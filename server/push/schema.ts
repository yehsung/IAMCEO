import type { Database } from "bun:sqlite";

/** Run inside PushStore's transaction. Only push-owned tables are changed. */
export function extendPushSchema(db: Database): void {
  if (!db.inTransaction) throw new Error("Push schema extension requires a transaction");
  widenPushEventKinds(db, "'todo_created'", "'report_complete','test'", "'report_complete','test','todo_created','report_blocked'");
  // 0.2.7(D4-3): tailnet_off(서버 Mac 의 Tailscale 꺼짐을 iPhone 에도). 같은 방식으로 종류 목록만 넓힌다(판 번호 없음).
  // 이전 판 서버는 이 종류를 만들지 않고, 남아 있는 그런 사건은 지금 사건이 아니라 보내지 않고 거둔다(isEventCurrent).
  widenPushEventKinds(db, "'tailnet_off'", "'todo_created','report_blocked'", "'todo_created','report_blocked','tailnet_off'");
  // 0.2.11: cli_update(서버 Mac 의 AI 도구 새 판, 판마다 한 번). 같은 방식(판 번호 없음). 이전 판 서버는 모르는 종류를 지금 사건으로 보지 않아 보내지 않는다.
  widenPushEventKinds(db, "'cli_update'", "'todo_created','report_blocked','tailnet_off'", "'todo_created','report_blocked','tailnet_off','cli_update'");
  // 0.2.6 Y: 그 iPhone 이 알림을 받을 언어(ko|en). 등록·설정 바꾸기 요청의 Accept-Language 로 정한다. 없으면(NULL, 옛 앱·옛 행) 한국어.
  // 열만 더한다(판 번호 없음). 이전 판 서버는 이 열을 모른 채 지나간다.
  if (!db.query<{ name: string }, []>("PRAGMA table_info(push_devices)").all().some(c => c.name === "language")) db.exec("ALTER TABLE push_devices ADD COLUMN language TEXT");
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_todo_observations'").get()) {
    db.exec("CREATE TABLE push_todo_observations (todo_id TEXT PRIMARY KEY REFERENCES todos(id) ON DELETE CASCADE)");
    // One-time installation baseline: existing work must not produce old alerts.
    db.exec("INSERT INTO push_todo_observations SELECT id FROM todos");
  }
}

/**
 * push_events.kind 의 CHECK 목록에 종류를 더한다(SQLite 는 CHECK 를 바꿀 수 없어 표를 다시 만든다). 이미 들어 있으면(marker) 아무것도 하지 않는다.
 * 옛 부모 표를 지우면 전달이 함께 지워지고 묶음의 사건 ID 가 비므로, 같은 트랜잭션에서 둘 다 보관했다가 되살린다(보내는 중·결과 모름 표시까지).
 */
function widenPushEventKinds(db: Database, marker: string, from: string, to: string): void {
  const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='push_events'").get()!.sql;
  if (sql.includes(marker)) return;
  // 한 번 다시 만든 표는 이름이 따옴표로 저장된다(CREATE TABLE "push_events", 라이브 DB 도 그렇다).
  const expanded = sql.replace(/CREATE TABLE\s+"?push_events"?(?=\s*\()/i, "CREATE TABLE push_events_next").replace(from, to);
  if (expanded === sql || !expanded.includes(marker)) throw new Error("Unsupported push event schema");
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
