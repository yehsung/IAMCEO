// B3 스스로 점검: 판정(사실 → 점검표), 사실 모으기(로그인 기록·자동 시작·백업), GET /api/doctor, `iamceo doctor`(서버가 꺼져 있어도).
// 진짜 launchctl·Claude·Codex 를 부르지 않는다: 판정은 주입한 사실로, 모으기는 임시 홈과 가짜 명령으로 시험한다.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DOCTOR_CHECK_IDS, type DoctorReport } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, VERSION, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { askServerDoctor, doctorChecks, doctorReport, formatDoctorReport, newestBackupAt, probeLogin, probeService, type DoctorFacts } from "../server/doctor.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const NOW = new Date("2026-11-13T03:00:00.000Z");
const HOUR = 3_600_000;

function temp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** 모두 정상인 Mac. 시험마다 한 군데만 바꾼다. */
function healthy(patch: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    now: NOW,
    server: { state: "running", ready: true, version: "0.2.4" },
    engine: { installed: true, available: true, version: "0.5.2", detail: null, status: { state: "ok", version: "0.5.2", expectedVersion: "0.5.2" } },
    providers: { claude: { installed: true, login: "yes" }, codex: { installed: true, login: "yes" } },
    codexInUse: true,
    cliVersions: [
      { provider: "claude", installed: true, version: "2.1.322", known: true },
      { provider: "codex", installed: true, version: "0.166.0", known: true },
    ],
    tailscale: { auto: true, address: "100.64.0.7", everOpened: true, status: { state: "ok", lastAddress: "100.64.0.7" } },
    service: { state: "running", pid: 42 },
    backup: { lastSuccessAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(), failing: false, failures: 0, cause: null, intervalMs: 24 * HOUR, homeAgeMs: 30 * 24 * HOUR },
    disk: { freeBytes: 120e9, totalBytes: 500e9 },
    ...patch,
  };
}

const byId = (facts: DoctorFacts, lang: "ko" | "en" = "ko") => Object.fromEntries(doctorChecks(facts, lang).map(check => [check.id, check]));

