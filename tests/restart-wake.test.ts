// 재시작(Mac 또는 실행 엔진)으로 꺼진 팀장을 서버가 스스로 다시 연다(server/restart-wake.ts, Orchestrator 의 kickRestartWakes).
// 2026-11-12 실측: Mac 을 다시 시작하자 깨어 있던 팀장 19명이 모두 꺼졌고, 대표나 총괄이 말을 걸 때까지 꺼진 채였다.
// 운영과 같은 틀로 돈다: 가짜 엔진 소켓 + 실제 CoreRunner + 운영 배선의 총괄 + 실제 HTTP 서버.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import { RESTART_REOPENED_NOTE, RESTART_RESUME_TEXT } from "../server/restart-wake.ts";
import type { DecisionOption, Member } from "../shared/types.ts";
import { appendFileSync } from "node:fs";
import { transcriptPath } from "../server/runner/transcript.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions, type FakeTurnContext } from "./fixtures/core-harness.ts";

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
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function setup(opts: CoreSetupOptions = {}) {
  const t = await coreSetup({ agentTools: TOOLS, ...opts });
  cleanups.push(() => t.close());
  return t;
}
/** 서버를 내렸다가 같은 홈·같은 엔진에 다시 띄운다(운영의 재시작). */
async function restart(t: CoreEnv, opts: Omit<CoreSetupOptions, "home" | "core" | "projectId"> = {}) {
  const next = await t.restart(opts);
  cleanups.push(() => next.close());
  return next;
}

/** 깨어 있고 쉬는 팀장. 턴을 한 번 돌려 세션 기록이 있다(없으면 이어 열 것이 없어 새 세션이 된다). */
async function awake(t: CoreEnv, name: string, handle: string, projectId = t.project.id): Promise<Member> {
  const member = (await t.orch.addMember(projectId, { name, handle, role: "개발" })).member;
  t.core.setStatus(member.id, { state: "idle" }); // 준비를 알리지 않는 CLI 로 띄운 시험(startState null)에서도 첫 턴이 돌게 한다.
  await t.orch.assign(projectId, handle, { text: `준비 @fake:post=${handle}준비` });
  await t.waitFor(`${name} 준비`, () => t.texts(projectId).some((m) => m.title === `${handle}준비`));
  await t.idle(member.id);
  return t.member(member.id);
}
/** 일하는 중인 팀장(끝나지 않는 턴). */
async function working(t: CoreEnv, name: string, handle: string): Promise<Member> {
  const member = (await t.orch.addMember(t.project.id, { name, handle, role: "개발" })).member;
  await t.orch.assign(t.project.id, handle, { text: "큰 일 @fake:hold" });
  await t.waitFor(`${name} 일하는 중`, () => t.core.held(member.id) && t.member(member.id).status === "working");
  return t.member(member.id);
}
/** 이어 연 기록(--resume 으로 띄운 것)만. */
const resumed = (t: CoreEnv, memberId?: string) => t.runs(memberId).filter((run) => run.resumeFlag !== null);
/** 이어가기 글로 시작한 턴. 전달 글 뒤에 수신 표지가 붙으므로 앞머리로 가린다. */
const resumeTurns = (t: CoreEnv, memberId: string) => t.turns(memberId).filter((turn) => turn.prompt.startsWith(RESTART_RESUME_TEXT));
const reopenNotes = (t: CoreEnv, memberId: string) => t.store.listActivity(memberId).filter((a) => a.text === RESTART_REOPENED_NOTE);
const terminalRuns = (t: CoreEnv, memberId: string) => t.core.calls.filter((c) => c.method === "terminal.run" && c.params.labels?.["iamceo.member"] === memberId).length;
const refuseRun = (t: CoreEnv, memberId: string) => t.core.intercept((call) => call.method === "terminal.run" && call.params.labels?.["iamceo.member"] === memberId ? { error: { kind: "invalid", message: "터미널을 만들지 못함" } } : undefined);
/** 이어가기 글을 받으면 보고하고 끝내는 가짜 CLI. gate 를 주면 그것이 풀릴 때까지 일하는 중으로 남는다. */
const continues = (title: string, gate?: Promise<void>) => async (ctx: FakeTurnContext) => {
  if (!ctx.prompt.startsWith(RESTART_RESUME_TEXT)) return false;
  await gate;
  await ctx.tool("post", { kind: "완료", title });
  return true;
};

