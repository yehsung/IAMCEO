// Gemini(Antigravity CLI) 팀장을 실제 CoreRunner 로 한 바퀴 돌린다: 띄우기 → 입력 → 턴 끝 → 대화 id 알아내기(session 사건) → 이어 열기.
// 실제 herdr-core·agy 는 띄우지 않는다. 가짜 core(tests/fixtures/core-harness.ts)가 소켓 약속과 그 안의 agy 를 흉내 낸다
// (--conversation·--add-dir·--settings 읽기, 주입 폴더의 MCP 설정, 상태줄 기록·훅 기록 쓰기). agy 실행 파일 자리는 /usr/bin/false,
// agy 의 자료 폴더는 임시 폴더다. gemini 값이 Claude·Codex 가지로 조용히 떨어지지 않는지도 여기서 본다.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreRunner, codexExecutionPreference, geminiMayHaveConversed, type CoreCompactState, type CoreRunnerDeps } from "../server/runner/core.ts";
import { CoreError } from "../server/runner/core-client.ts";
import { geminiStatusFromPayload, geminiStatusPath, readGeminiStatus } from "../server/runner/gemini-status.ts";
import { GEMINI_FOLDER_TRUST_CODE, GEMINI_SETUP_CODE, GEMINI_SETUP_NOTE } from "../server/runner/gemini-screen.ts";
import { geminiHookEventsDir, geminiHooksRecordTurns } from "../server/runner/gemini-hooks.ts";
import { GEMINI_LAUNCH_LABEL } from "../server/runner/providers.ts";
import { geminiStatusLineLaunch } from "../server/runner/gemini-statusline.ts";
import type { DeliveryDispatch } from "../server/service-contracts.ts";
import type { DeliveryProbe, RunnerEvent, RunnerMember, StartOpts } from "../server/runner/types.ts";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import { composerScreen, coreSetup, geminiComposerScreen, primesMcp, rejection, startFakeCore, type FakeCore, type FakeCoreCall, type FakeCoreOptions } from "./fixtures/core-harness.ts";

const ITEM = "#iamceo_AAAAAAAAAAAAAAAAAAAAAA";
const ITEM2 = "#iamceo_CCCCCCCCCCCCCCCCCCCCCC";
const BUNDLE = "#iamceo_b_BBBBBBBBBBBBBBBBBBBBBB";
const FAKE_BIN = "/usr/bin/false";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

interface Fixture {
  home: string; geminiHome: string; core: FakeCore; opts: StartOpts; member: RunnerMember; events: RunnerEvent[];
  runner: CoreRunner; newRunner(deps?: CoreRunnerDeps, options?: Record<string, unknown>): CoreRunner;
}
async function setup(extra: Partial<RunnerMember> = {}, fake: Partial<FakeCoreOptions> = {}, deps: CoreRunnerDeps = {}): Promise<Fixture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-grun-")));
  const claudeHome = join(home, "claude-home"), codexHome = join(home, "codex-home"), geminiHome = join(home, "gemini-home"), run = join(home, "run");
  for (const dir of [claudeHome, codexHome, geminiHome, run]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const core = await startFakeCore({ claudeHome, contextHome: home, geminiHome, ...fake });
  const member: RunnerMember = { id: "m_gem1", sessionGeneration: 1, projectId: "p_one", cli: "gemini", handle: "gem", name: "결제 연동", cwd: home, sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "bypassPermissions", kind: "worker", ...extra };
  const opts: StartOpts = { systemPromptFile: join(run, `${member.id}.rules.md`), mcpConfigFile: join(run, `${member.id}.mcp.json`), resume: false };
  writeFileSync(opts.systemPromptFile, "너는 시험 팀장이다.\n\n## 보고\n- 끝나면 보고한다.\n");
  writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: ["bridge"], env: { IAMCEO_TOKEN: "secret-token", IAMCEO_URL: "http://127.0.0.1:1" } } } }), { mode: 0o600 });
  const events: RunnerEvent[] = [];
  const runners: CoreRunner[] = [];
  const newRunner = (more: CoreRunnerDeps = {}, options: Record<string, unknown> = {}) => {
    const runner = new CoreRunner({ socketPath: core.socketPath, claudeBin: FAKE_BIN, codexBin: FAKE_BIN, geminiBin: FAKE_BIN, claudeHome, codexHome, geminiHome, contextHome: home, ...options },
      { pollMs: 20, rpcTimeoutMs: 2000, sendTimeoutMs: 2000, contextTimeoutMs: 300, hookShadow: false, ...deps, ...more });
    runners.push(runner);
    return runner;
  };
  const runner = newRunner();
  runner.on(event => events.push(event));
  cleanups.push(async () => { await Promise.all(runners.map(r => r.shutdown())); await core.stop(); rmSync(home, { recursive: true, force: true }); });
  return { home, geminiHome, core, opts, member, events, runner, newRunner };
}
async function until<T>(what: string, read: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`시간 초과: ${what}`);
    await Bun.sleep(10);
  }
}
const ofType = <K extends RunnerEvent["type"]>(events: RunnerEvent[], type: K) => events.filter((e): e is Extract<RunnerEvent, { type: K }> => e.type === type);
/** 한 턴을 넣고 끝날 때까지 기다린다. 끝난 뒤의 대화 id 를 돌려준다. */
async function turn(f: Fixture, member: RunnerMember, text: string): Promise<string> {
  const ended = ofType(f.events, "turn_end").length;
  expect(await f.runner.send(member, text, f.opts)).toMatchObject({ ok: true });
  await until("턴 끝", () => ofType(f.events, "turn_end").length > ended);
  return (await until("대화 id", () => f.runner.observationState(member.id)?.identity.sessionId));
}

/** 이 팀장의 지금 터미널에 붙은 띄우기 값(라벨). */
const launchOf = (f: Fixture, memberId = "m_gem1") => f.core.terminalOf(memberId)!.labels[GEMINI_LAUNCH_LABEL]!;
/** 상태줄 래퍼가 하듯 기록 파일을 둔다. launch 는 그 기록을 쓴 터미널의 띄우기 값이다(없으면 값을 받지 않은 명령이 쓴 기록). */
function putStatus(f: Fixture, payload: Record<string, unknown>, launch: string | null, at = new Date(Date.now() + 5), memberId = "m_gem1") {
  mkdirSync(join(f.home, "context", "gemini"), { recursive: true });
  writeFileSync(geminiStatusPath(f.home, memberId), JSON.stringify(geminiStatusFromPayload(memberId, payload, at, launch)));
}
/** 훅 기록 스크립트가 남기는 모양의 줄을 사건 파일에 덧붙인다(가짜 agy 를 거치지 않고: 예전 터미널·다른 봉투의 줄을 만들 때). */
function putHookLine(f: Fixture, entry: Record<string, unknown>, memberId = "m_gem1") {
  const dir = geminiHookEventsDir(f.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, `${memberId}.jsonl`), `${JSON.stringify({ v: 1, cli: "gemini", at: Date.now(), ...entry })}\n`, { mode: 0o600 });
}
const sessionsOf = (events: RunnerEvent[], memberId = "m_gem1") => ofType(events, "session").filter(e => e.memberId === memberId).map(e => e.sessionId);

