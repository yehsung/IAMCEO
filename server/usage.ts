// T(F6): 사용량 보기. CLI 가 스스로 보고한 수치만 모아 팀장·프로젝트·날짜별로 보인다. 비용을 추정하거나 토큰으로 계산하지 않는다.
//
// 어디서 읽나
// - Claude Code: 상태줄 래퍼(runner/statusline.ts)가 세션마다 `<홈>/context/<세션>.json` 에 남기는 기록. CLI 가 상태줄에 넘긴
//   세션 누적 비용(cost.total_cost_usd)·누적 토큰(context_window.total_input/output_tokens)·계정 한도 사용률(rate_limits)을 그대로 옮긴 것이다.
// - Codex: 그 세션의 rollout 기록(`<CODEX_HOME>/sessions/**/rollout-*-<세션>.jsonl`)의 token_count 사건. 누적 토큰(total_token_usage)과
//   한도 사용률(rate_limits)만 있다. Codex 는 비용을 보고하지 않으므로 비용은 늘 없음(null)이다.
//
// 어떻게 모으나
// - 둘 다 세션 누적값이다. 세션마다 마지막으로 본 누적값(usage_sessions)을 기준으로 늘어난 몫만 그 수치를 본 날의 칸(usage_daily)에 더한다.
//   누적값이 줄었으면(세션을 다시 열어 CLI 가 0 부터 셌다) 새 값 전체를 늘어난 몫으로 본다.
// - 처음 보는 세션은 그때의 누적값 전체를 그 기록의 시각이 속한 날에 넣는다(이 기능 전에 쓴 몫도 그날로 들어간다).
// - 날짜는 서버가 도는 Mac 의 시간대로 나눈다. 1분마다 모으므로 자정 무렵 몫은 다음 날로 넘어갈 수 있다(보고 화면이 그렇게 적는다).
// - 팀장을 닫아도 사용량은 남긴다(이름을 함께 적어 둔다). 프로젝트를 지우면 함께 지운다(ON DELETE CASCADE, db.ts USAGE_TABLES).
// - 보존 기한은 안쪽 기록과 같은 90일(RECORD_RETENTION_MS)이다. 그보다 오래된 기록은 모으지도 않는다(지운 뒤 다시 들어오지 않게).
import type { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { USAGE_MAX_DAYS, type CliProvider, type MemberKind, type UsageAmounts, type UsageDayRow, type UsageLimitWindow, type UsageMemberRow, type UsageProjectRow, type UsageReport } from "../shared/types.ts";
import { CONTEXT_SESSION_RE, writeStatuslineWrapper } from "./runner/statusline.ts";
import { jsonObject, parseCodexSessionMeta, readJsonlRange, type JsonlCursor } from "./runner/delivery-evidence.ts";
import { RECORD_RETENTION_MS } from "./storage-maintenance.ts";

/** 모으는 간격. 앱이 사용량을 열면 그때도 한 번 모은다(5초 안에 다시 모으지는 않는다). */
export const USAGE_TICK_MS = 60_000;
const REFRESH_MIN_MS = 5_000;
/** 정리(보존 기한)는 한 시간에 한 번. */
const PRUNE_EVERY_MS = 3_600_000;
/** 이보다 오래 못 본 한도 사용률은 보고에 싣지 않는다. */
const LIMIT_STALE_MS = 7 * 86_400_000;
/** Codex 세션 기록을 찾는 폴더 훑기: 못 찾은 세션이 있을 때만, 10분에 한 번, 세션마다 세 번까지(그 뒤는 서버를 다시 시작할 때까지 쉰다). */
const CODEX_SCAN_EVERY_MS = 600_000;
const CODEX_SCAN_TRIES = 3;
const TAIL_BYTES = 1024 * 1024;

export interface UsageLimitSample { window: string; windowMinutes: number | null; usedPct: number; resetsAt: string | null }
/** 세션 하나의 한 시점 누적값. 없는 값은 null(그 CLI 가 보고하지 않았다). */
export interface UsageSample {
  provider: CliProvider;
  sessionId: string;
  /** 그 값을 CLI 가 남긴 시각(ms). */
  at: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  limits: UsageLimitSample[];
}
export interface UsageMemberRef { id: string; projectId: string; name: string; kind: string }

// ---- 값 모양 ----
const amount = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const percent = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;

/** 초·밀리초 숫자나 ISO 글자를 ISO 로. 2001년~2200년 밖이면 버린다. */
function isoTime(value: unknown): string | null {
  let ms: number | null = null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) ms = value < 1e12 ? value * 1000 : value;
  else if (typeof value === "string" && value.length <= 40) { const parsed = Date.parse(value); ms = Number.isFinite(parsed) ? parsed : null; }
  return ms !== null && ms > 978_307_200_000 && ms < 7_258_118_400_000 ? new Date(ms).toISOString() : null;
}

