// 재시작 뒤 사라진 터미널에 묶인 상태가 스스로 풀리는지 본다.
// Mac 이 꺼졌다 켜져(또는 실행 엔진만 다시 시작돼) 팀장의 터미널이 사라진 뒤, DB 에 남은 '보류·대기·불확실' 상태가 풀려
// 밀린 지시가 다시 열린 터미널에 들어가는지를 실제 CoreRunner 틀(tests/fixtures/core-harness.ts)로 확인한다.
//
// 원칙은 하나다: 터미널의 사라짐이 확정되면(엔진이 끝났다고 알렸거나, 그 터미널을 모른다고 확정해 답함) 그 터미널에 묶인 미확정 상태를
// 한곳에서 정리한다(Orchestrator.releaseGoneTerminal). 엔진이 답하지 않는 동안과 세션 기록을 읽지 못한 전달은 예전처럼 보수적으로 둔다.
// 시험이 실패하면 그 팀장이 무엇에 막혀 있는지(보류 상태)를 실패 글에 싣는다.
import { afterAll, describe, expect, test } from "bun:test";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import type { DecisionOption, Member } from "../shared/types.ts";
import { appendFileSync } from "node:fs";
import { transcriptPath } from "../server/runner/transcript.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions } from "./fixtures/core-harness.ts";

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

/** 틱·점검·재시도를 시험 시간 안에 여러 번 돌게 줄인 값. 판정 기준(확인 120초 등 코드에 박힌 값)은 그대로다. */
const FAST = { tickMs: 150, healthMs: 40, retryMs: 30, inputBusyRetryMs: 30, writeSettleMs: 40, startGraceMs: 200 };
/** 답이 끊긴 요청을 기다리는 실행기의 제한 시간. 기본(2초)을 그대로 두면 '결과 모름'을 만드는 데만 시험마다 2초가 든다. */
const QUICK_RPC = { sendTimeoutMs: 300 };
/** 풀리기를 기다리는 상한. 틱(150ms)·점검(40ms)이 수십 번 돌 시간이다. 풀리면 곧바로 지나간다. */
const SETTLE_MS = 6000;
/** '일어나지 않는다'를 보는 대기. 틱·점검·전달 확인이 여러 번 돌 시간이다. */
const QUIET_MS = 700;

async function setup(opts: CoreSetupOptions = {}): Promise<CoreEnv> {
  const t = await coreSetup({ agentTools: TOOLS, ...opts, timings: { ...FAST, ...opts.timings } });
  cleanups.push(() => t.close());
  return t;
}
async function worker(t: CoreEnv, name = "철수", handle = "chulsu"): Promise<Member> {
  return (await t.orch.addMember(t.project.id, { name, handle, role: "개발" })).member;
}
/** 한 턴을 돌려 세션 기록을 만든다(기록이 있어야 다시 열 때 같은 세션을 --resume 한다). */
async function warm(t: CoreEnv, w: Member): Promise<void> {
  await t.orch.assign(t.project.id, w.handle, { text: "첫 일 @fake:post=첫일끝" });
  await t.waitFor("첫 일 보고", () => t.texts().some((m) => m.title === "첫일끝"));
  await t.idle(w.id);
}
/** Mac 을 껐다 켰다: 서버가 내려가고, 그 사이 터미널이 모두 사라지고(holder_lost), 서버가 다시 뜬다. */
async function macRestart(t: CoreEnv, memberIds: string[], next: Parameters<CoreEnv["restart"]>[0] = {}): Promise<CoreEnv> {
  await t.stopServer();
  for (const id of memberIds) if (t.core.terminalOf(id)?.state === "live") t.core.exit(id, 1, "holder_lost");
  const n = await t.restart(next);
  cleanups.push(() => n.close());
  return n;
}
const liveTerminals = (t: CoreEnv, memberId: string) => t.core.terminals().filter((x) => x.state === "live" && x.labels["iamceo.member"] === memberId).map((x) => x.address);
/** 그 팀장에게 걸려 있는 보류 상태 전부. 실패했을 때 무엇에 막혀 있는지 한눈에 보인다. */
function fences(t: CoreEnv, memberId: string) {
  const m = t.store.requireMember(memberId);
  const generation = t.store.memberRevisions(memberId).sessionGeneration;
  return {
    status: m.status, paneId: m.paneId, lastError: m.lastError, observation: m.statusObservation ? `${m.statusObservation.ownership}/${m.statusObservation.error?.code ?? "-"}` : null,
    deliveries: t.store.listDeliveries(m.projectId).filter((d) => d.memberId === memberId && d.status !== "delivered").map((d) => {
      const r = t.store.getDeliveryRecovery(d.id);
      return `${d.kind}:${d.status}/${d.holdReason ?? "-"} recovery=${r?.phase}/${r?.reason ?? "-"}`;
    }),
    dispatches: t.store.listDispatches(memberId).filter((d) => d.transportState !== "accepted").map((d) => `${d.transportState}@${d.identity.terminalId}`),
    lifecycle: t.store.listPendingLifecycleJournals().filter((j) => j.memberId === memberId && j.identity.sessionGeneration === generation).map((j) => `${j.intent}/${j.phase}`),
    executions: t.store.listPendingExecutions().filter((r) => r.memberId === memberId).map((r) => r.phase),
    compaction: (() => { try { const c = t.store.getContextState(memberId)?.compaction; return c ? `${c.phase}/${c.reason ?? "-"}` : null; } catch (e) { return `읽기 실패: ${(e as Error).message}`; } })(),
    configDeferred: t.store.deferredMemberConfig(memberId)?.signature ?? null,
    lease: !!t.store.inputState(memberId).lease,
    runs: t.runs(memberId).length,
    liveTerminals: liveTerminals(t, memberId),
  };
}
/** 기다렸다가 끝내 안 되면 보류 상태를 실패 글에 싣는다. */
async function eventually(t: CoreEnv, memberId: string, what: string, read: () => unknown, ms = SETTLE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (read()) return; await Bun.sleep(25); }
  expect({ 기대: what, 결과: `${ms}ms 안에 일어나지 않음`, 보류: fences(t, memberId) }).toEqual({ 기대: what, 결과: "일어남", 보류: {} } as never);
}
const pendingLifecycle = (t: CoreEnv, memberId: string) => fences(t, memberId).lifecycle;
/** 그 팀장의 지금 터미널을 띄울 때 넘긴 노력 설정. */
const effortOf = (t: CoreEnv, memberId: string) => { const argv = t.runs(memberId).at(-1)!.argv; return argv.includes("--effort") ? argv[argv.indexOf("--effort") + 1] : null; };
const delivered = (t: CoreEnv, deliveryId: string) => t.store.requireDelivery(deliveryId).status === "delivered";
const instruct = async (t: CoreEnv, w: Member, text: string) => (await t.orch.assign(t.project.id, w.handle, { text })).delivery.id;

