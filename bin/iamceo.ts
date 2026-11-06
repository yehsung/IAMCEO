#!/usr/bin/env bun
// IAMCEO CLI. mcp 는 세션마다 뜨므로 서버 코드를 끌어오지 않게 명령별로 늦게 불러온다.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { EFFORTS, type Bootstrap, type Effort, type Member, type Project, type ProjectState } from "../shared/types.ts";
import { DEFAULT_PORT, detectTailscaleIp, isTailscaleV4, loadConfig, updateConfigFile, type Config } from "../server/config.ts";

const USAGE = `쓰는 법: iamceo <명령>
  serve                  서버를 켠다
  setup [--port 번호] [--hosts local|lan|주소,주소]
                         첫 설정(herdr-core·포트·접근 범위)
  open                   접속 주소와 접속 코드를 보여 준다
  status                 서버와 프로젝트 상태를 본다
  attach <직원ID>        관리 중인 CLI 터미널을 연다
  join [--project 이름] [--name 이름] [--role 역할] [--handle 핸들] [--session UUID]
                         내가 띄운 CLI 를 직원으로 등록하고 연결 명령을 알려 준다
  import <덤프.json> [--name 이름] [--cwd 폴더]
                         기존 운영판 덤프를 프로젝트로 가져온다
  service install [--dry-run] | uninstall [--dry-run]
                         launchd 서비스(com.iamceo.server)를 등록·해제한다
  roles export           기본 역할 템플릿을 ~/.iamceo/roles/<kind>.example.md 로 꺼낸다. <kind>.md 로 고쳐 두면 그것을 쓴다
  version                버전을 보여 준다
  mcp                    MCP 브리지(세션이 부른다)`;

export const VERSION: string = pkg.version;

class CliError extends Error {}

const COMPILED = import.meta.path.startsWith("/$bunfs/");

function selfCommand(sub: string): string[] {
  return COMPILED ? [process.execPath, sub] : [process.execPath, resolve(import.meta.dir, "iamceo.ts"), sub];
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./:=@]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function localUrl(config: Config): string {
  const host = config.hosts.includes("127.0.0.1") || config.hosts.some((h) => h === "0.0.0.0" || h === "localhost") ? "127.0.0.1" : config.hosts[0]!;
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`;
}

function publicUrls(config: Config): string[] {
  return config.hosts.map((h) => `http://${h.includes(":") ? `[${h}]` : h}:${config.port}`);
}

async function api<T>(config: Config, path: string, init?: { method: string; body: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${localUrl(config)}${path}`, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${config.accessCode}`, ...(init ? { "Content-Type": "application/json" } : {}) },
      body: init ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new CliError(`서버가 꺼져 있습니다(${localUrl(config)}). iamceo serve 로 켜세요.`);
  }
  const parsed = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new CliError(parsed?.error ?? `서버 오류(${res.status})`);
  return parsed as T;
}

// ---- serve ----
function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port, timeout: 1000 });
    const finish = (inUse: boolean) => {
      socket.destroy();
      done(inUse);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** 사용자가 Claude Code 에 저장해 둔 effort. 없으면 high. */
function savedClaudeEffort(): Effort {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    const level = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).effortLevel;
    if ((EFFORTS as readonly string[]).includes(level)) return level as Effort;
  } catch {}
  return "high";
}

async function serve(): Promise<void> {
  const config = loadConfig();
  // 화면 번들의 주소가 작업 폴더 기준으로 나온다. 다른 폴더에서 켜면 스크립트가 HTML 로 응답되어 빈 화면이 된다.
  if (!COMPILED) process.chdir(resolve(import.meta.dir, ".."));
  // Bun.serve 는 routes 를 주면 이미 쓰는 포트에서도 예외 없이 돌아온다. 그러면 안 들리는 서버가 떠 있게 된다.
  if (config.port !== 0 && (await portInUse(config.hosts[0]!, config.port))) {
    throw new CliError(`포트 ${config.port} 을 이미 쓰고 있습니다. 서버가 떠 있으면 iamceo status 로 확인하고, 아니면 IAMCEO_PORT 나 iamceo setup 으로 바꾸세요.`);
  }
  const [{ Bus }, { openDb }, { startServer }, { createOrchestrator }, { Store }] = await Promise.all([
    import("../server/bus.ts"),
    import("../server/db.ts"),
    import("../server/http.ts"),
    import("../server/orchestrator.ts"),
    import("../server/store.ts"),
  ]);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  store.fillRankEfforts(savedClaudeEffort());
  const orch = createOrchestrator(config, store);
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ config, store, bus, orch });
  } catch (e) {
    await orch.shutdown();
    throw new CliError(`서버를 열지 못했습니다(포트 ${config.port}): ${(e as Error).message}`);
  }
  orch.setServerUrl(server.urls[0]!);
  await orch.initializeRuntime();
  await orch.recover();
  console.log(`IAMCEO 서버: ${server.urls.join(" · ")}`);
  console.log("접속 코드는 iamceo open 으로 봅니다.");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // 자식이 시그널에 안 죽어도 launchd 재시작이 막히지 않게 한다.
    setTimeout(() => process.exit(1), 15_000).unref();
    await orch.shutdown();
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}