describe("점검 판정", () => {
  test("항목 id 는 약속한 아홉 개이고 순서가 고정이다. 모두 정상이면 고치는 법이 없다", () => {
    expect([...DOCTOR_CHECK_IDS].sort()).toEqual(["backup", "claude", "cli_version", "codex", "disk", "engine", "server", "service", "tailscale"]);
    const checks = doctorChecks(healthy());
    expect(checks.map(check => check.id)).toEqual([...DOCTOR_CHECK_IDS]);
    for (const check of checks) {
      expect(check.state).toBe("ok");
      expect(check.fix).toBeUndefined();
      expect(check.title.length).toBeGreaterThan(0);
    }
    const report = doctorReport(healthy(), "ko", "0.2.4");
    expect(report).toEqual({ checkedAt: NOW.toISOString(), serverVersion: "0.2.4", checks });
    expect(byId(healthy()).claude!.detail).toBe("설치됨 · 2.1.322 · 로그인됨");
    expect(byId(healthy()).cli_version!.detail).toContain("Claude Code 2.1.322 · Codex 0.166.0");
  });

  test("서버: 꺼짐·처음·시작 중·접속 코드 불일치·옛 서버", () => {
    expect(byId(healthy({ server: { state: "down" } })).server).toMatchObject({ state: "fail", detail: "서버에 연결하지 못했습니다(꺼져 있음)" });
    expect(byId(healthy({ server: { state: "down" } })).server!.fix).toContain("이 Mac에서 시작");
    expect(byId(healthy({ server: { state: "missing_home" } })).server!.state).toBe("fail");
    expect(byId(healthy({ server: { state: "starting" } })).server!.state).toBe("warn");
    expect(byId(healthy({ server: { state: "running", ready: false, version: "0.2.4" } })).server!.state).toBe("warn");
    expect(byId(healthy({ server: { state: "auth" } })).server!.state).toBe("fail");
    expect(byId(healthy({ server: { state: "running", ready: true, version: "0.2.3", legacy: true } })).server).toMatchObject({ state: "ok" });
    // 서버가 꺼져 있는데 자동 시작도 등록돼 있지 않으면 그것도 문제다.
    expect(byId(healthy({ server: { state: "down" }, service: { state: "missing" } })).service!.state).toBe("fail");
    expect(byId(healthy({ service: { state: "missing" } })).service!.state).toBe("warn");
  });

  test("실행 엔진: 없음·응답 없음·버전 다름·연결 실패·서버 꺼짐", () => {
    const engine = (patch: Partial<DoctorFacts["engine"]>) => byId(healthy({ engine: { ...healthy().engine, ...patch } })).engine!;
    expect(engine({ installed: false })).toMatchObject({ state: "fail" });
    expect(engine({ installed: false }).fix).toContain("brew reinstall --cask yehsung/tap/iamceo");
    expect(engine({ status: { state: "unresponsive", expectedVersion: "0.5.2" } }).state).toBe("fail");
    const mismatch = engine({ status: { state: "version_mismatch", version: "0.5.1", expectedVersion: "0.5.2" } });
    expect(mismatch.state).toBe("warn");
    expect(mismatch.detail).toContain("0.5.1");
    expect(mismatch.detail).toContain("0.5.2");
    expect(engine({ available: false, status: null, detail: "소켓 없음" })).toMatchObject({ state: "fail", detail: "사용할 수 없음 · 소켓 없음" });
    expect(engine({ available: null, status: null }).state).toBe("unknown");
  });

  test("Claude·Codex: 설치와 로그인. Codex 는 쓰는 팀장이 없으면 선택 기능이다", () => {
    const claude = (p: DoctorFacts["providers"]["claude"]) => byId(healthy({ providers: { ...healthy().providers, claude: p } })).claude!;
    expect(claude({ installed: false, login: "no" }).state).toBe("fail");
    expect(claude({ installed: true, login: "no" })).toMatchObject({ state: "warn", detail: "설치됨 · 2.1.322 · 로그인 기록을 찾지 못했습니다" });
    expect(claude({ installed: true, login: "unknown" }).state).toBe("unknown");
    const codex = (p: DoctorFacts["providers"]["codex"], codexInUse: boolean | null) => byId(healthy({ providers: { ...healthy().providers, codex: p }, codexInUse })).codex!;
    const optional = codex({ installed: false, login: "no" }, false);
    expect(optional.state).toBe("unknown");
    expect(optional.fix).toBeUndefined();
    expect(codex({ installed: false, login: "no" }, null).state).toBe("unknown");
    expect(codex({ installed: false, login: "no" }, true).state).toBe("fail");
    expect(codex({ installed: true, login: "no" }, true).state).toBe("warn");
    expect(codex({ installed: true, login: "no" }, false).state).toBe("unknown");
  });

  test("CLI 버전: 견본이 없는 버전이면 '확인되지 않은 CLI 버전'", () => {
    const unverified = byId(healthy({ cliVersions: [{ provider: "claude", installed: true, version: "2.1.400", known: false }, { provider: "codex", installed: false, version: null, known: false }] })).cli_version!;
    expect(unverified.state).toBe("warn");
    expect(unverified.detail).toBe("확인되지 않은 CLI 버전: Claude Code 2.1.400");
    expect(unverified.fix).toBeDefined();
    expect(byId(healthy({ cliVersions: null })).cli_version!.state).toBe("unknown");
    expect(byId(healthy({ cliVersions: [{ provider: "claude", installed: true, version: null, known: false }] })).cli_version!.state).toBe("unknown");
    expect(byId(healthy({ cliVersions: [{ provider: "claude", installed: false, version: null, known: false }] })).cli_version!.state).toBe("unknown");
  });

  test("Tailscale: 꺼짐은 iPhone 을 쓰던 설치에서만 문제다", () => {
    const ts = (patch: Partial<DoctorFacts["tailscale"]>) => byId(healthy({ tailscale: { ...healthy().tailscale, ...patch } })).tailscale!;
    expect(ts({ status: { state: "off", lastAddress: "100.64.0.7" }, address: null })).toMatchObject({ state: "fail", fix: "메뉴 막대에서 Tailscale을 켜세요." });
    expect(ts({ status: null, address: null, everOpened: true }).state).toBe("fail");
    expect(ts({ status: null, address: null, everOpened: false }).state).toBe("unknown");
    expect(ts({ status: null, address: null, auto: false }).state).toBe("unknown");
    expect(ts({ status: null }).detail).toBe("켜짐 · 100.64.0.7");
  });

  test("백업·저장 공간", () => {
    const backup = (patch: Partial<NonNullable<DoctorFacts["backup"]>>) => byId(healthy({ backup: { ...healthy().backup!, ...patch } })).backup!;
    expect(backup({ failing: true, failures: 3, cause: "ENOSPC" })).toMatchObject({ state: "fail", detail: "정기 백업이 3번 이어서 실패했습니다 (ENOSPC)" });
    expect(backup({ lastSuccessAt: new Date(NOW.getTime() - 72 * HOUR).toISOString() })).toMatchObject({ state: "warn", detail: "마지막 백업이 3일 전입니다" });
    expect(backup({ lastSuccessAt: null, homeAgeMs: HOUR }).state).toBe("unknown");
    expect(backup({ lastSuccessAt: null, homeAgeMs: 30 * 24 * HOUR }).state).toBe("warn");
    expect(backup({}).detail).toBe("마지막 백업 3시간 전");
    expect(byId(healthy({ backup: null })).backup!.state).toBe("unknown");
    const disk = (freeBytes: number) => byId(healthy({ disk: { freeBytes, totalBytes: 500e9 } })).disk!;
    expect(disk(0.5e9).state).toBe("fail");
    expect(disk(3e9)).toMatchObject({ state: "warn", detail: "남은 공간 3.0 GB" });
    expect(disk(120e9)).toMatchObject({ state: "ok", detail: "남은 공간 120 GB" });
    expect(byId(healthy({ disk: null })).disk!.state).toBe("unknown");
  });

  test("고치는 법은 일반 사용자가 할 수 있는 동작만 가리킨다(개발자 명령 없음). 영어로도 낸다", () => {
    const variants: DoctorFacts[] = [
      healthy({ server: { state: "down" }, service: { state: "missing" }, engine: { installed: false, available: null, version: null, detail: null, status: null } }),
      healthy({ providers: { claude: { installed: false, login: "no" }, codex: { installed: false, login: "no" } }, codexInUse: true }),
      healthy({ tailscale: { auto: true, address: null, everOpened: false, status: null }, backup: { lastSuccessAt: null, failing: true, failures: 1, cause: null, intervalMs: 1, homeAgeMs: 1 }, disk: { freeBytes: 1, totalBytes: 2 } }),
      healthy({ cliVersions: [{ provider: "codex", installed: true, version: "9.9.9", known: false }], service: { state: "not_loaded" }, server: { state: "auth" } }),
    ];
    for (const facts of variants) {
      for (const lang of ["ko", "en"] as const) {
        for (const check of doctorChecks(facts, lang)) {
          const text = `${check.detail ?? ""} ${check.fix ?? ""}`;
          expect(text).not.toMatch(/bun run|setup:core|iamceo open/);
          // 문제나 확인 필요에는 고치는 법이 붙는다.
          if (check.state === "fail" || check.state === "warn") expect(check.fix).toBeDefined();
        }
      }
    }
    const en = byId(healthy({ server: { state: "down" } }), "en");
    expect(en.server).toMatchObject({ title: "Server", state: "fail" });
    expect(en.server!.fix).toContain("Start on this Mac");
  });

  test("명령줄 출력: 표시와 고치는 법, 요약 줄", () => {
    const report = doctorReport(healthy({ server: { state: "down" }, disk: { freeBytes: 3e9, totalBytes: 9e9 } }), "ko", "0.2.4");
    const text = formatDoctorReport(report, "ko");
    expect(text).toContain("✗ 서버 — 서버에 연결하지 못했습니다(꺼져 있음)");
    expect(text).toContain("    고치는 법: Mac 앱의 연결 화면에서 '이 Mac에서 시작'을 누르세요.");
    expect(text).toContain("! 저장 공간 — 남은 공간 3.0 GB");
    expect(text.trim().split("\n").at(-1)).toBe("문제 1 · 확인 필요 1");
    expect(formatDoctorReport(doctorReport(healthy(), "en"), "en").trim().split("\n").at(-1)).toBe("All good.");
  });
});

