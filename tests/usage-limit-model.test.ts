// 사용 한도로 멈춘 팀장의 모델을 바꿔 같은 세션을 이어 연다(2026-11-13 라이브).
// Fable 을 쓰던 팀장 셋이 한도에 걸린 뒤 대표가 "모델 오푸스로 바꿔서 이어서 해"라고 했다. 총괄에게는 있는 팀장의 모델을 바꾸는 도구가 없었고,
// 앱의 설정 변경도, 재우기도 "실행 중인 일이나 미해결 입력이 있어 닫지 않았습니다"(409)로 거절됐다. 총괄은 오푸스 팀장을 새로 띄웠고 원래 셋은 오류 표시를 단 채 남았다.
// 실제 CoreRunner 틀(tests/fixtures/core-harness.ts)로 본다: 가짜 core + 실제 CoreRunner + 실제 총괄 + 실제 HTTP 서버.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentTool } from "../server/agent-tools.ts";
import { usageModelResumeText } from "../server/api-outage.ts";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import type { DecisionOption, Member } from "../shared/types.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions, type FakeRun } from "./fixtures/core-harness.ts";

const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
    if (name === "ask") return { text: (await orch.registerAsk(member, args as { title: string; detail?: string; options?: DecisionOption[] })).text };
    return { text: "모르는 도구", isError: true };
  },
};

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => { await Promise.all(cleanups.map((c) => c().catch(() => {}))); });

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
    await expect(t.orch.sleepMember(b.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("입력칸에 글이 남아") });
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
  expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 409, body: { error: "일하거나 세션을 처리하는 중입니다. 턴이 끝난 뒤 CLI를 바꾸세요" } });
  expect(t.member(w.id).modelOverride).toBe(FABLE);
  expect(t.runs(w.id)).toHaveLength(1);
  t.core.release(w.id);
  await t.idle(w.id);
  expect((await changeModel(t, w.id, "opus")).status).toBe(200);
  expect({ resume: t.runs(w.id).at(-1)!.resumeFlag, model: flag(t.runs(w.id).at(-1)!, "--model") }).toEqual({ resume: w.sessionId, model: "opus" });
  expect(t.store.listDeliveries(t.project.id).filter((d) => d.text.includes(RESUME_LEAD))).toHaveLength(0);
  expect(t.core.keys).toEqual([]);
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
    expect(limitCard.detail.split("\n\n")[0]).toBe("Fable 5.2 사용 크레딧이 떨어졌습니다. 다른 모델로 바꾸면 바로 이어 갑니다. 기다리면 크레딧이 채워질 때 자동으로 이어 갑니다. 바로 이어 가려면 다른 모델을 고르세요. 다른 계정으로 로그인했거나 한도를 늘렸다면 '이어가기'를 누르세요.");
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
      expect({ choice, status: res.status }).toEqual({ choice, status: 400 });
    }
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
});
