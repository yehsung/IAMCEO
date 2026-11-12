// `iamceo uninstall` 과 Mac 앱의 '이 Mac에서 완전히 멈추기'.
// 순서: 팀장 재우기(서버가 떠 있으면 기존 안전 종료 경로로) → 서비스 해제(서버가 내려간다) → 실행 엔진의 터미널 종료와 엔진 종료 → (원하면) 데이터 삭제.
// 실행 엔진을 서비스보다 먼저 끄면 떠 있는 서버가 엔진을 다시 띄우므로, 서비스를 먼저 내린다.
// 데이터는 기본으로 남긴다. 지우기(--purge)는 따로 한 번 더 확인한다.
import { existsSync, lstatSync, rmSync } from "node:fs";
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
import { localBase } from "./runtime.ts";

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

export interface UninstallOptions { purge?: boolean; yes?: boolean; dryRun?: boolean }
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
}

export interface UninstallOutcome {
  home: string;
  members: { reachable: boolean; stopped: number; failed: string[] };
  service: "removed" | "absent" | "foreign";
  core: { absent: boolean; killed: number; stopped: boolean };
  purged: boolean;
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

function ownService(plist: ServicePlist, home: string, userHome: string): boolean {
  try {
    detectInstallation(plist, userHome);
    return normalizeHome(serviceHome(plist, userHome)) === normalizeHome(home);
  } catch { return false; }
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

/** 지워도 되는 IAMCEO 데이터 폴더인지 보고 지운다. 홈 폴더 자체·그 위·심볼릭 링크·표식 없는 폴더는 지우지 않는다. */
export function purgeHome(home: string, userHome: string = homedir()): boolean {
  if (!existsSync(home)) return false;
  if (lstatSync(home).isSymbolicLink()) throw new LifecycleError(say("데이터 폴더가 심볼릭 링크라 지우지 않았습니다", "The data folder is a symbolic link; it was not deleted"));
  const real = normalizeHome(home), user = normalizeHome(userHome);
  if (real.split("/").filter(Boolean).length < 2 || real === user || user.startsWith(`${real}/`)) {
    throw new LifecycleError(say(`데이터 폴더로 보이지 않는 경로라 지우지 않았습니다: ${real}`, `This does not look like a data folder; it was not deleted: ${real}`));
  }
  if (!["iamceo.db", "config.json"].some(name => existsSync(join(real, name)))) {
    throw new LifecycleError(say(`IAMCEO 데이터 폴더가 아니라 지우지 않았습니다: ${real}`, `This is not an IAMCEO data folder; it was not deleted: ${real}`));
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
  const owned = plist ? ownService(plist, home, userHome) : false;
  let config: Config | null = null;
  if (existsSync(join(home, "config.json"))) {
    try { config = loadConfig({ ...env, ...(owned ? plist!.env : {}), IAMCEO_HOME: home }); } catch { config = null; }
  }
  const socket = config?.coreSocket ?? join(home, "run", "core.sock");
  const coreBin = (owned ? plist!.env.IAMCEO_CORE_BIN : undefined) ?? config?.coreBin ?? Bun.which("herdr-core");
  const core = deps.core ?? defaultCoreControl(socket, coreBin && coreBin.includes("/") ? coreBin : coreBin ? Bun.which(coreBin) : null, home);
  const outcome: UninstallOutcome = { home, members: { reachable: false, stopped: 0, failed: [] }, service: plist ? (owned ? "removed" : "foreign") : "absent",
    core: { absent: true, killed: 0, stopped: false }, purged: false };

  log(say(`이 Mac 에서 IAMCEO 를 완전히 멈춥니다 (데이터 폴더 ${home})`, `Stopping IAMCEO completely on this Mac (data folder ${home})`));
  for (const line of [
    say("  1. 서버가 떠 있으면 관리하는 팀장을 모두 재웁니다(직접 띄운 세션은 건드리지 않습니다)", "  1. If the server is running, put every managed session to sleep (sessions you started yourself are left alone)"),
    plist ? owned ? say(`  2. 로그인 서비스를 해제합니다: ${control.plistPath}`, `  2. Remove the login service: ${control.plistPath}`)
      : say(`  2. 등록된 서비스가 다른 설치의 것이라 건드리지 않습니다: ${control.plistPath}`, `  2. The registered service belongs to another installation; it is left alone: ${control.plistPath}`)
      : say("  2. 등록된 로그인 서비스가 없습니다", "  2. No login service is registered"),
    say(`  3. 실행 엔진의 터미널을 모두 끝내고 엔진을 끕니다: ${socket}`, `  3. End every terminal in the session engine and stop it: ${socket}`),
    options.purge ? say(`  4. 데이터 폴더를 지웁니다: ${home} (백업 포함, 되돌릴 수 없음)`, `  4. Delete the data folder: ${home} (backups included, cannot be undone)`)
      : say(`  4. 데이터는 남깁니다: ${home}`, `  4. Your data stays in ${home}`),
  ]) log(line);
  if (dry) return outcome;
  const confirm = deps.confirm ?? askOnTerminal;
  if (!options.yes && !await confirm(say("계속하려면 y 를 입력하세요:", "Type y to continue:"), "y")) throw new LifecycleError(say("멈추지 않았습니다", "Nothing was stopped"));

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
    rmSync(control.plistPath, { force: true });
    log(say("로그인 서비스를 해제했습니다", "Removed the login service"));
  } else if (plist) log(say("다른 설치의 서비스라 그대로 두었습니다", "Left the other installation's service alone"));
  else if (serviceLoaded(control)) log(say("설정 파일 없이 올라 있는 서비스가 있어 건드리지 않았습니다", "A service is loaded without a settings file; it was left alone"));
  // 서비스 밖에서 도는 서버가 있으면 엔진을 꺼도 다시 띄운다. 그때는 엔진을 건드리지 않고 멈춘다.
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
    const live = (await core.terminals()).filter(terminal => terminal.state === "live");
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
    if (failures.length && stillUp) throw new LifecycleError(say(`실행 엔진의 터미널 ${failures.length}개를 끝내지 못했습니다. 잠시 뒤 다시 실행하세요.`, `Could not end ${failures.length} terminals in the session engine. Run this again in a moment.`));
    if (stillUp) log(say("실행 엔진이 아직 답합니다. 터미널은 모두 끝냈습니다. Mac 을 다시 시작하면 엔진도 끝납니다.", "The session engine still answers, but every terminal has ended. Restarting the Mac ends the engine as well."));
  } else log(say("실행 엔진은 이미 꺼져 있습니다", "The session engine is already stopped"));
  // 4. 데이터
  if (options.purge) {
    if (!options.yes && !await confirm(say(`데이터 폴더 ${home} 를 지웁니다. 대화·결재·자료·첨부·백업이 모두 사라지고 되돌릴 수 없습니다. 지우려면 '지우기' 를 입력하세요:`,
      `This deletes ${home}: conversations, decisions, files, attachments and backups, permanently. Type DELETE to confirm:`), say("지우기", "DELETE"))) {
      log(say("데이터는 지우지 않았습니다", "Your data was not deleted"));
    } else {
      outcome.purged = purgeHome(home, userHome);
      log(outcome.purged ? say(`데이터 폴더를 지웠습니다: ${home}`, `Deleted the data folder: ${home}`) : say("지울 데이터 폴더가 없습니다", "There is no data folder to delete"));
    }
  } else log(say(`데이터는 그대로 남아 있습니다: ${home}. 지우려면 iamceo uninstall --purge`, `Your data is still in ${home}. To delete it: iamceo uninstall --purge`));
  log(say("앱도 지우려면 응용 프로그램 폴더의 IAMCEO 를 휴지통으로 옮기세요(Homebrew 로 설치했다면 brew uninstall --cask iamceo).",
    "To remove the app too, move IAMCEO from Applications to the Trash (or brew uninstall --cask iamceo if you installed it with Homebrew)."));
  return outcome;
}