describe("사실 모으기", () => {
  test("로그인 기록: Claude 는 oauthAccount·credentials·환경 변수, Codex 는 auth.json. 내용은 읽어 두지 않는다", () => {
    const home = temp("iamceo-doctor-login-");
    const env = {} as NodeJS.ProcessEnv;
    expect(probeLogin("claude", { userHome: home }, env)).toBe("no");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3 }));
    expect(probeLogin("claude", { userHome: home }, env)).toBe("no");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: "x" } }));
    expect(probeLogin("claude", { userHome: home }, env)).toBe("yes");
    const configDir = temp("iamceo-doctor-claude-dir-");
    expect(probeLogin("claude", { userHome: home, claudeHome: configDir }, env)).toBe("no");
    writeFileSync(join(configDir, ".credentials.json"), "{}");
    expect(probeLogin("claude", { userHome: home, claudeHome: configDir }, env)).toBe("yes");
    expect(probeLogin("claude", { userHome: temp("iamceo-doctor-empty-") }, { ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv)).toBe("yes");

    const codexHome = temp("iamceo-doctor-codex-");
    expect(probeLogin("codex", { userHome: home, codexHome }, env)).toBe("no");
    writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    expect(probeLogin("codex", { userHome: home, codexHome }, env)).toBe("unknown");
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { id_token: "x" } }));
    expect(probeLogin("codex", { userHome: home, codexHome }, env)).toBe("yes");
  });

  test("자동 시작: launchctl print·plutil 의 답으로 판정한다(진짜 launchctl 은 부르지 않는다)", async () => {
    const userHome = temp("iamceo-doctor-service-");
    const dataHome = join(userHome, ".iamceo");
    mkdirSync(dataHome);
    const calls: string[][] = [];
    const runner = (answers: { plutil?: { code: number; stdout: string }; print: { code: number; stdout: string } }) => async (command: string[]) => {
      calls.push(command);
      return command[0]!.endsWith("plutil") ? answers.plutil ?? { code: 1, stdout: "" } : answers.print;
    };
    const opts = { userHome, uid: 501, platform: "darwin" };
    expect(await probeService(dataHome, { ...opts, run: runner({ print: { code: 113, stdout: "" } }) })).toEqual({ state: "missing" });
    expect(calls.at(-1)).toEqual(["/bin/launchctl", "print", "gui/501/com.iamceo.server"]);
    mkdirSync(join(userHome, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(userHome, "Library", "LaunchAgents", "com.iamceo.server.plist"), "<plist/>");
    const ours = { code: 0, stdout: JSON.stringify({ EnvironmentVariables: { IAMCEO_HOME: dataHome } }) };
    expect(await probeService(dataHome, { ...opts, run: runner({ plutil: ours, print: { code: 113, stdout: "" } }) })).toEqual({ state: "not_loaded" });
    const printed = "gui/501/com.iamceo.server = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n\tenvironment = {\n\t\tPATH => /usr/bin\n\t}\n}\n";
    expect(await probeService(dataHome, { ...opts, run: runner({ plutil: ours, print: { code: 0, stdout: printed } }) })).toEqual({ state: "running", pid: 4242 });
    const stopped = "gui/501/com.iamceo.server = {\n\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n}\n";
    expect(await probeService(dataHome, { ...opts, run: runner({ plutil: ours, print: { code: 0, stdout: stopped } }) })).toEqual({ state: "loaded", lastExitCode: 78 });
    const other = { code: 0, stdout: JSON.stringify({ EnvironmentVariables: { IAMCEO_HOME: join(userHome, "elsewhere") } }) };
    expect(await probeService(dataHome, { ...opts, run: runner({ plutil: other, print: { code: 0, stdout: printed } }) })).toEqual({ state: "other_home" });
    // IAMCEO_HOME 이 없는 서비스는 기본 홈(~/.iamceo)을 쓴다.
    const defaultHome = { code: 0, stdout: JSON.stringify({ EnvironmentVariables: {} }) };
    expect(await probeService(dataHome, { ...opts, run: runner({ plutil: defaultHome, print: { code: 0, stdout: printed } }) })).toEqual({ state: "running", pid: 4242 });
    expect(await probeService(dataHome, { ...opts, platform: "linux", run: runner({ print: { code: 0, stdout: printed } }) })).toEqual({ state: "unknown" });
    // 시험 환경에서 run 을 주지 않으면 진짜 launchctl 을 부르지 않는다.
    expect(process.env.IAMCEO_TEST).toBe("1");
    expect(await probeService(dataHome, { userHome, platform: "darwin" })).toEqual({ state: "unknown" });
  });

  test("가장 새 백업: 다 만든(manifest.json 이 있는) 것만 센다", () => {
    const dir = temp("iamceo-doctor-backup-");
    expect(newestBackupAt(join(dir, "none"))).toBeNull();
    const older = Date.parse("2026-11-10T00:00:00.000Z"), newer = Date.parse("2026-11-12T00:00:00.000Z"), partial = Date.parse("2026-11-13T00:00:00.000Z");
    const name = (ms: number, n: number) => `snapshot-${String(ms).padStart(13, "0")}-0000000${n}-0000-0000-0000-000000000000`;
    for (const [ms, n, done] of [[older, 1, true], [newer, 2, true], [partial, 3, false]] as const) {
      mkdirSync(join(dir, name(ms, n)));
      if (done) writeFileSync(join(dir, name(ms, n), "manifest.json"), "{}");
    }
    mkdirSync(join(dir, "not-a-snapshot"));
    expect(newestBackupAt(dir)).toBe(new Date(newer).toISOString());
  });
});

