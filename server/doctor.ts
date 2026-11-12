// B3: 스스로 점검. 서버·실행 엔진·Claude·Codex(설치와 로그인)·CLI 버전·Tailscale·자동 시작·백업·저장 공간을 항목별로 보고
// 고치는 법을 한 줄씩 붙인다. 같은 결과를 GET /api/doctor(앱의 설정 '실행 환경')와 `iamceo doctor`(서버가 꺼져 있어도)가 낸다.
// 고치는 법은 일반 사용자가 할 수 있는 동작(앱 버튼 이름, 설치 명령)만 가리킨다. 개발자 명령(bun run …)은 쓰지 않는다.
// 사실 모으기(probe)와 판정(doctorChecks)을 나눠, 판정은 주입한 사실만으로 시험한다.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, realpathSync, statfsSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { DOCTOR_CHECK_IDS, DOCTOR_ROLES_CHECK_ID, type CliProvider, type CliVersionInfo, type DoctorCheck, type DoctorReport, type EngineStatus, type RuntimeInfo, type TailnetStatus } from "../shared/types.ts";
import { readCliVersions } from "./cli-version.ts";
import { CORE_VERSION, defaultCoreBin, detectTailscaleIp, VERSION, type Config } from "./config.ts";
import { roleCustomizations, type RoleCustomization } from "./roles.ts";

export type DoctorLang = "ko" | "en";
const t = (lang: DoctorLang, ko: string, en: string): string => (lang === "ko" ? ko : en);

/** 서버 자신의 상태. 명령줄이 서버에 닿지 못했으면 down, 데이터 폴더가 아직 없으면 missing_home. */
export type ServerFacts =
  | { state: "running"; ready: boolean; version: string; /** 점검을 모르는 옛 서버(GET /api/doctor 가 404) */ legacy?: boolean }
  | { state: "starting" }
  | { state: "auth" }
  | { state: "down" }
  | { state: "missing_home" };

export interface EngineFacts {
  installed: boolean;
  /** 서버가 실행 엔진에 붙어 있는가. 서버가 꺼져 있으면 알 수 없어 null. */
  available: boolean | null;
  version: string | null;
  detail: string | null;
  status: EngineStatus | null;
}

export type LoginState = "yes" | "no" | "unknown";
export interface ProviderFacts { installed: boolean; login: LoginState }

export interface TailscaleFacts {
  /** config.json 에 hosts 를 적지 않아 서버가 Tailscale 주소를 스스로 찾는 설치. */
  auto: boolean;
  /** 지금 확인된 Tailscale 주소. */
  address: string | null;
  /** 이 설치가 전에 Tailscale 주소를 연 적이 있다(iPhone 을 쓰던 설치). */
  everOpened: boolean;
  /** 서버의 꺼짐 판정(60초 유예 뒤 off). 서버가 꺼져 있으면 null. */
  status: TailnetStatus | null;
}

export type ServiceFacts =
  | { state: "running"; pid?: number }
  | { state: "loaded"; lastExitCode?: number }
  | { state: "not_loaded" }
  | { state: "missing" }
  | { state: "other_home" }
  | { state: "unknown" };

export interface BackupFacts {
  /** 마지막으로 성공한 백업 시각(ISO). 없으면 null. */
  lastSuccessAt: string | null;
  failing: boolean;
  failures: number;
  cause: string | null;
  intervalMs: number;
  /** 데이터베이스가 생긴 지 얼마나 됐나(ms). 막 설치한 곳에 백업이 아직 없는 것은 문제가 아니다. */
  homeAgeMs: number | null;
}

export interface DiskFacts { freeBytes: number; totalBytes: number }

export interface DoctorFacts {
  now: Date;
  server: ServerFacts;
  engine: EngineFacts;
  providers: Record<CliProvider, ProviderFacts>;
  /** Codex 를 쓰는 총괄·팀장이 있다. 모르면 null(선택 기능으로 본다). */
  codexInUse: boolean | null;
  cliVersions: CliVersionInfo[] | null;
  tailscale: TailscaleFacts;
  service: ServiceFacts;
  backup: BackupFacts | null;
  disk: DiskFacts | null;
  /** E10: 이 Mac 에서 고쳐 둔 역할 지침(~/.iamceo/roles). 고친 것이 없거나 모르면 비거나 없다. 있을 때만 `roles` 항목이 붙는다. */
  roles?: RoleCustomization[] | null;
}

// ---- 판정 ----

const GiB = 1024 ** 3;
const DISK_FAIL_BYTES = 1 * GiB;
const DISK_WARN_BYTES = 5 * GiB;
const OPEN_APP_FIX = (lang: DoctorLang) => t(lang,
  "Mac 앱의 연결 화면에서 '이 Mac에서 시작'을 누르세요. 명령줄로 쓴다면 iamceo service install.",
  "In the IAMCEO Mac app, press “이 Mac에서 시작” (Start on this Mac) on the connection screen. From the command line: iamceo service install.");

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes >= 100e9 ? 0 : 1)} GB`;
}

function ago(ms: number, lang: DoctorLang): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return t(lang, `${minutes}분 전`, `${minutes} min ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t(lang, `${hours}시간 전`, `${hours} h ago`);
  return t(lang, `${Math.round(hours / 24)}일 전`, `${Math.round(hours / 24)} days ago`);
}

function check(id: (typeof DOCTOR_CHECK_IDS)[number], state: DoctorCheck["state"], title: string, detail?: string, fix?: string): DoctorCheck {
  return { id, state, title, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) };
}

