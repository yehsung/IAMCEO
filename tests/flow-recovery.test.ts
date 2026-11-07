import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import type { Backend, Member, WsEvent } from "../shared/types.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

class FakeRunner implements Runner {
  readonly kind: Backend = "core";
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  sendResult: (m: RunnerMember) => Promise<SendResult> = async () => ({ ok: true, started: false, turn: 0 });
  callback: (event: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember) { return { sessionId: m.sessionId ?? `session-${m.id}`, paneId: `pane-${m.id}` }; }
  async send(m: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ memberId: m.id, text });
    this.busy.add(m.id);
    const result = await this.sendResult(m);
    if (!result.ok) this.busy.delete(m.id);
    return result;
  }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: RunnerMember) { this.busy.delete(m.id); }
  async screen() { return ""; }
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
  end(member: Member, turn = 1, errorText?: string) {
    this.busy.delete(member.id);
    this.callback({ type: "turn_end", memberId: member.id, terminalId: member.paneId, sessionGeneration: 0, turn, isError: !!errorText, finalText: "", ...(errorText ? { errorText } : {}) });
  }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
function fixture(maxConcurrentTurns = 2) {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath);
  const bus = new Bus();
  const store = new Store(db, bus);
  store.patchSettings({ maxConcurrentTurns, boardTidyHours: 0 });
  const project = store.createProject({ name: "Workflow", cwd: isolated.paths.work });
  const runner = new FakeRunner();
  const orchestrators: Orchestrator[] = [];
  function orchestrator() {
    const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000, turnErrorRetryMs: 1000 } });
    orchestrators.push(orch);
    return orch;
  }
  const orch = orchestrator();
  let memberSequence = 0;
  function member(kind: Member["kind"] = "worker", origin: Member["origin"] = "runner") {
    const i = ++memberSequence;
    return store.createMember({ projectId: project.id, handle: kind === "conductor" ? "lead" : `worker${i}`, name: `Member ${i}`, kind, origin, backend: "core", status: "idle", cwd: isolated.paths.work, paneId: `pane${i}`, sessionId: `session${i}` });
  }
  cleanups.push(async () => { for (const current of orchestrators) await current.shutdown(); db.close(); await isolated.stop(); });
  return { isolated, config, store, project, runner, orch, orchestrator, member, db, bus };
}

test("turn start/end member notifications already include the corresponding work timestamp", async () => {
  const f = fixture();
  const member = f.member();
  const events: WsEvent[] = [];
  f.bus.subscribe(event => events.push(event));
  await f.orch.sendUserMessage(f.project.id, { text: "작업 시작", targetMemberId: member.id });
  await until(() => f.store.listActivity(member.id).some(activity => activity.kind === "turn_start"));
  const start = f.store.listActivity(member.id).find(activity => activity.kind === "turn_start")!;
  expect(events.some(event => event.type === "member" && event.member.id === member.id && event.member.status === "working" && event.member.lastActiveAt === start.at)).toBe(true);
  events.length = 0;
  f.runner.end(f.store.requireMember(member.id));
  await until(() => f.store.listActivity(member.id).some(activity => activity.kind === "turn_end"));
  const end = f.store.listActivity(member.id).find(activity => activity.kind === "turn_end")!;
  expect(events.some(event => event.type === "member" && event.member.id === member.id && event.member.status === "idle" && event.member.lastActiveAt === end.at)).toBe(true);
});

test("todo cancellation during an awaited send creates one correction after receipt", async () => {
  const f = fixture(); const member = f.member();
  const todo = f.store.createTodo({ projectId: f.project.id, memberId: member.id, title: "External action" });
  let resolve!: (result: SendResult) => void;
  f.runner.sendResult = () => new Promise(done => { resolve = done; });
  const completing = f.orch.setTodoDone(todo.id, true);
  expect(f.runner.sent).toHaveLength(1);
  const original = f.store.listDeliveries()[0];
  expect(original.status).toBe("delivering");
  await f.orch.setTodoDone(todo.id, false);
  expect(f.store.listDeliveries()).toHaveLength(1);
  resolve({ ok: true, started: false, turn: 0 });
  await completing;
  const corrections = f.store.listDeliveries().filter(d => d.text.includes("아직 안 했음"));
  expect(corrections).toHaveLength(1);
  expect(f.store.requireTodo(todo.id).done).toBe(false);
  await f.orch.setTodoDone(todo.id, false);
  await f.orch.shutdown(); const next = f.orchestrator(); await next.recover();
  expect(f.store.listDeliveries().filter(d => d.text.includes("아직 안 했음"))).toHaveLength(1);
});

