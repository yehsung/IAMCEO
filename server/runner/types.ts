import type { ActivityKind, ApprovalOption, ApprovalPrompt, Backend, BlockedReason, CliProvider, DeliveryEvidence, DeliveryFinding, Effort, MemberKind, MemberOrigin, PermissionMode, StatusObservation } from "../../shared/types.ts";
import type { ContextReading } from "./context.ts";

// 실행기 계약. 운영이 등록하는 실행기는 core 하나다(server/runner/core.ts 의 CoreRunner).
// 옛 herdr·headless 실행기는 지웠다. 그 실행기만 내던 이벤트(context·subagents·background)와 전용 옵션도 함께 없앴다.

/**
 * not_blocked: 승인 창 앞이 아니다. unrecognized: 창은 있으나 승인 창으로 못 읽었다. changed: 보여 준 창과 지금 창이 다르다(current 에 새 창).
 * no_option: 그런 번호가 없다. no_effect: 눌렀는데 창이 그대로다. gone: 터미널이 없다.
 */
export type ApprovalAnswer =
  | { ok: true; prompt: ApprovalPrompt; chosen: ApprovalOption }
  | { ok: false; reason: "not_blocked" | "unrecognized" | "changed" | "no_option" | "no_effect" | "gone" | "input_busy"; current?: ApprovalPrompt | null };

export interface RunnerMember {
  /** Official interactive provider; absent means Claude. */
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
  /** 서브에이전트 모델. CLI 를 띄울 때 환경변수로 넘긴다. null 이면 넘기지 않는다. */
  subagentModel: string | null;
  permissionMode: PermissionMode;
  kind: MemberKind;
  /** adopted 는 옛 실행기 시절 넘겨받은 명부다. core 는 그 세션을 띄우지도 끝내지도 않는다(unsupported). */
  origin?: MemberOrigin;
  /** 영속 세대. 미확인을 0으로 복원하지 않는다. */
  sessionGeneration?: number;
}

