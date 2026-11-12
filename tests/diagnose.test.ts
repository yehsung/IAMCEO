// D8 진단 파일: 버전·서비스 상태·점검표·로그 끝부분·멈춤 기록·백업 상태를 한 폴더와 zip 에 모은다.
// 대화·결재·할 일·전달의 본문, 첨부, 접속 코드, 팀장 열쇠, 알림 토큰, 환경 변수 값은 들어가지 않는다(여기서 확인한다).
// POST /api/diagnose 는 이 Mac 에서 온 요청만 받는다. `iamceo diagnose` 는 서버가 꺼져 있어도 만든다.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { DiagnoseResult } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, VERSION, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { buildZip, createDiagnostics, redact, serviceSummary } from "../server/diagnose.ts";
import { doctorReport } from "../server/doctor.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const ACCESS = "accesscode-SECRET-7k2m9q";
const BODY = "대화본문-SECRET-결제 실패 화면 문구";
const DECISION = "결재본문-SECRET-어느 쪽으로 할까요";
const DELIVERY = "전달본문-SECRET-이 일을 맡아 주세요";
const ATTACHMENT = "첨부내용-SECRET-pdf-bytes";
const PUSH = "pushtoken-SECRET-0123456789abcdef";
const ENV_VALUE = "envvalue-SECRET-do-not-copy";

function temp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** 비밀이 고루 든 데이터 홈. 서버 없이 Store 로 채운다. */
function seededHome() {
  const home = temp("iamceo-diagnose-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: ACCESS }, env);
  const config: Config = { ...loadConfig(env), hosts: ["127.0.0.1"], hostsAuto: true };
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const project = store.createProject({ name: "진단 시험", cwd: home });
  const member = store.createMember({ projectId: project.id, handle: "pay", name: "결제 연동", kind: "worker" });
  store.db.query("UPDATE members SET last_error = ? WHERE id = ?").run(`control_unknown: 화면 ${BODY}`, member.id);
  const token = store.db.query<{ token: string }, [string]>("SELECT token FROM members WHERE id = ?").get(member.id)!.token;
  store.createMessage({ projectId: project.id, kind: "나", mine: true, body: BODY });
  store.createMessage({ projectId: project.id, kind: "질문", memberId: member.id, body: DECISION, title: DECISION });
  const at = new Date().toISOString();
  store.db.query("INSERT INTO deliveries (id,project_id,member_id,kind,text,status,hold_reason,created_at,last_error) VALUES ('dl_1',?,?,'message',?,'held','runner_off',?,?)")
    .run(project.id, member.id, DELIVERY, at, `오류 ${DELIVERY}`);
  store.db.query(`INSERT INTO push_devices (id,label,platform,bundle_id,environment,token,authorization,enabled,state,registered_at,last_seen_at,expires_at)
    VALUES ('device','기기','ios','com.yehsung.iamceo','sandbox',?,'authorized',1,'active',?,?,?)`).run(PUSH, at, at, "2027-01-01T00:00:00.000Z");
  mkdirSync(config.uploadsDir, { recursive: true });
  writeFileSync(join(config.uploadsDir, "upload.bin"), ATTACHMENT);
  const logs = join(home, "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "server.log"), [
    "2026-11-13T00:00:00.000Z [startup] ready durationMs=120.0 pid=1 version=0.2.4",
    `2026-11-13T00:00:01.000Z 접속 코드 ${ACCESS} 를 잘못 찍은 줄`,
    `2026-11-13T00:00:02.000Z 팀장 열쇠 ${token}`,
    "2026-11-13T00:00:03.000Z Authorization: Bearer abcdefgh12345678",
    "2026-11-13T00:00:04.000Z [loop-monitor] timer:onTick count=3 maxMs=812.0",
    "",
  ].join("\n"));
  writeFileSync(join(logs, "server.err.log.1"), "2026-11-12T23:59:00.000Z [crash-guard] 2026-11-12T23:59:00.000Z uncaughtException — 서버는 계속 돕니다\n");
  return { home, config, store, bus, project, member, token };
}

/** 폴더 안 모든 파일의 글. */
function folderText(dir: string): string {
  let out = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    out += entry.isDirectory() ? folderText(path) : `\n--- ${entry.name}\n${readFileSync(path, "utf8")}`;
  }
  return out;
}

/** 이 파일이 만든 zip(deflate)만 푼다. */
function unzip(buffer: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const data = buffer.subarray(offset + 30 + nameLength + extra, offset + 30 + nameLength + extra + size);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    offset += 30 + nameLength + extra + size;
  }
  return files;
}

