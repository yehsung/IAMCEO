// 중계의 APNs 보내기. 연결·JWT·응답 분류는 Mac 서버의 코드(server/push/apns.ts)를 그대로 쓰고,
// 여럿이 함께 쓰는 중계에 맞게 세 가지만 다르게 한다(Mac 의 APNsClient 는 지금 동작 그대로 둔다):
//  1) 한 연결에서 동시에 여러 스트림을 연다(RELAY_APNS.maxInFlight). 한 건이 멈춰도 다른 사용자가 그 뒤에 줄 서지 않는다.
//  2) 자리가 날 때까지 기다리는 시간에 상한을 둔다(maxQueueWaitMs). 넘으면 APNs 로 보내지 않고 "다시 시도"로 답한다.
//  3) APNs 가 키를 거절(403)하거나 키를 읽지 못하면 영영 멈추지 않고 정해진 시간(authHoldMs) 뒤 다시 시도한다.
import { connect } from "node:http2";
import type { ClientHttp2Session } from "node:http2";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { APNS_ORIGINS, APNsTokenCache, HTTP2APNsTransport, classifyAPNsResponse } from "../../../server/push/apns.ts";
import type { APNsTransport, APNsTransportResult } from "../../../server/push/apns.ts";
import type { APNsCredential } from "../../../server/push/config.ts";
import type { PushRequest } from "./push-request.ts";
import { RELAY_APNS } from "./settings.ts";

export type InvalidReason = "Unregistered" | "ExpiredToken" | "BadDeviceToken" | "DeviceTokenNotForTopic";
export type SendOutcome =
  | { kind: "accepted" }
  /** 토큰이 더는 유효하지 않다. Mac 이 그 기기 등록을 지운다. */
  | { kind: "invalid"; reason: InvalidReason; timestamp?: number }
  /** APNs 가 이 토큰으로 너무 자주 보낸다고 했다(429 TooManyRequests). 그 알림만 늦춘다. */
  | { kind: "throttled"; retryAt?: number }
  /** 보내지 않았거나 APNs 가 잠시 받지 않았다. 다시 보내도 된다. */
  | { kind: "retry"; reason: "server_error" | "not_sent" | "busy" | "relay_unavailable"; retryAt?: number }
  /** 보냈는지 모른다. 다시 보내지 않는다(Mac 의 원칙). */
  | { kind: "unknown" }
  /** APNs 가 요청 자체를 거절했다(다시 보내도 같다). */
  | { kind: "rejected"; reason: "permanent_rejection" | "PayloadTooLarge" }
  | { kind: "expired" };

/** /healthz 에 싣는 마지막 APNs 결과의 종류. 사용자 정보는 넣지 않는다. */
export type LastResult = "none" | "accepted" | "token_rejected" | "rejected" | "auth_failed" | "key_error" | "server_error" | "network";

export interface APNsKeyInput { keyId: string | undefined; teamId: string | undefined; privateKey: string | undefined }

