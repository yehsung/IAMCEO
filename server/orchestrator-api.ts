// http.ts 가 부르는 Orchestrator 의 겉면. 비즈니스 흐름은 구현체(orchestrator.ts)가 맡는다.
// 처리할 수 없는 요청은 ApiError(status, 한국어 메시지)를 던지면 그대로 응답이 된다.
import type {
  AdoptPreview,
  AdoptReq,
  ReleaseResult,
  AnswerApprovalReq,
  AnswerReq,
  ApprovalPrompt,
  CreateProjectReq,
  CreateMemberReq,
  RuntimeInfo,
  Decision,
  HerdrInfo,
  LiveAgent,
  Member,
  Message,
  PatchMemberReq,
  PatchProjectReq,
  Project,
  SendMessageReq,
  Settings,
  SettingsPatch,
  TidyResult,
  Todo,
  DeliveryRecoveryRequest,
  DeliveryRecoveryResult,
} from "../shared/types.ts";

import type {
  AgentOperationContext,
  FreshSessionRequest,
  ManualInboxAckRequest,
  ManualInboxAckResult,
  ManualInboxBatch,
  MemberConfigWriteRequest,
  MemberConfigWriteResult,
  OperationReceipt,
  RevisionPrecondition,
  SettingsWriteRequest,
  SettingsWriteResult,
  TerminalControlRequestV2,
  TodoDoneRequest,
  TodoWriteResult,
} from "../shared/operations.ts";

import type { TerminalControlAction, TerminalControlResult } from "./runner/types.ts";

export { ApiError } from "./store.ts";

/** `GET /agent/tools` 응답의 한 항목. MCP 도구 정의와 같은 모양. */
export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** `POST /agent/tool` 응답. text 는 CLI 세션이 받는 도구 결과. */
export interface AgentToolResult {
  text: string;
  isError?: boolean;
  /** 있으면 브리지가 `/agent/ask/wait` 로 답을 기다린 뒤 그 글을 결과로 돌려준다(origin=manual 의 ask). */
  wait?: { decisionId: string };
}

/** `POST /agent/ask/wait` 응답. done=false 면 브리지가 다시 부른다. */
export type AskWaitResult = { done: false } | { done: true; text: string; decision: Decision };

