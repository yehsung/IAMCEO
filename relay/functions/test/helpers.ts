// 시험 도구: 가짜 APNs(이 Mac 의 127.0.0.1, 자체 서명 TLS, HTTP/2), 시험 키, 중계 묶음.
// 진짜 Apple 서버에는 닿지 않는다. 임시 파일은 mkdtemp 로 만든 시험 폴더에만 둔다.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createSecureServer } from "node:http2";
import type { IncomingHttpHeaders, ServerHttp2Session, ServerHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { KeyObject } from "node:crypto";
import { RelayAPNs, apnsCredential } from "../src/apns-sender.ts";
import type { RelayAPNsOptions } from "../src/apns-sender.ts";
import { RelayLimits } from "../src/limits.ts";
import type { LimitsOptions } from "../src/limits.ts";
import { createRelay } from "../src/relay.ts";
import type { LogEntry, Relay, RelayRequest, RelayResponse } from "../src/relay.ts";

export const MASTER = "test-master-0123456789abcdefghijklmnopqrstuvwxyz";
export const TOKEN = "a1".repeat(32);
export const SERVER_ID = "6f1f8a9e-2b7c-4d1e-9a3b-1c2d3e4f5a6b";

export function tempDir(cleanups: (() => void | Promise<void>)[]): string {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-relay-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface TestKey { privateKey: KeyObject; publicKey: KeyObject; pem: string }
export function testKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, publicKey, pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}

export function credentialFor(key: TestKey) {
  const credential = apnsCredential({ keyId: "TESTKEY123", teamId: "TEAMID1234", privateKey: key.pem });
  if (credential === "key_error") throw new Error("test key rejected");
  return credential;
}

export interface Received { headers: IncomingHttpHeaders; body: string; alpn: string | false | undefined }
export type ApnsHandler = (stream: ServerHttp2Stream, received: Received) => void;

/** 응답 도우미: 상태와 본문(JSON)·머리글. */
export function reply(stream: ServerHttp2Stream, status: number, body?: Record<string, unknown>, headers: Record<string, string> = {}): void {
  if (stream.destroyed || stream.closed) return;
  stream.respond({ ":status": status, ...(body ? { "content-type": "application/json" } : {}), ...headers });
  stream.end(body ? JSON.stringify(body) : undefined);
}

/** 이 Mac 에서만 듣는 가짜 APNs. 자체 서명 인증서는 openssl 로 그때그때 만든다. */
export async function fakeApns(cleanups: (() => void | Promise<void>)[], handler: ApnsHandler) {
  const dir = tempDir(cleanups);
  const tlsKey = testKey();
  const keyPath = join(dir, "tls.key"), certPath = join(dir, "tls.crt"), configPath = join(dir, "openssl.cnf");
  writeFileSync(keyPath, tlsKey.pem, { mode: 0o600 });
  writeFileSync(configPath, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n", { mode: 0o600 });
  const made = spawnSync("/usr/bin/openssl", ["req", "-new", "-x509", "-key", keyPath, "-days", "1", "-out", certPath, "-config", configPath], { cwd: dir, stdio: "pipe" });
  if (made.status !== 0) throw new Error("openssl failed");
  const cert = readFileSync(certPath);
  const received: Received[] = [];
  const sessions = new Set<ServerHttp2Session>();
  let connections = 0;
  const server = createSecureServer({ key: readFileSync(keyPath), cert, allowHTTP1: false });
  server.on("session", (session: ServerHttp2Session) => { connections++; sessions.add(session); session.on("error", () => {}); session.on("close", () => sessions.delete(session)); });
  server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    stream.on("error", () => {});
    let body = "";
    stream.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    stream.on("end", () => {
      const item = { headers, body, alpn: stream.session?.alpnProtocol };
      received.push(item);
      handler(stream, item);
    });
  });
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => { for (const session of sessions) session.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const origins: string[] = [];
  /** 중계의 연결 함수 자리에 넣는다. 원래 주소(api.push.apple.com)를 기록하고 이 서버로 돌린다. */
  const connector: NonNullable<RelayAPNsOptions["connector"]> = (origin, options) => {
    origins.push(origin);
    return connect(`https://127.0.0.1:${port}`, { ...options, servername: "localhost", ca: cert });
  };
  return { port, cert, certPath, received, origins, connector, connections: () => connections };
}

export interface RelayFixtureOptions {
  mode?: string; allowed?: string; blocked?: string; master?: string;
  key?: TestKey; apns?: Partial<RelayAPNsOptions>; limits?: LimitsOptions; now?: () => number;
}

/** 중계 핵심 + APNs 보내기 + 한도를 묶는다. 로그는 logs 에 모인다. */
export function relayFixture(cleanups: (() => void | Promise<void>)[], options: RelayFixtureOptions = {}) {
  const logs: LogEntry[] = [];
  const key = options.key ?? testKey();
  const now = options.now ?? Date.now;
  const apns = new RelayAPNs({ credential: () => credentialFor(key), now, ...options.apns,
    onSuspend: (reason, until) => logs.push({ severity: "ERROR", message: "apns_suspended", reason, until: new Date(until).toISOString() }) });
  cleanups.push(() => apns.close());
  const relay = createRelay({ apns, limits: new RelayLimits(options.limits), now, log: (entry) => logs.push(entry),
    settings: () => ({ master: options.master ?? MASTER, mode: options.mode ?? "open", allowed: options.allowed, blocked: options.blocked }) });
  return { relay, apns, logs, key };
}

export function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): RelayRequest {
  const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return { method, path, headers: { "content-type": "application/json", ...headers }, body: text === undefined ? undefined : Buffer.from(text) };
}

export async function install(relay: Relay, ip = "203.0.113.7"): Promise<{ installationId: string; secret: string; authorization: string }> {
  const response = await relay.handle(request("POST", "/v1/installations", { protocol: 1 }, { "x-forwarded-for": ip }));
  if (response.status !== 201) throw new Error(`install failed ${response.status}`);
  const value = JSON.parse(response.body) as { installationId: string; secret: string };
  return { ...value, authorization: `Bearer ${value.installationId}.${value.secret}` };
}

export function parse(response: RelayResponse): Record<string, unknown> { return JSON.parse(response.body) as Record<string, unknown>; }

/** Mac 의 relayPushBody 와 같은 모양의 본문. */
export function pushBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { token: TOKEN, kind: "decision", id: randomUUID(), eventId: randomUUID(), serverId: SERVER_ID,
    target: { screen: "inbox", projectId: "p_abc123", decisionId: "d_xyz789" }, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), ...overrides };
}
