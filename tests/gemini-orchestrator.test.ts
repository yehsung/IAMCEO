// Gemini(Antigravity CLI) 지원의 지휘·저장·설정 쪽: 총괄 CLI 저장, 직급표, 실행 파일, 계정 세대, 팀장 띄우기(도구), 설정 변경·CLI 전환,
// 대화 id 를 모르는 동안의 동작(설정 보류·재우기·보관), 이어 연 대화가 새 대화가 된 것, 첫 설정 막힘, 압축 거절, 한도 카드 이름, 모델 목록 갱신 조건.
// 실제 CLI 는 띄우지 않는다. 대부분의 시험은 가짜 실행기(받은 것만 적고, Gemini 는 실제처럼 대화 id 없이 뜬다)로 돌고,
// 파일 끝의 묶음만 가짜 core 소켓 + 실제 CoreRunner 로 돈다(tests/fixtures/core-harness.ts). CLI 자리에는 실행하면 실패하는 가짜 파일만 둔다.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentTool, listAgentTools } from "../server/agent-tools.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { removeDeletedProjectFiles } from "../server/lifecycle/project-data.ts";
import { rehearsalEnvironment } from "../server/lifecycle/rehearse.ts";
import { GeminiModelsRefresher, geminiModelsCachePath, writeGeminiModelsCache, type ModelOption } from "../server/models.ts";
import { createOrchestrator, geminiModelsRefresherOptions, geminiRunDir, Orchestrator, type AgentToolsImpl, type OrchestratorDeps, type OrchestratorTimings, type PostInput } from "../server/orchestrator.ts";
import { GeminiQuotaReader } from "../server/gemini-quota.ts";
import { GEMINI_PROBE_URL } from "../server/gemini-errors.ts";
import { geminiStatusFromPayload, geminiStatusPath } from "../server/runner/gemini-status.ts";
import { RESTART_RESUME_TEXT } from "../server/restart-wake.ts";
import { CoreError } from "../server/runner/core-client.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { ApiError, Store, type AppliedConfig } from "../server/store.ts";
import { DEFAULT_GEMINI_RANKS, DEFAULT_RANKS, ranksFor, staffConfig, type Backend, type Member } from "../shared/types.ts";
import { ERROR_CODES } from "../shared/error-codes.ts";
import { coreSetup, rejection, startFakeCore, type CoreSetupOptions } from "./fixtures/core-harness.ts";

/**
 * 세션을 띄우지 않고 받은 것만 적는다. 실행기 종류는 운영과 같은 core 다(CoreRunner 는 아니다).
 * Gemini 는 실제 실행기(CoreRunner)처럼 군다: 새 세션은 대화 id 없이 뜨고(sessionId null), id 는 나중에 session 사건으로 온다
 * (시험이 learn 으로 넣는다). 이어 열기는 넘긴 id 를 그대로 돌려주고, id 를 모르는 이어 열기는 session_unknown 으로 거절한다.
 */
class FakeRunner implements Runner {
  readonly kind: Backend = "core";
  readonly interjects = false;
  starts: { member: RunnerMember; opts: StartOpts }[] = [];
  stops: string[] = [];
  sent: { memberId: string; text: string }[] = [];
  compacts: string[] = [];
  busy = new Set<string>();
  /** 끝내기를 거절할 팀장(입력칸에 쓰던 글이 있는 터미널). */
  refuseStop = new Set<string>();
  /** 이어 띄운 결과에 이 대화 id 를 싣는다: 실행기가 붙는 사이에 agy 가 연 새 대화를 이미 알아낸 경우(팀장 id → 새 id). */
  replacedAtLaunch = new Map<string, string>();
  private terminals = 0;
  private cb: (e: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember, o: StartOpts) {
    this.starts.push({ member: { ...m }, opts: { ...o } });
    const paneId = `t${++this.terminals}`;
    if (m.cli !== "gemini") return { sessionId: m.sessionId ?? crypto.randomUUID(), paneId };
    if (o.resume && !m.sessionId) throw new CoreError("session_unknown", "Antigravity conversation id is unknown; reattach the existing core terminal or explicitly start a fresh session");
    return { sessionId: o.resume ? this.replacedAtLaunch.get(m.id) ?? m.sessionId : null, paneId };
  }
  async send(m: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ memberId: m.id, text });
    this.busy.add(m.id);
    return { ok: true };
  }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(m: RunnerMember): Promise<SendResult> { this.compacts.push(m.id); return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  /** 있어야 '설정이 달라 다시 열어야 하는 세션'을 따진다(운영의 CoreRunner 에도 있다). */
  async applyConfig(): Promise<SendResult> { return { ok: true }; }
  /** 한도 메뉴는 없다(Claude 화면의 메뉴만 읽는다). 한도로 멈춘 팀장의 설정 변경이 화면을 먼저 본다. */
  async usageLimitSnapshot() { return { menu: null, state: "idle" }; }
  async interrupt() {}
  async stop(m: RunnerMember) {
    if (this.refuseStop.has(m.id)) throw new CoreError("input_busy", "composer has a draft");
    this.stops.push(m.id); this.busy.delete(m.id);
  }
  async screen() { return ""; }
  on(cb: (e: RunnerEvent) => void) { this.cb = cb; }
  async shutdown() {}
  startsOf(id: string) { return this.starts.filter(s => s.member.id === id); }
  /** 실행기가 알리는 사건을 그대로 넣는다. */
  emit(e: RunnerEvent) { this.cb(e); }
  /** 그 팀장의 대화 id 를 알아냈다(실제 실행기는 첫 턴 뒤 상태줄 기록에서 읽어 session 사건을 낸다). 넣은 id 를 돌려준다. */
  learn(memberId: string, sessionId = `conv-${crypto.randomUUID()}`): string { this.cb({ type: "session", memberId, sessionId }); return sessionId; }
  /** 그 팀장의 턴이 오류로 끝났다(CLI 가 알린 글 그대로). */
  fail(memberId: string, errorText: string) { this.busy.delete(memberId); this.cb({ type: "turn_end", memberId, finalText: "", isError: true, errorText }); }
  end(memberId: string) { this.busy.delete(memberId); this.cb({ type: "turn_end", memberId, finalText: "", isError: false }); }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function until(what: string, cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`시간 초과: ${what}`);
    await Bun.sleep(5);
  }
}

/** 임시 폴더만 쓰는 설정. CLI 자리는 모두 가짜 실행 파일이고, CLI 홈도 임시 폴더다. */
function isolatedConfig(): { root: string; work: string; config: Config; env: Record<string, string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-gemini-orch-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { work: join(root, "work"), bin: join(root, "bin"), user: join(root, "user"), claude: join(root, "claude"), codex: join(root, "codex"), gemini: join(root, "gemini") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { mode: 0o700 });
  for (const name of ["core", "claude", "codex", "agy"]) writeFileSync(join(dirs.bin, name), "#!/bin/sh\nprintf 'fake: no real CLI\\n' >&2\nexit 97\n", { mode: 0o700 });
  const env = {
    IAMCEO_HOME: join(root, "state"), IAMCEO_PORT: "0", HOME: dirs.user, PATH: "/usr/bin:/bin",
    CLAUDE_CONFIG_DIR: dirs.claude, CODEX_HOME: dirs.codex, IAMCEO_GEMINI_HOME: dirs.gemini,
    IAMCEO_CORE_BIN: join(dirs.bin, "core"), IAMCEO_CORE_SOCKET: join(root, "no-core.sock"),
    IAMCEO_CLAUDE_BIN: join(dirs.bin, "claude"), IAMCEO_CODEX_BIN: join(dirs.bin, "codex"), IAMCEO_GEMINI_BIN: join(dirs.bin, "agy"),
  };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  return { root, work: dirs.work, config: loadConfig(env), env };
}

function setup(opts: { geminiModels?: GeminiModelsRefresher; geminiQuota?: GeminiQuotaReader; apiRecovery?: OrchestratorDeps["apiRecovery"]; notifier?: (title: string, body: string) => void; timings?: Partial<OrchestratorTimings> } = {}) {
  const { root, work, config } = isolatedConfig();
  const db = openDb(config.dbPath);
  const store = new Store(db, new Bus());
  store.patchSettings({ boardTidyHours: 0 });
  const runner = new FakeRunner();
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000, ...opts.timings }, ...(opts.geminiModels ? { geminiModels: opts.geminiModels } : {}),
    ...(opts.geminiQuota ? { geminiQuota: opts.geminiQuota } : {}), ...(opts.apiRecovery ? { apiRecovery: opts.apiRecovery } : {}), ...(opts.notifier ? { notifier: opts.notifier } : {}) });
  cleanups.push(async () => { await orch.shutdown(); db.close(); });
  const project = store.createProject({ name: "시험", cwd: work });
  const runDir = join(config.home, "run");
  const add = async (name: string, handle: string, extra: { cli?: Member["cli"]; modelOverride?: string | null } = {}) => {
    const member = (await orch.addMember(project.id, { name, handle, role: name, ...extra })).member;
    await orch.pump(member.id);
    return store.requireMember(member.id);
  };
  const tool = (member: Member, name: string, args: Record<string, unknown>) => handleAgentTool(orch, store.requireMember(member.id), name, args);
  const priv = <T>(name: string, ...args: unknown[]): T => (Reflect.get(orch, name) as (...a: unknown[]) => T).call(orch, ...args);
  return { root, work, config, db, store, runner, orch, project, runDir, add, tool, priv };
}

describe("저장: 총괄 CLI 와 Gemini 직급표", () => {
  test("총괄 CLI 'gemini' 를 저장한 그대로 읽는다. 모르는 값만 claude 다", () => {
    const { config } = isolatedConfig();
    const db = openDb(config.dbPath);
    cleanups.push(() => db.close());
    const store = new Store(db, new Bus());
    const project = store.createProject({ name: "총괄", cwd: config.home });
    expect(store.chiefCli(project.id)).toBe("claude");
    store.setChiefCli(project.id, "gemini");
    expect(store.chiefCli(project.id)).toBe("gemini");
    expect(db.query("SELECT chief_cli FROM projects WHERE id = ?").get(project.id)).toEqual({ chief_cli: "gemini" });
    // 다시 연 저장소도 같은 값을 읽는다.
    expect(new Store(db, new Bus()).chiefCli(project.id)).toBe("gemini");
    store.setChiefCli(project.id, "codex");
    expect(store.chiefCli(project.id)).toBe("codex");
    store.setChiefCli(project.id, "claude");
    expect(store.chiefCli(project.id)).toBe("claude");
    // 타입 밖의 값(다음 판이 적은 값 등)과 없는 프로젝트는 claude 다.
    db.query("UPDATE projects SET chief_cli = ? WHERE id = ?").run("some-future-cli", project.id);
    expect(store.chiefCli(project.id)).toBe("claude");
    expect(store.chiefCli("no-such-project")).toBe("claude");
    // 만들 때 준 값도 그대로다.
    const made = store.createProject({ name: "처음부터", cwd: config.home, chiefCli: "gemini" });
    expect(store.chiefCli(made.id)).toBe("gemini");
    // 팀장의 cli 값도 열에 그대로 들어가고 나온다(열에 값 제한이 없다).
    const member = store.createMember({ projectId: made.id, name: "자료 조사", handle: "research", kind: "worker", cli: "gemini" });
    expect(store.requireMember(member.id).cli).toBe("gemini");
    expect(db.query("SELECT cli FROM members WHERE id = ?").get(member.id)).toEqual({ cli: "gemini" });
  });

  test("geminiRanks: 저장값이 없으면 기본값(전부 null), 고친 칸만 바뀌고, 다시 열어도 남는다. 다른 직급표와 섞이지 않는다", () => {
    const { config } = isolatedConfig();
    const db = openDb(config.dbPath);
    cleanups.push(() => db.close());
    const store = new Store(db, new Bus());
    expect(store.getSettings().geminiRanks).toEqual(DEFAULT_GEMINI_RANKS);
    expect(db.query("SELECT count(*) AS n FROM settings WHERE key = 'geminiRanks'").get()).toEqual({ n: 0 });
    // 일부 직급만 저장된 값(다른 판이 적었다고 치고)도 칸은 다 있다.
    db.query("INSERT INTO settings(key,value) VALUES (?,?)").run("geminiRanks", JSON.stringify({ lead: { model: "gemini-4-neon" } }));
    expect(new Store(db, new Bus()).getSettings().geminiRanks).toEqual({ ...DEFAULT_GEMINI_RANKS, lead: { model: "gemini-4-neon", effort: null } });
    db.query("DELETE FROM settings WHERE key = 'geminiRanks'").run();
    const fresh = new Store(db, new Bus());
    fresh.patchSettings({ ranks: { lead: { model: "sonnet", effort: "high" } }, codexRanks: { lead: { model: "gpt-6-luna" } } });
    expect(fresh.getSettings().geminiRanks).toEqual(DEFAULT_GEMINI_RANKS);
    const saved = fresh.patchSettings({ geminiRanks: { lead: { model: "gemini-4-neon", effort: "xhigh" }, staff: { model: "gemini-3.8-flash" } } });
    expect(saved.geminiRanks).toEqual({ manager: { model: null, effort: null }, lead: { model: "gemini-4-neon", effort: "xhigh" }, staff: { model: "gemini-3.8-flash", effort: null } });
    expect(saved.ranks.lead).toEqual({ model: "sonnet", effort: "high" });
    expect(saved.codexRanks.lead).toEqual({ model: "gpt-6-luna", effort: null });
    // 한 칸만 고치면 나머지는 남는다.
    expect(fresh.patchSettings({ geminiRanks: { lead: { effort: null } } }).geminiRanks.lead).toEqual({ model: "gemini-4-neon", effort: null });
    expect(new Store(db, new Bus()).getSettings().geminiRanks.staff).toEqual({ model: "gemini-3.8-flash", effort: null });
    // 직급표 고르기: CLI 마다 자기 표.
    const settings = fresh.getSettings();
    expect(ranksFor("gemini", settings)).toBe(settings.geminiRanks);
    expect(ranksFor("claude", settings)).toBe(settings.ranks);
    expect(ranksFor("codex", settings)).toBe(settings.codexRanks);
    // 이 칸이 없는 옛 설정 행들만 있는 DB(직급표 두 개만 저장)도 그대로 읽힌다.
    db.query("DELETE FROM settings WHERE key = 'geminiRanks'").run();
    const legacy = new Store(db, new Bus()).getSettings();
    expect(legacy.geminiRanks).toEqual(DEFAULT_GEMINI_RANKS);
    expect(legacy.ranks.lead).toEqual({ model: "sonnet", effort: "high" });
  });

  test("직급 effort 채우기(서버가 뜰 때): Claude 직급표만 채운다. Gemini 직급표에는 effort 를 채우지 않는다", () => {
    const { config } = isolatedConfig();
    const db = openDb(config.dbPath);
    cleanups.push(() => db.close());
    const store = new Store(db, new Bus());
    // bin/iamceo.ts 가 서버를 띄울 때마다 부른다. 모델을 정하지 않은 Gemini 에 effort 가 채워지면 agy 가 기본 모델로 따져 시작 전에 끝날 수 있다.
    store.fillRankEfforts("high");
    expect(store.getSettings().ranks).toEqual({ manager: { model: null, effort: "high" }, lead: { model: null, effort: "high" }, staff: { model: null, effort: "high" } });
    expect(store.getSettings().geminiRanks).toEqual(DEFAULT_GEMINI_RANKS);
    expect(db.query("SELECT count(*) AS n FROM settings WHERE key = 'geminiRanks'").get()).toEqual({ n: 0 });
    expect(store.getSettings().codexRanks).toEqual(DEFAULT_RANKS);
    // Gemini 직급에 모델만 정해 둔 경우도 그대로 둔다(effort 는 agy 의 기본값).
    store.patchSettings({ geminiRanks: { lead: { model: "gemini-4-neon" } } });
    store.fillRankEfforts("max");
    expect(store.getSettings().geminiRanks).toEqual({ ...DEFAULT_GEMINI_RANKS, lead: { model: "gemini-4-neon", effort: null } });
  });

  test("Gemini 를 쓰는 근거(geminiInUse): Gemini 인 팀장·총괄이 있거나 Gemini 직급표에 정한 값이 있을 때만 참이다", () => {
    const { config } = isolatedConfig();
    const db = openDb(config.dbPath);
    cleanups.push(() => db.close());
    const store = new Store(db, new Bus());
    const project = store.createProject({ name: "근거", cwd: config.home });
    expect(store.geminiInUse()).toBe(false);
    // Claude·Codex 만 쓰는 Mac.
    store.createMember({ projectId: project.id, name: "화면 개발", handle: "ui", kind: "worker", cli: "claude" });
    const codex = store.createMember({ projectId: project.id, name: "서버 개발", handle: "api", kind: "worker", cli: "codex" });
    store.setChiefCli(project.id, "codex");
    store.patchSettings({ ranks: { lead: { model: "sonnet" } }, codexRanks: { lead: { model: "gpt-6-luna", effort: "low" } } });
    expect(store.geminiInUse()).toBe(false);
    // 팀장 하나가 Gemini.
    store.patchMember(codex.id, { cli: "gemini" });
    expect(store.geminiInUse()).toBe(true);
    store.patchMember(codex.id, { cli: "codex" });
    expect(store.geminiInUse()).toBe(false);
    // 총괄 CLI 가 Gemini(총괄을 아직 띄우지 않았어도).
    store.setChiefCli(project.id, "gemini");
    expect(store.geminiInUse()).toBe(true);
    store.setChiefCli(project.id, "claude");
    expect(store.geminiInUse()).toBe(false);
    // Gemini 직급표에 정한 값.
    store.patchSettings({ geminiRanks: { staff: { model: "gemini-3.8-flash" } } });
    expect(store.geminiInUse()).toBe(true);
    store.patchSettings({ geminiRanks: { staff: { model: null } } });
    expect(store.geminiInUse()).toBe(false);
  });

  test("서브에이전트 값: Claude 는 모델·effort, Codex 는 모델만, Gemini 는 둘 다 넘기지 않는다", () => {
    const settings = { ranks: { ...DEFAULT_RANKS, staff: { model: "haiku", effort: "low" } }, codexRanks: { ...DEFAULT_RANKS, staff: { model: "gpt-6.1-terra", effort: "minimal" } }, geminiRanks: { ...DEFAULT_RANKS, staff: { model: "gemini-3.8-flash", effort: "low" } } };
    expect(staffConfig("claude", settings)).toEqual({ model: "haiku", effort: "low" });
    expect(staffConfig(undefined, settings)).toEqual({ model: "haiku", effort: "low" });
    expect(staffConfig("codex", settings)).toEqual({ model: "gpt-6.1-terra", effort: null });
    expect(staffConfig("gemini", settings)).toEqual({ model: null, effort: null });
  });
});

