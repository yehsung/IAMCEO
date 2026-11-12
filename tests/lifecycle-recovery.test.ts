import { afterEach, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Bus } from "../server/bus.ts";
import { ApiError, Store } from "../server/store.ts";
import { Orchestrator, type OrchestratorTimings } from "../server/orchestrator.ts";
import { CoreRunner } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import type { RunnerEvent } from "../server/runner/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface Rpc {
  id: string;
  method: string;
  params: { terminal?: string; argv?: string[]; cwd?: string; labels?: Record<string, string>; text?: string };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}
async function fixture(healthMs = 60_000, rpcTimeoutMs = 100) {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath);
  const bus = new Bus();
  const store = new Store(db, bus);
  const project = store.createProject({ name: "Lifecycle", cwd: isolated.paths.work });
  const calls: Rpc[] = [];
  const terminals = new Map<string, CoreTerminal>();
  const sockets = new Set<Socket>();
  let draft = "";
  let runLost = false;
  let runDropped = false;
  let transcripts = true;
  let keysLost = false;
  let sendStarted = true;
  let getUnavailable = false;
  let killLost = false;
  let rejectSend = false;
  let unknownSend = false;
  let silentBoot = false;
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const request = JSON.parse(buffer.slice(0, newline)) as Rpc;
        buffer = buffer.slice(newline + 1); calls.push(request);
        let result: unknown;
        const terminal = terminals.get(request.params.terminal ?? "");
        if (request.method === "hello") result = { generation: 1, version: "fake", methods: ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.keys", "terminal.kill", "terminal.interrupt"], features: [] };
        if (request.method === "terminal.list") result = { terminals: [...terminals.values()] };
        if (request.method === "terminal.run" && runDropped) { socket.destroy(); continue; }
        if (request.method === "terminal.run") {
          const created: CoreTerminal = { address: `t${terminals.size + 1}`, argv: request.params.argv!, cwd: request.params.cwd!, labels: request.params.labels!, state: "live", turn: 0, ...(silentBoot ? {} : { status: { state: "idle", app: "claude-code" } }) };
          terminals.set(created.address, created); result = created;
          // 대화를 한 번이라도 한 CLI 는 세션 기록을 남긴다. 기록이 없는 세션은 이어 열 수 없다.
          const session = request.params.argv![request.params.argv!.indexOf("--session-id") + 1];
          if (transcripts && request.params.argv!.includes("--session-id") && session) {
            const path = transcriptPath(request.params.cwd!, session, isolated.providerHomes.claudeHome);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, JSON.stringify({ type: "user", sessionId: session, cwd: request.params.cwd, uuid: "boot", message: { role: "user", content: "첫 인사" } }) + "\n");
          }
          if (runLost) { socket.destroy(); continue; }
        }
        if (request.method === "terminal.get" && !getUnavailable) result = terminal;
        if (request.method === "terminal.read") result = { text: `output\n${"─".repeat(30)}\n❯ ${draft}\n${"─".repeat(30)}\n`, complete: true };
        if (request.method === "terminal.send" && terminal) {
          if (rejectSend) { socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "busy after restart", data: { kind: "status_mismatch" } } }) + "\n"); continue; }
          if (unknownSend) { socket.destroy(); continue; }
          result = { turn: terminal.turn, started: sendStarted, status: "idle" };
          if (sendStarted) terminal.status = { state: "working" };
        }
        if (request.method === "terminal.keys") { if (keysLost) { socket.destroy(); continue; } result = {}; }
        if (request.method === "terminal.interrupt") result = { outcome: "stopped" };
        if (request.method === "terminal.kill" && terminal) {
          if (killLost) { socket.destroy(); continue; }
          terminal.state = "finished"; result = terminal;
        }
        socket.write(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "not found", data: { kind: getUnavailable ? "temporarily_unavailable" : "not_found" } } } : { jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(isolated.socketPath, resolve));
  const orchestrators: Orchestrator[] = [];
  const runners: CoreRunner[] = [];
  /** live: 실제 서버처럼 실행기에 원래 쓰기의 상태(quiescence)와 복구 쓰기(repair) 포트를 잇는다. */
  function orchestrator(timings: Partial<OrchestratorTimings> = {}, live = false) {
    const wired: { orch?: Orchestrator } = {};
    const runner = new CoreRunner({ ...isolated.runnerOptions(isolated.providerHomes) }, { recoveryStore: store, pollMs: 20, rpcTimeoutMs, sendTimeoutMs: rpcTimeoutMs, ...(live ? {
      quiescence: (memberId, dispatch) => wired.orch!.dispatchQuiescence(memberId, dispatch),
      repair: { load: (memberId, request) => wired.orch!.deliveryRecovery.repair.load(memberId, request), prepare: (memberId, request, dispatch) => wired.orch!.deliveryRecovery.repair.prepare(memberId, request, dispatch) },
    } : {}) });
    const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs, retryMs: 10, inputBusyRetryMs: 10, ...timings } });
    wired.orch = orch;
    runners.push(runner); orchestrators.push(orch);
    return { orch, runner };
  }
  cleanups.push(async () => {
    for (const orch of orchestrators) await orch.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); await isolated.stop();
  });
  const current = orchestrator();
  return { ...current, store, bus, db, project, config, calls, terminals, runners, orchestrator, claudeHome: isolated.providerHomes.claudeHome,
    count: (method: string) => calls.filter(c => c.method === method).length,
    loseRun: (value: boolean) => { runLost = value; }, dropRun: (value: boolean) => { runDropped = value; }, transcripts: (value: boolean) => { transcripts = value; }, loseKeys: () => { keysLost = true; },
    loseKill: (value: boolean) => { killLost = value; }, unavailable: (value: boolean) => { getUnavailable = value; },
    rejectSend: (value: boolean) => { rejectSend = value; }, unknownSend: (value = true) => { unknownSend = value; }, silentBoot: (value: boolean) => { silentBoot = value; },
    draft: (text: string) => { draft = text; }, started: (value: boolean) => { sendStarted = value; } };
}

test("lost creation reply preserves intent/member and restart rejoins labels with no additional run", async () => {
  const f = await fixture(); f.loseRun(true);
  await expect(f.orch.createMember(f.project.id, { name: "Worker" })).rejects.toThrow();
  const member = f.store.listMembers(f.project.id)[0]!;
  expect(member.lastError).toStartWith("starting_unknown:");
  expect(f.store.listPendingLifecycleJournals()[0]).toMatchObject({ memberId: member.id, intent: "start", phase: "unknown" });
  expect(f.calls.find(c => c.method === "terminal.run")?.params.labels?.["iamceo.operation"]).toBe(f.store.listPendingLifecycleJournals()[0]!.operationId);
  await f.orch.shutdown(); f.loseRun(false);
  const next = f.orchestrator(); await next.orch.recover();
  expect(f.store.requireMember(member.id).paneId).toBe("t1");
  expect(f.store.listPendingLifecycleJournals()).toHaveLength(0);
  expect(f.count("terminal.run")).toBe(1);
});

