// 중계의 HTTP 동작(프레임워크와 무관한 핵심). index.ts 가 Firebase 함수에 붙이고, 시험은 이것을 바로 부른다.
//
// 경로(프로토콜 1, Mac 의 server/push/relay.ts 와 함께 지킨다):
//   POST /v1/installations            → 201 { installationId, secret }       계정·메일 없음. 본문은 보지 않는다.
//                                        (+ X-Relay-Forwarded-Count: 앞단이 넘긴 X-Forwarded-For 값의 개수. 배포 확인용)
//                                        한도: 429 { reason, scope:"installation" }(그 IP 의 하루 몫) · 503 { reason:"relay_busy" }(전체 시간 한도)
//   POST /v1/push  Authorization: Bearer <installationId>.<secret>
//        { token, kind, id, eventId, serverId, target, expiresAt?, summary? }
//     200 { state:"accepted" }                     APNs 가 받았다
//     400 { state:"failed", reason }               요청이 틀렸다(다시 보내도 같다). reason: invalid_request·expired·permanent_rejection
//     401 { reason:"unauthorized" }                설치 자격이 없다(Mac 은 한 번 다시 등록한다)
//     403 { reason:"blocked"|"not_allowed" }       + Retry-After. 막힌 설치, 또는 '허용 설치만' 상태
//     410 { state:"invalid", reason, timestamp? }  토큰이 더는 유효하지 않다(Mac 이 그 토큰을 지운다)
//     413 { state:"failed", reason }               본문이 너무 크다
//     429 { reason, scope }                        + Retry-After. scope: installation(이 Mac)·token(그 iPhone 알림만 늦춤)
//     503 { reason }                               (+ Retry-After) 보내지 않았다·APNs 가 잠시 못 받는다. 다시 보내도 된다
//     504 { state:"unknown" }                      보냈는지 모른다. 다시 보내지 않는다
//   GET /healthz                                   200/503 { ok, mode, apns:{ suspended, reason, last, lastAt } } — 사용자 정보 없음
//
// 기록하지 않는 것: 토큰, IP, Authorization, 본문, serverId·eventId·대상 ID. 오류 기록은 설치 ID·사유 코드·시각만.
import { createInstallation, validMaster, verifyAuthorization } from "./credentials.ts";
import { RelayLimits, clientIp, forwardedFor } from "./limits.ts";
import type { Denied } from "./limits.ts";
import { parsePushRequest } from "./push-request.ts";
import type { RelayAPNs, SendOutcome } from "./apns-sender.ts";
import { MAX_BODY_BYTES, RETRY_AFTER } from "./settings.ts";

export type RelayMode = "open" | "allowlist" | "off";
export interface RelaySettings {
  master: string | undefined;
  /** open(누구나) · allowlist(허용 설치만, 처음 실제 시험용) · off(전체 정지). 모르는 값이면 off. */
  mode: string | undefined;
  /** 쉼표로 나눈 설치 ID 목록. */
  allowed?: string | undefined;
  blocked?: string | undefined;
}

export type LogEntry =
  | { severity: "WARNING"; message: "apns_result"; installationId: string; reason: string }
  | { severity: "ERROR"; message: "apns_suspended"; reason: string; until: string }
  | { severity: "WARNING"; message: "installation_suspended"; installationId: string; reason: "error_budget"; until: string }
  | { severity: "INFO"; message: "relay_hourly"; hour: string; counts: Record<string, number> }
  | { severity: "ERROR"; message: "config_invalid"; name: string }
  | { severity: "ERROR"; message: "internal_error" };

export interface RelayRequest {
  method: string;
  /** 경로(쿼리가 붙어 있어도 된다. 쓰지 않는다). */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer | undefined;
}
export interface RelayResponse { status: number; headers: Record<string, string>; body: string }

