// 0.2.11: AI 도구(CLI) 새 판 알림과 원클릭 업데이트.
//
// - 설치 방식은 서버가 실제로 쓰는 실행 파일(server/config.ts resolveCliExecutable)의 실제 경로(realpath)로 가린다(detectCliInstall).
//   Homebrew cask·formula, npm 전역, Claude 네이티브(~/.local/share/claude/versions), Antigravity CLI 자체 업데이트(agy update). 모르는 방식은 직접 업데이트 안내만.
// - 최신 판은 그 설치 방식이 실제로 깔 판을 알려 주는 공개 주소에서 사용자 정보 없이 읽는다(2026-11-25 실제 GET 으로 확인):
//   cask·formula → formulae.brew.sh/api/{cask,formula}/<이름>.json 의 version(versions.stable). cask 의 'version,빌드' 는 앞만.
//   npm → registry.npmjs.org/<패키지>/latest 의 version. Claude 네이티브 → downloads.claude.ai/claude-code-releases/{latest,stable}(한 줄 글).
//   Antigravity CLI → 공식 설치 스크립트(antigravity.google/cli/install.sh)가 읽는 자동 업데이트 서버의 manifests/darwin_<arm64|amd64>.json 의 version.
//   시간 제한 10초, 약 6시간 담아 두고, 실패하면 마지막 값을 쓰고 30분 뒤 다시 읽는다. 실패가 서버에 번지지 않는다.
// - 새 판이 보이면 판마다 한 번 알린다(onNotice: 앱 안 띠·Mac 알림·iPhone 푸시는 http.ts 가 잇는다). 알린 판은 api_recovery_state 의 cli_update_notices 에 남긴다.
// - 대표가 누를 때만 업데이트한다(자동 업데이트 없음). 입력은 닫고(stdin /dev/null), 암호·물음이 보이면 기다리지 않고 멈춘다. 시간 제한, CLI 마다 한 번에 하나.
//   출력은 <데이터 홈>/logs/cli-update-<cli>.log 로(비밀처럼 보이는 값은 가린다). 끝나면 판을 다시 읽어 확인한다. 실패하면 옛 판이 남고 까닭·직접 할 명령을 싣는다.
// - 새 판이 깔리면 onInstalled(오케스트레이터 cliUpdated)가 떠 있는 총괄·팀장을 쉬는 때에 같은 대화로 다시 연다. 남은 수(pendingReopen)를 앱에 보인다.
// - 시험 모드(IAMCEO_TEST·NODE_ENV=test)에서는 읽기를 주입하지 않으면 네트워크를 쓰지 않고, 임시 폴더 밖의 실행 파일로는 업데이트 명령을 돌리지 않는다.
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { CLI_INFO, CLI_PROVIDERS, type CliInstallMethod, type CliProvider, type CliUpdateInfo, type CliUpdatePhase, type CliUpdateRun } from "../shared/types.ts";
import { ERROR_CODES, type ErrorCode } from "../shared/error-codes.ts";
import { isVerifiedCliVersion, parseCliVersion, resolveCliBinary, type CliBins, type CliVersionInfo, type CliVersionSource } from "./cli-version.ts";
import { resolveCliExecutable, VERSION } from "./config.ts";
import { childEnv, withoutGeminiRemote } from "./runner/env.ts";

/** 최신 판을 다시 읽는 간격(담아 두는 시간). */
export const CLI_UPDATE_CHECK_MS = 6 * 3600_000;
/** 읽기에 실패한 출처를 다시 읽기까지. */
export const CLI_UPDATE_RETRY_MS = 30 * 60_000;
/** 서버가 뜬 뒤 첫 확인까지(시작을 붙잡지 않는다). */
export const CLI_UPDATE_FIRST_CHECK_MS = 90_000;
export const CLI_UPDATE_FETCH_TIMEOUT_MS = 10_000;
/** 앱의 '다시 확인'(refresh=1)이 같은 출처를 다시 읽는 최소 간격. */
export const CLI_UPDATE_FORCE_MIN_MS = 60_000;
/** 업데이트 뒤 판을 다시 읽는 최대 시간(새 실행 파일의 첫 실행이 늦을 때). */
export const CLI_UPDATE_REREAD_MS = 60_000;
/** 업데이트 한 번의 전체 시간 제한. */
export const CLI_UPDATE_RUN_TIMEOUT_MS = 15 * 60_000;
/** 알린 판(CLI 마다 마지막으로 알린 최신 판). api_recovery_state 의 열쇠. */
export const CLI_UPDATE_NOTICES_KEY = "cli_update_notices";
const BODY_LIMIT = 1024 * 1024;
const LOG_LIMIT = 256 * 1024;
const PIPE_DRAIN_MS = 2_000;
const PENDING_POLL_MS = 5_000;
const PENDING_WATCH_MS = 6 * 3600_000;

export class CliUpdateError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode) { super(ERROR_CODES[code].ko); }
}

