import { classifyTurnError, usageLimitMenu, networkRetryScreen } from "../api-outage.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { capturedContext } from "./statusline.ts";
import { readCodexContextFile } from "./codex-context.ts";
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovalPrompt, Backend } from "../../shared/types.ts";
import { claudeFolderTrust, codexFolderTrust, looksLikeFolderTrust } from "./core-approval.ts";
import { cleanText } from "../text.ts";
import { childEnv } from "./env.ts";
import { inputText, screenContextPct } from "./claude-screen.ts";
import { defaultClaudeHome, findSessionFile } from "./session-files.ts";
import { CoreError, coreRpc, coreSocketPath, type CoreHello, type CoreTerminal } from "./core-client.ts";
import { providerFor, providerLaunch, isProviderArgv, type ProviderBins } from "./providers.ts";
import { codexBindingMarker, discoverCodexSession, observeCompactBoundary, type CodexBindingCursor, type CompactBoundaryBaseline, type CompactBoundaryCursor } from "./core-context.ts";
import { readDeliveryEvidence, readJsonlRange, parseCodexSessionMeta, providerLogPath, type DeliveryEvidenceCursor, type JsonlCursor } from "./delivery-evidence.ts";
import type { DeliveryDispatch, RunnerRecoveryStore, TerminalLease } from "../service-contracts.ts";
import { readTranscriptTail, transcriptPath } from "./transcript.ts";
import { HookShadow } from "./hook-compare.ts";
import { hookEventsDir } from "./hooks.ts";
import type { FullRunner, RunnerEvent, RunnerMember, SendResult, StartOpts, TerminalControlAction, TerminalControlResult, DeliveryProbe, DeliveryInspection, DeliveryRepair, DeliveryLogBaseline, RunnerTerminalIdentity, RunnerReattachResult, RunnerObservation } from "./types.ts";

/** claudeHome: Claude session transcripts (default CLAUDE_CONFIG_DIR or ~/.claude), read for context usage only. */
export interface CoreRunnerOptions extends ProviderBins { coreBin?: string; socketPath?: string; session?: string; stateDir?: string; configDir?: string; claudeHome?: string; codexHome?: string; contextHome?: string }
export interface CoreCompactState {
  id: string; baseline: CompactBoundaryBaseline; phase: "sending" | "running" | "uncertain" | "succeeded" | "failed";
  startedAt: number; cursor: CompactBoundaryCursor | null;
  reason?: "user_resolved";
  /** Only acknowledged human input can arm resolution; idle alone is insufficient. */
  manualResolution?: { turn: number | null; unsettled: boolean };
}
export interface CoreRunnerDeps {
  pollMs?: number; pollConcurrency?: number; rpcTimeoutMs?: number; sendTimeoutMs?: number; compactTimeoutMs?: number;
  /** Poll scheduling clock; does not change persisted observation timestamps or RPC deadlines. */
  pollNow?: () => number;
  contextTimeoutMs?: number; usageLimitCloseTimeoutMs?: number;
  /** How long a launched CLI may stay without any status report before the block is labelled start_not_ready. Default 60s. */
  startNotReadyMs?: number;
  /**
   * How long a just-launched CLI that has not reported yet is treated as starting rather than blocked. Default 0 (off);
   * the production assembly (createOrchestrator) turns it on. Recognized dialogs are never held back.
   */
  startQuietMs?: number;
  /** How long one inspection keeps reading a legacy (baseline-less) provider log before returning scan_pending. */
  evidenceScanMs?: number;
  readContext?: typeof capturedContext;
  recoveryStore?: RunnerRecoveryStore;
  /** Synchronous transaction ports. A throw prevents external input. */
  repair?: { load(memberId: string, request: DeliveryRepair): DeliveryDispatch | null; prepare(memberId: string, request: DeliveryRepair, dispatch: DeliveryDispatch): boolean };
  /**
   * unconfirmed: the write ended without a receipt (its outcome is unknown, but nothing more can arrive from it).
   * riskApproved: the owner accepted the risk of a duplicate for every item of this envelope.
   */
  quiescence?: (memberId: string, dispatch: DeliveryDispatch) => { originalWrite: "not_written" | "rejected" | "settled" | "unresolved"; externalInput: boolean | null; unconfirmed?: boolean; riskApproved?: boolean };
  submitKeyVerified?: boolean;
  compactStore?: { load(memberId: string): CoreCompactState | null; save(memberId: string, state: CoreCompactState): void };
  /** E1: 훅 기록과 지금 판정을 맞대어 세기만 한다. 없으면 contextHome 이 있고 훅을 넣을 때 만든다. false 면 끈다. */
  hookShadow?: HookShadow | false;
}
interface Track {
  composerEmpty: boolean | null;
  statusPublishedAt: number;
  publishedStatus: string | null;
  pendingStatus: Extract<RunnerEvent, { type: "status" }> | null;
  statusTimer: ReturnType<typeof setTimeout> | null;
  statusKey: string | null;
  setupAttempted: string | null;
  setupError: { code: string; note: string } | null;
  member: RunnerMember; terminal: CoreTerminal; sessionId: string | null; pending: boolean; uncertain: boolean; status: string | null;
  /** Uncertainty from input that has no dispatch (manual control, approval keys, parallel command). The store cannot resolve it. */
  controlUncertain: boolean;
  /** The persisted input state could not be read when this terminal was bound. Input stays fenced until a re-read succeeds. */
  restorePending: boolean;
  /** The Codex rollout file of this session, once found. */
  logFile: { sessionId: string; path: string } | null;
  /** The status report is gone but the turn is known to be over (decided by observe, which also reads the screen). */
  lost: boolean;
  /** When a live terminal's status report first went missing (pollNow). */
  silentSince: number | null;
  /** Last store re-read of the uncertain fence (pollNow) and how many re-reads left it in place. */
  settledAt: number; settleTries: number;
  epoch: number; endedTurn: number; completing: boolean; refresh: Promise<CoreTerminal> | null;
  nonce: string | null; bindingSince: string; binding: CodexBindingCursor | null; compact: CoreCompactState | null;
  dispatches: DeliveryDispatch[]; evidence: Map<string, DeliveryEvidenceCursor>; lastError: string | null;
  nextPollAt: number; pollDelay: number;
  observedAt: string; failures: number; failure: string | null;
}
const REQUIRED_METHODS = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill"];
/** herdr-core actually sends permission, question and auth; the other words are legacy. */
const BLOCKED_KINDS: Record<string, "permission" | "selection" | "setup"> = { permission: "permission", selection: "selection", setup: "setup", question: "selection", auth: "setup" };
const SILENT_SETTLE_MS = 750;
const unsupported = (detail: string): Extract<SendResult, { ok: false }> => ({ ok: false, reason: "error", retryable: false, deliveryEffect: "not_written", detail });

