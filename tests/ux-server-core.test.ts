import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { DeliveryRecovery } from "../server/delivery-recovery.ts";
import { startServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { CoreError } from "../server/runner/core-client.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { Store, type ExecutionJournal } from "../server/store.ts";
import type { Delivery, Member } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

// No provider is launched; every asynchronous boundary can be held or refused in memory.
class UxRunner implements Runner {
  readonly kind = "core" as const;
  starts: { member: RunnerMember; resume: boolean }[] = [];
  stops: string[] = [];
  sent: { id: string; text: string }[] = [];
  busy = new Set<string>();
  probes = 0;
  startGate: (() => Promise<void>) | null = null;
  sendGate: (() => Promise<SendResult>) | null = null;
  callback: (event: RunnerEvent) => void = () => {};
  async available() { this.probes++; return { ok: true }; }
  async start(member: RunnerMember, opts: StartOpts) {
    this.starts.push({ member, resume: !!opts.resume });
    await this.startGate?.();
    return { sessionId: member.sessionId ?? `native-${member.id}`, paneId: `pane-${member.id}` };
  }
  async send(member: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ id: member.id, text }); this.busy.add(member.id);
    return this.sendGate ? this.sendGate() : { ok: true, started: true, turn: 0 };
  }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async applyConfig(): Promise<SendResult> { throw new Error("core configuration must use managed resume"); }
  async stop(member: RunnerMember) { this.stops.push(member.id); this.busy.delete(member.id); }
  async interrupt() {}
  async screen() { return ""; }
  async shutdown() {}
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
  end(store: Store, id: string, turn = 1, errorText?: string) {
    const member = store.requireMember(id); this.busy.delete(id);
    this.callback({ type: "turn_end", memberId: id, terminalId: member.paneId, sessionGeneration: store.memberRevisions(id).sessionGeneration, turn, finalText: "", isError: !!errorText, ...(errorText ? { errorText } : {}) });
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
function fixture(maxConcurrentTurns = 4) {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath), bus = new Bus(), store = new Store(db, bus), runner = new UxRunner();
  store.patchSettings({ maxConcurrentTurns, boardTidyHours: 0 });
  const project = store.createProject({ name: "UX server core", cwd: isolated.paths.work });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000 } });
  let sequence = 0;
  function member(kind: Member["kind"] = "worker", cli: Member["cli"] = "claude") {
    const n = ++sequence;
    return store.createMember({ projectId: project.id, kind, cli, handle: `member${n}`, name: `담당 ${n}`, origin: "runner", backend: "core", status: "idle", cwd: project.cwd, sessionId: `native-${n}`, paneId: `pane-${n}` });
  }
  function enqueue(target: Member, kind: Delivery["kind"] = "instruction", refId?: string) {
    return store.enqueue({ projectId: project.id, memberId: target.id, kind, text: "할 일: 작업을 확인하세요", ...(refId ? { refType: "message" as const, refId } : {}) });
  }
  const notices = () => store.listMessages(project.id, { limit: 500 }).filter(m => m.id.startsWith("msg_delegation_ack_"));
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  return { config, db, bus, store, runner, project, orch, member, enqueue, notices };
}

function journal(f: ReturnType<typeof fixture>, member: Member, patch: Partial<ExecutionJournal> = {}) {
  const at = new Date().toISOString();
  const run: ExecutionJournal = { runId: randomUUID(), memberId: member.id, projectId: member.projectId,
    identity: { sessionId: member.sessionId, terminalId: member.paneId, sessionGeneration: 0, process: null },
    turn: 1, deliveryIds: [], phase: "running", inputReceivedAt: at, startedAt: at, lastProgressAt: null,
    endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null,
    createdAt: at, updatedAt: at, ...patch };
  f.store.saveExecutionJournal(run);
  return run;
}

