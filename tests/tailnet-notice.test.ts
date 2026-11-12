// Tailscale 꺼짐 안내(서버): 전에 Tailscale 주소를 연 설치에서 그 주소가 60초 넘게 잡히지 않으면 tailnet.state 가 off 가 되고
// Mac 알림이 한 번 간다. 주소를 연 적이 없는 설치는 영원히 조용하다. 실제 Tailscale 은 건드리지 않는다:
// ServerContext.detectHosts 와 시계를 주입하고, 가짜 Tailscale 주소로 이 컴퓨터의 ::1 을 쓴다.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bootstrap, SyncSnapshot, TailnetStatus, WsEvent } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import { TAILNET_OFF_BODY, TAILNET_OFF_GRACE_MS, TAILNET_OFF_TITLE } from "../server/tailnet.ts";

const FAKE_TAILNET = "::1";
const START = Date.parse("2026-11-12T00:00:00.000Z");
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function freshConfig(overrides: Partial<Config> = {}): Config {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-tailnet-")));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  // loadConfig 는 이 컴퓨터의 진짜 Tailscale 주소를 hosts 에 넣는다. 시험은 로컬 주소만 연다.
  return { ...loadConfig(env), hosts: ["127.0.0.1"], hostsAuto: true, ...overrides };
}

/** 같은 DB 로 서버를 띄운다. 다시 부르면 '서버를 다시 띄운' 것이다. */
async function boot(config: Config, clock: { now: number }, world: { detected: string[] }) {
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const notices: { title: string; body: string }[] = [];
  const events: WsEvent[] = [];
  const unsubscribe = bus.subscribe(event => { events.push(event); });
  const orch = new Orchestrator({ config, store, runners: new Map(), notifier: (title, body) => { notices.push({ title, body }); } });
  const context = { config, store, bus, orch, detectHosts: () => world.detected, tailnetWatch: { now: () => clock.now } };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    await server.stop();
    await orch.shutdown();
    store.db.close();
  };
  cleanups.push(close);
  const get = async <T>(path: string) => (await (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: "Bearer code" } })).json()) as T;
  /** bootstrap·sync·readiness 가 같은 값을 싣는지 보고 그 값을 돌려준다. 싣지 않으면 undefined. */
  const tailnet = async (): Promise<TailnetStatus | undefined> => {
    const bootstrap = await get<Bootstrap>("/api/bootstrap");
    const sync = await get<SyncSnapshot>("/api/sync");
    const readiness = await get<{ tailnet?: TailnetStatus }>("/api/readiness");
    expect("tailnet" in sync.bootstrap).toBe("tailnet" in bootstrap);
    expect("tailnet" in readiness).toBe("tailnet" in bootstrap);
    expect(sync.bootstrap.tailnet).toEqual(bootstrap.tailnet);
    expect(readiness.tailnet).toEqual(bootstrap.tailnet);
    return bootstrap.tailnet;
  };
  /**
   * 30초마다 도는 주소 동기화 한 번. 그 한 번이 '스냅샷을 다시 읽으라'는 신호(projects)를 몇 번 냈는지 돌려준다.
   * 동기화는 동기 함수라, 다른 까닭(상태 조회의 건강 확인 등)으로 나가는 같은 이벤트와 섞이지 않는다.
   */
  const tick = (ms = 30_000): number => {
    const before = events.length;
    clock.now += ms;
    server.syncHosts();
    return events.slice(before).filter(event => event.type === "projects").length;
  };
  return { store, server, notices, tailnet, tick, close };
}