export interface RelayDeps {
  /** 처음 요청 때 한 번 읽는다(비밀은 실행 중에만 읽을 수 있다). */
  settings: () => RelaySettings;
  apns: Pick<RelayAPNs, "send" | "health">;
  limits?: RelayLimits;
  now?: () => number;
  log?: (entry: LogEntry) => void;
  uuid?: () => string;
}

interface Config { master: string | undefined; mode: RelayMode; allowed: Set<string>; blocked: Set<string> }

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function header(headers: RelayRequest["headers"], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Cloud Run 주소(/v1/push)와 cloudfunctions.net 주소(…/relay/v1/push)를 같은 경로로 본다. */
export function normalizePath(path: string): string {
  let value = path.split("?")[0]!.split("#")[0]!;
  if (value.length > 1) value = value.replace(/\/+$/, "");
  if (value === "/relay" || value.startsWith("/relay/")) value = value.slice("/relay".length) || "/";
  return value || "/";
}

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): RelayResponse {
  return { status, body: JSON.stringify(body), headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } };
}

function retryAfter(at: number, now: number): Record<string, string> {
  return { "retry-after": String(Math.max(1, Math.ceil((at - now) / 1000))) };
}

export class Relay {
  readonly #settings: () => RelaySettings;
  readonly #apns: RelayDeps["apns"];
  readonly #limits: RelayLimits;
  readonly #now: () => number;
  readonly #log: (entry: LogEntry) => void;
  readonly #uuid: (() => string) | undefined;
  #config: Config | undefined;
  #hour = -1;
  #counts: Record<string, number> = {};
  #ipGroups = new Set<string>();

  constructor(deps: RelayDeps) {
    this.#settings = deps.settings;
    this.#apns = deps.apns;
    this.#limits = deps.limits ?? new RelayLimits();
    this.#now = deps.now ?? Date.now;
    this.#log = deps.log ?? (() => {});
    this.#uuid = deps.uuid;
  }

  /** 들어온 요청 하나. 절대 던지지 않는다(던지면 프레임워크가 오류 내용을 로그에 남긴다). */
  async handle(request: RelayRequest): Promise<RelayResponse> {
    try {
      const now = this.#now();
      this.roll(now);
      const path = normalizePath(request.path);
      const method = request.method.toUpperCase();
      if (path === "/healthz") return method === "GET" || method === "HEAD" ? this.health() : json(405, { reason: "method_not_allowed" }, { allow: "GET, HEAD" });
      if (path === "/v1/installations") return method === "POST" ? this.create(request, now) : json(405, { reason: "method_not_allowed" }, { allow: "POST" });
      if (path === "/v1/push") return method === "POST" ? await this.push(request, now) : json(405, { reason: "method_not_allowed" }, { allow: "POST" });
      return json(404, { reason: "not_found" });
    } catch {
      this.#log({ severity: "ERROR", message: "internal_error" });
      return json(500, { reason: "internal_error" });
    }
  }