describe("실행 환경", () => {
  test("서버가 SSH 세션에서 떴어도 Gemini 터미널에는 SSH_CLIENT·SSH_TTY·SSH_CONNECTION 을 넘기지 않는다(SSH_AUTH_SOCK 은 둔다)", async () => {
    const saved = { SSH_CLIENT: process.env.SSH_CLIENT, SSH_TTY: process.env.SSH_TTY, SSH_CONNECTION: process.env.SSH_CONNECTION, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
    Object.assign(process.env, { SSH_CLIENT: "10.0.0.2 50000 22", SSH_TTY: "/dev/ttys009", SSH_CONNECTION: "10.0.0.2 50000 10.0.0.1 22", SSH_AUTH_SOCK: "/private/tmp/agent.sock" });
    try {
      const f = await setup();
      await f.runner.start(f.member, f.opts);
      const env = f.core.runs()[0]!.env;
      expect(env.SSH_CLIENT).toBeUndefined();
      expect(env.SSH_TTY).toBeUndefined();
      expect(env.SSH_CONNECTION).toBeUndefined();
      expect(env.SSH_AUTH_SOCK).toBe("/private/tmp/agent.sock");
      expect(env.AGY_CLI_HIDE_ACCOUNT_INFO).toBe("1");
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});

describe("한 바퀴: 띄우기 → 입력 → 턴 끝 → session 사건 → 이어 열기", () => {
  test("새 세션은 id 없이 뜨고, 첫 턴 뒤 상태줄 기록으로 id 를 알아내 session 사건을 낸다. 그 id 로 이어 연다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    expect(started.sessionId).toBeNull();
    expect(started.paneId).toBeTruthy();
    const run = f.core.runs()[0]!;
    // agy 로 뜬다: 실행 파일은 geminiBin, 인자는 agy 의 것, 라벨의 cli 는 gemini.
    expect(run.argv[0]).toBe(FAKE_BIN);
    expect(run.cli).toBe("gemini");
    expect(run.labels["iamceo.cli"]).toBe("gemini");
    expect(run.argv).toContain("--add-dir");
    expect(run.argv).toContain("--dangerously-skip-permissions");
    expect(run.conversationFlag).toBeNull();
    expect(run.addDir).toBe(join(f.home, "run", "agy", "m_gem1"));
    expect(run.env).toMatchObject({ AGY_CLI_OSC7501: "on", AGY_CLI_HIDE_ACCOUNT_INFO: "1", IAMCEO_MEMBER_ID: "m_gem1" });
    // Codex 의 세션 묶기 표지·Claude 의 세션 라벨은 없다.
    expect(run.labels["iamceo.binding"]).toBeUndefined();
    expect(run.labels["iamceo.session"]).toBeUndefined();
    // 띄우기 값: 터미널 라벨과 상태줄 명령의 인자에 같은 임의 값이 실린다.
    expect(run.labels[GEMINI_LAUNCH_LABEL]).toMatch(/^[0-9a-f]{32}$/);
    expect(geminiStatusLineLaunch((run.settings!.statusLine as { command: string }).command)).toBe(run.labels[GEMINI_LAUNCH_LABEL]!);
    expect(run.argv.join(" ")).not.toContain("secret-token");
    expect(JSON.stringify(run.env)).not.toContain("secret-token");
    expect(f.core.terminalOf("m_gem1")!.status).toMatchObject({ state: "idle", app: "antigravity" });
    expect(ofType(f.events, "session")).toEqual([]);

    const id = await turn(f, f.member, `첫 지시입니다 ${ITEM}`);
    // 받은 글에 Codex 의 세션 묶기 줄·Claude 명령이 붙지 않는다(병렬 선호를 정하지 않았으면 앞 문구도 없다).
    expect(f.core.turns("m_gem1").map(t => t.prompt)).toEqual([`첫 지시입니다 ${ITEM}`]);
    expect(id).toBe(f.core.runs()[0]!.sessionId!);
    expect(ofType(f.events, "session").map(e => e.sessionId)).toEqual([id]);
    expect(ofType(f.events, "turn_end").at(-1)).toMatchObject({ memberId: "m_gem1", isError: false });
    expect(readGeminiStatus(f.home, "m_gem1")).toMatchObject({ conversationId: id, launch: run.labels[GEMINI_LAUNCH_LABEL]! });
    // 이어 열 대화가 있는가: agy 자료 폴더의 conversations/<id>.db 로 본다.
    expect(f.runner.sessionExists({ ...f.member, sessionId: id })).toBe(true);
    expect(f.runner.sessionExists({ ...f.member, sessionId: "no-such-conversation" })).toBe(false);
    expect(f.runner.sessionExists(f.member)).toBe(false);

    // 재우고 같은 대화로 이어 연다.
    const known = { ...f.member, sessionId: id, paneId: started.paneId };
    await f.runner.stop(known);
    const resumed = await f.runner.start({ ...known, paneId: null }, { ...f.opts, resume: true });
    expect(resumed.sessionId).toBe(id);
    const second = f.core.runs()[1]!;
    expect(second.conversationFlag).toBe(id);
    expect(second.argv.slice(1, 3)).toEqual(["--conversation", id]);
    expect(second.sessionId).toBe(id);
    expect(second.labels["iamceo.session"]).toBeUndefined();
    // 띄울 때마다 새 값이다.
    expect(second.labels[GEMINI_LAUNCH_LABEL]).toMatch(/^[0-9a-f]{32}$/);
    expect(second.labels[GEMINI_LAUNCH_LABEL]).not.toBe(run.labels[GEMINI_LAUNCH_LABEL]);
    expect(await turn(f, { ...known, paneId: resumed.paneId }, "둘째 지시")).toBe(id);
    // 같은 대화다: id 가 바뀌었다는 사건은 없다.
    expect(new Set(ofType(f.events, "session").map(e => e.sessionId))).toEqual(new Set([id]));
    expect(f.core.turns("m_gem1")).toHaveLength(2);
  });

  test("없는 id 로 이어 열면 agy 가 새 대화를 연다: 새 id 를 상태줄 기록으로 잡아 session 사건을 낸다", async () => {
    const f = await setup({ sessionId: "gone-conversation" });
    expect(f.runner.sessionExists(f.member)).toBe(false);
    const started = await f.runner.start(f.member, { ...f.opts, resume: true });
    // 띄울 때는 넘긴 id 그대로다(agy 는 오류로 끝나지 않는다).
    expect(started.sessionId).toBe("gone-conversation");
    expect(f.core.runs()[0]!.conversationFlag).toBe("gone-conversation");
    expect(f.core.terminalOf("m_gem1")!.state).toBe("live");
    expect(f.core.screenOf("m_gem1")).toContain('warning: conversation "gone-conversation" not found');
    const id = await turn(f, f.member, "이어서 해 주세요");
    expect(id).not.toBe("gone-conversation");
    expect(id).toBe(f.core.runs()[0]!.sessionId!);
    expect(ofType(f.events, "session").map(e => e.sessionId)).toEqual(["gone-conversation", id]);
    // 총괄이 새 id 로 바꾼 뒤의 호출이 그대로 통한다(터미널 라벨에 옛 id 를 박아 두지 않았다).
    const current = { ...f.member, sessionId: id, paneId: started.paneId };
    expect(await turn(f, current, "한 번 더")).toBe(id);
    // 서버를 다시 켠 것처럼 새 실행기가 같은 터미널에 다시 붙는다. 옛 id 라벨이 있었다면 '세션이 바뀜'으로 거절됐다.
    const again = f.newRunner();
    expect(await again.reattachOwned(current)).toMatchObject({ outcome: "rejoined", started: { sessionId: id, paneId: started.paneId } });
  });

  test("띄우는 중에 본 새 id 는 start 가 돌아온 뒤에 알린다(돌아온 결과의 옛 id 가 새 id 를 덮지 않게)", async () => {
    const f = await setup();
    // 다른 팀장을 먼저 띄워 관측 타이머가 돌고 있게 한다.
    await f.runner.start({ ...f.member, id: "m_gem0" }, f.opts);
    const target = { ...f.member, sessionId: "old-conversation" };
    let held: FakeCoreCall | null = null;
    f.core.intercept(call => {
      const terminal = f.core.terminalOf("m_gem1");
      if (call.method !== "terminal.read" || held || !terminal || call.params.terminal !== terminal.address) return undefined;
      held = call;
      return "drop";
    });
    // 붙는 중의 첫 화면 읽기를 붙잡아 둔다: start 는 아직 돌아오지 않았다.
    const starting = f.runner.start(target, { ...f.opts, resume: true });
    const read = await until("붙는 중", () => held);
    // 그 사이 agy 가 없는 id 대신 새 대화를 열었다고 상태줄에 알린다(이 터미널의 상태줄 명령이 쓴 기록).
    putStatus(f, { conversation_id: "new-conversation" }, launchOf(f));
    await Bun.sleep(150);
    const sessions = () => ofType(f.events, "session").filter(e => e.memberId === "m_gem1").map(e => e.sessionId);
    expect(sessions()).toEqual([]);
    f.core.intercept(null);
    expect(f.core.answer(read, { result: { text: f.core.screenOf("m_gem1"), complete: true, how: "screen" } })).toBe(true);
    const started = await starting;
    expect(started.sessionId).toBe("old-conversation");
    expect(sessions()).toEqual(["old-conversation"]);
    // 돌아온 뒤의 관측이 새 id 를 알린다.
    await until("새 id", () => sessions().length === 2);
    expect(sessions()).toEqual(["old-conversation", "new-conversation"]);
    expect(f.runner.observationState("m_gem1")?.identity.sessionId).toBe("new-conversation");
  });

  test("띄우기 전의 상태줄 기록(같은 팀장의 예전 세션)은 새 세션의 id 로 읽지 않는다", async () => {
    const f = await setup();
    const path = geminiStatusPath(f.home, "m_gem1");
    mkdirSync(join(f.home, "context", "gemini"), { recursive: true });
    writeFileSync(path, JSON.stringify(geminiStatusFromPayload("m_gem1", { conversation_id: "stale-conversation", context_window: { used_percentage: 77 } }, new Date(Date.now() - 60_000))));
    const started = await f.runner.start(f.member, f.opts);
    await f.runner.screen({ ...f.member, paneId: started.paneId });
    await Bun.sleep(80);
    expect(ofType(f.events, "session")).toEqual([]);
    expect(f.runner.observationState("m_gem1")?.identity.sessionId).toBeNull();
    expect(f.runner.logWrittenAt("m_gem1")).toBeNull();
    const id = await turn(f, f.member, "새 대화");
    expect(id).not.toBe("stale-conversation");
    expect(ofType(f.events, "session").map(e => e.sessionId)).toEqual([id]);
  });

  test("대화가 돌았는데 id 를 알기 전에 터미널이 사라졌으면 다시 띄우기를 session_unknown 으로 거절한다(조용히 새 대화가 되지 않게)", async () => {
    // 상태줄 기록이 남지 않는 환경: 턴은 돌았지만 대화 id 를 끝내 알지 못한다.
    const f = await setup({}, { contextHome: undefined });
    const started = await f.runner.start(f.member, f.opts);
    const ended = ofType(f.events, "turn_end").length;
    expect(await f.runner.send(f.member, "첫 지시입니다", f.opts)).toMatchObject({ ok: true });
    await until("턴 끝", () => ofType(f.events, "turn_end").length > ended);
    expect(f.runner.observationState("m_gem1")?.identity.sessionId).toBeNull();
    f.core.exit("m_gem1", 1);
    await until("사라짐 관측", () => f.events.some(e => e.type === "status" && e.status === "gone"));
    const before = f.core.count("terminal.run");
    const lost = await rejection(f.runner.start({ ...f.member, paneId: null }, f.opts));
    expect(lost).toBeInstanceOf(CoreError);
    expect((lost as CoreError).kind).toBe("session_unknown");
    expect((lost as CoreError).message).toContain("Antigravity CLI terminal is gone and its native session id is unknown");
    // 저장된 칸 번호만 남은 경우(서버를 다시 켠 뒤): 그 터미널을 지켜본 적이 없어 디스크의 근거로 가린다. 훅 줄이 남아 있으면 대화가 있었다.
    putHookLine(f, { event: "PreInvocation", conversationId: "conversation-nobody-recorded", invocation: 0, markers: [], chars: 6 });
    const other = f.newRunner();
    expect(((await rejection(other.start({ ...f.member, paneId: started.paneId }, f.opts))) as CoreError).kind).toBe("session_unknown");
    expect(f.core.count("terminal.run")).toBe(before);
    // 이어 열기인데 id 를 모르는 것도 거절이다.
    expect(((await rejection(other.start({ ...f.member, id: "m_gem2", paneId: null }, { ...f.opts, resume: true }))) as CoreError).kind).toBe("session_unknown");
  });

  test("한 번도 대화하지 않은 터미널은 사라지거나 재워져도 잃을 대화가 없다: 막지 않고 새 세션으로 다시 띄운다", async () => {
    // agy 는 첫 글을 받을 때 대화를 만든다. 지시를 받기 전에 재운 팀장을 '앞 대화를 잃었다'고 막으면 다시 열 길이 새 세션 시작뿐이다.
    const f = await setup();
    await f.runner.start(f.member, f.opts);
    f.core.exit("m_gem1", 1);
    await until("사라짐 관측", () => f.events.some(e => e.type === "status" && e.status === "gone"));
    const again = await f.runner.start({ ...f.member, paneId: null }, f.opts);
    expect(again.sessionId).toBeNull();
    expect(f.core.count("terminal.run")).toBe(2);
    // 쉬는 중에 재운 경우도 같다.
    await f.runner.stop({ ...f.member, paneId: again.paneId });
    const third = await f.runner.start({ ...f.member, paneId: null }, f.opts);
    expect(third.sessionId).toBeNull();
    expect(f.core.count("terminal.run")).toBe(3);
  });

  test("geminiMayHaveConversed: 턴이 끝난 적이 있거나, 도는 중이거나, 넣은 글을 기다리면 대화가 있을 수 있다. 쉬는 중·보고 없음·첫 설정 화면은 없다", () => {
    expect(geminiMayHaveConversed({ turn: 0, status: { state: "idle" } }, false)).toBe(false);
    expect(geminiMayHaveConversed({ status: { state: "done" } }, false)).toBe(false);
    expect(geminiMayHaveConversed({ turn: 0 }, false)).toBe(false);
    expect(geminiMayHaveConversed({ turn: 0, status: { state: "blocked", kind: "question", msg: "RmluaXNoIHNldHVw" } }, false)).toBe(false);
    expect(geminiMayHaveConversed({ turn: 0, status: { state: "blocked", kind: "auth", msg: "U2lnbiBpbiByZXF1aXJlZA==" } }, false)).toBe(false);
    expect(geminiMayHaveConversed({ turn: 1, status: { state: "idle" } }, false)).toBe(true);
    expect(geminiMayHaveConversed({ turn: 0, status: { state: "idle" } }, true)).toBe(true);
    expect(geminiMayHaveConversed({ turn: 0, status: { state: "working" } }, false)).toBe(true);
    expect(geminiMayHaveConversed({ turn: 0, status: { state: "blocked", kind: "permission" } }, false)).toBe(true);
    expect(geminiMayHaveConversed({ turn: 0, status: { state: "error" } }, false)).toBe(true);
  });
});

describe("대화 id 의 둘째 근거: 훅 기록", () => {
  const iso = () => new Date().toISOString();
  /** 저장소에 남은 봉투(서버가 그 터미널에 넣은 전달 묶음). */
  const envelope = (terminalId: string, bundleMarker: string, generation = 1): DeliveryDispatch => ({
    dispatchId: crypto.randomUUID(), memberId: "m_gem1", projectId: "p_one", cli: "gemini", backend: "core", markers: [{ deliveryId: "d1", marker: ITEM }], bundleMarker,
    wireText: "", wireSha256: "0".repeat(64), items: [{ deliveryId: "d1", ordinal: 0, sourceRevision: null }], transportState: "accepted", submitAttempts: 0, createdAt: iso(), updatedAt: iso(),
    identity: { terminalId, sessionId: null, sessionGeneration: generation, process: null }, baseline: { serverEpoch: "epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: iso() } });

  test("상태줄이 대화 id 를 주지 않아도, 서버가 넣은 전달 묶음의 표지가 든 훅 줄로 id 를 알아낸다. 표지 없는 줄은 근거가 아니다", async () => {
    // 실제 agy 의 상태줄 입력은 아직 보지 못했다. 대화 id 가 실리지 않는 경우: 상태줄 기록의 conversationId 는 끝내 비어 있다.
    const f = await setup({}, { geminiStatus: "no_conversation" });
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    // 묶음 표지 없이 들어간 글(사람이 터미널에서 직접 친 글도 같다): 훅 줄에 대화 id 는 남지만 이 터미널의 것이라고 묶지 않는다.
    expect(await f.runner.send(live, "표지 없는 글", f.opts)).toMatchObject({ ok: true });
    await until("턴 끝", () => ofType(f.events, "turn_end").length === 1);
    f.core.typeDirectly("m_gem1", `사람이 친 글 ${ITEM2}`);
    await until("턴 끝", () => ofType(f.events, "turn_end").length === 2);
    await Bun.sleep(80);
    const conversation = f.core.runs()[0]!.sessionId!;
    expect(readFileSync(join(geminiHookEventsDir(f.home), "m_gem1.jsonl"), "utf8")).toContain(conversation);
    expect(sessionsOf(f.events)).toEqual([]);
    expect(f.runner.observationState("m_gem1")?.identity.sessionId).toBeNull();
    // 서버가 넣은 전달(봉투의 묶음 표지): 그 표지가 든 PreInvocation 줄의 대화 id 가 이 터미널의 대화다.
    expect(await f.runner.send(live, `[총괄 → 팀장] 일을 시작해 주세요 ${ITEM}\n\n${BUNDLE}`, { ...f.opts, marker: BUNDLE })).toMatchObject({ ok: true });
    await until("대화 id", () => sessionsOf(f.events).length === 1);
    expect(sessionsOf(f.events)).toEqual([conversation]);
    expect(f.runner.observationState("m_gem1")?.identity.sessionId).toBe(conversation);
    // 상태줄 기록은 끝내 id 를 주지 않았다.
    expect(readGeminiStatus(f.home, "m_gem1")).toMatchObject({ conversationId: null, launch: launchOf(f) });
    // 그 id 로 재우고 이어 연다.
    await until("턴 끝", () => ofType(f.events, "turn_end").length === 3);
    const known = { ...live, sessionId: conversation };
    await f.runner.stop(known);
    const resumed = await f.runner.start({ ...known, paneId: null }, { ...f.opts, resume: true });
    expect(resumed.sessionId).toBe(conversation);
    expect(f.core.runs()[1]!.conversationFlag).toBe(conversation);
  });

  test("띄우기 전의 줄, 다른 봉투의 줄, 낱개 표지만 든 줄, 세션 시작·턴 끝 줄은 이 터미널의 대화로 묶지 않는다. 묶음 표지가 든 가장 나중 줄을 따른다", async () => {
    const f = await setup({}, { geminiStatus: "no_conversation" });
    // 이 팀장의 예전 터미널이 남긴 줄. 같은 묶음 표지가 들었더라도 띄우기 전의 줄은 보지 않는다.
    putHookLine(f, { at: Date.now() - 60_000, event: "PreInvocation", conversationId: "conversation-before-launch", invocation: 0, markers: [ITEM, BUNDLE], chars: 40 });
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    // 넣기가 엔진에서 거절됐다(글은 들어가지 않았다). 그 봉투의 묶음 표지는 이 터미널에 넣으려 한 것으로 남는다.
    f.core.intercept(call => call.method === "terminal.send" && !primesMcp(call) ? { error: { kind: "busy", message: "CLI is working" } } : undefined);
    expect(await f.runner.send(live, `전달 ${ITEM}\n\n${BUNDLE}`, { ...f.opts, marker: BUNDLE })).toMatchObject({ ok: false, deliveryEffect: "rejected" });
    f.core.intercept(null);
    putHookLine(f, { event: "SessionStart", conversationId: "conversation-session-start" });
    putHookLine(f, { event: "PreInvocation", conversationId: "conversation-other-envelope", invocation: 0, markers: [ITEM, "#iamceo_b_EEEEEEEEEEEEEEEEEEEEEE"], chars: 40 });
    putHookLine(f, { event: "PreInvocation", conversationId: "conversation-item-only", invocation: 0, markers: [ITEM], chars: 40 });
    putHookLine(f, { event: "PreInvocation", conversationId: null, invocation: 0, markers: [BUNDLE], chars: 40 });
    putHookLine(f, { event: "Stop", conversationId: "conversation-stop", reason: "NO_TOOL_CALL", fullyIdle: true, failed: false });
    await f.runner.screen(live);
    await Bun.sleep(100);
    expect(sessionsOf(f.events)).toEqual([]);
    // 남이 쓸 수 있는 사건 파일은 근거로 읽지 않는다.
    const file = join(geminiHookEventsDir(f.home), "m_gem1.jsonl");
    chmodSync(file, 0o666);
    putHookLine(f, { event: "PreInvocation", conversationId: "conversation-mine", invocation: 0, markers: [ITEM, BUNDLE], chars: 40 });
    await Bun.sleep(100);
    expect(sessionsOf(f.events)).toEqual([]);
    chmodSync(file, 0o600);
    await until("대화 id", () => sessionsOf(f.events).length === 1);
    expect(sessionsOf(f.events)).toEqual(["conversation-mine"]);
    // 같은 줄이 다시 읽혀도 사건은 한 번이다. 터미널 안에서 대화를 새로 연 뒤의 줄(같은 봉투를 다시 받은 모델 호출)이 오면 그 id 로 바뀐다.
    putHookLine(f, { event: "PreInvocation", conversationId: "conversation-mine", invocation: 1, markers: [ITEM, BUNDLE], chars: 40 });
    await Bun.sleep(80);
    expect(sessionsOf(f.events)).toEqual(["conversation-mine"]);
    putHookLine(f, { event: "PreInvocation", conversationId: "conversation-reopened", invocation: 0, markers: [BUNDLE], chars: 40 });
    await until("바뀐 id", () => sessionsOf(f.events).length === 2);
    expect(sessionsOf(f.events)).toEqual(["conversation-mine", "conversation-reopened"]);
  });

  test("상태줄 기록이 id 를 주면 그것을 따른다(훅 기록은 상태줄이 id 를 주지 못할 때만 본다)", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    f.core.intercept(call => call.method === "terminal.send" && !primesMcp(call) ? { error: { kind: "busy", message: "CLI is working" } } : undefined);
    await f.runner.send(live, `전달 ${ITEM}\n\n${BUNDLE}`, { ...f.opts, marker: BUNDLE });
    f.core.intercept(null);
    putHookLine(f, { event: "PreInvocation", conversationId: "conversation-from-hook", invocation: 0, markers: [BUNDLE], chars: 40 });
    f.core.drawGeminiStatus("m_gem1", { conversation_id: "conversation-from-statusline", session_id: "conversation-from-statusline" });
    await until("대화 id", () => sessionsOf(f.events).at(-1) === "conversation-from-statusline");
    await Bun.sleep(80);
    // 훅 줄을 적고 상태줄을 그리는 사이에 관측이 한 번 끼면 훅의 id 를 먼저 냈다가 상태줄의 id 로 바꾼다. 어느 쪽이든 마지막은 상태줄의 id 다.
    expect([["conversation-from-statusline"], ["conversation-from-hook", "conversation-from-statusline"]]).toContainEqual(sessionsOf(f.events));
    expect(f.runner.observationState("m_gem1")?.identity.sessionId).toBe("conversation-from-statusline");
  });

  test("상태줄이 알려 준 id 를 그보다 앞선 훅 줄이 되돌리지 않는다. 그 뒤에 적힌 훅 줄은 id 를 바꾼다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    expect(await f.runner.send(live, `전달 ${ITEM}\n\n${BUNDLE}`, { ...f.opts, marker: BUNDLE })).toMatchObject({ ok: true });
    const first = await until("대화 id", () => sessionsOf(f.events)[0]);
    await until("턴 끝", () => ofType(f.events, "turn_end").length === 1);
    // 그 전달의 훅 줄에는 첫 대화의 id 가 남아 있다.
    expect(readFileSync(join(geminiHookEventsDir(f.home), "m_gem1.jsonl"), "utf8")).toContain(BUNDLE);
    // 대표가 터미널에서 대화를 새로 열었다: 상태줄이 새 id 를 알린다.
    await Bun.sleep(5);
    f.core.drawGeminiStatus("m_gem1", { conversation_id: "conversation-reopened", session_id: "conversation-reopened" });
    await until("새 id", () => sessionsOf(f.events).length === 2);
    // 또 새로 열어 아직 첫 글 전이다(상태줄의 id 가 비었다). 앞선 전달의 훅 줄이 첫 대화의 id 를 되살리지 않는다.
    f.core.drawGeminiStatus("m_gem1", { conversation_id: "", session_id: "" });
    await f.runner.screen({ ...live, sessionId: "conversation-reopened" });
    await Bun.sleep(100);
    expect(sessionsOf(f.events)).toEqual([first, "conversation-reopened"]);
    expect(f.runner.observationState("m_gem1")?.identity.sessionId).toBe("conversation-reopened");
    // 그 뒤에 서버가 넣은 전달을 받은 모델 호출의 줄(더 나중)은 id 를 바꾼다.
    putHookLine(f, { event: "PreInvocation", conversationId: "conversation-third", invocation: 0, markers: [ITEM, BUNDLE], chars: 40 });
    await until("셋째 id", () => sessionsOf(f.events).length === 3);
    expect(sessionsOf(f.events)).toEqual([first, "conversation-reopened", "conversation-third"]);
  });

  test("없는 id 로 이어 연 세션: 상태줄이 id 를 주지 않아도, 붙은 뒤에 서버가 넣은 전달의 훅 줄로 새 대화의 id 를 잡는다", async () => {
    const f = await setup({ sessionId: "gone-conversation" }, { geminiStatus: "no_conversation" });
    // 이 팀장의 예전 터미널이 남긴 줄(넘겨받은 id 보다 앞선 근거)로는 바꾸지 않는다.
    putHookLine(f, { at: Date.now() - 60_000, event: "PreInvocation", conversationId: "conversation-of-an-older-terminal", invocation: 0, markers: [BUNDLE], chars: 40 });
    const started = await f.runner.start(f.member, { ...f.opts, resume: true });
    const live = { ...f.member, paneId: started.paneId };
    expect(started.sessionId).toBe("gone-conversation");
    await f.runner.screen(live);
    await Bun.sleep(80);
    expect(sessionsOf(f.events)).toEqual(["gone-conversation"]);
    expect(await f.runner.send(live, `이어서 해 주세요 ${ITEM}\n\n${BUNDLE}`, { ...f.opts, marker: BUNDLE })).toMatchObject({ ok: true });
    await until("새 id", () => sessionsOf(f.events).length === 2);
    const id = f.core.runs()[0]!.sessionId!;
    expect(id).not.toBe("gone-conversation");
    expect(sessionsOf(f.events)).toEqual(["gone-conversation", id]);
    expect(readGeminiStatus(f.home, "m_gem1")?.conversationId ?? null).toBeNull();
  });

  test("서버를 다시 켠 뒤: 넣은 기억이 없어도 저장소의 마지막 실행 봉투(이 터미널·이 세대의 것)로 같은 줄을 찾는다. 터미널마다 한 번만 묻는다", async () => {
    let run: { dispatch: DeliveryDispatch | null; ended: boolean } | null = null;
    let asked = 0;
    const store = { inputState: () => ({ unresolvedDispatches: [], lease: null }), lastWrittenRun: () => { asked++; return run; }, saveLease() {}, removeLease() {} };
    const f = await setup({}, { geminiStatus: "no_conversation" }, { recoveryStore: store as never });
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    expect(await f.runner.send(live, `전달 ${ITEM}\n\n${BUNDLE}`, { ...f.opts, marker: BUNDLE })).toMatchObject({ ok: true });
    const conversation = await until("대화 id", () => sessionsOf(f.events)[0]);
    await until("턴 끝", () => ofType(f.events, "turn_end").length === 1);
    await f.runner.shutdown();
    const reattached = async () => {
      const runner = f.newRunner();
      const events: RunnerEvent[] = [];
      runner.on(event => events.push(event));
      // 명부에는 아직 대화 id 가 없다(알아낸 것을 적기 전에 서버가 꺼졌다).
      expect(await runner.reattachOwned(live)).toMatchObject({ outcome: "rejoined", started: { sessionId: null } });
      return { runner, events };
    };
    // 다른 터미널(이 팀장의 예전 터미널)에 묶인 봉투, 다른 세대의 봉투는 근거가 아니다.
    for (const other of [envelope("t-other-terminal", BUNDLE), envelope(started.paneId, BUNDLE, 7), { ...envelope(started.paneId, BUNDLE), memberId: "m_other" }, { ...envelope(started.paneId, BUNDLE), cli: "codex" as const }]) {
      run = { dispatch: other, ended: true };
      const { runner, events } = await reattached();
      await Bun.sleep(100);
      expect(sessionsOf(events)).toEqual([]);
      await runner.shutdown();
    }
    run = { dispatch: envelope(started.paneId, BUNDLE), ended: true };
    asked = 0;
    const { runner, events } = await reattached();
    await until("다시 알아냄", () => sessionsOf(events).length === 1);
    expect(sessionsOf(events)).toEqual([conversation]);
    await Bun.sleep(80);
    expect(asked).toBe(1);
    expect(runner.observationState("m_gem1")?.identity.sessionId).toBe(conversation);
  });

  test("훅을 넣지 않는 환경이면 훅 기록을 보지 않는다", async () => {
    const f = await setup({}, { geminiStatus: "no_conversation" });
    const quiet = f.newRunner({}, { hookEvents: false });
    const events: RunnerEvent[] = [];
    quiet.on(event => events.push(event));
    const started = await quiet.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    expect(await quiet.send(live, `전달 ${ITEM}\n\n${BUNDLE}`, { ...f.opts, marker: BUNDLE })).toMatchObject({ ok: true });
    await until("턴 끝", () => ofType(events, "turn_end").length === 1);
    // 누가 그 자리에 줄을 써 두어도 읽지 않는다.
    putHookLine(f, { event: "PreInvocation", conversationId: "conversation-planted", invocation: 0, markers: [BUNDLE], chars: 40 });
    await Bun.sleep(100);
    expect(sessionsOf(events)).toEqual([]);
  });
});

describe("상태줄 기록은 이 터미널의 상태줄 명령이 쓴 것만 믿는다(띄우기 값)", () => {
  test("방금 끝낸 예전 터미널의 래퍼가 늦게 쓴 기록은, 새 터미널을 띄운 뒤에 쓰였어도 새 세션의 대화 id 가 되지 않는다", async () => {
    const f = await setup();
    const first = await f.runner.start(f.member, f.opts);
    const old = await turn(f, { ...f.member, paneId: first.paneId }, "앞 대화");
    const oldLaunch = launchOf(f);
    await f.runner.stop({ ...f.member, sessionId: old, paneId: first.paneId });
    // '새 세션으로': 끝내자마자 새 세대로 띄운다(이어 열지 않는다).
    const fresh = { ...f.member, sessionGeneration: 2, sessionId: null, paneId: null as string | null };
    fresh.paneId = (await f.runner.start(fresh, f.opts)).paneId;
    expect(launchOf(f)).not.toBe(oldLaunch);
    // 죽기 직전에 뜬 예전 터미널의 상태줄 래퍼가 이제야 기록을 쓴다. 쓴 시각은 새 터미널을 띄운 뒤라 시각만으로는 가를 수 없다.
    putStatus(f, { conversation_id: old, context_window: { used_percentage: 77 }, subagents: [{ status: "running" }] }, oldLaunch);
    await f.runner.screen(fresh);
    await Bun.sleep(100);
    expect(sessionsOf(f.events)).toEqual([old]);
    expect(f.runner.observationState("m_gem1")?.identity.sessionId).toBeNull();
    expect(f.runner.logWrittenAt("m_gem1")).toBeNull();
    // 띄우기 값을 받지 않은 명령이 쓴 기록도 이 터미널의 것이 아니다(이 터미널의 명령은 값을 받았다).
    putStatus(f, { conversation_id: old }, null);
    await Bun.sleep(100);
    expect(sessionsOf(f.events)).toEqual([old]);
    expect(f.runner.observationState("m_gem1")?.identity.sessionId).toBeNull();
    // 첫 지시 전에 재워도 버린 대화가 이어 열리지 않는다: 새 세션으로 뜬다.
    await f.runner.stop(fresh);
    const again = await f.runner.start({ ...fresh, paneId: null }, f.opts);
    expect(again.sessionId).toBeNull();
    expect(f.core.runs().at(-1)!.conversationFlag).toBeNull();
    // 이 터미널의 첫 대화는 새 id 다.
    const id = await turn(f, { ...fresh, paneId: again.paneId }, "새 대화");
    expect(id).not.toBe(old);
    expect(sessionsOf(f.events)).toEqual([old, id]);
  });

  test("서버를 다시 켠 뒤에는 터미널 라벨에서 띄우기 값을 읽는다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    await f.runner.shutdown();
    const again = f.newRunner();
    const events: RunnerEvent[] = [];
    again.on(event => events.push(event));
    expect(await again.reattachOwned(live)).toMatchObject({ outcome: "rejoined", started: { sessionId: null } });
    putStatus(f, { conversation_id: "conversation-of-another-terminal" }, "0123456789abcdef0123456789abcdef");
    await Bun.sleep(100);
    expect(sessionsOf(events)).toEqual([]);
    putStatus(f, { conversation_id: "conversation-of-this-terminal" }, launchOf(f));
    await until("대화 id", () => sessionsOf(events).length === 1);
    expect(sessionsOf(events)).toEqual(["conversation-of-this-terminal"]);
  });

  test("라벨이 없는 터미널은 띄우기 값을 적지 않은 기록만, 쓰인 시각으로 가른다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    await f.runner.shutdown();
    // 이 값을 싣기 전의 서버가 띄운 터미널이라고 치고 라벨을 지운다(그 터미널의 상태줄 명령은 값을 받지 않았다).
    delete f.core.terminalOf("m_gem1")!.labels[GEMINI_LAUNCH_LABEL];
    const plain = f.newRunner();
    const events: RunnerEvent[] = [];
    plain.on(event => events.push(event));
    expect(await plain.reattachOwned(live)).toMatchObject({ outcome: "rejoined" });
    putStatus(f, { conversation_id: "conversation-before-launch" }, null, new Date(Date.now() - 60_000));
    await Bun.sleep(80);
    expect(sessionsOf(events)).toEqual([]);
    putStatus(f, { conversation_id: "conversation-of-another-terminal" }, "0123456789abcdef0123456789abcdef");
    await Bun.sleep(80);
    expect(sessionsOf(events)).toEqual([]);
    putStatus(f, { conversation_id: "conversation-plain" }, null);
    await until("대화 id", () => sessionsOf(events).length === 1);
    expect(sessionsOf(events)).toEqual(["conversation-plain"]);
  });
});

describe("서버를 다시 켠 뒤, 대화 id 를 모르는 채 사라진 터미널(명부에 칸 번호만 남았다)", () => {
  /** 서버가 꺼진 사이 터미널이 죽었다: 처음 실행기를 내리고 터미널을 끝낸 뒤, 새 실행기(다시 켠 서버)가 같은 팀장을 띄워 본다. */
  /** 다시 켠 서버의 저장소: 이 세대에 입력이 들어간 실행이 있었는지(written)를 답한다. 운영의 실행기는 늘 저장소를 갖고 있다. */
  const storeWith = (written: boolean) => ({ inputState: () => ({ unresolvedDispatches: [], lease: null }), lastWrittenRun: () => written ? { runId: "run-1", deliveryIds: [] } : null, saveLease() {}, removeLease() {} }) as never;
  async function restartAfterExit(f: Fixture, paneId: string, options: Record<string, unknown> = {}, deps: CoreRunnerDeps = { recoveryStore: storeWith(false) }) {
    await f.runner.shutdown();
    f.core.exit("m_gem1", 1);
    const runner = f.newRunner(deps, options);
    const before = f.core.count("terminal.run");
    const outcome = await runner.start({ ...f.member, paneId }, f.opts).then(started => ({ started, error: null }), (error: unknown) => ({ started: null, error }));
    return { ...outcome, launched: f.core.count("terminal.run") - before };
  }
  const blocked = (result: Awaited<ReturnType<typeof restartAfterExit>>) => {
    expect(result.error).toBeInstanceOf(CoreError);
    expect((result.error as CoreError).kind).toBe("session_unknown");
    expect(result.launched).toBe(0);
  };

  test("마지막 상태줄 기록이 있고 대화 id 가 비었으면 대화가 없었다: 막지 않고 새 세션으로 띄운다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    // agy 는 뜨면서 상태줄을 그린다. 첫 대화 전이라 대화 id 는 빈 글이다.
    f.core.drawGeminiStatus("m_gem1");
    expect(readGeminiStatus(f.home, "m_gem1")).toMatchObject({ conversationId: null });
    const result = await restartAfterExit(f, started.paneId);
    expect(result.error).toBeNull();
    expect(result.started).toMatchObject({ sessionId: null });
    expect(result.launched).toBe(1);
    expect(f.core.runs().at(-1)!.conversationFlag).toBeNull();
  });

  test("서버 자신의 기록이 먼저다: 이 세대에 입력이 들어간 실행이 있으면, 상태줄 기록의 대화 id 가 비어 있어도 막는다. 저장소를 모르면 막는다", async () => {
    // 지시가 들어가 턴이 돌았는데 상태줄이 대화 id 를 끝내 싣지 않은 경우: 기록의 id 가 비었다는 것만으로 '대화 없음'으로 풀면 그 대화를 잃는다.
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    f.core.drawGeminiStatus("m_gem1");
    expect(readGeminiStatus(f.home, "m_gem1")).toMatchObject({ conversationId: null });
    blocked(await restartAfterExit(f, started.paneId, {}, { recoveryStore: storeWith(true) }));
    // 저장소가 없는 실행기는 그 기록을 볼 수 없다: 모르는 것이니 막는다.
    const g = await setup();
    const again = await g.runner.start(g.member, g.opts);
    g.core.drawGeminiStatus("m_gem1");
    blocked(await restartAfterExit(g, again.paneId, {}, {}));
  });

  test("훅을 넣지 않는 환경에서는 상태줄 기록의 대화 id 가 비었다는 것만으로 풀지 않는다(훅 줄이 없다는 것이 근거가 아니다)", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    f.core.drawGeminiStatus("m_gem1");
    blocked(await restartAfterExit(f, started.paneId, { hookEvents: false }));
  });

  test("이 팀장의 예전 터미널이 남긴 훅 줄이 있어도, 그 뒤에 그린 상태줄 기록의 대화 id 가 비었으면 막지 않는다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    putHookLine(f, { at: Date.now() - 60_000, event: "PreInvocation", conversationId: "conversation-of-an-older-terminal", invocation: 0, markers: [], chars: 6 });
    await Bun.sleep(10);
    f.core.drawGeminiStatus("m_gem1");
    const result = await restartAfterExit(f, started.paneId);
    expect(result.error).toBeNull();
    expect(result.launched).toBe(1);
  });

  test("상태줄 기록이 아예 없고 훅 줄도 하나도 없으면(뜨자마자 끝났다) 막지 않는다", async () => {
    const f = await setup({}, { geminiStatus: "none" });
    const started = await f.runner.start(f.member, f.opts);
    expect(existsSync(geminiStatusPath(f.home, "m_gem1"))).toBe(false);
    expect(existsSync(join(geminiHookEventsDir(f.home), "m_gem1.jsonl"))).toBe(false);
    // 훅을 싣고 띄웠다(주입 폴더의 hooks.json): 줄이 없다는 것이 근거가 된다.
    expect(existsSync(join(f.core.runs()[0]!.addDir!, ".agents", "hooks.json"))).toBe(true);
    const result = await restartAfterExit(f, started.paneId);
    expect(result.error).toBeNull();
    expect(result.started).toMatchObject({ sessionId: null });
    expect(result.launched).toBe(1);
  });

  test("그 밖에는 지금처럼 막는다: 기록에 대화 id 가 있다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    // 대화가 돌았지만 서버가 그 id 를 명부에 적기 전에 꺼졌다(명부의 세션 id 는 비어 있다).
    await turn(f, { ...f.member, paneId: started.paneId }, "한 턴");
    expect(readGeminiStatus(f.home, "m_gem1")?.conversationId).toBeTruthy();
    blocked(await restartAfterExit(f, started.paneId));
  });

  test("그 밖에는 지금처럼 막는다: 기록은 없는데 훅 줄이 있다, 기록 뒤에 훅 줄이 덧붙었다, 기록이 깨졌다", async () => {
    // 상태줄 명령이 한 번도 돌지 않았지만 대화는 돌았다(훅 줄이 남았다).
    const f = await setup({}, { geminiStatus: "none" });
    const started = await f.runner.start(f.member, f.opts);
    expect(await f.runner.send({ ...f.member, paneId: started.paneId }, "한 턴", f.opts)).toMatchObject({ ok: true });
    await until("턴 끝", () => ofType(f.events, "turn_end").length === 1);
    expect(existsSync(geminiStatusPath(f.home, "m_gem1"))).toBe(false);
    expect(existsSync(join(geminiHookEventsDir(f.home), "m_gem1.jsonl"))).toBe(true);
    blocked(await restartAfterExit(f, started.paneId));

    // 대화 id 가 빈 기록을 그린 뒤에 훅 줄이 덧붙었다(상태줄이 멈춘 뒤에 대화가 돌았다).
    const g = await setup();
    const begun = await g.runner.start(g.member, g.opts);
    g.core.drawGeminiStatus("m_gem1");
    await Bun.sleep(10);
    putHookLine(g, { event: "PreInvocation", conversationId: "conversation-after-status", invocation: 0, markers: [], chars: 6 });
    blocked(await restartAfterExit(g, begun.paneId));

    // 깨진 기록: 대화가 없었다는 근거가 아니다.
    const h = await setup();
    const opened = await h.runner.start(h.member, h.opts);
    mkdirSync(join(h.home, "context", "gemini"), { recursive: true });
    writeFileSync(geminiStatusPath(h.home, "m_gem1"), "{");
    blocked(await restartAfterExit(h, opened.paneId));
  });

  test("그 밖에는 지금처럼 막는다: contextHome 이 없다, 훅을 넣지 않는 환경에서 기록이 없다, 훅을 싣고 띄운 흔적이 없다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    f.core.drawGeminiStatus("m_gem1");
    blocked(await restartAfterExit(f, started.paneId, { contextHome: undefined }));

    const g = await setup({}, { geminiStatus: "none" });
    const begun = await g.runner.start(g.member, g.opts);
    blocked(await restartAfterExit(g, begun.paneId, { hookEvents: false }));

    const h = await setup({}, { geminiStatus: "none" });
    const opened = await h.runner.start(h.member, h.opts);
    rmSync(join(h.core.runs()[0]!.addDir!, ".agents", "hooks.json"));
    blocked(await restartAfterExit(h, opened.paneId));
  });

  test("이 서버가 사라지는 것을 본 터미널은 그때의 판정을 따른다: 대화가 없었으면 명부에 칸 번호가 남아 있고 디스크에 옛 기록이 있어도 막지 않는다", async () => {
    // 이 팀장의 예전 세대 터미널이 남긴 상태줄 기록(대화 id 가 있다). 디스크만 보면 '대화가 있었을 수 있다'.
    const f = await setup({}, { geminiStatus: "none" });
    putStatus(f, { conversation_id: "conversation-of-an-older-generation" }, "0123456789abcdef0123456789abcdef", new Date(Date.now() - 60_000));
    const started = await f.runner.start(f.member, f.opts);
    // 뜨자마자 끝났다(없는 모델 등). 이 서버가 그것을 봤다: 턴이 돈 적이 없고 넣은 글도 없다.
    f.core.exit("m_gem1", 1);
    await until("사라짐 관측", () => f.events.some(e => e.type === "status" && e.status === "gone"));
    // 총괄은 사라진 core 터미널의 칸 번호를 곧바로 비우지 않는다: 그 칸 번호가 남은 명부로 다시 띄운다.
    const again = await f.runner.start({ ...f.member, paneId: started.paneId }, f.opts);
    expect(again.sessionId).toBeNull();
    expect(f.core.count("terminal.run")).toBe(2);
    // 쉬는 중에 재운 터미널도 같다.
    await f.runner.stop({ ...f.member, paneId: again.paneId });
    const third = await f.runner.start({ ...f.member, paneId: again.paneId }, f.opts);
    expect(third.sessionId).toBeNull();
    expect(f.core.count("terminal.run")).toBe(3);
    // 지켜보지 못한 실행기(다시 켠 서버)는 같은 디스크를 보고 막는다.
    await f.runner.shutdown();
    f.core.exit("m_gem1", 1);
    const other = f.newRunner();
    expect(((await rejection(other.start({ ...f.member, paneId: third.paneId }, f.opts))) as CoreError).kind).toBe("session_unknown");
    // 지켜본 터미널이 아닌 다른 칸 번호가 적힌 명부도 디스크의 근거로 가린다(막는다).
    const g = await setup({}, { geminiStatus: "none" });
    putStatus(g, { conversation_id: "conversation-of-an-older-generation" }, "0123456789abcdef0123456789abcdef", new Date(Date.now() - 60_000));
    await g.runner.start(g.member, g.opts);
    g.core.exit("m_gem1", 1);
    await until("사라짐 관측", () => g.events.some(e => e.type === "status" && e.status === "gone"));
    expect(((await rejection(g.runner.start({ ...g.member, paneId: "t-some-other-terminal" }, g.opts))) as CoreError).kind).toBe("session_unknown");
  });

  test("이 서버가 사라지는 것을 본 터미널은 그때의 판정을 따른다: 대화가 돌았으면 디스크에 근거가 없어도 막는다", async () => {
    // 가짜 agy 가 상태줄·훅 기록을 남기지 않는 환경(둘 다 돌지 못했다): 디스크만 보면 대화가 없었던 것처럼 보인다.
    const f = await setup({}, { contextHome: undefined });
    await f.runner.start(f.member, f.opts);
    expect(await f.runner.send(f.member, "첫 지시입니다", f.opts)).toMatchObject({ ok: true });
    await until("턴 끝", () => ofType(f.events, "turn_end").length === 1);
    f.core.exit("m_gem1", 1);
    await until("사라짐 관측", () => f.events.some(e => e.type === "status" && e.status === "gone"));
    expect(((await rejection(f.runner.start({ ...f.member, paneId: null }, f.opts))) as CoreError).kind).toBe("session_unknown");
  });
});

