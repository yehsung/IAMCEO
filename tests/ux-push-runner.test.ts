import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { buildAPNsPayload } from "../server/push/apns.ts";
import type { APNsNotification } from "../server/push/apns.ts";
import { DEFAULT_PUSH_PREFERENCES as SERVER_DEFAULTS, PUSH_KINDS as SERVER_KINDS } from "../server/push/contracts.ts";
import { PushEventRecorder } from "../server/push/events.ts";
import { createPushHandler } from "../server/push/routes.ts";
import { PushStore } from "../server/push/store.ts";
import { PushWorker } from "../server/push/worker.ts";
import { DEFAULT_PUSH_BUNDLE_ID, DEFAULT_PUSH_PREFERENCES, PUSH_KINDS } from "../shared/push.ts";
import type { PushDevice, PushEventTargetResult, PushPayload, PushTarget } from "../shared/push.ts";

const connections: Database[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
function fixture() {
  const db = openDb(":memory:"); connections.push(db);
  const bus = new Bus();
  const options = { providers: () => [{ environment: "sandbox" as const, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready" as const, lastError: null }] };
  let push = new PushStore(db, options);
  let store = new Store(db, bus, new PushEventRecorder(push));
  const project = store.createProject({ name: "PROJECT-SECRET-CANARY", cwd: "/fixture", runnerEnabled: false });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "worker", kind: "worker" });
  const registration = { expectedRevision: null, platform: "ios" as const, bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox" as const, deviceToken: "ab", authorization: "authorized" as const };
  const device = push.registerDevice(randomUUID(), registration);
  push.patchDevice(device.id, { expectedRevision: device.revision, enabled: true });
  return { db, bus, project, member, device, registration, options, get push() { return push; }, get store() { return store; },
    restart() { push = new PushStore(db, options); store = new Store(db, bus, new PushEventRecorder(push)); } };
}

test("shared push contract owns all six kinds, defaults and project home targets", () => {
  const f = fixture();
  expect(SERVER_KINDS).toBe(PUSH_KINDS);
  expect(SERVER_DEFAULTS).toBe(DEFAULT_PUSH_PREFERENCES);
  expect(PUSH_KINDS).toEqual(["decision", "approval_wait", "error", "report_complete", "todo_created", "report_blocked"]);
  const device: PushDevice = f.push.requireDevice(f.device.id);
  expect(Object.keys(device.preferences).sort()).toEqual([...PUSH_KINDS].sort());
  f.store.createTodo({ projectId: f.project.id, title: "할 일" }); f.push.recordTodoChanges();
  const event = f.push.listEvents()[0];
  const target: PushTarget = { screen: "home", projectId: f.project.id };
  const result: PushEventTargetResult = f.push.eventTarget(event.id);
  expect(result.target).toEqual(target);
  const payload: PushPayload = buildAPNsPayload({ environment: "sandbox", deviceToken: "ab", deliveryId: randomUUID(),
    eventId: event.id, serverId: f.push.serverId, kind: "todo_created", target, occurredAt: event.occurredAt, expiresAt: event.expiresAt });
  expect(payload.iamceo).toMatchObject({ kind: "todo_created", target });
});

test("selection waits notify once across ticks/restart and recur only after resolution", () => {
  const f = fixture();
  f.store.patchMember(f.member.id, { status: "blocked", blockedReason: "selection" });
  f.store.patchMember(f.member.id, { contextPct: 10 }); f.restart();
  f.store.patchMember(f.member.id, { status: "blocked", blockedReason: "permission" });
  expect(f.push.listEvents().map(e => e.kind)).toEqual(["approval_wait"]);
  expect(f.push.listDeliveries()).toHaveLength(1);
  expect(f.push.listEvents()[0].target).toEqual({ screen: "team", projectId: f.project.id, memberId: f.member.id });
  f.store.patchMember(f.member.id, { status: "idle", blockedReason: null });
  f.store.patchMember(f.member.id, { status: "blocked", blockedReason: "selection" });
  expect(f.push.getEpisode(f.member.id)?.blockedGeneration).toBe(2);
  expect(f.push.listDeliveries().map(d => d.state)).toEqual(["cancelled", "queued"]);
});

test("new defaults are opt-in overall; missing legacy keys stay OFF through PATCH, renewal and restart", async () => {
  const f = fixture();
  expect(f.device.enabled).toBe(false);
  expect(f.device.preferences).toEqual(DEFAULT_PUSH_PREFERENCES);
  const legacy = { decision: true, approval_wait: false, error: false, report_complete: true };
  f.db.query("UPDATE push_devices SET preferences=? WHERE id=?").run(JSON.stringify(legacy), f.device.id);
  f.restart();
  expect(f.push.requireDevice(f.device.id).preferences).toEqual({ ...legacy, todo_created: false, report_blocked: false });
  const handler = createPushHandler({ store: f.push, providers: f.options.providers });
  const patch = async (preferences: object) => {
    const url = new URL(`http://localhost/api/push/devices/${f.device.id}`);
    return handler(new Request(url, { method: "PATCH", body: JSON.stringify({ expectedRevision: f.push.requireDevice(f.device.id).revision, preferences }) }), url);
  };
  expect((await patch({ todo_created: true, report_blocked: true })).status).toBe(200);
  expect((await patch({ error: true })).status).toBe(200);
  expect(f.push.requireDevice(f.device.id).preferences).toEqual({ ...legacy, error: true, todo_created: true, report_blocked: true });
  expect((await patch({ unknown: true })).status).toBe(400);
  const renewed = f.push.registerDevice(f.device.id, { ...f.registration, expectedRevision: f.push.requireDevice(f.device.id).revision });
  f.restart();
  expect(f.push.requireDevice(f.device.id).preferences).toEqual(renewed.preferences);
});

test("blocked reports use the message recorder exactly once and roll back with the domain", () => {
  const f = fixture();
  expect(() => f.store.transaction(() => {
    f.store.createMessage({ id: "rolled-back", projectId: f.project.id, memberId: f.member.id, kind: "막힘" });
    throw new Error("rollback");
  })).toThrow("rollback");
  expect(f.push.listEvents()).toEqual([]);
  const message = f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "막힘", body: "BODY-SECRET-CANARY" });
  f.store.transaction(() => new PushEventRecorder(f.push).message(message));
  f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "진행" });
  f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "막힘", mine: true });
  expect(f.push.listEvents().map(e => e.kind)).toEqual(["report_blocked"]);
  expect(f.push.listDeliveries()).toHaveLength(1);
  f.restart();
  f.store.transaction(() => new PushEventRecorder(f.push).message(message));
  expect(f.push.listEvents()).toHaveLength(1);
  f.db.query("DELETE FROM messages WHERE id=?").run(message.id);
  f.push.cancelInvalidPending();
  expect(f.push.listDeliveries()[0].state).toBe("cancelled");
});

