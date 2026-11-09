import type { PushDeliveryState, PushEnvironment, PushProviderStatus } from "../../shared/push.ts";
import type { APNsClient, APNsNotification, APNsResult } from "./apns.ts";
import { PushStore } from "./store.ts";

export interface PushWorkerOptions {
  now?: () => number;
  random?: () => number;
  /** Test deadlines may be shorter, never longer than the production budgets. */
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onError?: (code: "storage_error") => void;
}
interface Candidate {
  id: string; eventId: string; deviceId: string; registrationGeneration: number;
  attempts: number; expiresAt: string;
}
interface Claim extends Candidate { leaseUntil: string; notification: APNsNotification; settledByShutdown?: boolean }

/** SQL outbox consumer. Construction does not start timers or contact APNs.
 * Call start after recovery/commit wiring; call wake only AFTER the outer domain commit.
 * The client is owned by this worker and is closed during shutdown.
 */
export class PushWorker {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;
  private stopped: Promise<void> | undefined;
  private active = new Map<Claim, () => void>();
  private holds = new Map<PushEnvironment, number>();

  constructor(readonly push: PushStore, private readonly client: Pick<APNsClient, "send" | "status" | "close">,
    private readonly options: PushWorkerOptions = {}) {
    this.now = options.now ?? (() => Date.parse(push.timestamp()));
    this.random = options.random ?? Math.random;
    this.requestTimeoutMs = Math.min(Math.max(options.requestTimeoutMs ?? 10_000, 1), 10_000);
    // openDb permits up to 5s of SQLite lock waiting. Leave that budget for one final transaction.
    this.shutdownTimeoutMs = Math.min(Math.max(options.shutdownTimeoutMs ?? 4_500, 0), 4_500);
  }