describe("소유권: 실행 파일은 agy(또는 설정한 경로)", () => {
  test("관측이 '소유가 바뀜'으로 깨지지 않고, 다른 프로그램이면 충돌이다", async () => {
    const f = await setup();
    const runner = f.newRunner({}, { geminiBin: "/fake/bin/agy" });
    const events: RunnerEvent[] = [];
    runner.on(e => events.push(e));
    const started = await runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    expect(f.core.runs()[0]!.argv[0]).toBe("/fake/bin/agy");
    await runner.screen(live);
    await Bun.sleep(60);
    expect(runner.observationState("m_gem1")).toMatchObject({ failures: 0, failure: null });
    // geminiBin 을 설정하지 않은 실행기도 실행 파일 이름(agy)으로 알아본다. Codex·Claude 실행 파일 설정과 견주지 않는다.
    const plain = f.newRunner({}, { geminiBin: undefined, codexBin: "/fake/bin/agy-is-not-codex", claudeBin: "/fake/claude" });
    expect(await plain.reattachOwned(live)).toMatchObject({ outcome: "rejoined" });
    // 그 터미널의 프로그램이 다른 것이면(같은 라벨) 붙지 않는다.
    f.core.terminalOf("m_gem1")!.argv[0] = "/usr/local/bin/codex";
    const strict = f.newRunner({}, { geminiBin: "/fake/bin/agy" });
    expect(await strict.reattachOwned(live)).toMatchObject({ outcome: "conflict", code: "ownership_changed" });
    expect(String(await rejection(runner.screen(live)))).toContain("Core terminal ownership changed");
    // 옛 Gemini CLI(`gemini`)도 gemini 팀장의 터미널이 아니다.
    f.core.terminalOf("m_gem1")!.argv[0] = "/Users/x/.npm-global/bin/gemini";
    expect(await strict.reattachOwned(live)).toMatchObject({ outcome: "conflict", code: "ownership_changed" });
  });
});

