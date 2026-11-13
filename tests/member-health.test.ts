import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator, type OrchestratorTimings } from "../server/orchestrator.ts";
import { CoreRunner, type CoreRunnerDeps } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import type { Runner, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

// 시간 제한. 정상 경로(다른 팀장의 전달, 멈추기 전까지의 단계와 RPC)는 느린 CI 러너에서도 넉넉하게 둔다.
// 예전에는 모든 RPC 30ms·모든 단계 35~150ms 라, 러너가 느리면 멈추게 만든 곳에 닿기도 전에 정상 RPC·단계가 끊겼다
// (0.2.4 CI: 다른 팀장 전달이 "terminal.get: pump deadline expired before RPC" 로 보류, 이 Mac 에서도 taskpolicy -c background 로 매번 1~3개 실패).
// - 답하지 않는 RPC(f.hang)는 RPC 제한(RPC_MS)이 다 지나서 끝난다. 정상 RPC 는 로컬 소켓 왕복이라 그 안에 넉넉히 끝난다.
// - 끝나지 않는 실행기 동작·정리(never)와 자기 제한이 긴 RPC(terminal.kill 15초)는 단계 제한으로만 풀린다. 그 단계 하나만 f.stall(팀장, 단계)로
//   짧게(STALL_MS) 하고 나머지 단계는 STAGE_MS 다. STALL_MS 도 그 단계 안에서 멈추기 전의 정상 RPC 가 끝날 만큼은 둔다.
const RPC_MS = 1_000, STAGE_MS = 10_000, STALL_MS = 1_000;
setDefaultTimeout(30_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const never = <T>(): Promise<T> => new Promise(() => {});
type Internals = {
  probeHealth(): Promise<void>;
  reportStuckPumps(): void;
  coreSupervisor: { observations(): Array<{ memberId: string }> };
  runtime(id: string): { pumping: Promise<void> | null; pumpStage: string | null; wantParallel: boolean | null; again: boolean; holdUntil: number };
  queueCoreCompact(member: ReturnType<Store["requireMember"]>, trigger: "manual", focus: string): void;
  timings: OrchestratorTimings;
  pumpWait(memberId: string, stage: string, ...rest: unknown[]): Promise<unknown>;
};

async function fixture(deps: Partial<CoreRunnerDeps> = {}) {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath), store = new Store(db, new Bus());
  const project = store.createProject({ name: "Member health", cwd: isolated.paths.work });
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const terminals = new Map<string, CoreTerminal>();
  const sockets = new Set<Socket>();
  let hang: ((method: string, params: Record<string, any>) => boolean) | null = null;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const req = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        calls.push(req);
        if (hang?.(req.method, req.params)) continue; // Keep the connection open forever.
        const terminal = terminals.get(req.params.terminal);
        let result: unknown;
        switch (req.method) {
          case "hello": result = { generation: 1, version: "fake", methods: ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill"], features: [] }; break;
          case "terminal.list": result = { terminals: [...terminals.values()] }; break;
          case "terminal.run": {
            const t: CoreTerminal = { address: `t${terminals.size + 1}`, cwd: req.params.cwd, argv: req.params.argv, labels: req.params.labels, state: "live", status: { state: "idle" }, turn: 0 };
            terminals.set(t.address, t); result = t; break;
          }
          case "terminal.get": result = terminal; break;
          case "terminal.read": result = { text: `output\n${"─".repeat(30)}\n❯ \n${"─".repeat(30)}\n` }; break;
          case "terminal.send": result = { started: false, turn: terminal?.turn ?? 0 }; break;
          case "terminal.kill": if (terminal) { terminal.state = "finished"; result = terminal; } break;
        }
        socket.write(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: req.id, error: { message: "missing", data: { kind: "not_found" } } } : { jsonrpc: "2.0", id: req.id, result }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(isolated.socketPath, resolve));
  const runner = new CoreRunner(isolated.runnerOptions(isolated.providerHomes), { recoveryStore: store, pollMs: 60_000, rpcTimeoutMs: RPC_MS, sendTimeoutMs: RPC_MS, ...deps });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000, retryMs: 60_000, pumpStageTimeoutMs: STAGE_MS, stuckPumpMs: 60_000 } });
  const internal = orch as unknown as Internals;
  // 단계 제한은 pumpWait 가 시작할 때(첫 await 전) 한 번 읽는다. 고른 팀장의 고른 단계만 그 순간 짧은 제한을 보게 한다.
  const stalls = new Set<string>();
  const pumpWait = internal.pumpWait;
  internal.pumpWait = function (this: unknown, memberId: string, stage: string, ...rest: unknown[]) {
    if (!stalls.has(`${memberId} ${stage}`)) return pumpWait.call(this, memberId, stage, ...rest);
    const timings = internal.timings;
    internal.timings = { ...timings, pumpStageTimeoutMs: STALL_MS };
    try { return pumpWait.call(this, memberId, stage, ...rest); } finally { internal.timings = timings; }
  };
  cleanups.push(async () => {
    hang = null;
    await orch.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); await isolated.stop();
  });
  const create = (name = "Worker") => orch.createMember(project.id, { name });
  const enqueue = (id: string, urgent = false) => store.enqueue({ projectId: project.id, memberId: id, kind: "system", text: "Do this once", wake: true, urgent });
  const count = (method: string, id?: string) => calls.filter(c => c.method === method && (!id || c.params.terminal === id)).length;
  return { isolated, store, project, runner, orch, internal, calls, terminals, create, enqueue, count,
    hang(fn: typeof hang) { hang = fn; },
    /** 이 팀장의 이 단계(pumpWait 의 stage 이름)만 단계 제한을 STALL_MS 로. 끝나지 않는 동작이 단계 제한으로 풀리는 것을 볼 때 쓴다. */
    stall(memberId: string, stage: string) { stalls.add(`${memberId} ${stage}`); } };
}

