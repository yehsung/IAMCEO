// 0.2.10 저장 공간: 백업이 디스크를 채우지 않고, 저장소 정리가 서버를 멈추지 않는다.
// clone 백업·작업 스레드 검사·검증 표시·배포/설치 사본 정리·이주 사본 정리·게시 기록 정리·보관 프로젝트 지우기의 참조 확인.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { BackupManager, backupFile, createBackup, INSTALL_COPY_RETENTION, listBackups, pruneInstallCopies, runBackupTask, verifyBackup } from "../server/backup.ts";
import type { BackupTask } from "../server/backup.ts";
import { Bus } from "../server/bus.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { FilePublication, prepareImport, writePublicationManifest, type PublicationManifest } from "../server/files.ts";
import { restoreBackup } from "../server/restore.ts";
import { PUBLISHED_JOURNAL_BUDGET_MS, PUBLISHED_JOURNAL_GRACE_MS, StorageMaintenance } from "../server/storage-maintenance.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import type { IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const runtimes: IsolatedRuntime[] = [];
const databases: Database[] = [];
const at = "2026-11-07T00:00:00.000Z";
const DAY = 86_400_000;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
  for (const db of databases.splice(0).reverse()) db.close();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

function track(db: Database): Database { databases.push(db); return db; }

function home(attachments = 3, bytes = 64) {
  const runtime = createIsolatedRuntime();
  runtimes.push(runtime);
  const home = runtime.paths.iamceoHome;
  const root = join(runtime.dir, "backups");
  fs.mkdirSync(join(home, "uploads"), { mode: 0o700 });
  fs.writeFileSync(join(home, "config.json"), JSON.stringify({ accessCode: "fixture-secret", port: 0, hosts: ["127.0.0.1"] }), { mode: 0o600 });
  const db = track(openDb(join(home, "iamceo.db")));
  db.query("INSERT INTO projects (id,name,cwd,runner_enabled,created_at,updated_at) VALUES ('p','보관할 기록',?,1,?,?)").run(join(home, "work"), at, at);
  const paths: string[] = [];
  for (let i = 0; i < attachments; i++) {
    const dir = join(home, "uploads", `a_fixture${String(i).padStart(5, "0")}`);
    fs.mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, `file-${i}.bin`);
    fs.writeFileSync(path, randomBytes(bytes), { mode: 0o600 });
    db.query("INSERT INTO attachments (id,name,mime,size,path,created_at) VALUES (?,?,?,?,?,?)").run(`a${i}`, `file-${i}.bin`, "application/octet-stream", bytes, path, at);
    paths.push(path);
  }
  return { runtime, home, root, db, paths };
}

/** Does this volume clone (APFS)? The fixture's temp folder decides which copy path the backup takes. */
function clonesHere(dir: string): boolean {
  const source = join(dir, `.probe-${process.pid}`), copy = `${source}.copy`;
  fs.writeFileSync(source, "probe");
  try { fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE_FORCE); return true; }
  catch { return false; }
  finally { for (const path of [source, copy]) try { fs.unlinkSync(path); } catch { /* not made */ } }
}

/** One spy on node:fs openSync for the whole block; count by path prefix afterwards. */
function watchOpens() {
  const opened: string[] = [];
  const original = fs.openSync;
  const spy = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    opened.push(String(path));
    return (original as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof fs.openSync);
  return { restore: () => spy.mockRestore(), count: (...prefixes: string[]) => opened.filter((path) => prefixes.some((prefix) => path.startsWith(prefix))).length };
}

