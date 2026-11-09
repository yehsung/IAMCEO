import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { connect, constants, createSecureServer } from "node:http2";
import type { ServerHttp2Session, ServerHttp2Stream, IncomingHttpHeaders } from "node:http2";
import { createServer as createTLSServer } from "node:tls";
import type { TLSSocket } from "node:tls";
import type { Server } from "node:net";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ClientHttp2Session } from "node:http2";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";
import type { PushKind } from "../shared/push.ts";
import { loadAPNsConfig } from "../server/push/config.ts";
import type { APNsConfig } from "../server/push/config.ts";
import { APNS_ORIGINS, APNS_TTL_MS, APNsClient, APNsTokenCache, HTTP2APNsTransport,
  buildAPNsPayload, classifyAPNsResponse, serializeAPNsPayload } from "../server/push/apns.ts";
import type { APNsNotification, APNsTransport, APNsTransportRequest, APNsTransportResult } from "../server/push/apns.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  const runtime = createIsolatedRuntime();
  cleanups.push(() => runtime.stop());
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const path = join(runtime.paths.configDir, "test.p8");
  writeFileSync(path, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const entry = { keyId: "TESTKEY123", teamId: "TEAMID1234", bundleId: DEFAULT_PUSH_BUNDLE_ID, privateKeyPath: path };
  const configPath = join(runtime.paths.iamceoHome, "apns.json");
  function save(value: unknown = { sandbox: entry, production: entry }) {
    writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
    return loadAPNsConfig(runtime.paths.iamceoHome);
  }
  const config = save();
  return { runtime, keys, path, entry, configPath, config, save, credential: config.credentials.sandbox! };
}

function notification(kind: PushKind | "test" = "decision", now = 1_800_000_000_000): APNsNotification {
  return { environment: "sandbox", deviceToken: "AA0123", deliveryId: randomUUID(), eventId: randomUUID(), serverId: randomUUID(), kind,
    occurredAt: new Date(now).toISOString(), expiresAt: new Date(now + APNS_TTL_MS[kind]).toISOString(),
    target: kind === "test" ? { screen: "home" } : kind === "report_complete" ? { screen: "chat", projectId: "p_1", memberId: null, messageId: "msg_1", groupId: randomUUID() }
      : kind === "decision" ? { screen: "inbox", projectId: "p_1", decisionId: "d_1" } : { screen: "team", projectId: "p_1", memberId: "m_1" } };
}

function response(status = 200, reason?: string, headers: IncomingHttpHeaders = {}, timestamp?: number): APNsTransportResult & { type: "response" } {
  return { type: "response", status, headers, body: reason ? JSON.stringify({ reason, timestamp }) : "" };
}
class FakeTransport implements APNsTransport {
  requests: APNsTransportRequest[] = [];
  closed = false;
  constructor(readonly handler: (request: APNsTransportRequest, index: number) => APNsTransportResult | Promise<APNsTransportResult> = () => response()) {}
  async send(request: APNsTransportRequest) { this.requests.push(request); return this.handler(request, this.requests.length - 1); }
  close() { this.closed = true; }
}
function client(config: APNsConfig, transport: APNsTransport, now: () => number = () => 1_800_000_000_000, timeoutMs?: number) {
  const result = new APNsClient(config, { transport, now, timeoutMs });
  cleanups.push(() => result.close());
  return result;
}