// ───────────────────────── 1. 전달의 '받았는지 모름' ─────────────────────────
describe("전달 결과 모름(delivery_unknown)을 받은 터미널이 사라진 뒤", () => {
  /**
   * 입력 요청의 답이 끊겨 '받았는지 모름'이 된 전달 하나를 만든다(봉투 unknown, 전달 held/delivery_unknown, 복구 checking).
   * received=true 면 CLI 는 실제로 받았다(세션 기록에 표지가 남는다). false 면 CLI 에 닿지 않았다.
   * 첫 서버는 틱을 돌리지 않는다: 재시작 전에 수신 확인이 먼저 끝나 버리면 보려는 상태가 아니다.
   */
  async function unknownSend(received: boolean) {
    const t = await setup({ timings: { tickMs: 60_000 }, runnerDeps: QUICK_RPC });
    const w = await worker(t);
    await warm(t, w);
    t.core.intercept((call) => {
      if (call.method !== "terminal.send" || !String(call.params.text).includes("끊긴 일")) return undefined;
      if (received) t.core.typeDirectly(w.id, String(call.params.text));
      return "drop";
    });
    const d = await instruct(t, w, "끊긴 일 @fake:post=끊긴일끝");
    t.core.intercept(null);
    expect(t.store.requireDelivery(d)).toMatchObject({ status: "held", holdReason: "delivery_unknown" });
    return { t, w, d };
  }
  const sentTurns = (t: CoreEnv, w: Member) => t.turns(w.id).filter((x) => x.prompt.includes("끊긴 일"));
  /** 대표의 전달 복구 요청. 확인이 도는 사이 판 번호가 바뀌면 다시 읽어 넣는다. */
  async function ownerAction(t: CoreEnv, deliveryId: string, action: "stop_retry" | "retry_with_risk"): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const version = t.store.getDeliveryRecovery(deliveryId)!.version;
      try {
        await t.orch.recoverDelivery(deliveryId, action === "stop_retry" ? { operationId: crypto.randomUUID(), expectedVersion: version, action }
          : { operationId: crypto.randomUUID(), expectedVersion: version, action, acceptDuplicateRisk: true });
        return;
      } catch (e) { if ((e as { status?: number }).status !== 409) throw e; await Bun.sleep(50); }
    }
    throw new Error(`전달 복구 요청을 넣지 못했습니다: ${action}`);
  }
  /**
   * Mac 재시작. 서버가 다시 뜨기 전에, 죽은 CLI 가 쓰다 만 줄이 세션 기록 끝에 남아 있게 한다:
   * 판정 범위를 끝까지 읽지 못해 받았는지 못 받았는지 기록으로는 알 수 없다.
   */
  async function macRestartWithTornLog(t: CoreEnv, w: Member): Promise<CoreEnv> {
    const sessionId = t.member(w.id).sessionId!;
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    appendFileSync(transcriptPath(t.project.cwd, sessionId, t.core.claudeHome), '{"type":"user","message":{"role":"us');
    const next = await t.restart({ timings: FAST });
    cleanups.push(() => next.close());
    return next;
  }

  test("세션 기록에 수신 흔적이 없으면(못 받음), 다시 뜬 서버가 그 지시를 새 터미널에 다시 넣어 전달한다", async () => {
    const { t, w, d } = await unknownSend(false);
    const old = t.member(w.id).paneId;
    const next = await macRestart(t, [w.id], { timings: FAST });
    await eventually(next, w.id, "끊긴 지시가 새 터미널에 전달됨", () => delivered(next, d) && next.texts().some((m) => m.title === "끊긴일끝"));
    // 한 번만, 새 터미널에 들어갔다. 옛 봉투는 거절로 닫혔고 새 봉투가 받았다.
    expect(sentTurns(next, w)).toHaveLength(1);
    expect(sentTurns(next, w)[0]!.terminal).toBe(next.member(w.id).paneId!);
    expect(next.member(w.id).paneId).not.toBe(old);
    const envelopes = next.store.listDispatches(w.id).filter((x) => x.items.some((i) => i.deliveryId === d));
    expect(envelopes[0]).toMatchObject({ transportState: "rejected", identity: { terminalId: old } });
    expect(envelopes.at(-1)).toMatchObject({ transportState: "accepted", identity: { terminalId: next.member(w.id).paneId } });
    // 넣지 못한 것은 '하던 일'이 아니다: 총괄에게 중단을 알리지 않고, 이어가기 글도 넣지 않는다.
    expect(next.texts().some((m) => m.body.includes("중단"))).toBe(false);
    expect(next.turns(w.id).some((x) => x.prompt.startsWith("[시스템] Mac이나"))).toBe(false);
    // 스스로 보류를 풀었다는 것이 그 팀장의 활동에 남는다.
    expect(next.store.listActivity(w.id).some((a) => a.text.includes("세션 기록에 받은 흔적이 없습니다"))).toBe(true);
  }, 30_000);

  test("세션 기록에 수신 흔적이 있으면(받았음), 다시 뜬 서버가 대표의 깨우기를 기다리지 않고 전달됨으로 확정한다", async () => {
    const { t, w, d } = await unknownSend(true);
    const next = await macRestart(t, [w.id], { timings: FAST });
    await eventually(next, w.id, "세션 기록의 수신 근거로 전달됨 확정", () => delivered(next, d));
    expect(sentTurns(next, w)).toHaveLength(1);
  }, 30_000);

  test("대표가 그 팀장을 깨우면, 못 받은 지시를 새 터미널에 다시 넣고 뒤에 온 지시도 전달한다", async () => {
    const { t, w, d } = await unknownSend(false);
    const next = await macRestart(t, [w.id], { timings: FAST });
    await next.orch.resumeMember(w.id);
    const second = await instruct(next, w, "새 일 @fake:post=새일끝");
    await eventually(next, w.id, "깨운 뒤 끊긴 지시와 새 지시가 모두 전달됨", () => delivered(next, d) && delivered(next, second));
    expect(sentTurns(next, w)).toHaveLength(1);
  }, 30_000);

  test("받았던 지시는 대표가 깨우면 세션 기록의 수신 근거로 전달됨으로 확정되고, 다시 넣지 않는다", async () => {
    const { t, w, d } = await unknownSend(true);
    const next = await macRestart(t, [w.id], { timings: FAST });
    await next.orch.resumeMember(w.id);
    await next.waitFor("수신 확정", () => delivered(next, d), 30_000);
    expect(next.store.getDeliveryRecovery(d)).toMatchObject({ phase: "resolved" });
    expect(next.store.getDeliveryRecovery(d)!.evidence.some((e) => e.location === "received_input" && e.verdict === "present" && e.source !== "transport")).toBe(true);
    expect(sentTurns(next, w)).toHaveLength(1);
    // 보류가 풀려 뒤에 온 지시도 나간다.
    const second = await instruct(next, w, "새 일 @fake:post=새일끝");
    await next.waitFor("새 지시 전달", () => delivered(next, second));
  }, 30_000);

  test("엔진이 답하지 않는 동안에는 못 받은 지시를 다시 넣지 않고, 엔진이 답해 터미널의 사라짐이 확인된 뒤에 다시 넣는다", async () => {
    const { t, w, d } = await unknownSend(false);
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    await t.core.setRefusing(true); // 엔진이 아직 안 떴다. 답이 없는 것은 터미널이 사라졌다는 근거가 아니다.
    const next = await t.restart({ timings: FAST });
    cleanups.push(() => next.close());
    await Bun.sleep(QUIET_MS);
    expect(next.store.requireDelivery(d)).toMatchObject({ status: "held", holdReason: "delivery_unknown" });
    expect(next.store.listDispatches(w.id).at(-1)).toMatchObject({ transportState: "unknown" });
    expect(next.runs(w.id)).toHaveLength(1);
    await t.core.setRefusing(false);
    await eventually(next, w.id, "엔진이 답한 뒤 끊긴 지시가 새 터미널에 전달됨", () => delivered(next, d), 20_000);
    expect(sentTurns(next, w)).toHaveLength(1);
  }, 40_000);

  test("세션 기록을 끝까지 읽지 못하면 스스로 다시 넣지 않고 대표에게 묻는다. '그만 보내기'를 누르면 보류가 풀려 뒤에 온 지시가 전달된다", async () => {
    const { t, w, d } = await unknownSend(false);
    const next = await macRestartWithTornLog(t, w);
    await next.waitFor("대표 확인으로 넘어감", () => next.store.getDeliveryRecovery(d)?.phase === "needs_owner");
    expect(next.store.getDeliveryRecovery(d)).toMatchObject({ phase: "needs_owner", reason: "log_incomplete" });
    const second = await instruct(next, w, "새 일 @fake:post=새일끝");
    await Bun.sleep(QUIET_MS);
    // 받았는지 모르는 채로는 그 지시도, 뒤에 온 지시도 넣지 않는다.
    expect(sentTurns(next, w)).toHaveLength(0);
    expect(delivered(next, second)).toBe(false);
    expect(next.orch.deliveryRecovery.memberNotices(w.id).items.find((i) => i.deliveryId === d)?.allowedActions).toEqual(["recheck", "retry_with_risk", "stop_retry"]);
    await ownerAction(next, d, "stop_retry");
    await next.waitFor("새 지시 전달", () => delivered(next, second), 20_000);
    expect(next.store.requireDelivery(d).status).toBe("failed");
    expect(sentTurns(next, w)).toHaveLength(0);
  }, 40_000);

  test("세션 기록을 읽지 못한 지시에 대표가 '중복 위험 동의 재전송'을 누르면, 사라진 옛 터미널이 아니라 지금 터미널에 다시 넣는다", async () => {
    const { t, w, d } = await unknownSend(false);
    const next = await macRestartWithTornLog(t, w);
    await next.waitFor("대표 확인으로 넘어감", () => next.store.getDeliveryRecovery(d)?.phase === "needs_owner");
    await next.waitFor("다시 열림", () => !!next.member(w.id).paneId && next.runs(w.id).length === 2);
    await ownerAction(next, d, "retry_with_risk");
    await eventually(next, w.id, "동의 뒤 지금 터미널에 전달됨", () => delivered(next, d) && next.texts().some((m) => m.title === "끊긴일끝"));
    expect(sentTurns(next, w)).toHaveLength(1);
    expect(sentTurns(next, w)[0]!.terminal).toBe(next.member(w.id).paneId!);
    expect(next.store.listActivity(w.id).some((a) => a.text.includes("중복 위험 동의를 받아 다시 열린 세션에 다시 보냅니다"))).toBe(true);
  }, 40_000);
});