test("message and answer HTTP receipts do not wait for cold start or health probes; duplicate IDs retain one intent", async () => {
  const f = fixture();
  let release!: () => void;
  f.runner.startGate = () => new Promise<void>(resolve => { release = resolve; });
  const server = await startServer({ config: f.config, store: f.store, bus: f.bus, orch: f.orch, delivery: f.orch.deliveryRecovery });
  expect(server.port).not.toBe(7878);
  cleanups.push(async () => { release?.(); await server.stop(); });
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { Authorization: `Bearer ${f.config.accessCode}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const response = await post(`/api/projects/${f.project.id}/messages`, { id: "ux-receipt", text: "작업 시작" });
  expect(response.status).toBe(200);
  const message = await response.json();
  expect(message.delivery).toBe("queued");
  expect(message.deliveryInfo[0].waitReason).toBe("waking");
  expect(f.runner.probes).toBe(0);
  expect(f.runner.starts).toHaveLength(1);
  expect(f.store.listDeliveries().filter(d => d.refId === message.id)).toHaveLength(1);
  expect((await post(`/api/projects/${f.project.id}/messages`, { id: "ux-receipt", text: "작업 시작" })).status).toBe(200);
  const lead = f.store.getConductor(f.project.id)!;
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: lead.id, who: lead.name, title: "진행할까요?", options: [{ k: "yes", label: "승인" }] });
  const answered = await post(`/api/decisions/${decision.id}/answer`, { choice: "yes" });
  expect(answered.status).toBe(200);
  expect((await answered.json()).status).toBe("answered");
  expect((await post(`/api/decisions/${decision.id}/answer`, { choice: "yes" })).status).toBe(200);
  expect(f.runner.probes).toBe(0);
  expect(f.store.listDeliveries().filter(d => d.refId === decision.id)).toHaveLength(1);
  release();
  await until(() => f.runner.sent.length === 1);
});

test("background start refusal preserves owner source and durable recipient intent", async () => {
  const f = fixture();
  f.runner.startGate = async () => { throw new CoreError("rejected", "fixture cold start refused"); };
  const message = await f.orch.sendUserMessage(f.project.id, { id: "ux-refusal", text: "원문 보존" });
  await until(() => f.store.listDeliveries().some(d => d.refId === message.id && d.status === "held"));
  const delivery = f.store.listDeliveries().find(d => d.refId === message.id)!;
  expect(f.store.requireMessage(message.id).body).toBe("원문 보존");
  expect(f.store.getMember(delivery.memberId)).not.toBeNull();
  expect(f.orch.deliveryRecovery.memberNotices(delivery.memberId).items[0].waitReason).toBe("runner_off");
});

test("a slow or uncertain send cannot delay receipt or automatically resend its input", async () => {
  const f = fixture(); const member = f.member();
  let release!: (value: SendResult) => void;
  f.runner.sendGate = () => new Promise(resolve => { release = resolve; });
  const message = await f.orch.sendUserMessage(f.project.id, { text: "한 번만 실행", targetMemberId: member.id });
  await until(() => f.runner.sent.length === 1);
  expect(f.store.requireMessage(message.id).body).toBe("한 번만 실행");
  release({ ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" });
  await f.orch.pump(member.id);
  const next = await f.orch.sendUserMessage(f.project.id, { text: "후속", targetMemberId: member.id });
  expect(f.store.requireMessage(next.id).deliveryInfo?.[0].waitReason).toBe("receipt_check");
  await f.orch.deliveryRecovery.tick(); await f.orch.pump(member.id);
  expect(f.runner.sent).toHaveLength(1);
});

test("run limit reason includes global used/limit and matches message and member summaries", async () => {
  const f = fixture(1); const busy = f.member(), waiting = f.member();
  await f.orch.assign(f.project.id, busy.handle, { text: "앞 작업" });
  const message = await f.orch.sendUserMessage(f.project.id, { text: "대기 작업", targetMemberId: waiting.id });
  await f.orch.pump(waiting.id);
  const info = f.store.requireMessage(message.id).deliveryInfo![0];
  expect(info).toMatchObject({ waitReason: "run_limit", runLimit: { used: 1, limit: 1 } });
  const summary = f.orch.deliveryRecovery.memberNotices(waiting.id).summary;
  expect(summary).toMatchObject({ waitReason: "run_limit", waitingSince: info.waitingSince, runLimit: { used: 1, limit: 1 } });
  expect(summary.waitReasons).toMatchObject([{ waitReason: "run_limit", count: 1 }]);
});

test("wait reason distinguishes working, approval, manual control, disabled and archived", async () => {
  const f = fixture(); const member = f.member(), delivery = f.enqueue(member);
  f.store.patchMember(member.id, { status: "working" });
  expect(f.store.deliveryWait(delivery).waitReason).toBe("member_busy");
  f.store.patchMember(member.id, { status: "blocked" });
  expect(f.store.deliveryWait(delivery).waitReason).toBe("approval");
  f.store.patchMember(member.id, { status: "idle" });
  f.store.saveLease({ memberId: member.id, claimId: "ux-claim", leaseId: "ux-lease", identity: { sessionId: member.sessionId, terminalId: member.paneId, sessionGeneration: 0, process: null }, expiresAt: Date.now() + 60_000, lastInputSequence: 0 });
  expect(f.store.deliveryWait(delivery).waitReason).toBe("manual_control");
  f.store.patchProject(f.project.id, { runnerEnabled: false });
  expect(f.store.deliveryWait(delivery).waitReason).toBe("runner_off");
  f.store.patchProject(f.project.id, { archived: true });
  expect(f.store.deliveryWait(delivery).waitReason).toBe("archived");
});

test("wake=1 reasonless stall creates one durable visible notice; recheck is idempotent and never creates a new delivery", async () => {
  const f = fixture(); const member = f.member(), delivery = f.enqueue(member);
  const future = Date.parse(delivery.createdAt) + 120_001;
  // 서버는 이제 알리기 전에 한 번 스스로 다시 민다(delivery-1). 이 시험은 그러고도 남은 정체의 알림을 본다: 밀기 없는 저장소로 판정한다.
  f.store.setDeliveryWaitContext(() => ({ busy: false, waking: false, used: 0 }), () => {});
  f.store.detectDeliveryStalls(future);
  const restart = new Store(f.db, new Bus());
  restart.detectDeliveryStalls(future + 10_000);
  expect(restart.listMessages(f.project.id).filter(m => m.title === "전달 확인 필요")).toHaveLength(1);
  expect(restart.listActivity(member.id).filter(a => a.text.includes("전달이 진행되지"))).toHaveLength(1);
  let rechecks = 0;
  restart.setDeliveryWaitContext(() => ({ busy: false, waking: false, used: 0 }), () => { rechecks++; });
  const recovery = new DeliveryRecovery({ store: restart, runner: () => null, now: () => future });
  const item = recovery.memberNotices(member.id).items[0];
  expect(item).toMatchObject({ phase: "needs_owner", waitReason: "unknown", allowedActions: ["recheck", "stop_retry"], recommendation: { text: "다시 확인" } });
  const request = { action: "recheck" as const, operationId: randomUUID(), expectedVersion: item.version };
  const first = await recovery.recover(delivery.id, request);
  expect(await recovery.recover(delivery.id, request)).toEqual(first);
  expect(rechecks).toBe(1);
  expect(restart.listDeliveries()).toHaveLength(1);
  expect(restart.getDeliveryRecovery(delivery.id)?.phase).toBe("none");
  expect(f.runner.sent).toHaveLength(0);
  f.enqueue(member);
  expect(recovery.memberNotices(member.id).summary.waitingBehindCount).toBe(0);
  expect(recovery.fenced(member.id)).toBe(false);
});

test("known waiting reasons do not generate a reasonless-stall alert", () => {
  const f = fixture(); const member = f.member(); f.store.patchMember(member.id, { status: "blocked" });
  const delivery = f.enqueue(member);
  f.store.detectDeliveryStalls(Date.parse(delivery.createdAt) + 3_600_000);
  expect(f.store.listMessages(f.project.id).filter(m => m.title === "전달 확인 필요")).toHaveLength(0);
});

for (const kind of ["system", "report"] as const) test(`passive ${kind} waits for an idle recipient's next turn beyond 120 seconds`, () => {
  const f = fixture(); const member = f.member("conductor");
  const message = f.store.createMessage({ projectId: f.project.id, kind: "알림", body: "다음 턴에 확인" });
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind, text: message.body, wake: false, refType: "message", refId: message.id });
  f.store.detectDeliveryStalls(Date.parse(delivery.createdAt) + 120_001);
  expect(f.store.deliveryWait(delivery).waitReason).toBe("next_turn");
  expect(f.store.requireMessage(message.id).deliveryInfo?.[0].waitReason).toBe("next_turn");
  expect(f.orch.deliveryRecovery.memberNotices(member.id).summary).toMatchObject({ waitReason: "next_turn", needsOwnerCount: 0 });
  expect(f.store.deliveryStalled(delivery.id)).toBe(false);
  expect(f.store.listMessages(f.project.id).filter(m => m.title === "전달 확인 필요")).toHaveLength(0);
  expect(f.runner.sent).toHaveLength(0);
});