describe("재시작으로 꺼진 팀장 다시 열기", () => {
  test("깨어 있던 팀장 여럿이 재시작으로 꺼지면 다시 뜬 서버가 입력 없이 같은 세션을 이어 열고, 잠든 팀장은 그대로 잔다", async () => {
    const t = await setup();
    const a = await awake(t, "결제 연동", "pay"), b = await awake(t, "검색 개선", "search"), c = await awake(t, "문서 정리", "docs");
    await t.orch.sleepMember(c.id);
    const turns = t.turns().length;
    // Mac 을 껐다 켰다: 서버도 터미널도 사라진다. 엔진은 두 가지 사유로 알린다.
    await t.stopServer();
    t.core.exit(a.id, 1, "holder_lost");
    t.core.exit(b.id, 1, "stopped_by_restart");
    const next = await restart(t);
    for (const before of [a, b]) {
      await next.waitFor(`${before.name} 다시 열림`, () => next.member(before.id).status === "idle" && !next.store.getRestartWake(before.id));
      const now = next.member(before.id);
      // 같은 세션을 새 터미널에 이어 연다. 꺼졌다는 안내(lastError)는 지운다.
      expect(now).toMatchObject({ status: "idle", sessionId: before.sessionId, lastError: null });
      expect(now.paneId).not.toBe(before.paneId);
      expect(now.paneId).toBe(next.core.terminalOf(before.id)!.address);
      expect(next.runs(before.id).map((run) => [run.sessionFlag, run.resumeFlag])).toEqual([[before.sessionId, null], [null, before.sessionId]]);
      expect(reopenNotes(next, before.id).map((x) => x.kind)).toEqual(["system"]);
    }
    // 입력은 넣지 않는다: 쉬던 팀장에게는 이어가기 글도 없다. 끊긴 일이 없으니 대화에 중단 글도 없다.
    await Bun.sleep(150);
    expect(next.turns()).toHaveLength(turns);
    expect(next.store.listDeliveries(next.project.id).some((d) => d.text === RESTART_RESUME_TEXT)).toBe(false);
    expect(next.texts().some((m) => m.kind === "시스템" && m.body.includes("중단"))).toBe(false);
    // 대표가 재운 팀장은 그대로 잔다.
    expect(next.member(c.id).status).toBe("asleep");
    expect(next.runs(c.id)).toHaveLength(1);
    expect(next.store.restartWakes()).toEqual({});
  });

  test("CLI 가 스스로 죽은 팀장, 실행이 꺼진 프로젝트와 보관된 프로젝트의 팀장은 스스로 열지 않는다", async () => {
    const t = await setup();
    const dead = await awake(t, "죽은 세션", "dead");
    const offProject = t.store.createProject({ name: "실행 꺼짐", cwd: t.home });
    const off = await awake(t, "꺼진 프로젝트", "off", offProject.id);
    const keptProject = t.store.createProject({ name: "보관함", cwd: t.home });
    const kept = await awake(t, "보관된 프로젝트", "kept", keptProject.id);
    t.store.patchProject(offProject.id, { runnerEnabled: false });
    t.store.patchProject(keptProject.id, { archived: true });
    await t.stopServer();
    t.core.exit(dead.id, 1); // 종료 코드가 있는 종료: 되풀이해 죽는 세션을 계속 띄우면 안 된다.
    t.core.exit(off.id, 1, "holder_lost");
    t.core.exit(kept.id, 1, "holder_lost");
    const next = await restart(t);
    await next.waitFor("꺼짐 확인", () => next.member(dead.id).status === "offline" && next.member(off.id).status === "offline");
    await Bun.sleep(300);
    expect(next.member(dead.id)).toMatchObject({ status: "offline", paneId: null, lastError: "초기/실행 종료: exited (exit_code=1)" });
    expect(next.member(off.id)).toMatchObject({ status: "offline", paneId: null });
    expect(next.member(off.id).lastError).toContain("다시 시작되어 세션이 꺼졌습니다");
    for (const member of [dead, off, kept]) {
      expect(next.runs(member.id)).toHaveLength(1);
      expect(reopenNotes(next, member.id)).toEqual([]);
    }
    expect(next.store.restartWakes()).toEqual({});
  });

  // 준비를 알리지 않는 CLI 로 띄운다: 방금 연 팀장이 상태를 알릴 때까지 다음 차례로 넘어가지 않는 것을 시험이 손으로 넘긴다.
  test.each([1, 2])("한 번에 %d명씩만 열고, 앞의 팀장이 자리를 잡은 뒤 다음으로 넘어간다. 총괄이 먼저다", async (parallel) => {
    const t = await setup({ fake: { startState: null }, timings: { restartWakeParallel: parallel, restartWakeSettleMs: 60_000 } });
    const workers = [await awake(t, "결제 연동", "pay"), await awake(t, "검색 개선", "search"), await awake(t, "문서 정리", "docs")];
    // 총괄을 팀장들보다 나중에 만든다. 만든 순서가 아니라 총괄이 먼저다.
    const lead = await t.orch.ensureConductor(t.project.id);
    t.core.setStatus(lead.id, { state: "idle" });
    await t.orch.sendUserMessage(t.project.id, { text: "상황을 알려 주세요" });
    await t.waitFor("총괄의 첫 턴", () => t.turns(lead.id).length === 1);
    await t.idle(lead.id);
    await t.stopServer();
    for (const member of [...workers, lead]) t.core.exit(member.id, 1, "holder_lost");
    const next = await restart(t);
    const unsettled = () => resumed(next).filter((run) => !next.core.terminals().find((terminal) => terminal.address === run.terminal)!.status);
    let most = 0;
    for (let opened = parallel; ; opened++) {
      await next.waitFor(`${opened}명째 열림`, () => resumed(next).length >= Math.min(opened, 4));
      // 자리를 잡지 못한 팀장이 상한만큼 있는 동안에는 더 열지 않는다.
      await Bun.sleep(200);
      most = Math.max(most, unsettled().length);
      expect(resumed(next)).toHaveLength(Math.min(opened, 4));
      if (!unsettled().length) break;
      next.core.setStatus(unsettled()[0]!.memberId!, { state: "idle" }); // 가장 먼저 연 팀장이 준비를 알린다.
    }
    expect(most).toBe(parallel);
    expect(resumed(next).map((run) => run.memberId)).toEqual([lead.id, ...workers.map((w) => w.id)]);
    for (const member of [...workers, lead]) expect(reopenNotes(next, member.id)).toHaveLength(1);
  });

  test("다 깨우기 전에 서버가 한 번 더 내려갔다 떠도 남은 팀장이 깨어난다(표식은 재시작을 넘어 남는다)", async () => {
    const t = await setup();
    const members = [await awake(t, "결제 연동", "pay"), await awake(t, "검색 개선", "search"), await awake(t, "문서 정리", "docs")];
    await t.stopServer();
    for (const member of members) t.core.exit(member.id, 1, "holder_lost");
    // 첫 팀장을 연 뒤 다음 차례까지 오래 쉬게 해, 줄이 도는 도중에 서버가 내려가게 한다.
    const first = await restart(t, { timings: { restartWakeGapMs: 60_000 } });
    await first.waitFor("첫 팀장", () => resumed(first).length === 1 && !first.store.getRestartWake(members[0]!.id));
    await Bun.sleep(150);
    expect(resumed(first).map((run) => run.memberId)).toEqual([members[0]!.id]);
    expect(Object.entries(first.store.restartWakes()).map(([id, wake]) => [id, wake.state, wake.reason])).toEqual([[members[1]!.id, "pending", "holder_lost"], [members[2]!.id, "pending", "holder_lost"]]);
    // Mac 이 한 번 더 꺼졌다: 방금 연 팀장도 다시 꺼진다.
    await first.stopServer();
    first.core.exit(members[0]!.id, 1, "holder_lost");
    const second = await restart(first, { timings: {} });
    for (const member of members) await second.waitFor(`${member.name} 다시 열림`, () => second.member(member.id).status === "idle" && second.member(member.id).paneId === second.core.terminalOf(member.id)!.address && second.core.terminalOf(member.id)!.state === "live");
    await second.waitFor("표식 정리", () => Object.keys(second.store.restartWakes()).length === 0);
    // 꺼질 때마다 한 번씩만 연다.
    expect(members.map((member) => resumed(second, member.id).length)).toEqual([2, 1, 1]);
    for (const member of members) expect(second.member(member.id)).toMatchObject({ sessionId: member.sessionId, lastError: null });
  });

  test("이 기능 전에 꺼져 옛 글만 남은 팀장(표식 없음)도 서버가 뜨면 깨어난다", async () => {
    const t = await setup();
    const w = await awake(t, "결제 연동", "pay");
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    // 라이브 DB 에 남아 있는 모습 그대로: 꺼짐(offline), 터미널 없음, 엔진의 내부 낱말이 든 옛 글. 표식은 없다.
    const db = new Database(t.config.dbPath);
    db.query("UPDATE members SET status = 'offline', pane_id = NULL, last_error = ? WHERE id = ?").run("초기/실행 종료: holder_lost (exit_code=unknown)", w.id);
    expect(db.query("SELECT 1 FROM settings WHERE key = 'restartWake'").get()).toBeNull();
    db.close();
    const next = await restart(t);
    await next.waitFor("다시 열림", () => next.member(w.id).status === "idle" && !next.store.getRestartWake(w.id));
    expect(next.member(w.id)).toMatchObject({ sessionId: w.sessionId, lastError: null, paneId: next.core.terminalOf(w.id)!.address });
    expect(resumed(next, w.id).map((run) => run.resumeFlag)).toEqual([w.sessionId]);
    expect(reopenNotes(next, w.id)).toHaveLength(1);
  });

  test("실행 엔진이 서버보다 늦게 뜨면 그동안 기다렸다가, 엔진이 답하기 시작한 뒤에 깨운다", async () => {
    const t = await setup({ timings: { healthMs: 60 } });
    const w = await awake(t, "결제 연동", "pay");
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    await t.core.setRefusing(true); // 부팅 직후: 엔진의 소켓이 아직 없다.
    const next = await restart(t);
    await Bun.sleep(400);
    // 엔진이 답하지 않는 동안에는 꺼졌는지도 모른다. 아무것도 띄우지 않는다.
    expect(resumed(next, w.id)).toEqual([]);
    expect(next.member(w.id).paneId).toBe(w.paneId);
    await next.core.setRefusing(false);
    await next.waitFor("다시 열림", () => next.member(w.id).status === "idle" && next.member(w.id).paneId !== w.paneId && !next.store.getRestartWake(w.id));
    expect(resumed(next, w.id).map((run) => run.resumeFlag)).toEqual([w.sessionId]);
    expect(next.member(w.id).lastError).toBeNull();
    expect(reopenNotes(next, w.id)).toHaveLength(1);
  });

  test("스스로 여는 도중 대표의 말이 다른 꺼진 팀장에게 오면 줄을 기다리지 않고 바로 열려 말을 받는다. 같은 팀장을 두 번 띄우지 않는다", async () => {
    const t = await setup();
    const a = await awake(t, "결제 연동", "pay"), b = await awake(t, "검색 개선", "search"), c = await awake(t, "문서 정리", "docs");
    await t.stopServer();
    for (const member of [a, b, c]) t.core.exit(member.id, 1, "holder_lost");
    // 첫 팀장을 연 뒤 줄이 오래 쉰다: 둘째·셋째는 아직 차례가 아니다.
    const next = await restart(t, { timings: { restartWakeGapMs: 60_000 } });
    await next.waitFor("첫 팀장", () => resumed(next).length === 1);
    expect(next.member(c.id).status).toBe("offline");
    await next.orch.sendUserMessage(next.project.id, { text: "급한 말 @fake:post=급한일끝", targetMemberId: c.id });
    await next.waitFor("급한 말 처리", () => next.texts().some((m) => m.title.includes("급한일끝")));
    expect(next.turns(c.id).at(-1)!.prompt).toContain("급한 말");
    expect(next.turns(c.id).at(-1)!.run.resumeFlag).toBe(c.sessionId);
    // 대표의 말로 열린 팀장도 재시작으로 꺼졌던 것이다. 표식을 닫고 활동에 남긴다. 줄이 뒤에 또 열지 않는다.
    expect(next.store.getRestartWake(c.id)).toBeNull();
    expect(reopenNotes(next, c.id)).toHaveLength(1);
    await Bun.sleep(150);
    expect([a, b, c].map((member) => resumed(next, member.id).length)).toEqual([1, 0, 1]);
    // 둘째는 여전히 제 차례를 기다린다.
    expect(next.member(b.id).status).toBe("offline");
    expect(next.store.getRestartWake(b.id)).toMatchObject({ state: "pending" });
  });

  test("여는 데 실패한 팀장은 한 번만 시도하고 꺼진 채 두며, 다음 팀장으로 넘어간다", async () => {
    const t = await setup();
    const a = await awake(t, "결제 연동", "pay"), b = await awake(t, "검색 개선", "search");
    await t.stopServer();
    for (const member of [a, b]) t.core.exit(member.id, 1, "holder_lost");
    refuseRun(t, a.id);
    const next = await restart(t, { timings: { healthMs: 60 } });
    await next.waitFor("다음 팀장", () => next.member(b.id).status === "idle" && !next.store.getRestartWake(b.id));
    expect(resumed(next, b.id)).toHaveLength(1);
    // 꺼진 채 기존 오류 안내를 남긴다.
    expect(next.member(a.id)).toMatchObject({ status: "offline", paneId: null });
    expect(next.member(a.id).lastError).toContain("터미널을 만들지 못함");
    expect(next.store.getRestartWake(a.id)).toMatchObject({ state: "failed", attempts: 1 });
    // 실행기 상태를 여러 번 다시 봐도(60ms 간격), 서버를 또 재시작해도 스스로는 다시 시도하지 않는다.
    await Bun.sleep(400);
    expect(terminalRuns(next, a.id)).toBe(2); // 처음 띄운 것 + 실패한 시도 한 번
    const again = await restart(next, { timings: { healthMs: 60 } });
    await Bun.sleep(400);
    expect(terminalRuns(again, a.id)).toBe(2);
    expect(again.member(a.id).status).toBe("offline");
    // 대표가 깨우면 바로 다시 열린다.
    again.core.intercept(null);
    await again.orch.resumeMember(a.id);
    expect(again.member(a.id)).toMatchObject({ status: "idle", sessionId: a.sessionId, lastError: null });
    expect(again.store.getRestartWake(a.id)).toBeNull();
  });
});

