// 2차 E 묶음(B1): 명령줄 문구의 언어(say), 보고 언어 설정(reportLanguage), 영어일 때 역할 지침 끝에 붙는 줄.
// 임시 홈·가짜 실행기만 쓰고 launchctl·claude·codex 는 부르지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Bus } from "../server/bus.ts";
import { cliLang, say } from "../server/cli-text.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { ENGLISH_REPORT_RULE, renderRole } from "../server/roles.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import type { Bootstrap, MemberKind, Settings } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const CLI = resolve(import.meta.dir, "..", "bin", "iamceo.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("명령줄 문구 언어", () => {
  test("IAMCEO_LANG 이 먼저, 없으면 LC_ALL, 그다음 LANG. ko 로 시작할 때만 한국어", () => {
    expect(cliLang({})).toBe("en");
    expect(cliLang({ LANG: "ko_KR.UTF-8" })).toBe("ko");
    expect(cliLang({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(cliLang({ LANG: "C" })).toBe("en");
    expect(cliLang({ LC_ALL: "en_US.UTF-8", LANG: "ko_KR.UTF-8" })).toBe("en");
    expect(cliLang({ LC_ALL: "ko_KR.UTF-8", LANG: "en_US.UTF-8" })).toBe("ko");
    expect(cliLang({ IAMCEO_LANG: "en", LC_ALL: "ko_KR.UTF-8", LANG: "ko_KR.UTF-8" })).toBe("en");
    expect(cliLang({ IAMCEO_LANG: "ko", LANG: "en_US.UTF-8" })).toBe("ko");
    expect(cliLang({ IAMCEO_LANG: "KO" })).toBe("ko");
    // 빈 값은 없는 것으로 친다.
    expect(cliLang({ IAMCEO_LANG: "", LC_ALL: " ", LANG: "ko_KR.UTF-8" })).toBe("ko");
  });

  test("say 는 부를 때마다 환경을 다시 읽는다", () => {
    const before = process.env.IAMCEO_LANG;
    try {
      process.env.IAMCEO_LANG = "ko";
      expect(say("안녕", "hello")).toBe("안녕");
      process.env.IAMCEO_LANG = "en";
      expect(say("안녕", "hello")).toBe("hello");
    } finally {
      if (before === undefined) delete process.env.IAMCEO_LANG; else process.env.IAMCEO_LANG = before;
    }
  });
});

function cliEnv(home: string, lang: string): Record<string, string> {
  for (const dir of ["claude", "codex"]) mkdirSync(join(home, dir), { recursive: true, mode: 0o700 });
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "ko_KR.UTF-8", IAMCEO_LANG: lang,
    IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_HERDR_SOCKET: join(home, "no-herdr.sock"),
    IAMCEO_CORE_SOCKET: join(home, "no-core.sock"), IAMCEO_CORE_BIN: "/usr/bin/false",
    IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false",
    CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), IAMCEO_TEST: "1" };
}

async function cli(args: string[], lang: string) {
  const home = mkdtempSync(join(tmpdir(), "iamceo-w2e-"));
  const p = Bun.spawn([process.execPath, CLI, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: cliEnv(home, lang) });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}