test("passive input waits through the existing turn and restart, but a later started turn cannot leave it queued", () => {
  const f = fixture(1); const member = f.member();
  const current = journal(f, member);
  f.store.patchMember(member.id, { status: "working" });
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "system", text: "다음 입력", wake: false });
  const future = Date.parse(delivery.createdAt) + 120_001;
  const restart = new Store(f.db, new Bus());
  restart.detectDeliveryStalls(future);
  expect(restart.deliveryWait(delivery).waitReason).toBe("next_turn");
  expect(restart.deliveryStalled(delivery.id)).toBe(false);
  f.store.saveExecutionJournal({ ...current, phase: "ended", endedAt: delivery.createdAt, result: "success" });
  // Deliberately use the same timestamp: insertion order must identify the next turn.
  const next = journal(f, member, { createdAt: delivery.createdAt, phase: "received", startedAt: null });
  expect(restart.deliveryWait(delivery).waitReason).toBe("next_turn");
  f.store.saveExecutionJournal({ ...next, phase: "running", startedAt: delivery.createdAt });
  restart.detectDeliveryStalls(future);
  expect(restart.deliveryWait(delivery).waitReason).toBe("unknown");
  expect(restart.deliveryStalled(delivery.id)).toBe(true);
  f.store.saveExecutionJournal({ ...next, phase: "ended", startedAt: delivery.createdAt, endedAt: delivery.createdAt, result: "success" });
  f.store.patchMember(member.id, { status: "idle" });
  expect(restart.deliveryWait(delivery).waitReason).toBe("unknown");
  expect(f.store.listMessages(f.project.id).filter(m => m.title === "전달 확인 필요")).toHaveLength(1);
  expect(f.runner.sent).toHaveLength(0);
});