describe("재시작으로 끊긴 일 이어가기", () => {
  test("일하던 중 꺼진 팀장은 다시 열린 뒤 이어가기 글을 한 번 받아 턴을 돌고 보고한다. 총괄은 깨어나지 않고 소식만 받는다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const w = await working(t, "결제 연동", "pay");
    const runId = t.member(w.id).executionState!.runId;
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const next = await restart(t, { onTurn: continues("이어서끝", gate) });
    await next.waitFor("이어가기 턴", () => resumeTurns(next, w.id).length === 1);
    // 원래 지시를 다시 넣지 않는다. 같은 세션을 이어 연 터미널에 이어가기 글만 들어간다.
    expect(resumeTurns(next, w.id)[0]!.prompt).not.toContain("큰 일");
    expect(resumeTurns(next, w.id)[0]!.run.resumeFlag).toBe(w.sessionId);
    expect(next.store.getExecutionJournal(runId)).toMatchObject({ phase: "interrupted", result: "interrupted", reason: "holder_lost" });
    expect(next.store.getExecutionJournal(runId)!.interruptionNotifiedAt).not.toBeNull();
    // 대표에게 보이는 대화: 중단이 아니라 이어서 하게 했다는 사실.
    const system = next.texts().filter((m) => m.kind === "시스템").map((m) => m.body);
    expect(system.filter((body) => body.includes("재시작으로 끊겨 이어서 하게 했습니다"))).toEqual([`결제 연동: 실행 ${runId} — 재시작으로 끊겨 이어서 하게 했습니다`]);
    expect(system.some((body) => body.includes("중단"))).toBe(false);
    // 총괄은 깨우지 않는 소식만 받는다(같은 일을 또 맡기지 않게).
    const news = next.store.listPending(lead.id);
    expect(news.map((d) => [d.wake, d.kind])).toEqual([[false, "system"]]);
    expect(news[0]!.text).toContain("다시 지시하지 마세요");
    expect(news[0]!.text).not.toContain("중단되었습니다");
    expect(next.turns(lead.id)).toEqual([]);
    finish();
    await next.waitFor("이어서 한 일의 보고", () => next.texts().some((m) => m.title === "이어서끝"));
    // 팀장의 보고가 총괄을 깨우고, 소식은 그 턴에 함께 들어간다.
    await next.waitFor("총괄이 보고를 받음", () => next.turns(lead.id).length === 1);
    expect(next.turns(lead.id)[0]!.prompt).toContain("이어서끝");
    expect(next.turns(lead.id)[0]!.prompt).toContain("다시 지시하지 마세요");
    await next.idle(w.id);
    expect(resumeTurns(next, w.id)).toHaveLength(1);
    expect(reopenNotes(next, w.id)).toHaveLength(1);
    expect(next.store.listDeliveries(next.project.id).filter((d) => d.text === RESTART_RESUME_TEXT).map((d) => d.status)).toEqual(["delivered"]);
  });

  test("이어가기 글은 실행마다 한 번이다: 넣기 전에 서버가 또 재시작해도 두 번 만들지 않는다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const w = await working(t, "결제 연동", "pay");
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    // 다시 연 CLI 가 이어가기 글을 아직 받지 못한다(입력을 거절한다).
    t.core.intercept((call) => call.method === "terminal.send" && String(call.params.text).startsWith(RESTART_RESUME_TEXT) ? { error: { kind: "busy", message: "CLI is working" } } : undefined);
    const first = await restart(t, { timings: { retryMs: 30, inputBusyRetryMs: 30 } });
    await first.waitFor("이어가기 글이 줄에 섬", () => first.store.listPending(w.id).some((d) => d.text === RESTART_RESUME_TEXT) && first.store.getRestartWake(w.id)?.state === "resumed");
    expect(resumeTurns(first, w.id)).toEqual([]);
    // 그 상태에서 서버가 또 재시작한다(터미널은 살아 있다).
    await first.stopServer();
    first.core.intercept(null);
    const second = await restart(first, { onTurn: continues("이어서끝"), timings: {} });
    await second.waitFor("이어서 한 일의 보고", () => second.texts().some((m) => m.title === "이어서끝"));
    await second.idle(w.id);
    await second.waitFor("총괄이 보고를 받음", () => second.turns(lead.id).length === 1);
    await second.idle(lead.id);
    // 한 번 더 재시작해도(이번에는 아무것도 꺼지지 않았다) 그대로다.
    const third = await restart(second, { timings: {} });
    await Bun.sleep(300);
    expect(resumeTurns(third, w.id)).toHaveLength(1);
    expect(third.store.listDeliveries(third.project.id).filter((d) => d.text === RESTART_RESUME_TEXT).map((d) => d.status)).toEqual(["delivered"]);
    expect(third.store.listDeliveries(third.project.id).filter((d) => d.memberId === lead.id && d.text.includes("다시 지시하지 마세요"))).toHaveLength(1);
    expect(third.texts().filter((m) => m.kind === "시스템" && m.body.includes("이어서 하게 했습니다"))).toHaveLength(1);
    expect(reopenNotes(third, w.id)).toHaveLength(1);
    expect(third.store.restartWakes()).toEqual({});
  });

  test("기다리던 지시는 이어가기 글 뒤에 들어간다(끊긴 일을 정리한 뒤 새 일)", async () => {
    const t = await setup();
    const w = await working(t, "결제 연동", "pay");
    const queued = await t.orch.assign(t.project.id, w.handle, { text: "둘째 일 @fake:post=둘째끝" });
    expect(queued.position).toBeGreaterThan(0);
    const before = t.turns(w.id).length;
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    const next = await restart(t, { onTurn: continues("이어서끝") });
    await next.waitFor("둘째 일의 보고", () => next.texts().some((m) => m.title === "둘째끝"));
    const after = next.turns(w.id).slice(before);
    expect(after).toHaveLength(2);
    expect(after[0]!.prompt.startsWith(RESTART_RESUME_TEXT)).toBe(true);
    expect(after[0]!.prompt).not.toContain("둘째 일");
    expect(after[1]!.prompt).toContain("둘째 일");
    expect(after[1]!.prompt).not.toContain(RESTART_RESUME_TEXT);
    expect(next.texts().filter((m) => ["이어서끝", "둘째끝"].includes(m.title)).map((m) => m.title)).toEqual(["이어서끝", "둘째끝"]);
    // 대표의 말이나 지시가 깨운 것이라 줄을 기다리지 않았고, 터미널은 한 번만 열었다.
    expect(resumed(next, w.id)).toHaveLength(1);
  });

  test("끊긴 것이 총괄 자신의 턴이면 총괄이 이어가기 글을 받는다(자기에게 가는 소식은 없다)", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    await t.orch.sendUserMessage(t.project.id, { text: "큰 그림을 정리해 주세요 @fake:hold" });
    await t.waitFor("총괄이 일하는 중", () => t.core.held(lead.id) && t.member(lead.id).status === "working");
    await t.stopServer();
    t.core.exit(lead.id, 1, "holder_lost");
    const next = await restart(t, { onTurn: continues("총괄이어서끝") });
    await next.waitFor("총괄의 보고", () => next.texts().some((m) => m.title === "총괄이어서끝"));
    await next.idle(lead.id);
    expect(resumeTurns(next, lead.id)).toHaveLength(1);
    expect(resumeTurns(next, lead.id)[0]!.run.resumeFlag).toBe(next.member(lead.id).sessionId);
    expect(next.member(lead.id).sessionId).toBe(lead.sessionId);
    expect(next.store.listDeliveries(next.project.id).filter((d) => d.memberId === lead.id).map((d) => d.text === RESTART_RESUME_TEXT || d.kind === "user_message")).not.toContain(false);
    expect(next.texts().filter((m) => m.kind === "시스템").map((m) => m.body)).toEqual([expect.stringContaining("재시작으로 끊겨 이어서 하게 했습니다")]);
  });

  test("스스로 다시 여는 데 실패하면 예전처럼 총괄을 깨워 '실행 중단'을 알린다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const w = await working(t, "결제 연동", "pay");
    const runId = t.member(w.id).executionState!.runId;
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    refuseRun(t, w.id);
    const next = await restart(t);
    await next.waitFor("총괄에게 알림", () => next.turns(lead.id).some((turn) => turn.prompt.includes(`결제 연동의 실행 ${runId}이 중단되었습니다`)));
    expect(next.texts().filter((m) => m.kind === "시스템" && m.body.includes("중단")).map((m) => m.body)).toEqual([`결제 연동: 실행 ${runId} 중단 — Mac이나 실행 엔진이 다시 시작되어 끊겼습니다. 세션을 다시 열지 못했습니다`]);
    expect(next.member(w.id).status).toBe("offline");
    expect(next.store.getRestartWake(w.id)).toMatchObject({ state: "failed", runIds: [] });
    // 이어가기 글은 만들지 않는다. 끊긴 일도 다시 넣지 않는다.
    expect(next.store.listDeliveries(next.project.id).some((d) => d.text === RESTART_RESUME_TEXT)).toBe(false);
    expect(next.turns(w.id)).toHaveLength(1);
  });

  test("CLI 가 스스로 죽어 끊긴 일은 예전 그대로다: 다시 열지 않고 총괄을 깨워 알린다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const w = await working(t, "결제 연동", "pay");
    await t.stopServer();
    t.core.exit(w.id, 1);
    const next = await restart(t);
    await next.waitFor("총괄에게 알림", () => next.turns(lead.id).some((turn) => turn.prompt.includes("결제 연동의 실행") && turn.prompt.includes("중단되었습니다")));
    expect(next.texts().some((m) => m.kind === "시스템" && m.body.startsWith("결제 연동: 실행") && m.body.endsWith("중단 — exited"))).toBe(true);
    expect(next.member(w.id)).toMatchObject({ status: "offline", lastError: "초기/실행 종료: exited (exit_code=1)" });
    expect(next.runs(w.id)).toHaveLength(1);
    expect(next.store.restartWakes()).toEqual({});
    expect(next.store.listDeliveries(next.project.id).some((d) => d.text === RESTART_RESUME_TEXT)).toBe(false);
  });
});

