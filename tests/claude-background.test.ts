// 11-16 핫픽스 C: Claude 의 턴 끝을 잘못 보던 세 경우.
// 1. 뒤 작업(Workflow·백그라운드 에이전트·셸·Monitor)을 띄우고 턴을 끝낸 Claude: core 는 그 작업이 끝날 때까지 working 을 알린다(라이브 3시간 10분).
//    화면(빈 입력칸·일하는 중의 상태 줄 없음)과 Claude 자기 기록(전달 기준선 뒤의 stop_hook_summary·turn_duration, 또는 봉투 자리 뒤의 Stop 훅)이
//    함께 그 끝을 보이면 업무를 성공으로 닫고 쉬는 중으로 보이며, 다음 전달은 그동안에도 넣는다(if:"working").
// 2. 로그인 오류(authentication_failed)로 끝난 턴: core 가 끝을 알리지 않아도 오류로 닫고 '로그인 필요' 막힘으로 보이며 전달은 보류한다.
// 3. 쉬는 동안의 자동 압축(Compacted while idle): 실행 기록이 없으면 턴 끝으로 세지 않고 문맥은 압축 뒤 값으로 둔다.
// 기록·화면 견본은 라이브 기록의 줄 종류·키·순서를 흉내 낸 가짜 글이다(tests/fixtures/cli/claude/2.1.323/ 의 합성 견본과 같은 모양).
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import { claudeQuietScreen } from "../server/runner/claude-screen.ts";
import { claudeHookTurn, readClaudeTurn, type ClaudeTurnQuery } from "../server/runner/claude-turn.ts";
import type { HookEventRecord } from "../server/runner/hook-events.ts";
import { hookEventsDir, hookEventsFile } from "../server/runner/hooks.ts";
import { parseTranscriptTail, transcriptPath } from "../server/runner/transcript.ts";
import type { RunnerEvent } from "../server/runner/types.ts";
import { ERROR_CODES } from "../shared/error-codes.ts";
import type { DecisionOption, Member } from "../shared/types.ts";
import { composerScreen, coreSetup, type CoreEnv, type CoreSetupOptions } from "./fixtures/core-harness.ts";
import { rejection } from "./fixtures/settle.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "cli", "claude", "2.1.323");
const WAIT_SCREEN = readFileSync(join(FIXTURES, "background-wait.txt"), "utf8");
const WORKING_SCREEN = readFileSync(join(FIXTURES, "background-working.txt"), "utf8");
const IDLE_SCREEN = readFileSync(join(FIXTURES, "idle.txt"), "utf8");

const rows = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const MARKER = "#iamceo_" + "a".repeat(22), BUNDLE = "#iamceo_b_" + "b".repeat(22);
// 실측(2.1.323) 줄 모양. 글은 가짜다.
const line = (sessionId: string, extra: Record<string, unknown>) => ({ parentUuid: null, isSidechain: false, ...extra, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), userType: "external", entrypoint: "cli", cwd: "/work/sub", sessionId, version: "2.1.323" });
const prompt = (s: string, text: string) => line(s, { type: "user", message: { role: "user", content: `  <pasted_content id="f1a2">\n${text}\n</pasted_content>` }, origin: { kind: "human" } });
const answer = (s: string, text = "가짜 답", tokens = 1000) => line(s, { type: "assistant", message: { model: "claude-opus-5-5", id: `msg_${crypto.randomUUID()}`, role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0, output_tokens: 5 } } });
const toolUse = (s: string, name: string) => line(s, { type: "assistant", message: { model: "claude-opus-5-5", id: `msg_${crypto.randomUUID()}`, role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name, input: {} }], stop_reason: "tool_use", usage: { input_tokens: 10, cache_read_input_tokens: 990, cache_creation_input_tokens: 0, output_tokens: 5 } } });
const toolResult = (s: string) => line(s, { type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "Workflow started in background" }] }, toolUseResult: { status: "async_launched", taskType: "workflow" } });
const stopSummary = (s: string) => line(s, { type: "system", subtype: "stop_hook_summary", hookCount: 1, hookInfos: [{ command: "fake", durationMs: 20 }], hookErrors: [], preventedContinuation: false, stopReason: "", hasOutput: false, level: "suggestion" });
const turnDuration = (s: string) => line(s, { type: "system", subtype: "turn_duration", durationMs: 300_000, messageCount: 5, pendingWorkflowCount: 1, isMeta: false });
const enqueue = (s: string) => ({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: s, content: "<task-notification>\n<task-id>bfake</task-id>\n</task-notification>" });
const dequeue = (s: string) => ({ type: "queue-operation", operation: "dequeue", timestamp: new Date().toISOString(), sessionId: s });
const notification = (s: string) => line(s, { type: "user", message: { role: "user", content: "<task-notification>\n<task-id>wfake</task-id>\n<status>completed</status>\n</task-notification>" }, origin: { kind: "task-notification", producer: "workflow" } });
const localCommand = (s: string) => line(s, { type: "user", message: { role: "user", content: "<command-name>/effort</command-name>\n<command-message>effort</command-message>" } });
const apiError = (s: string) => line(s, { type: "assistant", message: { model: "<synthetic>", id: `msg_${crypto.randomUUID()}`, role: "assistant", content: [{ type: "text", text: "Please run /login · API Error: 403 Attention Required! | Cloudflare" }], stop_reason: "stop_sequence", usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } }, isApiErrorMessage: true, error: "authentication_failed", apiErrorStatus: 403 });
const boundary = (s: string, trigger: "auto" | "manual", post: number | null = 12_000) => line(s, { type: "system", subtype: "compact_boundary", content: "Conversation compacted", isMeta: false, level: "info", compactMetadata: { trigger, preTokens: 150_000, durationMs: 90_000, ...(post === null ? {} : { postTokens: post }) } });
const summary = (s: string) => line(s, { type: "user", message: { role: "user", content: "This session is being continued from a previous conversation. (가짜 요약)" }, isVisibleInTranscriptOnly: true, isCompactSummary: true });
const idleNotice = (s: string) => line(s, { type: "system", subtype: "informational", content: "Compacted while idle, before the prompt cache expired · turn off with \"idleCompaction\": false in settings.json", isMeta: false, level: "notice" });

