// 11-16 핫픽스 B: Codex 가 턴을 끝냈어도 자기가 띄운 백그라운드 터미널이 살아 있으면 core 는 working 을 알린다(라이브에서 15시간).
// 화면(빈 입력칸·진행 줄 없음·'N background terminal(s) running')과 Codex 자기 기록(task_complete)이 함께 턴 끝을 보이면
// 그 업무를 평소의 턴 끝(성공)으로 닫고 쉬는 중으로 보인다. 다음 전달은 그 프로그램이 끝날 때까지 넣지 않는다.
// 화면·기록 견본은 tests/fixtures/cli/codex/0.166.0/ 의 합성 견본(라이브 화면·기록의 모양을 옮기고 글은 가짜)이다.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexBackgroundTerminals } from "../server/runner/core.ts";
import { readCodexTurnEnd, type CodexTurnQuery } from "../server/runner/codex-turn.ts";
import type { RunnerEvent } from "../server/runner/types.ts";
import { ERROR_CODES } from "../shared/error-codes.ts";
import type { Member } from "../shared/types.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions } from "./fixtures/core-harness.ts";
import { rejection } from "./fixtures/settle.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "cli", "codex", "0.166.0");
const screen = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const BACKGROUND = screen("background-idle.txt");
const BACKGROUND_PLURAL = screen("background-idle-plural.txt");
const WORKING = screen("background-working.txt");
const IDLE = screen("idle.txt");
const CODEX_IDLE = "\n› Ask Codex to do anything\n\n  GPT-6-Astra high Fast · ~/workspace/sample-app\n  ? for shortcuts\n";

const rows = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const meta = (id: string, cwd: string) => ({ type: "session_meta", payload: { id, session_id: id, cwd, source: "cli", cli_version: "0.166.0" } });
const started = (turn: string | null) => ({ type: "event_msg", payload: { type: "task_started", ...(turn ? { turn_id: turn } : {}) } });
const complete = (turn: string | null) => ({ type: "event_msg", payload: { type: "task_complete", ...(turn ? { turn_id: turn } : {}), last_agent_message: "가짜 답" } });
const aborted = (turn: string) => ({ type: "event_msg", payload: { type: "turn_aborted", turn_id: turn } });
const user = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const tokenCount = (total: number) => ({ type: "event_msg", payload: { type: "token_count", info: { model_context_window: 258_400, last_token_usage: { total_tokens: total } } } });
const tokens = tokenCount(42_000);
const itemCompleted = { type: "event_msg", payload: { type: "item_completed" } };
const MARKER = "#iamceo_" + "a".repeat(22), BUNDLE = "#iamceo_b_" + "b".repeat(22);

describe("화면: 백그라운드 터미널만 남은 Codex", () => {
  test("빈 입력칸 바로 위의 'N background terminal(s) running' 을 센다(단수·복수)", () => {
    expect(codexBackgroundTerminals(BACKGROUND)).toBe(1);
    expect(codexBackgroundTerminals(BACKGROUND_PLURAL)).toBe(2);
    // terminal.read 는 160칸에 맞춰 공백을 채운다.
    expect(codexBackgroundTerminals(BACKGROUND.split("\n").map(line => line.padEnd(160)).join("\n"))).toBe(1);
  });
  test("진행 줄이 보이거나, 입력칸에 글이 있거나, 백그라운드 줄이 입력칸 바로 위가 아니면 아니다", () => {
    expect(codexBackgroundTerminals(WORKING)).toBeNull();
    expect(codexBackgroundTerminals(BACKGROUND.replace("  Worked for 8m 22s • 12:51 PM", "• Inspecting files (1m 02s • esc to interrupt)"))).toBeNull();
    expect(codexBackgroundTerminals(BACKGROUND.replace("› Ask Codex to do anything", "› 사람이 쓰던 글"))).toBeNull();
    expect(codexBackgroundTerminals(BACKGROUND.replace("/stop to close\n", "/stop to close\n  ↳ 가짜 줄\n"))).toBeNull();
    expect(codexBackgroundTerminals(BACKGROUND.replace("  1 background terminal running", "  0 background terminals running"))).toBeNull();
    expect(codexBackgroundTerminals(IDLE)).toBeNull();
    expect(codexBackgroundTerminals(CODEX_IDLE)).toBeNull();
  });
});

