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
import { USAGE_RESUME_TEXT, usageLimitMenu } from "../server/api-outage.ts";
import { claudeFolderTrust, codexFolderTrust } from "../server/runner/core-approval.ts";
import { wrappedTrustScreens } from "./fixtures/folder-trust-160.ts";
import { rejection, thrower } from "./fixtures/settle.ts";

const methods = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill", "terminal.keys"];
const composer = (draft = "") => `prior output\n${"─".repeat(30)}\n❯ ${draft}\n${"─".repeat(30)}\n`;
const member = (extra: Partial<RunnerMember> = {}): RunnerMember => ({ id: "member-one", sessionGeneration: 1, projectId: "project-one", cli: "claude", handle: "worker", name: "Worker", cwd: "/tmp", sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker", ...extra });
interface Request { jsonrpc: string; id: string; method: string; params: Record<string, any> }
const fixtures: { dir: string; server: Server; sockets: Set<Socket>; runners: CoreRunner[] }[] = [];
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-core-test-"));
  const socketPath = join(dir, "c.sock");
  const opts: StartOpts = { systemPromptFile: join(dir, "rules.md"), mcpConfigFile: join(dir, "mcp.json"), resume: false };
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
          const terminal: CoreTerminal = { address: `t${terminals.size + 1}`, argv: params.argv, cwd: params.cwd, labels: params.labels, state: "live", cols: params.size?.cols ?? 200, rows: params.size?.rows ?? 120, turn: 0, status: { state: "idle", app: "claude-code" }, reported: true };
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
    // 폴더 신뢰 창은 160칸 미만의 한 줄 경로만 인정한다. 임시 폴더 경로가 길면 짧은 작업 폴더를 따로 쓴다.
    const cwd = Bun.stringWidth(f.dir) < 120 ? f.dir : mkdtempSync("/tmp/iamceo-ct-");
    const config = loadConfig({ IAMCEO_HOME: join(f.dir, "iamceo"), IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: f.socketPath,
      IAMCEO_CLAUDE_BIN: "/fake/claude", IAMCEO_CODEX_BIN: "/fake/codex", IAMCEO_CORE_BIN: "/usr/bin/false" });
    const db = openDb(config.dbPath); const store = new Store(db, new Bus());
    const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]),
      providerHomes: { claudeHome: join(f.dir, "claude-home"), codexHome: join(f.dir, "codex-home") }, timings: { healthMs: 1, tickMs: 60000 } });
    try {
      const project = store.createProject({ name: "신뢰", cwd });
      const m = await orch.createMember(project.id, { name: "worker" });
      f.terminals.get(m.paneId!)!.status = null; f.setScreen(trustScreen(cwd));
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
    } finally { await orch.shutdown(); db.close(); if (cwd !== f.dir) rmSync(cwd, { recursive: true, force: true }); }
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
  test("stream inputs return before an outstanding refresh and debounce to one post-input refresh", async () => {
    const f = await fixture(), runner = f.runner(60_000);
    const started = await runner.start(member(), f.opts);
    let held: { request: Request; socket: Socket } | undefined;
    f.setHook((request, socket) => {
      if (request.method === "terminal.get" && !held) { held = { request, socket }; return true; }
      return false;
    });
    const reading = runner.screen(member());
    await until(() => !!held);
    const writes: string[] = [];
    const before = f.calls.filter(c => c.method === "terminal.get").length;
    expect(await Promise.race([
      (async () => {
        await runner.noteTerminalInput(member().id, () => writes.push("A"));
        await runner.noteTerminalInput(member().id, () => writes.push("B"));
        return "written";
      })(), Bun.sleep(50).then(() => "blocked"),
    ])).toBe("written");
    expect(writes).toEqual(["A", "B"]);
    held!.socket.write(JSON.stringify({ jsonrpc: "2.0", id: held!.request.id, result: f.terminals.get(started.paneId) }) + "\n");
    await reading; f.setHook(null);
    await until(() => f.calls.filter(c => c.method === "terminal.get").length === before + 1);
    await Bun.sleep(250);
    expect(f.calls.filter(c => c.method === "terminal.get")).toHaveLength(before + 1);
  });
  test("blocked full-screen inspection cannot hold up PTY input", async () => {
    const f = await fixture(), runner = f.runner(60_000);
    const started = await runner.start(member(), f.opts);
    f.terminals.get(started.paneId)!.status = { state: "blocked", kind: "selection" };
    let held: { request: Request; socket: Socket } | undefined;
    f.setHook((request, socket) => {
      if (request.method === "terminal.read" && !held) { held = { request, socket }; return true; }
      return false;
    });
    const reading = runner.screen(member());
    await until(() => !!held);
    let writes = "";
    expect(await Promise.race([
      runner.noteTerminalInput(member().id, () => { writes += "AB"; }).then(() => "written"),
      Bun.sleep(50).then(() => "blocked"),
    ])).toBe("written");
    expect(writes).toBe("AB");
    held!.socket.write(JSON.stringify({ jsonrpc: "2.0", id: held!.request.id, result: { text: "unknown blocked screen" } }) + "\n");
    await reading; f.setHook(null);
  });
  test("fake core follows the 0.1.18 size schema and ignores top-level dimensions", async () => {
    const f = await fixture();
    const params = { argv: ["/fake/claude"], cwd: "/tmp", labels: {}, cols: 80, rows: 24 };
    const legacy = await coreRpc<CoreTerminal>(f.socketPath, "terminal.run", params);
    expect(await coreRpc(f.socketPath, "terminal.get", { terminal: legacy.address })).toMatchObject({ cols: 200, rows: 120 });
    const sized = await coreRpc<CoreTerminal>(f.socketPath, "terminal.run", { ...params, size: { cols: 160, rows: 50 } });
    expect(await coreRpc(f.socketPath, "terminal.get", { terminal: sized.address })).toMatchObject({ cols: 160, rows: 50 });
  });
  test("handshake validates generation and methods", async () => {
    const f = await fixture(); const runner = f.runner(); expect((await runner.available()).ok).toBe(true);
    f.setHook((request, socket) => { socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { generation: 1, version: "old", methods: [], features: [] } }) + "\n"); return true; });
    expect(await runner.available()).toMatchObject({ ok: false, detail: expect.stringContaining("missing methods") });
  });
  test("owned terminal launch uses argv, survives runner shutdown, rejoins without another launch", async () => {
    const f = await fixture(); const runner = f.runner(); const first = await runner.start(member(), f.opts);
    const launch = f.calls.find((request) => request.method === "terminal.run")!;
    expect(launch.params).toMatchObject({ size: { cols: 160, rows: 50 }, no_parent: true, outlive_parent: true, keep: false, wait: false });
    expect(launch.params).not.toHaveProperty("cols"); expect(launch.params).not.toHaveProperty("rows");
    expect(await runner.terminalInfo(member({ paneId: first.paneId }))).toEqual({ cols: 160, rows: 50 });
    expect(launch.params.env.XDG_CONFIG_HOME).toBeString(); expect(launch.params.env.XDG_STATE_HOME).toBeString(); expect(launch.params.env.HOME).toBe(process.env.HOME); expect(launch.params.argv[0]).toBe("/fake/claude"); expect(launch.params.argv).not.toContain("-p"); expect(launch.params.argv).toContain("--append-system-prompt-file");
    await runner.shutdown(); expect(f.calls.some((request) => ["terminal.kill", "server.stop"].includes(request.method))).toBe(false);
    Object.assign(f.terminals.get(first.paneId)!, { cols: 200, rows: 120 }); // A legacy session keeps its existing grid.
    const rejoinedRunner = f.runner();
    const recovered = await rejoinedRunner.start(member({ sessionId: first.sessionId, paneId: first.paneId }), { ...f.opts, resume: true });
    expect(recovered.rejoined).toBe(true); expect(recovered.paneId).toBe(first.paneId); expect(f.calls.filter((request) => request.method === "terminal.run")).toHaveLength(1);
    expect(await rejoinedRunner.terminalInfo(member({ paneId: first.paneId }))).toEqual({ cols: 200, rows: 120 });
  });
  test("explicit stop kills only owned terminal; changed labels refuse control", async () => {
    const f = await fixture(); const runner = f.runner(); const start = await runner.start(member(), f.opts); const terminal = f.terminals.get(start.paneId)!;
    terminal.labels["iamceo.member"] = "someone-else"; expect(await thrower(runner.stop(member()))).toThrow("ownership"); expect(f.calls.some((request) => request.method === "terminal.kill")).toBe(false);
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
  test("startup helper refuses implicit or user-global daemon configuration", async () => { expect(await thrower(ensureCoreServer({}))).toThrow("explicit"); });
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
  test("a held slow employee does not block healthy polls; only that employee backs off and recovers", async () => {
    // Measure scheduling time independently of host load, while keeping real
    // sockets, the held reply, RPC deadlines and concurrent polling intact.
    let now = -1;
    const f = await fixture(); const runner = f.runner(20, { rpcTimeoutMs: 500, pollConcurrency: 2, pollNow: () => now });
    const slow = await runner.start(member({ id: "slow" }), f.opts);
    const fast = await runner.start(member({ id: "fast" }), f.opts);
    const gets: { terminal: string; at: number }[] = [];
    let held: { request: Request; socket: Socket } | null = null;
    f.setHook((request, socket) => {
      if (request.method !== "terminal.get") return false;
      gets.push({ terminal: request.params.terminal, at: now });
      if (request.params.terminal !== slow.paneId || held) return false;
      held = { request, socket }; return true;
    });
    const polling = runner as unknown as { poll(): void; polling: Set<unknown>; tracks: Map<string, { refresh: Promise<unknown> | null }> };
    let released = false;
    async function pollAt(at: number) {
      now = at;
      polling.poll();
      await until(() => [...polling.tracks].every(([id, track]) =>
        (id === "slow" && !released) || (!track.refresh && !polling.polling.has(track))));
    }
    for (const at of [0, 20, 40, 60]) await pollAt(at);
    expect(gets.filter(r => r.terminal === fast.paneId).map(r => r.at)).toEqual([0, 20, 40, 60]);
    expect(gets.filter(r => r.terminal === slow.paneId)).toHaveLength(1);
    expect(polling.polling.size).toBe(1);
    const resolvedAt = now;
    const reply = held as unknown as { request: Request; socket: Socket };
    released = true;
    reply.socket.write(JSON.stringify({ jsonrpc: "2.0", id: reply.request.id, result: f.terminals.get(slow.paneId) }) + "\n");
    await until(() => polling.polling.size === 0 && [...polling.tracks.values()].every(track => !track.refresh));
    await pollAt(99); expect(gets.filter(r => r.terminal === slow.paneId)).toHaveLength(1);
    await pollAt(100);
    await pollAt(119); expect(gets.filter(r => r.terminal === slow.paneId)).toHaveLength(2);
    await pollAt(120);
    const slowGets = gets.filter(r => r.terminal === slow.paneId);
    expect(slowGets.map(r => r.at)).toEqual([0, 100, 120]);
    expect(slowGets[1].at - resolvedAt).toBeGreaterThanOrEqual(35);
    expect(slowGets[2].at - slowGets[1].at).toBeLessThan(75);
    expect(runner.observationState("slow")?.failures).toBe(0);
    expect(f.calls.some(r => ["terminal.send", "terminal.keys", "terminal.kill"].includes(r.method))).toBe(false);
  });
  test("poll concurrency is bounded, each employee has one in-flight read and waiting employees get the next slot", async () => {
    const f = await fixture(); const runner = f.runner(20, { rpcTimeoutMs: 1000, pollConcurrency: 2 });
    for (let i = 0; i < 5; i++) await runner.start(member({ id: `employee-${i}` }), f.opts);
    const held: { request: Request; socket: Socket }[] = [];
    f.setHook((request, socket) => {
      if (request.method !== "terminal.get") return false;
      held.push({ request, socket }); return true;
    });
    await until(() => held.length === 2); await Bun.sleep(60);
    expect(held).toHaveLength(2);
    expect(new Set(held.map(r => r.request.params.terminal)).size).toBe(2);
    const first = held[0];
    first.socket.write(JSON.stringify({ jsonrpc: "2.0", id: first.request.id, result: f.terminals.get(first.request.params.terminal) }) + "\n");
    await until(() => held.length === 3);
    expect(new Set(held.map(r => r.request.params.terminal)).size).toBe(3);
    await runner.shutdown();
    for (const reply of held.slice(1)) reply.socket.write(JSON.stringify({ jsonrpc: "2.0", id: reply.request.id, result: f.terminals.get(reply.request.params.terminal) }) + "\n");
    const calls = f.calls.length; await Bun.sleep(50); expect(f.calls).toHaveLength(calls);
  });
  test("failed observations back off per employee without reporting death, and a healthy reply resets the cadence", async () => {
    // Freeze only scheduling time. Socket RPCs remain real, so a loaded host's
    // read latency cannot accidentally turn the healthy employee into a slow one.
    let now = -1;
    const f = await fixture(); const runner = f.runner(20, { pollNow: () => now });
    const slow = await runner.start(member({ id: "failing" }), f.opts);
    const fast = await runner.start(member({ id: "healthy" }), f.opts);
    const events: RunnerEvent[] = []; runner.on(e => events.push(e));
    const times: number[] = []; let failing = true;
    f.setHook((request, socket) => {
      if (request.method !== "terminal.get" || request.params.terminal !== slow.paneId) return false;
      times.push(now);
      if (!failing) return false;
      socket.destroy(); return true;
    });
    const polling = runner as unknown as { poll(): void; polling: Set<unknown>; tracks: Map<string, { refresh: Promise<unknown> | null }> };
    async function pollAt(at: number) {
      now = at;
      polling.poll();
      await until(() => polling.polling.size === 0 && [...polling.tracks.values()].every(track => !track.refresh));
    }
    await pollAt(0);
    await pollAt(20);
    await pollAt(39); expect(times).toEqual([0]);
    await pollAt(40);
    for (const at of [60, 80, 100, 119]) await pollAt(at);
    expect(times).toEqual([0, 40]);
    await pollAt(120);
    expect(times).toEqual([0, 40, 120]);
    expect(f.calls.filter(r => r.method === "terminal.get" && r.params.terminal === fast.paneId).length).toBeGreaterThan(times.length);
    expect(events.some(e => e.type === "status" && e.status === "gone")).toBe(false);
    failing = false;
    await pollAt(279); expect(times).toEqual([0, 40, 120]);
    await pollAt(280);
    await pollAt(299); expect(times).toEqual([0, 40, 120, 280]);
    await pollAt(300);
    await pollAt(320);
    expect(times).toEqual([0, 40, 120, 280, 300, 320]);
    expect(runner.observationState("failing")?.failures).toBe(0);
    expect(f.calls.some(r => ["terminal.send", "terminal.keys", "terminal.kill"].includes(r.method))).toBe(false);
  });
  test("Codex uses official interactive command and scoped TOML MCP; unknown native id is not invented", async () => {
    const f = await fixture(); const codex = member({ cli: "codex", model: "gpt-test", effort: "xhigh" }); const launch = providerLaunch(codex, f.opts, { codexBin: "/fake/codex" });
    expect(launch.argv[0]).toBe("/fake/codex"); expect(launch.argv).not.toContain("exec"); expect(launch.argv).toContain('model_reasoning_effort="xhigh"'); expect(launch.argv).toContain('mcp_servers.iamceo.command="/bin/echo"'); expect(launch.argv).toContain('mcp_servers.iamceo.env_vars=["IAMCEO_TOKEN","IAMCEO_URL"]'); expect(launch.env.IAMCEO_TOKEN).toBe("secret"); expect(launch.argv.join(" ")).not.toContain("secret"); expect(launch.sessionId).toBeNull();
    // Codex 0.166's start-up update menu defaults to `npm install -g`; IAMCEO launches never show it.
    expect(launch.argv).toContain("check_for_update_on_startup=false");
    expect(() => providerLaunch(codex, { ...f.opts, resume: true }, { codexBin: "/fake/codex" })).toThrow("unknown");
    const runner = f.runner(); await runner.start(codex, f.opts); f.setScreen("prior output\n› \n  ? for shortcuts\n"); expect(await runner.send(codex, "hello", f.opts)).toMatchObject({ ok: true });
  });
  test("Codex draft safety rejects typed/wrapped/unknown content", () => {
    expect(codexDraft("output\n› \n  ? for shortcuts")).toBe(""); expect(codexDraft("› Ask Codex to do anything\n\n  GPT-6-Astra high Fast · /private/tmp/iamceo-core-qa\n  ← for agents · ? for shortcuts")).toBe(""); expect(codexDraft("› keep my draft\n  ? for shortcuts")).toBe("keep my draft"); expect(codexDraft("› first\nsecond line\n  ? for shortcuts")).toBeNull(); expect(codexDraft("Approve? Yes/No")).toBeNull();
  });
});


