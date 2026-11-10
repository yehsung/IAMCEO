import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { memberConfig, type Delivery, type DeliveryEvidence, type DeliveryNoticeItem, type DeliveryNoticePage, type DeliveryNoticePageOptions, type DeliveryNotices, type DeliveryRecoveryRequest, type DeliveryRecoveryResult, type Member, type MemberDeliverySummary, type Message, type UnassignedRecoveryRequest, type UnassignedRecoveryResult } from "../shared/types.ts";
import { ApiError, type Store } from "./store.ts";
import type { DeliveryDispatch, DeliveryRecoveryRecord, DeliveryRecoveryService } from "./service-contracts.ts";
import type { DeliveryBaseline, DeliveryInspection, DeliveryRepair, Runner, RunnerMember, RunnerTerminalIdentity, SendResult } from "./runner/types.ts";

/** SQL, cursors and transactions belong exclusively to Store. */
export type DeliveryRecoveryStore = Pick<Store,
  "legacyAssignedMember" | "getConductor" | "unassignedMessageOperation" | "setNeedsOwnerCounter" | "transaction" | "afterCommit" | "requireProject" | "listProjects" | "requireMember" | "getMember" | "listMembers" | "memberRevisions" | "getSettings" |
  "listDeliveries" | "requireDelivery" | "getDelivery" | "enqueue" | "getDeliveryRecovery" | "updateDeliveryRecovery" | "listDeliveryRecoveries" |
  "withDeliveryRead" | "deliveryNoticePreviews" | "listUnlinkedFailedMessages" | "listDeliveryRecoveryCandidates" | "hasDeliveryAttention" |
  "getDeliveryRetry" | "patchDeliveryRetry" | "saveDispatch" | "getDispatch" | "listDispatches" | "updateDispatch" | "inputState" |
  "deliveryRecoveryOperation" | "markDelivered" | "markHeld" | "markFailed" | "setDeliveryStatus" | "setMessageDelivery" |
  "listMissingReportNotices" | "deliveryWait" | "detectDeliveryStalls" | "deliveryStalled" | "recheckPendingDelivery" | "getMessage" | "requireMessage" | "listMessagePage" | "getDecision" | "setDecisionStatus" | "getTodo" | "todoRevision" | "appendActivity">;

export interface DeliveryRecoveryOptions {
  store: DeliveryRecoveryStore;
  runner: (member: Member) => Pick<Runner, "inspectDelivery" | "repairDelivery"> | null;
  legacyMessageText?: (message: Message) => string;
  now?: () => number;
  random?: () => number;
}

