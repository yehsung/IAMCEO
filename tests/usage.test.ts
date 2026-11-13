// T(F6) 사용량 보기: 상태줄 래퍼가 옮기는 CLI 보고값, Codex rollout 의 누적 토큰·한도, 늘어난 몫만 날짜별로 모으기, 보존 기한, GET /api/usage.
// 진짜 Claude·Codex 를 띄우지 않는다. 상태줄 기록과 rollout 은 임시 홈에 직접 쓰고, 래퍼는 임시 홈에서 /bin/cat 사용자 명령으로만 돌린다.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { USAGE_MAX_DAYS, type UsageReport } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, VERSION, type Config } from "../server/config.ts";
import { MIGRATIONS, openDb, USAGE_TABLES } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { readContextRecord, writeStatuslineWrapper } from "../server/runner/statusline.ts";
import { RECORD_RETENTION_MS } from "../server/storage-maintenance.ts";
import { Store } from "../server/store.ts";
import { localDay, parseClaudeUsageRecord, parseCodexUsageEvent, readCodexUsageFile, UsageCollector, UsageLedger, usageReport, type UsageSample } from "../server/usage.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const DAY = 86_400_000;
/** 시간대와 상관없이 날짜가 정해지도록 Mac 의 그날 정오로 잡는다. */
const noon = (month: number, day: number) => new Date(2026, month - 1, day, 12).getTime();
const NOW = noon(11, 13);

function temp(prefix: string): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }

function fixture() {
  const home = temp("iamceo-usage-");
  const db = openDb(join(home, "iamceo.db"));
  const store = new Store(db, new Bus());
  cleanups.push(() => db.close());
  const project = store.createProject({ name: "결제 앱", cwd: home });
  const other = store.createProject({ name: "홈페이지", cwd: home });
  const lead = store.createMember({ projectId: project.id, handle: "pay", name: "결제 연동", kind: "worker" });
  const codex = store.createMember({ projectId: project.id, handle: "cx", name: "정산 검토", kind: "worker", cli: "codex" });
  const web = store.createMember({ projectId: other.id, handle: "web", name: "화면 정리", kind: "worker" });
  const setSession = (memberId: string, sessionId: string) => db.query("UPDATE members SET session_id = ? WHERE id = ?").run(sessionId, memberId);
  const history = (memberId: string, cli: string, sessionId: string) => db.query(`INSERT INTO member_session_history (id, member_id, cli, backend, session_id, pane_id, generation, applied_config, archived_at, reason)
    VALUES (?, ?, ?, 'core', ?, NULL, 0, NULL, ?, 'fresh')`).run(`h_${sessionId}`, memberId, cli, sessionId, new Date(NOW).toISOString());
  const context = (sessionId: string, record: Record<string, unknown>, mtime?: number) => {
    mkdirSync(join(home, "context"), { recursive: true });
    const path = join(home, "context", `${sessionId}.json`);
    writeFileSync(path, JSON.stringify({ session_id: sessionId, model: "claude-opus-5-5", context_window_size: 1_000_000, used_percentage: 12, tokens: 120_000, ...record }));
    if (mtime !== undefined) utimesSync(path, mtime / 1000, mtime / 1000);
  };
  return { home, db, store, project, other, lead, codex, web, setSession, history, context };
}

const claude = (sessionId: string, at: number, costUsd: number | null, inputTokens: number | null = null, outputTokens: number | null = null): UsageSample =>
  ({ provider: "claude", sessionId, at, costUsd, inputTokens, outputTokens, limits: [] });

