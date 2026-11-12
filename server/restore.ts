import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { backupFile, backupPath, checkBackupDatabase, readBackupJson, syncBackupDirectory, verifyBackup } from "./backup.ts";
import type { BackupManifest } from "./backup.ts";
import { openDb } from "./db.ts";
import { generateAccessCode } from "./config.ts";
import { revokeAllDeviceKeys } from "./devices.ts";
import { acquireHomeOwner, normalizeHome } from "./home-owner.ts";
import { toStorageError } from "./storage-errors.ts";

export interface RestoreOptions { snapshotDir: string; destinationHome: string; mode?: "same-host" | "clone"; now?: Date }
export interface RestoreResult { home: string; snapshotId: string; serverId: string | null; reconciliationRequired: true; outboundEnabled: false }

const stateSchema = z.object({
  format: z.literal(1), snapshotId: z.string(), restoredAt: z.iso.datetime({ precision: 3 }),
  destinationHome: z.string().refine(isAbsolute),
  mode: z.enum(["same-host", "clone"]), reconciliationRequired: z.literal(true), outboundEnabled: z.literal(false),
  serverId: z.string().nullable(),
  files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
}).strict();

const reconciliationSchema = z.object({
  snapshotId: z.string(), restoredAt: z.iso.datetime({ precision: 3 }), mode: z.enum(["same-host", "clone"]),
  reconciliationRequired: z.boolean(), outboundEnabled: z.boolean(), enabledProjects: z.array(z.string()),
  reconciledAt: z.iso.datetime({ precision: 3 }).optional(), resumedAt: z.iso.datetime({ precision: 3 }).optional(),
}).passthrough().refine((state) => state.reconciliationRequired
  ? !state.outboundEnabled && !state.reconciledAt && !state.resumedAt
  : !!state.reconciledAt && (state.outboundEnabled ? !!state.resumedAt : !state.resumedAt), "Invalid restore transition");

export interface RestoreOperationResult { home: string; snapshotId: string; reconciliationRequired: false; outboundEnabled: boolean }

function reconciliationState(db: Database) {
  const row = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key='restoreReconciliation'").get();
  return row ? reconciliationSchema.parse(JSON.parse(row.value)) : null;
}

/** The daemon must check this before constructing runners, HTTP ingress or APNs. */
export function requireRestoreOutboundEnabled(db: Database, home: string): void {
  const state = reconciliationState(db);
  if (!state && existsSync(join(home, "restore-state.json"))) throw new Error("Missing restored reconciliation fence");
  if (state && !state.outboundEnabled) throw new Error("복원 발신 꺼짐: 서버를 끈 상태에서 iamceo restore reconcile 후 iamceo restore resume 을 실행하세요");
}

function withRestoredHome<T>(home: string, action: (db: Database, state: z.infer<typeof reconciliationSchema>, home: string) => T): T {
  home = normalizeHome(home);
  // Refuse absent/unrelated homes rather than creating a new database or config.
  backupPath(home, join(home, "iamceo.db"));
  using owner = acquireHomeOwner(home);
  const manifest = stateSchema.parse(readBackupJson(backupPath(home, join(home, "restore-state.json"))));
  if (manifest.destinationHome !== home) throw new Error("Restored home identity mismatch");
  const db = new Database(backupPath(home, join(home, "iamceo.db")), { readwrite: true });
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL");
    checkBackupDatabase(db);
    return db.transaction(() => {
      const state = reconciliationState(db);
      if (!state || state.snapshotId !== manifest.snapshotId || state.mode !== manifest.mode || state.restoredAt !== manifest.restoredAt) throw new Error("Missing restored reconciliation fence");
      if (!state.outboundEnabled && (db.query<{ server_id: string }, []>("SELECT server_id FROM push_meta WHERE id=1").get()?.server_id ?? null) !== manifest.serverId) throw new Error("Restored server identity mismatch");
      return action(db, state, home);
    }).immediate();
  } finally { db.close(); }
}

