// 업그레이드·되돌리기·제거가 함께 쓰는 서버 확인과 DB·폴더 다루기.
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { say } from "../cli-text.ts";
import type { Config } from "../config.ts";
import { acquireHomeOwner, HomeOwnershipError, type HomeOwner } from "../home-owner.ts";
import { LifecycleError } from "./launchd.ts";

/** 이 Mac 안에서 서버에 닿는 주소. bin/iamceo.ts 의 localUrl 과 같은 규칙이다. */
export function localBase(config: Pick<Config, "hosts" | "port">): string {
  const host = config.hosts.includes("127.0.0.1") || config.hosts.some(h => h === "0.0.0.0" || h === "localhost") ? "127.0.0.1" : config.hosts[0]!;
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`;
}

export interface ExpectedRuntime { buildId: string | null; version: string }
export type ReadinessCheck = (config: Config, expected: ExpectedRuntime, timeoutMs: number) => Promise<void>;

/**
 * 인증된 /api/readiness 로 '이 실행 파일이 떠서 복구까지 끝났다'를 확인한다. buildId 가 null 이면 버전만 대조한다.
 * 살아 있다(health)만으로는 어느 판이 떠 있는지 모른다.
 */
export async function waitReady(config: Config, expected: ExpectedRuntime, timeoutMs: number,
  options: { fetch?: typeof fetch; pollMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let reason = say("서버 응답 없음", "no answer from the server");
  do {
    try {
      const response = await (options.fetch ?? fetch)(`${localBase(config)}/api/readiness`, {
        headers: { Authorization: `Bearer ${config.accessCode}` }, redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, deadline - Date.now()))),
      });
      if (response.status === 401 || response.status === 403) throw new LifecycleError(say("서버가 접속 코드를 받지 않습니다", "The server refused the access code"));
      const body = await response.json().catch(() => null) as { ok?: boolean; daemon?: { ready?: boolean; buildId?: string; version?: string } | null } | null;
      const daemon = body?.daemon;
      if (response.status === 200 && body?.ok === true && daemon?.ready === true && daemon.version === expected.version &&
          (expected.buildId === null || daemon.buildId === expected.buildId)) return;
      reason = !daemon ? say(`준비 중(HTTP ${response.status})`, `starting (HTTP ${response.status})`)
        : daemon.version !== expected.version || (expected.buildId !== null && daemon.buildId !== expected.buildId)
          ? say(`다른 판이 떠 있음(${daemon.version ?? "?"})`, `a different build is running (${daemon.version ?? "?"})`)
          : say("복구가 끝나기를 기다리는 중", "waiting for recovery to finish");
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      reason = say("서버 응답 없음", "no answer from the server");
    }
    if (Date.now() < deadline) await Bun.sleep(Math.min(Math.max(1, options.pollMs ?? 500), Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new LifecycleError(say(`서버가 제한 시간 안에 준비되지 않았습니다: ${reason}`, `The server was not ready in time: ${reason}`));
}

/** 서버가 이 주소에서 아직 답하는가(인증 없는 /api/health). 연결이 거절되면 false. */
export async function serverAnswers(config: Pick<Config, "hosts" | "port">, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!config.port) return false;
  try {
    await fetchImpl(`${localBase(config)}/api/health`, { redirect: "error", signal: AbortSignal.timeout(2_000) });
    return true;
  } catch { return false; }
}

/** 다른 프로세스(내려가는 중인 서버)가 홈을 놓을 때까지 기다린다. */
export async function waitHomeOwner(home: string, timeoutMs: number, sleep: (ms: number) => Promise<unknown>): Promise<HomeOwner> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return acquireHomeOwner(home); }
    catch (error) {
      if (!(error instanceof HomeOwnershipError) || Date.now() >= deadline) {
        throw new LifecycleError(say(`서버가 데이터 폴더를 아직 쓰고 있습니다: ${home}`, `The server is still using the data folder: ${home}`));
      }
      await sleep(250);
    }
  }
}

/** DB 의 스키마 판. 쓰기 없이 읽는다. -shm 없이 남은 WAL DB 는 내용을 바꾸지 않는 읽기/쓰기 연결로 머리만 읽는다. */
export function databaseSchema(path: string): number {
  const read = (db: Database) => db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  let db: Database | undefined;
  try { db = new Database(path, { readonly: true }); return read(db); }
  catch (error) {
    db?.close();
    db = undefined;
    if ((error as { code?: string }).code !== "SQLITE_CANTOPEN") throw error;
    db = new Database(path, { readwrite: true, create: false });
    return read(db);
  } finally { db?.close(); }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * 원본은 읽기 전용으로만 연다. VACUUM INTO 가 반영된 WAL 까지 담은 독립 사본을 만들고, 사본을 무결성 검사한다.
 * 돌려주는 값은 사본의 스키마 판이다.
 */
export function snapshotDatabase(source: string, target: string): number {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    const db = new Database(source, { readonly: true });
    try { db.exec("PRAGMA busy_timeout = 5000"); db.query("VACUUM INTO ?").run(target); }
    finally { db.close(); }
  } catch (error) {
    // -shm 없이 남은 WAL DB 는 읽기 전용으로 못 연다. 반영되지 않은 WAL 이 없을 때만 파일을 그대로 복사한다.
    if ((error as { code?: string }).code !== "SQLITE_CANTOPEN" || (statSync(`${source}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0) throw error;
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
  chmodSync(target, 0o600);
  const copy = new Database(target, { readonly: true });
  try {
    const checks = copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (checks.length !== 1 || checks[0]!.integrity_check !== "ok") throw new LifecycleError(say("DB 사본의 무결성 검사가 실패했습니다", "The database copy failed its integrity check"));
    const version = copy.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    fsyncFile(target);
    return version;
  } finally { copy.close(); }
}

/**
 * 홈의 DB 를 사본으로 되돌린다. 지금 DB(-wal·-shm 포함)는 지우지 않고 aside 폴더로 옮긴다.
 * 호출하는 쪽이 홈 잠금을 쥐고 있어야 한다(서버가 꺼져 있다는 증거).
 */
export function restoreDatabase(owner: HomeOwner, snapshot: string, aside: string): void {
  const live = join(owner.home, "iamceo.db");
  if (!existsSync(snapshot)) throw new LifecycleError(say(`되돌릴 DB 사본이 없습니다: ${snapshot}`, `The database copy to restore is missing: ${snapshot}`));
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(live + suffix)) renameSync(live + suffix, join(aside, `iamceo.db${suffix}`));
  }
  const temp = join(owner.home, `.iamceo.db.restore-${process.pid}`);
  copyFileSync(snapshot, temp, constants.COPYFILE_EXCL);
  chmodSync(temp, 0o600);
  fsyncFile(temp);
  renameSync(temp, live);
  const dir = openSync(owner.home, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

/** 같은 볼륨이면 이름만 바꾼다. 다른 볼륨이면 ditto 로 복사한 뒤 원래 것을 지운다. */
export function moveBundle(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (existsSync(target)) throw new LifecycleError(say(`옮길 자리에 이미 무엇이 있습니다: ${target}`, `Something already exists at ${target}`));
  try { renameSync(source, target); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; }
  const copied = Bun.spawnSync(["/usr/bin/ditto", source, target], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  if (copied.exitCode !== 0) {
    try { rmSync(target, { recursive: true, force: true }); } catch { /* 반쯤 만든 사본 */ }
    throw new LifecycleError(say(`앱을 옮기지 못했습니다: ${copied.stderr.toString().trim()}`, `Could not move the app: ${copied.stderr.toString().trim()}`));
  }
  rmSync(source, { recursive: true });
}