const SECRETS = (token: string) => [ACCESS, BODY, DECISION, DELIVERY, ATTACHMENT, PUSH, ENV_VALUE, token, "abcdefgh12345678", "결제 실패 화면"];

describe("진단 파일 만들기", () => {
  test("필요한 것은 모으고, 본문·첨부·접속 코드·열쇠·알림 토큰·환경 변수 값은 넣지 않는다", async () => {
    const t = seededHome();
    cleanups.push(() => t.store.db.close());
    process.env.IAMCEO_DIAG_SECRET = ENV_VALUE;
    cleanups.push(() => { delete process.env.IAMCEO_DIAG_SECRET; });
    const now = new Date("2026-11-13T03:04:05.000Z");
    // 합치기(L): 전달 펌프의 판정이 팀장 줄에 실린다.
    t.store.recordPumpVerdict(t.member.id, { code: "runner_off" }, Date.parse("2026-11-13T03:00:00.000Z"));
    const result = await createDiagnostics({
      home: t.home, dbPath: t.config.dbPath, config: t.config, db: t.store.db, source: "server",
      versions: { server: VERSION, buildId: "build-1" },
      doctor: null, server: { ready: true, pid: 1 },
      service: async () => serviceSummary("gui/501/com.iamceo.server = {\n\tstate = running\n\tpid = 99\n\tenvironment = {\n\t\tIAMCEO_DIAG_SECRET => envvalue-SECRET-do-not-copy\n\t}\n\tlast exit code = 0\n}\n"),
      crashReportsDir: null, now,
    });
    expect(result.createdAt).toBe(now.toISOString());
    expect(result.path.startsWith(join(t.home, "diagnostics") + "/")).toBe(true);
    expect(result.path.endsWith(".zip")).toBe(true);
    expect(result.sizeBytes).toBe(statSync(result.path).size);
    const dir = result.path.slice(0, -".zip".length);
    expect(statSync(join(t.home, "diagnostics")).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    for (const name of ["README.txt", "summary.json", "service.txt", "database.json", "backups.json", "events.txt", "logs/server.log.txt", "logs/server.err.log.1.txt"]) {
      expect(existsSync(join(dir, name))).toBe(true);
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }

    const text = folderText(dir);
    const zipped = unzip(readFileSync(result.path));
    const base = dir.split("/").at(-1)!;
    expect([...zipped.keys()].every(name => name.startsWith(`${base}/`))).toBe(true);
    expect(zipped.get(`${base}/summary.json`)).toBe(readFileSync(join(dir, "summary.json"), "utf8"));
    const all = text + [...zipped.values()].join("\n");
    for (const secret of SECRETS(t.token)) expect(all).not.toContain(secret);

    // 모은 것: 버전, 비밀 아닌 설정, 서비스 줄, 멈춤 기록, DB 요약.
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    expect(summary.versions).toMatchObject({ server: VERSION, buildId: "build-1" });
    expect(summary.config).toMatchObject({ home: t.home, hosts: ["127.0.0.1"] });
    expect(summary.config.accessCode).toBeUndefined();
    expect(summary.environmentNames).toContain("IAMCEO_DIAG_SECRET");
    expect(readFileSync(join(dir, "service.txt"), "utf8")).toBe("state = running\npid = 99\nlast exit code = 0\n");
    const events = readFileSync(join(dir, "events.txt"), "utf8");
    expect(events).toContain("[startup] ready");
    expect(events).toContain("[loop-monitor] timer:onTick");
    expect(events).toContain("[crash-guard]");
    expect(events.indexOf("[crash-guard]")).toBeLessThan(events.indexOf("[startup]"));
    expect(readFileSync(join(dir, "logs/server.log.txt"), "utf8")).toContain("접속 코드 [가림] 를 잘못 찍은 줄");
    const database = JSON.parse(readFileSync(join(dir, "database.json"), "utf8"));
    expect(database.schemaVersion).toBeGreaterThan(0);
    expect(database.rowCounts.messages).toBe(2);
    expect(database.members).toHaveLength(1);
    expect(database.members[0]).toMatchObject({ id: t.member.id, kind: "worker", errorCode: "control_unknown" });
    expect(database.members[0].name).toBeUndefined();
    expect(database.members[0].pumpVerdict).toEqual({ code: "runner_off", since: "2026-11-13T03:00:00.000Z", overdueAt: null });
    expect(database.openDeliveries).toEqual([expect.objectContaining({ id: "dl_1", status: "held", hold_reason: "runner_off", errorCode: "text" })]);
    expect(database.openDeliveries[0].text).toBeUndefined();
    expect(database.pushDevices).toEqual([{ environment: "sandbox", state: "active", enabled: 1, n: 1 }]);
    expect(database.projects[0].name).toBeUndefined();
  });

  test("점검표를 함께 넣고, 새 것부터 다섯 묶음만 남긴다", async () => {
    const t = seededHome();
    cleanups.push(() => t.store.db.close());
    const report = doctorReport({
      now: new Date(), server: { state: "down" },
      engine: { installed: false, available: null, version: null, detail: null, status: null },
      providers: { claude: { installed: false, login: "no" }, codex: { installed: false, login: "no" } }, codexInUse: null, cliVersions: null,
      tailscale: { auto: true, address: null, everOpened: false, status: null }, service: { state: "unknown" }, backup: null, disk: null,
    }, "ko");
    const results: DiagnoseResult[] = [];
    for (let i = 0; i < 7; i++) {
      results.push(await createDiagnostics({ home: t.home, dbPath: t.config.dbPath, config: t.config, db: t.store.db, source: "cli",
        versions: { server: VERSION }, doctor: report, service: async () => null, crashReportsDir: null, now: new Date(Date.UTC(2026, 10, 13, 3, 0, i)) }));
    }
    // 같은 초에 또 만들면 이름 뒤에 번호가 붙는다.
    const same = await createDiagnostics({ home: t.home, dbPath: t.config.dbPath, config: t.config, db: null, source: "cli",
      versions: { server: VERSION }, doctor: null, service: async () => null, crashReportsDir: null, now: new Date(Date.UTC(2026, 10, 13, 3, 0, 6)) });
    expect(same.path).toEndWith("-2.zip");
    const left = readdirSync(join(t.home, "diagnostics")).sort();
    expect(left.filter(name => name.endsWith(".zip"))).toHaveLength(5);
    expect(left.filter(name => !name.endsWith(".zip"))).toHaveLength(5);
    expect(existsSync(results[0]!.path)).toBe(false);
    expect(existsSync(results[6]!.path)).toBe(true);
    const dir = results[6]!.path.slice(0, -4);
    expect(JSON.parse(readFileSync(join(dir, "doctor.json"), "utf8"))).toEqual(report);
    expect(readFileSync(join(dir, "doctor.txt"), "utf8")).toContain("✗ 서버");
  });

  test("가리기와 서비스 요약, zip 모양", () => {
    expect(redact("a SECRETVALUE1 b SECRETVALUE1", ["SECRETVALUE1"])).toBe("a [가림] b [가림]");
    expect(redact('{"accessCode":"abcdefgh2345"} token=zzzzzzzzzz Bearer qwertyuiop', [])).toBe('{"accessCode":"[가림]"} token=[가림] Bearer [가림]');
    expect(serviceSummary("gui/1/x = {\n\tpath = /p\n\targuments = {\n\t\tstate = fake\n\t}\n\tpid = 3\n}\n")).toBe("path = /p\npid = 3");
    const zip = buildZip([{ name: "a/b.txt", data: Buffer.from("안녕 hello") }, { name: "a/c.json", data: Buffer.from("{}") }], new Date(2026, 10, 13, 3, 4, 6));
    expect(unzip(zip)).toEqual(new Map([["a/b.txt", "안녕 hello"], ["a/c.json", "{}"]]));
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(2);
  });

  test("macOS 의 unzip 으로도 풀린다", async () => {
    if (!existsSync("/usr/bin/unzip")) return;
    const t = seededHome();
    cleanups.push(() => t.store.db.close());
    const result = await createDiagnostics({ home: t.home, dbPath: t.config.dbPath, config: t.config, db: t.store.db, source: "cli",
      versions: { server: VERSION }, doctor: null, service: async () => null, crashReportsDir: null });
    const check = Bun.spawnSync(["/usr/bin/unzip", "-t", result.path], { stdout: "pipe", stderr: "pipe" });
    expect(check.exitCode).toBe(0);
    expect(check.stdout.toString()).toContain("No errors detected");
  });
});

// ---- POST /api/diagnose ----

async function boot() {
  const t = seededHome();
  const orch = new Orchestrator({ config: t.config, store: t.store, runners: new Map(), notifier: () => {} });
  const context = {
    config: t.config, store: t.store, bus: t.bus, orch, detectHosts: () => [],
    daemon: () => ({ ready: true, buildId: "build-http", version: VERSION }),
    doctorProbes: { service: async () => ({ state: "running" as const }), disk: () => ({ freeBytes: 50e9, totalBytes: 100e9 }), login: () => "yes" as const, cliVersions: async () => null },
    diagnose: { service: async () => "state = running", crashReportsDir: null },
  };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); t.store.db.close(); });
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", ...init, headers: { Authorization: `Bearer ${ACCESS}`, ...init.headers } });
  return { ...t, server, request };
}

