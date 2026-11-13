#!/usr/bin/env bun
// IAMCEO CLI. mcp 는 세션마다 뜨므로 서버 코드를 끌어오지 않게 명령별로 늦게 불러온다.
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { EFFORTS, type Bootstrap, type Effort, type Member, type Project, type ProjectState } from "../shared/types.ts";
import { DEFAULT_PORT, homeDir, detectTailscaleIp, isTailscaleV4, loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { say } from "../server/cli-text.ts";

const USAGE = `쓰는 법: iamceo <명령>
  serve                  서버를 켠다
  setup [--port 번호] [--hosts local|lan|주소,주소]
                         첫 설정(herdr-core·포트·접근 범위)
  open                   접속 주소와 접속 코드를 보여 준다
  status                 서버와 프로젝트 상태를 본다
  doctor [--json]        이 Mac의 실행 환경을 항목별로 점검하고 고치는 법을 알려 준다(서버가 꺼져 있어도 된다)
  diagnose               진단 파일(~/.iamceo/diagnostics/<시각>.zip)을 만든다. 대화 내용과 접속 코드는 넣지 않는다
  attach <팀장ID>        관리 중인 CLI 터미널을 연다
  join [--project 이름] [--name 이름] [--role 역할] [--handle 핸들] [--session UUID]
                         내가 띄운 CLI 를 팀장으로 등록하고 연결 명령을 알려 준다
  import <덤프.json> [--name 이름] [--cwd 폴더]
                         기존 운영판 덤프를 프로젝트로 가져온다
  backup [--directory 경로] 검증된 DB·첨부·설정 백업
  restore <백업폴더> --destination 경로 [--clone]
                         비어 있거나 없는 홈에 복원하고 발신을 격리한다
  restore reconcile      서버가 꺼진 복원 홈의 보내던 글과 알림을 안전하게 조정한다
  restore resume         조정한 뒤 발신을 허용한다. 그다음 앱에서 '이 Mac에서 시작'을 누른다
  readiness              인증·복구 완료·실행 파일 식별값을 확인한다
  auth rotate [--all-devices]
                         이 Mac의 공용 접속 코드를 교체하고 그 코드로 붙은 연결·QR을 만료시킨다(QR로 연결한 기기는 그대로,
                         --all-devices 면 QR로 연결한 기기의 열쇠도 모두 끊는다. 코드가 새었을 때)
  auth revoke-devices    QR로 연결한 기기의 열쇠를 모두 끊는다(공용 접속 코드와 그 코드로 붙은 기기는 그대로)
  auth devices           QR로 연결한 기기와 그 ID를 보여 준다
  auth revoke-device <ID>
                         QR로 연결한 기기 한 대만 끊는다(다른 기기는 그대로. 다른 기기 끊기는 서버가 도는 Mac에서만 된다)
  build-id               실행 파일 식별값(build ID)을 보여 준다
  service install [--restart] [--dry-run] | uninstall [--dry-run]
                         launchd 서비스(com.iamceo.server)를 등록·해제한다
  upgrade [--version vX.Y.Z] [--dry-run]
                         새 판을 받아 DB 사본으로 미리 돌려 본 뒤 바꾼다. 안 뜨면 스스로 직전 판으로 되돌린다
                         (git 체크아웃에서 도는 서버는 upgrade <커밋>)
  rollback [--yes] [--dry-run]
                         마지막 업그레이드 전의 판으로 되돌린다
  uninstall [--purge] [--yes] [--dry-run] [--include-checkout]
                         모든 팀장·실행 엔진·로그인 서비스를 멈춘다. 데이터는 --purge 일 때만(한 번 더 확인하고) 지운다
                         (소스 체크아웃에서 도는 서비스는 --include-checkout 일 때만 내리고 설정 사본을 남긴다)
  roles export           기본 역할 템플릿을 ~/.iamceo/roles/<kind>.example.md 로 꺼낸다. 더할 규칙은 <kind>.extra.md, 통째로 고친 것은 <kind>.md
  version                버전을 보여 준다
  mcp                    MCP 브리지(세션이 부른다)`;

// 영어 도움말. 새 명령은 위 USAGE 와 여기에 한 줄씩 더한다. 언어는 IAMCEO_LANG → LC_ALL → LANG 순으로 고른다(server/cli-text.ts).
const USAGE_EN = `Usage: iamceo <command>
  serve                  start the server
  setup [--port N] [--hosts local|lan|addr,addr]
                         first-time setup (herdr-core, port, who can connect)
  open                   show the connection address and access code
  status                 show the server and project status
  doctor [--json]        check this Mac's setup item by item, with a fix for each (works while the server is down)
  diagnose               make a diagnostics file (~/.iamceo/diagnostics/<time>.zip) without conversations or the access code
  attach <staffID>       open the terminal of a managed CLI
  join [--project name] [--name name] [--role role] [--handle handle] [--session UUID]
                         register a CLI you started yourself as staff and print the commands to connect it
  import <dump.json> [--name name] [--cwd folder]
                         import an old board dump as a project
  backup [--directory path] checked backup of the database, attachments and settings
  restore <backup folder> --destination path [--clone]
                         restore into an empty or missing home with outgoing delivery switched off
  restore reconcile      settle the pending messages and notifications of a stopped restored home, conservatively
  restore resume         allow outgoing delivery after reconcile; then press 'Start on this Mac' in the app
  readiness              check authentication, recovery and the running build ID
  auth rotate [--all-devices]
                         replace this Mac's shared access code; connections on it and QRs stop working (devices paired by QR stay;
                         with --all-devices their keys are revoked too, for when the code may have leaked)
  auth revoke-devices    revoke the keys of every device paired by QR (the shared access code and devices on it stay)
  auth devices           list the devices paired by QR with their IDs
  auth revoke-device <ID>
                         disconnect one device paired by QR (the others stay; other devices can only be
                         disconnected on the Mac that runs the server)
  build-id               show the build ID of this executable
  service install [--restart] [--dry-run] | uninstall [--dry-run]
                         register or remove the launchd service (com.iamceo.server)
  upgrade [--version vX.Y.Z] [--dry-run]
                         download the new build, rehearse it on a copy of the database, then switch;
                         rolls back by itself if it does not start (a server run from a git checkout: upgrade <commit>)
  rollback [--yes] [--dry-run]
                         return to the build before the last upgrade
  uninstall [--purge] [--yes] [--dry-run] [--include-checkout]
                         stop every session, the session engine and the login service; data is deleted only with --purge (asked again)
                         (a service that runs from a source checkout is stopped only with --include-checkout; its settings file is kept as a copy)
  roles export           copy the default role templates to ~/.iamceo/roles/<kind>.example.md; put added rules in <kind>.extra.md, a full replacement in <kind>.md
  version                show the version
  mcp                    MCP bridge (sessions start it)

Language: set IAMCEO_LANG=en or IAMCEO_LANG=ko. Without it, Korean when LC_ALL or LANG starts with ko.`;

function usage(): string {
  return say(`${USAGE}\n\n언어: IAMCEO_LANG=ko 또는 IAMCEO_LANG=en 으로 고릅니다. 없으면 LC_ALL·LANG 이 ko 로 시작할 때 한국어입니다.`, USAGE_EN);
}

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
    throw new CliError(say(`서버가 꺼져 있습니다(${localUrl(config)}). IAMCEO 앱에서 ‘이 Mac에서 시작’을 누르세요(앱 없이 쓰면 iamceo service install).`,
      `The server is not running (${localUrl(config)}). Press 'Start on this Mac' in the IAMCEO app (without the app: iamceo service install).`));
  }
  const parsed = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new CliError(parsed?.error ?? say(`서버 오류(${res.status})`, `Server error (${res.status})`));
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
      references: createStorageReferences(store, config.inboxDir),
      // E4: 같은 정리 주기에 끝난 지 오래된 안쪽 기록(보낸 글 사본 30일, 실행 기록·영수증 90일)도 정리한다.
      records: store,
      // B5: 내보내기 도중에 서버가 꺼져 남은 임시 zip(1시간 넘은 것만). 업그레이드 기록(upgrades/)은 넘기지 않는다.
      exportsDir: join(config.home, "exports") });
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
      timer = setTimeout(() => reject(new CliError(say("15초 종료 예산을 초과했습니다", "Shutdown went over its 15-second budget"))), Math.min(Math.max(timeoutMs, 1), 15_000));
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
    console.error(say("잠자기 방지를 켜지 못했습니다. 자리를 비우면 Mac 이 잠들 수 있습니다.", "Could not keep the Mac awake. It may go to sleep while you are away."));
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
    if (config.port !== 0 && await portInUse(config.hosts[0]!, config.port)) throw new CliError(say(`포트 ${config.port} 을 이미 쓰고 있습니다. iamceo status 로 확인하세요.`,
      `Port ${config.port} is already in use. Check with iamceo status.`));
    starting = startOpsRuntime(config, { owner, signal: shutdown.signal });
    runtime = await starting;
    if (!stopping) {
      awake = keepAwake(config);
      console.log(`${say("IAMCEO 서버", "IAMCEO server")}: ${runtime.server.urls.join(" · ")}`);
      console.log(say("접속 코드는 iamceo open 으로 봅니다.", "Run iamceo open to see the access code."));
    }
  } catch (error) {
    if (!starting) owner.release();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, stop);
    uninstallGuard();
    throw error;
  }
}

