import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { IncomingHttpHeaders } from "node:http2";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { APNsClient, HTTP2APNsTransport } from "../server/push/apns.ts";
import type { APNsTransport, APNsTransportRequest, APNsTransportResult } from "../server/push/apns.ts";
import type { APNsConfig } from "../server/push/config.ts";
import { PushEventRecorder } from "../server/push/events.ts";
import { PushStore } from "../server/push/store.ts";
import { PushWorker } from "../server/push/worker.ts";
import type { PushWorkerOptions } from "../server/push/worker.ts";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";
import type { PushEnvironment, PushKind } from "../shared/push.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import { EventEmitter } from "node:events";
import type { ClientHttp2Session } from "node:http2";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const start = Date.parse("2026-11-07T00:00:00.123Z");
const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const canary = "PRIVATE-ERROR-PATH-AND-TOKEN-CANARY";
function response(status = 200, reason?: string, headers: IncomingHttpHeaders = {}, timestamp?: number): APNsTransportResult {
  return { type: "response", status, headers, body: reason ? JSON.stringify({ reason, timestamp }) : "" };
}
class Transport implements APNsTransport {
  requests: APNsTransportRequest[] = [];
  closed = false;
  handler: (request: APNsTransportRequest) => APNsTransportResult | Promise<APNsTransportResult> = () => response();
  async send(request: APNsTransportRequest) { this.requests.push(request); return this.handler(request); }
  close(): void { this.closed = true; }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Fixture did not reach the expected state");
}
function fixture(options: PushWorkerOptions = {}, persistent = false) {
  const runtime = persistent ? createIsolatedRuntime() : undefined;
  if (runtime) cleanups.push(() => runtime.stop());
  const path = runtime ? join(runtime.paths.iamceoHome, "push-worker.db") : ":memory:";
  let db = openDb(path);
  cleanups.push(() => db.close());
  let now = start;
  const config: APNsConfig = { credentials: {}, providers: [] };
  for (const environment of ["sandbox", "production"] as const) {
    config.credentials[environment] = { environment, key, bundleId: DEFAULT_PUSH_BUNDLE_ID, keyId: "TESTKEY123", teamId: "TESTTEAM12", cacheKey: environment };
    config.providers.push({ environment, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready", lastError: null });
  }
  const transport = new Transport();
  let client = new APNsClient(config, { transport, now: () => now });
  const pushOptions = { now: () => now, providers: () => client.status() };
  let push = new PushStore(db, pushOptions);
  let store = new Store(db, new Bus());
  let recorder = new PushEventRecorder(push);
  const project = store.createProject({ name: "fixture", cwd: runtime?.paths.work ?? "/fixture", runnerEnabled: false });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "worker", kind: "worker" });
  let worker = new PushWorker(push, client, { now: () => now, random: () => 0.5, ...options });
  cleanups.push(() => worker.shutdown());
  function enabled(token = "ab", environment: PushEnvironment = "sandbox") {
    const value = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID,
      environment, deviceToken: token, authorization: "authorized" });
    return push.patchDevice(value.id, { expectedRevision: value.revision, enabled: true });
  }
  function event(kind: PushKind | "test" = "test") {
    if (kind === "decision") return store.transaction(() => {
      const value = store.createDecision({ projectId: project.id, memberId: member.id, who: "fixture", title: canary, options: [] });
      recorder.decision(null, value);
      return push.listEvents().at(-1)!;
    });
    if (kind === "report_complete") {
      const message = store.createMessage({ projectId: project.id, memberId: member.id, kind: "완료", body: canary });
      return push.recordEvent({ sourceKey: `report:${message.id}`, kind, projectId: project.id, memberId: member.id,
        target: { screen: "chat", projectId: project.id, memberId: member.id, messageId: message.id }, occurredAt: push.timestamp() });
    }
    if (kind === "error" || kind === "approval_wait") {
      const before = store.requireMember(member.id);
      const after = { ...before, status: kind === "error" ? "error" as const : "blocked" as const,
        blockedReason: kind === "approval_wait" ? "permission" as const : null, lastError: kind === "error" ? canary : null };
      store.transaction(() => {
        db.query("UPDATE members SET status=?,blocked_reason=?,last_error=? WHERE id=?").run(after.status, after.blockedReason, after.lastError, member.id);
        recorder.member(before, after);
      });
      return push.listEvents().at(-1)!;
    }
    return push.recordEvent({ sourceKey: `test:${randomUUID()}`, kind, projectId: null, memberId: null, target: { screen: "home" }, occurredAt: push.timestamp() });
  }
  return { get db() { return db; }, get push() { return push; }, get worker() { return worker; }, get client() { return client; },
    get store() { return store; }, get recorder() { return recorder; }, now: () => now,
    project, member, config, transport, enabled, event, advance: (ms: number) => { now += ms; },
    delivery: (id?: string) => push.listDeliveries(id)[0],
    restart: async () => {
      await worker.shutdown();
      if (persistent) { db.close(); db = openDb(path); }
      client = new APNsClient(config, { transport, now: () => now });
      push = new PushStore(db, pushOptions); store = new Store(db, new Bus()); recorder = new PushEventRecorder(push);
      worker = new PushWorker(push, client, { now: () => now, random: () => 0.5, ...options });
    } };
}

