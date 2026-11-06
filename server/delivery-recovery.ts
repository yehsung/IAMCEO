import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { memberConfig, type Delivery, type DeliveryEvidence, type DeliveryNoticeItem, type DeliveryNoticePage, type DeliveryNoticePageOptions, type DeliveryNotices, type DeliveryRecoveryRequest, type DeliveryRecoveryResult, type Member, type MemberDeliverySummary, type Message } from "../shared/types.ts";
import { ApiError, type Store } from "./store.ts";
import type { DeliveryDispatch, DeliveryRecoveryRecord, DeliveryRecoveryService } from "./service-contracts.ts";
import type { DeliveryBaseline, DeliveryInspection, DeliveryRepair, Runner, RunnerMember, RunnerTerminalIdentity, SendResult } from "./runner/types.ts";

/** SQL, cursors and transactions belong exclusively to Store. */
export type DeliveryRecoveryStore = Pick<Store,
  "transaction" | "afterCommit" | "requireProject" | "listProjects" | "requireMember" | "getMember" | "listMembers" | "memberRevisions" | "getSettings" |
  "listDeliveries" | "requireDelivery" | "getDelivery" | "enqueue" | "getDeliveryRecovery" | "updateDeliveryRecovery" | "listDeliveryRecoveries" |
  "getDeliveryRetry" | "patchDeliveryRetry" | "saveDispatch" | "getDispatch" | "listDispatches" | "updateDispatch" | "inputState" |
  "deliveryRecoveryOperation" | "markDelivered" | "markHeld" | "markFailed" | "setDeliveryStatus" | "setMessageDelivery" |
  "getMessage" | "requireMessage" | "listMessagePage" | "getDecision" | "setDecisionStatus" | "getTodo" | "todoRevision" | "appendActivity">;

