// 후속 웨이브가 주입할 서비스 포트. 현재 Store/Orchestrator/Runner에 implements를 강제하지 않는다.
// 구현이 없는 포트는 capability=false/HTTP 501이며 성공 stub으로 대체하지 않는다.
import type {
  ArchiveMessagePage, ArchiveProjectState, CoreContextState, Decision, DecisionCloseFollowUp, Delivery,
  DeliveryNoticePage, DeliveryNoticePageOptions, DeliveryNotices, DeliveryRecoveryPhase,
  DeliveryRecoveryRequest, DeliveryRecoveryResult, UnassignedRecoveryRequest, UnassignedRecoveryResult, Member, Message, MessagePage,
  MessagePageOptions, PatchProjectReq, Project,
} from "../shared/types.ts";
import type {
  AgentOperationContext, FreshSessionRequest, ManualInboxAckRequest, ManualInboxAckResult,
  ManualInboxBatch, MemberConfigWriteRequest, MemberConfigWriteResult, OperationReceipt,
  RevisionPrecondition, SettingsWriteRequest, SettingsWriteResult, TerminalControlRequestV2,
  TodoDoneRequest, TodoWriteResult,
} from "../shared/operations.ts";
import type { PushReportGroup } from "../shared/push.ts";
import type { AgentToolResult } from "./orchestrator-api.ts";
import type { ProjectPatch } from "./store.ts";
import type { DeliveryBaseline, DeliveryProbe, RunnerTerminalIdentity } from "./runner/types.ts";

/** Store가 SQL/범위 정규화/커서/transaction을 단독 소유한다. 모든 GET은 runner/pump 0회. */
export interface MessageReadStore {
  listMessagePage(projectId: string, opts?: MessagePageOptions): MessagePage;
  requireMessage(id: string): Message;
  archiveState(projectId: string): ArchiveProjectState;
  listArchiveMessagePage(projectId: string, opts?: MessagePageOptions): ArchiveMessagePage;
}
export interface ProjectPatchStore {
  validateProjectPatch(id: string, patch: ProjectPatch): ProjectPatch;
  patchProject(id: string, patch: ProjectPatch): Project;
}
export interface ProjectManagementService {
  patchProject(projectId: string, patch: PatchProjectReq): Promise<Project>;
}
export interface DeliveryRecoveryService {
  notices(projectId: string): DeliveryNotices;
  memberNotices(memberId: string, opts?: DeliveryNoticePageOptions): DeliveryNoticePage;
  recoverUnassignedMessage(messageId: string, request: UnassignedRecoveryRequest): UnassignedRecoveryResult;
  recover(deliveryId: string, request: DeliveryRecoveryRequest): Promise<DeliveryRecoveryResult>;
  /** 중복 tick을 합친다. lease/승인/작업 대기는 활성 확인 예산에서 제외한다. */
  tick(): Promise<void>;
  shutdown(): Promise<void>;
}

/** 내부 영속 봉투. wireText/기준선은 사용자용 notice/receipt로 직렬화하지 않는다. */
export interface DeliveryDispatch extends DeliveryProbe {
  memberId: string;
  projectId: string;
  wireText: string;
  items: { deliveryId: string; ordinal: number; sourceRevision: string | null }[];
  transportState: "prepared" | "write_started" | "accepted" | "rejected" | "unknown";
  submitAttempts: number;
  createdAt: string;
  updatedAt: string;
}
export interface DeliveryRecoveryRecord {
  deliveryId: string;
  marker: string | null;
  phase: DeliveryRecoveryPhase;
  reason: string | null;
  version: number;
  autoAttempts: number;
  checkCount: number;
  activeCheckMs: number;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  evidence: import("../shared/types.ts").DeliveryEvidence[];
  updatedAt: string;
}

