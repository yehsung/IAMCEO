// G(C3): 기기마다 따로 주는 열쇠, 한 대만 끊기, 접속 기록.
// 지금 공용 접속 코드로 붙은 기기(대표의 iPhone·Mac 앱)는 끊기지 않는다. 짝 맺기는 그 기기만의 열쇠를 accessCode 칸에 준다.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { join } from "node:path";
import { createBackup } from "../server/backup.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { ACCESS_LOG_LIMITS, type AccessLogLimits, authenticate, DEVICE_KEY_PREFIX, DeviceKeys, deviceDisplayName, principalKey, revokeAllDeviceKeys, SHARED_PRINCIPAL } from "../server/devices.ts";
import { startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Pairing } from "../server/pairing.ts";
import { revokeDeviceKeys, rotateAccess } from "../bin/iamceo.ts";
import { restoreBackup } from "../server/restore.ts";
import { Store } from "../server/store.ts";
import type { AuthRotateResult, DeviceAccessList, DeviceRevokeAllResult, DeviceRevokeResult } from "../shared/types.ts";
import { APP_HEADERS } from "../shared/types.ts";
import { createIsolatedRuntime, type IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const SHARED = "devices-shared-canary";
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); });

function memoryKeys(start = Date.parse("2026-11-13T00:00:00.000Z"), limits: Partial<AccessLogLimits> = {}) {
  const db = openDb(":memory:");
  cleanups.push(() => db.close());
  let now = start;
  const keys = new DeviceKeys(db, { now: () => now, limits });
  return { db, keys, advance: (ms: number) => { now += ms; }, at: () => now };
}

/** 모든 기기·기록 표의 글자를 이어 붙인다. 코드·열쇠 값이 들어가지 않았는지 볼 때 쓴다. */
function authTableText(db: Database): string {
  return ["auth_devices", "auth_events", "auth_shared_seen"].map(table => JSON.stringify(db.query(`SELECT * FROM ${table}`).all())).join("\n");
}

