// 0.2.7 D2-6: 느린 API 응답 화면('Waiting for API response … check your network') 한 번을 인터넷 장애로 보고 '팀원이 멈췄습니다'를 알렸고,
// 그 팀원이 1분 뒤 턴을 잘 마쳤는데도 장애를 닫지 않아(탐침 두 번을 기다림) 그 팀원의 전달이 12분 보류됐다(11-16 01:52, 1건).
// - 그 화면이 networkRetryNoticeMs(운영 60초) 동안 이어질 때만 장애로 연다. 턴이 실제로 연결 오류로 끝나면 예전처럼 곧바로 연다.
// - 장애에 걸린 팀원이 모두 그 뒤로 턴을 성공하면 곧바로 장애를 닫고 복구를 알린다.
import { afterEach, describe, expect, test } from "bun:test";
import { ApiRecovery, type ApiRecoveryOptions } from "../server/api-outage.ts";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import type { AgentToolsImpl } from "../server/orchestrator.ts";
import { mustRender, type ServerTextRef } from "../shared/server-text.ts";
import type { Member } from "../shared/types.ts";
import { coreSetup, type CoreEnv } from "./fixtures/core-harness.ts";

const RETRY_SCREEN = "Waiting for API response · will retry in 1m 2s · check your network";
const shown = (text: string | ServerTextRef): string => typeof text === "string" ? text : mustRender(text, "ko");
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

function recovery() {
  const db = openDb(":memory:"); closers.push(() => db.close());
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "연결 시험", cwd: "/private/tmp/fake-api-work" });
  const make = (handle: string) => store.createMember({ projectId: project.id, handle, name: handle, kind: "worker", backend: "core", paneId: `t-${handle}`, sessionId: `s-${handle}` });
  const notices: string[] = [], pumps: string[] = [];
  let now = Date.parse("2026-11-16T01:52:00+09:00");
  const options: ApiRecoveryOptions = { store, now: () => now, intervalMs: 30_000, urls: ["https://fake-anthropic.invalid"], probe: async () => { throw new Error("offline"); },
    notify: (_p, text) => notices.push(shown(text)), pump: id => { pumps.push(id); }, inspect: async () => ({ menu: null, state: "idle" }), dismiss: async () => ({ ok: true }) };
  const service = new ApiRecovery(options);
  return { store, project, make, notices, pumps, service, advance(ms: number) { now += ms; } };
}

describe("성공한 턴은 장애를 닫는다 (D2-6)", () => {
  test("응답 기다림으로 장애가 열린 팀원이 턴을 성공하면 탐침을 기다리지 않고 닫고 복구를 알린다", () => {
    const f = recovery(), m = f.make("search");
    const d = f.store.enqueue({ projectId: f.project.id, memberId: m.id, kind: "instruction", text: "다음 지시" });
    f.service.networkFailure(m, false);
    expect(f.service.outage()?.affectedMemberIds).toEqual([m.id]);
    expect(f.service.holdReason(m.id)).toBe("api_outage");
    expect(f.store.requireDelivery(d.id).holdReason).toBe("api_outage");
    f.advance(66_000);
    f.service.completed(m.id);
    expect(f.service.outage()).toBeNull();
    expect(f.store.apiOutage()).toBeNull();
    expect(f.service.holdReason(m.id)).toBeNull();
    expect(f.notices).toEqual(["인터넷 연결이 불안정해 팀원 1명이 멈췄습니다. 연결이 돌아오면 자동으로 이어 갑니다.", "인터넷 연결이 돌아와 팀원 1명이 이어서 일합니다."]);
    expect(f.pumps).toContain(m.id);
    // 턴이 끊긴 팀원이 없으니 이어가기 글은 넣지 않는다.
    expect(f.store.listDeliveries(f.project.id).map(x => x.id)).toEqual([d.id]);
  });

  test("영향받은 팀원 가운데 하나라도 아직 성공하지 않았으면 닫지 않는다. 성공한 뒤 다시 실패하면 다시 센다", () => {
    const f = recovery(), a = f.make("a"), b = f.make("b");
    f.service.networkFailure(a, true);
    f.service.networkFailure(b, false);
    f.service.completed(b.id);
    expect(f.service.outage()?.affectedMemberIds).toEqual([a.id, b.id]);
    f.service.networkFailure(b, false);
    f.service.completed(a.id);
    expect(f.service.outage()).not.toBeNull();
    f.service.completed(b.id);
    expect(f.service.outage()).toBeNull();
    expect(f.notices.filter(n => n.includes("돌아와"))).toHaveLength(1);
  });
});

