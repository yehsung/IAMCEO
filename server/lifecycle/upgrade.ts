// `iamceo upgrade` 와 `iamceo rollback`.
// 설치판(앱 묶음 안의 실행 파일)은 릴리스 파일로, git 체크아웃에서 도는 서버(대표 라이브)는 커밋으로 바꾼다. 순서는 같다:
//   새 판으로 DB 사본 예행 → 직전 판 기록(plist·DB 사본·이전 앱 또는 커밋) → 서비스 내림 → 교체 → 올림 → 준비 확인.
// 정해진 시간 안에 준비되지 않으면 스스로 직전 판으로 되돌린다. 자동 되돌리기는 기동 실패 때만 한다
// (되돌리면 그 사이 쌓인 대화가 옆 사본으로 빠지므로, 이미 잘 돌고 있는 판을 나중에 되돌리는 것은 대표가 rollback 으로 정한다).
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { say } from "../cli-text.ts";
import { homeDir, loadConfig, type Config } from "../config.ts";
import { normalizeHome } from "../home-owner.ts";
import {
  detectInstallation, LifecycleError, readServicePlist, realLaunchctl, serviceDomain, serviceLoaded, servicePlistPath, startService, stopService,
  type Installation, type Launchctl, type ServiceControl,
} from "./launchd.ts";
import { describeRehearsal, rehearseDatabase, type Rehearse } from "./rehearse.ts";
import { compareVersions, releaseSource, stageRelease, type ReleaseTools } from "./release.ts";
import { databaseSchema, moveBundle, restoreDatabase, snapshotDatabase, waitHomeOwner, waitReady, type ReadinessCheck } from "./runtime.ts";
import { keptAsideCopies, latestRollbackTarget, newUpgradeId, pruneUpgradeRecords, saveUpgradeRecord, upgradeDir, type UpgradeRecord } from "./state.ts";
import { savedTailnetHttps, TAILNET_SERVE_OFF_COMMAND, turnOffTailnetHttps } from "./tailnet-off.ts";
import type { TailscaleRunner } from "../tailnet-https.ts";

export type CommandRunner = (command: string[], options?: { cwd?: string; timeoutMs?: number }) => { code: number; stdout: string; stderr: string };

/** 바깥 세계와 닿는 모든 것. 시험은 가짜 launchctl·준비 확인·예행·릴리스 도구를 넣는다. */
export interface LifecycleDeps {
  launchctl?: Launchctl;
  userHome?: string;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => Date;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  run?: CommandRunner;
  rehearse?: Rehearse;
  readiness?: ReadinessCheck;
  releaseTools?: ReleaseTools;
  appRunning?: () => boolean;
  brewCaskrooms?: string[];
  scratch?: string;
  stopTimeoutMs?: number;
  /** 서버가 답하지 않을 때 HTTPS 주소를 끄는 tailscale(시험은 가짜). */
  tailscale?: TailscaleRunner;
}

export interface UpgradeOptions {
  /** git 판: 올릴 커밋. */
  target?: string;
  /** 설치판: 정한 버전(v0.2.4). 없으면 최신. */
  version?: string;
  /** 설치판: 릴리스 자산 폴더(https://, file://, 로컬 폴더). */
  from?: string;
  dryRun?: boolean;
  /** 같은 버전도 다시 깐다 / Homebrew 설치도 바꾼다. */
  force?: boolean;
  allowDowngrade?: boolean;
  skipRehearsal?: boolean;
  /** 새 판이 준비되기를 기다리는 시간. 기본 120초. */
  timeoutMs?: number;
}

export interface UpgradeOutcome { status: "upgraded" | "current" | "dry_run"; mode: "release" | "git"; from: string; to: string; id?: string }
export interface RollbackOutcome { status: "rolled_back" | "dry_run"; mode: "release" | "git"; from: string; to: string; id: string; databaseRestored: boolean }