describe("dedicated APNs config", () => {
  test("explicit temporary home, missing file disabled, valid environments and safe status", () => {
    const f = fixture();
    expect(loadAPNsConfig(f.runtime.paths.home).providers.every((p) => p.state === "unconfigured")).toBe(true);
    expect(f.config.providers.every((p) => p.state === "ready")).toBe(true);
    expect(f.config.credentials.sandbox!.cacheKey).not.toBe(f.config.credentials.production!.cacheKey);
    expect(f.config.providers[0].bundleId).toBe("com.yehsung.iamceo");
    const status = JSON.stringify(f.config.providers);
    for (const secret of [f.entry.keyId, f.entry.teamId, f.path, "PRIVATE KEY"]) expect(status).not.toContain(secret);
    expect(f.save({ sandbox: f.entry }).providers[1].state).toBe("unconfigured");
  });
  test("malformed and insecure config never throw or enable providers", () => {
    const f = fixture();
    for (const value of [null, [], "canary", { sandbox: { ...f.entry, host: "https://canary.invalid" } }, { origin: "https://canary.invalid" }]) {
      expect(Object.keys(f.save(value).credentials)).toHaveLength(0);
    }
    writeFileSync(f.configPath, "{canary");
    expect(loadAPNsConfig(f.runtime.paths.iamceoHome).providers[0].lastError).toBe("invalid_key");
    f.save(); chmodSync(f.configPath, 0o640);
    expect(loadAPNsConfig(f.runtime.paths.iamceoHome).providers.every((p) => p.lastError === "key_unreadable")).toBe(true);
    expect(loadAPNsConfig("relative").providers[0].state).toBe("configuration_error");
  });
  test("validates IDs, explicit topic and absolute paths independently by environment", () => {
    const f = fixture();
    for (const patch of [{ keyId: "lowercase1" }, { teamId: "short" }, { bundleId: "com.*" }, { bundleId: "single" }, { privateKeyPath: "relative.p8" }]) {
      const config = f.save({ sandbox: { ...f.entry, ...patch }, production: f.entry });
      expect(config.credentials.sandbox).toBeUndefined();
      expect(config.providers[0].lastError).toBe("invalid_key");
      expect(config.providers[1].state).toBe("ready");
    }
  });
  test("rejects p8 permissions, nonfiles, symlinks and open secret directory", () => {
    const f = fixture();
    chmodSync(f.path, 0o644);
    expect(f.save().providers[0].lastError).toBe("key_unreadable");
    chmodSync(f.path, 0o600); chmodSync(f.runtime.paths.configDir, 0o750);
    expect(f.save().providers[0].lastError).toBe("key_unreadable");
    chmodSync(f.runtime.paths.configDir, 0o700);
    const link = join(f.runtime.paths.configDir, "link.p8"); symlinkSync(f.path, link);
    expect(f.save({ sandbox: { ...f.entry, privateKeyPath: link } }).providers[0].lastError).toBe("key_unreadable");
    expect(f.save({ sandbox: { ...f.entry, privateKeyPath: f.runtime.paths.configDir } }).providers[0].lastError).toBe("key_unreadable");
    const linkHome = join(f.runtime.dir, "symlink-config"); mkdirSync(linkHome, { mode: 0o700 });
    symlinkSync(f.configPath, join(linkHome, "apns.json"));
    expect(loadAPNsConfig(linkHome).providers[0].lastError).toBe("key_unreadable");
  });
  test("requires PEM PKCS8 P-256 private key", () => {
    const f = fixture();
    const other = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey;
    for (const value of ["canary private key", f.keys.publicKey.export({ format: "pem", type: "spki" }),
      f.keys.privateKey.export({ format: "pem", type: "sec1" }), other.export({ format: "pem", type: "pkcs8" })]) {
      writeFileSync(f.path, value);
      expect(f.save().providers[0].lastError).toBe("invalid_key");
    }
  });
});

