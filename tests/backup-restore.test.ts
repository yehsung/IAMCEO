import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { join } from "node:path";
import { BackupManager, backupFile, createBackup, DEFAULT_BACKUP_POLICY, listBackups, pruneBackups, verifyBackup } from "../server/backup.ts";
import type { BackupSnapshot } from "../server/backup.ts";
import { openDb, MIGRATIONS } from "../server/db.ts";
import { acquireHomeOwner } from "../server/home-owner.ts";
import { restoreBackup, verifyRestoredHome } from "../server/restore.ts";
import { classifyStorageError } from "../server/storage-errors.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import type { IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const runtimes: IsolatedRuntime[] = [];
const databases: Database[] = [];
const at = "2026-11-07T00:00:00.000Z";

afterEach(async () => {
  for (const db of databases.splice(0).reverse()) db.close();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

function fixture() {
  const runtime = createIsolatedRuntime();
  runtimes.push(runtime);
  const home = runtime.paths.iamceoHome;
  const root = join(runtime.dir, "backups");
  const destination = join(runtime.dir, "restored");
  fs.mkdirSync(join(home, "uploads"), { mode: 0o700 });
  fs.writeFileSync(join(home, "config.json"), JSON.stringify({ accessCode: "fixture-secret", port: 0, hosts: ["127.0.0.1"], coreSocket: join(home, "core.sock") }), { mode: 0o600 });
  const db = track(openDb(join(home, "iamceo.db")));
  db.exec("PRAGMA wal_autocheckpoint=0");
  db.query("INSERT INTO projects (id,name,cwd,runner_enabled,created_at,updated_at) VALUES ('p','보관할 기록',?,1,?,?)").run(join(home, "work"), at, at);
  db.query(`INSERT INTO members (id,project_id,handle,name,kind,origin,status,cwd,token,session_id,pane_id,backend,created_at,updated_at)
    VALUES ('m','p','worker','직원','worker','runner','working',?,'fixture-member','native-id','terminal-id','core',?,?)`).run(runtime.paths.work, at, at);
  const path = join(home, "uploads", "attachment.txt");
  fs.writeFileSync(path, "원본", { mode: 0o600 });
  const attachment = { id: "a", name: "attachment.txt", mime: "text/plain", size: fs.statSync(path).size, path, url: "/api/attachments/a/attachment.txt", isImage: false };
  db.query("INSERT INTO attachments (id,name,mime,size,path,created_at) VALUES (?,?,?,?,?,?)").run(attachment.id, attachment.name, attachment.mime, attachment.size, path, at);
  db.query("INSERT INTO messages (id,project_id,at,kind,body,attachments,delivery,mine) VALUES ('msg','p',?,'일반','원본',?,'queued',1)").run(at, JSON.stringify([attachment]));
  db.query("INSERT INTO files (id,project_id,title,attachments,path,sort_order,created_at) VALUES ('file','p','자료',?,?,0,?)").run(JSON.stringify([attachment]), path, at);
  db.query("INSERT INTO decisions (id,project_id,title,who,status,images,created_at) VALUES ('question','p','질문','직원','open',?,?)").run(JSON.stringify([attachment]), at);
  const backup = (date = at) => createBackup({ home, backupDir: root, now: new Date(date) });
  return { runtime, home, root, destination, db, path, attachment, backup };
}

function track(db: Database): Database { databases.push(db); return db; }
function readDb(home: string): Database { return track(new Database(join(home, "iamceo.db"), { readonly: true })); }
function json(path: string) { return JSON.parse(fs.readFileSync(path, "utf8")); }

function rewriteManifest(snapshot: BackupSnapshot, edit: (value: BackupSnapshot["manifest"]) => void): void {
  const value = json(join(snapshot.directory, "manifest.json"));
  edit(value);
  fs.writeFileSync(join(snapshot.directory, "manifest.json"), JSON.stringify(value));
}

function seedOutbound(db: Database): void {
  for (const status of ["queued", "held", "delivering", "failed", "delivered"]) {
    db.query("INSERT INTO deliveries (id,project_id,member_id,kind,text,status,created_at) VALUES (?,'p','m','message','original wire',?,?)").run(status, status, at);
  }
  db.query("INSERT INTO delivery_recovery (delivery_id,marker,phase,updated_at) VALUES ('delivering','marker','checking',?)").run(at);
  db.query(`INSERT INTO delivery_dispatches (id,project_id,member_id,bundle_marker,cli,backend,generation,
    native_session_id,terminal_identity_json,baseline_json,wire_text,wire_sha256,transport_state,created_at,updated_at)
    VALUES ('dispatch','p','m','bundle','claude','core',0,'native-id','{}','{}','immutable wire',?,'write_started',?,?)`).run("a".repeat(64), at, at);
  db.query("INSERT INTO lifecycle_journal (operation_id,member_id,project_id,intent,phase,generation,terminal_identity_json,created_at,updated_at) VALUES ('start','m','p','start','started',0,'{}',?,?)").run(at, at);
  db.query("INSERT INTO execution_journal (run_id,member_id,project_id,generation,terminal_identity_json,phase,created_at,updated_at) VALUES ('run','m','p',0,'{}','running',?,?)").run(at, at);
  db.query("INSERT INTO operation_receipts (operation_id,kind,status,request_json,created_at,updated_at) VALUES ('input','terminal_control','pending','{}',?,?)").run(at, at);
  db.query("INSERT INTO terminal_leases (member_id,claim_id,lease_id,generation,terminal_identity_json,expires_at) VALUES ('m','claim','lease',0,'{}',9999999999999)").run();
  db.query("INSERT INTO push_meta (id,server_id,created_at) VALUES (1,'server-original',?)").run(at);
  db.query(`INSERT INTO push_devices (id,label,platform,bundle_id,environment,token,authorization,enabled,state,registered_at,last_seen_at,expires_at)
    VALUES ('device','기기','ios','com.yehsung.iamceo','sandbox','fixture-token','authorized',1,'active',?,?,?)`).run(at, at, "2027-01-01T00:00:00.000Z");
  for (const state of ["queued", "retry", "sending", "accepted", "unknown"]) {
    db.query("INSERT INTO push_events (id,source_key,kind,target,occurred_at,expires_at) VALUES (?,?,'decision','{}',?,?)").run(state, state, at, "2027-01-01T00:00:00.000Z");
    db.query("INSERT INTO push_deliveries (id,event_id,device_id,registration_generation,state,next_attempt_at,expires_at) VALUES (?,?,'device',1,?,?,?)").run(state, state, state, at, "2027-01-01T00:00:00.000Z");
  }
  db.query("INSERT INTO push_report_groups (id,project_id,member_id,opened_at,closes_at,last_message_id) VALUES ('group','p','m',?,'2026-11-07T00:02:00.000Z','msg')").run(at);
  db.query("INSERT INTO push_report_group_recipients (group_id,device_id,registration_generation) VALUES ('group','device',1)").run();
}

describe("consistent backup packages", () => {
  test("includes committed WAL, all attachment rows/drafts and protected config; copies are independent", () => {
    const f = fixture();
    const draftPath = join(f.home, "uploads", "draft");
    fs.writeFileSync(draftPath, "", { mode: 0o600 });
    f.db.query("INSERT INTO attachments (id,name,mime,size,path,created_at) VALUES ('draft','draft','text/plain',0,?,?)").run(draftPath, at);
    expect(fs.statSync(join(f.home, "iamceo.db-wal")).size).toBeGreaterThan(0);
    const owner = acquireHomeOwner(f.home);
    let snapshot: BackupSnapshot;
    try { snapshot = f.backup(); } finally { owner.release(); }
    expect(snapshot.manifest.attachments).toHaveLength(2);
    expect(readDb(snapshot.directory).query("SELECT body FROM messages WHERE id='msg'").get()).toEqual({ body: "원본" });
    f.db.query("UPDATE messages SET body='later'").run();
    fs.writeFileSync(f.path, "바뀜");
    expect(readDb(snapshot.directory).query("SELECT body FROM messages WHERE id='msg'").get()).toEqual({ body: "원본" });
    expect(fs.readFileSync(join(snapshot.directory, snapshot.manifest.attachments[0].path), "utf8")).toBe("원본");
    expect(verifyBackup(snapshot.directory).manifest.id).toBe(snapshot.manifest.id);
    for (const path of [snapshot.directory, join(snapshot.directory, "attachments")]) expect(fs.statSync(path).mode & 0o777).toBe(0o700);
    for (const path of ["iamceo.db", "manifest.json", "config.json", ...snapshot.manifest.attachments.map((entry) => entry.path)]) expect(fs.statSync(join(snapshot.directory, path)).mode & 0o777).toBe(0o600);
    expect(json(join(snapshot.directory, "config.json")).accessCode).toBe("fixture-secret");
  });

  test("APNs config is included but p8 is only recorded as requiring separate backup", () => {
    const f = fixture();
    const key = join(f.runtime.dir, "must-not-be-read.p8");
    // A directory cannot be read as a key. Backup succeeds without inspecting it.
    fs.mkdirSync(key);
    fs.writeFileSync(join(f.home, "apns.json"), JSON.stringify({ sandbox: { privateKeyPath: key, keyId: "JA65PRWDJX", teamId: "MQ2KQK37WD", bundleId: "com.yehsung.iamceo" } }), { mode: 0o600 });
    const snapshot = f.backup();
    expect(snapshot.manifest.configs.map((entry) => entry.path)).toEqual(["config.json", "apns.json"]);
    expect(snapshot.manifest.externalSecrets.apnsP8).toBe("separate_backup_required_not_included");
    expect(fs.readdirSync(snapshot.directory).sort()).toEqual(["apns.json", "attachments", "config.json", "iamceo.db", "manifest.json"]);
    f.db.query("UPDATE attachments SET name='AuthKey.p8',path=?").run(key);
    expect(() => f.backup()).toThrow("p8");
    expect(listBackups(f.root)).toHaveLength(1);
  });

  test("a home alias shares ownership while uploaded symlink components remain forbidden", () => {
    const f = fixture();
    const alias = join(f.runtime.dir, "alias");
    fs.symlinkSync(f.home, alias);
    f.db.query("UPDATE attachments SET path=?").run(join(alias, "uploads", "attachment.txt"));
    const snapshot = createBackup({ home: alias, backupDir: f.root });
    expect(snapshot.manifest.sourceHome).toBe(f.home);
    expect(snapshot.manifest.sourceHomeAliases).toEqual([alias]);
    expect(restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination }).outboundEnabled).toBe(false);
  });

  test("rejects invalid/inline-secret config, dangling JSON references and DB sidecars", () => {
    const f = fixture();
    fs.writeFileSync(join(f.home, "config.json"), "{");
    expect(() => f.backup()).toThrow();
    fs.writeFileSync(join(f.home, "config.json"), JSON.stringify({ accessCode: "fixture-secret", key: "-----BEGIN PRIVATE KEY-----" }));
    expect(() => f.backup()).toThrow("private key");
    fs.writeFileSync(join(f.home, "config.json"), JSON.stringify({ accessCode: "fixture-secret" }));
    f.db.query("UPDATE messages SET attachments=?").run(JSON.stringify([{ id: "missing", path: f.path }]));
    expect(() => f.backup()).toThrow("missing attachment");
    f.db.query("UPDATE messages SET attachments='[]'").run();
    const snapshot = f.backup();
    fs.writeFileSync(join(snapshot.directory, "iamceo.db-wal"), "stray WAL");
    expect(() => verifyBackup(snapshot.directory)).toThrow("sidecars");
  });

  test.each(["missing", "size", "symlink", "ancestor", "outside"])("rejects %s attachment and publishes no partial snapshot", (fault) => {
    const f = fixture();
    if (fault === "missing") fs.unlinkSync(f.path);
    if (fault === "size") fs.writeFileSync(f.path, "wrong size");
    if (fault === "symlink") { fs.unlinkSync(f.path); fs.symlinkSync(join(f.home, "config.json"), f.path); }
    if (fault === "ancestor") {
      const alias = join(f.home, "uploads", "alias");
      fs.symlinkSync(f.runtime.paths.work, alias);
      fs.writeFileSync(join(f.runtime.paths.work, "file"), "원본");
      f.db.query("UPDATE attachments SET path=?").run(join(alias, "file"));
    }
    if (fault === "outside") f.db.query("UPDATE attachments SET path=?").run(join(f.home, "config.json"));
    expect(() => f.backup()).toThrow();
    expect(listBackups(f.root)).toEqual([]);
    expect(fs.readdirSync(f.root)).toEqual([".owner.lock"]);
  });

  test("equal-size corruption, missing package files and manifest path traversal are rejected", () => {
    const f = fixture();
    const first = f.backup();
    fs.writeFileSync(join(first.directory, first.manifest.attachments[0].path), "변조");
    expect(() => verifyBackup(first.directory)).toThrow("hash mismatch");
    const second = f.backup();
    fs.unlinkSync(join(second.directory, "config.json"));
    expect(() => verifyBackup(second.directory)).toThrow();
    const third = f.backup();
    rewriteManifest(third, (manifest) => { manifest.attachments[0].path = "../config.json"; });
    expect(() => verifyBackup(third.directory)).toThrow();
    expect(listBackups(f.root)).toEqual([]);
  });

  test("checks DB integrity, foreign keys and future schema even if the file digest matches", () => {
    const f = fixture();
    for (const fault of ["integrity", "foreign_keys", "future"]) {
      const snapshot = f.backup();
      const path = join(snapshot.directory, "iamceo.db");
      if (fault === "integrity") fs.writeFileSync(path, "not SQLite");
      else {
        const db = new Database(path);
        try {
          if (fault === "foreign_keys") db.exec("PRAGMA foreign_keys=OFF; UPDATE members SET project_id='missing'");
          else db.exec(`PRAGMA user_version=${MIGRATIONS.length + 1}`);
        } finally { db.close(); }
      }
      rewriteManifest(snapshot, (manifest) => { manifest.database = { path: "iamceo.db", ...backupFile(path) }; });
      expect(() => verifyBackup(snapshot.directory)).toThrow();
    }
    f.db.exec(`PRAGMA user_version=${MIGRATIONS.length + 1}`);
    const before = backupFile(join(f.home, "iamceo.db-wal"));
    expect(() => f.backup()).toThrow("schema");
    expect(backupFile(join(f.home, "iamceo.db-wal"))).toEqual(before);
  });

  test("storage-full leaves the prior success and config intact; next attempt can succeed", async () => {
    const f = fixture();
    const first = f.backup();
    const original = fs.writeSync;
    const spy = spyOn(fs, "writeSync").mockImplementation(() => {
      throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
    });
    let error: unknown;
    try { f.backup("2026-11-08T00:00:00.000Z"); } catch (caught) { error = caught; }
    finally { spy.mockRestore(); }
    expect(fs.writeSync).toBe(original);
    expect(classifyStorageError(error)).toBe("storage_full");
    expect(listBackups(f.root).map((snapshot) => snapshot.manifest.id)).toEqual([first.manifest.id]);
    expect(fs.readdirSync(f.root).some((name) => name.startsWith(".pending-"))).toBe(false);
    expect(json(join(f.home, "config.json")).accessCode).toBe("fixture-secret");
    expect(f.backup("2026-11-08T00:00:00.000Z").manifest.id).not.toBe(first.manifest.id);
  });

  test("another process cannot back up a home held by this daemon", () => {
    const f = fixture();
    const owner = acquireHomeOwner(f.home);
    try {
      const child = Bun.spawnSync([process.execPath, "-e", `
        import { createBackup } from ${JSON.stringify(join(import.meta.dir, "../server/backup.ts"))};
        try { createBackup({home:process.argv.at(-2),backupDir:process.argv.at(-1)}); process.exit(1); }
        catch(error) { console.log(error.code); process.exit(error.code === 'home_in_use' ? 0 : 2); }
      `, f.home, f.root], { cwd: f.runtime.paths.work, env: f.runtime.childEnv() });
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString().trim()).toBe("home_in_use");
      expect(fs.existsSync(f.root)).toBe(false);
    } finally { owner.release(); }
    expect(f.backup().manifest.schemaVersion).toBe(MIGRATIONS.length);
  });

  test("directory sync failure after publish does not become the next successful backup", () => {
    const f = fixture();
    const first = f.backup();
    const original = fs.fsyncSync;
    const spy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory() && fs.realpathSync(`/dev/fd/${fd}`) === f.root) throw Object.assign(new Error("fixture sync failure"), { code: "EIO" });
      original(fd);
    });
    try { expect(() => f.backup("2026-11-08T00:00:00.000Z")).toThrow("storage_io"); }
    finally { spy.mockRestore(); }
    expect(listBackups(f.root).map((snapshot) => snapshot.manifest.id)).toEqual([first.manifest.id]);
  });
});

