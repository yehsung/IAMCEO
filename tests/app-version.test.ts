// D5: 앱 버전 머리글과 어긋남 안내. 머리글이 없는 출시 앱(0.2.2·0.2.3)에는 새 필드가 한 글자도 실리지 않고,
// 머리글을 보낸 앱에는 server 가 늘, compat 은 실제로 어긋날 때만 실린다. 서버는 가짜 실행기 없이 HTTP 만 띄운다.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_LEVEL, APP_HEADERS, MIN_APP_API_LEVEL, type AppClientInfo, type Bootstrap, type SeenAppClient, type SyncSnapshot } from "../shared/types.ts";
import { compatFields, compatNotice, readAppClient, SeenApps } from "../server/app-version.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, VERSION } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function headers(fields: Partial<Record<keyof typeof APP_HEADERS, string>>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(fields)) result.set(APP_HEADERS[key as keyof typeof APP_HEADERS], value!);
  return result;
}
const app = (overrides: Partial<AppClientInfo> = {}): AppClientInfo => ({ version: "0.2.4", build: "7", platform: "ios", apiLevel: API_LEVEL, ...overrides });
const appHeaders = (apiLevel: number, platform = "ios") => ({
  [APP_HEADERS.version]: "0.2.4", [APP_HEADERS.build]: "7", [APP_HEADERS.platform]: platform, [APP_HEADERS.apiLevel]: String(apiLevel),
});

async function boot() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-appversion-")));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  const config = { ...loadConfig(env), hosts: ["127.0.0.1"] };
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const orch = new Orchestrator({ config, store, runners: new Map() });
  const context = { config, store, bus, orch, daemon: () => ({ ready: true, buildId: "fixture-build", version: VERSION }) };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); store.db.close(); });
  const get = async <T>(path: string, extra: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: "Bearer code", ...extra } });
    expect(response.status).toBe(200);
    return await response.json() as T;
  };
  return { store, get };
}

describe("머리글 읽기", () => {
  test("버전·플랫폼·API 단계가 다 맞아야 앱으로 읽는다", () => {
    expect(readAppClient(headers({ version: "0.2.4", build: "31", platform: "ios", apiLevel: "1" })))
      .toEqual({ version: "0.2.4", build: "31", platform: "ios", apiLevel: 1 });
    // 플랫폼은 대소문자를 가리지 않고, 빌드는 없어도 된다.
    expect(readAppClient(headers({ version: "0.3.0-beta.1", platform: "MacOS", apiLevel: "2" })))
      .toEqual({ version: "0.3.0-beta.1", build: null, platform: "macos", apiLevel: 2 });
    // 출시된 옛 앱: 머리글이 하나도 없다.
    expect(readAppClient(new Headers())).toBeNull();
    for (const bad of [
      { platform: "ios", apiLevel: "1" },
      { version: "0.2.4", apiLevel: "1" },
      { version: "0.2.4", platform: "ios" },
      { version: "0.2.4", platform: "android", apiLevel: "1" },
      { version: "0.2.4", platform: "ios", apiLevel: "0" },
      { version: "0.2.4", platform: "ios", apiLevel: "1.5" },
      { version: "0.2.4", platform: "ios", apiLevel: "99999" },
      { version: "0.2.4 <script>", platform: "ios", apiLevel: "1" },
      { version: "x".repeat(40), platform: "ios", apiLevel: "1" },
    ]) expect(readAppClient(headers(bad))).toBeNull();
    // 모양이 어긋난 빌드 번호는 버리고 나머지는 읽는다.
    expect(readAppClient(headers({ version: "0.2.4", build: "7 8;x", platform: "ios", apiLevel: "1" }))?.build).toBeNull();
  });

  test("단계가 같으면 안내가 없고, 앱이 낮으면 app_outdated, 높으면 server_outdated", () => {
    expect(compatNotice(app(), "0.2.4")).toBeNull();
    const levels = { apiLevel: 3, minAppApiLevel: 2 };
    expect(compatNotice(app({ apiLevel: 2 }), "0.4.0", levels)).toBeNull();
    expect(compatNotice(app({ apiLevel: 3 }), "0.4.0", levels)).toBeNull();
    const old = compatNotice(app({ apiLevel: 1 }), "0.4.0", levels);
    expect(old?.state).toBe("app_outdated");
    expect(old?.message).toContain("App Store");
    expect(old?.message).toContain("0.4.0");
    const oldMac = compatNotice(app({ apiLevel: 1, platform: "macos" }), "0.4.0", levels);
    expect(oldMac?.state).toBe("app_outdated");
    expect(oldMac?.message).not.toContain("App Store");
    const ahead = compatNotice(app({ apiLevel: 4, version: "0.5.0" }), "0.4.0", levels);
    expect(ahead).toEqual({ state: "server_outdated", message: expect.stringContaining("서버(0.4.0)") });
    expect(ahead?.message).toContain("0.5.0");
    // 사용자 문구에 영어 약어·내부 용어가 없다.
    for (const message of [old!.message, oldMac!.message, ahead!.message]) expect(message).not.toMatch(/API|apiLevel|compat|header/i);
  });

  test("머리글이 없으면 덧붙일 필드가 없다", () => {
    expect(compatFields(null, VERSION)).toEqual({});
    expect(compatFields(app(), VERSION)).toEqual({ server: { version: VERSION, apiLevel: API_LEVEL } });
    expect(MIN_APP_API_LEVEL).toBeLessThanOrEqual(API_LEVEL);
  });

  test("접속한 앱 기록: 처음 보는 조합만 한 줄 남기고, 최근 것부터 8개까지", () => {
    const lines: string[] = [];
    let now = Date.parse("2026-11-13T00:00:00.000Z");
    const seen = new SeenApps(3, line => lines.push(line), () => new Date(now));
    seen.note(null);
    seen.note(app());
    now += 1000; seen.note(app());
    now += 1000; seen.note(app({ platform: "macos", build: null }));
    expect(lines).toEqual(["앱 접속: ios 0.2.4 (빌드 7) · API 단계 1", "앱 접속: macos 0.2.4 · API 단계 1"]);
    expect(seen.list().map(entry => [entry.platform, entry.lastSeenAt])).toEqual([["macos", "2026-11-13T00:00:02.000Z"], ["ios", "2026-11-13T00:00:01.000Z"]]);
    for (const version of ["0.2.5", "0.2.6", "0.2.7"]) seen.note(app({ version }));
    expect(seen.list().map(entry => entry.version)).toEqual(["0.2.7", "0.2.6", "0.2.5"]);
  });
});

