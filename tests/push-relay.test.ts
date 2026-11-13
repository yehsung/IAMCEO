// 알림 중계(Mac 서버 쪽): 이 Mac 에 production 키가 없으면 개발자의 중계로 보낸다.
// 실제 중계·APNs 에는 닿지 않는다. 127.0.0.1 의 가짜 중계(Bun.serve)와 주입한 fetch 로만 시험한다.
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as net from "node:net";
import { join } from "node:path";
import * as tls from "node:tls";
import { APNS_TTL_MS, buildAPNsPayload } from "../server/push/apns.ts";
import type { APNsNotification, APNsResult } from "../server/push/apns.ts";
import { loadAPNsConfig } from "../server/push/config.ts";
import { PushStore } from "../server/push/store.ts";
import { PushWorker } from "../server/push/worker.ts";
import { createPushHandler } from "../server/push/routes.ts";
import { DEFAULT_PUSH_RELAY_URL, PUSH_RELAY_FILE, PushRouter, RelayClient, createPushClient, normalizePushRelayUrl, serverPushRelayOptions,
  pushRelaySecrets, pushRelaySummary, readPushRelayCredential, relayPushBody, writePushRelayCredential } from "../server/push/relay.ts";
import { loadConfig, pushRelaySettings, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { createDiagnostics } from "../server/diagnose.ts";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";
import type { PushKind, PushProviderStatus } from "../shared/push.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const T0 = Date.parse("2026-11-13T00:00:00.000Z");
const TOKEN = "AB".repeat(32);

function home(): string {
  const runtime = createIsolatedRuntime();
  cleanups.push(() => runtime.stop());
  return runtime.paths.iamceoHome;
}

interface Seen { path: string; method: string; authorization: string | null; body: string }
type Reply = (seen: Seen, issued: Map<string, string>) => Response | Promise<Response>;

/** 프로토콜 1 의 가짜 중계. 설치를 발급하고, 알림은 발급한 자격만 받는다. reply 로 응답을 바꾼다. */
function fakeRelay(reply?: Reply) {
  const seen: Seen[] = [];
  const issued = new Map<string, string>();
  const state = { reply };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    const entry = { path: url.pathname, method: req.method, authorization: req.headers.get("authorization"), body: await req.text() };
    seen.push(entry);
    if (state.reply) return state.reply(entry, issued);
    return defaultReply(entry, issued);
  } });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, seen, issued, state,
    pushes: () => seen.filter((s) => s.path === "/v1/push"), registrations: () => seen.filter((s) => s.path === "/v1/installations") };
}
function defaultReply(entry: Seen, issued: Map<string, string>): Response {
  if (entry.method === "POST" && entry.path === "/v1/installations") {
    const installationId = randomUUID(), secret = randomBytes(32).toString("base64url");
    issued.set(installationId, secret);
    return Response.json({ installationId, secret }, { status: 201 });
  }
  if (entry.method === "POST" && entry.path === "/v1/push") {
    const match = /^Bearer ([^.]+)\.(.+)$/.exec(entry.authorization ?? "");
    if (!match || issued.get(match[1]!) !== match[2]) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json({ ok: true });
  }
  return new Response("not found", { status: 404 });
}

function notification(kind: PushKind | "test" = "decision", now = T0, environment: "sandbox" | "production" = "production"): APNsNotification {
  return { environment, deviceToken: TOKEN, deliveryId: randomUUID(), eventId: randomUUID(), serverId: randomUUID(), kind,
    occurredAt: new Date(now).toISOString(), expiresAt: new Date(now + APNS_TTL_MS[kind]).toISOString(),
    reportSummary: kind === "report_complete",
    target: kind === "test" ? { screen: "home" } : kind === "decision" ? { screen: "inbox", projectId: "p_1", decisionId: "d_1" }
      : kind === "report_complete" || kind === "report_blocked" ? { screen: "chat", projectId: "p_1", memberId: "m_1", messageId: "msg_1", groupId: randomUUID() }
      : kind === "todo_created" ? { screen: "home", projectId: "p_1" } : { screen: "team", projectId: "p_1", memberId: "m_1" } };
}

function relayClient(dir: string, url: string, options: { now?: () => number; timeoutMs?: number; tlsCa?: string | Buffer } = {}) {
  const logs: string[] = [];
  const client = new RelayClient({ home: dir, url: normalizePushRelayUrl(url), now: options.now ?? (() => T0), timeoutMs: options.timeoutMs,
    tlsCa: options.tlsCa, log: (line) => logs.push(line) });
  cleanups.push(() => client.close());
  return { client, logs };
}

