// 0.2.10 Gemini(Antigravity CLI) 기능 맞추기(핵심 갈래): 권한 auto 의 실제 모드 확인과 대신하는 모드, 결재함 도구 승인 카드, 서브에이전트 단계.
// 실제 agy 는 띄우지 않는다. 지휘 쪽은 가짜 실행기(받은 것만 적는다)로, 실행기 쪽은 가짜 core 소켓 + 실제 CoreRunner 로 돈다(tests/fixtures/core-harness.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator, type OrchestratorTimings } from "../server/orchestrator.ts";
import { CoreError } from "../server/runner/core-client.ts";
import { CoreRunner, type CoreRunnerDeps } from "../server/runner/core.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import type { Backend, Member } from "../shared/types.ts";
import { startFakeCore, type FakeCoreOptions } from "./fixtures/core-harness.ts";

/** 세션을 띄우지 않고 받은 것만 적는다. Gemini 는 실제 실행기처럼 새 세션을 대화 id 없이 띄운다(tests/gemini-orchestrator.test.ts 의 것과 같은 꼴). */
class FakeRunner implements Runner {
  readonly kind: Backend = "core";
  readonly interjects = false;
  starts: { member: RunnerMember; opts: StartOpts }[] = [];
  stops: string[] = [];
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  modes = new Map<string, { cycleMode: string; sandbox: boolean | null }>();
  private terminals = 0;
  private cb: (e: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember, o: StartOpts) {
    this.starts.push({ member: { ...m }, opts: { ...o } });
    const paneId = `t${++this.terminals}`;
    if (m.cli !== "gemini") return { sessionId: m.sessionId ?? crypto.randomUUID(), paneId };
    if (o.resume && !m.sessionId) throw new CoreError("session_unknown", "Antigravity conversation id is unknown");
    return { sessionId: o.resume ? m.sessionId : null, paneId };
  }
  async send(m: RunnerMember, text: string): Promise<SendResult> { this.sent.push({ memberId: m.id, text }); this.busy.add(m.id); return { ok: true }; }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async applyConfig(): Promise<SendResult> { return { ok: true }; }
  async usageLimitSnapshot() { return { menu: null, state: "idle" }; }
  async interrupt() {}
  async stop(m: RunnerMember) { this.stops.push(m.id); this.busy.delete(m.id); }
  async screen() { return ""; }
  on(cb: (e: RunnerEvent) => void) { this.cb = cb; }
  async shutdown() {}
  startsOf(id: string) { return this.starts.filter(s => s.member.id === id); }
  emit(e: RunnerEvent) { this.cb(e); }
  learn(memberId: string, sessionId = `conv-${crypto.randomUUID()}`): string { this.cb({ type: "session", memberId, sessionId }); return sessionId; }
  end(memberId: string) { this.busy.delete(memberId); this.cb({ type: "turn_end", memberId, finalText: "", isError: false }); }
  /** CoreRunner.geminiMode 와 같은 자리(결재함 승인 카드의 판정이 쓴다). */
  geminiMode(memberId: string) { return this.modes.get(memberId) ?? null; }
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

function isolatedConfig(): { root: string; work: string; config: Config } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-gpc-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { work: join(root, "work"), bin: join(root, "bin"), user: join(root, "user"), claude: join(root, "claude"), codex: join(root, "codex"), gemini: join(root, "gemini") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { mode: 0o700 });
  for (const name of ["core", "claude", "codex", "agy"]) writeFileSync(join(dirs.bin, name), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  const env = {
    IAMCEO_HOME: join(root, "state"), IAMCEO_PORT: "0", HOME: dirs.user, PATH: "/usr/bin:/bin",
    CLAUDE_CONFIG_DIR: dirs.claude, CODEX_HOME: dirs.codex, IAMCEO_GEMINI_HOME: dirs.gemini,
    IAMCEO_CORE_BIN: join(dirs.bin, "core"), IAMCEO_CORE_SOCKET: join(root, "no-core.sock"),
    IAMCEO_CLAUDE_BIN: join(dirs.bin, "claude"), IAMCEO_CODEX_BIN: join(dirs.bin, "codex"), IAMCEO_GEMINI_BIN: join(dirs.bin, "agy"),
  };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  return { root, work: dirs.work, config: loadConfig(env) };
}

function setup(opts: { timings?: Partial<OrchestratorTimings>; permissionMode?: "auto" | "default" | "bypassPermissions" } = {}) {
  const { root, work, config } = isolatedConfig();
  const db = openDb(config.dbPath);
  const store = new Store(db, new Bus());
  store.patchSettings({ boardTidyHours: 0, ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}) });
  const runner = new FakeRunner();
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000, ...opts.timings } });
  cleanups.push(async () => { await orch.shutdown(); db.close(); });
  const project = store.createProject({ name: "시험", cwd: work });
  const add = async (name: string, handle: string, extra: { cli?: Member["cli"] } = {}) => {
    const member = (await orch.addMember(project.id, { name, handle, role: name, ...extra })).member;
    await orch.pump(member.id);
    return store.requireMember(member.id);
  };
  const priv = <T>(name: string, ...args: unknown[]): T => (Reflect.get(orch, name) as (...a: unknown[]) => T).call(orch, ...args);
  return { root, work, config, db, store, runner, orch, project, add, priv };
}
const fallbackLines = (store: Store, memberId: string) => store.listActivity(memberId, 100).filter(a => a.textCode === "activity.gemini_auto_fallback");

