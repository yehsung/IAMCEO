import { createHash, randomUUID } from "node:crypto";
import type { ApiOutageState, CliProvider, Decision, Delivery, Member } from "../shared/types.ts";
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

function formatUsageReset(at: string): string {
  const parts = new Intl.DateTimeFormat("ko-KR", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, month: "long", day: "numeric", hour: "numeric", minute: "numeric", hour12: true }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  return `${part("month")} ${part("day")}일 ${part("dayPeriod")} ${part("hour")}시${Number(part("minute")) ? ` ${Number(part("minute"))}분` : ""}`;
}

interface Affected { memberId: string; ended: boolean; attempts: number; resumeId: string | null; awaitingResult: boolean; exhausted: boolean; errorKey?: string }
interface Outage { id: string; since: string; active: boolean; lastProbeAt: string | null; successes: number; revision?: number; affected: Affected[]; notifiedProjects?: string[]; recoveredProjects?: string[]; recoveryNotified?: boolean }
interface Limited { memberId: string; fingerprint: string | null; raw: string; resetsAt: string | null; resumeId: string | null; awaitingResult: boolean; autoAttempted: string | null; failure: string | null; dismissStarted?: boolean; errorKey?: string }
interface LimitGroup { cli: CliProvider; decisionId: string; stillLimited: boolean; members: Limited[]; rawEvidence?: string[] }
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
      if (ended && a.attempts >= 3 && !a.exhausted) {
        a.exhausted = true;
        this.options.notify(member.projectId, `${member.name}의 인터넷 연결 복구 후 이어가기가 3회 실패했습니다. 터미널을 확인해 주세요.`);
      }
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
        this.options.notify(member.projectId, `인터넷 연결이 불안정해 직원 ${count}명이 멈췄습니다. 연결이 돌아오면 자동으로 이어 갑니다.`, alertOwner);
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
      if (d.refType === "message" && d.refId) this.options.store.setMessageDelivery(d.refId, "held", reason === "api_outage" ? "인터넷 연결 복구를 기다립니다" : "사용 한도 해제를 기다립니다");
    }
  }
  preservesOrder(memberId: string): boolean { return this.state.resumeOrder?.includes(memberId) ?? false; }
  finishNetwork(memberId: string): void {
    const a = this.state.outage?.affected.find(a => a.memberId === memberId);
    if (a?.awaitingResult) { a.awaitingResult = false; a.ended = false; this.save(); }
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
        const card = store.createDecision({ projectId: member.projectId, who: "시스템", title: "사용 한도 도달", options: [{ k: "resume", label: "계정을 바꿨어요 · 모두 이어가기" }] });
        group = { cli: member.cli, decisionId: card.id, stillLimited: false, members: [] };
        this.state.limits.push(group);
      }
      let limited = group.members.find(m => m.memberId === member.id);
      if (!menu && errorKey && limited?.errorKey === errorKey) return;
      if (!limited) { limited = { memberId: member.id, fingerprint: menu?.fingerprint ?? null, raw, resetsAt: menu?.resetsAt ?? parseUsageReset(raw, this.now()), resumeId: null, awaitingResult: false, autoAttempted: null, failure: null }; group.members.push(limited); }
      else {
        if (limited.awaitingResult) { group.stillLimited = true; limited.awaitingResult = false; if (!menu) limited.fingerprint = null; }
        limited.fingerprint = menu?.fingerprint ?? limited.fingerprint;
        limited.raw = raw;
        // Relative reset text is parsed once per occurrence, never moved forward by polling.
        limited.resetsAt = menu?.resetsAt ?? limited.resetsAt ?? parseUsageReset(raw, this.now());
      }
      if (!limited.resetsAt) {
        group.rawEvidence ??= [];
        if (!group.rawEvidence.includes(raw)) group.rawEvidence.push(raw);
      }
      if (errorKey) limited.errorKey = errorKey;
      store.appendActivity(member.id, "error", raw, `usage:${group.decisionId}:${member.id}:${createHash("sha256").update(raw).digest("hex")}`);
      store.patchMember(member.id, { status: menu ? "blocked" : "error", lastError: "사용 한도 해제를 기다립니다", blockedReason: "usage_limit", statusObservation: { source: member.backend ?? "core", observedAt: new Date(this.now()).toISOString(), freshness: "fresh", ownership: member.statusObservation?.ownership ?? "verified", consecutiveFailures: 0, error: { code: "usage_limit", note: raw } } });
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
    const first = group.stillLimited ? "아직 같은 계정이라 한도가 남아 있지 않습니다. 다른 계정으로 로그인한 뒤 다시 누르세요." : resetsAt ? `${formatUsageReset(resetsAt)}에 풀리면 자동으로 이어 갑니다. 다른 계정으로 로그인했다면 지금 이어갈 수 있습니다.` : "초기화 시각을 확인하지 못했습니다. 다른 계정으로 로그인했다면 지금 이어갈 수 있습니다.";
    const names = waiting.map(m => `${this.options.store.getMember(m.memberId)?.name ?? m.memberId}${m.failure ? ` — ${m.failure}` : ""}`).join("\n");
    const raw = (group.rawEvidence ?? group.members.filter(m => !m.resetsAt).map(m => m.raw)).join("\n\n");
    const card = this.options.store.requireDecision(group.decisionId);
    const open = waiting.length > 0 && (card.status !== "closed" || card.usageLimit?.memberIds.length === 0);
    if (!open) group.stillLimited = false;
    this.options.store.updateUsageDecision(card.id, { cli: group.cli, resetsAt, memberIds: waiting.map(m => m.memberId), stillLimited: group.stillLimited }, waiting.length ? `${group.cli === "claude" ? "Claude" : "Codex"} 사용 한도 도달 · 직원 ${waiting.length}명 멈춤` : card.title, waiting.length ? [first, names, raw].filter(Boolean).join("\n\n") : card.detail, open);
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
        if (automatic && (!limited.resetsAt || this.now() < Date.parse(limited.resetsAt) + 60_000 || limited.autoAttempted === limited.resetsAt)) continue;
        if (automatic) { limited.autoAttempted = limited.resetsAt; this.save(); }
        try {
          const snapshot = await this.options.inspect(member);
          limited.fingerprint ??= snapshot.menu?.fingerprint ?? null;
          if (limited.fingerprint) {
            if (!snapshot.menu && !limited.dismissStarted) { group.members = group.members.filter(m => m !== limited); this.clearUsage(member, snapshot.state); continue; }
            if (snapshot.menu) {
              if (snapshot.menu.fingerprint !== limited.fingerprint) { limited.fingerprint = snapshot.menu.fingerprint; limited.failure = "화면이 바뀌었습니다. 다시 눌러 주세요"; if (automatic) limited.autoAttempted = null; continue; }
              limited.dismissStarted = true;
              this.save();
              const result = await this.options.dismiss(member, limited.fingerprint);
              if (!result.ok) { limited.dismissStarted = false; limited.failure = result.note ?? "창을 닫지 못했습니다"; continue; }
            } else if (snapshot.state === "blocked" || snapshot.state === "working") { limited.failure = "창을 닫지 못했습니다"; continue; }
          } else if (snapshot.state === "blocked" || snapshot.state === "working") { limited.failure = "창을 닫지 못했습니다"; continue; }
          if (this.closed) break;
          this.transaction(() => {
            this.options.store.clearUsageRetry(member.id);
            limited.resumeId = this.enqueueResume(member, limited.resumeId, USAGE_RESUME_TEXT);
            limited.awaitingResult = true;
            limited.dismissStarted = false;
            limited.failure = null;
            this.options.store.patchMember(member.id, { status: "idle", blockedReason: null, lastError: null, statusObservation: member.statusObservation ? { ...member.statusObservation, error: null } : null });
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
  completed(memberId: string): void {
    const a = this.state.outage?.affected.find(a => a.memberId === memberId);
    if (!a && !this.preservesOrder(memberId) && !this.state.limits.some(g => g.members.some(m => m.memberId === memberId && m.awaitingResult))) return;
    if (a) { a.awaitingResult = false; a.ended = false; a.exhausted = false; }
    if (!this.options.store.listPending(memberId).length) this.state.resumeOrder = this.state.resumeOrder?.filter(id => id !== memberId);
    for (const g of this.state.limits) {
      if (!g.members.some(m => m.memberId === memberId && m.awaitingResult)) continue;
      g.members = g.members.filter(m => m.memberId !== memberId);
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
              if (!a.exhausted) this.options.notify(member.projectId, `${member.name}의 인터넷 연결 복구 후 이어가기가 3회 실패했습니다. 터미널을 확인해 주세요.`);
              a.exhausted = true;
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
          for (const n of notifications) this.options.notify(n.projectId, `인터넷 연결이 돌아와 직원 ${n.count}명이 이어서 일합니다.`, n.alertOwner);
        });
        for (const a of o.affected) this.options.pump(a.memberId);
      } else this.save();
    }
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
  async shutdown(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); await this.running; await Promise.allSettled([...this.resumeTasks]); }
}