describe("화면: 턴을 끝내고 입력을 받을 수 있는 Claude", () => {
  test("빈 입력칸이고 입력칸 위에 일하는 중의 상태 줄이 없으면 그렇다(뒤 작업 기다림 줄은 이름으로 읽는다)", () => {
    expect(claudeQuietScreen(WAIT_SCREEN)).toEqual({ label: "1 dynamic workflow" });
    expect(claudeQuietScreen(IDLE_SCREEN)).toEqual({ label: null });
    expect(claudeQuietScreen(composerScreen("❯ 일\n⏺ 답"))).toEqual({ label: null });
    // 입력칸 아래 뒤 작업 막대(2.1.316 실측 모양).
    expect(claudeQuietScreen(composerScreen("⏺ 답").replace("  ? for shortcuts", "  ◯ 가짜 조사  ▰▰▰▱▱▱"))).toEqual({ label: "가짜 조사" });
  });
  test("일하는 중의 상태 줄이 있거나(할 일 칸이 끼어도), 입력칸에 글이 있거나, 방금 넣은 글의 되풀이가 가장 가까우면 아니다", () => {
    expect(claudeQuietScreen(WORKING_SCREEN)).toBeNull();
    expect(claudeQuietScreen(composerScreen("⏺ 답\n✻ Thinking… (3s · esc to interrupt)\n  ⎿ ☐ 할 일 하나\n     ☐ 할 일 둘"))).toBeNull();
    expect(claudeQuietScreen(composerScreen("⏺ 답\n✶ Compacting conversation… (40s)"))).toBeNull();
    expect(claudeQuietScreen(composerScreen("⏺ 답", "사람이 쓰던 글"))).toBeNull();
    expect(claudeQuietScreen(composerScreen("⏺ 답\n\n❯ 방금 넣은 글"))).toBeNull();
    expect(claudeQuietScreen("승인 창\n 1. Yes\n 2. No\n")).toBeNull();
  });
});

describe("Claude 기록: 전달 뒤의 턴이 닫혔는가", () => {
  const scratch = mkdtempSync(join(tmpdir(), "iamceo-claude-turn-"));
  function log(text: string, sessionId = "sess") {
    const home = mkdtempSync(join(scratch, "home-"));
    const path = join(home, "projects", "-work", `${sessionId}.jsonl`);
    mkdirSync(join(home, "projects", "-work"), { recursive: true });
    writeFileSync(path, text);
    const query = (offset: number, extra: Partial<ClaudeTurnQuery> = {}): ClaudeTurnQuery => ({ home, path, sessionId, baseline: { offset, fileIdentity: null }, markers: [BUNDLE, MARKER], ...extra });
    return { path, query };
  }
  const head = rows(prompt("sess", `앞 일 #iamceo_${"z".repeat(22)}`), answer("sess"), stopSummary("sess"), turnDuration("sess"));
  const at = Buffer.byteLength(head);

  test("기준선 뒤 이 전달의 턴이 stop_hook_summary·turn_duration 으로 닫히면 ended, 열려 있으면 running. 이어 읽는다", () => {
    const { path, query } = log(head + rows(prompt("sess", `일\n${MARKER}\n${BUNDLE}`), toolUse("sess", "Workflow"), toolResult("sess"), answer("sess")));
    const open = readClaudeTurn(query(at));
    expect(open).toMatchObject({ outcome: "running", code: "turn_open" });
    appendFileSync(path, rows(stopSummary("sess")));
    const ended = readClaudeTurn(query(at), open.cursor);
    expect(ended).toMatchObject({ outcome: "ended", code: "turn_end", error: null });
    // turn_duration 만 남은 턴(stop 훅 없이 끝난 턴)도 닫힌 턴이다. 큐에 넣고 뺀 알림·로컬 명령은 턴을 열지 않는다.
    appendFileSync(path, rows(turnDuration("sess"), enqueue("sess"), { ...enqueue("sess"), operation: "remove" }, localCommand("sess")));
    expect(readClaudeTurn(query(at), ended.cursor)).toMatchObject({ outcome: "ended" });
    expect(readClaudeTurn(query(at))).toMatchObject({ outcome: "ended" });
  });
  test("뒤 작업 알림으로 Claude 가 스스로 연 턴은 열려 있는 동안 running, 닫히면 다시 ended", () => {
    const { path, query } = log(head + rows(prompt("sess", MARKER), answer("sess"), stopSummary("sess"), turnDuration("sess")));
    const first = readClaudeTurn(query(at));
    expect(first.outcome).toBe("ended");
    appendFileSync(path, rows(enqueue("sess"), dequeue("sess"), notification("sess")));
    const self = readClaudeTurn(query(at), first.cursor);
    expect(self).toMatchObject({ outcome: "running" });
    appendFileSync(path, rows(answer("sess"), stopSummary("sess"), turnDuration("sess")));
    expect(readClaudeTurn(query(at), self.cursor)).toMatchObject({ outcome: "ended", error: null });
  });
  test("로그인 오류로 끝난 턴은 그 오류와 함께 ended. 다시 로그인해 새 턴이 돌면 running, 정상으로 닫히면 오류가 없다", () => {
    const { path, query } = log(head + rows(prompt("sess", MARKER), apiError("sess"), turnDuration("sess")));
    const failed = readClaudeTurn(query(at));
    expect(failed).toMatchObject({ outcome: "ended", error: { error: "authentication_failed", text: "Please run /login · API Error: 403 Attention Required! | Cloudflare" } });
    appendFileSync(path, rows(answer("sess", "이어서 합니다")));
    const resumed = readClaudeTurn(query(at), failed.cursor);
    expect(resumed).toMatchObject({ outcome: "running", error: null });
    appendFileSync(path, rows(stopSummary("sess"), turnDuration("sess")));
    expect(readClaudeTurn(query(at), resumed.cursor)).toMatchObject({ outcome: "ended", error: null });
  });
  test("표지가 든 받은 글이 아직 없거나, 다른 세션 줄·망가진 줄·덜 쓴 줄이 있으면 정하지 않는다. 사이드체인 줄은 보지 않는다", () => {
    expect(readClaudeTurn(log(head).query(at))).toMatchObject({ outcome: "unknown", code: "marker_missing" });
    // 기준선 앞의 앞 턴 끝만으로는 이 전달이 끝났다고 하지 않는다.
    expect(readClaudeTurn(log(head + rows(prompt("sess", MARKER))).query(at))).toMatchObject({ outcome: "running" });
    expect(readClaudeTurn(log(head + rows(prompt("sess", MARKER), answer("other"), stopSummary("sess"))).query(at))).toMatchObject({ outcome: "unknown", code: "session_conflict" });
    expect(readClaudeTurn(log(head + rows(prompt("sess", MARKER)) + "{broken\n" + rows(stopSummary("sess"))).query(at))).toMatchObject({ outcome: "unknown", code: "corrupt_log" });
    const partial = log(head + rows(prompt("sess", MARKER), answer("sess")) + JSON.stringify(stopSummary("sess")));
    const first = readClaudeTurn(partial.query(at));
    expect(first).toMatchObject({ outcome: "unknown", code: "partial_log" });
    appendFileSync(partial.path, "\n");
    expect(readClaudeTurn(partial.query(at), first.cursor)).toMatchObject({ outcome: "ended" });
    // 서브에이전트(사이드체인)의 응답은 주 대화의 턴을 열지 않는다.
    expect(readClaudeTurn(log(head + rows(prompt("sess", MARKER), answer("sess"), stopSummary("sess"), { ...answer("sess"), isSidechain: true })).query(at))).toMatchObject({ outcome: "ended" });
  });
});

