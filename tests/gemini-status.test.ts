// Gemini(Antigravity CLI) 상태줄 기록의 계약: 상태줄 입력 JSON → 기록, 기록 파일의 자리, 읽기.
// 진짜 agy 는 띄우지 않는다. 입력 예시는 설계 요약의 상태줄 칸 목록으로 만든 것이다(실제 agy 출력 견본이 아니다).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { geminiStatusFromPayload, geminiStatusPath, readGeminiStatus, type GeminiStatusRecord } from "../server/runner/gemini-status.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "iamceo-gemini-status-")); dirs.push(dir); return dir; }
/** 래퍼가 하듯 기록 파일을 둔다(값이 글이면 그대로, 아니면 JSON). */
function put(home: string, memberId: string, value: unknown): string {
  const path = geminiStatusPath(home, memberId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  return path;
}

const NOW = new Date("2026-11-21T03:00:00.000Z");
const CONVERSATION = "0b6f6a52-3c1e-4d7a-9a51-7f2d5c1e8a90";
const TRANSCRIPT = `/Users/tester/.gemini/antigravity-cli/brain/${CONVERSATION}/.system_generated/logs/transcript.jsonl`;
const EMAIL = "owner@example.com";
/** 상태줄 입력 예시(설계 요약 2절의 칸). */
const PAYLOAD = {
  session_id: CONVERSATION,
  conversation_id: CONVERSATION,
  transcript_path: TRANSCRIPT,
  model: { id: "gemini-4-argon-high", display_name: "Gemini 4 Argon", effort: "high" },
  context_window: {
    total_input_tokens: 48_213, total_output_tokens: 1_902, context_window_size: 1_000_000,
    used_percentage: 4.8, remaining_percentage: 95.2, current_usage: { input_tokens: 47_100, output_tokens: 310 },
  },
  quota: {
    "gemini-pro": { remaining_fraction: 0.82, reset_time: "2026-11-21T08:00:00Z", reset_in_seconds: 18_000 },
    "gemini-flash": { remaining_amount: 140, reset_in_seconds: 3_600 },
    "third-party": { remaining_fraction: 0, disabled: true },
  },
  agent_state: "working",
  cycle_mode: "auto",
  subagents: [{ name: "explorer", role: "research", status: "running" }, { name: "tester", role: "verify", status: "idle" }],
  pending_input_count: 0,
  tool_confirmation_pending: false,
  task_count: 2,
  plan_tier: "Google AI Ultra",
  email: EMAIL,
  cost: { total_usd: 0.4312, subagent_usd: 0.05, estimated: true },
  version: "1.5.14",
};
const RECORD: GeminiStatusRecord = {
  v: 1,
  memberId: "m_lead1",
  at: "2026-11-21T03:00:00.000Z",
  conversationId: CONVERSATION,
  // 0.2.10: 상태줄의 transcript_path 는 옮기지 않는다(1.5.14 실측: 없는 경로를 알린다).
  transcriptPath: null,
  model: { id: "gemini-4-argon-high", effort: "high" },
  context: { usedPct: 4.8, windowSize: 1_000_000, inputTokens: 48_213, outputTokens: 1_902 },
  quota: {
    "gemini-pro": { remainingFraction: 0.82, resetAt: "2026-11-21T08:00:00.000Z", disabled: false },
    "gemini-flash": { remainingFraction: null, resetAt: "2026-11-21T04:00:00.000Z", disabled: false },
    "third-party": { remainingFraction: 0, resetAt: null, disabled: true },
  },
  costUsd: 0.4312,
  agentState: "working",
  // 예시 입력의 두 항목: 도는 것(running) 하나, 문서에 없는 상태(idle) 하나.
  subagents: 1,
  subagentsUnknown: 1,
  planTier: "Google AI Ultra",
  launch: null,
  cycleMode: "auto",
  sandbox: null,
};
/** 모양이 다른 입력에서 나오는 빈 기록. */
const EMPTY: GeminiStatusRecord = {
  v: 1, memberId: "m_lead1", at: "2026-11-21T03:00:00.000Z", conversationId: null, transcriptPath: null,
  model: { id: null, effort: null }, context: { usedPct: null, windowSize: null, inputTokens: null, outputTokens: null },
  quota: {}, costUsd: null, agentState: null, subagents: 0, subagentsUnknown: 0, planTier: null, launch: null, cycleMode: null, sandbox: null,
};
const LAUNCH = "0f8fad5bd9cb469fa16570867728950e";

describe("상태줄 입력 JSON → 기록", () => {
  test("예시 입력을 기록 모양으로 옮긴다", () => {
    expect(geminiStatusFromPayload("m_lead1", PAYLOAD, NOW)).toEqual(RECORD);
    // JSON 글로 온 입력(래퍼가 실제로 받는 것)도 같다.
    expect(geminiStatusFromPayload("m_lead1", JSON.parse(JSON.stringify(PAYLOAD)), NOW)).toEqual(RECORD);
  });

  test("계정 메일을 비롯해 정해 둔 칸 밖의 값은 담지 않는다", () => {
    const record = geminiStatusFromPayload("m_lead1", { ...PAYLOAD, account: { email: EMAIL }, model: { ...PAYLOAD.model, email: EMAIL } }, NOW);
    const text = JSON.stringify(record);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("email");
    expect(text).not.toContain("Gemini 4 Argon");
    expect(Object.keys(record).sort()).toEqual(Object.keys(RECORD).sort());
  });

  test("첫 대화 전(빈 id)에는 conversationId 가 null 이고, conversation_id 가 없으면 session_id 를 쓴다", () => {
    expect(geminiStatusFromPayload("m_lead1", { ...PAYLOAD, session_id: "", conversation_id: "" }, NOW).conversationId).toBeNull();
    const { conversation_id: _dropped, ...sessionOnly } = PAYLOAD;
    expect(geminiStatusFromPayload("m_lead1", sessionOnly, NOW).conversationId).toBe(CONVERSATION);
  });

  test("경로·명령줄에 쓰면 위험한 id 와 경로는 받지 않는다", () => {
    for (const bad of ["../../etc/passwd", "a/b", "--settings", ".hidden", "a.b", "a:b", "a b", "a\nb", "x".repeat(129), 7, null, { id: CONVERSATION }]) {
      expect(geminiStatusFromPayload("m_lead1", { conversation_id: bad, session_id: bad }, NOW).conversationId).toBeNull();
    }
    for (const bad of ["relative/transcript.jsonl", "", "/x\0y", "/" + "p".repeat(4096), 3, null]) {
      expect(geminiStatusFromPayload("m_lead1", { transcript_path: bad }, NOW).transcriptPath).toBeNull();
    }
  });

  test("1.5.14 실측: 상태줄의 transcript_path 는 없는 경로(~/.gemini/antigravity/…)라 기록에 옮기지 않는다. 앞 판 래퍼가 적은 경로가 든 기록은 그대로 읽힌다", () => {
    const wrong = `/Users/user/.gemini/antigravity/brain/${CONVERSATION}/.system_generated/logs/transcript.jsonl`;
    expect(geminiStatusFromPayload("m_lead1", { transcript_path: wrong, conversation_id: CONVERSATION }, NOW).transcriptPath).toBeNull();
    expect(geminiStatusFromPayload("m_lead1", { transcript_path: TRANSCRIPT }, NOW).transcriptPath).toBeNull();
    const home = temp();
    put(home, "m_lead1", { ...RECORD, transcriptPath: wrong });
    expect(readGeminiStatus(home, "m_lead1")?.transcriptPath).toBe(wrong);
  });

  test("숫자는 유한수이고 범위 안일 때만 받는다. 아니면 null", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, "42", null, undefined, true, [1], { n: 1 }]) {
      const record = geminiStatusFromPayload("m_lead1", {
        context_window: { used_percentage: bad, context_window_size: bad, total_input_tokens: bad, total_output_tokens: bad },
        quota: { pro: { remaining_fraction: bad, reset_in_seconds: bad } },
        cost: { total_usd: bad },
      }, NOW);
      expect(record.context).toEqual({ usedPct: null, windowSize: null, inputTokens: null, outputTokens: null });
      expect(record.quota).toEqual({ pro: { remainingFraction: null, resetAt: null, disabled: false } });
      expect(record.costUsd).toBeNull();
    }
    // 범위 밖: 문맥 % 는 100 까지, 창 크기는 0 초과, 남은 비율은 0~1.
    const edge = geminiStatusFromPayload("m_lead1", { context_window: { used_percentage: 100.5, context_window_size: 0 }, quota: { pro: { remaining_fraction: 1.2 } } }, NOW);
    expect(edge.context.usedPct).toBeNull();
    expect(edge.context.windowSize).toBeNull();
    expect(edge.quota.pro!.remainingFraction).toBeNull();
    const ok = geminiStatusFromPayload("m_lead1", { context_window: { used_percentage: 100, total_input_tokens: 0 }, quota: { pro: { remaining_fraction: 1 } }, cost: { total_usd: 0 } }, NOW);
    expect(ok.context.usedPct).toBe(100);
    expect(ok.context.inputTokens).toBe(0);
    expect(ok.quota.pro!.remainingFraction).toBe(1);
    expect(ok.costUsd).toBe(0);
  });

  test("한도 초기화 시각: ISO 글·epoch 초·epoch 밀리초를 ISO 로 옮기고, 없으면 지금 + reset_in_seconds", () => {
    const resetOf = (bucket: unknown) => geminiStatusFromPayload("m_lead1", { quota: { pro: bucket } }, NOW).quota.pro?.resetAt;
    expect(resetOf({ reset_time: "2026-11-21T17:00:00+09:00" })).toBe("2026-11-21T08:00:00.000Z");
    expect(resetOf({ reset_time: 1_795_248_000 })).toBe(new Date(1_795_248_000_000).toISOString());
    expect(resetOf({ reset_time: 1_795_248_000_000 })).toBe(new Date(1_795_248_000_000).toISOString());
    expect(resetOf({ reset_in_seconds: 90 })).toBe("2026-11-21T03:01:30.000Z");
    // 읽지 못한 reset_time 은 버리고 reset_in_seconds 로 간다.
    expect(resetOf({ reset_time: "tomorrow", reset_in_seconds: 60 })).toBe("2026-11-21T03:01:00.000Z");
    for (const bad of ["tomorrow", "2026-11-21", "", 0, -5, Number.NaN, null, {}]) expect(resetOf({ reset_time: bad })).toBeNull();
    expect(resetOf({ reset_in_seconds: 1e300 })).toBeNull();
  });

  test("한도 묶음: 객체가 아닌 값·이상한 이름은 빼고 32개까지만 담는다", () => {
    const record = geminiStatusFromPayload("m_lead1", JSON.parse(`{"quota":{"ok":{"remaining_fraction":0.5},"text":"x","list":[1],"none":null,"":{"remaining_fraction":0.1},"__proto__":{"remaining_fraction":0.2},"bad\\nname":{"remaining_fraction":0.3}}}`), NOW);
    expect(record.quota).toEqual({ ok: { remainingFraction: 0.5, resetAt: null, disabled: false } });
    expect(Object.getPrototypeOf(record.quota)).toBe(Object.prototype);
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`bucket-${i}`, { remaining_fraction: 0.5 }]));
    expect(Object.keys(geminiStatusFromPayload("m_lead1", { quota: many }, NOW).quota)).toHaveLength(32);
    // disabled 는 true 일 때만 true 다.
    expect(geminiStatusFromPayload("m_lead1", { quota: { a: { disabled: "yes" }, b: { disabled: true } } }, NOW).quota).toEqual({
      a: { remainingFraction: null, resetAt: null, disabled: false }, b: { remainingFraction: null, resetAt: null, disabled: true } });
  });

  test("객체가 아닌 입력과 모양이 다른 칸은 빈 기록이 된다(던지지 않는다)", () => {
    for (const payload of [null, undefined, "text", 7, [], [PAYLOAD], true]) expect(geminiStatusFromPayload("m_lead1", payload, NOW)).toEqual(EMPTY);
    expect(geminiStatusFromPayload("m_lead1", { model: "gemini", context_window: [1], quota: "none", cost: 3, agent_state: 5, subagents: { length: 3 }, plan_tier: ["x"], transcript_path: {} }, NOW)).toEqual(EMPTY);
    expect(geminiStatusFromPayload("m_lead1", { agent_state: "", plan_tier: "x".repeat(81), model: { id: "", effort: "e".repeat(41) } }, NOW)).toEqual(EMPTY);
  });

  test("서브에이전트: 도는 것(running)만 세고, 끝난 것(completed)은 뺀다. 둘 다 아닌 항목은 도는 수에 넣지 않고 따로 센다", () => {
    const count = (subagents: unknown) => { const record = geminiStatusFromPayload("m_lead1", { subagents }, NOW); return [record.subagents, record.subagentsUnknown]; };
    expect(count([])).toEqual([0, 0]);
    expect(count([{ name: "a", status: "completed" }, { name: "b", status: "completed" }])).toEqual([0, 0]);
    expect(count([{ name: "a", status: "completed" }, { name: "b", status: "running" }])).toEqual([1, 0]);
    // 상태가 없거나, 글이 아니거나, 문서에 없는 값(failed·cancelled·idle …)이거나, 객체가 아닌 항목: 도는 중인지 모른다.
    expect(count([{ name: "a" }, { name: "b", status: 7 }, null, "x", { status: "running" }])).toEqual([1, 4]);
    expect(count([{ status: "failed" }, { status: "cancelled" }, { status: "idle" }, { status: "Running" }, { status: "running" }, { status: "completed" }])).toEqual([1, 4]);
    // 배열이 아니면 항목이 없는 것이다.
    expect(count({ length: 3 })).toEqual([0, 0]);
    expect(count(undefined)).toEqual([0, 0]);
  });

  test("띄우기 값(넷째 인자)은 모양이 맞을 때만 기록에 적는다. 주지 않으면 null 이다", () => {
    expect(geminiStatusFromPayload("m_lead1", PAYLOAD, NOW, LAUNCH)).toEqual({ ...RECORD, launch: LAUNCH });
    expect(geminiStatusFromPayload("m_lead1", PAYLOAD, NOW).launch).toBeNull();
    expect(geminiStatusFromPayload("m_lead1", PAYLOAD, NOW, null).launch).toBeNull();
    expect(geminiStatusFromPayload("m_lead1", PAYLOAD, NOW, "a-b_C9").launch).toBe("a-b_C9");
    for (const bad of ["", "a b", "a/b", "x'; rm -rf /", "가나다", "x".repeat(65), 7, {}, undefined]) expect(geminiStatusFromPayload("m_lead1", PAYLOAD, NOW, bad as never).launch).toBeNull();
    // 상태줄 입력 안의 같은 이름 칸은 띄우기 값이 아니다(agy 가 주는 값이 아니라 서버가 명령에 실은 값만 쓴다).
    expect(geminiStatusFromPayload("m_lead1", { ...PAYLOAD, launch: LAUNCH }, NOW).launch).toBeNull();
  });

  test("바깥 이름을 쓰지 않는다: 함수 글만 떼어 독립 스크립트에 넣어도 같은 기록을 만든다", () => {
    const standalone = new Function(`return (${geminiStatusFromPayload.toString()});`)() as typeof geminiStatusFromPayload;
    expect(standalone("m_lead1", PAYLOAD, NOW)).toEqual(RECORD);
    expect(standalone("m_lead1", PAYLOAD, NOW, LAUNCH)).toEqual({ ...RECORD, launch: LAUNCH });
    expect(standalone("m_lead1", { subagents: [{ status: "running" }, {}, { status: "completed" }] }, NOW)).toMatchObject({ subagents: 1, subagentsUnknown: 1 });
    expect(standalone("m_lead1", null, NOW)).toEqual(EMPTY);
    expect(standalone("m_lead1", { quota: { pro: { reset_time: 1_795_248_000 } } }, NOW).quota).toEqual({ pro: { remainingFraction: null, resetAt: new Date(1_795_248_000_000).toISOString(), disabled: false } });
    expect(() => standalone("../x", PAYLOAD, NOW)).toThrow("invalid member id");
  });
});