describe("상태줄 래퍼가 CLI 보고값을 함께 옮긴다", () => {
  function wrapperRun(input: unknown) {
    const home = temp("iamceo usage wrapper's ");
    const project = join(home, "project"), user = join(home, "claude");
    mkdirSync(join(project, ".claude"), { recursive: true }); mkdirSync(user);
    writeFileSync(join(user, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "/bin/cat" } }));
    const wrapper = writeStatuslineWrapper(home, { managedSettingsPath: join(home, "managed.json") });
    return (async () => {
      const bytes = JSON.stringify(input);
      const proc = Bun.spawn(["/bin/sh", "-c", wrapper.command], { env: { ...process.env, CLAUDE_CONFIG_DIR: user }, cwd: project, stdin: new Blob([bytes]), stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(0); expect(stderr).toBe("");
      // 사용자 상태줄은 같은 바이트를 그대로 받는다.
      expect(stdout).toBe(bytes);
      return { home, record: JSON.parse(readFileSync(join(home, "context", "session-usage.json"), "utf8")) as Record<string, unknown> };
    })();
  }
  const base = { session_id: "session-usage", model: { id: "claude-opus-5-5" }, context_window: { context_window_size: 1_000_000, used_percentage: 12,
    current_usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 117_000, output_tokens: 10 } } };

  test("비용·누적 토큰·한도를 고치지 않고 옮기고, 문맥 기록은 예전 그대로다", async () => {
    const { home, record } = await wrapperRun({ ...base, cost: { total_cost_usd: 3.4521, total_duration_ms: 1000 },
      context_window: { ...base.context_window, total_input_tokens: 2_345_678, total_output_tokens: 45_678 },
      rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1_795_000_000 }, seven_day: { used_percentage: 41, resets_at: "2026-11-15T00:00:00Z" } } });
    expect(record).toMatchObject({ session_id: "session-usage", context_window_size: 1_000_000, used_percentage: 12, tokens: 120_000,
      cost_usd: 3.4521, input_tokens_total: 2_345_678, output_tokens_total: 45_678,
      rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1_795_000_000 }, seven_day: { used_percentage: 41, resets_at: "2026-11-15T00:00:00Z" } } });
    // 문맥을 읽는 쪽(실행기)이 보는 값은 그대로다.
    expect(readContextRecord(home, "session-usage")).toMatchObject({ context_window_size: 1_000_000, used_percentage: 12, tokens: 120_000 });
  });

  test("모양이 어긋난 값은 넣지 않는다(문맥 기록은 그대로 남는다)", async () => {
    const { record } = await wrapperRun({ ...base, cost: { total_cost_usd: -1 }, context_window: { ...base.context_window, total_input_tokens: 1.5, total_output_tokens: "9" },
      rate_limits: { five_hour: { used_percentage: 140 }, "Bad Name": { used_percentage: 3 }, seven_day: { used_percentage: 5, resets_at: { x: 1 } } } });
    expect(record.cost_usd).toBeUndefined();
    expect(record.input_tokens_total).toBeUndefined();
    expect(record.output_tokens_total).toBeUndefined();
    expect(record.rate_limits).toEqual({ seven_day: { used_percentage: 5, resets_at: null } });
    expect(record.context_window_size).toBe(1_000_000);
    const none = await wrapperRun(base);
    expect(Object.keys(none.record).sort()).toEqual(["at", "context_window_size", "model", "session_id", "tokens", "used_percentage"]);
  });
});