describe("입력칸: agy 판독기로만 읽는다", () => {
  test("빈 칸이면 넣고, 쓰던 글·승인 창·다른 CLI 의 입력칸 모양이면 넣지 않는다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    f.core.setDraft("m_gem1", "대표가 쓰던 글");
    expect(await f.runner.send(live, "지시", f.opts)).toMatchObject({ ok: false, reason: "input_busy", deliveryEffect: "not_written", detail: "A user draft is present; IAMCEO leaves it untouched" });
    f.core.setDraft("m_gem1", "");
    // 이 터미널의 첫 입력: 먼저 맨 /mcp 로 MCP 를 띄우고 관리 창을 Esc 로 닫은 뒤 넣는다(primeGeminiMcp). 쓰던 글이 있을 때는 /mcp 도 넣지 않았다.
    expect(f.core.mcpOpens).toEqual([]);
    expect(await f.runner.send(live, "첫 지시", f.opts)).toMatchObject({ ok: true });
    await until("턴 끝", () => ofType(f.events, "turn_end").length === 1);
    expect(f.core.mcpOpens).toEqual([started.paneId]);
    expect(f.core.keys).toEqual([{ terminal: started.paneId, keys: ["esc"] }]);
    // 자리표시 글은 빈 칸이다.
    f.core.setScreen("m_gem1", geminiComposerScreen("앞 대화", "Auto mode: edits & safe commands auto-approved (shift+tab to cycle)"));
    expect(await f.runner.send(live, "자리표시 글 위에 넣기", f.opts)).toMatchObject({ ok: true });
    await until("턴 끝", () => ofType(f.events, "turn_end").length === 2);
    // 승인 창: 상태 보고는 쉬는 중이어도 입력칸이 아니면 넣지 않는다.
    f.core.setScreen("m_gem1", "Accept this file edit?\n> 1. Yes, accept this change\n  2. No, reject this change\n\n  ↑/↓ Navigate · tab Amend · f full diff\nIAMCEO · fake-model\n");
    const known = { ...live, sessionId: f.runner.observationState("m_gem1")!.identity.sessionId };
    expect(await f.runner.send(known, "지시", f.opts)).toMatchObject({ ok: false, reason: "input_busy", detail: "Cannot identify an empty CLI composer" });
    // Claude·Codex 의 빈 입력칸 모양은 agy 의 빈 칸이 아니다(남의 판독기로 읽지 않는다).
    for (const screen of [composerScreen("앞 대화"), "앞 대화\n› \n  ? for shortcuts\n", "앞 대화\n› Ask Codex to do anything\n  ? for shortcuts\n"]) {
      f.core.setScreen("m_gem1", screen);
      expect(await f.runner.send(known, "지시", f.opts)).toMatchObject({ ok: false, reason: "input_busy", detail: "Cannot identify an empty CLI composer" });
    }
    expect(f.core.turns("m_gem1")).toHaveLength(2);
    // 키는 첫 입력 앞의 관리 창 닫기 하나뿐이다(MCP 띄우기는 터미널마다 한 번).
    expect(f.core.keys).toEqual([{ terminal: started.paneId, keys: ["esc"] }]);
    expect(f.core.mcpOpens).toEqual([started.paneId]);
    // 재우기도 같은 판독으로 지킨다: 쓰던 글이 있으면 끝내지 않는다.
    f.core.setScreen("m_gem1", null); f.core.setDraft("m_gem1", "남은 글");
    expect(String(await rejection(f.runner.stop(known, { whileWorking: false })))).toContain("user draft or unknown composer");
    f.core.setDraft("m_gem1", "");
    await f.runner.stop(known, { whileWorking: false });
    expect(f.core.terminalOf("m_gem1")!.state).toBe("finished");
  });
  test("Claude 의 사용 한도 메뉴 문구를 agy 화면에 대지 않는다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    const menu = "You've hit your 5-hour limit · resets Nov 13 at 10am (Asia/Seoul)\nWhat do you want to do?\n❯ 1. Add funds to continue with usage credits\n2. Stop\n3. Switch to usage credits\nEnter to confirm · Esc to cancel";
    f.core.setScreen("m_gem1", menu);
    const sent = await f.runner.send(live, "지시", f.opts);
    // 한도 막힘(usage_limit)이 아니라 '입력칸을 못 알아봄'이다.
    expect(sent).toMatchObject({ ok: false, reason: "input_busy", detail: "Cannot identify an empty CLI composer" });
    expect(f.events.some(e => e.type === "status" && e.blockedReason === "usage_limit")).toBe(false);
    expect(await f.runner.usageLimitSnapshot(live)).toMatchObject({ menu: null });
    expect(await f.runner.dismissUsageLimit(live, "any")).toMatchObject({ ok: false });
    expect(f.core.keys).toEqual([]);
  });
});

