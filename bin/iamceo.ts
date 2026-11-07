#!/usr/bin/env bun
// IAMCEO CLI. mcp 는 세션마다 뜨므로 서버 코드를 끌어오지 않게 명령별로 늦게 불러온다.
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { EFFORTS, type Bootstrap, type Effort, type Member, type Project, type ProjectState } from "../shared/types.ts";
import { DEFAULT_PORT, homeDir, detectTailscaleIp, isTailscaleV4, loadConfig, updateConfigFile, type Config } from "../server/config.ts";

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
  backup [--directory 경로] 검증된 DB·첨부·설정 백업
  restore <백업폴더> --destination 경로 [--clone]
                         별도 빈 홈에 복원하고 발신을 격리한다
  readiness              인증·복구 완료·실행 build ID를 확인한다
  build-id               실행 파일의 build ID를 보여 준다
  service install [--restart] [--dry-run] | uninstall [--dry-run]
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

/** Source runs hash the server inputs; compiled runs hash the installed executable once at startup. */
let buildIdentity: Promise<string> | undefined;
export function buildId(): Promise<string> {
  return buildIdentity ??= (async () => {
    const hash = createHash("sha256");
    if (COMPILED) {
      for await (const chunk of createReadStream(process.execPath)) hash.update(chunk);
    } else {
      const root = resolve(import.meta.dir, "..");
      const files = [...new Bun.Glob("{bin,server,shared}/**/*.{ts,md}").scanSync({ cwd: root })].sort();
      for (const file of ["package.json", "bun.lock", ...files]) {
        hash.update(file).update("\0");
        for await (const chunk of createReadStream(join(root, file))) hash.update(chunk);
        hash.update("\0");
      }
    }
    return hash.digest("hex");
  })();
}

export interface OpsRuntimeOptions {
  owner?: import("../server/home-owner.ts").HomeOwner;
  createOrchestrator?: typeof import("../server/orchestrator.ts").createOrchestrator;
  startServer?: typeof import("../server/http.ts").startServer;
  client?: Pick<import("../server/push/apns.ts").APNsClient, "send" | "status" | "close">;
  backupPolicy?: Partial<import("../server/backup.ts").BackupPolicy>;
  sweepIntervalMs?: number;
}