function writeAPNs(dir: string, value: unknown) {
  const keyDir = join(dir, "keys");
  require("node:fs").mkdirSync(keyDir, { mode: 0o700 });
  const keyPath = join(keyDir, "k.p8");
  writeFileSync(keyPath, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const entry = { keyId: "TESTKEY123", teamId: "TEAMID1234", bundleId: DEFAULT_PUSH_BUNDLE_ID, privateKeyPath: keyPath };
  const resolved = typeof value === "function" ? (value as (e: typeof entry) => unknown)(entry) : value;
  writeFileSync(join(dir, "apns.json"), typeof resolved === "string" ? resolved : JSON.stringify(resolved), { mode: 0o600 });
}

class FakeDirect {
  sent: APNsNotification[] = [];
  closed = false;
  constructor(private readonly providers: PushProviderStatus[]) {}
  status() { return this.providers.map((p) => ({ ...p })); }
  async send(n: APNsNotification): Promise<APNsResult> { this.sent.push(n); return { state: "accepted", reason: "accepted", status: 200 }; }
  close() { this.closed = true; }
}

describe("relay address and settings", () => {
  test("https only (loopback http for local tests), no credentials, query or fragment; trailing slash removed", () => {
    expect(normalizePushRelayUrl("https://relay.example.com/")).toBe("https://relay.example.com");
    expect(normalizePushRelayUrl("https://us-central1-p.cloudfunctions.net/relay/")).toBe("https://us-central1-p.cloudfunctions.net/relay");
    expect(normalizePushRelayUrl("http://127.0.0.1:5001/demo/us-central1/relay")).toBe("http://127.0.0.1:5001/demo/us-central1/relay");
    for (const bad of ["http://relay.example.com", "https://u:p@relay.example.com", "https://relay.example.com/?x=1", "https://relay.example.com/#a",
      "ftp://relay.example.com", "relay.example.com", "", " https://relay.example.com", 42, null]) {
      expect(() => normalizePushRelayUrl(bad)).toThrow();
    }
  });
  test("the default address is the deployed relay (https, Cloud Run, no path)", () => {
    // 2026-11-14 배포한 iamceo-relay 의 Cloud Run 주소. Firebase Hosting(*.web.app)·cloudfunctions.net 이 아니다.
    expect(DEFAULT_PUSH_RELAY_URL).toBe("https://relay-480267814589.us-central1.run.app");
    expect(normalizePushRelayUrl(DEFAULT_PUSH_RELAY_URL)).toBe(DEFAULT_PUSH_RELAY_URL!);
  });
  test("config.json: false turns it off, a wrong value turns it off instead of stopping the server", () => {
    const warnings: string[] = [];
    const warn = (line: string) => warnings.push(line);
    expect(pushRelaySettings({}, warn)).toEqual({});
    expect(pushRelaySettings({ pushRelay: true }, warn)).toEqual({});
    expect(pushRelaySettings({ pushRelay: false, pushRelayUrl: "https://relay.example.com" }, warn)).toEqual({ pushRelay: false });
    expect(pushRelaySettings({ pushRelayUrl: "https://relay.example.com/" }, warn)).toEqual({ pushRelayUrl: "https://relay.example.com" });
    expect(warnings).toEqual([]);
    expect(pushRelaySettings({ pushRelay: "yes" } as never, warn)).toEqual({ pushRelay: false });
    // 잘못 적은 주소 대신 기본 주소로 토큰을 보내지 않는다.
    expect(pushRelaySettings({ pushRelayUrl: "http://relay.example.com" }, warn)).toEqual({ pushRelay: false });
    expect(warnings).toHaveLength(2);
  });
});

describe("config.json", () => {
  test("loadConfig carries pushRelay:false and a checked address; a bad value never stops the server", () => {
    const dir = home();
    const env = { IAMCEO_HOME: dir, IAMCEO_PORT: "0" };
    updateConfigFile({ accessCode: "relay-config-test", hosts: ["127.0.0.1"] }, env);
    expect(loadConfig(env).pushRelay).toBeUndefined();
    updateConfigFile({ pushRelay: false }, env);
    expect(loadConfig(env).pushRelay).toBe(false);
    updateConfigFile({ pushRelay: undefined, pushRelayUrl: "https://relay.example.com/" }, env);
    expect(loadConfig(env)).toMatchObject({ pushRelayUrl: "https://relay.example.com" });
    const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...raw, pushRelay: "on", pushRelayUrl: "http://relay.example.com" }), { mode: 0o600 });
    const warn = console.warn;
    console.warn = () => {};
    try { expect(loadConfig(env)).toMatchObject({ pushRelay: false, accessCode: "relay-config-test" }); }
    finally { console.warn = warn; }
  });
});