/** Offline reconciliation is conservative: retain receipt/lease/wire evidence and never replay uncertain work. */
export function reconcileRestoredHome(home: string, now = new Date()): RestoreOperationResult {
  return withRestoredHome(home, (db, state, home) => {
    if (state.outboundEnabled) throw new Error("이미 재개된 복원본은 다시 조정할 수 없습니다");
    const at = now.toISOString();
    quarantineOutbound(db, at);
    db.query("UPDATE settings SET value=? WHERE key='restoreReconciliation'").run(JSON.stringify({
      ...state, reconciliationRequired: false, reconciledAt: at,
    }));
    return { home, snapshotId: state.snapshotId, reconciliationRequired: false, outboundEnabled: false };
  });
}

/** Requires an exclusive, stopped home; pending restored work and push registrations stay quarantined. */
export function resumeRestoredHome(home: string, now = new Date()): RestoreOperationResult {
  return withRestoredHome(home, (db, state, home) => {
    if (state.reconciliationRequired) throw new Error("복원 조정이 끝나지 않았습니다. iamceo restore reconcile 을 먼저 실행하세요");
    if (!state.outboundEnabled) {
      if (db.query(`SELECT 1 FROM projects WHERE runner_enabled != 0
        UNION ALL SELECT 1 FROM deliveries WHERE status IN ('queued','delivering','failed')
        UNION ALL SELECT 1 FROM push_devices WHERE enabled != 0
        UNION ALL SELECT 1 FROM push_deliveries WHERE state IN ('queued','retry','sending')
        UNION ALL SELECT 1 FROM push_report_groups WHERE state='open'
        UNION ALL SELECT 1 FROM operation_receipts WHERE status='pending'
        UNION ALL SELECT 1 FROM lifecycle_journal WHERE phase IN ('prepared','started')
        UNION ALL SELECT 1 FROM execution_journal WHERE phase IN ('received','starting','running') LIMIT 1`).get()) {
        throw new Error("복원 조정 이후 발신 상태가 바뀌었습니다. 재개를 거부합니다");
      }
      for (const id of state.enabledProjects) db.query("UPDATE projects SET runner_enabled=1 WHERE id=? AND archived=0").run(id);
      db.query("UPDATE settings SET value=? WHERE key='restoreReconciliation'").run(JSON.stringify({
        ...state, outboundEnabled: true, resumedAt: now.toISOString(),
      }));
    }
    return { home, snapshotId: state.snapshotId, reconciliationRequired: false, outboundEnabled: true };
  });
}

function relocatePath(path: string, source: string, destination: string): string {
  if (!isAbsolute(path)) return path;
  const tail = relative(source, path);
  return tail === "" ? destination : tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail) ? join(destination, tail) : path;
}

