// 중계 HTTP 동작: 경로·인증·모드·한도·APNs 결과를 Mac 이 아는 응답으로 바꾸기·기록하지 않는 것.
// APNs 는 가짜 전송(APNsTransport 주입)으로 대신한다. 실제 HTTP/2 연결 시험은 apns-tls.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import type { APNsTransport, APNsTransportRequest, APNsTransportResult } from "../../../server/push/apns.ts";
import { MASTER, TOKEN, install, parse, pushBody, relayFixture, request } from "./helpers.ts";
import type { RelayFixtureOptions } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class FakeTransport implements APNsTransport {
  sent: APNsTransportRequest[] = [];
  constructor(private readonly respond: (request: APNsTransportRequest, index: number) => APNsTransportResult | Promise<APNsTransportResult>) {}
  async send(request: APNsTransportRequest): Promise<APNsTransportResult> { this.sent.push(request); return this.respond(request, this.sent.length - 1); }
  close(): void {}
}
const ok = (): APNsTransportResult => ({ type: "response", status: 200, headers: {}, body: "" });
const apnsError = (status: number, reason?: string, headers: Record<string, string> = {}, timestamp?: number): APNsTransportResult =>
  ({ type: "response", status, headers, body: JSON.stringify({ ...(reason ? { reason } : {}), ...(timestamp !== undefined ? { timestamp } : {}) }) });

function setup(respond: ConstructorParameters<typeof FakeTransport>[0] = ok, options: RelayFixtureOptions = {}) {
  const transport = new FakeTransport(respond);
  const fixture = relayFixture(cleanups, { ...options, apns: { transport, ...options.apns } });
  return { ...fixture, transport };
}

describe("경로와 설치", () => {
  test("설치 만들기 → 201, 그 자격으로 보내기 → 200, 고정 topic·헤더", async () => {
    const { relay, transport } = setup();
    const created = await relay.handle(request("POST", "/v1/installations", { protocol: 1 }));
    expect(created.status).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    const { installationId, secret } = parse(created) as { installationId: string; secret: string };
    const body = pushBody();
    const sent = await relay.handle(request("POST", "/v1/push", body, { authorization: `Bearer ${installationId}.${secret}` }));
    expect(sent.status).toBe(200);
    expect(parse(sent)).toEqual({ state: "accepted" });
    expect(transport.sent).toHaveLength(1);
    const headers = transport.sent[0]!.headers;
    expect(headers[":path"]).toBe(`/3/device/${TOKEN}`);
    expect(headers[":authority"]).toBe("api.push.apple.com");
    expect(headers["apns-topic"]).toBe("com.yehsung.iamceo");
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-priority"]).toBe("10");
    expect(headers["apns-id"]).toBe(String(body.id));
    expect(headers["apns-collapse-id"]).toBe(String(body.eventId));
    expect(headers["apns-expiration"]).toBe(String(Math.floor(Date.parse(String(body.expiresAt)) / 1000)));
    expect(transport.sent[0]!.credential.environment).toBe("production");
    expect(transport.sent[0]!.timeoutMs).toBe(4_000);
  });
  test("함수 기본 주소(/relay/v1/...)와 끝의 / 도 같은 경로", async () => {
    const { relay } = setup();
    expect((await relay.handle(request("POST", "/relay/v1/installations/?x=1", {}))).status).toBe(201);
    expect((await relay.handle(request("GET", "/relay/healthz"))).status).toBe(200);
  });
  test("모르는 경로 404, 다른 방법 405", async () => {
    const { relay } = setup();
    expect((await relay.handle(request("GET", "/"))).status).toBe(404);
    expect((await relay.handle(request("POST", "/v1/notifications", {}))).status).toBe(404);
    const get = await relay.handle(request("GET", "/v1/push"));
    expect(get.status).toBe(405); expect(get.headers.allow).toBe("POST");
    expect((await relay.handle(request("DELETE", "/v1/installations"))).status).toBe(405);
    expect((await relay.handle(request("POST", "/healthz", {}))).status).toBe(405);
    // run.app 에서는 /healthz 가 앞단에서 막혀 같은 응답을 /v1/health 로 준다.
    expect((await relay.handle(request("GET", "/v1/health"))).status).toBe(200);
    expect((await relay.handle(request("POST", "/v1/health", {}))).status).toBe(405);
  });
  test("자격이 없거나 틀리면 401(APNs 로 보내지 않는다)", async () => {
    const { relay, transport } = setup();
    const { installationId, secret } = await install(relay);
    for (const authorization of [undefined, "", `Bearer ${installationId}`, `Bearer ${installationId}.${secret.slice(1)}x`, `Basic ${secret}`]) {
      const response = await relay.handle(request("POST", "/v1/push", pushBody(), authorization === undefined ? {} : { authorization }));
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
    }
    expect(transport.sent).toHaveLength(0);
  });
  test("master 를 바꾸면 옛 자격은 401(Mac 이 한 번 다시 등록한다)", async () => {
    const first = setup();
    const old = await install(first.relay);
    const rotated = setup(ok, { master: `${MASTER}-next-0123456789` });
    expect((await rotated.relay.handle(request("POST", "/v1/push", pushBody(), { authorization: old.authorization }))).status).toBe(401);
    const fresh = await install(rotated.relay);
    expect((await rotated.relay.handle(request("POST", "/v1/push", pushBody(), { authorization: fresh.authorization }))).status).toBe(200);
  });
  test("본문이 크면 413, 틀리면 400(보내지 않는다)", async () => {
    const { relay, transport } = setup();
    const { authorization } = await install(relay);
    expect((await relay.handle(request("POST", "/v1/push", pushBody({ pad: "x".repeat(5_000) }), { authorization }))).status).toBe(413);
    const bad = await relay.handle(request("POST", "/v1/push", "{not json", { authorization }));
    expect(bad.status).toBe(400); expect(parse(bad)).toEqual({ state: "failed", reason: "invalid_request" });
    const expired = await relay.handle(request("POST", "/v1/push", pushBody({ expiresAt: new Date(Date.now() - 1_000).toISOString() }), { authorization }));
    expect(expired.status).toBe(400); expect(parse(expired)).toEqual({ state: "failed", reason: "expired" });
    expect(transport.sent).toHaveLength(0);
  });
});