describe("which way each environment sends", () => {
  const url = "https://relay.example.com";
  test("no key file: production goes through the relay (ready, via relay); sandbox stays unconfigured", () => {
    const dir = home();
    const router = createPushClient({ home: dir, relayUrl: url });
    cleanups.push(() => router.close());
    expect(router.relay?.url).toBe(url);
    expect(router.status()).toEqual([
      { environment: "sandbox", bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "unconfigured", lastError: null },
      { environment: "production", bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready", lastError: null, via: "relay" },
    ]);
  });
  test("server start: test mode never uses the default relay (a live DB copy holds the owner's real device tokens)", () => {
    expect(serverPushRelayOptions({}, {})).toEqual({ relay: true, relayUrl: null });
    expect(serverPushRelayOptions({ pushRelay: false }, {})).toEqual({ relay: false });
    expect(serverPushRelayOptions({}, { IAMCEO_TEST: "1" })).toEqual({ relay: false });
    expect(serverPushRelayOptions({ pushRelayUrl: "http://127.0.0.1:5001/relay" }, { IAMCEO_TEST: "1" })).toEqual({ relay: true, relayUrl: "http://127.0.0.1:5001/relay" });
    expect(serverPushRelayOptions({ pushRelay: false, pushRelayUrl: "https://relay.example.com" }, { IAMCEO_TEST: "1" })).toEqual({ relay: false });
    const dir = home();
    const router = createPushClient({ home: dir, ...serverPushRelayOptions({}, { IAMCEO_TEST: "1" }) });
    cleanups.push(() => router.close());
    expect(router.relay).toBeNull();
  });
  test("turned off: exactly as before (unconfigured); no address given: the deployed default", () => {
    const dir = home();
    for (const router of [createPushClient({ home: dir, relay: false, relayUrl: url }), createPushClient({ home: dir, relay: false })]) {
      cleanups.push(() => router.close());
      expect(router.relay).toBeNull();
      expect(router.status().map((p) => [p.state, p.via])).toEqual([["unconfigured", undefined], ["unconfigured", undefined]]);
    }
    for (const router of [createPushClient({ home: dir }), createPushClient({ home: dir, relayUrl: null })]) {
      cleanups.push(() => router.close());
      expect(router.relay?.url).toBe(DEFAULT_PUSH_RELAY_URL!);
    }
  });
  test("a production key on this Mac wins: sent directly, never to the relay", () => {
    const dir = home();
    writeAPNs(dir, (entry: object) => ({ sandbox: entry, production: entry }));
    const router = createPushClient({ home: dir, relayUrl: url });
    cleanups.push(() => router.close());
    expect(router.relay).toBeNull();
    expect(router.status().map((p) => [p.environment, p.state, p.via])).toEqual([["sandbox", "ready", "key"], ["production", "ready", "key"]]);
  });
  test("only a sandbox key: sandbox direct, production through the relay", () => {
    const dir = home();
    writeAPNs(dir, (entry: object) => ({ sandbox: entry }));
    const router = createPushClient({ home: dir, relayUrl: url });
    cleanups.push(() => router.close());
    expect(router.status().map((p) => [p.environment, p.state, p.via])).toEqual([["sandbox", "ready", "key"], ["production", "ready", "relay"]]);
  });
  test("a broken key file is the user's own key: no silent fallback to the relay", () => {
    const dir = home();
    writeAPNs(dir, "{broken");
    const router = createPushClient({ home: dir, relayUrl: url });
    cleanups.push(() => router.close());
    expect(router.relay).toBeNull();
    expect(router.status().every((p) => p.state === "configuration_error")).toBe(true);
    const unreadable = home();
    writeAPNs(unreadable, (entry: object) => ({ production: { ...entry, privateKeyPath: join(unreadable, "missing.p8") } }));
    expect(loadAPNsConfig(unreadable).providers[1]!.state).toBe("configuration_error");
    expect(createPushClient({ home: unreadable, relayUrl: url }).relay).toBeNull();
  });
  test("send: production to the relay, sandbox to the direct client; close closes both", async () => {
    const relay = fakeRelay();
    const dir = home();
    const direct = new FakeDirect([{ environment: "sandbox", bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready", lastError: null },
      { environment: "production", bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "unconfigured", lastError: null }]);
    const router = new PushRouter(direct, relayClient(dir, relay.url).client);
    expect((await router.send(notification("test", Date.now(), "sandbox"))).state).toBe("accepted");
    expect(direct.sent).toHaveLength(1);
    expect(relay.seen).toHaveLength(0);
    expect((await router.send(notification("test", Date.now()))).state).toBe("accepted");
    expect(direct.sent).toHaveLength(1);
    expect(relay.pushes()).toHaveLength(1);
    router.close();
    expect(direct.closed).toBe(true);
    expect((await router.send(notification("test", Date.now()))).reason).toBe("shutdown");
  });
});

describe("installation and sending", () => {
  test("nothing is sent to the relay until there is a notification to send", async () => {
    const relay = fakeRelay();
    const dir = home();
    const router = createPushClient({ home: dir, relayUrl: relay.url });
    cleanups.push(() => router.close());
    for (let i = 0; i < 3; i++) router.status();
    await Bun.sleep(20);
    expect(relay.seen).toHaveLength(0);
    expect(existsSync(join(dir, PUSH_RELAY_FILE))).toBe(false);
  });
  test("first send registers once, keeps the credential in a 0600 file, then reuses it (also after a restart)", async () => {
    const relay = fakeRelay();
    const dir = home();
    const { client } = relayClient(dir, relay.url);
    expect(await client.send(notification())).toEqual({ state: "accepted", reason: "accepted", status: 200 });
    expect(await client.send(notification("todo_created"))).toMatchObject({ state: "accepted" });
    expect(relay.registrations()).toHaveLength(1);
    expect(JSON.parse(relay.registrations()[0]!.body)).toEqual({ protocol: 1 });
    expect(relay.registrations()[0]!.authorization).toBeNull();
    const file = join(dir, PUSH_RELAY_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(saved).sort()).toEqual(["createdAt", "installationId", "relay", "secret", "v"]);
    expect(saved.relay).toBe(relay.url);
    expect(relay.pushes().every((p) => p.authorization === `Bearer ${saved.installationId}.${saved.secret}`)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const again = relayClient(dir, relay.url).client;
    expect((await again.send(notification())).state).toBe("accepted");
    expect(relay.registrations()).toHaveLength(1);
  });
  test("the body carries no text: fixed sentences and the app payload are built by the relay from these fields", async () => {
    const relay = fakeRelay();
    const dir = home();
    const { client } = relayClient(dir, relay.url);
    for (const kind of ["decision", "approval_wait", "error", "report_complete", "todo_created", "report_blocked", "test"] as const) {
      const n = notification(kind);
      expect((await client.send(n)).state).toBe("accepted");
      const body = JSON.parse(relay.pushes().at(-1)!.body);
      const payload = buildAPNsPayload(n);
      expect(body).toEqual({ token: TOKEN.toLowerCase(), kind, id: n.deliveryId, eventId: n.eventId, serverId: n.serverId,
        target: payload.iamceo.target, expiresAt: n.expiresAt, ...(kind === "report_complete" ? { summary: true } : {}) });
      expect(relay.pushes().at(-1)!.body).not.toMatch(/aps|alert|title|도착|확인/);
    }
    // 허용 목록 밖의 값은 실리지 않는다(target 은 다시 만든 것).
    const n = notification("decision");
    (n.target as Record<string, unknown>).secretNote = "CANARY-NOT-SENT";
    expect(JSON.stringify(relayPushBody(n))).not.toContain("CANARY");
  });
  test("a credential issued by another relay address is not sent to this one", async () => {
    const first = fakeRelay(), second = fakeRelay();
    const dir = home();
    expect((await relayClient(dir, first.url).client.send(notification())).state).toBe("accepted");
    expect(readPushRelayCredential(dir, second.url)).toBeNull();
    expect((await relayClient(dir, second.url).client.send(notification())).state).toBe("accepted");
    expect(second.registrations()).toHaveLength(1);
    expect(second.pushes()[0]!.authorization).not.toBe(first.pushes()[0]!.authorization);
  });
  test("a credential file others can read, or a link, is ignored and replaced", async () => {
    const relay = fakeRelay();
    const dir = home();
    expect((await relayClient(dir, relay.url).client.send(notification())).state).toBe("accepted");
    chmodSync(join(dir, PUSH_RELAY_FILE), 0o644);
    expect(readPushRelayCredential(dir, relay.url)).toBeNull();
    expect((await relayClient(dir, relay.url).client.send(notification())).state).toBe("accepted");
    expect(relay.registrations()).toHaveLength(2);
    expect(statSync(join(dir, PUSH_RELAY_FILE)).mode & 0o777).toBe(0o600);
    const other = home();
    writeFileSync(join(other, "target.json"), readFileSync(join(dir, PUSH_RELAY_FILE)), { mode: 0o600 });
    symlinkSync(join(other, "target.json"), join(other, PUSH_RELAY_FILE));
    expect(readPushRelayCredential(other, relay.url)).toBeNull();
  });
  test("an unknown installation (401) registers again once and sends; a fresh credential refused again holds 10 minutes", async () => {
    const relay = fakeRelay();
    const dir = home();
    let now = T0;
    const { client, logs } = relayClient(dir, relay.url, { now: () => now });
    expect((await client.send(notification("test", now))).state).toBe("accepted");
    relay.issued.clear(); // 중계가 비밀을 바꿨다.
    expect((await client.send(notification("test", now))).state).toBe("accepted");
    expect(relay.registrations()).toHaveLength(2);
    relay.state.reply = (entry, issued) => entry.path === "/v1/push" ? Response.json({}, { status: 401 }) : defaultReply(entry, issued);
    const refused = await client.send(notification("test", now));
    // retryAt 없는 unavailable 은 작업기가 서버를 다시 켤 때까지 멈춘다. 늘 시각을 붙인다.
    expect(refused).toEqual({ state: "unavailable", reason: "auth_failed", status: 401, retryAt: now + 600_000 });
    // 저장한 자격이 거절됨 → 한 번 다시 등록 → 방금 받은 자격도 거절됨 → 더 등록하지 않고 쉰다.
    expect(relay.registrations()).toHaveLength(3);
    expect(client.status()).toMatchObject({ state: "temporarily_unavailable", lastError: "auth_failed", via: "relay" });
    const before = relay.seen.length;
    expect(await client.send(notification("test", now))).toEqual(refused);
    expect(relay.seen.length).toBe(before);
    expect(logs).toHaveLength(1);
    now += 600_001;
    expect(client.status()).toMatchObject({ state: "ready", lastError: null });
    relay.state.reply = undefined;
    expect((await client.send(notification("test", now))).state).toBe("accepted");
  });
});

describe("relay answers", () => {
  async function answer(reply: (entry: Seen, issued: Map<string, string>) => Response, n = notification()) {
    const relay = fakeRelay((entry, issued) => entry.path === "/v1/push" ? reply(entry, issued) : defaultReply(entry, issued));
    const dir = home();
    const { client, logs } = relayClient(dir, relay.url);
    return { result: await client.send(n), client, relay, logs };
  }
  test("410: the token is gone (Unregistered, BadDeviceToken) and the worker removes it", async () => {
    expect((await answer(() => Response.json({ reason: "BadDeviceToken", timestamp: T0 - 5 }, { status: 410 }))).result)
      .toEqual({ state: "invalid", reason: "BadDeviceToken", status: 410, invalidatedAt: T0 - 5 });
    expect((await answer(() => new Response(null, { status: 410 }))).result).toEqual({ state: "invalid", reason: "Unregistered", status: 410 });
    expect((await answer(() => Response.json({ reason: "<script>", timestamp: "x" }, { status: 410 }))).result).toEqual({ state: "invalid", reason: "Unregistered", status: 410 });
  });
  test("429: this Mac's limit holds production sending until Retry-After; one iPhone's limit delays only that notification", async () => {
    const mac = await answer(() => new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    expect(mac.result).toEqual({ state: "unavailable", reason: "TooManyRequests", status: 429, retryAt: T0 + 120_000 });
    expect(mac.client.status()).toMatchObject({ state: "temporarily_unavailable", lastError: "network_error" });
    const missing = await answer(() => new Response(null, { status: 429 }));
    expect(missing.result).toMatchObject({ state: "unavailable", retryAt: T0 + 60_000 });
    const huge = await answer(() => new Response(null, { status: 429, headers: { "retry-after": "999999999" } }));
    expect((huge.result as { retryAt: number }).retryAt).toBe(T0 + 24 * 3_600_000);
    const token = await answer(() => Response.json({ scope: "token" }, { status: 429, headers: { "retry-after": "30" } }));
    expect(token.result).toEqual({ state: "retry", reason: "TooManyRequests", status: 429, retryAt: T0 + 30_000 });
    expect(token.client.status().state).toBe("ready");
  });
  test("503 and other relay failures retry; a gateway timeout is unknown and never resent", async () => {
    expect((await answer(() => new Response(null, { status: 503 }))).result).toEqual({ state: "retry", reason: "server_error", status: 503 });
    expect((await answer(() => new Response(null, { status: 503, headers: { "retry-after": "5" } }))).result)
      .toEqual({ state: "retry", reason: "server_error", status: 503, retryAt: T0 + 5_000 });
    expect((await answer(() => new Response(null, { status: 500 }))).result).toMatchObject({ state: "retry", reason: "server_error" });
    expect((await answer(() => new Response(null, { status: 504 }))).result).toEqual({ state: "unknown", reason: "timeout", status: 504 });
  });
  test("the whole relay stopped (switched off, or resting after an APNs key problem): hold production sending until Retry-After", async () => {
    const off = await answer(() => Response.json({ reason: "relay_off" }, { status: 503, headers: { "retry-after": "3600" } }));
    expect(off.result).toEqual({ state: "unavailable", reason: "server_error", status: 503, retryAt: T0 + 3_600_000 });
    expect(off.client.status()).toMatchObject({ state: "temporarily_unavailable", lastError: "network_error" });
    const resting = await answer(() => Response.json({ reason: "relay_unavailable" }, { status: 503 }));
    expect(resting.result).toEqual({ state: "unavailable", reason: "server_error", status: 503, retryAt: T0 + 600_000 });
    // 바쁨(잠깐)과 APNs 의 일시 오류는 그 알림만 다시 시도한다.
    expect((await answer(() => Response.json({ reason: "relay_busy" }, { status: 503, headers: { "retry-after": "5" } }))).result)
      .toEqual({ state: "retry", reason: "server_error", status: 503, retryAt: T0 + 5_000 });
    expect((await answer(() => Response.json({ state: "failed", reason: "permanent_rejection" }, { status: 400 }))).result)
      .toEqual({ state: "failed", reason: "permanent_rejection", status: 400 });
  });
  test("400 fails that notification; 403, 404 and redirects hold with a retry time (never followed, never forever)", async () => {
    expect((await answer(() => new Response(null, { status: 400 }))).result).toEqual({ state: "failed", reason: "invalid_payload", status: 400 });
    expect((await answer(() => new Response(null, { status: 403 }))).result).toEqual({ state: "unavailable", reason: "auth_failed", status: 403, retryAt: T0 + 600_000 });
    expect((await answer(() => new Response("no", { status: 404 }))).result).toEqual({ state: "unavailable", reason: "invalid_response", status: 404, retryAt: T0 + 600_000 });
    let followed = false;
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { followed = true; return new Response("ok"); } });
    cleanups.push(() => target.stop(true));
    const redirect = await answer(() => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${target.port}/v1/push` } }));
    expect(redirect.result).toMatchObject({ state: "unavailable", reason: "invalid_response", status: 307 });
    expect(followed).toBe(false);
    const status = redirect.client.status();
    expect(status.state).toBe("temporarily_unavailable");
    // 출시된 앱은 configuration_error 를 "키 경로와 파일 권한을 확인"으로 안내한다. 중계 거절은 그렇게 알리지 않는다.
    expect(status.state).not.toBe("configuration_error");
  });
  test("a notification the relay finds expired ends without touching the device registration", async () => {
    expect((await answer(() => Response.json({ state: "failed", reason: "expired" }, { status: 400 }))).result).toEqual({ state: "expired", reason: "expired", status: 400 });
    expect((await answer(() => Response.json({ error: "expired" }, { status: 400 }))).result).toEqual({ state: "expired", reason: "expired", status: 400 });
    expect((await answer(() => Response.json({ error: "expired" }, { status: 410 }))).result).toEqual({ state: "expired", reason: "expired", status: 410 });
  });
  test("an oversized or broken response body does not break classification", async () => {
    expect((await answer(() => new Response("x".repeat(100_000), { status: 200 }))).result.state).toBe("accepted");
    expect((await answer(() => new Response("{not json", { status: 410 }))).result).toEqual({ state: "invalid", reason: "Unregistered", status: 410 });
  });
  test("cannot connect: retry (it was not sent) and the status says the notification server is unreachable", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const url = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    const dir = home();
    const { client } = relayClient(dir, url);
    expect(await client.send(notification())).toEqual({ state: "retry", reason: "network_error" });
    expect(client.status()).toMatchObject({ state: "temporarily_unavailable", lastError: "network_error" });
    expect(existsSync(join(dir, PUSH_RELAY_FILE))).toBe(false);
  });
  test("no answer in time: unknown (never resent), within the worker's 10 second guard", async () => {
    const relay = fakeRelay(async (entry, issued) => {
      if (entry.path === "/v1/push") await Bun.sleep(500);
      return defaultReply(entry, issued);
    });
    const dir = home();
    const { client } = relayClient(dir, relay.url, { timeoutMs: 150 });
    const started = performance.now();
    expect(await client.send(notification("test", Date.now()))).toEqual({ state: "unknown", reason: "timeout" });
    expect(performance.now() - started).toBeLessThan(450);
    expect(new RelayClient({ home: dir, url: relay.url, timeoutMs: 60_000 })).toBeDefined();
  });
  test("registration failures: limit holds with Retry-After; server errors retry; nothing is saved", async () => {
    const limited = fakeRelay((entry) => new Response(null, { status: 429, headers: { "retry-after": "3600" } }));
    const dir = home();
    const { client } = relayClient(dir, limited.url);
    expect(await client.send(notification())).toEqual({ state: "unavailable", reason: "TooManyRequests", status: 429, retryAt: T0 + 3_600_000 });
    expect(limited.pushes()).toHaveLength(0);
    const broken = fakeRelay((entry) => entry.path === "/v1/installations" ? Response.json({ installationId: "has.dot.in.it", secret: "short" }, { status: 201 }) : new Response(null, { status: 500 }));
    const dir2 = home();
    expect(await relayClient(dir2, broken.url).client.send(notification())).toMatchObject({ state: "unavailable", reason: "invalid_response", retryAt: T0 + 600_000 });
    expect(existsSync(join(dir2, PUSH_RELAY_FILE))).toBe(false);
    const down = fakeRelay(() => new Response(null, { status: 502 }));
    expect(await relayClient(home(), down.url).client.send(notification())).toMatchObject({ state: "retry", reason: "server_error", status: 502 });
  });
  test("bad notifications stop here, before any request", async () => {
    const relay = fakeRelay();
    const { client } = relayClient(home(), relay.url);
    const expired = notification("test", T0 - 400_000);
    expect(await client.send(expired)).toEqual({ state: "expired", reason: "expired" });
    const long = notification(); long.expiresAt = new Date(T0 + 7_200_000).toISOString();
    expect(await client.send(long)).toEqual({ state: "failed", reason: "invalid_expiration" });
    const token = notification(); token.deviceToken = "zz";
    expect(await client.send(token)).toEqual({ state: "failed", reason: "invalid_payload" });
    const target = notification("decision"); target.target = { screen: "home" };
    expect(await client.send(target)).toEqual({ state: "failed", reason: "invalid_payload" });
    expect(await client.send(notification("test", T0, "sandbox"))).toMatchObject({ state: "unavailable", reason: "unconfigured" });
    expect(relay.seen).toHaveLength(0);
  });
  test("tokens, secrets and the Authorization header never reach the log", async () => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const name of ["log", "warn", "error", "info"] as const) console[name] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      const relay = fakeRelay();
      const dir = home();
      let now = T0;
      const client = new RelayClient({ home: dir, url: relay.url, now: () => now });
      cleanups.push(() => client.close());
      await client.send(notification());
      const first = JSON.parse(readFileSync(join(dir, PUSH_RELAY_FILE), "utf8")) as { installationId: string; secret: string };
      relay.state.reply = (entry, issued) => entry.path === "/v1/push" ? new Response(null, { status: 429 }) : defaultReply(entry, issued);
      await client.send(notification());
      relay.state.reply = () => Response.json({}, { status: 401 });
      relay.issued.clear();
      now = T0 + 61_000;
      await client.send(notification("test", now));
      const text = lines.join("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const value of [TOKEN, TOKEN.toLowerCase(), "Bearer", first.secret, first.installationId]) expect(text).not.toContain(value);
    } finally { Object.assign(console, original); }
  });
});

/** 이 Mac 에서만 믿는 자체 서명 인증서(127.0.0.1). 실제 중계에는 쓰지 않는다. */
function selfSigned(): { key: string; cert: string } {
  const dir = home();
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(join(dir, "tls.key"), key, { mode: 0o600 });
  writeFileSync(join(dir, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n" +
    "[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n");
  const made = spawnSync("/usr/bin/openssl", ["req", "-new", "-x509", "-key", "tls.key", "-days", "1", "-out", "tls.crt", "-config", "openssl.cnf"], { cwd: dir, stdio: "pipe" });
  if (made.status !== 0) throw new Error("openssl failed");
  return { key, cert: readFileSync(join(dir, "tls.crt"), "utf8") };
}

/** 소켓을 받기만 하는 서버. onSocket 이 무엇을 할지 정한다(아무것도 안 함 = 패킷이 사라지는 연결 흉내). */
async function rawServer(onSocket: (socket: net.Socket) => void): Promise<{ port: number; sockets: net.Socket[] }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => { sockets.push(socket); socket.on("error", () => {}); onSocket(socket); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return { port: (server.address() as net.AddressInfo).port, sockets };
}

function storedCredential(dir: string, url: string) {
  writePushRelayCredential(dir, { v: 1, relay: normalizePushRelayUrl(url), installationId: randomUUID(),
    secret: randomBytes(32).toString("base64url"), createdAt: new Date(T0).toISOString() });
}

describe("whether the request left this Mac (a timeout before the connection is up is resent)", () => {
  test("https: registers and sends over TLS, and a certificate the system does not trust is never sent to", async () => {
    const { key, cert } = selfSigned();
    const seen: string[] = [];
    const issued = new Map<string, string>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key, cert }, async fetch(req) {
      const url = new URL(req.url);
      const entry = { path: url.pathname, method: req.method, authorization: req.headers.get("authorization"), body: await req.text() };
      seen.push(entry.path);
      return defaultReply(entry, issued);
    } });
    cleanups.push(() => server.stop(true));
    const url = `https://127.0.0.1:${server.port}`;
    expect(await relayClient(home(), url, { tlsCa: cert }).client.send(notification())).toEqual({ state: "accepted", reason: "accepted", status: 200 });
    expect(seen).toEqual(["/v1/installations", "/v1/push"]);
    const untrusted = home();
    storedCredential(untrusted, url);
    expect(await relayClient(untrusted, url).client.send(notification())).toEqual({ state: "retry", reason: "network_error" });
    expect(seen).toHaveLength(2);
  });
  test("the TLS connection never comes up (Wi-Fi up, internet gone): retry, not unknown, with or without a stored installation", async () => {
    const silent = await rawServer(() => { /* 아무것도 답하지 않는다 */ });
    const url = `https://127.0.0.1:${silent.port}`;
    const dir = home();
    storedCredential(dir, url);
    const { client } = relayClient(dir, url, { timeoutMs: 200 });
    const started = performance.now();
    expect(await client.send(notification())).toEqual({ state: "retry", reason: "timeout" });
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(client.status()).toMatchObject({ state: "temporarily_unavailable", lastError: "network_error" });
    // 저장한 자격이 없으면 등록부터: 그것도 보내지 않은 것이다.
    expect(await relayClient(home(), url, { timeoutMs: 200 }).client.send(notification())).toEqual({ state: "retry", reason: "timeout" });
    expect(silent.sockets.length).toBe(2);
  });
  test("reset before the TLS handshake finishes: retry", async () => {
    const reset = await rawServer((socket) => socket.destroy());
    const url = `https://127.0.0.1:${reset.port}`;
    const dir = home();
    storedCredential(dir, url);
    expect(await relayClient(dir, url).client.send(notification())).toEqual({ state: "retry", reason: "network_error" });
  });
  test("the request went out and then nothing came back, or the connection dropped: unknown (never resent)", async () => {
    const { key, cert } = selfSigned();
    const sockets: tls.TLSSocket[] = [];
    const quiet = tls.createServer({ key, cert }, (socket) => { sockets.push(socket); socket.on("error", () => {}); socket.on("data", () => {}); });
    await new Promise<void>((resolve) => quiet.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); quiet.close(() => resolve()); }));
    const url = `https://127.0.0.1:${(quiet.address() as net.AddressInfo).port}`;
    const dir = home();
    storedCredential(dir, url);
    expect(await relayClient(dir, url, { timeoutMs: 300, tlsCa: cert }).client.send(notification())).toEqual({ state: "unknown", reason: "timeout" });
    const dropped = await rawServer((socket) => {
      let head = "";
      socket.on("data", (chunk) => { head += chunk.toString("latin1"); if (head.includes("\r\n\r\n")) socket.destroy(); });
    });
    const plain = `http://127.0.0.1:${dropped.port}`;
    const other = home();
    storedCredential(other, plain);
    expect(await relayClient(other, plain).client.send(notification())).toEqual({ state: "unknown", reason: "network_error" });
  });
  test("HTTP/1.1 answers in pieces, chunked, or after 100 Continue are read the same way", async () => {
    const id = randomUUID(), secret = randomBytes(32).toString("base64url");
    const answers: string[] = [];
    const server = await rawServer((socket) => {
      let head = "";
      socket.on("data", (chunk) => {
        head += chunk.toString("latin1");
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
        if (head.length < end + 4 + length) return;
        answers.push(head.split(" ")[1]!);
        if (/^POST \S*\/v1\/installations HTTP\/1\.1\r\n/.test(head)) {
          const body = JSON.stringify({ installationId: id, secret });
          const pieces = [body.slice(0, 7), body.slice(7)];
          socket.write("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n");
          setTimeout(() => socket.end(pieces.map((piece) => `${piece.length.toString(16)}\r\n${piece}\r\n`).join("") + "0\r\n\r\n"), 20);
        } else {
          const body = JSON.stringify({ state: "invalid", reason: "BadDeviceToken", timestamp: 1_790_000_000_000 });
          socket.write(`HTTP/1.1 410 Gone\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 5)}`);
          setTimeout(() => socket.end(body.slice(5)), 20);
        }
      });
    });
    const url = `http://127.0.0.1:${server.port}`;
    expect(await relayClient(home(), url).client.send(notification())).toEqual({ state: "invalid", reason: "BadDeviceToken", status: 410, invalidatedAt: 1_790_000_000_000 });
    expect(answers).toEqual(["/v1/installations", "/v1/push"]);
    // 주소에 경로가 있으면(cloudfunctions.net/relay) 그 뒤에 붙인다.
    answers.length = 0;
    expect((await relayClient(home(), `${url}/relay`).client.send(notification())).state).toBe("invalid");
    expect(answers).toEqual(["/relay/v1/installations", "/relay/v1/push"]);
  });
  test("worker: a notification whose connection never came up goes out on a later try instead of being lost", async () => {
    const { key, cert } = selfSigned();
    const issued = new Map<string, string>();
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key, cert }, async fetch(req) {
      const url = new URL(req.url);
      return defaultReply({ path: url.pathname, method: req.method, authorization: req.headers.get("authorization"), body: await req.text() }, issued);
    } });
    cleanups.push(() => upstream.stop(true));
    // 처음 연결 하나는 삼킨다(바깥이 끊긴 순간). 그 뒤 연결은 진짜 중계로 잇는다.
    let swallowed = 0;
    const front = await rawServer((socket) => {
      if (swallowed++ === 0) return;
      const up = net.connect(upstream.port!, "127.0.0.1");
      up.on("error", () => socket.destroy());
      socket.pipe(up); up.pipe(socket);
      cleanups.push(() => { up.destroy(); });
    });
    const dir = home();
    const db = openDb(join(dir, "push.db"));
    cleanups.push(() => db.close());
    let now = Date.now();
    const router = createPushClient({ home: dir, relayUrl: `https://127.0.0.1:${front.port}`, relayOptions: { now: () => now, log: () => {}, timeoutMs: 300, tlsCa: cert } });
    const push = new PushStore(db, { now: () => now, providers: () => router.status() });
    const worker = new PushWorker(push, router, { now: () => now, random: () => 0.5 });
    cleanups.push(() => worker.shutdown());
    const registered = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID,
      environment: "production", deviceToken: TOKEN, authorization: "authorized" });
    const d = push.patchDevice(registered.id, { expectedRevision: registered.revision, enabled: true });
    const event = push.recordEvent({ sourceKey: `test:${d.id}:${randomUUID()}`, kind: "test", projectId: null, memberId: null, target: { screen: "home" },
      occurredAt: push.timestamp() }, [{ deviceId: d.id, registrationGeneration: push.getRegistration(d.id)!.registrationGeneration }]);
    await worker.tick();
    expect(push.listDeliveries(event.id)[0]).toMatchObject({ state: "retry", lastReason: "timeout" });
    now += 30_000;
    await worker.tick();
    expect(push.listDeliveries(event.id)[0]).toMatchObject({ state: "accepted" });
  });
});

