import { join } from "node:path";
import type { ServerWebSocket, Subprocess, Terminal } from "bun";
import { defaultCoreBin, type Config } from "./config.ts";
import type { OrchestratorApi } from "./orchestrator-api.ts";
import { childEnv } from "./runner/headless.ts";
import { ApiError, type Store } from "./store.ts";

export type TerminalMode = "observe" | "control";
export type TerminalSizePolicy = "core" | "fit";
export interface TerminalSocketData { kind: "terminal"; authGeneration: number; stream: TerminalStream }
export interface RealtimeSocketData { kind: "realtime"; authGeneration: number; protocol: 1 | 2 }
export type SocketData = TerminalSocketData | RealtimeSocketData;
const MAX_BUFFER = 4 * 1024 * 1024;

export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const integer = (raw: unknown, fallback: number) => {
    if (raw === null || raw === undefined) return fallback;
    if ((typeof raw !== "number" && typeof raw !== "string") || raw === "" || !Number.isSafeInteger(Number(raw))) {
      throw new ApiError(400, "터미널 크기는 정수여야 합니다");
    }
    return Number(raw);
  };
  return { cols: Math.max(40, Math.min(320, integer(cols, 100))), rows: Math.max(10, Math.min(200, integer(rows, 30))) };
}

/** Owns both upgraded sockets and reservations, so concurrent handshakes share limits. */
export class TerminalStreams {
  private readonly streams = new Set<TerminalStream>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe?: () => void;
  private readonly unsubscribeLease?: () => void;
  private stopped = false;
  private readonly restores = new Map<string, { paneId: string; cols: number; rows: number }>();
  async restore(memberId: string): Promise<void> {
    const target = this.restores.get(memberId);
    if (!target) return;
    const deadline = performance.now() + 2000;
    do {
      if (this.store.getMember(memberId)?.paneId !== target.paneId) { this.restores.delete(memberId); return; }
      try {
        const remaining = Math.max(1, deadline - performance.now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const size = await Promise.race([
          this.orch.terminalStreamInfo!(memberId),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Core size check timed out")), remaining); }),
        ]).finally(() => clearTimeout(timer));
        if (size.cols === target.cols && size.rows === target.rows) { this.restores.delete(memberId); return; }
      } catch (error) {
        if (error instanceof ApiError && error.code === "TERMINAL_GONE") { this.restores.delete(memberId); return; }
      }
      await Bun.sleep(25);
    } while (performance.now() < deadline);
    this.restores.delete(memberId);
    try { this.store.appendActivity(memberId, "system", "경고: 2초 안에 터미널 크기 복원을 확인하지 못해 계속 진행합니다"); }
    catch { /* member may have been removed */ }
  }
  detached(stream: TerminalStream, reason?: string): void {
    if (reason === "terminal_gone") {
      if (this.restores.get(stream.memberId)?.paneId === stream.paneId) this.restores.delete(stream.memberId);
    } else if (stream.restoreSize) this.restores.set(stream.memberId, { paneId: stream.paneId, ...stream.restoreSize });
    // Only a live control attach can create a restore target. Await detach first;
    // terminal disappearance or the bounded check ends the delivery fence.
  }
  constructor(readonly config: Config, readonly store: Store, readonly orch: OrchestratorApi) {
    this.timer = setInterval(() => { for (const stream of this.streams) stream.check(); }, 1000);
    this.timer.unref();
    if ("onTerminalStreamShutdown" in orch) this.unsubscribe = orch.onTerminalStreamShutdown?.(() => this.close());
    if ("onTerminalLeaseEnded" in orch) this.unsubscribeLease = orch.onTerminalLeaseEnded?.(async (memberId, leaseId) => {
      await Promise.all([...this.streams].map(stream => stream.endLease(memberId, leaseId)));
      await this.restore(memberId);
    });
  }
  async prepare(memberId: string, url: URL): Promise<TerminalStream> {
    const mode = url.searchParams.get("mode") ?? "observe";
    if (mode !== "observe" && mode !== "control") throw new ApiError(400, "터미널 연결 방식이 잘못되었습니다");
    const sizePolicy = url.searchParams.get("size") ?? "fit";
    if (sizePolicy !== "core" && sizePolicy !== "fit") throw new ApiError(400, "터미널 크기 정책이 잘못되었습니다");
    const member = this.store.requireMember(memberId);
    const project = this.store.requireProject(member.projectId);
    if (this.stopped || member.backend !== "core" || !member.paneId || member.origin === "manual" || project.archived || !project.runnerEnabled) {
      throw new ApiError(409, "지금 터미널을 열 수 없습니다", "TERMINAL_REFUSED");
    }
    if (!this.orch.terminalStreamInfo) throw new ApiError(501, "터미널 스트림을 지원하지 않습니다");
    const size = terminalSize(url.searchParams.get("cols"), url.searchParams.get("rows"));
    const stream = new TerminalStream(this, memberId, member.paneId, mode, size, url.searchParams.get("lease"), sizePolicy);
    this.streams.add(stream);
    try {
      stream.requireLease(true);
      if (mode === "control") {
        // Only an authenticated current lease holder may replace an orphan.
        await Promise.all([...this.streams].filter(s => s !== stream && s.memberId === memberId && s.mode === "control").map(s => s.replace()));
        stream.requireLease(true);
      }
      await this.restore(memberId);
      const peers = [...this.streams].filter(s => s.memberId === memberId && s.mode === mode);
      if (this.streams.size > 12 || peers.length > (mode === "observe" ? 3 : 1)) throw new ApiError(429, "열린 터미널이 너무 많습니다");
      const currentSize = await this.orch.terminalStreamInfo(memberId);
      if (this.stopped || this.store.requireMember(memberId).paneId !== member.paneId) throw new ApiError(409, "세션이 바뀌었습니다", "TERMINAL_REFUSED");
      stream.requireLease(true);
      if (mode === "observe" || sizePolicy === "core") stream.size = currentSize;
      if (mode === "control") stream.restoreSize = currentSize;
      return stream;
    } catch (error) { this.forget(stream); throw error; }
  }
  refreshObservers(memberId: string): void {
    for (const stream of this.streams) if (stream.memberId === memberId && stream.mode === "observe") void stream.refreshSize();
  }
  forget(stream: TerminalStream): void { this.streams.delete(stream); }
  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.unsubscribeLease?.();
    await Promise.all([...this.streams].map(s => s.close("terminal_gone")));
  }
}