// orch-b-1: 깨우다 결과를 놓친 기동이 직원을 영구히 막았다. 잠든 직원은 감시에서도 빠졌다.
test("a sleeping member whose wake reply was lost and whose terminal never appeared is released after the grace and woken again", async () => {
  const f = await fixture(5);
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.sleepMember(member.id);
  await f.orch.shutdown();
  const next = f.orchestrator({ startGraceMs: 0 });
  f.dropRun(true);
  await next.orch.assign(f.project.id, member.handle, { text: "깨어나서 할 일" });
  expect(f.store.listPendingLifecycleJournals()[0]).toMatchObject({ memberId: member.id, intent: "start", phase: "unknown" });
  expect(f.store.requireMember(member.id)).toMatchObject({ status: "asleep", paneId: null });
  await expect(next.orch.resumeMember(member.id)).rejects.toThrow();
  await expect(next.orch.sleepMember(member.id, { force: true })).rejects.toThrow("미확정 세션 작업");
  const runs = f.count("terminal.run");
  f.dropRun(false);
  for (let i = 0; i < 200 && f.count("terminal.send") === 0; i++) { await next.orch.refreshConnection(); await Bun.sleep(5); }
  expect(f.store.listPendingLifecycleJournals()).toHaveLength(0);
  expect(f.count("terminal.run")).toBe(runs + 1);
  expect(f.count("terminal.send")).toBe(1);
  expect(f.store.requireMember(member.id)).toMatchObject({ lastError: null, paneId: "t2" });
  expect(f.store.listPending(member.id)).toHaveLength(0);
});

test("a wake that is still within the grace keeps its unknown start journal", async () => {
  const f = await fixture(5);
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.sleepMember(member.id);
  f.dropRun(true);
  await f.orch.assign(f.project.id, member.handle, { text: "깨어나서 할 일" });
  f.dropRun(false);
  for (let i = 0; i < 6; i++) { await f.orch.refreshConnection(); await Bun.sleep(5); }
  expect(f.store.listPendingLifecycleJournals()[0]).toMatchObject({ memberId: member.id, intent: "start", phase: "unknown" });
  expect(f.count("terminal.run")).toBe(2);
});

test("a sleeping member whose wake reply was lost but whose terminal exists is rejoined although it still reads asleep", async () => {
  const f = await fixture(5);
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.sleepMember(member.id);
  f.loseRun(true);
  await f.orch.assign(f.project.id, member.handle, { text: "깨어나서 할 일" });
  expect(f.store.listPendingLifecycleJournals()[0]).toMatchObject({ memberId: member.id, intent: "start", phase: "unknown" });
  expect(f.store.requireMember(member.id).status).toBe("asleep");
  f.loseRun(false);
  for (let i = 0; i < 200 && f.count("terminal.send") === 0; i++) { await f.orch.refreshConnection(); await Bun.sleep(5); }
  expect(f.store.listPendingLifecycleJournals()).toHaveLength(0);
  expect(f.count("terminal.run")).toBe(2);
  expect(f.count("terminal.send")).toBe(1);
  expect(f.store.requireMember(member.id)).toMatchObject({ paneId: "t2", lastError: null });
  expect(f.store.requireMember(member.id).status).not.toBe("asleep");
});

// orch-b-2: core 는 터미널만 뜨면 성공으로 답해, 기록이 없는 세션을 --resume 하면 CLI 가 곧바로 끝나기를 끝없이 되풀이했다.
test("waking a member whose session has no record starts a fresh session instead of resuming a missing one", async () => {
  const f = await fixture(); f.transcripts(false);
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.sleepMember(member.id);
  await f.orch.assign(f.project.id, member.handle, { text: "깨어나서 할 일" });
  const runs = f.calls.filter(c => c.method === "terminal.run");
  expect(runs).toHaveLength(2);
  expect(runs[1]!.params.argv).not.toContain("--resume");
  expect(runs[1]!.params.argv).toContain("--session-id");
  const now = f.store.requireMember(member.id);
  expect(now.sessionId).not.toBe(member.sessionId);
  expect(now.sessionId).toBe(runs[1]!.params.argv![runs[1]!.params.argv!.indexOf("--session-id") + 1]!);
  expect(f.calls.find(c => c.method === "terminal.send")?.params.text).toContain("이전 세션을 찾지 못해 새 세션으로 시작합니다");
});

test("a session with a record is still resumed", async () => {
  const f = await fixture();
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.sleepMember(member.id);
  await f.orch.resumeMember(member.id);
  const run = f.calls.filter(c => c.method === "terminal.run")[1]!;
  expect(run.params.argv).toContain("--resume");
  expect(f.store.requireMember(member.id).sessionId).toBe(member.sessionId);
});

test("a fresh session whose launch reply was lost is rejoined by its new session label", async () => {
  const f = await fixture(5); f.transcripts(false);
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.sleepMember(member.id);
  f.loseRun(true);
  await f.orch.assign(f.project.id, member.handle, { text: "깨어나서 할 일" });
  expect(f.store.listPendingLifecycleJournals()[0]).toMatchObject({ memberId: member.id, intent: "start", phase: "unknown" });
  f.loseRun(false);
  for (let i = 0; i < 200 && f.count("terminal.send") === 0; i++) { await f.orch.refreshConnection(); await Bun.sleep(5); }
  expect(f.store.listPendingLifecycleJournals()).toHaveLength(0);
  expect(f.count("terminal.run")).toBe(2);
  expect(f.store.requireMember(member.id)).toMatchObject({ paneId: "t2", sessionId: f.terminals.get("t2")!.labels["iamceo.session"] });
  expect(f.store.requireMember(member.id).statusObservation?.ownership).toBe("verified");
});

test("a start that fails before anything is sent to the runner is refused, not left unknown", async () => {
  const f = await fixture();
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.sleepMember(member.id);
  const runs = f.count("terminal.run");
  const internals = f.orch as unknown as { writeRunFiles: () => never };
  const original = internals.writeRunFiles;
  internals.writeRunFiles = () => { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); };
  await expect(f.orch.resumeMember(member.id)).rejects.toThrow();
  expect(f.store.listPendingLifecycleJournals()).toHaveLength(0);
  expect(f.count("terminal.run")).toBe(runs);
  internals.writeRunFiles = original;
  await f.orch.resumeMember(member.id);
  expect(f.count("terminal.run")).toBe(runs + 1);
  expect(f.store.requireMember(member.id).status).toBe("idle");
});

test("uncertain creation with duplicate owners is quarantined without run or kill", async () => {
  const f = await fixture(); f.loseRun(true);
  await expect(f.orch.createMember(f.project.id, { name: "Worker" })).rejects.toThrow();
  const first = f.terminals.get("t1")!;
  f.terminals.set("t2", { ...first, address: "t2" });
  await f.orch.shutdown();
  const next = f.orchestrator(); await next.orch.recover();
  const member = f.store.listMembers(f.project.id)[0]!;
  expect(member.statusObservation?.ownership).toBe("conflict");
  await next.orch.assign(f.project.id, member.handle, { text: "Follow up" });
  expect(f.count("terminal.run")).toBe(1); expect(f.count("terminal.kill")).toBe(0); expect(f.count("terminal.send")).toBe(0);
});

test("initial bind failure with empty queue recovers through read-only supervisor", async () => {
  const f = await fixture(20);
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.shutdown();
  const terminal = f.terminals.get(member.paneId!)!;
  const labels = terminal.labels; terminal.labels = { ...labels, "iamceo.generation": "99" };
  const next = f.orchestrator(); await next.orch.recover();
  expect(f.store.requireMember(member.id).statusObservation?.ownership).toBe("conflict");
  terminal.labels = labels;
  await until(() => f.store.requireMember(member.id).statusObservation?.ownership === "verified");
  expect(f.count("terminal.run")).toBe(1); expect(f.count("terminal.send")).toBe(0);
});

