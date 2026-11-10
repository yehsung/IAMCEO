import { randomInt, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { withHomeOwner } from "./home-owner.ts";
import { toStorageError } from "./storage-errors.ts";

export const VERSION: string = pkg.version;
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
  herdrSocket?: string;
  /** false 면 서버가 Mac 의 유휴 잠자기를 막지 않는다. 없으면 막는다. */
  keepAwake?: boolean;
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
  herdrSocket: string;
  /** 서버가 떠 있는 동안 Mac 의 유휴 잠자기를 막는다. config.json 에서 false 로만 끈다. */
  keepAwake?: boolean;
}

// 폰에서 손으로 칠 수 있게 헷갈리는 글자(0 O 1 l I)를 뺀다.
const CODE_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

export function generateAccessCode(length = 16): string {
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function isTailscaleV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

export function detectTailscaleIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && isTailscaleV4(a.address)) return a.address;
    }
  }
  return null;
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
  for (const key of ["accessCode", "claudeBin", "codexBin", "coreBin", "coreSocket", "herdrSocket"]) {
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

/** Prefer a packaged companion or the explicit, pinned local installation. Never install at startup. */
export function defaultCoreBin(): string {
  const candidates = [
    resolve(process.execPath, "..", "herdr-core"),
    resolve(import.meta.dir, "..", ".runtime", "herdr-core", "0.1.18", "Herdr Core.app", "Contents", "MacOS", "herdr-core"),
    resolve(import.meta.dir, "..", ".runtime", "herdr-core", "0.1.18", "herdr-core"),
  ];
  return candidates.find((path) => fs.existsSync(path)) ?? "herdr-core";
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
    // $HERDR_SOCKET_PATH 는 일부러 보지 않는다: 라이브 세션 서버를 건드리면 안 된다(spec §5).
    herdrSocket: env.IAMCEO_HERDR_SOCKET || file.herdrSocket || join(homedir(), ".config", "herdr", "herdr.sock"),
    ...(file.keepAwake === false ? { keepAwake: false } : {}),
  };
}