const TOOLS: AgentToolsImpl = { listAgentTools: () => [], async handleAgentTool() { return { text: "" }; } };
async function working(t: CoreEnv): Promise<Member> {
  const member = (await t.orch.addMember(t.project.id, { name: "검색 개선", handle: "search", role: "개발" })).member;
  await t.orch.assign(t.project.id, "search", { text: "큰 일 @fake:hold" });
  await t.waitFor("일하는 중", () => t.core.held(member.id) && t.member(member.id).status === "working");
  return t.member(member.id);
}
const outageNotices = (t: CoreEnv) => t.texts().filter(m => m.kind === "시스템" && m.body.startsWith("인터넷 연결이"));

describe("응답 기다림 화면은 이어질 때만 장애다 (D2-6)", () => {
  test("기한 안에 화면이 풀리면 장애도 알림도 없다", async () => {
    const t = await coreSetup({ agentTools: TOOLS, timings: { networkRetryNoticeMs: 1500 } }); closers.push(() => t.close());
    const m = await working(t);
    t.core.setScreen(m.id, RETRY_SCREEN);
    await t.waitFor("응답 기다림 관측", () => t.member(m.id).statusObservation?.error?.code === "network_retry");
    t.core.setScreen(m.id, null);
    await t.waitFor("화면 풀림", () => t.member(m.id).statusObservation?.error?.code !== "network_retry");
    await Bun.sleep(1800);
    expect(t.store.apiOutage()).toBeNull();
    expect(outageNotices(t)).toHaveLength(0);
    // 턴은 잘 끝난다.
    t.core.release(m.id);
    await t.idle(m.id);
    expect(t.store.apiOutage()).toBeNull();
  });

  test("기한 넘게 이어지면 장애로 열고 알린다. 그 팀원이 턴을 성공하면 곧바로 닫는다", async () => {
    const t = await coreSetup({ agentTools: TOOLS, timings: { networkRetryNoticeMs: 300 } }); closers.push(() => t.close());
    const m = await working(t);
    t.core.setScreen(m.id, RETRY_SCREEN);
    await t.waitFor("응답 기다림 관측", () => t.member(m.id).statusObservation?.error?.code === "network_retry");
    expect(t.store.apiOutage()).toBeNull();
    await t.waitFor("장애 열림", () => t.store.apiOutage());
    expect(t.store.apiOutage()?.affectedMemberIds).toEqual([m.id]);
    expect(outageNotices(t).map(x => x.body)).toEqual(["인터넷 연결이 불안정해 팀원 1명이 멈췄습니다. 연결이 돌아오면 자동으로 이어 갑니다."]);
    t.core.setScreen(m.id, null);
    t.core.release(m.id);
    await t.waitFor("장애 닫힘", () => t.store.apiOutage() === null);
    await t.waitFor("복구 알림", () => outageNotices(t).length === 2);
    expect(outageNotices(t)[1]!.body).toBe("인터넷 연결이 돌아와 팀원 1명이 이어서 일합니다.");
  });
});

