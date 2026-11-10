import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CODEX_RANKS, DEFAULT_RANKS, type WsEvent } from "../shared/types.ts";
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
    expect(s.getSettings()).toEqual({ backend: "core", permissionMode: "bypassPermissions", ranks: DEFAULT_RANKS, codexRanks: DEFAULT_CODEX_RANKS, maxConcurrentTurns: 4, compactAtPct: 70, contextWindowDefault: 1_000_000, contextWindows: { "gpt-6-astra": 475_000 }, maxAwakeWorkers: 8, notifyMac: false, macScriptNotifications: true, boardTidyHours: 6 });
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
    try {
      bus.emit({ type: "hello", seq: 0 });
      off();
      bus.emit({ type: "hello", seq: 0 });
    } finally { silenced.mockRestore(); }
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
    const heic = join(dir, "photo.heic");
    // 미리 소프트웨어 인코딩한 32×32 빨간 HEIC. 샌드박스의 하드웨어 인코더에 의존하지 않는다.
    await Bun.write(heic, Buffer.from("AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAABP21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABXwAAABcAAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABodmMxSW1hZ2UAAAAAvmlwcnAAAACgaXBjbwAAAHRodmNDAQFgAAAAkAAAAAAAHvAA/P34+AAADwOgAAEAGEABDAH//wFgAAADAJAAAAMAAAMAHpWYCaEAAQAoQgEBAWAAAAMAkAAAAwAAAwAeoEIIWWVmuTK8BaAgAAADACAAAAMAIaIAAQAGRAHBc9CJAAAAFGlzcGUAAAAAAAAAIAAAACAAAAAQcGl4aQAAAAADCAgIAAAAFmlwbWEAAAAAAAAAAQABA4GCAwAAAB9tZGF0AAAAEygBrxOA9SSj/+SVH/2F54eu6uA=", "base64"));

    const saved = await importPath(tempDir(), heic);
    expect(saved).toMatchObject({ name: "photo.jpg", mime: "image/jpeg" });
    expect(saved.path.endsWith("photo.jpg")).toBe(true);
    const head = new Uint8Array(await Bun.file(saved.path).arrayBuffer()).slice(0, 2);
    expect([...head]).toEqual([0xff, 0xd8]);
  });
});


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

