// 사용 한도로 멈춘 팀장의 모델을 바꿔 같은 세션을 이어 연다(2026-11-13 라이브).
// Fable 을 쓰던 팀장 셋이 한도에 걸린 뒤 대표가 "모델 오푸스로 바꿔서 이어서 해"라고 했다. 총괄에게는 있는 팀장의 모델을 바꾸는 도구가 없었고,
// 앱의 설정 변경도, 재우기도 "실행 중인 일이나 미해결 입력이 있어 닫지 않았습니다"(409)로 거절됐다. 총괄은 오푸스 팀장을 새로 띄웠고 원래 셋은 오류 표시를 단 채 남았다.
// 실제 CoreRunner 틀(tests/fixtures/core-harness.ts)로 본다: 가짜 core + 실제 CoreRunner + 실제 총괄 + 실제 HTTP 서버.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentTool, listAgentTools } from "../server/agent-tools.ts";
import { USAGE_RESUME_TEXT, USAGE_WAIT_NOTE, usageModelResumeText } from "../server/api-outage.ts";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import type { DecisionOption, Member } from "../shared/types.ts";
import { coreSetup, rejection, type CoreEnv, type CoreSetupOptions, type FakeRun } from "./fixtures/core-harness.ts";

const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
    if (name === "ask") return { text: (await orch.registerAsk(member, args as { title: string; detail?: string; options?: DecisionOption[] })).text };
    return { text: "모르는 도구", isError: true };
  },
};

const cleanups: (() => Promise<void>)[] = [];
// 시험마다 닫는다(regress.test.ts 와 같다). 파일 끝까지 두면 앞 시험들의 틱·관측·서버가 쌓여, 느린 러너(taskpolicy -c background)에서
// 뒤 시험이 제한 시간(40초)을 넘기거나 상태 판정이 밀렸다(usage-limit-model 한 파일이 375초).
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close().catch(() => {}); });

/** 라이브에서 CLI 가 턴을 끝낸 글 그대로. */
const LIMIT = "You're out of usage credits. Run /usage-credits to keep using Fable 5.2 or /model to switch models.";
/** 턴 도중에 뜨는 사용 한도 메뉴. 선택지에 유료 크레딧 구매가 있다: Esc 말고는 아무 키도 보내면 안 된다. 초기화 시각은 없다(시험 중에 자동 이어가기가 돌지 않게). */
const MENU = [
  "You've hit your Fable limit",
  "What do you want to do?",
  "❯ 1. Add funds to continue with usage credits",
  "  2. Stop and wait for limit to reset",
  "  3. Switch to usage credits",
  "Enter to confirm · Esc to cancel",
].join("\n");
const FABLE = "claude-fable-5-2";
/** 계정 전체의 한도(모델 한정이 아니다). */
const WEEKLY = "You've hit your weekly limit";
/** Sonnet 만의 한도(모델 한정). */
const SONNET_LIMIT = "You've hit your Sonnet limit";
/** 새 모델로 이어 연 뒤 첫 글. 모델 목록의 표시 이름이 들어간다. */
const RESUME = usageModelResumeText("Opus");
const RESUME_LEAD = "사용 한도로 하던 일이 중간에 멈췄습니다";
/** 틱·점검·재시도를 시험 시간 안에 여러 번 돌게 줄인 값(restart-audit 와 같다). */
const FAST = { tickMs: 150, healthMs: 40, retryMs: 30, inputBusyRetryMs: 30, writeSettleMs: 40, startGraceMs: 200 };
/** '일어나지 않는다'를 보는 대기. 틱·점검·전달 확인이 여러 번 돌 시간이다. */
const QUIET_MS = 700;

async function setup(opts: CoreSetupOptions = {}): Promise<CoreEnv> {
  // 모델 목록은 CLI 설정 폴더의 .claude.json 에서 읽는다. 틀이 그 폴더를 <home>/claude-home 으로 잡는다.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-usage-model-")));
  mkdirSync(join(home, "claude-home"));
  writeFileSync(join(home, "claude-home", ".claude.json"), JSON.stringify({ additionalModelOptionsCache: [{ value: FABLE, label: "Fable 5.2" }] }));
  const t = await coreSetup({
    home, agentTools: TOOLS, ...opts, timings: { ...FAST, ...opts.timings },
    // '한도일'이 든 턴은 라이브의 한도 오류로 끝난다. 이어가기 글로 시작한 턴은 보고하고 끝낸다(보고 보완 턴이 섞이지 않게).
    onTurn: ({ prompt }) => {
      if (prompt.includes("한도일")) throw Object.assign(new Error(LIMIT), { fake: "error" });
      if (prompt.includes("주간한도")) throw Object.assign(new Error(WEEKLY), { fake: "error" });
      if (prompt.includes("소네트한도")) throw Object.assign(new Error(SONNET_LIMIT), { fake: "error" });
    },
    script: [{ when: RESUME_LEAD, tools: [{ name: "post", args: { kind: "완료", title: "이어서끝" } }] }],
  });
  cleanups.push(() => t.close());
  return t;
}
async function worker(t: CoreEnv, name: string, handle: string): Promise<Member> {
  const w = (await t.orch.addMember(t.project.id, { name, handle, role: name, modelOverride: FABLE })).member;
  // 한 턴을 돌려 세션 기록을 만든다(기록이 있어야 같은 세션을 --resume 한다).
  await t.orch.assign(t.project.id, w.handle, { text: `준비 @fake:post=${handle}준비` });
  await t.waitFor("첫 보고", () => t.texts().some((m) => m.title === `${handle}준비`));
  await t.idle(w.id);
  return t.member(w.id);
}
/** 열린 사용 한도 카드(없으면 마지막 카드). 보류된 팀장이 모두 빠지면 카드가 닫히고, 다시 걸리면 새 카드가 열린다. */
const card = (t: CoreEnv) => {
  const cards = t.store.listDecisions(t.project.id).filter((d) => d.kind === "usage_limit");
  return cards.find((d) => d.status === "open") ?? cards.at(-1) ?? null;
};
/**
 * 앱의 '적용'이 보내는 요청 그대로(cli 를 함께 보낸다). 그 팀장의 전달 펌프가 막 도는 순간이면 409 '세션을 처리하는 중'이다(다시 하면 되는 알려진 거절,
 * unified.test.ts 참고). 그것만 잠깐 뒤 다시 보낸다. 다른 거절은 그대로 돌려준다.
 */