async function attach(args: string[]): Promise<void> {
  if (args.length !== 1 || !/^m_[A-Za-z0-9_-]+$/.test(args[0]!)) throw new CliError("쓰는 법: iamceo attach <직원ID>");
  const config = loadConfig();
  const member = await api<Member>(config, `/api/members/${encodeURIComponent(args[0]!)}`);
  if (member.backend !== "core" || !member.paneId) throw new CliError("연결할 core 터미널이 없습니다");
  // The screen endpoint verifies the current core ownership labels before local attach.
  await api(config, `/api/members/${encodeURIComponent(member.id)}/screen`);
  const coreBin = config.coreBin ?? "herdr-core";
  if (!Bun.which(coreBin)) throw new CliError(`herdr-core를 찾을 수 없습니다: ${coreBin}`);
  const proc = Bun.spawn([coreBin, "attach", member.paneId], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: {
    ...process.env, HC_SOCKET: config.coreSocket ?? join(config.home, "run", "core.sock"), HC_SESSION: "iamceo",
    XDG_STATE_HOME: join(config.home, "core-state"), XDG_CONFIG_HOME: join(config.home, "core-config"),
  } });
  const code = await proc.exited;
  if (code !== 0) throw new CliError(`터미널 연결이 끝났습니다(${code})`);
}

// ---- setup ----
function lineReader(): { ask(question: string, fallback: string): Promise<string>; close(): void } {
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question, fallback) {
      process.stdout.write(`${question} [${fallback}]: `);
      const { value, done } = await lines.next();
      if (done) process.stdout.write("\n");
      return (done ? "" : String(value).trim()) || fallback;
    },
    close: () => rl.close(),
  };
}

/** 접근 범위 답을 config.json 의 hosts 로 바꾼다. undefined 는 기본(이 컴퓨터 + Tailscale 자동). */
function hostsFor(answer: string): string[] | undefined {
  if (answer === "local") return undefined;
  if (answer === "lan") {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === "IPv4" && !a.internal && !isTailscaleV4(a.address));
    if (!lan) throw new CliError("같은 망의 주소를 찾지 못했습니다. --hosts 로 직접 적어 주세요");
    return ["127.0.0.1", ...(detectTailscaleIp() ? [detectTailscaleIp()!] : []), lan.address];
  }
  const hosts = answer.split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) throw new CliError(`접근 범위 값이 잘못되었습니다: ${answer}`);
  for (const host of hosts) {
    if (host === "0.0.0.0" || host === "::") throw new CliError("모든 주소(0.0.0.0)로는 열지 않습니다. 쓸 주소를 직접 적어 주세요");
    if (!/^[0-9a-fA-F:.]+$/.test(host)) throw new CliError(`주소 값이 잘못되었습니다: ${host}`);
  }
  return hosts;
}