// ───────────────────────── 2. 조작 결과 모름 · 설정 전환 중 끊김 ─────────────────────────
describe("조작 결과 모름(control_unknown)을 받은 터미널이 사라진 뒤", () => {
  /** 병렬 설정 명령(/effort ultracode on)의 답이 끊겨 control_unknown · parallel_unknown 보류가 걸린 팀장. 지시 하나가 줄 서 있다. */
  async function controlUnknown() {
    const t = await setup({ runnerDeps: QUICK_RPC });
    const w = await worker(t);
    await warm(t, w);
    t.core.intercept((call) => call.method === "terminal.send" && String(call.params.text).startsWith("/effort") ? "drop" : undefined);
    const d = (await t.orch.assign(t.project.id, w.handle, { text: "넓은 일 @fake:post=넓은일끝", parallel: true })).delivery.id;
    t.core.intercept(null);
    expect(t.member(w.id).lastError).toStartWith("control_unknown:");
    expect(t.store.deferredMemberConfig(w.id)?.signature).toStartWith("parallel_unknown:");
    return { t, w, d };
  }

  test("다시 뜬 서버가 그 보류를 풀고 밀린 지시를 새 터미널에 넣는다", async () => {
    const { t, w, d } = await controlUnknown();
    const next = await macRestart(t, [w.id]);
    await eventually(next, w.id, "밀린 지시가 새 터미널에 전달됨", () => delivered(next, d));
    expect(next.store.deferredMemberConfig(w.id)).toBeNull();
    expect(next.store.listActivity(w.id).some((a) => a.text.includes("병렬 설정을 받은 터미널이 끝나"))).toBe(true);
  }, 40_000);

  test("터미널이 사라진 것이 확인되면 다시 열기 전에 이미 보류가 풀려 있다(스스로 다시 열지 못해도 새 지시가 연다)", async () => {
    const { t, w, d } = await controlUnknown();
    // 서버가 스스로 다시 여는 길을 막는다: 그 길에 기대지 않고도 보류가 풀려야 한다.
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    t.core.intercept((call) => call.method === "terminal.run" ? { error: { kind: "unavailable", message: "engine is starting" } } : undefined);
    const next = await t.restart();
    cleanups.push(() => next.close());
    await next.waitFor("꺼짐 확인", () => next.member(w.id).status === "offline" && next.member(w.id).paneId === null);
    expect(next.store.deferredMemberConfig(w.id)).toBeNull();
    expect(next.member(w.id).lastError ?? "").not.toContain("control_unknown");
    expect(delivered(next, d)).toBe(false);
    t.core.intercept(null);
    const second = await instruct(next, w, "새 일 @fake:post=새일끝");
    await eventually(next, w.id, "새 지시가 꺼진 팀장을 열어 밀린 지시와 함께 전달됨", () => delivered(next, d) && delivered(next, second));
  }, 40_000);

  test("대표가 깨우면 밀린 지시가 전달된다", async () => {
    const { t, w, d } = await controlUnknown();
    const next = await macRestart(t, [w.id]);
    await next.orch.resumeMember(w.id);
    await next.waitFor("밀린 지시 전달", () => delivered(next, d));
    expect(next.store.deferredMemberConfig(w.id)).toBeNull();
    expect(next.member(w.id).lastError ?? "").not.toContain("control_unknown");
  }, 40_000);
});