/** 조건이 참이 될 때까지 기다린다. 끝내 거짓이면 그대로 돌아오고, 뒤의 단정이 실패를 알린다. */
async function until(condition: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await Bun.sleep(5);
}

/** 펌프가 풀리기를 기다리는 상한. 풀리는 데는 멈춘 RPC 의 RPC_MS 나 고른 단계의 STALL_MS 가 걸리고, 이 값은 실패를 알리는 상한일 뿐이다. */
async function bounded(promise: Promise<void>, ms = 15_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("pump did not release")), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** 실패했을 때 왜 안 나갔는지 보이게, 전달의 상태와 보류 사유·팀장 상태를 함께 단정한다(CI 에서 사유 없이 held 만 찍혔다). */
function deliveryState(f: Awaited<ReturnType<typeof fixture>>, deliveryId: string, memberId: string) {
  const d = f.store.requireDelivery(deliveryId), m = f.store.requireMember(memberId);
  return { status: d.status, holdReason: d.holdReason ?? null, attempts: d.attempts, member: m.status, blockedReason: m.blockedReason ?? null,
    lastError: m.lastError ?? null, stage: f.internal.runtime(memberId).pumpStage, observed: m.statusObservation?.error?.code ?? null };
}

async function otherMemberDelivers(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const delivery = f.enqueue(id); await bounded(f.orch.pump(id));
  expect(deliveryState(f, delivery.id, id)).toMatchObject({ status: "delivered" });
}

test("verified absent offline member leaves the watch list and wakes with exactly one new terminal", async () => {
  const f = await fixture();
  const member = f.store.createMember({ projectId: f.project.id, name: "Offline", handle: "offline", kind: "worker" });
  f.store.patchMember(member.id, { backend: "core", status: "offline", paneId: null });
  await f.internal.probeHealth();
  const reads = f.count("terminal.list");
  for (let i = 0; i < 4; i++) await f.internal.probeHealth();
  expect(f.store.requireMember(member.id).statusObservation?.error ?? null).toBeNull();
  expect(f.internal.coreSupervisor.observations().some(s => s.memberId === member.id)).toBe(false);
  expect(f.count("terminal.list")).toBe(reads);
  await f.orch.resumeMember(member.id);
  expect(f.count("terminal.run")).toBe(1);
  expect(f.store.requireMember(member.id).paneId).toBe("t1");
});

