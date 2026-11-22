// 0.2.10 Gemini(Antigravity CLI) 기능 맞추기(핵심 갈래): 권한 auto 의 실제 모드 확인과 대신하는 모드, 결재함 도구 승인 카드, 서브에이전트 단계.
// 실제 agy 는 띄우지 않는다. 지휘 쪽은 가짜 실행기(받은 것만 적는다)로, 실행기 쪽은 가짜 core 소켓 + 실제 CoreRunner 로 돈다(tests/fixtures/core-harness.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { DEFAULT_RANKS, GEMINI_SUBAGENT_TIERS, staffConfig, type Backend, type Member } from "../shared/types.ts";
import { coreSetup, startFakeCore, type FakeCoreOptions } from "./fixtures/core-harness.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { describeToolRequest, geminiNeedsCard, geminiToolForCard, ToolPermissions, type GeminiEffectiveMode } from "../server/tool-permission.ts";
import { geminiToolHookSet } from "../server/runner/gemini-tool-hook.ts";
import { startServer, type RunningServer, type ServerContext } from "../server/http.ts";
import { PushStore } from "../server/push/store.ts";
import { VERSION } from "../server/config.ts";

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

// ---- 결재함 도구 승인 ----
describe("결재함 승인: 모드별로 agy 가 물을 종류에만 카드(Claude 의 PermissionRequest 와 같은 뜻)", () => {
  test("모드 × 종류 표", () => {
    const kinds = ["command", "edit", "edit_temp", "edit_outside", "read_temp", "read_outside", "mcp", "web"] as const;
    const asked = (mode: GeminiEffectiveMode) => kinds.filter(kind => geminiNeedsCard(kind, mode));
    expect(asked("default")).toEqual([...kinds]);
    expect(asked("accept-edits")).toEqual(["command", "edit_temp", "edit_outside", "read_temp", "read_outside", "mcp", "web"]);
    expect(asked("auto")).toEqual(["edit_outside", "read_outside", "mcp", "web"]);
    expect(asked("fallback")).toEqual(["edit_outside", "read_outside", "mcp", "web"]);
    for (const odd of [null, undefined, "", "Bash", "read"]) expect(geminiNeedsCard(odd, "default")).toBe(false);
  });
  test("연결 도구는 Claude 와 같은 mcp__서버__도구 이름과 그 인자로 보인다", () => {
    expect(geminiToolForCard("call_mcp_tool", { ServerName: "github", ToolName: "create_issue", Arguments: { title: "버그" } })).toEqual({ toolName: "mcp__github__create_issue", toolInput: { title: "버그" } });
    expect(geminiToolForCard("call_mcp_tool", { ServerName: "a b/c", ToolName: "x" }).toolName).toBe("mcp__a_b_c__x");
    expect(geminiToolForCard("run_command", { CommandLine: "ls" })).toEqual({ toolName: "run_command", toolInput: { CommandLine: "ls" } });
    expect(describeToolRequest("run_command", { CommandLine: "npm test", Cwd: "/w" })).toEqual({ action: "명령 실행", target: "npm test" });
    expect(describeToolRequest("write_file", { Path: "/w/a.env", Content: "SECRET=1\n" })).toEqual({ action: "파일 쓰기", target: "/w/a.env (9자)" });
    expect(describeToolRequest("edit_file", { Path: "/w/a.ts", Target: "a", Replacement: "b" })).toEqual({ action: "파일 고치기", target: "/w/a.ts" });
    expect(describeToolRequest("read_file", { Path: "/etc/hosts" })).toEqual({ action: "파일 읽기", target: "/etc/hosts" });
    expect(describeToolRequest("read_url_content", { Url: "https://example.com/a" })).toEqual({ action: "웹 페이지 가져오기", target: "https://example.com/a" });
    expect(describeToolRequest(...Object.values(geminiToolForCard("call_mcp_tool", { ServerName: "github", ToolName: "create_issue", Arguments: { title: "버그" } })) as [string, unknown]).action).toBe("연결 도구 쓰기(github)");
  });

  function storeFixture(cli: Member["cli"] = "gemini") {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-gpc-tp-")));
    const db = openDb(join(dir, "iamceo.db"));
    const store = new Store(db, new Bus());
    const project = store.createProject({ name: "도구 승인", cwd: dir });
    const member = store.createMember({ projectId: project.id, handle: "pay", name: "결제 연동", kind: "worker", cwd: dir, origin: "runner", backend: "core", status: "working", sessionId: crypto.randomUUID(), paneId: "pane-1", cli });
    cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    return { dir, store, member };
  }
  function permissions(store: Store, mode: () => GeminiEffectiveMode) {
    const tp = new ToolPermissions({ store, notify: () => {}, deliverNote: () => {}, geminiMode: () => mode(), ttlMs: 2_000, pollMs: 200, goneMs: 300, graceMs: 80, sweepMs: 20 });
    cleanups.push(() => tp.dispose());
    return tp;
  }
  const gemini = (toolName: string, toolInput: unknown, geminiKind: string) => ({ toolName, toolInput, sessionId: "conv", cwd: null, cli: "gemini", geminiKind, toolCallId: "call_1" });

  test("default: 명령은 카드(명령 실행·명령줄·폴더), 허용하면 훅이 allow 를 받는다. auto: 명령은 카드 없이 닫힘, 연결 도구는 카드", async () => {
    const { store, member, dir } = storeFixture();
    let mode: GeminiEffectiveMode = "default";
    const tp = permissions(store, () => mode);
    const pending = tp.request(member, gemini("run_command", { CommandLine: "npm test", Cwd: dir }, "command"));
    const card = store.listOpenToolPermissions()[0]!;
    expect(card.toolPermission).toMatchObject({ tool: "run_command", action: "명령 실행", target: "npm test", cwd: dir });
    expect(card.title).toBe("명령 실행: npm test");
    expect(card.options.map(o => o.k)).toEqual(["allow", "deny"]);
    tp.answer(card.id, { choice: "allow" });
    expect(await pending).toEqual({ id: card.id, state: "allow" });

    mode = "auto";
    expect(await tp.request(member, gemini("run_command", { CommandLine: "rm -rf build" }, "command"))).toEqual({ id: null, state: "closed" });
    expect(await tp.request(member, gemini("write_file", { Path: join(dir, "a.txt"), Content: "x" }, "edit"))).toEqual({ id: null, state: "closed" });
    expect(store.listOpenToolPermissions()).toEqual([]);
    const mcp = tp.request(member, gemini("call_mcp_tool", { ServerName: "github", ToolName: "create_issue", Arguments: { title: "버그" } }, "mcp"));
    const mcpCard = store.listOpenToolPermissions()[0]!;
    expect(mcpCard.toolPermission).toMatchObject({ tool: "mcp__github__create_issue", action: "연결 도구 쓰기(github)" });
    tp.answer(mcpCard.id, { choice: "deny", note: "이슈는 내가 만든다" });
    expect(await mcp).toEqual({ id: mcpCard.id, state: "deny", message: "대표가 결재함에서 거절했습니다. 대표 메모: \"이슈는 내가 만든다\"" });
  });

  test("Gemini 카드는 터미널 상태(승인 창 앞→다른 상태)로 닫지 않는다: 서브에이전트의 다른 창이 닫힌 것을 이 카드의 답으로 읽지 않게. 터미널이 끝나면 닫는다", async () => {
    const { store, member } = storeFixture();
    const tp = permissions(store, () => "default");
    const pending = tp.request(member, gemini("run_command", { CommandLine: "make" }, "command"));
    const card = store.listOpenToolPermissions()[0]!;
    tp.memberStatus(member.id, "blocked");
    tp.memberStatus(member.id, "working");
    // 터미널에서 답한 것으로 보는 유예(graceMs 80)를 넘겨도 열려 있다(한 번의 기다림 pollMs 200 안에서 본다).
    await Bun.sleep(130);
    expect(store.requireDecision(card.id).status).toBe("open");
    tp.memberStatus(member.id, "gone");
    expect(await pending).toEqual({ id: card.id, state: "closed" });
    expect(store.requireDecision(card.id).status).toBe("closed");
  });

  test("Gemini 가 아닌 팀장이 Gemini 요청을 올리면 카드를 열지 않는다. Claude 요청(새 칸 없음)은 예전 그대로다", async () => {
    const { store, member } = storeFixture("claude");
    const tp = permissions(store, () => "default");
    expect(await tp.request(member, gemini("run_command", { CommandLine: "ls" }, "command"))).toEqual({ id: null, state: "closed" });
    const pending = tp.request(member, { toolName: "Bash", toolInput: { command: "ls" }, sessionId: "s", cwd: null });
    const card = store.listOpenToolPermissions()[0]!;
    expect(card.toolPermission).toMatchObject({ tool: "Bash", action: "명령 실행", target: "ls" });
    // Claude 카드는 예전처럼 승인 창이 닫히면(터미널에서 답함) 닫힌다.
    tp.memberStatus(member.id, "blocked");
    tp.memberStatus(member.id, "working");
    expect(await pending).toEqual({ id: card.id, state: "closed" });
  });

  test("지금 모드: 띄운 뜻(권한 방식·대신하는 모드)에서 시작해 실행기가 알려 준 실제 모드를 따른다", async () => {
    const t = setup({ permissionMode: "auto" });
    const member = await t.add("자료 조사", "research", { cli: "gemini" });
    const mode = () => t.priv<GeminiEffectiveMode>("geminiEffectiveMode", t.store.requireMember(member.id));
    expect(mode()).toBe("auto");
    t.runner.modes.set(member.id, { cycleMode: "default", sandbox: false });
    expect(mode()).toBe("default");
    t.runner.modes.set(member.id, { cycleMode: "auto", sandbox: true });
    expect(mode()).toBe("auto");
    t.runner.modes.set(member.id, { cycleMode: "plan", sandbox: true });
    expect(mode()).toBe("default");
    // 사람이 Shift+Tab 으로 고른 accept-edits(대신하는 모드로 띄운 세션이 아님).
    t.runner.modes.set(member.id, { cycleMode: "accept-edits", sandbox: true });
    expect(mode()).toBe("accept-edits");
    // 대신하는 모드로 띄운 세션.
    t.runner.modes.delete(member.id);
    t.runner.emit({ type: "gemini_mode", memberId: member.id, cycleMode: "default", sandbox: false, initial: true });
    await until("대신하는 모드로 다시 띄움", () => t.store.getAppliedConfig(member.id)?.geminiMode === "auto-fallback");
    expect(mode()).toBe("fallback");
    t.runner.modes.set(member.id, { cycleMode: "accept-edits", sandbox: true });
    expect(mode()).toBe("fallback");
    t.runner.modes.set(member.id, { cycleMode: "accept-edits", sandbox: false });
    expect(mode()).toBe("accept-edits");
    t.store.patchSettings({ permissionMode: "default" });
    t.runner.modes.delete(member.id);
    expect(mode()).toBe("default");
  });
});