describe("설정 변경으로 세션을 다시 열다 끊긴 뒤", () => {
  /** 모델·노력 설정을 바꾸면 쉬는 세션을 끝내고 같은 대화로 다시 연다. 그 끝내기(terminal.kill)의 답이 끊겨 fresh_session 의도가 미확정으로 남는다. */
  async function unknownSettingsStop(timings: CoreSetupOptions["timings"] = {}) {
    const t = await setup({ timings });
    const w = await worker(t);
    await warm(t, w);
    t.core.intercept((call) => { if (call.method === "terminal.kill") { t.core.setDown(true); return "drop"; } return undefined; });
    await t.orch.patchMemberConfig(w.id, { effortOverride: "high" }).catch(() => {});
    t.core.intercept(null); t.core.setDown(false);
    expect(pendingLifecycle(t, w.id)).toEqual(["fresh_session/unknown"]);
    return { t, w };
  }

  test("끝내기 결과를 모르는 채(fresh_session 미확정) 터미널이 사라졌으면, 다시 뜬 서버가 그 의도를 닫고 지시를 전달한다", async () => {
    const { t, w } = await unknownSettingsStop();
    const session = t.member(w.id).sessionId;
    const next = await macRestart(t, [w.id]);
    const d = await instruct(next, w, "새 일 @fake:post=새일끝");
    await eventually(next, w.id, "미확정 의도를 닫고 지시가 새 터미널에 전달됨", () => delivered(next, d) && pendingLifecycle(next, w.id).length === 0);
    // 같은 대화를 이어 열었다. 실패로 답했던 설정 변경은 적용되지 않았고, 그 사실이 활동에 남는다.
    expect(next.member(w.id).sessionId).toBe(session);
    expect(next.runs(w.id).at(-1)).toMatchObject({ resumeFlag: session });
    expect(next.store.listActivity(w.id).some((a) => a.text.includes("터미널이 끝난 것을 확인해 그 작업을 닫았습니다"))).toBe(true);
    // 막혀 있던 설정 변경을 다시 할 수 있다(예전에는 '세션을 처리하는 중입니다'로 영영 거절됐다).
    await next.waitFor("새 일 보고", () => next.texts().some((m) => m.title === "새일끝"));
    await next.idle(w.id);
    await next.orch.patchMemberConfig(w.id, { effortOverride: "high" });
    expect(effortOf(next, w.id)).toBe("high");
    expect(next.runs(w.id).at(-1)).toMatchObject({ resumeFlag: session });
  }, 40_000);

  test("끝내기 결과를 모르는데 터미널이 그대로 살아 있으면(재시작 없음), 그 의도를 닫아 전달과 설정 변경이 다시 된다", async () => {
    const { t, w } = await unknownSettingsStop();
    const before = t.member(w.id).paneId;
    // 끝내기 요청은 엔진에 닿지 않았다: 터미널은 살아 있다. 재우기·깨우기·전달이 모두 이 의도에 막혀 있었다.
    expect(t.core.terminals().find((x) => x.address === before)?.state).toBe("live");
    await t.waitFor("살아 있는 터미널을 확인해 의도를 닫음", () => pendingLifecycle(t, w.id).length === 0);
    expect(t.store.listActivity(w.id).some((a) => a.text.includes("터미널이 그대로 살아 있어 그 작업을 닫았습니다"))).toBe(true);
    // 같은 터미널이 그대로 일한다.
    const d = await instruct(t, w, "새 일 @fake:post=새일끝");
    await eventually(t, w.id, "살아 있는 세션에 지시가 전달됨", () => delivered(t, d));
    expect(t.member(w.id).paneId).toBe(before);
    expect(t.runs(w.id)).toHaveLength(1);
    await t.waitFor("새 일 보고", () => t.texts().some((m) => m.title === "새일끝"));
    await t.idle(w.id);
    await t.orch.patchMemberConfig(w.id, { effortOverride: "high" });
    expect(effortOf(t, w.id)).toBe("high");
    expect(liveTerminals(t, w.id)).toEqual([t.member(w.id).paneId!]);
  }, 40_000);

  test("끝내기 결과를 모르는 동안 엔진이 답하지 않으면 아무것도 정하지 않고, 대표의 깨우기는 성공으로 답하지 않는다", async () => {
    const { t, w } = await unknownSettingsStop();
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    await t.core.setRefusing(true);
    const next = await t.restart();
    cleanups.push(() => next.close());
    await Bun.sleep(QUIET_MS);
    expect(pendingLifecycle(next, w.id)).toEqual(["fresh_session/unknown"]);
    expect(next.member(w.id).paneId).not.toBeNull();
    await expect(next.orch.resumeMember(w.id)).rejects.toMatchObject({ status: 409 });
    await t.core.setRefusing(false);
    await next.waitFor("엔진이 답한 뒤 의도를 닫음", () => pendingLifecycle(next, w.id).length === 0, 20_000);
    const d = await instruct(next, w, "새 일 @fake:post=새일끝");
    await eventually(next, w.id, "지시가 새 터미널에 전달됨", () => delivered(next, d), 20_000);
  }, 60_000);

  test("끝내기 결과를 모르는 팀장을 대표가 깨우면, 그 자리에서 터미널이 사라진 것을 확인해 의도를 닫고 같은 대화로 다시 연다", async () => {
    const { t, w } = await unknownSettingsStop();
    const session = t.member(w.id).sessionId;
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    await t.core.setRefusing(true);
    // 다시 뜬 서버는 엔진이 답하지 않아 아무것도 정하지 못했고, 다음 점검은 멀었다. 그 사이 엔진이 떴고 대표가 깨운다.
    const next = await t.restart({ timings: { ...FAST, healthMs: 60_000, tickMs: 60_000 } });
    cleanups.push(() => next.close());
    expect(pendingLifecycle(next, w.id)).toEqual(["fresh_session/unknown"]);
    await t.core.setRefusing(false);
    const woken = await next.orch.resumeMember(w.id);
    expect(pendingLifecycle(next, w.id)).toEqual([]);
    expect(woken.paneId).not.toBeNull();
    expect(liveTerminals(next, w.id)).toEqual([woken.paneId!]);
    expect(next.runs(w.id).at(-1)).toMatchObject({ resumeFlag: session });
    const d = await instruct(next, w, "새 일 @fake:post=새일끝");
    await eventually(next, w.id, "깨운 팀장에게 지시가 전달됨", () => delivered(next, d));
  }, 40_000);

  test("새 세션 띄우기가 확정 실패해 터미널 없이 error 로 남은 팀장에게 지시가 오면, 다시 띄워 전달한다", async () => {
    const t = await setup();
    const w = await worker(t);
    await warm(t, w);
    // '새 세션으로'를 눌렀는데 엔진이 띄우기를 거절했다(엔진이 막 뜨는 중 등). 옛 터미널은 이미 끝냈다.
    t.core.intercept((call) => call.method === "terminal.run" ? { error: { kind: "unavailable", message: "engine is starting" } } : undefined);
    await t.orch.freshMemberSession(w.id).catch(() => {});
    t.core.intercept(null);
    expect(t.member(w.id)).toMatchObject({ status: "error", paneId: null });
    const next = await macRestart(t, [w.id]);
    const d = await instruct(next, w, "새 일 @fake:post=새일끝");
    await eventually(next, w.id, "터미널 없는 팀장을 다시 띄워 지시가 전달됨", () => delivered(next, d));
  }, 40_000);

  test("터미널 없이 error 로 남은 팀장을 대표가 깨우면 실제로 다시 띄운다(성공으로 답하고 아무 일도 안 하지 않는다)", async () => {
    // 서버를 다시 띄우지 않는다: 엔진 점검이 그 팀장을 꺼짐으로 돌리기 전에 대표가 깨워도 열려야 한다.
    const t = await setup({ timings: { healthMs: 60_000 } });
    const w = await worker(t);
    await warm(t, w);
    t.core.intercept((call) => call.method === "terminal.run" ? { error: { kind: "unavailable", message: "engine is starting" } } : undefined);
    await t.orch.freshMemberSession(w.id).catch(() => {});
    t.core.intercept(null);
    expect(t.member(w.id)).toMatchObject({ status: "error", paneId: null });
    const runs = t.runs(w.id).length;
    const woken = await t.orch.resumeMember(w.id);
    expect(woken.paneId).not.toBeNull();
    expect(t.runs(w.id)).toHaveLength(runs + 1);
    expect(liveTerminals(t, w.id)).toEqual([woken.paneId!]);
    const d = await instruct(t, w, "새 일 @fake:post=새일끝");
    await eventually(t, w.id, "깨운 팀장에게 지시가 전달됨", () => delivered(t, d));
  }, 40_000);
});