test("offline member without pane retains conflict warnings for multiple candidates", async () => {
  const f = await fixture(), member = await f.create();
  const t = f.terminals.get(member.paneId!)!;
  f.terminals.set("duplicate", { ...t, address: "duplicate" });
  f.store.patchMember(member.id, { status: "offline", paneId: null });
  await f.internal.probeHealth();
  expect(f.store.requireMember(member.id).statusObservation?.error?.code).toBe("multiple_terminals");
  expect(f.internal.coreSupervisor.observations().some(s => s.memberId === member.id)).toBe(true);
  expect(f.count("terminal.run")).toBe(1);
});

for (const [method, skip] of [["terminal.get", 0], ["terminal.read", 0], ["terminal.get", 1]] as const) {
  test(`send preflight ${method} (skip ${skip}) never replies: pump releases, no input, next tick retries`, async () => {
    const f = await fixture(), member = await f.create(), other = await f.create("Other");
    let seen = 0;
    f.hang((m, p) => m === method && p.terminal === member.paneId && seen++ >= skip);
    const delivery = f.enqueue(member.id);
    const blocked = f.orch.pump(member.id);
    await otherMemberDelivers(f, other.id);
    await bounded(blocked);
    expect(f.internal.runtime(member.id).pumping).toBeNull();
    expect(f.count("terminal.send", member.paneId!)).toBe(0);
    expect(f.store.getDeliveryRecovery(delivery.id)?.phase).not.toBe("unknown");
    f.hang(null);
    // Clear only the test's configured long retry due; production waits for its normal tick.
    f.store.patchDeliveryRetry(delivery.id, { nextAttemptAt: null });
    f.internal.runtime(member.id).holdUntil = 0;
    await f.internal.probeHealth();
    await bounded(f.orch.pump(member.id));
    expect(deliveryState(f, delivery.id, member.id)).toMatchObject({ status: "delivered" });
    expect(f.count("terminal.send", member.paneId!)).toBe(1);
  });
}

test("send write never replies: unknown delivery is fenced and repeated ticks never resend", async () => {
  const f = await fixture(), member = await f.create(), other = await f.create("Other");
  f.hang((m, p) => m === "terminal.send" && p.terminal === member.paneId);
  const d = f.enqueue(member.id), blocked = f.orch.pump(member.id);
  await otherMemberDelivers(f, other.id); await bounded(blocked);
  expect(f.store.inputState(member.id).unresolvedDispatches).toHaveLength(1);
  for (let i = 0; i < 4; i++) await f.orch.pump(member.id);
  expect(f.count("terminal.send", member.paneId!)).toBe(1);
  expect(f.store.requireDelivery(d.id).attempts).toBe(1);
});

test("post-send observation never replies: acknowledged send remains delivered without replay", async () => {
  const f = await fixture(), member = await f.create();
  let gets = 0;
  f.hang((m, p) => m === "terminal.get" && p.terminal === member.paneId && ++gets >= 3);
  const d = f.enqueue(member.id); await bounded(f.orch.pump(member.id));
  expect(f.store.requireDelivery(d.id).status).toBe("delivered");
  await f.orch.pump(member.id);
  expect(f.count("terminal.send", member.paneId!)).toBe(1);
});

for (const method of ["hello", "terminal.list", "terminal.run"] as const) {
  test(`reopen ${method} never replies: starting guard releases and creation is not duplicated`, async () => {
    const f = await fixture(), other = await f.create("Other");
    const member = f.store.createMember({ projectId: f.project.id, name: "Offline", handle: "offline", kind: "worker" });
    f.store.patchMember(member.id, { backend: "core", status: "offline" });
    // hello/list are shared discovery RPCs: let the already bound other member send first.
    await otherMemberDelivers(f, other.id);
    f.hang(m => m === method);
    f.enqueue(member.id); await bounded(f.orch.pump(member.id));
    expect(f.internal.runtime(member.id).pumping).toBeNull();
    expect(f.count("terminal.send")).toBe(1);
    f.hang(null);
    await bounded(f.orch.pump(member.id));
    if (method === "terminal.run") {
      expect(f.store.listPendingLifecycleJournals().some(j => j.memberId === member.id && j.phase === "unknown")).toBe(true);
      expect(f.count("terminal.run")).toBe(2); // Other + the single ambiguous creation.
    } else {
      expect(f.store.requireMember(member.id).paneId).not.toBeNull();
      expect(f.count("terminal.run")).toBe(2);
    }
  });
}