test("old passive stall records resolve on reevaluation and retain the original system messages", () => {
  const f = fixture(); const member = f.member("conductor");
  for (const kind of ["system", "report"] as const) {
    const delivery = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind, text: "정상 대기", wake: false });
    f.db.query("INSERT INTO delivery_stalls (delivery_id, detected_at) VALUES (?, ?)").run(delivery.id, delivery.createdAt);
    const history = f.store.createMessage({ id: `msg_delivery_stalled_${delivery.id}`, projectId: f.project.id, kind: "시스템", title: "전달 확인 필요", body: "과거 오탐 원문" });
    const restart = new Store(f.db, new Bus());
    restart.detectDeliveryStalls(Date.parse(delivery.createdAt) + 120_001);
    expect(restart.deliveryStalled(delivery.id)).toBe(false);
    expect(f.db.query("SELECT resolved_at FROM delivery_stalls WHERE delivery_id = ?").get(delivery.id)).toMatchObject({ resolved_at: expect.any(String) });
    expect(restart.requireMessage(history.id).body).toBe(history.body);
  }
  expect(f.orch.deliveryRecovery.memberNotices(member.id).summary.needsOwnerCount).toBe(0);
  expect(f.runner.sent).toHaveLength(0);
});

test("legacy migration restores the passive turn boundary and resolves only normal waits", () => {
  const f = fixture(); const waiting = f.member(), missed = f.member();
  const at = Date.now(), before = new Date(at - 60_000).toISOString();
  for (const member of [waiting, missed]) journal(f, member, { createdAt: before, startedAt: before, phase: "ended" });
  const passive = [waiting, missed].map(member => f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "system", text: "기존 전달", wake: false }));
  journal(f, missed, { createdAt: new Date(at + 60_000).toISOString() });
  for (const delivery of passive) f.db.query("INSERT INTO delivery_stalls (delivery_id, detected_at) VALUES (?, ?)").run(delivery.id, before);
  f.db.exec("ALTER TABLE deliveries DROP COLUMN next_turn_after_run");
  f.db.exec("ALTER TABLE delivery_stalls DROP COLUMN resolved_at");
  f.db.exec(MIGRATIONS.find(sql => sql.includes("ADD COLUMN next_turn_after_run"))!);
  const restart = new Store(f.db, new Bus());
  restart.detectDeliveryStalls(at + 180_000);
  expect(restart.deliveryWait(passive[0]).waitReason).toBe("next_turn");
  expect(restart.deliveryStalled(passive[0].id)).toBe(false);
  expect(restart.deliveryWait(passive[1]).waitReason).toBe("unknown");
  expect(restart.deliveryStalled(passive[1].id)).toBe(true);
});

test("delegation acknowledgement checks each assignee's name, including post body, across restart", async () => {
  const f = fixture(); const lead = f.member("conductor"), first = f.member(), second = f.member();
  const source = f.enqueue(lead, "user_message", "owner-A");
  f.store.beginDelegationAck("ack-partial", lead.id, [source]);
  f.store.noteDelegation(lead.id, f.enqueue(first), false);
  f.store.noteDelegation(lead.id, f.enqueue(second), true);
  await f.orch.recordPost(lead, { kind: "진행", title: "확인했습니다", body: `${first.name}에게 맡겼습니다` });
  const restart = new Store(f.db, new Bus());
  restart.finishDelegationAck(lead.id, "ack-partial"); restart.finishDelegationAck(lead.id, "ack-partial");
  expect(f.notices().map(m => m.body)).toEqual([`총괄이 ${second.name}에게 맡겼습니다: 작업을 확인하세요 (앞 일 끝나면 시작)`]);
});

for (const posted of [true, false]) test(`bundle [A,B] -> [A] replay retains per-source acknowledgement (${posted ? "post" : "system"})`, () => {
  const f = fixture(); const lead = f.member("conductor"), worker = f.member();
  const a = f.enqueue(lead, "user_message", "owner-A"), b = f.enqueue(lead, "user_message", "owner-B");
  f.store.beginDelegationAck("ack-ab", lead.id, [a, b]);
  f.store.noteDelegation(lead.id, f.enqueue(worker), false);
  if (posted) f.store.noteDelegationPost(lead.id, `${worker.name}에게 맡겼습니다`);
  f.store.finishDelegationAck(lead.id, "ack-ab");
  const restart = new Store(f.db, new Bus());
  restart.beginDelegationAck("ack-a", lead.id, [a]);
  restart.noteDelegation(lead.id, f.enqueue(worker), false);
  restart.finishDelegationAck(lead.id, "ack-a");
  expect(f.notices()).toHaveLength(posted ? 0 : 1);
});

