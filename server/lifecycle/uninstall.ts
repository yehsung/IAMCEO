// `iamceo uninstall` 과 Mac 앱의 '이 Mac에서 완전히 멈추기'.
// 순서: (켜 둔) HTTPS 주소 끄기 → 팀장 재우기(서버가 떠 있으면 기존 안전 종료 경로로) → 서비스 해제(서버가 내려간다) → 실행 엔진의 터미널 종료와 엔진 종료 → (원하면) 데이터 삭제.
// HTTPS 주소(tailscale serve)는 tailscaled 에 남으므로 서버를 내리기 전에 끈다(tailnet-off.ts). 끄지 못하면 남은 명령을 알리고 계속한다.
// 실행 엔진을 서비스보다 먼저 끄면 떠 있는 서버가 엔진을 다시 띄우므로, 서비스를 먼저 내린다.
// 데이터는 기본으로 남긴다. 지우기(--purge)는 따로 한 번 더 확인한다.
// 이 명령이 내리는 서비스는 앱 묶음 안의 실행 파일로 등록된 설치판(같은 데이터 폴더)뿐이다. 소스 체크아웃에서 도는 서버(대표 라이브)는
// --include-checkout 을 붙였을 때만 내리고, 그때도 서비스 설정을 지우지 않고 사본을 남긴다. 끌 수 없는 서버가 떠 있으면 아무것도 하지 않는다.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { say } from "../cli-text.ts";
import { homeDir, loadConfig, type Config } from "../config.ts";
import { acquireHomeOwner, HomeOwnershipError, normalizeHome } from "../home-owner.ts";
import { CoreError, coreRpc } from "../runner/core-client.ts";
import {
  detectInstallation, LifecycleError, readServicePlist, realLaunchctl, serviceDomain, serviceHome, servicePlistPath, serviceLoaded, stopService,
  type Launchctl, type ServiceControl, type ServicePlist,
} from "./launchd.ts";
import { databaseSchema, localBase } from "./runtime.ts";
import { savedTailnetHttps, TAILNET_SERVE_OFF_COMMAND, turnOffTailnetHttps } from "./tailnet-off.ts";
import type { TailscaleRunner } from "../tailnet-https.ts";

export interface CoreTerminalInfo { address: string; state: string; labels?: Record<string, string> }
/** 실행 엔진(herdr-core)과 말하는 길. 시험은 가짜 소켓·가짜 실행 파일을 쓴다. */
export interface CoreControl {
  /** 소켓이 있고 엔진이 답하는가. */
  answers(): Promise<boolean>;
  terminals(): Promise<CoreTerminalInfo[]>;
  kill(address: string): Promise<void>;
  /** 엔진을 끈다. 실행 파일을 찾지 못하면 false. */
  stop(): Promise<boolean>;
}

export interface UninstallOptions {
  purge?: boolean; yes?: boolean; dryRun?: boolean;
  /** 소스 체크아웃(bun + bin/iamceo.ts)에서 도는 서비스도 내린다. 서비스 설정은 지우지 않고 사본을 남긴다. */
  includeCheckout?: boolean;
}
export interface UninstallDeps {
  launchctl?: Launchctl;
  userHome?: string;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<unknown>;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  core?: CoreControl;
  /** 사람에게 묻는다. 없으면 터미널에서 묻고, 터미널이 아니면 --yes 를 요구한다. */
  confirm?: (question: string, answer: string) => Promise<boolean>;
  /** 서버가 내려가기를 기다리는 시간. */
  stopTimeoutMs?: number;
  /** 서버가 답하지 않을 때 HTTPS 주소를 끄는 tailscale(시험은 가짜). */
  tailscale?: TailscaleRunner;
}

export interface UninstallOutcome {
  home: string;
  members: { reachable: boolean; stopped: number; failed: string[] };
  service: "removed" | "absent" | "foreign";
  /** 소스 체크아웃 서비스를 내렸을 때 남긴 서비스 설정 사본. */
  serviceCopy?: string;
  core: { absent: boolean; killed: number; stopped: boolean };
  purged: boolean;
  /** Tailscale 의 HTTPS 주소(tailscale serve). none: 켠 기록 없음, off: 껐다, failed: 끄지 못했다(남은 명령을 알렸다). */
  tailnetHttps: "none" | "off" | "failed";
}