describe("outbox claims and event revalidation", () => {
  test("all four kinds and test reach HTTP/2 with stable IDs, TTL and fixed private payloads", async () => {
    const f = fixture(); f.enabled();
    for (const kind of ["decision", "approval_wait", "error", "report_complete", "test"] as const) {
      f.event(kind); await f.worker.tick();
    }
    expect(f.transport.requests).toHaveLength(5);
    expect(f.push.listDeliveries().every((d) => d.state === "accepted" && d.attempts === 1 && d.leaseUntil === null)).toBe(true);
    for (const request of f.transport.requests) {
      const payload = JSON.parse(request.body);
      const event = f.push.getEvent(payload.iamceo.eventId)!;
      const delivery = f.delivery(event.id);
      expect(request.headers["apns-id"]).toBe(delivery.id);
      expect(request.headers["apns-collapse-id"]).toBe(event.id);
      expect(request.headers["apns-expiration"]).toBe(String(Math.floor(Date.parse(event.expiresAt) / 1000)));
      expect(request.headers["apns-topic"]).toBe("com.yehsung.iamceo");
      expect(request.body).not.toContain(canary);
      expect(payload.aps.alert.title).toBe("IAMCEO");
    }
    expect(f.push.listDevices()[0].lastAcceptedAt).toBe(f.push.timestamp());
    await f.worker.tick(); expect(f.transport.requests).toHaveLength(5);
  });
  test("two worker instances and concurrent wake/tick calls claim a delivery only once with a 30s lease", async () => {
    const f = fixture(); f.enabled(); f.event();
    const result = deferred<APNsTransportResult>();
    f.transport.handler = () => result.promise;
    const other = new PushWorker(new PushStore(f.db, { now: f.now }), f.client, { now: f.now });
    cleanups.push(() => other.shutdown());
    const first = f.worker.tick();
    expect(f.worker.wake()).toBe(first);
    await until(() => f.transport.requests.length === 1);
    expect(f.delivery()).toMatchObject({ state: "sending", attempts: 1, leaseUntil: new Date(start + 30_000).toISOString() });
    await other.tick(); expect(f.transport.requests).toHaveLength(1);
    result.resolve(response()); await first;
    expect(f.delivery().state).toBe("accepted");
  });
  test("independent SQLite connections see the committed claim and cannot duplicate its POST", async () => {
    const f = fixture({}, true); f.enabled(); f.event();
    const dbPath = f.db.query<{ file: string }, []>("PRAGMA database_list").get()!.file;
    const db = openDb(dbPath); cleanups.push(() => db.close());
    const other = new PushWorker(new PushStore(db, { now: f.now }), f.client, { now: f.now });
    cleanups.push(() => other.shutdown());
    const result = deferred<APNsTransportResult>(); f.transport.handler = () => result.promise;
    const first = f.worker.tick(); await until(() => f.transport.requests.length === 1);
    await other.tick(); expect(f.transport.requests).toHaveLength(1);
    result.resolve(response()); await first; await other.tick();
    expect(f.transport.requests).toHaveLength(1); expect(f.delivery().state).toBe("accepted");
  });
  test("wake refuses uncommitted domain work and rollback sends nothing", async () => {
    const f = fixture(); f.enabled();
    let wake!: Promise<void>;
    expect(() => f.store.transaction(() => { f.event(); wake = f.worker.wake(); throw new Error("rollback"); })).toThrow("rollback");
    await expect(wake).rejects.toThrow("committed transaction");
    expect(f.push.listEvents()).toEqual([]);
    expect(f.transport.requests).toHaveLength(0);
  });
  test("answer/reopen revision, solved episodes, archived project and deleted report cancel before send", async () => {
    for (const kind of ["decision", "approval_wait", "error", "report_complete"] as const) {
      const f = fixture(); f.enabled(); const event = f.event(kind);
      if (event.target.screen === "inbox") f.db.query("UPDATE decisions SET updated_at='new-version' WHERE id=?").run(event.target.decisionId);
      if (kind === "approval_wait" || kind === "error") {
        const episode = f.push.getEpisode(f.member.id)!;
        f.push.saveEpisode({ ...episode, blockedActive: false, errorActive: false });
      }
      if (event.target.screen === "chat") f.db.query("DELETE FROM messages WHERE id=?").run(event.target.messageId);
      await f.worker.tick();
      expect(f.delivery().state).toBe("cancelled"); expect(f.transport.requests).toHaveLength(0);
    }
    const f = fixture(); f.enabled(); f.event("decision");
    f.db.query("UPDATE projects SET archived=1 WHERE id=?").run(f.project.id);
    await f.worker.tick(); expect(f.delivery().state).toBe("cancelled");
    const g = fixture(); g.enabled(); g.event("decision");
    g.db.query("UPDATE decisions SET status='answered' WHERE project_id=?").run(g.project.id);
    await g.worker.tick(); expect(g.delivery().state).toBe("cancelled");
  });
  test("latest device enabled, authorization, kind preference, generation and registration expiry are rechecked", async () => {
    for (const mutation of ["disabled", "permission", "kind", "generation", "expiry"] as const) {
      const f = fixture(); const device = f.enabled(); f.event("decision");
      const sql = { disabled: "enabled=0", permission: "authorization='denied'", kind: `preferences='{"decision":false}'`,
        generation: "registration_generation=registration_generation+1", expiry: `expires_at='${new Date(f.now() - 1).toISOString()}'` }[mutation];
      f.db.query(`UPDATE push_devices SET ${sql} WHERE id=?`).run(device.id);
      await f.worker.tick();
      expect(f.delivery().state).toBe("cancelled"); expect(f.transport.requests).toHaveLength(0);
    }
  });
  test("a second queued request is revalidated after waiting for the first stream", async () => {
    const f = fixture(); const device = f.enabled(); f.event(); f.event();
    const result = deferred<APNsTransportResult>(); f.transport.handler = () => result.promise;
    const tick = f.worker.tick(); await until(() => f.transport.requests.length === 1);
    f.push.revokeDevice(device.id, device.revision);
    result.resolve(response()); await tick;
    expect(f.push.listDeliveries().map((d) => d.state)).toEqual(["accepted", "cancelled"]);
    expect(f.push.getDevice(device.id)).toMatchObject({ state: "revoked", enabled: false, lastAcceptedAt: null });
    expect(f.transport.requests).toHaveLength(1);
  });
  test("new token is read for queued work, while results for the old stream cannot alter its diagnostics", async () => {
    const f = fixture(); const device = f.enabled(); f.event(); f.event();
    const result = deferred<APNsTransportResult>(); f.transport.handler = () => f.transport.requests.length === 1 ? result.promise : response();
    const tick = f.worker.tick(); await until(() => f.transport.requests.length === 1);
    f.push.registerDevice(device.id, { expectedRevision: device.revision, platform: "ios", bundleId: device.bundleId,
      environment: device.environment, deviceToken: "cd", authorization: "authorized" });
    result.resolve(response()); await tick;
    expect(f.transport.requests.map((r) => r.headers[":path"])).toEqual(["/3/device/ab", "/3/device/cd"]);
    expect(f.push.listDeliveries().map((d) => d.registrationGeneration)).toEqual([1, 2]);
  });
});

