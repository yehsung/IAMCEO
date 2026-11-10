import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { VERSION } from "./config.ts";
import { MIGRATIONS } from "./db.ts";
import { normalizeHome, withHomeOwner } from "./home-owner.ts";
import { toStorageError } from "./storage-errors.ts";
import type { LoopMonitor } from "./loop-monitor.ts";

export interface BackupPolicy { intervalMs: number; daily: number; weekly: number }
export const DEFAULT_BACKUP_POLICY: Readonly<BackupPolicy> = Object.freeze({ intervalMs: 86_400_000, daily: 7, weekly: 4 });

const digestSchema = z.object({ size: z.number().int().nonnegative().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const manifestSchema = z.object({
  format: z.literal(1), id: z.string().regex(/^snapshot-\d{13}-[a-f0-9-]{36}$/),
  createdAt: z.iso.datetime({ precision: 3 }), applicationVersion: z.string().min(1),
  sourceHome: z.string().refine(isAbsolute), schemaVersion: z.number().int().min(1).max(MIGRATIONS.length),
  sourceHomeAliases: z.array(z.string().refine(isAbsolute)).default([]),
  database: digestSchema.extend({ path: z.literal("iamceo.db") }),
  configs: z.array(digestSchema.extend({ path: z.enum(["config.json", "apns.json"]) })).min(1).max(2),
  attachments: z.array(digestSchema.extend({ id: z.string().min(1), sourcePath: z.string().refine(isAbsolute), path: z.string().regex(/^attachments\/\d+\.bin$/) })),
  externalSecrets: z.object({ apnsP8: z.literal("separate_backup_required_not_included") }).strict(),
  verification: z.object({ integrity: z.literal("ok"), foreignKeys: z.literal("ok"), attachments: z.literal("ok") }).strict(),
}).strict();

export type BackupManifest = z.infer<typeof manifestSchema>;
export interface BackupSnapshot { directory: string; manifest: BackupManifest }
export interface BackupOptions { home: string; backupDir: string; now?: Date }

/** Reject symlink components and escapes before opening an attachment or package member. */
export function backupPath(root: string, path: string): string {
  root = resolve(root);
  path = resolve(path);
  const tail = relative(root, path);
  if (!tail || tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new Error("Backup path escapes its root");
  let current = root;
  if (!lstatSync(current).isDirectory()) throw new Error("Backup root must be a real directory");
  for (const part of tail.split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("Backup symlink refused");
  }
  return path;
}

/** Bounded memory, independent file copies, no hard links to mutable uploads. */
export function backupFile(source: string, destination?: string): { size: number; sha256: string } {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: number | undefined;
  try {
    const before = fstatSync(input);
    if (!before.isFile()) throw new Error("Backup input must be a regular file");
    if (destination) output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (let count; (count = readSync(input, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, count));
      if (output !== undefined) {
        let offset = 0;
        while (offset < count) {
          const written = writeSync(output, buffer, offset, count - offset);
          if (!written) throw new Error("Backup short write");
          offset += written;
        }
      }
      size += count;
    }
    const after = fstatSync(input);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Backup input changed during copy");
    if (output !== undefined) fsyncSync(output);
    return { size, sha256: hash.digest("hex") };
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

export function syncBackupDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Metadata is untrusted input too: never block on a FIFO or read an unbounded file. */
export function readBackupJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid backup metadata file");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

export function checkBackupDatabase(db: Database): number {
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  if (version < 1 || version > MIGRATIONS.length) throw new Error("Unsupported backup DB schema");
  const checks = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
  if (checks.length !== 1 || checks[0].integrity_check !== "ok") throw new Error("Backup DB integrity check failed");
  if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Backup DB foreign key check failed");
  return version;
}

function attachmentRows(db: Database) {
  return db.query<{ id: string; name: string; size: number; path: string }, []>("SELECT id,name,size,path FROM attachments ORDER BY id COLLATE BINARY").all();
}

function checkConfig(path: string): void {
  const value = readBackupJson(path);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid backup config");
  // Credentials must remain path references; never package an inline private key.
  if (/-----BEGIN .*PRIVATE KEY-----/.test(JSON.stringify(value))) throw new Error("Inline private key refused");
  if (path.endsWith(`${sep}config.json`) && !z.object({ accessCode: z.string().min(1) }).safeParse(value).success) throw new Error("Missing backup access code");
}

/** Fully verify candidates without migration, recovery, network, or source-home access. */
export function verifyBackup(directory: string): BackupSnapshot {
  directory = normalizeHome(directory);
  if (["-wal", "-shm", "-journal"].some((suffix) => existsSync(join(directory, `iamceo.db${suffix}`)))) throw new Error("Backup DB must be standalone without sidecars");
  const manifestPath = backupPath(directory, join(directory, "manifest.json"));
  // An invalid manifest must not direct reads to arbitrary paths or p8 files.
  const manifest = manifestSchema.parse(readBackupJson(manifestPath));
  if (new Date(manifest.createdAt).toISOString() !== manifest.createdAt) throw new Error("Invalid snapshot time");
  if (new Set(manifest.configs.map((entry) => entry.path)).size !== manifest.configs.length || !manifest.configs.some((entry) => entry.path === "config.json")) throw new Error("Invalid config inventory");
  if (new Set(manifest.attachments.map((entry) => entry.id)).size !== manifest.attachments.length || new Set(manifest.attachments.map((entry) => entry.path)).size !== manifest.attachments.length) throw new Error("Duplicate backup attachment");
  for (const entry of [manifest.database, ...manifest.configs, ...manifest.attachments]) {
    const actual = backupFile(backupPath(directory, join(directory, entry.path)));
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error("Backup size/hash mismatch");
  }
  for (const config of manifest.configs) checkConfig(join(directory, config.path));
  const db = new Database(join(directory, manifest.database.path), { readonly: true });
  try {
    if (checkBackupDatabase(db) !== manifest.schemaVersion) throw new Error("Backup schema mismatch");
    const rows = attachmentRows(db);
    if (rows.length !== manifest.attachments.length) throw new Error("Backup attachment inventory mismatch");
    const entries = new Map(manifest.attachments.map((entry) => [entry.id, entry]));
    for (const row of rows) {
      const entry = entries.get(row.id);
      if (!entry || entry.sourcePath !== row.path || entry.size !== row.size || /\.p8$/i.test(row.name) || /\.p8$/i.test(row.path)) throw new Error("Backup attachment metadata mismatch");
      if (![manifest.sourceHome, ...manifest.sourceHomeAliases].some((home) => {
        const tail = relative(join(home, "uploads"), row.path);
        return tail && tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
      })) throw new Error("Invalid source attachment path");
    }
    for (const [table, column] of [["messages", "attachments"], ["files", "attachments"], ["decisions", "images"]]) {
      for (const row of db.query<{ value: string }, []>(`SELECT ${column} AS value FROM ${table}`).all()) {
        const refs = z.array(z.object({ id: z.string(), path: z.string() })).parse(JSON.parse(row.value));
        if (refs.some((ref) => !entries.has(ref.id))) throw new Error("Backup record references a missing attachment");
      }
    }
  } finally { db.close(); }
  return { directory, manifest };
}

/** Caller may hold the daemon's home owner; all I/O is synchronous within that owner. */
export function createBackup(options: BackupOptions): BackupSnapshot {
  try {
    return withHomeOwner(options.home, (home) => {
      const root = normalizeHome(options.backupDir);
      if (root === home || home.startsWith(root + sep) || root.startsWith(join(home, "uploads") + sep) || root === join(home, "uploads")) throw new Error("Unsafe backup directory");
      return withHomeOwner(root, () => {
        const now = options.now ?? new Date();
        const createdAt = now.toISOString();
        const id = `snapshot-${String(now.getTime()).padStart(13, "0")}-${randomUUID()}`;
        if (!/^snapshot-\d{13}-/.test(id)) throw new Error("Unsupported snapshot time");
        const stage = join(root, `.pending-${randomUUID()}`);
        mkdirSync(stage, { mode: 0o700 });
        let published: string | undefined;
        try {
          mkdirSync(join(stage, "attachments"), { mode: 0o700 });
          const source = new Database(backupPath(home, join(home, "iamceo.db")), { readonly: true });
          try {
            checkBackupDatabase(source);
            source.exec("PRAGMA busy_timeout = 5000");
            source.query("VACUUM INTO ?").run(join(stage, "iamceo.db"));
          } finally { source.close(); }
          chmodSync(join(stage, "iamceo.db"), 0o600);
          const db = new Database(join(stage, "iamceo.db"), { readonly: true });
          let schemaVersion: number;
          const attachments: BackupManifest["attachments"] = [];
          try {
            schemaVersion = checkBackupDatabase(db);
            for (const [index, row] of attachmentRows(db).entries()) {
              if (/\.p8$/i.test(row.name) || /\.p8$/i.test(row.path)) throw new Error("p8 cannot be included in backups");
              // Config keeps IAMCEO_HOME's spelling; only the home itself may be an alias.
              const aliases = [home, resolve(options.home)];
              const root = aliases.find((alias) => {
                const tail = relative(join(alias, "uploads"), row.path);
                return tail && tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
              });
              if (!root) throw new Error("Backup attachment escapes uploads");
              const sourcePath = backupPath(join(home, "uploads"), join(home, relative(root, row.path)));
              const path = `attachments/${index}.bin`;
              const copied = backupFile(sourcePath, join(stage, path));
              if (copied.size !== row.size) throw new Error("Backup attachment size mismatch");
              attachments.push({ id: row.id, sourcePath: row.path, path, ...copied });
            }
          } finally { db.close(); }
          const configs: BackupManifest["configs"] = [];
          for (const path of ["config.json", "apns.json"] as const) {
            if (path === "apns.json" && !existsSync(join(home, path))) continue;
            const copied = backupFile(backupPath(home, join(home, path)), join(stage, path));
            checkConfig(join(stage, path));
            configs.push({ path, ...copied });
          }
          const manifest: BackupManifest = {
            format: 1, id, createdAt, applicationVersion: VERSION, sourceHome: home,
            sourceHomeAliases: home === resolve(options.home) ? [] : [resolve(options.home)], schemaVersion,
            database: { path: "iamceo.db", ...backupFile(join(stage, "iamceo.db")) }, configs, attachments,
            externalSecrets: { apnsP8: "separate_backup_required_not_included" },
            verification: { integrity: "ok", foreignKeys: "ok", attachments: "ok" },
          };
          writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          verifyBackup(stage);
          for (const path of ["iamceo.db", "manifest.json"]) {
            const fd = openSync(join(stage, path), constants.O_RDONLY | constants.O_NOFOLLOW);
            try { fsyncSync(fd); } finally { closeSync(fd); }
          }
          syncBackupDirectory(join(stage, "attachments"));
          syncBackupDirectory(stage);
          const directory = join(root, id);
          renameSync(stage, directory);
          published = directory;
          syncBackupDirectory(root);
          return { directory, manifest };
        } catch (error) {
          if (published) rmSync(published, { recursive: true });
          throw error;
        } finally {
          if (existsSync(stage)) rmSync(stage, { recursive: true });
        }
      });
    });
  } catch (error) { throw toStorageError(error, "백업 실패"); }
}

/** Invalid/incomplete candidates are never advertised as successful snapshots. */
export function listBackups(backupDir: string): BackupSnapshot[] {
  const root = normalizeHome(backupDir);
  if (!existsSync(root)) return [];
  const snapshots: BackupSnapshot[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^snapshot-\d{13}-[a-f0-9-]{36}$/.test(entry.name)) continue;
    try {
      const snapshot = verifyBackup(join(root, entry.name));
      if (snapshot.manifest.id === entry.name) snapshots.push(snapshot);
    } catch { /* Keep damaged candidates for diagnosis; they cannot suppress a new backup. */ }
  }
  return snapshots.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt) || b.manifest.id.localeCompare(a.manifest.id));
}

function policyValue(policy: Partial<BackupPolicy>): BackupPolicy {
  return z.object({ intervalMs: z.number().int().positive().safe(), daily: z.number().int().positive().safe(), weekly: z.number().int().nonnegative().safe() }).parse({ ...DEFAULT_BACKUP_POLICY, ...policy });
}

/** Latest snapshot per UTC day/week; overlapping daily/weekly representatives count once. */
export function pruneBackups(backupDir: string, policy: Partial<BackupPolicy> = {}): string[] {
  const { daily, weekly } = policyValue(policy);
  return withHomeOwner(backupDir, (root) => {
    const snapshots = listBackups(root);
    const homes = new Map<string, { days: Set<string>; weeks: Set<string> }>();
    const removed: string[] = [];
    for (const snapshot of snapshots) {
      // A shared backup volume must not let one home's snapshots evict another's.
      let buckets = homes.get(snapshot.manifest.sourceHome);
      if (!buckets) { buckets = { days: new Set(), weeks: new Set() }; homes.set(snapshot.manifest.sourceHome, buckets); }
      const { days, weeks } = buckets;
      const day = snapshot.manifest.createdAt.slice(0, 10);
      const date = new Date(snapshot.manifest.createdAt);
      date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      const week = date.toISOString().slice(0, 10);
      const keepDay = !days.has(day) && days.size < daily;
      const keepWeek = !weeks.has(week) && weeks.size < weekly;
      days.add(day);
      weeks.add(week);
      if (keepDay || keepWeek) continue;
      // Recheck immediately before deleting; never traverse unrelated directories.
      verifyBackup(snapshot.directory);
      rmSync(backupPath(root, snapshot.directory), { recursive: true });
      removed.push(snapshot.directory);
    }
    syncBackupDirectory(root);
    return removed;
  });
}

const pending = new Map<string, Promise<BackupSnapshot | null>>();

/** W6 runtime owns start/stop. Construction has no timers, network or implicit home. */
export class BackupManager {
  readonly policy: Readonly<BackupPolicy>;
  lastError: Error | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private lastSuccessAt?: number;
  constructor(readonly options: { home: string; backupDir: string; policy?: Partial<BackupPolicy>; now?: () => Date; loopMonitor?: LoopMonitor }) {
    this.policy = Object.freeze(policyValue(options.policy ?? {}));
  }
  run(force = false): Promise<BackupSnapshot | null> {
    // One in-flight operation per source home, even across manager instances/aliases.
    const key = normalizeHome(this.options.home);
    const existing = pending.get(key);
    if (existing) return existing;
    const run = () => {
      const now = this.options.now?.() ?? new Date();
      if (this.lastSuccessAt === undefined) {
        const last = listBackups(this.options.backupDir).find((snapshot) => snapshot.manifest.sourceHome === key);
        if (last) this.lastSuccessAt = Date.parse(last.manifest.createdAt);
      }
      // Revalidate persisted packages on restart/daily work, not on every timer tick.
      if (!force && this.lastSuccessAt !== undefined && now.getTime() - this.lastSuccessAt < this.policy.intervalMs) return null;
      const snapshot = createBackup({ ...this.options, now });
      pruneBackups(this.options.backupDir, this.policy);
      this.lastSuccessAt = Date.parse(snapshot.manifest.createdAt);
      this.lastError = null;
      return snapshot;
    };
    const job = Promise.resolve().then(() => this.options.loopMonitor ? this.options.loopMonitor.run("timer:backup", run) : run())
      .catch((error) => { this.lastError = toStorageError(error, "정기 백업 실패"); throw this.lastError; })
      .finally(() => { pending.delete(key); });
    pending.set(key, job);
    return job;
  }
  start(): void {
    if (this.timer) return;
    const tick = () => { void this.run().catch(() => { /* lastError is exposed to runtime diagnostics. */ }); };
    tick();
    this.timer = setInterval(tick, Math.min(this.policy.intervalMs, 60_000));
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await pending.get(normalizeHome(this.options.home));
  }
}
