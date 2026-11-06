import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { DEFAULT_RANKS, type WsEvent } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { generateAccessCode, loadConfig, updateConfigFile } from "../server/config.ts";
import { newId, openDb } from "../server/db.ts";
import { importPath, resolveInside, sanitizeName, saveUpload } from "../server/files.ts";
import { ApiError, MAX_ACTIVITY_PER_MEMBER, Store } from "../server/store.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "iamceo-core-"));

function makeStore() {
  const bus = new Bus();
  const events: WsEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const db = openDb(join(tempDir(), "t.db"));
  return { store: new Store(db, bus), bus, events, db };
}

function expectApiError(fn: () => unknown, status: number) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    return;
  }
  throw new Error(`ApiError(${status}) 가 나야 합니다`);
}

describe("config", () => {
  test("접속 코드를 만들어 저장하고 다시 읽으면 같다. 파일은 본인만 읽는다", () => {
    const home = tempDir();
    const env = { IAMCEO_HOME: home };
    const a = loadConfig(env);
    expect(a.accessCode.length).toBe(16);
    expect(a.home).toBe(home);
    expect(a.dbPath).toBe(join(home, "iamceo.db"));
    expect(existsSync(a.uploadsDir)).toBe(true);
    expect(statSync(a.configPath).mode & 0o777).toBe(0o600);
    expect(loadConfig(env).accessCode).toBe(a.accessCode);
  });

  test("환경 변수가 파일보다 우선하고 $HERDR_SOCKET_PATH 는 무시한다", () => {
    const home = tempDir();
    updateConfigFile({ accessCode: "abc", port: 1234, claudeBin: "/x/claude", herdrSocket: "/x/sock", hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home });
    const fromFile = loadConfig({ IAMCEO_HOME: home, HERDR_SOCKET_PATH: "/live/sock" });
    expect(fromFile).toMatchObject({ accessCode: "abc", port: 1234, claudeBin: "/x/claude", herdrSocket: "/x/sock", hosts: ["127.0.0.1"] });
    const fromEnv = loadConfig({ IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_CLAUDE_BIN: "/y/claude", IAMCEO_HERDR_SOCKET: "/y/sock" });
    expect(fromEnv).toMatchObject({ port: 0, claudeBin: "/y/claude", herdrSocket: "/y/sock" });
  });

  test("기본 herdr 소켓은 $HERDR_SOCKET_PATH 를 따라가지 않는다", () => {
    const c = loadConfig({ IAMCEO_HOME: tempDir(), HERDR_SOCKET_PATH: "/live/sock" });
    expect(c.herdrSocket).toBe(join(homedir(), ".config", "herdr", "herdr.sock"));
    expect(c.hosts[0]).toBe("127.0.0.1");
  });

  test("깨진 설정과 잘못된 포트는 분명한 오류를 낸다", () => {
    const home = tempDir();
    writeFileSync(join(home, "config.json"), "{나쁨");
    expect(() => loadConfig({ IAMCEO_HOME: home })).toThrow("설정 파일");
    expect(() => loadConfig({ IAMCEO_HOME: tempDir(), IAMCEO_PORT: "99999" })).toThrow("포트");
  });

  test("접속 코드에는 헷갈리는 글자가 없다", () => {
    expect(generateAccessCode(200)).toMatch(/^[2-9a-km-np-z]+$/);
  });
});

describe("db", () => {
  test("WAL·외래 키·id 접두어, 다시 열어도 마이그레이션이 깨지지 않는다", () => {
    const path = join(tempDir(), "t.db");
    const db = openDb(path);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    for (const t of ["projects", "members", "decisions", "todos", "work", "messages", "files", "attachments", "deliveries", "activity", "settings"]) {
      expect(tables).toContain(t);
    }
    db.close();
    openDb(path).close();
    expect(newId("msg_")).toMatch(/^msg_[A-Za-z0-9]{12}$/);
  });
});