export interface OrchestratorApi {
  /** Store 로 프로젝트를 만들고 goal·startConductor 를 처리한다. */
  createProject(req: CreateProjectReq): Promise<Project>;
  /** 프로젝트 변경 단일 진입점. W9 HTTP 전환 전 fake/v1 hook은 호환한다. */
  patchProject?(projectId: string, patch: PatchProjectReq): Promise<Project>;
  createMember?(projectId: string, req: CreateMemberReq): Promise<Member>;
  runtimeInfo?(): Promise<RuntimeInfo>;
  terminalControl?(memberId: string, action: TerminalControlAction): Promise<TerminalControlResult>;
  /** http.ts 가 store.patchProject 를 끝낸 뒤 부른다(runnerEnabled 변화 등에 반응). */
  onProjectPatched(project: Project, patch: PatchProjectReq): void | Promise<void>;
  /** 저장 전에 부른다. 보관할 수 없으면 ApiError 를 던진다. */
  beforeProjectPatch?(project: Project, patch: PatchProjectReq): void | Promise<void>;
  /** 전체 설정. 실행 방식을 바꿀 수 없으면(일하는 직원이 있으면) ApiError 를 던지고, 바꿀 수 있으면 이전 실행기의 칸을 닫는다. */
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  /** 직원별 모델·effort. */
  patchMemberConfig(memberId: string, patch: PatchMemberReq): Promise<Member>;
  freshMemberSession?(memberId: string): Promise<Member>;
  /** 별도 v2 포트. 미지원이면 501/capability=false이며 v1로 쓰기를 내려 보내지 않는다. */
  updateSettingsV2?(patch: SettingsWriteRequest, precondition: RevisionPrecondition): Promise<SettingsWriteResult>;
  patchMemberConfigV2?(memberId: string, patch: MemberConfigWriteRequest, precondition: RevisionPrecondition): Promise<MemberConfigWriteResult>;
  setTodoDoneV2?(todoId: string, request: TodoDoneRequest, precondition: RevisionPrecondition): Promise<TodoWriteResult>;
  /** 동일 receipt는 세대 재검사 전에 반환한다. pending/unknown 외부 작업을 재생하지 않는다. */
  freshMemberSessionV2?(memberId: string, request: FreshSessionRequest): Promise<OperationReceipt<"fresh_session">>;
  /** claim ID와 입력 순번은 영속 lease에 결합한다. unknown 입력은 조회만 한다. */
  terminalControlV2?(memberId: string, request: TerminalControlRequestV2): Promise<OperationReceipt<"terminal_control">>;
  /** 내부 요청/토큰 없이 허용된 결과만 반환하며 소속은 매번 검사한다. */
  operation?(operationId: string): Promise<OperationReceipt>;
  recoverDelivery?(deliveryId: string, request: DeliveryRecoveryRequest): Promise<DeliveryRecoveryResult>;
  /** 실행기를 지금 다시 본다. 입력을 받기 전에 부른다. */
  refreshConnection?(): Promise<void>;
  startConductor(projectId: string): Promise<Member>;
  /** http.ts 가 프로젝트·대상·첨부·멱등(같은 id 재전송)을 먼저 걸러 준다. */
  sendUserMessage(projectId: string, req: SendMessageReq): Promise<Message>;
  /** http.ts 가 같은 답 재전송(그대로 반환)·다른 답(409)을 먼저 걸러 준다. store.answerDecision 으로 기록한다. */
  answerDecision(decisionId: string, req: AnswerReq): Promise<Decision>;
  /** 끝내 실패한 대표 글을 같은 id 로 다시 넣는다. */
  resendMessage?(existing: Message): Promise<Message>;
  /** 값이 실제로 바뀔 때만 불린다. */
  setTodoDone(todoId: string, done: boolean): Promise<Todo>;
  /** AI 가 닫은 결재(closeKind 있음)를 대표가 다시 연다. 아니면 409. */
  reopenDecision?(decisionId: string): Promise<Decision>;
  /** '지금 판 정리'. 총괄에게 판 정리 지시를 넣는다(없거나 잠들었으면 띄운다). http 가 연결을 먼저 본다. */
  tidyBoard?(projectId: string): Promise<TidyResult>;
  /** force: 대표가 화면에서 '그래도 재우기'를 눌렀을 때만. */
  memberSleep(memberId: string, opts?: { force?: boolean }): Promise<Member | void>;
  memberResume(memberId: string): Promise<Member | void>;
  memberCompact(memberId: string): Promise<Member | void>;
  memberInterrupt(memberId: string): Promise<Member | void>;
  /** 직접 띄운 세션을 명부에서 뺀다. */
  memberClose?(memberId: string): Promise<void>;
  /** 직접 띄운 CLI 의 도구 호출로 상태를 고친다. */
  noteManualCall?(member: Member, tool: string): void;
  /** herdr 칸 화면. 없으면 빈 글. */
  memberScreen(memberId: string): Promise<string>;
  /** 칸이 권한 승인 창 앞이면 그 창. 아니면 null. */
  memberApproval?(memberId: string): Promise<ApprovalPrompt | null>;
  /** 대표가 승인 창의 선택지를 고른다. 창이 바뀌었거나 닫혔으면 409. AI 도구에는 없다. */
  answerApproval?(memberId: string, req: AnswerApprovalReq): Promise<void>;
  herdrInfo(): Promise<HerdrInfo>;
  herdrAgents(): Promise<LiveAgent[]>;
  adopt(projectId: string, req: AdoptReq): Promise<Member>;
  adoptPreview?(projectId: string, paneId: string): Promise<AdoptPreview>;
  /** 편입 해제: 대화·세션은 그대로 두고 관리에서 뺀다. */
  releaseMember?(memberId: string): Promise<ReleaseResult>;
  /** 넘겨받은 세션을 도구를 붙여 다시 연다. */
  reopenWithTools?(memberId: string): Promise<Member>;
  /** 터미널에서 CLI 를 부르는 명령. */
  cliCommand?(): string;
  listAgentTools(member: Member): AgentToolDef[] | Promise<AgentToolDef[]>;
  /** signal: 호출한 쪽 연결이 끊기면 기다리던 도구(wait)를 그만둔다. */
  handleAgentTool(member: Member, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult>;
  handleAgentOperation?(member: Member, name: string, args: Record<string, unknown>, context: AgentOperationContext, signal?: AbortSignal): Promise<AgentToolResult>;
  manualInbox?(memberId: string, timeoutMs: number, signal?: AbortSignal): Promise<ManualInboxBatch | null>;
  acknowledgeManualInbox?(memberId: string, request: ManualInboxAckRequest): Promise<ManualInboxAckResult>;
  /** 답이 오거나 timeoutMs(최대 50초)가 지나면 돌아온다. */
  askWait(member: Member, decisionId: string, timeoutMs: number, signal?: AbortSignal): Promise<AskWaitResult>;
}