describe("결재함 승인: 실제 훅 스크립트 → 실제 서버(/agent/permission) → 대표 답", () => {
  test("Gemini 팀장의 명령이 카드로 뜨고, 대표가 허용하면 훅이 auto_approve(바로잡은 Cwd 와 함께)를 낸다. 옛 칸만 보내는 요청도 받는다", async () => {
    const isolated = createIsolatedRuntime();
    const env = { IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
      IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin, IAMCEO_GEMINI_BIN: isolated.bins.geminiBin };
    updateConfigFile({ accessCode: "gemini-permission-test", hosts: ["127.0.0.1"] }, env);
    const config = loadConfig(env);
    const bus = new Bus();
    const store = new Store(openDb(config.dbPath), bus);
    store.patchSettings({ boardTidyHours: 0, permissionMode: "default" });
    const runner = new FakeRunner();
    const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", runner]]), providerHomes: isolated.providerHomes, timings: { tickMs: 60_000, healthMs: 60_000 } });
    const context: ServerContext = { config, store, bus, orch, delivery: orch.deliveryRecovery, push: { store: new PushStore(store.db), providers: () => [] }, daemon: () => ({ ready: true, buildId: "gemini-permission", version: VERSION }) };
    let server: RunningServer | undefined;
    do { if (server) await server.stop(); server = await startServer(context); } while (server.port === 7878);
    const base = `http://127.0.0.1:${server.port}`;
    orch.setServerUrl(base);
    cleanups.push(async () => { await server!.stop(); await orch.shutdown(); store.db.close(); await isolated.stop(); });
    const project = store.createProject({ name: "도구 승인", cwd: isolated.paths.work });
    const member = store.createMember({ projectId: project.id, handle: "gem", name: "자료 조사", kind: "worker", backend: "core", origin: "runner", status: "working", sessionId: crypto.randomUUID(), paneId: "fake:gem", cwd: isolated.paths.work, cli: "gemini" });
    // 팀장 열쇠가 든 MCP 설정과 도구 훅(운영과 같은 함수).
    const run = join(config.home, "run");
    const own = join(run, `${member.id}.gemini`);
    mkdirSync(own, { recursive: true, mode: 0o700 });
    const mcpConfigFile = join(own, "mcp.json");
    writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: [], env: { IAMCEO_URL: base, IAMCEO_TOKEN: store.getMemberToken(member.id) } } } }), { mode: 0o600 });
    const injectDir = join(own, "agy", member.id);
    mkdirSync(injectDir, { recursive: true });
    const set = geminiToolHookSet({ runDir: run, cwd: isolated.paths.work, injectDir, permission: { mcpConfigFile } });
    const command = set.PreToolUse![0]!.hooks[0]!.command;
    const input = JSON.stringify({ conversationId: "conv-1", cwd: injectDir, hookEventName: "PreToolUse", stepIdx: 2, toolCall: { id: "call_9", name: "run_command", args: { CommandLine: "bun test", WaitMsBeforeAsync: 5000 } }, workspacePaths: [injectDir, isolated.paths.work] });
    const child = Bun.spawn(["/bin/sh", "-c", command], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const output = new Response(child.stdout).text();
    await until("카드", () => store.listOpenToolPermissions().length === 1);
    const card = store.listOpenToolPermissions()[0]!;
    expect(card.toolPermission).toMatchObject({ tool: "run_command", action: "명령 실행", target: "bun test", cwd: isolated.paths.work });
    const answer = await fetch(`${base}/api/decisions/${card.id}/answer`, { method: "POST", headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json" }, body: JSON.stringify({ choice: "allow" }) });
    expect(answer.status).toBe(200);
    expect(JSON.parse(await output)).toEqual({ decision: "auto_approve", overwrite: { Cwd: isolated.paths.work } });
    expect(await child.exited).toBe(0);
    // auto 로 바꾸면 같은 명령은 카드 없이 agy 에 맡긴다(바로잡은 Cwd 만).
    store.patchSettings({ permissionMode: "auto" });
    const second = Bun.spawn(["/bin/sh", "-c", command], { stdin: new Blob([input]), stdout: "pipe" });
    expect(JSON.parse(await new Response(second.stdout).text())).toEqual({ decision: "allow", overwrite: { Cwd: isolated.paths.work } });
    expect(store.listOpenToolPermissions()).toEqual([]);
    // 옛 Claude 훅의 요청 모양(새 칸 없음)도 그대로 받는다.
    const token = store.getMemberToken(member.id);
    const legacy = fetch(`${base}/agent/permission`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ toolName: "Bash", toolInput: { command: "ls" }, sessionId: "s", cwd: null }) });
    await until("옛 요청 카드", () => store.listOpenToolPermissions().length === 1);
    const old = store.listOpenToolPermissions()[0]!;
    await fetch(`${base}/api/decisions/${old.id}/answer`, { method: "POST", headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json" }, body: JSON.stringify({ choice: "deny" }) });
    expect(await (await legacy).json()).toMatchObject({ state: "deny" });
  });
});

