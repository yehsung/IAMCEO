import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { join } from "node:path";
import { BackupManager, createBackup, listBackups, verifyBackup } from "../server/backup.ts";
import { openDb } from "../server/db.ts";
import { acquireHomeOwner } from "../server/home-owner.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import type { IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const runtimes: IsolatedRuntime[] = [];
const databases: Database[] = [];
const at = "2026-11-07T00:00:00.000Z";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(async () => {
  for (const db of databases.splice(0).reverse()) db.close();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

function fixture(attachments = 6) {
  const runtime = createIsolatedRuntime();
  runtimes.push(runtime);
  const home = runtime.paths.iamceoHome;
  const root = join(runtime.dir, "backups");
  fs.mkdirSync(join(home, "uploads"), { mode: 0o700 });
  fs.writeFileSync(join(home, "config.json"), JSON.stringify({ accessCode: "fixture-secret", port: 0, hosts: ["127.0.0.1"] }), { mode: 0o600 });
  const db = openDb(join(home, "iamceo.db"));
  databases.push(db);
  db.query("INSERT INTO projects (id,name,cwd,runner_enabled,created_at,updated_at) VALUES ('p','보관할 기록',?,1,?,?)").run(join(home, "work"), at, at);
  const paths: string[] = [];
  for (let i = 0; i < attachments; i++) {
    const path = join(home, "uploads", `attachment-${i}.txt`);
    fs.writeFileSync(path, `원본 ${i}`, { mode: 0o600 });
    db.query("INSERT INTO attachments (id,name,mime,size,path,created_at) VALUES (?,?,?,?,?,?)").run(`a${i}`, `attachment-${i}.txt`, "text/plain", fs.statSync(path).size, path, at);
    paths.push(path);
  }
  const names = () => fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name !== ".owner.lock").sort() : [];
  return { runtime, home, root, db, paths, names };
}

describe("정기 백업은 서버를 멈추지 않는다", () => {
  test("파일 사이마다 이벤트 루프를 내주고, 그동안에도 홈 잠금을 놓지 않는다", async () => {
    const f = fixture();
    const manager = new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date(at), sliceMs: 0 });
    let turns = 0, homeUnlocked = 0, rootUnlocked = 0, finished = false;
    const spin = () => {
      if (finished) return;
      turns++;
      // 양보한 사이에 다른 작업이 끼어들면 안 된다: 만드는 동안은 홈을, 만들고 정리하는 내내 백업 폴더를 쥔다.
      if (!f.names().some((name) => name.startsWith("snapshot-"))) {
        try { acquireHomeOwner(f.home).release(); homeUnlocked++; } catch { /* 백업이 쥐고 있다. */ }
      }
      try { acquireHomeOwner(f.root).release(); rootUnlocked++; } catch { /* 백업이 쥐고 있다. */ }
      setImmediate(spin);
    };
    const job = manager.run();
    setImmediate(spin);
    const snapshot = await job;
    finished = true;
    expect(snapshot).not.toBeNull();
    // 첨부 6개를 복사하고 다시 검증하는 동안 다른 일이 여러 번 끼어들 수 있었다.
    expect(turns).toBeGreaterThanOrEqual(12);
    expect(homeUnlocked).toBe(0);
    expect(rootUnlocked).toBe(0);
    expect(verifyBackup(snapshot!.directory).manifest.attachments).toHaveLength(6);
    expect(f.names()).toEqual([snapshot!.manifest.id]);
    // 끝난 뒤에는 잠금이 풀려 있다.
    acquireHomeOwner(f.home).release();
    acquireHomeOwner(f.root).release();
    await manager.stop();
  });

  test("이 프로세스가 이미 쥔 홈에서는 그 소유권을 빌려 쓰고 끝나도 풀지 않는다", async () => {
    const f = fixture(2);
    const owner = acquireHomeOwner(f.home);
    try {
      const manager = new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date(at), sliceMs: 0 });
      expect((await manager.run())?.manifest.attachments).toHaveLength(2);
      expect(() => acquireHomeOwner(f.home)).toThrow("사용 중");
    } finally { owner.release(); }
  });

  test("재시작 뒤에는 가장 최근 스냅샷 하나만 다시 읽어 주기를 정한다", async () => {
    const f = fixture(2);
    const older = createBackup({ home: f.home, backupDir: f.root, now: new Date("2026-11-05T00:00:00.000Z") });
    const old = createBackup({ home: f.home, backupDir: f.root, now: new Date("2026-11-06T00:00:00.000Z") });
    const newest = createBackup({ home: f.home, backupDir: f.root, now: new Date(at) });
    const opened: string[] = [];
    const original = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(path));
      return (original as (...args: unknown[]) => number)(path, ...rest);
    }) as typeof fs.openSync);
    try {
      const manager = new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date("2026-11-07T12:00:00.000Z") });
      expect(await manager.run()).toBeNull();
      expect(await manager.run()).toBeNull();
    } finally { spy.mockRestore(); }
    const content = (directory: string) => opened.filter((path) => path.startsWith(directory) && !path.endsWith("manifest.json"));
    // 가장 최근 것은 첨부까지 한 번 검증하고, 나머지는 manifest만 읽는다.
    expect(content(newest.directory).filter((path) => path.includes("/attachments/"))).toHaveLength(2);
    expect(content(old.directory)).toEqual([]);
    expect(content(older.directory)).toEqual([]);
    expect(f.names()).toHaveLength(3);
  });

  test("가장 최근 스냅샷이 손상됐으면 그 앞의 온전한 것으로 주기를 정해 새 백업을 만든다", async () => {
    const f = fixture(2);
    const old = createBackup({ home: f.home, backupDir: f.root, now: new Date("2026-11-05T00:00:00.000Z") });
    const newest = createBackup({ home: f.home, backupDir: f.root, now: new Date(at) });
    // manifest는 멀쩡하고 내용만 같은 크기로 바뀌었다.
    fs.writeFileSync(join(newest.directory, newest.manifest.attachments[0]!.path), "변조 0");
    const now = new Date("2026-11-07T01:00:00.000Z");
    const created = await new BackupManager({ home: f.home, backupDir: f.root, now: () => now }).run();
    expect(created?.manifest.createdAt).toBe(now.toISOString());
    expect(listBackups(f.root).map((snapshot) => snapshot.manifest.id)).toEqual([created!.manifest.id, old.manifest.id]);
    expect(fs.existsSync(newest.directory)).toBe(true);
    // 온전한 최근 것이 있으면 주기 안에서는 다시 만들지 않는다.
    expect(await new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date("2026-11-07T02:00:00.000Z") }).run()).toBeNull();
  });

  test("같은 서버가 이미 검증한 보관분은 다시 해시하지 않고, 지울 것만 지우기 직전에 검증한다", async () => {
    const f = fixture(2);
    let now = new Date("2026-11-05T00:00:00.000Z");
    const manager = new BackupManager({ home: f.home, backupDir: f.root, policy: { daily: 2, weekly: 0 }, now: () => now });
    const first = (await manager.run())!;
    now = new Date("2026-11-06T00:00:00.000Z");
    const second = (await manager.run())!;
    const opened: string[] = [];
    const original = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(path));
      return (original as (...args: unknown[]) => number)(path, ...rest);
    }) as typeof fs.openSync);
    let third: Awaited<ReturnType<BackupManager["run"]>>;
    try {
      now = new Date(at);
      third = await manager.run();
    } finally { spy.mockRestore(); }
    const hashed = (directory: string) => opened.filter((path) => path.startsWith(join(directory, "attachments") + "/")).length;
    // 남는 것은 다시 읽지 않고, 보존 기간을 넘긴 것은 지우기 전에 한 번 끝까지 검증한다.
    expect(hashed(second.directory)).toBe(0);
    expect(hashed(first.directory)).toBe(2);
    expect(fs.existsSync(first.directory)).toBe(false);
    expect(listBackups(f.root).map((snapshot) => snapshot.manifest.id)).toEqual([third!.manifest.id, second.manifest.id]);
    expect(manager.lastError).toBeNull();
  });

  test("검증한 뒤 손상된 보관분은 지우지 않고 남기며, 정리와 다음 백업을 막지 않는다", async () => {
    const f = fixture(2);
    let now = new Date("2026-11-05T00:00:00.000Z");
    const manager = new BackupManager({ home: f.home, backupDir: f.root, policy: { daily: 1, weekly: 0 }, now: () => now });
    const first = (await manager.run())!;
    fs.writeFileSync(join(first.directory, first.manifest.attachments[0]!.path), "변조 0");
    now = new Date("2026-11-06T00:00:00.000Z");
    const second = (await manager.run())!;
    expect(manager.lastError).toBeNull();
    expect(fs.existsSync(first.directory)).toBe(true);
    now = new Date(at);
    const third = (await manager.run())!;
    expect(manager.lastError).toBeNull();
    expect(fs.existsSync(first.directory)).toBe(true);
    expect(fs.existsSync(second.directory)).toBe(false);
    expect(listBackups(f.root).map((snapshot) => snapshot.manifest.id)).toEqual([third.manifest.id]);
  });

  test("타이머의 재시도는 실패가 이어질수록 간격을 늘리고, 성공하면 처음으로 돌아간다", async () => {
    const f = fixture(1);
    let now = Date.parse(at);
    const manager = new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date(now) });
    const original = fs.readFileSync(f.paths[0]!);
    fs.unlinkSync(f.paths[0]!);
    await manager.tick();
    expect(manager.lastError).not.toBeNull();
    const firstError = manager.lastError;
    // 원인이 사라져도 5분 안에는 타이머가 다시 돌리지 않는다.
    fs.writeFileSync(f.paths[0]!, original, { mode: 0o600 });
    now += 299_999;
    await manager.tick();
    expect(manager.lastError).toBe(firstError);
    expect(f.names()).toEqual([]);
    // 두 번째 실패 뒤에는 10분을 기다린다.
    fs.unlinkSync(f.paths[0]!);
    now += 1;
    await manager.tick();
    expect(manager.lastError).not.toBe(firstError);
    const secondError = manager.lastError;
    fs.writeFileSync(f.paths[0]!, original, { mode: 0o600 });
    now += 599_999;
    await manager.tick();
    expect(manager.lastError).toBe(secondError);
    expect(f.names()).toEqual([]);
    now += 1;
    await manager.tick();
    expect(manager.lastError).toBeNull();
    expect(f.names()).toHaveLength(1);
    // 성공한 뒤의 첫 실패는 다시 5분부터다.
    fs.unlinkSync(f.paths[0]!);
    now += 86_400_000;
    await manager.tick();
    expect(manager.lastError).not.toBeNull();
    fs.writeFileSync(f.paths[0]!, original, { mode: 0o600 });
    now += 300_000;
    await manager.tick();
    expect(manager.lastError).toBeNull();
    expect(f.names()).toHaveLength(2);
    await manager.stop();
  });

  test("직접 부른 run()은 실패 직후에도 바로 다시 시도한다", async () => {
    const f = fixture(1);
    const manager = new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date(at) });
    const original = fs.readFileSync(f.paths[0]!);
    fs.unlinkSync(f.paths[0]!);
    await expect(manager.run()).rejects.toThrow();
    fs.writeFileSync(f.paths[0]!, original, { mode: 0o600 });
    expect(await manager.run()).not.toBeNull();
  });

  test("종료는 진행 중인 백업을 기다리지 않고, 만들던 스테이징을 남기지 않는다", async () => {
    const f = fixture();
    const manager = new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date(at), sliceMs: 0 });
    const job = manager.run();
    for (let i = 0; i < 10_000 && !f.names().some((name) => name.startsWith(".pending-")); i++) await turn();
    expect(f.names().some((name) => name.startsWith(".pending-"))).toBe(true);
    await manager.stop();
    expect(await job).toBeNull();
    expect(manager.lastError).toBeNull();
    expect(f.names()).toEqual([]);
    // 잠금이 풀렸고, 다음 실행은 처음부터 다시 만든다.
    acquireHomeOwner(f.home).release();
    acquireHomeOwner(f.root).release();
    expect((await manager.run())?.manifest.attachments).toHaveLength(6);
    expect(f.names()).toHaveLength(1);
  });
});