describe("응답", () => {
  test("머리글 없는 출시 앱: bootstrap·sync·readiness 에 새 필드가 없다", async () => {
    const f = await boot();
    const bootstrap = await f.get<Record<string, unknown>>("/api/bootstrap");
    const sync = await f.get<{ bootstrap: Record<string, unknown> }>("/api/sync");
    for (const body of [bootstrap, sync.bootstrap]) {
      expect("server" in body).toBe(false);
      expect("compat" in body).toBe(false);
    }
    expect("apps" in await f.get<Record<string, unknown>>("/api/readiness")).toBe(false);
  });

  test("단계가 맞는 새 앱: server 만 실리고 compat 은 없다", async () => {
    const f = await boot();
    const bootstrap = await f.get<Bootstrap>("/api/bootstrap", appHeaders(API_LEVEL));
    const sync = await f.get<SyncSnapshot>("/api/sync", appHeaders(API_LEVEL));
    for (const body of [bootstrap, sync.bootstrap]) {
      expect(body.server).toEqual({ version: VERSION, apiLevel: API_LEVEL });
      expect("compat" in body).toBe(false);
    }
    const readiness = await f.get<{ apps?: SeenAppClient[] }>("/api/readiness");
    expect(readiness.apps).toEqual([{ version: "0.2.4", build: "7", platform: "ios", apiLevel: API_LEVEL, lastSeenAt: expect.any(String) }]);
  });

  test("서버보다 높은 단계의 앱: server_outdated. 같은 순간의 다른 앱 응답에는 섞이지 않는다", async () => {
    const f = await boot();
    const ahead = await f.get<SyncSnapshot>("/api/sync", appHeaders(API_LEVEL + 1, "macos"));
    expect(ahead.bootstrap.compat?.state).toBe("server_outdated");
    expect(ahead.bootstrap.server).toEqual({ version: VERSION, apiLevel: API_LEVEL });
    // sync 는 같은 세대 안에서 응답을 캐시한다. 옛 앱과 맞는 앱이 그 캐시를 나눠 받으면 안 된다.
    const plain = await f.get<{ bootstrap: Record<string, unknown> }>("/api/sync");
    expect("compat" in plain.bootstrap).toBe(false);
    expect("server" in plain.bootstrap).toBe(false);
    const matching = await f.get<SyncSnapshot>("/api/sync", appHeaders(API_LEVEL));
    expect(matching.bootstrap.compat).toBeUndefined();
    const again = await f.get<SyncSnapshot>("/api/sync", appHeaders(API_LEVEL + 1, "macos"));
    expect(again.bootstrap.compat).toEqual(ahead.bootstrap.compat);
    const bootstrap = await f.get<Bootstrap>("/api/bootstrap", appHeaders(API_LEVEL + 1, "macos"));
    expect(bootstrap.compat).toEqual(ahead.bootstrap.compat);
  });

  test("모양이 어긋난 머리글은 옛 앱처럼 다룬다", async () => {
    const f = await boot();
    const body = await f.get<Record<string, unknown>>("/api/bootstrap", { ...appHeaders(API_LEVEL), [APP_HEADERS.apiLevel]: "abc" });
    expect("server" in body).toBe(false);
    expect("compat" in body).toBe(false);
  });
});