describe("manual terminal control", () => {
  test("release revokes only the matching lease even after terminal.get becomes not_found", async () => {
    const f = await fixture(), runner = f.runner(10000), started = await runner.start(member(), f.opts);
    const lease = await runner.terminalControl(member(), { action: "claim" });
    f.terminals.delete(started.paneId);
    const calls = f.calls.length;
    expect(await thrower(runner.terminalControl(member(), { action: "release", leaseId: "foreign" }))).toThrow("lease");
    expect(await thrower(runner.terminalControl(member({ sessionGeneration: 2 }), { action: "release", leaseId: lease.leaseId }))).toThrow();
    expect(runner.terminalLease(member().id)?.leaseId).toBe(lease.leaseId);
    await runner.terminalControl(member(), { action: "release", leaseId: lease.leaseId });
    expect(runner.terminalLease(member().id)).toBeNull();
    expect(f.calls.length).toBe(calls);
  });
  test("token lease pauses automation; input/keys require owner token; release resumes", async () => {
    const f = await fixture(); const runner = f.runner(10000); const start = await runner.start(member(), f.opts);
    const lease = await runner.terminalControl(member(), { action: "claim" }); expect(lease.leaseId).toBeString();
    expect(await runner.send(member(), "automatic", f.opts)).toMatchObject({ ok: false, reason: "input_busy", retryable: true });
    expect(await thrower(runner.terminalControl(member(), { action: "claim" }))).toThrow("lease");
    expect(await thrower(runner.terminalControl(member(), { action: "key", key: "enter", leaseId: "wrong" }))).toThrow("lease");
    expect(await thrower(runner.terminalControl(member(), { action: "key", key: "f5", leaseId: lease.leaseId }))).toThrow("Unsupported");
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
    expect(await thrower(runner.start(member({ id: "other-member", sessionId: first.sessionId }), { ...f.opts, resume: true }))).toThrow("already owned"); expect(f.calls.filter((request) => request.method === "terminal.run")).toHaveLength(1);
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
  expect(await thrower(runner.start(member({ cli: "codex", paneId: "t-missing", sessionId: null }), f.opts))).toThrow("native session id is unknown"); expect(f.calls.some((request) => request.method === "terminal.run")).toBe(false);
});

test("stop and provider switch preserve a visible user draft", async () => {
  const f = await fixture(); const runner = f.runner(10000); await runner.start(member(), f.opts); f.setScreen(composer("unsaved message"));
  expect(await thrower(runner.checkStop(member()))).toThrow("draft"); expect(await thrower(runner.stop(member()))).toThrow("draft"); expect(f.calls.some((request) => request.method === "terminal.kill")).toBe(false);
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
  // (옛 실행기의 "context" 이벤트 종류는 계약에서 없앴다. 문맥에 관한 이벤트는 사용량 보고뿐이어야 한다.)
  expect(events.filter((event) => event.type.startsWith("context")).every((event) => event.type === "context_usage")).toBe(true);
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
    f.setHook(null); terminal.turn = 8; terminal.status = { state: "working" }; expect(await thrower(runner.screen(member()))).toThrow("older");
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
    // 입력칸이 보이는 채 보고만 사라진 끝난 턴은 이제 쉬는 중으로 읽는다(stab-srv-runner-core). 입력칸이 안 보이는 화면은 그대로 막는다.
    f.setScreen("An unrecognized dialog"); terminal.status = null; await runner.screen(member()); expect(events.findLast(e => e.type === "status")).toMatchObject({ status: "blocked", blockedReason: "status_unknown" });
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
    expect(await thrower(runner.start({ ...codex, paneId: null }, f.opts))).toThrow("native session id is unknown");
    expect(f.calls.filter(c => c.method === "terminal.run")).toHaveLength(1);
  });
});

