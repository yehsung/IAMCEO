import type { ActivityKind, ApprovalOption, ApprovalPrompt, Backend, BlockedReason, CliProvider, DeliveryEvidence, DeliveryFinding, Effort, MemberKind, MemberOrigin, PermissionMode, StatusObservation, SubagentState } from "../../shared/types.ts";
import type { ContextReading } from "./context.ts";

/**
 * not_blocked: 승인 창 앞이 아니다. unrecognized: 창은 있으나 승인 창으로 못 읽었다. changed: 보여 준 창과 지금 창이 다르다(current 에 새 창).
 * no_option: 그런 번호가 없다. no_effect: 눌렀는데 창이 그대로다. gone: 칸이 없다.
 */
export type ApprovalAnswer =
  | { ok: true; prompt: ApprovalPrompt; chosen: ApprovalOption }
  | { ok: false; reason: "not_blocked" | "unrecognized" | "changed" | "no_option" | "no_effect" | "gone" | "input_busy"; current?: ApprovalPrompt | null };

export interface RunnerMember {
  /** Official interactive provider; absent for legacy Claude members. */
  cli?: "claude" | "codex";
  /** Native subagent preference, retained across core reconnects. */
  parallel?: boolean;
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
  /** 영속 세대. 구형 어댑터에는 강제하지 않으며 미확인을 0으로 복원하지 않는다. */
  sessionGeneration?: number;
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
  /** start 전 저장된 실행 의도. 응답 유실 뒤 같은 operation/member로 재결합한다. */
  operationId?: string;
}

/** 내부 식별자. 프로토콜 generation(예: core 1)과 멤버 sessionGeneration은 별개다. */
export interface RunnerTerminalIdentity {
  terminalId: string | null;
  sessionId: string | null;
  sessionGeneration: number;
  process: { pid: number; startedAt: string | null } | null;
}
/** 기존 어댑터 이벤트에는 선택적이다. 지원 어댑터는 같은 관측의 식별자를 고정해 보낸다. */
export interface RunnerObservation {
  terminalId?: string | null;
  sessionGeneration?: number;
  turn?: number | null;
  inputEpoch?: number | null;
  observedAt?: string;
  runId?: string;
}
export interface RunnerStartResult {
  sessionId: string | null;
  paneId: string | null;
  tabId?: string | null;
  rejoined?: boolean;
  identity?: RunnerTerminalIdentity;
}
export type RunnerReattachResult =
  | { outcome: "rejoined"; started: RunnerStartResult }
  | { outcome: "not_found" | "conflict" | "unknown"; code: string; detail?: string };
export interface RunnerStopOptions { whileWorking?: boolean }
export interface DeliveryLogBaseline {
  /** 검증된 provider 루트 내부 경로. HTTP 응답에 직렬화하지 않는다. */
  path: string;
  fileIdentity: string | null;
  /** 마지막 완성 JSONL 행 뒤의 byte offset. 일부 줄/미탐색은 완전 부재가 아니다. */
  offset: number;
  eventId: string | null;
}
export interface DeliveryBaseline {
  serverEpoch: string;
  turn: number | null;
  inputEpoch: number | null;
  logs: DeliveryLogBaseline[];
  /** native ID 미확정 후보 탐색도 재시작 때 같은 기준선을 사용한다. */
  capturedAt: string;
}
export interface DeliveryProbe {
  dispatchId: string;
  cli: CliProvider;
  backend: Backend;
  markers: { deliveryId: string; marker: string }[];
  bundleMarker: string;
  identity: RunnerTerminalIdentity;
  baseline: DeliveryBaseline;
  wireSha256: string;
}
export interface DeliverySnapshot {
  identity: RunnerTerminalIdentity;
  observedAt: string;
  turn: number | null;
  inputEpoch: number | null;
  ownership: "verified" | "conflict" | "unknown";
  status: "working" | "idle" | "done" | "blocked" | "gone" | "unknown";
  blockedReason: BlockedReason | null;
  leaseActive: boolean;
  mutation: "none" | "send" | "config" | "compact" | "manual" | "unknown";
  composer: "empty" | "matches" | "different" | "unknown";
  /** settled는 원래 쓰기의 완료/입력 큐 소진 증거다. 단순 timeout/화면 안정이 아니다. */
  originalWrite: "not_written" | "rejected" | "settled" | "unresolved";
  externalInput: boolean | null;
}
export interface DeliveryInspection {
  evidence: DeliveryEvidence[];
  finding: DeliveryFinding;
  /** 일부 묶음만 확인되면 해당 ID만 반환한다. */
  receivedDeliveryIds: string[];
  snapshot: DeliverySnapshot | null;
  quiescence: "settled" | "unresolved";
}
/** 임의 본문을 받지 않는다. 저장 봉투/원본 판을 같은 입력 mutex 안에서 다시 검증한다. */
export interface DeliveryRepair {
  action: "resend" | "submit_only";
  dispatchId: string;
  expectedRecoveryVersion: number;
  expectedSessionGeneration: number;
  expectedSessionId: string | null;
  expectedTerminalId: string;
  expectedInputEpoch: number;
}
export type DeliveryEffect = "not_written" | "rejected" | "unknown";
export interface DeliveryReceipt {
  dispatchId: string;
  receivedAt: string;
  source: "transport" | "claude_log" | "codex_log";
}

/**
 * input_busy(herdr): 입력칸을 못 찾았거나(선택 창·승인 창·셸 모드) 남은 글을 지금은 지울 수 없다(일하는 중이라 지우는 키가 턴을 끊음,
 * 방금 지워 종료 창이 열려 있음). 입력칸에 남은 글 자체는 보류 사유가 아니다. 실행기가 지우고 넣는다.
 */
