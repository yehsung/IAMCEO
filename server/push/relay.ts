// 알림 중계(relay): 이 Mac 에 production APNs 키가 없을 때, App Store 앱으로 가는 알림을 개발자가 운영하는 중계에 넘긴다.
// 중계는 받은 값으로 고정 문구 페이로드를 직접 만들어 Apple(APNs)에 보낸다. 대화 내용·문구는 보내지 않는다.
// - 서버가 뜰 때는 중계에 접속하지 않는다. 처음 보낼 알림이 생길 때 설치를 한 번 등록한다(계정·메일 없음).
// - 설치 자격(installationId·secret)은 IAMCEO 홈의 push-relay.json(0600)에만 둔다. DB·백업에는 넣지 않는다
//   (백업은 config.json·apns.json 만 담으므로 복원한 홈은 저절로 새 설치가 된다).
// - 토큰·secret 은 로그에 쓰지 않는다. 오류 기록은 사유 코드와 다시 시도할 시각뿐이다.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import * as tls from "node:tls";
import { DEFAULT_PUSH_BUNDLE_ID } from "../../shared/push.ts";
import type { PushProviderStatus } from "../../shared/push.ts";
import { APNS_TTL_MS, APNsClient, buildAPNsPayload } from "./apns.ts";
import type { APNsNotification, APNsResult } from "./apns.ts";
import { loadAPNsConfig } from "./config.ts";
import type { APNsConfig } from "./config.ts";
import { DEFAULT_PUSH_RELAY_URL, normalizePushRelayUrl } from "./relay-url.ts";

export { DEFAULT_PUSH_RELAY_URL, normalizePushRelayUrl };

export const PUSH_RELAY_FILE = "push-relay.json";
/** 중계 프로토콜 판. 요청 본문·경로가 바뀌면 올린다(relay/ 와 함께). */
export const PUSH_RELAY_PROTOCOL = 1;

const DEFAULT_TIMEOUT_MS = 8_000;
/** 중계가 거절했는데 다시 시도할 시각을 주지 않으면 이만큼 쉰다(retryAt 없는 unavailable 은 작업기를 영영 멈춘다). */
const REJECT_HOLD_MS = 10 * 60_000;
const RATE_HOLD_MS = 60_000;
const MAX_HOLD_MS = 24 * 60 * 60_000;
const NETWORK_FLAG_MS = 60_000;
const MAX_RESPONSE_BYTES = 4096;
/** 응답 머리글 묶음의 최대 크기. 넘으면 알아볼 수 없는 응답으로 본다. */
const MAX_HEAD_BYTES = 16 * 1024;
const INVALID_REASONS = ["Unregistered", "ExpiredToken", "BadDeviceToken", "DeviceTokenNotForTopic"] as const;

interface RelayCredential { v: 1; relay: string; installationId: string; secret: string; createdAt: string }
type Credential = RelayCredential & { fresh?: boolean };

const ID = /^[A-Za-z0-9_-]{8,200}$/;
const SECRET = /^[A-Za-z0-9_-]{16,512}$/;

function validCredential(value: unknown): value is RelayCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.v === 1 && typeof v.relay === "string" && typeof v.installationId === "string" && ID.test(v.installationId) &&
    typeof v.secret === "string" && SECRET.test(v.secret) && typeof v.createdAt === "string";
}

/** 홈의 push-relay.json. 링크·다른 사용자·남이 읽을 수 있는 파일은 없는 것으로 본다(새로 등록해 덮어쓴다). */
export function readPushRelayCredential(home: string, relay: string): RelayCredential | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(join(home, PUSH_RELAY_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 4096) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    // 다른 주소에서 받은 자격은 그 주소에만 쓴다. 주소를 바꿨으면 새 중계에 새로 등록한다.
    return validCredential(parsed) && parsed.relay === relay ? parsed : null;
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 읽기만 했다 */ } }
}

