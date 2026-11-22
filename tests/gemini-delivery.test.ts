// 결과를 모르는 Gemini(Antigravity CLI) 전달의 복구: 확인 → 대표 확인 필요 → 대표의 '중복 위험을 알고 다시 보내기' → 재전송 → 전달됨.
// 실제 CoreRunner 와 실제 DeliveryRecovery·Store 를 운영과 같은 배선(복구 저장소·복구 쓰기·쓰기 종료 판정)으로 잇고, 가짜 core 가 소켓과 agy 를 흉내 낸다.
// 실제 herdr-core·agy 는 띄우지 않는다. 복구의 시계(now)만 시험이 돌린다(대표 확인 필요까지의 2분을 기다리지 않게).
//
// Gemini 가 다른 점 둘을 본다:
// - 수신 증거가 훅 기록이다. 표지를 찾지 못한 까닭의 코드(marker_not_in_hook_log·hook_log_missing …)가 대표 선택지가 나오는 사유로 옮겨진다.
// - agy 는 첫 글을 받을 때 대화 id 를 정한다. 첫 전달의 봉투에는 id 가 없고 서버는 그 뒤에 알게 된다. 그래도 같은 세대·같은 터미널이면 다시 보낼 수 있다.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { DeliveryRecovery } from "../server/delivery-recovery.ts";
import { CoreRunner } from "../server/runner/core.ts";
import { geminiHookEventsDir } from "../server/runner/gemini-hooks.ts";
import type { DeliveryDispatch } from "../server/service-contracts.ts";
import type { RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { ERROR_CODES } from "../shared/error-codes.ts";
import { primesMcp, startFakeCore, type FakeCoreOptions } from "./fixtures/core-harness.ts";
import { thrower } from "./fixtures/settle.ts";

const FAKE_BIN = "/usr/bin/false";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function until<T>(what: string, read: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`시간 초과: ${what}`);
    await Bun.sleep(10);
  }
}

