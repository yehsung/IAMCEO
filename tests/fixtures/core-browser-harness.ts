// Deterministic generation-1 core peer. Never starts herdr or discovers user services.
import { createServer, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreTerminal } from "../../server/runner/core-client";
import { createIsolatedRuntime, type IsolatedRuntime } from "./isolated-runtime";

export interface CoreFixtureCall {
  id: string | number; method: string; params: Record<string, any>;
  applied: boolean; replied: boolean;
}
export interface CoreFixtureFault {
  /** Apply normally, then delay the captured reply (including stale snapshots). */
  delayMs?: number;
  /** Delay execution too, to model a late original write after a timeout. */
  applyDelayMs?: number;
  dropResponse?: boolean;
  holdResponse?: boolean;
  error?: { kind: string; message: string };
  result?: unknown;
}
export interface CoreFixtureOptions { runtime?: IsolatedRuntime; providerTurns?: boolean }
interface Holder { terminal: CoreTerminal; env: Record<string, string>; child?: ReturnType<typeof Bun.spawn>; screen: string; sent: boolean }
const composer = (text = "") => `${text}\n${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n`;
const methods = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill", "terminal.keys"];

export async function startBrowserCore(options: CoreFixtureOptions = {}) {
  const runtime = options.runtime ?? createIsolatedRuntime();
  const socketPath = runtime.assertOwnedPath(runtime.socketPath);
  // Refuse existing endpoints; this peer must never replace somebody else's socket.
  if (existsSync(socketPath)) throw new Error("Fixture socket is already occupied");
  const holders = new Map<string, Holder>();
  const calls: CoreFixtureCall[] = [];
  const kills: { terminal: string; pid: number | null; call: CoreFixtureCall }[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending: (() => void)[] = [];
  const faults = new Map<string, CoreFixtureFault[]>();
  let counter = 0;
  let stopping: Promise<void> | undefined;
  function later(action: () => void, ms: number) {
    const timer = setTimeout(() => { timers.delete(timer); action(); }, Math.max(0, ms));
    timers.add(timer);
  }
  function bridgeEnvironment(args: string[]): Record<string, string> {
    const index = args.indexOf("--mcp-config");
    if (index < 0 || !args[index + 1]) throw new Error("Fake turns require an explicit MCP config");
    const configPath = runtime.assertOwnedPath(args[index + 1]);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const env = config.mcpServers?.iamceo?.env;
    if (!env?.IAMCEO_URL || !env.IAMCEO_TOKEN) throw new Error("Fake MCP bridge environment missing");
    runtime.assertURL(env.IAMCEO_URL);
    return { IAMCEO_URL: env.IAMCEO_URL, IAMCEO_TOKEN: env.IAMCEO_TOKEN };
  }
  async function turn(holder: Holder, prompt: string) {
    const terminal = holder.terminal;
    const args = terminal.argv.slice(1);
    const bridge = bridgeEnvironment(args);
    const sessionAt = args.indexOf("--session-id");
    const resumeAt = args.indexOf("--resume");
    const sessionID = args[(sessionAt >= 0 ? sessionAt : resumeAt) + 1];
    if (!sessionID || !/^[a-zA-Z0-9_-]+$/.test(sessionID)) throw new Error("Explicit fake session id required");
    if (sessionAt >= 0 && (holder.sent || existsSync(join(runtime.paths.sessions, `${sessionID}.txt`)))) args[sessionAt] = "--resume";
    holder.sent = true;
    holder.screen = composer(`Working…\n${prompt}`);
    const child = runtime.spawnFake([terminal.argv[0], ...args, "-p"], { cwd: terminal.cwd, env: holder.env });
    holder.child = child;
    terminal.pid = child.pid;
    child.stdin.write(prompt); child.stdin.end();
    const [output, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (holder.child !== child || stopping) return;
    holder.child = undefined;
    if (terminal.state !== "live") return;
    const events = output.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const final = events.findLast((value) => value?.type === "result");
    const text = final?.result || "";
    if (text && code === 0) {
      const url = runtime.assertURL(`${bridge.IAMCEO_URL}/agent/tool`);
      await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(2000), headers: { Authorization: `Bearer ${bridge.IAMCEO_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "post", args: { kind: "진행", title: text, body: text } }) });
    }
    if (stopping || terminal.state !== "live") return;
    holder.screen = composer(text || stderr || prompt);
    terminal.status = { state: code === 0 ? "idle" : "error", ...(code === 0 ? {} : { msg: stderr || "Fake provider failed" }) };
    terminal.turn = (terminal.turn ?? 0) + 1;
  }
  function apply(call: CoreFixtureCall): unknown {
    const p = call.params;
    const holder = holders.get(p.terminal);
    if (call.method === "hello") return { generation: 1, version: "isolated-fixture", methods, features: [] };
    if (call.method === "terminal.list") return { terminals: [...holders.values()].map((value) => value.terminal).filter((terminal) => Object.entries(p.labels ?? {}).every(([key, value]) => terminal.labels[key] === value)) };
    if (call.method === "terminal.run") {
      if (!Array.isArray(p.argv) || !p.argv.length) throw new Error("Explicit fake argv required");
      runtime.assertFakeExecutable(p.argv[0]);
      runtime.assertOwnedPath(p.cwd);
      const env = runtime.childEnv(p.env ?? {});
      for (const flag of ["--mcp-config", "--append-system-prompt-file", "--settings"]) {
        const at = p.argv.indexOf(flag);
        if (at >= 0) runtime.assertOwnedPath(p.argv[at + 1]);
      }
      if (options.providerTurns !== false) bridgeEnvironment(p.argv);
      const terminal: CoreTerminal = { address: `t${++counter}`, argv: p.argv, cwd: p.cwd, labels: p.labels ?? {}, state: "live", turn: 0, status: { state: "idle" }, reported: true };
      holders.set(terminal.address, { terminal, env, screen: composer(), sent: false });
      return terminal;
    }
    if (!holder) return undefined;
    if (call.method === "terminal.get") return holder.terminal;
    if (call.method === "terminal.read") return { text: holder.screen, complete: true };
    if (call.method === "terminal.send") {
      if (holder.terminal.state !== "live" || (p.if && p.if !== holder.terminal.status?.state)) return undefined;
      if (holder.terminal.status?.state !== "idle") return undefined;
      holder.terminal.status = { state: "working" };
      if (options.providerTurns !== false) void turn(holder, p.text).catch((error) => {
        if (stopping || holder.terminal.state !== "live") return;
        holder.terminal.status = { state: "error", msg: String(error) };
        holder.terminal.turn = (holder.terminal.turn ?? 0) + 1;
      });
      return { turn: holder.terminal.turn, started: true };
    }
    if (call.method === "terminal.interrupt") {
      holder.child?.kill("SIGTERM"); holder.child = undefined;
      holder.terminal.status = { state: "idle" }; holder.terminal.turn = (holder.terminal.turn ?? 0) + 1;
      return { outcome: "stopped" };
    }
    if (call.method === "terminal.kill") {
      kills.push({ terminal: holder.terminal.address, pid: holder.child?.pid ?? null, call });
      holder.child?.kill("SIGKILL"); holder.child = undefined;
      holder.terminal.state = "finished"; holder.terminal.reason = "killed"; holder.terminal.exit_code = 137;
      return holder.terminal;
    }
    if (call.method === "terminal.keys") return { turn: holder.terminal.turn };
    return undefined;
  }
  function handle(call: CoreFixtureCall, socket: Socket, fault: CoreFixtureFault = {}) {
    let reply: unknown;
    try {
      if (fault.error) throw Object.assign(new Error(fault.error.message), { kind: fault.error.kind });
      const result = apply(call);
      call.applied = result !== undefined;
      if (result === undefined) throw Object.assign(new Error("No matching core terminal or method"), { kind: "not_found" });
      reply = { jsonrpc: "2.0", id: call.id, result: "result" in fault ? fault.result : result };
    } catch (error) {
      reply = { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: String(error), data: { kind: (error as { kind?: string }).kind ?? "fixture_refused" } } };
    }
    // Freeze observations now; releasing a stale reply must not read newer mutable holder state.
    const line = JSON.stringify(reply) + "\n";
    const send = () => { if (!socket.destroyed && !stopping) { socket.write(line); call.replied = true; } };
    if (fault.dropResponse) return;
    if (fault.holdResponse) pending.push(send);
    else if (fault.delayMs) later(send, fault.delayMs);
    else send();
  }
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { socket.destroy(); return; }
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let request;
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        if (request?.jsonrpc !== "2.0" || typeof request.method !== "string" || !["string", "number"].includes(typeof request.id)) { socket.destroy(); return; }
        const call: CoreFixtureCall = { id: request.id, method: request.method, params: request.params ?? {}, applied: false, replied: false };
        calls.push(call);
        const fault = faults.get(call.method)?.shift();
        if (fault?.applyDelayMs) later(() => handle(call, socket, fault), fault.applyDelayMs);
        else handle(call, socket, fault);
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  } catch (error) { if (!options.runtime) await runtime.stop(); throw error; }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear(); pending.length = 0;
      const children = [...holders.values()].flatMap((holder) => holder.child ? [holder.child] : []);
      for (const child of children) child.kill("SIGKILL");
      for (const socket of sockets) socket.destroy();
      await Promise.all(children.map((child) => child.exited));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (!options.runtime) await runtime.stop();
    })();
    return stopping;
  }
  return {
    runtime, socketPath, env: runtime.childEnv(), holders, calls, kills,
    count(method: string) { return calls.filter((call) => call.method === method).length; },
    faultNext(method: string, fault: CoreFixtureFault) {
      if (stopping) throw new Error("Core fixture is stopped");
      const queue = faults.get(method) ?? []; queue.push({ ...fault }); faults.set(method, queue);
    },
    releaseReplies(order: "forward" | "reverse" = "forward") {
      const replies = pending.splice(0); if (order === "reverse") replies.reverse();
      for (const reply of replies) reply();
    },
    stop,
  };
}