export interface VersionedWriteService {
  updateSettings(patch: SettingsWriteRequest, precondition: RevisionPrecondition): Promise<SettingsWriteResult>;
  patchMemberConfig(memberId: string, patch: MemberConfigWriteRequest, precondition: RevisionPrecondition): Promise<MemberConfigWriteResult>;
  setTodoDone(todoId: string, request: TodoDoneRequest, precondition: RevisionPrecondition): Promise<TodoWriteResult>;
}
export interface OperationService {
  /** 인증/소속 확인 뒤 동일 receipt를 버전 재검사보다 먼저 반환한다. 없는 ID는 404. */
  operation(operationId: string): Promise<OperationReceipt>;
  freshMemberSession(memberId: string, request: FreshSessionRequest): Promise<OperationReceipt<"fresh_session">>;
  /** unknown 입력은 영속 유지하며 재생하지 않는다. */
  terminalControl(memberId: string, request: TerminalControlRequestV2): Promise<OperationReceipt<"terminal_control">>;
}
export interface ManualInboxService {
  /** ACK 전 동일 batch 회수. askWait와 같은 소비 상태를 사용하고 보관 중 소비하지 않는다. */
  inbox(memberId: string, timeoutMs: number, signal?: AbortSignal): Promise<ManualInboxBatch | null>;
  acknowledge(memberId: string, request: ManualInboxAckRequest): Promise<ManualInboxAckResult>;
}
export interface AgentOperationService {
  execute(member: Member, name: string, args: Record<string, unknown>, context: AgentOperationContext, signal?: AbortSignal): Promise<AgentToolResult>;
}
/** 후속 불필요도 명시한다. 필요한 후속은 닫기 원본과 함께 outbox transaction에 넣는다. */
export type DecisionFollowUp = DecisionCloseFollowUp;
export interface ReportReferences {
  sourceMessageId: string;
  fileIds: string[];
  decisionIds: string[];
  authoredAt: string;
  sequence: number;
  correctsMessageId: string | null;
}
export interface BoardReview {
  requestedRevision: number;
  reviewedRevision: number | null;
  requestedAt: string;
  completedAt: string | null;
}
export interface AgentWorkflowService {
  closeDecision(member: Member, request: { id: string; kind: "decided" | "obsolete"; reason: string; userQuote?: string; answeredDecisionId?: string; sameIssue?: string; followUp: DecisionFollowUp }): Promise<Decision>;
  reportReferences(projectId: string, messageId: string): ReportReferences;
}
export interface ContextCompactionService {
  /** 접수/예약이며 성공 선언이 아니다. 기존 compact(m,focus,opts) 반환형은 유지한다. */
  request(memberId: string, trigger: "auto" | "manual", focus?: string): Promise<Member>;
  state(memberId: string): CoreContextState | null;
}

/** 재시작 뒤 자동 pump 전에 복원한다. lease 만료와 transport disconnect는 별개다. */
export interface TerminalLease {
  memberId: string;
  claimId: string;
  leaseId: string;
  identity: RunnerTerminalIdentity;
  expiresAt: number;
  lastInputSequence: number;
}
export interface RunnerRecoveryState {
  lease: TerminalLease | null;
  unresolvedDispatches: DeliveryDispatch[];
}
export interface RunnerRecoveryStore {
  /** Start journal supplies launch time for terminals created before the startedAt label. */
  getLifecycleJournal?(operationId: string): LifecycleJournal | null;
  inputState(memberId: string): RunnerRecoveryState;
  saveLease(lease: TerminalLease): void;
  removeLease(memberId: string, claimId: string): void;
}
export interface LifecycleJournal {
  operationId: string;
  memberId: string;
  projectId: string;
  intent: "start" | "sleep" | "close" | "archive" | "fresh_session";
  phase: "prepared" | "started" | "unknown" | "confirmed" | "refused";
  identity: RunnerTerminalIdentity;
  runId: string | null;
  deliveryIds: string[];
  baseline: DeliveryBaseline | null;
  reason: string | null;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 도메인 쓰기와 동기 실행한다. 네트워크 발신/Bus 방송/wake는 최외곽 commit 뒤다. */
export interface DomainRecorder {
  decision(before: Decision | null, after: Decision): void;
  message(message: Message): void;
  member(before: Member, after: Member): void;
}
export interface PushReportGroupStore {
  /** 같은 project/member의 첫 보고부터 고정 120초, 창 연장/취소 그룹 부활 없음. */
  appendReport(message: Message): PushReportGroup;
  closeDueGroups(now: string): void;
}
export interface OrchestratorServicePorts {
  projects?: ProjectManagementService;
  delivery?: DeliveryRecoveryService;
  writes?: VersionedWriteService;
  operations?: OperationService;
  manualInbox?: ManualInboxService;
  agentOperations?: AgentOperationService;
  workflow?: AgentWorkflowService;
  context?: ContextCompactionService;
}

/** 원본 저장+전달 의도는 같은 Store transaction으로 처리하고 commit 뒤 pump한다. */
export interface DeliveryIntentResult<T> { value: T; deliveries: Delivery[] }
