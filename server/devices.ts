// G(C3): 기기마다 따로 주는 열쇠와 접속 기록.
//
// - 짝 맺기(QR, POST /pair/claim)는 그 기기만의 열쇠를 accessCode 칸에 담아 준다. 출시된 앱(0.2.2·0.2.3)은 그 값을
//   접속 코드로 알고 그대로 Bearer 에 싣는다. 고치지 않고 따라온다.
// - 열쇠는 `dk1.<기기 ID>.<비밀>` 모양이다. DB 에는 비밀의 SHA-256 만 둔다. 기기 ID 로 행을 찾고 해시를 상수 시간으로 비교한다.
// - 공용 접속 코드(config.json)는 지금처럼 어디서나 통한다. 지금 그 코드로 붙은 기기(이 Mac 의 앱, 기존 iPhone)는 끊기지 않는다.
// - 접속 코드를 보는 모든 자리(HTTP, 실시간 연결, 터미널 스트림, 첨부, 합류)는 authenticate() 하나로 판정한다.
// - 기록: 인증 실패(주소·시각), 짝 맺기 성공(기기 이름), 열쇠 끊기, 코드 교체. 코드·열쇠 값은 어디에도 남기지 않는다.
//   오래된 기록은 정리한다(90일, 2,000줄).
// - 표가 없거나(만들기 실패) 기록 쓰기가 실패해도 공용 코드 인증은 막지 않는다. 다만 열쇠를 읽다가 난 저장소 오류는
//   '틀린 열쇠'가 아니라 오류(503)로 답한다(출시된 앱은 401 한 번에 저장한 열쇠를 지운다). 열쇠를 저장하지 못한 짝 맺기도
//   공용 코드를 건네지 않고 503 으로 답한다(목록에 없고 한 대만 끊을 수도 없는 기기가 생기지 않게. http.ts).
// - 조회 요청(GET)은 DB 를 쓰지 않는다: 마지막 접속 시각은 메모리에 모았다가 서버가 1분마다, 그리고 멈출 때 flush() 로 쓴다.
import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { AccessEvent, AccessEventKind, AccessPlatform, AppPlatform, ConnectedDevice, DeviceAccessList, SharedCodeAccess } from "../shared/types.ts";

export const DEVICE_KEY_PREFIX = "dk1.";
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ID_RE = /^dev[A-Za-z0-9]{16}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 86_400_000;
/** 비교할 행이 없을 때도 같은 길이의 비교를 한 번 한다. */
const DUMMY_HASH = Buffer.alloc(32);

export interface AccessLogLimits {
  retentionDays: number; maxEvents: number; failureWindowMs: number; failureFlushMs: number; touchEveryMs: number;
  unusedKeyMs: number; failureDays: number; listEvents: number; trackedAddresses: number;
}
export const ACCESS_LOG_LIMITS: Readonly<AccessLogLimits> = Object.freeze({
  /** 기록을 두는 날수와 줄 수. */
  retentionDays: 90,
  maxEvents: 2_000,
  /** 같은 주소의 실패를 한 줄로 묶는 시간. 대입 시도가 DB 를 채우지 못하게 한다. */
  failureWindowMs: 10 * 60_000,
  /** 묶인 실패 수를 DB 에 쓰는 최소 간격. */
  failureFlushMs: 5_000,
  /** 메모리에 모은 마지막 접속 시각(과 묶인 실패 수)을 DB 에 쓰는 간격(서버 타이머). 화면에는 메모리의 더 최근 값을 보인다. */
  touchEveryMs: 60_000,
  /** 짝 맺기 응답을 잃어 한 번도 쓰이지 않은 열쇠는 이만큼 지나면 끊는다(가진 기기가 없다). */
  unusedKeyMs: DAY_MS,
  /** 화면의 '최근 실패한 시도' 날수와 목록 줄 수. */
  failureDays: 7,
  listEvents: 50,
  /** 메모리에 묶어 두는 실패 주소 수. */
  trackedAddresses: 256,
});

export type Principal = { kind: "shared" } | { kind: "device"; id: string };
export const SHARED_PRINCIPAL: Principal = Object.freeze({ kind: "shared" });

