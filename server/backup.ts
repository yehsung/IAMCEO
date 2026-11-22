import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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

/**
 * 한 덩어리로 오래 걸리는 일(DB 무결성·외래 키 검사, VACUUM INTO, DB 파일 전체 해시). 정기 백업은 이것을 작업 스레드에서
 * 돌려 서버를 멈추지 않는다(11-22: 원본 검사·VACUUM INTO·사본 검사가 서버 스레드를 1.4초까지 붙잡았고 DB 크기에 비례해 늘었다).
 * 동기 호출(createBackup·verifyBackup·restore)과 작업 스레드를 쓸 수 없을 때는 예전처럼 이 스레드에서 돈다.
 */
export type BackupTask =
  | { op: "check"; path: string; maxVersion: number }
  | { op: "vacuum"; source: string; target: string }
  | { op: "digest"; path: string };

interface BackupTaskDeps {
  Database: typeof Database;
  openSync: typeof openSync;
  fstatSync: typeof fstatSync;
  readSync: typeof readSync;
  closeSync: typeof closeSync;
  fsyncSync: typeof fsyncSync;
  constants: typeof constants;
  createHash: typeof createHash;
}

/**
 * 일부러 바깥 이름을 쓰지 않는다: 이 함수의 소스(Function.prototype.toString)가 그대로 작업 스레드의 프로그램이 된다.
 * 매개변수와 언어 기본 전역(Buffer·Error)만 쓴다. `checkOpen` 은 이미 연 DB(복원)를 이 스레드에서 검사할 때만 쓴다.
 */
function backupTask(deps: BackupTaskDeps, task: BackupTask | { op: "checkOpen"; db: Database; maxVersion: number }): unknown {
  const check = (db: Database, maxVersion: number): number => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (version < 1 || version > maxVersion) throw new Error("Unsupported backup DB schema");
    const checks = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (checks.length !== 1 || checks[0]!.integrity_check !== "ok") throw new Error("Backup DB integrity check failed");
    if (db.query("PRAGMA foreign_key_check").all().length) throw new Error("Backup DB foreign key check failed");
    return version;
  };
  if (task.op === "checkOpen") return check(task.db, task.maxVersion);
  if (task.op === "digest") {
    const { openSync, fstatSync, readSync, closeSync, constants, createHash } = deps;
    const input = openSync(task.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(input);
      if (!before.isFile()) throw new Error("Backup input must be a regular file");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(1024 * 1024);
      let size = 0;
      for (let count; (count = readSync(input, buffer, 0, buffer.length, null)) > 0;) {
        hash.update(buffer.subarray(0, count));
        size += count;
      }
      const after = fstatSync(input);
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Backup input changed during copy");
      return { size, sha256: hash.digest("hex") };
    } finally { closeSync(input); }
  }
  if (task.op === "vacuum") {
    const db = new deps.Database(task.source, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.query("VACUUM INTO ?").run(task.target);
    } finally { db.close(); }
    // Flush the new copy here too, so publishing's fsync on the server thread has nothing large left to write.
    const fd = deps.openSync(task.target, deps.constants.O_RDONLY | deps.constants.O_NOFOLLOW);
    try { deps.fsyncSync(fd); } finally { deps.closeSync(fd); }
    return null;
  }
  const db = new deps.Database(task.path, { readonly: true });
  try { return check(db, task.maxVersion); } finally { db.close(); }
}

/** Live bindings: tests that spy on node:fs see these reads too. */
const hereDeps = (): BackupTaskDeps => ({ Database, openSync, fstatSync, readSync, closeSync, fsyncSync, constants, createHash });

function runTaskHere(task: BackupTask): unknown {
  return backupTask(hereDeps(), task);
}

let workerUrl: string | undefined;
/** A blob module, so a compiled binary needs no extra entry point. */
function backupWorkerUrl(): string {
  return workerUrl ??= URL.createObjectURL(new Blob([`import { Database } from "bun:sqlite";
import { openSync, fstatSync, readSync, closeSync, fsyncSync, constants } from "node:fs";
import { createHash } from "node:crypto";
const task = ${backupTask.toString()};
const deps = { Database, openSync, fstatSync, readSync, closeSync, fsyncSync, constants, createHash };
self.onmessage = (event) => {
  let reply;
  try { reply = { ok: true, value: task(deps, event.data) }; }
  catch (error) {
    const e = error ?? {};
    reply = { ok: false, error: { name: String(e.name ?? "Error"), message: String(e.message ?? e),
      code: typeof e.code === "string" ? e.code : undefined, errno: typeof e.errno === "number" ? e.errno : undefined,
      errcode: typeof e.errcode === "number" ? e.errcode : undefined } };
  }
  postMessage(reply);
};
`], { type: "text/javascript" }));
}