/** Owns every resource from the pre-DB lock through the last background write. */
export async function startOpsRuntime(config: Config, options: OpsRuntimeOptions = {}) {
  const { acquireHomeOwner } = await import("../server/home-owner.ts");
  const owner = options.owner ?? acquireHomeOwner(config.home);
  let db: import("bun:sqlite").Database | undefined;
  let orch: ReturnType<NonNullable<OpsRuntimeOptions["createOrchestrator"]>> | undefined;
  let server: import("../server/http.ts").RunningServer | undefined;
  let worker: import("../server/push/worker.ts").PushWorker | undefined;
  let backups: import("../server/backup.ts").BackupManager | undefined;
  let client = options.client;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let ready = false;
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => stopped ??= (async () => {
    ready = false;
    clearInterval(sweepTimer);
    unsubscribe?.();
    // Stop ingress and all producers/consumers together, within one outer deadline.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => server?.stop()),
      Promise.resolve().then(() => orch?.shutdown()),
      Promise.resolve().then(() => worker ? worker.shutdown() : client?.close()),
      Promise.resolve().then(() => backups?.stop()),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    try { db?.close(); } finally { owner.release(); }
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "운영 자원 종료 실패");
  })();
  try {
    const [{ Bus }, { openDb }, http, orchestration, { Store }, { PushStore }, { PushEventRecorder }, { PushWorker },
      { APNsClient }, { loadAPNsConfig }, { BackupManager }, { StorageMaintenance, createStorageReferences }] = await Promise.all([
      import("../server/bus.ts"), import("../server/db.ts"), import("../server/http.ts"), import("../server/orchestrator.ts"),
      import("../server/store.ts"), import("../server/push/store.ts"), import("../server/push/events.ts"), import("../server/push/worker.ts"),
      import("../server/push/apns.ts"), import("../server/push/config.ts"), import("../server/backup.ts"), import("../server/storage-maintenance.ts"),
    ]);
    const identity = await buildId();
    db = openDb(config.dbPath);
    client ??= new APNsClient(loadAPNsConfig(config.home));
    const push = new PushStore(db, { providers: () => client!.status() });
    const bus = new Bus();
    const store = new Store(db, bus, new PushEventRecorder(push));
    store.fillRankEfforts(process.env.IAMCEO_TEST === "1" ? "high" : savedClaudeEffort());
    // Pending external effects are uncertain after a crash, never replayable inputs.
    store.transaction(() => {
      for (const receipt of store.listPendingOperations()) if (receipt.status === "pending") store.finishOperation({ ...receipt, status: "unknown",
        code: "restart_reconciliation_required", error: "서버 재시작 후 외부 효과 확인 필요" });
    });
    orch = (options.createOrchestrator ?? orchestration.createOrchestrator)(config, store);
    const runtimeInfo = orch.runtimeInfo.bind(orch);
    orch.runtimeInfo = async () => ({ ...await runtimeInfo(), daemon: { ready, buildId: identity, version: VERSION } });
    const context = { config, store, bus, orch, delivery: orch.deliveryRecovery,
      push: { store: push, providers: () => client!.status(), wake: () => worker?.wake() } };
    server = await (options.startServer ?? http.startServer)(context);
    orch.setServerUrl(server.urls[0]!);
    await orch.initializeRuntime();
    // CoreRunner restores persisted identity-bound leases as it reattaches; only recover may resume the queue.
    await orch.recover();
    worker = new PushWorker(push, client, { onError: () => console.error("푸시 저장 오류") });
    unsubscribe = bus.subscribe(() => { void worker!.wake().catch(() => console.error("푸시 저장 오류")); });
    worker.start();
    const backupDir = join(config.home, "backups");
    backups = new BackupManager({ home: config.home, backupDir, policy: options.backupPolicy });
    // Surface the first backup failure; periodic failures remain visible in diagnostics.
    try { await backups.run(); } catch { console.error("정기 백업 실패"); }
    backups.start();
    const storage = new StorageMaintenance({ uploadsDir: config.uploadsDir, inboxDir: config.inboxDir, backupDir,
      references: createStorageReferences(store, config.inboxDir) });
    const sweep = () => {
      try { if (storage.sweep().errors.length) console.error("저장소 정리 중 보존된 오류 항목이 있습니다"); }
      catch { console.error("저장소 정리 실패"); }
      if (backups?.lastError) console.error("정기 백업 실패");
    };
    sweep();
    sweepTimer = setInterval(sweep, Math.max(1, options.sweepIntervalMs ?? 3_600_000));
    sweepTimer.unref();
    ready = true;
    return { config, store, push, worker, server, backups, storage, stop };
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], "시작 및 정리 실패"); }
    throw error;
  }
}

/** A timeout never releases ownership while a background task could still write. The CLI exits at the deadline. */
export async function shutdownWithinBudget(stop: () => Promise<void>, timeoutMs = 15_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(stop), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CliError("15초 종료 예산을 초과했습니다")), Math.min(Math.max(timeoutMs, 1), 15_000));
    })]);
  } finally { clearTimeout(timer); }
}

