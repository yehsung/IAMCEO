// 새 판으로 DB 사본을 미리 돌려 본다(업그레이드 전 예행). scripts/smoke-db.ts 와 같은 생각을 실행 파일 안에 넣은 것이다:
// 원본은 읽기 전용으로만 열고, 사본은 격리한 임시 홈에서 새 판의 서버가 이주·복구·응답까지 해 본다.
// 실행기·CLI·core·푸시는 없다. 출력은 단계 이름·시간뿐이고 DB 내용은 내보내지 않는다.
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface RehearsalRow { step: string; ok: boolean; ms: number; detail: string }
export interface RehearsalResult { ok: boolean; rows: RehearsalRow[]; startupMs: number | null; exitCode: number | null }
export type Rehearse = (input: { command: string[]; cwd?: string; source: string; timeoutMs?: number }) => Promise<RehearsalResult>;

/** 하위 명령 이름. 새 판의 실행 파일이 이 이름을 알아야 예행할 수 있다. */
export const REHEARSAL_COMMAND = "upgrade-rehearse";

/** 아무것도 물려받지 않는 환경. 실제 소켓·홈·세션을 가리키는 변수가 새어 들어갈 수 없다. */
export function rehearsalEnvironment(root: string): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    IAMCEO_TEST: "1", IAMCEO_PORT: "0", IAMCEO_HOME: join(root, "iamceo"),
    IAMCEO_HERDR_SOCKET: join(root, "no-herdr.sock"), IAMCEO_CORE_SOCKET: join(root, "no-core.sock"),
    IAMCEO_CORE_BIN: join(root, "bin", "core"), IAMCEO_CLAUDE_BIN: join(root, "bin", "claude"), IAMCEO_CODEX_BIN: join(root, "bin", "codex"),
    HERDR_BIN_PATH: join(root, "bin", "herdr"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"),
    XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
  };
}

