import { createHash, randomUUID } from "node:crypto";
import type { ApiOutageState, CliProvider, Decision, DecisionOption, Delivery, Member } from "../shared/types.ts";
import { ApiError, type Store } from "./store.ts";

function usageLimitTitle(text: string): boolean {
  return /(?:you['’]ve hit your (?:weekly limit|5-hour limit|Opus limit|Sonnet limit|Fable limit|usage credit limit|monthly spend limit|team['’]s shared budget|channel['’]s monthly spend limit)\b|you['’]ve reached your .+?\blimit\b|you['’]re out of usage credits\b|your org is out of usage\b)/i.test(text);
}

export type TurnErrorKind = "network" | "usage_limit" | "auth" | "error";
export function classifyTurnError(text: string): TurnErrorKind {
  if (/authentication|unauthorized|invalid.?api.?key|authentication_error|\b401\b|인증/i.test(text)) return "auth";
  if (usageLimitTitle(text) || /quota|usage.?limit|rate.?limit|weekly limit|hit your .*limit|한도/i.test(text)) return "usage_limit";
  if (/response stopped arriving|no response from API|connection error|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|request timed out|overloaded|\b529\b|API Error:\s*5|check your network|stream disconnected|error sending request|reconnecting/i.test(text)) return "network";
  return "error";
}

function localParts(at: number, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(at);
  return ["year", "month", "day", "hour", "minute", "second"].map(key => Number(parts.find(p => p.type === key)!.value));
}
function zonedTime(parts: number[], zone: string): number | null {
  const target = Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, parts[3]!, parts[4]!, 0);
  let at = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(at, zone);
    const offset = Date.UTC(p[0]!, p[1]! - 1, p[2]!, p[3]!, p[4]!, p[5]!) - at;
    at = target - offset;
  }
  return localParts(at, zone).slice(0, 5).every((n, i) => n === parts[i]) ? at : null;
}
/** Unknown/invalid dates stay visible as raw evidence instead of inventing a reset. */
export function parseUsageReset(text: string, now = Date.now(), serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string | null {
  const relative = /try again in\s+(?:(\d+)\s*h(?:ours?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?)?)?\s*)?/i.exec(text);
  if (relative && (relative[1] || relative[2])) {
    try { return new Date(now + (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * 60_000).toISOString(); } catch { return null; }
  }
  const match = /(?:resets|try again at)\s+(?:([A-Za-z]{3})\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!match) return null;
  const zone = match[6] ?? serverZone;
  try {
    const p = localParts(now, zone);
    const hour = Number(match[3]), minute = Number(match[4] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const month = match[1] ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[1].toLowerCase()) + 1 : p[1]!;
    if (!month) return null;
    const parts = [p[0]!, month, match[2] ? Number(match[2]) : p[2]!, hour % 12 + (match[5]!.toLowerCase() === "pm" ? 12 : 0), minute];
    let at = zonedTime(parts, zone);
    if (at === null) return null;
    // Weekly reset labels omit the year. Resolve the nearby year across Dec/Jan,
    // while preserving a recently passed reset so a stale menu can be resumed.
    if (match[1] && Math.abs(at - now) > 183 * 86_400_000) {
      parts[0]! += at < now ? 1 : -1;
      at = zonedTime(parts, zone);
      if (at === null) return null;
    }
    if (!match[1] && at < now) {
      const tomorrow = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]! + 1));
      parts.splice(0, 3, tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate());
      at = zonedTime(parts, zone);
    }
    return at === null ? null : new Date(at).toISOString();
  } catch { return null; }
}

