// 실제 HTTP/2·TLS 로 가짜 APNs(127.0.0.1)에 보낸다. Mac 서버와 같은 전송 코드(HTTP2APNsTransport)를 쓴다.
// 여럿이 함께 쓰는 중계의 꼬리 지연: 한 건이 멈춰도 다른 건은 같은 연결의 다른 스트림으로 바로 간다.
import { afterEach, describe, expect, test } from "bun:test";
import { verify } from "node:crypto";
import { connect } from "node:http2";
import { APNS_ORIGINS } from "../../../server/push/apns.ts";
import { TOKEN, fakeApns, install, parse, pushBody, relayFixture, reply, request } from "./helpers.ts";
import type { ApnsHandler } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(handler: ApnsHandler, apns: { timeoutMs?: number; maxInFlight?: number; maxQueueWaitMs?: number } = {}) {
  const server = await fakeApns(cleanups, handler);
  const fixture = relayFixture(cleanups, { apns: { connector: server.connector, ...apns } });
  const { authorization } = await install(fixture.relay);
  const push = (overrides: Record<string, unknown> = {}) => fixture.relay.handle(request("POST", "/v1/push", pushBody(overrides), { authorization }));
  return { ...fixture, server, push };
}

describe("TLS HTTP/2 가짜 APNs", () => {
  test("ALPN h2·production 주소·고정 머리글·ES256 JWT·Mac 과 같은 본문, 연결은 다시 쓴다", async () => {
    const { server, push, key } = await setup((stream) => reply(stream, 200, undefined, { "apns-id": "x" }));
    const body = pushBody();
    expect((await push(body)).status).toBe(200);
    expect((await push()).status).toBe(200);
    expect(server.origins).toEqual([APNS_ORIGINS.production]);
    expect(server.connections()).toBe(1);
    const [received] = server.received;
    expect(received!.alpn).toBe("h2");
    expect(received!.headers[":path"]).toBe(`/3/device/${TOKEN}`);
    expect(received!.headers["apns-topic"]).toBe("com.yehsung.iamceo");
    expect(received!.headers["apns-id"]).toBe(String(body.id));
    const [header, claims, signature] = String(received!.headers.authorization).replace(/^bearer /, "").split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "TESTKEY123" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString()).iss).toBe("TEAMID1234");
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key: key.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
    const payload = JSON.parse(received!.body);
    expect(payload.aps.alert).toEqual({ title: "IAMCEO", body: "새 결재가 도착했습니다." });
    expect(payload.iamceo).toEqual({ v: 1, serverId: body.serverId, eventId: body.eventId, kind: "decision", target: body.target });
  });
  test("410 Unregistered 와 timestamp, 429 Retry-After 가 줄을 타고 온다", async () => {
    let next = 0;
    const { push } = await setup((stream) => {
      if (next++ === 0) reply(stream, 410, { reason: "Unregistered", timestamp: 1_790_000_000_123 });
      else reply(stream, 429, { reason: "TooManyRequests" }, { "retry-after": "45" });
    });
    const gone = await push();
    expect(gone.status).toBe(410); expect(parse(gone)).toEqual({ state: "invalid", reason: "Unregistered", timestamp: 1_790_000_000_123 });
    const throttled = await push();
    expect(throttled.status).toBe(429); expect(throttled.headers["retry-after"]).toBe("45");
  });
  test("한 건이 멈춰도 다른 건은 바로 간다(동시 스트림). 멈춘 건은 시간 한도 뒤 504(보냈는지 모름)", async () => {
    let count = 0;
    const { push } = await setup((stream) => { if (count++ > 0) reply(stream, 200); /* 첫 건은 답하지 않는다 */ }, { timeoutMs: 1_500 });
    const started = Date.now();
    const stalled = push();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const quick = await push();
    expect(quick.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    const late = await stalled;
    expect(late.status).toBe(504); expect(parse(late)).toEqual({ state: "unknown" });
    // 멈춘 세션을 버렸으니 다음 건은 새 연결로 간다.
    expect((await push()).status).toBe(200);
  });
  test("자리가 다 찼으면 정해진 시간만 기다리고 보내지 않은 채 503(다시 시도)", async () => {
    const { push, server } = await setup(() => { /* 답하지 않는다 */ }, { timeoutMs: 1_500, maxInFlight: 1, maxQueueWaitMs: 200 });
    const stalled = push();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    const busy = await push();
    expect(busy.status).toBe(503); expect(parse(busy)).toEqual({ reason: "relay_busy" }); expect(busy.headers["retry-after"]).toBe("5");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await stalled).status).toBe(504);
    expect(server.received).toHaveLength(1);
  });
  test("동시 20건: 16개 스트림 + 짧은 줄로 모두 받고, 듣개 경고가 없다", async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on("warning", onWarning);
    cleanups.push(() => { process.off("warning", onWarning); });
    const { push, server } = await setup((stream) => setTimeout(() => reply(stream, 200), 60));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => push({ token: `${(i % 9) + 1}a`.repeat(32) })));
    expect(results.map((result) => result.status)).toEqual(Array(20).fill(200));
    expect(server.connections()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warnings.filter((name) => name === "MaxListenersExceededWarning")).toEqual([]);
  });
  test("믿을 수 없는 인증서면 POST 전에 끊기고 503 not_sent", async () => {
    const server = await fakeApns(cleanups, (stream) => reply(stream, 200));
    const fixture = relayFixture(cleanups, { apns: { connector: (origin, options) => connect(`https://127.0.0.1:${server.port}`, { ...options, servername: "localhost" }) } });
    const { authorization } = await install(fixture.relay);
    const response = await fixture.relay.handle(request("POST", "/v1/push", pushBody(), { authorization }));
    expect(response.status).toBe(503); expect(parse(response)).toEqual({ reason: "not_sent" });
    expect(server.received).toHaveLength(0);
  });
});
