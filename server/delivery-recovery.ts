import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { memberConfig, staffConfig, type Delivery, type DeliveryEvidence, type DeliveryNoticeItem, type DeliveryNoticePage, type DeliveryNoticePageOptions, type DeliveryNotices, type DeliveryRecoveryRequest, type DeliveryRecoveryResult, type Member, type MemberDeliverySummary, type Message, type UnassignedRecoveryRequest, type UnassignedRecoveryResult } from "../shared/types.ts";
import { ApiError, type Store } from "./store.ts";
import { ERROR_CODES } from "../shared/error-codes.ts";
import { textRef } from "../shared/server-text.ts";
import type { DeliveryDispatch, DeliveryRecoveryRecord, DeliveryRecoveryService } from "./service-contracts.ts";
import type { DeliveryBaseline, DeliveryInspection, DeliveryRepair, Runner, RunnerMember, RunnerTerminalIdentity, SendResult } from "./runner/types.ts";

/** SQL, cursors and transactions belong exclusively to Store. */
export type DeliveryRecoveryStore = Pick<Store,
  "legacyAssignedMember" | "getConductor" | "unassignedMessageOperation" | "setNeedsOwnerCounter" | "transaction" | "afterCommit" | "requireProject" | "listProjects" | "requireMember" | "getMember" | "listMembers" | "memberRevisions" | "getSettings" |
  "listDeliveries" | "requireDelivery" | "getDelivery" | "enqueue" | "getDeliveryRecovery" | "updateDeliveryRecovery" | "listDeliveryRecoveries" |
  "withDeliveryRead" | "deliveryNoticePreviews" | "listUnlinkedFailedMessages" | "listDeliveryRecoveryCandidates" | "hasDeliveryAttention" |
  "getDeliveryRetry" | "patchDeliveryRetry" | "saveDispatch" | "getDispatch" | "listDispatches" | "latestDispatchFor" | "updateDispatch" | "inputState" |
  "listLiveDeliveries" | "listDeliveriesByRef" | "hasLaterSameSource" | "listFenceCandidates" | "listPhysicalDispatches" | "listDispatchesFor" | "listDispatchesTouching" | "lastDispatch" |
  "deliveryRecoveryOperation" | "markDelivered" | "markHeld" | "markFailed" | "setDeliveryStatus" | "setMessageDelivery" |
  "listMissingReportNotices" | "deliveryWait" | "detectDeliveryStalls" | "deliveryStalled" | "recheckPendingDelivery" | "getMessage" | "requireMessage" | "listMessagePage" | "getDecision" | "setDecisionStatus" | "reopenDecision" | "getTodo" | "todoRevision" | "appendActivity">;

export type RecoveryRunner = Pick<Runner, "inspectDelivery" | "repairDelivery" | "terminalGone" | "inspectGoneDelivery">;
/** What settling the envelopes of a gone terminal decided, by delivery id. */
export interface GoneTerminalSettlement {
  /** The session log shows it was received: confirmed as delivered. */
  received: string[];
  /** Proven absent from the session log (or the owner accepted the duplicate risk): back in the queue for a new envelope. */
  requeued: string[];
  /** The log could not answer: left for the owner. */
  undecided: string[];
}

export interface DeliveryRecoveryOptions {
  store: DeliveryRecoveryStore;
  runner: (member: Member) => RecoveryRunner | null;
  legacyMessageText?: (message: Message) => string;
  /** True once nothing more can arrive from the write of this envelope (its call ended, or its process died). */
  writerDone?: (dispatch: DeliveryDispatch) => boolean;
  /** True while this process's own send call for the envelope has not returned yet. */
  writing?: (dispatch: DeliveryDispatch) => boolean;
  /** False while a repair write cannot be handed to the runner now (turn cap, outage hold, retry interval). */
  admit?: (memberId: string) => boolean;
  now?: () => number;
  random?: () => number;
}

const MAX_REJECTED = 5;
const CHECK_MS = [1_000, 3_000, 10_000, 30_000, 60_000];
const RETRY_MS = [2_000, 10_000, 30_000];
const STOP_NOTE = ERROR_CODES.note_stopped.ko;
const PHYSICAL = ["prepared", "write_started", "unknown"];
/**
 * Gemini(Antigravity CLI)의 수신 증거는 훅 기록이다(runner/gemini-hooks.ts readGeminiDeliveryEvidence). 표지를 찾지 못한 까닭의 코드를
 * 대표에게 선택지(중복 위험을 알고 다시 보내기)를 주는 아는 사유로 옮긴다. 옮기지 않으면 모르는 사유로 남아 '다시 확인'·'그만 보내기'만 보이고
 * 그동안 그 팀장의 전달 줄이 막힌다. 훅 기록을 볼 수 없던 것은 '기록 없음', 보았지만 받았는지 정하지 못한 것은 '기록으로 확정 못 함'이다.
 */
