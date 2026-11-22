// 0.2.8 AI 계정 로그인 뒤 떠 있는 팀장에게 새 계정을 적용한다(Orchestrator.cliLoggedIn).
// - 다른 계정이면 그 CLI 의 계정 세대가 오른다: 쉬는 팀장은 곧바로, 일하는 팀장은 턴이 끝난 뒤 같은 대화를 새 계정으로 다시 연다(설정 적용과 같은 길).
// - 사용 한도로 멈춘 팀장(다른 계정일 때)과 로그인 오류로 멈춘 팀장(같은 계정이어도)은 지금 다시 열고, 멈춘 일의 이어가기 글을 한 번 넣는다.
// 실제 CoreRunner 틀(tests/fixtures/core-harness.ts): 가짜 core + 실제 CoreRunner + 실제 총괄. 진짜 claude·codex 를 띄우지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOGIN_RESUME_TEXT, USAGE_ACCOUNT_RESUME_TEXT } from "../server/api-outage.ts";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import type { DecisionOption, Member } from "../shared/types.ts";
import { composerScreen, coreSetup, type CoreEnv, type CoreSetupOptions } from "./fixtures/core-harness.ts";

const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
    if (name === "ask") return { text: (await orch.registerAsk(member, args as { title: string; detail?: string; options?: DecisionOption[] })).text };
    return { text: "모르는 도구", isError: true };
  },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close().catch(() => {}); });

const LIMIT = "You've hit your weekly limit";
const FAST = { tickMs: 150, healthMs: 40, retryMs: 30, inputBusyRetryMs: 30, writeSettleMs: 40, startGraceMs: 200, blockedNoticeMs: 60 };
const QUIET_MS = 700;
const ACCOUNT_LEAD = "대표가 다른 계정으로 로그인해 같은 대화를";
const LOGIN_LEAD = "로그인(계정) 오류로 하던 일이 중간에 멈췄습니다";

async function setup(opts: CoreSetupOptions = {}): Promise<CoreEnv> {
  const t = await coreSetup({
    agentTools: TOOLS, ...opts, timings: { ...FAST, ...opts.timings },
    onTurn: ({ prompt }) => { if (prompt.includes("한도일")) throw Object.assign(new Error(LIMIT), { fake: "error" }); },
    script: [
      { when: ACCOUNT_LEAD, tools: [{ name: "post", args: { kind: "완료", title: "새계정으로끝" } }] },
      { when: LOGIN_LEAD, tools: [{ name: "post", args: { kind: "완료", title: "다시로그인끝" } }] },
    ],
  });
  cleanups.push(() => t.close());
  return t;
}
async function worker(t: CoreEnv, name: string, handle: string): Promise<Member> {
  const w = (await t.orch.addMember(t.project.id, { name, handle, role: name })).member;
  await t.orch.assign(t.project.id, w.handle, { text: `준비 @fake:post=${handle}준비` });
  await t.waitFor("첫 보고", () => t.texts().some((m) => m.title === `${handle}준비`));
  await t.idle(w.id);
  return t.member(w.id);
}
const activityCodes = (t: CoreEnv, id: string) => t.store.listActivity(id, 500).map(a => a.textCode).filter(Boolean);
const epochs = (t: CoreEnv) => t.store.loadApiRecovery<Record<string, { epoch: number; identity: string | null }>>("cli_accounts");

