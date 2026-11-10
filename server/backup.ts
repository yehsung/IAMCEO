import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statfsSync, statSync, writeFileSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { VERSION } from "./config.ts";
import { MIGRATIONS } from "./db.ts";
import { acquireHomeOwner, HomeOwnershipError, normalizeHome, withHomeOwner } from "./home-owner.ts";
import { classifyStorageError, toStorageError } from "./storage-errors.ts";
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
export interface BackupOptions { home: string; backupDir: string; now?: Date; /** 시험용: 백업 폴더의 남은 바이트. */ freeBytes?: (root: string) => number }

/** Work with a yield point after each file or DB check. Synchronous callers drain it; the daemon's scheduled backup releases the event loop in between. */
type Steps<T> = Generator<void, T, void>;

function drain<T>(steps: Steps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

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
  return drain(verifySteps(directory));
}

function* verifySteps(directory: string): Steps<BackupSnapshot> {
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
    yield;
  }
  for (const config of manifest.configs) checkConfig(join(directory, config.path));
  const db = new Database(join(directory, manifest.database.path), { readonly: true });
  try {
    if (checkBackupDatabase(db) !== manifest.schemaVersion) throw new Error("Backup schema mismatch");
    yield;
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

const STALE_PENDING_MS = 3_600_000;

/** Only stages abandoned by a killed process. While the backup root is owned, no other backup can be in flight. */
function removeStalePending(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.pending-[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.name)) continue;
    try {
      const path = backupPath(root, join(root, entry.name));
      if (Date.now() - lstatSync(path).mtimeMs < STALE_PENDING_MS) continue;
      rmSync(path, { recursive: true });
    } catch { /* Retried by the next backup. */ }
  }
}

function backupRoot(home: string, backupDir: string): string {
  const root = normalizeHome(backupDir);
  if (root === home || home.startsWith(root + sep) || root.startsWith(join(home, "uploads") + sep) || root === join(home, "uploads")) throw new Error("Unsafe backup directory");
  return root;
}

/** Caller may hold the daemon's home owner; all I/O is synchronous within that owner. */
export function createBackup(options: BackupOptions): BackupSnapshot {
  try {
    return withHomeOwner(options.home, (home) => {
      const root = backupRoot(home, options.backupDir);
      return withHomeOwner(root, () => drain(createSteps(home, root, options)));
    });
  } catch (error) { throw toStorageError(error, "백업 실패"); }
}

/** 스냅샷 하나에는 DB 사본과 첨부 전체가 든다. 그 1.5배가 남아 있지 않으면 쓰기 전에 그만둔다. */
function requireBackupSpace(root: string, bytes: number, freeBytes?: (root: string) => number): void {
  let free: number;
  try { free = freeBytes ? freeBytes(root) : (() => { const disk = statfsSync(root); return Number(disk.bavail) * Number(disk.bsize); })(); }
  catch { return; } // 남은 공간을 알 수 없으면 예전처럼 진행한다.
  if (free < bytes * 1.5) throw Object.assign(new Error("Not enough free space for a backup snapshot"), { code: "ENOSPC" });
}