/** Capture an EOF baseline, not an exhaustive delivery/absence scan of history. */
function compactLogBaseline(root: string, path: string): JsonlCursor | null {
  const target = providerLogPath(root, path);
  if (!target) return null;
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || providerLogPath(root, path) !== target) return null;
    const tail = Buffer.alloc(Math.min(stat.size, 4 * 1024 * 1024));
    const start = stat.size - tail.length;
    if (readSync(fd, tail, 0, tail.length, start) !== tail.length || (tail.length && tail.at(-1) !== 10)) return null;
    // Skip the first potentially partial line. Never adopt a partial EOF or an
    // oversized last line as a completed baseline, even if it contains a marker.
    let offset = start;
    if (start > 0) {
      const previous = Buffer.alloc(1);
      if (readSync(fd, previous, 0, 1, start - 1) !== 1) return null;
      if (previous[0] !== 10) {
        offset += tail.indexOf(10) + 1;
        if (offset <= start || offset === stat.size) return null;
      }
    }
    const range = readJsonlRange(root, path, null, { startOffset: offset, fileIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` });
    return range.complete && range.cursor?.offset === stat.size ? range.cursor : null;
  } catch { return null; }
  finally { closeSync(fd); }
}

/**
 * EOF position of the provider log at a line boundary, without reading its history. A delivery envelope stores it so
 * that receipt checks read only what was appended after the send. Evidence used to be scanned from byte 0, 4 MiB per
 * check: on the real 200-500 MB transcripts a delivered message took 20 minutes to 2 hours to confirm.
 */
export function eofLogBaseline(root: string, path: string): DeliveryLogBaseline | null {
  const target = providerLogPath(root, path);
  if (!target) return null;
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || providerLogPath(root, path) !== target) return null;
    if (stat.size > 0) {
      // A partial last line cannot anchor a scan; that envelope falls back to the full scan.
      const last = Buffer.alloc(1);
      if (readSync(fd, last, 0, 1, stat.size - 1) !== 1 || last[0] !== 10) return null;
    }
    return { path, fileIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, offset: stat.size, eventId: null };
  } catch { return null; }
  finally { closeSync(fd); }
}

/** Terminals belong to core's holders. IAMCEO shutdown only detaches. */
export class CoreRunner implements FullRunner {
  readonly kind: Backend = "core";
  /** send() never writes into a working CLI: an urgent delivery waits for the turn to end like any other. */
  readonly interjects: boolean = false;
  readonly socketPath: string;
  private readonly rpcTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly operation = new AsyncLocalStorage<{ signal: AbortSignal; waiting: (stage: string) => void; deadline: number }>();
  private readonly tracks = new Map<string, Track>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private readonly configuring = new Set<string>();
  private readonly parallelPreferences = new Map<string, boolean>();
  private readonly leases = new Map<string, TerminalLease>();
  private readonly lostCodex = new Map<string, number | undefined>();
  private readonly unknownStarts = new Set<string>();
  private readonly sending = new Set<string>();
  private readonly starts = new Map<string, Promise<{ sessionId: string | null; paneId: string; rejoined?: boolean }>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly polling = new Set<Track>();
  private readonly inputRefreshes = new Map<Track, ReturnType<typeof setTimeout>>();
  private closed = false;
  private methods = new Set<string>();
  /** E1 나란히 모으기. 판정에는 쓰지 않는다. */
  private readonly hookShadow: HookShadow | null;

  constructor(private readonly options: CoreRunnerOptions = {}, private readonly deps: CoreRunnerDeps = {}) {
    this.socketPath = options.socketPath || coreSocketPath(options.session);
    this.rpcTimeoutMs = deps.rpcTimeoutMs ?? 8000;
    this.sendTimeoutMs = deps.sendTimeoutMs ?? 20_000;
    // 훅은 contextHome 이 있을 때만 넣는다(providers.ts). 같은 조건에서만 비교한다.
    this.hookShadow = deps.hookShadow === false ? null : deps.hookShadow ?? (options.contextHome && (options.hookEvents ?? process.env.IAMCEO_HOOK_EVENTS !== "0") ? new HookShadow({ eventsDir: hookEventsDir(options.contextHome) }) : null);
  }
  /** Scope cancellation to this attempt; a late read must never initiate another input. */
  withSignal<T>(signal: AbortSignal, waiting: (stage: string) => void, action: () => Promise<T>, deadline: number): Promise<T> {
    return this.operation.run({ signal, waiting, deadline }, action);
  }
  private waitFor<T>(stage: string, action: () => Promise<T>, timeoutMs: number): Promise<T> {
    const scope = this.operation?.getStore();
    if (scope?.signal.aborted) return Promise.reject(scope.signal.reason);
    scope?.waiting(stage);
    return new Promise<T>((resolve, reject) => {
      const finish = (error: unknown, value?: T) => {
        clearTimeout(timer);
        scope?.signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(value as T);
      };
      const aborted = () => finish(scope!.signal.reason);
      const timer = setTimeout(() => finish(new CoreError("timeout", `${stage}: no completion within ${timeoutMs}ms`, true)), timeoutMs);
      scope?.signal.addEventListener("abort", aborted, { once: true });
      try { action().then(value => finish(null, value), error => finish(error)); }
      catch (error) { finish(error); }
    });
  }
  private call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.rpcTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new CoreError("closed", "CoreRunner is shut down"));
    const scope = this.operation.getStore();
    if (scope) {
      if (scope.signal.aborted) return Promise.reject(scope.signal.reason);
      const remaining = scope.deadline - Date.now();
      if (remaining <= 0) return Promise.reject(new CoreError("timeout", `${method}: pump deadline expired before RPC`, false, "not_written"));
      scope.waiting(method);
      timeoutMs = Math.min(timeoutMs, remaining);
    }
    // Let coreRpc destroy its socket before releasing the runner's input lock.
    // Racing a live socket against abort could otherwise allow a late connect
    // to write after a manual lease had been admitted. Non-pump input is unchanged.
    return coreRpc<T>(this.socketPath, method, params, timeoutMs);
  }
  async available(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const hello = await this.call<CoreHello>("hello", { generation: 1 });
      if (hello.generation !== 1) throw new CoreError("unsupported_generation", `Unsupported herdr-core generation: ${hello.generation}`);
      const missing = REQUIRED_METHODS.filter((method) => !hello.methods?.includes(method));
      if (missing.length) throw new CoreError("unsupported", `Core is missing methods: ${missing.join(", ")}`);
      this.methods = new Set(hello.methods);
      return { ok: true, detail: `herdr-core ${hello.version} (${this.socketPath}); status requires OSC 7501; attach with hc attach` };
    } catch (error) { return { ok: false, detail: `${error instanceof Error ? error.message : error}. Start herdr-core with ${this.options.coreBin || "hc"} server start` }; }
  }
  on(callback: (event: RunnerEvent) => void): void { this.listeners.add(callback); }
  private emit(event: RunnerEvent): void { for (const callback of this.listeners) callback(event); }
  private observation(track: Track): RunnerObservation {
    return { terminalId: track.terminal.address, ...(track.member.sessionGeneration !== undefined ? { sessionGeneration: track.member.sessionGeneration } : {}), turn: track.terminal.turn ?? null, inputEpoch: track.epoch, observedAt: track.observedAt };
  }
  private event(track: Track, event: RunnerEvent): void {
    const observed = { ...this.observation(track), ...event };
    this.hookShadow?.observe(observed, providerFor(track.member));
    this.emit(observed);
  }
  private publishStatus(track: Track, event: Extract<RunnerEvent, { type: "status" }>): void {
    const delay = 250 - (Date.now() - track.statusPublishedAt);
    if (["working", "idle"].includes(event.status) && ["working", "idle"].includes(track.publishedStatus ?? "") && event.observation?.freshness === "fresh" && delay > 0) {
      track.pendingStatus = event;
      track.statusTimer ??= setTimeout(() => {
        track.statusTimer = null;
        const latest = track.pendingStatus; track.pendingStatus = null;
        if (!this.closed && this.tracks.get(track.member.id) === track && latest) this.publishStatus(track, latest);
      }, delay);
      return;
    }
    if (track.statusTimer) clearTimeout(track.statusTimer);
    track.statusTimer = null; track.pendingStatus = null;
    track.statusPublishedAt = Date.now();
    track.publishedStatus = event.status;
    this.event(track, event);
  }
  private identity(track: Track): RunnerTerminalIdentity {
    return { terminalId: track.terminal.address, sessionId: track.sessionId, sessionGeneration: track.member.sessionGeneration ?? -1,
      process: track.terminal.pid ? { pid: track.terminal.pid, startedAt: null } : null };
  }
  private sameIdentity(a: RunnerTerminalIdentity, b: RunnerTerminalIdentity): boolean {
    return a.terminalId === b.terminalId && a.sessionId === b.sessionId && a.sessionGeneration === b.sessionGeneration && (!a.process || !b.process || a.process.pid === b.process.pid);
  }
  private reserve(memberId: string): () => void {
    if (this.sending.has(memberId)) throw new CoreError("busy", "A terminal input mutation is in progress");
    this.sending.add(memberId);
    return () => this.sending.delete(memberId);
  }
  private bump(track: Track): void { track.epoch++; }
  private restore(track: Track): void {
    const state = this.deps.recoveryStore?.inputState(track.member.id);
    // Recovery phase can lag a durable pre-write refusal across a restart.
    track.dispatches = (state?.unresolvedDispatches ?? []).filter(d => d.transportState !== "rejected");
    track.uncertain ||= track.dispatches.length > 0;
    if (state?.lease && state.lease.expiresAt > Date.now() && this.sameIdentity({ ...state.lease.identity, sessionId: track.sessionId ?? state.lease.identity.sessionId }, { ...this.identity(track), sessionId: track.sessionId ?? state.lease.identity.sessionId })) this.leases.set(track.member.id, state.lease);
    const compact = this.deps.compactStore?.load(track.member.id);
    if (compact && compact.baseline.generation === track.member.sessionGeneration && compact.baseline.terminalId === track.terminal.address && compact.baseline.sessionId === track.sessionId && !["failed", "succeeded"].includes(compact.phase)) {
      track.compact = { ...compact, phase: "uncertain" }; track.uncertain = true;
    }
  }
  /**
   * A fence that came from a dispatch is lifted once the store has resolved that dispatch. It used to stay until
   * the server restarted, so the member accepted nothing (real 2026-11-07 and 11-10 runs). Fences from manual
   * input or compaction are left alone.
   */
  private settleUncertain(track: Track, marker?: string, polled = false): boolean {
    if (track.restorePending) {
      // Same pacing as the fence re-read below: soon at first, every 5 s while it keeps failing.
      const now = this.pollNow();
      if (polled && now >= track.settledAt && now - track.settledAt < Math.min(5000, 500 * 2 ** Math.min(track.settleTries, 4))) return false;
      track.settledAt = now; track.settleTries++;
      try { this.restore(track); } catch { return false; }
      track.restorePending = false; track.settleTries = 0; track.settledAt = -Infinity;
      // The fence set at bind stood in for whatever the store holds. Now that it was read, keep only what it says.
      track.uncertain = track.dispatches.length > 0 || !!track.compact && !["failed", "succeeded"].includes(track.compact.phase);
      if (!track.uncertain) { track.evidence.clear(); return true; }
    }
    if (!track.uncertain || track.controlUncertain || !this.deps.recoveryStore) return false;
    if (track.compact && !["failed", "succeeded"].includes(track.compact.phase)) return false;
    // The store read costs as much as the dispatch history. Recheck a fresh fence soon, a long one (waiting for the owner) every 5s.
    const now = this.pollNow();
    if (polled && now >= track.settledAt && now - track.settledAt < Math.min(5000, 500 * 2 ** Math.min(track.settleTries, 4))) return false;
    track.settledAt = now; track.settleTries++;
    let unresolved: DeliveryDispatch[];
    try { unresolved = this.deps.recoveryStore.inputState(track.member.id).unresolvedDispatches; }
    catch { return false; } // Unreadable (e.g. the member is being removed): stay fenced.
    // The dispatch being written right now is not a previous unresolved write.
    track.dispatches = unresolved.filter(d => d.transportState !== "rejected" && (!marker || d.bundleMarker !== marker));
    if (track.dispatches.length) return false;
    track.uncertain = false; track.settleTries = 0;
    track.evidence.clear();
    return true;
  }
  /** A terminal whose report vanished after a finished turn reads as done. */
  private stateOf(track: Track | undefined, terminal: CoreTerminal): string | undefined {
    return track?.lost && track.terminal === terminal && !terminal.status ? "done" : terminal.status?.state;
  }
  private validateTrack(track: Track): void {
    this.operation.getStore()?.signal.throwIfAborted();
    if (this.closed || this.tracks.get(track.member.id) !== track) throw new CoreError("conflict", "Terminal generation changed during operation");
  }
  private assertMember(track: Track, member: RunnerMember): void {
    if (track.member.sessionGeneration !== member.sessionGeneration || track.member.projectId !== member.projectId || providerFor(track.member) !== providerFor(member) || track.member.cwd !== member.cwd || (member.sessionId && track.sessionId && member.sessionId !== track.sessionId)) throw new CoreError("conflict", "Member identity or session generation changed");
  }
  private labels(member: RunnerMember) { return { "iamceo.member": member.id, "iamceo.project": member.projectId, "iamceo.cli": providerFor(member) }; }
  private owns(terminal: CoreTerminal, member: RunnerMember): boolean {
    return Object.entries(this.labels(member)).every(([key, value]) => terminal.labels?.[key] === value) && (member.sessionGeneration === undefined || terminal.labels?.["iamceo.generation"] === String(member.sessionGeneration));
  }
  private name(member: RunnerMember): string { return `iamceo-${createHash("sha256").update(`${member.projectId}:${member.id}`).digest("hex").slice(0, 24)}`; }
  private async bind(member: RunnerMember, terminal: CoreTerminal, sessionId: string | null): Promise<Track> {
    if (this.closed) throw new CoreError("closed", "CoreRunner shut down while starting; terminal remains owned by core");
    const launch = terminal.labels["iamceo.operation"] ? this.deps.recoveryStore?.getLifecycleJournal?.(terminal.labels["iamceo.operation"]) : null;
    const launchedAt = launch?.memberId === member.id && launch.intent === "start" ? launch.createdAt : null;
    const track: Track = { member: { ...member }, terminal, sessionId, pending: false, uncertain: false, controlUncertain: false, restorePending: false, lost: false, silentSince: null, settledAt: -Infinity, settleTries: 0, status: null, statusKey: null, composerEmpty: null, statusPublishedAt: 0, publishedStatus: null, pendingStatus: null, statusTimer: null, setupAttempted: null, setupError: null,
      epoch: 0, endedTurn: terminal.turn ?? 0, completing: false, refresh: null, nonce: terminal.labels["iamceo.binding"] || null, bindingSince: terminal.labels["iamceo.startedAt"] || launchedAt || new Date().toISOString(), binding: null, compact: null,
      dispatches: [], evidence: new Map(), logFile: null, lastError: null, nextPollAt: 0, pollDelay: this.pollMs, observedAt: new Date().toISOString(), failures: 0, failure: null };
    // The terminal exists whether or not the persisted input state can be read. Throwing here left a terminal that
    // nobody tracked (terminal.run had already succeeded) and a start whose result read as unknown: every later
    // wake then failed the same way. Track it and fence input instead; the fence lifts once the state reads again.
    try { this.restore(track); } catch { track.restorePending = true; track.uncertain = true; }
    this.tracks.set(member.id, track);
    await this.observe(track, terminal, true);
    this.event(track, { type: "pane", memberId: member.id, paneId: terminal.address });
    if (sessionId) this.event(track, { type: "session", memberId: member.id, sessionId });
    if (!this.timer) {
      this.timer = this.operation.exit(() => setInterval(() => { this.poll(); }, Math.min(this.pollMs, 250)));
      this.timer.unref?.();
    }
    return track;
  }
  start(member: RunnerMember, opts: StartOpts): Promise<{ sessionId: string | null; paneId: string; rejoined?: boolean }> {
    const pending = this.starts.get(member.id);
    if (pending) return pending;
    let release: () => void;
    try { release = this.reserve(member.id); } catch (error) { return Promise.reject(error); }
    const promise = this.startLocked(member, opts).finally(() => { this.starts.delete(member.id); release(); });
    this.starts.set(member.id, promise);
    return promise;
  }
  private async startLocked(member: RunnerMember, opts: StartOpts) {
    const joined = await (async () => {
      const availability = await this.available();
      if (!availability.ok) throw new CoreError("unavailable", availability.detail || "Core unavailable");
      const snapshot = await this.call<{ terminals: CoreTerminal[] }>("terminal.list", {});
      return this.reattachFrom(member, snapshot.terminals.filter(terminal => terminal.state === "live"));
    })().catch(error => {
      // These RPCs only observe; a lost read reply cannot have created a CLI.
      if (error instanceof CoreError) throw new CoreError(error.kind, error.message, false, "not_written", error.causeCode);
      throw error;
    });
    if (joined.outcome === "rejoined") return { sessionId: joined.started.sessionId, paneId: joined.started.paneId!, rejoined: true };
    if (joined.outcome !== "not_found") throw new CoreError(joined.outcome, joined.detail || joined.code);
    if (this.unknownStarts.has(member.id)) throw new CoreError("starting_unknown", "Previous terminal.run may still create a holder; read-only reattach is required");
    // A persisted core pane is evidence of a previous program. Never replace it
    // on a transport failure, a missing snapshot, or an unknown Codex session.
    if (member.origin === "adopted") throw new CoreError("unsupported", "Core does not adopt terminals without IAMCEO ownership labels");
    if (providerFor(member) === "codex" && (member.paneId || (this.lostCodex.has(member.id) && this.lostCodex.get(member.id) === member.sessionGeneration)) && !member.sessionId) throw new CoreError("session_unknown", "The previous Codex terminal is gone and its native session id is unknown; explicitly start a fresh session with context handoff");
    const launch = providerLaunch(member, opts, this.options);
    const env = childEnv();
    for (const key of Object.keys(env)) if (/^(HC_|HERDR_)/.test(key)) delete env[key];
    // The core itself uses isolated XDG directories; its provider programs
    // retain the user's normal configuration/state roots.
    env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    env.XDG_STATE_HOME = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    if (this.options.claudeHome) env.CLAUDE_CONFIG_DIR = this.options.claudeHome;
    if (this.options.codexHome) env.CODEX_HOME = this.options.codexHome;
    Object.assign(env, launch.env);
    const nonce = providerFor(member) === "codex" ? crypto.randomUUID().replaceAll("-", "") : null;
    let terminal: CoreTerminal;
    try { terminal = await this.call<CoreTerminal>("terminal.run", {
      argv: launch.argv, cwd: member.cwd, env, name: this.name(member), size: { cols: 160, rows: 50 },
      labels: { ...this.labels(member), "iamceo.startedAt": new Date().toISOString(), ...(member.sessionGeneration !== undefined ? { "iamceo.generation": String(member.sessionGeneration) } : {}), ...(opts.operationId ? { "iamceo.operation": opts.operationId } : {}), ...(nonce ? { "iamceo.binding": nonce } : {}), ...(launch.sessionId ? { "iamceo.session": launch.sessionId } : {}) },
      no_parent: true, outlive_parent: true, no_notify: true, keep: false, rm: false, wait: false,
    }, this.sendTimeoutMs);
      if (!terminal?.address || !terminal.labels || !Array.isArray(terminal.argv) || terminal.cwd !== member.cwd || !this.owns(terminal, member) || (terminal.turn !== undefined && (!Number.isSafeInteger(terminal.turn) || terminal.turn < 0))) throw new CoreError("protocol", "Invalid terminal.run identity; creation may have occurred", true);
    } catch (error) { if (!(error instanceof CoreError) || error.uncertain) this.unknownStarts.add(member.id); throw error; }
    // A timed-out run may have spawned a holder. A later start first searches
    // the stable member labels/name, rather than replaying terminal.run.
    await this.bind(member, terminal, launch.sessionId);
    return { sessionId: launch.sessionId, paneId: terminal.address };
  }
  /** The orchestrator verified that no owned terminal appeared; a later start may create one again. */
  forgetUnknownStart(memberId: string): void { this.unknownStarts.delete(memberId); }
  async reattachOwned(member: RunnerMember): Promise<RunnerReattachResult> {
    // Re-observing an attached terminal only reads. Holding the input lock for it made the periodic supervisor
    // pass collide with deliveries, sleep and manual control ("busy"). Lock only when a terminal must be bound.
    const attached = this.tracks.get(member.id);
    if (attached && attached.member.sessionGeneration === member.sessionGeneration) {
      const result = await this.reattachWith(member, attached);
      if (result.outcome === "rejoined" || result.code !== "rebind_required") return result;
    }
    return this.reattachWith(member, null);
  }
  /** observed: re-observe that track without the lock; rebind_required means another terminal must be bound under it. */
  private async reattachWith(member: RunnerMember, observed: Track | null): Promise<RunnerReattachResult> {
    let release: (() => void) | null = null;
    try {
      if (!observed) release = this.reserve(member.id);
      const hello = await this.call<CoreHello>("hello", { generation: 1 });
      if (hello.generation !== 1) return { outcome: "conflict", code: "unsupported_generation" };
      this.methods = new Set(hello.methods);
      const snapshot = await this.call<{ terminals: CoreTerminal[] }>("terminal.list");
      const result = await this.reattachFrom(member, snapshot.terminals.filter((terminal) => terminal.state === "live"), observed);
      // A mutation ran while we looked without the lock: do not judge absence or conflict from that snapshot.
      if (observed && result.outcome !== "rejoined" && (this.sending.has(member.id) || this.tracks.get(member.id) !== observed)) return { outcome: "unknown", code: "mutation_in_progress" };
      return result;
    } catch (error) {
      // Sleep or start replaced the terminal while we looked without the lock; the observation is stale.
      if (observed && !this.closed && this.tracks.get(member.id) !== observed) return { outcome: "unknown", code: "mutation_in_progress" };
      return { outcome: error instanceof CoreError && error.kind === "conflict" ? "conflict" : "unknown", code: error instanceof CoreError ? error.kind : "error", detail: error instanceof Error ? error.message : String(error) };
    }
    finally { release?.(); }
  }
  private async reattachFrom(member: RunnerMember, live: CoreTerminal[], observed: Track | null = null): Promise<RunnerReattachResult> {
    const matches = live.filter((terminal) => terminal.labels?.["iamceo.member"] === member.id && terminal.labels?.["iamceo.project"] === member.projectId);
    if (live.some(terminal => (terminal.address === member.paneId || terminal.labels?.["iamceo.member"] === member.id) && !this.owns(terminal, member))) return { outcome: "conflict", code: "ownership_changed", detail: "A recorded terminal or member label has conflicting ownership" };
    if (member.sessionId && live.some((terminal) => terminal.labels?.["iamceo.session"] === member.sessionId && !this.owns(terminal, member))) return { outcome: "conflict", code: "session_owned", detail: "CLI session is already owned by another live terminal" };
    if (!matches.length) return { outcome: "not_found", code: "no_owned_terminal" };
    if (matches.length !== 1) return { outcome: "conflict", code: "multiple_terminals", detail: "Multiple live terminals claim this member" };
    const terminal = matches[0];
    if (!this.owns(terminal, member) || !isProviderArgv(terminal.argv, providerFor(member), providerFor(member) === "claude" ? this.options.claudeBin : this.options.codexBin) || terminal.cwd !== member.cwd ||
      (member.sessionId && terminal.labels["iamceo.session"] && terminal.labels["iamceo.session"] !== member.sessionId)) return { outcome: "conflict", code: "ownership_changed", detail: "Core terminal ownership, provider, cwd or generation changed" };
    const current = this.tracks.get(member.id);
    const sessionId = terminal.labels["iamceo.session"] || member.sessionId || (current?.terminal.address === terminal.address ? current.sessionId : null);
    const same = !!current && current.terminal.address === terminal.address && current.member.sessionGeneration === member.sessionGeneration;
    // A lock-free re-observation never binds: back off if the track changed, retry under the lock if another terminal is live.
    if (observed && current !== observed) return { outcome: "unknown", code: "mutation_in_progress" };
    if (observed && !same) return { outcome: "unknown", code: "rebind_required" };
    const track = same ? current! : await this.bind(member, terminal, sessionId);
    if (track === current) await this.refresh(track);
    if (observed && this.tracks.get(member.id) !== track) return { outcome: "unknown", code: "mutation_in_progress" };
    this.unknownStarts.delete(member.id);
    return { outcome: "rejoined", started: { sessionId: track.sessionId, paneId: terminal.address, rejoined: true, identity: this.identity(track) } };
  }
  private async observe(track: Track, terminal: CoreTerminal, initial = false): Promise<void> {
    this.validateTrack(track);
    const previous = track.terminal;
    if (terminal.turn !== undefined && (!Number.isSafeInteger(terminal.turn) || terminal.turn < 0)) throw new CoreError("protocol", "Invalid core turn counter");
    if (terminal.address !== previous.address || (previous.pid && terminal.pid && previous.pid !== terminal.pid)) throw new CoreError("conflict", "Core terminal process identity changed");
    if ((terminal.turn ?? 0) < (previous.turn ?? 0)) throw new CoreError("stale", "Discarded older core turn");
    track.terminal = terminal; track.lost = false;
    if (terminal.state !== "live" || terminal.status) track.silentSince = null; else track.silentSince ??= this.pollNow();
    track.observedAt = new Date().toISOString();
    const reported = terminal.status?.state;
    let status: "working" | "idle" | "blocked" | "gone" = terminal.state !== "live" ? "gone" : reported === "working" ? "working" : ["idle", "done", "error"].includes(reported || "") ? "idle" : "blocked";
    if (!initial && (terminal.turn !== previous.turn || reported !== previous.status?.state)) this.bump(track);
    if (status === "gone" && providerFor(track.member) === "codex" && !track.sessionId) this.lostCodex.set(track.member.id, track.member.sessionGeneration);
    // Pump input has its own mandatory composer read. Diagnostic screen reads must
    // not consume that attempt's deadline or hide its pre-write timeout boundary.
    const screen = terminal.state === "live" && (!this.operation.getStore() || status === "blocked") ? await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 }).then(r => r.text, () => null) : null;
    this.validateTrack(track);
    // A CLI that has run turns, cleared its status report and shows its normal composer has finished its turn.
    // Real 2026-11-09/10 runs: after a turn ended with an API error the report vanished; the CLI reports again only
    // after input and IAMCEO typed only after a report, so the member was dead until slept by hand.
    // A CLI that never reported (turn 0) and any screen without the composer (dialog, setup) stay blocked.
    // A turn whose end was not seen (counter moved, no report) is ended only after the gap has lasted a moment.
    const silent = track.silentSince !== null && terminal.reported !== false && (terminal.turn ?? 0) > 0 && screen !== null &&
      (providerFor(track.member) === "claude" ? inputText(screen) : codexDraft(screen)) !== null;
    track.lost = silent && ((terminal.turn ?? 0) <= track.endedTurn || this.pollNow() - track.silentSince! >= SILENT_SETTLE_MS);
    const state = track.lost ? "done" : reported;
    if (track.lost) status = "idle";
    const usage = screen !== null && state !== "working" ? usageLimitMenu(screen) : null;
    const retry = state === "working" && (screen === null ? track.setupError?.code === "network_retry" : networkRetryScreen(screen));
    if (initial && state === "error" && !track.compact) {
      track.lastError = usage?.raw ?? (terminal.status?.msg || "CLI reported an error");
      this.event(track, { type: "turn_end", memberId: track.member.id, finalText: "", isError: true, errorText: track.lastError });
    }
    // A compact OSC turn belongs exclusively to its control operation.
    if (track.compact && !["failed", "succeeded"].includes(track.compact.phase)) { await this.checkCompact(track); track.endedTurn = Math.max(track.endedTurn, terminal.turn ?? 0); }
    else if (!initial && ["idle", "done", "error"].includes(state || "") && (terminal.turn ?? 0) > track.endedTurn) {
      track.completing = true;
      try { if (!this.manualLease(track.member.id)) await this.reportContext(track); } finally { track.completing = false; }
      this.validateTrack(track);
      track.endedTurn = terminal.turn ?? track.endedTurn;
      track.pending = false;
      // An idle report never clears an unresolved external write fence.
      // A turn read as over only because its report vanished mostly ended in an API error, so it is no proof of a
      // working connection (inferred). When the CLI's own error line sits above the composer, end it as that error.
      const failed = track.lost && !usage ? screenTurnError(screen!) : null;
      track.lastError = usage?.raw ?? (state === "error" ? terminal.status?.msg || "CLI reported an error" : failed);
      this.event(track, { type: "turn_end", memberId: track.member.id, finalText: "", isError: state === "error" || !!usage || !!failed, ...(state === "error" || usage || failed ? { errorText: track.lastError! } : {}), ...(track.lost ? { inferred: true } : {}) });
    }
    if (status === "gone") track.pending = false;
    if (screen !== null && track.composerEmpty === false && ["idle", "done", "error"].includes(state ?? "") && !usage && (providerFor(track.member) === "claude" ? inputText(screen) : codexDraft(screen)) === "") {
      track.composerEmpty = true;
      this.event(track, { type: "input_ready", memberId: track.member.id });
    }
    const setup = screen !== null && !usage && status === "blocked" ? (providerFor(track.member) === "claude" ? claudeFolderTrust : codexFolderTrust)(screen, track.member.cwd) : null;
    // Labels for the owner only; neither sends a key. A dialog that merely reads like folder trust is never answered.
    const unreported = status === "blocked" && !usage && !setup && !reported;
    const trustLike = unreported && screen !== null && trustDialogLike(screen, providerFor(track.member));
    const notReady = unreported && !trustLike && (terminal.turn ?? 0) === 0 && Date.now() - Date.parse(track.bindingSince) >= (this.deps.startNotReadyMs ?? 60_000);
    track.setupError = usage ? { code: "usage_limit", note: usage.raw } : retry ? { code: "network_retry", note: "API 연결 복구를 기다리며 CLI가 재시도하고 있습니다" } : setup ? { code: "folder_trust", note: `폴더 신뢰 확인 창에서 멈췄습니다: ${track.member.cwd}` }
      : trustLike ? { code: "trust_dialog_unrecognized", note: `폴더 신뢰 확인 창으로 보이지만 정확히 읽지 못했습니다. 터미널을 열어 직접 답해 주세요: ${track.member.cwd}` }
      : notReady ? { code: "start_not_ready", note: "띄운 뒤 60초 넘게 준비를 알리지 않았습니다. 터미널을 열어 화면을 확인해 주세요" } : null;
    if (usage) { status = "blocked"; track.pending = false; }
    const blockedReason = usage ? "usage_limit" : setup ? "setup" : state === "blocked" ? BLOCKED_KINDS[terminal.status?.kind || ""] ?? "status_unknown" : status === "blocked" ? "status_unknown" : null;
    if (state === "error") {
      if (track.statusTimer) clearTimeout(track.statusTimer);
      track.statusTimer = null; track.pendingStatus = null;
    }
    const statusKey = JSON.stringify([status, blockedReason, setup?.prompt.fingerprint ?? null, usage?.fingerprint ?? null, retry, trustLike ? "trust_dialog_unrecognized" : notReady ? "start_not_ready" : null]);
    // While the end of a silent turn is being watched (SILENT_SETTLE_MS) nothing is blocked yet: publishing it sent the
    // owner an approval alert for a dialog that does not exist. The next observation decides.
    if (silent && !track.lost && !track.failure && blockedReason === "status_unknown") return;
    // A CLI launched a moment ago that has not reported yet is starting, not stopped at a dialog. Publishing it as
    // blocked showed 'blocked' in the roster for a few seconds and alerted the owner to an approval dialog on every wake
    // (real 2026-11-12: a member woken by hand was idle 6 s later, no dialog). A recognized dialog (folder trust, usage
    // limit) is published at once; a CLI still silent after startQuietMs is published as before.
    const starting = unreported && !trustLike && !notReady && (terminal.turn ?? 0) === 0 && Date.now() - Date.parse(track.bindingSince) < (this.deps.startQuietMs ?? 0);
    if (starting && !track.failure) return;
    if (statusKey !== track.statusKey || track.failure) {
      track.status = status;
      track.statusKey = statusKey;
      if (state === "error" && !usage) return; // Keep the error result from being overwritten by an earlier queued status.
      this.publishStatus(track, { type: "status", memberId: track.member.id, status, blockedReason, ...(usage ? { usageLimit: usage } : {}), observation: { source: "core", observedAt: track.observedAt, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: track.setupError }, ...(status === "gone" ? { exit: { reason: terminal.reason ?? null, exitCode: terminal.exit_code ?? null } } : {}) });
    }
  }
  /** 턴 끝 실측 창·사용량. core 는 문맥 표시만 하고 자동 압축은 하지 않는다. */
  private async reportContext(track: Track): Promise<void> {
    const sessionId = track.sessionId || track.member.sessionId;
    if (!sessionId) return;
    const endedAt = Date.now();
    const turn = track.terminal.turn;
    if (providerFor(track.member) === "codex") {
      const path = this.logPath(track);
      const reading = path ? readCodexContextFile(this.providerHome(track.member), path, sessionId).reading : null;
      if (reading) this.event(track, { type: "context_usage", memberId: track.member.id, ...reading, model: reading.model ?? track.member.model });
      return;
    }
    let tokens: number | null = null;
    let model: string | null = null;
    try {
      const path = findSessionFile(this.options.claudeHome ?? defaultClaudeHome(), track.member.cwd, sessionId);
      const tail = path ? readTranscriptTail(path) : null;
      tokens = tail?.contextTokens ?? null;
      model = tail?.model ?? null;
    } catch { /* unreadable transcript: the screen may still show the % */ }
    const screen = await this.call<{ text: string }>("terminal.read", { terminal: track.terminal.address, lines: 0 }, Math.min(this.rpcTimeoutMs, 1900)).then((r) => r.text, () => "");
    if (this.closed || this.tracks.get(track.member.id) !== track) return;
    const shownPct = screenContextPct(screen);
    const reading = await this.waitFor("context_file", () => (this.deps?.readContext ?? capturedContext)(this.options.contextHome, sessionId, { tokens, shownPct, model: track.member.model ?? model }, endedAt), this.deps?.contextTimeoutMs ?? 2000).catch((error): Awaited<ReturnType<typeof capturedContext>> => {
      this.operation?.getStore()?.signal.throwIfAborted();
      if (!(error instanceof CoreError) || error.kind !== "timeout") throw error;
      // Optional usage capture must not prevent an observed turn from ending.
      return { tokens, shownPct, model: track.member.model ?? model };
    });
    if (this.closed || this.tracks.get(track.member.id) !== track || (track.sessionId || track.member.sessionId) !== sessionId || track.terminal.turn !== turn) return;
    if (reading.tokens === null && reading.shownPct === null && !reading.exact) return;
    this.event(track, { type: "context_usage", memberId: track.member.id, sessionId, ...reading });
  }
  private refresh(track: Track): Promise<CoreTerminal> {
    if (track.refresh) return track.refresh;
    const startedAt = this.pollNow();
    const pending = (async () => {
      try {
        const terminal = await this.call<CoreTerminal>("terminal.get", { terminal: track.terminal.address });
        this.validateTrack(track);
        if (!this.owns(terminal, track.member) || !isProviderArgv(terminal.argv, providerFor(track.member), providerFor(track.member) === "claude" ? this.options.claudeBin : this.options.codexBin) || terminal.cwd !== track.member.cwd) throw new CoreError("conflict", "Core terminal ownership changed");
        if (!this.manualLease(track.member.id)) this.discoverBinding(track);
        await this.observe(track, terminal);
        track.failures = 0; track.failure = null;
        // Lifted: tell the orchestrator to push the deliveries it had been holding back.
        if (!this.sending.has(track.member.id) && this.settleUncertain(track, undefined, true)) this.event(track, { type: "input_ready", memberId: track.member.id });
        return track.terminal;
      } catch (error) {
        const previousFailure = track.failure;
        track.failures++; track.failure = error instanceof CoreError ? error.kind : "error";
        if (!this.closed && this.tracks.get(track.member.id) === track && previousFailure !== track.failure && track.failure !== "not_found") this.publishStatus(track, { type: "status", memberId: track.member.id, status: track.status as "working" | "idle" | "blocked" | "gone" || "blocked",
          observation: { source: "core", observedAt: track.observedAt, freshness: "stale", ownership: track.failure === "conflict" ? "conflict" : "unknown", consecutiveFailures: track.failures, error: { code: track.failure, note: "Core terminal observation failed; retry read-only inspection" } } });
        throw error;
      }
    })().finally(() => {
      if (track.refresh === pending) track.refresh = null;
      // A slow read is local to this employee, even when it eventually succeeds.
      const completedAt = this.pollNow();
      const delayed = track.failures > 0 || completedAt - startedAt >= this.pollMs;
      track.pollDelay = delayed
        ? Math.min(Math.max(this.pollMs, 30_000), track.pollDelay * 2) : this.pollMs;
      track.nextPollAt = delayed ? completedAt + track.pollDelay : startedAt + this.pollMs;
    });
    track.refresh = pending;
    return pending;
  }
  observationState(memberId: string): { observedAt: string; failures: number; failure: string | null; lastError: string | null; identity: RunnerTerminalIdentity; inputEpoch: number; setupError: Track["setupError"]; turn: number | null; state: string | null } | null {
    const track = this.tracks.get(memberId);
    return track ? { observedAt: track.observedAt, failures: track.failures, failure: track.failure, lastError: track.lastError, identity: this.identity(track), inputEpoch: track.epoch, setupError: track.setupError,
      // A finished turn whose report vanished reads as done here too, exactly as send() judges it.
      turn: track.terminal.state === "live" ? track.terminal.turn ?? null : null, state: track.terminal.state === "live" ? this.stateOf(track, track.terminal) ?? null : null } : null;
  }
  private get pollMs(): number { return Math.max(1, this.deps.pollMs ?? 1000); }
  private pollNow(): number { return (this.deps.pollNow ?? Date.now)(); }
  private poll(): void {
    if (this.closed) return;
    const limit = Math.max(1, Math.floor(this.deps.pollConcurrency ?? 4));
    const active = new Set([...this.polling, ...[...this.tracks.values()].filter(track => track.refresh)]);
    const now = this.pollNow();
    const due = [...this.tracks.values()].filter(track => !track.refresh && !this.polling.has(track) && track.nextPollAt <= now)
      .sort((a, b) => a.nextPollAt - b.nextPollAt);
    for (const track of due) {
      if (active.size >= limit) break;
      active.add(track); this.polling.add(track);
      void this.refresh(track).catch(async error => {
        // A socket outage is not proof a holder died. Only not_found ends it.
        if (!this.closed && this.tracks.get(track.member.id) === track && error instanceof CoreError && error.kind === "not_found") {
          await this.observe(track, { ...track.terminal, state: "finished", reason: "not_found" });
        }
      }).catch(() => undefined).finally(() => {
        this.polling.delete(track);
        this.poll();
      });
    }
  }
  isBusy(memberId: string): boolean {
    const track = this.tracks.get(memberId);
    return !!track && (track.pending || track.uncertain || track.restorePending || track.completing || track.status === "working" || !!track.compact && !["failed", "succeeded"].includes(track.compact.phase));
  }
  occupiesTurnSlot(memberId: string): boolean {
    const track = this.tracks.get(memberId);
    if (!track) return false;
    const compacting = !!track.compact && !["failed", "succeeded"].includes(track.compact.phase);
    // Real 2026-11-07 run: one needs_owner delivery left its track "uncertain" while the CLI sat idle, and that
    // phantom turn halved maxConcurrentTurns=2 for every other member. Unknown input on an observed-idle CLI
    // stays fenced for delivery, but it is not a running turn.
    const observedQuiet = track.status === "idle"; // includes done; a blocked CLI may be paused mid-turn and still counts
    return track.pending || track.completing || track.status === "working" || compacting || (track.uncertain && !observedQuiet);
  }
  async send(member: RunnerMember, text: string, opts: StartOpts, _urgent = false): Promise<SendResult> {
    if (!cleanText(text).trim()) return unsupported("Message is empty");
    if (this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: "CLI configuration is being reloaded" };
    if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written", detail: "Manual terminal control is active" };
    if (this.sending.has(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
    this.sending.add(member.id);
    let track = this.tracks.get(member.id);
    let deliveryAttempted = false;
    try {
      if (!track) { await this.startLocked(member, opts); track = this.tracks.get(member.id)!; }
      this.assertMember(track, member);
      this.settleUncertain(track, opts.marker);
      if (track.pending || track.uncertain || track.restorePending || track.completing || track.compact && !["failed", "succeeded"].includes(track.compact.phase)) return { ok: false, reason: "busy", retryable: false, deliveryEffect: "not_written", detail: "A previous send is still running or delivery is uncertain; inspect the terminal" };
      const terminal = await this.refresh(track);
      if (terminal.state !== "live") return { ok: false, reason: "gone", retryable: false, deliveryEffect: "not_written" };
      const state = this.stateOf(track, terminal);
      if (state === "working") return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      if (state === "blocked") return { ok: false, reason: "blocked", retryable: true, deliveryEffect: "not_written", detail: `Complete the CLI dialog with iamceo attach ${member.id}` };
      if (!["idle", "done", "error"].includes(state || "")) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: `No trustworthy idle OSC 7501 status; inspect CLI setup with iamceo attach ${member.id} (status=${JSON.stringify(terminal.status?.state ?? null)}, turn=${terminal.turn ?? null}, reported=${terminal.reported ?? null})` };
      const inputEpoch = track.epoch;
      const screen = await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 });
      const usage = usageLimitMenu(screen.text);
      if (usage) {
        track.status = "blocked";
        track.statusKey = JSON.stringify(["blocked", "usage_limit", null, usage.fingerprint, false]);
        track.setupError = { code: "usage_limit", note: usage.raw };
        this.publishStatus(track, { type: "status", memberId: member.id, status: "blocked", blockedReason: "usage_limit", usageLimit: usage,
          observation: { source: "core", observedAt: track.observedAt, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: track.setupError } });
        return { ok: false, reason: "blocked", retryable: true, deliveryEffect: "not_written", detail: "사용 한도 메뉴는 확인 후 Esc로만 닫을 수 있습니다" };
      }
      // Never erase a person's draft or deliver through an unidentified dialog.
      // An empty composer never establishes readiness; only the OSC gate above can permit input.
      const draft = providerFor(member) === "claude" ? inputText(screen.text) : codexDraft(screen.text);
      track.composerEmpty = draft === "";
      if (draft !== "") return { ok: false, reason: "input_busy", retryable: false, deliveryEffect: "not_written", detail: draft === null ? "Cannot identify an empty CLI composer" : "A user draft is present; IAMCEO leaves it untouched" };
      const preference = this.parallelPreferences.get(member.id) ?? member.parallel;
      const prefix = providerFor(member) === "codex" && preference !== undefined
        ? (preference ? "IAMCEO execution preference: Use native subagents for independent work in parallel when useful; retain your normal approvals and tool access.\n\n" : "IAMCEO execution preference: Work sequentially for this task; do not spawn subagents.\n\n") : "";
      const binding = providerFor(member) === "codex" && !track.sessionId && track.nonce ? codexBindingMarker(track.nonce) + "\n\n" : "";
      const cleaned = cleanText(binding + prefix + text);
      if (!cleaned.trim()) return unsupported("Message is empty");
      // Core generation 1 only permits if:idle|working. A done/error report has
      // no exact conditional; force:false still refuses any approval dialog.
      // IAMCEO manual controls use a lease; direct external attach cannot be
      // made atomic with this guard by the current core API.
      if (this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written", detail: "Manual terminal control is active" };
      const current = await this.refresh(track);
      this.validateTrack(track);
      if (current.state !== "live" || this.stateOf(track, current) !== state || track.epoch !== inputEpoch) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      track.pending = true; this.bump(track);
      deliveryAttempted = true;
      const result = await this.call<{ turn: number; started?: boolean | null }>("terminal.send", { terminal: terminal.address, text: cleaned, ...(state === "idle" ? { if: "idle" } : {}), force: false, wait: false }, this.sendTimeoutMs);
      if (!Number.isSafeInteger(result.turn)) throw new CoreError("protocol", "Send reply has no valid turn counter", true);
      this.hookShadow?.sent(member.id, providerFor(member), { sessionId: track.sessionId, text: cleaned });
      // started:false still means paste+Enter was delivered. Never resend it.
      await this.refresh(track).catch(() => undefined);
      return { ok: true, started: result.started ?? null, turn: result.turn };
    } catch (error) {
      if (track && deliveryAttempted && (!(error instanceof CoreError) || error.uncertain)) { track.pending = false; track.uncertain = true; track.controlUncertain ||= !opts.marker; return { ...unsupported(`Delivery may have occurred; do not resend automatically. ${error instanceof Error ? error.message : String(error)}`), deliveryEffect: "unknown" }; }
      if (track && deliveryAttempted) track.pending = false;
      if (error instanceof CoreError && ["blocked", "status_mismatch", "busy"].includes(error.kind)) return { ok: false, reason: error.kind === "blocked" ? "blocked" : "busy", retryable: true, detail: error.message, deliveryEffect: deliveryAttempted ? "rejected" : "not_written" };
      return { ok: false, reason: error instanceof CoreError && error.deliveryEffect === "not_written" ? "down" : "error", retryable: error instanceof CoreError && error.deliveryEffect === "not_written", deliveryEffect: !deliveryAttempted ? "not_written" : error instanceof CoreError ? error.deliveryEffect : "unknown", detail: error instanceof Error ? error.message : String(error) };
    } finally { this.sending.delete(member.id); }
  }

  /** False only when the provider's own store holds no record of this session; an unreadable store is not proof. */
  sessionExists(member: RunnerMember): boolean {
    if (!member.sessionId) return false;
    const home = this.providerHome(member);
    if (providerFor(member) === "claude") {
      if (existsSync(transcriptPath(member.cwd, member.sessionId, home))) return true;
      // A session that changed directory is recorded under another project folder. Only a missing store is absence.
      const projects = join(home, "projects");
      try { return readdirSync(projects).some(dir => existsSync(join(projects, dir, `${member.sessionId}.jsonl`))); }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    }
    try {
      for (const _ of new Bun.Glob(`**/rollout-*-${member.sessionId}.jsonl`).scanSync({ cwd: join(home, "sessions"), onlyFiles: true, followSymlinks: false })) return true;
      return false;
    } catch { return true; }
  }
  private providerHome(member: RunnerMember): string {
    return providerFor(member) === "claude" ? this.options.claudeHome ?? defaultClaudeHome() : this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  }
  private discoverBinding(track: Track): void {
    if (providerFor(track.member) !== "codex" || track.sessionId || !track.nonce || track.member.sessionGeneration === undefined) return;
    const result = discoverCodexSession({ home: this.providerHome(track.member), cwd: track.member.cwd, generation: track.member.sessionGeneration, nonce: track.nonce, since: track.bindingSince, cursor: track.binding });
    track.binding = result.cursor;
    if (result.outcome === "bound" && result.sessionId) {
      track.sessionId = result.sessionId;
      this.event(track, { type: "session", memberId: track.member.id, sessionId: result.sessionId });
    }
  }
  private logPath(track: Track): string | null {
    if (!track.sessionId) return null;
    const home = this.providerHome(track.member);
    if (providerFor(track.member) === "claude") return findSessionFile(home, track.member.cwd, track.sessionId);
    if (track.binding) {
      const matches = track.binding.files.filter((file) => file.matched && !file.invalid && file.meta?.sessionId === track.sessionId);
      if (matches.length === 1) return matches[0].path;
    }
    // Asked on every send, inspection and turn end: remember the file once found.
    if (track.logFile?.sessionId === track.sessionId && existsSync(track.logFile.path)) return track.logFile.path;
    try {
      const matches = [...new Bun.Glob(`**/rollout-*-${track.sessionId}.jsonl`).scanSync({ cwd: join(home, "sessions"), absolute: true, onlyFiles: true, followSymlinks: false })].filter((path) => {
        const meta = parseCodexSessionMeta(readJsonlRange(join(home, "sessions"), path, null, { maxBytes: 1024 * 1024 }).records[0]?.value);
        return meta?.sessionId === track.sessionId && meta.cwd === track.member.cwd;
      });
      if (matches.length !== 1) return null;
      track.logFile = { sessionId: track.sessionId, path: matches[0] };
      return matches[0];
    } catch { return null; }
  }
  /** Captured just before an envelope is written. Empty when the log is not known yet or ends in a partial line. */
  deliveryBaseline(member: RunnerMember): DeliveryLogBaseline[] {
    const track = this.tracks.get(member.id);
    if (!track || !track.sessionId) return [];
    try {
      const path = this.logPath(track);
      const baseline = path ? eofLogBaseline(join(this.providerHome(member), providerFor(member) === "claude" ? "projects" : "sessions"), path) : null;
      return baseline ? [baseline] : [];
    } catch { return []; }
  }
  async inspectDelivery(member: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection> {
    const release = this.reserve(member.id);
    try { return await this.inspectLocked(member, query); } finally { release(); }
  }
  /** Read-only. A live terminal or no answer is false: silence is never proof that a terminal is gone. */
  async terminalGone(terminalId: string): Promise<boolean> {
    try { return (await this.call<CoreTerminal>("terminal.get", { terminal: terminalId }, Math.min(this.rpcTimeoutMs, 2000))).state !== "live"; }
    catch (error) { return error instanceof CoreError && error.kind === "not_found" && !error.uncertain; }
  }
  /** Session log of a session that has no attached terminal. Null when it cannot be told apart. */
  private sessionLogPath(member: RunnerMember, sessionId: string): string | null {
    const home = this.providerHome(member);
    try {
      if (providerFor(member) === "claude") return findSessionFile(home, member.cwd, sessionId);
      const matches = [...new Bun.Glob(`**/rollout-*-${sessionId}.jsonl`).scanSync({ cwd: join(home, "sessions"), absolute: true, onlyFiles: true, followSymlinks: false })].filter((path) => {
        const meta = parseCodexSessionMeta(readJsonlRange(join(home, "sessions"), path, null, { maxBytes: 1024 * 1024 }).records[0]?.value);
        return meta?.sessionId === sessionId && meta.cwd === member.cwd;
      });
      return matches.length === 1 ? matches[0]! : null;
    } catch { return null; }
  }
  private readonly goneEvidence = new Map<string, DeliveryEvidenceCursor>();
  /**
   * The envelope's terminal is confirmed gone (the caller's precondition): a half-typed draft in its composer can
   * never be submitted, and its screen and turn counter no longer exist. Only the session log is left to ask.
   * received: every marker is a submitted user message. not_received: the whole range since the send was read and
   * holds none of them. Anything else (no log, a partial or unrecognized record, some markers only) is unknown.
   */
  inspectGoneDelivery(member: RunnerMember, query: DeliveryProbe): DeliveryInspection {
    const source = providerFor(member) === "claude" ? "claude_log" as const : "codex_log" as const;
    const unknown = (code: string): DeliveryInspection => ({ evidence: [{ source, verdict: "unknown", location: "none", code, complete: false, checkedAt: new Date().toISOString() }], finding: "unknown", receivedDeliveryIds: [], snapshot: null, quiescence: "unresolved" });
    const sessionId = query.identity.sessionId;
    if (query.cli !== providerFor(member) || query.backend !== "core" || !sessionId || sessionId !== member.sessionId || query.identity.sessionGeneration !== member.sessionGeneration) return unknown("identity_changed");
    const path = this.sessionLogPath(member, sessionId);
    if (!path) return unknown("file_missing");
    const baseline = query.baseline.logs.find((log) => log.path === path);
    const scan = () => readDeliveryEvidence({ cli: providerFor(member), home: this.providerHome(member), path, cwd: member.cwd, sessionId,
      sessionGeneration: query.identity.sessionGeneration, markers: query.markers, bundleMarker: query.bundleMarker, baseline,
      since: baseline ? undefined : query.baseline.capturedAt, cursor: this.goneEvidence.get(query.dispatchId) });
    let read = scan();
    if (read.evidence.code === "generation_changed" && this.goneEvidence.delete(query.dispatchId)) read = scan();
    // An envelope without a log baseline is read from the start, 4 MiB a piece. Bounded here; the next check continues.
    for (let pieces = 1; read.evidence.code === "scan_pending" && pieces < 8; pieces++) {
      if (read.cursor) this.goneEvidence.set(query.dispatchId, read.cursor);
      read = scan();
    }
    if (read.evidence.code === "scan_pending" && read.cursor) this.goneEvidence.set(query.dispatchId, read.cursor);
    else this.goneEvidence.delete(query.dispatchId);
    const allReceived = query.markers.length > 0 && query.markers.every((marker) => read.receivedDeliveryIds.includes(marker.deliveryId));
    const absent = read.evidence.complete && read.evidence.verdict === "absent" && !read.receivedDeliveryIds.length;
    return { evidence: [read.evidence], finding: allReceived ? "received" : absent ? "not_received" : "unknown", receivedDeliveryIds: read.receivedDeliveryIds, snapshot: null, quiescence: "settled" };
  }
  private async inspectLocked(member: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection> {
    const unknown = (code: string, finding: "unknown" | "wait" = "unknown"): DeliveryInspection => ({ evidence: [{ source: "transport", verdict: "unknown", location: "none", code, complete: false, checkedAt: new Date().toISOString() }], finding, receivedDeliveryIds: [], snapshot: null, quiescence: "unresolved" });
    const track = this.tracks.get(member.id);
    if (!track) return unknown("not_attached");
    this.assertMember(track, member);
    if (this.manualLease(member.id)) return unknown("manual_control", "wait"); // No provider record scan under lease.
    const terminal = await this.refresh(track);
    if (query.cli !== providerFor(member) || query.backend !== "core" || (!this.sameIdentity(query.identity, this.identity(track)) && (!query.identity.sessionId || query.identity.sessionId !== track.sessionId))) return unknown("identity_changed");
    const stored = this.deps.recoveryStore?.inputState(member.id).unresolvedDispatches ?? track.dispatches;
    const settledBefore = this.deps.recoveryStore?.getDispatch?.(query.dispatchId);
    const dispatch = stored.find((item) => item.dispatchId === query.dispatchId && item.wireSha256 === query.wireSha256) ??
      (settledBefore && settledBefore.memberId === member.id && settledBefore.wireSha256 === query.wireSha256 ? settledBefore : undefined);
    const barrier = dispatch && this.deps.quiescence?.(member.id, dispatch);
    const originalWrite = barrier?.originalWrite ?? (dispatch?.transportState === "accepted" ? "settled" : dispatch?.transportState === "rejected" ? "rejected" : "unresolved");
    const externalInput = barrier?.externalInput ?? null;
    const inputEpoch = track.epoch;
    const screen = (await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 })).text;
    this.validateTrack(track);
    if (track.epoch !== inputEpoch) return unknown("input_epoch_changed");
    const draft = providerFor(member) === "claude" ? inputText(screen) : codexDraft(screen);
    const composer = draft === null ? "unknown" : draft === "" ? "empty" : dispatch && exactComposer(screen, providerFor(member)) === dispatch.wireText ? "matches" : "different";
    const state = this.stateOf(track, terminal);
    const status = terminal.state !== "live" ? "gone" : ["idle", "done", "working", "blocked"].includes(state || "") ? state as "idle" | "done" | "working" | "blocked" : "unknown";
    const snapshot: NonNullable<DeliveryInspection["snapshot"]> = { identity: this.identity(track), observedAt: track.observedAt, turn: terminal.turn ?? null, inputEpoch: track.epoch, ownership: "verified", status,
      blockedReason: status === "blocked" ? terminal.status?.kind === "permission" ? "permission" : "status_unknown" : null,
      leaseActive: false, mutation: "none", composer, originalWrite, externalInput };
    const path = this.logPath(track);
    if (!path || !track.sessionId) return { ...unknown("session_unbound"), snapshot };
    const baseline = query.baseline.logs.find((log) => log.path === path);
    const scan = () => readDeliveryEvidence({ cli: providerFor(member), home: this.providerHome(member), path, cwd: member.cwd, sessionId: track.sessionId!,
      sessionGeneration: query.identity.sessionGeneration, markers: query.markers, bundleMarker: query.bundleMarker, baseline,
      since: baseline ? undefined : query.baseline.capturedAt, cursor: track.evidence.get(query.dispatchId) });
    let read = scan();
    // The cursor belongs to one exact question. A check that asks about fewer items of the envelope (they fall due
    // apart) is another question: without a fresh read every later check stayed generation_changed.
    if (read.evidence.code === "generation_changed" && track.evidence.delete(query.dispatchId)) read = scan();
    if (read.cursor) track.evidence.set(query.dispatchId, read.cursor);
    // An envelope without a log baseline (written by an older build) is read from the start. Keep reading in this
    // inspection, yielding between 4 MiB pieces, instead of one piece per 30 s check.
    for (let pieces = 1, started = Date.now(); read.evidence.code === "scan_pending" && pieces < 16 && Date.now() - started < (this.deps.evidenceScanMs ?? 250); pieces++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (this.closed || this.tracks.get(member.id) !== track || track.epoch !== inputEpoch || this.manualLease(member.id)) break;
      read = scan();
      if (read.cursor) track.evidence.set(query.dispatchId, read.cursor);
    }
    const settled = originalWrite !== "unresolved";
    const allReceived = query.markers.length > 0 && query.markers.every((marker) => read.receivedDeliveryIds.includes(marker.deliveryId));
    const completeAbsence = read.evidence.complete && read.evidence.verdict === "absent";
    // A write that ended without a receipt was not received when the whole log range since the send holds no record
    // of it, the composer is empty and the CLI's turn counter has not moved since the send. It used to stay unknown
    // forever (real restarts mid-send), fencing the member's whole queue until the member was removed.
    const untouched = query.baseline.turn !== null && (terminal.turn ?? null) === query.baseline.turn;
    const absentWrite = ["not_written", "rejected"].includes(originalWrite) || originalWrite === "settled" && barrier?.unconfirmed === true && untouched;
    const finding = allReceived ? "received" : ["working", "blocked"].includes(status) ? "wait" : completeAbsence && settled && externalInput === false && composer === "matches" ? "draft_only" : completeAbsence && absentWrite && externalInput === false && composer === "empty" ? "not_received" : "unknown";
    return { evidence: [read.evidence, { source: "core_screen", verdict: composer === "unknown" ? "unknown" : "present", location: "composer", code: composer, complete: composer !== "unknown", checkedAt: new Date().toISOString() }], finding, receivedDeliveryIds: read.receivedDeliveryIds, snapshot, quiescence: settled ? "settled" : "unresolved" };
  }
  async repairDelivery(member: RunnerMember, request: DeliveryRepair): Promise<SendResult> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" }; }
    let attempted = false;
    const track = this.tracks.get(member.id);
    try {
      if (track?.compact && !["failed", "succeeded"].includes(track.compact.phase)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      if (!track || !this.deps.repair) return { ...unsupported("A durable delivery repair port and attached terminal are required"), deliveryEffect: "not_written" };
      const dispatch = this.deps.repair.load(member.id, request);
      if (!dispatch || dispatch.memberId !== member.id || dispatch.projectId !== member.projectId || dispatch.dispatchId !== request.dispatchId || createHash("sha256").update(dispatch.wireText).digest("hex") !== dispatch.wireSha256 || cleanText(dispatch.wireText) !== dispatch.wireText) return { ...unsupported("Stored delivery or reviewed recovery version changed"), deliveryEffect: "not_written" };
      const inspected = await this.inspectLocked(member, dispatch);
      const snapshot = inspected.snapshot;
      if (!snapshot || request.expectedSessionGeneration !== snapshot.identity.sessionGeneration || request.expectedSessionId !== snapshot.identity.sessionId || request.expectedTerminalId !== snapshot.identity.terminalId || request.expectedInputEpoch !== snapshot.inputEpoch || snapshot.externalInput !== false || snapshot.leaseActive || !["idle", "done"].includes(snapshot.status)) return { ok: false, reason: "input_busy", retryable: false, deliveryEffect: "not_written", detail: "Delivery identity, epoch or safe idle state changed" };
      if (inspected.receivedDeliveryIds.length) return { ...unsupported("User receipt already exists; reconcile delivery without input"), deliveryEffect: "not_written" };
      // The owner's explicit consent replaces the proof of absence, never the idle state or the empty composer.
      const consented = this.deps.quiescence?.(member.id, dispatch)?.riskApproved === true && inspected.finding === "unknown" && snapshot.composer === "empty";
      if (request.action === "resend" ? inspected.finding !== "not_received" && !consented : inspected.finding !== "draft_only" || !this.deps.submitKeyVerified || !this.methods.has("terminal.keys") || dispatch.submitAttempts !== 0) return { ...unsupported("No verified safe repair or submit-key barrier"), deliveryEffect: "not_written" };
      const final = await this.inspectLocked(member, dispatch);
      if (final.finding !== inspected.finding || final.receivedDeliveryIds.length || !final.snapshot || !["idle", "done"].includes(final.snapshot.status) || final.snapshot.inputEpoch !== request.expectedInputEpoch || this.manualLease(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      const latest = track.terminal;
      // This port revalidates recovery version, source revisions and cancellation,
      // then commits the one write attempt in the same synchronous transaction.
      if (!this.deps.repair.prepare(member.id, request, dispatch)) return { ...unsupported("Recovery version or source changed before repair"), deliveryEffect: "not_written" };
      this.validateTrack(track); this.bump(track); attempted = true; track.uncertain = true;
      if (request.action === "submit_only") {
        await this.call("terminal.keys", { terminal: latest.address, keys: ["enter"] }, this.sendTimeoutMs);
        return { ...unsupported("Submit key was sent once; await user-record evidence before further input"), deliveryEffect: "unknown" };
      }
      // Same rule as send(): after any turn the CLI reports done until its next input, and core has no conditional for it.
      const result = await this.call<{ turn: number; started?: boolean }>("terminal.send", { terminal: latest.address, text: dispatch.wireText, ...(final.snapshot.status === "idle" ? { if: "idle" } : {}), force: false, wait: false }, this.sendTimeoutMs);
      if (!Number.isSafeInteger(result.turn)) throw new CoreError("protocol", "Invalid repair send receipt", true);
      this.hookShadow?.sent(member.id, providerFor(member), { sessionId: track.sessionId, text: dispatch.wireText });
      track.pending = true;
      // The previous write was proved absent and this exact resend has a verified receipt.
      track.dispatches = track.dispatches.filter(item => item.dispatchId !== dispatch.dispatchId);
      track.controlUncertain = false; track.uncertain = track.dispatches.length > 0;
      return { ok: true, turn: result.turn, started: result.started ?? null, receipt: { dispatchId: dispatch.dispatchId, receivedAt: new Date().toISOString(), source: "transport" } };
    } catch (error) {
      if (track && attempted) track.uncertain = true;
      return { ok: false, reason: "error", retryable: false, deliveryEffect: !attempted ? "not_written" : error instanceof CoreError ? error.deliveryEffect : "unknown", detail: error instanceof Error ? error.message : String(error) };
    } finally { release(); }
  }
  private saveCompact(track: Track, state: CoreCompactState): void {
    if (!this.deps.compactStore) throw new CoreError("unsupported", "Durable compact state port is required");
    this.deps.compactStore.save(track.member.id, state); track.compact = state;
  }
  async compact(member: RunnerMember, focus: string, _opts: StartOpts): Promise<SendResult> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" }; }
    let attempted = false;
    const track = this.tracks.get(member.id);
    try {
      if (!track || !track.sessionId || member.sessionGeneration === undefined || !this.deps.compactStore) return { ...unsupported("Compact requires an attached native session, generation and durable state port"), deliveryEffect: "not_written" };
      this.assertMember(track, member);
      if (this.manualLease(member.id) || this.isBusy(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      const terminal = await this.refresh(track);
      // After any turn core reports "done" until the next input, so "idle only" meant a compact requested after the
      // first turn never ran and fenced the member's queue forever (real 2026-11-07 run). Use the same rule as a
      // normal delivery: idle is sent with the core-side if:"idle" guard, done after the same client-side checks.
      if (terminal.state !== "live" || !["idle", "done"].includes(this.stateOf(track, terminal) || "")) return { ok: false, reason: "blocked", retryable: true, deliveryEffect: "not_written", detail: "Compact requires an idle or finished CLI" };
      const epoch = track.epoch;
      const screen = await this.screen(member);
      if ((providerFor(member) === "claude" ? inputText(screen) : codexDraft(screen)) !== "") return { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written" };
      const path = this.logPath(track), home = this.providerHome(member);
      if (!path) return { ...unsupported("Native session log is unavailable"), deliveryEffect: "not_written" };
      const root = join(home, providerFor(member) === "claude" ? "projects" : "sessions");
      const baseline = compactLogBaseline(root, path);
      if (!baseline) return { ...unsupported("Compact log baseline is incomplete"), deliveryEffect: "not_written" };
      const current = await this.refresh(track);
      const currentState = this.stateOf(track, current);
      if (current.state !== "live" || !["idle", "done"].includes(currentState || "") || track.epoch !== epoch || this.manualLease(member.id) || !readJsonlRange(root, path, baseline, { maxBytes: 0 }).complete) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      // The read above may have been shared with the poller and so outlived this attempt's deadline. Once the caller
      // gave up (stage limit) nothing is persisted or written: it has already recorded this attempt as not started.
      this.validateTrack(track);
      this.saveCompact(track, { id: crypto.randomUUID(), phase: "sending", startedAt: Date.now(), cursor: null, baseline: { path, fileIdentity: baseline.fileIdentity, offset: baseline.offset,
        sessionId: track.sessionId, terminalId: current.address, generation: member.sessionGeneration, turn: current.turn ?? null, model: member.model } });
      this.bump(track); track.pending = true; attempted = true;
      const command = providerFor(member) === "codex" ? "/compact" : `/compact ${cleanText(focus).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim()}`.trim();
      const result = await this.call<{ turn: number; started?: boolean }>("terminal.send", { terminal: current.address, text: command, ...(currentState === "idle" ? { if: "idle" } : {}), force: false, wait: false }, this.sendTimeoutMs);
      if (!Number.isSafeInteger(result.turn)) throw new CoreError("protocol", "Invalid compact receipt", true);
      this.saveCompact(track, { ...track.compact!, phase: "running" });
      return { ok: true, started: result.started ?? null, turn: result.turn };
    } catch (error) {
      if (track?.compact && attempted) {
        const uncertain = !(error instanceof CoreError) || error.uncertain;
        track.uncertain ||= uncertain;
        if (!uncertain) track.pending = false;
        const next: CoreCompactState = { ...track.compact, phase: uncertain ? "uncertain" : "failed" };
        track.compact = next; // Preserve in-memory fence even when persistence fails after input.
        try { this.saveCompact(track, next); } catch { track.uncertain = true; track.controlUncertain = true; }
      }
      return { ok: false, reason: "error", retryable: false, deliveryEffect: !attempted ? "not_written" : error instanceof CoreError ? error.deliveryEffect : "unknown", detail: error instanceof Error ? error.message : String(error) };
    } finally { release(); }
  }
  private async checkCompact(track: Track): Promise<void> {
    let operation = track.compact!;
    const state = track.terminal.status?.state;
    const resolution = operation.manualResolution;
    if (operation.phase === "uncertain" && resolution && track.terminal.state === "live") {
      if (["working", "blocked"].includes(state || "") && !resolution.unsettled) {
        this.saveCompact(track, { ...operation, manualResolution: { ...resolution, unsettled: true } });
        operation = track.compact!;
      }
      if (["idle", "done"].includes(state || "") && (resolution.unsettled || resolution.turn !== null && (track.terminal.turn ?? -1) > resolution.turn)) {
        this.saveCompact(track, { ...operation, phase: "failed", reason: "user_resolved" });
        track.pending = false; track.controlUncertain = false; track.uncertain = track.dispatches.length > 0;
        this.event(track, { type: "activity", memberId: track.member.id, kind: "system", text: "사용자 확인으로 압축 대기를 해제했습니다", runId: operation.id });
        return;
      }
    }
    if (this.manualLease(track.member.id) || operation.phase === "sending") return;
    const result = observeCompactBoundary({ cli: providerFor(track.member), home: this.providerHome(track.member), cwd: track.member.cwd, baseline: operation.baseline,
      current: { sessionId: track.sessionId!, generation: track.member.sessionGeneration ?? -1, terminalId: track.terminal.address, turn: track.terminal.turn ?? null, model: track.member.model },
      settled: track.terminal.state === "live" && ["idle", "done"].includes(state || ""), providerError: state === "error", cursor: operation.cursor });
    if (result.outcome === "succeeded") {
      this.saveCompact(track, { ...operation, cursor: result.cursor, phase: "succeeded" });
      track.pending = false; track.controlUncertain = false; track.uncertain = track.dispatches.length > 0; track.endedTurn = Math.max(track.endedTurn, track.terminal.turn ?? 0);
      this.event(track, { type: "compacted", memberId: track.member.id, runId: operation.id });
      // Post-compact usage is collected by the next fresh provider sample; never emit 0%.
    } else if (state === "error") {
      this.saveCompact(track, { ...operation, cursor: result.cursor, phase: "failed" });
      track.pending = false; track.controlUncertain = false; track.uncertain = track.dispatches.length > 0;
      track.lastError = track.terminal.status?.msg || "CLI reported a compact error";
      this.event(track, { type: "activity", memberId: track.member.id, kind: "error", text: "CLI reported that context compaction failed", runId: operation.id });
    } else if (Date.now() - operation.startedAt >= (this.deps.compactTimeoutMs ?? 600_000) || result.outcome === "unknown") {
      this.saveCompact(track, { ...operation, cursor: result.cursor, phase: "uncertain" }); track.uncertain = true;
    } else operation.cursor = result.cursor;
  }
  async setParallel(member: RunnerMember, on: boolean, opts: StartOpts): Promise<SendResult> {
    if (providerFor(member) === "codex") {
      // Codex has native subagents, not Claude's Ultracode switch. Its capability
      // stays enabled; this preference is added explicitly to each next task.
      this.parallelPreferences.set(member.id, on);
      return { ok: true };
    }
    const command = `/effort ultracode ${on ? "on" : "off"}`;
    const sent = await this.send(member, command, opts);
    if (!sent.ok) return sent;
    const deadline = Date.now() + 5000;
    const word = on ? "on" : "off";
    while (Date.now() < deadline && !this.closed) {
      this.operation.getStore()?.signal.throwIfAborted();
      const screen = await this.screen(member).catch(() => "");
      const index = screen.lastIndexOf(command);
      if (index >= 0 && screen.slice(index + command.length).split("\n").some((line) => new RegExp(`^\\W*ultracode ${word}\\b`, "i").test(line))) {
        const track = this.tracks.get(member.id);
        if (track) track.pending = false;
        return { ok: true };
      }
      await Bun.sleep(150);
    }
    return { ...unsupported(`The command was delivered, but Ultracode ${word} was not confirmed; inspect the terminal before retrying`), deliveryEffect: "unknown" };
  }
  async applyConfig(member: RunnerMember, opts: StartOpts): Promise<SendResult> {
    const track = this.tracks.get(member.id);
    if (!track) return { ok: false, reason: "gone", retryable: false };
    if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, detail: "Manual terminal control is active" };
    if (this.isBusy(member.id) || this.sending.has(member.id) || this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true };
    const sessionId = track.sessionId || member.sessionId;
    if (!sessionId) return unsupported("Native Codex session id is unknown; use the CLI /model menu or explicitly start a fresh session");
    const release = this.reserve(member.id);
    this.configuring.add(member.id);
    try {
      const terminal = await this.refresh(track);
      if (!["idle", "done"].includes(this.stateOf(track, terminal) || "")) return { ok: false, reason: "blocked", retryable: true };
      const screen = await this.screen(member);
      const draft = providerFor(member) === "claude" ? inputText(screen) : codexDraft(screen);
      if (draft !== "") return { ok: false, reason: "input_busy", retryable: false, detail: "Configuration reload requires an identifiable empty composer; the user draft is preserved" };
      const resumed = { ...member, sessionId, paneId: null };
      providerLaunch(resumed, { ...opts, resume: true }, this.options); // Validate before stopping.
      await this.stopLocked(member, { whileWorking: false });
      await this.startLocked(resumed, { ...opts, resume: true });
      return { ok: true };
    } catch (error) { return unsupported(error instanceof Error ? error.message : String(error)); }
    finally { this.configuring.delete(member.id); release(); }
  }
  private async owned(member: RunnerMember): Promise<CoreTerminal> {
    const track = this.tracks.get(member.id);
    if (track) { this.assertMember(track, member); return this.refresh(track); }
    const address = this.tracks.get(member.id)?.terminal.address || member.paneId;
    if (!address) throw new CoreError("not_found", "No core terminal for member", false, "rejected", undefined, "core_terminal_missing");
    const terminal = await this.call<CoreTerminal>("terminal.get", { terminal: address });
    if (!this.owns(terminal, member)) throw new CoreError("conflict", "Refusing to control a core terminal without matching IAMCEO ownership labels");
    return terminal;
  }
  async interrupt(member: RunnerMember): Promise<void> {
    const release = this.reserve(member.id);
    try {
      const terminal = await this.owned(member);
      const track = this.tracks.get(member.id);
      if (track) this.bump(track);
      const result = await this.call<{ outcome: string }>("terminal.interrupt", { terminal: terminal.address, timeout: 3 }, 6000);
      if (!["stopped", "exited"].includes(result.outcome)) throw new CoreError("not_stopped", `CLI interrupt outcome: ${result.outcome}`);
      if (track?.compact) { this.saveCompact(track, { ...track.compact, phase: "failed" }); track.pending = false; track.controlUncertain = false; track.uncertain = track.dispatches.length > 0; }
    } finally { release(); }
  }
  async checkStop(member: RunnerMember, opts: { whileWorking?: boolean } = {}): Promise<void> {
    if (member.origin === "adopted") throw new CoreError("unsupported", "Cannot close an adopted user terminal");
    if (this.manualLease(member.id)) throw new CoreError("input_busy", "Manual terminal control lease is active");
    const track = this.tracks.get(member.id);
    if (!opts.whileWorking && track && this.isBusy(member.id)) throw new CoreError("busy", "A turn or unresolved input is still active");
    let terminal: CoreTerminal;
    try { terminal = await this.owned(member); }
    catch (error) {
      // A terminal confirmed absent has nothing left to close: stop() treats the same error as success.
      if (error instanceof CoreError && error.kind === "not_found" && !error.uncertain) return;
      throw error;
    }
    if (terminal.state !== "live") return;
    const quiet = this.quietForStop(track, terminal);
    if (!opts.whileWorking && !quiet) throw new CoreError("busy", "Resolve the current CLI turn/dialog before changing its provider or configuration");
    if (quiet) {
      const screen = await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 });
      const draft = providerFor(member) === "claude" ? inputText(screen.text) : codexDraft(screen.text);
      // 닫기·강제 재우기(whileWorking)는 마지막 탈출구다. 오류로 끝난 CLI 는 예전에 초안 확인 없이 끝냈다: 오류 배너가 입력칸을 가려
      // 알아보지 못하는(null) 화면은 막지 않는다. 쓰던 글이 보이면 지금처럼 지킨다.
      const unreadableAfterError = draft === null && !!opts.whileWorking && this.stateOf(track, terminal) === "error";
      if (draft !== "" && !unreadableAfterError) throw new CoreError("input_busy", "Cannot close a CLI with a user draft or unknown composer; the draft is preserved");
    }
  }
  /**
   * 일을 끊지 않고 끝낼 수 있는 CLI 인가: 쉬는 중(idle·done), 또는 오류 보고(error)로 끝난 턴의 끝을 이미 본 CLI.
   * 오류로 끝난 턴(API 오류·사용 한도)은 창이 아니라 입력을 기다리는 CLI 다. 예전에는 error 를 '처리 중'으로 읽어,
   * 사용 한도로 멈춘 팀장을 재우거나 설정을 바꿔 다시 열 수 없었다(2026-11-13 라이브). 초안 확인은 쉬는 CLI 와 같다.
   * 끝을 보지 못한 턴(턴 번호가 앞섰다)이나 이 서버가 지켜보지 않는 터미널의 error 는 지금처럼 막는다.
   */
  private quietForStop(track: Track | undefined, terminal: CoreTerminal): boolean {
    const state = this.stateOf(track, terminal);
    if (["idle", "done"].includes(state || "")) return true;
    return state === "error" && !!track && track.terminal.address === terminal.address && (terminal.turn ?? 0) <= track.endedTurn;
  }
  async stop(member: RunnerMember, opts: { whileWorking?: boolean } = {}): Promise<void> {
    const release = this.reserve(member.id);
    try { await this.stopLocked(member, { whileWorking: opts.whileWorking ?? true }); } finally { release(); }
  }
  private async stopLocked(member: RunnerMember, opts: { whileWorking?: boolean }): Promise<void> {
    let terminal: CoreTerminal;
    try { await this.checkStop(member, opts); terminal = await this.owned(member); }
    catch (error) {
      if (error instanceof CoreError && error.kind === "not_found") { this.detachStopped(member); return; }
      // No terminal.kill has been attempted during these ownership/draft reads.
      if (error instanceof CoreError) throw new CoreError(error.kind, error.message, false, "not_written", error.causeCode);
      throw error;
    }
    if (terminal.state === "live") {
      if (!opts.whileWorking && !this.quietForStop(this.tracks.get(member.id), terminal)) throw new CoreError("busy", "CLI state changed before stop");
      try {
        const result = await this.call<CoreTerminal>("terminal.kill", { terminal: terminal.address }, 15_000);
        if (result.state !== "finished") throw new CoreError("not_stopped", "Core did not confirm terminal termination");
      } catch (error) {
        if (!(error instanceof CoreError) || !error.uncertain) throw error;
        try { if ((await this.owned(member)).state !== "finished") throw error; }
        catch (inspection) {
          // A failed/cancelled verification read cannot turn an unknown kill
          // into a definite pre-write refusal. Retain the original write fence.
          if (!(inspection instanceof CoreError) || inspection.kind !== "not_found" || inspection.uncertain) throw error;
        }
      }
    }
    this.detachStopped(member);
  }
  private detachStopped(member: RunnerMember): void {
    const lease = this.leases.get(member.id);
    if (lease) this.deps.recoveryStore?.removeLease(member.id, lease.claimId);
    this.leases.delete(member.id); this.parallelPreferences.delete(member.id);
    const track = this.tracks.get(member.id);
    if (track && providerFor(member) === "codex" && !track.sessionId) this.lostCodex.set(member.id, member.sessionGeneration);
    this.tracks.delete(member.id);
    if (track) this.event(track, { type: "status", memberId: member.id, status: "gone" });
  }
  async screen(member: RunnerMember): Promise<string> {
    const terminal = await this.owned(member);
    return (await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 })).text;
  }
  async terminalInfo(member: RunnerMember): Promise<{ cols: number; rows: number }> {
    const terminal = await this.owned(member);
    if (terminal.address !== member.paneId) throw new CoreError("conflict", "터미널 연결이 바뀌었습니다");
    if (terminal.state !== "live") throw new CoreError("finished", "터미널이 끝났습니다");
    if (!Number.isInteger(terminal.cols) || !Number.isInteger(terminal.rows) || terminal.cols! < 1 || terminal.rows! < 1) {
      throw new CoreError("unsupported", "터미널 크기를 확인할 수 없습니다");
    }
    return { cols: terminal.cols!, rows: terminal.rows! };
  }
  terminalLease(memberId: string): TerminalLease | null { return this.manualLease(memberId); }
  renewLease(memberId: string, leaseId: string): number {
    const lease = this.manualLease(memberId);
    if (!lease || lease.leaseId !== leaseId) throw new CoreError("conflict", "조작권이 없습니다");
    const next = { ...lease, expiresAt: Date.now() + 5 * 60_000 };
    this.deps.recoveryStore?.saveLease(next);
    this.leases.set(memberId, next);
    return next.expiresAt;
  }
  async noteTerminalInput(memberId: string, write: () => void): Promise<void> {
    const track = this.tracks.get(memberId);
    if (!track) throw new CoreError("not_found", "Terminal is no longer tracked");
    const terminal = track.terminal;
    clearTimeout(this.inputRefreshes.get(track));
    this.inputRefreshes.delete(track);
    this.bump(track);
    const compact = this.disarmManualResolution(track);
    write(); // A successful local PTY write is the stream's acknowledgement.
    // Keep pre-write observations disarmed without putting them on the input chain.
    const previous = track.refresh;
    if (!previous) this.armManualResolution(track, compact, terminal);
    const armed = previous?.catch(() => undefined).then(() => {
      if (!this.closed && this.tracks.get(memberId) === track && this.inputRefreshes.get(track) === timer) this.armManualResolution(track, compact, terminal);
    }).catch(() => undefined);
    const timer = setTimeout(() => {
      void (async () => {
        await armed;
        if (this.closed || this.tracks.get(memberId) !== track || this.inputRefreshes.get(track) !== timer) return;
        await this.refresh(track);
      })().catch(() => undefined).finally(() => {
        if (this.inputRefreshes.get(track) === timer) this.inputRefreshes.delete(track);
      });
    }, 200);
    timer.unref();
    this.inputRefreshes.set(track, timer);
  }
  private disarmManualResolution(track: Track) {
    const compact = track.compact && ["running", "uncertain"].includes(track.compact.phase) ? track.compact : null;
    if (compact?.manualResolution) this.saveCompact(track, { ...compact, manualResolution: undefined });
    return compact;
  }
  private armManualResolution(track: Track, compact: Track["compact"], terminal: CoreTerminal): void {
    if (compact && track.compact?.id === compact.id && ["running", "uncertain"].includes(track.compact.phase)) this.saveCompact(track, { ...track.compact,
      manualResolution: { turn: terminal.turn ?? null, unsettled: ["working", "blocked"].includes(terminal.status?.state || "") } });
  }
  private async readSetup(track: Track): Promise<ReturnType<typeof claudeFolderTrust>> {
    if (track.terminal.state !== "live" || ["working", "idle", "done", "error"].includes(track.terminal.status?.state || "")) return null;
    const epoch = track.epoch;
    const screen = await this.call<{ text: string }>("terminal.read", { terminal: track.terminal.address, lines: 0 });
    this.validateTrack(track);
    return epoch === track.epoch ? (providerFor(track.member) === "claude" ? claudeFolderTrust : codexFolderTrust)(screen.text, track.member.cwd) : null;
  }
  async usageLimitSnapshot(member: RunnerMember): Promise<{ menu: ReturnType<typeof usageLimitMenu>; state: string | null }> {
    const track = this.tracks.get(member.id);
    if (!track) throw new CoreError("not_found", "No owned terminal");
    this.assertMember(track, member);
    await this.refresh(track);
    const identity = this.identity(track), epoch = track.epoch;
    const screen = await this.call<{ text: string }>("terminal.read", { terminal: track.terminal.address, lines: 0 });
    this.validateTrack(track);
    if (track.terminal.state !== "live" || epoch !== track.epoch || !this.sameIdentity(identity, this.identity(track))) throw new CoreError("conflict", "Terminal changed while reading usage menu");
    const state = track.terminal.status?.state ?? null;
    return { menu: state === "working" ? null : usageLimitMenu(screen.text), state };
  }
  async dismissUsageLimit(member: RunnerMember, fingerprint: string): Promise<{ ok: boolean; note?: string }> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, note: "입력 처리 중입니다" }; }
    try {
      const track = this.tracks.get(member.id);
      if (track) this.settleUncertain(track);
      if (!track || this.manualLease(member.id) || track.pending || track.uncertain || track.compact && !["failed", "succeeded"].includes(track.compact.phase) || !this.methods.has("terminal.keys")) return { ok: false, note: "창을 닫지 못했습니다" };
      this.assertMember(track, member);
      const snapshot = await this.usageLimitSnapshot(member);
      if (!snapshot.menu || snapshot.menu.fingerprint !== fingerprint) return { ok: false, note: "화면이 바뀌었습니다. 다시 눌러 주세요" };
      const identity = this.identity(track), epoch = track.epoch;
      await this.refresh(track);
      const final = await this.usageLimitSnapshot(member);
      if (!final.menu || final.menu.fingerprint !== fingerprint || track.epoch !== epoch || !this.sameIdentity(identity, this.identity(track)) || this.manualLease(member.id)) return { ok: false, note: "화면이 바뀌었습니다. 다시 눌러 주세요" };
      this.bump(track);
      // This path must never select a paid option, submit, or move the selection.
      await this.call("terminal.keys", { terminal: track.terminal.address, keys: ["esc"] }, this.sendTimeoutMs);
      const deadline = Date.now() + Math.min(Math.max(this.deps.usageLimitCloseTimeoutMs ?? 10_000, 1), 10_000);
      do {
        const after = await this.waitFor("usage_limit_close", () => this.usageLimitSnapshot(member), Math.max(deadline - Date.now(), 1));
        if (after.menu) return { ok: false, note: "창을 닫지 못했습니다" };
        if (after.state !== "blocked") return { ok: true };
        await Bun.sleep(Math.min(100, Math.max(deadline - Date.now(), 0)));
      } while (Date.now() < deadline);
      return { ok: false, note: "창을 닫지 못했습니다" };
    } catch { return { ok: false, note: "창을 닫지 못했습니다" }; }
    finally { release(); }
  }
  async approval(member: RunnerMember): Promise<ApprovalPrompt | null> {
    const track = this.tracks.get(member.id);
    if (!track) return null;
    this.assertMember(track, member);
    await this.refresh(track);
    const setup = await this.readSetup(track);
    return setup && setup.prompt.fingerprint !== track.setupAttempted ? setup.prompt : null;
  }
  async answerApproval(member: RunnerMember, fingerprint: string, option: number): Promise<import("./types.ts").ApprovalAnswer> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, reason: "input_busy" }; }
    const track = this.tracks.get(member.id);
    let attempted = false;
    try {
      if (!track) return { ok: false, reason: "gone" };
      this.assertMember(track, member);
      this.settleUncertain(track);
      if (this.manualLease(member.id) || track.uncertain || track.compact && !["failed", "succeeded"].includes(track.compact.phase)) return { ok: false, reason: "input_busy" };
      if (!this.methods.has("terminal.keys")) return { ok: false, reason: "unrecognized" };
      const identity = this.identity(track);
      const epoch = track.epoch;
      await this.refresh(track);
      if (track.terminal.state !== "live") return { ok: false, reason: "gone" };
      const setup = await this.readSetup(track);
      if (!setup) return { ok: false, reason: "unrecognized" };
      const current = setup.prompt;
      if (fingerprint !== current.fingerprint || track.setupAttempted === fingerprint) return { ok: false, reason: "changed", current };
      const chosen = current.options.find((item) => item.n === option);
      if (!chosen) return { ok: false, reason: "no_option", current };
      // Revalidate identity/status after the screen read. No input crosses a lease or epoch change.
      await this.refresh(track);
      this.validateTrack(track);
      if (this.manualLease(member.id) || track.epoch !== epoch || !this.sameIdentity(identity, this.identity(track))) return { ok: false, reason: "input_busy" };
      const final = await this.readSetup(track);
      if (!final || final.prompt.fingerprint !== fingerprint || track.epoch !== epoch) return { ok: false, reason: "changed", current: final?.prompt ?? null };
      const distance = option - 1 - final.selected;
      const keys = [...Array(Math.abs(distance)).fill(distance < 0 ? "up" : "down"), "enter"];
      // Fence before the single write, including ambiguous replies. Never replay a setup answer.
      track.setupAttempted = fingerprint; this.bump(track); attempted = true;
      await this.call("terminal.keys", { terminal: track.terminal.address, keys }, this.sendTimeoutMs);
      await this.refresh(track).catch(() => undefined); // Exit after 'No' is an observed exit, never a successful work turn.
      return { ok: true, prompt: current, chosen };
    } catch (error) {
      if (track && attempted && (!(error instanceof CoreError) || error.uncertain)) track.uncertain = track.controlUncertain = true;
      if (!attempted && error instanceof CoreError && error.kind === "not_found") return { ok: false, reason: "gone" };
      if (!attempted && error instanceof CoreError && error.kind === "conflict") return { ok: false, reason: "changed" };
      throw error;
    } finally { release(); }
  }
  private manualLease(memberId: string): TerminalLease | null {
    const lease = this.leases.get(memberId);
    if (lease && this.deps.recoveryStore) {
      const saved = this.deps.recoveryStore.inputState(memberId).lease;
      if (!saved || saved.leaseId !== lease.leaseId || !this.sameIdentity(saved.identity, lease.identity)) {
        this.deps.recoveryStore.removeLease(memberId, lease.claimId);
        this.leases.delete(memberId);
        return null;
      }
      if (saved.expiresAt > Date.now()) { this.leases.set(memberId, saved); return saved; }
    }
    if (lease && lease.expiresAt > Date.now()) return lease;
    if (lease) this.deps.recoveryStore?.removeLease(memberId, lease.claimId);
    this.leases.delete(memberId);
    return null;
  }
  async terminalControl(member: RunnerMember, action: TerminalControlAction): Promise<TerminalControlResult> {
    const release = this.reserve(member.id);
    try {
      const lease = this.manualLease(member.id);
      // Revoking our own lease is local: terminal.get may already be not_found.
      if (action.action === "release") {
        const track = this.tracks.get(member.id);
        if (track) this.assertMember(track, member);
        if (!lease || action.leaseId !== lease.leaseId || lease.identity.sessionGeneration !== (member.sessionGeneration ?? -1) ||
            lease.identity.terminalId !== (member.paneId ?? track?.terminal.address)) throw new CoreError("conflict", "A matching active terminal control lease is required", false, "rejected", undefined, "core_lease_required");
        this.deps.recoveryStore?.removeLease(member.id, lease.claimId); this.leases.delete(member.id);
        if (track) this.bump(track);
        return {};
      }
      const terminal = await this.owned(member);
      const track = this.tracks.get(member.id);
      if (!track) throw new CoreError("not_found", "Reattach the owned terminal before claiming control");
      if (action.action === "claim") {
        if (lease && action.leaseId !== lease.leaseId && action.leaseId !== lease.claimId) throw new CoreError("conflict", "Another terminal control lease is active", false, "rejected", undefined, "core_lease_other");
        // Expired rows can also survive a restart, when there is no cached
        // lease left for manualLease to remove. Only clear this claim's row
        // after the store confirms there is no live holder.
        if (!lease && action.leaseId && this.deps.recoveryStore && !this.deps.recoveryStore.inputState(member.id).lease) {
          this.deps.recoveryStore.removeLease(member.id, action.leaseId);
        }
        const claimId = lease?.claimId || action.leaseId || crypto.randomUUID();
        // A claim is retry-stable; each new acquisition has a distinct incarnation.
        const next: TerminalLease = { memberId: member.id, claimId, leaseId: lease?.leaseId || crypto.randomUUID(), identity: this.identity(track), expiresAt: Date.now() + 5 * 60_000, lastInputSequence: lease?.lastInputSequence ?? 0 };
        this.deps.recoveryStore?.saveLease(next); this.leases.set(member.id, next); this.bump(track);
        return { leaseId: next.leaseId, expiresAt: next.expiresAt };
      }
      if (!lease || action.leaseId !== lease.leaseId) throw new CoreError("conflict", "A matching active terminal control lease is required", false, "rejected", undefined, "core_lease_required");
      if (terminal.state !== "live") throw new CoreError("finished", "Terminal has finished", false, "rejected", undefined, "core_terminal_finished");
      if (action.action === "input" && (!action.text?.length || Buffer.byteLength(action.text) > 128 * 1024)) throw new CoreError("invalid_params", "Terminal input must contain 1–131072 bytes");
      if (action.action === "key" && !this.methods.has("terminal.keys")) throw new CoreError("unsupported", "Core does not support terminal.keys");
      if (action.action === "key" && (!action.key || !["enter", "up", "down", "esc", "tab", "ctrl+c", "backspace"].includes(action.key))) throw new CoreError("invalid_params", "Unsupported terminal control key");
      const next = { ...lease, expiresAt: Date.now() + 5 * 60_000, lastInputSequence: lease.lastInputSequence + 1 };
      this.deps.recoveryStore?.saveLease(next); this.leases.set(member.id, next); this.bump(track);
      const compact = this.disarmManualResolution(track);
      try {
        if (action.action === "input") await this.call("terminal.send", { terminal: terminal.address, text: cleanText(action.text!), force: true, wait: false }, this.sendTimeoutMs);
        else await this.call("terminal.keys", { terminal: terminal.address, keys: [action.key] }, this.sendTimeoutMs);
      } catch (error) {
        if (!(error instanceof CoreError) || error.uncertain) track.uncertain = track.controlUncertain = true;
        throw error;
      }
      // Drain any observation started before the ACK while resolution remains
      // disarmed. Only a newly requested observation may prove settled input.
      await track.refresh?.catch(() => undefined);
      this.validateTrack(track);
      this.armManualResolution(track, compact, terminal);
      // Re-observe after the ACK. Claim/release, elapsed time and unchanged idle
      // cannot prove that a human intervention settled this compact operation.
      await this.refresh(track).catch(() => undefined);
      return { leaseId: next.leaseId, expiresAt: next.expiresAt };
    } finally { release(); }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.configuring.clear();
    this.parallelPreferences.clear();
    this.leases.clear();
    for (const timer of this.inputRefreshes.values()) clearTimeout(timer);
    this.inputRefreshes.clear();
    for (const track of this.tracks.values()) if (track.statusTimer) clearTimeout(track.statusTimer);
    this.tracks.clear();
    this.hookShadow?.stop();
  }
}

/** No trimming or whitespace normalization for a submit-only full-wire comparison. */
function exactComposer(screen: string, provider: "claude" | "codex"): string | null {
  if (/\x1b/.test(screen)) return null;
  const lines = screen.split("\n");
  if (provider === "codex") {
    if (codexDraft(screen) === null) return null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = /^\s*› (.*)$/.exec(lines[i]);
      if (match) return match[1];
    }
    return null;
  }
  for (let bottom = lines.length - 1; bottom > 0; bottom--) {
    if (!/^[─━]{3,}$/.test(lines[bottom])) continue;
    let top = bottom - 1;
    while (top >= 0 && !/^[─━]{3,}$/.test(lines[top])) top--;
    if (top < 0) return null;
    const first = /^[❯>] (.*)$/.exec(lines[top + 1]);
    if (!first || lines.slice(top + 2, bottom).some(line => /[│┃]/.test(line))) return null;
    return [first[1], ...lines.slice(top + 2, bottom)].join("\n");
  }
  return null;
}

/** How a CLI starts its own error line. Only the start of a line counts, so conversation text that mentions an error is not one. */
const SCREEN_ERROR_LINE = /^(?:API Error\b|you['’]ve (?:hit|reached) your\b|you['’]re out of usage credits\b|your org is out of usage\b|stream disconnected\b|error sending request\b)/i;
/**
 * The CLI's own connection or usage-limit error line among the last lines of the screen (just above the composer),
 * for a turn that ended without a status report. Any other ending is null.
 */
export function screenTurnError(screen: string): string | null {
  const lines = screen.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/)
    .map(line => line.replace(/^[^\p{L}\p{N}]+/u, "").trimEnd()).filter(Boolean).slice(-12);
  const line = lines.findLast(line => SCREEN_ERROR_LINE.test(line));
  return line && ["network", "usage_limit"].includes(classifyTurnError(line)) ? line : null;
}

/**
 * Guidance only, never a key: the screen reads like some version's folder-trust dialog. A screen that shows the
 * CLI's input box is not one (a real folder-trust dialog has no input box), whatever its banner path or its
 * conversation says about trust.
 */
export function trustDialogLike(screen: string, provider: "claude" | "codex"): boolean {
  return (provider === "claude" ? inputText(screen) : codexDraft(screen)) === null && looksLikeFolderTrust(screen);
}

/** Input safety only. Unknown composer layouts refuse delivery. */
export function codexDraft(screen: string): string | null {
  const clean = screen.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = clean.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^\s*›(?: (.*))?$/.exec(lines[i]);
    if (!match) continue;
    // terminal.read is plain text: the current native Codex placeholder is
    // indistinguishable from someone typing that exact sentence. A manual
    // control lease suspends automation while a person uses this composer.
    const below = lines.slice(i + 1).filter((line) => line.trim());
    if (below.some((line) => !/^\s*(?:\? for shortcuts|← for agents · \? for shortcuts|\d+% context left|(?:GPT-|gpt-|o\d|codex)[^·]* · [/~]|\S+\s+\d+% context left)/i.test(line))) return null;
    const draft = match[1]?.trim() || "";
    return draft === "Ask Codex to do anything" ? "" : draft;
  }
  return null;
}


export { ensureCoreServer } from "../core-supervisor.ts";