// ---- 서브에이전트 단계 ----
describe("서브에이전트 단계: Gemini 는 모델 이름 대신 단계(flash_lite·flash·pro)를 고른다", () => {
  test("staffConfig: 단계만 넘긴다(단계가 아닌 옛 값은 inherit = null), effort 는 늘 null. 다른 CLI 는 그대로", () => {
    const settings = (staff: { model: string | null; effort: null | "low" }) => ({ ranks: { ...DEFAULT_RANKS, staff: { model: "haiku", effort: "low" as const } }, codexRanks: { ...DEFAULT_RANKS, staff: { model: "gpt-6.1-terra", effort: null } }, geminiRanks: { ...DEFAULT_RANKS, staff } });
    for (const tier of GEMINI_SUBAGENT_TIERS) expect(staffConfig("gemini", settings({ model: tier, effort: null }))).toEqual({ model: tier, effort: null });
    for (const odd of ["gemini-3.8-flash", "inherit", "Flash", null]) expect(staffConfig("gemini", settings({ model: odd, effort: "low" }))).toEqual({ model: null, effort: null });
    expect(staffConfig("claude", settings({ model: "pro", effort: null }))).toEqual({ model: "haiku", effort: "low" });
    expect(staffConfig("codex", settings({ model: "pro", effort: null }))).toEqual({ model: "gpt-6.1-terra", effort: null });
  });

  test("설정: 단계만 받고(모델 이름은 400 gemini_staff_tier_unknown, effort 는 400), 바꾸면 쉬는 Gemini 팀장을 그 단계로 다시 띄우고 지침에 한 줄 싣는다", async () => {
    const t = setup({ permissionMode: "default" });
    const gemini = await t.add("자료 조사", "research", { cli: "gemini" });
    const claude = await t.add("결제 연동", "payments", { cli: "claude" });
    expect(t.runner.startsOf(gemini.id)[0]!.member.subagentModel).toBeNull();
    await expect(t.orch.updateSettings({ geminiRanks: { staff: { model: "gemini-3.8-flash" } } })).rejects.toMatchObject({ status: 400, code: "gemini_staff_tier_unknown" });
    await expect(t.orch.updateSettings({ geminiRanks: { staff: { model: "flash", effort: "low" } } })).rejects.toMatchObject({ status: 400, code: "effort_unsupported" });
    const saved = await t.orch.updateSettings({ geminiRanks: { staff: { model: "flash_lite" } } });
    expect(saved.geminiRanks.staff).toEqual({ model: "flash_lite", effort: null });
    // 말을 걸기 전의 Gemini 팀장은 곧바로 새 설정으로 다시 뜬다(적용 기록의 staffModel 이 달라졌다). Claude 팀장은 그대로다.
    await until("단계로 다시 띄움", () => t.runner.startsOf(gemini.id).length === 2);
    const relaunched = t.runner.startsOf(gemini.id).at(-1)!;
    expect(relaunched.member.subagentModel).toBe("flash_lite");
    expect(t.store.getAppliedConfig(gemini.id)).toMatchObject({ staffModel: "flash_lite", staffEffort: null });
    expect(t.runner.startsOf(claude.id)).toHaveLength(1);
    const rules = readFileSync(relaunched.opts.systemPromptFile, "utf8");
    expect(rules).toContain("- 서브에이전트(invoke_subagent)의 단계(Model)는 대표가 정한 flash_lite 다.");
    // 기본값(inherit)으로 되돌리면 그 줄도 없다.
    await t.orch.updateSettings({ geminiRanks: { staff: { model: null } } });
    await until("기본값으로 다시 띄움", () => t.runner.startsOf(gemini.id).length === 3);
    expect(t.runner.startsOf(gemini.id).at(-1)!.member.subagentModel).toBeNull();
    expect(readFileSync(t.runner.startsOf(gemini.id).at(-1)!.opts.systemPromptFile, "utf8")).not.toContain("invoke_subagent");
  });
});