test("sleep and close refusals preserve live state and always release closing guard", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.draft("human draft");
  await expect(f.orch.sleepMember(member.id)).rejects.toThrow();
  expect(f.store.requireMember(member.id)).toMatchObject({ status: "idle", paneId: member.paneId });
  await expect(f.orch.closeMember(member.id)).rejects.toThrow();
  expect(f.store.requireMember(member.id).status).toBe("idle");
  f.draft(""); await f.orch.closeMember(member.id);
  expect(f.store.getMember(member.id)).toBeNull();
  expect(f.count("terminal.kill")).toBe(1);
});

test("unknown stop stays live in DB and restart confirms termination before asleep", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.loseKill(true);
  await expect(f.orch.sleepMember(member.id)).rejects.toThrow();
  expect(f.store.requireMember(member.id).status).toBe("idle");
  expect(f.store.listPendingLifecycleJournals()[0]).toMatchObject({ intent: "sleep", phase: "unknown" });
  f.terminals.get(member.paneId!)!.state = "finished";
  await f.orch.shutdown(); f.loseKill(false);
  const next = f.orchestrator(); await next.orch.recover();
  expect(f.store.requireMember(member.id)).toMatchObject({ status: "asleep", paneId: null, sessionId: member.sessionId });
  expect(f.store.listPendingLifecycleJournals()).toHaveLength(0);
  expect(f.count("terminal.run")).toBe(1);
});

test("persistent lease is restored before recovery can pump a wake queue", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  const generation = f.store.memberRevisions(member.id).sessionGeneration;
  const request = { operationId: "claim-operation", expectedSessionGeneration: generation, claimId: "claim-one", action: "claim" as const };
  const claim = await f.orch.terminalControlV2(member.id, request);
  expect(claim.status).toBe("applied");
  f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "Wait for lease" });
  await f.orch.shutdown();
  const next = f.orchestrator(); await next.orch.recover();
  expect(f.count("terminal.send")).toBe(0);
  expect(await next.orch.terminalControlV2(member.id, request)).toEqual(claim);
  const release = await next.orch.terminalControlV2(member.id, { ...request, operationId: "release-operation", action: "release" });
  expect(release.status).toBe("applied");
  await until(() => f.count("terminal.send") === 1);
});

test("a persisted lease whose terminal ended while the server was down no longer holds the wake queue", async () => {
  // 위 시험의 짝: 조작권을 얻은 터미널이 살아 있으면 재시작 뒤에도 조작권이 대기열을 막는다(그대로다).
  // 그 터미널이 끝난 것이 확인되면 조작권은 묶일 곳이 없다: 만료(5분)를 기다리지 않고 거두고, 깨우는 전달이 새 터미널을 열어 나간다.
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  const generation = f.store.memberRevisions(member.id).sessionGeneration;
  const claim = await f.orch.terminalControlV2(member.id, { operationId: "claim-operation", expectedSessionGeneration: generation, claimId: "claim-one", action: "claim" });
  expect(claim.status).toBe("applied");
  f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "After the terminal ended" });
  await f.orch.shutdown();
  f.terminals.get(member.paneId!)!.state = "finished";
  const next = f.orchestrator(); await next.orch.recover();
  expect(f.store.inputState(member.id).lease).toBeNull();
  await until(() => f.count("terminal.send") === 1);
  expect(f.count("terminal.run")).toBe(2);
  expect(f.calls.find(c => c.method === "terminal.send")!.params.terminal).toBe(f.store.requireMember(member.id).paneId!);
  expect(f.store.requireMember(member.id).paneId).not.toBe(member.paneId);
  expect(f.store.listActivity(member.id).some(a => a.text.includes("직접 조작하던 터미널이 끝나 그 조작권을 거뒀습니다"))).toBe(true);
  // 새 터미널에서는 같은 앱이 조작권을 곧바로 다시 얻을 수 있다.
  await next.orch.pump(member.id);
  const again = await next.orch.terminalControlV2(member.id, { operationId: "claim-again", expectedSessionGeneration: generation, claimId: "claim-one", action: "claim" });
  expect(again.status).toBe("applied");
});

test("unknown direct Enter is durable and neither same operation nor same sequence replays", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  const expectedSessionGeneration = f.store.memberRevisions(member.id).sessionGeneration;
  await f.orch.terminalControlV2(member.id, { operationId: "claim", expectedSessionGeneration, claimId: "owner", action: "claim" });
  f.loseKeys();
  const request = { operationId: "enter", expectedSessionGeneration, claimId: "owner", action: "key" as const, key: "enter" as const, inputSequence: 1 };
  expect((await f.orch.terminalControlV2(member.id, request)).status).toBe("unknown");
  await f.orch.shutdown(); const next = f.orchestrator(); await next.orch.recover();
  expect((await next.orch.terminalControlV2(member.id, request)).status).toBe("unknown");
  expect((await next.orch.terminalControlV2(member.id, { ...request, operationId: "different-id" })).status).toBe("refused");
  expect(f.count("terminal.keys")).toBe(1);
});

test("fresh-session receipt returns before generation recheck and conflicting reuse is refused", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  const request = { operationId: "fresh", expectedSessionGeneration: f.store.memberRevisions(member.id).sessionGeneration };
  const receipt = await f.orch.freshMemberSessionV2(member.id, request);
  expect(receipt.status).toBe("applied");
  expect(await f.orch.freshMemberSessionV2(member.id, request)).toEqual(receipt);
  await expect(f.orch.freshMemberSessionV2(member.id, { ...request, expectedSessionGeneration: 9 })).rejects.toMatchObject({ status: 409 });
  expect(f.count("terminal.run")).toBe(2); expect(f.count("terminal.kill")).toBe(1);
});

test("ACK started:false is received; repeated reads never replay or interrupt a stalled task", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" }); f.started(false);
  await f.orch.assign(f.project.id, member.handle, { text: "One task" });
  const run = f.store.listPendingExecutions()[0]!;
  expect(run).toMatchObject({ phase: "received", deliveryIds: [expect.any(String)], startedAt: null });
  f.store.saveExecutionJournal({ ...run, inputReceivedAt: new Date(Date.now() - 30_000).toISOString() });
  await f.orch.refreshConnection();
  expect(f.store.requireMember(member.id).statusObservation?.error?.code).toBe("start_stalled");
  await f.orch.pump(member.id); await f.orch.refreshConnection();
  expect(f.count("terminal.send")).toBe(1); expect(f.count("terminal.interrupt")).toBe(0); expect(f.count("terminal.keys")).toBe(0);
});