// ---- 판 ----
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
/** 판다운 글자인가(40자 이하, 숫자.숫자.숫자[-미리보기]). 공개 주소의 답도 이 모양만 받는다. */
export function isCliVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && VERSION_RE.test(value) && parseCliVersion(value) === value;
}
/** a 가 b 보다 새 판이면 양수. 숫자 부분을 차례로 견주고, 같으면 미리보기 판(-…)이 정식 판보다 앞이다. */
export function compareCliVersions(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a), [coreB, preB] = splitVersion(b);
  for (let i = 0; i < Math.max(coreA.length, coreB.length); i++) {
    const d = (coreA[i] ?? 0) - (coreB[i] ?? 0);
    if (d) return d;
  }
  if (preA === null || preB === null) return preA === preB ? 0 : preA === null ? 1 : -1;
  const pa = preA.split("."), pb = preB.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN, ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const d = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : nx - ny;
    if (d) return d;
  }
  return 0;
}
function splitVersion(v: string): [number[], string | null] {
  const dash = v.indexOf("-");
  const core = (dash < 0 ? v : v.slice(0, dash)).split(".").map(part => Number.parseInt(part, 10) || 0);
  return [core, dash < 0 ? null : v.slice(dash + 1)];
}

// ---- 최신 판 출처 ----
export type LatestKind = "brew_cask" | "brew_formula" | "npm" | "text" | "manifest";
export interface LatestSource { url: string; kind: LatestKind; label: string }

/** 출처 답에서 판만 꺼낸다. 모양이 다르거나 판 같지 않으면 null. */
export function parseLatestVersion(kind: LatestKind, body: string): string | null {
  if (kind === "text") {
    const line = body.trim();
    return isCliVersion(line) ? line : null;
  }
  let value: unknown;
  try { value = JSON.parse(body); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  let raw: unknown;
  switch (kind) {
    case "brew_cask": raw = typeof record.version === "string" ? record.version.split(",")[0] : null; break;
    case "brew_formula": raw = (record.versions as Record<string, unknown> | undefined)?.stable; break;
    case "npm": case "manifest": raw = record.version; break;
  }
  return isCliVersion(raw) ? raw : null;
}

const CLAUDE_RELEASES = "https://downloads.claude.ai/claude-code-releases";
/** 공식 설치 스크립트(https://antigravity.google/cli/install.sh)의 DOWNLOAD_BASE_URL. agy 자체 업데이트도 이 서버의 manifest 를 읽는다. */
const AGY_UPDATER = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";
const NPM_PACKAGES: Partial<Record<CliProvider, string>> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };

/** Homebrew 의 cask·formula 이름 글자(claude-code@latest 처럼 @ 가 든다). 그 밖의 글자가 든 폴더 이름으로는 주소를 만들지 않는다. */
const BREW_NAME = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,99}$/;
const caskSource = (name: string): LatestSource => ({ url: `https://formulae.brew.sh/api/cask/${name}.json`, kind: "brew_cask", label: `Homebrew cask ${name}` });
const formulaSource = (name: string): LatestSource => ({ url: `https://formulae.brew.sh/api/formula/${name}.json`, kind: "brew_formula", label: `Homebrew ${name}` });
const npmSource = (pkg: string): LatestSource => ({ url: `https://registry.npmjs.org/${pkg}/latest`, kind: "npm", label: `npm ${pkg}` });
const claudeSource = (channel: "latest" | "stable"): LatestSource => ({ url: `${CLAUDE_RELEASES}/${channel}`, kind: "text", label: `Claude Code ${channel}` });
const agySource = (arch: string): LatestSource => {
  const machine = arch === "x64" || arch === "amd64" ? "amd64" : "arm64";
  return { url: `${AGY_UPDATER}/manifests/darwin_${machine}.json`, kind: "manifest", label: "Antigravity CLI" };
};

// ---- 설치 방식 ----
export interface CliInstall {
  cli: CliProvider;
  method: CliInstallMethod;
  /** 서버가 쓰는 실행 파일(설정·PATH 로 찾은 그대로). 없으면 null. */
  bin: string | null;
  /** 그 실제 경로. */
  real: string | null;
  /** cask·formula 이름, npm 패키지 이름. */
  name: string | null;
  /** npm 전역 prefix. */
  prefix: string | null;
  /** 업데이트 명령의 실행 파일(brew·npm·claude·agy). 없으면 원클릭을 할 수 없다. */
  program: string | null;
  /** 최신 판을 읽을 곳. */
  source: LatestSource | null;
  /** 대표가 터미널에서 직접 할 명령. 모르는 방식이면 null. */
  manualCommand: string | null;
}
export interface DetectOptions {
  /** 사용자 홈(~/.local/share/claude 를 찾는다). 기본은 HOME. */
  userHome?: string;
  /** Claude 설정 폴더(settings.json 의 autoUpdatesChannel). 기본은 CLAUDE_CONFIG_DIR 또는 ~/.claude. */
  claudeHome?: string;
  arch?: string;
}

function executable(path: string): boolean {
  try { const s = statSync(path); return s.isFile() && (s.mode & 0o111) !== 0; } catch { return false; }
}
function realOf(path: string): string | null { try { return realpathSync(path); } catch { return null; } }