/** 도움말의 명령 줄에서 명령 이름(두 칸 들여 쓴 첫 낱말들)만 뽑는다. */
function commands(help: string): string[] {
  return help.split("\n").filter(line => /^ {2}[a-z]/.test(line)).map(line => line.trim().split(/\s{2,}/)[0]!.split(/ [<[]/)[0]!.trim());
}

describe("명령줄 도움말과 오류", () => {
  test("영어 도움말은 한국어 도움말과 같은 명령을 모두 싣는다", async () => {
    const [ko, en] = await Promise.all([cli(["help"], "ko"), cli(["help"], "en")]);
    expect(ko.stdout).toContain("쓰는 법: iamceo <명령>");
    expect(en.stdout).toContain("Usage: iamceo <command>");
    expect(en.stdout).not.toMatch(/[가-힣]/);
    expect(en.stdout).toContain("IAMCEO_LANG");
    // 새 명령을 USAGE 에만 더하고 USAGE_EN 에 빠뜨리면 여기서 걸린다.
    expect(commands(en.stdout)).toEqual(commands(ko.stdout));
    expect(commands(en.stdout).length).toBeGreaterThan(10);
  });

  test("모르는 명령·잘못 쓴 명령은 고른 언어로 알리고 1로 끝난다", async () => {
    const unknown = await cli(["nope"], "en");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown command: nope");
    expect(unknown.stderr).toContain("Usage: iamceo <command>");
    const attach = await cli(["attach"], "en");
    expect(attach.code).toBe(1);
    expect(attach.stderr.trim()).toBe("Usage: iamceo attach <staffID>");
    const auth = await cli(["auth"], "ko");
    expect(auth.stderr.trim()).toBe("쓰는 법: iamceo auth rotate");
    const service = await cli(["service", "install"], "en");
    expect(service.code).toBe(1);
    expect(service.stderr).toContain("With IAMCEO_TEST=1 nothing is registered with launchd");
  });

  test("서버가 꺼져 있을 때의 안내도 고른 언어로", async () => {
    const down = await cli(["status"], "en");
    expect(down.code).toBe(1);
    expect(down.stderr).toContain("The server is not running");
    expect(down.stderr).not.toMatch(/[가-힣]/);
  });
});

describe("보고 언어 설정", () => {
  test("기본은 ko 이고 늘 내려가며, en 으로 바꾸면 다시 열어도 남는다", () => {
    const home = mkdtempSync(join(tmpdir(), "iamceo-w2e-store-"));
    const path = join(home, "iamceo.db");
    let db = openDb(path);
    let store = new Store(db, new Bus());
    expect(store.getSettings().reportLanguage).toBe("ko");
    expect(store.patchSettings({ reportLanguage: "en" }).reportLanguage).toBe("en");
    db.close();
    db = openDb(path);
    store = new Store(db, new Bus());
    expect(store.getSettings().reportLanguage).toBe("en");
    // 옛 판으로 되돌려도 열리게 settings 표의 키 하나로만 남는다.
    expect(db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'reportLanguage'").get()?.value).toBe("\"en\"");
    db.close();
  });
});

class QuietRunner implements Runner {
  readonly kind = "core" as const;
  started: StartOpts[] = [];
  async available() { return { ok: true }; }
  async start(member: RunnerMember, opts: StartOpts) { this.started.push(opts); return { sessionId: member.sessionId ?? `native-${member.id}`, paneId: `pane-${member.id}` }; }
  async send(): Promise<SendResult> { return { ok: true, started: true, turn: 0 }; }
  isBusy() { return false; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async stop() {}
  async interrupt() {}
  async screen() { return ""; }
  async shutdown() {}
  on(_callback: (event: RunnerEvent) => void) {}
}

async function server() {
  const isolated = createIsolatedRuntime();
  cleanups.push(() => isolated.stop());
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath), bus = new Bus(), store = new Store(db, bus), runner = new QuietRunner();
  store.patchSettings({ boardTidyHours: 0 });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000 } });
  let running = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery, folderHome: isolated.paths.home, detectHosts: () => [] });
  while (running.port === 7878) { await running.stop(); running = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery, folderHome: isolated.paths.home, detectHosts: () => [] }); }
  cleanups.push(async () => { await running.stop(); await orch.shutdown(); db.close(); });
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${running.port}${path}`, {
    method, headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { store, orch, runner, isolated, request };
}

describe("보고 언어 설정 쓰기 경로", () => {
  test("v1·v2 설정 쓰기가 reportLanguage 를 받고, 모르는 값은 400 으로 거절한다", async () => {
    const f = await server();
    const boot = await (await f.request("/api/bootstrap")).json() as Bootstrap;
    expect(boot.settings.reportLanguage).toBe("ko");
    const v1 = await f.request("/api/settings", "PUT", { reportLanguage: "en" });
    expect(v1.status).toBe(200);
    expect(((await v1.json()) as Settings).reportLanguage).toBe("en");
    expect(((await (await f.request("/api/bootstrap")).json()) as Bootstrap).settings.reportLanguage).toBe("en");
    const v2 = await f.request("/api/settings", "PUT", { reportLanguage: "ko" }, { "X-IAMCEO-Contract": "2", "If-Match": `"${f.store.settingsRevision()}"` });
    expect(v2.status).toBe(200);
    expect(((await v2.json()) as { settings: Settings }).settings.reportLanguage).toBe("ko");
    for (const bad of ["fr", "EN", "", null, 1]) {
      expect((await f.request("/api/settings", "PUT", { reportLanguage: bad })).status).toBe(400);
    }
    expect(f.store.getSettings().reportLanguage).toBe("ko");
  });
});

describe("역할 지침의 보고 언어 줄", () => {
  const vars = { PROJECT: "결제", NAME: "결제 연동", ROLE: "결제 연동", CONDUCTOR: "총괄" };
  const kinds: MemberKind[] = ["conductor", "worker", "root"];

  test("en 이면 세 역할 모두 끝에 한 번 붙고, ko·없음이면 붙지 않는다", () => {
    for (const kind of kinds) {
      const english = renderRole(kind, { ...vars, REPORT_LANGUAGE: "en" });
      expect(english.trimEnd().endsWith(ENGLISH_REPORT_RULE)).toBe(true);
      expect(english.split("## Report language").length).toBe(2);
      // 서버 머리말은 바꾸지 않고 뜻만 설명한다.
      expect(english).toContain("`[대표]` the owner");
      expect(english).toContain("`[시스템]` the server");
      expect(renderRole(kind, { ...vars, REPORT_LANGUAGE: "ko" })).toBe(renderRole(kind, vars));
      expect(renderRole(kind, vars)).not.toContain("## Report language");
    }
  });

  test("고쳐 쓴 템플릿에도 붙고, 값 안의 자리표시는 다시 치환하지 않는다", () => {
    const rolesDir = mkdtempSync(join(tmpdir(), "iamceo-w2e-roles-"));
    writeFileSync(join(rolesDir, "worker.md"), "승인 없이 커밋하지 않는다. {{NAME}}\n");
    const out = renderRole("worker", { ...vars, NAME: "{{PROJECT}}", REPORT_LANGUAGE: "en" }, rolesDir);
    expect(out).toBe(`승인 없이 커밋하지 않는다. {{PROJECT}}\n\n${ENGLISH_REPORT_RULE}\n`);
  });

  test("영어 줄은 한 줄짜리 규칙 두 개다(지침 길이를 크게 늘리지 않는다)", () => {
    const lines = ENGLISH_REPORT_RULE.split("\n");
    expect(lines[0]).toBe("## Report language");
    expect(lines.slice(1).every(line => line.startsWith("- "))).toBe(true);
    expect(lines.length).toBe(3);
    expect(ENGLISH_REPORT_RULE.length).toBeLessThan(1400);
  });

  // server/orchestrator.ts 의 rulesFor 가 REPORT_LANGUAGE: this.store.getSettings().reportLanguage 를 넘긴다(합치기 단계에서 연결).
  test("서버가 띄우는 세션의 규칙 파일에도 영어 줄이 들어간다", async () => {
    const f = await server();
    const project = f.store.createProject({ name: "언어", cwd: f.isolated.paths.work });
    f.store.patchSettings({ reportLanguage: "en" });
    await f.orch.addMember(project.id, { name: "결제 연동", handle: "pay", role: "개발" });
    expect(readFileSync(f.runner.started.at(-1)!.systemPromptFile, "utf8")).toContain(ENGLISH_REPORT_RULE);
    f.store.patchSettings({ reportLanguage: "ko" });
    await f.orch.addMember(project.id, { name: "화면 문구", handle: "copy", role: "개발" });
    expect(readFileSync(f.runner.started.at(-1)!.systemPromptFile, "utf8")).not.toContain("## Report language");
  });

  test("이미 있는 팀장을 잠재웠다 다시 띄우면 그때의 보고 언어로 규칙 파일을 다시 쓴다", async () => {
    const f = await server();
    const project = f.store.createProject({ name: "언어 재시작", cwd: f.isolated.paths.work });
    const { member } = await f.orch.addMember(project.id, { name: "결제 연동", handle: "pay", role: "개발" });
    const first = f.runner.started.at(-1)!.systemPromptFile;
    expect(readFileSync(first, "utf8")).not.toContain("## Report language");
    // 영어로 바꾼 뒤 다시 띄우면 같은 규칙 파일에 영어 줄이 들어간다.
    f.store.patchSettings({ reportLanguage: "en" });
    await f.orch.sleepMember(member.id, { force: true });
    const before = f.runner.started.length;
    await f.orch.resumeMember(member.id);
    expect(f.runner.started.length).toBe(before + 1);
    const reopened = f.runner.started.at(-1)!;
    expect(reopened.systemPromptFile).toBe(first);
    const english = readFileSync(reopened.systemPromptFile, "utf8");
    expect(english).toContain(ENGLISH_REPORT_RULE);
    expect(english.split("## Report language").length).toBe(2);
    // 다시 한국어로 돌리면 다음 띄우기에서 영어 줄이 빠진다.
    f.store.patchSettings({ reportLanguage: "ko" });
    await f.orch.sleepMember(member.id, { force: true });
    await f.orch.resumeMember(member.id);
    expect(readFileSync(f.runner.started.at(-1)!.systemPromptFile, "utf8")).not.toContain("## Report language");
  });
});
