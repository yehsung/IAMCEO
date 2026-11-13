import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer, type Socket } from "node:net";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { coreCompactStore, Orchestrator } from "../server/orchestrator.ts";
import { CoreRunner } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import type { Backend } from "../shared/types.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { rejection } from "./fixtures/settle.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
async function until(condition: () => boolean) {
  for (let i = 0; i < 300; i++) { if (condition()) return; await Bun.sleep(5); }
  expect(condition()).toBe(true);
}

class FakeCore implements Runner {
  readonly kind = "core" as const;
  callback: (e: RunnerEvent) => void = () => {};
  sent: string[] = [];
  compacted: string[] = [];
  busy = false;
  failure: SendResult | null = null;
  constructor(readonly store: Store) {}
  async available() { return { ok: true }; }
  async start(): Promise<never> { throw new Error("This fixture must never start a CLI"); }
  async send(_m: RunnerMember, text: string): Promise<SendResult> { this.sent.push(text); return { ok: true }; }
  async compact(m: RunnerMember, focus: string): Promise<SendResult> {
    this.compacted.push(focus);
    if (this.failure) return this.failure;
    const state = this.store.ensureContextState(m.id);
    this.store.saveContextState({ ...state, measurement: null, compaction: { ...state.compaction!, phase: "running" } }, { contextPct: null });
    return { ok: true, started: false };
  }
  isBusy() { return this.busy; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop() {}
  async screen() { return ""; }
  on(callback: (e: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
}

function fixture() {
  const runtime = createIsolatedRuntime();
  const env = runtime.childEnv();
  updateConfigFile({ accessCode: "test", hosts: ["127.0.0.1"], claudeBin: runtime.bins.claudeBin }, env);
  const config = loadConfig(env);
  const db = openDb(config.dbPath), store = new Store(db, new Bus());
  const fake = new FakeCore(store);
  const runners = new Map<Backend, Runner>([["core", fake]]);
  const makeOrch = () => new Orchestrator({ config, store, runners, providerHomes: runtime.providerHomes,
    timings: { tickMs: 60_000, healthMs: 60_000, compactTimeoutMs: 30, retryMs: 5 } });
  const orch = makeOrch();
  const project = store.createProject({ name: "문맥", cwd: runtime.paths.work, runnerEnabled: true });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker", origin: "runner", backend: "core", status: "idle", paneId: "terminal", sessionId: "native" });
  store.ensureContextState(member.id);
  const emit = async (e: RunnerEvent) => { fake.callback(e); await Bun.sleep(2); };
  const usage = (turn = 1, exact = true, tokens = 700_000): RunnerEvent => ({ type: "context_usage", memberId: member.id, sessionId: member.sessionId!, sessionGeneration: store.memberRevisions(member.id).sessionGeneration,
    terminalId: member.paneId, turn, tokens, shownPct: null, model: "model", ...(exact ? { exact: { window: 1_000_000, source: "statusline" as const } } : {}) });
  const end = async (turn = 1) => emit({ type: "turn_end", memberId: member.id, terminalId: member.paneId, turn, finalText: "", isError: false });
  const wake = (urgent = false) => store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: "다음 일", urgent });
  cleanups.push(async () => { await orch.shutdown(); db.close(); await runtime.stop(); });
  return { runtime, config, db, store, fake, orch, makeOrch, project, member, emit, usage, end, wake };
}

describe("core 자동 압축의 업무 경계", () => {
  test("fresh exact와 완료 턴, 실제 wake, 기준과 같은 값에서 한 번; ACK/turn_end는 완료가 아니다", async () => {
    const f = fixture();
    await f.emit(f.usage()); await f.end();
    await f.orch.pump(f.member.id);
    expect(f.fake.compacted).toHaveLength(0);
    f.wake(); await f.orch.pump(f.member.id);
    expect(f.fake.compacted).toHaveLength(1);
    expect(f.fake.sent).toHaveLength(0);
    expect(f.store.requireMember(f.member.id).contextState?.compaction?.phase).toBe("running");
    await f.end(2); f.wake(true); await f.orch.pump(f.member.id);
    expect(f.fake.sent).toHaveLength(0);
    const state = f.store.ensureContextState(f.member.id);
    f.store.saveContextState({ ...state, compaction: { ...state.compaction!, phase: "succeeded" } });
    await f.emit(f.usage(2, true, 240_000));
    await f.emit({ type: "compacted", memberId: f.member.id, runId: state.compaction!.id });
    await until(() => f.fake.sent.length === 1);
    expect(f.fake.compacted).toHaveLength(1);
    expect(f.store.requireMember(f.member.id).contextPct).toBe(24);
    await f.emit({ type: "compacted", memberId: f.member.id, runId: state.compaction!.id });
    expect(f.store.listActivity(f.member.id).filter(a => a.text === "압축 완료")).toHaveLength(1);
  });

  test("추정·이전 턴·모델 변경·0%는 일반 업무를 막지 않고 auto를 건너뛴다", async () => {
    for (const mode of ["estimated", "old_turn", "config", "zero"] as const) {
      const f = fixture();
      await f.emit(f.usage(1, mode !== "estimated", mode === "zero" ? 0 : 700_000));
      await f.end(mode === "old_turn" ? 2 : 1);
      if (mode === "config") f.store.patchMember(f.member.id, { modelOverride: "new-model" });
      f.wake(); await f.orch.pump(f.member.id);
      expect(f.fake.compacted).toHaveLength(0);
      expect(f.fake.sent).toHaveLength(1);
    }
  });

  test("working 수동 예약은 중복 접수를 합치고 원래 턴을 끊지 않는다", async () => {
    const f = fixture(); f.fake.busy = true;
    f.store.patchMember(f.member.id, { status: "working" });
    const first = await f.orch.compactMember(f.member.id, " 초점\n 다음 ");
    const second = await f.orch.compactMember(f.member.id, "다른 초점");
    expect(first.contextState?.compaction?.id).toBe(second.contextState?.compaction?.id);
    expect(first.contextState?.compaction).toMatchObject({ phase: "queued", trigger: "manual", reason: "working" });
    expect(f.fake.compacted).toHaveLength(0);
    f.fake.busy = false; await f.end();
    await until(() => f.fake.compacted.length === 1);
    expect(f.fake.compacted[0]).toBe("초점 다음");
  });

  test("queued 재시작 복원, lease/draft/blocked 보류; 확정 실패 뒤 업무는 진행한다", async () => {
    const f = fixture();
    f.fake.busy = true;
    await f.orch.compactMember(f.member.id);
    await f.orch.shutdown();
    const orch = f.makeOrch(); cleanups.push(() => orch.shutdown());
    f.fake.busy = false;
    f.fake.failure = { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written" };
    await orch.pump(f.member.id);
    expect(f.store.requireMember(f.member.id).contextState?.compaction).toMatchObject({ phase: "queued", reason: "draft" });
    f.store.patchMember(f.member.id, { status: "blocked" });
    const attempts = f.fake.compacted.length; await orch.pump(f.member.id);
    expect(f.fake.compacted).toHaveLength(attempts);
    f.store.patchMember(f.member.id, { status: "idle" });
    f.fake.failure = { ok: false, reason: "error", retryable: false, deliveryEffect: "not_written" };
    f.wake(); await Bun.sleep(10); await orch.pump(f.member.id);
    await until(() => f.fake.sent.length === 1);
    expect(f.store.requireMember(f.member.id).contextState?.compaction?.phase).toBe("failed");
  });

  test("lease 중 수동 예약은 입력 없이 보류하고 release 뒤 재검사한다", async () => {
    const f = fixture();
    const lease = { memberId: f.member.id, claimId: "claim", leaseId: "lease", expiresAt: Date.now() + 60_000, lastInputSequence: 0,
      identity: { terminalId: f.member.paneId, sessionId: f.member.sessionId, sessionGeneration: f.store.memberRevisions(f.member.id).sessionGeneration, process: null } };
    f.store.saveLease(lease);
    expect((await f.orch.compactMember(f.member.id)).contextState?.compaction).toMatchObject({ phase: "queued", reason: "manual_control" });
    f.wake(true); await f.orch.pump(f.member.id);
    expect(f.fake.compacted).toHaveLength(0); expect(f.fake.sent).toHaveLength(0);
    f.store.removeLease(f.member.id, lease.claimId); await f.orch.pump(f.member.id);
    expect(f.fake.compacted).toHaveLength(1); expect(f.fake.sent).toHaveLength(0);
  });

  test("timeout과 응답 유실은 영속 uncertain으로 일반/urgent/후속 압축을 막는다", async () => {
    for (const lost of [false, true]) {
      const f = fixture();
      if (lost) f.fake.failure = { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" };
      await f.orch.compactMember(f.member.id);
      await until(() => f.store.getContextState(f.member.id)?.compaction?.phase === "uncertain");
      f.wake(true); await f.orch.pump(f.member.id); await f.orch.compactMember(f.member.id);
      expect(f.fake.compacted).toHaveLength(1); expect(f.fake.sent).toHaveLength(0);
      await f.orch.shutdown(); const orch = f.makeOrch(); cleanups.push(() => orch.shutdown());
      await orch.pump(f.member.id);
      expect(f.fake.compacted).toHaveLength(1); expect(f.fake.sent).toHaveLength(0);
    }
  });

  test("CLI 내장 compact boundary가 있으면 같은 완료 턴의 auto를 중복 예약하지 않는다", async () => {
    const f = fixture();
    const path = transcriptPath(f.member.cwd, f.member.sessionId!, f.runtime.paths.claudeHome);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "{}\n");
    await f.emit(f.usage(1)); await f.end(1);
    writeFileSync(path, JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId: f.member.sessionId, cwd: f.member.cwd }) + "\n", { flag: "a" });
    await f.emit(f.usage(2)); await f.end(2); f.wake(); await f.orch.pump(f.member.id);
    expect(f.fake.compacted).toHaveLength(0); expect(f.fake.sent).toHaveLength(1);
  });

  test("확인된 sleep/중단은 압축을 failed/interrupted로 닫고 늦은 timeout은 결과를 바꾸지 않는다", async () => {
    for (const action of ["sleep", "interrupt", "gone"] as const) {
      const f = fixture(); await f.orch.compactMember(f.member.id);
      if (action === "sleep") await f.orch.sleepMember(f.member.id, { force: true });
      else if (action === "interrupt") await f.orch.memberInterrupt(f.member.id);
      else await f.emit({ type: "status", memberId: f.member.id, status: "gone" });
      expect(f.store.getContextState(f.member.id)?.compaction).toMatchObject({ phase: "failed", reason: "interrupted" });
      await Bun.sleep(40);
      expect(f.store.getContextState(f.member.id)?.compaction?.phase).toBe("failed");
      expect(f.fake.compacted).toHaveLength(1); expect(f.fake.sent).toHaveLength(0);
    }
  });
});

