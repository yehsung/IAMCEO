// 0.2.7 배포 전 확인(실제 CLI·라이브 사본, verify/real-cli.md P1~P4, live-copy.md 문제 3)에서 나온 서버 문제.
// 실행기는 실제 CoreRunner, 총괄은 운영 배선, core 는 가짜(tests/fixtures/core-harness.ts). 화면은 실측 모양을 옮긴 합성 견본이고 글은 가짜다.
// - P1: 급한 지시로 Codex 의 턴은 멈췄지만 하던 셸 명령이 백그라운드 터미널로 계속 돈다. IAMCEO 는 그 명령을 끄지 않고 사실대로 알린다.
// - P2: 그 프로그램 뒤에서 30분 넘게 기다린 대표 일은 '하던 일을 마치는 중'(알림)이 아니라 막힘·푸시. 총괄은 같은 알림을 두 번 받지 않는다.
// - P3: Claude 의 도는 압축을 멈추면 되돌아온 /compact 명령이 입력칸을 막는다. IAMCEO 가 넣은 글과 글자까지 같을 때만 지운다.
// - P4: 멈출 턴이 없는(쉬는) CLI 에 '중단'은 멈춤 키를 보내지 않는다(쉬는 Codex 에 Esc 두 번 = 기록 보기 화면).
// - 문제 3: 대표 화면의 새 글에 오늘 일은 시각만, 내부 번호(#dl_…·#d_…)는 싣지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleAgentTool } from "../server/agent-tools.ts";
import { inputText } from "../server/runner/claude-screen.ts";
import { ERROR_CODES } from "../shared/error-codes.ts";
import { formatTextTime, renderServerText, sinceParam, textRef } from "../shared/server-text.ts";
import type { Member } from "../shared/types.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions, type FakeCoreCall } from "./fixtures/core-harness.ts";

const CODEX = join(import.meta.dir, "fixtures", "cli", "codex", "0.166.0");
const CLAUDE = join(import.meta.dir, "fixtures", "cli", "claude", "2.1.323");
const BACKGROUND = readFileSync(join(CODEX, "background-idle.txt"), "utf8");
const INTERRUPTED = readFileSync(join(CODEX, "background-interrupted.txt"), "utf8");
const BACKGROUND_WORKING = readFileSync(join(CODEX, "background-working.txt"), "utf8");
const CODEX_IDLE = "\n› Ask Codex to do anything\n\n  GPT-6-Astra high Fast · ~/workspace/sample-app\n  ? for shortcuts\n";

const rows = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const meta = (id: string, cwd: string) => ({ type: "session_meta", payload: { id, session_id: id, cwd, source: "cli", cli_version: "0.166.0" } });
const started = (turn: string) => ({ type: "event_msg", payload: { type: "task_started", turn_id: turn } });
const complete = (turn: string) => ({ type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: "가짜 답" } });
const aborted = (turn: string) => ({ type: "event_msg", payload: { type: "turn_aborted", turn_id: turn, reason: "interrupted" } });
const user = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const tokens = { type: "event_msg", payload: { type: "token_count", info: { model_context_window: 258_400, last_token_usage: { total_tokens: 42_000 } } } };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(opts: CoreSetupOptions = {}): Promise<CoreEnv> {
  const t = await coreSetup({ ...opts, runnerDeps: { backgroundNoticeMs: 0, ...opts.runnerDeps } });
  cleanups.push(() => t.close());
  return t;
}
const generation = (t: CoreEnv, id: string) => t.store.memberRevisions(id).sessionGeneration;
const lastRun = (t: CoreEnv, id: string) => t.store.lastWrittenExecution(id, generation(t, id));
const activity = (t: CoreEnv, id: string) => t.store.listActivity(id, 500);
const codes = (t: CoreEnv, id: string) => activity(t, id).map(a => a.textCode).filter(Boolean);
const calls = (t: CoreEnv, method: string, terminal?: string) => t.core.calls.filter(c => c.method === method && (!terminal || c.params.terminal === terminal));