describe("persistent input safety and transport effects", () => {
  test("an unknown write on an observed-idle CLI fences delivery but does not hold a turn slot", async () => {
    // Real 2026-11-07 run: such a phantom turn kept maxConcurrentTurns=2 at an effective 1 for every other member.
    const f = await fixture(), runner = f.runner(); await runner.start(member(), f.opts);
    const track = (runner as unknown as { tracks: Map<string, { uncertain: boolean; status: string; pending: boolean }> }).tracks.get(member().id)!;
    track.uncertain = true; track.status = "idle"; track.pending = false;
    expect(runner.isBusy(member().id)).toBe(true);
    expect(runner.occupiesTurnSlot(member().id)).toBe(false);
    track.status = "working"; expect(runner.occupiesTurnSlot(member().id)).toBe(true);
    track.status = "blocked"; expect(runner.occupiesTurnSlot(member().id)).toBe(true);
    track.uncertain = false; track.status = "idle"; expect(runner.occupiesTurnSlot(member().id)).toBe(false);
    track.pending = true; expect(runner.occupiesTurnSlot(member().id)).toBe(true);
    await runner.shutdown();
  });
  test("lease survives restart and same claim id is reclaimable before automated input", async () => {
    const f = await fixture(), recovery = recoveryStore(), first = f.runner(10000, { recoveryStore: recovery.port }); const started = await first.start(member(), f.opts);
    const lease = await first.terminalControl(member(), { action: "claim", leaseId: "client-claim" }); expect(lease.leaseId).not.toBe("client-claim"); await first.shutdown();
    const second = f.runner(10000, { recoveryStore: recovery.port }); await second.start(member({ paneId: started.paneId, sessionId: started.sessionId }), f.opts);
    expect(await second.send(member(), "automatic", f.opts)).toMatchObject({ ok: false, reason: "input_busy", deliveryEffect: "not_written" });
    expect(await second.terminalControl(member(), { action: "claim", leaseId: "client-claim" })).toMatchObject({ leaseId: lease.leaseId });
    await second.terminalControl(member(), { action: "release", leaseId: lease.leaseId }); expect(recovery.lease()).toBeNull();
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
    expect(await thrower(runner.terminalControl(member(), { action: "claim" }))).toThrow("mutation"); await sending; f.setHook(null);
    f.terminals.get(started.paneId)!.status = { state: "working" }; expect(await thrower(runner.stop(member(), { whileWorking: false }))).toThrow(); expect(f.calls.some(c => c.method === "terminal.kill")).toBe(false);
  });
  test("pre-connect failure is not_written; JSON-RPC denial is rejected; started:false is received", async () => {
    const f = await fixture(); expect(await rejection(coreRpc(join(f.dir, "missing.sock"), "terminal.send", {}, 30))).toMatchObject({ deliveryEffect: "not_written", uncertain: false, causeCode: "ENOENT" });
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
  // delivery-3: 수신 확인이 세션 기록을 처음부터 4MB 씩 읽어, 기록이 큰 직원은 전달된 글도 확인에 수십 분이 걸렸다.
  test("an envelope's log baseline makes one inspection read only what was appended after the send", async () => {
    const d = await deliveryFixture();
    // 9MB 의 지난 기록: 예전 방식이면 검사 한 번에 4MB 씩이라 세 번째 검사에서야 끝에 닿는다.
    const filler = d.user("x".repeat(900), "old");
    writeFileSync(d.path, filler.repeat(Math.ceil(9 * 1024 * 1024 / filler.length)), { flag: "a" });
    const logs = d.runner.deliveryBaseline(member());
    expect(logs).toEqual([{ path: d.path, fileIdentity: expect.any(String), offset: statSync(d.path).size, eventId: null }]);
    d.dispatch.baseline = { ...d.dispatch.baseline, logs }; d.recovery.dispatches([d.dispatch]);
    const before = await d.runner.inspectDelivery(member(), d.dispatch);
    expect(before.evidence[0]).toMatchObject({ verdict: "absent", complete: true, code: "complete_range_without_marker" });
    writeFileSync(d.path, d.user(d.dispatch.wireText, "receipt"), { flag: "a" });
    expect(await d.runner.inspectDelivery(member(), d.dispatch)).toMatchObject({ finding: "received", receivedDeliveryIds: ["delivery"] });
  });
  test("a log that ends in a partial line gives no baseline, and an unknown session gives none either", async () => {
    const d = await deliveryFixture();
    writeFileSync(d.path, '{"type":"user","sessionId":"', { flag: "a" });
    expect(d.runner.deliveryBaseline(member())).toEqual([]);
    expect(d.runner.deliveryBaseline(member({ id: "someone-else" }))).toEqual([]);
  });
  test("an envelope without a baseline keeps reading within one inspection instead of 4 MiB per check", async () => {
    const d = await deliveryFixture(); await d.runner.shutdown();
    const runner = d.f.runner(10000, { recoveryStore: d.recovery.port, evidenceScanMs: 60_000 });
    await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    const filler = d.user("x".repeat(900), "old");
    writeFileSync(d.path, filler.repeat(Math.ceil(13 * 1024 * 1024 / filler.length)), { flag: "a" });
    writeFileSync(d.path, d.user(d.dispatch.wireText, "receipt"), { flag: "a" });
    expect(statSync(d.path).size).toBeGreaterThan(12 * 1024 * 1024);
    expect(await runner.inspectDelivery(member(), d.dispatch)).toMatchObject({ finding: "received", receivedDeliveryIds: ["delivery"] });
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
    expect(d.f.calls.find(c => c.method === "terminal.send")!.params).toMatchObject({ if: "idle", force: false });
  });
  // review runner-recovery-3: after any turn the CLI reports done; the repair write refused it and the resend went
  // round through reject → requeue → ordinary send, outside the three-attempt cap.
  test("a CLI that finished a turn (done) takes the repair write directly, under the same rule as an ordinary send", async () => {
    const d = await deliveryFixture(); await d.runner.shutdown(); d.dispatch.transportState = "rejected"; let prepared = 0;
    const runner = d.f.runner(10000, { recoveryStore: d.recovery.port, quiescence: () => ({ originalWrite: "rejected", externalInput: false }), repair: { load: () => d.dispatch, prepare: () => { prepared++; return true; } } });
    await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
    d.f.terminals.get(d.started.paneId)!.status = { state: "done" };
    const inspection = await runner.inspectDelivery(member(), d.dispatch);
    expect(inspection).toMatchObject({ finding: "not_received", snapshot: { status: "done", composer: "empty" } });
    const request: DeliveryRepair = { action: "resend", dispatchId: "dispatch", expectedRecoveryVersion: 1, expectedSessionGeneration: 1, expectedSessionId: d.started.sessionId, expectedTerminalId: d.started.paneId, expectedInputEpoch: inspection.snapshot!.inputEpoch! };
    // A draft in the composer or a working CLI still refuses before the durable prepare.
    d.f.setScreen(composer("someone is typing"));
    expect(await runner.repairDelivery(member(), request)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
    d.f.setScreen(composer()); d.f.terminals.get(d.started.paneId)!.status = { state: "working" };
    expect(await runner.repairDelivery(member(), request)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
    expect(prepared).toBe(0); expect(d.f.calls.some(c => c.method === "terminal.send")).toBe(false);
    d.f.terminals.get(d.started.paneId)!.status = { state: "done" };
    const again = await runner.inspectDelivery(member(), d.dispatch);
    expect(await runner.repairDelivery(member(), { ...request, expectedInputEpoch: again.snapshot!.inputEpoch! })).toMatchObject({ ok: true, receipt: { dispatchId: "dispatch" } });
    const sent = d.f.calls.filter(c => c.method === "terminal.send"); expect(sent).toHaveLength(1);
    expect(sent[0]!.params.text).toBe(d.dispatch.wireText); expect(sent[0]!.params.force).toBe(false); expect(sent[0]!.params.if).toBeUndefined();
  });
  // review runner-recovery-1: the evidence cursor is kept per envelope, but a check may ask about only some items.
  test("a check about fewer items of a bundle is read afresh instead of staying generation_changed", async () => {
    const d = await deliveryFixture();
    const bundle: DeliveryDispatch = { ...d.dispatch, markers: [...d.dispatch.markers, { deliveryId: "memo", marker: "#iamceo_" + "C".repeat(22) }], items: [...d.dispatch.items, { deliveryId: "memo", ordinal: 1, sourceRevision: null }] };
    d.recovery.dispatches([bundle]);
    const whole = await d.runner.inspectDelivery(member(), bundle);
    expect(whole.evidence[0]).toMatchObject({ verdict: "absent", complete: true });
    for (const query of [{ ...bundle, markers: bundle.markers.slice(0, 1) }, { ...bundle, markers: bundle.markers.slice(1) }, bundle]) {
      expect((await d.runner.inspectDelivery(member(), query)).evidence[0]).toMatchObject({ verdict: "absent", complete: true, code: whole.evidence[0]!.code });
    }
    // The partial question still finds a receipt written after the earlier reads.
    writeFileSync(d.path, d.user(`task\n${bundle.markers[0]!.marker}\n\nmemo\n${bundle.markers[1]!.marker}\n${bundle.bundleMarker}`, "receipt"), { flag: "a" });
    expect((await d.runner.inspectDelivery(member(), { ...bundle, markers: bundle.markers.slice(1) })).receivedDeliveryIds).toEqual(["memo"]);
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
  test("drafts, working and unavailable persistence send no compact input; a finished (done) CLI compacts like a delivery", async () => {
    // Real 2026-11-07 run: core keeps a CLI in "done" after every turn, so an idle-only compact never ran and its
    // pending state fenced the member's queue. done now follows the normal delivery rule (client-side checks, no if:"idle").
    const d = await deliveryFixture(), store = compactStore(); await d.runner.shutdown(); d.recovery.dispatches([]);
    const runner = d.f.runner(10000, { compactStore: store.port }); await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts); const terminal = d.f.terminals.get(d.started.paneId)!;
    terminal.status = { state: "done" }; d.f.setScreen(composer("user draft")); expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: false, reason: "input_busy", deliveryEffect: "not_written" });
    terminal.status = { state: "idle" }; d.f.setScreen(composer("user draft")); expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: false, reason: "input_busy" });
    d.f.setScreen(composer()); terminal.status = { state: "working" }; expect(await runner.compact(member(), "focus", d.f.opts)).toMatchObject({ ok: false });
    expect(d.f.calls.some(c => c.method === "terminal.send")).toBe(false);
    await runner.shutdown();
    const e = await deliveryFixture(), store2 = compactStore(); await e.runner.shutdown(); e.recovery.dispatches([]);
    const fresh = e.f.runner(10000, { compactStore: store2.port }); const finished = e.f.terminals.get(e.started.paneId)!;
    finished.status = { state: "done" }; e.f.setScreen(composer());
    await fresh.start(member({ paneId: e.started.paneId, sessionId: e.started.sessionId }), e.f.opts);
    expect(await fresh.compact(member(), "focus", e.f.opts)).toMatchObject({ ok: true });
    const sends = e.f.calls.filter(c => c.method === "terminal.send");
    expect(sends).toHaveLength(1); expect(sends[0]!.params.text).toBe("/compact focus"); expect(sends[0]!.params.if).toBeUndefined();
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
  test("stream writes arm the same compact recovery proof; later turn settles without compact success", async () => {
    const d = await uncertainCompactFixture();
    await d.runner.noteTerminalInput(member().id, () => {});
    expect(d.store.states.get(member().id)?.phase).toBe("uncertain");
    expect(d.store.states.get(member().id)?.manualResolution).toBeDefined();
    d.terminal.turn = 1; d.terminal.status = { state: "idle" }; await d.runner.screen(member());
    expect(d.store.states.get(member().id)).toMatchObject({phase:"failed",reason:"user_resolved"});
    expect(d.events.some(e=>e.type==="compacted" || e.type==="turn_end")).toBe(false);
  });
  test("failed stream write clears old manual proof and unchanged idle does not resolve compact", async () => {
    const d = await uncertainCompactFixture();
    await d.runner.noteTerminalInput(member().id, () => {});
    await d.runner.screen(member()); expect(d.store.states.get(member().id)?.phase).toBe("uncertain");
    expect(await thrower(d.runner.noteTerminalInput(member().id, () => { throw new Error("write failed"); }))).toThrow("write failed");
    expect(d.store.states.get(member().id)?.manualResolution).toBeUndefined();
    d.terminal.turn = 1; await d.runner.screen(member());
    expect(d.store.states.get(member().id)?.phase).toBe("uncertain");
    await d.runner.noteTerminalInput(member().id, () => {});
    d.terminal.status = {state:"working"}; await d.runner.screen(member());
    d.terminal.status = {state:"idle"}; await d.runner.screen(member());
    expect(d.store.states.get(member().id)).toMatchObject({phase:"failed",reason:"user_resolved"});
  });
  test("a pre-write stream observation cannot settle compact before a fresh post-write observation", async () => {
    const d = await uncertainCompactFixture();
    let observation: {request: Request; socket: Socket} | null = null;
    d.f.setHook((request,socket)=>{
      if (request.method === "terminal.get" && !observation) { observation={request,socket}; return true; }
      return false;
    });
    const reading = d.runner.screen(member()); await until(()=>observation!==null);
    const input = d.runner.noteTerminalInput(member().id,()=>{ d.terminal.turn=1; d.terminal.status={state:"working"}; });
    observation!.socket.write(JSON.stringify({jsonrpc:"2.0",id:observation!.request.id,result:{...d.terminal,status:{state:"idle"}}})+"\n");
    await Promise.all([reading,input]); d.f.setHook(null);
    expect(d.store.states.get(member().id)?.phase).toBe("uncertain");
    d.terminal.status={state:"idle"}; await d.runner.screen(member());
    expect(d.store.states.get(member().id)).toMatchObject({phase:"failed",reason:"user_resolved"});
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
    expect(await thrower(d.runner.terminalControl(member(), { action: "key", key: "esc", leaseId: lease.leaseId }))).toThrow(); d.f.setHook(null);
    d.terminal.turn = 2; d.terminal.status = { state: "idle" }; await d.runner.screen(member());
    await d.runner.terminalControl(member(), { action: "release", leaseId: lease.leaseId }); await d.runner.screen(member());
    expect(d.store.states.get(member().id)?.phase).toBe("uncertain"); expect(d.runner.isBusy(member().id)).toBe(true);
  });
  test("a later unknown human input discards earlier ACK proof and keeps unresolved delivery fenced", async () => {
    const d = await uncertainCompactFixture(), lease = await d.runner.terminalControl(member(), { action: "claim" });
    await d.runner.terminalControl(member(), { action: "key", key: "esc", leaseId: lease.leaseId });
    expect(d.store.states.get(member().id)?.manualResolution).toBeDefined();
    d.f.setHook((request, socket) => { if (request.method !== "terminal.keys") return false; socket.destroy(); return true; });
    expect(await thrower(d.runner.terminalControl(member(), { action: "key", key: "enter", leaseId: lease.leaseId }))).toThrow(); d.f.setHook(null);
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
    expect(await thrower(runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts))).toThrow("disk full");
    expect(runner.isBusy(member().id)).toBe(true); expect(d.store.states.get(member().id)?.phase).toBe("uncertain");
    fail = false; d.terminal.labels["iamceo.generation"] = "2"; expect(await thrower(runner.screen(member()))).toThrow("ownership");
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
  expect(await rejection(runner.start(member(), { ...f.opts, operationId: "stable-operation" }))).toMatchObject({ uncertain: true }); f.setHook(null);
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
  expect(await rejection(runner.start(member(), f.opts))).toMatchObject({ uncertain: true, kind: "protocol" }); f.setHook(null);
  expect(await rejection(runner.start(member(), f.opts))).toMatchObject({ kind: "starting_unknown" });
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

test("terminal identity change never authorizes a repair write while the old terminal may be alive; absence is only decided for a terminal confirmed gone", async () => {
  // 옛 터미널이 살아 있을 수 있는 동안: 지금 터미널의 기록·입력칸이 아무리 깨끗해도 다른 터미널의 봉투를 여기에 다시 쓰지 않는다.
  let prepared = 0;
  const d = await deliveryFixture(); await d.runner.shutdown();
  const runner = d.f.runner(10000, { recoveryStore: d.recovery.port, quiescence: () => ({ originalWrite: "settled", externalInput: false, unconfirmed: true }), repair: { load: () => old, prepare: () => { prepared++; return true; } } });
  await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
  const identity = runner.observationState(member().id)!.identity;
  const old = { ...d.dispatch, identity: { ...identity, terminalId: "previous-terminal" } };
  const seen = await runner.inspectDelivery(member(), old);
  expect(seen.snapshot?.identity.terminalId).toBe(d.started.paneId);
  expect(seen.evidence[0]).toMatchObject({ code: "complete_range_without_marker", verdict: "absent", complete: true });
  const request = { action: "resend" as const, dispatchId: old.dispatchId, expectedRecoveryVersion: 1, expectedSessionGeneration: identity.sessionGeneration, expectedSessionId: identity.sessionId, expectedTerminalId: "previous-terminal", expectedInputEpoch: seen.snapshot!.inputEpoch! };
  expect(await runner.repairDelivery(member(), request)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
  expect(prepared).toBe(0); expect(d.f.calls.filter(c => c.method === "terminal.send")).toHaveLength(0);

  // 그 터미널이 사라졌는지는 엔진의 답으로만 정한다: 끝났다고 알리거나, 모른다고 확정해 답해야 한다. 살아 있거나 답이 없으면 아니다.
  expect(await runner.terminalGone(d.started.paneId)).toBe(false);
  expect(await runner.terminalGone("previous-terminal")).toBe(true); // not_found
  d.f.setHook(request => request.method === "terminal.get"); // 엔진이 답하지 않는다
  const silent = d.f.runner(10000, { rpcTimeoutMs: 40 });
  expect(await silent.terminalGone("previous-terminal")).toBe(false);
  d.f.setHook(null);
  d.f.terminals.get(d.started.paneId)!.state = "finished";
  expect(await runner.terminalGone(d.started.paneId)).toBe(true);

  // 사라진 것이 확정된 터미널의 봉투는 터미널 없이(RPC 없이) 세션 기록만으로 판정한다.
  const target = member({ paneId: null, sessionId: d.started.sessionId });
  const rpcs = d.f.calls.length;
  expect(runner.inspectGoneDelivery(target, old)).toMatchObject({ finding: "not_received", receivedDeliveryIds: [], snapshot: null, quiescence: "settled", evidence: [{ source: "claude_log", code: "complete_range_without_marker", verdict: "absent", complete: true }] });
  // 죽은 CLI 가 쓰다 만 줄이 남으면 범위를 끝까지 읽지 못한 것이다: 못 받았다고 하지 않는다.
  writeFileSync(d.path, '{"type":"user","message":{"role":"us', { flag: "a" });
  expect(runner.inspectGoneDelivery(target, old)).toMatchObject({ finding: "unknown", receivedDeliveryIds: [], evidence: [{ verdict: "unknown", complete: false }] });
  // 수신 표지가 있으면 받은 것이다.
  writeFileSync(d.path, d.user("an earlier unrelated input") + d.user(d.dispatch.wireText, "user-2"));
  expect(runner.inspectGoneDelivery(target, old)).toMatchObject({ finding: "received", receivedDeliveryIds: ["delivery"], evidence: [{ code: "marker_in_user_input", verdict: "present" }] });
  // 다른 대화(세션이 바뀜)의 기록으로는 판정하지 않는다.
  expect(runner.inspectGoneDelivery(member({ paneId: null, sessionId: "another-native" }), old)).toMatchObject({ finding: "unknown", evidence: [{ code: "identity_changed" }] });
  expect(runner.inspectGoneDelivery(member({ paneId: null, sessionId: d.started.sessionId, sessionGeneration: 2 }), old)).toMatchObject({ finding: "unknown", evidence: [{ code: "identity_changed" }] });
  expect(d.f.calls.length).toBe(rpcs);
});

test("a terminal is tracked and fenced, not orphaned, when the persisted input state cannot be read at bind", async () => {
  // 저장된 압축 상태를 읽지 못하면(예: 기준선 없는 미확정 압축) 예전에는 방금 만든 터미널을 추적에 넣지 못한 채 start 가 실패했다:
  // 주인 없는 터미널이 남고, 기동 결과를 모르는 것으로 적혀 뒤따르는 깨우기가 모두 막혔다.
  const f = await fixture(); let broken = true;
  const store = compactStore();
  const runner = f.runner(10000, { compactStore: { load: id => { if (broken) throw new Error("미확정 압축의 baseline이 없어 자동 입력을 보류합니다"); return store.port.load(id); }, save: store.port.save } });
  const started = await runner.start(member(), f.opts);
  expect(f.terminals.get(started.paneId)?.state).toBe("live");
  expect(runner.observationState(member().id)?.identity.terminalId).toBe(started.paneId);
  expect(f.calls.filter(c => c.method === "terminal.run")).toHaveLength(1);
  // 입력은 넣지 않는다.
  expect(runner.isBusy(member().id)).toBe(true);
  expect(await runner.send(member(), "work", f.opts)).toMatchObject({ ok: false, reason: "busy", deliveryEffect: "not_written" });
  expect(await runner.compact(member({ sessionId: started.sessionId }), "focus", f.opts)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
  expect(f.calls.filter(c => c.method === "terminal.send")).toHaveLength(0);
  // 다시 시작해도 같은 터미널에 붙는다(둘이 되지 않는다).
  expect(await runner.start(member({ paneId: started.paneId, sessionId: started.sessionId }), f.opts)).toMatchObject({ paneId: started.paneId });
  expect(f.calls.filter(c => c.method === "terminal.run")).toHaveLength(1);
  // 저장 상태가 다시 읽히면 보류가 풀린다.
  broken = false;
  expect(await runner.send(member(), "work", f.opts)).toMatchObject({ ok: true });
  expect(f.calls.filter(c => c.method === "terminal.send")).toHaveLength(1);
});

test("a compact attempt the caller gave up on before the baseline was saved never persists or writes afterwards", async () => {
  // 총괄의 단계 제한이 압축의 확인 읽기 도중에 걸렸다. 그 읽기가 뒤늦게 답해도 실행기는 기준선을 저장하지도, 명령을 넣지도 않는다:
  // 총괄은 이 시도를 '넣지 못함'으로 적고 다시 예약했으므로, 여기서 진행하면 묶인 곳 없는 압축이 생긴다.
  const d = await deliveryFixture(), store = compactStore(); await d.runner.shutdown(); d.recovery.dispatches([]);
  const runner = d.f.runner(10000, { compactStore: store.port }); await runner.start(member({ paneId: d.started.paneId, sessionId: d.started.sessionId }), d.f.opts);
  // 압축이 화면을 읽는 순간, 범위 밖의 관측(주기 관측과 같은 길)이 같은 터미널을 읽기 시작한다. 그 조회를 붙잡아 두면
  // 압축의 마지막 확인 읽기(기준선 저장 직전)는 이 조회에 얹혀 기다린다: 단계 제한이 걸려도 이 조회는 평소대로 답한다.
  let held: { request: Request; socket: Socket } | null = null, shared: Promise<string> | null = null;
  d.f.setHook((request, socket) => {
    if (request.method === "terminal.read" && !shared) { shared = runner.screen(member({ sessionId: d.started.sessionId })); shared.catch(() => {}); return false; }
    if (request.method === "terminal.get" && shared && !held) { held = { request, socket }; return true; }
    return false;
  });
  const controller = new AbortController();
  const attempt = runner.withSignal(controller.signal, () => {}, () => runner.compact(member({ sessionId: d.started.sessionId }), "focus", d.f.opts), Date.now() + 5000);
  await until(() => held !== null);
  await Bun.sleep(30);
  controller.abort(new CoreError("timeout", "Pump stage compact exceeded", true));
  d.f.setHook(null);
  held!.socket.write(JSON.stringify({ jsonrpc: "2.0", id: held!.request.id, result: d.f.terminals.get(d.started.paneId) }) + "\n");
  expect(await attempt).toMatchObject({ ok: false, deliveryEffect: "not_written" });
  expect(store.states.size).toBe(0);
  expect(d.f.calls.some(c => c.method === "terminal.send")).toBe(false);
  // 다음 시도는 평소대로 된다.
  expect(await runner.compact(member({ sessionId: d.started.sessionId }), "focus", d.f.opts)).toMatchObject({ ok: true });
  expect(d.f.calls.filter(c => c.method === "terminal.send")).toHaveLength(1);
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

// Plain terminal.read snapshots: wrap at 160 columns and keep exactly 50 rows.
function screen160x50(text: string): string {
  const wrapped = text.trimEnd().split("\n").flatMap(line => {
    const chars = Array.from(line);
    return Array.from({ length: Math.max(1, Math.ceil(chars.length / 160)) }, (_, i) => chars.slice(i * 160, (i + 1) * 160).join("").padEnd(160));
  });
  return [...Array(Math.max(0, 50 - wrapped.length)).fill(" ".repeat(160)), ...wrapped].slice(-50).join("\n");
}

function trustPathScreen(cli: "claude" | "codex", pathRows: string[], pad = true): string {
  const snapshot = wrappedTrustScreens[0];
  const rows = snapshot[cli].trimEnd().split("\n");
  rows.splice(1, snapshot.pathRows, ...pathRows);
  // Preserve raw row boundaries and spaces, including all-space path fragments.
  const padded = pad ? rows.map(row => row + " ".repeat(Math.max(0, 160 - Bun.stringWidth(row)))) : rows;
  return [...Array(50 - padded.length).fill(" ".repeat(160)), ...padded].join("\n");
}

test.each(["claude", "codex"] as const)("%s R5-1 never trusts another cwd after deleting a real boundary space", async cli => {
  const parse = cli === "claude" ? claudeFolderTrust : codexFolderTrust;
  const indent = cli === "claude" ? 1 : 2;
  // The review-5 reproduction, including the exact 160-column first path row.
  const stem = "/tmp/" + "a".repeat(160 - indent - 1 - 5);
  for (const actual of [stem + " /child", stem + "a /child", stem + " project/child", stem + "a project/child"]) {
    const pathRows = [" ".repeat(indent) + actual.slice(0, 160 - indent), actual.slice(160 - indent)];
    expect(pathRows[0]!.length).toBe(160);
    const screen = trustPathScreen(cli, pathRows), otherCwd = actual.replace(" ", "");
    expect(screen.split("\n")).toHaveLength(50);
    expect(parse(screen, actual)).toBeNull(); // Ambiguous whitespace cannot establish either folder.
    expect(parse(screen, otherCwd)).toBeNull();
    const f = await fixture(), runner = f.runner(10000), m = member({ cli, cwd: otherCwd });
    const started = await runner.start(m, f.opts);
    f.terminals.get(started.paneId)!.status = null;
    f.setScreen(screen);
    expect(await runner.approval(m)).toBeNull();
    const fingerprint = createHash("sha256").update(screen).digest("hex").slice(0, 24);
    expect(await runner.answerApproval(m, fingerprint, cli === "claude" ? 2 : 1)).toMatchObject({ ok: false });
    expect(f.calls.some(call => call.method === "terminal.keys")).toBe(false);
  }
});

test.each(["claude", "codex"] as const)("%s R6-1 rejects final spaces, blank fragments, truncation and prefixes without sending keys", async cli => {
  const parse = cli === "claude" ? claudeFolderTrust : codexFolderTrust;
  const indent = " ".repeat(cli === "claude" ? 1 : 2);
  const stem = "/tmp/" + "a".repeat(160 - indent.length - 5);
  const cases = [
    { rows: [indent + stem, "/child "], cwd: stem + "/child" },
    { rows: [indent + stem, " ".repeat(160)], cwd: stem },
    { rows: [indent + stem, "/child"], cwd: stem + "/child" },
    { rows: [indent + stem, "/child"], cwd: stem },
    { rows: [indent + stem], cwd: stem }, // exactly at the edge: may be cut off
    { rows: [indent + "/tmp/project "], cwd: "/tmp/project" },
    { rows: [indent + "/tmp/project-other"], cwd: "/tmp/project" },
    { rows: [indent + "/tmp/project"], cwd: "/tmp/project/child" },
  ];
  const f = await fixture(), runner = f.runner(10000);
  for (const [index, item] of cases.entries()) {
    const m = member({ id: `r6-${index}`, cli, cwd: item.cwd });
    const started = await runner.start(m, f.opts);
    f.terminals.get(started.paneId)!.status = { state: "blocked", kind: "setup" };
    for (const pad of [false, true]) {
      const screen = trustPathScreen(cli, item.rows, pad);
      expect(parse(screen, item.cwd)).toBeNull();
      f.setScreen(screen);
      expect(await runner.approval(m)).toBeNull();
      expect(runner.observationState(m.id)?.state).toBe("blocked");
      const fingerprint = createHash("sha256").update(screen).digest("hex").slice(0, 24);
      expect(await runner.answerApproval(m, fingerprint, cli === "claude" ? 2 : 1)).toMatchObject({ ok: false });
    }
  }
  expect(f.calls.filter(call => call.method === "terminal.keys")).toHaveLength(0);
});

test.each(["claude", "codex"] as const)("%s accepts exact unpadded short paths and rejects ambiguous padded paths", cli => {
  const parse = cli === "claude" ? claudeFolderTrust : codexFolderTrust;
  const indent = " ".repeat(cli === "claude" ? 1 : 2);
  for (const cwd of ["/tmp", "/tmp/project", "/tmp/a project", "/tmp/한글/😀"]) {
    expect(parse(trustPathScreen(cli, [indent + cwd], false), cwd)?.prompt.body).toStartWith(cwd + "\n");
    expect(parse(trustPathScreen(cli, [indent + cwd]), cwd)).toBeNull();
    expect(parse(trustPathScreen(cli, [indent + cwd], false), cwd + "/other")).toBeNull();
  }
});

test.each(["claude", "codex"] as const)("%s refuses ambiguous whitespace and all-space continuation fragments", cli => {
  const parse = cli === "claude" ? claudeFolderTrust : codexFolderTrust;
  const indent = " ".repeat(cli === "claude" ? 1 : 2);
  const stem = "/tmp/" + "a".repeat(160 - indent.length - 5);
  for (const rows of [
    [indent + stem.slice(0, -2) + "  ", "/child"],
    [indent + stem, "  project/child"],
    [indent + stem.slice(0, -1) + "\u00a0", "/child"],
    [indent + stem, "\u3000project/child"],
    [indent + stem, " ".repeat(160), "/child"],
  ]) {
    expect(Bun.stringWidth(rows[0]!)).toBe(160);
    const displayed = rows.join("").slice(indent.length);
    const collapsed = rows.map(row => row.trim()).join("");
    const screen = trustPathScreen(cli, rows);
    for (const cwd of [displayed, collapsed, collapsed + "/other"]) expect(parse(screen, cwd)).toBeNull();
  }
  // Trailing ASCII space could be terminal padding or part of the folder name.
  expect(parse(trustPathScreen(cli, [indent + "/tmp/project "]), "/tmp/project ")).toBeNull();
});

test.each(["claude", "codex"] as const)("%s refuses multiple path rows regardless of their width", cli => {
  const parse = cli === "claude" ? claudeFolderTrust : codexFolderTrust;
  const indent = " ".repeat(cli === "claude" ? 1 : 2);
  for (const rows of [[indent + "/tmp/project", "/child"], [indent + "/tmp/project", " ", "/child"]]) {
    const raw = trustPathScreen(cli, rows);
    expect(parse(raw, "/tmp/project/child")).toBeNull();
    // Short terminal.read rows are not soft wraps either.
    expect(parse(raw.split("\n").map(row => row.trimEnd()).join("\n"), "/tmp/project/child")).toBeNull();
  }
});

test.each(["claude", "codex"] as const)("%s preserves spaces, special characters and Korean paths without prefix matching", cli => {
  const parse = cli === "claude" ? claudeFolderTrust : codexFolderTrust;
  const indent = " ".repeat(cli === "claude" ? 1 : 2);
  for (const cwd of ["/tmp/한글 프로젝트/작업", "/tmp/a $'`[]#;&()/child", "/tmp/공백\u00a0중간\u3000폴더/child"]) {
    const screen = trustPathScreen(cli, [indent + cwd], false);
    expect(parse(screen, cwd)?.prompt.body).toStartWith(cwd + "\n");
    for (const other of [cwd + "/other", cwd.slice(0, -1), cwd.replace(/\s/gu, "")]) {
      expect(parse(screen, other)).toBeNull();
    }
    for (const forbidden of ["\t", "\n", "\r", "\u2028", "\u2029"]) {
      const unsafe = cwd + forbidden + "child";
      expect(parse(trustPathScreen(cli, [indent + unsafe]), unsafe)).toBeNull();
    }
  }
  // CJK counts as two terminal cells, rather than one JS character.
  const first = indent + "/tmp/" + "한".repeat(75) + "a".repeat(5 - indent.length);
  expect(Bun.stringWidth(first)).toBe(160);
  const cwd = first.slice(indent.length) + "/작업 공백/$[]";
  const screen = trustPathScreen(cli, [first, "/작업 공백/$[]"]);
  expect(parse(screen, cwd)).toBeNull();
  expect(parse(screen, cwd + "/other")).toBeNull();
  const short = first.slice(0, -1);
  expect(parse(trustPathScreen(cli, [short, "/작업 공백/$[]"]), short.slice(indent.length) + "/작업 공백/$[]")).toBeNull();
});

for (const snapshot of wrappedTrustScreens) {
  test.each(["claude", "codex"] as const)(`%s refuses ${snapshot.pathRows} wrapped path rows at 160 columns`, async cli => {
    const parse = cli === "claude" ? claudeFolderTrust : codexFolderTrust;
    const raw = snapshot[cli], pathRows = raw.split("\n").slice(1, 1 + snapshot.pathRows);
    expect(pathRows).toHaveLength(snapshot.pathRows);
    expect(pathRows.slice(0, -1).every(line => line.length === 160)).toBe(true);
    const screen = screen160x50(raw);
    expect(screen.split("\n")).toHaveLength(50);
    expect(parse(screen, snapshot.cwd)).toBeNull();
    for (const cwd of [snapshot.cwd + "/other", snapshot.cwd.slice(0, -1), snapshot.cwd.replace("long project", "longproject")]) {
      expect(parse(screen, cwd)).toBeNull();
    }
    const badPaths = [
      [...pathRows].reverse(), pathRows.slice(0, -1), [...pathRows, "/other"],
      [pathRows[0]!, "unexpected text", ...pathRows.slice(1)],
    ];
    for (const path of badPaths) expect(parse(screen.replace(pathRows.join("\n"), path.join("\n")), snapshot.cwd)).toBeNull();
    expect(parse(screen.replace(cli === "claude" ? "❯" : "›", " "), snapshot.cwd)).toBeNull();
    expect(parse(screen.replace(cli === "claude" ? "Yes, I trust this folder" : "2. Quit", "Unknown option"), snapshot.cwd)).toBeNull();

    const f = await fixture(), runner = f.runner(10000), m = member({ cli, cwd: snapshot.cwd });
    const started = await runner.start(m, f.opts);
    f.terminals.get(started.paneId)!.status = null;
    f.setScreen(screen);
    expect(await runner.approval(m)).toBeNull();
    const fingerprint = createHash("sha256").update(screen).digest("hex").slice(0, 24);
    expect(await runner.answerApproval(m, fingerprint, cli === "claude" ? 2 : 1)).toMatchObject({ ok: false });
    expect(f.calls.some(c => c.method === "terminal.keys")).toBe(false);
  });
}
test.each(["claude", "codex"] as const)("%s new 160x50 sessions preserve screen, status, draft guard and trust approval", async cli => {
  const f = await fixture(), runner = f.runner(10000), m = member({ cli });
  const start = await runner.start(m, f.opts), terminal = f.terminals.get(start.paneId)!;
  expect(terminal).toMatchObject({ cols: 160, rows: 50 });
  const composerText = cli === "claude" ? composer("keep this draft") : "output\n› keep this draft\n  ? for shortcuts\n";
  const screen = screen160x50(composerText); f.setScreen(screen);
  expect(screen.split("\n")).toHaveLength(50);
  expect(screen.split("\n").every(line => Array.from(line).length === 160)).toBe(true);
  for (const state of ["working", "idle"] as const) {
    terminal.status = { state };
    expect(await runner.screen(m)).toBe(screen);
    expect(runner.observationState(m.id)?.state).toBe(state);
  }
  expect(await runner.send(m, "do not overwrite", f.opts)).toMatchObject({ ok: false, reason: "input_busy" });
  expect(f.calls.some(c => c.method === "terminal.send")).toBe(false);
  terminal.status = null;
  f.setScreen(screen160x50(cli === "claude" ? trustScreen() : codexTrustScreen()));
  // Padded text cannot prove whether trailing spaces belong to the folder.
  expect(await runner.approval(m)).toBeNull();
  f.setScreen(cli === "claude" ? trustScreen() : codexTrustScreen());
  const prompt = await runner.approval(m);
  expect(prompt?.title).toBe("폴더 신뢰 확인");
  expect(runner.observationState(m.id)?.setupError?.code).toBe("folder_trust");
  expect(await runner.answerApproval(m, prompt!.fingerprint!, cli === "claude" ? 2 : 1)).toMatchObject({ ok: true });
  expect(f.calls.filter(c => c.method === "terminal.keys")).toHaveLength(1);
  expect(f.calls.filter(c => c.method === "terminal.read").every(c => c.params.lines === 0)).toBe(true);
});


const usageScreen = `You've hit your weekly limit · resets Nov 13 at 10am (Asia/Seoul)
What do you want to do?
1. Stop and wait for limit to reset
2. Wait here, then continue automatically at reset
3. Add funds to continue with usage credits
Enter to confirm · Esc to cancel`;
describe("API 오류 후 Core 입력과 사용 한도 키 안전", () => {
  test("상태줄이 매번 바뀌는 Add funds 기본 선택 한도도 재검증 뒤 Esc 1회만 보낸다", async () => {
    const f = await fixture(), runner = f.runner(10000), m = member();
    const started = await runner.start(m, f.opts), terminal = f.terminals.get(started.paneId)!;
    const menu = "You've hit your 5-hour limit · resets Nov 13 at 10am (Asia/Seoul)\nWhat do you want to do?\n❯ 1. Add funds to continue with usage credits\n2. Stop\n3. Switch to usage credits\nEnter to confirm · Esc to cancel";
    const screen = (tick: number) => `${menu}\n◆ Opus │ ███░ │ ${70 + tick}% │ $${716.43 + tick} │ 7일: 11% (${412 + tick}s)\n⏵⏵ bypass permissions on`;
    terminal.status = { state: "blocked" }; f.setScreen(screen(0));
    const snapshot = await runner.usageLimitSnapshot(m);
    expect(snapshot.menu?.fingerprint).toBe(usageLimitMenu(screen(1))!.fingerprint);
    let reads = 1, dismissed = false;
    f.setHook(r => {
      if (r.method === "terminal.read" && !dismissed) f.setScreen(screen(reads++));
      if (r.method === "terminal.keys") { dismissed = true; terminal.status = { state: "error" }; f.setScreen(composer()); }
      return false;
    });
    expect(await runner.dismissUsageLimit(m, snapshot.menu!.fingerprint)).toEqual({ ok: true });
    expect(reads).toBeGreaterThan(2);
    expect(f.calls.filter(r => r.method === "terminal.keys").map(r => r.params.keys)).toEqual([["esc"]]);
    expect(f.calls.some(r => r.method === "terminal.send" || r.method === "terminal.interrupt")).toBe(false);
  });
  test("대화 기록에 인용된 한도와 살아 있는 입력칸에는 Esc를 보내지 않는다", async () => {
    const f = await fixture(), runner = f.runner(10000), m = member();
    const started = await runner.start(m, f.opts), terminal = f.terminals.get(started.paneId)!;
    terminal.status = { state: "idle" }; f.setScreen(usageScreen + "\n" + composer("live draft"));
    expect((await runner.usageLimitSnapshot(m)).menu).toBeNull();
    expect(await runner.dismissUsageLimit(m, usageLimitMenu(usageScreen)!.fingerprint)).toMatchObject({ ok: false });
    expect(f.calls.some(r => r.method === "terminal.keys" || r.method === "terminal.send")).toBe(false);
  });
  test("error 뒤 다음 전달은 terminal.send에 도달하며 force:false와 초안 보호를 유지한다", async () => {
    const f = await fixture(), runner = f.runner(10000); const m = member();
    const started = await runner.start(m, f.opts), terminal = f.terminals.get(started.paneId)!;
    terminal.turn = 1; terminal.status = { state: "error", msg: "API Error: No response from API" };
    f.setScreen(composer("대표가 쓰던 초안"));
    expect(await runner.send(m, "이어서", f.opts)).toMatchObject({ ok: false, reason: "input_busy", deliveryEffect: "not_written" });
    expect(f.calls.filter(r => r.method === "terminal.send")).toHaveLength(0);
    f.setScreen(composer());
    expect(await runner.send(m, "이어서", f.opts)).toMatchObject({ ok: true });
    expect(f.calls.filter(r => r.method === "terminal.send").map(r => r.params)).toEqual([expect.objectContaining({ text: "이어서", force: false, wait: false })]);
  });
  test.each(["blocked", "idle", "error", null] as const)("OSC %s에서도 한도 화면을 인식한다", async state => {
    const f = await fixture(), runner = f.runner(10000), m = member();
    const started = await runner.start(m, f.opts), terminal = f.terminals.get(started.paneId)!;
    terminal.status = state ? { state } : null; f.setScreen(usageScreen);
    const events: RunnerEvent[] = []; runner.on(e => events.push(e));
    expect((await runner.usageLimitSnapshot(m)).menu).not.toBeNull();
    expect(events.find(e => e.type === "status" && e.blockedReason === "usage_limit")).toMatchObject({ status: "blocked", observation: { error: { code: "usage_limit" } } });
    expect(f.calls.some(r => r.method === "terminal.keys")).toBe(false);
  });
  test("working은 한도 화면 판독 대신 network_retry를 표시한다", async () => {
    const f = await fixture(), runner = f.runner(10000), m = member();
    const started = await runner.start(m, f.opts), terminal = f.terminals.get(started.paneId)!;
    terminal.status = { state: "working" }; f.setScreen(usageScreen + "\nWaiting for API response · will retry in 1m 2s · check your network");
    const events: RunnerEvent[] = []; runner.on(e => events.push(e));
    expect((await runner.usageLimitSnapshot(m)).menu).toBeNull();
    await until(() => events.some(e => e.type === "status" && e.observation?.error?.code === "network_retry"));
    expect(events.find(e => e.type === "status")).toMatchObject({ status: "working", observation: { error: { code: "network_retry" } } });
  });
  test("재검증 지문이 같을 때 Esc만 전송하고 닫힘·error 입력 가능을 확인한다", async () => {
    const f = await fixture(), runner = f.runner(10000), m = member();
    const started = await runner.start(m, f.opts), terminal = f.terminals.get(started.paneId)!;
    terminal.status = { state: "blocked" }; f.setScreen(usageScreen);
    const fingerprint = usageLimitMenu(usageScreen)!.fingerprint;
    f.setHook(r => { if (r.method === "terminal.keys") { terminal.status = { state: "error" }; f.setScreen(composer()); } return false; });
    expect(await runner.dismissUsageLimit(m, fingerprint)).toEqual({ ok: true });
    expect(f.calls.filter(r => r.method === "terminal.keys").map(r => r.params.keys)).toEqual([["esc"]]);
    expect(await runner.send(m, "이어서", f.opts)).toMatchObject({ ok: true });
  });
  test("Esc 직전 지문 변경·닫히지 않은 메뉴에는 추가 키나 본문을 넣지 않는다", async () => {
    const f = await fixture(), runner = f.runner(10000), m = member();
    const started = await runner.start(m, f.opts), terminal = f.terminals.get(started.paneId)!;
    terminal.status = { state: "blocked" }; f.setScreen(usageScreen);
    const fingerprint = usageLimitMenu(usageScreen)!.fingerprint;
    let reads = 0;
    f.setHook(r => { if (r.method === "terminal.read" && ++reads === 4) f.setScreen(usageScreen.replace("Nov 13", "Nov 14")); return false; });
    expect(await runner.dismissUsageLimit(m, fingerprint)).toMatchObject({ ok: false });
    expect(f.calls.some(r => r.method === "terminal.keys")).toBe(false);
    f.setHook(null); f.setScreen(usageScreen);
    expect(await runner.dismissUsageLimit(m, fingerprint)).toEqual({ ok: false, note: "창을 닫지 못했습니다" });
    expect(f.calls.filter(r => r.method === "terminal.keys").map(r => r.params.keys)).toEqual([["esc"]]);
    expect(f.calls.some(r => r.method === "terminal.send")).toBe(false);
  });
});


test("한도 메뉴가 사라져도 OSC blocked가 계속되면 대기 상한 후 본문을 보내지 않는다", async () => {
  const f = await fixture(), runner = f.runner(10000, { usageLimitCloseTimeoutMs: 50 }), m = member();
  const started = await runner.start(m, f.opts), terminal = f.terminals.get(started.paneId)!;
  terminal.status = { state: "blocked" }; f.setScreen(usageScreen);
  f.setHook(r => { if (r.method === "terminal.keys") f.setScreen(composer()); return false; });
  expect(await runner.dismissUsageLimit(m, usageLimitMenu(usageScreen)!.fingerprint)).toEqual({ ok: false, note: "창을 닫지 못했습니다" });
  expect(f.calls.filter(r => r.method === "terminal.keys").map(r => r.params.keys)).toEqual([["esc"]]);
  expect(f.calls.some(r => r.method === "terminal.send")).toBe(false);
});


test("관리 턴 도중 OSC blocked 한도 메뉴는 실행 자리를 풀고 Esc 뒤 이어가기를 실제로 전달한다", async () => {
  const f = await fixture();
  const config = loadConfig({ IAMCEO_HOME: join(f.dir, "iamceo"), IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: f.socketPath,
    IAMCEO_CLAUDE_BIN: "/fake/claude", IAMCEO_CODEX_BIN: "/fake/codex", IAMCEO_CORE_BIN: "/usr/bin/false" });
  const db = openDb(config.dbPath), store = new Store(db, new Bus());
  const runner = f.runner(20, { recoveryStore: store });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: { claudeHome: join(f.dir, "claude-home"), codexHome: join(f.dir, "codex-home") }, timings: { tickMs: 60000, healthMs: 60000 } });
  try {
    const project = store.createProject({ name: "한도 작업", cwd: f.dir });
    const worker = await orch.createMember(project.id, { name: "직원" });
    await orch.assign(project.id, worker.handle, { text: "원래 작업" });
    const terminal = f.terminals.get(worker.paneId!)!;
    terminal.status = { state: "blocked" }; f.setScreen(usageScreen);
    await until(() => store.listDecisions(project.id).some(d => d.kind === "usage_limit"));
    const card = store.listDecisions(project.id).find(d => d.kind === "usage_limit")!;
    expect(store.listPendingExecutions().filter(run => run.memberId === worker.id)).toHaveLength(0);
    expect(store.listDeliveries(project.id).some(d => d.text.includes("보고 보완"))).toBe(false);
    f.setHook(r => { if (r.method === "terminal.keys") { terminal.status = { state: "error" }; f.setScreen(composer()); } return false; });
    await orch.answerDecision(card.id, { choice: "resume" });
    await until(() => f.calls.filter(r => r.method === "terminal.send").length === 2);
    await until(() => store.requireDecision(card.id).status === "closed");
    expect(f.calls.filter(r => r.method === "terminal.keys").map(r => r.params.keys)).toEqual([["esc"]]);
    expect(f.calls.filter(r => r.method === "terminal.send")[1]?.params.text).toContain(USAGE_RESUME_TEXT);
  } finally { await orch.shutdown(); db.close(); }
});


test("입력 직전 한도 메뉴는 OSC idle과 과거의 빈 composer가 보여도 본문·Enter를 보내지 않는다", async () => {
  const f = await fixture(), runner = f.runner(10000), m = member();
  const started = await runner.start(m, f.opts), terminal = f.terminals.get(started.paneId)!;
  terminal.status = { state: "idle" }; f.setScreen(composer() + usageScreen);
  const events: RunnerEvent[] = []; runner.on(event => events.push(event));
  const result = await runner.withSignal(new AbortController().signal, () => {}, () => runner.send(m, "업무 본문", f.opts), Date.now() + 1000);
  expect(result).toMatchObject({ ok: false, reason: "blocked", deliveryEffect: "not_written" });
  expect(events.some(event => event.type === "status" && event.blockedReason === "usage_limit")).toBe(true);
  expect(f.calls.some(request => request.method === "terminal.send" || request.method === "terminal.keys")).toBe(false);
});