async function attach(args: string[]): Promise<void> {
  if (args.length !== 1 || !/^m_[A-Za-z0-9_-]+$/.test(args[0]!)) throw new CliError(say("쓰는 법: iamceo attach <팀장ID>", "Usage: iamceo attach <staffID>"));
  const config = loadConfig();
  const member = await api<Member>(config, `/api/members/${encodeURIComponent(args[0]!)}`);
  if (member.backend !== "core" || !member.paneId) throw new CliError(say("연결할 실행 엔진 터미널이 없습니다(잠든 팀장일 수 있습니다)", "There is no session engine terminal to attach to (the session may be asleep)"));
  // The screen endpoint verifies the current core ownership labels before local attach.
  await api(config, `/api/members/${encodeURIComponent(member.id)}/screen`);
  const coreBin = config.coreBin ?? "herdr-core";
  if (!Bun.which(coreBin)) throw new CliError(say(`herdr-core를 찾을 수 없습니다: ${coreBin}`, `herdr-core not found: ${coreBin}`));
  const proc = Bun.spawn([coreBin, "attach", member.paneId], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: {
    ...process.env, HC_SOCKET: config.coreSocket ?? join(config.home, "run", "core.sock"), HC_SESSION: "iamceo",
    XDG_STATE_HOME: join(config.home, "core-state"), XDG_CONFIG_HOME: join(config.home, "core-config"),
  } });
  const code = await proc.exited;
  if (code !== 0) throw new CliError(say(`터미널 연결이 끝났습니다(${code})`, `The terminal connection ended (${code})`));
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
    if (!lan) throw new CliError(say("같은 망의 주소를 찾지 못했습니다. --hosts 로 직접 적어 주세요",
      "No address on the local network was found. Give the addresses with --hosts"));
    return ["127.0.0.1", ...(detectTailscaleIp() ? [detectTailscaleIp()!] : []), lan.address];
  }
  const hosts = answer.split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) throw new CliError(say(`접근 범위 값이 잘못되었습니다: ${answer}`, `Invalid value for who can connect: ${answer}`));
  for (const host of hosts) {
    if (host === "0.0.0.0" || host === "::") throw new CliError(say("모든 주소(0.0.0.0)로는 열지 않습니다. 쓸 주소를 직접 적어 주세요",
      "IAMCEO does not listen on every address (0.0.0.0). Give the addresses to use"));
    if (!/^[0-9a-fA-F:.]+$/.test(host)) throw new CliError(say(`주소 값이 잘못되었습니다: ${host}`, `Invalid address: ${host}`));
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
  console.log(say(`데이터 폴더: ${config.home}\n실행기: herdr-core (${config.coreBin ?? "herdr-core"})`, `Data folder: ${config.home}\nEngine: herdr-core (${config.coreBin ?? "herdr-core"})`));
  for (const cli of [config.claudeBin, config.codexBin ?? "codex"]) if (!Bun.which(cli)) console.log(say(`${cli} 명령을 찾지 못했습니다.`, `The ${cli} command was not found.`));
  if (values.backend && values.backend !== "core") throw new CliError(say("실행기는 herdr-core 하나입니다. --backend 옵션은 core만 지원합니다",
    "herdr-core is the only engine. --backend accepts core only"));

  const db = openDb(config.dbPath);
  const store = new Store(db, new Bus());
  const reader = lineReader();
  try {
    const portText = values.port ?? (await reader.ask(say("포트", "Port"), String(config.port || DEFAULT_PORT)));
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(say(`포트 값이 잘못되었습니다: ${portText}`, `Invalid port: ${portText}`));

    console.log(say("접근 범위:\n  local  이 컴퓨터와 Tailscale(켜져 있으면 폰에서 그 주소로)\n  lan    같은 망의 다른 기기까지\n  유지   지금 설정 그대로",
      "Who can connect:\n  local  this Mac, and Tailscale when it is on (your phone uses that address)\n  lan    other devices on the same network too\n  keep   leave the current setting"));
    const scope = values.hosts ?? (await reader.ask(say("접근 범위", "Who can connect"), config.hostsAuto ? "local" : say("유지", "keep")));
    // 어느 언어로 물었든 '유지'와 'keep' 둘 다 받는다.
    const hosts = scope === "유지" || scope === "keep" ? null : hostsFor(scope);

    store.patchSettings({ backend: "core" });
    if (port !== config.port) updateConfigFile({ port });
    if (hosts !== null) updateConfigFile({ hosts });
    const after = loadConfig();
    console.log(say(
      `\n설정했습니다: herdr-core, 포트 ${port}\n주소: ${publicUrls({ ...after, port }).join(" · ")}\n접속 코드: ${config.accessCode}\n서버 켜기: iamceo serve (서비스로 두려면 iamceo service install). 이미 켜져 있으면 다시 켜야 적용됩니다.\n역할 지침을 고치려면: iamceo roles export (${config.rolesDir})`,
      `\nSet up: herdr-core, port ${port}\nAddress: ${publicUrls({ ...after, port }).join(" · ")}\nAccess code: ${config.accessCode}\nStart the server: iamceo serve (to keep it as a service: iamceo service install). If it is already running, restart it to apply this.\nTo change the role rules: iamceo roles export (${config.rolesDir})`));
    if (process.env.IAMCEO_PORT) console.log(say(`IAMCEO_PORT=${process.env.IAMCEO_PORT} 환경변수가 설정 파일보다 앞섭니다.`,
      `The IAMCEO_PORT=${process.env.IAMCEO_PORT} environment variable takes precedence over the settings file.`));
  } finally {
    reader.close();
    db.close();
  }
}

// ---- open · status ----
function open(): void {
  const config = loadConfig();
  console.log(say(`주소: ${publicUrls(config).join(" · ")}\n접속 코드: ${config.accessCode}`, `Address: ${publicUrls(config).join(" · ")}\nAccess code: ${config.accessCode}`));
}