describe("수치 읽기", () => {
  test("상태줄 기록: 세션이 맞아야 하고, 이전 판 래퍼의 기록은 수치 없이 읽힌다. 한도 창은 아는 이름만", () => {
    expect(parseClaudeUsageRecord({ session_id: "a", at: NOW, cost_usd: 1.25, input_tokens_total: 10, output_tokens_total: 2,
      rate_limits: { five_hour: { used_percentage: 20, resets_at: 1_795_000_000 }, seven_day_opus: { used_percentage: 7, resets_at: null }, weird: { used_percentage: 1 } } }, "a"))
      .toEqual({ provider: "claude", sessionId: "a", at: NOW, costUsd: 1.25, inputTokens: 10, outputTokens: 2,
        limits: [{ window: "five_hour", windowMinutes: 300, usedPct: 20, resetsAt: new Date(1_795_000_000_000).toISOString() }, { window: "seven_day_opus", windowMinutes: 10_080, usedPct: 7, resetsAt: null }] });
    expect(parseClaudeUsageRecord({ session_id: "a", at: NOW, context_window_size: 200_000 }, "a")).toMatchObject({ costUsd: null, inputTokens: null, outputTokens: null, limits: [] });
    expect(parseClaudeUsageRecord({ session_id: "b", at: NOW }, "a")).toBeNull();
    expect(parseClaudeUsageRecord({ session_id: "a" }, "a")).toBeNull();
  });

  test("Codex token_count: 누적 토큰과 한도만 읽고 비용은 없다", () => {
    const event = parseCodexUsageEvent({ timestamp: "2026-11-13T03:00:00.000Z", type: "event_msg", payload: { type: "token_count",
      info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 400, output_tokens: 100, total_tokens: 1000 }, last_token_usage: { total_tokens: 50 }, model_context_window: 272_000 },
      rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 40, window_minutes: 10_080, resets_at: 1_795_000_000 } } } });
    expect(event).toEqual({ at: Date.parse("2026-11-13T03:00:00.000Z"), inputTokens: 900, outputTokens: 100, limits: [
      { window: "primary", windowMinutes: 300, usedPct: 12.5, resetsAt: "2026-11-13T04:00:00.000Z" },
      { window: "secondary", windowMinutes: 10_080, usedPct: 40, resetsAt: new Date(1_795_000_000_000).toISOString() }] });
    expect(parseCodexUsageEvent({ type: "event_msg", payload: { type: "token_count", info: null } })).toBeNull();
    expect(parseCodexUsageEvent({ type: "event_msg", payload: { type: "agent_message" } })).toBeNull();
  });

  test("Codex rollout: 처음엔 세션 확인과 끝부분, 그다음엔 새로 쓴 사건만 읽는다", () => {
    const home = temp("iamceo-usage-codex-");
    const dir = join(home, "sessions", "2026", "11", "13"); mkdirSync(dir, { recursive: true });
    const id = "0199aaaa-bbbb-cccc-dddd-eeeeffff0001";
    const path = join(dir, `rollout-2026-11-13T10-00-00-${id}.jsonl`);
    const tokenCount = (input: number, output: number, at: string) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output } } } });
    writeFileSync(path, [JSON.stringify({ type: "session_meta", payload: { id, cwd: home, source: "cli" } }), " ".repeat(2048), tokenCount(100, 10, "2026-11-13T01:00:00Z"), tokenCount(300, 30, "2026-11-13T02:00:00Z")].join("\n") + "\n");
    const root = join(home, "sessions");
    const first = readCodexUsageFile(root, path, id, null);
    expect(first.sample).toMatchObject({ provider: "codex", sessionId: id, costUsd: null, inputTokens: 300, outputTokens: 30, at: Date.parse("2026-11-13T02:00:00Z") });
    expect(readCodexUsageFile(root, path, id, first.cursor).sample).toBeNull();
    writeFileSync(path, tokenCount(500, 50, "2026-11-13T03:00:00Z") + "\n", { flag: "a" });
    expect(readCodexUsageFile(root, path, id, first.cursor).sample).toMatchObject({ inputTokens: 500, outputTokens: 50 });
    // 다른 세션의 기록이면 읽지 않는다.
    expect(readCodexUsageFile(root, path, "0199aaaa-bbbb-cccc-dddd-eeeeffff0002", null)).toEqual({ sample: null, cursor: null });
  });
});

