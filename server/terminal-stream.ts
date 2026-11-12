import { join } from "node:path";
import type { ServerWebSocket, Subprocess, Terminal } from "bun";
import { defaultCoreBin, type Config } from "./config.ts";
import type { OrchestratorApi } from "./orchestrator-api.ts";
import { childEnv } from "./runner/env.ts";
import { ApiError, type Store } from "./store.ts";
import type { ErrorCode } from "../shared/error-codes.ts";

export type TerminalMode = "observe" | "control";
export type TerminalSizePolicy = "core" | "fit";
/**
 * authGeneration: 공용 접속 코드로 연 연결의 코드 세대(코드를 바꾸면 닫는다).
 * deviceId(G): 기기 열쇠로 연 연결의 기기. 그 기기를 끊으면 닫고, 공용 코드를 바꿔도 그대로다.
 */
export interface TerminalSocketData { kind: "terminal"; authGeneration: number; deviceId?: string; stream: TerminalStream }
export interface RealtimeSocketData { kind: "realtime"; authGeneration: number; deviceId?: string; protocol: 1 | 2 }
export type SocketData = TerminalSocketData | RealtimeSocketData;
const MAX_BUFFER = 4 * 1024 * 1024;
export interface TerminalStreamsOptions {
  /** How long a dropped control socket may reattach with its lease before the server releases it. */
  orphanLeaseMs?: number;
}

