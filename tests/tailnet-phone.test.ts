// 0.2.7 D4-3: Tailscale 꺼짐 알림이 Mac 화면(osascript)에만 갔다. iPhone 에도 간다(APNs·알림 중계는 Tailscale 없이 간다).
// 더 오래(3분) 꺼져 있을 때 한 번, 꺼짐마다. 다시 켜지면 아직 나가지 않은 알림은 거둔다. 기기의 '실행 문제' 설정을 따른다.
// 실제 Tailscale 은 건드리지 않는다: 주소 감지와 시계를 주입하고, 가짜 Tailscale 주소로 이 컴퓨터의 ::1 을 쓴다.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { buildAPNsPayload } from "../server/push/apns.ts";
import { PushStore } from "../server/push/store.ts";
import { Store } from "../server/store.ts";
import { TAILNET_OFF_GRACE_MS, TAILNET_PHONE_GRACE_MS } from "../server/tailnet.ts";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";

const FAKE_TAILNET = "::1";
const START = Date.parse("2026-11-13T08:51:00.000Z");
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function boot() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-tailnet-phone-")));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  const config: Config = { ...loadConfig(env), hosts: ["127.0.0.1"], hostsAuto: true };
  const store = new Store(openDb(config.dbPath), new Bus());
  const providers = () => [{ environment: "sandbox" as const, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready" as const, lastError: null }];
  const push = new PushStore(store.db, { providers });
  let wakes = 0;
  const orch = new Orchestrator({ config, store, runners: new Map(), notifier: () => {} });
  const clock = { now: START }, world = { detected: [] as string[] };
  const context = { config, store, bus: new Bus(), orch, detectHosts: () => world.detected, tailnetWatch: { now: () => clock.now }, push: { store: push, providers, wake: () => { wakes++; } } };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  /** 같은 DB·같은 총괄로 서버를 내렸다 다시 띄운다(배포·launchd 재시작). Tailscale 감시도 새로 만들어진다. */
  const restartServer = async () => {
    await server.stop();
    server = await startServer(context);
    while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  };
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); store.db.close(); });
  const device = (preferences: Record<string, boolean> = {}) => {
    const value = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: "ab", authorization: "authorized" });
    return push.patchDevice(value.id, { expectedRevision: value.revision, enabled: true, ...(Object.keys(preferences).length ? { preferences } : {}) });
  };
  const tick = (ms = 30_000) => { clock.now += ms; server.syncHosts(); };
  const events = () => push.listEvents().filter(e => e.kind === "tailnet_off");
  return { push, store, device, tick, world, clock, events, restartServer, wakes: () => wakes };
}

describe("Tailscale 꺼짐을 iPhone 에도 알린다 (D4-3)", () => {
  test("3분 넘게 꺼지면 iPhone 알림이 한 번(꺼짐마다) 가고, Mac 알림 시각(60초)에는 아직 가지 않는다", async () => {
    const t = await boot();
    const device = t.device();
    t.world.detected = [FAKE_TAILNET]; t.tick();
    t.world.detected = []; t.tick();
    t.tick(TAILNET_OFF_GRACE_MS);
    expect(t.events()).toHaveLength(0);
    t.tick(TAILNET_PHONE_GRACE_MS - TAILNET_OFF_GRACE_MS);
    const [event] = t.events();
    expect(event).toMatchObject({ kind: "tailnet_off", projectId: null, memberId: null, target: { screen: "home" } });
    expect(t.push.listDeliveries(event!.id).map(d => [d.deviceId, d.state])).toEqual([[device.id, "queued"]]);
    expect(t.wakes()).toBeGreaterThan(0);
    // 같은 꺼짐이 이어지는 동안에는 다시 알리지 않는다.
    for (let i = 0; i < 10; i++) t.tick();
    expect(t.events()).toHaveLength(1);
    // 알림 글: 종류별 고정 문구, 내용은 없다. 누르면 첫 화면.
    const payload = buildAPNsPayload({ environment: "sandbox", deviceToken: "ab", deliveryId: event!.id, eventId: event!.id, serverId: randomUUID(), kind: "tailnet_off", target: event!.target, occurredAt: event!.occurredAt, expiresAt: event!.expiresAt });
    expect(payload.aps.alert.body).toBe("서버 Mac의 Tailscale이 꺼져 있어 iPhone에서 연결할 수 없습니다. Mac에서 Tailscale을 켜 주세요.");
    expect(payload.iamceo.target).toEqual({ screen: "home" });
    // 다시 켜지면 거둔다. 다음 꺼짐은 새로 센다.
    t.world.detected = [FAKE_TAILNET]; t.tick();
    expect(t.push.listDeliveries(event!.id).map(d => d.state)).toEqual(["cancelled"]);
    t.world.detected = []; t.tick();
    t.tick(TAILNET_PHONE_GRACE_MS);
    expect(t.events()).toHaveLength(2);
  });

  test("기기의 '실행 문제' 알림을 끈 iPhone 에는 보내지 않는다", async () => {
    const t = await boot();
    t.device({ error: false });
    t.world.detected = [FAKE_TAILNET]; t.tick();
    t.world.detected = []; t.tick();
    t.tick(TAILNET_PHONE_GRACE_MS);
    const [event] = t.events();
    expect(event).toBeDefined();
    expect(t.push.listDeliveries(event!.id)).toEqual([]);
  });

  test("꺼진 채 서버를 다시 띄워도 같은 꺼짐에는 iPhone 알림을 다시 내지 않는다. 다시 켜지면 거두고 기록을 지우며, 다음 꺼짐은 새로 센다", async () => {
    const t = await boot();
    t.device();
    t.world.detected = [FAKE_TAILNET]; t.tick();
    t.world.detected = []; t.tick();
    t.tick(TAILNET_PHONE_GRACE_MS);
    const [event] = t.events();
    expect(event).toBeDefined();
    expect(t.store.tailnetPhoneAlert()).not.toBeNull();
    // 꺼진 채로 배포·재시작이 두 번 있었다. 새 서버는 앞 서버가 낸 알림을 이어받는다.
    for (let i = 0; i < 2; i++) {
      await t.restartServer();
      t.tick();
      t.tick(TAILNET_PHONE_GRACE_MS);
      t.tick();
    }
    expect(t.events()).toHaveLength(1);
    // 다시 켜지면 앞 서버가 낸 알림이라도 아직 나가지 않았으면 거두고, 기록을 지운다.
    t.world.detected = [FAKE_TAILNET]; t.tick();
    expect(t.push.listDeliveries(event!.id).map(d => d.state)).toEqual(["cancelled"]);
    expect(t.store.tailnetPhoneAlert()).toBeNull();
    t.world.detected = []; t.tick();
    t.tick(TAILNET_PHONE_GRACE_MS);
    expect(t.events()).toHaveLength(2);
  });

  test("3분 안에 다시 켜지면 iPhone 알림은 없다", async () => {
    const t = await boot();
    t.device();
    t.world.detected = [FAKE_TAILNET]; t.tick();
    t.world.detected = []; t.tick();
    t.tick(TAILNET_PHONE_GRACE_MS - 30_000);
    t.world.detected = [FAKE_TAILNET]; t.tick();
    t.tick(TAILNET_PHONE_GRACE_MS);
    expect(t.events()).toHaveLength(0);
  });
});