describe("Claude 훅: 전달 뒤의 턴이 닫혔는가(자리 뒤에 덧붙은 줄)", () => {
  const record = (event: HookEventRecord["event"], extra: Partial<HookEventRecord> = {}): HookEventRecord => ({ at: Date.now(), event, sessionId: "sess", ...extra });
  test("표지가 든 UserPromptSubmit 뒤 Stop 이면 ended, StopFailure 면 그 오류. 다른 세션·표지 없는 앞 턴은 세지 않는다", () => {
    const state = { anchored: false, open: false, ended: 0, last: null };
    expect(claudeHookTurn(state, [record("UserPromptSubmit", { markers: [] }), record("Stop")], "sess", [BUNDLE, MARKER])).toMatchObject({ outcome: "unknown" });
    expect(claudeHookTurn(state, [record("UserPromptSubmit", { markers: [BUNDLE, MARKER] }), record("Stop", { sessionId: "other" })], "sess", [BUNDLE, MARKER])).toMatchObject({ outcome: "running" });
    expect(claudeHookTurn(state, [record("Stop")], "sess", [BUNDLE, MARKER])).toMatchObject({ outcome: "ended", error: null });
    expect(claudeHookTurn(state, [record("UserPromptSubmit", { markers: [] })], "sess", [BUNDLE, MARKER])).toMatchObject({ outcome: "running" });
    expect(claudeHookTurn(state, [record("StopFailure", { error: "authentication_failed" })], "sess", [BUNDLE, MARKER])).toMatchObject({ outcome: "ended", error: { error: "authentication_failed", text: null } });
  });
});

describe("기록 꼬리: 쉬는 동안 압축", () => {
  const s = "sess";
  test("턴 끝 뒤에 새 입력 없이 온 자동 압축 경계면 idleCompaction 이고 문맥은 압축 뒤 크기다", () => {
    const tail = parseTranscriptTail(rows(prompt(s, "일"), answer(s, "답", 150_000), stopSummary(s), turnDuration(s), enqueue(s), boundary(s, "auto"), summary(s), idleNotice(s)));
    expect(tail).toMatchObject({ idleCompaction: true, compactedAfterUsage: true, contextTokens: 12_000, finalText: "" });
  });
  test("압축 뒤 크기가 없으면 문맥은 모름(null). 압축 뒤 새 응답이 오면 그 응답의 크기이고 쉬는 동안 압축이 아니다", () => {
    expect(parseTranscriptTail(rows(answer(s, "답", 150_000), turnDuration(s), boundary(s, "auto", null), summary(s)))).toMatchObject({ idleCompaction: true, contextTokens: null });
    const after = parseTranscriptTail(rows(answer(s, "답", 150_000), turnDuration(s), boundary(s, "auto"), summary(s), prompt(s, "새 일"), answer(s, "새 답", 30_000)));
    expect(after).toMatchObject({ contextTokens: 30_000 });
    expect(after.idleCompaction).toBeUndefined();
    expect(after.compactedAfterUsage).toBeUndefined();
  });
  test("서버가 넣은 압축(manual), 턴 도중의 자동 압축, 꼬리가 앞 턴 끝까지 닿지 않는 경우는 쉬는 동안 압축이 아니다", () => {
    expect(parseTranscriptTail(rows(answer(s, "답", 150_000), turnDuration(s), boundary(s, "manual"), summary(s))).idleCompaction).toBeUndefined();
    expect(parseTranscriptTail(rows(prompt(s, "일"), toolUse(s, "Bash"), boundary(s, "auto"), summary(s))).idleCompaction).toBeUndefined();
    expect(parseTranscriptTail(rows(boundary(s, "auto"), summary(s), idleNotice(s))).idleCompaction).toBeUndefined();
  });
});

