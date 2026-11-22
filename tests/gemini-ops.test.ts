// Gemini(Antigravity CLI) — HTTP 검증·런타임 정보·로그인 범위·진단·비밀 경로·명령줄·시험 격리 틀.
// 진짜 agy 는 띄우지 않는다. Antigravity CLI 자리는 늘 임시 폴더의 가짜(exit 97)이거나 없는 경로다. ~/.gemini 는 읽지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLI_PROVIDERS, DEFAULT_GEMINI_RANKS, type CliAccountsResponse, type CreateMemberReq, type CreateProjectReq, type Member, type PatchMemberReq, type RuntimeInfo, type SettingsPatch } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { CLI_LOGIN_CLIS, CliLoginError, CliLogins, isCliLoginCli } from "../server/cli-login.ts";
import { loadConfig, updateConfigFile, VERSION, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { createDiagnostics } from "../server/diagnose.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { geminiStatusFromPayload, geminiStatusPath } from "../server/runner/gemini-status.ts";
import { configuredSecretRoots, isSecretPath } from "../server/secret-paths.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { rejection } from "./fixtures/settle.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function temp(prefix: string): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }
/** 부르면 실패하는 가짜 실행 파일(부르지 않는지 보려고 인자를 적어 둔다). */
function fake(folder: string, name: string): { path: string; calls: () => string[] } {
  const path = join(folder, name), log = join(folder, `${name}.calls`);
  writeFileSync(path, `#!/bin/sh\necho "$@" >> '${log}'\nexit 97\n`, { mode: 0o755 });
  return { path, calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

/** agy: "fake" 면 이 시험 홈의 가짜 실행 파일, "missing" 이면 없는 경로(깔려 있지 않은 Mac). */
function freshConfig(agy: "fake" | "missing"): { config: Config; agy: ReturnType<typeof fake> | null } {
  const home = temp("iamceo-gemini-ops-");
  const bin = join(home, "bin");
  mkdirSync(bin);
  const fakeAgy = agy === "fake" ? fake(bin, "agy") : null;
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_CLAUDE_BIN: fake(bin, "claude").path, IAMCEO_CODEX_BIN: join(bin, "no-such-codex"),
    IAMCEO_CORE_BIN: join(bin, "no-such-core"), IAMCEO_CORE_SOCKET: join(home, "no-core.sock"), IAMCEO_GEMINI_BIN: fakeAgy?.path ?? join(bin, "no-such-agy") };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  return { config: loadConfig(env), agy: fakeAgy };
}

/** 임시 홈의 DB 와 저장소. 버스는 서버 문맥과 함께 쓴다. */
function openStore(config: Config): { store: Store; bus: Bus } {
  const bus = new Bus(), store = new Store(openDb(config.dbPath), bus);
  cleanups.push(() => store.db.close());
  return { store, bus };
}
function folderText(dir: string): string {
  let out = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    out += entry.isDirectory() ? folderText(path) : `\n--- ${entry.name}\n${readFileSync(path, "utf8")}`;
  }
  return out;
}

