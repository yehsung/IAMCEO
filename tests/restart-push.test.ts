// 0.2.7 D2-4·D4-2: Mac·실행 엔진 재시작 한 번에 팀장 수만큼 '오류' 알림이 갔다(11-13 13:04·17:51 각 15건). 서버가 1분 안에 모두 스스로 다시 열었는데도.
// 이제 스스로 다시 연 팀장은 따로 알리지 않고 프로젝트마다 대화에 한 줄 요약만 남긴다. 다시 열지 못한 팀장이 있을 때만 알림을 한 번 낸다.
// 운영과 같은 틀: 가짜 엔진 소켓 + 실제 CoreRunner + 운영 배선의 총괄 + 알림 사건 기록기(PushEventRecorder).
import { afterEach, describe, expect, test } from "bun:test";
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
  const t = await coreSetup({ agentTools: TOOLS, push: true, ...opts });
  cleanups.push(() => t.close());
  return t;
}
async function restart(t: CoreEnv, opts: Omit<CoreSetupOptions, "home" | "core" | "projectId"> = {}) {
  const next = await t.restart(opts);
  cleanups.push(() => next.close());
  return next;
}
async function awake(t: CoreEnv, name: string, handle: string): Promise<Member> {
  const member = (await t.orch.addMember(t.project.id, { name, handle, role: "개발" })).member;
  t.core.setStatus(member.id, { state: "idle" });
  await t.orch.assign(t.project.id, handle, { text: `준비 @fake:post=${handle}준비` });
  await t.waitFor(`${name} 준비`, () => t.texts().some((m) => m.title === `${handle}준비`));
  await t.idle(member.id);
  return t.member(member.id);
}
/**
 * 이 서버의 다시 열기 확인이 한 번 더 끝날 때까지 기다린다(긍정 신호). recover 의 첫 확인은 restart() 가 이미 기다렸고, 연결 확인(refreshConnection)은
 * 끝에서 kickRestartWakes 를 부른다. 알릴 실패만 남은 확인은 그 자리에서 요약·알림까지 쓴다. 고정 시간을 자지 않아 부하 아래에서도 헛통과하지 않는다.
 */
async function rechecked(t: CoreEnv): Promise<void> {
  await t.orch.refreshConnection();
  await t.orch.refreshConnection();
}
const errorEvents = (t: CoreEnv) => t.push!.listEvents().filter((e) => e.kind === "error");
const summaries = (t: CoreEnv) => t.texts().filter((m) => m.kind === "시스템" && (m.textCode === "chat.restart_reopened_summary" || m.textCode === "chat.restart_reopen_failed_summary"));

