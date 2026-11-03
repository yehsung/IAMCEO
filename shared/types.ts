// IAMCEO 공유 계약: 서버·웹·MCP가 함께 쓰는 타입. 바꾸려면 docs/spec.md 와 같이 바꾼다.

export type Backend = "herdr" | "headless";
/** bypassPermissions 묻지 않음(기본) · auto 위험한 것만 멈춤 · default 전부 승인 필요(herdr 는 승인 창, headless 는 창이 없어 막히고 활동에 남는다) */
export type PermissionMode = "bypassPermissions" | "auto" | "default";
export const PERMISSION_MODES = ["bypassPermissions", "auto", "default"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
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
  cli: "claude";
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
  subagents: number; // 지금 돌고 있는 서브에이전트 수
  parallel: boolean; // ultracode 켬
  queuedCount: number; // 전달 대기 중 입력 수
  lastError: string | null;
  updatedAt: string;
  createdAt: string;
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
}

export type ActivityKind = "text" | "tool" | "tool_result" | "turn_start" | "turn_end" | "compact" | "error" | "system";
export interface Activity { id: number; memberId: string; at: string; kind: ActivityKind; text: string }

/**
 * herdr 칸에 뜬 Claude Code 권한 승인 창. 화면에서 읽은 글 그대로다(번역하지 않는다).
 * fingerprint 는 창 내용(제목·본문·질문·선택지)의 해시다. 누를 때 다시 읽어 같을 때만 누른다.
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
  maxConcurrentTurns: number;
  compactAtPct: number; // 기본 70
  maxAwakeWorkers: number; // 기본 8
  /** 결재·할 일이 올라오면 서버 컴퓨터(맥)에 알림을 띄운다. */
  notifyMac: boolean;
  /** 총괄에게 판 정리(결재·내 할 일·진행판·지금 상황)를 맡기는 간격(시간). 0 이면 끈다. 기본 6. */
  boardTidyHours: number;
}

export interface HerdrInfo { installed: boolean; running: boolean; version: string | null; protocol: number | null; compatible: boolean; warning: string | null }
export interface LiveAgent { paneId: string; name: string | null; agent: string | null; status: string; cwd: string | null; sessionId: string | null; workspaceId: string | null; tabId: string | null; adopted: boolean }

export interface Bootstrap {
  version: string;
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

// ---- REST 요청 ----
export interface CreateProjectReq { name: string; cwd: string; goal?: string; startConductor?: boolean }
export interface PatchProjectReq { name?: string; cwd?: string; runnerEnabled?: boolean; now?: string; archived?: boolean }
/** PUT /api/settings. ranks 는 고친 칸만 보내도 된다(나머지 유지). */
export type SettingsPatch = Partial<Omit<Settings, "ranks">> & { ranks?: Partial<Record<Rank, Partial<RankConfig>>> };
/** PATCH /api/members/:id. null 이면 직급 기본으로 돌아간다. */
export interface PatchMemberReq { modelOverride?: string | null; effortOverride?: Effort | null }
export interface SendMessageReq { id?: string; text: string; targetMemberId?: string | null; attachmentIds?: string[] }
export interface AnswerReq { choice?: string | null; note?: string | null; batch?: boolean }
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

/** 세션의 직급. 총괄·본사 AI 는 부장, 직원 세션은 팀장. 서브에이전트(직원)는 세션이 없다. */
export function memberRank(kind: MemberKind): Exclude<Rank, "staff"> {
  return kind === "worker" ? "lead" : "manager";
}

/** 이 직원이 써야 할 값. 직원별 지정이 직급 기본을 이긴다. */
export function memberConfig(m: Pick<Member, "kind" | "modelOverride" | "effortOverride">, ranks: Ranks): RankConfig {
  const rank = ranks[memberRank(m.kind)];
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
