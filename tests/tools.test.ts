import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONDUCTOR_TOOLS, MANUAL_TOOLS, ROOT_TOOLS, WORKER_TOOLS, type Backend, type Member } from "../shared/types.ts";
import { handleAgentTool, listAgentTools } from "../server/agent-tools.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import type { AgentToolResult } from "../server/orchestrator-api.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { FilePublication } from "../server/files.ts";
import { StorageError } from "../server/storage-errors.ts";

/** 세션을 띄우지 않고 받은 글만 기록한다. 턴은 end() 로 끝낸다. */
class FakeRunner implements Runner {
  readonly kind: Backend = "headless";
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  parallel: { memberId: string; on: boolean }[] = [];
  private cb: (e: RunnerEvent) => void = () => {};
  async available() {
    return { ok: true };
  }
  async start() {
    return { sessionId: crypto.randomUUID(), paneId: null };
  }
  async send(m: { id: string }, text: string): Promise<SendResult> {
    this.sent.push({ memberId: m.id, text });
    this.busy.add(m.id);
    return { ok: true };
  }
  isBusy(id: string) {
    return this.busy.has(id);
  }
  async compact(): Promise<SendResult> {
    return { ok: true };
  }
  async setParallel(m: { id: string }, on: boolean): Promise<SendResult> {
    this.parallel.push({ memberId: m.id, on });
    return { ok: true };
  }
  async interrupt() {}
  async stop(m: { id: string }) {
    this.busy.delete(m.id);
  }
  async screen() {
    return "";
  }
  on(cb: (e: RunnerEvent) => void) {
    this.cb = cb;
  }
  async shutdown() {}
  end(memberId: string, finalText = "") {
    this.busy.delete(memberId);
    this.cb({ type: "turn_end", memberId, finalText, isError: false });
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "iamceo-tools-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const runner = new FakeRunner();
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["headless", runner]]) });
  const server: RunningServer = await startServer({ config, store, bus, orch });
  orch.setServerUrl(server.urls[0]!);
  cleanups.push(async () => {
    await orch.shutdown();
    await server.stop();
  });
  const project = store.createProject({ name: "시험", cwd: home });
  const lead = await orch.ensureConductor(project.id);
  const call = async (member: Member, name: string, args: Record<string, unknown> = {}): Promise<AgentToolResult> => {
    const res = await fetch(`${server.urls[0]}/agent/tool`, {
      method: "POST",
      headers: { Authorization: `Bearer ${store.getMemberToken(member.id)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as AgentToolResult;
  };
  return { home, store, bus, orch, runner, server, project, lead, call };
}

/** 표식을 제거해 비교하는 대신, 저장 봉투와 송신 문자열도 일치해야 한다. */
function deliveryBody(store: Store, sent: { memberId: string; text: string }): string {
  const dispatch = store.listDispatches(sent.memberId).find(d => d.wireText === sent.text)!;
  expect(dispatch).toBeDefined();
  expect(dispatch.items).toHaveLength(1);
  const delivery = store.requireDelivery(dispatch.items[0]!.deliveryId);
  expect(dispatch.markers).toEqual([{ deliveryId: delivery.id, marker: store.getDeliveryRecovery(delivery.id)!.marker! }]);
  expect(sent.text).toBe(`${delivery.text}\n${dispatch.markers[0]!.marker}\n${dispatch.bundleMarker}`);
  return delivery.text;
}

describe("도구 목록", () => {
  test("역할마다 다르고 MCP 입력 스키마 모양이다", async () => {
    const { store, project, lead } = await setup();
    const names = (m: Member) => listAgentTools(m).map((t) => t.name);
    const worker = store.createMember({ projectId: project.id, handle: "w", name: "직원", kind: "worker" });
    const manual = store.createMember({ projectId: project.id, handle: "m", name: "손", kind: "worker", origin: "manual" });
    const root = store.createMember({ projectId: "hq", handle: "root", name: "본사 AI", kind: "root" });
    expect(names(worker)).toEqual([...WORKER_TOOLS]);
    expect(names(lead)).toEqual([...WORKER_TOOLS, ...CONDUCTOR_TOOLS]);
    expect(names(root)).toEqual([...WORKER_TOOLS, ...ROOT_TOOLS]);
    expect(names(manual)).toEqual([...WORKER_TOOLS, ...MANUAL_TOOLS]);
    for (const t of listAgentTools(lead)) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.$schema).toBeUndefined();
      expect(t.description.length).toBeGreaterThan(5);
    }
    const ask = listAgentTools(lead).find((t) => t.name === "ask")!.inputSchema as { required: string[] };
    expect(ask.required).toEqual(["title", "detail"]);
  });

  test("역할에 없는 도구, 모르는 도구, 모르는 인자, 빠진 인자는 거부", async () => {
    const { store, project, lead, call } = await setup();
    const worker = store.createMember({ projectId: project.id, handle: "w", name: "직원", kind: "worker" });
    expect(await call(worker, "team_add", { name: "x", role: "y" })).toMatchObject({ isError: true });
    expect(await call(lead, "project_create", { name: "x", cwd: "/" })).toMatchObject({ isError: true });
    expect(await call(lead, "wait")).toMatchObject({ isError: true });
    expect(await call(lead, "없는도구")).toMatchObject({ isError: true });
    expect(await call(worker, "status", { now: "일", 다음: "모름" })).toMatchObject({ isError: true });
    expect((await call(worker, "post", { kind: "질문", title: "물음" })).isError).toBe(true);
    expect((await call(worker, "ask", { title: "제목만" })).text).toContain("detail");
  });
});

describe("공통 도구", () => {
  test("status: 팀 카드에 지금·다음이 남는다", async () => {
    const { store, lead, call } = await setup();
    expect((await call(lead, "status", { now: "조사 중", next: "정리" })).isError).toBeUndefined();
    expect(store.requireMember(lead.id)).toMatchObject({ now: "조사 중", next: "정리" });
    await call(lead, "status", { now: "다른 일" });
    expect(store.requireMember(lead.id)).toMatchObject({ now: "다른 일", next: "정리" });
  });

  test("ask: 실행기 직원은 카드 등록 후 즉시 반환, 대기 상태", async () => {
    const { store, project, orch, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "철수", handle: "cs", role: "개발" });
    const r = await call(w, "ask", { title: "어느 쪽", detail: "배경", options: [{ k: "a", label: "가" }, { k: "b", label: "나", desc: "느림" }], rec: "a", group: "묶음" });
    expect(r.wait).toBeUndefined();
    expect(r.text).toContain("턴을 끝내세요");
    const d = store.listDecisions(project.id)[0]!;
    expect(d).toMatchObject({ title: "어느 쪽", rec: "a", group: "묶음", who: "철수", status: "open", memberId: w.id });
    expect(store.requireMember(w.id).status).toBe("waiting");
  });

  test("ask: 직접 띄운 CLI 는 기다리라고 돌려준다", async () => {
    const { store, project, call } = await setup();
    const m = store.createMember({ projectId: project.id, handle: "m", name: "손", kind: "worker", origin: "manual" });
    const r = await call(m, "ask", { title: "물음", detail: "배경" });
    expect(r.wait?.decisionId).toBe(store.listDecisions(project.id)[0]!.id);
  });

  test("ask: 권장이 선택지에 없거나 k 가 겹치거나 자료가 다른 프로젝트면 거부", async () => {
    const { store, project, lead, call } = await setup();
    const opt = [{ k: "a", label: "가" }];
    expect(await call(lead, "ask", { title: "t", detail: "d", options: opt, rec: "z" })).toMatchObject({ isError: true });
    expect(await call(lead, "ask", { title: "t", detail: "d", options: [...opt, ...opt] })).toMatchObject({ isError: true });
    const other = store.createProject({ name: "다른", cwd: "/tmp" });
    const foreign = store.createFile({ projectId: other.id, title: "남의 자료" });
    expect(await call(lead, "ask", { title: "t", detail: "d", file_id: foreign.id })).toMatchObject({ isError: true });
    expect(store.listDecisions(project.id)).toHaveLength(0);
  });

  test("post: 대화에 남고 직원 보고는 총괄을 깨우거나 쌓는다", async () => {
    const { store, project, orch, lead, runner, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "철수", handle: "cs", role: "개발" });
    const file = store.createFile({ projectId: project.id, title: "보고서" });
    await call(w, "post", { kind: "진행", title: "반쯤" });
    expect(runner.sent).toHaveLength(0);
    expect(store.listPending(lead.id)).toHaveLength(1);
    const r = await call(w, "post", { kind: "완료", title: "다 했다", body: "핵심", file_ids: [file.id] });
    expect(r.isError).toBeUndefined();
    const messages = store.listMessages(project.id);
    expect(messages.at(-1)).toMatchObject({ kind: "완료", who: "철수", title: "다 했다", fileId: file.id });
    expect(runner.sent).toHaveLength(1);
    expect(runner.sent[0]!.text).toContain("[보고 철수] 완료: 다 했다");
    expect(runner.sent[0]!.text).toContain("[보고 철수] 진행: 반쯤");
    expect(await call(w, "post", { kind: "완료", title: "t", file_ids: ["f_없음"] })).toMatchObject({ isError: true });
  });

  test("거부된 post 는 보고로 치지 않아 턴 마지막 글이 자동 보고된다", async () => {
    const { store, project, orch, runner, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "철수", handle: "cs", role: "개발", firstInstruction: "일" });
    expect(await call(w, "post", { kind: "완료", title: "t", file_ids: ["f_없음"] })).toMatchObject({ isError: true });
    runner.end(w.id, "결과 글");
    await Bun.sleep(30);
    expect(store.listMessages(project.id).at(-1)).toMatchObject({ who: "철수", title: "(자동) 결과 글" });
  });

  test("file: 글·md 경로·첨부·이미지", async () => {
    const { home, store, project, lead, call } = await setup();
    const docs = join(home, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "r.md"), "# 보고서 본문");
    writeFileSync(join(docs, "d.csv"), "a,b\n");
    writeFileSync(join(docs, "p.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const id = (r: AgentToolResult) => /#(f_\S+?)\./.exec(r.text)![1]!;

    const a = store.getFile(id(await call(lead, "file", { title: "글", summary: "요약", content: "전문" })))!;
    expect(a).toMatchObject({ title: "글", summary: "요약", body: "전문", who: lead.name, path: null, memberId: lead.id });

    const b = store.getFile(id(await call(lead, "file", { title: "md", path: join(docs, "r.md") })))!;
    expect(b).toMatchObject({ body: "# 보고서 본문", path: join(docs, "r.md"), attachments: [] });

    const c = store.getFile(id(await call(lead, "file", { title: "표", path: "docs/d.csv", images: [join(docs, "p.png")] })))!;
    expect(c.kind).toBe("table");
    expect(c.body).toBe("a,b\n");
    expect(c.attachments.map((x) => [x.name, x.isImage])).toEqual([["d.csv", false], ["p.png", true]]);
    expect(existsSync(c.attachments[0]!.path)).toBe(true);
    expect(c.attachments[0]!.path).toStartWith(join(home, "uploads"));

    expect(await call(lead, "file", { title: "둘 다", path: "docs/r.md", content: "x" })).toMatchObject({ isError: true });
    expect(await call(lead, "file", { title: "없음" })).toMatchObject({ isError: true });
    expect(await call(lead, "file", { title: "없는 파일", path: "없다.png" })).toMatchObject({ isError: true });
    expect(await call(lead, "file", { title: "그림 아님", images: [join(docs, "d.csv")] })).toMatchObject({ isError: true });
    expect(store.listFiles(project.id)).toHaveLength(3);
  });

  test("file: 후반의 잘못된 이미지·없는 경로는 첨부와 staging을 전혀 만들지 않는다", async () => {
    const { home, store, lead, call } = await setup();
    const image = join(home, "ok.png");
    const csv = join(home, "data.csv");
    writeFileSync(image, "image");
    writeFileSync(csv, "a,b");
    const before = existsSync(join(home, "uploads")) ? readdirSync(join(home, "uploads")) : [];
    for (const images of [[image, csv], [image, join(home, "missing.png")]]) {
      expect(await call(lead, "file", { title: "거부", path: csv, images })).toMatchObject({ isError: true });
    }
    expect(store.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    expect(readdirSync(join(home, "uploads"))).toEqual(before);
  });

  test("file: 두 번째 복사 실패는 게시하지 않고 실패 staging만 남긴다", async () => {
    const { home, store, lead, orch, project } = await setup();
    const images = [join(home, "first.png"), join(home, "second.png")];
    for (const path of images) writeFileSync(path, "image");
    const original = FilePublication.prototype.stagePath;
    let count = 0;
    const stage = spyOn(FilePublication.prototype, "stagePath").mockImplementation(async function (this: FilePublication, input) {
      const saved = await original.call(this, input);
      if (++count === 1) unlinkSync(images[1]!);
      return saved;
    });
    try { await expect(handleAgentTool(orch, lead, "file", { title: "실패", images })).rejects.toThrow(); }
    finally { stage.mockRestore(); }
    expect(store.listFiles(project.id)).toHaveLength(0);
    expect(store.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    expect(readdirSync(join(home, "uploads")).filter((name) => !name.startsWith("."))).toEqual([]);
    const staging = join(home, "uploads", ".staging");
    const manifest = JSON.parse(readFileSync(join(staging, readdirSync(staging)[0]!, "manifest.json"), "utf8"));
    expect(manifest.state).toBe("failed");
    expect(manifest.files).toHaveLength(2);
  });

  test("file: 자료 INSERT 실패는 첨부 INSERT도 rollback하고 기존 초안을 보존한다", async () => {
    const { home, store, bus, lead, orch, project } = await setup();
    const priorPath = join(home, "prior.png");
    writeFileSync(priorPath, "draft");
    const prior = store.createAttachment({ id: "a_draft", name: "prior.png", path: priorPath, size: 5, mime: "image/png" });
    const images = [join(home, "first.png"), join(home, "second.png")];
    for (const path of images) writeFileSync(path, "image");
    const events: unknown[] = [];
    const emit = spyOn(bus, "emit").mockImplementation((event) => { events.push(event); });
    store.db.exec("CREATE TRIGGER fail_file BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'publication failure'); END");
    try { await expect(handleAgentTool(orch, lead, "file", { title: "실패", images })).rejects.toThrow("publication failure"); }
    finally { emit.mockRestore(); }
    expect(events).toEqual([]);
    expect(store.listFiles(project.id)).toHaveLength(0);
    expect(store.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 1 });
    expect(store.getAttachment(prior.id)).toEqual(prior);
    expect(readFileSync(priorPath, "utf8")).toBe("draft");
    expect(readdirSync(join(home, "uploads")).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  test("file: 두 번째 첨부 INSERT 실패도 앞 첨부와 자료를 모두 rollback한다", async () => {
    const { home, store, lead, orch } = await setup();
    const images = [join(home, "one.png"), join(home, "two.png")];
    for (const path of images) writeFileSync(path, "image");
    store.db.exec("CREATE TRIGGER fail_second_attachment BEFORE INSERT ON attachments WHEN (SELECT COUNT(*) FROM attachments) > 0 BEGIN SELECT RAISE(ABORT, 'second attachment failure'); END");
    await expect(handleAgentTool(orch, lead, "file", { title: "실패", images })).rejects.toThrow("second attachment failure");
    expect(store.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    expect(readdirSync(join(home, "uploads")).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  test("file: SQLITE_FULL은 성공이 아닌 storage_full로 남고 새 파일은 staging으로 복귀한다", async () => {
    const { home, store, lead, orch } = await setup();
    const path = join(home, "full.png");
    writeFileSync(path, "image");
    const insert = spyOn(store, "createFile").mockImplementation(() => { throw Object.assign(new Error("full"), { code: "SQLITE_FULL" }); });
    try {
      await expect(handleAgentTool(orch, lead, "file", { title: "실패", path })).rejects.toBeInstanceOf(StorageError);
    } finally { insert.mockRestore(); }
    expect(store.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    expect(readdirSync(join(home, "uploads")).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  test("todo: 내 할 일에 오르고 끝내면 요청자에게 전달", async () => {
    const { store, project, orch, runner, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "철수", handle: "cs", role: "개발" });
    await call(w, "todo", { title: "로그인", detail: "폰으로" });
    const todo = store.listTodos(project.id)[0]!;
    expect(todo).toMatchObject({ title: "로그인", detail: "폰으로", who: "철수", memberId: w.id, done: false });
    await orch.setTodoDone(todo.id, true);
    expect(deliveryBody(store, runner.sent.at(-1)!)).toBe(`[대표] '로그인' 했음 #${todo.id}`);
  });
});