async function changeModel(t: CoreEnv, id: string, model: string): Promise<Response> {
  for (let i = 0; ; i++) {
    const res = await t.api("PATCH", `/api/members/${id}`, { cli: "claude", modelOverride: model, effortOverride: null });
    if (res.status !== 409 || i >= 40 || !(await res.clone().text()).includes("처리하는 중")) return res;
    await Bun.sleep(50);
  }
}
/** 일하던 도중 라이브와 같은 글(LIMIT)로 한도에 걸린다. 메뉴는 뜨지 않는다. */
async function limitByError(t: CoreEnv, w: Member): Promise<string> {
  const d = (await t.orch.assign(t.project.id, w.handle, { text: "발표 자료 만들기 한도일" })).delivery.id;
  await t.waitFor("한도 보류", () => t.orch.apiRecovery.usageLimited(w.id) && t.member(w.id).status === "error");
  return d;
}
/** 일하던 도중 한도 메뉴가 뜬다. Esc 를 누르면 메뉴가 닫히고 그 턴은 한도 오류로 끝난다(OSC error). */
async function limitByMenu(t: CoreEnv, w: Member): Promise<void> {
  t.core.onKeys((terminal, pressed) => {
    if (!pressed.includes("esc")) return;
    const id = terminal.labels["iamceo.member"]!;
    t.core.setScreen(id, null);
    if (!t.core.release(id, { error: LIMIT })) t.core.setStatus(id, { state: "error", msg: LIMIT });
  });
  await t.orch.assign(t.project.id, w.handle, { text: "랜딩 문구 고치기 @fake:hold" });
  await t.waitFor("일하는 중", () => t.core.held(w.id));
  t.core.setScreen(w.id, MENU);
  t.core.setStatus(w.id, { state: "blocked" });
  await t.waitFor("한도 메뉴 보류", () => t.orch.apiRecovery.usageLimited(w.id) && t.member(w.id).status === "blocked");
}
/** 닫기도 그 팀장의 전달 펌프가 막 도는 순간이면 409 '세션을 처리하는 중'이다. 그것만 잠깐 뒤 다시 한다. */
async function closeWhenSettled(t: CoreEnv, id: string): Promise<void> {
  for (let i = 0; ; i++) {
    try { await t.orch.closeMember(id); return; }
    catch (e) { if (i >= 40 || !(e as Error).message.includes("처리하는 중")) throw e; await Bun.sleep(50); }
  }
}
const flag = (run: FakeRun, name: string) => { const at = run.argv.indexOf(name); return at >= 0 ? run.argv[at + 1] ?? null : null; };
const resumeTurns = (t: CoreEnv, id: string) => t.turns(id).filter((x) => x.prompt.includes(RESUME_LEAD));
const keysOf = (t: CoreEnv, id: string) => t.core.keys.filter((k) => t.core.terminals().find((x) => x.address === k.terminal)?.labels["iamceo.member"] === id).map((k) => k.keys);
/** 오류 표시가 남지 않았다: 상태·오류 글·막힘 사유·관측 오류 모두. */
function noLimitMark(t: CoreEnv, id: string) {
  const m = t.member(id);
  return { status: m.status === "error" || m.status === "blocked" ? m.status : "ok", lastError: m.lastError, blockedReason: m.blockedReason, observation: m.statusObservation?.error?.code ?? null, held: t.orch.apiRecovery.usageLimited(id) };
}
const CLEAR = { status: "ok", lastError: null, blockedReason: null, observation: null, held: false };

