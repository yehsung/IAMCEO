// 0.2.5 X: 기기 끊기 권한.
// - 다른 기기를 끊는 것은 서버가 도는 Mac 에서만(실제 loopback 연결, 대리 전달 머리글 없음 — 코드 교체·모두 끊기와 같은 판정).
// - 각 기기는 자기 열쇠만 끊을 수 있다(어디서 왔든).
// - 목록(GET /api/devices)은 canRevokeOthers 로 그 자리인지 알려 준다. 출시된 앱(0.2.4 이하)이 남을 끊으려 하면 403 device_revoke_local_only.
// - 명령줄 iamceo auth devices · iamceo auth revoke-device <ID> 가 이 Mac 에서 한 대만 끊는다.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { listDeviceKeys, formatDeviceList, revokeDeviceKey } from "../bin/iamceo.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Store } from "../server/store.ts";
import { ERROR_CODES } from "../shared/error-codes.ts";
import type { DeviceAccessList, DeviceRevokeResult } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const SHARED = "revoke-permission-shared-canary";
/** 이 Mac 에 없는 대역. 서버는 그 주소에도 묶으려다 실패하고 넘어가지만, 그 대역의 상대는 받는다(주소 거절이 아니라 '서버가 도는 Mac에서만'을 본다). */
const REMOTE_HOSTS = ["127.0.0.1", "192.168.77.1"];
const REMOTE = { requestIP: () => ({ address: "192.168.77.5", family: "IPv4", port: 50000 }) };
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); });

type Handle = (req: Request, server: unknown) => Promise<Response>;

/** 서버를 띄우고, 다른 기기에서 온 요청을 흉내 낼 수 있게 서버의 fetch 처리기를 함께 잡는다. */
async function fixture() {
  let handle: Handle | undefined;
  const original = Bun.serve;
  const spy = spyOn(Bun, "serve").mockImplementation(((options: Parameters<typeof Bun.serve>[0]) => {
    handle ??= (options as { fetch: Handle }).fetch;
    return original(options);
  }) as typeof Bun.serve);
  const isolated = createIsolatedRuntime();
  const env = isolated.childEnv();
  updateConfigFile({ accessCode: SHARED, hosts: REMOTE_HOSTS }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const orch = {} as OrchestratorApi;
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ config, store, bus, orch, detectHosts: () => [] });
    while (server.port === 7878) { await server.stop(); server = await startServer({ config, store, bus, orch, detectHosts: () => [] }); }
  } finally { spy.mockRestore(); }
  const base = `http://127.0.0.1:${server.port}`;
  cleanups.push(async () => { await server.stop(); store.db.close(); await isolated.stop(); });
  const headers = (code: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${code}`, ...extra });
  /** 이 Mac(loopback)에서 온 요청. */
  const local = (path: string, code = SHARED, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: headers(code, init.headers as Record<string, string> | undefined) });
  /** 다른 기기(192.168.77.5)에서 온 요청. */
  const remote = (path: string, code: string, method = "GET", extra: Record<string, string> = {}) =>
    handle!(new Request(base + path, { method, headers: headers(code, { Host: new URL(base).host, ...extra }) }), REMOTE);
  const pair = async (device: string) => {
    const { code } = await (await local("/api/pair/start", SHARED, { method: "POST" })).json() as { code: string };
    const response = await fetch(`${base}/pair/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, device }) });
    expect(response.status).toBe(200);
    const key = (await response.json() as { accessCode: string }).accessCode;
    const { devices } = await (await local("/api/devices", key)).json() as DeviceAccessList;
    return { key, id: devices.find(entry => entry.current)!.id };
  };
  const activeNames = async () => ((await (await local("/api/devices")).json()) as DeviceAccessList).devices.map(device => device.name).sort();
  return { config, server, base, local, remote, pair, activeNames };
}

