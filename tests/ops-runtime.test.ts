import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startOpsRuntime, shutdownWithinBudget, waitForReadiness } from "../bin/iamceo.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { acquireHomeOwner } from "../server/home-owner.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { startServer } from "../server/http.ts";
import { openDb } from "../server/db.ts";
import { Bus } from "../server/bus.ts";
import { Store } from "../server/store.ts";
import { FilePublication, prepareImport, writePublicationManifest, type PublicationManifest } from "../server/files.ts";
import { createStorageReferences, STAGING_GRACE_MS } from "../server/storage-maintenance.ts";
import { verifyBackup } from "../server/backup.ts";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";
import type { APNsNotification, APNsResult } from "../server/push/apns.ts";

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
function config(): Config {
  const home = mkdtempSync("/private/tmp/iamceo-ops-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_HERDR_SOCKET: join(home, "no-herdr.sock"),
    IAMCEO_CORE_SOCKET: join(home, "no-core.sock"), IAMCEO_CORE_BIN: "/usr/bin/false", IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false" };
  updateConfigFile({ hosts: ["127.0.0.1"] }, env);
  return loadConfig(env);
}
const fakeOrchestrator = (settings: Config, store: Store) => new Orchestrator({ config: settings, store,
  runners: new Map(), agentTools: { listAgentTools: () => [], handleAgentTool: async () => ({ text: "" }) } });
function client(send: (notification: APNsNotification) => Promise<APNsResult> = async () => ({ state: "accepted", reason: "accepted", status: 200 })) {
  let closed = 0;
  return { send, status: () => [{ environment: "sandbox" as const, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready" as const, lastError: null }],
    close() { closed++; }, get closed() { return closed; } };
}

describe("operations runtime", () => {
  test("shutdown signal closes ingress during pending initialization without releasing DB ownership early", async () => {
    const settings = config();
    const shutdown = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const initializing = new Promise<void>(resolve => { entered = resolve; });
    let server!: Awaited<ReturnType<typeof startServer>>;
    const starting = startOpsRuntime(settings, { signal: shutdown.signal, client: client(),
      createOrchestrator: (c, state) => {
        const orch = fakeOrchestrator(c, state);
        orch.initializeRuntime = async () => { entered(); await gate; };
        orch.recover = async () => { throw new Error("Recovery must not start after shutdown was requested"); };
        return orch;
      },
      startServer: async context => { server = await startServer(context); return server; },
    });
    await initializing;
    const stop = spyOn(server, "stop");
    try {
      shutdown.abort();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(() => acquireHomeOwner(settings.home)).toThrow("다른 작업");
    } finally { release(); }
    const runtime = await starting;
    stops.push(runtime.stop);
    await runtime.stop();
    expect(existsSync(join(settings.home, "backups"))).toBe(false);
    using owner = acquireHomeOwner(settings.home);
  });

  test("runtime attributes slow onTick work to its timer", async () => {
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    let orch!: Orchestrator;
    const runtime = await startOpsRuntime(config(), { client: client(), createOrchestrator: (c, store) => {
      orch = fakeOrchestrator(c, store);
      Reflect.set(orch, "onTick", () => {
        const until = performance.now() + 820;
        while (performance.now() < until) { /* injected synchronous timer workload */ }
      });
      return orch;
    } });
    stops.push(runtime.stop);
    try {
      (Reflect.get(orch, "onTick") as () => void).call(orch);
      await Bun.sleep(20);
      expect(warnings.mock.calls.some(([line]) => String(line).includes("slow timer:onTick"))).toBe(true);
      expect(warnings.mock.calls.some(([line]) => String(line).includes("lag work=timer:onTick"))).toBe(true);
    } finally { await runtime.stop(); warnings.mockRestore(); }
  });

  test("runtime initialization gates sync and status; ready does not await backup or sweep", async () => {
    const settings = config();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const initializing = new Promise<void>(resolve => { entered = resolve; });
    let origin = "";
    const starting = startOpsRuntime(settings, {
      client: client(),
      createOrchestrator: (c, store) => {
        const orch = fakeOrchestrator(c, store);
        orch.initializeRuntime = async () => { entered(); await gate; };
        return orch;
      },
      startServer: async context => {
        const server = await startServer(context);
        origin = server.urls[0]!;
        return server;
      },
    });
    await initializing;
    try {
      for (const path of ["/api/sync", "/api/readiness", "/api/runtime"]) {
        const response = await fetch(origin + path, { headers: { Authorization: `Bearer ${settings.accessCode}` } });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "서버를 시작하는 중입니다", code: "STARTING" });
      }
    } finally { release(); }
    const runtime = await starting;
    stops.push(runtime.stop);
    expect(runtime.startupMs).toBeGreaterThan(0);
    expect(existsSync(join(settings.home, "backups"))).toBe(false);
    expect((await fetch(origin + "/api/readiness", { headers: { Authorization: `Bearer ${settings.accessCode}` } })).status).toBe(200);
    await runtime.stop();
    expect(existsSync(join(settings.home, "backups"))).toBe(false);
  });

  test("production assembly records in the domain transaction, mounts authenticated push HTTP, wakes only after commit and backs up", async () => {
    const settings = config();
    const sent: APNsNotification[] = [];
    const provider = client(async (notification) => { expect(runtime.store.db.inTransaction).toBe(false); sent.push(notification); return { state: "accepted", reason: "accepted", status: 200 }; });
    const runtime = await startOpsRuntime(settings, { createOrchestrator: fakeOrchestrator, client: provider });
    stops.push(runtime.stop);
    expect(runtime.server.port).not.toBe(7878);
    expect(() => acquireHomeOwner(settings.home)).toThrow("다른 작업");
    const headers = { Authorization: `Bearer ${settings.accessCode}` };
    const origin = runtime.server.urls[0]!;
    expect((await fetch(`${origin}/api/push/status`)).status).toBe(401);
    expect((await fetch(`${origin}/api/push/status`, { headers })).status).toBe(200);
    await waitForReadiness({ ...settings, port: runtime.server.port }, { timeoutMs: 1_000 });
    const device = runtime.push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID,
      environment: "sandbox", deviceToken: "aabb", authorization: "authorized" });
    runtime.push.patchDevice(device.id, { expectedRevision: device.revision, enabled: true });
    const member = runtime.store.createMember({ projectId: "hq", handle: "w", name: "직원", kind: "worker", origin: "manual" });
    expect(() => runtime.store.transaction(() => {
      runtime.store.createDecision({ projectId: "hq", memberId: member.id, who: member.name, title: "rollback" });
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(runtime.push.listEvents()).toHaveLength(0);
    runtime.store.createDecision({ projectId: "hq", memberId: member.id, who: member.name, title: "private ask" });
    const deadline = Date.now() + 2_000;
    while (!sent.length && Date.now() < deadline) await Bun.sleep(10);
    expect(sent).toHaveLength(1);
    const snapshot = await runtime.backups.run(true);
    expect(verifyBackup(snapshot!.directory).manifest.database.size).toBeGreaterThan(0);
    expect(readdirSync(join(settings.home, "backups")).some((name) => name.startsWith("snapshot-"))).toBe(true);
    await runtime.stop(); await runtime.stop();
    expect(provider.closed).toBe(1);
    using owner = acquireHomeOwner(settings.home);
  });

  test("home lock precedes DB/schema access, and DB/HTTP/recovery failures release every resource", async () => {
    const settings = config();
    writeFileSync(settings.dbPath, "not a database");
    using first = acquireHomeOwner(settings.home);
    await expect(startOpsRuntime(settings)).rejects.toThrow("다른 작업");
    first.release();
    await expect(startOpsRuntime(settings)).rejects.toThrow();
    using next = acquireHomeOwner(settings.home);
    next.release();
    for (const phase of ["HTTP", "initialize", "recover"]) {
      const clean = config(); const provider = client();
      let serverStopped = false; let shutdown = false;
      await expect(startOpsRuntime(clean, { client: provider,
        createOrchestrator: (c, store) => {
          const orch = fakeOrchestrator(c, store);
          const stop = orch.shutdown.bind(orch);
          orch.shutdown = async () => { shutdown = true; await stop(); };
          if (phase === "initialize") orch.initializeRuntime = async () => { throw new Error(phase); };
          if (phase === "recover") orch.recover = async () => { throw new Error(phase); };
          return orch;
        },
        startServer: async (context) => {
          if (phase === "HTTP") throw new Error(phase);
          const server = await startServer(context);
          return { ...server, stop: async () => { serverStopped = true; await server.stop(); } };
        },
      })).rejects.toThrow(phase);
      expect(provider.closed).toBe(1); expect(shutdown).toBe(true);
      expect(serverStopped).toBe(phase !== "HTTP");
      using owner = acquireHomeOwner(clean.home);
    }
  });

  test("pending receipts are unknown before runtime initialization and durable leases survive", async () => {
    const settings = config(); const db = openDb(settings.dbPath); const store = new Store(db, new Bus());
    const member = store.createMember({ projectId: "hq", handle: "w", name: "직원", kind: "worker", origin: "manual" });
    const operationId = randomUUID();
    store.beginOperation({ operationId, kind: "terminal_control", projectId: "hq", memberId: member.id, request: { text: "never replay" } });
    const identity = { terminalId: "terminal", sessionGeneration: store.memberRevisions(member.id).sessionGeneration, sessionId: null, process: null };
    // Store owns serialization; the runtime never edits/replaces the lease journal.
    store.saveLease({ memberId: member.id, claimId: "claim", leaseId: "lease", identity,
      expiresAt: Date.now() + 60_000, lastInputSequence: 3 });
    db.close();
    const calls: string[] = [];
    const runtime = await startOpsRuntime(settings, { client: client(), createOrchestrator: (c, state) => {
      const orch = fakeOrchestrator(c, state);
      orch.initializeRuntime = async () => {
        calls.push("initialize");
        expect(state.getOperation(operationId)?.status).toBe("unknown");
        expect(state.inputState(member.id).lease?.claimId).toBe("claim");
      };
      const recover = orch.recover.bind(orch);
      orch.recover = async () => { calls.push("recover"); await recover(); };
      return orch;
    } });
    stops.push(runtime.stop);
    expect(calls).toEqual(["initialize", "recover"]);
    expect(runtime.store.getOperation(operationId)?.status).toBe("unknown");
    expect(runtime.store.inputState(member.id).lease?.lastInputSequence).toBe(3);
  });

  test("periodic backups and conservative storage sweep run under ownership and stop with the runtime", async () => {
    const settings = config();
    const source = join(settings.home, "fixture.txt"); writeFileSync(source, "failed upload");
    const db = openDb(settings.dbPath); const store = new Store(db, new Bus());
    const publication = new FilePublication(settings.uploadsDir);
    await publication.stagePath(prepareImport(source));
    publication.fail(createStorageReferences(store, settings.inboxDir));
    const manifest = JSON.parse(readFileSync(join(publication.directory, "manifest.json"), "utf8")) as PublicationManifest;
    writePublicationManifest(publication.directory, { ...manifest, createdAt: Date.now() - STAGING_GRACE_MS - 10_000,
      failedAt: Date.now() - STAGING_GRACE_MS - 1_000 });
    db.close();
    const runtime = await startOpsRuntime(settings, { client: client(), createOrchestrator: fakeOrchestrator,
      backupPolicy: { intervalMs: 20 }, sweepIntervalMs: 20, maintenanceDelayMs: 10 });
    stops.push(runtime.stop);
    expect(existsSync(publication.directory)).toBe(true);
    expect(existsSync(join(settings.home, "backups"))).toBe(false);
    const maintenanceDeadline = Date.now() + 2_000;
    while (existsSync(publication.directory) && Date.now() < maintenanceDeadline) await Bun.sleep(10);
    expect(existsSync(join(settings.uploadsDir, ".quarantine", manifest.id))).toBe(true);
    expect(existsSync(publication.directory)).toBe(false);
    expect(runtime.storage.usage().quarantine.files).toBeGreaterThan(0);
    const initial = readdirSync(join(settings.home, "backups")).filter(name => name.startsWith("snapshot-"));
    const deadline = Date.now() + 2_000;
    let later = initial;
    while (Date.now() < deadline && later.join() === initial.join()) {
      await Bun.sleep(20);
      later = readdirSync(join(settings.home, "backups")).filter(name => name.startsWith("snapshot-"));
    }
    expect(later).not.toEqual(initial);
    await runtime.stop();
    const stopped = readdirSync(join(settings.home, "backups"));
    await Bun.sleep(50);
    expect(readdirSync(join(settings.home, "backups"))).toEqual(stopped);
  });

  test("shutdown drains the active APNs attempt as unknown within the shared 15-second budget", async () => {
    const settings = config(); let sending!: () => void;
    const entered = new Promise<void>(resolve => { sending = resolve; });
    const provider = client(async () => { sending(); return new Promise<APNsResult>(() => {}); });
    const runtime = await startOpsRuntime(settings, { client: provider, createOrchestrator: fakeOrchestrator });
    stops.push(runtime.stop);
    const device = runtime.push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID,
      environment: "sandbox", deviceToken: "aabb", authorization: "authorized" });
    runtime.push.patchDevice(device.id, { expectedRevision: device.revision, enabled: true });
    const member = runtime.store.createMember({ projectId: "hq", handle: "w", name: "직원", kind: "worker", origin: "manual" });
    runtime.store.createDecision({ projectId: "hq", memberId: member.id, who: member.name, title: "private ask" });
    await entered;
    const started = Date.now();
    await shutdownWithinBudget(runtime.stop);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(provider.closed).toBe(1);
    const db = openDb(settings.dbPath);
    try { expect(db.query<{ state: string }, []>("SELECT state FROM push_deliveries").get()?.state).toBe("unknown"); }
    finally { db.close(); }
  }, 12_000);

  test("one shutdown deadline bounds concurrent cleanup and surfaces failures", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const started = Date.now();
    await expect(shutdownWithinBudget(() => pending, 30)).rejects.toThrow("종료 예산");
    expect(Date.now() - started).toBeLessThan(500);
    finish();
    await expect(shutdownWithinBudget(async () => { throw new Error("cleanup failed"); })).rejects.toThrow("cleanup failed");
  });
});