describe("늘어난 몫만 날짜별로", () => {
  test("누적값의 증가분만 더하고, 줄면 새로 센 것으로 보고, 같거나 오래된 표본·기한 밖 표본은 버린다", () => {
    const f = fixture();
    const ledger = new UsageLedger(f.db);
    const member = { id: f.lead.id, projectId: f.project.id, name: f.lead.name, kind: f.lead.kind };
    expect(ledger.ingest(claude("s1", noon(11, 12), 2.0, 1000, 100), member, NOW)).toBe(true);
    expect(ledger.ingest(claude("s1", noon(11, 12) + 60_000, 2.5, 1500, 150), member, NOW)).toBe(true);
    expect(ledger.ingest(claude("s1", noon(11, 12) + 60_000, 9.9, 9999, 999), member, NOW)).toBe(false);
    expect(ledger.ingest(claude("s1", noon(11, 12), 9.9), member, NOW)).toBe(false);
    // 다음 날: 세션을 다시 열어 CLI 가 0 부터 셌다.
    expect(ledger.ingest(claude("s1", noon(11, 13), 0.4, 200, 20), member, NOW)).toBe(true);
    // 수치가 그대로인 갱신은 날짜 칸을 바꾸지 않는다.
    expect(ledger.ingest(claude("s1", noon(11, 13) + 1000, 0.4, 200, 20), member, NOW)).toBe(true);
    expect(ledger.ingest(claude("old", NOW - RECORD_RETENTION_MS - DAY, 5), member, NOW)).toBe(false);
    const rows = f.db.query("SELECT day, cost_usd, input_tokens, output_tokens, samples FROM usage_daily ORDER BY day").all();
    expect(rows).toEqual([
      { day: localDay(noon(11, 12)), cost_usd: 2.5, input_tokens: 1500, output_tokens: 150, samples: 2 },
      { day: localDay(noon(11, 13)), cost_usd: 0.4, input_tokens: 200, output_tokens: 20, samples: 1 },
    ]);
    expect(f.db.query("SELECT count(*) AS n FROM usage_sessions WHERE session_id = 'old'").get()).toEqual({ n: 0 });
  });

  test("비용을 보고하지 않는 기록(Codex·이전 판 래퍼)은 비용 칸을 비워 둔다. 한도는 더 새 값만 남는다", () => {
    const f = fixture();
    const ledger = new UsageLedger(f.db);
    const member = { id: f.codex.id, projectId: f.project.id, name: f.codex.name, kind: f.codex.kind };
    ledger.ingest({ provider: "codex", sessionId: "c1", at: NOW - 1000, costUsd: null, inputTokens: 900, outputTokens: 100, limits: [{ window: "primary", windowMinutes: 300, usedPct: 30, resetsAt: null }] }, member, NOW);
    ledger.ingest({ provider: "codex", sessionId: "c2", at: NOW - 5000, costUsd: null, inputTokens: 10, outputTokens: 1, limits: [{ window: "primary", windowMinutes: 300, usedPct: 10, resetsAt: null }] }, member, NOW);
    expect(f.db.query("SELECT cost_usd, input_tokens, output_tokens FROM usage_daily").get()).toEqual({ cost_usd: null, input_tokens: 910, output_tokens: 101 });
    expect(f.db.query("SELECT used_pct FROM usage_limits WHERE provider = 'codex' AND window_id = 'primary'").get()).toEqual({ used_pct: 30 });
  });
});

