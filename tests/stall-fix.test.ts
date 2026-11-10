import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { CoreRunner } from "../server/runner/core.ts";
import { coreRpc } from "../server/runner/core-client.ts";
import { Store } from "../server/store.ts";
import { memberConfig } from "../shared/types.ts";
import { startBrowserCore } from "./fixtures/core-browser-harness.ts";
import type { IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

// Optional before/after replay: read the pre-change modules without changing the worktree or git state.
async function serverClasses(runtime: IsolatedRuntime) {
  if (process.env.IAMCEO_STALL_BASELINE !== "1") return { Store, CoreRunner, Orchestrator };
  const urls = new Map<string, string>();
  const sources = new Map<string, string>();
  const paths = ["server/store.ts", "server/delivery-recovery.ts", "server/runner/core.ts", "server/orchestrator.ts"];
  for (const path of paths) urls.set(new URL("../" + path, import.meta.url).href, runtime.assertOwnedPath(`${runtime.paths.temp}/${path.replaceAll("/", "-")}`));
  for (const path of paths) {
    const result = Bun.spawnSync(["git", "show", `42cb26d87753627a879cd3e56d620415820a0601:${path}`], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`Cannot read baseline ${path}`);
    const source = result.stdout.toString().replace(/from\s+(["'])([^"']+)\1/g, (_match, quote, specifier) => {
      if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return _match;
      const url = specifier.startsWith(".") ? new URL(specifier, new URL("../" + path, import.meta.url)).href : null;
      return `from ${quote}${url ? urls.get(url) ?? new URL(url).pathname : Bun.resolveSync(specifier, new URL("..", import.meta.url).pathname)}${quote}`;
    });
    sources.set(path, source);
  }
  for (const path of paths) writeFileSync(urls.get(new URL("../" + path, import.meta.url).href)!, sources.get(path)!);
  return { Store: (await import(urls.get(new URL("../server/store.ts", import.meta.url).href)!)).Store as typeof Store,
    CoreRunner: (await import(urls.get(new URL("../server/runner/core.ts", import.meta.url).href)!)).CoreRunner as typeof CoreRunner,
    Orchestrator: (await import(urls.get(new URL("../server/orchestrator.ts", import.meta.url).href)!)).Orchestrator as typeof Orchestrator };
}

// Instrument actual statement execution, including queries outside Store.row/rows.
function meter(db: Database) {
  let queries = 0, rows = 0, sqlMs = 0;
  const statements = new Map<string, number>();
  const query = db.query.bind(db);
  db.query = ((...args: Parameters<Database["query"]>) => {
    const statement = query(...args);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (!["get", "all", "run"].includes(String(key))) return typeof value === "function" ? value.bind(target) : value;
      return (...params: unknown[]) => {
        const start = performance.now();
        try {
          const result = value.apply(target, params);
          statements.set(args[0], (statements.get(args[0]) ?? 0) + 1);
          queries++; rows += Array.isArray(result) ? result.length : key === "get" && result ? 1 : 0;
          return result;
        } finally { sqlMs += performance.now() - start; }
      };
    } });
  }) as Database["query"];
  return { snapshot: () => ({ queries, rows, sqlMs }), statements: () => new Map(statements) };
}
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0, max: sorted.at(-1) ?? 0 };
}