describe("잘못된 memberId", () => {
  const BAD = ["", "../m_x", "a/b", "a.b", "a b", "m\0x", "가나다", "m".repeat(65)];

  test("기록 파일 자리는 <contextHome>/context/gemini/<memberId>.json 이고, 모양이 다른 id 는 던진다", () => {
    expect(geminiStatusPath("/tmp/iamceo-home", "m_lead1")).toBe("/tmp/iamceo-home/context/gemini/m_lead1.json");
    expect(geminiStatusPath("/tmp/iamceo-home", "M-9_z")).toBe("/tmp/iamceo-home/context/gemini/M-9_z.json");
    expect(geminiStatusPath("/tmp/iamceo-home", "m".repeat(64))).toEndWith(`/${"m".repeat(64)}.json`);
    for (const id of BAD) expect(() => geminiStatusPath("/tmp/iamceo-home", id)).toThrow("invalid member id");
    for (const id of [undefined, null, 7, {}]) expect(() => geminiStatusPath("/tmp/iamceo-home", id as never)).toThrow("invalid member id");
    // 상대 경로의 홈은 작업 폴더(남의 저장소일 수 있다) 아래를 가리키게 되므로 받지 않는다.
    for (const home of ["", "relative/home", "."]) expect(() => geminiStatusPath(home, "m_lead1")).toThrow("absolute");
  });

  test("기록을 만들 때도 던지고, 읽을 때는 던지지 않고 null 이다", () => {
    const home = temp();
    put(home, "m_lead1", RECORD);
    for (const id of BAD) {
      expect(() => geminiStatusFromPayload(id, PAYLOAD, NOW)).toThrow("invalid member id");
      expect(readGeminiStatus(home, id)).toBeNull();
    }
    expect(readGeminiStatus("relative/home", "m_lead1")).toBeNull();
  });
});

