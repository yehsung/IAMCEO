// E9: 보류 사유를 문장이 아니라 코드로 가른다.
//
// 1) members.fence_code — lastError 가 '자동 입력을 멈춘 보류'일 때 그 보류의 코드. 동작은 이 열로만 가른다.
//    lastError 문장은 지금처럼 계속 쓴다. 이전 판 서버로 되돌리면 옛 서버는 그 문장의 앞머리로 판정하기 때문이다.
// 2) messages.delivery_code — 대표 글의 deliveryNote 가 정해진 보류 문장이면 그 코드. 앱은 이 코드로 가른다.
//
// 두 열은 DB 판 번호를 올리지 않고 더한다(server/db.ts). 이전 판 서버는 이 열을 모른 채 문장만 고친다.
// 그래서 DB 를 열 때마다 문장에서 코드를 다시 맞춘다(reconcileHoldCodes). 문장에서 코드를 읽는 곳은 이 파일의 이주뿐이다.
import type { Database } from "bun:sqlite";
import type { ErrorCode } from "../shared/error-codes.ts";

/** lastError 에 붙는 보류 코드. 하나의 lastError 는 많아야 하나의 보류를 뜻한다. */
export type FenceCode = Extract<ErrorCode, "control_unknown" | "starting_unknown" | "core_reconnect_held" | "stop_check_held" | "usage_wait">;
export const FENCE_CODES: readonly FenceCode[] = ["control_unknown", "starting_unknown", "core_reconnect_held", "stop_check_held", "usage_wait"];

/** 사용 한도로 보류한 직원의 lastError. 한도가 풀리면 이 보류(usage_wait)일 때만 지운다. */
export const USAGE_WAIT_NOTE = "사용 한도 해제를 기다립니다";
/** 병렬 설정 결과를 모를 때의 lastError. control_unknown 보류다. */
export const CONTROL_UNKNOWN_NOTE = "control_unknown: 병렬 설정 결과를 확인하지 못했습니다. 자동 입력을 보류합니다";
export const CORE_RECONNECT_HELD_NOTE = "core 재연결 보류: 읽기 재결합을 지원하지 않습니다";
export function startingUnknownNote(detail: string): string { return `starting_unknown: ${detail.slice(0, 500)}`; }
export function stopCheckHeldNote(detail: string): string { return `종료 확인 보류: ${detail.slice(0, 500)}`; }

/**
 * 이주 전용: 옛 서버가 쓴 lastError 문장에서 보류 코드를 읽는다(그 서버가 쓰던 앞머리 판정과 글자까지 같다).
 * 실행 중 판정에는 쓰지 않는다. 실행 중에는 lastError 를 쓸 때 코드를 함께 쓴다.
 */
export function fenceCodeFromLegacyText(lastError: string | null | undefined): FenceCode | null {
  if (!lastError) return null;
  if (lastError.startsWith("control_unknown:")) return "control_unknown";
  if (lastError.startsWith("starting_unknown")) return "starting_unknown";
  if (lastError.startsWith("core 재연결 보류")) return "core_reconnect_held";
  if (lastError.startsWith("종료 확인 보류:")) return "stop_check_held";
  if (lastError === USAGE_WAIT_NOTE) return "usage_wait";
  return null;
}

/** 전달 보류 사유(deliveries.hold_reason)마다 대표 글 아래에 보이는 문장. */
export const HOLD_NOTES: Record<string, string> = {
  delivery_unknown: "전달 여부를 확인할 수 없어 보류했습니다. 중복 실행 방지를 위해 자동 재전송하지 않습니다",
  legacy_session: "이전 실행기의 세션입니다. 새 core 세션이 필요합니다",
  blocked: "승인 창 앞에서 멈춤",
  input_busy: "입력칸에 넣지 못함(선택 창 등)",
  asleep: "잠듦",
  offline: "세션이 보이지 않음",
  backend_down: "실행기에 연결할 수 없음",
  runner_disabled: "실행이 꺼져 있음",
  archived: "보관되어 멈춤",
};
/** 가져온 못 읽은 말. 총괄을 시작하면 전달하기로 약속했으므로 실행이 꺼져도 실패로 돌리지 않는다. */
export const IMPORT_HOLD_NOTE = "총괄을 시작하면 전달됩니다";
export const API_OUTAGE_NOTE = "인터넷 연결 복구를 기다립니다";
export const REOPEN_RETRY_NOTE = "새 설정으로 다시 여는 데 실패해 잠시 뒤 다시 엽니다";

/** 정해진 deliveryNote 문장 → 코드. 이 표에 없는 문장(이름·까닭이 끼어든 글)은 코드가 없다. */
const DELIVERY_NOTE_CODES: ReadonlyMap<string, ErrorCode> = new Map<string, ErrorCode>([
  [HOLD_NOTES.delivery_unknown!, "held_delivery_unknown"],
  [HOLD_NOTES.legacy_session!, "held_legacy_session"],
  [HOLD_NOTES.blocked!, "held_blocked"],
  [HOLD_NOTES.input_busy!, "held_input_busy"],
  [HOLD_NOTES.asleep!, "held_asleep"],
  [HOLD_NOTES.offline!, "held_offline"],
  [HOLD_NOTES.backend_down!, "held_backend_down"],
  [HOLD_NOTES.runner_disabled!, "held_runner_disabled"],
  [HOLD_NOTES.archived!, "held_archived"],
  [IMPORT_HOLD_NOTE, "held_import"],
  [API_OUTAGE_NOTE, "held_api_outage"],
  [USAGE_WAIT_NOTE, "held_usage_limit"],
  [REOPEN_RETRY_NOTE, "held_reopen_retry"],
]);

/** setMessageDelivery 가 note 와 함께 쓰는 코드. 문장과 코드를 한곳(위 표)에서 짝지어 둘이 어긋나지 않게 한다. */
export function deliveryNoteCode(note: string | null | undefined): ErrorCode | null {
  return note ? DELIVERY_NOTE_CODES.get(note) ?? null : null;
}

/**
 * DB 를 열 때마다 문장에서 코드를 다시 맞춘다. 새 서버가 쓴 행은 이미 맞아서 바뀌지 않는다.
 * 이전 판 서버가 고친 행(코드 열을 모르고 문장만 바꿈)만 고쳐진다: 되돌렸다가 다시 올려도 낡은 코드가 전달을 막지 않는다.
 */
export function reconcileHoldCodes(db: Database): { members: number; messages: number } {
  let members = 0;
  const update = db.query("UPDATE members SET fence_code = ? WHERE id = ?");
  for (const row of db.query<{ id: string; last_error: string | null; fence_code: string | null }, []>("SELECT id, last_error, fence_code FROM members").all()) {
    const code = fenceCodeFromLegacyText(row.last_error);
    if (code !== row.fence_code) { update.run(code, row.id); members++; }
  }
  const map = JSON.stringify(Object.fromEntries(DELIVERY_NOTE_CODES));
  const derived = "(SELECT value FROM json_each(?1) WHERE key = messages.delivery_note)";
  // 메모도 코드도 없는 행(대부분의 대화)은 표를 보지 않고 넘긴다.
  const messages = db.query(`UPDATE messages SET delivery_code = ${derived}
    WHERE (delivery_note IS NOT NULL OR delivery_code IS NOT NULL) AND delivery_code IS NOT ${derived}`).run(map).changes;
  return { members, messages };
}