async function serve(): Promise<void> {
  const { acquireHomeOwner } = await import("../server/home-owner.ts");
  const owner = acquireHomeOwner(homeDir());
  let runtime: Awaited<ReturnType<typeof startOpsRuntime>> | undefined;
  let starting: Promise<Awaited<ReturnType<typeof startOpsRuntime>>> | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const hardStop = setTimeout(() => process.exit(1), 15_000);
    try {
      await shutdownWithinBudget(async () => { runtime ??= await starting; await runtime?.stop(); });
      clearTimeout(hardStop);
      process.exit(0);
    } catch { process.exit(1); }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
  try {
    const config = loadConfig();
    if (!COMPILED) process.chdir(resolve(import.meta.dir, ".."));
    if (config.port !== 0 && await portInUse(config.hosts[0]!, config.port)) throw new CliError(`포트 ${config.port} 을 이미 쓰고 있습니다. iamceo status 로 확인하세요.`);
    starting = startOpsRuntime(config, { owner });
    runtime = await starting;
    if (!stopping) {
      console.log(`IAMCEO 서버: ${runtime.server.urls.join(" · ")}`);
      console.log("접속 코드는 iamceo open 으로 봅니다.");
    }
  } catch (error) {
    if (!starting) owner.release();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
    throw error;
  }
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
  const { acquireHomeOwner } = await import("../server/home-owner.ts");
  using owner = acquireHomeOwner(homeDir());
  const config = loadConfig();
  console.log(`데이터 폴더: ${config.home}\n실행기: herdr-core (${config.coreBin ?? "herdr-core"})`);
  for (const cli of [config.claudeBin, config.codexBin ?? "codex"]) if (!Bun.which(cli)) console.log(`${cli} 명령을 찾지 못했습니다.`);
  if (values.backend && values.backend !== "core") throw new CliError("실행기는 herdr-core 하나입니다. --backend 옵션은 core만 지원합니다");

  const db = openDb(config.dbPath);
  const store = new Store(db, new Bus());
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
  const { acquireHomeOwner } = await import("../server/home-owner.ts");
  using owner = acquireHomeOwner(homeDir());
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

// ---- backup / separate-path restore ----
async function backup(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { directory: { type: "string" } } });
  const { acquireHomeOwner } = await import("../server/home-owner.ts");
  using owner = acquireHomeOwner(homeDir());
  const config = loadConfig();
  const { BackupManager } = await import("../server/backup.ts");
  const manager = new BackupManager({ home: config.home, backupDir: resolve(values.directory ?? join(config.home, "backups")) });
  const snapshot = await manager.run(true);
  console.log(`백업 검증 완료: ${snapshot!.directory}`);
}

async function restore(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { destination: { type: "string" }, clone: { type: "boolean" } } });
  if (positionals.length !== 1 || !values.destination) throw new CliError("iamceo restore <백업폴더> --destination <별도 빈 홈> [--clone]");
  const { restoreBackup } = await import("../server/restore.ts");
  const result = restoreBackup({ snapshotDir: resolve(positionals[0]!), destinationHome: resolve(values.destination), mode: values.clone ? "clone" : "same-host" });
  console.log(`복원 검증 완료: ${result.home}\n발신 꺼짐: 세션·lease·전달 증거 조정 후 명시적으로 재개하세요.`);
}

export async function waitForReadiness(config: Config, options: {
  expectedBuildId?: string; timeoutMs?: number; pollMs?: number; fetch?: typeof fetch;
} = {}): Promise<void> {
  const expected = options.expectedBuildId ?? await buildId();
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? 30_000);
  let reason = "서버 응답 없음";
  do {
    try {
      // Bootstrap is authenticated by HTTP. Liveness alone cannot confirm the running binary or recovery.
      const response = await (options.fetch ?? fetch)(`${localUrl(config)}/api/bootstrap`, {
        headers: { Authorization: `Bearer ${config.accessCode}` }, redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))),
      });
      if (response.status === 401 || response.status === 403) throw new CliError("인증된 준비 확인 실패");
      const body = await response.json() as { runtime?: { daemon?: { ready?: boolean; buildId?: string; version?: string } } };
      const daemon = body.runtime?.daemon;
      if (response.ok && daemon?.ready === true && daemon.buildId === expected && daemon.version === VERSION) return;
      reason = !response.ok ? `HTTP ${response.status}` : !daemon ? "준비/build ID 계약 없음" : daemon.buildId !== expected || daemon.version !== VERSION ? "실행 build ID 불일치" : "복구 완료 대기";
    } catch (error) {
      if (error instanceof CliError) throw error;
      reason = "서버 응답 없음";
    }
    if (Date.now() < deadline) await Bun.sleep(Math.min(Math.max(1, options.pollMs ?? 250), deadline - Date.now()));
  } while (Date.now() < deadline);
  throw new CliError(`서비스 준비 확인 실패: ${reason}. 로그를 확인하세요.`);
}