describe("사용 한도로 멈춘 팀장의 모델을 바꾸면 같은 세션을 새 모델로 이어 연다", () => {
  test.each(["한도 오류 글(라이브)", "한도 메뉴"] as const)("일하던 팀장이 %s로 멈춘 뒤 대표가 앱에서 모델을 바꾸면: --resume 같은 세션 + 새 --model, 이어가기 글 한 번, 기다리던 지시는 그 뒤", async (how) => {
    const t = await setup();
    const w = await worker(t, "발표 준비", "deck");
    const session = w.sessionId!;
    if (how === "한도 메뉴") await limitByMenu(t, w); else await limitByError(t, w);
    const limitCard = card(t)!;
    expect(limitCard).toMatchObject({ status: "open", usageLimit: { memberIds: [w.id] } });
    // 한도에 걸린 동안 대표가 보낸 지시는 보류된다.
    const waiting = (await t.orch.assign(t.project.id, w.handle, { text: "새 일 @fake:post=새일끝" })).delivery.id;
    expect(t.store.requireDelivery(waiting)).toMatchObject({ status: "held", holdReason: "usage_limit" });
    const runsBefore = t.runs(w.id).length;

    // 앱의 '적용'이 보내는 요청 그대로(cli 를 함께 보낸다).
    const res = await changeModel(t, w.id, "opus");
    expect({ status: res.status, body: res.status === 200 ? "" : await res.text() }).toEqual({ status: 200, body: "" });

    // 같은 세션을 새 모델로 이어 열었다.
    expect(t.runs(w.id)).toHaveLength(runsBefore + 1);
    const run = t.runs(w.id).at(-1)!;
    expect({ resume: run.resumeFlag, model: flag(run, "--model") }).toEqual({ resume: session, model: "opus" });
    expect(t.member(w.id)).toMatchObject({ sessionId: session, modelOverride: "opus", paneId: run.terminal });

    // 이어가기 글이 혼자 먼저 들어가 턴이 돌고, 기다리던 지시는 그 뒤에 들어간다.
    const resumed = await t.waitFor("이어가기 턴", () => resumeTurns(t, w.id).find((x) => x.outcome === "done"));
    expect(resumed.run).toBe(run);
    expect(resumed.prompt).toContain(RESUME);
    expect(resumed.prompt).not.toContain("새 일");
    expect(resumed.prompt).not.toContain("발표 자료 만들기"); // 원래 지시를 다시 넣지 않는다.
    expect(resumed.prompt).not.toContain("랜딩 문구 고치기");
    await t.waitFor("기다리던 지시 전달", () => t.store.requireDelivery(waiting).status === "delivered");
    const next = await t.waitFor("기다리던 지시의 턴", () => t.turns(w.id).find((x) => x.prompt.includes("새 일") && x.outcome === "done"));
    expect(next.index).toBeGreaterThan(resumed.index);
    await t.idle(w.id);
    await Bun.sleep(QUIET_MS);
    expect(resumeTurns(t, w.id)).toHaveLength(1);
    // S2: 이어가기 글이 모델을 바꿨다고 이미 알린다. 설정 변경 인계 글('CLI 설정 변경: claude → claude. … 현재 상황: …')을 다음 턴에 붙이지 않는다.
    expect(t.store.listDeliveries(t.project.id).filter((d) => d.memberId === w.id && /설정 변경|모델 변경|같은 세션을 새 설정으로/.test(d.text)).map((d) => d.text)).toEqual([]);

    // 오류 표시가 사라지고 카드도 닫혔다(남은 팀장이 없다).
    expect(noLimitMark(t, w.id)).toEqual(CLEAR);
    expect(t.store.requireDecision(limitCard.id).status).toBe("closed");
    // 메뉴가 떠 있었으면 Esc 한 번만, 아니면 아무 키도 보내지 않았다.
    expect(keysOf(t, w.id)).toEqual(how === "한도 메뉴" ? [["esc"]] : []);
    // 대화에는 한 줄, 총괄이 없으므로 깨울 사람도 없다.
    expect(t.texts().filter((m) => m.body?.includes("사용 한도로 멈춰 모델을 Opus로 바꿔 이어서 하게 했습니다"))).toHaveLength(1);
  }, 40_000);

  test("총괄이 team_model 로 바꿔도 같다. 새 팀장은 생기지 않고, 총괄에게는 다시 지시하지 말라는 깨우지 않는 소식이 간다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const w = await worker(t, "인스타 2", "insta");
    const session = w.sessionId!;
    await limitByError(t, w);
    const members = t.store.listMembers(t.project.id).length;

    const result = await handleAgentTool(t.orch, t.store.requireMember(lead.id), "team_model", { member: "인스타 2", model: "opus" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("인스타 2의 모델을 Opus로 바꿔 같은 세션을 이어 열었습니다");
    expect(result.text).toContain("멈춘 곳부터 이어서 합니다");
    expect(t.store.listMembers(t.project.id)).toHaveLength(members);
    expect({ resume: t.runs(w.id).at(-1)!.resumeFlag, model: flag(t.runs(w.id).at(-1)!, "--model") }).toEqual({ resume: session, model: "opus" });
    await t.waitFor("이어가기 턴", () => resumeTurns(t, w.id).find((x) => x.outcome === "done"));
    await t.idle(w.id);
    await Bun.sleep(QUIET_MS);
    expect(resumeTurns(t, w.id)).toHaveLength(1);
    expect(noLimitMark(t, w.id)).toEqual(CLEAR);
    expect(keysOf(t, w.id)).toEqual([]);
    // 총괄에게 간 소식: 깨우지 않고, 같은 일을 다시 맡기거나 새로 띄우지 말라고 한다.
    const notes = t.store.listDeliveries(t.project.id).filter((d) => d.memberId === lead.id && d.text.includes("사용 한도로 멈춰"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ wake: false });
    expect(notes[0]!.text).toContain("다른 직원을 새로 띄워 넘기지 마세요");

    // 같은 설정으로 다시 부르면 아무것도 하지 않고 이유를 답한다. 일하는 중인 팀장은 지금처럼 거절한다.
    const same = await handleAgentTool(t.orch, t.store.requireMember(lead.id), "team_model", { member: "insta", model: "opus" });
    expect(same).toMatchObject({ isError: true });
    expect(same.text).toContain("이미 그 모델");
    await t.orch.assign(t.project.id, w.handle, { text: "오래 걸리는 일 @fake:post=오래끝 @fake:hold" });
    await t.waitFor("일하는 중", () => t.core.held(w.id));
    const busy = await handleAgentTool(t.orch, t.store.requireMember(lead.id), "team_model", { member: "insta", model: "sonnet" });
    expect(busy).toMatchObject({ isError: true });
    expect(busy.text).toContain("턴이 끝난 뒤");
    t.core.release(w.id);
  }, 40_000);

  test("쉬던 중 한도에 걸린 팀장(하던 일 없음)은 이어가기 글 없이 새 모델로 열리기만 한다", async () => {
    const t = await setup();
    const w = await worker(t, "B2B 랜딩", "b2b");
    const session = w.sessionId!;
    // 쉬는 화면에 한도 메뉴가 뜬다. Esc 를 누르면 메뉴만 닫힌다(턴은 없었다).
    t.core.onKeys((terminal, pressed) => {
      if (!pressed.includes("esc")) return;
      const id = terminal.labels["iamceo.member"]!;
      t.core.setScreen(id, null);
      t.core.setStatus(id, { state: "error", msg: LIMIT });
    });
    t.core.setScreen(w.id, MENU);
    t.core.setStatus(w.id, { state: "blocked" });
    await t.waitFor("한도 메뉴 보류", () => t.orch.apiRecovery.usageLimited(w.id));
    const waiting = (await t.orch.assign(t.project.id, w.handle, { text: "새 일 @fake:post=새일끝" })).delivery.id;
    expect(t.store.requireDelivery(waiting)).toMatchObject({ status: "held", holdReason: "usage_limit" });

    expect((await changeModel(t, w.id, "opus")).status).toBe(200);
    expect({ resume: t.runs(w.id).at(-1)!.resumeFlag, model: flag(t.runs(w.id).at(-1)!, "--model") }).toEqual({ resume: session, model: "opus" });
    await t.waitFor("기다리던 지시 전달", () => t.store.requireDelivery(waiting).status === "delivered");
    await t.idle(w.id);
    await Bun.sleep(QUIET_MS);
    expect(resumeTurns(t, w.id)).toHaveLength(0);
    expect(t.store.listDeliveries(t.project.id).filter((d) => d.text.includes(RESUME_LEAD))).toHaveLength(0);
    expect(noLimitMark(t, w.id)).toEqual(CLEAR);
    expect(keysOf(t, w.id)).toEqual([["esc"]]);
  }, 40_000);

  test("같은 계정의 다른 팀장의 한도 보류는 그대로다", async () => {
    const t = await setup();
    const a = await worker(t, "발표 준비", "deck");
    const b = await worker(t, "인스타 2", "insta");
    await limitByError(t, a);
    await limitByError(t, b);
    expect(card(t)!.usageLimit!.memberIds.sort()).toEqual([a.id, b.id].sort());
    const waitingB = (await t.orch.assign(t.project.id, b.handle, { text: "B 새 일 @fake:post=B끝" })).delivery.id;

    expect((await changeModel(t, a.id, "opus")).status).toBe(200);
    await t.waitFor("A 이어가기 턴", () => resumeTurns(t, a.id).find((x) => x.outcome === "done"));
    await Bun.sleep(QUIET_MS);
    expect(noLimitMark(t, a.id)).toEqual(CLEAR);
    // B 는 여전히 한도 보류다: 전달도 붙잡혀 있고, 세션도 그대로이며, 카드에는 B 만 남았다.
    expect(t.orch.apiRecovery.usageLimited(b.id)).toBe(true);
    expect(t.member(b.id)).toMatchObject({ status: "error", lastError: "사용 한도 해제를 기다립니다", modelOverride: FABLE });
    expect(t.store.requireDelivery(waitingB)).toMatchObject({ status: "held", holdReason: "usage_limit" });
    expect(t.runs(b.id)).toHaveLength(1);
    expect(resumeTurns(t, b.id)).toHaveLength(0);
    expect(card(t)).toMatchObject({ status: "open", usageLimit: { memberIds: [b.id] } });
  }, 40_000);

  test("새 모델도 한도에 걸리면 평소처럼 다시 보류된다", async () => {
    const t = await setup();
    const w = await worker(t, "발표 준비", "deck");
    await limitByError(t, w);
    // 이어가기 턴도 한도로 끝난다.
    t.core.setScript([]);
    t.core.setOnTurn(({ prompt }) => { if (prompt.includes(RESUME_LEAD) || prompt.includes("한도일")) throw Object.assign(new Error(LIMIT), { fake: "error" }); });
    expect((await changeModel(t, w.id, "opus")).status).toBe(200);
    await t.waitFor("다시 한도 보류", () => resumeTurns(t, w.id).some((x) => x.outcome === "error") && t.orch.apiRecovery.usageLimited(w.id));
    expect(t.member(w.id)).toMatchObject({ status: "error", lastError: "사용 한도 해제를 기다립니다" });
    expect(card(t)).toMatchObject({ status: "open", usageLimit: { memberIds: [w.id] } });
  }, 40_000);
});

describe("사용 한도로 멈춘 팀장의 재우기·닫기", () => {
  test("한도 오류로 멈춘 팀장도, 한도 메뉴가 떠 있는 팀장도 재워지고(메뉴는 Esc 한 번), 깨우면 같은 세션으로 열린다", async () => {
    const t = await setup();
    const a = await worker(t, "발표 준비", "deck");
    const b = await worker(t, "B2B 랜딩", "b2b");
    await limitByError(t, a);
    await limitByMenu(t, b);
    for (const w of [a, b]) {
      // 예전: 409 "실행 중인 일이나 미해결 입력이 있어 닫지 않았습니다"(CoreRunner.checkStop 이 OSC error·blocked 를 '처리 중'으로 읽었다).
      expect(await t.orch.sleepMember(w.id)).toMatchObject({ status: "asleep" });
      expect(t.core.terminalOf(w.id)!.state).toBe("finished");
    }
    expect(keysOf(t, a.id)).toEqual([]);
    expect(keysOf(t, b.id)).toEqual([["esc"]]);
    for (const w of [a, b]) {
      const reopened = await t.orch.resumeMember(w.id);
      expect(reopened.sessionId).toBe(w.sessionId);
      expect(t.runs(w.id).at(-1)!.resumeFlag).toBe(w.sessionId);
    }
    expect(t.core.keys.flatMap((k) => k.keys)).toEqual(["esc"]);
  }, 40_000);

  test("한도로 멈춘 팀장을 닫으면 명부에서 빠진다. 입력칸에 쓰던 글이 있으면 재우기는 지금처럼 거절한다", async () => {
    const t = await setup();
    const a = await worker(t, "발표 준비", "deck");
    const b = await worker(t, "인스타 2", "insta");
    await limitByError(t, a);
    await limitByError(t, b);
    await closeWhenSettled(t, a.id);
    expect(t.store.getMember(a.id)).toBeNull();
    expect(t.core.terminalOf(a.id)!.state).toBe("finished");
    t.core.setDraft(b.id, "대표가 쓰던 글");
    expect(await rejection(t.orch.sleepMember(b.id))).toMatchObject({ status: 409, message: expect.stringContaining("입력칸에 글이 남아") });
    expect(t.core.terminalOf(b.id)!.state).toBe("live");
  }, 40_000);
});

test("이어가기 글은 서버를 다시 띄워도 한 번뿐이다", async () => {
  const t = await setup();
  const w = await worker(t, "발표 준비", "deck");
  await limitByError(t, w);
  expect((await changeModel(t, w.id, "opus")).status).toBe(200);
  await t.waitFor("이어가기 턴", () => resumeTurns(t, w.id).find((x) => x.outcome === "done"));
  await t.idle(w.id);
  const next = await t.restart();
  cleanups.push(() => next.close());
  await Bun.sleep(QUIET_MS);
  expect(resumeTurns(next, w.id)).toHaveLength(1);
  // 다시 띄운 뒤 모델을 또 바꿔도(이제 한도 보류가 아니다) 이어가기 글을 다시 넣지 않는다.
  await next.idle(w.id);
  expect((await changeModel(next, w.id, "sonnet")).status).toBe(200);
  expect(flag(next.runs(w.id).at(-1)!, "--model")).toBe("sonnet");
  await Bun.sleep(QUIET_MS);
  expect(resumeTurns(next, w.id)).toHaveLength(1);
  expect(next.store.listDeliveries(next.project.id).filter((d) => d.text.includes(RESUME_LEAD))).toHaveLength(1);
}, 40_000);

test("한도에 걸린 채 서버를 다시 띄운 뒤 모델을 바꿔도 같은 세션으로 이어 열고 이어가기 글은 한 번이다", async () => {
  const t = await setup();
  const w = await worker(t, "발표 준비", "deck");
  await limitByError(t, w);
  const next = await t.restart();
  cleanups.push(() => next.close());
  await Bun.sleep(QUIET_MS);
  // 다시 띄운 서버가 한도로 끝난 터미널을 다시 관측해도 보류는 그대로 하나다.
  expect(next.orch.apiRecovery.usageLimited(w.id)).toBe(true);
  expect(next.member(w.id)).toMatchObject({ status: "error", lastError: "사용 한도 해제를 기다립니다" });
  expect((await changeModel(next, w.id, "opus")).status).toBe(200);
  expect({ resume: next.runs(w.id).at(-1)!.resumeFlag, model: flag(next.runs(w.id).at(-1)!, "--model") }).toEqual({ resume: w.sessionId, model: "opus" });
  await next.waitFor("이어가기 턴", () => resumeTurns(next, w.id).find((x) => x.outcome === "done"));
  await next.idle(w.id);
  await Bun.sleep(QUIET_MS);
  expect(resumeTurns(next, w.id)).toHaveLength(1);
  expect(noLimitMark(next, w.id)).toEqual(CLEAR);
}, 40_000);

test("한도로 멈춘 뒤 재운 팀장의 모델을 바꾸면 보류를 풀고, 이어가기 글이 새 모델로 같은 세션을 연다", async () => {
  const t = await setup();
  const w = await worker(t, "발표 준비", "deck");
  await limitByError(t, w);
  expect(await t.orch.sleepMember(w.id)).toMatchObject({ status: "asleep" });
  const runs = t.runs(w.id).length;
  expect((await changeModel(t, w.id, "opus")).status).toBe(200);
  await t.waitFor("이어가기 턴", () => resumeTurns(t, w.id).find((x) => x.outcome === "done"));
  expect(t.runs(w.id)).toHaveLength(runs + 1);
  expect({ resume: t.runs(w.id).at(-1)!.resumeFlag, model: flag(t.runs(w.id).at(-1)!, "--model") }).toEqual({ resume: w.sessionId, model: "opus" });
  await t.idle(w.id);
  await Bun.sleep(QUIET_MS);
  expect(resumeTurns(t, w.id)).toHaveLength(1);
  expect(noLimitMark(t, w.id)).toEqual(CLEAR);
}, 40_000);

test("한도가 아닌 이유로 일하는 팀장의 모델 변경은 예전처럼 거절되고(409), 턴이 끝난 뒤 바꾸면 적용된다", async () => {
  const t = await setup();
  const w = await worker(t, "발표 준비", "deck");
  await t.orch.assign(t.project.id, w.handle, { text: "오래 걸리는 일 @fake:post=오래끝 @fake:hold" });
  await t.waitFor("일하는 중", () => t.core.held(w.id));
  const refused = await t.api("PATCH", `/api/members/${w.id}`, { cli: "claude", modelOverride: "opus", effortOverride: null });
  expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 409, body: { error: "일하거나 세션을 처리하는 중입니다. 턴이 끝난 뒤 CLI를 바꾸세요", code: "cli_switch_busy" } });
  expect(t.member(w.id).modelOverride).toBe(FABLE);
  expect(t.runs(w.id)).toHaveLength(1);
  t.core.release(w.id);
  await t.idle(w.id);
  expect((await changeModel(t, w.id, "opus")).status).toBe(200);
  expect({ resume: t.runs(w.id).at(-1)!.resumeFlag, model: flag(t.runs(w.id).at(-1)!, "--model") }).toEqual({ resume: w.sessionId, model: "opus" });
  expect(t.store.listDeliveries(t.project.id).filter((d) => d.text.includes(RESUME_LEAD))).toHaveLength(0);
  expect(t.core.keys).toEqual([]);
  // S2: 일반 설정 변경의 인계 글은 그대로 넣되, 같은 CLI 면 'claude → claude' 가 아니라 바뀐 것을 사실대로 적는다.
  const handoff = t.store.listDeliveries(t.project.id).filter((d) => d.memberId === w.id && d.text.includes("같은 세션을 새 설정으로 이어 열었습니다"));
  expect(handoff).toHaveLength(1);
  expect(handoff[0]!.text).toContain("모델 변경: Fable 5.2 → Opus. 같은 세션을 새 설정으로 이어 열었습니다.");
  expect(handoff[0]!.text).not.toContain("claude → claude");
}, 40_000);