export interface DeliveryRecoveryOptions {
  store: DeliveryRecoveryStore;
  runner: (member: Member) => Pick<Runner, "inspectDelivery" | "repairDelivery"> | null;
  now?: () => number;
  random?: () => number;
}

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
function note(reason: string | null): string {
  switch (reason) {
    case "manual_control": return "직접 조작이 끝나면 다시 확인합니다";
    case "busy": return "받을 수 있을 때 다시 확인합니다";
    case "blocked": return "승인 창이 닫히면 다시 확인합니다";
    case "duplicate_draft": return "이미 받은 지시가 입력칸에도 남아 있습니다. 초안을 확인해 주세요";
    case "source_changed": return "원본이 변경되어 다시 보내지 않습니다. 수신 여부는 계속 확인합니다";
    case "retry_exhausted": return "자동 재전송 상한에 도달했습니다";
    case "not_received": return "미전달을 확인했습니다. 안전 상태를 다시 확인한 뒤 재전송합니다";
    case "draft_pending": return "입력 제출을 확인 중입니다";
    case "session_lost": return "기존 세션을 확인할 수 없습니다. 연결 상태를 확인해 주세요";
    case "unsupported_schema": return "이 실행기에서는 안전한 전달 확인을 지원하지 않습니다";
    case "log_missing": return "세션 기록을 확인할 수 없습니다";
    case "legacy_unknown": return "옛 전달의 수신 여부를 확인할 수 없습니다";
    case "inflight_unsettled": return "원래 입력의 종료 여부를 확인하고 있습니다";
    default: return "상세 내용을 확인해 주세요";
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
    return { ...member, ...memberConfig(member, settings.ranks), sessionGeneration: this.store.memberRevisions(member.id).sessionGeneration,
      subagentModel: member.cli === "codex" ? null : settings.ranks.staff.model, permissionMode: settings.permissionMode };
  }

  /** Capture before the first external write; never infer a source version during retry. */
  sourceRevision(delivery: Delivery): string | null {
    if (!delivery.refType || !delivery.refId) return hash({ text: delivery.text, memberId: delivery.memberId });
    if (delivery.refType === "message") {
      const m = this.store.getMessage(delivery.refId);
      return m && m.projectId === delivery.projectId && (delivery.kind !== "user_message" || m.targetMemberId === null || m.targetMemberId === delivery.memberId)
        ? hash({ id: m.id, body: m.body, title: m.title, attachments: m.attachments, targetMemberId: m.targetMemberId, memberId: delivery.memberId }) : null;
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
    const state = this.store.inputState(memberId);
    return !!state.lease || this.mutations.has(memberId) || state.unresolvedDispatches.some(d => ["prepared", "write_started", "unknown"].includes(d.transportState)) ||
      this.store.listDeliveries(this.store.requireMember(memberId).projectId).some(d => d.memberId === memberId && this.logicalFence(d));
  }
  private logicalFence(d: Delivery): boolean {
    const r = this.record(d.id);
    return !["none", "resolved", "stopped"].includes(r.phase) || (r.phase === "none" && (d.status === "delivering" || d.status === "held" && d.holdReason === "delivery_unknown"));
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
        if (d.memberId !== first.memberId || d.projectId !== first.projectId || d.kind === "compact" || !["queued", "held"].includes(d.status) || d.attempts || this.latest(d) || this.record(d.id).phase !== "none" || this.sourceRevision(d) === null) throw new ApiError(409, "새 전달 봉투를 만들 수 없습니다");
      }
      return this.saveEnvelope(deliveries, identity, baseline, "prepared");
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

  beginRecovery(deliveryId: string, reason = "inflight_unsettled"): void {
    this.store.transaction(() => {
      const d = this.store.requireDelivery(deliveryId);
      const r = this.record(deliveryId);
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
      if (this.closed || r.version !== request.expectedVersion || ["resolved", "stopped"].includes(r.phase) || r.phase === "none" || this.mutations.has(d.memberId)) throw new ApiError(409, "전달 상태가 바뀌었습니다. 다시 확인해 주세요");
      if (request.action !== "recheck" && !this.actions(d, r).includes(request.action)) throw new ApiError(409, "전달 상태가 바뀌었습니다. 다시 확인해 주세요");
      const next = this.store.updateDeliveryRecovery(d.id, r.version, request.action === "stop_retry"
        ? { phase: "stopped", nextCheckAt: null }
        : { phase: request.action === "recheck" && r.phase === "needs_owner" ? "needs_owner" : "checking", reason: request.action === "retry_with_risk" ? "risk_approved" : r.reason, nextCheckAt: this.iso() });
      if (request.action === "stop_retry") {
        this.projectStatus(d, "failed", STOP_NOTE);
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
    const members = new Map<string, Delivery[]>();
    for (const d of this.store.listDeliveries()) {
      const r = this.record(d.id);
      const physical = this.store.listDispatches(d.memberId).some(item => item.items.some(item => item.deliveryId === d.id) && ["prepared", "write_started", "unknown"].includes(item.transportState));
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
      const runner = this.options.runner(this.store.requireMember(d.memberId));
      const versions = new Map(ids.map(id => [id, this.record(id).version]));
      let inspection: DeliveryInspection;
      try {
        inspection = dispatch && this.validDispatch(dispatch) && runner?.inspectDelivery ? await runner.inspectDelivery(this.member(this.store.requireMember(d.memberId)), { ...dispatch, markers: dispatch.markers.filter(marker => ids.includes(marker.deliveryId)) }) : this.unknown(dispatch ? "unsupported_schema" : "legacy_unknown");
      } catch { inspection = this.unknown("backend_down"); }
      if (this.closed) return;
      // Re-read CAS, lease, membership and archive after every awaited observation.
      if (this.store.requireProject(d.projectId).archived || this.store.inputState(d.memberId).lease || dispatch && this.validDispatch(dispatch) && (this.store.memberRevisions(d.memberId).sessionGeneration !== dispatch.identity.sessionGeneration || this.store.requireMember(d.memberId).sessionId !== dispatch.identity.sessionId)) continue;
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
    this.projectStatus(d, phase === "needs_owner" && reason === "retry_exhausted" ? "failed" : "held", CHECK_NOTE);
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
        return this.saveEnvelope(unresolved, original.identity, original.baseline, "rejected");
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
    if (["resolved", "stopped", "none"].includes(r.phase)) return [];
    if (r.phase !== "needs_owner" || r.reason === "duplicate_draft") return ["recheck"];
    const dispatch = this.latest(d);
    const retry = dispatch && this.validDispatch(dispatch) && this.sourceValid(dispatch, d) && ["retry_exhausted", "log_missing", "log_incomplete", "unsupported_schema"].includes(r.reason ?? "") && this.store.memberRevisions(d.memberId).sessionGeneration === dispatch.identity.sessionGeneration && this.store.requireMember(d.memberId).sessionId === dispatch.identity.sessionId;
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

  private definitelyAbsent(d: Delivery): boolean {
    const r = this.record(d.id);
    return ["not_received", "retry_exhausted"].includes(r.reason ?? "") || r.phase === "none" && ["queued", "held"].includes(d.status) && d.holdReason !== "delivery_unknown";
  }
  private item(d: Delivery): DeliveryNoticeItem | null {
    const r = this.record(d.id);
    if (r.phase === "resolved" || r.phase === "stopped" || d.status === "delivered" && r.reason !== "duplicate_draft") return null;
    const m = d.refType === "message" && d.refId ? this.store.getMessage(d.refId) : null;
    const preview = m?.body ?? (d.refType === "decision" && d.refId ? this.store.getDecision(d.refId)?.title : d.refType === "todo" && d.refId ? this.store.getTodo(d.refId)?.title : null) ?? ({ user_message: "대표 메시지", answer: "결재 답변", todo_done: "업무 완료 알림", instruction: "업무 지시", report: "보고 전달", system: "시스템 지시", compact: "문맥 정리" }[d.kind]);
    return { id: d.id, deliveryId: d.id, messageId: m?.id ?? null, memberId: d.memberId, projectId: d.projectId, kind: d.kind, status: d.status,
      phase: r.phase, holdReason: d.holdReason, reason: r.reason, note: r.phase === "none" ? d.status === "failed" ? note("legacy_unknown") : "전달 대기" : note(r.reason),
      version: r.version, createdAt: d.createdAt, lastCheckedAt: r.lastCheckedAt, nextCheckAt: r.nextCheckAt, autoAttempts: r.autoAttempts, evidence: r.evidence,
      recommendation: r.phase === "needs_owner" ? { code: r.reason ?? "unknown", text: note(r.reason) } : null, allowedActions: this.actions(d, r),
      ref: d.refType && d.refId ? { type: d.refType, id: d.refId } : null, preview: preview.length > 160 ? preview.slice(0, 157) + "..." : preview };
  }
  private items(projectId: string): DeliveryNoticeItem[] {
    const deliveries = this.store.listDeliveries(projectId);
    const last = new Map<string, string>();
    const key = (d: Delivery) => { const revision = this.store.getDeliveryRetry(d.id).sourceRevision; return d.refType && d.refId && revision ? JSON.stringify([d.memberId, d.refType, d.refId, revision]) : null; };
    for (const d of deliveries) { const k = key(d); if (k) last.set(k, d.id); }
    const items: DeliveryNoticeItem[] = [];
    for (const d of deliveries) {
      const k = key(d);
      if (d.status === "failed" && this.definitelyAbsent(d) && k && last.get(k) !== d.id) continue;
      const item = this.item(d);
      if (item) items.push(item);
    }
    const linked = new Set(deliveries.filter(d => d.refType === "message").map(d => d.refId));
    let cursor: string | undefined;
    do {
      const page = this.store.listMessagePage(projectId, { limit: 500, cursor });
      for (const m of page.items) if (m.mine && m.delivery === "failed" && !linked.has(m.id)) items.push(this.virtual(m));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return items;
  }
  private virtual(m: Message): DeliveryNoticeItem {
    const member = m.targetMemberId && this.store.getMember(m.targetMemberId);
    return { id: `message:${m.id}`, deliveryId: null, messageId: m.id, memberId: member && member.projectId === m.projectId ? member.id : "", projectId: m.projectId,
      kind: "user_message", status: "failed", phase: "needs_owner", holdReason: null, reason: "legacy_unknown", note: note("legacy_unknown"), version: 0,
      createdAt: m.at, lastCheckedAt: null, nextCheckAt: null, autoAttempts: 0, evidence: [], recommendation: { code: "legacy_unknown", text: "기존 메시지에서 다시 확인해 주세요" }, allowedActions: [], ref: { type: "message", id: m.id }, preview: m.body.length > 160 ? m.body.slice(0, 157) + "..." : m.body };
  }
  private summarize(memberId: string, items: DeliveryNoticeItem[]): MemberDeliverySummary {
    const summary: MemberDeliverySummary = { memberId, undeliveredCount: 0, unknownCount: 0, deliveringCount: 0, checkingCount: 0, needsOwnerCount: 0, waitingBehindCount: 0, oldestAt: null, reasons: [] };
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
      if (item.phase !== "none" || item.status === "delivering" || item.holdReason === "delivery_unknown") fence = true;
      if (summary.oldestAt === null || compare(item.createdAt, summary.oldestAt) < 0) summary.oldestAt = item.createdAt;
      if (item.reason) {
        const reason = summary.reasons.find(reason => reason.code === item.reason);
        if (reason) reason.count++; else summary.reasons.push({ code: item.reason, count: 1, note: note(item.reason) });
      }
    }
    return summary;
  }
  notices(projectId: string): DeliveryNotices {
    return this.store.transaction(() => {
      this.activeProject(projectId);
      const items = this.items(projectId);
      const unassigned = this.summarize("", items);
      return { version: 2, members: this.store.listMembers(projectId).map(m => this.summarize(m.id, items)), unassigned: { undeliveredCount: unassigned.undeliveredCount, unknownCount: unassigned.unknownCount, needsOwnerCount: unassigned.needsOwnerCount } };
    });
  }
  memberNotices(memberId: string, opts: DeliveryNoticePageOptions = {}): DeliveryNoticePage {
    return this.store.transaction(() => {
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
    });
  }
  async shutdown(): Promise<void> { this.closed = true; await this.running; }
}
