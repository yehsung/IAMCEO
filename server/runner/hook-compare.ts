// E1 나란히 모으기: 훅 기록(CLI 가 직접 알려 준 것)과 지금 판정의 근거를 맞대어 일치·불일치만 센다.
// 판정은 하나도 바꾸지 않는다. 결과는 서버 로그([hooks] 줄)와 $IAMCEO_HOME/run/events/compare.json(진단 파일에 들어간다)에 남는다.
//
// 맞대는 다섯 가지
// - receipt   수신 표지: 보내기가 성공(전송 영수증)한 봉투의 묶음 표지 ↔ UserPromptSubmit 에 실린 같은 표지
// - turn_end  턴 끝: 실행기의 turn_end(OSC 상태 보고·사라진 보고 추정) ↔ Stop·StopFailure
// - error_kind 오류 분류: turn_end 의 오류 글을 classifyTurnError 로 나눈 것 ↔ StopFailure 의 분류값
// - compact   압축 경계: 세션 기록에서 찾은 압축 완료(compacted) ↔ PostCompact
// - session   세션 ID: 서버가 아는 팀장의 세션 ↔ 훅 기록마다 실린 session_id
//
// /clear 판단(기록만): 대표가 터미널에서 /clear 를 치면 SessionStart(source=clear)가 새 세션 ID 로 온다. 서버의 세션 ID 는 바꾸지 않는다.
// 근거: (1) 터미널의 iamceo.session 표지는 띄울 때 정해져 바꿀 수 없어, 팀장 세션을 바꾸면 서버를 다시 켤 때 다시 붙이기가
// '소유가 바뀜'으로 거절된다. (2) 이미 보낸 봉투는 옛 세션 ID 로 신원을 묶어 두어 수신 확인이 identity_changed 로 멈춘다.
// (3) 새 세션 ID 가 훅 입력에 그대로 실린다는 것은 문서 설명뿐이고 실제 CLI 로 아직 보지 못했다. 그래서 이번에는 세고 로그에 남기기만 한다.
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { classifyTurnError, type TurnErrorKind } from "../api-outage.ts";
import { HookEventReader, type HookEventRecord } from "./hook-events.ts";
import { HOOK_COMPARE_FILE } from "./hooks.ts";
import type { RunnerEvent } from "./types.ts";

export { HOOK_COMPARE_FILE };
export const HOOK_COMPARE_CATEGORIES = ["receipt", "turn_end", "error_kind", "compact", "session"] as const;
export type HookCompareCategory = (typeof HOOK_COMPARE_CATEGORIES)[number];

export interface HookCompareCategoryCounts { matched: number; mismatched: number; rate: number | null; reasons: Record<string, number> }
export interface HookCompareSnapshot {
  version: 1;
  /** 이 서버 실행에서 비교를 시작한 때. 숫자는 이 실행 동안의 것이다. */
  startedAt: string;
  updatedAt: string;
  /** 지켜본 Claude 팀장 수와 그중 훅 기록이 있었던 수. */
  membersWatched: number;
  membersWithHooks: number;
  overall: { matched: number; mismatched: number; rate: number | null };
  categories: Record<HookCompareCategory, HookCompareCategoryCounts>;
  /** 훅 기록이 아예 없는 팀장이라 비교하지 못한 지금 판정 수(훅 이전에 띄운 팀장, 훅이 꺼진 환경). */
  noHookData: number;
  /** 읽지 못한 기록 줄·돌린 파일을 놓친 횟수. */
  unreadable: { lines: number; gaps: number };
  clears: { count: number; lastAt: string | null; decision: "record_only" };
  recentMismatches: { at: string; category: HookCompareCategory; reason: string; memberId: string }[];
}

/** StopFailure 의 분류값을 지금 판정의 오류 종류(classifyTurnError)로 옮긴다. billing_error 는 한도처럼 멈춰 기다리는 쪽으로 본다. */
export function hookErrorKind(error: string | undefined): TurnErrorKind {
  switch (error) {
    case "authentication_failed": return "auth";
    case "rate_limit": case "billing_error": return "usage_limit";
    case "overloaded": case "server_error": return "network";
    default: return "error";
  }
}

