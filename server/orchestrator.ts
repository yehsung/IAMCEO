// Orchestrator: 전달 펌프, 턴 종료 처리, 압축 판단, 띄우기·잠재우기·다시 열기, 승인 근거 확인(spec §4·§6·§7).
//
// server/agent-tools.ts 가 쓰는 공개 메서드:
//   팀       addMember · assign · compactMember · sleepMember · resumeMember · closeMember · roster
//   보고     recordPost · registerAsk · setMemberStatus · setProjectNow · setWork
//   직접 CLI waitInbox · askWait
//   프로젝트 createProject · ensureConductor
//   그 밖의 읽기·쓰기(file·todo·project_list)는 orch.store 를 그대로 쓴다.
// agent-tools.ts 는 다음 두 함수를 내보낸다(AgentToolsImpl).
//   listAgentTools(member): AgentToolDef[]
//   handleAgentTool(orch, member, name, args): Promise<AgentToolResult>
//
// 조립 순서: createOrchestrator(config, store) → startServer(ctx) → setServerUrl(url) → recover() · 끝낼 때 shutdown().
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  AdoptPreview,
  AdoptReq,
  AnswerApprovalReq,
  ApprovalPrompt,
  AdoptWarning,
  AnswerReq,
  Attachment,
  Backend,
  CreateProjectReq,
  Decision,
  DecisionCloseKind,
  DecisionOption,
  Delivery,
  Effort,
  HerdrInfo,
  LiveAgent,
  Member,
  MemberKind,
  Message,
  MessageKind,
  PatchProjectReq,
  Project,
  PatchMemberReq,
  ReleaseResult,
  SendMessageReq,
  Settings,
  SettingsPatch,
  TidyResult,
  Todo,
  TodoOutcome,
  WorkItem,
  WorkSec,
} from "../shared/types.ts";
import { adoptRefusal, memberConfig } from "../shared/types.ts";
import type { Config } from "./config.ts";
import type { AgentToolDef, AgentToolResult, AskWaitResult, OrchestratorApi } from "./orchestrator-api.ts";
import { sanitizeName } from "./files.ts";
import { josa, renderRole } from "./roles.ts";
import { HeadlessRunner, isMissingSessionError } from "./runner/headless.ts";
import { HerdrError } from "./runner/herdr-client.ts";
import { detectHerdr, HerdrRunner, inspectPane, listAgents, type PaneInspection } from "./runner/herdr.ts";
import { approvalSummary } from "./runner/approval.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "./runner/types.ts";
import { ApiError, type AppliedConfig, type NewDelivery, type Store } from "./store.ts";
import { cleanText, RESERVED_HANDLES } from "./text.ts";
import { conductorHandle, conductorName } from "./text.ts";

// ---- 전달 글(§4). 서버만 만든다 ----
const SHORT_QUOTE = 4;
const QUOTE_SCAN_PAGES = 10;

export function normalizeSpace(text: string): string {
  return cleanText(text).replace(/\s+/g, " ").trim();
}