describe("JWT cache", () => {
  test("ES256 JOSE signature verifies as 64-byte P1363, with seconds and unpadded base64url", () => {
    const f = fixture();
    const token = new APNsTokenCache(f.credential, () => 1_800_000_000_987).get();
    const [header, claims, signature] = token.split(".");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: f.entry.keyId });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: f.entry.teamId, iat: 1_800_000_000 });
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key: f.keys.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
  });
  test("20-minute rejection refresh, 50-minute normal refresh, never sends 60-minute token", async () => {
    const f = fixture(); let now = 1_800_000_000_000;
    const cache = new APNsTokenCache(f.credential, () => now);
    const first = cache.get();
    now += 20 * 60_000 - 1;
    expect(cache.refreshExpired(first)).toBe(false); expect(cache.get()).toBe(first);
    now++;
    expect(cache.refreshExpired(first)).toBe(true);
    const second = cache.get(); expect(second).not.toBe(first);
    expect(cache.refreshExpired(first)).toBe(true); expect(cache.get()).toBe(second);
    now += 50 * 60_000 - 1; expect(cache.get()).toBe(second);
    now++;
    const refreshed = await Promise.all(Array.from({ length: 20 }, async () => cache.get()));
    expect(new Set(refreshed).size).toBe(1); expect(refreshed[0]).not.toBe(second);
    now += 60 * 60_000;
    expect(JSON.parse(Buffer.from(cache.get().split(".")[1], "base64url").toString()).iat).toBe(now / 1000);
  });
  test("backward clock fails closed until original clock catches up", () => {
    const f = fixture(); let now = 1_800_000_000_000;
    const cache = new APNsTokenCache(f.credential, () => now); const token = cache.get();
    now -= 120_000; expect(() => cache.get()).toThrow("clock_rollback");
    now += 120_000; expect(cache.get()).toBe(token);
    now += 600_000; cache.get(); now -= 60_001;
    expect(() => cache.get()).toThrow("clock_rollback");
  });
  test("environment, topic, team, key ID and public key separate cache identities", () => {
    const f = fixture(); const original = f.credential.cacheKey;
    for (const patch of [{ bundleId: "com.example.other" }, { teamId: "OTHERTEAM1" }, { keyId: "OTHERKEY12" }]) {
      expect(f.save({ sandbox: { ...f.entry, ...patch } }).credentials.sandbox!.cacheKey).not.toBe(original);
    }
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(f.path, keys.privateKey.export({ format: "pem", type: "pkcs8" }));
    expect(f.save().credentials.sandbox!.cacheKey).not.toBe(original);
  });
});

