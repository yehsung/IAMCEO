import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CoreRunner, screenTurnError, type CoreRunnerDeps } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import type { DeliveryDispatch, RunnerRecoveryStore, TerminalLease } from "../server/service-contracts.ts";
import type { RunnerEvent, RunnerMember, StartOpts } from "../server/runner/types.ts";

const methods = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill", "terminal.keys"];
const composer = (draft = "") => `prior output\n${"─".repeat(30)}\n❯ ${draft}\n${"─".repeat(30)}\n`;
const member = (extra: Partial<RunnerMember> = {}): RunnerMember => ({ id: "member-one", sessionGeneration: 1, projectId: "project-one", cli: "claude", handle: "worker", name: "Worker", cwd: "/tmp", sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker", ...extra });
interface Request { jsonrpc: string; id: string; method: string; params: Record<string, any> }
const fixtures: { dir: string; server: Server; sockets: Set<Socket>; runners: CoreRunner[] }[] = [];
/** tests/core-runner.test.ts 와 같은 모양의 가짜 core. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-stab-core-"));
  const socketPath = join(dir, "c.sock");
  const opts: StartOpts = { systemPromptFile: join(dir, "rules.md"), mcpConfigFile: join(dir, "mcp.json"), resume: false };
  writeFileSync(opts.systemPromptFile, "IAMCEO test instructions");
  writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: {} }));
  const calls: Request[] = [];
  const terminals = new Map<string, CoreTerminal>();
  let screen = composer();
  let hook: ((request: Request, socket: Socket) => boolean) | null = null;
  const sockets = new Set<Socket>();
  const reply = (socket: Socket, request: Request, result: unknown) => socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n"); const request = JSON.parse(buffer.slice(0, newline)) as Request; buffer = buffer.slice(newline + 1); calls.push(request);
        if (hook?.(request, socket)) continue;
        let result: unknown;
        const params = request.params;
        if (request.method === "hello") result = { generation: 1, version: "test", methods, features: [] };
        else if (request.method === "terminal.list") result = { terminals: [...terminals.values()] };
        else if (request.method === "terminal.run") {
          const terminal: CoreTerminal = { address: `t${terminals.size + 1}`, argv: params.argv, cwd: params.cwd, labels: params.labels, state: "live", cols: 160, rows: 50, turn: 0, status: { state: "idle", app: "claude-code" }, reported: true };
          terminals.set(terminal.address, terminal); result = terminal;
        } else if (request.method === "terminal.get") result = terminals.get(params.terminal);
        else if (request.method === "terminal.read") result = { text: screen, complete: true, how: "screen" };
        else if (request.method === "terminal.send") { const terminal = terminals.get(params.terminal)!; result = { turn: terminal.turn, started: true }; terminal.status = { state: "working" }; }
        else if (request.method === "terminal.keys") result = { status: "idle", turn: 0 };
        else if (request.method === "terminal.interrupt") result = { outcome: "stopped", key: "esc" };
        else if (request.method === "terminal.kill") { const terminal = terminals.get(params.terminal)!; terminal.state = "finished"; result = terminal; }
        if (result === undefined) socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "no terminal", data: { kind: "not_found" } } }) + "\n");
        else reply(socket, request, result);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const runners: CoreRunner[] = [];
  fixtures.push({ dir, server, sockets, runners });
  return { dir, opts, terminals, calls, reply, setScreen(value: string) { screen = value; }, setHook(value: typeof hook) { hook = value; },
    runner(deps: CoreRunnerDeps = {}) { const runner = new CoreRunner({ socketPath, claudeBin: "/fake/claude", codexBin: "/fake/codex", claudeHome: join(dir, "claude-home"), codexHome: join(dir, "codex-home"), contextHome: dir }, { pollMs: 10_000, rpcTimeoutMs: 100, sendTimeoutMs: 150, ...deps }); runners.push(runner); return runner; } };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await Promise.all(f.runners.map((runner) => runner.shutdown())); for (const socket of f.sockets) socket.destroy(); await new Promise<void>((resolve) => f.server.close(() => resolve())); rmSync(f.dir, { recursive: true, force: true }); } });
const until = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5); expect(predicate()).toBe(true); };

function recoveryStore() {
  let lease: TerminalLease | null = null;
  let dispatches: DeliveryDispatch[] = [];
  const port: RunnerRecoveryStore = { inputState: () => ({ lease, unresolvedDispatches: dispatches }), saveLease(value) { lease = structuredClone(value); }, removeLease(_memberId, claimId) { if (lease?.claimId === claimId) lease = null; } };
  return { port, dispatches(value: DeliveryDispatch[]) { dispatches = value; } };
}
function envelope(runner: CoreRunner, name: string, transportState: DeliveryDispatch["transportState"] = "write_started"): DeliveryDispatch {
  const marker = "#iamceo_" + name.padEnd(22, "A"), bundleMarker = "#iamceo_b_" + name.padEnd(22, "B"), wireText = `task ${name}\n${marker}\n${bundleMarker}`;
  return { dispatchId: `dispatch-${name}`, memberId: member().id, projectId: member().projectId, cli: "claude", backend: "core", markers: [{ deliveryId: `delivery-${name}`, marker }], bundleMarker,
    identity: runner.observationState(member().id)!.identity, baseline: { serverEpoch: "test-epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date(0).toISOString() }, wireText,
    wireSha256: createHash("sha256").update(wireText).digest("hex"), items: [{ deliveryId: `delivery-${name}`, ordinal: 0, sourceRevision: null }], transportState, submitAttempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
const sends = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(c => c.method === "terminal.send");

describe("불확실 펜스는 저장소가 봉투를 해결하면 풀린다", () => {
  test("응답을 잃은 전달: 미해결인 동안은 막고, 해결되면 풀려 다음 전달이 나가며 다시 밀라고 알린다", async () => {
    let now = 1_000_000;
    const f = await fixture(), recovery = recoveryStore(), runner = f.runner({ recoveryStore: recovery.port, pollNow: () => now }), events: RunnerEvent[] = []; runner.on(e => events.push(e));
    await runner.start(member(), f.opts);
    const first = envelope(runner, "first"); recovery.dispatches([first]);
    f.setHook(request => request.method === "terminal.send");
    expect(await runner.send(member(), first.wireText, { ...f.opts, marker: first.bundleMarker })).toMatchObject({ ok: false, deliveryEffect: "unknown" });
    f.setHook(null); first.transportState = "unknown";
    await runner.screen(member());
    expect(runner.isBusy(member().id)).toBe(true);
    const next = envelope(runner, "next");
    expect(await runner.send(member(), next.wireText, { ...f.opts, marker: next.bundleMarker })).toMatchObject({ ok: false, reason: "busy", retryable: false, deliveryEffect: "not_written" });
    expect(sends(f)).toHaveLength(1);
    expect(events.some(e => e.type === "input_ready")).toBe(false);
    // 전달 복구가 수신을 확인해 저장소에 미해결 봉투가 남지 않았다. 다음 폴링이 알아챈다.
    recovery.dispatches([]);
    now += 2000; await runner.screen(member());
    expect(runner.isBusy(member().id)).toBe(false);
    expect(events.filter(e => e.type === "input_ready")).toHaveLength(1);
    recovery.dispatches([next]);
    expect(await runner.send(member(), next.wireText, { ...f.opts, marker: next.bundleMarker })).toMatchObject({ ok: true });
    expect(sends(f)).toHaveLength(2);
  });
  test("재시작 때 미해결 봉투로 켜진 펜스도 저장소가 비면 풀린다", async () => {
    const f = await fixture(), recovery = recoveryStore(), first = f.runner({ recoveryStore: recovery.port }), started = await first.start(member(), f.opts);
    const stale = envelope(first, "stale", "unknown"); recovery.dispatches([stale]); await first.shutdown();
    const runner = f.runner({ recoveryStore: recovery.port }); await runner.start(member({ paneId: started.paneId, sessionId: started.sessionId }), f.opts);
    expect(runner.isBusy(member().id)).toBe(true);
    expect(await runner.send(member(), "blocked", f.opts)).toMatchObject({ ok: false, reason: "busy", retryable: false });
    recovery.dispatches([]);
    expect(await runner.send(member(), "delivered", f.opts)).toMatchObject({ ok: true });
    expect(sends(f)).toHaveLength(1);
  });
  test("거부로 끝난 봉투만 남으면 풀린다. 폴링은 저장소를 띄엄띄엄 다시 읽는다", async () => {
    let now = 1_000_000, reads = 0;
    const f = await fixture(), recovery = recoveryStore(), first = f.runner({ recoveryStore: recovery.port }), started = await first.start(member(), f.opts);
    const stale = envelope(first, "stale", "unknown"); recovery.dispatches([stale]); await first.shutdown();
    const counted: RunnerRecoveryStore = { ...recovery.port, inputState: id => { reads++; return recovery.port.inputState(id); } };
    const runner = f.runner({ recoveryStore: counted, pollNow: () => now }); await runner.start(member({ paneId: started.paneId, sessionId: started.sessionId }), f.opts);
    reads = 0;
    for (let i = 0; i < 60; i++) { await runner.screen(member()); now += 1000; } // 대표 확인을 기다리며 1분 동안 폴링
    expect(reads).toBeGreaterThan(5); expect(reads).toBeLessThan(20); expect(runner.isBusy(member().id)).toBe(true);
    stale.transportState = "rejected"; now += 5000; await runner.screen(member());
    expect(runner.isBusy(member().id)).toBe(false);
  });
  test("지금 쓰려는 봉투 자신은 이전의 미해결 쓰기가 아니다", async () => {
    const f = await fixture(), recovery = recoveryStore(), first = f.runner({ recoveryStore: recovery.port }), started = await first.start(member(), f.opts);
    const current = envelope(first, "current"); recovery.dispatches([current]); await first.shutdown();
    // 서버가 봉투를 write_started 로 적은 뒤 처음 묶이는 터미널: 예전에는 자기 봉투 때문에 스스로를 막았다.
    const runner = f.runner({ recoveryStore: recovery.port });
    expect(await runner.send(member({ paneId: started.paneId, sessionId: started.sessionId }), current.wireText, { ...f.opts, marker: current.bundleMarker })).toMatchObject({ ok: true });
    expect(sends(f)).toHaveLength(1);
  });
  test("봉투 없는 입력에서 온 불확실 표시는 저장소가 비어 있어도 풀지 않는다", async () => {
    const f = await fixture(), recovery = recoveryStore(), runner = f.runner({ recoveryStore: recovery.port }), events: RunnerEvent[] = []; runner.on(e => events.push(e));
    await runner.start(member(), f.opts);
    f.setHook(request => request.method === "terminal.send");
    expect(await runner.send(member(), "/effort ultracode on", f.opts)).toMatchObject({ ok: false, deliveryEffect: "unknown" });
    f.setHook(null);
    await runner.screen(member()); await runner.screen(member());
    expect(runner.isBusy(member().id)).toBe(true);
    expect(await runner.send(member(), "must not replay", f.opts)).toMatchObject({ ok: false, reason: "busy", retryable: false });
    expect(sends(f)).toHaveLength(1); expect(events.some(e => e.type === "input_ready")).toBe(false);
  });
});

describe("턴이 끝난 뒤 상태 보고가 사라진 CLI", () => {
  async function ended() {
    const f = await fixture(), runner = f.runner(), events: RunnerEvent[] = []; runner.on(e => events.push(e));
    const started = await runner.start(member(), f.opts), terminal = f.terminals.get(started.paneId)!;
    expect(await runner.send(member(), "first", f.opts)).toMatchObject({ ok: true });
    terminal.turn = 1; terminal.status = { state: "error", msg: "API Error: The response stopped arriving" };
    await runner.screen(member());
    expect(events.filter(e => e.type === "turn_end")).toMatchObject([{ isError: true, errorText: "API Error: The response stopped arriving" }]);
    return { f, runner, events, terminal };
  }
  test("입력칸이 보이면 끝난 턴으로 읽어 막지 않고, 다음 글을 받는다", async () => {
    const { f, runner, events, terminal } = await ended();
    terminal.status = null; // CLI 가 보고를 지웠다. 입력이 오기 전에는 다시 보고하지 않는다.
    await runner.screen(member());
    expect(events.some(e => e.type === "status" && e.status === "blocked")).toBe(false);
    expect(runner.isBusy(member().id)).toBe(false);
    expect(await runner.send(member(), "이어서 진행", f.opts)).toMatchObject({ ok: true });
    const sent = sends(f).at(-1)!.params; expect(sent.force).toBe(false); expect(sent.if).toBeUndefined();
    terminal.turn = 2; terminal.status = { state: "idle" }; await runner.screen(member());
    expect(events.filter(e => e.type === "turn_end")).toHaveLength(2);
  });
  test("쉬던 CLI의 보고가 사라지면 막힘이 아니라 쉬는 중으로 알린다", async () => {
    const { runner, events, terminal } = await ended();
    terminal.status = { state: "blocked", kind: "permission" }; await runner.screen(member());
    expect(events.findLast(e => e.type === "status")).toMatchObject({ status: "blocked", blockedReason: "permission" });
    terminal.status = null; await runner.screen(member());
    expect(events.findLast(e => e.type === "status")).toMatchObject({ status: "idle", blockedReason: null });
  });
  test("입력칸이 안 보이는 화면·쓰던 글·한 번도 보고하지 않은 CLI 는 그대로 넣지 않는다", async () => {
    const { f, runner, events, terminal } = await ended();
    terminal.status = null; f.setScreen("Do you want to proceed?\n❯ 1. Yes\n  2. No");
    await runner.screen(member());
    expect(events.findLast(e => e.type === "status")).toMatchObject({ status: "blocked", blockedReason: "status_unknown" });
    expect(await runner.send(member(), "no", f.opts)).toMatchObject({ ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: expect.stringContaining("status=null, turn=1, reported=true") });
    f.setScreen(composer("대표가 쓰던 글"));
    expect(await runner.send(member(), "no", f.opts)).toMatchObject({ ok: false, reason: "input_busy", deliveryEffect: "not_written" });
    f.setScreen(composer()); terminal.reported = false;
    expect(await runner.send(member(), "no", f.opts)).toMatchObject({ ok: false, reason: "busy", retryable: true });
    expect(sends(f)).toHaveLength(1);
    const fresh = await fixture(), other = fresh.runner(); const started = await other.start(member(), fresh.opts);
    fresh.terminals.get(started.paneId)!.status = null;
    expect(await other.send(member(), "no", fresh.opts)).toMatchObject({ ok: false, reason: "busy", retryable: true });
    expect(sends(fresh)).toHaveLength(0);
  });
  test("끝나는 순간을 못 봤어도(보고가 바로 사라짐) 잠깐 지켜본 뒤 턴을 한 번 끝낸다", async () => {
    let now = 1_000_000;
    const f = await fixture(), runner = f.runner({ pollNow: () => now }), events: RunnerEvent[] = []; runner.on(e => events.push(e));
    const started = await runner.start(member(), f.opts), terminal = f.terminals.get(started.paneId)!;
    expect(await runner.send(member(), "first", f.opts)).toMatchObject({ ok: true });
    expect(runner.isBusy(member().id)).toBe(true);
    terminal.turn = 1; terminal.status = null;
    await runner.screen(member()); now += 300; await runner.screen(member());
    // 일하다 끝난 상태로 넘어가는 사이의 빈틈일 수 있다. 아직 끝내지 않는다.
    expect(events.some(e => e.type === "turn_end")).toBe(false); expect(runner.isBusy(member().id)).toBe(true);
    now += 700; await runner.screen(member()); await runner.screen(member());
    expect(events.filter(e => e.type === "turn_end")).toMatchObject([{ isError: false, turn: 1 }]);
    expect(runner.isBusy(member().id)).toBe(false);
  });
  test("빈틈 뒤에 오류 보고가 오면 그 오류로 턴을 끝낸다", async () => {
    let now = 1_000_000;
    const f = await fixture(), runner = f.runner({ pollNow: () => now }), events: RunnerEvent[] = []; runner.on(e => events.push(e));
    const started = await runner.start(member(), f.opts), terminal = f.terminals.get(started.paneId)!;
    expect(await runner.send(member(), "first", f.opts)).toMatchObject({ ok: true });
    terminal.turn = 1; terminal.status = null; await runner.screen(member());
    now += 200; terminal.status = { state: "error", msg: "API Error: overloaded" }; await runner.screen(member());
    expect(events.filter(e => e.type === "turn_end")).toMatchObject([{ isError: true, errorText: "API Error: overloaded" }]);
  });
  // review runner-recovery-2·4: 보고 없이 끝난 턴을 성공한 턴으로 알려 장애·한도 보류가 풀렸고, 지켜보는 0.75초 동안 거짓 '승인 대기'가 나갔다.
  const above = (text: string) => `${text}\n${"─".repeat(30)}\n❯ \n${"─".repeat(30)}\n`;
  async function silentEnd(screen: string) {
    let now = 1_000_000;
    const f = await fixture(), runner = f.runner({ pollNow: () => now }), events: RunnerEvent[] = []; runner.on(e => events.push(e));
    const started = await runner.start(member(), f.opts), terminal = f.terminals.get(started.paneId)!;
    expect(await runner.send(member(), "first", f.opts)).toMatchObject({ ok: true });
    terminal.turn = 1; terminal.status = null; f.setScreen(screen);
    await runner.screen(member());
    // 끝을 지켜보는 동안에는 막힘도 턴 끝도 알리지 않는다.
    expect(events.some(e => e.type === "turn_end" || e.type === "status" && e.status === "blocked")).toBe(false);
    now += 800; await runner.screen(member());
    expect(events.some(e => e.type === "status" && e.status === "blocked")).toBe(false);
    return { f, runner, ends: () => events.filter(e => e.type === "turn_end"), terminal };
  }
  test("보고 없이 끝난 턴은 추정으로 알리고, 입력칸 위에 CLI 의 연결 오류 줄이 있으면 그 오류로 끝낸다", async () => {
    const failed = await silentEnd(above("⏺ 파일을 고치는 중입니다\n  ⎿  API Error: Connection error.\n     Retrying failed after 10 attempts\n"));
    expect(failed.ends()).toMatchObject([{ isError: true, errorText: "API Error: Connection error.", inferred: true, turn: 1 }]);
    expect(failed.runner.observationState(member().id)).toMatchObject({ state: "done", lastError: "API Error: Connection error." });
    const limited = await silentEnd(above("  ⎿  You've hit your weekly limit · resets 3am"));
    expect(limited.ends()).toMatchObject([{ isError: true, errorText: "You've hit your weekly limit · resets 3am", inferred: true }]);
    // 한도 안내 글에는 어떤 키도 넣지 않는다.
    expect(limited.f.calls.some(c => c.method === "terminal.keys")).toBe(false);
  });
  test("오류 줄이 없으면 오류 없이 끝내되 추정이라고 알리고, 보고가 있는 턴 끝에는 붙이지 않는다", async () => {
    const plain = await silentEnd(above("⏺ 원인은 API Error: 529 overloaded 였습니다. 한도 문제는 아닙니다."));
    expect(plain.ends()).toMatchObject([{ isError: false, inferred: true, turn: 1 }]);
    expect(plain.ends()[0]).not.toHaveProperty("errorText");
    expect(await plain.runner.send(member(), "다음 글", plain.f.opts)).toMatchObject({ ok: true });
    plain.terminal.turn = 2; plain.terminal.status = { state: "idle" }; await plain.runner.screen(member());
    expect(plain.ends()).toHaveLength(2);
    expect(plain.ends()[1]).toMatchObject({ isError: false, turn: 2 });
    expect(plain.ends()[1]).not.toHaveProperty("inferred");
  });
  test("화면 끝의 오류 줄 판독: 줄 머리가 CLI 의 오류 꼴이고 연결·한도일 때만", () => {
    expect(screenTurnError(above("  ⎿  API Error: 529 {\"type\":\"overloaded_error\"}"))).toBe('API Error: 529 {"type":"overloaded_error"}');
    expect(screenTurnError(above("■ stream disconnected before completion: error sending request"))).toBe("stream disconnected before completion: error sending request");
    expect(screenTurnError(above("⏺ You've reached your usage limit. Try again in 3h 2m"))).toBe("You've reached your usage limit. Try again in 3h 2m");
    // 인증·그 밖의 오류는 장애·한도 경로로 보내지 않는다.
    expect(screenTurnError(above("  ⎿  API Error: 401 authentication_error"))).toBeNull();
    expect(screenTurnError(above("  ⎿  API Error: 400 invalid_request_error"))).toBeNull();
    // 대화 글 속의 낱말, 입력칸에서 먼 옛 오류 줄은 세지 않는다.
    expect(screenTurnError(above("⏺ 사용 한도와 rate limit 처리를 고쳤습니다. API Error: 529 도 다시 시도합니다."))).toBeNull();
    expect(screenTurnError(above(["  ⎿  API Error: Connection error.", ...Array.from({ length: 12 }, (_, i) => `⏺ 이어서 한 일 ${i}`)].join("\n")))).toBeNull();
    expect(screenTurnError(composer())).toBeNull();
  });
  test("보고가 사라진 CLI 의 수신 검사도 send 와 같이 끝난 상태(done)로 읽는다", async () => {
    const { runner, terminal } = await ended();
    terminal.status = null; await runner.screen(member());
    expect((await runner.inspectDelivery(member(), envelope(runner, "lost"))).snapshot).toMatchObject({ status: "done", blockedReason: null });
  });

  // review runner-recovery-5
  test("Claude 세션 기록: 다른 프로젝트 폴더 아래에 있어도 찾고, 폴더를 읽지 못한 것은 '없음'이 아니다", async () => {
    const f = await fixture(), runner = f.runner(), home = join(f.dir, "claude-home"), who = member({ sessionId: "session-moved" });
    // 기록 폴더가 아예 없으면 세션도 없다.
    expect(runner.sessionExists(who)).toBe(false);
    mkdirSync(join(home, "projects", "-some-other-folder"), { recursive: true });
    expect(runner.sessionExists(who)).toBe(false);
    writeFileSync(join(home, "projects", "-some-other-folder", "session-moved.jsonl"), "{}\n");
    expect(runner.sessionExists(who)).toBe(true);
    const broken = await fixture(), other = broken.runner();
    mkdirSync(join(broken.dir, "claude-home"), { recursive: true });
    writeFileSync(join(broken.dir, "claude-home", "projects"), "not a directory");
    expect(other.sessionExists(who)).toBe(true);
  });

  test("core 가 실제로 보내는 kind(question·auth)를 차단 사유로 옮긴다", async () => {
    const f = await fixture(), runner = f.runner(), events: RunnerEvent[] = []; runner.on(e => events.push(e));
    const started = await runner.start(member(), f.opts), terminal = f.terminals.get(started.paneId)!;
    f.setScreen("Which option?\n❯ 1. A\n  2. B");
    for (const [kind, reason] of [["question", "selection"], ["auth", "setup"], ["permission", "permission"], ["something-new", "status_unknown"]] as const) {
      terminal.status = { state: "blocked", kind }; await runner.screen(member());
      expect(events.findLast(e => e.type === "status")).toMatchObject({ status: "blocked", blockedReason: reason });
    }
  });
});

describe("재관측은 입력 잠금을 잡지 않는다", () => {
  async function observing() {
    const f = await fixture(), runner = f.runner(), started = await runner.start(member(), f.opts);
    let held: { request: Request; socket: Socket } | null = null;
    f.setHook((request, socket) => { if (request.method !== "terminal.list" || held) return false; held = { request, socket }; return true; });
    const snapshot = structuredClone([...f.terminals.values()]);
    const reattach = runner.reattachOwned(member({ paneId: started.paneId, sessionId: started.sessionId }));
    await until(() => held !== null);
    return { f, runner, started, reattach, release: () => f.reply(held!.socket, held!.request, { terminals: snapshot }) };
  }
  test("재관측 중에도 전달과 조작권 요청이 그대로 된다", async () => {
    const d = await observing();
    expect(await d.runner.send(member(), "delivered during re-observation", d.f.opts)).toMatchObject({ ok: true });
    const lease = await d.runner.terminalControl(member(), { action: "claim" }); expect(lease.leaseId).toBeString();
    d.release();
    expect(await d.reattach).toMatchObject({ outcome: "rejoined", started: { paneId: d.started.paneId } });
  });
  test("재관측 중 잠재우면 잠들고, 낡은 목록으로 다시 묶거나 '없음'을 판정하지 않는다", async () => {
    const d = await observing();
    await d.runner.stop(member());
    expect(d.f.terminals.get(d.started.paneId)!.state).toBe("finished");
    d.release(); // 잠재우기 전에 찍힌 목록: 터미널이 아직 살아 있다고 적혀 있다.
    expect(await d.reattach).toEqual({ outcome: "unknown", code: "mutation_in_progress" });
    expect(d.runner.observationState(member().id)).toBeNull();
    expect(d.f.calls.filter(c => c.method === "terminal.run")).toHaveLength(1);
  });
  test("새로 묶어야 하는 재결합은 지금처럼 잠금을 잡는다", async () => {
    const f = await fixture(), first = f.runner(), started = await first.start(member(), f.opts); await first.shutdown();
    const runner = f.runner();
    let held: { request: Request; socket: Socket } | null = null;
    f.setHook((request, socket) => { if (request.method !== "terminal.list" || held) return false; held = { request, socket }; return true; });
    const reattach = runner.reattachOwned(member({ paneId: started.paneId, sessionId: started.sessionId }));
    await until(() => held !== null);
    expect(await runner.send(member({ paneId: started.paneId, sessionId: started.sessionId }), "collides", f.opts)).toMatchObject({ ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" });
    f.reply(held!.socket, held!.request, { terminals: [...f.terminals.values()] });
    expect(await reattach).toMatchObject({ outcome: "rejoined" });
  });
  test("붙어 있던 터미널이 죽고 같은 직원의 새 터미널이 살아 있으면 잠금을 잡고 그쪽으로 다시 묶는다", async () => {
    const f = await fixture(), runner = f.runner(), started = await runner.start(member(), f.opts);
    const old = f.terminals.get(started.paneId)!; old.state = "finished";
    // 답을 잃은 terminal.run 이 만든 새 터미널: 실행기는 아직 옛 터미널을 붙들고 있다.
    f.terminals.set("t2", { ...structuredClone(old), address: "t2", state: "live", turn: 0, status: { state: "idle" } });
    expect(await runner.reattachOwned(member({ paneId: started.paneId, sessionId: started.sessionId }))).toMatchObject({ outcome: "rejoined", started: { paneId: "t2" } });
    expect(runner.observationState(member().id)?.identity.terminalId).toBe("t2");
    expect(f.calls.filter(c => c.method === "terminal.run")).toHaveLength(1);
  });
  test("묶어야 하는데 잠금이 잡혀 있으면 던지지 않고 '모름'으로 답한다", async () => {
    const f = await fixture(), first = f.runner(), started = await first.start(member(), f.opts); await first.shutdown();
    const runner = f.runner(), known = member({ paneId: started.paneId, sessionId: started.sessionId });
    let held: { request: Request; socket: Socket } | null = null;
    f.setHook((request, socket) => { if (request.method !== "hello" || held) return false; held = { request, socket }; return true; });
    const starting = runner.start(known, { ...f.opts, resume: true });
    await until(() => held !== null);
    expect(await runner.reattachOwned(known)).toMatchObject({ outcome: "unknown", code: "busy" });
    f.reply(held!.socket, held!.request, { generation: 1, version: "test", methods, features: [] });
    expect(await starting).toMatchObject({ rejoined: true, paneId: started.paneId });
  });
});