describe("store", () => {
  let store: Store;
  let events: WsEvent[];
  let projectId: string;

  beforeEach(() => {
    ({ store, events } = makeStore());
    projectId = store.createProject({ name: "시험", cwd: "/tmp/x" }).id;
    events.length = 0;
  });

  const addMember = (handle = "kim", name = "김") => store.createMember({ projectId, handle, name, kind: "worker" });

  test("첫 실행 때 본사를 한 번만 만든다", () => {
    const { store: s, db } = makeStore();
    const hq = s.getProject("hq")!;
    expect(hq).toMatchObject({ name: "본사", isHq: true, cwd: homedir(), runnerEnabled: true });
    new Store(db, new Bus());
    expect(s.listProjects().filter((p) => p.isHq).length).toBe(1);
  });

  test("실행기는 core로 고정하고 저장된 이전 방식은 실행하지 않는다", () => {
    expect(store.getSettings().backend).toBe("core");
    expect(store.effectiveBackend()).toBe("core");
    store.patchSettings({ backend: "herdr" });
    expect(store.effectiveBackend()).toBe("core");
    expect(store.getProject("hq")).not.toHaveProperty("backend");
    expect(store.createProject({ name: "새", cwd: "/tmp/y" })).not.toHaveProperty("permissionMode");
  });

  test("프로젝트 패치: now 바뀔 때만 nowAt, 없는 프로젝트는 404, 방송", () => {
    const p = store.patchProject(projectId, { now: "일하는 중", runnerEnabled: false, herdrTabId: "tab1" });
    expect(p).toMatchObject({ now: "일하는 중", runnerEnabled: false, herdrTabId: "tab1" });
    expect(p.nowAt).not.toBeNull();
    expect(events.map((e) => e.type)).toContain("project");
    expect(events.map((e) => e.type)).toContain("projects");
    expectApiError(() => store.patchProject("nope", { name: "x" }), 404);
  });

  test("보관한 프로젝트는 목록·요약에서 빠진다", () => {
    store.patchProject(projectId, { archived: true });
    expect(store.listProjects().map((p) => p.id)).toEqual(["hq"]);
    expect(store.listProjects({ includeArchived: true }).length).toBe(2);
    expect(store.projectSummaries().map((p) => p.id)).toEqual(["hq"]);
  });

  test("직원: 토큰은 조회로만 나오고 Member·방송에는 없다", () => {
    const m = addMember();
    const token = store.getMemberToken(m.id);
    expect(token.length).toBeGreaterThan(20);
    expect(store.getMemberByToken(token)!.id).toBe(m.id);
    expect(store.getMemberByToken("틀림")).toBeNull();
    expect(store.getMemberByToken("")).toBeNull();
    expect(JSON.stringify(store.projectState(projectId))).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  test("직원: 핸들 형식·핸들 유일·이름 유일, 다른 프로젝트는 상관없다", () => {
    addMember();
    expectApiError(() => store.createMember({ projectId, handle: "Bad!", name: "다른", kind: "worker" }), 400);
    expectApiError(() => addMember("kim", "다른"), 409);
    expectApiError(() => addMember("lee", "김"), 409);
    const other = store.createProject({ name: "둘", cwd: "/tmp/z" }).id;
    expect(store.createMember({ projectId: other, handle: "kim", name: "김", kind: "worker" }).projectId).toBe(other);
  });

  test("직원 찾기: 핸들·이름, 프로젝트 경계, 총괄", () => {
    const m = addMember();
    const lead = store.createMember({ projectId, handle: "lead", name: "총괄", kind: "conductor" });
    expect(store.findMember(projectId, "kim")!.id).toBe(m.id);
    expect(store.findMember(projectId, "김")!.id).toBe(m.id);
    expect(store.findMember("hq", "kim")).toBeNull();
    expect(store.getConductor(projectId)!.id).toBe(lead.id);
    expect(store.getConductor("hq")).toBeNull();
    expect(store.getMemberByHandle(projectId, "lead")!.id).toBe(lead.id);
  });

  test("직원 패치: 상태 바뀌면 요약 방송, 아니면 안 함. 삭제는 전달·활동도 지운다", () => {
    const m = addMember();
    events.length = 0;
    store.patchMember(m.id, { contextPct: 42, sessionId: "s1", parallel: true, lastError: null });
    expect(events.map((e) => e.type)).toEqual(["member"]);
    expect(store.getMemberBySession("s1")!.contextPct).toBe(42);
    expect(store.getMember(m.id)!.parallel).toBe(true);
    events.length = 0;
    store.patchMember(m.id, { status: "working" });
    expect(events.map((e) => e.type)).toEqual(["member", "projects"]);

    const d = store.enqueue({ projectId, memberId: m.id, kind: "system", text: "x" });
    store.appendActivity(m.id, "text", "y");
    store.removeMember(m.id);
    expect(store.getDelivery(d.id)).toBeNull();
    expect(store.listActivity(m.id)).toEqual([]);
    expect(events.some((e) => e.type === "member_removed" && e.memberId === m.id)).toBe(true);
  });

  test("요약: 열린 결재 + 안 한 할 일, 일하는 직원, 직원 수", () => {
    const m = addMember();
    store.patchMember(m.id, { status: "working" });
    const d = store.createDecision({ projectId, who: "김", title: "고르기", options: [{ k: "a", label: "A" }] });
    const t = store.createTodo({ projectId, title: "서명" });
    const summary = () => store.projectSummaries().find((p) => p.id === projectId)!;
    expect(summary()).toMatchObject({ inboxCount: 2, workingCount: 1, memberCount: 1 });
    store.answerDecision(d.id, { choice: "a" });
    store.setTodoDone(t.id, true);
    expect(summary().inboxCount).toBe(0);
  });

  test("상태 조립: 메시지 최근 200 오래된 순, 결재는 열린 것 + 처리 50", () => {
    for (let i = 0; i < 205; i++) store.createMessage({ projectId, kind: "알림", body: `m${i}` });
    for (let i = 0; i < 55; i++) {
      const d = store.createDecision({ projectId, who: "김", title: `d${i}`, options: [{ k: "a", label: "A" }] });
      store.answerDecision(d.id, { choice: "a" });
    }
    store.createDecision({ projectId, who: "김", title: "열림" });
    const state = store.projectState(projectId);
    expect(state.messages.length).toBe(200);
    expect(state.messages[0]!.body).toBe("m5");
    expect(state.messages[199]!.body).toBe("m204");
    expect(state.decisions.length).toBe(51);
    expect(state.decisions[0]!.title).toBe("열림");
    expectApiError(() => store.projectState("nope"), 404);
  });

  test("메시지 멱등: 같은 id 는 한 번만 쓰고 한 번만 방송한다", () => {
    const first = store.createMessage({ id: "client-1", projectId, kind: "나", mine: true, body: "처음", who: "나" });
    const again = store.createMessage({ id: "client-1", projectId, kind: "나", mine: true, body: "다시", who: "나" });
    expect(again).toEqual(first);
    expect(again.body).toBe("처음");
    expect(store.listMessages(projectId).length).toBe(1);
    expect(events.filter((e) => e.type === "message").length).toBe(1);
  });

  test("메시지 페이징: 같은 밀리초에 써도 before 로 빠짐없이 넘길 수 있다", () => {
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(store.createMessage({ projectId, kind: "알림", body: String(i) }).id);
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = store.listMessages(projectId, { before, limit: 7 });
      if (page.length === 0) break;
      seen.unshift(...page.map((m) => m.id));
      before = page[0]!.at;
    }
    expect(seen).toEqual(ids);
  });

  test("메시지 전달 상태 갱신, 첨부 JSON 왕복", () => {
    const att = store.createAttachment({ id: "a_1", name: "한글 이름.png", mime: "image/png", size: 3, path: "/p" });
    expect(att).toMatchObject({ isImage: true, url: "/files/a_1/%ED%95%9C%EA%B8%80%20%EC%9D%B4%EB%A6%84.png" });
    const m = store.createMessage({ projectId, kind: "나", mine: true, attachments: [att], delivery: "queued" });
    expect(store.getMessage(m.id)!.attachments).toEqual([att]);
    const updated = store.setMessageDelivery(m.id, "held", "blocked");
    expect(updated).toMatchObject({ delivery: "held", deliveryNote: "blocked" });
    expect(events.filter((e) => e.type === "message").length).toBe(2);
  });

  test("결재 멱등: 같은 답은 changed=false, 다른 답은 409, 메모만·묶음도 처리", () => {
    const options = [
      { k: "a", label: "A", desc: "가" },
      { k: "b", label: "B" },
    ];
    const d = store.createDecision({ projectId, who: "김", title: "고르기", detail: "**왜**", options, rec: "b", group: "g1" });
    expect(d).toMatchObject({ status: "open", options, rec: "b", group: "g1" });

    const first = store.answerDecision(d.id, { choice: "a", note: " 메모 " });
    expect(first.changed).toBe(true);
    expect(first.decision).toMatchObject({ status: "answered", choice: "a", note: "메모", batch: false });
    expect(first.decision.answeredAt).not.toBeNull();

    const again = store.answerDecision(d.id, { choice: "a", note: "메모" });
    expect(again.changed).toBe(false);
    expect(again.decision.answeredAt).toBe(first.decision.answeredAt);
    expectApiError(() => store.answerDecision(d.id, { choice: "b" }), 409);

    expectApiError(() => store.answerDecision("nope", { choice: "a" }), 404);
    const d2 = store.createDecision({ projectId, who: "김", title: "둘", options, rec: "b" });
    expectApiError(() => store.answerDecision(d2.id, {}), 400);
    expectApiError(() => store.answerDecision(d2.id, { choice: "z" }), 400);
    expect(store.answerDecision(d2.id, { batch: true }).decision).toMatchObject({ choice: "b", batch: true });

    const free = store.createDecision({ projectId, who: "김", title: "자유" });
    expect(store.answerDecision(free.id, { note: "자유 답" }).decision).toMatchObject({ choice: null, note: "자유 답" });
  });

  test("결재 상태: delivered·closed, 직원별 열린 결재", () => {
    const m = addMember();
    const d = store.createDecision({ projectId, memberId: m.id, who: "김", title: "x" });
    expect(store.listOpenDecisionsByMember(m.id).map((x) => x.id)).toEqual([d.id]);
    store.answerDecision(d.id, { note: "ok" });
    expect(store.listOpenDecisionsByMember(m.id)).toEqual([]);
    const delivered = store.setDecisionStatus(d.id, "delivered");
    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredAt).not.toBeNull();
    expect(store.setDecisionStatus(d.id, "closed").status).toBe("closed");
  });

  test("할 일: 완료 왕복과 changed", () => {
    const t = store.createTodo({ projectId, title: "서명", who: "김" });
    const done = store.setTodoDone(t.id, true);
    expect(done.changed).toBe(true);
    expect(done.todo.doneAt).not.toBeNull();
    expect(store.setTodoDone(t.id, true).changed).toBe(false);
    expect(store.setTodoDone(t.id, false).todo).toMatchObject({ done: false, doneAt: null });
  });

  test("진행 판: 만들기·고치기·done 시각·다른 프로젝트 거부·방송", () => {
    const a = store.upsertWork({ projectId, sec: "doing", title: "일1", who: "김" });
    const b = store.upsertWork({ projectId, sec: "next", title: "일2" });
    expect(b.order).toBeGreaterThan(a.order);
    const done = store.upsertWork({ id: a.id, projectId, sec: "done", title: "일1 끝" });
    expect(done).toMatchObject({ sec: "done", title: "일1 끝", who: "김" });
    expect(done.doneAt).not.toBeNull();
    expect(store.upsertWork({ id: a.id, projectId, sec: "doing", title: "되돌림" }).doneAt).toBeNull();
    expectApiError(() => store.upsertWork({ id: a.id, projectId: "hq", sec: "doing", title: "x" }), 404);
    const last = events.filter((e) => e.type === "work").at(-1)!;
    expect(last).toMatchObject({ type: "work", projectId });
    store.removeWork(b.id);
    expect(store.listWork(projectId).length).toBe(1);
  });

  test("자료: 최신 순, 방송", () => {
    store.createFile({ projectId, title: "첫째", summary: "요약" });
    const f2 = store.createFile({ projectId, title: "둘째", body: "# 본문", path: "/x.md" });
    expect(store.listFiles(projectId).map((f) => f.title)).toEqual(["둘째", "첫째"]);
    expect(f2).toMatchObject({ order: 2, body: "# 본문", path: "/x.md", attachments: [] });
    expect(events.some((e) => e.type === "file")).toBe(true);
  });

  test("전달 큐: 넣은 순서, queuedCount, delivered 는 빠지고 held 는 남는다", () => {
    const m = addMember();
    const other = addMember("lee", "이");
    const d1 = store.enqueue({ projectId, memberId: m.id, kind: "user_message", text: "1", refType: "message", refId: "msg_1" });
    const d2 = store.enqueue({ projectId, memberId: m.id, kind: "system", text: "2", wake: false });
    const d3 = store.enqueue({ projectId, memberId: m.id, kind: "instruction", text: "3", urgent: true });
    store.enqueue({ projectId, memberId: other.id, kind: "system", text: "남의 것" });

    expect(store.listPending(m.id).map((d) => d.text)).toEqual(["1", "2", "3"]);
    expect(d1).toMatchObject({ wake: true, urgent: false, status: "queued", refType: "message", refId: "msg_1", attempts: 0 });
    expect(d2.wake).toBe(false);
    expect(d3.urgent).toBe(true);
    expect(store.getMember(m.id)!.queuedCount).toBe(3);

    expect(store.markHeld(d2.id, "blocked")).toMatchObject({ status: "held", holdReason: "blocked" });
    expect(store.listPending(m.id).map((d) => d.text)).toEqual(["1", "2", "3"]);

    const delivered = store.markDelivered(d1.id);
    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredAt).not.toBeNull();
    expect(store.listPending(m.id).map((d) => d.text)).toEqual(["2", "3"]);
    expect(store.getMember(m.id)!.queuedCount).toBe(2);

    const failed = store.markFailed(d3.id, "터짐");
    expect(failed).toMatchObject({ status: "failed", lastError: "터짐" });
    expect(store.getMember(m.id)!.queuedCount).toBe(1);

    // held 에서 다시 queued 로 가면 사유가 지워진다.
    const retried = store.setDeliveryStatus(d2.id, "queued", { attempt: true, lastError: "재시도" });
    expect(retried).toMatchObject({ status: "queued", holdReason: null, attempts: 1, lastError: "재시도" });
    expectApiError(() => store.markDelivered("nope"), 404);
  });

  test("전달 큐: 큐가 바뀌면 직원을 방송, 다른 프로젝트는 거부, 재시작 복구", () => {
    const m = addMember();
    events.length = 0;
    const d = store.enqueue({ projectId, memberId: m.id, kind: "system", text: "x" });
    const last = events.at(-1)!;
    expect(last.type === "member" && last.member.queuedCount).toBe(1);
    expectApiError(() => store.enqueue({ projectId: "hq", memberId: m.id, kind: "system", text: "x" }), 400);

    store.setDeliveryStatus(d.id, "delivering");
    expect(store.listPending(m.id)).toEqual([]);
    expect(store.listUndelivered(projectId).map((x) => x.id)).toEqual([d.id]);
    expect(store.listUndelivered().map((x) => x.id)).toEqual([d.id]);
    expect(store.requeueDelivering()).toBe(1);
    expect(store.getDelivery(d.id)!.status).toBe("queued");
  });

  test(`활동: 직원당 ${MAX_ACTIVITY_PER_MEMBER}개만 남고 최신을 남기며 다른 직원은 건드리지 않는다`, () => {
    const m = addMember();
    const other = addMember("lee", "이");
    store.appendActivity(other.id, "text", "남의 활동");
    for (let i = 0; i < MAX_ACTIVITY_PER_MEMBER + 25; i++) store.appendActivity(m.id, "tool", `a${i}`);
    const list = store.listActivity(m.id, 10_000);
    expect(list.length).toBe(MAX_ACTIVITY_PER_MEMBER);
    expect(list[0]!.text).toBe("a25");
    expect(list.at(-1)!.text).toBe(`a${MAX_ACTIVITY_PER_MEMBER + 24}`);
    expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM activity WHERE member_id = ?").get(m.id)!.n).toBe(MAX_ACTIVITY_PER_MEMBER);
    expect(store.listActivity(other.id).length).toBe(1);
    expect(store.listActivity(m.id, 3).map((a) => a.text)).toEqual([`a${MAX_ACTIVITY_PER_MEMBER + 22}`, `a${MAX_ACTIVITY_PER_MEMBER + 23}`, `a${MAX_ACTIVITY_PER_MEMBER + 24}`]);
  });

  test("활동: 프로젝트와 함께 방송하고 긴 글은 자른다", () => {
    const m = addMember();
    events.length = 0;
    const a = store.appendActivity(m.id, "tool_result", "x".repeat(10_000));
    expect(a.text.length).toBe(4001);
    expect(events.at(-1)).toMatchObject({ type: "activity", projectId });
    expectApiError(() => store.appendActivity("nope", "text", "x"), 404);
  });

  test("설정: 기본값, 일부만 고치기, 다시 열어도 유지, 방송", () => {
    const { store: s, bus, db, events: ev } = makeStore();
    expect(s.getSettings()).toEqual({ backend: "core", permissionMode: "bypassPermissions", ranks: DEFAULT_RANKS, maxConcurrentTurns: 4, compactAtPct: 70, contextWindowDefault: 1_000_000, contextWindows: { "gpt-6-astra": 475_000 }, maxAwakeWorkers: 8, notifyMac: false, boardTidyHours: 6 });
    expect(s.patchSettings({ compactAtPct: 60 }).compactAtPct).toBe(60);
    expect(ev.at(-1)).toMatchObject({ type: "settings" });
    expect(new Store(db, bus).getSettings().compactAtPct).toBe(60);
  });
});