export function defaultCoreControl(socket: string, coreBin: string | null, home: string): CoreControl {
  return {
    async answers() {
      if (!existsSync(socket)) return false;
      try { await coreRpc(socket, "hello", { generation: 1 }, 1_500); return true; }
      catch (error) { return !(error instanceof CoreError && error.deliveryEffect === "not_written"); }
    },
    async terminals() {
      const result = await coreRpc<{ terminals?: CoreTerminalInfo[] }>(socket, "terminal.list", {}, 8_000);
      return Array.isArray(result.terminals) ? result.terminals : [];
    },
    async kill(address) { await coreRpc(socket, "terminal.kill", { terminal: address }, 15_000); },
    async stop() {
      if (!coreBin) return false;
      const child = Bun.spawn([coreBin, "server", "stop"], {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? homedir(), HC_SOCKET: socket, HC_SESSION: "iamceo",
          XDG_STATE_HOME: join(home, "core-state"), XDG_CONFIG_HOME: join(home, "core-config") },
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try { return (await child.exited) === 0; } finally { clearTimeout(timer); }
    },
  };
}

async function askOnTerminal(question: string, answer: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new LifecycleError(say("확인할 수 없는 환경입니다. 그대로 진행하려면 --yes 를 붙이세요.", "Cannot ask for confirmation here. Add --yes to proceed."));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const reply = await new Promise<string>(resolve => rl.question(`${question} `, resolve));
    return reply.trim() === answer;
  } finally { rl.close(); }
}

/**
 * 등록된 서비스가 이 명령이 내려도 되는 것인가.
 * - release: 앱 묶음 안의 실행 파일을 serve 로 돌리고 같은 데이터 폴더를 쓴다(앱이 직접 관리하는 설치판). 앱의 LocalHostService·Homebrew 의
 *   service_cleanup 과 같은 판정이다.
 * - git: 소스 체크아웃에서 도는 서버. --include-checkout 일 때만 내린다.
 * - other: 알아볼 수 없는 설치(옛 명령줄 설치 등)나 다른 프로그램. 내리지 않는다.
 * sameHome 은 그 서비스가 이 명령의 데이터 폴더를 쓰는가(같은 실행 엔진을 쓴다는 뜻).
 */
export interface ServiceOwnership { kind: "release" | "git" | "other"; sameHome: boolean; owned: boolean }
export function serviceOwnership(plist: ServicePlist, home: string, userHome: string, includeCheckout = false): ServiceOwnership {
  let kind: ServiceOwnership["kind"] = "other";
  try { kind = detectInstallation(plist, userHome).kind; } catch { kind = "other"; }
  let sameHome = false;
  try { sameHome = normalizeHome(serviceHome(plist, userHome)) === normalizeHome(home); } catch { sameHome = false; }
  return { kind, sameHome, owned: sameHome && (kind === "release" || (kind === "git" && includeCheckout)) };
}

function stampNow(): string { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }

/** 기본이 아닌 데이터 폴더는 터미널에서 경로를 그대로 입력해야 지운다. 물을 수 없는 환경(앱 등)이면 지우지 않는다. */
async function confirmUnusualHome(confirm: UninstallDeps["confirm"], home: string): Promise<boolean> {
  const question = say(`이 데이터 폴더는 기본 자리(~/.iamceo)도, 등록된 서비스의 폴더도 아닙니다. 정말 지우려면 경로를 그대로 입력하세요(${home}):`,
    `This data folder is neither the usual place (~/.iamceo) nor the registered service's folder. To delete it anyway, type its path exactly (${home}):`);
  if (confirm) return confirm(question, home);
  if (!process.stdin.isTTY) return false;
  return askOnTerminal(question, home);
}