  private count(name: string): void { this.#counts[name] = (this.#counts[name] ?? 0) + 1; }

  /** 시간이 바뀌면 지난 시간의 합계를 한 줄 남긴다(타이머 없음: 요청이 없으면 CPU 도 없다). */
  private roll(now: number): void {
    const hour = Math.floor(now / 3_600_000);
    if (hour === this.#hour) return;
    if (this.#ipGroups.size) this.#counts.create_ip_groups = this.#ipGroups.size;
    if (this.#hour >= 0 && Object.keys(this.#counts).length) {
      this.#log({ severity: "INFO", message: "relay_hourly", hour: new Date(this.#hour * 3_600_000).toISOString(), counts: this.#counts });
    }
    this.#hour = hour;
    this.#counts = {};
    this.#ipGroups = new Set();
  }

  private config(): Config {
    if (this.#config) return this.#config;
    let settings: RelaySettings;
    try { settings = this.#settings(); } catch { settings = { master: undefined, mode: undefined }; }
    const master = validMaster(settings.master) ? settings.master.trim() : undefined;
    if (!master) this.#log({ severity: "ERROR", message: "config_invalid", name: "RELAY_MASTER" });
    let mode = (settings.mode ?? "").trim().toLowerCase();
    if (mode !== "open" && mode !== "allowlist" && mode !== "off") {
      this.#log({ severity: "ERROR", message: "config_invalid", name: "RELAY_MODE" });
      mode = "off";
    }
    const ids = (value: string | undefined, name: string): Set<string> => {
      const items = (value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
      if (items.some((item) => !ID.test(item))) this.#log({ severity: "ERROR", message: "config_invalid", name });
      return new Set(items.filter((item) => ID.test(item)));
    };
    this.#config = { master, mode: mode as RelayMode, allowed: ids(settings.allowed, "RELAY_ALLOWED_INSTALLATIONS"),
      blocked: ids(settings.blocked, "RELAY_BLOCKED_INSTALLATIONS") };
    return this.#config;
  }

  private unavailable(config: Config, now: number): RelayResponse | undefined {
    if (config.mode === "off") return json(503, { reason: "relay_off" }, retryAfter(now + RETRY_AFTER.off * 1000, now));
    if (!config.master) return json(503, { reason: "relay_unavailable" }, retryAfter(now + RETRY_AFTER.configError * 1000, now));
    return undefined;
  }

  private health(): RelayResponse {
    const config = this.config();
    const apns = this.#apns.health();
    const ok = config.mode !== "off" && !!config.master && !apns.suspended;
    return json(ok ? 200 : 503, { ok, mode: config.mode, apns: { suspended: apns.suspended, reason: apns.reason, last: apns.last,
      lastAt: apns.lastAt > 0 ? new Date(Math.floor(apns.lastAt / 60_000) * 60_000).toISOString() : null } });
  }

  private create(request: RelayRequest, now: number): RelayResponse {
    this.count("create_received");
    const config = this.config();
    const down = this.unavailable(config, now);
    if (down) return down;
    if ((request.body?.length ?? 0) > MAX_BODY_BYTES) return json(413, { reason: "too_large" });
    const ip = clientIp(request.headers);
    // 진단(값은 남기지 않는다): X-Forwarded-For 의 값 개수(Mac 은 보내지 않으므로 앞단이 몇 개를 붙이는지 안다. settings.ts
    // 의 RELAY_CLIENT_IP), 이번 시간에 설치를 만든 서로 다른 IP 묶음의 수(늘 1이면 앞단이 붙인 값을 잘못 고른 것이다).
    const hops = forwardedFor(request.headers).length;
    this.count(hops === 0 ? "create_xff_none" : hops >= 3 ? "create_xff_3plus" : `create_xff_${hops}`);
    // 배포 직후 확인용(README 배포 9단계): 이 요청의 X-Forwarded-For 값 개수. 값 자체는 돌려주지 않는다.
    const hopsHeader = { "x-relay-forwarded-count": String(hops) };
    const key = this.#limits.ipKey(ip, now);
    if (!key) this.count("create_no_ip");
    else if (this.#ipGroups.size < 10_000) this.#ipGroups.add(key); // 거절되는 요청이 몰려도 메모리가 늘지 않게
    const allowed = this.#limits.allowCreate(ip, now);
    if (!allowed.ok) {
      this.count(`create_limited_${allowed.scope}`);
      const response = this.limited(allowed, now);
      return { ...response, headers: { ...response.headers, ...hopsHeader } };
    }
    const created = createInstallation(config.master!, this.#uuid);
    this.count("created");
    return json(201, created, hopsHeader);
  }

  private limited(denied: Denied, now: number, reason = "rate_limited"): RelayResponse {
    // 인스턴스 전체 한도는 이 Mac 의 잘못이 아니다: 503(그 알림만 다시 시도)으로 답한다.
    if (denied.scope === "global") return json(503, { reason: "relay_busy" }, retryAfter(denied.retryAt, now));
    const scope = denied.scope === "token" ? "token" : "installation";
    return json(429, { reason, scope }, retryAfter(denied.retryAt, now));
  }

  private async push(request: RelayRequest, now: number): Promise<RelayResponse> {
    this.count("push_received");
    const config = this.config();
    const down = this.unavailable(config, now);
    if (down) return down;
    const installationId = verifyAuthorization(config.master!, header(request.headers, "authorization"));
    if (!installationId) { this.count("unauthorized"); return json(401, { reason: "unauthorized" }, { "www-authenticate": "Bearer" }); }
    if (config.blocked.has(installationId)) {
      this.count("blocked");
      return json(403, { reason: "blocked" }, retryAfter(now + RETRY_AFTER.blocked * 1000, now));
    }
    if (config.mode === "allowlist" && !config.allowed.has(installationId)) {
      this.count("not_allowed");
      return json(403, { reason: "not_allowed" }, retryAfter(now + RETRY_AFTER.notAllowed * 1000, now));
    }
    const suspended = this.#limits.suspendedUntil(installationId, now);
    if (suspended !== undefined) { this.count("suspended"); return json(429, { reason: "error_budget", scope: "installation" }, retryAfter(suspended, now)); }
    if ((request.body?.length ?? 0) > MAX_BODY_BYTES) { this.count("bad_request"); return json(413, { state: "failed", reason: "too_large" }); }
    const parsed = parsePushRequest(request.body?.toString("utf8") ?? "", now);
    if (!parsed.ok) { this.count("bad_request"); return json(400, { state: "failed", reason: parsed.reason }); }
    const allowed = this.#limits.allowSend(installationId, parsed.value.token, now);
    if (!allowed.ok) { this.count(`limited_${allowed.scope}`); return this.limited(allowed, now); }
    let outcome: SendOutcome;
    try { outcome = await this.#apns.send(parsed.value); } catch { outcome = { kind: "unknown" }; }
    return this.answer(installationId, outcome);
  }

  private answer(installationId: string, outcome: SendOutcome): RelayResponse {
    const now = this.#now();
    this.count(outcome.kind === "retry" ? `retry_${outcome.reason}` : outcome.kind);
    const note = (reason: string) => this.#log({ severity: "WARNING", message: "apns_result", installationId, reason });
    switch (outcome.kind) {
      case "accepted": return json(200, { state: "accepted" });
      case "invalid": {
        note(outcome.reason);
        const until = this.#limits.recordTokenError(installationId, now);
        if (until !== undefined) this.#log({ severity: "WARNING", message: "installation_suspended", installationId, reason: "error_budget", until: new Date(until).toISOString() });
        return json(410, { state: "invalid", reason: outcome.reason, ...(outcome.timestamp !== undefined ? { timestamp: outcome.timestamp } : {}) });
      }
      case "throttled":
        note("TooManyRequests");
        return json(429, { reason: "TooManyRequests", scope: "token" }, retryAfter(outcome.retryAt ?? now + RETRY_AFTER.apnsThrottle * 1000, now));
      case "retry":
        if (outcome.reason === "server_error" || outcome.reason === "not_sent") note(outcome.reason);
        return json(503, { reason: outcome.reason === "server_error" ? "apns_unavailable" : outcome.reason === "busy" ? "relay_busy" : outcome.reason },
          outcome.retryAt !== undefined ? retryAfter(outcome.retryAt, now) : outcome.reason === "busy" ? retryAfter(now + RETRY_AFTER.busy * 1000, now) : {});
      case "rejected":
        note(outcome.reason);
        return json(outcome.reason === "PayloadTooLarge" ? 413 : 400, { state: "failed", reason: outcome.reason });
      case "expired": return json(400, { state: "failed", reason: "expired" });
      default:
        note("unknown");
        return json(504, { state: "unknown" });
    }
  }
}

export function createRelay(deps: RelayDeps): Relay { return new Relay(deps); }