test("error then idle keeps the error; stale and duplicate terminal events do not end a later turn", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.assign(f.project.id, member.handle, { text: "Fail once" });
  const terminal = f.terminals.get(member.paneId!)!;
  terminal.turn = 1; terminal.status = { state: "error", msg: "real failure" };
  await until(() => f.store.requireMember(member.id).status === "error");
  terminal.status = { state: "idle" };
  await Bun.sleep(40);
  expect(f.store.requireMember(member.id)).toMatchObject({ status: "error", lastError: "real failure" });
  const run = f.db.query<{ run_id: string }, []>("SELECT run_id FROM execution_journal").get()!;
  expect(f.store.getExecutionJournal(run.run_id)).toMatchObject({ phase: "ended", result: "error" });
  const count = f.store.listActivity(member.id).filter(a => a.kind === "error").length;
  const emit = (event: RunnerEvent) => (f.orch as unknown as { onRunnerEvent(e: RunnerEvent): Promise<void> }).onRunnerEvent(event);
  await emit({ type: "turn_end", memberId: member.id, terminalId: member.paneId, sessionGeneration: 0, turn: 1, isError: true, finalText: "", errorText: "duplicate" });
  await emit({ type: "status", memberId: member.id, terminalId: member.paneId, sessionGeneration: 0, turn: 0, status: "idle" });
  expect(f.store.listActivity(member.id).filter(a => a.kind === "error")).toHaveLength(count);
});

test("confirmed CLI exit preserves reason/code, delivery linkage and one interruption across restart", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.assign(f.project.id, member.handle, { text: "Unfinished task" });
  const run = f.store.listPendingExecutions()[0]!;
  const terminal = f.terminals.get(member.paneId!)!; terminal.state = "finished"; terminal.reason = "resume failed"; terminal.exit_code = 17;
  await until(() => f.store.requireMember(member.id).status === "offline");
  expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "interrupted", result: "interrupted", reason: "resume failed", exitCode: 17, deliveryIds: run.deliveryIds, interruptionNotifiedAt: expect.any(String) });
  const before = f.store.listMessages(f.project.id).filter(m => m.body.includes(run.runId)).length;
  await f.orch.shutdown(); const next = f.orchestrator(); await next.orch.recover();
  expect(f.store.listMessages(f.project.id).filter(m => m.body.includes(run.runId))).toHaveLength(before);
});

test("Codex gone then wake with an unknown native ID cannot create a fresh conversation", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Codex", cli: "codex" });
  f.terminals.get(member.paneId!)!.state = "finished";
  await until(() => f.store.requireMember(member.id).status === "offline");
  await f.orch.assign(f.project.id, member.handle, { text: "Continue" });
  expect(f.count("terminal.run")).toBe(1);
  expect(f.store.requireMember(member.id).paneId).toBe(member.paneId);
});

test("restart recognizes a later settled core turn without interruption or another send", async () => {
  const f = await fixture(60_000, 5_000); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.assign(f.project.id, member.handle, { text: "Finish while away" });
  const run = f.store.listPendingExecutions()[0]!;
  await f.orch.shutdown();
  // A missing report intentionally schedules a new send after retryMs. Supply
  // the report so this test measures recovery rather than racing that timer.
  f.store.createMessage({ projectId: f.project.id, memberId: member.id, who: member.name, kind: "완료", title: "완료 보고", body: "작업 완료" });
  const terminal = f.terminals.get(member.paneId!)!;
  terminal.turn = 1; terminal.status = { state: "done" };
  const next = f.orchestrator(); await next.orch.recover();
  await until(() => f.store.getExecutionJournal(run.runId)?.phase === "ended");
  expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "ended", result: "success", interruptionNotifiedAt: null });
  await next.orch.refreshConnection(); await next.orch.pump(member.id);
  expect(f.count("terminal.send")).toBe(1); expect(f.count("terminal.run")).toBe(1);
}, 15_000);

test("a write whose reply was lost settles from log receipt once a later turn is seen, then asks for the missing report", async () => {
  // Real 2026-11-07 run: kill -9 ~60ms after an owner message left dispatch write_started and the run in "starting".
  // Recovery proved receipt from the CLI log, but the run stayed "starting": member looked busy and the report the
  // worker could not post while the daemon was down was never requested.
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.assign(f.project.id, member.handle, { text: "Crash-window task" });
  const run = f.store.listPendingExecutions()[0]!;
  expect(f.store.getDispatch(run.runId)?.baseline.turn).toBe(0);
  await f.orch.shutdown();
  // Save the crash snapshot only after the old runner has stopped publishing.
  f.store.saveExecutionJournal({ ...run, phase: "starting", inputReceivedAt: null, startedAt: null, turn: null });
  const terminal = f.terminals.get(member.paneId!)!; terminal.turn = 1; terminal.status = { state: "done" };
  const next = f.orchestrator(); await next.orch.recover(); await next.orch.refreshConnection();
  // Recovery deliberately schedules the missing report after retryMs. It may
  // already be sending by the time recover/refresh returns. Observe its ACK and
  // drain the pump before checking journals or closing the fixture database.
  const reports = f.store.listDeliveries(f.project.id).filter(d => d.memberId === member.id && d.kind === "system" && d.text.includes("보고 보완:"));
  expect(reports).toHaveLength(1);
  await until(() => f.store.requireDelivery(reports[0]!.id).status === "delivered");
  await next.orch.pump(member.id);
  expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "ended", result: "success" });
  expect(f.store.listPendingExecutions()).toMatchObject([{ deliveryIds: [reports[0]!.id], phase: "running" }]);
  expect(f.store.listPending(member.id)).toHaveLength(0);
  const sends = f.calls.filter(c => c.method === "terminal.send");
  expect(sends).toHaveLength(2);
  expect(sends[0]!.params.text).toContain("Crash-window task");
  expect(sends[1]!.params.text).toContain("보고 보완:");
  expect(sends[1]!.params.text).not.toContain("Crash-window task");
  await next.orch.refreshConnection(); await next.orch.pump(member.id);
  expect(f.store.listDeliveries(f.project.id).filter(d => d.text.includes("보고 보완:"))).toHaveLength(1);
  expect(f.count("terminal.send")).toBe(2); expect(f.count("terminal.run")).toBe(1);
  expect(f.count("terminal.interrupt")).toBe(0);
});

test("a recovered start with no later turn stays received and fenced; time alone never ends it", async () => {
  const f = await fixture(60_000, 5_000); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  // Receipt without a started turn is the premise of this crash window. Do not
  // manufacture a working notification and race it against the saved snapshot.
  f.started(false);
  const assigned = await f.orch.assign(f.project.id, member.handle, { text: "Crash-window task, not yet counted" });
  await until(() => f.store.requireDelivery(assigned.delivery.id).status === "delivered");
  await f.orch.shutdown();
  const run = f.store.listPendingExecutions()[0]!;
  expect(run).toMatchObject({ phase: "received", deliveryIds: [assigned.delivery.id], turn: 0, startedAt: null });
  const old = new Date(Date.now() - 60_000).toISOString();
  // Freeze the crash-window snapshot after old runner events have drained.
  f.store.saveExecutionJournal({ ...run, phase: "starting", inputReceivedAt: null, startedAt: null, lastProgressAt: null, turn: null, createdAt: old });
  const terminal = f.terminals.get(member.paneId!)!; terminal.turn = 0; terminal.status = { state: "done" };
  const next = f.orchestrator(); await next.orch.recover(); await next.orch.refreshConnection();
  await until(() => f.store.getExecutionJournal(run.runId)?.phase === "received");
  expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "received", turn: 0 });
  f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "Must remain fenced" });
  // Age the receipt timestamps without sleeping; elapsed time is not evidence
  // of completion. Exercise health reconciliation and the queued-send guard.
  const received = f.store.getExecutionJournal(run.runId)!;
  f.store.saveExecutionJournal({ ...received, inputReceivedAt: old, updatedAt: old });
  await next.orch.refreshConnection(); await next.orch.pump(member.id);
  expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "received", turn: 0, startedAt: null, endedAt: null, result: null });
  expect(f.store.requireMember(member.id).statusObservation?.error?.code).toBe("start_stalled");
  expect(f.store.listPendingExecutions()).toHaveLength(1);
  expect(f.store.listPending(member.id)).toHaveLength(1);
  expect(f.count("terminal.send")).toBe(1);
}, 15_000);

