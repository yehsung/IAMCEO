// 0.2.7 D2-7: Codex 팀장을 새로 띄운 직후 입력칸 인식 실패('Cannot identify an empty CLI composer')로 넣기가 4~5번 되풀이되고
// 실패 실행 기록이 쌓였다(11-15 새로 띄운 Codex 팀장: 오류 실행 4건, 시도 5번, 18초 뒤 전달). CLI 가 쉬는 중을 알렸지만 화면에 입력칸을 아직 그리지 않았다.
// 이제 화면에서 입력칸을 알아볼 수 있을 때까지(실행기가 input_ready 로 알린다) 넣지 않고 기다렸다가 한 번에 넣는다. 오래 이어지면 예전처럼 보류한다.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexDraft } from "../server/runner/core.ts";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import type { Member } from "../shared/types.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions } from "./fixtures/core-harness.ts";

const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
    return { text: "모르는 도구", isError: true };
  },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(opts: CoreSetupOptions = {}) {
  const t = await coreSetup({ agentTools: TOOLS, ...opts });
  cleanups.push(() => t.close());
  return t;
}
async function awake(t: CoreEnv): Promise<Member> {
  const member = (await t.orch.addMember(t.project.id, { name: "자료 조사", handle: "research", role: "조사" })).member;
  t.core.setStatus(member.id, { state: "idle" });
  await t.orch.assign(t.project.id, "research", { text: "준비 @fake:post=준비" });
  await t.waitFor("준비", () => t.texts().some((m) => m.title === "준비"));
  await t.idle(member.id);
  return t.member(member.id);
}
/** 쉬는 중을 알렸지만 아직 입력칸을 그리지 않은 화면(Codex 가 시작 화면을 그리는 중). */
const DRAWING = "OpenAI Codex (v0.166.0)\n\n  model: gpt-6.1   /model to change\n  directory: ~/work\n\n  Starting MCP servers (1/2)…\n";
/**
 * Codex 0.166.0 의 실측 첫 화면(tests/fixtures/cli/codex/0.166.0/idle.txt, 빈 입력칸). 그리는 중 화면은 같은 첫 화면에서 입력칸 줄을 아직 그리지 않은 모양이다
 * (머리 상자만 있다). 실제 사례: 새로 띄운 Codex 팀장이 쉬는 중을 알린 직후 첫 지시를 넣다가 'Cannot identify an empty CLI composer' 로 4번 실패.
 */
const CODEX_READY = readFileSync(join(import.meta.dir, "fixtures", "cli", "codex", "0.166.0", "idle.txt"), "utf8");
const CODEX_STARTING = CODEX_READY.slice(0, CODEX_READY.indexOf("╰")) + CODEX_READY.slice(CODEX_READY.indexOf("╰")).split("\n")[0] + "\n";
const errorRuns = (t: CoreEnv, memberId: string) => t.db.query<{ reason: string }, [string]>("SELECT reason FROM execution_journal WHERE member_id = ? AND result = 'error'").all(memberId);
const composerUnknown = (t: CoreEnv, memberId: string) => (t.runner as unknown as { composerUnidentified(id: string): boolean }).composerUnidentified(memberId);