describe("separate-home restore and outbound reconciliation", () => {
  test("migrates an older backup only in the restore staging copy", () => {
    const f = fixture();
    const oldHome = join(f.runtime.dir, "old-home");
    fs.mkdirSync(oldHome, { mode: 0o700 });
    fs.mkdirSync(join(oldHome, "uploads"), { mode: 0o700 });
    fs.writeFileSync(join(oldHome, "config.json"), JSON.stringify({ accessCode: "old-secret" }), { mode: 0o600 });
    const old = new Database(join(oldHome, "iamceo.db"), { create: true });
    try { old.exec(MIGRATIONS[0]); old.exec("PRAGMA user_version=1"); } finally { old.close(); }
    const snapshot = createBackup({ home: oldHome, backupDir: f.root });
    const before = backupFile(join(snapshot.directory, "iamceo.db"));
    restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination });
    expect(readDb(f.destination).query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    expect(backupFile(join(snapshot.directory, "iamceo.db"))).toEqual(before);
    expect(readDb(oldHome).query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(fs.readdirSync(f.destination).some((name) => name.includes(".pre-v"))).toBe(false);
    expect(verifyRestoredHome(f.destination).outboundEnabled).toBe(false);
  });

  test("relocates DB/embedded attachment paths and config without mutating source or package", () => {
    const f = fixture();
    const snapshot = f.backup();
    const digest = backupFile(join(snapshot.directory, "iamceo.db"));
    const result = restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination });
    expect(result).toMatchObject({ home: f.destination, reconciliationRequired: true, outboundEnabled: false });
    expect(verifyRestoredHome(f.destination)).toEqual(result);
    const db = readDb(f.destination);
    const path = join(f.destination, "uploads", "0.bin");
    expect(db.query("SELECT path FROM attachments WHERE id='a'").get()).toEqual({ path });
    expect(fs.readFileSync(path, "utf8")).toBe("원본");
    for (const [table, column] of [["messages", "attachments"], ["files", "attachments"], ["decisions", "images"]]) {
      const row = db.query<{ value: string }, []>(`SELECT ${column} AS value FROM ${table}`).get()!;
      expect(JSON.parse(row.value)[0]).toEqual({ ...f.attachment, path });
    }
    expect(db.query("SELECT path FROM files").get()).toEqual({ path });
    expect(db.query("SELECT cwd FROM projects").get()).toEqual({ cwd: join(f.destination, "work") });
    expect(json(join(f.destination, "config.json"))).toMatchObject({ accessCode: "fixture-secret", coreSocket: join(f.destination, "core.sock") });
    expect(f.db.query("SELECT path FROM attachments").get()).toEqual({ path: f.path });
    expect(f.db.query("SELECT runner_enabled FROM projects").get()).toEqual({ runner_enabled: 1 });
    expect(backupFile(join(snapshot.directory, "iamceo.db"))).toEqual(digest);
    for (const path of [f.destination, join(f.destination, "uploads"), join(f.destination, "inbox"), join(f.destination, "roles")]) expect(fs.statSync(path).mode & 0o777).toBe(0o700);
    for (const path of ["iamceo.db", "config.json", "restore-state.json", "uploads/0.bin"]) expect(fs.statSync(join(f.destination, path)).mode & 0o777).toBe(0o600);
  });

  test.each(["same-host", "clone"] as const)("%s freezes queues/pushes, preserves unknown input evidence and requires reconciliation", (mode) => {
    const f = fixture();
    seedOutbound(f.db);
    const snapshot = f.backup();
    const result = restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination, mode });
    const db = readDb(f.destination);
    expect(db.query("SELECT id,status,hold_reason FROM deliveries ORDER BY id").all()).toEqual([
      { id: "delivered", status: "delivered", hold_reason: null },
      ...["delivering", "failed", "held", "queued"].map((id) => ({ id, status: "held", hold_reason: "delivery_unknown" })),
    ]);
    expect(db.query("SELECT DISTINCT phase,reason FROM delivery_recovery").all()).toEqual([{ phase: "stopped", reason: "restore_reconciliation_required" }]);
    expect(db.query("SELECT wire_text,wire_sha256,transport_state FROM delivery_dispatches").get()).toEqual({ wire_text: "immutable wire", wire_sha256: "a".repeat(64), transport_state: "write_started" });
    expect(db.query("SELECT session_id,pane_id FROM members").get()).toEqual({ session_id: "native-id", pane_id: "terminal-id" });
    expect(db.query("SELECT claim_id,lease_id FROM terminal_leases").get()).toEqual({ claim_id: "claim", lease_id: "lease" });
    expect(db.query("SELECT phase FROM lifecycle_journal").get()).toEqual({ phase: "unknown" });
    expect(db.query("SELECT phase FROM execution_journal").get()).toEqual({ phase: "unknown" });
    expect(db.query("SELECT status,code FROM operation_receipts").get()).toEqual({ status: "unknown", code: "restore_reconciliation_required" });
    expect(db.query("SELECT id,state FROM push_deliveries ORDER BY id").all()).toEqual([
      { id: "accepted", state: "accepted" }, { id: "queued", state: "cancelled" }, { id: "retry", state: "cancelled" }, { id: "sending", state: "unknown" }, { id: "unknown", state: "unknown" },
    ]);
    expect(db.query("SELECT state FROM push_report_groups").get()).toEqual({ state: "cancelled" });
    expect(db.query("SELECT cancelled_at FROM push_report_group_recipients").get()).not.toEqual({ cancelled_at: null });
    const device = db.query<{ enabled: number; token: string | null; state: string; registration_generation: number }, []>("SELECT enabled,token,state,registration_generation FROM push_devices").get()!;
    expect(device.enabled).toBe(0);
    if (mode === "clone") {
      expect(result.serverId).not.toBe("server-original");
      expect(device).toMatchObject({ token: null, state: "revoked", registration_generation: 2 });
    } else {
      expect(result.serverId).toBe("server-original");
      expect(device).toMatchObject({ token: "fixture-token", state: "active", registration_generation: 1 });
    }
    const state = JSON.parse(db.query<{ value: string }, []>("SELECT value FROM settings WHERE key='restoreReconciliation'").get()!.value);
    expect(state).toMatchObject({ enabledProjects: ["p"], reconciliationRequired: true, outboundEnabled: false, mode });
    expect(f.db.query("SELECT enabled FROM push_devices").get()).toEqual({ enabled: 1 });
    expect(verifyRestoredHome(f.destination)).toEqual(result);
  });

  test("refuses source, related, occupied and owned destinations without overwriting files", () => {
    const f = fixture();
    const snapshot = f.backup();
    for (const destinationHome of [f.home, join(f.home, "other"), f.runtime.dir, snapshot.directory, join(snapshot.directory, "other")]) {
      expect(() => restoreBackup({ snapshotDir: snapshot.directory, destinationHome })).toThrow("separate");
    }
    fs.mkdirSync(f.destination);
    const sentinel = join(f.destination, "keep.txt");
    fs.writeFileSync(sentinel, "keep");
    expect(() => restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination })).toThrow("empty");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    fs.unlinkSync(sentinel);
    const owner = acquireHomeOwner(f.destination);
    try { expect(() => restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination })).toThrow("사용 중"); }
    finally { owner.release(); }
  });

  test("failed restore publishes nothing, releases owner and succeeds after correction", () => {
    const f = fixture();
    const snapshot = f.backup();
    const spy = spyOn(fs, "writeSync").mockImplementation(() => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); });
    try { expect(() => restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination })).toThrow("storage_full"); }
    finally { spy.mockRestore(); }
    expect(fs.readdirSync(f.destination)).toEqual([".owner.lock"]);
    expect(restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination }).outboundEnabled).toBe(false);
  });

  test("a publish failure rolls back only this restore's files and keeps the lock inode", () => {
    const f = fixture();
    const snapshot = f.backup();
    const original = fs.renameSync;
    let renames = 0;
    const spy = spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (++renames === 3) throw Object.assign(new Error("fixture publish failure"), { code: "EIO" });
      original(source, target);
    });
    try { expect(() => restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination })).toThrow("storage_io"); }
    finally { spy.mockRestore(); }
    const inode = fs.statSync(join(f.destination, ".owner.lock")).ino;
    expect(fs.readdirSync(f.destination)).toEqual([".owner.lock"]);
    restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination });
    expect(fs.statSync(join(f.destination, ".owner.lock")).ino).toBe(inode);
  });

  test("restore rejects damaged package first, and restored attachment damage is detected", () => {
    const f = fixture();
    const snapshot = f.backup();
    const sourcePath = join(snapshot.directory, snapshot.manifest.attachments[0].path);
    fs.writeFileSync(sourcePath, "변조");
    expect(() => restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination })).toThrow("hash mismatch");
    expect(fs.existsSync(f.destination)).toBe(false);
    fs.writeFileSync(sourcePath, "원본");
    restoreBackup({ snapshotDir: snapshot.directory, destinationHome: f.destination });
    fs.writeFileSync(join(f.destination, "uploads", "0.bin"), "변조");
    expect(() => verifyRestoredHome(f.destination)).toThrow("hash mismatch");
  });
});