async function setup(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { backend: { type: "string" }, port: { type: "string" }, hosts: { type: "string" } } });
  const [{ Bus }, { openDb }, { Store }] = await Promise.all([
    import("../server/bus.ts"),
    import("../server/db.ts"),
    import("../server/store.ts"),
  ]);
  const config = loadConfig();
  console.log(`데이터 폴더: ${config.home}\n실행기: herdr-core (${config.coreBin ?? "herdr-core"})`);
  for (const cli of [config.claudeBin, config.codexBin ?? "codex"]) if (!Bun.which(cli)) console.log(`${cli} 명령을 찾지 못했습니다.`);
  if (values.backend && values.backend !== "core") throw new CliError("실행기는 herdr-core 하나입니다. --backend 옵션은 core만 지원합니다");

  const db = openDb(config.dbPath);
  const store = new Store(db, new Bus());
  const current = store.getSettings().backend;
  const reader = lineReader();
  try {
    const portText = values.port ?? (await reader.ask("포트", String(config.port || DEFAULT_PORT)));
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(`포트 값이 잘못되었습니다: ${portText}`);

    console.log("접근 범위:\n  local  이 컴퓨터와 Tailscale(켜져 있으면 폰에서 그 주소로)\n  lan    같은 망의 다른 기기까지\n  유지   지금 설정 그대로");
    const scope = values.hosts ?? (await reader.ask("접근 범위", config.hostsAuto ? "local" : "유지"));
    const hosts = scope === "유지" ? null : hostsFor(scope);

    store.patchSettings({ backend: "core" });
    if (port !== config.port) updateConfigFile({ port });
    if (hosts !== null) updateConfigFile({ hosts });
    const after = loadConfig();
    console.log(`\n설정했습니다: herdr-core, 포트 ${port}\n주소: ${publicUrls({ ...after, port }).join(" · ")}\n접속 코드: ${config.accessCode}\n서버 켜기: iamceo serve (서비스로 두려면 iamceo service install). 이미 켜져 있으면 다시 켜야 적용됩니다.\n직원 규칙을 고치려면: iamceo roles export (${config.rolesDir})`);
    if (process.env.IAMCEO_PORT) console.log(`IAMCEO_PORT=${process.env.IAMCEO_PORT} 환경변수가 설정 파일보다 앞섭니다.`);
  } finally {
    reader.close();
    db.close();
  }
}

// ---- open · status ----
function open(): void {
  const config = loadConfig();
  console.log(`주소: ${publicUrls(config).join(" · ")}\n접속 코드: ${config.accessCode}`);
}

async function status(): Promise<void> {
  const config = loadConfig();
  const health = await api<{ ok: boolean; version: string }>(config, "/api/health");
  const boot = await api<Bootstrap>(config, "/api/bootstrap");
  const herdr = boot.herdr;
  console.log(`IAMCEO ${health.version} 실행 중: ${boot.urls.join(" · ")}`);
  console.log(`실행기: herdr-core · ${boot.runtime?.core.available ? "연결됨" : "연결 안 됨"}${boot.runtime?.core.detail ? ` (${boot.runtime.core.detail})` : ""}`);
  if (herdr.warning) console.log(`  ${herdr.warning}`);
  console.log("프로젝트:");
  for (const p of boot.projects) {
    console.log(`  ${p.name} (${p.id})${p.runnerEnabled ? "" : " [실행 꺼짐]"}: 결재 ${p.inboxCount} · 일하는 중 ${p.workingCount} · 직원 ${p.memberCount}${p.now ? ` · ${p.now.split("\n")[0]}` : ""}`);
  }
}

// ---- join ----
async function join_(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { project: { type: "string" }, name: { type: "string" }, role: { type: "string" }, handle: { type: "string" }, session: { type: "string" } },
  });
  if (!values.name && !values.handle) throw new CliError("--name 또는 --handle 이 필요합니다");
  const config = loadConfig();
  const cwd = process.cwd();
  const joined = await api<{ member: Member; token: string; project: Project }>(config, "/agent/join", {
    method: "POST",
    body: { project: values.project, cwd, name: values.name, role: values.role, handle: values.handle, sessionId: values.session },
  });
  const state = await api<ProjectState>(config, `/api/projects/${encodeURIComponent(joined.project.id)}/state`);
  const conductor = state.members.find((m) => m.kind !== "worker");

  const { renderRole } = await import("../server/roles.ts");
  const runDir = join(config.home, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const rulesFile = join(runDir, `${joined.member.id}.rules.md`);
  writeFileSync(rulesFile, renderRole(joined.member.kind, { PROJECT: joined.project.name, NAME: joined.member.name, ROLE: joined.member.role, CONDUCTOR: conductor?.name ?? "총괄" }, config.rolesDir));

  // --env 는 값을 여러 개 받는 옵션이라 서버 이름이 뒤에 오면 그것까지 값으로 먹는다(claude mcp add 가 거부한다, 실측).
  const add = ["claude", "mcp", "add", "iamceo", "--transport", "stdio", "--scope", "local", "--env", `IAMCEO_URL=${localUrl(config)}`, "--env", `IAMCEO_TOKEN=${joined.token}`, "--", ...selfCommand("mcp")];
  console.log(`${joined.project.name} 의 직원 ${joined.member.name}(${joined.member.handle})으로 등록했습니다.\n`);
  console.log(`1. 이 폴더(${cwd})에서 MCP 를 연결합니다(토큰이 들어 있으니 남에게 보이지 마세요):\n   ${add.map(shellQuote).join(" ")}\n`);
  console.log(`2. 규칙 파일: ${rulesFile}\n   새로 띄울 때: claude --append-system-prompt-file ${shellQuote(rulesFile)}\n   이미 떠 있는 세션이면 /mcp 로 다시 연결한 뒤 이 파일을 읽고 따르라고 입력합니다.`);
}

