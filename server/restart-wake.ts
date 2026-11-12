// 재시작(Mac 또는 실행 엔진)으로 꺼진 팀장을 서버가 스스로 다시 여는 일의 대상·속도·글. 끄는 설정은 없다.
// 흐름은 Orchestrator 에 있다(noteRestartLoss · kickRestartWakes · settleRestartWake). 여기는 값과 판정만 둔다.

/** 속도. OrchestratorTimings 에 그대로 들어가 시험에서 줄일 수 있다. */
export interface RestartWakePacing {
  /** 한 번에 여는 팀장 수. */
  restartWakeParallel: number;
  /** 연 팀장의 CLI 가 상태(쉬는 중·일하는 중·막힘)를 알릴 때까지 다음 차례를 미루는 상한. */
  restartWakeSettleMs: number;
  /** 한 명을 연 뒤 다음을 열기까지의 최소 간격. */
  restartWakeGapMs: number;
  /** 자리를 잡았는지 다시 보는 간격. */
  restartWakePollMs: number;
}
export const RESTART_WAKE_PACING: RestartWakePacing = {
  restartWakeParallel: 1,
  restartWakeSettleMs: 30_000,
  restartWakeGapMs: 2_000,
  restartWakePollMs: 250,
};

/**
 * 한 번의 꺼짐에 대해 서버가 스스로 열어 보는 횟수의 상한. 여는 데 실패한 것이 확인되면 한 번으로 끝난다.
 * 여는 도중 서버가 또 내려가 결과를 남기지 못한 시도만 한 번 더 한다(2026-11-12 에는 하루에 세 번 재시작했다).
 */
export const RESTART_WAKE_MAX_ATTEMPTS = 2;

/** 엔진이 알려 주는 종료 사유 가운데 재시작으로 터미널을 잃은 것. CLI 가 스스로 끝난 것(exited 와 종료 코드)은 아니다. */
export function endedByRestart(reason: string | null | undefined): boolean {
  return reason === "holder_lost" || reason === "stopped_by_restart";
}

/** 팀장의 lastError·활동에 남는 글: 재시작으로 세션이 꺼졌다. */
export const RESTART_EXIT_NOTE = "Mac이나 실행 엔진이 다시 시작되어 세션이 꺼졌습니다. 말을 걸거나 깨우면 하던 대화를 이어서 엽니다";
/** 다시 연 팀장의 활동에 남는 글. */
export const RESTART_REOPENED_NOTE = "Mac이나 실행 엔진이 다시 시작되어 꺼졌던 세션을 이어서 열었습니다";
/**
 * 재시작으로 턴 도중에 끊긴 팀장에게, 다시 연 뒤 실행마다 한 번 넣는 글. 원래 지시를 다시 넣지 않는다(세션 기록에 끊긴 턴이 그대로 있다).
 * 이 글로 시작한 턴에도 평소의 보고 의무와 보고 보완이 그대로 적용된다.
 */
export const RESTART_RESUME_TEXT = "[시스템] Mac이나 실행 엔진이 다시 시작되어 하던 일이 중간에 끊겼습니다. 끊기기 직전까지 한 일을 먼저 확인하고(파일, 명령 결과, 외부 서비스의 상태), 끝나지 않은 부분만 이어서 하세요. 이미 끝낸 일을 다시 하지 마세요. 끝나면 평소처럼 보고하세요.";

/**
 * "재시작으로 꺼졌고 아직 다시 열지 않았다"는 표식. 팀장 ID 별로 settings 표의 `restartWake` 키에 적는다(스키마 변경 없음).
 * 서버가 또 재시작해도 남는다. 다시 열렸거나, 대표가 재우거나 닫았거나, 세션이 새로 바뀌면 지운다.
 */
export interface RestartWake {
  /** 꺼질 때의 세션 세대. 세대가 바뀌면(새 세션) 이 표식은 더 맞지 않는다. */
  generation: number;
  /**
   * holder_lost · stopped_by_restart: 엔진이 알려 준 종료 사유. terminal_absent: 엔진이 그 터미널을 모른다고 확정했다.
   * legacy_note: 이 기능 전에 꺼져 lastError 의 글로만 남아 있던 것.
   */
  reason: "holder_lost" | "stopped_by_restart" | "terminal_absent" | "legacy_note";
  lostAt: string;
  /**
   * pending: 차례를 기다림 · opening: 여는 중(결과가 아직 없음) · failed: 열어 봤고 실패(이 꺼짐에는 다시 스스로 열지 않는다)
   * · resumed: 다시 열었고, 이어가기 글이 아직 나가지 않았다.
   */
  state: "pending" | "opening" | "failed" | "resumed";
  /** 서버가 스스로 열어 본 횟수. */
  attempts: number;
  /** 이 꺼짐으로 턴 도중에 끊긴 실행. 다시 열면 이어가기 글을 넣고, 못 열면 총괄에게 중단을 알린다. 알림은 실행마다 한 번이다. */
  runIds: string[];
  /** 이어가기 글의 전달 ID. 그 팀장에게 기다리던 다른 전달보다 먼저, 혼자 나간다. */
  resumeId: string | null;
}

/** 저장된 값 하나를 표식으로 읽는다. 모양이 다르면 null(없는 것으로 본다). */
export function parseRestartWake(value: unknown): RestartWake | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.generation) || (v.generation as number) < 0) return null;
  if (!["holder_lost", "stopped_by_restart", "terminal_absent", "legacy_note"].includes(v.reason as string)) return null;
  if (!["pending", "opening", "failed", "resumed"].includes(v.state as string)) return null;
  return {
    generation: v.generation as number,
    reason: v.reason as RestartWake["reason"],
    lostAt: typeof v.lostAt === "string" ? v.lostAt : new Date(0).toISOString(),
    state: v.state as RestartWake["state"],
    attempts: Number.isSafeInteger(v.attempts) && (v.attempts as number) >= 0 ? v.attempts as number : 0,
    runIds: Array.isArray(v.runIds) ? v.runIds.filter((id): id is string => typeof id === "string") : [],
    resumeId: typeof v.resumeId === "string" ? v.resumeId : null,
  };
}

/**
 * 이 기능 전에 재시작으로 꺼진 팀장은 표식 없이 lastError 의 글만 남아 있다. 예: `초기/실행 종료: holder_lost (exit_code=unknown)`,
 * 또는 그 뒤의 안내 글(RESTART_EXIT_NOTE). 그 글을 표식으로 옮길 때만 쓴다. 새로 꺼지는 팀장은 글이 아니라 종료 사유로 가린다.
 */
export function restartNoteIn(lastError: string | null | undefined): boolean {
  if (!lastError) return false;
  return lastError === RESTART_EXIT_NOTE || /(^|[^a-z_])(holder_lost|stopped_by_restart)([^a-z_]|$)/.test(lastError);
}
