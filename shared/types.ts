// IAMCEO 공유 계약: 서버·웹·MCP가 함께 쓰는 타입. 바꾸려면 docs/spec.md 와 같이 바꾼다.

export type Backend = "core" | "herdr" | "headless";
export type CliProvider = "claude" | "codex";
/** bypassPermissions 묻지 않음(기본) · auto 위험한 것만 멈춤 · default 전부 승인 필요(herdr 는 승인 창, headless 는 창이 없어 막히고 활동에 남는다) */
export type PermissionMode = "bypassPermissions" | "auto" | "default";
export const PERMISSION_MODES = ["bypassPermissions", "auto", "default"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number] | (typeof CODEX_EFFORTS)[number];
/** manager 부장(총괄·본사 AI) · lead 팀장(직원 세션) · staff 직원(서브에이전트) */
export type Rank = "manager" | "lead" | "staff";
/** null 이면 CLI 기본값 */
export interface RankConfig { model: string | null; effort: Effort | null }
export type Ranks = Record<Rank, RankConfig>;
export type MemberKind = "root" | "conductor" | "worker";
export type MemberOrigin = "runner" | "adopted" | "manual";
/** working 일하는 중 · waiting 내 답 기다림 · idle 대기 · blocked 승인 창 앞(herdr) · asleep 잠듦 · offline 안 보임 · error 오류 */
export type MemberStatus = "working" | "waiting" | "idle" | "blocked" | "asleep" | "offline" | "error";

/**
 * 지금 대표의 말·결정을 받을 수 있는가. ok=false 면 화면은 입력을 막고 detail 을 보여 주고, 서버도 409 로 거부한다.
 * ok: 보관 아님 && ((runnerEnabled && 전역 실행기 쓸 수 있음) || 살아 있는 직접 띄운 세션 있음)
 */
export type ConnectionReason = "runner_off" | "backend_down" | "archived";
export interface ProjectConnection { ok: boolean; reason: ConnectionReason | null; detail: string | null }

export interface Project {
  id: string; // 'hq' 는 본사
  name: string;
  isHq: boolean;
  cwd: string;
  /** false 면 메시지를 저장만 하고 어떤 세션도 띄우거나 깨우지 않는다(가져온 프로젝트 기본값). */
  runnerEnabled: boolean;
  now: string; // '지금 상황' 한 줄~짧은 글
  /** 생성 때 대표가 쓴 목표 원문. 이후 수정하지 않으며 이전 프로젝트는 null. */
  readonly creationGoal: string | null;
  nowAt: string | null;
  herdrTabId: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  connection: ProjectConnection;
  /** 마지막으로 총괄에게 판 정리를 맡긴(또는 그 턴이 끝난) 시각. 한 번도 안 했으면 null. */
  tidiedAt: string | null;
}

export interface ProjectSummary extends Pick<Project, "id" | "name" | "isHq" | "cwd" | "now" | "runnerEnabled" | "connection"> {
  decisionCount: number; // 열린 결재
  todoCount: number; // 안 한 내 할 일
  /** decisionCount + todoCount. 호환용으로 남겨 두었다. 새 화면은 위 둘을 쓴다. */
  inboxCount: number;
  workingCount: number;
  /** 승인 창 앞에서 멈춘 세션. 대표가 풀어 줘야 움직인다. */
  blockedCount: number;
  errorCount: number;
  memberCount: number;
}

export type ContextWindowSource = "statusline" | "codex" | "headless" | "screen";

