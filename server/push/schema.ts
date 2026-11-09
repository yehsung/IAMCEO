import type { Database } from "bun:sqlite";

/** Run inside PushStore's transaction. Only push-owned tables are changed. */
export function extendPushSchema(db: Database): void {
  if (!db.inTransaction) throw new Error("Push schema extension requires a transaction");
  const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='push_events'").get()!.sql;
  if (!sql.includes("'todo_created'")) {
    const expanded = sql.replace(/CREATE TABLE\s+push_events/i, "CREATE TABLE push_events_next")
      .replace("'report_complete','test'", "'report_complete','test','todo_created','report_blocked'");
    if (expanded === sql || !expanded.includes("'todo_created'")) throw new Error("Unsupported push event schema");
    const indexes = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='push_events' AND sql IS NOT NULL").all();
    // DROP of the old parent cascades deliveries and clears group event IDs. Save
    // and restore both within this transaction, including sending/unknown fences.
    db.exec("CREATE TEMP TABLE push_delivery_backup AS SELECT * FROM push_deliveries");
    db.exec("CREATE TEMP TABLE push_group_event_backup AS SELECT id,event_id FROM push_report_groups WHERE event_id IS NOT NULL");
    db.exec(expanded);
    db.exec("INSERT INTO push_events_next SELECT * FROM push_events");
    db.exec("DROP TABLE push_events");
    db.exec("ALTER TABLE push_events_next RENAME TO push_events");
    for (const index of indexes) db.exec(index.sql);
    db.exec("INSERT INTO push_deliveries SELECT * FROM push_delivery_backup");
    db.exec("UPDATE push_report_groups SET event_id=(SELECT event_id FROM push_group_event_backup b WHERE b.id=push_report_groups.id) WHERE id IN (SELECT id FROM push_group_event_backup)");
    db.exec("DROP TABLE push_delivery_backup");
    db.exec("DROP TABLE push_group_event_backup");
  }
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_todo_observations'").get()) {
    db.exec("CREATE TABLE push_todo_observations (todo_id TEXT PRIMARY KEY REFERENCES todos(id) ON DELETE CASCADE)");
    // One-time installation baseline: existing work must not produce old alerts.
    db.exec("INSERT INTO push_todo_observations SELECT id FROM todos");
  }
}
