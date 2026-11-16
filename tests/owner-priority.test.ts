// 0.2.7 묶음 1: 급한 지시와 결재 답이 먼저 들어가게, 지연 알림을 사유별로(점검 audit-1116 D1-1·D1-2·D1-3·D1-5·D1-6·D3-2·D3-10·D4-4·D5-1·D5-2).
// 실행기는 가짜(운영과 같은 core: 돌고 있는 턴에 끼워 넣지 못한다), 저장소·전달 펌프·도구는 진짜다. 시험 글은 같은 모양의 가짜 글이다.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, Member } from "../shared/types.ts";
import { handleAgentTool } from "../server/agent-tools.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator, type OrchestratorTimings } from "../server/orchestrator.ts";
import { PushEventRecorder } from "../server/push/events.ts";
import { PushStore } from "../server/push/store.ts";
import { CoreError } from "../server/runner/core-client.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";

/** 운영의 CoreRunner 처럼 돌고 있는 턴에 끼워 넣지 못하는 가짜 실행기. '중단'은 그 턴을 끝낸다(멈추지 못하게도 할 수 있다). */
class FakeRunner implements Runner {
  store: Store | null = null;
  kind: Backend = "core";
  readonly interjects = false;
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  interrupts = 0;
  /** 있으면 '중단'이 이 오류로 끝난다(멈추지 않는다). */
  interruptError: Error | null = null;
  compacts = 0;
  cb: (e: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember, _o: StartOpts) { return { sessionId: m.sessionId ?? crypto.randomUUID(), paneId: `t-${m.id}` }; }
  sessionExists() { return true; }
  async send(m: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ memberId: m.id, text });
    this.busy.add(m.id);
    const dispatch = this.store?.listDispatches(m.id).find(d => d.wireText === text && d.transportState === "write_started");
    return { ok: true, ...(dispatch ? { receipt: { dispatchId: dispatch.dispatchId, receivedAt: new Date().toISOString(), source: "transport" as const } } : {}) };
  }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(m: RunnerMember): Promise<SendResult> {
    this.compacts++;
    const state = this.store?.getContextState(m.id);
    if (state?.compaction) this.store!.saveContextState({ ...state, measurement: null, compaction: { ...state.compaction, phase: "running" } }, { contextPct: null });
    return { ok: true, started: false };
  }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt(m: RunnerMember) {
    this.interrupts++;
    if (this.interruptError) throw this.interruptError;
    setTimeout(() => this.end(m.id), 0);
  }
  async stop(m: RunnerMember) { this.busy.delete(m.id); }
  async screen() { return ""; }
  on(cb: (e: RunnerEvent) => void) { this.cb = cb; }
  async shutdown() {}
  end(memberId: string) {
    this.busy.delete(memberId);
    this.cb({ type: "turn_end", memberId, finalText: "", isError: false });
  }
  textsTo(memberId: string) { return this.sent.filter(s => s.memberId === memberId).map(s => s.text); }
}

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