function serverCheck(f: DoctorFacts, lang: DoctorLang): DoctorCheck {
  const title = t(lang, "서버", "Server");
  const s = f.server;
  switch (s.state) {
    case "running":
      if (!s.ready) return check("server", "warn", title, t(lang, `시작하는 중 · ${s.version}`, `Starting · ${s.version}`), t(lang, "잠시 뒤 다시 확인하세요.", "Check again in a moment."));
      return check("server", "ok", title, s.legacy
        ? t(lang, `실행 중 · ${s.version} (점검을 모르는 이전 버전이라 이 Mac에서 직접 확인했습니다)`, `Running · ${s.version} (an older server; checked locally)`)
        : t(lang, `실행 중 · ${s.version}`, `Running · ${s.version}`));
    case "starting":
      return check("server", "warn", title, t(lang, "시작하는 중입니다", "Starting"), t(lang, "잠시 뒤 다시 확인하세요.", "Check again in a moment."));
    case "auth":
      return check("server", "fail", title, t(lang, "서버가 이 Mac 설정의 접속 코드를 받지 않습니다", "The server rejected this Mac's access code"),
        t(lang, "Mac을 다시 시작하면 서버가 설정을 다시 읽습니다.", "Restart the Mac so the server reloads its settings."));
    case "down":
      return check("server", "fail", title, t(lang, "서버에 연결하지 못했습니다(꺼져 있음)", "Could not reach the server (not running)"), OPEN_APP_FIX(lang));
    case "missing_home":
      return check("server", "fail", title, t(lang, "이 Mac에서 IAMCEO를 아직 시작한 적이 없습니다", "IAMCEO has not been started on this Mac yet"), OPEN_APP_FIX(lang));
  }
}

function engineCheck(f: DoctorFacts, lang: DoctorLang): DoctorCheck {
  const title = t(lang, "실행 엔진", "Engine (herdr-core)");
  const e = f.engine;
  // Homebrew 의 다시 설치는 서버를 내리고 로그인 항목을 지운다. 끝난 뒤 앱에서 다시 등록해야 서버가 뜬다.
  const reinstall = t(lang, "IAMCEO 앱을 다시 설치하세요. Homebrew로 설치했다면 brew reinstall --cask yehsung/tap/iamceo 뒤 앱에서 ‘이 Mac에서 시작’을 한 번 누르세요.",
    "Reinstall the IAMCEO app. With Homebrew: brew reinstall --cask yehsung/tap/iamceo, then press 'Start on this Mac' in the app once.");
  if (!e.installed) return check("engine", "fail", title, t(lang, "실행 엔진(herdr-core)을 찾지 못했습니다", "herdr-core was not found"), reinstall);
  if (e.status?.state === "unresponsive") {
    return check("engine", "fail", title, t(lang, "실행 엔진이 60초 넘게 답하지 않습니다", "The engine has not answered for over 60 seconds"),
      t(lang, "잠시 기다려도 그대로면 Mac을 다시 시작하세요. 팀장 세션은 서버가 다시 엽니다.", "If it stays this way, restart the Mac. The server reopens the sessions."));
  }
  if (e.status?.state === "version_mismatch") {
    return check("engine", "warn", title,
      t(lang, `떠 있는 실행 엔진(${e.status.version ?? "버전 모름"})이 이 서버의 버전(${e.status.expectedVersion ?? CORE_VERSION})과 다릅니다`,
        `The running engine (${e.status.version ?? "unknown"}) differs from this server's (${e.status.expectedVersion ?? CORE_VERSION})`),
      t(lang, "IAMCEO를 최신 버전으로 다시 설치해 주세요.", "Reinstall the latest IAMCEO."));
  }
  if (e.available === true) return check("engine", "ok", title, e.version ? t(lang, `사용 가능 · ${e.version}`, `Available · ${e.version}`) : t(lang, "사용 가능", "Available"));
  if (e.available === null) {
    return check("engine", "unknown", title, t(lang, `설치됨${e.version ? ` · ${e.version}` : ""} · 서버가 꺼져 있어 동작은 확인하지 못했습니다`,
      `Installed${e.version ? ` · ${e.version}` : ""} · not checked while the server is down`));
  }
  return check("engine", "fail", title, e.detail ? t(lang, `사용할 수 없음 · ${e.detail}`, `Unavailable · ${e.detail}`) : t(lang, "실행 엔진에 연결하지 못했습니다", "Could not connect to the engine"),
    t(lang, "잠시 뒤 다시 확인하세요. 그대로면 Mac을 다시 시작하세요.", "Check again in a moment. If it stays, restart the Mac."));
}

function versionOf(f: DoctorFacts, provider: CliProvider): string | null {
  return f.cliVersions?.find(info => info.provider === provider)?.version ?? null;
}