describe("권한 auto: 실제 모드 확인과 대신하는 모드(지휘)", () => {
  test("auto 로 띄운 팀장의 첫 모드가 default 면 활동에 남기고, 말을 걸기 전이면 곧바로 대신하는 모드로 새로 띄운다", async () => {
    const t = setup({ permissionMode: "auto" });
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    expect(t.runner.startsOf(gemini.id)).toHaveLength(1);
    expect(t.runner.startsOf(gemini.id)[0]!.member.geminiAutoFallback).toBeUndefined();
    t.runner.emit({ type: "gemini_mode", memberId: gemini.id, cycleMode: "default", sandbox: false, initial: true });
    await until("대신하는 모드로 다시 띄움", () => t.runner.startsOf(gemini.id).length === 2);
    const relaunched = t.runner.startsOf(gemini.id).at(-1)!;
    expect(relaunched.member).toMatchObject({ cli: "gemini", permissionMode: "auto", geminiAutoFallback: true, sessionId: null });
    expect(relaunched.opts.resume).toBe(false);
    expect(t.store.getAppliedConfig(gemini.id)).toEqual({ model: null, effort: null, staffModel: null, staffEffort: null, geminiMode: "auto-fallback" });
    expect(fallbackLines(t.store, gemini.id)).toHaveLength(1);
    expect(t.priv<boolean>("configPending", t.store.requireMember(gemini.id))).toBe(false);
    // 대신하는 모드로 띄운 터미널이 accept-edits 를 알려도, 다시 default 를 알려도 또 바꾸지 않는다.
    t.runner.emit({ type: "gemini_mode", memberId: gemini.id, cycleMode: "accept-edits", sandbox: true, initial: true });
    t.runner.emit({ type: "gemini_mode", memberId: gemini.id, cycleMode: "default", sandbox: false, initial: true });
    await t.orch.pump(gemini.id);
    await Bun.sleep(30);
    expect(t.runner.startsOf(gemini.id)).toHaveLength(2);
    expect(fallbackLines(t.store, gemini.id)).toHaveLength(1);
  });

  test("auto 가 들었거나, 처음이 아닌 모드 알림(사람이 Shift+Tab 으로 바꿈)이거나, 권한이 auto 가 아니면 손대지 않는다", async () => {
    const t = setup({ permissionMode: "auto" });
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    t.runner.emit({ type: "gemini_mode", memberId: gemini.id, cycleMode: "auto", sandbox: true, initial: true });
    t.runner.emit({ type: "gemini_mode", memberId: gemini.id, cycleMode: "default", sandbox: true, initial: false });
    await t.orch.pump(gemini.id);
    await Bun.sleep(30);
    expect(t.runner.startsOf(gemini.id)).toHaveLength(1);
    expect(fallbackLines(t.store, gemini.id)).toEqual([]);

    const plain = setup({ permissionMode: "default" });
    const other = await plain.add("문서 정리", "docs", { cli: "gemini" });
    plain.runner.emit({ type: "gemini_mode", memberId: other.id, cycleMode: "default", sandbox: false, initial: true });
    await plain.orch.pump(other.id);
    await Bun.sleep(30);
    expect(plain.runner.startsOf(other.id)).toHaveLength(1);
    expect(plain.runner.startsOf(other.id)[0]!.member.geminiAutoFallback).toBeUndefined();
  });

  test("대화가 있는 팀장은 일하는 동안 기다렸다가 쉬는 때에 같은 대화를 대신하는 모드로 이어 연다. Claude 팀장은 auto 그대로다", async () => {
    const t = setup({ permissionMode: "auto" });
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    const claude = await t.add("결제 연동", "payments", { cli: "claude" });
    await t.orch.assign(t.project.id, "research", { text: "조사 시작" });
    await until("지시 전달", () => t.runner.sent.some(s => s.memberId === gemini.id));
    const conversation = t.runner.learn(gemini.id);
    await until("대화 id", () => t.store.requireMember(gemini.id).sessionId === conversation);
    // 일하는 중에 모드를 알게 됐다: 지금 끄지 않는다.
    t.runner.emit({ type: "gemini_mode", memberId: gemini.id, cycleMode: "default", sandbox: false, initial: true });
    await Bun.sleep(40);
    expect(t.runner.startsOf(gemini.id)).toHaveLength(1);
    expect(t.runner.stops).toEqual([]);
    // 턴이 끝나 쉬면 같은 대화를 이어 연다.
    t.runner.end(gemini.id);
    await until("이어 열기", () => t.runner.startsOf(gemini.id).length === 2);
    const reopened = t.runner.startsOf(gemini.id).at(-1)!;
    expect(reopened.member).toMatchObject({ geminiAutoFallback: true, sessionId: conversation });
    expect(reopened.opts.resume).toBe(true);
    // Claude 팀장에게는 이 칸이 없다.
    expect(t.runner.startsOf(claude.id).every(s => s.member.geminiAutoFallback === undefined)).toBe(true);
    expect(t.store.getAppliedConfig(claude.id)?.geminiMode).toBeUndefined();
  });
});