/** launchd owns only /dev/null FDs. This dedicated supervisor owns and rotates both real log FDs. */
async function serviceRun(): Promise<void> {
  const { BoundedLogWriter } = await import("../server/log-writer.ts");
  const { acquireHomeOwner } = await import("../server/home-owner.ts");
  const logs = join(homeDir(), "logs");
  using logsOwner = acquireHomeOwner(logs);
  const stdout = new BoundedLogWriter(join(logs, "server.log"));
  let stderr: InstanceType<typeof BoundedLogWriter> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const signalChild = (signal: "SIGTERM" | "SIGINT" | "SIGHUP") => () => {
    child?.kill(signal);
    hardStop ??= setTimeout(() => child?.kill("SIGKILL"), 15_000);
  };
  const term = signalChild("SIGTERM"), interrupt = signalChild("SIGINT"), hup = signalChild("SIGHUP");
  try {
    stderr = new BoundedLogWriter(join(logs, "server.err.log"));
    child = Bun.spawn(selfCommand("serve"), { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, IAMCEO_LOG_WRITER: "0" } });
    process.on("SIGTERM", term); process.on("SIGINT", interrupt); process.on("SIGHUP", hup);
    const pump = async (stream: ReadableStream<Uint8Array>, writer: InstanceType<typeof BoundedLogWriter>) => {
      const reader = stream.getReader();
      try { for (;;) { const { done, value } = await reader.read(); if (done) return; writer.write(value); } }
      finally { reader.releaseLock(); }
    };
    const guard = (job: Promise<void>) => job.catch(error => { term(); throw error; });
    const results = await Promise.allSettled([guard(pump(child.stdout as ReadableStream<Uint8Array>, stdout)), guard(pump(child.stderr as ReadableStream<Uint8Array>, stderr)), child.exited]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    process.exitCode = await child.exited;
    if (stdout.failed || stderr.failed) process.exitCode = 1;
  } finally {
    clearTimeout(hardStop);
    process.off("SIGTERM", term); process.off("SIGINT", interrupt); process.off("SIGHUP", hup);
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    try { stdout.close(); } finally { stderr?.close(); }
    if (stdout.failed || stderr?.failed) process.exitCode = 1;
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
  ${string("/dev/null")}
  <key>StandardErrorPath</key>
  ${string("/dev/null")}
</dict>
</plist>
`;
}

function launchctl(...args: string[]): { ok: boolean; output: string } {
  const p = Bun.spawnSync(["launchctl", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, output: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
}

function serviceEnvironment(plistPath: string): Record<string, string> {
  const converted = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", plistPath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const value = JSON.parse(converted.stdout.toString()) as { EnvironmentVariables?: Record<string, string> };
    return value.EnvironmentVariables ?? {};
  } catch { throw new CliError("기존 서비스의 환경을 읽지 못했습니다"); }
}

function requireOwnedService(plistPath: string, dataHome: string): void {
  if (!existsSync(plistPath)) throw new CliError("같은 서비스 이름을 쓰는 다른 실행이 있어 변경하지 않았습니다");
  const converted = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", plistPath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let value: { Label?: string; ProgramArguments?: string[]; EnvironmentVariables?: Record<string, string> };
  try { value = JSON.parse(converted.stdout.toString()); } catch { throw new CliError("기존 서비스의 소유를 확인하지 못해 변경하지 않았습니다"); }
  const args = value.ProgramArguments;
  const ownerHome = value.EnvironmentVariables?.IAMCEO_HOME ?? join(homedir(), ".iamceo");
  if (value.Label !== SERVICE_LABEL || !Array.isArray(args) || !["serve", "service-run"].includes(args.at(-1) ?? "") || !args.some((arg) => /(?:^|\/)iamceo(?:\.ts)?$/.test(arg)) || resolve(ownerHome) !== resolve(dataHome)) {
    throw new CliError("다른 IAMCEO 설치 또는 다른 프로그램의 서비스여서 변경하지 않았습니다");
  }
}

export interface ServiceDependencies {
  home: string;
  config: Config;
  program: string[];
  launchctl: (...args: string[]) => { ok: boolean; output: string };
  readiness: (config: Config) => Promise<void>;
}

export async function service(args: string[], dependencies?: ServiceDependencies): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "dry-run": { type: "boolean" }, restart: { type: "boolean" } } });
  const action = positionals[0];
  if (action !== "install" && action !== "uninstall") throw new CliError("iamceo service install|uninstall [--dry-run]");
  const dry = values["dry-run"] === true;
  if (!dry && process.env.IAMCEO_TEST === "1" && !dependencies) throw new CliError("IAMCEO_TEST=1 에서는 launchd 에 등록하지 않습니다. --dry-run 을 쓰세요.");
  if (!dry && process.platform !== "darwin") throw new CliError("launchd 서비스는 macOS 에서만 됩니다");

  const home = dependencies?.home ?? homedir();
  const control = dependencies?.launchctl ?? launchctl;
  const readiness = dependencies?.readiness ?? waitForReadiness;
  const plistPath = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const target = `gui/${userInfo().uid}`;
  if (action === "uninstall") {
    if (dry) return console.log(`지울 파일: ${plistPath}\n실행할 명령: launchctl bootout ${target}/${SERVICE_LABEL}`);
    requireOwnedService(plistPath, (dependencies?.config ?? loadConfig()).home);
    const result = control("bootout", `${target}/${SERVICE_LABEL}`);
    if (!result.ok) throw new CliError(`launchd 해제 실패: ${result.output}`);
    rmSync(plistPath, { force: true });
    return console.log("서비스를 해제했습니다. 데이터는 그대로 남습니다.");
  }

  const inherited = !dry && existsSync(plistPath) ? serviceEnvironment(plistPath) : {};
  const config = dependencies?.config ?? loadConfig({ ...inherited, ...process.env });
  const logDir = join(config.home, "logs");
  const serviceEnv = { ...inherited, ...process.env };
  const env = Object.fromEntries(
    (["IAMCEO_HOME", "IAMCEO_PORT", "IAMCEO_CLAUDE_BIN", "IAMCEO_CODEX_BIN", "IAMCEO_CORE_BIN", "IAMCEO_CORE_SOCKET"] as const).flatMap((k) => (serviceEnv[k] ? [[k, serviceEnv[k]!]] : [])),
  );
  const claude = config.claudeBin.includes("/") ? config.claudeBin : Bun.which(config.claudeBin);
  const codex = config.codexBin?.includes("/") ? config.codexBin : Bun.which(config.codexBin ?? "codex");
  const core = config.coreBin?.includes("/") ? config.coreBin : Bun.which(config.coreBin ?? "herdr-core");
  Object.assign(env, { IAMCEO_LOG_WRITER: "1", IAMCEO_HOME: config.home, ...(claude ? { IAMCEO_CLAUDE_BIN: claude } : {}), ...(codex ? { IAMCEO_CODEX_BIN: codex } : {}), ...(core ? { IAMCEO_CORE_BIN: core } : {}), IAMCEO_CORE_SOCKET: config.coreSocket ?? join(config.home, "run", "core.sock") });
  const plist = launchdPlist({ program: dependencies?.program ?? selfCommand("serve"), home, logDir, workingDir: home, env, path: servicePath(home, [claude, codex ?? null, core ?? null]) });
  if (dry) return console.log(`쓸 파일: ${plistPath}\n로그: ${join(logDir, "server.log")}\n실행할 명령: launchctl bootstrap ${target} ${plistPath}\n\n${plist}`);
  if (!claude) console.log("claude 명령을 찾지 못했습니다. Claude Code 를 설치한 뒤 iamceo service install 을 다시 실행하세요. 그때 찾은 위치를 서비스에 적어 둡니다.");

  const active = control("print", `${target}/${SERVICE_LABEL}`);
  if (existsSync(plistPath) || active.ok) {
    requireOwnedService(plistPath, config.home);
    if (active.ok && !values.restart) {
      await readiness(config);
      return console.log(`서비스 준비 확인 완료: ${plistPath}`);
    }
    if (active.ok) {
      const unloaded = control("bootout", `${target}/${SERVICE_LABEL}`);
      if (!unloaded.ok) throw new CliError(`서비스 재시작 실패: ${unloaded.output}`);
    }
  }
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, plist);
  const loaded = control("bootstrap", target, plistPath);
  if (!loaded.ok) throw new CliError(`launchd 등록 실패: ${loaded.output}`);
  await readiness(config);
  console.log(`서비스를 등록했습니다: ${plistPath}\n로그: ${logDir}\n주소: ${publicUrls(config).join(" · ")}`);
}

// ---- 진입 ----
async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "serve":
      return process.env.IAMCEO_LOG_WRITER === "1" ? serviceRun() : serve();
    case "service-run":
      return serviceRun();
    case "backup":
      return backup(rest);
    case "restore":
      return restore(rest);
    case "readiness":
      await waitForReadiness(loadConfig());
      return console.log("인증·복구·build ID 준비 확인 완료");
    case "build-id":
      return console.log(await buildId());
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
