// 0.2.11: CLI 를 새 판으로 올린 뒤 그 CLI 로 떠 있는 총괄·팀장을 쉬는 때에 같은 대화로 다시 연다(Orchestrator.cliUpdated).
// 0.2.8 의 '설정·계정이 바뀐 뒤 다음에 쉴 때 같은 대화로 다시 열기' 길(configPending → syncConfig)을 그대로 쓴다. 새 세션을 만들지 않는다.
// 실제 CoreRunner 틀(tests/fixtures/core-harness.ts): 가짜 core + 실제 CoreRunner + 실제 총괄. 진짜 claude·codex 를 띄우지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import type { Member } from "../shared/types.ts";
import { coreSetup, type CoreEnv } from "./fixtures/core-harness.ts";

const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
    return { text: "모르는 도구", isError: true };
  },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close().catch(() => {}); });

const FAST = { tickMs: 150, healthMs: 40, retryMs: 30, inputBusyRetryMs: 30, writeSettleMs: 40, startGraceMs: 200, blockedNoticeMs: 60 };
const QUIET_MS = 700;

async function setup(): Promise<CoreEnv> {
  const t = await coreSetup({ agentTools: TOOLS, timings: FAST });
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

describe("CLI 새 판이 깔린 뒤", () => {
  test("쉬는 팀장은 곧바로, 일하는 팀장은 턴이 끝난 뒤 같은 대화를 새 판으로 다시 연다. 인계 글 없이 활동 한 줄, 남은 수가 줄어든다", async () => {
    const t = await setup();
    const idle = await worker(t, "문서 정리", "docs");
    const busy = await worker(t, "화면 개발", "ui");
    const idleRuns = t.runs(idle.id).length, busyRuns = t.runs(busy.id).length;
    await t.orch.assign(t.project.id, busy.handle, { text: "긴 일 @fake:hold" });
    await t.waitFor("일하는 중", () => t.core.held(busy.id));
    expect(t.orch.cliUpdateStatus("claude").pending).toBe(0);
    const live = t.orch.cliUpdateStatus("claude").live;
    expect(live).toBeGreaterThanOrEqual(2);

    const result = await t.orch.cliUpdated("claude");
    expect(result.atNextTurn).toBeGreaterThanOrEqual(2);
    expect(t.store.loadApiRecovery<Record<string, number>>("cli_update_epochs")).toEqual({ claude: 1 });
    // 쉬는 팀장: 같은 세션을 이어 연다(--resume). 새 세션이 아니다.
    await t.waitFor("쉬는 팀장 다시 열림", () => t.runs(idle.id).length === idleRuns + 1);
    expect(t.runs(idle.id).at(-1)!.resumeFlag).toBe(idle.sessionId);
    await t.waitFor("활동 줄", () => activityCodes(t, idle.id).includes("activity.cli_update_reopen"));
    expect(t.store.getAppliedConfig(idle.id)?.cliUpdate).toBe(1);
    expect(t.member(idle.id).sessionId).toBe(idle.sessionId);
    // 일하는 팀장은 그 턴을 끊지 않는다. 아직 남은 수에 든다.
    await Bun.sleep(QUIET_MS);
    expect(t.runs(busy.id)).toHaveLength(busyRuns);
    expect(t.orch.cliUpdateStatus("claude").pending).toBeGreaterThanOrEqual(1);
    t.core.release(busy.id);
    await t.waitFor("턴이 끝난 뒤 다시 열림", () => t.runs(busy.id).length === busyRuns + 1, 20_000);
    expect(t.runs(busy.id).at(-1)!.resumeFlag).toBe(busy.sessionId);
    await t.idle(idle.id); await t.idle(busy.id);
    await t.waitFor("모두 새 판으로", () => t.orch.cliUpdateStatus("claude").pending === 0, 20_000);
    // 설정 변경 인계 글을 붙이지 않는다(같은 대화를 같은 설정으로 이어 연 것뿐이다).
    expect(t.store.listDeliveries(t.project.id).filter(d => [idle.id, busy.id].includes(d.memberId) && /설정 변경|같은 세션을 새 설정으로/.test(d.text))).toEqual([]);

    // 다시 연 세션은 지금 세대로 떴다: 한 번 더 열지 않는다. 다른 CLI 의 업데이트는 Claude 팀장을 다시 열지 않는다.
    await Bun.sleep(QUIET_MS);
    expect(t.runs(idle.id)).toHaveLength(idleRuns + 1);
    expect((await t.orch.cliUpdated("codex")).atNextTurn).toBe(0);
    await Bun.sleep(QUIET_MS);
    expect(t.runs(idle.id)).toHaveLength(idleRuns + 1);
    expect(t.store.loadApiRecovery<Record<string, number>>("cli_update_epochs")).toEqual({ claude: 1, codex: 1 });
  }, 60_000);

  test("잠든 팀장은 깨우지 않고 남은 수에도 넣지 않는다. 깨우면 새 판 세대로 뜬다", async () => {
    const t = await setup();
    const w = await worker(t, "발표 준비", "deck");
    await t.orch.sleepMember(w.id, { force: true });
    await t.waitFor("잠듦", () => t.member(w.id).status === "asleep");
    const runsBefore = t.runs(w.id).length;
    await t.orch.cliUpdated("claude");
    await Bun.sleep(QUIET_MS);
    expect(t.runs(w.id)).toHaveLength(runsBefore);
    expect(t.member(w.id).status).toBe("asleep");
    await t.waitFor("깨어 있는 팀장만 남음", () => t.orch.cliUpdateStatus("claude").pending === 0, 20_000);
    await t.orch.resumeMember(w.id);
    await t.waitFor("깨움", () => t.runs(w.id).length === runsBefore + 1);
    await t.idle(w.id);
    expect(t.store.getAppliedConfig(w.id)?.cliUpdate).toBe(1);
    await Bun.sleep(QUIET_MS);
    expect(t.runs(w.id)).toHaveLength(runsBefore + 1);
  }, 60_000);
});