describe("worker and routes with the relay", () => {
  function setup(reply?: Reply) {
    const relay = fakeRelay(reply);
    const dir = home();
    const db = openDb(join(dir, "push.db"));
    cleanups.push(() => db.close());
    let now = Date.now();
    const router = createPushClient({ home: dir, relayUrl: relay.url, relayOptions: { now: () => now, log: () => {} } });
    const push = new PushStore(db, { now: () => now, providers: () => router.status() });
    const worker = new PushWorker(push, router, { now: () => now, random: () => 0.5 });
    cleanups.push(() => worker.shutdown());
    return { relay, dir, push, worker, router, advance: (ms: number) => { now += ms; }, now: () => now };
  }
  function device(push: PushStore) {
    const value = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID,
      environment: "production", deviceToken: TOKEN, authorization: "authorized" });
    // 키 없는 Mac 에서 App Store(production) 기기를 켜는 것이 409 없이 된다.
    return push.patchDevice(value.id, { expectedRevision: value.revision, enabled: true });
  }
  function testEvent(push: PushStore, id: string) {
    return push.recordEvent({ sourceKey: `test:${id}:${randomUUID()}`, kind: "test", projectId: null, memberId: null, target: { screen: "home" }, occurredAt: push.timestamp() },
      [{ deviceId: id, registrationGeneration: push.getRegistration(id)!.registrationGeneration }]);
  }
  test("an App Store iPhone on a Mac without a key: enable, deliver through the relay, status via relay", async () => {
    const f = setup();
    const handler = createPushHandler({ store: f.push, providers: () => f.router.status() });
    const status = await (await handler(new Request("http://127.0.0.1/api/push/status"), new URL("http://127.0.0.1/api/push/status"))).json();
    expect(status.providers[1]).toEqual({ environment: "production", bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready", lastError: null, via: "relay" });
    expect(status.providers[0]).toEqual({ environment: "sandbox", bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "unconfigured", lastError: null });
    const d = device(f.push);
    expect(d.enabled).toBe(true);
    const event = testEvent(f.push, d.id);
    await f.worker.tick();
    expect(f.push.listDeliveries(event.id)[0]).toMatchObject({ state: "accepted", lastReason: "accepted" });
    expect(f.relay.pushes()).toHaveLength(1);
  });
  test("410 from the relay removes the token (device invalid) and nothing more goes to that iPhone", async () => {
    const f = setup((entry, issued) => entry.path === "/v1/push" ? Response.json({ reason: "Unregistered" }, { status: 410 }) : defaultReply(entry, issued));
    const d = device(f.push);
    const event = testEvent(f.push, d.id);
    await f.worker.tick();
    expect(f.push.listDeliveries(event.id)[0]!.state).toBe("invalid");
    const registration = f.push.getRegistration(d.id)!;
    expect(registration.device.state).toBe("invalid");
    expect(registration.deviceToken).toBeNull();
    expect(registration.device.lastFailure).toBe("token_invalid");
  });
  test("relay refusal holds for a while, then the same notification goes out (no restart needed)", async () => {
    let refuse = true;
    const f = setup((entry, issued) => entry.path === "/v1/push" && refuse ? new Response(null, { status: 429, headers: { "retry-after": "30" } }) : defaultReply(entry, issued));
    const d = device(f.push);
    const event = testEvent(f.push, d.id);
    await f.worker.tick();
    expect(f.push.listDeliveries(event.id)[0]).toMatchObject({ state: "retry", attempts: 0, lastReason: "TooManyRequests" });
    const pushes = f.relay.pushes().length;
    await f.worker.tick();
    expect(f.relay.pushes().length).toBe(pushes);
    refuse = false;
    f.advance(31_000);
    await f.worker.tick();
    expect(f.push.listDeliveries(event.id)[0]).toMatchObject({ state: "accepted" });
  });
});

