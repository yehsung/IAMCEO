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
  attach <팀원ID>        관리 중인 CLI 터미널을 연다
  join [--project 이름] [--name 이름] [--role 역할] [--handle 핸들] [--session UUID]
                         내가 띄운 CLI 를 팀장으로 등록하고 연결 명령을 알려 준다
  import <덤프.json> [--name 이름] [--cwd 폴더]
                         기존 운영판 덤프를 프로젝트로 가져온다
  backup [--directory 경로] 검증된 DB·첨부·설정 백업
  restore <백업폴더> --destination 경로 [--clone]
                         별도 빈 홈에 복원하고 발신을 격리한다
  restore reconcile      서버가 꺼진 IAMCEO_HOME의 큐·푸시를 보수적으로 조정한다
  restore resume         조정 완료 후 발신을 허용한다. 이후 serve로 시작한다
  readiness              인증·복구 완료·실행 build ID를 확인한다
  auth rotate            이 Mac의 접속 코드를 교체하고 모든 연결·QR을 만료시킨다
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
  /** First expensive maintenance runs after readiness and a quiet startup window. */
  maintenanceDelayMs?: number;
  /** Close ingress immediately on a planned shutdown, even while recovery is awaiting I/O. */
  signal?: AbortSignal;
}

/** Owns every resource from the pre-DB lock through the last background write. */
export async function startOpsRuntime(config: Config, options: OpsRuntimeOptions = {}) {
  const startedAt = performance.now();
  const { LoopMonitor } = await import("../server/loop-monitor.ts");
  const { acquireHomeOwner } = await import("../server/home-owner.ts");
  const owner = options.owner ?? acquireHomeOwner(config.home);
  let db: import("bun:sqlite").Database | undefined;
  let orch: ReturnType<NonNullable<OpsRuntimeOptions["createOrchestrator"]>> | undefined;
  let server: import("../server/http.ts").RunningServer | undefined;
  let worker: import("../server/push/worker.ts").PushWorker | undefined;
  let backups: import("../server/backup.ts").BackupManager | undefined;
  let client = options.client;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let vitalsTimer: ReturnType<typeof setInterval> | undefined;
  let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;
  const loopMonitor = new LoopMonitor({ cpu: () => { const used = process.cpuUsage(); return (used.user + used.system) / 1000; } });
  const stopIngress = () => {
    ready = false;
    // The runtime's stop collects failures after initialization releases its DB work.
    void server?.stop().catch(() => {});
  };
  let unsubscribe: (() => void) | undefined;
  let ready = false;
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => stopped ??= (async () => {
    ready = false;
    clearInterval(sweepTimer);
    clearInterval(vitalsTimer);
    clearTimeout(maintenanceTimer);
    unsubscribe?.();
    // Stop ingress and all producers/consumers together, within one outer deadline.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => server?.stop()),
      Promise.resolve().then(() => orch?.shutdown()),
      Promise.resolve().then(() => worker ? worker.shutdown() : client?.close()),
      Promise.resolve().then(() => backups?.stop()),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    options.signal?.removeEventListener("abort", stopIngress);
    try { db?.close(); } finally { loopMonitor.stop(); owner.release(); }
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "운영 자원 종료 실패");
  })();
  options.signal?.addEventListener("abort", stopIngress, { once: true });
  try {
    const [{ Bus }, { openDb }, http, orchestration, { Store }, { PushStore }, { PushEventRecorder }, { PushWorker },
      { APNsClient }, { loadAPNsConfig }, { BackupManager }, { StorageMaintenance, createStorageReferences }, { requireRestoreOutboundEnabled }] = await Promise.all([
      import("../server/bus.ts"), import("../server/db.ts"), import("../server/http.ts"), import("../server/orchestrator.ts"),
      import("../server/store.ts"), import("../server/push/store.ts"), import("../server/push/events.ts"), import("../server/push/worker.ts"),
      import("../server/push/apns.ts"), import("../server/push/config.ts"), import("../server/backup.ts"), import("../server/storage-maintenance.ts"),
      import("../server/restore.ts"),
    ]);
    const identity = await buildId();
    db = openDb(config.dbPath);
    requireRestoreOutboundEnabled(db, config.home);
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
    // TS private methods are ordinary properties at runtime; preserve this and the existing scheduler.
    // The runtime timer test guards this coupling to the onTick method name.
    const onTick = Reflect.get(orch, "onTick") as () => void;
    const tickOwner = orch;
    Reflect.set(orch, "onTick", () => loopMonitor.run("timer:onTick", () => onTick.call(tickOwner)));
    const runtimeInfo = orch.runtimeInfo.bind(orch);
    orch.runtimeInfo = async () => ({ ...await runtimeInfo(), daemon: { ready, buildId: identity, version: VERSION }, ...(backups ? { backup: backups.status() } : {}) });
    const context = { config, store, bus, orch, delivery: orch.deliveryRecovery, loopMonitor,
      daemon: () => ({ ready, buildId: identity, version: VERSION }),
      push: { store: push, providers: () => client!.status(), wake: () => worker?.wake() } };
    server = await (options.startServer ?? http.startServer)(context);
    if (options.signal?.aborted) stopIngress();
    // 팀장의 도구 연결은 이 Mac 안에서만 받는다. loopback 주소가 열려 있으면 그 주소를 쓴다.
    orch.setServerUrl(server.urls.find(url => /^http:\/\/(127\.\d+\.\d+\.\d+|\[::1\]|localhost)[:/]/.test(url)) ?? server.urls[0]!);
    if (!options.signal?.aborted) await orch.initializeRuntime();
    // CoreRunner restores persisted identity-bound leases as it reattaches; only recover may resume the queue.
    if (!options.signal?.aborted) await orch.recover();
    worker = new PushWorker(push, client, { onError: () => console.error("푸시 저장 오류") });
    if (!options.signal?.aborted) {
      unsubscribe = bus.subscribe(() => { void worker!.wake().catch(() => console.error("푸시 저장 오류")); });
      worker.start();
    }
    const backupDir = join(config.home, "backups");
    backups = new BackupManager({ home: config.home, backupDir, policy: options.backupPolicy, loopMonitor });
    const storage = new StorageMaintenance({ uploadsDir: config.uploadsDir, inboxDir: config.inboxDir, backupDir,
      references: createStorageReferences(store, config.inboxDir) });
    const { readVitals, vitalsLine } = await import("../server/vitals.ts");
    const vitals = () => loopMonitor.run("timer:vitals", () => {
      try { const { line, warn } = vitalsLine(readVitals(db!, config.dbPath)); (warn ? console.warn : console.info)(line); }
      catch { /* 진단 한 줄이 서버를 흔들면 안 된다 */ }
    });
    const sweep = () => loopMonitor.run("timer:storageSweep", () => {
      try { if (storage.sweep().errors.length) console.error("저장소 정리 중 보존된 오류 항목이 있습니다"); }
      catch { console.error("저장소 정리 실패"); }
      if (backups?.lastError) console.error(`정기 백업 실패 중: ${backups.status().cause} (연속 ${backups.status().failures}회)`);
    });
    ready = !options.signal?.aborted;
    const startupMs = performance.now() - startedAt;
    if (ready) {
      console.info(`[startup] ready durationMs=${startupMs.toFixed(1)} pid=${process.pid} version=${VERSION}`);
      maintenanceTimer = setTimeout(() => {
        backups!.start();
        sweep();
        sweepTimer = setInterval(sweep, Math.max(1, options.sweepIntervalMs ?? 3_600_000));
        sweepTimer.unref();
        vitals();
        vitalsTimer = setInterval(vitals, 5 * 60_000);
        vitalsTimer.unref();
      }, Math.max(0, options.maintenanceDelayMs ?? 120_000));
      maintenanceTimer.unref();
    }
    return { config, store, push, worker, server, backups, storage, startupMs, stop };
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

/** 서버가 떠 있는 동안 Mac 의 유휴 잠자기만 막는다(화면 꺼짐·덮개 닫기는 그대로). -w 라 서버가 어떻게 끝나도 함께 끝난다.
 * config.json 의 keepAwake: false 로 끈다. */
export function keepAwake(config: Pick<Config, "keepAwake">, options: {
  platform?: string; test?: boolean; pid?: number; spawn?: (command: string[]) => { kill(): void };
} = {}): (() => void) | undefined {
  if (config.keepAwake === false || (options.test ?? process.env.IAMCEO_TEST === "1") || (options.platform ?? process.platform) !== "darwin") return undefined;
  try {
    const spawn = options.spawn ?? ((command: string[]) => {
      const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      child.unref();
      return child;
    });
    const child = spawn(["/usr/bin/caffeinate", "-i", "-w", String(options.pid ?? process.pid)]);
    return () => { try { child.kill(); } catch { /* 이미 끝났다 */ } };
  } catch {
    console.error("잠자기 방지를 켜지 못했습니다. 자리를 비우면 Mac 이 잠들 수 있습니다.");
    return undefined;
  }
}

async function serve(): Promise<void> {
  const { acquireHomeOwner } = await import("../server/home-owner.ts");
  const owner = acquireHomeOwner(homeDir());
  let runtime: Awaited<ReturnType<typeof startOpsRuntime>> | undefined;
  let starting: Promise<Awaited<ReturnType<typeof startOpsRuntime>>> | undefined;
  let stopping = false;
  let awake: (() => void) | undefined;
  const shutdown = new AbortController();
  const stop = async (signal?: string) => {
    if (stopping) return;
    stopping = true;
    console.info(`[shutdown] ${typeof signal === "string" ? signal : "stop"} pid=${process.pid}`);
    shutdown.abort();
    awake?.();
    const hardStop = setTimeout(() => process.exit(1), 15_000);
    try {
      await shutdownWithinBudget(async () => { runtime ??= await starting; await runtime?.stop(); });
      clearTimeout(hardStop);
      process.exit(0);
    } catch { process.exit(1); }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
  // 타이머 콜백의 예외나 놓친 거부 한 번에 서버가 통째로 죽지 않게 한다. 계속 쏟아질 때만 정상 종료로 내려간다.
  const { createCrashGuard } = await import("../server/crash-guard.ts");
  const uninstallGuard = createCrashGuard({ restart: () => { void stop("crash-guard"); } }).install();
  try {
    const config = loadConfig();
    if (!COMPILED) process.chdir(resolve(import.meta.dir, ".."));
    if (config.port !== 0 && await portInUse(config.hosts[0]!, config.port)) throw new CliError(`포트 ${config.port} 을 이미 쓰고 있습니다. iamceo status 로 확인하세요.`);
    starting = startOpsRuntime(config, { owner, signal: shutdown.signal });
    runtime = await starting;
    if (!stopping) {
      awake = keepAwake(config);
      console.log(`IAMCEO 서버: ${runtime.server.urls.join(" · ")}`);
      console.log("접속 코드는 iamceo open 으로 봅니다.");
    }
  } catch (error) {
    if (!starting) owner.release();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
    uninstallGuard();
    throw error;
  }
}

async function attach(args: string[]): Promise<void> {
  if (args.length !== 1 || !/^m_[A-Za-z0-9_-]+$/.test(args[0]!)) throw new CliError("쓰는 법: iamceo attach <팀원ID>");
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
    console.log(`\n설정했습니다: herdr-core, 포트 ${port}\n주소: ${publicUrls({ ...after, port }).join(" · ")}\n접속 코드: ${config.accessCode}\n서버 켜기: iamceo serve (서비스로 두려면 iamceo service install). 이미 켜져 있으면 다시 켜야 적용됩니다.\n팀원 규칙을 고치려면: iamceo roles export (${config.rolesDir})`);
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
  try {
    const response = await fetch(`${localUrl(config)}/api/readiness`, { headers: { Authorization: `Bearer ${config.accessCode}` },
      redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (response.status === 401 || response.status === 403) throw new CliError("인증된 진단 확인 실패");
    if (response.status === 200 || response.status === 503) {
      const diagnostic = await response.json() as { ok: boolean; daemon: { buildId: string } | null;
        schema: { version: number; supportedVersion: number }; hosts: { host: string; state: string }[] };
      console.log(`준비 상태: ${diagnostic.ok ? "완료" : "미완료"} · build ${diagnostic.daemon?.buildId ?? "확인 불가"} · DB ${diagnostic.schema.version}/${diagnostic.schema.supportedVersion}`);
      for (const binding of diagnostic.hosts) if (binding.state === "failed") console.log(`  접속 주소 열기 실패: ${binding.host} (자동 재시도 중)`);
    } else { console.log(`준비 진단 확인 불가 (HTTP ${response.status})`); }
  } catch (error) {
    if (error instanceof CliError) throw error;
    console.log("준비 진단 확인 불가");
  }
  console.log("프로젝트:");
  for (const p of boot.projects) {
    console.log(`  ${p.name} (${p.id})${p.runnerEnabled ? "" : " [실행 꺼짐]"}: 결재 ${p.inboxCount} · 일하는 중 ${p.workingCount} · 팀원 ${p.memberCount}${p.now ? ` · ${p.now.split("\n")[0]}` : ""}`);
  }
}

/** Only a local peer may rotate. A lost response is recovered by explicit local `open`, never replayed. */
export async function rotateAccessCode(config: Config, request: typeof fetch = fetch): Promise<string> {
  const host = config.hosts.find(host => host === "::1" || host === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(host)) ??
    (config.hosts.includes("0.0.0.0") ? "127.0.0.1" : config.hosts.includes("::") ? "::1" : null);
  if (!host || config.port === 0) throw new CliError("로컬 접속 주소와 실행 포트가 필요합니다. loopback host 설정을 확인하세요.");
  let response: Response;
  try {
    response = await request(`http://${host.includes(":") ? `[${host}]` : host}:${config.port}/api/auth/rotate`, {
      method: "POST", headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json" },
      body: "{}", redirect: "error", signal: AbortSignal.timeout(5_000),
    });
  } catch { throw new CliError("접속 코드 교체 결과를 확인하지 못했습니다. 자동 재시도하지 않았습니다. 이 Mac에서 iamceo open으로 현재 코드를 확인하세요."); }
  if (!response.ok) throw new CliError(`접속 코드 교체 실패 (HTTP ${response.status}). 이 Mac에서 iamceo open으로 현재 코드를 확인하세요.`);
  let result: { accessCode: string };
  try { result = parseRotationResult(await response.json()); }
  catch { throw new CliError("교체 응답을 확인하지 못했습니다. 이 Mac에서 iamceo open으로 현재 코드를 확인하세요."); }
  config.accessCode = result.accessCode;
  return result.accessCode;
}

function parseRotationResult(value: unknown): { accessCode: string } {
  // Network input is untrusted even though the public helper returns a typed value.
  if (!value || typeof value !== "object" || !("accessCode" in value) || typeof value.accessCode !== "string" || !value.accessCode.trim()) {
    throw new CliError("접속 코드 교체 응답이 잘못되었습니다");
  }
  return { accessCode: value.accessCode };
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
  console.log(`${joined.project.name} 의 팀원 ${joined.member.name}(${joined.member.handle})으로 등록했습니다.\n`);
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
  if (args[0] === "reconcile" || args[0] === "resume") {
    if (args.length !== 1) throw new CliError("iamceo restore reconcile | iamceo restore resume (IAMCEO_HOME으로 복원 홈 지정, 서버 종료 필요)");
    const { reconcileRestoredHome, resumeRestoredHome } = await import("../server/restore.ts");
    const result = args[0] === "reconcile" ? reconcileRestoredHome(homeDir()) : resumeRestoredHome(homeDir());
    console.log(result.outboundEnabled
      ? `복원 발신 재개 허용: ${result.home}\n이 홈에서 iamceo serve 로 시작하세요. 기존 보류 전달·푸시 기기는 자동 재전송·활성화하지 않습니다.`
      : `복원 큐·푸시 조정 완료: ${result.home}\n발신 꺼짐: iamceo restore resume 으로 명시적으로 재개하세요.`);
    return;
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { destination: { type: "string" }, clone: { type: "boolean" } } });
  if (positionals.length !== 1 || !values.destination) throw new CliError("iamceo restore <백업폴더> --destination <별도 빈 홈> [--clone]");
  const { restoreBackup } = await import("../server/restore.ts");
  const result = restoreBackup({ snapshotDir: resolve(positionals[0]!), destinationHome: resolve(values.destination), mode: values.clone ? "clone" : "same-host" });
  console.log(`복원 검증 완료: ${result.home}\n발신 꺼짐: IAMCEO_HOME을 복원 홈으로 지정하고 restore reconcile → restore resume → serve 순서로 실행하세요. 기존 전달·lease 증거는 보존하며 푸시는 다시 등록·활성화해야 합니다.`);
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
  const { BoundedLogWriter, lineStamper } = await import("../server/log-writer.ts");
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
      // 언제 멈췄고 언제 다시 떴는지 찾을 수 있게 줄마다 받은 시각을 붙인다.
      const stamp = lineStamper();
      try { for (;;) { const { done, value } = await reader.read(); if (done) return; writer.write(stamp(value)); } }
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

/** ProcessType 을 비우면 launchd 가 CPU·디스크를 조이는 '표준 데몬' 등급으로 돌린다. 앱 응답이 이 서버에 달려 있어 Interactive 로 둔다. */
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
  <key>ProcessType</key>
  <string>Interactive</string>
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
  sleep?: (ms: number) => Promise<unknown>;
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
  const sleep = dependencies?.sleep ?? ((ms: number) => Bun.sleep(ms));
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
      // 떠 있는 서비스는 건드리지 않는다. 등록된 설정이 지금 것과 다르면 갱신 방법만 알린다.
      let installed: string | null = null;
      try { installed = readFileSync(plistPath, "utf8"); } catch {}
      if (installed !== plist) console.log("등록된 서비스 설정이 이 버전과 다릅니다. iamceo service install --restart 로 갱신하세요(서버가 잠깐 다시 시작됩니다).");
      return console.log(`서비스 준비 확인 완료: ${plistPath}`);
    }
    if (active.ok) {
      const unloaded = control("bootout", `${target}/${SERVICE_LABEL}`);
      // 서버가 내려가는 동안(최대 15초) bootout 은 36(in progress)을 준다. 실패가 아니라 기다릴 일이다.
      if (!unloaded.ok && !/failed: 36\b|in progress/i.test(unloaded.output)) throw new CliError(`서비스 재시작 실패: ${unloaded.output}`);
      // 다 내려가기 전에 다시 올리면 bootstrap 이 거절돼 서비스가 꺼진 채 남는다.
      for (let i = 0; i < 60 && control("print", `${target}/${SERVICE_LABEL}`).ok; i++) await sleep(500);
    }
  }
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, plist);
  let loaded = control("bootstrap", target, plistPath);
  // 앞 인스턴스 정리가 덜 끝났으면 5(Input/output error)·37(already)로 거절된다. 잠깐 뒤 다시 건다.
  for (let i = 0; i < 5 && !loaded.ok && /failed: (5|37)\b|Input\/output error|already|in progress/i.test(loaded.output); i++) {
    await sleep(1000);
    loaded = control("bootstrap", target, plistPath);
  }
  if (!loaded.ok) {
    const stillLoaded = control("print", `${target}/${SERVICE_LABEL}`).ok;
    throw new CliError(`launchd 등록 실패: ${loaded.output}\n${stillLoaded
      ? "이전 서비스가 아직 내려가지 않았습니다. 잠시 뒤 iamceo service install --restart 를 다시 실행하세요."
      : "지금 서비스가 내려가 있습니다. iamceo service install 을 다시 실행해 올리세요."}`);
  }
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
    case "auth":
      if (rest.length !== 1 || rest[0] !== "rotate") throw new CliError("쓰는 법: iamceo auth rotate");
      return console.log(`접속 코드를 교체했습니다. 모든 기기에서 다시 연결하세요.\n접속 코드: ${await rotateAccessCode(loadConfig())}`);
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