test("a supplement notification without a final report creates one owner-visible missing-result notice and no third execution", async () => {
  const f = fixture(); const member = f.member();
  await f.orch.assign(f.project.id, member.handle, { text: "원래 업무" });
  f.runner.end(f.store, member.id);
  await until(() => f.runner.sent.length === 2);
  await until(() => f.store.listActivity(member.id).filter(a => a.kind === "turn_start").length === 2);
  await f.orch.recordPost(member, { kind: "알림", title: "확인 중이며 아직 결과가 없습니다" });
  f.runner.end(f.store, member.id, 2);
  await until(() => f.store.listMessages(f.project.id).some(m => m.title === "결과 보고 누락"));
  f.runner.end(f.store, member.id, 2); await Bun.sleep(10);
  expect(f.store.listMessages(f.project.id).filter(m => m.title === "결과 보고 누락")).toHaveLength(1);
  const missing = f.store.listMissingReportNotices(f.project.id)[0];
  expect(f.store.requireMessage(missing.messageId).body).not.toContain(missing.runId);
  expect(f.runner.sent).toHaveLength(2);
  expect(f.runner.sent[1].text).toContain("기존 업무를 다시 실행하지 마세요");
  expect(f.orch.deliveryRecovery.notices(f.project.id).reportNotices).toMatchObject([{ kind: "missing_report", memberId: member.id, title: "결과 보고 누락" }]);
  await f.orch.recordPost(member, { kind: "완료", title: "늦게 남긴 결과" });
  expect(f.orch.deliveryRecovery.notices(f.project.id).reportNotices).toEqual([]);
});

test("an approval opened before a supplement plus a notification post is a valid result", async () => {
  const f = fixture(); const member = f.member();
  await f.orch.assign(f.project.id, member.handle, { text: "원 업무" });
  const original = f.store.listPendingExecutions().find(r => r.memberId === member.id)!;
  f.runner.end(f.store, member.id);
  await until(() => f.runner.sent.length === 2);
  await until(() => f.store.listActivity(member.id).filter(a => a.kind === "turn_start").length === 2);
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: member.id, who: member.name, title: "대표 답 대기" });
  // Reproduce a decision that was already open before this run began.
  f.db.query("UPDATE decisions SET created_at = ? WHERE id = ?").run(new Date(Date.parse(original.createdAt) - 60_000).toISOString(), decision.id);
  await f.orch.recordPost(member, { kind: "알림", title: "결재 카드는 이미 올라가 있고 답을 기다립니다", decisionId: decision.id });
  f.runner.end(f.store, member.id, 2);
  await until(() => f.store.listActivity(member.id).filter(a => a.kind === "turn_end").length === 2);
  expect(f.store.listMessages(f.project.id).filter(m => m.title === "결과 보고 누락")).toHaveLength(0);
  expect(f.store.listMissingReportNotices(f.project.id)).toEqual([]);
  expect(f.runner.sent).toHaveLength(2);
});

for (const kind of ["완료", "막힘", "질문"] as const) test(`a supplement notification needs no missing-report alert after an original ${kind}`, async () => {
  const f = fixture(); const member = f.member();
  const original = journal(f, member, { createdAt: "2026-11-09T05:00:00.000Z", phase: "ended" });
  f.store.createMessage({ projectId: f.project.id, memberId: member.id, kind, at: "2026-11-09T05:01:00.000Z", title: "원 업무의 유효 보고" });
  f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "system", text: `[시스템] 보고 보완: 실행 ${original.runId}의 결과만 post로 알려 주세요. 기존 업무를 다시 실행하지 마세요.` });
  await f.orch.pump(member.id);
  await until(() => f.store.listActivity(member.id).some(a => a.kind === "turn_start"));
  await f.orch.recordPost(member, { kind: "알림", title: "기존 보고를 확인해 주세요" });
  f.runner.end(f.store, member.id);
  await until(() => f.store.listActivity(member.id).some(a => a.kind === "turn_end"));
  expect(f.store.listMessages(f.project.id).filter(m => m.title === "결과 보고 누락")).toHaveLength(0);
  expect(f.runner.sent).toHaveLength(1);
});