/** Claude 네이티브 설치의 업데이트 채널. settings.json 의 autoUpdatesChannel 이 stable 이면 stable, 그 밖은 latest. */
function claudeChannel(opts: DetectOptions): "latest" | "stable" {
  const home = opts.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(opts.userHome ?? process.env.HOME ?? homedir(), ".claude");
  try {
    const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { autoUpdatesChannel?: unknown };
    return settings?.autoUpdatesChannel === "stable" ? "stable" : "latest";
  } catch { return "latest"; }
}
/** 설치 방식을 모를 때 알리기만 하려고 읽는 그 CLI 의 공식 출처. */
function fallbackSource(cli: CliProvider, opts: DetectOptions): LatestSource {
  switch (cli) {
    case "claude": return claudeSource(claudeChannel(opts));
    case "codex": return npmSource(NPM_PACKAGES.codex!);
    case "gemini": return agySource(opts.arch ?? process.arch);
    default: { const unlisted: never = cli; return unlisted; }
  }
}

/** 실행 파일의 실제 경로로 설치 방식을 가린다. bin 이 없으면(설치되지 않음) unknown. */
export function detectCliInstall(cli: CliProvider, bin: string | null, opts: DetectOptions = {}): CliInstall {
  const unknown = (real: string | null): CliInstall => ({ cli, method: "unknown", bin, real, name: null, prefix: null, program: null,
    source: bin ? fallbackSource(cli, opts) : null, manualCommand: null });
  if (!bin) return unknown(null);
  const real = realOf(bin);
  if (!real) return unknown(null);
  // Antigravity CLI 는 깐 방식(brew cask·설치 스크립트)과 상관없이 스스로 업데이트한다. brew cask 로 깔았어도 agy 가 실행 파일을 바꿔 cask 기록이 낡는다(이 Mac 실측: cask 1.2.0, 실행 파일 1.5.16).
  if (cli === "gemini") return { cli, method: "agy_self", bin, real, name: null, prefix: null, program: bin, source: agySource(opts.arch ?? process.arch), manualCommand: "agy update" };
  const brew = /^(.*)\/(Caskroom|Cellar)\/([^/]+)\/[^/]+\/.+$/.exec(real);
  if (brew && BREW_NAME.test(brew[3]!)) {
    const [, prefix, kind, name] = brew as unknown as [string, string, string, string];
    const program = join(prefix, "bin", "brew");
    const cask = kind === "Caskroom";
    return { cli, method: cask ? "brew_cask" : "brew_formula", bin, real, name, prefix, program: executable(program) ? program : null,
      source: cask ? caskSource(name) : formulaSource(name), manualCommand: cask ? `brew upgrade --cask ${name}` : `brew upgrade ${name}` };
  }
  const npm = /^(.*)\/lib\/node_modules\/((?:@[^/]+\/)?[^/]+)\/.+$/.exec(real);
  if (npm) {
    const [, prefix, pkg] = npm as unknown as [string, string, string];
    if (pkg !== NPM_PACKAGES[cli]) return unknown(real);
    const own = join(prefix, "bin", "npm");
    const program = executable(own) ? own : resolveCliExecutable("npm");
    return { cli, method: "npm_global", bin, real, name: pkg, prefix, program, source: npmSource(pkg), manualCommand: `npm install -g ${pkg}@latest` };
  }
  const userHome = opts.userHome ?? process.env.HOME ?? homedir();
  const versions = realOf(join(userHome, ".local", "share", "claude", "versions"));
  if (cli === "claude" && versions && real.startsWith(versions + sep)) {
    return { cli, method: "claude_native", bin, real, name: null, prefix: null, program: bin, source: claudeSource(claudeChannel(opts)), manualCommand: "claude update" };
  }
  return unknown(real);
}

/**
 * phase: 이 단계를 시작할 때 보일 진행. 없으면 출력으로 짐작한다(brew 의 '==> Downloading' 뒤 '==> Installing·Upgrading').
 * npm 은 받기와 깔기를 한 명령으로 하고 끝에 한 줄('changed 2 packages in 9s')만 찍어 나눌 수 없다(11-25 실제 업데이트): 처음부터 '설치 중'.
 */
export interface UpdateStep { argv: string[]; env: Record<string, string>; timeoutMs: number; optional?: boolean; phase?: CliUpdatePhase }
export interface UpdatePlan { steps: UpdateStep[]; display: string }

const BASE_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
/** 업데이트 명령의 환경. 서버 환경 그대로(USER·LOGNAME·HOME 유지, env -i 로 비우지 않는다)에서 바깥 세션 값만 빼고, 물음을 막는 값을 더한다. */
function stepEnv(install: CliInstall, front: string[], extra: Record<string, string> = {}): Record<string, string> {
  const base = install.cli === "gemini" ? withoutGeminiRemote(childEnv()) : childEnv();
  const path = [...new Set([...front, ...(base.PATH ?? "").split(":"), ...BASE_PATH].filter(Boolean))].join(":");
  return { ...base, PATH: path, NONINTERACTIVE: "1", GIT_TERMINAL_PROMPT: "0", HOMEBREW_NO_ENV_HINTS: "1",
    npm_config_yes: "true", npm_config_fund: "false", npm_config_audit: "false", npm_config_update_notifier: "false", npm_config_progress: "false", ...extra };
}

