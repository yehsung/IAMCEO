// APNs 네트워크 오류 뒤 회복: 실제 PushStore·PushWorker·APNsClient 를 쓰고 전송 계층만 바꾼다.
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientHttp2Session } from "node:http2";
import { openDb } from "../server/db.ts";
import { APNsClient, HTTP2APNsTransport } from "../server/push/apns.ts";
import type { APNsTransport, APNsTransportRequest, APNsTransportResult } from "../server/push/apns.ts";
import type { APNsConfig } from "../server/push/config.ts";
import { createPushHandler } from "../server/push/routes.ts";
import { PushStore } from "../server/push/store.ts";
import { PushWorker } from "../server/push/worker.ts";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const start = Date.parse("2026-11-10T03:00:00.000Z");
const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const accepted: APNsTransportResult = { type: "response", status: 200, headers: {}, body: "" };

function config(): APNsConfig {
  const value: APNsConfig = { credentials: {}, providers: [] };
  for (const environment of ["sandbox", "production"] as const) {
    value.credentials[environment] = { environment, key, bundleId: DEFAULT_PUSH_BUNDLE_ID, keyId: "TESTKEY123", teamId: "TESTTEAM12", cacheKey: environment };
    value.providers.push({ environment, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready", lastError: null });
  }
  return value;
}
function fixture(transport: APNsTransport, requestTimeoutMs?: number, clientTimeoutMs?: number) {
  const db = openDb(":memory:");
  cleanups.push(() => db.close());
  let now = start;
  const client = new APNsClient(config(), { transport, now: () => now, timeoutMs: clientTimeoutMs });
  const push = new PushStore(db, { now: () => now, providers: () => client.status() });
  const worker = new PushWorker(push, client, { now: () => now, random: () => 0.5, requestTimeoutMs });
  cleanups.push(() => worker.shutdown());
  const registered = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID,
    environment: "sandbox", deviceToken: "ab", authorization: "authorized" });
  const device = push.patchDevice(registered.id, { expectedRevision: registered.revision, enabled: true });
  const event = () => push.recordEvent({ sourceKey: `test:${randomUUID()}`, kind: "test", projectId: null, memberId: null,
    target: { screen: "home" }, occurredAt: push.timestamp() });
  return { push, worker, client, device, event, advance: (ms: number) => { now += ms; }, state: () => client.status().find(p => p.environment === "sandbox")! };
}
class Transport implements APNsTransport {
  requests: APNsTransportRequest[] = [];
  handler: (request: APNsTransportRequest) => APNsTransportResult | Promise<APNsTransportResult> = () => accepted;
  async send(request: APNsTransportRequest) { this.requests.push(request); return this.handler(request); }
  close(): void {}
}

test("ops-1: 응답 없는 전송 한 번 뒤에도 새 알림이 전달 행을 얻고, 네트워크가 돌아오면 접수된다", async () => {
  const transport = new Transport();
  const f = fixture(transport);
  transport.handler = () => ({ type: "unknown", reason: "timeout" });
  const lost = f.event();
  await f.worker.tick();
  expect(f.push.listDeliveries(lost.id)[0]).toMatchObject({ state: "unknown", lastReason: "timeout" });
  expect(f.state()).toMatchObject({ state: "temporarily_unavailable", lastError: "network_error" });
  // 'unknown' 은 다시 보내지 않는다(중복 방지). 그 뒤의 새 알림까지 막혀서는 안 된다.
  transport.handler = () => accepted;
  f.advance(10_000);
  const next = f.event();
  expect(f.push.listDeliveries(next.id)).toHaveLength(1);
  expect(f.push.listDeliveries(next.id)[0]!.state).toBe("queued");
  await f.worker.tick();
  expect(f.push.listDeliveries(next.id)[0]!.state).toBe("accepted");
  expect(f.push.listDeliveries(lost.id)[0]!.state).toBe("unknown");
  expect(transport.requests).toHaveLength(2);
  expect(f.state().state).toBe("ready");
});