// 2026-11-13 대표 지적: 카드가 '계정을 바꿨어요 · 모두 이어가기' 하나뿐이었다. 계정이 하나인 사람도 있고, 이번처럼 한 모델의 크레딧만 떨어졌으면
// 다른 모델로 바꾸면 바로 된다. 카드에서 모델을 고르면 카드의 팀장 모두가 같은 세션을 그 모델로 이어 연다.
describe("사용 한도 카드에서 다른 모델 고르기", () => {
  const answer = (t: CoreEnv, id: string, choice: string, expectedVersion?: string) => t.api("POST", `/api/decisions/${id}/answer`, { choice, ...(expectedVersion ? { expectedVersion } : {}) });
  const RESUME_OPTION = { k: "resume", label: "계정을 바꿨거나 한도를 늘렸어요 · 이어가기" };

  test("Fable 크레딧이 떨어진 팀장 둘: 카드는 Fable 을 뺀 모델 선택지와 이어가기를 내고, Opus 를 고르면 둘 다 같은 세션을 Opus 로 이어 연다(두 번 답해도 한 번)", async () => {
    const t = await setup();
    const a = await worker(t, "발표 준비", "deck");
    const b = await worker(t, "B2B 랜딩", "b2b");
    await limitByError(t, a);
    await limitByError(t, b);
    const limitCard = card(t)!;
    // 이번 라이브와 같은 경우에 실제로 만들어지는 선택지(모델 목록: 기본 opus·sonnet·haiku + 이 Mac 의 Fable 5.2).
    expect(limitCard.options).toEqual([
      { k: "model:opus", label: "Opus로 바꿔 이어가기" },
      { k: "model:sonnet", label: "Sonnet으로 바꿔 이어가기" },
      { k: "model:haiku", label: "Haiku로 바꿔 이어가기" },
      RESUME_OPTION,
    ]);
    expect(limitCard.detail.split("\n\n")[0]).toBe("Fable 5.2 사용 크레딧이 떨어졌습니다. 다른 모델로 바꾸면 바로 이어 갑니다. 기다리면 크레딧이 채워질 때 자동으로 이어 갑니다. 바로 이어 가려면 다른 모델을 고르세요(고를 버튼이 없으면 팀장 설정에서 모델을 바꾸거나 총괄에게 모델을 바꿔 이어 가라고 하세요). 다른 계정으로 로그인했거나 한도를 늘렸다면 '이어가기'를 누르세요.");
    const runs = { a: t.runs(a.id).length, b: t.runs(b.id).length };

    const res = await answer(t, limitCard.id, "model:opus", limitCard.updatedAt);
    expect({ status: res.status, body: res.status === 200 ? "" : await res.text() }).toEqual({ status: 200, body: "" });
    expect(t.store.requireDecision(limitCard.id).status).toBe("closed");
    for (const w of [a, b]) {
      expect(t.runs(w.id)).toHaveLength(runs[w.id === a.id ? "a" : "b"] + 1);
      const run = t.runs(w.id).at(-1)!;
      expect({ resume: run.resumeFlag, model: flag(run, "--model") }).toEqual({ resume: w.sessionId, model: "opus" });
      expect(t.member(w.id).modelOverride).toBe("opus");
      await t.waitFor(`${w.name} 이어가기 턴`, () => resumeTurns(t, w.id).find((x) => x.outcome === "done"));
    }
    // 같은 답이 다시 와도(응답을 잃은 앱의 재시도) 한 번만 한다.
    const again = await answer(t, limitCard.id, "model:opus", limitCard.updatedAt);
    expect(again.status).toBe(200);
    for (const w of [a, b]) await t.idle(w.id);
    await Bun.sleep(QUIET_MS);
    for (const w of [a, b]) {
      expect(t.runs(w.id)).toHaveLength(runs[w.id === a.id ? "a" : "b"] + 1);
      expect(resumeTurns(t, w.id)).toHaveLength(1);
      expect(noLimitMark(t, w.id)).toEqual(CLEAR);
    }
    expect(t.core.keys).toEqual([]);
  }, 40_000);

  test("목록에 없는 값·다른 CLI 의 모델·한도에 걸린 모델·모르는 답은 400 이고 아무것도 바꾸지 않는다", async () => {
    const t = await setup();
    const w = await worker(t, "발표 준비", "deck");
    await limitByError(t, w);
    const limitCard = card(t)!;
    for (const choice of ["model:nope", "model:gpt-6-luna", `model:${FABLE}`, "approve"]) {
      const res = await answer(t, limitCard.id, choice, limitCard.updatedAt);
      const body = await res.json() as { error: string };
      expect({ choice, status: res.status }).toEqual({ choice, status: 400 });
      // F6: 앱은 '사용 한도'가 든 글을 모두 "…다른 모델로 바꾸면 바로 이어 갑니다"로 바꿔 보여 준다. 거절 까닭이 덮이지 않게 그 낱말을 쓰지 않는다.
      expect(body.error).not.toContain("사용 한도");
    }
    expect(await (await answer(t, limitCard.id, "model:nope", limitCard.updatedAt)).json()).toEqual({ error: "이 CLI의 모델 목록에 없는 모델입니다", code: "model_unknown" });
    expect(t.store.requireDecision(limitCard.id)).toMatchObject({ status: "open", updatedAt: limitCard.updatedAt });
    expect(t.runs(w.id)).toHaveLength(1);
    expect(t.member(w.id).modelOverride).toBe(FABLE);
    expect(t.orch.apiRecovery.usageLimited(w.id)).toBe(true);
  }, 40_000);

  test("팀장마다 모델이 다르면 카드 전체에서 한도에 걸린 모델(쓰던 모델·글에 나온 모델)을 모두 뺀다", async () => {
    const t = await setup();
    const a = await worker(t, "발표 준비", "deck");
    const b = await worker(t, "인스타 2", "insta");
    await t.orch.patchMemberConfig(b.id, { modelOverride: "sonnet" });
    await t.idle(b.id);
    await limitByError(t, a); // Fable 크레딧 소진
    await t.orch.assign(t.project.id, b.handle, { text: "주간한도" }); // sonnet 을 쓰던 팀장의 계정 한도
    await t.waitFor("둘째 한도 보류", () => t.orch.apiRecovery.usageLimited(b.id));
    expect(card(t)!.options.map((o) => o.k)).toEqual(["model:opus", "model:haiku", "resume"]);
  }, 40_000);

  test("예전의 '이어가기'(resume) 답은 예전처럼: 모델·세션을 바꾸지 않고 이어가기 글을 넣는다", async () => {
    const t = await setup();
    const w = await worker(t, "발표 준비", "deck");
    await limitByError(t, w);
    const limitCard = card(t)!;
    const res = await answer(t, limitCard.id, "resume", limitCard.updatedAt);
    expect(res.status).toBe(200);
    await t.waitFor("한도 이어가기 글 턴", () => t.turns(w.id).find((x) => x.prompt.includes("[시스템] 사용 한도로 하던 턴이 멈췄습니다") && x.outcome === "done"));
    expect(t.runs(w.id)).toHaveLength(1);
    expect(t.member(w.id).modelOverride).toBe(FABLE);
    expect(resumeTurns(t, w.id)).toHaveLength(0);
  }, 40_000);

  // a176ecf 리뷰 F1: 주간·5시간 한도는 모든 모델이 같이 쓴다. 모델을 바꿔도 곧바로 다시 걸리고, 바꾼 모델 지정만 낮아진 채 남는다.
  test("계정 전체의 한도(주간)에 걸린 카드는 모델 선택지 없이 '이어가기'만 내고, 모델 답은 400 이다", async () => {
    const t = await setup();
    const w = await worker(t, "발표 준비", "deck");
    await t.orch.assign(t.project.id, w.handle, { text: "주간한도" });
    await t.waitFor("한도 보류", () => t.orch.apiRecovery.usageLimited(w.id));
    const limitCard = card(t)!;
    expect(limitCard.options).toEqual([RESUME_OPTION]);
    expect(limitCard.detail).not.toContain("다른 모델");
    expect((await answer(t, limitCard.id, "model:opus", limitCard.updatedAt)).status).toBe(400);
    expect(t.member(w.id).modelOverride).toBe(FABLE);
    expect(t.runs(w.id)).toHaveLength(1);
  }, 40_000);

  test("카드에서 한 번 걸린 모델은 그 팀장이 카드에서 빠진 뒤에도 다시 내지 않는다", async () => {
    const t = await setup();
    const a = await worker(t, "발표 준비", "deck");
    const b = await worker(t, "인스타 2", "insta");
    await t.orch.patchMemberConfig(b.id, { modelOverride: "sonnet" });
    await t.idle(b.id);
    await limitByError(t, a); // Fable 크레딧 소진
    await t.orch.assign(t.project.id, b.handle, { text: "소네트한도" }); // Sonnet 만의 한도
    await t.waitFor("둘째 한도 보류", () => t.orch.apiRecovery.usageLimited(b.id));
    expect(card(t)!.options.map((o) => o.k)).toEqual(["model:opus", "model:haiku", "resume"]);
    // A 만 팀장 설정에서 Opus 로 바꾼다. 카드에는 B 만 남는다. A 가 걸렸던 Fable 은 여전히 크레딧이 없다.
    expect((await changeModel(t, a.id, "opus")).status).toBe(200);
    await t.waitFor("A 이어가기 턴", () => resumeTurns(t, a.id).find((x) => x.outcome === "done"));
    expect(card(t)).toMatchObject({ status: "open", usageLimit: { memberIds: [b.id] } });
    expect(card(t)!.options.map((o) => o.k)).toEqual(["model:opus", "model:haiku", "resume"]);
  }, 40_000);

  // a176ecf 리뷰 F5: 한도 카드의 답은 결재 id 하나로만 합쳐져, 모델을 바꾸는 동안 온 다른 선택(다른 기기, 다시 누름)이 앞 답의 결과를 200 으로 받았다.
  test("모델 답이 도는 동안 다른 선택이 오면 409 이고(앞 답의 결과를 성공으로 받지 않는다), 같은 선택은 같은 결과를 받는다", async () => {
    const t = await setup();
    const w = await worker(t, "B2B 랜딩", "b2b");
    await limitByMenu(t, w);
    // Esc 로 메뉴는 사라졌지만 CLI 는 한동안 막힘을 알린다: 서버가 닫혔는지 확인하는 동안 다른 선택이 온다.
    let closeMenu: (() => void) | null = null;
    t.core.onKeys((terminal, pressed) => {
      if (!pressed.includes("esc")) return;
      const id = terminal.labels["iamceo.member"]!;
      t.core.setScreen(id, null);
      closeMenu = () => { if (!t.core.release(id, { error: LIMIT })) t.core.setStatus(id, { state: "error", msg: LIMIT }); };
    });
    const limitCard = card(t)!;
    const first = answer(t, limitCard.id, "model:opus", limitCard.updatedAt);
    await t.waitFor("Esc", () => closeMenu);
    const same = answer(t, limitCard.id, "model:opus", limitCard.updatedAt);
    const other = await answer(t, limitCard.id, "model:sonnet", limitCard.updatedAt);
    const resume = await answer(t, limitCard.id, "resume", limitCard.updatedAt);
    expect({ status: other.status, body: await other.json() }).toEqual({ status: 409, body: { error: "다른 선택을 처리하는 중입니다. 잠시 뒤 카드를 다시 확인해 주세요", code: "usage_choice_busy" } });
    expect(resume.status).toBe(409);
    closeMenu!();
    expect((await first).status).toBe(200);
    expect((await same).status).toBe(200);
    expect(t.member(w.id).modelOverride).toBe("opus");
    expect(t.runs(w.id).filter((r) => flag(r, "--model") === "sonnet")).toHaveLength(0);
    expect(keysOf(t, w.id)).toEqual([["esc"]]);
  }, 40_000);

  test("카드의 팀장이 모두 이어가기 결과를 기다리는 중이면 모델 답은 409 이고 아무것도 바꾸거나 적어 두지 않는다", async () => {
    const t = await setup();
    const w = await worker(t, "발표 준비", "deck");
    await limitByError(t, w);
    // 입력칸에 대표가 쓰던 글이 있어 이어가기 글이 들어가지 못한다(결과를 기다리는 채로 카드에 남는다).
    t.core.setDraft(w.id, "대표가 쓰던 글");
    const limitCard = card(t)!;
    expect((await answer(t, limitCard.id, "resume", limitCard.updatedAt)).status).toBe(200);
    await t.waitFor("이어가기 대기", () => !t.orch.apiRecovery.usageLimited(w.id));
    const open = card(t)!;
    expect(open).toMatchObject({ id: limitCard.id, status: "open", usageLimit: { memberIds: [w.id] } });
    const runs = t.runs(w.id).length;
    const res = await answer(t, open.id, "model:opus", open.updatedAt);
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 409, body: { error: "카드의 팀장이 모두 이어가기 결과를 기다리는 중입니다. 잠시 뒤 카드를 다시 확인해 주세요", code: "usage_notice_pending" } });
    expect(t.member(w.id).modelOverride).toBe(FABLE);
    expect(t.runs(w.id)).toHaveLength(runs);
    // 적어 두지 않았다: 카드가 닫힌 뒤 같은 답이 와도 '이미 바꿨다'로 받지 않는다.
    expect(t.orch.apiRecovery.answeredWith(open.id)).toBeNull();
  }, 40_000);

  test("앱이 본 팀장과 카드의 팀장이 다르면(그 사이 다른 팀장이 붙었다) 모델 답은 409 이고 아무도 바꾸지 않는다", async () => {
    const t = await setup();
    const a = await worker(t, "발표 준비", "deck");
    const b = await worker(t, "인스타 2", "insta");
    await limitByError(t, a);
    const seen = card(t)!;
    await limitByError(t, b);
    const now = card(t)!;
    // 카드의 판(updatedAt)은 푸시 알림에 묶여 팀장이 붙어도 그대로다. 그래서 판으로는 걸러지지 않는다.
    expect({ id: now.id, updatedAt: now.updatedAt, members: now.usageLimit!.memberIds.length }).toEqual({ id: seen.id, updatedAt: seen.updatedAt, members: 2 });
    const refused = await t.api("POST", `/api/decisions/${now.id}/answer`, { choice: "model:opus", expectedVersion: seen.updatedAt, memberIds: seen.usageLimit!.memberIds });
    expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 409, body: { error: "카드의 팀장이 바뀌었습니다. 카드를 다시 확인해 주세요", code: "usage_notice_member_changed" } });
    for (const w of [a, b]) expect(t.member(w.id).modelOverride).toBe(FABLE);
    const ok = await t.api("POST", `/api/decisions/${now.id}/answer`, { choice: "model:opus", expectedVersion: now.updatedAt, memberIds: [...now.usageLimit!.memberIds].reverse() });
    expect(ok.status).toBe(200);
    for (const w of [a, b]) expect(t.member(w.id).modelOverride).toBe("opus");
  }, 40_000);
});