function claudeCheck(f: DoctorFacts, lang: DoctorLang): DoctorCheck {
  const p = f.providers.claude;
  const version = versionOf(f, "claude");
  const installed = t(lang, `설치됨${version ? ` · ${version}` : ""}`, `Installed${version ? ` · ${version}` : ""}`);
  if (!p.installed) {
    return check("claude", "fail", "Claude Code", t(lang, "Claude Code를 찾지 못했습니다", "Claude Code was not found"),
      t(lang, "Claude Code를 설치하고(claude.com/claude-code) 터미널에서 claude를 한 번 실행해 로그인하세요.",
        "Install Claude Code (claude.com/claude-code), then run claude once in Terminal and sign in."));
  }
  if (p.login === "yes") return check("claude", "ok", "Claude Code", `${installed} · ${t(lang, "로그인됨", "signed in")}`);
  if (p.login === "no") {
    return check("claude", "warn", "Claude Code", `${installed} · ${t(lang, "로그인 기록을 찾지 못했습니다", "no sign-in found")}`,
      t(lang, "터미널에서 claude를 실행해 로그인하세요. 로그인하지 않으면 팀장이 시작하지 못하고 멈춥니다.",
        "Run claude in Terminal and sign in. Without it, sessions stop right after starting."));
  }
  return check("claude", "unknown", "Claude Code", `${installed} · ${t(lang, "로그인은 세션을 열 때 확인합니다", "sign-in is checked when a session starts")}`);
}

function codexCheck(f: DoctorFacts, lang: DoctorLang): DoctorCheck {
  const p = f.providers.codex;
  const version = versionOf(f, "codex");
  const installed = t(lang, `설치됨${version ? ` · ${version}` : ""}`, `Installed${version ? ` · ${version}` : ""}`);
  if (!p.installed) {
    if (f.codexInUse) {
      return check("codex", "fail", "Codex", t(lang, "Codex를 쓰는 총괄·팀장이 있는데 Codex를 찾지 못했습니다", "Some sessions use Codex, but Codex was not found"),
        t(lang, "Codex CLI를 설치하고(npm install -g @openai/codex) 터미널에서 codex를 한 번 실행해 로그인하세요.",
          "Install the Codex CLI (npm install -g @openai/codex), then run codex once in Terminal and sign in."));
    }
    return check("codex", "unknown", "Codex", t(lang, "설치하지 않았습니다 · 쓰지 않으면 괜찮습니다", "Not installed · optional"));
  }
  if (p.login === "yes") return check("codex", "ok", "Codex", `${installed} · ${t(lang, "로그인됨", "signed in")}`);
  if (p.login === "no") {
    return check("codex", f.codexInUse === false ? "unknown" : "warn", "Codex", `${installed} · ${t(lang, "로그인 기록을 찾지 못했습니다", "no sign-in found")}`,
      t(lang, "Codex를 쓰려면 터미널에서 codex를 실행해 로그인하세요.", "To use Codex, run codex in Terminal and sign in."));
  }
  return check("codex", "unknown", "Codex", `${installed} · ${t(lang, "로그인은 세션을 열 때 확인합니다", "sign-in is checked when a session starts")}`);
}

function cliVersionCheck(f: DoctorFacts, lang: DoctorLang): DoctorCheck {
  const title = t(lang, "CLI 버전", "CLI versions");
  if (!f.cliVersions) return check("cli_version", "unknown", title, t(lang, "확인하지 못했습니다", "Not checked"));
  const name = (provider: CliProvider) => (provider === "claude" ? "Claude Code" : "Codex");
  const installed = f.cliVersions.filter(info => info.installed);
  if (!installed.length) return check("cli_version", "unknown", title, t(lang, "설치된 CLI가 없습니다", "No CLI installed"));
  const unverified = installed.filter(info => info.version && !info.known);
  if (unverified.length) {
    const list = unverified.map(info => `${name(info.provider)} ${info.version}`).join(", ");
    return check("cli_version", "warn", title, t(lang, `확인되지 않은 CLI 버전: ${list}`, `Unverified CLI version: ${list}`),
      t(lang, "IAMCEO 새 버전이 나오면 올려 주세요. 그 전에 팀장이 확인 창 앞에서 멈추면 터미널을 열어 직접 답하세요.",
        "Update IAMCEO when a new version is out. Until then, if a session stops at a prompt, open its terminal and answer it yourself."));
  }
  const verified = installed.filter(info => info.version && info.known);
  if (!verified.length) return check("cli_version", "unknown", title, t(lang, "버전을 읽지 못했습니다", "Could not read the versions"));
  const list = verified.map(info => `${name(info.provider)} ${info.version}`).join(" · ");
  return check("cli_version", "ok", title, t(lang, `${list} (확인된 버전)`, `${list} (verified)`));
}

function tailscaleCheck(f: DoctorFacts, lang: DoctorLang): DoctorCheck {
  const ts = f.tailscale;
  const turnOn = t(lang, "메뉴 막대에서 Tailscale을 켜세요.", "Turn on Tailscale from the menu bar.");
  if (ts.status?.state === "off") {
    return check("tailscale", "fail", "Tailscale", t(lang, "꺼져 있습니다 · iPhone에서 연결할 수 없습니다", "Off · the iPhone cannot connect"), turnOn);
  }
  if (ts.address) return check("tailscale", "ok", "Tailscale", t(lang, `켜짐 · ${ts.address}`, `On · ${ts.address}`));
  if (!ts.auto) return check("tailscale", "unknown", "Tailscale", t(lang, "접속 주소를 직접 정해 둔 설치라 확인하지 않습니다", "Addresses are set by hand; not checked"));
  if (ts.everOpened) {
    return check("tailscale", "fail", "Tailscale", t(lang, "Tailscale 주소를 찾지 못했습니다 · iPhone에서 연결할 수 없습니다", "No Tailscale address · the iPhone cannot connect"), turnOn);
  }
  return check("tailscale", "unknown", "Tailscale", t(lang, "이 Mac에서 Tailscale을 찾지 못했습니다 · iPhone을 쓰지 않으면 괜찮습니다", "Tailscale not found on this Mac · fine without an iPhone"),
    t(lang, "iPhone에서 쓰려면 Mac과 iPhone에 Tailscale을 설치하고 같은 계정으로 켜세요.", "To use the iPhone, install Tailscale on both and sign in with the same account."));
}

