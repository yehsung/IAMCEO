import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator, type OrchestratorTimings } from "../server/orchestrator.ts";
import { CoreError } from "../server/runner/core-client.ts";
import type { Backend, Member } from "../shared/types.ts";
import type { Runner, RunnerEvent, RunnerMember, RunnerStartResult, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

// 배포 전 코드 리뷰(review:orchestrator, review:runner-recovery)에서 나온 것의 회귀 시험. 소켓·실제 CLI 없이 돈다.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** 소켓 없이 core 실행기의 계약만 흉내 낸다. 시험이 결과와 시점을 정한다. */
class FakeCore implements Runner {
  readonly kind = "core" as const;
  callback: (e: RunnerEvent) => void = () => {};
  sent: string[] = [];
  starts = 0;
  busy = new Set<string>();
  sendImpl: (m: RunnerMember, text: string) => Promise<SendResult> = async () => ({ ok: true, started: true, turn: 1 });
  startImpl: (m: RunnerMember) => Promise<RunnerStartResult> = async m => ({ sessionId: m.sessionId ?? `s-${m.id}`, paneId: `t-${m.id}-${this.starts}` });
  applyConfig?: Runner["applyConfig"];
  async available() { return { ok: true }; }
  async start(m: RunnerMember): Promise<RunnerStartResult> { this.starts++; return this.startImpl(m); }
  async send(m: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push(text);
    const result = await this.sendImpl(m, text);
    if (result.ok) this.busy.add(m.id);
    return result;
  }
  async compact(): Promise<SendResult> { return { ok: true, started: false }; }
  isBusy(id: string) { return this.busy.has(id); }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop() {}
  async screen() { return ""; }
  on(callback: (e: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
}

function fixture(timings: Partial<OrchestratorTimings> = {}) {
  const runtime = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: runtime.socketPath, IAMCEO_CORE_BIN: runtime.bins.coreBin, IAMCEO_CLAUDE_BIN: runtime.bins.claudeBin, IAMCEO_CODEX_BIN: runtime.bins.codexBin });
  const db = openDb(config.dbPath), store = new Store(db, new Bus());
  store.patchSettings({ boardTidyHours: 0 });
  const fake = new FakeCore();
  const project = store.createProject({ name: "리뷰", cwd: runtime.paths.work, runnerEnabled: true });
  let count = 0;
  const worker = (): Member => { count++; return store.createMember({ projectId: project.id, handle: `w${count}`, name: `직원${count}`, kind: "worker", origin: "runner", backend: "core", status: "idle", paneId: `pane${count}`, sessionId: `session${count}` }); };
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", fake]]), providerHomes: runtime.providerHomes,
    timings: { tickMs: 60_000, healthMs: 60_000, retryMs: 5, inputBusyRetryMs: 5, ...timings } });
  const say = (member: Member, text = "[대표] 안녕하세요") => store.enqueue({ projectId: project.id, memberId: member.id, kind: "user_message", text });
  const emit = async (e: RunnerEvent) => { fake.callback(e); await Bun.sleep(2); };
  cleanups.push(async () => { await orch.shutdown(); db.close(); await runtime.stop(); });
  const internals = orch as unknown as { settleInFlight(): Promise<void>; recoveryTimer: ReturnType<typeof setTimeout> | null };
  /** 걸려 있던 전달 확인 타이머를 치우고 확인을 한 번 돈 뒤, 다시 걸렸는지 본다. */
  const checkOnce = async () => {
    if (internals.recoveryTimer) clearTimeout(internals.recoveryTimer);
    internals.recoveryTimer = null;
    await internals.settleInFlight();
    return internals.recoveryTimer !== null;
  };
  return { db, store, fake, orch, project, worker, say, emit, checkOnce, armed: () => internals.recoveryTimer !== null };
}
const lost: SendResult = { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown", detail: "reply lost" };

describe("orchestrator-2: 이전 프로세스가 남긴 쓰기는 이 프로세스가 뜬 때부터 센다", () => {
  test("쓰기 시작만 적고 죽은 프로세스의 봉투는 적힌 시각이 오래돼도 곧바로 끝난 쓰기로 보지 않는다", async () => {
    const f = fixture({ writeSettleMs: 60_000 }), w = f.worker();
    f.fake.sendImpl = async () => lost;
    f.say(w);
    await f.orch.pump(w.id);
    const inherited = { ...f.store.inputState(w.id).unresolvedDispatches[0]!, updatedAt: new Date(Date.now() - 3_600_000).toISOString() };
    expect(f.orch.writerDone(inherited)).toBe(false);
    expect(f.orch.dispatchQuiescence(w.id, inherited)).toEqual({ originalWrite: "unresolved", externalInput: null });
    // 이 프로세스가 뜬 뒤로 writeSettleMs 가 지나면 끝난 쓰기다.
    const now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now + 60_001);
    try { expect(f.orch.writerDone(inherited)).toBe(true); } finally { clock.mockRestore(); }
  });
});