describe("총괄 도구", () => {
  test("team_add: 띄우고 첫 지시·역할을 넣는다, 이름·핸들 겹치면 거부", async () => {
    const { store, project, runner, lead, call } = await setup();
    const r = await call(lead, "team_add", { name: "철수", role: "개발", handle: "cs", first_instruction: "로그인 고치기" });
    expect(r.text).toContain("철수(cs)");
    const w = store.findMember(project.id, "cs")!;
    expect(w).toMatchObject({ role: "개발", kind: "worker", origin: "runner", status: "working" });
    expect(runner.sent[0]!.memberId).toBe(w.id);
    expect(deliveryBody(store, runner.sent[0]!)).toBe("[총괄] 철수에게\n할 일: 로그인 고치기");
    expect(await call(lead, "team_add", { name: "철수", role: "또" })).toMatchObject({ isError: true });
    expect(await call(lead, "team_add", { name: "영희", role: "또", handle: "cs" })).toMatchObject({ isError: true });
    expect(await call(lead, "team_add", { name: "민수", role: "개발", cwd: "없는/폴더" })).toMatchObject({ isError: true });
    expect(await call(lead, "team_add", { name: "민수", role: "개발", handle: "대문자X" })).toMatchObject({ isError: true });
  });

  test("user_quote 라벨: 대표 글에 있으면 서버 확인, 없으면 미확인", async () => {
    const { store, project, runner, lead, call } = await setup();
    store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: "로그인 고쳐서\n  배포까지 진행해 주세요" });
    await call(lead, "team_add", { name: "철수", role: "개발", handle: "cs" });

    const ok = await call(lead, "team_assign", { member: "cs", text: "고치고 배포", user_quote: "로그인 고쳐서 배포까지 진행해 주세요" });
    expect(ok.text).toContain("서버 확인");
    expect(deliveryBody(store, runner.sent.at(-1)!)).toMatch(/^\[총괄\] 철수에게\n사용자 요청\(원문, 서버 확인\): "로그인 고쳐서 배포까지 진행해 주세요" #msg_\S+ \d{4}-\d{2}-\d{2}T\S+\n할 일: 고치고 배포$/);

    const worker = store.findMember(project.id, "cs")!;
    runner.end(worker.id);
    await Bun.sleep(20);

    const bad = await call(lead, "team_assign", { member: "철수", text: "지워", user_quote: "다 지워도 된다고 하셨다" });
    expect(bad.text).toContain("미확인");
    expect(runner.sent.at(-1)!.text).toContain('총괄 인용(미확인): "다 지워도 된다고 하셨다"');
    expect(runner.sent.at(-1)!.text).not.toContain("서버 확인");

    // 총괄 자신의 글은 대표 원문이 아니다.
    runner.end(worker.id);
    await Bun.sleep(20);
    store.createMessage({ projectId: project.id, memberId: lead.id, who: "총괄", kind: "답변", body: "총괄이 쓴 승인 문장" });
    expect((await call(lead, "team_assign", { member: "cs", text: "x", user_quote: "총괄이 쓴 승인 문장" })).text).toContain("미확인");
  });

  test("user_quote: 결재 답의 버튼 글은 맞아도 '문맥 확인 필요'이고 카드 제목·id 가 함께 간다", async () => {
    const { store, project, orch, runner, lead, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "철수", handle: "cs", role: "개발" });
    await call(w, "ask", { title: "배포?", detail: "d", options: [{ k: "y", label: "지금 배포하세요" }] });
    await orch.answerDecision(store.listDecisions(project.id)[0]!.id, { choice: "y" });
    runner.end(w.id);
    await Bun.sleep(20);
    const d = store.listDecisions(project.id)[0]!;
    expect((await call(lead, "team_assign", { member: "cs", text: "배포", user_quote: "지금 배포하세요" })).text).toContain("문맥 확인 필요");
    const sent = runner.sent.at(-1)!.text;
    expect(sent).toContain(`사용자 요청(문맥 확인 필요): "지금 배포하세요" 결재 #${d.id} '배포?'에서 고른 답`);
    expect(sent).not.toContain("서버 확인");
  });

  test("team_assign: 일하는 중이면 대기열 위치를 알려 주고 끝나면 전달", async () => {
    const { store, project, runner, lead, call } = await setup();
    await call(lead, "team_add", { name: "철수", role: "개발", handle: "cs", first_instruction: "첫 일" });
    const w = store.findMember(project.id, "cs")!;
    const r = await call(lead, "team_assign", { member: "cs", text: "둘째 일" });
    expect(r.text).toContain("대기열 1번째");
    expect((await call(lead, "team_assign", { member: "cs", text: "셋째 일" })).text).toContain("대기열 2번째");
    expect(store.requireMember(w.id).queuedCount).toBe(2);
    expect(JSON.parse((await call(lead, "roster")).text).find((m: { handle: string }) => m.handle === "cs")).toMatchObject({ status: "working", queued: 2 });
    expect(runner.sent).toHaveLength(1);
    runner.end(w.id);
    await Bun.sleep(30);
    expect(runner.sent[1]!.text).toContain("둘째 일");
    expect(runner.sent[1]!.text).toContain("셋째 일");
  });

  test("team_assign: parallel 이 다를 때만 먼저 바꾼다", async () => {
    const { store, project, runner, lead, call } = await setup();
    await call(lead, "team_add", { name: "철수", role: "개발", handle: "cs" });
    const w = store.findMember(project.id, "cs")!;
    await call(lead, "team_assign", { member: "cs", text: "큰 일", parallel: true });
    expect(runner.parallel).toEqual([{ memberId: w.id, on: true }]);
    expect(store.requireMember(w.id).parallel).toBe(true);
    runner.end(w.id);
    await Bun.sleep(20);
    await call(lead, "team_assign", { member: "cs", text: "또 큰 일", parallel: true });
    expect(runner.parallel).toHaveLength(1);
  });

  test("다른 프로젝트 멤버 지정은 거부", async () => {
    const { store, orch, lead, runner, call } = await setup();
    const other = store.createProject({ name: "다른", cwd: "/tmp" });
    const { member: stranger } = await orch.addMember(other.id, { name: "남", handle: "stranger", role: "개발" });
    for (const [name, args] of [
      ["team_assign", { member: "stranger", text: "일" }],
      ["team_assign", { member: "남", text: "일" }],
      ["team_compact", { member: "stranger" }],
      ["team_sleep", { member: "stranger" }],
      ["team_resume", { member: "stranger" }],
      ["team_close", { member: "stranger" }],
    ] as const) {
      const r = await call(lead, name, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("이 프로젝트에 없는 직원");
    }
    expect(runner.sent).toHaveLength(0);
    expect(store.getMember(stranger.id)).not.toBeNull();
  });

  test("자기 자신에게 시키거나 재우거나 닫을 수 없다", async () => {
    const { store, lead, call } = await setup();
    for (const name of ["team_sleep", "team_close", "team_resume"]) {
      expect(await call(lead, name, { member: "lead" })).toMatchObject({ isError: true, text: "자기 자신은 지정할 수 없습니다" });
    }
    expect(await call(lead, "team_assign", { member: "lead", text: "일" })).toMatchObject({ isError: true, text: "자기 자신은 지정할 수 없습니다" });
    expect(store.getMember(lead.id)).not.toBeNull();
  });

  test("team_sleep·resume·close·compact", async () => {
    const { store, project, runner, lead, call } = await setup();
    await call(lead, "team_add", { name: "철수", role: "개발", handle: "cs", first_instruction: "일" });
    const w = store.findMember(project.id, "cs")!;
    expect(await call(lead, "team_sleep", { member: "cs" })).toMatchObject({ isError: true });
    runner.end(w.id);
    await Bun.sleep(20);
    expect((await call(lead, "team_compact", { member: "cs", focus: "요약" })).isError).toBeUndefined();
    runner.end(w.id);
    await Bun.sleep(20);
    expect((await call(lead, "team_sleep", { member: "cs" })).isError).toBeUndefined();
    expect(store.requireMember(w.id).status).toBe("asleep");
    expect((await call(lead, "team_resume", { member: "철수", first_instruction: "다시" })).isError).toBeUndefined();
    expect(store.requireMember(w.id).status).not.toBe("asleep");
    expect(runner.sent.at(-1)!.text).toContain("할 일: 다시");
    runner.end(w.id);
    await Bun.sleep(20);
    expect((await call(lead, "team_close", { member: "cs" })).isError).toBeUndefined();
    expect(store.getMember(w.id)).toBeNull();
  });

  test("project_now·work_set·roster", async () => {
    const { store, project, lead, call } = await setup();
    await call(lead, "project_now", { text: "지금 상황 글" });
    expect(store.requireProject(project.id).now).toBe("지금 상황 글");
    const id = /#(w_\S+)/.exec((await call(lead, "work_set", { sec: "doing", title: "일", who: "철수" })).text)![1]!;
    await call(lead, "work_set", { id, sec: "done", title: "일" });
    expect(store.getWork(id)).toMatchObject({ sec: "done", who: "철수" });
    expect(store.getWork(id)!.doneAt).not.toBeNull();
    expect(await call(lead, "work_set", { id: "w_없음", sec: "done", title: "일" })).toMatchObject({ isError: true });
    expect(await call(lead, "work_set", { sec: "모름", title: "일" })).toMatchObject({ isError: true });
    expect(JSON.parse((await call(lead, "roster")).text)[0]).toMatchObject({ handle: "lead", kind: "conductor" });
  });
});