describe("POST /api/diagnose", () => {
  test("이 Mac 에서 온 요청이면 진단 파일을 만들고 위치·크기·시각을 준다", async () => {
    const t = await boot();
    const response = await t.request("/api/diagnose", { headers: { "X-IAMCEO-App-Version": "0.2.4", "X-IAMCEO-App-Build": "12", "X-IAMCEO-App-Platform": "macos", "X-IAMCEO-Api-Level": "1" } });
    expect(response.status).toBe(200);
    const result = await response.json() as DiagnoseResult;
    expect(Object.keys(result).sort()).toEqual(["createdAt", "path", "sizeBytes"]);
    expect(result.path.startsWith(join(t.home, "diagnostics") + "/")).toBe(true);
    expect(result.sizeBytes).toBe(statSync(result.path).size);
    const dir = result.path.slice(0, -4);
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    expect(summary.source).toBe("server");
    expect(summary.versions.buildId).toBe("build-http");
    expect(summary.server).toMatchObject({ ready: true, pid: process.pid, requestedBy: { version: "0.2.4", platform: "macos" } });
    // 합치기(N): HTTPS 주소의 상태와 까닭 코드만(켠 적이 없으면 off, tailscale 을 부르지 않는다).
    expect(summary.server.tailnetHttps).toMatchObject({ state: "off", problem: null });
    const doctor = JSON.parse(readFileSync(join(dir, "doctor.json"), "utf8"));
    expect(doctor.checks.find((check: { id: string }) => check.id === "server").state).toBe("ok");
    for (const secret of SECRETS(t.token)) expect(folderText(dir)).not.toContain(secret);
    // 빈 몸 {} 도 받는다.
    expect((await t.request("/api/diagnose", { body: "{}", headers: { "Content-Type": "application/json" } })).status).toBe(200);
  });

  test("대리 전달 헤더가 붙은 요청(다른 기기·tailscale serve)은 막고, 인증·메서드·몸을 검사한다", async () => {
    const t = await boot();
    const forwarded = await t.request("/api/diagnose", { headers: { "X-Forwarded-For": "100.64.0.9" } });
    expect(forwarded.status).toBe(403);
    expect((await forwarded.json() as { code?: string }).code).toBe("LOCAL_ONLY");
    expect((await fetch(`http://127.0.0.1:${t.server.port}/api/diagnose`, { method: "POST" })).status).toBe(401);
    expect((await t.request("/api/diagnose", { method: "GET" })).status).toBe(405);
    expect((await t.request("/api/diagnose", { body: JSON.stringify({ out: "/tmp" }), headers: { "Content-Type": "application/json" } })).status).toBe(400);
    expect(existsSync(join(t.home, "diagnostics"))).toBe(false);
  });
});