test("committed todo changes wake the existing worker, remain unique on restart and cancel after completion", async () => {
  const f = fixture();
  const sent: APNsNotification[] = [];
  let worker = new PushWorker(f.push, { status: f.options.providers, close() {}, async send(n) { sent.push(n); return { state: "accepted", reason: "accepted" }; } });
  const unsubscribe = f.bus.subscribe(() => { void worker.wake(); });
  try {
    const todo = f.store.createTodo({ projectId: f.project.id, title: "TODO-SECRET-CANARY" });
    await worker.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "todo_created", target: { screen: "home", projectId: f.project.id } });
    expect(f.push.eventTarget(sent[0].eventId).target).toEqual({ screen: "home", projectId: f.project.id });
    await worker.shutdown(); f.restart();
    worker = new PushWorker(f.push, { status: f.options.providers, close() {}, async send(n) { sent.push(n); return { state: "accepted", reason: "accepted" }; } });
    f.store.setTodoDone(todo.id, true); f.store.setTodoDone(todo.id, false);
    await worker.tick(); expect(sent).toHaveLength(1);
    unsubscribe();
    const done = f.store.createTodo({ projectId: f.project.id, title: "done before scan" });
    f.store.setTodoDone(done.id, true);
    f.push.recordTodoChanges();
    expect(f.push.listEvents()).toHaveLength(1);
    const pending = f.store.createTodo({ projectId: f.project.id, title: "pending" });
    f.push.recordTodoChanges(); f.store.setTodoDone(pending.id, true); f.push.cancelInvalidPending();
    expect(f.push.listDeliveries().map(d => d.state)).toEqual(["accepted", "cancelled"]);
  } finally { unsubscribe(); await worker.shutdown(); }
});