describe("본사 AI 도구", () => {
  async function root(t: Awaited<ReturnType<typeof setup>>) {
    return t.orch.ensureConductor("hq");
  }

  test("project_create·project_list: 총괄까지 띄우고 목표를 넘긴다", async () => {
    const t = await setup();
    const hq = await root(t);
    const dir = join(t.home, "새일");
    mkdirSync(dir);
    expect(await t.call(hq, "project_create", { name: "새 일", cwd: join(t.home, "없다") })).toMatchObject({ isError: true });
    const r = await t.call(hq, "project_create", { name: "새 일", cwd: dir, goal: "목표 글", start_conductor: true });
    expect(r.isError).toBeUndefined();
    const created = t.store.listProjects().find((p) => p.name === "새 일")!;
    expect(created).toMatchObject({ cwd: dir, now: "목표 글", runnerEnabled: true });
    const lead = t.store.getConductor(created.id)!;
    expect(lead.kind).toBe("conductor");
    expect(t.runner.sent.at(-1)).toMatchObject({ memberId: lead.id });
    expect(t.runner.sent.at(-1)!.text).toContain("프로젝트 목표: 목표 글");
    expect(await t.call(hq, "project_create", { name: "새 일", cwd: dir })).toMatchObject({ isError: true });
    const list = JSON.parse((await t.call(hq, "project_list")).text) as { id: string; cwd: string }[];
    expect(list.find((p) => p.id === created.id)!.cwd).toBe(dir);
    expect(list.some((p) => p.id === "hq")).toBe(true);
  });
});