for (const kind of ["완료", "답변", "막힘", "질문"] as const) test(`a ${kind} from the original work resolves an old supplement notice across restart`, () => {
  const f = fixture(); const member = f.member(), other = f.member();
  const start = "2026-11-09T05:00:00.000Z", supplementAt = "2026-11-09T05:02:00.000Z";
  const work = f.enqueue(member);
  const original = journal(f, member, { deliveryIds: [work.id], createdAt: start, phase: "ended" });
  const supplement = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "system", text: `[시스템] 보고 보완: 실행 ${original.runId}의 결과만 post로 알려 주세요. 기존 업무를 다시 실행하지 마세요.` });
  const run = journal(f, member, { deliveryIds: [supplement.id], createdAt: supplementAt, phase: "ended" });
  const history = f.store.createMessage({ id: `msg_missing_report_${run.runId}`, projectId: f.project.id, kind: "시스템", title: "결과 보고 누락", body: "과거 누락 오탐 원문" });
  f.store.createMessage({ projectId: f.project.id, memberId: member.id, kind, at: "2026-11-09T04:59:00.000Z" });
  f.store.createMessage({ projectId: f.project.id, memberId: other.id, kind, at: supplementAt });
  expect(f.store.listMissingReportNotices(f.project.id)).toHaveLength(1);
  f.store.createMessage({ projectId: f.project.id, memberId: member.id, kind, at: "2026-11-09T05:01:00.000Z" });
  const restart = new Store(f.db, new Bus());
  expect(restart.hasExecutionReport(run)).toBe(true);
  expect(restart.listMissingReportNotices(f.project.id)).toEqual([]);
  expect(restart.requireMessage(history.id).body).toBe(history.body);
  const unrelated = journal(f, member, { createdAt: "2026-11-09T05:03:00.000Z", deliveryIds: [f.enqueue(member).id] });
  expect(restart.hasExecutionReport(unrelated)).toBe(false);
  const replay = journal(f, member, { createdAt: unrelated.createdAt, deliveryIds: [work.id] });
  expect(restart.hasExecutionReport(replay)).toBe(true);
});

test("an older open approval clears an existing missing-report notice without deleting history", () => {
  const f = fixture(); const member = f.member(), other = f.member();
  const run = journal(f, member);
  const message = f.store.createMessage({ id: `msg_missing_report_${run.runId}`, projectId: f.project.id, kind: "시스템", title: "결과 보고 누락", body: "이력 유지" });
  f.store.createDecision({ projectId: f.project.id, memberId: other.id, who: other.name, title: "다른 직원 결재" });
  expect(f.store.listMissingReportNotices(f.project.id)).toHaveLength(1);
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: member.id, who: member.name, title: "답 대기" });
  f.db.query("UPDATE decisions SET created_at = ? WHERE id = ?").run("2026-11-09T00:00:00.000Z", decision.id);
  expect(new Store(f.db, new Bus()).listMissingReportNotices(f.project.id)).toEqual([]);
  expect(f.store.requireMessage(message.id).body).toBe("이력 유지");
});

for (const kind of ["conductor", "root"] as const) test(`${kind} worker-report wake is exempt; owner-command wake still requires a result`, async () => {
  const f = fixture(); const lead = f.member(kind), worker = f.member();
  await f.orch.recordPost(worker, { kind: "완료", title: "검토 결과" });
  await until(() => f.store.listActivity(lead.id).some(a => a.kind === "turn_start"));
  await f.orch.recordPost(lead, { kind: "진행", title: "직원 보고 확인" });
  f.runner.end(f.store, lead.id);
  await until(() => f.store.listActivity(lead.id).some(a => a.kind === "turn_end"));
  expect(f.store.listDeliveries().filter(d => d.text.includes("보고 보완:"))).toHaveLength(0);
  await f.orch.sendUserMessage(f.project.id, { text: "대표의 새 지시" });
  await until(() => f.store.listActivity(lead.id).filter(a => a.kind === "turn_start").length === 2);
  f.runner.end(f.store, lead.id, 2);
  await until(() => f.store.listDeliveries().some(d => d.text.includes("보고 보완:")));
});

for (const cli of ["codex", "claude"] as const) test(`${cli} idle settings reload resumes the same native session`, async () => {
  const f = fixture(); const member = f.member("worker", cli);
  f.store.patchMember(member.id, { effortOverride: "high" });
  await f.orch.pump(member.id);
  expect(f.runner.starts).toHaveLength(1);
  expect(f.runner.starts[0]).toMatchObject({ resume: true, member: { sessionId: member.sessionId, effort: "high" } });
  expect(f.store.requireMember(member.id).sessionId).toBe(member.sessionId);
});