describe("APNs request and result contract", () => {
  test("fixed headers, variable hex token length, expiration seconds and only allowlisted payload", async () => {
    const f = fixture(); const transport = new FakeTransport(); const sender = client(f.config, transport);
    const n = { ...notification(), canary: "PRIVATE-CANARY", target: { screen: "inbox" as const, projectId: "p_1", decisionId: "d_1", url: "https://canary.invalid" } };
    expect(await sender.send(n)).toEqual({ state: "accepted", reason: "accepted", status: 200 });
    const request = transport.requests[0];
    expect(request.headers).toEqual({ ":method": "POST", ":path": "/3/device/aa0123", ":scheme": "https", ":authority": "api.sandbox.push.apple.com",
      authorization: expect.stringMatching(/^bearer /), "apns-topic": DEFAULT_PUSH_BUNDLE_ID, "apns-push-type": "alert", "apns-priority": "10",
      "apns-id": n.deliveryId, "apns-collapse-id": n.eventId, "apns-expiration": "1800003600", "content-type": "application/json" });
    expect(JSON.parse(request.body)).toEqual({ aps: { alert: { title: "IAMCEO", body: "새 결재가 도착했습니다." }, sound: "default", "thread-id": `iamceo:${n.serverId}` },
      iamceo: { v: 1, serverId: n.serverId, eventId: n.eventId, kind: "decision", target: { screen: "inbox", projectId: "p_1", decisionId: "d_1" } } });
    for (const secret of ["canary", n.deviceToken, "PRIVATE KEY", f.path, f.entry.teamId, f.entry.keyId]) expect(request.body).not.toContain(secret);
    expect(request.timeoutMs).toBe(10_000);
  });
  test("all four kinds plus test have fixed text, valid targets and TTL", async () => {
    const f = fixture(); const transport = new FakeTransport(); const sender = client(f.config, transport);
    for (const kind of ["decision", "approval_wait", "error", "report_complete", "test"] as const) {
      const n = notification(kind);
      expect((await sender.send(n)).state).toBe("accepted");
      const request = transport.requests.at(-1)!;
      expect(Number(request.headers["apns-expiration"]) * 1000).toBe(Date.parse(n.expiresAt));
      expect(JSON.parse(request.body).iamceo.kind).toBe(kind);
      expect(Object.keys(JSON.parse(request.body).aps).sort()).toEqual(["alert", "sound", "thread-id"]);
    }
  });
  test("invalid token, target, UUID and expired/oversized TTL are rejected before transport", async () => {
    const f = fixture(); const transport = new FakeTransport(); const sender = client(f.config, transport);
    for (const patch of [{ deviceToken: "a" }, { deviceToken: "zz" }, { deviceToken: "aa".repeat(513) }, { deliveryId: "oops" },
      { eventId: "oops" }, { target: { screen: "home" as const } }, { target: { screen: "inbox" as const, projectId: "https://canary", decisionId: "d_1" } },
      { expiresAt: "invalid" }, { expiresAt: new Date(1_800_000_000_000 + 3_600_001).toISOString() }]) {
      expect((await sender.send({ ...notification(), ...patch })).state).toBe("failed");
    }
    expect((await sender.send(notification("decision", 1_800_000_000_000 - 3_600_000))).state).toBe("expired");
    expect(transport.requests).toHaveLength(0);
  });
  test("payload size is UTF8 bytes, accepts exactly 4096 and refuses 4097", () => {
    const payload = buildAPNsPayload(notification());
    payload.aps.alert.body = "";
    const overhead = Buffer.byteLength(JSON.stringify(payload));
    payload.aps.alert.body = "a".repeat(4096 - overhead);
    expect(Buffer.byteLength(serializeAPNsPayload(payload))).toBe(4096);
    payload.aps.alert.body += "a";
    expect(() => serializeAPNsPayload(payload)).toThrow("payload_too_large");
    payload.aps.alert.body = "한".repeat(1500);
    expect(JSON.stringify(payload).length).toBeLessThan(4096);
    expect(() => serializeAPNsPayload(payload)).toThrow("payload_too_large");
  });
  test("definite rejection classification and millisecond invalidation timestamps", () => {
    const cases = [[400, "BadDeviceToken", "invalid"], [400, "DeviceTokenNotForTopic", "invalid"], [410, "Unregistered", "invalid"],
      [410, "ExpiredToken", "invalid"], [403, "InvalidProviderToken", "unavailable"], [403, "Forbidden", "unavailable"],
      [413, "PayloadTooLarge", "failed"], [429, "TooManyRequests", "retry"], [500, "InternalServerError", "retry"], [503, "Shutdown", "retry"],
      [400, "SECRET-CANARY", "failed"], [302, "SECRET-CANARY", "unknown"]] as const;
    for (const [status, reason, state] of cases) {
      const result = classifyAPNsResponse(response(status, reason));
      expect(result.state).toBe(state); expect(JSON.stringify(result)).not.toContain("SECRET-CANARY");
    }
    expect(classifyAPNsResponse(response(410, "Unregistered", {}, 1_800_000_000_123)).invalidatedAt).toBe(1_800_000_000_123);
    expect(classifyAPNsResponse({ ...response(410), body: '{"reason":"Unregistered","timestamp":"bad"}' }).invalidatedAt).toBeUndefined();
    expect(classifyAPNsResponse({ ...response(500), body: "not json" }).state).toBe("retry");
  });
  test("Retry-After seconds/date validation without retaining raw response", () => {
    const now = 1_800_000_000_000;
    expect(classifyAPNsResponse(response(429, "TooManyRequests", { "retry-after": "15" }), now).retryAt).toBe(now + 15_000);
    expect(classifyAPNsResponse(response(503, "Shutdown", { "retry-after": new Date(now + 60_000).toUTCString() }), now).retryAt).toBe(now + 60_000);
    for (const value of ["-1", "1.5", "1e3", "NaN", "99999999999999999999999", "garbage"]) {
      expect(classifyAPNsResponse(response(429, "TooManyRequests", { "retry-after": value }), now).retryAt).toBeUndefined();
    }
  });
  test("ExpiredProviderToken refreshes once only after 20 minutes, reuses IDs", async () => {
    const f = fixture(); let now = 1_800_000_000_000;
    const transport = new FakeTransport((_request, index) => index === 1 ? response(403, "ExpiredProviderToken") : response());
    const sender = client(f.config, transport, () => now);
    const n = notification(); await sender.send(n);
    now += 20 * 60_000;
    expect((await sender.send(n)).state).toBe("accepted");
    expect(transport.requests).toHaveLength(3);
    expect(transport.requests[0].headers.authorization).toBe(transport.requests[1].headers.authorization);
    expect(transport.requests[1].headers.authorization).not.toBe(transport.requests[2].headers.authorization);
    expect(transport.requests[1].headers["apns-id"]).toBe(transport.requests[2].headers["apns-id"]);
    expect(transport.requests[1].body).toBe(transport.requests[2].body);
  });
  test("fresh auth failure suspends just one environment with no repeated JWT/request flood", async () => {
    const f = fixture(); const transport = new FakeTransport((request) => request.credential.environment === "sandbox" ? response(403, "ExpiredProviderToken") : response());
    const sender = client(f.config, transport);
    expect((await sender.send(notification())).state).toBe("unavailable");
    expect((await sender.send(notification())).state).toBe("unavailable");
    expect(transport.requests).toHaveLength(1);
    expect((await sender.send({ ...notification(), environment: "production" })).state).toBe("accepted");
    expect(sender.status()[0].lastError).toBe("auth_failed");
    expect(sender.status()[1].state).toBe("ready");
  });
  test("a second ExpiredProviderToken after refresh suspends the provider, without a third attempt", async () => {
    const f = fixture(); let now = 1_800_000_000_000;
    const transport = new FakeTransport((_r, index) => index === 0 ? response() : response(403, "ExpiredProviderToken"));
    const sender = client(f.config, transport, () => now);
    await sender.send(notification()); now += 20 * 60_000;
    expect((await sender.send(notification())).state).toBe("unavailable");
    expect(transport.requests).toHaveLength(3);
    await sender.send(notification()); expect(transport.requests).toHaveLength(3);
  });
  test("clock rollback pauses requests and resumes only after clock recovery", async () => {
    const f = fixture(); let now = 1_800_000_000_000;
    const transport = new FakeTransport(); const sender = client(f.config, transport, () => now);
    await sender.send(notification()); now -= 120_000;
    expect((await sender.send(notification())).reason).toBe("clock_rollback");
    expect(sender.status()[0].state).toBe("temporarily_unavailable");
    await sender.send(notification()); expect(transport.requests).toHaveLength(1);
    now += 120_000; expect((await sender.send(notification())).state).toBe("accepted");
  });
  test("queued requests recheck TTL and capture their original target/token", async () => {
    const f = fixture(); let now = 1_800_000_000_000; let release!: (result: APNsTransportResult) => void;
    const transport = new FakeTransport((_r, index) => index === 0 ? new Promise((resolve) => { release = resolve; }) : response());
    const sender = client(f.config, transport, () => now);
    const first = sender.send(notification());
    const n = notification("test"); const queued = sender.send(n);
    n.deviceToken = "bb"; n.target = { screen: "team", projectId: "evil", memberId: "evil" };
    await Promise.resolve(); now += 300_000; release(response()); await first;
    expect((await queued).state).toBe("expired"); expect(transport.requests).toHaveLength(1);
    const fresh = notification("test", now); const snapshotted = sender.send(fresh); fresh.deviceToken = "bb"; fresh.target = { screen: "team", projectId: "evil", memberId: "evil" };
    expect((await snapshotted).state).toBe("accepted"); expect(transport.requests.at(-1)!.headers[":path"]).toBe("/3/device/aa0123");
  });
  test("network diagnostics recover after success; invalid tokens never try the other environment", async () => {
    const f = fixture(); const transport = new FakeTransport((_r, index) => index === 0 ? { type: "not_sent", reason: "network_error" } : response());
    const sender = client(f.config, transport);
    await sender.send(notification()); expect(sender.status()[0].lastError).toBe("network_error");
    await sender.send(notification()); expect(sender.status()[0].state).toBe("ready");
    const badToken = new FakeTransport(() => response(400, "BadDeviceToken"));
    expect((await client(f.config, badToken).send(notification())).state).toBe("invalid");
    expect(badToken.requests).toHaveLength(1); expect(badToken.requests[0].credential.environment).toBe("sandbox");
    const unconfigured = client(loadAPNsConfig(f.runtime.paths.home), new FakeTransport());
    expect((await unconfigured.send(notification())).reason).toBe("unconfigured");
  });
  test("TooManyProviderTokenUpdates holds provider and does not regenerate within 20 minutes", async () => {
    const f = fixture(); let now = 1_800_000_000_000;
    const transport = new FakeTransport((_r, index) => index === 0 ? response(429, "TooManyProviderTokenUpdates") : response());
    const sender = client(f.config, transport, () => now);
    const result = await sender.send(notification());
    expect(result.retryAt).toBe(now + 20 * 60_000);
    now += 20 * 60_000 - 1; await sender.send(notification()); expect(transport.requests).toHaveLength(1);
    now++; expect((await sender.send(notification())).state).toBe("accepted");
    expect(transport.requests[0].headers.authorization).toBe(transport.requests[1].headers.authorization);
  });
  test("one stream per environment, independent environments, pre/post-write failures and shutdown", async () => {
    const f = fixture(); let release!: (value: APNsTransportResult) => void;
    const transport = new FakeTransport((_r, index) => index === 0 ? new Promise((resolve) => { release = resolve; }) : response());
    const sender = client(f.config, transport);
    const first = sender.send(notification()); const queued = sender.send(notification());
    await Promise.resolve(); expect(transport.requests).toHaveLength(1);
    expect((await sender.send({ ...notification(), environment: "production" })).state).toBe("accepted");
    release({ type: "unknown", reason: "timeout" });
    expect((await first).state).toBe("unknown"); expect((await queued).state).toBe("accepted");
    const prewrite = client(f.config, new FakeTransport(() => ({ type: "not_sent", reason: "network_error" })));
    expect((await prewrite.send(notification())).state).toBe("retry");
    const throwing = client(f.config, new FakeTransport(() => { throw new Error("SECRET-CANARY"); }));
    expect(await throwing.send(notification())).toEqual({ state: "unknown", reason: "network_error" });
    sender.close(); expect((await sender.send(notification())).reason).toBe("shutdown");
  });
});