describe("병렬: Claude 명령을 치지 않는다", () => {
  test("setParallel 은 선호만 적고 다음 입력 앞에 실행 선호 줄을 붙인다(`/effort ultracode` 를 넣지 않는다)", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    const sends = f.core.count("terminal.send");
    expect(await f.runner.setParallel(live, true, f.opts)).toEqual({ ok: true });
    expect(f.core.count("terminal.send")).toBe(sends);
    await turn(f, live, "나눠서 해 주세요");
    expect(f.core.turns("m_gem1")[0]!.prompt).toBe(`${codexExecutionPreference("worker", true)}나눠서 해 주세요`);
    const known = { ...live, sessionId: f.runner.observationState("m_gem1")!.identity.sessionId };
    expect(await f.runner.setParallel(known, false, f.opts)).toEqual({ ok: true });
    await turn(f, known, "순서대로");
    expect(f.core.turns("m_gem1")[1]!.prompt).toBe(`${codexExecutionPreference("worker", false)}순서대로`);
    expect(f.core.turns("m_gem1").some(t => t.prompt.includes("/effort"))).toBe(false);
    // 팀장 설정의 선호(member.parallel)도 같다. 총괄에게는 '순서대로'가 아닌 줄이 붙는다.
    const g = await setup({ parallel: false, kind: "conductor" });
    const lead = await g.runner.start(g.member, g.opts);
    await turn(g, { ...g.member, paneId: lead.paneId }, "일을 나눠 주세요");
    expect(g.core.turns("m_gem1")[0]!.prompt).toBe(`${codexExecutionPreference("conductor", false)}일을 나눠 주세요`);
  });
});

/** 압축 상태를 메모리에 둔다(운영은 저장소, coreCompactStore). */
function compactStore() {
  const states = new Map<string, CoreCompactState>();
  return { states, port: { load: (id: string) => states.get(id) ?? null, save: (id: string, state: CoreCompactState) => { states.set(id, structuredClone(state)); } } };
}
const transcriptOf = (f: Fixture, id: string) => join(f.geminiHome, "brain", id, ".system_generated", "logs", "transcript.jsonl");

describe("압축: 맨 /compact 를 넣고 대화 기록의 CHECKPOINT 로 끝을 본다", () => {
  test("맨 '/compact' 하나만(초점·실행 선호 줄·표지 없이) 넣고, 기록에 CHECKPOINT 가 생기고 쉬면 succeeded·compacted 다. 턴 끝이 아니고, 그 뒤 전달이 들어간다", async () => {
    const store = compactStore();
    const f = await setup({ parallel: true }, {}, { compactStore: store.port });
    const started = await f.runner.start(f.member, f.opts);
    const id = await turn(f, { ...f.member, paneId: started.paneId }, "한 턴");
    const known = { ...f.member, sessionId: id, paneId: started.paneId };
    const sends = f.core.count("terminal.send");
    expect(await f.runner.compact(known, "이어갈 일: 결제 연동 · 남은 일 둘", f.opts)).toMatchObject({ ok: true });
    const calls = f.core.calls.filter(c => c.method === "terminal.send");
    expect(calls).toHaveLength(sends + 1);
    expect(calls.at(-1)!.params).toMatchObject({ text: "/compact", force: false });
    await until("압축 끝", () => ofType(f.events, "compacted").length === 1);
    expect(store.states.get("m_gem1")).toMatchObject({ phase: "succeeded", command: "/compact" });
    expect(store.states.get("m_gem1")!.evidence).toBeUndefined();
    expect(store.states.get("m_gem1")!.baseline).toMatchObject({ path: transcriptOf(f, id), sessionId: id });
    expect(readFileSync(transcriptOf(f, id), "utf8")).toContain("# Resuming from a compaction");
    // 압축은 턴 끝이 아니다. 끝나면 묶임이 풀리고 다음 전달이 같은 대화로 들어간다.
    expect(ofType(f.events, "turn_end")).toHaveLength(1);
    await until("묶임 풀림", () => !f.runner.isBusy("m_gem1"));
    expect(await turn(f, known, "다음 일")).toBe(id);
    expect(f.core.turns("m_gem1").map(t => t.prompt).filter(p => p.includes("/compact"))).toEqual(["/compact"]);
  });

  test("입력칸에 글이 있으면 input_busy, 답이 하나도 없는 대화면 넣지 않는다(아무것도 쓰지 않는다)", async () => {
    const store = compactStore();
    const f = await setup({}, {}, { compactStore: store.port });
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    const id = await turn(f, live, "첫 일");
    const known = { ...live, sessionId: id };
    // 대화는 열렸지만 기록에 모델의 답 줄이 없다(헤드리스에서는 이런 대화의 /compact 가 보통 글처럼 모델에 갔다).
    writeFileSync(transcriptOf(f, id), `${JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\n첫 일\n</USER_REQUEST>" })}\n`);
    const sends = f.core.count("terminal.send");
    const nothing = await f.runner.compact(known, "", f.opts);
    expect(nothing).toMatchObject({ ok: false, reason: "error", deliveryEffect: "not_written" });
    expect((nothing as { detail?: string }).detail).toContain("Nothing to compact yet");
    // 답이 생긴 뒤에도 입력칸에 쓰던 글이 있으면 넣지 않는다.
    expect(await turn(f, known, "이번엔 답한다")).toBe(id);
    f.core.setDraft("m_gem1", "대표가 쓰던 글");
    expect(await f.runner.compact(known, "", f.opts)).toMatchObject({ ok: false, reason: "input_busy", deliveryEffect: "not_written" });
    expect(f.core.count("terminal.send")).toBe(sends + 1);
    expect(f.core.turns("m_gem1").some(t => t.prompt.includes("/compact"))).toBe(false);
    expect(store.states.size).toBe(0);
  });

  test("기록에 CHECKPOINT 가 없어도 같은 대화의 PreInvocation(compact) 뒤 Stop(TERMINAL_CUSTOM_HOOK) 과 쉬는 CLI 면 닫는다(훅 근거)", async () => {
    const store = compactStore();
    const f = await setup({}, { geminiCompact: "hook_only" }, { compactStore: store.port });
    const started = await f.runner.start(f.member, f.opts);
    const id = await turn(f, { ...f.member, paneId: started.paneId }, "한 턴");
    expect(await f.runner.compact({ ...f.member, sessionId: id, paneId: started.paneId }, "", f.opts)).toMatchObject({ ok: true });
    await until("압축 끝", () => ofType(f.events, "compacted").length === 1);
    expect(store.states.get("m_gem1")).toMatchObject({ phase: "succeeded", evidence: "hook" });
  });

  test("기록도 훅도 끝을 알리지 않으면 닫지 않고, 기한이 지나면 '결과 모름'(completion_timeout)이다", async () => {
    const store = compactStore();
    const f = await setup({}, { geminiCompact: "silent" }, { compactStore: store.port, compactTimeoutMs: 150 });
    const started = await f.runner.start(f.member, f.opts);
    const id = await turn(f, { ...f.member, paneId: started.paneId }, "한 턴");
    expect(await f.runner.compact({ ...f.member, sessionId: id, paneId: started.paneId }, "", f.opts)).toMatchObject({ ok: true });
    await until("결과 모름", () => store.states.get("m_gem1")?.phase === "uncertain");
    expect(store.states.get("m_gem1")).toMatchObject({ reason: "completion_timeout" });
    expect(ofType(f.events, "compacted")).toHaveLength(0);
    expect(f.runner.isBusy("m_gem1")).toBe(true);
  });
});

describe("턴 오류의 글: OSC 보고 글(풀어서) + 그 턴의 Stop 훅 오류 글", () => {
  const network = "There was a network issue connecting to the server, please try again.";
  const stopError = 'generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": unexpected EOF';
  test("재시도를 다 쓰고 끝난 턴: 오류 글에 base64 를 푼 보고 글과 Stop 의 오류 글이 함께 실린다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const osc = Buffer.from(network).toString("base64");
    expect(await f.runner.send({ ...f.member, paneId: started.paneId }, `일 @fake:error=x @fake:oscmsg=${osc} @fake:stoperror=${encodeURIComponent(stopError)}`, f.opts)).toMatchObject({ ok: true });
    const ended = await until("오류 턴 끝", () => ofType(f.events, "turn_end")[0]);
    expect(ended).toMatchObject({ isError: true, errorText: `${network} · ${stopError}` });
  });

  test("UNVERIFIED-INTERACTIVE 대비: OSC 는 끝남(done)으로 알렸는데 그 턴의 Stop 이 ERROR 면 오류로 끝난 턴이다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    expect(await f.runner.send({ ...f.member, paneId: started.paneId }, `일 @fake:stopfail=${encodeURIComponent("RESOURCE_EXHAUSTED: You have exhausted your quota on this model.")}`, f.opts)).toMatchObject({ ok: true });
    const ended = await until("턴 끝", () => ofType(f.events, "turn_end")[0]);
    expect(ended).toMatchObject({ isError: true, errorText: "RESOURCE_EXHAUSTED: You have exhausted your quota on this model." });
  });

  test("앞 턴의 Stop 이 늦게 덧붙었거나 서브에이전트(다른 대화)의 Stop 이 ERROR 여도, 이 턴의 Stop 으로 가른다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    const id = await turn(f, live, "첫 일");
    // 앞 턴의 늦은 Stop(ERROR): 다음 턴의 모델 호출(PreInvocation) 앞에 놓인다.
    putHookLine(f, { event: "Stop", conversationId: id, reason: "ERROR", fullyIdle: true, failed: true, error: "late error" });
    // 이 턴 안에서 서브에이전트(다른 대화 id)가 ERROR 로 끝났다.
    f.core.setOnTurn(() => { putHookLine(f, { event: "Stop", conversationId: "sub-agent-conv", reason: "ERROR", fullyIdle: false, failed: true, error: "RESOURCE_EXHAUSTED" }); return false; });
    await turn(f, { ...live, sessionId: id }, "둘째 일");
    expect(ofType(f.events, "turn_end").map(e => e.isError)).toEqual([false, false]);
  });
});