async function serve(config: Config, opened: { store: Store; bus: Bus }, orch: OrchestratorApi, extra: Record<string, unknown> = {}) {
  const context = { config, store: opened.store, bus: opened.bus, orch, detectHosts: () => [], ...extra };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  cleanups.push(() => server.stop());
  const request = (path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, {
    method, headers: { Authorization: "Bearer code", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { server, request };
}

describe("HTTP: 총괄·팀장의 CLI 로 gemini 를 받는다", () => {
  /** 지휘는 받은 요청을 적어 두기만 한다(이 시험은 HTTP 의 검증만 본다). */
  async function boot() {
    const { config } = freshConfig("missing");
    const opened = openStore(config), store = opened.store;
    const project = store.createProject({ name: "자료 조사", cwd: config.home });
    const member = store.createMember({ projectId: project.id, handle: "gm", name: "시장 조사", kind: "worker" });
    const calls: unknown[][] = [];
    const orch = {
      createProject: async (req: CreateProjectReq) => { calls.push(["createProject", req]); return project; },
      createMember: async (projectId: string, req: CreateMemberReq) => { calls.push(["createMember", projectId, req]); return member; },
      patchMemberConfig: async (memberId: string, patch: PatchMemberReq): Promise<Member> => { calls.push(["patchMemberConfig", memberId, patch]); return store.requireMember(memberId); },
      updateSettings: async (patch: SettingsPatch) => { calls.push(["updateSettings", patch]); return store.getSettings(); },
    } as unknown as OrchestratorApi;
    return { ...await serve(config, opened, orch), config, store, project, member, calls };
  }

  test("프로젝트의 chiefCli, 팀장 만들기·고치기의 cli: claude·codex·gemini 만 받고 그 밖은 400 이다", async () => {
    const t = await boot();
    for (const cli of CLI_PROVIDERS) {
      expect([cli, (await t.request("/api/projects", "POST", { name: "새 프로젝트", cwd: t.config.home, chiefCli: cli })).status]).toEqual([cli, 200]);
      expect(t.calls.at(-1)).toEqual(["createProject", { name: "새 프로젝트", cwd: t.config.home, chiefCli: cli }]);
      expect([cli, (await t.request(`/api/projects/${t.project.id}/members`, "POST", { name: "새 팀장", cli })).status]).toEqual([cli, 200]);
      expect(t.calls.at(-1)).toEqual(["createMember", t.project.id, { name: "새 팀장", cli }]);
      expect([cli, (await t.request(`/api/members/${t.member.id}`, "PATCH", { cli })).status]).toEqual([cli, 200]);
      expect(t.calls.at(-1)).toEqual(["patchMemberConfig", t.member.id, { cli }]);
    }
    // 실행 파일 이름(agy)·제품 이름·옛 Gemini CLI 를 cli 값으로 받지 않는다.
    const before = t.calls.length;
    for (const cli of ["agy", "antigravity", "Gemini", "gemini-cli", "", null, 3]) {
      expect([cli, (await t.request("/api/projects", "POST", { name: "새 프로젝트", cwd: t.config.home, chiefCli: cli })).status]).toEqual([cli, 400]);
      expect([cli, (await t.request(`/api/projects/${t.project.id}/members`, "POST", { name: "새 팀장", cli })).status]).toEqual([cli, 400]);
      expect([cli, (await t.request(`/api/members/${t.member.id}`, "PATCH", { cli })).status]).toEqual([cli, 400]);
    }
    expect(t.calls.length).toBe(before);
  });

  test("설정: geminiRanks 를 받는다(고친 칸만 보내도 된다). 모르는 칸·모르는 직급은 400 이고, 다른 직급표는 그대로 받는다", async () => {
    const t = await boot();
    const cleared = { geminiRanks: { lead: { model: null, effort: null } } };
    expect((await t.request("/api/settings", "PUT", cleared)).status).toBe(200);
    expect(t.calls.at(-1)).toEqual(["updateSettings", cleared]);
    expect((await t.request("/api/settings", "PUT", { geminiRanks: { manager: { model: null } } })).status).toBe(200);
    expect(t.calls.at(-1)).toEqual(["updateSettings", { geminiRanks: { manager: { model: null } } }]);
    expect((await t.request("/api/settings", "PUT", { geminiRanks: {} })).status).toBe(200);
    const before = t.calls.length;
    for (const bad of [{ geminiRanks: { lead: { model: null, extra: 1 } } }, { geminiRanks: { boss: { model: null } } }, { geminiRanks: { lead: { model: 3 } } }, { geminiRanks: "x" }, { agyRanks: {} }]) {
      expect([JSON.stringify(bad), (await t.request("/api/settings", "PUT", bad)).status]).toEqual([JSON.stringify(bad), 400]);
    }
    expect(t.calls.length).toBe(before);
    // Claude·Codex 직급표는 예전처럼 받는다.
    expect((await t.request("/api/settings", "PUT", { ranks: { lead: { model: null } }, codexRanks: { lead: { effort: null } } })).status).toBe(200);
    expect(t.calls.at(-1)).toEqual(["updateSettings", { ranks: { lead: { model: null } }, codexRanks: { lead: { effort: null } } }]);
    expect(DEFAULT_GEMINI_RANKS.lead).toEqual({ model: null, effort: null });
  });
});

describe("HTTP: Antigravity CLI 가 없으면 로그인·계정은 예전처럼 Claude·Codex 만 보인다", () => {
  test("계정 목록에 gemini 줄·새 칸이 없고, gemini 로그인 요청은 409(띄우지 않는다)다. 모르는 CLI 는 400 이고 타입 밖에서 불러도 다른 CLI 로그인을 띄우지 않는다", async () => {
    const dir = temp("iamceo-gemini-login-");
    const claude = fake(dir, "claude"), codex = fake(dir, "codex");
    const read: string[] = [];
    const logins = new CliLogins({ claudeBin: claude.path, codexBin: codex.path, runDir: join(dir, "run"), env: { PATH: "/usr/bin:/bin", HOME: dir }, log: () => undefined,
      readAccount: async cli => { read.push(cli); return { account: { cli, installed: true, loggedIn: false, email: null, organization: null, plan: null, method: null, checkedAt: "2026-11-21T00:00:00.000Z" }, identity: null }; } });
    cleanups.push(() => logins.close());
    expect([...CLI_LOGIN_CLIS]).toEqual(["claude", "codex", "gemini"]);
    expect(["claude", "codex", "gemini", "agy", undefined].map(isCliLoginCli)).toEqual([true, true, true, false, false]);

    const { config } = freshConfig("fake");
    const t = await serve(config, openStore(config), {} as OrchestratorApi, { cliLogins: logins });
    const accounts = await (await t.request("/api/cli-accounts?refresh=1")).json() as CliAccountsResponse;
    // 이 서비스에는 Antigravity CLI 가 없다: 응답이 예전 그대로다(출시 앱은 모르는 CLI 의 줄을 Claude Code 로 그린다).
    expect(Object.keys(accounts).sort()).toEqual(["accounts", "logins"]);
    expect(accounts.accounts.map(account => account.cli)).toEqual(["claude", "codex"]);
    expect(read.sort()).toEqual(["claude", "codex"]);
    const gemini = await t.request("/api/cli-login", "POST", { cli: "gemini" });
    expect([gemini.status, ((await gemini.json()) as { code?: string }).code]).toEqual([409, "cli_login_cli_missing"]);
    for (const cli of ["agy", "antigravity"]) {
      const response = await t.request("/api/cli-login", "POST", { cli });
      expect([cli, response.status]).toEqual([cli, 400]);
    }
    // 타입을 거치지 않고 불렸을 때: 다른 CLI 의 길(codex login --device-auth 등)로 흘려보내지 않고 거절한다.
    const error = await rejection(logins.start("agy" as never));
    expect(error).toBeInstanceOf(CliLoginError);
    expect((error as CliLoginError).status).toBe(400);
    expect(logins.list()).toEqual([]);
    expect([claude.calls(), codex.calls()]).toEqual([[], []]);
  });
});

describe("런타임 정보: gemini 는 Antigravity CLI 가 깔려 있을 때만 싣는다", () => {
  async function runtimeOf(config: Config): Promise<RuntimeInfo> {
    const opened = openStore(config);
    const orch = new Orchestrator({ config, store: opened.store, runners: new Map(), notifier: () => {} });
    cleanups.push(() => orch.shutdown());
    const t = await serve(config, opened, orch);
    return await (await t.request("/api/runtime")).json() as RuntimeInfo;
  }

  test("깔려 있지 않으면 응답이 예전 그대로다(claude·codex 두 칸)", async () => {
    const runtime = await runtimeOf(freshConfig("missing").config);
    expect(runtime.providers).toEqual({ claude: { installed: true }, codex: { installed: false } });
  });

  test("깔려 있으면 gemini 칸이 더해진다. 있는지만 보고 실행하지 않는다", async () => {
    const { config, agy } = freshConfig("fake");
    const runtime = await runtimeOf(config);
    expect(runtime.providers).toEqual({ claude: { installed: true }, codex: { installed: false }, gemini: { installed: true } });
    expect(agy!.calls()).toEqual([]);
  });

  test("설정에 실행 파일이 없으면(손으로 만든 설정) 이 Mac 에서 agy 를 찾아보지 않는다", async () => {
    const { config } = freshConfig("fake");
    const runtime = await runtimeOf({ ...config, geminiBin: undefined });
    expect(Object.keys(runtime.providers).sort()).toEqual(["claude", "codex"]);
  });
});

describe("진단 파일", () => {
  test("gemini 실행 파일·자료 폴더의 경로와 직급 설정만 싣는다. 상태줄 기록·~/.gemini 의 내용은 넣지 않는다", async () => {
    const { config } = freshConfig("fake");
    const geminiHome = join(config.home, "gemini-data");
    mkdirSync(geminiHome);
    writeFileSync(join(geminiHome, "oauth_creds.json"), JSON.stringify({ access_token: "GEMINI-OAUTH-CANARY" }));
    const { store } = openStore(config);
    const project = store.createProject({ name: "자료 조사", cwd: config.home });
    const member = store.createMember({ projectId: project.id, handle: "gm", name: "시장 조사", kind: "worker", cli: "gemini" });
    store.db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('geminiRanks', ?)").run(JSON.stringify({ ...DEFAULT_GEMINI_RANKS, lead: { model: "gemini-4-neon", effort: "high" } }));
    // 팀장의 상태줄 기록(대화 id·기록 경로가 들어 있다).
    const status = geminiStatusPath(config.home, member.id);
    mkdirSync(dirname(status), { recursive: true });
    writeFileSync(status, JSON.stringify(geminiStatusFromPayload(member.id, { conversation_id: "GEMINI-CONVERSATION-CANARY", transcript_path: "/Users/tester/.gemini/antigravity-cli/brain/x/transcript.jsonl", email: "owner@example.com" }, new Date())));
    const result = await createDiagnostics({ home: config.home, dbPath: config.dbPath, config: { ...config, geminiHome }, db: store.db, source: "cli",
      versions: { server: VERSION }, doctor: null, service: async () => null, crashReportsDir: null });
    const dir = result.path.slice(0, -4);
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as { config: Record<string, unknown> };
    expect(summary.config.geminiBin).toBe(config.geminiBin);
    expect(summary.config.geminiHome).toBe(geminiHome);
    expect(summary.config.codexBin).toBe(config.codexBin);
    const database = JSON.parse(readFileSync(join(dir, "database.json"), "utf8")) as { settings: Record<string, unknown>; members: { cli: string }[] };
    expect(database.settings.geminiRanks).toEqual({ ...DEFAULT_GEMINI_RANKS, lead: { model: "gemini-4-neon", effort: "high" } });
    expect(database.members.map(row => row.cli)).toEqual(["gemini"]);
    const text = folderText(dir);
    for (const secret of ["GEMINI-OAUTH-CANARY", "GEMINI-CONVERSATION-CANARY", "owner@example.com", "transcript.jsonl"]) expect(text).not.toContain(secret);
    // 설정에 적지 않은 자료 폴더는 null 이다(기본 자리를 짐작해 적지 않는다).
    const plain = await createDiagnostics({ home: config.home, dbPath: config.dbPath, config, db: null, source: "cli",
      versions: { server: VERSION }, doctor: null, service: async () => null, crashReportsDir: null, now: new Date(Date.now() + 5_000) });
    expect((JSON.parse(readFileSync(join(plain.path.slice(0, -4), "summary.json"), "utf8")) as { config: Record<string, unknown> }).config.geminiHome).toBeNull();
  });
});

describe("비밀 경로", () => {
  test("~/.gemini 는 기본으로 막혀 있고, 설정·환경 변수로 옮긴 Antigravity CLI 자료 폴더도 막는다", () => {
    const userHome = temp("iamceo-gemini-secret-");
    const moved = join(userHome, "elsewhere", "agy-data"), byEnv = join(userHome, "env-agy-data");
    expect(configuredSecretRoots({}, {}, userHome)).toContain(join(userHome, ".gemini"));
    expect(configuredSecretRoots({}, {}, userHome)).not.toContain(moved);
    const roots = configuredSecretRoots({ geminiHome: moved }, { IAMCEO_GEMINI_HOME: byEnv }, userHome);
    expect(roots).toContain(moved);
    expect(roots).toContain(byEnv);
    for (const path of [join(userHome, ".gemini", "oauth_creds.json"), join(userHome, ".gemini", "google_accounts.json"),
      join(userHome, ".gemini", "antigravity-cli", "conversations", "x.db"), join(moved, "conversations", "x.db"), join(byEnv, "brain", "x", "transcript.jsonl")]) {
      expect([path, isSecretPath(path, userHome, roots)]).toEqual([path, true]);
    }
    // 프로젝트 안의 같은 이름 폴더는 막지 않는다(홈의 자리만 막는다).
    expect(isSecretPath(join(userHome, "work", "app", ".gemini", "notes.md"), userHome, roots)).toBe(false);
    // Claude·Codex 의 자리는 그대로 막힌다.
    const others = configuredSecretRoots({ claudeHome: join(userHome, "c"), codexHome: join(userHome, "x") }, {}, userHome);
    expect(others).toContain(join(userHome, "c"));
    expect(others).toContain(join(userHome, "x"));
  });
});

describe("명령줄: 서비스 등록", () => {
  const BIN = resolve(import.meta.dir, "..", "bin", "iamceo.ts");
  async function dryRun(extra: Record<string, string>) {
    const home = temp("iamceo-gemini-service-");
    const env = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", IAMCEO_LANG: "ko", HOME: join(home, "user"), IAMCEO_HOME: join(home, "data"), IAMCEO_PORT: "0", IAMCEO_TEST: "1",
      IAMCEO_CORE_SOCKET: join(home, "no-core.sock"), IAMCEO_CORE_BIN: "/usr/bin/false", IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false", ...extra };
    const child = Bun.spawn([process.execPath, BIN, "service", "install", "--dry-run"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }

  test("찾은 Antigravity CLI 의 위치와 자료 폴더 설정을 서비스 환경에 적는다. 실행하지 않는다", async () => {
    const bin = temp("iamceo-gemini-service-bin-");
    const agy = fake(bin, "agy");
    const result = await dryRun({ IAMCEO_GEMINI_BIN: agy.path, IAMCEO_GEMINI_HOME: join(bin, "agy-data") });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`<key>IAMCEO_GEMINI_BIN</key>\\s*<string>${agy.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
    expect(result.stdout).toMatch(/<key>IAMCEO_GEMINI_HOME<\/key>\s*<string>[^<]*agy-data<\/string>/);
    // 그 폴더는 서비스 PATH 에 넣지 않는다: agy 는 절대 경로로 띄우고, PATH 는 agy 가 없는 Mac 과 같아야 한다(Claude·Codex 팀장이 부르는 도구의 순서).
    const pathOf = (stdout: string) => /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(stdout)?.[1];
    expect(pathOf(result.stdout)?.split(":")).not.toContain(bin);
    // Claude·Codex 줄은 그대로다.
    expect(result.stdout).toMatch(/<key>IAMCEO_CLAUDE_BIN<\/key>\s*<string>\/usr\/bin\/false<\/string>/);
    expect(result.stdout).toMatch(/<key>IAMCEO_CODEX_BIN<\/key>\s*<string>\/usr\/bin\/false<\/string>/);
    expect(agy.calls()).toEqual([]);
    // 선택 사항이라, 그 자리에 실행 파일이 없어도 찾지 못했다고 알리지 않는다.
    const missing = await dryRun({ IAMCEO_GEMINI_BIN: join(bin, "no-such-agy") });
    expect(missing.code).toBe(0);
    expect(missing.stdout + missing.stderr).not.toContain("찾지 못했습니다");
    // 없는 자리는 서비스에 적지 않는다(적어 두면 다른 자리에 다시 깐 agy 를 서버가 찾지 못한다). PATH 는 agy 가 있을 때와 같다.
    expect(missing.stdout).not.toContain("IAMCEO_GEMINI_BIN");
    const sameHome = (path: string | undefined) => path?.replace(/iamceo-gemini-service-[A-Za-z0-9]+/g, "home");
    expect(sameHome(pathOf(missing.stdout))).toBe(sameHome(pathOf(result.stdout)));
  }, 30_000);
});

describe("시험 격리 틀", () => {
  test("Antigravity CLI 자리는 부르면 실패하는 가짜이고, 자식 환경은 그 가짜와 임시 자료 폴더로 고정된다", async () => {
    const f = createIsolatedRuntime();
    cleanups.push(() => f.stop());
    expect(f.bins.geminiBin).toBe(join(f.paths.bin, "agy"));
    expect(f.providerHomes.geminiHome).toBe(f.paths.geminiHome);
    expect(f.paths.geminiHome.startsWith(f.dir)).toBe(true);
    const env = f.childEnv();
    expect([env.IAMCEO_GEMINI_BIN, env.IAMCEO_GEMINI_HOME]).toEqual([f.bins.geminiBin, f.paths.geminiHome]);
    for (const key of ["IAMCEO_GEMINI_BIN", "IAMCEO_GEMINI_HOME"]) expect(() => f.childEnv({ [key]: "/opt/homebrew/bin/agy" })).toThrow("Cannot override");
    const child = f.spawnFake([f.bins.geminiBin, "--version"], { cwd: f.paths.work });
    child.stdin.end();
    expect(await child.exited).toBe(97);
    // 실행기 옵션에도 같은 자리가 들어간다. 틀 밖의 gemini 홈은 받지 않는다.
    expect(f.runnerOptions(f.providerHomes)).toMatchObject({ geminiBin: f.bins.geminiBin, geminiHome: f.paths.geminiHome, claudeBin: f.bins.claudeBin, codexBin: f.bins.codexBin });
    expect(() => f.runnerOptions({ ...f.providerHomes, geminiHome: "/outside-fixture" })).toThrow("outside");
    // 손으로 만든 묶음은 gemini 홈을 빼도 된다(예전 시험이 그대로 돈다).
    const { geminiHome: _omitted, ...legacy } = f.providerHomes;
    expect(f.runnerOptions(legacy)).toMatchObject({ claudeHome: f.paths.claudeHome, codexHome: f.paths.codexHome });
    // 이 틀의 환경으로 읽은 설정은 가짜 agy 를 가리킨다(이 Mac 의 진짜 agy 가 아니다).
    const config = loadConfig(env);
    expect([config.geminiBin, config.geminiHome]).toEqual([f.bins.geminiBin, f.paths.geminiHome]);
  });
});