test("ops-1: 네트워크 오류 표시는 전송이 없어도 60초 뒤 풀리고, 그동안에도 알림 켜기·시험 알림이 된다", async () => {
  const transport = new Transport();
  const f = fixture(transport);
  transport.handler = () => ({ type: "not_sent", reason: "network_error" });
  const first = f.event();
  await f.worker.tick();
  expect(f.push.listDeliveries(first.id)[0]!.state).toBe("retry");
  expect(f.state().state).toBe("temporarily_unavailable");
  // 설정 화면에서 껐다 켜기.
  const off = f.push.patchDevice(f.device.id, { expectedRevision: f.device.revision, enabled: false });
  const on = f.push.patchDevice(f.device.id, { expectedRevision: off.revision, enabled: true });
  expect(on.enabled).toBe(true);
  // 시험 알림 경로도 같은 조건을 쓴다.
  let woke = 0;
  const handler = createPushHandler({ store: f.push, providers: () => f.client.status(), wake: async () => { woke++; } });
  const response = await handler(new Request(`http://localhost/api/push/devices/${f.device.id}/test`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-IAMCEO-Contract": "2" }, body: JSON.stringify({ requestId: randomUUID() }) }), new URL(`http://localhost/api/push/devices/${f.device.id}/test`));
  expect(response?.status).toBe(202);
  f.advance(59_999);
  expect(f.state().state).toBe("temporarily_unavailable");
  f.advance(1);
  expect(f.state()).toMatchObject({ state: "ready", lastError: null });
});

test("ops-1: 설정 오류는 그대로 막는다(네트워크 오류만 예외)", async () => {
  const db = openDb(":memory:"); cleanups.push(() => db.close());
  let state: "ready" | "configuration_error" | "temporarily_unavailable" = "ready";
  let lastError: "auth_failed" | "network_error" | null = null;
  const push = new PushStore(db, { now: () => start, providers: () => [{ environment: "sandbox", bundleId: DEFAULT_PUSH_BUNDLE_ID, state, lastError }] });
  const registered = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID,
    environment: "sandbox", deviceToken: "ab", authorization: "authorized" });
  push.patchDevice(registered.id, { expectedRevision: registered.revision, enabled: true });
  const record = () => push.listDeliveries(push.recordEvent({ sourceKey: `test:${randomUUID()}`, kind: "test", projectId: null, memberId: null,
    target: { screen: "home" }, occurredAt: push.timestamp() }).id).length;
  state = "configuration_error"; lastError = "auth_failed"; expect(record()).toBe(0);
  state = "temporarily_unavailable"; lastError = "auth_failed"; expect(record()).toBe(0);
  state = "temporarily_unavailable"; lastError = "network_error"; expect(record()).toBe(1);
  state = "ready"; lastError = null; expect(record()).toBe(1);
});

class ConnectingSession extends EventEmitter {
  connecting = true; destroyed = false; closed = false; alpnProtocol = "h2";
  destroy() { if (!this.destroyed) { this.destroyed = true; this.closed = true; this.emit("close"); } }
}

test("ops-2: 연결조차 못 한 전송은 워커 감시보다 먼저 '보내지 못함'으로 끝나 다시 시도된다", async () => {
  // 연결이 맺어지지 않는 세션: 전송 계층은 아무것도 보내지 않았다.
  const sessions: ConnectingSession[] = [];
  const transport = new HTTP2APNsTransport(() => { const session = new ConnectingSession(); sessions.push(session); return session as unknown as ClientHttp2Session; });
  // 운영값(전송 8초 < 워커 10초)과 같은 순서를 짧은 값으로 둔다.
  const f = fixture(transport, 2_000, 30);
  const event = f.event();
  await f.worker.tick();
  const delivery = f.push.listDeliveries(event.id)[0]!;
  expect(delivery).toMatchObject({ state: "retry", lastReason: "timeout", attempts: 1 });
  expect(sessions).toHaveLength(1); expect(sessions[0]!.destroyed).toBe(true);
});

test("ops-2: 운영 기본값에서 전송 한도는 워커 감시(10초)보다 짧다", async () => {
  const transport = new Transport();
  const client = new APNsClient(config(), { transport, now: () => start });
  cleanups.push(() => client.close());
  await client.send({ environment: "sandbox", deviceToken: "ab", deliveryId: randomUUID(), eventId: randomUUID(), serverId: randomUUID(), kind: "test",
    target: { screen: "home" }, occurredAt: new Date(start).toISOString(), expiresAt: new Date(start + 300_000).toISOString() });
  expect(transport.requests[0]!.timeoutMs).toBeLessThan(10_000);
});
