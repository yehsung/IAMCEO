import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CoreRunner, codexDraft, ensureCoreServer, type CoreRunnerDeps, type CoreCompactState } from "../server/runner/core.ts";
import { CoreError, coreRpc, type CoreTerminal } from "../server/runner/core-client.ts";
import { DEFAULT_RANKS, memberConfig } from "../shared/types.ts";
import { providerLaunch } from "../server/runner/providers.ts";
import { createHash } from "node:crypto";
import type { DeliveryDispatch, RunnerRecoveryStore, TerminalLease } from "../server/service-contracts.ts";
import type { DeliveryRepair } from "../server/runner/types.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import type { RunnerEvent, RunnerMember, StartOpts } from "../server/runner/types.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Bus } from "../server/bus.ts";
import { Store } from "../server/store.ts";
import { Orchestrator } from "../server/orchestrator.ts";

const methods = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill", "terminal.keys"];
const composer = (draft = "") => `prior output\n${"─".repeat(30)}\n❯ ${draft}\n${"─".repeat(30)}\n`;
const member = (extra: Partial<RunnerMember> = {}): RunnerMember => ({ id: "member-one", sessionGeneration: 1, projectId: "project-one", cli: "claude", handle: "worker", name: "Worker", cwd: "/tmp", sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker", ...extra });
interface Request { jsonrpc: string; id: string; method: string; params: Record<string, any> }
const fixtures: { dir: string; server: Server; sockets: Set<Socket>; runners: CoreRunner[] }[] = [];
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-core-test-"));
  const socketPath = join(dir, "c.sock");
  const opts: StartOpts = { systemPromptFile: join(dir, "rules.md"), mcpConfigFile: join(dir, "mcp.json"), resume: false, projectName: "Test" };
  writeFileSync(opts.systemPromptFile, "IAMCEO test instructions\nKeep user tools.");
  writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: ["bridge", "a'b"], env: { IAMCEO_TOKEN: "secret", IAMCEO_URL: "http://localhost:1" } } } }));
  const calls: Request[] = [];
  const terminals = new Map<string, CoreTerminal>();
  let screen = composer();
  let hook: ((request: Request, socket: Socket) => boolean) | null = null;
  const sockets = new Set<Socket>();
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
        else if (request.method === "terminal.list") result = { terminals: [...terminals.values()].filter((terminal) => Object.entries(params.labels || {}).every(([key, value]) => terminal.labels[key] === value)) };
        else if (request.method === "terminal.run") {
          const terminal: CoreTerminal = { address: `t${terminals.size + 1}`, argv: params.argv, cwd: params.cwd, labels: params.labels, state: "live", turn: 0, status: { state: "idle", app: "claude-code" }, reported: true };
          terminals.set(terminal.address, terminal); result = terminal;
        } else if (request.method === "terminal.get") result = terminals.get(params.terminal);
        else if (request.method === "terminal.read") result = { text: screen, complete: true, how: "screen" };
        else if (request.method === "terminal.send") {
          const terminal = terminals.get(params.terminal)!;
          if (params.if && terminal.status?.state !== params.if) {
            socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "status changed", data: { kind: "status_mismatch" } } }) + "\n"); continue;
          }
          result = { turn: terminal.turn, started: true, status: "idle" }; terminal.status = { state: "working" };
        } else if (request.method === "terminal.keys") result = { status: "blocked", turn: 0 };
        else if (request.method === "terminal.interrupt") result = { outcome: "stopped", key: "esc" };
        else if (request.method === "terminal.kill") { const terminal = terminals.get(params.terminal)!; terminal.state = "finished"; result = terminal; }
        if (result === undefined) socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "no terminal", data: { kind: "not_found" } } }) + "\n");
        else socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const runners: CoreRunner[] = [];
  fixtures.push({ dir, server, sockets, runners });
  return { dir, socketPath, opts, terminals, calls, setScreen(value: string) { screen = value; }, setHook(value: typeof hook) { hook = value; }, runner(pollMs = 20, deps: CoreRunnerDeps = {}) { const runner = new CoreRunner({ socketPath, claudeBin: "/fake/claude", codexBin: "/fake/codex", claudeHome: join(dir, "claude-home"), codexHome: join(dir, "codex-home"), contextHome: dir }, { pollMs, rpcTimeoutMs: 100, sendTimeoutMs: 150, ...deps }); runners.push(runner); return runner; } };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await Promise.all(f.runners.map((runner) => runner.shutdown())); for (const socket of f.sockets) socket.destroy(); await new Promise<void>((resolve) => f.server.close(() => resolve())); rmSync(f.dir, { recursive: true, force: true }); } });
const until = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(10); expect(predicate()).toBe(true); };

const trustScreen = (cwd = "/tmp", selected = 0) => ` Accessing workspace:\n ${cwd}\n Quick safety check: Is this a project you created or one you trust?\n ${selected === 0 ? "❯" : " "} No, exit\n ${selected === 1 ? "❯" : " "} Yes, I trust this folder\n Enter to confirm · Esc to cancel\n`;
describe("core Claude folder trust approval", () => {
  test("real orchestrator and supervisor keep folder trust evidence through reconnect and clear it on unknown screens", async () => {
    const f = await fixture(); const runner = f.runner();
    const config = loadConfig({ IAMCEO_HOME: join(f.dir, "iamceo"), IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: f.socketPath,
      IAMCEO_CLAUDE_BIN: "/fake/claude", IAMCEO_CODEX_BIN: "/fake/codex", IAMCEO_CORE_BIN: "/usr/bin/false" });
    const db = openDb(config.dbPath); const store = new Store(db, new Bus());
    const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]),
      providerHomes: { claudeHome: join(f.dir, "claude-home"), codexHome: join(f.dir, "codex-home") }, timings: { healthMs: 1, tickMs: 60000 } });
    try {
      const project = store.createProject({ name: "신뢰", cwd: f.dir });
      const m = await orch.createMember(project.id, { name: "worker" });
      f.terminals.get(m.paneId!)!.status = null; f.setScreen(trustScreen(f.dir));
      await until(() => store.requireMember(m.id).statusObservation?.error?.code === "folder_trust");
      expect(store.requireMember(m.id).blockedReason).toBe("setup");
      await orch.refreshConnection();
      expect(store.requireMember(m.id).statusObservation).toMatchObject({ freshness: "fresh", ownership: "verified", error: { code: "folder_trust" } });
      store.patchMember(m.id, { statusObservation: { source: "core", observedAt: null, freshness: "stale", ownership: "unknown", consecutiveFailures: 1, error: { code: "timeout", note: "재연결 중" } } });
      await Bun.sleep(5); await orch.refreshConnection();
      expect(store.requireMember(m.id).statusObservation).toMatchObject({ freshness: "fresh", error: { code: "folder_trust" } });
      expect((await orch.memberApproval(m.id))?.title).toBe("폴더 신뢰 확인");
      f.setScreen("An unknown setup screen"); await Bun.sleep(5); await orch.refreshConnection();
      expect(store.requireMember(m.id)).toMatchObject({ status: "blocked", blockedReason: "status_unknown", statusObservation: { error: null } });
      expect(await orch.memberApproval(m.id)).toBeNull();
      expect(f.calls.some(r => r.method === "terminal.keys")).toBe(false);
    } finally { await orch.shutdown(); db.close(); }
  });
  async function trust(cli: "claude" | "codex" = "claude") {
    const f = await fixture(); const runner = f.runner(10000); const m = member({ cli });
    const started = await runner.start(m, f.opts); const terminal = f.terminals.get(started.paneId)!;
    terminal.status = null; f.setScreen(trustScreen());
    return { f, runner, m, terminal };
  }
  test("unknown → setup/folder_trust → unknown updates evidence even while status stays blocked", async () => {
    const { f, runner, m } = await trust(); const events: RunnerEvent[] = []; runner.on((e) => events.push(e));
    f.setScreen("An unknown setup dialog"); expect(await runner.approval(m)).toBeNull();
    expect(events.at(-1)).toMatchObject({ status: "blocked", blockedReason: "status_unknown", observation: { error: null } });
    f.setScreen(trustScreen()); const prompt = await runner.approval(m);
    expect(prompt).toMatchObject({ title: "폴더 신뢰 확인", body: "/tmp\n이 폴더에서 AI가 파일을 읽고 고치고 실행할 수 있게 됩니다",
      options: [{ n: 1, label: "No, exit", reject: true }, { n: 2, label: "Yes, I trust this folder", reject: false }] });
    expect(events.at(-1)).toMatchObject({ status: "blocked", blockedReason: "setup", observation: { source: "core", freshness: "fresh", ownership: "verified", error: { code: "folder_trust", note: "폴더 신뢰 확인 창에서 멈췄습니다: /tmp" } } });
    expect(prompt!.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect((await runner.approval(m))?.fingerprint).toBe(prompt!.fingerprint);
    f.setScreen("Not a trust screen"); expect(await runner.approval(m)).toBeNull();
    expect(events.at(-1)).toMatchObject({ status: "blocked", blockedReason: "status_unknown", observation: { error: null } });
    expect(f.calls.filter((r) => ["terminal.send", "terminal.keys"].includes(r.method))).toHaveLength(0);
  });
  test("Yes sends down + enter in one write, then reports the actual idle state; replay is fenced", async () => {
    const { f, runner, m, terminal } = await trust(); const prompt = (await runner.approval(m))!;
    const events: RunnerEvent[] = []; runner.on((e) => events.push(e));
    f.setHook((r) => { if (r.method === "terminal.keys") { terminal.status = { state: "idle" }; f.setScreen(composer()); } return false; });
    expect(await runner.answerApproval(m, prompt.fingerprint, 2)).toMatchObject({ ok: true, chosen: { n: 2 } });
    expect(f.calls.filter((r) => r.method === "terminal.keys").map((r) => r.params.keys)).toEqual([["down", "enter"]]);
    expect(events.at(-1)).toMatchObject({ status: "idle", blockedReason: null });
    terminal.status = null; f.setScreen(trustScreen());
    expect(await runner.answerApproval(m, prompt.fingerprint, 2)).toMatchObject({ ok: false, reason: "changed" });
    expect(f.calls.filter((r) => r.method === "terminal.keys")).toHaveLength(1);
  });
  test("No sends only enter and preserves the observed normal session exit", async () => {
    const { f, runner, m, terminal } = await trust(); const prompt = (await runner.approval(m))!;
    const events: RunnerEvent[] = []; runner.on((e) => events.push(e));
    f.setHook((r) => { if (r.method === "terminal.keys") { terminal.state = "finished"; terminal.reason = "exited"; terminal.exit_code = 0; } return false; });
    expect(await runner.answerApproval(m, prompt.fingerprint, 1)).toMatchObject({ ok: true, chosen: { reject: true } });
    expect(f.calls.filter((r) => r.method === "terminal.keys").map((r) => r.params.keys)).toEqual([["enter"]]);
    expect(events.at(-1)).toMatchObject({ status: "gone", exit: { reason: "exited", exitCode: 0 } });
    expect(events.some((e) => e.type === "turn_end")).toBe(false);
  });
  test("selection marker determines movement, rather than assuming the default", async () => {
    for (const option of [1, 2]) {
      const { f, runner, m } = await trust(); f.setScreen(trustScreen("/tmp", 1));
      const prompt = (await runner.approval(m))!;
      expect(await runner.answerApproval(m, prompt.fingerprint, option)).toMatchObject({ ok: true });
      expect(f.calls.filter((r) => r.method === "terminal.keys").map((r) => r.params.keys)).toEqual([option === 1 ? ["up", "enter"] : ["enter"]]);
    }
  });
  test("changed screen fingerprint, path, unknown menu and manual lease each send zero keys", async () => {
    const { f, runner, m } = await trust(); const prompt = (await runner.approval(m))!;
    f.setScreen(trustScreen().replace("trust?", "trust? Changed explanation"));
    expect(await runner.answerApproval(m, prompt.fingerprint, 2)).toMatchObject({ ok: false, reason: "changed" });
    f.setScreen(trustScreen("/different")); expect(await runner.approval(m)).toBeNull();
    expect(await runner.answerApproval(m, prompt.fingerprint, 2)).toMatchObject({ ok: false, reason: "unrecognized" });
    f.setScreen(trustScreen()); await runner.terminalControl(m, { action: "claim" });
    expect(await runner.answerApproval(m, prompt.fingerprint, 2)).toMatchObject({ ok: false, reason: "input_busy" });
    expect(f.calls.filter((r) => ["terminal.send", "terminal.keys"].includes(r.method))).toHaveLength(0);
  });
  test("identity and epoch changes across screen reads refuse input", async () => {
    for (const change of ["identity", "epoch"]) {
      const { f, runner, m, terminal } = await trust(); const prompt = (await runner.approval(m))!;
      if (change === "identity") { terminal.pid = 123; await runner.approval(m); }
      let reads = 0;
      f.setHook((r) => { if (r.method === "terminal.read" && ++reads === 2) {
        if (change === "identity") terminal.pid = 999; else terminal.turn = 7;
      } return false; });
      expect(await runner.answerApproval(m, prompt.fingerprint, 2)).toMatchObject({ ok: false, reason: change === "identity" ? "changed" : "input_busy" });
      expect(f.calls.filter((r) => r.method === "terminal.keys")).toHaveLength(0);
    }
  });
  test("Codex trust text, ordinary blocked screens, malformed markers, and idle/working Claude are not parsed", async () => {
    const codex = await trust("codex"); expect(await codex.runner.approval(codex.m)).toBeNull();
    codex.f.setScreen("Do you trust the contents of this directory?\n1. Yes\n2. No"); expect(await codex.runner.approval(codex.m)).toBeNull();
    const { f, runner, m, terminal } = await trust();
    for (const screen of ["Approve execution?\n1. Yes\n2. No", trustScreen().replace("❯", " "), trustScreen().replace("Yes, I trust this folder", "❯ Yes, I trust this folder")]) {
      f.setScreen(screen); expect(await runner.approval(m)).toBeNull();
    }
    f.setScreen(trustScreen());
    for (const state of ["idle", "working", "done"] as const) { terminal.status = { state }; expect(await runner.approval(m)).toBeNull(); }
    expect(f.calls.some((r) => r.method === "terminal.keys")).toBe(false);
  });
});