type Json = Record<string, unknown>;
async function call(config: Config, fetchImpl: typeof fetch, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; body: Json | null }> {
  const response = await fetchImpl(`${localBase(config)}${path}`, {
    method: init.method ?? "GET", redirect: "error", signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    headers: { Authorization: `Bearer ${config.accessCode}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) as Json | null };
}

/** 서버가 떠 있으면 관리하는 팀장을 모두 재운다. 직접 띄운 세션은 IAMCEO 의 프로세스가 아니라 건드리지 않는다. */
async function sleepMembers(config: Config, fetchImpl: typeof fetch): Promise<UninstallOutcome["members"]> {
  let projects: { id: string }[];
  try {
    const boot = await call(config, fetchImpl, "/api/bootstrap");
    if (boot.status !== 200 || !Array.isArray(boot.body?.projects)) return { reachable: false, stopped: 0, failed: [] };
    projects = boot.body.projects as { id: string }[];
  } catch { return { reachable: false, stopped: 0, failed: [] }; }
  let stopped = 0;
  const failed: string[] = [];
  for (const project of projects) {
    let members: { id: string; name?: string; origin?: string; status?: string }[] = [];
    try {
      const state = await call(config, fetchImpl, `/api/projects/${encodeURIComponent(project.id)}/state`, { timeoutMs: 30_000 });
      if (state.status === 200 && Array.isArray(state.body?.members)) members = state.body.members as typeof members;
    } catch { failed.push(project.id); continue; }
    for (const member of members) {
      if (member.origin === "manual" || member.status === "asleep") continue;
      try {
        const result = await call(config, fetchImpl, `/api/members/${encodeURIComponent(member.id)}/sleep`, { method: "POST", body: { force: true }, timeoutMs: 60_000 });
        if (result.status === 200) stopped++;
        else failed.push(`${member.name ?? member.id}: ${typeof result.body?.error === "string" ? result.body.error : `HTTP ${result.status}`}`);
      } catch (error) { failed.push(`${member.name ?? member.id}: ${error instanceof Error ? error.name : "error"}`); }
    }
  }
  return { reachable: true, stopped, failed };
}

async function iamceoAnswers(config: Config, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${localBase(config)}/api/health`, { redirect: "error", signal: AbortSignal.timeout(2_000) });
    const body = await response.json().catch(() => null) as { ok?: unknown; version?: unknown } | null;
    return response.status === 503 || (!!body && "version" in body);
  } catch { return false; }
}

/**
 * IAMCEO 데이터 폴더의 표식: 이주를 한 번이라도 거친 SQLite DB(iamceo.db, user_version > 0)와 접속 코드가 든 config.json 이 **둘 다** 있다.
 * 하나만으로는 통과시키지 않는다(IAMCEO_HOME 이 잘못 잡혀 다른 폴더를 통째로 지우는 사고를 막는다).
 */
export function looksLikeDataHome(dir: string): boolean {
  const db = join(dir, "iamceo.db"), config = join(dir, "config.json");
  try {
    if (!lstatSync(db).isFile() || !lstatSync(config).isFile()) return false;
    if (databaseSchema(db) <= 0) return false;
    const parsed = JSON.parse(readFileSync(config, "utf8")) as { accessCode?: unknown } | null;
    return typeof parsed?.accessCode === "string" && parsed.accessCode.length > 0;
  } catch { return false; }
}

/** 지워도 되는 IAMCEO 데이터 폴더인지 보고 지운다. 홈 폴더 자체·그 위·심볼릭 링크·표식 없는 폴더는 지우지 않는다. */
export function purgeHome(home: string, userHome: string = homedir()): boolean {
  if (!existsSync(home)) return false;
  if (lstatSync(home).isSymbolicLink()) throw new LifecycleError(say("데이터 폴더가 심볼릭 링크라 지우지 않았습니다", "The data folder is a symbolic link; it was not deleted"));
  const real = normalizeHome(home), user = normalizeHome(userHome);
  if (real.split("/").filter(Boolean).length < 2 || real === user || user.startsWith(`${real}/`)) {
    throw new LifecycleError(say(`데이터 폴더로 보이지 않는 경로라 지우지 않았습니다: ${real}`, `This does not look like a data folder; it was not deleted: ${real}`));
  }
  if (!looksLikeDataHome(real)) {
    throw new LifecycleError(say(`IAMCEO 데이터 폴더가 아니라 지우지 않았습니다(DB 와 접속 코드가 든 설정 파일이 함께 있어야 합니다): ${real}`,
      `This is not an IAMCEO data folder, so it was not deleted (it needs both the database and a settings file with an access code): ${real}`));
  }
  let owner;
  try { owner = acquireHomeOwner(real); }
  catch (error) {
    if (error instanceof HomeOwnershipError) throw new LifecycleError(say("다른 작업이 데이터 폴더를 쓰고 있어 지우지 않았습니다. 서버가 꺼졌는지 확인하세요.", "Another process is using the data folder, so it was not deleted. Check that the server is stopped."));
    throw error;
  }
  try { rmSync(real, { recursive: true }); } finally { owner.release(); }
  return true;
}

export async function uninstall(options: UninstallOptions, deps: UninstallDeps = {}): Promise<UninstallOutcome> {
  const env = deps.env ?? process.env;
  const dry = options.dryRun === true;
  if (!dry && env.IAMCEO_TEST === "1" && !deps.launchctl) throw new LifecycleError(say("IAMCEO_TEST=1 에서는 실제 서비스를 바꾸지 않습니다. --dry-run 을 쓰세요.", "With IAMCEO_TEST=1 the real service is never changed. Use --dry-run."));
  const log = deps.log ?? (line => console.log(line));
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const userHome = deps.userHome ?? homedir();
  const home = homeDir(env);
  const control: ServiceControl = { launchctl: deps.launchctl ?? realLaunchctl, domain: serviceDomain(deps.uid), plistPath: servicePlistPath(userHome), sleep };
  const plist = readServicePlist(control.plistPath);
  const ownership = plist ? serviceOwnership(plist, home, userHome, options.includeCheckout === true) : null;
  const owned = ownership?.owned === true;
  let config: Config | null = null;
  if (existsSync(join(home, "config.json"))) {
    try { config = loadConfig({ ...env, ...(owned ? plist!.env : {}), IAMCEO_HOME: home }); } catch { config = null; }
  }
  const socket = config?.coreSocket ?? join(home, "run", "core.sock");
  const coreBin = (owned ? plist!.env.IAMCEO_CORE_BIN : undefined) ?? config?.coreBin ?? Bun.which("herdr-core");
  const core = deps.core ?? defaultCoreControl(socket, coreBin && coreBin.includes("/") ? coreBin : coreBin ? Bun.which(coreBin) : null, home);
  const outcome: UninstallOutcome = { home, members: { reachable: false, stopped: 0, failed: [] }, service: plist ? (owned ? "removed" : "foreign") : "absent",
    core: { absent: true, killed: 0, stopped: false }, purged: false, tailnetHttps: "none" };
  const httpsOn = config !== null && savedTailnetHttps(home) !== null;
  const checkoutHint = ownership?.kind === "git" && ownership.sameHome && !owned;

  log(say(`이 Mac 에서 IAMCEO 를 완전히 멈춥니다 (데이터 폴더 ${home})`, `Stopping IAMCEO completely on this Mac (data folder ${home})`));
  for (const line of [
    httpsOn
      ? say("  1. 켜 둔 HTTPS 주소(이 서버가 만든 tailscale serve 설정)를 끄고, 서버가 떠 있으면 관리하는 팀장을 모두 재웁니다(직접 띄운 세션은 건드리지 않습니다)",
        "  1. Turn off the HTTPS address you turned on (the tailscale serve setting this server made), then, if the server is running, put every managed session to sleep (sessions you started yourself are left alone)")
      : say("  1. 서버가 떠 있으면 관리하는 팀장을 모두 재웁니다(직접 띄운 세션은 건드리지 않습니다)", "  1. If the server is running, put every managed session to sleep (sessions you started yourself are left alone)"),
    plist ? owned ? ownership!.kind === "git"
        ? say(`  2. 소스 체크아웃에서 도는 로그인 서비스를 해제합니다. 서비스 설정은 지우지 않고 사본을 남깁니다: ${control.plistPath}`,
          `  2. Remove the login service that runs from a source checkout; its settings file is kept as a copy: ${control.plistPath}`)
        : say(`  2. 로그인 서비스를 해제합니다: ${control.plistPath}`, `  2. Remove the login service: ${control.plistPath}`)
      : checkoutHint
        ? say(`  2. 등록된 서비스는 소스 체크아웃에서 도는 서버라 건드리지 않습니다(내리려면 --include-checkout): ${control.plistPath}`,
          `  2. The registered service runs from a source checkout, so it is left alone (add --include-checkout to stop it): ${control.plistPath}`)
        : say(`  2. 등록된 서비스가 다른 설치의 것이라 건드리지 않습니다: ${control.plistPath}`, `  2. The registered service belongs to another installation; it is left alone: ${control.plistPath}`)
      : say("  2. 등록된 로그인 서비스가 없습니다", "  2. No login service is registered"),
    say(`  3. 실행 엔진의 터미널을 모두 끝내고 엔진을 끕니다: ${socket}`, `  3. End every terminal in the session engine and stop it: ${socket}`),
    options.purge ? say(`  4. 데이터 폴더를 지웁니다: ${home} (백업 포함, 되돌릴 수 없음)`, `  4. Delete the data folder: ${home} (backups included, cannot be undone)`)
      : say(`  4. 데이터는 남깁니다: ${home}`, `  4. Your data stays in ${home}`),
  ]) log(line);
  if (dry) return outcome;

  // 0. 이 명령으로 끌 수 없는 서버가 떠 있으면 팀장을 재우기 전에 아무것도 하지 않고 멈춘다.
  //    (다른 설치의 서비스는 엔진을 꺼도 서버가 다시 띄우고, 같은 데이터 폴더면 그 서버의 팀장 세션까지 끝내게 된다.)
  const loaded = serviceLoaded(control);
  const answering = config ? await iamceoAnswers(config, fetchImpl) : false;
  const address = config ? localBase(config) : home;
  if (plist && !owned && ownership!.sameHome && (loaded || answering)) {
    throw new LifecycleError(checkoutHint
      ? say(`등록된 로그인 서비스가 소스 체크아웃에서 도는 서버라 이 명령으로 끄지 않습니다. 아무것도 바꾸지 않았습니다. 그 서버까지 멈추려면 --include-checkout 을 붙이세요(서비스 설정은 사본으로 남깁니다).`,
        `The registered login service runs from a source checkout, so this command does not stop it. Nothing was changed. To stop that server too, add --include-checkout (its settings file is kept as a copy).`)
      : say(`등록된 로그인 서비스가 다른 설치(옛 명령줄 설치 등)의 것이라 이 명령으로 끌 수 없습니다. 아무것도 바꾸지 않았습니다. 그 설치의 방법으로 먼저 멈추세요: ${control.plistPath}`,
        `The registered login service belongs to another installation (such as an older command-line install), so this command cannot stop it. Nothing was changed. Stop it the way that installation is stopped first: ${control.plistPath}`));
  }
  if (!plist && loaded) {
    throw new LifecycleError(say("설정 파일 없이 올라 있는 IAMCEO 서비스가 있어 이 명령으로 끌 수 없습니다. 아무것도 바꾸지 않았습니다. Mac 을 다시 시작한 뒤 다시 실행하세요.",
      "An IAMCEO service is loaded without a settings file, so this command cannot stop it. Nothing was changed. Restart the Mac, then run this again."));
  }
  if (answering && !(owned && loaded)) {
    throw new LifecycleError(say(`서비스 밖에서 직접 실행 중인 IAMCEO 서버가 있습니다(${address}). 이 명령으로는 끌 수 없어 아무것도 바꾸지 않았습니다. 그 서버를 끈 뒤 다시 실행하세요.`,
      `An IAMCEO server was started directly, outside the login service (${address}). This command cannot stop it, so nothing was changed. Stop that server and run this again.`));
  }

  const confirm = deps.confirm ?? askOnTerminal;
  if (!options.yes && !await confirm(say("계속하려면 y 를 입력하세요:", "Type y to continue:"), "y")) throw new LifecycleError(say("멈추지 않았습니다", "Nothing was stopped"));

  // 1. HTTPS 주소. 서버가 떠 있는 동안 서버에게 끄게 한다(서버가 없으면 같은 판정으로 직접). 서비스를 내리면 tailscaled 에 설정만 남는다.
  if (httpsOn && config) {
    const off = await turnOffTailnetHttps(config, home, { fetch: fetchImpl, ...(deps.tailscale ? { run: deps.tailscale } : {}), log });
    outcome.tailnetHttps = off.state === "failed" ? "failed" : off.state === "off" ? "off" : "none";
    if (off.state === "off") log(say("HTTPS 주소(tailscale serve)를 껐습니다", "Turned off the HTTPS address (tailscale serve)"));
    else if (off.state === "failed") log(say(`경고: HTTPS 주소를 끄지 못했습니다(${off.detail ?? "?"}). 터미널에서 ${TAILNET_SERVE_OFF_COMMAND} 로 끄세요. 나머지는 계속합니다.`,
      `Warning: could not turn off the HTTPS address (${off.detail ?? "?"}). Turn it off in Terminal with ${TAILNET_SERVE_OFF_COMMAND}. Continuing with the rest.`));
  }
  // 1. 팀장
  if (config) {
    outcome.members = await sleepMembers(config, fetchImpl);
    if (outcome.members.reachable) log(say(`팀장 ${outcome.members.stopped}명을 재웠습니다${outcome.members.failed.length ? ` · 재우지 못함 ${outcome.members.failed.length}건(실행 엔진을 끌 때 함께 끝납니다)` : ""}`,
      `Put ${outcome.members.stopped} sessions to sleep${outcome.members.failed.length ? ` · ${outcome.members.failed.length} could not be put to sleep (they end with the engine)` : ""}`));
    else log(say("서버가 꺼져 있어 팀장 재우기는 건너뜁니다", "The server is not running; skipping the sleep step"));
  }
  // 2. 서비스
  if (plist && owned) {
    await stopService(control, deps.stopTimeoutMs ?? 30_000);
    if (ownership!.kind === "git") {
      // 소스 체크아웃의 서비스 설정은 직접 만든 것일 수 있다. 지우지 않고 데이터 폴더 밖(지우기에도 남는 자리)에 사본을 둔다.
      const dir = join(userHome, "Library", "Application Support", "IAMCEO", "service-backup");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const copy = join(dir, `com.iamceo.server.${stampNow()}.plist`);
      copyFileSync(control.plistPath, copy);
      rmSync(control.plistPath, { force: true });
      outcome.serviceCopy = copy;
      log(say(`로그인 서비스를 해제했습니다. 서비스 설정 사본: ${copy} (다시 쓰려면 ${control.plistPath} 로 옮깁니다)`,
        `Removed the login service. Copy of its settings: ${copy} (move it back to ${control.plistPath} to use it again)`));
    } else {
      rmSync(control.plistPath, { force: true });
      log(say("로그인 서비스를 해제했습니다", "Removed the login service"));
    }
  } else if (plist) log(say("다른 설치의 서비스라 그대로 두었습니다", "Left the other installation's service alone"));
  // 서비스가 내려간 뒤에도 서버가 답하면(서비스 밖에서 새로 띄웠다) 엔진을 꺼도 그 서버가 다시 띄운다. 그때는 엔진을 건드리지 않고 멈춘다.
  if (config) {
    const deadline = Date.now() + (deps.stopTimeoutMs ?? 30_000);
    while (await iamceoAnswers(config, fetchImpl)) {
      if (Date.now() >= deadline) throw new LifecycleError(say(`서비스 밖에서 실행 중인 IAMCEO 서버가 있습니다(${localBase(config)}). 그 서버를 끈 뒤 다시 실행하세요. 실행 엔진은 그대로 두었습니다.`,
        `An IAMCEO server is running outside the service (${localBase(config)}). Stop it and run this again. The session engine was left running.`));
      await sleep(500);
    }
  }
  // 3. 실행 엔진
  if (await core.answers()) {
    outcome.core.absent = false;
    // 목록을 읽지 못해도(시간 초과 등) 엔진 끄기로 넘어간다. 서비스는 이미 내려갔으므로 여기서 멈추면 세션이 화면 없이 남는다.
    let live: CoreTerminalInfo[] = [];
    let listFailed = false;
    try { live = (await core.terminals()).filter(terminal => terminal.state === "live"); }
    catch {
      listFailed = true;
      log(say("경고: 실행 엔진의 터미널 목록을 읽지 못했습니다. 엔진을 바로 끕니다.", "Warning: could not list the terminals in the session engine. Stopping the engine directly."));
    }
    const failures: string[] = [];
    for (const terminal of live) {
      try { await core.kill(terminal.address); outcome.core.killed++; }
      catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    }
    outcome.core.stopped = await core.stop();
    for (let i = 0; i < 20 && await core.answers(); i++) await sleep(500);
    const stillUp = await core.answers();
    log(say(`실행 엔진의 터미널 ${outcome.core.killed}개를 끝냈습니다${outcome.core.stopped && !stillUp ? " · 엔진을 껐습니다" : ""}`,
      `Ended ${outcome.core.killed} terminals in the session engine${outcome.core.stopped && !stillUp ? " · stopped the engine" : ""}`));
    if (listFailed && stillUp) throw new LifecycleError(say("실행 엔진을 끄지 못했습니다. 팀장 세션이 아직 남아 있을 수 있습니다. Mac 을 다시 시작하면 엔진과 세션이 모두 끝납니다.",
      "Could not stop the session engine, so sessions may still be running. Restarting the Mac ends the engine and every session."));
    if (failures.length && stillUp) throw new LifecycleError(say(`실행 엔진의 터미널 ${failures.length}개를 끝내지 못했습니다. 잠시 뒤 다시 실행하세요.`, `Could not end ${failures.length} terminals in the session engine. Run this again in a moment.`));
    if (stillUp) log(say("실행 엔진이 아직 답합니다. 터미널은 모두 끝냈습니다. Mac 을 다시 시작하면 엔진도 끝납니다.", "The session engine still answers, but every terminal has ended. Restarting the Mac ends the engine as well."));
  } else log(say("실행 엔진은 이미 꺼져 있습니다", "The session engine is already stopped"));
  // 4. 데이터
  if (options.purge) {
    // 기본 자리(~/.iamceo)도, 등록된 서비스의 폴더도 아니면 --yes 가 있어도 경로를 직접 입력받는다(IAMCEO_HOME 이 잘못 잡힌 경우).
    const usual = [join(userHome, ".iamceo"), ...(plist ? [serviceHome(plist, userHome)] : [])].some(path => normalizeHome(path) === normalizeHome(home));
    if (!usual && !await confirmUnusualHome(deps.confirm, home)) {
      log(say("데이터는 지우지 않았습니다", "Your data was not deleted"));
    } else if (!options.yes && !await confirm(say(`데이터 폴더 ${home} 를 지웁니다. 대화·결재·자료·첨부·백업이 모두 사라지고 되돌릴 수 없습니다. 지우려면 '지우기' 를 입력하세요:`,
      `This deletes ${home}: conversations, decisions, files, attachments and backups, permanently. Type DELETE to confirm:`), say("지우기", "DELETE"))) {
      log(say("데이터는 지우지 않았습니다", "Your data was not deleted"));
    } else {
      outcome.purged = purgeHome(home, userHome);
      log(outcome.purged ? say(`데이터 폴더를 지웠습니다: ${home}`, `Deleted the data folder: ${home}`) : say("지울 데이터 폴더가 없습니다", "There is no data folder to delete"));
    }
  } else log(say(`데이터는 그대로 남아 있습니다: ${home}. 지우려면 iamceo uninstall --purge`, `Your data is still in ${home}. To delete it: iamceo uninstall --purge`));
  if (outcome.tailnetHttps === "failed") log(say(`HTTPS 주소(tailscale serve)가 아직 남아 있을 수 있습니다. 터미널에서 ${TAILNET_SERVE_OFF_COMMAND} 로 끄세요.`,
    `The HTTPS address (tailscale serve) may still be on. Turn it off in Terminal with ${TAILNET_SERVE_OFF_COMMAND}.`));
  log(say("앱도 지우려면 응용 프로그램 폴더의 IAMCEO 를 휴지통으로 옮기세요(Homebrew 로 설치했다면 brew uninstall --cask iamceo).",
    "To remove the app too, move IAMCEO from Applications to the Trash (or brew uninstall --cask iamceo if you installed it with Homebrew)."));
  return outcome;
}
