// Gemini(Antigravity CLI) 사용량: 팀장마다의 상태줄 기록(<홈>/context/gemini/<팀장>.json)에서 한도·비용·누적 토큰을 읽어 모은다.
// 진짜 agy 는 띄우지 않고 ~/.gemini 도 읽지 않는다. 기록은 임시 홈에 래퍼가 쓰는 모양(geminiStatusFromPayload)으로 직접 둔다.
// 입력 예시는 설계 요약의 상태줄 칸 목록으로 만든 것이다(실제 agy 출력 견본이 아니다).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { geminiStatusFromPayload, geminiStatusPath, type GeminiStatusRecord } from "../server/runner/gemini-status.ts";
import { Store } from "../server/store.ts";
import { geminiLimits, localDay, parseGeminiUsageRecord, UsageCollector, UsageLedger, usageReport } from "../server/usage.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** 시간대와 상관없이 날짜가 정해지도록 Mac 의 그날 정오로 잡는다. */
const NOW = new Date(2026, 10, 21, 12).getTime();
const HOUR = 3_600_000;
const CONVERSATION = "0b6f6a52-3c1e-4d7a-9a51-7f2d5c1e8a90";
const OTHER_CONVERSATION = "7c1d2e3f-0000-4aaa-8bbb-123456789abc";

function temp(prefix: string): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }

/** 상태줄 입력 예시. 비용·토큰은 대화 누적값이다. */
function payload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: CONVERSATION, conversation_id: CONVERSATION,
    model: { id: "gemini-4-argon-high", display_name: "Gemini 4 Argon", effort: "high" },
    context_window: { total_input_tokens: 48_213, total_output_tokens: 1_902, context_window_size: 1_000_000, used_percentage: 4.8 },
    quota: {
      "gemini-pro": { remaining_fraction: 0.82, reset_time: new Date(NOW + 5 * HOUR).toISOString() },
      "gemini-flash": { remaining_amount: 140, reset_in_seconds: 3_600 },
      "third-party": { remaining_fraction: 0, disabled: true },
    },
    agent_state: "idle", email: "owner@example.com", cost: { total_usd: 0.4312, subagent_usd: 0.05, estimated: true }, version: "1.5.14",
    ...patch,
  };
}