describe("기록 읽기", () => {
  test("없으면 null, 래퍼가 쓴 기록은 그대로 읽는다", () => {
    const home = temp();
    expect(readGeminiStatus(home, "m_lead1")).toBeNull();
    put(home, "m_lead1", geminiStatusFromPayload("m_lead1", PAYLOAD, NOW));
    expect(readGeminiStatus(home, "m_lead1")).toEqual(RECORD);
    // 다른 팀장의 자리는 비어 있다.
    expect(readGeminiStatus(home, "m_lead2")).toBeNull();
  });

  test("입력이 어떤 모양이든 만든 기록은 다시 읽힌다(쓰는 규칙과 읽는 규칙이 같다)", () => {
    const home = temp();
    const payloads: unknown[] = [
      PAYLOAD, null, {}, { conversation_id: "abc-DEF_1-2_3" }, { session_id: "x".repeat(128) },
      { quota: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`b${i}`, { remaining_fraction: i / 40, reset_time: 1_795_248_000 + i, disabled: i % 2 === 0 }])) },
      { context_window: { used_percentage: 0, context_window_size: 1, total_input_tokens: 0.5, total_output_tokens: 9_007_199_254_740_991 }, cost: { total_usd: 1e-9 } },
      { subagents: Array.from({ length: 20_000 }, () => ({})) },
      { transcript_path: "/" + "p".repeat(4095), plan_tier: "x".repeat(80), agent_state: "s".repeat(40), model: { id: "i".repeat(200), effort: "e".repeat(40) } },
      { quota: { far: { reset_time: "9999-12-31T23:59:59.999Z" }, soon: { reset_in_seconds: 0 } } },
    ];
    for (const payload of payloads) {
      const record = geminiStatusFromPayload("m_lead1", payload, NOW);
      put(home, "m_lead1", record);
      expect(readGeminiStatus(home, "m_lead1")).toEqual(record);
    }
    expect(geminiStatusFromPayload("m_lead1", payloads[3], NOW).conversationId).toBe("abc-DEF_1-2_3");
    expect(geminiStatusFromPayload("m_lead1", payloads[4], NOW).conversationId).toBe("x".repeat(128));
    // 상태 없는 항목 20,000개: 도는 수에는 넣지 않고, 따로 세는 수는 상한(10,000)까지다.
    expect(geminiStatusFromPayload("m_lead1", payloads[7], NOW)).toMatchObject({ subagents: 0, subagentsUnknown: 10_000 });
    expect(geminiStatusFromPayload("m_lead1", { subagents: Array.from({ length: 20_000 }, () => ({ status: "running" })) }, NOW)).toMatchObject({ subagents: 10_000, subagentsUnknown: 0 });
    // 띄우기 값이 적힌 기록도 그대로 읽힌다.
    put(home, "m_lead1", geminiStatusFromPayload("m_lead1", PAYLOAD, NOW, LAUNCH));
    expect(readGeminiStatus(home, "m_lead1")).toEqual({ ...RECORD, launch: LAUNCH });
  });

  test("뒤에 더한 칸(subagentsUnknown·launch)이 없는 기록도 읽는다: 둘 다 null 이다", () => {
    const home = temp();
    const { subagentsUnknown: _unknown, launch: _launch, ...older } = RECORD;
    put(home, "m_lead1", older);
    expect(readGeminiStatus(home, "m_lead1")).toEqual({ ...RECORD, subagentsUnknown: null, launch: null });
    // 한 칸만 없어도 같다.
    put(home, "m_lead1", { ...older, launch: LAUNCH });
    expect(readGeminiStatus(home, "m_lead1")).toEqual({ ...RECORD, subagentsUnknown: null, launch: LAUNCH });
    put(home, "m_lead1", { ...older, subagentsUnknown: 3 });
    expect(readGeminiStatus(home, "m_lead1")).toEqual({ ...RECORD, subagentsUnknown: 3, launch: null });
    // null 로 적힌 것도 받는다.
    put(home, "m_lead1", { ...older, subagentsUnknown: null, launch: null });
    expect(readGeminiStatus(home, "m_lead1")).toEqual({ ...RECORD, subagentsUnknown: null, launch: null });
  });

  test("깨진 파일은 null: JSON 이 아님, 빈 파일, 객체가 아님", () => {
    const home = temp();
    for (const text of ["", "{", "not json", "null", "[]", "7", `"text"`, JSON.stringify(RECORD).slice(0, -5)]) {
      put(home, "m_lead1", text);
      expect(readGeminiStatus(home, "m_lead1")).toBeNull();
    }
  });

  test("v 가 1 이 아니거나 다른 팀장의 기록이면 null", () => {
    const home = temp();
    for (const v of [2, 0, "1", null, undefined]) {
      put(home, "m_lead1", { ...RECORD, v });
      expect(readGeminiStatus(home, "m_lead1")).toBeNull();
    }
    put(home, "m_lead1", { ...RECORD, memberId: "m_lead2" });
    expect(readGeminiStatus(home, "m_lead1")).toBeNull();
  });

  test("한 칸이라도 모양이 다르면 null(쓰는 쪽이 믿고 쓸 수 있게)", () => {
    const home = temp();
    const broken: Record<string, unknown>[] = [
      { at: "yesterday" }, { at: "2026-11-21T03:00:00Z" }, { at: 1_795_000_000 }, { at: null },
      { conversationId: "../../x" }, { conversationId: "a.b" }, { conversationId: "" }, { conversationId: 7 }, { conversationId: undefined },
      { transcriptPath: "relative.jsonl" }, { transcriptPath: 3 },
      { model: null }, { model: { id: 3, effort: null } }, { model: { id: null } },
      { context: null }, { context: { ...RECORD.context, usedPct: 101 } }, { context: { ...RECORD.context, usedPct: "4.8" } },
      { context: { ...RECORD.context, windowSize: 0 } }, { context: { ...RECORD.context, inputTokens: -1 } }, { context: { usedPct: null, windowSize: null, inputTokens: null } },
      { quota: null }, { quota: [] }, { quota: { pro: null } }, { quota: { pro: { remainingFraction: 2, resetAt: null, disabled: false } } },
      { quota: { pro: { remainingFraction: null, resetAt: "soon", disabled: false } } }, { quota: { pro: { remainingFraction: null, resetAt: null } } },
      { quota: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`b${i}`, { remainingFraction: null, resetAt: null, disabled: false }])) },
      { costUsd: "0.4" }, { costUsd: -1 }, { agentState: 5 }, { agentState: "" }, { planTier: 5 },
      { subagents: -1 }, { subagents: 1.5 }, { subagents: "2" }, { subagents: null }, { subagents: 10_001 },
      { subagentsUnknown: -1 }, { subagentsUnknown: 1.5 }, { subagentsUnknown: "2" }, { subagentsUnknown: 10_001 },
      { launch: "" }, { launch: "a b" }, { launch: "../x" }, { launch: 7 }, { launch: "x".repeat(65) },
    ];
    for (const change of broken) {
      put(home, "m_lead1", { ...RECORD, ...change });
      expect([change, readGeminiStatus(home, "m_lead1")]).toEqual([change, null]);
    }
    // 견줌: 고치지 않은 기록은 읽힌다.
    put(home, "m_lead1", RECORD);
    expect(readGeminiStatus(home, "m_lead1")).toEqual(RECORD);
  });

  test("기록에 다른 칸이 섞여 있어도 아는 칸만 돌려준다(메일이 새지 않는다)", () => {
    const home = temp();
    put(home, "m_lead1", { ...RECORD, email: EMAIL, model: { ...RECORD.model, display_name: "Gemini 4 Argon" }, quota: { ...RECORD.quota, "gemini-pro": { ...RECORD.quota["gemini-pro"], owner: EMAIL } } });
    const record = readGeminiStatus(home, "m_lead1");
    expect(record).toEqual(RECORD);
    expect(JSON.stringify(record)).not.toContain(EMAIL);
  });

  test("보통 파일이 아니면 읽지 않는다: 링크, 폴더, 너무 큰 파일", () => {
    const home = temp();
    const real = put(home, "m_real", { ...RECORD, memberId: "m_link" });
    const link = geminiStatusPath(home, "m_link");
    symlinkSync(real, link);
    expect(readGeminiStatus(home, "m_link")).toBeNull();
    mkdirSync(geminiStatusPath(home, "m_dir"));
    expect(readGeminiStatus(home, "m_dir")).toBeNull();
    put(home, "m_big", JSON.stringify({ ...RECORD, memberId: "m_big" }) + " ".repeat(64 * 1024));
    expect(readGeminiStatus(home, "m_big")).toBeNull();
    put(home, "m_big", JSON.stringify({ ...RECORD, memberId: "m_big" }) + " ".repeat(1024));
    expect(readGeminiStatus(home, "m_big")).toEqual({ ...RECORD, memberId: "m_big" });
  });
});

