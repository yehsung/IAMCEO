import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { Bus } from "../server/bus.ts";
import { ensureErrorCodeColumns, MIGRATIONS, openDb } from "../server/db.ts";
import { DeliveryRecovery } from "../server/delivery-recovery.ts";
import { ApiError, Store } from "../server/store.ts";
import type { UnassignedRecoveryRequest } from "../shared/types.ts";

const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });
function fixture() {
  const db = openDb(":memory:");
  close.push(() => db.close());
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "check", cwd: "/private/tmp/iamceo-unassigned-fixture" });
  const message = store.createMessage({ id: "936ffe9e-cb04-425a-8029-5ecbe3797a90", projectId: project.id,
    mine: true, kind: "나", body: "이거 개발자 이름 원할때 변경 가능한건가?", delivery: "failed" });
  db.query("UPDATE messages SET at = ? WHERE id = ?").run("2026-11-02T06:12:00.000Z", message.id);
  const recovery = new DeliveryRecovery({ store, runner: () => { throw new Error("must not write to runner"); } });
  const request = (action: UnassignedRecoveryRequest["action"]): UnassignedRecoveryRequest => ({ operationId: randomUUID(), expectedVersion: 0, action });
  return { db, store, project, message, recovery, request };
}
function conflict(fn: () => unknown) {
  try { fn(); throw new Error("expected conflict"); }
  catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).status).toBe(409); }
}

test("legacy dismiss removes every attention aggregate, retains original and owner audit, and is durable/idempotent", () => {
  const f = fixture();
  const before = f.recovery.notices(f.project.id);
  expect(before.unassigned.needsOwnerCount).toBe(1);
  expect(before.unassignedItems?.[0]).toMatchObject({ id: `message:${f.message.id}`, messageId: f.message.id,
    createdAt: "2026-11-02T06:12:00.000Z", allowedActions: ["send_to_conductor", "dismiss"], version: 0 });
  const req = f.request("dismiss"), result = f.recovery.recoverUnassignedMessage(f.message.id, req);
  expect(result).toMatchObject({ outcome: "dismissed", deliveryId: null, committedVersion: 1 });
  const restarted = new DeliveryRecovery({ store: f.store, runner: () => null });
  expect(restarted.recoverUnassignedMessage(f.message.id, req)).toEqual(result);
  expect(restarted.recoverUnassignedMessage(f.message.id, f.request("dismiss")).outcome).toBe("dismissed");
  expect(restarted.notices(f.project.id).unassigned).toEqual({ needsOwnerCount: 0, undeliveredCount: 0, unknownCount: 0 });
  expect(restarted.notices(f.project.id).unassignedItems).toEqual([]);
  expect(f.store.projectSummaries().find(p => p.id === f.project.id)?.needsCount).toBe(0);
  expect(f.store.requireMessage(f.message.id)).toMatchObject({ body: f.message.body, delivery: "held", deliveryDisposition: "dismissed", deliveryRevision: 1, targetMemberId: null });
  expect(f.db.query("SELECT delivery FROM messages WHERE id = ?").get(f.message.id)).toEqual({ delivery: "dismissed" });
  expect(f.db.query("SELECT action, actor, member_id FROM unassigned_message_recoveries WHERE operation_id = ?").get(req.operationId)).toEqual({ action: "dismiss", actor: "owner", member_id: null });
  expect(f.db.query<{ created_at: string }, []>("SELECT created_at FROM unassigned_message_recoveries LIMIT 1").get()?.created_at).toMatch(/^\d{4}-/);
  expect(f.store.listDeliveries(f.project.id)).toHaveLength(0);
  conflict(() => restarted.recoverUnassignedMessage(f.message.id, { ...req, action: "send_to_conductor" }));
  conflict(() => restarted.recoverUnassignedMessage(f.message.id, { ...f.request("dismiss"), expectedVersion: 1 }));
});

test("explicit assignment creates exactly one fresh delivery to the current conductor and preserves source", () => {
  const f = fixture();
  const conductor = f.store.createMember({ projectId: f.project.id, handle: "chief", name: "총괄", kind: "conductor" });
  const pumps: string[] = [];
  f.store.setDeliveryWaitContext(() => ({ busy: false, waking: false, used: 0 }), id => pumps.push(id));
  const req = f.request("send_to_conductor"), result = f.recovery.recoverUnassignedMessage(f.message.id, req);
  expect(result.outcome).toBe("send_scheduled");
  expect(f.recovery.recoverUnassignedMessage(f.message.id, req)).toEqual(result);
  expect(f.recovery.recoverUnassignedMessage(f.message.id, f.request("send_to_conductor")).deliveryId).toBe(result.deliveryId);
  expect(f.store.listDeliveries(f.project.id)).toHaveLength(1);
  expect(f.store.requireDelivery(result.deliveryId!)).toMatchObject({ memberId: conductor.id, status: "queued", wake: true,
    kind: "user_message", refId: f.message.id, refType: "message", text: f.message.body });
  expect(f.recovery.sourceRevision(f.store.requireDelivery(result.deliveryId!))).not.toBeNull();
  expect(pumps).toEqual([conductor.id]);
  expect(f.store.requireMessage(f.message.id)).toMatchObject({ body: f.message.body, delivery: "queued", targetMemberId: null });
  const notices = f.recovery.notices(f.project.id);
  expect(notices.unassigned.needsOwnerCount).toBe(0);
  expect(notices.members.find(m => m.memberId === conductor.id)).toMatchObject({ needsOwnerCount: 0, undeliveredCount: 1 });
  expect(f.db.query("SELECT member_id FROM unassigned_message_recoveries LIMIT 1").get()).toEqual({ member_id: conductor.id });
  conflict(() => f.recovery.recoverUnassignedMessage(f.message.id, f.request("dismiss")));
});