// ---- GET /api/doctor ----

function freshConfig(): Config {
  const home = temp("iamceo-doctor-http-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  // Codex 는 설치되지 않은 Mac 으로 둔다(쓰는 팀장이 있을 때만 문제인지 본다).
  return { ...loadConfig(env), hosts: ["127.0.0.1"], hostsAuto: true, codexBin: join(home, "no-such-codex") };
}

async function boot(options: { ready?: boolean } = {}) {
  const config = freshConfig();
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const orch = new Orchestrator({ config, store, runners: new Map(), notifier: () => {} });
  let ready = options.ready ?? true;
  const context = {
    config, store, bus, orch, detectHosts: () => [],
    daemon: () => ({ ready, buildId: "build", version: VERSION }),
    doctorProbes: {
      service: async () => ({ state: "running" as const, pid: 7 }),
      disk: () => ({ freeBytes: 50e9, totalBytes: 100e9 }),
      login: () => "yes" as const,
      cliVersions: async () => [{ provider: "claude" as const, installed: true, version: "2.1.322", known: true }, { provider: "codex" as const, installed: false, version: null, known: false }],
    },
  };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); store.db.close(); });
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { Authorization: "Bearer code", ...init.headers } });
  return { config, store, server, request, setReady: (value: boolean) => { ready = value; } };
}

