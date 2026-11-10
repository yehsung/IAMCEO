// 설치 전 확인 스크립트(scripts/smoke-db.ts): 원본은 읽기만 하고, 사본을 격리된 서버로 열어 본다.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { parseSmokeOptions, renderSmokeReport } from "../scripts/smoke-db.ts";

const script = resolve(import.meta.dir, "../scripts/smoke-db.ts");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-smoke-test-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const scratch = join(dir, "scratch"), path = join(dir, "data", "iamceo.db");
  mkdirSync(scratch); mkdirSync(join(dir, "data"));
  const db = openDb(path), store = new Store(db, new Bus());
  const project = store.createProject({ name: "비공개이름", cwd: dir });
  store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: "SECRET-BODY 본문" });
  store.patchProject(store.createProject({ name: "보관이름", cwd: dir }).id, { archived: true });
  db.close();
  const run = (args: string[]) => {
    const result = Bun.spawnSync([process.execPath, script, ...args], { env: { ...process.env, TMPDIR: scratch }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  return { dir, scratch, path, run, digest };
}

test("smoke-db: 사본을 이주·기동해 읽기 API 를 확인하고, 원본과 임시 폴더를 그대로 둔다", () => {
  const f = fixture(), before = f.digest(f.path);
  const result = f.run([f.path, "--budget-ms", "30000"]);
  expect(result.code, result.output).toBe(0);
  for (const step of ["copy (source opened read-only)", "startup (migrate, recover, listen)", "GET /api/readiness", "GET /api/bootstrap",
    "GET /api/sync?projectId", "GET state", "GET messages/page", "GET delivery-notices", "(archived): GET archive/state", "PRAGMA quick_check after migration", "shutdown", "smoke-db passed"]) expect(result.output).toContain(step);
  expect(result.output).not.toContain("FAIL");
  // 내용은 한 글자도 내보내지 않는다.
  for (const secret of ["SECRET-BODY", "비공개이름", "보관이름"]) expect(result.output).not.toContain(secret);
  expect(f.digest(f.path)).toBe(before);
  expect(readdirSync(f.scratch)).toEqual([]);
}, 120_000);

test("smoke-db: 예산을 넘긴 요청이 하나라도 있으면 실패로 끝난다", () => {
  const f = fixture();
  const result = f.run([f.path, "--budget-ms", "0"]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("FAIL over 0 ms");
  expect(result.output).toContain("smoke-db FAILED");
  expect(readdirSync(f.scratch)).toEqual([]);
}, 120_000);

test("smoke-db: DB 가 아닌 파일은 서버를 띄우지 않고 실패한다", () => {
  const f = fixture(), garbage = join(f.dir, "garbage.db");
  writeFileSync(garbage, "not a database ".repeat(400));
  const result = f.run([garbage]);
  expect(result.code).toBe(1);
  expect(result.output).toContain("copy (source opened read-only)");
  expect(result.output).not.toContain("startup (");
  expect(f.run([join(f.dir, "missing.db")]).code).toBe(1);
  expect(readdirSync(f.scratch)).toEqual([]);
}, 120_000);

test("smoke-db: -shm 없이 파일만 복사해 온 WAL DB 도 원본을 쓰기로 열지 않고 확인한다", () => {
  const f = fixture(), alone = join(f.dir, "alone"), copy = join(alone, "iamceo.db");
  mkdirSync(alone); copyFileSync(f.path, copy);
  const before = f.digest(copy);
  const result = f.run([copy, "--budget-ms", "30000"]);
  expect(result.code, result.output).toBe(0);
  expect(f.digest(copy)).toBe(before);
  expect(readdirSync(alone)).toEqual(["iamceo.db"]);
  expect(existsSync(`${copy}-shm`)).toBe(false);
}, 120_000);

test("smoke-db: 인자와 표", () => {
  expect(parseSmokeOptions(["a.db", "--budget-ms", "250", "--startup-budget-ms", "5000", "--keep"])).toEqual({ source: "a.db", budgetMs: 250, startupBudgetMs: 5000, keep: true });
  for (const args of [[], ["--keep"], ["a.db", "b.db"], ["a.db", "--unknown"], ["a.db", "--budget-ms"], ["a.db", "--budget-ms", "-1"]]) expect(() => parseSmokeOptions(args)).toThrow();
  const table = renderSmokeReport([{ step: "GET /api/health", ok: true, ms: 1.234, bytes: 29, detail: "" }, { step: "startup", ok: false, ms: 10, bytes: null, detail: "over 5 ms" }]);
  expect(table.split("\n")).toHaveLength(3);
  expect(table).toContain("ok");
  expect(table).toContain("FAIL over 5 ms");
});
