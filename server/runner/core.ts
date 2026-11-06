import { capturedContext } from "./statusline.ts";
import { readCodexContext } from "./codex-context.ts";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Backend } from "../../shared/types.ts";
import { cleanText } from "../text.ts";
import { childEnv } from "./headless.ts";
import { defaultClaudeHome, findSessionFile, inputText, screenContextPct } from "./herdr.ts";
import { CoreError, coreRpc, coreSocketPath, type CoreHello, type CoreTerminal } from "./core-client.ts";
import { providerFor, providerLaunch, isProviderArgv, type ProviderBins } from "./providers.ts";
import { readTranscriptTail } from "./transcript.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts, TerminalControlAction, TerminalControlResult } from "./types.ts";

/** claudeHome: Claude session transcripts (default CLAUDE_CONFIG_DIR or ~/.claude), read for context usage only. */
export interface CoreRunnerOptions extends ProviderBins { coreBin?: string; socketPath?: string; session?: string; stateDir?: string; configDir?: string; claudeHome?: string; codexHome?: string; contextHome?: string }
export interface CoreRunnerDeps { pollMs?: number; rpcTimeoutMs?: number; sendTimeoutMs?: number }
interface Track { member: RunnerMember; terminal: CoreTerminal; sessionId: string | null; pending: boolean; uncertain: boolean; status: string | null }
const REQUIRED_METHODS = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill"];
const unsupported = (detail: string): SendResult => ({ ok: false, reason: "error", retryable: false, detail });

/** Terminals belong to core's holders. IAMCEO shutdown only detaches. */
export class CoreRunner implements Runner {
  readonly kind: Backend = "core";
  readonly socketPath: string;
  private readonly rpcTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly tracks = new Map<string, Track>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private readonly configuring = new Set<string>();
  private readonly parallelPreferences = new Map<string, boolean>();
  private readonly leases = new Map<string, { id: string; expiresAt: number }>();
  private readonly sending = new Set<string>();
  private readonly starts = new Map<string, Promise<{ sessionId: string | null; paneId: string; rejoined?: boolean }>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private closed = false;