/** Same name/message/code as a failure in this thread, so classification and logs do not change. */
function workerError(value: { name?: string; message?: string; code?: string; errno?: number; errcode?: number }): Error {
  const error = new Error(value.message ?? "backup task failed");
  if (value.name && value.name !== "Error") error.name = value.name;
  for (const key of ["code", "errno", "errcode"] as const) if (value[key] !== undefined) Object.assign(error, { [key]: value[key] });
  return error;
}

/** 작업 스레드가 한 번이라도 뜨지 못했거나 죽었으면 이 프로세스에서는 다시 쓰지 않고 이 스레드에서 한다(예전 동작). */
let workerUnavailable = false;

/** One worker per cooperative run, created on first use and ended with the run. One task at a time. */
class TaskRunner {
  private worker?: Worker;
  private waiting?: { resolve(value: unknown): void; reject(error: unknown): void };
  constructor(private readonly offload: boolean) {}

  run(task: BackupTask): Promise<unknown> {
    if (!this.offload || workerUnavailable) return Promise.resolve().then(() => runTaskHere(task));
    let worker: Worker;
    try { worker = this.worker ??= this.spawn(); }
    catch {
      this.unavailable();
      return Promise.resolve().then(() => runTaskHere(task));
    }
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      worker.postMessage(task);
    });
  }

  private spawn(): Worker {
    // Kept referenced: a CLI backup (`iamceo backup`) has nothing else holding the process open while it waits for a reply.
    // Every run ends its worker (TaskRunner.close in cooperate's finally).
    const worker = new Worker(backupWorkerUrl());
    worker.onmessage = (event: MessageEvent<{ ok: true; value: unknown } | { ok: false; error: Parameters<typeof workerError>[0] }>) => {
      if (this.worker !== worker) return;
      const waiting = this.waiting;
      this.waiting = undefined;
      if (event.data.ok) waiting?.resolve(event.data.value);
      else waiting?.reject(workerError(event.data.error));
    };
    // The task may or may not have run; it fails this attempt (the backup retries) and later work stays in this thread.
    const lost = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.unavailable();
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting?.reject(new Error("Backup worker stopped"));
    };
    worker.onerror = lost;
    worker.addEventListener("close", lost);
    return worker;
  }

  private unavailable(): void {
    if (!workerUnavailable) console.error("[backup] 백업 작업 스레드를 쓸 수 없어 DB 검사를 서버 스레드에서 합니다");
    workerUnavailable = true;
  }

  close(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.waiting = undefined;
    worker?.terminate();
  }
}

/** One BackupTask on a worker thread (`offload`) or in this thread. Backups use the cooperative runner; this is for checks and tests. */
export async function runBackupTask(work: BackupTask, options: { offload: boolean }): Promise<unknown> {
  const runner = new TaskRunner(options.offload);
  try { return await runner.run(work); } finally { runner.close(); }
}

/** Work with a yield point after each file or DB check. Synchronous callers drain it; the daemon's scheduled backup releases the event loop in between and runs each BackupTask on a worker. */
type Steps<T> = Generator<BackupTask | void, T, unknown>;

/** One heavy step; its result (or failure) comes back at the yield, wherever it ran. */
function* task<R = unknown>(work: BackupTask): Generator<BackupTask, R, unknown> {
  return (yield work) as R;
}