// 스스로 다시 여는 길은 전달 펌프를 거치지 않는다. 펌프는 여는 자리에 닿기 전에 보류(받았는지 모르는 전달 등)에서 돌아가므로,
// 펌프에 기대면 보류가 남은 팀장은 깨어나지 않는다. 먼저 터미널을 확보하고, 보류는 입력 직전에만 본다.
// 받았는지 모르는 전달 자체는 그 전달을 받던 터미널의 사라짐이 확정되면 세션 기록으로 판정한다(tests/restart-audit.test.ts).
describe("보류가 남은 팀장", () => {
  /** 엔진이 입력 요청에 답하지 않아 받았는지 모르는 전달 하나가 남은, 깨어 있는 팀장. */
  async function unknownInput() {
    const t = await setup({ runnerDeps: { sendTimeoutMs: 300 } });
    const w = await awake(t, "결제 연동", "pay");
    t.core.intercept((call) => call.method === "terminal.send" && String(call.params.text).includes("받았는지 모를 일") ? "drop" : undefined);
    const assigned = await t.orch.assign(t.project.id, w.handle, { text: "받았는지 모를 일" });
    await t.waitFor("받았는지 모름", () => t.store.requireDelivery(assigned.delivery.id).holdReason === "delivery_unknown");
    return { t, w, deliveryId: assigned.delivery.id };
  }

  test("받았는지 모르는 전달이 남은 팀장도 다시 연다. 세션 기록으로 판정하지 못한 전달을 스스로 다시 넣지는 않는다", async () => {
    const { t, w, deliveryId } = await unknownInput();
    await t.stopServer();
    t.core.intercept(null);
    t.core.exit(w.id, 1, "holder_lost");
    // 죽은 CLI 가 쓰다 만 줄이 세션 기록 끝에 남았다: 받았는지 못 받았는지 기록으로는 알 수 없다.
    appendFileSync(transcriptPath(t.project.cwd, w.sessionId!, t.core.claudeHome), '{"type":"user","message":{"role":"us');
    const next = await restart(t);
    await next.waitFor("다시 열림", () => resumed(next, w.id).length === 1 && next.member(w.id).paneId === next.core.terminalOf(w.id)!.address && !next.store.getRestartWake(w.id));
    expect(reopenNotes(next, w.id)).toHaveLength(1);
    await Bun.sleep(300);
    // 보류는 그대로다: 받았는지 모르는 전달을 서버가 스스로 다시 넣지 않고 대표에게 묻는다.
    expect(next.store.requireDelivery(deliveryId)).toMatchObject({ status: "held", holdReason: "delivery_unknown" });
    expect(next.store.getDeliveryRecovery(deliveryId)).toMatchObject({ phase: "needs_owner", reason: "log_incomplete" });
    expect(next.turns(w.id).some((turn) => turn.prompt.includes("받았는지 모를 일"))).toBe(false);
    expect(resumed(next, w.id)).toHaveLength(1);
    // 받았는지조차 모르는 입력은 '하던 일'이 아니다: 이어가기 글을 만들지 않는다.
    expect(next.store.listDeliveries(next.project.id).some((d) => d.text === RESTART_RESUME_TEXT)).toBe(false);
    expect(next.store.getRestartWake(w.id)).toBeNull();
  }, 20_000);

  test("그 전달을 받던 터미널이 사라진 것이 확인되고 세션 기록에 받은 흔적이 없으면, 다시 연 터미널에 한 번 다시 넣는다", async () => {
    const { t, w, deliveryId } = await unknownInput();
    const lead = await t.orch.ensureConductor(t.project.id);
    await t.stopServer();
    t.core.intercept(null);
    t.core.exit(w.id, 1, "holder_lost");
    const next = await restart(t);
    await next.waitFor("다시 넣어 전달됨", () => next.store.requireDelivery(deliveryId).status === "delivered");
    expect(resumed(next, w.id)).toHaveLength(1);
    const turns = next.turns(w.id).filter((turn) => turn.prompt.includes("받았는지 모를 일"));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.terminal).toBe(next.member(w.id).paneId!);
    // 넣지 못한 입력은 '하던 일'도 '끊긴 실행'도 아니다: 이어가기 글을 만들지 않고, 총괄에게 중단을 알리지도 않는다.
    expect(next.store.listDeliveries(next.project.id).some((d) => d.text === RESTART_RESUME_TEXT)).toBe(false);
    expect(next.texts().some((m) => m.kind === "시스템" && m.body.includes("중단"))).toBe(false);
    expect(next.store.listDeliveries(next.project.id).some((d) => d.memberId === lead.id && d.text.includes("중단되었습니다"))).toBe(false);
  }, 20_000);
});

