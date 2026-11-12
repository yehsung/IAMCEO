import type { DeliveryWaitReason } from "../shared/types.ts";

/**
 * E3: 전달 펌프(Orchestrator.pumpOnce) 한 번의 판정.
 *
 * 보낼지 말지는 펌프 한 곳이 정한다. 화면에 보이는 대기 사유(앱으로 내려가는 waitReason 13개)는 펌프가 남긴 이 판정만 읽는다.
 * 예전에는 저장소(rawDeliveryWait)가 같은 조건을 다른 순서로 다시 추측해서, 대기 사유가 실제와 다르게 보였다.
 *
 * fence_code(2차 F, members.fence_code)와 역할이 다르다: fence 는 '무엇이 막고 있나(원인)'이고, 이것은 '이번 펌프가 왜 보내지 않았나(판정)'다.
 * 판정 코드는 서버 안쪽 이름이다. 앱에는 wait(13개 값 중 하나)만 내려간다.
 *
 * watch:
 * - "busy": 일한다고 보는데 CLI 는 쉬는 중으로 관측된다. 기한(정체 기준, 2분)을 넘기면 '이유 없는 대기'로 다룬다.
 * - "waking": 깨우는 중·세션 처리 중. 기동 제한(45초)과 재결합 유예가 들어 있어 더 넉넉히(정체 기준의 2.5배, 5분) 본다.
 * rejudge: 끝을 알리는 사건이 빠지면 판정이 낡을 수 있어, 정체 점검(10초)마다 펌프가 다시 판정한다(일하는 중의 턴 끝 사건이 빠진 경우 등).
 */
export const PUMP_VERDICTS = {
  sent: { wait: "member_busy", ko: "턴을 넣었다", rejudge: true },
  busy: { wait: "member_busy", ko: "일하는 중이라 다음 턴을 기다린다", rejudge: true },
  busy_unconfirmed: { wait: "member_busy", ko: "일하는 중으로 보는데 CLI 는 쉬는 중으로 관측된다", watch: "busy", rejudge: true },
  pending_run: { wait: "member_busy", ko: "끝나지 않은 실행 기록이 있다", rejudge: true },
  compacting: { wait: "member_busy", ko: "문맥 정리 중", rejudge: false },
  manual_busy: { wait: "member_busy", ko: "직접 띄운 세션이 일하는 중(wait 를 부르면 전달)", rejudge: true },
  manual_idle: { wait: "unknown", ko: "직접 띄운 세션이 wait 를 부르지 않는다", rejudge: true },
  no_wake: { wait: "unknown", ko: "깨울 전달이 없다(수동 전달은 다음 턴에 함께)", rejudge: false },
  asleep_hold: { wait: "next_turn", ko: "잠들 때 보류된 전달은 다음에 깨울 때 함께 나간다", rejudge: false },
  approval: { wait: "approval", ko: "승인 창 앞에서 멈췄다", rejudge: false },
  manual_control: { wait: "manual_control", ko: "대표가 터미널을 직접 조작하는 중", rejudge: false },
  receipt_check: { wait: "receipt_check", ko: "앞 전달의 수신을 확인하는 중", rejudge: false },
  sending: { wait: "receipt_check", ko: "보내는 중(수신 확인 전)", rejudge: false },
  waking: { wait: "waking", ko: "세션을 깨우는 중", watch: "waking", rejudge: false },
  session_busy: { wait: "waking", ko: "세션 처리 중(설정 적용·터미널 조작·기동 기록·닫기·재시작 복구)", watch: "waking", rejudge: false },
  retry_wait: { wait: "retry_wait", ko: "다시 보낼 시각을 기다린다", rejudge: false },
  run_limit: { wait: "run_limit", ko: "동시에 일하는 팀장 수 상한", rejudge: false },
  archived: { wait: "archived", ko: "보관된 프로젝트", rejudge: false },
  runner_off: { wait: "runner_off", ko: "실행기가 꺼져 있거나 연결할 수 없다", rejudge: false },
  api_outage: { wait: "api_outage", ko: "인터넷 연결 장애로 보류", rejudge: false },
  usage_limit: { wait: "usage_limit", ko: "사용 한도로 보류", rejudge: false },
  control_unknown: { wait: "unknown", ko: "직접 조작의 결과를 모른다", rejudge: false },
  ownership_unverified: { wait: "unknown", ko: "터미널 소유를 확인하지 못했다", rejudge: false },
  legacy_session: { wait: "unknown", ko: "옛 실행기의 세션이다", rejudge: false },
  reopen_failed: { wait: "unknown", ko: "꺼진 세션을 다시 열지 못했다", rejudge: false },
  session_gone: { wait: "unknown", ko: "보내려던 터미널이 사라졌다", rejudge: false },
  input_hold: { wait: "unknown", ko: "입력칸이 오래 비지 않아 보류했다", rejudge: false },
  config_failed: { wait: "unknown", ko: "새 설정을 적용하지 못했다", rejudge: false },
  parallel_failed: { wait: "unknown", ko: "병렬 설정을 바꾸지 못해 일을 미뤘다", rejudge: false },
  pump_error: { wait: "unknown", ko: "전달 처리 오류", rejudge: false },
} as const satisfies Record<string, { wait: DeliveryWaitReason; ko: string; watch?: "busy" | "waking"; rejudge: boolean }>;