/** 그 설치 방식으로 목표 판까지 올리는 명령. 원클릭을 할 수 없으면 null. */
export function updatePlan(install: CliInstall, to: string): UpdatePlan | null {
  const program = install.program;
  if (!program || install.method === "unknown") return null;
  const front = [dirname(program), ...(realOf(program) ? [dirname(realOf(program)!)] : [])];
  switch (install.method) {
    case "brew_cask": case "brew_formula": {
      const upgrade = install.method === "brew_cask" ? [program, "upgrade", "--cask", install.name!] : [program, "upgrade", install.name!];
      // brew 가 낡은 목록으로 '이미 최신'이라 하지 않게 먼저 목록을 새로 받는다. 실패해도(탭 문제 등) upgrade 는 해 본다.
      return { display: install.manualCommand!, steps: [
        { argv: [program, "update", "--quiet"], env: stepEnv(install, front), timeoutMs: 3 * 60_000, optional: true },
        { argv: upgrade, env: stepEnv(install, front, { HOMEBREW_NO_AUTO_UPDATE: "1" }), timeoutMs: 10 * 60_000 },
      ] };
    }
    case "npm_global": {
      // 그 npm 이 쓰는 node 를 찾게 node 의 폴더도 앞에 둔다(launchd 의 PATH 는 짧다).
      const node = resolveCliExecutable("node");
      return { display: `npm install -g ${install.name}@${to}`, steps: [{
        argv: [program, "install", "-g", "--prefix", install.prefix!, "--no-fund", "--no-audit", `${install.name}@${to}`],
        env: stepEnv(install, [...front, ...(node ? [dirname(node)] : [])]), timeoutMs: 10 * 60_000, phase: "installing" }] };
    }
    case "claude_native": return { display: "claude update", steps: [{ argv: [program, "update"], env: stepEnv(install, front), timeoutMs: 10 * 60_000 }] };
    case "agy_self": return { display: "agy update", steps: [{ argv: [program, "update"], env: stepEnv(install, front), timeoutMs: 10 * 60_000 }] };
    default: { const unlisted: never = install.method; return unlisted; }
  }
}

/** 시험 모드에서 돌려도 되는 실행 파일인가: 실제 경로가 임시 폴더 안이다(가짜 brew·npm). */
export function testModeAllows(program: string): boolean {
  const real = realOf(program);
  const roots = [tmpdir(), "/tmp", "/private/tmp"].map(path => realOf(path)).filter((path): path is string => !!path);
  return !!real && roots.some(root => real.startsWith(root + sep));
}
function isTestProcess(): boolean { return process.env.IAMCEO_TEST === "1" || process.env.NODE_ENV === "test"; }

// ---- 출력 ----
const INSTALLING = /==> (?:Installing|Upgrading|Pouring|Moving|Linking|Purging|Removing|Unlinking)|\binstall(?:ing|ed)\b|\bupgrad(?:ing|ed)\b|\badded \d+ packages?|\bchanged \d+ packages?|\bextract|\breplac/i;
const PROMPT = /password[^\n]{0,40}:|a terminal is required|\bsudo:|\[y\/n\]|\(y\/n\)|\[Y\/n\]|press (?:return|enter)|proceed\?|do you want to (?:continue|proceed)|are you sure/i;
/** 로그에 남기기 전에 비밀처럼 보이는 값을 가린다(npm 토큰·Bearer·주소의 계정). */
export function redactLog(text: string): string {
  return text
    .replace(/((?:_authToken|_auth|token|password|passwd|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1***")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***@");
}

class UpdateLog {
  private fd: number | null = null;
  private written = 0;
  constructor(readonly path: string) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path)) renameSync(path, `${path}.1`);
      this.fd = openSync(path, "w", 0o600);
      chmodSync(path, 0o600);
    } catch { this.fd = null; }
  }
  write(text: string): void {
    if (this.fd === null || this.written >= LOG_LIMIT) return;
    const chunk = redactLog(text).slice(0, LOG_LIMIT - this.written);
    try { this.written += writeSync(this.fd, chunk); } catch { /* 로그는 진단용이다. 쓰지 못해도 업데이트는 이어 간다 */ }
  }
  close(): void { if (this.fd !== null) { try { closeSync(this.fd); } catch { /* 이미 닫혔다 */ } this.fd = null; } }
}

type StepResult = { kind: "ok" } | { kind: "failed"; code: ErrorCode };

