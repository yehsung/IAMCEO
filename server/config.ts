import { randomInt, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import coreLock from "../vendor/herdr-core/release-lock.json";
import { withHomeOwner } from "./home-owner.ts";
import { normalizePushRelayUrl } from "./push/relay-url.ts";
import { toStorageError } from "./storage-errors.ts";

export const VERSION: string = pkg.version;
/** 이 서버가 고정해 둔 herdr-core 버전. 값은 vendor/herdr-core/release-lock.json 한 곳에만 둔다. */
export const CORE_VERSION: string = coreLock.version;
export const DEFAULT_PORT = 7878;

/** config.json 에 저장되는 값. accessCode 외에는 없으면 기본값을 쓴다. */
export interface ConfigFile {
  accessCode: string;
  port?: number;
  hosts?: string[];
  claudeBin?: string;
  codexBin?: string;
  claudeHome?: string;
  codexHome?: string;
  coreBin?: string;
  coreSocket?: string;
  /** false 면 서버가 Mac 의 유휴 잠자기를 막지 않는다. 없으면 막는다. */
  keepAwake?: boolean;
  /** false 면 이 Mac 에 production 알림 키가 없어도 개발자의 알림 중계로 보내지 않는다. 없으면 켬. */
  pushRelay?: boolean;
  /** 알림 중계 주소를 바꾼다(https, 시험용으로 이 Mac 의 http). 없으면 코드의 기본 주소. */
  pushRelayUrl?: string;
}

export interface Config {
  home: string;
  configPath: string;
  dbPath: string;
  uploadsDir: string;
  inboxDir: string;
  rolesDir: string;
  accessCode: string;
  port: number;
  hosts: string[];
  /** config.json 에 hosts 를 안 적었다. Tailscale 이 나중에 올라오면 서버가 그 주소도 연다. */
  hostsAuto?: boolean;
  claudeBin: string;
  codexBin?: string;
  claudeHome?: string;
  codexHome?: string;
  coreBin?: string;
  coreSocket?: string;
  /** 서버가 떠 있는 동안 Mac 의 유휴 잠자기를 막는다. config.json 에서 false 로만 끈다. */
  keepAwake?: boolean;
  /** config.json 에서 false 로만 끈다(알림 중계). */
  pushRelay?: boolean;
  /** config.json 의 알림 중계 주소(검사를 거친 값). */
  pushRelayUrl?: string;
}

// 폰에서 손으로 칠 수 있게 헷갈리는 글자(0 O 1 l I)를 뺀다.
const CODE_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

export function generateAccessCode(length = 16): string {
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** 100.64.0.0/10 대역인가. 대역만 본다: 통신사·공유기도 이 대역을 주므로 Tailscale 이라는 증거는 아니다. */
export function isTailscaleV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

/** Tailscale 이 기기마다 주는 IPv6 대역(fd7a:115c:a1e0::/48). */
export function isTailscaleV6(ip: string): boolean {
  return ip.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

type InterfaceTable = Record<string, { address: string; family: string | number }[] | undefined>;
export interface TailscaleProbeDeps {
  interfaces?: () => InterfaceTable;
  /** `tailscale ip -4` 의 답. 명령이 없거나 답하지 않으면 null. */
  cliAddresses?: () => string[] | null;
}
export interface TailscaleProbe {
  /** 실제로 Tailscale 주소라고 확인한 IPv4. 없으면 null. */
  ip: string | null;
  via: "interface" | "cli" | null;
  /** 100.64.0.0/10 대역이지만 Tailscale 인지 확인하지 못한 주소. 이 주소에는 열지 않는다. */
  unverified: string[];
  /** 확인하지 못한 까닭(로그용). */
  reason: string | null;
}

const TUNNEL_INTERFACE = /^(utun|tun)\d+$/i;
const TAILSCALE_INTERFACE = /^tailscale/i;
export const TAILSCALE_CLI_PATHS = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/** 명령이 없는 설치(Mac App Store 판)도 앱 묶음 안의 실행 파일로 물어본다. 1.5초 안에 답이 없으면 모르는 것으로 둔다. */
function tailscaleCliAddresses(): string[] | null {
  const found = Bun.which("tailscale");
  for (const bin of [...new Set([...(found ? [found] : []), ...TAILSCALE_CLI_PATHS])]) {
    if (!fs.existsSync(bin)) continue;
    try {
      const result = Bun.spawnSync([bin, "ip", "-4"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 1500 });
      if (result.exitCode !== 0) continue;
      const addresses = result.stdout.toString().split(/\s+/).filter(isTailscaleV4);
      if (addresses.length) return addresses;
    } catch { /* 다음 후보로 넘어간다 */ }
  }
  return null;
}

/**
 * 100.64.0.0/10 주소가 정말 Tailscale 것인지 확인한다. 대역만으로는 믿지 않는다(통신사·공유기가 같은 대역을 주는 망이 있다).
 * 1) 이름이 tailscale 로 시작하는 인터페이스, 또는 터널 인터페이스(utun·tun)에 Tailscale 의 IPv6(fd7a:115c:a1e0::/48)가 같이 붙어 있으면 확인.
 *    터널 인터페이스는 이 컴퓨터의 프로그램만 만들 수 있어, 같은 망의 남이 주소 광고로 흉내 낼 수 없다.
 * 2) 그렇게 확인되지 않은 후보가 있으면 `tailscale ip -4` 의 답에 그 주소가 있는지 본다.
 * 둘 다 아니면 확인하지 못한 것으로 두고 그 주소에는 열지 않는다.
 */
export function probeTailscale(deps: TailscaleProbeDeps = {}): TailscaleProbe {
  const table = (deps.interfaces ?? (networkInterfaces as () => InterfaceTable))();
  const candidates: { name: string; address: string; tunnelWithV6: boolean }[] = [];
  for (const [name, addrs] of Object.entries(table)) {
    const v4 = (addrs ?? []).filter(a => (a.family === "IPv4" || a.family === 4) && isTailscaleV4(a.address));
    if (!v4.length) continue;
    const hasV6 = (addrs ?? []).some(a => (a.family === "IPv6" || a.family === 6) && isTailscaleV6(a.address));
    for (const a of v4) candidates.push({ name, address: a.address, tunnelWithV6: TAILSCALE_INTERFACE.test(name) || (TUNNEL_INTERFACE.test(name) && hasV6) });
  }
  if (!candidates.length) return { ip: null, via: null, unverified: [], reason: null };
  const byInterface = candidates.find(c => c.tunnelWithV6);
  if (byInterface) return { ip: byInterface.address, via: "interface", unverified: candidates.filter(c => !c.tunnelWithV6).map(c => c.address), reason: null };
  const answered = (deps.cliAddresses ?? cachedCliAddresses)();
  const byCli = answered ? candidates.find(c => answered.includes(c.address)) : undefined;
  if (byCli) return { ip: byCli.address, via: "cli", unverified: candidates.filter(c => c !== byCli).map(c => c.address), reason: null };
  return { ip: null, via: null, unverified: candidates.map(c => c.address),
    reason: answered ? "tailscale 명령이 알려 준 주소와 다릅니다" : "Tailscale 인터페이스로 확인되지 않고 tailscale 명령도 답하지 않습니다" };
}

// 확인되지 않는 주소가 있는 동안 30초마다 명령을 띄우지 않게 답을 잠깐 기억한다(답이 없었으면 2분 뒤 다시 묻는다).
let cliCache: { at: number; value: string[] | null } | null = null;
function cachedCliAddresses(): string[] | null {
  const now = Date.now();
  if (!cliCache || now - cliCache.at >= (cliCache.value ? 60_000 : 2 * 60_000)) cliCache = { at: now, value: tailscaleCliAddresses() };
  return cliCache.value;
}

const loggedUnverified = new Set<string>();
/** 확인된 Tailscale IPv4 주소. 대역만 맞고 확인되지 않은 주소는 돌려주지 않고, 까닭을 주소마다 한 번 로그에 남긴다. */
export function detectTailscaleIp(deps: TailscaleProbeDeps = {}): string | null {
  const probe = probeTailscale(deps);
  for (const address of probe.ip ? [] : probe.unverified) {
    const key = `${address}|${probe.reason}`;
    if (loggedUnverified.has(key)) continue;
    loggedUnverified.add(key);
    console.warn(`[hosts] ${address} 는 100.64.0.0/10 대역이지만 Tailscale 주소인지 확인하지 못해 열지 않습니다(${probe.reason}). Tailscale 이 맞다면 config.json 의 hosts 에 이 주소를 직접 적어 주세요`);
  }
  return probe.ip;
}

export function defaultHosts(): string[] {
  const ts = detectTailscaleIp();
  return ts ? ["127.0.0.1", ts] : ["127.0.0.1"];
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  // serve 는 작업 폴더를 옮긴다. 상대 경로로 두면 데이터 폴더가 따라 바뀐다.
  // 반환 경로의 별칭은 보존하고, 같은 홈의 잠금 판정은 home-owner 에서 정규화한다.
  return env.IAMCEO_HOME ? resolve(env.IAMCEO_HOME) : join(homedir(), ".iamceo");
}

function validateConfig(value: unknown, path: string): Partial<ConfigFile> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`설정 파일 형식이 잘못되었습니다: ${path}`);
  const file = value as Record<string, unknown>;
  // 옛 herdr 실행기의 소켓 설정(herdrSocket)은 더 읽지 않는다. 파일에 남아 있어도 값을 보지 않고 그대로 둔다.
  for (const key of ["accessCode", "claudeBin", "codexBin", "coreBin", "coreSocket"]) {
    if (file[key] !== undefined && (typeof file[key] !== "string" || !file[key] || (file[key] as string).includes("\0"))) {
      throw new Error(`설정 파일 필드가 잘못되었습니다(${key}): ${path}`);
    }
  }
  if (file.port !== undefined && (typeof file.port !== "number" || !Number.isInteger(file.port) || file.port < 0 || file.port > 65535)) {
    throw new Error(`설정 파일 포트가 잘못되었습니다: ${path}`);
  }
  if (file.hosts !== undefined && (!Array.isArray(file.hosts) || file.hosts.some((host) => typeof host !== "string" || !host || host.includes("\0")))) {
    throw new Error(`설정 파일 hosts가 잘못되었습니다: ${path}`);
  }
  if (file.keepAwake !== undefined && typeof file.keepAwake !== "boolean") throw new Error(`설정 파일 필드가 잘못되었습니다(keepAwake): ${path}`);
  // pushRelay·pushRelayUrl 은 여기서 거절하지 않는다: 알림 설정 하나 때문에 서버가 뜨지 않으면 안 된다(pushRelaySettings 가 끈다).
  return file as Partial<ConfigFile>;
}

function readConfigFile(path: string): Partial<ConfigFile> | undefined {
  let fd: number;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw toStorageError(error, "설정 파일 열기 실패");
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()) throw new Error(`안전하지 않은 설정 파일: ${path}`);
    if ((stat.mode & 0o7777) !== 0o600) fs.fchmodSync(fd, 0o600);
    return parseConfig(fs.readFileSync(fd, "utf8"), path);
  } finally { fs.closeSync(fd); }
}