const MAX_REJECTED = 5;
const CHECK_MS = [1_000, 3_000, 10_000, 30_000, 60_000];
const RETRY_MS = [2_000, 10_000, 30_000];
const STOP_NOTE = "추가 전달을 중지했습니다. 과거 수신 여부는 알 수 없습니다";
const CHECK_NOTE = "전달 여부를 시스템이 확인하고 있습니다";
const requestSchema = z.discriminatedUnion("action", [
  z.strictObject({ operationId: z.uuid(), expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), action: z.literal("recheck") }),
  z.strictObject({ operationId: z.uuid(), expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), action: z.literal("stop_retry") }),
  z.strictObject({ operationId: z.uuid(), expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), action: z.literal("retry_with_risk"), acceptDuplicateRisk: z.literal(true) }),
]);

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function compare(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
function note(reason: string | null, evidence: DeliveryEvidence[] = []): string {
  switch (reason) {
    case "manual_control": return "직접 조작이 끝나면 다시 확인합니다";
    case "stale_instruction": return "오래된 미전달 지시입니다. 지금 다시 시도하거나 그만 보내세요";
    case "input_busy": return "직원의 입력칸이 비기를 기다리는 중입니다";
    case "busy": return "받을 수 있을 때 다시 확인합니다";
    case "blocked": return "승인 창이 닫히면 다시 확인합니다";
    case "duplicate_draft": return "이미 받은 지시가 입력칸에도 남아 있습니다. 초안을 확인해 주세요";
    case "source_changed": return "원본이 변경되어 다시 보내지 않습니다. 수신 여부는 계속 확인합니다";
    case "retry_exhausted": return "자동 재전송 상한에 도달했습니다";
    case "not_received": return "미전달을 확인했습니다. 안전 상태를 다시 확인한 뒤 재전송합니다";
    case "draft_pending": return "입력 제출을 확인 중입니다";
    case "session_lost": return "세션이나 터미널이 바뀌어 이전 입력의 결과를 이어서 확인하지 못했습니다. 같은 대화인지 터미널과 연결 상태를 확인해 주세요";
    case "session_unbound": return "CLI의 대화 연결을 아직 확인하지 못했습니다. 터미널에서 세션이 열렸는지 확인한 뒤 다시 확인해 주세요";
    case "unsupported_schema": return "이 실행기에서는 안전한 전달 확인을 지원하지 않습니다";
    case "log_missing": return "세션 기록을 찾지 못했습니다. 연결과 기록 경로를 확인한 뒤 다시 확인해 주세요";
    case "log_incomplete": return "기록을 끝까지 읽지 못해 수신 여부를 확정하지 못했습니다. 다시 확인하거나 터미널에서 확인해 주세요";
    case "identity_changed": return "세션이 다시 열려 이전 입력의 결과를 이어서 확인하지 못했습니다. 같은 대화인지 터미널에서 확인한 뒤 다시 확인해 주세요";
    case "complete_range_without_marker": return evidence.some(e => e.location === "composer" && e.code === "different")
      ? "기록상 아직 안 들어갔습니다. 입력칸에 다른 글이 있어 자동으로 넣지 않았습니다. 입력칸을 비운 뒤 다시 확인하거나 중복 위험에 동의해 다시 보내세요"
      : "기록상 아직 안 들어갔습니다. 자동 재전송의 안전 조건을 확인하지 못했습니다. 터미널을 확인한 뒤 중복 위험에 동의해 다시 보낼 수 있습니다";
    case "legacy_unknown": return "옛 전달의 수신 여부를 확인할 수 없습니다";
    case "inflight_unsettled": return "원래 입력의 종료 여부를 확인하고 있습니다";
    default: return "입력 결과를 아직 확정하지 못했습니다. 터미널과 연결을 확인한 뒤 다시 확인해 주세요";
  }
}

/** No background timer is started: the host owns the tick timer and shutdown. */
export class DeliveryRecovery implements DeliveryRecoveryService {
  private readonly store: DeliveryRecoveryStore;
  private readonly now: () => number;
  private readonly random: () => number;
  private running: Promise<void> | null = null;
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
    if (!record) throw new ApiError(409, "전달 복구 상태가 없습니다");
    return record;
  }
  private activeProject(id: string): void {
    if (this.store.requireProject(id).archived) throw new ApiError(404, "프로젝트를 찾을 수 없습니다");
  }
  private latest(delivery: Delivery): DeliveryDispatch | null {
    return this.store.listDispatches(delivery.memberId).filter(d => d.items.some(item => item.deliveryId === delivery.id)).at(-1) ?? null;
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
    return { ...member, ...memberConfig(member, settings.ranks, settings.codexRanks), sessionGeneration: this.store.memberRevisions(member.id).sessionGeneration,
      subagentModel: (member.cli === "codex" ? settings.codexRanks : settings.ranks).staff.model, permissionMode: settings.permissionMode };
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

  /** Also used by ordinary and urgent admission. stopped releases only the logical fence. */
  fenced(memberId: string): boolean {
    this.settleProvenDispatches(memberId);
    return this.store.withDeliveryRead(this.store.requireMember(memberId).projectId, () => {
      const state = this.store.inputState(memberId);
      return !!state.lease || this.mutations.has(memberId) || state.unresolvedDispatches.some(d => ["prepared", "write_started", "unknown"].includes(d.transportState)) ||
        this.store.listDeliveries(this.store.requireMember(memberId).projectId).some(d => d.memberId === memberId && this.logicalFence(d));
    });
  }
  private logicalFence(d: Delivery): boolean {
    const r = this.record(d.id);
    return !(r.phase === "waiting" && r.reason === "input_busy" || r.phase === "needs_owner" && r.reason === "stale_instruction") && !["none", "resolved", "stopped"].includes(r.phase) || (r.phase === "none" && (d.status === "delivering" || d.status === "held" && d.holdReason === "delivery_unknown"));
  }

  prepareDispatch(deliveryIds: string[], identity: RunnerTerminalIdentity, baseline: DeliveryBaseline): DeliveryDispatch {
    return this.store.transaction(() => {
      if (!deliveryIds.length || new Set(deliveryIds).size !== deliveryIds.length) throw new ApiError(400, "봉투 항목이 올바르지 않습니다");
      const deliveries = deliveryIds.map(id => this.store.requireDelivery(id));
      const first = deliveries[0];
      this.activeProject(first.projectId);
      const member = this.store.requireMember(first.memberId);
      if (this.closed || !this.store.requireProject(member.projectId).runnerEnabled || this.fenced(member.id) || member.origin === "manual" || identity.terminalId !== member.paneId || identity.sessionId !== member.sessionId || identity.sessionGeneration !== this.store.memberRevisions(member.id).sessionGeneration) throw new ApiError(409, "입력 안전 상태가 바뀌었습니다");
      for (const d of deliveries) {
        const previous = this.latest(d), phase = this.record(d.id).phase;
        const admissible = previous
          ? previous.transportState === "rejected" && (["none", "resolved"].includes(phase) || phase === "waiting" && this.record(d.id).reason === "input_busy")
          : d.attempts === 0 && phase === "none";
        if (d.memberId !== first.memberId || d.projectId !== first.projectId || d.kind === "compact" || !["queued", "held"].includes(d.status) || !admissible || this.sourceRevision(d) === null) throw new ApiError(409, "새 전달 봉투를 만들 수 없습니다");
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
    const createdAt = this.iso(Math.max(this.now(), Date.parse(this.store.listDispatches(member.id).at(-1)?.createdAt ?? this.iso())));
    const dispatch: DeliveryDispatch = { dispatchId: randomUUID(), memberId: first.memberId, projectId: first.projectId,
      cli: member.cli, backend: member.backend ?? "core", identity, baseline, markers, bundleMarker, wireText,
      wireSha256: createHash("sha256").update(wireText).digest("hex"), items: deliveries.map((d, ordinal) => ({ deliveryId: d.id, ordinal, sourceRevision: this.sourceRevision(d) })),
      transportState, submitAttempts: 0, createdAt, updatedAt: this.iso() };
    if (!this.validDispatch(dispatch)) throw new ApiError(409, "전달 봉투의 기준선이나 신원을 확인할 수 없습니다");
    this.store.saveDispatch(dispatch);
    for (const item of dispatch.items) this.store.patchDeliveryRetry(item.deliveryId, { sourceRevision: item.sourceRevision });
    return dispatch;
  }

  private rejectedCount(d: Delivery): number {
    let count = 0;
    for (const dispatch of this.store.listDispatches(d.memberId).filter(x => x.items.some(i => i.deliveryId === d.id)).reverse()) {
      if (dispatch.transportState !== "rejected") break;
      count++;
    }
    return count;
  }

  /** A durable pre-write refusal needs no log, identity or quiescence evidence. */
  requeueRejected(deliveryId: string): boolean {
    return this.store.transaction(() => {
      const d = this.store.requireDelivery(deliveryId), r = this.record(deliveryId);
      if (this.latest(d)?.transportState !== "rejected" || d.status === "delivered" || r.phase === "stopped") return false;
      if (r.phase === "needs_owner" && r.reason === "stale_instruction") return false;
      if (r.phase === "resolved" && r.reason === "not_received" || r.phase === "waiting" && r.reason === "input_busy") return true;
      const exhausted = this.rejectedCount(d) >= MAX_REJECTED;
      const nextAttemptAt = exhausted ? this.iso(this.now() + [30_000, 60_000, 120_000, 300_000][Math.min(this.rejectedCount(d) - MAX_REJECTED, 3)]!) : null;
      this.store.updateDeliveryRecovery(d.id, r.version, { phase: exhausted ? "waiting" : "resolved", reason: exhausted ? "input_busy" : "not_received", nextCheckAt: null });
      this.store.setDeliveryStatus(d.id, exhausted ? "held" : "queued", { holdReason: exhausted ? "input_busy" : null });
      this.store.patchDeliveryRetry(d.id, { nextAttemptAt, retryReason: exhausted ? "input_busy" : null });
      if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, exhausted ? "held" : "queued", exhausted ? "직원의 입력칸이 비기를 기다리는 중입니다" : null);
      return true;
    });
  }

  beginRecovery(deliveryId: string, reason = "inflight_unsettled"): void {
    this.store.transaction(() => {
      const d = this.store.requireDelivery(deliveryId);
      const r = this.record(deliveryId);
      if (this.requeueRejected(deliveryId)) return;
      if (["resolved", "stopped"].includes(r.phase) || d.status === "delivered") return;
      this.store.updateDeliveryRecovery(d.id, r.version, { phase: r.phase === "needs_owner" ? "needs_owner" : "checking", reason: r.phase === "needs_owner" ? r.reason : reason, nextCheckAt: this.iso() });
      this.projectStatus(d, "held", CHECK_NOTE);
    });
  }
  private projectStatus(d: Delivery, status: "held" | "delivered" | "failed", message: string | null): void {
    this.store.setDeliveryStatus(d.id, status, { holdReason: status === "held" ? "delivery_unknown" : undefined, lastError: status === "failed" ? message : undefined });
    // A newer attempt for the same source must not be overwritten by an old result.
    const dispatch = this.latest(d);
    const deliveries = this.store.listDeliveries(d.projectId);
    if (d.refType === "message" && d.refId && this.store.getMessage(d.refId) && (!dispatch || this.sourceValid(dispatch, d)) && !deliveries.slice(deliveries.findIndex(item => item.id === d.id) + 1).some(other => other.refType === d.refType && other.refId === d.refId && other.memberId === d.memberId)) {
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
      this.store.appendActivity(d.memberId, "system", `전달 기록에서 수신을 확인해 표시를 바로잡았습니다 (${d.id})`, `${d.id}:received`);
    }
    this.store.updateDeliveryRecovery(d.id, r.version, { phase: duplicate ? "needs_owner" : "resolved", reason: duplicate ? "duplicate_draft" : null,
      evidence, nextCheckAt: duplicate ? this.iso(this.now() + 60_000) : null, lastCheckedAt: this.iso() });
    this.store.patchDeliveryRetry(d.id, { nextAttemptAt: null, retryReason: null });
  }

  /** Late failures can settle physical writes, but cannot regress delivered/stopped decisions. */
  recordResult(dispatchId: string, result: SendResult): void {
    this.store.transaction(() => {
      const dispatch = this.store.getDispatch(dispatchId);
      if (!dispatch) throw new ApiError(404, "전달 봉투를 찾을 수 없습니다");
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
        if (this.latest(d)?.dispatchId === dispatchId && !["resolved", "stopped"].includes(this.record(d.id).phase)) this.beginRecovery(d.id);
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
        this.store.appendActivity(memberId, "system", `${request.action === "submit_only" ? "입력칸의 지시를 다시 넣지 않고 제출합니다" : retry.retryReason?.startsWith("delivery_risk:") ? "중복 위험 동의를 받아 지시를 재전송합니다" : "미전달을 확인해 같은 지시를 자동 재전송합니다"} (${item.deliveryId})`, `${current.dispatchId}:${item.deliveryId}:${request.action}:${r.autoAttempts + 1}`);
      }
      this.store.updateDispatch(current.dispatchId, current.transportState, "write_started", request.action === "submit_only");
      return true;
    }),
  };
  private loadRepair(memberId: string, request: DeliveryRepair): DeliveryDispatch | null {
    const dispatch = this.store.getDispatch(request.dispatchId);
    const member = this.store.getMember(memberId);
    if (!dispatch || !this.validDispatch(dispatch) || !member || dispatch.memberId !== memberId || (this.store.requireProject(member.projectId).archived || !this.store.requireProject(member.projectId).runnerEnabled) || this.store.inputState(memberId).lease || dispatch.identity.sessionGeneration !== this.store.memberRevisions(memberId).sessionGeneration || dispatch.identity.sessionId !== member.sessionId || dispatch.identity.terminalId !== member.paneId || request.expectedSessionGeneration !== dispatch.identity.sessionGeneration || request.expectedSessionId !== dispatch.identity.sessionId || request.expectedTerminalId !== dispatch.identity.terminalId) return null;
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
    if (this.store.listDeliveries(member.projectId).some(d => d.memberId === memberId && !dispatch.items.some(item => item.deliveryId === d.id) && this.logicalFence(d))) return null;
    return dispatch;
  }

  async recover(deliveryId: string, request: DeliveryRecoveryRequest): Promise<DeliveryRecoveryResult> {
    if (!requestSchema.safeParse(request).success) throw new ApiError(400, "전달 복구 요청이 올바르지 않습니다");
    const d = this.store.requireDelivery(deliveryId);
    this.activeProject(d.projectId);
    return this.store.deliveryRecoveryOperation(deliveryId, request.operationId, request, () => {
      const r = this.record(deliveryId);
      if (["recheck", "stop_retry"].includes(request.action) && ["queued", "held"].includes(d.status) && r.phase !== "stopped" && (!this.latest(d) || this.latest(d)?.transportState === "rejected")) {
        if (this.closed || r.version !== request.expectedVersion || this.mutations.has(d.memberId)) throw new ApiError(409, "전달 상태가 바뀌었습니다. 다시 확인해 주세요");
        const next = this.store.updateDeliveryRecovery(d.id, r.version, { phase: request.action === "stop_retry" ? "stopped" : this.latest(d) ? "resolved" : "none", reason: this.latest(d) ? "not_received" : null, lastCheckedAt: this.iso(), nextCheckAt: null });
        if (request.action === "stop_retry") {
          this.projectStatus(d, "failed", STOP_NOTE);
          this.store.patchDeliveryRetry(d.id, { nextAttemptAt: null, retryReason: null });
        } else {
          this.store.patchDeliveryRetry(d.id, { nextAttemptAt: null, retryReason: null });
          this.store.recheckPendingDelivery(d.memberId);
        }
        return { operationId: request.operationId, deliveryId, outcome: request.action === "stop_retry" ? "stopped" : "check_scheduled", committedVersion: next.version };
      }
      if (this.closed || r.version !== request.expectedVersion || ["resolved", "stopped"].includes(r.phase) || r.phase === "none" || this.mutations.has(d.memberId)) throw new ApiError(409, "전달 상태가 바뀌었습니다. 다시 확인해 주세요");
      if (request.action !== "recheck" && !this.actions(d, r).includes(request.action)) throw new ApiError(409, "전달 상태가 바뀌었습니다. 다시 확인해 주세요");
      const next = this.store.updateDeliveryRecovery(d.id, r.version, request.action === "stop_retry"
        ? { phase: "stopped", nextCheckAt: null }
        : { phase: request.action === "recheck" && r.phase === "needs_owner" ? "needs_owner" : "checking", reason: request.action === "retry_with_risk" ? "risk_approved" : r.reason, nextCheckAt: this.iso() });
      if (request.action === "stop_retry") {
        if (d.status !== "delivered") this.projectStatus(d, "failed", STOP_NOTE);
        this.store.patchDeliveryRetry(d.id, { nextAttemptAt: null, retryReason: null });
      } else if (request.action === "retry_with_risk") {
        this.store.patchDeliveryRetry(d.id, { nextAttemptAt: this.iso(), retryReason: `delivery_risk:${request.operationId}` });
      }
      return { operationId: request.operationId, deliveryId, outcome: request.action === "stop_retry" ? "stopped" : request.action === "retry_with_risk" ? "retry_scheduled" : "check_scheduled", committedVersion: next.version };
    });
  }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  private async run(): Promise<void> {
    this.store.detectDeliveryStalls(this.now());
    const members = new Map<string, Delivery[]>();
    const dispatches = new Map<string, DeliveryDispatch[]>();
    for (const d of this.store.listDeliveryRecoveryCandidates()) {
      const r = this.record(d.id);
      if (r.phase === "needs_owner" && r.reason === "stale_instruction") continue;
      if (!["none", "resolved", "stopped"].includes(r.phase) && this.requeueRejected(d.id)) continue;
      if (!dispatches.has(d.memberId)) dispatches.set(d.memberId, this.store.listDispatches(d.memberId));
      const physical = dispatches.get(d.memberId)!.some(item => item.items.some(item => item.deliveryId === d.id) && ["prepared", "write_started", "unknown"].includes(item.transportState));
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
    const checked = new Set<string>();
    // An older unknown write is still a physical fence even if a later attempt succeeded.
    // Read it by its own identity/barrier; later success cannot settle that earlier RPC.
    const latest = new Set(deliveries.map(d => this.latest(d)?.dispatchId));
    for (const dispatch of this.store.listDispatches(deliveries[0].memberId)) {
      if (this.closed || this.store.inputState(dispatch.memberId).lease) return;
      if (latest.has(dispatch.dispatchId) || !["prepared", "write_started", "unknown"].includes(dispatch.transportState)) continue;
      const member = this.store.requireMember(dispatch.memberId);
      const runner = this.options.runner(member);
      if (!runner?.inspectDelivery || !this.validDispatch(dispatch) || member.sessionId !== dispatch.identity.sessionId || this.store.memberRevisions(member.id).sessionGeneration !== dispatch.identity.sessionGeneration) continue;
      let inspection: DeliveryInspection;
      try { inspection = await runner.inspectDelivery(this.member(member), dispatch); }
      catch { continue; } // Failed reads leave the original physical fence intact.
      if (!this.closed && !this.store.inputState(member.id).lease && !this.store.requireProject(member.projectId).archived) this.settlePhysical(dispatch, inspection);
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
            if (dispatch && this.sameIdentity(dispatch.identity, inspection.snapshot?.identity) && inspection.snapshot?.composer === "empty") this.received(current, false, inspection.evidence);
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
    for (const dispatch of this.store.listDispatches(memberId)) {
      if (!["prepared", "write_started", "unknown"].includes(dispatch.transportState) || !dispatch.items.length) continue;
      const proven = dispatch.items.every(item => {
        const d = this.store.getDelivery(item.deliveryId), r = this.store.getDeliveryRecovery(item.deliveryId);
        return d?.status === "delivered" && r?.phase === "resolved" && r.evidence.some(e => e.location === "received_input" && e.verdict === "present" && e.source !== "transport");
      });
      if (proven) this.store.updateDispatch(dispatch.dispatchId, dispatch.transportState, "accepted");
    }
  }
  private settlePhysical(dispatch: DeliveryDispatch, inspection: DeliveryInspection): void {
    const snapshot = inspection.snapshot;
    if (!snapshot || !this.sameIdentity(dispatch.identity, snapshot.identity) || snapshot.ownership !== "verified" || inspection.quiescence !== "settled" || snapshot.originalWrite === "unresolved") return;
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
  private safe(dispatch: DeliveryDispatch, inspection: DeliveryInspection): boolean {
    const s = inspection.snapshot;
    return !!s && this.sameIdentity(dispatch.identity, s.identity) && s.ownership === "verified" && ["idle", "done"].includes(s.status) && !s.blockedReason && !s.leaseActive && s.mutation === "none" && s.externalInput === false && s.inputEpoch !== null && s.identity.terminalId !== null && inspection.quiescence === "settled" && ["settled", "not_written", "rejected"].includes(s.originalWrite);
  }
  private observe(d: Delivery, dispatch: DeliveryDispatch | null, inspection: DeliveryInspection): void {
    let r = this.record(d.id);
    const s = inspection.snapshot;
    const waiting = s?.leaseActive ? "manual_control" : s?.status === "working" ? "busy" : s?.status === "blocked" ? "blocked" : inspection.finding === "wait" ? inspection.evidence[0]?.code ?? "busy" : null;
    if (waiting) {
      this.wait(d.id, waiting);
      return;
    }
    const elapsed = r.lastCheckedAt && r.phase !== "waiting" ? Math.max(0, this.now() - Date.parse(r.lastCheckedAt)) : 0;
    const activeCheckMs = Math.min(120_000, r.activeCheckMs + elapsed);
    let reason = inspection.evidence[0]?.code ?? "inflight_unsettled";
    if (["partial_log", "partial_line", "scan_incomplete"].includes(reason)) reason = "log_incomplete";
    if (["file_missing", "permission_denied"].includes(reason)) reason = "log_missing";
    if (dispatch && s && !this.sameIdentity(dispatch.identity, s.identity) || s?.status === "gone") reason = "session_lost";
    let phase: DeliveryRecoveryRecord["phase"] = r.phase === "needs_owner" ? "needs_owner" : "checking";
    let nextCheckAt = this.iso(this.now() + CHECK_MS[Math.min(r.checkCount, CHECK_MS.length - 1)]);
    const retry = this.store.getDeliveryRetry(d.id);
    const risk = retry.retryReason?.startsWith("delivery_risk:");
    if (dispatch && !this.sourceValid(dispatch, d)) { reason = "source_changed"; phase = "needs_owner"; }
    else if (dispatch && this.safe(dispatch, inspection) && (inspection.finding === "not_received" || risk && inspection.finding === "unknown") && s?.composer === "empty") {
      reason = risk ? "risk_approved" : "not_received";
      if (r.phase === "needs_owner" && !risk || r.autoAttempts >= 3 && !risk) { phase = "needs_owner"; reason = "retry_exhausted"; }
      else {
        phase = "retry_wait";
        const due = retry.nextAttemptAt ?? this.iso(this.now() + RETRY_MS[Math.min(r.autoAttempts, 2)] * (1 + 0.2 * Math.min(Math.max(this.random(), 0), 1)));
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
    if (action === "resend") {
      dispatch = this.store.transaction(() => {
        // Every attempt has its own envelope so a late result can only settle its own RPC.
        // Delivery IDs/markers remain stable, and this new subset has never been written.
        this.settlePhysical(original, inspection);
        return this.saveEnvelope(unresolved, original.identity, original.baseline, "prepared");
      });
    }
    // A bundle uses one reviewed CAS version. Store increments can differ after partial corrections;
    // align with no-op CAS updates rather than weakening the runner's exact version check.
    const version = Math.max(...unresolved.map(d => this.record(d.id).version));
    this.store.transaction(() => {
      for (const d of unresolved) while (this.record(d.id).version < version) this.store.updateDeliveryRecovery(d.id, this.record(d.id).version, {});
    });
    const s = inspection.snapshot!;
    const request: DeliveryRepair = { action, dispatchId: dispatch.dispatchId, expectedRecoveryVersion: version, expectedSessionGeneration: s.identity.sessionGeneration,
      expectedSessionId: s.identity.sessionId, expectedTerminalId: s.identity.terminalId!, expectedInputEpoch: s.inputEpoch! };
    if (!this.loadRepair(dispatch.memberId, request)) return;
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
    const retry = dispatch && this.validDispatch(dispatch) && this.sourceValid(dispatch, d) && (["retry_exhausted", "log_missing", "log_incomplete", "unsupported_schema"].includes(r.reason ?? "") || r.evidence.some(e => e.code === "complete_range_without_marker" && e.verdict === "absent" && e.complete)) && this.store.memberRevisions(d.memberId).sessionGeneration === dispatch.identity.sessionGeneration && this.store.requireMember(d.memberId).sessionId === dispatch.identity.sessionId;
    return retry ? ["recheck", "retry_with_risk", "stop_retry"] : ["recheck", "stop_retry"];
  }

  /** Legacy same-message retry materializes a held row; it never starts a new send. */
  materializeLegacyMessage(messageId: string): Delivery {
    return this.store.transaction(() => {
      const m = this.store.requireMessage(messageId);
      this.activeProject(m.projectId);
      const existing = this.store.listDeliveries(m.projectId).filter(d => d.refType === "message" && d.refId === m.id).at(-1);
      if (existing) return existing;
      const member = m.targetMemberId && this.store.getMember(m.targetMemberId);
      if (!m.mine || m.delivery !== "failed" || !member || member.projectId !== m.projectId) throw new ApiError(409, "옛 메시지의 수신자를 확정할 수 없습니다");
      const d = this.store.enqueue({ projectId: m.projectId, memberId: member.id, kind: "user_message", text: m.body, refType: "message", refId: m.id, status: "held", holdReason: "delivery_unknown" });
      this.beginRecovery(d.id, "legacy_unknown");
      return this.store.requireDelivery(d.id);
    });
  }

  /** Explicit owner choice: never infer a recipient while reading legacy failures. */
  recoverUnassignedMessage(messageId: string, request: UnassignedRecoveryRequest): UnassignedRecoveryResult {
    if (!z.strictObject({ operationId: z.uuid(), expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      action: z.enum(["send_to_conductor", "dismiss"]) }).safeParse(request).success) throw new ApiError(400, "메시지 정리 요청이 올바르지 않습니다");
    return this.store.transaction(() => {
      const m = this.store.requireMessage(messageId);
      if (this.store.requireProject(m.projectId).archived) throw new ApiError(409, "보관 중인 프로젝트의 메시지는 정리할 수 없습니다");
      return this.store.unassignedMessageOperation<UnassignedRecoveryResult>(messageId, request.operationId, request, request.action, () => {
        if (this.closed || request.expectedVersion !== 0 || !m.mine || m.delivery !== "failed" ||
          this.store.listDeliveries(m.projectId).some(d => d.refType === "message" && d.refId === m.id)) throw new ApiError(409, "메시지 상태가 바뀌었습니다. 다시 확인해 주세요");
        const target = m.targetMemberId && this.store.getMember(m.targetMemberId);
        if (request.action === "dismiss") {
          this.store.setMessageDelivery(m.id, "dismissed");
          return { memberId: null, result: { operationId: request.operationId, messageId, deliveryId: null, outcome: "dismissed" as const, committedVersion: 1 } };
        }
        if (target && target.projectId === m.projectId) throw new ApiError(409, "이미 수신자가 지정된 메시지입니다");
        const member = this.store.getConductor(m.projectId);
        if (!member) throw new ApiError(409, "프로젝트에 현재 총괄이 없습니다");
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
      phase: stalled ? "needs_owner" : r.phase === "resolved" ? "none" : r.phase, holdReason: d.holdReason, reason: stalled ? "stalled" : r.reason, note: wait.waitReason === "api_outage" ? "인터넷 연결이 돌아오면 보냅니다" : wait.waitReason === "usage_limit" ? "사용 한도가 풀리면 보냅니다" : stalled ? "전달이 진행되지 않고 있습니다. 다시 확인해 주세요" : r.phase === "none" ? d.status === "failed" ? note("legacy_unknown") : "전달 대기" : note(r.reason, r.evidence),
      version: r.version, createdAt: d.createdAt, lastCheckedAt: r.lastCheckedAt, nextCheckAt: r.nextCheckAt, autoAttempts: r.autoAttempts, evidence: r.evidence,
      recommendation: stalled ? { code: "recheck", text: "다시 확인" } : r.phase === "needs_owner" ? { code: r.reason ?? "unknown", text: note(r.reason, r.evidence) } : null, allowedActions: stalled ? ["recheck", "stop_retry"] : this.actions(d, r),
      ref: d.refType && d.refId ? { type: d.refType, id: d.refId } : null, preview: preview.length > 160 ? preview.slice(0, 157) + "..." : preview };
  }
  private items(projectId: string, includePreviews = true): DeliveryNoticeItem[] {
    return this.store.withDeliveryRead(projectId, () => this.readItems(projectId, includePreviews));
  }
  private readItems(projectId: string, includePreviews: boolean): DeliveryNoticeItem[] {
    const deliveries = this.store.listDeliveries(projectId);
    const previews = includePreviews ? this.store.deliveryNoticePreviews(projectId) : new Map<string, string>();
    const last = new Map<string, string>();
    const key = (d: Delivery) => { const revision = this.store.getDeliveryRetry(d.id).sourceRevision; return d.refType && d.refId && revision ? JSON.stringify([d.memberId, d.refType, d.refId, revision]) : null; };
    for (const d of deliveries) { const k = key(d); if (k) last.set(k, d.id); }
    const items: DeliveryNoticeItem[] = [];
    for (const d of deliveries) {
      const k = key(d);
      if (d.status === "failed" && this.definitelyAbsent(d) && k && last.get(k) !== d.id) continue;
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
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "조회 개수가 올바르지 않습니다");
      let before: { createdAt: string; id: string } | null = null;
      if (opts.before !== undefined) {
        try {
          if (!opts.before || opts.before.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(opts.before)) throw new Error("cursor");
          const bytes = Buffer.from(opts.before, "base64url");
          if (bytes.toString("base64url") !== opts.before) throw new Error("cursor");
          const cursor = z.strictObject({ v: z.literal(1), memberId: z.literal(memberId), createdAt: z.string().min(1).max(128), id: z.string().min(1).max(512) }).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
          before = cursor;
        } catch { throw new ApiError(400, "전달 조회 위치가 올바르지 않습니다"); }
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