test("a pump that never settles is reported once with its waiting stage and nothing is sent", async () => {
  // Real 2026-11-07 run: one member's queue stayed stuck for minutes with no clue where its pump waited.
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  const sendsBefore = f.count("terminal.send");
  const rt = (f.orch as unknown as { runtime(id: string): { pumping: Promise<void> | null; pumpSince: number | null; pumpStage: string | null; pumpReported: boolean } }).runtime(member.id);
  rt.pumping = new Promise<void>(() => {}); rt.pumpSince = Date.now() - 120_000; rt.pumpStage = "sync_config"; rt.pumpReported = false;
  await f.orch.refreshConnection(); await f.orch.refreshConnection();
  const reports = f.store.listActivity(member.id).filter(a => a.text.includes("전달 처리가") && a.text.includes("sync_config"));
  expect(reports).toHaveLength(1);
  expect(f.count("terminal.send")).toBe(sendsBefore); expect(f.count("terminal.interrupt")).toBe(0); expect(f.count("terminal.keys")).toBe(0);
  rt.pumping = null; rt.pumpSince = null; rt.pumpStage = null;
});

test("same-turn idle after restart leaves the received execution fenced", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" }); f.started(false);
  await f.orch.assign(f.project.id, member.handle, { text: "Received but not started" });
  const received = f.store.listPendingExecutions()[0]!;
  f.store.saveExecutionJournal({ ...received, inputReceivedAt: new Date(Date.now() - 30_000).toISOString() });
  f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "Next task" });
  await f.orch.shutdown(); const next = f.orchestrator(); await next.orch.recover();
  await next.orch.pump(member.id);
  expect(f.store.listPendingExecutions()).toHaveLength(1);
  expect(f.store.requireMember(member.id).statusObservation?.error?.code).toBe("start_stalled");
  expect(f.count("terminal.send")).toBe(1); expect(f.count("terminal.interrupt")).toBe(0);
});

test("finished terminal diagnostics and completion report outside latest 200 survive recovery", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.assign(f.project.id, member.handle, { text: "Reported task" });
  const run = f.store.listPendingExecutions()[0]!;
  f.store.createMessage({ projectId: f.project.id, memberId: member.id, who: member.name, kind: "완료", title: "완료 보고", body: "완료" });
  for (let i = 0; i < 210; i++) f.store.createMessage({ projectId: f.project.id, memberId: member.id, who: member.name, kind: "진행", body: `후속 관측 ${i}` });
  await f.orch.shutdown();
  const terminal = f.terminals.get(member.paneId!)!;
  terminal.state = "finished"; terminal.reason = "normal exit"; terminal.exit_code = 0;
  const next = f.orchestrator(); await next.orch.recover();
  expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "ended", result: "success", exitCode: 0, reason: "normal exit", interruptionNotifiedAt: null });
  expect(f.count("terminal.run")).toBe(1);
});

test("a question or progress message does not turn an interrupted execution into success", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.assign(f.project.id, member.handle, { text: "Unfinished" });
  const run = f.store.listPendingExecutions()[0]!;
  f.store.createMessage({ projectId: f.project.id, memberId: member.id, who: member.name, kind: "질문", body: "아직 확인할 사항" });
  f.terminals.get(member.paneId!)!.state = "finished";
  await until(() => f.store.getExecutionJournal(run.runId)?.phase === "interrupted");
});

test("a second claim cannot take over a live claim and preflight refusals are definite", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  const expectedSessionGeneration = f.store.memberRevisions(member.id).sessionGeneration;
  await f.orch.terminalControlV2(member.id, { operationId: "first-claim", claimId: "owner", expectedSessionGeneration, action: "claim" });
  expect((await f.orch.terminalControlV2(member.id, { operationId: "other-claim", claimId: "other-owner", expectedSessionGeneration, action: "claim" })).status).toBe("refused");
  expect(f.store.inputState(member.id).lease?.claimId).toBe("owner");
  f.store.patchProject(f.project.id, { archived: true });
  expect((await f.orch.terminalControlV2(member.id, { operationId: "archived-key", claimId: "owner", expectedSessionGeneration, action: "key", key: "enter", inputSequence: 1 })).status).toBe("refused");
  expect(f.count("terminal.keys")).toBe(0);
});

test("pending stop recovery respects a persisted lease before the runner binds", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.loseKill(true);
  await expect(f.orch.sleepMember(member.id)).rejects.toThrow();
  const identity = f.runner.observationState(member.id)!.identity;
  f.store.saveLease({ memberId: member.id, claimId: "restored-owner", leaseId: "restored-owner", identity, expiresAt: Date.now() + 300_000, lastInputSequence: 0 });
  const kills = f.count("terminal.kill");
  await f.orch.shutdown(); f.loseKill(false);
  const next = f.orchestrator(); await next.orch.recover();
  expect(f.count("terminal.kill")).toBe(kills);
  expect(f.store.requireMember(member.id).status).not.toBe("asleep");
  expect(f.store.listPendingLifecycleJournals()[0]!.phase).toBe("unknown");
  const release = await next.orch.terminalControlV2(member.id, { operationId: "release-after-stop", claimId: "restored-owner", expectedSessionGeneration: identity.sessionGeneration, action: "release" });
  expect(release.status).toBe("applied");
  await next.orch.refreshConnection();
  expect(f.store.requireMember(member.id).status).toBe("asleep");
});

test("recovery of an idle-only sleep cannot force-stop newly observed work", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.loseKill(true);
  await expect(f.orch.sleepMember(member.id)).rejects.toThrow();
  const kills = f.count("terminal.kill");
  f.terminals.get(member.paneId!)!.status = { state: "working" };
  await f.orch.shutdown(); f.loseKill(false);
  const next = f.orchestrator(); await next.orch.recover();
  expect(f.count("terminal.kill")).toBe(kills);
  expect(f.store.listPendingLifecycleJournals()).toHaveLength(1);
  expect(f.store.requireMember(member.id).status).not.toBe("asleep");
});


test("draft pre-write refusal clears to one automatic send with the same marker and no duplicate", async () => {
  const f = await fixture(), member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.draft("owner draft");
  const d = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "report", text: "직원 보고", wake: true });
  await f.orch.pump(member.id);
  expect(f.count("terminal.send")).toBe(0);
  expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "queued", attempts: 1 });
  const old = f.store.listDispatches(member.id).at(-1)!;
  expect(old.transportState).toBe("rejected"); expect(f.store.getDeliveryRecovery(d.id)?.phase).toBe("resolved");
  f.draft(""); await until(() => f.count("terminal.send") === 1);
  await f.orch.pump(member.id);
  expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "delivered", attempts: 2 });
  expect(f.store.listDispatches(member.id).at(-1)!.markers).toEqual(old.markers);
  expect(f.count("terminal.send")).toBe(1);
});

