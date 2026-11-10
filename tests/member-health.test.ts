import { afterEach, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { CoreRunner, type CoreRunnerDeps } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import type { Runner, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const never = <T>(): Promise<T> => new Promise(() => {});
type Internals = {
  probeHealth(): Promise<void>;
  reportStuckPumps(): void;
  coreSupervisor: { observations(): Array<{ memberId: string }> };
  runtime(id: string): { pumping: Promise<void> | null; pumpStage: string | null; wantParallel: boolean | null; again: boolean; holdUntil: number };
  queueCoreCompact(member: ReturnType<Store["requireMember"]>, trigger: "manual", focus: string): void;
};

async function fixture(deps: Partial<CoreRunnerDeps> = {}, stageTimeoutMs = 150) {
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
  const runner = new CoreRunner(isolated.runnerOptions(isolated.providerHomes), { recoveryStore: store, pollMs: 60_000, rpcTimeoutMs: 30, sendTimeoutMs: 30, ...deps });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000, retryMs: 60_000, pumpStageTimeoutMs: stageTimeoutMs, stuckPumpMs: 60_000 } });
  const internal = orch as unknown as Internals;
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
    hang(fn: typeof hang) { hang = fn; } };
}

async function bounded(promise: Promise<void>, ms = 600) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("pump did not release")), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function otherMemberDelivers(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const delivery = f.enqueue(id); await bounded(f.orch.pump(id));
  expect(f.store.requireDelivery(delivery.id).status).toBe("delivered");
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
    expect(f.count("terminal.send", member.paneId!)).toBe(1);
    expect(f.store.requireDelivery(delivery.id).status).toBe("delivered");
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
  const f = await fixture({}, 35), member = await f.create(), other = await f.create("Other");
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
    const f = await fixture({}, 50), member = await f.create(), other = await f.create("Other");
    f.store.patchMember(member.id, { modelOverride: "claude-sonnet-4-5" });
    f.hang((m, p) => m === method && p.terminal === member.paneId);
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
    const f = await fixture({}, 35), member = await f.create(), other = await f.create("Other");
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
    if (operation === "compact") expect(f.store.getContextState(member.id)?.compaction?.phase).toBe("uncertain");
    const attempts = f.store.requireDelivery(d.id).attempts;
    for (let i = 0; i < 3; i++) await f.orch.pump(member.id);
    expect(f.store.requireDelivery(d.id).attempts).toBe(attempts);
    // Restore fake send so the second member can demonstrate independent delivery.
    if (operation === "send" || operation === "send_urgent") delete (f.runner as Partial<Runner>).send;
    await otherMemberDelivers(f, other.id);
  });
}

test("late preflight completion after cancellation cannot issue another RPC or send input", async () => {
  const f = await fixture({}, 35), member = await f.create();
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
  const f = await fixture({}, 35);
  const member = f.store.createMember({ projectId: f.project.id, name: "Late", handle: "late", kind: "worker" });
  f.store.patchMember(member.id, { backend: "core", status: "offline" });
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
