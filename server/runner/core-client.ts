// herdr-core protocol generation 1, plain NDJSON JSON-RPC. Each request has
// its own connection: disconnect/reconnect never replays a mutating request.
import { Socket } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CoreStatus { state: string; app?: string; msg?: string; title?: string; kind?: string | null; progress?: number | null }
export interface CoreTerminal {
  address: string; argv: string[]; cwd: string; labels: Record<string, string>; state: string;
  status?: CoreStatus | null; records?: Record<string, CoreStatus>; reported?: boolean;
  turn?: number; pid?: number | null; reason?: string | null; exit_code?: number | null;
}
export interface CoreHello { generation: number; version: string; methods: string[]; features: string[] }
export class CoreError extends Error {
  constructor(readonly kind: string, message: string, readonly uncertain = false, readonly deliveryEffect: "not_written" | "rejected" | "unknown" = uncertain ? "unknown" : "rejected", readonly causeCode?: string) { super(message); this.name = "CoreError"; }
}

export function coreSocketPath(session = process.env.HC_SESSION || "default"): string {
  if (process.env.HC_SOCKET) return process.env.HC_SOCKET;
  if (!/^[a-zA-Z0-9_.-]+$/.test(session)) throw new CoreError("config", "Invalid herdr-core session name");
  const runtime = process.env.XDG_RUNTIME_DIR || (existsSync(`/run/user/${process.getuid?.()}`) ? `/run/user/${process.getuid?.()}` : null);
  return runtime ? join(runtime, "herdr-core", `${session}.sock`) : join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "herdr-core", session, `${session}.sock`);
}

let nextId = 0;
const MAX_RESPONSE = 16 * 1024 * 1024;
export function coreRpc<T>(socketPath: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
  const id = `iamceo-core-${++nextId}`;
  return new Promise((resolve, reject) => {
    let sent = false;
    let settled = false;
    let bytes = 0;
    let buffer = "";
    const socket = new Socket();
    socket.setEncoding("utf8");
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result as T);
    };
    const fail = (kind: string, message: string, causeCode?: string) => finish(new CoreError(kind, `${method}: ${message}`, sent, sent ? "unknown" : "not_written", causeCode));
    const timer = setTimeout(() => fail("timeout", `no reply within ${timeoutMs}ms`), timeoutMs);
    socket.on("connect", () => {
      // Once a write is attempted, transport failure is ambiguous. Never retry it.
      sent = true;
      socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESPONSE) return fail("protocol", "response exceeds 16 MiB");
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: { id?: unknown; jsonrpc?: string; result?: T; error?: { message?: string; data?: { kind?: string; hint?: string } } };
        try { message = JSON.parse(line); } catch { return fail("protocol", "invalid JSON response"); }
        if (!message || typeof message !== "object" || Array.isArray(message)) return fail("protocol", "invalid JSON-RPC response");
        if (message.id !== id) continue;
        if (message.jsonrpc !== "2.0") return fail("protocol", "invalid JSON-RPC version");
        if (message.error) {
          const { message: detail, data } = message.error;
          return finish(new CoreError(data?.kind || "rpc", [detail || "core rejected request", data?.hint].filter(Boolean).join(": ")));
        }
        if (!("result" in message)) return fail("protocol", "response has no result");
        return finish(undefined, message.result);
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => fail("down", error.message, error.code));
    socket.on("close", () => { if (!settled) fail("closed", "connection closed without a reply"); });
    // Bun may report an unavailable Unix endpoint during connect itself.
    // Install all listeners before initiating that connection.
    try { socket.connect({ path: socketPath }); } catch (error) { fail("down", error instanceof Error ? error.message : String(error)); }
  });
}
