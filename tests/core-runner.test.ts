import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CoreRunner, codexDraft, ensureCoreServer } from "../server/runner/core.ts";
import { CoreError, coreRpc, type CoreTerminal } from "../server/runner/core-client.ts";
import { providerLaunch } from "../server/runner/providers.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import type { RunnerEvent, RunnerMember, StartOpts } from "../server/runner/types.ts";

const methods = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill", "terminal.keys"];
const composer = (draft = "") => `prior output\n${"─".repeat(30)}\n❯ ${draft}\n${"─".repeat(30)}\n`;
const member = (extra: Partial<RunnerMember> = {}): RunnerMember => ({ id: "member-one", projectId: "project-one", cli: "claude", handle: "worker", name: "Worker", cwd: "/tmp", sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker", ...extra });
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
  return { dir, socketPath, opts, terminals, calls, setScreen(value: string) { screen = value; }, setHook(value: typeof hook) { hook = value; }, runner(pollMs = 20) { const runner = new CoreRunner({ socketPath, claudeBin: "/fake/claude", codexBin: "/fake/codex", claudeHome: join(dir, "claude-home"), codexHome: join(dir, "codex-home"), contextHome: dir }, { pollMs, rpcTimeoutMs: 100, sendTimeoutMs: 150 }); runners.push(runner); return runner; } };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await Promise.all(f.runners.map((runner) => runner.shutdown())); for (const socket of f.sockets) socket.destroy(); await new Promise<void>((resolve) => f.server.close(() => resolve())); rmSync(f.dir, { recursive: true, force: true }); } });
const until = async (predicate: () => boolean) => { for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(10); expect(predicate()).toBe(true); };

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
    terminal.status = null; expect(await runner.send(member(), "message", f.opts)).toMatchObject({ ok: false, reason: "input_busy", retryable: false });
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
    const runner = f.runner(); await runner.start(codex, f.opts); f.setScreen("prior output\n› \n  ? for shortcuts\n"); expect(await runner.send(codex, "hello", f.opts)).toEqual({ ok: true });
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
    expect(await runner.send(member(), "automatic", f.opts)).toEqual({ ok: true });
  });
  test("done may send without unsupported exact condition; idle keeps atomic core condition", async () => {
    const f = await fixture(); const runner = f.runner(10000); const start = await runner.start(member(), f.opts);
    f.terminals.get(start.paneId)!.status = { state: "done" };
    expect(await runner.send(member(), "next turn", f.opts)).toEqual({ ok: true });
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
    f.setScreen(composer()); expect(await runner.applyConfig(member({ model: "new-model" }), f.opts)).toEqual({ ok: true });
    const launches = f.calls.filter((request) => request.method === "terminal.run"); expect(launches).toHaveLength(2); expect(launches[1].params.argv).toContain("--resume"); expect(launches[1].params.argv).toContain(first.sessionId); expect(launches[1].params.argv).toContain("new-model");
  });
  test("Codex supports configured max effort and subagent model without invented resume", async () => {
    const f = await fixture(); const launch = providerLaunch(member({ cli: "codex", effort: "max", subagentModel: "gpt-child" }), f.opts, { codexBin: "/fake/codex" });
    expect(launch.argv).toContain('model_reasoning_effort="max"'); expect(launch.argv).toContain('agents.default_subagent_model="gpt-child"'); expect(launch.argv).toContain("features.multi_agent=true");
  });
  test("Codex parallel preference instructs native subagents on the next task", async () => {
    const f = await fixture(); const runner = f.runner(10000); const codex = member({ cli: "codex" }); await runner.start(codex, f.opts); f.setScreen("› Ask Codex to do anything\n  GPT-6-Astra high Fast · /tmp\n  ← for agents · ? for shortcuts");
    expect(await runner.setParallel(codex, true, f.opts)).toEqual({ ok: true }); expect(await runner.send(codex, "implement the task", f.opts)).toEqual({ ok: true });
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
  expect(await runner.setParallel(member(), true, f.opts)).toEqual({ ok: true }); expect(runner.isBusy(member().id)).toBe(false);
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
  expect(events.find((event) => event.type === "context_usage")).toEqual({ type: "context_usage", memberId: member().id, sessionId: start.sessionId!, tokens: 190_000, shownPct: null, model: "claude-opus-5-5" });
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
  mkdirSync(join(f.dir, "context"));
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