describe("문맥·서브에이전트·진전: 상태줄 기록에서", () => {
  test("턴 끝의 문맥 크기는 대화 기록의 마지막 모델 호출 크기(input + cache_read)와 상태줄의 창 크기다(정확한 값, 토큰 수와 함께)", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const id = await turn(f, { ...f.member, paneId: started.paneId }, "문맥 재기 @fake:usage=50000 @fake:window=1000000");
    const usage = await until("문맥 사건", () => ofType(f.events, "context_usage").at(-1));
    expect(usage).toMatchObject({ memberId: "m_gem1", sessionId: id, tokens: 50_000, shownPct: null, model: "fake-model", exact: { window: 1_000_000, source: "statusline" } });
    expect((usage.exact as { pct?: number }).pct).toBeUndefined();
    // 팀장에게 정한 모델이 있으면 그 이름으로 싣는다.
    const g = await setup({ model: "gemini-4-neon" });
    const lead = await g.runner.start(g.member, g.opts);
    await turn(g, { ...g.member, paneId: lead.paneId }, "문맥 @fake:usage=20000 @fake:window=200000");
    expect(await until("문맥 사건", () => ofType(g.events, "context_usage").at(-1))).toMatchObject({ tokens: 20_000, model: "gemini-4-neon" });
    expect(g.core.runs()[0]!.argv).toContain("gemini-4-neon");
  });
  test("대화 기록을 읽지 못하면 예전처럼 상태줄이 알려 준 % 다(토큰 수 없이)", async () => {
    const f = await setup();
    const elsewhere = join(f.home, "other-gemini-home");
    mkdirSync(elsewhere, { recursive: true });
    const runner = f.newRunner({}, { geminiHome: elsewhere });
    const events: RunnerEvent[] = [];
    runner.on(e => events.push(e));
    const started = await runner.start(f.member, f.opts);
    expect(await runner.send({ ...f.member, paneId: started.paneId }, "문맥 재기 @fake:usage=50000 @fake:window=1000000", f.opts)).toMatchObject({ ok: true });
    const usage = await until("문맥 사건", () => ofType(events, "context_usage").at(-1));
    expect(usage).toMatchObject({ tokens: null, shownPct: 5, exact: { window: 1_000_000, source: "statusline", pct: 5 } });
  });
  test("상태줄 명령이 없으면(contextHome 없음) id·문맥을 지어내지 않는다", async () => {
    const f = await setup();
    const bare = f.newRunner({}, { contextHome: undefined });
    const events: RunnerEvent[] = [];
    bare.on(e => events.push(e));
    const started = await bare.start(f.member, f.opts);
    expect(f.core.runs()[0]!.settings?.statusLine).toBeUndefined();
    expect(await bare.send({ ...f.member, paneId: started.paneId }, "지시", f.opts)).toMatchObject({ ok: true });
    await until("턴 끝", () => ofType(events, "turn_end").length === 1);
    expect(ofType(events, "session")).toEqual([]);
    expect(ofType(events, "context_usage")).toEqual([]);
    expect(bare.observationState("m_gem1")?.identity.sessionId).toBeNull();
    expect(existsSync(geminiStatusPath(f.home, "m_gem1"))).toBe(false);
  });
  test("서브에이전트: 상태줄 기록의 도는 수(running)를 그대로 낸다. 끝난 항목은 세지 않고, 상태를 모르는 항목이 섞이면 '모름'이다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    await turn(f, { ...f.member, paneId: started.paneId }, "한 턴");
    const last = () => ofType(f.events, "subagents").at(-1);
    expect(await until("서브에이전트 0", () => ofType(f.events, "subagents").find(e => e.quality === "exact"))).toMatchObject({ memberId: "m_gem1", quality: "exact", count: 0 });
    f.core.drawGeminiStatus("m_gem1", { subagents: [{ name: "a", status: "completed" }, { name: "b", status: "running" }] });
    expect(await until("서브에이전트 1", () => last()?.count === 1 && last())).toMatchObject({ quality: "exact", count: 1 });
    // 문서에 없는 상태(failed)·상태 없는 항목이 섞였다: 도는 중인지 모르므로 정확한 수인 것처럼 내지 않는다.
    f.core.drawGeminiStatus("m_gem1", { subagents: [{ name: "b", status: "running" }, { name: "c", status: "failed" }] });
    expect(await until("모름", () => last()?.quality === "unknown" && last())).toMatchObject({ quality: "unknown", count: null });
    f.core.drawGeminiStatus("m_gem1", { subagents: [{ name: "b", status: "running" }, { name: "d" }] });
    await Bun.sleep(80);
    expect(last()).toMatchObject({ quality: "unknown", count: null });
    // 다시 아는 상태만 남으면 정확한 수로 돌아온다.
    f.core.drawGeminiStatus("m_gem1", { subagents: [{ name: "b", status: "running" }, { name: "e", status: "running" }, { name: "c", status: "completed" }] });
    expect(await until("서브에이전트 2", () => last()?.count === 2 && last())).toMatchObject({ quality: "exact", count: 2 });
    f.core.drawGeminiStatus("m_gem1", { subagents: [] });
    await until("다시 0", () => last()?.quality === "exact" && last()?.count === 0);
    // 그 칸을 모르던 래퍼가 쓴 기록(subagentsUnknown 없음)도 정확한 수로 내지 않는다.
    const id = f.runner.observationState("m_gem1")!.identity.sessionId!;
    const { subagentsUnknown: _dropped, ...older } = geminiStatusFromPayload("m_gem1", { conversation_id: id, subagents: [{ status: "running" }] }, new Date(Date.now() + 5), launchOf(f));
    writeFileSync(geminiStatusPath(f.home, "m_gem1"), JSON.stringify(older));
    expect(await until("모름", () => last()?.quality === "unknown" && last())).toMatchObject({ quality: "unknown", count: null });
  });
  test("logWrittenAt: 이 대화의 상태줄 기록이 쓰인 때", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    expect(f.runner.logWrittenAt("m_gem1")).toBeNull();
    const id = await turn(f, { ...f.member, paneId: started.paneId }, "한 턴");
    const at = f.runner.logWrittenAt("m_gem1");
    expect(at).toBe(readGeminiStatus(f.home, "m_gem1")!.at);
    // 다시 그리면 그 시각으로 오른다.
    await Bun.sleep(5);
    f.core.drawGeminiStatus("m_gem1");
    expect(Date.parse(f.runner.logWrittenAt("m_gem1")!)).toBeGreaterThan(Date.parse(at!));
    // 다른 대화의 기록이 되면(대화 id 가 비었다) 근거로 쓰지 않는다.
    f.core.drawGeminiStatus("m_gem1", { conversation_id: "", session_id: "" });
    expect(readGeminiStatus(f.home, "m_gem1")).toMatchObject({ conversationId: null, launch: launchOf(f) });
    expect(f.runner.logWrittenAt("m_gem1")).toBeNull();
    // 다른 터미널이 쓴 기록(띄우기 값이 다르다)도 근거가 아니다.
    putStatus(f, { conversation_id: id }, "another-terminal");
    expect(f.runner.logWrittenAt("m_gem1")).toBeNull();
    expect(id.length).toBeGreaterThan(0);
  });
});

describe("로그인·첫 설정 막힘: 알리기만 하고 키를 보내지 않는다", () => {
  test.each([
    ["Finish setup(base64, kind question)", { state: "blocked", kind: "question", app: "antigravity", msg: "RmluaXNoIHNldHVw" }],
    ["Sign in required(base64, kind auth)", { state: "blocked", kind: "auth", app: "antigravity", msg: "U2lnbiBpbiByZXF1aXJlZA==" }],
    ["Finish setup(풀린 글)", { state: "blocked", kind: "question", app: "antigravity", msg: "Finish setup" }],
  ])("%s → 막힘 사유 setup, 관측 메모 gemini_setup", async (_name, status) => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    f.core.setStatus("m_gem1", status);
    f.core.setScreen("m_gem1", "Welcome to Antigravity CLI\n\nChoose a color theme\n> 1. Dark\n  2. Light\n");
    const blocked = await until("막힘 알림", () => f.events.findLast(e => e.type === "status" && e.status === "blocked")) as Extract<RunnerEvent, { type: "status" }>;
    expect(blocked).toMatchObject({ status: "blocked", blockedReason: "setup", observation: { source: "core", freshness: "fresh", ownership: "verified", error: { code: GEMINI_SETUP_CODE, note: GEMINI_SETUP_NOTE } } });
    expect(f.runner.observationState("m_gem1")?.setupError).toEqual({ code: "gemini_setup", note: GEMINI_SETUP_NOTE });
    // 앱에서 답할 창이 아니다: 승인 카드를 만들지 않고, 답하려 해도 키를 보내지 않는다.
    expect(await f.runner.approval(live)).toBeNull();
    expect(await f.runner.answerApproval(live, "any-fingerprint", 1)).toEqual({ ok: false, reason: "unrecognized" });
    expect(await f.runner.send(live, "지시", f.opts)).toMatchObject({ ok: false, reason: "blocked", deliveryEffect: "not_written" });
    // '중단'도 키(Esc)를 보내지 않는다: 그 키가 동의 창의 답이 될 수 있다.
    const stopped = await rejection(f.runner.interrupt(live));
    expect((stopped as CoreError).kind).toBe("no_turn");
    expect(f.core.count("terminal.interrupt")).toBe(0);
    expect(f.core.keys).toEqual([]);
    expect(f.core.turns("m_gem1")).toEqual([]);
    // 사람이 설정을 끝내 쉬는 중이 되면 메모가 사라진다.
    f.core.setStatus("m_gem1", { state: "idle", app: "antigravity" });
    f.core.setScreen("m_gem1", null);
    await until("쉬는 중", () => f.events.at(-1)?.type === "status" && (f.events.at(-1) as { status: string }).status === "idle");
    expect(f.runner.observationState("m_gem1")?.setupError).toBeNull();
  });
  test.each([
    ["상태 보고가 아직 없다(뜨는 중: 첫 화면이 약관 동의일 수 있다)", null],
    ["문구가 달라 알아보지 못한 물음(현지화·바뀐 문구)", { state: "blocked", kind: "question", app: "antigravity", msg: "설정을 마쳐 주세요" }],
    ["종류를 모르는 막힘", { state: "blocked", app: "antigravity" }],
  ])("'중단': %s → 멈출 턴이 확실하지 않으면 멈춤 키를 보내지 않는다", async (_name, status) => {
    const f = await setup({}, { startState: null });
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    if (status) f.core.setStatus("m_gem1", status);
    f.core.setScreen("m_gem1", "Terms of Service & Data Use\n\n  > [x] Yes, I agree\n");
    await Bun.sleep(80);
    const stopped = await rejection(f.runner.interrupt(live));
    expect((stopped as CoreError).kind).toBe("no_turn");
    expect(f.core.count("terminal.interrupt")).toBe(0);
    expect(f.core.keys).toEqual([]);
  });
  test("폴더 신뢰 창: 파서가 없다. 상태 보고 없이 그런 창이 보이면 '터미널에서 직접 답하기' 안내만 하고, 답하려 해도 키를 보내지 않는다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    f.core.setStatus("m_gem1", null);
    f.core.setScreen("m_gem1", `Do you trust the contents of this project?\n\n  ${f.home}\n\n> 1. Yes, I trust this folder\n  2. No, exit\n\nenter to confirm\n`);
    const blocked = await until("막힘 알림", () => f.events.findLast(e => e.type === "status" && e.status === "blocked")) as Extract<RunnerEvent, { type: "status" }>;
    expect(blocked).toMatchObject({ blockedReason: "status_unknown", observation: { error: { code: "trust_dialog_unrecognized" } } });
    expect(await f.runner.approval(live)).toBeNull();
    expect(await f.runner.answerApproval(live, "any-fingerprint", 1)).toEqual({ ok: false, reason: "unrecognized" });
    // Codex 의 폴더 신뢰 창 모양이어도 agy 팀장에게는 Codex 파서로 답하지 않는다.
    f.core.setScreen("m_gem1", `Folder access\n\n  ${f.home}\n\n  Trust this folder?\n  Codex can read, edit, and run files here. Your trust decision will be saved.\n\n› 1. Trust and continue\n  2. Quit\n\n  enter continue · esc quit\n`);
    expect(await f.runner.approval(live)).toBeNull();
    expect(await f.runner.answerApproval(live, "any-fingerprint", 1)).toEqual({ ok: false, reason: "unrecognized" });
    expect(f.core.keys).toEqual([]);
  });
  test("다른 질문 창(kind question)은 지금처럼 선택 대기다. Claude·Codex 팀장의 같은 보고는 바뀌지 않는다", async () => {
    const f = await setup();
    await f.runner.start(f.member, f.opts);
    f.core.setStatus("m_gem1", { state: "blocked", kind: "question", app: "antigravity", msg: "Accept this file edit?" });
    f.core.setScreen("m_gem1", "Accept this file edit?\n> 1. Yes, accept this change\n  2. No, reject this change\n");
    const blocked = await until("막힘 알림", () => f.events.findLast(e => e.type === "status" && e.status === "blocked")) as Extract<RunnerEvent, { type: "status" }>;
    expect(blocked).toMatchObject({ blockedReason: "selection", observation: { error: null } });
    for (const cli of ["claude", "codex"] as const) {
      const g = await setup({ cli, id: `m_${cli}` });
      await g.runner.start(g.member, g.opts);
      g.core.setStatus(g.member.id, { state: "blocked", kind: "question", msg: "Finish setup" });
      g.core.setScreen(g.member.id, "Some dialog\n");
      const other = await until("막힘 알림", () => g.events.findLast(e => e.type === "status" && e.status === "blocked")) as Extract<RunnerEvent, { type: "status" }>;
      expect(other).toMatchObject({ blockedReason: "selection", observation: { error: null } });
    }
  });
});

