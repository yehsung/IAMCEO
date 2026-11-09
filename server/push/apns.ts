import { sign } from "node:crypto";
import { connect, constants } from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http2";
import type { PushEnvironment, PushProviderStatus } from "../../shared/push.ts";
import type { PushEventTarget, PushKind, PushPayload } from "./contracts.ts";
import type { APNsConfig, APNsCredential } from "./config.ts";

export const APNS_ORIGINS = Object.freeze({ sandbox: "https://api.sandbox.push.apple.com:443", production: "https://api.push.apple.com:443" });
export const APNS_TTL_MS = Object.freeze({ decision: 3_600_000, approval_wait: 900_000, error: 900_000, report_complete: 3_600_000, todo_created: 3_600_000, report_blocked: 900_000, test: 300_000 });

export interface APNsNotification {
  environment: PushEnvironment;
  deviceToken: string;
  deliveryId: string;
  eventId: string;
  serverId: string;
  kind: PushKind | "test";
  target: PushEventTarget;
  occurredAt: string;
  expiresAt: string;
  reportSummary?: boolean;
}
export type APNsTransportResult =
  | { type: "response"; status: number; headers: IncomingHttpHeaders; body: string }
  | { type: "not_sent" | "unknown"; reason: "network_error" | "timeout" | "goaway" | "shutdown" | "invalid_response" };
export interface APNsTransportRequest {
  credential: APNsCredential;
  headers: OutgoingHttpHeaders;
  body: string;
  timeoutMs: number;
}
/** Injection is the only test origin override. Production config cannot set hosts/TLS. */
export interface APNsTransport {
  send(request: APNsTransportRequest): Promise<APNsTransportResult>;
  close(): void;
}
export type APNsResult = {
  state: "accepted" | "invalid" | "retry" | "failed" | "unknown" | "expired" | "unavailable";
  reason: string;
  status?: number;
  invalidatedAt?: number;
  retryAt?: number;
};

class ProviderError extends Error {
  constructor(readonly code: "clock_rollback" | "invalid_key") { super(code); }
}