describe("APNs 결과 → Mac 이 아는 응답", () => {
  async function one(result: APNsTransportResult | (() => APNsTransportResult)) {
    const fixture = setup(typeof result === "function" ? result : () => result);
    const { authorization, installationId } = await install(fixture.relay);
    const response = await fixture.relay.handle(request("POST", "/v1/push", pushBody(), { authorization }));
    return { ...fixture, response, body: parse(response), installationId, authorization };
  }
  test("Unregistered·ExpiredToken·BadDeviceToken·DeviceTokenNotForTopic → 410(Mac 이 토큰을 지운다)", async () => {
    const unregistered = await one(apnsError(410, "Unregistered", {}, 1_790_000_000_000));
    expect(unregistered.response.status).toBe(410);
    expect(unregistered.body).toEqual({ state: "invalid", reason: "Unregistered", timestamp: 1_790_000_000_000 });
    expect((await one(apnsError(410, "ExpiredToken"))).body).toEqual({ state: "invalid", reason: "ExpiredToken" });
    expect((await one(apnsError(400, "BadDeviceToken"))).response.status).toBe(410);
    expect((await one(apnsError(400, "DeviceTokenNotForTopic"))).body.reason).toBe("DeviceTokenNotForTopic");
    expect(unregistered.logs).toContainEqual({ severity: "WARNING", message: "apns_result", installationId: unregistered.installationId, reason: "Unregistered" });
  });
  test("다른 400·413 은 다시 보내도 같다 → 400/413 failed", async () => {
    const bad = await one(apnsError(400, "BadExpirationDate"));
    expect(bad.response.status).toBe(400); expect(bad.body).toEqual({ state: "failed", reason: "permanent_rejection" });
    const large = await one(apnsError(413, "PayloadTooLarge"));
    expect(large.response.status).toBe(413);
  });
  test("APNs 429(그 토큰이 너무 잦음) → 429 scope token + Retry-After", async () => {
    const throttled = await one(apnsError(429, "TooManyRequests"));
    expect(throttled.response.status).toBe(429);
    expect(throttled.body).toEqual({ reason: "TooManyRequests", scope: "token" });
    expect(throttled.response.headers["retry-after"]).toBe("60");
    const told = await one(apnsError(429, "TooManyRequests", { "retry-after": "120" }));
    expect(told.response.headers["retry-after"]).toBe("120");
  });
  test("APNs 500·503 → 503 apns_unavailable(다시 시도)", async () => {
    const down = await one(apnsError(503, "ServiceUnavailable", { "retry-after": "30" }));
    expect(down.response.status).toBe(503);
    expect(down.body).toEqual({ reason: "apns_unavailable" });
    expect(down.response.headers["retry-after"]).toBe("30");
    expect((await one(apnsError(500, "InternalServerError"))).response.headers["retry-after"]).toBeUndefined();
  });
  test("보내지 못함(not_sent) → 503, 보냈는지 모름(unknown) → 504", async () => {
    const notSent = await one({ type: "not_sent", reason: "network_error" });
    expect(notSent.response.status).toBe(503); expect(notSent.body).toEqual({ reason: "not_sent" });
    const unknown = await one({ type: "unknown", reason: "timeout" });
    expect(unknown.response.status).toBe(504); expect(unknown.body).toEqual({ state: "unknown" });
    const thrown = await one(() => { throw new Error(`SECRET ${TOKEN}`); });
    expect(thrown.response.status).toBe(504);
    expect(JSON.stringify(thrown.logs)).not.toContain(TOKEN);
  });
  test("APNs 403(키 거절) → 503 + 10분, 그동안 APNs 로 보내지 않고, 지나면 다시 시도(영영 멈추지 않는다)", async () => {
    let now = Date.UTC(2026, 10, 13, 12);
    let status = 403;
    const fixture = setup(() => status === 200 ? ok() : apnsError(403, "InvalidProviderToken"), { now: () => now });
    const { authorization } = await install(fixture.relay);
    const first = await fixture.relay.handle(request("POST", "/v1/push", pushBody({ expiresAt: new Date(now + 60_000).toISOString() }), { authorization }));
    expect(first.status).toBe(503);
    expect(parse(first)).toEqual({ reason: "relay_unavailable" });
    expect(first.headers["retry-after"]).toBe("600");
    expect(fixture.logs).toContainEqual({ severity: "ERROR", message: "apns_suspended", reason: "auth_failed", until: new Date(now + 600_000).toISOString() });
    now += 60_000;
    const held = await fixture.relay.handle(request("POST", "/v1/push", pushBody({ expiresAt: new Date(now + 60_000).toISOString() }), { authorization }));
    expect(held.status).toBe(503); expect(held.headers["retry-after"]).toBe("540");
    expect(fixture.transport.sent).toHaveLength(1);
    const health = await fixture.relay.handle(request("GET", "/healthz"));
    expect(health.status).toBe(503);
    expect(parse(health)).toMatchObject({ ok: false, apns: { suspended: true, reason: "auth_failed", last: "auth_failed" } });
    now += 600_000; status = 200;
    const again = await fixture.relay.handle(request("POST", "/v1/push", pushBody({ expiresAt: new Date(now + 60_000).toISOString() }), { authorization }));
    expect(again.status).toBe(200);
    expect(parse(await fixture.relay.handle(request("GET", "/healthz")))).toMatchObject({ ok: true, apns: { suspended: false, last: "accepted" } });
  });
  test("ExpiredProviderToken: 20분 지난 JWT 는 한 번 새로 만들어 다시 보낸다", async () => {
    let now = Date.UTC(2026, 10, 13, 12);
    const fixture = setup((_request, index) => index === 1 ? apnsError(403, "ExpiredProviderToken") : ok(), { now: () => now });
    const { authorization } = await install(fixture.relay);
    expect((await fixture.relay.handle(request("POST", "/v1/push", pushBody({ expiresAt: new Date(now + 60_000).toISOString() }), { authorization }))).status).toBe(200);
    now += 21 * 60_000;
    expect((await fixture.relay.handle(request("POST", "/v1/push", pushBody({ expiresAt: new Date(now + 60_000).toISOString() }), { authorization }))).status).toBe(200);
    expect(fixture.transport.sent).toHaveLength(3);
    expect(fixture.transport.sent[1]!.headers.authorization).not.toBe(fixture.transport.sent[2]!.headers.authorization);
  });
  test("키를 읽지 못하면 503 + 10분, 키 내용은 어디에도 없다", async () => {
    const transport = new FakeTransport(ok);
    const logs: unknown[] = [];
    const { RelayAPNs } = await import("../src/apns-sender.ts");
    const { createRelay } = await import("../src/relay.ts");
    const apns = new RelayAPNs({ credential: () => "key_error", transport, onSuspend: (reason) => logs.push({ reason }) });
    const relay = createRelay({ apns, settings: () => ({ master: MASTER, mode: "open" }), log: (entry) => logs.push(entry) });
    const { authorization } = await install(relay);
    const response = await relay.handle(request("POST", "/v1/push", pushBody(), { authorization }));
    expect(response.status).toBe(503); expect(response.headers["retry-after"]).toBe("600");
    expect(transport.sent).toHaveLength(0);
    expect(logs).toContainEqual({ reason: "key_error" });
    expect(parse(await relay.handle(request("GET", "/healthz")))).toMatchObject({ ok: false, apns: { reason: "key_error", last: "key_error" } });
  });
});