describe("다른 계정으로 로그인한 뒤", () => {
  test("사용 한도로 멈춘 팀장: 같은 세션을 이어 열고(--resume) 이어가기 글을 한 번, 기다리던 지시는 그 뒤. 한도 카드에서 빠진다", async () => {
    const t = await setup();
    const w = await worker(t, "발표 준비", "deck");
    const session = w.sessionId!;
    await t.orch.assign(t.project.id, w.handle, { text: "발표 자료 만들기 한도일" });
    await t.waitFor("한도 보류", () => t.orch.apiRecovery.usageLimited(w.id) && t.member(w.id).status === "error");
    const waiting = (await t.orch.assign(t.project.id, w.handle, { text: "새 일 @fake:post=새일끝" })).delivery.id;
    expect(t.store.requireDelivery(waiting)).toMatchObject({ status: "held", holdReason: "usage_limit" });
    const runsBefore = t.runs(w.id).length;

    const result = await t.orch.cliLoggedIn("claude", "new-account", "old-account");
    expect(result).toEqual({ changed: true, reopenedNow: 1, atNextTurn: 0 });
    await t.orch.accountReopening;
    expect(epochs(t)?.claude).toEqual({ epoch: 1, identity: "new-account" });

    expect(t.runs(w.id)).toHaveLength(runsBefore + 1);
    const run = t.runs(w.id).at(-1)!;
    expect(run.resumeFlag).toBe(session);
    const resumed = await t.waitFor("이어가기 턴", () => t.turns(w.id).find(x => x.prompt.includes(ACCOUNT_LEAD) && x.outcome === "done"));
    expect(resumed.prompt).toContain(USAGE_ACCOUNT_RESUME_TEXT);
    expect(resumed.prompt).not.toContain("새 일");
    expect(resumed.prompt).not.toContain("발표 자료 만들기");
    await t.waitFor("기다리던 지시 전달", () => t.store.requireDelivery(waiting).status === "delivered");
    await t.idle(w.id);
    expect(t.orch.apiRecovery.usageLimited(w.id)).toBe(false);
    expect(activityCodes(t, w.id)).toContain("activity.usage_reopen_account_continue");
    expect(t.texts().some(m => m.textCode === "chat.usage_account_resumed")).toBe(true);
    // 이미 새 계정 세대로 떠 있다: 다시 열지 않는다. 설정 변경 인계 글도 붙이지 않는다.
    await Bun.sleep(QUIET_MS);
    expect(t.runs(w.id)).toHaveLength(runsBefore + 1);
    expect(t.turns(w.id).filter(x => x.prompt.includes(ACCOUNT_LEAD))).toHaveLength(1);
    expect(t.store.listDeliveries(t.project.id).filter(d => d.memberId === w.id && /설정 변경|같은 세션을 새 설정으로/.test(d.text))).toEqual([]);
  }, 60_000);

  test("쉬는 팀장은 곧바로, 일하는 팀장은 턴이 끝난 뒤 같은 대화를 새 계정으로 다시 연다. 같은 계정을 다시 로그인하면 다시 열지 않는다", async () => {
    const t = await setup();
    const idle = await worker(t, "문서 정리", "docs");
    const busy = await worker(t, "화면 개발", "ui");
    const idleRuns = t.runs(idle.id).length, busyRuns = t.runs(busy.id).length;
    await t.orch.assign(t.project.id, busy.handle, { text: "긴 일 @fake:hold" });
    await t.waitFor("일하는 중", () => t.core.held(busy.id));

    const result = await t.orch.cliLoggedIn("claude", "b", "a");
    expect(result.changed).toBe(true);
    expect(result.reopenedNow).toBe(0);
    expect(result.atNextTurn).toBeGreaterThanOrEqual(2);
    await t.orch.accountReopening;
    // 쉬는 팀장: 같은 세션을 이어 열고, 인계 글 없이 활동 한 줄.
    await t.waitFor("쉬는 팀장 다시 열림", () => t.runs(idle.id).length === idleRuns + 1);
    expect(t.runs(idle.id).at(-1)!.resumeFlag).toBe(idle.sessionId);
    await t.waitFor("활동 줄", () => activityCodes(t, idle.id).includes("activity.account_reopen"));
    expect(t.store.getAppliedConfig(idle.id)?.account).toBe(1);
    // 일하는 팀장은 그 턴을 끊지 않는다.
    await Bun.sleep(QUIET_MS);
    expect(t.runs(busy.id)).toHaveLength(busyRuns);
    t.core.release(busy.id);
    await t.waitFor("턴이 끝난 뒤 다시 열림", () => t.runs(busy.id).length === busyRuns + 1, 20_000);
    expect(t.runs(busy.id).at(-1)!.resumeFlag).toBe(busy.sessionId);
    expect(t.store.listDeliveries(t.project.id).filter(d => [idle.id, busy.id].includes(d.memberId) && /설정 변경|같은 세션을 새 설정으로/.test(d.text))).toEqual([]);
    await t.idle(idle.id); await t.idle(busy.id);

    // 새로 연 세션은 지금 세대로 뜬다. 같은 계정을 다시 로그인하면 세대가 오르지 않는다.
    const again = await t.orch.cliLoggedIn("claude", "b", "b");
    expect(again).toEqual({ changed: false, reopenedNow: 0, atNextTurn: 0 });
    await t.orch.accountReopening;
    await Bun.sleep(QUIET_MS);
    expect(t.runs(idle.id)).toHaveLength(idleRuns + 1);
    expect(epochs(t)?.claude.epoch).toBe(1);
    // 다른 CLI(Codex)의 로그인은 Claude 팀장을 다시 열지 않는다.
    expect((await t.orch.cliLoggedIn("codex", "x", "y")).changed).toBe(true);
    await t.orch.accountReopening;
    await Bun.sleep(QUIET_MS);
    expect(t.runs(idle.id)).toHaveLength(idleRuns + 1);
  }, 60_000);

  test("견주는 기준은 마지막으로 적용한 계정이 먼저다. 처음이면 로그인 직전 계정, 둘 다 모르면 세대를 올리지 않는다", async () => {
    const t = await setup();
    expect((await t.orch.cliLoggedIn("claude", "first", null)).changed).toBeNull();
    expect(epochs(t)?.claude).toEqual({ epoch: 0, identity: "first" });
    expect((await t.orch.cliLoggedIn("claude", "second", null)).changed).toBe(true);
    expect(epochs(t)?.claude).toEqual({ epoch: 1, identity: "second" });
    // 앞 로그인(third)의 적용이 빠져 세대를 못 올렸다고 해도: 직전 계정(third)이 아니라 마지막 적용(second)과 견주므로 third 로 다시 로그인하면 바뀐 것이다.
    expect((await t.orch.cliLoggedIn("claude", "third", "third")).changed).toBe(true);
    expect(epochs(t)?.claude).toEqual({ epoch: 2, identity: "third" });
    expect((await t.orch.cliLoggedIn("claude", "third", "third")).changed).toBe(false);
  }, 30_000);

  test("잠든 팀장은 사용 한도로 멈췄어도 깨우지 않는다(한도 카드에 남는다)", async () => {
    const t = await setup();
    const w = await worker(t, "발표 준비", "deck");
    await t.orch.assign(t.project.id, w.handle, { text: "발표 자료 만들기 한도일" });
    await t.waitFor("한도 보류", () => t.orch.apiRecovery.usageLimited(w.id) && t.member(w.id).status === "error");
    await t.orch.sleepMember(w.id, { force: true });
    await t.waitFor("잠듦", () => t.member(w.id).status === "asleep");
    const runsBefore = t.runs(w.id).length;
    const result = await t.orch.cliLoggedIn("claude", "new-account", "old-account");
    expect(result.reopenedNow).toBe(0);
    await t.orch.accountReopening;
    await Bun.sleep(QUIET_MS);
    expect(t.runs(w.id)).toHaveLength(runsBefore);
    expect(t.member(w.id).status).toBe("asleep");
  }, 60_000);
});