const until = async (cond: () => boolean, label: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${label} 시간 초과`);
    await Bun.sleep(5);
  }
};

function setup(opts: { timings?: Partial<OrchestratorTimings>; notifier?: (title: string, body: string) => void } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-w71-")));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-w71-work-")));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"], claudeBin: "/bin/false" }, env);
  const config = loadConfig(env);
  const db = openDb(config.dbPath);
  const push = new PushStore(db);
  const store = new Store(db, new Bus(), new PushEventRecorder(push));
  const runner = new FakeRunner();
  runner.store = store;
  store.patchSettings({ backend: "core" });
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", runner]]), notifier: opts.notifier, timings: { tickMs: 60_000, retryMs: 10, inputBusyRetryMs: 10, ...opts.timings } });
  closers.push(() => orch.shutdown());
  const project = store.createProject({ name: "시험", cwd: work });
  const lead = store.createMember({ projectId: project.id, handle: "lead", name: "총괄", kind: "conductor" });
  const call = (member: Member, name: string, args: Record<string, unknown>) => handleAgentTool(orch, store.requireMember(member.id), name, args);
  /** 대표가 쓴 글(서버가 인용을 맞춰 볼 원문). 받는 이 없이 남긴다. */
  const ownerSaid = (body: string, at?: string) => store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body, ...(at ? { at } : {}) });
  /** 팀장이 지시를 받아 턴을 도는 중으로 만든다. */
  const working = async (member: Member, text = "앞 일") => {
    await orch.assign(project.id, member.handle, { text });
    await until(() => runner.textsTo(member.id).some(t => t.includes(text)) && orch.store.requireMember(member.id).status === "working", "일하는 중");
  };
  return { home, store, runner, orch, project, lead, call, ownerSaid, working, push };
}

describe("결재 답이 다른 일 뒤로 밀리지 않게(D1-2·D3-2)", () => {
  test("결재를 올리고 턴을 끝낸 팀장에게 쌓인 총괄 지시는 답을 기다리고, 답이 오면 답이 맨 앞인 한 봉투로 들어간다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "자료 정리", handle: "docs" })).member;
    await t.working(w);
    const { decision } = await t.orch.registerAsk(t.store.requireMember(w.id), { title: "어느 판으로 할까요?", options: [{ k: "a", label: "가 판" }, { k: "b", label: "나 판" }] });
    // 질문 전후로 쌓인 총괄 지시(실제 사례: 질문 직후 이 지시가 53분 턴을 시작해 대표 답이 47분 늦었다).
    const queued = await t.orch.assign(t.project.id, w.handle, { text: "다른 일 하나" }, t.lead);
    t.runner.end(w.id);
    await until(() => t.store.pumpVerdict(w.id)?.code === "ask_hold", "결재 답 기다림");
    expect(t.runner.textsTo(w.id)).toHaveLength(1);
    expect(t.store.requireDelivery(queued.delivery.id).status).toBe("queued");
    // 앱에는 새 값 없이 '다음에 일할 때 함께 전달'로 보이고, 정체로 세지 않는다.
    expect(t.store.deliveryWait(t.store.requireDelivery(queued.delivery.id)).waitReason).toBe("next_turn");
    expect(t.store.requireMember(w.id).status).toBe("waiting");
    await t.orch.answerDecision(decision.id, { choice: "b" });
    await until(() => t.runner.textsTo(w.id).length === 2, "답과 미룬 지시");
    const envelope = t.runner.textsTo(w.id)[1]!;
    expect(envelope).toContain("나 판");
    expect(envelope).toContain("다른 일 하나");
    expect(envelope.indexOf("나 판")).toBeLessThan(envelope.indexOf("다른 일 하나"));
  });

  test("기다림은 짧다: 정한 시간이 지나면 답이 없어도 평소대로 나간다", async () => {
    const t = setup({ timings: { askHoldMs: 80 } });
    const w = (await t.orch.addMember(t.project.id, { name: "자료 정리", handle: "docs" })).member;
    await t.working(w);
    await t.orch.registerAsk(t.store.requireMember(w.id), { title: "물음", options: [{ k: "a", label: "예" }] });
    await t.orch.assign(t.project.id, w.handle, { text: "다른 일 하나" }, t.lead);
    t.runner.end(w.id);
    await until(() => t.store.pumpVerdict(w.id)?.code === "ask_hold", "결재 답 기다림");
    expect(t.runner.textsTo(w.id)).toHaveLength(1);
    await until(() => t.runner.textsTo(w.id).length === 2, "기다림 뒤 전달");
    expect(t.runner.textsTo(w.id)[1]).toContain("다른 일 하나");
  });

  test("대표의 글과 급한 지시는 미루지 않는다(미룬 지시는 그 봉투에 끼지 않는다)", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "자료 정리", handle: "docs" })).member;
    await t.working(w);
    await t.orch.registerAsk(t.store.requireMember(w.id), { title: "물음", options: [{ k: "a", label: "예" }] });
    const held = await t.orch.assign(t.project.id, w.handle, { text: "다른 일 하나" }, t.lead);
    t.runner.end(w.id);
    await until(() => t.store.pumpVerdict(w.id)?.code === "ask_hold", "결재 답 기다림");
    await t.orch.sendUserMessage(t.project.id, { text: "대표가 직접 묻는 말", targetMemberId: w.id });
    await until(() => t.runner.textsTo(w.id).length === 2, "대표 글");
    expect(t.runner.textsTo(w.id)[1]).toContain("대표가 직접 묻는 말");
    expect(t.runner.textsTo(w.id)[1]).not.toContain("다른 일 하나");
    expect(t.store.requireDelivery(held.delivery.id).status).toBe("queued");
  });

  test("결재를 올리지 않은 턴 뒤에는 미루지 않는다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "자료 정리", handle: "docs" })).member;
    await t.working(w);
    await t.orch.recordPost(t.store.requireMember(w.id), { kind: "완료", title: "앞 일 끝" });
    await t.orch.assign(t.project.id, w.handle, { text: "다른 일 하나" }, t.lead);
    t.runner.end(w.id);
    await until(() => t.runner.textsTo(w.id).length === 2, "곧바로 다음 일");
  });
});

describe("급한 지시: 하던 턴 멈추고 넣기(D5-1·D1-2)", () => {
  test("대표 원문을 실은 급한 지시는 하던 턴을 멈추고 맨 먼저 들어가며, 총괄 도구 답과 활동이 사실을 말한다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    const normal = await t.orch.assign(t.project.id, w.handle, { text: "보통 지시" }, t.lead);
    t.ownerSaid("지금 하던 거 바로 멈추고 내보내기 먼저 해");
    const reply = await t.call(t.lead, "team_assign", { member: "video", text: "내보내기 먼저", user_quote: "지금 하던 거 바로 멈추고 내보내기 먼저 해", urgent: true });
    expect(reply.text).toContain("하던 턴을 멈추게 했습니다");
    expect(t.runner.interrupts).toBe(1);
    expect(t.store.listActivity(w.id).some(a => a.textCode === "activity.urgent_interrupt")).toBe(true);
    await until(() => t.runner.textsTo(w.id).length === 2, "멈춘 뒤 급한 지시");
    const envelope = t.runner.textsTo(w.id)[1]!;
    expect(envelope).toContain("하던 턴을 멈추게 했습니다");
    expect(envelope.indexOf("내보내기 먼저")).toBeLessThan(envelope.indexOf("보통 지시"));
    expect(t.store.requireDelivery(normal.delivery.id).status).toBe("delivered");
    // 멈춘 턴에 '보고 보완'을 묻지 않는다(급한 지시와 섞여 '하던 일을 다시 하지 말라'고 하지 않게).
    await Bun.sleep(30);
    expect(t.store.listDeliveries(t.project.id).some(d => d.memberId === w.id && d.text.startsWith("[시스템] 보고 보완"))).toBe(false);
  });

  test("대표 원문이 없거나 오래된 급한 지시는 멈추지 않고, 도구 답에 '하던 턴이 끝나야 들어감(HH:MM부터 N분째)'을 싣는다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    const none = await t.call(t.lead, "team_assign", { member: "video", text: "급한 일", urgent: true });
    expect(none.text).toContain("대표 원문(user_quote, 서버 확인)이 실리지 않아");
    expect(none.text).toMatch(/그 턴이 끝나야 맨 먼저 들어갑니다\(\d\d:\d\d부터 \d+분째 일하는 중\)/);
    expect(none.text).toContain("'바로 넣었다'고 하지 말고");
    t.ownerSaid("지금 바로 해", new Date(Date.now() - 40 * 60_000).toISOString());
    const stale = await t.call(t.lead, "team_assign", { member: "video", text: "급한 일 둘", user_quote: "지금 바로 해", urgent: true });
    expect(stale.text).toContain("인용한 대표 글이 30분보다 오래돼");
    expect(t.runner.interrupts).toBe(0);
    expect(t.runner.textsTo(w.id)).toHaveLength(1);
    // 기다린 급한 지시는 턴이 끝나면 맨 먼저 들어간다.
    t.runner.end(w.id);
    await until(() => t.runner.textsTo(w.id).length === 2, "턴 끝 뒤 급한 지시");
    expect(t.runner.textsTo(w.id)[1]).toContain("급한 일");
  });

  test("안전하지 않은 때(승인 창)는 멈추지 않고, 멈춤 키를 보내지 못한 것이 확정이면 안내 글을 거두고 기다린다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    t.ownerSaid("그만하고 이거 먼저");
    t.store.patchMember(w.id, { status: "blocked", blockedReason: "permission" });
    const blocked = await t.call(t.lead, "team_assign", { member: "video", text: "급한 일", user_quote: "그만하고 이거 먼저", urgent: true });
    expect(blocked.text).toContain("승인 창 앞이라");
    expect(t.runner.interrupts).toBe(0);
    t.store.patchMember(w.id, { status: "working", blockedReason: null });
    // 터미널이 없다는 확정 거절(멈춤 키가 가지 않았다).
    t.runner.interruptError = new CoreError("not_found", "No core terminal for member", false);
    const failed = await t.call(t.lead, "team_assign", { member: "video", text: "급한 일 둘", user_quote: "그만하고 이거 먼저", urgent: true });
    expect(t.runner.interrupts).toBe(1);
    expect(failed.text).toContain("멈춤 키를 보내지 못해 하던 턴을 멈추지 않았습니다. 그 턴이 끝나야 맨 먼저 들어갑니다");
    expect(t.store.listActivity(w.id).some(a => a.textCode === "activity.urgent_interrupt_failed")).toBe(true);
    // '멈추게 했습니다' 안내는 거뒀다. 턴이 끝나면 급한 지시만 나간다.
    expect(t.store.listPending(w.id).some(d => d.text.includes("하던 턴을 멈추게 했습니다"))).toBe(false);
    t.runner.end(w.id);
    await until(() => t.runner.textsTo(w.id).length === 2, "턴 끝 뒤 전달");
    expect(t.runner.textsTo(w.id)[1]).not.toContain("하던 턴을 멈추게 했습니다");
    // 멈추지 못한 대표 글로는 다시 멈출 수 있다(한 번만 멈추는 표식은 멈춘 때만 남는다).
    expect(t.store.listActivity(w.id).some(a => a.textCode === "activity.urgent_interrupt" || a.textCode === "activity.urgent_interrupt_unconfirmed")).toBe(false);
  });
});

describe("30분 지연 알림을 사유별로(D1-3·D5-2·D1-1)", () => {
  const age = (t: ReturnType<typeof setup>, id: string, now: number) => t.store.db.query("UPDATE deliveries SET created_at = ? WHERE id = ?").run(new Date(now - 31 * 60_000).toISOString(), id);
  const ageVerdict = (t: ReturnType<typeof setup>, memberId: string, at: number) => t.store.db.query("UPDATE member_delivery_verdicts SET since = ? WHERE member_id = ?").run(new Date(at).toISOString(), memberId);

  test("하던 일을 마치는 중이라 기다리는 대표 글은 막힘이 아니라 알림(푸시·Mac 알림 없음) 한 번이고, 뒤에 진짜로 막히면 그때 막힘과 푸시", async () => {
    const mac: string[] = [];
    const t = setup({ notifier: (_title, body) => mac.push(body) });
    t.store.patchSettings({ notifyMac: true, macScriptNotifications: true });
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    const message = await t.orch.sendUserMessage(t.project.id, { text: "이것도 해 줘", targetMemberId: w.id });
    const d = t.store.listPending(w.id).find(x => x.refId === message.id)!;
    const now = Date.now();
    age(t, d.id, now);
    t.orch.notifyDelayedDeliveries(now); t.orch.notifyDelayedDeliveries(now + 30_000);
    const behind = t.store.listMessages(t.project.id).filter(m => m.textCode === "chat.owner_delivery_behind");
    expect(behind).toHaveLength(1);
    expect(behind[0]).toMatchObject({ kind: "알림", who: "시스템", memberId: w.id, title: "전달 대기" });
    // 0.2.7 배포 전 확인(문제 3): 오늘 일이라 시각만, 대표 글에는 내부 번호가 없다(총괄 사본에만).
    expect(behind[0]!.body).toMatch(/^영상 편집이 (오전|오후) \d{1,2}시( \d{1,2}분)?부터 하던 일을 마치는 중입니다\. 그 일이 끝나면 대표 메시지가 들어갑니다\.$/);
    expect(behind[0]!.body).not.toContain("#");
    expect(t.store.listPending(t.lead.id).find(x => x.text.includes("막힌 것이 아니라"))!.text).toContain(`(전달 ${d.id})`);
    expect(t.push.listEvents().filter(e => e.kind === "report_blocked")).toHaveLength(0);
    expect(mac).toHaveLength(0);
    // 총괄에게는 깨우지 않는 사본(막힌 것이 아니라는 말과 함께).
    expect(t.store.listPending(t.lead.id).filter(x => x.text.includes("막힌 것이 아니라 차례를 기다리는 것입니다")).map(x => x.wake)).toEqual([false]);
    // 같은 전달이 뒤에 진짜로 막혔다(압축이 끝을 못 알아본 채 2분 넘게).
    t.store.recordPumpVerdict(w.id, { code: "compacting" });
    ageVerdict(t, w.id, now - 3 * 60_000);
    t.orch.notifyDelayedDeliveries(now + 60_000); t.orch.notifyDelayedDeliveries(now + 90_000);
    expect(t.store.listMessages(t.project.id).filter(m => m.textCode === "chat.owner_message_late").map(m => m.kind)).toEqual(["막힘"]);
    expect(t.push.listEvents().filter(e => e.kind === "report_blocked")).toHaveLength(1);
    expect(mac).toHaveLength(1);
  });

  test("잠깐의 사유(방금 바뀐 판정)는 알리지 않고, 대표 원문을 실은 지시·할 일 완료도 막히면 알리며, 원문 없는 지시는 대상이 아니다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    t.ownerSaid("자막도 같이 고쳐 줘");
    const quoted = await t.orch.assign(t.project.id, w.handle, { text: "자막 고치기", userQuote: "자막도 같이 고쳐 줘" }, t.lead);
    const plain = await t.orch.assign(t.project.id, w.handle, { text: "총괄 혼자 정한 일" }, t.lead);
    const todo = t.store.createTodo({ projectId: t.project.id, title: "계정 만들기", memberId: w.id, who: w.name });
    await t.orch.setTodoDone(todo.id, true, { note: "만들었어" });
    const done = t.store.listPending(w.id).find(x => x.kind === "todo_done")!;
    const now = Date.now();
    for (const id of [quoted.delivery.id, plain.delivery.id, done.id]) age(t, id, now);
    t.store.recordPumpVerdict(w.id, { code: "receipt_check" });
    t.orch.notifyDelayedDeliveries(now);
    expect(t.store.listMessages(t.project.id).filter(m => m.who === "시스템" && (m.kind === "막힘" || m.kind === "알림"))).toHaveLength(0);
    ageVerdict(t, w.id, now - 3 * 60_000);
    t.orch.notifyDelayedDeliveries(now);
    const late = t.store.listMessages(t.project.id).filter(m => m.who === "시스템" && m.kind === "막힘").map(m => m.textCode).sort();
    expect(late).toEqual(["chat.owner_instruction_late", "chat.owner_todo_done_late"]);
    expect(t.store.listMessages(t.project.id).find(m => m.textCode === "chat.owner_instruction_late")!.body).toBe("영상 편집에게 넘긴 대표 요청(총괄 지시)이 30분 넘게 전달되지 않았습니다. 팀 화면에서 영상 편집의 상태를 확인해 주세요.");
    // 총괄 사본(AI 글)에는 전달 번호가 남는다.
    expect(t.store.listPending(t.lead.id).some(x => x.kind === "system" && x.text.includes("대표 요청(총괄 지시)이 30분 넘게") && x.text.includes(`(전달 ${quoted.delivery.id})`))).toBe(true);
  });

  test("받는 이가 총괄 자신이면 총괄 사본을 넣지 않는다", async () => {
    const t = setup();
    await t.working(t.lead, "총괄의 긴 일");
    const message = await t.orch.sendUserMessage(t.project.id, { text: "이것도" });
    const d = t.store.listPending(t.lead.id).find(x => x.refId === message.id)!;
    const now = Date.now();
    age(t, d.id, now);
    t.store.recordPumpVerdict(t.lead.id, { code: "busy_unconfirmed" });
    ageVerdict(t, t.lead.id, now - 3 * 60_000);
    t.orch.notifyDelayedDeliveries(now);
    expect(t.store.listMessages(t.project.id).filter(m => m.textCode === "chat.owner_message_late")).toHaveLength(1);
    expect(t.store.listPending(t.lead.id).filter(x => x.kind === "system" && x.text.includes("30분 넘게"))).toHaveLength(0);
  });

  test("넣은 압축의 끝을 기한 안에 확인하지 못하면 대표에게 막힘(푸시)으로 한 번 알리고, 압축 중 판정은 기한을 넘기면 확인 필요가 된다", async () => {
    const t = setup({ timings: { compactTimeoutMs: 40 } });
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    await t.orch.recordPost(t.store.requireMember(w.id), { kind: "완료", title: "편집 끝" });
    t.runner.end(w.id);
    await until(() => t.store.requireMember(w.id).status === "idle", "쉬는 중");
    await t.orch.compactMember(w.id);
    await until(() => t.runner.compacts === 1, "압축 넣음");
    await until(() => t.store.listMessages(t.project.id).some(m => m.textCode === "chat.compact_unconfirmed"), "압축 미확인 알림");
    const notice = t.store.listMessages(t.project.id).filter(m => m.textCode === "chat.compact_unconfirmed");
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({ kind: "막힘", who: "시스템", memberId: w.id, title: "압축 확인 필요" });
    expect(t.push.listEvents().filter(e => e.kind === "report_blocked")).toHaveLength(1);
    // 그동안 온 전달은 압축 중으로 기다리다, 지켜보기 기한(정체 기준의 6배)을 넘기면 '이유 없는 대기'(확인 필요)로 바뀐다.
    const queued = await t.orch.assign(t.project.id, w.handle, { text: "압축 뒤 일" }, t.lead);
    expect(t.store.pumpVerdict(w.id)?.code).toBe("compacting");
    expect(t.store.deliveryWait(t.store.requireDelivery(queued.delivery.id)).waitReason).toBe("member_busy");
    t.store.detectDeliveryStalls(Date.now() + 13 * 60_000);
    expect(t.store.pumpVerdict(w.id)?.overdueAt).not.toBeNull();
    expect(t.store.deliveryWait(t.store.requireDelivery(queued.delivery.id)).waitReason).toBe("unknown");
  });
});

describe("총괄 사본과 결재 상태를 사실대로(D1-6·D1-5·D3-10)", () => {
  test("결재 답의 총괄 사본은 '이미 전달했습니다'가 아니라 지금 상태(하던 일을 마치는 중, HH:MM부터)를 쓴다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "자료 정리", handle: "docs" })).member;
    const { decision } = await t.orch.registerAsk(w, { title: "어느 판?", options: [{ k: "a", label: "가 판" }] });
    await t.working(w, "다른 긴 일");
    await t.orch.answerDecision(decision.id, { choice: "a" });
    const copy = t.store.listPending(t.lead.id).find(d => d.kind === "system" && d.text.includes("결재에 답했습니다"))!;
    expect(copy.wake).toBe(false);
    expect(copy.text).not.toContain("이미 자료 정리에게 전달했습니다");
    expect(copy.text).toMatch(/서버가 자료 정리에게 전달합니다\(자료 정리가 \d\d:\d\d부터 \d+분째 하던 일을 마치는 중이라 그 일이 끝나면 들어갑니다\)/);
  });

  test("팀장 몫 할 일을 닫으면 총괄 사본은 깨우지 않고 '서버가 따로 전함 — 다시 전하지 말 것'을 붙인다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "자료 정리", handle: "docs" })).member;
    const todo = t.store.createTodo({ projectId: t.project.id, title: "계정 만들기", memberId: w.id, who: w.name });
    await t.orch.setTodoDone(todo.id, true, { note: "만들었어" });
    const copies = t.store.listDeliveries(t.project.id).filter(d => d.kind === "todo_done" && d.refId === todo.id);
    expect(copies.find(d => d.memberId === w.id)!.wake).toBe(true);
    const lead = copies.find(d => d.memberId === t.lead.id)!;
    expect(lead.wake).toBe(false);
    expect(lead.text).toContain("서버가 이 소식을 자료 정리에게 따로 전합니다");
    expect(lead.text).toContain("같은 소식을 다시 전하지 마세요");
    expect(lead.text).toContain("만들었어");
    expect(t.runner.textsTo(t.lead.id)).toHaveLength(0);
  });

  test("결재 답의 전달을 그만두면 카드가 직전 답과 함께 다시 열리고 총괄은 깨우지 않는 사실을 받는다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "자료 정리", handle: "docs" })).member;
    const { decision } = await t.orch.registerAsk(w, { title: "어느 판?", options: [{ k: "a", label: "가 판" }] });
    await t.working(w, "다른 긴 일");
    await t.orch.answerDecision(decision.id, { choice: "a", note: "가 판으로 가자" });
    const d = t.store.listPending(w.id).find(x => x.kind === "answer")!;
    const r = t.store.getDeliveryRecovery(d.id)!;
    const result = await t.orch.recoverDelivery(d.id, { operationId: crypto.randomUUID(), expectedVersion: r.version, action: "stop_retry" });
    expect(result.outcome).toBe("stopped");
    expect(t.store.requireDelivery(d.id).status).toBe("failed");
    const reopened = t.store.requireDecision(decision.id);
    expect(reopened).toMatchObject({ status: "open", choice: null, lastChoice: "a", lastNote: "가 판으로 가자" });
    expect(reopened.reopenNote).toBe("전달을 그만둔 답입니다. 자료 정리가 받지 못했을 수 있으니 다시 결정해 주세요");
    const note = t.store.listPending(t.lead.id).find(x => x.kind === "system" && x.text.includes("답 전달"))!;
    expect(note.wake).toBe(false);
    expect(note.text).toContain(`결재 #${decision.id} 답 전달(${d.id})을 그만뒀습니다`);
  });
});