describe("Tailscale 꺼짐 안내", () => {
  test("(가) Tailscale 주소를 연 적이 없는 설치는 아무리 오래 꺼져 있어도 필드도 알림도 없다", async () => {
    const config = freshConfig();
    const t = await boot(config, { now: START }, { detected: [] });
    expect(await t.tailnet()).toBeUndefined();
    for (let i = 0; i < 20; i++) expect(t.tick()).toBe(0);
    expect(await t.tailnet()).toBeUndefined();
    expect(t.notices).toEqual([]);
    expect(t.store.tailnetSeen()).toBeNull();
  });

  test("(가) 주소를 직접 정한 설치(hostsAuto 아님)는 전에 연 기록이 있어도 조용하다", async () => {
    const config = freshConfig({ hostsAuto: false });
    const clock = { now: START };
    const seed = new Store(openDb(config.dbPath), new Bus());
    seed.rememberTailnetSeen({ address: "100.64.0.7", at: new Date(START).toISOString() });
    seed.db.close();
    const t = await boot(config, clock, { detected: [] });
    for (let i = 0; i < 5; i++) t.tick();
    expect(await t.tailnet()).toBeUndefined();
    expect(t.notices).toEqual([]);
  });

  test("(나)(다) 연 적이 있고 60초 넘게 안 잡히면 off 와 알림 한 번, 그 전에는 조용하다. 열어 둔 소켓이 남아 있어도 꺼진 것이다", async () => {
    const config = freshConfig();
    const clock = { now: START }, world = { detected: [] as string[] };
    const t = await boot(config, clock, world);
    expect(await t.tailnet()).toBeUndefined();
    world.detected = [FAKE_TAILNET];
    // 처음 연 것은 화면에 알릴 변화가 아니다.
    expect(t.tick()).toBe(0);
    expect(t.server.hosts).toContain(FAKE_TAILNET);
    expect(await t.tailnet()).toEqual({ state: "ok", lastAddress: FAKE_TAILNET });
    expect(t.store.tailnetSeen()).toEqual({ address: FAKE_TAILNET, at: new Date(START + 30_000).toISOString() });

    // 꺼짐: 인터페이스가 사라져 detect 가 빈다. 전에 연 소켓은 hosts 에 그대로 남는다.
    world.detected = [];
    expect(t.tick()).toBe(0);
    const missingSince = clock.now;
    expect(await t.tailnet()).toEqual({ state: "ok", lastAddress: FAKE_TAILNET });
    expect(t.tick(TAILNET_OFF_GRACE_MS - 1)).toBe(0);
    expect(await t.tailnet()).toEqual({ state: "ok", lastAddress: FAKE_TAILNET });
    expect(t.notices).toEqual([]);

    // 열려 있는 앱이 스냅샷을 다시 읽게 하는 기존 신호가 한 번 나간다.
    expect(t.tick(1)).toBe(1);
    expect(t.server.hosts).toContain(FAKE_TAILNET);
    // 결재 알림(notifyMac)은 기본이 꺼짐이다. 운영 안내라 그래도 간다.
    expect(t.store.getSettings()).toMatchObject({ notifyMac: false, macScriptNotifications: true });
    expect(t.notices).toEqual([{ title: TAILNET_OFF_TITLE, body: TAILNET_OFF_BODY }]);
    expect(TAILNET_OFF_TITLE).toBe("IAMCEO · Tailscale이 꺼져 있습니다");
    expect(TAILNET_OFF_BODY).toBe("iPhone에서 연결할 수 없습니다. 이 Mac의 Tailscale을 켜 주세요.");
    expect(await t.tailnet()).toEqual({ state: "off", lastAddress: FAKE_TAILNET, since: new Date(missingSince).toISOString(), macNotified: true });

    // 같은 꺼짐이 이어지는 동안에는 다시 알리지 않는다.
    for (let i = 0; i < 10; i++) expect(t.tick()).toBe(0);
    expect(t.notices).toHaveLength(1);
    expect((await t.tailnet())?.since).toBe(new Date(missingSince).toISOString());
  });

  test("(다) 유예 안에 다시 잡히면 시간을 처음부터 다시 센다", async () => {
    const config = freshConfig();
    const clock = { now: START }, world = { detected: [FAKE_TAILNET] };
    const t = await boot(config, clock, world);
    t.tick();
    world.detected = [];
    t.tick(); t.tick();
    world.detected = [FAKE_TAILNET];
    t.tick();
    world.detected = [];
    t.tick(); t.tick();
    expect(await t.tailnet()).toEqual({ state: "ok", lastAddress: FAKE_TAILNET });
    expect(t.notices).toEqual([]);
    t.tick();
    expect((await t.tailnet())?.state).toBe("off");
    expect(t.notices).toHaveLength(1);
  });

  test("(라) 다시 켜지면 바로 ok, 다음 꺼짐에 다시 알린다", async () => {
    const config = freshConfig();
    const clock = { now: START }, world = { detected: [FAKE_TAILNET] };
    const t = await boot(config, clock, world);
    t.tick();
    world.detected = [];
    t.tick(); t.tick(); t.tick();
    expect((await t.tailnet())?.state).toBe("off");
    expect(t.notices).toHaveLength(1);

    world.detected = [FAKE_TAILNET];
    expect(t.tick(1)).toBe(1);
    expect(await t.tailnet()).toEqual({ state: "ok", lastAddress: FAKE_TAILNET });
    expect(t.notices).toHaveLength(1);

    world.detected = [];
    t.tick();
    const secondSince = clock.now;
    t.tick();
    expect((await t.tailnet())?.state).toBe("ok");
    t.tick();
    expect(await t.tailnet()).toEqual({ state: "off", lastAddress: FAKE_TAILNET, since: new Date(secondSince).toISOString(), macNotified: true });
    expect(t.notices).toHaveLength(2);
  });

  test("(마) macScriptNotifications=false 면 서버는 알림을 띄우지 않고, 띄우지 않았다고 알린다(Mac 앱의 몫)", async () => {
    const config = freshConfig();
    const clock = { now: START }, world = { detected: [FAKE_TAILNET] };
    const t = await boot(config, clock, world);
    t.store.patchSettings({ macScriptNotifications: false, notifyMac: true });
    t.tick();
    world.detected = [];
    t.tick();
    const missingSince = clock.now;
    t.tick(); t.tick();
    expect(await t.tailnet()).toEqual({ state: "off", lastAddress: FAKE_TAILNET, since: new Date(missingSince).toISOString() });
    expect(t.notices).toEqual([]);
    // 꺼진 뒤에 설정을 되돌려도 같은 꺼짐에 서버가 뒤늦게 띄우지 않는다.
    t.store.patchSettings({ macScriptNotifications: true });
    t.tick(); t.tick();
    expect(t.notices).toEqual([]);
    expect((await t.tailnet())?.macNotified).toBeUndefined();
  });

  test("(바) 서버를 다시 띄워도 '연 적 있음'이 남아, 꺼진 채로 뜬 서버가 유예 뒤에 알린다", async () => {
    const config = freshConfig();
    const clock = { now: START }, world = { detected: [FAKE_TAILNET] };
    const first = await boot(config, clock, world);
    first.tick();
    expect(await first.tailnet()).toEqual({ state: "ok", lastAddress: FAKE_TAILNET });
    const seen = first.store.tailnetSeen();
    expect(seen).toEqual({ address: FAKE_TAILNET, at: new Date(START + 30_000).toISOString() });
    await first.close();

    // Mac 을 다시 켰는데 Tailscale 이 꺼져 있다: 이번 서버는 그 주소를 한 번도 열지 못한다.
    clock.now += 3_600_000;
    world.detected = [];
    const bootedAt = clock.now;
    const second = await boot(config, clock, world);
    expect(second.server.hosts).toEqual(["127.0.0.1"]);
    expect(second.store.tailnetSeen()).toEqual(seen);
    expect(await second.tailnet()).toEqual({ state: "ok", lastAddress: FAKE_TAILNET });
    second.tick();
    expect((await second.tailnet())?.state).toBe("ok");
    expect(second.notices).toEqual([]);
    second.tick();
    expect(await second.tailnet()).toEqual({ state: "off", lastAddress: FAKE_TAILNET, since: new Date(bootedAt).toISOString(), macNotified: true });
    expect(second.notices).toEqual([{ title: TAILNET_OFF_TITLE, body: TAILNET_OFF_BODY }]);

    // 켜지면 서버가 스스로 주소를 다시 열고 정상으로 돌아간다.
    world.detected = [FAKE_TAILNET];
    second.tick();
    expect(second.server.hosts).toContain(FAKE_TAILNET);
    expect(await second.tailnet()).toEqual({ state: "ok", lastAddress: FAKE_TAILNET });
  });

  test("설정 응답에는 내부 기록이 나가지 않는다", async () => {
    const config = freshConfig();
    const t = await boot(config, { now: START }, { detected: [FAKE_TAILNET] });
    t.tick();
    expect(t.store.tailnetSeen()).not.toBeNull();
    expect(Object.keys(t.store.getSettings())).not.toContain("tailnetSeen");
  });
});