export type AuthOutcome =
  | { ok: true; principal: Principal }
  | { ok: false; reason: "missing" | "wrong" }
  | { ok: false; reason: "revoked"; deviceId: string }
  /** 기기 열쇠를 읽다가 저장소 오류가 났다. 틀린 열쇠가 아니므로 401 이 아니라 503 으로 답한다(앱은 다시 시도한다). */
  | { ok: false; reason: "error" };

/** QR 을 만든 자격의 이름. 기기를 끊을 때 그 기기가 만든 QR 을 무르는 데 쓴다(pairing.ts). */
export function principalKey(principal: Principal): string {
  return principal.kind === "device" ? `device:${principal.id}` : "shared";
}

/** 길이가 달라도 시간이 새지 않게 해시끼리 비교한다. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function sha256(value: string): Buffer { return createHash("sha256").update(value).digest(); }

/**
 * 요청의 Bearer 하나로 판정한다. 접속 코드를 보는 모든 자리가 이것만 쓴다.
 * 기기 열쇠 모양이면 열쇠를 먼저 보고, 아니면(또는 맞는 열쇠가 없으면) 공용 접속 코드와 견준다.
 */
export function authenticate(token: string | null | undefined, sharedCode: string, keys: DeviceKeys | null | undefined): AuthOutcome {
  if (!token) return { ok: false, reason: "missing" };
  const device = keys && token.startsWith(DEVICE_KEY_PREFIX) ? keys.verify(token) : null;
  if (device?.state === "active") return { ok: true, principal: { kind: "device", id: device.id } };
  if (device?.state === "revoked") return { ok: false, reason: "revoked", deviceId: device.id };
  if (safeEqual(token, sharedCode)) return { ok: true, principal: SHARED_PRINCIPAL };
  return device?.state === "error" ? { ok: false, reason: "error" } : { ok: false, reason: "wrong" };
}

/** 앱이 보낸 기기 이름을 화면에 보일 한 줄로. 제어 문자는 버리고 64자에서 자른다. */
export function deviceDisplayName(raw: unknown): string {
  const text = typeof raw === "string" ? raw.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim() : "";
  return [...text].slice(0, 64).join("") || "이름 없는 기기";
}

interface DeviceRow {
  id: string; secret_hash: string; name: string; platform: string | null; created_at: string;
  last_seen_at: string | null; last_address: string | null; revoked_at: string | null; revoked_reason: string | null;
}
interface EventRow { id: number; kind: string; at: string; last_at: string; count: number; reason: string | null; address: string | null; device_id: string | null; device_name: string | null }
interface PendingFailure { rowId: number | null; windowStart: number; pending: number; lastAt: number; lastFlush: number; kind: "auth_failed" | "pair_failed"; reason: string | null; address: string | null; deviceId: string | null }

export interface DeviceKeysOptions { now?: () => number; limits?: Partial<AccessLogLimits> }

function asAppPlatform(value: string | null): AppPlatform | null { return value === "ios" || value === "macos" ? value : null; }
/** 표가 없는 DB(만들기 실패, 또는 시험). 이 DB 가 준 열쇠가 없다는 확실한 답이라 저장소 오류로 보지 않는다. */
function isMissingTable(error: unknown): boolean { return error instanceof Error && /no such table/i.test(error.message); }
function asAccessPlatform(value: string): AccessPlatform { return value === "ios" || value === "macos" || value === "local" ? value : "other"; }
function laterIso(a: string | null, b: string | null): string | null { return !a ? b : !b ? a : a > b ? a : b; }

/** 기기 열쇠와 접속 기록. 서버 하나에 하나. 모든 쓰기는 실패해도 삼킨다(인증을 막지 않는다). */
export class DeviceKeys {
  private readonly now: () => number;
  private readonly limits: Readonly<AccessLogLimits>;
  /** 마지막 접속: 메모리의 최신 값(화면용)과 아직 DB 에 쓰지 않은 것. 요청 안에서는 메모리만 고친다. */
  private readonly seen = new Map<string, { at: string; address: string | null; platform: string | null }>();
  private readonly dirty = new Set<string>();
  private readonly failing = new Map<string, PendingFailure>();
  private lastPrune = 0;

  constructor(private readonly db: Database, options: DeviceKeysOptions = {}) {
    this.now = options.now ?? Date.now;
    this.limits = { ...ACCESS_LOG_LIMITS, ...options.limits };
    this.prune();
  }