export interface StartOpts {
  systemPromptFile: string;
  mcpConfigFile: string;
  resume: boolean;
  /** 있으면 --settings 로 넘긴다(Claude). 상태줄 기록과, 대표가 확인한 바이패스 모드의 경고 창 끄기가 들어 있다. */
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
/** 같은 관측에서 나온 이벤트는 같은 식별자를 싣는다. 시험용 가짜 실행기는 생략할 수 있다. */
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
 * input_busy: 빈 입력칸을 확인하지 못했다(사람이 쓰던 글, 선택 창·승인 창, 직접 조작권). core 는 남의 글을 지우지 않고 넣지 않는다.
 */
export type SendResult =
  | { ok: true; /** 검증된 수신 ACK와 턴 시작은 다르며 started:false도 재전송 근거가 아니다. */ started?: boolean | null; turn?: number; receipt?: DeliveryReceipt }
  | { ok: false; reason: "busy" | "blocked" | "input_busy" | "down" | "gone" | "error"; detail?: string; retryable: boolean; /** 누락/모르는 오류는 unknown으로 다룬다. */ deliveryEffect?: DeliveryEffect };

export type RunnerEvent = RunnerObservation & (
  | { type: "status"; memberId: string; status: "working" | "idle" | "blocked" | "gone"; blockedReason?: BlockedReason | null; usageLimit?: import("../api-outage.ts").UsageMenu; observation?: StatusObservation; exit?: { reason: string | null; exitCode: number | null } }
  | { type: "input_ready"; memberId: string }
  | { type: "turn_end"; memberId: string; finalText: string; isError: boolean; errorText?: string; exitCode?: number | null; reason?: string | null;
      /** 상태 보고가 사라져 끝난 것으로 읽은 턴. 끝난 것은 맞지만 성공했다는 증거는 아니다. */
      inferred?: boolean }
  | { type: "activity"; memberId: string; kind: ActivityKind; text: string }
  /**
   * 턴 끝 실측 창·사용량 또는 화면 추정. 서버가 출처와 함께 저장하고 문맥 % 를 정한다.
   */
  | ({ type: "context_usage"; memberId: string } & ContextReading)
  | { type: "session"; memberId: string; sessionId: string }
  | { type: "compacted"; memberId: string }
  | { type: "pane"; memberId: string; paneId: string }
);

export interface TerminalControlAction { action: "claim" | "release" | "input" | "key"; leaseId?: string; text?: string; key?: string }
export type TerminalControlRequest = TerminalControlAction;
export interface TerminalControlResult { leaseId?: string; expiresAt?: number }

/**
 * 선택 항목(?)은 시험용 가짜 실행기가 생략할 수 있게 남겨 둔 것이다. 생략하면 총괄은 그 기능이 없는 것으로 다룬다.
 * 운영 실행기는 FullRunner 로 전부 구현한다.
 */
export interface Runner {
  terminalInfo?(m: RunnerMember): Promise<{ cols: number; rows: number }>;
  terminalLease?(memberId: string): import("../service-contracts.ts").TerminalLease | null;
  renewLease?(memberId: string, leaseId: string): number;
  noteTerminalInput?(memberId: string, write: () => void): Promise<void>;
  /** Explicit human terminal control; claim pauses automatic delivery. */
  terminalControl?(m: RunnerMember, action: TerminalControlAction): Promise<TerminalControlResult>;
  readonly kind: Backend;
  available(): Promise<{ ok: boolean; detail?: string }>;
  /** 세션을 만들거나 이어서 연다. */
  start(m: RunnerMember, o: StartOpts): Promise<RunnerStartResult>;
  /** 조회/기존 소유 terminal bind만 한다. 후보 부재/충돌을 terminal.run의 허가로 쓰지 않는다. */
  reattachOwned?(m: RunnerMember): Promise<RunnerReattachResult>;
  /** 턴을 시작한다(글 넣기). 한 직원당 동시에 한 턴. */
  send(m: RunnerMember, text: string, o: StartOpts, urgent?: boolean): Promise<SendResult>;
  /** 미지원 hook은 unknown이다. 성공으로 대체하거나 자동 본문 재전송하지 않는다. */
  inspectDelivery?(m: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection>;
  repairDelivery?(m: RunnerMember, request: DeliveryRepair): Promise<SendResult>;
  /**
   * 엔진이 그 터미널을 끝났다고 알리거나, 모른다고 확정해 답했는가. 살아 있거나 답이 없으면 false 다(답이 없는 것은 사라졌다는 근거가 아니다).
   * 읽기만 한다.
   */
  terminalGone?(terminalId: string): Promise<boolean>;
  /**
   * 터미널 없이 세션 기록만 읽어 봉투의 수신 표지를 찾는다. 봉투가 묶인 터미널의 사라짐이 확정된 뒤에만 쓴다:
   * 그 터미널의 입력칸·턴 번호는 더 볼 수 없고 볼 까닭도 없다. snapshot 은 없고 finding 은 received·not_received·unknown 뿐이다.
   * not_received 는 판정 범위를 끝까지 읽었고 표지가 없다는 뜻이다.
   */
  inspectGoneDelivery?(m: RunnerMember, query: DeliveryProbe): DeliveryInspection;
  isBusy(memberId: string): boolean;
  /**
   * 일하는 중인 턴에 긴급 글을 끼워 넣을 수 있는가. false 면 긴급도 턴이 끝난 뒤 보통 묶음으로 나간다
   * (넣을 수 없는 실행기에 시도하면 거절 기록만 쌓여 그 직원의 대기열이 통째로 미뤄졌다). 없으면 넣을 수 있다고 본다.
   */
  readonly interjects?: boolean;
  /**
   * Whether this member is actually running (or may be running) a CLI turn and so holds one of maxConcurrentTurns.
   * A write whose result is unknown on a CLI that is observed idle/done is a delivery fence, not a running turn.
   * Absent: isBusy is used.
   */
  occupiesTurnSlot?(memberId: string): boolean;
  compact(m: RunnerMember, focus: string, o: StartOpts): Promise<SendResult>;
  setParallel(m: RunnerMember, on: boolean, o: StartOpts): Promise<SendResult>; // /effort ultracode on|off
  interrupt(m: RunnerMember): Promise<void>;
  /**
   * 잠재우기: 터미널을 끝낸다(세션 기록은 남는다). {whileWorking:false} 면 최종 상태를 다시 검사하고,
   * 실제 종료를 확인한 뒤 resolve 한다.
   */
  stop(m: RunnerMember, opts?: RunnerStopOptions): Promise<void>;
  /** stop 이 터미널을 끝낼 수 있는지 아무것도 바꾸지 않고 본다. 못 끝내면 stop 과 같은 오류를 던진다. whileWorking: 곧 끊을 턴이라 일하는 중은 문제 삼지 않는다. */
  checkStop?(m: RunnerMember, opts?: RunnerStopOptions): Promise<void>;
  screen(m: RunnerMember): Promise<string>;
  /** 실행기가 확인할 수 있는 승인·설정 창을 읽는다. 아니거나 알아볼 수 없는 창이면 null. */
  usageLimitSnapshot?(m: RunnerMember): Promise<{ menu: import("../api-outage.ts").UsageMenu | null; state: string | null }>;
  dismissUsageLimit?(m: RunnerMember, fingerprint: string): Promise<{ ok: boolean; note?: string }>;
  approval?(m: RunnerMember): Promise<ApprovalPrompt | null>;
  /** 화면을 다시 읽어 fingerprint 가 같을 때만 고른 선택지에 맞는 키를 한 번 보내고 상태를 다시 관측한다. */
  answerApproval?(m: RunnerMember, fingerprint: string, option: number): Promise<ApprovalAnswer>;
  on(cb: (e: RunnerEvent) => void): void;
  shutdown(): Promise<void>;
  /**
   * 쉬고 있는 세션을 새 설정(모델·effort·서브에이전트)으로 다시 연다. 기록은 그대로 이어진다. 넣기 전 점검(승인 창·일하는 중·입력칸)을 똑같이 한다.
   * 총괄은 이 메서드가 있으면 '설정 맞추기를 하는 실행기'로 보고, 실제 다시 열기는 자기 쪽 절차(switchProvider)로 한다.
   */
  applyConfig?(m: RunnerMember, o: StartOpts): Promise<SendResult>;
  /** 세션 기록이 디스크에 있는가. 모르면 구현하지 않는다. 이어 열기가 실패했을 때 새 세션으로 갈지 정한다. */
  sessionExists?(m: RunnerMember): boolean;
}

/** 운영 실행기(CoreRunner)가 지키는 전체 계약. 선택 항목까지 모두 구현해야 컴파일된다. */
export type FullRunner = Required<Runner>;