// 0.2.7 묶음 1 독립 검토 대응: 멈추는 근거를 좁히고(버튼 글·짧은 글·다른 팀장에게 쓴 글 아님, 같은 글로 한 번만), 멈춘 것을 확인하지 못한 경우를 멈춘 턴으로,
// 지연 알림에서 대표가 이미 아는 대기·진전 없는 실행·재시작 뒤 사본, 기한을 넘긴 압축의 '중단' 안내.
describe("검토 대응: 급한 지시로 멈추는 근거와 결과", () => {
  test("다른 결재에서 고른 버튼 글이나 다른 팀장에게 쓴 대표 글로는 하던 턴을 멈추지 않는다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    const docs = (await t.orch.addMember(t.project.id, { name: "자료 정리", handle: "docs" })).member;
    await t.working(w, "긴 편집 작업");
    const { decision } = await t.orch.registerAsk(t.store.requireMember(docs.id), { title: "배포할까요?", options: [{ k: "go", label: "진행" }, { k: "no", label: "보류" }] });
    await t.orch.answerDecision(decision.id, { choice: "go" });
    const button = await t.call(t.lead, "team_assign", { member: "video", text: "내보내기 먼저", user_quote: "진행", urgent: true });
    expect(button.text).toContain("인용이 결재 버튼 글·짧은 글처럼 대표가 이 일로 쓴 문장이 아니라 하던 턴을 멈추지 않았습니다");
    await t.orch.sendUserMessage(t.project.id, { text: "자료 정리는 지금 바로 표부터 고쳐 줘", targetMemberId: docs.id });
    const other = await t.call(t.lead, "team_assign", { member: "video", text: "표 고치기 돕기", user_quote: "자료 정리는 지금 바로 표부터 고쳐 줘", urgent: true });
    expect(other.text).toContain("인용한 대표 글이 다른 팀장에게 쓴 글이라 하던 턴을 멈추지 않았습니다");
    expect(t.runner.interrupts).toBe(0);
    expect(t.runner.textsTo(w.id)).toHaveLength(1);
  });

  test("같은 대표 글로는 한 팀장의 턴을 한 번만 멈춘다(재시작·활동 줄 정리 뒤에도), 보충 지시는 급한 일을 하던 턴을 끊지 않는다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    t.ownerSaid("지금 하던 거 바로 멈추고 내보내기 먼저 해");
    const first = await t.call(t.lead, "team_assign", { member: "video", text: "내보내기 먼저", user_quote: "지금 하던 거 바로 멈추고 내보내기 먼저 해", urgent: true });
    expect(first.text).toContain("하던 턴을 멈추게 했습니다");
    await until(() => t.runner.textsTo(w.id).length === 2 && t.store.requireMember(w.id).status === "working", "급한 지시 턴");
    const again = await t.call(t.lead, "team_assign", { member: "video", text: "내보낼 때 자막도 켜", user_quote: "지금 하던 거 바로 멈추고 내보내기 먼저 해", urgent: true });
    expect(again.text).toContain("그 대표 글로 이 팀장의 턴을 이미 한 번 멈췄기 때문에");
    expect(again.text).toMatch(/그 턴이 끝나야 맨 먼저 들어갑니다\(\d\d:\d\d부터 \d+분째 일하는 중\)/);
    // 재시작(메모리 표식 없음)에도 DB 의 활동 표식이 막고, 그때 메모리에 다시 적어 활동 줄이 상한으로 지워져도 막는다.
    (t.orch as unknown as { urgentStopSources: Set<string> }).urgentStopSources.clear();
    expect((await t.call(t.lead, "team_assign", { member: "video", text: "보충 둘", user_quote: "지금 하던 거 바로 멈추고 내보내기 먼저 해", urgent: true })).text).toContain("이미 한 번 멈췄기");
    t.store.db.query("DELETE FROM activity WHERE member_id = ?").run(w.id);
    expect((await t.call(t.lead, "team_assign", { member: "video", text: "보충 셋", user_quote: "지금 하던 거 바로 멈추고 내보내기 먼저 해", urgent: true })).text).toContain("이미 한 번 멈췄기");
    expect(t.runner.interrupts).toBe(1);
    // 다른 팀장에게는 같은 글로 한 번 멈출 수 있다.
    const docs = (await t.orch.addMember(t.project.id, { name: "자료 정리", handle: "docs" })).member;
    await t.working(docs, "표 정리");
    expect((await t.call(t.lead, "team_assign", { member: "docs", text: "내보내기 돕기", user_quote: "지금 하던 거 바로 멈추고 내보내기 먼저 해", urgent: true })).text).toContain("하던 턴을 멈추게 했습니다");
    expect(t.runner.interrupts).toBe(2);
  });

  test("멈춤 키는 갔는데 멈춘 것을 확인하지 못하면(still_working) 멈춘 턴으로 둔다: 뒤늦게 멈춰도 보고 보완을 묻지 않고, 배정 기록은 '앞 일 끝나면 시작'", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    // 총괄이 대표 글을 받아 도는 턴(배정 확인이 이 턴에 쌓인다).
    await t.orch.sendUserMessage(t.project.id, { text: "영상 편집 지금 멈추고 내보내기 먼저 해" });
    await until(() => t.runner.textsTo(t.lead.id).some(x => x.includes("영상 편집 지금 멈추고")) && t.store.requireMember(t.lead.id).status === "working", "총괄 턴");
    t.runner.interruptError = new CoreError("not_stopped", "CLI interrupt outcome: still_working", false);
    const reply = await t.call(t.lead, "team_assign", { member: "video", text: "내보내기 먼저", user_quote: "영상 편집 지금 멈추고 내보내기 먼저 해", urgent: true });
    expect(reply.text).toContain("하던 턴에 멈춤 키를 보냈지만, 바로 멈춘 것은 확인하지 못했습니다. 멈추거나 그 턴이 끝나는 대로 이 지시를 맨 먼저 넣습니다");
    expect(reply.text).toMatch(/\(\d\d:\d\d부터 \d+분째 일하는 중\)/);
    expect(reply.text).not.toContain("멈추지 않았습니다");
    expect(t.store.listActivity(w.id).some(a => a.textCode === "activity.urgent_interrupt_unconfirmed")).toBe(true);
    // 안내는 거두지 않는다(뒤늦게 멈추면 급한 지시와 같은 봉투로 나간다).
    expect(t.store.listPending(w.id).filter(d => d.text.includes("하던 턴을 멈추게 했습니다")).map(d => d.wake)).toEqual([false]);
    // 몇 초 뒤 CLI 가 Esc 로 멈췄다.
    t.runner.end(w.id);
    await until(() => t.runner.textsTo(w.id).length === 2, "멈춘 뒤 급한 지시");
    expect(t.runner.textsTo(w.id)[1]).toContain("하던 턴을 멈추게 했습니다");
    expect(t.runner.textsTo(w.id)[1]).toContain("내보내기 먼저");
    await Bun.sleep(30);
    expect(t.store.listDeliveries(t.project.id).some(d => d.memberId === w.id && d.text.startsWith("[시스템] 보고 보완"))).toBe(false);
    // 총괄 턴이 끝나면 남는 배정 확인 줄은 '맡겼습니다'가 아니라 '앞 일 끝나면 시작'이다(멈춘 것을 확인하지 못했다).
    t.runner.end(t.lead.id);
    await until(() => t.store.listMessages(t.project.id).some(m => m.textCode === "chat.assigned_queued" || m.textCode === "chat.assigned"), "배정 확인 줄");
    expect(t.store.listMessages(t.project.id).filter(m => m.textCode === "chat.assigned_queued" || m.textCode === "chat.assigned").map(m => m.body)).toEqual(["총괄이 영상 편집에게 맡겼습니다: 내보내기 먼저 (앞 일 끝나면 시작)"]);
    // 같은 글로 다시 멈추지 않는다.
    expect((await t.call(t.lead, "team_assign", { member: "video", text: "보충", user_quote: "영상 편집 지금 멈추고 내보내기 먼저 해", urgent: true })).text).toContain("이미 한 번 멈췄기");
  });

  test("멈출 턴이 없는 바쁜 CLI(백그라운드 프로그램)에는 '세션 처리 중'이 아니라 그 까닭과 '받을 수 있게 되면'을 싣는다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    t.runner.busy.add(w.id); // 서버가 넣은 턴 없이 CLI 가 바쁘다(미리보기 서버 같은 백그라운드 프로그램).
    t.ownerSaid("영상 편집한테 지금 바로 내보내라고 해");
    const reply = await t.call(t.lead, "team_assign", { member: "video", text: "내보내기", user_quote: "영상 편집한테 지금 바로 내보내라고 해", urgent: true });
    expect(reply.text).toContain("서버가 넣은 일하는 턴이 없어(백그라운드 프로그램 등으로 CLI 가 바쁘게 보입니다) 하던 턴을 멈추지 않았습니다. 그 팀장이 받을 수 있게 되면 맨 먼저 들어갑니다");
    expect(reply.text).not.toContain("세션을 처리하는 중");
    expect(reply.text).not.toContain("그 턴이 끝나야");
    expect(t.runner.interrupts).toBe(0);
  });
});