async function tlsPeer(handler: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void,
  fault?: "goaway_unprocessed" | "goaway_processed" | "refused") {
  const f = fixture();
  const keyPath = join(f.runtime.paths.configDir, "tls.key");
  const certPath = join(f.runtime.paths.configDir, "tls.crt");
  const configPath = join(f.runtime.paths.configDir, "openssl.cnf");
  writeFileSync(keyPath, f.keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(configPath, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n", { mode: 0o600 });
  const child = Bun.spawnSync(["/usr/bin/openssl", "req", "-new", "-x509", "-key", keyPath, "-days", "1",
    "-out", certPath, "-config", configPath], { cwd: f.runtime.paths.work, env: f.runtime.childEnv(), stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const cert = readFileSync(certPath);
  const sessions = new Set<ServerHttp2Session>();
  const sockets = new Set<TLSSocket>();
  // Send precise fault frames on the wire, independently of the peer runtime's
  // HTTP/2 server implementation. This also exposes Bun's client-side ID bug.
  const frame = (type: number, flags: number, streamId: number, payload = Buffer.alloc(0)) => {
    const header = Buffer.alloc(9); header.writeUIntBE(payload.length, 0, 3); header[3] = type; header[4] = flags; header.writeUInt32BE(streamId, 5);
    return Buffer.concat([header, payload]);
  };
  const server: Server = fault ? createTLSServer({ key: readFileSync(keyPath), cert, ALPNProtocols: ["h2"] }, (socket) => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0); let preface = false; let sent = false;
    socket.write(frame(4, 0, 0)); // SETTINGS
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (!preface) {
        if (pending.length < 24) return;
        expect(pending.subarray(0, 24).toString()).toBe("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
        pending = pending.subarray(24); preface = true;
      }
      while (pending.length >= 9) {
        const length = pending.readUIntBE(0, 3);
        if (pending.length < 9 + length) return;
        const type = pending[3]; const flags = pending[4]; const streamId = pending.readUInt32BE(5) & 0x7fffffff;
        pending = pending.subarray(9 + length);
        if (type === 4 && !(flags & 1)) socket.write(frame(4, 1, 0)); // SETTINGS ACK
        if (!sent && type === 1 && fault === "refused") {
          sent = true; const code = Buffer.alloc(4); code.writeUInt32BE(constants.NGHTTP2_REFUSED_STREAM);
          socket.write(frame(3, 0, streamId, code));
        } else if (!sent && streamId > 0 && (type === 0 || type === 1) && (flags & 1)) {
          sent = true; const payload = Buffer.alloc(8); payload.writeUInt32BE(fault === "goaway_processed" ? streamId : 0);
          socket.write(frame(7, 0, 0, payload));
        }
      }
    });
  }) : createSecureServer({ key: readFileSync(keyPath), cert, allowHTTP1: false });
  server.on("session", (session: ServerHttp2Session) => { sessions.add(session); session.on("error", () => {}); session.on("close", () => sessions.delete(session)); });
  server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => { stream.on("error", () => {}); handler(stream, headers); });
  server.on("tlsClientError", () => {});
  for (;;) {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address && typeof address !== "string" && address.port !== 7878) break;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); for (const session of sessions) session.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const origins: string[] = [];
  function transport(trust = true, servername = "localhost") {
    const result = new HTTP2APNsTransport((origin, options) => {
      origins.push(origin);
      expect(options.rejectUnauthorized).toBe(true); expect(options.ALPNProtocols).toEqual(["h2"]);
      expect(options.servername).toBe(new URL(origin).hostname);
      return connect(`https://127.0.0.1:${port}`, { ...options, servername, ...(trust ? { ca: cert } : {}) });
    });
    cleanups.push(() => result.close());
    return result;
  }
  return { ...f, server, sessions, port, origins, transport };
}

