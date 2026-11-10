import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { childEnv } from "./runner/headless.ts";
import { CoreError, coreRpc, type CoreHello } from "./runner/core-client.ts";
import type { CoreRunnerOptions } from "./runner/core.ts";
import type { RunnerMember, RunnerReattachResult } from "./runner/types.ts";

const startups = new Map<string, Promise<void>>();
/** Only explicit isolated, IAMCEO-owned configuration is eligible. No CLI is launched here. */
export function ensureCoreServer(options: CoreRunnerOptions): Promise<void> {
  if (!options.socketPath || !options.stateDir || !options.configDir || !options.session ||
    ![options.socketPath, options.stateDir, options.configDir].every(isAbsolute) || !/^[a-zA-Z0-9_.-]+$/.test(options.session)) return Promise.reject(new CoreError("config", "Owned core startup requires explicit absolute socketPath, session, stateDir and configDir"));
  const key = resolve(options.socketPath);
  const active = startups.get(key);
  if (active) return active;
  const pending = startOwned(options).finally(() => { if (startups.get(key) === pending) startups.delete(key); });
  startups.set(key, pending);
  return pending;
}
async function startOwned(options: CoreRunnerOptions): Promise<void> {
  try {
    const hello = await coreRpc<CoreHello>(options.socketPath!, "hello", { generation: 1 }, 1000);
    if (hello.generation !== 1) throw new CoreError("unsupported_generation", "Owned core has an unsupported generation");
    return;
  } catch (error) {
    // Refused connections, timeout, protocol errors and ownership changes do not
    // prove absence. Never replace a potentially live server on those signals.
    if (!(error instanceof CoreError) || error.deliveryEffect !== "not_written" || error.causeCode !== "ENOENT") throw error;
  }
  mkdirSync(options.stateDir!, { recursive: true, mode: 0o700 });
  mkdirSync(options.configDir!, { recursive: true, mode: 0o700 });
  const command = options.coreBin || "hc";
  const bin = command.includes("/") ? command : Bun.which(command);
  if (!bin) throw new CoreError("unavailable", "Owned core executable not found");
  const env = { ...childEnv(), HC_SOCKET: options.socketPath!, HC_SESSION: options.session!, XDG_STATE_HOME: options.stateDir!, XDG_CONFIG_HOME: options.configDir! };
  const child = Bun.spawn([bin, "server", "start", "--json"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new CoreError("timeout", "Owned core startup timed out; inspect before another attempt", true)); }, 15_000); })]);
    if (code !== 0) throw new CoreError("unavailable", `Owned core startup exited with code ${code}`);
    const hello = await coreRpc<CoreHello>(options.socketPath!, "hello", { generation: 1 }, 5000);
    if (hello.generation !== 1) throw new CoreError("unsupported_generation", "Owned core has an unsupported generation");
  } finally { if (timer) clearTimeout(timer); }
}

export interface CoreSupervisorObservation {
  memberId: string; outcome: RunnerReattachResult["outcome"];
  lastObservedAt: number | null; failures: number; code: string | null; nextAttemptAt: number;
}
export interface CoreSupervisorDeps {
  reattachOwned(member: RunnerMember): Promise<RunnerReattachResult>;
  /** Absent means both owner/core absence are verified, not just failed hello. */
  presence(): Promise<"owned" | "absent" | "conflict" | "unknown">;
  startOwned(): Promise<void>;
  now?: () => number; pollMs?: number; retryMs?: number; maxStartAttempts?: number;
  observed?: (state: CoreSupervisorObservation) => void;
}
/** Queue-independent read-only reattachment. Runtime integration belongs to W6-O. */
export class CoreSupervisor {
  private readonly members = new Map<string, { member: RunnerMember; state: CoreSupervisorObservation }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private stopped = false;
  private starts = 0;
  private nextStartAt = 0;
  private startUncertain = false;
  constructor(private readonly deps: CoreSupervisorDeps) {}
  watch(member: RunnerMember): void {
    if (this.stopped) return;
    const existing = this.members.get(member.id);
    // Same generation: update in place. Swapping the object discarded the result of the reattachment in flight.
    if (existing && existing.member.sessionGeneration === member.sessionGeneration && existing.member.projectId === member.projectId) { Object.assign(existing.member, member); return; }
    this.members.set(member.id, { member: { ...member }, state: { memberId: member.id, outcome: "unknown", lastObservedAt: null, failures: 0, code: null, nextAttemptAt: 0 } });
  }
  unwatch(memberId: string): void { this.members.delete(memberId); }
  observations(): CoreSupervisorObservation[] { return [...this.members.values()].map(({ state }) => ({ ...state })); }
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.pollMs ?? 1000); this.timer.unref?.();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) return this.active;
    const pending = this.run().finally(() => { if (this.active === pending) this.active = null; });
    this.active = pending;
    return pending;
  }
  private async run(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    let presence: Awaited<ReturnType<CoreSupervisorDeps["presence"]>>;
    try { presence = await this.deps.presence(); } catch { presence = "unknown"; }
    if (this.stopped) return;
    if (presence === "owned") { this.starts = 0; this.startUncertain = false; }
    if (presence === "absent" && !this.startUncertain && this.starts < (this.deps.maxStartAttempts ?? 3) && now >= this.nextStartAt) {
      this.starts++; this.nextStartAt = now + (this.deps.retryMs ?? 5000) * 2 ** (this.starts - 1);
      try { await this.deps.startOwned(); }
      catch (error) { if (!(error instanceof CoreError) || error.uncertain) this.startUncertain = true; }
    }
    if (this.stopped) return;
    for (const [id, entry] of this.members) {
      if (now < entry.state.nextAttemptAt) continue;
      const watched = entry.member;
      let result: RunnerReattachResult;
      if (presence === "conflict") result = { outcome: "conflict", code: "core_owner_conflict" };
      else {
        try { result = await this.deps.reattachOwned(entry.member); }
        catch (error) { result = { outcome: "unknown", code: error instanceof CoreError ? error.kind : "error" }; }
      }
      if (this.stopped || this.members.get(id) !== entry || entry.member !== watched) continue;
      const success = result.outcome === "rejoined";
      entry.state = { memberId: id, outcome: result.outcome, lastObservedAt: success ? now : entry.state.lastObservedAt,
        failures: success ? 0 : entry.state.failures + 1, code: result.outcome === "rejoined" ? null : result.code,
        nextAttemptAt: now + (success ? this.deps.pollMs ?? 1000 : Math.min(60_000, (this.deps.retryMs ?? 1000) * 2 ** Math.min(entry.state.failures, 6))) };
      this.deps.observed?.({ ...entry.state });
    }
  }
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
    this.members.clear();
  }
}