/** agy 1.5.14 실측 화면 견본(tests/fixtures/cli/gemini/1.5.14). */
const realScreen = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "cli", "gemini", "1.5.14", `${name}.txt`), "utf8");

describe("1.5.14 실측: 폴더 신뢰 창은 대표가 볼 창이다", () => {
  test.each([
    ["OSC 글(풀린 글)", { state: "blocked", kind: "permission", app: "antigravity", msg: "Trust this folder?" }],
    ["OSC 글(base64)", { state: "blocked", kind: "permission", app: "antigravity", msg: Buffer.from("Trust this folder?").toString("base64") }],
    ["OSC 글이 다르다(화면으로 안다)", { state: "blocked", kind: "permission", app: "antigravity", msg: "Confirm" }],
    ["상태 보고가 아직 없다(화면으로 안다)", null],
  ])("%s → 도구 승인이 아니다: 막힘 사유 setup·관측 gemini_folder_trust, 전달 보류, 승인·멈춤 키를 보내지 않는다", async (_name, status) => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    f.core.setStatus("m_gem1", status);
    f.core.setScreen("m_gem1", realScreen("folder-trust"));
    const blocked = await until("막힘 알림", () => f.events.findLast(e => e.type === "status" && e.status === "blocked")) as Extract<RunnerEvent, { type: "status" }>;
    expect(blocked).toMatchObject({ status: "blocked", blockedReason: "setup", observation: { error: { code: GEMINI_FOLDER_TRUST_CODE } } });
    expect(blocked.observation!.error!.note).toBe(`Antigravity CLI가 이 폴더를 신뢰할지 묻고 있습니다. IAMCEO는 이 창에 답하지 않습니다. 터미널을 열어 직접 답해 주세요: ${f.member.cwd}`);
    expect(await f.runner.approval(live)).toBeNull();
    expect(await f.runner.answerApproval(live, "any-fingerprint", 1)).toEqual({ ok: false, reason: "unrecognized" });
    expect(await f.runner.send(live, "지시", f.opts)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
    // 예전에는 permission 이라 멈춤 키(Esc)를 보냈다: 그 키가 이 창의 답('No, exit')일 수 있다.
    const stopped = await rejection(f.runner.interrupt(live));
    expect((stopped as CoreError).kind).toBe("no_turn");
    expect(f.core.count("terminal.interrupt")).toBe(0);
    expect(f.core.keys).toEqual([]);
    expect(f.core.turns("m_gem1")).toEqual([]);
    // 대표가 터미널에서 답해 쉬는 중이 되면 메모가 사라진다.
    f.core.setStatus("m_gem1", { state: "idle", app: "antigravity" });
    f.core.setScreen("m_gem1", null);
    await until("쉬는 중", () => f.runner.observationState("m_gem1")?.setupError === null);
  });
  test("도구 승인 창(같은 permission)은 지금처럼 승인 대기이고 멈춤 키가 간다(Esc = 거절하고 턴을 끝낸다)", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    f.core.setStatus("m_gem1", { state: "blocked", kind: "permission", app: "antigravity", msg: "Approve Bash: ls -la ." });
    f.core.setScreen("m_gem1", realScreen("approval-command"));
    const blocked = await until("막힘 알림", () => f.events.findLast(e => e.type === "status" && e.status === "blocked")) as Extract<RunnerEvent, { type: "status" }>;
    expect(blocked).toMatchObject({ blockedReason: "permission", observation: { error: null } });
    await f.runner.interrupt(live);
    expect(f.core.count("terminal.interrupt")).toBe(1);
  });
});

describe("1.5.14 실측: 재시도 진행 줄은 Claude 의 응답 대기와 같은 관측(network_retry)이다", () => {
  test("'Model unavailable (attempt N/9), retrying in Ns...' 가 보이는 동안 network_retry, 사라지면 지운다", async () => {
    const f = await setup();
    await f.runner.start(f.member, f.opts);
    f.core.setStatus("m_gem1", { state: "working", app: "antigravity" });
    f.core.setScreen("m_gem1", realScreen("network-retry"));
    const retry = await until("재시도 관측", () => f.events.findLast(e => e.type === "status" && e.observation?.error?.code === "network_retry")) as Extract<RunnerEvent, { type: "status" }>;
    expect(retry).toMatchObject({ status: "working", blockedReason: null, observation: { error: { code: "network_retry", note: "API 연결 복구를 기다리며 CLI가 재시도하고 있습니다" } } });
    f.core.setScreen("m_gem1", realScreen("working-first"));
    await until("재시도 끝", () => f.runner.observationState("m_gem1")?.setupError === null);
    // 대화 위쪽(지난 글)에만 그 줄이 남은 화면은 재시도가 아니다.
    expect(f.events.filter(e => e.type === "status" && e.observation?.error?.code === "network_retry")).toHaveLength(1);
  });
});

describe("1.5.14 실측: OSC 턴 끝(done·idle·error)과 Stop 훅", () => {
  test("Esc 로 멈춘 턴은 done 없이 idle 이고 Stop 이 없다: 오류로 끝난 턴이 아니다. 정상 끝(done)·장애(error + Stop ERROR)는 각각 맞게 끝낸다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    await turn(f, live, "첫 턴");
    expect(ofType(f.events, "turn_end").at(-1)).toMatchObject({ isError: false });
    // 멈춘 턴: 가짜 agy 는 실제처럼 idle 로 알리고 Stop 을 쓰지 않는다.
    const ended = ofType(f.events, "turn_end").length;
    expect(await f.runner.send(live, "오래 걸리는 일 @fake:hold", f.opts)).toMatchObject({ ok: true });
    await until("일하는 중", () => f.core.terminalOf("m_gem1")?.status?.state === "working");
    await f.runner.interrupt(live);
    await until("멈춘 턴 끝", () => ofType(f.events, "turn_end").length > ended);
    expect(f.core.terminalOf("m_gem1")?.status?.state).toBe("idle");
    expect(ofType(f.events, "turn_end").at(-1)).toMatchObject({ isError: false });
    expect(ofType(f.events, "turn_end").at(-1)!.errorText).toBeUndefined();
    // 장애: OSC error(msg) + Stop ERROR → 오류 글은 둘을 잇는다.
    const before = ofType(f.events, "turn_end").length;
    expect(await f.runner.send(live, "@fake:error=network @fake:oscmsg=There%20was%20a%20network%20issue%20connecting%20to%20the%20server%2C%20please%20try%20again. @fake:stoperror=generating%20and%20executing%3A%20request%20failed%3A%20unexpected%20EOF 일", f.opts)).toMatchObject({ ok: true });
    await until("장애 턴 끝", () => ofType(f.events, "turn_end").length > before);
    expect(ofType(f.events, "turn_end").at(-1)).toMatchObject({ isError: true, errorText: "There was a network issue connecting to the server, please try again. · generating and executing: request failed: unexpected EOF" });
  });
});

describe("전달 수신 증거: 훅 기록(PreInvocation)의 표지", () => {
  const probe = (f: Fixture, runner: CoreRunner, member: RunnerMember, markers: { deliveryId: string; marker: string }[], hookMark: unknown, sessionId: string | null): DeliveryProbe => ({
    dispatchId: "dispatch-1", cli: "gemini", backend: "core", markers, bundleMarker: BUNDLE, wireSha256: "0".repeat(64),
    identity: { ...runner.observationState(member.id)!.identity, sessionId },
    baseline: { serverEpoch: "epoch", turn: 0, inputEpoch: 0, logs: runner.deliveryBaseline(member), capturedAt: new Date().toISOString(), ...(hookMark !== undefined ? { hookMark: hookMark as never } : {}) },
  });
  test("봉투를 쓰기 직전의 자리 뒤에 표지가 있으면 받은 것. 없으면 모른다(안 받았다고 하지 않는다)", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    // 기록 기준선은 없고(줄 단위 기록이 없다), 훅 사건 파일의 자리를 기준으로 삼는다.
    expect(f.runner.deliveryBaseline(live)).toEqual([]);
    const mark = f.runner.deliveryHookMark(live);
    expect(mark).toEqual({ identity: null, offset: 0 });
    const markers = [{ deliveryId: "d1", marker: ITEM }, { deliveryId: "d2", marker: ITEM2 }];
    const first = probe(f, f.runner, live, markers, mark, null);
    const id = await turn(f, live, `[총괄 → 팀장] 첫 건 ${ITEM}\n둘째 건 ${ITEM2}\n\n${BUNDLE}`);
    const known = { ...live, sessionId: id };
    // 첫 전달은 대화 id 를 알기 전에 나갔다(봉투의 세션 id 가 비어 있다). 그래도 같은 세대의 봉투면 본다.
    expect(first.identity.sessionId).toBeNull();
    const received = await f.runner.inspectDelivery(known, first);
    expect(received.finding).toBe("received");
    expect(received.receivedDeliveryIds.sort()).toEqual(["d1", "d2"]);
    expect(received.evidence[0]).toMatchObject({ source: "gemini_log", verdict: "present", location: "received_input", code: "marker_in_user_input" });
    expect(received.evidence[1]).toMatchObject({ source: "core_screen", code: "empty" });
    // 그 뒤의 자리에서 보면 그 표지는 없다: 모름이다. not_received·draft_only 는 내지 않는다.
    const later = f.runner.deliveryHookMark(known);
    expect(typeof later?.identity).toBe("string");
    expect(later!.offset).toBeGreaterThan(0);
    const missing = await f.runner.inspectDelivery(known, probe(f, f.runner, known, markers, later, id));
    expect(missing.finding).toBe("unknown");
    expect(missing.receivedDeliveryIds).toEqual([]);
    expect(missing.evidence[0]).toMatchObject({ source: "gemini_log", verdict: "unknown", code: "marker_not_in_hook_log" });
    // 자리가 없는 봉투(옛 서버가 썼거나 읽지 못함)도 모름이다.
    expect((await f.runner.inspectDelivery(known, probe(f, f.runner, known, markers, undefined, id))).evidence[0]).toMatchObject({ source: "gemini_log", verdict: "unknown", code: "no_baseline" });
    // 다른 세대의 봉투는 보지 않는다.
    expect((await f.runner.inspectDelivery(known, { ...first, identity: { ...first.identity, sessionGeneration: 7 } })).evidence[0]).toMatchObject({ source: "transport", code: "identity_changed" });
    // Codex·Claude 의 기록 읽기로 떨어지지 않았다.
    for (const inspection of [received, missing]) expect(inspection.evidence.some(e => e.source === "codex_log" || e.source === "claude_log")).toBe(false);

    // 터미널이 사라진 뒤에도 같은 근거로 본다(첫 전달의 봉투에는 대화 id 가 없어도 된다).
    // 다른 묶음의 봉투(다른 묶음 표지): 그 표지는 기록에 없다.
    const unrelated = { ...probe(f, f.runner, known, [{ deliveryId: "d9", marker: "#iamceo_DDDDDDDDDDDDDDDDDDDDDD" }], { identity: null, offset: 0 }, id), bundleMarker: "#iamceo_b_EEEEEEEEEEEEEEEEEEEEEE" };
    await f.runner.stop(known);
    const gone = f.runner.inspectGoneDelivery({ ...known, paneId: null }, first);
    expect(gone).toMatchObject({ finding: "received", snapshot: null, quiescence: "settled" });
    expect(gone.receivedDeliveryIds.sort()).toEqual(["d1", "d2"]);
    expect(gone.evidence).toHaveLength(1);
    expect(gone.evidence[0]).toMatchObject({ source: "gemini_log", verdict: "present" });
    const goneMissing = f.runner.inspectGoneDelivery({ ...known, paneId: null }, unrelated);
    expect(goneMissing).toMatchObject({ finding: "unknown", receivedDeliveryIds: [], quiescence: "unresolved" });
    expect(goneMissing.evidence[0]).toMatchObject({ source: "gemini_log", verdict: "unknown" });
    // 다른 세대의 봉투는 보지 않는다.
    expect(f.runner.inspectGoneDelivery({ ...known, paneId: null, sessionGeneration: 2 }, first)).toMatchObject({ finding: "unknown", evidence: [{ source: "gemini_log", code: "identity_changed" }] });
    expect(f.runner.inspectGoneDelivery({ ...known, paneId: null }, { ...first, cli: "codex" })).toMatchObject({ finding: "unknown", evidence: [{ source: "gemini_log", code: "identity_changed" }] });
  });
  test("훅을 넣지 않는 환경이면 자리도 근거도 없다(모름)", async () => {
    const f = await setup();
    const quiet = f.newRunner({}, { hookEvents: false });
    const started = await quiet.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    expect(quiet.deliveryHookMark(live)).toBeUndefined();
    // 기록 사건은 싣지 않는다(도구 훅 PreToolUse 만 있다: 작업 폴더 바로잡기는 기록과 따로다).
    const hooksFile = join(f.home, "run", "agy", "m_gem1", ".agents", "hooks.json");
    expect(Object.keys(JSON.parse(readFileSync(hooksFile, "utf8")).iamceo)).toEqual(["PreToolUse"]);
    expect(geminiHooksRecordTurns(hooksFile)).toBe(false);
    expect(await quiet.send(live, `전달 ${ITEM}\n\n${BUNDLE}`, f.opts)).toMatchObject({ ok: true });
    await until("턴 끝", () => f.core.turns("m_gem1")[0]?.outcome === "done");
    expect(existsSync(geminiHookEventsDir(f.home))).toBe(false);
    const id = await until("대화 id", () => quiet.observationState("m_gem1")?.identity.sessionId);
    const inspection = await quiet.inspectDelivery({ ...live, sessionId: id }, probe(f, quiet, live, [{ deliveryId: "d1", marker: ITEM }], undefined, id));
    expect(inspection.finding).toBe("unknown");
    expect(inspection.evidence[0]).toMatchObject({ source: "gemini_log", verdict: "unknown", code: "hooks_off" });
  });
});