test("unknown todo writes stay fenced and compensation is created after later positive evidence", async () => {
  const f = fixture(); const member = f.member();
  const todo = f.store.createTodo({ projectId: f.project.id, memberId: member.id, title: "Unknown action" });
  f.runner.sendResult = async () => ({ ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" });
  await f.orch.setTodoDone(todo.id, true);
  await f.orch.setTodoDone(todo.id, false);
  expect(f.store.listDeliveries().filter(d => d.text.includes("아직 안 했음"))).toHaveLength(0);
  const dispatch = f.store.listDispatches(member.id)[0];
  f.orch.deliveryRecovery.recordResult(dispatch.dispatchId, { ok: true, receipt: { dispatchId: dispatch.dispatchId, receivedAt: new Date().toISOString(), source: "transport" } });
  await f.orch.shutdown(); const next = f.orchestrator(); await next.recover();
  expect(f.store.listDeliveries().filter(d => d.text.includes("아직 안 했음"))).toHaveLength(1);
});

test("closing a decision persists the explicit follow-up and original source atomically", async () => {
  const f = fixture(); const lead = f.member("conductor"); const worker = f.member();
  f.store.patchProject(f.project.id, { runnerEnabled: false });
  const source = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "새 저장소로 이전을 진행하세요" });
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: worker.id, who: worker.name, title: "Move?" });
  const followUp = { kind: "instruction" as const, memberId: worker.id, text: "저장소 이전 실행", sourceMessageId: source.id };
  await f.orch.closeDecision(lead, { id: decision.id, kind: "decided", reason: "대표가 결정", userQuote: source.body, followUp });
  expect(f.store.requireDecision(decision.id).status).toBe("closed");
  expect(f.store.getDecisionFollowUp(decision.id)).toEqual(followUp);
  const instructions = f.store.listDeliveries().filter(d => d.kind === "instruction");
  expect(instructions).toHaveLength(1);
  expect(instructions[0].text).toContain(source.id);
  expect(instructions[0].text).toContain(decision.id);
  const none = f.store.createDecision({ projectId: f.project.id, memberId: worker.id, who: worker.name, title: "No follow up" });
  await f.orch.closeDecision(lead, { id: none.id, kind: "obsolete", reason: "불필요", followUp: { kind: "none" } });
  expect(f.store.getDecisionFollowUp(none.id)).toEqual({ kind: "none" });
});

test("failed follow-up enqueue rolls back decision closing and follow-up metadata", async () => {
  const f = fixture(); const lead = f.member("conductor"); const worker = f.member();
  const source = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "저장소를 이전해 주세요" });
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: worker.id, who: worker.name, title: "Move?" });
  const enqueue = f.store.enqueue.bind(f.store);
  f.store.enqueue = () => { throw new Error("injected enqueue failure"); };
  await expect(f.orch.closeDecision(lead, { id: decision.id, kind: "decided", reason: "대표 결정", userQuote: source.body, followUp: { kind: "instruction", memberId: worker.id, text: "Move", sourceMessageId: source.id } })).rejects.toThrow("injected");
  f.store.enqueue = enqueue;
  expect(f.store.requireDecision(decision.id).status).toBe("open");
  expect(f.store.getDecisionFollowUp(decision.id)).toBeNull();
  expect(f.store.listDeliveries()).toHaveLength(0);
});

test("report envelope retains every file, decision, authored order and explicit correction", async () => {
  const f = fixture(); f.member("conductor"); const worker = f.member();
  f.store.patchProject(f.project.id, { runnerEnabled: false });
  const files = ["One", "Two", "Three"].map(title => f.store.createFile({ projectId: f.project.id, title }));
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: worker.id, who: worker.name, title: "Reference" });
  const first = await f.orch.recordPost(worker, { kind: "완료", title: "Artifacts", fileIds: files.map(file => file.id), decisionId: decision.id });
  const correction = await f.orch.recordPost(worker, { kind: "알림", title: "Correction", correctsMessageId: first.id });
  const refs = f.orch.reportReferences(f.project.id, first.id);
  expect(refs).toMatchObject({ sourceMessageId: first.id, fileIds: files.map(file => file.id), decisionIds: [decision.id], authoredAt: first.at, correctsMessageId: null });
  const newer = f.orch.reportReferences(f.project.id, correction.id);
  expect(newer.sequence).toBeGreaterThan(refs.sequence);
  expect(newer.correctsMessageId).toBe(first.id);
  const reports = f.store.listDeliveries().filter(d => d.kind === "report");
  expect(reports[0].text).toContain(first.id);
  for (const file of files) expect(reports[0].text).toContain(file.id);
  expect(reports[0].text).toContain(decision.id);
  expect(reports[1].text).toContain(`정정 대상 #${first.id}`);
});

