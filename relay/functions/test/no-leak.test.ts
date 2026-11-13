// 기록하지 않는 것: 토큰 원문, IP 원문, Authorization·secret, 본문(serverId·eventId·전달 ID·대상 ID).
// 여러 결과를 한꺼번에 지나가게 하고, 중계가 남긴 모든 기록과 console 출력에서 그 값들을 찾는다.
import { afterEach, expect, test } from "bun:test";
import type { APNsTransport, APNsTransportRequest, APNsTransportResult } from "../../../server/push/apns.ts";
import { install, pushBody, relayFixture, request } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const ALLOWED = {
  apns_result: ["severity", "message", "installationId", "reason"],
  apns_suspended: ["severity", "message", "reason", "until"],
  installation_suspended: ["severity", "message", "installationId", "reason", "until"],
  relay_hourly: ["severity", "message", "hour", "counts"],
  config_invalid: ["severity", "message", "name"],
  internal_error: ["severity", "message"],
} as const;

test("어떤 결과든 기록에는 설치 ID·사유 코드·시각·건수만 남는다", async () => {
  const outcomes: APNsTransportResult[] = [
    { type: "response", status: 200, headers: {}, body: "" },
    { type: "response", status: 410, headers: {}, body: '{"reason":"Unregistered","timestamp":1790000000000}' },
    { type: "response", status: 400, headers: {}, body: '{"reason":"BadDeviceToken"}' },
    { type: "response", status: 400, headers: {}, body: '{"reason":"BadTopic"}' },
    { type: "response", status: 429, headers: {}, body: '{"reason":"TooManyRequests"}' },
    { type: "response", status: 500, headers: {}, body: "<html>secret upstream text</html>" },
    { type: "not_sent", reason: "network_error" },
    { type: "unknown", reason: "goaway" },
    { type: "response", status: 403, headers: {}, body: '{"reason":"InvalidProviderToken"}' },
  ];
  let index = 0;
  const transport: APNsTransport = { async send(_request: APNsTransportRequest) { return outcomes[index++ % outcomes.length]!; }, close() {} };
  let now = Date.UTC(2026, 10, 13, 12, 59, 0);
  const { relay, logs } = relayFixture(cleanups, { now: () => now, apns: { transport, authHoldMs: 1_000 }, limits: { errorBudget: 1 } });
  const consoleCalls: unknown[][] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => {
    const original = console[name];
    console[name] = (...args: unknown[]) => { consoleCalls.push(args); };
    return () => { console[name] = original; };
  });
  cleanups.push(() => spies.forEach((restore) => restore()));

  const ip = "198.51.100.200";
  const sensitive: string[] = [ip];
  const installs = [];
  for (let i = 0; i < 3; i++) installs.push(await install(relay, `${ip}, 35.191.2.${i}`));
  for (const item of installs) sensitive.push(item.secret, item.authorization);
  for (let i = 0; i < outcomes.length * 2; i++) {
    const item = installs[i % installs.length]!;
    const token = `${(i % 15).toString(16)}${((i + 3) % 15).toString(16)}`.repeat(32);
    const body = pushBody({ token, expiresAt: new Date(now + 120_000).toISOString(),
      target: { screen: "inbox", projectId: `proj_${i}_private`, decisionId: `dec_${i}_private` } });
    sensitive.push(token, String(body.id), String(body.eventId), `proj_${i}_private`, `dec_${i}_private`);
    await relay.handle(request("POST", "/v1/push", body, { authorization: item.authorization, "x-forwarded-for": ip }));
    now += 1_500; // 키 거절 정지(1초)가 풀리게
  }
  await relay.handle(request("POST", "/v1/push", "{broken " + sensitive[3], { authorization: installs[0]!.authorization }));
  now = Date.UTC(2026, 10, 13, 14);
  await relay.handle(request("GET", "/healthz"));

  const text = JSON.stringify(logs) + JSON.stringify(consoleCalls);
  for (const value of sensitive) expect({ value, found: text.includes(value) }).toEqual({ value, found: false });
  expect(text).not.toContain("secret upstream text");
  expect(text).not.toContain("6f1f8a9e-2b7c-4d1e-9a3b-1c2d3e4f5a6b"); // serverId
  expect(consoleCalls).toEqual([]);
  expect(logs.length).toBeGreaterThan(0);
  for (const entry of logs) {
    const allowed = ALLOWED[entry.message as keyof typeof ALLOWED];
    expect(allowed).toBeDefined();
    expect([...allowed]).toEqual(expect.arrayContaining(Object.keys(entry)));
  }
  expect(logs.some((entry) => entry.message === "relay_hourly")).toBe(true);
  expect(logs.some((entry) => entry.message === "apns_result")).toBe(true);
});