  private iso(ms = this.now()): string { return new Date(ms).toISOString(); }

  private quietly<T>(fallback: T, action: () => T): T {
    try { return action(); } catch { return fallback; }
  }

  /** 짝 맺기에 성공한 기기에 새 열쇠를 준다. 저장하지 못하면 null(부르는 쪽이 공용 코드를 대신 주지 않고 503 으로 답한다). */
  issue(input: { name: unknown; address: string | null; platform: AppPlatform | null }): { id: string; key: string; name: string } | null {
    const name = deviceDisplayName(input.name);
    const id = "dev" + Array.from({ length: 16 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");
    const secret = randomBytes(32).toString("base64url");
    const at = this.iso();
    const saved = this.quietly(false, () => {
      this.db.transaction(() => {
        this.db.query(`INSERT INTO auth_devices (id, secret_hash, name, platform, created_at, created_address) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, sha256(secret).toString("hex"), name, input.platform, at, input.address);
        this.insertEvent("paired", { address: input.address, deviceId: id, deviceName: name });
      })();
      return true;
    });
    return saved ? { id, key: `${DEVICE_KEY_PREFIX}${id}.${secret}`, name } : null;
  }

  /**
   * 열쇠 모양을 풀어 그 기기 행의 해시와 상수 시간으로 견준다. 맞지 않으면 null.
   * 행을 읽다가 저장소 오류가 나면 error(틀린 열쇠로 보지 않는다). 표가 아예 없으면 이 DB 가 준 열쇠가 없으므로 null.
   */
  verify(token: string): { state: "active" | "revoked"; id: string } | { state: "error" } | null {
    const parts = token.split(".");
    const id = parts[1] ?? "", secret = parts[2] ?? "";
    const wellFormed = parts.length === 3 && `${parts[0]}.` === DEVICE_KEY_PREFIX && ID_RE.test(id) && SECRET_RE.test(secret);
    let row: Pick<DeviceRow, "secret_hash" | "revoked_at"> | null = null;
    let failed = false;
    if (wellFormed) {
      try { row = this.db.query<Pick<DeviceRow, "secret_hash" | "revoked_at">, [string]>("SELECT secret_hash, revoked_at FROM auth_devices WHERE id = ?").get(id); }
      catch (error) { failed = !isMissingTable(error); }
    }
    const stored = row && /^[0-9a-f]{64}$/.test(row.secret_hash) ? Buffer.from(row.secret_hash, "hex") : DUMMY_HASH;
    const match = timingSafeEqual(stored, sha256(secret));
    if (failed) return { state: "error" };
    if (!match || !row) return null;
    return { state: row.revoked_at ? "revoked" : "active", id };
  }

  /**
   * 지금도 쓸 수 있는 열쇠인가(열린 소켓·터미널 스트림을 다시 볼 때). 읽다가 오류가 나면 살아 있다고 둔다:
   * 끊기는 그 자리에서 소켓을 직접 닫으므로, 일시적인 오류로 멀쩡한 연결을 끊지 않고 다음 확인에 맡긴다.
   */
  isActive(id: string): boolean {
    return this.quietly(true, () => !!this.db.query("SELECT 1 FROM auth_devices WHERE id = ? AND revoked_at IS NULL").get(id));
  }

  /** 인증된 요청 하나. 마지막 접속 시각을 메모리에만 남긴다(조회 요청은 DB 를 쓰지 않는다). DB 에는 flush() 가 쓴다. */
  touch(principal: Principal, platform: AccessPlatform, address: string | null): void {
    const at = this.iso();
    const key = principal.kind === "device" ? `device:${principal.id}` : `shared:${platform}`;
    const appPlatform = platform === "ios" || platform === "macos" ? platform : null;
    const before = this.seen.get(key);
    this.seen.set(key, { at, address, platform: appPlatform ?? before?.platform ?? null });
    this.dirty.add(key);
  }

  /**
   * 메모리에 모은 마지막 접속 시각과 묶어 둔 실패 수를 DB 에 쓴다. 서버가 1분마다, 그리고 멈출 때 부른다(요청 안에서는 부르지 않는다).
   * 쓰지 못하면 다음 번에 다시 쓴다.
   */
  flush(): void {
    this.flushFailures();
    if (this.dirty.size === 0) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    try {
      this.db.transaction(() => {
        for (const key of keys) {
          const value = this.seen.get(key);
          if (!value) continue;
          if (key.startsWith("device:")) {
            this.db.query("UPDATE auth_devices SET last_seen_at = ?, last_address = ?, platform = COALESCE(?, platform) WHERE id = ? AND revoked_at IS NULL")
              .run(value.at, value.address, value.platform, key.slice("device:".length));
          } else {
            this.db.query(`INSERT INTO auth_shared_seen (platform, last_seen_at, last_address) VALUES (?, ?, ?)
              ON CONFLICT(platform) DO UPDATE SET last_seen_at = excluded.last_seen_at, last_address = excluded.last_address`).run(key.slice("shared:".length), value.at, value.address);
          }
        }
      })();
    } catch {
      for (const key of keys) if (this.seen.has(key)) this.dirty.add(key);
    }
  }

  /** 틀린 코드·열쇠(auth_failed) 또는 맞지 않는 QR(pair_failed). 같은 주소·까닭은 몇 분씩 한 줄로 묶는다. */
  recordFailure(kind: "auth_failed" | "pair_failed", address: string | null, outcome?: AuthOutcome): void {
    const now = this.now();
    const reason = kind === "pair_failed" ? null : outcome && !outcome.ok && outcome.reason === "revoked" ? "revoked" : "wrong";
    const deviceId = outcome && !outcome.ok && outcome.reason === "revoked" ? outcome.deviceId : null;
    const key = `${kind}|${address ?? ""}|${reason ?? ""}|${deviceId ?? ""}`;
    let entry = this.failing.get(key);
    if (entry && now - entry.windowStart >= this.limits.failureWindowMs) { this.flushFailure(entry); this.failing.delete(key); entry = undefined; }
    if (!entry) {
      while (this.failing.size >= this.limits.trackedAddresses) {
        const oldest = this.failing.keys().next().value!;
        this.flushFailure(this.failing.get(oldest)!);
        this.failing.delete(oldest);
      }
      entry = { rowId: null, windowStart: now, pending: 0, lastAt: now, lastFlush: 0, kind, reason, address, deviceId };
      this.failing.set(key, entry);
    }
    entry.pending++;
    entry.lastAt = now;
    if (entry.rowId === null || now - entry.lastFlush >= this.limits.failureFlushMs) this.flushFailure(entry);
  }

  private flushFailure(entry: PendingFailure): void {
    if (entry.pending === 0) return;
    const count = entry.pending, lastAt = this.iso(entry.lastAt);
    entry.pending = 0;
    entry.lastFlush = this.now();
    this.quietly(undefined, () => {
      if (entry.rowId !== null) {
        this.db.query("UPDATE auth_events SET count = count + ?, last_at = ? WHERE id = ?").run(count, lastAt, entry.rowId);
        return;
      }
      const name = entry.deviceId ? this.db.query<{ name: string }, [string]>("SELECT name FROM auth_devices WHERE id = ?").get(entry.deviceId)?.name ?? null : null;
      entry.rowId = this.insertEvent(entry.kind, { at: this.iso(entry.windowStart), lastAt, count, reason: entry.reason, address: entry.address, deviceId: entry.deviceId, deviceName: name });
    });
  }

  private flushFailures(): void { for (const entry of this.failing.values()) this.flushFailure(entry); }

  /** 공용 접속 코드를 바꿨다(POST /api/auth/rotate). */
  recordRotation(address: string | null): void {
    this.quietly(undefined, () => { this.insertEvent("code_rotated", { address }); });
  }

  /** 한 대만 끊는다. 이미 끊었거나 없으면 null. */
  revoke(id: string, address: string | null, reason: "owner" | "unused" = "owner"): ConnectedDevice | null {
    if (!ID_RE.test(id)) return null;
    const at = this.iso();
    const row = this.quietly(null, () => this.db.transaction(() => {
      const found = this.db.query<DeviceRow, [string]>("SELECT * FROM auth_devices WHERE id = ? AND revoked_at IS NULL").get(id);
      if (!found) return null;
      this.db.query("UPDATE auth_devices SET revoked_at = ?, revoked_reason = ? WHERE id = ?").run(at, reason, id);
      this.insertEvent("device_revoked", { address, deviceId: id, deviceName: found.name, reason });
      return found;
    })());
    if (!row) return null;
    this.seen.delete(`device:${id}`);
    this.dirty.delete(`device:${id}`);
    return this.toDevice(row, null);
  }

  /**
   * QR 로 받은 열쇠를 모두 끊는다(이 Mac 에서 `iamceo auth rotate --all-devices`·`iamceo auth revoke-devices`).
   * 공용 접속 코드는 건드리지 않는다. 끊은 기기의 ID 를 돌려준다(부르는 쪽이 그 소켓을 닫는다). 저장하지 못하면 null.
   */
  revokeAll(address: string | null): string[] | null {
    const at = this.iso();
    const revoked = this.quietly(null, () => this.db.transaction(() => {
      const rows = this.db.query<{ id: string; name: string }, []>("SELECT id, name FROM auth_devices WHERE revoked_at IS NULL").all();
      this.db.query("UPDATE auth_devices SET revoked_at = ?, revoked_reason = 'all' WHERE revoked_at IS NULL").run(at);
      for (const row of rows) this.insertEvent("device_revoked", { address, deviceId: row.id, deviceName: row.name, reason: "all" });
      return rows.map(row => row.id);
    })());
    if (!revoked) return null;
    for (const id of revoked) { this.seen.delete(`device:${id}`); this.dirty.delete(`device:${id}`); }
    return revoked;
  }

  private insertEvent(kind: AccessEventKind, event: { at?: string; lastAt?: string; count?: number; reason?: string | null; address?: string | null; deviceId?: string | null; deviceName?: string | null }): number {
    const at = event.at ?? this.iso();
    const result = this.db.query(`INSERT INTO auth_events (kind, at, last_at, count, reason, address, device_id, device_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(kind, at, event.lastAt ?? at, event.count ?? 1, event.reason ?? null, event.address ?? null, event.deviceId ?? null, event.deviceName ?? null);
    if (this.now() - this.lastPrune >= 3_600_000) this.prune();
    return Number(result.lastInsertRowid);
  }

  /** 90일 지난 기록, 상한을 넘는 기록, 끊은 지 90일 지난 열쇠, 한 번도 쓰이지 않은 채 하루 지난 열쇠를 정리한다. */
  prune(): void {
    const now = this.now();
    this.lastPrune = now;
    const cutoff = this.iso(now - this.limits.retentionDays * DAY_MS);
    this.quietly(undefined, () => {
      const unused = this.db.query<{ id: string }, [string]>("SELECT id FROM auth_devices WHERE revoked_at IS NULL AND last_seen_at IS NULL AND created_at < ?")
        .all(this.iso(now - this.limits.unusedKeyMs));
      for (const { id } of unused) if (!this.seen.has(`device:${id}`)) this.revoke(id, null, "unused");
      this.db.query("DELETE FROM auth_events WHERE last_at < ?").run(cutoff);
      this.db.query(`DELETE FROM auth_events WHERE id NOT IN (SELECT id FROM auth_events ORDER BY last_at DESC, id DESC LIMIT ?)`).run(this.limits.maxEvents);
      this.db.query("DELETE FROM auth_devices WHERE revoked_at IS NOT NULL AND revoked_at < ?").run(cutoff);
      this.db.query("DELETE FROM auth_shared_seen WHERE last_seen_at < ?").run(cutoff);
    });
  }

  private toDevice(row: DeviceRow, current: Principal | null): ConnectedDevice {
    const memory = this.seen.get(`device:${row.id}`);
    return {
      id: row.id, name: row.name, platform: asAppPlatform(memory?.platform ?? row.platform), pairedAt: row.created_at,
      lastSeenAt: laterIso(row.last_seen_at, memory?.at ?? null),
      current: current?.kind === "device" && current.id === row.id,
    };
  }

  /**
   * 설정 화면의 '연결된 기기'. current 는 이 목록을 부른 요청의 자격이다.
   * 조회라 DB 를 쓰지 않는다: 아직 쓰지 않은 실패 수는 메모리에서 더해 보인다.
   */
  list(current: Principal): DeviceAccessList {
    const now = this.now();
    const devices = this.quietly([] as DeviceRow[], () => this.db.query<DeviceRow, []>("SELECT * FROM auth_devices WHERE revoked_at IS NULL").all())
      .map(row => this.toDevice(row, current))
      .sort((a, b) => Number(b.current) - Number(a.current) || (b.lastSeenAt ?? b.pairedAt).localeCompare(a.lastSeenAt ?? a.pairedAt));
    const platforms = new Map<AccessPlatform, string>();
    for (const row of this.quietly([] as { platform: string; last_seen_at: string }[], () => this.db.query<{ platform: string; last_seen_at: string }, []>("SELECT platform, last_seen_at FROM auth_shared_seen").all())) {
      const platform = asAccessPlatform(row.platform);
      platforms.set(platform, laterIso(platforms.get(platform) ?? null, row.last_seen_at)!);
    }
    for (const [key, value] of this.seen) {
      if (!key.startsWith("shared:")) continue;
      const platform = asAccessPlatform(key.slice("shared:".length));
      platforms.set(platform, laterIso(platforms.get(platform) ?? null, value.at)!);
    }
    const sharedPlatforms = [...platforms].map(([platform, lastSeenAt]) => ({ platform, lastSeenAt })).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    const rotatedAt = this.quietly(null, () => this.db.query<{ at: string }, []>("SELECT at FROM auth_events WHERE kind = 'code_rotated' ORDER BY at DESC LIMIT 1").get()?.at ?? null);
    const shared: SharedCodeAccess = { lastSeenAt: sharedPlatforms[0]?.lastSeenAt ?? null, platforms: sharedPlatforms, current: current.kind === "shared", rotatedAt };
    const since = this.iso(now - this.limits.failureDays * DAY_MS);
    const failures = this.quietly({ n: 0, last: null as string | null }, () => this.db.query<{ n: number | null; last: string | null }, [string]>(
      "SELECT SUM(count) AS n, MAX(last_at) AS last FROM auth_events WHERE kind IN ('auth_failed','pair_failed') AND last_at >= ?").get(since) ?? { n: 0, last: null });
    // 묶어 두고 아직 쓰지 않은 실패(첫 실패는 이미 줄로 써 두었다).
    const pendingByRow = new Map<number, { pending: number; lastAt: string }>();
    let failureCount = Number(failures.n ?? 0), failureLast = failures.last ?? null;
    for (const entry of this.failing.values()) {
      if (entry.pending === 0) continue;
      const lastAt = this.iso(entry.lastAt);
      if (entry.rowId !== null) pendingByRow.set(entry.rowId, { pending: entry.pending, lastAt });
      if (lastAt >= since) { failureCount += entry.pending; failureLast = laterIso(failureLast, lastAt); }
    }
    const events = this.quietly([] as EventRow[], () => this.db.query<EventRow, [number]>("SELECT * FROM auth_events ORDER BY last_at DESC, id DESC LIMIT ?").all(this.limits.listEvents))
      .map((row): AccessEvent => {
        const pending = pendingByRow.get(row.id);
        return { kind: row.kind as AccessEventKind, at: row.at, lastAt: laterIso(row.last_at, pending?.lastAt ?? null)!, count: row.count + (pending?.pending ?? 0), address: row.address, deviceName: row.device_name, reason: row.reason };
      });
    return { shared, devices, failures: { count: failureCount, days: this.limits.failureDays, lastAt: failureLast }, events };
  }
}

/**
 * 복제(iamceo restore --clone)한 사본에서 원본 기기의 열쇠를 모두 끊는다. 복제본은 원본에 붙어 있던 기기를 받아들이지 않는다.
 * 같은 Mac 복원(same-host)은 열쇠를 그대로 둔다. 표가 없는 옛 백업이면 할 일이 없다.
 */
export function revokeAllDeviceKeys(db: Database, at: string, reason: "clone"): number {
  const exists = db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'auth_devices'").get();
  if (!exists) return 0;
  const revoked = db.query<{ id: string; name: string }, []>("SELECT id, name FROM auth_devices WHERE revoked_at IS NULL").all();
  db.query("UPDATE auth_devices SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL").run(at, reason);
  db.query("DELETE FROM auth_shared_seen").run();
  for (const device of revoked) {
    db.query("INSERT INTO auth_events (kind, at, last_at, count, reason, device_id, device_name) VALUES ('device_revoked', ?, ?, 1, ?, ?, ?)").run(at, at, reason, device.id, device.name);
  }
  return revoked.length;
}