test("unknown native ID defers both settings entry points without stopping a live Codex session", async () => {
  const f = fixture(); const member = f.member("worker", "codex");
  f.store.patchMember(member.id, { sessionId: null });
  await f.orch.patchMemberConfig(member.id, { effortOverride: "high" });
  await f.orch.pump(member.id); await f.orch.pump(member.id);
  expect(f.runner.starts).toHaveLength(0); expect(f.runner.stops).toHaveLength(0);
  expect(f.store.requireMember(member.id).paneId).toBe(member.paneId);
  expect(f.store.listActivity(member.id).filter(a => a.text.includes("설정 적용 보류"))).toHaveLength(1);
});

test("failed resume never falls back to a new native session", async () => {
  const f = fixture(); const member = f.member("worker", "codex");
  f.store.patchMember(member.id, { effortOverride: "high" });
  f.runner.startGate = async () => { throw new CoreError("session_unknown", "resume unavailable"); };
  await f.orch.pump(member.id); await f.orch.pump(member.id);
  expect(f.runner.starts).toHaveLength(1);
  expect(f.runner.starts[0].resume).toBe(true);
  expect(f.store.requireMember(member.id).sessionId).toBe(member.sessionId);
});

function decisionPair(f: ReturnType<typeof fixture>, member: Member, grouped = true) {
  const input = { projectId: f.project.id, memberId: member.id, who: member.name, title: "결제 검토", group: grouped ? "결제" : undefined, options: [{ k: "yes", label: "승인" }] };
  const answered = f.store.createDecision(input), open = f.store.createDecision(input);
  f.store.answerDecision(answered.id, { choice: "yes", note: "검토 범위만 진행" });
  return { answered, open };
}

test("ask_close uses a real same-project answered decision, quotes button and memo, and audits same-group closure atomically", async () => {
  const f = fixture(); const lead = f.member("conductor"), worker = f.member();
  const { answered, open } = decisionPair(f, worker);
  const result = await f.orch.handleAgentTool(lead, "ask_close", { id: open.id, kind: "decided", reason: "같은 안건 답변", answered_decision_id: answered.id, follow_up: { kind: "none" } });
  expect(result.isError, result.text).not.toBe(true);
  expect(f.store.requireDecision(open.id)).toMatchObject({ status: "closed", choice: null, note: null });
  expect(f.store.requireDecision(open.id).closeQuote).toContain('"승인"');
  expect(f.store.requireDecision(open.id).closeQuote).toContain('메모 "검토 범위만 진행"');
  expect(f.db.query("SELECT answered_decision_id FROM decision_close_audit WHERE decision_id = ?").get(open.id)).toMatchObject({ answered_decision_id: answered.id });
  expect(f.store.listPending(worker.id).some(d => d.text.includes(answered.id) && d.text.includes("검토 범위만 진행"))).toBe(true);
});

test("different groups require an explicit chief same-issue explanation; workers cannot assert that link", async () => {
  const f = fixture(); const lead = f.member("conductor"), worker = f.member();
  const { answered, open } = decisionPair(f, worker, false);
  const request = { id: open.id, kind: "decided" as const, reason: "대표 결정", answeredDecisionId: answered.id };
  await expect(f.orch.closeAsk(lead, request)).rejects.toThrow("same_issue");
  await expect(f.orch.closeAsk(worker, { ...request, sameIssue: "같은 결제 검토" })).rejects.toThrow("same_issue");
  await f.orch.closeAsk(lead, { ...request, sameIssue: "두 직원이 같은 결제 검토 범위를 물었습니다" });
  expect(f.db.query("SELECT same_issue FROM decision_close_audit WHERE decision_id = ?").get(open.id)).toMatchObject({ same_issue: "두 직원이 같은 결제 검토 범위를 물었습니다" });
});

test("unanswered, reopened, closed, foreign and obsolete answer evidence cannot close an open card", async () => {
  const f = fixture(); const lead = f.member("conductor"), worker = f.member();
  const { answered, open } = decisionPair(f, worker);
  const request = { id: open.id, kind: "decided" as const, reason: "대표 결정", answeredDecisionId: answered.id };
  await expect(f.orch.closeAsk(lead, { ...request, kind: "obsolete" })).rejects.toThrow();
  f.store.reopenDecision(answered.id);
  await expect(f.orch.closeAsk(lead, request)).rejects.toThrow("실제로 답한");
  f.store.closeDecision(answered.id, { kind: "obsolete", reason: "취소", by: "총괄" });
  await expect(f.orch.closeAsk(lead, request)).rejects.toThrow("실제로 답한");
  const foreign = f.store.createProject({ name: "다른 프로젝트", cwd: f.project.cwd });
  const other = f.store.createDecision({ projectId: foreign.id, who: "다른 직원", title: "다른 안건" });
  f.store.answerDecision(other.id, { note: "네" });
  await expect(f.orch.closeAsk(lead, { ...request, answeredDecisionId: other.id, sameIssue: "동일" })).rejects.toThrow("같은 프로젝트");
  expect(f.store.requireDecision(open.id).status).toBe("open");
  expect(f.db.query("SELECT * FROM decision_close_audit").all()).toHaveLength(0);
});

