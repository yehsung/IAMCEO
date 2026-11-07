import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { DEFAULT_PUSH_PREFERENCES, PUSH_REPORT_GROUP_WINDOW_MS } from "../shared/push.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import type { IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const at = "2026-11-07T00:00:00.123Z";
const afterWindow = MIGRATIONS.findIndex((sql) => sql.includes("ADD COLUMN context_window INTEGER")) + 1;
const runtimes: IsolatedRuntime[] = [];
const connections: Database[] = [];

afterEach(async () => {
  for (const db of connections.splice(0).reverse()) db.close();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

function fixture(name = "iamceo.db") {
  const runtime = createIsolatedRuntime();
  runtimes.push(runtime);
  return { runtime, path: join(runtime.paths.iamceoHome, name) };
}

function track(db: Database): Database {
  connections.push(db);
  return db;
}

function version(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
}

function columns(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function backups(runtime: IsolatedRuntime): string[] {
  return readdirSync(runtime.paths.iamceoHome).filter((name) => name.includes(".pre-v"));
}

// The fixture begins in the original schema; every historical data migration really runs.
function historicalDb(path: string, target: number): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  for (let v = 0; v < target; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      if (v === 0) seed(db);
    })();
  }
  return db;
}

function seed(db: Database): void {
  db.query(`INSERT INTO projects
    (id,name,cwd,backend,permission_mode,runner_enabled,created_at,updated_at)
    VALUES ('p','기존 프로젝트','/fixture','headless','default',1,?,?)`).run(at, at);
  db.query(`INSERT INTO members
    (id,project_id,handle,name,kind,origin,cli,status,cwd,session_id,pane_id,token,context_pct,created_at,updated_at)
    VALUES ('m','p','worker','기존 직원','worker','runner','codex','idle','/fixture','native-old','terminal-old','test-only',42,?,?)`).run(at, at);
  db.query(`INSERT INTO messages (id,project_id,at,member_id,kind,body,delivery)
    VALUES ('msg_한글','p',?,'m','완료','원본 보고','delivered')`).run(at);
  db.query(`INSERT INTO deliveries (id,project_id,member_id,kind,text,status,created_at)
    VALUES ('d','p','m','message','원본 입력','delivered',?)`).run(at);
  db.query(`INSERT INTO decisions (id,project_id,member_id,who,title,status,created_at)
    VALUES ('decision','p','m','기존 직원','기존 질문','open',?)`).run(at);
  db.query(`INSERT INTO todos (id,project_id,title,created_at) VALUES ('todo','p','기존 업무',?)`).run(at);
  db.query(`INSERT INTO work (id,project_id,sec,title,sort_order,created_at,updated_at)
    VALUES ('work','p','doing','진행 중 업무',0,?,?)`).run(at, at);
  db.query(`INSERT INTO files (id,project_id,title,body,created_at,sort_order)
    VALUES ('file','p','자료','자료 본문',?,0)`).run(at);
  db.query(`INSERT INTO attachments (id,name,mime,size,path,created_at)
    VALUES ('attachment','fixture.txt','text/plain',3,'/fixture/attachment',?)`).run(at);
  db.exec(`INSERT INTO settings (key,value) VALUES ('permissionMode','"default"');`);
}

function insertDevice(db: Database, id: string, token: string | null = null, environment = "sandbox"): void {
  db.query(`INSERT INTO push_devices
    (id,label,platform,bundle_id,environment,token,authorization,state,registered_at,last_seen_at,expires_at)
    VALUES (?,?,'ios','com.yehsung.iamceo',?,?,'authorized','active',?,?,?)`).run(id, id, environment, token, at, at, "2026-12-07T00:00:00.123Z");
}