test("lease cleanup never settles: no input is admitted, other employee delivers, later tick retries cleanup", async () => {
  const f = await fixture(), member = await f.create(), other = await f.create("Other");
  f.stall(member.id, "lease_cleanup");
  const remove = f.orch.onTerminalLeaseEnded(id => id === member.id ? never<void>() : Promise.resolve());
  f.enqueue(member.id); const blocked = f.orch.pump(member.id);
  await otherMemberDelivers(f, other.id); await bounded(blocked);
  expect(f.count("terminal.send", member.paneId!)).toBe(0);
  expect(f.store.listActivity(member.id).some(a => a.text.includes("lease_cleanup"))).toBe(true);
  remove(); await bounded(f.orch.pump(member.id));
  expect(f.count("terminal.send", member.paneId!)).toBe(1);
});

test("context file promise never settles: shared refresh releases and late completion cannot emit stale usage", async () => {
  let finish!: (value: any) => void;
  let reads = 0;
  const f = await fixture({ contextTimeoutMs: 20, readContext: () => { reads++; return new Promise(resolve => { finish = resolve; }); } });
  const member = await f.create(), other = await f.create("Other");
  const events: string[] = []; f.runner.on(e => { if (e.memberId === member.id) events.push(e.type); });
  f.terminals.get(member.paneId!)!.turn = 1;
  f.terminals.get(member.paneId!)!.status = { state: "done" };
  f.enqueue(member.id); const blocked = f.orch.pump(member.id);
  await otherMemberDelivers(f, other.id); await bounded(blocked);
  expect(reads).toBe(1); expect(f.internal.runtime(member.id).pumping).toBeNull();
  expect(f.count("terminal.send", member.paneId!)).toBe(1);
  finish({ tokens: 10, shownPct: null, model: null }); await Bun.sleep(5);
  expect(events).not.toContain("context_usage");
});

for (const method of ["terminal.get", "terminal.read", "terminal.kill"] as const) {
  test(`sync_config ${method} never replies: no lifecycle continuation or work input after timeout`, async () => {
    const f = await fixture(), member = await f.create(), other = await f.create("Other");
    f.store.patchMember(member.id, { modelOverride: "claude-sonnet-4-5" });
    f.hang((m, p) => m === method && p.terminal === member.paneId);
    // get·read 는 RPC 제한으로 끝난다. kill 은 15초 제한으로 불러 단계의 남은 시간에 잘리므로 그 단계만 짧게 둔다.
    if (method === "terminal.kill") f.stall(member.id, "sync_config.stop");
    f.enqueue(member.id); const blocked = f.orch.pump(member.id);
    await otherMemberDelivers(f, other.id); await bounded(blocked);
    expect(f.internal.runtime(member.id).pumping).toBeNull();
    expect(f.count("terminal.send", member.paneId!)).toBe(0);
    expect(f.count("terminal.run")).toBe(2);
    f.hang(null);
    if (method === "terminal.kill") {
      for (let i = 0; i < 3; i++) await f.orch.pump(member.id);
      expect(f.count("terminal.kill", member.paneId!)).toBe(1);
      expect(f.store.listPendingLifecycleJournals().some(j => j.memberId === member.id && j.phase === "unknown")).toBe(true);
      expect(f.store.listActivity(member.id).some(a => a.text.includes("sync_config.stop:terminal.kill"))).toBe(true);
    }
  });
}