describe("report group deadlines", () => {
  test("fixed 120s group closes after restart, uses last report, and snapshots only the original recipients", async () => {
    const f = fixture({}, true); const original = f.enabled();
    const report = () => f.store.transaction(() => {
      const message = f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "완료", body: canary });
      f.recorder.message(message); return message;
    });
    const first = report(); f.advance(119_999); const last = report();
    const group = f.db.query<{ id: string }, []>("SELECT id FROM push_report_groups").get()!;
    f.enabled("cd");
    await f.worker.tick(); expect(f.transport.requests).toHaveLength(1);
    expect(JSON.parse(f.transport.requests[0].body).iamceo.target.messageId).toBe(first.id);
    await f.restart(); f.advance(1); await f.worker.tick();
    expect(f.push.getReportGroup(group.id)).toMatchObject({ state: "closed", reportIds: [first.id, last.id], lastMessageId: last.id });
    expect(f.push.listEvents()).toHaveLength(2);
    expect(f.delivery()).toMatchObject({ state: "accepted", deviceId: original.id });
    const payload = JSON.parse(f.transport.requests[1].body);
    expect(payload.aps.alert.body).toBe("추가 완료 보고가 도착했습니다.");
    expect(payload.iamceo.target).toMatchObject({ messageId: last.id, groupId: group.id });
    await f.restart(); await f.worker.tick();
    expect(f.transport.requests).toHaveLength(2); expect(f.push.listEvents()).toHaveLength(2);
  });
  test("opt-out/re-enable never resurrects cancelled group recipients; late deadline beyond TTL sends nothing", async () => {
    const f = fixture(); const device = f.enabled();
    const message = f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "완료" });
    const group = f.push.appendReport(message);
    const off = f.push.patchDevice(device.id, { expectedRevision: device.revision, enabled: false });
    f.push.patchDevice(device.id, { expectedRevision: off.revision, enabled: true });
    f.advance(120_000); await f.worker.tick();
    expect(f.push.getReportGroup(group.id)?.state).toBe("cancelled");
    expect(f.transport.requests).toHaveLength(0);
    const g = fixture(); g.enabled();
    g.push.appendReport(g.store.createMessage({ projectId: g.project.id, memberId: g.member.id, kind: "완료" }));
    g.advance(120_000 + 3_600_000); await g.worker.tick();
    expect(g.push.listEvents()).toHaveLength(1); expect(g.push.listDeliveries().map(d => d.state)).toEqual(["expired"]);
  });
});