export class TerminalStream {
  private ws?: ServerWebSocket<SocketData>;
  private proc?: Subprocess<"ignore", "pipe", "pipe">;
  private closing?: Promise<void>;
  private ended = false;
  private started = false;
  private lastRenew = -Infinity;
  private leaseCheckedAt = -Infinity;
  private expiresAt?: number;
  private terminal?: Terminal;
  private ready = false;
  private earlyOutput: Uint8Array[] = [];
  private pendingInput = Buffer.alloc(0);
  private queuedInput: Uint8Array[] = [];
  private inputScheduled = false;
  private sizeCheck = false;
  restoreSize?: { cols: number; rows: number };
  private lastSizeCheck = 0;
  private lastPong = Date.now();
  private lastPing = Date.now();
  constructor(private readonly owner: TerminalStreams, readonly memberId: string, readonly paneId: string,
    readonly mode: TerminalMode, public size: { cols: number; rows: number }, private readonly leaseId: string | null,
    readonly sizePolicy: TerminalSizePolicy = "fit") {}

  requireLease(force = false): void {
    if (this.ended) throw new LeaseEnded();
    if (this.mode !== "control") return;
    const now = Date.now();
    if (!force && now >= this.leaseCheckedAt && now - this.leaseCheckedAt < 1000 && this.expiresAt! > now) return;
    const lease = this.owner.orch.terminalStreamLease?.(this.memberId);
    if (!lease || lease.expiresAt <= now || lease.leaseId !== this.leaseId) throw new LeaseEnded();
    this.expiresAt = lease.expiresAt;
    this.leaseCheckedAt = now;
  }
  async endLease(memberId: string, leaseId: string | null): Promise<void> {
    if (this.mode !== "control" || this.memberId !== memberId) return;
    if (leaseId !== null && this.leaseId !== leaseId) return;
    if (leaseId === null && !this.ended) {
      try { this.requireLease(true); return; } catch { /* expired or replaced */ }
    }
    await this.close("lease_ended");
  }
  open(ws: ServerWebSocket<SocketData>): void {
    this.ws = ws;
    this.lastPong = this.lastPing = Date.now();
    if (this.ended) { ws.close(); return; }
    try {
      this.requireLease(true);
      const config = this.owner.config;
      const env = { ...childEnv(), HC_SOCKET: config.coreSocket ?? join(config.home, "run", "core.sock"), HC_SESSION: "iamceo",
        XDG_STATE_HOME: join(config.home, "core-state"), XDG_CONFIG_HOME: join(config.home, "core-config") };
      const binary = config.coreBin || defaultCoreBin();
      if (this.mode === "control") {
        this.terminal = new Bun.Terminal({ ...this.size, data: (_terminal, bytes) => this.output(bytes) });
        // Bun 1.3.14 caches raw state by fd even after a PTY closes. A reused
        // fd must clear that cache before setting the new slave raw. No child
        // exists yet, so neither transition exposes a cooked input window.
        this.terminal.setRawMode(false);
        this.terminal.setRawMode(true);
        this.proc = Bun.spawn([binary, "attach", this.paneId], { env, terminal: this.terminal });
      } else {
        this.proc = Bun.spawn([binary, "attach", "--observe", "--history", "300", this.paneId], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
      }
      this.started = true;
      if (this.mode === "control") this.activity("대표가 터미널에서 직접 입력을 시작했습니다");
      const early = this.earlyOutput; this.earlyOutput = [];
      early.forEach(bytes => this.output(bytes));
      const output = this.mode === "observe" ? this.read(this.proc.stdout, true) : Promise.resolve();
      // Drain without retaining or exposing stderr (which can contain secrets).
      if (this.proc.stderr) void this.read(this.proc.stderr, false);
      void this.proc.exited.then(async code => {
        await output;
        if (!this.ended) void this.close(code === 0 ? "terminal_gone" : "error", code === 0 ? undefined : "터미널 연결이 끝났습니다");
      }).catch(() => { void this.close("error", "터미널 연결이 끝났습니다"); });
    } catch (error) { this.fail(error); }
  }
  private async read(pipe: ReadableStream<Uint8Array> | null, output: boolean): Promise<void> {
    if (!pipe) return;
    const reader = pipe.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (output) this.output(value);
      }
    }
    catch { if (!this.ended) void this.close("error", "터미널 출력을 읽을 수 없습니다"); }
    finally { reader.releaseLock(); }
  }
  private sendText(event: object): void { this.ws?.send(JSON.stringify(event)); }
  output(bytes: Uint8Array): void {
    if (this.ended || !this.ws || !bytes.length) return;
    if (!this.started) { this.earlyOutput.push(bytes.slice()); return; }
    if (!this.ready) {
      this.ready = true;
      this.sendText({ type: "ready", mode: this.mode, ...this.size, ...(this.mode === "control" ? { expiresAt: this.expiresAt } : {}) });
      if (this.mode === "control") {
        this.owner.refreshObservers(this.memberId);
        const pending = this.pendingInput; this.pendingInput = Buffer.alloc(0);
        if (pending.length) this.queueInput(pending);
      }
    }
    if (this.ws.getBufferedAmount() > MAX_BUFFER) { void this.close("slow_client"); return; }
    this.ws.sendBinary(bytes);
    if (this.ws.getBufferedAmount() > MAX_BUFFER) void this.close("slow_client");
  }
  pong(): void { this.lastPong = Date.now(); }
  private fail(error: unknown): void {
    // A renewal can cross the expiry boundary after the preceding lease check.
    let failure = error;
    try { this.requireLease(true); } catch (leaseError) { failure = leaseError; }
    const reason = failure instanceof LeaseEnded ? "lease_ended"
      : failure instanceof ApiError && failure.code === "TERMINAL_GONE" ? "terminal_gone"
      : failure instanceof ApiError && failure.code === "TERMINAL_REFUSED" ? "refused" : "error";
    void this.close(reason, reason === "refused" && failure instanceof Error ? failure.message : "터미널에 연결할 수 없습니다");
  }
  async refreshSize(): Promise<void> {
    if (this.ended || (this.mode !== "observe" && this.sizePolicy !== "core") || this.sizeCheck) return;
    this.sizeCheck = true;
    try {
      const size = await this.owner.orch.terminalStreamInfo!(this.memberId);
      if (!this.ended && (size.cols !== this.size.cols || size.rows !== this.size.rows)) {
        this.size = size;
        if (this.mode === "control") this.resizePTY();
        if (this.ready) this.sendText({ type: "resize", ...size });
      }
    } catch (error) { this.fail(error); }
    finally { this.sizeCheck = false; }
  }
  check(): void {
    if (this.ended) return;
    try { this.requireLease(true); } catch (error) { this.fail(error); return; }
    if (this.ws) {
      const now = Date.now();
      if (now - this.lastPong >= 30_000) { void this.close("timeout"); return; }
      if (now - this.lastPing >= 15_000) { this.lastPing = now; this.ws.ping(); }
      if (this.ws.getBufferedAmount() > MAX_BUFFER) void this.close("slow_client");
    }
    if (this.started && Date.now() - this.lastSizeCheck >= 2000) {
      this.lastSizeCheck = Date.now();
      void this.refreshSize();
    }
  }
  message(message: string | Buffer): void {
    if (this.ended) return;
    if (typeof message === "string") {
      try {
        const event = JSON.parse(message);
        if (event.type === "ping") { this.pong(); this.sendText({ type: "pong" }); }
        if (event.type === "pong") this.pong();
        if (event.type === "activity" && this.mode === "control") {
          this.requireLease();
          // Core leases last five minutes; keep the renewal clock on reconnect.
          this.renew(60_000, this.expiresAt! - 5 * 60_000);
        }
        if (event.type === "resize" && this.mode === "control" && this.sizePolicy === "fit") {
          this.requireLease();
          const size = terminalSize(event.cols, event.rows);
          if (size.cols === this.size.cols && size.rows === this.size.rows) return;
          this.size = size;
          this.resizePTY();
          this.owner.refreshObservers(this.memberId);
        }
      } catch (error) { this.fail(error); }
      return;
    }
    if (this.mode !== "control") return;
    const bytes = message.filter(byte => byte !== 0x1c);
    if (!bytes.length) return;
    if (!this.ready) {
      try { this.requireLease(); } catch (error) { this.fail(error); return; }
      if (this.pendingInput.length + bytes.length > 4096) { void this.close("error", "입력 준비 버퍼를 초과했습니다"); return; }
      this.pendingInput = Buffer.concat([this.pendingInput, bytes]);
    } else this.queueInput(bytes);
  }
  private resizePTY(): void {
    this.terminal?.resize(this.size.cols, this.size.rows);
    // Pre-created Bun Terminals on macOS need an explicit SIGWINCH.
    if (this.proc?.exitCode === null) this.proc.kill("SIGWINCH");
  }
  private queueInput(bytes: Uint8Array): void {
    this.queuedInput.push(bytes);
    if (this.inputScheduled) return;
    this.inputScheduled = true;
    queueMicrotask(() => { void this.flushInput(); });
  }
  private renew(interval: number, since = -Infinity): void {
    const now = Date.now();
    if (now - Math.max(this.lastRenew, since) < interval) return;
    this.expiresAt = this.owner.orch.renewTerminalStreamLease!(this.memberId, this.leaseId!);
    this.lastRenew = now;
    this.leaseCheckedAt = now;
    this.sendText({ type: "lease", expiresAt: this.expiresAt });
  }
  private async flushInput(): Promise<void> {
    try {
      while (!this.ended && this.queuedInput.length) {
        this.renew(10_000);
        await this.owner.orch.terminalStreamInput!(this.memberId, () => {
          if (this.ended) throw new Error("Stream closed");
          this.requireLease();
          const bytes = Buffer.concat(this.queuedInput);
          this.queuedInput = [];
          this.terminal!.write(bytes);
        });
      }
    } catch (error) { this.fail(error); }
    finally { this.inputScheduled = false; }
  }
  replace(): Promise<void> {
    try { this.requireLease(true); }
    catch (error) { this.fail(error); return this.close(); }
    return this.close("replaced");
  }
  private activity(text: string): void {
    try { this.owner.store.appendActivity(this.memberId, "system", text); } catch { /* member may have been removed */ }
  }
  close(reason?: string, message?: string): Promise<void> {
    if (this.closing) return this.closing;
    if (this.ended) return Promise.resolve(); // Bun may synchronously re-enter via websocket.close.
    this.ended = true;
    if (reason) this.sendText({ type: "closed", reason, ...(message ? { message } : {}) });
    this.ws?.close(1000);
    if (this.started && this.mode === "control") this.activity("대표가 터미널에서 직접 입력을 마쳤습니다");
    return this.closing = (async () => {
      const proc = this.proc;
      if (proc) {
        if (this.mode === "control" && proc.exitCode === null) {
          try { this.terminal?.write(new Uint8Array([0x1c])); } catch { /* already exited */ }
          await Promise.race([proc.exited, Bun.sleep(500)]);
        }
        if (proc.exitCode === null) proc.kill("SIGKILL");
        await proc.exited;
      }
      try { this.terminal?.setRawMode(false); } catch { /* master already closed */ }
      this.terminal?.close();
      this.pendingInput = Buffer.alloc(0);
      this.queuedInput = [];
      if (this.started && this.mode === "control") this.owner.detached(this, reason);
      this.owner.forget(this);
      if (this.mode === "control") this.owner.refreshObservers(this.memberId);
    })();
  }
}

class LeaseEnded extends ApiError { constructor() { super(409, "조작권이 없습니다", "TERMINAL_REFUSED"); } }