/** Signing is synchronous, so concurrent callers share the same refresh atomically. */
export class APNsTokenCache {
  #token: string | undefined;
  #issuedAt = 0;
  #lastNow = 0;
  constructor(private readonly credential: APNsCredential, private readonly now: () => number = Date.now) {}
  get(): string {
    const now = this.time();
    if (!this.#token || now - this.#issuedAt >= 50 * 60_000) this.generate(now);
    return this.#token!;
  }
  /** Only a definite rejection of the current token can request an early refresh. */
  refreshExpired(rejectedToken: string): boolean {
    const now = this.time();
    if (this.#token !== rejectedToken) return true;
    if (now - this.#issuedAt < 20 * 60_000) return false;
    this.generate(now);
    return true;
  }
  nextRefreshAt(): number { return this.#issuedAt + 20 * 60_000; }
  private time(): number {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0 || now < this.#lastNow - 60_000 || (this.#token && Math.floor(now / 1000) < Math.floor(this.#issuedAt / 1000))) throw new ProviderError("clock_rollback");
    this.#lastNow = Math.max(this.#lastNow, now);
    return now;
  }
  private generate(now: number): void {
    try {
      const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: this.credential.keyId })).toString("base64url");
      const claims = Buffer.from(JSON.stringify({ iss: this.credential.teamId, iat: Math.floor(now / 1000) })).toString("base64url");
      const input = `${header}.${claims}`;
      const signature = sign("sha256", Buffer.from(input), { key: this.credential.key, dsaEncoding: "ieee-p1363" });
      if (signature.length !== 64) throw new Error();
      this.#token = `${input}.${signature.toString("base64url")}`;
      this.#issuedAt = now;
    } catch { throw new ProviderError("invalid_key"); }
  }
}

function uuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function id(value: string): boolean { return /^[A-Za-z0-9_-]{1,200}$/.test(value); }

/** Reconstruct allowlisted fields; extra properties from persisted objects never escape. */
export function buildAPNsPayload(notification: APNsNotification): PushPayload {
  if (!uuid(notification.serverId) || !uuid(notification.eventId)) throw new Error("invalid_payload");
  let target: PushEventTarget;
  const hint = notification.target;
  switch (notification.kind) {
    case "decision":
      if (hint.screen !== "inbox" || !id(hint.projectId) || !id(hint.decisionId)) throw new Error("invalid_payload");
      target = { screen: "inbox", projectId: hint.projectId, decisionId: hint.decisionId };
      break;
    case "approval_wait": case "error":
      if (hint.screen !== "team" || !id(hint.projectId) || !id(hint.memberId)) throw new Error("invalid_payload");
      target = { screen: "team", projectId: hint.projectId, memberId: hint.memberId };
      break;
    case "report_complete": case "report_blocked":
      if (hint.screen !== "chat" || !id(hint.projectId) || !id(hint.messageId) ||
          (hint.memberId !== null && !id(hint.memberId)) || (hint.groupId !== undefined && !uuid(hint.groupId))) throw new Error("invalid_payload");
      target = { screen: "chat", projectId: hint.projectId, memberId: hint.memberId, messageId: hint.messageId,
        ...(hint.groupId === undefined ? {} : { groupId: hint.groupId }) };
      break;
    case "todo_created":
      if (hint.screen !== "home" || !("projectId" in hint) || !id(hint.projectId)) throw new Error("invalid_payload");
      target = { screen: "home", projectId: hint.projectId };
      break;
    case "test":
      if (hint.screen !== "home") throw new Error("invalid_payload");
      target = { screen: "home" };
      break;
    default: throw new Error("invalid_payload");
  }
  const bodies = { decision: "새 결재가 도착했습니다.", approval_wait: "진행을 위해 직접 확인이 필요합니다.",
    error: "실행 문제를 확인해 주세요.", report_complete: "완료 보고가 도착했습니다.", todo_created: "대표 할 일이 생겼습니다.", report_blocked: "막힘 보고를 확인해 주세요.", test: "iPhone 알림 연결을 확인합니다." };
  return { aps: { alert: { title: "IAMCEO", body: notification.kind === "report_complete" && notification.reportSummary ? "추가 완료 보고가 도착했습니다." : bodies[notification.kind] }, sound: "default", "thread-id": `iamceo:${notification.serverId}` },
    iamceo: { v: 1, serverId: notification.serverId, eventId: notification.eventId, kind: notification.kind, target } };
}

/** Shared serialization guard, including the UTF-8 (not JS string length) limit. */
export function serializeAPNsPayload(payload: PushPayload): string {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > 4096) throw new Error("payload_too_large");
  return body;
}

type Connector = (origin: string, options: { servername: string; rejectUnauthorized: true; ALPNProtocols: string[] }) => ClientHttp2Session;
interface Connection { session: ClientHttp2Session; draining: boolean; ready: Promise<boolean>; failed: boolean }