// ---- iamceo diagnose ----

const BIN = resolve(import.meta.dir, "..", "bin", "iamceo.ts");

describe("iamceo diagnose", () => {
  test("서버가 꺼져 있어도 이 Mac 에서 만든다. 데이터 폴더가 없으면 만들지 않고 알린다", async () => {
    const t = seededHome();
    t.store.db.close();
    const userHome = temp("iamceo-diagnose-user-");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    Object.assign(env, { IAMCEO_HOME: t.home, IAMCEO_PORT: "0", IAMCEO_TEST: "1", HOME: userHome, IAMCEO_LANG: "ko",
      CLAUDE_CONFIG_DIR: join(userHome, ".claude"), CODEX_HOME: join(userHome, ".codex"),
      IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false", IAMCEO_CORE_BIN: "/usr/bin/false" });
    const run = async (home: string) => {
      const child = Bun.spawn([process.execPath, BIN, "diagnose"], { env: { ...env, IAMCEO_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return { stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text(), code: await child.exited };
    };
    const made = await run(t.home);
    expect(made.code).toBe(0);
    const path = /진단 파일을 만들었습니다: (\S+\.zip)/.exec(made.stdout)?.[1];
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
    const dir = path!.slice(0, -4);
    expect(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).source).toBe("cli");
    expect(JSON.parse(readFileSync(join(dir, "doctor.json"), "utf8")).checks[0]).toMatchObject({ id: "server", state: "fail" });
    expect(JSON.parse(readFileSync(join(dir, "database.json"), "utf8")).rowCounts.messages).toBe(2);
    for (const secret of SECRETS(t.token)) expect(folderText(dir)).not.toContain(secret);

    const missing = join(temp("iamceo-diagnose-none-"), "never");
    const refused = await run(missing);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("아직 시작한 적이 없어");
    expect(existsSync(missing)).toBe(false);
  }, 30_000);
});