function fixture() {
  const home = temp("iamceo-gemini-usage-");
  const db = openDb(join(home, "iamceo.db"));
  const store = new Store(db, new Bus());
  cleanups.push(() => db.close());
  const project = store.createProject({ name: "자료 조사", cwd: home });
  const gemini = store.createMember({ projectId: project.id, handle: "gm", name: "시장 조사", kind: "worker", cli: "gemini" });
  const second = store.createMember({ projectId: project.id, handle: "gm2", name: "경쟁사 조사", kind: "worker", cli: "gemini" });
  const claude = store.createMember({ projectId: project.id, handle: "cl", name: "결제 연동", kind: "worker" });
  const setSession = (memberId: string, sessionId: string | null) => db.query("UPDATE members SET session_id = ? WHERE id = ?").run(sessionId, memberId);
  const setCli = (memberId: string, cli: string) => db.query("UPDATE members SET cli = ? WHERE id = ?").run(cli, memberId);
  const history = (memberId: string, cli: string, sessionId: string) => db.query(`INSERT INTO member_session_history (id, member_id, cli, backend, session_id, pane_id, generation, applied_config, archived_at, reason)
    VALUES (?, ?, ?, 'core', ?, NULL, 0, NULL, ?, 'fresh')`).run(`h_${sessionId}`, memberId, cli, sessionId, new Date(NOW).toISOString());
  let stamp = 0;
  /** 래퍼가 하듯 기록을 둔다. 쓸 때마다 수정 시각이 달라지게 한다(래퍼는 새 파일로 바꿔 넣는다). */
  const status = (memberId: string, at: number, patch: Record<string, unknown> = {}): GeminiStatusRecord => {
    const record = geminiStatusFromPayload(memberId, payload(patch), new Date(at));
    const path = geminiStatusPath(home, memberId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
    const mtime = (NOW + ++stamp * 1000) / 1000;
    utimesSync(path, mtime, mtime);
    return record;
  };
  const ref = (m: typeof gemini) => ({ id: m.id, projectId: m.projectId, name: m.name, kind: m.kind });
  const ledger = new UsageLedger(db);
  const collector = () => new UsageCollector({ db, home, codexHome: null, now: () => NOW });
  const sessions = () => db.query("SELECT provider, session_id, member_id, cost_usd, input_tokens, output_tokens FROM usage_sessions ORDER BY provider, session_id").all();
  const limits = () => db.query("SELECT provider, window_id, window_minutes, used_pct, resets_at FROM usage_limits ORDER BY provider, window_id").all();
  return { home, db, store, project, gemini, second, claude, setSession, setCli, history, status, ref, ledger, collector, sessions, limits };
}

describe("수치 읽기", () => {
  test("한도 묶음 → 한도 창: 쓴 비율 = (1 - 남은 비율) × 100, 묶음 id 가 그대로 창 이름이다", () => {
    const record = geminiStatusFromPayload("m_lead", payload(), new Date(NOW));
    // 남은 양만 알려 준 묶음(gemini-flash)과 꺼진 묶음(third-party)은 뺀다. 창의 길이는 모른다.
    expect(geminiLimits(record.quota)).toEqual([{ window: "gemini-pro", windowMinutes: null, usedPct: 18, resetsAt: new Date(NOW + 5 * HOUR).toISOString() }]);
    const quota = (fraction: number): GeminiStatusRecord["quota"] => ({ bucket: { remainingFraction: fraction, resetAt: null, disabled: false } });
    // 소수 계산의 끝자리가 흔들리지 않는다.
    expect(geminiLimits(quota(0.37))[0]!.usedPct).toBe(63);
    expect(geminiLimits(quota(0.1))[0]!.usedPct).toBe(90);
    expect(geminiLimits(quota(1))[0]!.usedPct).toBe(0);
    expect(geminiLimits(quota(0))[0]!.usedPct).toBe(100);
    expect(geminiLimits(quota(0.123456))[0]!.usedPct).toBe(87.6544);
    expect(geminiLimits(quota(0))[0]!.resetsAt).toBeNull();
    expect(geminiLimits({})).toEqual([]);
  });

  test("상태줄 기록 → 표본: 대화가 있어야 하고, 비용·누적 토큰을 그대로 옮긴다. 계정 메일은 어디에도 없다", () => {
    const record = geminiStatusFromPayload("m_lead", payload(), new Date(NOW - 60_000));
    expect(parseGeminiUsageRecord(record)).toEqual({ provider: "gemini", sessionId: CONVERSATION, at: NOW - 60_000, costUsd: 0.4312, inputTokens: 48_213, outputTokens: 1_902,
      limits: [{ window: "gemini-pro", windowMinutes: null, usedPct: 18, resetsAt: new Date(NOW + 5 * HOUR).toISOString() }] });
    expect(JSON.stringify(parseGeminiUsageRecord(record))).not.toContain("owner@example.com");
    // 대화가 아직 없다(첫 대화 전의 상태줄).
    expect(parseGeminiUsageRecord(geminiStatusFromPayload("m_lead", payload({ session_id: "", conversation_id: "" }), new Date(NOW)))).toBeNull();
    // 알려 주지 않은 값은 없음(null)이다. 0 으로 채우지 않는다.
    const bare = parseGeminiUsageRecord(geminiStatusFromPayload("m_lead", { conversation_id: CONVERSATION }, new Date(NOW)))!;
    expect([bare.costUsd, bare.inputTokens, bare.outputTokens, bare.limits]).toEqual([null, null, null, []]);
    // 정수가 아닌 토큰 수는 받지 않는다.
    const odd = parseGeminiUsageRecord(geminiStatusFromPayload("m_lead", payload({ context_window: { total_input_tokens: 10.5, total_output_tokens: 7 } }), new Date(NOW)))!;
    expect([odd.inputTokens, odd.outputTokens]).toEqual([null, 7]);
  });
});

describe("모으기", () => {
  test("서버가 알아낸 대화의 누적값을 그 팀장에 넣고, 늘어난 몫만 더한다. 그대로인 기록은 다시 읽지 않는다", () => {
    const f = fixture();
    f.setSession(f.gemini.id, CONVERSATION);
    // 서버가 그 대화를 알아냈을 때 '0 에서 시작'으로 적는다(지휘 쪽이 한다).
    expect(f.ledger.registerFreshSession("gemini", CONVERSATION, f.ref(f.gemini), NOW)).toBe(true);
    // 비용을 보고하는 CLI 라 비용 기준값도 0 이다(Codex 는 null).
    expect(f.sessions()).toEqual([{ provider: "gemini", session_id: CONVERSATION, member_id: f.gemini.id, cost_usd: 0, input_tokens: 0, output_tokens: 0 }]);
    f.status(f.gemini.id, NOW - 60_000);
    const collector = f.collector();
    expect(collector.tick(NOW)).toEqual({ claude: 0, codex: 0, gemini: 1, pruned: { days: 0, sessions: 0, limits: 0 } });
    expect(collector.tick(NOW + 1000)).toMatchObject({ claude: 0, codex: 0, gemini: 0 });

    let report = usageReport(f.db, { days: 7, now: NOW });
    expect(report.totals).toEqual({ costUsd: 0.4312, inputTokens: 48_213, outputTokens: 1_902 });
    expect(report.members.map(m => [m.name, m.costUsd, m.inputTokens, m.outputTokens, m.providers])).toEqual([["시장 조사", 0.4312, 48_213, 1_902, ["gemini"]]]);
    expect(report.daily.map(d => [d.day, d.costUsd])).toEqual([[localDay(NOW), 0.4312]]);
    expect(report.limits.map(l => [l.provider, l.window, l.windowMinutes, l.usedPct, l.resetsAt]))
      .toEqual([["gemini", "gemini-pro", null, 18, new Date(NOW + 5 * HOUR).toISOString()]]);

    // 같은 대화가 이어졌다: 늘어난 몫만 더한다.
    f.status(f.gemini.id, NOW - 30_000, { cost: { total_usd: 1 }, context_window: { total_input_tokens: 60_000, total_output_tokens: 2_500 },
      quota: { "gemini-pro": { remaining_fraction: 0.75, reset_time: new Date(NOW + 5 * HOUR).toISOString() } } });
    expect(collector.tick(NOW + 2000)).toMatchObject({ gemini: 1 });
    report = usageReport(f.db, { days: 7, now: NOW });
    expect(report.totals).toEqual({ costUsd: 1, inputTokens: 60_000, outputTokens: 2_500 });
    expect(report.limits.map(l => [l.window, l.usedPct])).toEqual([["gemini-pro", 25]]);
    // 다른 CLI 의 칸에는 아무것도 들어가지 않았다.
    expect(f.db.query("SELECT DISTINCT provider FROM usage_daily").all()).toEqual([{ provider: "gemini" }]);
    expect(f.db.query("SELECT DISTINCT provider FROM usage_sessions").all()).toEqual([{ provider: "gemini" }]);
  });

  test("서버가 아직 모르는 대화의 누적값은 넣지 않고(첫 몫을 잃지 않게) 한도만 남긴다. 서버가 알아낸 뒤에 넣는다", () => {
    const f = fixture();
    // 상태줄은 이미 대화 id 를 알려 줬지만, 서버는 아직 그 대화를 이 팀장의 세션으로 적지 않았다.
    f.status(f.gemini.id, NOW - 60_000);
    const collector = f.collector();
    expect(collector.tick(NOW)).toMatchObject({ gemini: 0 });
    expect(f.sessions()).toEqual([]);
    expect(f.limits()).toEqual([{ provider: "gemini", window_id: "gemini-pro", window_minutes: null, used_pct: 18, resets_at: new Date(NOW + 5 * HOUR).toISOString() }]);
    // 서버가 그 대화를 알아냈다. 기록 파일은 그대로여도 다음에 넣는다(읽은 것으로 표시하지 않았다).
    f.setSession(f.gemini.id, CONVERSATION);
    f.ledger.registerFreshSession("gemini", CONVERSATION, f.ref(f.gemini), NOW);
    expect(collector.tick(NOW + 1000)).toMatchObject({ gemini: 1 });
    expect(usageReport(f.db, { days: 1, now: NOW }).totals).toEqual({ costUsd: 0.4312, inputTokens: 48_213, outputTokens: 1_902 });
    expect(collector.tick(NOW + 2000)).toMatchObject({ gemini: 0 });
  });

  test("대화를 열기 전의 기록은 한도만 남긴다. 다른 팀장의 대화로 적힌 기록은 넣지 않는다", () => {
    const f = fixture();
    // 첫 팀장: 서버는 예전 대화를 알고 있지만, 지금 터미널은 아직 대화를 열지 않았다.
    f.setSession(f.gemini.id, CONVERSATION);
    f.status(f.gemini.id, NOW - 60_000, { session_id: "", conversation_id: "" });
    // 둘째 팀장의 기록이 첫 팀장의 대화 id 를 알려 준다: 둘째 팀장의 사용량으로 넣지 않는다.
    f.setSession(f.second.id, OTHER_CONVERSATION);
    f.status(f.second.id, NOW - 50_000, { session_id: CONVERSATION, conversation_id: CONVERSATION, quota: {} });
    const collector = f.collector();
    expect(collector.tick(NOW)).toMatchObject({ claude: 0, codex: 0, gemini: 0 });
    expect(f.sessions()).toEqual([]);
    expect(f.limits().map(row => (row as { window_id: string }).window_id)).toEqual(["gemini-pro"]);
    expect(usageReport(f.db, { days: 7, now: NOW }).members).toEqual([]);
    // 한도는 더 새로 본 값만 남는다.
    f.status(f.second.id, NOW - 40_000, { session_id: "", conversation_id: "", quota: { "gemini-pro": { remaining_fraction: 0.5 } } });
    collector.tick(NOW + 1000);
    expect(f.limits().map(row => (row as { used_pct: number }).used_pct)).toEqual([50]);
    f.status(f.gemini.id, NOW - 45_000, { session_id: "", conversation_id: "", quota: { "gemini-pro": { remaining_fraction: 0.9 } } });
    collector.tick(NOW + 2000);
    expect(f.limits().map(row => (row as { used_pct: number }).used_pct)).toEqual([50]);
  });

  test("처음 보는 대화(서버가 띄우지 않은 대화를 이어 연 것)의 첫 누적값은 기준값일 뿐이고, 그 뒤 늘어난 몫만 든다", () => {
    const f = fixture();
    f.setSession(f.gemini.id, CONVERSATION);
    f.status(f.gemini.id, NOW - 60_000, { cost: { total_usd: 40 }, context_window: { total_input_tokens: 9_000_000, total_output_tokens: 80_000 } });
    const collector = f.collector();
    expect(collector.tick(NOW)).toMatchObject({ gemini: 1 });
    expect(usageReport(f.db, { days: 7, now: NOW }).totals).toEqual({ costUsd: null, inputTokens: null, outputTokens: null });
    f.status(f.gemini.id, NOW - 30_000, { cost: { total_usd: 40.5 }, context_window: { total_input_tokens: 9_010_000, total_output_tokens: 80_400 } });
    expect(collector.tick(NOW + 1000)).toMatchObject({ gemini: 1 });
    expect(usageReport(f.db, { days: 7, now: NOW }).totals).toEqual({ costUsd: 0.5, inputTokens: 10_000, outputTokens: 400 });
  });

  test("Gemini 세션을 조용히 버리지 않는다: 지난 세션(CLI 를 바꾼 팀장)의 마지막 몫도 그 팀장에 든다", () => {
    const f = fixture();
    // Gemini 로 일하다 Claude 로 바꾼 팀장: 지금 세션은 Claude 것이고, Gemini 대화는 지난 세션 기록에 있다.
    f.history(f.gemini.id, "gemini", CONVERSATION);
    f.setCli(f.gemini.id, "claude");
    f.setSession(f.gemini.id, "claude-now");
    f.ledger.registerFreshSession("gemini", CONVERSATION, f.ref(f.gemini), NOW);
    f.status(f.gemini.id, NOW - 60_000);
    expect(f.collector().tick(NOW)).toMatchObject({ claude: 0, gemini: 1 });
    expect(usageReport(f.db, { days: 7, now: NOW }).members.map(m => [m.name, m.costUsd, m.providers])).toEqual([["시장 조사", 0.4312, ["gemini"]]]);
  });

  test("깨진 기록·링크·기한 밖 기록은 건너뛰고, Claude 상태줄 기록 읽기는 그대로다", () => {
    const f = fixture();
    f.setSession(f.gemini.id, CONVERSATION);
    f.setSession(f.second.id, OTHER_CONVERSATION);
    f.setSession(f.claude.id, "claude-now");
    for (const id of [CONVERSATION, OTHER_CONVERSATION]) f.ledger.registerFreshSession("gemini", id, f.ref(f.gemini), NOW);
    f.ledger.registerFreshSession("claude", "claude-now", f.ref(f.claude), NOW);
    // 깨진 기록.
    mkdirSync(dirname(geminiStatusPath(f.home, f.gemini.id)), { recursive: true });
    writeFileSync(geminiStatusPath(f.home, f.gemini.id), "{");
    // 다른 곳을 가리키는 링크는 따라가지 않는다.
    const outside = join(f.home, "outside.json");
    writeFileSync(outside, JSON.stringify(geminiStatusFromPayload(f.second.id, payload({ session_id: OTHER_CONVERSATION, conversation_id: OTHER_CONVERSATION }), new Date(NOW - 1000))));
    symlinkSync(outside, geminiStatusPath(f.home, f.second.id));
    // Claude 의 상태줄 기록은 같은 context 폴더에 있다(gemini 는 그 안의 폴더라 섞이지 않는다).
    writeFileSync(join(f.home, "context", "claude-now.json"), JSON.stringify({ session_id: "claude-now", at: NOW - 60_000, cost_usd: 1.5, input_tokens_total: 1000, output_tokens_total: 100 }));
    const collector = f.collector();
    expect(collector.tick(NOW)).toMatchObject({ claude: 1, codex: 0, gemini: 0 });
    expect(usageReport(f.db, { days: 7, now: NOW }).members.map(m => [m.name, m.costUsd, m.providers])).toEqual([["결제 연동", 1.5, ["claude"]]]);
    // 보존 기한(90일)보다 오래된 기록은 넣지 않는다.
    const old = NOW - 100 * 24 * HOUR;
    const path = geminiStatusPath(f.home, f.gemini.id);
    writeFileSync(path, JSON.stringify(geminiStatusFromPayload(f.gemini.id, payload(), new Date(old))));
    utimesSync(path, old / 1000, old / 1000);
    expect(collector.tick(NOW + 1000)).toMatchObject({ gemini: 0 });
    expect(f.limits()).toEqual([]);
  });
});

describe("장부", () => {
  test("새 세션의 비용 기준값: Claude·Gemini 는 0, 비용을 보고하지 않는 Codex 는 없음", () => {
    const f = fixture();
    f.ledger.registerFreshSession("claude", "s-claude", f.ref(f.claude), NOW);
    f.ledger.registerFreshSession("codex", "s-codex", f.ref(f.claude), NOW);
    f.ledger.registerFreshSession("gemini", "s-gemini", f.ref(f.gemini), NOW);
    expect(f.sessions().map(row => [(row as { provider: string }).provider, (row as { cost_usd: number | null }).cost_usd])).toEqual([["claude", 0], ["codex", null], ["gemini", 0]]);
  });

  test("한도만 남기기: 기한 밖·빈 목록은 받지 않고, 더 새로 본 값만 남긴다", () => {
    const f = fixture();
    const limit = (usedPct: number) => [{ window: "gemini-pro", windowMinutes: null, usedPct, resetsAt: null }];
    expect(f.ledger.recordLimits("gemini", [], NOW, NOW)).toBe(0);
    expect(f.ledger.recordLimits("gemini", limit(10), NOW - 100 * 24 * HOUR, NOW)).toBe(0);
    expect(f.ledger.recordLimits("gemini", limit(10), Number.NaN, NOW)).toBe(0);
    expect(f.ledger.recordLimits("gemini", limit(10), NOW - 60_000, NOW)).toBe(1);
    expect(f.ledger.recordLimits("gemini", limit(5), NOW - 120_000, NOW)).toBe(0);
    expect(f.ledger.recordLimits("gemini", limit(20), NOW - 30_000, NOW)).toBe(1);
    expect(f.limits()).toEqual([{ provider: "gemini", window_id: "gemini-pro", window_minutes: null, used_pct: 20, resets_at: null }]);
    // 다른 CLI 의 같은 이름 창과 섞이지 않는다.
    expect(f.ledger.recordLimits("codex", [{ window: "gemini-pro", windowMinutes: 300, usedPct: 1, resetsAt: null }], NOW - 1000, NOW)).toBe(1);
    expect(f.limits().map(row => [(row as { provider: string }).provider, (row as { used_pct: number }).used_pct])).toEqual([["codex", 1], ["gemini", 20]]);
  });
});