  constructor(private readonly options: CoreRunnerOptions = {}, private readonly deps: CoreRunnerDeps = {}) {
    this.socketPath = options.socketPath || coreSocketPath(options.session);
    this.rpcTimeoutMs = deps.rpcTimeoutMs ?? 8000;
    this.sendTimeoutMs = deps.sendTimeoutMs ?? 20_000;
  }
  private call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.rpcTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new CoreError("closed", "CoreRunner is shut down"));
    return coreRpc<T>(this.socketPath, method, params, timeoutMs);
  }
  async available(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const hello = await this.call<CoreHello>("hello", { generation: 1 });
      if (hello.generation !== 1) throw new CoreError("unsupported_generation", `Unsupported herdr-core generation: ${hello.generation}`);
      const missing = REQUIRED_METHODS.filter((method) => !hello.methods?.includes(method));
      if (missing.length) throw new CoreError("unsupported", `Core is missing methods: ${missing.join(", ")}`);
      return { ok: true, detail: `herdr-core ${hello.version} (${this.socketPath}); status requires OSC 7501; attach with hc attach` };
    } catch (error) { return { ok: false, detail: `${error instanceof Error ? error.message : error}. Start herdr-core with ${this.options.coreBin || "hc"} server start` }; }
  }
  on(callback: (event: RunnerEvent) => void): void { this.listeners.add(callback); }
  private emit(event: RunnerEvent): void { for (const callback of this.listeners) callback(event); }
  private labels(member: RunnerMember) { return { "iamceo.member": member.id, "iamceo.project": member.projectId, "iamceo.cli": providerFor(member) }; }
  private owns(terminal: CoreTerminal, member: RunnerMember): boolean {
    return Object.entries(this.labels(member)).every(([key, value]) => terminal.labels?.[key] === value);
  }
  private name(member: RunnerMember): string { return `iamceo-${createHash("sha256").update(`${member.projectId}:${member.id}`).digest("hex").slice(0, 24)}`; }
  private bind(member: RunnerMember, terminal: CoreTerminal, sessionId: string | null): Track {
    if (this.closed) throw new CoreError("closed", "CoreRunner shut down while starting; terminal remains owned by core");
    const track: Track = { member, terminal, sessionId, pending: false, uncertain: false, status: null };
    this.tracks.set(member.id, track);
    this.observe(track, terminal, true);
    this.emit({ type: "pane", memberId: member.id, paneId: terminal.address });
    if (sessionId) this.emit({ type: "session", memberId: member.id, sessionId });
    if (!this.timer) {
      this.timer = setInterval(() => { void this.poll(); }, this.deps.pollMs ?? 1000);
      this.timer.unref?.();
    }
    return track;
  }
  start(member: RunnerMember, opts: StartOpts): Promise<{ sessionId: string | null; paneId: string; rejoined?: boolean }> {
    const pending = this.starts.get(member.id);
    if (pending) return pending;
    const promise = this.startLocked(member, opts).finally(() => this.starts.delete(member.id));
    this.starts.set(member.id, promise);
    return promise;
  }
  private async startLocked(member: RunnerMember, opts: StartOpts) {
    const availability = await this.available();
    if (!availability.ok) throw new CoreError("unavailable", availability.detail || "Core unavailable");
    const snapshot = await this.call<{ terminals: CoreTerminal[] }>("terminal.list", {});
    const live = snapshot.terminals.filter((terminal) => terminal.state === "live");
    const matches = live.filter((terminal) => terminal.labels["iamceo.member"] === member.id && terminal.labels["iamceo.project"] === member.projectId);
    if (member.sessionId && live.some((terminal) => terminal.labels["iamceo.session"] === member.sessionId && !this.owns(terminal, member))) throw new CoreError("conflict", "CLI session is already owned by another live terminal");
    if (matches.length > 1) throw new CoreError("conflict", "Multiple live core terminals claim this member; choose one in hc before continuing");
    if (matches.length) {
      const terminal = matches[0];
      if (!this.owns(terminal, member)) throw new CoreError("conflict", "Live terminal belongs to a different CLI; stop it before switching provider");
      if (!isProviderArgv(terminal.argv, providerFor(member), providerFor(member) === "claude" ? this.options.claudeBin : this.options.codexBin)) throw new CoreError("conflict", "Core terminal is no longer running the configured CLI");
      if (member.sessionId && terminal.labels["iamceo.session"] && terminal.labels["iamceo.session"] !== member.sessionId) throw new CoreError("conflict", "Live terminal holds a different CLI session");
      const sessionId = terminal.labels["iamceo.session"] || member.sessionId;
      this.bind(member, terminal, sessionId);
      return { sessionId, paneId: terminal.address, rejoined: true };
    }
    // A persisted core pane is evidence of a previous program. Never replace it
    // on a transport failure, a missing snapshot, or an unknown Codex session.
    if (member.origin === "adopted") throw new CoreError("unsupported", "Core does not adopt terminals without IAMCEO ownership labels");
    if (providerFor(member) === "codex" && member.paneId && !member.sessionId) throw new CoreError("session_unknown", "The previous Codex terminal is gone and its native session id is unknown; explicitly start a fresh session with context handoff");
    const launch = providerLaunch(member, opts, this.options);
    const env = childEnv();
    for (const key of Object.keys(env)) if (/^(HC_|HERDR_)/.test(key)) delete env[key];
    // The core itself uses isolated XDG directories; its provider programs
    // retain the user's normal configuration/state roots.
    env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    env.XDG_STATE_HOME = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    Object.assign(env, launch.env);
    const terminal = await this.call<CoreTerminal>("terminal.run", {
      argv: launch.argv, cwd: member.cwd, env, name: this.name(member),
      labels: { ...this.labels(member), ...(launch.sessionId ? { "iamceo.session": launch.sessionId } : {}) },
      no_parent: true, outlive_parent: true, no_notify: true, keep: false, rm: false, wait: false,
    }, this.sendTimeoutMs);
    // A timed-out run may have spawned a holder. A later start first searches
    // the stable member labels/name, rather than replaying terminal.run.
    this.bind(member, terminal, launch.sessionId);
    return { sessionId: launch.sessionId, paneId: terminal.address };
  }
  private observe(track: Track, terminal: CoreTerminal, initial = false): void {
    if (this.closed || this.tracks.get(track.member.id) !== track) return;
    const previous = track.terminal;
    track.terminal = terminal;
    const state = terminal.status?.state;
    let status: "gone" | "working" | "idle" | "blocked";
    if (terminal.state !== "live") status = "gone";
    else if (state === "working") status = "working";
    else if (state === "blocked" || !state || !["idle", "done", "error"].includes(state)) status = "blocked";
    else status = "idle";
    // turn increments also on working->blocked; only a settled root report is
    // completion. Empty finalText is intentional: screens are not final output.
    let ended = false;
    if (!initial && (terminal.turn ?? 0) > (previous.turn ?? 0) && ["idle", "done", "error"].includes(state || "")) {
      track.pending = false;
      track.uncertain = false;
      ended = true;
      this.emit({ type: "turn_end", memberId: track.member.id, finalText: "", isError: state === "error", ...(state === "error" ? { errorText: terminal.status?.msg || "CLI reported an error" } : {}) });
    } else if (!initial && track.pending && previous.status?.state === "blocked" && ["idle", "done", "error"].includes(state || "")) {
      track.pending = false;
      ended = true;
      // Approval cancellation may settle without another working transition.
      this.emit({ type: "turn_end", memberId: track.member.id, finalText: "", isError: state === "error" });
    }
    if (ended) void this.reportContext(track);
    if (status === "gone") track.pending = false;
    if (status !== track.status) {
      track.status = status;
      this.emit({ type: "status", memberId: track.member.id, status });
      if (status === "blocked" && !state) this.emit({ type: "activity", memberId: track.member.id, kind: "error", text: `CLI status is unknown. Configure OSC 7501 reporting and use iamceo attach ${track.member.id} for setup or approval.` });
    }
  }
  /** 턴 끝 실측 창·사용량. core 는 문맥 표시만 하고 자동 압축은 하지 않는다. */
  private async reportContext(track: Track): Promise<void> {
    const sessionId = track.sessionId || track.member.sessionId;
    if (!sessionId) return;
    const endedAt = Date.now();
    const turn = track.terminal.turn;
    if (providerFor(track.member) === "codex") {
      const reading = readCodexContext(this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), sessionId);
      if (reading) this.emit({ type: "context_usage", memberId: track.member.id, ...reading, model: track.member.model });
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
    const screen = await this.call<{ text: string }>("terminal.read", { terminal: track.terminal.address, lines: 0 }).then((r) => r.text, () => "");
    if (this.closed || this.tracks.get(track.member.id) !== track) return;
    const shownPct = screenContextPct(screen);
    const reading = await capturedContext(this.options.contextHome, sessionId, { tokens, shownPct, model: track.member.model ?? model }, endedAt);
    if (this.closed || this.tracks.get(track.member.id) !== track || (track.sessionId || track.member.sessionId) !== sessionId || track.terminal.turn !== turn) return;
    if (reading.tokens === null && reading.shownPct === null && !reading.exact) return;
    this.emit({ type: "context_usage", memberId: track.member.id, sessionId, ...reading });
  }
  private async refresh(track: Track): Promise<CoreTerminal> {
    const terminal = await this.call<CoreTerminal>("terminal.get", { terminal: track.terminal.address });
    if (!this.owns(terminal, track.member)) throw new CoreError("conflict", "Core terminal ownership changed");
    this.observe(track, terminal);
    return terminal;
  }
  private async poll(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      await Promise.all([...this.tracks.values()].map(async (track) => {
        try { await this.refresh(track); }
        catch (error) {
          // A socket outage is not proof a holder died. Reconnect next poll.
          if (this.tracks.get(track.member.id) === track && error instanceof CoreError && error.kind === "not_found") {
            if (track.status !== "gone") { track.status = "gone"; this.emit({ type: "status", memberId: track.member.id, status: "gone" }); }
          }
        }
      }));
    } finally { this.polling = false; }
  }
  isBusy(memberId: string): boolean {
    const track = this.tracks.get(memberId);
    return !!track && (track.pending || track.uncertain || track.status === "working");
  }
  async send(member: RunnerMember, text: string, opts: StartOpts, _urgent = false): Promise<SendResult> {
    if (this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true, detail: "CLI configuration is being reloaded" };
    if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, detail: "Manual terminal control is active" };
    if (this.sending.has(member.id)) return { ok: false, reason: "busy", retryable: true };
    this.sending.add(member.id);
    let track = this.tracks.get(member.id);
    let deliveryAttempted = false;
    try {
      if (!track) { await this.start(member, opts); track = this.tracks.get(member.id)!; }
      if (track.pending || track.uncertain) return { ok: false, reason: "busy", retryable: false, detail: "A previous send is still running or delivery is uncertain; inspect the terminal" };
      const terminal = await this.refresh(track);
      if (terminal.state !== "live") return { ok: false, reason: "gone", retryable: false };
      const state = terminal.status?.state;
      if (state === "working") return { ok: false, reason: "busy", retryable: true };
      if (state === "blocked") return { ok: false, reason: "blocked", retryable: true, detail: `Complete the CLI dialog with iamceo attach ${member.id}` };
      if (!["idle", "done"].includes(state || "")) return { ok: false, reason: "input_busy", retryable: false, detail: `No trustworthy idle OSC 7501 status; inspect CLI setup with iamceo attach ${member.id}` };
      const screen = await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 });
      // Never erase a person's draft or deliver through an unidentified dialog.
      // Status is taken exclusively from OSC7501, never this screen guard.
      const draft = providerFor(member) === "claude" ? inputText(screen.text) : codexDraft(screen.text);
      if (draft !== "") return { ok: false, reason: "input_busy", retryable: false, detail: draft === null ? "Cannot identify an empty CLI composer" : "A user draft is present; IAMCEO leaves it untouched" };
      const preference = this.parallelPreferences.get(member.id) ?? member.parallel;
      const prefix = providerFor(member) === "codex" && preference !== undefined
        ? (preference ? "IAMCEO execution preference: Use native subagents for independent work in parallel when useful; retain your normal approvals and tool access.\n\n" : "IAMCEO execution preference: Work sequentially for this task; do not spawn subagents.\n\n") : "";
      const cleaned = cleanText(prefix + text);
      if (!cleaned.trim()) return unsupported("Message is empty");
      track.pending = true;
      // Core generation 1 only permits if:idle|working. A done report has
      // no exact conditional; force:false still refuses any approval dialog.
      // IAMCEO manual controls use a lease; direct external attach cannot be
      // made atomic with this guard by the current core API.
      if (this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true };
      if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, detail: "Manual terminal control is active" };
      deliveryAttempted = true;
      const result = await this.call<{ turn: number; started?: boolean | null }>("terminal.send", { terminal: terminal.address, text: cleaned, ...(state === "idle" ? { if: "idle" } : {}), force: false, wait: false }, this.sendTimeoutMs);
      if (!Number.isSafeInteger(result.turn)) throw new CoreError("protocol", "Send reply has no valid turn counter", true);
      // started:false still means paste+Enter was delivered. Never resend it.
      await this.refresh(track).catch(() => undefined);
      return { ok: true };
    } catch (error) {
      if (track && deliveryAttempted && error instanceof CoreError && error.uncertain) { track.pending = false; track.uncertain = true; return unsupported(`Delivery may have occurred; do not resend automatically. ${error.message}`); }
      if (track) track.pending = false;
      if (error instanceof CoreError && ["blocked", "status_mismatch"].includes(error.kind)) return { ok: false, reason: error.kind === "blocked" ? "blocked" : "busy", retryable: true, detail: error.message };
      return { ok: false, reason: "error", retryable: false, detail: error instanceof Error ? error.message : String(error) };
    } finally { this.sending.delete(member.id); }
  }
  compact(_member: RunnerMember, _focus: string, _opts: StartOpts): Promise<SendResult> { return Promise.resolve(unsupported("Use the CLI's /compact command in hc attach; automated compact is not supported")); }
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
      const screen = await this.screen(member).catch(() => "");
      const index = screen.lastIndexOf(command);
      if (index >= 0 && screen.slice(index + command.length).split("\n").some((line) => new RegExp(`^\\W*ultracode ${word}\\b`, "i").test(line))) {
        const track = this.tracks.get(member.id);
        if (track) track.pending = false;
        return { ok: true };
      }
      await Bun.sleep(150);
    }
    return unsupported(`The command was delivered, but Ultracode ${word} was not confirmed; inspect the terminal before retrying`);
  }
  async applyConfig(member: RunnerMember, opts: StartOpts): Promise<SendResult> {
    const track = this.tracks.get(member.id);
    if (!track) return { ok: false, reason: "gone", retryable: false };
    if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, detail: "Manual terminal control is active" };
    if (this.isBusy(member.id) || this.sending.has(member.id) || this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true };
    const sessionId = track.sessionId || member.sessionId;
    if (!sessionId) return unsupported("Native Codex session id is unknown; use the CLI /model menu or explicitly start a fresh session");
    this.configuring.add(member.id);
    try {
      const terminal = await this.refresh(track);
      if (!["idle", "done"].includes(terminal.status?.state || "")) return { ok: false, reason: "blocked", retryable: true };
      const screen = await this.screen(member);
      const draft = providerFor(member) === "claude" ? inputText(screen) : codexDraft(screen);
      if (draft !== "") return { ok: false, reason: "input_busy", retryable: false, detail: "Configuration reload requires an identifiable empty composer; the user draft is preserved" };
      const resumed = { ...member, sessionId, paneId: null };
      providerLaunch(resumed, { ...opts, resume: true }, this.options); // Validate before stopping.
      await this.stop(member);
      await this.start(resumed, { ...opts, resume: true });
      return { ok: true };
    } catch (error) { return unsupported(error instanceof Error ? error.message : String(error)); }
    finally { this.configuring.delete(member.id); }
  }
  private async owned(member: RunnerMember): Promise<CoreTerminal> {
    const address = this.tracks.get(member.id)?.terminal.address || member.paneId;
    if (!address) throw new CoreError("not_found", "No core terminal for member");
    const terminal = await this.call<CoreTerminal>("terminal.get", { terminal: address });
    if (!this.owns(terminal, member)) throw new CoreError("conflict", "Refusing to control a core terminal without matching IAMCEO ownership labels");
    return terminal;
  }
  async interrupt(member: RunnerMember): Promise<void> {
    const terminal = await this.owned(member);
    const result = await this.call<{ outcome: string }>("terminal.interrupt", { terminal: terminal.address, timeout: 3 }, 6000);
    if (!["stopped", "exited"].includes(result.outcome)) throw new CoreError("not_stopped", `CLI interrupt outcome: ${result.outcome}`);
  }
  async checkStop(member: RunnerMember, opts: { whileWorking?: boolean } = {}): Promise<void> {
    if (member.origin === "adopted") throw new CoreError("unsupported", "Cannot close an adopted user terminal");
    const terminal = await this.owned(member);
    if (terminal.state !== "live") return;
    const state = terminal.status?.state;
    if (!opts.whileWorking && !["idle", "done"].includes(state || "")) throw new CoreError("busy", "Resolve the current CLI turn/dialog before changing its provider or configuration");
    if (["idle", "done"].includes(state || "")) {
      const screen = await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 });
      const draft = providerFor(member) === "claude" ? inputText(screen.text) : codexDraft(screen.text);
      if (draft !== "") throw new CoreError("input_busy", "Cannot close a CLI with a user draft or unknown composer; the draft is preserved");
    }
  }
  async stop(member: RunnerMember): Promise<void> {
    await this.checkStop(member, { whileWorking: true });
    const terminal = await this.owned(member);
    if (terminal.state === "live") {
      const result = await this.call<CoreTerminal>("terminal.kill", { terminal: terminal.address }, 15_000);
      if (result.state !== "finished") throw new CoreError("not_stopped", "Core did not confirm terminal termination");
    }
    this.leases.delete(member.id);
    this.parallelPreferences.delete(member.id);
    this.tracks.delete(member.id);
    this.emit({ type: "status", memberId: member.id, status: "gone" });
  }
  async screen(member: RunnerMember): Promise<string> {
    const terminal = await this.owned(member);
    return (await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 })).text;
  }
  private manualLease(memberId: string) {
    const lease = this.leases.get(memberId);
    if (lease && lease.expiresAt > Date.now()) return lease;
    this.leases.delete(memberId);
    return null;
  }
  async terminalControl(member: RunnerMember, action: TerminalControlAction): Promise<TerminalControlResult> {
    const terminal = await this.owned(member);
    const lease = this.manualLease(member.id);
    if (action.action === "claim") {
      if (this.sending.has(member.id) || this.configuring.has(member.id)) throw new CoreError("busy", "An automatic delivery is in progress; claim control after it settles");
      if (lease && action.leaseId !== lease.id) throw new CoreError("conflict", "Another terminal control lease is active");
      const next = { id: lease?.id || crypto.randomUUID(), expiresAt: Date.now() + 5 * 60_000 };
      this.leases.set(member.id, next);
      return { leaseId: next.id, expiresAt: next.expiresAt };
    }
    if (!lease || action.leaseId !== lease.id) throw new CoreError("conflict", "A matching active terminal control lease is required");
    if (action.action === "release") {
      this.leases.delete(member.id);
      const track = this.tracks.get(member.id);
      if (track) await this.refresh(track);
      return {};
    }
    if (terminal.state !== "live") throw new CoreError("finished", "Terminal has finished");
    if (action.action === "input") {
      if (typeof action.text !== "string" || !action.text.length || Buffer.byteLength(action.text) > 128 * 1024) throw new CoreError("invalid_params", "Terminal input must contain 1–131072 bytes");
      // force is confined to this explicit human action under a valid lease.
      await this.call("terminal.send", { terminal: terminal.address, text: cleanText(action.text), force: true, wait: false }, this.sendTimeoutMs);
    } else if (action.action === "key") {
      if (!action.key || !["enter", "up", "down", "esc", "tab", "ctrl+c", "backspace"].includes(action.key)) throw new CoreError("invalid_params", "Unsupported terminal control key");
      await this.call("terminal.keys", { terminal: terminal.address, keys: [action.key] }, this.sendTimeoutMs);
    } else throw new CoreError("invalid_params", "Unsupported terminal control action");
    // Human input takes responsibility for any previously ambiguous delivery.
    const track = this.tracks.get(member.id);
    if (track) { track.uncertain = false; await this.refresh(track).catch(() => undefined); }
    lease.expiresAt = Date.now() + 5 * 60_000;
    return { leaseId: lease.id, expiresAt: lease.expiresAt };
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.configuring.clear();
    this.parallelPreferences.clear();
    this.leases.clear();
    this.tracks.clear();
  }
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