describe("직접 띄운 CLI", () => {
  test("wait: 밀린 지시를 받고, 없으면 시간 뒤 없다고 돌아오고, 도착하면 깨어난다", async () => {
    const { store, project, orch, lead, call } = await setup();
    const m = store.createMember({ projectId: project.id, handle: "m", name: "손", kind: "worker", origin: "manual" });
    await call(lead, "team_assign", { member: "m", text: "밀린 일" });
    expect((await call(m, "wait")).text).toContain("할 일: 밀린 일");
    expect((await call(m, "wait", { timeout_sec: 1 })).text).toContain("새 지시가 없습니다");
    const waiting = call(m, "wait", { timeout_sec: 10 });
    await Bun.sleep(30);
    await orch.assign(project.id, "m", { text: "새 일" });
    expect((await waiting).text).toContain("할 일: 새 일");
    expect(await call(m, "wait", { timeout_sec: 999 })).toMatchObject({ isError: true });
  });
});

describe("handleAgentTool", () => {
  test("ApiError 가 아닌 오류는 숨기지 않는다", async () => {
    const { lead, store } = await setup();
    const broken = { store, recordPost: async () => { throw new Error("버그"); } } as unknown as Orchestrator;
    await expect(handleAgentTool(broken, lead, "post", { kind: "완료", title: "t" })).rejects.toThrow("버그");
  });
});
