// herdr 소켓 클라이언트. NDJSON, 연결당 요청 1개이고 서버가 답한 뒤 닫는다.
// events.subscribe 만 연결을 유지하며 줄마다 이벤트를 보낸다.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export class HerdrError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "HerdrError"; }
}

export const DEFAULT_SOCKET = () => join(homedir(), ".config", "herdr", "herdr.sock");

/** IAMCEO_TEST=1 이면 격리 시험 소켓이나 herdr 설정 폴더 밖의 소켓만 허용한다. */
export function isForbiddenTestSocket(socketPath: string): boolean {
  if (process.env.IAMCEO_TEST !== "1") return false;
  const path = resolve(socketPath);
  if (path === resolve(DEFAULT_SOCKET())) return true;
  const herdrHome = resolve(homedir(), ".config", "herdr") + "/";
  return path.startsWith(herdrHome) && !/\/sessions\/iamceo-test-[^/]+\/herdr\.sock$/.test(path);
}

const READ_ONLY = new Set(["ping", "session.snapshot", "agent.list", "agent.get", "agent.read", "pane.read", "pane.get", "pane.list", "tab.get", "tab.list", "workspace.get", "workspace.list", "layout.export", "pane.layout", "pane.process_info", "server.agent_manifests", "events.subscribe"]);

let seq = 0;

export function rpc<T = any>(socketPath: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
  if (!READ_ONLY.has(method) && isForbiddenTestSocket(socketPath)) {
    return Promise.reject(new Error(`시험 중 라이브 herdr 쓰기 차단: ${method} → ${socketPath}`));
  }
  const id = `iamceo-${++seq}`;
  return new Promise<T>((res, rej) => {
    let buf = "";
    let settled = false;
    let sock: { end(): void } | null = null;
    const decoder = new TextDecoder();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      try { sock?.end(); } catch { /* 이미 닫힘 */ }
    };
    const timer = setTimeout(() => finish(() => rej(new HerdrError("timeout", `${method}: ${timeoutMs}ms 안에 답 없음`))), timeoutMs);
    const down = (e: unknown) => finish(() => rej(new HerdrError("down", `herdr 소켓 연결 실패: ${String(e)}`)));
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) { sock = s; s.write(JSON.stringify({ id, method, params }) + "\n"); },
        data(_s, chunk) {
          buf += decoder.decode(chunk, { stream: true });
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          let msg: any;
          try { msg = JSON.parse(line); }
          catch { return finish(() => rej(new HerdrError("bad_json", line.slice(0, 200)))); }
          if (msg.error) return finish(() => rej(new HerdrError(String(msg.error.code ?? "error"), String(msg.error.message ?? "herdr 오류"))));
          finish(() => res(msg.result as T));
        },
        close() { finish(() => rej(new HerdrError("closed", `${method}: 답 없이 연결이 닫힘`))); },
        error(_s, e) { finish(() => rej(new HerdrError("down", String(e)))); },
        connectError(_s, e) { down(e); },
      },
    }).catch(down);
  });
}

export interface HerdrEvent { event: string; data: any }
export interface Subscription { close(): void }

/** 구독을 연다. 응답을 받으면 onOpen, 끊기면(직접 close 제외) onClose. */
export function subscribe(socketPath: string, subscriptions: Array<Record<string, unknown>>, handlers: {
  onOpen(): void;
  onEvent(e: HerdrEvent): void;
  onClose(reason: string): void;
}): Subscription {
  const id = `iamceo-sub-${++seq}`;
  const decoder = new TextDecoder();
  let buf = "";
  let closed = false;
  let sock: { end(): void } | null = null;
  const lost = (reason: string) => { if (closed) return; closed = true; handlers.onClose(reason); };
  Bun.connect({
    unix: socketPath,
    socket: {
      open(s) {
        if (closed) { s.end(); return; }
        sock = s;
        s.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n");
      },
      data(_s, chunk) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === id) {
            if (msg.error) { lost(String(msg.error.message ?? "구독 실패")); sock?.end(); return; }
            if (!closed) handlers.onOpen();
            continue;
          }
          if (!closed && typeof msg.event === "string") handlers.onEvent({ event: msg.event, data: msg.data ?? {} });
        }
      },
      close() { lost("연결 닫힘"); },
      error(_s, e) { lost(String(e)); },
      connectError(_s, e) { lost(String(e)); },
    },
  }).catch((e) => lost(String(e)));
  return { close() { closed = true; try { sock?.end(); } catch { /* 이미 닫힘 */ } } };
}