// ───────────────────────── 3·6. 띄우기·끝내기·보관 결과 모름 ─────────────────────────
describe("띄우기·끝내기 결과 모름 뒤", () => {
  test("재우기 결과를 모르는 채 터미널이 사라졌으면, 다시 뜬 서버가 잠듦으로 확정하고 새 지시에 다시 깨운다", async () => {
    const t = await setup();
    const w = await worker(t);
    await warm(t, w);
    t.core.intercept((call) => { if (call.method === "terminal.kill") { t.core.setDown(true); return "drop"; } return undefined; });
    await expect(t.orch.sleepMember(w.id)).rejects.toThrow();
    t.core.intercept(null); t.core.setDown(false);
    expect(pendingLifecycle(t, w.id)).toEqual(["sleep/unknown"]);
    const next = await macRestart(t, [w.id]);
    await next.waitFor("잠듦 확정", () => next.member(w.id).status === "asleep" && pendingLifecycle(next, w.id).length === 0);
    const d = await instruct(next, w, "새 일 @fake:post=새일끝");
    await next.waitFor("새 지시 전달", () => delivered(next, d));
    expect(next.runs(w.id).at(-1)).toMatchObject({ resumeFlag: next.member(w.id).sessionId });
  }, 40_000);

  test("띄우기 결과를 모르는 채(터미널은 끝내 안 생김) 서버가 다시 뜨면, 유예 뒤 기동을 취소하고 다시 띄워 첫 지시를 전달한다", async () => {
    const t = await setup({ runnerDeps: QUICK_RPC });
    t.core.intercept((call) => call.method === "terminal.run" ? "drop" : undefined);
    await expect(t.orch.addMember(t.project.id, { name: "영희", handle: "younghee", role: "개발", firstInstruction: "첫 지시 @fake:post=첫지시끝" })).rejects.toThrow();
    t.core.intercept(null);
    const w = t.store.findMember(t.project.id, "younghee")!;
    expect(pendingLifecycle(t, w.id)).toEqual(["start/unknown"]);
    const next = await macRestart(t, [w.id]);
    await next.waitFor("첫 지시 보고", () => next.texts().some((m) => m.title === "첫지시끝"));
    expect(pendingLifecycle(next, w.id)).toEqual([]);
    expect(next.runs(w.id)).toHaveLength(1);
  }, 40_000);

  test("보관 중 한 팀장의 끝내기 결과를 모르는 채 터미널이 사라졌으면, 다시 뜬 서버가 잠듦으로 정리하고 프로젝트는 다시 보관할 수 있다", async () => {
    const t = await setup();
    const a = await worker(t, "가", "ga");
    const b = await worker(t, "나", "na");
    await t.orch.assign(t.project.id, a.handle, { text: "일 @fake:post=가끝" });
    await t.orch.assign(t.project.id, b.handle, { text: "일 @fake:post=나끝" });
    await t.waitFor("둘 다 보고", () => ["가끝", "나끝"].every((x) => t.texts().some((m) => m.title === x)));
    await t.idle(a.id); await t.idle(b.id);
    let kills = 0;
    t.core.intercept((call) => { if (call.method === "terminal.kill" && ++kills === 2) { t.core.setDown(true); return "drop"; } return undefined; });
    await expect(t.orch.patchProject(t.project.id, { archived: true })).rejects.toThrow();
    t.core.intercept(null); t.core.setDown(false);
    expect(pendingLifecycle(t, b.id)).toEqual(["archive/unknown"]);
    const next = await macRestart(t, [a.id, b.id]);
    await next.waitFor("둘 다 잠듦", () => [a, b].every((m) => next.member(m.id).status === "asleep" && pendingLifecycle(next, m.id).length === 0));
    expect(next.store.requireProject(next.project.id).archived).toBe(false);
    // 보관이 중간에 멈춘 프로젝트는 그대로 쓸 수 있고(새 지시에 깨어난다), 다시 보관할 수도 있다.
    const d = await instruct(next, b, "새 일 @fake:post=새일끝");
    await next.waitFor("새 지시 전달", () => delivered(next, d));
    await next.waitFor("새 일 보고", () => next.texts().some((m) => m.title === "새일끝"));
    await next.idle(b.id);
    await next.orch.patchProject(next.project.id, { archived: true });
    expect(next.store.requireProject(next.project.id).archived).toBe(true);
  }, 60_000);
});

