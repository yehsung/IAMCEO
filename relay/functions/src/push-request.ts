// 알림 한 건 요청을 검사하고 APNs 페이로드를 만든다.
// 페이로드는 Mac 서버가 직접 보낼 때와 같은 함수(server/push/apns.ts 의 buildAPNsPayload)로 만든다.
// 그래서 문구(종류별 고정 한국어)와 출시 앱이 읽는 iamceo:{v,serverId,eventId,kind,target} 모양이 바이트까지 같다.
// 요청에 문구·제목·소리 같은 필드가 있어도 쓰지 않는다(허용 목록으로 다시 만든다). 모르는 필드는 버린다.
import { PUSH_KINDS } from "../../../shared/push.ts";
import type { PushEventTarget, PushKind } from "../../../shared/push.ts";
import { APNS_TTL_MS, buildAPNsPayload, serializeAPNsPayload } from "../../../server/push/apns.ts";

export type RelayKind = PushKind | "test";
export interface PushRequest {
  /** 소문자 16진. APNs 경로에만 쓰고 저장·기록하지 않는다. */
  token: string;
  /** Mac 의 전달 ID. apns-id 로 쓴다. */
  id: string;
  /** Mac 의 사건 ID. apns-collapse-id 로 쓴다(같은 사건은 기기에서 한 장으로 합쳐진다). */
  eventId: string;
  kind: RelayKind;
  /** 밀리초. 종류별 최대 보관 시간을 넘지 않게 줄인 값. */
  expiresAt: number;
  /** 직렬화한 APNs 페이로드. */
  payload: string;
}
export type PushRequestResult = { ok: true; value: PushRequest } | { ok: false; reason: "invalid_request" | "expired" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^(?:[0-9a-fA-F]{2}){1,512}$/;
const KINDS: readonly string[] = [...PUSH_KINDS, "test"];
const TARGET_KEYS = new Set(["screen", "projectId", "decisionId", "memberId", "messageId", "groupId"]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** target 은 문자열 값만(채팅의 memberId 만 null 허용). 숫자를 문자열처럼 통과시키지 않는다. */
function target(value: unknown): PushEventTarget | null {
  if (!object(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > TARGET_KEYS.size || keys.some((key) => !TARGET_KEYS.has(key))) return null;
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string") continue;
    if (key === "memberId" && item === null) continue;
    return null;
  }
  return value as unknown as PushEventTarget;
}

/**
 * 본문(프로토콜 1, Mac 의 relayPushBody 와 같은 이름):
 * { token, kind, id, eventId, serverId, target, expiresAt?, summary?, environment? }
 * environment 는 없거나 "production" 이어야 한다(중계는 production 만 보낸다).
 */
export function parsePushRequest(raw: string, now: number): PushRequestResult {
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return { ok: false, reason: "invalid_request" }; }
  if (!object(body)) return { ok: false, reason: "invalid_request" };
  const { token, kind, id, eventId, serverId, expiresAt, summary, environment } = body;
  if (typeof token !== "string" || !TOKEN.test(token) || typeof kind !== "string" || !KINDS.includes(kind) ||
      typeof id !== "string" || !UUID.test(id) || typeof eventId !== "string" || !UUID.test(eventId) ||
      typeof serverId !== "string" || !UUID.test(serverId) ||
      (summary !== undefined && typeof summary !== "boolean") ||
      (environment !== undefined && environment !== "production") ||
      (expiresAt !== undefined && typeof expiresAt !== "string")) return { ok: false, reason: "invalid_request" };
  const hint = target(body.target);
  if (!hint) return { ok: false, reason: "invalid_request" };
  const relayKind = kind as RelayKind;
  // 유효 시각: 없으면 종류별 최대 보관 시간. 있으면 그보다 길지 않게 줄인다(Mac 시계가 앞서도 거절하지 않는다).
  const latest = now + APNS_TTL_MS[relayKind];
  let expiry = latest;
  if (typeof expiresAt === "string") {
    const parsed = Date.parse(expiresAt);
    if (!Number.isFinite(parsed)) return { ok: false, reason: "invalid_request" };
    expiry = Math.min(parsed, latest);
  }
  if (Math.floor(expiry / 1000) <= Math.floor(now / 1000)) return { ok: false, reason: "expired" };
  let payload: string;
  try {
    payload = serializeAPNsPayload(buildAPNsPayload({
      environment: "production", deviceToken: token, deliveryId: id, eventId, serverId, kind: relayKind, target: hint,
      occurredAt: new Date(now).toISOString(), expiresAt: new Date(expiry).toISOString(), reportSummary: summary === true,
    }));
  } catch { return { ok: false, reason: "invalid_request" }; }
  return { ok: true, value: { token: token.toLowerCase(), id: id.toLowerCase(), eventId: eventId.toLowerCase(), kind: relayKind, expiresAt: expiry, payload } };
}
