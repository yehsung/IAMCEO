/** Pre-install smoke check: open a COPY of a real database with this checkout's server code.
 * bun scripts/smoke-db.ts <iamceo.db> [--budget-ms 1000] [--startup-budget-ms 60000] [--keep]
 * The source is only ever read (VACUUM INTO from a read-only connection). The copy is migrated and served by a
 * child process whose environment is built from scratch: temporary home, port 0, no runner, no
 * provider/core executable, no push sender. It cannot reach a live session, socket or device.
 * Output is step names, timings and sizes only, never database content.
 * Exit 1 when a step fails or exceeds its budget.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SmokeOptions { source: string; budgetMs: number; startupBudgetMs: number; keep: boolean }
export interface SmokeRow { step: string; ok: boolean; ms: number; bytes: number | null; detail: string }

export function parseSmokeOptions(args: string[]): SmokeOptions {
  const options: SmokeOptions = { source: "", budgetMs: Number(process.env.IAMCEO_SMOKE_BUDGET_MS ?? 1000),
    startupBudgetMs: Number(process.env.IAMCEO_SMOKE_STARTUP_BUDGET_MS ?? 60_000), keep: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--keep") options.keep = true;
    else if (arg === "--budget-ms" || arg === "--startup-budget-ms") {
      const value = Number(args[++i]);
      if (arg === "--budget-ms") options.budgetMs = value; else options.startupBudgetMs = value;
    } else if (arg.startsWith("-") || options.source) throw new Error(`Unknown argument: ${arg}`);
    else options.source = arg;
  }
  if (!options.source) throw new Error("Usage: bun scripts/smoke-db.ts <iamceo.db> [--budget-ms N] [--startup-budget-ms N] [--keep]");
  for (const value of [options.budgetMs, options.startupBudgetMs]) if (!Number.isFinite(value) || value < 0) throw new Error("A budget must be a non-negative number of milliseconds");
  return options;
}

export function renderSmokeReport(rows: SmokeRow[]): string {
  const width = Math.max(4, ...rows.map(row => row.step.length));
  const lines = [`${"step".padEnd(width)}  ${"ms".padStart(9)}  ${"bytes".padStart(10)}  result`];
  for (const row of rows) lines.push(`${row.step.padEnd(width)}  ${row.ms.toFixed(1).padStart(9)}  ${(row.bytes === null ? "-" : String(row.bytes)).padStart(10)}  ${row.ok ? "ok" : `FAIL ${row.detail}`.trim()}`);
  return lines.join("\n");
}

/** Runs inside the isolated child only. */
async function serveCopy(source: string, reportPath: string, budgetMs: number, startupBudgetMs: number): Promise<void> {
  const rows: SmokeRow[] = [];
  const save = () => writeFileSync(reportPath, JSON.stringify(rows));
  const root = dirname(reportPath), home = process.env.IAMCEO_HOME ?? "";
  // Refuse to run anywhere but the scratch root the parent prepared.
  if (process.env.IAMCEO_TEST !== "1" || process.env.IAMCEO_PORT !== "0" || home !== join(root, "iamceo") || process.env.HOME !== join(root, "home")) throw new Error("smoke child requires the isolated environment");
  const { generateAccessCode, loadConfig, updateConfigFile } = await import("../server/config.ts");
  updateConfigFile({ accessCode: generateAccessCode(), hosts: ["127.0.0.1"], keepAwake: false });
  const config = loadConfig();
  if (config.port !== 0 || dirname(config.dbPath) !== home) throw new Error("smoke child resolved a foreign configuration");
  let started = performance.now();
  try {
    try {
      const original = new Database(source, { readonly: true });
      try { original.query("VACUUM INTO ?").run(config.dbPath); } finally { original.close(); }
    } catch (error) {
      // A WAL-mode file copied without its -shm cannot be opened read-only. With no pending WAL the file
      // alone is the whole database: copy the bytes instead of opening the source for writing.
      if ((error as { code?: string }).code !== "SQLITE_CANTOPEN" || (statSync(`${source}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0) throw error;
      copyFileSync(source, config.dbPath);
    }
    rows.push({ step: "copy (source opened read-only)", ok: true, ms: performance.now() - started, bytes: statSync(config.dbPath).size, detail: "" });
  } catch (error) {
    rows.push({ step: "copy (source opened read-only)", ok: false, ms: performance.now() - started, bytes: null, detail: (error as Error).message });
    return save();
  }
  const { startOpsRuntime } = await import("../bin/iamceo.ts");
  const { Orchestrator } = await import("../server/orchestrator.ts");
  started = performance.now();
  let runtime: Awaited<ReturnType<typeof startOpsRuntime>>;
  try {
    runtime = await startOpsRuntime(config, {
      // No runner at all: recovery runs over the real rows but nothing can be started, written to or stopped.
      createOrchestrator: (settings, store) => new Orchestrator({ config: settings, store, runners: new Map() }),
      client: { send: async () => ({ state: "unavailable" as const, reason: "smoke" }), status: () => [], close() {} },
      maintenanceDelayMs: 2_000_000_000,
    });
    const ms = performance.now() - started;
    rows.push({ step: "startup (migrate, recover, listen)", ok: ms <= startupBudgetMs, ms, bytes: null, detail: ms <= startupBudgetMs ? "" : `over ${startupBudgetMs} ms` });
  } catch (error) {
    rows.push({ step: "startup (migrate, recover, listen)", ok: false, ms: performance.now() - started, bytes: null, detail: (error as Error).message });
    return save();
  }
  try {
    if (runtime.server.port === 7878) throw new Error("live port forbidden");
    const base = `http://127.0.0.1:${runtime.server.port}`;
    const get = async (step: string, path: string, auth = true): Promise<void> => {
      const begun = performance.now();
      try {
        const response = await fetch(base + path, { headers: auth ? { Authorization: `Bearer ${config.accessCode}` } : {}, redirect: "error", signal: AbortSignal.timeout(Math.max(30_000, budgetMs * 2)) });
        const body = await response.text(), ms = performance.now() - begun;
        let detail = response.status === 200 ? "" : `HTTP ${response.status}`;
        if (!detail) try { JSON.parse(body); } catch { detail = "response is not JSON"; }
        if (!detail && ms > budgetMs) detail = `over ${budgetMs} ms`;
        rows.push({ step, ok: !detail, ms, bytes: Buffer.byteLength(body), detail });
      } catch (error) { rows.push({ step, ok: false, ms: performance.now() - begun, bytes: null, detail: (error as Error).name }); }
    };
    await get("GET /api/health", "/api/health", false);
    await get("GET /api/readiness", "/api/readiness");
    await get("GET /api/capabilities", "/api/capabilities");
    await get("GET /api/bootstrap", "/api/bootstrap");
    await get("GET /api/sync", "/api/sync");
    await get("GET /api/projects/archived", "/api/projects/archived");
    const projects = runtime.store.db.query<{ id: string; archived: number }, []>("SELECT id, archived FROM projects ORDER BY created_at, id").all();
    for (const [index, project] of projects.entries()) {
      const id = encodeURIComponent(project.id), label = `project ${index + 1}${project.archived ? " (archived)" : ""}:`;
      if (project.archived) {
        await get(`${label} GET archive/state`, `/api/projects/${id}/archive/state`);
        await get(`${label} GET archive/messages/page`, `/api/projects/${id}/archive/messages/page`);
        continue;
      }
      await get(`${label} GET /api/sync?projectId`, `/api/sync?projectId=${id}`);
      await get(`${label} GET /api/sync?projectId&lite=1`, `/api/sync?projectId=${id}&lite=1`);
      await get(`${label} GET state`, `/api/projects/${id}/state`);
      await get(`${label} GET messages/page`, `/api/projects/${id}/messages/page`);
      await get(`${label} GET delivery-notices`, `/api/projects/${id}/delivery-notices`);
      await get(`${label} GET decisions?status=open`, `/api/projects/${id}/decisions?status=open`);
    }
    started = performance.now();
    const check = runtime.store.db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check ?? "no result";
    rows.push({ step: "PRAGMA quick_check after migration", ok: check === "ok", ms: performance.now() - started, bytes: null, detail: check === "ok" ? "" : "database is damaged" });
  } finally {
    started = performance.now();
    try {
      await runtime.stop();
      rows.push({ step: "shutdown", ok: true, ms: performance.now() - started, bytes: null, detail: "" });
    } catch (error) { rows.push({ step: "shutdown", ok: false, ms: performance.now() - started, bytes: null, detail: (error as Error).message }); }
    save();
  }
}

export function smokeDb(options: SmokeOptions): boolean {
  const source = resolve(options.source);
  if (!statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`Not a database file: ${source}`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-smoke-")));
  try {
    for (const dir of ["home", "iamceo", "claude", "codex", "state", "config", "cache", "tmp", "bin"]) mkdirSync(join(root, dir), { mode: 0o700 });
    for (const name of ["core", "claude", "codex", "herdr"]) writeFileSync(join(root, "bin", name), "#!/bin/sh\nprintf 'Smoke check: real runtime disabled\\n' >&2\nexit 97\n", { mode: 0o700 });
    // Nothing is inherited: a variable that points at a live socket, home or session cannot leak in.
    const env = {
      PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
      IAMCEO_TEST: "1", IAMCEO_PORT: "0", IAMCEO_HOME: join(root, "iamceo"),
      IAMCEO_HERDR_SOCKET: join(root, "no-herdr.sock"), IAMCEO_CORE_SOCKET: join(root, "no-core.sock"),
      IAMCEO_CORE_BIN: join(root, "bin", "core"), IAMCEO_CLAUDE_BIN: join(root, "bin", "claude"), IAMCEO_CODEX_BIN: join(root, "bin", "codex"),
      HERDR_BIN_PATH: join(root, "bin", "herdr"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"),
      XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    };
    const report = join(root, "report.json");
    const child = Bun.spawnSync([process.execPath, import.meta.path, "--child", source, report, String(options.budgetMs), String(options.startupBudgetMs)], {
      cwd: resolve(import.meta.dir, ".."), env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: options.startupBudgetMs + 300_000,
    });
    let rows: SmokeRow[] = [];
    try { rows = JSON.parse(readFileSync(report, "utf8")) as SmokeRow[]; } catch { /* the child died before its first report */ }
    console.log(`smoke-db: ${source}`);
    if (rows.length) console.log(renderSmokeReport(rows));
    const failed = rows.filter(row => !row.ok).length;
    const passed = child.exitCode === 0 && rows.length > 0 && failed === 0 && rows.at(-1)!.step === "shutdown";
    if (!passed) {
      // Server diagnostics only (no request or message bodies are logged by the server).
      const log = (child.stdout.toString() + child.stderr.toString()).trim().split("\n").slice(-30).join("\n");
      if (log) console.error(`--- server output (last lines) ---\n${log}`);
      console.error(`smoke-db FAILED: ${failed} failed step(s)${child.exitCode === 0 ? "" : `, server process exit ${child.exitCode ?? "timeout"}`}`);
    } else console.log(`smoke-db passed: ${rows.length} steps, slowest ${Math.max(...rows.map(row => row.ms)).toFixed(1)} ms`);
    return passed;
  } finally {
    if (options.keep) console.log(`kept: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    // The child exits explicitly: a stray handle must not keep the smoke check waiting.
    if (args[0] === "--child") { await serveCopy(args[1]!, args[2]!, Number(args[3]), Number(args[4])); process.exit(0); }
    else if (!smokeDb(parseSmokeOptions(args))) process.exitCode = 1;
  } catch (error) { console.error(`smoke-db failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