test("busy rejected survives server restart and sends exactly once after ordinary safety checks", async () => {
  const f = await fixture(), member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.rejectSend(true);
  const d = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "report", text: "보고", wake: true });
  await f.orch.pump(member.id);
  expect(f.count("terminal.send")).toBe(1); expect(f.store.listDispatches(member.id).at(-1)!.transportState).toBe("rejected");
  // Persist the old bug's owner-review state before booting the fixed server.
  const recovery = f.store.getDeliveryRecovery(d.id)!;
  f.store.updateDeliveryRecovery(d.id, recovery.version, { phase: "needs_owner", reason: "identity_changed", nextCheckAt: new Date(Date.now() + 60000).toISOString() });
  await f.orch.shutdown(); f.rejectSend(false);
  const next = f.orchestrator(); await next.orch.recover();
  await until(() => f.store.requireDelivery(d.id).status === "delivered");
  await next.orch.pump(member.id);
  expect(f.count("terminal.send")).toBe(2); expect(f.store.requireDelivery(d.id).attempts).toBe(2);
});

test("unknown send keeps its fence and tells sleep refusal's real cause", async () => {
  const f = await fixture(), member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.unknownSend();
  const d = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "report", text: "보고", wake: true });
  await f.orch.pump(member.id); await f.orch.pump(member.id);
  expect(f.count("terminal.send")).toBe(1); expect(f.store.getDeliveryRecovery(d.id)?.phase).toBe("checking");
  await expect(f.orch.sleepMember(member.id)).rejects.toThrow("전달 결과가 확인되지");
});

test("force sleep preserves a draft with a Korean 409 and restart clears old execution error", async () => {
  const f = await fixture(), member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.draft("preserve me");
  try { await f.orch.sleepMember(member.id, { force: true }); throw new Error("expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).status).toBe(409); expect((error as Error).message).toContain("입력칸에 글"); }
  expect(f.count("terminal.kill")).toBe(0);
  f.draft(""); await f.orch.sleepMember(member.id, { force: true });
  f.store.patchMember(member.id, { lastError: "초기/실행 종료: exited (exit_code=0)" });
  await f.orch.resumeMember(member.id);
  expect(f.store.requireMember(member.id).lastError).toBeNull();
});


for (const started of [false, true]) test(`${started ? "progress" : "start"} advisory survives every emitted reattach observation until new progress`, async () => {
  const f = await fixture(0);
  f.started(started);
  const member = await f.orch.createMember(f.project.id, { name: "Quiet worker" });
  await f.orch.assign(f.project.id, member.handle, { text: "Think quietly" });
  if (started) await until(() => !!f.store.listPendingExecutions()[0]?.startedAt);
  const run = f.store.listPendingExecutions()[0]!;
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  f.store.saveExecutionJournal({ ...run, inputReceivedAt: since, startedAt: started ? since : null, lastProgressAt: started ? since : null });
  await f.orch.refreshConnection();
  const code = started ? "progress_stalled" : "start_stalled";
  expect(f.store.requireMember(member.id).statusObservation?.error?.code).toBe(code);
  const observations: string[] = [];
  const unsubscribe = f.bus.subscribe(event => {
    if (event.type === "member" && event.member.id === member.id) observations.push(event.member.statusObservation?.error?.code ?? "none");
  });
  const gets = f.count("terminal.get"), sends = f.count("terminal.send"), keys = f.count("terminal.keys"), interrupts = f.count("terminal.interrupt");
  for (let n = 0; n < 3; n++) {
    await f.orch.refreshConnection();
    expect(f.store.requireMember(member.id).statusObservation?.error?.code).toBe(code);
  }
  unsubscribe();
  expect(f.count("terminal.get")).toBeGreaterThan(gets);
  expect(observations).toHaveLength(0); // Repeated timestamps persist freshness without invalidating every client's snapshot.
  expect(observations.every(value => value === code)).toBe(true); // Check intermediate websocket events, not just final DB state.
  expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: run.phase, result: null, lastProgressAt: started ? since : null });
  expect(f.count("terminal.send")).toBe(sends); expect(f.count("terminal.keys")).toBe(keys); expect(f.count("terminal.interrupt")).toBe(interrupts);

  const emit = (event: RunnerEvent) => (f.orch as unknown as { onRunnerEvent(e: RunnerEvent): Promise<void> }).onRunnerEvent(event);
  await emit({ type: "activity", memberId: member.id, terminalId: member.paneId, sessionGeneration: run.identity.sessionGeneration, kind: "tool", text: "New output" });
  await f.orch.refreshConnection();
  expect(f.store.requireMember(member.id).statusObservation?.error).toBeNull();
  expect(Date.parse(f.store.getExecutionJournal(run.runId)!.lastProgressAt!)).toBeGreaterThan(Date.parse(since));
  // Real observation failures still take precedence over the soft execution advisory.
  await emit({ type: "status", memberId: member.id, terminalId: member.paneId, sessionGeneration: run.identity.sessionGeneration, status: "working",
    observation: { source: "core", observedAt: since, freshness: "stale", ownership: "unknown", consecutiveFailures: 1, error: { code: "timeout", note: "Observation failed" } } });
  expect(f.store.requireMember(member.id).statusObservation).toMatchObject({ freshness: "stale", error: { code: "timeout" } });
});

test("a just-woken CLI that has not reported ready is not written to; its idle signal sends once with no rejected attempt", async () => {
  const f = await fixture(), member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.sleepMember(member.id);
  f.silentBoot(true);
  const d = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "report", text: "깨우는 보고", wake: true });
  await f.orch.pump(member.id);
  expect(f.count("terminal.run")).toBe(2);
  expect(f.count("terminal.send")).toBe(0);
  // Previously the pump wrote at once, core refused ("No trustworthy idle OSC 7501 status") and every wake left a
  // rejected envelope plus an error run, then waited out a retry interval although the CLI became ready meanwhile.
  expect(f.store.listDispatches(member.id)).toHaveLength(0);
  expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "queued", attempts: 0 });
  f.terminals.get(f.store.requireMember(member.id).paneId!)!.status = { state: "idle", app: "claude-code" };
  await until(() => f.store.requireDelivery(d.id).status === "delivered");
  expect(f.count("terminal.send")).toBe(1);
  expect(f.store.listDispatches(member.id).map(dispatch => dispatch.transportState)).toEqual(["accepted"]);
});

// review orchestrator-5: the wait for a ready report had no limit and no reason; the delivery just stayed queued.
test("a woken CLI that never reports ready becomes visibly blocked after the limit, and its idle signal still delivers", async () => {
  const f = await fixture(), member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.sleepMember(member.id);
  await f.orch.shutdown();
  const next = f.orchestrator({ inputBusyLimitMs: 60 });
  await next.orch.recover();
  f.silentBoot(true);
  const d = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "report", text: "깨우는 보고", wake: true });
  await next.orch.pump(member.id);
  // Within the limit nothing is written and nothing is held.
  expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "queued", attempts: 0 });
  await until(() => f.store.requireDelivery(d.id).status === "held");
  expect(f.store.requireMember(member.id).status).toBe("blocked");
  expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "held", holdReason: "blocked", attempts: 0 });
  expect(f.count("terminal.send")).toBe(0);
  expect(f.store.listDispatches(member.id)).toHaveLength(0);
  f.terminals.get(f.store.requireMember(member.id).paneId!)!.status = { state: "idle", app: "claude-code" };
  await until(() => f.store.requireDelivery(d.id).status === "delivered");
  expect(f.count("terminal.send")).toBe(1);
  expect(f.store.requireMember(member.id).status).not.toBe("blocked");
});