describe("기기 끊기 권한(HTTP)", () => {
  test("목록은 서버가 도는 Mac 에서 부를 때만 canRevokeOthers=true 다. 다른 기기와 tailscale serve 를 거친 요청은 false", async () => {
    const f = await fixture();
    const phone = await f.pair("대표의 iPhone");
    expect((await (await f.local("/api/devices")).json() as DeviceAccessList).canRevokeOthers).toBe(true);
    // 기기 열쇠로 불러도 이 Mac 에서 왔으면 true(판정은 자격이 아니라 연결의 자리다).
    expect((await (await f.local("/api/devices", phone.key)).json() as DeviceAccessList).canRevokeOthers).toBe(true);
    const fromPhone = await (await f.remote("/api/devices", phone.key)).json() as DeviceAccessList;
    expect(fromPhone.canRevokeOthers).toBe(false);
    expect(fromPhone.devices.find(device => device.current)?.name).toBe("대표의 iPhone");
    // 공용 접속 코드로 붙은 옛 iPhone 도 서버가 도는 Mac 이 아니다.
    expect((await (await f.remote("/api/devices", SHARED)).json() as DeviceAccessList).canRevokeOthers).toBe(false);
    // tailscale serve(HTTPS 주소)는 다른 기기의 요청을 127.0.0.1 에서 넘겨준다. 대리 전달 머리글이 있으면 이 Mac 이 아니다.
    const served = await f.local("/api/devices", phone.key, { headers: { "X-Forwarded-For": "100.64.0.9", "Tailscale-User-Login": "owner@example.com" } });
    expect((await served.json() as DeviceAccessList).canRevokeOthers).toBe(false);
  });

  test("다른 기기에서 남을 끊으려 하면 403 device_revoke_local_only 와 안내 한 줄이고 아무것도 끊지 않는다(없는 ID 인지도 알려 주지 않는다)", async () => {
    const f = await fixture();
    const phone = await f.pair("대표의 iPhone");
    const ipad = await f.pair("대표의 iPad");
    for (const [code, label] of [[phone.key, "기기 열쇠"], [SHARED, "공용 접속 코드(출시된 앱)"]] as const) {
      const refused = await f.remote(`/api/devices/${ipad.id}`, code, "DELETE");
      expect(refused.status, label).toBe(403);
      const body = await refused.json() as { error: string; code: string };
      expect(body).toEqual({ error: "다른 기기는 서버가 도는 Mac에서 끊을 수 있습니다", code: "device_revoke_local_only" });
      expect(body.error).toBe(ERROR_CODES.device_revoke_local_only.ko);
    }
    // 없는 ID 도 같은 403(남의 ID 를 더듬어 볼 수 없다).
    expect((await f.remote("/api/devices/devZZZZZZZZZZZZZZZZ", phone.key, "DELETE")).status).toBe(403);
    // tailscale serve 를 거친 요청도 이 Mac 이 아니다.
    const served = await f.local(`/api/devices/${ipad.id}`, phone.key, { method: "DELETE", headers: { "X-Forwarded-For": "100.64.0.9" } });
    expect(served.status).toBe(403);
    expect(await served.json()).toMatchObject({ code: "device_revoke_local_only" });
    // 모두 그대로다.
    expect(await f.activeNames()).toEqual(["대표의 iPad", "대표의 iPhone"]);
    expect((await f.local("/api/capabilities", ipad.key)).status).toBe(200);
  });

  test("리뷰 lang-5: 영어 화면의 앱(Accept-Language 가 한국어가 아님)에는 거절 문장을 영어로 보낸다. 출시된 0.2.4 앱은 이 코드의 영어 문장을 몰라 받은 문장을 그대로 보인다", async () => {
    const f = await fixture();
    const phone = await f.pair("대표의 iPhone");
    const ipad = await f.pair("대표의 iPad");
    const refusal = async (language?: string) => {
      const response = await f.remote(`/api/devices/${ipad.id}`, phone.key, "DELETE", language === undefined ? {} : { "Accept-Language": language });
      expect(response.status).toBe(403);
      return await response.json() as { error: string; code: string };
    };
    // URLSession 이 영어 화면의 앱에 붙이는 모양.
    expect(await refusal("en-US,en;q=0.9")).toEqual({ error: ERROR_CODES.device_revoke_local_only.en, code: "device_revoke_local_only" });
    expect((await refusal("en-KR")).error).toBe("Other devices can be disconnected on the Mac that runs the server");
    expect((await refusal("ja-JP,en;q=0.8")).error).toBe(ERROR_CODES.device_revoke_local_only.en);
    // 한국어 화면과 머리글이 없는 요청(명령줄·옛 클라이언트)은 예전 그대로 한국어.
    expect((await refusal("ko-KR,ko;q=0.9")).error).toBe(ERROR_CODES.device_revoke_local_only.ko);
    expect((await refusal("ko")).error).toBe(ERROR_CODES.device_revoke_local_only.ko);
    expect((await refusal()).error).toBe(ERROR_CODES.device_revoke_local_only.ko);
    expect((await refusal("*")).error).toBe(ERROR_CODES.device_revoke_local_only.ko);
    expect(await f.activeNames()).toEqual(["대표의 iPad", "대표의 iPhone"]);
  });

  test("각 기기는 어디서든 자기 열쇠만 끊을 수 있다: 응답은 current=true, 그 뒤 그 열쇠는 401 device_revoked, 다른 기기는 그대로", async () => {
    const f = await fixture();
    const phone = await f.pair("대표의 iPhone");
    const ipad = await f.pair("대표의 iPad");
    const response = await f.remote(`/api/devices/${phone.id}`, phone.key, "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json() as DeviceRevokeResult).toMatchObject({ ok: true, device: { id: phone.id, name: "대표의 iPhone", current: true } });
    const after = await f.local("/api/capabilities", phone.key);
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ code: "device_revoked" });
    expect(await f.activeNames()).toEqual(["대표의 iPad"]);
    expect((await f.local("/api/capabilities", ipad.key)).status).toBe(200);
    // HTTPS 주소(tailscale serve)를 거쳐 와도 자기 열쇠는 끊을 수 있다.
    const served = await f.local(`/api/devices/${ipad.id}`, ipad.key, { method: "DELETE", headers: { "X-Forwarded-For": "100.64.0.9" } });
    expect(served.status).toBe(200);
    expect(await f.activeNames()).toEqual([]);
  });

  test("서버가 도는 Mac 에서는 공용 코드든 기기 열쇠든 다른 기기를 끊는다(Mac 앱의 끊기 단추)", async () => {
    const f = await fixture();
    const phone = await f.pair("잃어버린 iPhone");
    const mac = await f.pair("다른 Mac");
    expect((await f.local(`/api/devices/${phone.id}`, SHARED, { method: "DELETE" })).status).toBe(200);
    expect(await f.activeNames()).toEqual(["다른 Mac"]);
    // 이 Mac 안에서 기기 열쇠로 붙은 앱도 이 Mac 이다.
    const extra = await f.pair("남는 iPad");
    expect((await f.local(`/api/devices/${extra.id}`, mac.key, { method: "DELETE" })).status).toBe(200);
    expect(await f.activeNames()).toEqual(["다른 Mac"]);
  });
});

