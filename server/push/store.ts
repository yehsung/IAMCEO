import type { Database, SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { DEFAULT_PUSH_BUNDLE_ID, PUSH_REPORT_GROUP_WINDOW_MS } from "../../shared/push.ts";
import type { PushAuthorization, PushDeliveryState, PushEnvironment, PushProviderStatus, PushReportGroup, RegisterPushDeviceRequest } from "../../shared/push.ts";
import type { Message } from "../../shared/types.ts";
import type { PushReportGroupStore } from "../service-contracts.ts";
import { ApiError } from "../store.ts";
import { APNS_TTL_MS, buildAPNsPayload } from "./apns.ts";
import { DEFAULT_PUSH_PREFERENCES, PUSH_KINDS, storedPushPreferences } from "./contracts.ts";
import type { PatchPushDeviceRequest, PushDevice, PushEventTarget, PushEventTargetResult, PushKind } from "./contracts.ts";
import { extendPushSchema } from "./schema.ts";

const DAY = 86_400_000;
/** A network error is cleared only by the next response, so new deliveries must still be queued: the next
 * one is the recovery probe (PushWorker.available allows it). Configuration errors stay fail-closed. */
export function providerUsable(provider: PushProviderStatus | undefined): boolean {
  return provider?.state === "ready" || (provider?.state === "temporarily_unavailable" && provider.lastError === "network_error");
}
export interface PushStoreOptions {
  now?: () => number;
  /** No configured provider is the fail-closed default; no secret files are read here. */
  providers?: () => readonly PushProviderStatus[];
}
export interface PushEvent {
  id: string; sourceKey: string; kind: PushKind | "test"; projectId: string | null; memberId: string | null;
  target: PushEventTarget; occurredAt: string; expiresAt: string;
}
export interface PushDelivery {
  id: string; eventId: string; deviceId: string; registrationGeneration: number; state: PushDeliveryState;
  attempts: number; nextAttemptAt: string; leaseUntil: string | null; lastStatus: number | null;
  lastReason: string | null; acceptedAt: string | null; expiresAt: string; finishedAt: string | null;
}
/** Internal only: never return this record from an API. */
export interface PushRegistration { device: PushDevice; deviceToken: string | null; registrationGeneration: number }
export interface PushEpisode {
  memberId: string; blockedGeneration: number; blockedActive: boolean;
  errorGeneration: number; errorActive: boolean; errorDigest: string | null;
}
interface DeviceRow {
  id: string; label: string; platform: "ios"; bundle_id: string; environment: PushEnvironment; token: string | null;
  authorization: PushAuthorization; enabled: number; preferences: string; state: PushDevice["state"]; revision: number;
  registration_generation: number; registered_at: string; last_seen_at: string; expires_at: string;
  revoked_at: string | null; invalidated_at: string | null; last_accepted_at: string | null; last_failure: PushDevice["lastFailure"];
}
interface EventRow { id: string; source_key: string; kind: PushEvent["kind"]; project_id: string | null; member_id: string | null; target: string; occurred_at: string; expires_at: string }
interface GroupRow { id: string; project_id: string; member_id: string; opened_at: string; closes_at: string; last_message_id: string; state: PushReportGroup["state"]; event_id: string | null; closed_at: string | null }
interface DeliveryRow {
  id: string; event_id: string; device_id: string; registration_generation: number; state: PushDeliveryState;
  attempts: number; next_attempt_at: string; lease_until: string | null; last_status: number | null;
  last_reason: string | null; accepted_at: string | null; expires_at: string; finished_at: string | null;
}
function device(row: DeviceRow): PushDevice {
  return { id: row.id, label: row.label, platform: row.platform, bundleId: row.bundle_id, environment: row.environment,
    enabled: !!row.enabled, authorization: row.authorization, preferences: storedPushPreferences(row.preferences), state: row.state,
    revision: row.revision, registeredAt: row.registered_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at,
    lastAcceptedAt: row.last_accepted_at, lastFailure: row.last_failure };
}
function event(row: EventRow): PushEvent {
  return { id: row.id, sourceKey: row.source_key, kind: row.kind, projectId: row.project_id, memberId: row.member_id,
    target: JSON.parse(row.target), occurredAt: row.occurred_at, expiresAt: row.expires_at };
}
function uuid(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ApiError(400, "기기 ID가 올바르지 않습니다", "push_device_id_invalid");
}
function label(value: string): void {
  if (Array.from(value).length < 1 || Array.from(value).length > 40 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new ApiError(400, "기기 이름이 올바르지 않습니다", "push_device_name_invalid");
}
function authorized(value: PushAuthorization): boolean { return ["authorized", "provisional", "ephemeral"].includes(value); }
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ApiError(400, "기기 revision이 올바르지 않습니다", "push_device_revision_invalid");
}

/** Owns only push tables, on the same connection as the domain Store. No network, timers or Bus. */
export class PushStore implements PushReportGroupStore {
  private readonly now: () => number;
  private readonly providers: () => readonly PushProviderStatus[];
  constructor(readonly db: Database, options: PushStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.providers = options.providers ?? (() => []);
    this.transaction(() => {
      extendPushSchema(this.db);
      this.run("INSERT OR IGNORE INTO push_meta(id,server_id,created_at) VALUES(1,?,?)", randomUUID(), this.timestamp());
    });
  }
  get serverId(): string { return this.one<{ server_id: string }>("SELECT server_id FROM push_meta WHERE id=1")!.server_id; }
  timestamp(): string { return new Date(this.now()).toISOString(); }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(() => {
      const value = fn();
      if (value instanceof Promise) throw new Error("PushStore.transaction requires a synchronous callback");
      return value;
    }).immediate();
  }
  private one<T>(sql: string, ...args: SQLQueryBindings[]): T | null { return this.db.query<T, SQLQueryBindings[]>(sql).get(...args); }
  private all<T>(sql: string, ...args: SQLQueryBindings[]): T[] { return this.db.query<T, SQLQueryBindings[]>(sql).all(...args); }
  private run(sql: string, ...args: SQLQueryBindings[]): void { this.db.query(sql).run(...args); }
  private row(id: string): DeviceRow | null { return this.one<DeviceRow>("SELECT * FROM push_devices WHERE id=?", id); }
  getDevice(id: string): PushDevice | null { const row = this.row(id); return row ? device(row) : null; }
  requireDevice(id: string): PushDevice {
    const found = this.getDevice(id);
    if (!found) throw new ApiError(404, "기기를 찾을 수 없습니다", "push_device_not_found");
    return found;
  }
  listDevices(): PushDevice[] { return this.all<DeviceRow>("SELECT * FROM push_devices ORDER BY last_seen_at DESC,id LIMIT 100").map(device); }
  getRegistration(id: string): PushRegistration | null {
    const row = this.row(id);
    return row ? { device: device(row), deviceToken: row.token, registrationGeneration: row.registration_generation } : null;
  }
  private checkRevision(row: DeviceRow | null, expected: number | null): void {
    if (expected !== null) revision(expected);
    if (!row && expected !== null) throw new ApiError(404, "기기를 찾을 수 없습니다", "push_device_not_found");
    if (row && row.revision !== expected) throw new ApiError(409, "기기 등록 상태가 바뀌었습니다. 다시 확인해 주세요", "push_device_changed");
  }
  private provider(bundleId: string, environment: PushEnvironment): PushProviderStatus | undefined {
    return this.providers().find((p) => p.environment === environment && p.bundleId === bundleId);
  }
  private ready(row: DeviceRow): boolean { return providerUsable(this.provider(row.bundle_id, row.environment)); }
  private eligible(row: DeviceRow, kind: PushEvent["kind"], at: string): boolean {
    return row.state === "active" && !!row.token && !!row.enabled && authorized(row.authorization) && row.expires_at > at &&
      this.ready(row) && (kind === "test" || storedPushPreferences(row.preferences)[kind]);
  }
  registerDevice(id: string, request: RegisterPushDeviceRequest): PushDevice {
    uuid(id);
    if (request.label !== undefined) label(request.label);
    if (request.platform !== "ios" || !["sandbox", "production"].includes(request.environment) || !authorized(request.authorization) ||
        request.deviceToken.length > 1024 || !/^(?:[0-9a-f]{2})+$/i.test(request.deviceToken)) throw new ApiError(400, "기기 등록 값이 올바르지 않습니다", "push_device_invalid");
    const allowed = this.providers().find((p) => p.environment === request.environment)?.bundleId ?? DEFAULT_PUSH_BUNDLE_ID;
    if (request.bundleId !== allowed) throw new ApiError(400, "허용되지 않은 앱입니다", "push_bundle_not_allowed");
    return this.transaction(() => {
      this.sweep();
      const before = this.row(id);
      this.checkRevision(before, request.expectedRevision);
      if (!before && this.one<{ n: number }>("SELECT COUNT(*) n FROM push_devices")!.n >= 100) throw new ApiError(409, "기기 등록 한도입니다", "push_device_limit");
      const at = this.timestamp();
      const token = request.deviceToken.toLowerCase();
      const previous = this.one<DeviceRow>("SELECT * FROM push_devices WHERE bundle_id=? AND environment=? AND token=? AND id!=?", request.bundleId, request.environment, token, id);
      if (previous) this.deactivate(previous, "revoked", at);
      const compatible = before?.state === "active" && before.expires_at > at && before.bundle_id === request.bundleId && before.environment === request.environment;
      if (before && (!compatible || previous)) this.cancelDevice(id, at);
      const generation = (before?.registration_generation ?? 0) + 1;
      this.run(`INSERT INTO push_devices(id,label,platform,bundle_id,environment,token,authorization,enabled,preferences,state,revision,registration_generation,registered_at,last_seen_at,expires_at)
        VALUES(?,?,'ios',?,?,?,?,?,?,'active',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        label=excluded.label,bundle_id=excluded.bundle_id,environment=excluded.environment,token=excluded.token,authorization=excluded.authorization,
        enabled=excluded.enabled,state='active',revision=excluded.revision,registration_generation=excluded.registration_generation,
        registered_at=excluded.registered_at,last_seen_at=excluded.last_seen_at,expires_at=excluded.expires_at,revoked_at=NULL,invalidated_at=NULL,last_failure=NULL`,
        id, request.label ?? before?.label ?? "내 iPhone", request.bundleId, request.environment, token, request.authorization,
        compatible && !previous ? before!.enabled : 0, before?.preferences ?? JSON.stringify(DEFAULT_PUSH_PREFERENCES),
        (before?.revision ?? 0) + 1, generation, at, at, new Date(this.now() + 30 * DAY).toISOString());
      if (compatible && !previous) {
        this.run("UPDATE push_deliveries SET registration_generation=? WHERE device_id=? AND state IN ('queued','retry')", generation, id);
        this.run(`UPDATE push_report_group_recipients SET registration_generation=? WHERE device_id=? AND cancelled_at IS NULL
          AND group_id IN (SELECT id FROM push_report_groups WHERE state='open')`, generation, id);
      }
      return this.requireDevice(id);
    });
  }
  patchDevice(id: string, patch: PatchPushDeviceRequest): PushDevice {
    uuid(id); revision(patch.expectedRevision);
    if (patch.label !== undefined) label(patch.label);
    if (patch.authorization !== undefined && !["authorized", "provisional", "ephemeral", "denied", "notDetermined"].includes(patch.authorization)) throw new ApiError(400, "알림 권한이 올바르지 않습니다", "push_authorization_invalid");
    if (patch.enabled === undefined && patch.preferences === undefined && patch.label === undefined && patch.authorization === undefined) throw new ApiError(400, "변경할 값이 없습니다", "nothing_to_change");
    if (patch.preferences && (Object.keys(patch.preferences).length === 0 || Object.keys(patch.preferences).some((k) => !PUSH_KINDS.includes(k as PushKind)))) throw new ApiError(400, "알림 종류가 올바르지 않습니다", "push_kind_invalid");
    return this.transaction(() => {
      this.sweep();
      const before = this.row(id);
      this.checkRevision(before, patch.expectedRevision);
      const row = before!;
      const permission = patch.authorization ?? row.authorization;
      const enabled = authorized(permission) && (patch.enabled ?? !!row.enabled);
      if (patch.enabled && (!authorized(permission) || row.state !== "active" || !row.token || !this.ready(row))) throw new ApiError(409, "이 기기에서 알림을 켤 수 없습니다", "push_enable_refused");
      const preferences = { ...storedPushPreferences(row.preferences), ...patch.preferences };
      this.run("UPDATE push_devices SET enabled=?,preferences=?,label=?,authorization=?,revision=revision+1 WHERE id=?",
        enabled ? 1 : 0, JSON.stringify(preferences), patch.label ?? row.label, permission, id);
      if (!enabled) this.cancelDevice(id, this.timestamp());
      else for (const kind of PUSH_KINDS) if (!preferences[kind]) this.cancelDevice(id, this.timestamp(), kind);
      return this.requireDevice(id);
    });
  }
  revokeDevice(id: string, expectedRevision: number): void {
    uuid(id); revision(expectedRevision);
    this.transaction(() => {
      const row = this.row(id);
      if (row?.state === "revoked") return;
      if (row) { this.checkRevision(row, expectedRevision); this.deactivate(row, "revoked", this.timestamp()); return; }
      // DELETE arriving before the first PUT must also fence that late registration.
      const at = this.timestamp();
      this.run(`INSERT INTO push_devices(id,label,platform,bundle_id,environment,authorization,state,revision,registered_at,last_seen_at,expires_at,revoked_at)
        VALUES(?,'내 iPhone','ios',?,'sandbox','denied','revoked',?,?,?,?,?)`, id, DEFAULT_PUSH_BUNDLE_ID, expectedRevision + 1, at, at, at, at);
    });
  }
  private deactivate(row: DeviceRow, state: "revoked" | "expired" | "invalid", at: string): void {
    this.run(`UPDATE push_devices SET state=?,enabled=0,token=NULL,revision=revision+1,revoked_at=?,invalidated_at=?,last_failure=? WHERE id=?`,
      state, state === "revoked" ? at : null, state === "invalid" ? at : null, state === "invalid" ? "token_invalid" : row.last_failure, row.id);
    this.cancelDevice(row.id, at);
  }
  /** A response for an old stream cannot invalidate a newer registration. Timestamp is epoch ms. */
  invalidateDevice(id: string, generation: number, invalidatedAt?: number): boolean {
    return this.transaction(() => {
      const row = this.row(id);
      if (!row || row.state !== "active" || row.registration_generation !== generation ||
          (invalidatedAt !== undefined && Number.isFinite(invalidatedAt) && invalidatedAt >= 0 && Date.parse(row.registered_at) > invalidatedAt)) return false;
      this.deactivate(row, "invalid", this.timestamp());
      return true;
    });
  }
  private cancelDevice(id: string, at: string, kind?: PushKind): void {
    this.run(`UPDATE push_deliveries SET state='cancelled',finished_at=?,lease_until=NULL WHERE device_id=? AND state IN ('queued','retry')
      ${kind ? "AND event_id IN (SELECT id FROM push_events WHERE kind=?)" : ""}`, ...[at, id, ...(kind ? [kind] : [])]);
    if (!kind || kind === "report_complete") this.run(`UPDATE push_report_group_recipients SET cancelled_at=? WHERE device_id=? AND cancelled_at IS NULL
      AND group_id IN (SELECT id FROM push_report_groups WHERE state='open')`, at, id);
  }
  getEpisode(memberId: string): PushEpisode | null {
    const row = this.one<{ member_id: string; blocked_generation: number; blocked_active: number; error_generation: number; error_active: number; error_digest: string | null }>("SELECT * FROM push_episodes WHERE member_id=?", memberId);
    return row ? { memberId: row.member_id, blockedGeneration: row.blocked_generation, blockedActive: !!row.blocked_active,
      errorGeneration: row.error_generation, errorActive: !!row.error_active, errorDigest: row.error_digest } : null;
  }
  saveEpisode(episode: PushEpisode): void {
    this.run(`INSERT INTO push_episodes(member_id,blocked_generation,blocked_active,error_generation,error_active,error_digest) VALUES(?,?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET blocked_generation=excluded.blocked_generation,
      blocked_active=excluded.blocked_active,error_generation=excluded.error_generation,error_active=excluded.error_active,error_digest=excluded.error_digest`,
      episode.memberId, episode.blockedGeneration, episode.blockedActive ? 1 : 0, episode.errorGeneration, episode.errorActive ? 1 : 0, episode.errorDigest);
  }
  getEvent(id: string): PushEvent | null { const row = this.one<EventRow>("SELECT * FROM push_events WHERE id=?", id); return row ? event(row) : null; }
  eventBySource(sourceKey: string): PushEvent | null { const row = this.one<EventRow>("SELECT * FROM push_events WHERE source_key=?", sourceKey); return row ? event(row) : null; }
  listEvents(): PushEvent[] { return this.all<EventRow>("SELECT * FROM push_events ORDER BY occurred_at,rowid").map(event); }
  listDeliveries(eventId?: string): PushDelivery[] {
    return this.all<DeliveryRow>(`SELECT * FROM push_deliveries ${eventId ? "WHERE event_id=?" : ""} ORDER BY rowid`, ...(eventId ? [eventId] : [])).map((r) => ({
      id: r.id, eventId: r.event_id, deviceId: r.device_id, registrationGeneration: r.registration_generation, state: r.state,
      attempts: r.attempts, nextAttemptAt: r.next_attempt_at, leaseUntil: r.lease_until, lastStatus: r.last_status,
      lastReason: r.last_reason, acceptedAt: r.accepted_at, expiresAt: r.expires_at, finishedAt: r.finished_at }));
  }
  recordEvent(input: Omit<PushEvent, "id" | "expiresAt">, recipients?: { deviceId: string; registrationGeneration: number }[]): PushEvent {
    return this.transaction(() => {
      const existing = this.eventBySource(input.sourceKey);
      if (existing) return existing;
      const id = randomUUID();
      const expiresAt = new Date(Date.parse(input.occurredAt) + APNS_TTL_MS[input.kind]).toISOString();
      const target = buildAPNsPayload({ ...input, eventId: id, serverId: this.serverId, deliveryId: id,
        deviceToken: "", environment: "sandbox", expiresAt }).iamceo.target;
      this.run("INSERT INTO push_events(id,source_key,kind,project_id,member_id,target,occurred_at,expires_at) VALUES(?,?,?,?,?,?,?,?)", id, input.sourceKey, input.kind, input.projectId, input.memberId, JSON.stringify(target), input.occurredAt, expiresAt);
      const at = this.timestamp();
      const candidates = recipients ?? this.all<DeviceRow>("SELECT * FROM push_devices").filter((r) => this.eligible(r, input.kind, at)).map((r) => ({ deviceId: r.id, registrationGeneration: r.registration_generation }));
      const saved = this.getEvent(id)!;
      if (expiresAt > at && this.isEventCurrent(saved)) for (const recipient of candidates) {
        const row = this.row(recipient.deviceId);
        if (row && row.registration_generation === recipient.registrationGeneration && this.eligible(row, input.kind, at)) {
          this.run(`INSERT OR IGNORE INTO push_deliveries(id,event_id,device_id,registration_generation,state,next_attempt_at,expires_at)
            VALUES(?,?,?,?,'queued',?,?)`, randomUUID(), id, row.id, row.registration_generation, at, expiresAt);
        }
      }
      return saved;
    });
  }
  isEventCurrent(value: PushEvent): boolean {
    if (value.kind === "test") return value.target.screen === "home";
    if (!this.projectActive(value.projectId)) return false;
    if (value.kind === "decision") {
      if (value.target.screen !== "inbox") return false;
      const row = this.one<{ status: string; updated_at: string }>("SELECT status,updated_at FROM decisions WHERE id=? AND project_id=?", value.target.decisionId, value.projectId);
      return !!row && row.status === "open" && value.sourceKey === `ask:${value.target.decisionId}:${row.updated_at}`;
    }
    if (value.kind === "todo_created") {
      const todoId = value.sourceKey.slice("todo:".length);
      return value.sourceKey.startsWith("todo:") && !!this.one("SELECT 1 FROM todos WHERE id=? AND project_id=? AND done=0", todoId, value.projectId);
    }
    if (value.kind === "report_blocked") {
      return value.target.screen === "chat" && !!this.one("SELECT 1 FROM messages WHERE id=? AND project_id=? AND member_id=? AND mine=0 AND kind='막힘'", value.target.messageId, value.projectId, value.memberId);
    }
    if (value.kind === "report_complete") {
      if (value.target.screen !== "chat") return false;
      return !!this.one("SELECT 1 FROM messages WHERE id=? AND project_id=? AND member_id=? AND mine=0 AND kind='완료'", value.target.messageId, value.projectId, value.memberId);
    }
    if (!this.one("SELECT 1 FROM members WHERE id=? AND project_id=?", value.memberId, value.projectId)) return false;
    const episode = value.memberId ? this.getEpisode(value.memberId) : null;
    return !!episode && (value.kind === "approval_wait"
      ? episode.blockedActive && value.sourceKey === `blocked:${value.memberId}:${episode.blockedGeneration}`
      : episode.errorActive && value.sourceKey === `error:${value.memberId}:${episode.errorGeneration}`);
  }
  private projectActive(id: string | null): boolean { return !!this.one("SELECT 1 FROM projects WHERE id=? AND archived=0", id); }
  cancelInvalidPending(): void {
    this.transaction(() => {
      const at = this.timestamp();
      for (const row of this.all<EventRow>("SELECT DISTINCT e.* FROM push_events e JOIN push_deliveries d ON e.id=d.event_id WHERE d.state IN ('queued','retry')")) {
        if (!this.isEventCurrent(event(row))) this.run("UPDATE push_deliveries SET state='cancelled',finished_at=? WHERE event_id=? AND state IN ('queued','retry')", at, row.id);
      }
      for (const row of this.all<GroupRow>("SELECT * FROM push_report_groups WHERE state='open'")) {
        if (!this.projectActive(row.project_id) || !this.one("SELECT 1 FROM members WHERE id=? AND project_id=?", row.member_id, row.project_id) ||
            !this.one("SELECT 1 FROM messages WHERE id=? AND project_id=? AND member_id=?", row.last_message_id, row.project_id, row.member_id)) {
          this.run("UPDATE push_report_groups SET state='cancelled',closed_at=? WHERE id=?", at, row.id);
          this.run("UPDATE push_report_group_recipients SET cancelled_at=COALESCE(cancelled_at,?) WHERE group_id=?", at, row.id);
        }
      }
    });
  }
  getReportGroup(id: string): PushReportGroup | null {
    const r = this.one<GroupRow>("SELECT * FROM push_report_groups WHERE id=?", id);
    if (!r) return null;
    return { id: r.id, projectId: r.project_id, memberId: r.member_id, openedAt: r.opened_at, closesAt: r.closes_at,
      lastMessageId: r.last_message_id, state: r.state, eventId: r.event_id, closedAt: r.closed_at,
      reportIds: this.all<{ message_id: string }>("SELECT message_id FROM push_report_group_reports WHERE group_id=? ORDER BY ordinal", id).map((v) => v.message_id),
      recipients: this.all<{ device_id: string; registration_generation: number; cancelled_at: string | null }>("SELECT * FROM push_report_group_recipients WHERE group_id=? ORDER BY rowid", id)
        .map((v) => ({ deviceId: v.device_id, registrationGeneration: v.registration_generation, cancelledAt: v.cancelled_at })) };
  }
  appendReport(message: Message): PushReportGroup {
    if (message.mine || !message.memberId || message.kind !== "완료") throw new ApiError(400, "완료 보고가 아닙니다", "push_not_completion_report");
    return this.transaction(() => {
      const existing = this.one<{ group_id: string }>("SELECT group_id FROM push_report_group_reports WHERE message_id=?", message.id);
      if (existing) return this.getReportGroup(existing.group_id)!;
      const at = this.timestamp();
      this.closeDueGroups(at);
      if (!this.projectActive(message.projectId) || !this.one("SELECT 1 FROM members WHERE id=? AND project_id=?", message.memberId, message.projectId) ||
          !this.one("SELECT 1 FROM messages WHERE id=? AND project_id=? AND member_id=? AND mine=0 AND kind='완료'", message.id, message.projectId, message.memberId)) throw new ApiError(404, "보고를 찾을 수 없습니다", "report_not_found");
      let leading = false;
      let row = this.one<GroupRow>("SELECT * FROM push_report_groups WHERE project_id=? AND member_id=? AND state='open'", message.projectId, message.memberId);
      if (!row) {
        leading = true;
        const id = randomUUID();
        this.run(`INSERT INTO push_report_groups(id,project_id,member_id,opened_at,closes_at,last_message_id) VALUES(?,?,?,?,?,?)`,
          id, message.projectId, message.memberId, at, new Date(Date.parse(at) + PUSH_REPORT_GROUP_WINDOW_MS).toISOString(), message.id);
        for (const r of this.all<DeviceRow>("SELECT * FROM push_devices")) if (this.eligible(r, "report_complete", at)) {
          this.run("INSERT INTO push_report_group_recipients(group_id,device_id,registration_generation) VALUES(?,?,?)", id, r.id, r.registration_generation);
        }
        row = this.one<GroupRow>("SELECT * FROM push_report_groups WHERE id=?", id)!;
      }
      this.run(`INSERT INTO push_report_group_reports(group_id,message_id,ordinal) VALUES(?,?,(SELECT COUNT(*) FROM push_report_group_reports WHERE group_id=?))`, row.id, message.id, row.id);
      this.run("UPDATE push_report_groups SET last_message_id=? WHERE id=?", message.id, row.id);
      if (leading) {
        const group = this.getReportGroup(row.id)!;
        const saved = this.recordEvent({ sourceKey: `report-leading:${row.id}`, kind: "report_complete", projectId: message.projectId, memberId: message.memberId,
          occurredAt: at, target: { screen: "chat", projectId: message.projectId, memberId: message.memberId, messageId: message.id, groupId: row.id } }, group.recipients);
        this.run("UPDATE push_report_groups SET event_id=? WHERE id=?", saved.id, row.id);
      }
      return this.getReportGroup(row.id)!;
    });
  }
  /** Worker already wakes on committed store/Bus changes; scan also covers restart gaps. */
  recordTodoChanges(): void {
    this.transaction(() => {
      for (const row of this.all<{ id: string; project_id: string; member_id: string | null; done: number; created_at: string }>(
        "SELECT t.id,t.project_id,t.member_id,t.done,t.created_at FROM todos t LEFT JOIN push_todo_observations o ON o.todo_id=t.id WHERE o.todo_id IS NULL ORDER BY t.rowid")) {
        this.run("INSERT INTO push_todo_observations(todo_id) VALUES(?)", row.id);
        if (!row.done && this.projectActive(row.project_id)) this.recordEvent({ sourceKey: `todo:${row.id}`, kind: "todo_created",
          projectId: row.project_id, memberId: row.member_id, occurredAt: row.created_at, target: { screen: "home", projectId: row.project_id } });
      }
    });
  }
  closeDueGroups(now: string): void {
    const at = new Date(now).toISOString();
    this.transaction(() => {
      this.cancelInvalidPending();
      for (const row of this.all<GroupRow>("SELECT * FROM push_report_groups WHERE state='open' AND closes_at<=? ORDER BY closes_at,id", at)) {
        const group = this.getReportGroup(row.id)!;
        const recipients = group.recipients.filter((r) => r.cancelledAt === null);
        if (group.recipients.length && !recipients.length) {
          this.run("UPDATE push_report_groups SET state='cancelled',closed_at=? WHERE id=? AND state='open'", at, row.id);
          continue;
        }
        // Old open groups have no leading event and retain their original close behavior.
        if (this.eventBySource(`report-leading:${row.id}`) && group.reportIds.length === 1) {
          this.run("UPDATE push_report_groups SET state='closed',closed_at=? WHERE id=? AND state='open'", at, row.id);
          continue;
        }
        const saved = this.recordEvent({ sourceKey: `report-group:${row.id}`, kind: "report_complete", projectId: row.project_id, memberId: row.member_id,
          occurredAt: row.closes_at, target: { screen: "chat", projectId: row.project_id, memberId: row.member_id, messageId: row.last_message_id, groupId: row.id } }, recipients);
        this.run("UPDATE push_report_groups SET state='closed',event_id=?,closed_at=? WHERE id=? AND state='open'", saved.id, at, row.id);
      }
    });
  }
  eventTarget(id: string): PushEventTargetResult {
    const saved = this.getEvent(id);
    if (!saved || Date.parse(saved.occurredAt) <= this.now() - 90 * DAY || (saved.kind !== "test" && !this.projectActive(saved.projectId))) throw new ApiError(404, "알림을 찾을 수 없습니다", "push_event_not_found");
    if (saved.kind === "todo_created" && !this.one("SELECT 1 FROM todos WHERE id=? AND project_id=?", saved.sourceKey.slice("todo:".length), saved.projectId)) throw new ApiError(404, "알림 대상을 찾을 수 없습니다", "push_target_not_found");
    const target = saved.target;
    if (target.screen === "inbox" && !this.one("SELECT 1 FROM decisions WHERE id=? AND project_id=?", target.decisionId, target.projectId) ||
        target.screen === "team" && !this.one("SELECT 1 FROM members WHERE id=? AND project_id=?", target.memberId, target.projectId) ||
        target.screen === "chat" && !this.one("SELECT 1 FROM messages WHERE id=? AND project_id=?", target.messageId, target.projectId)) throw new ApiError(404, "알림 대상을 찾을 수 없습니다", "push_target_not_found");
    const group = target.screen === "chat" && target.groupId ? this.getReportGroup(target.groupId) : null;
    return { serverId: this.serverId, eventId: id, target, ...(group ? { reportGroup: { id: group.id, projectId: group.projectId, memberId: group.memberId,
      openedAt: group.openedAt, closesAt: group.closesAt, lastMessageId: group.lastMessageId, reportIds: group.reportIds } } : {}) };
  }
  /** TTL and retention have separate clocks. Sending is owned by the worker, never made retryable here. */
  sweep(): void {
    this.transaction(() => {
      const at = this.timestamp();
      for (const row of this.all<DeviceRow>("SELECT * FROM push_devices WHERE state='active' AND expires_at<=?", at)) this.deactivate(row, "expired", at);
      this.run("UPDATE push_deliveries SET state='expired',finished_at=? WHERE state IN ('queued','retry') AND expires_at<=?", at, at);
      this.cancelInvalidPending();
      const cutoff = new Date(this.now() - 90 * DAY).toISOString();
      this.run("DELETE FROM push_report_groups WHERE state!='open' AND COALESCE(closed_at,closes_at)<=?", cutoff);
      this.run("DELETE FROM push_events WHERE occurred_at<=? AND id NOT IN (SELECT event_id FROM push_deliveries WHERE state='sending')", cutoff);
      this.run(`DELETE FROM push_devices WHERE state!='active' AND COALESCE(revoked_at,invalidated_at,expires_at)<=?
        AND id NOT IN (SELECT device_id FROM push_deliveries WHERE state='sending')`, cutoff);
    });
  }
}