describe("Gemini 총괄·팀장 띄우기", () => {
  test("Gemini 총괄: 저장한 CLI 로 뜨고, 그 프로젝트에서 CLI 없이 만든 팀장도 Gemini 다. Claude 형식 설정 파일을 넘기지 않는다", async () => {
    const t = setup();
    const made = await t.orch.createProject({ name: "제미나이 팀", cwd: t.work, chiefCli: "gemini", startConductor: true });
    expect(t.store.chiefCli(made.id)).toBe("gemini");
    const lead = t.store.getConductor(made.id)!;
    expect(lead).toMatchObject({ kind: "conductor", cli: "gemini" });
    const started = t.runner.startsOf(lead.id);
    expect(started).toHaveLength(1);
    expect(started[0]!.member).toMatchObject({ cli: "gemini", model: null, effort: null, subagentModel: null });
    // 실행 파일은 그 팀장만의 폴더에 있다(실행기가 그 옆에 주입 폴더를 만든다). Claude 형식 settings 는 없다.
    const own = geminiRunDir(t.config.home, lead.id);
    expect(own).toBe(join(t.runDir, `${lead.id}.gemini`));
    expect(started[0]!.opts.systemPromptFile).toBe(join(own, "rules.md"));
    expect(started[0]!.opts.mcpConfigFile).toBe(join(own, "mcp.json"));
    expect(started[0]!.opts.settingsFile).toBeUndefined();
    expect(started[0]!.opts.resume).toBe(false);
    expect(statSync(own).mode & 0o777).toBe(0o700);
    expect(statSync(join(own, "mcp.json")).mode & 0o777).toBe(0o600);
    const mcp = JSON.parse(readFileSync(join(own, "mcp.json"), "utf8")) as { mcpServers: { iamceo: { command: string; args: string[]; env: Record<string, string> } } };
    expect(Object.keys(mcp.mcpServers)).toEqual(["iamceo"]);
    expect(mcp.mcpServers.iamceo.env.IAMCEO_TOKEN).toBe(t.store.getMemberToken(lead.id));
    expect(readFileSync(join(own, "rules.md"), "utf8")).toContain("제미나이 팀");
    expect(readdirSync(t.runDir).filter(name => name.startsWith(`${lead.id}.`))).toEqual([`${lead.id}.gemini`]);

    // CLI 를 정하지 않은 팀장은 그 프로젝트 총괄의 CLI 를 따른다.
    const worker = (await t.orch.addMember(made.id, { name: "자료 조사", handle: "research", role: "조사" })).member;
    expect(worker.cli).toBe("gemini");
    expect(t.runner.startsOf(worker.id)[0]!.opts.settingsFile).toBeUndefined();
    // 팀장마다 폴더가 따로다(지침과 토큰이 섞이지 않는다).
    expect(t.runner.startsOf(worker.id)[0]!.opts.mcpConfigFile).toBe(join(t.runDir, `${worker.id}.gemini`, "mcp.json"));
    expect(JSON.parse(readFileSync(join(t.runDir, `${worker.id}.gemini`, "mcp.json"), "utf8")).mcpServers.iamceo.env.IAMCEO_TOKEN).toBe(t.store.getMemberToken(worker.id));

    // 같은 프로젝트의 Claude·Codex 팀장은 예전 그대로다: run 폴더의 <id>.rules.md·<id>.mcp.json, Claude 만 <id>.settings.json.
    const claude = (await t.orch.addMember(made.id, { name: "화면 개발", handle: "ui", role: "개발", cli: "claude" })).member;
    const codex = (await t.orch.addMember(made.id, { name: "서버 개발", handle: "api", role: "개발", cli: "codex" })).member;
    expect(t.runner.startsOf(claude.id)[0]!.opts).toMatchObject({ systemPromptFile: join(t.runDir, `${claude.id}.rules.md`), mcpConfigFile: join(t.runDir, `${claude.id}.mcp.json`), settingsFile: join(t.runDir, `${claude.id}.settings.json`) });
    expect(Object.keys(JSON.parse(readFileSync(join(t.runDir, `${claude.id}.settings.json`), "utf8")))).toContain("statusLine");
    expect(t.runner.startsOf(codex.id)[0]!.opts).toMatchObject({ systemPromptFile: join(t.runDir, `${codex.id}.rules.md`), mcpConfigFile: join(t.runDir, `${codex.id}.mcp.json`) });
    expect(t.runner.startsOf(codex.id)[0]!.opts.settingsFile).toBeUndefined();
    expect(existsSync(join(t.runDir, `${claude.id}.gemini`))).toBe(false);
    expect(existsSync(join(t.runDir, `${codex.id}.gemini`))).toBe(false);
    // 총괄을 다시 띄워도(이미 있으면 그대로) Gemini 다.
    expect((await t.orch.ensureConductor(made.id)).cli).toBe("gemini");
    // 새 세션의 사용량 장부 칸은 그 CLI 의 것이다. Claude·Codex 는 띄울 때 세션 id 가 있어 그때 적힌다.
    const ledger = (id: string) => t.db.query("SELECT provider, session_id FROM usage_sessions WHERE member_id = ?").all(id);
    expect(ledger(claude.id)).toEqual([{ provider: "claude", session_id: claude.sessionId }]);
    expect(ledger(codex.id)).toEqual([{ provider: "codex", session_id: codex.sessionId }]);
    // Gemini 는 대화 id 없이 뜬다(첫 글을 받을 때 agy 가 정한다). 장부에는 아직 줄이 없고, id 를 알아낸 때(session 사건) Gemini 칸으로 적힌다.
    expect(lead.sessionId).toBeNull();
    expect(t.store.requireMember(worker.id).sessionId).toBeNull();
    expect(ledger(lead.id)).toEqual([]);
    const conversation = t.runner.learn(lead.id);
    await until("총괄의 대화 id", () => t.store.requireMember(lead.id).sessionId === conversation);
    expect(ledger(lead.id)).toEqual([{ provider: "gemini", session_id: conversation }]);
    expect(ledger(worker.id)).toEqual([]);
  });

  test("직급 기본값: Gemini 팀장은 geminiRanks 만 쓴다. Claude 직급의 모델 이름이 넘어가지 않고, 서브에이전트 값은 넘기지 않는다", async () => {
    const t = setup();
    t.store.patchSettings({
      ranks: { manager: { model: "opus", effort: "max" }, lead: { model: "sonnet", effort: "high" }, staff: { model: "haiku", effort: "low" } },
      codexRanks: { lead: { model: "gpt-6-luna", effort: "low" }, staff: { model: "gpt-6.1-terra" } },
    });
    // geminiRanks 는 기본값(전부 null): CLI 기본 모델로 뜬다.
    const first = await t.add("자료 조사", "research", { cli: "gemini" });
    expect(t.runner.startsOf(first.id)[0]!.member).toMatchObject({ cli: "gemini", model: null, effort: null, subagentModel: null });
    expect(t.store.getAppliedConfig(first.id)).toEqual({ model: null, effort: null, staffModel: null, staffEffort: null });
    // 다른 CLI 는 예전 그대로 자기 직급표다.
    const claude = await t.add("화면 개발", "ui", { cli: "claude" });
    const codex = await t.add("서버 개발", "api", { cli: "codex" });
    expect(t.runner.startsOf(claude.id)[0]!.member).toMatchObject({ model: "sonnet", effort: "high", subagentModel: "haiku" });
    expect(t.runner.startsOf(codex.id)[0]!.member).toMatchObject({ model: "gpt-6-luna", effort: "low", subagentModel: "gpt-6.1-terra" });
    expect(t.store.getAppliedConfig(claude.id)).toEqual({ model: "sonnet", effort: "high", staffModel: "haiku", staffEffort: "low" });
    expect(t.store.getAppliedConfig(codex.id)).toEqual({ model: "gpt-6-luna", effort: "low", staffModel: "gpt-6.1-terra", staffEffort: null });

    // Gemini 직급표를 정하면 그 값으로 뜬다. 직급 staff 값은 세션에 넣을 길이 없어 넘기지 않는다.
    t.store.patchSettings({ geminiRanks: { manager: { model: "gemini-4-argon", effort: "high" }, lead: { model: "gemini-4-neon", effort: "xhigh" }, staff: { model: "gemini-3.8-flash", effort: "low" } } });
    const second = await t.add("문서 정리", "docs", { cli: "gemini" });
    expect(t.runner.startsOf(second.id)[0]!.member).toMatchObject({ model: "gemini-4-neon", effort: "xhigh", subagentModel: null });
    expect(t.store.getAppliedConfig(second.id)).toEqual({ model: "gemini-4-neon", effort: "xhigh", staffModel: null, staffEffort: null });
    // 팀장별 지정이 직급을 이긴다. 직급에서 물려받은 effort(xhigh)를 그 모델(flash: low~high)이 받지 않으면 넘기지 않는다:
    // 그대로 넘기면 agy 가 시작 전에 끝난다(모델마다 받는 effort 가 다르다).
    const third = await t.add("번역", "translate", { cli: "gemini", modelOverride: "gemini-3.8-flash" });
    expect(t.runner.startsOf(third.id)[0]!.member).toMatchObject({ model: "gemini-3.8-flash", effort: null });
    expect(t.store.getAppliedConfig(third.id)).toMatchObject({ model: "gemini-3.8-flash", effort: null });
    // 그 모델이 받는 effort 를 물려받으면 그대로 넘긴다.
    const fourth = await t.add("검수", "review", { cli: "gemini", modelOverride: "gemini-4-hydrogen" });
    expect(t.runner.startsOf(fourth.id)[0]!.member).toMatchObject({ model: "gemini-4-hydrogen", effort: "xhigh" });
    // 총괄은 부장 직급이다.
    t.store.setChiefCli(t.project.id, "gemini");
    const lead = await t.orch.ensureConductor(t.project.id);
    expect(t.runner.startsOf(lead.id)[0]!.member).toMatchObject({ cli: "gemini", model: "gemini-4-argon", effort: "high", subagentModel: null });

    // 명부(총괄이 보는 roster)도 CLI 마다 자기 직급표다.
    const roster = new Map(t.orch.roster(t.project.id).map(entry => [entry.handle, entry]));
    expect(roster.get("docs")).toMatchObject({ model: "gemini-4-neon", effort: "xhigh", subagentModel: null, subagentEffort: null });
    expect(roster.get("ui")).toMatchObject({ model: "sonnet", effort: "high", subagentModel: "haiku", subagentEffort: "low" });
    expect(roster.get("api")).toMatchObject({ model: "gpt-6-luna", effort: "low", subagentModel: "gpt-6.1-terra", subagentEffort: null });

    // 역할 지침의 '서브에이전트에 effort 를 넘긴다' 줄은 Claude 에만 붙는다.
    const rules = (id: string) => readFileSync(t.runner.startsOf(id).at(-1)!.opts.systemPromptFile, "utf8");
    expect(rules(claude.id)).toContain("effort=low 을 넘긴다");
    expect(rules(second.id)).not.toContain("을 넘긴다");
    expect(rules(codex.id)).not.toContain("을 넘긴다");

    // Gemini 직급 staff 를 고쳐도(세션에 들어가지 않는 값) Gemini 세션은 다시 열 것이 없다. 직급 lead 를 고치면 있다.
    const pending = (id: string) => t.priv<boolean>("configPending", t.store.requireMember(id));
    expect(pending(second.id)).toBe(false);
    t.store.patchSettings({ geminiRanks: { staff: { model: "gemini-4-argon", effort: "high" } } });
    expect(pending(second.id)).toBe(false);
    // Claude 직급을 고쳐도 Gemini 세션은 그대로다.
    t.store.patchSettings({ ranks: { lead: { model: "opus" }, staff: { model: "sonnet" } } });
    expect(pending(second.id)).toBe(false);
    expect(pending(claude.id)).toBe(true);
    t.store.patchSettings({ geminiRanks: { lead: { effort: "high" } } });
    expect(pending(second.id)).toBe(true);
    // 팀장별 모델을 정한 팀장은 직급 모델이 그대로라 effort 만 달라진다.
    expect(t.priv<AppliedConfig>("desiredConfig", t.store.requireMember(third.id))).toEqual({ model: "gemini-3.8-flash", effort: "high", staffModel: null, staffEffort: null });
  });

  test("팀장을 지우거나 프로젝트를 지우면 Gemini 실행 폴더(토큰이 든 MCP 설정)도 지운다", async () => {
    const t = setup();
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    const other = await t.add("문서 정리", "docs", { cli: "gemini" });
    const own = geminiRunDir(t.config.home, gemini.id), kept = geminiRunDir(t.config.home, other.id);
    // 실행기가 만드는 주입 폴더 자리(dirname(rules.md)/agy)를 흉내 낸다.
    mkdirSync(join(own, "agy", ".agents"), { recursive: true });
    writeFileSync(join(own, "agy", ".agents", "mcp_config.json"), "{}");
    expect(existsSync(join(own, "mcp.json"))).toBe(true);
    await t.orch.closeMember(gemini.id);
    expect(t.store.getMember(gemini.id)).toBeNull();
    expect(existsSync(own)).toBe(false);
    expect(existsSync(join(kept, "mcp.json"))).toBe(true);

    // 프로젝트 삭제의 디스크 정리(lifecycle/project-data.ts): 그 팀장의 폴더만 지운다. 링크는 따라가지 않는다.
    const outside = join(t.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(t.runDir, "mem_linked.gemini"));
    writeFileSync(join(t.runDir, "mem_plain.rules.md"), "rules");
    mkdirSync(join(t.runDir, "mem_plain.other"));
    const result = removeDeletedProjectFiles({ home: t.config.home, uploadsDir: t.config.uploadsDir, inboxDir: t.config.inboxDir }, { memberIds: [other.id, "mem_linked", "mem_plain"], attachments: [] });
    expect(result.failed).toBe(0);
    expect(existsSync(kept)).toBe(false);
    expect(existsSync(join(t.runDir, "mem_plain.rules.md"))).toBe(false);
    // <id>.gemini 가 아닌 폴더와, 링크인 <id>.gemini 는 건드리지 않는다.
    expect(existsSync(join(t.runDir, "mem_plain.other"))).toBe(true);
    expect(lstatSync(join(t.runDir, "mem_linked.gemini")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

});

describe("계정 세대: Claude·Codex 로 다시 로그인해도 Gemini 팀장은 다시 열리지 않는다", () => {
  test("Claude 계정이 바뀌면 Claude 팀장만 같은 대화를 다시 연다. Gemini 팀장의 세션과 적용 설정은 그대로다", async () => {
    const t = setup();
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    const claude = await t.add("화면 개발", "ui", { cli: "claude" });
    expect(t.runner.startsOf(gemini.id)).toHaveLength(1);
    expect(t.runner.startsOf(claude.id)).toHaveLength(1);
    const applied = t.store.getAppliedConfig(gemini.id);
    const pending = (id: string) => t.priv<boolean>("configPending", t.store.requireMember(id));

    const result = await t.orch.cliLoggedIn("claude", "new-account", "old-account");
    // 쉬는 Claude 팀장 한 명만 다음에 맞춘다. Gemini 팀장은 세지 않는다.
    expect(result).toEqual({ changed: true, reopenedNow: 0, atNextTurn: 1 });
    expect(pending(gemini.id)).toBe(false);
    expect(t.priv<AppliedConfig>("desiredConfig", t.store.requireMember(gemini.id))).toEqual({ model: null, effort: null, staffModel: null, staffEffort: null });
    expect(t.priv<AppliedConfig>("desiredConfig", t.store.requireMember(claude.id)).account).toBe(1);
    await t.orch.accountReopening;
    await until("Claude 팀장 다시 열림", () => t.runner.startsOf(claude.id).length === 2);
    expect(t.runner.startsOf(claude.id)[1]!.opts.resume).toBe(true);
    expect(t.runner.startsOf(claude.id)[1]!.member.sessionId).toBe(claude.sessionId);
    await until("Claude 적용 설정", () => t.store.getAppliedConfig(claude.id)?.account === 1);

    // Codex 로그인도 Gemini 와 무관하다.
    expect(await t.orch.cliLoggedIn("codex", "codex-new", "codex-old")).toEqual({ changed: true, reopenedNow: 0, atNextTurn: 0 });
    await t.orch.accountReopening;
    // Gemini 팀장을 펌프해도(쉬는 세션의 설정 맞추기) 다시 열 것이 없다.
    await t.orch.pump(gemini.id);
    await Bun.sleep(150);
    expect(t.runner.startsOf(gemini.id)).toHaveLength(1);
    expect(t.runner.stops).not.toContain(gemini.id);
    expect(t.store.requireMember(gemini.id)).toMatchObject({ sessionId: gemini.sessionId, paneId: gemini.paneId, status: "idle" });
    expect(t.store.getAppliedConfig(gemini.id)).toEqual(applied);
    expect(t.store.getAppliedConfig(gemini.id)?.account).toBeUndefined();
    expect(pending(gemini.id)).toBe(false);
    // 저장되는 계정 세대에는 로그인을 다루는 CLI 만 있다.
    const epochs = t.store.loadApiRecovery<Record<string, { epoch: number }>>("cli_accounts")!;
    expect(Object.keys(epochs).sort()).toEqual(["claude", "codex"]);
    expect(epochs.claude!.epoch).toBe(1);
  });
});

describe("총괄의 도구: Gemini 로 띄우기", () => {
  const sharedModel = (slug: string) => ({ slug, display_name: slug, visibility: "list", priority: 1, supported_reasoning_levels: [{ effort: "low" }] });

  test("team_add: cli 'gemini' 를 받고, 모르는 cli 값은 거절한다. 도구 목록의 값에도 gemini 가 있다", async () => {
    const t = setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    expect(lead.cli).toBe("claude");
    const schema = listAgentTools(lead).find(tool => tool.name === "team_add")!.inputSchema as { properties: { cli: { enum: string[]; description: string } } };
    expect(schema.properties.cli.enum).toEqual(["claude", "codex", "gemini"]);
    expect(schema.properties.cli.description).toContain("Antigravity CLI");

    const added = await t.tool(lead, "team_add", { name: "자료 조사", role: "조사", cli: "gemini" });
    expect(added.isError).toBeUndefined();
    const member = t.store.findMember(t.project.id, "자료 조사")!;
    expect(member).toMatchObject({ cli: "gemini", modelOverride: null });
    expect(t.runner.startsOf(member.id)[0]!.member.cli).toBe("gemini");

    const withModel = await t.tool(lead, "team_add", { name: "문서 정리", role: "정리", cli: "gemini", model: "gemini-4-argon" });
    expect(withModel.isError).toBeUndefined();
    expect(t.store.findMember(t.project.id, "문서 정리")).toMatchObject({ cli: "gemini", modelOverride: "gemini-4-argon" });

    const before = t.store.listMembers(t.project.id).length;
    // cli 를 정했으면 그 CLI 의 목록에 있는 모델만 받는다(다른 CLI 로 바꿔 띄우지 않는다).
    const wrongModel = await t.tool(lead, "team_add", { name: "거절", role: "시험", cli: "gemini", model: "opus" });
    expect(wrongModel).toMatchObject({ isError: true });
    expect(wrongModel.text).toContain("목록에 없는 모델입니다");
    for (const cli of ["antigravity", "agy", "Gemini", ""]) {
      const bad = await t.tool(lead, "team_add", { name: "거절", role: "시험", cli });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("인자가 잘못되었습니다");
    }
    expect(t.store.listMembers(t.project.id)).toHaveLength(before);
  });

  test("team_add: 모델만 주면 그 모델이 있는 CLI 로 띄운다. Claude↔Codex 는 예전 그대로, Gemini 로는 이름이 Gemini 계열(gemini-…)일 때만", async () => {
    const t = setup();
    // Gemini 목록(캐시)과 Codex 목록에 같은 이름을 하나 넣는다. Gemini 목록에는 Claude 목록의 이름(opus)과,
    // agy 가 함께 주는 Claude·GPT 계열 모델(`agy models` 의 claude-opus-5-5-low, gpt-oss-120b-medium)도 넣는다.
    const geminiModels: ModelOption[] = [
      { value: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { value: "shared-model", label: "Shared", efforts: [] },
      { value: "opus", label: "Opus via agy", efforts: [] },
      { value: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low"] },
      { value: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"], defaultEffort: "medium" },
    ];
    writeGeminiModelsCache(geminiModelsCachePath(t.config.home), geminiModels, new Date());
    writeFileSync(join(t.config.codexHome!, "models_cache.json"), JSON.stringify({ models: [sharedModel("gpt-6.1-sol"), sharedModel("shared-model"), sharedModel("both-old")] }));
    writeFileSync(join(t.config.claudeHome!, ".claude.json"), JSON.stringify({ additionalModelOptionsCache: [{ value: "both-old", label: "Both" }] }));

    const lead = await t.orch.ensureConductor(t.project.id);
    expect(lead.cli).toBe("claude");
    const cliOf = (name: string) => t.store.findMember(t.project.id, name)?.cli;
    const add = async (by: Member, name: string, model: string) => t.tool(by, "team_add", { name, role: "시험", model });

    // Claude 총괄
    expect((await add(lead, "제미나이 모델", "gemini-4-neon")).isError).toBeUndefined();
    expect(t.store.findMember(t.project.id, "제미나이 모델")).toMatchObject({ cli: "gemini", modelOverride: "gemini-4-neon" });
    expect((await add(lead, "코덱스 모델", "gpt-6.1-sol")).isError).toBeUndefined();
    expect(cliOf("코덱스 모델")).toBe("codex");
    // 자기 목록에 있는 이름은 자기 CLI 다(Gemini 목록에도 있지만 옮기지 않는다).
    expect((await add(lead, "자기 목록", "opus")).isError).toBeUndefined();
    expect(cliOf("자기 목록")).toBe("claude");
    // Codex 와 Gemini 둘 다에 있는 이름: 예전 그대로 Codex.
    expect((await add(lead, "둘 다", "shared-model")).isError).toBeUndefined();
    expect(cliOf("둘 다")).toBe("codex");
    // 어디에도 없는 이름은 거절.
    expect(await add(lead, "없는 모델", "nowhere-model")).toMatchObject({ isError: true });
    expect(cliOf("없는 모델")).toBeUndefined();
    // agy 목록에만 있는 Claude·GPT 계열 이름은 Gemini 로 보내지 않는다: 0.2.9 처럼 '목록에 없는 모델'로 거절한다.
    // (Gemini 로 띄우면 대표가 시킨 것과 다른 계정·한도·권한 방식의 팀장이 뜬다.)
    const before = t.store.listMembers(t.project.id).length;
    for (const [name, model] of [["클로드 계열", "claude-opus-5-5"], ["지피티 계열", "gpt-oss-120b"]] as const) {
      const refused = await add(lead, name, model);
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("목록에 없는 모델입니다");
      expect(cliOf(name)).toBeUndefined();
    }
    expect(await rejection(t.orch.addMember(t.project.id, { name: "클로드 계열", role: "시험", modelOverride: "claude-opus-5-5" }, lead))).toMatchObject({ status: 400, code: "model_unknown" });
    expect(t.store.listMembers(t.project.id)).toHaveLength(before);
    expect(t.runner.starts.some(start => start.member.model === "claude-opus-5-5" || start.member.model === "gpt-oss-120b")).toBe(false);
    // 그 모델을 agy 로 쓰려면 총괄이 cli 를 명시한다.
    expect((await t.tool(lead, "team_add", { name: "명시한 제미나이", role: "시험", cli: "gemini", model: "claude-opus-5-5" })).isError).toBeUndefined();
    expect(t.store.findMember(t.project.id, "명시한 제미나이")).toMatchObject({ cli: "gemini", modelOverride: "claude-opus-5-5" });

    // Codex 총괄: Claude 와 Gemini 둘 다에 있는 이름(opus)은 예전 그대로 Claude.
    const codexLead = t.store.createMember({ projectId: t.project.id, name: "코덱스 총괄", handle: "codex-lead", kind: "conductor", cli: "codex", origin: "runner", backend: "core", status: "idle" });
    expect((await add(codexLead, "코덱스가 소넷", "sonnet")).isError).toBeUndefined();
    expect(cliOf("코덱스가 소넷")).toBe("claude");
    expect((await add(codexLead, "코덱스가 오퍼스", "opus")).isError).toBeUndefined();
    expect(cliOf("코덱스가 오퍼스")).toBe("claude");
    expect((await add(codexLead, "코덱스가 제미나이", "gemini-4-neon")).isError).toBeUndefined();
    expect(cliOf("코덱스가 제미나이")).toBe("gemini");
    // Codex 총괄도 같다: agy 목록에만 있는 Claude·GPT 계열 이름은 거절한다.
    for (const [name, model] of [["코덱스가 클로드 계열", "claude-opus-5-5"], ["코덱스가 지피티 계열", "gpt-oss-120b"]] as const) {
      const refused = await add(codexLead, name, model);
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain("목록에 없는 모델입니다");
      expect(cliOf(name)).toBeUndefined();
    }
    // 화면에서 만든 팀장(부른 총괄 없음)은 이 프로젝트 총괄의 CLI(claude)를 따른다. 규칙은 같다.
    expect(await rejection(t.orch.addMember(t.project.id, { name: "화면에서 클로드 계열", role: "시험", modelOverride: "gpt-oss-120b" }))).toMatchObject({ status: 400, code: "model_unknown" });
    expect((await t.orch.addMember(t.project.id, { name: "화면에서 제미나이", role: "시험", modelOverride: "gemini-4-neon" })).member.cli).toBe("gemini");

    // Gemini 총괄: 자기 목록의 이름은 Gemini, 한 CLI 에만 있는 이름은 그 CLI, 두 CLI 에 있는 이름은 정하지 못해 거절.
    const geminiLead = t.store.createMember({ projectId: t.project.id, name: "제미나이 총괄", handle: "gemini-lead", kind: "conductor", cli: "gemini", origin: "runner", backend: "core", status: "idle" });
    expect((await add(geminiLead, "제미나이가 자기 모델", "opus")).isError).toBeUndefined();
    expect(cliOf("제미나이가 자기 모델")).toBe("gemini");
    // Gemini 총괄에게는 agy 목록의 Claude·GPT 계열 이름도 자기 목록의 모델이다.
    expect((await add(geminiLead, "제미나이가 클로드 계열", "claude-opus-5-5")).isError).toBeUndefined();
    expect(cliOf("제미나이가 클로드 계열")).toBe("gemini");
    expect((await add(geminiLead, "제미나이가 소넷", "sonnet")).isError).toBeUndefined();
    expect(cliOf("제미나이가 소넷")).toBe("claude");
    expect((await add(geminiLead, "제미나이가 코덱스", "gpt-6.1-sol")).isError).toBeUndefined();
    expect(cliOf("제미나이가 코덱스")).toBe("codex");
    const ambiguous = await add(geminiLead, "정할 수 없음", "both-old");
    expect(ambiguous).toMatchObject({ isError: true });
    expect(ambiguous.text).toContain("목록에 없는 모델입니다");
    expect(cliOf("정할 수 없음")).toBeUndefined();
    // 모델도 CLI 도 안 주면 부른 총괄의 CLI 다.
    expect((await t.tool(geminiLead, "team_add", { name: "따라가기", role: "시험" })).isError).toBeUndefined();
    expect(cliOf("따라가기")).toBe("gemini");
  });

  test("project_create: chief_cli 'gemini' 로 총괄을 띄우고, 생략하면 본사 AI 의 CLI 를 따른다", async () => {
    const t = setup();
    const hq = await t.orch.ensureConductor("hq");
    expect(hq.cli).toBe("claude");
    const first = join(t.work, "하나"), second = join(t.work, "둘");
    mkdirSync(first); mkdirSync(second);
    expect((await t.tool(hq, "project_create", { name: "제미나이 프로젝트", cwd: first, start_conductor: true, chief_cli: "gemini" })).isError).toBeUndefined();
    const made = t.store.listProjects().find(p => p.name === "제미나이 프로젝트")!;
    expect(t.store.chiefCli(made.id)).toBe("gemini");
    expect(t.store.getConductor(made.id)).toMatchObject({ cli: "gemini", kind: "conductor" });
    expect((await t.tool(hq, "project_create", { name: "거절", cwd: second, chief_cli: "antigravity" })).isError).toBe(true);
    // 본사 AI 가 Gemini 면 생략한 총괄도 Gemini 다.
    const geminiHq = t.store.createMember({ projectId: "hq", name: "제미나이 본사", handle: "gemini-root", kind: "root", cli: "gemini", origin: "runner", backend: "core", status: "idle" });
    expect((await t.tool(geminiHq, "project_create", { name: "따라가는 프로젝트", cwd: second, start_conductor: true })).isError).toBeUndefined();
    const follow = t.store.listProjects().find(p => p.name === "따라가는 프로젝트")!;
    expect(t.store.chiefCli(follow.id)).toBe("gemini");
    expect(t.store.getConductor(follow.id)!.cli).toBe("gemini");
  });
});

describe("Gemini 팀장의 설정 변경·압축·한도", () => {
  test("모델 변경: 말을 걸지 않은 Gemini 팀장(대화 id 가 아직 없다)은 미루지 않고 새 설정으로 다시 띄운다. id 를 안 뒤에는 같은 대화를 이어 연다. 다른 CLI 의 모델은 거절한다", async () => {
    const t = setup();
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    // 방금 만든 Gemini 팀장: agy 는 첫 글을 받을 때 대화를 만든다. 아직 대화 id 가 없고 잃을 대화도 없다.
    expect(gemini).toMatchObject({ sessionId: null, paneId: "t1", status: "idle" });
    const ledger = () => t.db.query("SELECT provider, session_id FROM usage_sessions WHERE member_id = ?").all(gemini.id);
    expect(ledger()).toEqual([]);
    // 미뤄 두면 첫 지시가 옛 설정으로 돌고 재우고 깨우기 전까지 적용되지 않는다. 지금 새 세션으로 다시 띄운다(이어 열 대화가 없다).
    const applied = await t.orch.changeMemberModel(gemini.id, { modelOverride: "gemini-4-argon", effortOverride: "high" });
    expect(applied).toMatchObject({ model: "Gemini 4 Argon", opened: "fresh", usage: false, continued: false });
    expect(t.runner.startsOf(gemini.id)).toHaveLength(2);
    expect(t.runner.stops).toEqual([gemini.id]);
    const relaunched = t.runner.startsOf(gemini.id).at(-1)!;
    expect(relaunched.member).toMatchObject({ cli: "gemini", model: "gemini-4-argon", effort: "high", sessionId: null });
    expect(relaunched.opts.resume).toBe(false);
    expect(t.store.requireMember(gemini.id)).toMatchObject({ modelOverride: "gemini-4-argon", effortOverride: "high", sessionId: null, status: "idle" });
    expect(t.store.getAppliedConfig(gemini.id)).toEqual({ model: "gemini-4-argon", effort: "high", staffModel: null, staffEffort: null });
    expect(t.priv<boolean>("configPending", t.store.requireMember(gemini.id))).toBe(false);
    // 미룬 것이 아니고, 대화가 없었으니 새 세션에 넘길 인계 글도 없다.
    expect(t.store.listActivity(gemini.id, 50).filter(a => a.textCode === "activity.settings_held_session")).toEqual([]);
    expect(t.store.listPending(gemini.id)).toEqual([]);

    // 첫 턴 뒤 실행기가 대화 id 를 알아낸다(session 사건). 사용량 장부의 Gemini 칸은 이 길로 적힌다.
    const conversation = t.runner.learn(gemini.id);
    await until("대화 id", () => t.store.requireMember(gemini.id).sessionId === conversation);
    expect(ledger()).toEqual([{ provider: "gemini", session_id: conversation }]);
    await t.orch.pump(gemini.id);
    await Bun.sleep(50);
    expect(t.runner.startsOf(gemini.id)).toHaveLength(2);

    // id 를 안 뒤의 변경은 같은 대화를 새 설정으로 이어 연다.
    const changed = await t.orch.changeMemberModel(gemini.id, { effortOverride: "low" });
    expect(changed).toMatchObject({ model: "Gemini 4 Argon", opened: "resumed", usage: false, continued: false });
    const reopened = t.runner.startsOf(gemini.id).at(-1)!;
    expect(t.runner.startsOf(gemini.id)).toHaveLength(3);
    expect(reopened.member).toMatchObject({ cli: "gemini", model: "gemini-4-argon", effort: "low", sessionId: conversation });
    expect(reopened.opts.resume).toBe(true);
    expect(reopened.opts.settingsFile).toBeUndefined();
    expect(t.store.requireMember(gemini.id).sessionId).toBe(conversation);
    expect(t.store.getAppliedConfig(gemini.id)).toEqual({ model: "gemini-4-argon", effort: "low", staffModel: null, staffEffort: null });
    // 같은 대화를 이어 열었다: 장부에 새 줄이 생기지 않고, 대화가 바뀌었다는 활동 줄도 없다.
    expect(ledger()).toEqual([{ provider: "gemini", session_id: conversation }]);
    expect(t.store.listActivity(gemini.id, 100).filter(a => a.textCode?.startsWith("activity.gemini_"))).toEqual([]);
    expect(await rejection(t.orch.changeMemberModel(gemini.id, { modelOverride: "opus" }))).toMatchObject({ status: 400, code: "model_unknown" });
    expect(await rejection(t.orch.changeMemberModel(gemini.id, { modelOverride: "gemini-4-argon", effortOverride: "xhigh" }))).toMatchObject({ status: 400, code: "effort_unsupported" });
    expect(t.runner.startsOf(gemini.id)).toHaveLength(3);
  });

  test("대화가 시작됐는데 id 를 아직 모르는 동안의 변경은 미룬다. id 를 알면 보류가 풀려, 다음에 쉴 때 같은 대화를 새 설정으로 이어 연다", async () => {
    const t = setup();
    const gemini = (await t.orch.addMember(t.project.id, { name: "문서 정리", handle: "docs", role: "정리", cli: "gemini" })).member;
    await t.orch.assign(t.project.id, "docs", { text: "문서 정리 시작" });
    await until("지시 전달", () => t.runner.sent.some(sent => sent.memberId === gemini.id));
    expect((await t.tool(gemini, "post", { kind: "완료", title: "문서 정리를 끝냈습니다" })).isError).toBeUndefined();
    t.runner.end(gemini.id);
    await until("쉬는 중", () => t.store.requireMember(gemini.id).status === "idle" && !t.runner.isBusy(gemini.id));
    expect(t.store.requireMember(gemini.id).sessionId).toBeNull();
    const starts = () => t.runner.startsOf(gemini.id).length;
    const before = starts();
    // 지시가 나가 대화가 만들어졌을 수 있다. 이어 열 대화를 가리킬 수 없으니 다시 열지 않고 적어만 둔다(새로 띄우면 그 대화를 잃는다).
    const held = await t.orch.changeMemberModel(gemini.id, { modelOverride: "gemini-4-neon", effortOverride: "xhigh" });
    expect(held).toMatchObject({ opened: "later" });
    expect(starts()).toBe(before);
    expect(t.runner.stops).not.toContain(gemini.id);
    expect(t.store.listActivity(gemini.id, 50).filter(a => a.textCode === "activity.settings_held_session")).toHaveLength(1);
    expect(t.priv<boolean>("configPending", t.store.requireMember(gemini.id))).toBe(false);
    // 실행기가 대화 id 를 알아냈다: 보류가 풀리고, 쉬는 중이니 다음 펌프가 같은 대화를 새 설정으로 이어 연다.
    const conversation = t.runner.learn(gemini.id);
    await until("대화 id", () => t.store.requireMember(gemini.id).sessionId === conversation);
    expect(t.priv<boolean>("configPending", t.store.requireMember(gemini.id))).toBe(true);
    await t.orch.pump(gemini.id);
    await until("다시 열림", () => starts() === before + 1);
    const reopened = t.runner.startsOf(gemini.id).at(-1)!;
    expect(reopened.opts.resume).toBe(true);
    expect(reopened.member).toMatchObject({ model: "gemini-4-neon", effort: "xhigh", sessionId: conversation });
    await until("적용", () => t.store.getAppliedConfig(gemini.id)?.model === "gemini-4-neon");
    expect(t.store.getAppliedConfig(gemini.id)).toEqual({ model: "gemini-4-neon", effort: "xhigh", staffModel: null, staffEffort: null });
    expect(t.priv<boolean>("configPending", t.store.requireMember(gemini.id))).toBe(false);
    // Codex 는 그대로다: id 를 알아도 미뤄 둔 설정은 다음에 띄울 때 들어간다(보류를 풀지 않는다).
    const codex = (await t.orch.addMember(t.project.id, { name: "API 개발", handle: "api", role: "개발", cli: "codex" })).member;
    await t.orch.pump(codex.id);
    if (!t.store.requireMember(codex.id).sessionId) {
      await t.orch.patchMemberConfig(codex.id, { effortOverride: "low" });
      const codexStarts = t.runner.startsOf(codex.id).length;
      t.runner.learn(codex.id);
      await until("codex id", () => !!t.store.requireMember(codex.id).sessionId);
      await t.orch.pump(codex.id);
      await Bun.sleep(50);
      expect(t.runner.startsOf(codex.id)).toHaveLength(codexStarts);
    }
  });

  test("모델을 정하지 않은 Gemini 에는 effort 를 정할 수 없다: 직급표와 팀장 설정이 거절하고, 모델과 함께 주면 그 모델의 값만 받는다", async () => {
    const t = setup();
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    const starts = () => t.runner.startsOf(gemini.id).length;
    // agy 에 --effort 만 넘기면 agy 가 사용자 설정의 기본 모델로 따진다(그 모델이 받지 않는 값이면 시작 전에 끝난다). 서버는 그 모델을 모른다.
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(await rejection(t.orch.updateSettings({ geminiRanks: { lead: { effort } } }))).toMatchObject({ status: 400, code: "effort_unsupported" });
      expect(await rejection(t.orch.updateSettings({ geminiRanks: { manager: { model: null, effort } } }))).toMatchObject({ status: 400, code: "effort_unsupported" });
      expect(await rejection(t.orch.patchMemberConfig(gemini.id, { effortOverride: effort }))).toMatchObject({ status: 400, code: "effort_unsupported" });
      expect(await rejection(t.orch.patchMemberConfig(gemini.id, { modelOverride: null, effortOverride: effort }))).toMatchObject({ status: 400, code: "effort_unsupported" });
    }
    expect(t.store.getSettings().geminiRanks).toEqual(DEFAULT_GEMINI_RANKS);
    expect(t.store.requireMember(gemini.id)).toMatchObject({ modelOverride: null, effortOverride: null });
    expect(starts()).toBe(1);
    // 모델과 함께면 그 모델이 받는 값만.
    expect(await rejection(t.orch.updateSettings({ geminiRanks: { lead: { model: "gemini-4-argon", effort: "xhigh" } } }))).toMatchObject({ code: "effort_unsupported" });
    const saved = await t.orch.updateSettings({ geminiRanks: { lead: { model: "gemini-4-argon", effort: "high" } } });
    expect(saved.geminiRanks.lead).toEqual({ model: "gemini-4-argon", effort: "high" });
    // 말을 걸지 않은 Gemini 팀장은 직급 설정이 바뀌면 미루지 않고 새 설정으로 다시 뜬다(대화가 없어 잃을 것이 없다).
    await until("직급 설정 적용", () => starts() === 2 && t.store.getAppliedConfig(gemini.id)?.model === "gemini-4-argon" && !t.priv<boolean>("configPending", t.store.requireMember(gemini.id)));
    expect(t.runner.startsOf(gemini.id).at(-1)!.member).toMatchObject({ model: "gemini-4-argon", effort: "high", sessionId: null });
    expect(t.runner.startsOf(gemini.id).at(-1)!.opts.resume).toBe(false);
    await until("펌프 끝", () => !(Reflect.get(t.orch, "runtimes") as Map<string, { pumping: unknown; closing: boolean }>).get(gemini.id)?.pumping);
    // 직급 모델이 정해졌으니 팀장의 effort 지정은 그 모델의 값으로 따진다.
    expect(await rejection(t.orch.patchMemberConfig(gemini.id, { effortOverride: "xhigh" }))).toMatchObject({ code: "effort_unsupported" });
    expect((await t.orch.patchMemberConfig(gemini.id, { effortOverride: "low" })).effortOverride).toBe("low");
    // 직급 모델을 다시 비우면(모델만 보냄) 물려받은 직급 effort 도 비우고 알린다.
    const cleared = await t.orch.updateSettings({ geminiRanks: { lead: { model: null } } });
    expect(cleared.geminiRanks.lead).toEqual({ model: null, effort: null });
    expect(cleared.resetEfforts).toEqual(["geminiRanks.lead.effort"]);
    // Claude·Codex 의 규칙은 그대로다: 모델을 정하지 않아도 effort 를 정할 수 있다.
    expect((await t.orch.updateSettings({ ranks: { lead: { effort: "max" } }, codexRanks: { lead: { effort: "minimal" } } })).ranks.lead).toEqual({ model: null, effort: "max" });
    expect(t.store.getSettings().codexRanks.lead).toEqual({ model: null, effort: "minimal" });
    const claude = await t.add("화면 개발", "ui", { cli: "claude" });
    expect((await t.orch.patchMemberConfig(claude.id, { effortOverride: "xhigh" })).effortOverride).toBe("xhigh");
  });

  test("CLI 바꾸기: Claude 팀장을 Gemini 로 바꾸면 새 세션으로 뜨고 Claude 의 모델·effort 지정은 되돌린다. 프로젝트 총괄의 CLI 는 팀장으로는 바뀌지 않는다", async () => {
    const t = setup();
    const claude = await t.add("화면 개발", "ui", { cli: "claude", modelOverride: "opus" });
    // Claude 의 max 는 모델을 정하지 않은 Gemini 가 받지 않는다(agy 의 기본 모델이 무엇인지 서버는 모른다).
    await t.orch.patchMemberConfig(claude.id, { effortOverride: "max" });
    const before = t.store.requireMember(claude.id);
    expect(before).toMatchObject({ modelOverride: "opus", effortOverride: "max" });
    const switched = await t.orch.patchMemberConfig(claude.id, { cli: "gemini" });
    expect(switched).toMatchObject({ cli: "gemini", modelOverride: null, effortOverride: null, sessionId: null });
    expect(switched.resetOverrides).toEqual(["modelOverride", "effortOverride"]);
    const started = t.runner.startsOf(claude.id).at(-1)!;
    // agy 에는 --model 도 --effort 도 넘어가지 않는다.
    expect(started.member).toMatchObject({ cli: "gemini", model: null, effort: null, sessionId: null });
    expect(started.opts).toMatchObject({ resume: false, systemPromptFile: join(geminiRunDir(t.config.home, claude.id), "rules.md") });
    expect(started.opts.settingsFile).toBeUndefined();
    expect(t.store.getAppliedConfig(claude.id)).toEqual({ model: null, effort: null, staffModel: null, staffEffort: null });
    expect(t.store.chiefCli(t.project.id)).toBe("claude");
    const activity = t.store.listActivity(claude.id, 50);
    expect(activity.some(a => a.text.includes("CLI 설정 변경: claude → gemini"))).toBe(true);
    expect(activity.find(a => a.textCode === "activity.overrides_reset")?.text).toContain("modelOverride, effortOverride");
    // Gemini 직급에 모델이 정해져 있으면 그 모델이 받는 effort 지정은 남기고, 받지 않는 것만 되돌린다.
    await t.orch.updateSettings({ geminiRanks: { lead: { model: "gemini-4-neon" } } });
    const kept = await t.add("문서 정리", "docs", { cli: "claude", modelOverride: "sonnet" });
    await t.orch.patchMemberConfig(kept.id, { effortOverride: "xhigh" });
    const keptSwitched = await t.orch.patchMemberConfig(kept.id, { cli: "gemini" });
    expect(keptSwitched).toMatchObject({ cli: "gemini", modelOverride: null, effortOverride: "xhigh" });
    expect(keptSwitched.resetOverrides).toEqual(["modelOverride"]);
    expect(t.runner.startsOf(kept.id).at(-1)!.member).toMatchObject({ cli: "gemini", model: "gemini-4-neon", effort: "xhigh" });
    const dropped = await t.add("번역", "translate", { cli: "claude", modelOverride: "sonnet" });
    await t.orch.patchMemberConfig(dropped.id, { effortOverride: "max" });
    expect(await t.orch.patchMemberConfig(dropped.id, { cli: "gemini" })).toMatchObject({ modelOverride: null, effortOverride: null, resetOverrides: ["modelOverride", "effortOverride"] });
    // 앱이 effort 를 함께 보냈으면 되돌리지 않고 거절한다(무엇을 고를지는 보낸 쪽이 정한다). 아무것도 바뀌지 않는다.
    const explicit = await t.add("검수", "review", { cli: "claude" });
    await t.orch.updateSettings({ geminiRanks: { lead: { model: null } } });
    expect(await rejection(t.orch.patchMemberConfig(explicit.id, { cli: "gemini", modelOverride: null, effortOverride: "max" }))).toMatchObject({ status: 400, code: "effort_unsupported" });
    expect(t.store.requireMember(explicit.id)).toMatchObject({ cli: "claude", sessionId: explicit.sessionId });
    expect(t.runner.startsOf(explicit.id)).toHaveLength(1);
    // 총괄의 CLI 를 바꾸면 그 프로젝트의 총괄 CLI 가 따라 바뀐다(다음에 띄울 때도 Gemini).
    const lead = await t.orch.ensureConductor(t.project.id);
    await t.orch.pump(lead.id);
    await t.orch.patchMemberConfig(lead.id, { cli: "gemini" });
    expect(t.store.chiefCli(t.project.id)).toBe("gemini");
  });

  test("CLI 바꾸기: Gemini → Claude 는 토큰을 바꾸고 Gemini 실행 폴더를 지운다. Codex → Gemini 는 토큰을 바꾸고 그 팀장만의 폴더에 새 토큰으로 쓴다", async () => {
    const t = setup();
    const tokenIn = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { mcpServers: { iamceo: { env: { IAMCEO_TOKEN: string } } } }).mcpServers.iamceo.env.IAMCEO_TOKEN;
    // ---- Gemini → Claude ----
    const gemini = await t.add("자료 조사", "research", { cli: "gemini", modelOverride: "gemini-4-neon" });
    const own = geminiRunDir(t.config.home, gemini.id);
    const geminiToken = t.store.getMemberToken(gemini.id);
    expect(tokenIn(join(own, "mcp.json"))).toBe(geminiToken);
    // 실행기가 그 폴더 안에 만드는 주입 폴더와, 그 옆의 환경 파일(토큰이 든다)을 흉내 낸다.
    mkdirSync(join(own, "agy", gemini.id, ".agents"), { recursive: true });
    writeFileSync(join(own, "agy", `${gemini.id}.env`), `IAMCEO_TOKEN='${geminiToken}'\n`, { mode: 0o600 });
    const conversation = t.runner.learn(gemini.id);
    await until("대화 id", () => t.store.requireMember(gemini.id).sessionId === conversation);
    const toClaude = await t.orch.patchMemberConfig(gemini.id, { cli: "claude" });
    // Gemini 의 모델 이름은 Claude 목록에 없어 되돌린다. Gemini 대화는 Claude 로 이어 열 수 없어 새 세션이다.
    expect(toClaude).toMatchObject({ cli: "claude", modelOverride: null, status: "idle" });
    expect(toClaude.resetOverrides).toEqual(["modelOverride"]);
    expect(toClaude.sessionId).not.toBe(conversation);
    expect(t.runner.stops).toEqual([gemini.id]);
    const claudeStart = t.runner.startsOf(gemini.id).at(-1)!;
    expect(claudeStart.member).toMatchObject({ cli: "claude", model: null, sessionId: null });
    expect(claudeStart.opts).toMatchObject({ resume: false, systemPromptFile: join(t.runDir, `${gemini.id}.rules.md`), mcpConfigFile: join(t.runDir, `${gemini.id}.mcp.json`), settingsFile: join(t.runDir, `${gemini.id}.settings.json`) });
    // 토큰이 바뀌었다: 옛 토큰으로는 이 팀장이 아니고, 새 CLI 의 MCP 설정에는 새 토큰이 있다.
    const claudeToken = t.store.getMemberToken(gemini.id);
    expect(claudeToken).not.toBe(geminiToken);
    expect(t.store.getMemberByToken(geminiToken)).toBeNull();
    expect(t.store.getMemberByToken(claudeToken)?.id).toBe(gemini.id);
    expect(tokenIn(join(t.runDir, `${gemini.id}.mcp.json`))).toBe(claudeToken);
    // 옛 Gemini 실행 폴더(규칙·MCP 설정·주입 폴더·환경 파일)는 남지 않는다.
    expect(existsSync(own)).toBe(false);
    expect(readdirSync(t.runDir).filter(name => name.startsWith(`${gemini.id}.`)).sort()).toEqual([`${gemini.id}.mcp.json`, `${gemini.id}.rules.md`, `${gemini.id}.settings.json`]);
    expect(t.store.listActivity(gemini.id, 50).some(a => a.text.includes("CLI 설정 변경: gemini → claude"))).toBe(true);
    // 사용량 장부: 앞 Gemini 대화의 줄은 남고, 새 Claude 세션이 Claude 칸으로 적힌다.
    expect(t.db.query("SELECT provider, session_id FROM usage_sessions WHERE member_id = ? ORDER BY provider").all(gemini.id)).toEqual([{ provider: "claude", session_id: toClaude.sessionId }, { provider: "gemini", session_id: conversation }]);
    // 같은 CLI 안의 설정 변경(Gemini → Gemini)은 폴더를 지우지 않는다(그 폴더를 그대로 고쳐 쓴다).
    const stays = await t.add("문서 정리", "docs", { cli: "gemini" });
    const staysConversation = t.runner.learn(stays.id);
    await until("대화 id", () => t.store.requireMember(stays.id).sessionId === staysConversation);
    await t.orch.patchMemberConfig(stays.id, { modelOverride: "gemini-4-argon" });
    expect(tokenIn(join(geminiRunDir(t.config.home, stays.id), "mcp.json"))).toBe(t.store.getMemberToken(stays.id));

    // ---- Codex → Gemini ----
    const codex = await t.add("서버 개발", "api", { cli: "codex", modelOverride: "gpt-6.1-sol" });
    await t.orch.patchMemberConfig(codex.id, { effortOverride: "minimal" });
    const codexBefore = t.store.requireMember(codex.id);
    const codexToken = t.store.getMemberToken(codex.id);
    const toGemini = await t.orch.patchMemberConfig(codex.id, { cli: "gemini" });
    // Codex 의 모델 이름과 minimal 은 Gemini 의 것이 아니다. 대화 id 는 agy 가 정하므로 아직 없다.
    expect(toGemini).toMatchObject({ cli: "gemini", modelOverride: null, effortOverride: null, sessionId: null, status: "idle" });
    expect(toGemini.resetOverrides).toEqual(["modelOverride", "effortOverride"]);
    const geminiStart = t.runner.startsOf(codex.id).at(-1)!;
    const codexOwn = geminiRunDir(t.config.home, codex.id);
    expect(geminiStart.member).toMatchObject({ cli: "gemini", model: null, effort: null, sessionId: null });
    expect(geminiStart.opts).toMatchObject({ resume: false, systemPromptFile: join(codexOwn, "rules.md"), mcpConfigFile: join(codexOwn, "mcp.json") });
    expect(geminiStart.opts.settingsFile).toBeUndefined();
    const newToken = t.store.getMemberToken(codex.id);
    expect(newToken).not.toBe(codexToken);
    expect(t.store.getMemberByToken(codexToken)).toBeNull();
    expect(tokenIn(join(codexOwn, "mcp.json"))).toBe(newToken);
    expect(statSync(codexOwn).mode & 0o777).toBe(0o700);
    // 새 Gemini 세션의 장부 줄은 대화 id 를 알아낸 때 적힌다. Codex 세션의 줄은 그대로 남는다.
    const rows = () => t.db.query("SELECT provider, session_id FROM usage_sessions WHERE member_id = ? ORDER BY provider").all(codex.id);
    expect(rows()).toEqual([{ provider: "codex", session_id: codexBefore.sessionId }]);
    const fresh = t.runner.learn(codex.id);
    await until("새 대화 id", () => t.store.requireMember(codex.id).sessionId === fresh);
    expect(rows()).toEqual([{ provider: "codex", session_id: codexBefore.sessionId }, { provider: "gemini", session_id: fresh }]);
    // 새로 알아낸 id 는 '대화가 바뀐 것'이 아니다.
    expect(t.store.listActivity(codex.id, 100).filter(a => a.textCode?.startsWith("activity.gemini_"))).toEqual([]);
  });

  test("CLI 바꾸기: Gemini 로 바꾸려다 그만두면(옛 세션을 끝내지 못함) 미리 써 둔 Gemini 실행 폴더를 남기지 않는다", async () => {
    const t = setup();
    const codex = await t.add("서버 개발", "api", { cli: "codex" });
    const own = geminiRunDir(t.config.home, codex.id);
    const token = t.store.getMemberToken(codex.id);
    // 운영에서는 미리 해 보는 검사(providerLaunch)가 지금도 쓰이는 토큰으로 이 폴더를 쓴다. 그 결과를 흉내 낸다.
    mkdirSync(join(own, "agy", codex.id, ".agents"), { recursive: true });
    writeFileSync(join(own, "mcp.json"), JSON.stringify({ mcpServers: { iamceo: { env: { IAMCEO_TOKEN: token } } } }), { mode: 0o600 });
    // 입력칸에 쓰던 글이 있어 옛 세션을 끝내지 못한다.
    t.runner.refuseStop.add(codex.id);
    expect(await rejection(t.orch.patchMemberConfig(codex.id, { cli: "gemini" }))).toMatchObject({ status: 409, code: "close_draft_present" });
    expect(t.store.requireMember(codex.id)).toMatchObject({ cli: "codex", sessionId: codex.sessionId, paneId: codex.paneId });
    expect(t.store.getMemberToken(codex.id)).toBe(token);
    expect(t.runner.startsOf(codex.id)).toHaveLength(1);
    expect(existsSync(own)).toBe(false);
    // Gemini 팀장의 같은 CLI 안 변경이 실패한 것은 그 폴더를 지우지 않는다(떠 있는 세션이 쓰고 있다).
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    const conversation = t.runner.learn(gemini.id);
    await until("대화 id", () => t.store.requireMember(gemini.id).sessionId === conversation);
    t.runner.refuseStop.add(gemini.id);
    expect(await rejection(t.orch.patchMemberConfig(gemini.id, { modelOverride: "gemini-4-argon" }))).toMatchObject({ status: 409, code: "close_draft_present" });
    expect(existsSync(join(geminiRunDir(t.config.home, gemini.id), "mcp.json"))).toBe(true);
    // Gemini 에서 다른 CLI 로 바꾸려다 그만둔 것도 그대로 둔다(아직 Gemini 팀장이다).
    expect(await rejection(t.orch.patchMemberConfig(gemini.id, { cli: "claude", modelOverride: null }))).toMatchObject({ status: 409, code: "close_draft_present" });
    expect(t.store.requireMember(gemini.id).cli).toBe("gemini");
    expect(existsSync(join(geminiRunDir(t.config.home, gemini.id), "mcp.json"))).toBe(true);
  });

  test("압축: Gemini 팀장도 화면·총괄 도구(team_compact) 모두 받아 실행기에 넘긴다. 대화 id 를 모르면 지금처럼 409 session_id_unknown", async () => {
    const t = setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    // 말을 건 적이 없어 대화 id 가 없다: 압축할 대화가 없다.
    const early = await t.orch.compactMember(gemini.id).then(() => null, (e: unknown) => e);
    expect(early).toMatchObject({ status: 409, code: "session_id_unknown" });
    const conversation = t.runner.learn(gemini.id);
    await until("대화 id", () => t.store.requireMember(gemini.id).sessionId === conversation);
    await t.orch.compactMember(gemini.id);
    await until("화면 압축", () => t.runner.compacts.includes(gemini.id));
    expect(t.store.getContextState(gemini.id)?.compaction).toMatchObject({ trigger: "manual" });
    // 앞 압축이 끝난 뒤(실행기가 끝을 알린 것으로 친다) 총괄 도구로 다시.
    const state = t.store.ensureContextState(gemini.id);
    t.store.saveContextState({ ...state, compaction: { ...state.compaction!, phase: "succeeded", finishedAt: new Date().toISOString() } });
    t.runner.emit({ type: "compacted", memberId: gemini.id, runId: state.compaction!.id });
    const viaTool = await t.tool(lead, "team_compact", { member: "research" });
    expect(viaTool.isError).toBeFalsy();
    await until("도구 압축", () => t.runner.compacts.filter(id => id === gemini.id).length === 2);
  });

  test("첫 설정·로그인 막힘: 실행기의 막힘 사건으로 들어오면 '터미널에서 직접 끝내 달라'고 알리고, 기다리던 지시는 넣지 않은 채 둔다", async () => {
    const notices: { title: string; body: string }[] = [];
    const t = setup({ notifier: (title, body) => { notices.push({ title, body }); }, timings: { blockedNoticeMs: 30 } });
    t.store.patchSettings({ notifyMac: true });
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    notices.length = 0;
    const observed = (error: { code: string; note: string } | null) => ({ source: "core" as const, observedAt: new Date().toISOString(), freshness: "fresh" as const, ownership: "verified" as const, consecutiveFailures: 0, error });
    // 실행기가 agy 의 상태 보고(blocked · "Finish setup")를 읽어 알린다: 막힘의 까닭은 setup, 관측 코드는 gemini_setup 이다.
    t.runner.emit({ type: "status", memberId: gemini.id, status: "blocked", blockedReason: "setup", observation: observed({ code: "gemini_setup", note: ERROR_CODES.observation_gemini_setup.ko }) });
    await until("막힘 반영", () => t.store.requireMember(gemini.id).status === "blocked");
    const blocked = t.store.requireMember(gemini.id);
    // 막힘의 까닭이 앱까지 간다(앱은 이 값으로 '터미널 열어 직접 끝내기'를 보인다).
    expect(blocked).toMatchObject({ status: "blocked", blockedReason: "setup", blockedCode: "gemini_setup" });
    expect(t.store.projectState(t.project.id).members.find(m => m.id === gemini.id)?.blockedCode).toBe("gemini_setup");
    // 막힘이 이어지면 알린다. 승인 대기 문구가 아니다.
    await until("알림", () => notices.length > 0);
    expect(notices).toEqual([{ title: "IAMCEO · 자료 조사 확인 필요", body: "Antigravity CLI의 로그인·첫 설정이 끝나지 않았습니다. 터미널을 열어 직접 끝내 주세요" }]);
    // 같은 막힘의 관측이 다시 와도 또 알리지 않는다.
    t.runner.emit({ type: "status", memberId: gemini.id, status: "blocked", blockedReason: "setup", observation: observed({ code: "gemini_setup", note: ERROR_CODES.observation_gemini_setup.ko }) });
    await Bun.sleep(80);
    expect(notices).toHaveLength(1);

    // 그 사이 온 지시는 그 화면에 넣지 않는다: 보류(막힘)로 줄에 남는다.
    await t.orch.assign(t.project.id, "research", { text: "첫 자료 찾기" });
    await t.orch.pump(gemini.id);
    await Bun.sleep(80);
    expect(t.runner.sent.filter(sent => sent.memberId === gemini.id)).toEqual([]);
    const waiting = t.store.listPending(gemini.id).filter(d => d.kind === "instruction");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ status: "held", holdReason: "blocked", attempts: 0 });
    expect(t.runner.stops).toEqual([]);
    expect(t.runner.startsOf(gemini.id)).toHaveLength(1);

    // 대표가 터미널에서 첫 설정을 끝내면(쉬는 중 보고) 막힘이 풀리고 기다리던 지시가 들어간다.
    t.runner.emit({ type: "status", memberId: gemini.id, status: "idle", blockedReason: null, observation: observed(null) });
    await until("지시 전달", () => t.runner.sent.some(sent => sent.memberId === gemini.id && sent.text.includes("첫 자료 찾기")));
    expect(t.store.requireMember(gemini.id).blockedCode).toBeUndefined();
    expect(notices).toHaveLength(1);
  });

  test("재우기 → 깨우기: 말을 걸지 않은 Gemini 팀장은 새 세션으로 뜬다(이어 열 대화가 없다). 대화 id 를 아는 팀장은 그 대화를 이어 연다", async () => {
    const t = setup();
    const fresh = await t.add("자료 조사", "research", { cli: "gemini" });
    const spoken = await t.add("문서 정리", "docs", { cli: "gemini" });
    const conversation = t.runner.learn(spoken.id);
    await until("대화 id", () => t.store.requireMember(spoken.id).sessionId === conversation);
    expect((await t.orch.sleepMember(fresh.id))).toMatchObject({ status: "asleep", sessionId: null, paneId: null });
    expect((await t.orch.sleepMember(spoken.id))).toMatchObject({ status: "asleep", sessionId: conversation, paneId: null });
    expect(t.runner.stops).toEqual([fresh.id, spoken.id]);

    // 대화가 없던 팀장: 이어 열기(--conversation)를 시키지 않는다. 새 세션이고, '이전 세션을 찾지 못했다'는 글도 넣지 않는다(잃은 대화가 없다).
    const woken = await t.orch.resumeMember(fresh.id);
    expect(woken).toMatchObject({ status: "idle", sessionId: null, lastError: null });
    expect(woken.paneId).not.toBe(fresh.paneId);
    const again = t.runner.startsOf(fresh.id);
    expect(again).toHaveLength(2);
    expect(again[1]!.opts.resume).toBe(false);
    expect(again[1]!.member.sessionId).toBeNull();
    expect(t.store.listPending(fresh.id)).toEqual([]);
    expect(t.store.listActivity(fresh.id, 100).filter(a => a.textCode?.startsWith("activity.gemini_"))).toEqual([]);
    // 지시를 실어 깨워도 같다: 새 세션에 그 지시가 들어간다.
    await t.orch.sleepMember(fresh.id);
    await t.orch.resumeMember(fresh.id, "첫 자료 찾기");
    await until("지시 전달", () => t.runner.sent.some(sent => sent.memberId === fresh.id && sent.text.includes("첫 자료 찾기")));
    expect(t.runner.startsOf(fresh.id).at(-1)!.opts.resume).toBe(false);

    // 대화 id 를 아는 팀장: 같은 대화를 이어 연다.
    expect(await t.orch.resumeMember(spoken.id)).toMatchObject({ status: "idle", sessionId: conversation });
    expect(t.runner.startsOf(spoken.id).at(-1)).toMatchObject({ opts: { resume: true }, member: { sessionId: conversation } });
  });

  test("보관: 한 번도 말을 걸지 않은 깨어 있는 Gemini 총괄·팀장은 보관을 막지 않는다. 지시가 나갔는데 대화 id 를 모르면 지금처럼 막는다", async () => {
    const t = setup();
    // 총괄만 띄운 Gemini 프로젝트(+ 첫 지시 없이 더한 팀장): 대화 id 가 영영 없다. 기다려도 생기지 않는다.
    const made = await t.orch.createProject({ name: "보관할 팀", cwd: t.work, chiefCli: "gemini", startConductor: true });
    const lead = t.store.getConductor(made.id)!;
    const worker = (await t.orch.addMember(made.id, { name: "자료 조사", handle: "research", role: "조사" })).member;
    expect([lead, t.store.requireMember(worker.id)].map(m => [m.cli, m.sessionId, m.status])).toEqual([["gemini", null, "idle"], ["gemini", null, "idle"]]);
    expect((await t.orch.patchProject(made.id, { archived: true })).archived).toBe(true);
    expect(t.store.listMembers(made.id).map(m => [m.status, m.paneId, m.sessionId])).toEqual([["asleep", null, null], ["asleep", null, null]]);
    expect(t.runner.stops.sort()).toEqual([lead.id, worker.id].sort());
    // 꺼내서 깨우면 새 세션으로 열린다.
    await t.orch.patchProject(made.id, { archived: false });
    expect(await t.orch.resumeMember(lead.id)).toMatchObject({ status: "idle", sessionId: null });
    expect(t.runner.startsOf(lead.id).at(-1)!.opts.resume).toBe(false);

    // 지시가 나간 팀장: agy 가 대화를 만들었을 수 있는데 서버는 아직 그 id 를 모른다. 잃을 수 있는 대화가 있으니 막는다.
    const other = await t.orch.createProject({ name: "일하던 팀", cwd: t.work });
    const busy = (await t.orch.addMember(other.id, { name: "문서 정리", handle: "docs", role: "정리", cli: "gemini" })).member;
    await t.orch.assign(other.id, "docs", { text: "문서 정리 시작" });
    await until("지시 전달", () => t.runner.sent.some(sent => sent.memberId === busy.id));
    // 보고하고 턴을 끝낸다(쉬는 중). 대화 id 는 아직 오지 않았다.
    expect((await t.tool(busy, "post", { kind: "완료", title: "문서 정리를 끝냈습니다" })).isError).toBeUndefined();
    t.runner.end(busy.id);
    await until("쉬는 중", () => t.store.requireMember(busy.id).status === "idle" && !t.runner.isBusy(busy.id));
    expect(t.store.requireMember(busy.id).sessionId).toBeNull();
    const refused = await t.orch.patchProject(other.id, { archived: true }).then(() => null, (e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, code: "archive_stop_failed" });
    // '확인하는 중'(기다리면 풀릴 것 같은 글)이 아니라 할 일을 알린다: 먼저 재운 뒤 보관한다.
    expect((refused as ApiError).message).toContain("Gemini 세션의 대화 ID를 아직 알지 못했습니다. 그 세션을 먼저 재운 뒤 보관하세요");
    expect(t.store.requireProject(other.id).archived).toBe(false);
    expect(t.store.requireMember(busy.id).status).toBe("idle");
    expect(t.runner.stops).not.toContain(busy.id);
    // 대화 id 를 알아내면 보관된다.
    const conversation = t.runner.learn(busy.id);
    await until("대화 id", () => t.store.requireMember(busy.id).sessionId === conversation);
    expect((await t.orch.patchProject(other.id, { archived: true })).archived).toBe(true);
    expect(t.store.requireMember(busy.id)).toMatchObject({ status: "asleep", sessionId: conversation });

    // Claude·Codex 는 예전 그대로다: 세션 id 를 모르는 Codex 팀장은 말을 걸지 않았어도 막는다(이 규칙은 Gemini 에만 더했다).
    const third = await t.orch.createProject({ name: "코덱스 팀", cwd: t.work });
    const codex = (await t.orch.addMember(third.id, { name: "서버 개발", handle: "api", role: "개발", cli: "codex" })).member;
    t.store.patchMember(codex.id, { sessionId: null });
    expect(await rejection(t.orch.patchProject(third.id, { archived: true }))).toMatchObject({ status: 409, code: "archive_stop_failed" });
  });

  test("이어 연 Gemini 대화가 새 대화로 바뀌면 활동에 남기고, 그 대화를 이어 띄운 것이었으면 팀장에게 마지막 일을 알린다", async () => {
    const t = setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    const lines = (code: string) => t.store.listActivity(gemini.id, 200).filter(a => a.textCode === code);
    const notes = () => t.store.listPending(gemini.id).filter(d => d.text.includes("이전 세션을 찾지 못해 새 세션으로 시작합니다"));
    const ledger = () => t.db.query("SELECT session_id FROM usage_sessions WHERE member_id = ? AND provider = 'gemini'").all(gemini.id);
    const first = t.runner.learn(gemini.id);
    await until("첫 대화 id", () => t.store.requireMember(gemini.id).sessionId === first);
    // 처음 알아낸 id 는 바뀐 것이 아니다.
    expect([lines("activity.gemini_resume_lost"), lines("activity.gemini_conversation_changed"), notes()]).toEqual([[], [], []]);
    t.store.patchMember(gemini.id, { now: "보고서 3장 쓰는 중", next: "4장 자료 모으기", contextPct: 42 });

    // 재웠다 깨운다: 서버는 그 대화를 --conversation 으로 이어 띄웠고, 띄운 결과에는 넘긴 id 가 그대로 실려 온다.
    await t.orch.sleepMember(gemini.id);
    expect(await t.orch.resumeMember(gemini.id)).toMatchObject({ status: "idle", sessionId: first });
    expect(t.runner.startsOf(gemini.id).at(-1)).toMatchObject({ opts: { resume: true }, member: { sessionId: first } });
    // agy 는 그 대화를 열지 못하면 오류 없이 새 대화를 연다. 실행기가 첫 턴 뒤 새 id 를 알린다.
    const second = t.runner.learn(gemini.id);
    await until("바뀐 대화 id", () => t.store.requireMember(gemini.id).sessionId === second);
    expect(lines("activity.gemini_resume_lost").map(a => [a.kind, a.text])).toEqual([["system", "이전 대화를 이어 열지 못해 새 대화로 열렸습니다. 앞 대화의 맥락은 없습니다"]]);
    expect(lines("activity.gemini_conversation_changed")).toEqual([]);
    // 세션 기록이 없어 새 세션으로 연 때와 같은 글이 팀장의 줄에 선다(깨우지 않는 글: 다음 전달과 함께 들어간다).
    expect(notes().map(d => [d.kind, d.wake, d.text])).toEqual([["system", false, "[시스템] 이전 세션을 찾지 못해 새 세션으로 시작합니다. 마지막 일 — 지금 일: 보고서 3장 쓰는 중 · 다음: 4장 자료 모으기"]]);
    // 앞 대화의 문맥 % 는 새 대화의 것이 아니다.
    expect(t.store.requireMember(gemini.id).contextPct).toBeNull();
    // 끊긴 실행이 없었으니 총괄에게 알릴 중단은 없다.
    expect(t.store.listPending(lead.id).filter(d => d.text.includes("중단"))).toEqual([]);
    expect(t.store.listMessages(t.project.id, { limit: 100 }).filter(m => m.textCode === "chat.run_interrupted")).toEqual([]);
    // 바뀐 id 는 사용량을 '0 부터'로 적지 않는다(앞 대화의 누적값이 한 번 더 들어가지 않게).
    expect(ledger()).toEqual([{ session_id: first }]);

    // 떠 있는 터미널에서 대화가 또 바뀐다(대표가 터미널에서 새 대화를 열었다): 이어 띄운 것이 아니라 활동 한 줄뿐이다.
    const third = t.runner.learn(gemini.id);
    await until("또 바뀐 대화 id", () => t.store.requireMember(gemini.id).sessionId === third);
    expect(lines("activity.gemini_conversation_changed").map(a => a.text)).toEqual(["대화가 새로 열렸습니다. 앞 대화의 맥락은 이어지지 않습니다"]);
    expect(lines("activity.gemini_resume_lost")).toHaveLength(1);
    expect(notes()).toHaveLength(1);
    // 같은 id 가 다시 와도 아무 일도 없다.
    t.runner.learn(gemini.id, third);
    await Bun.sleep(50);
    expect(lines("activity.gemini_conversation_changed")).toHaveLength(1);

    // 설정 변경으로 이어 연 것도 같다: '같은 세션을 새 설정으로 이어 열었습니다'로 처리한 뒤 새 대화였던 것이 드러난다.
    expect((await t.orch.changeMemberModel(gemini.id, { modelOverride: "gemini-4-argon" })).opened).toBe("resumed");
    const fourth = t.runner.learn(gemini.id);
    await until("설정 변경 뒤 바뀐 id", () => t.store.requireMember(gemini.id).sessionId === fourth);
    expect(lines("activity.gemini_resume_lost")).toHaveLength(2);
    // Claude·Codex 팀장의 세션 id 가 바뀌는 것은 예전 그대로다(이 줄들은 Gemini 에만 있다).
    const codex = await t.add("서버 개발", "api", { cli: "codex" });
    t.runner.learn(codex.id, "codex-rebound-session");
    await until("Codex 세션 id", () => t.store.requireMember(codex.id).sessionId === "codex-rebound-session");
    expect(t.store.listActivity(codex.id, 100).filter(a => a.textCode?.startsWith("activity.gemini_"))).toEqual([]);
    expect(t.store.listPending(codex.id)).toEqual([]);
  });

  test("이어 띄운 뒤 첫 턴이 같은 대화 id 로 끝나면 이어 열린 것이다: 그 뒤에 대화가 바뀌는 것은 '이어 열지 못함'으로 알리지 않는다", async () => {
    const t = setup();
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    const lines = (code: string) => t.store.listActivity(gemini.id, 200).filter(a => a.textCode === code);
    const notes = () => t.store.listDeliveries(t.project.id).filter(d => d.memberId === gemini.id && d.text.includes("이전 세션을 찾지 못해 새 세션으로 시작합니다"));
    const first = t.runner.learn(gemini.id);
    await until("첫 대화 id", () => t.store.requireMember(gemini.id).sessionId === first);
    await t.orch.sleepMember(gemini.id);
    await t.orch.resumeMember(gemini.id, "이어서 정리");
    await until("지시 전달", () => t.runner.sent.some(sent => sent.memberId === gemini.id && sent.text.includes("이어서 정리")));
    expect(t.runner.startsOf(gemini.id).at(-1)).toMatchObject({ opts: { resume: true }, member: { sessionId: first } });
    // 그 대화에서 턴이 돌고 끝났다. 대화 id 는 그대로다: 이어 열린 것이 확인됐다.
    expect((await t.tool(gemini, "post", { kind: "완료", title: "이어서 정리를 끝냈습니다" })).isError).toBeUndefined();
    t.runner.end(gemini.id);
    await until("쉬는 중", () => t.store.requireMember(gemini.id).status === "idle" && !t.runner.isBusy(gemini.id));
    expect(t.store.requireMember(gemini.id).sessionId).toBe(first);
    // 한참 뒤 대표가 터미널에서 새 대화를 열었다: 대화가 바뀌었다는 줄만 남는다.
    const second = t.runner.learn(gemini.id);
    await until("바뀐 대화 id", () => t.store.requireMember(gemini.id).sessionId === second);
    expect(lines("activity.gemini_conversation_changed")).toHaveLength(1);
    expect(lines("activity.gemini_resume_lost")).toEqual([]);
    expect(notes()).toEqual([]);
  });

  test("이어 띄운 결과에 이미 다른 대화 id 가 실려 오면(실행기가 붙는 사이에 알아냄) 새 세션으로 연 것으로 다룬다", async () => {
    const t = setup();
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    const lines = (code: string) => t.store.listActivity(gemini.id, 200).filter(a => a.textCode === code);
    const notes = () => t.store.listPending(gemini.id).filter(d => d.text.includes("이전 세션을 찾지 못해 새 세션으로 시작합니다"));
    const first = t.runner.learn(gemini.id);
    await until("첫 대화 id", () => t.store.requireMember(gemini.id).sessionId === first);
    t.store.patchMember(gemini.id, { now: "표 정리", contextPct: 55 });
    // 깨우기: --conversation <first> 로 띄웠는데 실행기가 돌려준 id 가 다르다.
    await t.orch.sleepMember(gemini.id);
    t.runner.replacedAtLaunch.set(gemini.id, "conv-opened-instead");
    expect(await t.orch.resumeMember(gemini.id)).toMatchObject({ status: "idle", sessionId: "conv-opened-instead", contextPct: null });
    expect(t.runner.startsOf(gemini.id).at(-1)).toMatchObject({ opts: { resume: true }, member: { sessionId: first } });
    expect(lines("activity.gemini_resume_lost")).toHaveLength(1);
    expect(notes().map(d => d.text)).toEqual(["[시스템] 이전 세션을 찾지 못해 새 세션으로 시작합니다. 마지막 일 — 지금 일: 표 정리"]);
    // 뒤따라 같은 id 의 session 사건이 와도 두 번 알리지 않는다.
    t.runner.learn(gemini.id, "conv-opened-instead");
    await Bun.sleep(50);
    expect(lines("activity.gemini_resume_lost")).toHaveLength(1);
    expect(lines("activity.gemini_conversation_changed")).toEqual([]);
    expect(notes()).toHaveLength(1);
    // 설정 변경으로 이어 띄운 것도 같다: 같은 세션을 이어 열었다고 답하지 않는다.
    t.runner.replacedAtLaunch.set(gemini.id, "conv-after-model-change");
    const changed = await t.orch.changeMemberModel(gemini.id, { modelOverride: "gemini-4-argon" });
    expect(changed.opened).toBe("fresh");
    expect(changed.member.sessionId).toBe("conv-after-model-change");
    expect(lines("activity.gemini_resume_lost")).toHaveLength(2);
    // 이어 띄운 결과가 넘긴 id 그대로면 아무 일도 없다.
    t.runner.replacedAtLaunch.delete(gemini.id);
    expect((await t.orch.changeMemberModel(gemini.id, { modelOverride: "gemini-4-neon" })).opened).toBe("resumed");
    expect(lines("activity.gemini_resume_lost")).toHaveLength(2);
  });

  test("자동 압축: Gemini 팀장도 정확한 측정이 기준을 넘으면 압축부터 한다(Claude 와 같다). 자동 압축 뒤 첫 측정도 기준 이상이면 그 세션에서는 더 하지 않는다", async () => {
    const t = setup();
    const created = await t.add("자료 조사", "research", { cli: "gemini" });
    const claude = await t.add("화면 개발", "ui", { cli: "claude" });
    // 문맥 측정은 턴이 돈 뒤의 것이다: Gemini 팀장도 대화 id 를 알아낸 뒤다.
    const conversation = t.runner.learn(created.id);
    await until("대화 id", () => t.store.requireMember(created.id).sessionId === conversation);
    const gemini = t.store.requireMember(created.id);
    // 둘 다 문맥 90%(기준 70%)이고, 방금 끝난 턴의 정확한 측정이 있다(자동 압축이 걸리는 조건).
    const overLimit = (m: Member) => {
      const state = t.store.ensureContextState(m.id);
      const revisions = t.store.memberRevisions(m.id);
      t.store.saveContextState({ ...state,
        measurement: { sessionId: m.sessionId!, sessionGeneration: revisions.sessionGeneration, turn: 3, model: null, tokens: 900_000, window: 1_000_000, source: "default", quality: "exact", measuredAt: new Date().toISOString(), fresh: true },
        baseline: { ...state.baseline, completedTurn: 3, configRevision: revisions.configRevision } }, { contextPct: 90 });
    };
    overLimit(gemini); overLimit(claude);
    expect(t.store.requireMember(gemini.id).contextPct).toBe(90);
    await t.orch.assign(t.project.id, "ui", { text: "다음 화면 만들기" });
    await until("Claude 팀장 압축", () => t.runner.compacts.includes(claude.id));
    expect(t.store.getContextState(claude.id)?.compaction).toMatchObject({ trigger: "auto" });
    expect(t.runner.sent.filter(s => s.memberId === claude.id)).toEqual([]);
    await t.orch.assign(t.project.id, "research", { text: "다음 자료 찾기" });
    await until("Gemini 팀장 압축", () => t.runner.compacts.includes(gemini.id));
    const auto = t.store.getContextState(gemini.id)!.compaction!;
    expect(auto).toMatchObject({ trigger: "auto" });
    expect(t.runner.sent.filter(s => s.memberId === gemini.id)).toEqual([]);
    // 실행기가 압축 끝을 알렸다(대화 기록의 CHECKPOINT). 기다리던 전달이 나간다.
    const done = t.store.ensureContextState(gemini.id);
    t.store.saveContextState({ ...done, measurement: null, compaction: { ...done.compaction!, phase: "succeeded", finishedAt: new Date().toISOString() } });
    t.runner.emit({ type: "compacted", memberId: gemini.id, runId: auto.id });
    await until("압축 뒤 전달", () => t.runner.sent.some(s => s.memberId === gemini.id && s.text.includes("다음 자료 찾기")));
    // 압축 뒤 첫 측정이 여전히 기준(70%) 이상: 이 세션에서는 자동 압축을 더 하지 않는다(활동 한 줄).
    const member = t.store.requireMember(gemini.id);
    t.runner.end(gemini.id);
    t.runner.emit({ type: "context_usage", memberId: gemini.id, sessionId: member.sessionId!, tokens: 850_000, shownPct: null, model: "gemini-4-neon", exact: { window: 1_000_000, source: "statusline" },
      turn: 5, sessionGeneration: t.store.memberRevisions(gemini.id).sessionGeneration, terminalId: member.paneId, observedAt: new Date().toISOString() });
    await until("자동 압축 끔", () => t.store.listActivity(gemini.id, 100).some(a => a.textCode === "activity.gemini_auto_compact_off"));
    expect(t.store.getContextState(gemini.id)?.baseline?.geminiAutoOff).toBe(t.store.memberRevisions(gemini.id).sessionGeneration);
    overLimit(t.store.requireMember(gemini.id));
    await t.orch.assign(t.project.id, "research", { text: "그다음 자료" });
    // 앞 턴(보고 보완 요청 포함)을 끝내 가며 기다린다.
    await until("다음 전달", () => { if (t.runner.isBusy(gemini.id)) t.runner.end(gemini.id); return t.runner.sent.some(s => s.memberId === gemini.id && s.text.includes("그다음 자료")); });
    expect(t.runner.compacts.filter(id => id === gemini.id)).toHaveLength(1);
  });

  test("턴 오류: Gemini 는 agy 의 오류 글로 한도·장애·인증을 가른다. 한도는 보류 + 'Gemini' 카드(초기화 시각은 상태줄의 다 쓴 묶음), 장애는 탐침 영향, 인증은 일반 오류", async () => {
    const probes: string[] = [];
    const t = setup({ apiRecovery: { probe: async url => { probes.push(url); throw new Error("offline"); }, intervalMs: 1 } });
    const failTurn = async (handle: string, memberId: string, errorText: string) => {
      await t.orch.assign(t.project.id, handle, { text: `${handle} 일` });
      await until(`${handle} 전달`, () => t.runner.sent.some(s => s.memberId === memberId));
      t.runner.fail(memberId, errorText);
    };
    // 실제 agy 처럼 상태줄 기록에 지금 모델을 싣는다(모델을 정하지 않은 팀장은 이것으로 한도 묶음의 갈래를 안다. 모르면 초기화 시각을 정하지 않는다).
    const status = (memberId: string, quota: Record<string, unknown>) => {
      mkdirSync(join(t.config.home, "context", "gemini"), { recursive: true });
      writeFileSync(geminiStatusPath(t.config.home, memberId), JSON.stringify(geminiStatusFromPayload(memberId, { conversation_id: "", model: { id: "gemini-3.8-flash-low" }, quota }, new Date())));
    };
    const quota = "You have exhausted your quota on this model.";
    const network = 'There was a network issue connecting to the server, please try again. · generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": unexpected EOF';
    const transient = "RESOURCE_EXHAUSTED: Error 429 rate limit";
    const auth = "Verification required. Please complete verification in your browser to continue.";
    const limited = await t.add("자료 조사", "research", { cli: "gemini" });
    const offline = await t.add("문서 정리", "docs", { cli: "gemini" });
    const busy = await t.add("번역", "translate", { cli: "gemini" });
    const login = await t.add("검수", "review", { cli: "gemini" });
    const reset = new Date(Date.now() + 3 * 3_600_000).toISOString();
    status(limited.id, { "gemini-5h": { remaining_fraction: 0, reset_time: reset }, "3p-5h": { remaining_fraction: 1, reset_time: new Date(Date.now() + 9 * 3_600_000).toISOString() } });
    status(busy.id, { "gemini-5h": { remaining_fraction: 0.4, reset_time: reset } });
    await failTurn("research", limited.id, quota);
    await until("한도 보류", () => t.orch.apiRecovery.usageLimited(limited.id));
    const card = t.store.listDecisions(t.project.id).find(d => d.usageLimit)!;
    expect(card.usageLimit).toMatchObject({ cli: "gemini", memberIds: [limited.id], resetsAt: reset });
    expect(card.title).toBe("Gemini 사용 한도 도달 · 팀원 1명 멈춤");
    expect(t.store.requireMember(limited.id)).toMatchObject({ status: "error", blockedReason: "usage_limit" });
    // 연결 문제는 장애다. Gemini 팀장이 있으면 탐침이 agy 가 닿는 주소도 본다.
    await failTurn("docs", offline.id, network);
    await until("장애", () => t.orch.apiRecovery.outage() !== null);
    expect(t.orch.apiRecovery.outage()!.affectedMemberIds).toEqual([offline.id]);
    await t.orch.apiRecovery.tick();
    expect(probes).toContain(GEMINI_PROBE_URL);
    // 429 만 말하는 글인데 상태줄의 묶음이 하나도 바닥나지 않았다: 잠깐의 용량 제한이라 한도가 아니라 장애로 다룬다.
    await failTurn("translate", busy.id, transient);
    await until("용량 제한은 장애", () => t.orch.apiRecovery.outage()?.affectedMemberIds.includes(busy.id) ?? false);
    expect(t.orch.apiRecovery.usageLimited(busy.id)).toBe(false);
    // 로그인 글은 지금처럼 일반 오류로 알린다(한도·장애로 보류하지 않는다).
    await failTurn("review", login.id, auth);
    await until("인증 오류", () => t.store.requireMember(login.id).status === "error");
    expect(t.store.requireMember(login.id).lastError).toBe(auth);
    expect(t.orch.apiRecovery.holdReason(login.id)).toBeNull();
    expect(t.store.listMessages(t.project.id, { limit: 100 }).filter(m => m.textCode === "chat.member_error").map(m => m.body).join("\n")).toContain("Verification required");
  });

  test("429 글인데 그 갈래의 칸 하나가 남은 비율 없이 왔다(agy 의 omitempty): 바닥났는지 모르므로 장애로 바꾸지 않고 사용 한도로 둔다", async () => {
    const probes: string[] = [];
    const t = setup({ apiRecovery: { probe: async url => { probes.push(url); throw new Error("offline"); }, intervalMs: 1 } });
    const member = await t.add("자료 조사", "research", { cli: "gemini", modelOverride: "gemini-3.8-flash" });
    mkdirSync(join(t.config.home, "context", "gemini"), { recursive: true });
    const reset = new Date(Date.now() + 3 * 3_600_000).toISOString();
    writeFileSync(geminiStatusPath(t.config.home, member.id), JSON.stringify(geminiStatusFromPayload(member.id, { conversation_id: "", agent_state: "idle", quota: {
      "gemini-5h": { reset_time: reset }, "gemini-weekly": { remaining_fraction: 0.5, reset_time: new Date(Date.now() + 5 * 86_400_000).toISOString() },
    } }, new Date())));
    await t.orch.assign(t.project.id, "research", { text: "자료 찾기" });
    await until("전달", () => t.runner.sent.some(s => s.memberId === member.id));
    t.runner.fail(member.id, "request failed: 429 Too Many Requests: RESOURCE_EXHAUSTED");
    await until("한도 보류", () => t.orch.apiRecovery.usageLimited(member.id));
    expect(t.orch.apiRecovery.outage()).toBeNull();
    expect(t.store.listDecisions(t.project.id).find(d => d.usageLimit)?.usageLimit?.cli).toBe("gemini");
  });

  test("모델 갈래를 모르는 팀장(Orchestrator (Argon))의 한도: 상태줄의 다른 갈래 시각(6일 뒤)을 쓰지 않고 초기화 시각을 모름으로 둔다(1시간부터 다시 이어 본다)", async () => {
    const t = setup();
    writeGeminiModelsCache(geminiModelsCachePath(t.config.home), [
      { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
      { value: "gemini-pro-orchestrator-g1-pro", label: "Orchestrator (Argon)", efforts: [] },
    ], new Date());
    const member = await t.add("자료 조사", "research", { cli: "gemini", modelOverride: "gemini-pro-orchestrator-g1-pro" });
    mkdirSync(join(t.config.home, "context", "gemini"), { recursive: true });
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(geminiStatusPath(t.config.home, member.id), JSON.stringify(geminiStatusFromPayload(member.id, { conversation_id: "", agent_state: "idle", quota: {
      "gemini-5h": { remaining_fraction: 0, reset_time: iso(2 * 3_600_000) }, "3p-weekly": { remaining_fraction: 0, reset_time: iso(6 * 86_400_000) },
    } }, new Date())));
    await t.orch.assign(t.project.id, "research", { text: "자료 찾기" });
    await until("전달", () => t.runner.sent.some(s => s.memberId === member.id));
    t.runner.fail(member.id, "You have exhausted your quota on this model.");
    await until("한도 보류", () => t.orch.apiRecovery.usageLimited(member.id));
    expect(t.store.listDecisions(t.project.id).find(d => d.usageLimit)!.usageLimit!.resetsAt).toBeNull();
  });

  test("한도로 멈춘 Gemini 팀장의 카드: /usage 로 초기화 시각을 정하고, 남은 묶음의 모델을 선택지로 낸다. 고르면 같은 대화를 그 모델로 이어 연다", async () => {
    const usage = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "agy-headless", "1.5.14", "usage.json"), "utf8"));
    const reset = new Date(Date.now() + 2 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    // Gemini Models 묶음의 5시간 칸이 바닥났다. Claude and GPT models·Gemini 4 Argon 묶음은 남아 있다.
    usage.command.data.groups[0].buckets[1] = { ...usage.command.data.groups[0].buckets[1], remaining_fraction: 0, reset_time: reset };
    const spawns: string[] = [];
    const t = setup({ geminiQuota: new GeminiQuotaReader({ bin: "/bin/sh", cwd: join(tmpdir(), "unused"), spawn: async (_bin, cwd) => { spawns.push(cwd); return { exitCode: 0, stdout: JSON.stringify(usage) }; } }) });
    // 실제 `agy models`(1.5.14) 출력을 parseAgyModels 로 묶은 모양: effort 를 뗀 값과 표시 이름. 묶음을 모르는 모델(Orchestrator (Argon))도 섞여 있다.
    writeGeminiModelsCache(geminiModelsCachePath(t.config.home), [
      { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
      { value: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"] },
      { value: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)", efforts: [] },
      { value: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
      { value: "gemini-pro-orchestrator-g1-pro", label: "Orchestrator (Argon)", efforts: [] },
      { value: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "medium", "high"] },
      { value: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"] },
    ], new Date());
    const created = await t.add("자료 조사", "research", { cli: "gemini", modelOverride: "gemini-3.8-flash" });
    const conversation = t.runner.learn(created.id);
    await until("대화 id", () => t.store.requireMember(created.id).sessionId === conversation);
    await t.orch.assign(t.project.id, "research", { text: "자료 찾기" });
    await until("전달", () => t.runner.sent.some(s => s.memberId === created.id));
    t.runner.fail(created.id, "You have exhausted your quota on this model.");
    await until("초기화 시각", () => t.store.listDecisions(t.project.id).find(d => d.usageLimit)?.usageLimit?.resetsAt === new Date(reset).toISOString());
    expect(spawns).toHaveLength(1);
    // 카드는 틱마다 선택지를 다시 셈한다. 한 번 돌린다.
    await t.orch.apiRecovery.tick();
    const card = t.store.listDecisions(t.project.id).find(d => d.usageLimit)!;
    // 같은 묶음(Gemini 4 Neon·Orchestrator (Neon))·묶음을 모르는 모델(Orchestrator (Argon))은 내지 않는다.
    expect(card.options.map(o => o.k)).toEqual(["model:gemini-4-argon", "model:claude-opus-5-5", "model:gpt-oss-120b", "resume"]);
    expect(card.options.find(o => o.k === "model:claude-opus-5-5")!.label).toBe("Claude Opus 5.5로 바꿔 이어가기");
    await t.orch.answerDecision(card.id, { choice: "model:claude-opus-5-5", memberIds: card.usageLimit!.memberIds });
    await until("보류 풀림", () => !t.orch.apiRecovery.usageLimited(created.id));
    const after = t.store.requireMember(created.id);
    expect(after.modelOverride).toBe("claude-opus-5-5");
    expect(after.sessionId).toBe(conversation);
    expect(t.runner.startsOf(created.id).at(-1)!.member).toMatchObject({ model: "claude-opus-5-5", sessionId: conversation });
    expect(t.runner.startsOf(created.id).at(-1)!.opts.resume).toBe(true);
  });

  test("새 한도 때는 /usage 를 다시 읽는다: 앞 팀장의 한도 때 읽어 둔 답(60초 캐시)으로 뒤 팀장의 초기화 시각을 놓치거나 바닥난 묶음의 모델을 선택지로 내지 않는다", async () => {
    const usage = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "agy-headless", "1.5.14", "usage.json"), "utf8"));
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const r1 = iso(2 * 3_600_000), r2 = iso(4 * 3_600_000);
    // 첫 답: Gemini 묶음의 5시간 칸이 바닥. 둘째 답: Claude·GPT 묶음의 5시간 칸까지 바닥.
    const first = structuredClone(usage);
    first.command.data.groups[0].buckets[1] = { ...first.command.data.groups[0].buckets[1], remaining_fraction: 0, reset_time: r1 };
    const second = structuredClone(first);
    second.command.data.groups[1].buckets[1] = { ...second.command.data.groups[1].buckets[1], remaining_fraction: 0, reset_time: r2 };
    let spawns = 0;
    const t = setup({ geminiQuota: new GeminiQuotaReader({ bin: "/bin/sh", cwd: join(tmpdir(), "unused"), spawn: async () => ({ exitCode: 0, stdout: JSON.stringify(++spawns === 1 ? first : second) }) }) });
    writeGeminiModelsCache(geminiModelsCachePath(t.config.home), [
      { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
      { value: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
      { value: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "medium", "high"] },
      { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"] },
      { value: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"] },
    ], new Date());
    const a = await t.add("자료 조사", "research", { cli: "gemini", modelOverride: "gemini-3.8-flash" });
    const b = await t.add("문서 정리", "docs", { cli: "gemini", modelOverride: "claude-opus-5-5" });
    const card = () => t.store.listDecisions(t.project.id).find(d => d.usageLimit);
    await t.orch.assign(t.project.id, "research", { text: "자료 찾기" });
    await until("A 전달", () => t.runner.sent.some(s => s.memberId === a.id));
    t.runner.fail(a.id, "You have exhausted your quota on this model.");
    await until("A 초기화 시각", () => card()?.usageLimit?.resetsAt === new Date(r1).toISOString());
    await t.orch.assign(t.project.id, "docs", { text: "문서 정리" });
    await until("B 전달", () => t.runner.sent.some(s => s.memberId === b.id));
    t.runner.fail(b.id, "You have exhausted your quota on this model.");
    // 카드의 시각은 기다리는 팀장들 가운데 가장 늦은 것이다: B 의 시각(4시간 뒤)을 /usage 를 다시 읽어 알아야 그것이 된다.
    await until("B 초기화 시각", () => card()?.usageLimit?.resetsAt === new Date(r2).toISOString());
    expect(spawns).toBe(2);
    await t.orch.apiRecovery.tick();
    // 남은 묶음은 Argon 뿐이다. Claude Sonnet·GPT-OSS(바닥난 Claude·GPT 묶음)를 선택지로 내지 않는다.
    expect(card()!.options.map(o => o.k)).toEqual(["model:gemini-4-argon", "resume"]);
  });

  test("/usage 를 못 읽으면 상태줄 기록의 묶음(1.5.14 실측 id)으로 같은 선택지를 낸다: Gemini 모델 ↔ gemini-*, Claude·GPT-OSS ↔ 3p-*, Argon ↔ gemini-argon-*", async () => {
    // 시험 모드처럼 /usage 읽기가 없다(geminiQuota 없음). 상태줄 입력은 실측 견본 그대로에 gemini-5h 만 바닥낸 것이다.
    const t = setup();
    writeGeminiModelsCache(geminiModelsCachePath(t.config.home), [
      { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
      { value: "gemini-4-neon", label: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"] },
      { value: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)", efforts: [] },
      { value: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
      { value: "gemini-pro-orchestrator-g1-pro", label: "Orchestrator (Argon)", efforts: [] },
      { value: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "medium", "high"] },
      { value: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"] },
    ], new Date());
    const created = await t.add("자료 조사", "research", { cli: "gemini", modelOverride: "gemini-3.8-flash" });
    const payload = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "cli", "gemini", "1.5.14", "statusline-after.json"), "utf8"));
    const reset = new Date(Date.now() + 2 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    payload.quota["gemini-5h"] = { remaining_fraction: 0, reset_time: reset, reset_in_seconds: 7200 };
    payload.quota["3p-5h"] = { ...payload.quota["3p-5h"], reset_time: new Date(Date.now() + 5 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z") };
    mkdirSync(join(t.config.home, "context", "gemini"), { recursive: true });
    writeFileSync(geminiStatusPath(t.config.home, created.id), JSON.stringify(geminiStatusFromPayload(created.id, payload, new Date())));
    await t.orch.assign(t.project.id, "research", { text: "자료 찾기" });
    await until("전달", () => t.runner.sent.some(s => s.memberId === created.id));
    t.runner.fail(created.id, "You have exhausted your quota on this model.");
    // 초기화 시각은 그 팀장 모델 갈래(gemini-*)의 다 쓴 칸이다(3p-* 의 움직이는 시각이 아니다).
    await until("초기화 시각", () => t.store.listDecisions(t.project.id).find(d => d.usageLimit)?.usageLimit?.resetsAt === new Date(reset).toISOString());
    await t.orch.apiRecovery.tick();
    const card = t.store.listDecisions(t.project.id).find(d => d.usageLimit)!;
    expect(card.options.map(o => o.k)).toEqual(["model:gemini-4-argon", "model:claude-opus-5-5", "model:gpt-oss-120b", "resume"]);
  });

  test("사용 한도 카드의 CLI 이름: Gemini 는 'Gemini' 다(예전에는 Claude 가 아니면 모두 'Codex'). CLI 마다 카드가 따로다", async () => {
    const t = setup();
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    const codex = await t.add("서버 개발", "api", { cli: "codex" });
    const claude = await t.add("화면 개발", "ui", { cli: "claude" });
    t.orch.apiRecovery.usageFailure(t.store.requireMember(gemini.id), "RESOURCE_EXHAUSTED: quota exceeded");
    t.orch.apiRecovery.usageFailure(t.store.requireMember(codex.id), "You've hit your usage limit");
    t.orch.apiRecovery.usageFailure(t.store.requireMember(claude.id), "You've hit your weekly limit");
    const cards = t.store.listDecisions(t.project.id).filter(d => d.usageLimit);
    const titleOf = (cli: string) => cards.find(d => d.usageLimit!.cli === cli)!.title;
    expect(cards).toHaveLength(3);
    expect(titleOf("gemini")).toBe("Gemini 사용 한도 도달 · 팀원 1명 멈춤");
    expect(titleOf("codex")).toBe("Codex 사용 한도 도달 · 팀원 1명 멈춤");
    expect(titleOf("claude")).toBe("Claude 사용 한도 도달 · 팀원 1명 멈춤");
    expect(cards.find(d => d.usageLimit!.cli === "gemini")!.usageLimit!.memberIds).toEqual([gemini.id]);
    // /usage 를 읽지 못하면(여기는 읽기가 없다) 묶음을 몰라 모델 선택지를 내지 않는다(이어가기만).
    expect(cards.find(d => d.usageLimit!.cli === "gemini")!.options.map(o => o.k)).toEqual(["resume"]);
    // 사용 한도로 멈춘 Claude 팀장을 Gemini 로 바꾸면 활동 줄의 CLI 이름도 Gemini 다.
    await t.orch.patchMemberConfig(claude.id, { cli: "gemini" });
    const line = t.store.listActivity(claude.id, 100).find(a => a.textCode === "activity.usage_reopen_cli_new");
    expect(line?.text).toContain("Gemini");
    expect(line?.text).not.toContain("Claude");
    expect(t.orch.apiRecovery.usageLimited(claude.id)).toBe(false);
  });
});

describe("조립: 실행 파일·모델 캐시 갱신", () => {
  test("createOrchestrator 가 실행기에 geminiBin·geminiHome 을 넘긴다. 시험 모드에서는 모델 갱신기를 만들지 않는다", async () => {
    const { config } = isolatedConfig();
    const db = openDb(config.dbPath);
    const store = new Store(db, new Bus());
    const orch = createOrchestrator(config, store);
    cleanups.push(async () => { await orch.shutdown(); db.close(); });
    expect(config.geminiBin).toEndWith("/bin/agy");
    const options = Reflect.get(Reflect.get(orch, "runners").get("core"), "options") as Record<string, unknown>;
    expect(options).toMatchObject({ contextHome: config.home, claudeBin: config.claudeBin, codexBin: config.codexBin, geminiBin: config.geminiBin, geminiHome: config.geminiHome });
    // bun test 는 NODE_ENV=test 로 돈다(격리 스크립트는 IAMCEO_TEST=1 도 준다): 실제 agy 를 띄울 수 있는 갱신기가 없다.
    expect(process.env.NODE_ENV === "test" || process.env.IAMCEO_TEST === "1").toBe(true);
    expect(Reflect.get(orch, "geminiModels")).toBeNull();
  });

  test("갱신기를 넘기면 틱을 시작할 때 한 번 갱신해 모델 목록이 캐시의 것이 되고, 캐시가 없어지면 틱이 다시 걸며, 끝낼 때 멈춘다", async () => {
    const { root, config } = isolatedConfig();
    let spawned = 0;
    const output = "Fetching available models...\ngemini-5-test-low\tGemini 5 Test (Low)\ngemini-5-test-high\tGemini 5 Test (High)\n";
    const cachePath = geminiModelsCachePath(config.home);
    const refresher = new GeminiModelsRefresher({ bin: join(root, "bin", "agy"), cachePath, retryStepsMs: [0], spawn: async (bin) => { spawned++; expect(bin).toBe(join(root, "bin", "agy")); return { exitCode: 0, stdout: output }; } });
    const db = openDb(config.dbPath);
    const store = new Store(db, new Bus());
    const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", new FakeRunner()]]), timings: { tickMs: 60_000, healthMs: 60_000 }, geminiModels: refresher });
    let closed = false;
    cleanups.push(async () => { if (!closed) await orch.shutdown(); db.close(); });
    const models = () => (Reflect.get(orch, "models") as { read(): { gemini: { source: string; models: ModelOption[] } } }).read().gemini;
    expect(models().source).toBe("default");
    expect(spawned).toBe(0);
    (Reflect.get(orch, "startTick") as () => void).call(orch);
    await until("첫 갱신", () => existsSync(cachePath));
    expect(spawned).toBe(1);
    expect(models()).toMatchObject({ source: "cli", models: [{ value: "gemini-5-test", label: "Gemini 5 Test", efforts: ["low", "high"] }] });
    // 틱: 캐시가 있으면 다시 띄우지 않고, 없어지면 다시 건다.
    const tick = () => (Reflect.get(orch, "onTick") as () => void).call(orch);
    tick();
    await Bun.sleep(30);
    expect(spawned).toBe(1);
    rmSync(cachePath);
    tick();
    await until("캐시 다시 생김", () => existsSync(cachePath));
    expect(spawned).toBe(2);
    await orch.shutdown();
    closed = true;
    expect(await refresher.refresh()).toEqual({ ok: false, reason: "failed" });
    expect(spawned).toBe(2);
  });

  test("모델 목록 갱신은 Gemini 를 쓰는 근거가 있을 때만 돈다: 근거가 없으면 서버가 떠도 틱이 돌아도 agy 를 띄우지 않고, Gemini 팀장을 만들면 다음 틱에 띄운다", async () => {
    const { root, work, config } = isolatedConfig();
    const db = openDb(config.dbPath);
    const store = new Store(db, new Bus());
    store.patchSettings({ boardTidyHours: 0 });
    let spawned = 0;
    const output = "Fetching available models...\ngemini-5-test-low\tGemini 5 Test (Low)\n";
    const cachePath = geminiModelsCachePath(config.home);
    // 운영 조립이 쓰는 설정 그대로(쓰는 근거는 저장소에서 읽는다). 실행만 가짜다.
    const options = geminiModelsRefresherOptions(config, store);
    expect(options).toMatchObject({ bin: join(root, "bin", "agy"), cachePath });
    expect(options.wanted?.()).toBe(false);
    const refresher = new GeminiModelsRefresher({ ...options, retryStepsMs: [0], spawn: async () => { spawned++; return { exitCode: 0, stdout: output }; } });
    const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", new FakeRunner()]]), timings: { tickMs: 60_000, healthMs: 60_000 }, geminiModels: refresher });
    cleanups.push(async () => { await orch.shutdown(); db.close(); });
    const project = store.createProject({ name: "시험", cwd: work });
    const tick = () => (Reflect.get(orch, "onTick") as () => void).call(orch);
    const source = () => (Reflect.get(orch, "models") as { read(): { gemini: { source: string } } }).read().gemini.source;
    // agy 는 깔려 있지만(가짜 실행 파일) Claude·Codex 만 쓴다.
    await orch.addMember(project.id, { name: "화면 개발", handle: "ui", role: "개발", cli: "claude" });
    await orch.addMember(project.id, { name: "서버 개발", handle: "api", role: "개발", cli: "codex" });
    (Reflect.get(orch, "startTick") as () => void).call(orch);
    for (let i = 0; i < 3; i++) { tick(); await Bun.sleep(15); }
    expect(spawned).toBe(0);
    expect(existsSync(cachePath)).toBe(false);
    expect(source()).toBe("default");
    // Gemini 팀장을 처음 만든다. 만드는 것만으로는 띄우지 않고, 다음 틱이 건너뛴 갱신을 한다.
    await orch.addMember(project.id, { name: "자료 조사", handle: "research", role: "조사", cli: "gemini" });
    expect(options.wanted?.()).toBe(true);
    await Bun.sleep(30);
    expect(spawned).toBe(0);
    tick();
    await until("첫 갱신", () => existsSync(cachePath));
    expect(spawned).toBe(1);
    expect(source()).toBe("cli");
    // 그 뒤의 틱은 캐시가 있어 띄우지 않는다.
    tick();
    await Bun.sleep(30);
    expect(spawned).toBe(1);
  });

  test("예행 환경에는 Gemini 실행 파일·홈 자리도 가짜로 묶여 있다", () => {
    const env = rehearsalEnvironment("/private/tmp/rehearse-root");
    expect(env.IAMCEO_GEMINI_BIN).toBe("/private/tmp/rehearse-root/bin/agy");
    expect(env.IAMCEO_GEMINI_HOME).toBe("/private/tmp/rehearse-root/gemini");
    expect(env.IAMCEO_CLAUDE_BIN).toBe("/private/tmp/rehearse-root/bin/claude");
    expect(env.IAMCEO_CODEX_BIN).toBe("/private/tmp/rehearse-root/bin/codex");
  });
});

// 아래는 운영과 같은 실행기로 돈다: 가짜 core 소켓(그 안의 agy 흉내) + 실제 CoreRunner + 운영 배선의 총괄(tests/fixtures/core-harness.ts).
// 가짜 agy 는 실제처럼 첫 글을 받을 때 대화 id 를 만들고, 상태줄 기록으로 알리며, 열 수 없는 대화로 이어 열면 조용히 새 대화가 된다.
describe("실제 실행기(CoreRunner)와 함께: 대화 id 를 모르는 Gemini 세션, 조용히 새 대화가 된 이어 열기", () => {
  const TOOLS: AgentToolsImpl = {
    listAgentTools: () => [],
    async handleAgentTool(orch, member, name, args) {
      if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
      return { text: "모르는 도구", isError: true };
    },
  };
  async function core(opts: CoreSetupOptions = {}) {
    const t = await coreSetup({ agentTools: TOOLS, ...opts });
    cleanups.push(() => t.close());
    return t;
  }

  test("말을 걸지 않은 Gemini 팀장: 재웠다 깨우면 새 세션으로 뜨고, 깨어 있는 채로 보관해도 막히지 않는다", async () => {
    const t = await core();
    const member = (await t.orch.addMember(t.project.id, { name: "자료 조사", handle: "research", role: "조사", cli: "gemini" })).member;
    await t.idle(member.id);
    expect(t.member(member.id)).toMatchObject({ cli: "gemini", sessionId: null, status: "idle" });
    const flags = () => t.runs(member.id).map(run => run.conversationFlag);
    expect(flags()).toEqual([null]);
    // 재우기 → 깨우기: 대화가 없던 터미널이다. 이어 열기를 시키지 않고, '세션 id 를 모른다'로 막지도 않는다.
    await t.orch.sleepMember(member.id);
    expect(await t.orch.resumeMember(member.id)).toMatchObject({ status: "idle", sessionId: null, lastError: null });
    expect(flags()).toEqual([null, null]);
    expect(t.core.terminalOf(member.id)!.state).toBe("live");
    // 보관: 실행기가 본 턴이 0 이고 서버가 넣은 것도 없다. '이어갈 세션 기록을 확인하는 중'으로 막지 않는다.
    await t.idle(member.id);
    expect((await t.orch.patchProject(t.project.id, { archived: true })).archived).toBe(true);
    expect(t.member(member.id)).toMatchObject({ status: "asleep", sessionId: null, paneId: null });
    // 꺼내서 지시하면 새 세션이 뜨고, 첫 턴 뒤 대화 id 를 알아낸다. 그 뒤로는 그 대화를 이어 연다.
    await t.orch.patchProject(t.project.id, { archived: false });
    await t.orch.resumeMember(member.id, "첫 자료 찾기 @fake:post=자료찾음");
    await t.waitFor("첫 턴", () => t.texts().some(m => m.title === "자료찾음"));
    const conversation = await t.waitFor("대화 id", () => t.member(member.id).sessionId);
    await t.idle(member.id);
    expect(flags()).toEqual([null, null, null]);
    expect(t.db.query("SELECT provider, session_id FROM usage_sessions WHERE member_id = ?").all(member.id)).toEqual([{ provider: "gemini", session_id: conversation }]);
    await t.orch.sleepMember(member.id);
    expect(await t.orch.resumeMember(member.id)).toMatchObject({ status: "idle", sessionId: conversation });
    expect(flags()).toEqual([null, null, null, conversation]);
  });

  test("보관: 대표가 터미널에서 직접 돌린 턴이 있는데 대화 id 를 모르면 지금처럼 막는다(잃을 수 있는 대화가 있다)", async () => {
    // 상태줄 기록을 남기지 않는 agy: 턴이 돌아도 서버는 대화 id 를 끝내 알지 못한다.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-gemini-orch-core-")));
    const fake = await startFakeCore({ claudeHome: join(home, "claude-home"), geminiHome: join(home, "gemini-home") });
    cleanups.push(async () => { await fake.stop(); rmSync(home, { recursive: true, force: true }); });
    const t = await core({ home, core: fake });
    const member = (await t.orch.addMember(t.project.id, { name: "자료 조사", handle: "research", role: "조사", cli: "gemini" })).member;
    await t.idle(member.id);
    // 서버는 아무것도 넣지 않았다. 대표가 앱의 터미널에서 직접 한 턴을 돌렸다.
    fake.typeDirectly(member.id, "직접 물어본 것");
    await t.waitFor("직접 돌린 턴 끝", () => (t.runner.observationState(member.id)?.turn ?? 0) > 0 && !t.runner.isBusy(member.id));
    await t.idle(member.id);
    expect(t.member(member.id)).toMatchObject({ status: "idle", sessionId: null });
    expect(t.store.listDispatches(member.id)).toEqual([]);
    const refused = await t.orch.patchProject(t.project.id, { archived: true }).then(() => null, (e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, code: "archive_stop_failed" });
    // '확인하는 중'(기다리면 풀릴 것 같은 글)이 아니라 할 일을 알린다: 먼저 재운 뒤 보관한다.
    expect((refused as ApiError).message).toContain("Gemini 세션의 대화 ID를 아직 알지 못했습니다. 그 세션을 먼저 재운 뒤 보관하세요");
    expect(t.store.requireProject(t.project.id).archived).toBe(false);
    expect(fake.terminalOf(member.id)!.state).toBe("live");
  });

  test("첫 설정 화면에 걸린 Gemini 팀장: 알림이 가고, 기다리던 지시는 그 터미널에 한 글자도 넣지 않는다. 첫 설정이 끝나면 들어간다", async () => {
    const notices: { title: string; body: string }[] = [];
    const t = await core({ notifier: (title, body) => { notices.push({ title, body }); }, timings: { blockedNoticeMs: 30 } });
    t.store.patchSettings({ notifyMac: true });
    const member = (await t.orch.addMember(t.project.id, { name: "자료 조사", handle: "research", role: "조사", cli: "gemini" })).member;
    await t.idle(member.id);
    notices.length = 0;
    // agy 가 스스로 알리는 상태(OSC 7501): blocked · question · "Finish setup"(base64). 약관·데이터 수집 동의는 사람만 할 수 있다.
    t.core.setStatus(member.id, { state: "blocked", kind: "question", msg: Buffer.from("Finish setup").toString("base64") });
    await t.waitFor("막힘", () => t.member(member.id).status === "blocked" && t.member(member.id).blockedCode === "gemini_setup");
    expect(t.member(member.id)).toMatchObject({ blockedReason: "setup", sessionId: null });
    await t.waitFor("알림", () => notices.length > 0);
    expect(notices).toEqual([{ title: "IAMCEO · 자료 조사 확인 필요", body: "Antigravity CLI의 로그인·첫 설정이 끝나지 않았습니다. 터미널을 열어 직접 끝내 주세요" }]);
    const written = () => [t.core.count("terminal.send"), t.core.count("terminal.keys"), t.core.count("terminal.interrupt")];
    const before = written();
    await t.orch.assign(t.project.id, "research", { text: "첫 자료 찾기 @fake:post=자료찾음" });
    await t.orch.pump(member.id);
    await Bun.sleep(200);
    expect(written()).toEqual(before);
    expect(t.turns(member.id)).toEqual([]);
    expect(t.store.listPending(member.id).filter(d => d.kind === "instruction").map(d => [d.status, d.holdReason])).toEqual([["held", "blocked"]]);
    expect(notices).toHaveLength(1);
    // 대표가 터미널에서 첫 설정을 끝냈다: agy 가 쉬는 중을 알리고, 기다리던 지시가 들어간다.
    t.core.setStatus(member.id, { state: "idle" });
    await t.waitFor("지시가 들어감", () => t.texts().some(m => m.title === "자료찾음"));
    expect(t.turns(member.id).filter(turn => turn.prompt.includes("첫 자료 찾기"))).toHaveLength(1);
    await t.waitFor("대화 id", () => t.member(member.id).sessionId);
    expect(t.member(member.id).blockedCode).toBeUndefined();
  });

  test("CLI 바꾸기(실제 실행기): Claude → Gemini 를 그만두면 미리 해 본 검사가 쓴 Gemini 실행 폴더가 남지 않고, 바꾼 뒤 Gemini → Claude 로 돌아오면 그 폴더를 지운다", async () => {
    const t = await core();
    const member = (await t.orch.addMember(t.project.id, { name: "화면 개발", handle: "ui", role: "개발", cli: "claude" })).member;
    await t.idle(member.id);
    const own = geminiRunDir(t.config.home, member.id);
    const token = t.store.getMemberToken(member.id);
    // 입력칸에 대표가 쓰던 글이 있다: 옛 세션을 끝내지 않는다(그만둔다).
    t.core.setDraft(member.id, "쓰던 글");
    const refused = await t.orch.patchMemberConfig(member.id, { cli: "gemini" }).then(() => null, (e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, code: "close_draft_present" });
    expect(t.member(member.id)).toMatchObject({ cli: "claude", sessionId: member.sessionId });
    expect(t.store.getMemberToken(member.id)).toBe(token);
    // 끝내기 전에 띄우기 인자를 미리 만들어 보며 이 폴더에 지금 토큰으로 MCP 설정을 썼다. 그만뒀으니 남기지 않는다.
    expect(existsSync(own)).toBe(false);
    expect(t.core.terminalOf(member.id)!.state).toBe("live");

    // 글을 지우고 다시 바꾼다: Gemini 로 뜨고, 그 폴더에 새 토큰으로 쓴다.
    t.core.setDraft(member.id, "");
    // 설정을 바꾼 뒤(거절이어도) 서버가 한 번 미는 전달 펌프가 끝나기를 기다린다. 그 사이의 변경은 '처리하는 중'으로 거절된다.
    const settled = () => t.waitFor("펌프 끝", () => !t.runner.isBusy(member.id) && t.member(member.id).status === "idle" && !(Reflect.get(t.orch, "runtimes") as Map<string, { pumping: unknown }>).get(member.id)?.pumping);
    await settled();
    const switched = await t.orch.patchMemberConfig(member.id, { cli: "gemini" });
    expect(switched).toMatchObject({ cli: "gemini", sessionId: null });
    const geminiToken = t.store.getMemberToken(member.id);
    expect(geminiToken).not.toBe(token);
    expect(t.runs(member.id).at(-1)).toMatchObject({ cli: "gemini", conversationFlag: null, addDir: join(own, "agy", member.id) });
    expect(readFileSync(join(own, "agy", `${member.id}.env`), "utf8")).toContain(geminiToken);
    expect(readFileSync(join(own, "agy", `${member.id}.env`), "utf8")).not.toContain(token);
    await settled();
    // Claude 로 돌아온다: Gemini 실행 폴더(주입 폴더·토큰이 든 환경 파일)는 지워지고, 그 토큰은 더 쓸 수 없다.
    const back = await t.orch.patchMemberConfig(member.id, { cli: "claude" });
    expect(back.cli).toBe("claude");
    expect(existsSync(own)).toBe(false);
    expect(t.store.getMemberByToken(geminiToken)).toBeNull();
    expect(t.runs(member.id).at(-1)!.cli).toBe("claude");
  });

  test("CLI 바꾸기(실제 실행기): Gemini 목록에 없는 모델로 뜨게 될 전환은 지금 세션을 끝내기 전에 거절한다", async () => {
    const t = await core();
    const member = (await t.orch.addMember(t.project.id, { name: "화면 개발", handle: "ui", role: "개발", cli: "claude" })).member;
    await t.idle(member.id);
    // Gemini 직급 모델이 목록에서 사라진 값으로 남아 있다(목록이 바뀌기 전에 정한 값). agy 는 없는 모델을 시작 전에 오류로 끝낸다.
    t.store.patchSettings({ geminiRanks: { lead: { model: "gemini-removed-model" } } });
    const runs = t.runs(member.id).length, kills = t.core.count("terminal.kill");
    const refused = await t.orch.patchMemberConfig(member.id, { cli: "gemini" }).then(() => null, (e: unknown) => e);
    expect(refused).toMatchObject({ status: 400, code: "cli_switch_model_mismatch_gemini" });
    expect(t.member(member.id)).toMatchObject({ cli: "claude", sessionId: member.sessionId, status: "idle" });
    expect(t.core.terminalOf(member.id)!.state).toBe("live");
    expect([t.runs(member.id).length, t.core.count("terminal.kill")]).toEqual([runs, kills]);
    expect(existsSync(geminiRunDir(t.config.home, member.id))).toBe(false);
    // 팀장에게 목록의 모델을 정해 주면 바뀐다.
    await t.waitFor("펌프 끝", () => !(Reflect.get(t.orch, "runtimes") as Map<string, { pumping: unknown }>).get(member.id)?.pumping);
    const switched = await t.orch.patchMemberConfig(member.id, { cli: "gemini", modelOverride: "gemini-4-neon" });
    expect(switched).toMatchObject({ cli: "gemini", modelOverride: "gemini-4-neon", sessionId: null });
    const argv = t.runs(member.id).at(-1)!.argv;
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "gemini-4-neon"]);
  });

  test("재시작 이어가기: 이어 연 Gemini 대화가 실제로는 새 대화였으면, 끊긴 실행을 총괄에게 중단으로 알리고 팀장에게 마지막 일을 넣는다", async () => {
    const t = await core();
    const lead = await t.orch.ensureConductor(t.project.id);
    await t.idle(lead.id);
    const member = (await t.orch.addMember(t.project.id, { name: "자료 조사", handle: "research", role: "조사", cli: "gemini" }, lead)).member;
    await t.idle(member.id);
    await t.orch.assign(t.project.id, "research", { text: "큰 자료 정리 @fake:hold" }, lead);
    // 첫 글을 받으며 agy 가 대화를 만들고, 서버가 그 id 를 알아낸다. 턴은 아직 도는 중이다.
    await t.waitFor("일하는 중", () => t.core.held(member.id) && t.member(member.id).status === "working" && !!t.member(member.id).sessionId);
    const before = t.member(member.id);
    const conversationFile = join(t.home, "gemini-home", "conversations", `${before.sessionId}.db`);
    expect(existsSync(conversationFile)).toBe(true);
    // Mac 을 껐다 켰다: 서버도 그 터미널도 사라진다.
    await t.stopServer();
    t.core.exit(member.id, 1, "holder_lost");
    // 다시 뜬 서버가 볼 때는 대화 파일이 있다(이어 열 수 있다고 본다). agy 는 띄워 보니 그 대화를 열지 못한다:
    // 오류 없이 경고만 찍고 새 대화를 연다. 띄우는 순간 파일을 치워 그 상황을 만든다.
    t.core.intercept(call => {
      if (call.method === "terminal.run" && call.params.labels?.["iamceo.member"] === member.id) rmSync(conversationFile, { force: true });
      return undefined;
    });
    const next = await t.restart();
    cleanups.push(() => next.close());
    // 서버는 같은 대화를 이어 띄웠고(--conversation), 끊긴 일을 이어서 하라는 글을 넣었다.
    await next.waitFor("이어가기 글", () => next.turns(member.id).some(turn => turn.prompt.includes(RESTART_RESUME_TEXT)));
    expect(next.runs(member.id).map(run => run.conversationFlag)).toEqual([null, before.sessionId]);
    // 그 글을 받으며 agy 가 새 대화를 만들었다. 실행기가 바뀐 id 를 알린다.
    const replaced = await next.waitFor("바뀐 대화 id", () => { const id = next.member(member.id).sessionId; return id && id !== before.sessionId ? id : null; });
    expect(replaced).toBe(next.runs(member.id).at(-1)!.sessionId!);
    const activity = next.store.listActivity(member.id, 200);
    expect(activity.filter(a => a.textCode === "activity.gemini_resume_lost").map(a => a.text)).toEqual(["이전 대화를 이어 열지 못해 새 대화로 열렸습니다. 앞 대화의 맥락은 없습니다"]);
    // 대화에는 '이어서 하게 했습니다' 뒤에 그 실행의 중단이 까닭과 함께 남는다.
    const system = next.texts().filter(m => m.textCode === "chat.run_restart_resumed" || m.textCode === "chat.run_interrupted");
    expect(system.map(m => m.textCode)).toEqual(["chat.run_restart_resumed", "chat.run_interrupted"]);
    expect(system[1]!.body).toContain("자료 조사: 실행 ");
    expect(system[1]!.body).toContain("중단 — 이전 대화를 이어 열지 못해 새 대화로 열렸습니다(앞 대화의 맥락 없음)");
    // 총괄을 깨워 중단을 알린다(세션 기록이 없어 새 세션으로 연 때와 같은 글). 앞서 받은 '다시 지시하지 마세요'만 믿고 기다리지 않게 한다.
    await next.waitFor("총괄에게 중단 알림", () => next.turns(lead.id).some(turn => turn.prompt.includes("자료 조사의 실행") && turn.prompt.includes("중단되었습니다")));
    // 팀장의 줄에는 마지막 일을 적은 글이 선다(새 대화에는 앞 맥락이 없다).
    expect(next.store.listDeliveries(t.project.id).filter(d => d.memberId === member.id && d.text.includes("이전 세션을 찾지 못해 새 세션으로 시작합니다"))).toHaveLength(1);
    // 한 번만 알린다.
    await Bun.sleep(200);
    expect(next.texts().filter(m => m.textCode === "chat.run_interrupted")).toHaveLength(1);
    expect(next.store.listActivity(member.id, 200).filter(a => a.textCode?.startsWith("activity.gemini_"))).toHaveLength(1);
  }, 30_000);
});