/** Start only the caller's explicitly isolated core. Never update/restart it. */
export async function ensureCoreServer(options: CoreRunnerOptions): Promise<void> {
  if (!options.socketPath || !options.stateDir || !options.configDir || !options.session) throw new CoreError("config", "Owned core startup requires explicit socketPath, session, stateDir and configDir");
  try {
    const hello = await coreRpc<CoreHello>(options.socketPath, "hello", { generation: 1 }, 1000);
    if (hello.generation !== 1) throw new CoreError("unsupported_generation", "Owned core has an unsupported generation");
    return;
  } catch (error) {
    if (!(error instanceof CoreError) || !["down", "closed"].includes(error.kind)) throw error;
  }
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
  const command = options.coreBin || "hc";
  const bin = command.includes("/") ? command : Bun.which(command);
  if (!bin) throw new CoreError("unavailable", `herdr-core executable not found: ${command}`);
  const env = { ...childEnv(), HC_SOCKET: options.socketPath, HC_SESSION: options.session, XDG_STATE_HOME: options.stateDir, XDG_CONFIG_HOME: options.configDir };
  const child = Bun.spawn([bin, "server", "start", "--json"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const code = await Promise.race([child.exited, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { child.kill(); reject(new CoreError("timeout", "Owned herdr-core startup timed out; its daemon may still start, so inspect it before retrying")); }, 15_000); })]);
    if (code !== 0) {
      // Startup diagnostics can include settings, so keep them out of browser/API errors.
      throw new CoreError("unavailable", `Owned herdr-core startup exited with code ${code}`);
    }
    const hello = await coreRpc<CoreHello>(options.socketPath, "hello", { generation: 1 }, 5000);
    if (hello.generation !== 1) throw new CoreError("unsupported_generation", "Owned core has an unsupported generation");
  } finally { if (timer) clearTimeout(timer); }
}