describe("Store 영속 포트", () => {
  test("최외곽 rollback은 원본/outbox/recovery/Bus/pump를 모두 취소한다", () => {
    const { store, db, events, bus } = makeStore();
    try {
      const p = store.createProject({ name: "원자", cwd: "/fixture" });
      const m = store.createMember({ projectId: p.id, handle: "worker", name: "직원", kind: "worker" });
      events.length = 0;
      const seq = bus.seq;
      let pumps = 0;
      expect(() => store.transaction(() => {
        store.withDeliveryIntents(() => store.createMessage({ id: "atomic", projectId: p.id, kind: "나", mine: true, delivery: "queued" }), (message) => [{ projectId: p.id, memberId: m.id, kind: "user_message", text: "지시", refType: "message", refId: message.id }], () => { pumps++; });
        expect(events).toEqual([]);
        expect(pumps).toBe(0);
        throw new Error("outer rollback");
      })).toThrow("outer rollback");
      expect(store.getMessage("atomic")).toBeNull();
      expect(store.listDeliveries()).toEqual([]);
      expect(store.listDeliveryRecoveries()).toEqual([]);
      expect(store.boardRevision(p.id)).toBe(0);
      expect(bus.seq).toBe(seq);
      expect(pumps).toBe(0);
      expect(events).toEqual([]);
      // DB trigger가 outbox 삽입을 거부해도 원본이 남지 않는다.
      db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'outbox failed'); END");
      expect(() => store.withDeliveryIntents(() => store.createMessage({ id: "failed", projectId: p.id, kind: "나" }), (message) => [{ projectId: p.id, memberId: m.id, kind: "user_message", text: "지시", refType: "message", refId: message.id }], () => { pumps++; })).toThrow("outbox failed");
      expect(store.getMessage("failed")).toBeNull();
      expect(events).toEqual([]);
      expect(pumps).toBe(0);
    } finally { db.close(); }
  });

  test("중첩 savepoint만 실패하면 그 이벤트만 버리고 commit 뒤 pump는 수신자당 한 번", () => {
    const { store, db, events } = makeStore();
    try {
      const p = store.createProject({ name: "중첩", cwd: "/fixture" });
      const m = store.createMember({ projectId: p.id, handle: "worker", name: "직원", kind: "worker" });
      events.length = 0;
      let pumps = 0;
      store.transaction(() => {
        expect(() => store.transaction(() => {
          store.createMessage({ id: "rollback", projectId: p.id, kind: "나" });
          store.afterCommit(() => { pumps += 100; });
          throw new Error("inner rollback");
        })).toThrow("inner rollback");
        store.withDeliveryIntents(() => store.createMessage({ id: "kept", projectId: p.id, kind: "나" }), (message) => ["one", "two"].map((text) => ({ projectId: p.id, memberId: m.id, kind: "system" as const, text, refType: "message" as const, refId: message.id, sourceRevision: text })), () => {
          expect(db.inTransaction).toBe(false);
          expect(store.listDeliveries()).toHaveLength(2);
          pumps++;
        });
        expect(events).toEqual([]);
      });
      expect(pumps).toBe(1);
      expect(store.getMessage("rollback")).toBeNull();
      expect(events.filter((e) => e.type === "message").map((e) => e.type === "message" && e.message.id)).toEqual(["kept"]);
      expect(store.listDeliveryRecoveries()).toHaveLength(2);
      expect(() => store.transaction(async () => "invalid")).toThrow("synchronous");
    } finally { db.close(); }
  });

  test("전체 누락/미수신 조회는 500개 메시지·50개 처리 카드 밖도 찾는다", () => {
    const { store, db } = makeStore();
    try {
      const p = store.createProject({ name: "누락", cwd: "/fixture" });
      const m = store.createMember({ projectId: p.id, handle: "worker", name: "직원", kind: "worker", origin: "manual" });
      const old = store.createMessage({ projectId: p.id, kind: "나", mine: true, delivery: "queued" });
      const direct = store.createMessage({ projectId: p.id, kind: "나", mine: true, targetMemberId: m.id, delivery: "held" });
      const d = store.createDecision({ projectId: p.id, memberId: m.id, who: m.name, title: "옛 질문" });
      store.answerDecision(d.id, { note: "답" });
      store.transaction(() => {
        for (let i = 0; i < 550; i++) store.createMessage({ projectId: p.id, kind: "시스템" });
        for (let i = 0; i < 60; i++) { const next = store.createDecision({ projectId: p.id, who: "총괄", title: "처리" }); store.closeDecision(next.id, { kind: "obsolete", reason: "정리", by: "총괄" }); }
      });
      expect(store.listMessagesMissingDeliveries(p.id).map((m) => m.id)).toEqual([old.id, direct.id]);
      expect(store.listUnreceivedAnswers(m.id).map((a) => a.id)).toEqual([d.id]);
      expect(store.listAnswersMissingDeliveries().map((a) => a.id)).toEqual([d.id]);
      const delivery = store.enqueue({ projectId: p.id, memberId: m.id, kind: "user_message", text: "x", refType: "message", refId: old.id });
      store.markDelivered(delivery.id);
      // 전달 행이 이미 있으면 원본 상태가 낡았어도 누락으로 재생하지 않는다.
      expect(store.listMessagesMissingDeliveries(p.id).map((m) => m.id)).toEqual([direct.id]);
    } finally { db.close(); }
  });

  test("v1 쓰기도 revision을 올리고 CAS 실패/rollback은 값과 이벤트를 보존", () => {
    const { store, db, events } = makeStore();
    try {
      const p = store.createProject({ name: "CAS", cwd: "/fixture" });
      const m = store.createMember({ projectId: p.id, handle: "worker", name: "직원", kind: "worker" });
      const todo = store.createTodo({ projectId: p.id, title: "일" });
      const start = store.syncRevisions(p.id);
      store.patchSettings({ ranks: { lead: { model: "sonnet" } } });
      expectApiError(() => store.patchSettingsCas({ notifyMac: true }, start.settings), 409);
      expect(store.patchSettingsCas({ notifyMac: true }, store.settingsRevision()).settings.ranks.lead.model).toBe("sonnet");
      store.patchMember(m.id, { status: "working" });
      expect(store.memberRevisions(m.id).configRevision).toBe(0);
      const member = store.patchMemberCas(m.id, { modelOverride: "model" }, 0);
      expect(member.configRevision).toBe(1);
      expectApiError(() => store.patchMemberCas(m.id, { modelOverride: "old" }, 0), 409);
      expect(store.setTodoDoneCas(todo.id, true, 0).revision).toBe(1);
      expectApiError(() => store.setTodoDoneCas(todo.id, false, 0), 409);
      const revision = store.settingsRevision();
      events.length = 0;
      expect(() => store.transaction(() => { store.patchSettingsCas({ notifyMac: false }, revision); throw new Error("rollback"); })).toThrow();
      expect(store.settingsRevision()).toBe(revision);
      expect(store.getSettings().notifyMac).toBe(true);
      expect(events).toEqual([]);
    } finally { db.close(); }
  });

  test("receipt은 같은 operation의 요청만 합치고 unknown은 재실행하지 않는다", () => {
    const { store, db } = makeStore();
    try {
      const p = store.createProject({ name: "receipt", cwd: "/fixture" });
      const m = store.createMember({ projectId: p.id, handle: "worker", name: "직원", kind: "worker" });
      const input = { operationId: "input", kind: "terminal_control" as const, projectId: p.id, memberId: m.id, request: { text: "private-canary", sequence: 1 } };
      const pending = store.beginOperation(input);
      expect(JSON.stringify(pending)).not.toContain("private-canary");
      if (pending.status !== "pending" || pending.kind !== "terminal_control") throw new Error("expected pending terminal receipt");
      const unknown = store.finishOperation({ ...pending, kind: "terminal_control", status: "unknown", code: "WRITE_UNKNOWN", error: "결과 확인 중" });
      expect(store.beginOperation({ ...input, request: { sequence: 1, text: "private-canary" } })).toEqual(unknown);
      expectApiError(() => store.beginOperation({ ...input, request: { sequence: 2 } }), 409);
      expectApiError(() => store.finishOperation({ ...pending, kind: "terminal_control", status: "refused", code: "NO", error: "stale" }), 409);
      let calls = 0;
      const execute = () => { calls++; return { id: store.createDecision({ projectId: p.id, who: m.name, title: "질문" }).id }; };
      expect(store.agentOperation(m.id, "ask", "agent1", { title: "질문" }, execute)).toEqual(store.agentOperation(m.id, "ask", "agent1", { title: "질문" }, execute));
      expect(calls).toBe(1);
      store.agentOperation(m.id, "ask", "agent2", { title: "질문" }, execute);
      expect(calls).toBe(2);
      expectApiError(() => store.agentOperation(m.id, "post", "agent1", {}, execute), 409);
    } finally { db.close(); }
  });

  test("lease·journal·문맥·봉투·nextAttemptAt은 재오픈 뒤 유지하고 세대/CAS를 검사", () => {
    const path = join(tempDir(), "persistent.db");
    let db = openDb(path);
    try {
      let store = new Store(db, new Bus());
      const p = store.createProject({ name: "영속", cwd: "/fixture" });
      const m = store.createMember({ projectId: p.id, handle: "worker", name: "직원", kind: "worker", sessionId: "session", paneId: "terminal" });
      const identity = { terminalId: "terminal", sessionId: "session", sessionGeneration: 0, process: null };
      const at = new Date().toISOString();
      const baseline = { serverEpoch: "epoch", turn: 1, inputEpoch: 0, logs: [], capturedAt: at };
      const lease = { memberId: m.id, claimId: "claim", leaseId: "lease", identity, expiresAt: Date.now() + 60_000, lastInputSequence: 1 };
      store.saveLease(lease);
      expectApiError(() => store.saveLease({ ...lease, claimId: "other" }), 409);
      expectApiError(() => store.saveLease({ ...lease, lastInputSequence: 0 }), 409);
      const delivery = store.enqueue({ projectId: p.id, memberId: m.id, kind: "system", text: "wire" });
      store.patchDeliveryRetry(delivery.id, { nextAttemptAt: at, sourceRevision: "revision" });
      const recovery = store.getDeliveryRecovery(delivery.id)!;
      store.updateDeliveryRecovery(delivery.id, recovery.version, { phase: "checking", checkCount: 1, evidence: [] });
      expectApiError(() => store.updateDeliveryRecovery(delivery.id, recovery.version, { phase: "resolved" }), 409);
      store.saveDispatch({ dispatchId: "dispatch", projectId: p.id, memberId: m.id, cli: "claude", backend: "core", markers: [{ deliveryId: delivery.id, marker: "marker" }], bundleMarker: "bundle", identity, baseline, wireSha256: new Bun.CryptoHasher("sha256").update("wire").digest("hex"), wireText: "wire", items: [{ deliveryId: delivery.id, ordinal: 0, sourceRevision: "revision" }], transportState: "prepared", submitAttempts: 0, createdAt: at, updatedAt: at });
      store.updateDispatch("dispatch", "prepared", "unknown", true);
      expectApiError(() => store.updateDispatch("dispatch", "unknown", "unknown", true), 409);
      store.saveLifecycleJournal({ operationId: "start", memberId: m.id, projectId: p.id, intent: "start", phase: "unknown", identity, runId: "run", deliveryIds: [delivery.id], baseline, reason: "timeout", exitCode: null, createdAt: at, updatedAt: at });
      store.saveExecutionJournal({ runId: "run", memberId: m.id, projectId: p.id, identity, turn: 1, deliveryIds: [delivery.id], phase: "unknown", inputReceivedAt: at, startedAt: null, lastProgressAt: null, endedAt: null, result: null, reason: "timeout", exitCode: 1, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at });
      const context = store.ensureContextState(m.id);
      store.saveContextState({ ...context, rolloutPath: "/fixture/rollout.jsonl", rolloutOffset: 10 });
      db.close();
      db = openDb(path);
      store = new Store(db, new Bus());
      expect(store.inputState(m.id).lease).toEqual(lease);
      expect(store.inputState(m.id).unresolvedDispatches[0]!.submitAttempts).toBe(1);
      expect(store.listPendingLifecycleJournals()[0]!.reason).toBe("timeout");
      expect(store.listPendingExecutions()[0]!.exitCode).toBe(1);
      expect(store.getContextState(m.id)).toMatchObject({ bindingNonce: context.bindingNonce, rolloutOffset: 10 });
      expect(store.getDeliveryRetry(delivery.id).nextAttemptAt).toBe(at);
      expect(store.getDeliveryRecovery(delivery.id)!.checkCount).toBe(1);
      let notices = 0;
      expect(() => store.claimExecutionNotice("run", "interruption", () => { throw new Error("notice fail"); })).toThrow();
      expect(store.claimExecutionNotice("run", "interruption", () => { notices++; })).toBe(true);
      expect(store.claimExecutionNotice("run", "interruption", () => { notices++; })).toBe(false);
      expect(notices).toBe(1);
      store.removeLease(m.id, "wrong");
      expect(store.inputState(m.id).lease).not.toBeNull();
      store.archiveAndRotateSession(m.id, "codex");
      expect(store.inputState(m.id).lease).toBeNull();
      expectApiError(() => store.saveContextState(context), 409);
      expect(store.ensureContextState(m.id).bindingNonce).not.toBe(context.bindingNonce);
    } finally { db.close(); }
  });

  test("보고 출처·board 검토는 원본과 함께 저장하며 실행 중 새 revision을 덮지 않는다", () => {
    const { store, db } = makeStore();
    try {
      const p = store.createProject({ name: "board", cwd: "/fixture" });
      const first = store.createMessage({ projectId: p.id, kind: "진행" });
      const requested = store.requestBoardReview(p.id);
      store.createTodo({ projectId: p.id, title: "새 일" });
      store.completeBoardReview(p.id, requested.requestedRevision, requested.requestedRevision);
      expect(store.boardRevision(p.id)).toBeGreaterThan(store.getBoardReview(p.id)!.reviewedRevision!);
      const file = store.createFile({ projectId: p.id, title: "자료" });
      const refs = { sourceMessageId: first.id, fileIds: [file.id], decisionIds: [], authoredAt: first.at, sequence: 0, correctsMessageId: null };
      store.saveReportReferences(p.id, refs);
      expect(store.getReportReferences(p.id, first.id)).toEqual(refs);
      expectApiError(() => store.saveReportReferences(p.id, { ...refs, fileIds: [] }), 409);
    } finally { db.close(); }
  });
});