// ───────────────────────── 4. 조작권 · 승인 대기 · 사용 한도 ─────────────────────────
describe("터미널 조작권·승인 대기·사용 한도 보류가 사라진 터미널에 묶인 뒤", () => {
  test("사라진 터미널에 묶인 조작권은 재시작 뒤의 전달을 막지 않는다(예전에는 만료까지 최대 5분 막았다)", async () => {
    const t = await setup();
    const w = await worker(t);
    await warm(t, w);
    await t.orch.terminalControl(w.id, { action: "claim" }); // 대표가 앱에서 터미널을 직접 조작하던 중이었다.
    const next = await macRestart(t, [w.id]);
    const d = await instruct(next, w, "새 일 @fake:post=새일끝");
    await eventually(next, w.id, "옛 터미널의 조작권에 막히지 않고 지시가 전달됨", () => delivered(next, d));
  }, 40_000);

  test("승인 창 앞에서 멈춰 보류된 지시는, 터미널이 사라졌으면 다시 뜬 서버가 새 터미널에 넣는다", async () => {
    const t = await setup();
    const w = await worker(t);
    await warm(t, w);
    t.core.setStatus(w.id, { state: "blocked", kind: "permission" });
    await t.waitFor("막힘", () => t.member(w.id).status === "blocked");
    const d = await instruct(t, w, "새 일 @fake:post=새일끝");
    expect(t.store.requireDelivery(d)).toMatchObject({ status: "held", holdReason: "blocked" });
    const next = await macRestart(t, [w.id]);
    await next.waitFor("새 터미널에 전달", () => delivered(next, d));
    expect(next.runs(w.id).at(-1)).toMatchObject({ resumeFlag: next.member(w.id).sessionId });
  }, 40_000);

  test("사용 한도로 보류된 팀장은 터미널이 사라져도 보류가 남고, 대표가 한도 카드에 답하면 새 터미널에서 이어 간다", async () => {
    const t = await setup();
    const w = await worker(t);
    await warm(t, w);
    await t.orch.assign(t.project.id, w.handle, { text: "한도에 걸리는 일 @fake:error=usage_limit_reached" });
    await t.waitFor("한도 카드", () => t.store.listDecisions(t.project.id).some((x) => x.kind === "usage_limit"));
    const d = await instruct(t, w, "새 일 @fake:post=새일끝");
    expect(t.store.requireDelivery(d)).toMatchObject({ status: "held", holdReason: "usage_limit" });
    const next = await macRestart(t, [w.id]);
    await Bun.sleep(600); // '없음'을 보는 대기: 한도가 풀렸다는 근거 없이 스스로 보내지 않는다.
    expect(next.orch.apiRecovery.holdReason(w.id)).toBe("usage_limit");
    expect(delivered(next, d)).toBe(false);
    const card = next.store.listDecisions(next.project.id).find((x) => x.kind === "usage_limit")!;
    await next.orch.answerDecision(card.id, { choice: "resume" });
    await next.waitFor("이어가기 뒤 전달", () => delivered(next, d));
    expect(next.runs(w.id).at(-1)).toMatchObject({ resumeFlag: next.member(w.id).sessionId });
  }, 40_000);
});