async function setup(cli: "gemini" | "claude" = "gemini", fake: Partial<FakeCoreOptions> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-gdel-")));
  const claudeHome = join(home, "claude-home"), codexHome = join(home, "codex-home"), geminiHome = join(home, "gemini-home"), run = join(home, "run");
  for (const dir of [claudeHome, codexHome, geminiHome, run]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const core = await startFakeCore({ claudeHome, contextHome: home, geminiHome, ...fake });
  const db = openDb(":memory:");
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "전달 복구 시험", cwd: home });
  const created = store.createMember({ projectId: project.id, handle: "research", name: "자료 조사", kind: "worker", cli, backend: "core" });
  const id = created.id;
  const opts: StartOpts = { systemPromptFile: join(run, `${id}.rules.md`), mcpConfigFile: join(run, `${id}.mcp.json`), resume: false };
  writeFileSync(opts.systemPromptFile, "너는 시험 팀장이다.\n");
  writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: ["bridge"], env: { IAMCEO_TOKEN: "secret-token", IAMCEO_URL: "http://127.0.0.1:1" } } } }), { mode: 0o600 });
  let time = Date.now();
  let service!: DeliveryRecovery;
  let runner!: CoreRunner;
  /** 총괄의 dispatchQuiescence 와 같은 판정(server/orchestrator.ts): 쓰기 호출은 끝났고(writerDone), 대표가 중복 위험에 동의했거나 턴 번호가 그대로면 다른 입력이 없었다고 본다. */
  const quiescence = (dispatch: DeliveryDispatch) => {
    const riskApproved = dispatch.items.length > 0 && dispatch.items.every(item => !!store.getDelivery(item.deliveryId) && !!store.getDeliveryRetry(item.deliveryId).retryReason?.startsWith("delivery_risk:"));
    const observed = runner.observationState(id);
    const untouched = !!observed && observed.failures === 0 && dispatch.baseline.turn !== null && observed.turn === dispatch.baseline.turn;
    const externalInput = riskApproved || untouched ? false : null;
    if (dispatch.transportState === "rejected") return { originalWrite: "rejected" as const, externalInput, riskApproved };
    if (dispatch.transportState === "prepared") return { originalWrite: "not_written" as const, externalInput, riskApproved };
    if (dispatch.transportState === "accepted") {
      const delivered = dispatch.items.every(item => store.getDelivery(item.deliveryId)?.status === "delivered");
      return { originalWrite: "settled" as const, externalInput: delivered ? null : externalInput, unconfirmed: !delivered, riskApproved };
    }
    return { originalWrite: "settled" as const, externalInput, unconfirmed: true, riskApproved };
  };
  runner = new CoreRunner({ socketPath: core.socketPath, claudeBin: FAKE_BIN, codexBin: FAKE_BIN, geminiBin: FAKE_BIN, claudeHome, codexHome, geminiHome, contextHome: home },
    { pollMs: 20, rpcTimeoutMs: 2000, sendTimeoutMs: 300, contextTimeoutMs: 300, hookShadow: false, recoveryStore: store,
      repair: { load: (memberId, request) => service.repair.load(memberId, request), prepare: (memberId, request, dispatch) => service.repair.prepare(memberId, request, dispatch) },
      quiescence: (_memberId, dispatch) => quiescence(dispatch) });
  /** 복구가 실행기에 다시 넣기를 맡기기 직전에 끼워 넣을 일(확인과 다시 넣기 사이에 상태가 바뀌는 경우를 만든다). */
  let beforeRepair: (() => Promise<void>) | null = null;
  const recoveryRunner = {
    inspectDelivery: (m: RunnerMember, query: Parameters<CoreRunner["inspectDelivery"]>[1]) => runner.inspectDelivery(m, query),
    inspectGoneDelivery: (m: RunnerMember, query: Parameters<CoreRunner["inspectGoneDelivery"]>[1]) => runner.inspectGoneDelivery(m, query),
    terminalGone: (terminalId: string) => runner.terminalGone(terminalId),
    repairDelivery: async (m: RunnerMember, request: Parameters<CoreRunner["repairDelivery"]>[1]) => { await beforeRepair?.(); return runner.repairDelivery(m, request); },
  };
  service = new DeliveryRecovery({ store, runner: () => recoveryRunner, admit: () => true, writing: () => false, writerDone: () => true, now: () => time });
  const events: RunnerEvent[] = [];
  // 총괄이 하듯 실행기가 알아낸 터미널·대화 id 를 명부에 적는다.
  runner.on(event => {
    events.push(event);
    if (event.type === "session" && event.memberId === id) store.patchMember(id, { sessionId: event.sessionId });
    if (event.type === "pane" && event.memberId === id) store.patchMember(id, { paneId: event.paneId });
  });
  cleanups.push(async () => { await service.shutdown(); await runner.shutdown(); await core.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });
  const member = () => store.requireMember(id);
  const rm = (): RunnerMember => ({ ...member(), sessionGeneration: store.memberRevisions(id).sessionGeneration, model: null, effort: null, subagentModel: null, permissionMode: "bypassPermissions" });
  const r = (deliveryId: string) => store.getDeliveryRecovery(deliveryId)!;
  /** 총괄의 sendEnvelope 와 같은 순서: 봉투를 저장하고(쓰기 직전의 신원·훅 자리), 쓰기 시작으로 바꾼 뒤 넣는다. 결과를 복구에 적는다. */
  async function sendEnvelope(deliveryId: string): Promise<{ dispatch: DeliveryDispatch; result: SendResult }> {
    const observed = runner.observationState(id)!;
    const hookMark = runner.deliveryHookMark(rm());
    const dispatch = service.prepareDispatch([deliveryId], observed.identity, { serverEpoch: "test-epoch", turn: observed.turn, inputEpoch: observed.inputEpoch, logs: runner.deliveryBaseline(rm()), capturedAt: new Date().toISOString(), ...(hookMark !== undefined ? { hookMark } : {}) });
    store.transaction(() => {
      store.updateDispatch(dispatch.dispatchId, "prepared", "write_started");
      store.setDeliveryStatus(deliveryId, "delivering", { attempt: true });
    });
    const result = await runner.send(rm(), dispatch.wireText, { ...opts, marker: dispatch.bundleMarker });
    service.recordResult(dispatch.dispatchId, result);
    return { dispatch, result };
  }
  /** 다음 확인 시각으로 시계를 돌리고 확인을 한 번 돈다. */
  async function check(deliveryId: string, advanceMs = 0) {
    time = Math.max(time + advanceMs, Date.parse(r(deliveryId).nextCheckAt ?? new Date(time).toISOString()));
    await service.tick();
  }
  const notice = (deliveryId: string) => service.memberNotices(id).items.find(item => item.id === deliveryId);
  return { home, core, store, project, id, opts, member, rm, r, events, sendEnvelope, check, notice,
    get runner() { return runner; }, get service() { return service; }, get now() { return time; }, set beforeRepair(value: (() => Promise<void>) | null) { beforeRepair = value; } };
}

