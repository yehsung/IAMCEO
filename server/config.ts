import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";

export const VERSION: string = pkg.version;
export const DEFAULT_PORT = 7878;

/** config.json 에 저장되는 값. accessCode 외에는 없으면 기본값을 쓴다. */
export interface ConfigFile {
  accessCode: string;
  port?: number;
  hosts?: string[];
  claudeBin?: string;
  codexBin?: string;
  coreBin?: string;
  coreSocket?: string;
  herdrSocket?: string;
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
  coreBin?: string;
  coreSocket?: string;
  herdrSocket: string;
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
  return env.IAMCEO_HOME ? resolve(env.IAMCEO_HOME) : join(homedir(), ".iamceo");
}

function readConfigFile(path: string): Partial<ConfigFile> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`설정 파일을 읽을 수 없습니다: ${path} (${(e as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`설정 파일 형식이 잘못되었습니다: ${path}`);
  }
  return parsed as Partial<ConfigFile>;
}

/** config.json 을 일부만 고친다. 접속 코드가 들어 있으므로 본인만 읽게 쓴다. */
export function updateConfigFile(patch: Partial<ConfigFile>, env: NodeJS.ProcessEnv = process.env): void {
  const home = homeDir(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "config.json");
  writeFileSync(path, JSON.stringify({ ...readConfigFile(path), ...patch }, null, 2) + "\n", { mode: 0o600 });
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
  return candidates.find((path) => existsSync(path)) ?? "herdr-core";
}

/** 폴더를 만들고 설정을 읽는다. 접속 코드가 없으면 만들어 저장한다. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = homeDir(env);
  const configPath = join(home, "config.json");
  const uploadsDir = join(home, "uploads");
  const inboxDir = join(home, "inbox");
  const rolesDir = join(home, "roles");
  for (const dir of [home, uploadsDir, inboxDir, rolesDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  let file = readConfigFile(configPath);
  if (typeof file.accessCode !== "string" || !file.accessCode) {
    updateConfigFile({ accessCode: generateAccessCode() }, env);
    file = readConfigFile(configPath);
  }

  return {
    home,
    configPath,
    dbPath: join(home, "iamceo.db"),
    uploadsDir,
    inboxDir,
    rolesDir,
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
  };
}