describe("강제 종료로 남은 백업 스테이징", () => {
  test("오래된 .pending-<uuid>만 다음 백업 때 지우고, 방금 것·다른 이름·링크는 건드리지 않는다", () => {
    const f = fixture(1);
    fs.mkdirSync(f.root, { mode: 0o700 });
    const stale = join(f.root, ".pending-11111111-2222-4333-8444-555555555555");
    const fresh = join(f.root, ".pending-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const unrelated = join(f.root, ".pending-unrelated");
    const linked = join(f.root, ".pending-99999999-2222-4333-8444-555555555555");
    const target = join(f.runtime.paths.work, "linked");
    for (const directory of [stale, fresh, unrelated, target]) {
      fs.mkdirSync(join(directory, "attachments"), { recursive: true });
      fs.writeFileSync(join(directory, "attachments", "0.bin"), "남은 조각");
    }
    fs.symlinkSync(target, linked);
    const past = new Date(Date.now() - 2 * 3_600_000);
    for (const path of [stale, unrelated, target]) fs.utimesSync(path, past, past);
    fs.lutimesSync(linked, past, past);
    const snapshot = createBackup({ home: f.home, backupDir: f.root, now: new Date(at) });
    expect(f.names()).toEqual([".pending-99999999-2222-4333-8444-555555555555", ".pending-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", ".pending-unrelated", snapshot.manifest.id].sort());
    expect(fs.existsSync(stale)).toBe(false);
    for (const directory of [fresh, unrelated, target]) expect(fs.readFileSync(join(directory, "attachments", "0.bin"), "utf8")).toBe("남은 조각");
    expect(listBackups(f.root)).toHaveLength(1);
  });
});

describe("store-5: 백업 실패가 보이고, 공간이 모자라면 쓰기 전에 그만둔다", () => {
  test("남은 공간이 스냅샷의 1.5배에 못 미치면 아무것도 쓰지 않고 storage_full 로 실패한다", () => {
    const f = fixture(2);
    expect(() => createBackup({ home: f.home, backupDir: f.root, now: new Date(at), freeBytes: () => 1 })).toThrow("storage_full");
    expect(fs.existsSync(f.root) ? fs.readdirSync(f.root).filter(name => name.startsWith("snapshot-")) : []).toHaveLength(0);
    // 남은 공간을 알 수 없으면 예전처럼 진행한다.
    expect(createBackup({ home: f.home, backupDir: f.root, now: new Date(at), freeBytes: () => { throw new Error("statfs unavailable"); } }).manifest.attachments).toHaveLength(2);
  });

  test("실패 원인은 경로 없이 한 줄로 한 번만 남고, 진단 상태에서 읽을 수 있다", async () => {
    const f = fixture(2);
    let now = Date.parse(at), free = 1;
    const lines: string[] = [];
    const manager = new BackupManager({ home: f.home, backupDir: f.root, now: () => new Date(now), freeBytes: () => free, log: line => lines.push(line) });
    expect(manager.status()).toEqual({ lastSuccessAt: null, failing: false, failures: 0, cause: null, nextAttemptAt: null });
    await manager.tick();
    expect(manager.status()).toMatchObject({ failing: true, failures: 1, cause: "storage_full", lastSuccessAt: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("storage_full"); expect(lines[0]).not.toContain(f.home);
    // 같은 실패가 이어지는 동안에는 되풀이해 적지 않는다.
    now += 6 * 60_000; await manager.tick();
    expect(manager.status().failures).toBe(2);
    expect(lines).toHaveLength(1);
    free = Number.MAX_SAFE_INTEGER; now += 11 * 60_000; await manager.tick();
    expect(manager.status()).toMatchObject({ failing: false, failures: 0, cause: null, nextAttemptAt: null, lastSuccessAt: new Date(now).toISOString() });
    expect(lines).toHaveLength(2); expect(lines[1]).toContain("다시 성공");
  });
});