function serviceCheck(f: DoctorFacts, lang: DoctorLang): DoctorCheck {
  const title = t(lang, "자동 시작", "Start at login");
  const s = f.service;
  switch (s.state) {
    case "running": return check("service", "ok", title, t(lang, "로그인 항목으로 등록됨 · 실행 중", "Registered as a login item · running"));
    case "loaded":
      return check("service", "warn", title, t(lang, "등록됨 · 지금은 꺼져 있습니다", "Registered · not running now"), OPEN_APP_FIX(lang));
    case "not_loaded":
      return check("service", "warn", title, t(lang, "등록 파일은 있지만 켜져 있지 않습니다", "Registered but not loaded"), OPEN_APP_FIX(lang));
    case "missing":
      return check("service", f.server.state === "running" ? "warn" : "fail", title,
        t(lang, "로그인 항목으로 등록되지 않았습니다 · Mac을 다시 시작하면 서버가 뜨지 않습니다", "Not registered · the server will not start after a restart"), OPEN_APP_FIX(lang));
    case "other_home":
      return check("service", "warn", title, t(lang, "다른 데이터 폴더를 쓰는 서버가 등록돼 있습니다", "A server for another data folder is registered"));
    case "unknown":
      return check("service", "unknown", title, t(lang, "확인하지 못했습니다", "Not checked"));
  }
}

function backupCheck(f: DoctorFacts, lang: DoctorLang): DoctorCheck {
  const title = t(lang, "백업", "Backup");
  const b = f.backup;
  if (!b) return check("backup", "unknown", title, t(lang, "확인하지 못했습니다", "Not checked"));
  const keepOn = t(lang, "Mac과 서버를 켜 두면 하루에 한 번 만듭니다.", "Keep the Mac and server on; a backup is made once a day.");
  if (b.failing) {
    return check("backup", "fail", title,
      t(lang, `정기 백업이 ${b.failures}번 이어서 실패했습니다${b.cause ? ` (${b.cause})` : ""}`, `The daily backup failed ${b.failures} time(s) in a row${b.cause ? ` (${b.cause})` : ""}`),
      t(lang, "Mac의 저장 공간을 확인하세요. 서버가 스스로 다시 시도합니다.", "Check the Mac's free space. The server retries by itself."));
  }
  if (!b.lastSuccessAt) {
    if (b.homeAgeMs !== null && b.homeAgeMs < 2 * b.intervalMs) {
      return check("backup", "unknown", title, t(lang, "아직 백업이 없습니다 · 서버가 하루에 한 번 만듭니다", "No backup yet · made once a day"));
    }
    return check("backup", "warn", title, t(lang, "백업을 찾지 못했습니다", "No backup found"), keepOn);
  }
  const age = f.now.getTime() - Date.parse(b.lastSuccessAt);
  if (age > 2 * b.intervalMs) return check("backup", "warn", title, t(lang, `마지막 백업이 ${ago(age, lang)}입니다`, `Last backup ${ago(age, lang)}`), keepOn);
  return check("backup", "ok", title, t(lang, `마지막 백업 ${ago(age, lang)}`, `Last backup ${ago(age, lang)}`));
}

function diskCheck(f: DoctorFacts, lang: DoctorLang): DoctorCheck {
  const title = t(lang, "저장 공간", "Disk space");
  if (!f.disk) return check("disk", "unknown", title, t(lang, "확인하지 못했습니다", "Not checked"));
  const free = t(lang, `남은 공간 ${gb(f.disk.freeBytes)}`, `${gb(f.disk.freeBytes)} free`);
  const fix = t(lang, "Mac의 저장 공간을 비워 주세요(시스템 설정 > 일반 > 저장 공간). 공간이 모자라면 대화와 자료를 저장하지 못합니다.",
    "Free up space (System Settings > General > Storage). Without space, messages and files cannot be saved.");
  if (f.disk.freeBytes < DISK_FAIL_BYTES) return check("disk", "fail", title, free, fix);
  if (f.disk.freeBytes < DISK_WARN_BYTES) return check("disk", "warn", title, free, fix);
  return check("disk", "ok", title, free);
}

/**
 * E10: 고쳐 둔 역할 지침. 고친 것이 있을 때만 붙는다(고정 목록 밖의 `roles`). 통째 교체 파일에 기준판 표지가 없거나 옛것이면,
 * 또는 승인 규칙이 빠졌으면 확인 필요. 덧붙임(<kind>.extra.md)은 기본 규칙 개선을 그대로 받으므로 정상이다.
 */