/** The caller owns both home and root for every step. */
function* createSteps(home: string, root: string, options: BackupOptions): Steps<BackupSnapshot> {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const id = `snapshot-${String(now.getTime()).padStart(13, "0")}-${randomUUID()}`;
  if (!/^snapshot-\d{13}-/.test(id)) throw new Error("Unsupported snapshot time");
  removeStalePending(root);
  const stage = join(root, `.pending-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  let published: string | undefined;
  try {
    mkdirSync(join(stage, "attachments"), { mode: 0o700 });
    const source = new Database(backupPath(home, join(home, "iamceo.db")), { readonly: true });
    try {
      // 공간이 모자란 채로 시작하면 수백 MB 를 썼다 지우기를 되풀이하고, 같은 디스크를 쓰는 다른 세션의 쓰기까지 실패시킨다.
      requireBackupSpace(root, statSync(join(home, "iamceo.db")).size + (source.query<{ total: number | null }, []>("SELECT SUM(size) AS total FROM attachments").get()?.total ?? 0), options.freeBytes);
      checkBackupDatabase(source);
      yield;
      source.exec("PRAGMA busy_timeout = 5000");
      source.query("VACUUM INTO ?").run(join(stage, "iamceo.db"));
    } finally { source.close(); }
    chmodSync(join(stage, "iamceo.db"), 0o600);
    yield;
    const db = new Database(join(stage, "iamceo.db"), { readonly: true });
    let schemaVersion: number;
    const attachments: BackupManifest["attachments"] = [];
    try {
      schemaVersion = checkBackupDatabase(db);
      yield;
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
        yield;
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
    yield;
    yield* verifySteps(stage);
    yield;
    // No yield from here until the snapshot is published.
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
}

const SNAPSHOT_NAME = /^snapshot-\d{13}-[a-f0-9-]{36}$/;
const newestFirst = (a: BackupSnapshot, b: BackupSnapshot) => b.manifest.createdAt.localeCompare(a.manifest.createdAt) || b.manifest.id.localeCompare(a.manifest.id);

/** Invalid/incomplete candidates are never advertised as successful snapshots. */
export function listBackups(backupDir: string): BackupSnapshot[] {
  return drain(listSteps(backupDir));
}

/** Snapshots this process has fully verified (directory → manifest file identity). Published snapshots are immutable. */
type Verified = Map<string, string>;

function manifestStamp(directory: string): string | null {
  try {
    const stat = lstatSync(join(directory, "manifest.json"));
    return stat.isFile() ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : null;
  } catch { return null; }
}

function remember(verified: Verified, directory: string): void {
  const stamp = manifestStamp(directory);
  if (stamp) verified.set(directory, stamp);
}

/** Manifest only, no hashing. Use it only for ordering or for snapshots verified elsewhere. */
function readCandidate(directory: string, name: string): BackupSnapshot {
  directory = normalizeHome(directory);
  const manifest = manifestSchema.parse(readBackupJson(backupPath(directory, join(directory, "manifest.json"))));
  if (manifest.id !== name) throw new Error("Backup identity mismatch");
  return { directory, manifest };
}

function* listSteps(backupDir: string, verified?: Verified): Steps<BackupSnapshot[]> {
  const root = normalizeHome(backupDir);
  if (!existsSync(root)) return [];
  const snapshots: BackupSnapshot[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SNAPSHOT_NAME.test(entry.name)) continue;
    try {
      const directory = join(root, entry.name);
      const known = verified?.get(directory);
      if (known !== undefined && known === manifestStamp(directory)) {
        // Do not re-hash every retained snapshot each day. Deletion and restore always verify in full.
        snapshots.push(readCandidate(directory, entry.name));
        continue;
      }
      const snapshot = yield* verifySteps(directory);
      if (snapshot.manifest.id !== entry.name) continue;
      snapshots.push(snapshot);
      if (verified) remember(verified, snapshot.directory);
    } catch { /* Keep damaged candidates for diagnosis; they cannot suppress a new backup. */ }
    yield;
  }
  return snapshots.sort(newestFirst);
}

/** Candidates by name and manifest only, newest first. */
function backupCandidates(backupDir: string): BackupSnapshot[] {
  const root = normalizeHome(backupDir);
  if (!existsSync(root)) return [];
  const candidates: BackupSnapshot[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SNAPSHOT_NAME.test(entry.name)) continue;
    try { candidates.push(readCandidate(join(root, entry.name), entry.name)); }
    catch { /* An unreadable candidate is never counted as a successful backup. */ }
  }
  return candidates.sort(newestFirst);
}

function policyValue(policy: Partial<BackupPolicy>): BackupPolicy {
  return z.object({ intervalMs: z.number().int().positive().safe(), daily: z.number().int().positive().safe(), weekly: z.number().int().nonnegative().safe() }).parse({ ...DEFAULT_BACKUP_POLICY, ...policy });
}

/** Latest snapshot per UTC day/week; overlapping daily/weekly representatives count once. */
export function pruneBackups(backupDir: string, policy: Partial<BackupPolicy> = {}): string[] {
  const { daily, weekly } = policyValue(policy);
  return withHomeOwner(backupDir, (root) => drain(pruneSteps(root, daily, weekly)));
}

/** The caller owns root for every step. */
function* pruneSteps(root: string, daily: number, weekly: number, verified?: Verified): Steps<string[]> {
  const snapshots = yield* listSteps(root, verified);
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
    verified?.delete(snapshot.directory);
    try { yield* verifySteps(snapshot.directory); }
    // Damaged since it was listed: keep it for diagnosis like any other damaged candidate instead of failing the prune.
    catch { continue; }
    rmSync(backupPath(root, snapshot.directory), { recursive: true });
    removed.push(snapshot.directory);
    yield;
  }
  syncBackupDirectory(root);
  return removed;
}

class BackupCancelled extends Error {}

/** Keep ownership across yields. A home this process already owns is borrowed; one owned by another process fails as before. */
function holdOwner(path: string): { home: string; release(): void } {
  try {
    const owner = acquireHomeOwner(path);
    return { home: owner.home, release: () => owner.release() };
  } catch (error) {
    if (!(error instanceof HomeOwnershipError)) throw error;
    return { home: withHomeOwner(path, (home) => home), release() {} };
  }
}

interface Cooperation {
  /** Runs one slice (loop-monitor attribution). */
  step<R>(next: () => R): R;
  cancelled(): boolean;
  sliceMs: number;
}

/** Releases the event loop between slices. On cancellation or failure the generator's cleanup (finally) still runs. */
async function cooperate<T>(steps: Steps<T>, cooperation: Cooperation, guard: <R>(next: () => R) => R): Promise<T> {
  try {
    let sliceStart = performance.now();
    for (;;) {
      if (cooperation.cancelled()) throw new BackupCancelled("backup cancelled");
      const result = guard(() => cooperation.step(() => steps.next()));
      if (result.done) return result.value;
      if (performance.now() - sliceStart < cooperation.sliceMs) continue;
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStart = performance.now();
    }
  } finally { steps.return(undefined as never); }
}

const pending = new Map<string, { job: Promise<BackupSnapshot | null>; cancel(): void }>();
const RETRY_BASE_MS = 300_000;

/** W6 runtime owns start/stop. Construction has no timers, network or implicit home. */
export class BackupManager {
  readonly policy: Readonly<BackupPolicy>;
  lastError: Error | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private lastSuccessAt?: number;
  private failures = 0;
  private retryAt = 0;
  private readonly verified: Verified = new Map();
  private loggedCause: string | null = null;
  constructor(readonly options: { home: string; backupDir: string; policy?: Partial<BackupPolicy>; now?: () => Date; loopMonitor?: LoopMonitor; sliceMs?: number; freeBytes?: (root: string) => number; log?: (line: string) => void }) {
    this.policy = Object.freeze(policyValue(options.policy ?? {}));
  }
  /** 실패 원인을 경로·내용 없이 한 낱말로 줄인다(분류 > 오류 코드 > 경로가 없는 고정 문구). */
  private cause(error: unknown): string {
    const chain: unknown[] = [];
    for (let e: unknown = error; e && typeof e === "object" && !chain.includes(e); e = (e as { cause?: unknown }).cause) chain.push(e);
    const coded = chain.map(e => (e as { code?: unknown }).code).find(code => typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)) as string | undefined;
    const message = chain.map(e => (e as Error).message).findLast(text => typeof text === "string" && text.length > 0 && text.length <= 80 && !/[\/\\]/.test(text));
    return classifyStorageError(error) ?? coded ?? message ?? (error instanceof Error ? error.name : "unknown");
  }
  /** 진단용. 백업이 며칠째 실패하고 있어도 알 길이 없던 것을 화면·로그가 읽을 수 있게 한다. */
  status(): { lastSuccessAt: string | null; failing: boolean; failures: number; cause: string | null; nextAttemptAt: string | null } {
    return { lastSuccessAt: this.lastSuccessAt === undefined ? null : new Date(this.lastSuccessAt).toISOString(), failing: this.lastError !== null, failures: this.failures,
      cause: this.lastError ? this.cause(this.lastError) : null, nextAttemptAt: this.retryAt ? new Date(this.retryAt).toISOString() : null };
  }
  run(force = false): Promise<BackupSnapshot | null> {
    // One in-flight operation per source home, even across manager instances/aliases.
    const key = normalizeHome(this.options.home);
    const existing = pending.get(key);
    if (existing) return existing.job;
    let cancelled = false;
    const monitor = this.options.loopMonitor;
    const cooperation: Cooperation = {
      step: (next) => monitor ? monitor.run("timer:backup", next) : next(),
      cancelled: () => cancelled,
      sliceMs: Math.max(0, this.options.sliceMs ?? 8),
    };
    const run = async () => {
      const now = this.options.now?.() ?? new Date();
      if (this.lastSuccessAt === undefined) {
        // Revalidate the newest persisted package on restart, not on every timer tick. A damaged candidate cannot suppress a new backup.
        for (const candidate of backupCandidates(this.options.backupDir)) {
          if (candidate.manifest.sourceHome !== key) continue;
          try {
            await cooperate(verifySteps(candidate.directory), cooperation, (next) => next());
            remember(this.verified, candidate.directory);
            this.lastSuccessAt = Date.parse(candidate.manifest.createdAt);
            break;
          } catch (error) { if (error instanceof BackupCancelled) throw error; }
        }
      }
      if (!force && this.lastSuccessAt !== undefined && now.getTime() - this.lastSuccessAt < this.policy.intervalMs) return null;
      let snapshot: BackupSnapshot;
      try {
        const home = holdOwner(this.options.home);
        try {
          const root = holdOwner(backupRoot(home.home, this.options.backupDir));
          try {
            snapshot = await cooperate(createSteps(home.home, root.home, { ...this.options, now }), cooperation,
              (next) => withHomeOwner(home.home, () => withHomeOwner(root.home, next)));
          } finally { root.release(); }
        } finally { home.release(); }
      } catch (error) { throw error instanceof BackupCancelled ? error : toStorageError(error, "백업 실패"); }
      // The snapshot exists now: a failed prune must not make the retry create another full copy.
      this.lastSuccessAt = Date.parse(snapshot.manifest.createdAt);
      remember(this.verified, snapshot.directory);
      const root = holdOwner(this.options.backupDir);
      try {
        await cooperate(pruneSteps(root.home, this.policy.daily, this.policy.weekly, this.verified), cooperation, (next) => withHomeOwner(root.home, next));
      } finally { root.release(); }
      if (this.loggedCause !== null) (this.options.log ?? (line => console.error(line)))(`[backup] 정기 백업이 다시 성공했습니다 (${snapshot.manifest.createdAt})`);
      this.lastError = null;
      this.failures = 0;
      this.retryAt = 0;
      this.loggedCause = null;
      return snapshot;
    };
    const job = Promise.resolve().then(run)
      .catch((error) => {
        // Stopped by shutdown, not a failure. The next start runs it again.
        if (error instanceof BackupCancelled) return null;
        this.lastError = toStorageError(error, "정기 백업 실패");
        // Repeated failures push the timer's next attempt out: 5 minutes, doubling, capped at the backup interval.
        this.failures++;
        this.retryAt = (this.options.now?.() ?? new Date()).getTime() + Math.min(this.policy.intervalMs, RETRY_BASE_MS * 2 ** Math.min(this.failures - 1, 16));
        // 원인이 바뀔 때마다 한 줄. 같은 실패가 이어지는 동안에는 되풀이하지 않는다.
        const cause = this.cause(this.lastError);
        if (cause !== this.loggedCause) {
          this.loggedCause = cause;
          (this.options.log ?? (line => console.error(line)))(`[backup] 정기 백업 실패: ${cause} (연속 ${this.failures}회, 다음 시도 ${new Date(this.retryAt).toISOString()})`);
        }
        throw this.lastError;
      })
      .finally(() => { pending.delete(key); });
    pending.set(key, { job, cancel: () => { cancelled = true; } });
    return job;
  }
  /** Timer entry. Unlike an explicit run(), it waits out the failure backoff. */
  tick(): Promise<void> {
    try {
      if ((this.options.now?.() ?? new Date()).getTime() < this.retryAt) return Promise.resolve();
      return this.run().then(() => {}, () => { /* lastError is exposed to runtime diagnostics. */ });
    } catch (error) {
      this.lastError = toStorageError(error, "정기 백업 실패");
      return Promise.resolve();
    }
  }
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, Math.min(this.policy.intervalMs, 60_000));
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const active = pending.get(normalizeHome(this.options.home));
    // Shutdown does not wait for a backup: the in-flight stage is removed and the job ends.
    active?.cancel();
    await active?.job;
  }
}
