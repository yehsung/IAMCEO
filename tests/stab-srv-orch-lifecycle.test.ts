import { afterEach, describe, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator, type OrchestratorTimings } from "../server/orchestrator.ts";
import { CoreError } from "../server/runner/core-client.ts";
import type { Backend, Member } from "../shared/types.ts";
import type { Runner, RunnerEvent, RunnerMember, RunnerStartResult, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { USAGE_RESUME_TEXT } from "../server/api-outage.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(what: string, condition: () => boolean) {
  for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5);
  if (!condition()) throw new Error(`시간 초과: ${what}`);
}
function gate() {
  let open!: () => void;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { wait, open };
}

/** 소켓 없이 core 실행기의 계약만 흉내 낸다. 시험이 결과와 시점을 정한다. */
class FakeCore implements Runner {
  readonly kind = "core" as const;
  callback: (e: RunnerEvent) => void = () => {};
  sent: string[] = [];
  compacted: string[] = [];
  starts = 0;
  stops = 0;
  busy = new Set<string>();
  sendImpl: (m: RunnerMember, text: string) => Promise<SendResult> = async () => ({ ok: true, started: true, turn: 1 });
  compactImpl: (m: RunnerMember) => Promise<SendResult> = async () => ({ ok: true, started: false });
  stopImpl: (m: RunnerMember) => Promise<void> = async () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember): Promise<RunnerStartResult> { this.starts++; return { sessionId: m.sessionId ?? `s-${m.id}`, paneId: `t-${m.id}-${this.starts}` }; }
  async send(m: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push(text);
    const result = await this.sendImpl(m, text);
    if (result.ok) this.busy.add(m.id);
    return result;
  }
  async compact(m: RunnerMember, focus: string): Promise<SendResult> { this.compacted.push(focus); return this.compactImpl(m); }
  isBusy(id: string) { return this.busy.has(id); }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: RunnerMember) { this.stops++; await this.stopImpl(m); }
  async screen() { return ""; }
  on(callback: (e: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
}

function fixture(timings: Partial<OrchestratorTimings> = {}, prepare?: (store: Store, worker: () => Member) => void) {
  const runtime = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: runtime.socketPath, IAMCEO_CORE_BIN: runtime.bins.coreBin, IAMCEO_CLAUDE_BIN: runtime.bins.claudeBin, IAMCEO_CODEX_BIN: runtime.bins.codexBin });
  const db = openDb(config.dbPath), store = new Store(db, new Bus());
  store.patchSettings({ boardTidyHours: 0 });
  const fake = new FakeCore();
  const project = store.createProject({ name: "안정성", cwd: runtime.paths.work, runnerEnabled: true });
  let count = 0;
  const worker = (): Member => { count++; return store.createMember({ projectId: project.id, handle: `w${count}`, name: `직원${count}`, kind: "worker", origin: "runner", backend: "core", status: "idle", paneId: `pane${count}`, sessionId: `session${count}` }); };
  // 서버가 뜨기 전에 남아 있던 영속 상태를 만든다.
  prepare?.(store, worker);
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", fake]]), providerHomes: runtime.providerHomes,
    timings: { tickMs: 60_000, healthMs: 60_000, retryMs: 5, inputBusyRetryMs: 5, ...timings } });
  const say = (member: Member, text = "[대표] 안녕하세요") => store.enqueue({ projectId: project.id, memberId: member.id, kind: "user_message", text });
  const emit = async (e: RunnerEvent) => { fake.callback(e); await Bun.sleep(2); };
  const idle = (member: Member, freshness: "fresh" | "stale" = "fresh"): RunnerEvent => ({ type: "status", memberId: member.id, status: "idle", terminalId: member.paneId,
    observation: { source: "core", observedAt: new Date().toISOString(), freshness, ownership: "verified", consecutiveFailures: freshness === "fresh" ? 0 : 1, error: null } });
  let closed = false;
  const shutdown = async () => { if (!closed) { closed = true; await orch.shutdown(); } };
  cleanups.push(async () => { await shutdown(); db.close(); await runtime.stop(); });
  // 시험이 private 흐름(건강 확인·틱)을 실제 주기 대신 직접 돌린다.
  const internals = orch as unknown as { probeHealth(): Promise<void>; onTick(): void };
  return { runtime, config, db, store, fake, orch, project, worker, say, emit, idle, shutdown, probeHealth: () => internals.probeHealth(), tick: () => internals.onTick() };
}