// ───────── a176ecf 리뷰 반영: CLI 교체·총괄 도구의 답·끝내기 가장자리·재시작 깨우기 ─────────
describe("a176ecf 리뷰 반영", () => {
  // F3: 한도로 멈춘 팀장의 CLI 교체가 통과하게 됐는데 보류는 풀리지 않아, 새 Codex 세션에 대표의 말이 '사용 한도 해제를 기다립니다'로 붙잡혔다.
  test("한도로 멈춘 팀장의 CLI 를 Codex 로 바꾸면 한도 보류가 풀리고 카드에서 빠진다. 새 CLI 는 같은 대화가 아니므로 이어가기 글은 없다", async () => {
    const t = await setup();
    const w = await worker(t, "발표 준비", "deck");
    await limitByError(t, w);
    const waiting = (await t.orch.assign(t.project.id, w.handle, { text: "새 일 @fake:post=새일끝" })).delivery.id;
    expect(t.store.requireDelivery(waiting)).toMatchObject({ status: "held", holdReason: "usage_limit" });
    const limitCard = card(t)!;
    const res = await t.api("PATCH", `/api/members/${w.id}`, { cli: "codex", modelOverride: null, effortOverride: null });
    expect({ status: res.status, body: res.status === 200 ? "" : await res.text() }).toEqual({ status: 200, body: "" });
    expect(t.member(w.id).cli).toBe("codex");
    expect(t.runs(w.id).at(-1)!.cli).toBe("codex");
    expect(t.orch.apiRecovery.holdReason(w.id)).toBeNull();
    expect(t.store.requireDecision(limitCard.id).status).toBe("closed");
    // 대표의 말은 더 이상 한도로 붙잡혀 있지 않다(새 Codex 세션으로 나간다).
    expect(t.store.requireDelivery(waiting).holdReason).not.toBe("usage_limit");
    await Bun.sleep(QUIET_MS);
    expect(t.orch.apiRecovery.holdReason(w.id)).toBeNull();
    expect(t.store.requireDelivery(waiting).holdReason).not.toBe("usage_limit");
    expect(t.store.listDeliveries(t.project.id).filter((d) => d.text === USAGE_RESUME_TEXT || d.text.includes(RESUME_LEAD))).toEqual([]);
    expect(t.member(w.id)).toMatchObject({ blockedReason: null });
    expect(t.member(w.id).lastError).not.toBe(USAGE_WAIT_NOTE);
    // 멈춘 일은 대화에 '중단'으로 남는다(새 CLI 에는 그 대화가 없다).
    expect(t.texts().filter((m) => m.body?.includes("중단 — 사용 한도로 멈췄습니다. CLI를 Codex로 바꿔"))).toHaveLength(1);
  }, 40_000);

  // F8: 총괄이 받는 team_model 의 설명과 답이 서버가 실제로 한 일과 맞아야 한다.
  test("team_model 설명은 대표가 바꾸라고 했을 때만 쓰라고 하고, 그 전에는 기다리라고 한다(team_add·roster 도 같다)", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const tools = Object.fromEntries(listAgentTools(t.store.requireMember(lead.id)).map((x) => [x.name, x.description]));
    expect(tools.team_model).toStartWith("대표가 모델을 바꾸라고 했을 때만 쓴다.");
    expect(tools.team_model).toContain("사용 한도로 멈춘 직원은 대표가 정할 때까지 기다린다");
    expect(tools.team_add).toContain("대표가 모델을 바꾸라고 하면 team_model");
    expect(tools.roster).toContain("대표가 바꾸라고 할 때만 team_model");
  }, 40_000);

  test("team_model: 옛 터미널을 끝낸 뒤 새 터미널 기동이 실패해도 보류를 풀었으면 실패로 답하지 않고 '곧 다시 연다'고 답한다. 곧 새 모델로 이어 연다", async () => {
    const t = await setup({ timings: { configRetryMs: 300 } });
    const lead = await t.orch.ensureConductor(t.project.id);
    const w = await worker(t, "인스타 2", "insta");
    await limitByError(t, w);
    let refuse = true;
    t.core.intercept((call) => refuse && call.method === "terminal.run" && call.params.labels?.["iamceo.member"] === w.id ? { error: { kind: "invalid", message: "터미널을 만들지 못함" } } : undefined);
    const result = await handleAgentTool(t.orch, t.store.requireMember(lead.id), "team_model", { member: "인스타 2", model: "opus" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toBe("인스타 2의 모델을 Opus로 바꿨습니다. 사용 한도로 멈춘 일을 이어서 하도록 새 모델로 다시 엽니다. 같은 일을 다시 맡기거나 새 직원에게 넘기지 마세요");
    expect(t.orch.apiRecovery.usageLimited(w.id)).toBe(false);
    expect(t.member(w.id)).toMatchObject({ status: "offline", modelOverride: "opus" });
    refuse = false;
    const resumed = await t.waitFor("새 모델로 이어 엶", () => resumeTurns(t, w.id).find((x) => x.outcome === "done"), 20_000);
    expect({ resume: resumed.run.resumeFlag, model: flag(resumed.run, "--model") }).toEqual({ resume: w.sessionId, model: "opus" });
    t.core.intercept(null);
  }, 40_000);

  test("team_model: 잠든 한도 팀장의 세션 기록이 없으면 '넘기지 마세요'라고 하지 않는다(총괄에게 간 중단 알림과 어긋나지 않는다)", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const w = await worker(t, "인스타 2", "insta");
    await limitByError(t, w);
    expect(await t.orch.sleepMember(w.id)).toMatchObject({ status: "asleep" });
    rmSync(transcriptPath(t.member(w.id).cwd, w.sessionId!, join(t.home, "claude-home")));
    const result = await handleAgentTool(t.orch, t.store.requireMember(lead.id), "team_model", { member: "인스타 2", model: "opus" });
    expect(result.isError).toBeUndefined();
    expect(result.text).not.toContain("넘기지 마세요");
    expect(result.text).toBe("인스타 2의 모델을 Opus로 바꿨습니다. 사용 한도 보류를 풀었습니다. 다음에 열 때 새 모델로 엽니다");
    // 총괄은 깨우는 중단 알림을 받았다: 후속 지시는 총괄이 정한다.
    expect(t.store.listDeliveries(t.project.id).filter((d) => d.memberId === lead.id && d.text.includes("중단되었습니다") && d.wake)).toHaveLength(1);
  }, 40_000);

  test("team_model: 세션 ID 를 모르는 한도 팀장은 409 로 알리고 아무것도 바꾸지 않는다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const w = await worker(t, "인스타 2", "insta");
    await limitByError(t, w);
    t.store.patchMember(w.id, { sessionId: null });
    const result = await handleAgentTool(t.orch, t.store.requireMember(lead.id), "team_model", { member: "인스타 2", model: "opus" });
    expect(result).toEqual({ isError: true, text: "인스타 2의 세션 ID를 확인하지 못해 한도 보류를 풀 수 없습니다. 한도가 풀리면 서버가 이어 갑니다" });
    expect(t.member(w.id).modelOverride).toBe(FABLE);
    expect(t.orch.apiRecovery.usageLimited(w.id)).toBe(true);
  }, 40_000);

  // F10(a): Esc 로 메뉴를 닫은 뒤 끝내기가 거절되면, 닫는 동안 버려진 상태 이벤트 때문에 명부가 blocked 로 굳어 팀 설정이 막혔다.
  test("한도 메뉴를 Esc 로 닫은 뒤 끝내기가 거절되면 막힘 표시가 남지 않는다: 오류(한도) 상태로 고쳐 적는다", async () => {
    const t = await setup();
    const w = await worker(t, "B2B 랜딩", "b2b");
    await limitByMenu(t, w);
    // Esc 로 메뉴가 닫히면서 입력칸에 대표가 쓰던 글이 드러난다.
    t.core.onKeys((terminal, pressed) => {
      if (!pressed.includes("esc")) return;
      const id = terminal.labels["iamceo.member"]!;
      t.core.setScreen(id, null);
      t.core.setDraft(id, "대표가 쓰던 글");
      if (!t.core.release(id, { error: LIMIT })) t.core.setStatus(id, { state: "error", msg: LIMIT });
    });
    expect(await rejection(t.orch.sleepMember(w.id))).toMatchObject({ status: 409 });
    expect(t.core.terminalOf(w.id)!.state).toBe("live");
    expect(t.member(w.id)).toMatchObject({ status: "error", blockedReason: "usage_limit", lastError: USAGE_WAIT_NOTE });
    expect(t.orch.apiRecovery.usageLimited(w.id)).toBe(true);
    expect(keysOf(t, w.id)).toEqual([["esc"]]);
  }, 40_000);

  // F10(b): 닫기·강제 재우기는 마지막 탈출구다. 오류로 끝난 팀장의 입력칸을 알아보지 못했다고 막지 않는다(쓰던 글이 보이면 지킨다).
  test("오류로 끝난 팀장은 입력칸을 알아볼 수 없는 화면(오류 배너)이어도 닫힌다. 쓰던 글이 보이면 지금처럼 거절한다", async () => {
    const t = await setup();
    const a = await worker(t, "발표 준비", "deck");
    const b = await worker(t, "인스타 2", "insta");
    await limitByError(t, a);
    await limitByError(t, b);
    t.core.setScreen(a.id, "API Error: You're out of usage credits.\n(오류 배너가 입력칸을 가렸다)");
    await closeWhenSettled(t, a.id);
    expect(t.store.getMember(a.id)).toBeNull();
    expect(t.core.terminalOf(a.id)!.state).toBe("finished");
    t.core.setDraft(b.id, "대표가 쓰던 글");
    expect(await rejection(closeWhenSettled(t, b.id))).toMatchObject({ status: 409 });
    expect(t.core.terminalOf(b.id)!.state).toBe("live");
  }, 40_000);

  // S1: 라이브 DB 사본(터미널이 모두 사라진 상태)에서 재시작 자동 깨우기가 한도로 멈춘 팀장 셋을 다시 열어 status idle, 막힘 사유·오류 글이 비었는데
  // 한도 카드와 보류는 남았다. 화면(쉬는 중)과 실제(한도 보류)가 어긋났다.
  test.each(["엔진이 터미널을 모른다고 답함", "엔진이 재시작으로 끝났다고 알림"] as const)("한도로 멈춘 팀장의 터미널이 재시작으로 사라지면(%s) 다시 뜬 서버는 그 팀장을 스스로 열지 않고 한도 표시·카드·보류를 그대로 둔다. 카드에서 모델을 고르면 같은 세션을 새 모델로 연다", async (how) => {
    const t = await setup();
    const a = await worker(t, "발표 준비", "deck");
    const b = await worker(t, "검색 개선", "search");
    await limitByError(t, a);
    const waiting = (await t.orch.assign(t.project.id, a.handle, { text: "새 일 @fake:post=새일끝" })).delivery.id;
    const limitCard = card(t)!;
    const runsA = t.runs(a.id).length, runsB = t.runs(b.id).length;
    await t.stopServer();
    if (how === "엔진이 재시작으로 끝났다고 알림") { t.core.exit(a.id, 1, "holder_lost"); t.core.exit(b.id, 1, "holder_lost"); }
    else {
      const lost = new Set([t.core.terminalOf(a.id)!.address, t.core.terminalOf(b.id)!.address]);
      t.core.intercept((call) => call.method === "terminal.list" ? { result: { terminals: t.core.terminals().filter((x) => !lost.has(x.address)) } }
        : lost.has(String(call.params.terminal)) ? { error: { kind: "not_found", message: "no such terminal" } } : undefined);
    }
    const next = await t.restart();
    cleanups.push(() => next.close());
    // 한도가 아닌 팀장은 평소처럼 스스로 다시 열린다(깨우기가 돈 것을 확인한다).
    await next.waitFor("B 다시 열림", () => next.runs(b.id).length === runsB + 1 && next.member(b.id).status === "idle");
    await Bun.sleep(QUIET_MS);
    expect(next.runs(a.id)).toHaveLength(runsA);
    expect(next.store.getRestartWake(a.id)).toBeNull();
    expect(next.member(a.id)).toMatchObject({ status: "offline", paneId: null, blockedReason: "usage_limit", lastError: USAGE_WAIT_NOTE, statusObservation: { error: { code: "usage_limit" } } });
    expect(next.orch.apiRecovery.usageLimited(a.id)).toBe(true);
    expect(next.store.requireDecision(limitCard.id)).toMatchObject({ status: "open", usageLimit: { memberIds: [a.id] } });
    expect(next.store.requireDelivery(waiting)).toMatchObject({ status: "held", holdReason: "usage_limit" });
    // 대표가 카드에서 모델을 고르면 그 팀장만 같은 세션을 새 모델로 연다. 멈춘 일의 이어가기 글이 먼저, 기다리던 지시는 그 뒤.
    const now = next.store.requireDecision(limitCard.id);
    const res = await next.api("POST", `/api/decisions/${now.id}/answer`, { choice: "model:opus", expectedVersion: now.updatedAt });
    expect({ status: res.status, body: res.status === 200 ? "" : await res.text() }).toEqual({ status: 200, body: "" });
    const resumed = await next.waitFor("이어가기 턴", () => resumeTurns(next, a.id).find((x) => x.outcome === "done"));
    expect({ resume: resumed.run.resumeFlag, model: flag(resumed.run, "--model") }).toEqual({ resume: a.sessionId, model: "opus" });
    await next.waitFor("기다리던 지시 전달", () => next.store.requireDelivery(waiting).status === "delivered");
    expect(next.turns(a.id).findIndex((x) => x.prompt.includes("새 일"))).toBeGreaterThan(next.turns(a.id).indexOf(resumed));
    expect(noLimitMark(next, a.id)).toEqual(CLEAR);
    next.core.intercept(null);
  }, 40_000);

  // S1 의 다른 반쪽: 다시 열기(대표의 깨우기 등)는 한도 보류 중인 팀장의 표시를 지우지 않는다. 한도 그룹에서 실제로 풀릴 때만 지운다.
  test("한도로 멈춘 뒤 재운 팀장을 대표가 직접 깨워도 한도 표시(막힘 사유·오류 글·관측)와 보류는 남는다", async () => {
    const t = await setup();
    const a = await worker(t, "발표 준비", "deck");
    await limitByError(t, a);
    expect(await t.orch.sleepMember(a.id)).toMatchObject({ status: "asleep" });
    const waiting = (await t.orch.assign(t.project.id, a.handle, { text: "새 일 @fake:post=새일끝" })).delivery.id;
    const reopened = await t.orch.resumeMember(a.id);
    expect(reopened.sessionId).toBe(a.sessionId);
    expect(t.runs(a.id).at(-1)!.resumeFlag).toBe(a.sessionId);
    await Bun.sleep(QUIET_MS);
    expect(t.member(a.id)).toMatchObject({ blockedReason: "usage_limit", lastError: USAGE_WAIT_NOTE, statusObservation: { error: { code: "usage_limit" } } });
    expect(t.orch.apiRecovery.usageLimited(a.id)).toBe(true);
    expect(t.store.requireDelivery(waiting)).toMatchObject({ status: "held", holdReason: "usage_limit" });
    expect(card(t)).toMatchObject({ status: "open", usageLimit: { memberIds: [a.id] } });
  }, 40_000);
});