describe("판정 함수와 열쇠 저장", () => {
  test("열쇠는 해시로만 남고, 공용 코드·기기 열쇠·틀린 값·끊은 열쇠를 한 함수로 가른다", () => {
    const { db, keys } = memoryKeys();
    const issued = keys.issue({ name: "대표의 iPhone", address: "100.64.0.2", platform: null })!;
    expect(issued.key.startsWith(DEVICE_KEY_PREFIX)).toBe(true);
    expect(issued.key).toMatch(/^dk1\.dev[A-Za-z0-9]{16}\.[A-Za-z0-9_-]{43}$/);
    const secret = issued.key.split(".")[2]!;
    const stored = db.query<{ secret_hash: string }, []>("SELECT secret_hash FROM auth_devices").get()!;
    expect(stored.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.secret_hash).toBe(new Bun.CryptoHasher("sha256").update(secret).digest("hex"));
    expect(authTableText(db)).not.toContain(secret);

    expect(authenticate(SHARED, SHARED, keys)).toEqual({ ok: true, principal: SHARED_PRINCIPAL });
    expect(authenticate(issued.key, SHARED, keys)).toEqual({ ok: true, principal: { kind: "device", id: issued.id } });
    expect(authenticate(null, SHARED, keys)).toEqual({ ok: false, reason: "missing" });
    expect(authenticate("", SHARED, keys)).toEqual({ ok: false, reason: "missing" });
    expect(authenticate("wrong", SHARED, keys)).toEqual({ ok: false, reason: "wrong" });
    // 같은 기기 ID 에 다른 비밀, 모양이 어긋난 열쇠, 없는 기기는 모두 '틀림'이다.
    const forged = `${DEVICE_KEY_PREFIX}${issued.id}.${"A".repeat(43)}`;
    for (const token of [forged, `${DEVICE_KEY_PREFIX}${issued.id}.short`, `${DEVICE_KEY_PREFIX}devAAAAAAAAAAAAAAAA.${secret}`, `${issued.key}.extra`, `dk2.${issued.id}.${secret}`]) {
      expect(authenticate(token, SHARED, keys)).toEqual({ ok: false, reason: "wrong" });
    }
    // 표가 없는 서버(만들기 실패)에서도 공용 코드는 통하고 열쇠는 '틀림'이다.
    expect(authenticate(issued.key, SHARED, null)).toEqual({ ok: false, reason: "wrong" });

    expect(keys.revoke(issued.id, "127.0.0.1")?.name).toBe("대표의 iPhone");
    expect(authenticate(issued.key, SHARED, keys)).toEqual({ ok: false, reason: "revoked", deviceId: issued.id });
    expect(keys.isActive(issued.id)).toBe(false);
    expect(keys.revoke(issued.id, null)).toBeNull();
    expect(keys.revoke("../etc", null)).toBeNull();
    expect(authenticate(SHARED, SHARED, keys).ok).toBe(true);
  });

  test("기기 이름은 한 줄로 다듬고, 비어 있으면 '이름 없는 기기'", () => {
    expect(deviceDisplayName("  민수의\n iPhone​ ")).toBe("민수의 iPhone");
    expect(deviceDisplayName("x".repeat(100))).toHaveLength(64);
    expect(deviceDisplayName(42)).toBe("이름 없는 기기");
    expect(deviceDisplayName("\u0000\t")).toBe("이름 없는 기기");
  });

  test("마지막 접속은 메모리에만 남기고(조회는 DB 를 쓰지 않는다) flush 때 한꺼번에 쓴다. 목록은 메모리의 최신 값, 플랫폼은 머리글로 배운다", () => {
    const { db, keys, advance, at } = memoryKeys();
    const iso = (ms: number) => new Date(ms).toISOString();
    const changes = () => db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
    const issued = keys.issue({ name: "iPad", address: "100.64.0.3", platform: null })!;
    const device = { kind: "device" as const, id: issued.id };
    const start = at();
    const before = changes();
    keys.touch(device, "other", "100.64.0.3");
    advance(30_000);
    keys.touch(device, "ios", "100.64.0.3");
    keys.touch(SHARED_PRINCIPAL, "macos", "127.0.0.1");
    // 요청 안에서는 DB 를 쓰지 않는다. 목록(조회)도 쓰지 않고 메모리의 값을 보인다.
    expect(changes()).toBe(before);
    expect(db.query("SELECT last_seen_at, platform FROM auth_devices").get()).toEqual({ last_seen_at: null, platform: null });
    expect(keys.list(device).devices[0]).toMatchObject({ platform: "ios", lastSeenAt: iso(start + 30_000), current: true });
    expect(changes()).toBe(before);
    // flush(서버 타이머·멈출 때)가 한꺼번에 쓴다. 새로 바뀐 것이 없으면 다시 쓰지 않는다.
    keys.flush();
    expect(db.query("SELECT last_seen_at, platform FROM auth_devices").get()).toEqual({ last_seen_at: iso(start + 30_000), platform: "ios" });
    expect(db.query("SELECT platform FROM auth_shared_seen").all()).toEqual([{ platform: "macos" }]);
    const flushed = changes();
    keys.flush();
    expect(changes()).toBe(flushed);
    // 머리글 없는 요청은 배운 플랫폼을 지우지 않는다.
    advance(61_000);
    keys.touch(device, "other", "100.64.0.4");
    keys.flush();
    expect(db.query("SELECT last_seen_at, platform, last_address FROM auth_devices").get()).toEqual({ last_seen_at: iso(start + 91_000), platform: "ios", last_address: "100.64.0.4" });

    keys.touch(SHARED_PRINCIPAL, "macos", "127.0.0.1");
    keys.touch(SHARED_PRINCIPAL, "local", "127.0.0.1");
    advance(1_000);
    keys.touch(SHARED_PRINCIPAL, "other", "100.64.0.9");
    const list = keys.list(SHARED_PRINCIPAL);
    expect(list.shared.current).toBe(true);
    expect(list.devices[0]).toMatchObject({ name: "iPad", platform: "ios", current: false });
    expect(list.shared.platforms.map(entry => entry.platform)).toEqual(["other", "macos", "local"]);
    expect(list.shared.lastSeenAt).toBe(list.shared.platforms[0]!.lastSeenAt);
    expect(keys.list(device).devices[0]!.current).toBe(true);
    expect(keys.list(device).shared.current).toBe(false);
  });

  test("실패는 주소마다 몇 분씩 한 줄로 묶어 세고, 묶음이 지나면 새 줄을 쓴다. 메모리에 쥐는 주소 수도 묶는다", () => {
    const { db, keys, advance } = memoryKeys(undefined, { trackedAddresses: 4 });
    for (let i = 0; i < 500; i++) keys.recordFailure("auth_failed", "100.64.0.66", { ok: false, reason: "wrong" });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM auth_events").get()!.n).toBe(1);
    expect(keys.list(SHARED_PRINCIPAL).failures).toMatchObject({ count: 500, days: 7 });
    advance(ACCESS_LOG_LIMITS.failureWindowMs);
    keys.recordFailure("auth_failed", "100.64.0.66", { ok: false, reason: "wrong" });
    keys.recordFailure("pair_failed", "100.64.0.67");
    const rows = db.query<{ kind: string; count: number; address: string; reason: string | null }, []>("SELECT kind, count, address, reason FROM auth_events ORDER BY id").all();
    expect(rows).toEqual([
      { kind: "auth_failed", count: 500, address: "100.64.0.66", reason: "wrong" },
      { kind: "auth_failed", count: 1, address: "100.64.0.66", reason: "wrong" },
      { kind: "pair_failed", count: 1, address: "100.64.0.67", reason: null },
    ]);
    expect(keys.list(SHARED_PRINCIPAL).failures.count).toBe(502);
    // 주소를 바꿔 가며 두드려도 메모리는 상한까지만 쥐고, 내보낸 줄의 수는 그대로 남는다.
    for (let i = 0; i < 20; i++) keys.recordFailure("auth_failed", `100.64.1.${i}`, { ok: false, reason: "wrong" });
    expect(keys.list(SHARED_PRINCIPAL).failures.count).toBe(522);
    // 7일이 지나면 '최근 실패'에서 빠진다(기록은 90일까지 남는다).
    advance(8 * 86_400_000);
    expect(keys.list(SHARED_PRINCIPAL).failures.count).toBe(0);
    expect(keys.list(SHARED_PRINCIPAL).events.length).toBeGreaterThan(0);
  });

  test("90일 지난 기록·상한을 넘는 기록·끊은 지 오래된 열쇠·한 번도 쓰지 않은 열쇠를 정리한다", () => {
    const { db, keys, advance } = memoryKeys(undefined, { maxEvents: 5 });
    const used = keys.issue({ name: "쓰는 기기", address: null, platform: "ios" })!;
    const unused = keys.issue({ name: "응답을 잃은 짝 맺기", address: null, platform: null })!;
    const old = keys.issue({ name: "옛 기기", address: null, platform: null })!;
    keys.touch({ kind: "device", id: used.id }, "ios", null);
    keys.touch({ kind: "device", id: old.id }, "ios", null);
    keys.revoke(old.id, null);
    advance(ACCESS_LOG_LIMITS.unusedKeyMs + 1);
    keys.prune();
    expect(keys.isActive(used.id)).toBe(true);
    expect(keys.isActive(unused.id)).toBe(false);
    expect(db.query("SELECT revoked_reason FROM auth_devices WHERE id = ?").get(unused.id)).toEqual({ revoked_reason: "unused" });
    for (let i = 0; i < 10; i++) keys.recordRotation("127.0.0.1");
    keys.prune();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM auth_events").get()!.n).toBe(5);
    advance(91 * 86_400_000);
    keys.prune();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM auth_events").get()!.n).toBe(0);
    expect(db.query("SELECT id FROM auth_devices ORDER BY id").all().map(row => (row as { id: string }).id).sort()).toEqual([used.id].sort());
  });

  test("표를 만들지 못한 DB 에서는 열쇠를 주지 않고(부르는 쪽이 503 으로 답한다) 기록 실패도 삼킨다. 그 DB 의 열쇠는 없으므로 '틀림'이다", () => {
    const db = openDb(":memory:");
    cleanups.push(() => db.close());
    for (const table of ["auth_events", "auth_devices", "auth_shared_seen"]) db.exec(`DROP TABLE ${table}`);
    const keys = new DeviceKeys(db);
    expect(keys.issue({ name: "iPhone", address: null, platform: null })).toBeNull();
    expect(keys.revokeAll(null)).toBeNull();
    expect(() => keys.recordFailure("auth_failed", "100.64.0.2", { ok: false, reason: "wrong" })).not.toThrow();
    expect(() => keys.touch(SHARED_PRINCIPAL, "local", "127.0.0.1")).not.toThrow();
    expect(() => keys.flush()).not.toThrow();
    expect(keys.list(SHARED_PRINCIPAL)).toMatchObject({ devices: [], events: [], failures: { count: 0 } });
    expect(authenticate(SHARED, SHARED, keys).ok).toBe(true);
    expect(authenticate(`${DEVICE_KEY_PREFIX}devAAAAAAAAAAAAAAAA.${"A".repeat(43)}`, SHARED, keys)).toEqual({ ok: false, reason: "wrong" });
  });

  test("열쇠를 읽다가 난 저장소 오류는 '틀림'이 아니라 오류다(출시된 앱은 401 이면 열쇠를 지운다). 열린 연결 확인은 오류면 살아 있다고 둔다", () => {
    const { db, keys } = memoryKeys();
    const issued = keys.issue({ name: "iPhone", address: null, platform: "ios" })!;
    const original = db.query.bind(db);
    const broken = spyOn(db, "query").mockImplementation(((sql: string) => {
      if (/FROM auth_devices/.test(sql)) throw new Error("disk I/O error");
      return original(sql);
    }) as typeof db.query);
    try {
      expect(authenticate(issued.key, SHARED, keys)).toEqual({ ok: false, reason: "error" });
      // 공용 코드는 DB 를 보지 않으므로 그대로 통한다. 열쇠 모양이 아닌 틀린 값은 그대로 '틀림'.
      expect(authenticate(SHARED, SHARED, keys).ok).toBe(true);
      expect(authenticate("wrong", SHARED, keys)).toEqual({ ok: false, reason: "wrong" });
      expect(keys.isActive(issued.id)).toBe(true);
    } finally { broken.mockRestore(); }
    expect(authenticate(issued.key, SHARED, keys)).toEqual({ ok: true, principal: { kind: "device", id: issued.id } });
  });

  test("QR 은 만든 자격을 기억하고, 기기를 끊을 때 그 기기가 만든 QR 만 무른다", () => {
    const pairing = new Pairing();
    const fromDevice = pairing.start(principalKey({ kind: "device", id: "devAAAAAAAAAAAAAAAA" })).code;
    const fromOther = pairing.start(principalKey({ kind: "device", id: "devBBBBBBBBBBBBBBBB" })).code;
    const fromShared = pairing.start(principalKey(SHARED_PRINCIPAL)).code;
    pairing.invalidateOwner(principalKey({ kind: "device", id: "devAAAAAAAAAAAAAAAA" }));
    expect(pairing.status(fromDevice).status).toBe("expired");
    expect(pairing.claim(fromDevice, "x")).toBe("invalid");
    expect(pairing.status(fromOther).status).toBe("pending");
    expect(pairing.status(fromShared).status).toBe("pending");
    // 교환 뒤 이어 가지 못한 코드는 버린다(Mac 화면은 '시간이 지남'으로 보고 새 QR 을 만든다).
    expect(pairing.claim(fromShared, "x")).toBe("ok");
    pairing.discard(fromShared.toLowerCase());
    expect(pairing.status(fromShared).status).toBe("expired");
  });
});