describe("잠재우기와 깨우는 입력의 경합", () => {
  test("종료 결과가 미확정인 사이 온 깨움은 복구가 잠을 마친 뒤 직원을 다시 깨워 전달된다", async () => {
    const f = fixture(), w = f.worker();
    f.fake.stopImpl = async () => { throw new CoreError("timeout", "terminal.kill: no reply", true); };
    await expect(f.orch.sleepMember(w.id)).rejects.toThrow();
    expect(f.store.listPendingLifecycleJournals()[0]).toMatchObject({ intent: "sleep", phase: "unknown" });
    const d = f.say(w);
    await f.orch.pump(w.id);
    expect(f.fake.sent).toHaveLength(0);
    f.fake.stopImpl = async () => {};
    await f.probeHealth();
    await until("깨움 전달", () => f.store.requireDelivery(d.id).status === "delivered");
    expect(f.store.listPendingLifecycleJournals()).toHaveLength(0);
    expect(f.fake.starts).toBe(1);
    expect(f.fake.sent).toHaveLength(1);
    expect(f.store.requireMember(w.id).lastError).toBeNull();
  });

  test("미확정 종료의 복구는 그 사이 일을 시작한 CLI 를 끊지 않는다", async () => {
    const f = fixture(), w = f.worker();
    f.fake.stopImpl = async () => { throw new CoreError("timeout", "terminal.kill: no reply", true); };
    await expect(f.orch.sleepMember(w.id)).rejects.toThrow();
    f.fake.stopImpl = async () => {};
    f.say(w);
    f.fake.busy.add(w.id);
    const stops = f.fake.stops;
    await f.probeHealth();
    expect(f.fake.stops).toBe(stops);
    expect(f.store.requireMember(w.id).status).not.toBe("asleep");
    expect(f.store.listPendingLifecycleJournals()).toHaveLength(1);
  });

  test("잠재우는 사이 도착한 깨움은 '잠듦'으로 묻히지 않고 곧바로 다시 깨운다", async () => {
    const f = fixture(), w = f.worker(), stopping = gate(), entered = gate();
    const quiet = f.store.enqueue({ projectId: f.project.id, memberId: w.id, kind: "system", text: "[시스템] 참고", wake: false });
    f.fake.stopImpl = async () => { entered.open(); await stopping.wait; };
    const sleeping = f.orch.sleepMember(w.id);
    await entered.wait;
    const d = f.say(w);
    await f.orch.pump(w.id);
    expect(f.fake.sent).toHaveLength(0);
    stopping.open();
    await sleeping;
    await until("깨움 전달", () => f.store.requireDelivery(d.id).status === "delivered");
    expect(f.fake.starts).toBe(1);
    expect(f.store.requireDelivery(quiet.id).status).toBe("delivered");
    expect(f.store.requireMember(w.id).status).toBe("working");
  });

  test("강제로 재울 때 이미 있던 깨움은 그대로 '잠듦' 보류이고, 깨우지 않는 소식만 있으면 잠든 채 둔다", async () => {
    const f = fixture(), w = f.worker(), other = f.worker();
    f.fake.sendImpl = async () => ({ ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" });
    const before = f.say(w);
    await f.orch.sleepMember(w.id, { force: true });
    expect(f.store.requireDelivery(before.id)).toMatchObject({ status: "held", holdReason: "asleep" });
    const stopping = gate(), entered = gate();
    f.fake.stopImpl = async () => { entered.open(); await stopping.wait; };
    const sleeping = f.orch.sleepMember(other.id);
    await entered.wait;
    const quiet = f.store.enqueue({ projectId: f.project.id, memberId: other.id, kind: "system", text: "[시스템] 참고", wake: false });
    stopping.open();
    await sleeping;
    await f.orch.pump(other.id);
    expect(f.store.requireMember(other.id).status).toBe("asleep");
    expect(f.store.requireDelivery(quiet.id)).toMatchObject({ status: "held", holdReason: "asleep" });
    expect(f.fake.starts).toBe(0);
  });
});

const busy: SendResult = { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: "No trustworthy idle OSC 7501 status" };

describe("거절된 전달과 준비 신호", () => {
  test("거절 뒤 미뤄 둔 전달은 DB 상태가 이미 idle 이어도 준비 신호(fresh idle)가 오면 곧바로 다시 나간다", async () => {
    const f = fixture({ retryMs: 60_000 }), w = f.worker();
    f.fake.sendImpl = async () => busy;
    const d = f.say(w);
    await f.orch.pump(w.id);
    expect(f.fake.sent).toHaveLength(1);
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "queued", attempts: 1 });
    expect(Date.parse(f.store.getDeliveryRetry(d.id).nextAttemptAt!)).toBeGreaterThan(Date.now() + 30_000);
    expect(f.store.requireMember(w.id).status).toBe("idle");
    f.fake.sendImpl = async () => ({ ok: true, started: true, turn: 1 });
    // 관측이 끊긴 사이의 idle 은 준비의 근거가 아니다.
    await f.emit(f.idle(w, "stale"));
    await f.orch.pump(w.id);
    expect(f.fake.sent).toHaveLength(1);
    await f.emit(f.idle(w));
    await until("다시 전달", () => f.store.requireDelivery(d.id).status === "delivered");
    expect(f.fake.sent).toHaveLength(2);
  });

  test("거절이 쌓여 길게 미뤄진 묶음도 준비 신호 한 번에 풀리고, 한도·인증 간격은 그대로 둔다", async () => {
    const f = fixture({ retryMs: 1 }), w = f.worker(), limited = f.worker();
    f.fake.sendImpl = async () => busy;
    const d = f.say(w);
    // 거절마다 짧은 재시도가 다시 밀어 상한(5회)에 닿으면 긴 간격으로 바뀐다.
    await f.orch.pump(w.id);
    await until("거절 상한", () => f.store.requireDelivery(d.id).holdReason === "input_busy");
    const attempts = f.fake.sent.length;
    expect(Date.parse(f.store.getDeliveryRetry(d.id).nextAttemptAt!)).toBeGreaterThan(Date.now() + 20_000);
    f.fake.sendImpl = async () => ({ ok: true, started: true, turn: 1 });
    await f.emit(f.idle(w));
    await until("다시 전달", () => f.store.requireDelivery(d.id).status === "delivered");
    expect(f.fake.sent).toHaveLength(attempts + 1);

    const q = f.say(limited), due = new Date(Date.now() + 60_000).toISOString();
    f.store.patchDeliveryRetry(q.id, { nextAttemptAt: due, retryScope: `member:${limited.id}`, retryReason: "processing_quota" });
    await f.emit(f.idle(limited));
    await f.orch.pump(limited.id);
    expect(f.store.getDeliveryRetry(q.id).nextAttemptAt).toBe(due);
    expect(f.store.requireDelivery(q.id).status).toBe("queued");
  });
});