// ───────────────────────── 7. 압축 ─────────────────────────
describe("압축 상태가 사라진 터미널에 묶인 뒤", () => {
  /**
   * 묶인 터미널이 적히지 않은 미확정 압축: 압축은 '불확실'인데 실행기가 기준선(baseline.coreCompact, 명령을 받을 터미널)을 저장한 적이 없다.
   * 예전 서버는 압축 명령을 넣기 전의 확인 읽기에서 전달 단계 제한이 먼저 걸리면 이렇게 적었고, 어떤 조작으로도 풀리지 않았다.
   * 지금 서버는 그 경우를 불확실로 적지 않으므로(아래 '넣기 전에 단계 제한이 걸린 압축' 시험), 예전 서버가 DB 에 남긴 모양을 그대로 적어 넣는다.
   * 첫 서버는 틱을 돌리지 않는다: 재시작 전에 먼저 풀려 버리면 보려는 상태가 아니다.
   */
  async function baselineLessCompact() {
    const t = await setup({ timings: { tickMs: 60_000 } });
    const w = await worker(t);
    await warm(t, w);
    const state = t.store.ensureContextState(w.id);
    expect(state.baseline?.coreCompact ?? null).toBeNull();
    t.store.saveContextState({ ...state, compaction: { id: crypto.randomUUID(), trigger: "manual", phase: "uncertain", reason: "send_uncertain", requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null } });
    return { t, w };
  }
  const uncertainCompact = (t: CoreEnv, w: Member) => t.store.getContextState(w.id)!.compaction?.phase === "uncertain";

  test("기준선(baseline) 없는 미확정 압축이 남은 팀장의 터미널이 사라졌으면, 다시 뜬 서버가 그 압축을 닫고 지시를 전달한다", async () => {
    const { t, w } = await baselineLessCompact();
    expect(uncertainCompact(t, w)).toBe(true);
    const next = await macRestart(t, [w.id]);
    const d = await instruct(next, w, "새 일 @fake:post=새일끝");
    await eventually(next, w.id, "묶인 터미널 없는 미확정 압축을 닫고 지시가 전달됨", () => delivered(next, d));
    expect(next.store.getContextState(w.id)!.compaction).toMatchObject({ phase: "failed", reason: "interrupted" });
    expect(next.store.listActivity(w.id).some((a) => a.text.includes("넣지 못한 압축이 확인 대기로 남아 있어 닫았습니다"))).toBe(true);
    expect(next.turns(w.id).filter((x) => x.prompt.startsWith("/compact"))).toHaveLength(0);
  }, 40_000);

  test("기준선 없는 미확정 압축이 남은 팀장을 대표가 깨워도, 주인 없는 터미널과 미확정 기동을 남기지 않고 지시를 전달한다", async () => {
    const { t, w } = await baselineLessCompact();
    expect(uncertainCompact(t, w)).toBe(true);
    const next = await macRestart(t, [w.id]);
    await next.orch.resumeMember(w.id);
    const d = await instruct(next, w, "새 일 @fake:post=새일끝");
    await eventually(next, w.id, "깨운 터미널이 명부에 붙고 지시가 전달됨", () => {
      const live = liveTerminals(next, w.id);
      return delivered(next, d) && pendingLifecycle(next, w.id).length === 0 && live.length === 1 && live[0] === next.member(w.id).paneId;
    });
  }, 40_000);

  test("기준선 없는 미확정 압축은 터미널이 살아 있어도(재시작 없음) 다음 전달 때 닫히고 지시가 나간다", async () => {
    const { t, w } = await baselineLessCompact();
    const pane = t.member(w.id).paneId;
    const d = await instruct(t, w, "새 일 @fake:post=새일끝");
    await eventually(t, w.id, "미확정 압축을 닫고 같은 터미널에 지시가 전달됨", () => delivered(t, d));
    expect(t.member(w.id).paneId).toBe(pane);
    expect(t.runs(w.id)).toHaveLength(1);
    expect(t.store.getContextState(w.id)!.compaction).toMatchObject({ phase: "failed", reason: "interrupted" });
  }, 40_000);

  test("넣기 전에 단계 제한이 걸린 압축은 불확실로 남지 않고 다시 예약돼, 엔진이 답하면 한 번 돌고 뒤따르는 지시가 나간다", async () => {
    // 압축 명령을 넣기 전의 확인 읽기(terminal.get)가 답하지 않는 사이 전달 단계 제한(300ms)이 먼저 걸린다. 실행기는 기준선을 저장하기 전이다.
    const t = await setup({ timings: { pumpStageTimeoutMs: 300 }, runnerDeps: { rpcTimeoutMs: 700 } });
    const w = await worker(t);
    await warm(t, w);
    let hang = true;
    t.core.intercept((call) => hang && call.method === "terminal.get" ? "drop" : undefined);
    await Bun.sleep(80); // 주기 관측 하나가 답 없는 조회에 걸려 있게 한다. 압축의 확인 읽기는 그 조회에 얹혀 기다린다.
    await t.orch.compactMember(w.id).catch(() => {});
    const state = t.store.getContextState(w.id)!;
    expect(state.compaction).toMatchObject({ phase: "queued", reason: "backend_down" });
    expect(state.baseline?.coreCompact ?? null).toBeNull();
    expect(t.turns(w.id).filter((x) => x.prompt.startsWith("/compact"))).toHaveLength(0);
    hang = false; t.core.intercept(null);
    const d = await instruct(t, w, "새 일 @fake:post=새일끝");
    await eventually(t, w.id, "다시 예약된 압축이 돈 뒤 지시가 전달됨", () => delivered(t, d) && t.store.getContextState(w.id)!.compaction?.phase === "succeeded", 20_000);
    const order = t.turns(w.id).map((x) => x.prompt.split(" ")[0]).filter((x) => x === "/compact" || x === "[총괄]");
    expect(order.slice(-2)).toEqual(["/compact", "[총괄]"]);
    expect(t.turns(w.id).filter((x) => x.prompt.startsWith("/compact"))).toHaveLength(1);
  }, 60_000);

  test("예약(queued)만 된 압축은 터미널이 사라져도 남아 있다가, 스스로 다시 열린 터미널에서 가장 먼저 돌고 이어가기 글과 새 지시가 뒤따른다", async () => {
    const t = await setup();
    const w = await worker(t);
    await warm(t, w);
    await t.orch.assign(t.project.id, w.handle, { text: "오래 걸리는 일 @fake:hold" });
    await t.waitFor("일하는 중", () => t.core.held(w.id));
    await t.orch.compactMember(w.id);
    const queued = t.store.getContextState(w.id)!.compaction!;
    expect(queued).toMatchObject({ phase: "queued" });
    // 서버는 재시작으로 꺼진 팀장을 새 지시를 기다리지 않고 스스로 다시 연다. 예약된 압축은 그 터미널에서 곧바로 돈다.
    const next = await macRestart(t, [w.id]);
    const d = await instruct(next, w, "새 일 @fake:post=새일끝");
    await next.waitFor("새 지시 전달", () => delivered(next, d));
    // 재시작을 넘어 남은 것은 같은 예약이다(터미널이 사라졌다고 닫히지 않았다).
    expect(next.store.listActivity(w.id).some((a) => a.text.includes("그 압축을 닫았습니다"))).toBe(false);
    expect(next.store.getContextState(w.id)!.compaction).toMatchObject({ phase: "succeeded", requestedAt: queued.requestedAt });
    // 순서: 예약된 압축 → 턴 도중 끊긴 일의 이어가기 글 → 새 지시.
    const after = next.turns(w.id).filter((x) => x.terminal === next.member(w.id).paneId).map((x) => x.prompt.split(" ")[0]);
    expect(after).toEqual(["/compact", "[시스템]", "[총괄]"]);
  }, 40_000);
});