describe("결과를 모르는 Gemini 전달: 대표가 중복 위험을 알고 다시 보낼 수 있다", () => {
  test("첫 전달의 결과를 모른 채 대화 id 를 알게 된 뒤에도: 확인 → 대표 확인 필요(아는 사유) → 다시 보내기 선택 → 같은 터미널에 재전송 → 전달됨", async () => {
    const f = await setup();
    const started = await f.runner.start(f.rm(), f.opts);
    expect(f.member().paneId).toBe(started.paneId);
    expect(f.member().sessionId).toBeNull();
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.id, kind: "instruction", text: "자료를 찾아 보고해 주세요" });
    // 넣는 호출이 답 없이 끝났다(엔진이 답하지 않았다): 들어갔는지 모른다. 실제로는 들어가지 않았다.
    f.core.intercept(call => call.method === "terminal.send" && !primesMcp(call) ? "drop" : undefined);
    const { dispatch, result } = await f.sendEnvelope(d.id);
    f.core.intercept(null);
    expect(result).toMatchObject({ ok: false, deliveryEffect: "unknown" });
    // 첫 전달의 봉투에는 대화 id 가 없다(agy 는 첫 글을 받을 때 정한다).
    expect(dispatch.cli).toBe("gemini");
    expect(dispatch.identity).toMatchObject({ terminalId: started.paneId, sessionId: null });
    expect(f.store.getDispatch(dispatch.dispatchId)!.transportState).toBe("unknown");
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "held", holdReason: "delivery_unknown" });
    expect(f.service.fenced(f.id)).toBe(true);
    // 그 뒤 대표가 터미널에서 직접 글을 쳤다: 대화가 생기고, 서버가 그 id 를 알아내 명부에 적는다. 봉투의 id(null)와 달라졌다.
    f.core.typeDirectly(f.id, "대표가 터미널에서 직접 친 글");
    const conversation = await until("대화 id", () => f.member().sessionId);
    await until("턴 끝", () => f.core.turns(f.id)[0]?.outcome === "done" && f.runner.observationState(f.id)?.state === "done");
    expect(conversation).toBe(f.core.runs()[0]!.sessionId!);

    // 확인: 훅 기록은 있지만 그 전달의 표지가 없다. '안 받았다'는 근거가 아니므로 스스로 다시 넣지 않는다.
    await f.check(d.id);
    expect(f.r(d.id)).toMatchObject({ phase: "checking", reason: "log_incomplete", autoAttempts: 0 });
    expect(f.r(d.id).evidence[0]).toMatchObject({ source: "gemini_log", verdict: "unknown", code: "marker_not_in_hook_log" });
    expect(f.notice(d.id)!.allowedActions).toEqual(["recheck", "stop_retry"]);
    expect(f.core.turns(f.id)).toHaveLength(1);
    // 2분 동안 정하지 못하면 대표에게 묻는다. 사유는 '세션이 바뀜'이 아니라 선택지가 나오는 아는 사유다.
    await f.check(d.id, 121_000);
    expect(f.r(d.id)).toMatchObject({ phase: "needs_owner", reason: "log_incomplete" });
    const asked = f.notice(d.id)!;
    expect(asked).toMatchObject({ phase: "needs_owner", reason: "log_incomplete", note: ERROR_CODES.note_log_incomplete.ko });
    expect(asked.allowedActions).toEqual(["recheck", "retry_with_risk", "stop_retry"]);
    expect(f.core.turns(f.id)).toHaveLength(1);

    // 대표가 중복 위험을 알고 다시 보내기를 고른다.
    const chosen = await f.service.recover(d.id, { operationId: randomUUID(), expectedVersion: asked.version, action: "retry_with_risk", acceptDuplicateRisk: true });
    expect(chosen).toMatchObject({ outcome: "retry_scheduled" });
    // 다음 확인이 쉬는 CLI·빈 입력칸을 다시 보고 같은 터미널에 새 봉투로 넣는다.
    await f.check(d.id);
    await until("재전송", () => f.core.turns(f.id).length === 2);
    const resent = f.core.turns(f.id)[1]!;
    const item = dispatch.markers[0]!.marker;
    expect(resent.terminal).toBe(started.paneId);
    expect(resent.prompt).toContain("자료를 찾아 보고해 주세요");
    // 전달의 표지는 그대로이고 묶음 표지는 새 봉투의 것이다.
    expect(resent.prompt).toContain(item);
    expect(resent.prompt).not.toContain(dispatch.bundleMarker);
    const latest = f.store.latestDispatchFor(f.id, d.id)!;
    expect(latest.dispatchId).not.toBe(dispatch.dispatchId);
    expect(resent.prompt).toBe(latest.wireText);
    expect(latest.transportState).toBe("accepted");
    expect(f.store.requireDelivery(d.id).status).toBe("delivered");
    expect(f.r(d.id)).toMatchObject({ phase: "resolved" });
    // 옛 봉투의 쓰기도 닫혔다: 그 팀장의 전달 줄이 풀린다.
    expect(f.store.getDispatch(dispatch.dispatchId)!.transportState).toBe("accepted");
    expect(f.service.fenced(f.id)).toBe(false);
    expect(f.notice(d.id)).toBeUndefined();
    // 같은 대화에 들어갔다(새 대화가 되지 않았다).
    await until("턴 끝", () => resent.outcome === "done");
    expect(resent.run.sessionId).toBe(conversation);
    expect(f.member().sessionId).toBe(conversation);
  });

  test("훅 기록이 아예 없으면(훅 줄이 한 번도 남지 않았다) 사유는 '기록 없음'이고, 역시 다시 보내기를 고를 수 있다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.rm(), f.opts);
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.id, kind: "instruction", text: "첫 지시" });
    f.core.intercept(call => call.method === "terminal.send" && !primesMcp(call) ? "drop" : undefined);
    const { dispatch } = await f.sendEnvelope(d.id);
    f.core.intercept(null);
    expect(existsSync(join(geminiHookEventsDir(f.home), `${f.id}.jsonl`))).toBe(false);
    await f.check(d.id);
    expect(f.r(d.id)).toMatchObject({ phase: "checking", reason: "log_missing" });
    expect(f.r(d.id).evidence[0]).toMatchObject({ source: "gemini_log", code: "hook_log_missing" });
    await f.check(d.id, 121_000);
    const asked = f.notice(d.id)!;
    expect(asked).toMatchObject({ phase: "needs_owner", reason: "log_missing", note: ERROR_CODES.note_log_missing.ko });
    expect(asked.allowedActions).toEqual(["recheck", "retry_with_risk", "stop_retry"]);
    await f.service.recover(d.id, { operationId: randomUUID(), expectedVersion: asked.version, action: "retry_with_risk", acceptDuplicateRisk: true });
    await f.check(d.id);
    await until("재전송", () => f.core.turns(f.id).length === 1);
    expect(f.core.turns(f.id)[0]!.prompt).toContain(dispatch.markers[0]!.marker);
    expect(f.store.requireDelivery(d.id).status).toBe("delivered");
    expect(f.service.fenced(f.id)).toBe(false);
    // 재전송이 이 터미널의 첫 글이다: 그 대화의 id 를 알아내 명부에 적는다.
    expect(await until("대화 id", () => f.member().sessionId)).toBe(f.core.runs()[0]!.sessionId!);
    expect(f.core.runs()).toHaveLength(1);
    expect(started.paneId).toBe(f.member().paneId!);
  });

  test("복구가 다시 넣기를 맡긴 뒤에 대화 id 를 알게 돼도 '세션이 바뀜'으로 거절하지 않는다(세대와 터미널이 같으면 넣는다)", async () => {
    const f = await setup();
    const started = await f.runner.start(f.rm(), f.opts);
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.id, kind: "instruction", text: "첫 지시" });
    f.core.intercept(call => call.method === "terminal.send" && !primesMcp(call) ? "drop" : undefined);
    await f.sendEnvelope(d.id);
    f.core.intercept(null);
    await f.check(d.id);
    await f.check(d.id, 121_000);
    await f.service.recover(d.id, { operationId: randomUUID(), expectedVersion: f.r(d.id).version, action: "retry_with_risk", acceptDuplicateRisk: true });
    // 복구의 확인 때는 대화 id 를 몰랐다(요청의 세션 id 는 비어 있다). 실행기가 넣기 직전에 agy 가 상태줄로 대화 id 를 알린다.
    let slipped = 0;
    f.beforeRepair = async () => {
      slipped++;
      expect(f.runner.observationState(f.id)?.identity.sessionId).toBeNull();
      f.core.drawGeminiStatus(f.id, { conversation_id: "conversation-known-late", session_id: "conversation-known-late" });
      await until("대화 id", () => f.runner.observationState(f.id)?.identity.sessionId === "conversation-known-late");
    };
    await f.check(d.id);
    expect(slipped).toBe(1);
    expect(f.member().sessionId).toBe("conversation-known-late");
    await until("재전송", () => f.core.turns(f.id).length === 1);
    expect(f.core.turns(f.id)[0]!.terminal).toBe(started.paneId);
    expect(f.store.requireDelivery(d.id).status).toBe("delivered");
    expect(f.r(d.id)).toMatchObject({ phase: "resolved" });
  });

  test("실제로는 들어갔던 전달이면 다시 넣지 않는다: 훅 기록의 표지로 받은 것이 확인된다(대표가 다시 보내기를 골랐어도)", async () => {
    const f = await setup();
    await f.runner.start(f.rm(), f.opts);
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.id, kind: "instruction", text: "한 번만 들어가야 하는 지시" });
    // 글은 들어갔는데 답이 끊겼다: 가짜 core 가 넣기를 처리한 뒤 답을 버린다.
    let dropped = false;
    f.core.intercept(call => {
      if (call.method !== "terminal.send" || primesMcp(call) || dropped) return undefined;
      dropped = true;
      f.core.typeDirectly(f.id, String(call.params.text));
      return "drop";
    });
    const { result } = await f.sendEnvelope(d.id);
    f.core.intercept(null);
    expect(result).toMatchObject({ ok: false, deliveryEffect: "unknown" });
    await until("턴 끝", () => f.core.turns(f.id)[0]?.outcome === "done" && f.runner.observationState(f.id)?.state === "done");
    await f.check(d.id);
    expect(f.store.requireDelivery(d.id).status).toBe("delivered");
    expect(f.r(d.id)).toMatchObject({ phase: "resolved" });
    expect(f.r(d.id).evidence[0]).toMatchObject({ source: "gemini_log", verdict: "present", code: "marker_in_user_input" });
    expect(f.core.turns(f.id)).toHaveLength(1);
    expect(f.service.fenced(f.id)).toBe(false);
  });

  test("터미널이 바뀐 뒤(옛 터미널이 사라짐)에도 대표가 다시 보내기를 고를 수 있다: 봉투에 대화 id 가 없어도 같은 세대면 된다", async () => {
    const f = await setup();
    const started = await f.runner.start(f.rm(), f.opts);
    const d = f.store.enqueue({ projectId: f.project.id, memberId: f.id, kind: "instruction", text: "옛 터미널에 넣다 만 지시" });
    f.core.intercept(call => call.method === "terminal.send" && !primesMcp(call) ? "drop" : undefined);
    const { dispatch } = await f.sendEnvelope(d.id);
    f.core.intercept(null);
    // 대표가 직접 친 글로 대화가 생겼고, 그 뒤 터미널을 끝내고 같은 대화로 다시 열었다(재우기 → 깨우기).
    f.core.typeDirectly(f.id, "직접 친 글");
    const conversation = await until("대화 id", () => f.member().sessionId);
    await until("턴 끝", () => f.core.turns(f.id)[0]?.outcome === "done" && f.runner.observationState(f.id)?.state === "done");
    await f.runner.stop(f.rm());
    const reopened = await f.runner.start({ ...f.rm(), paneId: null }, { ...f.opts, resume: true });
    expect(reopened.paneId).not.toBe(started.paneId);
    expect(f.member()).toMatchObject({ paneId: reopened.paneId, sessionId: conversation });
    // 사라진 터미널의 봉투는 터미널 없이 훅 기록만으로 본다. 표지가 없다는 것은 '안 받았다'가 아니므로 대표에게 묻는다.
    await f.check(d.id);
    const asked = f.notice(d.id)!;
    expect(asked).toMatchObject({ phase: "needs_owner", reason: "log_incomplete" });
    expect(asked.evidence[0]).toMatchObject({ source: "gemini_log", verdict: "unknown", code: "marker_not_in_hook_log" });
    expect(asked.allowedActions).toEqual(["recheck", "retry_with_risk", "stop_retry"]);
    await f.service.recover(d.id, { operationId: randomUUID(), expectedVersion: asked.version, action: "retry_with_risk", acceptDuplicateRisk: true });
    await f.check(d.id);
    // 옛 봉투는 닫히고 전달은 대기열로 돌아간다. 다음 전달이 지금 터미널에 새 봉투로 넣는다.
    expect(f.store.getDispatch(dispatch.dispatchId)!.transportState).toBe("rejected");
    expect(f.store.requireDelivery(d.id).status).toBe("queued");
    expect(f.service.fenced(f.id)).toBe(false);
    const again = await f.sendEnvelope(d.id);
    expect(again.result).toMatchObject({ ok: true });
    expect(again.dispatch.identity).toMatchObject({ terminalId: reopened.paneId, sessionId: conversation });
    await until("전달", () => f.core.turns(f.id).length === 2);
    expect(f.core.turns(f.id)[1]!.terminal).toBe(reopened.paneId);
  });
});

