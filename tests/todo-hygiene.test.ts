import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { Orchestrator, TIDY_HEAD, formatTidy } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import type { Backend, Member } from "../shared/types.ts";

const DAY = 86_400_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
class HygieneRunner implements Runner {
  readonly kind: Backend = "core";
  /** 운영의 CoreRunner 와 같다: 돌고 있는 턴에 끼워 넣지 못한다. 급한 글도 턴이 끝난 뒤 나간다. */
  readonly interjects = false;
  sent: string[] = [];
  private listener: (event: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start() { return { sessionId: crypto.randomUUID(), paneId: null }; }
  async send(_member: { id: string }, text: string): Promise<SendResult> { this.sent.push(text); return { ok: true }; }
  isBusy() { return false; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop() {}
  async screen() { return ""; }
  async shutdown() {}
  on(listener: (event: RunnerEvent) => void) { this.listener = listener; }
  end(memberId: string) { this.listener({ type: "turn_end", memberId, finalText: "", isError: false }); }
}
/** 고정 대기 대신 조건을 기다린다. 끝내 안 맞으면 무엇을 기다렸는지 말하고 떨어진다. */
const until = async (cond: () => boolean, label: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${label} 시간 초과`);
    await Bun.sleep(5);
  }
};
async function setup() {
  if (!process.env.IAMCEO_TEST || !process.env.IAMCEO_HOME) throw new Error("Use bun run test:server");
  const home = mkdtempSync(join(process.env.IAMCEO_HOME, "hygiene-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env), bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus), runner = new HygieneRunner();
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", runner]]) });
  const server = await startServer({ config, store, bus, orch });
  const url = server.urls[0]!;
  orch.setServerUrl(url);
  cleanups.push(async () => { await orch.shutdown(); await server.stop(); });
  const project = store.createProject({ name: "hygiene", cwd: home });
  const lead = await orch.ensureConductor(project.id);
  // core 직원의 전달 펌프는 터미널 조작 임대 정리를 기다리는 구간이 있어 한 박자 늦게 끝난다. 띄운 직후의 펌프가 끝난 뒤에 시험을 시작한다.
  await orch.pump(lead.id);
  const worker = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker", backend: "core" });
  const oldTodo = (memberId: string | null = worker.id, age = 4 * DAY) => {
    const todo = store.createTodo({ projectId: project.id, memberId, title: "ASC 로그인" });
    store.db.query("UPDATE todos SET created_at = ? WHERE id = ?").run(new Date(Date.now() - age).toISOString(), todo.id);
    return store.requireTodo(todo.id);
  };
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
    method: "POST", headers: { Authorization: "Bearer code", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
  });
  return { home, store, runner, orch, project, lead, worker, oldTodo, post };
}

test("stale reminders are passive, durable, and limited to once per 72 hours", async () => {
  const t = await setup();
  const old = t.oldTodo();
  const now = Date.now();
  t.oldTodo(t.worker.id, DAY);
  expect(t.orch.checkStaleTodos(now)).toEqual([old.id]);
  const notice = t.store.listPending(t.worker.id)[0]!;
  expect(notice).toMatchObject({ kind: "system", wake: false, memberId: t.worker.id });
  expect(notice.text).toContain(`#${old.id}`);
  expect(notice.text).toContain("4일째");
  expect(notice.text).toContain("todo_close");
  const sent = t.runner.sent.length;
  await t.orch.pump(t.worker.id);
  expect(t.runner.sent).toHaveLength(sent);
  expect(t.orch.checkStaleTodos(now + 3 * DAY - 1)).not.toContain(old.id);
  // A separate orchestrator over the same DB observes the persisted stamp.
  const restarted = new Orchestrator({ config: loadConfig({ IAMCEO_HOME: t.home, IAMCEO_PORT: "0" }), store: t.store, runners: new Map() });
  expect(restarted.checkStaleTodos(now + DAY)).not.toContain(old.id);
  expect(t.orch.checkStaleTodos(now + 3 * DAY)).toContain(old.id);
  expect(t.store.listPending(t.worker.id).filter(d => d.text.includes(`#${old.id}`))).toHaveLength(2);
});

test("strict three-day boundary, no recipient retry, and sleeping requester keep next-turn semantics", async () => {
  const t = await setup(), now = Date.now();
  const boundary = t.oldTodo();
  t.store.db.query("UPDATE todos SET created_at = ? WHERE id = ?").run(new Date(now - 3 * DAY).toISOString(), boundary.id);
  expect(t.orch.checkStaleTodos(now)).toEqual([]);
  expect(t.orch.checkStaleTodos(now + 1)).toEqual([boundary.id]);
  const unowned = t.oldTodo(null);
  t.store.removeMember(t.lead.id);
  expect(t.orch.checkStaleTodos(now + 2)).toEqual([]);
  expect(t.store.db.query<{ stale_notified_at: string | null }, [string]>("SELECT stale_notified_at FROM todos WHERE id = ?").get(unowned.id)!.stale_notified_at).toBeNull();
  const lead = t.store.createMember({ projectId: t.project.id, handle: "replacement", name: "새 총괄", kind: "conductor" });
  expect(t.orch.checkStaleTodos(now + 3)).toEqual([unowned.id]);
  expect(t.store.listPending(lead.id)[0]).toMatchObject({ wake: false });
  const asleep = t.oldTodo();
  await t.orch.memberSleep(t.worker.id);
  expect(t.orch.checkStaleTodos(now + 4)).toEqual([asleep.id]);
  const sent = t.runner.sent.length;
  await t.orch.pump(t.worker.id);
  expect(t.store.requireMember(t.worker.id).status).toBe("asleep");
  expect(t.runner.sent).toHaveLength(sent);
});

test("missing/deleted/non-worker requesters fall back to lead; archived and closed todos are excluded", async () => {
  const t = await setup();
  const missing = t.oldTodo(null), leadMade = t.oldTodo(t.lead.id), deleted = t.oldTodo();
  t.store.db.query("DELETE FROM members WHERE id = ?").run(t.worker.id);
  const closed = t.oldTodo(null);
  t.store.closeTodo(closed.id, { outcome: "done", reason: "확인", by: "대표" });
  expect(t.orch.checkStaleTodos().sort()).toEqual([missing.id, leadMade.id, deleted.id].sort());
  expect(t.store.listPending(t.lead.id).filter(d => d.text.includes("일째 열려"))).toHaveLength(3);
  const archived = t.store.createProject({ name: "보관", cwd: t.home });
  const todo = t.store.createTodo({ projectId: archived.id, title: "보관 일" });
  t.store.db.query("UPDATE todos SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 5 * DAY).toISOString(), todo.id);
  t.store.db.query("UPDATE projects SET archived = 1 WHERE id = ?").run(archived.id);
  expect(t.orch.checkStaleTodos()).toEqual([]);
});

test("stale board review runs without changes, no more than daily, and keeps operational guards", async () => {
  const t = await setup(), now = Date.now();
  t.oldTodo();
  const revision = t.store.boardRevision(t.project.id);
  t.store.requestBoardReview(t.project.id, new Date(now).toISOString());
  t.store.completeBoardReview(t.project.id, revision, revision);
  // Unchanged and below the normal 6-hour interval, but stale work must be reviewed.
  expect(t.orch.checkBoardTidy(now)).toEqual([t.project.id]);
  await until(() => t.runner.sent.some(text => text.includes(TIDY_HEAD)), "판 정리 전달");
  t.runner.end(t.lead.id);
  // 턴 끝이 처리되고 그 끝에 도는 전달 펌프까지 끝난 뒤에 본다(펌프가 도는 총괄은 주기 판 정리가 건너뛴다).
  await until(() => t.store.listActivity(t.lead.id).some(a => a.kind === "turn_end"), "턴 끝 처리");
  await t.orch.pump(t.lead.id);
  expect(t.orch.checkBoardTidy(now + DAY - 1)).toEqual([]);
  expect(t.orch.checkBoardTidy(now + DAY)).toEqual([t.project.id]);
  expect(formatTidy("conductor", false)).toContain("대표 브라우저");
  expect(formatTidy("root", false)).toContain("3일 넘은");
});

test("disabled periodic tidy stays disabled even for old todos", async () => {
  const t = await setup(); t.oldTodo();
  t.store.patchSettings({ boardTidyHours: 0 });
  expect(t.orch.checkBoardTidy()).toEqual([]);
});

test("drop requires CEO authentication and v2 preconditions; sends existing wake-policy notifications exactly once", async () => {
  const t = await setup(), todo = t.oldTodo();
  const path = `/api/todos/${todo.id}/drop`, revision = t.store.todoRevision(todo.id);
  expect((await t.post(path, {}, { Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await t.post(path, {}, { Authorization: `Bearer ${t.store.getMemberToken(t.worker.id)}` })).status).toBe(401);
  expect((await t.post(path, {}, { "X-IAMCEO-Contract": "2" })).status).toBe(400);
  expect((await t.post(path, {}, { "X-IAMCEO-Contract": "2", "If-Match": `"${revision + 1}"` })).status).toBe(409);
  expect((await t.post(path, { extra: true }, { "X-IAMCEO-Contract": "2", "If-Match": `"${revision}"` })).status).toBe(400);
  const response = await t.post(path, { reason: "  이미 필요 없음  " }, { "X-IAMCEO-Contract": "2", "If-Match": `"${revision}"` });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ revision: revision + 1, todo: { id: todo.id, done: true, outcome: "dropped", closedBy: "대표", closeReason: "이미 필요 없음" } });
  const notices = t.store.listDeliveries().filter(d => d.refId === todo.id);
  expect(notices.map(d => d.memberId).sort()).toEqual([t.worker.id, t.lead.id].sort());
  expect(notices.every(d => d.wake && d.kind === "todo_done" && d.text.includes("필요 없음"))).toBe(true);
  expect((await t.post(path)).status).toBe(200);
  expect(t.store.listDeliveries().filter(d => d.refId === todo.id)).toHaveLength(2);
  expect((await t.post(path, {}, { "X-IAMCEO-Contract": "2", "If-Match": `"${revision}"` })).status).toBe(409);
});

test("legacy drop defaults reason and existing web done/undo contracts survive", async () => {
  const t = await setup(), todo = t.oldTodo();
  const drop = await t.post(`/api/todos/${todo.id}/drop`, { reason: "  " });
  expect(await drop.json()).toMatchObject({ id: todo.id, outcome: "dropped", closeReason: "대표가 필요 없음으로 정리" });
  const undo = await t.post(`/api/todos/${todo.id}/done`, { done: false });
  expect(await undo.json()).toMatchObject({ id: todo.id, done: false, outcome: null, closeReason: null, closedBy: null });
  const done = await t.post(`/api/todos/${todo.id}/done`, { done: true });
  expect(await done.json()).toMatchObject({ id: todo.id, done: true, outcome: "done" });
  expect((await t.post(`/api/todos/${todo.id}/drop`)).status).toBe(409);
});

test("only passive notices allow sleep and survive resume without starting a turn, until a real wake", async () => {
  const t = await setup();
  const worker: Member = { ...t.worker, sessionId: "fixture-session", status: "idle" };
  t.store.patchMember(worker.id, { sessionId: worker.sessionId, status: "idle" });
  const todo = t.oldTodo();
  t.orch.checkStaleTodos();
  const passive = t.store.listPending(worker.id)[0]!;
  expect((await t.orch.memberSleep(worker.id)).status).toBe("asleep");
  expect(t.store.requireDelivery(passive.id)).toMatchObject({ wake: false, status: "held", holdReason: "asleep" });
  const sends = t.runner.sent.length;
  await t.orch.memberResume(worker.id);
  await t.orch.pump(worker.id);
  expect(t.runner.sent).toHaveLength(sends);
  expect(t.store.listPending(worker.id).map(d => d.id)).toContain(passive.id);
  t.store.enqueue({ projectId: t.project.id, memberId: worker.id, kind: "system", text: "실제 새 업무", wake: true });
  await expect(t.orch.memberSleep(worker.id)).rejects.toThrow("대기열이 남아");
  await t.orch.pump(worker.id);
  expect(t.runner.sent.at(-1)).toContain(`#${todo.id}`);
  expect(t.runner.sent.at(-1)).toContain("실제 새 업무");
});

test("unreceived decision answer still blocks sleep", async () => {
  const t = await setup();
  const decision = t.store.createDecision({ projectId: t.project.id, memberId: t.worker.id, who: "직원", title: "결재", options: [{ k: "yes", label: "예" }] });
  t.store.answerDecision(decision.id, { choice: "yes" });
  await expect(t.orch.memberSleep(t.worker.id)).rejects.toThrow("대기열이 남아");
});

test("migration upgrades the previous schema with nullable durable stamps and increments version", async () => {
  const t = await setup(), path = join(t.home, "previous.sqlite");
  const previous = new Database(path);
  for (const migration of MIGRATIONS.slice(0, -1)) previous.exec(migration);
  previous.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  previous.close();
  const migrated = openDb(path);
  try {
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(MIGRATIONS.length);
    expect(migrated.query<{ name: string }, []>("PRAGMA table_info(todos)").all().some(c => c.name === "stale_notified_at")).toBe(true);
    expect(migrated.query<{ name: string }, []>("PRAGMA table_info(projects)").all().some(c => c.name === "stale_review_at")).toBe(true);
  } finally { migrated.close(); }
});