// ───────── 실제 CoreRunner + 운영 배선의 총괄 + 가짜 core ─────────
const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
    if (name === "ask") return { text: (await orch.registerAsk(member, args as { title: string; detail?: string; options?: DecisionOption[] })).text };
    return { text: "모르는 도구", isError: true };
  },
};
const FAST = { tickMs: 150, healthMs: 40, retryMs: 30, inputBusyRetryMs: 30, writeSettleMs: 40, startGraceMs: 200, blockedNoticeMs: 60 };
/** '일어나지 않는다'를 보는 대기. 관측(20ms)·틱(150ms)이 여러 번 돌 시간이다. */
const QUIET_MS = 500;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close().catch(() => {}); });
async function setup(opts: CoreSetupOptions = {}): Promise<CoreEnv> {
  const t = await coreSetup({ agentTools: TOOLS, ...opts, timings: { ...FAST, ...opts.timings } });
  cleanups.push(() => t.close());
  return t;
}
const lastRun = (t: CoreEnv, id: string) => t.store.lastWrittenExecution(id, t.store.memberRevisions(id).sessionGeneration);
const activityCodes = (t: CoreEnv, id: string) => t.store.listActivity(id, 500).map(a => a.textCode).filter(Boolean);
const nudges = (t: CoreEnv, id: string) => t.store.listDeliveries(t.member(id).projectId).filter(d => d.memberId === id && d.text.includes("보고 보완"));
const transcript = (t: CoreEnv, m: Member) => transcriptPath(m.cwd, m.sessionId!, join(t.home, "claude-home"));

/** 첫 일을 보고까지 끝낸 Claude 팀장(세션 기록이 있다). */
async function worker(t: CoreEnv, first = "첫 일 @fake:post=첫일끝"): Promise<Member> {
  const w = (await t.orch.addMember(t.project.id, { name: "조사", handle: "research", role: "개발" })).member;
  await t.orch.assign(t.project.id, w.handle, { text: first });
  await t.waitFor("첫 일 보고", () => t.texts().some(m => m.title === "첫일끝"));
  await t.idle(w.id);
  return t.member(w.id);
}
/** 일을 하나 넣고 core 가 working 으로 남게 한다(뒤 작업을 띄운 Claude 처럼, @fake:hold). 가짜 CLI 는 받은 글과 답을 기록에 적는다. */
async function atWork(t: CoreEnv, w: Member, text = "가짜 조사를 뒤에서 돌리고 보고하세요"): Promise<{ path: string; runId: string }> {
  const before = lastRun(t, w.id)?.runId;
  await t.orch.assign(t.project.id, w.handle, { text: `${text} @fake:hold` });
  const run = await t.waitFor("일하는 중", () => { const r = lastRun(t, w.id); return r && r.runId !== before && r.phase === "running" && r.lastProgressAt && t.member(w.id).status === "working" ? r : null; });
  return { path: transcript(t, w), runId: run.runId };
}