describe("압축 예약이 전달을 굶기지 않는다", () => {
  for (const trigger of ["manual", "auto"] as const) test(`${trigger} 압축을 입력칸 글 때문에 계속 못 넣으면 접고 기다리던 전달을 보낸다`, async () => {
    const f = fixture({ retryMs: 2, inputBusyLimitMs: 30 }), w = f.worker();
    f.store.ensureContextState(w.id);
    f.fake.compactImpl = async () => ({ ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written" });
    if (trigger === "manual") await f.orch.compactMember(w.id, "초점");
    else (f.orch as unknown as { queueCoreCompact(member: Member, trigger: "auto", focus: string): void }).queueCoreCompact(w, "auto", "초점");
    const d = f.say(w);
    await f.orch.pump(w.id);
    expect(f.store.getContextState(w.id)?.compaction).toMatchObject({ phase: "queued", reason: "draft" });
    expect(f.fake.sent).toHaveLength(0);
    await until("전달", () => f.store.requireDelivery(d.id).status === "delivered");
    expect(f.store.getContextState(w.id)?.compaction).toMatchObject({ phase: "failed", reason: "draft", trigger });
    expect(f.store.listActivity(w.id).some(a => a.text.startsWith("압축 실패: 입력칸의 글이나 CLI 화면"))).toBe(true);
    const attempts = f.fake.compacted.length;
    expect(attempts).toBeGreaterThan(1);
    await f.orch.pump(w.id); await f.orch.pump(w.id);
    expect(f.fake.compacted).toHaveLength(attempts);
  });

  test("한 번 미뤄진 압축은 입력칸이 비면 그대로 진행된다", async () => {
    const f = fixture({ retryMs: 2, inputBusyLimitMs: 60_000 }), w = f.worker();
    f.store.ensureContextState(w.id);
    f.fake.compactImpl = async () => ({ ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written" });
    await f.orch.compactMember(w.id, "초점");
    expect(f.store.getContextState(w.id)?.compaction).toMatchObject({ phase: "queued", reason: "draft" });
    f.fake.compactImpl = async m => {
      const state = f.store.ensureContextState(m.id);
      f.store.saveContextState({ ...state, compaction: { ...state.compaction!, phase: "running" } });
      return { ok: true, started: false };
    };
    await until("압축 시작", () => f.store.getContextState(w.id)?.compaction?.phase === "running");
  });
});

describe("종료는 진행 중인 전송의 결과 기록을 기다린다", () => {
  test("전송 중에 종료해도 거절 결과가 기록되어 write_started 가 남지 않는다", async () => {
    const f = fixture(), w = f.worker(), sending = gate();
    f.fake.sendImpl = async () => { await sending.wait; return busy; };
    const d = f.say(w);
    void f.orch.pump(w.id);
    await until("전송 시작", () => f.fake.sent.length === 1);
    expect(f.store.listDispatches(w.id).at(-1)!.transportState).toBe("write_started");
    let closed = false;
    const closing = f.shutdown().then(() => { closed = true; });
    await Bun.sleep(20);
    expect(closed).toBe(false);
    sending.open();
    await closing;
    expect(f.store.listDispatches(w.id).at(-1)!.transportState).toBe("rejected");
    expect(f.store.requireDelivery(d.id).status).toBe("queued");
    expect(f.store.inputState(w.id).unresolvedDispatches).toHaveLength(0);
    expect(f.store.listPendingExecutions().filter(run => run.memberId === w.id)).toHaveLength(0);
  });

  test("끝나지 않는 전송은 상한까지만 기다리고 종료한다", async () => {
    const f = fixture({ shutdownDrainMs: 20 }), w = f.worker();
    f.fake.sendImpl = () => new Promise<SendResult>(() => {});
    f.say(w);
    void f.orch.pump(w.id);
    await until("전송 시작", () => f.fake.sent.length === 1);
    await f.shutdown();
    expect(f.store.listDispatches(w.id).at(-1)!.transportState).toBe("write_started");
  });
});

describe("API 장애·사용 한도 보류의 출구", () => {
  test("이어가기를 포기해 멈춰 둔 직원도 대표가 새로 말을 걸면 기다리던 것과 함께 전달된다", async () => {
    let w!: Member;
    const f = fixture({}, (store, worker) => {
      w = worker();
      store.saveApiRecovery("api_recovery", { outage: { id: "incident", since: new Date(Date.now() - 30 * 60_000).toISOString(), active: false, lastProbeAt: null, successes: 2,
        affected: [{ memberId: w.id, ended: true, attempts: 3, resumeId: null, awaitingResult: false, exhausted: true, exhaustedAt: new Date(Date.now() - 10 * 60_000).toISOString() }] }, limits: [] });
    });
    const waiting = f.store.enqueue({ projectId: f.project.id, memberId: w.id, kind: "instruction", text: "[총괄] 기다리던 지시" });
    await f.orch.pump(w.id);
    expect(f.fake.sent).toHaveLength(0);
    expect(f.store.requireDelivery(waiting.id)).toMatchObject({ status: "held", holdReason: "api_outage" });
    const said = f.say(w, "[대표] 이어서 해 주세요");
    await f.orch.pump(w.id);
    expect(f.fake.sent).toHaveLength(1);
    expect(f.store.requireDelivery(waiting.id).status).toBe("delivered");
    expect(f.store.requireDelivery(said.id).status).toBe("delivered");
    expect(f.orch.apiRecovery.holdReason(w.id)).toBeNull();
  });

  test("한도에 걸린 채 잠든 직원도 '모두 이어가기'로 풀려 깨어나며 이어가기를 먼저 받는다", async () => {
    const f = fixture(), w = f.worker();
    f.orch.apiRecovery.usageFailure(w, "usage limit reached: unknown reset raw");
    f.store.patchMember(w.id, { status: "asleep", paneId: null });
    const card = f.store.listDecisions(f.project.id).find(d => d.kind === "usage_limit")!;
    await f.orch.answerDecision(card.id, { choice: "resume" });
    await until("이어가기 전달", () => f.fake.sent.length === 1);
    expect(f.fake.starts).toBe(1);
    expect(f.fake.sent[0]).toContain(USAGE_RESUME_TEXT);
    expect(f.orch.apiRecovery.holdReason(w.id)).toBeNull();
    expect(f.store.listDecisions(f.project.id).find(d => d.id === card.id)?.detail ?? "").not.toContain("창을 닫지 못했습니다");
  });
});