// ---- 서비스 ----
export interface CliUpdateState {
  loadApiRecovery<T>(key: string): T | null;
  saveApiRecovery(key: string, value: unknown): void;
}
export interface CliUpdatesOptions {
  /** 데이터 홈(로그를 logs/ 에 쓴다). */
  home: string;
  /** 서버가 쓰는 실행 파일 설정(config 의 claudeBin·codexBin·geminiBin). geminiBin 이 null 이면 Antigravity CLI 를 보지 않는다. */
  bins: () => CliBins;
  /** CLI 버전 캐시(http.ts 의 CliVersionMonitor). 업데이트 뒤 refresh(true) 로 다시 읽는다. */
  versions: CliVersionSource;
  /** 알린 판을 남기는 곳(Store 의 api_recovery_state). */
  state: CliUpdateState;
  /** 주소 하나를 읽는다. 없으면 fetch(시험 모드에서는 읽지 않는다). 실패는 null 이나 던짐. */
  fetchText?: (url: string, signal: AbortSignal) => Promise<string | null>;
  now?: () => number;
  /** 진행·최신 판이 바뀌었다(앱이 스냅샷을 다시 읽게 한다). */
  onChange?: () => void;
  /** 새 판을 처음 보았다(판마다 한 번). */
  onNotice?: (info: CliUpdateInfo) => void;
  /** 새 판이 깔렸다(떠 있는 팀장을 쉬는 때에 다시 연다). */
  onInstalled?: (cli: CliProvider, version: string) => unknown;
  /** 그 CLI 로 떠 있는 총괄·팀장 수와, 새 판으로 다시 열기를 기다리는 수. */
  reopen?: (cli: CliProvider) => { live: number; pending: number } | null;
  /** 기본은 IAMCEO_TEST=1 또는 NODE_ENV=test. 켜져 있으면 네트워크를 쓰지 않고(읽기를 주입하지 않았을 때) 임시 폴더 밖의 명령을 돌리지 않는다. */
  testMode?: boolean;
  userHome?: string;
  claudeHome?: string;
  arch?: string;
  runTimeoutMs?: number;
  killGraceMs?: number;
  pendingPollMs?: number;
  /** 업데이트 뒤 판을 다시 읽는 최대 시간. 기본 CLI_UPDATE_REREAD_MS. */
  rereadMs?: number;
}

interface Latest { version: string | null; at: number; failedAt: number | null }

export class CliUpdates {
  private readonly latest = new Map<string, Latest>();
  private readonly runs = new Map<CliProvider, CliUpdateRun>();
  private readonly active = new Map<CliProvider, Promise<void>>();
  private checking: Promise<CliUpdateInfo[]> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingTimer: ReturnType<typeof setInterval> | null = null;
  private pendingSeen = "";
  private pendingUntil = 0;
  private stopped = false;
  private readonly testMode: boolean;
  private readonly now: () => number;

  constructor(private readonly options: CliUpdatesOptions) {
    this.testMode = options.testMode ?? isTestProcess();
    this.now = options.now ?? Date.now;
  }