function rolesCheck(roles: RoleCustomization[], lang: DoctorLang): DoctorCheck {
  const name = (kind: RoleCustomization["kind"]) => kind === "conductor" ? t(lang, "총괄", "lead") : kind === "worker" ? t(lang, "팀장", "staff") : t(lang, "본사 AI", "HQ agent");
  const base: Record<string, string> = {
    current: "",
    stale: t(lang, "이전 기본 지침 기준", "based on older defaults"),
    unmarked: t(lang, "기준판 표지 없음", "no base marker"),
    other_kind: t(lang, "다른 역할의 기본 지침 기준", "based on another role's defaults"),
  };
  const flagged: RoleCustomization["kind"][] = [];
  const parts = roles.map(role => {
    const notes: string[] = [];
    if (role.replacement) {
      notes.push(t(lang, "통째 교체", "replaced"));
      if (base[role.replacement.base]) notes.push(base[role.replacement.base]!);
      if (!role.replacement.approval) notes.push(t(lang, "승인 규칙 없음", "no approval rule"));
      if (base[role.replacement.base] || !role.replacement.approval) flagged.push(role.kind);
    }
    if (role.extra) notes.push(t(lang, "덧붙임", "additions"));
    return `${name(role.kind)}: ${notes.join(", ")}`;
  });
  const extra = flagged.map(kind => `${kind}.extra.md`).join(", ");
  const replaced = flagged.map(kind => `${kind}.md`).join(", ");
  const fix = flagged.length ? t(lang,
    `새 기본 지침을 꺼내(iamceo roles export) 고친 부분을 옮기고, 첫 줄의 기준판 표지를 새 파일의 것으로 바꾸세요. 규칙을 더하기만 했다면 더한 부분만 ${extra} 로 옮기면 ${replaced} 는 필요 없습니다.`,
    `Export the new defaults (iamceo roles export), carry your edits over, and replace the base marker on the first line with the new file's. If you only added rules, move just those to ${extra}; then ${replaced} is not needed.`) : undefined;
  return { id: DOCTOR_ROLES_CHECK_ID, state: flagged.length ? "warn" : "ok", title: t(lang, "고쳐 쓴 역할 지침", "Edited role rules"), detail: parts.join(" · "), ...(fix ? { fix } : {}) };
}

/** 사실에서 점검표를 만든다. 항목 순서는 DOCTOR_CHECK_IDS 그대로이고, 고친 역할 지침이 있으면 끝에 `roles` 가 붙는다. */
export function doctorChecks(facts: DoctorFacts, lang: DoctorLang = "ko"): DoctorCheck[] {
  const builders: Record<(typeof DOCTOR_CHECK_IDS)[number], (f: DoctorFacts, lang: DoctorLang) => DoctorCheck> = {
    server: serverCheck, engine: engineCheck, claude: claudeCheck, codex: codexCheck, cli_version: cliVersionCheck,
    tailscale: tailscaleCheck, service: serviceCheck, backup: backupCheck, disk: diskCheck,
  };
  const checks = DOCTOR_CHECK_IDS.map(id => builders[id](facts, lang));
  return facts.roles?.length ? [...checks, rolesCheck(facts.roles, lang)] : checks;
}

/** 고친 역할 지침을 읽는다. 읽다 실패해도 점검 전체를 막지 않는다. */
function readRoles(home: string): RoleCustomization[] | null {
  try { return roleCustomizations(join(home, "roles")); } catch { return null; }
}

export function doctorReport(facts: DoctorFacts, lang: DoctorLang = "ko", serverVersion = VERSION): DoctorReport {
  return { checkedAt: facts.now.toISOString(), serverVersion, checks: doctorChecks(facts, lang) };
}

// ---- 사실 모으기 ----

export interface ProviderHomes { claudeHome?: string; codexHome?: string; userHome?: string }

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * CLI 가 남긴 로그인 기록을 본다. 내용(토큰·계정)은 읽어 두지 않고 있는지만 본다. 키체인은 건드리지 않는다.
 * Claude Code: 설정 폴더의 .claude.json 에 oauthAccount 가 있거나 .credentials.json 이 있거나, API 키·클라우드 사용 환경 변수나 apiKeyHelper 가 있으면 로그인된 것으로 본다.
 * Codex: CODEX_HOME(기본 ~/.codex)의 auth.json 이 있거나 OPENAI_API_KEY 가 있으면 로그인된 것으로 본다. 키체인에 둔 설정이면 모른다.
 */
export function probeLogin(provider: CliProvider, homes: ProviderHomes = {}, env: NodeJS.ProcessEnv = process.env): LoginState {
  const userHome = homes.userHome ?? homedir();
  try {
    if (provider === "claude") {
      if (["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"].some(name => !!env[name]?.trim())) return "yes";
      const configDir = homes.claudeHome ?? env.CLAUDE_CONFIG_DIR;
      const state = readText(configDir ? join(configDir, ".claude.json") : join(userHome, ".claude.json"));
      if (state && /"oauthAccount"\s*:\s*\{/.test(state)) return "yes";
      const dir = configDir ?? join(userHome, ".claude");
      if (existsSync(join(dir, ".credentials.json"))) return "yes";
      const settings = readText(join(dir, "settings.json"));
      if (settings && /"apiKeyHelper"\s*:\s*"[^"]+"/.test(settings)) return "yes";
      return "no";
    }
    if (env.OPENAI_API_KEY?.trim()) return "yes";
    const dir = homes.codexHome ?? env.CODEX_HOME ?? join(userHome, ".codex");
    try { if (statSync(join(dir, "auth.json")).size > 2) return "yes"; } catch { /* 없다 */ }
    const config = readText(join(dir, "config.toml"));
    if (config && /^\s*cli_auth_credentials_store\s*=\s*"(keyring|auto)"/m.test(config)) return "unknown";
    return "no";
  } catch { return "unknown"; }
}

export const SERVICE_LABEL = "com.iamceo.server";

export interface ServiceProbeOptions {
  uid?: number;
  userHome?: string;
  platform?: string;
  /** 명령 하나를 돌려 종료 코드와 표준 출력을 준다. 시험은 이것을 바꿔 진짜 launchctl 을 부르지 않는다. */
  run?: (command: string[]) => Promise<{ code: number; stdout: string }>;
}

async function runQuiet(command: string[], timeoutMs = 2_000): Promise<{ code: number; stdout: string }> {
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 이미 끝났다 */ } }, timeoutMs);
    try {
      const stdout = await new Response(child.stdout).text();
      return { code: await child.exited, stdout: stdout.slice(0, 64 * 1024) };
    } finally { clearTimeout(timer); }
  } catch { return { code: -1, stdout: "" }; }
}