// ───────────────────────── 8·9. 실행 엔진의 늦은 기동 · 엔진만 재시작 · 겹친 깨우기 ─────────────────────────
describe("실행 엔진과 서버가 어긋나게 다시 뜰 때", () => {
  test("엔진이 서버보다 늦게 뜨면 그동안은 아무것도 띄우거나 넣지 않고, 엔진이 답하면 사라진 터미널을 확인해 새로 열어 전달한다", async () => {
    const t = await setup();
    const w = await worker(t);
    await warm(t, w);
    await t.stopServer();
    t.core.exit(w.id, 1, "holder_lost");
    await t.core.setRefusing(true); // 엔진이 아직 안 떴다: 소켓 자체가 없다.
    const next = await t.restart();
    cleanups.push(() => next.close());
    const d = await instruct(next, w, "새 일 @fake:post=새일끝");
    await Bun.sleep(800); // '없음'을 보는 대기.
    expect(delivered(next, d)).toBe(false);
    expect(next.runs(w.id)).toHaveLength(1);
    // 답이 없는 것은 '터미널이 없다'는 근거가 아니다: 명부의 터미널을 지우지 않는다.
    expect(next.member(w.id).paneId).not.toBeNull();
    await t.core.setRefusing(false);
    await next.waitFor("엔진이 뜬 뒤 전달", () => delivered(next, d), 30_000);
    expect(next.runs(w.id)).toHaveLength(2);
    expect(next.runs(w.id).at(-1)).toMatchObject({ resumeFlag: next.member(w.id).sessionId });
  }, 60_000);

  test("엔진만 다시 시작돼 옛 터미널을 '모른다'고 답하면(서버는 그대로), 그 팀장을 같은 세션으로 스스로 다시 열고 새 지시를 전달한다", async () => {
    const t = await setup();
    const w = await worker(t);
    await warm(t, w);
    const session = t.member(w.id).sessionId;
    const lost = new Set([t.core.terminalOf(w.id)!.address]);
    t.core.intercept((call) => call.method === "terminal.list" ? { result: { terminals: t.core.terminals().filter((x) => !lost.has(x.address)) } }
      : lost.has(String(call.params.terminal)) ? { error: { kind: "not_found", message: "no such terminal" } } : undefined);
    // 꺼짐은 잠깐이다: 엔진이 그 터미널을 모른다고 확정해 답하면 서버가 곧바로 같은 세션을 다시 연다.
    await t.waitFor("스스로 다시 엶", () => t.runs(w.id).length === 2 && !!t.member(w.id).paneId && !lost.has(t.member(w.id).paneId!) && t.member(w.id).status !== "offline");
    expect(t.runs(w.id).at(-1)).toMatchObject({ resumeFlag: session });
    const d = await instruct(t, w, "새 일 @fake:post=새일끝");
    await t.waitFor("새 터미널에 전달", () => delivered(t, d));
    expect(t.runs(w.id)).toHaveLength(2);
  }, 40_000);

  test("재시작 직후 대표의 깨우기 두 번·새 지시·자동 전달이 한꺼번에 겹쳐도 그 팀장의 터미널은 하나만 생긴다", async () => {
    const t = await setup();
    const w = await worker(t);
    await warm(t, w);
    const next = await macRestart(t, [w.id]);
    let d = "";
    await Promise.all([
      next.orch.resumeMember(w.id).catch(() => {}),
      instruct(next, w, "새 일 @fake:post=새일끝").then((id) => { d = id; }),
      next.orch.resumeMember(w.id).catch(() => {}),
      next.orch.pump(w.id),
    ]);
    await next.waitFor("새 지시 전달", () => !!d && delivered(next, d));
    await next.waitFor("새 일 보고", () => next.texts().some((m) => m.title === "새일끝"));
    expect(liveTerminals(next, w.id)).toEqual([next.member(w.id).paneId!]);
    expect(next.runs(w.id)).toHaveLength(2);
    expect(next.turns(w.id).filter((x) => x.prompt.includes("새 일"))).toHaveLength(1);
  }, 40_000);
});
