import type { ActivityKind, ApprovalOption, ApprovalPrompt, Backend, Effort, MemberKind, MemberOrigin, PermissionMode } from "../../shared/types.ts";

/**
 * not_blocked: 승인 창 앞이 아니다. unrecognized: 창은 있으나 승인 창으로 못 읽었다. changed: 보여 준 창과 지금 창이 다르다(current 에 새 창).
 * no_option: 그런 번호가 없다. no_effect: 눌렀는데 창이 그대로다. gone: 칸이 없다.
 */
export type ApprovalAnswer =
  | { ok: true; prompt: ApprovalPrompt; chosen: ApprovalOption }
  | { ok: false; reason: "not_blocked" | "unrecognized" | "changed" | "no_option" | "no_effect" | "gone"; current?: ApprovalPrompt | null };

export interface RunnerMember {
  id: string;
  projectId: string;
  handle: string;
  name: string;
  cwd: string;
  sessionId: string | null;
  paneId: string | null;
  model: string | null;
  effort: Effort | null;
  /** 서브에이전트 모델. 환경변수로 넘긴다(childEnv·칸 환경). null 이면 넘기지 않는다. */
  subagentModel: string | null;
  permissionMode: PermissionMode;
  kind: MemberKind;
  /** adopted 는 대표가 쓰던 칸이다. 원래 인자(--mcp-config 등)가 없고, 칸을 옮기거나 닫지 않는다. */
  origin?: MemberOrigin;
}

export interface StartOpts {
  systemPromptFile: string;
  mcpConfigFile: string;
  resume: boolean;
  firstPrompt?: string;
  herdrTabId?: string | null;
  projectName: string;
  /** 이 프로젝트 직원들의 세션. DB 의 탭 번호는 그 탭에 이 세션들이 있을 때만 믿는다. */
  projectSessions?: string[];
  /** 있으면 --settings 로 넘긴다(herdr). 대표가 고른 바이패스 모드의 경고 창이 빈 칸에서 멈추지 않게 한다. */
  settingsFile?: string;
  /** 글 끝에 #id 가 없을 때 쓸 표지. 재시작 복구에서 이번 글이 들어갔는지 찾는다. */
  marker?: string;
}

/**
 * input_busy(herdr): 입력칸을 못 찾았거나(선택 창·승인 창·셸 모드) 남은 글을 지금은 지울 수 없다(일하는 중이라 지우는 키가 턴을 끊음,
 * 방금 지워 종료 창이 열려 있음). 입력칸에 남은 글 자체는 보류 사유가 아니다. 실행기가 지우고 넣는다.
 */
export type SendResult =
  | { ok: true }
  | { ok: false; reason: "busy" | "blocked" | "input_busy" | "down" | "gone" | "error"; detail?: string; retryable: boolean };

export type RunnerEvent =
  | { type: "status"; memberId: string; status: "working" | "idle" | "blocked" | "gone" }
  /** noOutput: 입력을 읽고 일한 흔적 없이 오류로 끝났다(사용량 한도 등). 서버가 그 입력을 다시 보낸다. */
  | { type: "turn_end"; memberId: string; finalText: string; isError: boolean; errorText?: string; noOutput?: boolean }
  | { type: "activity"; memberId: string; kind: ActivityKind; text: string }
  | { type: "context"; memberId: string; pct: number }
  | { type: "subagents"; memberId: string; count: number }
  | { type: "session"; memberId: string; sessionId: string }
  | { type: "compacted"; memberId: string }
  | { type: "pane"; memberId: string; paneId: string; tabId?: string };

export interface Runner {
  readonly kind: Backend;
  available(): Promise<{ ok: boolean; detail?: string }>;
  /** 세션을 만들거나 이어서 연다. headless 는 sessionId 만 정한다. */
  start(m: RunnerMember, o: StartOpts): Promise<{ sessionId: string | null; paneId: string | null; tabId?: string | null; rejoined?: boolean }>;
  /** 턴을 시작한다(글 넣기). 한 직원당 동시에 한 턴. */
  send(m: RunnerMember, text: string, o: StartOpts, urgent?: boolean): Promise<SendResult>;
  isBusy(memberId: string): boolean;
  compact(m: RunnerMember, focus: string, o: StartOpts): Promise<SendResult>;
  setParallel(m: RunnerMember, on: boolean, o: StartOpts): Promise<SendResult>; // /effort ultracode on|off
  interrupt(m: RunnerMember): Promise<void>;
  /** 잠재우기: headless 는 프로세스만 정리, herdr 는 칸 닫기(세션 파일은 남음) */
  stop(m: RunnerMember): Promise<void>;
  /** stop 이 넘겨받은 칸을 끝낼 수 있는지 아무것도 바꾸지 않고 본다. 못 끝내면 stop 과 같은 오류를 던진다. whileWorking: 곧 끊을 턴이라 일하는 중은 문제 삼지 않는다. 칸을 끝내지 않는 실행기는 구현하지 않는다. */
  checkStop?(m: RunnerMember, opts?: { whileWorking?: boolean }): Promise<void>;
  screen(m: RunnerMember): Promise<string>;
  /** 칸이 권한 승인 창 앞이면 그 창을 읽는다. 아니거나 알아볼 수 없는 창이면 null. 창이 없는 실행기는 구현하지 않는다. */
  approval?(m: RunnerMember): Promise<ApprovalPrompt | null>;
  /** 화면을 다시 읽어 fingerprint 가 같을 때만 option 번호 키를 누르고, 창이 닫혔는지 확인한다. */
  answerApproval?(m: RunnerMember, fingerprint: string, option: number): Promise<ApprovalAnswer>;
  on(cb: (e: RunnerEvent) => void): void;
  shutdown(): Promise<void>;
  /**
   * 쉬고 있는 세션을 새 설정(모델·effort·서브에이전트)으로 다시 연다. 기록은 그대로 이어진다. 넣기 전 점검(승인 창·일하는 중·입력칸)을 똑같이 한다.
   * headless 는 턴마다 인자를 다시 정하므로 구현하지 않는다.
   */
  applyConfig?(m: RunnerMember, o: StartOpts): Promise<SendResult>;
  /** 세션 기록이 디스크에 있는가. 모르면 구현하지 않는다. 이어 열기가 실패했을 때 새 세션으로 갈지 정한다. */
  sessionExists?(m: RunnerMember): boolean;
  /** 서버가 강제로 죽어 남은 자식을 정리한다. 재시작 복구 맨 앞에서 부른다. */
  reapOrphans?(): Promise<void>;
}