test("todo observation and outbox are atomic, survive an unscanned restart and do not backfill opt-outs", () => {
  const f = fixture();
  const pending = f.store.createTodo({ projectId: f.project.id, title: "pending" }); f.restart();
  f.db.exec("CREATE TEMP TRIGGER reject_push BEFORE INSERT ON push_events BEGIN SELECT RAISE(ABORT,'outbox failure'); END");
  expect(() => f.push.recordTodoChanges()).toThrow("outbox failure");
  expect(f.db.query("SELECT 1 FROM push_todo_observations WHERE todo_id=?").get(pending.id)).toBeNull();
  f.db.exec("DROP TRIGGER reject_push");
  const device = f.push.requireDevice(f.device.id);
  const off = f.push.patchDevice(device.id, { expectedRevision: device.revision, preferences: { todo_created: false } });
  f.push.recordTodoChanges();
  f.push.patchDevice(device.id, { expectedRevision: off.revision, preferences: { todo_created: true } });
  f.push.recordTodoChanges();
  expect(f.push.listEvents()).toHaveLength(1); expect(f.push.listDeliveries()).toEqual([]);
  const next = f.store.createTodo({ projectId: f.project.id, title: "new" });
  f.push.recordTodoChanges();
  expect(f.push.eventBySource(`todo:${next.id}`)).not.toBeNull();
  expect(f.push.listDeliveries()).toHaveLength(1);
});

test("both new kinds transmit only fixed text and IDs, including the project home hint", () => {
  const f = fixture();
  const message = f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "막힘", body: "BODY-SECRET-CANARY" });
  f.store.createTodo({ projectId: f.project.id, title: "TODO-SECRET-CANARY" }); f.push.recordTodoChanges();
  for (const event of f.push.listEvents()) {
    const targetWithExtra = { ...event.target, secret: "EXTRA-SECRET-CANARY" };
    const payload = buildAPNsPayload({ environment: "sandbox", deviceToken: "ab", deliveryId: randomUUID(), eventId: event.id,
      serverId: f.push.serverId, kind: event.kind, target: targetWithExtra,
      occurredAt: event.occurredAt, expiresAt: event.expiresAt });
    expect(payload.aps.alert.body).toBe(event.kind === "todo_created" ? "대표 할 일이 생겼습니다." : "막힘 보고를 확인해 주세요.");
    expect(JSON.stringify(payload)).not.toContain("SECRET-CANARY");
    expect(payload.iamceo.target).toEqual(event.target);
  }
  expect(f.push.listEvents()[0].target).toMatchObject({ messageId: message.id });
});

