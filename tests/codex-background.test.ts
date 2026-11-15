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
import type { Member } from "../shared/types.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions } from "./fixtures/core-harness.ts";

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
const tokens = { type: "event_msg", payload: { type: "token_count", info: { model_context_window: 258_400, last_token_usage: { total_tokens: 42_000 } } } };
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
    appendFileSync(path, rows(complete("t2"), { type: "event_msg", payload: { type: "item_completed" } }));
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
/** Codex 가 그 세션 기록에 남겼을 rollout. complete=false 면 턴이 아직 열려 있다. */
function writeRollout(t: CoreEnv, m: Member, prompt: string, opts: { complete?: boolean } = {}): string {
  const id = randomUUID(), dir = join(t.home, "codex-home", "sessions", "2026", "11", "16");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-test-${id}.jsonl`);
  writeFileSync(path, rows(meta(id, m.cwd), started("turn-1"), user(prompt), { type: "turn_context", payload: { model: "gpt-6-astra" } }, tokens,
    ...(opts.complete === false ? [] : [complete("turn-1"), { type: "event_msg", payload: { type: "item_completed" } }])));
  return id;
}

describe("백그라운드 터미널만 남은 Codex 팀장", () => {
  test("Codex 기록이 턴 끝을 보이면 업무를 성공으로 닫고 쉬는 중으로 보이며, 남은 프로그램을 활동에 알린다. 다음 전달은 그 프로그램이 끝난 뒤에 넣는다", async () => {
    const t = await setup();
    const events: RunnerEvent[] = []; t.runner.on(event => events.push(event));
    const { m, prompt } = await codexAtWork(t);
    const sessionId = writeRollout(t, m, prompt);
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
});