test("Store의 기존 db.transaction 진입점도 중첩 rollback/인자/SQL 모드와 commit 이벤트를 보존한다", () => {
  const { store, db, events } = makeStore();
  try {
    for (const mode of ["deferred", "immediate", "exclusive"] as const) {
      events.length = 0;
      const write = store.db.transaction((id: string) => {
        store.createMessage({ id, projectId: "hq", kind: "시스템" });
        expect(events).toEqual([]);
        return id;
      });
      expect(write[mode](`committed-${mode}`)).toBe(`committed-${mode}`);
      expect(events.filter((e) => e.type === "message")).toHaveLength(1);
      events.length = 0;
      expect(() => store.db.transaction(() => {
        write[mode](`rollback-${mode}`);
        store.afterCommit(() => { throw new Error("must not run"); });
        throw new Error("rollback");
      })()).toThrow("rollback");
      expect(store.getMessage(`rollback-${mode}`)).toBeNull();
      expect(events).toEqual([]);
    }
    // 다른 저장소가 쓰는 원래 Database는 교체하거나 transaction 함수를 변조하지 않는다.
    expect(db).not.toBe(store.db);
    expect(db.inTransaction).toBe(false);
  } finally { db.close(); }
});

test("원본 ID+수신자+sourceRevision 재접수는 outbox/pump를 중복 생성하지 않는다", () => {
  const { store, db, events } = makeStore();
  try {
    const p = store.createProject({ name: "접수", cwd: "/fixture" });
    const member = store.createMember({ projectId: p.id, handle: "worker", name: "직원", kind: "worker" });
    let pumps = 0;
    const accept = () => store.withDeliveryIntents(() => store.createMessage({ id: "same-source", projectId: p.id, kind: "나", mine: true }), (message) => [{ projectId: p.id, memberId: member.id, kind: "user_message", text: "지시", refType: "message", refId: message.id }], () => { pumps++; });
    const first = accept();
    events.length = 0;
    expect(accept()).toEqual(first);
    expect(pumps).toBe(1);
    expect(events).toEqual([]);
    expect(store.listDeliveries()).toHaveLength(1);
  } finally { db.close(); }
});