const GEMINI_LOG_MISSING = ["hooks_off", "no_baseline", "hook_log_missing"];
const GEMINI_LOG_INCOMPLETE = ["marker_not_in_hook_log", "hook_log_rotated", "hook_log_unreadable", "hook_log_untrusted"];
function geminiLogReason(evidence: DeliveryEvidence | undefined): "log_missing" | "log_incomplete" | null {
  if (evidence?.source !== "gemini_log" || evidence.verdict !== "unknown") return null;
  return GEMINI_LOG_MISSING.includes(evidence.code) ? "log_missing" : GEMINI_LOG_INCOMPLETE.includes(evidence.code) ? "log_incomplete" : null;
}
const CHECK_NOTE = ERROR_CODES.note_checking.ko;
const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({ operationId: z.uuid(), expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), action: z.literal("recheck") }),
  z.strictObject({ operationId: z.uuid(), expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), action: z.literal("stop_retry") }),
  z.strictObject({ operationId: z.uuid(), expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), action: z.literal("retry_with_risk"), acceptDuplicateRisk: z.literal(true) }),
]);

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function compare(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
function note(reason: string | null, evidence: DeliveryEvidence[] = []): string {
  switch (reason) {
    case "manual_control": return ERROR_CODES.note_manual_control.ko;
    case "stale_instruction": return ERROR_CODES.note_stale_instruction.ko;
    case "input_busy": return ERROR_CODES.note_input_busy.ko;
    case "busy": return ERROR_CODES.note_busy.ko;
    case "blocked": return ERROR_CODES.note_blocked.ko;
    case "duplicate_draft": return ERROR_CODES.note_duplicate_draft.ko;
    case "source_changed": return ERROR_CODES.note_source_changed.ko;
    case "retry_exhausted": return "자동 재전송 상한에 도달했습니다";
    case "not_received": return "미전달을 확인했습니다. 안전 상태를 다시 확인한 뒤 재전송합니다";
    case "draft_pending": return "입력 제출을 확인 중입니다";
    case "session_lost": return ERROR_CODES.note_session_lost.ko;
    case "session_unbound": return ERROR_CODES.note_session_unbound.ko;
    case "unsupported_schema": return ERROR_CODES.note_unsupported_schema.ko;
    case "log_missing": return ERROR_CODES.note_log_missing.ko;
    case "log_incomplete": return ERROR_CODES.note_log_incomplete.ko;
    case "identity_changed": return ERROR_CODES.note_identity_changed.ko;
    case "complete_range_without_marker": return evidence.some(e => e.location === "composer" && e.code === "different")
      ? ERROR_CODES.note_not_written_draft.ko
      : ERROR_CODES.note_not_written_unsafe.ko;
    case "legacy_unknown": return ERROR_CODES.note_legacy_unknown.ko;
    case "inflight_unsettled": return ERROR_CODES.note_inflight_unsettled.ko;
    default: return ERROR_CODES.note_unsettled.ko;
  }
}

/** No background timer is started: the host owns the tick timer and shutdown. */
export class DeliveryRecovery implements DeliveryRecoveryService {
  private readonly store: DeliveryRecoveryStore;
  private readonly now: () => number;
  private readonly random: () => number;
  private running: Promise<void> | null = null;
  /** Start of the latest check run. A check time before it that the run left in place was skipped, not missed. */
  lastRunAt: number | null = null;
  private closed = false;
  private readonly mutations = new Set<string>();

  constructor(private readonly options: DeliveryRecoveryOptions) {
    this.store = options.store;
    this.store.setNeedsOwnerCounter(projectId => this.store.hasDeliveryAttention(projectId)
      ? this.items(projectId, false).filter(item => item.phase === "needs_owner").length
      : this.store.listUnlinkedFailedMessages(projectId).length);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  private iso(at = this.now()): string { return new Date(at).toISOString(); }
  private record(id: string): DeliveryRecoveryRecord {
    this.store.requireDelivery(id);
    const record = this.store.getDeliveryRecovery(id);
    if (!record) throw new ApiError(409, "전달 복구 상태가 없습니다", "delivery_recovery_missing");
    return record;
  }
  private activeProject(id: string): void {
    if (this.store.requireProject(id).archived) throw new ApiError(404, "프로젝트를 찾을 수 없습니다", "project_not_found");
  }
  private latest(delivery: Delivery): DeliveryDispatch | null {
    // 11-16(D4-5): 전달마다 그 팀장의 봉투 이력 전체를 읽지 않는다(Store.latestDispatchFor 가 같은 답을 색인으로 찾는다).
    return this.store.latestDispatchFor(delivery.memberId, delivery.id);
  }
  private validDispatch(dispatch: DeliveryDispatch): boolean {
    // JSON columns are a persistence boundary, unlike ordinary typed arguments.
    return z.object({
      identity: z.object({ terminalId: z.string().min(1).nullable(), sessionId: z.string().min(1).nullable(), sessionGeneration: z.number().int().nonnegative(),
        process: z.object({ pid: z.number().int().positive(), startedAt: z.string().nullable() }).nullable() }),
      baseline: z.object({ serverEpoch: z.string().min(1), turn: z.number().int().nullable(), inputEpoch: z.number().int().nullable(), capturedAt: z.iso.datetime(),
        logs: z.array(z.object({ path: z.string().min(1), fileIdentity: z.string().nullable(), offset: z.number().int().nonnegative(), eventId: z.string().nullable() })) }),
      markers: z.array(z.object({ deliveryId: z.string().min(1), marker: z.string().min(1) })).min(1),
    }).safeParse(dispatch).success && createHash("sha256").update(dispatch.wireText).digest("hex") === dispatch.wireSha256;
  }
  private member(member: Member): RunnerMember {
    const settings = this.store.getSettings();
    // 직급표는 그 팀장의 CLI 것이다(Gemini 팀장에게 Claude 직급의 모델 이름을 넘기지 않는다).
    return { ...member, ...memberConfig(member, settings.ranks, settings.codexRanks, settings.geminiRanks), sessionGeneration: this.store.memberRevisions(member.id).sessionGeneration,
      subagentModel: staffConfig(member.cli, settings).model, permissionMode: settings.permissionMode };
  }

  /** Capture before the first external write; never infer a source version during retry. */
  sourceRevision(delivery: Delivery): string | null {
    if (!delivery.refType || !delivery.refId) return hash({ text: delivery.text, memberId: delivery.memberId });
    if (delivery.refType === "message") {
      const m = this.store.getMessage(delivery.refId);
      return m && m.projectId === delivery.projectId && (delivery.kind !== "user_message" || m.targetMemberId === null || m.targetMemberId === delivery.memberId || this.store.legacyAssignedMember(m.id) === delivery.memberId)
        ? hash({ id: m.id, body: m.body, title: m.title, attachments: m.attachments, ...(m.contextFileId ? { contextFileId: m.contextFileId } : {}), targetMemberId: m.targetMemberId, memberId: delivery.memberId }) : null;
    }
    if (delivery.refType === "decision") {
      const d = this.store.getDecision(delivery.refId);
      return d && d.projectId === delivery.projectId && d.memberId === delivery.memberId && ["answered", "delivered"].includes(d.status)
        ? hash({ id: d.id, answeredAt: d.answeredAt, choice: d.choice, note: d.note, updatedAt: d.updatedAt }) : null;
    }
    const t = this.store.getTodo(delivery.refId);
    return t && t.projectId === delivery.projectId && t.done
      ? hash({ id: t.id, done: t.done, doneAt: t.doneAt, outcome: t.outcome, revision: this.store.todoRevision(t.id), text: delivery.text }) : null;
  }
  private sourceValid(dispatch: DeliveryDispatch, delivery: Delivery): boolean {
    const expected = dispatch.items.find(item => item.deliveryId === delivery.id)?.sourceRevision;
    return expected != null && expected === this.sourceRevision(delivery);
  }

  /**
   * Also used by ordinary and urgent admission. stopped releases only the logical fence.
   * 0.2.10: 펌프 진입마다 부른다. 프로젝트 전달 이력 전체 대신 울타리가 될 수 있는 이 팀장의 전달(listFenceCandidates)만 본다. 판정은 같다.
   */
  fenced(memberId: string): boolean {
    this.settleProvenDispatches(memberId);
    this.store.requireMember(memberId);
    const state = this.store.inputState(memberId);
    return !!state.lease || this.mutations.has(memberId) || state.unresolvedDispatches.some(d => ["prepared", "write_started", "unknown"].includes(d.transportState)) ||
      this.store.listFenceCandidates(memberId).some(d => this.logicalFence(d));
  }
  private logicalFence(d: Delivery): boolean {
    const r = this.record(d.id);
    return !(r.phase === "waiting" && r.reason === "input_busy" || r.phase === "needs_owner" && r.reason === "stale_instruction") && !["none", "resolved", "stopped"].includes(r.phase) || (r.phase === "none" && (d.status === "delivering" || d.status === "held" && d.holdReason === "delivery_unknown"));
  }

  prepareDispatch(deliveryIds: string[], identity: RunnerTerminalIdentity, baseline: DeliveryBaseline): DeliveryDispatch {
    return this.store.transaction(() => {
      if (!deliveryIds.length || new Set(deliveryIds).size !== deliveryIds.length) throw new ApiError(400, "봉투 항목이 올바르지 않습니다", "envelope_invalid");
      const deliveries = deliveryIds.map(id => this.store.requireDelivery(id));
      const first = deliveries[0];
      this.activeProject(first.projectId);
      const member = this.store.requireMember(first.memberId);
      if (this.closed || !this.store.requireProject(member.projectId).runnerEnabled || this.fenced(member.id) || member.origin === "manual" || identity.terminalId !== member.paneId || identity.sessionId !== member.sessionId || identity.sessionGeneration !== this.store.memberRevisions(member.id).sessionGeneration) throw new ApiError(409, "입력 안전 상태가 바뀌었습니다", "input_safety_changed");
      for (const d of deliveries) {
        const previous = this.latest(d), phase = this.record(d.id).phase;
        const admissible = previous
          ? previous.transportState === "rejected" && (["none", "resolved"].includes(phase) || phase === "waiting" && this.record(d.id).reason === "input_busy")
          : d.attempts === 0 && phase === "none";
        if (d.memberId !== first.memberId || d.projectId !== first.projectId || d.kind === "compact" || !["queued", "held"].includes(d.status) || !admissible || this.sourceRevision(d) === null) throw new ApiError(409, "새 전달 봉투를 만들 수 없습니다", "envelope_create_refused");
      }
      const dispatch = this.saveEnvelope(deliveries, identity, baseline, "prepared");
      for (const d of deliveries) {
        const r = this.record(d.id);
        this.store.updateDeliveryRecovery(d.id, r.version, { phase: "none", reason: null, nextCheckAt: null });
      }
      return dispatch;
    });
  }
  private saveEnvelope(deliveries: Delivery[], identity: RunnerTerminalIdentity, baseline: DeliveryBaseline, transportState: DeliveryDispatch["transportState"]): DeliveryDispatch {
    const first = deliveries[0];
    const member = this.store.requireMember(first.memberId);
    const markers = deliveries.map(d => ({ deliveryId: d.id, marker: this.record(d.id).marker ?? `#iamceo_${randomBytes(16).toString("base64url")}` }));
    const bundleMarker = `#iamceo_b_${randomBytes(16).toString("base64url")}`;
    const wireText = deliveries.map((d, index) => `${d.text}\n${markers[index].marker}`).join("\n\n") + `\n${bundleMarker}`;
    const createdAt = this.iso(Math.max(this.now(), Date.parse(this.store.lastDispatch(member.id)?.createdAt ?? this.iso())));
    const dispatch: DeliveryDispatch = { dispatchId: randomUUID(), memberId: first.memberId, projectId: first.projectId,
      cli: member.cli, backend: member.backend ?? "core", identity, baseline, markers, bundleMarker, wireText,
      wireSha256: createHash("sha256").update(wireText).digest("hex"), items: deliveries.map((d, ordinal) => ({ deliveryId: d.id, ordinal, sourceRevision: this.sourceRevision(d) })),
      transportState, submitAttempts: 0, createdAt, updatedAt: this.iso() };
    if (!this.validDispatch(dispatch)) throw new ApiError(409, "전달 봉투의 기준선이나 신원을 확인할 수 없습니다", "envelope_identity_unverified");
    this.store.saveDispatch(dispatch);
    for (const item of dispatch.items) this.store.patchDeliveryRetry(item.deliveryId, { sourceRevision: item.sourceRevision });
    return dispatch;
  }

  private rejectedCount(d: Delivery): number {
    let count = 0;
    for (const dispatch of this.store.listDispatchesFor(d.memberId, d.id).reverse()) {
      if (dispatch.transportState !== "rejected") break;
      count++;
    }
    return count;
  }

  /** A durable pre-write refusal needs no log, identity or quiescence evidence. */
  requeueRejected(deliveryId: string, refusal?: string): boolean {
    return this.store.transaction(() => {
      const d = this.store.requireDelivery(deliveryId), r = this.record(deliveryId);
      // The cheap checks come first: latest() reads the member's whole dispatch history.
      if (d.status === "delivered" || r.phase === "stopped" || this.latest(d)?.transportState !== "rejected") return false;
      if (r.phase === "needs_owner" && r.reason === "stale_instruction") return false;
      if (r.phase === "resolved" && r.reason === "not_received" || r.phase === "waiting" && r.reason === "input_busy") return true;
      const exhausted = this.rejectedCount(d) >= MAX_REJECTED;
      const nextAttemptAt = exhausted ? this.iso(this.now() + [30_000, 60_000, 120_000, 300_000][Math.min(this.rejectedCount(d) - MAX_REJECTED, 3)]!) : null;
      this.store.updateDeliveryRecovery(d.id, r.version, { phase: exhausted ? "waiting" : "resolved", reason: exhausted ? "input_busy" : "not_received", nextCheckAt: null });
      this.store.setDeliveryStatus(d.id, exhausted ? "held" : "queued", { holdReason: exhausted ? "input_busy" : null });
      this.store.patchDeliveryRetry(d.id, { nextAttemptAt, retryReason: exhausted ? "input_busy" : null });
      // 거절이 이어진 까닭을 그대로 말한다. 일하는 중이거나 승인 창 앞인데 '입력칸이 비기를 기다린다'고 하면 대표가 엉뚱한 곳을 본다.
      const why = refusal === "busy" ? ERROR_CODES.note_retry_busy.ko : refusal === "blocked" ? ERROR_CODES.note_retry_blocked.ko
        : refusal === "down" || refusal === "gone" ? ERROR_CODES.note_retry_unreachable.ko : ERROR_CODES.note_input_busy.ko;
      if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, exhausted ? "held" : "queued", exhausted ? why : null);
      return true;
    });
  }

  beginRecovery(deliveryId: string, reason = "inflight_unsettled", refusal?: string): void {
    this.store.transaction(() => {
      const d = this.store.requireDelivery(deliveryId);
      const r = this.record(deliveryId);
      if (this.requeueRejected(deliveryId, refusal)) return;
      if (["resolved", "stopped"].includes(r.phase) || d.status === "delivered") return;
      this.store.updateDeliveryRecovery(d.id, r.version, { phase: r.phase === "needs_owner" ? "needs_owner" : "checking", reason: r.phase === "needs_owner" ? r.reason : reason, nextCheckAt: this.iso() });
      this.projectStatus(d, "held", CHECK_NOTE);
    });
  }
  private projectStatus(d: Delivery, status: "held" | "delivered" | "failed", message: string | null): void {
    this.store.setDeliveryStatus(d.id, status, { holdReason: status === "held" ? "delivery_unknown" : undefined, lastError: status === "failed" ? message : undefined });
    // A newer attempt for the same source must not be overwritten by an old result.
    const dispatch = this.latest(d);
    // 0.2.10: 같은 글의 전달만 읽는다(예전에는 프로젝트 전달 이력 전체에서 이 전달 뒤의 것을 찾았다).
    const deliveries = d.refType === "message" && d.refId ? this.store.listDeliveriesByRef(d.refType, d.refId, d.projectId) : [];
    if (d.refType === "message" && d.refId && this.store.getMessage(d.refId) && (!dispatch || this.sourceValid(dispatch, d)) && !deliveries.slice(deliveries.findIndex(item => item.id === d.id) + 1).some(other => other.memberId === d.memberId)) {
      this.store.setMessageDelivery(d.refId, status, message);
    }
  }
  private received(d: Delivery, duplicate: boolean, evidence: DeliveryEvidence[]): void {
    const r = this.record(d.id);
    if (r.phase === "stopped") return;
    const dispatch = this.latest(d);
    const sourceValid = dispatch && this.sourceValid(dispatch, d);
    if (d.status !== "delivered") {
      if (sourceValid) this.projectStatus(d, "delivered", null);
      else this.store.markDelivered(d.id);
      if (sourceValid && d.refType === "decision" && d.refId && this.store.getDecision(d.refId)?.status === "answered") this.store.setDecisionStatus(d.refId, "delivered");
      // 0.2.7(D1-7): '표시를 바로잡았습니다'는 정말 바로잡았을 때만(확인 중·보류·실패·대기로 보이던 것이 받은 것으로 확인됨). 넣는 중(delivering)의
      // 평소 수신 확정마다 남아 거의 모든 턴 앞에 붙었다(활동 1,389줄). 수신 확정 자체(상태·복구 기록)는 그대로다.
      if (d.status !== "delivering") this.store.appendActivity(d.memberId, "system", textRef("activity.delivery_corrected", { id: d.id }), `${d.id}:received`);
    }
    this.store.updateDeliveryRecovery(d.id, r.version, { phase: duplicate ? "needs_owner" : "resolved", reason: duplicate ? "duplicate_draft" : null,
      evidence, nextCheckAt: duplicate ? this.iso(this.now() + 60_000) : null, lastCheckedAt: this.iso() });
    this.store.patchDeliveryRetry(d.id, { nextAttemptAt: null, retryReason: null });
  }

  /** Late failures can settle physical writes, but cannot regress delivered/stopped decisions. */
  recordResult(dispatchId: string, result: SendResult): void {
    this.store.transaction(() => {
      const dispatch = this.store.getDispatch(dispatchId);
      if (!dispatch) throw new ApiError(404, "전달 봉투를 찾을 수 없습니다", "envelope_not_found");
      const receipt = result.ok && result.receipt?.dispatchId === dispatchId;
      if (receipt) {
        this.store.updateDispatch(dispatchId, dispatch.transportState, "accepted");
        for (const item of dispatch.items) {
          const d = this.store.requireDelivery(item.deliveryId);
          if (this.record(d.id).phase !== "stopped") this.received(d, false, [{ source: "transport", verdict: "present", location: "received_input", code: "verified_receipt", complete: true, checkedAt: this.iso() }]);
        }
        return;
      }
      // An obsolete failure from an older dispatch never changes the latest dispatch.
      // Resends always use another envelope, so a settled envelope cannot start writing again.
      if (["accepted", "rejected"].includes(dispatch.transportState)) return;
      if (dispatch.items.every(item => this.store.requireDelivery(item.deliveryId).status === "delivered")) return;
      this.store.updateDispatch(dispatchId, dispatch.transportState, !result.ok && ["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown") ? "rejected" : "unknown");
      for (const item of dispatch.items) {
        const d = this.store.requireDelivery(item.deliveryId);
        if (this.latest(d)?.dispatchId === dispatchId && !["resolved", "stopped"].includes(this.record(d.id).phase)) this.beginRecovery(d.id, undefined, result.ok ? undefined : result.reason);
      }
    });
  }

  /** CoreRunner calls these inside its own input mutex, immediately before physical input. */
  readonly repair = {
    load: (memberId: string, request: DeliveryRepair): DeliveryDispatch | null => this.loadRepair(memberId, request),
    prepare: (memberId: string, request: DeliveryRepair, dispatch: DeliveryDispatch): boolean => this.store.transaction(() => {
      const current = this.loadRepair(memberId, request);
      if (!current || current.wireSha256 !== dispatch.wireSha256 || current.transportState !== dispatch.transportState || this.closed) return false;
      for (const item of current.items) {
        const r = this.record(item.deliveryId);
        const retry = this.store.getDeliveryRetry(item.deliveryId);
        this.store.updateDeliveryRecovery(item.deliveryId, r.version, { phase: "checking", reason: "inflight_unsettled", autoAttempts: r.autoAttempts + (request.action === "resend" ? 1 : 0), nextCheckAt: this.iso(this.now() + 1_000) });
        this.store.patchDeliveryRetry(item.deliveryId, { nextAttemptAt: null, retryReason: null });
        this.store.setDeliveryStatus(item.deliveryId, "delivering", { attempt: true });
        this.store.appendActivity(memberId, "system", textRef(request.action === "submit_only" ? "activity.submit_only" : retry.retryReason?.startsWith("delivery_risk:") ? "activity.resend_risk" : "activity.resend_auto", { id: item.deliveryId }), `${current.dispatchId}:${item.deliveryId}:${request.action}:${r.autoAttempts + 1}`);
      }
      this.store.updateDispatch(current.dispatchId, current.transportState, "write_started", request.action === "submit_only");
      return true;
    }),
  };
  private loadRepair(memberId: string, request: DeliveryRepair): DeliveryDispatch | null {
    const dispatch = this.store.getDispatch(request.dispatchId);
    const member = this.store.getMember(memberId);
    if (!dispatch || !this.validDispatch(dispatch) || !member || dispatch.memberId !== memberId || (this.store.requireProject(member.projectId).archived || !this.store.requireProject(member.projectId).runnerEnabled) || this.store.inputState(memberId).lease || dispatch.identity.sessionGeneration !== this.store.memberRevisions(memberId).sessionGeneration || (!this.sessionFree(dispatch) && dispatch.identity.sessionId !== member.sessionId) || dispatch.identity.terminalId !== member.paneId || request.expectedSessionGeneration !== dispatch.identity.sessionGeneration || (!this.sessionFree(dispatch) && request.expectedSessionId !== dispatch.identity.sessionId) || request.expectedTerminalId !== dispatch.identity.terminalId) return null;
    if (dispatch.items.some(item => {
      const d = this.store.requireDelivery(item.deliveryId);
      const r = this.record(d.id);
      const retry = this.store.getDeliveryRetry(d.id);
      return this.latest(d)?.dispatchId !== dispatch.dispatchId || !this.sourceValid(dispatch, d) || d.status === "delivered" || !["checking", "retry_wait"].includes(r.phase) || r.version !== request.expectedRecoveryVersion ||
        request.action === "resend" && (r.autoAttempts >= 3 && !retry.retryReason?.startsWith("delivery_risk:") || r.reason !== "not_received" && r.reason !== "risk_approved" || !retry.nextAttemptAt || Date.parse(retry.nextAttemptAt) > this.now()) ||
        request.action === "submit_only" && (dispatch.submitAttempts !== 0 || r.reason !== "draft_pending");
    })) return null;
    // Even an older attempt of the same delivery can still perform physical input.
    if (this.store.inputState(memberId).unresolvedDispatches.some(other => other.dispatchId !== dispatch.dispatchId && ["prepared", "write_started", "unknown"].includes(other.transportState))) return null;
    // Multiple unknown envelopes must never be bypassed by a repair of one envelope.
    if (this.store.listFenceCandidates(memberId).some(d => !dispatch.items.some(item => item.deliveryId === d.id) && this.logicalFence(d))) return null;
    return dispatch;
  }

  async recover(deliveryId: string, request: DeliveryRecoveryRequest): Promise<DeliveryRecoveryResult> {
    if (!requestSchema.safeParse(request).success) throw new ApiError(400, "전달 복구 요청이 올바르지 않습니다", "delivery_recovery_invalid");
    const d = this.store.requireDelivery(deliveryId);
    this.activeProject(d.projectId);
    return this.store.deliveryRecoveryOperation(deliveryId, request.operationId, request, () => {
      const r = this.record(deliveryId);
      if (["recheck", "stop_retry"].includes(request.action) && ["queued", "held"].includes(d.status) && r.phase !== "stopped" && (!this.latest(d) || this.latest(d)?.transportState === "rejected")) {
        if (this.closed || r.version !== request.expectedVersion || this.mutations.has(d.memberId)) throw new ApiError(409, "전달 상태가 바뀌었습니다. 다시 확인해 주세요", "delivery_state_changed");
        const next = this.store.updateDeliveryRecovery(d.id, r.version, { phase: request.action === "stop_retry" ? "stopped" : this.latest(d) ? "resolved" : "none", reason: this.latest(d) ? "not_received" : null, lastCheckedAt: this.iso(), nextCheckAt: null });
        if (request.action === "stop_retry") {
          this.projectStatus(d, "failed", STOP_NOTE);
          this.store.patchDeliveryRetry(d.id, { nextAttemptAt: null, retryReason: null });
          this.stoppedAnswer(d);
        } else {
          this.store.patchDeliveryRetry(d.id, { nextAttemptAt: null, retryReason: null });
          this.store.recheckPendingDelivery(d.memberId);
        }
        return { operationId: request.operationId, deliveryId, outcome: request.action === "stop_retry" ? "stopped" : "check_scheduled", committedVersion: next.version };
      }
      if (this.closed || r.version !== request.expectedVersion || ["resolved", "stopped"].includes(r.phase) || r.phase === "none" || this.mutations.has(d.memberId)) throw new ApiError(409, "전달 상태가 바뀌었습니다. 다시 확인해 주세요", "delivery_state_changed");
      if (request.action !== "recheck" && !this.actions(d, r).includes(request.action)) throw new ApiError(409, "전달 상태가 바뀌었습니다. 다시 확인해 주세요", "delivery_state_changed");
      const next = this.store.updateDeliveryRecovery(d.id, r.version, request.action === "stop_retry"
        ? { phase: "stopped", nextCheckAt: null }
        : { phase: request.action === "recheck" && r.phase === "needs_owner" ? "needs_owner" : "checking", reason: request.action === "retry_with_risk" ? "risk_approved" : r.reason, nextCheckAt: this.iso() });
      if (request.action === "stop_retry") {
        if (d.status !== "delivered") { this.projectStatus(d, "failed", STOP_NOTE); this.stoppedAnswer(d); }
        this.store.patchDeliveryRetry(d.id, { nextAttemptAt: null, retryReason: null });
      } else if (request.action === "retry_with_risk") {
        this.store.patchDeliveryRetry(d.id, { nextAttemptAt: this.iso(), retryReason: `delivery_risk:${request.operationId}` });
      }
      return { operationId: request.operationId, deliveryId, outcome: request.action === "stop_retry" ? "stopped" : request.action === "retry_with_risk" ? "retry_scheduled" : "check_scheduled", committedVersion: next.version };
    });
  }

  /**
   * 0.2.7 묶음 1(점검 D3-10): 대표가 결재 답의 전달을 그만두면, 그 결재는 예전에 영영 '답함(미전달)'으로 남고 총괄은 접수 때 받은 '전달했습니다'만 알았다.
   * 끝내 전달하지 못한 답과 같은 길(store.reopenDecision, 직전 답을 카드에 남김)로 카드를 다시 연다: 물은 팀장은 그 답을 받지 못했을 수 있고 아직 답을
   * 기다린다. 대표는 같은 답을 한 번에 다시 고르거나 다르게 답할 수 있다. 총괄에게는 깨우지 않는 소식으로 사실을 알린다. 이 전달이 그 결재의 마지막 답 전달일 때만.
   */
  private stoppedAnswer(d: Delivery): void {
    if (d.kind !== "answer" || d.refType !== "decision" || !d.refId) return;
    const decision = this.store.getDecision(d.refId);
    if (!decision || decision.status !== "answered" || decision.projectId !== d.projectId) return;
    const later = this.store.listDeliveriesByRef("decision", decision.id, d.projectId).filter(other => other.kind === "answer" && other.id !== d.id && ["queued", "held", "delivering", "delivered"].includes(other.status));
    if (later.length) return;
    const asker = this.store.getMember(d.memberId);
    this.store.reopenDecision(decision.id, textRef("card.reopen_stopped", { name: asker?.name ?? decision.who }));
    const conductor = this.store.getConductor(d.projectId);
    if (conductor && conductor.id !== d.memberId) this.store.enqueue({ projectId: d.projectId, memberId: conductor.id, kind: "system", wake: false,
      text: `[시스템] 대표가 ${decision.who}의 결재 #${decision.id} 답 전달(${d.id})을 그만뒀습니다. ${decision.who}에게 그 답이 들어가지 않았거나 들어갔는지 모릅니다. 결재는 다시 열려 대표의 답을 기다립니다. 앞서 받은 '결재에 답했습니다' 소식은 전달된 것이 아닙니다.` });
  }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  private async run(): Promise<void> {
    this.lastRunAt = this.now();
    this.store.detectDeliveryStalls(this.now());
    const members = new Map<string, Delivery[]>();
    const dispatches = new Map<string, DeliveryDispatch[]>();
    for (const d of this.store.listDeliveryRecoveryCandidates()) {
      const r = this.record(d.id);
      if (r.phase === "needs_owner" && r.reason === "stale_instruction") continue;
      if (!["none", "resolved", "stopped"].includes(r.phase) && this.requeueRejected(d.id)) continue;
      // 0.2.10: 쓰기 결과를 모르는 봉투만 읽는다(예전에는 팀장마다 봉투 이력 전체를 읽고 같은 상태로 걸렀다).
      if (!dispatches.has(d.memberId)) dispatches.set(d.memberId, this.store.listPhysicalDispatches(d.memberId));
      const physical = dispatches.get(d.memberId)!.some(item => item.items.some(item => item.deliveryId === d.id));
      if (!physical && (["resolved", "stopped"].includes(r.phase) || d.status === "delivered" && r.reason !== "duplicate_draft" || r.phase === "none" && !["failed", "delivering"].includes(d.status) && !(d.status === "held" && d.holdReason === "delivery_unknown"))) continue;
      if (this.store.requireProject(d.projectId).archived || this.store.requireMember(d.memberId).origin === "manual") continue;
      if (physical && ["resolved", "stopped"].includes(r.phase) && r.lastCheckedAt && Date.parse(r.lastCheckedAt) + 60_000 > this.now()) continue;
      if (r.nextCheckAt && Date.parse(r.nextCheckAt) > this.now()) continue;
      members.set(d.memberId, [...(members.get(d.memberId) ?? []), d]);
    }
    // Members progress independently. Errors remain visible to the gate/host.
    const results = await Promise.allSettled([...members.values()].map(ds => this.checkMember(ds)));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  private async checkMember(deliveries: Delivery[]): Promise<void> {
    // 사라진 것이 확정된 터미널의 봉투는 터미널 없이 판정했다. 아래의 터미널 조회는 지금 터미널(또는 살아 있을 수 있는 터미널)의 봉투만 본다.
    const stranded = this.strandedTerminals(deliveries[0].memberId);
    if (stranded.length) {
      const settled = await this.settleGoneTerminals(deliveries[0].memberId, stranded);
      deliveries = deliveries.filter(d => !settled.has(d.id));
      if (!deliveries.length || this.closed) return;
    }
    const checked = new Set<string>();
    // An older unknown write is still a physical fence even if a later attempt succeeded.
    // Read it by its own identity/barrier; later success cannot settle that earlier RPC.
    const latest = new Set(deliveries.map(d => this.latest(d)?.dispatchId));
    // 조작권은 기다림(await) 사이에만 바뀔 수 있다. 예전에는 봉투마다 조작권을 다시 읽었고, 그 읽기가 봉투 이력 전체를 거르는
    // inputState 라 바쁜 총괄(봉투 560개)에서 이 반복 하나가 3초 넘게 이벤트 루프를 막았다(11-16 D4-5). 기다린 뒤에만 다시 읽는다(판정은 같다).
    // 0.2.10: 그 팀장의 봉투 이력 전체가 아니라 쓰기 결과를 모르는 봉투만 돈다(나머지는 아래에서 언제나 건너뛰던 봉투다).
    // 조작권·닫힘을 확인하는 때도 예전과 같다: 첫 봉투 앞(봉투가 하나라도 있으면), 그리고 기다림(await) 뒤의 다음 봉투 앞(그 뒤에 봉투가 남아 있으면).
    // 그 사이에는 기다림이 없어 조작권이 바뀌지 않으므로, 건너뛰던 봉투 앞에서 보던 것을 다음으로 도는 봉투 앞에서, 그런 봉투가 없으면 반복 뒤에서 본다
    // (돈 봉투가 없거나 마지막으로 기다린 봉투가 마지막 봉투가 아니면 그 뒤에 건너뛰던 봉투가 있었다).
    const memberId = deliveries[0].memberId;
    const last = this.store.lastDispatch(memberId)?.dispatchId ?? null;
    let leaseChecked = false, waitedOn: string | null = null;
    for (const dispatch of this.store.listPhysicalDispatches(memberId)) {
      if (this.closed) return;
      if (!leaseChecked) { if (this.store.inputState(dispatch.memberId).lease) return; leaseChecked = true; }
      if (latest.has(dispatch.dispatchId)) continue;
      const member = this.store.requireMember(dispatch.memberId);
      const runner = this.options.runner(member);
      if (!runner?.inspectDelivery || !this.validDispatch(dispatch) || (!this.sessionFree(dispatch) && member.sessionId !== dispatch.identity.sessionId) || this.store.memberRevisions(member.id).sessionGeneration !== dispatch.identity.sessionGeneration) continue;
      let inspection: DeliveryInspection;
      leaseChecked = false; waitedOn = dispatch.dispatchId;
      try { inspection = await runner.inspectDelivery(this.member(member), dispatch); }
      catch { continue; } // Failed reads leave the original physical fence intact.
      if (!this.closed && !this.store.inputState(member.id).lease && !this.store.requireProject(member.projectId).archived) this.settlePhysical(dispatch, inspection);
    }
    if (!leaseChecked && waitedOn !== last) {
      if (this.closed) return;
      if (this.store.inputState(memberId).lease) return;
    }
    for (const d of deliveries) {
      if (this.closed) return;
      const dispatch = this.latest(d);
      if (dispatch && checked.has(dispatch.dispatchId)) continue;
      if (dispatch) checked.add(dispatch.dispatchId);
      const ids = dispatch ? dispatch.items.map(item => item.deliveryId).filter(id => deliveries.some(item => item.id === id)) : [d.id];
      if (this.store.inputState(d.memberId).lease) {
        for (const id of ids) this.wait(id, "manual_control");
        continue;
      }
      const memberBefore = this.store.requireMember(d.memberId);
      const generationBefore = this.store.memberRevisions(d.memberId).sessionGeneration;
      const runner = this.options.runner(memberBefore);
      const versions = new Map(ids.map(id => [id, this.record(id).version]));
      let inspection: DeliveryInspection;
      try {
        inspection = dispatch && this.validDispatch(dispatch) && runner?.inspectDelivery ? await runner.inspectDelivery(this.member(this.store.requireMember(d.memberId)), { ...dispatch, markers: dispatch.markers.filter(marker => ids.includes(marker.deliveryId)) }) : this.unknown(dispatch ? "unsupported_schema" : "legacy_unknown");
      } catch { inspection = this.unknown("backend_down"); }
      if (this.closed) return;
      // Re-read CAS, lease, membership and archive after every awaited observation.
      if (this.store.requireProject(d.projectId).archived || this.store.inputState(d.memberId).lease || (this.store.memberRevisions(d.memberId).sessionGeneration !== generationBefore || this.store.requireMember(d.memberId).sessionId !== memberBefore.sessionId || this.store.requireMember(d.memberId).paneId !== memberBefore.paneId)) continue;
      const unchanged = ids.filter(id => this.record(id).version === versions.get(id) && !["resolved", "stopped"].includes(this.record(id).phase));
      const received = new Set(inspection.receivedDeliveryIds);
      this.store.transaction(() => {
        if (dispatch && this.validDispatch(dispatch)) this.settlePhysical(dispatch, inspection);
        for (const id of unchanged) {
          const current = this.store.requireDelivery(id);
          if (received.has(id)) this.received(current, inspection.snapshot?.composer === "matches", inspection.evidence);
          else if (current.status === "delivered" && this.record(id).reason === "duplicate_draft") {
            if (dispatch && this.sameTerminal(dispatch, inspection.snapshot?.identity) && inspection.snapshot?.composer === "empty") this.received(current, false, inspection.evidence);
          } else this.observe(current, dispatch, inspection);
        }
        for (const id of ids) {
          const r = this.record(id);
          if (["resolved", "stopped"].includes(r.phase) && dispatch && ["prepared", "write_started", "unknown"].includes(this.store.getDispatch(dispatch.dispatchId)!.transportState)) this.store.updateDeliveryRecovery(id, r.version, { lastCheckedAt: this.iso() });
        }
      });
      if (!dispatch || !runner?.repairDelivery || !unchanged.length) continue;
      await this.maybeRepair(dispatch, inspection, runner);
    }
  }
  /**
   * An envelope whose every item the CLI's own log shows as a submitted user message has finished writing, even
   * when the writer died before the reply (real 2026-11-07 kill -9 mid-send). Generation 1 otherwise keeps
   * write_started unresolved forever, and that alone fenced the member's whole queue. Only positive per-item
   * provider-log receipt settles it; anything less stays unresolved.
   */
  private settleProvenDispatches(memberId: string): void {
    // 0.2.10: 쓰기 결과를 모르는 봉투만 읽는다(펌프 진입마다 그 팀장의 봉투 이력 전체를 읽었다). 고르는 봉투와 차례는 같다.
    for (const dispatch of this.store.listPhysicalDispatches(memberId)) {
      if (!dispatch.items.length) continue;
      const proven = dispatch.items.every(item => {
        const d = this.store.getDelivery(item.deliveryId), r = this.store.getDeliveryRecovery(item.deliveryId);
        return d?.status === "delivered" && r?.phase === "resolved" && r.evidence.some(e => e.location === "received_input" && e.verdict === "present" && e.source !== "transport");
      });
      // The physical fence exists for a write that may still land. Once its writer is done and every item has been
      // decided another way (received, stopped by the owner, or re-sent in a newer envelope), nothing is left to wait
      // for: '그만 보내기' used to leave the member fenced forever.
      const closed = !proven && this.options.writerDone?.(dispatch) === true && dispatch.items.every(item => {
        const d = this.store.getDelivery(item.deliveryId), r = this.store.getDeliveryRecovery(item.deliveryId);
        return !d || d.status === "delivered" || r?.phase === "stopped" || this.latest(d)?.dispatchId !== dispatch.dispatchId;
      });
      if (proven || closed) this.store.updateDispatch(dispatch.dispatchId, dispatch.transportState, "accepted");
    }
  }
  /** 이 봉투가 마지막 시도이고 아직 정해지지 않은(전달됨·그만 보내기·다시 보내기로 닫히지 않은) 항목. */
  private openItems(dispatch: DeliveryDispatch): Delivery[] {
    const physical = PHYSICAL.includes(dispatch.transportState);
    return dispatch.items.map(item => this.store.getDelivery(item.deliveryId)).filter((d): d is Delivery => !!d && d.status !== "delivered" &&
      !["resolved", "stopped"].includes(this.record(d.id).phase) && (physical || this.logicalFence(d)) && this.latest(d)?.dispatchId === dispatch.dispatchId);
  }

  /**
   * 봉투가 묶인 터미널의 사라짐이 확정된 뒤에만 부른다(엔진이 끝났다고 알렸거나, 그 터미널을 모른다고 확정해 답했다. 답이 없는 것은 확정이 아니다).
   * 그 터미널의 입력칸에 반쯤 들어간 글은 되살아날 수 없으므로 터미널 없이 세션 기록만으로 판정한다:
   * - 수신 표지가 있으면 전달됨으로 확정한다.
   * - 판정 범위를 끝까지 읽었고 표지가 없으면 그 봉투를 거절로 닫고 대기열로 돌린다. 다음 전달이 지금 터미널에 새 봉투로 넣는다.
   *   이미 대표에게 묻고 있던 전달과 자동 재전송을 세 번 한 전달은 스스로 다시 넣지 않고, 대표의 '중복 위험 동의 재전송'을 기다린다.
   * - 대표가 중복 위험에 동의했으면 기록을 끝까지 읽지 못했어도 같은 길로 다시 넣는다(예전에는 터미널이 바뀌면 동의해도 넣지 못했다).
   * - 기록을 읽지 못했으면 대표 확인으로 둔다.
   * 옛 터미널이 살아 있을 수 있는 동안에는 부르지 않는다. 그때는 자동으로도 수동으로도 다른 터미널에 다시 넣지 않는 기존 판정(checkMember)이 그대로다.
   * 잠든 팀장은 건드리지 않는다: 깨어난 뒤의 확인이 같은 판정을 한다.
   */
  settleGoneTerminal(memberId: string, terminalId: string): GoneTerminalSettlement {
    const out: GoneTerminalSettlement = { received: [], requeued: [], undecided: [] };
    const member = this.store.getMember(memberId);
    if (this.closed || !member || member.origin === "manual" || member.status === "asleep" || this.mutations.has(memberId) || this.store.requireProject(member.projectId).archived) return out;
    const runner = this.options.runner(member);
    // 세션 기록을 터미널 없이 읽지 못하는 실행기에서는 아무것도 바꾸지 않는다.
    if (!runner?.inspectGoneDelivery) return out;
    const generation = this.store.memberRevisions(memberId).sessionGeneration;
    this.store.transaction(() => {
      for (const dispatch of this.store.listDispatches(memberId)) {
        if (dispatch.identity.terminalId !== terminalId || dispatch.identity.sessionGeneration !== generation || dispatch.transportState === "rejected") continue;
        const physical = PHYSICAL.includes(dispatch.transportState);
        const open = this.openItems(dispatch);
        if (!physical && !open.length) continue;
        // 이 프로세스의 전송 호출이 아직 돌고 있다. 끝난 뒤의 확인(tick)이 다시 본다.
        if (this.options.writing?.(dispatch)) { out.undecided.push(...open.map(d => d.id)); continue; }
        if (!open.length) {
          // 항목이 모두 다른 길로 정해졌고, 사라진 터미널에는 더 들어갈 것이 없다.
          this.store.updateDispatch(dispatch.dispatchId, dispatch.transportState, "accepted");
          continue;
        }
        let inspection: DeliveryInspection;
        // prepared 는 쓰기 직전에야 write_started 가 된다. 쓴 적이 없으니 기록을 읽을 것도 없다.
        if (dispatch.transportState === "prepared") inspection = { ...this.unknown("not_written"), finding: "not_received" };
        else {
          try { inspection = this.validDispatch(dispatch) ? runner.inspectGoneDelivery!(this.member(member), dispatch) : this.unknown("unsupported_schema"); }
          catch { inspection = this.unknown("file_missing"); }
        }
        const received = new Set(inspection.receivedDeliveryIds);
        for (const d of open) if (received.has(d.id)) { this.received(d, false, inspection.evidence); out.received.push(d.id); }
        const rest = open.filter(d => !received.has(d.id));
        if (!rest.length) {
          if (physical) this.store.updateDispatch(dispatch.dispatchId, dispatch.transportState, "accepted");
          continue;
        }
        const risk = (d: Delivery) => !!this.store.getDeliveryRetry(d.id).retryReason?.startsWith("delivery_risk:");
        const absent = inspection.finding === "not_received" && !received.size;
        // 봉투는 통째로 다시 넣거나 통째로 둔다. 일부만 다시 넣으면 남은 항목의 옛 쓰기를 닫을 근거가 없다.
        const resend = dispatch.transportState === "prepared" || rest.every(risk) || absent && rest.every(d => { const r = this.record(d.id); return r.phase !== "needs_owner" && r.autoAttempts < 3; });
        if (!resend) {
          for (const d of rest) { this.observeGone(d, inspection, absent); out.undecided.push(d.id); }
          continue;
        }
        this.store.updateDispatch(dispatch.dispatchId, dispatch.transportState, "rejected");
        for (const d of rest) {
          const r = this.record(d.id), approved = risk(d);
          this.store.updateDeliveryRecovery(d.id, r.version, { autoAttempts: r.autoAttempts + (approved ? 0 : 1), evidence: inspection.evidence, lastCheckedAt: this.iso() });
          if (!this.requeueRejected(d.id, "gone")) { out.undecided.push(d.id); continue; }
          this.store.appendActivity(memberId, "system", textRef(approved ? "activity.gone_resend_risk" : "activity.gone_resend", { id: d.id }), `${dispatch.dispatchId}:${d.id}:gone_resend`);
          out.requeued.push(d.id);
        }
      }
    });
    if (out.received.length || out.requeued.length) this.store.recheckPendingDelivery(memberId);
    return out;
  }
  /** 사라진 터미널의 봉투를 세션 기록으로 판정하지 못했다(또는 스스로 다시 넣지 않기로 했다). 대표에게 묻는다. */
  private observeGone(d: Delivery, inspection: DeliveryInspection, absent: boolean): void {
    const r = this.record(d.id);
    const code = inspection.evidence[0]?.code ?? "file_missing";
    // 큰 기록을 나눠 읽는 중이다. 묻지 않고 곧 이어 읽는다.
    const scanning = code === "scan_pending" && r.phase !== "needs_owner";
    const reason = absent ? (r.autoAttempts >= 3 ? "retry_exhausted" : "complete_range_without_marker")
      : ["identity_changed", "session_unbound", "unsupported_schema"].includes(code) ? code
      : ["file_missing", "permission_denied"].includes(code) ? "log_missing" : geminiLogReason(inspection.evidence[0]) ?? "log_incomplete";
    this.store.updateDeliveryRecovery(d.id, r.version, { phase: scanning ? "checking" : "needs_owner", reason: scanning ? r.reason ?? "inflight_unsettled" : reason, checkCount: r.checkCount + 1,
      lastCheckedAt: this.iso(), nextCheckAt: this.iso(this.now() + (scanning ? CHECK_MS[0] : 60_000)), evidence: inspection.evidence });
    this.projectStatus(d, "held", scanning ? CHECK_NOTE : note(reason, inspection.evidence));
  }
  /** 지금 터미널이 아닌 터미널에 묶인 미해결 봉투의 터미널들. 엔진에 물어볼 후보다(읽기만 한다, 동기). */
  private strandedTerminals(memberId: string): string[] {
    const member = this.store.getMember(memberId);
    const runner = member ? this.options.runner(member) : null;
    if (!member || member.status === "asleep" || !runner?.terminalGone || !runner.inspectGoneDelivery) return [];
    const generation = this.store.memberRevisions(memberId).sessionGeneration;
    const terminals = new Set<string>();
    // 0.2.10: 봉투 이력 전체 대신 쓰기 결과를 모르는 봉투와 울타리가 될 수 있는 전달을 담은 봉투만 본다. 빠진 봉투는 쓰기가 끝났고 항목이 모두
    // 울타리가 아니어서 openItems 가 언제나 비던 것이다(아래 조건에서 빠졌다). 터미널이 처음 나오는 차례(만든 순서)도 같다.
    for (const dispatch of this.store.listDispatchesTouching(memberId, this.store.listFenceCandidates(memberId).map(d => d.id))) {
      const terminal = dispatch.identity.terminalId;
      if (!terminal || terminal === member.paneId || dispatch.identity.sessionGeneration !== generation || dispatch.transportState === "rejected") continue;
      if (PHYSICAL.includes(dispatch.transportState) || this.openItems(dispatch).length) terminals.add(terminal);
    }
    return [...terminals];
  }
  /**
   * 후보 터미널이 사라졌는지 엔진에 묻고, 사라진 것만 터미널 없이 판정한다. 여기서 다룬 전달의 ID 를 돌려준다(뒤따르는 터미널 조회에서 뺀다).
   * 살아 있거나 답이 없는 터미널의 봉투는 다루지 않는다.
   */
  private async settleGoneTerminals(memberId: string, terminals: string[]): Promise<Set<string>> {
    const handled = new Set<string>();
    for (const terminal of terminals) {
      const member = this.store.getMember(memberId);
      const runner = member ? this.options.runner(member) : null;
      if (this.closed || !runner?.terminalGone) break;
      let gone = false;
      try { gone = await runner.terminalGone(terminal); } catch { /* 답이 없는 것은 사라졌다는 근거가 아니다 */ }
      // 묻는 사이 명부가 그 터미널로 돌아왔으면(다시 붙음) 살아 있는 터미널이다.
      if (!gone || this.closed || this.store.getMember(memberId)?.paneId === terminal) continue;
      const result = this.settleGoneTerminal(memberId, terminal);
      for (const id of [...result.received, ...result.requeued, ...result.undecided]) handled.add(id);
    }
    return handled;
  }
  private settlePhysical(dispatch: DeliveryDispatch, inspection: DeliveryInspection): void {
    const snapshot = inspection.snapshot;
    if (!snapshot || !this.sameTerminal(dispatch, snapshot.identity) || snapshot.ownership !== "verified" || inspection.quiescence !== "settled" || snapshot.originalWrite === "unresolved") return;
    const current = this.store.getDispatch(dispatch.dispatchId)!;
    if (["prepared", "write_started", "unknown"].includes(current.transportState)) this.store.updateDispatch(current.dispatchId, current.transportState, snapshot.originalWrite === "not_written" || snapshot.originalWrite === "rejected" ? "rejected" : "accepted");
  }
  private unknown(code: string): DeliveryInspection {
    return { finding: "unknown", receivedDeliveryIds: [], snapshot: null, quiescence: "unresolved", evidence: [{ source: "transport", verdict: "unknown", location: "none", code, complete: false, checkedAt: this.iso() }] };
  }
  private wait(id: string, reason: string): void {
    const r = this.record(id);
    if (["resolved", "stopped"].includes(r.phase)) return;
    this.store.updateDeliveryRecovery(id, r.version, { phase: r.phase === "needs_owner" ? r.phase : "waiting", reason: r.reason === "duplicate_draft" ? r.reason : reason, nextCheckAt: this.iso(this.now() + 1_000), lastCheckedAt: this.iso() });
  }
  private sameIdentity(a: RunnerTerminalIdentity, b?: RunnerTerminalIdentity): boolean {
    return !!b && a.terminalId === b.terminalId && a.sessionId === b.sessionId && a.sessionGeneration === b.sessionGeneration &&
      (!a.process || !!b.process && a.process.pid === b.process.pid && a.process.startedAt === b.process.startedAt);
  }
  /**
   * 이 봉투의 신원 대조에서 대화(세션) id 를 빼는가. Gemini(Antigravity CLI) 봉투만 그렇다: agy 는 첫 글을 받을 때 대화 id 를 스스로 정해,
   * 첫 전달의 봉투에는 id 가 없고(null) 서버는 그 뒤에야 알게 된다(터미널 안에서 대화를 새로 열면 바뀌기도 한다). id 까지 견주면 결과를 모르는
   * 첫 전달은 언제나 '세션이 바뀜'이 되어 자동으로도, 대표의 동의로도 다시 보낼 수 없다. 세션 세대와 터미널은 그대로 견준다(실행기의 판정과 같다).
   * Claude·Codex 봉투는 지금처럼 세션 id 까지 견준다.
   */
  private sessionFree(dispatch: DeliveryDispatch): boolean { return dispatch.cli === "gemini"; }
  /** 봉투가 묶인 터미널이 지금 본 터미널인가. Claude·Codex 는 sameIdentity 그대로이고, Gemini 봉투는 대화 id 를 빼고 견준다(sessionFree). */
  private sameTerminal(dispatch: DeliveryDispatch, identity?: RunnerTerminalIdentity): boolean {
    if (!this.sessionFree(dispatch)) return this.sameIdentity(dispatch.identity, identity);
    return !!identity && this.sameIdentity({ ...dispatch.identity, sessionId: identity.sessionId }, identity);
  }
  private safe(dispatch: DeliveryDispatch, inspection: DeliveryInspection): boolean {
    const s = inspection.snapshot;
    return !!s && this.sameTerminal(dispatch, s.identity) && s.ownership === "verified" && ["idle", "done"].includes(s.status) && !s.blockedReason && !s.leaseActive && s.mutation === "none" && s.externalInput === false && s.inputEpoch !== null && s.identity.terminalId !== null && inspection.quiescence === "settled" && ["settled", "not_written", "rejected"].includes(s.originalWrite);
  }
  private observe(d: Delivery, dispatch: DeliveryDispatch | null, inspection: DeliveryInspection): void {
    let r = this.record(d.id);
    const s = inspection.snapshot;
    const waiting = s?.leaseActive ? "manual_control" : s?.status === "working" ? "busy" : s?.status === "blocked" ? "blocked" : inspection.finding === "wait" ? inspection.evidence[0]?.code ?? "busy" : null;
    if (waiting) {
      this.wait(d.id, waiting);
      return;
    }
    // Still reading the provider log is progress, not an unanswered check: it does not count toward 'needs owner'.
    const scanning = inspection.evidence[0]?.code === "scan_pending";
    const elapsed = r.lastCheckedAt && r.phase !== "waiting" && !scanning ? Math.max(0, this.now() - Date.parse(r.lastCheckedAt)) : 0;
    const activeCheckMs = Math.min(120_000, r.activeCheckMs + elapsed);
    let reason = inspection.evidence[0]?.code ?? "inflight_unsettled";
    if (["partial_log", "partial_line", "scan_incomplete"].includes(reason)) reason = "log_incomplete";
    if (["file_missing", "permission_denied"].includes(reason)) reason = "log_missing";
    // Gemini(Antigravity CLI): 훅 기록에서 표지를 찾지 못한 까닭도 같은 두 사유로 옮긴다(대표가 다시 보내기를 고를 수 있게).
    reason = geminiLogReason(inspection.evidence[0]) ?? reason;
    if (dispatch && s && !this.sameTerminal(dispatch, s.identity) || s?.status === "gone") reason = "session_lost";
    let phase: DeliveryRecoveryRecord["phase"] = r.phase === "needs_owner" ? "needs_owner" : "checking";
    let nextCheckAt = this.iso(this.now() + (scanning ? CHECK_MS[0] : CHECK_MS[Math.min(r.checkCount, CHECK_MS.length - 1)]));
    const retry = this.store.getDeliveryRetry(d.id);
    const risk = retry.retryReason?.startsWith("delivery_risk:");
    if (dispatch && !this.sourceValid(dispatch, d)) { reason = "source_changed"; phase = "needs_owner"; }
    else if (dispatch && this.safe(dispatch, inspection) && (inspection.finding === "not_received" || risk && inspection.finding === "unknown") && s?.composer === "empty") {
      reason = risk ? "risk_approved" : "not_received";
      if (r.phase === "needs_owner" && !risk || r.autoAttempts >= 3 && !risk) { phase = "needs_owner"; reason = "retry_exhausted"; }
      else {
        phase = "retry_wait";
        // One retry time per envelope: items that fall due apart are probed as a partial bundle and resent late.
        const due = retry.nextAttemptAt ?? dispatch.items.map(item => item.deliveryId !== d.id && this.record(item.deliveryId).phase === "retry_wait" ? this.store.getDeliveryRetry(item.deliveryId).nextAttemptAt : null).find(at => !!at)
          ?? this.iso(this.now() + RETRY_MS[Math.min(r.autoAttempts, 2)] * (1 + 0.2 * Math.min(Math.max(this.random(), 0), 1)));
        this.store.patchDeliveryRetry(d.id, { nextAttemptAt: due });
        nextCheckAt = due;
      }
    } else if (dispatch && this.safe(dispatch, inspection) && inspection.finding === "draft_only" && s?.composer === "matches") {
      reason = "draft_pending";
      if (dispatch.submitAttempts >= 1 || r.phase === "needs_owner") phase = "needs_owner";
    } else if (activeCheckMs >= 120_000 || ["unsupported_schema", "legacy_unknown"].includes(reason)) phase = "needs_owner";
    if (phase === "needs_owner") nextCheckAt = this.iso(this.now() + 60_000);
    r = this.store.updateDeliveryRecovery(d.id, r.version, { phase, reason, activeCheckMs, checkCount: r.checkCount + 1, lastCheckedAt: this.iso(), nextCheckAt, evidence: inspection.evidence });
    this.projectStatus(d, phase === "needs_owner" && reason === "retry_exhausted" ? "failed" : "held", phase === "needs_owner" ? note(reason, inspection.evidence) : CHECK_NOTE);
  }
  private async maybeRepair(original: DeliveryDispatch, inspection: DeliveryInspection, runner: Pick<Runner, "repairDelivery">): Promise<void> {
    if (this.closed || !this.safe(original, inspection) || inspection.receivedDeliveryIds.length && inspection.finding !== "not_received") return;
    const unresolved = original.items.map(item => this.store.requireDelivery(item.deliveryId)).filter(d => !["resolved", "stopped"].includes(this.record(d.id).phase) && d.status !== "delivered");
    if (!unresolved.length) return;
    if (unresolved.some(d => !this.sourceValid(original, d)) || this.store.inputState(original.memberId).unresolvedDispatches.some(other => other.dispatchId !== original.dispatchId && ["prepared", "write_started", "unknown"].includes(other.transportState))) return;
    const action = inspection.finding === "draft_only" ? "submit_only" : inspection.finding === "not_received" || inspection.finding === "unknown" && unresolved.every(d => this.store.getDeliveryRetry(d.id).retryReason?.startsWith("delivery_risk:")) ? "resend" : null;
    if (!action || unresolved.some(d => {
      const r = this.record(d.id);
      return action === "resend" ? r.phase !== "retry_wait" || !this.store.getDeliveryRetry(d.id).nextAttemptAt || Date.parse(this.store.getDeliveryRetry(d.id).nextAttemptAt!) > this.now() : r.phase !== "checking" || r.reason !== "draft_pending";
    })) return;
    let dispatch = original;
    if (action === "submit_only" && unresolved.length !== original.items.length) return;
    const s = inspection.snapshot!;
    let request!: DeliveryRepair;
    // The new envelope is kept only when the write can be handed to the runner now. While it could not be
    // (turn cap, outage hold, retry interval), every check used to leave one more never-written envelope.
    const refused = new Error("repair not admitted");
    let admitted = true;
    try {
      this.store.transaction(() => {
        if (action === "resend") {
          // Every attempt has its own envelope so a late result can only settle its own RPC.
          // Delivery IDs/markers remain stable, and this new subset has never been written.
          this.settlePhysical(original, inspection);
          dispatch = this.saveEnvelope(unresolved, original.identity, original.baseline, "prepared");
        }
        // A bundle uses one reviewed CAS version. Store increments can differ after partial corrections;
        // align with no-op CAS updates rather than weakening the runner's exact version check.
        const version = Math.max(...unresolved.map(d => this.record(d.id).version));
        for (const d of unresolved) while (this.record(d.id).version < version) this.store.updateDeliveryRecovery(d.id, this.record(d.id).version, {});
        request = { action, dispatchId: dispatch.dispatchId, expectedRecoveryVersion: version, expectedSessionGeneration: s.identity.sessionGeneration,
          expectedSessionId: s.identity.sessionId, expectedTerminalId: s.identity.terminalId!, expectedInputEpoch: s.inputEpoch! };
        admitted = this.options.admit?.(dispatch.memberId) !== false;
        if (!admitted || !this.loadRepair(dispatch.memberId, request)) throw refused;
      });
    } catch (error) {
      if (error !== refused) throw error;
      if (!admitted) for (const d of unresolved) this.wait(d.id, "busy");
      return;
    }
    this.mutations.add(dispatch.memberId);
    try {
      let result: SendResult;
      try { result = await runner.repairDelivery!(this.member(this.store.requireMember(dispatch.memberId)), request); }
      catch { result = { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" }; }
      // A supported adapter must have durably prepared the write under its input mutex.
      const after = this.store.getDispatch(dispatch.dispatchId)!;
      if (after.transportState === "write_started") this.recordResult(dispatch.dispatchId, result);
      else if (!result.ok && result.retryable) {
        for (const d of unresolved) this.wait(d.id, "busy");
      } else if (!result.ok) {
        // Adapters may refuse unsupported recovery (for example an unverified key).
        // A reservation is not a success, nor a reason to spin retry every tick.
        this.store.transaction(() => {
          for (const d of unresolved) {
            const r = this.record(d.id);
            if (r.phase !== "stopped" && r.phase !== "resolved") this.store.updateDeliveryRecovery(d.id, r.version, { phase: "needs_owner", reason: "unsupported_schema", nextCheckAt: this.iso(this.now() + 60_000) });
            this.store.patchDeliveryRetry(d.id, { retryReason: null, nextAttemptAt: null });
          }
        });
      }
    } finally { this.mutations.delete(dispatch.memberId); }
  }

  private actions(d: Delivery, r: DeliveryRecoveryRecord): DeliveryNoticeItem["allowedActions"] {
    if (["queued", "held"].includes(d.status) && !["needs_owner", "stopped"].includes(r.phase)) return ["recheck", "stop_retry"];
    if (["resolved", "stopped", "none"].includes(r.phase)) return [];
    if (r.phase !== "needs_owner") return ["recheck", "stop_retry"];
    if (r.reason === "duplicate_draft") return ["recheck", "stop_retry"];
    const dispatch = this.latest(d);
    const retry = dispatch && this.validDispatch(dispatch) && this.sourceValid(dispatch, d) && (["retry_exhausted", "log_missing", "log_incomplete", "unsupported_schema"].includes(r.reason ?? "") || r.evidence.some(e => e.code === "complete_range_without_marker" && e.verdict === "absent" && e.complete)) && this.store.memberRevisions(d.memberId).sessionGeneration === dispatch.identity.sessionGeneration && (this.sessionFree(dispatch) || this.store.requireMember(d.memberId).sessionId === dispatch.identity.sessionId);
    return retry ? ["recheck", "retry_with_risk", "stop_retry"] : ["recheck", "stop_retry"];
  }

  /** Legacy same-message retry materializes a held row; it never starts a new send. */
  materializeLegacyMessage(messageId: string): Delivery {
    return this.store.transaction(() => {
      const m = this.store.requireMessage(messageId);
      this.activeProject(m.projectId);
      const existing = this.store.listDeliveriesByRef("message", m.id, m.projectId).at(-1);
      if (existing) return existing;
      const member = m.targetMemberId && this.store.getMember(m.targetMemberId);
      if (!m.mine || m.delivery !== "failed" || !member || member.projectId !== m.projectId) throw new ApiError(409, "옛 메시지의 수신자를 확정할 수 없습니다", "legacy_message_recipient_unknown");
      const d = this.store.enqueue({ projectId: m.projectId, memberId: member.id, kind: "user_message", text: m.body, refType: "message", refId: m.id, status: "held", holdReason: "delivery_unknown" });
      this.beginRecovery(d.id, "legacy_unknown");
      return this.store.requireDelivery(d.id);
    });
  }

  /** Explicit owner choice: never infer a recipient while reading legacy failures. */
  recoverUnassignedMessage(messageId: string, request: UnassignedRecoveryRequest): UnassignedRecoveryResult {
    if (!z.strictObject({ operationId: z.uuid(), expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      action: z.enum(["send_to_conductor", "dismiss"]) }).safeParse(request).success) throw new ApiError(400, "메시지 정리 요청이 올바르지 않습니다", "message_cleanup_invalid");
    return this.store.transaction(() => {
      const m = this.store.requireMessage(messageId);
      if (this.store.requireProject(m.projectId).archived) throw new ApiError(409, "보관 중인 프로젝트의 메시지는 정리할 수 없습니다", "message_cleanup_archived");
      return this.store.unassignedMessageOperation<UnassignedRecoveryResult>(messageId, request.operationId, request, request.action, () => {
        if (this.closed || request.expectedVersion !== 0 || !m.mine || m.delivery !== "failed" ||
          this.store.listDeliveriesByRef("message", m.id, m.projectId).length > 0) throw new ApiError(409, "메시지 상태가 바뀌었습니다. 다시 확인해 주세요", "message_state_changed");
        const target = m.targetMemberId && this.store.getMember(m.targetMemberId);
        if (request.action === "dismiss") {
          this.store.setMessageDelivery(m.id, "dismissed");
          return { memberId: null, result: { operationId: request.operationId, messageId, deliveryId: null, outcome: "dismissed" as const, committedVersion: 1 } };
        }
        if (target && target.projectId === m.projectId) throw new ApiError(409, "이미 수신자가 지정된 메시지입니다", "message_recipient_set");
        const member = this.store.getConductor(m.projectId);
        if (!member) throw new ApiError(409, "프로젝트에 현재 총괄이 없습니다", "project_no_lead");
        const d = this.store.enqueue({ projectId: m.projectId, memberId: member.id, kind: "user_message", text: this.options.legacyMessageText?.(m) ?? m.body,
          refType: "message", refId: m.id });
        this.store.setMessageDelivery(m.id, "queued");
        this.store.recheckPendingDelivery(member.id);
        return { memberId: member.id, result: { operationId: request.operationId, messageId, deliveryId: d.id, outcome: "send_scheduled" as const, committedVersion: 1 } };
      });
    });
  }

  private definitelyAbsent(d: Delivery): boolean {
    const r = this.record(d.id);
    return ["not_received", "retry_exhausted"].includes(r.reason ?? "") || r.phase === "none" && ["queued", "held"].includes(d.status) && d.holdReason !== "delivery_unknown";
  }
  private item(d: Delivery, previews: Map<string, string>): DeliveryNoticeItem | null {
    const r = this.record(d.id);
    if (r.phase === "resolved" && !(r.reason === "not_received" && ["queued", "held"].includes(d.status)) || r.phase === "stopped" || d.status === "delivered" && r.reason !== "duplicate_draft") return null;
    const wait = this.store.deliveryWait(d);
    const stalled = wait.waitReason === "unknown" && this.store.deliveryStalled(d.id) && ["none", "resolved"].includes(r.phase);
    const sourceKey = `${d.refType}:${d.refId}`;
    const preview = previews.get(sourceKey) ?? ({ user_message: "대표 메시지", answer: "결재 답변", todo_done: "업무 완료 알림", instruction: "업무 지시", report: "보고 전달", system: "시스템 지시", compact: "문맥 정리" }[d.kind]);
    return { ...wait, id: d.id, deliveryId: d.id, messageId: d.refType === "message" && previews.has(sourceKey) ? d.refId : null, memberId: d.memberId, projectId: d.projectId, kind: d.kind, status: d.status,
      phase: stalled ? "needs_owner" : r.phase === "resolved" ? "none" : r.phase, holdReason: d.holdReason, reason: stalled ? "stalled" : r.reason, note: wait.waitReason === "api_outage" ? ERROR_CODES.note_after_api_outage.ko : wait.waitReason === "usage_limit" ? ERROR_CODES.note_after_usage_limit.ko : stalled ? ERROR_CODES.note_stalled.ko : r.phase === "none" ? d.status === "failed" ? note("legacy_unknown") : ERROR_CODES.note_queued.ko : note(r.reason, r.evidence),
      version: r.version, createdAt: d.createdAt, lastCheckedAt: r.lastCheckedAt, nextCheckAt: r.nextCheckAt, autoAttempts: r.autoAttempts, evidence: r.evidence,
      recommendation: stalled ? { code: "recheck", text: ERROR_CODES.note_recheck.ko } : r.phase === "needs_owner" ? { code: r.reason ?? "unknown", text: note(r.reason, r.evidence) } : null, allowedActions: stalled ? ["recheck", "stop_retry"] : this.actions(d, r),
      ref: d.refType && d.refId ? { type: d.refType, id: d.refId } : null, preview: preview.length > 160 ? preview.slice(0, 157) + "..." : preview };
  }
  private items(projectId: string, includePreviews = true): DeliveryNoticeItem[] {
    return this.store.withDeliveryRead(projectId, () => this.readItems(projectId, includePreviews));
  }
  /**
   * 0.2.10: 알림이 될 수 있는 살아 있는 전달(Store.listLiveDeliveries)만 돈다. 전달되고 확인이 끝난 이력은 item() 이 언제나 null 이라 읽지 않는다.
   * 같은 팀장·같은 원문·같은 판을 뒤에 다시 보낸 것이 있는 실패는 숨긴다(예전에는 이력 전체에서 키마다 마지막 전달을 골랐다. hasLaterSameSource 가 같은 답).
   */
  private readItems(projectId: string, includePreviews: boolean): DeliveryNoticeItem[] {
    const deliveries = this.store.listLiveDeliveries(projectId);
    const previews = includePreviews ? this.store.deliveryNoticePreviews(projectId, deliveries) : new Map<string, string>();
    const items: DeliveryNoticeItem[] = [];
    for (const d of deliveries) {
      if (d.status === "failed" && this.definitelyAbsent(d) && this.store.hasLaterSameSource(d)) continue;
      const item = this.item(d, previews);
      if (item) items.push(item);
    }
    for (const m of this.store.listUnlinkedFailedMessages(projectId)) items.push(this.virtual(m));
    return items;
  }
  private virtual(m: Message): DeliveryNoticeItem {
    const member = m.targetMemberId && this.store.getMember(m.targetMemberId);
    return { id: `message:${m.id}`, deliveryId: null, messageId: m.id, memberId: member && member.projectId === m.projectId ? member.id : "", projectId: m.projectId,
      kind: "user_message", status: "failed", phase: "needs_owner", holdReason: null, reason: "legacy_unknown", note: note("legacy_unknown"), version: 0,
      createdAt: m.at, lastCheckedAt: null, nextCheckAt: null, autoAttempts: 0, evidence: [], recommendation: { code: "legacy_unknown", text: "대표가 전달하거나 정리할 수 있습니다" }, allowedActions: member && member.projectId === m.projectId ? ["dismiss"] : ["send_to_conductor", "dismiss"], ref: { type: "message", id: m.id }, preview: m.body.length > 160 ? m.body.slice(0, 157) + "..." : m.body };
  }
  private summarize(memberId: string, items: DeliveryNoticeItem[]): MemberDeliverySummary {
    const summary: MemberDeliverySummary = { memberId, undeliveredCount: 0, unknownCount: 0, deliveringCount: 0, checkingCount: 0, needsOwnerCount: 0, waitingBehindCount: 0, oldestAt: null, reasons: [], waitReason: null, waitingSince: null, waitReasons: [] };
    // Store delivery order is insertion order; equal timestamps must not reorder the queue.
    const own = items.filter(item => item.memberId === memberId);
    let fence = false;
    for (const item of own) {
      const absent = item.deliveryId ? this.definitelyAbsent(this.store.requireDelivery(item.deliveryId)) : false;
      if (item.status !== "delivered") {
        if (item.status === "delivering") summary.deliveringCount++;
        else if (absent) summary.undeliveredCount++;
        else summary.unknownCount++;
      }
      if (["checking", "waiting", "retry_wait"].includes(item.phase)) summary.checkingCount++;
      if (item.phase === "needs_owner") summary.needsOwnerCount++;
      if (fence && item.phase === "none" && ["held", "queued"].includes(item.status)) summary.waitingBehindCount++;
      if (item.reason !== "stalled" && (item.phase !== "none" || item.status === "delivering" || item.holdReason === "delivery_unknown")) fence = true;
      if (summary.oldestAt === null || compare(item.createdAt, summary.oldestAt) < 0) summary.oldestAt = item.createdAt;
      if (item.waitReason && item.waitingSince) {
        const wait = summary.waitReasons!.find(wait => wait.waitReason === item.waitReason);
        if (wait) { wait.count++; if (item.waitingSince < wait.waitingSince) wait.waitingSince = item.waitingSince; }
        else summary.waitReasons!.push({ waitReason: item.waitReason, waitingSince: item.waitingSince, ...(item.runLimit ? { runLimit: item.runLimit } : {}), count: 1 });
        if (!summary.waitingSince || item.waitingSince < summary.waitingSince) {
          summary.waitReason = item.waitReason; summary.waitingSince = item.waitingSince; summary.runLimit = item.runLimit;
        }
      }
      if (item.reason) {
        const reason = summary.reasons.find(reason => reason.code === item.reason);
        if (reason) reason.count++; else summary.reasons.push({ code: item.reason, count: 1, note: note(item.reason) });
      }
    }
    return summary;
  }
  notices(projectId: string): DeliveryNotices {
    return this.store.transaction(() => this.store.withDeliveryRead(projectId, () => {
      this.activeProject(projectId);
      const items = this.items(projectId, false);
      const unassigned = this.summarize("", items);
      return { version: 2, unassignedItems: items.filter(item => item.memberId === ""), reportNotices: this.store.listMissingReportNotices(projectId), members: this.store.listMembers(projectId).map(m => this.summarize(m.id, items)), unassigned: { undeliveredCount: unassigned.undeliveredCount, unknownCount: unassigned.unknownCount, needsOwnerCount: unassigned.needsOwnerCount } };
    }));
  }
  memberNotices(memberId: string, opts: DeliveryNoticePageOptions = {}): DeliveryNoticePage {
    return this.store.transaction(() => this.store.withDeliveryRead(this.store.requireMember(memberId).projectId, () => {
      const member = this.store.requireMember(memberId);
      this.activeProject(member.projectId);
      const limit = opts.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "조회 개수가 올바르지 않습니다", "invalid_limit");
      let before: { createdAt: string; id: string } | null = null;
      if (opts.before !== undefined) {
        try {
          if (!opts.before || opts.before.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(opts.before)) throw new Error("cursor");
          const bytes = Buffer.from(opts.before, "base64url");
          if (bytes.toString("base64url") !== opts.before) throw new Error("cursor");
          const cursor = z.strictObject({ v: z.literal(1), memberId: z.literal(memberId), createdAt: z.string().min(1).max(128), id: z.string().min(1).max(512) }).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
          before = cursor;
        } catch { throw new ApiError(400, "전달 조회 위치가 올바르지 않습니다", "invalid_delivery_cursor"); }
      }
      const all = this.items(member.projectId);
      const sorted = all.filter(item => item.memberId === memberId).sort((a, b) => compare(b.createdAt, a.createdAt) || compare(b.id, a.id));
      const page = sorted.filter(item => !before || compare(item.createdAt, before.createdAt) < 0 || item.createdAt === before.createdAt && compare(item.id, before.id) < 0).slice(0, limit + 1);
      const items = page.slice(0, limit);
      const tail = items.at(-1);
      return { memberId, summary: this.summarize(memberId, all), items, nextBefore: page.length > limit && tail ? Buffer.from(JSON.stringify({ v: 1, memberId, createdAt: tail.createdAt, id: tail.id })).toString("base64url") : null };
    }));
  }
  async shutdown(): Promise<void> { this.closed = true; await this.running; }
}
