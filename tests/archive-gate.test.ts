// 보관·전달·연결의 경계(spec §3.1·§6). 운영과 같은 실행기 종류(core)로 돈다: 가짜 core 소켓 + 실제 CoreRunner + 운영 배선의 총괄.
// 옛 시험은 kind "herdr" 가짜 실행기와 HerdrError 에 기댔다. 넘겨받은 칸(편입)·편입 해제만 보던 시험은 옛 실행기 전용이라 지웠다.
import { afterEach, describe, expect, test } from "bun:test";
import type { Member } from "../shared/types.ts";
import type { OrchestratorTimings } from "../server/orchestrator.ts";
import type { RunnerMember } from "../server/runner/types.ts";
import { IMPORT_HOLD_NOTE } from "../server/store.ts";
import { coreSetup, type CoreSetupOptions } from "./fixtures/core-harness.ts";

const closers: (() => Promise<void> | void)[] = [];
// 시험마다 닫는다. 파일 끝까지 두면 15ms 틱이 스무 개 넘게 쌓여 뒤 시험의 시간 판정을 민다.
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function setup(opts: { timings?: Partial<OrchestratorTimings>; runnerEnabled?: boolean; runnerDeps?: CoreSetupOptions["runnerDeps"] } = {}) {
  const core = await coreSetup({ timings: { tickMs: 15, retryMs: 5, inputBusyRetryMs: 5, ...opts.timings }, runnerDeps: opts.runnerDeps });
  closers.push(() => core.close());
  const { store, orch, runner } = core;
  const project = store.createProject({ name: "시험", cwd: core.home, runnerEnabled: opts.runnerEnabled ?? true });
  await orch.recover(); // 틱을 돌린다. 아직 정리할 것이 없다.
  const api = (method: string, path: string, body?: unknown, token = "code") =>
    fetch(`${core.base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const manual = async (name = "직접") => (await (await api("POST", "/agent/join", { project: project.id, name })).json()) as { member: Member; token: string };
  const tool = async (token: string, name: string, args: unknown) => (await (await api("POST", "/agent/tool", { name, args }, token)).json()) as { text: string; isError?: boolean };
  // 옛 가짜 실행기의 checks·stopped 자리. 실제 CoreRunner 의 종료 전 검사·종료를 그대로 부르고, 부른 것만 적는다.
  const checks: { id: string; whileWorking?: boolean }[] = [];
  const stopped: string[] = [];
  const realCheck = runner.checkStop.bind(runner), realStop = runner.stop.bind(runner);
  const hooks = { beforeCheck: null as ((m: RunnerMember) => void | Promise<void>) | null, beforeStop: null as ((m: RunnerMember) => void | Promise<void>) | null };
  runner.checkStop = async (m, o) => { checks.push({ id: m.id, whileWorking: o?.whileWorking }); await hooks.beforeCheck?.(m); return realCheck(m, o); };
  runner.stop = async (m, o) => { await hooks.beforeStop?.(m); await realStop(m, o); stopped.push(m.id); };
  /**
   * 서버가 띄운 직원. core 의 보관은 이어갈 세션 기록을 확인하므로(verifyArchiveSession) 실제 턴을 한 번 돌려 둔다.
   * 보고하고 끝내 '보고 보완' 턴이 붙지 않게 한다.
   */
  const firstTurn = async (m: Member) => {
    if (m.kind === "worker") await orch.assign(m.projectId, m.handle, { text: "준비 @fake:post=준비됨" });
    else await orch.sendUserMessage(m.projectId, { text: "준비 @fake:post=준비됨" });
    await core.waitFor("첫 턴", () => core.turns(m.id).some(c => c.outcome === "done"));
    await core.idle(m.id);
    return store.requireMember(m.id);
  };
  const managed = async (handle: string, name = handle) => firstTurn((await orch.addMember(project.id, { name, handle, role: "개발" })).member);
  return { ...core, project, api, manual, tool, checks, stopped, hooks, firstTurn, managed };
}
type Env = Awaited<ReturnType<typeof setup>>;

const until = async (cond: () => boolean, label: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`시간 초과: ${label}`);
    await Bun.sleep(5);
  }
};

describe("보관", () => {
  test("직접 세션의 보고가 보관된 총괄을 깨우지 않고, 꺼내면 그때 전달된다", async () => {
    const t = await setup();
    const lead = await t.firstTurn(await t.orch.ensureConductor(t.project.id));
    const m = await t.manual();
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true })).status).toBe(200);
    expect(t.store.requireMember(lead.id).status).toBe("asleep");
    const starts = t.runs().length;
    const sends = t.turns().length;
    expect((await t.tool(m.token, "post", { kind: "완료", title: "끝" })).isError).toBeFalsy();
    await Bun.sleep(80);
    expect(t.store.requireMember(lead.id).status).toBe("asleep");
    expect(t.runs().length).toBe(starts);
    expect(t.turns().length).toBe(sends);
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: false })).status).toBe(200);
    await until(() => t.turns().length > sends, "꺼낸 뒤 전달");
    expect(t.runs().length).toBe(starts + 1);
    // 깨울 때는 같은 세션을 --resume 으로 새 터미널에 이어 연다.
    expect(t.runs(lead.id).at(-1)!.resumeFlag).toBe(lead.sessionId);
    expect(t.turns(lead.id).at(-1)!.prompt).toContain("[보고 직접] 완료: 끝");
  });

  // 옛 시험: "보관 중에는 다시 열기·총괄 시작·실행 켜기·편입이 409 다". 편입(herdr 칸 넘겨받기)은 옛 실행기 전용이라 그 줄만 뺐다.
  test("보관 중에는 다시 열기·총괄 시작·실행 켜기가 409 다", async () => {
    const t = await setup({ runnerEnabled: false });
    const lead = t.store.createMember({ projectId: t.project.id, handle: "cs", name: "철수", role: "개발", kind: "worker", origin: "runner", status: "asleep", sessionId: "s1" });
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true })).status).toBe(200);
    expect((await t.api("POST", `/api/members/${lead.id}/resume`)).status).toBe(409);
    expect((await t.api("POST", `/api/projects/${t.project.id}/conductor/start`)).status).toBe(409);
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { runnerEnabled: true })).status).toBe(409);
    expect(t.runs().length).toBe(0);
    expect(t.store.requireProject(t.project.id).runnerEnabled).toBe(false);
    // 꺼내면서 켜는 것은 된다.
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: false, runnerEnabled: true })).status).toBe(200);
  });

  test("아직 전송을 시도하지 않은 대표 글은 보관했다 꺼내면 한 번 전달된다", async () => {
    const t = await setup({ timings: { tickMs: 60_000 } });
    const lead = await t.firstTurn(await t.orch.ensureConductor(t.project.id));
    // 옛 시험은 가짜 실행기를 바쁘다고 표시해 전송 시도를 미뤘다. core 에서는 동시 턴 상한이 찬 동안 전송을 시도하지 않는다:
    // 다른 프로젝트의 직원이 턴 자리를 쥐고 있는 사이 온 대표 글은 시도 0회로 줄에 남는다.
    t.store.patchSettings({ maxConcurrentTurns: 1 });
    const side = t.store.createProject({ name: "옆 프로젝트", cwd: t.home });
    const holder = (await t.orch.addMember(side.id, { name: "자리 쥔 직원", handle: "holder", role: "개발" })).member;
    await t.orch.assign(side.id, "holder", { text: "@fake:hold @fake:post=끝" });
    await t.waitFor("턴 자리 참", () => t.core.held(holder.id));
    const res = await t.api("POST", `/api/projects/${t.project.id}/messages`, { text: "대기 중 지시" });
    expect(res.status).toBe(200);
    const message = (await res.json()) as { id: string };
    const delivery = t.store.listPending(lead.id).find(d => d.refId === message.id)!;
    expect(delivery.attempts).toBe(0);
    expect(t.store.listDispatches(lead.id).filter(d => d.items.some(item => item.deliveryId === delivery.id))).toHaveLength(0);
    // 총괄은 쉬고 있다. 일하는 직원은 보관할 수 없다.
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true })).status).toBe(200);
    expect(t.store.requireDelivery(delivery.id)).toMatchObject({ status: "held", holdReason: "archived" });
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: false })).status).toBe(200);
    expect(t.core.release(holder.id)).toBe(true);
    await until(() => t.store.requireMessage(message.id).delivery === "delivered", "꺼낸 뒤 전달");
    expect(t.turns(lead.id).filter(c => c.prompt.includes("대기 중 지시"))).toHaveLength(1);
    expect(t.store.requireDelivery(delivery.id).attempts).toBe(1);
  });

  // 옛 시험: "input_busy만으로 미수신을 확정하지 않고 보관했다 꺼내도 재전송을 막는다".
  // 달라진 점 둘.
  // 1) core 의 input_busy 는 늘 '쓰지 않음'(not_written)이 확정된 거절이라 그 이름의 상황이 없다. 전달 여부를 모르는 상황은
  //    terminal.send 의 답이 오지 않을 때 생긴다.
  // 2) 옛 가짜 실행기는 그 상태에서도 쉬는 중이라 보관이 됐다. 실제 CoreRunner 는 풀리지 않은 입력이 있는 직원을 일하는 중으로 본다:
  //    보관 자체가 409 로 거절되고 아무것도 바뀌지 않는다. 꺼내는 단계는 그래서 없다.
  test("전달 여부를 모르는 글은 미수신으로 확정하지 않는다: 보관을 거절하고 다시 넣지 않는다", async () => {
    const t = await setup({ runnerDeps: { sendTimeoutMs: 150 } });
    const lead = await t.firstTurn(await t.orch.ensureConductor(t.project.id));
    const sentBefore = t.core.count("terminal.send");
    t.core.intercept(call => call.method === "terminal.send" ? "drop" : undefined);
    const res = await t.api("POST", `/api/projects/${t.project.id}/messages`, { text: "옛 지시" });
    expect(res.status).toBe(200);
    const message = (await res.json()) as { id: string };
    // 넣기를 시도했고(답이 오지 않는다) 제한 시간이 지나 그 전송의 결과가 '모름'으로 적힐 때까지 기다린다.
    await until(() => t.core.count("terminal.send") === sentBefore + 1 && t.store.listDispatches(lead.id).some(d => d.transportState === "unknown"), "전달 불명");
    expect(t.store.listPending(lead.id).find(d => d.refId === message.id)).toMatchObject({ status: "held", holdReason: "delivery_unknown" });
    t.core.intercept(null);
    const dispatches = t.store.listDispatches(lead.id);
    const delivery = t.store.listPending(lead.id).find(d => d.refId === message.id)!;
    expect(delivery.attempts).toBe(1);
    expect(t.core.count("terminal.send")).toBe(sentBefore + 1);
    expect(t.orch.deliveryRecovery.fenced(lead.id)).toBe(true);
    await t.orch.pump(lead.id); // 그 전달을 다루던 펌프가 끝난 뒤에 본다(도는 중이면 '세션을 처리하는 중'으로 거절된다).
    const refused = await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("일하는 중이라 보관할 수 없습니다");
    expect(t.store.requireProject(t.project.id).archived).toBe(false);
    expect(t.store.requireMember(lead.id).status).not.toBe("asleep");
    expect(t.store.listPending(lead.id).find((d) => d.refId === message.id)).toMatchObject({ status: "held", holdReason: "delivery_unknown" });
    await Bun.sleep(50);
    await t.orch.deliveryRecovery.tick();
    await t.orch.pump(lead.id);
    // 넣기는 그 한 번뿐이다. 가짜 CLI 는 그 글을 받은 적이 없다.
    expect(t.core.count("terminal.send")).toBe(sentBefore + 1);
    expect(t.turns(lead.id).some(c => c.prompt.includes("옛 지시"))).toBe(false);
    expect(t.store.requireDelivery(delivery.id).attempts).toBe(1);
    expect(t.store.listDispatches(lead.id)).toEqual(dispatches);
    expect(t.store.requireMessage(message.id).delivery).toBe("held");
    expect(t.orch.deliveryRecovery.fenced(lead.id)).toBe(true);
  });

  test("보관된 프로젝트의 ask 는 카드를 만들지 않고 도구 오류로 끝난다", async () => {
    const t = await setup({ runnerEnabled: false });
    const m = await t.manual();
    await t.tool(m.token, "wait", { timeoutMs: 1 }).catch(() => null);
    t.store.patchMember(m.member.id, { status: "idle" });
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true })).status).toBe(200);
    const r = await t.tool(m.token, "ask", { title: "물음", detail: "내용" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("보관");
    expect(t.store.listDecisions(t.project.id).length).toBe(0);
  });
});

describe("단일 프로젝트 변경 장벽", () => {
  test("전체 patch/HQ 검증이 종료보다 먼저이며 같은 값은 부작용이 없다", async () => {
    const t = await setup(); await t.managed("worker");
    for (const patch of [{ name: "  ", archived: true }, { archived: true, runnerEnabled: true }]) {
      await expect(t.orch.patchProject(t.project.id, patch)).rejects.toMatchObject({ status: 400 });
    }
    await t.orch.patchProject(t.project.id, { name: t.project.name });
    await expect(t.orch.patchProject("hq", { archived: true })).rejects.toMatchObject({ status: 400 });
    expect(t.stopped).toHaveLength(0); expect(t.checks).toHaveLength(0);
    expect(t.core.count("terminal.kill")).toBe(0);
  });

  test("runner 직원도 전원 사전 검사하고, 마지막 검사에서 거부하면 한 명도 종료하지 않는다", async () => {
    const t = await setup(); const a = await t.managed("first"), b = await t.managed("second");
    // 옛 시험은 가짜 실행기가 HerdrError("cannot_exit") 를 던졌다. core 에서는 입력칸에 사람이 쓰던 글이 있으면 실제 CoreRunner 가 종료를 거절한다.
    t.core.setDraft(b.id, "초안 보존");
    await expect(t.orch.patchProject(t.project.id, { archived: true, name: "새 이름" })).rejects.toMatchObject({ status: 409 });
    await until(() => t.checks.length === 2, "전원 검사");
    expect(t.stopped).toHaveLength(0);
    expect(t.store.requireProject(t.project.id)).toMatchObject({ archived: false, name: "시험" });
    t.core.setDraft(b.id, ""); t.checks.length = 0;
    // 검사 뒤 초안 변경: 첫 직원의 두 번째 검사(종료 직전) 때 입력칸에 글이 생겼다.
    t.hooks.beforeCheck = member => { if (member.id === a.id && t.checks.filter(c => c.id === a.id).length === 2) t.core.setDraft(a.id, "검사 뒤 초안 변경"); };
    await expect(t.orch.patchProject(t.project.id, { archived: true })).rejects.toMatchObject({ status: 409 });
    await until(() => t.checks.length === 3, "종료 직전 검사");
    expect(t.checks.every(c => c.whileWorking === false)).toBe(true);
    expect(t.stopped).toHaveLength(0);
    expect(t.core.count("terminal.kill")).toBe(0);
  });

  test("장벽 중 중복 patch/새 업무/생성/재개/설정/수신은 효과 없이 거부하고 manual은 종료하지 않는다", async () => {
    const t = await setup(); const a = await t.managed("worker");
    const manual = await t.manual();
    t.store.patchMember(manual.member.id, { status: "idle" });
    const delivery = t.store.enqueue({ projectId: t.project.id, memberId: manual.member.id, kind: "instruction", text: "manual 대기" });
    const starts = t.runs().length;
    t.hooks.beforeStop = () => Bun.sleep(80);
    const changing = t.orch.patchProject(t.project.id, { archived: true });
    await until(() => t.checks.length >= 2, "장벽");
    await expect(t.orch.patchProject(t.project.id, { name: "경합" })).rejects.toMatchObject({ status: 409 });
    await expect(t.orch.sendUserMessage(t.project.id, { text: "경합", targetMemberId: a.id })).rejects.toMatchObject({ status: 409 });
    await expect(t.orch.resumeMember(a.id)).rejects.toMatchObject({ status: 409 });
    await expect(t.orch.addMember(t.project.id, { name: "추가" })).rejects.toMatchObject({ status: 409 });
    await expect(t.orch.patchMemberConfig(a.id, { modelOverride: "other" })).rejects.toMatchObject({ status: 409 });
    expect(await t.orch.manualInbox(manual.member.id, 0)).toBeNull();
    await t.orch.pump(a.id);
    const archived = await changing;
    expect(archived.archived).toBe(true); expect(t.runs()).toHaveLength(starts);
    expect(t.stopped).toEqual([a.id]);
    expect(t.store.requireDelivery(delivery.id).status).toBe("held");
  });

  test("진행 중 start는 pane 저장 전에도 보관을 거절한다", async () => {
    const t = await setup(); const original = t.runner.start.bind(t.runner);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    t.runner.start = async (member, opts) => { await gate; return original(member, opts); };
    const spawning = t.orch.ensureConductor(t.project.id);
    await until(() => t.store.getConductor(t.project.id) !== null, "생성 의도");
    await expect(t.orch.patchProject(t.project.id, { archived: true })).rejects.toMatchObject({ status: 409 });
    expect(t.store.requireProject(t.project.id).archived).toBe(false);
    finish(); await spawning;
  });

  test("종료 뒤 DB commit이 실패해도 장벽을 풀고 종료한 큐를 asleep으로 남긴다", async () => {
    const t = await setup(); const member = await t.managed("worker");
    const starts = t.runs().length;
    // 지금은 보내지 않을 전달(다음 시도 시각이 한참 뒤)이라 보관 전까지 줄에 남는다.
    const delivery = t.store.enqueue({ projectId: t.project.id, memberId: member.id, kind: "instruction", text: "보존", nextAttemptAt: new Date(Date.now() + 600_000).toISOString() });
    const patch = t.store.patchProject.bind(t.store);
    t.store.patchProject = () => { throw new Error("injected DB write failure"); };
    await expect(t.orch.patchProject(t.project.id, { archived: true })).rejects.toThrow("DB write failure");
    t.store.patchProject = patch;
    expect(t.store.requireProject(t.project.id).archived).toBe(false);
    expect(t.store.requireDelivery(delivery.id)).toMatchObject({ status: "held", holdReason: "asleep" });
    await t.orch.patchProject(t.project.id, { name: "복구" });
    expect(t.store.requireProject(t.project.id).name).toBe("복구");
    expect(t.runs()).toHaveLength(starts);
  });

  test("부분 종료 불명은 journal로 복구하고 PATCH 필드/세션과 기존 asleep 보류를 보존한다", async () => {
    const t = await setup({ timings: { tickMs: 60_000, healthMs: 60_000 } });
    const a = await t.managed("first"), b = await t.managed("second");
    const starts = t.runs().length;
    const first = t.store.enqueue({ projectId: t.project.id, memberId: a.id, kind: "instruction", text: "대기", nextAttemptAt: new Date(Date.now() + 600_000).toISOString() });
    // 옛 시험은 가짜 실행기의 stop 이 "종료 ACK 유실"을 던졌다. core 에서는 둘째 직원의 terminal.kill 을 보내는 순간 엔진 연결이 끊긴다:
    // 종료가 됐는지 모른다(확인하러 다시 읽는 것도 닿지 않는다).
    const bTerminal = t.core.terminalOf(b.id)!.address;
    t.core.intercept(call => { if (call.method === "terminal.kill" && call.params.terminal === bTerminal) { t.core.setDown(true); return "drop"; } return undefined; });
    await expect(t.orch.patchProject(t.project.id, { archived: true, name: "반영 금지" })).rejects.toMatchObject({ status: 503 });
    expect(t.store.requireProject(t.project.id)).toMatchObject({ archived: false, name: "시험" });
    expect(t.store.requireMember(a.id)).toMatchObject({ status: "asleep", paneId: null, sessionId: a.sessionId });
    expect(t.store.requireDelivery(first.id)).toMatchObject({ status: "held", holdReason: "asleep" });
    expect(t.store.requireMember(b.id)).toMatchObject({ paneId: b.paneId, sessionId: b.sessionId });
    expect(t.store.listPendingLifecycleJournals()).toEqual([expect.objectContaining({ memberId: b.id, intent: "archive", phase: "unknown" })]);
    // 서버를 다시 띄운다. 엔진은 돌아와 있고 둘째 직원의 터미널은 그대로 살아 있다.
    t.core.intercept(null); t.core.setDown(false);
    const next = await t.restart({ timings: { tickMs: 60_000, healthMs: 60_000 } });
    closers.push(() => next.close());
    await next.orch.recover();
    expect(next.store.requireMember(b.id)).toMatchObject({ status: "asleep", paneId: null, sessionId: b.sessionId });
    expect(next.store.listPendingLifecycleJournals()).toHaveLength(0);
    expect(next.store.requireProject(t.project.id).archived).toBe(false);
    expect(next.runs()).toHaveLength(starts);
    await next.orch.patchProject(t.project.id, { archived: true });
    await next.orch.patchProject(t.project.id, { archived: false });
    expect(next.runs()).toHaveLength(starts);
    expect(next.store.requireDelivery(first.id)).toMatchObject({ status: "held", holdReason: "asleep" });
  });
});

describe("재시작 정리", () => {
  test("다시 연 결재는 직전 답과 메모를 남긴다", async () => {
    const t = await setup({ timings: { tickMs: 60_000 } });
    const w = t.store.createMember({ projectId: t.project.id, handle: "cs", name: "철수", role: "개발", kind: "worker", origin: "runner", status: "idle" });
    const d = t.store.createDecision({ projectId: t.project.id, memberId: w.id, who: "철수", title: "t", options: [{ k: "a", label: "가" }] });
    t.store.answerDecision(d.id, { choice: "a", note: "길게 쓴 메모" });
    const delivery = t.store.enqueue({ projectId: t.project.id, memberId: w.id, kind: "answer", text: "답", refType: "decision", refId: d.id });
    t.store.markHeld(delivery.id, "runner_disabled");
    expect(t.store.releaseHeldBeforeConnection().decisions).toBe(1);
    expect(t.store.requireDecision(d.id)).toMatchObject({ status: "open", choice: null, note: null, lastChoice: "a", lastNote: "길게 쓴 메모", reopenNote: expect.stringContaining("연결 전") });
    t.store.answerDecision(d.id, { choice: "a" });
    expect(t.store.requireDecision(d.id)).toMatchObject({ lastChoice: null, lastNote: null, reopenNote: null });
  });

  test("가져온 못 읽은 말은 재시작을 지나도 보류로 남고, 총괄을 시작하면 전달된다", async () => {
    const t = await setup({ runnerEnabled: false });
    const message = t.store.createMessage({ projectId: t.project.id, mine: true, who: "나", kind: "나", body: "가져온 말", delivery: "held", deliveryNote: IMPORT_HOLD_NOTE });
    t.store.releaseHeldBeforeConnection();
    expect(t.store.requireMessage(message.id).delivery).toBe("held");
    expect((await t.api("POST", `/api/projects/${t.project.id}/conductor/start`)).status).toBe(200);
    await until(() => t.turns().some((c) => c.prompt.includes("가져온 말")), "총괄에게 전달");
  });
});

describe("죽은 직접 세션", () => {
  test("답을 기다리다 조용해지면 offline 으로 내려 게이트가 닫히고, 롱폴이 살아 있으면 내려가지 않는다", async () => {
    // 실제 시계를 기다리지 않는다: 마지막 활동 시각을 옮기고 틱을 직접 부른다.
    const t = await setup({ runnerEnabled: false, timings: { tickMs: 60_000, manualOfflineMs: 60_000, manualIdleMs: 30_000 } });
    const m = await t.manual();
    const tick = () => (t.orch as unknown as { onTick(): void }).onTick();
    const quietFor = (ms: number) => {
      const at = new Date(Date.now() - ms).toISOString();
      t.store.db.query("UPDATE members SET updated_at = ?, manual_activity_at = ? WHERE id = ?").run(at, at, m.member.id);
    };
    const ask = await t.api("POST", "/agent/tool", { name: "ask", args: { title: "물음", detail: "내용" } }, m.token);
    const { wait } = (await ask.json()) as { wait: { decisionId: string } };
    await until(() => t.store.requireMember(m.member.id).status === "waiting", "대기");
    // 살아 있는 동안: 기준에 못 미치면 그대로고, 기준을 넘겼어도 롱폴이 다시 걸리면 시각이 새로워진다.
    for (let i = 0; i < 3; i++) {
      quietFor(50_000); tick();
      expect(t.store.requireMember(m.member.id).status).toBe("waiting");
      quietFor(61_000);
      await t.api("POST", "/agent/ask/wait", { decisionId: wait.decisionId, timeoutMs: 1 }, m.token);
      tick();
      expect(t.store.requireMember(m.member.id).status).toBe("waiting");
    }
    expect(t.store.requireProject(t.project.id).connection.ok).toBe(true);
    // 죽은 뒤
    quietFor(61_000); tick();
    expect(t.store.requireMember(m.member.id).status).toBe("offline");
    expect(t.store.requireProject(t.project.id).connection).toMatchObject({ ok: false, reason: "runner_off" });
    // 맥이 잠들었다 깬 것처럼 브리지가 다시 부르면 되살아난다.
    await t.api("POST", "/agent/ask/wait", { decisionId: wait.decisionId, timeoutMs: 1 }, m.token);
    expect(t.store.requireMember(m.member.id).status).toBe("waiting");
  });
});
