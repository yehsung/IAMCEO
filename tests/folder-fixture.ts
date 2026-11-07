import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Store } from "../server/store.ts";

export async function folderFixture(path?: string, environment?: (home: string) => Record<string, string>) {
  const root = mkdtempSync("/private/tmp/iamceo-folders-"), home = join(root, "home");
  mkdirSync(home);
  const config = loadConfig({ IAMCEO_HOME: join(root, "state"), IAMCEO_PORT: "0", ...environment?.(home) });
  const bus = new Bus(), store = new Store(openDb(config.dbPath), bus);
  const previousPath = process.env.PATH;
  if (path !== undefined) process.env.PATH = path;
  let server;
  try { server = await startServer({ config, bus, store, orch: {} as OrchestratorApi, folderHome: home, githubFreeBytes: async () => 10 * 1024 ** 3 }); }
  finally { process.env.PATH = previousPath; }
  const base = `http://127.0.0.1:${server.port}`;
  return {
    root, home, store, config,
    request: (path: string, body?: unknown, authorized = true) => fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(authorized ? { Authorization: `Bearer ${config.accessCode}` } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    close: async () => { await server.stop(); store.db.close(); },
  };
}