// 2026-11-12 실측: 꺼진 팀장을 깨우자 '승인 대기 · 승인 창 앞에서 멈췄습니다' 알림이 떴는데, 그 팀장은 6초 뒤 쉬는 중이 됐고 승인 창은 없었다.
// 갓 띄운 CLI 가 아직 준비를 알리지 않은 것을 실행기가 '막힘'으로 알렸기 때문이다. 스스로 다시 열면 재시작마다 팀장 수만큼 그 알림이 뜬다.
describe("갓 깨운 팀장은 준비를 알리기 전에도 막힘이 아니다", () => {
  const claudeTrust = (cwd: string) => ` Accessing workspace:\n ${cwd}\n Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel\n`;
  async function woken(opts: CoreSetupOptions = {}) {
    const notices: string[] = [];
    const t = await setup({ fake: { startState: null }, notifier: (title, body) => notices.push(`${title} / ${body}`), ...opts, timings: { blockedNoticeMs: 40, ...opts.timings } });
    t.store.patchSettings({ notifyMac: true });
    const w = await awake(t, "결제 연동", "pay");
    await t.orch.sleepMember(w.id);
    notices.length = 0;
    await t.orch.resumeMember(w.id); // 대표가 '깨우기'를 눌렀다. 새 CLI 는 아직 아무것도 알리지 않는다.
    return { t, w, notices };
  }

  test("준비를 알리기 전의 몇 초 동안 명부에 막힘으로 보이지 않고 알림도 없다", async () => {
    const { t, w, notices } = await woken();
    await Bun.sleep(300);
    expect(t.member(w.id)).toMatchObject({ status: "idle", blockedReason: null });
    t.core.setStatus(w.id, { state: "idle" });
    await Bun.sleep(200);
    expect(t.member(w.id).status).toBe("idle");
    expect(notices).toEqual([]);
    // 깨어난 팀장은 평소처럼 일을 받는다.
    await t.orch.assign(t.project.id, w.handle, { text: "깨어난 뒤의 일 @fake:post=깨어난뒤끝" });
    await t.waitFor("깨어난 뒤의 보고", () => t.texts().some((m) => m.title === "깨어난뒤끝"));
  });

  test("알아본 창(폴더 신뢰) 앞이면 곧바로 막힘이고, 그 막힘이 이어지면 알린다", async () => {
    const { t, w, notices } = await woken();
    t.core.setScreen(w.id, claudeTrust(t.member(w.id).cwd));
    await t.waitFor("막힘", () => t.member(w.id).status === "blocked" && t.member(w.id).blockedReason === "setup");
    await t.waitFor("알림", () => notices.length === 1);
    expect(notices[0]).toContain("결제 연동 승인 대기");
  });

  test("끝내 준비를 알리지 않으면 예전처럼 막힘으로 보이고 알린다", async () => {
    // 조용한 시간은 '아직 막힘이 아님'을 보는 동안 느린 러너에서도 끝나지 않을 만큼 둔다(150ms 였을 때는 깨우기부터 이 단정까지가 넘칠 수 있었다).
    const { t, w, notices } = await woken({ runnerDeps: { startQuietMs: 1_500 } });
    await Bun.sleep(60);
    expect(t.member(w.id).status).toBe("idle");
    await t.waitFor("막힘", () => t.member(w.id).status === "blocked");
    expect(t.member(w.id).blockedReason).toBe("status_unknown");
    await t.waitFor("알림", () => notices.length === 1);
    expect(notices[0]).toContain("결제 연동 승인 대기");
  });
});