test("full orphan repair recovers old originals plus existing-recipient answers/reports without duplicates", async () => {
  const f = fixture(); const lead = f.member("conductor"); const worker = f.member();
  const old = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "Old original", delivery: "queued" });
  const targeted = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "Target original", delivery: "held", targetMemberId: worker.id });
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: worker.id, who: worker.name, title: "Old answer" });
  f.store.answerDecision(decision.id, { note: "Persisted without intent" });
  const report = f.store.createMessage({ projectId: f.project.id, memberId: worker.id, kind: "완료", who: worker.name, title: "Old report" });
  for (let i = 0; i < 510; i++) f.store.createMessage({ projectId: f.project.id, kind: "알림", body: `Later ${i}` });
  await f.orch.recover();
  for (const [id, target] of [[old.id, lead.id], [targeted.id, worker.id], [decision.id, worker.id], [report.id, lead.id]]) expect(f.store.listDeliveries().filter(d => d.refId === id && d.memberId === target)).toHaveLength(1);
  await f.orch.shutdown(); const next = f.orchestrator(); await next.recover();
  for (const id of [old.id, targeted.id, decision.id, report.id]) expect(f.store.listDeliveries().filter(d => d.refId === id)).toHaveLength(1);
});

test("core missing final report requests a single supplement, progress is insufficient, and supplement cannot loop", async () => {
  const f = fixture(); const member = f.member();
  await f.orch.assign(f.project.id, member.handle, { text: "Do the work" });
  const run = f.store.listPendingExecutions()[0];
  await f.orch.recordPost(member, { kind: "진행", title: "Still progressing" });
  f.runner.end(member);
  await until(() => f.runner.sent.length === 2);
  expect(f.store.getExecutionJournal(run.runId)?.reportRequestedAt).toEqual(expect.any(String));
  expect(f.runner.sent[1].text).toContain("기존 업무를 다시 실행하지 마세요");
  f.runner.end(member, 2);
  await Bun.sleep(15);
  expect(f.runner.sent).toHaveLength(2);
  expect(f.store.listDeliveries().filter(d => d.text.includes("보고 보완:"))).toHaveLength(1);
});

test("completed/blocked posts, questions, delegation and tidy-only turns are valid no-supplement exits", async () => {
  for (const kind of ["완료", "막힘", "질문", "위임", "정리"] as const) {
    const f = fixture(); const member = f.member(kind === "위임" ? "conductor" : "worker");
    const text = kind === "정리" ? "[시스템] 판 정리: nothing changed" : "Work";
    f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "system", text });
    await f.orch.pump(member.id);
    if (kind === "질문") await f.orch.registerAsk(member, { title: "Need a decision" });
    else if (kind === "위임") {
      const child = f.member();
      expect((await f.orch.handleAgentTool(member, "team_assign", { member: child.handle, text: "Delegate" })).isError).toBeUndefined();
    } else if (kind !== "정리") await f.orch.recordPost(member, { kind, title: "Result" });
    f.runner.end(member);
    await Bun.sleep(10);
    expect(f.store.listDeliveries().filter(d => d.text.includes("보고 보완:"))).toHaveLength(0);
  }
});

test("the reviewed board revision survives restart before terminal completion", async () => {
  const f = fixture(); const lead = f.member("conductor");
  await f.orch.tidyBoard(f.project.id);
  expect((await f.orch.handleAgentTool(lead, "board", {})).isError).toBeUndefined();
  const run = f.store.listPendingExecutions()[0];
  const reviewed = f.store.getBoardReview(f.project.id)!;
  expect(f.store.getExecutionJournal(run.runId)?.reason).toBe(`board_review:${reviewed.requestedRevision}:${reviewed.requestedRevision}`);
  f.store.createTodo({ projectId: f.project.id, title: "Arrived after board read" });
  await f.orch.shutdown(); const next = f.orchestrator(); await next.recover();
  f.runner.end(lead);
  await until(() => f.store.getBoardReview(f.project.id)?.completedAt !== null);
  expect(f.store.getBoardReview(f.project.id)?.reviewedRevision).toBe(reviewed.requestedRevision);
  expect(f.store.boardRevision(f.project.id)).toBeGreaterThan(reviewed.requestedRevision);
  expect(f.store.listDeliveries().filter(d => d.text.includes("판 정리"))).toHaveLength(1);
});

test("a live Codex core terminal is eligible for scheduled tidy without inventing a native session ID", async () => {
  const f = fixture(); const lead = f.member("conductor");
  f.store.patchMember(lead.id, { cli: "codex", sessionId: null });
  f.store.patchSettings({ boardTidyHours: 1 });
  f.store.setBoardTidiedAt(f.project.id, new Date(Date.now() - 7_200_000).toISOString());
  f.store.createTodo({ projectId: f.project.id, title: "Board changed" });
  await f.orch.refreshConnection();
  expect(f.orch.checkBoardTidy()).toEqual([f.project.id]);
  await until(() => f.runner.sent.length === 1);
  expect(f.store.requireMember(lead.id).sessionId).toBeNull();
});