// 묶음 전달에서 글 안의 한 줄이 출처 접두어처럼 보이면 위조가 된다. 그런 줄의 맨 앞을 막는다.
// 목록·강조·표 기호를 씌우거나 다른 괄호로 바꿔도 같은 줄로 본다. 전각 괄호·호환 글자는 정규화해서 보고, 글자 사이 공백도 뺀다.
const LINE_NOISE = /^[\s\-*+#|`~_=:.,·•◦‣▪■□▶▷►●○※"'“”‘’«»]*(?:\d+[.)]\s*)?[\s*_`"'“”‘’]*/;
const OPENING = /^[\s*_`"'“”‘’\[({<【〔〖〘〚⟦「『〈《❲❴｟⟨⟪]+/;
const WITH_BRACKET = /^(?:대표|代表|총괄|보고|시스템)/;
const BARE_PREFIX = /^(?:대표(?:직접|답|글전문)|代表|사용자요청\(|총괄인용\(|(?:대표|총괄|보고|시스템):)/;

function looksForged(line: string): boolean {
  const head = line.normalize("NFKC").replace(LINE_NOISE, "");
  const opened = OPENING.exec(head);
  const rest = (opened ? head.slice(opened[0].length) : head).replace(/\s+/g, "");
  if (opened && /[\[({<【〔〖〘〚⟦「『〈《❲❴｟⟨⟪]/.test(opened[0]) && WITH_BRACKET.test(rest)) return true;
  return BARE_PREFIX.test(rest);
}

/** CR·U+2028 같은 숨은 줄바꿈과 제로폭 글자를 먼저 없앤 뒤 줄 머리를 본다. */
export function guardLines(text: string): string {
  return cleanText(text)
    .split("\n")
    .map((line) => (!line.trimStart().startsWith(">") && looksForged(line) ? `> ${line}` : line))
    .join("\n");
}

/** 직원·총괄이 쓴 여러 줄 글은 목록으로 막는 대신 줄마다 인용 표시를 붙인다. 어떤 모양을 지어내도 접두어 없는 입력으로 보이지 않는다. */
function quoteBlock(text: string): string {
  return cleanText(text)
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/** 직원이 쓴 값(카드 제목·버튼 글·설명·할 일 제목)을 따옴표 안에 넣는다. 따옴표를 닫아 대표 답을 지어내지 못하게 한다. */
function quotedInline(text: string): string {
  return normalizeSpace(text).replace(/[\\'"]/g, "\\$&");
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 경로와 형식은 바깥에서 온 값이 섞인다. 한 줄이어야 줄을 끊어 접두어를 지어내지 못한다. */
function attachmentLines(attachments: Attachment[]): string[] {
  return attachments.map((a) => `첨부: ${normalizeSpace(a.path)} (${normalizeSpace(a.mime)}, ${humanSize(a.size)})`);
}

export function formatUserMessage(text: string, attachments: Attachment[], id: string, direct: boolean): string {
  const lines = [`[대표${direct ? " 직접" : ""}] "${guardLines(text)}"`];
  lines.push(...attachmentLines(attachments));
  lines.push(`#${id}`);
  return lines.join("\n");
}

export function formatAnswer(d: Decision): string {
  const option: DecisionOption | undefined = d.options.find((o) => o.k === d.choice);
  const head = `[대표 답(원문) '${quotedInline(d.title)}']`;
  const note = d.note ? guardLines(d.note) : null;
  const parts = [head];
  if (option) {
    parts.push(`"${quotedInline(option.label)}"${option.desc ? `(${quotedInline(option.desc)})` : ""}`);
    if (note) parts.push(`메모 "${note}"`);
  } else if (note) {
    parts.push(`"${note}"`);
  }
  if (d.batch) parts.push("(묶음 추천대로)");
  parts.push(`#${d.id}`);
  return parts.join(" ");
}

export function formatTodoDone(t: Todo): string {
  return `[대표] '${quotedInline(t.title)}' 했음 #${t.id}`;
}

export function formatTodoUndone(t: Todo): string {
  return `[대표] '${quotedInline(t.title)}' 아직 안 했음(체크를 풀었습니다) #${t.id}`;
}

export interface QuoteSource {
  id: string;
  text: string;
  /** 대표가 쓰거나 고른 시각 */
  at?: string | null;
  /** 버튼 글이면 그 결재 카드의 제목. 버튼 글만으로는 무엇에 대한 답인지 알 수 없다. */
  card?: string | null;
}

export interface VerifiedQuote {
  text: string;
  verified: boolean;
  /** 맞은 대표 글. 일부 인용이면 전문을, 전체 인용이면 #id 와 시각을 함께 보내 판단 재료를 준다. */
  source?: QuoteSource | null;
}

/** '진행' 같은 버튼 글·짧은 글은 다른 안건의 답일 수 있다. 맞더라도 승인으로 바로 치지 말라고 표시한다. */
export function quoteNeedsContext(quote: VerifiedQuote): boolean {
  if (!quote.verified || !quote.source) return false;
  return quote.source.card != null || normalizeSpace(quote.text).length < SHORT_QUOTE;
}

const QUOTE_SOURCE_MAX = 1000;

export function formatInstruction(name: string, text: string, quote: VerifiedQuote | null): string {
  const lines = [`[총괄] ${name}에게`];
  if (quote) {
    const cited = normalizeSpace(quote.text);
    const label = !quote.verified ? "총괄 인용(미확인)" : quoteNeedsContext(quote) ? "사용자 요청(문맥 확인 필요)" : "사용자 요청(원문, 서버 확인)";
    const source = quote.source ? normalizeSpace(quote.source.text) : "";
    const whole = !!quote.source && source === cited;
    const stamp = quote.source?.at ? ` ${quote.source.at}` : "";
    const origin = !whole || !quote.source ? "" : quote.source.card != null ? ` 결재 #${quote.source.id} '${quotedInline(quote.source.card)}'에서 고른 답${stamp}` : ` #${quote.source.id}${stamp}`;
    lines.push(`${label}: "${cited}"${origin}`);
    if (quote.source && !whole) {
      lines.push(`대표 글 전문 #${quote.source.id}: "${source.length > QUOTE_SOURCE_MAX ? `${source.slice(0, QUOTE_SOURCE_MAX)}…` : source}"`);
    }
  }
  // 첫 줄 뒤는 총괄이 쓴 글이다. 어떤 모양이어도 줄 머리가 접두어처럼 보이지 않게 인용 표시를 붙인다.
  const [first, ...rest] = cleanText(text).split("\n");
  lines.push(`할 일: ${first}`);
  if (rest.length > 0) lines.push(quoteBlock(rest.join("\n")));
  return lines.join("\n");
}

export function formatReport(name: string, kind: string, title: string, body: string): string {
  const head = `[보고 ${name}] ${kind}: ${normalizeSpace(title)}`;
  return body ? `${head}\n${quoteBlock(body)}` : head;
}

export function formatSystem(text: string): string {
  return `[시스템] ${text}`;
}

/** 판 정리 지시의 머리. 대기열에 이미 있는지, 이번 턴이 판 정리였는지 이것으로 가린다. */
export const TIDY_HEAD = formatSystem("판 정리");

/** 총괄(본사는 본사 AI)에게 넣는 판 정리 지시. 본사 AI 에게는 진행판·지금 상황 도구가 없다. */
export function formatTidy(kind: MemberKind, manual: boolean): string {
  const tools =
    kind === "root"
      ? "이미 정해졌거나 필요 없어진 결재는 `ask_close`, 끝났거나 필요 없어진 할 일은 `todo_close`."
      : "이미 정해졌거나 필요 없어진 결재는 `ask_close`, 끝났거나 필요 없어진 할 일은 `todo_close`, 진행판은 `work_set`·`work_remove`, 전체 그림은 `project_now`.";
  return [
    `${TIDY_HEAD}${manual ? "(대표가 눌렀습니다)" : ""}: 열린 결재·내 할 일·진행판·지금 상황을 지금 상태에 맞춰라.`,
    "- `board` 로 판을 보고, 대화·보고·세션 기록으로 판단한다.",
    `- ${tools}`,
    "- 대표가 아직 정하지 않은 결재는 대신 닫지 않는다. 확실하지 않으면 그대로 둔다. 직원은 깨우지 않는다.",
    "- 바뀐 게 있으면 `post`(알림) 한 줄로 무엇을 정리했는지 알린다. 없으면 아무것도 올리지 말고 턴을 끝낸다.",
  ].join("\n");
}

function isTidy(d: Pick<Delivery, "kind" | "text">): boolean {
  return d.kind === "system" && d.text.startsWith(TIDY_HEAD);
}

// ---- 공개 타입 ----
export interface AgentToolsImpl {
  listAgentTools(member: Member): AgentToolDef[] | Promise<AgentToolDef[]>;
  handleAgentTool(orch: Orchestrator, member: Member, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult>;
}

/** herdr 어댑터만의 기능. Runner 인터페이스 밖이다. */
export interface HerdrCapable extends Runner {
  /** 재시작 뒤 snapshot 으로 sessionId→pane 재결합. 없으면 null. */
  reattach(m: RunnerMember): Promise<{ paneId: string; tabId: string | null } | null>;
  /** 표지가 칸에 이미 들어갔는가(재시작 복구). 기록이나 화면으로 확인한다. */
  promptSeen?(m: RunnerMember, markers: string[]): Promise<boolean>;
  /** 칸이 쉬고 있을 때 세션 기록의 마지막 글. since 뒤에 쓰인 것만 준다(서버가 꺼진 사이 끝난 턴의 보고). */
  finishedWhileAway?(m: RunnerMember, since: string): { finalText: string; isError: boolean } | null;
  /** 칸을 옮기지도 이름을 바꾸지도 않고 세션을 맡는다. */
  adopt(m: RunnerMember, paneId: string, o: StartOpts): Promise<{ sessionId: string | null; paneId: string; tabId: null }>;
  /** 칸과 세션은 그대로 두고 손을 뗀다. */
  release(m: RunnerMember, notice: string | null): Promise<{ notified: boolean }>;
  /** 명부에서 빠진 직원의 추적을 지우고 다시 묶지 않는다. */
  dropMember?(memberId: string): void;
}

/** 소켓에서 읽기만 하는 herdr 조회. 실행기가 없어도(시험·미설치) 화면은 떠야 해서 따로 둔다. */
export interface HerdrQueries {
  info(): Promise<HerdrInfo>;
  agents(): Promise<LiveAgent[]>;
  /** 편입 전 살펴보기(화면·명령줄·기록). 없으면 칸의 목록 정보만 본다. */
  inspect?(a: LiveAgent): Promise<PaneInspection>;
}

export interface OrchestratorTimings {
  inputBusyRetryMs: number;
  inputBusyLimitMs: number;
  retryMs: number;
  tickMs: number;
  compactTimeoutMs: number;
  /** 입력을 읽기 전에 오류로 끝난 턴을 다시 보내기까지(시도마다 곱한다). */
  turnErrorRetryMs: number;
  /** 직접 띄운 CLI: 도구 호출이 이만큼 없으면 일하는 중을 대기로, 안 보임으로 본다. */
  manualIdleMs: number;
  manualOfflineMs: number;
  /** 실행기가 켜졌는지 꺼졌는지 다시 보는 간격. 화면의 입력 허용이 이것을 따른다. */
  healthMs: number;
}

const DEFAULT_TIMINGS: OrchestratorTimings = {
  inputBusyRetryMs: 5000,
  inputBusyLimitMs: 60_000,
  retryMs: 5000,
  tickMs: 30_000,
  compactTimeoutMs: 600_000,
  turnErrorRetryMs: 60_000,
  manualIdleMs: 5 * 60_000,
  manualOfflineMs: 30 * 60_000,
  healthMs: 5000,
};

/** 입력을 읽지 못하고 끝난 턴을 다시 보내는 횟수 상한. 넘으면 실패로 알린다. */
const MAX_TURN_ERROR_ATTEMPTS = 3;
/** 실행 방식을 바꿀 때 이미 돌던 전달을 기다리는 시간. 넘으면 거부한다. */
const SWITCH_SETTLE_MS = 5000;

export interface OrchestratorDeps {
  config: Pick<Config, "home" | "rolesDir" | "port">;
  store: Store;
  runners: Map<Backend, Runner>;
  herdr?: HerdrQueries;
  serverUrl?: string;
  agentTools?: AgentToolsImpl;
  timings?: Partial<OrchestratorTimings>;
  /** 맥 알림. 시험에서는 넣지 않으면 아무것도 안 한다. */
  notifier?: (title: string, body: string) => void;
}

export interface NewMemberInput {
  name: string;
  role?: string;
  handle?: string;
  cwd?: string;
  kind?: Exclude<MemberKind, "root">;
  firstInstruction?: string;
  userQuote?: string;
  parallel?: boolean;
}

export interface AssignInput {
  text: string;
  userQuote?: string;
  parallel?: boolean;
  urgent?: boolean;
  /** 대표 메시지의 첨부 id. 그 직원 폴더로 이어 경로를 알린다. */
  attachmentIds?: string[];
}

export interface AssignResult {
  delivery: Delivery;
  /** 앞에 일이 있어 기다리면 대기열 위치(1부터), 곧바로 들어가면 0. */
  position: number;
  verified: boolean | null;
  /** 맞았지만 버튼 글·짧은 글이라 '문맥 확인 필요'로 나갔다. */
  needsContext: boolean;
}

export interface PostInput {
  kind: Extract<MessageKind, "완료" | "진행" | "막힘" | "알림" | "질문">;
  title: string;
  body?: string;
  fileIds?: string[];
  decisionId?: string | null;
}

export interface AskInput {
  title: string;
  detail?: string;
  options?: DecisionOption[];
  rec?: string | null;
  group?: string | null;
  fileId?: string | null;
  images?: Attachment[];
}

export interface RosterEntry {
  handle: string;
  name: string;
  role: string;
  kind: MemberKind;
  status: Member["status"];
  now: string;
  next: string;
  queued: number;
  openDecisions: number;
  contextPct: number | null;
  subagents: number;
  parallel: boolean;
  updatedAt: string;
  /** 세션이 써야 할 값(직원별 지정 > 직급 기본). null 은 CLI 기본. */
  model: string | null;
  effort: Effort | null;
  /** 서브에이전트에 쓰는 값. */
  subagentModel: string | null;
  subagentEffort: Effort | null;
}

interface Turn {
  kind: "work" | "compact" | "control";
  headless: boolean;
  text: string;
  interrupted: boolean;
  sessionRetried: boolean;
  /** 이 턴으로 나간 전달. 입력을 읽기 전에 끝나면 되돌린다. */
  deliveries?: Delivery[];
}

interface Runtime {
  turn: Turn | null;
  pumping: Promise<void> | null;
  again: boolean;
  posted: boolean;
  direct: boolean;
  /** 방금 압축했거나 압축이 실패했다. 다음 턴이 끝나 새 usage 를 받기 전까지 다시 압축하지 않는다. */
  skipCompact: boolean;
  compactRequest: string | null;
  compactTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inputBusySince: number | null;
  wantParallel: boolean | null;
  /** 세션을 띄우는 중. 끝날 때까지 전달하지 않는다(둘이 함께 띄우면 칸이 둘 생기고 순서가 뒤집힌다). */
  starting: Promise<void> | null;
  reopening: Promise<Member | null> | null;
  /** 닫는 중. 틱이 대기열을 보고 세션을 다시 열면 명부 밖 칸이 남는다. */
  closing: boolean;
  /** 병렬 설정을 다시 시도한 횟수. 끝내 안 되면 총괄에게 알리고 일을 내보낸다. */
  parallelFails: number;
  /** 이 시각까지는 전달하지 않는다(입력을 못 읽고 끝난 턴을 곧바로 되풀이하지 않게). */
  holdUntil: number;
  /** 재결합 중에는 working 을 '대표가 터미널에 친 일'로 보지 않는다. */
  reattaching: boolean;
  /** 새 설정으로 다시 열기를 실패한 횟수와, 포기한 설정. 설정이 또 바뀌면 다시 시도한다. */
  configFails: number;
  configGaveUp: string | null;
}

const HOLD_NOTES: Record<string, string> = {
  blocked: "승인 창 앞에서 멈춤",
  input_busy: "입력칸에 넣지 못함(선택 창 등)",
  asleep: "잠듦",
  offline: "세션이 보이지 않음",
  backend_down: "실행기에 연결할 수 없음",
  runner_disabled: "실행이 꺼져 있음",
  archived: "보관되어 멈춤",
};

/** 턴 오류·전달 오류가 이어질 때 ref 없는 전달(보고·지시·완료)을 다시 보내는 간격의 배수. 잃지 않되 사용량을 태우지 않게 멀리 둔다. */
const HELD_RETRY_FACTOR = 5;

const WAKE_POST_KINDS = new Set<string>(["완료", "막힘", "질문"]);

/** 실제 실행기로 조립한다. herdr 는 설정의 소켓만 쓴다. */
export function createOrchestrator(config: Config, store: Store): Orchestrator {
  const runners = new Map<Backend, Runner>([
    ["headless", new HeadlessRunner({ claudeBin: config.claudeBin, runDir: join(config.home, "run"), inboxDir: config.inboxDir })],
    ["herdr", new HerdrRunner({ socketPath: config.herdrSocket }, { inboxDir: config.inboxDir })],
  ]);
  const herdr: HerdrQueries = { info: () => detectHerdr(config.herdrSocket), agents: () => listAgents(config.herdrSocket), inspect: (a) => inspectPane(config.herdrSocket, a) };
  return new Orchestrator({ config, store, runners, herdr, notifier: macNotifier() });
}

/** 인자로 넘기므로 글에 무엇이 있어도 AppleScript 로 해석되지 않는다. */
function macNotifier(): ((title: string, body: string) => void) | undefined {
  if (process.platform !== "darwin" || process.env.IAMCEO_TEST === "1") return undefined;
  return (title, body) => {
    try {
      Bun.spawn(["osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, body], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (e) {
      console.warn("맥 알림 실패:", (e as Error).message);
    }
  };
}

export class Orchestrator implements OrchestratorApi {
  readonly store: Store;
  private readonly config: OrchestratorDeps["config"];
  private readonly runners: Map<Backend, Runner>;
  private readonly timings: OrchestratorTimings;
  private readonly herdr: HerdrQueries | null;
  private agentTools: AgentToolsImpl | null;
  private serverUrl: string;
  private runtimes = new Map<string, Runtime>();
  /** 동시 턴 상한에 걸려 기다리는 직원. 턴이 끝나면 차례로 다시 민다. */
  private waiting = new Set<string>();
  private askWaiters = new Map<string, Set<() => void>>();
  private inboxWaiters = new Map<string, Set<() => void>>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly notifier: ((title: string, body: string) => void) | null;
  /** 소켓이 안 닿아 재결합하지 못한 herdr 직원. 틱이 다시 시도한다. */
  private unattached = new Set<string>();
  /** 보관 전에 넘겨받은 칸을 끝내는 중인 프로젝트. 전달은 보관된 것처럼 멈춘다. */
  private archiving = new Set<string>();
  private lastHerdrInfo: string | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthProbe: Promise<void> | null = null;
  private switching = false;

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.runners = deps.runners;
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.herdr = deps.herdr ?? null;
    this.agentTools = deps.agentTools ?? null;
    this.notifier = deps.notifier ?? null;
    this.serverUrl = deps.serverUrl ?? `http://127.0.0.1:${deps.config.port}`;
    for (const runner of this.runners.values()) {
      runner.on((event) => {
        void this.onRunnerEvent(event).catch((e) => console.error("실행기 이벤트 처리 오류:", event.type, e));
      });
    }
  }

  /** 접속 코드·토큰이 있는 폴더. file 도구가 읽지 못하게 막는다. */
  get dataDir(): string {
    return this.config.home;
  }

  /** file 도구가 원본을 복사해 두는 곳. */
  get uploadsDir(): string {
    return join(this.config.home, "uploads");
  }

  /** 서버가 실제 포트로 뜬 뒤 부른다. MCP 설정 파일에 들어간다. */
  setServerUrl(url: string): void {
    this.serverUrl = url;
  }

  // ---- 시작·종료 ----
  /** 서버 재시작 복구(§6). 끊긴 턴을 정리하고 대기열을 다시 민다. */
  async recover(): Promise<void> {
    // 서버가 강제로 죽었으면 전 턴의 자식이 살아 있다. 먼저 끝내야 같은 세션을 둘이 쓰지 않는다.
    await Promise.all([...this.runners.values()].map((r) => r.reapOrphans?.().catch((e) => console.warn("남은 자식 정리 실패:", (e as Error).message))));
    this.store.releaseHeldBeforeConnection();
    await this.refreshConnection();
    await this.settleInFlight();
    this.store.requeueDelivering();
    const herdrMembers: Member[] = [];
    for (const member of this.store.listAllMembers()) {
      if (member.subagents !== 0) this.store.patchMember(member.id, { subagents: 0 });
      if (member.origin === "manual") continue;
      const project = this.store.requireProject(member.projectId);
      if (this.backendOf(member) === "herdr") {
        // 가져온 명부의 직원은 세션도 칸도 없어 재결합할 것이 없다.
        if (member.status !== "asleep" && (member.sessionId || member.paneId)) herdrMembers.push(member);
        continue;
      }
      if (member.status === "working" || member.status === "blocked") {
        this.settle(member);
        this.systemMessage(project.id, `서버 재시작으로 ${member.name}의 턴이 끊겼습니다`);
        const conductor = this.store.getConductor(project.id);
        if (conductor && conductor.id !== member.id) {
          this.store.enqueue({
            projectId: project.id,
            memberId: conductor.id,
            kind: "system",
            text: formatSystem(`서버 재시작으로 ${member.name}의 턴이 끊겼습니다. 필요하면 다시 지시하세요.`),
            wake: false,
          });
        }
      }
    }
    await Promise.all(herdrMembers.map((m) => this.reattachHerdr(m)));
    this.startTick();
    const ids = new Set(this.store.listUndelivered().map((d) => d.memberId));
    await Promise.all([...ids].map((id) => this.pump(id)));
    await this.retryOrphans();
  }

  /**
   * 글을 넣는 도중 서버가 죽으면 전달이 delivering 으로 남는다. 칸에는 이미 들어갔을 수 있어 무조건 되돌리면 같은 입력이 두 번 간다.
   * herdr 는 세션 기록·화면에서 표지를 찾아, 있으면 받은 것으로 친다. 한 직원의 delivering 은 한 묶음이다.
   */
  private async settleInFlight(): Promise<void> {
    const runner = this.runners.get("herdr") as HerdrCapable | undefined;
    if (!runner?.promptSeen) return;
    const groups = new Map<string, Delivery[]>();
    for (const d of this.store.listDelivering()) groups.set(d.memberId, [...(groups.get(d.memberId) ?? []), d]);
    await Promise.all(
      [...groups].map(async ([memberId, deliveries]) => {
        const member = this.store.getMember(memberId);
        if (!member || !member.sessionId) return;
        const project = this.store.requireProject(member.projectId);
        if (this.backendOf(member) !== "herdr") return;
        const markers = deliveries.flatMap((d) => [`#${d.id}`, ...(d.text.match(/#(?:msg|d|t)_[A-Za-z0-9_-]+$|#[0-9a-f]{8}-[0-9a-f-]{27}$/) ?? [])]);
        const seen = await runner.promptSeen!(this.runnerMember(member, project), markers).catch(() => false);
        if (!seen) return;
        for (const d of deliveries) this.markDelivered(d);
        this.store.appendActivity(memberId, "turn_start", normalizeSpace(deliveries.map((d) => d.text).join(" ")).slice(0, 300));
      }),
    );
  }

  /** 일하던 칸을 잃었거나 턴이 끊겼다. 대기열이 없으면 아무도 깨우지 않아 팀이 조용히 멈춘다. 총괄이 기다리는 일이라 깨운다. */
  private noticeCutTurn(member: Member, why: string): void {
    this.systemMessage(member.projectId, `${member.name}: ${why}`);
    const conductor = this.store.getConductor(member.projectId);
    if (conductor && conductor.id !== member.id) {
      void this.deliver({ projectId: member.projectId, memberId: conductor.id, kind: "system", text: formatSystem(`${member.name}: ${why}. 필요하면 다시 지시하세요.`) });
    }
  }

  private async reattachHerdr(member: Member): Promise<void> {
    const runner = this.runners.get("herdr") as HerdrCapable | undefined;
    if (!runner) return;
    const project = this.store.requireProject(member.projectId);
    const rt = this.runtime(member.id);
    const wasWorking = member.status === "working";
    rt.reattaching = true;
    try {
      const found = await runner.reattach(this.runnerMember(member, project));
      this.unattached.delete(member.id);
      if (!found) {
        this.store.patchMember(member.id, { status: "offline", paneId: null, lastError: null });
        if (wasWorking) this.noticeCutTurn(member, "서버가 꺼진 사이 칸이 사라져 하던 턴이 끊겼습니다");
        return;
      }
      if (member.lastError?.startsWith("herdr 재결합 실패")) this.store.patchMember(member.id, { lastError: null });
      // reattach 안에서 칸의 실제 상태(승인 창 등)가 DB 에 이미 들어갔다. 옛 값으로 덮어쓰면 안 된다.
      const fresh = this.store.requireMember(member.id);
      if (runner.isBusy(member.id) || fresh.status === "blocked") {
        // 턴이 이어지는 중이다. 재시작 전에 이미 post 했으면 턴 끝에 (자동) 보고를 또 내지 않는다.
        const since = this.store.lastTurnStart(member.id);
        rt.posted = since !== null && this.store.hasMessageBySince(member.id, since);
        return;
      }
      if (wasWorking && (await this.reportFinishedWhileAway(fresh, project, runner))) return;
      this.settle(fresh);
      if (wasWorking) this.noticeCutTurn(fresh, "서버가 꺼진 사이 턴이 끊겼습니다. 끝났다는 보고를 찾지 못했습니다");
    } catch (e) {
      // 소켓이 안 닿으면 칸이 사라졌다고 볼 수 없다. 틱이 다시 시도한다.
      this.unattached.add(member.id);
      this.store.patchMember(member.id, { lastError: `herdr 재결합 실패: ${(e as Error).message}` });
    } finally {
      rt.reattaching = false;
    }
  }

  /** 서버가 꺼진 사이 끝난 턴의 마지막 글을 보고로 살린다. 이미 post 했거나 이번 입력 뒤의 글이 아니면 하지 않는다. */
  private async reportFinishedWhileAway(member: Member, project: Project, runner: HerdrCapable): Promise<boolean> {
    const since = this.store.lastTurnStart(member.id);
    if (!since || !runner.finishedWhileAway) return false;
    const finished = runner.finishedWhileAway(this.runnerMember(member, project), since);
    if (!finished) return false;
    const rt = this.runtime(member.id);
    rt.posted = this.store.hasMessageBySince(member.id, since);
    await this.onTurnEnd(member, { type: "turn_end", memberId: member.id, finalText: finished.finalText, isError: finished.isError, ...(finished.isError ? { errorText: finished.finalText } : {}) });
    return true;
  }

  private startTick(): void {
    if (this.tick) return;
    this.tick = setInterval(() => this.onTick(), this.timings.tickMs);
    this.tick.unref?.();
    this.healthTimer = setInterval(() => void this.refreshConnection().catch((e) => console.warn("실행기 상태 확인 실패:", (e as Error).message)), this.timings.healthMs);
    this.healthTimer.unref?.();
  }

  /** 전역 실행기가 지금 쓸 수 있는지 다시 본다. 달라졌으면 화면에 알리고, 돌아왔으면 보류된 것을 민다. 겹쳐 불러도 한 번만 묻는다. */
  refreshConnection(): Promise<void> {
    this.healthProbe ??= this.probeHealth().finally(() => {
      this.healthProbe = null;
    });
    return this.healthProbe;
  }

  private async probeHealth(): Promise<void> {
    const backend = this.store.effectiveBackend();
    const runner = this.runners.get(backend);
    const state = runner ? await runner.available().catch((e: Error) => ({ ok: false, detail: e.message })) : { ok: false, detail: "실행기가 없습니다" };
    if (this.closed || !this.store.setRunnerHealth(backend, { ok: state.ok, detail: state.ok ? null : state.detail })) return;
    await this.broadcastHerdr();
    if (!state.ok) return;
    for (const id of new Set(this.store.listUndelivered().map((d) => d.memberId))) void this.pump(id);
    void this.retryOrphans().catch((e) => console.warn("보류된 말 전달 재시도 실패:", (e as Error).message));
  }

  private onTick(): void {
    for (const id of [...this.unattached]) {
      const member = this.store.getMember(id);
      if (member && member.status !== "asleep") void this.reattachHerdr(member);
      else this.unattached.delete(id);
    }
    this.checkManualMembers();
    // 입력칸을 못 찾았거나(선택 창 등) 소켓이 끊겨 못 맞춘 새 설정을 다시 시도한다.
    for (const m of this.store.listAllMembers()) {
      if ((m.status === "idle" || m.status === "waiting") && this.configPending(m)) void this.pump(m.id);
    }
    void this.retryOrphans().catch((e) => console.warn("보류된 말 전달 재시도 실패:", (e as Error).message));
    void this.broadcastHerdr();
    const ids = new Set(
      this.store
        .listUndelivered()
        .filter((d) => !(d.status === "held" && (d.holdReason === "asleep" || d.holdReason === "runner_disabled")))
        .map((d) => d.memberId),
    );
    for (const id of ids) void this.pump(id);
    try {
      this.checkBoardTidy();
    } catch (e) {
      console.warn("판 정리 확인 실패:", (e as Error).message);
    }
  }

  /**
   * 판 정리(주기). 틱마다 부른다. 조건이 모두 맞는 프로젝트의 총괄(본사는 본사 AI)에게만 판 정리 지시를 깨움으로 넣는다:
   * 보관 아님 · 실행 켜짐 · 연결됨 · 총괄이 이미 떠 있고 쉬는 중(일하는 중·잠듦·꺼짐·넘겨받은 칸이면 건너뛴다. 정리하려고 띄우지 않는다)
   * · 간격이 지남 · 지난 정리 뒤 결재·할 일·진행판·대화에 바뀐 게 있음 · 기다리는 판 정리 지시가 없음. 넣은 프로젝트 id 를 돌려준다.
   */
  checkBoardTidy(now = Date.now()): string[] {
    const hours = this.store.getSettings().boardTidyHours;
    if (!(hours > 0) || this.closed || this.switching) return [];
    const queued: string[] = [];
    for (const project of this.store.listProjects()) {
      if (!project.runnerEnabled || !project.connection.ok || this.archiving.has(project.id)) continue;
      const lead = this.store.getConductor(project.id);
      if (!lead || lead.origin !== "runner" || !lead.sessionId) continue;
      if (lead.status !== "idle" && lead.status !== "waiting") continue;
      const rt = this.runtime(lead.id);
      if (this.isBusy(lead) || rt.starting || rt.reopening || rt.pumping || rt.closing) continue;
      if (this.tidyPending(lead.id)) continue;
      // 한 번도 정리하지 않았으면 총괄이 뜬 때부터 센다.
      const since = project.tidiedAt ?? lead.createdAt;
      if (now - Date.parse(since) < hours * 3_600_000) continue;
      const changed = this.store.lastBoardChangeAt(project.id);
      if (!changed || changed <= since) continue;
      this.store.setBoardTidiedAt(project.id, new Date(now).toISOString());
      void this.deliver({ projectId: project.id, memberId: lead.id, kind: "system", text: formatTidy(lead.kind, false) });
      queued.push(project.id);
    }
    return queued;
  }

  /** 판 정리 지시가 줄 서 있거나 지금 그 턴이 돈다. */
  private tidyPending(memberId: string): boolean {
    if (this.runtimes.get(memberId)?.turn?.deliveries?.some(isTidy)) return true;
    return this.store.listPending(memberId).some(isTidy);
  }

  /**
   * 대표의 '지금 판 정리'. 간격·바뀐 것을 따지지 않는다. 총괄이 없거나 잠들었으면 띄운다. 연결은 http 가 먼저 본다(409).
   * 이미 기다리거나 도는 판 정리가 있으면 새로 넣지 않는다.
   */
  async tidyBoard(projectId: string): Promise<TidyResult> {
    const project = this.store.requireProject(projectId);
    this.requireActive(project);
    if (!project.runnerEnabled) throw new ApiError(409, "이 프로젝트는 실행이 꺼져 있습니다. 총괄을 시작하거나 기존 세션을 편입하세요");
    const lead = this.store.getConductor(projectId) ?? (await this.ensureConductor(projectId));
    if (lead.origin === "adopted") throw new ApiError(409, `${josa(lead.name, "은")} 넘겨받은 세션이라 도구가 없습니다. 팀 화면에서 '도구 붙여 다시 열기'를 먼저 하세요`);
    if (this.tidyPending(lead.id)) return { already: true };
    this.store.setBoardTidiedAt(projectId, new Date().toISOString());
    await this.deliver({ projectId, memberId: lead.id, kind: "system", text: formatTidy(lead.kind, true) });
    return { already: false };
  }

  /** 서버가 보낼 이벤트가 없어도 herdr 가 내려가거나 올라오면 화면이 알아야 한다. */
  private async broadcastHerdr(): Promise<void> {
    if (!this.herdr) return;
    const info = await this.herdrInfo();
    const key = JSON.stringify(info);
    if (key === this.lastHerdrInfo) return;
    if (this.lastHerdrInfo !== null) this.store.broadcast({ type: "herdr", herdr: info });
    this.lastHerdrInfo = key;
  }

  /** 직접 띄운 CLI 는 실행기가 없어 도구 호출 시각으로만 상태를 안다. */
  private checkManualMembers(): void {
    const now = Date.now();
    for (const m of this.store.listAllMembers()) {
      if (m.origin !== "manual") continue;
      const quiet = now - new Date(m.updatedAt).getTime();
      // 답을 기다리는 세션은 브리지가 롱폴을 다시 걸 때마다 시각이 새로워진다. 그것마저 끊겼으면 죽은 것이다.
      if (quiet >= this.timings.manualOfflineMs && (m.status === "idle" || m.status === "working" || m.status === "waiting")) this.store.patchMember(m.id, { status: "offline" });
      else if (quiet >= this.timings.manualIdleMs && m.status === "working") this.store.patchMember(m.id, { status: "idle" });
    }
  }

  /** 도구를 부르면 살아 있고 일하는 중이다. wait 는 지시를 기다리는 것이니 대기다. */
  noteManualCall(member: Member, tool: string): void {
    if (member.origin !== "manual") return;
    const next = tool === "wait" ? "idle" : tool === "ask_wait" || member.status === "waiting" ? "waiting" : "working";
    if (member.status !== next) this.store.patchMember(member.id, { status: next });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.tick) clearInterval(this.tick);
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const rt of this.runtimes.values()) {
      if (rt.compactTimer) clearTimeout(rt.compactTimer);
      if (rt.retryTimer) clearTimeout(rt.retryTimer);
    }
    for (const waiters of [...this.askWaiters.values(), ...this.inboxWaiters.values()]) {
      for (const wake of waiters) wake();
    }
    await Promise.all([...this.runners.values()].map((r) => r.shutdown()));
  }

  // ---- REST 겉면 ----
  async createProject(req: CreateProjectReq): Promise<Project> {
    const goal = req.goal?.trim();
    const project = this.store.createProject({ name: req.name, cwd: req.cwd, now: goal });
    if (req.startConductor) {
      const conductor = await this.ensureConductor(project.id);
      if (goal) await this.deliver({ projectId: project.id, memberId: conductor.id, kind: "system", text: formatSystem(`프로젝트 목표: ${guardLines(goal)}`) });
    }
    return this.store.requireProject(project.id);
  }

  /** 저장 전에 부른다. 보관할 수 없으면 거부한다. */
  async beforeProjectPatch(project: Project, patch: PatchProjectReq): Promise<void> {
    if (patch.archived === true && !project.archived) {
      this.checkArchivable(project);
      await this.sleepAdoptedForArchive(project);
    }
    // 켜면 세션이 뜬다. 꺼내면서 켜는 것만 된다.
    if (patch.runnerEnabled === true && (patch.archived ?? project.archived)) this.requireActive(project);
  }

  /**
   * 넘겨받은 칸은 대표의 것이라 하나라도 못 끝내면 보관을 거부한다. 끝낸 칸은 되돌릴 수 없으므로 전부 먼저 보고, 다 된다고 할 때만 끝낸다.
   * 소켓 문제도 거부한다. 칸이 깬 채로 보관되면 안 된다. 이미 안 보이는 직원(offline)만 예외다.
   * 끝내는 동안 전달이 칸을 다시 열지 못하게 archiving 으로 막는다. 끝나면 호출한 쪽이 곧바로 저장하므로 틱이 끼어들 틈이 없다.
   */
  private async sleepAdoptedForArchive(project: Project): Promise<void> {
    if (this.archiving.has(project.id)) throw new ApiError(409, "보관을 처리하는 중입니다. 잠시 뒤 다시 하세요");
    this.archiving.add(project.id);
    try {
      const adopted = this.store.listMembers(project.id).filter((m) => m.origin === "adopted" && m.status !== "asleep" && (m.sessionId || m.paneId));
      for (const m of adopted) {
        try {
          await this.runnerOf(m).checkStop?.(this.runnerMember(m, project));
        } catch (e) {
          if (this.skipsArchiveRefusal(m, e)) continue;
          throw this.archiveRefusal(m, e);
        }
      }
      this.checkArchivable(project); // 보는 동안 일이 시작됐을 수 있다.
      const slept: { member: Member; deliveries: Set<string> }[] = [];
      for (const m of adopted) {
        const deliveries = new Set(this.store.listPending(m.id).map((d) => d.id));
        try {
          await this.sleepMember(m.id, { force: true, holdAs: "archived" });
          slept.push({ member: m, deliveries });
        } catch (e) {
          if (this.skipsArchiveRefusal(m, e)) continue;
          // 보고 난 뒤에 칸이 달라진 경우다. 이미 끝낸 칸은 되돌릴 수 없으니 잠든 채로 두고, 활성 프로젝트에서 저절로 깨어나지 않게 한다.
          for (const s of slept) {
            for (const d of this.store.listPending(s.member.id)) {
              if (s.deliveries.has(d.id) && d.status === "held" && d.holdReason === "archived") this.hold(d, "asleep");
            }
          }
          const refusal = this.archiveRefusal(m, e);
          if (slept.length === 0) throw refusal;
          throw new ApiError(refusal.status, `${refusal.message} (${slept.map((s) => s.member.name).join(", ")}의 칸은 이미 끝나 잠든 채로 둡니다)`);
        }
      }
    } finally {
      this.archiving.delete(project.id);
    }
  }

  /** 안 보이는 직원의 칸은 소켓이 안 닿아도 보관을 막지 않는다. 쓰던 글이 있다는 거절은 언제나 막는다. */
  private skipsArchiveRefusal(m: Member, e: unknown): boolean {
    if (m.status !== "offline" || this.isCannotExit(e)) return false;
    console.warn(`${m.name} 잠재우기 실패:`, (e as Error).message);
    return true;
  }

  private isCannotExit(e: unknown): boolean {
    return (e instanceof HerdrError && e.code === "cannot_exit") || (e instanceof ApiError && e.status === 409);
  }

  private archiveRefusal(m: Member, e: unknown): ApiError {
    const why = (e as Error).message;
    return this.isCannotExit(e) ? new ApiError(409, `${m.name}의 칸을 끝내지 못해 보관할 수 없습니다: ${why}`) : new ApiError(503, `${m.name}의 칸을 확인하지 못해 보관할 수 없습니다: ${why}`);
  }

  /** 보관한 프로젝트는 화면에 없어 멈출 수 없다. 세션을 새로 띄우거나 깨우는 길은 모두 여기서 막는다. */
  private requireActive(project: Project): void {
    if (project.archived) throw new ApiError(409, "보관된 프로젝트입니다. 보관함에서 꺼낸 뒤 다시 하세요");
  }

  /** 전체 설정을 고친다. 실행 방식은 일하는 직원이 있으면 거부하고, 아니면 이전 실행기의 칸을 닫은 뒤 다음 전달부터 새 방식으로 잇는다. */
  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const before = this.store.getSettings();
    let settings: Settings;
    if (patch.backend && patch.backend !== before.backend) {
      this.requireNotSwitching();
      // 칸을 닫는 동안 나간 지시는 칸과 함께 사라진다. 끝날 때까지 전달을 세우고, 끝나면(거부돼도) 줄 선 것을 민다.
      this.switching = true;
      try {
        await this.switchBackend(patch.backend);
        settings = this.store.patchSettings(patch);
      } finally {
        this.switching = false;
        for (const m of this.store.listAllMembers()) if (m.origin !== "manual" && this.store.listPending(m.id).length > 0) void this.pump(m.id);
      }
    } else {
      settings = this.store.patchSettings(patch);
    }
    await this.refreshConnection();
    // 쉬고 있는 세션은 곧바로 새 설정으로 맞춘다. 응답을 칸 여는 시간만큼 붙잡지 않는다.
    for (const m of this.store.listAllMembers()) if (this.configPending(m)) void this.pump(m.id);
    return settings;
  }

  private requireNotSwitching(): void {
    if (this.switching) throw new ApiError(409, "실행 방식을 바꾸는 중입니다. 잠시 뒤 다시 하세요");
  }

  private refuseIfBusy(member: Member): void {
    const rt = this.runtime(member.id);
    if (this.isBusy(member) || member.status === "working" || member.status === "blocked" || rt.pumping || rt.starting || rt.reopening) {
      throw new ApiError(409, `${this.store.requireProject(member.projectId).name}의 ${josa(member.name, "이")} 일하는 중이라 실행 방식을 바꿀 수 없습니다. 끝난 뒤 다시 하세요`);
    }
  }

  private async switchBackend(next: Backend): Promise<void> {
    const members = this.store.listAllMembers().filter((m) => m.origin !== "manual");
    // 관문을 지난 전달이 아직 돌 수 있다. 끝나면 턴으로 잡혀 아래 검사에 걸린다.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(members.map((m) => this.runtime(m.id).pumping)),
      new Promise((done) => {
        settleTimer = setTimeout(done, SWITCH_SETTLE_MS);
      }),
    ]);
    clearTimeout(settleTimer);
    for (const m of members) {
      const fresh = this.store.getMember(m.id);
      if (fresh) this.refuseIfBusy(fresh);
    }
    const moving = members.filter((m) => this.backendOf(m) !== next);
    // 넘겨받은 칸은 끝내지 못할 수 있다. 하나라도 그러면 아무 칸도 끝내기 전에 거부한다.
    for (const member of moving) {
      const project = this.store.requireProject(member.projectId);
      await this.runners
        .get(this.backendOf(member))
        ?.checkStop?.(this.runnerMember(member, project))
        .catch((e) => this.refuseSwitch(member, project, e));
    }
    const moved: string[] = [];
    try {
      for (const { id } of moving) {
        // 앞 칸을 닫는 동안 달라졌을 수 있다. 전달은 서 있지만 대표가 칸에서 일을 시작할 수 있다.
        const member = this.store.getMember(id);
        if (!member) continue;
        this.refuseIfBusy(member);
        const project = this.store.requireProject(member.projectId);
        // 칸을 남기면 같은 세션을 두 실행기가 함께 쓴다. 세션 파일은 그대로라 새 방식으로 이어서 열 수 있다.
        // 이전 실행기가 죽어 있어도 옮길 수 있어야 한다. herdr 가 안 켜져서 바꾸는 경우가 흔하다.
        await this.runners
          .get(this.backendOf(member))
          ?.stop(this.runnerMember(member, project))
          .catch(async (e) => {
            await this.refuseSwitch(member, project, e);
            this.store.appendActivity(member.id, "error", `이전 실행기의 칸을 닫지 못했습니다: ${(e as Error).message}`);
          });
        // 끝낸 넘겨받은 칸은 잠든 것과 같다. 깨울 때 도구와 규칙을 갖고 뜨며 서버 세션이 된다.
        const handedBack = member.origin === "adopted" && !!member.sessionId && member.status !== "asleep" && member.status !== "offline";
        // 병렬은 세션에만 있는 값이라 새 칸·새 프로세스에서 풀린다. 다음 일 전에 되살린다.
        if (member.parallel) this.runtime(id).wantParallel ??= true;
        this.store.patchMember(id, { backend: member.backend ? next : null, paneId: null, ...(member.parallel ? { parallel: false } : {}), ...(handedBack ? { status: "asleep" as const } : {}) });
        moved.push(member.name);
      }
    } catch (e) {
      // 닫은 칸은 되돌릴 수 없다. 옮긴 직원은 새 방식으로 잇고, 대표가 다시 시도하면 남은 직원만 옮긴다.
      if (e instanceof ApiError && moved.length > 0) throw new ApiError(e.status, `${e.message} (${moved.join(", ")}의 칸은 이미 닫아 새 방식으로 옮겼습니다)`);
      throw e;
    }
  }

  /** 칸의 세션이 살아 있는데 넘어가면 같은 세션을 두 프로세스가 쓴다. 실행기가 정말 죽어 있는 경우만 넘어간다. */
  private async refuseSwitch(member: Member, project: Project, e: unknown): Promise<void> {
    const refusal = new ApiError(409, `${project.name}의 ${member.name} 칸을 끝내지 못해 실행 방식을 바꿀 수 없습니다: ${(e as Error).message}`);
    if (e instanceof HerdrError) {
      if (e.code === "cannot_exit") throw refusal;
      if (e.code === "down" || e.code === "closed") return;
    }
    // 시간 초과 등은 실행기가 살아 있으면 칸도 살아 있을 수 있다.
    const health = await this.runners.get(this.backendOf(member))?.available().catch(() => ({ ok: false }));
    if (health?.ok) throw refusal;
  }

  /** 직원별 모델·effort. null 이면 직급 기본으로 돌아간다. */
  async patchMemberConfig(memberId: string, patch: PatchMemberReq): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 설정을 바꿀 수 없습니다");
    const updated = this.store.patchMember(memberId, patch);
    if (this.configPending(updated)) void this.pump(memberId);
    return updated;
  }

  /** 보관하면 화면에서 사라진다. 답을 기다리는 세션이나 일하는 세션을 두고 사라지면 아무도 풀어 줄 수 없다. */
  private checkArchivable(project: Project): void {
    const members = this.store.listMembers(project.id);
    const busy = members.find((m) => m.status === "working" || m.status === "blocked" || (m.origin !== "manual" && this.isBusy(m)));
    if (busy) throw new ApiError(409, `${josa(busy.name, "이")} 일하는 중이라 보관할 수 없습니다`);
    const open = this.store.listDecisions(project.id).filter((d) => d.status === "open").length;
    if (open > 0) throw new ApiError(409, `열린 결재 ${open}건에 답한 뒤 보관하세요`);
    const todos = this.store.listTodos(project.id).filter((t) => !t.done).length;
    if (todos > 0) throw new ApiError(409, `안 한 할 일 ${todos}건을 처리한 뒤 보관하세요`);
  }

  async onProjectPatched(project: Project, patch: PatchProjectReq): Promise<void> {
    if (patch.runnerEnabled === true) {
      // 대표가 직접 켰다. 이제 편입만으로 켠 실행이 아니다.
      this.store.setRunnerByAdopt(project.id, false);
      await this.enableProject(project.id);
    }
    if (patch.archived === true) {
      // 칸을 띄워 둘 이유가 없다. 세션은 남아 꺼내면 다시 깨울 수 있다.
      for (const m of this.store.listMembers(project.id)) {
        if (m.origin !== "manual" && m.status !== "asleep" && (m.sessionId || m.paneId)) {
          await this.sleepMember(m.id, { force: true, holdAs: "archived" }).catch((e) => console.warn(`${m.name} 잠재우기 실패:`, (e as Error).message));
        }
      }
    }
    if (patch.archived === false) {
      // 보관 때문에 멈춘 전달을 다시 민다. 응답을 칸 여는 시간만큼 붙잡지 않는다.
      const stopped = this.store.listUndelivered(project.id).filter((d) => d.status === "held" && d.holdReason === "archived");
      for (const id of new Set(stopped.map((d) => d.memberId))) void this.pump(id);
    }
  }

  async startConductor(projectId: string): Promise<Member> {
    const project = this.store.requireProject(projectId);
    this.requireActive(project);
    // 먼저 본다. 실행기가 없는데 켜 두면 연결된 것처럼 보인다.
    const backend = this.store.effectiveBackend();
    const runner = this.runners.get(backend);
    if (!runner) throw new ApiError(503, `실행기가 없습니다: ${backend}`);
    const available = await runner.available();
    if (!available.ok) throw new ApiError(503, available.detail ?? "실행기를 쓸 수 없습니다");
    if (!project.runnerEnabled) this.store.patchProject(projectId, { runnerEnabled: true });
    const conductor = await this.ensureConductor(projectId);
    if (conductor.status === "asleep") await this.resumeMember(conductor.id);
    await this.enableProject(projectId);
    return this.store.requireMember(conductor.id);
  }

  private async enableProject(projectId: string): Promise<void> {
    this.requireActive(this.store.requireProject(projectId));
    await this.adoptOrphans(projectId);
    await Promise.all(this.store.listMembers(projectId).map((m) => this.pump(m.id)));
  }

  /** 받을 사람이 없어 멈춘 대표의 말·답·완료를 총괄에게 넘긴다. */
  private async adoptOrphans(projectId: string): Promise<void> {
    if (this.orphanMessages(projectId).length + this.orphanAnswers(projectId).length + this.orphanTodos(projectId).length === 0) return;
    const conductor = await this.ensureConductor(projectId);
    // 기다리는 사이 겹친 호출이 이미 넘겼을 수 있다. 여기부터 줄 세우기까지 await 가 없어야 두 번 넘기지 않는다.
    const messages = this.orphanMessages(projectId);
    const answers = this.orphanAnswers(projectId);
    const todos = this.orphanTodos(projectId);
    for (const message of messages) {
      this.store.enqueue({
        projectId,
        memberId: conductor.id,
        kind: "user_message",
        text: formatUserMessage(message.body, this.attachmentsFor(conductor, message.attachments), message.id, false),
        refType: "message",
        refId: message.id,
      });
    }
    for (const d of answers) this.store.enqueue({ projectId, memberId: conductor.id, kind: "answer", text: formatAnswer(d), refType: "decision", refId: d.id });
    for (const t of todos) {
      this.store.enqueue({ projectId, memberId: conductor.id, kind: "todo_done", text: formatTodoDone(t), refType: "todo", refId: t.id });
      this.store.setTodoNoticePending(t.id, false);
    }
  }

  /** 실행이 켜진 프로젝트에서 총괄을 못 띄워 멈춘 말이 있으면 다시 시도한다. 실행기가 돌아오면 저절로 풀린다. */
  private async retryOrphans(): Promise<void> {
    if (this.closed) return;
    for (const project of this.store.listProjects()) {
      if (!project.runnerEnabled || this.store.getConductor(project.id)) continue;
      // 편입은 세션 하나를 넘겨준 것이다. 대표가 시키지 않은 총괄을 띄워 옛 지시를 실행하지 않는다.
      if (this.store.runnerByAdopt(project.id)) continue;
      if (this.orphanMessages(project.id).length + this.orphanAnswers(project.id).length + this.orphanTodos(project.id).length === 0) continue;
      await this.enableProject(project.id).catch((e) => console.warn(`${project.name} 총괄 띄우기 재시도 실패:`, (e as Error).message));
    }
  }

  /** 전달 항목이 없는 대표 메시지: 총괄이 없을 때 보류됐거나, 총괄을 띄우다 실패해 항목째 사라졌다. */
  private orphanMessages(projectId: string): Message[] {
    const linked = new Set(this.store.listUndelivered(projectId).map((d) => d.refId));
    return this.store
      .listMessages(projectId, { limit: 500 })
      .filter((m) => m.mine && (m.delivery === "held" || m.delivery === "queued") && !m.targetMemberId && !linked.has(m.id));
  }

  /** 답했는데 물은 직원이 없어(가져온 카드, 닫힌 직원) 아무에게도 가지 않은 결재. */
  private orphanAnswers(projectId: string): Decision[] {
    const linked = new Set(this.store.listUndelivered(projectId).map((d) => d.refId));
    return this.store.listAnsweredDecisions(projectId).filter((d) => !linked.has(d.id) && (!d.memberId || !this.store.getMember(d.memberId)));
  }

  private orphanTodos(projectId: string): Todo[] {
    return this.store.listTodoNoticesPending(projectId);
  }

  /** 실패한 글을 같은 id 로 다시 넣는다. 대화의 그 줄이 그대로 바뀌므로 지시가 둘로 늘지 않는다. */
  async resendMessage(existing: Message): Promise<Message> {
    if (existing.delivery !== "failed") return existing;
    const target = existing.targetMemberId ? this.store.getMember(existing.targetMemberId) : null;
    if (existing.targetMemberId && !target) throw new ApiError(409, "그 직원이 닫혀 다시 보낼 수 없습니다. 새 글로 보내세요");
    await this.refreshConnection();
    this.store.requireReachable(existing.projectId, target);
    this.store.setMessageDelivery(existing.id, "queued", null);
    return this.routeUserMessage(this.store.requireProject(existing.projectId), this.store.requireMessage(existing.id), existing.attachments, target);
  }

  async sendUserMessage(projectId: string, req: SendMessageReq): Promise<Message> {
    const project = this.store.requireProject(projectId);
    if (project.archived) throw new ApiError(409, "보관된 프로젝트에는 보낼 수 없습니다");
    const attachments = (req.attachmentIds ?? []).map((id) => this.store.getAttachment(id)).filter((a): a is Attachment => a !== null);
    const target = req.targetMemberId ? this.store.requireMember(req.targetMemberId) : null;
    if (target && target.projectId !== projectId) throw new ApiError(400, "이 프로젝트의 직원이 아닙니다");

    const message = this.store.createMessage({
      id: req.id,
      projectId,
      mine: true,
      who: "나",
      kind: "나",
      body: req.text,
      targetMemberId: target?.id ?? null,
      targetName: target?.name ?? null,
      attachments,
      delivery: "queued",
    });
    return this.routeUserMessage(project, message, attachments, target);
  }

  private async routeUserMessage(project: Project, message: Message, attachments: Attachment[], target: Member | null): Promise<Message> {
    const projectId = project.id;
    if (target) {
      const conductor = this.store.getConductor(projectId);
      if (conductor && conductor.id !== target.id) {
        this.store.enqueue({
          projectId,
          memberId: conductor.id,
          kind: "system",
          text: formatSystem(`대표가 ${target.name}에게 직접 지시했습니다 #${message.id}`),
          wake: false,
        });
      }
      await this.deliver({
        projectId,
        memberId: target.id,
        kind: "user_message",
        text: formatUserMessage(message.body, this.attachmentsFor(target, attachments), message.id, true),
        refType: "message",
        refId: message.id,
      });
      return this.store.requireMessage(message.id);
    }

    let conductor = this.store.getConductor(projectId);
    let booting: Promise<void> | null = null;
    if (!conductor) {
      if (!project.runnerEnabled) return this.store.setMessageDelivery(message.id, "held", HOLD_NOTES.runner_disabled);
      // 띄우기를 기다리기 전에 줄을 세운다. 그 사이 온 둘째 말이 첫째를 앞지르지 못한다.
      const spawn = this.beginConductor(project);
      conductor = spawn.member;
      booting = spawn.ready;
    }
    this.store.enqueue({
      projectId,
      memberId: conductor.id,
      kind: "user_message",
      text: formatUserMessage(message.body, this.attachmentsFor(conductor, attachments), message.id, false),
      refType: "message",
      refId: message.id,
    });
    if (booting) {
      // 실패해도 말은 잃지 않는다. 보류로 남겨 실행기가 돌아오면 다시 띄운다.
      await booting.catch((e) => console.warn(`${project.name} 총괄을 띄우지 못했습니다:`, (e as Error).message));
    }
    await this.pump(conductor.id);
    return this.store.requireMessage(message.id);
  }

  /** 첨부를 그 직원의 폴더로 잇는다. herdr 칸은 이 폴더만 승인 없이 읽고, 다른 프로젝트의 첨부는 열지 않는다. */
  private attachmentsFor(member: Member, attachments: Attachment[]): Attachment[] {
    if (attachments.length === 0) return attachments;
    const dir = join(this.config.home, "inbox", member.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return attachments.map((a) => {
      // 전에 올라온 첨부의 이름에는 위험한 글자가 남아 있을 수 있다. 전달 글에 들어가는 경로는 이 이름으로 만든다.
      const dest = join(dir, `${a.id}-${sanitizeName(a.name)}`);
      try {
        if (!existsSync(dest)) {
          try {
            linkSync(a.path, dest);
          } catch {
            copyFileSync(a.path, dest);
          }
        }
        return { ...a, path: dest };
      } catch {
        return a; // 원본이 사라졌으면 그대로 알린다. 읽는 쪽에서 오류가 보인다.
      }
    });
  }

  async answerDecision(decisionId: string, req: AnswerReq): Promise<Decision> {
    const { decision, changed } = this.store.answerDecision(decisionId, req);
    if (!changed) return decision;
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    let conductor = this.store.getConductor(decision.projectId);
    if (!asker && !conductor && this.store.requireProject(decision.projectId).runnerEnabled && !this.store.runnerByAdopt(decision.projectId)) {
      // 받을 사람이 없으면 답이 영영 멈춘다. 못 띄우면 틱이 다시 시도한다.
      conductor = await this.ensureConductor(decision.projectId).catch((e) => {
        console.warn("결재 답을 받을 총괄을 띄우지 못했습니다:", (e as Error).message);
        return null;
      });
    }
    const recipient = asker ?? conductor;

    if (asker?.origin === "manual") {
      // 직접 띄운 CLI 는 롱폴이나 다음 wait 로 받는다.
      this.wakeAll(this.askWaiters, decisionId);
    } else if (recipient) {
      await this.deliver({
        projectId: decision.projectId,
        memberId: recipient.id,
        kind: "answer",
        text: formatAnswer(decision),
        refType: "decision",
        refId: decision.id,
      });
    }
    if (conductor && recipient && conductor.id !== recipient.id) {
      await this.deliver({
        projectId: decision.projectId,
        memberId: conductor.id,
        kind: "system",
        text: formatSystem(`대표가 ${decision.who}의 결재에 답했습니다.\n${formatAnswer(decision)}`),
        wake: false,
      });
    }
    return this.store.requireDecision(decisionId);
  }

  async setTodoDone(todoId: string, done: boolean): Promise<Todo> {
    const { todo, changed } = this.store.setTodoDone(todoId, done);
    if (!changed) return todo;
    const requester = todo.memberId ? this.store.getMember(todo.memberId) : null;
    if (!done) {
      this.store.setTodoNoticePending(todo.id, false);
      // 아직 안 나간 글은 거둔다. 마지막으로 실제 나간 글이 '했음'이면 끝난 일로 알고 있으니 바로잡는다.
      const lastTold = this.store.lastDeliveredTextFor("todo", todo.id);
      this.store.cancelPendingFor("todo", todo.id);
      const conductor = this.store.getConductor(todo.projectId);
      const target = requester ?? conductor;
      if (lastTold !== null && lastTold !== formatTodoUndone(todo) && target) {
        await this.deliver({ projectId: todo.projectId, memberId: target.id, kind: "todo_done", text: formatTodoUndone(todo), refType: "todo", refId: todo.id });
      }
      return todo;
    }
    let recipient = requester ?? this.store.getConductor(todo.projectId);
    if (!recipient && this.store.requireProject(todo.projectId).runnerEnabled && !this.store.runnerByAdopt(todo.projectId)) {
      recipient = await this.ensureConductor(todo.projectId).catch((e) => {
        console.warn("할 일 완료를 받을 총괄을 띄우지 못했습니다:", (e as Error).message);
        return null;
      });
    }
    if (recipient) {
      await this.deliver({ projectId: todo.projectId, memberId: recipient.id, kind: "todo_done", text: formatTodoDone(todo), refType: "todo", refId: todo.id });
    } else {
      this.store.setTodoNoticePending(todo.id, true);
    }
    return todo;
  }

  async memberSleep(memberId: string, opts: { force?: boolean } = {}): Promise<Member> {
    return this.sleepMember(memberId, opts);
  }

  async memberResume(memberId: string): Promise<Member> {
    return this.resumeMember(memberId);
  }

  async memberCompact(memberId: string): Promise<Member> {
    return this.compactMember(memberId);
  }

  async memberInterrupt(memberId: string): Promise<Member> {
    const member = this.store.requireMember(memberId);
    const rt = this.runtime(memberId);
    const project = this.store.requireProject(member.projectId);
    const runner = this.runners.get(this.backendOf(member));
    if (member.origin === "manual" || !runner) throw new ApiError(400, "실행기가 관리하지 않는 세션입니다");
    if (rt.turn) rt.turn.interrupted = true;
    await runner.interrupt(this.runnerMember(member, project));
    return this.store.requireMember(memberId);
  }

  /** 화면의 '명부에서 빼기'. 직접 띄운 세션만. 실행기 세션은 총괄이 team_close 로 닫는다. */
  async memberClose(memberId: string): Promise<void> {
    const member = this.store.requireMember(memberId);
    if (member.origin !== "manual") throw new ApiError(400, "직접 띄운 세션만 여기서 뺄 수 있습니다");
    const { projectId, name } = member;
    const dropped = await this.closeMember(memberId);
    const conductor = this.store.getConductor(projectId);
    // 총괄이 보낸 지시가 안 나간 채 사라졌다. 도구 응답을 받을 사람이 없으니 알린다.
    if (conductor && dropped.length > 0) {
      await this.deliver({ projectId, memberId: conductor.id, kind: "system", text: formatSystem(`대표가 ${josa(name, "을")} 명부에서 뺐습니다. 나가지 않은 입력 ${dropped.length}건: ${dropped.join(" / ")}`), wake: false });
    }
  }

  async memberScreen(memberId: string): Promise<string> {
    const member = this.store.requireMember(memberId);
    if (this.runtime(memberId).closing) return ""; // 빠지는 중이다. 화면을 읽으려고 칸을 다시 묶지 않는다.
    const project = this.store.requireProject(member.projectId);
    return (await this.runners.get(this.backendOf(member))?.screen(this.runnerMember(member, project))) ?? "";
  }

  async memberApproval(memberId: string): Promise<ApprovalPrompt | null> {
    const member = this.store.requireMember(memberId);
    if (this.runtime(memberId).closing) return null;
    const runner = this.runners.get(this.backendOf(member));
    if (!runner?.approval) return null;
    return runner.approval(this.runnerMember(member, this.store.requireProject(member.projectId)));
  }

  /**
   * 대표가 승인 창의 선택지를 고른다. 대표 화면(HTTP)에서만 부른다. 총괄·직원의 도구에는 없다: AI 가 자기 일을 스스로 승인하면 안 된다.
   * 실행기가 누르기 직전 창을 다시 읽어 대표가 본 창과 같을 때만 누른다. 거절하며 남긴 말은 대표가 직원에게 직접 보낸 글로 넣는다.
   */
  async answerApproval(memberId: string, req: AnswerApprovalReq): Promise<void> {
    const member = this.store.requireMember(memberId);
    const runner = this.runners.get(this.backendOf(member));
    if (!runner?.answerApproval) throw new ApiError(501, "이 실행 방식에는 승인 창이 없습니다");
    const project = this.store.requireProject(member.projectId);
    const r = await runner.answerApproval(this.runnerMember(member, project), req.fingerprint, req.option);
    if (!r.ok) {
      const why = {
        not_blocked: "승인 창 앞이 아닙니다. 이미 풀렸을 수 있습니다",
        unrecognized: "승인 창으로 읽히지 않는 창입니다. 터미널에서 푸세요",
        changed: "창이 바뀌었습니다. 새 창을 보고 다시 고르세요",
        no_option: "그 번호의 선택지가 없습니다",
        no_effect: "키를 눌렀지만 창이 그대로입니다. 터미널에서 확인하세요",
        gone: "칸을 찾지 못했습니다",
      }[r.reason];
      throw new ApiError(r.reason === "no_option" ? 400 : 409, why);
    }
    this.store.appendActivity(member.id, "system", `대표가 승인 창에서 ${r.chosen.n}번 '${r.chosen.label}' 을 골랐습니다 · ${approvalSummary(r.prompt, 200)}`);
    const note = req.note?.trim();
    if (r.chosen.reject && note) await this.sendUserMessage(member.projectId, { text: note, targetMemberId: member.id });
  }

  async herdrInfo(): Promise<HerdrInfo> {
    const fallback: HerdrInfo = { installed: false, running: false, version: null, protocol: null, compatible: false, warning: null };
    if (!this.herdr) return fallback;
    return this.herdr.info().catch((e: Error) => ({ ...fallback, warning: e.message }));
  }

  async herdrAgents(): Promise<LiveAgent[]> {
    if (!this.herdr) return [];
    const members = this.store.listAllMembers();
    const adopted = new Set(members.map((m) => m.paneId));
    // 잠든 직원의 세션을 대표가 터미널에서 연 칸은 이미 있는 직원이다. 다른 직원으로 받으면 깨울 때 한 칸에 둘이 묶인다.
    const sessions = new Set(members.map((m) => m.sessionId).filter(Boolean));
    return (await this.herdr.agents()).map((a) => ({ ...a, adopted: a.adopted || adopted.has(a.paneId) || (!!a.sessionId && sessions.has(a.sessionId)) }));
  }

  cliCommand(): string {
    return cliCommand();
  }

  /** 편입 전 화면에 보여 줄 것. 읽기만 한다. 경고는 막지 않고, refuse 만 막는다. */
  async adoptPreview(projectId: string, paneId: string): Promise<AdoptPreview> {
    const project = this.store.requireProject(projectId);
    const live = (await this.herdrAgents()).find((a) => a.paneId === paneId);
    if (!live) throw new ApiError(404, "그 칸을 찾을 수 없습니다");
    const seen = await this.herdr?.inspect?.(live).catch(() => null);
    return {
      paneId,
      name: live.name,
      cwd: live.cwd,
      status: live.status,
      sessionId: live.sessionId,
      screen: seen?.screen ?? "",
      refuse: adoptRefusal(live) ?? (seen?.inputEmpty === null ? NO_INPUT_BOX : null),
      warnings: adoptWarnings(project, live, seen ?? null),
    };
  }

  /** 사용자가 화면에서 눌렀을 때만 온다(§6). 규칙은 시스템 프롬프트에 없으므로 첫 지시로 보낸다. */
  async adopt(projectId: string, req: AdoptReq): Promise<Member> {
    const project = this.store.requireProject(projectId);
    this.requireActive(project);
    const live = (await this.herdrAgents()).find((a) => a.paneId === req.paneId);
    if (!live) throw new ApiError(404, "그 칸을 찾을 수 없습니다");
    if (this.store.getMemberByPane(req.paneId)) throw new ApiError(409, "이미 등록된 칸입니다");
    const sameSession = live.sessionId ? this.store.getMemberBySession(live.sessionId) : null;
    if (sameSession) throw new ApiError(409, `이 세션은 이미 ${sameSession.name} 자리입니다. 그 직원을 깨우거나 터미널 칸을 닫으세요`);
    // 실행기는 claude 세션만 다룰 수 있다. 일하는 중·승인 창 앞이면 규칙이 턴 중간에 끼어들고, 쓰던 턴의 마지막 글이 보고로 나간다.
    const refusal = adoptRefusal(live);
    if (refusal) throw new ApiError(409, refusal);
    if ((await this.herdr?.inspect?.(live).catch(() => null))?.inputEmpty === null) throw new ApiError(409, NO_INPUT_BOX);
    const kind = req.kind ?? "worker";
    if (kind === "conductor" && this.store.getConductor(projectId)) throw new ApiError(409, "이미 총괄이 있습니다");
    // 실행 방식은 전체 설정 하나다. 편입은 칸이 있어야 하므로 herdr 일 때만 된다.
    this.requireNotSwitching();
    if (this.store.getSettings().backend !== "herdr") throw new ApiError(409, "실행 방식이 herdr 일 때만 편입할 수 있습니다. 설정에서 실행 방식을 먼저 바꾸세요");
    const runner = this.runners.get("herdr") as HerdrCapable | undefined;
    if (!runner) throw new ApiError(503, "herdr 실행기가 없습니다");
    const turnedOnRunner = !project.runnerEnabled;
    const herdrProject = project.runnerEnabled ? project : this.store.patchProject(projectId, { runnerEnabled: true });
    if (turnedOnRunner) this.store.setRunnerByAdopt(projectId, true);
    // 가져온 명부에 같은 직원이 있으면(칸 없는 offline) 그 자리를 잇는다. 새로 만들면 이름이 겹쳐 거부된다.
    const placeholder = [req.handle, req.name]
      .map((ref) => (ref ? this.store.findMember(projectId, ref) : null))
      .find((m) => m && m.origin === "adopted" && m.kind === kind && m.status === "offline" && !m.paneId && !m.sessionId);
    const placed = { status: "idle", backend: "herdr", cwd: live.cwd ?? project.cwd, sessionId: live.sessionId, paneId: req.paneId } as const;
    let member: Member | undefined;
    try {
      member = placeholder
        ? this.store.patchMember(placeholder.id, { name: req.name, role: req.role, ...placed })
        : this.store.createMember({ projectId, handle: req.handle ?? this.deriveHandle(projectId, req.name), name: req.name, role: req.role, kind, origin: "adopted", ...placed });
      const moved = await runner.adopt(this.runnerMember(member, herdrProject), req.paneId, this.writeRunFiles(member, herdrProject));
      // 넘겨받은 세션은 대표가 쓰던 그대로 둔다. 무슨 모델로 도는지 모르고, 설정은 잠재웠다 깨울 때 전체 인자로 들어간다.
      this.applyStarted(member.id, herdrProject, { ...moved, rejoined: true });
    } catch (e: unknown) {
      if (member) {
        if (placeholder) this.store.patchMember(member.id, { status: "offline", sessionId: null, paneId: null, backend: null });
        else this.store.removeMember(member.id);
      }
      // 거부된 편입이 실행을 켠 채 남기면 다음 대표 말에 총괄이 뜬다.
      if (turnedOnRunner) {
        this.store.patchProject(projectId, { runnerEnabled: false });
        this.store.setRunnerByAdopt(projectId, false);
      }
      if (e instanceof ApiError) throw e;
      if (e instanceof HerdrError && e.code === "cannot_adopt") throw new ApiError(409, e.message);
      throw new ApiError(502, `칸을 넘겨받지 못했습니다: ${(e as Error).message}`);
    }
    this.store.setAdoptedInfo(member.id, { turnedOnRunner });
    const conductorName = this.store.getConductor(projectId)?.name ?? "총괄";
    await this.deliver({
      projectId,
      memberId: member.id,
      kind: "system",
      text: formatSystem(`지금부터 이 세션은 '${project.name}'의 ${conductorName} 지휘를 받습니다. 아래 규칙을 이 대화 끝까지 따르세요. 단, 이 세션에는 iamceo 도구(post·ask·status·file·todo)가 연결되어 있지 않으니 찾지 말고, 보고와 질문은 턴 마지막 글로 하세요. 서버가 그 글을 총괄에게 전합니다. 이 세션의 CLAUDE.md·메모리 규칙과 아래 규칙이 부딪히면 임의로 고르지 말고 턴 마지막 글로 알리세요.\n\n${this.rulesFor(member, project)}`),
    });
    return this.store.requireMember(member.id);
  }

  /**
   * 편입 해제: 대화와 세션은 그대로 두고 관리에서 뺀다. 되돌릴 수 있어야 하므로 다시 편입할 수 있다.
   * 대표의 칸이면 칸을 그대로 두고 규칙이 풀렸다고 알린다. 다시 열어 서버 칸에 있으면 그 칸을 닫고 이어 열 명령을 돌려준다.
   */
  async releaseMember(memberId: string): Promise<ReleaseResult> {
    const member = this.store.requireMember(memberId);
    if (!member.wasAdopted || member.kind !== "worker") throw new ApiError(400, "편입한 직원만 해제할 수 있습니다");
    const project = this.store.requireProject(member.projectId);
    let notified = false;
    const paneKept = member.origin === "adopted";
    // 칸에 알리는 동안 전달과 화면 조회가 칸을 다시 묶거나 알림과 겹치지 않게 먼저 막는다.
    this.runtime(memberId).closing = true;
    if (paneKept) notified = (await this.releasePane(member, project)).notified;
    const dropped = await this.closeMember(memberId, { paneDone: paneKept });
    // 편입이 켠 실행이고 남은 세션이 없으면 편입 전으로 돌린다. 칸도 세션도 없는 명부 행은 세션이 아니다.
    if (this.store.runnerByAdopt(project.id) && !this.store.listMembers(project.id).some((m) => m.origin !== "manual" && (m.kind === "conductor" || m.sessionId || m.paneId))) {
      this.store.patchProject(project.id, { runnerEnabled: false });
      this.store.setRunnerByAdopt(project.id, false);
    }
    this.systemMessage(project.id, `${josa(member.name, "을")} 편입 해제했습니다. 세션과 대화 기록은 그대로입니다`);
    const conductor = this.store.getConductor(project.id);
    if (conductor) await this.deliver({ projectId: project.id, memberId: conductor.id, kind: "system", text: formatSystem(`대표가 ${josa(member.name, "을")} 편입 해제했습니다. 이제 지시할 수 없습니다.${dropped.length ? ` 나가지 않은 입력 ${dropped.length}건: ${dropped.join(" / ")}` : ""}`), wake: false });
    const resumeCommand = !paneKept && member.sessionId ? `cd ${shellQuote(member.cwd)} && claude --resume ${shellQuote(member.sessionId)}` : null;
    return { notified, paneKept, resumeCommand };
  }

  private async releasePane(member: Member, project: Project): Promise<{ notified: boolean }> {
    const runner = this.runners.get("herdr") as HerdrCapable | undefined;
    if (!runner?.release) return { notified: false };
    await this.runtime(member.id).pumping; // 이미 나가는 전달이 있으면 끝을 본다. 그 턴 중이면 알리지 않는다.
    const notice = formatSystem("이 세션은 IAMCEO 관리에서 빠졌습니다. 앞서 받은 IAMCEO 운영 규칙은 이제 따르지 않아도 되고 보고도 하지 않아도 됩니다. 이 글에 짧게 알았다고만 답하세요.");
    return runner.release(this.runnerMember(member, project), notice).catch((e) => {
      console.warn(`${member.name} 편입 해제 중 칸에 알리지 못했습니다:`, (e as Error).message);
      return { notified: false };
    });
  }

  /** 넘겨받은 세션에 도구를 붙인다: 칸에서 세션을 끝내고(칸은 셸로 남는다) 전체 인자로 프로젝트 탭에 다시 연다. 기록은 이어진다. */
  async reopenWithTools(memberId: string): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.origin !== "adopted") throw new ApiError(400, "넘겨받은 세션만 다시 열 수 있습니다");
    this.requireActive(this.store.requireProject(member.projectId));
    if (member.status === "working" || member.status === "blocked" || this.isBusy(member)) throw new ApiError(409, `${josa(member.name, "은")} 일하는 중입니다. 턴이 끝난 뒤 다시 시도하세요`);
    if (member.status !== "asleep" && member.status !== "offline") await this.sleepMember(memberId, { force: true });
    return this.resumeMember(memberId);
  }

  async listAgentTools(member: Member): Promise<AgentToolDef[]> {
    return (await this.tools()).listAgentTools(member);
  }

  async handleAgentTool(member: Member, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> {
    return (await this.tools()).handleAgentTool(this, member, name, args, signal);
  }

  private async tools(): Promise<AgentToolsImpl> {
    // agent-tools.ts 가 이 파일의 타입을 쓰므로 정적 import 로 순환시키지 않는다.
    this.agentTools ??= await import("./agent-tools.ts");
    return this.agentTools;
  }

  async askWait(member: Member, decisionId: string, timeoutMs: number, signal?: AbortSignal): Promise<AskWaitResult> {
    const ready = (): AskWaitResult | null => {
      const decision = this.store.requireDecision(decisionId);
      if (decision.status === "open") return null;
      const answered = decision.status === "answered" || decision.status === "delivered";
      const text = answered ? formatAnswer(decision) : formatSystem(`결재가 닫혔습니다${decision.closeReason ? `: ${normalizeSpace(decision.closeReason)}` : ""}. 이 질문의 답은 오지 않습니다 #${decision.id}`);
      if (decision.status === "answered") this.store.setDecisionStatus(decisionId, "delivered");
      this.settle(this.store.requireMember(member.id));
      return { done: true, text, decision: this.store.requireDecision(decisionId) };
    };
    const now = ready();
    if (now) return now;
    await this.waitOn(this.askWaiters, decisionId, timeoutMs, signal);
    // 끊긴 연결로 답을 넘기면 받은 줄 알고 사라진다. 다음 wait 가 받게 둔다.
    if (signal?.aborted) return { done: false };
    return ready() ?? { done: false };
  }

  // ---- 팀 ----
  /** 총괄·본사 AI 를 찾거나 만든다. 본사는 root. */
  async ensureConductor(projectId: string): Promise<Member> {
    this.requireActive(this.store.requireProject(projectId));
    const existing = this.store.getConductor(projectId);
    if (existing) {
      // 다른 요청이 띄우는 중이면 함께 기다린다.
      await this.runtime(existing.id).starting;
      return this.store.getConductor(projectId) ?? this.ensureConductor(projectId);
    }
    const spawn = this.beginConductor(this.store.requireProject(projectId));
    await spawn.ready;
    return this.store.requireMember(spawn.member.id);
  }

  private beginConductor(project: Project): { member: Member; ready: Promise<void> } {
    // 대표가 총괄을 시작했거나 말을 보냈다. 이제 편입만으로 켠 실행이 아니다.
    this.store.setRunnerByAdopt(project.id, false);
    // 예약 이름을 막기 전에 만들어진 명부에 같은 이름·핸들의 직원이 있어도 총괄은 떠야 한다.
    const free = (base: string, sep: string): string => {
      if (!this.store.findMember(project.id, base)) return base;
      for (let n = 2; ; n++) if (!this.store.findMember(project.id, `${base}${sep}${n}`)) return `${base}${sep}${n}`;
    };
    const spawn = this.beginSpawn(project, {
      kind: project.isHq ? "root" : "conductor",
      handle: free(project.isHq ? "root" : conductorHandle(project.name), "-"),
      name: free(project.isHq ? "본사 AI" : conductorName(project.name), " "),
      role: project.isHq ? "프로젝트 만들기와 잡다한 일" : "총괄",
    });
    if (project.now) {
      this.store.enqueue({ projectId: project.id, memberId: spawn.member.id, kind: "system", text: formatSystem(`지금 상황: ${guardLines(project.now)}`), wake: false });
    }
    return spawn;
  }

  async addMember(projectId: string, input: NewMemberInput): Promise<{ member: Member; assigned: AssignResult | null }> {
    const project = this.store.requireProject(projectId);
    if (!project.runnerEnabled) throw new ApiError(409, "이 프로젝트는 실행이 꺼져 있습니다");
    const name = input.name.trim();
    if (!name) throw new ApiError(400, "이름이 필요합니다");
    const { member, ready } = this.beginSpawn(project, {
      kind: input.kind ?? "worker",
      handle: input.handle ?? this.deriveHandle(projectId, name),
      name,
      role: input.role ?? "",
      cwd: input.cwd ? this.resolveCwd(project, input.cwd) : undefined,
    });
    await ready;
    if (input.parallel) this.runtime(member.id).wantParallel = true;
    const assigned = input.firstInstruction ? await this.assign(projectId, member.handle, { text: input.firstInstruction, userQuote: input.userQuote, parallel: input.parallel }) : null;
    this.checkAwakeLimit(projectId);
    return { member: this.store.requireMember(member.id), assigned };
  }

  /** 명부에 올리고 세션을 띄우기 시작한다. 끝나기 전에는 pump 가 건너뛰고, 끝나면 다시 민다. */
  private beginSpawn(project: Project, input: { kind: MemberKind; handle: string; name: string; role: string; cwd?: string }): { member: Member; ready: Promise<void> } {
    this.requireNotSwitching(); // 옮기는 명단에 없는 칸이 옛 실행기에 남는다.
    const member = this.store.createMember({ projectId: project.id, ...input, origin: "runner", status: "idle" });
    if (!project.runnerEnabled) return { member, ready: Promise.resolve() };
    const rt = this.runtime(member.id);
    const ready = (async () => {
      const runner = this.openRunner(member);
      const sent = this.desiredConfig(member);
      const started = await runner.start(this.runnerMember(member, project), this.writeRunFiles(member, project));
      this.applyStarted(member.id, project, started, sent);
    })().catch((e) => {
      this.abandonSpawn(member.id);
      throw new ApiError(502, `세션을 띄우지 못했습니다: ${(e as Error).message}`);
    });
    rt.starting = ready.then(
      () => {
        rt.starting = null;
        void this.pump(member.id);
      },
      () => {
        rt.starting = null;
      },
    );
    return { member, ready };
  }

  /** 명부에서 빼기 전에 그 직원 앞으로 줄 선 대표의 말을 보류로 남긴다(CASCADE 로 전달 항목이 사라진다). */
  private abandonSpawn(memberId: string): void {
    for (const d of this.store.listPending(memberId)) {
      if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "held", HOLD_NOTES.backend_down);
    }
    const rt = this.runtimes.get(memberId);
    if (rt) this.clearRuntime(memberId, rt);
    this.store.removeMember(memberId);
  }

  /** sent 는 start 에 실제로 넘긴 설정이다. 띄우는 동안 바뀐 값을 적으면 옛 값으로 돌면서 맞춘 것으로 기록된다. */
  private applyStarted(memberId: string, project: Project, started: { sessionId: string | null; paneId: string | null; tabId?: string | null; rejoined?: boolean }, sent?: AppliedConfig): void {
    this.store.patchMember(memberId, { sessionId: started.sessionId, paneId: started.paneId });
    // 이미 떠 있던 칸에 붙었으면 이번 인자가 들어간 것이 아니다.
    if (!started.rejoined && sent) this.store.setAppliedConfig(memberId, sent);
    if (started.tabId && started.tabId !== project.herdrTabId) this.store.patchProject(project.id, { herdrTabId: started.tabId });
  }

  private resolveCwd(project: Project, raw: string): string {
    const path = isAbsolute(raw) ? raw : resolve(project.cwd, raw);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      // 없는 경로는 아래에서 같은 오류로 처리한다.
    }
    if (!isDir) throw new ApiError(400, `폴더가 없습니다: ${path}`);
    return path;
  }

  private deriveHandle(projectId: string, name: string): string {
    const ascii = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32);
    if (ascii && !RESERVED_HANDLES.has(ascii) && !this.store.getMemberByHandle(projectId, ascii)) return ascii;
    for (let n = 1; ; n++) {
      const handle = `w${n}`;
      if (!this.store.getMemberByHandle(projectId, handle)) return handle;
    }
  }

  /** team_assign. member 는 핸들 또는 화면 이름. 다른 프로젝트 직원은 찾지 못한다. */
  async assign(projectId: string, memberRef: string, input: AssignInput): Promise<AssignResult> {
    const target = this.requireInProject(projectId, memberRef);
    // 마지막 지시가 이긴다. 현재값과 같으면 앞서 대기 중인 반대 지시를 지워야 한다(같으면 applyParallel 이 아무것도 안 한다).
    if (input.parallel !== undefined) this.runtime(target.id).wantParallel = input.parallel;
    const source = input.userQuote?.trim() ? this.findQuoteSource(projectId, input.userQuote) : null;
    const quote = input.userQuote?.trim() ? { text: input.userQuote, verified: source !== null, source } : null;
    const project = this.store.requireProject(projectId);
    const busy = this.isBusy(target);
    const attachments = (input.attachmentIds ?? []).map((id) => {
      const attachment = this.store.getAttachment(id);
      if (!attachment || !this.store.isProjectAttachment(projectId, id)) throw new ApiError(404, `이 프로젝트에서 대표가 보낸 첨부가 아닙니다: ${id}`);
      return attachment;
    });
    const delivery = this.store.enqueue({
      projectId,
      memberId: target.id,
      kind: "instruction",
      text: [formatInstruction(target.name, input.text, quote), ...attachmentLines(this.attachmentsFor(target, attachments))].join("\n"),
      urgent: input.urgent,
    });
    const position = busy ? this.store.listPending(target.id).length : 0;
    await this.pump(target.id);
    return { delivery: this.store.requireDelivery(delivery.id), position, verified: quote?.verified ?? null, needsContext: quote ? quoteNeedsContext(quote) : false };
  }

  /**
   * 인용이 이 프로젝트의 대표 메시지·결재 답에 (공백 정규화 후) 그대로 있으면 그 글. 총괄의 말은 승인이 아니다.
   * 직원에게 전문·시각·카드 제목을 함께 보내 잘린 인용이나 다른 안건의 답으로 뜻이 뒤집히지 않게 한다.
   */
  findQuoteSource(projectId: string, rawQuote: string): QuoteSource | null {
    const quote = normalizeSpace(rawQuote).replace(/^["'“”‘’](.*)["'“”‘’]$/, "$1").trim();
    if (!quote) return null;
    // "네" 같은 짧은 인용은 다른 글의 일부로 우연히 맞는다. 글 전체가 같아야 한다.
    const matches = (source: string): boolean => {
      const text = normalizeSpace(source);
      return quote.length < SHORT_QUOTE ? text === quote : includesWhole(text, quote);
    };
    for (const d of this.store.listAllDoneDecisions(projectId)) {
      const option = d.options.find((o) => o.k === d.choice);
      // 버튼 글은 대표가 보고 누른 그대로만 친다. 설명·버튼 글의 일부는 직원이 쓴 글이라 대표의 말이 아니다.
      if (option && normalizeSpace(option.label) === quote) return { id: d.id, text: option.label, at: d.answeredAt, card: d.title };
      if (d.note && matches(d.note)) return { id: d.id, text: d.note, at: d.answeredAt };
    }
    let before: string | undefined;
    for (let page = 0; page < QUOTE_SCAN_PAGES; page++) {
      const messages = this.store.listMessages(projectId, { before, limit: 500 });
      const found = [...messages].reverse().find((m) => m.mine && matches(m.body));
      if (found) return { id: found.id, text: found.body, at: found.at };
      if (messages.length < 500) return null;
      before = messages[0]!.at;
    }
    return null;
  }

  /** team_compact·화면 압축. 일하는 중이면 끊지 않고 끝난 뒤로 미룬다. */
  async compactMember(memberId: string, focus?: string): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 압축할 수 없습니다");
    if (!member.sessionId) throw new ApiError(400, "아직 세션이 없습니다");
    if (member.status === "asleep") throw new ApiError(409, "잠든 직원은 압축할 수 없습니다");
    // 입력칸에 그대로 들어간다. 제어문자·줄바꿈이 있으면 붙여넣기를 끝내고 입력을 고칠 수 있다.
    this.runtime(memberId).compactRequest = (focus ? normalizeSpace(focus) : "") || this.compactFocus(member);
    await this.pump(memberId);
    return this.store.requireMember(memberId);
  }

  private compactFocus(member: Member): string {
    const questions = this.store.listOpenDecisionsByMember(member.id).map((d) => normalizeSpace(d.title));
    const queue = this.store.listPending(member.id).slice(0, 3).map((d) => normalizeSpace(d.text).slice(0, 80));
    const board =
      member.kind === "worker"
        ? ""
        : this.store
            .listWork(member.projectId)
            .filter((w) => w.sec !== "done")
            .slice(0, 12)
            .map((w) => `${w.id} ${w.sec} ${normalizeSpace(w.title).slice(0, 40)}`)
            .join(", ");
    const parts = [normalizeSpace(member.now), normalizeSpace(member.next), questions.length ? `대기 질문: ${questions.join(", ")}` : "", queue.length ? `대기열 앞부분: ${queue.join(" / ")}` : "", board ? `일 항목: ${board}` : ""].filter(Boolean);
    return `이어갈 일: ${parts.join(" · ") || "대표의 말과 결정, 지금까지 한 일을 빠짐없이 남긴다"}`;
  }

  /** 일하는 중·열린 결재·대기열이 있으면 거부(force 로만). sessionId 는 유지한다. */
  async sleepMember(memberId: string, opts: { force?: boolean; holdAs?: "archived" } = {}): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.status === "asleep") return member;
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 잠재울 수 없습니다");
    const project = this.store.requireProject(member.projectId);
    const rt = this.runtime(memberId);
    const pending = this.store.listPending(memberId);
    if (!opts.force) {
      if (this.isBusy(member)) throw new ApiError(409, `${josa(member.name, "은")} 일하는 중입니다`);
      if (this.store.listOpenDecisionsByMember(memberId).length > 0) throw new ApiError(409, `${member.name}에게 열린 결재가 있습니다`);
      if (pending.length > 0) throw new ApiError(409, `${member.name}의 대기열이 남아 있습니다`);
    }
    // 넘겨받은 칸은 대표의 것이라 선택 창·승인 창이 떠 있으면 끝내지 않는다(입력칸에 남은 글은 지우고 끝낸다). 먼저 해 보고, 안 되면 아무것도 바꾸지 않고 이유를 돌려준다.
    const adopted = member.origin === "adopted";
    if (adopted) {
      const runner = this.runnerOf(member);
      const target = this.runnerMember(member, project);
      try {
        // 끊기 전에 본다. Esc 는 대표의 승인 창을 취소하고, 선택 창이 떠 있으면 끊고도 끝낼 수 없다. 승인 창은 force 여도 대표가 푼다.
        if (opts.force && (this.isBusy(member) || member.status === "blocked")) {
          await runner.checkStop?.(target, { whileWorking: true });
          if (member.status !== "blocked") await runner.interrupt(target);
        }
        await runner.stop(target);
      } catch (e) {
        if (e instanceof HerdrError && e.code === "cannot_exit") throw new ApiError(409, e.message);
        throw e;
      }
    }
    if (rt.turn) rt.turn.interrupted = true;
    rt.compactRequest = null;
    this.store.patchMember(memberId, { status: "asleep", subagents: 0 });
    for (const d of pending) this.hold(d, opts.holdAs ?? "asleep");
    if (!adopted) await this.runnerOf(member).stop(this.runnerMember(member, project));
    // 닫힌 번호를 들고 있으면 나중에 같은 번호의 다른 칸을 자기 칸으로 착각한다.
    if (member.paneId) this.store.patchMember(memberId, { paneId: null });
    // herdr 는 칸을 닫을 뿐 turn_end 를 내지 않는다. 턴을 비우지 않으면 깨운 뒤 전달이 영영 막힌다.
    if (rt.compactTimer) clearTimeout(rt.compactTimer);
    rt.compactTimer = null;
    if (rt.turn) {
      rt.turn = null;
      this.releaseSlots();
    }
    return this.store.requireMember(memberId);
  }

  /** --resume 으로 다시 연다. 실패하면 같은 핸들로 새 세션을 띄우고 마지막 일을 첫 지시에 넣는다. */
  async resumeMember(memberId: string, firstInstruction?: string): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 다시 열 수 없습니다");
    this.requireActive(this.store.requireProject(member.projectId));
    this.requireNotSwitching();
    if (member.status === "asleep" || member.status === "offline") {
      // 가져온 프로젝트는 총괄을 시작하거나 편입하기 전에는 어떤 세션도 움직이지 않는다고 약속했다.
      if (!this.store.requireProject(member.projectId).runnerEnabled) throw new ApiError(409, "이 프로젝트는 실행이 꺼져 있습니다. 총괄을 시작하거나 기존 세션을 편입하세요");
      const reopened = await this.reopen(member);
      if (!reopened) {
        const why = this.store.requireMember(memberId).lastError;
        throw new ApiError(502, `${josa(member.name, "을")} 다시 열지 못했습니다${why ? `: ${why}` : ""}`);
      }
      this.checkAwakeLimit(member.projectId);
    }
    if (firstInstruction?.trim()) {
      await this.assign(member.projectId, member.handle, { text: firstInstruction });
    } else {
      await this.pump(memberId);
    }
    return this.store.requireMember(memberId);
  }

  /** 깨우기와 전달 펌프가 함께 불러도 세션은 하나만 연다. */
  private reopen(member: Member): Promise<Member | null> {
    const rt = this.runtime(member.id);
    rt.reopening ??= this.reopenOnce(member).finally(() => {
      rt.reopening = null;
    });
    return rt.reopening;
  }

  private async reopenOnce(member: Member): Promise<Member | null> {
    const project = this.store.requireProject(member.projectId);
    const runner = this.openRunner(member);
    try {
      const sent = this.desiredConfig(member);
      const started = await runner.start(this.runnerMember(member, project), this.writeRunFiles(member, project, !!member.sessionId));
      if (await this.dropIfClosed(member, project, runner, started)) return null;
      this.applyStarted(member.id, project, started, sent);
      // 넘겨받은 세션도 서버가 다시 띄우면 도구와 규칙을 갖고 뜬다. 이제 서버가 띄운 세션과 같다.
      // 대표가 칸에서 그 세션을 다시 열어 거기 붙었으면(rejoined) 도구가 없는 그대로다.
      if (member.origin === "adopted" && !started.rejoined) {
        this.store.patchMember(member.id, { origin: "runner" });
        this.store.enqueue({ projectId: project.id, memberId: member.id, kind: "system", text: formatSystem("이제 이 세션에 iamceo 도구(post·ask·status·file·todo)가 연결되었습니다. 앞서 받은 '도구가 없다'는 안내는 취소입니다. 보고와 질문은 도구로 하세요."), wake: false });
      }
    } catch (e) {
      const message = (e as Error).message;
      // 잠깐의 시간 초과·소켓 끊김으로 멀쩡한 세션을 버리면 직원이 맥락을 잃는다. 세션이 정말 없을 때만 새로 연다.
      const missing = isMissingSessionError(message) || runner.sessionExists?.(this.runnerMember(member, project)) === false;
      if (!missing) {
        console.warn(`${member.name} 이어 열기 실패, 세션을 그대로 두고 다시 시도합니다:`, message);
        if (this.store.getMember(member.id)) this.store.patchMember(member.id, { lastError: message });
        return null;
      }
      console.warn(`${member.name}의 이전 세션이 없어 새 세션을 엽니다:`, message);
      try {
        const fresh = { ...member, sessionId: null };
        const sent = this.desiredConfig(fresh);
        const started = await runner.start(this.runnerMember(fresh, project), this.writeRunFiles(member, project, false));
        if (await this.dropIfClosed(member, project, runner, started)) return null;
        this.applyStarted(member.id, project, started, sent);
        this.store.patchMember(member.id, { contextPct: null, parallel: false, ...(member.origin === "adopted" ? { origin: "runner" as const } : {}) });
        this.store.enqueue({ projectId: project.id, memberId: member.id, kind: "system", text: this.newSessionNote(member), wake: false });
      } catch (e2) {
        this.store.patchMember(member.id, { lastError: (e2 as Error).message });
        return null;
      }
    }
    this.settle(this.store.requireMember(member.id));
    return this.store.requireMember(member.id);
  }

  /** 띄우는 사이 직원이 닫혔다. 띄운 칸을 남기면 명부 밖에서 계속 산다. */
  private async dropIfClosed(member: Member, project: Project, runner: Runner, started: { sessionId: string | null; paneId: string | null; rejoined?: boolean }): Promise<boolean> {
    if (this.store.getMember(member.id)) return false;
    // 방금 띄운 칸은 서버 칸이다. 대표의 칸에 다시 붙은 경우(rejoined)만 넘겨받은 칸으로 다룬다.
    const origin = member.origin === "adopted" && !started.rejoined ? "runner" : member.origin;
    await runner.stop(this.runnerMember({ ...member, origin, sessionId: started.sessionId, paneId: started.paneId }, project)).catch((e) => console.warn("닫힌 직원의 칸을 닫지 못했습니다:", (e as Error).message));
    return true;
  }

  private newSessionNote(member: Member): string {
    const last = [member.now && `지금 일: ${normalizeSpace(member.now)}`, member.next && `다음: ${normalizeSpace(member.next)}`].filter(Boolean).join(" · ");
    return formatSystem(`이전 세션을 찾지 못해 새 세션으로 시작합니다. ${last ? `마지막 일 — ${last}` : "이전 기록은 없습니다."}`);
  }

  /** 세션을 끝내고 명부에서 뺀다. 대화·결재 기록은 남는다. 나가지 않고 사라진 입력의 요약을 돌려준다. */
  async closeMember(memberId: string, opts: { paneDone?: boolean } = {}): Promise<string[]> {
    const member = this.store.requireMember(memberId);
    if (member.kind !== "worker") throw new ApiError(400, "총괄은 닫을 수 없습니다");
    const rt = this.runtime(memberId);
    rt.closing = true;
    if (rt.turn) rt.turn.interrupted = true;
    if (member.origin !== "manual") {
      // asleep 로 두어야 끊긴 턴의 뒤처리가 대기열을 다시 밀지 않는다.
      this.store.patchMember(memberId, { status: "asleep" });
      const project = this.store.requireProject(member.projectId);
      // 넘겨받은 칸은 대표의 세션이다. 총괄이 닫아도 끝내지 않고 손만 뗀다.
      if (member.origin === "adopted") {
        if (!opts.paneDone) await this.releasePane(member, project);
      } else await this.runnerOf(member).stop(this.runnerMember(member, project));
    }
    const dropped: string[] = [];
    const doneTodos: Todo[] = [];
    for (const d of this.store.listPending(memberId)) {
      if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "failed", `${josa(member.name, "이")} 닫혔습니다`);
      else if (d.kind === "todo_done" && d.refId) {
        const todo = this.store.getTodo(d.refId);
        if (todo?.done) doneTodos.push(todo);
      } else if (d.kind === "instruction") dropped.push(normalizeSpace(d.text.replace(/^\[총괄\][^\n]*\n/, "")).slice(0, 120));
    }
    for (const d of this.store.listOpenDecisionsByMember(memberId)) {
      this.store.closeDecision(d.id, { kind: null, reason: `${josa(member.name, "이")} 명부에서 빠져 함께 닫혔습니다`, by: "시스템" });
      this.wakeAll(this.askWaiters, d.id);
    }
    this.clearRuntime(memberId, rt);
    (this.runners.get("herdr") as HerdrCapable | undefined)?.dropMember?.(memberId);
    this.store.removeMember(memberId);
    this.releaseSlots();
    // 대표가 체크한 '했음'은 받을 직원이 사라져도 잃으면 안 된다. 총괄에게 넘긴다.
    const conductor = this.store.getConductor(member.projectId);
    for (const todo of doneTodos) {
      if (conductor) await this.deliver({ projectId: member.projectId, memberId: conductor.id, kind: "todo_done", text: formatTodoDone(todo), refType: "todo", refId: todo.id, wake: false });
      else this.store.setTodoNoticePending(todo.id, true);
    }
    return dropped;
  }

  roster(projectId: string): RosterEntry[] {
    const { ranks } = this.store.getSettings();
    return this.store.listMembers(projectId).map((m) => ({
      handle: m.handle,
      name: m.name,
      role: m.role,
      kind: m.kind,
      status: m.status,
      now: m.now,
      next: m.next,
      queued: m.queuedCount,
      openDecisions: this.store.listOpenDecisionsByMember(m.id).length,
      contextPct: m.contextPct,
      subagents: m.subagents,
      parallel: m.parallel,
      updatedAt: m.updatedAt,
      ...memberConfig(m, ranks),
      subagentModel: ranks.staff.model,
      subagentEffort: ranks.staff.effort,
    }));
  }

  requireInProject(projectId: string, memberRef: string): Member {
    const member = this.store.findMember(projectId, memberRef);
    if (!member) throw new ApiError(404, `이 프로젝트에 없는 직원입니다: ${memberRef}`);
    return member;
  }

  // ---- 보고 ----
  async recordPost(member: Member, input: PostInput): Promise<Message> {
    const rt = this.runtime(member.id);
    const files = (input.fileIds ?? []).map((id) => {
      const file = this.store.getFile(id);
      if (!file || file.projectId !== member.projectId) throw new ApiError(404, `자료를 찾을 수 없습니다: ${id}`);
      return file;
    });
    if (input.decisionId && this.store.getDecision(input.decisionId)?.projectId !== member.projectId) {
      throw new ApiError(404, `결재를 찾을 수 없습니다: ${input.decisionId}`);
    }
    // 거부된 호출은 보고가 아니다. 턴 마지막 글의 자동 보고를 막으면 안 된다.
    rt.posted = true;
    // Message 는 자료 하나만 잇는다. 나머지는 본문의 앱 안 링크로 잇는다.
    const extra = files
      .slice(1)
      .map((f) => `[자료: ${f.title.replace(/[\[\]\\]/g, "\\$&")}](#/p/${encodeURIComponent(member.projectId)}/files/${encodeURIComponent(f.id)})`)
      .join("\n\n");
    const message = this.store.createMessage({
      projectId: member.projectId,
      memberId: member.id,
      who: member.name,
      kind: input.kind,
      title: rt.direct ? `(직접) ${input.title}` : input.title,
      body: [input.body ?? "", extra].filter(Boolean).join("\n\n"),
      decisionId: input.decisionId ?? null,
      fileId: files[0]?.id ?? null,
    });
    if (member.kind === "worker") {
      const kindLabel = rt.direct ? `(직접) ${input.kind}` : input.kind;
      await this.reportToConductor(member, kindLabel, input.title, input.body ?? "", WAKE_POST_KINDS.has(input.kind));
    }
    return message;
  }

  private async reportToConductor(member: Member, kind: string, title: string, body: string, wake: boolean): Promise<void> {
    const conductor = this.store.getConductor(member.projectId);
    if (!conductor || conductor.id === member.id) return;
    await this.deliver({ projectId: member.projectId, memberId: conductor.id, kind: "report", text: formatReport(member.name, kind, title, body), wake });
  }

  /** ask. blocking 이면(manual) 호출자가 askWait 로 기다리고, 아니면 text 를 도구 결과로 돌려준다. */
  async registerAsk(member: Member, input: AskInput): Promise<{ decision: Decision; blocking: boolean; text: string }> {
    // 보관한 프로젝트의 카드는 화면에 없고 답도 409 다. 올리면 세션이 답 없는 대기에 묶인다.
    if (this.store.requireProject(member.projectId).archived) throw new ApiError(409, "프로젝트가 보관되어 대표가 답할 수 없습니다. 묻지 말고 턴을 끝내세요");
    const decision = this.store.createDecision({
      projectId: member.projectId,
      memberId: member.id,
      who: member.name,
      title: input.title,
      detail: input.detail,
      options: input.options,
      rec: input.rec,
      group: input.group,
      fileId: input.fileId,
      images: input.images,
    });
    this.store.createMessage({
      projectId: member.projectId,
      memberId: member.id,
      who: member.name,
      kind: "질문",
      title: input.title,
      body: input.detail ?? "",
      decisionId: decision.id,
      fileId: input.fileId ?? null,
      attachments: input.images,
    });
    this.runtime(member.id).posted = true;
    this.store.patchMember(member.id, { status: "waiting" });
    this.notifyInbox(`${member.name}의 결재`, input.title);
    if (member.kind === "worker") {
      const conductor = this.store.getConductor(member.projectId);
      if (conductor) {
        await this.deliver({
          projectId: member.projectId,
          memberId: conductor.id,
          kind: "system",
          text: formatSystem(`${josa(member.name, "이")} 대표에게 질문했습니다: ${normalizeSpace(input.title)} #${decision.id}`),
          wake: false,
        });
      }
    }
    if (member.origin === "manual") return { decision, blocking: true, text: `질문 #${decision.id} 등록됨. 답을 기다립니다` };
    return { decision, blocking: false, text: `질문 #${decision.id} 등록됨. 턴을 끝내세요. 답은 다음 입력으로 옵니다` };
  }

  // ---- 판 정리: 결재 닫기·할 일 정리 ----
  /**
   * ask_close. 열린 결재를 이유와 함께 닫는다. 대신 답하지 않는다: decided 는 user_quote 가 이 프로젝트의 대표 글과
   * team_assign 과 같은 방식으로 맞아야 하고, 버튼 글·아주 짧은 글은 근거가 못 된다. 직원은 자기가 올린 카드만.
   * 닫으면 물은 직원에게 깨우지 않고 알리고, ask 를 기다리던 직접 띄운 CLI 는 풀어 준다.
   */
  async closeAsk(member: Member, input: { id: string; kind: DecisionCloseKind; reason: string; userQuote?: string }): Promise<Decision> {
    const decision = this.store.getDecision(input.id);
    if (!decision || decision.projectId !== member.projectId) throw new ApiError(404, `결재를 찾을 수 없습니다: ${input.id}`);
    if (member.kind === "worker" && decision.memberId !== member.id) throw new ApiError(403, "직원은 자기가 올린 결재만 닫을 수 있습니다");
    if (decision.status !== "open") throw new ApiError(409, decision.status === "closed" ? "이미 닫힌 결재입니다" : "대표가 이미 답한 결재입니다. 닫지 않습니다");
    const reason = normalizeSpace(input.reason);
    let quote: string | null = null;
    let sourceId: string | null = null;
    if (input.kind === "decided") {
      const raw = input.userQuote?.trim();
      if (!raw) throw new ApiError(400, "decided 로 닫으려면 user_quote 에 대표가 정한 말을 글자 그대로 실어야 합니다. 대표가 아직 정하지 않았으면 닫지 마세요");
      const source = this.findQuoteSource(member.projectId, raw);
      if (!source) throw new ApiError(409, "인용을 대표 글에서 찾지 못해 닫지 않았습니다. 대표가 정하지 않았으면 그대로 두세요");
      if (quoteNeedsContext({ text: raw, verified: true, source })) throw new ApiError(409, "버튼 글이나 아주 짧은 글은 이 결재를 정했다는 근거가 못 되어 닫지 않았습니다. 대표가 이 일을 정한 문장을 인용하세요");
      quote = normalizeSpace(raw);
      sourceId = source.id;
    }
    const closed = this.store.closeDecision(decision.id, { kind: input.kind, reason, by: member.name, quote });
    const why = `${reason}${sourceId ? ` (대표가 이미 정함, 대표 글 #${sourceId})` : ""}`;
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    if (asker?.origin === "manual") this.wakeAll(this.askWaiters, decision.id);
    if (asker && asker.id !== member.id && asker.origin !== "manual") {
      await this.deliver({ projectId: decision.projectId, memberId: asker.id, kind: "system", text: formatSystem(`결재 #${decision.id} 가 닫혔습니다: ${why}. 질문 '${quotedInline(decision.title)}' 의 답은 오지 않습니다`), wake: false });
    }
    if (asker && asker.origin !== "manual") {
      const fresh = this.store.getMember(asker.id);
      if (fresh?.status === "waiting" && !this.isBusy(fresh)) this.settle(fresh);
    }
    // 직원이 스스로 닫았으면 총괄의 판도 맞춘다.
    const lead = this.store.getConductor(decision.projectId);
    if (lead && lead.id !== member.id && lead.id !== asker?.id) {
      await this.deliver({ projectId: decision.projectId, memberId: lead.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 결재 #${decision.id} 를 닫았습니다: ${why} (질문 '${quotedInline(decision.title)}')`), wake: false });
    }
    return closed;
  }

  /** todo_close. 대표의 할 일을 끝남·필요 없어짐으로 정리한다. 직원은 자기가 부탁한 할 일만. 부탁한 직원에게 깨우지 않고 알린다. */
  async closeTodo(member: Member, input: { id: string; outcome: TodoOutcome; reason: string }): Promise<Todo> {
    const todo = this.store.getTodo(input.id);
    if (!todo || todo.projectId !== member.projectId) throw new ApiError(404, `할 일을 찾을 수 없습니다: ${input.id}`);
    if (member.kind === "worker" && todo.memberId !== member.id) throw new ApiError(403, "직원은 자기가 부탁한 할 일만 정리할 수 있습니다");
    const reason = normalizeSpace(input.reason);
    const closed = this.store.closeTodo(todo.id, { outcome: input.outcome, reason, by: member.name });
    const label = input.outcome === "done" ? "끝남" : "필요 없어짐";
    const requester = todo.memberId ? this.store.getMember(todo.memberId) : null;
    if (requester && requester.id !== member.id) {
      // 대표가 체크를 풀면 '아직 안 했음'이 이 글을 바로잡도록 할 일에 잇는다.
      await this.deliver({ projectId: todo.projectId, memberId: requester.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 대표의 할 일 #${todo.id} 를 정리했습니다(${label}): ${reason} (할 일 '${quotedInline(todo.title)}')`), wake: false, refType: "todo", refId: todo.id });
    }
    const lead = this.store.getConductor(todo.projectId);
    if (lead && lead.id !== member.id && lead.id !== requester?.id) {
      await this.deliver({ projectId: todo.projectId, memberId: lead.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 대표의 할 일 #${todo.id} 를 정리했습니다(${label}): ${reason} (할 일 '${quotedInline(todo.title)}')`), wake: false });
    }
    return closed;
  }

  /** 대표가 AI 가 닫은 결재를 다시 연다. 결재할 항목으로 돌아가고, 물은 직원과 총괄에게 깨우지 않고 알린다. */
  async reopenDecision(decisionId: string): Promise<Decision> {
    const decision = this.store.requireDecision(decisionId);
    this.requireActive(this.store.requireProject(decision.projectId));
    if (decision.status !== "closed" || !decision.closeKind) throw new ApiError(409, "AI가 닫은 결재만 다시 열 수 있습니다");
    const reopened = this.store.reopenDecision(decisionId, `${josa(decision.closedBy ?? "AI", "이")} 닫았던 결재를 대표가 다시 열었습니다${decision.closeReason ? `(닫은 이유: ${normalizeSpace(decision.closeReason)})` : ""}`);
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    const note = `대표가 결재 #${decision.id} 를 다시 열었습니다(질문 '${quotedInline(decision.title)}'). 닫은 것은 취소이며 답이 오면 전달됩니다`;
    if (asker && asker.origin !== "manual") {
      await this.deliver({ projectId: decision.projectId, memberId: asker.id, kind: "system", text: formatSystem(note), wake: false });
      const fresh = this.store.getMember(asker.id);
      if (fresh?.status === "idle" && !this.isBusy(fresh)) this.settle(fresh);
    }
    const lead = this.store.getConductor(decision.projectId);
    if (lead && lead.id !== asker?.id) await this.deliver({ projectId: decision.projectId, memberId: lead.id, kind: "system", text: formatSystem(note), wake: false });
    return this.store.requireDecision(reopened.id);
  }

  /** 대표가 다른 창에 있어도 결정할 일을 알게 한다. 설정에서 켠 때만. */
  notifyInbox(title: string, body: string): void {
    if (!this.notifier || !this.store.getSettings().notifyMac) return;
    this.notifier(`IAMCEO · ${normalizeSpace(title).slice(0, 60)}`, normalizeSpace(body).slice(0, 200));
  }

  setMemberStatus(member: Member, now: string, next?: string): Member {
    return this.store.patchMember(member.id, { now: normalizeSpace(now), ...(next !== undefined ? { next: normalizeSpace(next) } : {}) });
  }

  setProjectNow(projectId: string, text: string): Project {
    return this.store.patchProject(projectId, { now: text });
  }

  setWork(projectId: string, input: { id?: string; sec: WorkSec; title: string; detail?: string; who?: string }): WorkItem {
    return this.store.upsertWork({ projectId, ...input });
  }

  /** 직접 띄운 CLI 의 wait. 밀린 지시를 한 글로 묶어 돌려준다. 없으면 null. */
  async waitInbox(member: Member, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    const first = this.takeInbox(member);
    if (first) return first;
    await this.waitOn(this.inboxWaiters, member.id, timeoutMs, signal);
    // 끊긴 연결로 응답을 보내면 지시가 받은 것으로 표시된 채 사라진다.
    if (signal?.aborted) return null;
    return this.takeInbox(member);
  }

  private takeInbox(member: Member): string | null {
    const answers = this.store.listDecisions(member.projectId).filter((d) => d.memberId === member.id && d.status === "answered");
    const pending = this.store.listPending(member.id);
    if (answers.length === 0 && pending.length === 0) return null;
    for (const d of answers) this.store.setDecisionStatus(d.id, "delivered");
    for (const d of pending) this.markDelivered(d);
    return [...answers.map(formatAnswer), ...orderForBundle(pending).map((d) => d.text)].join("\n\n");
  }

  private waitOn(table: Map<string, Set<() => void>>, key: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((done) => {
      if (this.closed || signal?.aborted) return done();
      const waiters = table.get(key) ?? new Set<() => void>();
      table.set(key, waiters);
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        waiters.delete(finish);
        if (waiters.size === 0 && table.get(key) === waiters) table.delete(key);
        done();
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
      waiters.add(finish);
    });
  }

  private wakeAll(table: Map<string, Set<() => void>>, key: string): void {
    for (const wake of [...(table.get(key) ?? [])]) wake();
  }

  // ---- 전달 펌프 ----
  private async deliver(input: NewDelivery): Promise<Delivery> {
    const delivery = this.store.enqueue(input);
    await this.pump(input.memberId);
    return this.store.getDelivery(delivery.id) ?? delivery;
  }

  /** 직원마다 한 번에 하나만 돈다. 도는 중에 다시 불리면 끝나고 한 번 더 돈다. */
  pump(memberId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const rt = this.runtime(memberId);
    if (rt.pumping) {
      rt.again = true;
      return rt.pumping;
    }
    rt.pumping = (async () => {
      try {
        do {
          rt.again = false;
          await this.pumpOnce(memberId);
        } while (rt.again && !this.closed);
      } catch (e) {
        console.error("전달 펌프 오류:", memberId, e);
      } finally {
        rt.pumping = null;
      }
    })();
    return rt.pumping;
  }

  private async pumpOnce(memberId: string): Promise<void> {
    let member = this.store.getMember(memberId);
    if (!member) return;
    if (member.origin === "manual") {
      const pending = this.store.listPending(memberId);
      if (pending.some((d) => d.wake) || this.store.listDecisions(member.projectId).some((d) => d.memberId === memberId && d.status === "answered")) {
        this.wakeAll(this.inboxWaiters, memberId);
      }
      // 서버가 넣어 줄 수 없는 세션이다. 왜 안 가는지 화면에 보여 준다.
      for (const d of this.store.listPending(memberId)) {
        if (d.refType === "message" && d.refId && !this.store.getMessage(d.refId)?.deliveryNote) {
          this.store.setMessageDelivery(d.refId, "queued", `${member.name}이 wait 를 부르면 전달됩니다`);
        }
      }
      return;
    }
    const project = this.store.requireProject(member.projectId);
    const pending = this.store.listPending(memberId);
    const rt = this.runtime(memberId);
    if (rt.closing) return; // 닫는 중에 다시 열면 명부 밖 칸이 남는다.
    if (this.switching) return; // 끝나면 updateSettings 가 다시 민다.
    if (rt.starting) return; // 다 뜨면 다시 민다.
    if (Date.now() < rt.holdUntil) return; // retryLater 가 시간이 되면 다시 민다.

    // 보관 중에는 아무도 깨우지 않는다. 꺼낼 때 onProjectPatched 가 다시 민다.
    if (project.archived || this.archiving.has(project.id)) {
      for (const d of pending) if (d.status === "queued") this.hold(d, "archived");
      return;
    }
    if (!project.runnerEnabled) {
      for (const d of pending) this.hold(d, "runner_disabled");
      return;
    }
    // 세션이 없거나 잠들었으면 새로 연다: 전역 실행 방식을 따른다. 살아 있는 세션은 시작한 실행기로 계속 다룬다.
    const opening = member.status === "asleep" || member.status === "offline" || !member.sessionId;
    let runner = this.runners.get(opening ? this.store.effectiveBackend() : this.backendOf(member));
    if (!runner) {
      for (const d of pending) this.hold(d, "backend_down");
      return;
    }

    if (member.status === "asleep" || member.status === "offline") {
      // 잠들 때 보류된 것만 있으면 깨우지 않는다. 새 깨움이 와야 함께 나간다.
      const wakes = pending.some((d) => d.wake && !(d.status === "held" && d.holdReason === "asleep"));
      if (!wakes) return;
      const reopened = await this.reopen(member);
      if (!reopened) {
        for (const d of pending) this.hold(d, member.status === "offline" ? "offline" : "backend_down");
        return;
      }
      member = reopened;
      runner = this.runnerOf(member);
      this.checkAwakeLimit(member.projectId);
    }

    // 턴 도중 승인 창에 걸려도 보류로 보여 준다. isBusy 보다 먼저 본다(§6).
    if (member.status === "blocked") {
      for (const d of pending) this.hold(d, "blocked");
      return;
    }
    if (this.isBusy(member)) {
      const urgent = pending.filter((d) => d.urgent);
      // headless 는 돌고 있는 턴에 끼워 넣을 수 없다. 끝나면 묶어서 나간다.
      if (urgent.length > 0 && runner.kind !== "headless") await this.sendUrgent(member, project, runner, urgent);
      return;
    }

    // 쉬는 동안 바뀐 설정을 먼저 맞춘다. 일을 넣고 나면 턴이 끝날 때까지 못 맞춘다.
    if (runner.applyConfig && this.configPending(member)) {
      if (!(await this.syncConfig(member, project, runner, rt))) return;
      member = this.store.requireMember(memberId);
    }

    const hasWake = pending.some((d) => d.wake);
    if (!hasWake && rt.compactRequest === null) {
      for (const d of pending) if (d.status === "held") this.requeue(d);
      return;
    }

    // 상한 검사와 자리 잡기(rt.turn) 사이에 await 가 끼면 상한을 넘을 수 있어 세션부터 마련한다.
    if (!member.sessionId) {
      let failure: Error | null = null;
      const current = member;
      runner = this.openRunner(current);
      const opened = runner;
      const started = (async () => {
        try {
          const sent = this.desiredConfig(current);
          const result = await opened.start(this.runnerMember(current, project), this.writeRunFiles(current, project, false));
          this.applyStarted(current.id, project, result, sent);
        } catch (e) {
          failure = e as Error;
        } finally {
          rt.starting = null;
        }
      })();
      rt.starting = started;
      await started;
      if (failure) {
        this.store.patchMember(member.id, { lastError: (failure as Error).message });
        for (const d of pending) this.hold(d, "backend_down");
        return;
      }
      member = this.store.requireMember(member.id);
    }

    if (runner.kind === "headless" && this.activeHeadlessTurns() >= this.store.getSettings().maxConcurrentTurns) {
      this.waiting.add(memberId);
      for (const d of pending) if (d.status === "held") this.requeue(d);
      return;
    }

    const compactAt = this.store.getSettings().compactAtPct;
    const autoCompact = hasWake && !rt.skipCompact && member.contextPct !== null && member.contextPct >= compactAt;
    if (rt.compactRequest !== null || autoCompact) {
      await this.beginCompact(member, project, runner, rt, rt.compactRequest ?? this.compactFocus(member));
      return;
    }
    if (!hasWake) return;

    const turn: Turn = { kind: "work", headless: runner.kind === "headless", text: "", interrupted: false, sessionRetried: false };
    rt.turn = turn;
    if (rt.wantParallel !== null) {
      const go = await this.applyParallel(member, project, runner, rt, this.store.listPending(memberId));
      if (!go || this.store.requireMember(memberId).status === "asleep") {
        rt.turn = null;
        this.releaseSlots();
        return;
      }
    }

    const fresh = this.store.listPending(memberId);
    const ordered = orderForBundle(fresh);
    turn.text = ordered.map((d) => d.text).join("\n\n");
    rt.posted = false;
    rt.direct = ordered.some((d) => d.kind === "user_message" && d.text.startsWith("[대표 직접]"));
    turn.deliveries = ordered;
    for (const d of ordered) this.store.setDeliveryStatus(d.id, "delivering", { attempt: true });

    const current = this.store.requireMember(memberId);
    // 재시작 복구에서 이번 글이 칸에 들어갔는지 찾을 표지. 글 끝에 #id 가 없을 때만 쓰인다.
    const sendOpts = { ...this.writeRunFiles(current, project), marker: `#${ordered.at(-1)!.id}` };
    const sender = runner;
    const sentConfig = this.desiredConfig(current);
    const result = await this.safeSend(() => sender.send(this.runnerMember(current, project), turn.text, sendOpts, false));
    if (!result.ok) {
      if (rt.turn === turn) rt.turn = null;
      this.onSendFailed(current, rt, ordered, result);
      this.releaseSlots();
      return;
    }
    rt.inputBusySince = null;
    // headless 는 턴마다 인자를 새로 정한다. 방금 나간 인자가 곧 지금 설정이다.
    if (!sender.applyConfig && this.store.getMember(memberId)) this.store.setAppliedConfig(memberId, sentConfig);
    for (const d of ordered) this.markDelivered(d);
    this.store.appendActivity(memberId, "turn_start", normalizeSpace(turn.text).slice(0, 300));
    // 아주 빠른 턴은 send 가 돌아오기 전에 끝날 수 있다. 그때는 이미 정리되어 있다.
    if (rt.turn === turn && this.store.requireMember(memberId).status !== "asleep") this.store.patchMember(memberId, { status: "working", lastError: null });
  }

  /** 이 직원의 세션에 들어가 있어야 할 설정. */
  private desiredConfig(member: Member): AppliedConfig {
    const { ranks } = this.store.getSettings();
    const { model, effort } = memberConfig(member, ranks);
    return { model, effort, staffModel: ranks.staff.model, staffEffort: ranks.staff.effort };
  }

  /** 서버가 띄운 세션이 지금 설정과 다른가. 넘겨받은 세션은 대표가 쓰던 칸이라 스스로 닫지 않는다(깨울 때 맞춰진다). 잠든 세션은 깨울 때 맞춰진다. */
  private configPending(member: Member): boolean {
    if (member.origin !== "runner" || !member.sessionId || member.status === "asleep" || member.status === "offline") return false;
    if (!this.runners.get(this.backendOf(member))?.applyConfig) return false;
    const want = this.desiredConfig(member);
    if (this.runtime(member.id).configGaveUp === JSON.stringify(want)) return false;
    const have = this.store.getAppliedConfig(member.id);
    return want.model !== (have?.model ?? null) || want.effort !== (have?.effort ?? null) || want.staffModel !== (have?.staffModel ?? null) || want.staffEffort !== (have?.staffEffort ?? null);
  }

  /** 쉬는 세션을 새 설정으로 다시 연다. 이번 전달을 그대로 이어가도 되면 true. */
  private async syncConfig(member: Member, project: Project, runner: Runner, rt: Runtime): Promise<boolean> {
    const want = this.desiredConfig(member);
    const held = rt.turn;
    const control: Turn = { kind: "control", headless: false, text: "", interrupted: false, sessionRetried: false };
    rt.turn = control;
    const result = await this.safeSend(() => runner.applyConfig!(this.runnerMember(member, project), this.writeRunFiles(member, project, true)));
    if (rt.turn === control) rt.turn = held;
    if (!this.store.getMember(member.id)) return false;
    if (result.ok) {
      rt.configFails = 0;
      this.store.setAppliedConfig(member.id, want);
      this.store.appendActivity(member.id, "system", `새 설정으로 다시 열었습니다: 모델 ${want.model ?? "기본"}, effort ${want.effort ?? "기본"}`);
      // 병렬은 세션에만 있는 값이라 다시 열면 풀린다. 다음 일 전에 되살린다.
      if (member.parallel) {
        this.store.patchMember(member.id, { parallel: false });
        rt.wantParallel ??= true;
      }
      return true;
    }
    switch (result.reason) {
      case "busy":
      case "input_busy":
        // 선택 창이 떠 있는 등 입력칸을 못 찾았다(남은 글은 실행기가 지운다). 닫힐 때까지 기다린다.
        this.retryLater(member.id, rt, this.timings.inputBusyRetryMs);
        return true;
      case "gone":
        this.store.patchMember(member.id, { status: "offline", paneId: null });
        rt.again = true;
        return false;
      case "error": {
        rt.configFails++;
        const detail = result.detail ?? "알 수 없는 오류";
        if (rt.configFails < MAX_TURN_ERROR_ATTEMPTS) {
          this.retryLater(member.id, rt, this.timings.retryMs);
          return true;
        }
        // 일을 영영 막지는 않는다. 어떤 값으로 도는지는 활동에 남긴다.
        rt.configFails = 0;
        rt.configGaveUp = JSON.stringify(want);
        this.store.appendActivity(member.id, "error", `새 설정을 적용하지 못했습니다: ${detail}`);
        return true;
      }
      default:
        return true;
    }
  }

  private async sendUrgent(member: Member, project: Project, runner: Runner, urgent: Delivery[]): Promise<void> {
    const text = urgent.map((d) => d.text).join("\n\n");
    for (const d of urgent) this.store.setDeliveryStatus(d.id, "delivering", { attempt: true });
    const result = await this.safeSend(() => runner.send(this.runnerMember(member, project), text, this.writeRunFiles(member, project), true));
    if (result.ok) {
      for (const d of urgent) this.markDelivered(d);
    } else {
      this.onSendFailed(member, this.runtime(member.id), urgent, result);
    }
  }

  private async safeSend(send: () => Promise<SendResult>): Promise<SendResult> {
    try {
      return await send();
    } catch (e) {
      return { ok: false, reason: "error", detail: (e as Error).message, retryable: true };
    }
  }

  /** 일을 내보내도 되면 true. 일시적으로 못 바꿨으면 지시를 되살리고 일도 미룬다(순차로 나가 버리면 되돌릴 수 없다). */
  private async applyParallel(member: Member, project: Project, runner: Runner, rt: Runtime, pending: Delivery[] = []): Promise<boolean> {
    const want = rt.wantParallel!;
    rt.wantParallel = null;
    if (want === member.parallel) return true;
    const held = rt.turn;
    rt.turn = { kind: "control", headless: runner.kind === "headless", text: "", interrupted: false, sessionRetried: false };
    const result = await this.safeSend(() => runner.setParallel(this.runnerMember(member, project), want, this.writeRunFiles(member, project)));
    rt.turn = held;
    if (result.ok) {
      rt.parallelFails = 0;
      this.store.patchMember(member.id, { parallel: want });
      this.store.appendActivity(member.id, "system", `병렬 ${want ? "켬" : "끔"}`);
      return true;
    }
    const detail = result.detail ?? result.reason;
    this.store.appendActivity(member.id, "error", `병렬 설정 실패: ${detail}`);
    // 세션을 못 찾았다면 이어지는 턴이 새 세션을 만든다. 그때 다시 켠다.
    if (isMissingSessionError(result.detail)) {
      rt.wantParallel = want;
      return true;
    }
    // 그 사이 온 새 지시가 이긴다.
    rt.wantParallel ??= want;
    if (result.reason !== "error") {
      // 입력칸·승인 창·연결 문제는 보통 전달과 같게 미룬다.
      this.onSendFailed(member, rt, pending, result);
      return false;
    }
    rt.parallelFails++;
    if (result.retryable && rt.parallelFails < MAX_TURN_ERROR_ATTEMPTS) {
      this.retryLater(member.id, rt, this.timings.retryMs);
      return false;
    }
    // 끝내 안 된다. 일을 영영 막지는 않되, 순차로 돈다는 것을 총괄이 알게 한다.
    rt.wantParallel = null;
    rt.parallelFails = 0;
    const conductor = this.store.getConductor(member.projectId);
    if (conductor && conductor.id !== member.id) {
      this.store.enqueue({ projectId: member.projectId, memberId: conductor.id, kind: "system", text: formatSystem(`${member.name} 병렬 ${want ? "켜기" : "끄기"} 실패: ${normalizeSpace(detail).slice(0, 200)}. 지금 설정대로 일을 넘겼습니다.`), wake: false });
    }
    return true;
  }

  private onSendFailed(member: Member, rt: Runtime, deliveries: Delivery[], result: Extract<SendResult, { ok: false }>): void {
    const memberId = member.id;
    switch (result.reason) {
      case "busy":
        for (const d of deliveries) this.requeue(d);
        this.retryLater(memberId, rt, this.timings.retryMs);
        return;
      case "blocked":
        this.markBlocked(member);
        for (const d of deliveries) this.hold(d, "blocked");
        return;
      case "input_busy": {
        rt.inputBusySince ??= Date.now();
        if (Date.now() - rt.inputBusySince < this.timings.inputBusyLimitMs) {
          for (const d of deliveries) this.requeue(d);
          this.retryLater(memberId, rt, this.timings.inputBusyRetryMs);
        } else {
          rt.inputBusySince = null;
          for (const d of deliveries) this.hold(d, "input_busy");
        }
        return;
      }
      case "down":
        this.store.patchMember(memberId, { lastError: result.detail ?? "실행기에 연결할 수 없습니다" });
        for (const d of deliveries) this.hold(d, "backend_down");
        return;
      case "gone":
        this.store.patchMember(memberId, { status: "offline", paneId: null });
        for (const d of deliveries) this.hold(d, "offline");
        return;
      case "error": {
        const detail = result.detail ?? "전달 실패";
        const attempts = Math.max(...deliveries.map((d) => this.store.requireDelivery(d.id).attempts));
        if (result.retryable && attempts < 3) {
          for (const d of deliveries) this.requeue(d);
          this.retryLater(memberId, rt, this.timings.retryMs);
          return;
        }
        const first = member.status !== "error" || member.lastError !== detail;
        for (const d of deliveries) {
          if (d.refType === "message" && d.refId) {
            this.store.markFailed(d.id, detail);
            this.store.setMessageDelivery(d.refId, "failed", detail);
          } else {
            // 대표에게 돌려줄 글이 없는 전달(보고·지시·알림·완료)은 실패시키면 아무도 모르게 사라진다. 두었다가 다시 보낸다.
            this.hold(d, "send_error");
          }
        }
        this.store.patchMember(memberId, { status: "error", lastError: detail });
        this.holdHeld(memberId, rt, this.timings.retryMs);
        if (first) this.systemMessage(member.projectId, `${member.name}에게 전달하지 못했습니다: ${detail}`);
        return;
      }
    }
  }

  /** 보류해 둔 전달을 시간을 두고 다시 보낸다. 틱이 그 전에 밀어도 holdUntil 이 막는다. */
  private holdHeld(memberId: string, rt: Runtime, baseMs: number): void {
    if (this.store.listPending(memberId).length === 0) return;
    const wait = baseMs * HELD_RETRY_FACTOR;
    rt.holdUntil = Date.now() + wait;
    if (rt.retryTimer) clearTimeout(rt.retryTimer);
    rt.retryTimer = null;
    this.retryLater(memberId, rt, wait);
  }

  private retryLater(memberId: string, rt: Runtime, ms: number): void {
    if (rt.retryTimer || this.closed) return;
    rt.retryTimer = setTimeout(() => {
      rt.retryTimer = null;
      void this.pump(memberId);
    }, ms);
  }

  private hold(d: Delivery, reason: string): void {
    this.store.markHeld(d.id, reason);
    if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "held", HOLD_NOTES[reason] ?? reason);
  }

  private requeue(d: Delivery): void {
    this.store.setDeliveryStatus(d.id, "queued");
    if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "queued");
  }

  private markDelivered(d: Delivery): void {
    this.store.markDelivered(d.id);
    if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "delivered");
    if (d.refType === "decision" && d.refId && this.store.getDecision(d.refId)?.status === "answered") {
      this.store.setDecisionStatus(d.refId, "delivered");
    }
  }

  private isBusy(member: Member): boolean {
    return this.runtime(member.id).turn !== null || !!this.runners.get(this.backendOf(member))?.isBusy(member.id);
  }

  private activeHeadlessTurns(): number {
    let count = 0;
    for (const rt of this.runtimes.values()) if (rt.turn?.headless) count++;
    return count;
  }

  private releaseSlots(): void {
    const ids = [...this.waiting];
    this.waiting.clear();
    for (const id of ids) void this.pump(id);
  }

  // ---- 압축 ----
  private async beginCompact(member: Member, project: Project, runner: Runner, rt: Runtime, focus: string): Promise<void> {
    rt.compactRequest = null;
    const turn: Turn = { kind: "compact", headless: runner.kind === "headless", text: "", interrupted: false, sessionRetried: false };
    rt.turn = turn;
    this.store.patchMember(member.id, { status: "working" });
    this.store.appendActivity(member.id, "compact", `압축 시작 (문맥 ${member.contextPct ?? "?"}%)`);
    const result = await this.safeSend(() => runner.compact(this.runnerMember(member, project), focus, this.writeRunFiles(member, project)));
    if (result.ok) {
      if (rt.turn === turn) {
        rt.compactTimer = setTimeout(() => {
          rt.compactTimer = null;
          if (rt.turn === turn) this.endCompact(member.id, rt, "압축이 끝났다는 신호를 받지 못했습니다");
        }, this.timings.compactTimeoutMs);
      }
      return;
    }
    if (rt.turn === turn) rt.turn = null;
    if (result.reason === "busy") {
      rt.compactRequest = focus;
      this.retryLater(member.id, rt, this.timings.retryMs);
    } else {
      this.store.appendActivity(member.id, "error", `압축 실패: ${result.detail ?? result.reason}`);
      rt.skipCompact = true;
      rt.again = true;
    }
    this.settle(this.store.requireMember(member.id));
    this.releaseSlots();
  }

  /** 압축 턴 정리. 실패해도 대기열은 멈추지 않는다. */
  private endCompact(memberId: string, rt: Runtime, error: string | null): void {
    rt.turn = null;
    if (rt.compactTimer) clearTimeout(rt.compactTimer);
    rt.compactTimer = null;
    rt.skipCompact = true;
    const member = this.store.getMember(memberId);
    if (member) {
      if (error) {
        this.store.appendActivity(memberId, "error", `압축 실패: ${error}`);
      } else {
        this.afterCompacted(member);
      }
      if (member.status !== "asleep") this.settle(this.store.requireMember(memberId));
      if (member.status !== "asleep") void this.pump(memberId);
    }
    this.releaseSlots();
  }

  private afterCompacted(member: Member): void {
    this.store.patchMember(member.id, { contextPct: null });
    this.store.appendActivity(member.id, "compact", "압축 완료");
    if (member.origin !== "adopted") return;
    // 넘겨받은 세션은 규칙이 시스템 프롬프트에 없어 요약에서 흐려진다(스킬 §4).
    const project = this.store.requireProject(member.projectId);
    const text = formatSystem(`압축 뒤 규칙을 다시 보냅니다. 단, 이 세션에는 iamceo 도구(post·ask·status·file·todo)가 연결되어 있지 않으니 찾지 말고, 보고와 질문은 턴 마지막 글로 하세요. 서버가 그 글을 총괄에게 전합니다.\n\n${this.rulesFor(member, project)}`);
    if (!this.store.listPending(member.id).some((d) => d.text === text)) {
      this.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "system", text, wake: false });
    }
  }

  // ---- 실행기 이벤트 ----
  private async onRunnerEvent(e: RunnerEvent): Promise<void> {
    const member = this.store.getMember(e.memberId);
    if (!member) {
      const rt = this.runtimes.get(e.memberId);
      if (rt && e.type === "turn_end") {
        this.clearRuntime(e.memberId, rt);
        this.releaseSlots();
      }
      return;
    }
    switch (e.type) {
      case "status":
        return this.onStatus(member, e.status);
      case "turn_end":
        return this.onTurnEnd(member, e);
      case "activity":
        this.store.appendActivity(member.id, e.kind, e.text);
        return;
      case "context":
        this.store.patchMember(member.id, { contextPct: e.pct });
        return;
      case "subagents":
        this.store.patchMember(member.id, { subagents: e.count });
        return;
      case "session":
        if (e.sessionId !== member.sessionId) this.store.patchMember(member.id, { sessionId: e.sessionId });
        return;
      case "compacted": {
        const rt = this.runtime(member.id);
        if (rt.turn?.kind === "compact") {
          this.endCompact(member.id, rt, null);
        } else {
          rt.skipCompact = true;
          this.afterCompacted(member);
        }
        return;
      }
      case "pane":
        // 프로젝트 탭은 어댑터가 만든 탭으로 고정한다. 사용자가 칸을 자기 탭으로 옮겼다고 그 탭이 프로젝트 탭이 되면 안 된다.
        this.store.patchMember(member.id, { paneId: e.paneId });
        return;
    }
  }

  /** 승인 창 앞에서는 대표가 풀어 줘야 움직인다. 결재함에 안 보이므로 다른 창을 보고 있어도 알린다. */
  private markBlocked(member: Member): void {
    if (member.status !== "blocked") void this.notifyBlocked(member);
    this.store.patchMember(member.id, { status: "blocked" });
  }

  /** 무엇을 승인할지 알림에 같이 싣는다. 창을 못 읽으면 예전 문구다. */
  private async notifyBlocked(member: Member): Promise<void> {
    let body = "승인 창 앞에서 멈췄습니다";
    try {
      const a = await this.memberApproval(member.id);
      if (a) body = `${approvalSummary(a)} · 결재함에서 승인·거절할 수 있습니다`;
    } catch { /* 알림은 그대로 보낸다 */ }
    this.notifyInbox(`${member.name} 승인 대기`, body);
  }

  private onStatus(member: Member, status: "working" | "idle" | "blocked" | "gone"): void {
    if (member.status === "asleep") return;
    const rt = this.runtime(member.id);
    switch (status) {
      case "working":
        // 서버가 넣지 않았는데 칸이 일을 시작했다: 대표가 터미널에 직접 친 일이다.
        if (!rt.turn && !rt.reattaching && this.backendOf(member) === "herdr" && member.status !== "working") {
          rt.direct = true;
          rt.posted = false;
        }
        // waiting 은 이번 턴에 ask 한 것이다. 턴이 끝날 때 정한다.
        if (member.status !== "waiting" && member.status !== "working") this.store.patchMember(member.id, { status: "working" });
        break;
      case "idle":
        // turn_end 가 뒤따른다. 그때 정한다.
        if (!rt.turn) this.settle(member);
        break;
      case "blocked":
        this.markBlocked(member);
        break;
      case "gone":
        this.store.patchMember(member.id, { status: "offline", paneId: null, subagents: 0 });
        rt.turn = null;
        this.releaseSlots();
        return;
    }
    if (status !== "blocked") void this.pump(member.id);
  }

  private async onTurnEnd(member: Member, e: Extract<RunnerEvent, { type: "turn_end" }>): Promise<void> {
    const rt = this.runtime(member.id);
    const turn = rt.turn;
    if (turn?.kind === "control") return;
    if (turn?.kind === "compact") {
      if (turn.interrupted) {
        rt.turn = null;
        if (rt.compactTimer) clearTimeout(rt.compactTimer);
        rt.compactTimer = null;
        // 끊었는데 곧바로 다시 압축하면 멈출 길이 없다. 다음 턴이 끝날 때 다시 판단한다.
        rt.skipCompact = true;
        if (member.status !== "asleep") {
          this.settle(member);
          void this.pump(member.id);
        }
        this.releaseSlots();
        return;
      }
      if (e.isError && isMissingSessionError(e.errorText)) await this.resetSession(member);
      this.endCompact(member.id, rt, e.isError ? (e.errorText ?? "오류") : null);
      return;
    }

    if (e.isError && turn && !turn.interrupted && !turn.sessionRetried && isMissingSessionError(e.errorText)) {
      await this.retryInNewSession(member, rt, turn);
      return;
    }

    rt.turn = null;
    const { posted, direct } = rt;
    rt.posted = false;
    rt.direct = false;
    rt.skipCompact = false;
    this.store.appendActivity(member.id, e.isError ? "error" : "turn_end", e.isError ? (e.errorText ?? "오류") : "턴 끝");
    if (member.subagents !== 0) this.store.patchMember(member.id, { subagents: 0 });

    if (member.status === "asleep") {
      this.releaseSlots();
      return;
    }
    if (turn?.interrupted) {
      this.settle(member);
    } else if (e.isError && e.noOutput && turn?.deliveries?.length) {
      await this.onTurnUnread(member, rt, turn.deliveries, e.errorText ?? "오류");
    } else if (e.isError) {
      await this.onTurnError(member, e.errorText ?? "오류");
    } else {
      this.settle(member, true);
      const tidied = member.kind !== "worker" && !!turn?.deliveries?.some(isTidy);
      // 이 턴에 스스로 정리한 것은 다음 판 정리의 '바뀐 것'으로 치지 않는다.
      if (tidied) this.store.setBoardTidiedAt(member.projectId, new Date().toISOString());
      // 판 정리만 받은 턴은 바뀐 게 없으면 아무것도 올리지 않기로 했다. 마지막 글은 활동에만 남긴다.
      const tidyOnly = tidied && !!turn?.deliveries?.every((d) => d.kind === "system");
      if (!posted && e.finalText.trim()) {
        if (tidyOnly) this.store.appendActivity(member.id, "system", `판 정리: ${normalizeSpace(e.finalText).slice(0, 300)}`);
        else await this.fallbackReport(member, e.finalText, direct);
      }
    }
    await this.pump(member.id);
    this.releaseSlots();
  }

  private async onTurnError(member: Member, errorText: string): Promise<void> {
    this.store.patchMember(member.id, { status: "error", lastError: errorText });
    this.systemMessage(member.projectId, `${member.name} 오류: ${errorText}`);
    if (member.kind === "worker") await this.reportToConductor(member, "막힘", "(자동) 턴 오류", errorText, true);
  }

  /**
   * 턴이 입력을 읽고 일하기 전에 오류로 끝났다(사용량 한도 등). 받은 것으로 표시하면 대표의 답이 사라진다.
   * 대기로 되돌려 시간을 두고 다시 보내고, 상한을 넘으면 대표에게 돌려준다.
   */
  private async onTurnUnread(member: Member, rt: Runtime, deliveries: Delivery[], errorText: string): Promise<void> {
    this.store.patchMember(member.id, { status: "error", lastError: errorText });
    // 상한은 전달마다 따로 센다. 방금 들어온 전달이 앞선 전달의 횟수에 끌려 실패하면 안 된다.
    const live = deliveries.flatMap((d) => this.store.getDelivery(d.id) ?? []);
    const maxAttempts = Math.max(0, ...live.map((d) => d.attempts));
    let givenUp = false;
    let keptRefless = false;
    for (const d of live) {
      const giveBack = d.attempts >= MAX_TURN_ERROR_ATTEMPTS && (d.refType === "message" || d.refType === "decision");
      if (giveBack && d.refId) {
        givenUp = true;
        this.store.markFailed(d.id, errorText);
        if (d.refType === "message") this.store.setMessageDelivery(d.refId, "failed", errorText);
        else {
          this.store.reopenDecision(d.refId);
          this.systemMessage(member.projectId, `${member.name}에게 결재 답을 전하지 못했습니다. 결재함에서 다시 답해 주세요`);
        }
        continue;
      }
      // 대표에게 돌려줄 글이 없는 전달(보고·지시·알림·완료)은 실패시키면 받을 사람이 영영 모른다. 상한을 넘어도 잃지 않고 다시 보낸다.
      this.store.requeueDelivered(d.id);
      if (d.attempts >= MAX_TURN_ERROR_ATTEMPTS) {
        keptRefless = true;
        this.hold(d, "turn_error");
      }
      if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "queued", `턴 오류로 다시 보낼 예정입니다: ${errorText.slice(0, 80)}`);
      if (d.refType === "decision" && d.refId && this.store.getDecision(d.refId)?.status === "delivered") this.store.setDecisionStatus(d.refId, "answered");
    }
    const wait = this.timings.turnErrorRetryMs * Math.max(1, Math.min(maxAttempts, MAX_TURN_ERROR_ATTEMPTS));
    if (maxAttempts < MAX_TURN_ERROR_ATTEMPTS) {
      this.systemMessage(member.projectId, `${member.name} 턴이 시작하자마자 끝나 입력을 다시 보냅니다(${maxAttempts}/${MAX_TURN_ERROR_ATTEMPTS}): ${errorText}`);
      if (rt.retryTimer) clearTimeout(rt.retryTimer);
      rt.retryTimer = null;
      rt.holdUntil = Date.now() + wait;
      this.retryLater(member.id, rt, wait);
      return;
    }
    // 방금 들어온 전달이 섞여 있으면 평소 간격으로, 상한을 넘은 것만 남았으면 멀리 두고 다시 보낸다.
    if (live.some((d) => d.attempts < MAX_TURN_ERROR_ATTEMPTS && d.refType !== null)) {
      rt.holdUntil = Date.now() + wait;
      this.retryLater(member.id, rt, wait);
    } else if (keptRefless || this.store.listPending(member.id).length > 0) {
      this.holdHeld(member.id, rt, this.timings.turnErrorRetryMs);
    }
    // 상한을 처음 넘길 때만 알린다. 그 뒤의 재시도마다 대화와 총괄을 깨우지 않는다.
    if (givenUp || maxAttempts === MAX_TURN_ERROR_ATTEMPTS) await this.onTurnError(member, errorText);
  }

  /** post 를 안 부른 턴의 마지막 글(§6). 직원은 총괄에게 보고, 총괄·본사 AI 는 대표에게 하는 말. */
  private async fallbackReport(member: Member, finalText: string, direct: boolean): Promise<void> {
    if (member.kind !== "worker") {
      this.store.createMessage({ projectId: member.projectId, memberId: member.id, who: member.name, kind: "답변", body: finalText });
      return;
    }
    const firstLine = normalizeSpace(finalText.split("\n")[0] ?? "").slice(0, 60);
    const title = `${direct ? "(직접) " : ""}(자동) ${firstLine}`;
    this.store.createMessage({ projectId: member.projectId, memberId: member.id, who: member.name, kind: "알림", title, body: finalText });
    await this.reportToConductor(member, direct ? "(직접) (자동) 알림" : "(자동) 알림", firstLine, finalText.trim() === firstLine ? "" : finalText, true);
  }

  private async resetSession(member: Member): Promise<Member> {
    const project = this.store.requireProject(member.projectId);
    const runner = this.runnerOf(member);
    this.store.patchMember(member.id, { sessionId: null, contextPct: null });
    const fresh = this.store.requireMember(member.id);
    const sent = this.desiredConfig(fresh);
    const started = await runner.start(this.runnerMember(fresh, project), this.writeRunFiles(fresh, project, false));
    this.applyStarted(member.id, project, started, sent);
    return this.store.requireMember(member.id);
  }

  /** --resume 이 세션을 못 찾았다. 턴 자리는 그대로 두고 새 세션에 같은 글을 넣는다. */
  private async retryInNewSession(member: Member, rt: Runtime, turn: Turn): Promise<void> {
    const project = this.store.requireProject(member.projectId);
    const runner = this.runnerOf(member);
    const note = this.newSessionNote(member);
    turn.sessionRetried = true;
    turn.text = `${note}\n\n${turn.text}`;
    this.systemMessage(member.projectId, `${member.name}의 이전 세션을 찾지 못해 새 세션으로 이어갑니다`);
    let result: SendResult;
    try {
      const fresh = await this.resetSession(member);
      if (fresh.parallel) {
        this.store.patchMember(member.id, { parallel: false });
        rt.wantParallel = true;
      }
      const ready = this.store.requireMember(member.id);
      if (rt.wantParallel !== null) await this.applyParallel(ready, project, runner, rt);
      const current = this.store.requireMember(member.id);
      result = await this.safeSend(() => runner.send(this.runnerMember(current, project), turn.text, this.writeRunFiles(current, project), false));
    } catch (e) {
      result = { ok: false, reason: "error", detail: (e as Error).message, retryable: false };
    }
    if (result.ok) return;
    rt.turn = null;
    await this.onTurnError(member, result.detail ?? "새 세션을 띄우지 못했습니다");
    this.releaseSlots();
  }

  /** 열린 결재가 있으면 waiting, 아니면 idle. */
  private settle(member: Member, clearError = false): void {
    const open = member.origin !== "manual" && this.store.listOpenDecisionsByMember(member.id).length > 0;
    const status = open ? "waiting" : "idle";
    if (member.status === status && !clearError) return;
    this.store.patchMember(member.id, { status, ...(clearError ? { lastError: null } : {}) });
  }

  /** 깨어 있는 직원이 상한을 넘으면 총괄에게 후보만 알린다. 잠재우기는 총괄 판단(§6). */
  private checkAwakeLimit(projectId: string): void {
    const max = this.store.getSettings().maxAwakeWorkers;
    const workers = this.store.listMembers(projectId).filter((m) => m.kind === "worker" && m.origin !== "manual");
    // 칸이 없는 offline(가져온 명부, 사라진 칸)은 깨어 있는 세션이 아니다.
    const awake = workers.filter((m) => m.status !== "asleep" && m.status !== "offline");
    if (awake.length <= max) return;
    const conductor = this.store.getConductor(projectId);
    if (!conductor) return;
    const candidates = awake
      .filter((m) => (m.status === "idle" || m.status === "waiting") && m.queuedCount === 0 && this.store.listOpenDecisionsByMember(m.id).length === 0)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((m) => m.name);
    const list = candidates.length ? `잠재울 후보(오래된 순): ${candidates.join(", ")}` : "지금 잠재울 수 있는 직원이 없습니다";
    this.store.enqueue({
      projectId,
      memberId: conductor.id,
      kind: "system",
      text: formatSystem(`깨어 있는 직원이 ${awake.length}명으로 상한 ${max}명을 넘었습니다. ${list}`),
      wake: false,
    });
  }

  // ---- 도움 ----
  private systemMessage(projectId: string, body: string): void {
    this.store.createMessage({ projectId, who: "시스템", kind: "시스템", body });
  }

  private runtime(memberId: string): Runtime {
    let rt = this.runtimes.get(memberId);
    if (!rt) {
      rt = { turn: null, pumping: null, again: false, posted: false, direct: false, skipCompact: false, compactRequest: null, compactTimer: null, retryTimer: null, inputBusySince: null, wantParallel: null, starting: null, reopening: null, closing: false, parallelFails: 0, reattaching: false, holdUntil: 0, configFails: 0, configGaveUp: null };
      this.runtimes.set(memberId, rt);
    }
    return rt;
  }

  private clearRuntime(memberId: string, rt: Runtime): void {
    if (rt.compactTimer) clearTimeout(rt.compactTimer);
    if (rt.retryTimer) clearTimeout(rt.retryTimer);
    this.waiting.delete(memberId);
    this.runtimes.delete(memberId);
  }

  /** 이 직원의 세션을 다루는 실행 방식. 세션을 시작한 실행기로 계속 다룬다. 아직 없으면 전역 설정. */
  private backendOf(member: Member): Backend {
    return member.backend ?? this.store.effectiveBackend();
  }

  private runnerOf(member: Member): Runner {
    const backend = this.backendOf(member);
    const runner = this.runners.get(backend);
    if (!runner) throw new ApiError(503, `실행기가 없습니다: ${backend}`);
    return runner;
  }

  /** 세션을 새로 띄우거나 다시 열 때. 전역 실행 방식을 따르고 그것을 기억한다. */
  private openRunner(member: Member): Runner {
    const backend = this.store.effectiveBackend();
    const runner = this.runners.get(backend);
    if (!runner) throw new ApiError(503, `실행기가 없습니다: ${backend}`);
    if (this.store.getMember(member.id) && member.backend !== backend) {
      this.store.patchMember(member.id, { backend });
      member.backend = backend;
    }
    return runner;
  }

  private runnerMember(member: Member, _project: Project): RunnerMember {
    const settings = this.store.getSettings();
    return {
      id: member.id,
      projectId: member.projectId,
      handle: member.handle,
      name: member.name,
      cwd: member.cwd,
      sessionId: member.sessionId,
      paneId: member.paneId,
      ...memberConfig(member, settings.ranks),
      subagentModel: settings.ranks.staff.model,
      permissionMode: settings.permissionMode,
      kind: member.kind,
      origin: member.origin,
    };
  }

  private rulesFor(member: Member, project: Project): string {
    const conductor = this.store.getConductor(project.id);
    const staffEffort = this.store.getSettings().ranks.staff.effort;
    return renderRole(member.kind, { PROJECT: project.name, NAME: member.name, ROLE: member.role, CONDUCTOR: conductor?.name ?? "총괄", SUBAGENT_EFFORT: staffEffort ? `- 서브에이전트·워크플로를 부를 때 effort=${staffEffort} 을 넘긴다.` : "" }, this.config.rolesDir);
  }

  /** 시스템 프롬프트·MCP 설정 파일을 쓴다. MCP 설정에 멤버 토큰이 들어가 본인만 읽게 한다. */
  private writeRunFiles(member: Member, project: Project, resume: boolean = !!member.sessionId): StartOpts {
    const dir = join(this.config.home, "run");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const systemPromptFile = join(dir, `${member.id}.rules.md`);
    const mcpConfigFile = join(dir, `${member.id}.mcp.json`);
    writeFileSync(systemPromptFile, this.rulesFor(member, project));
    const env = { IAMCEO_URL: this.serverUrl, IAMCEO_TOKEN: this.store.getMemberToken(member.id) };
    writeFileSync(mcpConfigFile, `${JSON.stringify({ mcpServers: { iamceo: { ...mcpCommand(), env } } }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(mcpConfigFile, 0o600);
    // 넘겨받은 칸은 대표의 탭에 있다. 그 세션을 근거로 대표의 탭을 프로젝트 탭으로 믿으면 새 칸이 거기 생긴다.
    const projectSessions = this.store.listMembers(project.id).flatMap((m) => (m.origin === "adopted" ? [] : (m.sessionId ?? [])));
    // 바이패스는 대표가 설정에서 고른 모드다. 첫 경고 창이 아무도 안 보는 칸에서 일을 막지 않게 한다.
    let settingsFile: string | undefined;
    if (this.store.getSettings().permissionMode === "bypassPermissions") {
      settingsFile = join(dir, `${member.id}.settings.json`);
      writeFileSync(settingsFile, `${JSON.stringify({ skipDangerousModePermissionPrompt: true })}\n`, { mode: 0o600 });
    }
    return { systemPromptFile, mcpConfigFile, resume, herdrTabId: project.herdrTabId, projectName: project.name, projectSessions, settingsFile };
  }
}

/**
 * 인용이 낱말 경계에 맞게 들어 있는가. '삭제는 하지 마'에서 '삭제'만 잘라 오면 조사에서 끊겨 맞지 않는다.
 * 공백·문장 부호에서 시작하고 끝나야 한다.
 */
function includesWhole(text: string, quote: string): boolean {
  const boundary = /[\s.,!?;:…·"'“”‘’()[\]{}<>~\-—–/]/;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const before = at === 0 ? " " : text[at - 1]!;
    const after = at + quote.length >= text.length ? " " : text[at + quote.length]!;
    if (boundary.test(before) && boundary.test(after)) return true;
  }
  return false;
}

/** 깨움 없는 것을 앞에 묶는다(§6). */
function orderForBundle(pending: Delivery[]): Delivery[] {
  return [...pending.filter((d) => !d.wake), ...pending.filter((d) => d.wake)];
}

const NO_INPUT_BOX = "입력칸을 찾지 못했습니다. 선택 창이나 다른 화면이 떠 있는 것 같습니다. 닫은 뒤 다시 시도하세요";

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./:=@]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function adoptWarnings(project: Project, live: LiveAgent, seen: PaneInspection | null): AdoptWarning[] {
  const out: AdoptWarning[] = [];
  const traces = seen?.traces ?? [];
  if (traces.length > 0) out.push({ kind: "conductor", text: `다른 지휘자가 있을 수 있습니다. ${traces.join(" · ")}. 지휘자가 둘이면 지시와 보고가 엇갈립니다` });
  if (live.cwd && live.cwd !== project.cwd && !live.cwd.startsWith(`${project.cwd.replace(/\/$/, "")}/`)) out.push({ kind: "folder", text: `이 프로젝트 폴더가 아닙니다. 세션 폴더: ${live.cwd} · 프로젝트 폴더: ${project.cwd}` });
  if (seen?.inputEmpty === false) out.push({ kind: "input", text: "입력칸에 쓰던 글이 있습니다. 넘겨받으면 그 글을 지우고 규칙을 넣습니다" });
  return out;
}

/** 서버 컴퓨터의 터미널에서 CLI 를 부르는 명령. 화면의 안내가 그대로 동작해야 한다. */
export function cliCommand(): string {
  if (Bun.which("iamceo")) return "iamceo";
  const { command, args } = mcpCommand();
  return [command, ...args.slice(0, -1)].map(shellQuote).join(" ");
}

/** 컴파일 실행이면 자기 자신, 아니면 bun 으로 CLI 를 띄운다. */
export function mcpCommand(): { command: string; args: string[] } {
  if (import.meta.path.startsWith("/$bunfs/")) return { command: process.execPath, args: ["mcp"] };
  return { command: process.execPath, args: [resolve(import.meta.dir, "..", "bin", "iamceo.ts"), "mcp"] };
}