describe("모드(cycle_mode)·샌드박스: 권한 auto 가 실제로 들었는지의 근거", () => {
  test("cycle_mode 글은 그대로, 칸이 없으면 default(상태줄 입력으로 보일 때만), 그 밖은 모름", () => {
    const mode = (payload: Record<string, unknown>) => geminiStatusFromPayload("m_lead1", payload, NOW).cycleMode;
    expect(mode({ agent_state: "idle", cycle_mode: "auto" })).toBe("auto");
    expect(mode({ agent_state: "idle", cycle_mode: "accept-edits" })).toBe("accept-edits");
    expect(mode({ agent_state: "idle" })).toBe("default");
    expect(mode({ agent_state: "idle", cycle_mode: null })).toBe("default");
    // agent_state 가 없거나 빈 글이면 상태줄 입력으로 믿지 않는다: 칸이 없어도 default 로 읽지 않는다.
    expect(mode({})).toBeNull();
    expect(mode({ agent_state: "" })).toBeNull();
    for (const bad of [7, "", "x".repeat(41), "a\nb", { v: "auto" }]) expect(mode({ agent_state: "idle", cycle_mode: bad })).toBeNull();
  });
  test("sandbox.enabled 는 참·거짓일 때만", () => {
    const sandbox = (value: unknown) => geminiStatusFromPayload("m_lead1", { agent_state: "idle", sandbox: value }, NOW).sandbox;
    expect(sandbox({ enabled: true })).toBe(true);
    expect(sandbox({ enabled: false })).toBe(false);
    for (const bad of [undefined, null, true, { enabled: "yes" }, []]) expect(sandbox(bad)).toBeNull();
  });
  test("이 칸을 모르던 래퍼의 기록도 읽는다(모름 = null). 있는데 모양이 다르면 깨진 기록이다", () => {
    const home = mkdtempSync(join(tmpdir(), "iamceo-gst-mode-"));
    try {
      const path = geminiStatusPath(home, "m_lead1");
      mkdirSync(dirname(path), { recursive: true });
      const { cycleMode: _c, sandbox: _s, ...old } = RECORD;
      writeFileSync(path, JSON.stringify(old));
      expect(readGeminiStatus(home, "m_lead1")).toEqual({ ...RECORD, cycleMode: null, sandbox: null });
      writeFileSync(path, JSON.stringify({ ...RECORD, cycleMode: "default", sandbox: true }));
      expect(readGeminiStatus(home, "m_lead1")).toEqual({ ...RECORD, cycleMode: "default", sandbox: true });
      writeFileSync(path, JSON.stringify({ ...RECORD, cycleMode: 3 }));
      expect(readGeminiStatus(home, "m_lead1")).toBeNull();
      writeFileSync(path, JSON.stringify({ ...RECORD, sandbox: "on" }));
      expect(readGeminiStatus(home, "m_lead1")).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