describe("herdr-core client and lifecycle", () => {
  test("handshake validates generation and methods", async () => {
    const f = await fixture(); const runner = f.runner(); expect((await runner.available()).ok).toBe(true);
    f.setHook((request, socket) => { socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { generation: 1, version: "old", methods: [], features: [] } }) + "\n"); return true; });
    expect(await runner.available()).toMatchObject({ ok: false, detail: expect.stringContaining("missing methods") });
  });
  test("owned terminal launch uses argv, survives runner shutdown, rejoins without another launch", async () => {
    const f = await fixture(); const runner = f.runner(); const first = await runner.start(member(), f.opts);
    const launch = f.calls.find((request) => request.method === "terminal.run")!;
    expect(launch.params).toMatchObject({ no_parent: true, outlive_parent: true, keep: false, wait: false });
    expect(launch.params.env.XDG_CONFIG_HOME).toBeString(); expect(launch.params.env.XDG_STATE_HOME).toBeString(); expect(launch.params.env.HOME).toBe(process.env.HOME); expect(launch.params.argv[0]).toBe("/fake/claude"); expect(launch.params.argv).not.toContain("-p"); expect(launch.params.argv).toContain("--append-system-prompt-file");
    await runner.shutdown(); expect(f.calls.some((request) => ["terminal.kill", "server.stop"].includes(request.method))).toBe(false);
    const recovered = await f.runner().start(member({ sessionId: first.sessionId, paneId: first.paneId }), { ...f.opts, resume: true });
    expect(recovered.rejoined).toBe(true); expect(recovered.paneId).toBe(first.paneId); expect(f.calls.filter((request) => request.method === "terminal.run")).toHaveLength(1);
  });
  test("explicit stop kills only owned terminal; changed labels refuse control", async () => {
    const f = await fixture(); const runner = f.runner(); const start = await runner.start(member(), f.opts); const terminal = f.terminals.get(start.paneId)!;
    terminal.labels["iamceo.member"] = "someone-else"; await expect(runner.stop(member())).rejects.toThrow("ownership"); expect(f.calls.some((request) => request.method === "terminal.kill")).toBe(false);
    terminal.labels["iamceo.member"] = member().id; await runner.stop(member()); expect(terminal.state).toBe("finished");
  });
  test("transport timeout marks uncertain delivery and never replays", async () => {
    const f = await fixture(); const runner = f.runner(10000); await runner.start(member(), f.opts);
    f.setHook((request) => request.method === "terminal.send");
    const result = await runner.send(member(), "one prompt", f.opts); expect(result).toMatchObject({ ok: false, retryable: false, detail: expect.stringContaining("may have occurred") });
    expect(await runner.send(member(), "one prompt", f.opts)).toMatchObject({ ok: false, reason: "busy", retryable: false }); expect(f.calls.filter((request) => request.method === "terminal.send")).toHaveLength(1);
  });
  test("JSON-RPC rejection has stable kind and is not uncertain", async () => {
    const f = await fixture(); f.setHook((request, socket) => { socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "blocked", data: { kind: "blocked", hint: "use attach" } } }) + "\n"); return true; });
    try { await coreRpc(f.socketPath, "terminal.send", {}, 100); throw new Error("expected failure"); } catch (error) { expect(error).toBeInstanceOf(CoreError); expect(error).toMatchObject({ kind: "blocked", uncertain: false }); }
  });
  test("startup helper refuses implicit or user-global daemon configuration", async () => { await expect(ensureCoreServer({})).rejects.toThrow("explicit"); });
});

describe("delivery safety and OSC7501 turns", () => {
  test("blocked, silent, unknown composer and user drafts never receive input", async () => {
    const f = await fixture(); const runner = f.runner(10000); const start = await runner.start(member(), f.opts); const terminal = f.terminals.get(start.paneId)!;
    terminal.status = { state: "blocked", kind: "permission" }; expect(await runner.send(member(), "message", f.opts)).toMatchObject({ ok: false, reason: "blocked" });
    terminal.status = null; expect(await runner.send(member(), "message", f.opts)).toMatchObject({ ok: false, reason: "busy", retryable: true });
    terminal.status = { state: "idle" }; f.setScreen(composer("User's existing draft")); expect(await runner.send(member(), "message", f.opts)).toMatchObject({ ok: false, reason: "input_busy" });
    f.setScreen("Approve execution?\n1. Yes\n2. No"); expect(await runner.send(member(), "message", f.opts)).toMatchObject({ ok: false, reason: "input_busy" });
    expect(f.calls.some((request) => ["terminal.send", "terminal.keys"].includes(request.method))).toBe(false);
  });
  test("one concurrent delivery, force false and idle comparison; OSC turns emit no invented final output", async () => {
    const f = await fixture(); const runner = f.runner(); const events: RunnerEvent[] = []; runner.on((event) => events.push(event)); const start = await runner.start(member(), f.opts);
    const results = await Promise.all([runner.send(member(), "first", f.opts), runner.send(member(), "second", f.opts)]); expect(results.filter((result) => result.ok)).toHaveLength(1);
    const sends = f.calls.filter((request) => request.method === "terminal.send"); expect(sends).toHaveLength(1); expect(sends[0].params).toMatchObject({ if: "idle", force: false, wait: false });
    expect(events.filter((event) => event.type === "turn_end")).toHaveLength(0);
    const terminal = f.terminals.get(start.paneId)!; terminal.turn = 1; terminal.status = { state: "blocked" }; await until(() => events.some((event) => event.type === "status" && event.status === "blocked")); expect(events.filter((event) => event.type === "turn_end")).toHaveLength(0);
    terminal.status = { state: "idle" }; await until(() => events.some((event) => event.type === "turn_end")); expect(events.find((event) => event.type === "turn_end")).toMatchObject({ finalText: "", isError: false }); expect(runner.isBusy(member().id)).toBe(false);
  });
  test("polling reconnects after transient socket errors without respawning", async () => {
    const f = await fixture(); const runner = f.runner(); const events: RunnerEvent[] = []; runner.on((event) => events.push(event)); const start = await runner.start(member(), f.opts);
    f.setHook((request, socket) => { if (request.method === "terminal.get") { socket.destroy(); return true; } return false; }); await Bun.sleep(60);
    expect(events.some((event) => event.type === "status" && event.status === "gone")).toBe(false);
    f.setHook(null); const terminal = f.terminals.get(start.paneId)!; terminal.status = { state: "working" }; await until(() => events.some((event) => event.type === "status" && event.status === "working")); expect(f.calls.filter((request) => request.method === "terminal.run")).toHaveLength(1);
  });
  test("Codex uses official interactive command and scoped TOML MCP; unknown native id is not invented", async () => {
    const f = await fixture(); const codex = member({ cli: "codex", model: "gpt-test", effort: "xhigh" }); const launch = providerLaunch(codex, f.opts, { codexBin: "/fake/codex" });
    expect(launch.argv[0]).toBe("/fake/codex"); expect(launch.argv).not.toContain("exec"); expect(launch.argv).toContain('model_reasoning_effort="xhigh"'); expect(launch.argv).toContain('mcp_servers.iamceo.command="/bin/echo"'); expect(launch.argv).toContain('mcp_servers.iamceo.env_vars=["IAMCEO_TOKEN","IAMCEO_URL"]'); expect(launch.env.IAMCEO_TOKEN).toBe("secret"); expect(launch.argv.join(" ")).not.toContain("secret"); expect(launch.sessionId).toBeNull();
    expect(() => providerLaunch(codex, { ...f.opts, resume: true }, { codexBin: "/fake/codex" })).toThrow("unknown");
    const runner = f.runner(); await runner.start(codex, f.opts); f.setScreen("prior output\n› \n  ? for shortcuts\n"); expect(await runner.send(codex, "hello", f.opts)).toMatchObject({ ok: true });
  });
  test("Codex draft safety rejects typed/wrapped/unknown content", () => {
    expect(codexDraft("output\n› \n  ? for shortcuts")).toBe(""); expect(codexDraft("› Ask Codex to do anything\n\n  GPT-6-Astra high Fast · /private/tmp/iamceo-core-qa\n  ← for agents · ? for shortcuts")).toBe(""); expect(codexDraft("› keep my draft\n  ? for shortcuts")).toBe("keep my draft"); expect(codexDraft("› first\nsecond line\n  ? for shortcuts")).toBeNull(); expect(codexDraft("Approve? Yes/No")).toBeNull();
  });
});