function relocateAttachments(db: Database, manifest: BackupManifest, destination: string): void {
  const relocate = (path: string) => {
    for (const source of [manifest.sourceHome, ...manifest.sourceHomeAliases]) {
      const relocated = relocatePath(path, source, destination);
      if (relocated !== path) return relocated;
    }
    return path;
  };
  const paths = new Map(manifest.attachments.map((entry) => [entry.id, join(destination, "uploads", entry.path.slice("attachments/".length))]));
  for (const [id, path] of paths) db.query("UPDATE attachments SET path = ? WHERE id = ?").run(path, id);
  // These columns store full Attachment objects, including their absolute path.
  for (const [table, column] of [["messages", "attachments"], ["files", "attachments"], ["decisions", "images"]]) {
    for (const row of db.query<{ id: string; value: string }, []>(`SELECT id, ${column} AS value FROM ${table}`).all()) {
      const entries = z.array(z.object({ id: z.string(), path: z.string() }).passthrough()).parse(JSON.parse(row.value));
      const value = entries.map((entry) => {
        const path = paths.get(entry.id);
        if (!path) throw new Error("Restored record references a missing attachment");
        return { ...entry, path };
      });
      db.query(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(JSON.stringify(value), row.id);
    }
  }
  // Project working directories may also live inside IAMCEO_HOME. External cwd
  // and native session identities remain references, never copied or executed.
  for (const table of ["projects", "members"]) {
    for (const row of db.query<{ id: string; cwd: string }, []>(`SELECT id,cwd FROM ${table}`).all()) {
      db.query(`UPDATE ${table} SET cwd = ? WHERE id = ?`).run(relocate(row.cwd), row.id);
    }
  }
  for (const row of db.query<{ id: string; path: string }, []>("SELECT id,path FROM files WHERE path IS NOT NULL").all()) {
    const entry = manifest.attachments.find((entry) => entry.sourcePath === row.path);
    db.query("UPDATE files SET path = ? WHERE id = ?").run(entry ? paths.get(entry.id)! : relocate(row.path), row.id);
  }
}

/** This changes only the restored copy. It does not infer delivery from elapsed time. */
function quarantineOutbound(db: Database, at: string): void {
  db.query("UPDATE projects SET runner_enabled = 0").run();
  db.query(`UPDATE deliveries SET status='held', hold_reason='delivery_unknown', next_attempt_at=NULL,
    last_error='restore_reconciliation_required' WHERE status IN ('queued','held','delivering','failed')`).run();
  db.query(`INSERT INTO delivery_recovery (delivery_id,phase,reason,updated_at)
    SELECT id,'stopped','restore_reconciliation_required',? FROM deliveries WHERE status='held'
    ON CONFLICT(delivery_id) DO UPDATE SET phase='stopped',reason='restore_reconciliation_required',
    version=version+1,next_check_at=NULL,updated_at=excluded.updated_at`).run(at);
  db.query("UPDATE messages SET delivery='held',delivery_note='복원 후 수신 증거 조정 대기' WHERE delivery IN ('queued','held','failed')").run();
  // Preserve wire_text/hash, native IDs, baselines, leases, and receipts as evidence.
  db.query("UPDATE lifecycle_journal SET phase='unknown',reason='restore_reconciliation_required',updated_at=? WHERE phase IN ('prepared','started')").run(at);
  db.query("UPDATE execution_journal SET phase='unknown',reason='restore_reconciliation_required',updated_at=? WHERE phase IN ('received','starting','running')").run(at);
  db.query(`UPDATE operation_receipts SET status='unknown',code='restore_reconciliation_required',
    error='복원 후 외부 효과 확인 필요',updated_at=? WHERE status='pending'`).run(at);
  db.query("UPDATE push_devices SET enabled=0,revision=revision+1").run();
  db.query(`UPDATE push_deliveries SET state=CASE WHEN state='sending' THEN 'unknown' ELSE 'cancelled' END,
    lease_until=NULL,finished_at=? WHERE state IN ('queued','retry','sending')`).run(at);
  db.query("UPDATE push_report_groups SET state='cancelled',closed_at=? WHERE state='open'").run(at);
  db.query("UPDATE push_report_group_recipients SET cancelled_at=? WHERE cancelled_at IS NULL").run(at);
}

function quarantine(db: Database, manifest: BackupManifest, mode: "same-host" | "clone", at: string): string | null {
  const enabledProjects = db.query<{ id: string }, []>("SELECT id FROM projects WHERE runner_enabled = 1").all().map((row) => row.id);
  quarantineOutbound(db, at);
  if (mode === "clone") {
    db.query(`INSERT INTO push_meta (id,server_id,created_at) VALUES (1,?,?)
      ON CONFLICT(id) DO UPDATE SET server_id=excluded.server_id`).run(randomUUID(), at);
    db.query(`UPDATE push_devices SET enabled=0,token=NULL,state='revoked',revoked_at=?,
      registration_generation=registration_generation+1`).run(at);
    // G(C3): 복제본은 원본 Mac 에 붙어 있던 기기의 열쇠를 받아들이지 않는다(공용 접속 코드도 새로 만든다: restoreBackup).
    revokeAllDeviceKeys(db, at, "clone");
  }
  const serverId = db.query<{ server_id: string }, []>("SELECT server_id FROM push_meta WHERE id=1").get()?.server_id ?? null;
  db.query("INSERT OR REPLACE INTO settings (key,value) VALUES ('restoreReconciliation',?)").run(JSON.stringify({
    snapshotId: manifest.id, restoredAt: at, mode, reconciliationRequired: true, outboundEnabled: false,
    enabledProjects, sourceHome: manifest.sourceHome, externalSecrets: manifest.externalSecrets,
  }));
  return serverId;
}

/** Anything but the home lock file counts as data. A missing folder has none. */
function hasData(home: string): boolean {
  return existsSync(home) && readdirSync(home).some((name) => name !== ".owner.lock");
}

/** Restores into a missing or empty home only. Never replaces an installed DB or starts a worker. */
export function restoreBackup(options: RestoreOptions): RestoreResult {
  const mode = z.enum(["same-host", "clone"]).parse(options.mode ?? "same-host");
  const at = (options.now ?? new Date()).toISOString();
  const snapshot = verifyBackup(options.snapshotDir);
  const destination = normalizeHome(options.destinationHome);
  const source = snapshot.manifest.sourceHome;
  // The backup's own path is allowed: a new Mac with the same user name restores into the same ~/.iamceo.
  // A live home is still never overwritten: the destination must be missing or empty (below), and a running
  // server holds the home lock, so acquireHomeOwner refuses. Paths nested in or around either home stay refused.
  if (destination.startsWith(source + sep) || source.startsWith(destination + sep) ||
      destination === snapshot.directory || destination.startsWith(snapshot.directory + sep) || snapshot.directory.startsWith(destination + sep)) throw new Error("Restore requires a separate destination home");
  if (destination === source && hasData(destination)) throw new Error("Restore destination must be empty: the data folder this backup came from still has data and is never overwritten");
  // Deliberately do not borrow a daemon's existing owner during restoration.
  const owner = acquireHomeOwner(destination);
  const stage = join(destination, `.restore-${randomUUID()}`);
  const published: string[] = [];
  try {
    if (hasData(destination)) throw new Error("Restore destination must be empty");
    mkdirSync(stage, { mode: 0o700 });
    for (const dir of ["uploads", "inbox", "roles"]) mkdirSync(join(stage, dir), { mode: 0o700 });
    for (const entry of [snapshot.manifest.database, ...snapshot.manifest.configs, ...snapshot.manifest.attachments]) {
      const path = entry.path.startsWith("attachments/") ? join("uploads", entry.path.slice("attachments/".length)) : entry.path;
      const copied = backupFile(backupPath(snapshot.directory, join(snapshot.directory, entry.path)), join(stage, path));
      if (copied.size !== entry.size || copied.sha256 !== entry.sha256) throw new Error("Restore copy hash mismatch");
    }
    // Migrations are owned by db.ts and run only on this private, verified copy.
    const db = openDb(join(stage, "iamceo.db"));
    let serverId: string | null;
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
      db.transaction(() => {
        relocateAttachments(db, snapshot.manifest, destination);
        serverId = quarantine(db, snapshot.manifest, mode, at);
      })();
      checkBackupDatabase(db);
    } finally { db.close(); }
    for (const name of readdirSync(stage)) {
      if (/^iamceo\.db\.pre-v\d+-\d+-[a-f0-9]+\.bak$/.test(name)) rmSync(join(stage, name));
    }
    const configPath = join(stage, "config.json");
    const config = readBackupJson(configPath) as Record<string, unknown>;
    for (const key of ["claudeBin", "codexBin", "coreBin", "coreSocket"]) {
      if (typeof config[key] === "string") config[key] = relocatePath(config[key], snapshot.manifest.sourceHome, destination);
    }
    // G(C3): 복제본은 원본과 함께 쓰는 별개의 서버다. 원본의 공용 접속 코드로 붙은 기기가 복제본에도 붙지 않게 새 코드를 준다.
    // 같은 Mac 복원(same-host)은 코드와 기기 열쇠를 그대로 둔다(그 Mac 의 기기가 다시 연결하지 않아도 된다).
    if (mode === "clone") config.accessCode = generateAccessCode();
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    const files = ["iamceo.db", ...snapshot.manifest.configs.map((entry) => entry.path), ...snapshot.manifest.attachments.map((entry) => join("uploads", entry.path.slice("attachments/".length)))];
    const state = { format: 1, snapshotId: snapshot.manifest.id, restoredAt: at, mode, destinationHome: destination,
      reconciliationRequired: true, outboundEnabled: false, serverId: serverId!,
      files: files.map((path) => ({ path, ...backupFile(join(stage, path)) })),
    };
    writeFileSync(join(stage, "restore-state.json"), JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    verifyRestoredHome(stage);
    for (const path of [...files, "restore-state.json"]) {
      const fd = openSync(join(stage, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    syncBackupDirectory(join(stage, "uploads"));
    syncBackupDirectory(stage);
    for (const path of [...readdirSync(stage).filter((name) => name !== "restore-state.json"), "restore-state.json"]) {
      renameSync(join(stage, path), join(destination, path));
      published.push(join(destination, path));
    }
    syncBackupDirectory(destination);
    return { home: destination, snapshotId: snapshot.manifest.id, serverId: serverId!, reconciliationRequired: true, outboundEnabled: false };
  } catch (error) {
    // Only files created by this restore can be removed; pre-existing data is refused.
    for (const path of published.reverse()) rmSync(path, { recursive: true });
    throw toStorageError(error, "복원 실패");
  } finally {
    try { if (existsSync(stage)) rmSync(stage, { recursive: true }); }
    finally { owner.release(); }
  }
}

/** Verify immediately after restore, before any runtime opens/migrates the copy. */
export function verifyRestoredHome(home: string): RestoreResult {
  home = normalizeHome(home);
  const state = stateSchema.parse(readBackupJson(backupPath(home, join(home, "restore-state.json"))));
  if (!state.files.some((entry) => entry.path === "iamceo.db") || !state.files.some((entry) => entry.path === "config.json") || new Set(state.files.map((entry) => entry.path)).size !== state.files.length) throw new Error("Invalid restored inventory");
  for (const entry of state.files) {
    if (!["iamceo.db", "config.json", "apns.json"].includes(entry.path) && !/^uploads\/\d+\.bin$/.test(entry.path)) throw new Error("Invalid restored path");
    const actual = backupFile(backupPath(home, join(home, entry.path)));
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error("Restored size/hash mismatch");
  }
  const db = new Database(join(home, "iamceo.db"), { readonly: true });
  try {
    checkBackupDatabase(db);
    const reconciliation = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key='restoreReconciliation'").get();
    if (!reconciliation || !z.object({ snapshotId: z.literal(state.snapshotId), reconciliationRequired: z.literal(true), outboundEnabled: z.literal(false) }).safeParse(JSON.parse(reconciliation.value)).success) throw new Error("Missing restored reconciliation fence");
    if ((db.query<{ server_id: string }, []>("SELECT server_id FROM push_meta WHERE id=1").get()?.server_id ?? null) !== state.serverId) throw new Error("Restored server identity mismatch");
    const attachments = db.query<{ id: string; path: string; size: number }, []>("SELECT id,path,size FROM attachments").all();
    const paths = new Map<string, string>();
    for (const attachment of attachments) {
      const tail = relative(join(state.destinationHome, "uploads"), attachment.path);
      if (!/^\d+\.bin$/.test(tail)) throw new Error("Restored attachment path was not relocated");
      const entry = state.files.find((entry) => entry.path === `uploads/${tail}`);
      if (!entry || entry.size !== attachment.size) throw new Error("Restored attachment inventory mismatch");
      paths.set(attachment.id, attachment.path);
    }
    if (state.files.filter((entry) => entry.path.startsWith("uploads/")).length !== attachments.length) throw new Error("Restored attachment inventory mismatch");
    for (const [table, column] of [["messages", "attachments"], ["files", "attachments"], ["decisions", "images"]]) {
      for (const row of db.query<{ value: string }, []>(`SELECT ${column} AS value FROM ${table}`).all()) {
        const refs = z.array(z.object({ id: z.string(), path: z.string() })).parse(JSON.parse(row.value));
        if (refs.some((ref) => paths.get(ref.id) !== ref.path)) throw new Error("Restored embedded attachment path mismatch");
      }
    }
    if (db.query("SELECT 1 FROM projects WHERE runner_enabled != 0 LIMIT 1").get() ||
        db.query("SELECT 1 FROM deliveries WHERE status IN ('queued','delivering') LIMIT 1").get() ||
        db.query("SELECT 1 FROM push_devices WHERE enabled != 0 LIMIT 1").get() ||
        db.query("SELECT 1 FROM push_deliveries WHERE state IN ('queued','sending','retry') LIMIT 1").get() ||
        db.query("SELECT 1 FROM push_report_groups WHERE state='open' LIMIT 1").get()) throw new Error("Restored outbound work is not quarantined");
  } finally { db.close(); }
  return { home, snapshotId: state.snapshotId, serverId: state.serverId, reconciliationRequired: true, outboundEnabled: false };
}