  start(): void {
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => this.background(), 1_000);
    this.timer.unref();
    this.background();
  }
  private background(): void { void this.wake().catch(() => this.options.onError?.("storage_error")); }
  wake(): Promise<void> { return this.tick(); }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    // No network may escape a transaction that can still roll back.
    if (this.push.db.inTransaction) return Promise.reject(new Error("PushWorker requires a committed transaction"));
    if (this.running) return this.running;
    const running = Promise.resolve().then(() => this.run());
    this.running = running;
    void running.then(() => { this.running = undefined; }, () => { this.running = undefined; });
    return running;
  }
  private async run(): Promise<void> {
    if (this.stopping) return;
    if (this.push.db.inTransaction) throw new Error("PushWorker requires a committed transaction");
    this.push.transaction(() => {
      // A lease is a claim lock, never permission to repeat an uncertain POST.
      this.push.db.query(`UPDATE push_deliveries SET state='unknown',last_reason='lease_expired',finished_at=?,lease_until=NULL
        WHERE state='sending' AND (lease_until IS NULL OR lease_until<=?)`).run(this.timestamp(), this.timestamp());
      this.push.recordTodoChanges();
      this.push.closeDueGroups(this.timestamp());
      this.push.sweep();
    });
    const results = await Promise.allSettled((["sandbox", "production"] as const).map((environment) => this.drain(environment)));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private provider(environment: PushEnvironment, bundleId: string): PushProviderStatus | undefined {
    return this.client.status().find((p) => p.environment === environment && p.bundleId === bundleId);
  }
  private available(environment: PushEnvironment, bundleId: string): boolean {
    if ((this.holds.get(environment) ?? 0) > this.now()) return false;
    const provider = this.provider(environment, bundleId);
    // Network errors need a due probe to recover. Authentication/configuration never does.
    return provider?.state === "ready" || (provider?.state === "temporarily_unavailable" && provider.lastError === "network_error");
  }
  private claim(environment: PushEnvironment): Claim | null {
    return this.push.transaction(() => {
      while (!this.stopping) {
        const at = this.timestamp();
        const row = this.push.db.query<Candidate, [PushEnvironment, string]>(`SELECT d.id,d.event_id eventId,d.device_id deviceId,
          d.registration_generation registrationGeneration,d.attempts,d.expires_at expiresAt FROM push_deliveries d
          JOIN push_devices p ON p.id=d.device_id WHERE d.state IN ('queued','retry') AND p.environment=? AND d.next_attempt_at<=?
          ORDER BY d.next_attempt_at,d.rowid LIMIT 1`).get(environment, at);
        if (!row) return null;
        const event = this.push.getEvent(row.eventId);
        const registration = this.push.getRegistration(row.deviceId);
        let terminal: PushDeliveryState | undefined;
        if (Date.parse(row.expiresAt) <= this.now() || (event && Date.parse(event.expiresAt) <= this.now())) terminal = "expired";
        else if (!event || !registration || registration.registrationGeneration !== row.registrationGeneration ||
          registration.device.state !== "active" || !registration.deviceToken || !registration.device.enabled ||
          !["authorized", "provisional", "ephemeral"].includes(registration.device.authorization) ||
          Date.parse(registration.device.expiresAt) <= this.now() ||
          (event.kind !== "test" && !registration.device.preferences[event.kind]) || !this.push.isEventCurrent(event)) terminal = "cancelled";
        else if (row.attempts >= 5) terminal = "failed";
        if (terminal) {
          this.push.db.query("UPDATE push_deliveries SET state=?,finished_at=?,lease_until=NULL WHERE id=? AND state IN ('queued','retry')")
            .run(terminal, at, row.id);
          continue;
        }
        if (!this.available(environment, registration!.device.bundleId)) return null;
        const leaseUntil = new Date(this.now() + 30_000).toISOString();
        const updated = this.push.db.query(`UPDATE push_deliveries SET state='sending',attempts=attempts+1,lease_until=?
          WHERE id=? AND state IN ('queued','retry') AND next_attempt_at<=? AND registration_generation=?`)
          .run(leaseUntil, row.id, at, row.registrationGeneration);
        if (!updated.changes) continue;
        return { ...row, attempts: row.attempts + 1, leaseUntil, notification: { environment,
          deviceToken: registration!.deviceToken!, deliveryId: row.id, eventId: row.eventId, serverId: this.push.serverId,
          kind: event!.kind, target: event!.target, occurredAt: event!.occurredAt, reportSummary: event!.sourceKey.startsWith("report-group:"),
          expiresAt: new Date(Math.min(Date.parse(row.expiresAt), Date.parse(event!.expiresAt))).toISOString() } };
      }
      return null;
    });
  }
  private async drain(environment: PushEnvironment): Promise<void> {
    // Bound each turn so a large outbox cannot monopolize the event loop.
    for (let i = 0; i < 100 && !this.stopping; i++) {
      const claim = this.claim(environment);
      if (!claim) return;
      await this.dispatch(claim);
    }
  }
  private owns(claim: Claim): boolean {
    return !!this.push.db.query(`SELECT 1 FROM push_deliveries WHERE id=? AND state='sending' AND attempts=?
      AND lease_until=? AND registration_generation=?`).get(claim.id, claim.attempts, claim.leaseUntil, claim.registrationGeneration);
  }
  private async dispatch(claim: Claim): Promise<void> {
    if (!this.owns(claim)) return;
    // Read again immediately before handing the immutable request to the HTTP/2 client.
    const registration = this.push.getRegistration(claim.deviceId);
    const event = this.push.getEvent(claim.eventId);
    if (this.stopping || !registration || registration.registrationGeneration !== claim.registrationGeneration ||
      registration.deviceToken !== claim.notification.deviceToken || registration.device.state !== "active" ||
      !registration.device.enabled || !["authorized", "provisional", "ephemeral"].includes(registration.device.authorization) ||
      Date.parse(registration.device.expiresAt) <= this.now() || !event || !this.push.isEventCurrent(event) ||
      (event.kind !== "test" && !registration.device.preferences[event.kind])) {
      this.finish(claim, "cancelled", "cancelled");
      return;
    }
    if (Date.parse(claim.notification.expiresAt) <= this.now()) { this.finish(claim, "expired", "expired"); return; }
    if (!this.available(claim.notification.environment, registration.device.bundleId)) {
      this.apply(claim, { state: "unavailable", reason: "unconfigured" });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<APNsResult>((resolve) => {
      this.active.set(claim, () => resolve({ state: "unknown", reason: "shutdown" }));
      timer = setTimeout(() => resolve({ state: "unknown", reason: "timeout" }), this.requestTimeoutMs);
    });
    try {
      let response: Promise<APNsResult>;
      try { response = this.client.send(claim.notification); }
      catch { response = Promise.resolve({ state: "unknown", reason: "network_error" }); }
      const result = await Promise.race([response.catch((): APNsResult => ({ state: "unknown", reason: "network_error" })), interrupted]);
      if (!claim.settledByShutdown) this.apply(claim, result);
    } finally {
      clearTimeout(timer);
      this.active.delete(claim);
    }
  }
  private finish(claim: Claim, state: PushDeliveryState, reason: string, status: number | null = null, nextAt?: number): boolean {
    const at = this.timestamp();
    return !!this.push.db.query(`UPDATE push_deliveries SET state=?,last_reason=?,last_status=?,lease_until=NULL,
      accepted_at=?,finished_at=?,next_attempt_at=? WHERE id=? AND state='sending' AND attempts=? AND lease_until=? AND registration_generation=?`)
      .run(state, reason, status, state === "accepted" ? at : null, state === "retry" ? null : at,
        nextAt === undefined ? at : new Date(nextAt).toISOString(), claim.id, claim.attempts, claim.leaseUntil, claim.registrationGeneration).changes;
  }
  private apply(claim: Claim, result: APNsResult): void {
    this.push.transaction(() => {
      if (!this.owns(claim)) return;
      // APNsClient already discards opaque response text; repeat the allowlist at persistence.
      const reason = ["accepted", "Unregistered", "ExpiredToken", "BadDeviceToken", "DeviceTokenNotForTopic", "TooManyRequests",
        "server_error", "PayloadTooLarge", "permanent_rejection", "ExpiredProviderToken", "TooManyProviderTokenUpdates", "auth_failed",
        "invalid_key", "clock_rollback", "unconfigured", "shutdown", "network_error", "timeout", "goaway", "invalid_response",
        "invalid_payload", "invalid_expiration", "expired"].includes(result.reason) ? result.reason : "invalid_response";
      const status = result.status !== undefined && Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : null;
      if (result.state === "retry" || result.state === "unavailable") {
        const registration = this.push.getRegistration(claim.deviceId);
        const event = this.push.getEvent(claim.eventId);
        if (Date.parse(claim.notification.expiresAt) <= this.now()) { this.finish(claim, "expired", reason, status); return; }
        if (!registration || registration.registrationGeneration !== claim.registrationGeneration || !registration.device.enabled ||
          registration.device.state !== "active" || !registration.deviceToken ||
          !["authorized", "provisional", "ephemeral"].includes(registration.device.authorization) ||
          Date.parse(registration.device.expiresAt) <= this.now() || !event || !this.push.isEventCurrent(event) ||
          (event.kind !== "test" && !registration.device.preferences[event.kind])) {
          this.finish(claim, "cancelled", reason, status); return;
        }
        const delay = [5_000, 15_000, 60_000, 300_000][Math.min(Math.max(claim.attempts - 1, 0), 3)];
        const retryAt = Math.max(this.now() + Math.round(delay * (0.8 + Math.min(Math.max(this.random(), 0), 1) * 0.4)),
          Number.isFinite(result.retryAt) ? result.retryAt! : 0);
        if (result.state === "unavailable") {
          this.holds.set(claim.notification.environment, result.retryAt === undefined ? Infinity : retryAt);
        } else if (status === null) this.holds.set(claim.notification.environment, retryAt);
        if (retryAt >= Date.parse(claim.notification.expiresAt)) this.finish(claim, "expired", reason, status);
        else if (result.state === "retry" && claim.attempts >= 5) this.finish(claim, "failed", reason, status);
        else if (this.finish(claim, "retry", reason, status, retryAt) && result.state === "unavailable") {
          // A suspended provider has not attempted this delivery; don't consume its retry budget.
          this.push.db.query("UPDATE push_deliveries SET attempts=attempts-1 WHERE id=? AND state='retry'").run(claim.id);
        }
      } else {
        if (!this.finish(claim, result.state, reason, status)) return;
        if (result.state === "invalid") this.push.invalidateDevice(claim.deviceId, claim.registrationGeneration, result.invalidatedAt);
        // Drain/GOAWAY/connection loss must stop new claims before a later connection probe.
        if (result.state === "unknown" && status === null) this.holds.set(claim.notification.environment, this.now() + 5_000);
      }
      const failure = result.state === "unavailable" || result.state === "failed" ? "provider_error" : "temporary_error";
      // Never resurrect a revoked device, nor let an old generation overwrite new diagnostics.
      if (result.state !== "invalid" && result.state !== "expired") this.push.db.query(`UPDATE push_devices SET
        last_accepted_at=CASE WHEN ?='accepted' THEN ? ELSE last_accepted_at END,last_failure=?
        WHERE id=? AND state='active' AND registration_generation=?`).run(result.state, this.timestamp(),
          result.state === "accepted" ? null : failure, claim.deviceId, claim.registrationGeneration);
    });
  }
  shutdown(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.stopped = this.stop();
    return this.stopped;
  }
  private async stop(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.running) await Promise.race([this.running,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.shutdownTimeoutMs); })]);
    } finally {
      clearTimeout(timer);
      try { this.client.close(); }
      finally {
        // Persist before resolving shutdown; late client responses cannot overwrite unknown.
        const active = [...this.active];
        for (const [claim, interrupt] of active) { claim.settledByShutdown = true; interrupt(); }
        try {
          if (active.length) this.push.transaction(() => { for (const [claim] of active) this.finish(claim, "unknown", "shutdown"); });
        }
        finally { await this.running; }
      }
    }
  }
}