  /** 서버가 뜬 뒤 조금 있다 한 번, 그 뒤 CLI_UPDATE_CHECK_MS 마다(실패가 있으면 CLI_UPDATE_RETRY_MS 뒤) 최신 판을 읽는다. */
  start(firstDelayMs = CLI_UPDATE_FIRST_CHECK_MS): void {
    if (this.timer || this.stopped) return;
    const schedule = (ms: number) => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.check().catch(() => undefined).finally(() => schedule(this.failedSources() ? CLI_UPDATE_RETRY_MS : CLI_UPDATE_CHECK_MS));
      }, ms);
      (this.timer as { unref?: () => void }).unref?.();
    };
    schedule(firstDelayMs);
  }

  /**
   * 확인 타이머를 멈춘다. 도는 업데이트 명령은 끊지 않고 기다리지도 않는다: 서버를 다시 켜는 동안 brew·npm 을 중간에 죽이면
   * 반쯤 깔린 판이 남는다(명령은 스스로 끝나고, 다음 서버가 판을 다시 읽는다).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pendingTimer) clearInterval(this.pendingTimer);
    this.timer = null; this.pendingTimer = null;
  }

  private failedSources(): boolean { return [...this.latest.values()].some(entry => entry.failedAt !== null); }

  private detectOptions(): DetectOptions { return { userHome: this.options.userHome, claudeHome: this.options.claudeHome, arch: this.options.arch }; }

  private install(cli: CliProvider): CliInstall {
    const bins = this.options.bins();
    const configured = cli === "claude" ? bins.claudeBin : cli === "codex" ? bins.codexBin : bins.geminiBin;
    const bin = configured === null ? null : resolveCliBinary(cli, configured ?? undefined);
    return detectCliInstall(cli, bin, this.detectOptions());
  }

  private version(cli: CliProvider): CliVersionInfo | undefined {
    try { return this.options.versions.snapshot()?.find(info => info.provider === cli); } catch { return undefined; }
  }

  /** 설치된 CLI 의 지금 상태(기다리지 않는다). */
  list(): CliUpdateInfo[] {
    return CLI_PROVIDERS.map(cli => this.describe(cli)).filter((info): info is CliUpdateInfo => info !== null);
  }

  /** 한 CLI(설치되어 있지 않아도 줄을 만든다). */
  info(cli: CliProvider): CliUpdateInfo {
    return this.describe(cli, true)!;
  }

  private describe(cli: CliProvider, always = false): CliUpdateInfo | null {
    const install = this.install(cli);
    const seen = this.version(cli);
    const installed = !!install.bin && seen?.installed !== false;
    if (!installed && !always && !this.runs.has(cli)) return null;
    const current = seen?.version ?? null;
    const cached = install.source ? this.latest.get(install.source.url) : undefined;
    const latest = cached?.version ?? null;
    const available = !!(installed && latest && current && compareCliVersions(latest, current) > 0);
    const reopen = (() => { try { return this.options.reopen?.(cli) ?? null; } catch { return null; } })();
    const run = this.runs.get(cli);
    return {
      cli, current, latest, available, latestVerified: latest !== null && isVerifiedCliVersion(cli, latest),
      method: install.method, oneClick: installed && updatePlan(install, latest ?? current ?? "0.0.0") !== null,
      manualCommand: install.manualCommand, source: install.source?.label ?? null,
      checkedAt: cached?.at ? new Date(cached.at).toISOString() : null,
      ...(run ? { run: { ...run, error: run.error ? { ...run.error } : null } } : {}),
      ...(reopen ? { liveSessions: reopen.live } : {}),
      // 업데이트 세대가 오른 뒤에만 0 보다 크다(서버를 다시 켜 진행 값이 없어도 남은 수는 맞다).
      ...(reopen && reopen.pending > 0 ? { pendingReopen: reopen.pending } : {}),
    };
  }

  /** 최신 판을 읽는다(담아 둔 값이 낡았거나 force 일 때만). 겹친 부름은 하나로 합친다. 끝나면 새로 본 판을 알린다. */
  check(force = false): Promise<CliUpdateInfo[]> {
    if (this.checking) return this.checking;
    const run = (async () => {
      const sources = new Map<string, LatestSource>();
      for (const cli of CLI_PROVIDERS) {
        const install = this.install(cli);
        if (install.bin && install.source) sources.set(install.source.url, install.source);
      }
      let changed = false;
      await Promise.all([...sources.values()].map(async source => {
        const entry = this.latest.get(source.url);
        const at = this.now();
        const fresh = entry && (entry.failedAt === null ? at - entry.at < CLI_UPDATE_CHECK_MS : at - entry.failedAt < CLI_UPDATE_RETRY_MS);
        if (fresh && !(force && at - Math.max(entry!.at, entry!.failedAt ?? 0) >= CLI_UPDATE_FORCE_MIN_MS)) return;
        const version = await this.read(source);
        if (version) this.latest.set(source.url, { version, at: this.now(), failedAt: null });
        else this.latest.set(source.url, { version: entry?.version ?? null, at: entry?.at ?? 0, failedAt: this.now() });
        // 앱이 보는 것(최신 판·확인 시각)이 바뀌었을 때만 다시 읽게 한다.
        if (version && (version !== entry?.version || !entry?.at)) changed = true;
      }));
      const infos = this.list();
      this.announce(infos);
      if (changed) this.changed();
      return infos;
    })().finally(() => { this.checking = null; });
    this.checking = run;
    return run;
  }

  private async read(source: LatestSource): Promise<string | null> {
    const fetchText = this.options.fetchText ?? (this.testMode ? null : defaultFetchText);
    if (!fetchText) return null;
    try {
      const body = await fetchText(source.url, AbortSignal.timeout(CLI_UPDATE_FETCH_TIMEOUT_MS));
      return typeof body === "string" && body.length <= BODY_LIMIT ? parseLatestVersion(source.kind, body) : null;
    } catch { return null; }
  }

  /** 새 판을 판마다 한 번 알린다. 알린 판은 저장소에 남겨 서버를 다시 켜도 다시 알리지 않는다. */
  private announce(infos: CliUpdateInfo[]): void {
    let notices: Partial<Record<CliProvider, string>> = {};
    try { notices = this.options.state.loadApiRecovery<Partial<Record<CliProvider, string>>>(CLI_UPDATE_NOTICES_KEY) ?? {}; } catch { notices = {}; }
    let dirty = false;
    for (const info of infos) {
      if (!info.available || !info.latest) continue;
      const before = notices[info.cli];
      if (isCliVersion(before) && compareCliVersions(info.latest, before) <= 0) continue;
      notices[info.cli] = info.latest;
      dirty = true;
      try { this.options.onNotice?.(info); } catch (error) { console.warn("[cli-update] 새 판 알림을 내지 못했습니다:", (error as Error).message); }
    }
    if (dirty) { try { this.options.state.saveApiRecovery(CLI_UPDATE_NOTICES_KEY, notices); } catch (error) { console.warn("[cli-update] 알린 판을 남기지 못했습니다:", (error as Error).message); } }
  }

  private changed(): void { try { this.options.onChange?.(); } catch { /* 알림 실패가 업데이트를 막지 않는다 */ } }

  /** 대표가 누른 업데이트를 시작한다. 거절은 CliUpdateError. 진행은 info(cli).run 으로 보인다. */
  update(cli: CliProvider, to?: string): CliUpdateRun {
    if (!(CLI_PROVIDERS as readonly string[]).includes(cli)) throw new CliUpdateError(404, "cli_update_unknown_cli");
    if (this.active.has(cli)) throw new CliUpdateError(409, "cli_update_running");
    const install = this.install(cli);
    const info = this.describe(cli, true)!;
    if (!install.bin || this.version(cli)?.installed === false) throw new CliUpdateError(409, "cli_update_not_installed");
    if (install.method === "unknown" || !install.program) throw new CliUpdateError(409, "cli_update_unsupported");
    if (!info.available || !info.latest) throw new CliUpdateError(409, "cli_update_none");
    if (to !== undefined && to !== info.latest) throw new CliUpdateError(409, "cli_update_changed");
    const plan = updatePlan(install, info.latest);
    if (!plan) throw new CliUpdateError(409, "cli_update_unsupported");
    if (this.testMode && !plan.steps.every(step => testModeAllows(step.argv[0]!))) throw new CliUpdateError(503, "cli_update_test_mode");
    const run: CliUpdateRun = { id: randomUUID(), cli, from: info.current, to: info.latest, phase: plan.steps[0]?.phase ?? "downloading", startedAt: new Date(this.now()).toISOString(),
      endedAt: null, installed: null, error: null, manualCommand: install.manualCommand };
    this.runs.set(cli, run);
    const work = this.execute(run, install, plan).catch(error => {
      console.error(`[cli-update] ${CLI_INFO[cli].name} 업데이트 중 오류:`, (error as Error).message);
      if (run.phase !== "done" && run.phase !== "failed") this.finish(run, "cli_update_failed");
    }).finally(() => { this.active.delete(cli); });
    this.active.set(cli, work);
    this.changed();
    return { ...run };
  }

  /** 시험·종료용: 그 CLI 의 업데이트가 끝날 때까지 기다린다. */
  async settled(cli: CliProvider): Promise<void> { await this.active.get(cli); }

  private setPhase(run: CliUpdateRun, phase: CliUpdatePhase): void {
    if (run.phase === phase) return;
    run.phase = phase;
    this.changed();
  }

  private finish(run: CliUpdateRun, code: ErrorCode | null, installed: string | null = null): void {
    run.endedAt = new Date(this.now()).toISOString();
    run.installed = installed;
    run.error = code ? { code, message: ERROR_CODES[code].ko } : null;
    run.phase = code ? "failed" : "done";
    const name = CLI_INFO[run.cli].name;
    if (code) console.warn(`[cli-update] ${name} ${run.from ?? "?"} → ${run.to ?? "?"} 실패(${code}). 직접 할 명령: ${run.manualCommand ?? "-"}`);
    else console.info(`[cli-update] ${name} ${run.from ?? "?"} → ${installed} 끝`);
    this.changed();
  }

  private async execute(run: CliUpdateRun, install: CliInstall, plan: UpdatePlan): Promise<void> {
    const log = new UpdateLog(join(this.options.home, "logs", `cli-update-${run.cli}.log`));
    const deadline = this.now() + (this.options.runTimeoutMs ?? CLI_UPDATE_RUN_TIMEOUT_MS);
    try {
      log.write(`# ${new Date(this.now()).toISOString()} ${CLI_INFO[run.cli].name} ${run.from ?? "?"} → ${run.to ?? "?"} (${install.method})\n# ${plan.display}\n`);
      for (const step of plan.steps) {
        if (step.phase) this.setPhase(run, step.phase);
        const result = await this.runStep(step, run, log, deadline);
        if (result.kind === "ok") continue;
        if (step.optional && result.code === "cli_update_failed") { log.write(`# 앞 단계가 실패했지만 이어 갑니다\n`); continue; }
        this.finish(run, result.code);
        return;
      }
      this.setPhase(run, "verifying");
      const installed = await this.reread(run);
      log.write(`# 다시 읽은 판: ${installed ?? "읽지 못함"}\n`);
      if (!installed) return this.finish(run, "cli_update_unverified");
      if (run.from && compareCliVersions(installed, run.from) <= 0) return this.finish(run, "cli_update_unchanged");
      this.finish(run, null, installed);
      try { await this.options.onInstalled?.(run.cli, installed); } catch (error) { console.warn("[cli-update] 새 판 적용을 시작하지 못했습니다:", (error as Error).message); }
      this.watchPending();
    } finally { log.close(); }
  }

  /**
   * 업데이트 뒤 판을 다시 읽는다. 새로 깐 실행 파일의 첫 실행은 macOS 의 검사로 늦을 수 있다(11-25 실제 Codex 업데이트에서 다시 읽기에 2.6초,
   * 판 읽기 제한은 3초): 판을 못 읽으면(null) CLI_UPDATE_REREAD_MS 까지 다시 읽는다. 옛 판이 읽히면 앞서 돌던 읽기의 값일 수 있어
   * 두 번 이어 옛 판일 때 '그대로'로 본다. 시계는 실제 시간이다(시험이 넣는 now 는 멈춰 있을 수 있다).
   */
  private async reread(run: CliUpdateRun): Promise<string | null> {
    const until = Date.now() + (this.options.rereadMs ?? CLI_UPDATE_REREAD_MS);
    let version: string | null = null, same = 0;
    for (;;) {
      try { version = (await this.options.versions.refresh(true)).find(info => info.provider === run.cli)?.version ?? null; } catch { version = null; }
      if (version && (!run.from || compareCliVersions(version, run.from) > 0)) return version;
      same = version ? same + 1 : 0;
      if (same >= 2 || Date.now() >= until) return version;
      await Bun.sleep(500);
    }
  }

  private async runStep(step: UpdateStep, run: CliUpdateRun, log: UpdateLog, deadline: number): Promise<StepResult> {
    log.write(`\n$ ${step.argv.map(arg => (/^[\w@./:=+-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ")}\n`);
    let child: ReturnType<typeof Bun.spawn>;
    try {
      // 일하는 폴더는 있는 폴더여야 한다(없으면 실행이 곧바로 실패한다). 사용자 홈이 없으면 임시 폴더.
      const cwd = [this.options.userHome, process.env.HOME, homedir(), tmpdir()].find(dir => { try { return !!dir && statSync(dir).isDirectory(); } catch { return false; } }) ?? "/";
      child = Bun.spawn(step.argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: step.env, cwd });
    } catch (error) {
      log.write(`# 실행하지 못했습니다: ${(error as Error).message}\n`);
      return { kind: "failed", code: "cli_update_spawn_failed" };
    }
    let stopped: ErrorCode | null = null;
    const grace = this.options.killGraceMs ?? 2_000;
    const stop = (code: ErrorCode) => {
      if (stopped) return;
      stopped = code;
      try { child.kill("SIGTERM"); } catch { /* 이미 끝났다 */ }
      const hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 이미 끝났다 */ } }, grace);
      (hard as { unref?: () => void }).unref?.();
    };
    const limit = Math.max(1, Math.min(step.timeoutMs, deadline - this.now()));
    const timer = setTimeout(() => stop("cli_update_timeout"), limit);
    let tail = "";
    const consume = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
      if (!stream) return;
      const decoder = new TextDecoder();
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        log.write(text);
        tail = (tail + text).slice(-2_000);
        if (PROMPT.test(tail)) stop("cli_update_needs_input");
        else if (run.phase === "downloading" && INSTALLING.test(text)) this.setPhase(run, "installing");
      }
    };
    const out = Promise.all([consume(child.stdout as ReadableStream<Uint8Array>), consume(child.stderr as ReadableStream<Uint8Array>)]).catch(() => undefined);
    let code: number | null = null;
    try { code = await child.exited; } catch { code = null; }
    finally { clearTimeout(timer); }
    // 손주 프로세스가 출력 관을 쥐고 있으면 닫히지 않는다. 조금만 더 읽는다.
    await Promise.race([out, Bun.sleep(PIPE_DRAIN_MS)]);
    log.write(`\n# 종료 코드 ${code ?? "?"}\n`);
    if (stopped) return { kind: "failed", code: stopped };
    if (PROMPT.test(tail) && code !== 0) return { kind: "failed", code: "cli_update_needs_input" };
    return code === 0 ? { kind: "ok" } : { kind: "failed", code: "cli_update_failed" };
  }

  /** 새 판 적용(다시 열기)을 기다리는 수가 바뀌면 앱이 다시 읽게 한다. 0 이 되거나 PENDING_WATCH_MS 가 지나면 그친다. */
  private watchPending(): void {
    if (!this.options.reopen || this.stopped) return;
    this.pendingUntil = this.now() + PENDING_WATCH_MS;
    this.pendingSeen = this.pendingKey();
    if (this.pendingTimer) return;
    this.pendingTimer = setInterval(() => {
      const key = this.pendingKey();
      if (key !== this.pendingSeen) { this.pendingSeen = key; this.changed(); }
      if (!/[1-9]/.test(key) || this.now() > this.pendingUntil) { clearInterval(this.pendingTimer!); this.pendingTimer = null; }
    }, this.options.pendingPollMs ?? PENDING_POLL_MS);
    (this.pendingTimer as { unref?: () => void }).unref?.();
  }
  private pendingKey(): string {
    return CLI_PROVIDERS.map(cli => {
      try { return this.options.reopen?.(cli)?.pending ?? 0; } catch { return 0; }
    }).join(",");
  }
}

/** 공개 주소 하나를 읽는다. 사용자 정보(쿠키·계정)를 싣지 않는다. 1MB 가 넘으면 버린다. */
async function defaultFetchText(url: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(url, { signal, redirect: "follow", headers: { "User-Agent": `IAMCEO/${VERSION}`, Accept: "application/json, text/plain;q=0.9" } });
  if (!response.ok) return null;
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > BODY_LIMIT) return null;
  const text = await response.text();
  return text.length > BODY_LIMIT ? null : text;
}

/** 서버 문맥이 들고 다니는 모양. 시험은 가짜를 넣는다. */
export type CliUpdateSource = Pick<CliUpdates, "list" | "info" | "check" | "update">;

/** 사람이 읽는 이름(알림 문구). */
export function cliUpdateName(cli: CliProvider): string { return CLI_INFO[cli].name; }