describe("운영 배선(가짜 core + 실제 CoreRunner + createOrchestrator)", () => {
  test("설정을 바꾸기 전에 미리 해 보는 검사가 떠 있는 Gemini 세션의 승인 훅을 지우지 않는다(다시 띄우기가 막혀도 승인 카드가 남는다)", async () => {
    const t = await coreSetup({});
    cleanups.push(() => t.close());
    t.store.patchSettings({ permissionMode: "default" });
    const member = (await t.orch.addMember(t.project.id, { name: "자료 조사", handle: "research", role: "조사", cli: "gemini" })).member;
    await t.idle(member.id);
    const configFile = join(t.home, "run", `${member.id}.gemini`, "agy", `${member.id}.hook.json`);
    const permissionOf = () => JSON.parse(readFileSync(configFile, "utf8")).permission;
    expect(permissionOf()).toEqual({ mcpConfigFile: join(t.home, "run", `${member.id}.gemini`, "mcp.json") });
    // 입력칸에 대표가 쓰던 글이 있어 옛 터미널을 끝내지 못한다: 미리 해 보는 검사(훅 설정을 다시 쓴다)만 돌고 다시 띄우기는 막힌다.
    t.core.setDraft(member.id, "쓰던 글");
    await t.orch.changeMemberModel(member.id, { modelOverride: "gemini-3.8-flash" }).catch(() => null);
    expect(t.runs(member.id)).toHaveLength(1);
    expect(permissionOf()).toEqual({ mcpConfigFile: join(t.home, "run", `${member.id}.gemini`, "mcp.json") });
  });
});