describe("Codex 기록: 전달 뒤의 턴이 끝났는가", () => {
  const scratch = mkdtempSync(join(tmpdir(), "iamceo-codex-turn-"));
  function log(text: string, id = "sess") {
    const home = mkdtempSync(join(scratch, "home-"));
    const path = join(home, "sessions", "2026", "11", "16", `rollout-test-${id}.jsonl`);
    mkdirSync(join(home, "sessions", "2026", "11", "16"), { recursive: true });
    writeFileSync(path, text);
    const query = (extra: Partial<CodexTurnQuery> = {}): CodexTurnQuery => ({ home, path, sessionId: id, cwd: "/work", baseline: null, markers: [BUNDLE, MARKER], ...extra });
    return { home, path, query };
  }
  const head = rows(meta("sess", "/work"), started("t1"), user("앞 업무 #iamceo_" + "z".repeat(22)), complete("t1"));
  const baseline = (offset: number) => ({ offset, fileIdentity: null });

  test("기준선 뒤에 시작한 턴이 task_complete 로 끝나면 ended. 그 턴이 아직 열려 있으면 running", () => {
    const { path, query } = log(head + rows(started("t2"), user(`업무\n${MARKER}\n${BUNDLE}`), tokens));
    const at = Buffer.byteLength(head);
    const open = readCodexTurnEnd(query({ baseline: baseline(at) }));
    expect(open).toMatchObject({ outcome: "running", code: "turn_open" });
    appendFileSync(path, rows(complete("t2"), itemCompleted));
    // 앞 읽기 자리에서 이어 읽는다.
    expect(readCodexTurnEnd(query({ baseline: baseline(at) }), open.cursor)).toMatchObject({ outcome: "ended", code: "turn_complete" });
    expect(readCodexTurnEnd(query({ baseline: baseline(at) }))).toMatchObject({ outcome: "ended" });
  });
  test("기준선 뒤에 아직 턴이 시작되지 않았으면(앞 턴의 끝만 있으면) 끝났다고 하지 않는다", () => {
    const before = rows(meta("sess", "/work"), started("t1"));
    const { query } = log(before + rows(complete("t1")));
    expect(readCodexTurnEnd(query({ baseline: baseline(Buffer.byteLength(before)) }))).toMatchObject({ outcome: "unknown", code: "no_turn_complete" });
  });
  test("기준선이 없으면 그 전달의 표지가 든 사용자 글 뒤의 끝만 센다", () => {
    expect(readCodexTurnEnd(log(rows(meta("sess", "/work"), started("t1"), user(`[IAMCEO session binding: ${"n".repeat(24)}]\n\n업무\n${MARKER}\n${BUNDLE}`), complete("t1"))).query()))
      .toMatchObject({ outcome: "ended" });
    // 앞 턴만 끝났고 이 전달의 턴은 열려 있다.
    expect(readCodexTurnEnd(log(head + rows(started("t2"), user(`업무\n${BUNDLE}`))).query())).toMatchObject({ outcome: "running" });
    // 표지가 없다(이 전달을 받은 기록이 없다).
    expect(readCodexTurnEnd(log(head).query())).toMatchObject({ outcome: "unknown", code: "marker_missing" });
    // turn_id 없는 옛 모양도 짝을 맞춘다.
    expect(readCodexTurnEnd(log(rows(meta("sess", "/work"), started(null), user(MARKER), complete(null))).query())).toMatchObject({ outcome: "ended" });
  });
  test("중단으로 끝났거나, 다른 세션·폴더이거나, 망가진 줄·덜 쓴 줄이 있으면 끝났다고 하지 않는다", () => {
    expect(readCodexTurnEnd(log(rows(meta("sess", "/work"), started("t1"), user(MARKER), aborted("t1"))).query())).toMatchObject({ outcome: "unknown", code: "turn_aborted" });
    expect(readCodexTurnEnd(log(rows(meta("sess", "/other"), started("t1"), user(MARKER), complete("t1"))).query())).toMatchObject({ outcome: "unknown", code: "session_conflict" });
    expect(readCodexTurnEnd(log(rows(meta("other", "/work"), started("t1"), user(MARKER), complete("t1"))).query())).toMatchObject({ outcome: "unknown", code: "session_conflict" });
    expect(readCodexTurnEnd(log(rows(meta("sess", "/work"), started("t1"), user(MARKER)) + "{broken\n" + rows(complete("t1"))).query())).toMatchObject({ outcome: "unknown", code: "corrupt_log" });
    const partial = log(rows(meta("sess", "/work"), started("t1"), user(MARKER)) + JSON.stringify(complete("t1")));
    const first = readCodexTurnEnd(partial.query());
    expect(first).toMatchObject({ outcome: "unknown", code: "partial_log" });
    appendFileSync(partial.path, "\n");
    expect(readCodexTurnEnd(partial.query(), first.cursor)).toMatchObject({ outcome: "ended" });
    // 나중 기록에 다른 session_meta 가 붙었다.
    expect(readCodexTurnEnd(log(rows(meta("sess", "/work"), started("t1"), user(MARKER), complete("t1"), meta("sess", "/work"))).query())).toMatchObject({ outcome: "unknown", code: "session_conflict" });
  });
});