describe("장애·한도 복구 상태의 찌꺼기 (D4-12)", () => {
  test("서버가 뜰 때 지운 팀원·끝난 이어가기 글·닫힌 빈 한도 카드를 지우고, 살아 있는 항목은 그대로 둔다", () => {
    const f = recovery(), kept = f.make("kept"), waiting = f.make("waiting");
    const delivered = f.store.enqueue({ projectId: f.project.id, memberId: kept.id, kind: "system", text: "이어가기" });
    f.store.markDelivered(delivered.id);
    const queued = f.store.enqueue({ projectId: f.project.id, memberId: waiting.id, kind: "system", text: "이어가기" });
    const closed = f.store.createDecision({ projectId: f.project.id, who: "시스템", title: "사용 한도" });
    f.store.setDecisionStatus(closed.id, "closed");
    const open = f.store.createDecision({ projectId: f.project.id, who: "시스템", title: "사용 한도" });
    const limited = (memberId: string) => ({ memberId, fingerprint: null, raw: "You've hit your 5-hour limit", resetsAt: null, resumeId: null, awaitingResult: false, autoAttempted: null, failure: null });
    f.store.saveApiRecovery("api_recovery", {
      outage: { id: "o1", since: "2026-11-16T01:52:57.000Z", active: false, lastProbeAt: null, successes: 2, affected: [
        { memberId: "m_gone", ended: false, attempts: 0, resumeId: null, awaitingResult: false, exhausted: false },
        { memberId: kept.id, ended: false, attempts: 3, resumeId: null, awaitingResult: false, exhausted: true, exhaustedAt: "2026-11-16T01:00:00.000Z" }] },
      limits: [{ cli: "claude", decisionId: closed.id, stillLimited: false, members: [] }, { cli: "codex", decisionId: open.id, stillLimited: false, members: [limited("m_gone"), limited(waiting.id)] }],
      resumeOrder: ["m_gone", kept.id], continuations: { m_gone: "dl_gone", [kept.id]: delivered.id, [waiting.id]: queued.id },
    });
    const service = new ApiRecovery({ store: f.store, notify: () => {}, pump: () => {}, inspect: async () => ({ menu: null, state: "idle" }), dismiss: async () => ({ ok: true }) });
    const saved = f.store.loadApiRecovery<{ outage: { affected: { memberId: string }[] }; limits: { decisionId: string; members: { memberId: string }[] }[]; resumeOrder: string[]; continuations: Record<string, string> }>("api_recovery")!;
    expect(saved.outage.affected.map(a => a.memberId)).toEqual([kept.id]);
    expect(saved.resumeOrder).toEqual([kept.id]);
    expect(saved.continuations).toEqual({ [waiting.id]: queued.id });
    expect(saved.limits.map(g => [g.decisionId, g.members.map(m => m.memberId)])).toEqual([[open.id, [waiting.id]]]);
    // 이어가기를 포기한 팀원은 그대로 보류다.
    expect(service.holdReason(kept.id)).toBe("api_outage");
    // 팀원을 지우면(Orchestrator.forgetMember → forget) 그 팀원의 한도 카드 자리·이어가기 글도 지운다. 빈 카드는 닫히고 묶음도 지운다.
    f.store.removeMember(waiting.id);
    service.forget();
    const after = f.store.loadApiRecovery<typeof saved>("api_recovery")!;
    expect(after.limits).toEqual([]);
    expect(after.continuations).toEqual({});
    expect(f.store.requireDecision(open.id).status).toBe("closed");
  });

  test("지운 팀장만 있던 열린 한도 카드는 뜰 때 정리 뒤 총괄이 시작하면(start) 곧바로 닫히고 묶음도 지운다", () => {
    const f = recovery(), kept = f.make("kept");
    const lonely = f.store.createDecision({ projectId: f.project.id, who: "시스템", title: "사용 한도" });
    const mixed = f.store.createDecision({ projectId: f.project.id, who: "시스템", title: "사용 한도" });
    const limited = (memberId: string) => ({ memberId, fingerprint: "fp", raw: "You've hit your limit", resetsAt: null, resumeId: null, awaitingResult: false, autoAttempted: null, failure: null });
    f.store.saveApiRecovery("api_recovery", { outage: null, limits: [
      { cli: "claude", decisionId: lonely.id, stillLimited: true, members: [limited("m_gone")] },
      { cli: "codex", decisionId: mixed.id, stillLimited: false, members: [limited("m_gone2"), limited(kept.id)] }] });
    const service = new ApiRecovery({ store: f.store, intervalMs: 60_000, notify: () => {}, pump: () => {}, inspect: async () => ({ menu: null, state: "blocked" }), dismiss: async () => ({ ok: true }) });
    closers.push(() => service.shutdown());
    type Saved = { limits: { decisionId: string; members: { memberId: string }[] }[] };
    // 뜰 때(생성자)는 카드 글을 다시 쓰지 않는다. 팀장 자리만 뺀다.
    expect(f.store.loadApiRecovery<Saved>("api_recovery")!.limits.map(g => [g.decisionId, g.members.map(m => m.memberId)])).toEqual([[lonely.id, []], [mixed.id, [kept.id]]]);
    expect(f.store.requireDecision(lonely.id).status).toBe("open");
    // 총괄이 다 만들어진 뒤(start): 팀장이 남지 않은 카드는 닫히고 묶음도 지운다. 남은 팀장이 있는 카드는 그 팀장만으로 다시 쓴다.
    service.start();
    expect(f.store.requireDecision(lonely.id).status).toBe("closed");
    expect(f.store.requireDecision(mixed.id)).toMatchObject({ status: "open", usageLimit: { memberIds: [kept.id] } });
    expect(f.store.loadApiRecovery<Saved>("api_recovery")!.limits.map(g => [g.decisionId, g.members.map(m => m.memberId)])).toEqual([[mixed.id, [kept.id]]]);
  });
});
