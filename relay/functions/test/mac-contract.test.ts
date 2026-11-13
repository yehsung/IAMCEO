// Mac 서버의 중계 클라이언트(server/push/relay.ts, Z 묶음)와 이 중계를 실제 HTTP 로 잇는 약속 시험.
// Mac → (HTTP, 127.0.0.1) → 중계 → (HTTP/2·TLS) → 가짜 APNs. 직접 보내기와 같은 페이로드가 가는지, 응답을 Mac 이 바르게 읽는지 본다.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { buildAPNsPayload, serializeAPNsPayload } from "../../../server/push/apns.ts";
import type { APNsNotification } from "../../../server/push/apns.ts";
import { PUSH_RELAY_FILE, RelayClient } from "../../../server/push/relay.ts";
import { nodeHandler } from "../src/http-adapter.ts";
import type { NodeRequest } from "../src/http-adapter.ts";
import type { Relay } from "../src/relay.ts";
import { MASTER, SERVER_ID, TOKEN, fakeApns, relayFixture, reply, tempDir } from "./helpers.ts";
import type { ApnsHandler, RelayFixtureOptions } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/**
 * 중계 핵심을 일반 http 서버에 붙인다(Firebase 함수처럼 본문을 rawBody 에 미리 읽어 둔다).
 * forwardedFor 를 주면 Google 앞단처럼 X-Forwarded-For 끝에 그 Mac 의 IP 를 붙인다.
 */