async function status(): Promise<void> {
  const config = loadConfig();
  const health = await api<{ ok: boolean; version: string }>(config, "/api/health");
  const boot = await api<Bootstrap>(config, "/api/bootstrap");
  console.log(say(`IAMCEO ${health.version} 실행 중: ${boot.urls.join(" · ")}`, `IAMCEO ${health.version} is running: ${boot.urls.join(" · ")}`));
  console.log(`${say("실행기", "Engine")}: herdr-core · ${boot.runtime?.core.available ? say("연결됨", "connected") : say("연결 안 됨", "not connected")}${boot.runtime?.core.detail ? ` (${boot.runtime.core.detail})` : ""}`);
  try {
    const response = await fetch(`${localUrl(config)}/api/readiness`, { headers: { Authorization: `Bearer ${config.accessCode}` },
      redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (response.status === 401 || response.status === 403) throw new CliError(say("인증된 진단 확인 실패", "The authenticated readiness check failed"));
    if (response.status === 200 || response.status === 503) {
      const diagnostic = await response.json() as { ok: boolean; daemon: { buildId: string } | null;
        schema: { version: number; supportedVersion: number }; hosts: { host: string; state: string }[] };
      console.log(say(`준비 상태: ${diagnostic.ok ? "완료" : "미완료"} · build ${diagnostic.daemon?.buildId ?? "확인 불가"} · DB ${diagnostic.schema.version}/${diagnostic.schema.supportedVersion}`,
        `Ready: ${diagnostic.ok ? "yes" : "not yet"} · build ${diagnostic.daemon?.buildId ?? "unknown"} · DB ${diagnostic.schema.version}/${diagnostic.schema.supportedVersion}`));
      for (const binding of diagnostic.hosts) if (binding.state === "failed") console.log(say(`  접속 주소 열기 실패: ${binding.host} (자동 재시도 중)`, `  Could not open address: ${binding.host} (retrying on its own)`));
    } else { console.log(say(`준비 진단 확인 불가 (HTTP ${response.status})`, `Readiness unknown (HTTP ${response.status})`)); }
  } catch (error) {
    if (error instanceof CliError) throw error;
    console.log(say("준비 진단 확인 불가", "Readiness unknown"));
  }
  console.log(say("프로젝트:", "Projects:"));
  for (const p of boot.projects) {
    console.log(say(`  ${p.name} (${p.id})${p.runnerEnabled ? "" : " [실행 꺼짐]"}: 결재 ${p.inboxCount} · 일하는 중 ${p.workingCount} · 팀장 ${p.memberCount}${p.now ? ` · ${p.now.split("\n")[0]}` : ""}`,
      `  ${p.name} (${p.id})${p.runnerEnabled ? "" : " [stopped]"}: inbox ${p.inboxCount} · working ${p.workingCount} · staff ${p.memberCount}${p.now ? ` · ${p.now.split("\n")[0]}` : ""}`));
  }
}

/** 이 Mac 의 서버에 loopback 으로 닿는 주소. 코드 교체·모두 끊기는 서버가 실제 상대 주소로 이 Mac 인지 본다. */
function localServerUrl(config: Config, path: string): string {
  const host = config.hosts.find(host => host === "::1" || host === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(host)) ??
    (config.hosts.includes("0.0.0.0") ? "127.0.0.1" : config.hosts.includes("::") ? "::1" : null);
  if (!host || config.port === 0) throw new CliError(say("이 Mac 주소(127.0.0.1)와 실행 포트가 필요합니다. 설정의 접속 주소에 127.0.0.1 이 있는지 확인하세요.",
    "This Mac's own address (127.0.0.1) and a running port are needed. Check that 127.0.0.1 is among the addresses in the settings."));
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}${path}`;
}

/** Only a local peer may rotate. A lost response is recovered by explicit local `open`, never replayed. */
export async function rotateAccessCode(config: Config, request: typeof fetch = fetch, options: { allDevices?: boolean } = {}): Promise<string> {
  return (await rotateAccess(config, request, options)).accessCode;
}

/** rotateAccessCode 와 같고, --all-devices 면 함께 끊은 기기 열쇠 수도 돌려준다. */
export async function rotateAccess(config: Config, request: typeof fetch = fetch, options: { allDevices?: boolean } = {}): Promise<{ accessCode: string; revokedDevices: number | null }> {
  const url = localServerUrl(config, "/api/auth/rotate");
  let response: Response;
  try {
    response = await request(url, {
      method: "POST", headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json" },
      body: options.allDevices ? JSON.stringify({ allDevices: true }) : "{}", redirect: "error", signal: AbortSignal.timeout(5_000),
    });
  } catch { throw new CliError(say("접속 코드 교체 결과를 확인하지 못했습니다. 자동 재시도하지 않았습니다. 이 Mac에서 iamceo open으로 현재 코드를 확인하세요.",
    "Could not confirm whether the access code was replaced. It was not retried. Run iamceo open on this Mac to see the current code.")
    + (options.allDevices ? say("\n기기 열쇠가 끊겼는지도 모릅니다. 확실히 하려면 iamceo auth revoke-devices 를 실행하세요(다시 실행해도 됩니다).",
      "\nThe device keys may or may not be revoked. To be sure, run iamceo auth revoke-devices (safe to run again).") : "")); }
  // 옛 서버는 { allDevices } 를 모르는 본문으로 400 을 낸다. 그때는 아무것도 바뀌지 않았다.
  if (options.allDevices && response.status === 400) throw new CliError(say("이 서버는 --all-devices 를 모릅니다(옛 버전). 기기마다 다른 열쇠가 없으므로 iamceo auth rotate 만으로 모든 연결이 끊깁니다. 접속 코드는 바뀌지 않았습니다.",
    "This server does not know --all-devices (an older version). It has no per-device keys, so iamceo auth rotate alone disconnects everything. The access code was not replaced."));
  if (!response.ok) throw new CliError(say(`접속 코드 교체 실패 (HTTP ${response.status}). 이 Mac에서 iamceo open으로 현재 코드를 확인하세요.`,
    `Replacing the access code failed (HTTP ${response.status}). Run iamceo open on this Mac to see the current code.`));
  let result: { accessCode: string; revokedDevices: number | null };
  try { result = parseRotationResult(await response.json()); }
  catch { throw new CliError(say("교체 응답을 확인하지 못했습니다. 이 Mac에서 iamceo open으로 현재 코드를 확인하세요.",
    "Could not read the reply. Run iamceo open on this Mac to see the current code.")); }
  // 옛 서버는 allDevices 를 모르고(400 으로 거절) 새 서버는 끊은 수를 싣는다. 수가 없으면 끊었다고 말하지 않는다.
  if (options.allDevices && result.revokedDevices === null) throw new CliError(say("서버가 기기 열쇠 끊기를 확인해 주지 않았습니다. iamceo auth revoke-devices 로 다시 끊으세요.",
    "The server did not confirm that the device keys were revoked. Run iamceo auth revoke-devices."));
  config.accessCode = result.accessCode;
  return result;
}

function parseRotationResult(value: unknown): { accessCode: string; revokedDevices: number | null } {
  // Network input is untrusted even though the public helper returns a typed value.
  if (!value || typeof value !== "object" || !("accessCode" in value) || typeof value.accessCode !== "string" || !value.accessCode.trim()) {
    throw new CliError(say("접속 코드 교체 응답이 잘못되었습니다", "The reply to the access code replacement is invalid"));
  }
  const revoked = "revokedDevices" in value && Number.isSafeInteger(value.revokedDevices) && (value.revokedDevices as number) >= 0 ? value.revokedDevices as number : null;
  return { accessCode: value.accessCode, revokedDevices: revoked };
}

/** QR 로 받은 기기 열쇠를 모두 끊는다(DELETE /api/devices, 이 Mac 에서만). 공용 접속 코드는 그대로다. 다시 실행해도 된다. */
export async function revokeDeviceKeys(config: Config, request: typeof fetch = fetch): Promise<number> {
  const url = localServerUrl(config, "/api/devices");
  let response: Response;
  try {
    response = await request(url, { method: "DELETE", headers: { Authorization: `Bearer ${config.accessCode}` }, redirect: "error", signal: AbortSignal.timeout(5_000) });
  } catch { throw new CliError(say("기기 끊기 결과를 확인하지 못했습니다. 서버가 켜져 있는지 확인하고 다시 실행하세요(다시 실행해도 됩니다).",
    "Could not confirm that the devices were disconnected. Check that the server is running and run it again (safe to repeat).")); }
  if (response.status === 404) throw new CliError(say("이 서버는 기기 열쇠를 모릅니다(옛 버전). 기기마다 다른 열쇠가 없으므로 iamceo auth rotate 로 접속 코드를 바꾸세요.",
    "This server does not know device keys (an older version). Run iamceo auth rotate to replace the access code instead."));
  if (!response.ok) throw new CliError(say(`기기 끊기 실패 (HTTP ${response.status}). 다시 실행하세요.`, `Disconnecting the devices failed (HTTP ${response.status}). Run it again.`));
  const body = await response.json().catch(() => null) as { revoked?: unknown } | null;
  if (!body || !Number.isSafeInteger(body.revoked)) throw new CliError(say("기기 끊기 응답이 잘못되었습니다. 다시 실행하세요.", "The reply is invalid. Run it again."));
  return body.revoked as number;
}

// ---- 0.2.5 X: 한 대만 끊기(iamceo auth revoke-device <ID>)와 그 ID 를 찾는 목록(iamceo auth devices) ----
/** 명령줄이 보이는 기기 한 줄. 열쇠 값은 서버가 싣지 않는다. */
export interface CliDevice { id: string; name: string; platform: string | null; pairedAt: string; lastSeenAt: string | null }

async function readErrorCode(response: Response): Promise<string | null> {
  const body = await response.json().catch(() => null) as { code?: unknown } | null;
  return typeof body?.code === "string" ? body.code : null;
}

/** QR 로 연결한 기기 목록(GET /api/devices). 이 Mac 의 서버에 loopback 으로 묻는다. */
export async function listDeviceKeys(config: Config, request: typeof fetch = fetch): Promise<CliDevice[]> {
  const url = localServerUrl(config, "/api/devices");
  let response: Response;
  try {
    response = await request(url, { headers: { Authorization: `Bearer ${config.accessCode}` }, redirect: "error", signal: AbortSignal.timeout(5_000) });
  } catch { throw new CliError(say("기기 목록을 읽지 못했습니다. 서버가 켜져 있는지 확인하고 다시 실행하세요.",
    "Could not read the device list. Check that the server is running and run it again.")); }
  if (response.status === 404) throw new CliError(say("이 서버는 기기 열쇠를 모릅니다(옛 버전). 기기마다 다른 열쇠가 없으므로 iamceo auth rotate 로 접속 코드를 바꾸세요.",
    "This server does not know device keys (an older version). Run iamceo auth rotate to replace the access code instead."));
  if (!response.ok) throw new CliError(say(`기기 목록 읽기 실패 (HTTP ${response.status}). 다시 실행하세요.`, `Reading the device list failed (HTTP ${response.status}). Run it again.`));
  const body = await response.json().catch(() => null) as { devices?: unknown } | null;
  if (!body || !Array.isArray(body.devices)) throw new CliError(say("기기 목록 응답이 잘못되었습니다. 다시 실행하세요.", "The reply is invalid. Run it again."));
  const text = (value: unknown): string | null => typeof value === "string" ? value : null;
  return body.devices.flatMap((raw): CliDevice[] => {
    const device = raw as Record<string, unknown> | null;
    const id = text(device?.id);
    return id ? [{ id, name: text(device?.name) ?? "", platform: text(device?.platform), pairedAt: text(device?.pairedAt) ?? "", lastSeenAt: text(device?.lastSeenAt) }] : [];
  });
}

/**
 * 한 대만 끊는다(DELETE /api/devices/:id). 다른 기기를 끊는 것은 서버가 도는 Mac 에서만 되므로 loopback 으로 보낸다.
 * 끊은 기기의 이름을 돌려준다. 이미 끊었거나 없는 ID 면 그렇다고 알린다(다시 실행해도 된다).
 */
export async function revokeDeviceKey(config: Config, id: string, request: typeof fetch = fetch): Promise<string> {
  const url = localServerUrl(config, `/api/devices/${encodeURIComponent(id)}`);
  let response: Response;
  try {
    response = await request(url, { method: "DELETE", headers: { Authorization: `Bearer ${config.accessCode}` }, redirect: "error", signal: AbortSignal.timeout(5_000) });
  } catch { throw new CliError(say("기기 끊기 결과를 확인하지 못했습니다. 서버가 켜져 있는지 확인하고 다시 실행하세요(다시 실행해도 됩니다).",
    "Could not confirm that the device was disconnected. Check that the server is running and run it again (safe to repeat).")); }
  if (response.status === 404) {
    const code = await readErrorCode(response);
    if (code === "device_not_found") throw new CliError(say(`연결된 기기 중에 ${id} 가 없습니다(이미 끊었을 수 있습니다). 연결된 기기와 그 ID 는 iamceo auth devices 로 봅니다.`,
      `No connected device has the ID ${id} (it may already be disconnected). See the connected devices and their IDs with iamceo auth devices.`));
    throw new CliError(say("이 서버는 기기 열쇠를 모릅니다(옛 버전). 기기마다 다른 열쇠가 없으므로 iamceo auth rotate 로 접속 코드를 바꾸세요.",
      "This server does not know device keys (an older version). Run iamceo auth rotate to replace the access code instead."));
  }
  if (response.status === 403) throw new CliError(say("서버가 이 요청을 이 Mac 에서 온 것으로 보지 않았습니다. 서버가 도는 Mac 의 터미널에서 다시 실행하세요.",
    "The server did not treat this request as coming from this Mac. Run it again in Terminal on the Mac that runs the server."));
  if (!response.ok) throw new CliError(say(`기기 끊기 실패 (HTTP ${response.status}). 다시 실행하세요.`, `Disconnecting the device failed (HTTP ${response.status}). Run it again.`));
  const body = await response.json().catch(() => null) as { ok?: unknown; device?: { name?: unknown } } | null;
  if (body?.ok !== true) throw new CliError(say("기기 끊기 응답이 잘못되었습니다. iamceo auth devices 로 확인하세요.", "The reply is invalid. Check with iamceo auth devices."));
  return typeof body.device?.name === "string" ? body.device.name : id;
}

/** iamceo auth devices 의 출력. 마지막 접속이 없으면 '아직 접속하지 않음'. */
export function formatDeviceList(devices: CliDevice[]): string {
  if (devices.length === 0) return say("QR로 연결한 기기가 없습니다. 공용 접속 코드로 붙은 기기는 iamceo auth rotate 로 끊습니다.",
    "No device is paired by QR. Devices on the shared access code are disconnected with iamceo auth rotate.");
  const platform = (value: string | null): string => value === "ios" ? "iPhone" : value === "macos" ? "Mac" : say("모름", "unknown");
  const lines = devices.map(device => `  ${device.id}  ${device.name}  (${platform(device.platform)}, `
    + (device.lastSeenAt ? say(`마지막 접속 ${device.lastSeenAt}`, `last seen ${device.lastSeenAt}`) : say("아직 접속하지 않음", "not connected yet")) + ")");
  return [say("QR로 연결한 기기:", "Devices paired by QR:"), ...lines,
    say("한 대만 끊으려면 iamceo auth revoke-device <ID>", "To disconnect one of them: iamceo auth revoke-device <ID>")].join("\n");
}

// ---- join ----
async function join_(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { project: { type: "string" }, name: { type: "string" }, role: { type: "string" }, handle: { type: "string" }, session: { type: "string" } },
  });
  if (!values.name && !values.handle) throw new CliError(say("--name 또는 --handle 이 필요합니다", "--name or --handle is required"));
  const config = loadConfig();
  const cwd = process.cwd();
  const joined = await api<{ member: Member; token: string; project: Project }>(config, "/agent/join", {
    method: "POST",
    body: { project: values.project, cwd, name: values.name, role: values.role, handle: values.handle, sessionId: values.session },
  });
  const state = await api<ProjectState>(config, `/api/projects/${encodeURIComponent(joined.project.id)}/state`);
  const conductor = state.members.find((m) => m.kind !== "worker");
  // B1: 설정의 보고 언어를 직접 붙인 세션의 규칙에도 넣는다. 읽지 못하면 기본(한국어) 규칙을 쓴다.
  const reportLanguage = await api<Bootstrap>(config, "/api/bootstrap").then((boot) => boot.settings.reportLanguage, () => undefined);

  const { renderRole } = await import("../server/roles.ts");
  const runDir = join(config.home, "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const rulesFile = join(runDir, `${joined.member.id}.rules.md`);
  writeFileSync(rulesFile, renderRole(joined.member.kind, { PROJECT: joined.project.name, NAME: joined.member.name, ROLE: joined.member.role, CONDUCTOR: conductor?.name ?? "총괄", REPORT_LANGUAGE: reportLanguage, MANUAL: joined.member.origin === "manual" }, config.rolesDir));

  // --env 는 값을 여러 개 받는 옵션이라 서버 이름이 뒤에 오면 그것까지 값으로 먹는다(claude mcp add 가 거부한다, 실측).
  const add = ["claude", "mcp", "add", "iamceo", "--transport", "stdio", "--scope", "local", "--env", `IAMCEO_URL=${localUrl(config)}`, "--env", `IAMCEO_TOKEN=${joined.token}`, "--", ...selfCommand("mcp")];
  console.log(say(`${joined.project.name} 의 팀장 ${joined.member.name}(${joined.member.handle})으로 등록했습니다.\n`,
    `Registered as ${joined.member.name} (${joined.member.handle}) in ${joined.project.name}.\n`));
  console.log(say(`1. 이 폴더(${cwd})에서 MCP 를 연결합니다(토큰이 들어 있으니 남에게 보이지 마세요):\n   ${add.map(shellQuote).join(" ")}\n`,
    `1. Connect MCP in this folder (${cwd}). The command holds a token, so do not show it to anyone:\n   ${add.map(shellQuote).join(" ")}\n`));
  console.log(say(`2. 규칙 파일: ${rulesFile}\n   새로 띄울 때: claude --append-system-prompt-file ${shellQuote(rulesFile)}\n   이미 떠 있는 세션이면 /mcp 로 다시 연결한 뒤 이 파일을 읽고 따르라고 입력합니다.`,
    `2. Rules file: ${rulesFile}\n   For a new session: claude --append-system-prompt-file ${shellQuote(rulesFile)}\n   In a session that is already running, reconnect with /mcp, then ask it to read and follow this file.`));
}

// ---- import ----
async function importDump(args: string[]): Promise<void> {
  const { acquireHomeOwner } = await import("../server/home-owner.ts");
  using owner = acquireHomeOwner(homeDir());
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { name: { type: "string" }, cwd: { type: "string" } } });
  const file = positionals[0];
  if (!file) throw new CliError(say("덤프 파일이 필요합니다: iamceo import <덤프.json> [--name 이름] [--cwd 폴더]",
    "A dump file is required: iamceo import <dump.json> [--name name] [--cwd folder]"));
  const { describeImport, runImport } = await import("../scripts/import-artifact.ts");
  try {
    console.log(describeImport(await runImport({ file, name: values.name, cwd: values.cwd })));
  } catch (e) {
    throw new CliError((e as Error).message);
  }
}

// ---- backup / separate-path restore ----
/**
 * 백업·복원의 오류는 호출 기록 없이 한 줄로 보인다(문서가 이 명령들을 안내한다). 서버가 데이터 폴더를 쥐고 있으면 그 까닭과 할 일을 말한다.
 * 명령줄 사용법 오류(CliError·ERR_PARSE_ARGS)는 그대로 둔다.
 */
async function oneLineErrors(what: "backup" | "restore", run: () => Promise<void>): Promise<void> {
  try { await run(); }
  catch (error) {
    if (error instanceof CliError || !(error instanceof Error) || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) throw error;
    if ((error as { code?: string }).code === "home_in_use") {
      const home = (error as { home?: string }).home ?? homeDir();
      throw new CliError(what === "backup"
        ? say(`켜져 있는 서버가 데이터 폴더를 쓰고 있어(다른 작업이 사용 중) 지금 백업하지 않았습니다. 켜져 있는 서버는 매일 스스로 백업합니다(${join(home, "backups")}). 지금 바로 백업하려면 서버를 끈 뒤 다시 실행하세요.`,
          `The running server is using the data folder, so no backup was made now. A running server backs itself up every day (${join(home, "backups")}). To back up right now, stop the server and run this again.`)
        : say(`데이터 폴더를 다른 작업(켜져 있는 서버 등)이 사용 중이라 멈췄습니다: ${home}. 서버를 끈 뒤 다시 실행하세요.`,
          `Another process (such as the running server) is using the data folder, so nothing was done: ${home}. Stop the server and run this again.`));
    }
    throw new CliError(what === "backup" ? say(`백업하지 못했습니다: ${error.message}`, `Backup failed: ${error.message}`)
      : say(`복원하지 못했습니다: ${error.message}`, `Restore failed: ${error.message}`));
  }
}

function backup(args: string[]): Promise<void> {
  return oneLineErrors("backup", () => backupNow(args));
}

async function backupNow(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { directory: { type: "string" } } });
  const { acquireHomeOwner } = await import("../server/home-owner.ts");
  using owner = acquireHomeOwner(homeDir());
  const config = loadConfig();
  const { BackupManager } = await import("../server/backup.ts");
  const manager = new BackupManager({ home: config.home, backupDir: resolve(values.directory ?? join(config.home, "backups")) });
  const snapshot = await manager.run(true);
  console.log(`${say("백업 검증 완료", "Backup checked")}: ${snapshot!.directory}`);
}

function restore(args: string[]): Promise<void> {
  return oneLineErrors("restore", () => restoreNow(args));
}

async function restoreNow(args: string[]): Promise<void> {
  if (args[0] === "reconcile" || args[0] === "resume") {
    if (args.length !== 1) throw new CliError(say("iamceo restore reconcile | iamceo restore resume (IAMCEO_HOME으로 복원 홈 지정, 서버 종료 필요)",
      "iamceo restore reconcile | iamceo restore resume (point IAMCEO_HOME at the restored home; the server must be stopped)"));
    const { reconcileRestoredHome, resumeRestoredHome } = await import("../server/restore.ts");
    const result = args[0] === "reconcile" ? reconcileRestoredHome(homeDir()) : resumeRestoredHome(homeDir());
    console.log(result.outboundEnabled
      ? say(`복원 발신 재개 허용: ${result.home}\n${startRestoredHome(result.home, "ko")} 보류했던 전달은 다시 보내지 않고, 알림 기기도 저절로 켜지 않습니다.`,
        `Outgoing delivery allowed for the restored home: ${result.home}\n${startRestoredHome(result.home, "en")} Held deliveries are not resent and notification devices are not switched back on automatically.`)
      : say(`복원 홈 조정 완료: ${result.home} (보내던 글과 알림을 안전하게 정리했습니다)\n발신 꺼짐: iamceo restore resume 으로 직접 재개하세요.`,
        `Restored home settled: ${result.home} (pending messages and notifications were tidied up safely)\nOutgoing delivery is off: run iamceo restore resume to allow it.`));
    return;
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true,
    options: { destination: { type: "string" }, clone: { type: "boolean" } } });
  if (positionals.length !== 1 || !values.destination) throw new CliError(say("iamceo restore <백업폴더> --destination <비어 있거나 없는 홈> [--clone]",
    "iamceo restore <backup folder> --destination <empty or missing home> [--clone]"));
  const { restoreBackup } = await import("../server/restore.ts");
  const result = restoreBackup({ snapshotDir: resolve(positionals[0]!), destinationHome: resolve(values.destination), mode: values.clone ? "clone" : "same-host" });
  const usual = isDefaultHome(result.home);
  console.log(say(`복원 검증 완료: ${result.home}\n발신 꺼짐: ${usual ? "" : `IAMCEO_HOME=${shellQuote(result.home)} 으로 지정하고 `}iamceo restore reconcile → iamceo restore resume 순서로 실행한 뒤 ${usual ? "IAMCEO 앱에서 ‘이 Mac에서 시작’을 누르세요(앱 없이 쓰면 iamceo service install)" : "같은 IAMCEO_HOME 으로 iamceo service install 을 실행하세요"}. 기존 전달 기록은 그대로 두며, 알림 기기는 다시 등록해 켜야 합니다.`,
    `Restore checked: ${result.home}\nOutgoing delivery is off: ${usual ? "" : `set IAMCEO_HOME=${shellQuote(result.home)}, then `}run iamceo restore reconcile and then iamceo restore resume, then ${usual ? "press 'Start on this Mac' in the IAMCEO app (without the app: iamceo service install)" : "run iamceo service install with the same IAMCEO_HOME"}. Earlier delivery records are kept; notification devices must be registered and switched on again.`));
}

/** 복원 홈이 앱이 쓰는 기본 자리(~/.iamceo)인가. 아니면 앱의 '이 Mac에서 시작'이 그 홈을 쓰지 않는다. */
function isDefaultHome(home: string): boolean {
  // /var 와 /private/var 처럼 링크로 갈리는 같은 자리도 같은 홈으로 본다(있는 경로는 실제 경로로 비교).
  const real = (path: string) => { try { return realpathSync(resolve(path)); } catch { return resolve(path); } };
  return real(home) === real(join(homedir(), ".iamceo"));
}

/** 복원한 홈으로 서버를 켜는 법 한 줄. 기본 홈이면 앱 버튼, 아니면 그 홈을 지정한 서비스 등록. */
function startRestoredHome(home: string, lang: "ko" | "en"): string {
  if (isDefaultHome(home)) return lang === "ko" ? "IAMCEO 앱에서 ‘이 Mac에서 시작’을 누르세요(앱 없이 쓰면 iamceo service install)."
    : "Press 'Start on this Mac' in the IAMCEO app (without the app: iamceo service install).";
  return lang === "ko" ? `이 홈은 기본 자리(~/.iamceo)가 아니라 앱이 쓰지 않습니다. IAMCEO_HOME=${shellQuote(home)} iamceo service install 로 켜세요.`
    : `This home is not the usual place (~/.iamceo), so the app does not use it. Start it with IAMCEO_HOME=${shellQuote(home)} iamceo service install.`;
}

export async function waitForReadiness(config: Config, options: {
  expectedBuildId?: string; timeoutMs?: number; pollMs?: number; fetch?: typeof fetch;
} = {}): Promise<void> {
  const expected = options.expectedBuildId ?? await buildId();
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? 30_000);
  let reason = say("서버 응답 없음", "no answer from the server");
  do {
    try {
      // Bootstrap is authenticated by HTTP. Liveness alone cannot confirm the running binary or recovery.
      const response = await (options.fetch ?? fetch)(`${localUrl(config)}/api/bootstrap`, {
        headers: { Authorization: `Bearer ${config.accessCode}` }, redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))),
      });
      if (response.status === 401 || response.status === 403) throw new CliError(say("인증된 준비 확인 실패", "The authenticated readiness check failed"));
      const body = await response.json() as { runtime?: { daemon?: { ready?: boolean; buildId?: string; version?: string } } };
      const daemon = body.runtime?.daemon;
      if (response.ok && daemon?.ready === true && daemon.buildId === expected && daemon.version === VERSION) return;
      reason = !response.ok ? `HTTP ${response.status}` : !daemon ? say("서버가 준비 상태와 실행 파일 식별값을 알리지 않습니다", "the server does not report readiness or a build ID")
        : daemon.buildId !== expected || daemon.version !== VERSION ? say("다른 실행 파일이 떠 있습니다", "the running build ID is different")
        : say("복구 완료 대기", "waiting for recovery to finish");
    } catch (error) {
      if (error instanceof CliError) throw error;
      reason = say("서버 응답 없음", "no answer from the server");
    }
    if (Date.now() < deadline) await Bun.sleep(Math.min(Math.max(1, options.pollMs ?? 250), deadline - Date.now()));
  } while (Date.now() < deadline);
  throw new CliError(say(`서비스 준비 확인 실패: ${reason}. 로그를 확인하세요.`, `The service did not become ready: ${reason}. Check the logs.`));
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

/** launchd 는 로그인 셸의 PATH 를 모른다. 기본 자리에 더해, 등록하는 셸에서 찾은 CLI·herdr-core 폴더(nvm·npm 전역 등)를 앞에 둔다. */
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
  } catch { throw new CliError(say("기존 서비스의 환경을 읽지 못했습니다", "Could not read the environment of the existing service")); }
}

function requireOwnedService(plistPath: string, dataHome: string): void {
  if (!existsSync(plistPath)) throw new CliError(say("같은 서비스 이름을 쓰는 다른 실행이 있어 변경하지 않았습니다",
    "Something else is running under the same service name, so nothing was changed"));
  const converted = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", plistPath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let value: { Label?: string; ProgramArguments?: string[]; EnvironmentVariables?: Record<string, string> };
  try { value = JSON.parse(converted.stdout.toString()); } catch { throw new CliError(say("기존 서비스의 소유를 확인하지 못해 변경하지 않았습니다",
    "Could not confirm who owns the existing service, so nothing was changed")); }
  const args = value.ProgramArguments;
  const ownerHome = value.EnvironmentVariables?.IAMCEO_HOME ?? join(homedir(), ".iamceo");
  if (value.Label !== SERVICE_LABEL || !Array.isArray(args) || !["serve", "service-run"].includes(args.at(-1) ?? "") || !args.some((arg) => /(?:^|\/)iamceo(?:\.ts)?$/.test(arg)) || resolve(ownerHome) !== resolve(dataHome)) {
    throw new CliError(say("다른 IAMCEO 설치 또는 다른 프로그램의 서비스여서 변경하지 않았습니다",
      "The service belongs to another IAMCEO install or another program, so nothing was changed"));
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
  if (action !== "install" && action !== "uninstall") throw new CliError(say("쓰는 법: iamceo service install|uninstall [--dry-run]", "Usage: iamceo service install|uninstall [--dry-run]"));
  const dry = values["dry-run"] === true;
  if (!dry && process.env.IAMCEO_TEST === "1" && !dependencies) throw new CliError(say("IAMCEO_TEST=1 에서는 launchd 에 등록하지 않습니다. --dry-run 을 쓰세요.",
    "With IAMCEO_TEST=1 nothing is registered with launchd. Use --dry-run."));
  if (!dry && process.platform !== "darwin") throw new CliError(say("launchd 서비스는 macOS 에서만 됩니다", "The launchd service works on macOS only"));

  const home = dependencies?.home ?? homedir();
  const control = dependencies?.launchctl ?? launchctl;
  const readiness = dependencies?.readiness ?? waitForReadiness;
  const sleep = dependencies?.sleep ?? ((ms: number) => Bun.sleep(ms));
  const plistPath = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const target = `gui/${userInfo().uid}`;
  if (action === "uninstall") {
    if (dry) return console.log(say(`지울 파일: ${plistPath}\n실행할 명령: launchctl bootout ${target}/${SERVICE_LABEL}`,
      `File to remove: ${plistPath}\nCommand to run: launchctl bootout ${target}/${SERVICE_LABEL}`));
    requireOwnedService(plistPath, (dependencies?.config ?? loadConfig()).home);
    const result = control("bootout", `${target}/${SERVICE_LABEL}`);
    if (!result.ok) throw new CliError(say(`launchd 해제 실패: ${result.output}`, `Removing the launchd service failed: ${result.output}`));
    rmSync(plistPath, { force: true });
    return console.log(say("서비스를 해제했습니다. 데이터는 그대로 남습니다.", "The service is removed. Your data is kept."));
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
  if (dry) return console.log(say(`쓸 파일: ${plistPath}\n로그: ${join(logDir, "server.log")}\n실행할 명령: launchctl bootstrap ${target} ${plistPath}\n\n${plist}`,
    `File to write: ${plistPath}\nLog: ${join(logDir, "server.log")}\nCommand to run: launchctl bootstrap ${target} ${plistPath}\n\n${plist}`));
  if (!claude) console.log(say("claude 명령을 찾지 못했습니다. Claude Code 를 설치한 뒤 iamceo service install 을 다시 실행하세요. 그때 찾은 위치를 서비스에 적어 둡니다.",
    "The claude command was not found. Install Claude Code, then run iamceo service install again; the location found then is written into the service."));

  const active = control("print", `${target}/${SERVICE_LABEL}`);
  if (existsSync(plistPath) || active.ok) {
    requireOwnedService(plistPath, config.home);
    if (active.ok && !values.restart) {
      await readiness(config);
      // 떠 있는 서비스는 건드리지 않는다. 등록된 설정이 지금 것과 다르면 갱신 방법만 알린다.
      let installed: string | null = null;
      try { installed = readFileSync(plistPath, "utf8"); } catch {}
      if (installed !== plist) console.log(say("등록된 서비스 설정이 이 버전과 다릅니다. iamceo service install --restart 로 갱신하세요(서버가 잠깐 다시 시작됩니다).",
        "The registered service settings differ from this version. Update them with iamceo service install --restart (the server restarts briefly)."));
      return console.log(`${say("서비스 준비 확인 완료", "Service is ready")}: ${plistPath}`);
    }
    if (active.ok) {
      const unloaded = control("bootout", `${target}/${SERVICE_LABEL}`);
      // 서버가 내려가는 동안(최대 15초) bootout 은 36(in progress)을 준다. 실패가 아니라 기다릴 일이다.
      if (!unloaded.ok && !/failed: 36\b|in progress/i.test(unloaded.output)) throw new CliError(say(`서비스 재시작 실패: ${unloaded.output}`, `Restarting the service failed: ${unloaded.output}`));
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
    throw new CliError(`${say("launchd 등록 실패", "Registering with launchd failed")}: ${loaded.output}\n${stillLoaded
      ? say("이전 서비스가 아직 내려가지 않았습니다. 잠시 뒤 iamceo service install --restart 를 다시 실행하세요.",
        "The previous service has not stopped yet. Run iamceo service install --restart again in a moment.")
      : say("지금 서비스가 내려가 있습니다. iamceo service install 을 다시 실행해 올리세요.",
        "The service is down now. Run iamceo service install again to bring it up.")}`);
  }
  await readiness(config);
  console.log(say(`서비스를 등록했습니다: ${plistPath}\n로그: ${logDir}\n주소: ${publicUrls(config).join(" · ")}`,
    `Service registered: ${plistPath}\nLogs: ${logDir}\nAddress: ${publicUrls(config).join(" · ")}`));
}

// ---- doctor · diagnose (B3·D8) ----
/** 설정 파일이 있을 때만 읽는다. 아직 시작한 적 없는 Mac 에 점검이 데이터 폴더를 만들지 않게 한다. */
function existingConfig(): Config | null {
  return existsSync(join(homeDir(), "config.json")) ? loadConfig() : null;
}

/** 서버가 답하면 서버의 점검표, 꺼졌거나 옛 버전이면 이 Mac 에서 직접 본 점검표. */
async function doctorReportForCli(lang: "ko" | "en"): Promise<import("../shared/types.ts").DoctorReport> {
  const { askServerDoctor, doctorReport, localDoctorFacts } = await import("../server/doctor.ts");
  const config = existingConfig();
  if (!config) return doctorReport(await localDoctorFacts({ home: homeDir(), config: null, server: { state: "missing_home" } }), lang);
  const answer = await askServerDoctor(localUrl(config), config.accessCode, lang);
  if (answer.kind === "report") return answer.report;
  const server = answer.kind === "legacy" ? { state: "running" as const, ready: true, version: answer.version, legacy: true } : { state: answer.kind };
  return doctorReport(await localDoctorFacts({ home: config.home, config, server }), lang);
}

export async function doctorCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
  const { cliLang } = await import("../server/cli-text.ts");
  const { formatDoctorReport } = await import("../server/doctor.ts");
  const lang = cliLang();
  const report = await doctorReportForCli(lang);
  console.log(values.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report, lang));
  if (report.checks.some(check => check.state === "fail")) process.exitCode = 1;
}

function isDiagnoseResult(value: unknown): value is import("../shared/types.ts").DiagnoseResult {
  const v = value as { path?: unknown; sizeBytes?: unknown; createdAt?: unknown } | null;
  return !!v && typeof v.path === "string" && typeof v.sizeBytes === "number" && typeof v.createdAt === "string";
}

export async function diagnoseCommand(args: string[]): Promise<void> {
  parseArgs({ args, options: {} });
  const config = existingConfig();
  if (!config) throw new CliError(say("이 Mac에서 IAMCEO를 아직 시작한 적이 없어 진단할 데이터 폴더가 없습니다.", "IAMCEO has not been started on this Mac yet; there is no data folder to diagnose."));
  // 서버가 떠 있으면 서버가 만든다(실행 엔진·Tailscale·백업 상태를 안다). 꺼졌거나 옛 버전이면 여기서 만든다.
  let result: import("../shared/types.ts").DiagnoseResult | null = null;
  try {
    const response = await fetch(`${localUrl(config)}/api/diagnose`, {
      method: "POST", headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json" }, body: "{}",
      redirect: "error", signal: AbortSignal.timeout(60_000),
    });
    const body = response.ok ? await response.json().catch(() => null) : null;
    if (isDiagnoseResult(body)) result = body;
  } catch { /* 서버가 꺼져 있다 */ }
  if (!result) {
    const { cliLang } = await import("../server/cli-text.ts");
    const { createDiagnostics } = await import("../server/diagnose.ts");
    const { Database } = await import("bun:sqlite");
    const report = await doctorReportForCli(cliLang());
    let db: import("bun:sqlite").Database | null = null;
    try { if (existsSync(config.dbPath)) db = new Database(config.dbPath, { readonly: true }); } catch { db = null; }
    try {
      result = await createDiagnostics({ home: config.home, dbPath: config.dbPath, config, db, source: "cli",
        versions: { server: VERSION, buildId: await buildId().catch(() => null) }, doctor: report, server: null });
    } finally { db?.close(); }
  }
  const size = `${Math.max(1, Math.round(result.sizeBytes / 1024))} KB`;
  console.log(say(`진단 파일을 만들었습니다: ${result.path} (${size})\n대화 내용과 접속 코드는 넣지 않았습니다. 문제를 알릴 때 이 파일을 함께 보내 주세요.`,
    `Diagnostics file created: ${result.path} (${size})\nIt has no conversations and no access code. Attach it when you report a problem.`));
}

// ---- 설치 수명(B 묶음): upgrade · rollback · uninstall ----
/** 수명 명령의 오류는 사람이 읽을 문장이다. 쌓인 호출 기록 없이 그대로 보인다. */
async function lifecycleCommand<T>(run: () => Promise<T>): Promise<T> {
  const { LifecycleError } = await import("../server/lifecycle/launchd.ts");
  try { return await run(); }
  catch (error) { throw error instanceof LifecycleError ? new CliError(error.message) : error; }
}

function timeoutOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600) throw new CliError(say("--timeout 은 10~3600 초입니다", "--timeout must be 10 to 3600 seconds"));
  return seconds * 1000;
}

async function upgradeCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    version: { type: "string" }, from: { type: "string" }, "dry-run": { type: "boolean" }, force: { type: "boolean" },
    "allow-downgrade": { type: "boolean" }, "skip-rehearsal": { type: "boolean" }, timeout: { type: "string" },
  } });
  if (positionals.length > 1) throw new CliError(say("쓰는 법: iamceo upgrade [--version vX.Y.Z] [--dry-run] | iamceo upgrade <커밋>", "Usage: iamceo upgrade [--version vX.Y.Z] [--dry-run] | iamceo upgrade <commit>"));
  const { upgrade } = await import("../server/lifecycle/upgrade.ts");
  await lifecycleCommand(() => upgrade({ target: positionals[0], version: values.version, from: values.from, dryRun: values["dry-run"], force: values.force,
    allowDowngrade: values["allow-downgrade"], skipRehearsal: values["skip-rehearsal"], timeoutMs: timeoutOption(values.timeout) }));
}

async function rollbackCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { yes: { type: "boolean" }, "dry-run": { type: "boolean" }, timeout: { type: "string" } } });
  const { rollback } = await import("../server/lifecycle/upgrade.ts");
  await lifecycleCommand(() => rollback({ yes: values.yes, dryRun: values["dry-run"], timeoutMs: timeoutOption(values.timeout) }));
}

async function uninstallCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { purge: { type: "boolean" }, yes: { type: "boolean" }, "dry-run": { type: "boolean" }, "include-checkout": { type: "boolean" } } });
  const { uninstall } = await import("../server/lifecycle/uninstall.ts");
  await lifecycleCommand(() => uninstall({ purge: values.purge, yes: values.yes, dryRun: values["dry-run"], includeCheckout: values["include-checkout"] }));
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
      return console.log(say("인증·복구·실행 파일 확인 완료", "Authentication, recovery and build ID are ready"));
    case "auth": {
      const [sub, ...flags] = rest;
      // say 는 두 문구를 모두 만든다. 교체·끊기는 문구 밖에서 한 번만 한다.
      if (sub === "rotate" && flags.length === 0) {
        const code = await rotateAccessCode(loadConfig());
        return console.log(say(`접속 코드를 교체했습니다. 옛 코드로 붙어 있던 기기는 다시 연결하세요(QR로 연결해 기기 열쇠를 받은 기기는 그대로입니다. 그 열쇠까지 끊으려면 --all-devices).\n접속 코드: ${code}`,
          `The access code is replaced. Connect again from devices that used the old code (devices paired by QR keep their own key; add --all-devices to revoke those too).\nAccess code: ${code}`));
      }
      if (sub === "rotate" && flags.length === 1 && flags[0] === "--all-devices") {
        const { accessCode, revokedDevices } = await rotateAccess(loadConfig(), fetch, { allDevices: true });
        return console.log(say(`접속 코드를 교체하고 QR로 연결한 기기 ${revokedDevices}대의 열쇠도 끊었습니다. 모든 기기에서 다시 연결하세요(이 Mac의 앱은 '이 Mac에서 시작', iPhone은 Mac 앱에서 만든 새 QR로).\n접속 코드: ${accessCode}`,
          `The access code is replaced and the keys of ${revokedDevices} device(s) paired by QR are revoked. Connect again from every device (the app on this Mac with "Start on this Mac", iPhones with a new QR from the Mac app).\nAccess code: ${accessCode}`));
      }
      if (sub === "revoke-devices" && flags.length === 0) {
        const revoked = await revokeDeviceKeys(loadConfig());
        return console.log(say(`QR로 연결한 기기 ${revoked}대의 열쇠를 끊었습니다. 계속 쓸 기기는 Mac 앱에서 새 QR을 만들어 다시 연결하세요. 공용 접속 코드로 붙은 기기(이 Mac의 앱 등)는 그대로입니다.`,
          `Revoked the keys of ${revoked} device(s) paired by QR. Pair the devices you keep again with a new QR from the Mac app. Devices on the shared access code (such as the app on this Mac) stay connected.`));
      }
      // 0.2.5 X: 한 대만 끊기와 그 ID 를 찾는 목록. 다른 기기를 끊는 것은 서버가 도는 Mac 에서만 된다.
      if (sub === "devices" && flags.length === 0) return console.log(formatDeviceList(await listDeviceKeys(loadConfig())));
      if (sub === "revoke-device" && flags.length === 1 && flags[0] && !flags[0].startsWith("-")) {
        const name = await revokeDeviceKey(loadConfig(), flags[0]);
        return console.log(say(`‘${name}’의 연결을 끊었습니다. 그 기기를 다시 쓰려면 Mac 앱에서 새 QR을 만들어 연결하세요. 다른 기기는 그대로입니다.`,
          `Disconnected "${name}". To use that device again, pair it with a new QR from the Mac app. Other devices stay connected.`));
      }
      throw new CliError(say("쓰는 법: iamceo auth rotate [--all-devices] | iamceo auth revoke-devices | iamceo auth devices | iamceo auth revoke-device <ID>",
        "Usage: iamceo auth rotate [--all-devices] | iamceo auth revoke-devices | iamceo auth devices | iamceo auth revoke-device <ID>"));
    }
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
    case "doctor":
      return doctorCommand(rest);
    case "diagnose":
      return diagnoseCommand(rest);
    case "open":
      return open();
    case "import":
      return importDump(rest);
    case "service":
      return service(rest);
    case "upgrade":
      return upgradeCommand(rest);
    case "rollback":
      return rollbackCommand(rest);
    case "uninstall":
      return uninstallCommand(rest);
    case "upgrade-rehearse": {
      // 업그레이드가 새 판에게 시키는 예행(격리된 임시 홈에서만 돈다). 사람이 부르는 명령이 아니다.
      if (rest.length !== 2) throw new CliError("iamceo upgrade-rehearse <db> <report>");
      const { runRehearsalChild } = await import("../server/lifecycle/rehearse.ts");
      await runRehearsalChild(rest[0]!, rest[1]!, startOpsRuntime);
      // 남은 핸들이 예행을 붙잡지 않게 끝낸다.
      process.exit(0);
    }
    case "roles": {
      if (rest[0] !== "export") throw new CliError(`${say("쓰는 법: iamceo roles export", "Usage: iamceo roles export")}\n\n${usage()}`);
      const { exportRoles } = await import("../server/roles.ts");
      const paths = exportRoles(loadConfig().rolesDir);
      const list = paths.map((p) => `  ${p}`).join("\n");
      return console.log(say(`기본 역할 템플릿을 꺼냈습니다:\n${list}\n규칙을 더하려면 더할 글만 <kind>.extra.md 에 쓰세요. 기본 규칙 끝에 붙고, IAMCEO 를 올려도 기본 규칙의 개선을 그대로 받습니다.\n통째로 고치려면 .example 을 뺀 이름(<kind>.md)으로 저장하세요. 그 파일이 기본 규칙 전체를 대체합니다. 첫 줄의 기준판 표지는 지우지 마세요. 기본 규칙이 바뀌면 점검표(iamceo doctor)와 서버 로그가 알려 줍니다.`,
        `Copied the default role templates:\n${list}\nTo add rules, write only the additions in <kind>.extra.md. They go at the end of the default rules, and you keep getting improvements to the defaults when IAMCEO updates.\nTo change one entirely, save it without .example (<kind>.md). That file replaces the default rules. Keep the base marker on its first line: the self-check (iamceo doctor) and the server log tell you when the defaults change.`));
    }
    case "version":
    case "--version":
    case "-v":
      return console.log(VERSION);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return console.log(usage());
    default:
      throw new CliError(`${say("모르는 명령입니다", "Unknown command")}: ${command}\n\n${usage()}`);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    // 데이터 폴더를 다른 작업(켜져 있는 서버 등)이 쥐고 있으면 호출 기록 없이 한 줄로 알린다.
    console.error(e instanceof CliError || code?.startsWith("ERR_PARSE_ARGS") ? (e as Error).message
      : code === "home_in_use" ? say(`데이터 폴더를 다른 작업(켜져 있는 서버 등)이 사용 중입니다: ${(e as { home?: string }).home ?? homeDir()}. 서버를 끈 뒤 다시 실행하세요.`,
        `Another process (such as the running server) is using the data folder: ${(e as { home?: string }).home ?? homeDir()}. Stop the server and run this again.`)
      : e);
    process.exit(1);
  }
}