describe("권한 auto: 실제 모드 확인(실행기, 가짜 core + 실제 CoreRunner)", () => {
  async function runnerSetup(fake: Partial<FakeCoreOptions> = {}, deps: CoreRunnerDeps = {}, permissionMode: RunnerMember["permissionMode"] = "auto") {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-gpc-run-")));
    const claudeHome = join(home, "claude-home"), codexHome = join(home, "codex-home"), geminiHome = join(home, "gemini-home"), run = join(home, "run");
    for (const dir of [claudeHome, codexHome, geminiHome, run]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const core = await startFakeCore({ claudeHome, contextHome: home, geminiHome, ...fake });
    const member: RunnerMember = { id: "m_gem1", sessionGeneration: 1, projectId: "p_one", cli: "gemini", handle: "gem", name: "결제 연동", cwd: home, sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode, kind: "worker" };
    const opts: StartOpts = { systemPromptFile: join(run, `${member.id}.rules.md`), mcpConfigFile: join(run, `${member.id}.mcp.json`), resume: false };
    writeFileSync(opts.systemPromptFile, "너는 시험 팀장이다.\n");
    writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: ["bridge"], env: { IAMCEO_TOKEN: "secret-token", IAMCEO_URL: "http://127.0.0.1:1" } } } }), { mode: 0o600 });
    const runner = new CoreRunner({ socketPath: core.socketPath, claudeBin: "/usr/bin/false", codexBin: "/usr/bin/false", geminiBin: "/usr/bin/false", claudeHome, codexHome, geminiHome, contextHome: home },
      { pollMs: 20, rpcTimeoutMs: 2000, sendTimeoutMs: 2000, contextTimeoutMs: 300, hookShadow: false, ...deps });
    const events: RunnerEvent[] = [];
    runner.on(event => events.push(event));
    cleanups.push(async () => { await runner.shutdown(); await core.stop(); rmSync(home, { recursive: true, force: true }); });
    return { home, core, runner, member, opts, events };
  }
  const modes = (events: RunnerEvent[]) => events.filter((e): e is Extract<RunnerEvent, { type: "gemini_mode" }> => e.type === "gemini_mode");

  test("auto 가 든 터미널: 상태줄의 cycle_mode auto 를 한 번 알리고(처음), geminiMode 로 읽힌다", async () => {
    const f = await runnerSetup();
    const started = await f.runner.start(f.member, f.opts);
    expect(f.core.runs()[0]!.settings).toMatchObject({ agentMode: "auto" });
    expect(f.core.runs()[0]!.argv).not.toContain("--mode");
    // agy 는 뜨면서(쉬는 중이 되며) 상태줄을 그린다. 가짜는 손으로 그린다(띄운 시각과 같은 밀리초의 기록은 이 터미널 것으로 치지 않아 몇 번 그린다).
    await f.runner.screen({ ...f.member, paneId: started.paneId });
    await until("모드 알림", () => { f.core.drawGeminiStatus("m_gem1"); return modes(f.events).length > 0; });
    expect(modes(f.events)).toEqual([expect.objectContaining({ memberId: "m_gem1", cycleMode: "auto", sandbox: false, initial: true })]);
    expect(f.runner.geminiMode("m_gem1")).toEqual({ cycleMode: "auto", sandbox: false });
    // 같은 값이면 다시 알리지 않는다.
    f.core.drawGeminiStatus("m_gem1");
    await Bun.sleep(80);
    expect(modes(f.events)).toHaveLength(1);
  });

  test("auto 를 쓸 수 없는 agy: default(칸 없음)는 자리 잡은 뒤에만 알린다(띄운 직후의 기록은 아직 플래그를 받기 전일 수 있다)", async () => {
    const quick = await runnerSetup({ geminiAutoUnavailable: true }, { geminiModeSettleMs: 0 });
    const started = await quick.runner.start(quick.member, quick.opts);
    // agy 는 뜨면서(쉬는 중이 되며) 상태줄을 그린다. 가짜는 손으로 그린다(띄운 시각과 같은 밀리초의 기록은 이 터미널 것으로 치지 않아 몇 번 그린다).
    await quick.runner.screen({ ...quick.member, paneId: started.paneId });
    await until("모드 알림", () => { quick.core.drawGeminiStatus("m_gem1"); return modes(quick.events).length > 0; });
    expect(modes(quick.events)[0]).toMatchObject({ cycleMode: "default", initial: true });

    const slow = await runnerSetup({ geminiAutoUnavailable: true }, { geminiModeSettleMs: 60_000 });
    const second = await slow.runner.start(slow.member, slow.opts);
    await slow.runner.screen({ ...slow.member, paneId: second.paneId });
    for (let i = 0; i < 10; i++) { slow.core.drawGeminiStatus("m_gem1"); await Bun.sleep(20); }
    expect(modes(slow.events)).toEqual([]);
    expect(slow.runner.geminiMode("m_gem1")).toBeNull();
  });

  test("대신하는 모드로 띄우면 accept-edits + 터미널 샌드박스 + proceed-in-sandbox 이고, 그 모드를 알린다", async () => {
    const f = await runnerSetup();
    const started = await f.runner.start({ ...f.member, geminiAutoFallback: true }, f.opts);
    expect(f.core.runs()[0]!.settings).toMatchObject({ agentMode: "accept-edits", enableTerminalSandbox: true, toolPermission: "proceed-in-sandbox" });
    // agy 는 뜨면서(쉬는 중이 되며) 상태줄을 그린다. 가짜는 손으로 그린다(띄운 시각과 같은 밀리초의 기록은 이 터미널 것으로 치지 않아 몇 번 그린다).
    await f.runner.screen({ ...f.member, paneId: started.paneId });
    await until("모드 알림", () => { f.core.drawGeminiStatus("m_gem1"); return modes(f.events).length > 0; });
    expect(modes(f.events)[0]).toMatchObject({ cycleMode: "accept-edits", sandbox: true });
  });
});