for (const operation of ["send", "send_urgent", "parallel", "compact", "start_session"] as const) {
  test(`runner ${operation} never settles: pump releases and side effects are fenced`, async () => {
    const f = await fixture(), member = await f.create(), other = await f.create("Other");
    f.stall(member.id, operation);
    if (operation === "send" || operation === "send_urgent") f.runner.send = () => never<SendResult>();
    // core 는 일하는 턴에 끼워 넣지 못해 긴급을 시도하지 않는다(delivery-1). 끼워 넣는 실행기의 긴급 경로가 멈춰도 펌프가 풀리는지는 계속 본다.
    if (operation === "send_urgent") { f.store.patchMember(member.id, { status: "working" }); f.runner.isBusy = id => id === member.id; (f.runner as { interjects: boolean }).interjects = true; }
    if (operation === "parallel") { f.internal.runtime(member.id).wantParallel = true; f.runner.setParallel = () => never<SendResult>(); }
    if (operation === "compact") { f.internal.queueCoreCompact(member, "manual", "focus"); f.runner.compact = () => never<SendResult>(); }
    if (operation === "start_session") {
      f.store.patchMember(member.id, { sessionId: null, paneId: null, statusObservation: null });
      f.runner.start = () => never<Awaited<ReturnType<CoreRunner["start"]>>>();
    }
    const d = f.enqueue(member.id, operation === "send_urgent");
    await bounded(f.orch.pump(member.id));
    expect(f.internal.runtime(member.id).pumping).toBeNull();
    expect(f.store.listActivity(member.id).some(a => a.text.includes(operation))).toBe(true);
    if (operation === "send" || operation === "send_urgent") expect(f.store.inputState(member.id).unresolvedDispatches).toHaveLength(1);
    if (operation === "parallel") {
      expect(f.store.requireMember(member.id).lastError).toStartWith("control_unknown:");
      f.store.patchMember(member.id, { lastError: null });
      await f.internal.probeHealth();
      expect(f.store.deferredMemberConfig(member.id)?.signature).toStartWith("parallel_unknown:");
    }
    // 압축: 실행기가 기준선(받을 터미널)을 저장하기 전에 단계 제한이 걸렸다. 넣은 적이 없으므로 '불확실'이 아니라 다시 예약으로 남는다.
    // (예전에는 uncertain 으로 적어, 묶인 터미널이 없는 미확정 압축이 어떤 조작으로도 풀리지 않았다.) 다시 시도하는 동안에도 뒤따르는 전달은 넣지 않는다.
    if (operation === "compact") {
      expect(f.store.getContextState(member.id)?.compaction).toMatchObject({ phase: "queued", reason: "backend_down" });
      expect(f.store.getContextState(member.id)?.baseline?.coreCompact ?? null).toBeNull();
    }
    const attempts = f.store.requireDelivery(d.id).attempts;
    for (let i = 0; i < 3; i++) await bounded(f.orch.pump(member.id));
    expect(f.store.requireDelivery(d.id).attempts).toBe(attempts);
    if (operation === "parallel") {
      // 병렬 설정 명령을 받은 터미널이 살아 있는 동안은 결과 모름 보류가 그대로다(위의 세 번은 아무것도 넣지 않았다).
      // 그 터미널이 끝난 것이 확인되면 보류는 묶일 곳이 없다: 꺼짐으로 돌리며 지우고, 깨우면 새 터미널에서 전달이 나간다.
      expect(f.store.deferredMemberConfig(member.id)?.signature).toStartWith("parallel_unknown:");
      f.terminals.get(member.paneId!)!.state = "finished";
      const observer = f.runner as unknown as { tracks: Map<string, unknown>; refresh(track: unknown): Promise<unknown> };
      await observer.refresh(observer.tracks.get(member.id)); // 실행기가 종료를 관측해 알린다(주기 관측을 기다리지 않는다).
      await until(() => f.store.requireMember(member.id).status === "offline");
      expect(f.store.requireMember(member.id).status).toBe("offline");
      expect(f.store.deferredMemberConfig(member.id)).toBeNull();
      expect(f.store.requireMember(member.id).lastError ?? "").not.toContain("control_unknown");
      delete (f.runner as Partial<Runner>).setParallel;
      await f.orch.resumeMember(member.id);
      await bounded(f.orch.pump(member.id));
      expect(deliveryState(f, d.id, member.id)).toMatchObject({ status: "delivered" });
    }
    // Restore fake send so the second member can demonstrate independent delivery.
    if (operation === "send" || operation === "send_urgent") delete (f.runner as Partial<Runner>).send;
    await otherMemberDelivers(f, other.id);
  });
}