// ───────── 실제 CoreRunner + 운영 배선의 총괄 + 가짜 core ─────────
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(opts: CoreSetupOptions = {}): Promise<CoreEnv> {
  const t = await coreSetup({ ...opts, runnerDeps: { backgroundNoticeMs: 0, ...opts.runnerDeps } });
  cleanups.push(() => t.close());
  return t;
}
const generation = (t: CoreEnv, id: string) => t.store.memberRevisions(id).sessionGeneration;
const lastRun = (t: CoreEnv, id: string) => t.store.lastWrittenExecution(id, generation(t, id));
const activityCodes = (t: CoreEnv, id: string) => t.store.listActivity(id, 500).map(a => a.textCode).filter(Boolean);

/** Codex 팀장에게 일을 하나 넣고, 그 턴이 끝나지 않고 working 으로 남게 한다(백그라운드 터미널을 남긴 Codex 처럼). */
async function codexAtWork(t: CoreEnv): Promise<{ m: Member; prompt: string }> {
  const m = await t.orch.createMember(t.project.id, { name: "미리보기", cli: "codex" });
  t.core.setScreen(m.id, CODEX_IDLE);
  t.core.setDirectives("@fake:hold");
  await t.orch.assign(t.project.id, m.handle, { text: "미리보기를 띄우고 보고하세요" });
  const turn = await t.waitFor("첫 턴", () => t.core.turns(m.id)[0]);
  t.core.setDirectives("");
  // 실행기의 working 관측까지 반영된 뒤(마지막 진전 시각이 적힌 뒤)부터 본다.
  await t.waitFor("일하는 중", () => lastRun(t, m.id)?.phase === "running" && !!lastRun(t, m.id)?.lastProgressAt && t.member(m.id).status === "working");
  return { m: t.member(m.id), prompt: turn.prompt };
}
/** Codex 가 그 세션 기록에 남겼을 rollout. complete=false 면 턴이 아직 열려 있다(completeRollout 으로 끝낸다). */
function writeRollout(t: CoreEnv, m: Member, prompt: string, opts: { complete?: boolean; tokens?: number } = {}): { id: string; path: string } {
  const id = randomUUID(), dir = join(t.home, "codex-home", "sessions", "2026", "11", "16");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-test-${id}.jsonl`);
  writeFileSync(path, rows(meta(id, m.cwd), started("turn-1"), user(prompt), { type: "turn_context", payload: { model: "gpt-6-astra" } }, tokenCount(opts.tokens ?? 42_000),
    ...(opts.complete === false ? [] : [complete("turn-1"), itemCompleted])));
  return { id, path };
}
const completeRollout = (path: string) => appendFileSync(path, rows(complete("turn-1"), itemCompleted));

describe("백그라운드 터미널만 남은 Codex 팀장", () => {
  test("Codex 기록이 턴 끝을 보이면 업무를 성공으로 닫고 쉬는 중으로 보이며, 남은 프로그램을 활동에 알린다. 다음 전달은 그 프로그램이 끝난 뒤에 넣는다", async () => {
    const t = await setup();
    const events: RunnerEvent[] = []; t.runner.on(event => events.push(event));
    const { m, prompt } = await codexAtWork(t);
    const sessionId = writeRollout(t, m, prompt).id;
    t.core.setScreen(m.id, BACKGROUND);
    const run = await t.waitFor("업무 닫힘", () => { const r = lastRun(t, m.id); return r?.phase === "ended" ? r : null; });
    expect(run).toMatchObject({ result: "success", reason: "codex_background_terminal" });
    await t.waitFor("쉬는 중", () => t.member(m.id).status === "idle");
    await t.waitFor("활동 줄", () => activityCodes(t, m.id).includes("activity.codex_background_left"));
    const line = t.store.listActivity(m.id, 500).find(a => a.textCode === "activity.codex_background_left")!;
    expect(line.textParams).toEqual({ count: "1" });
    expect(line.text).toContain("백그라운드 프로그램(1개)");
    expect(t.member(m.id)).toMatchObject({ sessionId, statusObservation: { error: null } });
    // 턴 끝의 문맥 사용량(Codex 기록의 token_count)도 남는다.
    await t.waitFor("문맥 측정", () => t.store.getContextState(m.id)?.measurement?.tokens === 42_000);
    // core 는 여전히 working: 입력을 넣지 않는다. 그 사이 쌓인 전달(보고 보완·새 일)은 기다린다.
    expect(t.runner.isBusy(m.id)).toBe(true);
    expect(t.runner.observationState(m.id)?.state).toBe("working");
    const sends = () => t.core.calls.filter(call => call.method === "terminal.send").length;
    const sent = sends();
    const waiting = (await t.orch.assign(t.project.id, m.handle, { text: "다음 일" })).delivery.id;
    await Bun.sleep(300);
    expect(sends()).toBe(sent);
    expect(t.core.turns(m.id)).toHaveLength(1);
    expect(t.store.requireDelivery(waiting).status).toBe("queued");
    expect(t.member(m.id).status).toBe("idle");
    expect(events.filter(e => e.type === "turn_end")).toHaveLength(1);
    // 백그라운드 프로그램이 끝나 core 가 working 을 마치면(turn 이 하나 오른다) 그 끝을 다시 알리지 않고 밀린 전달을 넣는다.
    t.core.setDirectives("@fake:hold");
    t.core.setScreen(m.id, CODEX_IDLE);
    t.core.release(m.id);
    await t.waitFor("다음 전달", () => t.core.turns(m.id).length === 2);
    expect(events.filter(e => e.type === "turn_end")).toHaveLength(1);
    expect(activityCodes(t, m.id).filter(code => code === "activity.turn_end")).toHaveLength(1);
    expect(activityCodes(t, m.id).filter(code => code === "activity.codex_background_left")).toHaveLength(1);
  }, 30_000);

  test("진행 줄이 보이면(정말 일하는 중) Codex 기록이 끝을 보여도 그대로 일하는 중이다", async () => {
    const t = await setup();
    const { m, prompt } = await codexAtWork(t);
    writeRollout(t, m, prompt);
    t.core.setScreen(m.id, WORKING);
    await t.waitFor("세션 연결", () => !!t.member(m.id).sessionId);
    await Bun.sleep(300);
    expect(lastRun(t, m.id)?.phase).toBe("running");
    expect(t.member(m.id).status).toBe("working");
    expect(activityCodes(t, m.id).some(code => String(code).startsWith("activity.codex_background"))).toBe(false);
  }, 30_000);

  test("Codex 기록에 끝나지 않은 턴이 있으면 화면이 쉬는 모양이어도 일하는 중이다", async () => {
    const t = await setup();
    const { m, prompt } = await codexAtWork(t);
    writeRollout(t, m, prompt, { complete: false });
    t.core.setScreen(m.id, BACKGROUND);
    await t.waitFor("세션 연결", () => !!t.member(m.id).sessionId);
    await Bun.sleep(300);
    expect(lastRun(t, m.id)?.phase).toBe("running");
    expect(t.member(m.id).status).toBe("working");
    expect(activityCodes(t, m.id).some(code => String(code).startsWith("activity.codex_background"))).toBe(false);
  }, 30_000);

  test("Codex 기록을 찾지 못하면(세션 연결 안 됨) 끝내지 않고, 까닭을 활동에 한 번 남긴다. 그 줄은 업무의 진전으로 세지 않는다", async () => {
    const t = await setup();
    const { m } = await codexAtWork(t);
    const before = lastRun(t, m.id)!.lastProgressAt;
    t.core.setScreen(m.id, BACKGROUND_PLURAL);
    await t.waitFor("까닭 줄", () => activityCodes(t, m.id).includes("activity.codex_background_unverified"));
    const line = t.store.listActivity(m.id, 500).find(a => a.textCode === "activity.codex_background_unverified")!;
    expect(line.textParams).toEqual({ count: "2", why: { code: "why.codex_log_unbound" } });
    expect(line.text).toContain("Codex 세션 기록을 아직 이 팀장과 연결하지 못했습니다");
    await Bun.sleep(200);
    expect(activityCodes(t, m.id).filter(code => code === "activity.codex_background_unverified")).toHaveLength(1);
    expect(lastRun(t, m.id)).toMatchObject({ phase: "running", lastProgressAt: before });
    expect(t.member(m.id).status).toBe("working");
  }, 30_000);

  test("서버를 다시 띄워도 이미 닫은 업무의 턴 끝과 활동 줄을 되풀이하지 않는다", async () => {
    const t = await setup();
    const { m, prompt } = await codexAtWork(t);
    writeRollout(t, m, prompt);
    t.core.setScreen(m.id, BACKGROUND);
    await t.waitFor("업무 닫힘", () => lastRun(t, m.id)?.phase === "ended");
    await t.waitFor("활동 줄", () => activityCodes(t, m.id).includes("activity.codex_background_left"));
    const turnEnds = activityCodes(t, m.id).filter(code => code === "activity.turn_end").length;
    const t2 = await t.restart();
    cleanups.push(() => t2.close());
    await t2.waitFor("다시 붙음·쉬는 중", () => t2.runner.isBusy(m.id) && t2.member(m.id).status === "idle");
    await Bun.sleep(300);
    expect(activityCodes(t2, m.id).filter(code => code === "activity.turn_end")).toHaveLength(turnEnds);
    expect(activityCodes(t2, m.id).filter(code => code === "activity.codex_background_left")).toHaveLength(1);
    expect(t2.core.turns(m.id)).toHaveLength(1);
  }, 30_000);

  // 검토 지적 3: 배포 경로. 라이브 DB 처럼 실행 기록은 running, 팀장은 일하는 중('진전 없음' 표시), 세션은 연결된 채로 새 코드의 서버가 뜬다.
  test("실행 기록이 running 인 채로 서버가 다시 뜨면 붙는 순간에는 닫지 않고, 다음 관측에서 성공으로 닫아 쉬는 중이 된다('진전 없음' 표시도 지운다)", async () => {
    const t = await setup();
    const { m, prompt } = await codexAtWork(t);
    // 옛 서버는 끝을 보지 못한다: 그때 Codex 기록의 턴은 아직 열려 있었다.
    const { path } = writeRollout(t, m, prompt, { complete: false });
    t.core.setScreen(m.id, BACKGROUND);
    await t.waitFor("세션 연결", () => !!t.member(m.id).sessionId);
    const run = lastRun(t, m.id)!;
    expect(run.phase).toBe("running");
    // 라이브처럼 오래 진전이 없던 업무와 그 표시.
    const old = new Date(Date.now() - 3_600_000).toISOString();
    t.store.saveExecutionJournal({ ...run, lastProgressAt: old });
    t.store.patchMember(m.id, { statusObservation: { ...t.member(m.id).statusObservation!, error: { code: "progress_stalled", note: "가짜 진전 없음" } } });
    await t.stopServer();
    // 서버가 꺼진 사이 Codex 기록에 턴 끝이 붙었다(라이브에서는 옛 서버가 이 근거를 읽지 않았다).
    completeRollout(path);
    const t2 = await t.restart();
    cleanups.push(() => t2.close());
    const ended = await t2.waitFor("업무 닫힘", () => { const r = lastRun(t2, m.id); return r?.phase === "ended" ? r : null; });
    expect(ended).toMatchObject({ runId: run.runId, result: "success", reason: "codex_background_terminal" });
    await t2.waitFor("쉬는 중·표시 지움", () => t2.member(m.id).status === "idle" && t2.member(m.id).statusObservation?.error === null);
    await Bun.sleep(300);
    expect(t2.member(m.id)).toMatchObject({ status: "idle", statusObservation: { error: null } });
    expect(activityCodes(t2, m.id).filter(code => code === "activity.turn_end")).toHaveLength(1);
    expect(activityCodes(t2, m.id).filter(code => code === "activity.codex_background_left")).toHaveLength(1);
    // core 는 여전히 working 이라 입력은 넣지 않는다.
    expect(t2.runner.isBusy(m.id)).toBe(true);
    expect(t2.runner.backgroundTerminals(m.id)).toBe(1);
    expect(t2.core.turns(m.id)).toHaveLength(1);
  }, 30_000);

  // 검토 지적 1: turn 번호를 비운 턴 끝도 '방금 끝난 턴'의 측정(같은 core turn 번호)으로 적어, 다음 전달 전의 자동 압축을 건너뛰지 않는다.
  test("백그라운드로 닫은 턴의 문맥 측정이 압축 기준을 넘으면, 그 프로그램이 끝난 뒤 다음 전달보다 압축을 먼저 한다", async () => {
    const t = await setup();
    expect(t.store.getSettings().compactAtPct).toBe(70);
    const { m, prompt } = await codexAtWork(t);
    // 258,400 칸 가운데 230,000(89%).
    writeRollout(t, m, prompt, { tokens: 230_000 });
    t.core.setScreen(m.id, BACKGROUND);
    await t.waitFor("업무 닫힘", () => lastRun(t, m.id)?.phase === "ended");
    await t.waitFor("활동 줄", () => activityCodes(t, m.id).includes("activity.codex_background_left"));
    const state = t.store.getContextState(m.id)!;
    expect(state.measurement).toMatchObject({ tokens: 230_000, quality: "exact", fresh: true });
    expect(state.measurement!.turn).not.toBeNull();
    expect(state.baseline?.completedTurn).toBe(state.measurement!.turn);
    expect(t.member(m.id).contextPct).toBeGreaterThanOrEqual(70);
    const waiting = (await t.orch.assign(t.project.id, m.handle, { text: "다음 일" })).delivery.id;
    t.core.setDirectives("@fake:hold");
    t.core.setScreen(m.id, CODEX_IDLE);
    t.core.release(m.id);
    await t.waitFor("다음 턴", () => t.core.turns(m.id).length === 2);
    expect(t.core.turns(m.id)[1]!.prompt.startsWith("/compact")).toBe(true);
    expect(t.store.getContextState(m.id)!.compaction).toMatchObject({ trigger: "auto" });
    expect(t.store.requireDelivery(waiting).status).not.toBe("delivered");
  }, 30_000);

  // 검토 지적 2: 쉬는 중으로 보이지만 입력을 넣지 않는 팀장. 거절은 그 까닭으로 하고(넓은 코드는 그대로), 상한 알림의 잠재울 후보로 권하지 않는다.
  test("백그라운드 프로그램만 남은 팀장은 잠재우기·보관·CLI 바꾸기를 그 까닭으로 거절하고, 잠재울 후보로 권하지 않는다. 그래도 잠재우기는 된다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const { m, prompt } = await codexAtWork(t);
    // 보고하고 끝낸 턴이라 '보고 보완' 글이 붙지 않는다(대기열이 비어 있어야 잠재울 후보가 될 수 있다).
    await t.orch.recordPost(t.member(m.id), { kind: "완료", title: "미리보기 보고" });
    writeRollout(t, m, prompt);
    t.core.setScreen(m.id, BACKGROUND);
    await t.waitFor("업무 닫힘", () => lastRun(t, m.id)?.phase === "ended");
    await t.waitFor("쉬는 중", () => t.member(m.id).status === "idle" && t.runner.backgroundTerminals(m.id) === 1);
    await t.idle(lead.id);
    expect(t.member(m.id).queuedCount).toBe(0);

    // 잠재우기: 출시된 앱은 code(member_working)로 '그래도 잠재우기'를 띄우고, 새 앱은 reason 으로 영어 문장을 고른다.
    const sleep = await t.api("POST", `/api/members/${m.id}/sleep`);
    expect(sleep.status).toBe(409);
    expect(await sleep.json()).toEqual({ error: ERROR_CODES.sleep_background_program.ko, code: "member_working", reason: "sleep_background_program" });
    expect(await rejection(t.orch.patchProject(t.project.id, { archived: true }))).toMatchObject({ status: 409, code: "archive_member_working", reason: "archive_background_program",
      message: `미리보기가 턴은 끝냈지만 Codex가 띄운 백그라운드 프로그램이 아직 돌고 있어 보관할 수 없습니다. 터미널에서 /stop 으로 닫은 뒤 보관하세요` });
    expect(t.store.requireProject(t.project.id).archived).toBe(false);
    expect(await rejection(t.orch.patchMemberConfig(m.id, { cli: "claude" }))).toMatchObject({ status: 409, code: "cli_switch_busy", reason: "cli_switch_background_program", message: ERROR_CODES.cli_switch_background_program.ko });
    expect(t.member(m.id).cli).toBe("codex");

    // 깨어 있는 팀장 상한 알림: 이 팀장은 쉬는 중이지만 잠재우기가 거절되므로 후보가 아니다.
    t.store.patchSettings({ maxAwakeWorkers: 0 });
    (t.orch as unknown as { checkAwakeLimit(projectId: string): void }).checkAwakeLimit(t.project.id);
    const notice = t.store.listPending(lead.id).filter(d => d.text.includes("상한")).at(-1)!;
    expect(notice.text).toContain("지금 잠재울 수 있는 직원이 없습니다");
    expect(notice.text).not.toContain("잠재울 후보");

    // 답이 끝난 '결재 기다림'을 지금 하는 대로 고칠 때도 일하는 중이 아니라 쉬는 중으로 돌린다.
    t.store.patchMember(m.id, { status: "waiting" });
    (t.orch as unknown as { refreshWaiting(memberId: string): void }).refreshWaiting(m.id);
    expect(t.member(m.id).status).toBe("idle");

    // '그래도 잠재우기'(force)는 지금처럼 된다. 터미널과 함께 그 프로그램도 끝난다.
    await t.orch.sleepMember(m.id, { force: true });
    expect(t.member(m.id).status).toBe("asleep");
  }, 30_000);

  // 0.2.7 묶음 4: 핫픽스 B 검토 대응에서 남긴 곳(server/flows/owner.ts reopenDecision).
  test("백그라운드 프로그램만 남은 팀장의 결재를 대표가 다시 열면 '결재 기다림'이 된다(쉬는 중으로 남지 않는다)", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const { m, prompt } = await codexAtWork(t);
    await t.orch.recordPost(t.member(m.id), { kind: "완료", title: "미리보기 보고" });
    const card = t.store.createDecision({ projectId: t.project.id, memberId: m.id, who: m.name, title: "가짜 질문" });
    await t.orch.closeAsk(t.member(lead.id), { id: card.id, kind: "obsolete", reason: "필요 없어짐" });
    writeRollout(t, m, prompt);
    t.core.setScreen(m.id, BACKGROUND);
    await t.waitFor("업무 닫힘", () => lastRun(t, m.id)?.phase === "ended");
    await t.waitFor("쉬는 중", () => t.member(m.id).status === "idle" && t.runner.backgroundTerminals(m.id) === 1);
    expect(t.runner.isBusy(m.id)).toBe(true);
    await t.orch.reopenDecision(card.id);
    expect(t.store.requireDecision(card.id).status).toBe("open");
    expect(t.member(m.id).status).toBe("waiting");
  }, 30_000);
});
