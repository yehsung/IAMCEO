import { afterEach, expect, spyOn, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

test("explicit secondary bind failure is observable and retried without expanding configured addresses", async () => {
  const isolated = createIsolatedRuntime();
  const env = isolated.childEnv();
  updateConfigFile({ hosts: ["127.0.0.1", "::1"] }, env);
  const config = loadConfig(env);
  expect(config.hostsAuto).toBe(false);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  let fail = true;
  const attempted: string[] = [];
  const original = Bun.serve;
  const spy = spyOn(Bun, "serve").mockImplementation(((options: Parameters<typeof Bun.serve>[0]) => {
    const host = options.hostname!;
    attempted.push(host);
    if (host === "::1" && fail) throw new Error("fixture address not available");
    return original(options);
  }) as typeof Bun.serve);
  try {
    const context = { config, store, bus, orch: {} as OrchestratorApi, detectHosts: () => ["0.0.0.0", "100.64.0.99"],
      daemon: () => ({ ready: true, version: "0.1.0", buildId: "b".repeat(64) }) };
    let server = await startServer(context);
    while (server.port === 7878) { await server.stop(); server = await startServer(context); }
    stops.push(async () => { await server.stop(); store.db.close(); await isolated.stop(); });
    expect(server.hosts).toEqual(["127.0.0.1"]);
    expect(server.urls).toEqual([`http://127.0.0.1:${server.port}`]);
    expect(server.hostBindings).toContainEqual(expect.objectContaining({ host: "::1", state: "failed", attempts: 1, error: "HOST_BIND_FAILED" }));
    const diagnostic = await fetch(`${server.urls[0]}/api/readiness`, { headers: { Authorization: `Bearer ${config.accessCode}` } });
    expect((await diagnostic.json() as { hosts: unknown[] }).hosts).toContainEqual(expect.objectContaining({ host: "::1", state: "failed" }));
    server.syncHosts();
    expect(server.hostBindings!.find(binding => binding.host === "::1")?.attempts).toBe(2);
    fail = false;
    server.syncHosts();
    expect(server.hosts).toEqual(["127.0.0.1", "::1"]);
    expect(server.urls).toContain(`http://[::1]:${server.port}`);
    expect(server.hostBindings).toContainEqual(expect.objectContaining({ host: "::1", state: "bound", attempts: 3, error: null }));
    // Fetch still connects to an owned loopback listener, never to a tailnet address.
    expect((await fetch(`http://[::1]:${server.port}/api/health`)).status).toBe(200);
    const count = attempted.length;
    server.syncHosts();
    expect(attempted).toHaveLength(count);
    expect(attempted.every(host => ["127.0.0.1", "::1"].includes(host))).toBe(true);
    await server.stop();
    server.syncHosts();
    expect(attempted).toHaveLength(count);
  } finally { spy.mockRestore(); }
});
