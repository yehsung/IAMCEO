// 0.2.9: Codex 는 뜨는 동안 스스로 한 번 '일하는 중 → 끝'을 알린다(core 의 turn 1). 새로 띄운 Codex 팀장에게 첫 지시를 넣으려던 실행이
// 그 알림을 제 결과로 읽으면, 넣지도 못한 지시가 '보고 없이 끝난 일'이 되어 '보고 보완' 요청이 첫 지시와 한 묶음으로 들어간다.
// 11-20 실제 Codex 시험: 팀장이 "기존 업무를 다시 실행하지 말라"는 그 글을 따라 일을 하지 않고 막힘으로 보고했다.
// 실제 CoreRunner 틀(tests/fixtures/core-harness.ts): 가짜 core + 실제 CoreRunner + 실제 총괄. 진짜 codex 를 띄우지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions, type FakeCoreCall } from "./fixtures/core-harness.ts";

const CODEX_IDLE = readFileSync(join(import.meta.dir, "fixtures", "cli", "codex", "0.166.0", "idle.txt"), "utf8");
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
async function setup(opts: CoreSetupOptions = {}): Promise<CoreEnv> {
  const t = await coreSetup({ agentTools: TOOLS, ...opts, timings: { ...FAST, ...opts.timings } });
  cleanups.push(() => t.close());
  return t;
}
const nudges = (t: CoreEnv, id: string) => t.store.listDeliveries(t.project.id).filter(d => d.memberId === id && d.text.startsWith("[시스템] 보고 보완"));

const runsOf = (t: CoreEnv, id: string) => t.store.db.query<{ run_id: string; phase: string; result: string | null; reason: string | null; input_received_at: string | null; report_requested_at: string | null }, [string]>(
  "select run_id, phase, result, reason, input_received_at, report_requested_at from execution_journal where member_id = ? order by created_at").all(id);

