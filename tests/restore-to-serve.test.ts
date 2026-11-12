// D10 복원 끝까지: "새 Mac 에서 백업으로 시작하기" 절차를 그대로 밟는다.
// 옛 Mac 에서 백업 → 새 Mac(빈 홈)에 iamceo restore → restore reconcile → restore resume → 서버 기동(가짜 core) → 준비 확인 → 대화·첨부 읽기.
// 실제 CLI·core·launchd 는 부르지 않는다. 명령줄 단계는 문서에 적는 명령 그대로 이 소스의 iamceo 로 실행한다.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startOpsRuntime } from "../bin/iamceo.ts";
import { createBackup } from "../server/backup.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { createOrchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import type { Bootstrap, Message, MessagePage, Project } from "../shared/types.ts";
import { startFakeCore } from "./fixtures/core-harness.ts";

const entry = resolve(import.meta.dir, "../bin/iamceo.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("백업 → 새 Mac 의 빈 홈에 복원 → 조정 → 재개 → 서버 기동 → 준비 확인 → 대화·첨부·보관함 읽기", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-restore-serve-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const oldHome = join(root, "old-mac", ".iamceo"), newHome = join(root, "new-mac", ".iamceo"), work = join(root, "work");
  const claudeHome = join(root, "claude-home"), codexHome = join(root, "codex-home");
  for (const dir of [oldHome, work, claudeHome, codexHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  // 옛 Mac: 쓰던 데이터.
  updateConfigFile({ accessCode: "restore-to-serve-code", hosts: ["127.0.0.1"] }, { IAMCEO_HOME: oldHome, IAMCEO_PORT: "0" });
  const oldDb = openDb(join(oldHome, "iamceo.db"));
  const oldStore = new Store(oldDb, new Bus());
  const project = oldStore.createProject({ name: "옮길 프로젝트", cwd: work });
  oldStore.createMember({ projectId: project.id, handle: "lead", name: "옮길 총괄", kind: "conductor", status: "asleep" });
  mkdirSync(join(oldHome, "uploads"), { recursive: true, mode: 0o700 });
  const upload = join(oldHome, "uploads", "plan.txt");
  writeFileSync(upload, "첨부 원본", { mode: 0o600 });
  const attachment = oldStore.createAttachment({ id: "att_plan", name: "plan.txt", mime: "text/plain", size: Buffer.byteLength("첨부 원본"), path: upload });
  oldStore.createMessage({ id: "msg_first", projectId: project.id, mine: true, who: "대표", kind: "나", body: "첫 지시", attachments: [attachment], at: "2026-11-01T00:00:00.000Z" });
  for (let i = 0; i < 250; i++) oldStore.createMessage({ projectId: project.id, who: "옮길 총괄", kind: "알림", body: `보고 ${i}`, at: `2026-11-01T01:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z` });
  const archived = oldStore.createProject({ name: "보관한 프로젝트", cwd: work });
  oldStore.createMessage({ projectId: archived.id, who: "대표", kind: "나", body: "보관 전 마지막 글" });
  oldStore.patchProject(archived.id, { archived: true });
  oldDb.close();
  const snapshot = createBackup({ home: oldHome, backupDir: join(root, "external-disk") });

  // 새 Mac: 문서의 명령 그대로. 데이터 폴더는 아직 없다.
  expect(existsSync(newHome)).toBe(false);
  const iamceo = (args: string[], home?: string) => {
    const env: Record<string, string | undefined> = { ...process.env, IAMCEO_LANG: "ko", IAMCEO_HOME: home };
    if (!home) delete env.IAMCEO_HOME;
    const result = Bun.spawnSync([process.execPath, entry, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
  };
  const restored = iamceo(["restore", snapshot.directory, "--destination", newHome]);
  expect(restored.code, restored.out).toBe(0);
  expect(restored.out).toContain("복원 검증 완료");
  // 조정·재개 전에는 서버가 뜨지 않는다.
  const fence = loadConfig({ IAMCEO_HOME: newHome, IAMCEO_PORT: "0" });
  await expect(startOpsRuntime(fence, { maintenanceDelayMs: 2_000_000_000 })).rejects.toThrow("복원 발신 꺼짐");
  const reconciled = iamceo(["restore", "reconcile"], newHome);
  expect(reconciled.code, reconciled.out).toBe(0);
  const resumed = iamceo(["restore", "resume"], newHome);
  expect(resumed.code, resumed.out).toBe(0);
  expect(resumed.out).toContain("serve");

  // 서버 기동: 실제 실행기 조립 그대로, core 자리만 가짜 소켓이다.
  const core = await startFakeCore({ claudeHome, contextHome: newHome });
  cleanups.push(() => core.stop());
  const env = { IAMCEO_HOME: newHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: core.socketPath, IAMCEO_CORE_BIN: "/usr/bin/false",
    IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false" };
  const config = loadConfig(env);
  expect(config.accessCode).toBe("restore-to-serve-code");
  const runtime = await startOpsRuntime(config, {
    createOrchestrator: (settings, store) => createOrchestrator(settings, store, {
      runner: { claudeHome, codexHome }, runnerDeps: { pollMs: 20, rpcTimeoutMs: 2_000, sendTimeoutMs: 2_000, contextTimeoutMs: 300 },
      orchestrator: { providerHomes: { claudeHome, codexHome } },
    }),
    client: { send: async () => ({ state: "unavailable" as const, reason: "test" }), status: () => [], close() {} },
    maintenanceDelayMs: 2_000_000_000,
  });
  cleanups.push(() => runtime.stop());
  const base = `http://127.0.0.1:${runtime.server.port}`;
  const get = (path: string) => fetch(base + path, { headers: { Authorization: `Bearer ${config.accessCode}` } });

  const readiness = await get("/api/readiness");
  expect(readiness.status).toBe(200);
  expect(await readiness.json()).toMatchObject({ ok: true, daemon: { ready: true }, schema: { version: MIGRATIONS.length, supportedVersion: MIGRATIONS.length } });
  // 복원 전에 실행이 켜져 있던 프로젝트는 재개로 다시 켜졌다.
  const boot = await (await get("/api/bootstrap")).json() as Bootstrap;
  expect(boot.projects.find(summary => summary.id === project.id)).toMatchObject({ runnerEnabled: true });

  // 대화 전체를 페이지로 읽는다. 첨부는 새 홈으로 옮겨져 그대로 열린다.
  const messages: Message[] = [];
  let cursor: string | null = null;
  do {
    const response = await get(`/api/projects/${project.id}/messages/page?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(response.status).toBe(200);
    const page = await response.json() as MessagePage;
    messages.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  expect(messages).toHaveLength(251);
  const first = messages.find(message => message.id === "msg_first")!;
  expect(first.body).toBe("첫 지시");
  expect(first.attachments[0]!.path.startsWith(join(realpathSync(join(root, "new-mac")), ".iamceo", "uploads"))).toBe(true);
  const file = await get(first.attachments[0]!.url);
  expect(file.status).toBe(200);
  expect(await file.text()).toBe("첨부 원본");
  expect(readFileSync(first.attachments[0]!.path, "utf8")).toBe("첨부 원본");

  // 보관함도 그대로다.
  expect((await (await get("/api/projects/archived")).json() as Project[]).map(item => item.id)).toEqual([archived.id]);
  const archivePage = await (await get(`/api/projects/${archived.id}/archive/messages/page`)).json() as MessagePage;
  expect(archivePage.items.map(message => message.body)).toContain("보관 전 마지막 글");

  await runtime.stop();
  // 옛 Mac 의 데이터는 손대지 않았다.
  expect(readFileSync(upload, "utf8")).toBe("첨부 원본");
}, 120_000);

// 사용자 이름이 같은 새 Mac: 백업이 나온 경로(~/.iamceo)와 복원할 경로가 같다. 문서의 명령 그대로 밟는다.
test("사용자 이름이 같은 새 Mac: 같은 ~/.iamceo 경로에 복원 → 조정 → 재개되고, 데이터가 남은 홈에는 복원하지 않는다", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-restore-same-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const userHome = join(root, "Users", "owner"), home = join(userHome, ".iamceo"), work = join(root, "work");
  for (const dir of [home, work]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  updateConfigFile({ accessCode: "same-path-code", hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home, IAMCEO_PORT: "0" });
  const db = openDb(join(home, "iamceo.db"));
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "같은 경로", cwd: work });
  store.createMessage({ projectId: project.id, mine: true, who: "대표", kind: "나", body: "새 Mac 에서도 보여야 하는 글" });
  db.close();
  // 옛 Mac 에서 외장 디스크로 백업한다.
  const snapshot = createBackup({ home, backupDir: join(root, "external-disk") });
  const iamceo = (args: string[], env: Record<string, string> = {}) => {
    const result = Bun.spawnSync([process.execPath, entry, ...args], {
      env: { ...process.env, IAMCEO_LANG: "ko", HOME: userHome, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
  };
  // 옛 Mac 자신(데이터가 남은 홈)에는 복원하지 않고 아무것도 바꾸지 않는다.
  const before = readFileSync(join(home, "iamceo.db"));
  const refused = iamceo(["restore", snapshot.directory, "--destination", home]);
  expect(refused.code).not.toBe(0);
  expect(refused.out).toContain("never overwritten");
  expect(readFileSync(join(home, "iamceo.db")).equals(before)).toBe(true);
  // 새 Mac: 같은 사용자 이름이라 경로가 같고, 아직 '이 Mac에서 시작'을 누르지 않아 폴더가 없다.
  rmSync(home, { recursive: true, force: true });
  const restored = iamceo(["restore", snapshot.directory, "--destination", home]);
  expect(restored.code, restored.out).toBe(0);
  expect(restored.out).toContain("복원 검증 완료");
  expect(iamceo(["restore", "reconcile"], { IAMCEO_HOME: home }).code).toBe(0);
  const resumed = iamceo(["restore", "resume"], { IAMCEO_HOME: home });
  expect(resumed.code, resumed.out).toBe(0);
  expect(loadConfig({ IAMCEO_HOME: home, IAMCEO_PORT: "0" }).accessCode).toBe("same-path-code");
  const reopened = openDb(join(home, "iamceo.db"));
  try {
    const restoredStore = new Store(reopened, new Bus());
    expect(restoredStore.getProject(project.id)?.runnerEnabled).toBe(true);
    expect(reopened.query<{ body: string }, []>("SELECT body FROM messages").all().map(row => row.body)).toContain("새 Mac 에서도 보여야 하는 글");
  } finally { reopened.close(); }
}, 60_000);