describe("manual terminal control", () => {
  test("token lease pauses automation; input/keys require owner token; release resumes", async () => {
    const f = await fixture(); const runner = f.runner(10000); const start = await runner.start(member(), f.opts);
    const lease = await runner.terminalControl(member(), { action: "claim" }); expect(lease.leaseId).toBeString();
    expect(await runner.send(member(), "automatic", f.opts)).toMatchObject({ ok: false, reason: "input_busy", retryable: true });
    await expect(runner.terminalControl(member(), { action: "claim" })).rejects.toThrow("lease");
    await expect(runner.terminalControl(member(), { action: "key", key: "enter", leaseId: "wrong" })).rejects.toThrow("lease");
    await expect(runner.terminalControl(member(), { action: "key", key: "f5", leaseId: lease.leaseId })).rejects.toThrow("Unsupported");
    f.terminals.get(start.paneId)!.status = { state: "blocked" };
    await runner.terminalControl(member(), { action: "key", key: "down", leaseId: lease.leaseId });
    await runner.terminalControl(member(), { action: "input", text: "explicit user reply", leaseId: lease.leaseId });
    expect(f.calls.find((request) => request.method === "terminal.keys")?.params).toMatchObject({ keys: ["down"] });
    expect(f.calls.find((request) => request.method === "terminal.send")?.params).toMatchObject({ text: "explicit user reply", force: true });
    f.terminals.get(start.paneId)!.status = { state: "idle" };
    await runner.terminalControl(member(), { action: "release", leaseId: lease.leaseId });
    expect(await runner.send(member(), "automatic", f.opts)).toMatchObject({ ok: true });
  });
  test("done may send without unsupported exact condition; idle keeps atomic core condition", async () => {
    const f = await fixture(); const runner = f.runner(10000); const start = await runner.start(member(), f.opts);
    f.terminals.get(start.paneId)!.status = { state: "done" };
    expect(await runner.send(member(), "next turn", f.opts)).toMatchObject({ ok: true });
    const sent = f.calls.find((request) => request.method === "terminal.send")!; expect(sent.params.force).toBe(false); expect("if" in sent.params).toBe(false);
  });
  test("core status race blocks automated approval without typing", async () => {
    const f = await fixture(); const runner = f.runner(10000); await runner.start(member(), f.opts);
    f.setHook((request, socket) => { if (request.method !== "terminal.send") return false; socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "permission dialog", data: { kind: "blocked" } } }) + "\n"); return true; });
    expect(await runner.send(member(), "never approve", f.opts)).toMatchObject({ ok: false, reason: "blocked", retryable: true });
    expect(f.calls.find((request) => request.method === "terminal.send")?.params.force).toBe(false);
  });
});


describe("provider configuration and recovery guards", () => {
  test("concurrent unavailable socket probes reject cleanly without unhandled errors", async () => {
    const f = await fixture(); const missing = join(f.dir, "missing.sock");
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => coreRpc(missing, "hello", {}, 100)));
    expect(results.every((result) => result.status === "rejected" && result.reason instanceof CoreError)).toBe(true);
  });
  test("Claude configuration reload preserves native session and refuses a draft", async () => {
    const f = await fixture(); const runner = f.runner(10000); const first = await runner.start(member(), f.opts);
    f.setScreen(composer("leave my draft")); expect(await runner.applyConfig(member({ model: "new-model" }), f.opts)).toMatchObject({ ok: false, reason: "input_busy" }); expect(f.calls.some((request) => request.method === "terminal.kill")).toBe(false);
    f.setScreen(composer()); expect(await runner.applyConfig(member({ model: "new-model" }), f.opts)).toMatchObject({ ok: true });
    const launches = f.calls.filter((request) => request.method === "terminal.run"); expect(launches).toHaveLength(2); expect(launches[1].params.argv).toContain("--resume"); expect(launches[1].params.argv).toContain(first.sessionId); expect(launches[1].params.argv).toContain("new-model");
  });
  test("Codex supports configured max effort and subagent model without invented resume", async () => {
    const f = await fixture(); const launch = providerLaunch(member({ cli: "codex", effort: "max", subagentModel: "gpt-child" }), f.opts, { codexBin: "/fake/codex" });
    expect(launch.argv).toContain('model_reasoning_effort="max"'); expect(launch.argv).toContain('agents.default_subagent_model="gpt-child"'); expect(launch.argv).toContain("features.multi_agent=true");
  });
  test("Codex parallel preference instructs native subagents on the next task", async () => {
    const f = await fixture(); const runner = f.runner(10000); const codex = member({ cli: "codex" }); await runner.start(codex, f.opts); f.setScreen("› Ask Codex to do anything\n  GPT-6-Astra high Fast · /tmp\n  ← for agents · ? for shortcuts");
    expect(await runner.setParallel(codex, true, f.opts)).toMatchObject({ ok: true }); expect(await runner.send(codex, "implement the task", f.opts)).toMatchObject({ ok: true });
    const sent = f.calls.find((request) => request.method === "terminal.send")!; expect(sent.params.text).toContain("native subagents"); expect(sent.params.text).toContain("implement the task");
  });
  test("a native session already held by another member refuses duplicate launch", async () => {
    const f = await fixture(); const runner = f.runner(10000); const first = await runner.start(member(), f.opts);
    await expect(runner.start(member({ id: "other-member", sessionId: first.sessionId }), { ...f.opts, resume: true })).rejects.toThrow("already owned"); expect(f.calls.filter((request) => request.method === "terminal.run")).toHaveLength(1);
  });
});


test("Claude parallel mode confirms native command reply before reporting success", async () => {
  const f = await fixture(); const runner = f.runner(10000); await runner.start(member(), f.opts);
  f.setHook((request, socket) => {
    if (request.method !== "terminal.send") return false;
    expect(request.params.text).toBe("/effort ultracode on"); expect(request.params.force).toBe(false);
    f.setScreen(composer() + "\n/effort ultracode on\nUltracode on (this session only): native parallel mode\n");
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turn: 0, started: false, status: "idle" } }) + "\n"); return true;
  });
  expect(await runner.setParallel(member(), true, f.opts)).toMatchObject({ ok: true }); expect(runner.isBusy(member().id)).toBe(false);
});

test("persisted Codex terminal loss refuses an automatic fresh conversation", async () => {
  const f = await fixture(); const runner = f.runner(10000);
  await expect(runner.start(member({ cli: "codex", paneId: "t-missing", sessionId: null }), f.opts)).rejects.toThrow("native session id is unknown"); expect(f.calls.some((request) => request.method === "terminal.run")).toBe(false);
});

test("stop and provider switch preserve a visible user draft", async () => {
  const f = await fixture(); const runner = f.runner(10000); await runner.start(member(), f.opts); f.setScreen(composer("unsaved message"));
  await expect(runner.checkStop(member())).rejects.toThrow("draft"); await expect(runner.stop(member())).rejects.toThrow("draft"); expect(f.calls.some((request) => request.method === "terminal.kill")).toBe(false);
});

test("Claude turn end reports context usage from the transcript and status line; the server picks the window", async () => {
  const f = await fixture(); const runner = f.runner(); const events: RunnerEvent[] = []; runner.on((event) => events.push(event));
  const start = await runner.start(member(), f.opts);
  // Transcript of this session under the runner's (isolated) Claude home.
  const transcript = transcriptPath("/tmp", start.sessionId!, join(f.dir, "claude-home"));
  mkdirSync(dirname(transcript), { recursive: true });
  const line = (tokens: number) => JSON.stringify({ type: "assistant", message: { id: `a${tokens}`, model: "claude-opus-5-5", content: [{ type: "text", text: "done" }], usage: { input_tokens: 1000, cache_read_input_tokens: tokens - 1000, cache_creation_input_tokens: 0 } } }) + "\n";
  writeFileSync(transcript, line(190_000));
  // Narrow pane: the status line is cut before its %.
  f.setScreen(composer() + "  ◆ Opus(X) │ ██░░░░░░…\n");
  const terminal = f.terminals.get(start.paneId)!; terminal.turn = 1; terminal.status = { state: "idle" };
  await until(() => events.some((event) => event.type === "context_usage"));
  expect(events.find((event) => event.type === "context_usage")).toMatchObject({ type: "context_usage", memberId: member().id, sessionId: start.sessionId!, tokens: 190_000, shownPct: null, model: "claude-opus-5-5" });
  // Wide pane: the status-line % is the truth and comes with the tokens.
  writeFileSync(transcript, line(268_000), { flag: "a" });
  f.setScreen(composer() + "  ◆ Opus(X) │ ███░░░░░░░ │ 27% │ 268K/1.0M\n");
  terminal.turn = 2;
  await until(() => events.filter((event) => event.type === "context_usage").length === 2);
  expect(events.filter((event) => event.type === "context_usage")[1]).toMatchObject({ tokens: 268_000, shownPct: 27 });
  // The runner never guesses a % itself.
  expect(events.every((event) => event.type !== "context")).toBe(true);
});