// ---- 로그인 오류로 멈춘 Claude 팀장(claude-background.test.ts 의 실측 모양) ----
const rows = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const line = (sessionId: string, extra: Record<string, unknown>) => ({ parentUuid: null, isSidechain: false, ...extra, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), userType: "external", entrypoint: "cli", cwd: "/work/sub", sessionId, version: "2.1.323" });
const turnDuration = (s: string) => line(s, { type: "system", subtype: "turn_duration", durationMs: 300_000, messageCount: 5, isMeta: false });
const apiError = (s: string) => line(s, { type: "assistant", message: { model: "<synthetic>", id: `msg_${crypto.randomUUID()}`, role: "assistant", content: [{ type: "text", text: "Please run /login · API Error: 403 Attention Required! | Cloudflare" }], stop_reason: "stop_sequence", usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } }, isApiErrorMessage: true, error: "authentication_failed", apiErrorStatus: 403 });

describe("다시 로그인한 뒤 로그인 오류로 멈춘 팀장", () => {
  test("같은 계정이어도 지금 같은 세션을 이어 열고, 멈춘 일의 이어가기 글을 한 번 넣는다. 보류된 전달은 그 뒤에 나가고 '로그인 필요'가 풀린다", async () => {
    const t = await setup({ timings: { turnErrorRetryMs: 300 } });
    const w = await worker(t, "판 정리", "board");
    const before = t.store.lastWrittenExecution(w.id, t.store.memberRevisions(w.id).sessionGeneration)?.runId;
    await t.orch.assign(t.project.id, w.handle, { text: "가짜 판 정리 @fake:hold" });
    const run = await t.waitFor("일하는 중", () => { const r = t.store.lastWrittenExecution(w.id, t.store.memberRevisions(w.id).sessionGeneration); return r && r.runId !== before && r.phase === "running" && t.member(w.id).status === "working" ? r : null; });
    const path = transcriptPath(w.cwd, w.sessionId!, join(t.home, "claude-home"));
    appendFileSync(path, rows(apiError(w.sessionId!), turnDuration(w.sessionId!)));
    t.core.setScreen(w.id, composerScreen("⏺ Please run /login · API Error: 403 Attention Required! | Cloudflare"));
    await t.waitFor("로그인 필요 막힘", () => t.member(w.id).blockedCode === "login_required");
    expect(t.store.getExecutionJournal(run.runId)).toMatchObject({ phase: "ended", result: "error" });
    const held = (await t.orch.assign(t.project.id, w.handle, { text: "로그인 뒤에 할 일 @fake:post=뒤일끝" })).delivery.id;
    await t.waitFor("보류", () => t.store.requireDelivery(held).status === "held");
    const runsBefore = t.runs(w.id).length;

    const result = await t.orch.cliLoggedIn("claude", "same", "same");
    expect(result).toEqual({ changed: false, reopenedNow: 1, atNextTurn: 0 });
    await t.orch.accountReopening;
    expect(t.runs(w.id)).toHaveLength(runsBefore + 1);
    expect(t.runs(w.id).at(-1)!.resumeFlag).toBe(w.sessionId);
    const resumed = await t.waitFor("이어가기 턴", () => t.turns(w.id).find(x => x.prompt.includes(LOGIN_LEAD) && x.outcome === "done"));
    expect(resumed.prompt).toContain(LOGIN_RESUME_TEXT);
    expect(resumed.prompt).not.toContain("로그인 뒤에 할 일");
    expect(resumed.prompt).not.toContain("가짜 판 정리");
    await t.waitFor("보류한 전달이 나감", () => t.store.requireDelivery(held).status === "delivered");
    await t.idle(w.id);
    expect(t.member(w.id).blockedCode).toBeUndefined();
    expect(activityCodes(t, w.id)).toContain("activity.login_reopen_continue");
    expect(t.texts().some(m => m.textCode === "chat.login_resumed")).toBe(true);
    // 계정 세대는 그대로다(같은 계정). 이어가기 글은 한 번만.
    await Bun.sleep(QUIET_MS);
    expect(t.turns(w.id).filter(x => x.prompt.includes(LOGIN_LEAD))).toHaveLength(1);
    expect(epochs(t)?.claude.epoch).toBe(0);
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
  }, 60_000);
});

