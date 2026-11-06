// Protocol mock for web regression tests. No real core, provider, global service, or user session.
// Holder state survives IAMCEO restarts; fake model turns use the existing HTTP MCP fixture.
import { createServer, type Socket } from "node:net";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreTerminal } from "../../server/runner/core-client";

interface Holder { terminal: CoreTerminal; env: Record<string, string>; child?: ReturnType<typeof Bun.spawn>; screen: string; sent: boolean }
const composer = (text = "") => `${text}\n${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n`;
export async function startBrowserCore() {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-ui-core-"));
  const socketPath = join(dir, "c.sock");
  const holders = new Map<string, Holder>();
  const sockets = new Set<Socket>();
  let counter = 0;
  async function turn(holder: Holder, prompt: string) {
    const terminal = holder.terminal;
    const args = terminal.argv.slice(1);
    const sessionAt = args.indexOf("--session-id");
    // The turn process is an adapter for the existing fake model, not a new core holder.
    if (sessionAt >= 0 && holder.sent) args[sessionAt] = "--resume";
    const sessionID = sessionAt >= 0 ? args[sessionAt + 1] : args[args.indexOf("--resume") + 1];
    const sessions = holder.env.FAKE_CLAUDE_SESSIONS;
    if (sessionAt >= 0 && sessions && existsSync(join(sessions, `${sessionID}.txt`))) args[sessionAt] = "--resume";
    holder.sent = true;
    terminal.status = { state: "working" };
    holder.screen = composer(`Working…\n${prompt}`);
    const child = Bun.spawn([terminal.argv[0], ...args, "-p"], { cwd: terminal.cwd, env: holder.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    holder.child = child;
    terminal.pid = child.pid;
    child.stdin.write(prompt); child.stdin.end();
    const [output, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (holder.child !== child) return;
    holder.child = undefined;
    if (terminal.state !== "live") return;
    const events = output.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    const final = events.findLast((value) => value?.type === "result");
    const text = final?.result || "";
    // Real interactive providers report through MCP, rather than screen scraping a final answer.
    if (text && code === 0) {
      const configPath = args[args.indexOf("--mcp-config") + 1];
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const bridge = config.mcpServers.iamceo.env;
      await fetch(`${bridge.IAMCEO_URL}/agent/tool`, { method: "POST", headers: { Authorization: `Bearer ${bridge.IAMCEO_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "post", args: { kind: "진행", title: text, body: text } }) });
    }
    holder.screen = composer(text || stderr || prompt);
    terminal.status = { state: code === 0 ? "idle" : "error", ...(code === 0 ? {} : { msg: stderr || "Fake provider failed" }) };
    terminal.turn = (terminal.turn ?? 0) + 1;
  }
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const p = request.params ?? {};
        const holder = holders.get(p.terminal);
        let result: unknown;
        if (request.method === "hello") result = { generation: 1, version: "browser-fixture", methods: ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill", "terminal.keys"], features: [] };
        else if (request.method === "terminal.list") result = { terminals: [...holders.values()].map((value) => value.terminal) };
        else if (request.method === "terminal.run") {
          const terminal: CoreTerminal = { address: `t${++counter}`, argv: p.argv, cwd: p.cwd, labels: p.labels, state: "live", turn: 0, status: { state: "idle" }, reported: true };
          holders.set(terminal.address, { terminal, env: p.env, screen: composer(), sent: false }); result = terminal;
        } else if (holder) {
          if (request.method === "terminal.get") result = holder.terminal;
          else if (request.method === "terminal.read") result = { text: holder.screen, complete: true };
          else if (request.method === "terminal.send") {
            if (holder.terminal.status?.state === "idle" && holder.terminal.state === "live") {
              void turn(holder, p.text).catch((error) => { holder.terminal.status = { state: "error", msg: String(error) }; holder.terminal.turn = (holder.terminal.turn ?? 0) + 1; });
              result = { turn: holder.terminal.turn, started: true };
            }
          } else if (request.method === "terminal.interrupt") {
            holder.child?.kill("SIGTERM"); holder.child = undefined; holder.terminal.status = { state: "idle" }; holder.terminal.turn = (holder.terminal.turn ?? 0) + 1; result = { outcome: "stopped" };
          } else if (request.method === "terminal.kill") {
            holder.terminal.state = "finished"; holder.child?.kill("SIGKILL"); holder.child = undefined; result = holder.terminal;
          } else if (request.method === "terminal.keys") result = { turn: holder.terminal.turn };
        }
        const reply = result === undefined ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "No matching idle core terminal", data: { kind: "not_found" } } } : { jsonrpc: "2.0", id: request.id, result };
        socket.write(JSON.stringify(reply) + "\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    env: { IAMCEO_CORE_SOCKET: socketPath, IAMCEO_CORE_BIN: process.execPath }, holders,
    async stop() {
      for (const holder of holders.values()) holder.child?.kill("SIGKILL");
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