describe("첨부 사본은 APFS clone, 안 되는 곳은 예전처럼 바이트 복사", () => {
  test("clone 은 바이트를 쓰지 않고, 사본은 0600 이며 나중에 원본을 고쳐도 바뀌지 않는다", () => {
    const f = home(1, 4096);
    if (!clonesHere(f.runtime.dir)) throw new Error("이 시험은 APFS 임시 폴더가 필요합니다");
    fs.chmodSync(f.paths[0]!, 0o644);
    const target = join(f.runtime.dir, "copy.bin");
    const copies = spyOn(fs, "copyFileSync");
    const writes = spyOn(fs, "writeSync");
    let digest: { size: number; sha256: string };
    let modes: number[], written: number;
    // mockRestore 는 기록도 지우므로 돌려놓기 전에 센다.
    try { digest = backupFile(f.paths[0]!, target); modes = copies.mock.calls.map((call) => Number(call[2])); written = writes.mock.calls.length; }
    finally { copies.mockRestore(); writes.mockRestore(); }
    expect(modes!).toHaveLength(1);
    expect(modes![0]! & fs.constants.COPYFILE_FICLONE_FORCE).toBeTruthy();
    expect(written!).toBe(0);
    const original = fs.readFileSync(f.paths[0]!);
    expect(digest!).toEqual({ size: 4096, sha256: sha256(original) });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    fs.writeFileSync(f.paths[0]!, randomBytes(4096));
    expect(sha256(fs.readFileSync(target))).toBe(sha256(original));
    // 같은 이름이 이미 있으면 덮어쓰지 않는다.
    expect(() => backupFile(f.paths[0]!, target)).toThrow();
  });

  test.each(["ENOTSUP", "EXDEV", "EOPNOTSUPP"])("clone 이 안 되면(%s) 바이트로 복사하고 같은 해시를 적는다", (code) => {
    const f = home(1, 4096);
    const target = join(f.runtime.dir, "copy.bin");
    const copies = spyOn(fs, "copyFileSync").mockImplementation(() => { throw Object.assign(new Error("no clone"), { code }); });
    const writes = spyOn(fs, "writeSync");
    let digest: { size: number; sha256: string };
    let written: number;
    try { digest = backupFile(f.paths[0]!, target); written = writes.mock.calls.length; }
    finally { copies.mockRestore(); writes.mockRestore(); }
    expect(written!).toBeGreaterThan(0);
    expect(digest!).toEqual({ size: 4096, sha256: sha256(fs.readFileSync(f.paths[0]!)) });
    expect(sha256(fs.readFileSync(target))).toBe(digest!.sha256);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  test.each(["EACCES", "ENOSPC", "EEXIST"])("다른 실패(%s)는 바이트 복사로 넘기지 않고 그대로 실패한다", (code) => {
    const f = home(1);
    const copies = spyOn(fs, "copyFileSync").mockImplementation(() => { throw Object.assign(new Error("clone failed"), { code }); });
    const writes = spyOn(fs, "writeSync");
    let written: number;
    try { expect(() => backupFile(f.paths[0]!, join(f.runtime.dir, "copy.bin"))).toThrow("clone failed"); written = writes.mock.calls.length; }
    finally { copies.mockRestore(); writes.mockRestore(); }
    expect(written!).toBe(0);
  });

  test("연 뒤 이름이 다른 파일(링크)로 바뀌거나 clone 하는 동안 원본이 바뀌면 실패한다", () => {
    const f = home(1, 4096);
    const elsewhere = join(f.runtime.paths.work, "elsewhere.bin");
    fs.writeFileSync(elsewhere, randomBytes(4096));
    const original = fs.copyFileSync;
    let spy = spyOn(fs, "copyFileSync").mockImplementation(((source: string, destination: string, mode?: number) => {
      fs.renameSync(source, `${source}.moved`);
      fs.symlinkSync(elsewhere, source);
      return original(source, destination, mode);
    }) as typeof fs.copyFileSync);
    try { expect(() => backupFile(f.paths[0]!, join(f.runtime.dir, "swapped.bin"))).toThrow("Backup input changed during copy"); }
    finally { spy.mockRestore(); }
    fs.unlinkSync(f.paths[0]!);
    fs.renameSync(`${f.paths[0]!}.moved`, f.paths[0]!);
    spy = spyOn(fs, "copyFileSync").mockImplementation(((source: string, destination: string, mode?: number) => {
      original(source, destination, mode);
      fs.appendFileSync(source, "later");
    }) as typeof fs.copyFileSync);
    try { expect(() => backupFile(f.paths[0]!, join(f.runtime.dir, "changed.bin"))).toThrow("Backup input changed during copy"); }
    finally { spy.mockRestore(); }
  });

  test("clone 이 되면 남은 공간 검사는 새로 쓰는 DB 사본만 센다(첨부는 공간을 쓰지 않는다)", () => {
    const f = home(2, 1024 * 1024);
    if (!clonesHere(f.runtime.dir)) throw new Error("이 시험은 APFS 임시 폴더가 필요합니다");
    const database = fs.statSync(join(f.home, "iamceo.db")).size;
    const free = () => Math.ceil(database * 1.5) + 4096;
    expect(createBackup({ home: f.home, backupDir: f.root, now: new Date(at), freeBytes: free }).manifest.attachments).toHaveLength(2);
    // clone 이 안 되는 볼륨이면 첨부 2 MB 까지 세어 같은 공간으로는 시작하지 않는다.
    const copies = spyOn(fs, "copyFileSync").mockImplementation(() => { throw Object.assign(new Error("no clone"), { code: "ENOTSUP" }); });
    try { expect(() => createBackup({ home: f.home, backupDir: f.root, now: new Date("2026-11-08T00:00:00.000Z"), freeBytes: free })).toThrow("storage_full"); }
    finally { copies.mockRestore(); }
    expect(listBackups(f.root)).toHaveLength(1);
  });
});

describe("DB 검사·VACUUM INTO·DB 해시는 작업 스레드에서 돈다", () => {
  async function outcome(work: BackupTask, offload: boolean) {
    try { return { ok: true, value: await runBackupTask(work, { offload }) }; }
    catch (error) { const e = error as { name?: string; message?: string; code?: string }; return { ok: false, name: e.name, message: e.message, code: e.code }; }
  }

  function fixtureDatabases(dir: string) {
    const valid = join(dir, "valid.db");
    openDb(valid).close();
    const future = join(dir, "future.db");
    const futureDb = new Database(future); futureDb.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`); futureDb.close();
    const empty = join(dir, "empty.db");
    const emptyDb = new Database(empty); emptyDb.exec("CREATE TABLE t(x)"); emptyDb.close();
    const orphan = join(dir, "orphan.db");
    const orphanDb = openDb(orphan);
    orphanDb.exec("PRAGMA foreign_keys = OFF");
    orphanDb.query("INSERT INTO messages (id,project_id,at,kind) VALUES ('m','missing-project',?,'일반')").run(at);
    orphanDb.close();
    const corrupt = join(dir, "corrupt.db");
    const corruptDb = new Database(corrupt);
    corruptDb.exec("PRAGMA user_version = 1; CREATE TABLE t(x); CREATE INDEX t_x ON t(x)");
    const insert = corruptDb.query("INSERT INTO t VALUES (?)");
    for (let i = 0; i < 2000; i++) insert.run(randomBytes(64).toString("hex"));
    corruptDb.close();
    const bytes = fs.readFileSync(corrupt);
    randomBytes(4096).copy(bytes, 4096 * 3);
    fs.writeFileSync(corrupt, bytes);
    const file = join(dir, "file.bin");
    fs.writeFileSync(file, randomBytes(300_000));
    const link = join(dir, "link.bin");
    fs.symlinkSync(file, link);
    return { valid, future, empty, orphan, corrupt, missing: join(dir, "missing.db"), file, link, dir };
  }

  test("작업 스레드와 이 스레드의 결과·실패(이름·문구·코드)가 같다", async () => {
    const f = home(0);
    const d = fixtureDatabases(f.runtime.paths.work);
    const tasks: BackupTask[] = [
      ...[d.valid, d.future, d.empty, d.orphan, d.corrupt, d.missing].map((path) => ({ op: "check" as const, path, maxVersion: MIGRATIONS.length })),
      ...[d.file, d.link, d.dir, d.missing].map((path) => ({ op: "digest" as const, path })),
      { op: "vacuum", source: d.missing, target: join(d.dir, "never.db") },
      { op: "vacuum", source: d.valid, target: d.file },
    ];
    for (const work of tasks) {
      const here = await outcome(work, false);
      const worker = await outcome(work, true);
      expect({ work, result: worker }).toEqual({ work, result: here });
    }
    // 실패만 같은 게 아니다: 고른 것들은 실제로 실패하고, 온전한 DB 는 통과한다.
    expect(await outcome({ op: "check", path: d.valid, maxVersion: MIGRATIONS.length }, true)).toEqual({ ok: true, value: MIGRATIONS.length });
    for (const [path, message] of [[d.future, "Unsupported backup DB schema"], [d.empty, "Unsupported backup DB schema"], [d.orphan, "Backup DB foreign key check failed"]] as const) {
      expect(await outcome({ op: "check", path, maxVersion: MIGRATIONS.length }, true)).toMatchObject({ ok: false, message });
    }
    expect(await outcome({ op: "check", path: d.corrupt, maxVersion: MIGRATIONS.length }, true)).toMatchObject({ ok: false });
    expect(await outcome({ op: "digest", path: d.file }, true)).toEqual({ ok: true, value: { size: 300_000, sha256: sha256(fs.readFileSync(d.file)) } });
    expect(await outcome({ op: "digest", path: d.link }, true)).toMatchObject({ ok: false, code: "ELOOP" });
    // VACUUM INTO 는 두 쪽 다 같은 DB 를 만든다.
    for (const offload of [false, true]) {
      const target = join(d.dir, `vacuum-${offload}.db`);
      expect(await outcome({ op: "vacuum", source: d.valid, target }, offload)).toEqual({ ok: true, value: null });
      expect(await outcome({ op: "check", path: target, maxVersion: MIGRATIONS.length }, offload)).toEqual({ ok: true, value: MIGRATIONS.length });
    }
  });

  test("정기 백업이 DB 검사를 하는 동안에도 서버 스레드가 돈다(같은 백업을 이 스레드에서 할 때보다 훨씬 짧게 멈춘다)", async () => {
    const f = home(2);
    // DB 를 키워 무결성 검사·VACUUM INTO 가 눈에 띄게 걸리게 한다.
    f.db.exec("CREATE TABLE bulk (x BLOB)");
    const insert = f.db.query("INSERT INTO bulk VALUES (?)");
    f.db.transaction(() => { for (let i = 0; i < 12_000; i++) insert.run(randomBytes(4000)); })();
    f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const stall = async (offload: boolean, now: string) => {
      const manager = new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date(now), sliceMs: 0, offload });
      let last = performance.now(), worst = 0;
      const timer = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; }, 1);
      try { expect(await manager.run(true)).not.toBeNull(); } finally { clearInterval(timer); }
      return worst;
    };
    const here = await stall(false, at);
    const worker = await stall(true, "2026-11-08T00:00:00.000Z");
    // 이 Mac 이 너무 빨라 이 스레드에서도 거의 멈추지 않으면 비교할 것이 없다. 그때는 더 나빠지지만 않았는지만 본다.
    if (here >= 40) expect(worker).toBeLessThan(here / 2);
    else expect(worker).toBeLessThan(here + 20);
    expect(listBackups(f.root)).toHaveLength(2);
  }, 30_000);

  test("검증할 때 큰 첨부(8 MB 이상)와 DB 파일은 작업 스레드가 읽고, 작은 첨부는 예전처럼 이 스레드에서 읽는다", async () => {
    const f = home(2, 4096);
    const big = join(f.home, "uploads", "a_bigfile00000", "big.bin");
    fs.mkdirSync(join(f.home, "uploads", "a_bigfile00000"), { mode: 0o700 });
    fs.writeFileSync(big, randomBytes(9 * 1024 * 1024), { mode: 0o600 });
    f.db.query("INSERT INTO attachments (id,name,mime,size,path,created_at) VALUES (?,?,?,?,?,?)").run("a_big", "big.bin", "application/octet-stream", 9 * 1024 * 1024, big, at);
    const snapshot = createBackup({ home: f.home, backupDir: f.root, now: new Date(at) });
    const bigEntry = snapshot.manifest.attachments.find((entry) => entry.id === "a_big")!;
    const opens = watchOpens();
    let created: Awaited<ReturnType<BackupManager["run"]>>;
    // 표시가 없는 스냅샷이라 다시 뜬 서버가 끝까지 검증한다.
    try { created = await new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date("2026-11-07T06:00:00.000Z") }).run(); }
    finally { opens.restore(); }
    expect(created!).toBeNull();
    expect(opens.count(join(snapshot.directory, bigEntry.path), join(snapshot.directory, "iamceo.db"))).toBe(0);
    expect(opens.count(join(snapshot.directory, "attachments") + "/")).toBe(2);
    expect(fs.existsSync(join(snapshot.directory, ".verified.json"))).toBe(true);
  });

  test("컴파일한 실행 파일에서도 작업 스레드가 뜬다(추가 진입점 없이)", async () => {
    const f = home(0);
    const work = f.runtime.paths.work;
    const database = join(work, "probe.db");
    openDb(database).close();
    const file = join(work, "probe.bin");
    fs.writeFileSync(file, randomBytes(70_000));
    const entry = join(work, "worker-entry.ts");
    fs.writeFileSync(entry, `import { runBackupTask } from ${JSON.stringify(join(import.meta.dir, "..", "server", "backup.ts"))};
const [database, file] = process.argv.slice(2);
const check = await runBackupTask({ op: "check", path: database, maxVersion: ${MIGRATIONS.length} }, { offload: true });
const digest = await runBackupTask({ op: "digest", path: file }, { offload: true });
console.log(JSON.stringify({ check, digest }));
`);
    const binary = join(work, "worker-probe");
    const compile = Bun.spawn([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", entry, "--outfile", binary], { env: f.runtime.childEnv(), cwd: work, stdout: "pipe", stderr: "pipe" });
    expect(await compile.exited).toBe(0);
    const run = Bun.spawn([binary, database, file], { env: f.runtime.childEnv(), cwd: work, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ check: MIGRATIONS.length, digest: { size: 70_000, sha256: sha256(fs.readFileSync(file)) } });
    expect(stderr).not.toContain("작업 스레드를 쓸 수 없어");
  }, 60_000);

  test("작업 스레드를 띄울 수 없으면 한 번 알리고 예전처럼 이 스레드에서 백업한다", async () => {
    const f = home(2);
    const script = join(f.runtime.paths.work, "no-worker.ts");
    fs.writeFileSync(script, `globalThis.Worker = class { constructor() { throw new Error("no workers in this fixture"); } };
const { BackupManager } = await import(${JSON.stringify(join(import.meta.dir, "..", "server", "backup.ts"))});
const [home, root] = process.argv.slice(2);
let now = Date.parse(${JSON.stringify(at)});
const manager = new BackupManager({ home, backupDir: root, now: () => new Date(now) });
const first = await manager.run();
now += 86_400_000;
const second = await manager.run();
console.log(JSON.stringify({ first: !!first, second: !!second }));
`);
    f.db.close(); databases.splice(databases.indexOf(f.db), 1);
    const child = Bun.spawn([process.execPath, script, f.home, f.root], { env: f.runtime.childEnv(), cwd: f.runtime.paths.work, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ first: true, second: true });
    expect(stderr.split("작업 스레드를 쓸 수 없어").length - 1).toBe(1);
    expect(listBackups(f.root)).toHaveLength(2);
  }, 30_000);
});

describe("끝까지 검증한 스냅샷은 재시작 뒤에도 다시 해시하지 않는다", () => {
  test("재시작한 서버는 표시가 맞는 가장 최근 스냅샷을 다시 읽지 않고 주기를 정한다", async () => {
    const f = home(3);
    const first = (await new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date(at) }).run())!;
    expect(fs.existsSync(join(first.directory, ".verified.json"))).toBe(true);
    const opens = watchOpens();
    try {
      const restarted = new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date("2026-11-07T06:00:00.000Z") });
      expect(await restarted.run()).toBeNull();
      expect(restarted.status().lastSuccessAt).toBe(at);
    } finally { opens.restore(); }
    expect(opens.count(join(first.directory, "attachments") + "/", join(first.directory, "iamceo.db"))).toBe(0);
  });

  test.each(["내용", "표시의 id", "표시 형식", "표시가 링크"] as const)("%s 이(가) 맞지 않으면 처음부터 끝까지 검증한다", async (fault) => {
    const f = home(2);
    const first = (await new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date(at) }).run())!;
    const mark = join(first.directory, ".verified.json");
    const value = JSON.parse(fs.readFileSync(mark, "utf8"));
    if (fault === "내용") fs.writeFileSync(join(first.directory, first.manifest.attachments[0]!.path), randomBytes(64));
    if (fault === "표시의 id") fs.writeFileSync(mark, JSON.stringify({ ...value, id: "snapshot-0000000000000-00000000-0000-0000-0000-000000000000" }));
    if (fault === "표시 형식") fs.writeFileSync(mark, JSON.stringify({ ...value, extra: true }));
    if (fault === "표시가 링크") { const copy = join(f.runtime.paths.work, "mark.json"); fs.renameSync(mark, copy); fs.symlinkSync(copy, mark); }
    const opens = watchOpens();
    let created: Awaited<ReturnType<BackupManager["run"]>>;
    try { created = await new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date("2026-11-07T06:00:00.000Z") }).run(); }
    finally { opens.restore(); }
    expect(opens.count(join(first.directory, "attachments") + "/")).toBeGreaterThan(0);
    // 손상된 최근 것은 성공으로 치지 않으므로 새로 만든다. 표시만 틀린 것은 다시 검증해 통과하고 주기 안이라 만들지 않는다.
    if (fault === "내용") expect(created!).not.toBeNull();
    else {
      expect(created!).toBeNull();
      expect(JSON.parse(fs.readFileSync(join(first.directory, ".verified.json"), "utf8"))).toEqual(value);
    }
  });

  test("재시작 뒤 다음 날 정리는 남길 것을 다시 해시하지 않고, 지울 것만 지우기 직전에 끝까지 검증한다", async () => {
    const f = home(2);
    let now = Date.parse("2026-11-05T00:00:00.000Z");
    const policy = { daily: 2, weekly: 0 };
    const first = (await new BackupManager({ home: f.home, backupDir: f.root, policy, now: () => new Date(now) }).run())!;
    now += DAY;
    const second = (await new BackupManager({ home: f.home, backupDir: f.root, policy, now: () => new Date(now) }).run())!;
    now += DAY;
    const opens = watchOpens();
    let third: Awaited<ReturnType<BackupManager["run"]>>;
    try { third = await new BackupManager({ home: f.home, backupDir: f.root, policy, now: () => new Date(now) }).run(); }
    finally { opens.restore(); }
    expect(opens.count(join(second.directory, "attachments") + "/")).toBe(0);
    expect(opens.count(join(first.directory, "attachments") + "/")).toBe(2);
    expect(fs.existsSync(first.directory)).toBe(false);
    expect(listBackups(f.root).map((snapshot) => snapshot.manifest.id)).toEqual([third!.manifest.id, second.manifest.id]);
  });

  test("표시 파일은 manifest 밖이라 검증·목록·복원(예전 서버 포함)이 그대로이고, 복원한 홈으로 따라가지 않는다", async () => {
    const f = home(2);
    const snapshot = (await new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date(at) }).run())!;
    expect(fs.existsSync(join(snapshot.directory, ".verified.json"))).toBe(true);
    expect(verifyBackup(snapshot.directory).manifest.id).toBe(snapshot.manifest.id);
    expect(listBackups(f.root).map((item) => item.manifest.id)).toEqual([snapshot.manifest.id]);
    const destination = join(f.runtime.dir, "restored");
    expect(restoreBackup({ snapshotDir: snapshot.directory, destinationHome: destination }).outboundEnabled).toBe(false);
    expect(fs.readdirSync(destination).some((name) => name.includes("verified"))).toBe(false);
  });
});

describe("배포·앱 설치 직전 사본은 종류마다 최근 3개만 남긴다", () => {
  function stamp(ms: number): string {
    const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function copies(root: string, outside: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const age = (path: string, ms: number) => { const time = new Date(now - ms); fs.utimesSync(path, time, time); };
    const pre = (rev: string, ms: number, extra: (dir: string) => void = () => {}) => {
      const name = `pre-${rev}-${stamp(now - ms)}`, dir = join(root, name);
      fs.mkdirSync(dir);
      for (const file of ["iamceo.db", "old-rev.txt", "com.iamceo.server.plist"]) fs.writeFileSync(join(dir, file), file);
      extra(dir);
      age(dir, ms);
      return name;
    };
    const app = (label: string, ms: number, extra: (dir: string) => void = () => {}) => {
      const name = `app-pre-${label}-${stamp(now - ms)}`, dir = join(root, name);
      fs.mkdirSync(join(dir, "IAMCEO.app", "Contents", "MacOS"), { recursive: true });
      fs.writeFileSync(join(dir, "IAMCEO.app", "Contents", "MacOS", "IAMCEO"), "binary");
      fs.symlinkSync(outside, join(dir, "IAMCEO.app", "Contents", "Outside"));
      extra(dir);
      age(dir, ms);
      return name;
    };
    return { now, pre, app, age };
  }

  test("최근 3개와 하루가 안 된 것은 남기고, 나머지만 지운다. 안쪽 링크는 따라가지 않는다", () => {
    const f = home(0);
    const outside = join(f.runtime.paths.work, "outside");
    fs.mkdirSync(outside); fs.writeFileSync(join(outside, "keep.txt"), "남아야 한다");
    const c = copies(f.root, outside);
    const pres = [1, 2, 3, 4, 5, 6].map((days) => c.pre(`abc000${days}`, days * DAY + 60_000));
    const apps = ["0.2.1", "0.2.2", "0.2.3", "v0.2.4", "beefcafe"].map((label, i) => c.app(label, (i + 1) * 2 * DAY));
    // 이름은 오래됐지만 방금 고친(옮겨 넣은) 사본, 수정 시각이 미래인(시계가 틀린) 사본은 최근 3개 밖이어도 남긴다.
    const touched = c.pre("abc0007", 9 * DAY);
    c.age(join(f.root, touched), 60_000);
    const skewed = c.pre("abc0008", 8 * DAY);
    c.age(join(f.root, skewed), -3 * 3_600_000);
    const removed = pruneInstallCopies(f.root);
    expect(removed.sort()).toEqual([...pres.slice(3), ...apps.slice(3)].sort());
    expect(fs.readdirSync(f.root).filter((name) => name !== ".owner.lock").sort()).toEqual([...pres.slice(0, 3), touched, skewed, ...apps.slice(0, 3)].sort());
    expect(fs.readFileSync(join(outside, "keep.txt"), "utf8")).toBe("남아야 한다");
    expect(INSTALL_COPY_RETENTION).toEqual({ keep: 3, minAgeMs: DAY });
  });

  test("이름·모양이 다르거나 확실하지 않은 것은 지우지 않는다", () => {
    const f = home(0);
    const outside = join(f.runtime.paths.work, "outside");
    fs.mkdirSync(outside);
    const c = copies(f.root, outside);
    for (let i = 1; i <= 3; i++) { c.pre(`fff000${i}`, i * 3_600_000); c.app(`0.9.${i}`, i * 3_600_000); }
    const old = 30 * DAY;
    const nested = c.pre("abc0001", old, (dir) => fs.mkdirSync(join(dir, "sub")));
    const twoApps = c.app("0.1.0", old, (dir) => fs.mkdirSync(join(dir, "Other.app")));
    const fifo = c.app("0.1.1", old, (dir) => { Bun.spawnSync(["/usr/bin/mkfifo", join(dir, "IAMCEO.app", "pipe")]); });
    const badDate = join(f.root, "pre-abc0002-20261340-250000");
    fs.mkdirSync(badDate);
    const notHex = join(f.root, "pre-zzzzzzz-20200101-000000");
    fs.mkdirSync(notHex);
    const file = join(f.root, "pre-abc0003-20200101-000000");
    fs.writeFileSync(file, "a file, not a copy folder");
    const target = join(f.runtime.paths.work, "linked-copy");
    fs.mkdirSync(target); fs.writeFileSync(join(target, "iamceo.db"), "linked");
    const link = join(f.root, "pre-abc0004-20200101-000000");
    fs.symlinkSync(target, link);
    const other = ["snapshot-1794148277150-00000000-0000-0000-0000-000000000000", ".pending-00000000-0000-0000-0000-000000000000", "backup-before-x", "pre-abc0005"];
    for (const name of other) fs.mkdirSync(join(f.root, name));
    const removed = pruneInstallCopies(f.root);
    expect(removed).toEqual([]);
    for (const name of [nested, twoApps, fifo]) expect(fs.existsSync(join(f.root, name))).toBe(true);
    for (const path of [badDate, notHex, file, link, ...other.map((name) => join(f.root, name))]) expect(fs.existsSync(path)).toBe(true);
    expect(fs.readFileSync(join(target, "iamceo.db"), "utf8")).toBe("linked");
  });

  test("정기 백업은 스냅샷을 만들기 전에 정리하고(공간이 모자라 스냅샷을 못 만들어도), 지운 이름을 한 줄로 남긴다", async () => {
    const f = home(1);
    // 배포·설치 절차가 쓰는 기본 자리(<홈>/backups)다.
    const root = join(f.home, "backups");
    const outside = join(f.runtime.paths.work, "outside");
    fs.mkdirSync(outside);
    const c = copies(root, outside);
    const names = [1, 2, 3, 4, 5].map((days) => c.pre(`abc000${days}`, days * DAY));
    const lines: string[] = [];
    const manager = new BackupManager({ home: f.home, backupDir: root, now: () => new Date(c.now), freeBytes: () => 1, log: (line) => lines.push(line) });
    await manager.tick();
    expect(manager.status()).toMatchObject({ failing: true, cause: "storage_full" });
    expect(fs.readdirSync(root).filter((name) => name.startsWith("pre-")).sort()).toEqual(names.slice(0, 3).sort());
    const pruned = lines.filter((line) => line.includes("배포·설치 직전 사본"));
    expect(pruned).toHaveLength(1);
    for (const name of names.slice(3)) expect(pruned[0]).toContain(name);
    expect(pruned[0]).not.toContain(f.home);
  });

  test("`iamceo backup --directory` 로 고른 다른 폴더의 같은 이름은 정기 백업이 건드리지 않는다", async () => {
    const f = home(1);
    const outside = join(f.runtime.paths.work, "outside");
    fs.mkdirSync(outside);
    const c = copies(f.root, outside);
    const names = [1, 2, 3, 4, 5].map((days) => c.pre(`abc000${days}`, days * DAY));
    expect(await new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date(c.now) }).run()).not.toBeNull();
    expect(fs.readdirSync(f.root).filter((name) => name.startsWith("pre-")).sort()).toEqual(names.sort());
  });
});

describe("이주 전 DB 사본(iamceo.db.pre-v*.bak)은 DB 를 열 때마다 정리한다", () => {
  test("이주가 없는 시작에도 최근 3개와 하루 안의 것만 남기고, 다른 이름은 건드리지 않는다", () => {
    const f = home(0);
    f.db.close(); databases.splice(databases.indexOf(f.db), 1);
    const now = Date.now();
    const name = (v: number, ms: number, id: string) => `iamceo.db.pre-v${v}-${now - ms}-${id}.bak`;
    const old = [name(12, 12 * DAY, "00000001"), name(13, 11 * DAY, "00000002"), name(14, 10 * DAY, "00000003"), name(15, 9 * DAY, "00000004"), name(16, 8 * DAY, "00000005")];
    const recent = [name(17, 3_600_000, "00000006"), name(18, 2 * 3_600_000, "00000007"), name(19, 3 * 3_600_000, "00000008"), name(20, 4 * 3_600_000, "00000009")];
    const foreign = ["other.db.pre-v3-1700000000000-00000001.bak", "iamceo.db.pre-v3-manual.bak", "backup-before-update.db"];
    for (const file of [...old, ...recent, ...foreign]) fs.writeFileSync(join(f.home, file), file);
    track(openDb(join(f.home, "iamceo.db")));
    const left = fs.readdirSync(f.home).filter((file) => file.includes(".pre-v") || file.startsWith("backup-before")).sort();
    // 하루 안의 4개는 모두 남고(3개를 넘어도), 하루가 지난 것은 최근 3개 밖이라 지운다.
    expect(left).toEqual([...recent, ...foreign].sort());
  });
});

describe("게시를 마친 업로드 기록은 .staging 에서 치운다", () => {
  test("하루 지난 게시 기록만 치우고, 파일·진행 중·실패·남은 칸이 있는 기록은 그대로 둔다", async () => {
    const f = home(0);
    const uploadsDir = join(f.home, "uploads");
    const source = join(f.runtime.paths.work, "source.png");
    fs.writeFileSync(source, "fixture bytes");
    const read = (publication: FilePublication) => JSON.parse(fs.readFileSync(join(publication.directory, "manifest.json"), "utf8")) as PublicationManifest;
    const published = async () => {
      const publication = new FilePublication(uploadsDir);
      const saved = await publication.stagePath(prepareImport(source));
      publication.publish(); publication.complete();
      return { publication, saved };
    };
    const done = await published();
    const fresh = await published();
    writePublicationManifest(fresh.publication.directory, { ...read(fresh.publication), createdAt: Date.now() + PUBLISHED_JOURNAL_GRACE_MS });
    const leftover = await published();
    fs.mkdirSync(join(leftover.publication.directory, read(leftover.publication).files[0]!.id));
    const active = new FilePublication(uploadsDir);
    await active.stagePath(prepareImport(source));
    const failed = new FilePublication(uploadsDir);
    await failed.stagePath(prepareImport(source));
    failed.fail({ isReferenced: () => false });
    const maintenance = new StorageMaintenance({ uploadsDir, inboxDir: join(f.home, "inbox"), backupDir: f.root, references: { isReferenced: () => true } });
    const doneId = read(done.publication).id;
    const result = maintenance.sweep(Date.now() + PUBLISHED_JOURNAL_GRACE_MS + 60_000);
    expect(result.cleared).toEqual([doneId]);
    expect(fs.existsSync(done.publication.directory)).toBe(false);
    for (const publication of [fresh.publication, leftover.publication, active, failed]) expect(fs.existsSync(publication.directory)).toBe(true);
    for (const saved of [done.saved, fresh.saved, leftover.saved]) expect(fs.readFileSync(saved.path, "utf8")).toBe("fixture bytes");
    // 치울 것이 없으면 결과 모양은 예전 그대로다.
    expect(maintenance.sweep(Date.now()).cleared).toBeUndefined();
    expect(PUBLISHED_JOURNAL_BUDGET_MS).toBeLessThanOrEqual(250);
  });
});

describe("보관 프로젝트 지우기의 참조 확인은 예전 질의와 같은 첨부를 남긴다", () => {
  /** 0.2.9 까지의 판정: 첨부마다 다른 프로젝트의 기록을 instr 로 훑는다. */
  function legacyFreed(db: Database, projectId: string): { id: string; path: string }[] {
    const candidates = new Set<string>();
    const collect = (raw: unknown) => {
      let refs: unknown;
      try { refs = JSON.parse(typeof raw === "string" ? raw : "[]"); } catch { return; }
      if (!Array.isArray(refs)) return;
      for (const ref of refs) {
        if (typeof ref === "string") candidates.add(ref);
        else if (ref && typeof ref === "object" && typeof (ref as { id?: unknown }).id === "string") candidates.add((ref as { id: string }).id);
      }
    };
    for (const r of db.query<{ v: unknown }, [string]>("SELECT attachments AS v FROM messages WHERE project_id = ?").all(projectId)) collect(r.v);
    for (const r of db.query<{ v: unknown }, [string]>("SELECT attachments AS v FROM files WHERE project_id = ?").all(projectId)) collect(r.v);
    for (const r of db.query<{ v: unknown }, [string]>("SELECT images AS v FROM decisions WHERE project_id = ?").all(projectId)) collect(r.v);
    for (const r of db.query<{ a: unknown; b: unknown }, [string]>("SELECT answer_attachments AS a, last_answer_attachments AS b FROM decisions WHERE project_id = ?").all(projectId)) { collect(r.a); collect(r.b); }
    for (const r of db.query<{ v: unknown }, [string]>("SELECT completion_file_ids AS v FROM todos WHERE project_id = ?").all(projectId)) collect(r.v);
    const elsewhere = (attachmentId: string) => !!db.query(`SELECT 1 FROM messages WHERE project_id != ?1 AND instr(attachments, ?2) > 0
        UNION ALL SELECT 1 FROM files WHERE project_id != ?1 AND instr(attachments, ?2) > 0
        UNION ALL SELECT 1 FROM decisions WHERE project_id != ?1 AND (instr(images, ?2) > 0 OR instr(COALESCE(answer_attachments, ''), ?2) > 0 OR instr(COALESCE(last_answer_attachments, ''), ?2) > 0)
        UNION ALL SELECT 1 FROM todos WHERE project_id != ?1 AND instr(completion_file_ids, ?2) > 0
        UNION ALL SELECT 1 FROM deliveries WHERE project_id != ?1 AND instr(text, ?2) > 0 LIMIT 1`).get(projectId, attachmentId);
    return [...candidates].filter((id) => !elsewhere(id))
      .map((id) => db.query<{ id: string; path: string }, [string]>("SELECT id, path FROM attachments WHERE id = ?").get(id))
      .filter((row): row is { id: string; path: string } => !!row);
  }

  function random(seed: number) {
    let state = seed >>> 0;
    return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  }

  function world(seed: number) {
    const rand = random(seed);
    const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
    const store = new Store(track(openDb(":memory:")), new Bus());
    const db = store.db;
    const target = store.createProject({ name: "지울 프로젝트", cwd: "/fixture", runnerEnabled: false }).id;
    const others = [store.createProject({ name: "남을 프로젝트", cwd: "/fixture", runnerEnabled: false }).id, store.createProject({ name: "보관한 다른 프로젝트", cwd: "/fixture", runnerEnabled: false }).id];
    const members = new Map([target, ...others].map((project) => [project, store.createMember({ projectId: project, handle: "lead", name: "총괄", kind: "conductor" }).id]));
    const alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const canonical = () => `a_${Array.from({ length: 12 }, () => pick([...alnum])).join("")}`;
    const ids: string[] = [];
    for (let i = 0; i < 24; i++) ids.push(canonical());
    // 서로의 앞부분이거나(접두), 모양이 다른 옛 id, 짧은 id.
    ids.push(`${ids[0]!}X`, ids[1]!.slice(0, 10), "legacy-attachment", "x9", "a_", `${ids[2]!.slice(0, 13)}`);
    for (const id of ids) if (rand() < 0.85) db.query("INSERT OR IGNORE INTO attachments (id,name,mime,size,path,created_at) VALUES (?,?,?,?,?,?)").run(id, "f", "text/plain", 1, `/uploads/${id}/f`, at);
    const ref = (id: string) => ({ id, name: "f.png", path: `/uploads/${id}/f.png`, size: 1, mime: "image/png" });
    const json = (count: number, shape: "object" | "string") => JSON.stringify(Array.from({ length: count }, () => shape === "object" ? ref(pick(ids)) : pick(ids)));
    const mention = () => pick([
      () => `첨부: /home/inbox/m/${pick(ids)}-photo.png`,
      () => `앞${pick(ids)}뒤`,
      () => pick(ids).slice(0, -1),
      () => `${pick(ids)}${pick(ids)}`,
      () => "첨부 없음",
    ])();
    let n = 0;
    const add = (project: string, density: number) => {
      const member = members.get(project)!;
      for (let i = 0; i < 6; i++) {
        db.query("INSERT INTO messages (id,project_id,at,kind,attachments) VALUES (?,?,?,?,?)").run(`m${n++}`, project, at, "일반", rand() < density ? json(1 + Math.floor(rand() * 3), "object") : "[]");
        db.query("INSERT INTO files (id,project_id,title,attachments,created_at,sort_order) VALUES (?,?,?,?,?,?)").run(`f${n++}`, project, "자료", rand() < density ? json(1, "object") : "[]", at, n);
        db.query("INSERT INTO decisions (id,project_id,who,title,status,images,answer_attachments,last_answer_attachments,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(`d${n++}`, project, "총괄", "결재", "open",
          rand() < density ? json(1, "object") : "[]", rand() < density ? json(1, "object") : rand() < 0.5 ? null : "[]", rand() < density / 2 ? json(1, "object") : null, at);
        db.query("INSERT INTO todos (id,project_id,title,completion_file_ids,created_at) VALUES (?,?,?,?,?)").run(`t${n++}`, project, "할 일", rand() < density ? json(1, "string") : "[]", at);
        db.query("INSERT INTO deliveries (id,project_id,member_id,kind,text,status,created_at) VALUES (?,?,?,?,?,?,?)").run(`v${n++}`, project, member, "message", rand() < density ? mention() : "글", "delivered", at);
      }
    };
    add(target, 0.9);
    for (const project of others) add(project, 0.25);
    db.query("UPDATE projects SET archived = 1 WHERE id IN (?, ?)").run(target, others[1]!);
    return { store, db, target };
  }

  test("임의로 만든 40개 세계에서 지우는 첨부(순서 포함)가 예전 판정과 같다", () => {
    let differentOutcomes = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const w = world(seed);
      const expected = legacyFreed(w.db, w.target);
      const deleted = w.store.deleteArchivedProject(w.target);
      expect({ seed, attachments: deleted.attachments }).toEqual({ seed, attachments: expected });
      for (const attachment of expected) expect(w.db.query("SELECT 1 FROM attachments WHERE id = ?").get(attachment.id)).toBeNull();
      if (expected.length) differentOutcomes++;
    }
    // 시험이 '아무것도 안 지움'만 비교하지 않았다.
    expect(differentOutcomes).toBeGreaterThan(20);
  });

  test("다른 프로젝트가 글자 그대로 가리키는 첨부는 남기고, 같은 프로젝트·없는 행·NULL 은 판정을 바꾸지 않는다", () => {
    const store = new Store(track(openDb(":memory:")), new Bus());
    const db = store.db;
    const target = store.createProject({ name: "지울", cwd: "/fixture", runnerEnabled: false }).id;
    const other = store.createProject({ name: "남을", cwd: "/fixture", runnerEnabled: false }).id;
    const member = store.createMember({ projectId: other, handle: "lead", name: "총괄", kind: "conductor" }).id;
    const ids = ["a_AAAAAAAAAAAA", "a_AAAAAAAAAAAAB", "a_BBBBBBBBBBBB", "a_CCCCCCCCCCCC", "a_DDDDDDDDDDDD", "legacy-1", ""];
    for (const id of ids) db.query("INSERT INTO attachments (id,name,mime,size,path,created_at) VALUES (?,?,?,?,?,?)").run(id, "f", "text/plain", 1, `/u/${id}`, at);
    db.query("INSERT INTO messages (id,project_id,at,kind,attachments) VALUES ('m1',?,?,'일반',?)").run(target, at, JSON.stringify(ids.map((id) => ({ id, path: `/u/${id}` }))));
    // 다른 프로젝트: 더 긴 id 의 앞부분으로만 나오는 짧은 id 도 instr 로는 '들어 있다'.
    db.query("INSERT INTO deliveries (id,project_id,member_id,kind,text,status,created_at) VALUES ('v1',?,?,'message',?,'delivered',?)").run(other, member, "첨부: /inbox/m/a_AAAAAAAAAAAAB-x.png", at);
    db.query("INSERT INTO decisions (id,project_id,who,title,status,images,answer_attachments,created_at) VALUES ('d1',?,'총괄','결재','open','[]',NULL,?)").run(other, at);
    db.query("INSERT INTO todos (id,project_id,title,completion_file_ids,created_at) VALUES ('t1',?,'할 일',?,?)").run(other, JSON.stringify(["legacy-1"]), at);
    db.query("INSERT INTO files (id,project_id,title,attachments,created_at,sort_order) VALUES ('f1',?,'자료',?,?,1)").run(target, JSON.stringify([{ id: "a_DDDDDDDDDDDD", path: "/u/d" }]), at);
    db.query("UPDATE projects SET archived = 1 WHERE id = ?").run(target);
    const expected = legacyFreed(db, target);
    const deleted = store.deleteArchivedProject(target);
    expect(deleted.attachments).toEqual(expected);
    expect(deleted.attachments.map((a) => a.id)).toEqual(["a_BBBBBBBBBBBB", "a_CCCCCCCCCCCC", "a_DDDDDDDDDDDD"]);
    for (const id of ["a_AAAAAAAAAAAA", "a_AAAAAAAAAAAAB", "legacy-1", ""]) expect(db.query("SELECT 1 AS ok FROM attachments WHERE id = ?").get(id)).toEqual({ ok: 1 });
  });
});
