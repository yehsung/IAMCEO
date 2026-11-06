import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { PushStore } from "../server/push/store.ts";
import type { PushStoreOptions } from "../server/push/store.ts";
import { ApiError } from "../server/store.ts";
import { DEFAULT_PUSH_BUNDLE_ID, DEFAULT_PUSH_PREFERENCES } from "../shared/push.ts";
import type { PushEnvironment, RegisterPushDeviceRequest } from "../shared/push.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import type { IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const connections: Database[] = [];
const runtimes: IsolatedRuntime[] = [];
const start = Date.parse("2026-11-07T00:00:00.123Z");
const DAY = 86_400_000;
afterEach(async () => {
  for (const db of connections.splice(0)) db.close();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});
function fixture(options: PushStoreOptions = {}) {
  const db = openDb(":memory:"); connections.push(db);
  let now = start;
  const configuration = { now: () => now, providers: () => (["sandbox", "production"] as const).map((environment) => ({ environment,
    bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready" as const, lastError: null })), ...options };
  const push = new PushStore(db, configuration);
  return { db, push, options: configuration, advance: (ms: number) => { now += ms; } };
}
function request(token = "ab", environment: PushEnvironment = "sandbox", expectedRevision: number | null = null): RegisterPushDeviceRequest {
  return { expectedRevision, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment, deviceToken: token, authorization: "authorized" };
}
function enabled(push: PushStore, token = "ab") {
  const created = push.registerDevice(randomUUID(), request(token));
  return push.patchDevice(created.id, { expectedRevision: created.revision, enabled: true });
}
function status(fn: () => unknown, code: number) {
  try { fn(); } catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).status).toBe(code); return; }
  throw new Error(`Expected ${code}`);
}
function testEvent(push: PushStore, key: string = randomUUID()) {
  return push.recordEvent({ sourceKey: `test:${key}`, kind: "test", projectId: null, memberId: null, target: { screen: "home" }, occurredAt: push.timestamp() });
}

describe("PushStore registration", () => {
  test("new device is disabled with all four defaults; DTOs never expose the token/generation", () => {
    const { push } = fixture();
    const device = push.registerDevice(randomUUID(), request("ABCD"));
    expect(device).toMatchObject({ enabled: false, revision: 1, state: "active", preferences: DEFAULT_PUSH_PREFERENCES });
    expect(Date.parse(device.expiresAt) - start).toBe(30 * DAY);
    expect(push.getRegistration(device.id)).toMatchObject({ deviceToken: "abcd", registrationGeneration: 1 });
    expect(JSON.stringify(push.listDevices())).not.toContain("abcd");
    expect(Object.keys(device)).not.toContain("registrationGeneration");
    expect(testEvent(push).id).toMatch(/^[0-9a-f-]{36}$/);
    expect(push.listDeliveries()).toEqual([]);
  });
  test("variable even hex lengths are accepted; malformed registration cannot change state", () => {
    const { push } = fixture();
    for (const length of [2, 4, 64, 128, 1024]) expect(push.registerDevice(randomUUID(), request("ab".repeat(length / 2))).revision).toBe(1);
    for (const token of ["", "a", "abc", "zz", "ab ", "ab".repeat(513)]) status(() => push.registerDevice(randomUUID(), request(token)), 400);
    status(() => push.registerDevice("bad", request()), 400);
    status(() => push.registerDevice(randomUUID(), { ...request(), bundleId: "other.app" }), 400);
    status(() => push.registerDevice(randomUUID(), { ...request(), label: "\nsecret" }), 400);
  });
  test("two iPhones fan out once; idempotent source does not backfill later devices", () => {
    const { push } = fixture();
    enabled(push, "aa"); enabled(push, "bb");
    const saved = testEvent(push, "one");
    expect(push.listDeliveries(saved.id)).toHaveLength(2);
    enabled(push, "cc");
    expect(testEvent(push, "one").id).toBe(saved.id);
    expect(push.listDeliveries(saved.id)).toHaveLength(2);
  });
  test("registration preserves OFF/preferences; revision compare is atomic", () => {
    const { push } = fixture();
    const created = push.registerDevice(randomUUID(), request());
    const patched = push.patchDevice(created.id, { expectedRevision: 1, preferences: { error: false } });
    status(() => push.patchDevice(created.id, { expectedRevision: 1, enabled: true }), 409);
    status(() => push.registerDevice(created.id, request()), 409);
    const renewed = push.registerDevice(created.id, request("cd", "sandbox", patched.revision));
    expect(renewed.enabled).toBe(false);
    expect(renewed.preferences).toEqual({ ...DEFAULT_PUSH_PREFERENCES, error: false });
    status(() => push.registerDevice(randomUUID(), request("aa", "sandbox", 1)), 404);
  });
  test("same environment renewal retargets pending work but leaves in-flight history alone", () => {
    const { push, db, advance } = fixture();
    const current = enabled(push);
    testEvent(push, "queued"); testEvent(push, "sending"); testEvent(push, "unknown");
    const deliveries = push.listDeliveries();
    db.query("UPDATE push_deliveries SET state='sending' WHERE id=?").run(deliveries[1].id);
    db.query("UPDATE push_deliveries SET state='unknown' WHERE id=?").run(deliveries[2].id);
    advance(1_000);
    const renewed = push.registerDevice(current.id, request("cd", "sandbox", current.revision));
    expect(renewed.enabled).toBe(true);
    expect(push.listDeliveries().map((d) => d.registrationGeneration)).toEqual([2, 1, 1]);
    expect(push.invalidateDevice(current.id, 1)).toBe(false);
    expect(push.invalidateDevice(current.id, 2, start)).toBe(false);
    expect(push.getDevice(current.id)?.state).toBe("active");
    expect(push.invalidateDevice(current.id, 2, start + 1_000)).toBe(true);
    expect(push.getRegistration(current.id)).toMatchObject({ deviceToken: null, device: { state: "invalid", enabled: false } });
    expect(push.listDeliveries().map((d) => d.state)).toEqual(["cancelled", "sending", "unknown"]);
  });
  test("token transfer is atomic, does not inherit opt-in, and separates environments", () => {
    const { push } = fixture();
    const old = enabled(push, "ab"); testEvent(push);
    const moved = push.registerDevice(randomUUID(), request("AB"));
    expect(moved.enabled).toBe(false);
    expect(push.getRegistration(old.id)).toMatchObject({ deviceToken: null, device: { state: "revoked", revision: old.revision + 1 } });
    expect(push.listDeliveries()[0].state).toBe("cancelled");
    const production = push.registerDevice(randomUUID(), request("ab", "production"));
    expect(push.getDevice(moved.id)?.state).toBe("active");
    const changed = push.registerDevice(production.id, request("ef", "sandbox", production.revision));
    expect(changed.enabled).toBe(false);
    expect(changed.environment).toBe("sandbox");
  });
  test("storage failure during token transfer restores the original installation and pending work", () => {
    const { push, db } = fixture();
    const current = enabled(push); testEvent(push);
    db.exec("CREATE TEMP TRIGGER refuse_registration BEFORE INSERT ON push_devices BEGIN SELECT RAISE(ABORT,'registration failure'); END");
    expect(() => push.registerDevice(randomUUID(), request("ab"))).toThrow("registration failure");
    expect(push.getRegistration(current.id)).toMatchObject({ deviceToken: "ab", registrationGeneration: 1, device: { state: "active", enabled: true, revision: current.revision } });
    expect(push.listDeliveries()[0].state).toBe("queued");
    expect(push.listDevices()).toHaveLength(1);
  });
  test("topic/environment switch cancels old work; fresh opt-in does not resurrect it", () => {
    const { push } = fixture();
    const old = enabled(push); testEvent(push);
    const updated = push.registerDevice(old.id, request("bb", "production", old.revision));
    expect(updated.enabled).toBe(false);
    push.patchDevice(updated.id, { expectedRevision: updated.revision, enabled: true });
    expect(push.listDeliveries()[0].state).toBe("cancelled");
  });
  test("opt-out, permission revocation and unconfigured providers fail closed", () => {
    const { push } = fixture();
    const current = enabled(push); testEvent(push);
    const disabled = push.patchDevice(current.id, { expectedRevision: current.revision, authorization: "denied" });
    expect(disabled.enabled).toBe(false);
    expect(push.listDeliveries()[0].state).toBe("cancelled");
    status(() => push.patchDevice(current.id, { expectedRevision: disabled.revision, enabled: true }), 409);
    const other = fixture({ providers: () => [] }).push;
    const registered = other.registerDevice(randomUUID(), request());
    status(() => other.patchDevice(registered.id, { expectedRevision: 1, enabled: true }), 409);
    testEvent(other); expect(other.listDeliveries()).toEqual([]);
  });
  test("revocation fences stale PUTs, remains idempotent and retains missing-installation tombstones", () => {
    const { push } = fixture();
    const current = enabled(push);
    push.revokeDevice(current.id, current.revision);
    status(() => push.registerDevice(current.id, request("cc", "sandbox", current.revision)), 409);
    push.revokeDevice(current.id, current.revision);
    expect(push.getDevice(current.id)?.revision).toBe(current.revision + 1);
    const unknown = randomUUID(); push.revokeDevice(unknown, 1);
    status(() => push.registerDevice(unknown, request()), 409);
    const renewed = push.registerDevice(current.id, request("aa", "sandbox", push.requireDevice(current.id).revision));
    expect(renewed).toMatchObject({ enabled: false, state: "active" });
  });
  test("30-day lease expiry and 90-day retention use different clocks", () => {
    const { push, advance } = fixture();
    const current = enabled(push); const saved = testEvent(push);
    advance(300_000); push.sweep();
    expect(push.listDeliveries()[0].state).toBe("expired");
    expect(push.getEvent(saved.id)).not.toBeNull();
    advance(30 * DAY - 300_000); push.sweep();
    expect(push.getRegistration(current.id)).toMatchObject({ deviceToken: null, device: { state: "expired", enabled: false } });
    advance(60 * DAY); push.sweep();
    expect(push.getEvent(saved.id)).toBeNull();
    expect(push.getDevice(current.id)).not.toBeNull();
    advance(30 * DAY); push.sweep(); expect(push.getDevice(current.id)).toBeNull();
  });
  test("no more than 100 installation records can be created", () => {
    const { push } = fixture();
    for (let i = 0; i < 100; i++) push.registerDevice(randomUUID(), request(i.toString(16).padStart(2, "0")));
    status(() => push.registerDevice(randomUUID(), request("ff")), 409);
    expect(push.listDevices()).toHaveLength(100);
  });
});

test("historical schema migrates sequentially with backup; initialization and reopen preserve server ID and domain rows", () => {
  const runtime = createIsolatedRuntime(); runtimes.push(runtime);
  const path = join(runtime.paths.iamceoHome, "push.db");
  const beforePush = MIGRATIONS.findIndex((sql) => sql.includes("CREATE TABLE push_meta"));
  const old = new Database(path, { create: true });
  for (let i = 0; i < beforePush; i++) old.transaction(() => { old.exec(MIGRATIONS[i]); old.exec(`PRAGMA user_version=${i + 1}`); })();
  old.query("INSERT INTO projects(id,name,cwd,runner_enabled,created_at,updated_at) VALUES('p','legacy','/fixture',0,?,?)").run(new Date(start).toISOString(), new Date(start).toISOString());
  old.close();
  const first = openDb(path);
  const id = new PushStore(first).serverId;
  expect(new PushStore(first).serverId).toBe(id);
  expect(first.query("SELECT name FROM projects WHERE id='p'").get()).toEqual({ name: "legacy" });
  first.close();
  const second = openDb(path); connections.push(second);
  expect(new PushStore(second).serverId).toBe(id);
  expect(second.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
  expect(readdirSync(runtime.paths.iamceoHome).filter((name) => name.includes(".pre-v"))).toHaveLength(1);
});


test("independent SQLite connections compare the current revision, preserve identity and deduplicate the same source", () => {
  const runtime = createIsolatedRuntime(); runtimes.push(runtime);
  const path = join(runtime.paths.iamceoHome, "competing.db");
  const a = openDb(path); const b = openDb(path); connections.push(a, b);
  const options: PushStoreOptions = { now: () => start, providers: () => [{ environment: "sandbox", bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready", lastError: null }] };
  const first = new PushStore(a, options); const second = new PushStore(b, options);
  expect(first.serverId).toBe(second.serverId);
  const created = first.registerDevice(randomUUID(), request());
  const staleRevision = second.requireDevice(created.id).revision;
  const changed = first.patchDevice(created.id, { expectedRevision: created.revision, enabled: true });
  status(() => second.patchDevice(created.id, { expectedRevision: staleRevision, enabled: false }), 409);
  const saved = testEvent(first, "same-request");
  expect(testEvent(second, "same-request").id).toBe(saved.id);
  expect(second.listDeliveries()).toHaveLength(1);
  first.revokeDevice(created.id, changed.revision);
  status(() => second.registerDevice(created.id, request("cd", "sandbox", changed.revision)), 409);
  expect(second.getRegistration(created.id)).toMatchObject({ deviceToken: null, device: { state: "revoked", enabled: false } });
  expect(second.invalidateDevice(created.id, 1)).toBe(false);
});

test("nested push rollback preserves its parent and asynchronous transaction callbacks are rejected", () => {
  const { push } = fixture();
  push.transaction(() => {
    testEvent(push, "keep");
    expect(() => push.transaction(() => { testEvent(push, "discard"); throw new Error("savepoint"); })).toThrow("savepoint");
    expect(push.listEvents()).toHaveLength(1);
  });
  expect(push.listEvents().map((e) => e.sourceKey)).toEqual(["test:keep"]);
  expect(() => push.transaction(async () => { testEvent(push, "async"); })).toThrow("synchronous callback");
  expect(push.listEvents()).toHaveLength(1);
});