describe("실제 CoreRunner와 Store 압축 포트", () => {
  test("외부 입력 전 sending 저장, slash 단독 송신, 새 boundary와 settled로만 성공, 재시작 재송신 0회", async () => {
    const f = fixture(); await f.orch.shutdown();
    const sockets = new Set<Socket>(), terminals = new Map<string, CoreTerminal>();
    const sends: Record<string, unknown>[] = [];
    let persistedBeforeInput = false;
    const server = createServer(socket => {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
          const { method, params } = request;
          let result: unknown;
          if (method === "hello") result = { generation: 1, version: "fixture", methods: ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill"] };
          if (method === "terminal.run") {
            result = { address: "terminal", argv: params.argv, labels: params.labels, cwd: params.cwd, turn: 0, state: "live", status: { state: "idle" } };
            terminals.set("terminal", result as CoreTerminal);
          }
          if (method === "terminal.list") result = { terminals: [...terminals.values()] };
          if (method === "terminal.get") result = terminals.get("terminal");
          if (method === "terminal.kill") { terminals.get("terminal")!.state = "finished"; result = terminals.get("terminal"); }
          if (method === "terminal.read") result = { text: `output\n${"─".repeat(30)}\n❯ \n${"─".repeat(30)}\n` };
          if (method === "terminal.send") {
            persistedBeforeInput = f.store.getContextState(f.member.id)?.compaction?.phase === "sending";
            sends.push(params); result = { turn: 0, started: false };
          }
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
        }
      });
    });
    await new Promise<void>(resolve => server.listen(f.runtime.socketPath, resolve));
    const runners: CoreRunner[] = [];
    cleanups.push(async () => { for (const runner of runners) await runner.shutdown(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const options = f.runtime.runnerOptions(f.runtime.providerHomes);
    const deps = { compactStore: coreCompactStore(f.store), pollMs: 10, rpcTimeoutMs: 100, compactTimeoutMs: 30 };
    const runner = new CoreRunner(options, deps); runners.push(runner);
    const model = f.store.getSettings().ranks.lead.model;
    const member: RunnerMember = { ...f.member, model, effort: null, subagentModel: null, permissionMode: "default", sessionGeneration: f.store.memberRevisions(f.member.id).sessionGeneration };
    const opts = { systemPromptFile: join(f.runtime.paths.work, "rules"), mcpConfigFile: join(f.runtime.paths.work, "mcp"), resume: true };
    writeFileSync(opts.systemPromptFile, "test"); writeFileSync(opts.mcpConfigFile, "{}");
    await runner.start(member, opts);
    const path = transcriptPath(member.cwd, member.sessionId!, f.runtime.paths.claudeHome);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "{}\n");
    expect(await runner.compact(member, "초점\n다음", opts)).toMatchObject({ ok: true, started: false });
    expect(persistedBeforeInput).toBe(true);
    expect(sends).toMatchObject([{ text: "/compact 초점 다음", if: "idle", force: false, wait: false }]);
    await until(() => f.store.getContextState(member.id)?.compaction?.phase === "uncertain");
    await runner.shutdown();
    const recovered = new CoreRunner(options, deps); runners.push(recovered);
    const events: RunnerEvent[] = []; recovered.on(e => events.push(e));
    await recovered.start(member, opts);
    expect(await recovered.send(member, "금지", opts)).toMatchObject({ ok: false, reason: "busy" });
    expect(sends).toHaveLength(1);
    writeFileSync(path, JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId: member.sessionId, cwd: member.cwd }) + "\n", { flag: "a" });
    terminals.get("terminal")!.status = { state: "working" };
    await Bun.sleep(25); expect(events.some(e => e.type === "compacted")).toBe(false);
    terminals.get("terminal")!.status = { state: "idle" };
    await until(() => f.store.getContextState(member.id)?.compaction?.phase === "succeeded");
    expect(events.filter(e => e.type === "compacted")).toHaveLength(1);
    expect(f.store.requireMember(member.id).contextPct).toBeNull();
    // 같은 실제 Runner를 Orchestrator의 공개 수동 예약/장벽까지 연결한다.
    const settings = f.store.getSettings();
    f.store.setAppliedConfig(member.id, { model, effort: settings.ranks.lead.effort, staffModel: settings.ranks.staff.model, staffEffort: settings.ranks.staff.effort });
    const orch = new Orchestrator({ config: f.config, store: f.store, runners: new Map([["core", recovered]]), providerHomes: f.runtime.providerHomes,
      timings: { compactTimeoutMs: 1000 } });
    cleanups.push(() => orch.shutdown());
    const accepted = await orch.compactMember(member.id, "실제 연결");
    expect(accepted.contextState?.compaction?.phase).toBe("running");
    expect(sends).toHaveLength(2);
    expect(await rejection(orch.patchProject(f.project.id, { archived: true }))).toMatchObject({ status: 409 });
    writeFileSync(path, JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId: member.sessionId, cwd: member.cwd }) + "\n", { flag: "a" });
    await until(() => f.store.listActivity(member.id).some(a => a.text === "압축 완료"));
    expect(f.store.requireMember(member.id).contextState?.compaction?.phase).toBe("succeeded");
    await orch.patchProject(f.project.id, { archived: true });
    expect(terminals.get("terminal")!.state).toBe("finished");
    expect(f.store.requireMember(member.id)).toMatchObject({ status: "asleep", sessionId: member.sessionId, paneId: null });
  });
});