describe("뒤 작업을 남기고 턴을 끝낸 Claude 팀장", () => {
  test("기록이 턴 끝을 보이면 업무를 성공으로 닫고 쉬는 중으로 보이며, core 가 working 이어도 다음 전달을 넣는다. 스스로 연 턴은 일하는 중이고 끝에 결과 보고 누락을 만들지 않는다", async () => {
    const t = await setup();
    const w = await worker(t);
    const events: RunnerEvent[] = []; t.runner.on(event => { if (event.memberId === w.id) events.push(event); });
    const turnEnds = () => events.filter(e => e.type === "turn_end");
    const endLines = () => activityCodes(t, w.id).filter(code => code === "activity.turn_end").length;
    const linesBefore = endLines();
    const first = await atWork(t, w);
    // Claude 가 워크플로를 뒤로 띄우고 턴을 끝냈다: stop_hook_summary → turn_duration, 화면은 뒤 작업 기다림.
    appendFileSync(first.path, rows(stopSummary(w.sessionId!), turnDuration(w.sessionId!)));
    t.core.setScreen(w.id, WAIT_SCREEN);
    const run = await t.waitFor("업무 닫힘", () => { const r = lastRun(t, w.id); return r?.runId === first.runId && r.phase === "ended" ? r : null; });
    expect(run).toMatchObject({ result: "success", reason: "claude_background_task" });
    await t.waitFor("쉬는 중", () => t.member(w.id).status === "idle" && t.runner.claudeBackground(w.id));
    await t.waitFor("활동 줄", () => activityCodes(t, w.id).includes("activity.claude_background_left"));
    expect(t.core.terminalOf(w.id)!.status?.state).toBe("working");
    expect(t.runner.isBusy(w.id)).toBe(false);
    expect(t.runner.observationState(w.id)?.state).toBe("done");
    expect(t.member(w.id).statusObservation?.error ?? null).toBeNull();
    // 완료 보고 없이 끝난 턴이지만 결과는 뒤 작업 뒤에 온다: 보고 보완을 지금 요구하지 않는다.
    await Bun.sleep(QUIET_MS);
    expect(nudges(t, w.id)).toHaveLength(0);

    // 그동안 온 전달은 곧바로 넣는다(core 에게는 working 이라 if:"working").
    const sendsBefore = t.core.calls.filter(c => c.method === "terminal.send").length;
    const next = (await t.orch.assign(t.project.id, w.handle, { text: "그사이 온 대표 답 @fake:hold" })).delivery.id;
    await t.waitFor("뒤 작업 중에 넣음", () => t.core.turns(w.id).some(turn => turn.prompt.includes("그사이 온 대표 답")));
    const sent = t.core.calls.filter(c => c.method === "terminal.send").slice(sendsBefore);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params).toMatchObject({ if: "working", force: false });
    const second = await t.waitFor("넣은 턴은 일하는 중", () => { const r = lastRun(t, w.id); return r && r.runId !== first.runId && t.member(w.id).status === "working" ? r : null; });
    expect(t.store.requireDelivery(next).status).toBe("delivered");
    // 넣은 턴도 기록으로 닫힌다(뒤 작업은 아직 돈다).
    appendFileSync(first.path, rows(stopSummary(w.sessionId!), turnDuration(w.sessionId!)));
    await t.waitFor("둘째 업무 닫힘", () => lastRun(t, w.id)?.runId === second.runId && lastRun(t, w.id)?.phase === "ended" && t.member(w.id).status === "idle");
    expect(lastRun(t, w.id)).toMatchObject({ result: "success", reason: "claude_background_task" });

    // 뒤 작업이 끝나 Claude 가 알림으로 스스로 턴을 연다: 실행 기록 없이 일하는 중이다.
    appendFileSync(first.path, rows(enqueue(w.sessionId!), dequeue(w.sessionId!), notification(w.sessionId!)));
    await t.waitFor("스스로 연 턴은 일하는 중", () => t.member(w.id).status === "working");
    expect(lastRun(t, w.id)?.runId).toBe(second.runId);
    expect(t.runner.claudeBackground(w.id)).toBe(false);
    // 그 턴에서 결과를 보고하고 끝낸다(남은 뒤 작업이 있어 core 는 여전히 working).
    await t.orch.recordPost(t.member(w.id), { kind: "완료", title: "뒤 작업 결과" });
    appendFileSync(first.path, rows(answer(w.sessionId!, "보고했습니다"), stopSummary(w.sessionId!), turnDuration(w.sessionId!)));
    await t.waitFor("다시 쉬는 중", () => t.member(w.id).status === "idle" && t.runner.claudeBackground(w.id));
    expect(turnEnds()).toHaveLength(2);
    expect(activityCodes(t, w.id).filter(code => code === "activity.claude_background_left")).toHaveLength(1);

    // 뒤 작업이 모두 끝나 core 가 working 을 마친다(turn 이 하나 오른다): 그 끝은 열린 업무 없이 평소처럼 지나가고, 보고가 있으니 보고 보완은 없다.
    t.core.setScreen(w.id, IDLE_SCREEN);
    t.core.release(w.id);
    await t.waitFor("core 끝", () => turnEnds().length === 3 && t.member(w.id).status === "idle" && !t.runner.claudeBackground(w.id));
    await Bun.sleep(QUIET_MS);
    expect(nudges(t, w.id)).toHaveLength(0);
    expect(endLines() - linesBefore).toBe(3);
    expect(t.store.listPendingExecutions().filter(r => r.memberId === w.id)).toHaveLength(0);
  }, 40_000);

  test("결과를 끝내 보고하지 않았으면 보고 보완은 뒤 작업이 끝난 뒤의 턴 끝에서 한 번 요구한다", async () => {
    const t = await setup();
    const w = await worker(t);
    const first = await atWork(t, w);
    appendFileSync(first.path, rows(stopSummary(w.sessionId!), turnDuration(w.sessionId!)));
    t.core.setScreen(w.id, WAIT_SCREEN);
    await t.waitFor("업무 닫힘", () => lastRun(t, w.id)?.phase === "ended" && t.member(w.id).status === "idle");
    await Bun.sleep(QUIET_MS);
    expect(nudges(t, w.id)).toHaveLength(0);
    t.core.setScreen(w.id, IDLE_SCREEN);
    t.core.release(w.id);
    await t.waitFor("보고 보완", () => nudges(t, w.id).length === 1);
    expect(nudges(t, w.id)[0]!.text).toContain(first.runId);
    expect(activityCodes(t, w.id)).toContain("activity.missing_report_requested");
  }, 40_000);

  test("기록에 열린 턴이 있거나 화면에 일하는 중의 상태 줄이 있으면 그대로 일하는 중이다", async () => {
    const t = await setup();
    const w = await worker(t);
    const { path, runId } = await atWork(t, w);
    // 기록: 받은 글과 답만 있고 턴 끝이 없다(정말 일하는 중). 화면은 쉬는 모양이어도 닫지 않는다.
    t.core.setScreen(w.id, WAIT_SCREEN);
    await Bun.sleep(QUIET_MS);
    expect(lastRun(t, w.id)).toMatchObject({ runId, phase: "running" });
    expect(t.member(w.id).status).toBe("working");
    // 기록은 턴 끝인데 화면에 도는 상태 줄이 있다(곧 스스로 연 턴): 닫지 않는다.
    appendFileSync(path, rows(stopSummary(w.sessionId!), turnDuration(w.sessionId!)));
    t.core.setScreen(w.id, WORKING_SCREEN);
    await Bun.sleep(QUIET_MS);
    expect(lastRun(t, w.id)).toMatchObject({ runId, phase: "running" });
    expect(t.member(w.id).status).toBe("working");
    expect(activityCodes(t, w.id)).not.toContain("activity.claude_background_left");
    // 사람이 입력칸에 쓰던 글이 있어도 닫지 않는다.
    t.core.setScreen(w.id, null);
    t.core.setDraft(w.id, "쓰던 글");
    await Bun.sleep(QUIET_MS);
    expect(lastRun(t, w.id)).toMatchObject({ runId, phase: "running" });
    t.core.setDraft(w.id, "");
    await t.waitFor("화면이 비면 닫힘", () => lastRun(t, w.id)?.phase === "ended");
  }, 40_000);

  test("기록을 읽을 수 없으면 봉투를 쓰기 직전의 훅 자리 뒤에 덧붙은 같은 세션의 Stop 으로 닫는다(믿을 수 있는 사건 파일만)", async () => {
    const t = await setup();
    const w = await worker(t);
    const events = hookEventsDir(t.home);
    mkdirSync(events, { recursive: true, mode: 0o700 });
    const file = hookEventsFile(events, w.id);
    const hook = (record: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify({ v: 1, at: Date.now(), sessionId: w.sessionId, ...record })}\n`, { mode: 0o600 });
    // 봉투 전에 있던 줄(앞 턴의 Stop)은 근거가 아니다.
    hook({ event: "Stop" });
    const { path, runId } = await atWork(t, w);
    const dispatch = t.store.getDispatch(runId)!;
    expect(dispatch.baseline.hookMark).toMatchObject({ identity: expect.any(String) });
    // 기록이 망가져(모르는 줄) 기록으로는 정하지 못한다.
    appendFileSync(path, "{broken\n" + rows(stopSummary(w.sessionId!), turnDuration(w.sessionId!)));
    t.core.setScreen(w.id, WAIT_SCREEN);
    await Bun.sleep(QUIET_MS);
    expect(lastRun(t, w.id)?.phase).toBe("running");
    const markers = [dispatch.bundleMarker, ...dispatch.markers.map(m => m.marker)];
    hook({ event: "UserPromptSubmit", markers });
    hook({ event: "Stop", sessionId: "other-session" });
    await Bun.sleep(QUIET_MS);
    expect(lastRun(t, w.id)?.phase).toBe("running");
    chmodSync(file, 0o666); // 다른 사용자도 쓸 수 있는 파일의 기록은 근거로 읽지 않는다.
    hook({ event: "Stop" });
    await Bun.sleep(QUIET_MS);
    expect(lastRun(t, w.id)?.phase).toBe("running");
    chmodSync(file, 0o600);
    const run = await t.waitFor("훅으로 닫힘", () => { const r = lastRun(t, w.id); return r?.phase === "ended" ? r : null; });
    expect(run).toMatchObject({ result: "success", reason: "claude_background_task" });
    await t.waitFor("쉬는 중", () => t.member(w.id).status === "idle");
  }, 40_000);

  test("실행 기록이 running 인 채로 서버가 다시 뜨면 붙는 순간에는 닫지 않고, 다음 관측에서 성공으로 닫는다. 이미 닫은 업무는 되풀이하지 않는다", async () => {
    const t = await setup();
    const w = await worker(t);
    const { path, runId } = await atWork(t, w);
    t.core.setScreen(w.id, WAIT_SCREEN);
    await t.stopServer();
    // 서버가 꺼진 사이(라이브에서는 옛 서버가 이 근거를 읽지 않았다) Claude 가 턴을 끝냈다.
    appendFileSync(path, rows(stopSummary(w.sessionId!), turnDuration(w.sessionId!)));
    const t2 = await t.restart();
    cleanups.push(() => t2.close());
    const ended = await t2.waitFor("업무 닫힘", () => { const r = lastRun(t2, w.id); return r?.phase === "ended" ? r : null; });
    expect(ended).toMatchObject({ runId, result: "success", reason: "claude_background_task" });
    await t2.waitFor("쉬는 중", () => t2.member(w.id).status === "idle" && t2.runner.claudeBackground(w.id));
    const lines = activityCodes(t2, w.id).filter(code => code === "activity.turn_end").length;
    const t3 = await t2.restart();
    cleanups.push(() => t3.close());
    await t3.waitFor("다시 붙어도 쉬는 중", () => t3.member(w.id).status === "idle" && t3.runner.claudeBackground(w.id));
    await Bun.sleep(QUIET_MS);
    expect(activityCodes(t3, w.id).filter(code => code === "activity.turn_end")).toHaveLength(lines);
    expect(activityCodes(t3, w.id).filter(code => code === "activity.claude_background_left")).toHaveLength(1);
  }, 40_000);

  test("뒤 작업이 남은 팀장은 잠재우기·보관·CLI 바꾸기를 그 까닭으로 거절하고, 잠재울 후보로 권하지 않고, 압축하지 않는다. 그래도 잠재우기는 된다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const w = await worker(t);
    const { path } = await atWork(t, w, "가짜 조사 @fake:post=조사시작");
    appendFileSync(path, rows(stopSummary(w.sessionId!), turnDuration(w.sessionId!)));
    t.core.setScreen(w.id, WAIT_SCREEN);
    await t.waitFor("쉬는 중", () => t.member(w.id).status === "idle" && t.runner.claudeBackground(w.id));
    await t.idle(lead.id);
    const sleep = await t.api("POST", `/api/members/${w.id}/sleep`);
    expect(sleep.status).toBe(409);
    expect(await sleep.json()).toEqual({ error: ERROR_CODES.sleep_background_task.ko, code: "member_working", reason: "sleep_background_task" });
    expect(await rejection(t.orch.patchProject(t.project.id, { archived: true }))).toMatchObject({ status: 409, code: "archive_member_working", reason: "archive_background_task",
      message: "조사가 턴은 끝냈지만 Claude가 띄운 뒤 작업이 아직 돌고 있어 보관할 수 없습니다. 그 작업이 끝난 뒤 보관하세요" });
    expect(await rejection(t.orch.patchMemberConfig(w.id, { cli: "codex" }))).toMatchObject({ status: 409, code: "cli_switch_busy", reason: "cli_switch_background_task", message: ERROR_CODES.cli_switch_background_task.ko });
    t.store.patchSettings({ maxAwakeWorkers: 0 });
    (t.orch as unknown as { checkAwakeLimit(projectId: string): void }).checkAwakeLimit(t.project.id);
    expect(t.store.listPending(lead.id).filter(d => d.text.includes("상한")).at(-1)!.text).toContain("지금 잠재울 수 있는 직원이 없습니다");
    // 압축은 그 작업이 끝난 뒤로 미룬다(압축 명령을 넣지 않는다).
    await t.orch.compactMember(w.id, "가짜 초점").catch(() => undefined);
    await Bun.sleep(QUIET_MS);
    expect(t.core.turns(w.id).some(turn => turn.prompt.startsWith("/compact"))).toBe(false);
    await t.orch.sleepMember(w.id, { force: true });
    expect(t.member(w.id).status).toBe("asleep");
  }, 40_000);
});

describe("로그인 오류로 끝난 Claude 턴", () => {
  test("core 가 끝을 알리지 않아도 오류로 닫고 '로그인 필요' 막힘으로 보이며 전달은 보류한다. 다시 로그인해 다음 턴이 돌면 풀린다", async () => {
    const notes: string[] = [];
    // 인증 오류 턴 끝 뒤의 재시도 간격(processing_auth, 기존 동작)은 짧게 둔다.
    const t = await setup({ notifier: (title, body) => notes.push(`${title} ${body}`), timings: { turnErrorRetryMs: 300 } });
    const w = await worker(t);
    const { path, runId } = await atWork(t, w, "가짜 판 정리");
    // 실측: 받은 글 → isApiErrorMessage(authentication_failed) → turn_duration(stop_hook_summary 없음). 화면은 빈 입력칸으로 돌아온다.
    appendFileSync(path, rows(apiError(w.sessionId!), turnDuration(w.sessionId!)));
    t.core.setScreen(w.id, composerScreen("⏺ Please run /login · API Error: 403 Attention Required! | Cloudflare"));
    const run = await t.waitFor("오류로 닫힘", () => { const r = lastRun(t, w.id); return r?.runId === runId && r.phase === "ended" ? r : null; });
    expect(run.result).toBe("error");
    expect(run.reason).toBe("authentication_failed: Please run /login · API Error: 403 Attention Required! | Cloudflare");
    await t.waitFor("로그인 필요 막힘", () => t.member(w.id).blockedCode === "login_required");
    expect(t.member(w.id)).toMatchObject({ status: "blocked", blockedReason: "setup", blockedCode: "login_required",
      statusObservation: { error: { code: "login_required", note: ERROR_CODES.observation_login_required.ko } } });
    // 기존 오류 알림 경로: 팀장 오류 글(대화)과 lastError(오류 푸시).
    expect(t.member(w.id).lastError).toContain("authentication_failed");
    expect(t.texts().some(m => m.textCode === "chat.member_error" && m.body.includes("Please run /login"))).toBe(true);
    expect(activityCodes(t, w.id).filter(code => code === "activity.claude_login_required")).toHaveLength(1);
    // 이 동안의 전달은 실패하지 않고 보류된다. 승인 창이라는 알림은 가지 않는다.
    const held = (await t.orch.assign(t.project.id, w.handle, { text: "로그인 뒤에 할 일" })).delivery.id;
    await t.waitFor("보류", () => t.store.requireDelivery(held).status === "held");
    await Bun.sleep(QUIET_MS);
    expect(t.store.requireDelivery(held).status).toBe("held");
    expect(t.store.requireMember(w.id).status).toBe("blocked");
    expect(t.core.turns(w.id).some(turn => turn.prompt.includes("로그인 뒤에 할 일"))).toBe(false);
    expect(notes.some(note => note.includes("승인"))).toBe(false);
    // 대표가 터미널에서 /login 하면 Claude 가 같은 일을 이어 한다(새 턴). 그 턴이 정상으로 끝나면 막힘이 풀리고 보류한 전달이 나간다.
    appendFileSync(path, rows(answer(w.sessionId!, "다시 로그인됐습니다. 이어서 합니다")));
    await t.waitFor("다시 일하는 중", () => t.member(w.id).status === "working" && !t.member(w.id).lastError);
    appendFileSync(path, rows(stopSummary(w.sessionId!), turnDuration(w.sessionId!)));
    t.core.setScreen(w.id, IDLE_SCREEN);
    t.core.release(w.id);
    await t.waitFor("보류한 전달이 나감", () => t.core.turns(w.id).some(turn => turn.prompt.includes("로그인 뒤에 할 일")));
    expect(t.member(w.id).blockedCode).toBeUndefined();
  }, 40_000);
});

describe("로그인 밖의 API 오류로 끝난 Claude 턴", () => {
  test("core 가 working 이어도 오류로 닫고, 그 오류 결과를 쉬는 중으로 덮지 않는다(core 의 error 보고와 같다)", async () => {
    const t = await setup();
    const w = await worker(t);
    const { path, runId } = await atWork(t, w, "오류가 나는 일");
    const failure = JSON.parse(JSON.stringify(apiError(w.sessionId!)).replace("authentication_failed", "invalid_request").replace("Please run /login · API Error: 403 Attention Required! | Cloudflare", "API Error: 400 가짜 잘못된 요청"));
    appendFileSync(path, rows(failure, turnDuration(w.sessionId!)));
    t.core.setScreen(w.id, WAIT_SCREEN);
    const run = await t.waitFor("오류로 닫힘", () => { const r = lastRun(t, w.id); return r?.runId === runId && r.phase === "ended" ? r : null; });
    expect(run).toMatchObject({ result: "error", reason: "invalid_request: API Error: 400 가짜 잘못된 요청" });
    await t.waitFor("오류", () => t.member(w.id).status === "error");
    await Bun.sleep(QUIET_MS);
    expect(t.member(w.id)).toMatchObject({ status: "error", lastError: "invalid_request: API Error: 400 가짜 잘못된 요청" });
    expect(activityCodes(t, w.id)).not.toContain("activity.claude_background_left");
    expect(activityCodes(t, w.id)).not.toContain("activity.claude_login_required");
  }, 40_000);
});

describe("쉬는 동안의 자동 압축", () => {
  test("실행 기록이 없으면 턴 끝으로 세지 않고, 문맥은 압축 뒤 값(정확하지 않은 값)으로 둬 다음 전달 앞에서 다시 압축하지 않는다", async () => {
    const t = await setup();
    // 첫 일의 문맥은 200,000 칸에 150,000(75%). 압축 기준(70%)을 넘는다.
    const w = await worker(t, "첫 일 @fake:post=첫일끝 @fake:usage=150000");
    const events: RunnerEvent[] = []; t.runner.on(event => { if (event.memberId === w.id) events.push(event); });
    const path = transcript(t, w);
    const endLines = () => activityCodes(t, w.id).filter(code => code === "activity.turn_end").length;
    const before = endLines();
    // 실측: 앞 턴이 끝난(turn_duration) 뒤 CLI 가 1~2분 압축한다. 그동안 core 는 working, 끝나면 turn 이 하나 오른다.
    appendFileSync(path, rows(turnDuration(w.sessionId!)));
    t.core.setStatus(w.id, { state: "working" });
    await t.waitFor("압축 중 일하는 중", () => t.member(w.id).status === "working");
    appendFileSync(path, rows(boundary(w.sessionId!, "auto"), summary(w.sessionId!), idleNotice(w.sessionId!)));
    const terminal = t.core.terminalOf(w.id)!;
    terminal.turn = (terminal.turn ?? 0) + 1;
    terminal.status = { state: "done" };
    await t.waitFor("쉬는 중", () => t.member(w.id).status === "idle");
    await t.waitFor("압축 줄", () => activityCodes(t, w.id).includes("activity.claude_idle_compacted"));
    await t.waitFor("압축 뒤 문맥", () => t.store.getContextState(w.id)?.measurement?.tokens === 12_000);
    expect(t.store.getContextState(w.id)!.measurement).toMatchObject({ tokens: 12_000, quality: "estimated", fresh: false });
    expect(t.member(w.id).contextPct).toBe(6);
    expect(events.filter(e => e.type === "turn_end")).toHaveLength(0);
    expect(endLines()).toBe(before);
    // 다음 전달은 곧바로 일로 들어간다(압축 전 75% 를 정확한 값으로 믿고 /compact 를 먼저 넣지 않는다).
    await t.orch.assign(t.project.id, w.handle, { text: "다음 일" });
    await t.waitFor("다음 턴", () => t.core.turns(w.id).length >= 2);
    expect(t.core.turns(w.id).at(-1)!.prompt.startsWith("/compact")).toBe(false);
  }, 40_000);

  test("열린 업무가 있으면 그 끝은 평소의 턴 끝이고, 문맥은 압축 뒤 크기로 잰다", async () => {
    const t = await setup();
    const w = await worker(t);
    const { path, runId } = await atWork(t, w, "압축이 끼는 일");
    // 그 업무의 턴이 끝나고 core 가 끝을 알리기 전에 CLI 가 스스로 압축했다(그동안 화면은 압축 중의 상태 줄).
    t.core.setScreen(w.id, WORKING_SCREEN);
    appendFileSync(path, rows(stopSummary(w.sessionId!), turnDuration(w.sessionId!), boundary(w.sessionId!, "auto", 9_000), summary(w.sessionId!), idleNotice(w.sessionId!)));
    await Bun.sleep(QUIET_MS);
    expect(lastRun(t, w.id)?.phase).toBe("running");
    // core 가 끝을 알린다(평소의 턴 끝 경로).
    t.core.release(w.id);
    const run = await t.waitFor("업무 닫힘", () => { const r = lastRun(t, w.id); return r?.runId === runId && r.phase === "ended" ? r : null; });
    expect(run.result).toBe("success");
    await t.waitFor("압축 뒤 문맥", () => t.store.getContextState(w.id)?.measurement?.tokens === 9_000);
    expect(t.store.getContextState(w.id)!.measurement).toMatchObject({ quality: "estimated", fresh: false });
    expect(activityCodes(t, w.id)).not.toContain("activity.claude_idle_compacted");
  }, 40_000);
});