describe("diagnostics", () => {
  test("summary has no installation ID or secret; the secret is masked if it ever reaches a log", async () => {
    const relay = fakeRelay();
    const dir = home();
    expect((await relayClient(dir, relay.url).client.send(notification())).state).toBe("accepted");
    const saved = JSON.parse(readFileSync(join(dir, PUSH_RELAY_FILE), "utf8"));
    const summary = pushRelaySummary(dir);
    expect(summary).toEqual({ file: true, relay: new URL(relay.url).host, createdAt: saved.createdAt });
    expect(JSON.stringify(summary)).not.toContain(saved.secret);
    expect(JSON.stringify(summary)).not.toContain(saved.installationId);
    expect(pushRelaySecrets(dir)).toEqual([saved.secret]);
    expect(pushRelaySummary(home())).toEqual({ file: false, relay: null, createdAt: null });
  });
  test("a diagnostic file made on a relay Mac has the summary, never the installation secret", async () => {
    const relay = fakeRelay();
    const dir = home();
    expect((await relayClient(dir, relay.url).client.send(notification())).state).toBe("accepted");
    const saved = JSON.parse(readFileSync(join(dir, PUSH_RELAY_FILE), "utf8"));
    const logs = join(dir, "logs");
    require("node:fs").mkdirSync(logs, { mode: 0o700 });
    writeFileSync(join(logs, "server.log"), `2026-11-13T00:00:00.000Z [startup] ready\n잘못 찍힌 줄 ${saved.secret}\n`);
    const result = await createDiagnostics({ home: dir, dbPath: join(dir, "none.db"), config: null, db: null, source: "cli",
      versions: { server: "test" }, doctor: null, service: async () => null, logDir: logs, crashReportsDir: null });
    const folder = result.path.replace(/\.zip$/, "");
    const texts = readdirSync(folder, { recursive: true }).map(String).filter((name) => name.endsWith(".txt") || name.endsWith(".json"))
      .map((name) => readFileSync(join(folder, name), "utf8"));
    const all = texts.join("\n") + readFileSync(result.path).toString("latin1");
    expect(all).not.toContain(saved.secret);
    const summary = JSON.parse(readFileSync(join(folder, "summary.json"), "utf8"));
    expect(summary.pushRelay).toEqual({ setting: "auto", customUrl: false, file: true, relay: new URL(relay.url).host, createdAt: saved.createdAt });
  });
});