/** 부모 쪽: 격리 폴더를 만들고 새 판에 예행을 시킨 뒤 보고를 읽는다. 폴더는 끝나면 지운다. */
export async function rehearseDatabase(input: { command: string[]; cwd?: string; source: string; timeoutMs?: number; scratch?: string }): Promise<RehearsalResult> {
  if (!statSync(input.source, { throwIfNoEntry: false })?.isFile()) return { ok: false, exitCode: null, startupMs: null, rows: [{ step: "source", ok: false, ms: 0, detail: "database file not found" }] };
  const root = realpathSync(mkdtempSync(join(input.scratch ?? tmpdir(), "iamceo-rehearse-")));
  try {
    for (const dir of ["home", "iamceo", "claude", "codex", "state", "config", "cache", "tmp", "bin"]) mkdirSync(join(root, dir), { mode: 0o700 });
    for (const name of ["core", "claude", "codex", "herdr"]) writeFileSync(join(root, "bin", name), "#!/bin/sh\nprintf 'Rehearsal: real runtime disabled\\n' >&2\nexit 97\n", { mode: 0o700 });
    const report = join(root, "report.json");
    const child = Bun.spawn([...input.command, REHEARSAL_COMMAND, input.source, report], {
      cwd: input.cwd ?? root, env: rehearsalEnvironment(root), stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(1_000, input.timeoutMs ?? 300_000));
    let exitCode: number | null;
    try { exitCode = await child.exited; } finally { clearTimeout(timer); }
    let rows: RehearsalRow[] = [];
    try { rows = JSON.parse(readFileSync(report, "utf8")) as RehearsalRow[]; } catch { /* 첫 보고 전에 끝났다 */ }
    const startup = rows.find(row => row.step.startsWith("startup"));
    const ok = exitCode === 0 && rows.length > 0 && rows.every(row => row.ok) && rows.at(-1)!.step === "shutdown";
    return { ok, rows, startupMs: startup?.ok ? startup.ms : null, exitCode };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export function describeRehearsal(result: RehearsalResult): string {
  const failed = result.rows.filter(row => !row.ok);
  if (!result.rows.length) return `exit ${result.exitCode ?? "timeout"}`;
  return failed.length ? failed.map(row => `${row.step}: ${row.detail}`).join("; ") : `exit ${result.exitCode ?? "timeout"}`;
}

/** bin/iamceo.ts 의 startOpsRuntime. 진입 모듈이 자기 자신을 다시 불러오면 최상위 await 에 묶여 멈추므로 호출하는 쪽이 넘긴다. */
export type StartRuntime = typeof import("../../bin/iamceo.ts").startOpsRuntime;

/** 자식 쪽: 부모가 만든 격리 환경에서만 돈다. 사본을 이주·기동하고 읽기 경로 몇 개를 확인한 뒤 끈다. */
export async function runRehearsalChild(source: string, reportPath: string, startOpsRuntime: StartRuntime): Promise<void> {
  const rows: RehearsalRow[] = [];
  const save = () => writeFileSync(reportPath, JSON.stringify(rows));
  const root = dirname(reportPath), home = process.env.IAMCEO_HOME ?? "";
  if (process.env.IAMCEO_TEST !== "1" || process.env.IAMCEO_PORT !== "0" || home !== join(root, "iamceo") || process.env.HOME !== join(root, "home")) {
    throw new Error("rehearsal requires the isolated environment");
  }
  const { generateAccessCode, loadConfig, updateConfigFile } = await import("../config.ts");
  updateConfigFile({ accessCode: generateAccessCode(), hosts: ["127.0.0.1"], keepAwake: false });
  const config = loadConfig();
  if (config.port !== 0 || dirname(config.dbPath) !== home) throw new Error("rehearsal resolved a foreign configuration");
  let started = performance.now();
  try {
    try {
      const original = new Database(source, { readonly: true });
      try { original.query("VACUUM INTO ?").run(config.dbPath); } finally { original.close(); }
    } catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_CANTOPEN" || (statSync(`${source}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0) throw error;
      copyFileSync(source, config.dbPath);
    }
    rows.push({ step: "copy", ok: true, ms: performance.now() - started, detail: "" });
  } catch (error) {
    rows.push({ step: "copy", ok: false, ms: performance.now() - started, detail: (error as Error).name });
    return save();
  }
  const { Orchestrator } = await import("../orchestrator.ts");
  started = performance.now();
  let runtime: Awaited<ReturnType<StartRuntime>>;
  try {
    runtime = await startOpsRuntime(config, {
      createOrchestrator: (settings, store) => new Orchestrator({ config: settings, store, runners: new Map() }),
      client: { send: async () => ({ state: "unavailable" as const, reason: "rehearsal" }), status: () => [], close() {} },
      maintenanceDelayMs: 2_000_000_000,
    });
    rows.push({ step: "startup (migrate, recover, listen)", ok: true, ms: performance.now() - started, detail: "" });
  } catch (error) {
    // 오류 문장에는 경로가 들어갈 수 있다. 종류와 앞부분만 남긴다.
    rows.push({ step: "startup (migrate, recover, listen)", ok: false, ms: performance.now() - started, detail: `${(error as Error).name}: ${String((error as Error).message ?? "").slice(0, 160)}` });
    return save();
  }
  try {
    if (runtime.server.port === 7878) throw new Error("live port forbidden");
    const base = `http://127.0.0.1:${runtime.server.port}`;
    const get = async (step: string, path: string, auth = true) => {
      const begun = performance.now();
      try {
        const response = await fetch(base + path, { headers: auth ? { Authorization: `Bearer ${config.accessCode}` } : {}, redirect: "error", signal: AbortSignal.timeout(60_000) });
        const body = await response.text();
        let detail = response.status === 200 ? "" : `HTTP ${response.status}`;
        if (!detail) try { JSON.parse(body); } catch { detail = "response is not JSON"; }
        rows.push({ step, ok: !detail, ms: performance.now() - begun, detail });
      } catch (error) { rows.push({ step, ok: false, ms: performance.now() - begun, detail: (error as Error).name }); }
    };
    await get("GET /api/health", "/api/health", false);
    await get("GET /api/readiness", "/api/readiness");
    await get("GET /api/bootstrap", "/api/bootstrap");
    await get("GET /api/sync", "/api/sync");
    await get("GET /api/projects/archived", "/api/projects/archived");
    const projects = runtime.store.db.query<{ id: string; archived: number }, []>("SELECT id, archived FROM projects ORDER BY created_at, id").all();
    for (const [index, project] of projects.entries()) {
      const id = encodeURIComponent(project.id), label = `project ${index + 1}${project.archived ? " (archived)" : ""}:`;
      if (project.archived) { await get(`${label} archive/messages/page`, `/api/projects/${id}/archive/messages/page`); continue; }
      await get(`${label} state`, `/api/projects/${id}/state`);
      await get(`${label} messages/page`, `/api/projects/${id}/messages/page`);
    }
    started = performance.now();
    const check = runtime.store.db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check ?? "no result";
    rows.push({ step: "quick_check", ok: check === "ok", ms: performance.now() - started, detail: check === "ok" ? "" : "database is damaged" });
  } finally {
    started = performance.now();
    try { await runtime.stop(); rows.push({ step: "shutdown", ok: true, ms: performance.now() - started, detail: "" }); }
    catch (error) { rows.push({ step: "shutdown", ok: false, ms: performance.now() - started, detail: (error as Error).name }); }
    save();
  }
}