describe("실제 Orchestrator MCP receipt", () => {
  test("인증된 HTTP bridge operation을 실제 Orchestrator receipt로 전달한다", async () => {
    const f = fixture();
    const member = f.store.createMember({ projectId: f.project.id, handle: "manual", name: "직접", kind: "worker", origin: "manual" });
    const server = await startServer({ config: f.config, store: f.store, bus: new Bus(), orch: f.orch });
    cleanups.push(() => server.stop());
    expect(server.port).not.toBe(7878);
    const body = { operationId: crypto.randomUUID(), name: "post", args: { kind: "완료", title: "HTTP 보고" } };
    const call = () => fetch(`${server.urls[0]}/agent/tool`, { method: "POST", headers: { Authorization: `Bearer ${f.store.getMemberToken(member.id)}`, "Content-Type": "application/json", "X-IAMCEO-Contract": "2" }, body: JSON.stringify(body) });
    const first = await call(), second = await call();
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(f.store.listMessages(f.project.id)).toHaveLength(1);
  });

  test("동일 ID 동시 호출/재시작은 효과 1회, 새 ID 같은 본문은 독립, 다른 요청은 409", async () => {
    const f = fixture();
    const member = f.store.createMember({ projectId: f.project.id, handle: "manual", name: "직접", kind: "worker", origin: "manual" });
    const args = { kind: "완료", title: "보고" }, context = { operationId: crypto.randomUUID() };
    const [first, second] = await Promise.all([f.orch.handleAgentOperation(member, "post", args, context), f.orch.handleAgentOperation(member, "post", args, context)]);
    expect(first).toEqual(second); expect(f.store.listMessages(f.project.id)).toHaveLength(1);
    await f.orch.shutdown(); const orch = f.makeOrch(); cleanups.push(() => orch.shutdown());
    expect(await orch.handleAgentOperation(member, "post", args, context)).toEqual(first);
    expect(f.store.listMessages(f.project.id)).toHaveLength(1);
    await orch.handleAgentOperation(member, "post", args, { operationId: crypto.randomUUID() });
    expect(f.store.listMessages(f.project.id)).toHaveLength(2);
    expect(await rejection(orch.handleAgentOperation(member, "post", { ...args, title: "다른 보고" }, context))).toMatchObject({ status: 409 });
    const unknownId = crypto.randomUUID();
    f.store.agentOperation(member.id, "post", unknownId, args, () => ({ text: "crash: unknown", isError: true }));
    expect(await orch.handleAgentOperation(member, "post", args, { operationId: unknownId })).toMatchObject({ text: "crash: unknown", isError: true });
    expect(f.store.listMessages(f.project.id)).toHaveLength(2);
  });
});