describe("bus", () => {
  test("순번, 구독 해제, 받는 쪽 오류는 다른 쪽을 막지 않는다", () => {
    const bus = new Bus();
    const got: string[] = [];
    bus.subscribe(() => {
      throw new Error("받는 쪽 오류");
    });
    const off = bus.subscribe((e) => got.push(e.type));
    const silenced = spyOn(console, "error").mockImplementation(() => {});
    bus.emit({ type: "hello", seq: 0 });
    silenced.mockRestore();
    off();
    bus.emit({ type: "hello", seq: 0 });
    expect(got).toEqual(["hello"]);
    expect(bus.seq).toBe(2);
  });
});

describe("files", () => {
  test("이름 정리: 경로 제거, 숨김 점, 제어 문자, NFD 한글, 긴 이름", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeName("..\\..\\win.ini")).toBe("win.ini");
    expect(sanitizeName("...")).toBe("file");
    expect(sanitizeName("")).toBe("file");
    expect(sanitizeName(".env")).toBe("env");
    expect(sanitizeName("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(sanitizeName("한글.txt".normalize("NFD"))).toBe("한글.txt");
    const long = sanitizeName(`${"가".repeat(200)}.png`);
    expect(long.endsWith(".png")).toBe(true);
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(180);
  });

  test("resolveInside: 안쪽만 통과, .. 와 심볼릭 링크 탈출은 null, 없는 파일도 null", () => {
    const base = join(tempDir(), "uploads");
    mkdirSync(base);
    const outside = join(tempDir(), "secret");
    writeFileSync(outside, "s");
    writeFileSync(join(base, "ok.txt"), "o");
    symlinkSync(outside, join(base, "link"));
    expect(resolveInside(base, join(base, "ok.txt"))).toEndWith("ok.txt");
    expect(resolveInside(base, join(base, "..", "..", "etc"))).toBeNull();
    expect(resolveInside(base, outside)).toBeNull();
    expect(resolveInside(base, join(base, "link"))).toBeNull();
    expect(resolveInside(base, join(base, "none"))).toBeNull();
    expect(resolveInside(base, base)).toBeNull();
  });

  test("saveUpload·importPath: 슬롯 폴더 안에 정리된 이름으로 저장, MIME 추정", async () => {
    const uploads = tempDir();
    const saved = await saveUpload(uploads, new File(["hello"], "../../evil.txt", { type: "text/plain" }));
    expect(saved).toMatchObject({ name: "evil.txt", mime: "text/plain", size: 5 });
    expect(saved.id).toMatch(/^a_/);
    expect(saved.path).toBe(join(uploads, saved.id, "evil.txt"));
    expect(readFileSync(saved.path, "utf8")).toBe("hello");

    const src = join(tempDir(), "도표.png");
    writeFileSync(src, "pngbytes");
    const imported = await importPath(uploads, src);
    expect(imported).toMatchObject({ name: "도표.png", mime: "image/png", size: 8 });
    expect(readFileSync(imported.path, "utf8")).toBe("pngbytes");
    await expect(importPath(uploads, join(tempDir(), "없음"))).rejects.toThrow();
  });

  test("HEIC 를 변환하지 못하면 원본을 그대로 둔다", async () => {
    const saved = await saveUpload(tempDir(), new File(["not really heic"], "photo.heic", { type: "image/heic" }));
    expect(saved).toMatchObject({ name: "photo.heic", mime: "image/heic", size: 15 });
    expect(existsSync(saved.path)).toBe(true);
  });

  test.skipIf(process.platform !== "darwin")("HEIC→JPEG: 진짜 HEIC 는 sips 로 바꾼다", async () => {
    const dir = tempDir();
    const png = join(dir, "src.png");
    await Bun.write(png, makePng(16, 16));
    const heic = join(dir, "photo.heic");
    const proc = Bun.spawn(["sips", "-s", "format", "heic", png, "--out", heic], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    expect(await proc.exited).toBe(0);

    const saved = await importPath(tempDir(), heic);
    expect(saved).toMatchObject({ name: "photo.jpg", mime: "image/jpeg" });
    expect(saved.path.endsWith("photo.jpg")).toBe(true);
    const head = new Uint8Array(await Bun.file(saved.path).arrayBuffer()).slice(0, 2);
    expect([...head]).toEqual([0xff, 0xd8]);
  });
});

function makePng(w: number, h: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (type: string, data: Uint8Array) => {
    const typed = Buffer.concat([Buffer.from(type), data]);
    return Buffer.concat([u32(data.length), typed, u32(crc(typed))]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = 255;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.concat([u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0])])),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}


test("Finder PATH discovers installed user CLIs without a login shell and honors explicit paths", async () => {
  const { chmodSync, mkdirSync } = await import("node:fs");
  const userHome = mkdtempSync(join(tmpdir(), "iamceo-finder-home-"));
  const appHome = join(userHome, "app");
  const codex = join(userHome, ".npm-global", "bin", "codex");
  const claude = join(userHome, ".local", "bin", "claude");
  for (const executable of [codex, claude]) {
    mkdirSync(join(executable, ".."), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
  }
  const config = loadConfig({ IAMCEO_HOME: appHome, HOME: userHome, PATH: "/usr/bin:/bin" });
  expect(config.codexBin).toBe(codex);
  expect(config.claudeBin).toBe(claude);
  const explicit = loadConfig({ IAMCEO_HOME: appHome, HOME: userHome, PATH: "/usr/bin:/bin", IAMCEO_CODEX_BIN: "/missing/explicit-codex" });
  expect(explicit.codexBin).toBe("/missing/explicit-codex");
});