test("a turn end dropped while the member was closing is replayed from the next observation, never by elapsed time", async () => {
  const f = await fixture(), member = await f.orch.createMember(f.project.id, { name: "Worker" });
  const internal = f.orch as unknown as { runtime(id: string): { closing: boolean; turn: unknown }; probeHealth(): Promise<void> };
  f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "report", text: "첫 일", wake: true });
  await f.orch.pump(member.id);
  expect(f.count("terminal.send")).toBe(1);
  // Same turn, still working: nothing to replay however long it takes.
  await internal.probeHealth();
  expect(f.store.listPendingExecutions()).toHaveLength(1);
  const first = f.store.listPendingExecutions()[0]!;
  // A refused stop holds the member in closing; core events arriving meanwhile are dropped and never repeated.
  const emitted: RunnerEvent[] = []; f.runner.on(event => { emitted.push(event); });
  internal.runtime(member.id).closing = true;
  const terminal = f.terminals.get(member.paneId!)!;
  terminal.status = { state: "idle" }; terminal.turn = 1;
  // Both the turn end and the (debounced) idle status that follows it must have been emitted, and so dropped.
  await until(() => emitted.some(e => e.type === "turn_end" && e.turn === 1) && emitted.some(e => e.type === "status" && e.status === "idle" && e.turn === 1) && !f.runner.isBusy(member.id));
  internal.runtime(member.id).closing = false;
  expect(f.store.listPendingExecutions()).toHaveLength(1);
  expect(internal.runtime(member.id).turn).not.toBeNull();
  const next = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "report", text: "다음 일", wake: true });
  await f.orch.pump(member.id);
  expect(f.count("terminal.send")).toBe(1);
  await internal.probeHealth();
  await until(() => f.store.requireDelivery(next.id).status === "delivered");
  expect(f.count("terminal.send")).toBe(2);
  expect(f.store.getExecutionJournal(first.runId)).toMatchObject({ phase: "ended", result: "success", turn: 1, reason: "재관측으로 놓친 턴 종료를 확인했습니다" });
});

test("an unknown stop is finished by recovery even though a wake arrived meanwhile, and that wake reopens the member", async () => {
  const f = await fixture(), member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.loseKill(true);
  await expect(f.orch.sleepMember(member.id)).rejects.toThrow();
  expect(f.store.listPendingLifecycleJournals()[0]).toMatchObject({ intent: "sleep", phase: "unknown" });
  // The open journal fences the pump; the queued wake used to make every recovery attempt refuse ("대기열이 남아 있습니다").
  const d = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "report", text: "잠드는 사이 온 보고", wake: true });
  await f.orch.pump(member.id);
  expect(f.count("terminal.send")).toBe(0);
  f.loseKill(false);
  await (f.orch as unknown as { probeHealth(): Promise<void> }).probeHealth();
  await until(() => f.store.requireDelivery(d.id).status === "delivered");
  expect(f.store.listPendingLifecycleJournals()).toHaveLength(0);
  expect(f.count("terminal.run")).toBe(2);
  expect(f.count("terminal.send")).toBe(1);
  expect(f.store.requireMember(member.id)).toMatchObject({ sessionId: member.sessionId, lastError: null });
});

// x-restart-2: core 에서는 영수증 없는 쓰기가 영원히 '미해결'이라, 전송 중 재시작 한 번이 그 직원의 대기열을 영영 막았다.
async function lostWrite(turnMoved: boolean) {
  const f = await fixture();
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.unknownSend();
  await f.orch.assign(f.project.id, member.handle, { text: "들어가지 못한 지시" });
  const delivery = f.store.listDeliveries(f.project.id).find(d => d.kind === "instruction")!;
  expect(f.store.listDispatches(member.id)[0]).toMatchObject({ transportState: "unknown", baseline: { turn: 0, logs: [{ offset: expect.any(Number), eventId: null }] } });
  expect(f.store.listDispatches(member.id)[0]!.baseline.logs[0]!.offset).toBeGreaterThan(0);
  await f.orch.shutdown(); f.unknownSend(false);
  if (turnMoved) f.terminals.get(member.paneId!)!.turn = 3;
  const next = f.orchestrator({ writeSettleMs: 0 }, true);
  await next.orch.recover();
  return { f, member, delivery, next };
}
const tickUntil = async (orch: Orchestrator, done: () => boolean, limitMs = 8000) => {
  for (const started = Date.now(); !done() && Date.now() - started < limitMs;) { await orch.deliveryRecovery.tick(); await Bun.sleep(50); }
  expect(done()).toBe(true);
};

test("a write that never landed (restart mid-send) is proven absent after the restart and sent again without the owner", async () => {
  const { f, member, delivery, next } = await lostWrite(false);
  expect(next.orch.deliveryRecovery.fenced(member.id)).toBe(true);
  await tickUntil(next.orch, () => f.store.requireDelivery(delivery.id).status === "delivered");
  expect(f.count("terminal.send")).toBe(2);
  expect(f.store.getDeliveryRecovery(delivery.id)?.phase).toBe("resolved");
  expect(f.store.inputState(member.id).unresolvedDispatches).toHaveLength(0);
  expect(next.orch.deliveryRecovery.fenced(member.id)).toBe(false);
}, 20_000);

// review runner-recovery-1: 두 건 이상 묶인 봉투는 항목이 따로 확인되면서 수신 확인이 굳어 자동 재전송이 끝내 나가지 않았다.
test("a two-item envelope that never landed is sent again as one envelope", async () => {
  const f = await fixture();
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.unknownSend();
  const memo = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "system", text: "[시스템] 함께 나가는 메모", wake: false });
  await f.orch.assign(f.project.id, member.handle, { text: "들어가지 못한 지시" });
  const instruction = f.store.listDeliveries(f.project.id).find(d => d.kind === "instruction")!;
  expect(f.store.listDispatches(member.id).map(d => [d.transportState, d.items.length])).toEqual([["unknown", 2]]);
  await f.orch.shutdown(); f.unknownSend(false);
  const next = f.orchestrator({ writeSettleMs: 0 }, true);
  await next.orch.recover();
  await tickUntil(next.orch, () => [memo, instruction].every(d => f.store.requireDelivery(d.id).status === "delivered"));
  expect(f.count("terminal.send")).toBe(2);
  expect(f.store.listDispatches(member.id).map(d => d.items.length)).toEqual([2, 2]);
  expect(next.orch.deliveryRecovery.fenced(member.id)).toBe(false);
}, 20_000);