const BUNDLE_RE = /(?<![\p{L}\p{N}\p{M}_#\-])#iamceo_b_[A-Za-z0-9_-]{22}(?![\p{L}\p{N}\p{M}_#\-])/u;
const ITEM_RE = /(?<![\p{L}\p{N}\p{M}_#\-])#iamceo_[A-Za-z0-9_-]{22}(?![\p{L}\p{N}\p{M}_#\-])/gu;

interface Expectation { kind: "receipt" | "turn" | "compact"; at: number; bundle?: string; markers?: string[]; isError?: boolean; errorKind?: TurnErrorKind; inferred?: boolean }
interface MemberState {
  reader: HookEventReader;
  terminalId: string | null;
  sessions: { id: string; since: number }[];
  hooksSeen: boolean;
  cleared: Set<string>;
  expectations: Expectation[];
  candidates: HookEventRecord[];
  sessionQueue: HookEventRecord[];
  lastActive: number;
}

export interface HookShadowOptions {
  eventsDir: string;
  snapshotPath?: string;
  now?: () => number;
  /** 0 이면 타이머 없이 tick() 을 직접 부른다(시험). 기본 2초. */
  tickMs?: number;
  log?: (line: string) => void;
  windows?: Partial<typeof DEFAULT_WINDOWS>;
  /** 이보다 오래된 사건 파일은 시작할 때 지운다. 기본 30일. */
  pruneAfterMs?: number;
}

const DEFAULT_WINDOWS = {
  /** 보낸 뒤 이만큼 안에 UserPromptSubmit 이 와야 한다. 앞쪽은 보내기 응답이 훅보다 늦게 오는 몫. */
  receiptBeforeMs: 30_000, receiptAfterMs: 60_000,
  /** turn_end 앞뒤로 이만큼 안의 Stop·StopFailure 를 짝짓는다. turn_end 는 보고를 읽고 문맥을 잰 뒤에 나와 대개 훅보다 늦다. */
  turnBeforeMs: 60_000, turnAfterMs: 30_000,
  compactBeforeMs: 300_000, compactAfterMs: 60_000,
  /** 서버가 세션을 아직 모를 때 세션 비교를 미루는 시간. */
  sessionWaitMs: 30_000,
  /** 같은 까닭의 불일치 로그는 이 간격에 한 번. */
  logEveryMs: 10 * 60_000,
  summaryEveryMs: 30 * 60_000,
  persistEveryMs: 10_000,
};
const MAX_MEMBERS = 500;
const MAX_QUEUE = 200;
const RECENT = 50;

export class HookShadow {
  private readonly members = new Map<string, MemberState>();
  private readonly counts = Object.fromEntries(HOOK_COMPARE_CATEGORIES.map(c => [c, { matched: 0, mismatched: 0, reasons: {} as Record<string, number> }])) as Record<HookCompareCategory, { matched: number; mismatched: number; reasons: Record<string, number> }>;
  private noHookData = 0;
  private invalidLines = 0;
  private clears = { count: 0, lastAt: null as string | null };
  private readonly recent: HookCompareSnapshot["recentMismatches"] = [];
  private readonly startedAt: number;
  private readonly windows: typeof DEFAULT_WINDOWS;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly snapshotPath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private persistedAt = 0;
  private summarizedAt: number;
  private summarizedKey = "";
  private readonly loggedAt = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();
  private stopped = false;

  constructor(private readonly options: HookShadowOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.summarizedAt = this.startedAt;
    this.windows = { ...DEFAULT_WINDOWS, ...options.windows };
    this.log = options.log ?? ((line) => console.warn(line));
    this.snapshotPath = options.snapshotPath ?? join(options.eventsDir, HOOK_COMPARE_FILE);
    this.prune(options.pruneAfterMs ?? 30 * 24 * 3_600_000);
    const tickMs = options.tickMs ?? 2000;
    if (tickMs > 0) {
      this.timer = setInterval(() => this.tick(), tickMs);
      this.timer.unref?.();
    }
  }

  /** 보내기가 전송 영수증과 함께 성공했다(지금 판정: 받았다). Claude 팀장만 센다. */
  sent(memberId: string, cli: "claude" | "codex", info: { sessionId: string | null; text: string }): void {
    if (cli !== "claude" || this.stopped) return;
    try {
      const bundle = BUNDLE_RE.exec(info.text)?.[0];
      if (!bundle) return; // 전달 봉투가 아닌 입력(압축 명령 등)
      const m = this.member(memberId);
      if (!m) return;
      if (info.sessionId) this.noteSession(m, info.sessionId);
      const markers = [...new Set(info.text.match(ITEM_RE) ?? [])];
      this.push(m.expectations, { kind: "receipt", at: this.now(), bundle, markers });
    } catch { /* 비교는 판정에 영향을 주지 않는다 */ }
  }

  /** 실행기 사건(관측 정보가 붙은 것). Claude 팀장만 본다. */
  observe(event: RunnerEvent, cli: "claude" | "codex"): void {
    if (cli !== "claude" || this.stopped) return;
    try {
      const m = this.member(event.memberId);
      if (!m) return;
      if (event.type === "pane") { m.terminalId = event.paneId; return; }
      if (event.type === "session") { this.noteSession(m, event.sessionId); return; }
      if (event.type === "turn_end") {
        // 붙이는 순간의 첫 관측(서버를 다시 켰을 때 이미 오류로 끝나 있던 턴)은 훅이 이 실행 전에 남겼다. 비교하지 않는다.
        // CoreRunner.bind 는 첫 관측 뒤에 pane 사건을 내므로, 아직 모르는 터미널의 turn_end 가 그것이다.
        if (event.terminalId !== undefined && event.terminalId !== m.terminalId) return;
        this.push(m.expectations, { kind: "turn", at: this.now(), isError: event.isError, errorKind: event.isError ? classifyTurnError(event.errorText ?? "") : undefined, inferred: event.inferred === true });
        return;
      }
      if (event.type === "compacted") this.push(m.expectations, { kind: "compact", at: this.now() });
    } catch { /* 비교는 판정에 영향을 주지 않는다 */ }
  }

  tick(): void {
    if (this.stopped) return;
    try {
      const now = this.now();
      for (const [memberId, m] of this.members) {
        let read: ReturnType<HookEventReader["read"]>;
        try { read = m.reader.read(); } catch { continue; }
        if (read.invalid) { this.invalidLines += read.invalid; this.dirty = true; }
        for (const record of read.records) this.take(memberId, m, record);
        this.settleSessions(memberId, m, now);
        this.pair(memberId, m);
        this.expire(memberId, m, now);
      }
      this.summarize(now);
      if (this.dirty && now - this.persistedAt >= this.windows.persistEveryMs) this.persist(now);
    } catch { /* 다음 tick 에 다시 */ }
  }

  stop(): void {
    if (this.stopped) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.tick(); } catch { /* 마지막 읽기 */ }
    if (this.dirty) this.persist(this.now());
    this.stopped = true;
  }

  snapshot(): HookCompareSnapshot {
    const categories = {} as HookCompareSnapshot["categories"];
    let matched = 0, mismatched = 0;
    for (const c of HOOK_COMPARE_CATEGORIES) {
      const n = this.counts[c];
      categories[c] = { matched: n.matched, mismatched: n.mismatched, rate: rate(n.matched, n.mismatched), reasons: { ...n.reasons } };
      matched += n.matched; mismatched += n.mismatched;
    }
    let gaps = 0, withHooks = 0;
    for (const m of this.members.values()) { gaps += m.reader.gaps; if (m.hooksSeen) withHooks++; }
    return {
      version: 1, startedAt: new Date(this.startedAt).toISOString(), updatedAt: new Date(this.now()).toISOString(),
      membersWatched: this.members.size, membersWithHooks: withHooks,
      overall: { matched, mismatched, rate: rate(matched, mismatched) }, categories, noHookData: this.noHookData,
      unreadable: { lines: this.invalidLines, gaps }, clears: { ...this.clears, decision: "record_only" }, recentMismatches: [...this.recent],
    };
  }

  // ---- 안쪽 ----

  private member(memberId: string): MemberState | null {
    let m = this.members.get(memberId);
    if (!m) {
      let reader: HookEventReader;
      try { reader = new HookEventReader(this.options.eventsDir, memberId); } catch { return null; }
      if (this.members.size >= MAX_MEMBERS) {
        const oldest = [...this.members.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive)[0];
        if (oldest) this.members.delete(oldest[0]);
      }
      m = { reader, terminalId: null, sessions: [], hooksSeen: false, cleared: new Set(), expectations: [], candidates: [], sessionQueue: [], lastActive: this.now() };
      this.members.set(memberId, m);
    }
    m.lastActive = this.now();
    return m;
  }

  private push<T>(list: T[], item: T): void {
    list.push(item);
    if (list.length > MAX_QUEUE) list.splice(0, list.length - MAX_QUEUE);
  }

  private noteSession(m: MemberState, sessionId: string): void {
    if (m.sessions.at(-1)?.id === sessionId) return;
    m.sessions.push({ id: sessionId, since: this.now() });
    if (m.sessions.length > 8) m.sessions.splice(0, m.sessions.length - 8);
  }

  private take(memberId: string, m: MemberState, record: HookEventRecord): void {
    m.hooksSeen = true;
    if (record.event === "SessionStart" && record.source === "clear" && record.sessionId) m.cleared.add(record.sessionId);
    // 이 서버 실행 전에 남은 기록은 '훅이 켜져 있다'와 /clear 이력으로만 쓴다.
    if (record.at < this.startedAt) return;
    if (record.event === "SessionStart" && record.source === "clear") {
      this.clears.count++; this.clears.lastAt = new Date(record.at).toISOString(); this.dirty = true;
      this.log(`[hooks] ${memberId}: 터미널에서 /clear 로 새 대화가 시작됐습니다(세션 ID 바뀜). 서버는 이전 세션 ID 를 그대로 씁니다(기록만 하고 판정은 바꾸지 않음)`);
    }
    this.push(m.sessionQueue, record);
    // 표지 없는 입력은 대표가 터미널에서 직접 친 글이다. 지금 판정에 짝이 없으니 맞대지 않는다.
    if (record.event === "UserPromptSubmit" && record.markers?.length) this.push(m.candidates, record);
    if (record.event === "Stop" || record.event === "StopFailure" || record.event === "PostCompact") this.push(m.candidates, record);
  }

  private settleSessions(memberId: string, m: MemberState, now: number): void {
    const waiting: HookEventRecord[] = [];
    for (const record of m.sessionQueue) {
      if (!m.sessions.length) {
        if (now - record.at < this.windows.sessionWaitMs) waiting.push(record);
        continue; // 서버가 끝내 세션을 모르면 비교하지 않는다
      }
      // 기록 시각에 서버가 알던 세션. 서버가 세션을 알기 전의 기록(띄운 직후)은 첫 세션과 맞댄다.
      const known = [...m.sessions].reverse().find(s => s.since <= record.at + 5_000) ?? m.sessions[0]!;
      if (record.sessionId === known.id) this.count("session", true, memberId);
      else this.count("session", false, memberId, record.sessionId === null ? "invalid" : record.event === "SessionStart" && record.source === "clear" ? "clear" : m.cleared.has(record.sessionId) ? "after_clear" : "different");
    }
    m.sessionQueue = waiting;
  }

  private pair(memberId: string, m: MemberState): void {
    const w = this.windows;
    const left: Expectation[] = [];
    for (const exp of m.expectations) {
      const match = (accept: (r: HookEventRecord) => boolean, before: number, after: number) => {
        const at = m.candidates.findIndex(r => accept(r) && r.at >= exp.at - before && r.at <= exp.at + after);
        return at < 0 ? null : m.candidates.splice(at, 1)[0]!;
      };
      if (exp.kind === "receipt") {
        const record = match(r => r.event === "UserPromptSubmit" && (r.markers!.includes(exp.bundle!) || (exp.markers!.length > 0 && exp.markers!.every(x => r.markers!.includes(x)))), w.receiptBeforeMs, w.receiptAfterMs);
        if (record) { this.count("receipt", true, memberId); continue; }
      } else if (exp.kind === "turn") {
        const record = match(r => r.event === "Stop" || r.event === "StopFailure", w.turnBeforeMs, w.turnAfterMs);
        if (record) {
          this.count("turn_end", true, memberId);
          const hookError = record.event === "StopFailure";
          if (exp.isError && hookError) {
            const kind = hookErrorKind(record.error);
            this.count("error_kind", kind === exp.errorKind, memberId, `${exp.errorKind}->${kind}(${record.error})`);
          } else if (exp.isError !== hookError) {
            this.count("error_kind", false, memberId, exp.isError ? `server_error_only:${exp.errorKind}` : `hook_error_only:${record.error}`);
          }
          continue;
        }
      } else {
        const record = match(r => r.event === "PostCompact", w.compactBeforeMs, w.compactAfterMs);
        if (record) { this.count("compact", true, memberId); continue; }
      }
      left.push(exp);
    }
    m.expectations = left;
  }

  private expire(memberId: string, m: MemberState, now: number): void {
    const w = this.windows;
    const after = (kind: Expectation["kind"]) => kind === "receipt" ? w.receiptAfterMs : kind === "turn" ? w.turnAfterMs : w.compactAfterMs;
    m.expectations = m.expectations.filter(exp => {
      if (now - exp.at <= after(exp.kind)) return true;
      const category = exp.kind === "receipt" ? "receipt" : exp.kind === "turn" ? "turn_end" : "compact";
      if (!m.hooksSeen) { this.noHookData++; this.dirty = true; return false; }
      this.count(category, false, memberId, exp.kind === "turn" && exp.inferred ? "hook_missing_inferred" : "hook_missing");
      return false;
    });
    // 지금 판정 쪽 짝이 늦게 올 수 있는 만큼(앞쪽 창) 기다린 뒤에도 남은 훅 기록은 '훅만 안다'.
    m.candidates = m.candidates.filter(r => {
      const before = r.event === "UserPromptSubmit" ? w.receiptBeforeMs : r.event === "PostCompact" ? w.compactBeforeMs : w.turnBeforeMs;
      if (now - r.at <= before) return true;
      if (r.event === "UserPromptSubmit") this.count("receipt", false, memberId, "hook_only");
      else if (r.event === "PostCompact") this.count("compact", false, memberId, r.trigger === "auto" ? "hook_only_auto" : "hook_only");
      else this.count("turn_end", false, memberId, r.event === "StopFailure" ? `hook_only_error:${r.error}` : "hook_only");
      return false;
    });
  }

  private count(category: HookCompareCategory, matched: boolean, memberId: string, reason = ""): void {
    const n = this.counts[category];
    this.dirty = true;
    if (matched) { n.matched++; return; }
    n.mismatched++;
    n.reasons[reason] = (n.reasons[reason] ?? 0) + 1;
    const at = this.now();
    this.recent.push({ at: new Date(at).toISOString(), category, reason, memberId });
    if (this.recent.length > RECENT) this.recent.splice(0, this.recent.length - RECENT);
    const key = `${category}:${reason}`;
    const last = this.loggedAt.get(key);
    if (last !== undefined && at - last < this.windows.logEveryMs) { this.suppressed.set(key, (this.suppressed.get(key) ?? 0) + 1); return; }
    const skipped = this.suppressed.get(key) ?? 0;
    this.suppressed.delete(key);
    this.loggedAt.set(key, at);
    this.log(`[hooks] 불일치(판정은 그대로): ${LABEL[category]} · ${reason} · ${memberId}${skipped ? ` (같은 까닭 ${skipped}건 더)` : ""}`);
  }

  private summarize(now: number): void {
    if (now - this.summarizedAt < this.windows.summaryEveryMs) return;
    const s = this.snapshot();
    const key = JSON.stringify([s.overall, s.noHookData]);
    this.summarizedAt = now;
    if (key === this.summarizedKey || (s.overall.matched + s.overall.mismatched + s.noHookData === 0)) return;
    this.summarizedKey = key;
    this.log(summaryLine(s));
  }

  private persist(now: number): void {
    this.persistedAt = now;
    try {
      mkdirSync(this.options.eventsDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.snapshotPath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.snapshotPath);
      this.dirty = false;
    } catch { /* 다음에 다시 */ }
  }

  /** 오래된 팀장 사건 파일만 지운다(지운 팀장의 것). 이 폴더의 사건 파일 이름만 본다. */
  private prune(maxAgeMs: number): void {
    let names: string[];
    try { names = readdirSync(this.options.eventsDir); } catch { return; }
    const cutoff = this.now() - maxAgeMs;
    for (const name of names) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?:\.1)?\.jsonl$/.test(name)) continue;
      const path = join(this.options.eventsDir, name);
      try {
        const stat = lstatSync(path);
        if (stat.isFile() && statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch { /* 다음 실행에 다시 */ }
    }
  }
}

const LABEL: Record<HookCompareCategory, string> = { receipt: "수신 표지", turn_end: "턴 끝", error_kind: "오류 분류", compact: "압축 경계", session: "세션 ID" };

function rate(matched: number, mismatched: number): number | null {
  const total = matched + mismatched;
  return total ? Math.round((matched / total) * 1000) / 10 : null;
}

/** 서버 로그·진단에 쓰는 한 줄 요약. */
export function summaryLine(s: HookCompareSnapshot): string {
  const pct = (r: number | null) => r === null ? "-" : `${r}%`;
  const parts = HOOK_COMPARE_CATEGORIES.map(c => `${LABEL[c]} ${s.categories[c].matched}/${s.categories[c].matched + s.categories[c].mismatched}`);
  return `[hooks] 훅 기록 비교(판정은 그대로): 일치 ${s.overall.matched}/${s.overall.matched + s.overall.mismatched}(${pct(s.overall.rate)}) · ${parts.join(" · ")} · 훅 기록 없음 ${s.noHookData} · /clear ${s.clears.count}`;
}