describe("모으기", () => {
  test("지금·지난 세션의 상태줄 기록과 Codex rollout 을 팀장에 잇고, 모르는 세션은 넣지 않는다. 그대로인 기록은 다시 읽지 않는다", () => {
    const f = fixture();
    const codexHome = temp("iamceo-usage-codexhome-");
    f.setSession(f.lead.id, "lead-now");
    f.history(f.lead.id, "claude", "lead-old");
    f.setSession(f.web.id, "web-now");
    const codexId = "0199aaaa-bbbb-cccc-dddd-eeeeffff0003";
    f.setSession(f.codex.id, codexId);
    f.context("lead-now", { at: NOW - 60_000, cost_usd: 1.5, input_tokens_total: 1000, output_tokens_total: 100, rate_limits: { five_hour: { used_percentage: 22, resets_at: (NOW + 3_600_000) / 1000 } } });
    f.context("lead-old", { at: noon(11, 10), cost_usd: 4 });
    f.context("web-now", { at: NOW - 30_000, cost_usd: 0.25 });
    f.context("stranger", { at: NOW - 1000, cost_usd: 99 });
    const dir = join(codexHome, "sessions", "2026", "11", "13"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-11-13T09-00-00-${codexId}.jsonl`), [JSON.stringify({ type: "session_meta", payload: { id: codexId, cwd: f.home, source: "cli" } }),
      JSON.stringify({ timestamp: new Date(NOW - 10_000).toISOString(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 5000, output_tokens: 700 } },
        rate_limits: { primary: { used_percent: 18, window_minutes: 300 } } } })].join("\n") + "\n");
    const collector = new UsageCollector({ db: f.db, home: f.home, codexHome, now: () => NOW });
    expect(collector.tick(NOW)).toMatchObject({ claude: 3, codex: 1 });
    // 같은 기록은 다시 넣지 않는다.
    expect(collector.tick(NOW + 1000)).toMatchObject({ claude: 0, codex: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM usage_sessions WHERE session_id = 'stranger'").get()).toEqual({ n: 0 });

    const report = usageReport(f.db, { days: 7, now: NOW });
    expect(report.totals).toEqual({ costUsd: 5.75, inputTokens: 6000, outputTokens: 800 });
    expect(report.members.map(m => [m.name, m.costUsd, m.inputTokens, m.providers])).toEqual([
      ["결제 연동", 5.5, 1000, ["claude"]], ["화면 정리", 0.25, null, ["claude"]], ["정산 검토", null, 5000, ["codex"]]]);
    expect(report.projects.map(p => [p.name, p.costUsd, p.members])).toEqual([["결제 앱", 5.5, 2], ["홈페이지", 0.25, 1]]);
    expect(report.daily.map(d => [d.day, d.costUsd])).toEqual([[localDay(noon(11, 10)), 4], [localDay(NOW), 1.75]]);
    expect(report.limits.map(l => [l.provider, l.window, l.windowMinutes, l.usedPct])).toEqual([["claude", "five_hour", 300, 22], ["codex", "primary", 300, 18]]);

    // 새 기록이 오면 늘어난 몫만 더한다.
    f.context("lead-now", { at: NOW + 60_000, cost_usd: 2, input_tokens_total: 1600, output_tokens_total: 160 });
    expect(collector.tick(NOW + 120_000)).toMatchObject({ claude: 1 });
    expect(usageReport(f.db, { days: 1, now: NOW }).members.find(m => m.memberId === f.lead.id)).toMatchObject({ costUsd: 2, inputTokens: 1600, outputTokens: 160 });
  });

  test("닫은 팀장의 사용량은 이름과 함께 남고, 프로젝트를 지우면 함께 지워진다", () => {
    const f = fixture();
    f.setSession(f.web.id, "web-now");
    f.context("web-now", { at: NOW - 1000, cost_usd: 0.75 });
    new UsageCollector({ db: f.db, home: f.home, codexHome: null }).tick(NOW);
    f.store.removeMember(f.web.id);
    const report = usageReport(f.db, { days: 1, now: NOW });
    expect(report.members).toEqual([expect.objectContaining({ memberId: f.web.id, name: "화면 정리", removed: true, costUsd: 0.75 })]);
    f.db.query("UPDATE projects SET archived = 1 WHERE id = ?").run(f.other.id);
    f.store.deleteArchivedProject(f.other.id);
    expect(f.db.query("SELECT count(*) AS n FROM usage_daily").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM usage_sessions").get()).toEqual({ n: 0 });
  });

  test("보존 기한: 90일 지난 칸·기준값·한도를 지우고, 디스크에 남은 옛 기록이 다시 들어오지 않는다", () => {
    const f = fixture();
    f.setSession(f.lead.id, "lead-now");
    f.history(f.lead.id, "claude", "lead-ancient");
    const ancient = NOW - RECORD_RETENTION_MS - 3 * DAY;
    const ledger = new UsageLedger(f.db);
    const member = { id: f.lead.id, projectId: f.project.id, name: f.lead.name, kind: f.lead.kind };
    ledger.ingest(claude("lead-ancient", NOW - 10 * DAY, 3), member, NOW - 10 * DAY);
    ledger.ingest({ ...claude("lead-now", NOW - 10 * DAY, 1), limits: [{ window: "seven_day", windowMinutes: 10_080, usedPct: 50, resetsAt: null }] }, member, NOW - 10 * DAY);
    // 100일 뒤로 간다.
    const later = NOW + 90 * DAY;
    expect(ledger.prune(later)).toEqual({ days: 1, sessions: 1, limits: 1 });
    // 지금 팀장이 쓰는 세션의 기준값은 남는다(다음 증가분을 셀 기준).
    expect(f.db.query("SELECT session_id FROM usage_sessions").all()).toEqual([{ session_id: "lead-now" }]);
    f.context("lead-ancient", { at: ancient, cost_usd: 3 }, ancient);
    expect(new UsageCollector({ db: f.db, home: f.home, codexHome: null }).tick(NOW)).toMatchObject({ claude: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM usage_daily WHERE day < ?").get(localDay(NOW - RECORD_RETENTION_MS))).toEqual({ n: 0 });
  });
});

describe("보고", () => {
  test("기간·프로젝트로 거르고, 큰 것부터. 지난 한도와 오래 못 본 한도는 싣지 않는다", () => {
    const f = fixture();
    const ledger = new UsageLedger(f.db);
    const lead = { id: f.lead.id, projectId: f.project.id, name: f.lead.name, kind: f.lead.kind };
    const web = { id: f.web.id, projectId: f.other.id, name: f.web.name, kind: f.web.kind };
    ledger.ingest(claude("a", noon(11, 1), 10), lead, NOW);
    ledger.ingest(claude("a", noon(11, 13), 10.1), lead, NOW);
    ledger.ingest(claude("b", noon(11, 12), 0.3), web, NOW);
    f.db.query("INSERT INTO usage_limits (provider, window_id, window_minutes, used_pct, resets_at, observed_at) VALUES (?, ?, ?, ?, ?, ?)").run("claude", "five_hour", 300, 80, new Date(NOW - 1000).toISOString(), new Date(NOW - 2000).toISOString());
    f.db.query("INSERT INTO usage_limits (provider, window_id, window_minutes, used_pct, resets_at, observed_at) VALUES (?, ?, ?, ?, ?, ?)").run("claude", "seven_day", 10_080, 40, null, new Date(NOW - 8 * DAY).toISOString());
    f.db.query("INSERT INTO usage_limits (provider, window_id, window_minutes, used_pct, resets_at, observed_at) VALUES (?, ?, ?, ?, ?, ?)").run("claude", "seven_day_opus", 10_080, 12, new Date(NOW + DAY).toISOString(), new Date(NOW - 60_000).toISOString());

    const week = usageReport(f.db, { days: 7, now: NOW });
    expect(week).toMatchObject({ days: 7, from: localDay(noon(11, 7)), to: localDay(NOW), projectId: null, retentionDays: 90 });
    expect(week.members.map(m => [m.name, m.costUsd])).toEqual([["화면 정리", 0.3], ["결제 연동", 0.1]]);
    expect(week.totals.costUsd).toBe(0.4);
    expect(week.limits.map(l => l.window)).toEqual(["seven_day_opus"]);
    const month = usageReport(f.db, { days: 30, now: NOW });
    expect(month.members.map(m => [m.name, m.costUsd])).toEqual([["결제 연동", 10.1], ["화면 정리", 0.3]]);
    expect(month.daily.map(d => d.day)).toEqual([localDay(noon(11, 1)), localDay(noon(11, 12)), localDay(noon(11, 13))]);
    const one = usageReport(f.db, { days: 30, now: NOW, projectId: f.other.id });
    expect(one.members.map(m => m.name)).toEqual(["화면 정리"]);
    expect(one.projects.map(p => p.name)).toEqual(["홈페이지"]);
    expect(usageReport(f.db, { days: 999, now: NOW }).days).toBe(USAGE_MAX_DAYS);
  });
});

describe("DB: 이전 판이 그대로 연다", () => {
  test("사용량 표는 판 번호를 올리지 않고 만들고, 다시 열어도 그대로다", () => {
    const home = temp("iamceo-usage-db-");
    const path = join(home, "iamceo.db");
    let db: Database = openDb(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    for (const name of ["usage_daily", "usage_sessions", "usage_limits"]) expect(db.query("SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name)).toEqual({ ok: 1 });
    db.close();
    db = openDb(path);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    db.close();
    // 표·열을 지우거나 이름을 바꾸는 문장이 없다.
    for (const sql of USAGE_TABLES) expect(sql).toMatch(/^\s*CREATE (TABLE|INDEX) IF NOT EXISTS/);
  });

  test("표가 없는 DB 에서도 보고는 비어 있을 뿐 실패하지 않는다", () => {
    const home = temp("iamceo-usage-nodb-");
    const db = openDb(join(home, "iamceo.db"));
    cleanups.push(() => db.close());
    for (const name of ["usage_daily", "usage_sessions", "usage_limits"]) db.exec(`DROP TABLE ${name}`);
    expect(usageReport(db, { days: 7, now: NOW })).toMatchObject({ totals: { costUsd: null, inputTokens: null, outputTokens: null }, members: [], limits: [] });
    expect(new UsageLedger(db).ingest(claude("x", NOW, 1), { id: "m", projectId: "p", name: "n", kind: "worker" }, NOW)).toBe(false);
  });
});

// ---- GET /api/usage ----
function freshConfig(): Config {
  const home = temp("iamceo-usage-http-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  return { ...loadConfig(env), hosts: ["127.0.0.1"], hostsAuto: true };
}

async function boot() {
  const config = freshConfig();
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const orch = new Orchestrator({ config, store, runners: new Map(), notifier: () => {} });
  let refreshes = 0;
  const context = { config, store, bus, orch, detectHosts: () => [], daemon: () => ({ ready: true, buildId: "build", version: VERSION }), usage: { refresh: () => { refreshes++; } } };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); store.db.close(); });
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { Authorization: "Bearer code", ...init.headers } });
  return { config, store, server, request, refreshes: () => refreshes };
}

describe("GET /api/usage", () => {
  test("약속한 모양을 주고, 열 때 한 번 모은다", async () => {
    const t = await boot();
    const project = t.store.createProject({ name: "결제 앱", cwd: t.config.home });
    const member = t.store.createMember({ projectId: project.id, handle: "pay", name: "결제 연동", kind: "worker" });
    new UsageLedger(t.store.db).ingest(claude("s", Date.now() - 1000, 1.23, 100, 10), { id: member.id, projectId: project.id, name: member.name, kind: member.kind });
    const response = await t.request("/api/usage?days=7");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const report = await response.json() as UsageReport;
    expect(t.refreshes()).toBe(1);
    expect(Object.keys(report).sort()).toEqual(["daily", "days", "from", "generatedAt", "limits", "members", "projectId", "projects", "retentionDays", "timeZone", "to", "totals"]);
    expect(report.totals).toEqual({ costUsd: 1.23, inputTokens: 100, outputTokens: 10 });
    expect(report.members[0]).toEqual({ memberId: member.id, projectId: project.id, name: "결제 연동", kind: "worker", providers: ["claude"], removed: false,
      lastAt: expect.any(String), costUsd: 1.23, inputTokens: 100, outputTokens: 10 });
    expect((await (await t.request(`/api/usage?projectId=${project.id}`)).json() as UsageReport).days).toBe(7);
  });

  test("인증·검증: 기간은 1~90일, 모르는 조건·프로젝트는 거절", async () => {
    const t = await boot();
    expect((await fetch(`http://127.0.0.1:${t.server.port}/api/usage`)).status).toBe(401);
    for (const bad of ["days=0", "days=91", "days=abc", "days=7&days=7", "x=1", "days=-1", "days=1.5"]) {
      const response = await t.request(`/api/usage?${bad}`);
      expect(response.status).toBe(400);
      expect((await response.json() as { code: string }).code).toBe("invalid_query");
    }
    expect((await t.request("/api/usage?days=90")).status).toBe(200);
    const missing = await t.request("/api/usage?projectId=p_nope");
    expect(missing.status).toBe(404);
    expect((await missing.json() as { code: string }).code).toBe("project_not_found");
    expect((await t.request("/api/usage", { method: "POST" })).status).toBe(405);
  });
});
