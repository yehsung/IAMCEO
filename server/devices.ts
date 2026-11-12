// G(C3): 기기마다 따로 주는 열쇠와 접속 기록.
//
// - 짝 맺기(QR, POST /pair/claim)는 그 기기만의 열쇠를 accessCode 칸에 담아 준다. 출시된 앱(0.2.2·0.2.3)은 그 값을
//   접속 코드로 알고 그대로 Bearer 에 싣는다. 고치지 않고 따라온다.
// - 열쇠는 `dk1.<기기 ID>.<비밀>` 모양이다. DB 에는 비밀의 SHA-256 만 둔다. 기기 ID 로 행을 찾고 해시를 상수 시간으로 비교한다.
// - 공용 접속 코드(config.json)는 지금처럼 어디서나 통한다. 지금 그 코드로 붙은 기기(이 Mac 의 앱, 기존 iPhone)는 끊기지 않는다.
// - 접속 코드를 보는 모든 자리(HTTP, 실시간 연결, 터미널 스트림, 첨부, 합류)는 authenticate() 하나로 판정한다.
// - 기록: 인증 실패(주소·시각), 짝 맺기 성공(기기 이름), 열쇠 끊기, 코드 교체. 코드·열쇠 값은 어디에도 남기지 않는다.
//   오래된 기록은 정리한다(90일, 2,000줄).
// - 표가 없거나(만들기 실패) 쓰기가 실패해도 인증은 막지 않는다. 짝 맺기는 그때 예전처럼 공용 코드를 건넨다(http.ts).
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
  /** 마지막 접속 시각을 DB 에 쓰는 최소 간격. 화면에는 메모리의 더 최근 값을 보인다. */
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
  | { ok: false; reason: "revoked"; deviceId: string };

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
  return safeEqual(token, sharedCode) ? { ok: true, principal: SHARED_PRINCIPAL } : { ok: false, reason: "wrong" };
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
function asAccessPlatform(value: string): AccessPlatform { return value === "ios" || value === "macos" || value === "local" ? value : "other"; }
function laterIso(a: string | null, b: string | null): string | null { return !a ? b : !b ? a : a > b ? a : b; }

/** 기기 열쇠와 접속 기록. 서버 하나에 하나. 모든 쓰기는 실패해도 삼킨다(인증을 막지 않는다). */
export class DeviceKeys {
  private readonly now: () => number;
  private readonly limits: Readonly<AccessLogLimits>;
  /** 마지막 접속: DB 에 쓴 시각(쓰기 간격용)과 메모리의 최신 값(화면용). */
  private readonly lastWrite = new Map<string, number>();
  private readonly seen = new Map<string, { at: string; address: string | null; platform: string | null }>();
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

  /** 짝 맺기에 성공한 기기에 새 열쇠를 준다. 저장하지 못하면 null(부르는 쪽이 예전처럼 공용 코드를 준다). */
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

  /** 열쇠 모양을 풀어 그 기기 행의 해시와 상수 시간으로 견준다. 맞지 않으면 null. */
  verify(token: string): { state: "active" | "revoked"; id: string } | null {
    const parts = token.split(".");
    const id = parts[1] ?? "", secret = parts[2] ?? "";
    const wellFormed = parts.length === 3 && `${parts[0]}.` === DEVICE_KEY_PREFIX && ID_RE.test(id) && SECRET_RE.test(secret);
    const row = wellFormed
      ? this.quietly(null, () => this.db.query<Pick<DeviceRow, "secret_hash" | "revoked_at">, [string]>("SELECT secret_hash, revoked_at FROM auth_devices WHERE id = ?").get(id))
      : null;
    const stored = row && /^[0-9a-f]{64}$/.test(row.secret_hash) ? Buffer.from(row.secret_hash, "hex") : DUMMY_HASH;
    const match = timingSafeEqual(stored, sha256(secret));
    if (!match || !row) return null;
    return { state: row.revoked_at ? "revoked" : "active", id };
  }

  /** 지금도 쓸 수 있는 열쇠인가(열린 소켓·터미널 스트림을 다시 볼 때). */
  isActive(id: string): boolean {
    return this.quietly(false, () => !!this.db.query("SELECT 1 FROM auth_devices WHERE id = ? AND revoked_at IS NULL").get(id));
  }

  /** 인증된 요청 하나. 마지막 접속 시각을 메모리에 바로, DB 에는 1분에 한 번 남긴다. */
  touch(principal: Principal, platform: AccessPlatform, address: string | null): void {
    const now = this.now(), at = this.iso(now);
    const key = principal.kind === "device" ? `device:${principal.id}` : `shared:${platform}`;
    const appPlatform = platform === "ios" || platform === "macos" ? platform : null;
    const before = this.seen.get(key);
    this.seen.set(key, { at, address, platform: appPlatform ?? before?.platform ?? null });
    const written = this.lastWrite.get(key);
    const platformLearned = principal.kind === "device" && appPlatform !== null && before?.platform !== appPlatform;
    if (written !== undefined && now - written < this.limits.touchEveryMs && !platformLearned) return;
    this.lastWrite.set(key, now);
    this.quietly(undefined, () => {
      if (principal.kind === "device") {
        this.db.query("UPDATE auth_devices SET last_seen_at = ?, last_address = ?, platform = COALESCE(?, platform) WHERE id = ?").run(at, address, appPlatform, principal.id);
      } else {
        this.db.query(`INSERT INTO auth_shared_seen (platform, last_seen_at, last_address) VALUES (?, ?, ?)
          ON CONFLICT(platform) DO UPDATE SET last_seen_at = excluded.last_seen_at, last_address = excluded.last_address`).run(platform, at, address);
      }
    });
    if (this.lastWrite.size > 4096) this.lastWrite.clear();
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
    this.lastWrite.delete(`device:${id}`);
    return this.toDevice(row, null);
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

  /** 설정 화면의 '연결된 기기'. current 는 이 목록을 부른 요청의 자격이다. */
  list(current: Principal): DeviceAccessList {
    this.flushFailures();
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
    const events = this.quietly([] as EventRow[], () => this.db.query<EventRow, [number]>("SELECT * FROM auth_events ORDER BY last_at DESC, id DESC LIMIT ?").all(this.limits.listEvents))
      .map((row): AccessEvent => ({ kind: row.kind as AccessEventKind, at: row.at, lastAt: row.last_at, count: row.count, address: row.address, deviceName: row.device_name, reason: row.reason }));
    return { shared, devices, failures: { count: Number(failures.n ?? 0), days: this.limits.failureDays, lastAt: failures.last ?? null }, events };
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