/** Codex 팀장에게 일을 넣고 그 턴이 working 으로 남게 한다(오래 도는 셸 명령을 기다리는 Codex). */
async function codexAtWork(t: CoreEnv, name = "서버 점검"): Promise<{ m: Member; prompt: string }> {
  const m = await t.orch.createMember(t.project.id, { name, cli: "codex" });
  t.core.setScreen(m.id, CODEX_IDLE);
  t.core.setDirectives("@fake:hold");
  await t.orch.assign(t.project.id, m.handle, { text: "긴 명령을 돌리고 보고하세요" });
  const turn = await t.waitFor("첫 턴", () => t.core.turns(m.id)[0]);
  t.core.setDirectives("");
  await t.waitFor("일하는 중", () => lastRun(t, m.id)?.phase === "running" && !!lastRun(t, m.id)?.lastProgressAt && t.member(m.id).status === "working");
  return { m: t.member(m.id), prompt: turn.prompt };
}
/** Codex 가 그 세션에 남긴 rollout(턴은 열린 채). 끝은 시험이 덧붙인다. */
function rollout(t: CoreEnv, m: Member, prompt: string): string {
  const id = randomUUID(), dir = join(t.home, "codex-home", "sessions", "2026", "11", "16");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-test-${id}.jsonl`);
  writeFileSync(path, rows(meta(id, m.cwd), started("turn-1"), user(prompt), tokens));
  return path;
}
/** 대표가 총괄에게 쓴 글(서버가 인용을 맞춰 볼 원문). 총괄을 깨우지 않게 저장소에 바로 남긴다. */
const ownerSaid = (t: CoreEnv, body: string) => t.store.createMessage({ projectId: t.project.id, mine: true, who: "나", kind: "나", body });
const tool = async (t: CoreEnv, lead: Member, name: string, args: Record<string, unknown>) => (await handleAgentTool(t.orch, t.member(lead.id), name, args)).text;

describe("P1 급한 지시 + Codex 가 오래 도는 셸 명령", () => {
  test("턴은 멈췄지만 명령이 백그라운드 터미널로 계속 돌면, 도구 답·활동 줄이 그 사실과 /stop 을 알리고 IAMCEO 는 그 명령을 끄지 않는다. 명령이 끝나면 급한 지시가 맨 먼저 들어간다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    await t.idle(lead.id);
    const { m, prompt } = await codexAtWork(t);
    const path = rollout(t, m, prompt);
    const terminal = t.core.terminalOf(m.id)!.address;
    // 실제 Codex 0.166: Esc 로 턴은 곧바로 끝나지만(turn_aborted) 명령은 백그라운드 터미널로 남아 core 는 working, terminal.interrupt 는 still_working.
    t.core.intercept((call: FakeCoreCall) => {
      if (call.method !== "terminal.interrupt") return undefined;
      t.core.setScreen(m.id, INTERRUPTED);
      appendFileSync(path, rows(aborted("turn-1")));
      return { result: { outcome: "still_working", key: "esc" } };
    });
    ownerSaid(t, "지금 하던 명령은 멈추고 설정 파일 먼저 고쳐 줘");
    const reply = await tool(t, lead, "team_assign", { member: m.handle, text: "설정 파일 먼저 고치기", user_quote: "지금 하던 명령은 멈추고 설정 파일 먼저 고쳐 줘", urgent: true });
    t.core.intercept(null);
    expect(reply).toContain("턴은 멈췄지만 실행하던 명령(백그라운드 터미널 1개)이 계속 돌고 있어, 그 명령이 끝나거나 대표가 터미널에서 /stop 으로 닫아야 이 지시가 맨 먼저 들어갑니다");
    expect(reply).toContain("IAMCEO는 그 명령을 끄지 않습니다");
    expect(reply).not.toContain("확인하지 못했습니다");
    const urgent = activity(t, m.id).find(a => a.textCode === "activity.urgent_interrupt_background")!;
    expect(urgent.textParams).toEqual({ count: "1" });
    expect(urgent.text).toContain("터미널에서 /stop 으로 닫아야 급한 지시가 들어갑니다");
    expect(urgent.text).not.toContain("#");
    // Codex 기록의 중단(turn_aborted)이 그 턴의 끝이다: 업무를 닫고 쉬는 중으로 보이며, 활동에 '턴은 멈췄지만 명령이 계속' 한 줄.
    await t.waitFor("업무 닫힘", () => lastRun(t, m.id)?.phase === "ended");
    expect(lastRun(t, m.id)).toMatchObject({ reason: "codex_background_terminal" });
    await t.waitFor("쉬는 중", () => t.member(m.id).status === "idle" && t.runner.backgroundTerminals(m.id) === 1);
    await t.waitFor("활동 줄", () => codes(t, m.id).includes("activity.codex_background_after_stop"));
    expect(codes(t, m.id)).not.toContain("activity.codex_background_unverified");
    expect(codes(t, m.id)).not.toContain("activity.codex_background_left");
    // 그 명령이 도는 동안 급한 지시는 넣지 않는다. IAMCEO 는 명령을 끄지 않는다(키·/stop·종료 없음). 멈춘 턴에 보고 보완도 묻지 않는다.
    await Bun.sleep(200);
    expect(t.core.turns(m.id)).toHaveLength(1);
    expect(calls(t, "terminal.interrupt", terminal)).toHaveLength(1);
    expect(calls(t, "terminal.keys", terminal)).toHaveLength(0);
    expect(calls(t, "terminal.kill", terminal)).toHaveLength(0);
    expect(calls(t, "terminal.send", terminal).some(c => String(c.params.text).includes("/stop"))).toBe(false);
    expect(t.store.listDeliveries(t.project.id).some(d => d.memberId === m.id && d.text.startsWith("[시스템] 보고 보완"))).toBe(false);
    // 다른 '중단'도 키를 보내지 않는다(P4: 쉬는 Codex 에 Esc 두 번이면 기록 보기 화면에 들어갔다).
    const again = await t.api("POST", `/api/members/${m.id}/interrupt`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: ERROR_CODES.interrupt_background_program.ko, code: "interrupt_no_turn", reason: "interrupt_background_program" });
    expect(calls(t, "terminal.interrupt", terminal)).toHaveLength(1);
    // 명령이 끝나 core 가 working 을 마치면 안내 + 급한 지시가 맨 먼저 한 봉투로 들어간다.
    t.core.setScreen(m.id, CODEX_IDLE);
    t.core.release(m.id);
    await t.waitFor("급한 지시", () => t.core.turns(m.id).length === 2);
    const envelope = t.core.turns(m.id)[1]!.prompt;
    expect(envelope).toContain("설정 파일 먼저 고치기");
    expect(envelope.indexOf("하던 턴을 멈추게 했습니다")).toBeLessThan(envelope.indexOf("설정 파일 먼저 고치기"));
  }, 30_000);

  test("이미 백그라운드 프로그램만 남은 팀장에게 준 지시(급한 지시 포함)의 도구 답과 대표 직접 글의 총괄 사본이 '그 프로그램이 끝나거나 /stop' 을 말한다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    await t.idle(lead.id);
    const { m, prompt } = await codexAtWork(t);
    const path = rollout(t, m, prompt);
    appendFileSync(path, rows(complete("turn-1")));
    t.core.setScreen(m.id, BACKGROUND);
    await t.waitFor("쉬는 중", () => t.member(m.id).status === "idle" && t.runner.backgroundTerminals(m.id) === 1);
    await t.orch.recordPost(t.member(m.id), { kind: "완료", title: "가짜 보고" });
    const plain = await tool(t, lead, "team_assign", { member: m.handle, text: "다음 일" });
    expect(plain).toContain("턴은 끝났지만 Codex가 띄운 백그라운드 프로그램(1개)이 남아 있어 기다립니다");
    expect(plain).toContain("/stop 으로 닫아야 들어갑니다");
    expect(plain).not.toContain("일하는 중이라 대기열");
    ownerSaid(t, "지금 바로 이것부터 해 줘");
    const urgent = await tool(t, lead, "team_assign", { member: m.handle, text: "급한 일", user_quote: "지금 바로 이것부터 해 줘", urgent: true });
    expect(urgent).toContain("그 팀장의 턴은 이미 끝났고 Codex가 띄운 백그라운드 프로그램(1개)만 돌고 있어 멈출 턴이 없습니다");
    expect(calls(t, "terminal.interrupt")).toHaveLength(0);
    // 대표가 팀장에게 직접 쓴 글: 총괄 사본(deliveryOutlook)이 '하던 일을 마치는 중'이 아니라 그 사실을 말한다.
    const direct = await t.orch.sendUserMessage(t.project.id, { text: "이것도 봐 줘", targetMemberId: m.id });
    const copy = t.store.listDeliveries(t.project.id).filter(d => d.memberId === lead.id).map(d => d.text).find(text => text.includes(`직접 지시했습니다 #${direct.id}`))!;
    expect(copy).toContain("턴은 끝냈지만 Codex가 띄운 백그라운드 프로그램(1개)이 남아 있어, 그 프로그램이 끝나거나 대표가 터미널에서 /stop 으로 닫아야 들어갑니다");
    expect(copy).not.toContain("하던 일을 마치는 중");
  }, 30_000);

  test("검토 뒤: 대표가 앱 '중단'으로 오래 도는 명령을 하던 Codex 를 멈추면, 턴은 멈췄으므로 실패(500)가 아니라 그대로 답하고 그 명령은 끄지 않는다", async () => {
    const t = await setup();
    const { m, prompt } = await codexAtWork(t);
    const path = rollout(t, m, prompt);
    const terminal = t.core.terminalOf(m.id)!.address;
    t.core.intercept((call: FakeCoreCall) => {
      if (call.method !== "terminal.interrupt") return undefined;
      t.core.setScreen(m.id, INTERRUPTED);
      appendFileSync(path, rows(aborted("turn-1")));
      return { result: { outcome: "still_working", key: "esc" } };
    });
    const response = await t.api("POST", `/api/members/${m.id}/interrupt`);
    t.core.intercept(null);
    // 예전: 500 'CLI interrupt outcome: still_working'(멈춘 턴이 실패로 보였다).
    expect(response.status).toBe(200);
    expect((await response.json() as Member).id).toBe(m.id);
    await t.waitFor("업무 닫힘", () => lastRun(t, m.id)?.phase === "ended");
    await t.waitFor("쉬는 중", () => t.member(m.id).status === "idle" && t.runner.backgroundTerminals(m.id) === 1);
    await t.waitFor("활동 줄", () => codes(t, m.id).includes("activity.codex_background_after_stop"));
    expect(calls(t, "terminal.interrupt", terminal)).toHaveLength(1);
    expect(calls(t, "terminal.keys", terminal)).toHaveLength(0);
    expect(calls(t, "terminal.kill", terminal)).toHaveLength(0);
    expect(calls(t, "terminal.send", terminal).some(c => String(c.params.text).includes("/stop"))).toBe(false);
  }, 30_000);

  test("검토 뒤: 멈춤 키 직후의 화면에 진행 줄이 아직 남아 있어도, 곧 '멈춤 + 백그라운드 터미널' 화면이 되면 도구 답이 그 사실을 말한다(화면을 몇 번 더 읽는다)", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    await t.idle(lead.id);
    const { m, prompt } = await codexAtWork(t);
    const path = rollout(t, m, prompt);
    let timer: ReturnType<typeof setTimeout> | null = null;
    cleanups.push(() => { if (timer) clearTimeout(timer); });
    t.core.intercept((call: FakeCoreCall) => {
      if (call.method !== "terminal.interrupt") return undefined;
      // core 의 3초 기다림이 끝난 순간에는 아직 진행 줄('Working … esc to interrupt')이 남아 있고, 조금 뒤 멈춘 화면이 그려진다.
      t.core.setScreen(m.id, BACKGROUND_WORKING);
      timer = setTimeout(() => { timer = null; t.core.setScreen(m.id, INTERRUPTED); appendFileSync(path, rows(aborted("turn-1"))); }, 500);
      return { result: { outcome: "still_working", key: "esc" } };
    });
    ownerSaid(t, "지금 하던 명령은 멈추고 설정 파일 먼저 고쳐 줘");
    const reply = await tool(t, lead, "team_assign", { member: m.handle, text: "설정 파일 먼저 고치기", user_quote: "지금 하던 명령은 멈추고 설정 파일 먼저 고쳐 줘", urgent: true });
    t.core.intercept(null);
    expect(reply).toContain("턴은 멈췄지만 실행하던 명령(백그라운드 터미널 1개)이 계속 돌고 있어");
    expect(reply).not.toContain("확인하지 못했습니다");
    expect(codes(t, m.id)).toContain("activity.urgent_interrupt_background");
    expect(codes(t, m.id)).not.toContain("activity.urgent_interrupt_unconfirmed");
  }, 30_000);
});