/** 비밀 값을 검사해 APNs 자격으로 만든다. 키 내용·오류 내용은 어디에도 남기지 않고 "key_error" 만 돌려준다. */
export function apnsCredential(input: APNsKeyInput, bundleId: string = RELAY_APNS.topic): APNsCredential | "key_error" {
  try {
    const { keyId, teamId, privateKey } = input;
    if (typeof keyId !== "string" || !/^[A-Z0-9]{10}$/.test(keyId.trim()) || typeof teamId !== "string" || !/^[A-Z0-9]{10}$/.test(teamId.trim()) ||
        typeof privateKey !== "string" || privateKey.length > 16_384 ||
        !/^\s*-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----\s*$/.test(privateKey)) return "key_error";
    const key = createPrivateKey({ key: privateKey, format: "pem", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return "key_error";
    const fingerprint = createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("hex");
    return Object.freeze({ environment: "production" as const, keyId: keyId.trim(), teamId: teamId.trim(), bundleId, key,
      cacheKey: ["production", teamId.trim(), keyId.trim(), bundleId, fingerprint].join(":") });
  } catch { return "key_error"; }
}

type Connector = (origin: string, options: { servername: string; rejectUnauthorized: true; ALPNProtocols: string[] }) => ClientHttp2Session;

export interface RelayAPNsOptions {
  /** 처음 보낼 때 한 번 부른다(비밀은 실행 중에만 읽을 수 있다). */
  credential: () => APNsCredential | "key_error";
  /** 시험만 넣는다. 기본은 api.push.apple.com 에 TLS(h2)로 붙는 Mac 과 같은 전송. */
  connector?: Connector;
  transport?: APNsTransport;
  now?: () => number;
  timeoutMs?: number;
  maxInFlight?: number;
  maxQueueWaitMs?: number;
  authHoldMs?: number;
  /** 사유 코드만 넘긴다(토큰·키·응답 본문은 넘기지 않는다). */
  onSuspend?: (reason: "auth_failed" | "key_error" | "TooManyProviderTokenUpdates" | "clock_rollback", until: number) => void;
}

interface Waiter { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }

export class RelayAPNs {
  readonly #transport: APNsTransport;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #maxInFlight: number;
  readonly #maxQueueWaitMs: number;
  readonly #authHoldMs: number;
  #credential: APNsCredential | "key_error" | undefined;
  #tokens: APNsTokenCache | undefined;
  #inFlight = 0;
  #waiters: Waiter[] = [];
  #suspendedUntil = 0;
  #suspendReason: "auth_failed" | "key_error" | "TooManyProviderTokenUpdates" | "clock_rollback" | undefined;
  #last: { result: LastResult; at: number } = { result: "none", at: 0 };
  #closed = false;

  constructor(private readonly options: RelayAPNsOptions) {
    const base: Connector = options.connector ?? ((origin, connectOptions) => connect(origin, connectOptions));
    const listeners = Math.max(32, (options.maxInFlight ?? RELAY_APNS.maxInFlight) * 4);
    // Mac 의 전송은 보내는 건마다 세션에 듣개를 단다. 동시 스트림이 많으면 Node 의 듣개 경고가 로그에 찍히므로 상한을 올린다.
    this.#transport = options.transport ?? new HTTP2APNsTransport((origin, connectOptions) => {
      const session = base(origin, connectOptions);
      session.setMaxListeners(listeners);
      return session;
    });
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? RELAY_APNS.timeoutMs);
    this.#maxInFlight = Math.max(1, options.maxInFlight ?? RELAY_APNS.maxInFlight);
    this.#maxQueueWaitMs = Math.max(0, options.maxQueueWaitMs ?? RELAY_APNS.maxQueueWaitMs);
    this.#authHoldMs = Math.max(1_000, options.authHoldMs ?? RELAY_APNS.authHoldMs);
  }

  /** /healthz 용. 키가 거절돼 쉬는 중이면 suspended. */
  health(): { suspended: boolean; reason: string | null; last: LastResult; lastAt: number } {
    const suspended = this.#suspendedUntil > this.#now();
    return { suspended, reason: suspended ? this.#suspendReason ?? null : null, last: this.#last.result, lastAt: this.#last.at };
  }

  /** 쉬는 중이면 풀리는 시각. */
  suspendedUntil(): number | undefined {
    return this.#suspendedUntil > this.#now() ? this.#suspendedUntil : undefined;
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(false); }
    this.#transport.close();
  }

  private remember(result: LastResult): void { this.#last = { result, at: this.#now() }; }

  private suspend(reason: "auth_failed" | "key_error" | "TooManyProviderTokenUpdates" | "clock_rollback", until: number): SendOutcome {
    const fresh = this.#suspendedUntil <= this.#now() || this.#suspendReason !== reason;
    this.#suspendedUntil = Math.max(this.#suspendedUntil, until);
    this.#suspendReason = reason;
    if (fresh) this.options.onSuspend?.(reason, this.#suspendedUntil);
    return { kind: "retry", reason: "relay_unavailable", retryAt: this.#suspendedUntil };
  }

  private credential(): APNsCredential | "key_error" {
    if (this.#credential === undefined || this.#credential === "key_error") this.#credential = this.options.credential();
    return this.#credential;
  }

  /** 동시 스트림 자리를 얻는다. 정해진 시간 안에 못 얻으면 false(보내지 않는다). */
  private acquire(): Promise<boolean> {
    if (this.#inFlight < this.#maxInFlight) { this.#inFlight++; return Promise.resolve(true); }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { resolve, timer: setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve(false);
      }, this.#maxQueueWaitMs) };
      this.#waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.#waiters.shift();
    if (next) { clearTimeout(next.timer); next.resolve(true); return; } // 자리를 그대로 넘긴다.
    this.#inFlight--;
  }

  async send(request: PushRequest): Promise<SendOutcome> {
    if (this.#closed) return { kind: "retry", reason: "not_sent" };
    const until = this.suspendedUntil();
    if (until !== undefined) return { kind: "retry", reason: "relay_unavailable", retryAt: until };
    const credential = this.credential();
    if (credential === "key_error") { this.remember("key_error"); return this.suspend("key_error", this.#now() + this.#authHoldMs); }
    this.#tokens ??= new APNsTokenCache(credential, this.#now);
    if (!(await this.acquire())) return { kind: "retry", reason: "busy" };
    try {
      return await this.dispatch(credential, this.#tokens, request);
    } finally { this.release(); }
  }

  private async dispatch(credential: APNsCredential, tokens: APNsTokenCache, request: PushRequest): Promise<SendOutcome> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.#closed) return { kind: "retry", reason: "not_sent" };
      // 줄 서는 동안 다른 요청이 키 거절을 받았으면 보내지 않는다.
      const until = this.suspendedUntil();
      if (until !== undefined) return { kind: "retry", reason: "relay_unavailable", retryAt: until };
      if (Math.floor(request.expiresAt / 1000) <= Math.floor(this.#now() / 1000)) return { kind: "expired" };
      let jwt: string;
      try { jwt = tokens.get(); } catch (error) {
        // APNsTokenCache 는 시계가 뒤로 가면 clock_rollback, 서명에 실패하면 invalid_key 를 던진다.
        if ((error as Error)?.message === "clock_rollback") return this.suspend("clock_rollback", this.#now() + 60_000);
        this.remember("key_error");
        return this.suspend("key_error", this.#now() + this.#authHoldMs);
      }
      let response: APNsTransportResult;
      try {
        response = await this.#transport.send({ credential, body: request.payload, timeoutMs: this.#timeoutMs, headers: {
          ":method": "POST", ":path": `/3/device/${request.token}`, ":scheme": "https",
          ":authority": new URL(APNS_ORIGINS.production).hostname,
          authorization: `bearer ${jwt}`, "apns-topic": credential.bundleId, "apns-push-type": "alert", "apns-priority": "10",
          "apns-id": request.id, "apns-collapse-id": request.eventId, "apns-expiration": String(Math.floor(request.expiresAt / 1000)),
          "content-type": "application/json",
        } });
      } catch { this.remember("network"); return { kind: "unknown" }; }
      if (response.type !== "response") {
        this.remember("network");
        return response.type === "not_sent" ? { kind: "retry", reason: "not_sent" } : { kind: "unknown" };
      }
      const result = classifyAPNsResponse(response, this.#now());
      if (result.reason === "ExpiredProviderToken" && attempt === 0 && tokens.refreshExpired(jwt)) continue;
      switch (result.state) {
        case "accepted": this.remember("accepted"); return { kind: "accepted" };
        case "invalid":
          this.remember("token_rejected");
          return { kind: "invalid", reason: result.reason as InvalidReason, ...(result.invalidatedAt !== undefined ? { timestamp: result.invalidatedAt } : {}) };
        case "unavailable":
          if (result.reason === "TooManyProviderTokenUpdates") {
            return this.suspend("TooManyProviderTokenUpdates", Math.max(result.retryAt ?? 0, tokens.nextRefreshAt(), this.#now() + 60_000));
          }
          this.remember("auth_failed");
          return this.suspend("auth_failed", this.#now() + this.#authHoldMs);
        case "retry":
          if (result.reason === "TooManyRequests") { this.remember("rejected"); return { kind: "throttled", ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}) }; }
          this.remember("server_error");
          return { kind: "retry", reason: "server_error", ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}) };
        case "failed":
          this.remember("rejected");
          return { kind: "rejected", reason: result.reason === "PayloadTooLarge" ? "PayloadTooLarge" : "permanent_rejection" };
        default:
          this.remember("network");
          return { kind: "unknown" };
      }
    }
    // 새 JWT 로도 ExpiredProviderToken 이면 키 문제로 본다.
    this.remember("auth_failed");
    return this.suspend("auth_failed", this.#now() + this.#authHoldMs);
  }
}