describe("새로 띄운 Codex 팀장의 첫 지시", () => {
  test("넣는 사이 Codex 가 뜨면서 알린 '일하는 중 → 끝'은 첫 지시의 결과가 아니다: 보고 보완을 묻지 않고, 준비되면 지시만 넣는다", async () => {
    const t = await setup();
    // 실제 순서(11-20): 막 뜬 Codex 가 쉬는 중으로 보여 서버가 첫 지시를 넣기 시작했고, 그 사이 Codex 가 MCP 서버를 올리며
    // 일하는 중(turn 1)을 알렸다가 끝냈다. 엔진은 상태가 바뀌었다며 그 넣기를 거절했다.
    let held: FakeCoreCall | null = null;
    t.core.intercept(call => {
      if (call.method !== "terminal.send" || held) return undefined;
      held = call;
      return "drop";
    });
    const adding = t.orch.addMember(t.project.id, { name: "랜딩 페이지", handle: "landing", role: "랜딩 페이지 구현", cli: "codex",
      firstInstruction: "랜딩 페이지를 만들고 보고하세요" });
    const member = await t.waitFor("명부", () => t.store.listMembers(t.project.id).find(m => m.handle === "landing"));
    const terminal = await t.waitFor("터미널", () => t.core.terminalOf(member.id));
    t.core.setScreen(member.id, CODEX_IDLE);
    const sent = await t.waitFor("넣기 시작", () => held, 8000);
    terminal.status = { state: "working", app: "codex" };
    await Bun.sleep(400);
    terminal.turn = 1; terminal.status = { state: "done", app: "codex" };
    await Bun.sleep(400);
    // 턴 끝 뒤의 '쉬는 중'(더 뒤의 턴 번호)도 이 실행을 닫지 않는다.
    terminal.status = { state: "idle", app: "codex" };
    await Bun.sleep(400);
    // 넣지 못한 지시를 '보고 없이 끝난 일'로 치지 않았다. 뜨면서 돈 턴은 이 팀장의 '턴 끝'으로도 남기지 않는다.
    expect(t.core.turns(member.id)).toHaveLength(0);
    expect(nudges(t, member.id)).toHaveLength(0);
    expect(runsOf(t, member.id).filter(run => run.result === "success")).toHaveLength(0);
    expect(t.store.listActivity(member.id, 200).map(a => a.textCode)).not.toContain("activity.missing_report_requested");
    expect(t.store.listActivity(member.id, 200).map(a => a.textCode)).not.toContain("activity.turn_end");
    // 엔진이 그 넣기를 거절한다. 실행 기록은 '넣지 못함'으로 남는다.
    t.core.intercept(null);
    expect(t.core.answer(sent, { error: { kind: "status_mismatch", message: "status changed" } })).toBe(true);
    await adding;
    expect(runsOf(t, member.id).filter(run => run.result === "success")).toHaveLength(0);
    expect(nudges(t, member.id)).toHaveLength(0);
    // 준비되면 첫 지시만 들어간다.
    terminal.status = { state: "idle", app: "codex" };
    const turn = await t.waitFor("첫 턴", () => t.core.turns(member.id)[0], 8000);
    expect(turn.prompt).toContain("랜딩 페이지를 만들고 보고하세요");
    expect(turn.prompt).not.toContain("보고 보완");
    expect(t.core.turns(member.id).filter(item => item.prompt.includes("랜딩 페이지를 만들고 보고하세요"))).toHaveLength(1);
  }, 30_000);

  /** Codex 팀장을 띄우고 첫 지시의 넣기(terminal.send)를 엔진에서 붙잡아 둔다. */
  async function heldFirstSend(t: CoreEnv) {
    let held: FakeCoreCall | null = null;
    t.core.intercept(call => {
      if (call.method !== "terminal.send" || held) return undefined;
      held = call;
      return "drop";
    });
    const adding = t.orch.addMember(t.project.id, { name: "랜딩 페이지", handle: "landing", role: "랜딩 페이지 구현", cli: "codex",
      firstInstruction: "랜딩 페이지를 만들고 보고하세요" });
    const member = await t.waitFor("명부", () => t.store.listMembers(t.project.id).find(m => m.handle === "landing"));
    const terminal = await t.waitFor("터미널", () => t.core.terminalOf(member.id));
    t.core.setScreen(member.id, CODEX_IDLE);
    const sent = await t.waitFor("넣기 시작", () => held, 8000);
    t.core.intercept(null);
    return { adding, member, terminal, sent };
  }

  test("넣은 글로 시작한 턴이 쓰기 답보다 먼저 끝나도 그 실행은 닫힌다(보고가 없으면 지금처럼 보고 보완을 묻는다)", async () => {
    const t = await setup();
    const { adding, member, terminal, sent } = await heldFirstSend(t);
    // 글은 들어갔고(엔진의 답만 늦다) CLI 가 그 글로 턴을 돌려 끝냈다: 쓴 순간의 번호는 0, 끝난 턴은 1.
    terminal.status = { state: "working", app: "codex" };
    await Bun.sleep(300);
    terminal.turn = 1; terminal.status = { state: "done", app: "codex" };
    await Bun.sleep(400);
    expect(nudges(t, member.id)).toHaveLength(0);
    expect(t.core.answer(sent, { result: { turn: 0, started: true } })).toBe(true);
    await adding;
    // 입력칸이 보이기 전에 넣으려다 만 실행(넣지 못함)이 앞에 있을 수 있다. 글이 들어간 실행을 본다.
    const run = await t.waitFor("실행 닫힘", () => runsOf(t, member.id).find(item => item.phase === "ended" && item.input_received_at !== null));
    expect(run).toMatchObject({ result: "success" });
    await t.waitFor("보고 보완", () => nudges(t, member.id).length === 1);
  }, 30_000);

  test("뜨면서 돈 턴이 끝난 뒤에 글이 들어갔으면 그 턴 끝으로 닫지 않는다. 그 글이 연 턴이 끝날 때 닫는다", async () => {
    const t = await setup();
    const { adding, member, terminal, sent } = await heldFirstSend(t);
    // 뜨면서 돈 턴(1)이 끝난 뒤에 글이 들어갔다: 쓴 순간의 번호가 1 이다.
    terminal.status = { state: "working", app: "codex" };
    await Bun.sleep(300);
    terminal.turn = 1; terminal.status = { state: "done", app: "codex" };
    await Bun.sleep(400);
    terminal.status = { state: "working", app: "codex" };
    expect(t.core.answer(sent, { result: { turn: 1, started: true } })).toBe(true);
    await adding;
    await Bun.sleep(400);
    expect(runsOf(t, member.id).filter(item => item.phase === "ended" && item.input_received_at !== null)).toHaveLength(0);
    expect(runsOf(t, member.id).filter(item => item.result === "success")).toHaveLength(0);
    expect(nudges(t, member.id)).toHaveLength(0);
    // 그 글이 연 턴(2)이 끝난다.
    terminal.turn = 2; terminal.status = { state: "done", app: "codex" };
    const run = await t.waitFor("실행 닫힘", () => runsOf(t, member.id).find(item => item.phase === "ended" && item.input_received_at !== null));
    expect(run).toMatchObject({ result: "success" });
  }, 30_000);
});