describe("P2 백그라운드 프로그램으로 막힌 대표 일의 30분 알림", () => {
  test("막힘·푸시로 /ps·/stop 을 안내하고(그 상태가 2분 정착한 뒤, 기다리던 대표 일이 여럿이어도 상태 하나에 한 번), 총괄은 깨우지 않는 사본 하나만 받는다(시스템 글을 팀장 보고로 다시 넘기지 않는다)", async () => {
    const mac: string[] = [];
    const t = await setup({ push: true, notifier: (_title, body) => mac.push(body) });
    t.store.patchSettings({ notifyMac: true, macScriptNotifications: true });
    const lead = await t.orch.ensureConductor(t.project.id);
    await t.idle(lead.id);
    const { m, prompt } = await codexAtWork(t);
    appendFileSync(rollout(t, m, prompt), rows(complete("turn-1")));
    t.core.setScreen(m.id, BACKGROUND);
    await t.waitFor("쉬는 중", () => t.member(m.id).status === "idle" && t.runner.backgroundTerminals(m.id) === 1);
    const message = await t.orch.sendUserMessage(t.project.id, { text: "이 화면 확인해 줘", targetMemberId: m.id });
    const other = await t.orch.sendUserMessage(t.project.id, { text: "이것도 봐 줘", targetMemberId: m.id });
    const d = t.store.listPending(m.id).find(x => x.refId === message.id)!;
    const d2 = t.store.listPending(m.id).find(x => x.refId === other.id)!;
    const now = Date.now();
    for (const id of [d.id, d2.id]) t.store.db.query("UPDATE deliveries SET created_at = ? WHERE id = ?").run(new Date(now - 31 * 60_000).toISOString(), id);
    // 검토 뒤: 그 상태가 막 생겼으면 곧 저절로 풀릴 수 있어 정착(2분) 뒤에 알린다. 그동안 '하던 일을 마치는 중'(알림)도 쓰지 않는다(턴은 이미 끝났다).
    const since = t.runner.backgroundSince(m.id)!;
    expect(since).toBeGreaterThan(0);
    t.orch.notifyDelayedDeliveries(since + 60_000); t.orch.notifyDelayedDeliveries(since + 119_000);
    expect(t.store.listMessages(t.project.id).filter(x => ["chat.owner_delivery_background", "chat.owner_delivery_behind"].includes(x.textCode ?? ""))).toHaveLength(0);
    expect(t.push!.listEvents().filter(e => e.kind === "report_blocked")).toHaveLength(0);
    // 정착 뒤: 기다리던 대표 일이 둘이어도 그 상태 하나에 막힘·푸시 한 번(예전: 전달마다 한 번).
    t.orch.notifyDelayedDeliveries(since + 121_000); t.orch.notifyDelayedDeliveries(since + 151_000);
    const blocked = t.store.listMessages(t.project.id).filter(x => x.textCode === "chat.owner_delivery_background");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ kind: "막힘", who: "시스템", memberId: m.id, title: "전달 막힘",
      body: "서버 점검이 턴은 끝냈지만 Codex가 띄운 백그라운드 프로그램(1개)이 남아 있어 대표 메시지가 들어가지 못합니다. 서버 점검의 터미널에서 /ps 로 보고 /stop 으로 닫으면 들어갑니다." });
    expect(t.store.listMessages(t.project.id).some(x => x.textCode === "chat.owner_delivery_behind")).toBe(false);
    expect(t.push!.listEvents().filter(e => e.kind === "report_blocked")).toHaveLength(1);
    expect(mac).toHaveLength(1);
    // 총괄: 깨우지 않는 시스템 사본 하나(전달 번호 포함). 그 '막힘' 글이 '[보고 시스템]' 으로 다시 넘어가지 않는다.
    await (t.orch as unknown as { ownerFlows: { retryOrphans(): Promise<void> } }).ownerFlows.retryOrphans();
    const toLead = t.store.listDeliveries(t.project.id).filter(x => x.memberId === lead.id && x.text.includes("들어가지 못합니다"));
    expect(toLead.map(x => [x.kind, x.wake])).toEqual([["system", false]]);
    expect(toLead[0]!.text).toContain(`(전달 ${d.id})`);
    expect(t.store.listDeliveries(t.project.id).some(x => x.memberId === lead.id && x.text.includes("[보고 시스템]"))).toBe(false);
  }, 30_000);

  test("서버가 팀장 이름으로 남긴 시스템 글(30분 지연·압축 확인)은 팀장 보고로 다시 넘기지 않는다. 팀장이 쓴 보고는 그대로 넘긴다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    await t.idle(lead.id);
    const w = await t.orch.createMember(t.project.id, { name: "자료 정리" });
    t.store.createMessage({ projectId: t.project.id, memberId: w.id, who: "시스템", kind: "막힘", text: textRef("chat.compact_unconfirmed", { name: w.name }) });
    t.store.createMessage({ projectId: t.project.id, memberId: w.id, who: "시스템", kind: "알림", text: textRef("chat.owner_delivery_behind", { name: w.name, since: sinceParam(new Date().toISOString()), what: textRef("word.owner_message") }) });
    const own = t.store.createMessage({ projectId: t.project.id, memberId: w.id, who: w.name, kind: "막힘", title: "가짜 막힘 보고", body: "가짜 본문" });
    expect(t.store.listReportsMissingDeliveries(t.project.id).map(x => x.id)).toEqual([own.id]);
    await (t.orch as unknown as { ownerFlows: { retryOrphans(): Promise<void> } }).ownerFlows.retryOrphans();
    const reports = t.store.listDeliveries(t.project.id).filter(x => x.memberId === lead.id && x.kind === "report");
    expect(reports.map(x => x.refId)).toEqual([own.id]);
  }, 30_000);
});