describe("명령줄 iamceo auth devices · revoke-device", () => {
  test("목록으로 ID 를 보고 한 대만 끊는다. 다시 끊거나 없는 ID 면 그렇다고 알린다", async () => {
    const f = await fixture();
    const phone = await f.pair("대표의 iPhone");
    await f.pair("대표의 iPad");
    const client = { ...f.config, port: f.server.port };
    const devices = await listDeviceKeys(client);
    expect(devices.map(device => device.name).sort()).toEqual(["대표의 iPad", "대표의 iPhone"]);
    const printed = formatDeviceList(devices);
    expect(printed).toContain(phone.id);
    expect(printed).toContain("revoke-device <ID>");
    expect(await revokeDeviceKey(client, phone.id)).toBe("대표의 iPhone");
    expect(await f.activeNames()).toEqual(["대표의 iPad"]);
    expect((await f.local("/api/capabilities", phone.key)).status).toBe(401);
    await expect(revokeDeviceKey(client, phone.id)).rejects.toThrow(/iamceo auth devices/);
    await expect(revokeDeviceKey(client, "../x")).rejects.toThrow(/iamceo auth devices/);
    expect(await f.activeNames()).toEqual(["대표의 iPad"]);
  });

  test("옛 서버(경로 없음)·이 Mac 이 아니라는 답·연결 실패는 끊었다고 말하지 않는다", async () => {
    const f = await fixture();
    const client = { ...f.config, port: f.server.port };
    const reply = (status: number, body: unknown): typeof fetch => (async () => Response.json(body, { status })) as unknown as typeof fetch;
    await expect(revokeDeviceKey(client, "devAAAAAAAAAAAAAAAA", reply(404, { error: "없는 경로입니다", code: "route_not_found" }))).rejects.toThrow(/iamceo auth rotate/);
    await expect(listDeviceKeys(client, reply(404, { error: "없는 경로입니다" }))).rejects.toThrow(/iamceo auth rotate/);
    await expect(revokeDeviceKey(client, "devAAAAAAAAAAAAAAAA", reply(403, { error: "x", code: "device_revoke_local_only" }))).rejects.toThrow(/(서버가 도는 Mac|Mac that runs the server)/);
    await expect(revokeDeviceKey(client, "devAAAAAAAAAAAAAAAA", reply(200, { ok: false }))).rejects.toThrow();
    const offline = (async () => { throw new TypeError("connection refused"); }) as unknown as typeof fetch;
    await expect(revokeDeviceKey(client, "devAAAAAAAAAAAAAAAA", offline)).rejects.toThrow(/(다시 실행해도|safe to repeat)/);
    expect(formatDeviceList([])).toMatch(/(iamceo auth rotate)/);
  });
});