export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const integer = (raw: unknown, fallback: number) => {
    if (raw === null || raw === undefined) return fallback;
    if ((typeof raw !== "number" && typeof raw !== "string") || raw === "" || !Number.isSafeInteger(Number(raw))) {
      throw new ApiError(400, "터미널 크기는 정수여야 합니다", "terminal_size_invalid");
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
  private readonly orphans = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly orphanLeaseMs: number;
  private lastTick = performance.now();
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
    // A crashed app or a lost network never sends the HTTP release. Without this the lease
    // fences this member's deliveries until its five-minute expiry.
    if (reason !== "replaced" && reason !== "lease_ended" && reason !== "terminal_gone" && stream.leaseId && !this.stopped) {
      let seenExpiresAt: number | undefined;
      try { seenExpiresAt = this.orch.terminalStreamLease?.(stream.memberId)?.expiresAt; } catch { /* checked again when due */ }
      this.watchOrphan(stream.memberId, stream.leaseId, seenExpiresAt);
    }
  }
  private watchOrphan(memberId: string, leaseId: string, seenExpiresAt: number | undefined, attempt = 0): void {
    clearTimeout(this.orphans.get(memberId));
    const timer = setTimeout(() => {
      this.orphans.delete(memberId);
      void this.releaseOrphanLease(memberId, leaseId, seenExpiresAt).then(outcome => {
        // Release is refused while a session operation runs. Try a few more times before the expiry does it.
        if (outcome === "retry" && attempt < 5 && !this.stopped && !this.orphans.has(memberId)) this.watchOrphan(memberId, leaseId, seenExpiresAt, attempt + 1);
      });
    }, attempt === 0 ? this.orphanLeaseMs : Math.min(this.orphanLeaseMs, 5_000));
    timer.unref();
    this.orphans.set(memberId, timer);
  }
  /** Releases a lease whose control socket never came back. A reattached or otherwise renewed lease is left alone. */
  async releaseOrphanLease(memberId: string, leaseId: string, seenExpiresAt?: number): Promise<"released" | "kept" | "retry"> {
    if (this.stopped) return "kept";
    if ([...this.streams].some(s => s.memberId === memberId && s.mode === "control" && s.leaseId === leaseId && !s.closed)) return "kept";
    let lease: ReturnType<NonNullable<OrchestratorApi["terminalStreamLease"]>>;
    try { lease = this.orch.terminalStreamLease?.(memberId) ?? null; } catch { return "retry"; }
    if (!lease || lease.leaseId !== leaseId) return "kept";
    // Renewed since the socket dropped: the holder is alive on another path (HTTP input).
    if (seenExpiresAt !== undefined && lease.expiresAt > seenExpiresAt) return "kept";
    if (!this.orch.terminalControl) return "kept";
    try { await this.orch.terminalControl(memberId, { action: "release", leaseId }); }
    catch { return "retry"; }
    try { this.store.appendActivity(memberId, "system", "터미널 연결이 끊겨 직접 조작을 자동으로 끝냈습니다"); } catch { /* member may have been removed */ }
    return "released";
  }
  constructor(readonly config: Config, readonly store: Store, readonly orch: OrchestratorApi, options: TerminalStreamsOptions = {}) {
    this.orphanLeaseMs = Math.max(1, options.orphanLeaseMs ?? 20_000);
    this.timer = setInterval(() => {
      // While the loop was blocked no ping could leave and no pong could be read.
      const now = performance.now(), stalled = now - this.lastTick > 3000;
      this.lastTick = now;
      for (const stream of this.streams) stream.check(stalled);
    }, 1000);
    this.timer.unref();
    if ("onTerminalStreamShutdown" in orch) this.unsubscribe = orch.onTerminalStreamShutdown?.(() => this.close());
    if ("onTerminalLeaseEnded" in orch) this.unsubscribeLease = orch.onTerminalLeaseEnded?.(async (memberId, leaseId) => {
      await Promise.all([...this.streams].map(stream => stream.endLease(memberId, leaseId)));
      await this.restore(memberId);
    });
  }
  async prepare(memberId: string, url: URL): Promise<TerminalStream> {
    const mode = url.searchParams.get("mode") ?? "observe";
    if (mode !== "observe" && mode !== "control") throw new ApiError(400, "터미널 연결 방식이 잘못되었습니다", "terminal_mode_invalid");
    const sizePolicy = url.searchParams.get("size") ?? "fit";
    if (sizePolicy !== "core" && sizePolicy !== "fit") throw new ApiError(400, "터미널 크기 정책이 잘못되었습니다", "terminal_size_policy_invalid");
    const member = this.store.requireMember(memberId);
    const project = this.store.requireProject(member.projectId);
    if (this.stopped || member.backend !== "core" || !member.paneId || member.origin === "manual" || project.archived || !project.runnerEnabled) {
      throw new ApiError(409, "지금 터미널을 열 수 없습니다", "TERMINAL_REFUSED");
    }
    if (!this.orch.terminalStreamInfo) throw new ApiError(501, "터미널 스트림을 지원하지 않습니다", "terminal_stream_unsupported");
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
      if (this.streams.size > 12 || peers.length > (mode === "observe" ? 3 : 1)) throw new ApiError(429, "열린 터미널이 너무 많습니다", "terminal_stream_limit");
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
    for (const timer of this.orphans.values()) clearTimeout(timer);
    this.orphans.clear();
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
  private sizeFailures = 0;
  restoreSize?: { cols: number; rows: number };
  private lastSizeCheck = 0;
  private lastPong = Date.now();
  private lastPing = Date.now();
  constructor(private readonly owner: TerminalStreams, readonly memberId: string, readonly paneId: string,
    readonly mode: TerminalMode, public size: { cols: number; rows: number }, readonly leaseId: string | null,
    readonly sizePolicy: TerminalSizePolicy = "fit") {}
  get closed(): boolean { return this.ended; }

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
    // code: 거절의 좁은 사유(shared/error-codes.ts). 앱은 문장 대신 이것으로 가른다. 없으면 싣지 않는다.
    const code = reason === "refused" && failure instanceof ApiError ? failure.reason ?? failure.code : undefined;
    void this.close(reason, reason === "refused" && failure instanceof Error ? failure.message : "터미널에 연결할 수 없습니다", code);
  }
  async refreshSize(): Promise<void> {
    if (this.ended || (this.mode !== "observe" && this.sizePolicy !== "core") || this.sizeCheck) return;
    this.sizeCheck = true;
    try {
      const size = await this.owner.orch.terminalStreamInfo!(this.memberId);
      this.sizeFailures = 0;
      if (!this.ended && (size.cols !== this.size.cols || size.rows !== this.size.rows)) {
        this.size = size;
        if (this.mode === "control") this.resizePTY();
        if (this.ready) this.sendText({ type: "resize", ...size });
      }
    } catch (error) {
      // One failed size check (a slow core call, a brief session operation) must not drop a healthy
      // screen and its scrollback. Only a gone terminal or about ten seconds of failures closes it.
      if ((error instanceof ApiError && error.code === "TERMINAL_GONE") || ++this.sizeFailures >= 5) this.fail(error);
    }
    finally { this.sizeCheck = false; }
  }
  check(stalled = false): void {
    if (this.ended) return;
    try { this.requireLease(true); } catch (error) { this.fail(error); return; }
    if (this.ws) {
      const now = Date.now();
      // A blocked event loop is not client silence: give the peer one ping interval after it resumes.
      if (stalled) this.lastPong = Math.max(this.lastPong, now - 15_000);
      if (now - this.lastPong >= 30_000) { void this.close("timeout"); return; }
      if (now - this.lastPing >= 15_000) { this.lastPing = now; this.ws.ping(); }
      if (this.ws.getBufferedAmount() > MAX_BUFFER) void this.close("slow_client");
    }
    if (this.started && Date.now() - this.lastSizeCheck >= 2000) {
      this.lastSizeCheck = Date.now();
      // This attach shows the old terminal once the member moved to another one. Control is covered by its lease identity.
      if (this.mode === "observe" && this.owner.store.getMember(this.memberId)?.paneId !== this.paneId) { void this.close("terminal_gone"); return; }
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
  close(reason?: string, message?: string, code?: ErrorCode): Promise<void> {
    if (this.closing) return this.closing;
    if (this.ended) return Promise.resolve(); // Bun may synchronously re-enter via websocket.close.
    this.ended = true;
    if (reason) this.sendText({ type: "closed", reason, ...(message ? { message } : {}), ...(code ? { code } : {}) });
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