describe("입력칸이 그려질 때까지 기다렸다가 한 번에 넣는다 (D2-7)", () => {
  test("입력칸이 안 보이는 동안 넣지 않고(실패 실행·시도 없음), 입력칸이 보이면 곧바로 한 번에 넣는다", async () => {
    const t = await setup();
    const m = await awake(t);
    t.core.setScreen(m.id, DRAWING);
    await t.waitFor("입력칸 못 알아봄", () => composerUnknown(t, m.id));
    const turns = t.turns(m.id).length;
    const delivery = (await t.orch.assign(t.project.id, "research", { text: "새 조사 @fake:post=조사끝" })).delivery!;
    await Bun.sleep(400);
    expect(t.turns(m.id)).toHaveLength(turns);
    expect(t.store.requireDelivery(delivery.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(errorRuns(t, m.id)).toEqual([]);
    // 입력칸이 그려졌다: 실행기가 화면으로 알아보고 미뤄 둔 전달을 민다.
    t.core.setScreen(m.id, null);
    await t.waitFor("전달", () => t.store.requireDelivery(delivery.id).status === "delivered");
    await t.waitFor("보고", () => t.texts().some((x) => x.title === "조사끝"));
    expect(t.store.requireDelivery(delivery.id).attempts).toBe(1);
    expect(t.turns(m.id)).toHaveLength(turns + 1);
    expect(errorRuns(t, m.id)).toEqual([]);
  });

  test("새 Codex 팀장: 첫 시작 직후 쉬는 중을 알렸어도 입력칸(codexDraft)을 그리기 전에는 넣지 않고, 그리면 한 번에 넣는다", async () => {
    // 견본이 실제로 Codex 판독 경로를 탄다: 그리는 중은 입력칸을 못 알아보고(null), 다 그린 화면은 빈 입력칸("")이다.
    expect(codexDraft(CODEX_STARTING)).toBeNull();
    expect(codexDraft(CODEX_READY)).toBe("");
    const t = await setup();
    // 새 팀장을 띄운다(첫 시작). 가짜 엔진은 띄우자마자 쉬는 중을 알린다(실제 Codex 처럼 입력칸보다 먼저).
    const m = await t.orch.createMember(t.project.id, { name: "자료 조사", cli: "codex" });
    t.core.setScreen(m.id, CODEX_STARTING);
    expect(t.member(m.id).cli).toBe("codex");
    await t.waitFor("입력칸 못 알아봄", () => composerUnknown(t, m.id));
    const delivery = (await t.orch.assign(t.project.id, m.handle, { text: "첫 조사" })).delivery!;
    // 펌프가 입력칸을 기다린다고 판정한 뒤(긍정 신호)에도 몇 번의 다시 보기 동안 넣지 않는다.
    await t.waitFor("입력칸 대기 판정", () => t.store.pumpVerdict(m.id)?.code === "waking");
    await Bun.sleep(400);
    expect(t.core.turns(m.id)).toHaveLength(0);
    expect(t.core.calls.filter((c) => c.method === "terminal.send")).toHaveLength(0);
    expect(t.store.requireDelivery(delivery.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(errorRuns(t, m.id)).toEqual([]);
    // 입력칸이 그려졌다: 실행기가 Codex 화면 판독으로 알아보고(input_ready) 미뤄 둔 전달을 한 번에 넣는다.
    t.core.setScreen(m.id, CODEX_READY);
    await t.waitFor("넣음", () => t.core.turns(m.id).length === 1);
    await t.waitFor("시도 1", () => t.store.requireDelivery(delivery.id).attempts === 1);
    expect(t.core.turns(m.id)[0]!.prompt).toContain("첫 조사");
    expect(errorRuns(t, m.id)).toEqual([]);
  });

  test("끝내 입력칸이 보이지 않으면 실패 실행 없이 예전처럼 '입력칸에 넣지 못함'으로 보류한다", async () => {
    const t = await setup({ timings: { inputBusyLimitMs: 300, inputBusyRetryMs: 50 } });
    const m = await awake(t);
    t.core.setScreen(m.id, DRAWING);
    await t.waitFor("입력칸 못 알아봄", () => composerUnknown(t, m.id));
    const delivery = (await t.orch.assign(t.project.id, "research", { text: "새 조사" })).delivery!;
    await t.waitFor("보류", () => t.store.requireDelivery(delivery.id).status === "held");
    expect(t.store.requireDelivery(delivery.id)).toMatchObject({ holdReason: "input_busy", attempts: 0 });
    expect(errorRuns(t, m.id)).toEqual([]);
  });
});