/** Claude 의 한도 창 이름. five_hour·seven_day 와 그 뒤에 모델 이름이 붙은 것(seven_day_opus 등)만 받는다. */
const CLAUDE_WINDOW = /^(five_hour|seven_day)(_[a-z]{1,20})?$/;
function claudeLimits(raw: unknown): UsageLimitSample[] {
  const windows = jsonObject(raw);
  if (!windows) return [];
  const out: UsageLimitSample[] = [];
  for (const [name, value] of Object.entries(windows)) {
    const match = CLAUDE_WINDOW.exec(name);
    const w = jsonObject(value);
    const used = percent(w?.used_percentage);
    if (!match || used === null) continue;
    out.push({ window: name, windowMinutes: match[1] === "five_hour" ? 300 : 10_080, usedPct: used, resetsAt: isoTime(w?.resets_at) });
    if (out.length >= 6) break;
  }
  return out;
}

/** 상태줄 래퍼가 남긴 기록 하나. 세션이 맞지 않거나 시각이 없으면 버린다. 이전 판 래퍼의 기록은 수치 없이(null) 읽힌다. */
export function parseClaudeUsageRecord(raw: unknown, sessionId: string): UsageSample | null {
  const r = jsonObject(raw);
  if (!r || r.session_id !== sessionId || typeof r.at !== "number" || !Number.isFinite(r.at) || r.at <= 0) return null;
  return { provider: "claude", sessionId, at: r.at, costUsd: amount(r.cost_usd), inputTokens: count(r.input_tokens_total), outputTokens: count(r.output_tokens_total), limits: claudeLimits(r.rate_limits) };
}

/** Codex token_count 사건 하나. 누적 토큰(total_token_usage)과 한도(rate_limits)만 읽는다. 직전 요청의 토큰(last_token_usage)은 문맥용이라 쓰지 않는다. */
export function parseCodexUsageEvent(value: unknown): { at: number | null; inputTokens: number | null; outputTokens: number | null; limits: UsageLimitSample[] } | null {
  const entry = jsonObject(value), payload = jsonObject(entry?.payload);
  if (entry?.type !== "event_msg" || payload?.type !== "token_count") return null;
  const total = jsonObject(jsonObject(payload.info)?.total_token_usage);
  const parsedAt = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  const at = Number.isFinite(parsedAt) ? parsedAt : null;
  const rate = jsonObject(payload.rate_limits) ?? jsonObject(jsonObject(payload.info)?.rate_limits);
  const limits: UsageLimitSample[] = [];
  for (const name of ["primary", "secondary"] as const) {
    const w = jsonObject(rate?.[name]);
    const used = percent(w?.used_percent ?? w?.used_percentage);
    if (used === null) continue;
    const minutes = count(w?.window_minutes);
    const resetsIn = count(w?.resets_in_seconds);
    const resetsAt = isoTime(w?.resets_at) ?? (resetsIn !== null && at !== null ? new Date(at + resetsIn * 1000).toISOString() : null);
    limits.push({ window: name, windowMinutes: minutes !== null && minutes > 0 ? minutes : null, usedPct: used, resetsAt });
  }
  const inputTokens = count(total?.input_tokens), outputTokens = count(total?.output_tokens);
  if (inputTokens === null && outputTokens === null && limits.length === 0) return null;
  return { at, inputTokens, outputTokens, limits };
}

