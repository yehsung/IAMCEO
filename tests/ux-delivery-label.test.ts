import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Bus } from "../server/bus.ts";
import { ensureErrorCodeColumns, MIGRATIONS, openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import type { Message, WsEvent } from "../shared/types.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = openDb(":memory:");
  databases.push(db);
  const bus = new Bus(), store = new Store(db, bus);
  const project = store.createProject({ name: "전달 표시 시험", cwd: "/fixture", runnerEnabled: false });
  const events: WsEvent[] = [];
  bus.subscribe(event => events.push(event));
  const message = store.createMessage({ id: "45A3D2AD-fixture", projectId: project.id, mine: true,
    kind: "지시", body: "시험", delivery: "queued" });
  return { db, bus, store, project, message, events };
}

describe("message delivery snapshot revisions", () => {
  test("an early delivered event has a newer revision than the delayed queued POST snapshot", () => {
    const { store, project, message: postResponse, events } = fixture();
    const delivered = store.setMessageDelivery(postResponse.id, "delivered");
    const event = events.filter((event): event is Extract<WsEvent, { type: "message" }> => event.type === "message").at(-1)!;
    expect(postResponse).toMatchObject({ delivery: "queued", deliveryRevision: 0 });
    expect(event.message).toEqual(delivered);
    expect(delivered).toMatchObject({ delivery: "delivered", deliveryRevision: 1 });
    const reads: Message[] = [store.requireMessage(delivered.id), store.listMessages(project.id)[0]!,
      store.listMessagePage(project.id).items[0]!, store.listMessagesAround(project.id, delivered.id)[0]!,
      store.projectState(project.id).messages[0]!,
      store.createMessage({ id: delivered.id, projectId: project.id, kind: "지시", delivery: "queued" })];
    for (const read of reads) expect(read).toMatchObject({ delivery: "delivered", deliveryRevision: 1 });
    expect(postResponse.delivery).toBe("queued"); // The response really is an older immutable snapshot.
  });

  test("failed → queued → delivered on the same ID has increasing revisions, including after Store reconstruction", () => {
    const { db, store, message } = fixture();
    expect(store.setMessageDelivery(message.id, "failed", "거부")).toMatchObject({ delivery: "failed", deliveryRevision: 1 });
    const restarted = new Store(db, new Bus());
    expect(restarted.setMessageDelivery(message.id, "queued")).toMatchObject({ delivery: "queued", deliveryNote: null, deliveryRevision: 2 });
    expect(restarted.setMessageDelivery(message.id, "delivered")).toMatchObject({ delivery: "delivered", deliveryRevision: 3 });
    expect(restarted.setMessageDelivery(message.id, "delivered").deliveryRevision).toBe(3);
    expect(restarted.listMessages(message.projectId)).toHaveLength(1);
  });

  test.each([
    ["queued", null], ["failed", "거부"], ["delivered", null], [null, null],
  ] as const)("rewriting identical delivery %s / %s preserves the row and revision without broadcasts, including after Store reconstruction", (delivery, note) => {
    const { db, bus, store, message, events } = fixture();
    const current = store.setMessageDelivery(message.id, delivery, note);
    for (const writer of [store, new Store(db, bus)]) {
      events.length = 0;
      const row = db.query("SELECT * FROM messages WHERE id = ?").get(message.id);
      const changes = db.query("SELECT total_changes() AS count").get();
      expect(writer.setMessageDelivery(message.id, delivery, note)).toEqual(current);
      expect(writer.requireMessage(message.id)).toEqual(current);
      expect(db.query("SELECT * FROM messages WHERE id = ?").get(message.id)).toEqual(row);
      expect(db.query("SELECT total_changes() AS count").get()).toEqual(changes);
      expect(events).toEqual([]);
    }
  });

  test("changing only the delivery note increments the revision and broadcasts the new snapshot", () => {
    const { store, message, events } = fixture();
    store.setMessageDelivery(message.id, "failed", "거부");
    let revision = 1;
    for (const note of ["다른 사유", "", null]) {
      events.length = 0;
      const updated = store.setMessageDelivery(message.id, "failed", note);
      expect(updated).toMatchObject({ delivery: "failed", deliveryNote: note, deliveryRevision: ++revision });
      expect(store.requireMessage(message.id)).toEqual(updated);
      expect(events.filter(event => event.type === "message")).toEqual([{ type: "message", message: updated }]);
    }
  });

  test("rollback discards the delivery state, revision and broadcast together", () => {
    const { store, message, events } = fixture();
    events.length = 0;
    expect(() => store.transaction(() => {
      expect(store.setMessageDelivery(message.id, "delivered").deliveryRevision).toBe(1);
      expect(events).toEqual([]);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(events).toEqual([]);
    expect(store.requireMessage(message.id)).toMatchObject({ delivery: "queued", deliveryRevision: 0 });
    expect(store.setMessageDelivery(message.id, "failed").deliveryRevision).toBe(1);
  });

  test("migration gives historical messages revision zero without changing their delivery or body", () => {
    const migration = MIGRATIONS.findIndex(sql => sql.includes("ADD COLUMN delivery_revision"));
    expect(migration).toBeGreaterThan(0);
    const db = new Database(":memory:");
    databases.push(db);
    for (const sql of MIGRATIONS.slice(0, migration)) db.exec(sql);
    // 판 번호 없이 더하는 열(오류·보류 코드). 실제로는 openDb 가 이주 뒤에 더하지만, 이 시험은 이주 도중의 DB 에 지금 Store 를 쓴다.
    ensureErrorCodeColumns(db);
    const store = new Store(db, new Bus());
    const project = store.createProject({ name: "이전 판", cwd: "/fixture", runnerEnabled: false });
    db.query("INSERT INTO messages (id, project_id, at, kind, body, delivery, delivery_note) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("legacy", project.id, "2026-11-09T07:17:33Z", "지시", "원문", "failed", "기존 사유");
    db.transaction(() => { db.exec(MIGRATIONS[migration]!); })();
    expect(store.requireMessage("legacy")).toMatchObject({ body: "원문", delivery: "failed", deliveryNote: "기존 사유", deliveryRevision: 0 });
    expect(store.setMessageDelivery("legacy", "queued")).toMatchObject({ body: "원문", delivery: "queued", deliveryRevision: 1 });
  });
});
