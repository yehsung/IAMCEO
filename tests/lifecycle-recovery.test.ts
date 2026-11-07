import { afterEach, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Bus } from "../server/bus.ts";
import { ApiError, Store } from "../server/store.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { CoreRunner } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import type { RunnerEvent } from "../server/runner/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

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
async function fixture(healthMs = 60_000) {
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
  let keysLost = false;
  let sendStarted = true;
  let getUnavailable = false;
  let killLost = false;
  let rejectSend = false;
  let unknownSend = false;
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
        if (request.method === "terminal.run") {
          const created: CoreTerminal = { address: `t${terminals.size + 1}`, argv: request.params.argv!, cwd: request.params.cwd!, labels: request.params.labels!, state: "live", turn: 0, status: { state: "idle", app: "claude-code" } };
          terminals.set(created.address, created); result = created;
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
  function orchestrator() {
    const runner = new CoreRunner({ ...isolated.runnerOptions(isolated.providerHomes) }, { recoveryStore: store, pollMs: 20, rpcTimeoutMs: 100, sendTimeoutMs: 100 });
    const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs, retryMs: 10, inputBusyRetryMs: 10 } });
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
  return { ...current, store, bus, db, project, config, calls, terminals, runners, orchestrator,
    count: (method: string) => calls.filter(c => c.method === method).length,
    loseRun: (value: boolean) => { runLost = value; }, loseKeys: () => { keysLost = true; },
    loseKill: (value: boolean) => { killLost = value; }, unavailable: (value: boolean) => { getUnavailable = value; },
    rejectSend: (value: boolean) => { rejectSend = value; }, unknownSend: () => { unknownSend = true; },
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
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.assign(f.project.id, member.handle, { text: "Finish while away" });
  const run = f.store.listPendingExecutions()[0]!;
  await f.orch.shutdown();
  const terminal = f.terminals.get(member.paneId!)!;
  terminal.turn = 1; terminal.status = { state: "done" };
  const next = f.orchestrator(); await next.orch.recover();
  expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "ended", result: "success", interruptionNotifiedAt: null });
  expect(f.count("terminal.send")).toBe(1); expect(f.count("terminal.run")).toBe(1);
});

test("a write whose reply was lost settles from log receipt once a later turn is seen, then asks for the missing report", async () => {
  // Real 2026-11-07 run: kill -9 ~60ms after an owner message left dispatch write_started and the run in "starting".
  // Recovery proved receipt from the CLI log, but the run stayed "starting": member looked busy and the report the
  // worker could not post while the daemon was down was never requested.
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.assign(f.project.id, member.handle, { text: "Crash-window task" });
  const run = f.store.listPendingExecutions()[0]!;
  expect(f.store.getDispatch(run.runId)?.baseline.turn).toBe(0);
  f.store.saveExecutionJournal({ ...run, phase: "starting", inputReceivedAt: null, startedAt: null, turn: null });
  await f.orch.shutdown();
  const terminal = f.terminals.get(member.paneId!)!; terminal.turn = 1; terminal.status = { state: "done" };
  const next = f.orchestrator(); await next.orch.recover(); await next.orch.refreshConnection();
  expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "ended", result: "success" });
  expect(f.store.listPendingExecutions()).toHaveLength(0);
  expect(f.store.listPending(member.id).some(d => d.kind === "system" && d.text.includes("보고 보완"))).toBe(true);
  expect(f.count("terminal.send")).toBe(1); expect(f.count("terminal.interrupt")).toBe(0);
});

test("a recovered start with no later turn stays received and fenced; time alone never ends it", async () => {
  const f = await fixture(); const member = await f.orch.createMember(f.project.id, { name: "Worker" });
  await f.orch.assign(f.project.id, member.handle, { text: "Crash-window task, not yet counted" });
  const run = f.store.listPendingExecutions()[0]!;
  f.store.saveExecutionJournal({ ...run, phase: "starting", inputReceivedAt: null, startedAt: null, turn: null, createdAt: new Date(Date.now() - 60_000).toISOString() });
  await f.orch.shutdown();
  const terminal = f.terminals.get(member.paneId!)!; terminal.turn = 0; terminal.status = { state: "done" };
  const next = f.orchestrator(); await next.orch.recover(); await next.orch.refreshConnection();
  expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "received", turn: 0 });
  expect(f.store.listPendingExecutions()).toHaveLength(1);
  expect(f.count("terminal.send")).toBe(1);
});

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
  for (let n = 0; n < 3; n++) await f.orch.refreshConnection();
  unsubscribe();
  expect(f.count("terminal.get")).toBeGreaterThan(gets);
  expect(observations.length).toBeGreaterThan(0);
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
