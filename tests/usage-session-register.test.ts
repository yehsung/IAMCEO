// 0.2.7 D4-9: 처음 보는 세션의 누적값은 기준값으로만 삼는다(usage.ts). 그래서 서버가 새로 띄운 세션은 띄울 때 '0 에서 시작'으로 적어,
// 그 세션의 첫 몫이 빠지지 않게 한다. 이어 연 세션(--resume)은 이미 본 세션이라 다시 적지 않는다.
import { afterEach, expect, test } from "bun:test";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import { coreSetup } from "./fixtures/core-harness.ts";

const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
    return { text: "모르는 도구", isError: true };
  },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

test("새로 띄운 세션은 사용량 장부에 0 에서 시작으로 적히고, 깨워 이어 연 세션은 다시 적지 않는다", async () => {
  const t = await coreSetup({ agentTools: TOOLS });
  cleanups.push(() => t.close());
  const member = (await t.orch.addMember(t.project.id, { name: "결제 연동", handle: "pay", role: "개발" })).member;
  t.core.setStatus(member.id, { state: "idle" });
  await t.orch.assign(t.project.id, "pay", { text: "준비 @fake:post=준비" });
  await t.waitFor("준비", () => t.texts().some((m) => m.title === "준비"));
  await t.idle(member.id);
  const sessionId = t.member(member.id).sessionId!;
  expect(sessionId).toBeTruthy();
  const row = () => t.db.query("SELECT member_id, cost_usd, input_tokens, output_tokens, sample_at FROM usage_sessions WHERE provider = 'claude' AND session_id = ?").get(sessionId);
  expect(row()).toEqual({ member_id: member.id, cost_usd: 0, input_tokens: 0, output_tokens: 0, sample_at: 0 });
  // 장부가 그 세션을 본 뒤(기준값이 0 이 아니다) 재우고 깨워 같은 세션을 이어 열어도 기준값을 되돌리지 않는다.
  t.db.query("UPDATE usage_sessions SET cost_usd = 3.5, sample_at = 1 WHERE session_id = ?").run(sessionId);
  await t.orch.sleepMember(member.id);
  await t.orch.resumeMember(member.id);
  await t.waitFor("깨어남", () => t.member(member.id).status === "idle" && t.member(member.id));
  expect(t.member(member.id).sessionId).toBe(sessionId);
  expect(row()).toMatchObject({ cost_usd: 3.5, sample_at: 1 });
  expect(t.db.query("SELECT count(*) AS n FROM usage_sessions").get()).toEqual({ n: 1 });
});