async function serve(current: () => Relay, forwardedFor?: string): Promise<string> {
  const server = createServer((req: IncomingMessage, res) => {
    if (forwardedFor) req.headers["x-forwarded-for"] = req.headers["x-forwarded-for"] ? `${req.headers["x-forwarded-for"]}, ${forwardedFor}` : forwardedFor;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => { (req as NodeRequest).rawBody = Buffer.concat(chunks); void nodeHandler(current())(req as NodeRequest, res); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function notification(overrides: Partial<APNsNotification> = {}): APNsNotification {
  const now = Date.now();
  return { environment: "production", deviceToken: TOKEN, deliveryId: randomUUID(), eventId: randomUUID(), serverId: SERVER_ID,
    kind: "report_complete", target: { screen: "chat", projectId: "p_1", memberId: "m_1", messageId: "msg_1", groupId: randomUUID() },
    occurredAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(), reportSummary: true, ...overrides };
}

async function setup(handler: ApnsHandler, options: RelayFixtureOptions = {}) {
  const apns = await fakeApns(cleanups, handler);
  let fixture = relayFixture(cleanups, { ...options, apns: { connector: apns.connector, ...options.apns } });
  const url = await serve(() => fixture.relay);
  const home = tempDir(cleanups);
  const mac = new RelayClient({ home, url, log: () => {} });
  cleanups.push(() => mac.close());
  return { apns, url, home, mac, fixture: () => fixture,
    restart: (next: RelayFixtureOptions) => { fixture = relayFixture(cleanups, { ...next, apns: { connector: apns.connector, ...next.apns } }); } };
}

describe("Mac 중계 클라이언트 ↔ 중계", () => {
  test("처음 보낼 때 등록(0600 파일)하고, 직접 보내기와 바이트까지 같은 페이로드가 APNs 로 간다", async () => {
    const { apns, mac, home } = await setup((stream) => reply(stream, 200));
    const item = notification();
    expect(await mac.send(item)).toEqual({ state: "accepted", reason: "accepted", status: 200 });
    expect(statSync(join(home, PUSH_RELAY_FILE)).mode & 0o777).toBe(0o600);
    expect(apns.received).toHaveLength(1);
    expect(apns.received[0]!.body).toBe(serializeAPNsPayload(buildAPNsPayload(item)));
    expect(apns.received[0]!.headers["apns-collapse-id"]).toBe(item.eventId);
    expect(apns.received[0]!.headers["apns-id"]).toBe(item.deliveryId);
    expect(mac.status()).toMatchObject({ environment: "production", state: "ready", lastError: null });
    // 두 번째는 저장한 자격을 그대로 쓴다(등록 없음).
    expect((await mac.send(notification({ kind: "test", target: { screen: "home" }, reportSummary: false,
      expiresAt: new Date(Date.now() + 4 * 60_000).toISOString() }))).state).toBe("accepted");
  });
  test("APNs 가 토큰을 버리면 Mac 은 invalid(그 기기 등록을 지운다)", async () => {
    const { mac } = await setup((stream) => reply(stream, 410, { reason: "Unregistered", timestamp: 1_790_000_000_000 }));
    expect(await mac.send(notification())).toEqual({ state: "invalid", reason: "Unregistered", status: 410, invalidatedAt: 1_790_000_000_000 });
  });
  test("중계의 master 가 바뀌면 Mac 은 401 을 받고 한 번 다시 등록해 보낸다", async () => {
    const { mac, restart, apns } = await setup((stream) => reply(stream, 200));
    expect((await mac.send(notification())).state).toBe("accepted");
    restart({ master: `${MASTER}-rotated-0123456789` });
    expect((await mac.send(notification())).state).toBe("accepted");
    expect(apns.received).toHaveLength(2);
  });
  test("master 를 바꿔 재등록이 몰려 전체 등록 한도에 막혀도 Mac 은 잠기지 않는다: 그 시간에는 그 알림만 다시 시도, 다음 시간에 등록해 보낸다", async () => {
    let clock = Date.UTC(2026, 10, 14, 9, 10);
    const at = (overrides: Partial<APNsNotification> = {}) => notification({ occurredAt: new Date(clock).toISOString(),
      expiresAt: new Date(clock + 30 * 60_000).toISOString(), ...overrides });
    const apns = await fakeApns(cleanups, (stream) => reply(stream, 200));
    let fixture = relayFixture(cleanups, { now: () => clock, apns: { connector: apns.connector } });
    const macs = await Promise.all(["203.0.113.41", "203.0.113.42"].map(async (ip) => {
      const mac = new RelayClient({ home: tempDir(cleanups), url: await serve(() => fixture.relay, ip), now: () => clock, log: () => {} });
      cleanups.push(() => mac.close());
      return mac;
    }));
    const [a, b] = macs as [RelayClient, RelayClient];
    for (const mac of macs) expect((await mac.send(at())).state).toBe("accepted");
    // 다시 배포: 새 master, 새 인스턴스. 시간당 등록 1건으로 줄여 몰림을 흉내 낸다. IP 몫은 하루 2건.
    clock = Date.UTC(2026, 10, 14, 10, 5);
    fixture = relayFixture(cleanups, { now: () => clock, master: `${MASTER}-rotated-0123456789`, apns: { connector: apns.connector },
      limits: { createPerHour: 1, createPerIpPerDay: 2 } });
    expect((await a.send(at())).state).toBe("accepted");
    for (let i = 0; i < 6; i++) {
      const busy = await b.send(at());
      expect(busy).toMatchObject({ state: "retry", reason: "server_error", status: 503 });
      expect(busy.retryAt).toBe(Date.UTC(2026, 10, 14, 11));
      expect(b.status()).toMatchObject({ state: "ready", lastError: null });
    }
    clock = Date.UTC(2026, 10, 14, 11, 0, 5);
    expect((await b.send(at())).state).toBe("accepted");
    expect(apns.received).toHaveLength(4);
  });
  test("APNs 가 키를 거절하면 Mac 은 production 보내기를 약 10분 쉬고(영영 멈추지 않음), 키 오류 상태로 알리지 않는다", async () => {
    const { mac } = await setup((stream) => reply(stream, 403, { reason: "InvalidProviderToken" }));
    const before = Date.now();
    const result = await mac.send(notification());
    expect(result).toMatchObject({ state: "unavailable", reason: "server_error", status: 503 });
    expect(result.retryAt! - before).toBeGreaterThan(590_000);
    expect(result.retryAt! - before).toBeLessThan(610_000);
    expect(mac.status()).toMatchObject({ state: "temporarily_unavailable" });
  });
  test("중계 시계로 이미 지난 알림은 expired(토큰을 지우지 않는다), APNs 로 보내지 않는다", async () => {
    // 중계 시계가 Mac 보다 10분 앞선 경우: Mac 은 5분 남았다고 보지만 중계에서는 이미 지났다.
    const { mac, apns } = await setup((stream) => reply(stream, 200), { now: () => Date.now() + 10 * 60_000 });
    const result = await mac.send(notification({ expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }));
    expect(result).toMatchObject({ state: "expired", reason: "expired", status: 400 });
    expect(apns.received).toHaveLength(0);
  });
  test("보냈는지 모르면(APNs 무응답) Mac 은 unknown 으로 적고 다시 보내지 않는다", async () => {
    const { mac } = await setup(() => { /* 답하지 않는다 */ }, { apns: { timeoutMs: 800 } });
    expect(await mac.send(notification())).toEqual({ state: "unknown", reason: "timeout", status: 504 });
  });
  test("그 iPhone 의 한도는 그 알림만 늦추고, 이 Mac 의 한도는 production 보내기를 쉰다", async () => {
    const token = await setup((stream) => reply(stream, 200), { limits: { tokenPerDay: 1 } });
    expect((await token.mac.send(notification())).state).toBe("accepted");
    expect(await token.mac.send(notification())).toMatchObject({ state: "retry", reason: "TooManyRequests", status: 429 });
    expect(token.mac.status().state).toBe("ready");
    const installation = await setup((stream) => reply(stream, 200), { limits: { installationPerMinute: 1 } });
    expect((await installation.mac.send(notification())).state).toBe("accepted");
    expect(await installation.mac.send(notification({ deviceToken: "b2".repeat(32) }))).toMatchObject({ state: "unavailable", reason: "TooManyRequests", status: 429 });
    expect(installation.mac.status()).toMatchObject({ state: "temporarily_unavailable" });
  });
  test("중계를 끄면(off) Mac 은 production 보내기를 한 시간 쉰다", async () => {
    const { mac } = await setup((stream) => reply(stream, 200), { mode: "off" });
    const before = Date.now();
    const result = await mac.send(notification());
    expect(result).toMatchObject({ state: "unavailable", reason: "server_error", status: 503 });
    expect(result.retryAt! - before).toBeGreaterThan(3_590_000);
  });
});