export interface UsageMenu { fingerprint: string; raw: string; resetsAt: string | null }
export function usageLimitMenu(screen: string, now = Date.now()): UsageMenu | null {
  if (screen.includes("\x1b")) return null;
  const lines = screen.split(/\r?\n/).map(line => line.trimEnd());
  for (let title = lines.length - 1; title >= 0; title--) {
    if (!usageLimitTitle(lines[title]!)) continue;
    const question = lines.findIndex((line, i) => i > title && /What do you want to do\?/i.test(line));
    if (question < 0) continue;
    // A live composer below quoted dialog text is never a limit menu.
    if (/(?:^|\n)\s*[─━-]{3,}\s*\n\s*❯[^\n]*\n(?:[^\n]*\n)*?\s*[─━-]{3,}\s*(?:\n|$)/.test(lines.slice(question + 1).join("\n"))) return null;
    const footer = lines.findIndex((line, i) => i > question && /\bEsc to cancel\b/i.test(line));
    if (footer < 0 || !lines.slice(question + 1, footer).some(line => /\b(?:Stop(?: and wait for limit to reset)?|Wait here, then continue automatically(?: at\b| shortly\b| when the limit resets\b)?|Don['’]t continue automatically|Add funds to continue with usage(?: credits)?|Switch to usage credits|Ask your admin for more usage|Upgrade your plan|lower priority)\b/i.test(line))) continue;
    const raw = lines.slice(title, footer + 1).join("\n");
    return { fingerprint: createHash("sha256").update(raw).digest("hex"), raw, resetsAt: parseUsageReset(lines[title]!, now) };
  }
  return null;
}
export function networkRetryScreen(screen: string): boolean {
  return /Waiting for API response[\s\S]*check your network/i.test(screen);
}
export const API_RESUME_TEXT = "[시스템] 인터넷 연결이 끊겨 하던 턴이 중단됐습니다. 연결이 돌아왔습니다. 중단된 일을 이어서 하세요. 이미 끝낸 부분은 다시 하지 말고, 다 끝났으면 결과만 post 하세요.";
export const USAGE_RESUME_TEXT = "[시스템] 사용 한도로 하던 턴이 멈췄습니다. 이제 이어서 할 수 있습니다. 중단된 일을 이어서 하세요. 이미 끝낸 부분은 다시 하지 말고, 다 끝났으면 결과만 post 하세요.";
/** 사용 한도로 보류한 직원의 lastError. 한도가 풀리면 이 글일 때만 지운다. */
export const USAGE_WAIT_NOTE = "사용 한도 해제를 기다립니다";
/**
 * 사용 한도 카드의 '이어가기' 선택지. 키는 출시된 iPhone(0.2.2·0.2.3)이 이 값으로 답하므로 바꾸지 않는다.
 * 계정이 하나뿐인 사람도 있으니 계정을 바꿨다고 가정하지 않는다. 기다리기는 버튼이 아니라 기본 동작이다(풀리면 저절로 이어 간다).
 */
export const USAGE_RESUME_OPTION: DecisionOption = { k: "resume", label: "계정을 바꿨거나 한도를 늘렸어요 · 이어가기" };
/** 사용 한도 카드의 모델 선택지 키: `model:<모델 목록의 값>`. 고르면 카드의 팀장 모두를 그 모델로 바꿔 같은 세션을 이어 연다. */
export const USAGE_MODEL_PREFIX = "model:";

/**
 * '로'/'으로'. 한글은 받침으로 정하고(받침 없음·ㄹ 받침은 '로'), 숫자·영문은 우리말로 읽을 때의 끝소리로 정한다
 * (Opus로, Fable 5.2로, Haiku로, Sonnet으로, gpt-6.1-sol로). 정할 수 없으면 '(으)로'.
 */
export function particleRo(word: string): string {
  const text = word.trim();
  const last = text.at(-1) ?? "";
  const code = last.charCodeAt(0) - 0xac00;
  if (code >= 0 && code <= 11171) return code % 28 === 0 || code % 28 === 8 ? "로" : "으로";
  // 영(0)·삼(3)·육(6)만 받침이 ㄹ 이 아닌 소리로 끝난다.
  if (/[0-9]/.test(last)) return "036".includes(last) ? "으로" : "로";
  const lower = text.toLowerCase();
  if (!/[a-z]$/.test(lower)) return "(으)로";
  return /(?:ng|[mnbckpt])$/.test(lower) ? "으로" : "로";
}
/** 낱말에 '로'/'으로'를 붙인다. */
export function withRo(word: string): string { return `${word}${particleRo(word)}`; }

/**
 * 특정 모델의 사용 크레딧만 떨어진 한도인가(다른 모델로 바꾸면 바로 된다). 라이브 원문:
 * "You're out of usage credits. Run /usage-credits to keep using Fable 5.2 or /model to switch models." → { model: "Fable 5.2" }.
 * 모델 이름이 없고 '/model to switch models' 만 있으면 model 은 null. 아니면 null.
 */
export function modelCreditLimit(raw: string): { model: string | null } | null {
  const keep = /keep using\s+(.+?)\s+or\s+\/model\b/i.exec(raw) ?? /keep using\s+(.+?)\s*(?:\.\s|\.$|,|$)/im.exec(raw);
  if (keep?.[1]?.trim()) return { model: keep[1].trim() };
  return /\/model to switch models/i.test(raw) ? { model: null } : null;
}
/** 한도 글에 이름이 나온, 한도에 걸린 모델(카드의 모델 선택지에서 뺀다): 모델 크레딧 소진의 그 모델, 또는 'You've hit your Opus limit' 의 Opus. */
export function limitedModelName(raw: string): string | null {
  return modelCreditLimit(raw)?.model ?? /you['’]ve hit your (Opus|Sonnet|Fable|Haiku) limit\b/i.exec(raw)?.[1] ?? null;
}
/**
 * 사용 한도로 일하던 도중 멈춘 직원의 모델을 바꿔 같은 대화를 이어 열었을 때, 멈춘 실행마다 한 번 넣는 글(재시작 이어가기와 같은 꼴).
 * 원래 지시를 다시 넣지 않는다(세션 기록에 멈춘 턴이 그대로 있다). 이 글로 시작한 턴에도 평소의 보고 의무와 보고 보완이 그대로 적용된다.
 */
export function usageModelResumeText(model: string): string {
  return `[시스템] 사용 한도로 하던 일이 중간에 멈췄습니다. 모델을 ${withRo(model)} 바꿔 같은 대화를 이어 엽니다. 멈추기 직전까지 한 일을 먼저 확인하고(파일, 명령 결과, 외부 서비스의 상태), 끝나지 않은 부분만 이어서 하세요. 이미 끝낸 일을 다시 하지 마세요. 끝나면 평소처럼 보고하세요.`;
}

function formatUsageReset(at: string): string {
  const parts = new Intl.DateTimeFormat("ko-KR", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, month: "long", day: "numeric", hour: "numeric", minute: "numeric", hour12: true }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  return `${part("month")} ${part("day")}일 ${part("dayPeriod")} ${part("hour")}시${Number(part("minute")) ? ` ${Number(part("minute"))}분` : ""}`;
}

/** 이어가기 3회 실패 뒤에도 영영 멈추지는 않는다. 장애가 끝난 채 이만큼 지나면 한 번씩 다시 이어 본다. */
const EXHAUSTED_RETRY_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000, 120 * 60_000];
/** 한도 자동 이어가기를 시도조차 못했을 때(화면 읽기 실패·창 닫기 실패) 다시 해 보는 간격. */
const USAGE_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
/** 초기화 시각을 모르거나, 이어갔는데 다시 한도에 걸렸을 때 다시 이어 보는 간격. */
const USAGE_PROBE_MS = [60 * 60_000, 120 * 60_000, 240 * 60_000, 360 * 60_000];
const step = (table: number[], index: number) => table[Math.min(Math.max(index, 0), table.length - 1)]!;

/** 잠들었거나 사라진 세션이라 읽을 화면이 없다. 한도 창도 그 프로세스와 함께 없어졌다. */
export class NoTerminalError extends Error {
  constructor() { super("세션 터미널이 없습니다"); }
}

interface Affected { memberId: string; ended: boolean; attempts: number; resumeId: string | null; awaitingResult: boolean; exhausted: boolean; errorKey?: string; exhaustedAt?: string | null; slowRetries?: number; exhaustNotified?: boolean }
interface Outage { id: string; since: string; active: boolean; lastProbeAt: string | null; successes: number; revision?: number; affected: Affected[]; notifiedProjects?: string[]; recoveredProjects?: string[]; recoveryNotified?: boolean }
interface Limited { memberId: string; fingerprint: string | null; raw: string; resetsAt: string | null; resumeId: string | null; awaitingResult: boolean; autoAttempted: string | null; failure: string | null; dismissStarted?: boolean; errorKey?: string;
  /** 자동 이어가기 일정. 한 번 실패했다고 멈추지 않도록 다음 시도 시각과 횟수를 둔다. */
  limitedAt?: string; autoAttempts?: number; autoNextAt?: string | null; relimits?: number }
interface LimitGroup { cli: CliProvider; decisionId: string; stillLimited: boolean; members: Limited[]; rawEvidence?: string[];
  /** 대표가 카드에서 고른 마지막 모델 선택지(`model:<값>`). 같은 답이 다시 오면 한 번만 한다. */
  answered?: string }
interface RecoveryState { outage: Outage | null; limits: LimitGroup[]; resumeOrder?: string[]; continuations?: Record<string, string> }
export interface ApiRecoveryOptions {
  store: Store;
  probe?: (url: string, signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  urls?: string[];
  intervalMs?: number; probeTimeoutMs?: number;
  notify: (projectId: string, text: string, alertOwner?: boolean) => void;
  pump: (memberId: string) => void | Promise<void>;
  inspect: (member: Member) => Promise<{ menu: UsageMenu | null; state: string | null }>;
  dismiss: (member: Member, fingerprint: string) => Promise<{ ok: boolean; note?: string }>;
  /**
   * 카드의 모델 선택지(`model:<값>`): 그 CLI 의 모델 목록에서 카드의 팀장들이 한도에 걸린 모델을 뺀 것. 없으면 '이어가기'만 둔다.
   * 모델 목록과 팀장의 설정은 총괄이 안다(ModelCatalogReader·desiredConfig).
   */
  choices?: (cli: CliProvider, limited: { memberId: string; raw: string }[]) => DecisionOption[];
}

/** A single host-owned tick; all intent/attempt receipts are committed before external input. */
export class ApiRecovery {
  private state: RecoveryState;
  private readonly now: () => number;
  private running: Promise<void> | null = null;
  private readonly resuming = new Set<CliProvider>();
  private readonly resumeTasks = new Set<Promise<Decision>>();
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastUsageCheck = 0;
  private closed = false;
  constructor(private readonly options: ApiRecoveryOptions) {
    this.now = options.now ?? Date.now;
    this.state = options.store.loadApiRecovery<RecoveryState>("api_recovery") ?? { outage: null, limits: [] };
    // 이전 판이 남긴 상태에는 일정 기준 시각이 없다. 지금부터 센다.
    const at = new Date(this.now()).toISOString();
    for (const a of this.state.outage?.affected ?? []) if (a.exhausted) a.exhaustedAt ??= at;
    for (const g of this.state.limits) for (const m of g.members) m.limitedAt ??= at;
  }
  private exhaust(a: Affected, member: Member): void {
    a.exhausted = true;
    a.exhaustedAt = new Date(this.now()).toISOString();
    // 느린 재시도가 또 실패할 때마다 같은 알림을 되풀이하지 않는다.
    if (!a.exhaustNotified) this.options.notify(member.projectId, `${member.name}의 인터넷 연결 복구 후 이어가기가 3회 실패했습니다. 터미널을 확인해 주세요.`);
    a.exhaustNotified = true;
  }
  private transaction<T>(action: () => T): T {
    const before = structuredClone(this.state);
    try { return this.options.store.transaction(action); }
    catch (error) { this.state = before; throw error; }
  }
  private save(): void {
    this.options.store.transaction(() => {
      this.options.store.saveApiRecovery("api_recovery", this.state);
      this.options.store.saveApiRecovery("outage_public", this.outage());
    });
  }
  outage(): ApiOutageState | null {
    const o = this.state.outage;
    return o?.active ? { since: o.since, affectedMemberIds: o.affected.map(a => a.memberId), lastProbeAt: o.lastProbeAt } : null;
  }
  networkFailure(member: Member, ended = true, errorKey?: string): void {
    const store = this.options.store;
    this.transaction(() => {
      let o = this.state.outage;
      const previous = o?.affected.find(a => a.memberId === member.id);
      if (errorKey && previous?.errorKey === errorKey) return;
      const starting = !o || !o.active && !previous?.awaitingResult && !previous?.exhausted;
      if (!o || !o.active && !previous?.awaitingResult && !previous?.exhausted) o = { id: randomUUID(), since: new Date(this.now()).toISOString(), active: true, lastProbeAt: null, successes: 0, affected: [] };
      // Older recovery state only announced the first affected project.
      o.notifiedProjects ??= o.affected.length ? [store.getMember(o.affected[0]!.memberId)?.projectId].filter((id): id is string => !!id) : [];
      o.active = true;
      if (starting) o.successes = 0;
      let a = o.affected.find(a => a.memberId === member.id);
      const newFailure = !a || ended && !a.ended;
      if (newFailure) { o.successes = 0; o.revision = (o.revision ?? 0) + 1; }
      if (!a) { a = { memberId: member.id, ended, attempts: 0, resumeId: null, awaitingResult: false, exhausted: false }; o.affected.push(a); }
      if (errorKey) a.errorKey = errorKey;
      a.ended ||= ended;
      a.awaitingResult = false;
      if (ended && a.attempts >= 3 && !a.exhausted) this.exhaust(a, member);
      this.state.outage = o;
      if (ended) store.patchMember(member.id, { status: "idle", lastError: "인터넷 연결 문제로 멈춤", statusObservation: { source: member.backend ?? "core", observedAt: new Date(this.now()).toISOString(), freshness: "fresh", ownership: member.statusObservation?.ownership ?? "verified", consecutiveFailures: 0, error: { code: "network_outage", note: "인터넷 연결 문제로 멈춤" } } });
      this.holdPending(member.id, "api_outage");
      const notifyProject = !o.notifiedProjects.includes(member.projectId);
      const alertOwner = o.notifiedProjects.length === 0;
      if (notifyProject) o.notifiedProjects.push(member.projectId);
      this.save();
      if (this.started) this.start();
      if (notifyProject) {
        const count = o.affected.filter(a => store.getMember(a.memberId)?.projectId === member.projectId).length;
        this.options.notify(member.projectId, `인터넷 연결이 불안정해 팀원 ${count}명이 멈췄습니다. 연결이 돌아오면 자동으로 이어 갑니다.`, alertOwner);
      }
    });
  }
  holdReason(memberId: string): "api_outage" | "usage_limit" | null {
    if (this.state.outage?.affected.some(a => a.memberId === memberId && (this.state.outage!.active || a.exhausted))) return "api_outage";
    return this.state.limits.some(g => g.members.some(m => m.memberId === memberId && !m.awaitingResult)) ? "usage_limit" : null;
  }
  private holdPending(memberId: string, reason: string): void {
    for (const d of this.options.store.listPending(memberId)) {
      this.options.store.markHeld(d.id, reason);
      if (d.refType === "message" && d.refId) this.options.store.setMessageDelivery(d.refId, "held", reason === "api_outage" ? "인터넷 연결 복구를 기다립니다" : USAGE_WAIT_NOTE);
    }
  }
  /** 이 직원이 사용 한도로 보류 중인가(한도가 풀려 이어가기를 넣고 결과를 기다리는 중이면 아니다). */
  usageLimited(memberId: string): boolean {
    return this.state.limits.some(g => g.members.some(m => m.memberId === memberId && !m.awaitingResult));
  }
  /**
   * 사용 한도로 멈춘 직원의 모델을 바꿔 같은 대화를 이어 열 때(팀장 설정·총괄의 team_model). 그 직원의 한도 보류만 푼다.
   * 같은 계정(같은 CLI)의 다른 직원은 그대로 보류하고, 한도 카드는 남은 직원으로 고친다(남은 직원이 없으면 닫힌다).
   * 한도로 붙잡아 둔 전달은 다시 줄에 세운다. 새 모델도 한도에 걸리면 평소처럼 다시 보류된다(usageFailure).
   */
  releaseMember(memberId: string): void {
    const store = this.options.store;
    this.transaction(() => {
      for (const group of this.state.limits) {
        if (!group.members.some(m => m.memberId === memberId)) continue;
        group.members = group.members.filter(m => m.memberId !== memberId);
        this.updateCard(group);
      }
      store.clearUsageRetry(memberId);
      for (const d of store.listPending(memberId)) {
        if (d.status !== "held" || d.holdReason !== "usage_limit") continue;
        store.setDeliveryStatus(d.id, "queued");
        if (d.refType === "message" && d.refId) store.setMessageDelivery(d.refId, "queued");
      }
      const member = store.getMember(memberId);
      if (member) store.patchMember(member.id, { blockedReason: null, ...(member.lastError === USAGE_WAIT_NOTE ? { lastError: null } : {}),
        ...(member.statusObservation?.error?.code === "usage_limit" ? { statusObservation: { ...member.statusObservation, error: null } } : {}) });
      this.save();
    });
  }
  /** 이어가기 글을 넣는다. 기다리던 다른 전달보다 먼저, 혼자 나간다(prioritize). 아직 나가지 않은 이어가기 글이 있으면 그것을 쓴다. */
  continueAfter(member: Member, text: string): string {
    return this.transaction(() => {
      const id = this.enqueueResume(member, null, text);
      this.save();
      return id;
    });
  }
  /**
   * 이 직원 화면의 사용 한도 메뉴를 Esc 로만 닫는다(재우기·모델 변경으로 세션을 끝내기 전에). Enter·숫자·화살표는 보내지 않는다:
   * 메뉴의 선택지가 유료 크레딧 구매일 수 있다(dismiss 가 지문을 다시 확인하고 Esc 한 번만 보낸다). 메뉴가 없으면 할 일이 없다.
   * 닫는 동안과 닫은 뒤에, 메뉴가 사라진 것을 '대표가 터미널에서 직접 풀었다'로 읽어 보류를 풀지 않게 적어 둔다.
   */
  async closeMenu(member: Member): Promise<{ ok: boolean; note?: string }> {
    const snapshot = await this.options.inspect(member).catch((error: unknown) => {
      if (error instanceof NoTerminalError) return { menu: null, state: null };
      throw error;
    });
    if (!snapshot.menu) return { ok: true };
    const limited = this.state.limits.flatMap(g => g.members).filter(m => m.memberId === member.id);
    for (const m of limited) m.dismissStarted = true;
    if (limited.length) this.save();
    try {
      const result = await this.options.dismiss(member, snapshot.menu.fingerprint);
      if (result.ok) for (const m of limited) m.fingerprint = null;
      return result;
    } finally {
      for (const m of limited) m.dismissStarted = false;
      if (limited.length) this.save();
    }
  }
  preservesOrder(memberId: string): boolean { return this.state.resumeOrder?.includes(memberId) ?? false; }
  finishNetwork(memberId: string): void {
    const a = this.state.outage?.affected.find(a => a.memberId === memberId);
    if (a?.awaitingResult) { a.awaitingResult = false; a.ended = false; this.save(); }
  }
  /**
   * 이어가기를 포기해 멈춰 둔 직원을 대표의 뜻으로 다시 푼다(전달 '다시 확인', 그 직원에게 새로 보낸 말).
   * 장애가 진행 중이면 그대로 둔다. 풀린 뒤 또 실패하면 새 사고로 다시 센다.
   */
  releaseExhausted(memberId: string): boolean {
    const o = this.state.outage, a = o?.affected.find(a => a.memberId === memberId);
    if (!o || o.active || !a?.exhausted) return false;
    a.exhausted = false; a.exhaustedAt = null; a.ended = false; a.awaitingResult = false;
    const member = this.options.store.getMember(memberId);
    if (member && ["network_outage", "network_retry"].includes(member.statusObservation?.error?.code ?? "")) this.options.store.patchMember(member.id, { lastError: null, statusObservation: { ...member.statusObservation!, error: null } });
    this.save();
    return true;
  }
  /** 포기한 뒤에 대표가 새로 보낸 말·결재 답이 기다리고 있으면 푼다. */
  releaseForOwnerInput(memberId: string, pending: Delivery[]): boolean {
    const o = this.state.outage, a = o?.affected.find(a => a.memberId === memberId);
    if (!o || o.active || !a?.exhausted) return false;
    const since = a.exhaustedAt ?? "";
    return pending.some(d => (d.kind === "user_message" || d.kind === "answer") && d.createdAt > since) && this.releaseExhausted(memberId);
  }
  /** Send a continuation alone before any previously queued input. */
  prioritize(memberId: string, deliveries: Delivery[]): Delivery[] {
    const ids = [this.state.continuations?.[memberId], this.state.outage?.affected.find(a => a.memberId === memberId)?.resumeId, ...this.state.limits.flatMap(g => g.members.filter(m => m.memberId === memberId).map(m => m.resumeId))];
    const first = deliveries.find(d => ids.includes(d.id));
    return first ? [first] : deliveries;
  }
  usageFailure(member: Member, raw: string, menu: UsageMenu | null = null, errorKey?: string): void {
    const store = this.options.store;
    this.transaction(() => {
      this.state.limits = this.state.limits.filter(g => g.members.length > 0);
      let group = this.state.limits.find(g => g.cli === member.cli);
      if (!group) {
        const card = store.createDecision({ projectId: member.projectId, who: "시스템", title: "사용 한도 도달", options: [USAGE_RESUME_OPTION] });
        group = { cli: member.cli, decisionId: card.id, stillLimited: false, members: [] };
        this.state.limits.push(group);
      }
      let limited = group.members.find(m => m.memberId === member.id);
      if (!menu && errorKey && limited?.errorKey === errorKey) return;
      if (!limited) { limited = { memberId: member.id, fingerprint: menu?.fingerprint ?? null, raw, resetsAt: menu?.resetsAt ?? parseUsageReset(raw, this.now()), resumeId: null, awaitingResult: false, autoAttempted: null, failure: null, limitedAt: new Date(this.now()).toISOString() }; group.members.push(limited); }
      else {
        const before = limited.resetsAt;
        const again = limited.awaitingResult;
        if (again) {
          group.stillLimited = true; limited.awaitingResult = false; if (!menu) limited.fingerprint = null;
          // 이어갔는데 다시 걸렸다. 한 번으로 끝내지 않고 간격을 벌려 가며 다시 이어 본다.
          limited.relimits = (limited.relimits ?? 0) + 1;
          limited.autoNextAt = new Date(this.now() + step(USAGE_PROBE_MS, limited.relimits - 1)).toISOString();
        }
        limited.fingerprint = menu?.fingerprint ?? limited.fingerprint;
        limited.raw = raw;
        // Relative reset text is parsed once per occurrence, never moved forward by polling.
        // A failed continuation is a new occurrence, so its text is read again.
        limited.resetsAt = menu?.resetsAt ?? (again ? parseUsageReset(raw, this.now()) ?? limited.resetsAt : limited.resetsAt ?? parseUsageReset(raw, this.now()));
        // 새 초기화 시각이 나왔으면 그 시각에 맞춰 처음부터 다시 센다.
        if (limited.resetsAt && limited.resetsAt !== before && Date.parse(limited.resetsAt) > this.now()) { limited.autoAttempts = 0; limited.autoNextAt = null; limited.relimits = 0; }
      }
      if (!limited.resetsAt) {
        group.rawEvidence ??= [];
        if (!group.rawEvidence.includes(raw)) group.rawEvidence.push(raw);
      }
      if (errorKey) limited.errorKey = errorKey;
      store.appendActivity(member.id, "error", raw, `usage:${group.decisionId}:${member.id}:${createHash("sha256").update(raw).digest("hex")}`);
      store.patchMember(member.id, { status: menu ? "blocked" : "error", lastError: USAGE_WAIT_NOTE, blockedReason: "usage_limit", statusObservation: { source: member.backend ?? "core", observedAt: new Date(this.now()).toISOString(), freshness: "fresh", ownership: member.statusObservation?.ownership ?? "verified", consecutiveFailures: 0, error: { code: "usage_limit", note: raw } } });
      this.holdPending(member.id, "usage_limit");
      this.updateCard(group);
      this.save();
      if (this.started) this.start();
    });
  }
  private updateCard(group: LimitGroup): void {
    const waiting = group.members.filter(m => !m.awaitingResult || !m.resumeId || this.options.store.getDelivery(m.resumeId)?.status !== "delivered");
    const times = waiting.map(m => m.resetsAt).filter((t): t is string => !!t).sort();
    const resetsAt = times.at(-1) ?? null;
    const card = this.options.store.requireDecision(group.decisionId);
    // 선택지: 한도에 걸리지 않은 모델마다 하나(먼저), 그다음 이어가기. 팀장이 빠지거나 모델 목록이 바뀌면 다시 계산한다(틱마다 이 함수가 돈다).
    const models = waiting.length ? this.options.choices?.(group.cli, waiting.map(m => ({ memberId: m.memberId, raw: m.raw }))) ?? [] : card.options.filter(o => o.k.startsWith(USAGE_MODEL_PREFIX));
    const first = this.cardLead(group, waiting, resetsAt, models.length > 0);
    const names = waiting.map(m => `${this.options.store.getMember(m.memberId)?.name ?? m.memberId}${m.failure ? ` — ${m.failure}` : ""}`).join("\n");
    const raw = (group.rawEvidence ?? group.members.filter(m => !m.resetsAt).map(m => m.raw)).join("\n\n");
    const open = waiting.length > 0 && (card.status !== "closed" || card.usageLimit?.memberIds.length === 0);
    if (!open) group.stillLimited = false;
    this.options.store.updateUsageDecision(card.id, { cli: group.cli, resetsAt, memberIds: waiting.map(m => m.memberId), stillLimited: group.stillLimited }, waiting.length ? `${group.cli === "claude" ? "Claude" : "Codex"} 사용 한도 도달 · 팀원 ${waiting.length}명 멈춤` : card.title, waiting.length ? [first, names, raw].filter(Boolean).join("\n\n") : card.detail, open, [...models, USAGE_RESUME_OPTION]);
  }
  /**
   * 카드의 첫 문단. 계정이 여러 개라고 가정하지 않는다: 기다리면 저절로 이어 간다는 것, 바로 이어 가려면 다른 모델을 고르면 된다는 것,
   * 다른 계정으로 로그인했거나 한도를 늘렸으면 '이어가기'를 누르면 된다는 것을 차례로 적는다.
   */
  private cardLead(group: LimitGroup, waiting: Limited[], resetsAt: string | null, hasModels: boolean): string {
    if (group.stillLimited) return hasModels ? "아직 한도가 남아 있지 않습니다. 기다리거나 다른 모델을 고르세요." : "아직 한도가 남아 있지 않습니다. 한도가 풀리면 자동으로 이어 갑니다.";
    const credit = waiting.map(m => modelCreditLimit(m.raw)).find(c => c !== null) ?? null;
    const when = resetsAt ? `${formatUsageReset(resetsAt)}에 ` : "";
    const lead = credit ? `${credit.model ? `${credit.model} ` : "이 모델의 "}사용 크레딧이 떨어졌습니다. 다른 모델로 바꾸면 바로 이어 갑니다. 기다리면 ${when}크레딧이 채워질 때 자동으로 이어 갑니다.`
      : resetsAt ? `${when}한도가 풀리면 자동으로 이어 갑니다. 기다리셔도 됩니다.` : "한도가 풀렸는지 가끔 다시 확인해 자동으로 이어 갑니다. 기다리셔도 됩니다.";
    return `${lead} ${hasModels ? "바로 이어 가려면 다른 모델을 고르세요. " : ""}다른 계정으로 로그인했거나 한도를 늘렸다면 '이어가기'를 누르세요.`;
  }
  /** 이 카드에서 대표가 고른 마지막 모델 선택지. */
  answeredWith(decisionId: string): string | null {
    return this.state.limits.find(g => g.decisionId === decisionId)?.answered ?? null;
  }
  /** 카드에서 모델 선택지를 골랐다. 같은 답이 다시 오면 한 번만 하도록 적어 둔다. */
  noteAnswer(decisionId: string, choice: string): void {
    const group = this.state.limits.find(g => g.decisionId === decisionId);
    if (!group) return;
    group.answered = choice;
    this.save();
  }
  /** 카드에서 고른 모델로 바꾸지 못한 팀장: 카드에 남기고 이름 옆에 까닭을 적는다. */
  noteFailure(memberId: string, note: string): void {
    this.transaction(() => {
      for (const group of this.state.limits) {
        const limited = group.members.filter(m => m.memberId === memberId);
        if (!limited.length) continue;
        for (const m of limited) m.failure = note;
        this.updateCard(group);
      }
      this.save();
    });
  }
  received(deliveryId: string): void {
    for (const group of this.state.limits) if (group.members.some(m => m.resumeId === deliveryId)) this.updateCard(group);
  }
  private clearUsage(member: Member, state: string | null): void {
    this.options.store.patchMember(member.id, { ...(state === "working" ? { status: "working" as const } : ["idle", "done", "error"].includes(state ?? "") ? { status: "idle" as const } : {}), blockedReason: null, lastError: null, statusObservation: member.statusObservation ? { ...member.statusObservation, error: null } : null });
    this.options.pump(member.id);
  }

  private enqueueResume(member: Member, previousId: string | null = null, text = API_RESUME_TEXT): string {
    this.state.resumeOrder ??= [];
    if (!this.state.resumeOrder.includes(member.id)) this.state.resumeOrder.push(member.id);
    this.state.continuations ??= {};
    const previous = this.options.store.getDelivery(previousId ?? this.state.continuations[member.id] ?? "");
    const id = previous && ["queued", "held"].includes(previous.status) ? previous.id : this.options.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "system", text, wake: true }).id;
    this.state.continuations[member.id] = id;
    return id;
  }

  /** 초기화 시각 +1분(모르면 처음 걸린 지 한 시간) 뒤이고, 앞선 시도가 정한 다음 시각도 지났는가. */
  private autoDue(limited: Limited): boolean {
    const now = this.now();
    const base = limited.resetsAt ? Date.parse(limited.resetsAt) + 60_000 : Date.parse(limited.limitedAt ?? "") + step(USAGE_PROBE_MS, 0);
    return now >= base && (!limited.autoNextAt || now >= Date.parse(limited.autoNextAt));
  }

  resumeUsage(decisionId: string, automatic = false): Promise<Decision> {
    const task = this.resumeUsageOnce(decisionId, automatic);
    this.resumeTasks.add(task);
    void task.then(() => this.resumeTasks.delete(task), () => this.resumeTasks.delete(task));
    return task;
  }
  private async resumeUsageOnce(decisionId: string, automatic: boolean): Promise<Decision> {
    if (this.closed) throw new ApiError(503, "서버가 종료 중입니다");
    const group = this.state.limits.find(g => g.decisionId === decisionId);
    if (!group) throw new ApiError(404, "사용 한도 알림을 찾을 수 없습니다");
    if (this.resuming.has(group.cli)) return this.options.store.requireDecision(decisionId);
    this.resuming.add(group.cli);
    try {
      for (const limited of [...group.members]) {
        if (this.closed || limited.awaitingResult) continue;
        const member = this.options.store.getMember(limited.memberId);
        if (!member) { group.members = group.members.filter(m => m !== limited); continue; }
        if (this.options.store.requireProject(member.projectId).archived || this.state.outage?.active) continue;
        if (automatic && !this.autoDue(limited)) continue;
        if (automatic) {
          // 시도 전에 다음 시각을 적어 둔다. 이번에 못 하면(화면 읽기 실패 등) 그때 다시 한다.
          const tried = limited.autoAttempts ?? 0;
          limited.autoAttempts = tried + 1;
          limited.autoNextAt = new Date(this.now() + step(USAGE_RETRY_MS, tried)).toISOString();
          limited.autoAttempted = limited.resetsAt;
          this.save();
        }
        try {
          let gone = false;
          const snapshot = await this.options.inspect(member).catch((error: unknown) => {
            if (!(error instanceof NoTerminalError)) throw error;
            // 닫을 창이 없다. 이어가기만 넣어 두면 깨우면서 나간다.
            gone = true; limited.fingerprint = null; limited.dismissStarted = false;
            return { menu: null, state: null };
          });
          // 기다리는 사이 이 직원의 보류가 풀렸다(모델을 바꿔 이어 열었다: releaseMember). 이어가기를 또 넣지 않는다.
          if (!group.members.includes(limited)) continue;
          limited.fingerprint ??= snapshot.menu?.fingerprint ?? null;
          if (limited.fingerprint) {
            if (!snapshot.menu && !limited.dismissStarted) { group.members = group.members.filter(m => m !== limited); this.clearUsage(member, snapshot.state); continue; }
            if (snapshot.menu) {
              if (snapshot.menu.fingerprint !== limited.fingerprint) { limited.fingerprint = snapshot.menu.fingerprint; limited.failure = "화면이 바뀌었습니다. 다시 눌러 주세요"; if (automatic) { limited.autoAttempted = null; limited.autoNextAt = null; } continue; }
              limited.dismissStarted = true;
              this.save();
              const result = await this.options.dismiss(member, limited.fingerprint);
              if (!result.ok) { limited.dismissStarted = false; limited.failure = result.note ?? "창을 닫지 못했습니다"; continue; }
            } else if (snapshot.state === "blocked" || snapshot.state === "working") { limited.failure = "창을 닫지 못했습니다"; continue; }
          } else if (snapshot.state === "blocked" || snapshot.state === "working") { limited.failure = "창을 닫지 못했습니다"; continue; }
          if (this.closed) break;
          if (!group.members.includes(limited)) continue;
          this.transaction(() => {
            this.options.store.clearUsageRetry(member.id);
            limited.resumeId = this.enqueueResume(member, limited.resumeId, USAGE_RESUME_TEXT);
            limited.awaitingResult = true;
            limited.dismissStarted = false;
            limited.failure = null;
            this.options.store.patchMember(member.id, { ...(gone ? {} : { status: "idle" as const }), blockedReason: null, lastError: null, statusObservation: member.statusObservation ? { ...member.statusObservation, error: null } : null });
            this.save();
          });
          await this.options.pump(member.id);
        } catch { limited.failure = "창을 닫지 못했습니다"; }
      }
      this.updateCard(group);
      this.save();
      return this.options.store.requireDecision(decisionId);
    } finally { this.resuming.delete(group.cli); }
  }
  /** 성공한 턴은 연결도 한도도 풀렸다는 증거다. 서버가 이어가기를 넣지 않았어도(대표가 터미널에서 직접 풀었어도) 그 직원을 놓아준다. */
  completed(memberId: string): void {
    const a = this.state.outage?.affected.find(a => a.memberId === memberId);
    if (!a && !this.preservesOrder(memberId) && !this.state.limits.some(g => g.members.some(m => m.memberId === memberId))) return;
    if (a) { a.awaitingResult = false; a.ended = false; a.exhausted = false; a.exhaustedAt = null; a.attempts = 0; a.slowRetries = 0; a.exhaustNotified = false; }
    if (!this.options.store.listPending(memberId).length) this.state.resumeOrder = this.state.resumeOrder?.filter(id => id !== memberId);
    for (const g of this.state.limits) {
      const mine = g.members.filter(m => m.memberId === memberId);
      if (!mine.length) continue;
      g.members = g.members.filter(m => m.memberId !== memberId);
      const member = mine.some(m => !m.awaitingResult) ? this.options.store.getMember(memberId) : null;
      if (member) this.options.store.patchMember(member.id, { blockedReason: null, ...(member.lastError === USAGE_WAIT_NOTE ? { lastError: null } : {}),
        ...(member.statusObservation?.error?.code === "usage_limit" ? { statusObservation: { ...member.statusObservation, error: null } } : {}) });
      this.updateCard(g);
    }
    this.save();
  }
  start(): void {
    this.started = true;
    if (this.timer || this.closed || !this.state.outage?.active && !this.state.limits.some(g => g.members.length)) return;
    const interval = this.options.intervalMs ?? Number(process.env.IAMCEO_API_PROBE_INTERVAL_MS ?? 30_000);
    this.timer = setInterval(() => { void this.tick().catch(error => console.warn("API recovery tick failed", error)); }, Math.min(Number.isFinite(interval) && interval > 0 ? interval : 30_000, 5000));
    this.timer.unref?.();
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.running ??= this.runTick().finally(() => { this.running = null; });
  }
  private async runTick(): Promise<void> {
    const o = this.state.outage;
    const interval = this.options.intervalMs ?? Number(process.env.IAMCEO_API_PROBE_INTERVAL_MS ?? 30_000);
    if (o?.active && (!o.lastProbeAt || this.now() - Date.parse(o.lastProbeAt) >= (Number.isFinite(interval) && interval > 0 ? interval : 30_000))) {
      o.lastProbeAt = new Date(this.now()).toISOString();
      this.save();
      const configured = this.options.urls ?? process.env.IAMCEO_API_PROBE_URLS?.split(",").map(s => s.trim()).filter(Boolean);
      const urls = configured?.length ? configured : ["https://api.anthropic.com", ...(this.options.store.listAllMembers().some(m => m.cli === "codex") ? ["https://api.openai.com"] : [])];
      const revision = o.revision;
      const results = await Promise.all(urls.map(async url => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        try {
          await Promise.race([(this.options.probe ?? ((url, signal) => fetch(url, { method: "HEAD", signal, redirect: "manual" })))(url, controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("probe timeout")); }, Math.min(Math.max(this.options.probeTimeoutMs ?? 5000, 1), 5000)); })]);
          return true;
        } catch { return false; } finally { clearTimeout(timer!); }
      }));
      if (this.closed || o !== this.state.outage || revision !== o.revision) return;
      o.successes = results.length > 0 && results.every(Boolean) ? o.successes + 1 : 0;
      if (o.successes >= 2) {
        this.transaction(() => {
          o.active = false;
          for (const a of o.affected) {
            const member = this.options.store.getMember(a.memberId);
            if (!member) continue;
            if (!a.exhausted && ["network_outage", "network_retry"].includes(member.statusObservation?.error?.code ?? "")) this.options.store.patchMember(member.id, { lastError: null, statusObservation: { ...member.statusObservation!, error: null } });
            if (!a.ended) continue;
            if (a.attempts >= 3) {
              if (!a.exhausted) this.exhaust(a, member);
              continue;
            }
            a.resumeId = this.enqueueResume(member);
            a.attempts++;
            a.awaitingResult = true;
            a.ended = false;
          }
          o.recoveredProjects ??= [];
          const notifications = [...new Set([...(o.notifiedProjects ?? []), ...o.affected.map(a => this.options.store.getMember(a.memberId)?.projectId).filter((id): id is string => !!id)])]
            .filter(id => !o.recoveredProjects!.includes(id))
            .map(projectId => ({ projectId, count: o.affected.filter(a => this.options.store.getMember(a.memberId)?.projectId === projectId).length, alertOwner: false }));
          if (notifications.length && !o.recoveryNotified) { notifications[0]!.alertOwner = true; o.recoveryNotified = true; }
          o.recoveredProjects.push(...notifications.map(n => n.projectId));
          this.save();
          for (const n of notifications) this.options.notify(n.projectId, `인터넷 연결이 돌아와 팀원 ${n.count}명이 이어서 일합니다.`, n.alertOwner);
        });
        for (const a of o.affected) this.options.pump(a.memberId);
      } else this.save();
    }
    this.retryExhausted();
    if (this.now() - this.lastUsageCheck < 5000) return;
    this.lastUsageCheck = this.now();
    for (const group of [...this.state.limits]) {
      if (this.resuming.has(group.cli)) continue;
      for (const limited of [...group.members]) {
        const member = this.options.store.getMember(limited.memberId);
        if (!member) { group.members = group.members.filter(m => m !== limited); continue; }
        if (!limited.fingerprint || limited.awaitingResult) continue;
        try {
          const snapshot = await this.options.inspect(member);
          if (!group.members.includes(limited)) continue;
          if (!snapshot.menu && snapshot.state !== "blocked" && !limited.dismissStarted) {
            group.members = group.members.filter(m => m !== limited);
            this.clearUsage(member, snapshot.state);
          }
        } catch { /* Unknown screen is never permission for input or removal. */ }
      }
      this.updateCard(group);
      this.save();
      await this.resumeUsage(group.decisionId, !group.members.some(m => m.dismissStarted));
    }
  }
  /** 이어가기를 포기한 직원: 장애가 끝난 채로 충분히 지났으면 이어가기를 한 번 더 넣는다. 또 실패하면 간격을 벌린다. */
  private retryExhausted(): void {
    const o = this.state.outage;
    if (this.closed || !o || o.active) return;
    const due = o.affected.filter(a => a.exhausted && this.now() - Date.parse(a.exhaustedAt ?? "") >= step(EXHAUSTED_RETRY_MS, a.slowRetries ?? 0));
    if (!due.length) return;
    const resumed: string[] = [];
    this.transaction(() => {
      for (const a of due) {
        const member = this.options.store.getMember(a.memberId);
        if (!member || this.options.store.requireProject(member.projectId).archived) continue;
        a.exhausted = false; a.exhaustedAt = null;
        a.slowRetries = (a.slowRetries ?? 0) + 1;
        a.resumeId = this.enqueueResume(member);
        a.awaitingResult = true;
        a.ended = false;
        if (["network_outage", "network_retry"].includes(member.statusObservation?.error?.code ?? "")) this.options.store.patchMember(member.id, { lastError: null, statusObservation: { ...member.statusObservation!, error: null } });
        resumed.push(member.id);
      }
      this.save();
    });
    for (const id of resumed) this.options.pump(id);
  }
  async shutdown(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); await this.running; await Promise.allSettled([...this.resumeTasks]); }
}