test("missing conductor, archived project, stale version and non-owner source refuse without mutation", () => {
  const f = fixture(), req = f.request("send_to_conductor");
  conflict(() => f.recovery.recoverUnassignedMessage(f.message.id, req));
  expect(f.recovery.notices(f.project.id).unassigned.needsOwnerCount).toBe(1);
  conflict(() => f.recovery.recoverUnassignedMessage(f.message.id, { ...f.request("dismiss"), expectedVersion: 1 }));
  const other = f.store.createMessage({ projectId: f.project.id, mine: false, kind: "진행", body: "대표가 쓰지 않은 글", delivery: "failed" });
  conflict(() => f.recovery.recoverUnassignedMessage(other.id, f.request("dismiss")));
  f.store.patchProject(f.project.id, { archived: true });
  conflict(() => f.recovery.recoverUnassignedMessage(f.message.id, req));
  conflict(() => f.recovery.recoverUnassignedMessage(f.message.id, f.request("dismiss")));
  expect(f.store.listDeliveries(f.project.id)).toHaveLength(0);
  expect(f.store.requireMessage(f.message.id).delivery).toBe("failed");
});

test("every needs_owner item, including targeted legacy, duplicate draft and stalled rows, offers cleanup", async () => {
  const f = fixture();
  const member = f.store.createMember({ projectId: f.project.id, handle: "worker", name: "직원", kind: "worker" });
  f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "수신자 있는 옛 실패", targetMemberId: member.id, delivery: "failed" });
  for (const reason of ["log_missing", "duplicate_draft", "future_reason"]) {
    const d = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: reason });
    f.store.updateDeliveryRecovery(d.id, f.store.getDeliveryRecovery(d.id)!.version, { phase: "needs_owner", reason });
  }
  const stalled = f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "stalled" });
  f.db.query("UPDATE deliveries SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", stalled.id);
  f.store.detectDeliveryStalls(Date.now());
  const items = [...f.recovery.memberNotices(member.id).items, ...f.recovery.notices(f.project.id).unassignedItems!];
  expect(items.filter(i => i.phase === "needs_owner").length).toBeGreaterThanOrEqual(5);
  for (const item of items.filter(i => i.phase === "needs_owner")) {
    expect(item.allowedActions.some(a => a === "stop_retry" || a === "dismiss")).toBe(true);
  }
  const item = items.find(i => i.id === stalled.id)!;
  expect(item.reason).toBe("stalled");
  await f.recovery.recover(stalled.id, { operationId: randomUUID(), expectedVersion: item.version, action: "stop_retry" });
  expect(f.recovery.memberNotices(member.id).items.some(i => i.id === stalled.id)).toBe(false);
});

test("migration from live v30 keeps historical messages and adds the durable owner decision boundary", () => {
  // Exercise the real prefix and every migration after live v30 using an isolated memory DB.
  const db = new Database(":memory:"); close.push(() => db.close());
  for (const sql of MIGRATIONS.slice(0, 30)) db.exec(sql);
  db.exec("PRAGMA user_version = 30");
  // 판 번호 없이 더하는 열(오류·보류 코드). 실제로는 openDb 가 이주 뒤에 더하지만, 이 시험은 이주 도중의 DB 에 지금 Store 를 쓴다.
  ensureErrorCodeColumns(db);
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "v30 fixture", cwd: "/private/tmp/iamceo-v30-fixture" });
  const message = store.createMessage({ projectId: project.id, mine: true, kind: "나", body: "v30 원본", delivery: "failed" });
  for (const sql of MIGRATIONS.slice(30)) db.exec(sql);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'unassigned_message_recoveries'").get()).not.toBeNull();
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.requireMessage(message.id)).toMatchObject({ body: "v30 원본", delivery: "failed" });
  expect(MIGRATIONS.length).toBeGreaterThan(30);
});

test("audit insertion failure rolls back source and delivery together; operation IDs cannot cross messages", () => {
  const f = fixture();
  f.db.exec("CREATE TRIGGER deny_unassigned BEFORE INSERT ON unassigned_message_recoveries BEGIN SELECT RAISE(ABORT, 'audit refused'); END");
  expect(() => f.recovery.recoverUnassignedMessage(f.message.id, f.request("dismiss"))).toThrow("audit refused");
  expect(f.store.requireMessage(f.message.id)).toMatchObject({ delivery: "failed", deliveryRevision: 0 });
  expect(f.recovery.notices(f.project.id).unassigned.needsOwnerCount).toBe(1);
  f.db.exec("DROP TRIGGER deny_unassigned");
  const request = f.request("dismiss");
  f.recovery.recoverUnassignedMessage(f.message.id, request);
  const other = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "another", delivery: "failed" });
  conflict(() => f.recovery.recoverUnassignedMessage(other.id, request));
  expect(f.store.requireMessage(other.id).delivery).toBe("failed");
});