export interface CodexUsageCursor { path: string; sessionId: string; log: JsonlCursor }
/**
 * Codex rollout 에서 새로 쓰인 token_count 만 읽는다. 처음에는 머리(세션 확인)와 끝 1MiB, 그다음부터는 새로 쓰인 바이트만 1MiB 씩.
 * 새 사건이 없으면 표본은 null 이다(같은 값을 다시 넣지 않는다).
 */
export function readCodexUsageFile(root: string, path: string, sessionId: string, previous: CodexUsageCursor | null, now = Date.now()): { sample: UsageSample | null; cursor: CodexUsageCursor | null } {
  if (!CONTEXT_SESSION_RE.test(sessionId)) return { sample: null, cursor: null };
  if (previous && (previous.path !== path || previous.sessionId !== sessionId)) previous = null;
  let range = previous ? readJsonlRange(root, path, previous.log, { maxBytes: TAIL_BYTES }) : null;
  if (range && range.code === "file_changed") { previous = null; range = null; }
  if (!range) {
    const head = readJsonlRange(root, path, null, { maxBytes: TAIL_BYTES });
    const meta = parseCodexSessionMeta(head.records[0]?.value);
    if (!meta || meta.sessionId !== sessionId || head.records[0]?.start !== 0 || !head.cursor) return { sample: null, cursor: null };
    let start = 0;
    let fd: number;
    try { fd = openSync(head.cursor.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { return { sample: null, cursor: null }; }
    try {
      const stat = fstatSync(fd);
      if (`${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== head.cursor.fileIdentity) return { sample: null, cursor: null };
      start = Math.max(0, stat.size - TAIL_BYTES);
      if (start) {
        const bytes = Buffer.alloc(Math.min(TAIL_BYTES, stat.size - start));
        const length = readSync(fd, bytes, 0, bytes.length, start);
        const newline = bytes.subarray(0, length).indexOf(10);
        if (newline < 0) return { sample: null, cursor: null };
        start += newline + 1;
      }
    } finally { closeSync(fd); }
    range = readJsonlRange(root, path, null, { maxBytes: TAIL_BYTES, startOffset: start, fileIdentity: head.cursor.fileIdentity });
  }
  if (!range.cursor) return { sample: null, cursor: previous };
  let latest: ReturnType<typeof parseCodexUsageEvent> = null;
  for (const record of range.records) {
    const parsed = parseCodexUsageEvent(record.value);
    if (parsed) latest = parsed;
  }
  const cursor = { path, sessionId, log: range.cursor };
  if (!latest) return { sample: null, cursor };
  return { cursor, sample: { provider: "codex", sessionId, at: latest.at ?? now, costUsd: null, inputTokens: latest.inputTokens, outputTokens: latest.outputTokens, limits: latest.limits } };
}

// ---- 날짜 ----
const pad = (n: number) => String(n).padStart(2, "0");
/** 서버가 도는 Mac 의 시간대로 본 날짜(YYYY-MM-DD). */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayBefore(ms: number, days: number): string {
  const d = new Date(ms);
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - days, 12).getTime());
}

// ---- 저장 ----
type Row = Record<string, unknown>;
function tablesReady(db: Database): boolean {
  try {
    const row = db.query("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name IN ('usage_daily','usage_sessions','usage_limits')").get() as { n: number } | null;
    return row?.n === 3;
  } catch { return false; }
}

export class UsageLedger {
  private ready: boolean | null = null;
  constructor(private readonly db: Database) {}

  available(): boolean {
    if (this.ready !== true) this.ready = tablesReady(this.db);
    return this.ready;
  }

  /**
   * 표본 하나를 넣는다. 늘어난 몫이 있으면 그날 칸에 더하고, 세션의 기준값과 계정 한도를 고친다.
   * 같은 세션의 더 오래된(또는 같은 시각의) 표본, 보존 기한보다 오래된 표본은 넣지 않는다. 넣었으면 참.
   */
  ingest(sample: UsageSample, member: UsageMemberRef, now = Date.now(), retentionMs = RECORD_RETENTION_MS): boolean {
    if (!this.available() || !Number.isFinite(sample.at) || sample.at < now - retentionMs) return false;
    return this.db.transaction(() => {
      const prev = this.db.query("SELECT cost_usd, input_tokens, output_tokens, sample_at FROM usage_sessions WHERE provider = ? AND session_id = ?").get(sample.provider, sample.sessionId) as Row | null;
      if (prev && sample.at <= (prev.sample_at as number)) return false;
      const grown = (current: number | null, before: unknown): number | null => {
        if (current === null) return null;
        if (typeof before !== "number") return current;
        return current >= before ? current - before : current;
      };
      const cost = grown(sample.costUsd, prev?.cost_usd), input = grown(sample.inputTokens, prev?.input_tokens), output = grown(sample.outputTokens, prev?.output_tokens);
      const at = Math.min(sample.at, now);
      const atIso = new Date(at).toISOString(), nowIso = new Date(now).toISOString();
      if ([cost, input, output].some(value => value !== null && value > 0)) {
        this.db.query(`INSERT INTO usage_daily (day, member_id, provider, project_id, member_name, member_kind, cost_usd, input_tokens, output_tokens, samples, last_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(day, member_id, provider) DO UPDATE SET
            project_id = excluded.project_id, member_name = excluded.member_name, member_kind = excluded.member_kind,
            cost_usd = CASE WHEN excluded.cost_usd IS NULL THEN usage_daily.cost_usd ELSE COALESCE(usage_daily.cost_usd, 0) + excluded.cost_usd END,
            input_tokens = CASE WHEN excluded.input_tokens IS NULL THEN usage_daily.input_tokens ELSE COALESCE(usage_daily.input_tokens, 0) + excluded.input_tokens END,
            output_tokens = CASE WHEN excluded.output_tokens IS NULL THEN usage_daily.output_tokens ELSE COALESCE(usage_daily.output_tokens, 0) + excluded.output_tokens END,
            samples = usage_daily.samples + 1,
            last_at = MAX(usage_daily.last_at, excluded.last_at)`)
          .run(localDay(at), member.id, sample.provider, member.projectId, member.name, member.kind, cost, input, output, atIso);
      }
      this.db.query(`INSERT INTO usage_sessions (provider, session_id, member_id, project_id, cost_usd, input_tokens, output_tokens, sample_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, session_id) DO UPDATE SET
          member_id = excluded.member_id, project_id = excluded.project_id,
          cost_usd = COALESCE(excluded.cost_usd, usage_sessions.cost_usd),
          input_tokens = COALESCE(excluded.input_tokens, usage_sessions.input_tokens),
          output_tokens = COALESCE(excluded.output_tokens, usage_sessions.output_tokens),
          sample_at = excluded.sample_at, updated_at = excluded.updated_at`)
        .run(sample.provider, sample.sessionId, member.id, member.projectId, sample.costUsd, sample.inputTokens, sample.outputTokens, sample.at, nowIso);
      for (const limit of sample.limits) {
        this.db.query(`INSERT INTO usage_limits (provider, window_id, window_minutes, used_pct, resets_at, observed_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, window_id) DO UPDATE SET window_minutes = excluded.window_minutes, used_pct = excluded.used_pct,
            resets_at = excluded.resets_at, observed_at = excluded.observed_at
          WHERE excluded.observed_at > usage_limits.observed_at`)
          .run(sample.provider, limit.window, limit.windowMinutes, limit.usedPct, limit.resetsAt, atIso);
      }
      return true;
    })();
  }

  /**
   * 보존 기한(90일). 그보다 오래된 날의 칸, 그동안 수치가 없던 세션의 기준값(지금 팀장이 쓰는 세션은 남긴다), 그동안 못 본 한도를 지운다.
   * 지운 세션의 기록이 디스크에 남아 있어도 다시 들어오지 않는다: ingest 가 기한보다 오래된 표본을 받지 않는다.
   */
  prune(now = Date.now(), retentionMs = RECORD_RETENTION_MS): { days: number; sessions: number; limits: number } {
    if (!this.available()) return { days: 0, sessions: 0, limits: 0 };
    const cutoff = now - retentionMs;
    return this.db.transaction(() => ({
      days: this.db.query("DELETE FROM usage_daily WHERE day < ?").run(localDay(cutoff)).changes,
      sessions: this.db.query("DELETE FROM usage_sessions WHERE sample_at < ? AND session_id NOT IN (SELECT session_id FROM members WHERE session_id IS NOT NULL)").run(cutoff).changes,
      limits: this.db.query("DELETE FROM usage_limits WHERE observed_at < ?").run(new Date(cutoff).toISOString()).changes,
    }))();
  }
}

// ---- 모으기 ----
interface SessionMap { claude: Map<string, UsageMemberRef>; codex: Map<string, UsageMemberRef> }
/** 지금 세션과 지난 세션(member_session_history)을 팀장에 잇는다. 같은 세션이 겹치면 지금 세션이 먼저다. */
function sessionMap(db: Database): SessionMap {
  const map: SessionMap = { claude: new Map(), codex: new Map() };
  const put = (cli: unknown, sessionId: unknown, ref: UsageMemberRef, overwrite: boolean) => {
    if ((cli !== "claude" && cli !== "codex") || typeof sessionId !== "string" || !CONTEXT_SESSION_RE.test(sessionId)) return;
    if (overwrite || !map[cli].has(sessionId)) map[cli].set(sessionId, ref);
  };
  for (const r of db.query("SELECT h.cli, h.session_id, m.id, m.project_id, m.name, m.kind FROM member_session_history h JOIN members m ON m.id = h.member_id WHERE h.session_id IS NOT NULL").all() as Row[]) {
    put(r.cli, r.session_id, { id: r.id as string, projectId: r.project_id as string, name: r.name as string, kind: r.kind as string }, false);
  }
  for (const r of db.query("SELECT id, project_id, name, kind, cli, session_id FROM members WHERE session_id IS NOT NULL").all() as Row[]) {
    put(r.cli, r.session_id, { id: r.id as string, projectId: r.project_id as string, name: r.name as string, kind: r.kind as string }, true);
  }
  return map;
}

/** 앱이 사용량을 열 때 부르는 쪽(GET /api/usage). */
export interface UsageSource { refresh(): void }

export interface UsageCollectorOptions {
  db: Database;
  /** IAMCEO 홈(상태줄 기록은 `<홈>/context`). */
  home: string;
  /** Codex 홈. 없으면 CODEX_HOME 또는 ~/.codex(실행기가 Codex 를 띄우는 곳과 같다). null 이면 Codex 는 읽지 않는다. */
  codexHome?: string | null;
  intervalMs?: number;
  now?: () => number;
  retentionMs?: number;
  /** 서버의 지연 감시(LoopMonitor.run). */
  wrap?: <T>(name: string, work: () => T) => T;
  log?: (line: string) => void;
}
export interface UsageTickResult { claude: number; codex: number; pruned: { days: number; sessions: number; limits: number } | null }

export class UsageCollector implements UsageSource {
  private readonly ledger: UsageLedger;
  private readonly codexHome: string | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTick: ReturnType<typeof setTimeout> | null = null;
  private lastTick = -Infinity;
  private lastPrune = -Infinity;
  private failureLoggedAt = -Infinity;
  /** 상태줄 기록마다 마지막으로 읽은 수정 시각. 그대로면 다시 읽지 않는다(서버를 다시 띄우면 한 번씩 다시 읽고, 같은 표본은 ingest 가 버린다). */
  private readonly claudeSeen = new Map<string, number>();
  private readonly codexPaths = new Map<string, { path: string | null; tries: number }>();
  private nextCodexScan = -Infinity;
  private readonly codexCursors = new Map<string, CodexUsageCursor>();

  constructor(private readonly options: UsageCollectorOptions) {
    this.ledger = new UsageLedger(options.db);
    this.codexHome = options.codexHome === null ? null : options.codexHome ?? (process.env.CODEX_HOME || join(homedir(), ".codex"));
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  /**
   * 1분마다 모은다. 첫 모으기는 시작을 늦추지 않게 몇 초 뒤에 한다. 상태줄 래퍼 파일을 지금 판으로 맞춰 두어,
   * 다시 띄우지 않은 팀장의 상태줄도 다음 갱신부터 비용·한도를 남기게 한다(같은 내용이면 쓰지 않는다).
   */
  start(): void {
    if (this.timer) return;
    try { writeStatuslineWrapper(this.options.home); } catch { /* 다음에 팀장을 띄울 때 실행기가 다시 쓴다. */ }
    this.firstTick = setTimeout(() => { this.firstTick = null; this.safeTick(); }, 3_000);
    this.firstTick.unref?.();
    this.timer = setInterval(() => this.safeTick(), this.options.intervalMs ?? USAGE_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.firstTick) clearTimeout(this.firstTick);
    if (this.timer) clearInterval(this.timer);
    this.firstTick = null;
    this.timer = null;
  }

  refresh(): void {
    if (this.now() - this.lastTick < REFRESH_MIN_MS) return;
    this.safeTick();
  }

  private safeTick(): void {
    const run = () => {
      try { this.tick(); }
      catch (error) {
        const at = this.now();
        if (at - this.failureLoggedAt >= 600_000) {
          this.failureLoggedAt = at;
          (this.options.log ?? console.warn)(`[usage] 사용량을 모으지 못했습니다(다음에 다시 합니다): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    if (this.options.wrap) this.options.wrap("timer:usage", run); else run();
  }

  /** 한 번 모은다. 시험이 직접 부른다. */
  tick(now = this.now()): UsageTickResult {
    this.lastTick = now;
    const result: UsageTickResult = { claude: 0, codex: 0, pruned: null };
    if (!this.ledger.available()) return result;
    const retention = this.options.retentionMs ?? RECORD_RETENTION_MS;
    const sessions = sessionMap(this.options.db);
    result.claude = this.collectClaude(sessions.claude, now, retention);
    result.codex = this.collectCodex(sessions.codex, now, retention);
    if (now - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = now;
      result.pruned = this.ledger.prune(now, retention);
    }
    return result;
  }

  private collectClaude(sessions: Map<string, UsageMemberRef>, now: number, retention: number): number {
    const dir = join(this.options.home, "context");
    let names: string[];
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return 0;
      names = readdirSync(dir);
    } catch { return 0; }
    let ingested = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sessionId = name.slice(0, -5);
      const member = sessions.get(sessionId);
      if (!member || !CONTEXT_SESSION_RE.test(sessionId)) continue;
      try {
        const path = join(dir, name);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > 64 * 1024 || stat.mtimeMs < now - retention) continue;
        // 래퍼는 쓸 때마다 새 파일로 바꿔 넣는다(rename). 수정 시각이 그대로면 같은 기록이다.
        if (this.claudeSeen.get(sessionId) === stat.mtimeMs) continue;
        const sample = parseClaudeUsageRecord(JSON.parse(readFileSync(path, "utf8")), sessionId);
        if (sample && this.ledger.ingest(sample, member, now, retention)) ingested++;
        // 넣다가 실패하면(DB 잠김 등) 표시하지 않아 다음에 다시 읽는다.
        this.claudeSeen.set(sessionId, stat.mtimeMs);
      } catch { /* 쓰는 도중이거나 깨진 기록: 다음에 다시 본다. */ }
    }
    return ingested;
  }

  private collectCodex(sessions: Map<string, UsageMemberRef>, now: number, retention: number): number {
    if (!this.codexHome || sessions.size === 0) return 0;
    const root = join(this.codexHome, "sessions");
    const missing = [...sessions.keys()].filter(id => { const known = this.codexPaths.get(id); return !known?.path && (known?.tries ?? 0) < CODEX_SCAN_TRIES; });
    if (missing.length && now >= this.nextCodexScan) {
      this.nextCodexScan = now + CODEX_SCAN_EVERY_MS;
      const wanted = new Set(missing);
      const found = new Map<string, string[]>();
      try {
        for (const path of new Bun.Glob("**/rollout-*.jsonl").scanSync({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false })) {
          // rollout-<시각>-<세션>.jsonl: 세션 ID 자체에 '-' 가 들어 있으니 끝에서부터 맞춰 본다. 파일 안의 세션 정보로 한 번 더 확인한다.
          for (const id of wanted) if (path.endsWith(`-${id}.jsonl`)) found.set(id, [...(found.get(id) ?? []), path]);
        }
      } catch { /* 폴더가 없다(Codex 를 쓰지 않는다). */ }
      for (const id of missing) {
        const candidates = (found.get(id) ?? []).filter(path => parseCodexSessionMeta(readJsonlRange(root, path, null, { maxBytes: TAIL_BYTES }).records[0]?.value)?.sessionId === id);
        const known = this.codexPaths.get(id);
        this.codexPaths.set(id, candidates.length === 1 ? { path: candidates[0]!, tries: 0 } : { path: null, tries: (known?.tries ?? 0) + 1 });
      }
    }
    let ingested = 0;
    for (const [sessionId, member] of sessions) {
      const path = this.codexPaths.get(sessionId)?.path;
      if (!path) continue;
      let read: ReturnType<typeof readCodexUsageFile>;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.mtimeMs < now - retention) continue;
        const previous = this.codexCursors.get(sessionId) ?? null;
        if (previous && previous.log.readOffset === stat.size) continue;
        read = readCodexUsageFile(root, path, sessionId, previous, now);
      } catch {
        // 기록이 사라졌다(옮겨졌거나 지워졌다). 다음 훑기 때 다시 찾는다.
        this.codexPaths.delete(sessionId);
        this.codexCursors.delete(sessionId);
        continue;
      }
      if (read.cursor) this.codexCursors.set(sessionId, read.cursor); else this.codexCursors.delete(sessionId);
      // 넣다가 실패해도(DB 잠김 등) 다음 token_count 의 누적값이 빠진 몫까지 담는다.
      try { if (read.sample && this.ledger.ingest(read.sample, member, now, retention)) ingested++; } catch { /* 다음 사건에 이어 센다. */ }
    }
    return ingested;
  }
}