describe("TLS HTTP/2 peer (loopback port0, per-connection CA)", () => {
  test("ALPN h2, fixed origins/headers and payload, connection reuse and environment isolation", async () => {
    const received: { headers: IncomingHttpHeaders; body: string; alpn: string | false | undefined }[] = [];
    const f = await tlsPeer((stream, headers) => {
      let body = ""; stream.on("data", (chunk) => { body += chunk.toString(); });
      stream.on("end", () => { received.push({ headers, body, alpn: stream.session?.alpnProtocol }); stream.respond({ ":status": 200 }); stream.end(); });
    });
    const sender = client(f.config, f.transport());
    expect((await sender.send(notification())).state).toBe("accepted");
    expect((await sender.send(notification())).state).toBe("accepted");
    expect(f.origins).toEqual([APNS_ORIGINS.sandbox]);
    expect((await sender.send({ ...notification(), environment: "production" })).state).toBe("accepted");
    expect(f.origins).toEqual([APNS_ORIGINS.sandbox, APNS_ORIGINS.production]);
    expect(received).toHaveLength(3); expect(received.every((r) => r.alpn === "h2")).toBe(true);
    expect(received[0].headers[":path"]).toBe("/3/device/aa0123");
    expect(received[0].headers["apns-topic"]).toBe(DEFAULT_PUSH_BUNDLE_ID);
    expect(JSON.parse(received[0].body).iamceo.kind).toBe("decision");
    const [, claims, signature] = String(received[0].headers.authorization).slice(7).split(".");
    expect(JSON.parse(Buffer.from(claims, "base64url").toString()).iat).toBe(1_800_000_000);
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
  });
  test("untrusted TLS certificate fails before any POST", async () => {
    let requests = 0;
    const f = await tlsPeer(() => { requests++; });
    const result = await client(f.config, f.transport(false), undefined, 1000).send(notification());
    expect(result.state).toBe("retry"); expect(requests).toBe(0);
  });
  test("a trusted certificate for a different hostname is still rejected", async () => {
    let requests = 0; const f = await tlsPeer(() => { requests++; });
    expect((await client(f.config, f.transport(true, "wrong.invalid"), undefined, 1000).send(notification())).state).toBe("retry");
    expect(requests).toBe(0);
  });
  test("rotated credentials open a separate connection even in the same environment", async () => {
    const f = await tlsPeer((stream) => { stream.resume(); stream.on("end", () => { stream.respond({ ":status": 200 }); stream.end(); }); });
    const transport = f.transport();
    expect((await client(f.config, transport).send(notification())).state).toBe("accepted");
    const rotated = f.save({ sandbox: { ...f.entry, keyId: "NEXTKEY123" } });
    expect((await client(rotated, transport).send(notification())).state).toBe("accepted");
    expect(f.origins).toEqual([APNS_ORIGINS.sandbox, APNS_ORIGINS.sandbox]);
  });
  test("timeout and connection loss after HEADERS/body are unknown with no retry", async () => {
    let requests = 0;
    const f = await tlsPeer((stream) => { requests++; stream.resume(); });
    const sender = client(f.config, f.transport(), undefined, 150);
    expect(await sender.send(notification())).toEqual({ state: "unknown", reason: "timeout" });
    expect(requests).toBe(1);
    const lost = await tlsPeer((stream) => { stream.resume(); stream.on("end", () => stream.session?.destroy()); });
    expect((await client(lost.config, lost.transport(), undefined, 1000).send(notification())).state).toBe("unknown");
  });
  test("wire GOAWAY: Bun 1.3.14 loses peer lastStreamID, so ambiguous requests stay unknown", async () => {
    for (const processed of [false, true]) {
      const f = await tlsPeer(() => {}, processed ? "goaway_processed" : "goaway_unprocessed");
      const sender = client(f.config, f.transport(), undefined, 1000);
      const result = await sender.send(notification());
      expect(result).toEqual({ state: processed || Bun.version === "1.3.14" ? "unknown" : "retry", reason: "goaway" });
    }
  });
  test("injected accurate GOAWAY ID retries only streams above the peer's last processed ID", async () => {
    const f = fixture();
    for (const lastStreamID of [0, 1, 3]) {
      const session = Object.assign(new EventEmitter(), { connecting: false, alpnProtocol: "h2", closed: false, destroyed: false,
        request: () => stream,
        close() { session.closed = true; session.emit("close"); },
        destroy() { session.destroyed = true; session.emit("close"); },
      });
      const stream = Object.assign(new EventEmitter(), { id: 3, rstCode: 0, closed: false,
        end() { queueMicrotask(() => session.emit("goaway", 0, lastStreamID)); },
        close() { stream.closed = true; stream.emit("close"); },
      });
      const transport = new HTTP2APNsTransport(() => session as unknown as ClientHttp2Session);
      const sender = client(f.config, transport);
      expect(await sender.send(notification())).toEqual({ state: lastStreamID < 3 ? "retry" : "unknown", reason: "goaway" });
    }
  });
  test("HTTP2 definite errors reach classification, REFUSED_STREAM is retryable", async () => {
    const f = await tlsPeer((stream) => { stream.resume(); stream.on("end", () => { stream.respond({ ":status": 410 }); stream.end(JSON.stringify({ reason: "Unregistered", timestamp: 1_800_000_000_123 })); }); });
    expect(await client(f.config, f.transport()).send(notification())).toEqual({ state: "invalid", reason: "Unregistered", status: 410, invalidatedAt: 1_800_000_000_123 });
    const refused = await tlsPeer(() => {}, "refused");
    expect((await client(refused.config, refused.transport()).send(notification())).state).toBe("retry");
  });
  test("oversized peer response is bounded and unknown", async () => {
    const f = await tlsPeer((stream) => { stream.resume(); stream.on("end", () => { stream.respond({ ":status": 400 }); stream.end("x".repeat(8193)); }); });
    expect(await client(f.config, f.transport()).send(notification())).toEqual({ state: "unknown", reason: "invalid_response" });
  });
  test("closing an in-flight transport settles it as unknown and prevents new streams", async () => {
    let arrived!: () => void; const received = new Promise<void>((resolve) => { arrived = resolve; });
    const f = await tlsPeer((stream) => { stream.resume(); stream.on("end", arrived); });
    const transport = f.transport(); const sender = client(f.config, transport);
    const inFlight = sender.send(notification()); await received; sender.close();
    expect((await inFlight).state).toBe("unknown");
    expect((await sender.send(notification())).reason).toBe("shutdown");
  });
  test("closed transport refuses new streams", async () => {
    const f = fixture(); const transport = new HTTP2APNsTransport(() => { throw new Error("must not connect"); }); transport.close();
    expect((await client(f.config, transport).send(notification())).reason).toBe("shutdown");
  });
});