export type PumpVerdictCode = keyof typeof PUMP_VERDICTS;

export interface PumpVerdict {
  code: PumpVerdictCode;
  /** run_limit 일 때 판정한 순간의 전역 동시 턴 수와 상한. */
  runLimit?: { used: number; limit: number };
}

/** 저장된 판정 한 줄(member_delivery_verdicts). since 는 같은 판정이 이어진 시작 시각, overdueAt 은 정체 점검이 기한을 넘겼다고 적은 시각. */
export interface StoredPumpVerdict {
  memberId: string;
  code: string;
  waitReason: DeliveryWaitReason;
  since: string;
  runLimit: { used: number; limit: number } | null;
  overdueAt: string | null;
  updatedAt: string;
}

/** 앱(0.2.2 부터)이 아는 대기 사유 13개. 값을 더하거나 바꾸지 않는다. */
export const DELIVERY_WAIT_REASONS = ["next_turn", "run_limit", "member_busy", "waking", "receipt_check", "approval", "manual_control", "runner_off", "archived", "api_outage", "usage_limit", "retry_wait", "unknown"] as const satisfies readonly DeliveryWaitReason[];
// shared/types.ts 의 DeliveryWaitReason 과 위 목록이 정확히 같아야 한다(빠진 값이 있으면 여기서 타입 오류).
const everyWaitReason: Record<DeliveryWaitReason, true> = Object.fromEntries(DELIVERY_WAIT_REASONS.map(reason => [reason, true])) as Record<(typeof DELIVERY_WAIT_REASONS)[number], true>;
void everyWaitReason;

export function isDeliveryWaitReason(value: unknown): value is DeliveryWaitReason {
  return typeof value === "string" && (DELIVERY_WAIT_REASONS as readonly string[]).includes(value);
}

export function isPumpVerdictCode(code: string): code is PumpVerdictCode {
  return Object.hasOwn(PUMP_VERDICTS, code);
}

export function verdictWait(code: PumpVerdictCode): DeliveryWaitReason {
  return PUMP_VERDICTS[code].wait;
}

/** 정체 점검이 기한을 재는 판정이면 그 기한(ms). 아니면 null. */
export function verdictPatience(code: string, thresholdMs: number): number | null {
  if (!isPumpVerdictCode(code)) return null;
  const watch = (PUMP_VERDICTS[code] as { watch?: "busy" | "waking" }).watch;
  return watch === "waking" ? thresholdMs * 2.5 : watch === "busy" ? thresholdMs : null;
}

/** 정체 점검 때 펌프가 다시 판정해야 하는 판정인가(끝을 알리는 사건이 빠지면 낡는 판정). */
export function verdictRejudged(code: string): boolean {
  return isPumpVerdictCode(code) && PUMP_VERDICTS[code].rejudge;
}

/** 그 팀장의 모든 미전달을 막는 판정(전달 하나하나의 사정보다 먼저 본다). 깨우는 중은 이 전달 자신의 수신 확인 다음에 본다. */
export const MEMBER_GATE_WAITS: ReadonlySet<DeliveryWaitReason> = new Set(["api_outage", "usage_limit", "archived", "runner_off", "manual_control", "approval", "receipt_check"]);
/** 기한을 넘기면 '이유 없는 대기'로 돌리는 화면 사유. */
export const WATCHED_WAITS: ReadonlySet<DeliveryWaitReason> = new Set(["member_busy", "waking"]);