function drain<T>(steps: Steps<T>): T {
  let step = steps.next();
  for (;;) {
    if (step.done) return step.value;
    if (!step.value) { step = steps.next(); continue; }
    let value: unknown;
    try { value = runTaskHere(step.value); }
    catch (error) { step = steps.throw(error); continue; }
    step = steps.next(value);
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

type Digest = { size: number; sha256: string };

/** 이보다 큰 첨부는 검증할 때 작업 스레드가 해시한다(서버 스레드에서 한 번에 몇 ms 넘게 읽지 않게). */
const WORKER_DIGEST_BYTES = 8 * 1024 * 1024;

/** clonefile 이 안 되는 경우(다른 볼륨·APFS 가 아닌 볼륨). 이때만 예전처럼 바이트를 복사한다. */
const CLONE_UNSUPPORTED = new Set(["EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "ENOTTY"]);

/** 홈의 파일을 이 폴더로 APFS clone 할 수 있는가(config.json 으로 시험). 백업 공간 계산에만 쓰고, 모르면 '안 된다'로 본다. */
function cloneSupported(home: string, directory: string): boolean {
  const probe = join(directory, `.clone-probe-${randomUUID()}`);
  try {
    copyFileSync(backupPath(home, join(home, "config.json")), probe, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch { return false; }
  finally { try { unlinkSync(probe); } catch { /* Not created. */ } }
}

/**
 * Bounded memory, independent copies, no hard links to mutable uploads. On APFS the copy is a clone (copy-on-write: it shares
 * blocks until either side is written, so a later write to the source never reaches the copy) and takes no extra space; the
 * digest is then read from the copy itself. Elsewhere it is a plain byte copy, hashed as it is written, as before.
 */
export function backupFile(source: string, destination?: string): Digest {
  if (!destination) return runTaskHere({ op: "digest", path: source }) as Digest;
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: number | undefined;
  try {
    const before = fstatSync(input);
    if (!before.isFile()) throw new Error("Backup input must be a regular file");
    try {
      copyFileSync(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE);
    } catch (error) {
      if (!CLONE_UNSUPPORTED.has(String((error as { code?: unknown }).code))) throw error;
      return copyBytes(input, before, destination);
    }
    // copyFileSync follows a link: the name must still be the file we opened and checked.
    const named = lstatSync(source);
    if (named.dev !== before.dev || named.ino !== before.ino) throw new Error("Backup input changed during copy");
    output = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const copy = fstatSync(output);
    if (!copy.isFile() || copy.nlink !== 1) throw new Error("Backup copy must be a regular file");
    fchmodSync(output, 0o600);
    const digest = runTaskHere({ op: "digest", path: destination }) as Digest;
    const after = fstatSync(input);
    if (digest.size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Backup input changed during copy");
    fsyncSync(output);
    return digest;
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

/** The byte copy used where cloning is unavailable (the copy as it was before clones). The caller owns and closes `input`. */
function copyBytes(input: number, before: ReturnType<typeof fstatSync>, destination: string): Digest {
  const output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (let count; (count = readSync(input, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) {
        const written = writeSync(output, buffer, offset, count - offset);
        if (!written) throw new Error("Backup short write");
        offset += written;
      }
      size += count;
    }
    const after = fstatSync(input);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Backup input changed during copy");
    fsyncSync(output);
    return { size, sha256: hash.digest("hex") };
  } finally { closeSync(output); }
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
  return backupTask(hereDeps(), { op: "checkOpen", db, maxVersion: MIGRATIONS.length }) as number;
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
    const path = backupPath(directory, join(directory, entry.path));
    // The DB file and any large attachment are one long read each: the worker reads them. Small files are read here between yields as before.
    const actual = entry === manifest.database || entry.size >= WORKER_DIGEST_BYTES ? yield* task<Digest>({ op: "digest", path }) : backupFile(path);
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new Error("Backup size/hash mismatch");
    yield;
  }
  for (const config of manifest.configs) checkConfig(join(directory, config.path));
  const database = join(directory, manifest.database.path);
  if ((yield* task<number>({ op: "check", path: database, maxVersion: MIGRATIONS.length })) !== manifest.schemaVersion) throw new Error("Backup schema mismatch");
  yield;
  const db = new Database(database, { readonly: true });
  try {
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
    const refsSchema = z.array(z.object({ id: z.string(), path: z.string() }));
    for (const [table, column] of [["messages", "attachments"], ["files", "attachments"], ["decisions", "images"]]) {
      let checked = 0;
      for (const row of db.query<{ value: string }, []>(`SELECT ${column} AS value FROM ${table}`).all()) {
        const refs = refsSchema.parse(JSON.parse(row.value));
        if (refs.some((ref) => !entries.has(ref.id))) throw new Error("Backup record references a missing attachment");
        // 11-22: 이 확인이 한 덩어리로 서버를 40 ms 붙잡았다(행 수에 비례). 몇백 행마다 양보한다.
        if (++checked % 500 === 0) yield;
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
    const database = backupPath(home, join(home, "iamceo.db"));
    const source = new Database(database, { readonly: true });
    let attachmentBytes: number;
    try { attachmentBytes = source.query<{ total: number | null }, []>("SELECT SUM(size) AS total FROM attachments").get()?.total ?? 0; }
    finally { source.close(); }
    // 공간이 모자란 채로 시작하면 수백 MB 를 썼다 지우기를 되풀이하고, 같은 디스크를 쓰는 다른 세션의 쓰기까지 실패시킨다.
    // 첨부를 APFS clone 으로 담을 수 있으면 첨부는 공간을 쓰지 않으므로 새로 쓰는 DB 사본만 센다.
    const clones = cloneSupported(home, stage);
    requireBackupSpace(root, statSync(database).size + (clones ? 0 : attachmentBytes), options.freeBytes);
    yield* task({ op: "check", path: database, maxVersion: MIGRATIONS.length });
    yield;
    yield* task({ op: "vacuum", source: database, target: join(stage, "iamceo.db") });
    chmodSync(join(stage, "iamceo.db"), 0o600);
    yield;
    const schemaVersion = yield* task<number>({ op: "check", path: join(stage, "iamceo.db"), maxVersion: MIGRATIONS.length });
    yield;
    const db = new Database(join(stage, "iamceo.db"), { readonly: true });
    const attachments: BackupManifest["attachments"] = [];
    try {
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
    const databaseDigest = yield* task<Digest>({ op: "digest", path: join(stage, "iamceo.db") });
    const manifest: BackupManifest = {
      format: 1, id, createdAt, applicationVersion: VERSION, sourceHome: home,
      sourceHomeAliases: home === resolve(options.home) ? [] : [resolve(options.home)], schemaVersion,
      database: { path: "iamceo.db", ...databaseDigest }, configs, attachments,
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

/** Snapshots fully verified by this process or, per their mark, by an earlier one (directory → snapshotStamp). Published snapshots are immutable. */
type Verified = Map<string, string>;

/**
 * A snapshot at rest: every file its manifest names (and the manifest), by inode, size and change times. Writing a file's bytes
 * always moves its ctime, which user space cannot set back, so an equal stamp means nothing was written since it was verified.
 */
function snapshotStamp(snapshot: BackupSnapshot): string | null {
  try {
    const hash = createHash("sha256").update(`${snapshot.manifest.id}\n`);
    for (const path of ["manifest.json", snapshot.manifest.database.path, ...snapshot.manifest.configs.map((entry) => entry.path), ...snapshot.manifest.attachments.map((entry) => entry.path)]) {
      const stat = lstatSync(join(snapshot.directory, path));
      if (!stat.isFile()) return null;
      hash.update(`${path}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\n`);
    }
    return hash.digest("hex");
  } catch { return null; }
}

/**
 * 11-22: 서버가 다시 뜰 때마다(배포마다) 보관 스냅샷을 처음부터 다시 해시했다(지금 1회 약 17 GB 읽기). 끝까지 검증한 스냅샷에는
 * 그때의 stamp 를 이 표시 파일로 남기고, 다음 프로세스는 stamp 가 그대로일 때만 다시 해시하지 않는다. manifest 밖의 파일이라
 * 예전 서버·복원은 이 파일을 보지 않는다. 지우기 직전과 복원은 지금처럼 끝까지 검증한다.
 */
const VERIFIED_MARK = ".verified.json";
const verifiedMarkSchema = z.object({ format: z.literal(1), id: z.string(), stamp: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

function readMark(snapshot: BackupSnapshot): string | null {
  try {
    const mark = verifiedMarkSchema.parse(readBackupJson(join(snapshot.directory, VERIFIED_MARK)));
    return mark.id === snapshot.manifest.id ? mark.stamp : null;
  } catch { return null; }
}

/** Best effort: a missing mark only costs one more full verification after the next restart. */
function writeMark(snapshot: BackupSnapshot, stamp: string): void {
  try {
    const temp = join(snapshot.directory, `${VERIFIED_MARK}.next`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ format: 1, id: snapshot.manifest.id, stamp }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, join(snapshot.directory, VERIFIED_MARK));
  } catch { /* Kept unmarked. */ }
}

/** After a full verification. `persist` writes the mark; the caller then owns the backup root. */
function remember(verified: Verified, snapshot: BackupSnapshot, persist: boolean): void {
  const stamp = snapshotStamp(snapshot);
  if (!stamp) return;
  verified.set(snapshot.directory, stamp);
  if (persist && readMark(snapshot) !== stamp) writeMark(snapshot, stamp);
}

/** True when this exact snapshot was verified in full before (by this process, or by an earlier one per its mark). */
function alreadyVerified(verified: Verified, snapshot: BackupSnapshot): boolean {
  const stamp = snapshotStamp(snapshot);
  if (!stamp || (verified.get(snapshot.directory) ?? readMark(snapshot)) !== stamp) return false;
  verified.set(snapshot.directory, stamp);
  return true;
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
      if (verified) {
        // Do not re-hash every retained snapshot each day, nor after every restart. Deletion and restore always verify in full.
        let candidate: BackupSnapshot | undefined;
        try { candidate = readCandidate(directory, entry.name); } catch { /* Verified in full below, which reports why. */ }
        if (candidate && alreadyVerified(verified, candidate)) {
          snapshots.push(candidate);
          yield;
          continue;
        }
      }
      const snapshot = yield* verifySteps(directory);
      if (snapshot.manifest.id !== entry.name) continue;
      snapshots.push(snapshot);
      if (verified) remember(verified, snapshot, true);
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

/**
 * 배포·앱 설치 직전 사본. 스냅샷이 아니고 서버가 만들지도 않는다: 대표의 배포 절차(배포 스크립트가 서버를 내린 뒤 DB 를
 * `pre-<커밋>-<YYYYMMDD-HHMMSS>/` 에 복사)와 앱 설치 절차(바꾸기 전 앱을 `app-pre-<판>-<YYYYMMDD-HHMMSS>/` 로 옮김)가 이 백업
 * 폴더에 남긴다. 지우는 곳이 없어 11-22 에 60개·6.6 GB 가 쌓였다. 종류마다 이름의 시각으로 최근 `keep` 개를 남기고, 그보다
 * 오래된 것도 만든 지 `minAgeMs` 가 지나지 않았으면 남긴다(방금 만든 사본은 늘 최근 것이라 지우지 않는다).
 */
export const INSTALL_COPY_RETENTION: Readonly<{ keep: number; minAgeMs: number }> = Object.freeze({ keep: 3, minAgeMs: 86_400_000 });
const INSTALL_COPY_KINDS = [
  // DB 사본: 보통 파일만(iamceo.db·old-rev.txt·plist, 예전 것은 -wal·-shm 도).
  { name: /^pre-[0-9a-f]{7,40}-(\d{8})-(\d{6})$/, layout: "files" },
  // 앱 사본: `<이름>.app` 하나.
  { name: /^app-pre-[A-Za-z0-9][A-Za-z0-9._-]{0,63}-(\d{8})-(\d{6})$/, layout: "app" },
] as const;

/** `date +%Y%m%d-%H%M%S` (this Mac's local time) → ms; NaN when it is not a real time. */
function installCopyTime(date: string, time: string): number {
  const [y, mo, d, h, mi, s] = [date.slice(0, 4), date.slice(4, 6), date.slice(6, 8), time.slice(0, 2), time.slice(2, 4), time.slice(4, 6)].map(Number) as [number, number, number, number, number, number];
  const at = new Date(y, mo - 1, d, h, mi, s);
  return at.getFullYear() === y && at.getMonth() === mo - 1 && at.getDate() === d && at.getHours() === h && at.getMinutes() === mi && at.getSeconds() === s ? at.getTime() : Number.NaN;
}

/** Only the expected shape goes: no special files, nothing on another volume. Links inside an app are removed, never followed. */
function removableInstallCopy(path: string, dev: number, layout: "files" | "app"): boolean {
  const names = readdirSync(path);
  if (layout === "files") return names.every((name) => { const stat = lstatSync(join(path, name)); return stat.isFile() && stat.dev === dev; });
  if (names.length === 0) return true;
  if (names.length !== 1 || !names[0]!.endsWith(".app")) return false;
  const pending = [join(path, names[0]!)];
  for (let directory; (directory = pending.pop()) !== undefined;) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.dev !== dev) return false;
    for (const name of readdirSync(directory)) {
      const entry = lstatSync(join(directory, name));
      if (entry.isDirectory()) pending.push(join(directory, name));
      else if (!entry.isFile() && !entry.isSymbolicLink()) return false;
    }
  }
  return true;
}

/** The caller owns root for every step. Returns the names removed; anything uncertain stays for the next backup. */
function* pruneInstallCopySteps(root: string, now: number, retention: { keep: number; minAgeMs: number } = INSTALL_COPY_RETENTION): Steps<string[]> {
  const removed: string[] = [];
  if (!existsSync(root)) return removed;
  const entries = readdirSync(root, { withFileTypes: true });
  for (const kind of INSTALL_COPY_KINDS) {
    const copies = entries.flatMap((entry) => {
      const match = entry.isDirectory() ? kind.name.exec(entry.name) : null;
      const at = match ? installCopyTime(match[1]!, match[2]!) : Number.NaN;
      return Number.isFinite(at) ? [{ name: entry.name, at }] : [];
    }).sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
    for (const copy of copies.slice(retention.keep)) {
      try {
        const path = backupPath(root, join(root, copy.name));
        const stat = lstatSync(path);
        const youngest = Math.max(copy.at, stat.mtimeMs, stat.birthtimeMs || 0);
        if (!stat.isDirectory() || youngest > now || now - youngest < retention.minAgeMs) continue;
        if (!removableInstallCopy(path, stat.dev, kind.layout)) continue;
        rmSync(path, { recursive: true });
        removed.push(copy.name);
      } catch { /* Kept; the next backup looks again. */ }
      yield;
    }
  }
  if (removed.length) syncBackupDirectory(root);
  return removed;
}

/** Synchronous form (CLI, tests). Owns the backup folder while it runs. */
export function pruneInstallCopies(backupDir: string, now = Date.now(), retention: { keep: number; minAgeMs: number } = INSTALL_COPY_RETENTION): string[] {
  return withHomeOwner(backupDir, (root) => drain(pruneInstallCopySteps(root, now, retention)));
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
  /** Run each BackupTask on a worker thread (false: in this thread, as synchronous callers do). */
  offload: boolean;
}

/**
 * Releases the event loop between slices, and while a BackupTask runs on the worker. A running task is never abandoned:
 * cancellation is seen when it returns, as it was seen after a synchronous step. On cancellation or failure the generator's
 * cleanup (finally) still runs.
 */
async function cooperate<T>(steps: Steps<T>, cooperation: Cooperation, guard: <R>(next: () => R) => R): Promise<T> {
  const runner = new TaskRunner(cooperation.offload);
  try {
    let sliceStart = performance.now();
    let resume: { value?: unknown; error?: unknown; failed: boolean } = { failed: false };
    for (;;) {
      if (cooperation.cancelled()) throw new BackupCancelled("backup cancelled");
      const input = resume;
      const result = guard(() => cooperation.step(() => input.failed ? steps.throw(input.error) : steps.next(input.value)));
      if (result.done) return result.value;
      if (result.value) {
        try { resume = { value: await runner.run(result.value), failed: false }; }
        catch (error) { resume = { error, failed: true }; }
        sliceStart = performance.now();
        continue;
      }
      resume = { failed: false };
      if (performance.now() - sliceStart < cooperation.sliceMs) continue;
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStart = performance.now();
    }
  } finally {
    runner.close();
    steps.return(undefined as never);
  }
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
  private pruneFailures = 0;
  private pruneRetryAt = 0;
  constructor(readonly options: { home: string; backupDir: string; policy?: Partial<BackupPolicy>; now?: () => Date; loopMonitor?: LoopMonitor; sliceMs?: number; freeBytes?: (root: string) => number; log?: (line: string) => void;
    /** 시험용: false 면 DB 검사·VACUUM INTO 를 작업 스레드 없이 이 스레드에서 한다. */ offload?: boolean;
    /** 시험용: 배포·설치 직전 사본의 보존 수와 최소 나이. */ installCopies?: { keep: number; minAgeMs: number } }) {
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
  /**
   * 오래된 보관분 정리. 실패해도 방금 만든 백업은 성공이다: 정리만 간격을 늘려 가며 다시 한다.
   * 예전에는 백업 전체를 실패로 적어 하루 동안 '백업 실패'로 보였고 정리도 다음 날까지 다시 하지 않았다.
   */
  private async prune(cooperation: Cooperation, now: Date): Promise<void> {
    try {
      const root = holdOwner(this.options.backupDir);
      try {
        await cooperate(pruneSteps(root.home, this.policy.daily, this.policy.weekly, this.verified), cooperation, (next) => withHomeOwner(root.home, next));
      } finally { root.release(); }
      this.pruneFailures = 0;
    } catch (error) {
      if (error instanceof BackupCancelled) throw error;
      if (!this.pruneFailures) (this.options.log ?? (line => console.error(line)))(`[backup] 오래된 백업 정리 실패: ${this.cause(error)} (새 백업은 만들어졌습니다. 정리는 다시 시도합니다)`);
      this.pruneFailures++;
      this.pruneRetryAt = now.getTime() + Math.min(this.policy.intervalMs, RETRY_BASE_MS * 2 ** Math.min(this.pruneFailures - 1, 16));
    }
  }
  private log(line: string): void { (this.options.log ?? (text => console.error(text)))(line); }
  /** After a full verification outside a root-owning step (restart, a new snapshot): mark it only while owning the backup folder. */
  private remember(snapshot: BackupSnapshot): void {
    try { withHomeOwner(this.options.backupDir, () => remember(this.verified, snapshot, true)); }
    catch { remember(this.verified, snapshot, false); }
  }
  /**
   * 배포·설치 직전 사본 정리. 새 스냅샷을 만들기 전에 한다(디스크가 차서 스냅샷을 못 만들 때도 공간을 돌려받는다). 실패해도 백업은 이어 간다.
   * 그 절차들이 쓰는 기본 자리(<홈>/backups)에서만 한다: `iamceo backup --directory` 로 고른 다른 폴더의 것은 건드리지 않는다.
   */
  private async pruneInstallCopies(cooperation: Cooperation, now: Date): Promise<void> {
    if (normalizeHome(this.options.backupDir) !== join(normalizeHome(this.options.home), "backups")) return;
    try {
      const root = holdOwner(this.options.backupDir);
      let removed: string[];
      try {
        removed = await cooperate(pruneInstallCopySteps(root.home, now.getTime(), this.options.installCopies), cooperation, (next) => withHomeOwner(root.home, next));
      } finally { root.release(); }
      if (removed.length) (this.options.log ?? (line => console.info(line)))(`[backup] 배포·설치 직전 사본 ${removed.length}개 정리(종류마다 최근 ${(this.options.installCopies ?? INSTALL_COPY_RETENTION).keep}개와 하루가 안 된 것은 남김): ${removed.join(", ")}`);
    } catch (error) {
      if (error instanceof BackupCancelled) throw error;
      this.log(`[backup] 배포·설치 직전 사본 정리 실패: ${this.cause(error)} (다음 백업 때 다시 봅니다)`);
    }
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
      offload: this.options.offload ?? true,
    };
    const run = async () => {
      const now = this.options.now?.() ?? new Date();
      if (this.lastSuccessAt === undefined) {
        // Revalidate the newest persisted package on restart, not on every timer tick. A damaged candidate cannot suppress a new backup.
        for (const candidate of backupCandidates(this.options.backupDir)) {
          if (candidate.manifest.sourceHome !== key) continue;
          // Verified in full by an earlier process and untouched since (its mark): no re-hash on every deploy.
          if (alreadyVerified(this.verified, candidate)) {
            this.lastSuccessAt = Date.parse(candidate.manifest.createdAt);
            break;
          }
          try {
            this.remember(await cooperate(verifySteps(candidate.directory), cooperation, (next) => next()));
            this.lastSuccessAt = Date.parse(candidate.manifest.createdAt);
            break;
          } catch (error) { if (error instanceof BackupCancelled) throw error; }
        }
      }
      if (!force && this.lastSuccessAt !== undefined && now.getTime() - this.lastSuccessAt < this.policy.intervalMs) {
        if (this.pruneFailures && now.getTime() >= this.pruneRetryAt) await this.prune(cooperation, now);
        return null;
      }
      await this.pruneInstallCopies(cooperation, now);
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
      this.remember(snapshot);
      await this.prune(cooperation, now);
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