describe("HTTP/2 results, retries and provider isolation", () => {
  for (const [status, reason, expected] of [
    [200, undefined, "accepted"], [400, "BadDeviceToken", "invalid"], [400, "DeviceTokenNotForTopic", "invalid"],
    [410, "Unregistered", "invalid"], [410, "ExpiredToken", "invalid"], [413, "PayloadTooLarge", "failed"],
    [400, canary, "failed"], [429, "TooManyRequests", "retry"], [500, canary, "retry"], [503, canary, "retry"],
    [302, canary, "unknown"],
  ] as const) test(`${status} ${reason ?? ""} persists ${expected} without response secrets`, async () => {
    const f = fixture(); f.enabled(); f.event();
    f.transport.handler = () => response(status, reason);
    await f.worker.tick(); expect(f.delivery()).toMatchObject({ state: expected, lastStatus: status });
    expect(JSON.stringify(f.push.listDeliveries())).not.toContain(canary);
    if (expected === "invalid") expect(f.push.listDevices()[0]).toMatchObject({ state: "invalid", enabled: false, lastFailure: "token_invalid" });
  });
  test("retry backoff 5/15/60/300s is persisted, never early, uses the same IDs, and stops after five attempts", async () => {
    const f = fixture(); f.enabled(); const event = f.event("decision");
    f.transport.handler = () => response(503);
    for (const [index, delay] of [5_000, 15_000, 60_000, 300_000].entries()) {
      await f.worker.tick();
      expect(f.delivery(event.id)).toMatchObject({ state: "retry", attempts: index + 1, nextAttemptAt: new Date(f.now() + delay).toISOString() });
      f.advance(delay - 1); await f.worker.tick(); expect(f.transport.requests).toHaveLength(index + 1);
      f.advance(1);
    }
    await f.worker.tick(); expect(f.delivery().state).toBe("failed"); expect(f.delivery().attempts).toBe(5);
    f.advance(600_000); await f.worker.tick(); expect(f.transport.requests).toHaveLength(5);
    expect(new Set(f.transport.requests.map((r) => r.headers["apns-id"])).size).toBe(1);
    expect(new Set(f.transport.requests.map((r) => r.headers["apns-collapse-id"])).size).toBe(1);
  });
  test("jitter endpoints are +/-20%; Retry-After is a minimum and TTL takes priority", async () => {
    for (const [random, delay] of [[0, 4_000], [1, 6_000]] as const) {
      const f = fixture({ random: () => random }); f.enabled(); f.event(); f.transport.handler = () => response(500);
      await f.worker.tick(); expect(Date.parse(f.delivery().nextAttemptAt) - f.now()).toBe(delay);
    }
    const f = fixture(); f.enabled(); f.event(); f.transport.handler = () => response(429, "TooManyRequests", { "retry-after": "90" });
    await f.worker.tick(); expect(Date.parse(f.delivery().nextAttemptAt) - f.now()).toBe(90_000);
    f.advance(90_000); f.transport.handler = () => response(503, undefined, { "retry-after": "600" });
    await f.worker.tick(); expect(f.delivery().state).toBe("expired"); expect(f.transport.requests).toHaveLength(2);
  });
  test("expired event and subsecond APNs expiration never send; due retry survives a DB restart", async () => {
    const f = fixture({}, true); f.enabled(); f.event(); f.transport.handler = () => response(500);
    await f.worker.tick(); await f.restart(); f.advance(4_999); await f.worker.tick(); expect(f.transport.requests).toHaveLength(1);
    f.advance(1); f.transport.handler = () => response(); await f.worker.tick(); expect(f.delivery().state).toBe("accepted");
    const g = fixture(); g.enabled(); g.event(); g.advance(300_000); await g.worker.tick(); expect(g.delivery().state).toBe("expired");
    expect(g.transport.requests).toHaveLength(0);
    const h = fixture(); h.enabled(); h.event(); h.advance(299_877); await h.worker.tick();
    expect(h.delivery().state).toBe("expired"); expect(h.transport.requests).toHaveLength(0);
  });
  test("pre-write timeout/GOAWAY are retryable; post-write and malformed responses are unknown and never replayed", async () => {
    for (const type of ["not_sent", "unknown"] as const) for (const reason of ["timeout", "goaway", "invalid_response"] as const) {
      const f = fixture(); f.enabled(); f.event(); f.transport.handler = () => ({ type, reason });
      await f.worker.tick(); expect(f.delivery().state).toBe(type === "not_sent" ? "retry" : "unknown");
      f.advance(5_000); f.transport.handler = () => response(); await f.worker.tick();
      expect(f.transport.requests).toHaveLength(type === "not_sent" ? 2 : 1);
    }
    const f = fixture(); f.enabled(); f.event(); f.transport.handler = () => ({ type: "response", status: 410, headers: {}, body: "{" });
    await f.worker.tick(); expect(f.delivery()).toMatchObject({ state: "failed", lastReason: "permanent_rejection" });
    expect(f.push.listDevices()[0].state).toBe("active");
  });
  test("connection loss stops new environment claims until the due connection probe", async () => {
    for (const type of ["not_sent", "unknown"] as const) {
      const f = fixture(); f.enabled(); f.event(); f.event();
      f.transport.handler = () => ({ type, reason: "goaway" });
      await f.worker.tick(); expect(f.transport.requests).toHaveLength(1);
      expect(f.push.listDeliveries().map((d) => d.state)).toEqual([type === "not_sent" ? "retry" : "unknown", "queued"]);
      f.advance(4_999); await f.worker.tick(); expect(f.transport.requests).toHaveLength(1);
      f.advance(1); f.transport.handler = () => response(); await f.worker.tick();
      expect(f.transport.requests).toHaveLength(type === "not_sent" ? 3 : 2);
    }
  });
  test("a definite rejection after opt-out cancels instead of creating a fresh retry", async () => {
    const f = fixture(); const device = f.enabled(); f.event();
    const result = deferred<APNsTransportResult>(); f.transport.handler = () => result.promise;
    const tick = f.worker.tick(); await until(() => f.transport.requests.length === 1);
    f.push.patchDevice(device.id, { expectedRevision: device.revision, enabled: false });
    result.resolve(response(503)); await tick;
    expect(f.delivery()).toMatchObject({ state: "cancelled", leaseUntil: null, lastStatus: 503 });
  });
  test("GOAWAY lastStreamID proof from the real transport controls retry versus unknown", async () => {
    for (const lastStreamID of [0, 1]) {
      const f = fixture(); f.enabled(); f.event();
      const session = new EventEmitter() as EventEmitter & Record<string, any>;
      const stream = new EventEmitter() as EventEmitter & Record<string, any>;
      Object.assign(stream, { id: 1, closed: false, rstCode: 0, close() { this.closed = true; },
        end() { queueMicrotask(() => session.emit("goaway", 0, lastStreamID)); } });
      Object.assign(session, { connecting: false, alpnProtocol: "h2", closed: false, destroyed: false,
        request: () => stream, close() { this.closed = true; }, destroy() { this.destroyed = true; } });
      const transport = new HTTP2APNsTransport(() => session as unknown as ClientHttp2Session);
      const client = new APNsClient(f.config, { transport, now: f.now });
      const worker = new PushWorker(f.push, client, { now: f.now, random: () => 0.5 }); cleanups.push(() => worker.shutdown());
      await worker.tick(); expect(f.delivery().state).toBe(lastStreamID === 0 ? "retry" : "unknown");
    }
  });
  test("missing keys and auth failures hold one environment without invalidating devices or blocking the other", async () => {
    for (const reason of ["InvalidProviderToken", "Forbidden", "ExpiredProviderToken"] as const) {
      const f = fixture(); const sandbox = f.enabled(); f.enabled("cd", "production"); f.event();
      f.transport.handler = (request) => request.credential.environment === "sandbox" ? response(403, reason) : response();
      await f.worker.tick();
      expect(f.push.listDeliveries().map((d) => d.state)).toEqual(["retry", "accepted"]);
      expect(f.push.getDevice(sandbox.id)).toMatchObject({ state: "active", enabled: true, lastFailure: "provider_error" });
      f.advance(60_000); await f.worker.tick(); expect(f.transport.requests).toHaveLength(2);
      f.advance(300_000); await f.worker.tick(); expect(f.delivery().state).toBe("expired");
    }
    const f = fixture(); f.enabled(); f.event();
    f.config.providers[0].state = "unconfigured"; delete f.config.credentials.sandbox;
    await f.worker.tick(); expect(f.delivery()).toMatchObject({ state: "queued", attempts: 0 }); expect(f.transport.requests).toHaveLength(0);
    f.advance(300_000); await f.worker.tick(); expect(f.delivery().state).toBe("expired");
  });
  test("provider token update limit waits for the provider's retryAt without creating a new JWT", async () => {
    const f = fixture(); f.enabled(); f.event("decision");
    f.transport.handler = () => f.transport.requests.length === 1 ? response(429, "TooManyProviderTokenUpdates") : response();
    await f.worker.tick();
    expect(f.delivery()).toMatchObject({ state: "retry", attempts: 0 });
    const retryAt = Date.parse(f.delivery().nextAttemptAt);
    expect(retryAt - f.now()).toBe(20 * 60_000);
    f.advance(retryAt - f.now() - 1); await f.worker.tick(); expect(f.transport.requests).toHaveLength(1);
    f.advance(1); await f.worker.tick(); expect(f.delivery().state).toBe("accepted");
    expect(f.transport.requests[0].headers.authorization).toBe(f.transport.requests[1].headers.authorization);
  });
});