// review orchestrator-1: 동시 턴 자리가 없어 재전송이 미뤄지는 동안 확인할 때마다 쓰지 못한 봉투가 하나씩 쌓였다.
test("while the turn cap is full a pending resend leaves no extra envelope, and goes out once a slot frees", async () => {
  const f = await fixture();
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  const other = await f.orch.createMember(f.project.id, { name: "Other" });
  f.unknownSend();
  await f.orch.assign(f.project.id, member.handle, { text: "들어가지 못한 지시" });
  const delivery = f.store.listDeliveries(f.project.id).find(d => d.kind === "instruction")!;
  await f.orch.shutdown(); f.unknownSend(false);
  // 다른 직원이 일하는 중이라 하나뿐인 자리가 찼다.
  f.store.patchSettings({ maxConcurrentTurns: 1 });
  const at = new Date().toISOString(), busy = f.store.requireMember(other.id);
  const run = { runId: crypto.randomUUID(), memberId: busy.id, projectId: busy.projectId, identity: { terminalId: busy.paneId, sessionId: busy.sessionId, sessionGeneration: f.store.memberRevisions(busy.id).sessionGeneration, process: null },
    turn: 0, deliveryIds: [], phase: "running" as const, inputReceivedAt: at, startedAt: at, lastProgressAt: at, endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at };
  f.store.saveExecutionJournal(run);
  const next = f.orchestrator({ writeSettleMs: 0 }, true);
  await next.orch.recover();
  await tickUntil(next.orch, () => f.store.getDeliveryRecovery(delivery.id)?.phase === "waiting" && f.store.getDeliveryRecovery(delivery.id)?.reason === "busy");
  expect(f.store.listDispatches(member.id).map(d => d.transportState)).toEqual(["accepted"]);
  expect(f.count("terminal.send")).toBe(1);
  // 자리가 나면 한 번만 다시 나간다. 이 직원 자신의 끝난 쓰기는 자리를 차지하지 않는다.
  const ended = new Date().toISOString();
  f.store.saveExecutionJournal({ ...run, phase: "ended", result: "success", endedAt: ended, updatedAt: ended });
  await tickUntil(next.orch, () => f.store.requireDelivery(delivery.id).status === "delivered");
  expect(f.count("terminal.send")).toBe(2);
  expect(f.store.listDispatches(member.id).map(d => d.transportState)).toEqual(["accepted", "accepted"]);
}, 30_000);

test("when the CLI moved on since the send nothing is re-sent on its own, but '그만 보내기' really releases the member", async () => {
  const { f, member, delivery, next } = await lostWrite(true);
  for (let i = 0; i < 3; i++) { await next.orch.deliveryRecovery.tick(); await Bun.sleep(20); }
  expect(f.count("terminal.send")).toBe(1);
  expect(next.orch.deliveryRecovery.fenced(member.id)).toBe(true);
  await next.orch.recoverDelivery(delivery.id, { operationId: crypto.randomUUID(), expectedVersion: f.store.getDeliveryRecovery(delivery.id)!.version, action: "stop_retry" });
  expect(next.orch.deliveryRecovery.fenced(member.id)).toBe(false);
  expect(f.store.inputState(member.id).unresolvedDispatches).toHaveLength(0);
  await next.orch.assign(f.project.id, member.handle, { text: "그 뒤의 지시" });
  const later = f.store.listDeliveries(f.project.id).filter(d => d.kind === "instruction").at(-1)!;
  await until(() => f.store.requireDelivery(later.id).status === "delivered");
  expect(f.calls.filter(c => c.method === "terminal.send").at(-1)!.params.text).toContain("그 뒤의 지시");
}, 20_000);

test("'중복 위험에 동의하고 다시 보내기' actually sends once the original write is over", async () => {
  const { f, member, delivery, next } = await lostWrite(true);
  await next.orch.deliveryRecovery.tick();
  const before = f.store.getDeliveryRecovery(delivery.id)!;
  f.store.updateDeliveryRecovery(delivery.id, before.version, { phase: "needs_owner", reason: "log_incomplete" });
  const result = await next.orch.recoverDelivery(delivery.id, { operationId: crypto.randomUUID(), expectedVersion: f.store.getDeliveryRecovery(delivery.id)!.version, action: "retry_with_risk", acceptDuplicateRisk: true });
  expect(result.outcome).toBe("retry_scheduled");
  await tickUntil(next.orch, () => f.store.requireDelivery(delivery.id).status === "delivered");
  expect(f.count("terminal.send")).toBe(2);
  expect(next.orch.deliveryRecovery.fenced(member.id)).toBe(false);
}, 20_000);

test("while the original send call may still be running its write stays unresolved", async () => {
  const f = await fixture();
  const live = f.orchestrator({ writeSettleMs: 60_000 }, true);
  await f.orch.shutdown();
  const member = await live.orch.createMember(f.project.id, { name: "Worker" });
  f.unknownSend();
  await live.orch.assign(f.project.id, member.handle, { text: "결과를 모르는 지시" });
  f.unknownSend(false);
  const dispatch = f.store.listDispatches(member.id)[0]!;
  expect(live.orch.dispatchQuiescence(member.id, dispatch)).toEqual({ originalWrite: "unresolved", externalInput: null });
  for (let i = 0; i < 3; i++) { await live.orch.deliveryRecovery.tick(); await Bun.sleep(20); }
  expect(f.count("terminal.send")).toBe(1);
  expect(live.orch.deliveryRecovery.fenced(member.id)).toBe(true);
});

// mem-growth-9: 닫은 직원의 토큰이 든 MCP 설정 파일이 데이터 폴더에 계속 남았다.
test("closing a member removes its run files", async () => {
  const f = await fixture(), member = await f.orch.createMember(f.project.id, { name: "Worker" });
  const run = join(f.config.home, "run");
  expect(existsSync(join(run, `${member.id}.mcp.json`))).toBe(true);
  await f.orch.closeMember(member.id);
  expect(f.store.getMember(member.id)).toBeNull();
  expect(readdirSync(run).filter(name => name.startsWith(member.id))).toEqual([]);
});

// runner-core-1 인계: 응답을 잃은 전송이 실제로는 들어갔고 그 턴이 이미 끝났다. 수신이 확인되면 다시 시작하지 않아도 다음 지시가 나가야 한다.
for (const restart of [false, true]) test(`a send whose reply was lost but that the CLI received is confirmed from its log and the next instruction goes out (${restart ? "after a restart" : "same process"})`, async () => {
  const f = await fixture();
  const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  f.unknownSend();
  await f.orch.assign(f.project.id, member.handle, { text: "응답만 잃은 지시" });
  f.unknownSend(false);
  const first = f.store.listDeliveries(f.project.id).find(d => d.kind === "instruction")!;
  const dispatch = f.store.listDispatches(member.id)[0]!;
  expect(dispatch.transportState).toBe("unknown");
  // CLI 는 그 글을 받아 턴을 마쳤다.
  const terminal = f.terminals.get(member.paneId!)!;
  const log = f.calls.find(c => c.method === "terminal.run")!;
  const path = transcriptPath(log.params.cwd!, member.sessionId!, f.claudeHome);
  writeFileSync(path, JSON.stringify({ type: "user", sessionId: member.sessionId, cwd: log.params.cwd, uuid: "received", message: { role: "user", content: dispatch.wireText } }) + "\n", { flag: "a" });
  terminal.turn = 1; terminal.status = { state: "idle" };
  let orch = f.orch;
  if (restart) { await f.orch.shutdown(); orch = f.orchestrator().orch; await orch.recover(); }
  await tickUntil(orch, () => f.store.requireDelivery(first.id).status === "delivered");
  await orch.refreshConnection();
  await orch.assign(f.project.id, member.handle, { text: "그 다음 지시" });
  const second = f.store.listDeliveries(f.project.id).filter(d => d.kind === "instruction").at(-1)!;
  await until(() => f.store.requireDelivery(second.id).status === "delivered");
  expect(f.count("terminal.send")).toBe(2);
}, 20_000);