function leaveCommittedWal(runtime: IsolatedRuntime, path: string, schemaVersion: number): void {
  // Only this fixture's SQLite subprocess dies. It never imports config, binds a port, or starts a provider.
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { Database } from "bun:sqlite";
    const db = new Database(process.argv.at(-1), { create: true });
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE crash_probe (value TEXT); INSERT INTO crash_probe VALUES ('wal-only'); PRAGMA user_version=${schemaVersion};");
    process.kill(process.pid, "SIGKILL");
  `, path], { cwd: runtime.paths.work, env: runtime.childEnv() });
  expect(child.signalCode).toBe("SIGKILL");
  expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
}

describe("append-only migrations", () => {
  test("creation goal migration leaves existing projects null instead of copying mutable now", () => {
    const { path } = fixture();
    const old = historicalDb(path, MIGRATIONS.length - 1);
    old.query("UPDATE projects SET now='나중에 바뀐 상황' WHERE id='p'").run();
    expect(columns(old, "projects")).not.toContain("creation_goal");
    old.close();
    const db = track(openDb(path));
    const store = new Store(db, new Bus());
    expect(store.requireProject("p")).toMatchObject({ now: "나중에 바뀐 상황", creationGoal: null, createdAt: at });
    const project = store.createProject({ name: "새 목표", cwd: "/fixture", creationGoal: "대표의 원래 목표" });
    store.patchProject(project.id, { now: "바뀐 진행 상황" });
    expect(store.requireProject(project.id).creationGoal).toBe("대표의 원래 목표");
    expect(version(db)).toBe(MIGRATIONS.length);
  });
  test("fresh memory DB has all persistence boundaries, indexes and connection protections", () => {
    const db = track(openDb(":memory:"));
    expect(afterWindow).toBeGreaterThan(0);
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name);
    for (const name of [
      "delivery_recovery", "delivery_dispatches", "delivery_dispatch_items", "delivery_recovery_operations",
      "member_context_state", "lifecycle_journal", "execution_journal", "terminal_leases", "operation_receipts",
      "agent_operation_receipts", "domain_revisions", "report_references", "manual_inbox_batches", "manual_inbox_items",
      "push_meta", "push_devices", "push_events", "push_episodes", "push_deliveries", "push_report_groups",
      "push_report_group_reports", "push_report_group_recipients",
    ]) expect(tables).toContain(name);
    expect(columns(db, "members").filter((name) => name === "context_window")).toHaveLength(1);
    expect(columns(db, "members").filter((name) => name === "context_window_source")).toHaveLength(1);
    expect(columns(db, "members")).toContain("session_generation");
    expect(columns(db, "members")).toContain("config_revision");
    expect(columns(db, "deliveries")).toContain("next_attempt_at");
    expect(columns(db, "projects")).toContain("board_reviewed_revision");
    expect(db.query("SELECT * FROM domain_revisions").all()).toEqual([{ domain: "settings", revision: 0 }]);
    // No invented execution, compaction, server identity, or historical push on migration.
    for (const table of ["execution_journal", "lifecycle_journal", "member_context_state", "push_meta", "push_events", "push_episodes", "push_report_groups"])
      expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    for (const index of ["messages_project_page", "messages_member_page", "messages_target_page"]) {
      const keys = db.query<{ name: string; coll: string; key: number }, []>(`PRAGMA index_xinfo(${index})`).all().filter((row) => row.key);
      expect(keys.slice(-2).map((row) => [row.name, row.coll])).toEqual([["at", "BINARY"], ["id", "BINARY"]]);
    }
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='messages_project'").get()).not.toBeNull();
  });

  test("every historical prefix upgrades, retains domain rows and reopens without another backup", () => {
    for (let prefix = 0; prefix <= MIGRATIONS.length; prefix++) {
      const { runtime, path } = fixture(`prefix-${prefix}.db`);
      historicalDb(path, prefix).close();
      const db = openDb(path);
      try {
        expect(version(db)).toBe(MIGRATIONS.length);
        expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
        if (prefix > 0) {
          expect(db.query("SELECT cli,backend,session_id,pane_id FROM members WHERE id='m'").get()).toEqual({
            cli: "codex", backend: "headless", session_id: "native-old", pane_id: "terminal-old",
          });
          expect(db.query("SELECT body,delivery FROM messages WHERE id='msg_한글'").get()).toEqual({ body: "원본 보고", delivery: "delivered" });
          expect(db.query("SELECT title FROM decisions").get()).toEqual({ title: "기존 질문" });
          expect(db.query("SELECT title FROM todos").get()).toEqual({ title: "기존 업무" });
          expect(db.query("SELECT title FROM work").get()).toEqual({ title: "진행 중 업무" });
          expect(db.query("SELECT body FROM files").get()).toEqual({ body: "자료 본문" });
          expect(db.query("SELECT size,path FROM attachments").get()).toEqual({ size: 3, path: "/fixture/attachment" });
          expect(db.query("SELECT marker,phase,version FROM delivery_recovery WHERE delivery_id='d'").get()).toEqual({ marker: null, phase: "none", version: 1 });
        }
        expect(backups(runtime)).toHaveLength(prefix > 0 && prefix < MIGRATIONS.length ? 1 : 0);
      } finally { db.close(); }
      openDb(path).close();
      expect(backups(runtime)).toHaveLength(prefix > 0 && prefix < MIGRATIONS.length ? 1 : 0);
    }
  });

  test("pre-migration snapshot includes committed WAL and preserves measured windows, nonce state stays lazy", () => {
    const { runtime, path } = fixture("it's-a-db.sqlite");
    const old = track(historicalDb(path, afterWindow));
    old.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    old.query("UPDATE members SET context_window=1000000,context_window_source='statusline',context_pct=19,session_generation=7 WHERE id='m'").run();
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    const db = track(openDb(path));
    const snapshot = track(new Database(join(runtime.paths.iamceoHome, backups(runtime)[0]!), { readonly: true }));
    expect(version(snapshot)).toBe(afterWindow);
    expect(columns(snapshot, "members")).not.toContain("config_revision");
    expect(snapshot.query("SELECT name FROM sqlite_schema WHERE name='delivery_recovery'").get()).toBeNull();
    for (const connection of [db, snapshot]) {
      expect(connection.query("SELECT context_window,context_window_source,context_pct,session_generation FROM members WHERE id='m'").get()).toEqual({
        context_window: 1_000_000, context_window_source: "statusline", context_pct: 19, session_generation: 7,
      });
    }
    expect(statSync(join(runtime.paths.iamceoHome, backups(runtime)[0]!)).mode & 0o777).toBe(0o600);
    expect(db.query("SELECT * FROM member_context_state").all()).toEqual([]);
    expect(db.query("SELECT config_revision,now_at,manual_activity_at FROM members WHERE id='m'").get()).toEqual({ config_revision: 0, now_at: null, manual_activity_at: null });
    expect(db.query("SELECT board_revision,board_requested_revision,board_completed_revision,board_reviewed_revision FROM projects WHERE id='p'").get()).toEqual({
      board_revision: 0, board_requested_revision: null, board_completed_revision: null, board_reviewed_revision: null,
    });
  });

  test("reports written under the earlier runner are not re-sent to the lead after upgrade; new reports are tracked", () => {
    // Live schema on 2026-11-07 was v12. Its runner delivered worker reports without a message ref, so the
    // startup repair used to queue every historical report (397 on the live copy) to the leads again.
    const { path } = fixture();
    historicalDb(path, 12).close();
    const db = track(openDb(path));
    const store = new Store(db, new Bus());
    expect(store.listReportsMissingDeliveries().map((m) => m.id)).toEqual([]);
    db.query(`INSERT INTO messages (id,project_id,at,member_id,kind,body,delivery) VALUES ('msg_after','p',?,'m','완료','새 보고','')`).run(at);
    expect(store.listReportsMissingDeliveries().map((m) => m.id)).toEqual(["msg_after"]);
  });

  test("WAL-mode DB copied without its -wal/-shm side files still opens, backs up and migrates", () => {
    // `sqlite3 .backup`, a file-only copy or a restore of just iamceo.db leaves a WAL-mode file with no side files.
    // A read-only connection cannot create the shared-memory file there (SQLITE_CANTOPEN), which used to stop the server.
    const { runtime, path } = fixture();
    const old = historicalDb(path, afterWindow);
    old.exec("PRAGMA journal_mode=WAL");
    old.close();
    for (const side of [`${path}-wal`, `${path}-shm`]) rmSync(side, { force: true });
    const before = readFileSync(path);
    const db = track(openDb(path));
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.query("SELECT body FROM messages WHERE id='msg_한글'").get()).toEqual({ body: "원본 보고" });
    expect(backups(runtime)).toHaveLength(1);
    const snapshot = track(new Database(join(runtime.paths.iamceoHome, backups(runtime)[0]!), { readonly: true }));
    expect(version(snapshot)).toBe(afterWindow);
    expect(before.length).toBeGreaterThan(0);
  });

  test("future WAL-mode DB without side files is still refused and its bytes stay unchanged", () => {
    const { runtime, path } = fixture();
    const raw = new Database(path, { create: true });
    raw.exec(`PRAGMA journal_mode=WAL; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version=${MIGRATIONS.length + 1};`);
    raw.close();
    for (const side of [`${path}-wal`, `${path}-shm`]) rmSync(side, { force: true });
    const before = readFileSync(path);
    expect(() => openDb(path)).toThrow("미래 DB 스키마");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(backups(runtime)).toEqual([]);
  });

  test("future schema is refused before journal mode, permissions, bytes or directory contents change", () => {
    const { runtime, path } = fixture();
    const raw = new Database(path, { create: true });
    raw.exec(`CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version=${MIGRATIONS.length + 1};`);
    raw.close();
    chmodSync(path, 0o640);
    const before = readFileSync(path);
    const names = readdirSync(runtime.paths.iamceoHome);
    expect(() => openDb(path)).toThrow("미래 DB 스키마");
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(runtime.paths.iamceoHome)).toEqual(names);
    const unchanged = track(new Database(path, { readonly: true }));
    expect(unchanged.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(version(unchanged)).toBe(MIGRATIONS.length + 1);
    expect(unchanged.query("SELECT * FROM future_data").all()).toEqual([{ value: "keep" }]);
  });

  test("real VACUUM backup failure leaves source bytes, mode, schema and version unchanged", () => {
    // The DB basename fits NAME_MAX, but the appended backup name cannot. No permission/root assumptions or mocks.
    const { runtime, path } = fixture(`${"d".repeat(235)}.db`);
    historicalDb(path, afterWindow).close();
    chmodSync(path, 0o640);
    const before = readFileSync(path);
    const names = readdirSync(runtime.paths.iamceoHome);
    expect(() => openDb(path)).toThrow("마이그레이션 전 백업을 만들지 못했습니다");
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(runtime.paths.iamceoHome)).toEqual(names);
    const raw = track(new Database(path, { readonly: true }));
    expect(version(raw)).toBe(afterWindow);
    expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(raw.query("SELECT name FROM sqlite_schema WHERE name='messages_project_page'").get()).toBeNull();
  });

  test("future WAL left by a stopped process is refused without checkpointing its data", () => {
    const { runtime, path } = fixture();
    leaveCommittedWal(runtime, path, MIGRATIONS.length + 1);
    chmodSync(path, 0o640);
    const before = readFileSync(path);
    const wal = readFileSync(`${path}-wal`);
    const names = readdirSync(runtime.paths.iamceoHome);
    expect(() => openDb(path)).toThrow("미래 DB 스키마");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readFileSync(`${path}-wal`).equals(wal)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(runtime.paths.iamceoHome)).toEqual(names);
  });

  test("backup failure also leaves crash WAL contents and source permissions unchanged", () => {
    const { runtime, path } = fixture(`${"w".repeat(235)}.db`);
    historicalDb(path, afterWindow).close();
    leaveCommittedWal(runtime, path, afterWindow);
    chmodSync(path, 0o640);
    const before = readFileSync(path);
    const wal = readFileSync(`${path}-wal`);
    const names = readdirSync(runtime.paths.iamceoHome);
    expect(() => openDb(path)).toThrow("마이그레이션 전 백업을 만들지 못했습니다");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readFileSync(`${path}-wal`).equals(wal)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(runtime.paths.iamceoHome)).toEqual(names);
  });

  test("negative schema version is rejected before migration or permission changes", () => {
    const { path } = fixture();
    const raw = new Database(path, { create: true });
    raw.exec("PRAGMA user_version=-1");
    raw.close();
    chmodSync(path, 0o640);
    const before = readFileSync(path);
    expect(() => openDb(path)).toThrow("잘못된 DB 스키마 버전");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  test("version-zero populated DB is also backed up before migration failure", () => {
    const { runtime, path } = fixture();
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE projects (legacy TEXT); INSERT INTO projects VALUES ('preserve')");
    raw.close();
    expect(() => openDb(path)).toThrow();
    expect(backups(runtime)).toHaveLength(1);
    const snapshot = track(new Database(join(runtime.paths.iamceoHome, backups(runtime)[0]!), { readonly: true }));
    expect(version(snapshot)).toBe(0);
    expect(snapshot.query("SELECT * FROM projects").all()).toEqual([{ legacy: "preserve" }]);
  });

  test("a failed stage rolls back all its DDL and version, earlier stages commit and reopen resumes", () => {
    const { runtime, path } = fixture();
    historicalDb(path, afterWindow).close();
    const stage = MIGRATIONS.findIndex((sql) => sql.includes("CREATE TABLE delivery_recovery"));
    const sql = MIGRATIONS[stage]!;
    try {
      MIGRATIONS[stage] = `${sql}\nINSERT INTO nonexistent_migration_fault VALUES (1);`;
      expect(() => openDb(path)).toThrow("nonexistent_migration_fault");
    } finally { MIGRATIONS[stage] = sql; }
    const partial = new Database(path);
    try {
      expect(version(partial)).toBe(stage);
      expect(partial.query("SELECT name FROM sqlite_schema WHERE name='messages_project_page'").get()).not.toBeNull();
      expect(partial.query("SELECT name FROM sqlite_schema WHERE name LIKE 'delivery_recovery%'").all()).toEqual([]);
      expect(columns(partial, "activity")).not.toContain("delivery_event_key");
      expect(partial.query("SELECT body FROM messages").get()).toEqual({ body: "원본 보고" });
      // The failed open must have closed its connection and transaction.
      partial.exec("BEGIN EXCLUSIVE; ROLLBACK;");
    } finally { partial.close(); }
    const db = track(openDb(path));
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(backups(runtime)).toHaveLength(2);
  });
});

describe("persistence contracts", () => {
  function ready(): Database {
    const { path } = fixture();
    historicalDb(path, afterWindow).close();
    return track(openDb(path));
  }

  test("paging indexes seek tuples including identical timestamps and Unicode IDs", () => {
    const db = ready();
    const insert = db.query("INSERT INTO messages (id,project_id,at,member_id,target_member_id,kind) VALUES (?,'p',?,'m','m','진행')");
    db.transaction(() => {
      for (let i = 0; i < 1_205; i++) insert.run(`msg_${String(i).padStart(4, "0")}`, at);
      for (const id of ["msg_é", "msg_한", "msg_😀", "msg_\uE000"]) insert.run(id, at);
    })();
    for (const [index, filter] of [["messages_project_page", ""], ["messages_member_page", " AND member_id='m'"], ["messages_target_page", " AND target_member_id='m'"]]) {
      const sql = `SELECT id,at FROM messages WHERE project_id='p'${filter} AND (at,id) < (?,?) ORDER BY at DESC,id DESC LIMIT 101`;
      const plan = db.query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN ${sql}`).all(at, "zz");
      expect(plan.some((row) => row.detail.includes(index!) && row.detail.includes("SEARCH"))).toBe(true);
      expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
    }
    const expected = db.query<{ id: string }, []>("SELECT id FROM messages WHERE project_id='p' ORDER BY at DESC,id DESC").all().map((row) => row.id);
    const actual: string[] = [];
    let boundary = { at: "9999", id: "z" };
    for (;;) {
      const page = db.query<{ id: string; at: string }, [string, string]>("SELECT id,at FROM messages WHERE project_id='p' AND (at,id) < (?,?) ORDER BY at DESC,id DESC LIMIT 100").all(boundary.at, boundary.id);
      if (!page.length) break;
      actual.push(...page.map((row) => row.id));
      boundary = page[page.length - 1]!;
    }
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(expected.length);
  });

  test("delivery markers, ordinals, submit limit, CAS versions and activity keys are constrained", () => {
    const db = ready();
    expect(() => db.exec("UPDATE delivery_recovery SET version=0 WHERE delivery_id='d'")).toThrow();
    expect(() => db.exec("UPDATE delivery_recovery SET phase='received' WHERE delivery_id='d'")).toThrow();
    expect(() => db.exec("UPDATE delivery_recovery SET active_check_ms=-1 WHERE delivery_id='d'")).toThrow();
    db.query(`INSERT INTO delivery_dispatches
      (id,project_id,member_id,bundle_marker,cli,backend,generation,terminal_identity_json,baseline_json,wire_text,wire_sha256,transport_state,created_at,updated_at)
      VALUES ('dispatch','p','m','#bundle','codex','core',0,'{}','{}','wire','hash','unknown',?,?)`).run(at, at);
    db.exec("INSERT INTO delivery_dispatch_items VALUES ('dispatch','d',0,'source-v1')");
    expect(() => db.exec("INSERT INTO delivery_dispatch_items VALUES ('dispatch','d',1,'source-v1')")).toThrow();
    expect(() => db.exec("UPDATE delivery_dispatches SET submit_attempts=2")).toThrow();
    db.query("INSERT INTO activity (member_id,at,kind,text,delivery_event_key) VALUES ('m',?,'system','checked','dispatch:d:resolved:1')").run(at);
    expect(() => db.query("INSERT INTO activity (member_id,at,kind,text,delivery_event_key) VALUES ('m',?,'system','duplicate','dispatch:d:resolved:1')").run(at)).toThrow();
    db.query("INSERT INTO activity (member_id,at,kind,text) VALUES ('m',?,'system','legacy')").run(at);
    db.query("INSERT INTO activity (member_id,at,kind,text) VALUES ('m',?,'system','legacy')").run(at);
    expect(() => db.query("INSERT INTO member_context_state (member_id,generation,binding_nonce,updated_at) VALUES ('missing',0,'nonce',?)").run(at)).toThrow();
  });

  test("journal, lease, receipt, retry and board review identities survive reopening", () => {
    const { path } = fixture();
    historicalDb(path, afterWindow).close();
    const db = openDb(path);
    const due = "2026-11-07T00:05:00.123Z";
    try {
      db.query(`INSERT INTO lifecycle_journal (operation_id,member_id,project_id,intent,phase,generation,terminal_identity_json,reason,exit_code,created_at,updated_at)
        VALUES ('start-op','m','p','start','unknown',7,'{"terminalId":"terminal-old"}','run_response_lost',1,?,?)`).run(at, at);
      db.query(`INSERT INTO execution_journal (run_id,member_id,project_id,generation,terminal_identity_json,delivery_ids_json,phase,reason,exit_code,created_at,updated_at)
        VALUES ('run','m','p',7,'{"terminalId":"terminal-old"}','["d"]','interrupted','process_exit',1,?,?)`).run(at, at);
      db.query("INSERT INTO terminal_leases VALUES ('m','claim','lease',7,'{\"terminalId\":\"terminal-old\"}',?,3)").run(Date.parse(due));
      db.query(`INSERT INTO operation_receipts (operation_id,kind,project_id,member_id,status,request_json,code,error,created_at,updated_at)
        VALUES ('input-op','terminal_control','p','m','unknown','{"claimId":"claim","inputSequence":3}','INPUT_UNKNOWN','결과 확인 중',?,?)`).run(at, at);
      expect(() => db.exec("UPDATE operation_receipts SET status='applied' WHERE operation_id='input-op'")).toThrow();
      expect(() => db.query("INSERT INTO terminal_leases VALUES ('m','other-claim','other-lease',7,'{}',?,0)").run(Date.parse(due))).toThrow();
      db.query("UPDATE deliveries SET next_attempt_at=?,retry_scope='fixture-provider',retry_reason='quota' WHERE id='d'").run(due);
      db.exec("UPDATE members SET config_revision=4 WHERE id='m'; UPDATE todos SET revision=2 WHERE id='todo'; UPDATE domain_revisions SET revision=3 WHERE domain='settings';");
      db.exec("UPDATE projects SET board_revision=9,board_requested_revision=7,board_completed_revision=7,board_reviewed_revision=6 WHERE id='p'");
      db.query("INSERT INTO member_context_state (member_id,generation,binding_nonce,compaction_json,updated_at) VALUES ('m',7,'stable-nonce','{\"phase\":\"uncertain\"}',?)").run(at);
    } finally { db.close(); }
    const reopened = track(openDb(path));
    expect(reopened.query("SELECT phase,reason,exit_code,generation FROM lifecycle_journal").get()).toEqual({ phase: "unknown", reason: "run_response_lost", exit_code: 1, generation: 7 });
    expect(reopened.query("SELECT delivery_ids_json,phase,exit_code FROM execution_journal").get()).toEqual({ delivery_ids_json: '["d"]', phase: "interrupted", exit_code: 1 });
    expect(reopened.query("SELECT claim_id,generation,expires_at,last_input_sequence FROM terminal_leases").get()).toEqual({ claim_id: "claim", generation: 7, expires_at: Date.parse(due), last_input_sequence: 3 });
    expect(reopened.query("SELECT status,code FROM operation_receipts").get()).toEqual({ status: "unknown", code: "INPUT_UNKNOWN" });
    expect(reopened.query("SELECT next_attempt_at FROM deliveries WHERE id='d'").get()).toEqual({ next_attempt_at: due });
    expect(reopened.query("SELECT config_revision FROM members WHERE id='m'").get()).toEqual({ config_revision: 4 });
    expect(reopened.query("SELECT revision FROM todos WHERE id='todo'").get()).toEqual({ revision: 2 });
    expect(reopened.query("SELECT revision FROM domain_revisions WHERE domain='settings'").get()).toEqual({ revision: 3 });
    expect(reopened.query("SELECT board_revision,board_requested_revision,board_completed_revision,board_reviewed_revision FROM projects").get()).toEqual({
      board_revision: 9, board_requested_revision: 7, board_completed_revision: 7, board_reviewed_revision: 6,
    });
    expect(reopened.query("SELECT binding_nonce,compaction_json FROM member_context_state").get()).toEqual({ binding_nonce: "stable-nonce", compaction_json: '{"phase":"uncertain"}' });
    reopened.exec("DELETE FROM members WHERE id='m'");
    // Closing a member must not erase the operation outcome or initial failure evidence.
    expect(reopened.query("SELECT COUNT(*) AS n FROM lifecycle_journal").get()).toEqual({ n: 1 });
    expect(reopened.query("SELECT COUNT(*) AS n FROM execution_journal").get()).toEqual({ n: 1 });
    expect(reopened.query("SELECT COUNT(*) AS n FROM operation_receipts").get()).toEqual({ n: 1 });
    expect(reopened.query("SELECT * FROM terminal_leases").all()).toEqual([]);
    expect(reopened.query("SELECT * FROM member_context_state").all()).toEqual([]);
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("push defaults, enums, token generation, event and device fanout uniqueness", () => {
    const db = ready();
    insertDevice(db, "device-a", "token");
    insertDevice(db, "device-b", "token", "production");
    insertDevice(db, "revoked-a");
    insertDevice(db, "revoked-b");
    const device = db.query<{ enabled: number; preferences: string; revision: number; registration_generation: number }, []>("SELECT enabled,preferences,revision,registration_generation FROM push_devices WHERE id='device-a'").get()!;
    expect(device.enabled).toBe(0);
    expect(JSON.parse(device.preferences)).toEqual(DEFAULT_PUSH_PREFERENCES);
    expect(device.revision).toBe(1);
    expect(device.registration_generation).toBe(1);
    expect(() => insertDevice(db, "duplicate", "token")).toThrow();
    for (const change of ["enabled=2", "platform='macos'", "environment='test'", "authorization='unknown'", "state='unknown'", "revision=0", "registration_generation=0", "last_failure='raw-secret'"])
      expect(() => db.exec(`UPDATE push_devices SET ${change} WHERE id='device-a'`)).toThrow();
    for (const kind of ["decision", "approval_wait", "error", "report_complete", "test"]) {
      db.query("INSERT INTO push_events VALUES (?,?,?,'p','m','{}',?,?)").run(kind, `source:${kind}`, kind, at, at);
    }
    expect(() => db.query("INSERT INTO push_events VALUES ('other','source:decision','decision',NULL,NULL,'{}',?,?)").run(at, at)).toThrow();
    expect(() => db.query("INSERT INTO push_events VALUES ('question','source:question','question',NULL,NULL,'{}',?,?)").run(at, at)).toThrow();
    db.query("INSERT INTO push_deliveries (id,event_id,device_id,registration_generation,state,next_attempt_at,expires_at) VALUES ('push','decision','device-a',1,'unknown',?,?)").run(at, at);
    expect(() => db.query("INSERT INTO push_deliveries (id,event_id,device_id,registration_generation,state,next_attempt_at,expires_at) VALUES ('dup','decision','device-a',2,'queued',?,?)").run(at, at)).toThrow();
    db.exec("DELETE FROM members WHERE id='m'; DELETE FROM projects WHERE id='p'");
    // Events retain immutable source IDs after domain deletion; device/event cleanup still cascades deliveries.
    expect(db.query("SELECT project_id,member_id FROM push_events WHERE id='decision'").get()).toEqual({ project_id: "p", member_id: "m" });
    db.exec("DELETE FROM push_events WHERE id='decision'");
    expect(db.query("SELECT * FROM push_deliveries").all()).toEqual([]);
  });

  test("fixed 120s groups keep report order, original recipients, cancellation and one event across restart", () => {
    const { path } = fixture();
    historicalDb(path, afterWindow).close();
    const db = openDb(path);
    const closesAt = new Date(Date.parse(at) + PUSH_REPORT_GROUP_WINDOW_MS).toISOString();
    try {
      insertDevice(db, "device-a");
      db.query("INSERT INTO push_meta VALUES (1,'persistent-server-id',?)").run(at);
      const insertGroup = db.query("INSERT INTO push_report_groups (id,project_id,member_id,opened_at,closes_at,last_message_id) VALUES (?, 'p', ?, ?, ?, 'report-2')");
      insertGroup.run("group", "m", at, closesAt);
      expect(() => insertGroup.run("duplicate", "m", at, closesAt)).toThrow();
      insertGroup.run("other-member", "other", at, closesAt);
      expect(() => insertGroup.run("extended", "third", at, new Date(Date.parse(at) + 121_000).toISOString())).toThrow();
      expect(() => insertGroup.run("invalid-time", "third", "invalid", closesAt)).toThrow();
      db.exec("INSERT INTO push_report_group_reports VALUES ('group','report-1',0),('group','report-2',1)");
      expect(() => db.exec("INSERT INTO push_report_group_reports VALUES ('other-member','report-1',0)")).toThrow();
      db.exec("INSERT INTO push_report_group_recipients (group_id,device_id,registration_generation) VALUES ('group','device-a',1)");
      insertDevice(db, "late-device");
      db.query("UPDATE push_report_group_recipients SET cancelled_at=? WHERE group_id='group' AND device_id='device-a'").run(at);
      db.exec("UPDATE push_devices SET enabled=1,registration_generation=2 WHERE id='device-a'");
    } finally { db.close(); }
    const reopened = track(openDb(path));
    expect(reopened.query("SELECT server_id FROM push_meta").get()).toEqual({ server_id: "persistent-server-id" });
    expect(reopened.query("SELECT opened_at,closes_at,last_message_id,state FROM push_report_groups WHERE id='group'").get()).toEqual({ opened_at: at, closes_at: closesAt, last_message_id: "report-2", state: "open" });
    expect(reopened.query("SELECT message_id FROM push_report_group_reports WHERE group_id='group' ORDER BY ordinal").all()).toEqual([{ message_id: "report-1" }, { message_id: "report-2" }]);
    expect(reopened.query("SELECT device_id,registration_generation,cancelled_at FROM push_report_group_recipients WHERE group_id='group'").all()).toEqual([{ device_id: "device-a", registration_generation: 1, cancelled_at: at }]);
    reopened.transaction(() => {
      reopened.query("INSERT INTO push_events VALUES ('group-event','group:group','report_complete','p','m','{}',?,?)").run(closesAt, closesAt);
      reopened.query("UPDATE push_report_groups SET state='closed',event_id='group-event',closed_at=? WHERE id='group' AND state='open'").run(closesAt);
    })();
    expect(() => reopened.query("INSERT INTO push_events VALUES ('event-again','group:group','report_complete','p','m','{}',?,?)").run(closesAt, closesAt)).toThrow();
    expect(() => reopened.exec("UPDATE push_report_groups SET event_id='group-event' WHERE id='other-member'")).toThrow();
    // A new window is allowed after the prior one closes, never by resurrecting its recipient rows.
    reopened.query("INSERT INTO push_report_groups (id,project_id,member_id,opened_at,closes_at,last_message_id) VALUES ('next','p','m',?,?,'report-3')").run(closesAt, new Date(Date.parse(closesAt) + PUSH_REPORT_GROUP_WINDOW_MS).toISOString());
    expect(reopened.query("SELECT * FROM push_report_group_recipients WHERE group_id='next'").all()).toEqual([]);
  });
});