export class HTTP2APNsTransport implements APNsTransport {
  #connections = new Map<string, Connection>();
  #sessions = new Set<ClientHttp2Session>();
  #failures = new Map<string, { count: number; until: number }>();
  #closed = false;
  constructor(private readonly connector: Connector = (origin, options) => connect(origin, options), private readonly now: () => number = Date.now) {}
  private backoff(key: string): void {
    const count = Math.min(7, (this.#failures.get(key)?.count ?? 0) + 1);
    this.#failures.set(key, { count, until: this.now() + Math.min(60_000, 1000 * 2 ** (count - 1)) });
  }
  async send(request: APNsTransportRequest): Promise<APNsTransportResult> {
    if (this.#closed) return { type: "not_sent", reason: "shutdown" };
    const deadline = Date.now() + request.timeoutMs;
    let connection = this.#connections.get(request.credential.cacheKey);
    if (!connection || connection.draining || connection.session.closed || connection.session.destroyed) {
      if ((this.#failures.get(request.credential.cacheKey)?.until ?? 0) > this.now()) return { type: "not_sent", reason: "network_error" };
      try {
        const origin = APNS_ORIGINS[request.credential.environment];
        const session = this.connector(origin, { servername: new URL(origin).hostname, rejectUnauthorized: true, ALPNProtocols: ["h2"] });
        connection = { session, draining: false, ready: Promise.resolve(false), failed: false };
        this.#sessions.add(session);
        const entry = connection;
        const retire = () => {
          entry.draining = true;
          if (this.#connections.get(request.credential.cacheKey) === entry) this.#connections.delete(request.credential.cacheKey);
        };
        const failed = () => {
          if (!entry.failed && !this.#closed) { entry.failed = true; this.backoff(request.credential.cacheKey); }
          retire(); session.destroy();
        };
        session.on("error", failed); // Retire AND close failed TLS attempts before reconnecting.
        session.on("close", () => { retire(); this.#sessions.delete(session); });
        // Finish in-flight GOAWAY listeners before closing the retired session.
        session.on("goaway", () => { retire(); queueMicrotask(() => { if (!session.closed && !session.destroyed) session.close(); }); });
        this.#connections.set(request.credential.cacheKey, connection);
        // One handshake promise/listener set per session, shared by concurrent sends.
        entry.ready = new Promise<boolean>((resolve) => {
          if (!session.connecting) { resolve(!session.destroyed && session.alpnProtocol === "h2"); return; }
          let settled = false;
          const done = (ok: boolean) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            session.off("connect", connected); session.off("error", closed); session.off("close", closed);
            resolve(ok);
            if (!ok) failed();
          };
          const connected = () => done(session.alpnProtocol === "h2");
          const closed = () => done(false);
          const timer = setTimeout(() => done(false), Math.max(1, request.timeoutMs));
          session.once("connect", connected); session.once("error", closed); session.once("close", closed);
        }).then(ready => { if (ready) this.#failures.delete(request.credential.cacheKey); return ready; });
      } catch { this.backoff(request.credential.cacheKey); return { type: "not_sent", reason: "network_error" }; }
    }
    const { session } = connection;
    let failure: "network_error" | "timeout" = "network_error";
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { failure = "timeout"; resolve(false); }, Math.max(1, deadline - Date.now()));
      void connection.ready.then(ok => { clearTimeout(timer); resolve(ok); });
    });
    if (!ready || connection.draining || this.#closed || Date.now() >= deadline) {
      session.destroy();
      return { type: "not_sent", reason: this.#closed ? "shutdown" : Date.now() >= deadline ? "timeout" : failure };
    }
    return new Promise<APNsTransportResult>((resolve) => {
      let stream: ClientHttp2Stream | undefined;
      let settled = false;
      let headers: IncomingHttpHeaders | undefined;
      const chunks: Buffer[] = [];
      let bytes = 0;
      const finish = (result: APNsTransportResult) => {
        if (settled) return;
        settled = true; clearTimeout(timer); session.off("goaway", goaway); session.off("close", closed); session.off("error", closed);
        resolve(result);
        if (result.type !== "response" && stream && !stream.closed) stream.close(constants.NGHTTP2_CANCEL);
      };
      const closed = () => finish({ type: !stream || stream.rstCode === constants.NGHTTP2_REFUSED_STREAM ? "not_sent" : "unknown", reason: "network_error" });
      // Bun 1.3.14 exposes the local maximum ID instead of the peer's ID.
      // With our single stream that cannot prove nonprocessing: keep unknown.
      const goaway = (_code: number, lastStreamID: number) => finish({
        type: stream?.id !== undefined && stream.id > lastStreamID ? "not_sent" : "unknown", reason: "goaway",
      });
      const timer = setTimeout(() => finish({ type: stream ? "unknown" : "not_sent", reason: "timeout" }), Math.max(1, deadline - Date.now()));
      session.on("goaway", goaway); session.on("close", closed); session.on("error", closed);
      try {
        // request() itself can submit HEADERS. From here on, absence of a response is unknown.
        stream = session.request(request.headers);
        stream.on("response", (value) => { headers = value; });
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 8192) { finish({ type: "unknown", reason: "invalid_response" }); return; }
          chunks.push(Buffer.from(chunk));
        });
        stream.on("error", () => finish({ type: stream?.rstCode === constants.NGHTTP2_REFUSED_STREAM ? "not_sent" : "unknown", reason: "network_error" }));
        stream.on("close", () => { if (!settled) closed(); });
        stream.on("end", () => {
          // Bun can emit end before delivering a REFUSED_STREAM reset. Wait for
          // close/error to observe that proof rather than classifying it early.
          if (!headers) return;
          if (!Number.isInteger(headers[":status"])) { finish({ type: "unknown", reason: "invalid_response" }); return; }
          finish({ type: "response", status: Number(headers[":status"]), headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        stream.end(request.body);
      } catch { finish({ type: stream ? "unknown" : "not_sent", reason: "network_error" }); }
    });
  }
  close(): void {
    this.#closed = true;
    for (const session of this.#sessions) session.destroy();
    this.#sessions.clear();
    this.#connections.clear();
    this.#failures.clear();
  }
}

function retryAfter(headers: IncomingHttpHeaders, now: number): number | undefined {
  const value = headers["retry-after"];
  if (typeof value !== "string") return;
  if (/^\d+$/.test(value)) {
    const at = now + Number(value) * 1000;
    return Number.isSafeInteger(at) ? at : undefined;
  }
  // Do not let permissive Date.parse turn a malformed number into a date.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(now, at) : undefined;
}

/** Safe, allowlisted classification; response text and opaque reasons are discarded. */
export function classifyAPNsResponse(response: Extract<APNsTransportResult, { type: "response" }>, now = Date.now()): APNsResult {
  const status = response.status;
  if (status === 200) return { state: "accepted", reason: "accepted", status };
  let reason: unknown;
  let timestamp: unknown;
  try {
    const body: unknown = JSON.parse(response.body);
    if (body && typeof body === "object") { reason = (body as Record<string, unknown>).reason; timestamp = (body as Record<string, unknown>).timestamp; }
  } catch { /* Status is still a definite APNs rejection. */ }
  if ((status === 410 && (reason === "Unregistered" || reason === "ExpiredToken")) ||
      (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"))) {
    return { state: "invalid", reason, status,
      ...(typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp >= 0 ? { invalidatedAt: timestamp } : {}) };
  }
  if (reason === "TooManyProviderTokenUpdates") return { state: "unavailable", reason, status, retryAt: retryAfter(response.headers, now) };
  if (status === 403) return { state: "unavailable", reason: reason === "ExpiredProviderToken" ? reason : "auth_failed", status };
  if (status === 429 || status === 500 || status === 503) return { state: "retry", reason: status === 429 ? "TooManyRequests" : "server_error", status, retryAt: retryAfter(response.headers, now) };
  if (status >= 400 && status < 500) return { state: "failed", reason: status === 413 ? "PayloadTooLarge" : "permanent_rejection", status };
  return { state: "unknown", reason: "invalid_response", status };
}

export class APNsClient {
  #tokens = new Map<string, APNsTokenCache>();
  #tails = new Map<PushEnvironment, Promise<unknown>>();
  #suspended = new Map<PushEnvironment, APNsResult>();
  #networkErrors = new Set<PushEnvironment>();
  #closed = false;
  private readonly transport: APNsTransport;
  private readonly now: () => number;
  constructor(private readonly config: APNsConfig, private readonly options: { transport?: APNsTransport; now?: () => number; timeoutMs?: number } = {}) {
    this.transport = options.transport ?? new HTTP2APNsTransport();
    this.now = options.now ?? Date.now;
  }
  status(): PushProviderStatus[] {
    return this.config.providers.map((provider) => {
      const suspension = this.#suspended.get(provider.environment);
      if (suspension && (suspension.retryAt === undefined || suspension.retryAt > this.now())) return { ...provider,
        state: suspension.reason === "auth_failed" || suspension.reason === "invalid_key" ? "configuration_error" : "temporarily_unavailable",
        lastError: suspension.reason === "invalid_key" ? "invalid_key" : suspension.reason === "auth_failed" || suspension.reason === "ExpiredProviderToken" ? "auth_failed" : "network_error" };
      if (this.#networkErrors.has(provider.environment)) return { ...provider, state: "temporarily_unavailable", lastError: "network_error" };
      return { ...provider };
    });
  }
  send(notification: APNsNotification): Promise<APNsResult> {
    // Snapshot before queuing: callers cannot change a token or target while awaiting a stream.
    const snapshot = { ...notification, target: { ...notification.target } };
    const tail = this.#tails.get(notification.environment) ?? Promise.resolve();
    const result = tail.then(() => this.dispatch(snapshot));
    this.#tails.set(notification.environment, result.catch(() => {}));
    return result;
  }
  private async dispatch(notification: APNsNotification): Promise<APNsResult> {
    if (this.#closed) return { state: "unavailable", reason: "shutdown" };
    const credential = this.config.credentials[notification.environment];
    if (!credential) return { state: "unavailable", reason: "unconfigured" };
    const suspended = this.#suspended.get(notification.environment);
    if (suspended && (suspended.retryAt === undefined || suspended.retryAt > this.now())) return { ...suspended };
    this.#suspended.delete(notification.environment);
    const occurredAt = Date.parse(notification.occurredAt);
    const expiresAt = Date.parse(notification.expiresAt);
    if (!Number.isFinite(occurredAt) || !Number.isFinite(expiresAt) || expiresAt <= occurredAt ||
        expiresAt - occurredAt > APNS_TTL_MS[notification.kind]) return { state: "failed", reason: "invalid_expiration" };
    if (expiresAt <= this.now() || Math.floor(expiresAt / 1000) <= Math.floor(this.now() / 1000)) return { state: "expired", reason: "expired" };
    let body: string;
    try {
      if (!uuid(notification.deliveryId) || !/^(?:[0-9a-fA-F]{2}){1,512}$/.test(notification.deviceToken)) throw new Error();
      body = serializeAPNsPayload(buildAPNsPayload(notification));
    } catch { return { state: "failed", reason: "invalid_payload" }; }
    let tokens = this.#tokens.get(credential.cacheKey);
    if (!tokens) { tokens = new APNsTokenCache(credential, this.now); this.#tokens.set(credential.cacheKey, tokens); }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.#closed) return { state: "unavailable", reason: "shutdown" };
        if (Math.floor(expiresAt / 1000) <= Math.floor(this.now() / 1000)) return { state: "expired", reason: "expired" };
        const token = tokens.get();
        let response: APNsTransportResult;
        try {
          response = await this.transport.send({ credential, body, timeoutMs: Math.min(10_000, Math.max(1, this.options.timeoutMs ?? 10_000)), headers: {
            ":method": "POST", ":path": `/3/device/${notification.deviceToken.toLowerCase()}`, ":scheme": "https",
            ":authority": new URL(APNS_ORIGINS[notification.environment]).hostname,
            authorization: `bearer ${token}`, "apns-topic": credential.bundleId, "apns-push-type": "alert", "apns-priority": "10",
            "apns-id": notification.deliveryId, "apns-collapse-id": notification.eventId, "apns-expiration": String(Math.floor(expiresAt / 1000)),
            "content-type": "application/json",
          } });
        } catch { this.#networkErrors.add(notification.environment); return { state: "unknown", reason: "network_error" }; }
        if (response.type !== "response") {
          this.#networkErrors.add(notification.environment);
          return { state: response.type === "not_sent" ? "retry" : "unknown", reason: response.reason };
        }
        this.#networkErrors.delete(notification.environment);
        const result = classifyAPNsResponse(response, this.now());
        if (result.reason === "ExpiredProviderToken" && attempt === 0 && tokens.refreshExpired(token)) continue;
        if (result.state === "unavailable") {
          if (result.reason === "TooManyProviderTokenUpdates") result.retryAt = Math.max(result.retryAt ?? 0, tokens.nextRefreshAt(), this.now() + 60_000);
          this.#suspended.set(notification.environment, result);
        }
        return result;
      }
    } catch (error) {
      const reason = error instanceof ProviderError ? error.code : "invalid_key";
      const result: APNsResult = { state: "unavailable", reason,
        ...(reason === "clock_rollback" ? { retryAt: this.now() + 60_000 } : {}) };
      this.#suspended.set(notification.environment, result);
      return result;
    }
    return { state: "unavailable", reason: "auth_failed" };
  }
  close(): void { this.#closed = true; this.transport.close(); }
}