describe("다시 로그인한 뒤 인증 오류로 멈춘 Gemini 팀장(0.2.10)", () => {
  async function geminiWorker(t: CoreEnv, name: string, handle: string): Promise<Member> {
    const w = (await t.orch.addMember(t.project.id, { name, handle, role: name, cli: "gemini" })).member;
    await t.orch.assign(t.project.id, w.handle, { text: `준비 @fake:post=${handle}준비` });
    await t.waitFor("첫 보고", () => t.texts().some((m) => m.title === `${handle}준비`));
    await t.waitFor("대화 id", () => t.member(w.id).sessionId);
    await t.idle(w.id);
    return t.member(w.id);
  }
  test("같은 계정으로 다시 로그인해도 지금 같은 대화(--conversation)로 다시 열고, 멈춘 일의 이어가기 글(LOGIN_RESUME_TEXT)을 한 번 넣는다. Claude 막힘 코드(login_required)는 붙이지 않는다", async () => {
    // 인증 오류 턴 끝은 그 팀장의 전달에 재시도 대기(processing_auth, 기본 60초)를 건다(Claude 와 같다). 이어가기 글도 그 뒤에 나간다: 시험에서는 짧게.
    const t = await setup({ timings: { turnErrorRetryMs: 300 } });
    const g = await geminiWorker(t, "자료 조사", "research");
    // 앞서 같은 계정으로 로그인했다(지문 g-account). 처음 로그인은 앞 계정을 몰라 세대를 올려 쉬는 팀장을 다시 연다: 그것이 끝나기를 기다린다.
    const runs0 = t.runs(g.id).length;
    await t.orch.cliLoggedIn("gemini", "g-account", null);
    await t.orch.accountReopening;
    await t.waitFor("첫 로그인 적용", () => t.runs(g.id).length === runs0 + 1);
    await t.idle(g.id);
    const before = t.store.lastWrittenExecution(g.id, t.store.memberRevisions(g.id).sessionGeneration)?.runId;
    await t.orch.assign(t.project.id, g.handle, { text: "가짜 자료 조사 @fake:error=UNAUTHENTICATED" });
    const run = await t.waitFor("인증 오류로 끝남", () => {
      const r = t.store.lastWrittenExecution(g.id, t.store.memberRevisions(g.id).sessionGeneration);
      return r && r.runId !== before && r.phase === "ended" && r.result === "error" && t.member(g.id).status === "error" ? r : null;
    });
    expect(t.member(g.id).blockedCode).toBeUndefined();
    const runsBefore = t.runs(g.id).length;

    const result = await t.orch.cliLoggedIn("gemini", "g-account", null);
    expect(result).toEqual({ changed: false, reopenedNow: 1, atNextTurn: 0, setupBlocked: 0 });
    await t.orch.accountReopening;
    await t.waitFor("다시 열림", () => t.runs(g.id).length === runsBefore + 1);
    expect(t.runs(g.id).at(-1)).toMatchObject({ cli: "gemini", conversationFlag: g.sessionId });
    const resumed = await t.waitFor("이어가기 턴", () => t.turns(g.id).find(x => x.prompt.includes(LOGIN_LEAD) && x.outcome === "done"));
    expect(resumed.prompt).toContain(LOGIN_RESUME_TEXT);
    expect(resumed.prompt).not.toContain("가짜 자료 조사");
    await t.idle(g.id);
    expect(t.member(g.id).status).toBe("idle");
    expect(activityCodes(t, g.id)).toContain("activity.login_reopen_continue");
    expect(t.texts().some(m => m.textCode === "chat.login_resumed")).toBe(true);
    expect(t.store.getExecutionJournal(run.runId)?.interruptionNotifiedAt).toBeTruthy();
    // 같은 계정: 세대는 그대로(첫 로그인의 1). 이어가기 글은 한 번만이고, 다시 로그인해도 또 열지 않는다.
    expect(epochs(t)?.gemini).toEqual({ epoch: 1, identity: "g-account" });
    expect(await t.orch.cliLoggedIn("gemini", "g-account", null)).toEqual({ changed: false, reopenedNow: 0, atNextTurn: 0, setupBlocked: 0 });
    await t.orch.accountReopening;
    await Bun.sleep(QUIET_MS);
    expect(t.turns(g.id).filter(x => x.prompt.includes(LOGIN_LEAD))).toHaveLength(1);
    expect(t.runs(g.id)).toHaveLength(runsBefore + 1);
  }, 60_000);

  test("인증이 아닌 오류로 멈춘 Gemini 팀장·쉬는 Gemini 팀장은 같은 계정 로그인으로 다시 열지 않는다", async () => {
    const t = await setup({ timings: { turnErrorRetryMs: 600_000 } });
    const g = await geminiWorker(t, "자료 조사", "research");
    const first = t.runs(g.id).length;
    await t.orch.cliLoggedIn("gemini", "g-account", null);
    await t.orch.accountReopening;
    await t.waitFor("첫 로그인 적용", () => t.runs(g.id).length === first + 1);
    await t.idle(g.id);
    const runs0 = t.runs(g.id).length;
    expect((await t.orch.cliLoggedIn("gemini", "g-account", null)).reopenedNow).toBe(0);
    await t.orch.assign(t.project.id, g.handle, { text: "가짜 자료 조사 @fake:error=CLI%20reported%20an%20error" });
    await t.waitFor("일반 오류", () => t.member(g.id).status === "error");
    expect((await t.orch.cliLoggedIn("gemini", "g-account", null)).reopenedNow).toBe(0);
    await t.orch.accountReopening;
    await Bun.sleep(QUIET_MS);
    expect(t.runs(g.id).length).toBe(runs0);
  }, 60_000);
});