describe("모드·막기·한도", () => {
  test("off: 모든 보내기와 등록이 503 + 1시간", async () => {
    const { relay, transport } = setup(ok, { mode: "off" });
    const created = await relay.handle(request("POST", "/v1/installations", {}));
    expect(created.status).toBe(503); expect(parse(created)).toEqual({ reason: "relay_off" }); expect(created.headers["retry-after"]).toBe("3600");
    expect((await relay.handle(request("GET", "/healthz"))).status).toBe(503);
    expect(transport.sent).toHaveLength(0);
  });
  test("모르는 모드는 off 로 본다(닫는 쪽), master 가 없으면 503", async () => {
    const odd = setup(ok, { mode: "opne" });
    expect((await odd.relay.handle(request("POST", "/v1/installations", {}))).status).toBe(503);
    expect(odd.logs).toContainEqual({ severity: "ERROR", message: "config_invalid", name: "RELAY_MODE" });
    const missing = setup(ok, { master: "short" });
    const response = await missing.relay.handle(request("POST", "/v1/installations", {}));
    expect(response.status).toBe(503); expect(parse(response)).toEqual({ reason: "relay_unavailable" });
    expect(missing.logs).toContainEqual({ severity: "ERROR", message: "config_invalid", name: "RELAY_MASTER" });
  });
  test("allowlist: 등록은 되고, 허용 목록의 설치만 보낸다", async () => {
    const probe = setup();
    const allowed = await install(probe.relay);
    const other = await install(probe.relay, "198.51.100.1");
    const { relay, transport } = setup(ok, { mode: "allowlist", allowed: ` ${allowed.installationId.toUpperCase()} , not-an-id` });
    const denied = await relay.handle(request("POST", "/v1/push", pushBody(), { authorization: other.authorization }));
    expect(denied.status).toBe(403); expect(parse(denied)).toEqual({ reason: "not_allowed" }); expect(denied.headers["retry-after"]).toBe("3600");
    expect((await relay.handle(request("POST", "/v1/push", pushBody(), { authorization: allowed.authorization }))).status).toBe(200);
    expect((await relay.handle(request("POST", "/v1/installations", {}))).status).toBe(201);
    expect(transport.sent).toHaveLength(1);
  });
  test("막힌 설치는 403 + 하루", async () => {
    const probe = setup();
    const blocked = await install(probe.relay);
    const { relay } = setup(ok, { blocked: blocked.installationId });
    const response = await relay.handle(request("POST", "/v1/push", pushBody(), { authorization: blocked.authorization }));
    expect(response.status).toBe(403); expect(parse(response)).toEqual({ reason: "blocked" }); expect(response.headers["retry-after"]).toBe("86400");
  });
  test("설치 한도 → 429 scope installation, 토큰 한도 → 429 scope token, 전체 한도 → 503", async () => {
    const { relay, transport } = setup(ok, { limits: { installationPerMinute: 2, tokenPerDay: 3, sendsPerMinute: 5 } });
    const a = await install(relay, "203.0.113.1");
    const b = await install(relay, "203.0.113.2");
    expect((await relay.handle(request("POST", "/v1/push", pushBody(), { authorization: a.authorization }))).status).toBe(200);
    expect((await relay.handle(request("POST", "/v1/push", pushBody(), { authorization: a.authorization }))).status).toBe(200);
    const installation = await relay.handle(request("POST", "/v1/push", pushBody(), { authorization: a.authorization }));
    expect(installation.status).toBe(429); expect(parse(installation)).toEqual({ reason: "rate_limited", scope: "installation" });
    expect(Number(installation.headers["retry-after"])).toBeGreaterThan(0);
    expect((await relay.handle(request("POST", "/v1/push", pushBody(), { authorization: b.authorization }))).status).toBe(200);
    const token = await relay.handle(request("POST", "/v1/push", pushBody(), { authorization: b.authorization }));
    expect(token.status).toBe(429); expect(parse(token)).toEqual({ reason: "rate_limited", scope: "token" });
    const c = await install(relay, "203.0.113.3");
    expect((await relay.handle(request("POST", "/v1/push", pushBody({ token: "c3".repeat(32) }), { authorization: c.authorization }))).status).toBe(200);
    expect((await relay.handle(request("POST", "/v1/push", pushBody({ token: "d4".repeat(32) }), { authorization: c.authorization }))).status).toBe(200);
    const global = await relay.handle(request("POST", "/v1/push", pushBody({ token: "e5".repeat(32) }), { authorization: (await install(relay, "203.0.113.4")).authorization }));
    expect(global.status).toBe(503); expect(parse(global)).toEqual({ reason: "relay_busy" });
    expect(transport.sent).toHaveLength(5);
  });
  test("설치 만들기 한도: IP 별 하루 → 429 scope installation. 앞에 꾸민 X-Forwarded-For·Fastly-Client-IP 로 비켜 가지 못한다", async () => {
    const { relay } = setup(ok, { limits: { createPerIpPerDay: 2 } });
    await install(relay, "198.51.100.9");
    await install(relay, "203.0.113.99, 198.51.100.9");
    const attempts: Record<string, string>[] = [{ "x-forwarded-for": "198.51.100.9" }, { "x-forwarded-for": "9.9.9.9, 198.51.100.9" },
      { "x-forwarded-for": "9.9.9.9, 198.51.100.9", "fastly-client-ip": "8.8.4.4" }];
    for (const headers of attempts) {
      const again = await relay.handle(request("POST", "/v1/installations", {}, headers));
      expect(again.status).toBe(429); expect(parse(again)).toEqual({ reason: "rate_limited", scope: "installation" });
      expect(again.headers["x-relay-forwarded-count"]).toBe(String(headers["x-forwarded-for"]!.split(",").length));
    }
    const fresh = await relay.handle(request("POST", "/v1/installations", {}, { "x-forwarded-for": "198.51.100.10" }));
    expect(fresh.status).toBe(201); expect(fresh.headers["x-relay-forwarded-count"]).toBe("1");
    // 머리글이 없으면(앞단이 붙이지 않았으면) 0 으로 알리고 IP 한도는 건너뛴다.
    expect((await relay.handle(request("POST", "/v1/installations", {}))).headers["x-relay-forwarded-count"]).toBe("0");
  });
  test("RELAY_MASTER 를 바꾼 뒤 재등록이 몰려 전체 한도에 막혀도, 막힌 Mac 은 다음 시간에 등록된다(IP 몫을 태우지 않음)", async () => {
    let now = Date.UTC(2026, 10, 13, 9, 10);
    const before = setup(ok, { now: () => now });
    const macs = await Promise.all(["203.0.113.31", "203.0.113.32", "203.0.113.33"].map((ip) => install(before.relay, ip)));
    // 다시 배포: 새 master, 새 인스턴스(메모리 0), 시간당 등록 1건으로 줄여 몰림을 흉내 낸다.
    now = Date.UTC(2026, 10, 13, 10, 5);
    const after = setup(ok, { now: () => now, master: `${MASTER}-rotated-0123456789`, limits: { createPerHour: 1, createPerIpPerDay: 2 } });
    for (const mac of macs) expect((await after.relay.handle(request("POST", "/v1/push", pushBody(), { authorization: mac.authorization }))).status).toBe(401);
    expect((await install(after.relay, "203.0.113.31")).installationId).toBeTruthy();
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const ip of ["203.0.113.32", "203.0.113.33"]) {
        const busy = await after.relay.handle(request("POST", "/v1/installations", { protocol: 1 }, { "x-forwarded-for": ip }));
        expect(busy.status).toBe(503); expect(parse(busy)).toEqual({ reason: "relay_busy" });
        expect(Number(busy.headers["retry-after"])).toBeLessThanOrEqual(3_600);
      }
    }
    now = Date.UTC(2026, 10, 13, 11, 0, 1);
    const renewed = await install(after.relay, "203.0.113.32");
    expect((await after.relay.handle(request("POST", "/v1/push", pushBody({ expiresAt: new Date(now + 60_000).toISOString() }),
      { authorization: renewed.authorization }))).status).toBe(200);
    now = Date.UTC(2026, 10, 13, 12, 0, 1);
    expect((await install(after.relay, "203.0.113.33")).installationId).toBeTruthy();
  });
  test("오류 예산: 영구 토큰 오류가 넘치면 그 설치만 하루 정지(429 error_budget)", async () => {
    const { relay, logs, transport } = setup(() => apnsError(400, "BadDeviceToken"), { limits: { errorBudget: 3 } });
    const abuser = await install(relay, "203.0.113.20");
    for (let i = 0; i < 4; i++) {
      expect((await relay.handle(request("POST", "/v1/push", pushBody({ token: `${i}f`.repeat(32) }), { authorization: abuser.authorization }))).status).toBe(410);
    }
    const stopped = await relay.handle(request("POST", "/v1/push", pushBody(), { authorization: abuser.authorization }));
    expect(stopped.status).toBe(429); expect(parse(stopped)).toEqual({ reason: "error_budget", scope: "installation" });
    expect(Number(stopped.headers["retry-after"])).toBeGreaterThan(86_000);
    expect(transport.sent).toHaveLength(4);
    expect(logs.some((entry) => entry.message === "installation_suspended" && entry.installationId === abuser.installationId)).toBe(true);
    const other = await install(relay, "203.0.113.21");
    expect((await relay.handle(request("POST", "/v1/push", pushBody(), { authorization: other.authorization }))).status).toBe(410);
  });
});