function sameHome(a: string, b: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(a) === real(b);
}

/**
 * launchd 서비스(com.iamceo.server)가 등록돼 돌고 있는지 읽기만 한다(launchctl print, plutil). 불러오거나 내리지 않는다.
 * 시험 환경(IAMCEO_TEST=1)에서 run 을 주지 않으면 진짜 launchctl 을 부르지 않고 unknown 이다.
 */
export async function probeService(dataHome: string, options: ServiceProbeOptions = {}): Promise<ServiceFacts> {
  if ((options.platform ?? process.platform) !== "darwin") return { state: "unknown" };
  if (!options.run && process.env.IAMCEO_TEST === "1") return { state: "unknown" };
  const run = options.run ?? (command => runQuiet(command));
  const userHome = options.userHome ?? homedir();
  const plistPath = join(userHome, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const plistExists = existsSync(plistPath);
  if (plistExists) {
    const converted = await run(["/usr/bin/plutil", "-convert", "json", "-o", "-", plistPath]);
    if (converted.code === 0) {
      try {
        const plist = JSON.parse(converted.stdout) as { EnvironmentVariables?: Record<string, string> };
        const owner = plist.EnvironmentVariables?.IAMCEO_HOME ?? join(userHome, ".iamceo");
        if (!sameHome(owner, dataHome)) return { state: "other_home" };
      } catch { /* 소유를 모르면 아래 판정만 한다 */ }
    }
  }
  const printed = await run(["/bin/launchctl", "print", `gui/${options.uid ?? userInfo().uid}/${SERVICE_LABEL}`]);
  if (printed.code === -1) return { state: "unknown" };
  if (printed.code !== 0) return plistExists ? { state: "not_loaded" } : { state: "missing" };
  const pid = /^\s*pid\s*=\s*(\d+)/m.exec(printed.stdout)?.[1];
  const running = /^\s*state\s*=\s*running/m.test(printed.stdout) || pid !== undefined;
  if (running) return { state: "running", ...(pid ? { pid: Number(pid) } : {}) };
  const exit = /^\s*last exit code\s*=\s*(-?\d+)/m.exec(printed.stdout)?.[1];
  return { state: "loaded", ...(exit !== undefined ? { lastExitCode: Number(exit) } : {}) };
}

export function probeDisk(path: string): DiskFacts | null {
  try {
    const stat = statfsSync(path);
    return { freeBytes: Number(stat.bavail) * Number(stat.bsize), totalBytes: Number(stat.blocks) * Number(stat.bsize) };
  } catch { return null; }
}

const SNAPSHOT_NAME = /^snapshot-(\d{13})-[a-f0-9-]{36}$/;

/** 백업 폴더에서 다 만든(manifest.json 이 있는) 가장 새 백업의 시각. 내용 검증은 하지 않는다(서버의 정기 백업이 한다). */
export function newestBackupAt(backupDir: string): string | null {
  let newest = -1;
  try {
    for (const entry of readdirSync(backupDir, { withFileTypes: true })) {
      const match = entry.isDirectory() ? SNAPSHOT_NAME.exec(entry.name) : null;
      if (!match || !existsSync(join(backupDir, entry.name, "manifest.json"))) continue;
      newest = Math.max(newest, Number(match[1]));
    }
  } catch { return null; }
  return newest >= 0 ? new Date(newest).toISOString() : null;
}

function homeAgeMs(dbPath: string, now: Date): number | null {
  try {
    const stat = statSync(dbPath);
    const born = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
    return Math.max(0, now.getTime() - born);
  } catch { return null; }
}

/** 실행 엔진 실행 파일의 --version(2초 제한). 서버가 꺼져 있을 때만 쓴다. */
async function coreVersion(binary: string, run: (command: string[]) => Promise<{ code: number; stdout: string }>): Promise<string | null> {
  const path = binary.includes("/") ? (existsSync(binary) ? binary : null) : Bun.which(binary);
  if (!path) return null;
  const result = await run([path, "--version"]);
  return result.code === 0 ? result.stdout.trim().slice(0, 200) || null : null;
}

export interface DoctorProbes {
  service: (dataHome: string) => Promise<ServiceFacts>;
  disk: (path: string) => DiskFacts | null;
  login: (provider: CliProvider, homes: ProviderHomes) => LoginState;
  cliVersions: (bins: { claudeBin?: string; codexBin?: string }) => Promise<CliVersionInfo[] | null>;
  tailscaleAddress: () => string | null;
  /** 명령 하나(실행 엔진 --version 등)를 돌린다. */
  run: (command: string[]) => Promise<{ code: number; stdout: string }>;
  installed: (binary: string) => boolean;
}

export function defaultDoctorProbes(): DoctorProbes {
  return {
    service: home => probeService(home),
    disk: probeDisk,
    login: (provider, homes) => probeLogin(provider, homes),
    cliVersions: async bins => { try { return await readCliVersions({ ...bins }); } catch { return null; } },
    tailscaleAddress: () => detectTailscaleIp(),
    run: command => runQuiet(command),
    installed: binary => (binary.includes("/") ? existsSync(binary) : !!Bun.which(binary)),
  };
}

type DoctorConfig = Pick<Config, "home" | "dbPath" | "claudeBin" | "codexBin" | "claudeHome" | "codexHome" | "coreBin"> & { hostsAuto?: boolean };
type BackupStatusLike = { lastSuccessAt: string | null; failing: boolean; failures: number; cause: string | null };

/** 서버 안에서 모은다(GET /api/doctor). 실행 엔진·Tailscale 꺼짐·백업 상태는 서버가 이미 아는 값을 쓴다. */
export interface ServerDoctorInput {
  config: DoctorConfig;
  ready: boolean;
  runtime: (RuntimeInfo & { backup?: BackupStatusLike }) | null;
  engine: EngineStatus | null;
  tailnet: TailnetStatus | null;
  /** 이 설치가 Tailscale 주소를 연 적이 있다(settings 의 tailnetSeen). */
  tailnetSeen: boolean;
  /** 지금 확인된 Tailscale 주소(서버의 주소 감지). */
  detectedTailnet: string[];
  codexInUse: boolean | null;
  backupIntervalMs?: number;
  probes?: Partial<DoctorProbes>;
  now?: Date;
}

export async function serverDoctorFacts(input: ServerDoctorInput): Promise<DoctorFacts> {
  const probes = { ...defaultDoctorProbes(), ...input.probes };
  const now = input.now ?? new Date();
  const { config } = input;
  const homes = { claudeHome: config.claudeHome, codexHome: config.codexHome };
  const [service, cliVersions] = await Promise.all([
    probes.service(config.home).catch((): ServiceFacts => ({ state: "unknown" })),
    probes.cliVersions({ claudeBin: config.claudeBin, codexBin: config.codexBin }).catch(() => null),
  ]);
  const runtime = input.runtime;
  const backupStatus = runtime?.backup;
  const lastSuccessAt = backupStatus?.lastSuccessAt ?? newestBackupAt(join(config.home, "backups"));
  return {
    now,
    server: { state: "running", ready: input.ready, version: VERSION },
    engine: {
      installed: runtime?.core.installed ?? probes.installed(config.coreBin ?? "herdr-core"),
      available: runtime ? runtime.core.available : null,
      version: runtime?.core.version ?? null,
      detail: runtime?.core.detail ?? null,
      status: input.engine,
    },
    providers: {
      claude: { installed: runtime?.providers.claude.installed ?? probes.installed(config.claudeBin), login: probes.login("claude", homes) },
      codex: { installed: runtime?.providers.codex.installed ?? probes.installed(config.codexBin ?? "codex"), login: probes.login("codex", homes) },
    },
    codexInUse: input.codexInUse,
    cliVersions,
    tailscale: {
      auto: input.config.hostsAuto !== false,
      address: input.detectedTailnet[0] ?? null,
      everOpened: input.tailnetSeen,
      status: input.tailnet,
    },
    service,
    backup: {
      lastSuccessAt, failing: backupStatus?.failing ?? false, failures: backupStatus?.failures ?? 0, cause: backupStatus?.cause ?? null,
      intervalMs: input.backupIntervalMs ?? 86_400_000, homeAgeMs: homeAgeMs(config.dbPath, now),
    },
    disk: probes.disk(config.home),
    roles: readRoles(config.home),
  };
}

/** 명령줄에서 서버 없이 모은다(`iamceo doctor`, 서버가 꺼졌거나 옛 버전일 때). */
export interface LocalDoctorInput {
  home: string;
  /** 설정 파일이 없으면(아직 시작한 적 없음) null. 실행 파일 이름은 환경 변수·기본값을 쓴다. */
  config: (DoctorConfig & { hostsAuto?: boolean }) | null;
  server: ServerFacts;
  env?: NodeJS.ProcessEnv;
  probes?: Partial<DoctorProbes>;
  now?: Date;
}

export async function localDoctorFacts(input: LocalDoctorInput): Promise<DoctorFacts> {
  const probes = { ...defaultDoctorProbes(), ...input.probes };
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const config = input.config;
  const claudeBin = config?.claudeBin ?? env.IAMCEO_CLAUDE_BIN ?? "claude";
  const codexBin = config?.codexBin ?? env.IAMCEO_CODEX_BIN ?? "codex";
  // 설정 파일이 아직 없어도 앱 묶음 안의 엔진(runtime/Herdr Core.app)을 먼저 본다.
  const coreBin = config?.coreBin ?? env.IAMCEO_CORE_BIN ?? defaultCoreBin();
  const homes = { claudeHome: config?.claudeHome ?? env.CLAUDE_CONFIG_DIR, codexHome: config?.codexHome ?? env.CODEX_HOME };
  const coreInstalled = probes.installed(coreBin);
  const [service, cliVersions, version] = await Promise.all([
    probes.service(input.home).catch((): ServiceFacts => ({ state: "unknown" })),
    probes.cliVersions({ claudeBin, codexBin }).catch(() => null),
    coreInstalled ? coreVersion(coreBin, probes.run).catch(() => null) : Promise.resolve(null),
  ]);
  let tailnetSeen = false;
  let address: string | null = null;
  try { address = probes.tailscaleAddress(); } catch { address = null; }
  if (config) tailnetSeen = readTailnetSeen(config.dbPath);
  const status: EngineStatus | null = version && !version.includes(CORE_VERSION)
    ? { state: "version_mismatch", version, expectedVersion: CORE_VERSION } : null;
  return {
    now,
    server: input.server,
    engine: { installed: coreInstalled, available: null, version, detail: null, status },
    providers: {
      claude: { installed: probes.installed(claudeBin), login: probes.login("claude", homes) },
      codex: { installed: probes.installed(codexBin), login: probes.login("codex", homes) },
    },
    codexInUse: config ? readCodexInUse(config.dbPath) : null,
    cliVersions,
    tailscale: { auto: config?.hostsAuto !== false, address, everOpened: tailnetSeen, status: null },
    service,
    backup: config ? {
      lastSuccessAt: newestBackupAt(join(input.home, "backups")), failing: false, failures: 0, cause: null,
      intervalMs: 86_400_000, homeAgeMs: homeAgeMs(config.dbPath, now),
    } : null,
    disk: probes.disk(existsSync(input.home) ? input.home : homedir()),
    roles: existsSync(input.home) ? readRoles(input.home) : null,
  };
}

/** 서버가 꺼져 있을 때 DB 를 읽기 전용으로 잠깐 연다. 열지 못하면 모르는 것으로 둔다. */
function readDb<T>(dbPath: string, read: (db: Database) => T, fallback: T): T {
  if (!existsSync(dbPath)) return fallback;
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    return read(db);
  } catch { return fallback; }
  finally { try { db?.close(); } catch { /* 읽기만 했다 */ } }
}