test("late preflight completion after cancellation cannot issue another RPC or send input", async () => {
  const f = await fixture(), member = await f.create();
  f.stall(member.id, "send");
  let finish!: (terminal: CoreTerminal) => void;
  const runner = f.runner as unknown as { refresh(track: unknown): Promise<CoreTerminal> };
  const original = runner.refresh;
  runner.refresh = () => new Promise(resolve => { finish = resolve; });
  f.enqueue(member.id); await bounded(f.orch.pump(member.id));
  const before = f.calls.length;
  finish(f.terminals.get(member.paneId!)!); await Bun.sleep(10);
  expect(f.count("terminal.send", member.paneId!)).toBe(0);
  expect(f.calls.length).toBe(before);
  runner.refresh = original;
  expect(f.store.inputState(member.id).unresolvedDispatches).toHaveLength(1);
});

test("late session creation result after timeout cannot apply identity or send the queued job", async () => {
  const f = await fixture();
  const member = f.store.createMember({ projectId: f.project.id, name: "Late", handle: "late", kind: "worker" });
  f.store.patchMember(member.id, { backend: "core", status: "offline" });
  f.stall(member.id, "reopen");
  let finish!: (result: Awaited<ReturnType<CoreRunner["start"]>>) => void;
  f.runner.start = () => new Promise(resolve => { finish = resolve; });
  f.enqueue(member.id); await bounded(f.orch.pump(member.id));
  finish({ paneId: "late-holder", sessionId: "late-session" }); await Bun.sleep(10);
  expect(f.store.requireMember(member.id).paneId).toBeNull();
  expect(f.store.listPendingLifecycleJournals().some(j => j.memberId === member.id && j.phase === "unknown")).toBe(true);
  expect(f.count("terminal.send")).toBe(0);
});

test("blocked approval still prohibits work input", async () => {
  const f = await fixture(), member = await f.create();
  f.store.patchMember(member.id, { status: "blocked" });
  const d = f.enqueue(member.id); await f.orch.pump(member.id);
  expect(f.count("terminal.send", member.paneId!)).toBe(0);
  expect(f.store.requireDelivery(d.id).holdReason).toBe("blocked");
});

test("a wake delivery starts a verified absent offline member and delivers once", async () => {
  const f = await fixture();
  const member = f.store.createMember({ projectId: f.project.id, name: "Queue wake", handle: "queue-wake", kind: "worker" });
  f.store.patchMember(member.id, { status: "offline", backend: "core" });
  await f.internal.probeHealth();
  const d = f.enqueue(member.id); await bounded(f.orch.pump(member.id));
  expect(f.count("terminal.run")).toBe(1);
  expect(f.count("terminal.send")).toBe(1);
  expect(f.store.requireDelivery(d.id).status).toBe("delivered");
});

test("background polls do not inherit a completed pump's cancellation scope or stage reporter", async () => {
  const f = await fixture(), member = await f.create();
  const d = f.enqueue(member.id); await bounded(f.orch.pump(member.id));
  expect(f.store.requireDelivery(d.id).status).toBe("delivered");
  expect(f.internal.runtime(member.id).pumpStage).toBeNull();
  await Bun.sleep(280);
  expect(f.internal.runtime(member.id).pumpStage).toBeNull();
});

for (const keepPane of [true, false]) {
  test(`offline ownership conflict is not mistaken for absence (pane retained: ${keepPane})`, async () => {
    const f = await fixture(), member = await f.create();
    const terminal = f.terminals.get(member.paneId!)!;
    terminal.labels = { ...terminal.labels, "iamceo.project": "another-project" };
    delete terminal.labels["iamceo.session"];
    f.store.patchMember(member.id, { status: "offline", paneId: keepPane ? member.paneId : null });
    await f.internal.probeHealth();
    expect(f.store.requireMember(member.id).statusObservation?.ownership).toBe("conflict");
    expect(f.internal.coreSupervisor.observations().some(s => s.memberId === member.id)).toBe(true);
    expect(f.count("terminal.run")).toBe(1);
  });
}