/** blocked는 입력 보류다. permission만 증거로 확인된 승인 대기로 집계한다. */
export type BlockedReason = "permission" | "selection" | "setup" | "status_unknown";
export interface StatusObservation {
  source: Backend | "manual";
  observedAt: string | null;
  freshness: "fresh" | "stale" | "unknown";
  ownership: "verified" | "conflict" | "unknown";
  consecutiveFailures: number;
  error: { code: string; note: string } | null;
}
/** 미수집/추정은 기존 subagents=0과 다르며 실제 자식 lifecycle 수집을 약속하지 않는다. */
export interface SubagentState {
  quality: "exact" | "estimated" | "unknown" | "unsupported";
  count: number | null;
  observedAt: string | null;
  sessionGeneration: number;
}
export interface MemberExecutionState {
  runId: string;
  sessionGeneration: number;
  turn: number | null;
  deliveryIds: string[];
  phase: "received" | "starting" | "running" | "ended" | "interrupted" | "unknown";
  inputReceivedAt: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  endedAt: string | null;
  result: "success" | "error" | "interrupted" | null;
  /** 제한된 진단 code이며 원시 화면/프롬프트가 아니다. */
  reason: string | null;
  exitCode: number | null;
}
export interface MemberLifecycleState {
  operationId: string;
  sessionGeneration: number;
  /** journal의 confirmed만 확정 상태다. 기존 status는 종료/시작의 증거가 아니다. */
  phase: "starting" | "starting_unknown" | "stopping" | "stopping_unknown" | "closing" | "started_confirmed" | "stopped_confirmed" | "refused" | "reconnecting" | "quarantined";
  intent?: "start" | "sleep" | "close" | "archive" | "fresh_session";
  reason: string | null;
  exitCode?: number | null;
  updatedAt: string;
}
export interface ContextMeasurement {
  sessionId: string;
  sessionGeneration: number;
  turn: number | null;
  model: string | null;
  tokens: number | null;
  window: number | null;
  source: ContextWindowSource | "stored" | "model" | "default";
  quality: "exact" | "estimated";
  measuredAt: string;
  /** 같은 세션/세대/모델/완료 턴의 표본. 단순 경과시간으로 결정하지 않는다. */
  fresh: boolean;
}
export interface ContextCompaction {
  id: string;
  trigger: "auto" | "manual";
  phase: "queued" | "sending" | "running" | "succeeded" | "failed" | "uncertain";
  reason: "working" | "manual_control" | "draft" | "blocked" | "backend_down" | "measurement_pending" | "send_uncertain" | "completion_timeout" | "provider_error" | "interrupted" | "session_changed" | "user_resolved" | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface CoreContextState {
  measurement: ContextMeasurement | null;
  compaction: ContextCompaction | null;
}

export interface Member {
  id: string;
  projectId: string;
  handle: string; // [a-z][a-z0-9_-]{0,31}, 프로젝트 안에서 유일
  name: string; // 화면 이름(한국어)
  role: string;
  kind: MemberKind;
  origin: MemberOrigin;
  /** 편입으로 들어온 세션. 다시 열어 origin 이 runner 가 되어도 남는다. 편입 해제의 근거다. */
  wasAdopted: boolean;
  cli: CliProvider;
  /** 이 직원의 세션을 다루는 실행기. 띄울 때 기억한다. 세션이 없으면 null(다음에 띄울 때 전역 설정을 따른다). */
  backend: Backend | null;
  /** null 이면 직급 기본(Settings.ranks) */
  modelOverride: string | null;
  effortOverride: Effort | null;
  /** 지금 세션에 실제로 들어간 값. null 은 CLI 기본이거나 모름(넘겨받은 세션). */
  appliedModel: string | null;
  appliedEffort: Effort | null;
  status: MemberStatus;
  now: string;
  next: string;
  cwd: string;
  sessionId: string | null; // CLI 세션 UUID
  paneId: string | null; // herdr pane
  contextPct: number | null;
  /** 이 세션에서 실측하거나 상태줄로 추정한 문맥 창 크기(토큰). 모르면 null. 세션·CLI·모델이 바뀌면 지운다. */
  contextWindow: number | null;
  contextWindowSource: ContextWindowSource | null;
  subagents: number; // 지금 돌고 있는 서브에이전트 수
  parallel: boolean; // ultracode 켬
  queuedCount: number; // 전달 대기 중 입력 수
  lastError: string | null;
  updatedAt: string;
  createdAt: string;
  /** 추가 메타데이터의 누락은 구형/미지원이다. 기존 status/문맥 창 필드는 유지한다. */
  statusObservation?: StatusObservation | null;
  blockedReason?: BlockedReason | null;
  subagentState?: SubagentState | null;
  /** now는 마지막 자기 보고이며 일반 updatedAt과 별도로 기록한다. next 생략 시 보존한다. */
  nowAt?: string | null;
  manualActivityAt?: string | null;
  executionState?: MemberExecutionState | null;
  lifecycleState?: MemberLifecycleState | null;
  contextState?: CoreContextState | null;
}

export interface DecisionOption { k: string; label: string; desc?: string }
export type DecisionStatus = "open" | "answered" | "delivered" | "closed";
export interface Decision {
  id: string;
  projectId: string;
  memberId: string | null; // 물은 직원
  who: string; // 화면 이름
  title: string;
  detail: string; // 마크다운. 카드만 읽고 고를 수 있어야 한다
  options: DecisionOption[]; // 비어 있으면 자유 답
  rec: string | null;
  group: string | null;
  fileId: string | null;
  images: Attachment[];
  status: DecisionStatus;
  choice: string | null;
  note: string | null;
  batch: boolean;
  createdAt: string;
  answeredAt: string | null;
  deliveredAt: string | null;
  /** 상태가 바뀔 때마다 는다. 되돌아간 상태(다시 열림)와 늦게 온 응답을 가른다. */
  updatedAt: string;
  /** 전달되지 못하고 다시 열린 카드의 직전 답. 대표가 다시 쓰지 않아도 되게 카드로 돌려준다. 새 답이 오면 지운다. */
  lastChoice: string | null;
  lastNote: string | null;
  /** 왜 다시 열렸는지. 카드에 그대로 보인다. */
  reopenNote: string | null;
  /** AI 가 ask_close 로 닫았을 때만 있다. 대표는 이 카드를 다시 열 수 있다. 직원이 명부에서 빠져 함께 닫힌 카드는 null. */
  closeKind: DecisionCloseKind | null;
  /** 닫힌 이유(한 줄). 결재된 항목에 '닫힘 · 이유'로 보인다. */
  closeReason: string | null;
  /** decided 로 닫을 때 서버가 대표 글과 맞춰 본 인용. */
  closeQuote: string | null;
  /** 닫은 이(화면 이름) 또는 '시스템'. */
  closedBy: string | null;
  closedAt: string | null;
}
/** decided 대표가 대화 등으로 이미 정함(서버가 대표 글로 확인) · obsolete 상황이 바뀌어 필요 없어짐 */
export type DecisionCloseKind = "decided" | "obsolete";

/** done 끝남 · dropped 필요 없어짐(홈에서 빠진다). 둘 다 done=true 다. */
export type TodoOutcome = "done" | "dropped";
export interface Todo {
  id: string;
  projectId: string;
  memberId: string | null;
  who: string; // 요청한 직원 이름
  title: string;
  detail: string;
  done: boolean;
  doneAt: string | null;
  createdAt: string;
  /** 안 끝났으면 null. 대표가 체크하면 done. */
  outcome: TodoOutcome | null;
  /** AI 가 todo_close 로 정리했을 때의 이유와 정리한 이. 대표가 체크했으면 null. */
  closeReason: string | null;
  closedBy: string | null;
}

/** 팀 화면 아래: 진행 중 · 예정(AI가 곧 할 일) · 보류 · 완료 */
export type WorkSec = "doing" | "next" | "hold" | "done";
export interface WorkItem {
  id: string;
  projectId: string;
  sec: WorkSec;
  title: string;
  detail: string;
  who: string;
  order: number;
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageKind = "완료" | "진행" | "질문" | "막힘" | "알림" | "답변" | "지시" | "직접" | "나" | "시스템";
export interface Attachment { id: string; name: string; mime: string; size: number; url: string; path: string; isImage: boolean }
export interface Message {
  id: string;
  projectId: string;
  at: string;
  mine: boolean; // 대표가 쓴 말
  memberId: string | null;
  who: string;
  kind: MessageKind;
  title: string;
  body: string; // 마크다운
  targetMemberId: string | null; // @직원 지정
  targetName: string | null;
  decisionId: string | null;
  fileId: string | null;
  attachments: Attachment[];
  /** 대표 말의 전달 상태: sent 보냄 · queued 대기 · held 보류(사유) · delivered 받음 · failed 실패 */
  delivery: DeliveryStatus | null;
  deliveryNote: string | null;
}

export type MessageScope = { kind: "project" } | { kind: "member"; memberId: string };
export interface MessagePageOptions { scope?: MessageScope; cursor?: string; limit?: number }
/** items는(at BINARY,id BINARY) 오름차순. cursor는 불투명하며 hasOlder=false이면 null. */
export interface MessagePage {
  projectId: string;
  scope: MessageScope;
  items: Message[];
  nextCursor: string | null;
  hasOlder: boolean;
}

/** 자료의 모양. artifact 는 GET /api/files/:id/artifact 의 html 을 격리 칸에 그린다. table·code 는 body 에 원문이 있다(1MB 이하). */
export type FileKind = "document" | "artifact" | "image" | "pdf" | "table" | "code" | "video" | "audio" | "file";
export interface FileDoc {
  id: string;
  kind: FileKind;
  projectId: string;
  title: string;
  who: string;
  memberId: string | null;
  summary: string;
  body: string; // 마크다운 전문(없을 수 있음)
  path: string | null; // 원본 위치
  attachments: Attachment[];
  createdAt: string;
  order: number;
}

export type DeliveryKind = "user_message" | "answer" | "todo_done" | "instruction" | "report" | "system" | "compact";
export type DeliveryStatus = "queued" | "held" | "delivering" | "delivered" | "failed";
export interface Delivery {
  id: string;
  projectId: string;
  memberId: string;
  kind: DeliveryKind;
  text: string; // 서버가 접두어까지 붙인 최종 글
  wake: boolean; // false 면 다음 깨움에 묶어서만 전달
  urgent: boolean; // 일하는 중에도 넣기(herdr)
  status: DeliveryStatus;
  holdReason: string | null; // blocked · input_busy · asleep · offline · backend_down · runner_disabled · archived
  refType: "message" | "decision" | "todo" | null;
  refId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  /** 실제 재시도 큐의 예약 시각. 미지원/예약 없음은 누락 또는 null. */
  nextAttemptAt?: string | null;
}

export type EvidenceVerdict = "present" | "absent" | "unknown";
/** 공개 증거 요약. 원시 화면/프롬프트/로그 경로/lease ID는 포함하지 않는다. */
export interface DeliveryEvidence {
  source: "claude_log" | "codex_log" | "core_screen" | "herdr_screen" | "transport";
  verdict: EvidenceVerdict;
  location: "received_input" | "composer" | "history" | "none";
  code: string;
  complete: boolean;
  checkedAt: string;
}
export type DeliveryFinding = "received" | "not_received" | "draft_only" | "wait" | "unknown";
export type DeliveryRecoveryPhase = "none" | "checking" | "waiting" | "retry_wait" | "needs_owner" | "resolved" | "stopped";
export type DeliveryRecoveryAction = "recheck" | "retry_with_risk" | "stop_retry";
export interface MemberDeliverySummary {
  memberId: string;
  /** undelivered/unknown/delivering은 배타적. 나머지는 보조 집합이므로 더하지 않는다. */
  undeliveredCount: number;
  unknownCount: number;
  deliveringCount: number;
  checkingCount: number;
  needsOwnerCount: number;
  waitingBehindCount: number;
  oldestAt: string | null;
  reasons: { code: string; count: number; note: string }[];
}
export interface DeliveryNotices {
  version: 2;
  /** state.members와 같은 순서, 0건도 포함. 최근 메시지가 아닌 전체 DB 집계. */
  members: MemberDeliverySummary[];
  unassigned: { undeliveredCount: number; unknownCount: number; needsOwnerCount: number };
}
export interface DeliveryNoticeItem {
  id: string;
  deliveryId: string | null;
  messageId: string | null;
  memberId: string;
  projectId: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  phase: Exclude<DeliveryRecoveryPhase, "resolved" | "stopped">;
  holdReason: string | null;
  reason: string | null;
  note: string;
  /** 실제 recovery는 양의 안전 정수, 가상 message:<id> 항목은 0. */
  version: number;
  createdAt: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  autoAttempts: number;
  evidence: DeliveryEvidence[];
  recommendation: { code: string; text: string } | null;
  allowedActions: DeliveryRecoveryAction[];
  ref: { type: "message" | "decision" | "todo"; id: string } | null;
  preview: string;
}
export interface DeliveryNoticePage {
  memberId: string;
  summary: MemberDeliverySummary;
  items: DeliveryNoticeItem[];
  nextBefore: string | null;
}
export interface DeliveryNoticePageOptions { limit?: number; before?: string }
/** retry만 중복 위험 동의를 요구한다. 나머지 action에는 해당 키를 보내지 않는다. */
export type DeliveryRecoveryRequest = { operationId: string; expectedVersion: number } & (
  | { action: "retry_with_risk"; acceptDuplicateRisk: true }
  | { action: "recheck" | "stop_retry"; acceptDuplicateRisk?: never }
);
export interface DeliveryRecoveryResult {
  operationId: string;
  deliveryId: string;
  outcome: "check_scheduled" | "retry_scheduled" | "stopped";
  committedVersion: number;
}

export type ActivityKind = "text" | "tool" | "tool_result" | "turn_start" | "turn_end" | "compact" | "error" | "system";
export interface Activity { id: number; memberId: string; at: string; kind: ActivityKind; text: string }

/**
 * 실행기가 확인한 CLI 승인·설정 창. 선택지는 화면 원문 순서 그대로다.
 * fingerprint 는 창 근거의 해시다(herdr: 추출 내용, core 폴더 신뢰: 경로·선택 위치를 포함한 평문 화면).
 * 누를 때 다시 읽어 같을 때만 누른다. 설정 창에는 앱의 사실 설명을 붙일 수 있다.
 */
export interface ApprovalOption { n: number; label: string; /** 거절(No) 선택지 */ reject: boolean }
export interface ApprovalPrompt {
  /** 예: "Bash command", "Create file". 창 윗부분이 화면 밖이면 빈 글 */
  title: string;
  /** 설명·명령·미리보기. 줄바꿈 포함 */
  body: string;
  /** 예: "Do you want to proceed?" */
  question: string;
  options: ApprovalOption[];
  fingerprint: string;
}
export interface AnswerApprovalReq { fingerprint: string; option: number; /** 거절할 때 직원에게 전할 말 */ note?: string }

/** 전체 설정 하나가 전부다. 프로젝트마다 따로 두지 않는다. */
export interface Settings {
  /** null 이면 아직 첫 실행 선택 전 */
  backend: Backend | null;
  permissionMode: PermissionMode;
  ranks: Ranks;
  codexRanks: Ranks;
  maxConcurrentTurns: number;
  compactAtPct: number; // 기본 70
  /**
   * 문맥 창 크기(토큰)를 모를 때 쓰는 값. 기본 1000000. 상태줄이 잘려 % 가 안 보이고 아직 그 직원의 창 크기를 배우지 못했을 때
   * 토큰 수를 이것으로 나눠 문맥 %(와 자동 압축)를 정한다. 실측값·저장값·상태줄 추정·모델별 표가 이보다 먼저다.
   */
  contextWindowDefault: number;
  /** 모델 id → 문맥 창 크기(토큰). 기본 표와 병합하며 세션 실측값이 항상 우선한다. */
  contextWindows: Record<string, number>;
  maxAwakeWorkers: number; // 기본 8
  /** 결재·할 일이 올라오면 서버 컴퓨터(맥)에 알림을 띄운다. */
  notifyMac: boolean;
  /** 총괄에게 판 정리(결재·내 할 일·진행판·지금 상황)를 맡기는 간격(시간). 0 이면 끈다. 기본 6. */
  boardTidyHours: number;
}

export interface RuntimeInfo { backend: "core"; core: { installed: boolean; available: boolean; version: string | null; detail: string | null }; providers: Record<CliProvider, { installed: boolean }> }

export interface HerdrInfo { installed: boolean; running: boolean; version: string | null; protocol: number | null; compatible: boolean; warning: string | null }
export interface LiveAgent { paneId: string; name: string | null; agent: string | null; status: string; cwd: string | null; sessionId: string | null; workspaceId: string | null; tabId: string | null; adopted: boolean }

export interface Bootstrap {
  version: string;
  runtime?: RuntimeInfo;
  settings: Settings;
  projects: ProjectSummary[];
  herdr: HerdrInfo;
  home: string;
  /** 서버가 실제로 듣고 있는 주소들. 다른 기기에서 들어올 주소를 안내한다. */
  urls: string[];
  /** 서버 컴퓨터의 터미널에서 이 CLI 를 부르는 명령. 설치돼 있으면 iamceo, 아니면 실행 파일 전체 경로. */
  cli: string;
  /** 직급 값 대신 자기 값을 쓰는 직원 수. 직급 값을 바꿔도 이들에게는 먹지 않는다. */
  rankOverrides: Record<Exclude<Rank, "staff">, number>;
}

export interface ProjectState {
  project: Project;
  members: Member[];
  decisions: Decision[]; // 열린 것 + 최근 처리 50. 더 오래된 처리 건은 GET /api/projects/:id/decisions?status=done&before=&limit=
  doneDecisionCount: number; // 처리된 결재 전체 수
  todos: Todo[];
  work: WorkItem[];
  messages: Message[]; // 최근 200, 오래된 → 최신
  files: FileDoc[];
  deliveryNotices?: DeliveryNotices;
}

/** 보관함 GET 전용 DTO. 늦은 manual 기록이 가능하므로 불변 DB snapshot은 아니다. */
export interface ArchiveProjectState extends ProjectState { project: Project & { archived: true } }
/** 일반 page와 같은 strict query 4개/정렬. 없는/활성 프로젝트는 404. */
export type ArchiveMessagePage = MessagePage;

export interface SyncCursor { epoch: string; seq: number }
export interface SyncSnapshot {
  protocol: 2;
  cursor: SyncCursor;
  requestedProjectId: string | null;
  projectStatus: "none" | "ok" | "not_found" | "archived";
  bootstrap: Omit<Bootstrap, "runtime">;
  state: ProjectState | null;
  /** state/cursor와 같은 동기 읽기 경계. 선택 프로젝트가 없으면 members/todos는 빈 map. */
  revisions: import("./operations.ts").SyncRevisions;
}

/** WebSocket 서버→화면. 화면은 받으면 해당 조각만 고치거나 state 를 다시 받는다. */
export type WsEvent =
  | { type: "hello"; seq: number }
  /** 소켓이 살아 있다는 신호. 화면은 한동안 아무것도 안 오면 소켓을 새로 잇는다. */
  | { type: "ping" }
  | { type: "projects"; projects: ProjectSummary[] }
  | { type: "project"; project: Project }
  | { type: "member"; member: Member }
  | { type: "member_removed"; projectId: string; memberId: string }
  | { type: "decision"; decision: Decision }
  | { type: "todo"; todo: Todo }
  | { type: "work"; projectId: string; work: WorkItem[] }
  | { type: "message"; message: Message }
  | { type: "file"; file: FileDoc }
  | { type: "activity"; projectId: string; activity: Activity }
  | { type: "settings"; settings: Settings }
  | { type: "herdr"; herdr: HerdrInfo };

export type WsChangeEvent = Exclude<WsEvent, { type: "hello" } | { type: "ping" }>;
/** 별도 v2 wire. 기존 WsEvent를 수정하거나 v1 객체에 cursor를 덧붙이지 않는다. */
export type RealtimeEvent =
  | ({ type: "hello"; protocol: 2; heartbeatMs: 15000; staleAfterMs: 45000 } & SyncCursor)
  | ({ type: "ping" } & SyncCursor)
  | (WsChangeEvent & SyncCursor);

// ---- REST 요청 ----
export interface CreateProjectReq { name: string; cwd: string; goal?: string; startConductor?: boolean; chiefCli?: CliProvider }
export interface CreateMemberReq { name: string; role?: string; cli?: CliProvider; modelOverride?: string | null }
export interface PatchProjectReq { name?: string; cwd?: string; runnerEnabled?: boolean; now?: string; archived?: boolean }
/** PUT /api/settings. ranks·codexRanks 는 고친 칸만 보내도 된다(나머지 유지). */
export type SettingsPatch = Partial<Omit<Settings, "ranks" | "codexRanks">> & {
  ranks?: Partial<Record<Rank, Partial<RankConfig>>>;
  codexRanks?: Partial<Record<Rank, Partial<RankConfig>>>;
};
/** PATCH /api/members/:id. null 이면 직급 기본으로 돌아간다. */
export interface PatchMemberReq { cli?: CliProvider; modelOverride?: string | null; effortOverride?: Effort | null }
export interface SendMessageReq { id?: string; text: string; targetMemberId?: string | null; attachmentIds?: string[] }
export interface AnswerReq { expectedVersion?: string; choice?: string | null; note?: string | null; batch?: boolean }
export interface AdoptReq { paneId: string; name: string; role: string; handle?: string; kind?: "conductor" | "worker" }
/** conductor 다른 지휘자의 흔적 · folder 프로젝트 밖 폴더 · input 입력칸에 쓰던 글(넘겨받을 때 지운다). 편입을 막지는 않는다. */
export interface AdoptWarning { kind: "conductor" | "folder" | "input"; text: string }
/** GET /api/projects/:id/adopt/preview?pane=. 읽기만 한다. */
export interface AdoptPreview { paneId: string; name: string | null; cwd: string | null; status: string; sessionId: string | null; screen: string; refuse: string | null; warnings: AdoptWarning[] }
/** POST /api/projects/:id/tidy. already: 이미 판 정리 지시가 기다리거나 도는 중이라 새로 넣지 않았다. */
export interface TidyResult { already: boolean }
/** POST /api/members/:id/release. notified: 세션에 규칙이 풀렸다고 알렸다. paneKept: 칸은 그대로 있다. false 면 서버 칸을 닫았고 resumeCommand 로 이어 연다. */
export interface ReleaseResult { notified: boolean; paneKept: boolean; resumeCommand: string | null }

/** 지금 넘겨받을 수 없는 이유. null 이면 받을 수 있다(서버·화면 공통). */
export function adoptRefusal(a: Pick<LiveAgent, "agent" | "status" | "sessionId" | "adopted">): string | null {
  if (a.adopted) return "이미 직원 자리인 세션입니다";
  if (a.agent !== "claude") return `Claude 세션만 편입할 수 있습니다: ${a.agent ?? "알 수 없음"}`;
  if (a.status === "working") return "일하는 중입니다. 지금 턴이 끝나면 다시 시도하세요";
  if (a.status === "blocked") return "승인 창 앞에서 멈춰 있습니다. 터미널에서 푼 뒤 다시 시도하세요";
  if (a.status !== "idle" && a.status !== "done") return "아직 뜨는 중이거나 상태를 알 수 없습니다. 잠시 뒤 다시 시도하세요";
  // 세션 ID 를 모르면 턴 마지막 글을 읽을 수 없어 보고가 끊기고, 재시작 뒤 어느 칸인지도 가릴 수 없다.
  if (!a.sessionId) return "세션 ID 를 알 수 없어 받을 수 없습니다(herdr 의 Claude 연동을 확인하세요)";
  return null;
}

// ---- 직급 ----
export const DEFAULT_RANKS: Ranks = { manager: { model: null, effort: null }, lead: { model: null, effort: null }, staff: { model: null, effort: null } };
export const DEFAULT_CODEX_RANKS: Ranks = { manager: { model: null, effort: null }, lead: { model: null, effort: null }, staff: { model: null, effort: null } };

/** 세션의 직급. 총괄·본사 AI 는 부장, 직원 세션은 팀장. 서브에이전트(직원)는 세션이 없다. */
export function memberRank(kind: MemberKind): Exclude<Rank, "staff"> {
  return kind === "worker" ? "lead" : "manager";
}

/** 이 직원이 써야 할 값. 직원별 지정이 직급 기본을 이긴다. */
export function memberConfig(m: Pick<Member, "kind" | "modelOverride" | "effortOverride"> & Partial<Pick<Member, "cli">>, ranks: Ranks, codexRanks: Ranks = DEFAULT_CODEX_RANKS): RankConfig {
  const rank = (m.cli === "codex" ? codexRanks : ranks)[memberRank(m.kind)];
  return { model: m.modelOverride ?? rank.model, effort: m.effortOverride ?? rank.effort };
}

/** 이름과 형식으로 자료의 모양을 정한다(서버·화면 공통). */
const TABLE_EXT = new Set(["csv", "tsv"]);
const CODE_EXT = new Set(["json", "jsonl", "ndjson", "txt", "log", "yaml", "yml", "toml", "xml", "ini", "conf", "sh", "bash", "zsh", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sql", "css", "scss", "diff", "patch"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif", "tif", "tiff"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "m4v", "mkv", "avi"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"]);

export function fileKindOf(name: string, mime = ""): FileKind {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "document";
  if (ext === "html" || ext === "htm") return "artifact";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (TABLE_EXT.has(ext)) return "table";
  if (CODE_EXT.has(ext)) return "code";
  if (IMAGE_EXT.has(ext) || mime.startsWith("image/")) return "image";
  if (VIDEO_EXT.has(ext) || mime.startsWith("video/")) return "video";
  if (AUDIO_EXT.has(ext) || mime.startsWith("audio/")) return "audio";
  if (mime === "text/html") return "artifact";
  if (mime === "text/csv" || mime === "text/tab-separated-values") return "table";
  if (mime.startsWith("text/") || mime === "application/json") return "code";
  return "file";
}

// ---- 에이전트 도구 이름 ----
/** ask_close·todo_close: 직원은 자기가 올린 결재·할 일만, 총괄·본사 AI 는 프로젝트 전체를 정리한다. */
export const WORKER_TOOLS = ["status", "ask", "post", "file", "todo", "ask_close", "todo_close"] as const;
export const CONDUCTOR_TOOLS = ["team_add", "team_assign", "team_compact", "team_sleep", "team_resume", "team_close", "roster", "project_now", "work_set", "work_list", "work_remove", "board"] as const;
export const ROOT_TOOLS = ["project_create", "project_list", "board"] as const;
export const MANUAL_TOOLS = ["wait"] as const;