/** 0600 임시 파일에 쓰고 이름을 바꾼다. 실패하면 false(이번 실행 동안은 메모리의 자격을 쓴다). */
export function writePushRelayCredential(home: string, credential: RelayCredential): boolean {
  const temp = join(home, `.push-relay-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(credential) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, join(home, PUSH_RELAY_FILE));
    try {
      const dir = fs.openSync(home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch { /* 이름 바꾸기는 끝났다 */ }
    return true;
  } catch {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* 아래에서 지운다 */ }
    try { fs.unlinkSync(temp); } catch { /* 없으면 그만 */ }
    return false;
  }
}

function removePushRelayCredential(home: string): void {
  try { fs.unlinkSync(join(home, PUSH_RELAY_FILE)); } catch { /* 없으면 그만 */ }
}

/** 진단 파일용 요약. 설치 ID·secret 은 넣지 않는다. */
export function pushRelaySummary(home: string): { file: boolean; relay: string | null; createdAt: string | null } {
  try {
    const stat = fs.lstatSync(join(home, PUSH_RELAY_FILE));
    if (!stat.isFile()) return { file: false, relay: null, createdAt: null };
    const parsed: unknown = JSON.parse(fs.readFileSync(join(home, PUSH_RELAY_FILE), "utf8"));
    if (!validCredential(parsed)) return { file: true, relay: null, createdAt: null };
    let host: string | null = null;
    try { host = new URL(parsed.relay).host; } catch { /* 모양만 맞은 값 */ }
    return { file: true, relay: host, createdAt: parsed.createdAt };
  } catch { return { file: false, relay: null, createdAt: null }; }
}

/** 진단 파일의 가림 목록에 넣을 값(secret). 파일이 없거나 읽지 못하면 빈 목록. */
export function pushRelaySecrets(home: string): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(home, PUSH_RELAY_FILE), "utf8"));
    return validCredential(parsed) ? [parsed.secret] : [];
  } catch { return []; }
}

export interface RelayClientOptions {
  home: string;
  /** normalizePushRelayUrl 을 거친 주소. */
  url: string;
  /** 시험만 넣는다: 자체 서명한 가짜 중계(https)의 인증서. 실제로는 시스템이 믿는 인증서만 받는다. */
  tlsCa?: string | Buffer;
  now?: () => number;
  /** 등록과 발신을 합친 한 번의 send 시간 한도. 작업기의 10초 감시보다 짧아야 한다. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

type Wire =
  | { type: "response"; status: number; headers: Headers; body: Record<string, unknown> | null }
  | { type: "not_sent" | "unknown"; reason: "network_error" | "timeout" | "shutdown" };

function retryAfter(headers: Headers, now: number, fallback: number): number {
  const value = headers.get("retry-after");
  let at: number | undefined;
  if (value && /^\d{1,9}$/.test(value)) at = now + Number(value) * 1000;
  else if (value && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) at = parsed;
  }
  return Math.min(now + MAX_HOLD_MS, Math.max(now + 1000, at ?? now + fallback));
}

function jsonObject(bytes: Buffer | null): Record<string, unknown> | null {
  if (!bytes || bytes.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * HTTP/1.1 응답 읽개. 상태·머리글을 읽고 본문은 MAX_RESPONSE_BYTES 까지만 모은다(넘으면 본문 없음으로 끝낸다).
 * 1xx 중간 응답은 건너뛴다. 본문 길이는 Content-Length, chunked, 아니면 연결이 닫힐 때까지(Connection: close).
 */
class ResponseReader {
  #buffer: Buffer = Buffer.alloc(0);
  #head: { status: number; headers: Headers; mode: "length" | "chunked" | "close"; length: number } | undefined;
  #body: Buffer[] = [];
  #bodySize = 0;
  #invalid = false;
  /** 받은 조각을 더한다. 응답이 끝났으면 그 결과, 아직이면 undefined. */
  push(chunk: Buffer): Extract<Wire, { type: "response" }> | "invalid" | undefined {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    while (!this.#head) {
      const end = this.#buffer.indexOf("\r\n\r\n");
      if (end < 0) return this.#buffer.length > MAX_HEAD_BYTES ? "invalid" : undefined;
      const lines = this.#buffer.subarray(0, end).toString("latin1").split("\r\n");
      this.#buffer = this.#buffer.subarray(end + 4);
      const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0] ?? "");
      if (!match) return "invalid";
      const status = Number(match[1]);
      if (status >= 100 && status < 200) continue; // 100 Continue 같은 중간 응답
      const headers = new Headers();
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        try { headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim()); } catch { /* 알아볼 수 없는 머리글은 버린다 */ }
      }
      const length = Number(headers.get("content-length") ?? NaN);
      const chunked = /(?:^|,)\s*chunked\s*$/i.test(headers.get("transfer-encoding") ?? "");
      this.#head = { status, headers, mode: chunked ? "chunked" : Number.isSafeInteger(length) && length >= 0 ? "length" : "close", length };
      if (status === 204 || status === 304) return this.result(true);
    }
    return this.drain();
  }
  /** 연결이 닫혔다. 머리글까지 받았으면 그 응답(본문이 모자라면 본문 없음), 아니면 undefined. */
  end(): Extract<Wire, { type: "response" }> | undefined {
    if (!this.#head) return undefined;
    if (this.#head.mode === "close" && !this.#invalid) return this.result(true);
    return this.result(false);
  }
  private drain(): Extract<Wire, { type: "response" }> | undefined {
    const head = this.#head!;
    if (head.mode === "length") {
      const need = head.length - this.#bodySize;
      const take = this.#buffer.subarray(0, need);
      this.#buffer = this.#buffer.subarray(take.length);
      if (!this.add(take)) return this.result(false);
      return this.#bodySize >= head.length ? this.result(true) : undefined;
    }
    if (head.mode === "close") {
      const take = this.#buffer;
      this.#buffer = Buffer.alloc(0);
      return this.add(take) ? undefined : this.result(false);
    }
    while (true) {
      const lineEnd = this.#buffer.indexOf("\r\n");
      if (lineEnd < 0) return this.#buffer.length > 64 ? this.result(false) : undefined;
      const size = parseInt(this.#buffer.subarray(0, lineEnd).toString("latin1").split(";")[0]!.trim(), 16);
      if (!Number.isSafeInteger(size) || size < 0) return this.result(false);
      if (size === 0) return this.result(true); // 끝 조각(뒤따르는 머리글은 보지 않는다)
      if (this.#buffer.length < lineEnd + 2 + size + 2) return undefined;
      const take = this.#buffer.subarray(lineEnd + 2, lineEnd + 2 + size);
      this.#buffer = this.#buffer.subarray(lineEnd + 2 + size + 2);
      if (!this.add(take)) return this.result(false);
    }
  }
  private add(bytes: Buffer): boolean {
    if (!bytes.length) return true;
    this.#bodySize += bytes.length;
    if (this.#bodySize > MAX_RESPONSE_BYTES) { this.#invalid = true; return false; }
    this.#body.push(bytes);
    return true;
  }
  private result(complete: boolean): Extract<Wire, { type: "response" }> {
    const head = this.#head!;
    return { type: "response", status: head.status, headers: head.headers,
      body: complete && !this.#invalid ? jsonObject(Buffer.concat(this.#body)) : null };
  }
}

/**
 * 중계에 요청 한 번(HTTP/1.1, 요청마다 새 연결, Connection: close). fetch 대신 소켓을 직접 쓰는 까닭은 하나다:
 * 연결(https 는 TLS 악수)이 맺어지기 전에 끝난 실패·시간 초과는 요청이 중계에 닿지 않은 것이 확실하므로
 * not_sent(다시 보냄)로, 요청을 쓴 뒤의 시간 초과·끊김은 보냈는지 모르므로 unknown(다시 보내지 않음)으로 가른다.
 * 직접 보내기(apns.ts)가 연결이 안 맺어지면 not_sent 로 두는 것과 같다. 리디렉션은 따라가지 않는다.
 */
function exchange(target: URL, path: string, body: string, authorization: string | undefined, timeoutMs: number,
  signal: AbortSignal, ca: string | Buffer | undefined): Promise<Wire> {
  return new Promise((resolve) => {
    const secure = target.protocol === "https:";
    const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
    const port = Number(target.port) || (secure ? 443 : 80);
    const base = target.pathname === "/" ? "" : target.pathname.replace(/\/+$/, "");
    const payload = Buffer.from(body, "utf8");
    const head = [`POST ${base}${path} HTTP/1.1`, `Host: ${target.host}`, "Content-Type: application/json", "Accept: application/json",
      "User-Agent: IAMCEO", `Content-Length: ${payload.length}`, "Connection: close", ...(authorization ? [`Authorization: ${authorization}`] : [])];
    const reader = new ResponseReader();
    let connected = false;
    let done = false;
    let socket: net.Socket | undefined;
    const finish = (wire: Wire) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket?.destroy();
      resolve(wire);
    };
    const lost = (reason: "network_error" | "timeout" | "shutdown") => finish({ type: connected ? "unknown" : "not_sent", reason });
    const onAbort = () => lost("shutdown");
    const timer = setTimeout(() => lost("timeout"), Math.max(1, timeoutMs));
    if (signal.aborted) { lost("shutdown"); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    let opened: net.Socket;
    try {
      opened = secure
        ? tls.connect({ host, port, ALPNProtocols: ["http/1.1"], ...(net.isIP(host) ? {} : { servername: host }), ...(ca ? { ca } : {}) })
        : net.connect({ host, port });
    } catch { lost("network_error"); return; }
    socket = opened;
    opened.once(secure ? "secureConnect" : "connect", () => {
      if (done) return;
      // 여기서부터 요청 바이트가 나간다. 이 뒤의 실패는 중계가 받았는지 모른다.
      connected = true;
      opened.write(Buffer.concat([Buffer.from(`${head.join("\r\n")}\r\n\r\n`, "latin1"), payload]));
    });
    opened.on("data", (chunk: Buffer) => {
      const result = reader.push(chunk);
      if (result === "invalid") finish({ type: "unknown", reason: "network_error" });
      else if (result) finish(result);
    });
    // 끊겼다: 머리글까지 받았으면 그 응답, 아니면 연결 전이냐 뒤냐로 가른다.
    const closed = () => { const result = reader.end(); if (result) finish(result); else lost("network_error"); };
    opened.on("end", closed);
    opened.on("close", closed);
    opened.on("error", closed);
  });
}

/**
 * 중계로 보내는 production 발신 수단. 작업기가 요구하는 send/status/close 만 맞춘다.
 * 상태 값은 지금의 네 가지(ready·temporarily_unavailable)만 쓴다. 중계가 거절해도 configuration_error 로 알리지 않는다
 * (출시된 앱이 "키 경로와 파일 권한을 확인"이라는 틀린 안내를 띄운다).
 */
export class RelayClient {
  #credential: Credential | null | undefined;
  #registering: Promise<Credential | APNsResult> | undefined;
  #suspended: { result: APNsResult & { retryAt: number }; lastError: "auth_failed" | "network_error" } | undefined;
  #networkErrorAt: number | undefined;
  #closed = false;
  #inflight = new Set<AbortController>();
  private readonly target: URL;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  constructor(private readonly options: RelayClientOptions) {
    this.target = new URL(options.url);
    this.now = options.now ?? Date.now;
    this.timeoutMs = Math.min(9_000, Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.log = options.log ?? ((line) => console.warn(line));
  }
  get url(): string { return this.options.url; }

  status(): PushProviderStatus {
    const base = { environment: "production" as const, bundleId: DEFAULT_PUSH_BUNDLE_ID, via: "relay" as const };
    const suspended = this.#suspended;
    if (suspended && suspended.result.retryAt > this.now()) return { ...base, state: "temporarily_unavailable", lastError: suspended.lastError };
    if (this.#networkErrorAt !== undefined && this.now() - this.#networkErrorAt < NETWORK_FLAG_MS) {
      return { ...base, state: "temporarily_unavailable", lastError: "network_error" };
    }
    return { ...base, state: "ready", lastError: null };
  }

  async send(notification: APNsNotification): Promise<APNsResult> {
    if (this.#closed) return { state: "unavailable", reason: "shutdown" };
    if (notification.environment !== "production") return { state: "unavailable", reason: "unconfigured", retryAt: this.now() + REJECT_HOLD_MS };
    const suspended = this.#suspended;
    if (suspended && suspended.result.retryAt > this.now()) return { ...suspended.result };
    this.#suspended = undefined;
    // 형식 검사는 직접 보내기(APNsClient.dispatch)와 같다. 중계는 같은 검사를 다시 하지만, 틀린 값은 여기서 멈춘다.
    const occurredAt = Date.parse(notification.occurredAt);
    const expiresAt = Date.parse(notification.expiresAt);
    if (!Number.isFinite(occurredAt) || !Number.isFinite(expiresAt) || expiresAt <= occurredAt ||
        expiresAt - occurredAt > APNS_TTL_MS[notification.kind]) return { state: "failed", reason: "invalid_expiration" };
    if (Math.floor(expiresAt / 1000) <= Math.floor(this.now() / 1000)) return { state: "expired", reason: "expired" };
    let body: string;
    try {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notification.deliveryId) ||
          !/^(?:[0-9a-fA-F]{2}){1,512}$/.test(notification.deviceToken)) throw new Error();
      body = JSON.stringify(relayPushBody(notification));
    } catch { return { state: "failed", reason: "invalid_payload" }; }

    const deadline = this.now() + this.timeoutMs;
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = await this.credential(deadline);
      if (!("installationId" in credential)) return credential;
      // 등록에 시간을 거의 다 썼으면 보내지 않고 다시 시도로 둔다(아직 보내지 않았다).
      if (deadline - this.now() < Math.min(500, this.timeoutMs / 4)) return { state: "retry", reason: "timeout" };
      const wire = await this.post("/v1/push", body, deadline, `Bearer ${credential.installationId}.${credential.secret}`);
      if (wire.type !== "response") return this.networkResult(wire);
      this.#networkErrorAt = undefined;
      if (wire.status === 401) {
        // 중계가 이 설치를 모른다(비밀을 바꿨거나 설치가 지워졌다). 401 이면 APNs 로 보내지 않았으므로 다시 보내도 안전하다.
        // 방금 받은 자격까지 거절되면 더 등록하지 않고 쉰다(등록 폭주 방지).
        this.forget();
        if (credential.fresh || attempt === 1) return this.suspend({ state: "unavailable", reason: "auth_failed", status: 401, retryAt: this.now() + REJECT_HOLD_MS }, "auth_failed");
        continue;
      }
      return this.classify(wire);
    }
    return this.suspend({ state: "unavailable", reason: "auth_failed", status: 401, retryAt: this.now() + REJECT_HOLD_MS }, "auth_failed");
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#inflight) controller.abort();
    this.#inflight.clear();
  }

  private forget(): void {
    this.#credential = null;
    removePushRelayCredential(this.options.home);
  }

  private suspend(result: APNsResult & { retryAt: number }, lastError: "auth_failed" | "network_error"): APNsResult {
    const before = this.#suspended;
    this.#suspended = { result, lastError };
    if (!before || before.result.reason !== result.reason) {
      this.log(`[push] 알림 중계가 받지 않았습니다(${result.status ?? "-"} ${result.reason}). ${Math.max(1, Math.round((result.retryAt - this.now()) / 60_000))}분 뒤 다시 보냅니다`);
    }
    return { ...result };
  }

  private networkResult(wire: Extract<Wire, { type: "not_sent" | "unknown" }>): APNsResult {
    if (wire.reason === "shutdown") return { state: "unknown", reason: "shutdown" };
    this.#networkErrorAt = this.now();
    return { state: wire.type === "not_sent" ? "retry" : "unknown", reason: wire.reason };
  }

  /** 저장한 자격, 없으면 한 번 등록한다. 동시에 부르면 같은 등록을 함께 기다린다. */
  private async credential(deadline: number): Promise<Credential | APNsResult> {
    if (this.#credential === undefined) this.#credential = readPushRelayCredential(this.options.home, this.options.url);
    if (this.#credential) return this.#credential;
    this.#registering ??= this.register(deadline).finally(() => { this.#registering = undefined; });
    return this.#registering;
  }

  private async register(deadline: number): Promise<Credential | APNsResult> {
    const wire = await this.post("/v1/installations", JSON.stringify({ protocol: PUSH_RELAY_PROTOCOL }), deadline);
    // 등록에 실패하면 알림은 보내지 않은 것이 확실하다: unknown 이 아니라 다시 시도로 둔다.
    if (wire.type !== "response") {
      if (wire.reason === "shutdown") return { state: "unavailable", reason: "shutdown" };
      this.#networkErrorAt = this.now();
      return { state: "retry", reason: wire.reason };
    }
    this.#networkErrorAt = undefined;
    const now = this.now();
    if (wire.status === 200 || wire.status === 201) {
      const id = wire.body?.installationId, secret = wire.body?.secret;
      if (typeof id === "string" && ID.test(id) && typeof secret === "string" && SECRET.test(secret)) {
        const saved: RelayCredential = { v: 1, relay: this.options.url, installationId: id, secret, createdAt: new Date(now).toISOString() };
        writePushRelayCredential(this.options.home, saved);
        this.#credential = { ...saved };
        return { ...saved, fresh: true };
      }
      return this.suspend({ state: "unavailable", reason: "invalid_response", status: wire.status, retryAt: now + REJECT_HOLD_MS }, "network_error");
    }
    if (wire.status === 429) return this.suspend({ state: "unavailable", reason: "TooManyRequests", status: 429, retryAt: retryAfter(wire.headers, now, 60 * 60_000) }, "network_error");
    if (wire.status === 503 && (wire.body?.reason === "relay_off" || wire.body?.reason === "relay_unavailable")) {
      return this.suspend({ state: "unavailable", reason: "server_error", status: 503, retryAt: retryAfter(wire.headers, now, REJECT_HOLD_MS) }, "network_error");
    }
    if (wire.status >= 500) return { state: "retry", reason: "server_error", status: wire.status, retryAt: retryAfter(wire.headers, now, 0) };
    return this.suspend({ state: "unavailable", reason: wire.status === 401 || wire.status === 403 ? "auth_failed" : "invalid_response", status: wire.status,
      retryAt: retryAfter(wire.headers, now, REJECT_HOLD_MS) }, wire.status === 401 || wire.status === 403 ? "auth_failed" : "network_error");
  }

  /** 중계 응답 → 작업기가 아는 결과. 사유 값은 작업기의 허용 목록 안에서만 쓴다. */
  private classify(wire: Extract<Wire, { type: "response" }>): APNsResult {
    const now = this.now();
    const status = wire.status;
    if (status >= 200 && status < 300) return { state: "accepted", reason: "accepted", status: 200 };
    // 중계 시계로 이미 지난 알림. 기기 등록은 그대로 두고 그 알림만 끝낸다(410 이어도 토큰을 지우지 않는다).
    if ((wire.body?.reason === "expired" || wire.body?.error === "expired") && status >= 400 && status < 500) return { state: "expired", reason: "expired", status };
    if (status === 410) {
      // APNs 가 토큰을 버렸다(Unregistered·BadDeviceToken 등). 작업기가 그 기기 등록을 무효로 만든다(토큰을 지운다).
      const reason = INVALID_REASONS.find((value) => value === wire.body?.reason) ?? "Unregistered";
      const timestamp = wire.body?.timestamp;
      return { state: "invalid", reason, status: 410,
        ...(typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp >= 0 ? { invalidatedAt: timestamp } : {}) };
    }
    if (status === 400) return { state: "failed", reason: wire.body?.reason === "permanent_rejection" ? "permanent_rejection" : "invalid_payload", status };
    if (status === 413) return { state: "failed", reason: "PayloadTooLarge", status };
    if (status === 429) {
      const retryAt = retryAfter(wire.headers, now, RATE_HOLD_MS);
      // 한 iPhone(토큰)의 한도면 그 알림만 늦춘다. 설치(이 Mac)의 한도이거나 모르면 production 발신 전체를 쉰다.
      if (wire.body?.scope === "token") return { state: "retry", reason: "TooManyRequests", status, retryAt };
      return this.suspend({ state: "unavailable", reason: "TooManyRequests", status, retryAt }, "network_error");
    }
    if (status === 403) return this.suspend({ state: "unavailable", reason: "auth_failed", status, retryAt: retryAfter(wire.headers, now, REJECT_HOLD_MS) }, "auth_failed");
    // 중계 전체가 멈췄다(정지 스위치, APNs 키 문제로 쉬는 중): 이 알림만이 아니라 production 발신 전체를 정해진 시각까지 쉰다.
    if (status === 503 && (wire.body?.reason === "relay_off" || wire.body?.reason === "relay_unavailable")) {
      return this.suspend({ state: "unavailable", reason: "server_error", status, retryAt: retryAfter(wire.headers, now, REJECT_HOLD_MS) }, "network_error");
    }
    if (status === 500 || status === 502 || status === 503) return { state: "retry", reason: "server_error", status,
      ...(wire.headers.get("retry-after") ? { retryAt: retryAfter(wire.headers, now, 0) } : {}) };
    // 게이트웨이 시간 초과는 중계가 APNs 로 보냈는지 모른다. 다시 보내지 않는다.
    if (status === 504) return { state: "unknown", reason: "timeout", status };
    if (status >= 400 && status < 500 && status !== 404 && status !== 405) return { state: "failed", reason: "permanent_rejection", status };
    // 3xx·404·405·그 밖: 주소나 배포가 어긋났다. 알림을 버리지 않고 쉬었다가 다시 본다.
    if (status >= 500) return { state: "retry", reason: "server_error", status };
    return this.suspend({ state: "unavailable", reason: "invalid_response", status, retryAt: now + REJECT_HOLD_MS }, "network_error");
  }

  private async post(path: string, body: string, deadline: number, authorization?: string): Promise<Wire> {
    if (this.#closed) return { type: "not_sent", reason: "shutdown" };
    const controller = new AbortController();
    this.#inflight.add(controller);
    try {
      // close() 로 끊기면 reason "shutdown"(연결 전이면 not_sent, 뒤면 unknown). networkResult·register 가 다룬다.
      return await exchange(this.target, path, body, authorization, deadline - this.now(), controller.signal, this.options.tlsCa);
    } finally {
      this.#inflight.delete(controller);
    }
  }
}

/**
 * 중계로 보내는 본문(프로토콜 1). 문구는 싣지 않는다. 중계가 kind 별 고정 문구와
 * 출시 앱이 읽는 iamceo:{v,serverId,eventId,kind,target} 을 직접 만든다(buildAPNsPayload 와 같은 모양).
 * target 은 여기서 허용 목록으로 다시 만든 것만 보낸다.
 */
export function relayPushBody(notification: APNsNotification): Record<string, unknown> {
  const payload = buildAPNsPayload(notification);
  return {
    token: notification.deviceToken.toLowerCase(),
    kind: notification.kind,
    id: notification.deliveryId.toLowerCase(),
    eventId: payload.iamceo.eventId,
    serverId: payload.iamceo.serverId,
    target: payload.iamceo.target,
    expiresAt: notification.expiresAt,
    ...(notification.kind === "report_complete" && notification.reportSummary ? { summary: true } : {}),
  };
}

type Sender = Pick<APNsClient, "send" | "status" | "close">;
export interface PushClientOptions {
  home: string;
  /** config.json 의 pushRelay. false 면 중계를 쓰지 않는다. 없으면 켬. */
  relay?: boolean;
  /** config.json 의 pushRelayUrl(검사를 거친 값). 없으면 DEFAULT_PUSH_RELAY_URL. */
  relayUrl?: string | null;
  /** 시험만 넣는다. */
  apnsConfig?: APNsConfig;
  direct?: Sender;
  relayOptions?: Omit<RelayClientOptions, "home" | "url">;
}

/**
 * 환경마다 길을 고른다. ① apns.json 에 그 환경의 키가 적혀 있으면(오류여도) 직접 보낸다(지금과 같음).
 * ② production 에 키가 없고 중계가 켜져 있고 주소가 있으면 중계. ③ 그 밖은 지금처럼 unconfigured.
 * sandbox(Xcode 개발 빌드)는 중계로 보내지 않는다.
 */
export class PushRouter {
  constructor(private readonly direct: Sender, readonly relay: RelayClient | null) {}
  status(): PushProviderStatus[] {
    return this.direct.status().map((provider) => {
      if (provider.environment === "production" && this.relay) return this.relay.status();
      return provider.state === "unconfigured" ? provider : { ...provider, via: "key" as const };
    });
  }
  send(notification: APNsNotification): Promise<APNsResult> {
    if (notification.environment === "production" && this.relay) return this.relay.send(notification);
    return this.direct.send(notification);
  }
  close(): void {
    try { this.direct.close(); } finally { this.relay?.close(); }
  }
}

/**
 * 서버가 뜰 때 쓰는 중계 설정. 시험 모드(IAMCEO_TEST=1)에서는 config.json 에 pushRelayUrl 을 직접 적었을 때만 중계를 쓴다:
 * 라이브 DB 사본으로 띄운 시험 서버에는 대표의 실제 기기 토큰이 들어 있어, 기본 주소로 보내면 진짜 iPhone 에 알림이 간다.
 */
export function serverPushRelayOptions(config: { pushRelay?: boolean; pushRelayUrl?: string }, env: Record<string, string | undefined> = process.env): Pick<PushClientOptions, "relay" | "relayUrl"> {
  if (config.pushRelay === false) return { relay: false };
  if (env.IAMCEO_TEST === "1" && !config.pushRelayUrl) return { relay: false };
  return { relay: true, relayUrl: config.pushRelayUrl ?? null };
}

export function createPushClient(options: PushClientOptions): PushRouter {
  const config = options.apnsConfig ?? loadAPNsConfig(options.home);
  const direct = options.direct ?? new APNsClient(config);
  const production = config.providers.find((provider) => provider.environment === "production");
  const url = options.relayUrl ?? DEFAULT_PUSH_RELAY_URL;
  // 키 파일이 깨졌으면(configuration_error) 사용자가 직접 키를 쓰려던 것이다. 몰래 중계로 돌리지 않는다.
  const useRelay = options.relay !== false && !!url && production?.state === "unconfigured";
  return new PushRouter(direct, useRelay ? new RelayClient({ ...options.relayOptions, home: options.home, url: normalizePushRelayUrl(url) }) : null);
}