async function serverFixture(hosts = ["127.0.0.1"]) {
  const isolated = createIsolatedRuntime();
  const env = isolated.childEnv();
  updateConfigFile({ accessCode: SHARED, hosts }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const orch = {} as OrchestratorApi;
  let server = await startServer({ config, store, bus, orch, detectHosts: () => [] });
  while (server.port === 7878) { await server.stop(); server = await startServer({ config, store, bus, orch, detectHosts: () => [] }); }
  const base = `http://127.0.0.1:${server.port}`;
  cleanups.push(async () => { await server.stop(); store.db.close(); await isolated.stop(); });
  const request = (path: string, code: string | null = SHARED, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { ...(code === null ? {} : { Authorization: `Bearer ${code}` }), ...(init.headers as Record<string, string> | undefined) } });
  const pair = async (device = "대표의 iPhone", headers: Record<string, string> = {}) => {
    const { code } = await (await request("/api/pair/start", SHARED, { method: "POST" })).json() as { code: string };
    const response = await fetch(`${base}/pair/claim`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ code, device }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { accessCode: string; confirmationToken: string };
    return { ...body, code };
  };
  return { config, store, bus, server, base, request, pair, isolated };
}

function socket(base: string, code: string) {
  const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const ws = new Socket(`${base.replace("http:", "ws:")}/ws?v=2`, { headers: { Authorization: `Bearer ${code}` } });
  const messages: { type: string }[] = [];
  const hello = new Promise<void>((resolve, reject) => {
    ws.onmessage = event => { messages.push(JSON.parse(String(event.data))); resolve(); };
    ws.onerror = () => reject(new Error("WS handshake failed"));
  });
  let closeCode: number | undefined;
  const closed = new Promise<number>(resolve => { ws.onclose = event => { closeCode = event.code; resolve(event.code); }; });
  cleanups.push(async () => { ws.close(); await closed; });
  return { hello, closed, messages, get closeCode() { return closeCode; } };
}