describe("backup cadence, overlap and retention", () => {
  test("one daily success persists across restarts; concurrent managers share one operation", async () => {
    const f = fixture();
    let now = new Date(at);
    const options = { home: f.home, backupDir: f.root, now: () => now };
    const manager = new BackupManager(options);
    expect(manager.policy).toEqual(DEFAULT_BACKUP_POLICY);
    const first = manager.run();
    expect(manager.run(true)).toBe(first);
    expect(new BackupManager(options).run()).toBe(first);
    expect((await first)?.manifest.createdAt).toBe(at);
    expect(await new BackupManager(options).run()).toBeNull();
    now = new Date("2026-11-07T23:59:59.999Z");
    expect(await manager.run()).toBeNull();
    now = new Date("2026-11-08T00:00:00.000Z");
    expect((await manager.run())?.manifest.createdAt).toBe(now.toISOString());
    expect(listBackups(f.root)).toHaveLength(2);
    await manager.stop();
  });

  test("failed snapshots do not postpone retry or prune the last success", async () => {
    const f = fixture();
    const first = f.backup();
    const manager = new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date("2026-11-08T00:00:00.000Z") });
    fs.unlinkSync(f.path);
    await expect(manager.run()).rejects.toThrow();
    expect(manager.lastError).not.toBeNull();
    expect(listBackups(f.root).map((snapshot) => snapshot.manifest.id)).toEqual([first.manifest.id]);
    fs.writeFileSync(f.path, "원본");
    expect(await manager.run()).not.toBeNull();
    expect(manager.lastError).toBeNull();
  });

  test("retains latest seven daily/four weekly representatives, never deletes invalid or unrelated data", () => {
    const f = fixture();
    const snapshots: BackupSnapshot[] = [];
    for (let day = 1; day <= 35; day++) {
      const date = new Date("2026-10-01T00:00:00.000Z");
      date.setUTCDate(day);
      snapshots.push(f.backup(date.toISOString()));
    }
    const damaged = f.backup("2026-11-06T00:00:00.000Z");
    fs.writeFileSync(join(damaged.directory, "manifest.json"), "broken");
    fs.mkdirSync(join(f.root, ".pending-unrelated"));
    fs.writeFileSync(join(f.root, "keep.txt"), "keep");
    const removed = pruneBackups(f.root);
    const retained = listBackups(f.root);
    expect(removed.length + retained.length).toBe(snapshots.length);
    const dates = retained.map((snapshot) => snapshot.manifest.createdAt.slice(0, 10));
    for (const date of ["2026-11-04", "2026-11-03", "2026-11-02", "2026-11-01", "2026-10-31", "2026-10-30", "2026-10-29", "2026-10-25", "2026-10-18"]) expect(dates).toContain(date);
    expect(retained).toHaveLength(9);
    expect(fs.existsSync(damaged.directory)).toBe(true);
    expect(fs.existsSync(join(f.root, ".pending-unrelated"))).toBe(true);
    expect(fs.readFileSync(join(f.root, "keep.txt"), "utf8")).toBe("keep");
    expect(pruneBackups(f.root)).toEqual([]);
  });
});