describe("GET /api/doctor", () => {
  test("약속한 모양의 점검표를 준다. 서버가 아는 값과 주입한 사실을 쓴다", async () => {
    const t = await boot();
    const response = await t.request("/api/doctor");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const report = await response.json() as DoctorReport;
    expect(report.serverVersion).toBe(VERSION);
    expect(new Date(report.checkedAt).toISOString()).toBe(report.checkedAt);
    expect(report.checks.map(check => check.id)).toEqual([...DOCTOR_CHECK_IDS]);
    const checks = Object.fromEntries(report.checks.map(check => [check.id, check]));
    expect(checks.server).toMatchObject({ state: "ok", title: "서버", detail: `실행 중 · ${VERSION}` });
    expect(checks.service).toMatchObject({ state: "ok" });
    expect(checks.disk).toMatchObject({ state: "ok", detail: "남은 공간 50.0 GB" });
    expect(checks.claude!.state).toBe("ok");
    // 실행기 없는 시험 조립이라 실행 엔진은 붙어 있지 않다.
    expect(["fail", "unknown"]).toContain(checks.engine!.state);
    // 쓰는 팀장이 없으니 Codex 가 없어도 문제가 아니다.
    expect(checks.codex).toMatchObject({ state: "unknown" });
    // Tailscale 주소를 연 적이 없는 설치다.
    expect(checks.tailscale!.state).toBe("unknown");
    // 막 만든 DB 라 백업이 없는 것은 아직 문제가 아니다.
    expect(checks.backup!.state).toBe("unknown");
    for (const check of report.checks) for (const key of Object.keys(check)) expect(["id", "state", "title", "detail", "fix"]).toContain(key);
  });

  test("Codex 를 쓰는 팀장이 있는데 Codex 가 없으면 문제다. 영어로도 준다", async () => {
    const t = await boot();
    const project = t.store.createProject({ name: "코덱스", cwd: t.config.home });
    t.store.createMember({ projectId: project.id, handle: "cx", name: "코덱스 팀장", kind: "worker", cli: "codex" });
    const report = await (await t.request("/api/doctor?lang=en")).json() as DoctorReport;
    const codex = report.checks.find(check => check.id === "codex")!;
    expect(codex.state).toBe("fail");
    expect(codex.fix).toContain("npm install -g @openai/codex");
    expect(report.checks.find(check => check.id === "server")!.title).toBe("Server");
  });

  test("인증·검증·시작 중", async () => {
    const t = await boot();
    expect((await fetch(`http://127.0.0.1:${t.server.port}/api/doctor`)).status).toBe(401);
    expect((await t.request("/api/doctor?x=1")).status).toBe(400);
    expect((await t.request("/api/doctor", { method: "POST" })).status).toBe(405);
    t.setReady(false);
    const starting = await t.request("/api/doctor");
    expect(starting.status).toBe(503);
    expect((await starting.json() as { code?: string }).code).toBe("STARTING");
  });

  test("명령줄의 서버 묻기: 점검표·옛 서버·시작 중·꺼짐을 가른다", async () => {
    const t = await boot();
    const base = `http://127.0.0.1:${t.server.port}`;
    const answer = await askServerDoctor(base, "code", "ko");
    expect(answer.kind).toBe("report");
    expect((await askServerDoctor(base, "wrong", "ko")).kind).toBe("auth");
    const legacy: typeof fetch = Object.assign(async (input: RequestInfo | URL) => String(input).includes("/api/doctor")
      ? new Response(JSON.stringify({ error: "없는 경로입니다" }), { status: 404 })
      : Response.json({ ok: true, version: "0.2.3" }), { preconnect: () => {} });
    expect(await askServerDoctor(base, "code", "ko", legacy)).toEqual({ kind: "legacy", version: "0.2.3" });
    t.setReady(false);
    expect((await askServerDoctor(base, "code", "ko")).kind).toBe("starting");
    expect((await askServerDoctor("http://127.0.0.1:1", "code", "ko", fetch, 1_000)).kind).toBe("down");
  });
});