describe("기록", () => {
  test("시간이 바뀌면 지난 시간의 합계 한 줄(건수만)", async () => {
    let now = Date.UTC(2026, 10, 13, 12, 10);
    const { relay, logs } = setup(ok, { now: () => now });
    const { authorization } = await install(relay);
    await relay.handle(request("POST", "/v1/push", pushBody({ expiresAt: new Date(now + 60_000).toISOString() }), { authorization }));
    await relay.handle(request("POST", "/v1/push", pushBody(), { authorization: "Bearer nope" }));
    now = Date.UTC(2026, 10, 13, 13, 0, 1);
    await relay.handle(request("GET", "/healthz"));
    expect(logs).toContainEqual({ severity: "INFO", message: "relay_hourly", hour: "2026-11-13T12:00:00.000Z",
      counts: { create_received: 1, create_xff_1: 1, created: 1, create_ip_groups: 1, push_received: 2, accepted: 1, unauthorized: 1 } });
  });
  test("healthz 에는 사용자 정보가 없다", async () => {
    const { relay } = setup();
    const { authorization } = await install(relay);
    await relay.handle(request("POST", "/v1/push", pushBody(), { authorization }));
    const health = parse(await relay.handle(request("GET", "/healthz")));
    expect(Object.keys(health).sort()).toEqual(["apns", "mode", "ok"]);
    expect(Object.keys(health.apns as object).sort()).toEqual(["last", "lastAt", "reason", "suspended"]);
    expect(String((health.apns as { lastAt: string }).lastAt)).toMatch(/:00\.000Z$/);
  });
});