function parseConfig(text: string, path: string): Partial<ConfigFile> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`설정 파일을 읽을 수 없습니다: ${path}`); }
  return validateConfig(parsed, path);
}

function atomicConfigWrite(home: string, file: Partial<ConfigFile>): void {
  const path = join(home, "config.json");
  const text = JSON.stringify(file, null, 2) + "\n";
  parseConfig(text, path);
  const temp = join(home, `.config-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  let renamed = false;
  let failure: unknown;
  try {
    fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text, "utf8");
    // Validate what reached the file, not just the object we intended to write.
    const bytes = Buffer.alloc(Buffer.byteLength(text));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("설정 임시 파일 검증 실패");
      offset += count;
    }
    if (fs.fstatSync(fd).size !== bytes.length || bytes.toString("utf8") !== text) throw new Error("설정 임시 파일 검증 실패");
    parseConfig(bytes.toString("utf8"), temp);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, path);
    renamed = true;
    const directory = fs.openSync(home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directory); }
    finally { fs.closeSync(directory); }
  } catch (error) { failure = error; throw error; }
  finally {
    const cleanupErrors: unknown[] = [];
    try { if (fd !== undefined) fs.closeSync(fd); } catch (error) { cleanupErrors.push(error); }
    try { if (created && !renamed) fs.unlinkSync(temp); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors], "설정 임시 파일 정리 실패", { cause: failure ?? cleanupErrors[0] });
    }
  }
}

/** 선택 필드의 undefined 는 저장값을 지운다. 접속 코드는 생략/undefined 때 보존하고 0600 으로 쓴다. */
export function updateConfigFile(patch: Partial<ConfigFile>, env: NodeJS.ProcessEnv = process.env): void {
  try {
    withHomeOwner(homeDir(env), (home) => {
      const file = readConfigFile(join(home, "config.json"));
      atomicConfigWrite(home, { ...file, ...patch, accessCode: patch.accessCode === undefined ? file?.accessCode : patch.accessCode });
    });
  } catch (error) { throw toStorageError(error, "설정 파일 저장 실패"); }
}

function parsePort(raw: unknown, source: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`포트 값이 잘못되었습니다(${source}): ${raw}`);
  return n;
}

/** Finder/launchd has a small PATH; discover common user CLI locations without executing a shell. */
export function resolveCliExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (command.includes("/")) return Bun.which(command);
  const userHome = env.HOME || homedir();
  const extra = [join(userHome, ".npm-global", "bin"), join(userHome, ".npm", "bin"), join(userHome, ".local", "bin"), join(userHome, ".bun", "bin"), join(userHome, ".volta", "bin"), join(userHome, ".asdf", "shims"), join(userHome, ".nvm", "current", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const path = [...new Set([...(env.PATH ?? process.env.PATH ?? "").split(":"), ...extra].filter(Boolean))].join(":");
  return Bun.which(command, { PATH: path });
}

/**
 * Prefer a packaged companion or the explicit, pinned local installation. Never install at startup.
 * 앱 묶음 안의 서버(…/runtime/iamceo)는 엔진을 옆의 runtime/Herdr Core.app 안에 둔다(LocalHostService·build-native 와 같은 자리).
 * 그 자리를 모르면 서비스 설정 없이 돈 `iamceo doctor`·`uninstall` 이 엔진을 PATH 에서 찾다가 '실행 엔진 없음'으로 판정한다.
 */
export function defaultCoreBin(execPath: string = process.execPath, sourceDir: string = import.meta.dir): string {
  const candidates = [
    resolve(execPath, "..", "herdr-core"),
    resolve(execPath, "..", "Herdr Core.app", "Contents", "MacOS", "herdr-core"),
    resolve(sourceDir, "..", ".runtime", "herdr-core", CORE_VERSION, "Herdr Core.app", "Contents", "MacOS", "herdr-core"),
    resolve(sourceDir, "..", ".runtime", "herdr-core", CORE_VERSION, "herdr-core"),
  ];
  return candidates.find((path) => fs.existsSync(path)) ?? "herdr-core";
}

/**
 * config.json 의 알림 중계 설정. pushRelay:false 면 끈다. 값이 잘못됐으면(불리언이 아님, https 가 아닌 주소)
 * 서버는 그대로 띄우고 중계만 끈다. 잘못 적은 주소 대신 기본 주소로 토큰을 보내지 않는다.
 */
export function pushRelaySettings(file: Partial<ConfigFile>, warn: (line: string) => void = console.warn): Pick<Config, "pushRelay" | "pushRelayUrl"> {
  const raw = file as Record<string, unknown>;
  if (raw.pushRelay !== undefined && typeof raw.pushRelay !== "boolean") {
    warn("[push] config.json 의 pushRelay 는 true 나 false 여야 합니다. 알림 중계를 끕니다");
    return { pushRelay: false };
  }
  if (raw.pushRelay === false) return { pushRelay: false };
  if (raw.pushRelayUrl === undefined) return {};
  try { return { pushRelayUrl: normalizePushRelayUrl(raw.pushRelayUrl) }; }
  catch {
    warn("[push] config.json 의 pushRelayUrl 이 https 주소가 아닙니다. 알림 중계를 끕니다");
    return { pushRelay: false };
  }
}

/** 폴더를 만들고 설정을 읽는다. 접속 코드가 없으면 만들어 저장한다. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = homeDir(env);
  const configPath = join(home, "config.json");
  const uploadsDir = join(home, "uploads");
  const inboxDir = join(home, "inbox");
  const rolesDir = join(home, "roles");
  let file: Partial<ConfigFile>;
  try {
    const prepare = () => {
      for (const dir of [uploadsDir, inboxDir, rolesDir]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
          if (fs.fstatSync(fd).uid !== process.getuid!()) throw new Error(`다른 사용자의 데이터 폴더: ${dir}`);
          fs.fchmodSync(fd, 0o700);
        } finally { fs.closeSync(fd); }
      }
      const existing = readConfigFile(configPath);
      if (existing?.accessCode) return existing;
      // Legacy setup can save hosts/port before first load, but an established
      // installation must never silently rotate credentials after losing a field.
      if (fs.existsSync(join(home, "iamceo.db"))) throw new Error(`설정 파일에 접속 코드가 없습니다. 명시적으로 재발급하세요: ${configPath}`);
      const initial = { ...existing, accessCode: generateAccessCode() };
      atomicConfigWrite(home, initial);
      return initial;
    };
    // status/open also load configuration while the daemon owns the home.
    // A valid, already-protected installation needs no data mutation or lock.
    const existing = readConfigFile(configPath);
    const directoriesReady = [home, uploadsDir, inboxDir, rolesDir].every((dir) => {
      try {
        // IAMCEO_HOME 자체의 별칭은 허용하되 관리 하위 폴더의 링크는 거부한다.
        const stat = dir === home ? fs.statSync(dir) : fs.lstatSync(dir);
        return stat.isDirectory() && stat.uid === process.getuid!() && (stat.mode & 0o7777) === 0o700;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
    file = existing?.accessCode && directoriesReady ? existing : withHomeOwner(home, prepare);
  } catch (error) { throw toStorageError(error, "설정 파일 로드 실패"); }

  return {
    home,
    configPath,
    dbPath: join(home, "iamceo.db"),
    uploadsDir,
    inboxDir,
    rolesDir,
    claudeHome: env.CLAUDE_CONFIG_DIR || file.claudeHome,
    codexHome: env.CODEX_HOME || file.codexHome,
    accessCode: file.accessCode!,
    port: parsePort(env.IAMCEO_PORT, "IAMCEO_PORT") ?? parsePort(file.port, "config.json") ?? DEFAULT_PORT,
    hosts: Array.isArray(file.hosts) && file.hosts.length > 0 ? file.hosts : defaultHosts(),
    hostsAuto: !(Array.isArray(file.hosts) && file.hosts.length > 0),
    claudeBin: resolveCliExecutable(env.IAMCEO_CLAUDE_BIN || file.claudeBin || "claude", env) ?? env.IAMCEO_CLAUDE_BIN ?? file.claudeBin ?? "claude",
    codexBin: resolveCliExecutable(env.IAMCEO_CODEX_BIN || file.codexBin || "codex", env) ?? env.IAMCEO_CODEX_BIN ?? file.codexBin ?? "codex",
    coreBin: env.IAMCEO_CORE_BIN || file.coreBin || defaultCoreBin(),
    coreSocket: env.IAMCEO_CORE_SOCKET || file.coreSocket || join(home, "run", "core.sock"),
    ...(file.keepAwake === false ? { keepAwake: false } : {}),
    ...pushRelaySettings(file),
  };
}
