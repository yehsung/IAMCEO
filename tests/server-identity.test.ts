// V(0.2.5): 서버 신원(Bootstrap.server.id). 앱이 '연결되면 보낼 글'을 쓴 서버에 묶는 값이다.
// - 알림이 쓰는 서버 ID(push_meta.server_id)와 같은 값이고, 버전 머리글을 보낸 앱에만 싣는다(출시된 0.2.2·0.2.3 응답은 그대로).
// - 서버를 다시 켜도 같고, 백업을 같은 곳에 복원하면 같으며, 다른 Mac 에 복제(--clone)하면 새 값이다.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_LEVEL, APP_HEADERS, type Bootstrap, type SyncSnapshot } from "../shared/types.ts";
import { compatFields } from "../server/app-version.ts";
import { createBackup } from "../server/backup.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, VERSION } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { PushStore } from "../server/push/store.ts";
import { restoreBackup } from "../server/restore.ts";
import { readServerId, serverIdentity } from "../server/server-identity.ts";
import { Store } from "../server/store.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const appHeaders = { [APP_HEADERS.version]: "0.2.5", [APP_HEADERS.build]: "1", [APP_HEADERS.platform]: "ios", [APP_HEADERS.apiLevel]: String(API_LEVEL) };

/** 게이트가 TMPDIR 을 시험마다 따로 주고 끝나면 지운다. */
function tempHome(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

async function boot(options: { push?: boolean } = {}) {
  const home = tempHome("iamceo-identity-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  const config = { ...loadConfig(env), hosts: ["127.0.0.1"] };
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const push = options.push === false ? undefined : new PushStore(store.db);
  const orch = new Orchestrator({ config, store, runners: new Map() });
  const context = { config, store, bus, orch, daemon: () => ({ ready: true, buildId: "fixture-build", version: VERSION }),
    ...(push ? { push: { store: push, providers: () => [] } } : {}) };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); store.db.close(); });
  const get = async <T>(path: string, extra: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: "Bearer code", ...extra } });
    expect(response.status).toBe(200);
    return await response.json() as T;
  };
  return { store, push, get, home };
}

describe("서버 ID 읽기", () => {
  test("알림 저장소가 만든 ID 를 읽고, 없거나 모양이 어긋나면 싣지 않는다", () => {
    const db = openDb(join(tempHome("iamceo-identity-db-"), "iamceo.db"));
    cleanups.push(() => db.close());
    expect(readServerId(db)).toBeUndefined();
    const id = new PushStore(db).serverId;
    expect(readServerId(db)).toBe(id);
    expect(serverIdentity({ store: { db } })).toBe(id);
    // 다시 열어도(서버 재시작) 같은 값이다.
    expect(new PushStore(db).serverId).toBe(id);

    const odd = new Database(":memory:");
    cleanups.push(() => odd.close());
    expect(readServerId(odd)).toBeUndefined();
    odd.exec("CREATE TABLE push_meta (id INTEGER PRIMARY KEY, server_id TEXT, created_at TEXT)");
    odd.query("INSERT INTO push_meta VALUES (1, 'not an id; drop', 'x')").run();
    expect(readServerId(odd)).toBeUndefined();
  });

  test("compatFields: 머리글이 있을 때만, 준 ID 를 server.id 로", () => {
    const app = { version: "0.2.5", build: "1", platform: "ios" as const, apiLevel: API_LEVEL };
    expect(compatFields(null, VERSION, { serverId: "abc" })).toEqual({});
    expect(compatFields(app, VERSION, { serverId: "abc" })).toEqual({ server: { version: VERSION, apiLevel: API_LEVEL, id: "abc" } });
    expect(compatFields(app, VERSION)).toEqual({ server: { version: VERSION, apiLevel: API_LEVEL } });
  });
});

describe("응답", () => {
  test("새 앱의 bootstrap·sync 에 알림과 같은 서버 ID 가 실리고, 머리글 없는 출시 앱에는 없다", async () => {
    const f = await boot();
    const id = f.push!.serverId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const bootstrap = await f.get<Bootstrap>("/api/bootstrap", appHeaders);
    const sync = await f.get<SyncSnapshot>("/api/sync", appHeaders);
    expect(bootstrap.server).toEqual({ version: VERSION, apiLevel: API_LEVEL, id });
    expect(sync.bootstrap.server).toEqual({ version: VERSION, apiLevel: API_LEVEL, id });
    const old = await f.get<Record<string, unknown>>("/api/bootstrap");
    const oldSync = await f.get<{ bootstrap: Record<string, unknown> }>("/api/sync");
    expect("server" in old).toBe(false);
    expect("server" in oldSync.bootstrap).toBe(false);
    expect(JSON.stringify(old)).not.toContain(id);
  });

  test("알림 저장소가 없는 시험 서버는 ID 없이 버전만 싣는다(앱은 옛 판정으로 돌아간다)", async () => {
    const f = await boot({ push: false });
    const bootstrap = await f.get<Bootstrap>("/api/bootstrap", appHeaders);
    expect(bootstrap.server).toEqual({ version: VERSION, apiLevel: API_LEVEL });
  });
});

describe("복원", () => {
  function seededHome() {
    const root = tempHome("iamceo-identity-restore-");
    const home = join(root, "home");
    mkdirSync(join(home, "uploads"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), JSON.stringify({ accessCode: "fixture-secret", port: 0, hosts: ["127.0.0.1"] }), { mode: 0o600 });
    const db = openDb(join(home, "iamceo.db"));
    const id = new PushStore(db).serverId;
    db.close();
    return { root, home, id };
  }
  function restoredId(home: string): string | undefined {
    const db = new Database(join(home, "iamceo.db"), { readonly: true });
    try { return readServerId(db); } finally { db.close(); }
  }

  test("같은 곳 복원은 같은 ID, 복제(--clone)는 새 ID", () => {
    const f = seededHome();
    const snapshot = createBackup({ home: f.home, backupDir: join(f.root, "backups"), now: new Date("2026-11-13T00:00:00.000Z") });
    const same = restoreBackup({ snapshotDir: snapshot.directory, destinationHome: join(f.root, "same"), mode: "same-host" });
    const clone = restoreBackup({ snapshotDir: snapshot.directory, destinationHome: join(f.root, "clone"), mode: "clone" });
    expect(same.serverId).toBe(f.id);
    expect(restoredId(join(f.root, "same"))).toBe(f.id);
    expect(clone.serverId).not.toBe(f.id);
    expect(restoredId(join(f.root, "clone"))).toBe(clone.serverId!);
  });
});