test("push schema upgrade preserves all delivery fences and group links atomically; old todos are a silent baseline", () => {
  const db = openDb(":memory:"); connections.push(db);
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "legacy", cwd: "/fixture", runnerEnabled: false });
  const member = store.createMember({ projectId: project.id, name: "legacy", handle: "legacy", kind: "worker" });
  store.createTodo({ projectId: project.id, title: "old todo" });
  const message = store.createMessage({ projectId: project.id, memberId: member.id, kind: "완료" });
  const at = new Date().toISOString(); const closesAt = new Date(Date.parse(at) + 120_000).toISOString();
  const deviceId = randomUUID(), eventId = randomUUID(), groupId = randomUUID();
  db.query("INSERT INTO push_devices(id,label,platform,bundle_id,environment,token,authorization,enabled,state,registered_at,last_seen_at,expires_at) VALUES(?,'legacy','ios',?,'sandbox','ab','authorized',1,'active',?,?,?)")
    .run(deviceId, DEFAULT_PUSH_BUNDLE_ID, at, at, new Date(Date.now() + 86_400_000).toISOString());
  db.query("INSERT INTO push_events VALUES(?,?,'report_complete',?,?,?,?,?)").run(eventId, "legacy-event", project.id, member.id,
    JSON.stringify({ screen: "chat", projectId: project.id, memberId: member.id, messageId: message.id, groupId }), at, closesAt);
  // One source may have multiple recipient histories; each state belongs to its own device.
  for (const [i, state] of ["queued", "sending", "accepted", "unknown"].entries()) {
    const id = i === 0 ? deviceId : randomUUID();
    if (i) db.query("INSERT INTO push_devices(id,label,platform,bundle_id,environment,authorization,state,registered_at,last_seen_at,expires_at) VALUES(?,'legacy','ios',?,'sandbox','authorized','active',?,?,?)")
      .run(id, DEFAULT_PUSH_BUNDLE_ID, at, at, closesAt);
    db.query("INSERT INTO push_deliveries(id,event_id,device_id,registration_generation,state,attempts,next_attempt_at,expires_at,lease_until) VALUES(?,?,?,1,?,1,?,?,?)")
      .run(randomUUID(), eventId, id, state, at, closesAt, state === "sending" ? closesAt : null);
  }
  db.query("INSERT INTO push_report_groups(id,project_id,member_id,opened_at,closes_at,last_message_id,event_id) VALUES(?,?,?,?,?,?,?)")
    .run(groupId, project.id, member.id, at, closesAt, message.id, eventId);
  db.query("INSERT INTO push_report_group_reports VALUES(?,?,0)").run(groupId, message.id);
  db.query("INSERT INTO push_report_group_recipients(group_id,device_id,registration_generation) VALUES(?,?,1)").run(groupId, deviceId);
  const deliveries = db.query("SELECT * FROM push_deliveries ORDER BY id").all();
  const groups = db.query("SELECT * FROM push_report_groups").all();
  db.exec("CREATE TEMP TRIGGER reject_restore BEFORE INSERT ON push_deliveries BEGIN SELECT RAISE(ABORT,'restore failure'); END");
  expect(() => new PushStore(db)).toThrow("restore failure");
  expect(db.query("SELECT * FROM push_deliveries ORDER BY id").all()).toEqual(deliveries);
  expect(db.query("SELECT * FROM push_report_groups").all()).toEqual(groups);
  expect(db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='push_events'").get()!.sql).not.toContain("todo_created");
  db.exec("DROP TRIGGER reject_restore");
  const push = new PushStore(db);
  expect(db.query("SELECT * FROM push_deliveries ORDER BY id").all()).toEqual(deliveries);
  expect(db.query("SELECT * FROM push_report_groups").all()).toEqual(groups);
  expect(push.getReportGroup(groupId)?.reportIds).toEqual([message.id]);
  expect(push.getReportGroup(groupId)?.recipients).toHaveLength(1);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name='push_events_expiry'").get()).not.toBeNull();
  push.recordTodoChanges();
  expect(push.listEvents()).toHaveLength(1);
  expect(push.requireDevice(deviceId).preferences).toMatchObject({ todo_created: false, report_blocked: false });
  const again = new PushStore(db);
  expect(again.serverId).toBe(push.serverId);
  expect(again.listDeliveries().map(d => d.state)).toEqual(["queued", "sending", "accepted", "unknown"]);
  // Upgrade of a window opened by the old server keeps its original trailing event.
  again.closeDueGroups(closesAt);
  expect(again.listEvents()).toHaveLength(2);
  expect(again.getReportGroup(groupId)?.state).toBe("closed");
  again.closeDueGroups(closesAt);
  expect(again.listEvents()).toHaveLength(2);
});
