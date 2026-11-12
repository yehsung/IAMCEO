// 업그레이드 전 예행(iamceo upgrade-rehearse): 새 판이 DB 사본을 격리된 임시 홈에서 이주·기동·응답까지 해 본다. 원본은 읽기만 한다.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Bus } from "../server/bus.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { rehearseDatabase } from "../server/lifecycle/rehearse.ts";
import { Store } from "../server/store.ts";

const entry = resolve(import.meta.dir, "../bin/iamceo.ts");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-rehearse-test-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const scratch = join(dir, "scratch"), path = join(dir, "data", "iamceo.db");
  mkdirSync(scratch); mkdirSync(join(dir, "data"));
  const db = openDb(path), store = new Store(db, new Bus());
  const project = store.createProject({ name: "비밀프로젝트", cwd: dir });
  store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: "SECRET-BODY 본문" });
  store.patchProject(store.createProject({ name: "보관이름", cwd: dir }).id, { archived: true });
  db.close();
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  return { dir, scratch, path, digest };
}

test("새 판(지금 소스)이 사본을 이주·기동해 읽기 경로를 확인한다. 원본·임시 폴더는 그대로이고 내용은 보고에 나오지 않는다", async () => {
  const f = fixture(), before = f.digest(f.path);
  const result = await rehearseDatabase({ command: [process.execPath, entry], source: f.path, scratch: f.scratch });
  expect(result.ok, JSON.stringify(result.rows)).toBe(true);
  const steps = result.rows.map(row => row.step);
  for (const step of ["copy", "startup (migrate, recover, listen)", "GET /api/readiness", "GET /api/bootstrap", "GET /api/sync", "project 1: state",
    "project 1: messages/page", "(archived): archive/messages/page", "quick_check", "shutdown"]) expect(steps.some(name => name.includes(step))).toBe(true);
  expect(result.startupMs).toBeGreaterThan(0);
  for (const secret of ["SECRET-BODY", "비밀프로젝트", "보관이름"]) expect(JSON.stringify(result.rows)).not.toContain(secret);
  expect(f.digest(f.path)).toBe(before);
  expect(readdirSync(f.scratch)).toEqual([]);
}, 120_000);

test("새 판이 열 수 없는 DB(미래 스키마)면 기동 단계에서 실패로 끝난다", async () => {
  const f = fixture();
  const db = new Database(f.path);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 3}`);
  db.close();
  const result = await rehearseDatabase({ command: [process.execPath, entry], source: f.path, scratch: f.scratch });
  expect(result.ok).toBe(false);
  expect(result.rows.find(row => row.step.startsWith("startup"))?.ok).toBe(false);
  expect(result.rows.some(row => row.step === "shutdown")).toBe(false);
  expect(readdirSync(f.scratch)).toEqual([]);
}, 120_000);

test("DB 가 아닌 파일·없는 파일은 서버를 띄우지 않고 실패한다", async () => {
  const f = fixture(), garbage = join(f.dir, "garbage.db");
  writeFileSync(garbage, "not a database ".repeat(400));
  const result = await rehearseDatabase({ command: [process.execPath, entry], source: garbage, scratch: f.scratch });
  expect(result.ok).toBe(false);
  expect(result.rows.map(row => row.step)).toEqual(["copy"]);
  expect((await rehearseDatabase({ command: [process.execPath, entry], source: join(f.dir, "missing.db"), scratch: f.scratch })).ok).toBe(false);
  expect(readdirSync(f.scratch)).toEqual([]);
}, 120_000);

test("예행 명령은 격리된 환경이 아니면 돌지 않는다", () => {
  const f = fixture();
  const result = Bun.spawnSync([process.execPath, entry, "upgrade-rehearse", f.path, join(f.scratch, "report.json")], {
    env: { ...process.env, IAMCEO_HOME: join(f.dir, "home"), IAMCEO_PORT: "0" }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("isolated environment");
  expect(readdirSync(f.scratch)).toEqual([]);
});