// ---- iamceo doctor ----

const BIN = resolve(import.meta.dir, "..", "bin", "iamceo.ts");

function cliEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const userHome = temp("iamceo-doctor-user-");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return {
    ...env, IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_TEST: "1", HOME: userHome,
    CLAUDE_CONFIG_DIR: join(userHome, ".claude"), CODEX_HOME: join(userHome, ".codex"),
    IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false", IAMCEO_CORE_BIN: "/usr/bin/false", ...extra,
  };
}

async function runCli(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, BIN, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

describe("iamceo doctor", () => {
  test("서버가 꺼져 있어도 돈다: server 는 fail, 종료 코드 1, --json 은 같은 모양", async () => {
    const home = temp("iamceo-doctor-cli-");
    updateConfigFile({ accessCode: "code" }, { IAMCEO_HOME: home });
    const result = await runCli(["doctor", "--json"], cliEnv(home));
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.checks.map(check => check.id)).toEqual([...DOCTOR_CHECK_IDS]);
    expect(report.serverVersion).toBe(VERSION);
    const checks = Object.fromEntries(report.checks.map(check => [check.id, check]));
    expect(checks.server!.state).toBe("fail");
    // 시험 환경이라 launchctl 을 부르지 않는다.
    expect(checks.service!.state).toBe("unknown");
    // 가짜 실행 엔진(/usr/bin/false)은 있지만 서버가 꺼져 있어 동작은 모른다.
    expect(checks.engine!.state).toBe("unknown");
  }, 30_000);

  test("사람용 출력은 언어를 따른다. 처음인 Mac 에는 데이터 폴더를 만들지 않는다", async () => {
    const home = join(temp("iamceo-doctor-fresh-"), "never-started");
    const ko = await runCli(["doctor"], cliEnv(home, { IAMCEO_LANG: "ko" }));
    expect(ko.code).toBe(1);
    expect(ko.stdout).toContain("✗ 서버 — 이 Mac에서 IAMCEO를 아직 시작한 적이 없습니다");
    expect(ko.stdout).toContain("고치는 법: ");
    expect(existsSync(home)).toBe(false);
    const en = await runCli(["doctor"], cliEnv(home, { IAMCEO_LANG: "en" }));
    expect(en.stdout).toContain("✗ Server — IAMCEO has not been started on this Mac yet");
    expect(en.stdout).toContain("Fix: ");
    expect(existsSync(home)).toBe(false);
    const help = await runCli(["help"], cliEnv(home, { IAMCEO_LANG: "ko" }));
    expect(help.stdout).toContain("doctor [--json]");
    expect(help.stdout).toContain("diagnose");
  }, 30_000);
});
