// 11-16 D4-5: 총괄 타이머(onTick)가 CPU 로 최대 8.7초 이벤트 루프를 막았다.
// 원인: 수신 확인(DeliveryRecovery.checkMember)이 그 팀장의 봉투 이력을 하나씩 도는 동안 봉투마다 inputState 를 다시 읽었고,
// inputState 는 봉투 이력 전체(본문·기준선 JSON 포함)를 다시 읽어 걸렀다. 이력 크기의 제곱이다. 11-14 23:36 백업 사본(바쁜 총괄 봉투 555개)에서
// 수신 확인 한 건이 7.9초를 동기로 막았다(고친 뒤 53ms). 여기서는 시간 대신 '이력 전체 읽기' 횟수가 이력 크기와 상관없는지를 본다.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { DeliveryRecovery } from "../server/delivery-recovery.ts";
import { Store } from "../server/store.ts";
import type { DeliveryInspection, DeliveryProbe, RunnerMember } from "../server/runner/types.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function setup(history: number) {
  const db = openDb(":memory:");
  cleanup.push(() => db.close());
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "이력 시험", cwd: "/private/tmp/iamceo-fake-work" });
  const member = store.createMember({ projectId: project.id, handle: "pay", name: "결제 연동", kind: "worker", backend: "core", paneId: "terminal-pay", sessionId: "session-pay" });
  let time = Date.parse("2026-11-14T05:00:00.000Z");
  const inspected: string[] = [];
  let receivedIds: string[] = [];
  const observation = (query: DeliveryProbe): DeliveryInspection => ({
    finding: receivedIds.length ? "received" : "unknown", receivedDeliveryIds: receivedIds.filter(id => query.markers.some(m => m.deliveryId === id)), quiescence: "settled",
    evidence: [{ source: "claude_log", verdict: receivedIds.length ? "present" : "unknown", location: receivedIds.length ? "received_input" : "none", code: "fixture", complete: true, checkedAt: new Date(time).toISOString() }],
    snapshot: { identity: query.identity, observedAt: new Date(time).toISOString(), turn: 1, inputEpoch: 1, ownership: "verified", status: "idle", blockedReason: null, leaseActive: false, mutation: "none", composer: "empty", originalWrite: "settled", externalInput: false },
  });
  const runner = {
    terminalGone: async () => false,
    inspectGoneDelivery: (_member: RunnerMember, query: DeliveryProbe) => observation(query),
    inspectDelivery: async (_member: RunnerMember, query: DeliveryProbe) => { inspected.push(query.dispatchId); return observation(query); },
  };
  const service = new DeliveryRecovery({ store, runner: () => runner, now: () => time });
  const identity = () => ({ terminalId: "terminal-pay", sessionId: "session-pay", sessionGeneration: store.memberRevisions(member.id).sessionGeneration, process: null });
  const baseline = () => ({ serverEpoch: "test-epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date(time).toISOString() });
  // 전달되어 끝난 지난 봉투들(실제 총괄의 이력처럼 본문이 있다).
  for (let i = 0; i < history; i++) {
    const d = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: `지난 지시 ${i} `.repeat(40) });
    const dispatch = service.prepareDispatch([d.id], identity(), baseline());
    service.recordResult(dispatch.dispatchId, { ok: true, started: true, receipt: { dispatchId: dispatch.dispatchId, receivedAt: new Date(time).toISOString(), source: "transport" } });
    time += 1000;
  }
  // 지금 수신을 확인해야 하는 전달 하나(보낸 결과를 모른다).
  const pending = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: "새 지시" });
  const dispatch = service.prepareDispatch([pending.id], identity(), baseline());
  service.recordResult(dispatch.dispatchId, { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" });
  return { store, service, member, pending, dispatch, inspected, received(ids: string[]) { receivedIds = ids; } };
}

describe("수신 확인의 비용은 봉투 이력 크기에 따라 늘지 않는다 (D4-5)", () => {
  test.each([20, 200])("봉투 이력 %i개: 확인 한 번에 이력 전체 읽기는 몇 번뿐이고 판정은 그대로다", async (history) => {
    const f = setup(history);
    expect(f.store.listDispatches(f.member.id)).toHaveLength(history + 1);
    const lists = spyOn(f.store, "listDispatches");
    const inputs = spyOn(f.store, "inputState");
    f.received([f.pending.id]);
    await f.service.tick();
    // 판정은 예전과 같다: 세션 기록에 받은 표지가 있으면 전달됨.
    expect(f.store.requireDelivery(f.pending.id).status).toBe("delivered");
    expect(f.inspected).toEqual([f.dispatch.dispatchId]);
    // 예전: 이력의 봉투마다 inputState(=이력 전체 읽기)를 불러 history 번 넘게 읽었다.
    expect(inputs.mock.calls.length).toBeLessThanOrEqual(4);
    expect(lists.mock.calls.length).toBeLessThanOrEqual(4);
  });

  test("풀리지 않은 봉투(inputState)와 전달의 마지막 봉투(latestDispatchFor)는 이력을 걸러 얻던 값과 같다", () => {
    const f = setup(30);
    const all = f.store.listDispatches(f.member.id);
    const legacyUnresolved = all.filter((d) => ["prepared", "write_started", "unknown"].includes(d.transportState) || d.items.some((item) => {
      const recovery = f.store.getDeliveryRecovery(item.deliveryId);
      return recovery !== null && !(recovery.phase === "waiting" && recovery.reason === "input_busy" || recovery.phase === "needs_owner" && recovery.reason === "stale_instruction") && !["none", "resolved", "stopped"].includes(recovery.phase);
    }));
    expect(f.store.inputState(f.member.id).unresolvedDispatches).toEqual(legacyUnresolved);
    expect(legacyUnresolved.map(d => d.dispatchId)).toEqual([f.dispatch.dispatchId]);
    for (const d of all.flatMap(x => x.items.map(item => f.store.requireDelivery(item.deliveryId)))) {
      expect(f.store.latestDispatchFor(d.memberId, d.id)).toEqual(all.filter(x => x.items.some(item => item.deliveryId === d.id)).at(-1) ?? null);
    }
    // 다른 팀장의 봉투로는 찾지 않는다.
    expect(f.store.latestDispatchFor("m_other", f.pending.id)).toBeNull();
  });
});

describe("틱 단계별 계측 (D4-5)", () => {
  test("지연 감시를 넘기면 틱의 단계를 'tick:<단계>' 로 따로 잰다. 이름에 팀장 ID 는 없다", async () => {
    const { mkdtempSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadConfig, updateConfigFile } = await import("../server/config.ts");
    const { Orchestrator } = await import("../server/orchestrator.ts");
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-tick-")));
    const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
    updateConfigFile({ accessCode: "code" }, env);
    const config = { ...loadConfig(env), hosts: ["127.0.0.1"] };
    const db = openDb(config.dbPath);
    cleanup.push(() => db.close());
    const store = new Store(db, new Bus());
    const project = store.createProject({ name: "틱 시험", cwd: home });
    store.createMember({ projectId: project.id, handle: "pay", name: "결제 연동", kind: "worker", backend: "core" });
    const orch = new Orchestrator({ config, store, runners: new Map(), notifier: () => {} });
    const names: string[] = [];
    orch.measureTickSteps((name, work) => { names.push(name); return work(); });
    (Reflect.get(orch, "onTick") as () => void).call(orch);
    await orch.shutdown();
    expect(names).toEqual(expect.arrayContaining(["tick:api_recovery", "tick:delayed_notice", "tick:stalls", "tick:members", "tick:compact", "tick:in_flight", "tick:config", "tick:pump", "tick:board"]));
    expect(names.every(name => /^tick:[a-z_]+$/.test(name))).toBe(true);
  });
});