describe("짝 맺기·목록·끊기(HTTP)", () => {
  test("QR 교환은 그 기기만의 열쇠를 accessCode 칸에 주고, 공용 접속 코드는 계속 어디서나 통한다", async () => {
    const f = await serverFixture();
    const before = await f.request("/api/capabilities");
    expect(before.status).toBe(200);
    const paired = await f.pair();
    expect(paired.accessCode).not.toBe(SHARED);
    expect(paired.accessCode.startsWith(DEVICE_KEY_PREFIX)).toBe(true);
    // 출시된 앱처럼 받은 값을 그대로 Bearer 에 싣는다: 확인(ack)·REST·첨부·실시간 연결이 모두 통한다.
    const ack = await f.request("/api/pair/ack", paired.accessCode, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: paired.code, confirmationToken: paired.confirmationToken }) });
    expect(await ack.json()).toMatchObject({ status: "connected" });
    expect((await f.request("/api/capabilities", paired.accessCode)).status).toBe(200);
    expect((await f.request("/files/missing/file.txt", paired.accessCode)).status).toBe(404);
    const live = socket(f.base, paired.accessCode);
    await live.hello;
    // 기존 기기(공용 코드)는 그대로다.
    expect((await f.request("/api/capabilities")).status).toBe(200);
    expect((await f.request("/files/missing/file.txt")).status).toBe(404);
    // 열쇠는 원문으로 어디에도 남지 않는다(DB 의 모든 기기·기록 표).
    const secret = paired.accessCode.split(".")[2]!;
    expect(authTableText(f.store.db)).not.toContain(secret);
    expect(authTableText(f.store.db)).not.toContain(SHARED);
  });

  test("목록은 이 기기를 표시하고, 머리글로 플랫폼을 배우며, 공용 코드 접속을 플랫폼별로 한 줄에 보인다", async () => {
    const f = await serverFixture();
    const paired = await f.pair("민수의 iPhone");
    const app = { [APP_HEADERS.version]: "0.2.4", [APP_HEADERS.platform]: "ios", [APP_HEADERS.apiLevel]: "1" };
    expect((await f.request("/api/capabilities", paired.accessCode, { headers: app })).status).toBe(200);
    expect((await f.request("/api/capabilities", SHARED, { headers: { ...app, [APP_HEADERS.platform]: "macos" } })).status).toBe(200);
    const fromShared = await (await f.request("/api/devices")).json() as DeviceAccessList;
    expect(fromShared.shared.current).toBe(true);
    expect(fromShared.devices).toHaveLength(1);
    expect(fromShared.devices[0]).toMatchObject({ name: "민수의 iPhone", platform: "ios", current: false });
    expect(fromShared.devices[0]!.lastSeenAt).not.toBeNull();
    expect(fromShared.shared.platforms.map(entry => entry.platform).sort()).toEqual(["local", "macos"]);
    expect(fromShared.events.map(event => event.kind)).toContain("paired");
    expect(fromShared.events.find(event => event.kind === "paired")).toMatchObject({ deviceName: "민수의 iPhone", address: "127.0.0.1" });
    const fromDevice = await (await f.request("/api/devices", paired.accessCode)).json() as DeviceAccessList;
    expect(fromDevice.shared.current).toBe(false);
    expect(fromDevice.devices[0]!.current).toBe(true);
    // 경로·방법·쿼리 검사.
    expect((await f.request("/api/devices", null)).status).toBe(401);
    expect((await f.request("/api/devices", SHARED, { method: "POST" })).status).toBe(405);
    expect((await f.request("/api/devices?x=1")).status).toBe(400);
    expect((await f.request(`/api/devices/${fromShared.devices[0]!.id}`)).status).toBe(405);
    expect((await f.request("/api/devices/a/b", SHARED, { method: "DELETE" })).status).toBe(404);
  });

  test("한 대만 끊으면 그 기기의 실시간 연결이 바로 닫히고 다음 요청은 401 device_revoked, 다른 기기와 공용 코드는 그대로다", async () => {
    const f = await serverFixture();
    const lost = await f.pair("잃어버린 iPhone");
    const kept = await f.pair("남는 iPad");
    const lostSocket = socket(f.base, lost.accessCode);
    const keptSocket = socket(f.base, kept.accessCode);
    const sharedSocket = socket(f.base, SHARED);
    await Promise.all([lostSocket.hello, keptSocket.hello, sharedSocket.hello]);
    const { devices } = await (await f.request("/api/devices")).json() as DeviceAccessList;
    const target = devices.find(device => device.name === "잃어버린 iPhone")!;
    const response = await f.request(`/api/devices/${target.id}`, SHARED, { method: "DELETE" });
    expect(response.status).toBe(200);
    const result = await response.json() as DeviceRevokeResult;
    expect(result).toMatchObject({ ok: true, device: { id: target.id, name: "잃어버린 iPhone", current: false } });
    expect(await lostSocket.closed).toBe(4001);
    const refused = await f.request("/api/capabilities", lost.accessCode);
    expect(refused.status).toBe(401);
    const body = await refused.json() as { error: string; code: string };
    expect(body.code).toBe("device_revoked");
    // 출시된 앱은 문장 앞머리('인증이 필요')로 '새 QR 로 다시 연결' 안내를 고른다.
    expect(body.error.startsWith("인증이 필요")).toBe(true);
    expect((await f.request("/ws?v=2", lost.accessCode)).status).toBe(401);
    expect((await f.request("/files/missing/file.txt", lost.accessCode)).status).toBe(401);
    expect((await f.request("/api/capabilities", kept.accessCode)).status).toBe(200);
    expect((await f.request("/api/capabilities")).status).toBe(200);
    f.bus.emit({ type: "projects", projects: [] });
    await Bun.sleep(50);
    expect(keptSocket.closeCode).toBeUndefined();
    expect(sharedSocket.closeCode).toBeUndefined();
    expect(keptSocket.messages.some(message => message.type === "projects")).toBe(true);
    // 두 번 끊기와 없는 기기는 404 device_not_found.
    const again = await f.request(`/api/devices/${target.id}`, SHARED, { method: "DELETE" });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: "device_not_found" });
    const list = await (await f.request("/api/devices")).json() as DeviceAccessList;
    expect(list.devices.map(device => device.name)).toEqual(["남는 iPad"]);
    expect(list.events.find(event => event.kind === "device_revoked")).toMatchObject({ deviceName: "잃어버린 iPhone", reason: "owner" });
    // 끊은 기기가 다시 들어오려 한 것도 '실패한 시도'다. 그 기기 이름을 함께 남긴다(열쇠 값은 없다).
    expect(list.failures.count).toBeGreaterThanOrEqual(3);
    expect(list.events.find(event => event.kind === "auth_failed" && event.reason === "revoked")).toMatchObject({ deviceName: "잃어버린 iPhone", address: "127.0.0.1" });
  });

  test("자기 열쇠를 끊을 수도 있다: 응답은 current=true 이고 그 뒤 요청은 401", async () => {
    const f = await serverFixture();
    const mine = await f.pair("이 iPhone");
    const { devices } = await (await f.request("/api/devices", mine.accessCode)).json() as DeviceAccessList;
    const response = await f.request(`/api/devices/${devices[0]!.id}`, mine.accessCode, { method: "DELETE" });
    expect(await response.json()).toMatchObject({ ok: true, device: { current: true } });
    expect((await f.request("/api/devices", mine.accessCode)).status).toBe(401);
  });

  test("접속 코드를 바꾸면 공용 코드로 연 연결만 닫히고 기기 열쇠로 붙은 기기는 그대로다. 교체는 기록에 남는다", async () => {
    const f = await serverFixture();
    const paired = await f.pair();
    const sharedSocket = socket(f.base, SHARED);
    const deviceSocket = socket(f.base, paired.accessCode);
    await Promise.all([sharedSocket.hello, deviceSocket.hello]);
    const logs = [spyOn(console, "info"), spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
    let accessCode: string;
    try {
      const rotated = await f.request("/api/auth/rotate", SHARED, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(rotated.status).toBe(200);
      ({ accessCode } = await rotated.json() as { accessCode: string });
      expect(await sharedSocket.closed).toBe(4001);
      expect((await f.request("/api/capabilities")).status).toBe(401);
      expect((await f.request("/api/capabilities", accessCode)).status).toBe(200);
      expect((await f.request("/api/capabilities", paired.accessCode)).status).toBe(200);
      f.bus.emit({ type: "projects", projects: [] });
      // 고정 대기 대신 그 사건이 기기 연결에 닿을 때까지(느린 러너에서는 50ms 를 넘었다).
      for (const end = Date.now() + 5_000; !deviceSocket.messages.some(message => message.type === "projects") && Date.now() < end;) await Bun.sleep(5);
      expect(deviceSocket.closeCode).toBeUndefined();
      expect(deviceSocket.messages.some(message => message.type === "projects")).toBe(true);
      const output = JSON.stringify(logs.flatMap(log => log.mock.calls));
      for (const secret of [SHARED, accessCode, paired.accessCode]) expect(output).not.toContain(secret);
    } finally { for (const log of logs) log.mockRestore(); }
    const list = await (await f.request("/api/devices", accessCode)).json() as DeviceAccessList;
    expect(list.shared.rotatedAt).not.toBeNull();
    expect(list.events.find(event => event.kind === "code_rotated")).toMatchObject({ address: "127.0.0.1", deviceName: null });
    // 바뀐 뒤 옛 코드로 들어오려 한 것(위의 401)은 실패한 시도로 남는다.
    expect(list.failures.count).toBe(1);
    expect(authTableText(f.store.db)).not.toContain(accessCode);
    // 기기 열쇠로 들어와도 바꾸기는 이 Mac(loopback)에서만 된다.
    const fromDevice = await f.request("/api/auth/rotate", paired.accessCode, { method: "POST" });
    expect(fromDevice.status).toBe(200);
  });

  test("틀린 코드·맞지 않는 QR 은 주소·시각만 세고, 자격 없이 두드린 요청은 세지 않는다. 기록에 코드 값이 없다", async () => {
    const f = await serverFixture();
    for (let i = 0; i < 3; i++) expect((await f.request("/api/capabilities", `guess-${i}`)).status).toBe(401);
    const wrong = await f.request("/api/capabilities", "guess-x");
    expect(await wrong.json()).toEqual({ error: "인증이 필요합니다", code: "unauthorized" });
    expect((await f.request("/api/capabilities", null)).status).toBe(401);
    expect((await f.request("/ws?v=2", "guess-ws")).status).toBe(401);
    const badQr = await fetch(`${f.base}/pair/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "WRONGCOD", device: "x" }) });
    expect(badQr.status).toBe(401);
    expect(await badQr.json()).toMatchObject({ code: "pair_expired" });
    const list = await (await f.request("/api/devices")).json() as DeviceAccessList;
    expect(list.failures.count).toBe(6);
    expect(list.failures.lastAt).not.toBeNull();
    expect(list.events.filter(event => event.kind === "auth_failed").reduce((sum, event) => sum + event.count, 0)).toBe(5);
    expect(list.events.find(event => event.kind === "pair_failed")).toMatchObject({ count: 1, address: "127.0.0.1", deviceName: null });
    const text = authTableText(f.store.db);
    for (const secret of ["guess-0", "guess-x", "guess-ws", "WRONGCOD", SHARED]) expect(text).not.toContain(secret);
  });

  test("합류(/agent/join)도 같은 판정을 쓴다: 틀린 코드는 401 unauthorized, 끊은 열쇠는 device_revoked", async () => {
    const f = await serverFixture();
    const paired = await f.pair();
    const join = (code: string) => fetch(`${f.base}/agent/join`, { method: "POST", headers: { Authorization: `Bearer ${code}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "합류", project: "없는 프로젝트" }) });
    expect(await (await join("wrong")).json()).toEqual({ error: "인증이 필요합니다", code: "unauthorized" });
    // 자격은 통과하고 프로젝트를 못 찾는다(404). 공용 코드와 기기 열쇠가 같다.
    expect((await join(SHARED)).status).toBe(404);
    expect((await join(paired.accessCode)).status).toBe(404);
    const { devices } = await (await f.request("/api/devices")).json() as DeviceAccessList;
    await f.request(`/api/devices/${devices[0]!.id}`, SHARED, { method: "DELETE" });
    expect(await (await join(paired.accessCode)).json()).toMatchObject({ code: "device_revoked" });
  });

  test("열쇠를 저장하지 못하면 공용 접속 코드를 대신 주지 않고 503 이다. 그 QR 은 버리고, 공용 코드 기기는 그대로다", async () => {
    // 예전에는 공용 코드를 건넸다. 그러면 목록에 없고 한 대만 끊을 수도 없는 기기가 아무도 모르게 생긴다(리뷰 auth-3).
    const f = await serverFixture();
    for (const table of ["auth_events", "auth_devices", "auth_shared_seen"]) f.store.db.exec(`DROP TABLE ${table}`);
    const { code } = await (await f.request("/api/pair/start", SHARED, { method: "POST" })).json() as { code: string };
    const response = await fetch(`${f.base}/pair/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, device: "iPhone" }) });
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: "device_key_save_failed" });
    expect(body.accessCode).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(SHARED);
    expect(await (await f.request(`/api/pair/status?code=${code}`)).json()).toEqual({ code, status: "expired" });
    expect((await f.request("/api/capabilities")).status).toBe(200);
    expect(await (await f.request("/api/devices")).json()).toMatchObject({ devices: [], failures: { count: 0 } });
  });

  test("열쇠를 읽다가 저장소 오류가 나면 401 이 아니라 503 storage_io 이고 실패한 시도로 세지 않는다. 공용 코드는 그대로다", async () => {
    const f = await serverFixture();
    const paired = await f.pair();
    // 열쇠 행을 읽는 SQL 이 실패하게 한다(표는 있으나 열 이름이 맞지 않음 → 저장소 오류. 표가 없는 것과 다르다).
    f.store.db.exec("ALTER TABLE auth_devices RENAME COLUMN secret_hash TO secret_hash_broken");
    try {
      const refused = await f.request("/api/capabilities", paired.accessCode);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ code: "storage_io" });
      expect((await f.request("/ws?v=2", paired.accessCode)).status).toBe(503);
      expect((await f.request("/api/capabilities")).status).toBe(200);
    } finally { f.store.db.exec("ALTER TABLE auth_devices RENAME COLUMN secret_hash_broken TO secret_hash"); }
    expect((await f.request("/api/capabilities", paired.accessCode)).status).toBe(200);
    expect((await (await f.request("/api/devices")).json() as DeviceAccessList).failures.count).toBe(0);
  });

  test("인증된 조회(GET)는 공용 코드든 기기 열쇠든 DB 를 쓰지 않는다. 마지막 접속은 메모리에서 보이고 서버가 멈출 때 쓴다", async () => {
    const f = await serverFixture();
    const paired = await f.pair("민수의 iPhone");
    const changes = () => f.store.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
    const before = changes();
    const app = { [APP_HEADERS.version]: "0.2.4", [APP_HEADERS.platform]: "ios", [APP_HEADERS.apiLevel]: "1" };
    for (const code of [SHARED, paired.accessCode]) {
      expect((await f.request("/api/capabilities", code, { headers: app })).status).toBe(200);
      expect((await f.request("/api/devices", code)).status).toBe(200);
      expect((await f.request("/files/missing/file.txt", code)).status).toBe(404);
    }
    const live = socket(f.base, paired.accessCode);
    await live.hello;
    expect(changes()).toBe(before);
    const list = await (await f.request("/api/devices")).json() as DeviceAccessList;
    expect(list.devices[0]).toMatchObject({ name: "민수의 iPhone", platform: "ios" });
    expect(list.devices[0]!.lastSeenAt).not.toBeNull();
    expect(list.shared.platforms.map(entry => entry.platform)).toContain("ios");
    expect(changes()).toBe(before);
    await f.server.stop();
    expect(f.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM auth_devices WHERE last_seen_at IS NOT NULL AND platform = 'ios'").get()!.n).toBe(1);
    expect(f.store.db.query("SELECT platform FROM auth_shared_seen ORDER BY platform").all()).toEqual([{ platform: "ios" }, { platform: "local" }]);
  });

  test("QR 은 공용 접속 코드로만 만든다: 기기 열쇠로는 403 이라, 끊긴 기기가 미리 열쇠를 늘려 둘 수 없다", async () => {
    const f = await serverFixture();
    const lost = await f.pair("잃어버린 iPhone");
    const minted = await f.request("/api/pair/start", lost.accessCode, { method: "POST" });
    expect(minted.status).toBe(403);
    expect(await minted.json()).toMatchObject({ code: "pair_start_shared_only" });
    const { devices } = await (await f.request("/api/devices")).json() as DeviceAccessList;
    expect(devices).toHaveLength(1);
    expect((await f.request(`/api/devices/${devices[0]!.id}`, SHARED, { method: "DELETE" })).status).toBe(200);
    expect((await f.request("/api/capabilities", lost.accessCode)).status).toBe(401);
    // 공용 코드(이 Mac 의 앱)는 계속 QR 을 만든다.
    expect((await f.request("/api/pair/start", SHARED, { method: "POST" })).status).toBe(200);
  });

  test("코드가 새었을 때: rotate { allDevices } 는 공용 코드를 바꾸고 기기 열쇠도 모두 끊는다(그 소켓·열린 QR 까지). 잘못된 본문은 아무것도 바꾸지 않는다", async () => {
    const f = await serverFixture();
    // 공용 코드를 가진 쪽이 QR 없이 스스로 받아 둔 열쇠(리뷰 auth-1 의 재현)와 대표의 iPad.
    const leaked = await f.pair("iPhone");
    const ipad = await f.pair("대표의 iPad");
    const leakedSocket = socket(f.base, leaked.accessCode);
    await leakedSocket.hello;
    const { code: openQr } = await (await f.request("/api/pair/start", SHARED, { method: "POST" })).json() as { code: string };
    const json = { "Content-Type": "application/json" };
    expect((await f.request("/api/auth/rotate", SHARED, { method: "POST", headers: json, body: JSON.stringify({ allDevices: false }) })).status).toBe(400);
    expect((await f.request("/api/capabilities", leaked.accessCode)).status).toBe(200);
    expect((await f.request("/api/capabilities")).status).toBe(200);
    const rotated = await f.request("/api/auth/rotate", SHARED, { method: "POST", headers: json, body: JSON.stringify({ allDevices: true }) });
    expect(rotated.status).toBe(200);
    const result = await rotated.json() as AuthRotateResult;
    expect(result.revokedDevices).toBe(2);
    expect(await leakedSocket.closed).toBe(4001);
    for (const key of [leaked.accessCode, ipad.accessCode]) {
      const refused = await f.request("/api/capabilities", key);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ code: "device_revoked" });
    }
    expect((await f.request("/api/capabilities")).status).toBe(401);
    expect((await f.request("/api/capabilities", result.accessCode)).status).toBe(200);
    const late = await fetch(`${f.base}/pair/claim`, { method: "POST", headers: json, body: JSON.stringify({ code: openQr, device: "iPhone" }) });
    expect(late.status).toBe(401);
    const list = await (await f.request("/api/devices", result.accessCode)).json() as DeviceAccessList;
    expect(list.devices).toEqual([]);
    expect(list.events.filter(event => event.kind === "device_revoked").map(event => event.reason)).toEqual(["all", "all"]);
    // 열쇠 없이 바꾸는 예전 방식은 revokedDevices 를 싣지 않는다.
    const plain = await f.request("/api/auth/rotate", result.accessCode, { method: "POST" });
    expect(Object.keys(await plain.json() as object).sort()).toEqual(["accessCode", "version"]);
  });

  test("모두 끊기(DELETE /api/devices)는 이 Mac 에서만, 기기 열쇠만 끊고 공용 코드는 그대로다. 명령줄 두 명령이 이 경로를 쓴다", async () => {
    const f = await serverFixture();
    const a = await f.pair("iPhone"), b = await f.pair("iPad");
    const sharedSocket = socket(f.base, SHARED);
    const keySocket = socket(f.base, b.accessCode);
    await Promise.all([sharedSocket.hello, keySocket.hello]);
    const client = { ...f.config, port: f.server.port };
    expect(await revokeDeviceKeys(client)).toBe(2);
    expect(await keySocket.closed).toBe(4001);
    for (const key of [a.accessCode, b.accessCode]) expect((await f.request("/api/capabilities", key)).status).toBe(401);
    expect((await f.request("/api/capabilities")).status).toBe(200);
    f.bus.emit({ type: "projects", projects: [] });
    await Bun.sleep(50);
    expect(sharedSocket.closeCode).toBeUndefined();
    // 다시 해도 된다(끊을 열쇠가 없으면 0).
    const again = await f.request("/api/devices", SHARED, { method: "DELETE" });
    expect(await again.json() as DeviceRevokeAllResult).toEqual({ ok: true, revoked: 0 });
    // 명령줄 rotate --all-devices: 새 코드와 끊은 수.
    const c = await f.pair("새 iPhone");
    const rotated = await rotateAccess(client, fetch, { allDevices: true });
    expect(rotated.revokedDevices).toBe(1);
    expect(client.accessCode).toBe(rotated.accessCode);
    expect((await f.request("/api/capabilities", c.accessCode)).status).toBe(401);
    expect((await f.request("/api/capabilities", rotated.accessCode)).status).toBe(200);
  });

  test("모두 끊기는 이 Mac 이 아닌 주소에서 오면 403 이고 아무것도 끊지 않는다", async () => {
    let handle: ((req: Request, server: unknown) => Promise<Response>) | undefined;
    const original = Bun.serve;
    const spy = spyOn(Bun, "serve").mockImplementation(((options: Parameters<typeof Bun.serve>[0]) => {
      handle ??= (options as { fetch: typeof handle }).fetch;
      return original(options);
    }) as typeof Bun.serve);
    let f: Awaited<ReturnType<typeof serverFixture>>;
    // 이 Mac 에 없는 주소를 하나 더 두어 그 대역의 상대를 받게 한다(묶기는 실패하고 넘어간다). 그래야 주소 거절이 아니라 '이 Mac 에서만'을 본다.
    try { f = await serverFixture(["127.0.0.1", "192.168.77.1"]); } finally { spy.mockRestore(); }
    const paired = await f.pair();
    const remote = { requestIP: () => ({ address: "192.168.77.5" }) };
    const response = await handle!(new Request(`${f.base}/api/devices`, { method: "DELETE", headers: { Authorization: `Bearer ${SHARED}`, Host: new URL(f.base).host, "X-Forwarded-For": "127.0.0.1" } }), remote);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "LOCAL_ONLY" });
    expect((await f.request("/api/capabilities", paired.accessCode)).status).toBe(200);
  });
});

describe("백업·복원·복제의 열쇠", () => {
  const runtimes: IsolatedRuntime[] = [];
  afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); });

  function seeded() {
    const runtime = createIsolatedRuntime();
    runtimes.push(runtime);
    const home = runtime.paths.iamceoHome;
    fs.mkdirSync(join(home, "uploads"), { mode: 0o700 });
    fs.writeFileSync(join(home, "config.json"), JSON.stringify({ accessCode: SHARED, port: 0, hosts: ["127.0.0.1"] }), { mode: 0o600 });
    const db = openDb(join(home, "iamceo.db"));
    const keys = new DeviceKeys(db);
    const issued = keys.issue({ name: "대표의 iPhone", address: "100.64.0.2", platform: "ios" })!;
    keys.touch({ kind: "device", id: issued.id }, "ios", "100.64.0.2");
    keys.touch(SHARED_PRINCIPAL, "local", "127.0.0.1");
    db.close();
    const snapshot = createBackup({ home, backupDir: join(runtime.dir, "backups"), now: new Date("2026-11-13T00:00:00.000Z") });
    return { runtime, home, issued, snapshot, destination: join(runtime.dir, "restored") };
  }

  test("백업 DB 에는 열쇠의 해시만 들어간다", () => {
    const f = seeded();
    const bytes = fs.readFileSync(join(f.snapshot.directory, "iamceo.db"));
    expect(bytes.includes(Buffer.from(f.issued.key.split(".")[2]!))).toBe(false);
    expect(bytes.includes(Buffer.from(f.issued.id))).toBe(true);
  });

  test("같은 Mac 복원은 기기 열쇠와 공용 코드를 그대로 둔다(그 Mac 의 기기가 다시 연결하지 않아도 된다)", () => {
    const f = seeded();
    restoreBackup({ snapshotDir: f.snapshot.directory, destinationHome: f.destination, mode: "same-host" });
    expect(JSON.parse(fs.readFileSync(join(f.destination, "config.json"), "utf8")).accessCode).toBe(SHARED);
    const db = openDb(join(f.destination, "iamceo.db"));
    try {
      const keys = new DeviceKeys(db);
      expect(authenticate(f.issued.key, SHARED, keys)).toEqual({ ok: true, principal: { kind: "device", id: f.issued.id } });
    } finally { db.close(); }
  });

  test("복제본은 원본 기기의 열쇠를 받지 않고(끊김으로 남김) 공용 접속 코드도 새로 만든다", () => {
    const f = seeded();
    restoreBackup({ snapshotDir: f.snapshot.directory, destinationHome: f.destination, mode: "clone" });
    const cloned = JSON.parse(fs.readFileSync(join(f.destination, "config.json"), "utf8")).accessCode as string;
    expect(cloned).not.toBe(SHARED);
    expect(cloned).toMatch(/^[23456789a-km-z]{16}$/);
    const raw = new Database(join(f.destination, "iamceo.db"), { readonly: true });
    try {
      expect(raw.query("SELECT revoked_reason FROM auth_devices").all()).toEqual([{ revoked_reason: "clone" }]);
      expect(raw.query("SELECT COUNT(*) AS n FROM auth_shared_seen").get()).toEqual({ n: 0 });
      expect(raw.query("SELECT kind, reason, device_name FROM auth_events WHERE kind = 'device_revoked'").all()).toEqual([{ kind: "device_revoked", reason: "clone", device_name: "대표의 iPhone" }]);
    } finally { raw.close(); }
    const db = openDb(join(f.destination, "iamceo.db"));
    try {
      const keys = new DeviceKeys(db);
      expect(authenticate(f.issued.key, cloned, keys)).toEqual({ ok: false, reason: "revoked", deviceId: f.issued.id });
      expect(authenticate(SHARED, cloned, keys)).toEqual({ ok: false, reason: "wrong" });
      expect(authenticate(cloned, cloned, keys).ok).toBe(true);
    } finally { db.close(); }
    // 원본 홈은 그대로다.
    expect(JSON.parse(fs.readFileSync(join(f.home, "config.json"), "utf8")).accessCode).toBe(SHARED);
  });

  test("기기 표가 없는 옛 판의 백업도 복제된다(복원이 표를 만들고 끊을 열쇠는 없다)", () => {
    const runtime = createIsolatedRuntime();
    runtimes.push(runtime);
    const home = runtime.paths.iamceoHome;
    fs.mkdirSync(join(home, "uploads"), { mode: 0o700 });
    fs.writeFileSync(join(home, "config.json"), JSON.stringify({ accessCode: SHARED, port: 0, hosts: ["127.0.0.1"] }), { mode: 0o600 });
    const db = openDb(join(home, "iamceo.db"));
    for (const table of ["auth_events", "auth_devices", "auth_shared_seen"]) db.exec(`DROP TABLE ${table}`);
    db.close();
    const snapshot = createBackup({ home, backupDir: join(runtime.dir, "backups"), now: new Date("2026-11-13T00:00:00.000Z") });
    const destination = join(runtime.dir, "restored");
    restoreBackup({ snapshotDir: snapshot.directory, destinationHome: destination, mode: "clone" });
    expect(JSON.parse(fs.readFileSync(join(destination, "config.json"), "utf8")).accessCode).not.toBe(SHARED);
    const restored = new Database(join(destination, "iamceo.db"), { readonly: true });
    try { expect(restored.query("SELECT COUNT(*) AS n FROM auth_devices").get()).toEqual({ n: 0 }); }
    finally { restored.close(); }
    const bare = new Database(":memory:");
    try { expect(revokeAllDeviceKeys(bare, "2026-11-13T00:00:00.000Z", "clone")).toBe(0); }
    finally { bare.close(); }
  });
});