describe("Claude·Codex 봉투의 신원 대조는 그대로다(가짜 실행기로 복구 판정만 본다)", () => {
  /** 같은 확인 결과를 CLI 만 바꿔 넣는다: 터미널·세대는 같고 대화(세션) id 만 봉투와 달라졌다. */
  async function judge(cli: "claude" | "codex" | "gemini") {
    const db = openDb(":memory:");
    cleanups.push(() => db.close());
    const store = new Store(db, new Bus());
    const project = store.createProject({ name: "복구 판정", cwd: "/private/tmp/iamceo-fake-work" });
    const member = store.createMember({ projectId: project.id, handle: "worker", name: "결제 연동", kind: "worker", cli, backend: "core", paneId: "terminal-1", sessionId: "session-at-send" });
    let time = Date.now();
    const repairs: string[] = [];
    const evidence = cli === "gemini"
      ? { source: "gemini_log" as const, verdict: "unknown" as const, location: "none" as const, code: "marker_not_in_hook_log", complete: false, checkedAt: new Date(time).toISOString() }
      : { source: `${cli}_log` as "claude_log" | "codex_log", verdict: "unknown" as const, location: "none" as const, code: "partial_log", complete: false, checkedAt: new Date(time).toISOString() };
    const service: DeliveryRecovery = new DeliveryRecovery({ store, now: () => time, admit: () => true, writing: () => false, writerDone: () => true, runner: () => ({
      inspectDelivery: async (_member, query) => ({ finding: "unknown" as const, evidence: [evidence], receivedDeliveryIds: [], quiescence: "settled" as const,
        snapshot: { identity: { ...query.identity, sessionId: "session-now" }, observedAt: new Date(time).toISOString(), turn: 1, inputEpoch: 1, ownership: "verified" as const, status: "idle" as const, blockedReason: null, leaseActive: false, mutation: "none" as const, composer: "empty" as const, originalWrite: "settled" as const, externalInput: false } }),
      repairDelivery: async (_member, request) => {
        const dispatch = service.repair.load(member.id, request);
        if (!dispatch || !service.repair.prepare(member.id, request, dispatch)) return { ok: false as const, reason: "busy" as const, retryable: true, deliveryEffect: "not_written" as const };
        repairs.push(request.dispatchId);
        return { ok: true as const, receipt: { dispatchId: request.dispatchId, receivedAt: new Date(time).toISOString(), source: "transport" as const } };
      },
    }) });
    cleanups.push(() => service.shutdown());
    const d = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: "지시" });
    const dispatch = service.prepareDispatch([d.id], { terminalId: "terminal-1", sessionId: "session-at-send", sessionGeneration: store.memberRevisions(member.id).sessionGeneration, process: null }, { serverEpoch: "test-epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date(time).toISOString() });
    service.recordResult(dispatch.dispatchId, { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" });
    // 그 뒤 명부의 대화(세션) id 가 봉투와 달라졌다.
    store.patchMember(member.id, { sessionId: "session-now" });
    const r = () => store.getDeliveryRecovery(d.id)!;
    const due = async (advance = 0) => { time = Math.max(time + advance, Date.parse(r().nextCheckAt ?? new Date(time).toISOString())); await service.tick(); };
    await due();
    await due(121_000);
    const notice = () => service.memberNotices(member.id).items.find(item => item.id === d.id)!;
    return { store, service, d, r, due, notice, repairs, dispatch };
  }

  test.each(["claude", "codex"] as const)("%s: 세션 id 가 달라지면 지금처럼 '세션이 바뀜'이고 다시 보내기를 고를 수 없다", async (cli) => {
    const f = await judge(cli);
    expect(f.r()).toMatchObject({ phase: "needs_owner", reason: "session_lost" });
    expect(f.notice().allowedActions).toEqual(["recheck", "stop_retry"]);
    expect(await thrower(f.service.recover(f.d.id, { operationId: randomUUID(), expectedVersion: f.r().version, action: "retry_with_risk", acceptDuplicateRisk: true }))).toThrow();
    expect(f.repairs).toEqual([]);
    // 옛 봉투의 쓰기도 닫지 않는다(다른 세션의 관측으로는 닫을 수 없다).
    expect(f.store.getDispatch(f.dispatch.dispatchId)!.transportState).toBe("unknown");
  });

  test("gemini: 같은 확인 결과에서 대화 id 만 달라진 것은 '세션이 바뀜'이 아니다. 아는 사유로 묻고, 고르면 다시 보낸다", async () => {
    const f = await judge("gemini");
    expect(f.r()).toMatchObject({ phase: "needs_owner", reason: "log_incomplete" });
    expect(f.notice().allowedActions).toEqual(["recheck", "retry_with_risk", "stop_retry"]);
    await f.service.recover(f.d.id, { operationId: randomUUID(), expectedVersion: f.r().version, action: "retry_with_risk", acceptDuplicateRisk: true });
    await f.due();
    expect(f.repairs).toHaveLength(1);
    expect(f.repairs[0]).not.toBe(f.dispatch.dispatchId);
    expect(f.store.requireDelivery(f.d.id).status).toBe("delivered");
    expect(f.store.getDispatch(f.dispatch.dispatchId)!.transportState).toBe("accepted");
  });

  test("gemini 라도 터미널이나 세대가 다르면 '세션이 바뀜'이다(대화 id 만 빼고 견준다)", async () => {
    const db = openDb(":memory:");
    cleanups.push(() => db.close());
    const store = new Store(db, new Bus());
    const project = store.createProject({ name: "복구 판정", cwd: "/private/tmp/iamceo-fake-work" });
    const member = store.createMember({ projectId: project.id, handle: "worker", name: "자료 조사", kind: "worker", cli: "gemini", backend: "core", paneId: "terminal-1", sessionId: null });
    let time = Date.now();
    let seen = { terminalId: "terminal-2", sessionGeneration: store.memberRevisions(member.id).sessionGeneration };
    const service = new DeliveryRecovery({ store, now: () => time, admit: () => true, writing: () => false, writerDone: () => true, runner: () => ({
      inspectDelivery: async (_member, query) => ({ finding: "unknown" as const, evidence: [{ source: "gemini_log" as const, verdict: "unknown" as const, location: "none" as const, code: "marker_not_in_hook_log", complete: false, checkedAt: new Date(time).toISOString() }], receivedDeliveryIds: [], quiescence: "settled" as const,
        snapshot: { identity: { ...query.identity, ...seen, sessionId: "conversation-1" }, observedAt: new Date(time).toISOString(), turn: 1, inputEpoch: 1, ownership: "verified" as const, status: "idle" as const, blockedReason: null, leaseActive: false, mutation: "none" as const, composer: "empty" as const, originalWrite: "settled" as const, externalInput: false } }),
    }) });
    cleanups.push(() => service.shutdown());
    const d = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: "지시" });
    const dispatch = service.prepareDispatch([d.id], { terminalId: "terminal-1", sessionId: null, sessionGeneration: store.memberRevisions(member.id).sessionGeneration, process: null }, { serverEpoch: "test-epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date(time).toISOString() });
    service.recordResult(dispatch.dispatchId, { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" });
    const r = () => store.getDeliveryRecovery(d.id)!;
    const due = async (advance = 0) => { time = Math.max(time + advance, Date.parse(r().nextCheckAt ?? new Date(time).toISOString())); await service.tick(); };
    await due();
    expect(r().reason).toBe("session_lost");
    seen = { terminalId: "terminal-1", sessionGeneration: seen.sessionGeneration + 1 };
    await due();
    expect(r().reason).toBe("session_lost");
    expect(store.getDispatch(dispatch.dispatchId)!.transportState).toBe("unknown");
    // 같은 터미널·같은 세대로 보이면 아는 사유다.
    seen = { terminalId: "terminal-1", sessionGeneration: seen.sessionGeneration - 1 };
    await due();
    expect(r().reason).toBe("log_incomplete");
  });
});

describe("Gemini 훅 근거의 코드 → 대표 선택지가 나오는 사유", () => {
  const CODES: [string, "log_missing" | "log_incomplete"][] = [
    ["hooks_off", "log_missing"], ["no_baseline", "log_missing"], ["hook_log_missing", "log_missing"],
    ["marker_not_in_hook_log", "log_incomplete"], ["hook_log_rotated", "log_incomplete"], ["hook_log_unreadable", "log_incomplete"], ["hook_log_untrusted", "log_incomplete"],
  ];
  /** 가짜 실행기로 복구 판정만 본다. gone: 봉투의 터미널이 사라지고 팀장은 새 터미널에 있다(터미널 없이 훅 기록만 본다). */
  async function judged(code: string, gone: boolean, source: "gemini_log" | "claude_log" = "gemini_log") {
    const db = openDb(":memory:");
    cleanups.push(() => db.close());
    const store = new Store(db, new Bus());
    const project = store.createProject({ name: "복구 판정", cwd: "/private/tmp/iamceo-fake-work" });
    const member = store.createMember({ projectId: project.id, handle: "worker", name: "자료 조사", kind: "worker", cli: source === "gemini_log" ? "gemini" : "claude", backend: "core", paneId: "terminal-1", sessionId: source === "gemini_log" ? null : "session-1" });
    let time = Date.now();
    const evidence = () => [{ source, verdict: "unknown" as const, location: "none" as const, code, complete: false, checkedAt: new Date(time).toISOString() }];
    const service = new DeliveryRecovery({ store, now: () => time, admit: () => true, writing: () => false, writerDone: () => true, runner: () => ({
      terminalGone: async (terminalId: string) => gone && terminalId === "terminal-1",
      inspectGoneDelivery: () => ({ finding: "unknown" as const, evidence: evidence(), receivedDeliveryIds: [], snapshot: null, quiescence: "unresolved" as const }),
      inspectDelivery: async (_member, query) => ({ finding: "unknown" as const, evidence: evidence(), receivedDeliveryIds: [], quiescence: "settled" as const,
        snapshot: { identity: query.identity, observedAt: new Date(time).toISOString(), turn: 1, inputEpoch: 1, ownership: "verified" as const, status: "idle" as const, blockedReason: null, leaseActive: false, mutation: "none" as const, composer: "empty" as const, originalWrite: "settled" as const, externalInput: false } }),
    }) });
    cleanups.push(() => service.shutdown());
    const d = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: "지시" });
    const dispatch = service.prepareDispatch([d.id], { terminalId: "terminal-1", sessionId: member.sessionId, sessionGeneration: store.memberRevisions(member.id).sessionGeneration, process: null }, { serverEpoch: "test-epoch", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date(time).toISOString() });
    service.recordResult(dispatch.dispatchId, { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" });
    if (gone) store.patchMember(member.id, { paneId: "terminal-2" });
    const r = () => store.getDeliveryRecovery(d.id)!;
    const due = async (advance = 0) => { time = Math.max(time + advance, Date.parse(r().nextCheckAt ?? new Date(time).toISOString())); await service.tick(); };
    await due();
    if (!gone) await due(121_000);
    return { record: r(), actions: service.memberNotices(member.id).items.find(item => item.id === d.id)!.allowedActions };
  }

  test.each(CODES)("살아 있는 터미널: %s → %s, 다시 보내기를 고를 수 있다", async (code, reason) => {
    const { record, actions } = await judged(code, false);
    expect(record).toMatchObject({ phase: "needs_owner", reason });
    expect(actions).toEqual(["recheck", "retry_with_risk", "stop_retry"]);
  });
  test.each(CODES)("사라진 터미널: %s → %s, 다시 보내기를 고를 수 있다", async (code, reason) => {
    const { record, actions } = await judged(code, true);
    expect(record).toMatchObject({ phase: "needs_owner", reason });
    expect(actions).toEqual(["recheck", "retry_with_risk", "stop_retry"]);
  });
  test("옮기지 않는 것: 표지·팀장 id 가 잘못됐다는 코드, 그리고 같은 글자의 코드라도 Gemini 훅 근거가 아닌 것", async () => {
    for (const code of ["invalid_marker", "invalid_member"]) {
      const { record, actions } = await judged(code, false);
      expect(record).toMatchObject({ phase: "needs_owner", reason: code });
      expect(actions).toEqual(["recheck", "stop_retry"]);
    }
    // Claude 의 기록 근거에 같은 글자의 코드가 실려 와도 Claude 의 판정은 그대로다(아는 사유로 옮기지 않는다).
    const claude = await judged("marker_not_in_hook_log", false, "claude_log");
    expect(claude.record).toMatchObject({ phase: "needs_owner", reason: "marker_not_in_hook_log" });
    expect(claude.actions).toEqual(["recheck", "stop_retry"]);
  });
});