describe("검토 대응: 30분 지연 알림", () => {
  const age = (t: ReturnType<typeof setup>, id: string, now: number) => t.store.db.query("UPDATE deliveries SET created_at = ? WHERE id = ?").run(new Date(now - 31 * 60_000).toISOString(), id);
  const ageVerdict = (t: ReturnType<typeof setup>, memberId: string, at: number) => t.store.db.query("UPDATE member_delivery_verdicts SET since = ? WHERE member_id = ?").run(new Date(at).toISOString(), memberId);
  const blocked = (t: ReturnType<typeof setup>) => t.store.listMessages(t.project.id).filter(m => m.who === "시스템" && m.kind === "막힘");

  test("사용 한도·인터넷 장애·승인 창·동시 상한·보관처럼 대표가 이미 알거나 할 일이 없는 대기는 막힘과 푸시로 알리지 않는다", async () => {
    const mac: string[] = [];
    const t = setup({ notifier: (_title, body) => mac.push(body) });
    t.store.patchSettings({ notifyMac: true, macScriptNotifications: true });
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    const first = await t.orch.sendUserMessage(t.project.id, { text: "이것도 해 줘", targetMemberId: w.id });
    const second = await t.orch.sendUserMessage(t.project.id, { text: "저것도 해 줘", targetMemberId: w.id });
    const now = Date.now();
    for (const m of [first, second]) age(t, t.store.listPending(w.id).find(x => x.refId === m.id)!.id, now);
    for (const code of ["usage_limit", "api_outage", "approval", "tool_permission", "run_limit", "archived"] as const) {
      t.store.recordPumpVerdict(w.id, { code, ...(code === "run_limit" ? { runLimit: { used: 4, limit: 4 } } : {}) });
      ageVerdict(t, w.id, now - 3 * 60_000);
      t.orch.notifyDelayedDeliveries(now);
    }
    expect(blocked(t)).toHaveLength(0);
    expect(t.store.listMessages(t.project.id).filter(m => m.textCode === "chat.owner_delivery_behind")).toHaveLength(0);
    expect(t.push.listEvents().filter(e => e.kind === "report_blocked")).toHaveLength(0);
    expect(mac).toHaveLength(0);
    // 그 대기가 풀린 뒤에도 진짜로 막혀 있으면 그때 알린다(거른 동안 알림 표시를 적지 않았다).
    t.store.recordPumpVerdict(w.id, { code: "receipt_check" });
    ageVerdict(t, w.id, now - 3 * 60_000);
    t.orch.notifyDelayedDeliveries(now);
    expect(blocked(t).map(m => m.textCode)).toEqual(["chat.owner_message_late", "chat.owner_message_late"]);
    expect(t.push.listEvents().filter(e => e.kind === "report_blocked")).toHaveLength(2);
  });

  test("일하는 중이라는 실행이 30분 넘게 진전이 없으면 '하던 일을 마치는 중'이 아니라 막힘으로 알린다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    const message = await t.orch.sendUserMessage(t.project.id, { text: "이것도 해 줘", targetMemberId: w.id });
    const d = t.store.listPending(w.id).find(x => x.refId === message.id)!;
    const now = Date.now();
    age(t, d.id, now);
    const run = t.store.listPendingExecutions().find(r => r.memberId === w.id)!;
    expect(run).toBeDefined();
    const old = new Date(now - 31 * 60_000).toISOString();
    t.store.saveExecutionJournal({ ...run, phase: "running", startedAt: old, lastProgressAt: old, createdAt: old });
    expect(["busy", "sent", "pending_run"]).toContain(t.store.pumpVerdict(w.id)!.code);
    t.orch.notifyDelayedDeliveries(now);
    expect(t.store.listMessages(t.project.id).filter(m => m.textCode === "chat.owner_delivery_behind")).toHaveLength(0);
    expect(blocked(t).map(m => m.textCode)).toEqual(["chat.owner_message_late"]);
    expect(t.push.listEvents().filter(e => e.kind === "report_blocked")).toHaveLength(1);
    // 진전이 29분 전이면 정상 대기(알림)다.
    const t2 = setup();
    const w2 = (await t2.orch.addMember(t2.project.id, { name: "영상 편집", handle: "video" })).member;
    await t2.working(w2, "긴 편집 작업");
    const m2 = await t2.orch.sendUserMessage(t2.project.id, { text: "이것도 해 줘", targetMemberId: w2.id });
    const now2 = Date.now();
    age(t2, t2.store.listPending(w2.id).find(x => x.refId === m2.id)!.id, now2);
    const run2 = t2.store.listPendingExecutions().find(r => r.memberId === w2.id)!;
    const recent = new Date(now2 - 29 * 60_000).toISOString();
    t2.store.saveExecutionJournal({ ...run2, phase: "running", startedAt: old, lastProgressAt: recent, createdAt: old });
    t2.orch.notifyDelayedDeliveries(now2);
    expect(t2.store.listMessages(t2.project.id).filter(m => m.textCode === "chat.owner_delivery_behind")).toHaveLength(1);
    expect(blocked(t2)).toHaveLength(0);
  });

  test("'전달 대기' 알림의 총괄 사본은 서버가 다시 떠도 다시 넣지 않는다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    const message = await t.orch.sendUserMessage(t.project.id, { text: "이것도 해 줘", targetMemberId: w.id });
    const now = Date.now();
    age(t, t.store.listPending(w.id).find(x => x.refId === message.id)!.id, now);
    const copies = () => t.store.listPending(t.lead.id).filter(x => x.text.includes("막힌 것이 아니라 차례를 기다리는 것입니다"));
    t.orch.notifyDelayedDeliveries(now);
    expect(copies()).toHaveLength(1);
    // 재시작: 메모리의 '이미 알림' 표시가 비었다.
    for (let i = 0; i < 2; i++) {
      (t.orch as unknown as { delayBehindNoticed: Set<string> }).delayBehindNoticed.clear();
      t.orch.notifyDelayedDeliveries(now + (i + 1) * 30_000);
    }
    expect(copies()).toHaveLength(1);
    expect(t.store.listMessages(t.project.id).filter(m => m.textCode === "chat.owner_delivery_behind")).toHaveLength(1);
  });

  test("결과 모름으로 남은 압축이 지켜보기 기한을 넘기면 완료 확인 타이머가 없어도 '중단' 안내를 한 번 주고, '중단'으로 대기열이 이어진다", async () => {
    const mac: string[] = [];
    // 완료 확인 타이머가 울리지 않는 압축(넣기 자체가 불확실했거나 재시작 뒤 이어 지켜보는 압축과 같다).
    const t = setup({ timings: { compactTimeoutMs: 3_600_000 }, notifier: (_title, body) => mac.push(body) });
    t.store.patchSettings({ notifyMac: true, macScriptNotifications: true });
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    await t.orch.recordPost(t.store.requireMember(w.id), { kind: "완료", title: "편집 끝" });
    t.runner.end(w.id);
    await until(() => t.store.requireMember(w.id).status === "idle", "쉬는 중");
    await t.orch.compactMember(w.id);
    await until(() => t.runner.compacts === 1, "압축 넣음");
    const queued = await t.orch.assign(t.project.id, w.handle, { text: "압축 뒤 일" }, t.lead);
    await until(() => t.store.pumpVerdict(w.id)?.code === "compacting", "압축 중 판정");
    expect(t.store.listMessages(t.project.id).some(m => m.textCode === "chat.compact_unconfirmed")).toBe(false);
    ageVerdict(t, w.id, Date.now() - 13 * 60_000);
    const stallCheck = () => { (t.orch as unknown as { lastStallCheck: number }).lastStallCheck = 0; (t.orch as unknown as { detectStallsSoon(): void }).detectStallsSoon(); };
    stallCheck();
    expect(t.store.pumpVerdict(w.id)?.overdueAt).not.toBeNull();
    stallCheck();
    const notice = t.store.listMessages(t.project.id).filter(m => m.textCode === "chat.compact_unconfirmed");
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({ kind: "막힘", memberId: w.id, title: "압축 확인 필요" });
    expect(t.push.listEvents().filter(e => e.kind === "report_blocked")).toHaveLength(1);
    expect(mac.filter(body => body.includes("압축"))).toHaveLength(1);
    // 안내대로 '중단'을 누르면 미확정 압축이 닫히고 기다리던 전달이 나간다.
    await t.orch.memberInterrupt(w.id);
    await until(() => t.runner.textsTo(w.id).some(x => x.includes("압축 뒤 일")) && t.store.requireDelivery(queued.delivery.id).status === "delivered", "압축 뒤 전달");
    expect(t.store.getContextState(w.id)?.compaction?.phase).toBe("failed");
  });
});