const defaultRun: CommandRunner = (command, options = {}) => {
  try {
    const result = Bun.spawnSync(command, { cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: options.timeoutMs ?? 300_000 });
    return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (error) {
    // 실행 파일이 없거나 실행할 수 없다(옮겨진 앱 등). 던지지 않고 실패로 돌려준다.
    return { code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
};

interface Context {
  env: NodeJS.ProcessEnv; userHome: string; control: ServiceControl; log: (line: string) => void; now: () => Date;
  run: CommandRunner; rehearse: Rehearse; readiness: ReadinessCheck; releaseTools?: ReleaseTools; fetch?: typeof fetch;
  appRunning: () => boolean; brewCaskrooms: string[]; scratch?: string; stopTimeoutMs: number; sleep: (ms: number) => Promise<unknown>;
  tailscale?: TailscaleRunner;
}

function context(deps: LifecycleDeps, dryRun: boolean): Context {
  const env = deps.env ?? process.env;
  // 시험 환경은 실제 launchd 를 절대 부르지 않는다. 미리 보기(--dry-run)만 된다.
  if (!dryRun && env.IAMCEO_TEST === "1" && !deps.launchctl) throw new LifecycleError(say("IAMCEO_TEST=1 에서는 실제 서비스를 바꾸지 않습니다. --dry-run 을 쓰세요.", "With IAMCEO_TEST=1 the real service is never changed. Use --dry-run."));
  if (!dryRun && process.platform !== "darwin" && !deps.launchctl) throw new LifecycleError(say("launchd 서비스는 macOS 에서만 됩니다", "The launchd service is macOS only"));
  const userHome = deps.userHome ?? homedir();
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  return {
    env, userHome, sleep, log: deps.log ?? (line => console.log(line)), now: deps.now ?? (() => new Date()),
    control: { launchctl: deps.launchctl ?? realLaunchctl, domain: serviceDomain(deps.uid), plistPath: servicePlistPath(userHome), sleep },
    run: deps.run ?? defaultRun, rehearse: deps.rehearse ?? (input => rehearseDatabase({ ...input, scratch: deps.scratch })),
    readiness: deps.readiness ?? ((config, expected, timeoutMs) => waitReady(config, expected, timeoutMs, { fetch: deps.fetch })),
    releaseTools: deps.releaseTools, fetch: deps.fetch, scratch: deps.scratch, stopTimeoutMs: deps.stopTimeoutMs ?? 30_000, tailscale: deps.tailscale,
    appRunning: deps.appRunning ?? (() => Bun.spawnSync(["/usr/bin/pgrep", "-x", "IAMCEO"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode === 0),
    brewCaskrooms: deps.brewCaskrooms ?? ["/opt/homebrew/Caskroom/iamceo", "/usr/local/Caskroom/iamceo"],
  };
}

function loadInstallation(ctx: Context): Installation {
  const plist = readServicePlist(ctx.control.plistPath);
  if (!plist) throw new LifecycleError(say("등록된 IAMCEO 서비스가 없습니다. 앱에서 '이 Mac에서 시작'으로 먼저 시작하세요.", "No IAMCEO service is registered. Start it first with 'Start on this Mac' in the app."));
  const inst = detectInstallation(plist, ctx.userHome);
  // 다른 데이터 폴더를 쓰는 서비스를 이 명령의 홈으로 착각해 바꾸지 않는다(시험 홈으로 라이브를 건드리는 사고).
  if (normalizeHome(inst.home) !== normalizeHome(homeDir(ctx.env))) {
    throw new LifecycleError(say(`등록된 서비스는 다른 데이터 폴더(${inst.home})를 씁니다. IAMCEO_HOME 을 그 폴더로 맞춘 뒤 다시 실행하세요.`,
      `The registered service uses another data folder (${inst.home}). Set IAMCEO_HOME to that folder and run again.`));
  }
  return inst;
}

function serviceConfig(inst: Installation, ctx: Context): Config {
  return loadConfig({ ...ctx.env, ...inst.plist.env, IAMCEO_HOME: inst.home });
}

function probe(ctx: Context, command: string[], what: "build-id" | "version", cwd?: string): string {
  const result = ctx.run([...command, what], { cwd, timeoutMs: 60_000 });
  const value = result.stdout.trim();
  if (result.code !== 0 || (what === "build-id" ? !/^[a-f0-9]{64}$/.test(value) : !/^\d+\.\d+\.\d+$/.test(value))) {
    throw new LifecycleError(say(`실행 파일이 ${what === "build-id" ? "build ID 를" : "버전을"} 답하지 않습니다: ${command.at(-1)}`,
      `The executable did not report its ${what === "build-id" ? "build ID" : "version"}: ${command.at(-1)}`));
  }
  return value;
}

/** 예행에서 기동(이주 포함)이 오래 걸렸으면 실제 기동도 그만큼 기다린다. 큰 DB 의 첫 이주를 '안 뜸'으로 오인해 되돌리지 않게. */
export function readinessBudget(timeoutMs: number, rehearsedStartupMs: number | null): number {
  return rehearsedStartupMs === null ? timeoutMs : Math.max(timeoutMs, Math.ceil(rehearsedStartupMs * 3) + 30_000);
}

function stamp(ctx: Context): string { return ctx.now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }

function save(record: UpgradeRecord, patch: Partial<UpgradeRecord>): void {
  Object.assign(record, patch);
  saveUpgradeRecord(record);
}

function git(ctx: Context, checkout: string, ...args: string[]): { code: number; out: string; err: string } {
  const result = ctx.run(["git", "-C", checkout, ...args], { timeoutMs: 120_000 });
  return { code: result.code, out: result.stdout.trim(), err: result.stderr.trim() };
}

function gitOrFail(ctx: Context, checkout: string, ...args: string[]): string {
  const result = git(ctx, checkout, ...args);
  if (result.code !== 0) throw new LifecycleError(say(`git ${args[0]} 실패: ${result.err || result.out}`, `git ${args[0]} failed: ${result.err || result.out}`));
  return result.out;
}

function bunInstall(ctx: Context, inst: Extract<Installation, { kind: "git" }>): void {
  const result = ctx.run([inst.bun, "install", "--frozen-lockfile"], { cwd: inst.checkout, timeoutMs: 600_000 });
  if (result.code !== 0) ctx.log(say("경고: bun install --frozen-lockfile 이 실패했습니다(계속합니다). 새 판이 뜨지 않으면 스스로 되돌립니다.",
    "Warning: bun install --frozen-lockfile failed (continuing). If the new build does not start it is rolled back automatically."));
}

/** 서버를 내린 뒤의 일관된 DB 사본. 홈 잠금으로 서버가 DB 를 놓았음을 확인하고 만든다. */
async function snapshotStopped(ctx: Context, inst: Installation, target: string): Promise<number | null> {
  const owner = await waitHomeOwner(inst.home, ctx.stopTimeoutMs, ctx.sleep);
  try {
    const live = join(owner.home, "iamceo.db");
    return existsSync(live) ? snapshotDatabase(live, target) : null;
  } finally { owner.release(); }
}

/**
 * 되돌리기가 아무것도 바꾸지 않았거나, 바꾼 것을 모두 원래대로(서비스가 떠 있었으면 다시 올려) 돌려놓았다.
 * 기록은 그대로라 원인을 고친 뒤 다시 되돌릴 수 있다.
 */
export class RollbackKept extends LifecycleError {}

/** 서비스를 내리기 전에, 되돌리기 도중 실패할 조건을 먼저 본다. 여기서 멈추면 아무것도 바뀌지 않았다. */
function rollbackPreflight(record: UpgradeRecord, inst: Installation, ctx: Context): void {
  if (inst.kind === "git" && record.from.rev) {
    const head = gitOrFail(ctx, inst.checkout, "rev-parse", "HEAD");
    if (head !== record.from.rev && gitOrFail(ctx, inst.checkout, "status", "--porcelain", "--untracked-files=no")) {
      throw new RollbackKept(say("체크아웃에 커밋하지 않은 변경이 있어 되돌리지 않았습니다. 아무것도 바꾸지 않았습니다. 정리한 뒤 다시 실행하세요.",
        "The checkout has uncommitted changes, so nothing was rolled back or changed. Clean it up and run again."));
    }
  }
  if (inst.kind === "release" && record.previousApp && existsSync(record.previousApp)) {
    const installed = record.installedApp ?? inst.app;
    if (!existsSync(dirname(installed))) throw new RollbackKept(say(`앱을 둘 폴더가 없어 되돌리지 않았습니다: ${dirname(installed)}`, `The folder for the app is missing, so nothing was rolled back: ${dirname(installed)}`));
  }
}

function fsyncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** restoreDatabase 를 되돌린다: 되돌린 판이 쓴 DB 는 attempt 폴더로 빼고, aside 에 빼 두었던 DB 를 제자리로 돌린다. 서버가 꺼져 있어야 한다. */
async function putDatabaseBack(home: string, aside: string, attempt: string, ctx: Context): Promise<void> {
  const owner = await waitHomeOwner(home, ctx.stopTimeoutMs, ctx.sleep);
  try {
    const live = join(owner.home, "iamceo.db");
    mkdirSync(attempt, { recursive: true, mode: 0o700 });
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(live + suffix)) renameSync(live + suffix, join(attempt, `iamceo.db${suffix}`));
    for (const suffix of ["", "-wal", "-shm"]) {
      const kept = join(aside, `iamceo.db${suffix}`);
      if (existsSync(kept)) renameSync(kept, live + suffix);
    }
    fsyncDir(owner.home);
    try { rmdirSync(aside); } catch { /* 비지 않았으면 남긴다 */ }
  } finally { owner.release(); }
}

/**
 * 기록된 직전 판으로 돌린다(자동·수동 공용). 순서: 실패할 조건 확인 → 서비스 내림 → 앱 묶음 또는 커밋 되돌리기 →
 * (스키마가 올라갔으면) DB 를 사본으로 되돌리기(지금 DB 는 옆에 둔다) → 올려서 직전 판이 준비됐는지 확인.
 * 코드를 먼저 되돌리므로, 코드 되돌리기가 실패해도 DB 는 손대지 않은 채다(새 코드가 옛 DB 사본 위에서 뜨는 일이 없다).
 * 도중에 실패하면 바꾼 것을 거꾸로 되돌리고, 서비스가 떠 있었으면 다시 올린 뒤 RollbackKept 를 던진다.
 * 그 원상 복구마저 실패하면 일반 LifecycleError 다. 돌려주는 값은 DB 를 되돌렸는가.
 */
async function rollBack(record: UpgradeRecord, inst: Installation, ctx: Context, config: Config, timeoutMs: number): Promise<boolean> {
  const dir = upgradeDir(inst.home, record.id), when = stamp(ctx);
  rollbackPreflight(record, inst, ctx);
  const wasLoaded = serviceLoaded(ctx.control);
  try { await stopService(ctx.control, ctx.stopTimeoutMs); }
  catch (error) {
    if (wasLoaded) { try { await startService(ctx.control); } catch { /* 아래 오류로 알린다 */ } }
    throw new RollbackKept(say(`서비스를 내리지 못해 되돌리지 않았습니다: ${error instanceof Error ? error.message : String(error)}`,
      `Could not stop the service, so nothing was rolled back: ${error instanceof Error ? error.message : String(error)}`));
  }
  const undo: (() => void | Promise<void>)[] = [];
  let databaseRestored = false;
  try {
    // 1. 코드
    if (inst.kind === "release") {
      const installed = record.installedApp ?? inst.app;
      const previous = record.previousApp;
      if (previous && existsSync(previous)) {
        const parked = join(dir, `rolled-back-${when}.app`);
        if (existsSync(installed)) { moveBundle(installed, parked); undo.push(() => moveBundle(parked, installed)); }
        moveBundle(previous, installed);
        undo.push(() => moveBundle(installed, previous));
      }
    } else if (record.from.rev) {
      const head = gitOrFail(ctx, inst.checkout, "rev-parse", "HEAD");
      if (head !== record.from.rev) {
        gitOrFail(ctx, inst.checkout, "reset", "--keep", record.from.rev);
        undo.push(() => { gitOrFail(ctx, inst.checkout, "reset", "--keep", head); bunInstall(ctx, inst); });
      }
      bunInstall(ctx, inst);
    }
    // 2. DB — 직전 판은 미래 스키마의 DB 를 바이트 하나 바꾸지 않고 거절한다. 그때만 DB 를 되돌린다.
    const owner = await waitHomeOwner(inst.home, ctx.stopTimeoutMs, ctx.sleep);
    try {
      const live = join(owner.home, "iamceo.db");
      const now = existsSync(live) ? databaseSchema(live) : null;
      if (record.database && record.from.schemaVersion !== null && now !== null && now > record.from.schemaVersion) {
        const aside = join(dir, `after-upgrade-${when}`);
        restoreDatabase(owner, record.database, aside);
        databaseRestored = true;
        undo.push(() => putDatabaseBack(inst.home, aside, join(dir, `rollback-attempt-${when}`), ctx));
      }
    } finally { owner.release(); }
    // 3. 올리고 확인
    await startService(ctx.control);
    await ctx.readiness(config, { buildId: record.from.buildId, version: record.from.version }, timeoutMs);
    return databaseRestored;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await stopService(ctx.control, ctx.stopTimeoutMs);
      for (const step of undo.reverse()) await step();
      if (wasLoaded) await startService(ctx.control);
    } catch (undoError) {
      throw new LifecycleError(`${reason} / ${say("원래대로 돌리지도 못했습니다", "putting things back failed too")}: ${undoError instanceof Error ? undoError.message : String(undoError)}`);
    }
    throw new RollbackKept(say(`되돌리기가 실패해 바꾼 것을 모두 원래대로 돌렸습니다${wasLoaded ? "(서비스도 다시 올렸습니다)" : ""}. 이유: ${reason}`,
      `The rollback failed, so everything it changed was put back${wasLoaded ? " (and the service was started again)" : ""}. Reason: ${reason}`));
  }
}

/**
 * 켜 둔 HTTPS 주소(tailscale serve)를 판을 바꾸기 전에 끈다. 되돌리는 판(rollback, 낮은 판으로의 upgrade)은 HTTPS 이전 판일 수 있고,
 * 그 판은 serve 를 거친 tailnet 기기의 요청을 이 Mac(127.0.0.1)의 요청으로 보아 접속 코드 교체·모두 끊기를 기기 열쇠로 받아 준다.
 * 끄지 못하면 바꾸지 않고 멈춘다. 앞으로 가는 upgrade 와 그 자동 되돌리기(켤 때 쓰던 판으로 돌아간다)는 끄지 않는다.
 */
async function turnOffHttpsBeforeGoingBack(ctx: Context, inst: Installation, config: Config, what: string): Promise<void> {
  const off = await turnOffTailnetHttps(config, inst.home, { fetch: ctx.fetch, ...(ctx.tailscale ? { run: ctx.tailscale } : {}), log: ctx.log });
  if (off.state === "failed") {
    throw new LifecycleError(say(`HTTPS 주소를 끄지 못해 ${what} 않았습니다(${off.detail ?? "?"}). 설정 → 연결 → HTTPS 주소에서 끄거나 터미널에서 ${TAILNET_SERVE_OFF_COMMAND} 로 끈 뒤 다시 실행하세요.`,
      `Could not turn off the HTTPS address (${off.detail ?? "?"}), so nothing was changed. Turn it off in Settings › Connection › HTTPS address or in Terminal with ${TAILNET_SERVE_OFF_COMMAND}, then run this again.`));
  }
  if (off.state === "off") ctx.log(say("HTTPS 주소(tailscale serve)를 껐습니다. 바꾼 뒤 다시 쓰려면 설정 → 연결 → HTTPS 주소에서 켜세요.",
    "Turned off the HTTPS address (tailscale serve). To use it again afterwards, turn it on in Settings › Connection › HTTPS address."));
}

/** 되돌리기 미리 보기·계획의 HTTPS 한 줄. 켠 기록이 있을 때만. */
function httpsPlanLine(inst: Installation): string | null {
  return savedTailnetHttps(inst.home) ? say("  · 켜 둔 HTTPS 주소(tailscale serve)는 바꾸기 전에 끕니다(되돌린 판이 그 주소로 온 요청을 이 Mac 의 요청으로 볼 수 있어서입니다). 다시 올린 뒤 설정 → 연결 → HTTPS 주소에서 켜세요.",
    "  · The HTTPS address (tailscale serve) is turned off before switching (the older build may treat requests through it as coming from this Mac). Turn it on again afterwards in Settings › Connection › HTTPS address.") : null;
}

/** 교체 뒤 새 판이 뜨지 않았다. 직전 판으로 돌리고 무엇을 했는지 오류로 알린다. */
async function autoRollback(record: UpgradeRecord, inst: Installation, ctx: Context, config: Config, timeoutMs: number, reason: string): Promise<never> {
  ctx.log(say(`새 판이 준비되지 않았습니다(${reason}). 직전 판 ${record.from.version} 으로 되돌립니다.`, `The new build was not ready (${reason}). Rolling back to ${record.from.version}.`));
  try {
    const restored = await rollBack(record, inst, ctx, config, timeoutMs);
    save(record, { phase: "rolled_back", rolledBackAt: ctx.now().toISOString(), error: reason });
    throw new LifecycleError(say(
      `업그레이드하지 못해 직전 판 ${record.from.version} 으로 되돌렸습니다${restored ? "(DB 도 업그레이드 전 사본으로 되돌렸습니다)" : ""}. 이유: ${reason}. 기록: ${upgradeDir(inst.home, record.id)}`,
      `The upgrade failed and was rolled back to ${record.from.version}${restored ? " (the database was restored from the pre-upgrade copy)" : ""}. Reason: ${reason}. Record: ${upgradeDir(inst.home, record.id)}`));
  } catch (error) {
    if (error instanceof LifecycleError && record.phase === "rolled_back") throw error;
    const detail = error instanceof Error ? error.message : String(error);
    // 자동 되돌리기가 실패했지만 바꾼 것은 모두 원래대로다. 기록은 그대로라 iamceo rollback 으로 다시 되돌릴 수 있다.
    if (error instanceof RollbackKept) {
      throw new LifecycleError(say(
        `새 판이 준비되지 않았고(${reason}), 자동 되돌리기도 끝내지 못해 새 판을 그대로 두었습니다(${detail}). 원인을 고친 뒤 iamceo rollback 으로 다시 되돌릴 수 있습니다. 기록 ${upgradeDir(inst.home, record.id)}, 로그 ${join(inst.home, "logs")}`,
        `The new build was not ready (${reason}) and the automatic rollback did not finish either, so the new build was left in place (${detail}). Fix the cause, then iamceo rollback can try again. Record ${upgradeDir(inst.home, record.id)}, logs ${join(inst.home, "logs")}`));
    }
    try { save(record, { phase: "rollback_failed", error: `${reason} / ${detail}` }); } catch { /* 기록 실패는 아래 안내로 대신한다 */ }
    throw new LifecycleError(say(
      `업그레이드도, 자동 되돌리기도 끝내지 못했습니다(${detail}). 직접 확인할 것: 기록 ${upgradeDir(inst.home, record.id)}, 로그 ${join(inst.home, "logs")}`,
      `Both the upgrade and the automatic rollback failed (${detail}). Check the record ${upgradeDir(inst.home, record.id)} and the logs in ${join(inst.home, "logs")}`));
  }
}

async function upgradeRelease(inst: Extract<Installation, { kind: "release" }>, options: UpgradeOptions, ctx: Context): Promise<UpgradeOutcome> {
  if (options.target) throw new LifecycleError(say("설치판은 커밋이 아니라 --version 으로 올립니다", "An installed app is upgraded with --version, not a commit"));
  const cask = ctx.brewCaskrooms.find(path => existsSync(path));
  if (cask && !options.force) throw new LifecycleError(say("Homebrew 로 설치한 앱입니다. brew upgrade --cask iamceo 로 올리세요(그래야 Homebrew 기록과 맞습니다).",
    "This app was installed with Homebrew. Upgrade it with brew upgrade --cask iamceo so Homebrew stays in sync."));
  const source = releaseSource({ from: options.from, version: options.version, env: ctx.env });
  const current = probe(ctx, [inst.daemon], "version");
  let timeoutMs = options.timeoutMs ?? 120_000;
  if (options.dryRun) {
    for (const line of [
      say(`설치판 업그레이드 미리 보기 (지금 ${current})`, `Installed-app upgrade preview (now ${current})`),
      say(`  1. 받기·확인: ${source.base} 의 SHA256SUMS·DMG, 서명·공증 확인`, `  1. Download and verify: SHA256SUMS and DMG from ${source.base}, signature and notarization`),
      say(`  2. 새 판으로 DB 사본 미리 돌려 보기: ${join(inst.home, "iamceo.db")} (원본은 읽기만)`, `  2. Rehearse the new build on a copy of ${join(inst.home, "iamceo.db")} (the original is only read)`),
      say(`  3. 직전 판 기록: ${join(inst.home, "upgrades")}/<id>/ (plist·DB 사본·이전 앱)`, `  3. Record the previous build in ${join(inst.home, "upgrades")}/<id>/ (plist, database copy, previous app)`),
      say(`  4. 서비스 내림 → ${inst.app} 교체 → 올림 → ${Math.round(timeoutMs / 1000)}초 안에 준비 확인, 아니면 직전 판으로 되돌림`, `  4. Stop the service, replace ${inst.app}, start it, wait ${Math.round(timeoutMs / 1000)} s for readiness or roll back`),
      ...(options.allowDowngrade && savedTailnetHttps(inst.home) ? [say("  · 지금보다 낮은 판이면 켜 둔 HTTPS 주소(tailscale serve)를 바꾸기 전에 끕니다. 다시 올린 뒤 설정 → 연결 → HTTPS 주소에서 켜세요.",
        "  · If the build is older than the current one, the HTTPS address (tailscale serve) is turned off before switching. Turn it on again afterwards in Settings › Connection › HTTPS address.")] : []),
    ]) ctx.log(line);
    return { status: "dry_run", mode: "release", from: current, to: source.version ?? "latest" };
  }
  if (ctx.appRunning()) throw new LifecycleError(say("IAMCEO 앱을 종료한 뒤 다시 실행하세요. 실행 중인 앱은 바꾸지 않습니다.", "Quit the IAMCEO app and run this again. A running app is never replaced."));
  const config = serviceConfig(inst, ctx);
  const id = newUpgradeId(ctx.now()), dir = upgradeDir(inst.home, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const staged = await stageRelease(source, join(dirname(inst.app), `.iamceo-upgrade-${id}`), { tools: ctx.releaseTools, fetch: ctx.fetch, scratch: ctx.scratch, log: ctx.log })
    .catch(error => { rmSync(dir, { recursive: true, force: true }); throw error; });
  let record: UpgradeRecord | undefined;
  try {
    const order = compareVersions(staged.version, current);
    if (order === 0 && !options.force) {
      ctx.log(say(`이미 ${current} 입니다. 바꾸지 않았습니다.`, `Already ${current}. Nothing was changed.`));
      staged.cleanup(); rmSync(dir, { recursive: true, force: true });
      return { status: "current", mode: "release", from: current, to: current };
    }
    if (order < 0 && !options.allowDowngrade) throw new LifecycleError(say(`받은 판(${staged.version})이 지금 판(${current})보다 낮습니다. 직전 판으로 돌아가려면 iamceo rollback 을 쓰세요.`,
      `The downloaded build (${staged.version}) is older than the current one (${current}). Use iamceo rollback to return to the previous build.`));
    // 낮은 판은 HTTPS 이전 판일 수 있다. 켜 둔 HTTPS 주소를 먼저 끈다(끄지 못하면 바꾸지 않는다).
    if (order < 0) await turnOffHttpsBeforeGoingBack(ctx, inst, config, say("낮은 판으로 바꾸지", "downgrade"));
    const daemon = join(staged.app, "Contents", "Resources", "runtime", "iamceo");
    if (probe(ctx, [daemon], "version") !== staged.version) throw new LifecycleError(say("받은 앱의 서버가 다른 버전을 답합니다", "The server inside the downloaded app reports a different version"));
    const newBuild = probe(ctx, [daemon], "build-id"), oldBuild = probe(ctx, [inst.daemon], "build-id");
    if (!options.skipRehearsal) {
      ctx.log(say("새 판으로 DB 사본을 미리 돌려 보는 중입니다(원본은 읽기만 합니다)", "Rehearsing the new build on a copy of the database (the original is only read)"));
      const result = await ctx.rehearse({ command: [daemon], source: join(inst.home, "iamceo.db"), timeoutMs: 600_000 });
      if (!result.ok) throw new LifecycleError(say(`미리 돌려 보기가 실패해 아무것도 바꾸지 않았습니다: ${describeRehearsal(result)}`, `The rehearsal failed, so nothing was changed: ${describeRehearsal(result)}`));
      ctx.log(say(`미리 돌려 보기 통과${result.startupMs !== null ? ` (기동 ${Math.round(result.startupMs)}ms)` : ""}`, `Rehearsal passed${result.startupMs !== null ? ` (startup ${Math.round(result.startupMs)} ms)` : ""}`));
      timeoutMs = readinessBudget(timeoutMs, result.startupMs);
    }
    record = {
      format: 1, id, mode: "release", phase: "prepared", startedAt: ctx.now().toISOString(), home: inst.home,
      from: { version: current, buildId: oldBuild, schemaVersion: null }, to: { version: staged.version, buildId: newBuild },
      plist: join(dir, "com.iamceo.server.plist"), database: null, installedApp: inst.app,
    };
    copyFileSync(inst.plist.path, record.plist);
    saveUpgradeRecord(record);
  } catch (error) {
    staged.cleanup();
    if (!record) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  // 여기서부터 서비스를 바꾼다.
  ctx.log(say(`서비스를 내리고 ${current} → ${staged.version} 으로 바꿉니다`, `Stopping the service and replacing ${current} with ${staged.version}`));
  try {
    await stopService(ctx.control, ctx.stopTimeoutMs);
    save(record, { phase: "stopped" });
    const schema = await snapshotStopped(ctx, inst, join(dir, "iamceo.db"));
    save(record, { database: schema === null ? null : join(dir, "iamceo.db"), from: { ...record.from, schemaVersion: schema } });
    const previous = join(dir, "previous.app");
    moveBundle(inst.app, previous);
    save(record, { previousApp: previous });
    try { moveBundle(staged.app, inst.app); }
    catch (error) { moveBundle(previous, inst.app); save(record, { previousApp: undefined }); throw error; }
    save(record, { phase: "replaced" });
  } catch (error) {
    // 아직 새 판을 띄우지 않았다. 원래 판을 다시 올리고 멈춘다.
    staged.cleanup();
    save(record, { phase: "aborted", error: error instanceof Error ? error.message : String(error) });
    try { await startService(ctx.control); } catch { /* 아래 오류와 함께 알린다 */ }
    throw error;
  }
  staged.cleanup();
  try {
    await startService(ctx.control);
    save(record, { phase: "started" });
    await ctx.readiness(config, { buildId: record.to.buildId, version: record.to.version }, timeoutMs);
  } catch (error) {
    return autoRollback(record, inst, ctx, config, timeoutMs, error instanceof Error ? error.message : String(error));
  }
  save(record, { phase: "done", finishedAt: ctx.now().toISOString() });
  pruneUpgradeRecords(inst.home);
  ctx.log(say(`업그레이드했습니다: ${current} → ${record.to.version}. 문제가 있으면 iamceo rollback 으로 직전 판으로 돌아갑니다.`,
    `Upgraded ${current} → ${record.to.version}. If something is wrong, iamceo rollback returns to the previous build.`));
  return { status: "upgraded", mode: "release", from: current, to: record.to.version, id };
}

async function upgradeGit(inst: Extract<Installation, { kind: "git" }>, options: UpgradeOptions, ctx: Context): Promise<UpgradeOutcome> {
  if (options.version || options.from) throw new LifecycleError(say("git 체크아웃에서 도는 서버는 커밋으로 올립니다: iamceo upgrade <커밋>", "A server running from a git checkout is upgraded to a commit: iamceo upgrade <commit>"));
  if (!options.target) throw new LifecycleError(say("올릴 커밋을 적어 주세요: iamceo upgrade <커밋>", "Name the commit to upgrade to: iamceo upgrade <commit>"));
  const top = gitOrFail(ctx, inst.checkout, "rev-parse", "--show-toplevel");
  if (realpathSync(top) !== realpathSync(inst.checkout)) throw new LifecycleError(say(`서비스가 실행하는 폴더가 git 체크아웃의 맨 위가 아닙니다: ${inst.checkout}`, `The service does not run from the top of a git checkout: ${inst.checkout}`));
  const target = gitOrFail(ctx, inst.checkout, "rev-parse", "--verify", "--end-of-options", `${options.target}^{commit}`);
  const old = gitOrFail(ctx, inst.checkout, "rev-parse", "HEAD");
  const current = JSON.parse(readFileSync(join(inst.checkout, "package.json"), "utf8")).version as string;
  if (target === old) {
    ctx.log(say(`이미 ${old.slice(0, 12)} 입니다. 바꾸지 않았습니다.`, `Already at ${old.slice(0, 12)}. Nothing was changed.`));
    return { status: "current", mode: "git", from: old, to: target };
  }
  if (git(ctx, inst.checkout, "merge-base", "--is-ancestor", old, target).code !== 0) {
    throw new LifecycleError(say(`${target.slice(0, 12)} 은 지금 커밋(${old.slice(0, 12)})에서 앞으로 가는 커밋이 아닙니다. 뒤로 돌아가려면 iamceo rollback 을 쓰세요.`,
      `${target.slice(0, 12)} is not ahead of the current commit (${old.slice(0, 12)}). To go back, use iamceo rollback.`));
  }
  if (gitOrFail(ctx, inst.checkout, "status", "--porcelain", "--untracked-files=no")) throw new LifecycleError(say("체크아웃에 커밋하지 않은 변경이 있습니다. 정리한 뒤 다시 실행하세요.", "The checkout has uncommitted changes. Clean it up and run again."));
  const next = JSON.parse(gitOrFail(ctx, inst.checkout, "show", `${target}:package.json`)).version as string;
  const command = [inst.bun, inst.entry];
  let timeoutMs = options.timeoutMs ?? 120_000;
  if (options.dryRun) {
    for (const line of [
      say(`git 체크아웃 업그레이드 미리 보기: ${inst.checkout} ${old.slice(0, 12)} → ${target.slice(0, 12)}`, `Git checkout upgrade preview: ${inst.checkout} ${old.slice(0, 12)} → ${target.slice(0, 12)}`),
      say(`  1. 직전 판 기록: ${join(inst.home, "upgrades")}/<id>/ (old-rev·plist·DB 사본)`, `  1. Record the previous build in ${join(inst.home, "upgrades")}/<id>/ (old rev, plist, database copy)`),
      say("  2. 서비스 내림 → DB 사본(무결성 검사) → git reset --keep → bun install --frozen-lockfile", "  2. Stop the service, copy the database (integrity checked), git reset --keep, bun install --frozen-lockfile"),
      say("  3. 새 코드로 DB 사본 미리 돌려 보기 → 실패하면 이전 커밋으로 되돌리고 다시 올림", "  3. Rehearse the new code on the database copy; on failure return to the old commit and restart"),
      say(`  4. 서비스 올림 → ${Math.round(timeoutMs / 1000)}초 안에 /api/readiness 확인, 아니면 직전 판으로 되돌림`, `  4. Start the service and wait ${Math.round(timeoutMs / 1000)} s for /api/readiness, or roll back`),
    ]) ctx.log(line);
    return { status: "dry_run", mode: "git", from: old, to: target };
  }
  const config = serviceConfig(inst, ctx);
  const oldBuild = probe(ctx, command, "build-id", inst.checkout);
  const id = newUpgradeId(ctx.now()), dir = upgradeDir(inst.home, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record: UpgradeRecord = {
    format: 1, id, mode: "git", phase: "prepared", startedAt: ctx.now().toISOString(), home: inst.home,
    from: { version: current, buildId: oldBuild, rev: old, schemaVersion: null }, to: { version: next, buildId: null, rev: target },
    plist: join(dir, "com.iamceo.server.plist"), database: null, checkout: inst.checkout,
  };
  copyFileSync(inst.plist.path, record.plist);
  saveUpgradeRecord(record);
  ctx.log(say(`서비스를 내리고 ${old.slice(0, 12)} → ${target.slice(0, 12)} 로 옮깁니다`, `Stopping the service and moving ${old.slice(0, 12)} → ${target.slice(0, 12)}`));
  try {
    await stopService(ctx.control, ctx.stopTimeoutMs);
    save(record, { phase: "stopped" });
    const schema = await snapshotStopped(ctx, inst, join(dir, "iamceo.db"));
    save(record, { database: schema === null ? null : join(dir, "iamceo.db"), from: { ...record.from, schemaVersion: schema } });
    gitOrFail(ctx, inst.checkout, "reset", "--keep", target);
  } catch (error) {
    save(record, { phase: "aborted", error: error instanceof Error ? error.message : String(error) });
    try { await startService(ctx.control); } catch { /* 아래 오류와 함께 알린다 */ }
    throw error;
  }
  save(record, { phase: "replaced" });
  let reason: string | null = null;
  try {
    bunInstall(ctx, inst);
    if (!options.skipRehearsal && record.database) {
      ctx.log(say("새 코드로 DB 사본을 미리 돌려 보는 중입니다", "Rehearsing the new code on the database copy"));
      const result = await ctx.rehearse({ command, cwd: inst.checkout, source: record.database, timeoutMs: 600_000 });
      if (!result.ok) reason = say(`미리 돌려 보기 실패: ${describeRehearsal(result)}`, `rehearsal failed: ${describeRehearsal(result)}`);
      else timeoutMs = readinessBudget(timeoutMs, result.startupMs);
    }
    if (reason === null) {
      save(record, { to: { ...record.to, buildId: probe(ctx, command, "build-id", inst.checkout) } });
      await startService(ctx.control);
      save(record, { phase: "started" });
      await ctx.readiness(config, { buildId: record.to.buildId, version: next }, timeoutMs);
    }
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  if (reason !== null) return autoRollback(record, inst, ctx, config, timeoutMs, reason);
  save(record, { phase: "done", finishedAt: ctx.now().toISOString() });
  pruneUpgradeRecords(inst.home);
  ctx.log(say(`업그레이드했습니다: ${old.slice(0, 12)} → ${target.slice(0, 12)} (${next}). 되돌리려면 iamceo rollback.`,
    `Upgraded ${old.slice(0, 12)} → ${target.slice(0, 12)} (${next}). To go back: iamceo rollback.`));
  return { status: "upgraded", mode: "git", from: old, to: target, id };
}

export async function upgrade(options: UpgradeOptions, deps: LifecycleDeps = {}): Promise<UpgradeOutcome> {
  const ctx = context(deps, options.dryRun === true);
  const inst = loadInstallation(ctx);
  return inst.kind === "release" ? upgradeRelease(inst, options, ctx) : upgradeGit(inst, options, ctx);
}

/** 기록의 시각(끝난 시각, 없으면 시작 시각)을 사람이 읽는 모양으로. */
function recordTime(record: UpgradeRecord): string {
  const at = record.finishedAt ?? record.startedAt;
  return at.replace("T", " ").replace(/\.\d{3}Z$|Z$/, " UTC");
}

/**
 * 되돌리기 전에 지금 도는 판이 그 기록이 만든 판인지 대조한다. 기록 뒤에 다른 방법(DMG·설치 스크립트·직접 git)으로 판이 바뀌었으면
 * 그 기록으로 되돌리면 여러 판을 건너뛰고 오래된 DB 사본을 쓰게 되므로 거절한다. 돌려주는 값은 지금 판을 사람이 읽는 이름.
 * 도중에 멈춘 기록(stopped)은 교체 전이거나 교체 직후일 수 있어 두 판을 모두 받는다.
 */
function verifyRunningBuild(record: UpgradeRecord, inst: Installation, ctx: Context): string {
  const midway = record.phase === "stopped";
  let label: string, matches: boolean;
  if (inst.kind === "git") {
    const head = gitOrFail(ctx, inst.checkout, "rev-parse", "HEAD");
    let version = "?";
    try { version = JSON.parse(readFileSync(join(inst.checkout, "package.json"), "utf8")).version ?? "?"; } catch { /* 이름에만 쓴다 */ }
    label = `${head.slice(0, 12)} (${version})`;
    matches = head === record.to.rev || (midway && head === record.from.rev);
  } else {
    const installed = record.installedApp ?? inst.app;
    const daemon = join(installed, "Contents", "Resources", "runtime", "iamceo");
    let build: string | null = null, version: string | null = null;
    if (existsSync(daemon)) {
      try { build = probe(ctx, [daemon], "build-id"); } catch { build = null; }
      try { version = probe(ctx, [daemon], "version"); } catch { version = null; }
    }
    label = version ?? (existsSync(installed) ? "?" : say("앱 없음", "no app"));
    matches = build !== null
      ? build === record.to.buildId || (midway && build === record.from.buildId)
      : midway && !existsSync(installed) && !!record.previousApp && existsSync(record.previousApp);
  }
  if (!matches) {
    throw new LifecycleError(say(
      `기록된 업그레이드(${recordTime(record)}, ${record.from.version} → ${record.to.version}) 뒤에 다른 방법으로 판이 바뀌었습니다. 지금 판: ${label}. 여러 판을 건너뛰어 되돌리거나 오래된 DB 사본을 쓰지 않도록 아무것도 바꾸지 않았습니다.`,
      `The build was changed some other way after the recorded upgrade (${recordTime(record)}, ${record.from.version} → ${record.to.version}). Running now: ${label}. Nothing was changed, so you do not skip several builds back or get an old database copy.`));
  }
  return label;
}

export async function rollback(options: { dryRun?: boolean; yes?: boolean; timeoutMs?: number }, deps: LifecycleDeps = {}): Promise<RollbackOutcome> {
  const ctx = context(deps, options.dryRun === true);
  const inst = loadInstallation(ctx);
  const record = latestRollbackTarget(inst.home);
  if (!record) throw new LifecycleError(say("되돌릴 업그레이드 기록이 없습니다", "There is no upgrade to roll back"));
  if (record.mode !== inst.kind) throw new LifecycleError(say("기록된 업그레이드와 지금 설치 방식이 달라 되돌리지 않았습니다", "The recorded upgrade does not match this installation; nothing was changed"));
  // 내리기만 하고 멈춘 기록(stopped)은 앱을 아직 바꾸지 않았다. 다시 올리기만 하면 된다.
  if (inst.kind === "release" && record.phase !== "stopped" && (!record.previousApp || !existsSync(record.previousApp))) {
    throw new LifecycleError(say(`직전 앱이 보관된 자리에 없습니다: ${record.previousApp ?? "(기록 없음)"}`, `The previous app is missing from ${record.previousApp ?? "(not recorded)"}`));
  }
  if (inst.kind === "git" && (!record.from.rev || git(ctx, inst.checkout, "cat-file", "-e", `${record.from.rev}^{commit}`).code !== 0)) {
    throw new LifecycleError(say("직전 커밋을 체크아웃에서 찾지 못했습니다", "The previous commit is not in the checkout"));
  }
  const running = verifyRunningBuild(record, inst, ctx);
  const live = join(inst.home, "iamceo.db");
  const schema = existsSync(live) ? databaseSchema(live) : null;
  const needsDatabase = !!record.database && record.from.schemaVersion !== null && schema !== null && schema > record.from.schemaVersion;
  const label = record.mode === "git" ? `${record.from.rev?.slice(0, 12)} (${record.from.version})` : record.from.version;
  ctx.log(say(`직전 판으로 되돌립니다: 지금 ${running} → ${label} (업그레이드 기록 ${recordTime(record)})`, `Rolling back: now ${running} → ${label} (upgrade recorded ${recordTime(record)})`));
  if (needsDatabase) ctx.log(say(
    `DB 스키마가 올라가 있어(${record.from.schemaVersion} → ${schema}) 업그레이드 전 DB 사본으로 되돌립니다. 업그레이드 뒤 쌓인 대화·결재는 지우지 않고 ${upgradeDir(inst.home, record.id)} 안에 옆 사본으로 남깁니다(오래된 업그레이드 기록을 정리할 때도 지우지 않습니다).`,
    `The database schema moved up (${record.from.schemaVersion} → ${schema}), so the pre-upgrade copy is restored. Conversations and decisions made after the upgrade are kept aside in ${upgradeDir(inst.home, record.id)} (old upgrade records are cleaned up without touching it).`));
  const httpsLine = httpsPlanLine(inst);
  if (httpsLine) ctx.log(httpsLine);
  if (options.dryRun) return { status: "dry_run", mode: inst.kind, from: record.to.version, to: record.from.version, id: record.id, databaseRestored: needsDatabase };
  if (needsDatabase && !options.yes) throw new LifecycleError(say("DB 까지 되돌리려면 --yes 를 붙여 다시 실행하세요", "Run again with --yes to roll back the database as well"));
  if (inst.kind === "release" && ctx.appRunning()) throw new LifecycleError(say("IAMCEO 앱을 종료한 뒤 다시 실행하세요. 실행 중인 앱은 바꾸지 않습니다.", "Quit the IAMCEO app and run this again. A running app is never replaced."));
  const config = serviceConfig(inst, ctx);
  // 직전 판은 HTTPS 이전 판일 수 있다. 켜 둔 HTTPS 주소를 먼저 끈다(지금 도는 서버가 끈다. 끄지 못하면 되돌리지 않는다).
  if (httpsLine) await turnOffHttpsBeforeGoingBack(ctx, inst, config, say("되돌리지", "roll back"));
  let restored: boolean;
  try { restored = await rollBack(record, inst, ctx, config, options.timeoutMs ?? 120_000); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // 바꾼 것이 모두 원래대로라면 기록을 그대로 두어 다시 되돌릴 수 있게 한다.
    if (error instanceof RollbackKept) {
      throw new LifecycleError(say(`${detail}. 기록은 그대로라 원인을 고친 뒤 다시 iamceo rollback 할 수 있습니다. 로그: ${join(inst.home, "logs")}`,
        `${detail}. The record is unchanged, so you can run iamceo rollback again once the cause is fixed. Logs: ${join(inst.home, "logs")}`));
    }
    save(record, { phase: "rollback_failed", error: detail });
    throw new LifecycleError(say(`되돌리기를 끝내지 못했습니다(${detail}). 직접 확인할 것: 기록 ${upgradeDir(inst.home, record.id)}, 로그 ${join(inst.home, "logs")}`,
      `The rollback did not finish (${detail}). Check the record ${upgradeDir(inst.home, record.id)} and the logs in ${join(inst.home, "logs")}`));
  }
  save(record, { phase: "rolled_back", rolledBackAt: ctx.now().toISOString() });
  const kept = keptAsideCopies(inst.home, record.id).filter(path => path.includes("after-upgrade-"));
  ctx.log(say(`되돌렸습니다: 지금 ${label}${restored && kept.length ? `. 업그레이드 뒤의 DB 사본: ${kept.at(-1)}` : ""}`,
    `Rolled back: now ${label}${restored && kept.length ? `. Database from after the upgrade: ${kept.at(-1)}` : ""}`));
  return { status: "rolled_back", mode: inst.kind, from: record.to.version, to: record.from.version, id: record.id, databaseRestored: restored };
}