describe("token generation, recovery and shutdown", () => {
  test("410 milliseconds invalidate the current registration and cancel its remaining deliveries", async () => {
    const f = fixture(); const device = f.enabled(); f.event(); f.event();
    f.transport.handler = () => response(410, "Unregistered", {}, start);
    await f.worker.tick();
    expect(f.push.getRegistration(device.id)).toMatchObject({ deviceToken: null, device: { state: "invalid", enabled: false } });
    expect(f.push.listDeliveries().map((d) => d.state)).toEqual(["invalid", "cancelled"]);
    expect(f.transport.requests).toHaveLength(1);
  });
  test("old generation 410 after token renewal cannot invalidate the new token or retarget an old sending row", async () => {
    const f = fixture(); const device = f.enabled(); f.event(); f.event();
    const result = deferred<APNsTransportResult>();
    f.transport.handler = () => f.transport.requests.length === 1 ? result.promise : response();
    const tick = f.worker.tick(); await until(() => f.transport.requests.length === 1);
    f.advance(1_000);
    f.push.registerDevice(device.id, { expectedRevision: device.revision, platform: "ios", bundleId: device.bundleId,
      environment: device.environment, deviceToken: "cd", authorization: "authorized" });
    result.resolve(response(410, "Unregistered", {}, f.now())); await tick;
    expect(f.push.getRegistration(device.id)).toMatchObject({ deviceToken: "cd", registrationGeneration: 2, device: { state: "active", enabled: true, lastFailure: null } });
    expect(f.push.listDeliveries().map((d) => [d.state, d.registrationGeneration])).toEqual([["invalid", 1], ["accepted", 2]]);
  });
  test("410 older than registeredAt preserves the device, missing/invalid timestamp uses generation", async () => {
    for (const timestamp of [start - 1, undefined, NaN, -1]) {
      const f = fixture(); const device = f.enabled(); f.event(); f.transport.handler = () => response(410, "Unregistered", {}, timestamp);
      await f.worker.tick(); expect(f.push.getDevice(device.id)?.state).toBe(timestamp === start - 1 ? "active" : "invalid");
    }
  });
  test("restart waits for an unexpired lease, then records unknown; accepted/unknown are never resent", async () => {
    const f = fixture({}, true); f.enabled(); f.event(); f.event(); f.event();
    const [sending, accepted, unknown] = f.push.listDeliveries();
    f.db.query("UPDATE push_deliveries SET state='sending',attempts=1,lease_until=? WHERE id=?").run(new Date(start + 30_000).toISOString(), sending.id);
    f.db.query("UPDATE push_deliveries SET state='accepted' WHERE id=?").run(accepted.id);
    f.db.query("UPDATE push_deliveries SET state='unknown' WHERE id=?").run(unknown.id);
    await f.restart(); await f.worker.tick(); expect(f.delivery().state).toBe("sending");
    f.advance(30_000); await f.worker.tick(); expect(f.delivery()).toMatchObject({ state: "unknown", lastReason: "lease_expired", leaseUntil: null });
    await f.restart(); f.advance(300_000); await f.worker.tick();
    expect(f.push.listDeliveries().map((d) => d.state)).toEqual(["unknown", "accepted", "unknown"]);
    expect(f.transport.requests).toHaveLength(0);
  });
  test("legacy sending without a lease becomes unknown, and a late success cannot overwrite reaped unknown", async () => {
    const f = fixture(); f.enabled(); f.event();
    f.db.query("UPDATE push_deliveries SET state='sending' WHERE id=?").run(f.delivery().id);
    await f.worker.tick(); expect(f.delivery().state).toBe("unknown");
    const g = fixture(); g.enabled(); g.event(); const result = deferred<APNsTransportResult>(); g.transport.handler = () => result.promise;
    const tick = g.worker.tick(); await until(() => g.transport.requests.length === 1);
    g.advance(30_000);
    const observer = new PushWorker(g.push, g.client, { now: g.now }); cleanups.push(() => observer.shutdown());
    await observer.tick(); result.resolve(response()); await tick;
    expect(g.delivery().state).toBe("unknown"); expect(g.push.listDevices()[0].lastAcceptedAt).toBeNull();
  });
  test("storage failure after APNs acceptance leaves sending fenced; recovery never repeats the POST", async () => {
    const f = fixture(); f.enabled(); f.event();
    f.db.exec("CREATE TEMP TRIGGER fail_accept BEFORE UPDATE ON push_deliveries WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'disk full'); END");
    await expect(f.worker.tick()).rejects.toThrow("disk full");
    expect(f.delivery().state).toBe("sending"); expect(f.push.listDevices()[0].lastAcceptedAt).toBeNull();
    f.db.exec("DROP TRIGGER fail_accept"); f.advance(30_000); await f.worker.tick();
    expect(f.delivery().state).toBe("unknown"); expect(f.transport.requests).toHaveLength(1);
  });
  test("thrown transport errors and a nonsettling client timeout are unknown without automatic replay", async () => {
    const f = fixture(); f.enabled(); f.event(); f.transport.handler = () => { throw new Error(canary); };
    await f.worker.tick(); expect(f.delivery()).toMatchObject({ state: "unknown", lastReason: "network_error" });
    expect(JSON.stringify(f.push.listDeliveries())).not.toContain(canary);
    const g = fixture({ requestTimeoutMs: 15 }); g.enabled(); g.event(); g.transport.handler = () => new Promise(() => {});
    await g.worker.tick(); expect(g.delivery()).toMatchObject({ state: "unknown", lastReason: "timeout" });
    g.advance(30_000); await g.worker.tick(); expect(g.transport.requests).toHaveLength(1);
  });
  test("shutdown stops new claims, finishes within 10 seconds, closes transport, persists unknown and ignores late response", async () => {
    const f = fixture({ shutdownTimeoutMs: 15 }); f.enabled(); f.event(); f.event();
    const result = deferred<APNsTransportResult>(); f.transport.handler = () => result.promise;
    const tick = f.worker.tick(); await until(() => f.transport.requests.length === 1);
    const before = performance.now(); const shutdown = f.worker.shutdown();
    expect(f.worker.shutdown()).toBe(shutdown); await shutdown;
    expect(performance.now() - before).toBeLessThan(1_000);
    expect(f.transport.closed).toBe(true);
    expect(f.push.listDeliveries().map((d) => d.state)).toEqual(["unknown", "queued"]);
    result.resolve(response()); await tick; await f.worker.tick(); await f.worker.wake(); f.worker.start();
    expect(f.push.listDeliveries().map((d) => d.state)).toEqual(["unknown", "queued"]);
    expect(f.transport.requests).toHaveLength(1); expect(f.push.listDevices()[0].lastAcceptedAt).toBeNull();
  });
  test("graceful shutdown preserves a definite response received before the deadline", async () => {
    const f = fixture({ shutdownTimeoutMs: 200 }); f.enabled(); f.event(); f.event();
    const result = deferred<APNsTransportResult>(); f.transport.handler = () => result.promise;
    const tick = f.worker.tick(); await until(() => f.transport.requests.length === 1);
    const stopped = f.worker.shutdown(); result.resolve(response()); await stopped; await tick;
    expect(f.push.listDeliveries().map((d) => d.state)).toEqual(["accepted", "queued"]);
    expect(f.transport.closed).toBe(true);
  });
  test("shutdown storage failure closes every stream, rejects honestly, and leaves no late DB writes", async () => {
    const f = fixture({ shutdownTimeoutMs: 5 }); f.enabled(); f.enabled("cd", "production"); f.event();
    const result = deferred<APNsTransportResult>(); f.transport.handler = () => result.promise;
    const tick = f.worker.tick(); await until(() => f.transport.requests.length === 2);
    f.db.exec("CREATE TEMP TRIGGER fail_shutdown BEFORE UPDATE ON push_deliveries WHEN NEW.state='unknown' BEGIN SELECT RAISE(ABORT,'disk full'); END");
    await expect(f.worker.shutdown()).rejects.toThrow("disk full");
    // afterEach should not rethrow the intentionally observed shutdown failure.
    cleanups.pop();
    await tick; expect(f.transport.closed).toBe(true);
    expect(f.push.listDeliveries().map((d) => d.state)).toEqual(["sending", "sending"]);
    f.db.exec("DROP TRIGGER fail_shutdown"); result.resolve(response()); await Bun.sleep(1);
    expect(f.push.listDeliveries().map((d) => d.state)).toEqual(["sending", "sending"]);
    f.advance(30_000);
    const recovery = new PushWorker(f.push, f.client, { now: f.now }); cleanups.push(() => recovery.shutdown());
    await recovery.tick(); expect(f.push.listDeliveries().every((d) => d.state === "unknown")).toBe(true);
  });
  test("start is idempotent, wakes immediately, and closes without ever starting a real connection", async () => {
    const f = fixture(); f.enabled(); f.event(); f.worker.start(); f.worker.start();
    await until(() => f.delivery().state === "accepted");
    expect(f.transport.requests).toHaveLength(1); await f.worker.shutdown();
  });
});
