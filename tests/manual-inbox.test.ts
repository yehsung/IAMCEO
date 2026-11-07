import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import type { Backend, Member } from "../shared/types.ts";
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
  const store = new Store(db, new Bus());
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
  return { isolated, config, store, project, runner, orch, orchestrator, member, db };
}

test("unacknowledged manual batches are re-read across restart and ACK is idempotent", async () => {
  const f = fixture(); const member = f.member("worker", "manual");
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "Read exactly this batch" });
  const batch = await f.orch.manualInbox(member.id, 0);
  expect(batch?.items.map(item => item.deliveryId)).toEqual([delivery.id]);
  expect(f.store.requireDelivery(delivery.id).status).toBe("queued");
  expect(await f.orch.manualInbox(member.id, 0)).toEqual(batch);
  await f.orch.shutdown(); const next = f.orchestrator();
  expect(await next.manualInbox(member.id, 0)).toEqual(batch);
  const ack = await next.acknowledgeManualInbox(member.id, { batchId: batch!.id });
  expect(await next.acknowledgeManualInbox(member.id, { batchId: batch!.id })).toEqual(ack);
  expect(f.store.requireDelivery(delivery.id).status).toBe("delivered");
  expect(await next.manualInbox(member.id, 0)).toBeNull();
  expect(f.runner.sent).toHaveLength(0);
});

test("manual inbox retrieves answered cards outside the UI's latest fifty", async () => {
  const f = fixture(); const member = f.member("worker", "manual");
  const older = f.store.createDecision({ projectId: f.project.id, memberId: member.id, who: member.name, title: "Old unanswered delivery" });
  await f.orch.answerDecision(older.id, { note: "An old answer" });
  for (let i = 0; i < 60; i++) {
    const newer = f.store.createDecision({ projectId: f.project.id, memberId: member.id, who: member.name, title: `Later card ${i}` });
    f.store.answerDecision(newer.id, { note: "Later" });
    f.store.setDecisionStatus(newer.id, "delivered");
  }
  expect(f.store.listDecisions(f.project.id).some(d => d.id === older.id)).toBe(false);
  const batch = await f.orch.manualInbox(member.id, 0);
  expect(batch?.items[0].text).toContain("An old answer");
  expect(f.store.requireDecision(older.id).status).toBe("answered");
  await f.orch.acknowledgeManualInbox(member.id, { batchId: batch!.id });
  expect(f.store.requireDecision(older.id).status).toBe("delivered");
});

test("askWait cannot consume an answer owned by an outstanding general batch", async () => {
  const f = fixture(); const member = f.member("worker", "manual");
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: member.id, who: member.name, title: "Shared consumption" });
  await f.orch.answerDecision(decision.id, { note: "One answer" });
  const batch = await f.orch.manualInbox(member.id, 0);
  expect(await f.orch.askWait(member, decision.id, 0)).toEqual({ done: false });
  expect(f.store.requireDecision(decision.id).status).toBe("answered");
  await f.orch.acknowledgeManualInbox(member.id, { batchId: batch!.id });
  expect(await f.orch.manualInbox(member.id, 0)).toBeNull();
  expect((await f.orch.askWait(member, decision.id, 0)).done).toBe(true); // decision-specific retry remains compatible
});

test("askWait-first consumes through the same batch state and generic wait cannot duplicate it", async () => {
  const f = fixture(); const member = f.member("worker", "manual");
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: member.id, who: member.name, title: "Ask first" });
  await f.orch.answerDecision(decision.id, { note: "One answer" });
  expect((await f.orch.askWait(member, decision.id, 0)).done).toBe(true);
  expect(await f.orch.manualInbox(member.id, 0)).toBeNull();
  expect(await f.orch.waitInbox(member, 0)).toBeNull();
});

test("an archived project and aborted request never consume manual batches", async () => {
  const f = fixture(); const member = f.member("worker", "manual");
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "Keep" });
  const batch = await f.orch.manualInbox(member.id, 0);
  f.store.patchProject(f.project.id, { archived: true });
  expect(await f.orch.manualInbox(member.id, 0)).toBeNull();
  expect(await f.orch.waitInbox(member, 0)).toBeNull();
  await expect(f.orch.acknowledgeManualInbox(member.id, { batchId: batch!.id })).rejects.toMatchObject({ status: 409 });
  f.store.patchProject(f.project.id, { archived: false });
  const abort = new AbortController(); abort.abort();
  expect(await f.orch.manualInbox(member.id, 0, abort.signal)).toBeNull();
  expect(f.store.requireDelivery(delivery.id).status).toBe("queued");
  expect(await f.orch.manualInbox(member.id, 0)).toEqual(batch);
});

test("manual answer wakes an already waiting generic inbox; cross-member ACK and ask are refused", async () => {
  const f = fixture(); const member = f.member("worker", "manual"); const other = f.member("worker", "manual");
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: member.id, who: member.name, title: "Wake wait" });
  const waiting = f.orch.manualInbox(member.id, 1000);
  await f.orch.answerDecision(decision.id, { note: "Wake" });
  const batch = await waiting;
  expect(batch?.items[0].ref?.id).toBe(decision.id);
  await expect(f.orch.acknowledgeManualInbox(other.id, { batchId: batch!.id })).rejects.toMatchObject({ status: 404 });
  await expect(f.orch.askWait(other, decision.id, 0)).rejects.toMatchObject({ status: 403 });
});