test("failed quoted-answer delivery rolls back closure and audit", async () => {
  const f = fixture(); const lead = f.member("conductor"), worker = f.member();
  const { answered, open } = decisionPair(f, worker);
  f.db.exec("CREATE TEMP TRIGGER ux_reject_outbox BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'fixture outbox refusal'); END");
  await expect(f.orch.closeAsk(lead, { id: open.id, kind: "decided", reason: "대표 결정", answeredDecisionId: answered.id })).rejects.toThrow("fixture outbox refusal");
  expect(f.store.requireDecision(open.id).status).toBe("open");
  expect(f.db.query("SELECT * FROM decision_close_audit").all()).toHaveLength(0);
});

test("answered-decision follow-up stores the verified answer source with closure and is operation-idempotent", async () => {
  const f = fixture(); const lead = f.member("conductor"), worker = f.member();
  const { answered, open } = decisionPair(f, worker);
  const args = { id: open.id, kind: "decided", reason: "중복 검토 정리", answered_decision_id: answered.id, follow_up: { kind: "instruction", member_id: worker.id, text: "승인된 범위만 검토하세요" } };
  const context = { operationId: randomUUID() };
  const result = await f.orch.handleAgentOperation(lead, "ask_close", args, context);
  expect(result.isError, result.text).not.toBe(true);
  expect(await f.orch.handleAgentOperation(lead, "ask_close", args, context)).toEqual(result);
  expect(f.store.getDecisionFollowUp(open.id)).toEqual({ kind: "instruction", memberId: worker.id, text: "승인된 범위만 검토하세요", sourceDecisionId: answered.id });
  const instructions = f.store.listDeliveries().filter(d => d.kind === "instruction");
  expect(instructions).toHaveLength(1);
  expect(instructions[0].text).toContain(answered.id);
  expect(instructions[0].text).toContain('메모 "검토 범위만 진행"');
  expect(f.db.query("SELECT * FROM decision_close_audit").all()).toHaveLength(1);
});

test("failed configuration resume stays deferred after restart and a natural wake resumes the original ID", async () => {
  const f = fixture(); const member = f.member("worker", "codex");
  f.store.patchMember(member.id, { effortOverride: "high" });
  f.runner.startGate = async () => { throw new CoreError("session_unknown", "resume unavailable"); };
  await f.orch.pump(member.id);
  await f.orch.shutdown();
  const restart = new Store(f.db, new Bus());
  const orch = new Orchestrator({ config: f.config, store: restart, runners: new Map([["core", f.runner]]), timings: { tickMs: 60_000, healthMs: 60_000 } });
  cleanups.push(() => orch.shutdown());
  restart.enqueue({ projectId: f.project.id, memberId: member.id, kind: "user_message", text: "다음 지시" });
  await orch.pump(member.id);
  expect(f.runner.starts).toHaveLength(1);
  expect(f.runner.sent).toHaveLength(0);
  f.runner.startGate = null;
  await orch.resumeMember(member.id);
  expect(f.runner.starts).toHaveLength(2);
  expect(f.runner.starts[1]).toMatchObject({ resume: true, member: { sessionId: member.sessionId } });
  expect(restart.deferredMemberConfig(member.id)).toBeNull();
});

test("one assignee's name is not confused with a longer assignee name", () => {
  const f = fixture(); const lead = f.member("conductor"), short = f.member(), longer = f.member();
  f.store.patchMember(short.id, { name: "검토 1" });
  f.store.patchMember(longer.id, { name: "검토 10" });
  const owner = f.enqueue(lead, "user_message", "name-boundary");
  f.store.beginDelegationAck("name-boundary-turn", lead.id, [owner]);
  f.store.noteDelegation(lead.id, f.enqueue(short), false);
  f.store.noteDelegation(lead.id, f.enqueue(longer), false);
  f.store.noteDelegationPost(lead.id, "검토 10에게 맡겼습니다");
  f.store.finishDelegationAck(lead.id);
  expect(f.notices().map(m => m.body)).toEqual(["총괄이 검토 1에게 맡겼습니다: 작업을 확인하세요"]);
});


test("supplement error also leaves the missing-result notice without reexecuting the task", async () => {
  const f = fixture(); const member = f.member();
  await f.orch.assign(f.project.id, member.handle, { text: "실행할 업무" });
  f.runner.end(f.store, member.id);
  await until(() => f.store.listActivity(member.id).filter(a => a.kind === "turn_start").length === 2);
  f.runner.end(f.store, member.id, 2, "fixture report unavailable");
  await until(() => f.orch.deliveryRecovery.notices(f.project.id).reportNotices!.length === 1);
  expect(f.runner.sent).toHaveLength(2);
});
