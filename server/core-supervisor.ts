import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { childEnv } from "./runner/env.ts";
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
  /** After the fast burst the core is still started again, this far apart (doubling up to five times this). */
  slowRetryMs?: number;
  log?: (line: string) => void;
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
  private uncertainAt = 0;
  /** Since when nothing has answered on the socket path, without interruption. */
  private absentSince: number | null = null;
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
    // A rejected pass must not become an unhandled rejection (that ends the server process).
    const pass = () => { void this.tick().catch(error => console.error("core 감독 점검 실패:", error)); };
    this.timer = setInterval(pass, this.deps.pollMs ?? 1000); this.timer.unref?.();
    pass();
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
    const log = this.deps.log ?? (line => console.warn(line));
    const burst = this.deps.maxStartAttempts ?? 3, slowMs = this.deps.slowRetryMs ?? 60_000;
    if (presence === "owned") {
      if (this.starts > 0) log("[core] herdr-core 가 다시 응답합니다");
      this.starts = 0; this.startUncertain = false; this.nextStartAt = 0;
    }
    this.absentSince = presence === "absent" ? this.absentSince ?? now : null;
    // A start whose result was unknown may have produced a daemon. If the socket path then stays verifiably empty
    // for a whole slow interval, it did not: allow another start. It used to stay disarmed until the service restarted.
    if (this.startUncertain && this.absentSince !== null && now - Math.max(this.absentSince, this.uncertainAt) >= slowMs) {
      this.startUncertain = false;
      log("[core] 결과를 모르던 herdr-core 기동 뒤에도 소켓이 비어 있어 다시 띄웁니다");
    }
    if (presence === "absent" && !this.startUncertain && now >= this.nextStartAt) {
      this.starts++;
      // A fast burst first, then keep trying one to five minutes apart. It used to stop for good after the burst,
      // leaving every member unreachable until someone restarted the service by hand.
      this.nextStartAt = now + (this.starts < burst ? (this.deps.retryMs ?? 5000) * 2 ** (this.starts - 1) : Math.min(5 * slowMs, slowMs * 2 ** (this.starts - burst)));
      try { await this.deps.startOwned(); }
      catch (error) {
        const uncertain = !(error instanceof CoreError) || error.uncertain;
        if (uncertain) { this.startUncertain = true; this.uncertainAt = this.deps.now?.() ?? Date.now(); }
        if (this.starts <= burst || this.starts % 5 === 0) log(`[core] herdr-core 기동 실패(${this.starts}번째): ${error instanceof CoreError ? error.kind : "error"}${uncertain ? " · 결과를 몰라 소켓이 계속 비어 있는지 본 뒤 다시 시도합니다" : this.starts >= burst ? " · 1~5분 간격으로 계속 시도합니다" : ""}`);
      }
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
      // One member's failing callback must not stop the pass for the members after it.
      try { this.deps.observed?.({ ...entry.state }); } catch (error) { console.error("core 감독 관측 처리 실패:", id, error); }
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