// ---- import ----
async function importDump(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { name: { type: "string" }, cwd: { type: "string" } } });
  const file = positionals[0];
  if (!file) throw new CliError("덤프 파일이 필요합니다: iamceo import <덤프.json> [--name 이름] [--cwd 폴더]");
  const { describeImport, runImport } = await import("../scripts/import-artifact.ts");
  try {
    console.log(describeImport(await runImport({ file, name: values.name, cwd: values.cwd })));
  } catch (e) {
    throw new CliError((e as Error).message);
  }
}

// ---- service ----
const SERVICE_LABEL = "com.iamceo.server";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** launchd 는 로그인 셸의 PATH 를 모른다. 기본 자리에 더해, 등록하는 셸에서 찾은 claude·herdr 폴더(nvm·npm 전역 등)를 앞에 둔다. */
export function servicePath(home: string, found: (string | null)[] = []): string {
  const base = [join(home, ".bun/bin"), join(home, ".npm-global/bin"), join(home, ".npm/bin"), join(home, ".volta/bin"), join(home, ".asdf/shims"), "/opt/homebrew/bin", join(home, ".local/bin"), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const extra = found.filter((p): p is string => !!p && p.startsWith("/")).map((p) => dirname(p));
  return [...new Set([...extra, ...base])].join(":");
}

export function launchdPlist(opts: { program: string[]; home: string; logDir: string; workingDir: string; env?: Record<string, string>; path?: string }): string {
  const string = (s: string) => `<string>${xmlEscape(s)}</string>`;
  const env: Record<string, string> = {
    PATH: opts.path ?? servicePath(opts.home),
    ...opts.env,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(SERVICE_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${opts.program.map(string).join("\n    ")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    ${Object.entries(env).map(([k, v]) => `<key>${xmlEscape(k)}</key>\n    ${string(v)}`).join("\n    ")}
  </dict>
  <key>WorkingDirectory</key>
  ${string(opts.workingDir)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  ${string(join(opts.logDir, "server.log"))}
  <key>StandardErrorPath</key>
  ${string(join(opts.logDir, "server.err.log"))}
</dict>
</plist>
`;
}

function launchctl(...args: string[]): { ok: boolean; output: string } {
  const p = Bun.spawnSync(["launchctl", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, output: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
}

function requireOwnedService(plistPath: string, dataHome: string): void {
  if (!existsSync(plistPath)) throw new CliError("같은 서비스 이름을 쓰는 다른 실행이 있어 변경하지 않았습니다");
  const converted = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", plistPath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let value: { Label?: string; ProgramArguments?: string[]; EnvironmentVariables?: Record<string, string> };
  try { value = JSON.parse(converted.stdout.toString()); } catch { throw new CliError("기존 서비스의 소유를 확인하지 못해 변경하지 않았습니다"); }
  const args = value.ProgramArguments;
  const ownerHome = value.EnvironmentVariables?.IAMCEO_HOME ?? join(homedir(), ".iamceo");
  if (value.Label !== SERVICE_LABEL || !Array.isArray(args) || args.at(-1) !== "serve" || !args.some((arg) => /(?:^|\/)iamceo(?:\.ts)?$/.test(arg)) || resolve(ownerHome) !== resolve(dataHome)) {
    throw new CliError("다른 IAMCEO 설치 또는 다른 프로그램의 서비스여서 변경하지 않았습니다");
  }
}

function service(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "dry-run": { type: "boolean" } } });
  const action = positionals[0];
  if (action !== "install" && action !== "uninstall") throw new CliError("iamceo service install|uninstall [--dry-run]");
  const dry = values["dry-run"] === true;
  if (!dry && process.env.IAMCEO_TEST === "1") throw new CliError("IAMCEO_TEST=1 에서는 launchd 에 등록하지 않습니다. --dry-run 을 쓰세요.");
  if (!dry && process.platform !== "darwin") throw new CliError("launchd 서비스는 macOS 에서만 됩니다");

  const home = homedir();
  const plistPath = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const target = `gui/${userInfo().uid}`;
  if (action === "uninstall") {
    if (dry) return console.log(`지울 파일: ${plistPath}\n실행할 명령: launchctl bootout ${target}/${SERVICE_LABEL}`);
    requireOwnedService(plistPath, loadConfig().home);
    launchctl("bootout", `${target}/${SERVICE_LABEL}`);
    rmSync(plistPath, { force: true });
    return console.log("서비스를 해제했습니다. 데이터는 그대로 남습니다.");
  }

  const config = loadConfig();
  const logDir = join(config.home, "logs");
  const env = Object.fromEntries(
    (["IAMCEO_HOME", "IAMCEO_PORT", "IAMCEO_CLAUDE_BIN", "IAMCEO_CODEX_BIN", "IAMCEO_CORE_BIN", "IAMCEO_CORE_SOCKET"] as const).flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
  );
  const claude = config.claudeBin.includes("/") ? config.claudeBin : Bun.which(config.claudeBin);
  const codex = config.codexBin?.includes("/") ? config.codexBin : Bun.which(config.codexBin ?? "codex");
  const core = config.coreBin?.includes("/") ? config.coreBin : Bun.which(config.coreBin ?? "herdr-core");
  Object.assign(env, { IAMCEO_HOME: config.home, ...(claude ? { IAMCEO_CLAUDE_BIN: claude } : {}), ...(codex ? { IAMCEO_CODEX_BIN: codex } : {}), ...(core ? { IAMCEO_CORE_BIN: core } : {}), IAMCEO_CORE_SOCKET: config.coreSocket ?? join(config.home, "run", "core.sock") });
  const plist = launchdPlist({ program: selfCommand("serve"), home, logDir, workingDir: home, env, path: servicePath(home, [claude, codex ?? null, core ?? null]) });
  if (dry) return console.log(`쓸 파일: ${plistPath}\n실행할 명령: launchctl bootstrap ${target} ${plistPath}\n\n${plist}`);
  if (!claude) console.log("claude 명령을 찾지 못했습니다. Claude Code 를 설치한 뒤 iamceo service install 을 다시 실행하세요. 그때 찾은 위치를 서비스에 적어 둡니다.");

  const active = launchctl("print", `${target}/${SERVICE_LABEL}`);
  if (existsSync(plistPath) || active.ok) {
    requireOwnedService(plistPath, config.home);
    if (active.ok) return console.log(`이미 관리 중인 서비스가 실행 중입니다: ${plistPath}\n주소: ${publicUrls(config).join(" · ")}`);
  }
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, plist);
  const loaded = launchctl("bootstrap", target, plistPath);
  if (!loaded.ok) throw new CliError(`launchd 등록 실패: ${loaded.output}`);
  console.log(`서비스를 등록했습니다: ${plistPath}\n로그: ${logDir}\n주소: ${publicUrls(config).join(" · ")}`);
}

// ---- 진입 ----
async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "serve":
      return serve();
    case "setup":
      return setup(rest);
    case "mcp":
      return (await import("./mcp-bridge.ts")).runBridge();
    case "join":
      return join_(rest);
    case "attach":
      return attach(rest);
    case "status":
      return status();
    case "open":
      return open();
    case "import":
      return importDump(rest);
    case "service":
      return service(rest);
    case "roles": {
      if (rest[0] !== "export") throw new CliError(`쓰는 법: iamceo roles export\n\n${USAGE}`);
      const { exportRoles } = await import("../server/roles.ts");
      const paths = exportRoles(loadConfig().rolesDir);
      return console.log(`기본 역할 템플릿을 꺼냈습니다:\n${paths.map((p) => `  ${p}`).join("\n")}\n고치려면 .example 을 뺀 이름(<kind>.md)으로 저장하세요. 그 파일이 기본 규칙 전체를 대체합니다.`);
    }
    case "version":
    case "--version":
    case "-v":
      return console.log(VERSION);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return console.log(USAGE);
    default:
      throw new CliError(`모르는 명령입니다: ${command}\n\n${USAGE}`);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof CliError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? (e as Error).message : e);
    process.exit(1);
  }
}