function readTailnetSeen(dbPath: string): boolean {
  return readDb(dbPath, db => !!db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'tailnetSeen'").get(), false);
}

function readCodexInUse(dbPath: string): boolean | null {
  return readDb<boolean | null>(dbPath, db => !!db.query("SELECT 1 FROM members m JOIN projects p ON p.id = m.project_id WHERE m.cli = 'codex' AND p.archived = 0 LIMIT 1").get(), null);
}

// ---- 명령줄에서 서버에 묻기 ----

export type ServerDoctorAnswer =
  | { kind: "report"; report: DoctorReport }
  | { kind: "legacy"; version: string }
  | { kind: "starting" }
  | { kind: "auth" }
  | { kind: "down" };

function isReport(value: unknown): value is DoctorReport {
  const v = value as DoctorReport | null;
  return !!v && typeof v.checkedAt === "string" && typeof v.serverVersion === "string" && Array.isArray(v.checks)
    && v.checks.every(c => !!c && typeof c.id === "string" && typeof c.title === "string" && ["ok", "warn", "fail", "unknown"].includes(c.state));
}

/** 이 Mac 의 서버에 GET /api/doctor 를 묻는다. 옛 서버(404)면 /api/health 의 버전만 받아 둔다. */
export async function askServerDoctor(baseUrl: string, accessCode: string, lang: DoctorLang, request: typeof fetch = fetch, timeoutMs = 10_000): Promise<ServerDoctorAnswer> {
  const headers = { Authorization: `Bearer ${accessCode}` };
  let response: Response;
  try {
    response = await request(`${baseUrl}/api/doctor?lang=${lang}`, { headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch { return { kind: "down" }; }
  if (response.status === 401 || response.status === 403) return { kind: "auth" };
  if (response.status === 503) return { kind: "starting" };
  if (response.ok) {
    const body = await response.json().catch(() => null);
    if (isReport(body)) return { kind: "report", report: body };
  }
  // 점검을 모르는 옛 서버이거나 답이 깨졌다. 살아 있는지와 버전만 확인하고 나머지는 이 Mac 에서 본다.
  try {
    const health = await request(`${baseUrl}/api/health`, { redirect: "error", signal: AbortSignal.timeout(Math.min(timeoutMs, 3_000)) });
    const body = await health.json().catch(() => null) as { version?: unknown } | null;
    if (health.ok) return { kind: "legacy", version: typeof body?.version === "string" ? body.version : "?" };
    if (health.status === 503) return { kind: "starting" };
  } catch { /* 아래 */ }
  return { kind: "down" };
}

// ---- 명령줄 출력 ----

const MARK: Record<DoctorCheck["state"], string> = { ok: "✓", warn: "!", fail: "✗", unknown: "·" };

/** `iamceo doctor` 의 사람용 출력. */
export function formatDoctorReport(report: DoctorReport, lang: DoctorLang): string {
  const lines = [t(lang, `IAMCEO 점검 · 서버 ${report.serverVersion} · ${report.checkedAt}`, `IAMCEO check · server ${report.serverVersion} · ${report.checkedAt}`)];
  for (const c of report.checks) {
    lines.push(`${MARK[c.state] ?? "?"} ${c.title}${c.detail ? ` — ${c.detail}` : ""}`);
    if (c.fix) lines.push(`    ${t(lang, "고치는 법", "Fix")}: ${c.fix}`);
  }
  const fails = report.checks.filter(c => c.state === "fail").length;
  const warns = report.checks.filter(c => c.state === "warn").length;
  lines.push("");
  lines.push(fails || warns
    ? t(lang, `문제 ${fails} · 확인 필요 ${warns}`, `${fails} problem(s) · ${warns} warning(s)`)
    : t(lang, "모두 정상입니다.", "All good."));
  return lines.join("\n");
}