test("취소는 수신 결과 불명·ACK 대기 batch의 원본과 물리 fence를 삭제하지 않는다", () => {
  const { store, db } = makeStore();
  try {
    const p = store.createProject({ name: "취소", cwd: "/fixture" });
    const member = store.createMember({ projectId: p.id, handle: "worker", name: "직원", kind: "worker", origin: "manual" });
    const unknown = store.enqueue({ projectId: p.id, memberId: member.id, kind: "system", text: "unknown", refType: "todo", refId: "unknown" });
    store.updateDeliveryRecovery(unknown.id, 1, { phase: "checking" });
    expect(store.cancelPendingFor("todo", "unknown")).toBe(0);
    expect(store.requireDelivery(unknown.id).text).toBe("unknown");
    const pending = store.enqueue({ projectId: p.id, memberId: member.id, kind: "system", text: "manual", refType: "todo", refId: "manual" });
    const batch = store.manualInbox(member.id, [pending.id])!;
    expect(store.cancelPendingFor("todo", "manual")).toBe(0);
    expect(store.manualInbox(member.id)).toEqual(batch);
    const safe = store.enqueue({ projectId: p.id, memberId: member.id, kind: "system", text: "safe", refType: "todo", refId: "safe" });
    expect(store.cancelPendingFor("todo", "safe")).toBe(1);
    expect(store.getDelivery(safe.id)).toBeNull();
  } finally { db.close(); }
});