// ---- 보고 ----
function addAmounts(target: UsageAmounts, row: Row): void {
  const add = (current: number | null, value: unknown) => typeof value === "number" && Number.isFinite(value) ? (current ?? 0) + value : current;
  target.costUsd = add(target.costUsd, row.cost_usd);
  target.inputTokens = add(target.inputTokens, row.input_tokens);
  target.outputTokens = add(target.outputTokens, row.output_tokens);
}
const emptyAmounts = (): UsageAmounts => ({ costUsd: null, inputTokens: null, outputTokens: null });
/** 소수 더하기의 끝자리 흔들림만 지운다(백만분의 1달러). */
const tidyCost = <T extends UsageAmounts>(row: T): T => ({ ...row, costUsd: row.costUsd === null ? null : Math.round(row.costUsd * 1e6) / 1e6 });
const tokens = (row: UsageAmounts) => (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
const bigFirst = (a: UsageAmounts & { name?: string }, b: UsageAmounts & { name?: string }) =>
  (b.costUsd ?? -1) - (a.costUsd ?? -1) || tokens(b) - tokens(a) || (a.name ?? "").localeCompare(b.name ?? "");

export function usageTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** 오늘을 포함한 최근 days 일의 사용량. projectId 를 주면 그 프로젝트만. 표가 없으면(만들지 못한 DB) 빈 보고. */
export function usageReport(db: Database, options: { days: number; projectId?: string | null; now?: number; retentionMs?: number }): UsageReport {
  const now = options.now ?? Date.now();
  const days = Math.min(USAGE_MAX_DAYS, Math.max(1, Math.floor(options.days)));
  const from = dayBefore(now, days - 1), to = localDay(now);
  const projectId = options.projectId ?? null;
  const report: UsageReport = { generatedAt: new Date(now).toISOString(), timeZone: usageTimeZone(), days, from, to, projectId,
    retentionDays: Math.round((options.retentionMs ?? RECORD_RETENTION_MS) / 86_400_000), totals: emptyAmounts(), members: [], projects: [], daily: [], limits: [] };
  if (!tablesReady(db)) return report;
  const rows = db.query(`SELECT u.day, u.member_id, u.provider, u.project_id, u.member_name, u.member_kind, u.cost_usd, u.input_tokens, u.output_tokens, u.last_at,
      m.name AS current_name, m.kind AS current_kind, m.id IS NOT NULL AS present, p.name AS project_name, p.archived AS project_archived
    FROM usage_daily u JOIN projects p ON p.id = u.project_id LEFT JOIN members m ON m.id = u.member_id
    WHERE u.day >= ?1 AND u.day <= ?2 AND (?3 IS NULL OR u.project_id = ?3)`).all(from, to, projectId) as Row[];
  const members = new Map<string, UsageMemberRow>();
  const projects = new Map<string, UsageProjectRow & { memberIds: Set<string> }>();
  const daily = new Map<string, UsageDayRow>();
  for (const row of rows) {
    addAmounts(report.totals, row);
    const memberId = row.member_id as string;
    let member = members.get(memberId);
    if (!member) {
      member = { memberId, projectId: row.project_id as string, name: (row.current_name ?? row.member_name) as string, kind: (row.current_kind ?? row.member_kind) as MemberKind,
        providers: [], removed: !row.present, lastAt: row.last_at as string, ...emptyAmounts() };
      members.set(memberId, member);
    }
    addAmounts(member, row);
    if (!member.providers.includes(row.provider as CliProvider)) member.providers.push(row.provider as CliProvider);
    if ((row.last_at as string) > member.lastAt) member.lastAt = row.last_at as string;
    const pid = row.project_id as string;
    let project = projects.get(pid);
    if (!project) {
      project = { projectId: pid, name: row.project_name as string, archived: !!row.project_archived, members: 0, memberIds: new Set(), ...emptyAmounts() };
      projects.set(pid, project);
    }
    addAmounts(project, row);
    project.memberIds.add(memberId);
    const day = row.day as string;
    let entry = daily.get(day);
    if (!entry) { entry = { day, ...emptyAmounts() }; daily.set(day, entry); }
    addAmounts(entry, row);
  }
  report.totals = tidyCost(report.totals);
  report.members = [...members.values()].map(row => tidyCost({ ...row, providers: [...row.providers].sort() })).sort(bigFirst);
  report.projects = [...projects.values()].map(({ memberIds, ...row }) => tidyCost({ ...row, members: memberIds.size })).sort(bigFirst);
  report.daily = [...daily.values()].map(row => tidyCost(row)).sort((a, b) => a.day.localeCompare(b.day));
  report.limits = (db.query("SELECT provider, window_id, window_minutes, used_pct, resets_at, observed_at FROM usage_limits").all() as Row[])
    .filter(row => {
      const observed = Date.parse(row.observed_at as string), resets = row.resets_at === null ? null : Date.parse(row.resets_at as string);
      return Number.isFinite(observed) && observed >= now - LIMIT_STALE_MS && (resets === null || !Number.isFinite(resets) || resets > now);
    })
    .map((row): UsageLimitWindow => ({ provider: row.provider as CliProvider, window: row.window_id as string, windowMinutes: (row.window_minutes as number | null) ?? null,
      usedPct: row.used_pct as number, resetsAt: (row.resets_at as string | null) ?? null, observedAt: row.observed_at as string }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0) || a.window.localeCompare(b.window));
  return report;
}