test("stall: 900 messages/deliveries, busy core output and three realtime clients stay responsive", async () => {
  const core = await startBrowserCore({ providerTurns: false });
  const runtime = core.runtime;
  const classes = await serverClasses(runtime);
  const env = { ...runtime.childEnv(), IAMCEO_PORT: "0" };
  updateConfigFile({ hosts: ["127.0.0.1"], accessCode: "stall-fixture" }, env);
  const config = loadConfig(env), db = openDb(config.dbPath), metrics = meter(db), bus = new Bus(), store = new classes.Store(db, bus);
  const runner = new classes.CoreRunner(runtime.runnerOptions(runtime.providerHomes), { recoveryStore: store, pollMs: 20 });
  const orch = new classes.Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: runtime.providerHomes, timings: { tickMs: 60_000, healthMs: 60_000 } });
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const sockets: WebSocket[] = [], pending = new Set<Promise<void>>();
  let measuring = false;
  const latency: Record<string, number[]> = { health: [], notices: [], state: [], bootstrap: [] };
  const errors: unknown[] = [];
  const spans: Record<string, { ms: number; queries: number; rows: number }[]> = {};
  let tickSql: [string, number][] = [];
  function span<T>(name: string, work: () => T): T {
    const statements = name === "onTick" ? metrics.statements() : null;
    const before = metrics.snapshot(), start = performance.now();
    try { return work(); } finally {
      const after = metrics.snapshot();
      (spans[name] ??= []).push({ ms: performance.now() - start, queries: after.queries - before.queries, rows: after.rows - before.rows });
      if (statements) tickSql = [...metrics.statements()].map(([sql, count]): [string, number] => [sql.replace(/\s+/g, " ").slice(0, 180), count - (statements.get(sql) ?? 0)]).sort((a, b) => b[1] - a[1]).slice(0, 5);
    }
  }
  try {
    store.patchSettings({ boardTidyHours: 0 });
    const project = store.createProject({ name: "stall fixture", cwd: runtime.paths.work });
    const member = store.createMember({ projectId: project.id, name: "바쁜 직원", handle: "builder", kind: "worker", backend: "core", origin: "runner", status: "working", sessionId: "stall-session", paneId: "t1" });
    await coreRpc(runtime.socketPath, "terminal.run", { argv: [runtime.bins.claudeBin], cwd: runtime.paths.work, env: runtime.childEnv(), labels: { "iamceo.member": member.id, "iamceo.project": project.id, "iamceo.cli": "claude", "iamceo.generation": String(store.memberRevisions(member.id).sessionGeneration), "iamceo.session": member.sessionId } });
    const holder = [...core.holders.values()][0]!;
    holder.terminal.status = { state: "working" };
    const settings = store.getSettings();
    const runnerMember = { ...member, ...memberConfig(member, settings.ranks, settings.codexRanks), subagentModel: settings.ranks.staff.model, sessionGeneration: store.memberRevisions(member.id).sessionGeneration, permissionMode: settings.permissionMode };
    expect((await runner.reattachOwned(runnerMember)).outcome).toBe("rejoined");
    console.log("STALL_STAGE attached");
    // Keep all rows pending: this exposes repeated project-wide scans most clearly.
    const seed = new classes.Store(db, new Bus());
    seed.transaction(() => {
      for (let i = 0; i < 900; i++) {
        const message = seed.createMessage({ projectId: project.id, mine: true, targetMemberId: member.id, kind: "나", body: `build output instruction ${i}`, delivery: "queued" });
        seed.enqueue({ projectId: project.id, memberId: member.id, kind: "user_message", text: message.body, refType: "message", refId: message.id, wake: false });
      }
    });
    console.log("STALL_STAGE seeded");
    const notices = orch.deliveryRecovery.notices.bind(orch.deliveryRecovery);
    orch.deliveryRecovery.notices = id => span("notices", () => notices(id));
    const state = store.projectState.bind(store);
    store.projectState = id => span("state", () => state(id));
    const summaries = store.projectSummaries.bind(store);
    store.projectSummaries = () => span("summaries", summaries);
    span("detectDeliveryStalls", () => store.detectDeliveryStalls());
    span("checkStaleTodos", () => orch.checkStaleTodos());
    span("checkBoardTidy", () => orch.checkBoardTidy());
    console.log("STALL_STAGE ticks " + JSON.stringify(spans));
    span("coldNotices", () => orch.deliveryRecovery.notices(project.id));
    span("coldState", () => store.projectState(project.id));
    console.log("STALL_STAGE cold " + JSON.stringify(spans));
    do { await server?.stop(); server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery, detectHosts: () => [] }); } while (server.port === 7878);
    console.log("STALL_STAGE listening");
    const base = `http://127.0.0.1:${server.port}`;
    const paths = { health: "/api/health", notices: `/api/projects/${project.id}/delivery-notices`, state: `/api/projects/${project.id}/state`, bootstrap: "/api/bootstrap" };
    async function request(name: keyof typeof paths) {
      const start = performance.now();
      try {
        const response = await fetch(base + paths[name], { headers: { Authorization: "Bearer stall-fixture" }, signal: AbortSignal.timeout(30_000) });
        await response.text();
        expect(response.status).toBe(200);
      } catch (error) { errors.push(error); }
      finally { if (measuring) latency[name].push(performance.now() - start); }
    }
    const eventTimes: number[] = [], cursors: number[][] = [[], [], []];
    await Promise.all(cursors.map((seqs, index) => new Promise<void>((resolve, reject) => {
      const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
      const socket = new Socket(base.replace("http:", "ws:") + "/ws?v=2", { headers: { Authorization: "Bearer stall-fixture" } });
      sockets.push(socket); socket.onerror = () => reject(new Error("fixture WS refused")); socket.onopen = () => resolve();
      socket.onmessage = message => {
        const event = JSON.parse(String(message.data));
        if (event.seq !== undefined && event.type !== "hello" && event.type !== "ping") seqs.push(event.seq);
        if (!measuring || event.type === "hello" || event.type === "ping") return;
        if (index === 0) eventTimes.push(performance.now());
        const work = Promise.all([request("notices"), request("state")]).then(() => {}, error => { errors.push(error); }).finally(() => pending.delete(work));
        pending.add(work);
      };
    })));
    console.log("STALL_STAGE subscribed");
    let observations = 0, outputBytes = 0, consumedBytes = 0;
    const started = performance.now(); measuring = true;
    const producer = setInterval(() => {
      observations++;
      holder.terminal.status = { state: observations % 2 ? "working" : "idle" };
      holder.screen = `swift-frontend ${observations}\n` + "compiling source.swift\n".repeat(512);
      outputBytes += Buffer.byteLength(holder.screen);
      const work = runner.screen(runnerMember).then(text => { consumedBytes += Buffer.byteLength(text); }, error => { errors.push(error); }).finally(() => pending.delete(work));
      pending.add(work);
    }, 20);
    const ticks = setInterval(() => span("onTick", () => (orch as unknown as { onTick(): void }).onTick()), 250);
    try {
      while (performance.now() - started < 1500) {
        await Promise.all([request("health"), request("notices"), request("state"), request("bootstrap")]);
        await Bun.sleep(10);
      }
    } finally { clearInterval(producer); clearInterval(ticks); }
    await Promise.all([...pending]); measuring = false;
    const elapsed = performance.now() - started;
    const perSecond = eventTimes.reduce((max, at, index) => Math.max(max, eventTimes.slice(index).filter(time => time < at + 1000).length), 0);
    console.log("STALL_METRICS " + JSON.stringify({ baseline: process.env.IAMCEO_STALL_BASELINE === "1", errors: errors.length, latency: Object.fromEntries(Object.entries(latency).map(([key, values]) => [key, stats(values)])), spans: Object.fromEntries(Object.entries(spans).map(([key, values]) => [key, { ms: stats(values.map(v => v.ms)), queries: stats(values.map(v => v.queries)), rows: stats(values.map(v => v.rows)) }])), tickSql, events: { total: eventTimes.length, perSecond, elapsed, observations, outputBytes, consumedBytes, terminalReads: core.count("terminal.read") }, sql: metrics.snapshot() }));
    expect(errors.length).toBe(0);
    expect(observations).toBeGreaterThan(0);
    expect(consumedBytes).toBeGreaterThan(0);
    for (const seqs of cursors) expect(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!)).toBe(true);
    expect(eventTimes.length).toBeGreaterThan(0);
    expect(stats(latency.health).p95).toBeLessThan(50);
    expect(stats(latency.health).max).toBeLessThan(200);
    expect(stats(latency.notices).p95).toBeLessThan(150);
    expect(stats(latency.state).p95).toBeLessThan(150);
    expect(perSecond).toBeLessThanOrEqual(16);
    expect(stats(spans.notices.map(v => v.queries)).max).toBeLessThan(150);
    expect(stats(spans.state.map(v => v.queries)).max).toBeLessThan(150);
    expect(stats(spans.onTick.map(v => v.queries)).max).toBeLessThan(200);
    // Project summaries need only attention counts, even with a large queue.
    expect(stats(spans.summaries.map(v => v.rows)).max).toBeLessThan(50);
  } finally {
    measuring = false;
    for (const socket of sockets) socket.close();
    await Promise.all([...pending]);
    await server?.stop(); await orch.shutdown(); db.close(); await core.stop();
  }
}, 120_000);