describe("0.2.7 배포 전 확인(real-cli P4): 멈출 턴이 없다는 실행기의 답", () => {
  test("급한 지시로 멈추려 했는데 실행기가 멈출 턴이 없다(쉬는 CLI, 키를 보내지 않음)고 하면 실패가 아니다: 안내를 거두고 '받을 수 있게 되면 맨 먼저'로 답하며, 하던 턴을 중단된 턴으로 적지 않는다", async () => {
    const t = setup();
    const w = (await t.orch.addMember(t.project.id, { name: "영상 편집", handle: "video" })).member;
    await t.working(w, "긴 편집 작업");
    t.ownerSaid("하던 거 멈추고 이것 먼저");
    t.runner.interruptError = new CoreError("no_turn", "No turn to stop: the CLI is idle", false, "not_written");
    const reply = await t.call(t.lead, "team_assign", { member: "video", text: "급한 일", user_quote: "하던 거 멈추고 이것 먼저", urgent: true });
    expect(t.runner.interrupts).toBe(1);
    expect(reply.text).toContain("서버가 넣은 일하는 턴이 없어");
    expect(reply.text).toContain("그 팀장이 받을 수 있게 되면 맨 먼저 들어갑니다");
    expect(reply.text).not.toContain("멈춤 키를 보내지 못해");
    expect(t.store.listActivity(w.id).some(a => String(a.textCode).startsWith("activity.urgent_interrupt"))).toBe(false);
    expect(t.store.listPending(w.id).some(d => d.text.includes("하던 턴을 멈추게 했습니다"))).toBe(false);
    // 턴이 끝나면 급한 지시가 맨 먼저 나간다. 그 턴은 중단된 턴이 아니라 보고 보완 확인도 평소대로다.
    t.runner.end(w.id);
    await until(() => t.runner.textsTo(w.id).some(x => x.includes("급한 일")), "턴 끝 뒤 급한 지시");
    // 같은 대표 글로 다시 멈출 수 있다(멈추지 않았으므로 '이미 멈춤' 표식이 없다).
    expect(t.store.hasActivityEvent(`urgent-stop:${w.id}:${t.store.listMessages(t.project.id).find(m => m.body === "하던 거 멈추고 이것 먼저")!.id}`)).toBe(false);
  });
});