describe("재시작으로 꺼진 팀장의 알림은 묶음 하나로 (D2-4·D4-2)", () => {
  test("서버가 모두 다시 열면 팀장마다의 '오류' 알림은 없고, 대화에 한 줄 요약만 남는다", async () => {
    const t = await setup();
    const members = [await awake(t, "결제 연동", "pay"), await awake(t, "검색 개선", "search"), await awake(t, "문서 정리", "docs")];
    expect(errorEvents(t)).toHaveLength(0);
    await t.stopServer();
    t.core.exit(members[0]!.id, 1, "holder_lost");
    t.core.exit(members[1]!.id, 1, "stopped_by_restart");
    t.core.exit(members[2]!.id, 1, "holder_lost");
    const next = await restart(t);
    for (const m of members) await next.waitFor(`${m.name} 다시 열림`, () => next.member(m.id).status === "idle" && !next.store.getRestartWake(m.id));
    await next.waitFor("요약", () => summaries(next).length > 0);
    await Bun.sleep(150);
    expect(errorEvents(next)).toHaveLength(0);
    expect(summaries(next).map((m) => m.body)).toEqual(["Mac이나 실행 엔진이 다시 시작되어 꺼졌던 팀원 3명을 다시 열었습니다."]);
  });

  test("다시 열지 못한 팀장이 있으면 그 묶음에 알림은 한 번이고, 요약에 그 이름이 있다", async () => {
    const t = await setup();
    const a = await awake(t, "결제 연동", "pay"), b = await awake(t, "검색 개선", "search"), c = await awake(t, "문서 정리", "docs");
    await t.stopServer();
    for (const m of [a, b, c]) t.core.exit(m.id, 1, "holder_lost");
    // 두 팀장은 터미널을 만들지 못한다.
    t.core.intercept((call) => call.method === "terminal.run" && [a.id, b.id].includes(call.params.labels?.["iamceo.member"] ?? "") ? { error: { kind: "invalid", message: "터미널을 만들지 못함" } } : undefined);
    const next = await restart(t, { timings: { healthMs: 60 } });
    await next.waitFor("묶음 끝", () => summaries(next).length > 0);
    expect(next.member(c.id).status).toBe("idle");
    for (const m of [a, b]) expect(next.store.getRestartWake(m.id)).toMatchObject({ state: "failed" });
    expect(summaries(next).map((m) => m.body)).toEqual(["Mac이나 실행 엔진이 다시 시작되어 꺼졌던 팀원 3명 가운데 1명을 다시 열었습니다. 다시 열지 못한 팀원: 결제 연동, 검색 개선. 팀 화면에서 깨워 주세요."]);
    await rechecked(next);
    const events = errorEvents(next);
    expect(events).toHaveLength(1);
    expect(events[0]!.target).toEqual({ screen: "team", projectId: next.project.id, memberId: a.id });
    // 알렸다는 표시가 남는다(다음 서버가 다시 알리지 않는다).
    for (const m of [a, b]) expect(next.store.getRestartWake(m.id)?.unreported).toBeUndefined();
    // 같은 실패가 남아 있는 동안 다시 알리지 않는다(서버를 또 띄워도).
    const again = await restart(next, { timings: { healthMs: 60 } });
    await rechecked(again);
    expect(errorEvents(again)).toHaveLength(1);
    expect(summaries(again)).toHaveLength(1);
  });

  test("다시 열기 묶음 도중 서버가 내려가도, 이미 열지 못한 팀장은 다음 서버의 묶음이 요약과 알림 한 번에 싣는다", async () => {
    const t = await setup();
    const a = await awake(t, "결제 연동", "pay"), b = await awake(t, "검색 개선", "search");
    await t.stopServer();
    for (const m of [a, b]) t.core.exit(m.id, 1, "holder_lost");
    t.core.intercept((call) => call.method === "terminal.run" && call.params.labels?.["iamceo.member"] === a.id ? { error: { kind: "invalid", message: "터미널을 만들지 못함" } } : undefined);
    // 팀장 사이 간격을 길게 두어, a 가 실패로 닫힌 뒤 b 차례 전에 서버를 내릴 수 있게 한다(운영: 2초 간격 + 자리 잡기 최대 30초).
    const next = await restart(t, { timings: { healthMs: 60, restartWakeGapMs: 3000 } });
    await next.waitFor("a 실패", () => next.store.getRestartWake(a.id)?.state === "failed");
    expect(next.store.getRestartWake(a.id)?.unreported).toBe(true);
    expect(next.store.getRestartWake(b.id)?.state).toBe("pending");
    expect(errorEvents(next)).toHaveLength(0);
    // 묶음이 끝나기 전에 서버가 내려간다(배포·launchd 재시작). 이 서버는 요약도 알림도 쓰지 못한다.
    const third = await restart(next, { timings: { healthMs: 60 } });
    await third.waitFor("b 다시 열림", () => third.member(b.id).status === "idle" && !third.store.getRestartWake(b.id), 20_000);
    await third.waitFor("요약", () => summaries(third).length > 0);
    await rechecked(third);
    expect(summaries(third).map((m) => m.body)).toEqual(["Mac이나 실행 엔진이 다시 시작되어 꺼졌던 팀원 2명 가운데 1명을 다시 열었습니다. 다시 열지 못한 팀원: 결제 연동. 팀 화면에서 깨워 주세요."]);
    expect(errorEvents(third).map((e) => e.memberId)).toEqual([a.id]);
    expect(third.store.getRestartWake(a.id)).toMatchObject({ state: "failed" });
    expect(third.store.getRestartWake(a.id)?.unreported).toBeUndefined();
  });

  test("재시작이 아닌 오류(CLI 가 스스로 죽음)는 예전처럼 그 팀장의 알림이 간다", async () => {
    const t = await setup();
    const dead = await awake(t, "죽은 세션", "dead");
    await t.stopServer();
    t.core.exit(dead.id, 1);
    const next = await restart(t);
    await next.waitFor("꺼짐", () => next.member(dead.id).status === "offline" && next.member(dead.id).lastError);
    await next.waitFor("오류 알림", () => errorEvents(next).length === 1);
    expect(errorEvents(next)[0]!.memberId).toBe(dead.id);
    expect(summaries(next)).toHaveLength(0);
  });
});
