// 알림 중계 프로토콜 대조: Mac 의 RelayClient(server/push/relay.ts)가 relay/ 의 실제 중계 핵심(createRelay)과 말이 통하는지.
// 중계는 127.0.0.1 에서만 돌고 APNs 는 가짜다. Firebase·Apple 에는 닿지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { APNS_TTL_MS, buildAPNsPayload, serializeAPNsPayload } from "../server/push/apns.ts";
import type { APNsNotification } from "../server/push/apns.ts";
import { RelayClient } from "../server/push/relay.ts";
import { createRelay } from "../relay/functions/src/relay.ts";
import type { SendOutcome } from "../relay/functions/src/apns-sender.ts";
import type { PushRequest } from "../relay/functions/src/push-request.ts";
import type { PushKind } from "../shared/push.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const MASTER = "contract-test-master-0123456789-abcdefghijklmnop";
const TOKEN = "ab".repeat(32);

function serve(mode = "open", outcome: (request: PushRequest) => SendOutcome = () => ({ kind: "accepted" })) {
  const sent: PushRequest[] = [];
  const relay = createRelay({
    settings: () => ({ master: MASTER, mode }),
    apns: { async send(request) { sent.push(request); return outcome(request); }, health: () => ({ suspended: false, reason: null, last: "none", lastAt: 0 }) },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    const result = await relay.handle({ method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers),
      body: Buffer.from(await req.arrayBuffer()) });
    return new Response(result.body, { status: result.status, headers: result.headers });
  } });
  cleanups.push(() => server.stop(true));
  const runtime = createIsolatedRuntime();
  cleanups.push(() => runtime.stop());
  const client = new RelayClient({ home: runtime.paths.iamceoHome, url: `http://127.0.0.1:${server.port}`, log: () => {} });
  cleanups.push(() => client.close());
  return { client, sent };
}

function notification(kind: PushKind | "test", summary = false): APNsNotification {
  const now = Date.now();
  return { environment: "production", deviceToken: TOKEN, deliveryId: randomUUID(), eventId: randomUUID(), serverId: randomUUID(), kind,
    occurredAt: new Date(now).toISOString(), expiresAt: new Date(now + APNS_TTL_MS[kind]).toISOString(), reportSummary: summary,
    target: kind === "test" ? { screen: "home" } : kind === "decision" ? { screen: "inbox", projectId: "p_1", decisionId: "d_1" }
      : kind === "report_complete" || kind === "report_blocked" ? { screen: "chat", projectId: "p_1", memberId: null, messageId: "msg_1", groupId: randomUUID() }
      : kind === "todo_created" ? { screen: "home", projectId: "hq" } : { screen: "team", projectId: "p_1", memberId: "m_1" } };
}

describe("Mac client ↔ relay core (protocol 1)", () => {
  test("register, send every kind: the relay's APNs payload is byte-for-byte what this Mac would send with its own key", async () => {
    const { client, sent } = serve();
    const cases: [PushKind | "test", boolean][] = [["decision", false], ["approval_wait", false], ["error", false], ["report_complete", false],
      ["report_complete", true], ["todo_created", false], ["report_blocked", false], ["test", false]];
    for (const [kind, summary] of cases) {
      const n = notification(kind, summary);
      expect(await client.send(n)).toEqual({ state: "accepted", reason: "accepted", status: 200 });
      const request = sent.at(-1)!;
      expect(request.payload).toBe(serializeAPNsPayload(buildAPNsPayload(n)));
      expect(request).toMatchObject({ token: TOKEN, id: n.deliveryId, eventId: n.eventId, kind });
      expect(Math.abs(request.expiresAt - Date.parse(n.expiresAt))).toBeLessThan(1000);
    }
  });
  test("relay outcomes reach the worker as the right results", async () => {
    const outcomes: SendOutcome[] = [
      { kind: "invalid", reason: "BadDeviceToken", timestamp: 1_800_000_000_000 },
      { kind: "throttled", retryAt: Date.now() + 30_000 },
      { kind: "retry", reason: "server_error" },
      { kind: "unknown" },
      { kind: "rejected", reason: "permanent_rejection" },
      { kind: "rejected", reason: "PayloadTooLarge" },
      { kind: "expired" },
    ];
    let index = 0;
    const { client } = serve("open", () => outcomes[index]!);
    const results = [];
    for (index = 0; index < outcomes.length; index++) results.push(await client.send(notification("decision")));
    expect(results[0]).toEqual({ state: "invalid", reason: "BadDeviceToken", status: 410, invalidatedAt: 1_800_000_000_000 });
    expect(results[1]).toMatchObject({ state: "retry", reason: "TooManyRequests", status: 429 }); // 그 iPhone 의 알림만 늦춘다.
    expect(results[2]).toEqual({ state: "retry", reason: "server_error", status: 503 });
    expect(results[3]).toEqual({ state: "unknown", reason: "timeout", status: 504 }); // 다시 보내지 않는다.
    expect(results[4]).toEqual({ state: "failed", reason: "permanent_rejection", status: 400 });
    expect(results[5]).toEqual({ state: "failed", reason: "PayloadTooLarge", status: 413 });
    expect(results[6]).toEqual({ state: "expired", reason: "expired", status: 400 });
    expect(client.status().state).toBe("ready");
  });
  test("the relay's APNs-key rest and the off switch hold this Mac with a retry time; 'allowed installations only' too", async () => {
    const resting = serve("open", () => ({ kind: "retry", reason: "relay_unavailable", retryAt: Date.now() + 600_000 }));
    const result = await resting.client.send(notification("test"));
    expect(result).toMatchObject({ state: "unavailable", reason: "server_error", status: 503 });
    expect((result as { retryAt: number }).retryAt).toBeGreaterThan(Date.now() + 590_000);
    expect(resting.client.status()).toMatchObject({ state: "temporarily_unavailable", lastError: "network_error" });
    const off = serve("off");
    expect(await off.client.send(notification("test"))).toMatchObject({ state: "unavailable", reason: "server_error", status: 503 });
    const allowlist = serve("allowlist");
    const refused = await allowlist.client.send(notification("test"));
    expect(refused).toMatchObject({ state: "unavailable", reason: "auth_failed", status: 403 });
    expect((refused as { retryAt: number }).retryAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(allowlist.sent).toHaveLength(0);
  });
});