describe("P3 Claude 의 도는 압축을 멈춘 뒤 입력칸에 되살아난 /compact 명령", () => {
  /** 압축 명령을 받으면 끝내지 않고 working 으로 둔다. '중단'(Esc)을 받으면 Claude 처럼 끊긴 명령을 입력칸에 되돌린다. */
  async function compactingClaude(t: CoreEnv, restore: (command: string) => string | null) {
    const m = await t.orch.createMember(t.project.id, { name: "자료 정리" });
    await t.orch.assign(t.project.id, m.handle, { text: "첫 일 @fake:post=첫일끝" });
    await t.idle(m.id);
    await t.waitFor("세션 기록", () => !!t.member(m.id).sessionId);
    let command = "";
    t.core.intercept((call: FakeCoreCall) => {
      const terminal = t.core.terminalOf(m.id)!;
      if (call.params.terminal !== terminal.address) return undefined;
      if (call.method === "terminal.send" && String(call.params.text).startsWith("/compact")) {
        command = String(call.params.text);
        const turn = terminal.turn ?? 0;
        terminal.status = { state: "working" };
        return { result: { turn, started: true } };
      }
      if (call.method === "terminal.interrupt") {
        terminal.status = { state: "done" }; terminal.turn = (terminal.turn ?? 0) + 1;
        const draft = restore(command);
        if (draft !== null) t.core.setDraft(m.id, draft);
        return { result: { outcome: "stopped", key: "esc" } };
      }
      return undefined;
    });
    await t.orch.memberCompact(m.id);
    await t.waitFor("압축 도는 중", () => t.store.getContextState(m.id)?.compaction?.phase === "running" && t.core.terminalOf(m.id)!.status?.state === "working");
    await t.orch.memberInterrupt(m.id);
    expect(t.store.getContextState(m.id)?.compaction).toMatchObject({ phase: "failed", reason: "interrupted" });
    return { m: t.member(m.id), command: () => command };
  }

  test("입력칸 글이 IAMCEO 가 넣은 압축 명령과 글자까지 같으면 ctrl+c 한 번으로 지우고 기다리던 전달을 넣는다", async () => {
    const t = await setup();
    const { m, command } = await compactingClaude(t, cmd => cmd);
    expect(command()).toMatch(/^\/compact 이어갈 일: /);
    expect(inputText(t.core.screenOf(m.id))).toBe(command());
    // Claude 의 입력칸: 글이 있을 때 ctrl+c 는 입력 비우기다.
    t.core.onKeys((_terminal, pressed) => { if (pressed.includes("ctrl+c")) t.core.setDraft(m.id, ""); });
    await t.orch.assign(t.project.id, m.handle, { text: "기다리던 일 @fake:post=끝" });
    await t.waitFor("전달", () => t.core.turns(m.id).some(turn => turn.prompt.includes("기다리던 일")));
    expect(t.core.keys.filter(k => k.terminal === t.core.terminalOf(m.id)!.address).map(k => k.keys)).toEqual([["ctrl+c"]]);
    await t.waitFor("활동 줄", () => codes(t, m.id).includes("activity.compact_draft_cleared"));
    expect(codes(t, m.id)).not.toContain("activity.compact_draft_left");
  }, 30_000);

  test("대표가 쓴 글(다른 글자)은 지우지 않고, 압축 명령처럼 보이면 안내만 한 번 남긴다. 같은 글이어도 ctrl+c 는 압축마다 한 번뿐이다", async () => {
    const t = await setup({ timings: { inputBusyRetryMs: 20 } });
    const { m } = await compactingClaude(t, () => "/compact 내가 쓴 다른 요약 지시");
    await t.orch.assign(t.project.id, m.handle, { text: "기다리던 일" });
    await t.waitFor("안내 줄", () => codes(t, m.id).includes("activity.compact_draft_left"));
    for (let i = 0; i < 3; i++) { await t.orch.pump(m.id); await Bun.sleep(40); }
    expect(t.core.keys).toHaveLength(0);
    expect(t.core.turns(m.id).some(turn => turn.prompt.includes("기다리던 일"))).toBe(false);
    expect(codes(t, m.id).filter(code => code === "activity.compact_draft_left")).toHaveLength(1);
    expect(inputText(t.core.screenOf(m.id))).toBe("/compact 내가 쓴 다른 요약 지시");
    // 검토 뒤: 활동 줄만이 아니라 팀장의 상태 줄(lastError)에도 남는다(영어 화면은 코드로).
    await t.waitFor("상태 줄", () => t.member(m.id).lastError === ERROR_CODES.last_error_compact_draft.ko);
    expect(t.member(m.id)).toMatchObject({ lastError: ERROR_CODES.last_error_compact_draft.ko, lastErrorCode: "last_error_compact_draft" });
    // 늦게 온 쉬는 중 알림(전체 시험 부하에서 실제로 이 줄을 지웠다)은 그 줄을 지우지 않는다. 그 글은 그대로 입력칸에 있다.
    const terminal = t.core.terminalOf(m.id)!;
    (t.runner as unknown as { emit(event: unknown): void }).emit({ type: "status", memberId: m.id, status: "idle", terminalId: terminal.address, turn: terminal.turn ?? null,
      observation: { source: "core", observedAt: new Date().toISOString(), freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
    await Bun.sleep(50);
    expect(t.member(m.id).lastError).toBe(ERROR_CODES.last_error_compact_draft.ko);
    // 대표가 터미널에서 그 글을 지우면 기다리던 전달이 들어가고 상태 줄이 지워진다.
    t.core.setDraft(m.id, "");
    await t.orch.pump(m.id);
    await t.waitFor("전달", () => t.core.turns(m.id).some(turn => turn.prompt.includes("기다리던 일")));
    await t.waitFor("상태 줄 지움", () => t.member(m.id).lastError === null);
    expect(t.core.keys).toHaveLength(0);

    // 같은 글이지만 키가 듣지 않는(지워지지 않는) CLI: 한 번만 누르고 다시 누르지 않는다(두 번째 ctrl+c 는 Claude 를 끝낼 수 있다).
    const t2 = await setup({ timings: { inputBusyRetryMs: 20 } });
    const second = await compactingClaude(t2, cmd => cmd);
    await t2.orch.assign(t2.project.id, second.m.handle, { text: "기다리던 일" });
    await t2.waitFor("키 한 번", () => t2.core.keys.length === 1);
    for (let i = 0; i < 3; i++) { await t2.orch.pump(second.m.id); await Bun.sleep(40); }
    expect(t2.core.keys.map(k => k.keys)).toEqual([["ctrl+c"]]);
    expect(t2.core.turns(second.m.id).some(turn => turn.prompt.includes("기다리던 일"))).toBe(false);
  }, 30_000);

  test("검토 뒤: 글자가 같아도 CLI 가 오류로 턴을 끝낸 상태(error)면 ctrl+c 를 보내지 않고 안내만 남긴다", async () => {
    const t = await setup({ timings: { inputBusyRetryMs: 20 } });
    const { m } = await compactingClaude(t, cmd => cmd);
    t.core.setStatus(m.id, { state: "error", msg: "가짜 API 오류" });
    await t.waitFor("오류 관측", () => t.runner.observationState(m.id)?.state === "error");
    await t.orch.assign(t.project.id, m.handle, { text: "기다리던 일" });
    await t.waitFor("안내 줄", () => codes(t, m.id).includes("activity.compact_draft_left"));
    for (let i = 0; i < 3; i++) { await t.orch.pump(m.id); await Bun.sleep(40); }
    expect(t.core.keys).toHaveLength(0);
    expect(t.core.turns(m.id).some(turn => turn.prompt.includes("기다리던 일"))).toBe(false);
  }, 30_000);

  test("검토 뒤: 뒤 작업만 남은 Claude(claudeLingers, core 는 working 이고 stateOf 는 done)에는 글자가 같아도 ctrl+c 를 보내지 않는다", async () => {
    const t = await setup();
    const { m, command } = await compactingClaude(t, cmd => cmd);
    type Track = { terminal: { status?: { state: string } | null } };
    const runner = t.runner as unknown as {
      tracks: Map<string, Track>;
      claudeWatch: WeakMap<Track, { state: unknown }>;
      clearCompactDraft(track: Track, terminal: Track["terminal"], draft: string): Promise<boolean>;
    };
    // 실행기가 멈춘 압축 뒤의 쉬는 중(done)을 본 뒤에 시작한다.
    await t.waitFor("쉬는 중 관측", () => t.runner.observationState(m.id)?.state === "done" && runner.tracks.get(m.id)?.terminal.status?.state === "done");
    const track = runner.tracks.get(m.id)!, terminal = track.terminal;
    const watch = runner.claudeWatch.get(track) ?? (() => { const w = { state: null as unknown, cursor: null, hook: null, closedRun: null }; runner.claudeWatch.set(track, w); return w; })();
    // 같은 틱에서 상태를 바꾸고 부르고 되돌린다(판정은 첫 await 전에 끝난다). 다음 관측이 끼어들지 않는다.
    const status = terminal.status, saved = watch.state;
    terminal.status = { state: "working" };
    watch.state = { kind: "background", turn: 0, runId: "run_fake", runEnded: true, reported: true, error: null, label: null };
    const lingering = runner.clearCompactDraft(track, terminal, command());
    terminal.status = status; watch.state = saved;
    expect(await lingering).toBe(false);
    expect(t.core.keys).toHaveLength(0);
    await t.waitFor("안내 줄", () => codes(t, m.id).includes("activity.compact_draft_left"));
    // 대조: 같은 터미널·같은 글에서 뒤 작업이 없으면(core 가 쉬는 중) 지운다 — 위의 false 는 뒤 작업 조건 때문이다.
    expect(await runner.clearCompactDraft(track, track.terminal, command())).toBe(true);
    expect(t.core.keys.map(k => k.keys)).toEqual([["ctrl+c"]]);
  }, 30_000);

  test("견본: 되살아난 명령 화면의 입력칸 글은 그 명령 그대로 읽힌다(칸 너비로 접혀도 공백을 빼고 견준다)", () => {
    const screen = readFileSync(join(CLAUDE, "compact-restored.txt"), "utf8");
    expect(inputText(screen)).toBe("/compact 이어갈 일: 가짜 일을 마무리하는 중 · 대기 질문: 가짜 질문 · 짧게 보고");
  });
});

describe("P4 멈출 턴이 없는(쉬는) CLI 에 '중단'", () => {
  test("쉬는 Codex 에는 멈춤 키를 보내지 않고 409 '멈출 턴이 없습니다'로 답한다", async () => {
    const t = await setup();
    const m = await t.orch.createMember(t.project.id, { name: "서버 점검", cli: "codex" });
    t.core.setScreen(m.id, CODEX_IDLE);
    await t.waitFor("쉬는 중", () => t.member(m.id).status === "idle" && !!t.core.terminalOf(m.id));
    for (let i = 0; i < 2; i++) {
      const response = await t.api("POST", `/api/members/${m.id}/interrupt`);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: ERROR_CODES.interrupt_no_turn.ko, code: "interrupt_no_turn" });
    }
    expect(calls(t, "terminal.interrupt")).toHaveLength(0);
    expect(t.core.keys).toHaveLength(0);
  }, 30_000);

  test("일하는 CLI 에는 지금처럼 멈춤 키를 보낸다", async () => {
    const t = await setup();
    const { m } = await codexAtWork(t);
    t.core.setScreen(m.id, null);
    await t.orch.memberInterrupt(m.id);
    expect(calls(t, "terminal.interrupt")).toHaveLength(1);
  }, 30_000);

  test("쉬는 CLI 의 미확정 압축은 '중단'으로 키 없이 닫는다(압축 확인 안내의 '중단')", async () => {
    const t = await setup();
    const m = await t.orch.createMember(t.project.id, { name: "자료 정리" });
    await t.orch.assign(t.project.id, m.handle, { text: "첫 일 @fake:post=첫일끝" });
    await t.idle(m.id);
    // 압축 명령은 들어갔지만 CLI 는 곧 쉬고, 세션 기록에 압축 경계는 남지 않았다(끝을 확인하지 못한 압축).
    t.core.intercept((call: FakeCoreCall) => {
      if (call.method === "terminal.send" && String(call.params.text).startsWith("/compact")) return { result: { turn: t.core.terminalOf(m.id)!.turn ?? 0, started: false } };
      return undefined;
    });
    await t.orch.memberCompact(m.id);
    await t.waitFor("미확정 압축", () => ["running", "uncertain"].includes(t.store.getContextState(m.id)?.compaction?.phase ?? ""));
    t.core.intercept(null);
    await t.orch.memberInterrupt(m.id);
    expect(t.store.getContextState(m.id)?.compaction).toMatchObject({ phase: "failed", reason: "interrupted" });
    expect(calls(t, "terminal.interrupt")).toHaveLength(0);
    // 기다리던 전달이 이어 나간다.
    await t.orch.assign(t.project.id, m.handle, { text: "다음 일 @fake:post=끝" });
    await t.waitFor("다음 일", () => t.core.turns(m.id).some(turn => turn.prompt.includes("다음 일")));
  }, 30_000);
});

describe("문제 3: 대표 화면의 새 글 — 오늘은 시각만, 내부 번호 없음", () => {
  test("오늘 일이면 시각만('오후 3시 23분부터'), 다른 날이면 날짜까지. 만든 때 정해 언어별 글자로 실어, 다음 날 다시 그려도 같은 문장이다", () => {
    const at = new Date(); at.setHours(15, 23, 0, 0);
    const now = at.getTime() + 60 * 60_000;
    const today = sinceParam(at.toISOString(), now);
    expect(today).toEqual({ ko: "오후 3시 23분", en: "3:23 PM" });
    const ref = textRef("chat.owner_delivery_behind", { name: "결제 연동", since: today, what: textRef("word.owner_message") });
    expect(renderServerText(ref, "ko")).toBe("결제 연동이 오후 3시 23분부터 하던 일을 마치는 중입니다. 그 일이 끝나면 대표 메시지가 들어갑니다.");
    expect(renderServerText(ref, "en")).toBe("결제 연동 has been finishing earlier work since 3:23 PM. When it ends, your message goes in.");
    // 다른 날: 날짜까지(예전 꼴).
    expect(sinceParam(at.toISOString(), now + 24 * 3_600_000)).toEqual({ at: at.toISOString() });
    const top = new Date(at); top.setMinutes(0);
    expect([formatTextTime(top.toISOString(), "ko"), formatTextTime(top.toISOString(), "en")]).toEqual(["오후 3시", "3 PM"]);
  });

  test("0.2.7 의 새 글(전달 대기·지연·급한 지시 활동·대체된 카드)은 대표에게 내부 번호를 싣지 않는다", () => {
    const id = "dl_AbCdEfGhIjKl";
    const owner = [
      textRef("chat.owner_delivery_behind", { name: "결제 연동", since: { at: new Date().toISOString() }, what: textRef("word.owner_message") }),
      textRef("chat.owner_instruction_late", { name: "결제 연동" }),
      textRef("chat.owner_todo_done_late", { name: "결제 연동" }),
      textRef("chat.owner_delivery_background", { name: "결제 연동", count: "1", what: textRef("word.owner_message") }),
      textRef("activity.urgent_interrupt"),
      textRef("activity.urgent_interrupt_failed", { detail: "가짜 까닭" }),
      textRef("activity.urgent_interrupt_unconfirmed", { detail: "가짜 까닭" }),
      textRef("activity.urgent_interrupt_background", { count: "1" }),
      textRef("card.replaced"),
    ];
    for (const ref of owner) for (const lang of ["ko", "en"] as const) {
      const text = renderServerText(ref, lang);
      expect(text).not.toBeNull();
      expect(text!).not.toContain("#");
      expect(text!).not.toContain(id);
    }
  });
});