test("Codex with unknown session id reports no context usage", async () => {
  const f = await fixture(); const runner = f.runner(); const events: RunnerEvent[] = []; runner.on((event) => events.push(event));
  const codex = member({ cli: "codex" }); const start = await runner.start(codex, f.opts);
  const terminal = f.terminals.get(start.paneId)!; terminal.turn = 1; terminal.status = { state: "idle" };
  await until(() => events.some((event) => event.type === "turn_end")); await Bun.sleep(50);
  expect(events.some((event) => event.type === "context_usage")).toBe(false);
});

test("Codex turn end emits the rollout's exact window and last request tokens", async () => {
  const f = await fixture(); const runner = f.runner(); const events: RunnerEvent[] = []; runner.on(e => events.push(e));
  const id = "codex-known-session"; const codex = member({ cli: "codex", sessionId: id, model: "gpt-6-astra" });
  const dir = join(f.dir, "codex-home/sessions/2026/11/07"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-time-${id}.jsonl`), [
    { type: "session_meta", payload: { id, cwd: codex.cwd, timestamp: "2026-11-07" } },
    { type: "event_msg", payload: { type: "token_count", info: { model_context_window: 475_000, last_token_usage: { total_tokens: 190_000 }, total_token_usage: { total_tokens: 5_000_000 } } } },
  ].map(v => JSON.stringify(v)).join("\n") + "\n");
  const start = await runner.start(codex, { ...f.opts, resume: true });
  const terminal = f.terminals.get(start.paneId)!; terminal.turn = 1; terminal.status = { state: "idle" };
  await until(() => events.some(e => e.type === "context_usage"));
  expect(events.find(e => e.type === "context_usage")).toMatchObject({ sessionId: id, tokens: 190_000, model: "gpt-6-astra", exact: { source: "codex", window: 475_000 } });
});

test("Claude turn end uses captured context even without a transcript or visible status line", async () => {
  const f = await fixture(); const runner = f.runner(); const events: RunnerEvent[] = []; runner.on(e => events.push(e));
  const start = await runner.start(member(), f.opts);
  mkdirSync(join(f.dir, "context"), { recursive: true });
  writeFileSync(join(f.dir, "context", `${start.sessionId}.json`), JSON.stringify({ session_id: start.sessionId, model: "actual-model", tokens: 190_000, context_window_size: 1_000_000, used_percentage: 19.1, at: Date.now() }));
  const terminal = f.terminals.get(start.paneId)!; terminal.turn = 1; terminal.status = { state: "idle" };
  await until(() => events.some(e => e.type === "context_usage"));
  expect(events.find(e => e.type === "context_usage")).toMatchObject({ sessionId: start.sessionId, model: "actual-model", tokens: 190_000, exact: { window: 1_000_000, source: "statusline", pct: 19.1 } });
});

test("Claude configured [1m] survives a plain transcript model id", async () => {
  const f = await fixture(); const runner = f.runner(); const events: RunnerEvent[] = []; runner.on(e => events.push(e));
  const start = await runner.start(member({ model: "opus[1m]" }), f.opts);
  const transcript = transcriptPath("/tmp", start.sessionId!, join(f.dir, "claude-home"));
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { id: "a1", model: "claude-opus-plain", content: [{ type: "text", text: "done" }], usage: { input_tokens: 190_000 } } }) + "\n");
  const terminal = f.terminals.get(start.paneId)!; terminal.turn = 1; terminal.status = { state: "idle" };
  await until(() => events.some(e => e.type === "context_usage"));
  expect(events.find(e => e.type === "context_usage")).toMatchObject({ tokens: 190_000, model: "opus[1m]" });
});

function recoveryStore() {
  let lease: TerminalLease | null = null;
  let dispatches: DeliveryDispatch[] = [];
  const port: RunnerRecoveryStore = { inputState: () => ({ lease, unresolvedDispatches: dispatches }), saveLease(value) { lease = structuredClone(value); }, removeLease(_memberId, claimId) { if (lease?.claimId === claimId) lease = null; } };
  return { port, dispatches(value: DeliveryDispatch[]) { dispatches = value; }, lease: () => lease };
}
async function deliveryFixture() {
  const f = await fixture(), recovery = recoveryStore();
  const runner = f.runner(10000, { recoveryStore: recovery.port });
  const started = await runner.start(member(), f.opts);
  const path = transcriptPath(member().cwd, started.sessionId!, join(f.dir, "claude-home"));
  mkdirSync(dirname(path), { recursive: true });
  const user = (text: string, uuid = "user-1") => JSON.stringify({ type: "user", sessionId: started.sessionId, cwd: member().cwd, uuid, message: { role: "user", content: text } }) + "\n";
  writeFileSync(path, user("an earlier unrelated input"));
  const marker = "#iamceo_" + "A".repeat(22), bundleMarker = "#iamceo_b_" + "B".repeat(22), wireText = `task\n${marker}\n${bundleMarker}`;
  const dispatch: DeliveryDispatch = { dispatchId: "dispatch", memberId: member().id, projectId: member().projectId, cli: "claude", backend: "core", markers: [{ deliveryId: "delivery", marker }], bundleMarker,
    identity: runner.observationState(member().id)!.identity, baseline: { serverEpoch: "test-epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date(0).toISOString() }, wireText,
    wireSha256: createHash("sha256").update(wireText).digest("hex"), items: [{ deliveryId: "delivery", ordinal: 0, sourceRevision: null }], transportState: "unknown", submitAttempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  recovery.dispatches([dispatch]);
  return { f, runner, recovery, started, path, dispatch, user };
}

describe("serialized observations and generation protection", () => {
  test("overlapping refreshes share a request and older turns cannot rewind completion", async () => {
    const f = await fixture(), runner = f.runner(10000), events: RunnerEvent[] = []; runner.on(e => events.push(e)); const started = await runner.start(member(), f.opts);
    let pending: { request: Request; socket: Socket } | null = null;
    f.setHook((request, socket) => { if (request.method !== "terminal.get") return false; pending = { request, socket }; return true; });
    const screens = [runner.screen(member()), runner.screen(member())]; await until(() => pending !== null);
    expect(f.calls.filter(c => c.method === "terminal.get")).toHaveLength(1);
    const terminal = f.terminals.get(started.paneId)!; terminal.turn = 9; terminal.status = { state: "idle" };
    pending!.socket.write(JSON.stringify({ jsonrpc: "2.0", id: pending!.request.id, result: terminal }) + "\n"); await Promise.all(screens);
    expect(events.filter(e => e.type === "turn_end")).toHaveLength(1);
    f.setHook(null); terminal.turn = 8; terminal.status = { state: "working" }; await expect(runner.screen(member())).rejects.toThrow("older");
    terminal.turn = 9; terminal.status = { state: "idle" }; await runner.screen(member());
    expect(events.filter(e => e.type === "turn_end")).toHaveLength(1);
    expect(events.find(e => e.type === "turn_end")).toMatchObject({ terminalId: started.paneId, turn: 9, sessionGeneration: 1 });
  });
  test("context collection stays busy and precedes the normal turn_end", async () => {
    const f = await fixture(), runner = f.runner(10000), events: RunnerEvent[] = []; runner.on(e => events.push(e)); const started = await runner.start(member(), f.opts);
    const path = transcriptPath(member().cwd, started.sessionId!, join(f.dir, "claude-home")); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "assistant", message: { id: "a", model: "m", usage: { input_tokens: 100 }, content: [] } }) + "\n");
    f.terminals.get(started.paneId)!.turn = 1;
    const observation = runner.screen(member()); await Bun.sleep(10); expect(runner.isBusy(member().id)).toBe(true); await observation;
    expect(events.findIndex(e => e.type === "context_usage")).toBeLessThan(events.findIndex(e => e.type === "turn_end"));
    expect(runner.isBusy(member().id)).toBe(false);
  });
  test("initial error and error to idle preserve one failure; unknown status is not approval", async () => {
    const f = await fixture(), first = f.runner(10000), started = await first.start(member(), f.opts); await first.shutdown();
    const terminal = f.terminals.get(started.paneId)!; terminal.turn = 1; terminal.status = { state: "error", msg: "quota exhausted" };
    const runner = f.runner(10000), events: RunnerEvent[] = []; runner.on(e => events.push(e)); await runner.reattachOwned(member({ sessionId: started.sessionId, paneId: started.paneId }));
    terminal.status = { state: "idle" }; await runner.screen(member()); expect(events.filter(e => e.type === "turn_end")).toHaveLength(1);
    expect(events.some(e => e.type === "status" && e.status === "idle")).toBe(false); expect(runner.observationState(member().id)?.lastError).toBe("quota exhausted");
    terminal.status = null; await runner.screen(member()); expect(events.findLast(e => e.type === "status")).toMatchObject({ status: "blocked", blockedReason: "status_unknown" });
  });
  test("read-only reattach refuses generation conflicts and duplicate owners without run/kill", async () => {
    const f = await fixture(), runner = f.runner(10000); const started = await runner.start(member(), f.opts); f.calls.length = 0;
    expect(await runner.reattachOwned(member({ sessionGeneration: 2 }))).toMatchObject({ outcome: "conflict" });
    const terminal = f.terminals.get(started.paneId)!; f.terminals.set("duplicate", { ...terminal, address: "duplicate" });
    expect(await runner.reattachOwned(member())).toMatchObject({ outcome: "conflict" });
    expect(f.calls.some(c => ["terminal.run", "terminal.kill"].includes(c.method))).toBe(false);
  });
  test("lost Codex session stays fenced after caller drops paneId", async () => {
    const f = await fixture(), runner = f.runner(10000), codex = member({ cli: "codex" }); const started = await runner.start(codex, f.opts);
    f.terminals.get(started.paneId)!.state = "finished"; await runner.screen(codex);
    await expect(runner.start({ ...codex, paneId: null }, f.opts)).rejects.toThrow("native session id is unknown");
    expect(f.calls.filter(c => c.method === "terminal.run")).toHaveLength(1);
  });
});

describe("persistent input safety and transport effects", () => {
  test("lease survives restart and same claim id is reclaimable before automated input", async () => {
    const f = await fixture(), recovery = recoveryStore(), first = f.runner(10000, { recoveryStore: recovery.port }); const started = await first.start(member(), f.opts);
    const lease = await first.terminalControl(member(), { action: "claim", leaseId: "client-claim" }); expect(lease.leaseId).toBe("client-claim"); await first.shutdown();
    const second = f.runner(10000, { recoveryStore: recovery.port }); await second.start(member({ paneId: started.paneId, sessionId: started.sessionId }), f.opts);
    expect(await second.send(member(), "automatic", f.opts)).toMatchObject({ ok: false, reason: "input_busy", deliveryEffect: "not_written" });
    expect(await second.terminalControl(member(), { action: "claim", leaseId: "client-claim" })).toMatchObject({ leaseId: "client-claim" });
    await second.terminalControl(member(), { action: "release", leaseId: "client-claim" }); expect(recovery.lease()).toBeNull();
    expect(await second.send(member(), "automatic", f.opts)).toMatchObject({ ok: true });
  });
  test("manual input, release and idle never clear an unknown original write", async () => {
    const f = await fixture(), runner = f.runner(10000); await runner.start(member(), f.opts); f.setHook(request => request.method === "terminal.send");
    expect(await runner.send(member(), "unknown", f.opts)).toMatchObject({ deliveryEffect: "unknown" }); f.setHook(null);
    const lease = await runner.terminalControl(member(), { action: "claim" }); await runner.terminalControl(member(), { action: "key", key: "esc", leaseId: lease.leaseId }); await runner.terminalControl(member(), { action: "release", leaseId: lease.leaseId });
    expect(await runner.send(member(), "must not replay", f.opts)).toMatchObject({ ok: false, reason: "busy" });
    expect(f.calls.filter(c => c.method === "terminal.send")).toHaveLength(1);
  });
  test("restored unresolved dispatch blocks urgent sends and lease inspection scans nothing", async () => {
    const d = await deliveryFixture(); await d.runner.shutdown(); const runner = d.f.runner(10000, { recoveryStore: d.recovery.port });
    await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    expect(await runner.send(member(), "urgent", d.f.opts, true)).toMatchObject({ ok: false, reason: "busy" });
    const lease = await runner.terminalControl(member(), { action: "claim" }); d.f.calls.length = 0;
    expect(await runner.inspectDelivery(member(), d.dispatch)).toMatchObject({ finding: "wait", snapshot: null });
    expect(d.f.calls).toHaveLength(0); await runner.terminalControl(member(), { action: "release", leaseId: lease.leaseId });
  });
  test("claim cannot race through a send, and safe stop rechecks working state", async () => {
    const f = await fixture(), runner = f.runner(10000); const started = await runner.start(member(), f.opts);
    f.setHook(request => request.method === "terminal.send"); const sending = runner.send(member(), "in flight", f.opts); await until(() => f.calls.some(c => c.method === "terminal.send"));
    await expect(runner.terminalControl(member(), { action: "claim" })).rejects.toThrow("mutation"); await sending; f.setHook(null);
    f.terminals.get(started.paneId)!.status = { state: "working" }; await expect(runner.stop(member(), { whileWorking: false })).rejects.toThrow(); expect(f.calls.some(c => c.method === "terminal.kill")).toBe(false);
  });
  test("pre-connect failure is not_written; JSON-RPC denial is rejected; started:false is received", async () => {
    const f = await fixture(); await expect(coreRpc(join(f.dir, "missing.sock"), "terminal.send", {}, 30)).rejects.toMatchObject({ deliveryEffect: "not_written", uncertain: false, causeCode: "ENOENT" });
    const runner = f.runner(10000); await runner.start(member(), f.opts);
    f.setHook((request, socket) => { if (request.method !== "terminal.send") return false; socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turn: 0, started: false } }) + "\n"); return true; });
    expect(await runner.send(member(), "received", f.opts)).toMatchObject({ ok: true, started: false, turn: 0 });
    expect(await runner.send(member(), "again", f.opts)).toMatchObject({ ok: false, reason: "busy" });
  });
});

describe("delivery evidence and guarded repair", () => {
  test("only primary-session user input counts; composer match remains unknown without a barrier", async () => {
    const d = await deliveryFixture(); d.f.setScreen(composer(d.dispatch.wireText));
    expect(await d.runner.inspectDelivery(member(), d.dispatch)).toMatchObject({ finding: "unknown", receivedDeliveryIds: [], quiescence: "unresolved" });
    writeFileSync(d.path, JSON.stringify({ type: "assistant", sessionId: d.started.sessionId, cwd: member().cwd, message: { role: "assistant", content: d.dispatch.wireText } }) + "\n", { flag: "a" });
    expect((await d.runner.inspectDelivery(member(), d.dispatch)).receivedDeliveryIds).toEqual([]);
    writeFileSync(d.path, d.user(d.dispatch.wireText, "receipt"), { flag: "a" });
    expect(await d.runner.inspectDelivery(member(), d.dispatch)).toMatchObject({ finding: "received", receivedDeliveryIds: ["delivery"] });
    expect(d.f.calls.some(c => c.method === "terminal.send")).toBe(false);
  });
  test("resend needs durable source/version validation; discovery just before repair sends nothing", async () => {
    const d = await deliveryFixture(); await d.runner.shutdown(); d.dispatch.transportState = "rejected";
    let prepared = 0;
    const runner = d.f.runner(10000, { recoveryStore: d.recovery.port, quiescence: () => ({ originalWrite: "rejected", externalInput: false }), repair: { load: () => d.dispatch, prepare: () => { prepared++; return true; } } });
    await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    const inspection = await runner.inspectDelivery(member(), d.dispatch); expect(inspection.finding).toBe("not_received");
    const request: DeliveryRepair = { action: "resend", dispatchId: "dispatch", expectedRecoveryVersion: 1, expectedSessionGeneration: 1, expectedSessionId: d.started.sessionId, expectedTerminalId: d.started.paneId, expectedInputEpoch: inspection.snapshot!.inputEpoch! };
    writeFileSync(d.path, d.user(d.dispatch.wireText, "late-receipt"), { flag: "a" });
    expect(await runner.repairDelivery(member(), request)).toMatchObject({ ok: false, deliveryEffect: "not_written" }); expect(prepared).toBe(0); expect(d.f.calls.some(c => c.method === "terminal.send")).toBe(false);
  });
  test("known pre-write absence resends exact stored wire only after durable prepare", async () => {
    const d = await deliveryFixture(); await d.runner.shutdown(); d.dispatch.transportState = "rejected"; let prepared = false;
    const runner = d.f.runner(10000, { recoveryStore: d.recovery.port, quiescence: () => ({ originalWrite: "rejected", externalInput: false }), repair: { load: (_id, request) => request.expectedRecoveryVersion === 1 ? d.dispatch : null, prepare: () => { prepared = true; return true; } } });
    await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    d.f.setHook(request => { if (request.method === "terminal.send") expect(prepared).toBe(true); return false; });
    const inspection = await runner.inspectDelivery(member(), d.dispatch);
    const request: DeliveryRepair = { action: "resend", dispatchId: "dispatch", expectedRecoveryVersion: 1, expectedSessionGeneration: 1, expectedSessionId: d.started.sessionId, expectedTerminalId: d.started.paneId, expectedInputEpoch: inspection.snapshot!.inputEpoch! };
    expect(await runner.repairDelivery(member(), { ...request, expectedRecoveryVersion: 2 })).toMatchObject({ ok: false, deliveryEffect: "not_written" });
    expect(await runner.repairDelivery(member(), request)).toMatchObject({ ok: true, receipt: { dispatchId: "dispatch" } });
    expect(d.f.calls.filter(c => c.method === "terminal.send").map(c => c.params.text)).toEqual([d.dispatch.wireText]);
  });
});

function compactStore() {
  const states = new Map<string, CoreCompactState>();
  return { states, port: { load: (id: string) => states.get(id) ?? null, save: (id: string, state: CoreCompactState) => { states.set(id, structuredClone(state)); } } };
}

async function uncertainCompactFixture() {
  const d = await deliveryFixture(), store = compactStore(); await d.runner.shutdown(); d.recovery.dispatches([]);
  const runner = d.f.runner(10000, { compactStore: store.port, compactTimeoutMs: 0 }), events: RunnerEvent[] = [];
  runner.on(e => events.push(e)); await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
  expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: true }); await runner.screen(member());
  expect(store.states.get(member().id)?.phase).toBe("uncertain");
  return { ...d, store, runner, events, terminal: d.f.terminals.get(d.started.paneId)! };
}

describe("compact control and shared native binding", () => {
  test("Claude wrapper is invocation scoped and preserves explicitly supplied settings", async () => {
    const f = await fixture(), settingsFile = join(f.dir, "settings.json"); writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: ["Read"] }, statusLine: { command: "old" } }));
    const launched = providerLaunch(member(), { ...f.opts, settingsFile }, { claudeBin: "/fake/claude", contextHome: f.dir });
    const settings = JSON.parse(launched.argv[launched.argv.indexOf("--settings") + 1]);
    expect(settings.permissions).toEqual({ allow: ["Read"] }); expect(settings.statusLine.command).toContain("iamceo-context-statusline"); expect(settings.statusLine.command).toContain(f.dir);
    // The dim follow-up suggestion would read as a draft on core's plain-text screen; off for this process only.
    expect(launched.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe("false");
    expect(launched.argv.join(" ")).not.toContain("PROMPT_SUGGESTION");
  });
  test("Claude compact sends one clean command; only new boundary plus settled emits compacted", async () => {
    const d = await deliveryFixture(), store = compactStore(); await d.runner.shutdown(); d.recovery.dispatches([]);
    const runner = d.f.runner(20, { compactStore: store.port }), events: RunnerEvent[] = []; runner.on(e => events.push(e)); await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    expect(await runner.compact(member(), "keep\n  decisions\tand context", d.f.opts)).toMatchObject({ ok: true });
    const calls = d.f.calls.filter(c => c.method === "terminal.send"); expect(calls).toHaveLength(1); expect(calls[0].params).toMatchObject({ text: "/compact keep decisions and context", if: "idle", force: false });
    const terminal = d.f.terminals.get(d.started.paneId)!; terminal.turn = 1; terminal.status = { state: "idle" }; await Bun.sleep(60);
    expect(runner.isBusy(member().id)).toBe(true); expect(events.some(e => e.type === "compacted" || e.type === "turn_end")).toBe(false);
    writeFileSync(d.path, JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId: d.started.sessionId, cwd: member().cwd }) + "\n", { flag: "a" });
    await until(() => events.some(e => e.type === "compacted")); expect(events.filter(e => e.type === "compacted")).toHaveLength(1);
    await Bun.sleep(40); expect(events.filter(e => e.type === "turn_end")).toHaveLength(0); expect(runner.isBusy(member().id)).toBe(false);
    expect(store.states.get(member().id)?.phase).toBe("succeeded");
  });
  test("large Claude history captures EOF, ignores historical boundaries and resumes after restart", async () => {
    const d = await deliveryFixture(), store = compactStore(); await d.runner.shutdown(); d.recovery.dispatches([]);
    const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId: d.started.sessionId, cwd: member().cwd }) + "\n";
    writeFileSync(d.path, (JSON.stringify({ type: "assistant", message: { content: "한글😀".repeat(8192) } }) + "\n").repeat(65) + boundary, { flag: "a" });
    const size = statSync(d.path).size; expect(size).toBeGreaterThan(4 * 1024 * 1024);
    const first = d.f.runner(10000, { compactStore: store.port }); await first.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    expect(await first.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: true });
    expect(store.states.get(member().id)?.baseline.offset).toBe(size); await first.shutdown();
    const terminal = d.f.terminals.get(d.started.paneId)!; terminal.turn = 1; terminal.status = { state: "idle" };
    const second = d.f.runner(10000, { compactStore: store.port }), events: RunnerEvent[] = []; second.on(e => events.push(e));
    await second.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    expect(second.isBusy(member().id)).toBe(true); expect(events.some(e => e.type === "compacted")).toBe(false);
    // Completion can itself span more than the observer's 1MiB per-poll budget.
    writeFileSync(d.path, (JSON.stringify({ type: "assistant", message: { content: "x".repeat(32768) } }) + "\n").repeat(40) + boundary, { flag: "a" });
    await second.screen(member()); expect(second.isBusy(member().id)).toBe(true);
    await second.screen(member()); expect(second.isBusy(member().id)).toBe(false);
    expect(events.filter(e => e.type === "compacted")).toHaveLength(1); expect(events.some(e => e.type === "turn_end")).toBe(false);
    expect(d.f.calls.filter(c => c.method === "terminal.send")).toHaveLength(1);
  });
  test("tail starting exactly on a complete 4MiB record boundary is a usable baseline", async () => {
    const d = await deliveryFixture(), store = compactStore(); await d.runner.shutdown(); d.recovery.dispatches([]);
    const budget = 4 * 1024 * 1024;
    const line = JSON.stringify({ text: "x".repeat(budget - JSON.stringify({ text: "" }).length - 1) }) + "\n";
    expect(Buffer.byteLength(line)).toBe(budget); writeFileSync(d.path, line, { flag: "a" });
    const runner = d.f.runner(10000, { compactStore: store.port }); await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: true });
    expect(store.states.get(member().id)?.baseline.offset).toBe(statSync(d.path).size);
  });
  test.each(["partial", "corrupt", "oversized"])("large Claude history refuses a %s tail without sending, then accepts a repaired tail", async kind => {
    const d = await deliveryFixture(), store = compactStore(); await d.runner.shutdown(); d.recovery.dispatches([]);
    writeFileSync(d.path, (JSON.stringify({ type: "assistant", message: { content: "x".repeat(65536) } }) + "\n").repeat(65), { flag: "a" });
    const size = statSync(d.path).size;
    writeFileSync(d.path, kind === "partial" ? '{"text":"unfinished😀' : kind === "corrupt" ? "broken JSON\n" : JSON.stringify({ text: "x".repeat(4 * 1024 * 1024) }) + "\n", { flag: "a" });
    const runner = d.f.runner(10000, { compactStore: store.port }); await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
    expect(store.states.size).toBe(0); expect(d.f.calls.some(c => c.method === "terminal.send")).toBe(false);
    truncateSync(d.path, size); expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: true });
  });
  test.each(["replace", "truncate", "append"])("baseline %s during final terminal recheck prevents compact input", async kind => {
    const d = await deliveryFixture(), store = compactStore(); await d.runner.shutdown(); d.recovery.dispatches([]);
    const runner = d.f.runner(10000, { compactStore: store.port }); await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    let checks = 0;
    d.f.setHook(request => {
      if (request.method === "terminal.get" && ++checks === 3) {
        if (kind === "replace") { renameSync(d.path, d.path + ".old"); writeFileSync(d.path, "{}\n"); }
        else if (kind === "truncate") truncateSync(d.path, 0);
        else writeFileSync(d.path, "{}\n", { flag: "a" });
      }
      return false;
    });
    expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
    expect(store.states.size).toBe(0); expect(d.f.calls.some(c => c.method === "terminal.send")).toBe(false);
  });
  test("done, drafts, working and unavailable persistence send no compact input", async () => {
    const d = await deliveryFixture(), store = compactStore(); await d.runner.shutdown(); d.recovery.dispatches([]);
    const runner = d.f.runner(10000, { compactStore: store.port }); await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts); const terminal = d.f.terminals.get(d.started.paneId)!;
    terminal.status = { state: "done" }; expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
    terminal.status = { state: "idle" }; d.f.setScreen(composer("user draft")); expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: false, reason: "input_busy" });
    d.f.setScreen(composer()); terminal.status = { state: "working" }; expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: false });
    expect(d.f.calls.some(c => c.method === "terminal.send")).toBe(false);
  });
  test("compact persistence failure prevents input; ACK loss survives restart without another slash", async () => {
    const d = await deliveryFixture(); await d.runner.shutdown(); d.recovery.dispatches([]);
    const bad = d.f.runner(10000, { compactStore: { load: () => null, save: () => { throw new Error("disk full"); } } }); await bad.start(member({ sessionId: d.started.sessionId, paneId: d.started.paneId }), d.f.opts);
    expect(await bad.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: false, deliveryEffect: "not_written" }); expect(d.f.calls.some(c => c.method === "terminal.send")).toBe(false); await bad.shutdown();
    const store = compactStore(), first = d.f.runner(10000, { compactStore: store.port }); await first.start(member({ sessionId: d.started.sessionId, paneId: d.started.paneId }), d.f.opts);
    d.f.setHook(c => c.method === "terminal.send"); expect(await first.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: false, retryable: false, deliveryEffect: "unknown" }); await first.shutdown(); d.f.setHook(null);
    const second = d.f.runner(10000, { compactStore: store.port }); await second.start(member({ sessionId: d.started.sessionId, paneId: d.started.paneId }), d.f.opts);
    expect(await second.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: false, reason: "busy" }); expect(await second.send(member(), "next work", d.f.opts)).toMatchObject({ ok: false, reason: "busy" });
    expect(d.f.calls.filter(c => c.method === "terminal.send")).toHaveLength(1);
  });
  test("Codex binding is shared by delivery/context, keeps nonce across restart, and compact has no prefix", async () => {
    const f = await fixture(), store = compactStore(), first = f.runner(10000, { compactStore: store.port }), codex = member({ cli: "codex", parallel: true }); const started = await first.start(codex, f.opts);
    const terminal = f.terminals.get(started.paneId)!, nonce = terminal.labels["iamceo.binding"];
    f.setScreen("› \n  ? for shortcuts"); expect(await first.send(codex, "real task", f.opts)).toMatchObject({ ok: true });
    const wire = f.calls.find(c => c.method === "terminal.send")!.params.text; expect(wire).toContain(`[IAMCEO session binding: ${nonce}]`);
    const id = "native-codex", dir = join(f.dir, "codex-home/sessions/day"); mkdirSync(dir, { recursive: true }); const path = join(dir, `rollout-time-${id}.jsonl`);
    writeFileSync(path, [ { type: "session_meta", payload: { id, cwd: codex.cwd } }, { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: wire }] } } ].map(v => JSON.stringify(v)).join("\n") + "\n");
    terminal.turn = 1; terminal.status = { state: "idle" }; await first.screen(codex); expect(first.observationState(codex.id)?.identity.sessionId).toBe(id); await first.shutdown();
    writeFileSync(path, (JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(65536) }] } }) + "\n").repeat(65) + JSON.stringify({ type: "compacted" }) + "\n", { flag: "a" });
    const second = f.runner(20, { compactStore: store.port }), events: RunnerEvent[] = []; second.on(e => events.push(e)); await second.start({ ...codex, paneId: started.paneId }, f.opts);
    for (let i = 0; i < 8 && !second.observationState(codex.id)?.identity.sessionId; i++) await second.screen(codex);
    expect(second.observationState(codex.id)?.identity.sessionId).toBe(id); expect(terminal.labels["iamceo.binding"]).toBe(nonce);
    expect(await second.compact(codex, "never pass Claude focus", f.opts)).toMatchObject({ ok: true });
    expect(store.states.get(codex.id)?.baseline.offset).toBe(statSync(path).size);
    expect(f.calls.filter(c => c.method === "terminal.send").at(-1)?.params.text).toBe("/compact");
    terminal.turn = 2; terminal.status = { state: "idle" }; await second.screen(codex);
    expect(second.isBusy(codex.id)).toBe(true); expect(events.some(e => e.type === "compacted")).toBe(false);
    writeFileSync(path, JSON.stringify({ type: "compacted" }) + "\n", { flag: "a" }); terminal.turn = 2; terminal.status = { state: "idle" };
    await until(() => events.some(e => e.type === "compacted")); expect(events.some(e => e.type === "turn_end" && e.turn === 2)).toBe(false);
  });
  test("compact timeout fences following work and claim/release does not declare success", async () => {
    const d = await deliveryFixture(), store = compactStore(); await d.runner.shutdown(); d.recovery.dispatches([]);
    const runner = d.f.runner(20, { compactStore: store.port, compactTimeoutMs: 20 }), events: RunnerEvent[] = []; runner.on(e => events.push(e)); await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: true }); await until(() => store.states.get(member().id)?.phase === "uncertain");
    const lease = await runner.terminalControl(member(), { action: "claim" }); await runner.terminalControl(member(), { action: "release", leaseId: lease.leaseId });
    expect(await runner.send(member(), "next", d.f.opts)).toMatchObject({ ok: false, reason: "busy" }); expect(events.some(e => e.type === "compacted" || e.type === "turn_end")).toBe(false);
  });
  test.each(["input", "key"])("acknowledged human %s plus settled transition resolves compact once without claiming success", async action => {
    const d = await uncertainCompactFixture(); d.terminal.status = { state: "blocked", kind: "selection" };
    const lease = await d.runner.terminalControl(member(), { action: "claim" });
    await d.runner.terminalControl(member(), { action, text: "resolve the prompt", key: "esc", leaseId: lease.leaseId });
    expect(d.store.states.get(member().id)?.phase).toBe("uncertain");
    d.terminal.status = { state: "done" }; await d.runner.screen(member());
    expect(d.store.states.get(member().id)).toMatchObject({ phase: "failed", reason: "user_resolved" });
    expect(d.runner.isBusy(member().id)).toBe(false); await d.runner.screen(member());
    expect(d.events.filter(e => e.type === "activity" && e.runId === d.store.states.get(member().id)?.id)).toHaveLength(1);
    expect(d.events.some(e => e.type === "compacted" || e.type === "turn_end")).toBe(false);
    await d.runner.terminalControl(member(), { action: "release", leaseId: lease.leaseId });
    d.terminal.status = { state: "idle" }; expect(await d.runner.send(member(), "next", d.f.opts)).toMatchObject({ ok: true });
  });
  test("same idle and claim/release cannot resolve even acknowledged human input", async () => {
    const d = await uncertainCompactFixture(); d.terminal.status = { state: "idle" };
    const lease = await d.runner.terminalControl(member(), { action: "claim" });
    await d.runner.terminalControl(member(), { action: "key", key: "esc", leaseId: lease.leaseId });
    await d.runner.screen(member()); await d.runner.terminalControl(member(), { action: "release", leaseId: lease.leaseId });
    await d.runner.screen(member()); expect(d.runner.isBusy(member().id)).toBe(true);
    expect(d.store.states.get(member().id)?.phase).toBe("uncertain");
    d.terminal.status = { state: "working" }; await d.runner.screen(member());
    d.terminal.status = { state: "idle" }; await d.runner.screen(member());
    expect(d.store.states.get(member().id)).toMatchObject({ phase: "failed", reason: "user_resolved" });
  });
  test("a settled observation requested before the human ACK cannot resolve compact", async () => {
    const d = await uncertainCompactFixture(), lease = await d.runner.terminalControl(member(), { action: "claim" });
    let key: { request: Request; socket: Socket } | null = null, observation: { request: Request; socket: Socket } | null = null;
    let capture = true;
    d.f.setHook((request, socket) => {
      if (request.method === "terminal.keys") { key = { request, socket }; return true; }
      if (request.method === "terminal.get" && key && capture) { capture = false; observation = { request, socket }; return true; }
      return false;
    });
    const input = d.runner.terminalControl(member(), { action: "key", key: "esc", leaseId: lease.leaseId }); await until(() => key !== null);
    const reading = d.runner.screen(member()); await until(() => observation !== null);
    key!.socket.write(JSON.stringify({ jsonrpc: "2.0", id: key!.request.id, result: { turn: 0 } }) + "\n");
    d.terminal.turn = 1; d.terminal.status = { state: "working" };
    observation!.socket.write(JSON.stringify({ jsonrpc: "2.0", id: observation!.request.id, result: { ...d.terminal, status: { state: "idle" } } }) + "\n");
    await Promise.all([input, reading]); d.f.setHook(null);
    expect(d.store.states.get(member().id)?.phase).toBe("uncertain"); expect(d.runner.isBusy(member().id)).toBe(true);
    d.terminal.status = { state: "idle" }; await d.runner.screen(member());
    expect(d.store.states.get(member().id)).toMatchObject({ phase: "failed", reason: "user_resolved" });
  });
  test("expired control lease plus a later idle turn without acknowledged input retains the fence", async () => {
    const d = await uncertainCompactFixture(); await d.runner.shutdown();
    d.recovery.port.saveLease({ memberId: member().id, claimId: "expired", leaseId: "expired", identity: d.dispatch.identity, expiresAt: Date.now() - 1, lastInputSequence: 1 });
    d.terminal.turn = 1; d.terminal.status = { state: "idle" };
    const runner = d.f.runner(10000, { compactStore: d.store.port, recoveryStore: d.recovery.port });
    await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts); await runner.screen(member());
    expect(d.store.states.get(member().id)?.phase).toBe("uncertain"); expect(runner.isBusy(member().id)).toBe(true);
  });
  test.each(["refused", "unknown"])("%s human input cannot arm resolution after a later settled turn", async effect => {
    const d = await uncertainCompactFixture(), lease = await d.runner.terminalControl(member(), { action: "claim" });
    d.f.setHook((request, socket) => {
      if (request.method !== "terminal.keys") return false;
      if (effect === "unknown") socket.destroy();
      else socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "refused", data: { kind: "blocked" } } }) + "\n");
      return true;
    });
    await expect(d.runner.terminalControl(member(), { action: "key", key: "esc", leaseId: lease.leaseId })).rejects.toThrow(); d.f.setHook(null);
    d.terminal.turn = 2; d.terminal.status = { state: "idle" }; await d.runner.screen(member());
    await d.runner.terminalControl(member(), { action: "release", leaseId: lease.leaseId }); await d.runner.screen(member());
    expect(d.store.states.get(member().id)?.phase).toBe("uncertain"); expect(d.runner.isBusy(member().id)).toBe(true);
  });
  test("a later unknown human input discards earlier ACK proof and keeps unresolved delivery fenced", async () => {
    const d = await uncertainCompactFixture(), lease = await d.runner.terminalControl(member(), { action: "claim" });
    await d.runner.terminalControl(member(), { action: "key", key: "esc", leaseId: lease.leaseId });
    expect(d.store.states.get(member().id)?.manualResolution).toBeDefined();
    d.f.setHook((request, socket) => { if (request.method !== "terminal.keys") return false; socket.destroy(); return true; });
    await expect(d.runner.terminalControl(member(), { action: "key", key: "enter", leaseId: lease.leaseId })).rejects.toThrow(); d.f.setHook(null);
    d.terminal.turn = 1; d.terminal.status = { state: "idle" }; await d.runner.screen(member());
    expect(d.store.states.get(member().id)?.manualResolution).toBeUndefined(); expect(d.runner.isBusy(member().id)).toBe(true);
    // A fresh, acknowledged intervention may resolve compact, while the
    // independent delivery recovery fence must survive that resolution.
    await d.runner.terminalControl(member(), { action: "key", key: "esc", leaseId: lease.leaseId }); await d.runner.shutdown();
    d.recovery.dispatches([d.dispatch]); d.terminal.turn = 2;
    const runner = d.f.runner(10000, { compactStore: d.store.port, recoveryStore: d.recovery.port });
    await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    expect(d.store.states.get(member().id)).toMatchObject({ phase: "failed", reason: "user_resolved" });
    expect(runner.isBusy(member().id)).toBe(true); expect(await runner.send(member(), "next", d.f.opts)).toMatchObject({ ok: false, reason: "busy" });
  });
  test("acknowledged human resolution survives restart; failed persistence and ownership changes retain the fence", async () => {
    const d = await uncertainCompactFixture(), lease = await d.runner.terminalControl(member(), { action: "claim" });
    await d.runner.terminalControl(member(), { action: "key", key: "esc", leaseId: lease.leaseId }); await d.runner.shutdown();
    d.terminal.turn = 1; d.terminal.status = { state: "idle" };
    let fail = true;
    const runner = d.f.runner(10000, { compactStore: { load: d.store.port.load, save: (id, state) => { if (fail && state.reason === "user_resolved") throw new Error("disk full"); d.store.port.save(id, state); } } });
    await expect(runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts)).rejects.toThrow("disk full");
    expect(runner.isBusy(member().id)).toBe(true); expect(d.store.states.get(member().id)?.phase).toBe("uncertain");
    fail = false; d.terminal.labels["iamceo.generation"] = "2"; await expect(runner.screen(member())).rejects.toThrow("ownership");
    expect(runner.isBusy(member().id)).toBe(true);
    d.terminal.labels["iamceo.generation"] = "1"; await runner.screen(member());
    expect(d.store.states.get(member().id)).toMatchObject({ phase: "failed", reason: "user_resolved" }); expect(runner.isBusy(member().id)).toBe(false);
  });
});

test("submit-only repair requires exact unmodified composer, a verified drain barrier and one durable attempt", async () => {
  const d = await deliveryFixture(); await d.runner.shutdown(); d.dispatch.transportState = "accepted";
  const runner = d.f.runner(10000, { recoveryStore: d.recovery.port, submitKeyVerified: true, quiescence: () => ({ originalWrite: "settled", externalInput: false }), repair: { load: () => d.dispatch, prepare: () => { d.dispatch.submitAttempts++; return true; } } });
  await runner.start(member({ sessionId: d.started.sessionId, paneId: d.started.paneId }), d.f.opts);
  d.f.setScreen(composer(" " + d.dispatch.wireText)); expect((await runner.inspectDelivery(member(), d.dispatch)).finding).toBe("unknown");
  d.f.setScreen(composer(d.dispatch.wireText)); const inspection = await runner.inspectDelivery(member(), d.dispatch); expect(inspection.finding).toBe("draft_only");
  const request: DeliveryRepair = { action: "submit_only", dispatchId: "dispatch", expectedRecoveryVersion: 1, expectedSessionGeneration: 1, expectedSessionId: d.started.sessionId, expectedTerminalId: d.started.paneId, expectedInputEpoch: inspection.snapshot!.inputEpoch! };
  expect(await runner.repairDelivery(member(), request)).toMatchObject({ ok: false, deliveryEffect: "unknown" });
  expect(await runner.repairDelivery(member(), { ...request, expectedInputEpoch: runner.observationState(member().id)!.inputEpoch })).toMatchObject({ ok: false, deliveryEffect: "not_written" });
  expect(d.f.calls.filter(c => c.method === "terminal.keys").map(c => c.params.keys)).toEqual([["enter"]]); expect(d.f.calls.some(c => c.method === "terminal.send")).toBe(false);
});

test("safe stop confirms termination after a lost kill response", async () => {
  const f = await fixture(), runner = f.runner(10000), started = await runner.start(member(), f.opts);
  f.setHook((request, socket) => { if (request.method !== "terminal.kill") return false; f.terminals.get(started.paneId)!.state = "finished"; socket.destroy(); return true; });
  await runner.stop(member(), { whileWorking: false }); expect(f.calls.filter(c => c.method === "terminal.kill")).toHaveLength(1); expect(runner.observationState(member().id)).toBeNull();
});

test("stale caller generation cannot send or compact into an older live terminal", async () => {
  const f = await fixture(), store = compactStore(), runner = f.runner(10000, { compactStore: store.port }); await runner.start(member(), f.opts);
  expect(await runner.send(member({ sessionGeneration: 2 }), "stale request", f.opts)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
  expect(await runner.compact(member({ sessionGeneration: 2 }), "focus", f.opts)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
  expect(f.calls.some(c => c.method === "terminal.send")).toBe(false);
});

test("terminal.run response loss reattaches by stable labels without a second launch", async () => {
  const f = await fixture(), runner = f.runner(10000);
  f.setHook((request, socket) => { if (request.method !== "terminal.run") return false; f.terminals.set("late-holder", { address: "late-holder", argv: request.params.argv, cwd: request.params.cwd, labels: request.params.labels, state: "live", turn: 0, status: { state: "idle" } }); socket.destroy(); return true; });
  await expect(runner.start(member(), { ...f.opts, operationId: "stable-operation" })).rejects.toMatchObject({ uncertain: true }); f.setHook(null);
  expect(await runner.reattachOwned(member())).toMatchObject({ outcome: "rejoined", started: { paneId: "late-holder" } }); expect(f.calls.filter(c => c.method === "terminal.run")).toHaveLength(1);
});

test("stale send cannot clear a live pending turn, and empty input cannot launch a CLI", async () => {
  const f = await fixture(), runner = f.runner(10000);
  expect(await runner.send(member(), "  \n", f.opts)).toMatchObject({ ok: false, deliveryEffect: "not_written" }); expect(f.calls.some(c => c.method === "terminal.run")).toBe(false);
  await runner.start(member(), f.opts); f.setHook((request, socket) => { if (request.method !== "terminal.send") return false; socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turn: 0, started: false } }) + "\n"); return true; });
  expect(await runner.send(member(), "first", f.opts)).toMatchObject({ ok: true }); expect(runner.isBusy(member().id)).toBe(true);
  expect(await runner.send(member({ sessionGeneration: 2 }), "old caller", f.opts)).toMatchObject({ ok: false });
  expect(runner.isBusy(member().id)).toBe(true); expect(await runner.send(member(), "second", f.opts)).toMatchObject({ ok: false, reason: "busy" }); expect(f.calls.filter(c => c.method === "terminal.send")).toHaveLength(1);
});

test("malformed creation receipt leaves a start fence instead of authorizing a second CLI", async () => {
  const f = await fixture(), runner = f.runner(10000);
  f.setHook((request, socket) => { if (request.method !== "terminal.run") return false; socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: null }) + "\n"); return true; });
  await expect(runner.start(member(), f.opts)).rejects.toMatchObject({ uncertain: true, kind: "protocol" }); f.setHook(null);
  await expect(runner.start(member(), f.opts)).rejects.toMatchObject({ kind: "starting_unknown" });
  expect(f.calls.filter(c => c.method === "terminal.run")).toHaveLength(1);
});

 test("Codex rank config reaches provider argv and null preserves CLI defaults", async () => {
  const f = await fixture();
  const codexRanks = { ...DEFAULT_RANKS, lead: { model: "gpt-6-luna", effort: "low" as const }, staff: { model: "gpt-6.1-terra", effort: "minimal" as const } };
  const m = member({ cli: "codex" });
  const configured = { ...m, ...memberConfig({ ...m, modelOverride: null, effortOverride: null }, DEFAULT_RANKS, codexRanks), subagentModel: codexRanks.staff.model };
  const launch = providerLaunch(configured, f.opts, { codexBin: "/fake/codex" });
  expect(launch.argv.slice(launch.argv.indexOf("--model"), launch.argv.indexOf("--model") + 2)).toEqual(["--model", "gpt-6-luna"]);
  expect(launch.argv).toContain('model_reasoning_effort="low"');
  expect(launch.argv).toContain('agents.default_subagent_model="gpt-6.1-terra"');
  expect(launch.argv.some(arg => arg.includes("minimal"))).toBe(false);
  const defaults = providerLaunch(m, f.opts, { codexBin: "/fake/codex" });
  expect(defaults.argv).not.toContain("--model");
  expect(defaults.argv.some(arg => /model_reasoning_effort|default_subagent_model/.test(arg))).toBe(false);
});


const codexTrustScreen = (selected = 0, cwd = "/tmp") => `Folder access
${cwd}
Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a model request. Continue only if you
trust these files. Your trust decision will be saved.
${selected === 0 ? "›" : " "} 1. Trust and continue
${selected === 1 ? "›" : " "} 2. Quit
enter continue · esc quit
`;
describe("Codex 0.166 folder trust approval", () => {
  async function trust(selected = 0) {
    const f = await fixture(), runner = f.runner(10000), m = member({ cli: "codex" });
    const start = await runner.start(m, f.opts), terminal = f.terminals.get(start.paneId)!;
    terminal.status = null; f.setScreen(codexTrustScreen(selected));
    return { f, runner, m, terminal };
  }
  test.each([[0, 1, ["enter"]], [0, 2, ["down", "enter"]], [1, 1, ["up", "enter"]]] as const)("selection %s answer %s calculates keys from the observed cursor", async (selected, option, keys) => {
    const { f, runner, m } = await trust(selected);
    const prompt = (await runner.approval(m))!;
    expect(prompt).toMatchObject({ title: "폴더 신뢰 확인", question: "Trust this folder?", options: [{ n: 1, reject: false }, { n: 2, reject: true }] });
    expect(f.calls.filter(c => c.method === "terminal.keys")).toHaveLength(0);
    expect(runner.observationState(m.id)?.setupError?.code).toBe("folder_trust");
    expect(await runner.answerApproval(m, prompt.fingerprint!, option)).toMatchObject({ ok: true });
    expect(f.calls.filter(c => c.method === "terminal.keys").at(-1)?.params.keys).toEqual([...keys]);
    expect(await runner.answerApproval(m, prompt.fingerprint!, option)).toMatchObject({ ok: false });
    expect(f.calls.filter(c => c.method === "terminal.keys")).toHaveLength(1);
  });
  test("changed fingerprint, wrong cwd, missing selection and manual lease never send keys", async () => {
    const { f, runner, m } = await trust(); const prompt = (await runner.approval(m))!;
    f.setScreen(codexTrustScreen(1));
    expect(await runner.answerApproval(m, prompt.fingerprint!, 1)).toMatchObject({ ok: false, reason: "changed" });
    for (const screen of [codexTrustScreen(0, "/other"), codexTrustScreen().replace("›", " ")]) {
      f.setScreen(screen); expect(await runner.approval(m)).toBeNull();
    }
    f.setScreen(codexTrustScreen()); await runner.terminalControl(m, { action: "claim" });
    expect(await runner.answerApproval(m, prompt.fingerprint!, 1)).toMatchObject({ ok: false, reason: "input_busy" });
    expect(f.calls.filter(c => c.method === "terminal.keys")).toHaveLength(0);
  });
});

test("resumed native session reads old delivery markers across terminal identity change without authorizing repair", async () => {
  const d = await deliveryFixture();
  writeFileSync(d.path, d.user(d.dispatch.wireText));
  const old = { ...d.dispatch, identity: { ...d.dispatch.identity, terminalId: "previous-terminal", sessionGeneration: 0 } };
  const result = await d.runner.inspectDelivery(member(), old);
  expect(result.finding).toBe("received"); expect(result.receivedDeliveryIds).toEqual(["delivery"]);
  expect(result.snapshot?.identity.terminalId).toBe(d.started.paneId);
  expect(result.quiescence).toBe("unresolved");
  expect(d.f.calls.filter(c => c.method === "terminal.send")).toHaveLength(0);
  const different = await d.runner.inspectDelivery(member(), { ...old, identity: { ...old.identity, sessionId: "another-native" } });
  expect(different).toMatchObject({ finding: "unknown", receivedDeliveryIds: [], evidence: [{ code: "identity_changed" }] });
});

test("Codex legacy terminal launch journal bounds binding even without a startedAt label", async () => {
  const f = await fixture(), first = f.runner(10000), codex = member({ cli: "codex" });
  const started = await first.start(codex, f.opts), terminal = f.terminals.get(started.paneId)!;
  const timestamp = "2026-11-06T01:00:00Z", nonce = terminal.labels["iamceo.binding"];
  delete terminal.labels["iamceo.startedAt"]; terminal.labels["iamceo.operation"] = "legacy-launch";
  const dir = join(f.dir, "codex-home/sessions/day"); mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 25; i++) writeFileSync(join(dir, `rollout-2025-01-01T00-00-00-${i}.jsonl`), "{broken old format}\n");
  writeFileSync(join(dir, "rollout-2026-11-06T01-00-00-native.jsonl"), [
    { type: "session_meta", payload: { id: "native", session_id: "native", cwd: codex.cwd, timestamp } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `[IAMCEO session binding: ${nonce}]` }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  await first.shutdown();
  const recovery = recoveryStore();
  const runner = f.runner(10000, { recoveryStore: { ...recovery.port, getLifecycleJournal: () => ({ operationId: "legacy-launch", memberId: codex.id, projectId: codex.projectId, intent: "start", phase: "confirmed", identity: { terminalId: started.paneId, sessionId: null, sessionGeneration: 1, process: null }, runId: null, deliveryIds: [], baseline: null, reason: null, exitCode: null, createdAt: timestamp, updatedAt: timestamp }) } });
  await runner.start({ ...codex, paneId: started.paneId }, f.opts); await runner.screen(codex);
  expect(runner.observationState(codex.id)?.identity.sessionId).toBe("native");
});