export type SendResult =
  | { ok: true; /** 검증된 수신 ACK와 턴 시작은 다르며 started:false도 재전송 근거가 아니다. */ started?: boolean | null; turn?: number; receipt?: DeliveryReceipt }
  | { ok: false; reason: "busy" | "blocked" | "input_busy" | "down" | "gone" | "error"; detail?: string; retryable: boolean; /** 누락/모르는 오류는 unknown으로 다룬다. */ deliveryEffect?: DeliveryEffect };

export type RunnerEvent = RunnerObservation & (
  | { type: "status"; memberId: string; status: "working" | "idle" | "blocked" | "gone"; blockedReason?: BlockedReason | null; observation?: StatusObservation; exit?: { reason: string | null; exitCode: number | null } }
  /** noOutput는 처리 진단이며 미수신 증거가 아니다. 원문 재전송 판정은 전달 복구가 맡는다. */
  | { type: "turn_end"; memberId: string; finalText: string; isError: boolean; errorText?: string; noOutput?: boolean; exitCode?: number | null; reason?: string | null }
  | { type: "activity"; memberId: string; kind: ActivityKind; text: string }
  /** 실제 창 크기로 잰 문맥 %(headless 의 modelUsage, 압축 직후 0). */
  | { type: "context"; memberId: string; pct: number; /** headless 주 모델의 modelUsage 실측값일 때만 전달. */ window?: number }
  /**
   * 턴 끝 실측 창·사용량 또는 화면 추정. 서버가 출처와 함께 저장하고 문맥 % 를 정한다.
   */
  | ({ type: "context_usage"; memberId: string } & ContextReading)
  | { type: "subagents"; memberId: string; count: number; measurement?: SubagentState }
  /**
   * 턴을 마치고 뒤 작업(워크플로 등)을 기다린다(label: 화면에 적힌 그 작업), 또는 그 기다림이 끝났다(null).
   * 기다리는 동안 그 팀은 일하는 중이고, 세션은 넣은 글을 곧바로 받는다.
   */
  | { type: "background"; memberId: string; label: string | null }
  | { type: "session"; memberId: string; sessionId: string }
  | { type: "compacted"; memberId: string }
  | { type: "pane"; memberId: string; paneId: string; tabId?: string }
);

export interface TerminalControlAction { action: "claim" | "release" | "input" | "key"; leaseId?: string; text?: string; key?: string }
export type TerminalControlRequest = TerminalControlAction;
export interface TerminalControlResult { leaseId?: string; expiresAt?: number }

export interface Runner {
  /** Explicit human terminal control; claim pauses automatic delivery. */
  terminalControl?(m: RunnerMember, action: TerminalControlAction): Promise<TerminalControlResult>;
  readonly kind: Backend;
  available(): Promise<{ ok: boolean; detail?: string }>;
  /** 세션을 만들거나 이어서 연다. headless 는 sessionId 만 정한다. */
  start(m: RunnerMember, o: StartOpts): Promise<RunnerStartResult>;
  /** 조회/기존 소유 terminal bind만 한다. 후보 부재/충돌을 terminal.run의 허가로 쓰지 않는다. */
  reattachOwned?(m: RunnerMember): Promise<RunnerReattachResult>;
  /** 턴을 시작한다(글 넣기). 한 직원당 동시에 한 턴. */
  send(m: RunnerMember, text: string, o: StartOpts, urgent?: boolean): Promise<SendResult>;
  /** 미지원 hook은 unknown이다. 성공으로 대체하거나 자동 본문 재전송하지 않는다. */
  inspectDelivery?(m: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection>;
  repairDelivery?(m: RunnerMember, request: DeliveryRepair): Promise<SendResult>;
  isBusy(memberId: string): boolean;
  compact(m: RunnerMember, focus: string, o: StartOpts): Promise<SendResult>;
  setParallel(m: RunnerMember, on: boolean, o: StartOpts): Promise<SendResult>; // /effort ultracode on|off
  interrupt(m: RunnerMember): Promise<void>;
  /**
   * 잠재우기: headless는 프로세스 정리, herdr는 칸 닫기(세션 기록 보존).
   * 옵션 생략 시 기존 동작 유지. safe stop 구현은 {whileWorking:false}일 때 최종 상태를
   * 다시 검사하고 실제 종료 확인 뒤 resolve한다. 타입 추가만으로 기존 어댑터가 지원한다고 광고하지 않는다.
   */
  stop(m: RunnerMember, opts?: RunnerStopOptions): Promise<void>;
  /** stop 이 넘겨받은 칸을 끝낼 수 있는지 아무것도 바꾸지 않고 본다. 못 끝내면 stop 과 같은 오류를 던진다. whileWorking: 곧 끊을 턴이라 일하는 중은 문제 삼지 않는다. 칸을 끝내지 않는 실행기는 구현하지 않는다. */
  checkStop?(m: RunnerMember, opts?: RunnerStopOptions): Promise<void>;
  screen(m: RunnerMember): Promise<string>;
  /** 실행기가 확인할 수 있는 승인·설정 창을 읽는다. 아니거나 알아볼 수 없는 창이면 null. */
  approval?(m: RunnerMember): Promise<ApprovalPrompt | null>;
  /** 화면을 다시 읽어 fingerprint 가 같을 때만 고른 선택지에 맞는 키를 한 번 보내고 상태를 다시 관측한다. */
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
