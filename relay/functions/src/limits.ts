// 남용 막기. 모든 수는 이 인스턴스의 메모리에서만 센다. 디스크·DB·로그에 쓰지 않는다.
// 토큰과 IP 는 원문을 열쇠로 쓰지 않는다: 날마다 새로 만드는 무작위 메모리 비밀로 HMAC 한 값(16바이트)만 쓴다.
// 그 비밀은 어디에도 저장하지 않으므로 날이 바뀌면(또는 인스턴스가 내려가면) 지난 값과 다시 이을 수 없다.
import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { RELAY_CLIENT_IP, RELAY_LIMITS } from "./settings.ts";

export type LimitScope = "installation" | "token" | "ip" | "global" | "error_budget";
export interface Denied { ok: false; scope: LimitScope; retryAt: number }
export type LimitResult = { ok: true } | Denied;

const DAY = 86_400_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

interface Window { start: number; count: number }

/**
 * 고정 창 계수기. 표가 차면 지난 창을 지우고, 그래도 차 있으면 기본은 거절한다(실패하면 닫는 쪽).
 * failOpen 이면 그때 세지 않고 통과시킨다(IP 표: 남이 표를 채워 정상 사용자를 막지 못하게).
 */
class Counter {
  readonly #entries = new Map<string, Window>();
  constructor(private readonly windowMs: number, private readonly limit: number, private readonly maxEntries: number,
    private readonly failOpen = false) {}
  /** 이번 창에서 한 건 더 받을 수 있는지. 세지는 않는다. 창 시작은 UTC 기준 windowMs 단위(분·시·날)로 맞춘다. */
  peek(key: string, now: number): { ok: boolean; retryAt: number } {
    const start = Math.floor(now / this.windowMs) * this.windowMs;
    const entry = this.#entries.get(key);
    return { ok: !entry || entry.start !== start || entry.count < this.limit, retryAt: start + this.windowMs };
  }
  take(key: string, now: number): { ok: boolean; retryAt: number } {
    const start = Math.floor(now / this.windowMs) * this.windowMs;
    const retryAt = start + this.windowMs;
    let entry = this.#entries.get(key);
    if (!entry || entry.start !== start) {
      if (!entry && this.#entries.size >= this.maxEntries) this.prune(start);
      if (!entry && this.#entries.size >= this.maxEntries) return { ok: this.failOpen, retryAt };
      entry = { start, count: 0 };
      this.#entries.set(key, entry);
    }
    if (entry.count >= this.limit) return { ok: false, retryAt };
    entry.count++;
    return { ok: true, retryAt };
  }
  private prune(start: number): void {
    for (const [key, entry] of this.#entries) if (entry.start !== start) this.#entries.delete(key);
  }
  clear(): void { this.#entries.clear(); }
  get size(): number { return this.#entries.size; }
}

/** 영구 토큰 오류를 설치별로 센다. 넘으면 정해진 시간 동안 정지한다. */
class ErrorBudget {
  readonly #errors = new Map<string, number[]>();
  readonly #suspended = new Map<string, number>();
  constructor(private readonly budget: number, private readonly windowMs: number, private readonly suspendMs: number, private readonly maxEntries: number) {}
  suspendedUntil(installationId: string, now: number): number | undefined {
    const until = this.#suspended.get(installationId);
    if (until === undefined) return undefined;
    if (until > now) return until;
    this.#suspended.delete(installationId);
    return undefined;
  }
  /** 오류 한 건을 더한다. 이번 오류로 정지되면 true. */
  record(installationId: string, now: number): boolean {
    const recent = (this.#errors.get(installationId) ?? []).filter((at) => at > now - this.windowMs);
    recent.push(now);
    if (recent.length > this.budget) {
      this.#errors.delete(installationId);
      if (this.#suspended.size >= this.maxEntries) for (const [key, until] of this.#suspended) if (until <= now) this.#suspended.delete(key);
      this.#suspended.set(installationId, now + this.suspendMs);
      return true;
    }
    if (!this.#errors.has(installationId) && this.#errors.size >= this.maxEntries) {
      for (const [key, times] of this.#errors) if (!times.some((at) => at > now - this.windowMs)) this.#errors.delete(key);
      if (this.#errors.size >= this.maxEntries) return false; // 셀 자리가 없으면 세지 않는다(정상 사용자를 막지 않는다).
    }
    this.#errors.set(installationId, recent);
    return false;
  }
}

/**
 * 설치 만들기에 쓰는 IP 묶음. IPv4 는 주소 그대로, IPv6 는 앞 64비트(/64)로 묶는다(한 집이 /64 안에서 주소를 바꿔 쓴다).
 * IPv4 를 담은 IPv6(::ffff:a.b.c.d)는 IPv4 로 본다. 알아볼 수 없으면 null(그때는 IP 한도를 건너뛴다).
 */
export function ipBucket(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  let ip = value.trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const version = isIP(ip);
  if (version === 4) return `4:${ip}`;
  if (version !== 6) return null;
  const groups = expandIPv6(ip.toLowerCase());
  if (!groups) return null;
  if (groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff") {
    const [high, low] = [parseInt(groups[6]!, 16), parseInt(groups[7]!, 16)];
    return `4:${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `6:${groups.slice(0, 4).join(":")}`;
}

function expandIPv6(ip: string): string[] | null {
  let text = ip;
  // 끝의 IPv4 표기는 16진 두 묶음으로 바꾼다.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = text.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => group.replace(/^0+(?=.)/, ""));
}

/** X-Forwarded-For 의 값들(여러 줄이면 이어서). 머리글이 없으면 빈 목록. */
export function forwardedFor(headers: Record<string, string | string[] | undefined>): string[] {
  const value = headers["x-forwarded-for"];
  const text = Array.isArray(value) ? value.join(",") : value;
  return typeof text === "string" ? text.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

/**
 * 설치 만들기의 IP 한도에 쓰는 손님 IP(IP 원문은 HMAC 하기 전까지 메모리에만 있다).
 * Google 앞단이 X-Forwarded-For 끝에 붙인 값만 쓴다(settings.ts 의 RELAY_CLIENT_IP). 보낸 쪽이 넣은 앞쪽 값과
 * Fastly-Client-IP 같은 머리글은 꾸밀 수 있으므로 보지 않는다. 그 자리에 값이 없거나(머리글 없음·값이 모자람)
 * 알아볼 수 없으면 undefined 를 돌려주고, 그때는 IP 한도를 건너뛴다(전체 시간 한도는 그대로). 연결 주소는 쓰지 않는다:
 * Cloud Run 에서는 모든 요청이 Google 안쪽 주소에서 오므로 모든 Mac 이 한 묶음이 된다.
 */
export function clientIp(headers: Record<string, string | string[] | undefined>,
  fromEnd: number = RELAY_CLIENT_IP.forwardedForFromEnd): string | undefined {
  const entries = forwardedFor(headers);
  if (!Number.isInteger(fromEnd) || fromEnd < 1 || entries.length < fromEnd) return undefined;
  const value = entries[entries.length - fromEnd];
  return value && ipBucket(value) ? value : undefined;
}

export interface LimitsOptions {
  installationPerMinute?: number; installationPerDay?: number; tokenPerDay?: number;
  createPerIpPerDay?: number; createPerHour?: number; sendsPerMinute?: number;
  errorBudget?: number; errorWindowMs?: number; errorSuspendMs?: number; maxEntries?: number;
  /** 시험만 넣는다. 날마다 새로 만드는 HMAC 비밀. */
  randomKey?: () => Buffer;
}

export class RelayLimits {
  readonly #installationMinute: Counter;
  readonly #installationDay: Counter;
  readonly #tokenDay: Counter;
  readonly #ipDay: Counter;
  readonly #createHour: Counter;
  readonly #sendMinute: Counter;
  readonly #errors: ErrorBudget;
  readonly #randomKey: () => Buffer;
  #day = -1;
  #dayKey: Buffer = Buffer.alloc(0);

  constructor(options: LimitsOptions = {}) {
    const o = { ...RELAY_LIMITS, ...options };
    this.#installationMinute = new Counter(MINUTE, o.installationPerMinute, o.maxEntries);
    this.#installationDay = new Counter(DAY, o.installationPerDay, o.maxEntries);
    this.#tokenDay = new Counter(DAY, o.tokenPerDay, o.maxEntries);
    this.#ipDay = new Counter(DAY, o.createPerIpPerDay, o.maxEntries, true);
    this.#createHour = new Counter(HOUR, o.createPerHour, 1);
    this.#sendMinute = new Counter(MINUTE, o.sendsPerMinute, 1);
    this.#errors = new ErrorBudget(o.errorBudget, o.errorWindowMs, o.errorSuspendMs, o.maxEntries);
    this.#randomKey = options.randomKey ?? (() => randomBytes(32));
  }

  /** 오늘의 HMAC 열쇠. 날이 바뀌면 새로 만들고, 지난 날의 토큰·IP 표를 비운다. */
  private digest(value: string, now: number): string {
    const day = Math.floor(now / DAY);
    if (day !== this.#day) {
      this.#day = day;
      this.#dayKey = this.#randomKey();
      this.#tokenDay.clear();
      this.#ipDay.clear();
    }
    return createHmac("sha256", this.#dayKey).update(value).digest().subarray(0, 16).toString("base64url");
  }

  /** IP 묶음의 HMAC 값(오늘의 메모리 비밀). 알아볼 수 없으면 null. */
  ipKey(ip: string | undefined, now: number): string | null {
    const bucket = ipBucket(ip);
    return bucket ? this.digest(bucket, now) : null;
  }

  /**
   * 설치 만들기. 받는 요청만 센다: IP 몫이 남았는지 먼저 보고(세지 않음), 전체 시간 한도를 센 뒤, 받을 때만 IP 몫을 센다.
   * 그래서 전체 한도에 막힌 동안 다시 시도하는 정상 Mac 은 자기 IP 몫을 쓰지 않는다. IP 묶음을 알아볼 수 없거나
   * IP 표가 차 있으면 IP 한도는 건너뛴다(정상 사용자를 한 묶음에 몰거나 남이 채운 표 때문에 막지 않는다).
   */
  allowCreate(ip: string | undefined, now: number): LimitResult {
    const key = this.ipKey(ip, now);
    if (key) {
      const perIp = this.#ipDay.peek(key, now);
      if (!perIp.ok) return { ok: false, scope: "ip", retryAt: perIp.retryAt };
    }
    const global = this.#createHour.take("all", now);
    if (!global.ok) return { ok: false, scope: "global", retryAt: global.retryAt };
    if (key) this.#ipDay.take(key, now);
    return { ok: true };
  }

  /** 정지된 설치인지. 정지 중이면 풀리는 시각. */
  suspendedUntil(installationId: string, now: number): number | undefined {
    return this.#errors.suspendedUntil(installationId, now);
  }

  /** 보내기 한 건을 센다. 설치(분·날) → 토큰(날) → 인스턴스 전체(분) 순서. */
  allowSend(installationId: string, token: string, now: number): LimitResult {
    const minute = this.#installationMinute.take(installationId, now);
    if (!minute.ok) return { ok: false, scope: "installation", retryAt: minute.retryAt };
    const day = this.#installationDay.take(installationId, now);
    if (!day.ok) return { ok: false, scope: "installation", retryAt: day.retryAt };
    const perToken = this.#tokenDay.take(this.digest(`token:${token.toLowerCase()}`, now), now);
    if (!perToken.ok) return { ok: false, scope: "token", retryAt: perToken.retryAt };
    const global = this.#sendMinute.take("all", now);
    return global.ok ? { ok: true } : { ok: false, scope: "global", retryAt: global.retryAt };
  }

  /** 영구 토큰 오류 한 건. 이번 오류로 정지되면 그 풀리는 시각. */
  recordTokenError(installationId: string, now: number): number | undefined {
    return this.#errors.record(installationId, now) ? this.#errors.suspendedUntil(installationId, now) : undefined;
  }
}