describe("Claude·Codex 전용 보정은 꺼져 있다", () => {
  test("일하는 중의 턴 끝은 OSC 보고만 따른다: Codex 백그라운드 터미널 화면·Claude 뒤 작업 화면으로 끝내지 않는다", async () => {
    // Codex·Claude 의 보정은 일하는 중의 관측마다 실행 기록(lastWrittenRun)을 묻는다. gemini 는 대화 id 의 둘째 근거(훅 기록)를 찾을 때 터미널마다 한 번만 묻는다.
    let asked = 0;
    const f = await setup({}, {}, { recoveryStore: { inputState: () => ({ unresolvedDispatches: [], lease: null }), lastWrittenRun: () => { asked++; return null; }, saveLease() {}, removeLease() {} } as never });
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    expect(await f.runner.send(live, "오래 걸리는 일 @fake:hold", f.opts)).toMatchObject({ ok: true });
    await until("일하는 중", () => f.core.held("m_gem1"));
    // Codex 의 '백그라운드 터미널만 남음' 화면, Claude 의 '뒤 작업 기다림' 화면을 흉내 내도 agy 의 턴은 끝난 것으로 읽지 않는다.
    for (const screen of ["› \n  1 background terminal running · /ps to view · /stop to close\n  ? for shortcuts\n", composerScreen("✻ Waiting for 1 dynamic workflow to finish\n")]) {
      f.core.setScreen("m_gem1", screen);
      await f.runner.screen(live);
      await Bun.sleep(60);
      expect(f.runner.isBusy("m_gem1")).toBe(true);
      expect(f.runner.backgroundTerminals("m_gem1")).toBeNull();
      expect(f.runner.claudeBackground("m_gem1")).toBe(false);
      expect(f.runner.observationState("m_gem1")?.state).toBe("working");
    }
    expect(ofType(f.events, "turn_end")).toEqual([]);
    expect(asked).toBeLessThanOrEqual(1);
    // 일하는 중에는 넣지 않는다.
    expect(await f.runner.send(live, "끼어들기", f.opts)).toMatchObject({ ok: false, reason: "busy" });
    f.core.setScreen("m_gem1", null);
    f.core.release("m_gem1");
    await until("턴 끝", () => ofType(f.events, "turn_end").length === 1);
    expect(ofType(f.events, "turn_end")[0]).toMatchObject({ isError: false });
    expect(ofType(f.events, "turn_end")[0]!.reason).toBeUndefined();
    // Claude 훅 자리(run/events)는 gemini 팀장의 것이 아니다.
    expect(existsSync(join(f.home, "run", "events", "m_gem1.jsonl"))).toBe(false);
  });
  test("오류로 끝난 턴(OSC error)은 지금처럼 오류 턴 끝이고, 그 뒤 입력을 받는다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    expect(await f.runner.send(live, "실패하는 일 @fake:error=RESOURCE_EXHAUSTED", f.opts)).toMatchObject({ ok: true });
    const ended = await until("오류 턴 끝", () => ofType(f.events, "turn_end")[0]);
    expect(ended).toMatchObject({ isError: true, errorText: "RESOURCE_EXHAUSTED" });
    const id = await until("대화 id", () => f.runner.observationState("m_gem1")?.identity.sessionId);
    expect(await f.runner.send({ ...live, sessionId: id }, "다시", f.opts)).toMatchObject({ ok: true });
  });
});

describe("설정 적용·도구 호출", () => {
  test("applyConfig: 쉬는 세션을 같은 대화로 다시 연다(--conversation)", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    // id 를 모르는 동안은 다시 열 수 없다(새 대화가 된다).
    expect(await f.runner.applyConfig(live, f.opts)).toMatchObject({ ok: false, detail: "Antigravity conversation id is unknown; explicitly start a fresh session" });
    const id = await turn(f, live, "한 턴");
    const known = { ...live, sessionId: id, model: "gemini-4-argon", effort: "low" };
    expect(await f.runner.applyConfig(known, f.opts)).toEqual({ ok: true });
    const reopened = f.core.runs()[1]!;
    expect(reopened.conversationFlag).toBe(id);
    expect(reopened.argv).toEqual(expect.arrayContaining(["--model", "gemini-4-argon", "--effort", "low"]));
    expect(f.core.terminals().map(t => t.state)).toEqual(["finished", "live"]);
    expect(f.runner.observationState("m_gem1")?.identity.sessionId).toBe(id);
  });
  test("가짜 agy 는 주입 폴더의 mcp_config.json 이 가리키는 환경 파일의 주소·토큰으로 도구를 부른다", async () => {
    const calls: { auth: string | null; body: unknown }[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) { calls.push({ auth: request.headers.get("authorization"), body: await request.json() }); return new Response(JSON.stringify({ ok: true })); } });
    cleanups.push(() => { server.stop(true); });
    const f = await setup();
    writeFileSync(f.opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: ["bridge"], env: { IAMCEO_TOKEN: "member-token", IAMCEO_URL: `http://127.0.0.1:${server.port}` } } } }), { mode: 0o600 });
    const started = await f.runner.start(f.member, f.opts);
    expect(readFileSync(join(f.core.runs()[0]!.addDir!, ".agents", "mcp_config.json"), "utf8")).not.toContain("member-token");
    expect(readFileSync(`${f.core.runs()[0]!.addDir!}.env`, "utf8")).toContain("member-token");
    await turn(f, { ...f.member, paneId: started.paneId }, "보고해 주세요 @fake:post=끝났습니다");
    expect(calls).toEqual([{ auth: "Bearer member-token", body: { name: "post", args: { kind: "완료", title: "끝났습니다" } } }]);
    expect(f.core.turns("m_gem1")[0]!.tools).toMatchObject([{ name: "post", status: 200 }]);
  });
});

// 운영 조립 그대로(가짜 core + 실제 CoreRunner + 실제 총괄 + 실제 HTTP 서버): 시험 틀(coreSetup)이 Gemini 팀장을 끝까지 돌리는지 본다.
describe("시험 틀(coreSetup)의 Gemini 팀장", () => {
  const TOOLS: AgentToolsImpl = {
    listAgentTools: () => [],
    async handleAgentTool(orch, member, name, args) {
      if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
      return { text: "모르는 도구", isError: true };
    },
  };
  test("팀장을 더하면 agy 로 뜨고, 첫 지시가 들어가고, 도구가 불리고, 대화 id 가 팀장에 적힌다", async () => {
    const t = await coreSetup({ agentTools: TOOLS, timings: { tickMs: 150, healthMs: 40, retryMs: 30, inputBusyRetryMs: 30, writeSettleMs: 40, startGraceMs: 200, blockedNoticeMs: 60 } });
    cleanups.push(() => t.close());
    // 이 틀은 이 Mac 의 agy·~/.gemini 를 쓰지 않는다.
    expect(t.config.geminiBin).toBe(FAKE_BIN);
    expect(t.config.geminiHome).toBe(join(t.home, "gemini-home"));
    expect(t.core.geminiHome).toBe(join(t.home, "gemini-home"));
    await t.orch.addMember(t.project.id, { name: "자료 조사", handle: "research", role: "자료 조사", cli: "gemini", firstInstruction: "자료를 찾아 보고하세요 @fake:post=조사_끝" });
    const member = await t.waitFor("명부", () => t.store.listMembers(t.project.id).find(m => m.handle === "research"));
    expect(member.cli).toBe("gemini");
    const first = await t.waitFor("첫 턴", () => t.core.turns(member.id).find(turn => turn.prompt.includes("자료를 찾아 보고하세요")), 15_000);
    await t.waitFor("첫 턴 끝", () => first.outcome === "done", 15_000);
    const run = first.run;
    expect(run.cli).toBe("gemini");
    expect(run.argv[0]).toBe(FAKE_BIN);
    expect(run.argv).toContain("--add-dir");
    expect(run.argv).not.toContain("--mcp-config");
    expect(run.env.AGY_CLI_OSC7501).toBe("on");
    expect(run.addDir).toBeTruthy();
    expect(existsSync(join(run.addDir!, ".agents", "mcp_config.json"))).toBe(true);
    expect(readFileSync(join(run.addDir!, ".agents", "rules", "iamceo-01.md"), "utf8")).toContain("trigger: always_on");
    // 도구 호출이 주입 폴더의 MCP 설정으로 이 시험 서버에 닿았다.
    expect(first.tools).toMatchObject([{ name: "post", status: 200 }]);
    // agy 가 정한 대화 id 가 팀장에 적힌다(상태줄 기록 → session 사건).
    const id = await t.waitFor("대화 id", () => t.member(member.id).sessionId, 15_000);
    expect(id).toBe(run.sessionId!);
    await t.idle(member.id);
    expect(t.member(member.id).status).not.toBe("error");
  }, 40_000);
});

describe("첫 전달 앞에 MCP 를 띄운다(대화형 agy 는 MCP 서버를 프로세스의 첫 입력 때 띄운다, 1.5.14 실측 11-23)", () => {
  // 실측: 입력 전의 agy 에는 MCP 다리 프로세스가 없고 첫 입력 시각에 뜬다. 그 첫 턴의 모델 호출에는 연결 도구가 없어, 대화형 IAMCEO 대화 여섯 개 모두
  // 첫 턴에 call_mcp_tool 이 없었다(auto 총괄은 일을 나누지 못하고 열쇠 파일을 뒤졌다). 맨 /mcp 는 모델을 부르지 않고 MCP 를 띄운다.
  // 가짜 agy(core-harness geminiMcp "lazy", 기본)는 MCP 가 뜨기 전의 첫 입력 턴에 turn.mcp=false 를 적고 그 턴의 도구는 서버에 닿지 않는다.
  test("새 터미널의 첫 전달: 맨 /mcp → 관리 창의 ✓ iamceo → Esc 한 번으로 닫고 → 넣는다. 그 턴은 MCP 가 떠 있다. 둘째 전달에는 다시 하지 않는다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    const conversation = await turn(f, live, `첫 지시 ${ITEM}`);
    expect(f.core.mcpOpens).toEqual([started.paneId]);
    expect(f.core.keys).toEqual([{ terminal: started.paneId, keys: ["esc"] }]);
    expect(f.core.mcpPanelOpen("m_gem1")).toBe(false);
    // /mcp 는 턴이 아니다: 턴은 전달 하나이고, 그 턴이 시작될 때 MCP 가 떠 있었다.
    expect(f.core.turns("m_gem1").map(t => [t.prompt.endsWith(`첫 지시 ${ITEM}`), t.mcp])).toEqual([[true, true]]);
    await turn(f, { ...live, sessionId: conversation }, "둘째 지시");
    expect(f.core.mcpOpens).toHaveLength(1);
    expect(f.core.keys).toHaveLength(1);
    expect(f.core.turns("m_gem1").map(t => t.mcp)).toEqual([true, true]);
  });
  test("이어 연 대화(--conversation)도 새 프로세스라 첫 전달 앞에 다시 띄운다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    const conversation = await turn(f, live, "첫 지시");
    const known = { ...live, sessionId: conversation };
    await f.runner.stop(known);
    const resumed = await f.runner.start({ ...known, paneId: null }, { ...f.opts, resume: true });
    expect(f.core.runs()[1]!.conversationFlag).toBe(conversation);
    await turn(f, { ...known, paneId: resumed.paneId }, "이어 연 뒤 첫 지시");
    expect(f.core.mcpOpens).toEqual([started.paneId, resumed.paneId]);
    expect(f.core.turns("m_gem1").map(t => t.mcp)).toEqual([true, true]);
  });
  test("관리 창이 닫히지 않으면 넣지 않는다(input_busy, 창이 보일 때만 Esc). 두 번 닫지 못하면 그만두고, 창이 남아 입력칸을 알아보지 못하면 넣지 않는다", async () => {
    const f = await setup({}, { geminiMcp: "stuck" }, { geminiMcpPrimeMs: 300 });
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    const stuck = { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written", detail: "The Antigravity MCP manager opened before the first delivery did not close" };
    expect(await f.runner.send(live, "지시", f.opts)).toMatchObject(stuck);
    // 둘째 시도는 /mcp 를 다시 넣지 않고(창이 이미 열려 있다) 닫기만 해 본다.
    expect(await f.runner.send(live, "지시", f.opts)).toMatchObject(stuck);
    expect(await f.runner.send(live, "지시", f.opts)).toMatchObject({ ok: false, reason: "input_busy", detail: "Cannot identify an empty CLI composer" });
    expect(f.core.mcpOpens).toEqual([started.paneId]);
    expect(f.core.keys.map(k => k.keys)).toEqual(Array(6).fill(["esc"]));
    expect(f.core.turns("m_gem1")).toEqual([]);
  }, 20_000);
  test("창이 열리지 않고 /mcp 가 입력칸에 글로 남으면 IAMCEO 가 넣은 그 글만 지우고 넣는다(그 턴은 예전처럼 MCP 없이 돈다)", async () => {
    const f = await setup({}, { geminiMcp: "no_panel" }, { geminiMcpPrimeMs: 300 });
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    await turn(f, live, "지시");
    expect(f.core.keys).toEqual([{ terminal: started.paneId, keys: ["backspace", "backspace", "backspace", "backspace"] }]);
    expect(f.core.turns("m_gem1").map(t => [t.prompt.endsWith("지시"), t.mcp])).toEqual([[true, false]]);
  });
  test("이미 입력이 들어간 터미널(사람이 직접 친 턴)에는 하지 않는다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.member, f.opts);
    const live = { ...f.member, paneId: started.paneId };
    f.core.typeDirectly("m_gem1", "사람이 친 글");
    await until("사람 턴 끝", () => f.core.turns("m_gem1")[0]?.outcome === "done" && f.runner.observationState("m_gem1")?.state === "done");
    const conversation = await until("대화 id", () => f.runner.observationState("m_gem1")?.identity.sessionId);
    await turn(f, { ...live, sessionId: conversation }, "서버 지시");
    expect(f.core.mcpOpens).toEqual([]);
    expect(f.core.keys).toEqual([]);
    expect(f.core.turns("m_gem1").map(t => t.mcp)).toEqual([false, true]);
  });
});