describe("orchestrator-3: 넘기지 못한 확인 시각 때문에 전달 확인이 끝없이 다시 돌지 않는다", () => {
  test("보관된 프로젝트에 남은 확인 중 전달은 타이머를 다시 걸지 않고, 꺼내면 다시 확인한다", async () => {
    const f = fixture(), w = f.worker();
    f.fake.sendImpl = async () => lost;
    const d = f.say(w);
    await f.orch.pump(w.id);
    expect(f.store.getDeliveryRecovery(d.id)?.phase).toBe("checking");
    // 방금 생긴 확인은 틱을 기다리지 않고 예약된다.
    expect(f.armed()).toBe(true);
    const due = new Date(Date.now() - 10_000).toISOString();
    f.db.query("UPDATE delivery_recovery SET next_check_at = ? WHERE delivery_id = ?").run(due, d.id);
    f.db.query("UPDATE projects SET archived = 1 WHERE id = ?").run(f.project.id);
    expect(await f.checkOnce()).toBe(false);
    expect(f.store.getDeliveryRecovery(d.id)).toMatchObject({ phase: "checking", nextCheckAt: due });
    f.db.query("UPDATE projects SET archived = 0 WHERE id = ?").run(f.project.id);
    await f.checkOnce();
    expect(f.store.getDeliveryRecovery(d.id)?.nextCheckAt).not.toBe(due);
  });
});

describe("orchestrator-4: 펌프가 시작한 설정 재적용의 실패는 한 번만 센다", () => {
  test("한 번 실패하면 실패 횟수는 1이고 다음 시도는 5분이 아니라 configRetryMs 뒤다", async () => {
    const f = fixture({ configRetryMs: 60_000 }), w = f.worker();
    f.fake.applyConfig = async () => ({ ok: true });
    f.store.setAppliedConfig(w.id, { model: "older-model", effort: null, staffModel: null, staffEffort: null });
    f.fake.startImpl = async () => { throw new CoreError("session_unknown", "resume unavailable"); };
    const d = f.say(w);
    await f.orch.pump(w.id);
    expect(f.store.requireMember(w.id).status).toBe("offline");
    expect(f.store.deferredMemberConfig(w.id)).toMatchObject({ failed: true, attempts: 1 });
    expect(f.store.requireDelivery(d.id).status).not.toBe("delivered");
    // 61초 뒤에는 다시 연다(두 번 세던 때에는 5분을 기다렸다).
    f.fake.startImpl = async m => ({ sessionId: m.sessionId ?? "s", paneId: "t-again" });
    const now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now + 61_000);
    try { await f.orch.pump(w.id); } finally { clock.mockRestore(); }
    expect(f.fake.starts).toBe(2);
    expect(f.store.requireDelivery(d.id).status).toBe("delivered");
  });
});

describe("runner-recovery-2: 상태 보고가 사라져 끝난 것으로 읽은 턴은 성공의 증거가 아니다", () => {
  test("추정으로 끝난 턴은 한도 보류를 풀지 않고, 실제로 마친 턴은 푼다", async () => {
    const f = fixture(), w = f.worker();
    f.orch.apiRecovery.usageFailure(f.store.requireMember(w.id), "You've hit your weekly limit · resets 3am");
    expect(f.orch.apiRecovery.holdReason(w.id)).toBe("usage_limit");
    const d = f.say(w);
    await f.emit({ type: "turn_end", memberId: w.id, finalText: "", isError: false, inferred: true });
    expect(f.orch.apiRecovery.holdReason(w.id)).toBe("usage_limit");
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "held", holdReason: "usage_limit" });
    expect(f.fake.sent).toHaveLength(0);
    await f.emit({ type: "turn_end", memberId: w.id, finalText: "", isError: false });
    expect(f.orch.apiRecovery.holdReason(w.id)).toBeNull();
  });

  test("추정으로 끝난 턴에 실린 연결 오류는 기존 장애 경로로 가서 대기열을 붙잡는다", async () => {
    const f = fixture(), w = f.worker();
    const d = f.say(w);
    await f.emit({ type: "turn_end", memberId: w.id, finalText: "", isError: true, errorText: "API Error: Connection error.", inferred: true });
    expect(f.orch.apiRecovery.holdReason(w.id)).toBe("api_outage");
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "held", holdReason: "api_outage" });
    expect(f.fake.sent).toHaveLength(0);
  });
});
