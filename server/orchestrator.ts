import { configuredSecretRoots } from "./secret-paths.ts";
import { createHash, randomUUID } from "node:crypto";
import { ModelCatalogReader } from "./models.ts";
import { CONTROL_UNKNOWN_NOTE, CORE_RECONNECT_HELD_NOTE, HOLD_NOTES, REOPEN_RETRY_NOTE, startingUnknownNote, stopCheckHeldNote } from "./hold-codes.ts";
import { ApiRecovery, classifyTurnError, limitedModelName, modelCreditLimit, NoTerminalError, USAGE_MODEL_PREFIX, usageModelResumeText, withRo, type ApiRecoveryOptions } from "./api-outage.ts";
import { DeliveryRecovery, type RecoveryRunner } from "./delivery-recovery.ts";
import { verdictRejudged, type PumpVerdictCode } from "./pump-verdict.ts";
import { writeStatuslineWrapper } from "./runner/statusline.ts";
import { endedByRestart, RESTART_EXIT_NOTE, RESTART_REOPENED_NOTE, RESTART_RESUME_TEXT, RESTART_WAKE_MAX_ATTEMPTS, RESTART_WAKE_PACING, restartNoteIn, type RestartWake, type RestartWakePacing } from "./restart-wake.ts";
// Orchestrator: 전달 펌프, 턴 종료 처리, 압축 판단, 띄우기·잠재우기·다시 열기, 승인 근거 확인(spec §4·§6·§7).
//
// server/agent-tools.ts 가 쓰는 공개 메서드:
//   팀       addMember · assign · compactMember · sleepMember · resumeMember · closeMember · changeMemberModel · roster
//   보고     recordPost · registerAsk · setMemberStatus · setProjectNow · setWork
//   직접 CLI waitInbox · askWait
//   프로젝트 createProject · ensureConductor
//   그 밖의 읽기·쓰기(file·todo·project_list)는 orch.store 를 그대로 쓴다.
// agent-tools.ts 는 다음 두 함수를 내보낸다(AgentToolsImpl).
//   listAgentTools(member): AgentToolDef[]
//   handleAgentTool(orch, member, name, args): Promise<AgentToolResult>
//
// 조립 순서: createOrchestrator(config, store) → startServer(ctx) → setServerUrl(url) → recover() · 끝낼 때 shutdown().
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  AnswerApprovalReq,
  ApprovalPrompt,
  AnswerReq,
  Attachment,
  Backend,
  BlockedCode,
  CliProvider,
  CreateMemberReq,
  EngineStatus,
  RuntimeInfo,
  CreateProjectReq,
  Decision,
  DecisionCloseKind,
  DecisionCloseFollowUp,
  DecisionOption,
  Delivery,
  Effort,
  Member,
  MemberKind,
  Message,
  MessageKind,
  PatchProjectReq,
  Project,
  PatchMemberReq,
  SendMessageReq,
  Settings,
  SettingsPatch,
  TidyResult,
  Todo,
  TodoOutcome,
  WorkItem,
  WorkSec,
} from "../shared/types.ts";
import { memberConfig } from "../shared/types.ts";
import { CORE_VERSION, type Config } from "./config.ts";
import { briefly, type AgentToolDef, type AgentToolResult, type AskWaitResult, type OrchestratorApi } from "./orchestrator-api.ts";
import { sanitizeName } from "./files.ts";
import { josa, renderRole } from "./roles.ts";
import { CoreError, coreRpc, type CoreHello, type CoreTerminal } from "./runner/core-client.ts";
import { CoreSupervisor } from "./core-supervisor.ts";
import type { DeliveryDispatch, ReportReferences, LifecycleJournal } from "./service-contracts.ts";
import type { DeliveryRecoveryRequest, DeliveryRecoveryResult } from "../shared/types.ts";
import type { ErrorCode } from "../shared/error-codes.ts";
import type { AgentOperationContext, ManualInboxBatch, ManualInboxAckRequest, ManualInboxAckResult, FreshSessionRequest, MemberConfigWriteResult, OperationReceipt, RevisionPrecondition, SettingsWriteResult, TerminalControlRequestV2, TodoDoneRequest, TodoWriteResult } from "../shared/operations.ts";
import { coreContextMeasurement, observeCompactBoundary, type CompactBoundaryBaseline } from "./runner/core-context.ts";
import { readJsonlRange, parseCodexSessionMeta, jsonObject } from "./runner/delivery-evidence.ts";
import { defaultClaudeHome, findSessionFile, isMissingSessionError } from "./runner/session-files.ts";
import { providerLaunch } from "./runner/providers.ts";
import { CoreRunner, ensureCoreServer, eofLogBaseline, type CoreCompactState, type CoreRunnerDeps, type CoreRunnerOptions } from "./runner/core.ts";
import { approvalSummary } from "./runner/core-approval.ts";
import { ToolPermissions, type ToolPermissionPoll, type ToolPermissionRequest } from "./tool-permission.ts";
import { exactSource, measureContext } from "./runner/context.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts, TerminalControlAction, TerminalControlResult, RunnerStartResult, RunnerTerminalIdentity, RunnerReattachResult, DeliveryRepair } from "./runner/types.ts";
import { ApiError, type AppliedConfig, type ExecutionJournal, type NewDelivery, type Store } from "./store.ts";
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
  if (t.outcome === "dropped") return `[대표] '${quotedInline(t.title)}' 필요 없음 #${t.id}\n${t.closeReason ?? "대표가 필요 없음으로 정리"}`;
  return `[대표] '${quotedInline(t.title)}' 했음 #${t.id}${t.completionNote != null ? `\n[대표 완료 답 원문]\n${t.completionNote}\n[대표 완료 답 끝]` : ""}${t.completionFileIds?.length ? `\n대표가 올린 첨부: ${t.completionFileIds.join(", ")}` : ""}`;
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
    "- 3일 넘은 열린 할 일은 직접 확인할 수 있으면 확인 결과를 이유로 todo_close(done), 필요 없어졌으면 dropped로 닫는다. 대표 브라우저를 여는 확인(Aside 등)은 하지 않는다. 확인할 수 없으면 그대로 둔다. 부탁한 직원(없으면 총괄)에게 깨우지 않는 자동 안내가 가며 다음에 그 일을 할 때 확인한다.",
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

export interface OrchestratorTimings extends RestartWakePacing {
  inputBusyRetryMs: number;
  /** Maximum wait for one external pump operation, including its read guards. */
  pumpStageTimeoutMs: number;
  /** A pump still running after this long is reported once (diagnostics only). */
  stuckPumpMs: number;
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
  /** 종료할 때 진행 중인 전달·세션 기동이 결과를 기록하기를 기다리는 상한. */
  shutdownDrainMs: number;
  /** 결과를 모르는 세션 기동을 '뜨지 않음'으로 닫기 전에 기다리는 시간. 기동 요청 제한(20초)과 단계 제한보다 길어야 한다. */
  startGraceMs: number;
  /** 화면 요청(bootstrap·readiness·보내기 전 확인)이 실행기 응답을 기다리는 상한. 넘으면 마지막으로 아는 상태로 답한다. */
  screenWaitMs: number;
  /** 띄운 뒤 이 시간 안에 끝난 세션은 '시작 직후 종료'로 센다. 3번 이어지면 quickExitRetryMs 동안 자동으로 다시 띄우지 않는다. */
  quickExitMs: number;
  quickExitRetryMs: number;
  /** 새 설정으로 다시 여는 데 실패한 꺼진 직원을 다시 열어 보기까지. 두 번째 실패부터는 5배. */
  configRetryMs: number;
  /** 전송 호출이 끝난 뒤 이만큼 지나면 그 쓰기에서 더 올 것이 없다고 본다. 전송 제한(20초)보다 길어야 한다. */
  writeSettleMs: number;
  /** 실행 엔진(herdr-core)이 이만큼 이어서 답하지 않으면 화면에 '응답 없음'으로 알린다. */
  engineUnresponsiveMs: number;
  /**
   * 막힘이 이만큼 이어진 뒤에만 대표에게 알린다(Mac 알림). 명부의 막힘 표시와 승인 카드는 곧바로 보인다.
   * 깨운 직후 CLI 가 준비를 알리기 전의 몇 초가 막힘으로 스쳐, 승인 창이 없는데도 '승인 대기' 알림이 떴다(2026-11-12 실측).
   */
  blockedNoticeMs: number;
}

const DEFAULT_TIMINGS: OrchestratorTimings = {
  inputBusyRetryMs: 5000,
  pumpStageTimeoutMs: 45_000,
  stuckPumpMs: 60_000,
  inputBusyLimitMs: 60_000,
  retryMs: 5000,
  tickMs: 30_000,
  compactTimeoutMs: 600_000,
  turnErrorRetryMs: 60_000,
  manualIdleMs: 5 * 60_000,
  manualOfflineMs: 30 * 60_000,
  healthMs: 5000,
  shutdownDrainMs: 5000,
  startGraceMs: 90_000,
  screenWaitMs: 1000,
  quickExitMs: 60_000,
  quickExitRetryMs: 10 * 60_000,
  configRetryMs: 60_000,
  writeSettleMs: 30_000,
  engineUnresponsiveMs: 60_000,
  blockedNoticeMs: 5000,
  ...RESTART_WAKE_PACING,
};

/** 대표가 프로젝트를 만들며 폴더를 신뢰한다고 답했을 때만 고르는 선택지. 실측한 창의 글자와 정확히 같아야 한다. */
const TRUST_OPTION_LABELS = ["Yes, I trust this folder", "Trust and continue"];
/** 한 세션에서 폴더 신뢰 창에 자동으로 답해 보는 횟수의 상한. 넘으면 대표에게 맡긴다. */
const MAX_AUTO_TRUST_ATTEMPTS = 2;

/** "hc 1.2.3" 같은 글에서 버전만 고른다. 버전 꼴이 없으면 글자 그대로 비교한다. */
function versionIn(raw: string): string {
  return /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(raw)?.[0] ?? raw.trim();
}

class MissingSessionError extends Error {
  constructor() { super("이어갈 세션 기록이 없습니다"); }
}

/** 설정·병렬 제어 오류의 제한된 재시도 상한. 업무 입력은 전달 복구만 재시도한다. */
const MAX_TURN_ERROR_ATTEMPTS = 3;

export interface OrchestratorDeps {
  apiRecovery?: Pick<ApiRecoveryOptions, "probe" | "now" | "urls" | "intervalMs">;
  config: Pick<Config, "home" | "rolesDir" | "port"> & Partial<Pick<Config, "claudeBin" | "codexBin" | "coreBin" | "coreSocket" | "claudeHome" | "codexHome">>;
  store: Store;
  runners: Map<Backend, Runner>;
  serverUrl?: string;
  agentTools?: AgentToolsImpl;
  timings?: Partial<OrchestratorTimings>;
  /** 맥 알림. 시험에서는 넣지 않으면 아무것도 안 한다. */
  notifier?: (title: string, body: string) => void;
  deliveryRecovery?: DeliveryRecovery;
  /** 주입한 CoreRunner와 같은 기록 루트. 시험은 임시 경로만 사용한다. */
  providerHomes?: { claudeHome: string; codexHome: string };
}

export interface NewMemberInput {
  cli?: CliProvider;
  modelOverride?: string | null;
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
  group?: string | null;
  correctsMessageId?: string | null;
  supersedes?: string | null;
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

const APPROVAL_CARD_INSTRUCTION = "보고에 대표 승인이 필요하다고 썼는데 열린 결재 카드가 없다. 지금 ask 로 카드를 올리거나, 필요 없으면 보고를 정정하라.";

/** 단어만으로 막지 않는다. 앞으로 받을 판단과 이미 받은 판단·불필요·CLI 승인을 구분한다. */
function needsApprovalCard(text: string): boolean {
  const prose = text.replace(/```[^]*?```|~~~[^]*?~~~/g, "").replace(/^\s*>.*$/gm, "");
  return prose.split(/[\n.!?;,。]|(?:하지만|그러나|지만)/).some(part => {
    const clause = part
      .replace(/(?:터미널|CLI|cli|명령(?:어)?|도구|실행|권한|샌드박스)\s*(?:승인|허락)(?:\s*창)?/g, "")
      .replace(/승인\s*창/g, "")
      .replace(/(?:승인|결재|허락)\s*(?:요청\s*)?(?:기능|로직|문구|테스트|시험|규칙|카드\s*UI)/g, "")
      .replace(/(?:승인|허락|결재)\s*요청(?:은|을)?\s*(?:하지\s*않|안\s*했)/g, "")
      .replace(/(?:대표(?:님)?(?:의)?\s*)?(?:승인|허락|결재|확인|결정)(?:은|는|이|가|을|를)?\s*(?:불필요|필요\s*(?:없|하지\s*않)|요청하지\s*않|받지\s*않아도|(?:이미\s*)?(?:받았|받음|완료|끝났|끝남))/g, "")
      .replace(/(?:대표(?:님)?(?:이|께서)?\s*)?(?:승인|허락|결재|확인|결정)(?:을|를)?\s*(?:해\s*주셨|하셨|했습|했음)/g, "")
      .replace(/(?:여쭙|여쭈|여쭤)(?:지\s*않|지\s*말|지\s*않아도|었|봤)/g, "");
    if (/(?:승인|허락|결재|대표(?:님)?(?:의)?\s*(?:확인|결정))\s*(?:후|뒤).*(?:했습니다|했음|끝냈습니다|마쳤습니다)\s*$/.test(clause)
      && !/(?:필요|대기|여쭙|여쭈|여쭤)/.test(clause)) return false;
    return /(?:승인|허락|결재)(?:을|를|이|가|은|는)?\s*(?:뒤|후|전|대기|필요|요청|받아야|받으면|받고|받은\s*(?:뒤|후)|받기\s*전|부탁|올려야|올릴)/.test(clause)
      || /대표(?:님)?(?:의)?\s*(?:확인|결정)(?:을|를|이|가|은|는)?\s*(?:필요|대기|기다|요청|뒤|후|전|받아야|받으면|받고|부탁|바랍니다|해\s*주)/.test(clause)
      || /(?:대표(?:님)?(?:의)?\s*(?:확인|결정)|승인|허락|결재)\s*$/.test(clause)
      || /(?:여쭙|여쭘|여쭈|여쭤|정해\s*주시면)/.test(clause);
  });
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

/** 사용 한도로 보류 중인 팀장의 설정 변경. runId: 멈출 때 하던 실행(이어가기 글을 넣을 것). 쉬던 중 걸렸으면 null. */
interface UsageStop { runId: string | null }

/**
 * 설정 변경(patchMemberConfig)이 실제로 한 일. 총괄의 team_model 답이 서버가 한 일과 어긋나지 않게 부른 쪽이 넘겨 받는다.
 * usage: 사용 한도 보류를 풀었다. continued: 멈춘 일의 이어가기 글을 넣었다(같은 대화를 이어 열 수 있었다).
 * opened: resumed 같은 세션을 새 설정으로 이어 열었다 · fresh 새 세션으로 열었다 · later 지금은 열지 않았다(잠듦·꺼짐, 또는 다시 여는 데 실패해 곧 다시 연다).
 */
interface ConfigOutcome { usage: boolean; continued: boolean; opened: "resumed" | "fresh" | "later" | null }

interface Turn {
  kind: "work" | "compact" | "control";
  boardReview?: { requestedRevision: number; reviewedRevision: number | null };
  text: string;
  interrupted: boolean;
  /** 이 턴으로 나간 전달. 수신 여부는 별도 복구 증거로만 판단한다. */
  deliveries?: Delivery[];
  /** 같은 턴에 ask를 이미 올렸으면 보고에서 다시 카드를 요구하지 않는다. */
  askedDecisionIds?: Set<string>;
}

interface Runtime {
  /** 화면 추정은 토큰이 달라진 다음 읽기와 맞아야 저장한다. */
  contextCandidate: { sessionId: string | null; window: number; tokens: number } | null;
  turn: Turn | null;
  pumping: Promise<void> | null;
  /** Where the current pump is waiting and since when (diagnostics only; never used to send or interrupt). */
  pumpStage: string | null;
  pumpSince: number | null;
  pumpReported: boolean;
  again: boolean;
  posted: boolean;
  delegated: boolean;
  direct: boolean;
  /** 방금 압축했거나 압축이 실패했다. 다음 턴이 끝나 새 usage 를 받기 전까지 다시 압축하지 않는다. */
  skipCompact: boolean;
  compactRequest: string | null;
  compactTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inputBusySince: number | null;
  /** 준비 보고(idle)를 기다리기 시작한 때. */
  readySince: number | null;
  /** 압축을 넣으려다 입력칸·창 때문에 미루기 시작한 시각. 오래 이어지면 압축을 접고 전달을 먼저 보낸다. */
  compactBusySince: number | null;
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
  /** 새 설정으로 다시 열기를 포기한 설정. 설정이 또 바뀌면 다시 시도한다. */
  configGaveUp: string | null;
  /** 서버가 이 직원의 CLI 를 새로 띄운 시각. 곧바로 끝나는 세션을 세는 데만 쓴다. */
  launchedAt: number | null;
  /** 띄우자마자 끝난 횟수(연속)와 마지막 시각. 턴이 한 번이라도 끝나거나 대표가 직접 깨우면 0 으로 돌아간다. */
  quickExits: number;
  quickExitAt: number;
  quickExitNotified: boolean;
}


/** 턴 오류·전달 오류가 이어질 때 ref 없는 전달(보고·지시·완료)을 다시 보내는 간격의 배수. 잃지 않되 사용량을 태우지 않게 멀리 둔다. */
const HELD_RETRY_FACTOR = 5;

const WAKE_POST_KINDS = new Set<string>(["완료", "막힘", "질문"]);

/**
 * 작업 영수증의 좁은 사유(reason). 영수증의 code 는 넓은 옛 이름(TERMINAL_REFUSED 등)이라 앱이 사유를 가를 수 없다.
 * ApiError 면 그 reason 이나(넓은 이름과 다르면) 자기 코드, 실행 엔진 거절이면 그 reason. 모르면 싣지 않는다(앱은 그때 옛 방식대로 문장을 본다).
 */
function receiptReason(error: unknown, family: ErrorCode): { reason?: ErrorCode } {
  const reason = error instanceof ApiError ? error.reason ?? (error.code !== family ? error.code : undefined)
    : error instanceof CoreError ? error.reason : undefined;
  return reason ? { reason } : {};
}

/** Domain references also include orphan answers and todo correction notices. */
class OrchestratorDeliveryRecovery extends DeliveryRecovery {
  constructor(private readonly sourceStore: Store, runner: (member: Member) => RecoveryRunner | null, writerDone?: (dispatch: DeliveryDispatch) => boolean, admit?: (memberId: string) => boolean, writing?: (dispatch: DeliveryDispatch) => boolean) {
    super({ store: sourceStore, runner, writerDone, admit, writing, legacyMessageText: message => {
      const file = message.contextFileId ? sourceStore.getFile(message.contextFileId) : null;
      const context = file && file.projectId === message.projectId
        ? `\n[시스템 자료 맥락 · 대표 원문 아님]\n대표가 보던 자료: ${file.title.replace(/[\r\n]+/g, " ")} (${file.id})` : "";
      return formatUserMessage(message.body, message.attachments, message.id, false) + context;
    } });
  }
  override sourceRevision(delivery: Delivery): string | null {
    const revision = super.sourceRevision(delivery);
    if (revision !== null) return revision;
    if (delivery.refType === "decision" && delivery.refId) {
      const decision = this.sourceStore.getDecision(delivery.refId);
      if (decision && decision.projectId === delivery.projectId && ["answered", "delivered"].includes(decision.status) &&
        (!decision.memberId || !this.sourceStore.getMember(decision.memberId)) && this.sourceStore.getConductor(delivery.projectId)?.id === delivery.memberId) {
        return createHash("sha256").update(JSON.stringify({ decision, memberId: delivery.memberId })).digest("hex");
      }
    }
    if (delivery.refType === "todo" && delivery.refId) {
      const todo = this.sourceStore.getTodo(delivery.refId);
      if (todo && todo.projectId === delivery.projectId && (delivery.kind === "system" || delivery.text === formatTodoUndone(todo))) {
        return createHash("sha256").update(JSON.stringify({ todo, revision: this.sourceStore.todoRevision(todo.id), text: delivery.text, memberId: delivery.memberId })).digest("hex");
      }
    }
    return null;
  }
}

/**
 * 팀장의 lastError·활동에 남는 터미널 종료 글. 터미널을 붙잡던 실행 엔진이나 Mac 이 다시 시작돼 CLI 가 함께 꺼진 것(endedByRestart)은
 * CLI 의 잘못이 아니다: 서버가 같은 세션을 스스로 다시 연다(restart-wake.ts).
 */
function exitDetail(reason: string | null | undefined, exitCode: number | null | undefined): string {
  if (endedByRestart(reason)) return RESTART_EXIT_NOTE;
  return `초기/실행 종료: ${reason ?? "원인 미확인"} (exit_code=${exitCode ?? "unknown"})`;
}
/** 재시작으로 터미널을 잃은 종료를 표식의 사유로. 엔진이 그 터미널을 모른다(not_found)는 것도 엔진이 다시 시작된 것이다. CLI 가 스스로 끝났으면 null. */
function restartLossOf(reason: string | null | undefined, exitCode: number | null | undefined): RestartWake["reason"] | null {
  if (reason === "holder_lost" || reason === "stopped_by_restart") return reason;
  return reason === "not_found" && (exitCode === null || exitCode === undefined) ? "terminal_absent" : null;
}
/** 두 팀장 목록이 순서와 상관없이 같은가(사용 한도 카드의 답에 앱이 본 팀장을 실어 보냈을 때). */
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a), right = new Set(b);
  return left.size === right.size && [...left].every(id => right.has(id));
}

/** Runner의 외부 입력 baseline/cursor도 기존 세대별 문맥 행에 함께 저장한다. */
export function coreCompactStore(store: Store): NonNullable<CoreRunnerDeps["compactStore"]> {
  return {
    load(memberId) {
      const state = store.ensureContextState(memberId);
      const saved = state?.baseline?.coreCompact as CoreCompactState | undefined;
      if (!saved) {
        if (state.compaction && ["sending", "running", "uncertain"].includes(state.compaction.phase)) throw new ApiError(409, "미확정 압축의 baseline이 없어 자동 입력을 보류합니다", "compact_baseline_missing");
        return null;
      }
      if (!saved.baseline || !["sending", "running", "uncertain", "succeeded", "failed"].includes(saved.phase)) throw new ApiError(409, "압축 기록이 손상되어 자동 입력을 보류합니다", "compact_record_corrupt");
      if (saved.baseline.generation !== state.generation) return null;
      if (["sending", "running"].includes(saved.phase)) {
        const uncertain: CoreCompactState = { ...saved, phase: "uncertain" };
        store.saveContextState({ ...state, baseline: { ...state.baseline, coreCompact: uncertain },
          compaction: state.compaction ? { ...state.compaction, phase: "uncertain", reason: "send_uncertain" } : null });
        return uncertain;
      }
      return saved;
    },
    save(memberId, compact) {
      const state = store.ensureContextState(memberId);
      const member = store.requireMember(memberId);
      if (state.generation !== compact.baseline.generation || member.sessionId !== compact.baseline.sessionId || member.paneId !== compact.baseline.terminalId) throw new ApiError(409, "문맥 세대나 세션이 변경되었습니다", "context_generation_changed");
      const before = state.compaction;
      if (before && before.id !== compact.id && (compact.phase !== "sending" || !["queued", "succeeded", "failed"].includes(before.phase))) throw new ApiError(409, "다른 압축 작업의 결과입니다", "compact_result_mismatch");
      if (before?.id === compact.id && ["succeeded", "failed"].includes(before.phase) && compact.phase !== before.phase) return;
      const at = new Date().toISOString();
      store.saveContextState({ ...state,
        measurement: compact.phase === "sending" || compact.phase === "succeeded" ? null : state.measurement,
        baseline: { ...state.baseline, coreCompact: compact },
        compaction: { id: compact.id, trigger: before?.trigger ?? "manual", phase: compact.phase,
          reason: compact.phase === "uncertain" ? "send_uncertain" : compact.phase === "failed" ? "provider_error" : null,
          requestedAt: before?.requestedAt ?? at, startedAt: new Date(compact.startedAt).toISOString(),
          finishedAt: ["succeeded", "failed"].includes(compact.phase) ? at : null },
      }, compact.phase === "sending" || compact.phase === "succeeded" ? { contextPct: null } : {});
    },
  };
}

/**
 * 시험이 운영과 같은 배선(복구 저장소·압축 저장소·복구 쓰기·쓰기 종료 판정)으로 core 실행기를 붙일 때만 넘기는 덮어쓰기.
 * 운영(bin/iamceo.ts)은 넘기지 않는다. 배선 자체는 바꿀 수 없고, 경로·간격·알림처럼 시험 환경에 따라 달라지는 값만 받는다.
 */
export interface AssemblyOverrides {
  /** CoreRunner 의 경로 설정(임시 소켓·CLI 기록 폴더 등). */
  runner?: Partial<CoreRunnerOptions>;
  /** CoreRunner 의 간격·제한 시간. 저장소 포트(recoveryStore·compactStore·repair·quiescence)는 덮어쓸 수 없다. */
  runnerDeps?: Omit<CoreRunnerDeps, "recoveryStore" | "compactStore" | "repair" | "quiescence">;
  orchestrator?: Pick<OrchestratorDeps, "agentTools" | "timings" | "notifier" | "providerHomes" | "apiRecovery" | "serverUrl">;
}

/**
 * 갓 띄운 CLI 가 아직 준비를 알리지 않은 것을 '막힘'으로 보지 않는 시간(CoreRunnerDeps.startQuietMs). 2026-11-12 라이브에서 깨운 팀장이
 * 6초 뒤 쉬는 중이 됐는데 그사이 '승인 대기' 알림이 떴다. 이보다 오래 조용하면 예전처럼 막힘으로 보이고, 60초를 넘기면 '시작 지연'이다.
 */
const CORE_START_QUIET_MS = 20_000;

/**
 * 실제 실행기로 조립한다. 실행기는 core 하나다.
 * 옛 herdr·headless 실행기는 없다. 서버는 대표 개인의 herdr 소켓에 아무것도 보내지 않는다.
 */
export function createOrchestrator(config: Config, store: Store, overrides: AssemblyOverrides = {}): Orchestrator {
  const runners = new Map<Backend, Runner>();
  let orchestrator: Orchestrator | null = null;
  const deliveryRecovery = new OrchestratorDeliveryRecovery(store, member => orchestrator?.recoveryRunner(member) ?? null, dispatch => orchestrator?.writerDone(dispatch) ?? false, memberId => orchestrator?.repairAdmitted(memberId) ?? false, dispatch => orchestrator?.writing(dispatch) ?? false);
  // toolPermission(K, E2): 이 서버가 띄우는 Claude 팀장에게 도구 승인 훅을 넣는다(묻지 않기 팀장 제외, providers.ts).
  runners.set("core", new CoreRunner({ contextHome: config.home, coreBin: config.coreBin, socketPath: config.coreSocket, session: "iamceo", stateDir: join(config.home, "core-state"), configDir: join(config.home, "core-config"), claudeBin: config.claudeBin, codexBin: config.codexBin, toolPermission: true, ...overrides.runner }, {
    startQuietMs: CORE_START_QUIET_MS,
    ...overrides.runnerDeps,
    recoveryStore: store,
    compactStore: coreCompactStore(store),
    repair: deliveryRecovery.repair,
    // Generation 1 has no post-write drain or external-attach barrier. A write stays unresolved while its call may
    // still be running; see Orchestrator.dispatchQuiescence for when it is over.
    quiescence: (memberId, dispatch) => orchestrator?.dispatchQuiescence(memberId, dispatch) ?? { originalWrite: dispatch.transportState === "rejected" ? "rejected" : dispatch.transportState === "accepted" ? "settled" : "unresolved", externalInput: null },
  }));
  orchestrator = new Orchestrator({ providerHomes: { claudeHome: defaultClaudeHome(), codexHome: process.env.CODEX_HOME || join(homedir(), ".codex") }, notifier: macNotifier(), ...overrides.orchestrator, config, store, runners, deliveryRecovery });
  return orchestrator;
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
  readonly deliveryRecovery: DeliveryRecovery;
  private readonly deliveryEpoch = randomUUID();
  private readonly config: OrchestratorDeps["config"];
  private readonly runners: Map<Backend, Runner>;
  private readonly timings: OrchestratorTimings;
  private agentTools: AgentToolsImpl | null;
  private serverUrl: string;
  private runtimes = new Map<string, Runtime>();
  /** 동시 턴 상한에 걸려 기다리는 직원. 턴이 끝나면 차례로 다시 민다. */
  private waiting = new Set<string>();
  private askWaiters = new Map<string, Set<() => void>>();
  private inboxWaiters = new Map<string, Set<() => void>>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private lastDeliveryNoticeCheck = 0;
  readonly apiRecovery: ApiRecovery;
  private readonly notifier: ((title: string, body: string) => void) | null;
  /** 보관 전에 넘겨받은 칸을 끝내는 중인 프로젝트. 전달은 보관된 것처럼 멈춘다. */
  private archiving = new Set<string>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthProbe: Promise<void> | null = null;
  private healthKnown: Promise<void> | null = null;
  private recovering = false;
  private stopRecovery: Promise<void> | null = null;
  private readonly coreSupervisor: CoreSupervisor | null;
  private readonly absentCoreMembers = new Map<string, number>();
  /** 미확정 기동 저널이 있는 직원의 소유 터미널이 연속으로 안 보인 횟수. */
  private readonly absentStarts = new Map<string, number>();
  private readonly resolvedStarts = new Set<string>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly observedTurns = new Map<string, { generation: number; terminal: string | null; turn: number; ended: number }>();
  private readonly configWrites = new Set<string>();
  /** 사용 한도 카드마다 지금 도는 답(고른 것과 그 결과). 다른 답이 앞 답의 결과를 받아 가지 않게 한다(answerDecision). */
  private readonly usageAnswers = new Map<string, { choice: string; task: Promise<Decision> }>();
  /** K(E2): 도구 승인 카드와 그 답을 기다리는 훅(server/tool-permission.ts). */
  readonly toolPermissions: ToolPermissions;
  private settingsWriting = false;
  private readonly projectPatches = new Set<string>();
  private readonly terminalMutations = new Set<string>();
  private readonly agentOperations = new Map<string, Promise<AgentToolResult>>();
  private readonly providerHomes: OrchestratorDeps["providerHomes"];

  private readonly models: ModelCatalogReader;

  constructor(deps: OrchestratorDeps) {
    this.models = new ModelCatalogReader(deps.config);
    this.store = deps.store;
    this.providerHomes = deps.providerHomes;
    this.config = deps.config;
    this.runners = deps.runners;
    // 대기 사유는 저장소가 펌프의 판정 줄(recordPumpVerdict)을 읽는다. 여기서는 '다시 확인'과 정체 전 스스로 다시 밀기만 잇는다.
    this.store.setDeliveryHooks({
      recheck: id => {
        // 대표의 '다시 확인'은 이어가기를 포기해 멈춰 둔 직원도 다시 보내 보라는 뜻이다.
        this.apiRecovery.releaseExhausted(id);
        this.store.retryDeferredConfigNow(id);
        this.recheckMemberDelivery(id);
      },
      nudge: id => this.nudgeStalled(id),
    });
    this.deliveryRecovery = deps.deliveryRecovery ?? new OrchestratorDeliveryRecovery(this.store, member => this.recoveryRunner(member), dispatch => this.writerDone(dispatch), memberId => this.repairAdmitted(memberId), dispatch => this.writing(dispatch));
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.agentTools = deps.agentTools ?? null;
    this.notifier = deps.notifier ?? null;
    // K(E2): 허용하며 남긴 메모는 훅의 답에 실을 수 없어 팀장의 다음 입력으로 보낸다(결재와 묶지 않는다: 전달 실패가 카드를 다시 열지 않게).
    this.toolPermissions = new ToolPermissions({ store: this.store, notify: (title, body) => this.notifyInbox(title, body),
      deliverNote: (member, decision) => { this.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "answer", text: formatAnswer(decision) }); void this.pump(member.id); },
      stillBlocked: member => this.notifyInbox(`${member.name} 승인 대기`, "도구 승인 요청에 답이 없어 카드를 닫았습니다. 터미널의 승인 창에서 답해 주세요") });
    this.store.repairRejectedLimit();
    this.apiRecovery = new ApiRecovery({ ...deps.apiRecovery, store: this.store,
      notify: (projectId, text, alertOwner = true) => { this.systemMessage(projectId, text); if (alertOwner) this.store.afterCommit(() => this.notifyInbox("API 연결·사용 한도", text)); },
      pump: id => this.recheckMemberDelivery(id),
      inspect: async member => {
        if (member.status === "asleep" || member.status === "offline") throw new NoTerminalError();
        const runner = this.runners.get(this.backendOf(member));
        if (!runner?.usageLimitSnapshot) throw new Error("사용 한도 화면 판독을 지원하지 않습니다");
        return runner.usageLimitSnapshot(this.runnerMember(member, this.store.requireProject(member.projectId)));
      },
      dismiss: async (member, fingerprint) => {
        const runner = this.runners.get(this.backendOf(member));
        return runner?.dismissUsageLimit ? runner.dismissUsageLimit(this.runnerMember(member, this.store.requireProject(member.projectId)), fingerprint) : { ok: false, note: "창을 닫지 못했습니다" };
      },
      choices: (cli, limited, blocked) => this.usageModelChoices(cli, limited, blocked),
      limitedModels: (member, raw) => this.usageBlockedModels(member, raw),
    });
    this.serverUrl = deps.serverUrl ?? `http://127.0.0.1:${deps.config.port}`;
    const core = this.runners.get("core");
    this.coreSupervisor = core?.reattachOwned ? new CoreSupervisor({
      pollMs: this.timings.healthMs,
      retryMs: this.timings.healthMs,
      presence: async () => {
        if (!(core instanceof CoreRunner)) return (await core.available()).ok ? "owned" : "unknown";
        try {
          const hello = await coreRpc<CoreHello>(this.coreSocket(), "hello", { generation: 1 }, 1000);
          this.coreRefusedSince = null;
          this.noteEngine(hello);
          return hello.generation === 1 ? "owned" : "conflict";
        } catch (error) {
          this.noteEngine(null);
          this.noteCoreRefused(error instanceof CoreError && error.causeCode === "ECONNREFUSED");
          return error instanceof CoreError && error.causeCode === "ENOENT" && error.deliveryEffect === "not_written" ? "absent" : "unknown";
        }
      },
      startOwned: () => ensureCoreServer({ coreBin: this.config.coreBin, socketPath: this.coreSocket(), session: "iamceo", stateDir: join(this.config.home, "core-state"), configDir: join(this.config.home, "core-config") }),
      reattachOwned: async watched => {
        const member = this.store.getMember(watched.id);
        if (!member || this.closed || this.runtime(watched.id).closing || this.runtime(watched.id).starting || this.runtime(watched.id).reopening || this.runtime(watched.id).pumping) return { outcome: "unknown", code: "mutation_in_progress" };
        const rt = this.runtime(member.id);
        const result = await core.reattachOwned!(this.runnerMember(member, this.store.requireProject(member.projectId)));
        if (result.outcome === "rejoined" && !this.closed && this.store.getMember(member.id)) {
          this.applyStarted(member.id, result.started);
          for (const journal of this.store.listPendingLifecycleJournals()) {
            if (journal.memberId === member.id && journal.intent === "start" && journal.identity.sessionGeneration === watched.sessionGeneration) this.finishLifecycle(journal, "confirmed", null, result.started.identity ?? this.identity(this.store.requireMember(member.id)));
          }
          const current = this.store.requireMember(member.id);
          if (current.fenceCode === "starting_unknown" || current.fenceCode === "core_reconnect_held") this.store.patchMember(member.id, { lastError: null });
          // 깨우다 결과를 놓친 기동이 실제로는 떠 있었다. 잠듦으로 두면 살아 있는 CLI 가 명부에서는 잠든 채 남는다.
          if (current.status === "asleep") this.settle(current);
          // 재시작으로 꺼진 줄 알았던 팀장의 터미널이 떠 있다. 서버가 다시 열다 결과를 놓친 것이면 이어 연 것으로 닫는다.
          const lost = this.store.getRestartWake(member.id);
          if (lost && lost.state !== "resumed") this.settleRestartWake(member.id, lost.state === "opening" ? "resumed" : "dropped");
          await this.reconcileExecutions(member.id);
        }
        const resolvedStart = this.resolveAbsentStart(member, result.outcome);
        // 한 번도 뜨지 못한 세션이다. 쉬는 중으로 두면 소유 미확인 관측 때문에 전달이 계속 멈춘다.
        if (resolvedStart && !member.paneId && !["asleep", "offline"].includes(member.status)) this.store.patchMember(member.id, { status: "offline" });
        // 엔진이 답했고 이 팀장의 터미널이 없다. 결과를 모르는 띄우기·끝내기가 없으면, 서버가 띄운 세션은 명부가 무엇이라 적혀 있든 꺼진 것이다.
        // 예전에는 터미널 칸이 비어 있고 상태가 '꺼짐'이 아니면(새 세션 띄우기가 확정 실패해 error 로 남은 팀장) 그대로 두어,
        // 소유 미확인 관측 때문에 전달이 영영 멈추고 깨우기도 아무 일을 하지 않았다. 잠든 팀장은 잠든 그대로 둔다.
        // 넘겨받은 명부(대표의 터미널에 세션이 살아 있을 수 있다)는 예전 조건 그대로다.
        if (result.outcome === "not_found" && !this.pendingLifecycle(member.id) && this.store.getMember(member.id)?.status !== "asleep" &&
            (member.paneId || member.status === "offline" || member.origin === "runner")) {
          if (member.paneId && !(await this.reconcileAbsentTerminal(member))) return { outcome: "unknown", code: "terminal_absence_unverified" };
          // 묻는 사이 다른 길(깨우기, 전달)이 이 팀장을 다시 열기 시작했으면 그쪽이 명부를 정한다.
          const current = this.store.getMember(member.id);
          if (current && current.status !== "asleep" && current.paneId === member.paneId && !rt.reopening && !rt.starting) {
            if (current.status !== "offline" || current.paneId) this.store.patchMember(member.id, { status: "offline", paneId: null });
            rt.turn = null;
            this.releaseSlots();
          }
        }
        if (resolvedStart) this.resolvedStarts.add(member.id);
        return result;
      },
      observed: state => {
        const member = this.store.getMember(state.memberId);
        if (!member || this.closed || state.code === "mutation_in_progress") return;
        const resolvedStart = this.resolvedStarts.delete(member.id);
        if (state.outcome === "not_found" && (member.status === "offline" || member.status === "asleep") && !member.paneId && !this.pendingLifecycle(member.id)) {
          if (member.status === "offline") this.absentCoreMembers.set(member.id, this.store.memberRevisions(member.id).sessionGeneration);
          // 사용 한도로 보류 중인 팀장은 한도 관측(앱의 '사용 한도 도달')을 남긴다. 지우면 앱이 '안 보임 · 새 지시가 오면 다시 엽니다'로 보였는데
          // 새 지시는 한도로 붙잡힌다. 터미널이 없다는 것은 엔진이 답해 확인됐다(verified). 보류가 풀리면 오류만 지워지고 펌프가 평소처럼 다시 연다.
          const usage = member.statusObservation?.error?.code === "usage_limit" && this.apiRecovery.usageLimited(member.id) ? member.statusObservation.error : null;
          this.store.patchMember(member.id, { statusObservation: usage ? { source: "core", observedAt: new Date().toISOString(), freshness: "stale", ownership: "verified", consecutiveFailures: 0, error: usage } : null });
          this.coreSupervisor?.unwatch(member.id);
          // 취소한 기동을 기다리던 전달이 있으면 다시 깨워 보낸다.
          if (resolvedStart && !this.recovering) void this.pump(member.id);
          return;
        }
        const setupError = state.outcome === "rejoined" && core instanceof CoreRunner ? core.observationState(member.id)?.setupError ?? null : null;
        this.store.patchMember(member.id, { statusObservation: this.executionObservation(member, { source: "core", observedAt: state.lastObservedAt === null ? null : new Date(state.lastObservedAt).toISOString(), freshness: state.outcome === "rejoined" ? "fresh" : "stale", ownership: state.outcome === "rejoined" ? "verified" : state.outcome === "conflict" ? "conflict" : "unknown", consecutiveFailures: state.failures, error: state.code ? { code: state.code, note: "소유 터미널을 다시 관측합니다. 후보가 여러 개면 자동 선택하거나 종료하지 않습니다" } : setupError }) });
        if (state.outcome === "rejoined" && !this.recovering) void this.pump(member.id);
      },
    }) : null;
    for (const runner of this.runners.values()) {
      runner.on((event) => {
        const member = this.store.getMember(event.memberId);
        if (member && member.backend && member.backend !== runner.kind) return;
        if (this.runtimes.get(event.memberId)?.closing && (event.type !== "status" || event.status === "gone")) return;
        const before = this.eventQueues.get(event.memberId);
        const pending = (before ? before.then(async () => {
          if (!this.closed) await this.onRunnerEvent(event);
        }) : this.onRunnerEvent(event)).catch((e) => console.error("실행기 이벤트 처리 오류:", event.type, e));
        this.eventQueues.set(event.memberId, pending);
        void pending.finally(() => { if (this.eventQueues.get(event.memberId) === pending) this.eventQueues.delete(event.memberId); });
      });
    }
  }

  /** Serve startup owns a private daemon; diagnostics remain read-only and shutdown leaves it alive. */
  async initializeRuntime(): Promise<void> {
    if (!this.runners.has("core")) return;
    if (this.coreSupervisor) {
      await this.coreSupervisor.tick();
      this.coreSupervisor.start();
    }
    await this.refreshConnection();
  }

  private coreSocket(): string { return this.config.coreSocket ?? join(this.config.home, "run", "core.sock"); }

  private coreRefusedSince: number | null = null;
  private coreRefusedLogged = false;
  /**
   * 소켓 파일은 있는데 아무도 받지 않는 상태가 이어지면 죽은 core 가 남긴 소켓일 수 있다. 살아 있는 core 를 둘로 만들 위험이 있어
   * 자동으로 지우거나 새로 띄우지는 않는다. 왜 실행기가 안 닿는지는 로그에 한 번 남긴다.
   */
  private noteCoreRefused(refused: boolean): void {
    if (!refused) { this.coreRefusedSince = null; this.coreRefusedLogged = false; return; }
    this.coreRefusedSince ??= Date.now();
    if (this.coreRefusedLogged || Date.now() - this.coreRefusedSince < 60_000) return;
    this.coreRefusedLogged = true;
    console.error("[core] herdr-core 소켓 파일은 있지만 1분 넘게 아무도 받지 않습니다. 죽은 core 가 남긴 소켓일 수 있습니다. 자동으로 지우거나 새로 띄우지 않습니다: core 가 정말 내려갔는지 확인한 뒤 소켓 파일을 지우면 다시 띄웁니다");
  }

  private engine: EngineStatus | null = null;
  private engineSilentSince: number | null = null;
  /**
   * 실행 엔진이 답했는지(hello)와 그 버전을 적는다. 잠깐의 끊김(다시 띄우는 몇 초)에는 상태를 바꾸지 않고,
   * engineUnresponsiveMs 넘게 이어서 답이 없을 때만 '응답 없음'으로 바꾼다. 달라지면 화면이 다시 읽게 알린다.
   */
  private noteEngine(hello: CoreHello | null): void {
    let next = this.engine;
    if (hello) {
      this.engineSilentSince = null;
      const version = typeof hello.version === "string" && hello.version.trim() ? versionIn(hello.version) : undefined;
      next = { state: hello.generation === 1 && version === CORE_VERSION ? "ok" : "version_mismatch", ...(version ? { version } : {}), expectedVersion: CORE_VERSION };
    } else {
      this.engineSilentSince ??= Date.now();
      if (Date.now() - this.engineSilentSince >= this.timings.engineUnresponsiveMs) next = { state: "unresponsive", expectedVersion: CORE_VERSION };
    }
    if (JSON.stringify(next) === JSON.stringify(this.engine)) return;
    const before = this.engine;
    this.engine = next;
    if (next && next.state !== "ok") console.warn(next.state === "unresponsive"
      ? `[core] 실행 엔진(herdr-core)이 ${Math.round(this.timings.engineUnresponsiveMs / 1000)}초 넘게 답하지 않습니다`
      : `[core] 떠 있는 실행 엔진의 버전(${next.version ?? "알 수 없음"})이 고정 버전(${CORE_VERSION})과 다릅니다`);
    else if (before && before.state !== "ok") console.warn("[core] 실행 엔진 상태가 정상으로 돌아왔습니다");
    // 따로 이벤트가 없는 변화다. 화면이 스냅샷을 다시 읽게 기존 신호를 보낸다.
    if (!this.closed) this.store.touchSnapshot();
  }

  /** 실행 엔진 상태. 아직 한 번도 확인하지 못했거나 엔진이 없는 실행 방식이면 null. */
  engineStatus(): EngineStatus | null {
    return this.engine ? { ...this.engine } : null;
  }

  private readonly terminalStreamClosers = new Set<() => Promise<void>>();
  private readonly terminalLeaseListeners = new Set<(memberId: string, leaseId: string | null) => Promise<void>>();
  onTerminalLeaseEnded(ended: (memberId: string, leaseId: string | null) => Promise<void>): () => void {
    this.terminalLeaseListeners.add(ended);
    return () => { this.terminalLeaseListeners.delete(ended); };
  }
  onTerminalStreamShutdown(close: () => Promise<void>): () => void {
    this.terminalStreamClosers.add(close);
    return () => { this.terminalStreamClosers.delete(close); };
  }
  private requireTerminalStream(memberId: string): Member {
    const member = this.store.requireMember(memberId);
    const project = this.store.requireProject(member.projectId);
    const rt = this.runtime(memberId);
    if (this.closed || member.backend !== "core" || !member.paneId || member.origin === "manual" || project.archived || !project.runnerEnabled ||
        this.pendingLifecycle(memberId) || rt.closing || rt.starting || rt.reopening) {
      throw new ApiError(409, "세션을 처리하는 중이거나 터미널을 열 수 없습니다", "TERMINAL_REFUSED");
    }
    return member;
  }
  async terminalStreamInfo(memberId: string): Promise<{ cols: number; rows: number }> {
    const member = this.requireTerminalStream(memberId);
    const generation = this.store.memberRevisions(memberId).sessionGeneration;
    const runner = this.runnerOf(member);
    if (!runner.terminalInfo) throw new ApiError(409, "core 터미널을 확인할 수 없습니다", "TERMINAL_REFUSED");
    try {
      const size = await runner.terminalInfo(this.runnerMember(member, this.store.requireProject(member.projectId)));
      const latest = this.requireTerminalStream(memberId);
      if (latest.paneId !== member.paneId || this.store.memberRevisions(memberId).sessionGeneration !== generation) {
        throw new ApiError(409, "세션이 바뀌었습니다", "TERMINAL_REFUSED");
      }
      return size;
    } catch (error) {
      if (error instanceof CoreError && !error.uncertain && ["finished", "not_found"].includes(error.kind)) {
        throw new ApiError(409, "터미널이 끝났거나 없습니다", "TERMINAL_GONE");
      }
      throw new ApiError(409, "터미널 소유와 크기를 확인할 수 없습니다", "TERMINAL_REFUSED");
    }
  }
  terminalStreamLease(memberId: string) {
    const member = this.requireTerminalStream(memberId);
    const lease = this.runnerOf(member).terminalLease?.(memberId) ?? null;
    return lease && lease.identity.terminalId === member.paneId && lease.identity.sessionGeneration === this.store.memberRevisions(memberId).sessionGeneration ? lease : null;
  }
  renewTerminalStreamLease(memberId: string, leaseId: string): number {
    const member = this.requireTerminalStream(memberId);
    if (this.terminalStreamLease(memberId)?.leaseId !== leaseId) throw new ApiError(409, "조작권이 없습니다", "TERMINAL_REFUSED");
    const expiresAt = this.runnerOf(member).renewLease?.(memberId, leaseId);
    if (!expiresAt) throw new ApiError(409, "조작권이 없습니다", "TERMINAL_REFUSED");
    return expiresAt;
  }
  async terminalStreamInput(memberId: string, write: () => void): Promise<void> {
    const member = this.requireTerminalStream(memberId);
    this.invalidateCoreMeasurement(member);
    const runner = this.runnerOf(member);
    if (runner.noteTerminalInput) await runner.noteTerminalInput(memberId, write);
    else write();
  }

  async terminalControl(memberId: string, action: TerminalControlAction): Promise<TerminalControlResult> {
    const member = this.store.requireMember(memberId);
    if (member.backend !== "core") throw new ApiError(409, "core 터미널만 조작할 수 있습니다", "TERMINAL_REFUSED");
    if (action.action !== "release") {
      this.requireActive(this.store.requireProject(member.projectId));
      if (this.pendingLifecycle(memberId)) throw new ApiError(409, "미확정 세션 작업을 확인하는 중입니다", "TERMINAL_REFUSED");
    }
    const rt = this.runtime(memberId);
    if (rt.closing || rt.starting || rt.reopening || rt.pumping) throw new ApiError(409, "세션을 처리하는 중입니다. 잠시 뒤 다시 여세요", "TERMINAL_REFUSED");
    const runner = this.runnerOf(member);
    if (!runner.terminalControl) throw new ApiError(501, "터미널 조작을 지원하지 않습니다", "TERMINAL_REFUSED");
    if (this.terminalMutations.has(memberId)) throw new ApiError(409, "터미널 입력을 처리하는 중입니다", "terminal_busy");
    this.terminalMutations.add(memberId);
    try {
      if (action.action === "input" || action.action === "key") this.invalidateCoreMeasurement(member);
      const previousLease = runner.terminalLease?.(memberId);
      const result = await runner.terminalControl(this.runnerMember(member, this.store.requireProject(member.projectId)), action);
      if (previousLease && (action.action === "release" || (action.action === "claim" && result.leaseId !== previousLease.leaseId))) {
        await Promise.all([...this.terminalLeaseListeners].map(ended => ended(memberId, previousLease.leaseId)));
      }
      return result;
    } catch (e) {
      // 넓은 코드 TERMINAL_REFUSED 는 출시된 앱이 보므로 그대로 두고, 실행 엔진의 좁은 사유(core_terminal_missing 등)를 reason 으로 더한다.
      if (e instanceof CoreError && !e.uncertain) throw new ApiError(409, e.message, "TERMINAL_REFUSED", e.reason);
      throw e;
    } finally {
      this.terminalMutations.delete(memberId);
      if (action.action === "release" && this.store.listPending(memberId).length > 0) void this.pump(memberId);
    }
  }

  /** 실행 파일이 바뀌지 않는 한 버전은 한 번만 묻는다. 요청마다 프로세스를 띄우면 앱의 연결 확인이 그만큼 늦어진다. */
  private coreVersion: { key: string; value: Promise<string | null> } | null = null;
  private coreVersionOf(binary: string): Promise<string | null> {
    const path = Bun.which(binary);
    if (!path) return Promise.resolve(null);
    let key = path;
    try { const stat = statSync(path); key = `${path}:${stat.mtimeMs}:${stat.size}`; } catch {}
    if (this.coreVersion?.key === key) return this.coreVersion.value;
    const value = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = Bun.spawn([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        timer = setTimeout(() => result.kill(), 2000);
        const output = await new Response(result.stdout).text();
        return await result.exited === 0 ? output.trim().slice(0, 200) || null : null;
      } catch { return null; }
      finally { if (timer) clearTimeout(timer); }
    })();
    this.coreVersion = { key, value };
    // 실패한 조회는 기억하지 않는다. 다음에 다시 묻는다.
    void value.then(found => { if (found === null && this.coreVersion?.value === value) this.coreVersion = null; });
    return value;
  }

  /** 겹친 요청은 한 번만 묻고, 답이 늦으면 마지막으로 아는 상태로 답한다(앱의 연결 확인은 3~4초 제한이다). */
  private coreAvailability: Promise<{ ok: boolean; detail?: string }> | null = null;
  private lastCoreAvailability: { ok: boolean; detail?: string } | null = null;
  async runtimeInfo(): Promise<RuntimeInfo> {
    const runner = this.runners.get("core");
    if (runner) this.coreAvailability ??= runner.available().catch((e: Error) => ({ ok: false, detail: e.message }))
      .then(state => { this.lastCoreAvailability = state; return state; }).finally(() => { this.coreAvailability = null; });
    const configured = this.config as OrchestratorDeps["config"] & Partial<Config>;
    const binary = configured.coreBin ?? "herdr-core";
    const installed = !!Bun.which(binary);
    const [available, version] = await Promise.all([
      runner ? briefly(this.coreAvailability!, this.timings.screenWaitMs, () => this.lastCoreAvailability ?? { ok: false, detail: "실행기 응답을 기다리는 중입니다" }) : { ok: false, detail: "core 실행기가 없습니다" },
      installed ? briefly(this.coreVersionOf(binary), this.timings.screenWaitMs, () => null) : null,
    ]);
    return { backend: "core", core: { installed, available: available.ok, version, detail: available.ok ? null : available.detail ?? null }, providers: {
      claude: { installed: !!Bun.which(configured.claudeBin ?? "claude") }, codex: { installed: !!Bun.which(configured.codexBin ?? "codex") },
    } };
  }

  /** 접속 코드·토큰이 있는 폴더. file 도구가 읽지 못하게 막는다. */
  get dataDir(): string {
    return this.config.home;
  }

  get protectedFileRoots(): string[] {
    return configuredSecretRoots(this.config).concat(configuredSecretRoots(this.providerHomes ?? {}));
  }

  /** file 도구가 원본을 복사해 두는 곳. */
  get uploadsDir(): string {
    return join(this.config.home, "uploads");
  }

  /** 서버가 실제 포트로 뜬 뒤 부른다. MCP 설정 파일에 들어간다. */
  setServerUrl(url: string): void {
    this.serverUrl = url;
  }

  private identity(member: Member): RunnerTerminalIdentity {
    const runner = this.runners.get(this.backendOf(member));
    return (runner instanceof CoreRunner ? runner.observationState(member.id)?.identity : null) ?? { terminalId: member.paneId, sessionId: member.sessionId, sessionGeneration: this.store.memberRevisions(member.id).sessionGeneration, process: null };
  }

  private pendingLifecycle(memberId: string): LifecycleJournal | undefined {
    const generation = this.store.memberRevisions(memberId).sessionGeneration;
    return this.store.listPendingLifecycleJournals().find(j => j.memberId === memberId && j.identity.sessionGeneration === generation);
  }

  private watchesCore(member: Member, project: Project): boolean {
    return member.backend === "core" && member.origin !== "manual" && !project.archived && !this.coreAbsenceConfirmed(member) &&
      (member.status !== "asleep" || this.pendingLifecycle(member.id)?.intent === "start");
  }

  /**
   * 결과를 모르는 기동(start) 저널은 터미널이 나타나야만 닫혔다. 끝내 안 나타나면 그 직원은 깨우기·재우기·전달이
   * 모두 막힌 채 남았다. core 가 답했고 이 직원 라벨의 터미널이 없다는 관측이 유예 시간 뒤에도 두 번 이어지면
   * '뜨지 않음'으로 닫는다. 뒤늦게 터미널이 나타나도 다음 기동이 라벨로 먼저 찾아 붙으므로 둘이 되지 않는다.
   */
  private resolveAbsentStart(member: Member, outcome: RunnerReattachResult["outcome"]): boolean {
    const journal = this.pendingLifecycle(member.id);
    if (outcome !== "not_found" || journal?.intent !== "start") { this.absentStarts.delete(member.id); return false; }
    const seen = (this.absentStarts.get(member.id) ?? 0) + 1;
    this.absentStarts.set(member.id, seen);
    // prepared 는 기동 요청을 보내기 전이다. 이 프로세스가 지금 띄우는 중이 아니면(호출부가 확인) 보낸 적이 없다.
    if (seen < 2 || journal.phase !== "prepared" && Date.now() - Date.parse(journal.updatedAt) < this.timings.startGraceMs) return false;
    this.absentStarts.delete(member.id);
    this.finishLifecycle(journal, "refused", "소유 터미널이 생기지 않았습니다");
    const runner = this.runners.get("core");
    if (runner instanceof CoreRunner) runner.forgetUnknownStart(member.id);
    const current = this.store.requireMember(member.id);
    if (current.fenceCode === "starting_unknown") this.store.patchMember(member.id, { lastError: null });
    this.store.appendActivity(member.id, "system", "세션 기동 결과를 확인하지 못했고 터미널이 생기지 않아 기동을 취소했습니다. 필요하면 다시 깨웁니다");
    return true;
  }

  private prepareLifecycle(member: Member, intent: LifecycleJournal["intent"]): LifecycleJournal {
    const before = this.pendingLifecycle(member.id);
    if (before) {
      if (before.intent !== intent) throw new ApiError(409, "미확정 세션 작업을 먼저 확인해야 합니다", "lifecycle_unresolved");
      return before;
    }
    const at = new Date().toISOString();
    const run = this.store.listPendingExecutions().find(r => r.memberId === member.id);
    const entry: LifecycleJournal = { operationId: randomUUID(), memberId: member.id, projectId: member.projectId, intent, phase: "prepared", identity: this.identity(member), runId: run?.runId ?? null, deliveryIds: run?.deliveryIds ?? [], baseline: null, reason: null, exitCode: null, createdAt: at, updatedAt: at };
    this.store.saveLifecycleJournal(entry);
    return entry;
  }

  private finishLifecycle(entry: LifecycleJournal, phase: LifecycleJournal["phase"], reason: string | null, identity = entry.identity): void {
    this.store.saveLifecycleJournal({ ...entry, phase, reason, identity, updatedAt: new Date().toISOString() });
  }

  private async startManaged(member: Member, project: Project, resume: boolean, prepared?: LifecycleJournal): Promise<RunnerStartResult> {
    this.requireActive(this.store.requireProject(project.id));
    const previous = this.pendingLifecycle(member.id);
    if (previous && (previous.operationId !== prepared?.operationId || previous.phase !== "prepared")) throw new CoreError("starting_unknown", "미완료 생성 의도가 있어 소유 라벨로 확인하는 중입니다");
    const entry = prepared ?? this.prepareLifecycle(member, "start");
    const runner = this.runnerOf(member);
    this.finishLifecycle(entry, "started", null);
    // 실행기에 넘기기 전의 실패(보관·실행 꺼짐, 실행 파일 쓰기)는 터미널을 만들었을 수 없다.
    let launched = false;
    try {
      this.requireActive(this.store.requireProject(project.id));
      this.absentCoreMembers.delete(member.id);
      const target = this.runnerMember(member, project), opts = { ...this.writeRunFiles(member, project, resume), operationId: entry.operationId };
      const started = await this.pumpWait(member.id, this.runtime(member.id).closing ? "sync_config.start" : ["offline", "asleep"].includes(member.status) ? "reopen" : "start_session", () => { launched = true; return runner.start(target, opts); }, runner);
      if (!this.store.getMember(member.id)) return started;
      const identity = started.identity ?? { ...entry.identity, sessionId: started.sessionId, terminalId: started.paneId };
      this.finishLifecycle(entry, "confirmed", null, identity);
      return started;
    } catch (error) {
      const unknown = launched && (!(error instanceof CoreError) || error.uncertain || ["starting_unknown", "conflict", "unknown"].includes(error.kind));
      this.finishLifecycle(entry, unknown ? "unknown" : "refused", (error as Error).message.slice(0, 500));
      if (unknown) {
        this.store.patchMember(member.id, { lastError: startingUnknownNote((error as Error).message), fenceCode: "starting_unknown" });
        this.coreSupervisor?.watch(this.runnerMember(this.store.requireMember(member.id), project));
      }
      throw error;
    }
  }

  private async stopManaged(member: Member, intent: "sleep" | "close" | "archive" | "fresh_session", whileWorking: boolean): Promise<void> {
    const lease = this.store.inputState(member.id).lease;
    if (lease && lease.identity.terminalId === member.paneId) throw new ApiError(409, "직접 조작권이 유효한 동안 세션을 종료할 수 없습니다", "terminal_lease_active");
    const entry = this.prepareLifecycle(member, intent);
    this.finishLifecycle(entry, "started", whileWorking ? "while_working:" : "idle_only:");
    try {
      await this.pumpWait(member.id, this.runtime(member.id).pumpStage === "sync_config" ? "sync_config.stop" : "stop_session", () => this.runnerOf(member).stop(this.runnerMember(member, this.store.requireProject(member.projectId)), { whileWorking }), this.runnerOf(member));
      // Final state and the confirmation share a transaction at the caller.
    } catch (error) {
      const refused = (error instanceof CoreError && !error.uncertain) || error instanceof ApiError;
      this.finishLifecycle(entry, entry.phase !== "unknown" && refused ? "refused" : "unknown", `${whileWorking ? "while_working" : "idle_only"}: ${(error as Error).message.slice(0, 500)}`);
      if (error instanceof CoreError && !error.uncertain && error.kind === "input_busy") throw new ApiError(409, "입력칸에 글이 남아 있거나 입력 상태를 확인하지 못해 닫지 않았습니다. 터미널에서 지운 뒤 다시 시도하세요", "close_draft_present");
      if (error instanceof CoreError && !error.uncertain && error.kind === "busy") throw new ApiError(409, "실행 중인 일이나 미해결 입력이 있어 닫지 않았습니다. 터미널과 전달 결과를 확인해 주세요", "close_busy");
      throw error;
    }
  }

  private confirmStop(memberId: string): void {
    const journal = this.pendingLifecycle(memberId);
    if (journal && journal.intent !== "start") this.finishLifecycle(journal, "confirmed", null);
    this.coreSupervisor?.unwatch(memberId);
  }

  private recoverStops(): Promise<void> {
    this.stopRecovery ??= this.recoverStopsOnce().finally(() => { this.stopRecovery = null; });
    return this.stopRecovery;
  }

  private async recoverStopsOnce(): Promise<void> {
    for (const journal of this.store.listPendingLifecycleJournals()) {
      if (!["sleep", "close", "archive", "fresh_session"].includes(journal.intent)) continue;
      const member = this.store.getMember(journal.memberId);
      if (!member || this.store.memberRevisions(member.id).sessionGeneration !== journal.identity.sessionGeneration) continue;
      const rt = this.runtime(member.id);
      if (this.archiving.has(member.projectId) || rt.closing || rt.starting || rt.reopening || rt.pumping) continue;
      if (journal.intent === "fresh_session") {
        try { await this.recoverFreshStop(member, journal); }
        catch (error) { console.warn(`${member.name} 설정 변경 끝내기 확인 실패:`, (error as Error).message); }
        continue;
      }
      try {
        if (journal.intent === "close") await this.closeMember(member.id);
        else {
          await this.sleepMember(member.id, { force: journal.intent === "archive" || (journal.reason?.startsWith("while_working:") ?? false), recovering: true, ...(journal.intent === "archive" ? { holdAs: "archived" as const } : {}) });
          if (journal.intent === "archive" && !this.store.requireProject(member.projectId).archived) for (const d of this.store.listPending(member.id)) if (d.status === "held" && d.holdReason === "archived") this.hold(d, "asleep");
        }
        if (this.store.getMember(member.id)?.fenceCode === "stop_check_held") this.store.patchMember(member.id, { lastError: null });
      } catch (error) { this.store.patchMember(member.id, { lastError: stopCheckHeldNote((error as Error).message), fenceCode: "stop_check_held" }); }
    }
  }

  /**
   * 세션을 다시 열려고(설정·CLI 변경, 새 세션으로) 옛 터미널을 끝내다가 결과를 놓쳤다(fresh_session 미확정).
   * 끝내기가 확인돼야 다음 단계(설정 저장, 세션 교체)로 가므로 명부와 세션은 바뀌지 않은 채다.
   * 예전에는 이 의도를 닫는 자리가 없어, 그 팀장은 지시가 영영 대기하고 깨우기·재우기·설정 변경이 모두 막힌 채 남았다.
   * - 터미널이 끝났거나 엔진이 모른다고 확정해 답했다: 끝내기는 된 것이다. 의도를 확정하고 꺼짐으로 둔다(세션 ID 는 그대로).
   *   말을 걸거나 깨우면 같은 대화를 이어 연다(재시작으로 잃은 터미널이면 서버가 스스로 연다).
   * - 터미널이 살아 있고, 끝내기 요청에서 더 올 것이 없다(writeSettleMs): 끝내지 못한 것이다. 의도를 거절로 닫는다. 세션은 그대로 일한다.
   * - 엔진이 답하지 않는다: 아무것도 정하지 않고 다음 점검을 기다린다.
   * 하려던 변경은 어느 쪽이든 적용되지 않았다. 대표의 설정 변경은 그때 실패로 답했으니 다시 하면 되고, 직급 설정을 맞추던 것(syncConfig)은 다음 전달이 다시 한다.
   */
  private async recoverFreshStop(member: Member, journal: LifecycleJournal): Promise<void> {
    if (this.backendOf(member) !== "core" || !(this.runners.get("core") instanceof CoreRunner)) return;
    if (!member.paneId) {
      // 끝낼 터미널이 적혀 있지 않다. 끝낸 것이 없으니 의도만 닫는다.
      this.finishLifecycle(journal, "refused", "끝낼 터미널이 없습니다");
      void this.pump(member.id);
      return;
    }
    const probe = await this.probeOwnedTerminal(member);
    const rt = this.runtime(member.id);
    const current = this.store.getMember(member.id);
    if (this.closed || !current || current.paneId !== member.paneId || this.pendingLifecycle(member.id)?.operationId !== journal.operationId || rt.closing || rt.starting || rt.reopening) return;
    if (probe.state === "gone") {
      // 터미널에 묶인 상태 정리(releaseGoneTerminal)가 이 의도를 확정하고, 뒤이어 끊긴 실행과 재시작 표식을 정리한다.
      if (!(await this.reconcileAbsentTerminal(current, probe))) return;
      const after = this.store.getMember(member.id);
      if (after && after.paneId === member.paneId && !rt.reopening && !rt.starting) {
        this.store.patchMember(member.id, { status: "offline", paneId: null, subagents: 0 });
        rt.turn = null;
        this.releaseSlots();
      }
      if (!this.recovering) void this.pump(member.id);
      return;
    }
    if (probe.state !== "live" || Date.now() - Math.max(Date.parse(journal.updatedAt), this.startedAt) < this.timings.writeSettleMs) return;
    this.finishLifecycle(journal, "refused", "터미널이 그대로 살아 있습니다");
    this.store.appendActivity(member.id, "system", "세션을 다시 열려던 작업이 끊겨 있었습니다. 터미널이 그대로 살아 있어 그 작업을 닫았습니다. 바꾸려던 설정이나 새 세션은 적용되지 않았으니 다시 해 주세요", `${journal.operationId}:live_stop`);
    if (!this.recovering) void this.pump(member.id);
  }

  /**
   * 명부에 적힌 터미널을 엔진에 한 번 묻는다. gone 은 엔진이 끝났다고 알렸거나(terminal 에 그 기록), 그 터미널을 모른다고 확정해 답한 것(terminal null)이다.
   * 엔진이 답하지 않거나 그 주소의 터미널이 이 팀장의 것이 아니면 unknown 이다: 사라졌다는 근거가 아니다.
   */
  private async probeOwnedTerminal(member: Member): Promise<{ state: "gone"; terminal: CoreTerminal | null } | { state: "live" | "unknown" }> {
    try {
      const terminal = await coreRpc<CoreTerminal>(this.coreSocket(), "terminal.get", { terminal: member.paneId! }, 1000);
      if (terminal.address !== member.paneId || terminal.labels?.["iamceo.member"] !== member.id || terminal.labels["iamceo.project"] !== member.projectId || terminal.labels["iamceo.cli"] !== member.cli || terminal.labels["iamceo.generation"] !== String(this.store.memberRevisions(member.id).sessionGeneration)) return { state: "unknown" };
      return terminal.state === "live" ? { state: "live" } : { state: "gone", terminal };
    } catch (error) {
      // 엔진이 답했고 그 터미널을 모른다: 엔진(또는 Mac)이 다시 시작되며 터미널이 사라졌다.
      return error instanceof CoreError && error.kind === "not_found" && !error.uncertain ? { state: "gone", terminal: null } : { state: "unknown" };
    }
  }

  /** probed: 방금 같은 터미널을 물어 얻은 답이 있으면 다시 묻지 않는다. */
  private async reconcileAbsentTerminal(member: Member, probed?: Awaited<ReturnType<Orchestrator["probeOwnedTerminal"]>>): Promise<boolean> {
    if (!(this.runners.get("core") instanceof CoreRunner)) {
      this.releaseGoneTerminal(member.id, member.paneId);
      this.endExecution(member, "interrupted", "재결합 조회에서 소유 터미널의 부재를 확인했습니다");
      return true;
    }
    const probe = probed ?? await this.probeOwnedTerminal(member);
    if (probe.state !== "gone") return false;
    // 실행을 끝내기 전에 정리한다. 받지 못한 것이 확인된 전달의 실행은 '중단'이 아니라 '넣지 못함'으로 닫혀 총괄에게 중단을 알리지 않고,
    // 받은 것이 확인된 전달의 실행은 끊긴 일로 다뤄진다(재시작이면 이어가기 글).
    this.releaseGoneTerminal(member.id, member.paneId);
    const terminal = probe.terminal;
    if (!terminal) {
      this.endExecution(member, "interrupted", "소유 터미널의 부재를 확인했습니다", null, undefined, this.noteRestartLoss(member, "terminal_absent"));
      return true;
    }
    const run = this.store.listPendingExecutions().find(r => r.memberId === member.id);
    const settled = ["idle", "done"].includes(terminal.status?.state ?? "") && run?.turn !== null && run?.turn !== undefined && (terminal.turn ?? -1) > run.turn;
    const result = terminal.status?.state === "error" ? "error" : settled ? "success" : "interrupted";
    const lost = restartLossOf(terminal.reason, terminal.exit_code);
    this.endExecution(member, result, terminal.reason ?? terminal.status?.msg ?? "소유 터미널이 종료되었습니다", terminal.exit_code ?? null, terminal.turn, lost !== null && this.noteRestartLoss(member, lost));
    const detail = exitDetail(terminal.reason, terminal.exit_code);
    if (member.lastError !== detail) this.store.appendActivity(member.id, result === "success" || endedByRestart(terminal.reason) ? "system" : "error", detail.slice(0, 500));
    // 한도로 보류 중인 팀장의 표시는 남긴다. 종료 사유는 위에서 활동에 남겼다.
    if (!this.keepsUsageNote(this.store.requireMember(member.id))) this.store.patchMember(member.id, { lastError: result === "success" ? null : detail.slice(0, 500) });
    return true;
  }

  /**
   * 터미널의 사라짐이 확정되는 순간, 그 터미널에 묶여 있던 미확정 상태를 한곳에서 정리한다.
   * 부르는 자리는 둘이다: 재결합 조회에서 부재를 확인했을 때(reconcileAbsentTerminal)와 실행기가 종료를 알렸을 때(onRunnerEvent 의 gone).
   * 확정의 기준은 엔진의 답이다. 터미널이 끝났다고 알렸거나, 그 터미널을 모른다고 확정해 답했다. 엔진이 답하지 않는 것은 확정이 아니어서
   * 그때는 부르지 않고 아래 상태가 모두 그대로 남는다(살아 있을 수 있는 터미널에 대한 보수적 동작은 바뀌지 않는다).
   *
   * 예전에는 상태마다 따로 풀었고 푸는 자리가 대부분 '터미널에 붙어야' 돌아서, 보류라 못 열고 못 열어 보류를 못 푸는 순환이 생겼다.
   * - 끝내기 결과 모름: 설정 변경으로 다시 열던 끝내기(fresh_session)는 끝난 것으로 확정한다. 재우기·닫기·보관은 recoverStops 가 마저 한다.
   * - 전달: 받았는지 모르는 봉투를 세션 기록으로 판정한다(DeliveryRecovery.settleGoneTerminal). 그 봉투의 실행 기록도 맞춘다.
   * - 압축: 그 터미널이 받은 미확정 압축을 닫는다(releaseOrphanCompact).
   * - 조작 결과 모름: 병렬 설정 명령의 확인 보류를 푼다.
   * - 조작권: 그 터미널의 조작권을 지운다.
   * 한 가지가 실패해도 나머지는 정리한다. 여러 번 불러도 결과가 같다(종료 이벤트와 뒤따르는 재결합 조회가 같은 터미널로 한 번씩 부른다).
   */
  private releaseGoneTerminal(memberId: string, terminalId: string | null): void {
    if (!terminalId) return;
    const steps: [string, (member: Member) => void][] = [
      ["끝내기", member => this.confirmGoneStop(member, terminalId)],
      ["전달", member => this.settleGoneDeliveries(member, terminalId)],
      ["압축", member => this.releaseOrphanCompact(member.id, terminalId)],
      ["조작 결과", member => this.releaseGoneControl(member, terminalId)],
      ["조작권", member => this.releaseGoneLease(member, terminalId)],
    ];
    for (const [what, step] of steps) {
      const member = this.store.getMember(memberId);
      if (!member || this.backendOf(member) !== "core") return;
      try { step(member); } catch (e) { console.error(`사라진 터미널에 묶인 상태 정리 실패(${what}):`, memberId, (e as Error).message); }
    }
  }

  private confirmGoneStop(member: Member, terminalId: string): void {
    const journal = this.pendingLifecycle(member.id);
    if (!journal || journal.intent === "start" || (journal.identity.terminalId !== null && journal.identity.terminalId !== terminalId)) return;
    if (journal.intent !== "fresh_session") {
      // 재우기·닫기·보관은 대기열 보류와 명부 정리가 따라온다. 끝내기를 마저 확인하는 복구가 한다(이제 끝내기가 곧바로 확인된다).
      setImmediate(() => { if (!this.closed && !this.recovering) void this.recoverStops().catch(e => console.warn("끝내기 확인 복구 실패:", (e as Error).message)); });
      return;
    }
    this.finishLifecycle(journal, "confirmed", "터미널이 끝난 것을 확인했습니다");
    this.store.appendActivity(member.id, "system", "세션을 다시 열려던 작업이 끊겨 있었습니다. 터미널이 끝난 것을 확인해 그 작업을 닫았습니다. 바꾸려던 설정이나 새 세션이 적용되지 않았으면 다시 해 주세요", `${journal.operationId}:gone_stop`);
  }

  private settleGoneDeliveries(member: Member, terminalId: string): void {
    const settled = this.deliveryRecovery.settleGoneTerminal(member.id, terminalId);
    if (!settled.received.length && !settled.requeued.length) return;
    // 넣지 못한 것이 확인된 봉투의 실행은 '넣지 못함'으로 닫고, 받은 것이 확인된 봉투의 실행은 받은 것으로 적는다.
    this.reconcileRejectedExecutions();
    for (const run of this.store.listPendingExecutions()) if (run.memberId === member.id && run.identity.terminalId === terminalId) this.settleRecoveredStart(member, run, { turn: null, state: null });
  }

  private releaseGoneControl(member: Member, terminalId: string): void {
    // 결과를 모르는 병렬 설정 명령은 그때의 터미널에 들어갔다. 지금 터미널이 따로 있으면 그 보류는 지금 터미널의 것이다.
    if (member.paneId && member.paneId !== terminalId) return;
    const parallel = this.store.deferredMemberConfig(member.id)?.signature === `parallel_unknown:${this.store.memberRevisions(member.id).sessionGeneration}`;
    const noted = member.fenceCode === "control_unknown";
    if (!parallel && !noted) return;
    this.store.transaction(() => {
      if (parallel) this.store.clearDeferredMemberConfig(member.id);
      if (noted) this.store.patchMember(member.id, { lastError: null });
      this.store.appendActivity(member.id, "system", "병렬 설정을 받은 터미널이 끝나 그 설정의 확인 대기를 풀었습니다. 밀린 전달을 이어 갑니다");
    });
  }

  private releaseGoneLease(member: Member, terminalId: string): void {
    const leaseId = this.store.removeLeaseOfTerminal(member.id, terminalId);
    if (!leaseId) return;
    this.store.appendActivity(member.id, "system", "직접 조작하던 터미널이 끝나 그 조작권을 거뒀습니다. 밀린 전달을 이어 갑니다", `${leaseId}:gone_lease`);
    // 그 조작권으로 붙어 있던 화면 연결을 닫게 한다. 터미널이 이미 없으니 결과를 기다리지 않는다.
    for (const ended of this.terminalLeaseListeners) void ended(member.id, leaseId).catch(() => {});
  }

  private async reconcileExecutions(memberId?: string): Promise<void> {
    for (const run of this.store.listPendingExecutions()) {
      if (memberId && run.memberId !== memberId) continue;
      const member = this.store.getMember(run.memberId);
      if (!member || this.store.memberRevisions(member.id).sessionGeneration !== run.identity.sessionGeneration) continue;
      const runner = this.runners.get(this.backendOf(member));
      const observed = runner instanceof CoreRunner ? runner.observationState(member.id) : null;
      if (!runner || !observed || observed.failures || observed.identity.terminalId !== run.identity.terminalId) continue;
      if (this.settleRecoveredStart(member, run, observed)) continue;
      if (this.replayMissedTurnEnd(member, run, runner as CoreRunner)) continue;
      const observation = this.executionObservation(member, { source: "core", observedAt: observed.observedAt, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: observed.setupError });
      if (observation.error?.code === "progress_stalled" || observation.error?.code === "start_stalled" ||
          member.statusObservation?.error?.code === "progress_stalled" || member.statusObservation?.error?.code === "start_stalled") {
        this.store.patchMember(member.id, { statusObservation: observation });
      }
    }
  }

  /**
   * 닫는 중(잠재우기·설정 재적용이 거절로 끝나는 사이)에 온 이벤트는 버려지고, 코어는 상태가 바뀔 때만 다시 알린다.
   * 그 사이 턴이 끝났으면 실행 기록과 rt.turn 이 '일하는 중'으로 남아 그 직원의 전달이 모두 멈춘다.
   * 시간으로 끝내지 않는다: 관측이 이미 더 뒤의 종결 turn 을 보이고, 처리 중이거나 줄 선 이벤트가 없을 때만 놓친 종료를 평소 경로로 처리한다.
   */
  private replayMissedTurnEnd(member: Member, run: ExecutionJournal, runner: CoreRunner): boolean {
    const rt = this.runtime(member.id);
    if (this.closed || rt.closing || rt.pumping || rt.starting || rt.reopening || this.eventQueues.has(member.id) || runner.isBusy(member.id) || (rt.turn && rt.turn.kind !== "work")) return false;
    const observed = runner.observationState(member.id);
    if (!observed || observed.failures || observed.identity.terminalId !== run.identity.terminalId) return false;
    // 한도 창·설정 창 앞이거나 장애·한도로 멈춰 둔 직원의 턴은 '성공한 종료'로 보지 않는다.
    if (observed.setupError || this.apiRecovery.holdReason(member.id)) return false;
    if (run.turn === null || observed.turn === null || observed.turn <= run.turn || !["idle", "done"].includes(observed.state ?? "")) return false;
    const replay = this.onRunnerEvent({ type: "turn_end", memberId: member.id, finalText: "", isError: false, reason: "재관측으로 놓친 턴 종료를 확인했습니다",
      terminalId: observed.identity.terminalId, sessionGeneration: observed.identity.sessionGeneration, turn: observed.turn, observedAt: observed.observedAt })
      .catch(e => console.error("실행기 이벤트 처리 오류:", "turn_end", e));
    // 뒤따르는 실제 이벤트가 이 처리와 겹치지 않게 같은 줄에 세운다. 이어지는 전달까지 기다리느라 건강 확인을 붙잡지는 않는다.
    this.eventQueues.set(member.id, replay);
    void replay.finally(() => { if (this.eventQueues.get(member.id) === replay) this.eventQueues.delete(member.id); });
    return true;
  }

  /** Compose observation and execution evidence atomically. A successful reattach is not new output:
   * publishing its bare error:null used to erase the quiet-run advisory until the next reconciliation.
   * The same 20s threshold and execution timestamps apply to every observation writer. */
  private executionObservation(member: Member, observation: NonNullable<Member["statusObservation"]>, status: string = member.status): NonNullable<Member["statusObservation"]> {
    if (this.apiRecovery?.holdReason(member.id) && ["network_outage", "usage_limit"].includes(member.statusObservation?.error?.code ?? "") && !observation.error) return { ...observation, error: member.statusObservation!.error };
    if (observation.source !== "core" || observation.freshness !== "fresh" || observation.ownership !== "verified" || observation.error || ["blocked", "waiting"].includes(status)) return observation;
    const generation = this.store.memberRevisions(member.id).sessionGeneration;
    const run = this.store.listPendingExecutions().find(run => run.memberId === member.id && run.identity.sessionGeneration === generation && run.identity.terminalId === member.paneId);
    if (!run) return observation;
    const since = run.lastProgressAt ?? run.startedAt ?? run.inputReceivedAt ?? run.createdAt;
    if (!(Date.now() - Date.parse(since) >= 20_000)) return observation;
    const code = run.startedAt ? "progress_stalled" : "start_stalled";
    return { ...observation, error: { code, note: `업무 ${run.runId}의 ${run.startedAt ? "진전" : "시작"}을 재관측 중입니다. 마지막 근거 ${since}. 소유 터미널과 업무 기록을 확인하세요. 시간만으로 입력·Enter·중단하지 않습니다` } };
  }

  /**
   * A write whose reply was lost (daemon killed mid-send, real 2026-11-07 run) leaves its run in "starting". Once
   * delivery recovery proves receipt from the CLI's own log, the run is received; the turn counter observed just
   * before the write is the comparison point. A quiet CLI past that counter means the input's turn already ended
   * while we were away: close it as success (which also asks for a missing report). Without that counter the run
   * stays received and fenced: elapsed time alone never ends it.
   */
  private settleRecoveredStart(member: Member, run: ExecutionJournal, observed: { turn: number | null; state: string | null }): boolean {
    // 응답을 잃어 결과를 모른 채(unknown) 남은 실행도 같다: 같은 프로세스가 그렇게 적어 둔 뒤 재시작하면 턴 끝 이벤트는 다시 오지 않는다.
    if (!["starting", "unknown"].includes(run.phase) || run.inputReceivedAt || !run.deliveryIds.length) return false;
    const dispatch = this.store.getDispatch(run.runId);
    if (!dispatch || dispatch.transportState === "rejected" || !run.deliveryIds.every(id => this.store.getDelivery(id)?.status === "delivered")) return false;
    const at = new Date().toISOString(), base = dispatch.baseline.turn ?? null;
    this.store.saveExecutionJournal({ ...run, phase: "received", inputReceivedAt: at, turn: base, reason: run.reason ?? "receipt_from_log", updatedAt: at });
    if (base !== null && observed.turn !== null && observed.turn > base && ["idle", "done"].includes(observed.state ?? "")) {
      this.endExecution(member, "success", "입력 응답은 끊겼지만 CLI 기록으로 수신을 확인했고, 그 턴이 끝난 것을 확인했습니다", null, observed.turn);
      this.runtime(member.id).turn = null;
      this.releaseSlots();
    }
    return true;
  }

  private completedReportSince(member: Member, since: string): boolean {
    let cursor: string | undefined;
    do {
      const opts = { scope: { kind: "member" as const, memberId: member.id }, cursor, limit: 200 };
      const page = this.store.requireProject(member.projectId).archived ? this.store.listArchiveMessagePage(member.projectId, opts) : this.store.listMessagePage(member.projectId, opts);
      if (page.items.some(message => message.memberId === member.id && !message.mine && message.at >= since && ["완료", "답변"].includes(message.kind))) return true;
      if (!page.nextCursor || !page.items.some(message => message.at >= since)) return false;
      cursor = page.nextCursor;
    } while (cursor);
    return false;
  }

  /**
   * restartLost: 재시작으로 터미널을 잃었고 서버가 그 팀장을 스스로 다시 연다(noteRestartLoss 가 참). 그때 끊긴 실행은 여기서 알리지 않고
   * 표식에 적어 둔다. 다시 열면 이어가기 글을 넣고, 못 열면 그때 예전처럼 총괄에게 알린다(settleRestartWake). 어느 쪽이든 실행마다 한 번이다.
   */
  private endExecution(member: Member, result: "success" | "error" | "interrupted", reason: string | null, exitCode: number | null = null, turn?: number | null, restartLost = false): void {
    const at = new Date().toISOString();
    this.store.transaction(() => {
      for (const run of this.store.listPendingExecutions().filter(r => r.memberId === member.id && r.identity.sessionGeneration === this.store.memberRevisions(member.id).sessionGeneration)) {
        const reported = this.completedReportSince(member, run.createdAt);
        const outcome = result === "interrupted" && reported ? "success" : result;
        this.store.saveExecutionJournal({ ...run, turn: turn ?? run.turn, phase: outcome === "interrupted" ? "interrupted" : "ended", result: outcome, reason, exitCode, endedAt: at, updatedAt: at });
        this.store.finishDelegationAck(member.id, run.runId);
        if (result === "error" && ["network", "usage_limit"].includes(classifyTurnError(reason ?? ""))) continue;
        if (outcome === "success") {
          this.completeExecutionReview(member, run);
          this.requestMissingReport(member, run);
        } else if (run.deliveryIds.some(id => this.store.getDelivery(id)?.text.startsWith(formatSystem("보고 보완")))) {
          this.requestMissingReport(member, run);
        }
        if (outcome !== "interrupted") continue;
        const wake = restartLost ? this.store.getRestartWake(member.id) : null;
        // 받았는지조차 모르는 입력(수신도 시작도 확인되지 않은 실행)은 '하던 일'이 아니다. 이어가기 글을 넣지 않고 예전처럼 알린다.
        if (wake && wake.generation === run.identity.sessionGeneration && ["pending", "opening"].includes(wake.state) && (run.inputReceivedAt || run.startedAt)) {
          if (!wake.runIds.includes(run.runId)) this.store.setRestartWake(member.id, { ...wake, runIds: [...wake.runIds, run.runId] });
          continue;
        }
        this.store.claimExecutionNotice(run.runId, "interruption", () => this.noticeInterrupted(member, run,
          endedByRestart(reason) ? "Mac이나 실행 엔진이 다시 시작되어 세션이 꺼졌습니다" : reason ?? "종료 근거 없이 세션이 사라졌습니다"));
      }
    });
  }

  /** 끊긴 실행을 대화에 남기고 총괄을 깨워 알린다. 실행마다 한 번이다(claimExecutionNotice 안에서만 부른다). */
  private noticeInterrupted(member: Member, run: ExecutionJournal, why: string): void {
    this.systemMessage(member.projectId, `${member.name}: 실행 ${run.runId} 중단 — ${why}`);
    const conductor = this.store.getConductor(member.projectId);
    if (conductor && conductor.id !== member.id) this.store.enqueue({ projectId: member.projectId, memberId: conductor.id, kind: "system", text: formatSystem(`${member.name}의 실행 ${run.runId}이 중단되었습니다. 전달 ${run.deliveryIds.join(", ")}. 기존 변경과 보고를 확인한 뒤 후속 지시를 결정하세요.`), wake: true });
  }

  // ---- 재시작(Mac 또는 실행 엔진)으로 꺼진 팀장을 서버가 스스로 다시 열기 ----
  // 대상·속도·글은 restart-wake.ts. '깨우기'와 같은 길(reopen)로 같은 세션을 이어 연다. 입력은 넣지 않는다.
  // 턴 도중에 끊긴 실행이 있었을 때만, 다시 연 뒤 이어가기 글을 실행마다 한 번 넣는다.

  private quickExitLocked(rt: Runtime): boolean {
    return rt.quickExits >= 3 && Date.now() < rt.quickExitAt + this.timings.quickExitRetryMs;
  }

  /**
   * 서버가 스스로 다시 열어도 되는 팀장인가. 서버가 띄운 core 세션이고 세션 ID 가 있으며, 프로젝트가 보관되지 않았고 실행이 켜져 있어야 한다.
   * 잠든 팀장(대표나 총괄이 재운 것)·직접 붙인 세션·넘겨받은 명부·옛 실행기의 세션은 아니다.
   * 사용 한도로 보류 중인 팀장도 아니다: 다시 열어도 전달은 한도로 붙잡히고, 연 CLI 의 상태가 한도 표시를 지워 화면(쉬는 중)과 실제(한도 보류)가
   * 어긋났다(2026-11-13 라이브 DB 사본). 한도가 풀리거나(자동 이어가기·카드의 '이어가기') 모델을 바꾸면 그 길이 다시 연다.
   */
  private restartWakeTarget(member: Member): boolean {
    const project = this.store.getProject(member.projectId);
    return member.origin === "runner" && member.backend === "core" && !!member.sessionId && member.status !== "asleep" &&
      !!project && !project.archived && !this.archiving.has(project.id) && project.runnerEnabled && !this.apiRecovery?.usageLimited(member.id);
  }

  /**
   * 사용 한도로 보류 중인 팀장의 한도 표시(lastError '사용 한도 해제를 기다립니다')인가. 이 표시는 한도 그룹에서 실제로 풀릴 때만 지운다
   * (releaseMember·completed·이어가기). 다시 열기·재결합·CLI 의 쉬는 중 보고·터미널 종료 알림이 지우거나 덮어쓰지 않는다.
   */
  private keepsUsageNote(member: Member): boolean {
    return member.fenceCode === "usage_wait" && !!this.apiRecovery?.usageLimited(member.id);
  }

  /**
   * 재시작으로 터미널을 잃은 것을 표식으로 적는다. 서버가 스스로 다시 열 대상이면 true.
   * 띄우기·끝내기 결과를 모르는 팀장, 닫는 중인 팀장, 시작하자마자 끝나기를 되풀이한 팀장은 적지 않는다(예전처럼 꺼진 채 남는다).
   */
  private noteRestartLoss(snapshot: Member, reason: RestartWake["reason"]): boolean {
    const member = this.store.getMember(snapshot.id);
    if (!member) return false;
    const rt = this.runtime(member.id);
    if (!this.restartWakeTarget(member) || this.pendingLifecycle(member.id) || rt.closing || this.quickExitLocked(rt)) return false;
    const generation = this.store.memberRevisions(member.id).sessionGeneration;
    const before = this.store.getRestartWake(member.id);
    const lostAt = new Date().toISOString();
    if (before && before.generation === generation) {
      // 같은 꺼짐을 두 번 본다(종료 이벤트, 그 뒤의 재결합 조회): 기다리거나 여는 중인 표식은 그대로 둔다.
      // 실패로 닫았거나 다시 연 뒤의 표식이면 새로 꺼진 것이다. 처음부터 다시 센다(나가지 않은 이어가기 글은 그대로 쓴다).
      if (before.state === "failed" || before.state === "resumed") this.store.setRestartWake(member.id, { ...before, reason, lostAt, state: "pending", attempts: 0 });
      return true;
    }
    this.store.setRestartWake(member.id, { generation, reason, lostAt, state: "pending", attempts: 0, runIds: [], resumeId: null });
    return true;
  }

  /**
   * 이 기능 전에 재시작으로 꺼진 팀장은 표식 없이 lastError 의 글만 남아 있다(라이브 DB 의 옛 글 포함). 서버가 뜰 때 한 번 표식으로 옮긴다.
   * 끊긴 실행은 그때 이미 총괄에게 알렸으므로 세션만 다시 연다.
   */
  private adoptRestartNotes(): void {
    const wakes = this.store.restartWakes();
    for (const member of this.store.listAllMembers()) {
      if (wakes[member.id] || member.status !== "offline" || member.paneId || !restartNoteIn(member.lastError)) continue;
      if (!this.restartWakeTarget(member) || this.pendingLifecycle(member.id)) continue;
      this.store.setRestartWake(member.id, { generation: this.store.memberRevisions(member.id).sessionGeneration, reason: "legacy_note", lostAt: member.updatedAt, state: "pending", attempts: 0, runIds: [], resumeId: null });
    }
  }

  /**
   * 표식을 닫는다.
   * - resumed: 같은 세션을 이어 열었다. 활동에 한 줄 남기고, 끊긴 실행마다 이어가기 글을 한 번 넣는다(총괄에게는 깨우지 않는 소식).
   * - dropped: 대상에서 빠졌다(대표가 재우거나 닫음, 새 세션, 보관 등). 끊긴 실행은 예전처럼 총괄을 깨워 알린다.
   * - failed: 여는 데 실패했다. dropped 와 같되 표식을 남겨, 같은 꺼짐에 다시 스스로 열지 않는다.
   * 알림과 이어가기 글은 실행 기록의 통지 칸(claimExecutionNotice)으로 한 번만 만든다. 서버가 또 재시작해도 두 번 만들지 않는다.
   */
  private settleRestartWake(memberId: string, outcome: "resumed" | "dropped" | "failed"): void {
    const wake = this.store.getRestartWake(memberId);
    if (!wake) return;
    const member = this.store.getMember(memberId);
    if (!member) { this.store.setRestartWake(memberId, null); return; }
    let wakeConductor: string | null = null;
    this.store.transaction(() => {
      const conductor = this.store.getConductor(member.projectId);
      const lead = conductor && conductor.id !== member.id ? conductor : null;
      let resumeId = wake.resumeId && ["queued", "held"].includes(this.store.getDelivery(wake.resumeId)?.status ?? "") ? wake.resumeId : null;
      for (const runId of wake.runIds) {
        const run = this.store.getExecutionJournal(runId);
        if (!run || run.memberId !== member.id) continue;
        this.store.claimExecutionNotice(runId, "interruption", () => {
          if (outcome !== "resumed") {
            this.noticeInterrupted(member, run, `Mac이나 실행 엔진이 다시 시작되어 끊겼습니다${outcome === "failed" ? ". 세션을 다시 열지 못했습니다" : ""}`);
            wakeConductor = lead?.id ?? null;
            return;
          }
          resumeId ??= this.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "system", text: RESTART_RESUME_TEXT, wake: true }).id;
          this.systemMessage(member.projectId, `${member.name}: 실행 ${run.runId} — 재시작으로 끊겨 이어서 하게 했습니다`);
          // 총괄이 같은 일을 또 맡겨 두 번 하게 되지 않도록, 깨우지 않는 소식으로만 알린다.
          if (lead) this.store.enqueue({ projectId: member.projectId, memberId: lead.id, kind: "system", wake: false,
            text: formatSystem(`${member.name}의 일(실행 ${run.runId})이 Mac이나 실행 엔진의 재시작으로 끊겼습니다. 세션을 다시 열어 끊긴 곳부터 이어서 하게 했으니 같은 일을 다시 지시하지 마세요. 결과는 ${member.name}의 보고로 옵니다. 전달 ${run.deliveryIds.join(", ")}.`) });
        });
      }
      if (outcome === "resumed" && wake.state !== "resumed") this.store.appendActivity(member.id, "system", RESTART_REOPENED_NOTE);
      this.store.setRestartWake(memberId, outcome === "failed" ? { ...wake, state: "failed", runIds: [] }
        : outcome === "resumed" && resumeId ? { ...wake, state: "resumed", runIds: [], resumeId } : null);
      // 총괄의 전달은 트랜잭션이 끝난 뒤에 민다(재시작 복구 중이면 복구 끝의 펌프가 민다).
      this.store.afterCommit(() => { if (wakeConductor && !this.closed && !this.recovering) void this.pump(wakeConductor); });
    });
  }

  /** 지금 스스로 열 차례인 팀장들(총괄 먼저, 그다음 만든 순서). 대상에서 빠진 표식은 여기서 닫는다. */
  private restartWakeQueue(): Member[] {
    const ready: Member[] = [];
    for (const [memberId, saved] of Object.entries(this.store.restartWakes())) {
      const member = this.store.getMember(memberId);
      if (!member) { this.store.setRestartWake(memberId, null); continue; }
      let wake = saved;
      if (wake.state === "resumed") {
        // 이어가기 글이 나갔거나 없어졌으면 표식의 일은 끝났다.
        const resume = wake.resumeId ? this.store.getDelivery(wake.resumeId) : null;
        if (!resume || !["queued", "held", "delivering"].includes(resume.status)) this.store.setRestartWake(memberId, null);
        continue;
      }
      if (wake.generation !== this.store.memberRevisions(memberId).sessionGeneration || !this.restartWakeTarget(member)) { this.settleRestartWake(memberId, "dropped"); continue; }
      const rt = this.runtime(memberId);
      // 띄우기·끝내기가 진행 중이거나 결과를 모른다. 정해진 뒤에 다시 본다.
      if (this.pendingLifecycle(memberId) || rt.closing || rt.reopening || rt.starting) continue;
      // 다른 길(대표의 말, 깨우기, 재결합)로 이미 깨어 있다.
      if (member.status !== "offline") { this.settleRestartWake(memberId, "dropped"); continue; }
      if (wake.state === "failed") continue;
      if (wake.state === "opening") {
        // 여는 중이던 시도가 결과를 남기지 못했다(그사이 서버가 내려갔거나, 뜨지 않은 것으로 정리됐다). 한 번만 더 해 본다.
        if (wake.attempts >= RESTART_WAKE_MAX_ATTEMPTS) { this.settleRestartWake(memberId, "failed"); continue; }
        wake = { ...wake, state: "pending" };
        this.store.setRestartWake(memberId, wake);
      }
      if (this.quickExitLocked(rt)) { this.settleRestartWake(memberId, "dropped"); continue; }
      // 엔진이 답했고 이 팀장의 터미널이 없다는 것이 확인돼야 연다. 엔진이 아직 답하지 않으면(부팅 직후) 기다린다.
      if (member.paneId || !this.coreAbsenceConfirmed(member)) continue;
      ready.push(member);
    }
    ready.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return [...ready.filter(m => m.kind !== "worker"), ...ready.filter(m => m.kind === "worker")];
  }

  private restartWaking: Promise<void> | null = null;
  /**
   * 재시작으로 꺼진 팀장을 차례로 다시 연다. recover 가 끝난 뒤와 실행기 상태를 볼 때마다 부른다(엔진이 늦게 뜨면 그때 이어진다).
   * 한 번에 restartWakeParallel 명씩만 연다. 대표의 말이나 지시로 깨우는 기존 길(전달 펌프, 깨우기)은 이 줄을 기다리지 않고,
   * 같은 팀장을 함께 열어도 세션은 하나다(reopen).
   */
  private kickRestartWakes(): void {
    if (this.closed || this.recovering || this.restartWaking) return;
    try { if (!this.restartWakeQueue().length) return; }
    catch (e) { console.error("재시작으로 꺼진 팀장 확인 실패:", e); return; }
    const opened = new Set<string>();
    const lanes = Math.max(1, Math.floor(this.timings.restartWakeParallel) || 1);
    const run: Promise<void> = Promise.all(Array.from({ length: lanes }, () => this.restartWakeLane(opened)))
      // 원래 깨어 있던 팀장들이다. 상한을 넘으면 프로젝트마다 한 번만 총괄에게 알린다.
      .then(() => { if (!this.closed) for (const projectId of opened) this.checkAwakeLimit(projectId); })
      .catch(e => console.error("재시작으로 꺼진 팀장을 다시 여는 중 오류:", e))
      .finally(() => { if (this.restartWaking === run) this.restartWaking = null; });
    this.restartWaking = run;
  }

  private async restartWakeLane(opened: Set<string>): Promise<void> {
    while (!this.closed && !this.recovering) {
      const member = this.restartWakeQueue()[0];
      if (!member) return;
      const wake = this.store.getRestartWake(member.id)!;
      // 열기 전에 적는다. 서버가 도중에 내려가도 '한 번 해 봤다'가 남는다.
      this.store.setRestartWake(member.id, { ...wake, state: "opening", attempts: wake.attempts + 1 });
      let reopened: Member | null = null;
      try { reopened = await this.reopen(member); }
      catch (e) { console.warn(`${member.name} 스스로 다시 열기 실패:`, (e as Error).message); }
      if (this.closed) return;
      if (reopened) {
        opened.add(member.projectId);
        void this.pump(member.id);
      } else if (this.store.getMember(member.id) && this.pendingLifecycle(member.id)?.intent !== "start") {
        // 꺼진 채 두고 다음 팀장으로 넘어간다. 오류 안내는 reopen 이 lastError 에 남겼다.
        this.settleRestartWake(member.id, "failed");
      }
      // 띄운 결과를 모르면(미확정 기동) 표식을 '여는 중'으로 둔다. 재결합이 떴다고 확인하거나, 뜨지 않은 것으로 정리된 뒤에 다시 본다.
      await this.restartWakeSettle(member.id);
    }
  }

  /** 방금 연 팀장이 자리를 잡을 때까지 다음 차례를 미룬다: CLI 가 상태를 알렸거나(쉬는 중·일하는 중·막힘), restartWakeSettleMs 가 지났다. */
  private async restartWakeSettle(memberId: string): Promise<void> {
    const since = Date.now();
    for (;;) {
      if (this.closed) return;
      const elapsed = Date.now() - since;
      if (elapsed >= this.timings.restartWakeGapMs && (elapsed >= this.timings.restartWakeSettleMs || this.restartWakeSettled(memberId))) return;
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, Math.max(1, this.timings.restartWakePollMs)); timer.unref?.(); });
    }
  }

  private restartWakeSettled(memberId: string): boolean {
    const member = this.store.getMember(memberId);
    if (!member || !member.paneId || member.status === "offline" || member.status === "asleep") return true;
    const runner = this.runners.get(this.backendOf(member));
    const observed = runner instanceof CoreRunner ? runner.observationState(memberId) : null;
    // CLI 가 스스로 알린 상태가 있거나, 알아본 창(폴더 신뢰·사용 한도 등) 앞이다. 아직 아무것도 알리지 않았으면 뜨는 중이다.
    return !observed || !!observed.setupError || ["idle", "done", "error", "working", "blocked"].includes(observed.state ?? "");
  }

  private completeExecutionReview(member: Member, run: ExecutionJournal): void {
    const match = /^board_review:(\d+):(\d+)$/.exec(run.reason ?? "");
    if (!match) return;
    const requestedRevision = Number(match[1]);
    const reviewedRevision = Number(match[2]);
    if (this.store.getBoardReview(member.projectId)?.requestedRevision !== requestedRevision) return;
    this.store.completeBoardReview(member.projectId, requestedRevision, reviewedRevision);
    this.store.setBoardTidiedAt(member.projectId, new Date().toISOString());
  }

  private requestMissingReport(member: Member, run: ExecutionJournal): void {
    if (this.store.requireProject(member.projectId).archived || this.backendOf(member) !== "core" || run.reason === "awaiting_delegation" || this.runtime(member.id).delegated) return;
    const deliveries = run.deliveryIds.map(id => this.store.getDelivery(id)).filter((d): d is Delivery => !!d);
    if (!deliveries.some(d => d.wake) || deliveries.every(isTidy)) return;
    const supplementOnly = deliveries.some(d => d.text.startsWith(formatSystem("보고 보완")));
    // 총괄의 직원 보고 확인 턴에는 대표에게 다시 최종 보고를 요구하지 않는다.
    if (!supplementOnly && member.kind !== "worker" && !deliveries.some(d => d.wake && ["user_message", "answer"].includes(d.kind))) return;
    if (this.store.hasExecutionReport(run)) return;
    this.store.claimExecutionNotice(run.runId, "report", () => {
      if (supplementOnly) {
        this.store.createMessage({ id: `msg_missing_report_${run.runId}`, projectId: member.projectId, who: "시스템", kind: "시스템", title: "결과 보고 누락", body: `${member.name}의 결과 보고가 보완 요청 뒤에도 남지 않았습니다. 기존 업무를 다시 실행하지 않고 결과를 확인해 주세요.` });
        this.store.appendActivity(member.id, "error", "결과 보고 누락: 보완 요청 뒤에도 결과가 남지 않았습니다", `${run.runId}:missing_report_final`);
        // 일을 맡긴 총괄은 보고가 와야 깨어난다. 끝내 보고가 없으면 프로젝트가 조용히 멈추므로, 중단 알림과 같은 길로 총괄에게 한 번 알린다.
        // 시스템 글로 깬 총괄의 턴에는 보고 보완이 붙지 않고(위 조건), 이 자리는 실행마다 한 번만 돈다(claimExecutionNotice).
        const conductor = member.kind === "worker" ? this.store.getConductor(member.projectId) : null;
        if (conductor && conductor.id !== member.id) {
          const source = deliveries.map(d => /^\[시스템\] 보고 보완: 실행 (\S+)의 결과만 post로/.exec(d.text)?.[1]).find(Boolean) ?? run.runId;
          this.store.enqueue({ projectId: member.projectId, memberId: conductor.id, kind: "system", text: formatSystem(`${member.name}의 결과 보고가 보완 요청 뒤에도 없습니다(실행 ${source}). 기존 업무를 다시 시키기 전에 기존 변경과 진행 상태를 확인한 뒤 후속 지시를 결정하세요.`), wake: true });
          // 이 자리는 DB 트랜잭션 안이다. 총괄의 전달은 트랜잭션이 끝난 뒤에 민다(재시작 복구 중이면 복구 끝의 펌프가 민다).
          setImmediate(() => void this.pump(conductor.id));
        }
        return;
      }
      this.store.appendActivity(member.id, "system", "필수 보고가 없어 보고 보완을 요청했습니다", `${run.runId}:missing_report`);
      this.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "system", ...(this.recovering ? { nextAttemptAt: new Date(Date.now() + this.timings.retryMs).toISOString() } : {}), text: formatSystem(`보고 보완: 실행 ${run.runId}의 결과만 post로 알려 주세요. 기존 업무를 다시 실행하지 마세요. 완료·막힘 또는 질문/위임 대기 상태를 명시하세요.`) });
    });
  }

  async operation(operationId: string): Promise<OperationReceipt> {
    const receipt = this.store.getOperation(operationId);
    if (!receipt) throw new ApiError(404, "작업을 찾을 수 없습니다", "operation_not_found");
    if (receipt.projectId) this.store.requireProject(receipt.projectId);
    if (receipt.memberId && this.store.requireMember(receipt.memberId).projectId !== receipt.projectId) throw new ApiError(404, "작업을 찾을 수 없습니다", "operation_not_found");
    return receipt;
  }

  async freshMemberSessionV2(memberId: string, request: FreshSessionRequest): Promise<OperationReceipt<"fresh_session">> {
    const member = this.store.requireMember(memberId);
    const existing = this.store.getOperation(request.operationId);
    const receipt = this.store.beginOperation({ operationId: request.operationId, kind: "fresh_session", projectId: member.projectId, memberId, request }) as OperationReceipt<"fresh_session">;
    if (existing || receipt.status !== "pending") return receipt;
    try {
      if (this.store.memberRevisions(memberId).sessionGeneration !== request.expectedSessionGeneration) throw new ApiError(409, "세션 세대가 변경되었습니다", "SESSION_CONFLICT");
      const updated = await this.freshMemberSession(memberId);
      return this.store.finishOperation({ ...receipt, status: "applied", result: { member: updated, sessionGeneration: this.store.memberRevisions(memberId).sessionGeneration } }) as OperationReceipt<"fresh_session">;
    } catch (error) {
      const unknown = this.pendingLifecycle(memberId)?.phase === "unknown" || (error instanceof CoreError && error.uncertain);
      return this.store.finishOperation({ ...receipt, status: unknown ? "unknown" : "refused", code: unknown ? "SESSION_UNKNOWN" : "SESSION_REFUSED", error: (error as Error).message.slice(0, 500), ...receiptReason(error, "SESSION_REFUSED") }) as OperationReceipt<"fresh_session">;
    }
  }

  async terminalControlV2(memberId: string, request: TerminalControlRequestV2): Promise<OperationReceipt<"terminal_control">> {
    const member = this.store.requireMember(memberId);
    const existing = this.store.getOperation(request.operationId);
    const receipt = this.store.beginOperation({ operationId: request.operationId, kind: "terminal_control", projectId: member.projectId, memberId, request }) as OperationReceipt<"terminal_control">;
    if (existing || receipt.status !== "pending") return receipt;
    let attempted = false;
    try {
      if (request.action !== "release") this.requireActive(this.store.requireProject(member.projectId));
      const generation = this.store.memberRevisions(memberId).sessionGeneration;
      if (generation !== request.expectedSessionGeneration) throw new ApiError(409, "세션 세대가 변경되었습니다", "session_generation_changed");
      const lease = this.store.inputState(memberId).lease;
      if (request.action === "claim" && lease && lease.claimId !== request.claimId) throw new ApiError(409, "다른 조작권이 있습니다", "terminal_lease_other");
      if (request.action !== "claim" && (!lease || lease.claimId !== request.claimId || lease.identity.terminalId !== member.paneId)) throw new ApiError(409, "조작권이 만료되었거나 바뀌었습니다", "terminal_lease_expired");
      if ((request.action === "input" || request.action === "key") && request.inputSequence !== lease!.lastInputSequence + 1) throw new ApiError(409, "입력 순번이 변경되었습니다", "terminal_input_sequence_stale");
      attempted = true;
      const result = await this.terminalControl(memberId, { action: request.action, leaseId: lease?.leaseId ?? request.claimId, ...(request.action === "input" ? { text: request.text } : request.action === "key" ? { key: request.key } : {}) });
      return this.store.finishOperation({ ...receipt, status: "applied", result: { memberId, action: request.action, claimId: request.claimId, sessionGeneration: generation, ...result, ...((request.action === "input" || request.action === "key") ? { inputSequence: request.inputSequence } : {}) } }) as OperationReceipt<"terminal_control">;
    } catch (error) {
      const unknown = attempted && !(error instanceof ApiError && error.code === "TERMINAL_REFUSED");
      return this.store.finishOperation({ ...receipt, status: unknown ? "unknown" : "refused", code: unknown ? "TERMINAL_UNKNOWN" : "TERMINAL_REFUSED", error: (error as Error).message.slice(0, 500), ...receiptReason(error, "TERMINAL_REFUSED") }) as OperationReceipt<"terminal_control">;
    }
  }

  async patchMemberConfigV2(memberId: string, patch: PatchMemberReq, precondition: RevisionPrecondition): Promise<MemberConfigWriteResult> {
    this.store.requireMember(memberId);
    if (this.configWrites.has(memberId)) throw new ApiError(409, "팀원 설정을 적용하는 중입니다", "member_config_busy");
    if (this.store.memberRevisions(memberId).configRevision !== precondition.expectedRevision) throw new ApiError(409, "팀원 설정이 변경되었습니다", "REVISION_CONFLICT");
    this.configWrites.add(memberId);
    try {
      const member = await this.patchMemberConfigOnce(memberId, patch);
      return { member, ...this.store.memberRevisions(memberId) };
    } finally { this.releaseConfigWrite(memberId); }
  }

  async updateSettingsV2(patch: SettingsPatch, precondition: RevisionPrecondition): Promise<SettingsWriteResult> {
    if (this.settingsWriting) throw new ApiError(409, "설정을 적용하는 중입니다", "settings_busy");
    if (this.store.settingsRevision() !== precondition.expectedRevision) throw new ApiError(409, "설정이 변경되었습니다", "REVISION_CONFLICT");
    this.settingsWriting = true;
    try {
      const settings = await this.updateSettingsOnce(patch);
      return { settings, revision: this.store.settingsRevision() };
    } finally { this.settingsWriting = false; this.resumePumps(); }
  }

  async setTodoDoneV2(todoId: string, request: TodoDoneRequest, precondition: RevisionPrecondition): Promise<TodoWriteResult> {
    if (this.store.todoRevision(todoId) !== precondition.expectedRevision) throw new ApiError(409, "할 일이 변경되었습니다", "REVISION_CONFLICT");
    const writing = this.setTodoDone(todoId, request.done, request);
    const revision = this.store.todoRevision(todoId);
    const todo = await writing;
    return { todo, revision };
  }

  async dropTodoV2(todoId: string, request: { reason?: string }, precondition: RevisionPrecondition): Promise<TodoWriteResult> {
    if (this.store.todoRevision(todoId) !== precondition.expectedRevision) throw new ApiError(409, "할 일이 변경되었습니다", "REVISION_CONFLICT");
    const writing = this.dropTodo(todoId, request.reason);
    const revision = this.store.todoRevision(todoId);
    return { todo: await writing, revision };
  }

  // ---- 시작·종료 ----
  /** 서버 재시작 복구(§6). 끊긴 턴을 정리하고 대기열을 다시 민다. */
  async recover(): Promise<void> {
    this.recovering = true;
    // E3: 지난 프로세스가 남긴 판정은 사유만 이어 보인다. 기한을 재는 시각은 이 프로세스에서 다시 센다(곧바로 다시 판정한다).
    this.recoverStep("전달 판정 시각", () => this.store.restartPumpVerdictClocks());
    try {
      for (const member of this.store.listAllMembers()) {
        if (this.backendOf(member) !== "core") continue;
        this.recoverStep(`${member.id} 문맥 상태`, () => {
          const state = this.store.ensureContextState(member.id);
          this.store.saveContextState({ ...state, measurement: state.measurement ? { ...state.measurement, fresh: false } : null,
            compaction: state.compaction && ["sending", "running"].includes(state.compaction.phase) ? { ...state.compaction, phase: "uncertain", reason: "send_uncertain" } : state.compaction });
        });
      }
      // An interrupted external mutation is never replayed on restart.
      for (const receipt of this.store.listPendingOperations()) if (receipt.status === "pending") this.store.finishOperation({ ...receipt, status: "unknown", code: "RESTART_UNKNOWN", error: "서버 재시작으로 작업 결과를 확인할 수 없습니다. 같은 입력을 재생하지 않습니다" });
      await this.recoverStops();
      // 봉투는 쓰기 직전에야 write_started 가 된다. 이전 프로세스가 prepared 로 남긴 것은 쓴 적이 없으니 거절로 닫아 다시 보내게 한다.
      for (const dispatch of this.store.listPreparedDispatches()) this.recoverStep(`봉투 ${dispatch.dispatchId}`, () => {
        if (dispatch.baseline.serverEpoch !== this.deliveryEpoch) this.store.updateDispatch(dispatch.dispatchId, "prepared", "rejected");
      });
      // 이미 전달된 것은 되살릴 일이 없다. 전부 훑으면 이력만큼 시작이 느려진다(실측 2,442건에 1.25초).
      for (const d of this.store.listDeliveries()) if (d.status !== "delivered") this.recoverStep(`전달 ${d.id}`, () => this.deliveryRecovery.requeueRejected(d.id));
      for (const d of this.store.listDelivering()) this.recoverStep(`전달 ${d.id}`, () => this.deliveryRecovery.beginRecovery(d.id));
      this.store.releaseHeldBeforeConnection();
      // K(E2): 지난 실행이 남긴 도구 승인 카드는 닫는다. 그 훅은 서버와 함께 끊겨 CLI 가 터미널의 원래 승인 창으로 갔다.
      this.recoverStep("도구 승인 카드", () => this.toolPermissions.closeLeftovers());
      await this.refreshConnection();
      for (const member of this.store.listAllMembers()) this.recoverStep(`${member.id} 세션 복구`, () => {
        if (member.subagents !== 0 || !member.subagentState) this.store.patchMember(member.id, { subagents: 0, subagentState: { quality: "unknown", count: null, observedAt: null, sessionGeneration: this.store.memberRevisions(member.id).sessionGeneration } });
        if (member.origin === "manual") return;
        const project = this.store.requireProject(member.projectId);
        // 지워진 옛 실행기(herdr·headless)가 띄운 세션이다. 이어 열지도 넘겨받지도 않고, 대표가 새 세션으로 바꿀 때까지 전달을 세워 둔다.
        if (member.backend !== "core" && (member.sessionId || member.paneId)) {
          for (const d of this.store.listPending(member.id)) this.hold(d, "legacy_session");
          this.store.patchMember(member.id, { lastError: "이전 실행기의 세션입니다. 새 core 세션으로 명시적으로 전환해야 합니다" });
          return;
        }
        if (this.watchesCore(member, project)) {
          this.coreSupervisor?.watch(this.runnerMember(member, project));
          if (!this.coreSupervisor && member.paneId) this.store.patchMember(member.id, { lastError: CORE_RECONNECT_HELD_NOTE, fenceCode: "core_reconnect_held" });
        }
      });
      await this.coreSupervisor?.tick();
      await Promise.all([...this.eventQueues.values()]);
      await this.reconcileExecutions();
    } finally { this.recovering = false; }
    this.coreSupervisor?.start();
    this.startTick();
    // 재시작으로 꺼진 팀장을 천천히 다시 연다. 기다리지 않는다: 아래의 전달·깨우기는 이 줄과 따로 간다.
    this.recoverStep("재시작으로 꺼진 팀장 다시 열기", () => { this.adoptRestartNotes(); this.kickRestartWakes(); });
    const checking = this.settleInFlight();
    const ids = new Set(this.store.listUndelivered().map((d) => d.memberId));
    await Promise.all([checking, ...[...ids].map(id => this.pump(id))]);
    await this.retryOrphans();
  }

  /** 읽을 수 없는 행 하나가 서버 시작 전체를 막지 않게 한다. 그 항목은 건너뛰고 기록만 남긴다(다음 틱·점검이 다시 본다). */
  private recoverStep(what: string, step: () => unknown): void {
    try { step(); } catch (e) { console.error("재시작 복구 중 건너뜀:", what, (e as Error).message); }
  }

  /** Every backend uses persisted item evidence; legacy missing envelopes stay fenced. */
  private async settleInFlight(): Promise<void> {
    try {
      await this.deliveryRecovery.tick();
      this.reconcileTodoCorrections();
      this.reconcileRejectedExecutions();
      this.releaseSlots();
    } finally { this.scheduleRecoveryCheck(); }
  }

  /**
   * 여러 직원의 펌프를 한 번에 쏟아내면 그 동기 구간과 뒤따르는 마이크로태스크가 소켓·타이머보다 먼저 돌아
   * HTTP·WebSocket·터미널 스트림이 그동안 멈춘다. 직원마다 차례를 넘겨 사이에 다른 일이 돌게 한다(직원별 순서는 rt.pumping 이 지킨다).
   */
  private pumpEach(ids: string[]): void {
    const [first, ...rest] = ids;
    if (first === undefined || this.closed) return;
    void this.pump(first);
    if (rest.length) setImmediate(() => this.pumpEach(rest));
  }

  private lastStallCheck = 0;
  /**
   * 정체 감지는 프로젝트의 전달 이력을 통째로 읽는다. 5초 점검·30초 틱·전달 확인이 저마다 돌리던 것을 10초에 한 번으로 묶는다
   * (판정 기준이 60초·120초라 그보다 자주 볼 까닭이 없다).
   */
  private detectStallsSoon(): void {
    if (Date.now() - this.lastStallCheck < Math.min(10_000, this.timings.healthMs * 2)) return;
    this.lastStallCheck = Date.now();
    this.rejudgeQuietVerdicts();
    this.store.detectDeliveryStalls();
  }

  /**
   * E3: 끝을 알리는 사건이 빠지면 낡는 판정(일하는 중, 직접 띄운 세션)을 펌프가 다시 판정하게 한다. 기다리는 전달이 있는 팀장만.
   * 예전에는 저장소가 정체 점검 때마다 이 펌프의 메모리 상태를 콜백으로 읽어 '일한다는데 CLI 는 쉬는 중'을 다시 추측했다.
   * 이제는 펌프가 다시 판정해 남기고(busy_unconfirmed), 정체 점검은 그 판정이 기한을 넘겼는지만 본다.
   */
  private rejudgeQuietVerdicts(): void {
    if (this.closed || this.recovering) return;
    let ids: string[] = [];
    try { ids = [...new Set(this.store.listUndelivered().map(d => d.memberId))].filter(id => verdictRejudged(this.store.pumpVerdict(id)?.code ?? "")); }
    catch (e) { console.warn("전달 판정 다시 보기 실패:", (e as Error).message); return; }
    this.pumpEach(ids.filter(id => !this.runtimes.get(id)?.pumping));
  }

  /** 전송 호출이 아직 끝나지 않은 봉투. 단계 제한으로 펌프가 먼저 풀려도 호출이 끝날 때까지 남는다. */
  private readonly liveWrites = new Set<string>();

  private readonly startedAt = Date.now();

  /**
   * 이 봉투의 쓰기에서 더 올 것이 없다: 전송 호출이 끝났고(또는 쓴 프로세스가 죽었고) 그 뒤 writeSettleMs 가 지났다.
   * 이전 프로세스의 쓰기는 이 프로세스가 뜬 때부터 센다. 적힌 시각은 쓰기를 시작한 때라, 죽기 직전까지 돌던 호출을 일찍 끝난 것으로 본다.
   */
  writerDone(dispatch: DeliveryDispatch): boolean {
    return !this.liveWrites.has(dispatch.dispatchId) && Date.now() - Math.max(Date.parse(dispatch.updatedAt), this.startedAt) >= this.timings.writeSettleMs;
  }

  /** 이 프로세스의 전송 호출이 아직 돌아오지 않은 봉투인가. 사라진 터미널의 봉투도 그 호출이 끝난 뒤에 판정한다. */
  writing(dispatch: DeliveryDispatch): boolean {
    return this.liveWrites.has(dispatch.dispatchId);
  }

  /**
   * core 실행기에 원래 쓰기의 상태를 알려 준다. 예전에는 영수증이 없으면 언제나 '미해결'이라 자동 재전송, 위험 동의 재전송,
   * '그만 보내기' 뒤의 해제가 모두 동작하지 않았고, 전송 중 재시작 한 번이 그 직원의 대기열을 영영 막았다.
   * - prepared: 쓰기 직전에야 write_started 로 바뀐다. 쓴 적이 없다.
   * - write_started/unknown: 전송 호출이 끝나고 writeSettleMs 가 지나면 더 올 것이 없다(결과는 모른다: unconfirmed).
   * - 다른 입력이 없었다는 판단: 대표가 중복 위험에 동의했거나, 보낸 뒤 CLI 의 턴 번호가 그대로다.
   * 실제로 다시 쓸지는 실행기가 기록·입력칸·쉬는 상태를 다시 확인해 정한다.
   */
  dispatchQuiescence(memberId: string, dispatch: DeliveryDispatch): { originalWrite: "not_written" | "rejected" | "settled" | "unresolved"; externalInput: boolean | null; unconfirmed?: boolean; riskApproved?: boolean } {
    const riskApproved = dispatch.items.length > 0 && dispatch.items.every(item => this.store.getDelivery(item.deliveryId) && this.store.getDeliveryRetry(item.deliveryId).retryReason?.startsWith("delivery_risk:"));
    const runner = this.runners.get("core");
    const observed = runner instanceof CoreRunner ? runner.observationState(memberId) : null;
    const untouched = !!observed && observed.failures === 0 && dispatch.baseline.turn !== null && observed.turn === dispatch.baseline.turn;
    const externalInput = riskApproved || untouched ? false : null;
    if (dispatch.transportState === "rejected") return { originalWrite: "rejected", externalInput, riskApproved };
    if (dispatch.transportState === "prepared") return { originalWrite: "not_written", externalInput, riskApproved };
    if (dispatch.transportState === "accepted") {
      const delivered = dispatch.items.every(item => this.store.getDelivery(item.deliveryId)?.status === "delivered");
      return { originalWrite: "settled", externalInput: delivered ? null : externalInput, unconfirmed: !delivered, riskApproved };
    }
    if (!this.writerDone(dispatch)) return { originalWrite: "unresolved", externalInput: null };
    return { originalWrite: "settled", externalInput, unconfirmed: true, riskApproved };
  }

  /** 단계 제한 뒤 늦게 끝난 전송 호출의 확정 결과(쓰지 않음·거절·수신)를 받아 '확인 필요'로 남은 봉투를 닫는다. */
  private lateSendResult(memberId: string, dispatch: DeliveryDispatch, late: SendResult): void {
    if (this.closed || !this.store.getMember(memberId)) return;
    if (!late.ok && !["not_written", "rejected"].includes(late.deliveryEffect ?? "unknown")) return;
    const at = new Date().toISOString();
    try {
      this.deliveryRecovery.recordResult(dispatch.dispatchId, late.ok ? { ...late, receipt: late.receipt ?? { dispatchId: dispatch.dispatchId, receivedAt: at, source: "transport" } } : late);
      const run = this.store.getExecutionJournal(dispatch.dispatchId);
      if (run && run.phase === "unknown") this.store.saveExecutionJournal({ ...run, ...(late.ok
        ? { phase: late.started ? "running" as const : "received" as const, inputReceivedAt: at, startedAt: late.started ? at : null, turn: late.turn ?? run.turn }
        : { phase: "ended" as const, result: "error" as const, reason: late.detail ?? late.reason, endedAt: at }), updatedAt: at });
      this.store.appendActivity(memberId, "system", late.ok ? "늦게 도착한 수신 확인으로 전달을 확정했습니다" : "늦게 도착한 결과로 넣지 못한 것을 확인했습니다. 다시 보냅니다", `late-result:${dispatch.dispatchId}`);
    } catch (e) { console.warn("늦은 전송 결과 처리 실패:", memberId, (e as Error).message); return; }
    void this.pump(memberId);
  }

  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 전달 확인은 1·3·10초 간격으로 다시 보도록 적어 두지만 도는 곳은 30초 틱뿐이었다. 그래서 실제로 전달된 글도
   * 최대 30초씩 '확인 중'으로 그 직원의 대기열을 막았다. 다음 확인 시각이 틱보다 이르면 그때 한 번 더 본다.
   */
  private scheduleRecoveryCheck(): void {
    if (this.closed || this.recoveryTimer) return;
    // 방금 돈 확인이 그대로 둔 지난 시각(보관된 프로젝트, 직접 조작 중, 읽기 실패)은 30초 틱에 맡긴다. 세면 1초마다 영원히 다시 돈다.
    const next = this.store.nextDeliveryCheckAt(this.deliveryRecovery.lastRunAt), now = Date.now();
    // 일하는 직원을 기다리는 확인은 몇 시간씩 이어질 수 있다. 5초보다 자주 보지 않는다.
    const due = Math.min(next.active ?? Infinity, next.waiting === null ? Infinity : Math.max(next.waiting, now + 5000));
    if (due - now >= this.timings.tickMs) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.settleInFlight().catch(e => console.warn("전달 확인 실패:", e));
    }, Math.max(due - Date.now(), 1000));
    this.recoveryTimer.unref?.();
  }

  private reconcileRejectedExecutions(): void {
    for (const run of this.store.listPendingExecutions()) {
      const dispatch = this.store.getDispatch(run.runId);
      if (!dispatch || run.startedAt || run.inputReceivedAt) continue;
      // 받았는지 모른 채 닫힌 봉투: 쓰기는 끝났고 항목은 모두 '그만 보내기'나 새 봉투로 넘어갔다. 그 실행 기록이 남으면
      // 끝날 턴이 없는데도 '일하는 중'으로 세어져 그 직원의 전달이 계속 멈춘다.
      const abandoned = dispatch.transportState === "accepted" && dispatch.items.every(item => {
        const d = this.store.getDelivery(item.deliveryId);
        return !d || d.status !== "delivered" && (this.store.getDeliveryRecovery(d.id)?.phase === "stopped" ||
          this.store.listDispatches(d.memberId).filter(other => other.items.some(i => i.deliveryId === d.id)).at(-1)?.dispatchId !== dispatch.dispatchId);
      });
      if (dispatch.transportState !== "rejected" && !abandoned) continue;
      const at = new Date().toISOString();
      this.store.saveExecutionJournal({ ...run, phase: "ended", result: "error", reason: dispatch.transportState === "rejected" ? run.reason ?? "not_written" : "unconfirmed_closed", endedAt: at, updatedAt: at });
    }
  }

  /** 대표의 전달 복구 요청(다시 확인·위험 동의 재전송·그만 보내기). 결정이 다음 틱을 기다리지 않고 곧바로 반영되게 한다. */
  async recoverDelivery(deliveryId: string, request: DeliveryRecoveryRequest): Promise<DeliveryRecoveryResult> {
    const result = await this.deliveryRecovery.recover(deliveryId, request);
    try {
      const delivery = this.store.getDelivery(deliveryId);
      if (delivery && !this.closed) {
        // 끝난 쓰기의 펜스와 실행 기록을 닫고, 확인·재전송을 지금 한 번 돌린 뒤 그 직원의 대기열을 민다.
        this.deliveryRecovery.fenced(delivery.memberId);
        void this.settleInFlight().catch(e => console.warn("전달 확인 실패:", e)).then(() => this.pump(delivery.memberId));
      }
    } catch (e) { console.warn("전달 복구 뒤 처리 실패:", (e as Error).message); }
    return result;
  }

  private startTick(): void {
    if (this.tick) return;
    this.apiRecovery.start();
    this.tick = setInterval(() => this.onTick(), this.timings.tickMs);
    this.tick.unref?.();
    this.healthTimer = setInterval(() => void this.refreshConnection().catch((e) => console.warn("실행기 상태 확인 실패:", (e as Error).message)), this.timings.healthMs);
    this.healthTimer.unref?.();
  }

  /** 전역 실행기가 지금 쓸 수 있는지 다시 본다. 달라졌으면 화면에 알리고, 돌아왔으면 보류된 것을 민다. 겹쳐 불러도 한 번만 묻는다. */
  refreshConnection(): Promise<void> {
    if (!this.healthProbe) {
      let known!: () => void;
      this.healthKnown = new Promise<void>(resolve => { known = resolve; });
      this.healthProbe = this.probeHealth(known).finally(() => {
        known();
        this.healthProbe = null; this.healthKnown = null;
      });
    }
    return this.healthProbe;
  }

  /**
   * 화면 요청용. 연결 상태(실행기가 답하는지)만 다시 보고, 뒤따르는 정리(멈춤 복구·전 직원 재관측·정체 감지)는
   * 기다리지 않는다. 실행기가 늦게 답하면 마지막으로 아는 상태로 진행한다. 정리는 같은 점검이 뒤에서 끝낸다.
   */
  async refreshHealth(waitMs = this.timings.screenWaitMs): Promise<void> {
    const probe = this.refreshConnection();
    probe.catch(e => console.warn("실행기 상태 확인 실패:", (e as Error).message));
    await briefly(this.healthKnown ?? probe.catch(() => {}), waitMs, () => undefined);
  }

  /**
   * Real 2026-11-07 run: one member's pump never settled (queue stuck for minutes, other members fine, gone after a
   * daemon restart) and nothing said where it waited. Report the stage once per pump. Diagnostics only: this never
   * sends, presses Enter, interrupts or resets the pump.
   */
  private reportStuckPumps(timedOutMemberId?: string): void {
    const now = Date.now();
    for (const [memberId, rt] of this.runtimes) {
      if (!rt.pumping || rt.pumpReported || rt.pumpSince === null || now - rt.pumpSince < this.timings.stuckPumpMs && memberId !== timedOutMemberId) continue;
      const member = this.store.getMember(memberId);
      if (!member) continue;
      rt.pumpReported = true;
      const seconds = Math.round((now - rt.pumpSince) / 1000);
      const text = `전달 처리가 ${seconds}초째 끝나지 않았습니다(대기 단계: ${rt.pumpStage ?? "알 수 없음"}). 자동으로 다시 넣거나 중단하지 않습니다`;
      this.store.appendActivity(memberId, "error", text, `pump-stuck:${rt.pumpSince}`);
      console.warn("전달 펌프 정체:", memberId, rt.pumpStage, `${seconds}s`);
    }
  }

  private controlFenced(member: Member): boolean {
    return member.fenceCode === "control_unknown" ||
      this.store.deferredMemberConfig(member.id)?.signature === `parallel_unknown:${this.store.memberRevisions(member.id).sessionGeneration}`;
  }

  private coreAbsenceConfirmed(member: Member): boolean {
    return member.status === "offline" && !member.paneId && !this.pendingLifecycle(member.id) &&
      this.absentCoreMembers.get(member.id) === this.store.memberRevisions(member.id).sessionGeneration;
  }

  private async probeHealth(known?: () => void): Promise<void> {
    const backend = this.store.effectiveBackend();
    const runner = this.runners.get(backend);
    const state = runner ? await runner.available().catch((e: Error) => ({ ok: false, detail: e.message })) : { ok: false, detail: "실행기가 없습니다" };
    if (this.closed) return;
    if (backend === "core") this.lastCoreAvailability = state;
    const changed = this.store.setRunnerHealth(backend, { ok: state.ok, detail: state.ok ? null : state.detail });
    known?.();
    await this.recoverStops();
    for (const member of this.store.listAllMembers()) {
      const project = this.store.requireProject(member.projectId);
      if (this.watchesCore(member, project)) this.coreSupervisor?.watch(this.runnerMember(member, project));
      else this.coreSupervisor?.unwatch(member.id);
    }
    await this.coreSupervisor?.tick();
    await this.reconcileExecutions();
    // 엔진이 이제 답해 '터미널 없음'이 확인된 팀장, 서버가 떠 있는 동안 엔진이 다시 시작돼 꺼진 팀장을 이어서 연다.
    this.kickRestartWakes();
    this.reportStuckPumps();
    this.detectStallsSoon();
    if (!changed) return;
    if (!state.ok) return;
    for (const id of new Set(this.store.listUndelivered().map((d) => d.memberId))) void this.pump(id);
    void this.retryOrphans().catch((e) => console.warn("보류된 말 전달 재시도 실패:", (e as Error).message));
  }

  /**
   * 틱의 한 단계나 직원 한 명의 읽을 수 없는 상태가 나머지 단계와 다른 직원의 전달을 막지 않게 한다.
   * 타이머 콜백에서 새어 나간 예외는 서버 프로세스를 끝낸다.
   */
  private tickStep(name: string, step: () => void): void {
    try { step(); } catch (e) { this.tickFailed(name, e); }
  }
  private readonly tickFailures = new Map<string, number>();
  private tickFailed(name: string, error: unknown): void {
    // 같은 실패가 틱마다 되풀이되면 1분에 한 줄만 남긴다.
    const now = Date.now(), key = `${name}:${(error as Error)?.message ?? error}`;
    if (now - (this.tickFailures.get(key) ?? 0) < 60_000) return;
    if (this.tickFailures.size >= 100) this.tickFailures.clear();
    this.tickFailures.set(key, now);
    console.error("틱 단계 실패:", name, error);
  }

  private onTick(): void {
    this.tickStep("api_recovery", () => void this.apiRecovery.tick().catch(e => console.warn("API 복구 확인 실패:", e)));
    this.tickStep("delayed_notice", () => { if (Date.now() - this.lastDeliveryNoticeCheck >= 30_000) { this.lastDeliveryNoticeCheck = Date.now(); this.notifyDelayedDeliveries(); } });
    this.tickStep("stalls", () => this.detectStallsSoon());
    let members: Member[] = [];
    this.tickStep("members", () => { members = this.store.listAllMembers(); });
    for (const member of members) this.tickStep(`compact:${member.id}`, () => {
      if (this.backendOf(member) !== "core") return;
      this.reconcileCoreCompact(member);
      if (this.store.getContextState(member.id)?.compaction?.phase === "queued") void this.pump(member.id);
    });
    this.tickStep("in_flight", () => void this.settleInFlight().catch(e => console.warn("전달 확인 실패:", e)));
    this.tickStep("manual_members", () => this.checkManualMembers());
    // 입력칸을 못 찾았거나(선택 창 등) 소켓이 끊겨 못 맞춘 새 설정을 다시 시도한다.
    for (const m of members) this.tickStep(`config:${m.id}`, () => {
      if ((m.status === "idle" || m.status === "waiting") && this.configPending(m)) void this.pump(m.id);
    });
    this.tickStep("orphans", () => void this.retryOrphans().catch((e) => console.warn("보류된 말 전달 재시도 실패:", (e as Error).message)));
    this.tickStep("pump", () => {
      const ids = new Set(
        this.store
          .listUndelivered()
          .filter((d) => !(d.status === "held" && (d.holdReason === "asleep" || d.holdReason === "runner_disabled")))
          .map((d) => d.memberId),
      );
      this.pumpEach([...ids]);
    });
    this.tickStep("board", () => {
      this.checkStaleTodos();
      this.checkBoardTidy();
    });
  }

  /** Passive reminders never pump, start a session, or wake a sleeping member. */
  checkStaleTodos(now = Date.now()): string[] {
    const queued: string[] = [];
    if (this.closed) return queued;
    for (const project of this.store.listProjects()) {
      if (this.archiving.has(project.id)) continue;
      for (const todo of this.store.listStaleTodos(project.id, now)) {
        const requester = todo.memberId ? this.store.getMember(todo.memberId) : null;
        const target = requester?.kind === "worker" ? requester : this.store.getConductor(project.id);
        if (!target) continue;
        const days = Math.floor((now - Date.parse(todo.createdAt)) / 86_400_000);
        if (this.store.remindStaleTodo(todo, target.id, formatSystem(`네가 부탁한 대표의 할 일 #${todo.id} '${quotedInline(todo.title)}' 이 ${days}일째 열려 있다. 다음에 그 일을 할 때 됐는지 직접 확인하고 그 결과를 근거로 todo_close 로 정리해라. 필요 없어졌으면 dropped.`), now)) queued.push(todo.id);
      }
    }
    return queued;
  }

  /**
   * 주기 판 정리: 활성·연결·총괄 idle·중복 방지 조건을 유지한다.
   * 변경+설정 간격 또는 묵은 할 일+24시간 경과 시 요청한다. 정리만 하려고 세션을 띄우지 않는다.
   */
  checkBoardTidy(now = Date.now()): string[] {
    const hours = this.store.getSettings().boardTidyHours;
    if (!(hours > 0) || this.closed) return [];
    const queued: string[] = [];
    for (const project of this.store.listProjects()) {
      if (!project.runnerEnabled || !project.connection.ok || this.archiving.has(project.id)) continue;
      const lead = this.store.getConductor(project.id);
      if (!lead || lead.origin !== "runner" || (!lead.sessionId && !lead.paneId)) continue;
      if (lead.status !== "idle" && lead.status !== "waiting") continue;
      const rt = this.runtime(lead.id);
      if (this.isBusy(lead) || rt.starting || rt.reopening || rt.pumping || rt.closing) continue;
      if (this.tidyPending(lead.id)) continue;
      // 한 번도 정리하지 않았으면 총괄이 뜬 때부터 센다.
      const review = this.store.getBoardReview(project.id);
      const since = review?.requestedAt ?? project.tidiedAt ?? lead.createdAt;
      const staleDue = this.store.listStaleTodos(project.id, now).length > 0 && this.store.staleReviewDue(project.id, now);
      if (!staleDue && now - Date.parse(since) < hours * 3_600_000) continue;
      const changed = this.store.lastBoardChangeAt(project.id);
      if (!staleDue && (review?.completedAt ? this.store.boardRevision(project.id) <= (review.reviewedRevision ?? -1) : !review && (!changed || changed <= since))) continue;
      this.queueBoardReview(project.id, lead, false, new Date(now).toISOString());
      void this.pump(lead.id);
      queued.push(project.id);
    }
    return queued;
  }

  private queueBoardReview(projectId: string, lead: Member, manual: boolean, at = new Date().toISOString()): void {
    this.store.transaction(() => {
      this.store.requestBoardReview(projectId, at);
      if (this.store.listStaleTodos(projectId, Date.parse(at)).length) this.store.markStaleReview(projectId, at);
      this.store.enqueue({ projectId, memberId: lead.id, kind: "system", text: formatTidy(lead.kind, manual) });
    });
  }

  /** 판 정리 지시가 줄 서 있거나 지금 그 턴이 돈다. */
  private tidyPending(memberId: string): boolean {
    if (this.runtimes.get(memberId)?.turn?.deliveries?.some(isTidy)) return true;
    if (this.store.listPendingExecutions().some(run => run.memberId === memberId && run.deliveryIds.some(id => { const delivery = this.store.getDelivery(id); return delivery && isTidy(delivery); }))) return true;
    return this.store.listPending(memberId).some(isTidy);
  }

  /**
   * 대표의 '지금 판 정리'. 간격·바뀐 것을 따지지 않는다. 총괄이 없거나 잠들었으면 띄운다. 연결은 http 가 먼저 본다(409).
   * 이미 기다리거나 도는 판 정리가 있으면 새로 넣지 않는다.
   */
  async tidyBoard(projectId: string): Promise<TidyResult> {
    const project = this.store.requireProject(projectId);
    this.requireActive(project);
    if (!project.runnerEnabled) throw new ApiError(409, "이 프로젝트는 실행이 꺼져 있습니다. 총괄을 먼저 시작하세요", "runner_disabled");
    const lead = this.store.getConductor(projectId) ?? (await this.ensureConductor(projectId));
    if (lead.origin === "adopted") throw new ApiError(409, `${josa(lead.name, "은")} 이전 실행기에서 넘겨받은 세션이라 도구가 없어 판을 정리할 수 없습니다`, "board_tidy_legacy_lead");
    if (this.tidyPending(lead.id)) return { already: true };
    this.queueBoardReview(projectId, lead, true);
    await this.pump(lead.id);
    return { already: false };
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

  /**
   * 전송은 I/O 전에 봉투를 write_started 로 적는다. 결과(거절 포함)를 적기 전에 실행기와 DB 가 닫히면
   * 쓰지도 않은 글이 재시작 뒤 '전달 확인 중'으로 남는다. 새 펌프는 closed 가 막으므로 돌던 것만 끝난다.
   */
  private async drainPumps(): Promise<void> {
    const active = [...this.runtimes.values()].flatMap(rt => [rt.pumping, rt.starting, rt.reopening]).filter((work): work is NonNullable<typeof work> => !!work);
    if (!active.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(active).then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(this.timings.shutdownDrainMs, 0)); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!drained) console.warn(`종료: 진행 중인 전달·세션 기동이 ${this.timings.shutdownDrainMs}ms 안에 끝나지 않아 기다리지 않고 닫습니다`);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.drainPumps();
    await Promise.all([...this.terminalStreamClosers].map(close => close()));
    await this.coreSupervisor?.shutdown();
    await Promise.all([...this.eventQueues.values()]);
    if (this.tick) clearInterval(this.tick);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    for (const memberId of [...this.blockedNoticeTimers.keys()]) this.cancelBlockedNotices(memberId);
    this.toolPermissions.dispose();
    for (const rt of this.runtimes.values()) {
      if (rt.compactTimer) clearTimeout(rt.compactTimer);
      if (rt.retryTimer) clearTimeout(rt.retryTimer);
    }
    for (const waiters of [...this.askWaiters.values(), ...this.inboxWaiters.values()]) {
      for (const wake of waiters) wake();
    }
    await this.apiRecovery.shutdown();
    await this.deliveryRecovery.shutdown();
    await Promise.all([...this.runners.values()].map((r) => r.shutdown()));
  }

  // ---- REST 겉면 ----
  async createProject(req: CreateProjectReq): Promise<Project> {
    const goal = req.goal?.trim();
    const project = this.store.createProject({ name: req.name, cwd: req.cwd, now: goal, creationGoal: req.goal ?? null });
    this.store.setChiefCli(project.id, req.chiefCli ?? "claude");
    // 총괄을 띄우기 전에 남긴다. 첫 기동의 폴더 신뢰 창을 이 답으로 처리한다.
    if (req.trustFolder === true) this.store.trustProjectFolder(project.id, project.cwd);
    if (req.startConductor) {
      const conductor = await this.ensureConductor(project.id);
      if (goal) await this.deliver({ projectId: project.id, memberId: conductor.id, kind: "system", text: formatSystem(`프로젝트 목표: ${guardLines(goal)}`) });
    }
    return this.store.requireProject(project.id);
  }

  async patchProject(projectId: string, patch: PatchProjectReq): Promise<Project> {
    if (this.projectPatches.has(projectId) || this.archiving.has(projectId)) throw new ApiError(409, "프로젝트 변경을 처리하는 중입니다. 잠시 뒤 다시 하세요", "project_busy");
    this.projectPatches.add(projectId);
    const awake = new Set(this.store.listMembers(projectId).filter(m => m.status !== "asleep").map(m => m.id));
    try {
      const project = this.store.requireProject(projectId);
      const validated = this.store.validateProjectPatch(projectId, patch);
      if (project.archived && patch.archived !== false && this.store.listMembers(projectId).some(m => m.origin !== "manual" && m.status !== "asleep" && (m.sessionId || m.paneId))) throw new ApiError(409, "보관된 프로젝트의 세션 종료 상태를 확인해야 합니다", "archive_stop_unverified");
      if (Object.entries(validated).every(([key, value]) => project[key as keyof Project] === value)) return project;
      await this.beforeProjectPatch(project, patch);
      const saved = this.store.patchProject(projectId, validated);
      await this.onProjectPatched(saved, patch);
      return this.store.requireProject(projectId);
    } catch (error) {
      if (!this.store.requireProject(projectId).archived) for (const memberId of awake) {
        if (this.store.getMember(memberId)?.status !== "asleep") continue;
        for (const delivery of this.store.listPending(memberId)) if (delivery.status === "held" && delivery.holdReason === "archived") this.hold(delivery, "asleep");
      }
      throw error;
    } finally {
      this.archiving.delete(projectId);
      this.projectPatches.delete(projectId);
    }
  }

  /** v1 HTTP hook 호환. W9에서 HTTP도 patchProject 한 곳으로 옮긴다. */
  async beforeProjectPatch(project: Project, patch: PatchProjectReq): Promise<void> {
    this.store.validateProjectPatch(project.id, patch);
    if (this.archiving.has(project.id)) throw new ApiError(409, "프로젝트 변경을 처리하는 중입니다. 잠시 뒤 다시 하세요", "project_busy");
    if (patch.runnerEnabled === true && (patch.archived ?? project.archived)) this.requireActive(project);
    if (patch.archived !== true || project.archived) return;
    this.archiving.add(project.id);
    const slept: Member[] = [];
    try {
      this.checkArchivable(project);
      const managed = this.store.listMembers(project.id).filter(m => m.origin !== "manual" && m.status !== "asleep" && (m.sessionId || m.paneId));
      for (const m of managed) {
        const rt = this.runtime(m.id);
        if (rt.starting || rt.reopening || rt.pumping || rt.closing || this.configWrites.has(m.id) || this.terminalMutations.has(m.id) || this.pendingLifecycle(m.id) || this.store.inputState(m.id).lease) throw new ApiError(409, `${m.name}의 세션을 처리하는 중입니다`, "session_busy");
        try {
          await this.verifyArchiveSession(m);
          await this.runnerOf(m).checkStop?.(this.runnerMember(m, project), { whileWorking: false });
        } catch (e) {
          if (this.backendOf(m) !== "core" && this.skipsArchiveRefusal(m, e)) continue;
          throw this.archiveRefusal(m, e);
        }
      }
      this.checkArchivable(project);
      for (const m of managed) {
        try {
          await this.sleepMember(m.id, { force: true, holdAs: "archived" });
          slept.push(m);
        } catch (e) {
          if (this.backendOf(m) !== "core" && this.skipsArchiveRefusal(m, e)) continue;
          const refusal = this.archiveRefusal(m, e);
          throw new ApiError(refusal.status, `${refusal.message}${slept.length ? ` (${slept.map(s => s.name).join(", ")}의 칸은 이미 끝나 잠든 채로 둡니다)` : ""}`, refusal.code);
        }
      }
      this.checkArchivable(project);
      // 장벽은 DB commit과 큐 보류까지 onProjectPatched가 유지한다.
    } catch (e) {
      for (const m of slept) for (const d of this.store.listPending(m.id)) if (d.status === "held" && d.holdReason === "archived") this.hold(d, "asleep");
      this.archiving.delete(project.id);
      throw e;
    }
  }

  private async verifyArchiveSession(member: Member): Promise<void> {
    const runner = this.runnerOf(member);
    if (this.store.inputState(member.id).lease) throw new ApiError(409, "직접 조작권을 해제한 뒤 보관하세요", "archive_terminal_lease");
    if (runner instanceof CoreRunner && !member.sessionId) {
      // 읽기 poll은 기존 terminal의 nonce만 탐색한다. 식별용 업무를 보내지 않는다.
      await runner.screen(this.runnerMember(member, this.store.requireProject(member.projectId)));
      await Promise.all([...this.eventQueues.values()]);
      member = this.store.requireMember(member.id);
    }
    if (!member.sessionId) throw new ApiError(409, "이어갈 native 세션 기록을 확인하는 중입니다", "resume_record_checking");
    // 한 번도 턴을 돌지 않은 세션은 이어갈 기록이 없는 것이 정상이다. 잃을 대화가 없으니 보관을 막지 않는다(꺼내서 깨우면 새 세션으로 열린다).
    if (this.neverRan(member, runner)) return;
    if ((runner as Runner).sessionExists?.(this.runnerMember(member, this.store.requireProject(member.projectId))) === false) throw new ApiError(409, "이어갈 native 세션 기록을 확인할 수 없습니다", "resume_record_missing");
    if (runner instanceof CoreRunner) {
      const log = this.contextLog(member);
      if (!log) throw new ApiError(409, "이어갈 native 세션 기록을 확인할 수 없습니다", "resume_record_missing");
      const records = readJsonlRange(join(log.home, member.cli === "codex" ? "sessions" : "projects"), log.path).records;
      if (member.cli !== "codex" && !records.some(record => {
        const entry = jsonObject(record.value);
        return entry?.sessionId === member.sessionId && entry.cwd === member.cwd && !entry.isSidechain;
      })) throw new ApiError(409, "현재 native 세션과 일치하는 주 세션 기록을 확인할 수 없습니다", "resume_record_mismatch");
    }
  }

  /**
   * 띄우기만 하고 한 번도 턴을 돌지 않은 세션인가(총괄만 시작한 프로젝트, 첫 지시 없이 추가한 팀장).
   * 기록 파일이 없고, 이 세대에 받아들여진 전달이 없고, 관측된 턴도 0 일 때만 그렇다. 대표가 터미널에 직접 쳐서 턴을 돌렸으면 기록이 생겨 해당하지 않는다.
   * Codex 는 세션 ID 를 스스로 정하고 모르는 채로는 다시 띄울 수 없어(session_unknown) 여기서 다루지 않는다.
   */
  private neverRan(member: Member, runner: Runner): boolean {
    if (!(runner instanceof CoreRunner) || member.cli === "codex" || !member.sessionId) return false;
    if (runner.sessionExists(this.runnerMember(member, this.store.requireProject(member.projectId))) !== false) return false;
    const generation = this.store.memberRevisions(member.id).sessionGeneration;
    if (this.store.listDispatches(member.id).some(dispatch => dispatch.identity.sessionGeneration === generation && dispatch.transportState !== "rejected")) return false;
    return !runner.observationState(member.id)?.turn;
  }

  /** 안 보이는 직원의 칸은 소켓이 안 닿아도 보관을 막지 않는다. 쓰던 글이 있다는 거절은 언제나 막는다. */
  private skipsArchiveRefusal(m: Member, e: unknown): boolean {
    if (m.status !== "offline" || this.isCannotExit(e)) return false;
    console.warn(`${m.name} 잠재우기 실패:`, (e as Error).message);
    return true;
  }

  private isCannotExit(e: unknown): boolean {
    return (e instanceof CoreError && !e.uncertain && ["busy", "input_busy", "conflict", "unsupported"].includes(e.kind)) || (e instanceof ApiError && e.status === 409);
  }

  private archiveRefusal(m: Member, e: unknown): ApiError {
    const why = (e as Error).message;
    return this.isCannotExit(e) ? new ApiError(409, `${m.name}의 칸을 끝내지 못해 보관할 수 없습니다: ${why}`, "archive_stop_failed") : new ApiError(503, `${m.name}의 칸을 확인하지 못해 보관할 수 없습니다: ${why}`, "archive_stop_unknown");
  }

  async createMember(projectId: string, req: CreateMemberReq): Promise<Member> {
    return (await this.addMember(projectId, req)).member;
  }

  async freshMemberSession(memberId: string): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 새로 열 수 없습니다", "manual_session_unsupported");
    return this.switchProvider(member, { cli: member.cli }, false, true);
  }

  /**
   * usage: 사용 한도로 멈춘 팀장의 모델(또는 CLI)을 바꿔 다시 연다(patchMemberConfig). 그 턴은 이미 한도 오류로 끝났으므로, 한도 메뉴 때문에 적힌 막힘(blocked)으로는
   * 거절하지 않는다. 끝내기 전에 한도 메뉴를 Esc 로만 닫고, 끝낸 뒤 그 팀장의 한도 보류를 풀고 하던 일의 이어가기 글을 넣는다(resumeAfterUsageStop).
   * 정말 일하는 중이거나(턴·실행기의 일하는 중·불확실한 입력) 입력칸에 쓰던 글이 있으면 지금처럼 거절한다.
   * 보류를 푼 뒤에 새 터미널 기동만 실패하면(같은 CLI) 던지지 않는다: 설정은 미뤄 두었고 펌프가 곧 새 설정으로 다시 연다(outcome.opened "later").
   * outcome: 실제로 한 일을 부른 쪽에 알린다(총괄의 team_model 답).
   */
  private async switchProvider(member: Member, patch: PatchMemberReq, fromPump = false, freshSession = false, usage: UsageStop | null = null, outcome?: ConfigOutcome): Promise<Member> {
    const project = this.store.requireProject(member.projectId);
    this.requireActive(project);
    const rt = this.runtime(member.id);
    if (rt.closing || rt.starting || (!fromPump && rt.pumping) || rt.reopening || rt.turn || this.isBusy(member) || member.status === "working" || (member.status === "blocked" && !usage)) {
      throw new ApiError(409, "일하거나 세션을 처리하는 중입니다. 턴이 끝난 뒤 CLI를 바꾸세요", "cli_switch_busy");
    }
    if (this.store.listDelivering().some((d) => d.memberId === member.id) || this.store.listPending(member.id).some((d) => d.holdReason === "delivery_unknown")) {
      throw new ApiError(409, "전달 여부가 확인되지 않은 입력이 있어 CLI를 바꿀 수 없습니다", "cli_switch_delivery_unknown");
    }
    rt.closing = true;
    let changedSession = false;
    let sessionReady = false;
    let usageReleased = false;
    try {
      const targetRunner = this.runners.get(this.store.effectiveBackend());
      // 같은 CLI 라도 세션 기록이 없으면(한 번도 턴을 돌지 않은 세션) 이어 열 것이 없다. reopenOnce 와 같은 판정이다:
      // 없는 세션을 --resume 하면 CLI 가 곧바로 끝나 offline·오류가 됐다. 저장소를 못 읽은 것은 없다는 증거가 아니다.
      const resumable = !freshSession && patch.cli === member.cli && !!member.sessionId && targetRunner?.sessionExists?.(this.runnerMember(member, project)) !== false;
      // Validate the target invocation before stopping a working installation.
      const target = { ...member, ...patch, cli: patch.cli!, sessionId: resumable ? member.sessionId : null, paneId: null };
      if (targetRunner instanceof CoreRunner) {
        const model = this.desiredConfig(target).model;
        if (target.cli === "codex" && model && /^(?:claude[-:]|opus(?:-|$)|sonnet(?:-|$)|haiku(?:-|$))/i.test(model)) throw new ApiError(400, "Codex용 모델을 고르거나 팀원 모델 지정을 기본값으로 되돌리세요", "cli_switch_model_mismatch");
        try { providerLaunch(this.runnerMember(target, project), this.writeRunFiles(target, project, !!target.sessionId), this.config); }
        catch (e) { throw new ApiError(400, `CLI 설정을 적용할 수 없습니다: ${(e as Error).message}`, "cli_config_failed"); }
      }
      // 사용 한도 메뉴가 떠 있으면 Esc 로만 닫는다. 끝내는 동안(closing) 온 턴 끝 이벤트는 버려지므로, 닫으며 끝난 턴이 한도 보류를 다시 걸지 않는다.
      const menuClosed = usage ? await this.closeUsageMenu(member) : false;
      // Complete the old session before rotating credentials. Failure leaves the original identity intact.
      if ((member.sessionId || member.paneId) && !(freshSession && member.backend !== "core")) {
        try { await this.stopManaged(member, "fresh_session", false); }
        catch (e) {
          if (!(freshSession && member.status === "offline" && e instanceof CoreError && e.kind === "not_found")) {
            if (menuClosed) this.restoreAfterUsageMenu(member);
            throw e;
          }
        }
      }
      changedSession = true;
      const sameProvider = patch.cli === member.cli;
      let continued = false;
      this.store.transaction(() => {
        this.endExecution(member, "interrupted", freshSession ? "명시적 새 세션으로 전환했습니다" : "세션 설정을 변경했습니다");
        this.confirmStop(member.id);
        this.store.archiveAndRotateSession(member.id, patch.cli!, freshSession ? "fresh_session" : sameProvider ? "settings_change" : "provider_switch");
        // 옛 터미널은 끝났다. 새 터미널을 띄우기 전에 보류를 풀고 이어가기 글을 줄에 세운다: 띄우기가 실패해도 다음 기동이 그 글부터 넣는다.
        if (usage) continued = this.resumeAfterUsageStop(member, usage, resumable, sameProvider ? { kind: "model", label: this.modelLabel(target) } : { kind: "cli", label: patch.cli === "codex" ? "Codex" : "Claude" });
      });
      if (usage) { usageReleased = true; if (outcome) { outcome.usage = true; outcome.continued = continued; } }
      if (resumable) this.store.patchMember(member.id, { sessionId: member.sessionId });
      this.store.patchMember(member.id, { ...patch, ...(freshSession ? { origin: "runner" as const } : {}), backend: this.store.effectiveBackend(), status: "idle", lastError: null });
      if (member.kind !== "worker") this.store.setChiefCli(project.id, patch.cli!);
      const handoff = [
        `${this.configChangeLine(member, target, freshSession)}. ${resumable ? "같은 세션을 새 설정으로 이어 열었습니다" : !freshSession && sameProvider ? "이어 열 세션 기록이 없어 새 세션으로 열었습니다" : freshSession ? "이전 세션을 이어 열지 않은 새 세션입니다" : "이전 제공자의 세션을 재개하지 않는 새 세션입니다"}.`,
        `역할: ${member.role}. 현재 상황: ${member.now}. 다음: ${member.next}.`,
        `프로젝트 상황: ${project.now}. board 도구로 대화·결재·작업을 확인하고 계속하세요.`,
      ].join("\n");
      // 사용 한도로 멈춘 팀장의 모델만 바꿔 같은 대화를 이어 열었다: 이어가기 글(하던 일이 없었으면 활동 한 줄)이 모델을 바꿨다고 이미 알린다.
      // 같은 대화라 역할·상황도 그대로다. 인계 글을 다음 턴에 붙이지 않는다(일반 설정 변경과 새 세션·다른 CLI 는 지금처럼 넣는다).
      const handoffNeeded = !(usage && sameProvider && resumable);
      if (handoffNeeded) this.store.enqueue({ projectId: project.id, memberId: member.id, kind: "system", text: formatSystem(handoff), wake: false });
      const fresh = this.store.requireMember(member.id);
      this.openRunner(fresh);
      const started = await this.startManaged(fresh, project, !!fresh.sessionId);
      this.applyStarted(member.id, started, this.desiredConfig(fresh));
      sessionReady = true;
      if (handoffNeeded) this.store.appendActivity(member.id, "system", handoff);
      if (outcome) outcome.opened = resumable ? "resumed" : "fresh";
      return this.store.requireMember(member.id);
    } catch (e) {
      if (changedSession) {
        if (!freshSession && patch.cli === member.cli) {
          this.store.deferMemberConfig(member.id, JSON.stringify(this.desiredConfig(this.store.requireMember(member.id))), true);
          this.store.patchMember(member.id, { status: "offline", lastError: `설정 적용 보류: ${(e as Error).message}` });
        } else this.store.patchMember(member.id, { status: "error", lastError: `새 세션 시작 실패: ${(e as Error).message}` });
      }
      // 사용 한도 보류를 풀고 이어가기 글까지 넣은 뒤에 새 터미널 기동만 실패했다(같은 CLI). 설정은 미뤄 두었고(위) 펌프가 곧 새 설정으로 다시 연다.
      // 실패로 답하면 총괄이 다시 부르다 '이미 그 모델'을 받거나 새 직원을 띄웠다. 지금은 열지 못했고 곧 다시 연다고 답한다.
      if (usageReleased && !freshSession && patch.cli === member.cli && this.store.getMember(member.id)) {
        console.warn(`${member.name}: 사용 한도 보류를 풀고 모델을 바꿨지만 새 터미널을 열지 못했습니다. 곧 다시 엽니다:`, (e as Error).message);
        if (outcome) outcome.opened = "later";
        return this.store.requireMember(member.id);
      }
      throw e;
    } finally {
      rt.closing = false;
      if (sessionReady && !fromPump) void this.pump(member.id);
    }
  }

  /** 보관한 프로젝트는 화면에 없어 멈출 수 없다. 세션을 새로 띄우거나 깨우는 길은 모두 여기서 막는다. */
  private requireActive(project: Project): void {
    if (project.archived || this.archiving.has(project.id)) throw new ApiError(409, "보관된 프로젝트이거나 보관을 처리하는 중입니다. 꺼낸 뒤 다시 하세요", "project_archived");
  }

  /** 전체 설정을 고친다. 실행 방식(backend)은 core 하나라 다른 값은 400 으로 거절한다. */
  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    if (this.settingsWriting) throw new ApiError(409, "설정을 적용하는 중입니다", "settings_busy");
    this.settingsWriting = true;
    try { return await this.updateSettingsOnce(patch); }
    finally { this.settingsWriting = false; this.resumePumps(); }
  }

  private async updateSettingsOnce(patch: SettingsPatch): Promise<Settings> {
    const normalized = this.models.settingsPatch(patch, this.store.getSettings());
    patch = normalized.patch;
    const response = (settings: Settings): Settings => normalized.resetEfforts.length ? { ...settings, resetEfforts: normalized.resetEfforts } : settings;
    if (this.archiving.size) throw new ApiError(409, "프로젝트 보관을 처리하는 중입니다", "archive_busy");
    // 실행기는 core 하나다. 설정의 backend 값은 출시된 앱이 읽는 칸이라 "core" 로 고정해 둔다.
    if (patch.backend && patch.backend !== "core") throw new ApiError(400, "실행기는 herdr-core 하나입니다", "backend_fixed");
    const settings = this.store.patchSettings({ ...patch, backend: "core" });
    await this.refreshConnection();
    // 쉬고 있는 세션은 곧바로 새 설정으로 맞춘다. 응답을 터미널 여는 시간만큼 붙잡지 않는다.
    for (const member of this.store.listAllMembers()) if (this.configPending(member)) void this.pump(member.id);
    return response(settings);
  }

  /** 직원별 모델·effort. null 이면 직급 기본으로 돌아간다. outcome: 실제로 한 일(총괄의 team_model 답에 쓴다). */
  async patchMemberConfig(memberId: string, patch: PatchMemberReq, outcome?: ConfigOutcome): Promise<Member> {
    this.requireActive(this.store.requireProject(this.store.requireMember(memberId).projectId));
    if (this.configWrites.has(memberId)) throw new ApiError(409, "팀원 설정을 적용하는 중입니다", "member_config_busy");
    this.configWrites.add(memberId);
    try { return await this.patchMemberConfigOnce(memberId, patch, outcome); }
    finally { this.releaseConfigWrite(memberId); }
  }

  private releaseConfigWrite(memberId: string): void {
    this.configWrites.delete(memberId);
    if (!this.closed && this.store.getMember(memberId)) void this.pump(memberId);
  }

  private async patchMemberConfigOnce(memberId: string, patch: PatchMemberReq, outcome?: ConfigOutcome): Promise<Member> {
    const member = this.store.requireMember(memberId);
    this.requireActive(this.store.requireProject(member.projectId));
    if (this.runtime(memberId).closing || this.runtime(memberId).starting || this.runtime(memberId).reopening || this.pendingLifecycle(memberId)) throw new ApiError(409, "세션을 처리하는 중입니다", "session_busy");
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 설정을 바꿀 수 없습니다", "manual_session_unsupported");
    const normalized = this.models.memberPatch(member, patch, this.store.getSettings());
    patch = normalized.patch;
    if (patch.cli && patch.cli !== member.cli) {
      // 사용 한도로 멈춘 팀장의 CLI 를 바꾼다: 새 CLI 는 그 한도에 묶이지 않는다. 옛 CLI 의 한도 보류를 풀고 카드에서 뺀다(새 세션이라 이어가기 글 대신 중단 알림).
      // 예전에는 보류를 그대로 두어, 새 Codex 세션에 대표의 말이 '사용 한도 해제를 기다립니다'로 붙잡혔다.
      const updated = await this.switchProvider(member, patch, false, false, this.usageStop(member), outcome);
      if (normalized.resetOverrides.length) {
        this.store.appendActivity(memberId, "system", `CLI 변경으로 지원하지 않는 ${normalized.resetOverrides.join(", ")} 지정을 비우고 직급 기본값으로 되돌렸습니다`);
        return { ...updated, resetOverrides: normalized.resetOverrides };
      }
      return updated;
    }
    if (member.backend === "core" && (member.sessionId || member.paneId) &&
        ((patch.modelOverride !== undefined && patch.modelOverride !== member.modelOverride) || (patch.effortOverride !== undefined && patch.effortOverride !== member.effortOverride))) {
      // 사용 한도로 멈춘 팀장이면 모델을 바꿔 같은 세션을 이어 연다. 한도 보류·한도 메뉴의 막힘 때문에 미루지 않는다.
      const usage = member.sessionId ? this.usageStop(member) : null;
      if (!member.sessionId || ["asleep", "offline"].includes(member.status)) {
        const saved = this.store.patchMember(memberId, patch);
        if (outcome) outcome.opened = "later";
        if (!member.sessionId && member.paneId && !["asleep", "offline"].includes(member.status)) {
          this.runtime(memberId).configGaveUp = JSON.stringify(this.desiredConfig(saved));
          this.store.deferMemberConfig(memberId, JSON.stringify(this.desiredConfig(saved)));
          this.store.appendActivity(memberId, "system", "설정 적용 보류: 같은 대화의 세션 ID를 확인하지 못했습니다. 다음 자연 기동 때 적용합니다");
        }
        if (!usage) return saved;
        // 터미널 없이(잠듦·꺼짐) 보류된 팀장: 보류를 풀고, 하던 일이 있었으면 이어가기 글을 넣는다. 그 글이 다음 펌프에서 새 모델로 같은 세션을 연다.
        const project = this.store.requireProject(saved.projectId);
        const resumable = this.runners.get(this.store.effectiveBackend())?.sessionExists?.(this.runnerMember(saved, project)) !== false;
        const continued = this.store.transaction(() => this.resumeAfterUsageStop(saved, usage, resumable, { kind: "model", label: this.modelLabel(saved) }));
        if (outcome) { outcome.usage = true; outcome.continued = continued; }
        return this.store.requireMember(memberId);
      }
      return this.switchProvider(member, { ...patch, cli: member.cli }, false, false, usage, outcome);
    }
    if (outcome) outcome.opened = "later";
    return this.store.patchMember(memberId, patch);
  }

  /**
   * 총괄의 team_model: 있는 팀장의 모델(과 effort)을 바꾼다. 앱의 팀장 설정 변경(patchMemberConfig)과 같은 길이다.
   * 살아 있는 세션은 같은 세션을 새 모델로 이어 연다. 사용 한도로 멈춘 팀장은 그 보류를 풀고 멈춘 일을 이어서 하게 한다.
   */
  async changeMemberModel(memberId: string, patch: Pick<PatchMemberReq, "modelOverride" | "effortOverride">): Promise<{ member: Member; model: string; opened: "resumed" | "fresh" | "later"; usage: boolean; continued: boolean }> {
    const before = this.store.requireMember(memberId);
    const limited = this.apiRecovery.usageLimited(before.id);
    const same = (patch.modelOverride === undefined || patch.modelOverride === before.modelOverride) && (patch.effortOverride === undefined || patch.effortOverride === before.effortOverride);
    if (same) throw new ApiError(400, `${josa(before.name, "은")} 이미 그 모델·effort 입니다${limited ? ". 사용 한도로 멈춘 직원은 다른 모델로 바꿔야 이어 갑니다" : ""}`, "model_unchanged");
    // 세션 ID 를 모르면 같은 대화를 이어 열 수 없어 보류도 풀지 않는다(설정만 미뤄진다). '다음에 열 때 새 모델로'라고 답하면 총괄은 바뀐 줄 알고 기다리는데
    // 그 팀장은 한도가 풀릴 때까지 멈춰 있다. 아무것도 바꾸지 않고 그대로 알린다.
    if (limited && !before.sessionId) throw new ApiError(409, `${before.name}의 세션 ID를 확인하지 못해 한도 보류를 풀 수 없습니다. 한도가 풀리면 서버가 이어 갑니다`, "usage_resume_session_unknown");
    const outcome: ConfigOutcome = { usage: false, continued: false, opened: null };
    const member = await this.patchMemberConfig(memberId, patch, outcome);
    // 답은 서버가 실제로 한 일로만 정한다(잠듦·꺼짐이거나 다시 여는 데 실패했으면 later, 이어가기 글을 넣었을 때만 continued).
    const opened = outcome.opened ?? (["asleep", "offline"].includes(member.status) || !member.paneId ? "later" : member.sessionId === before.sessionId ? "resumed" : "fresh");
    return { member, model: this.modelLabel(member), opened, usage: outcome.usage, continued: outcome.continued };
  }

  /**
   * 사용 한도로 보류 중인 팀장이면, 멈출 때 하던 실행: 이 세대에서 입력이 들어간 마지막 실행이 한도 오류로 끝났고 아직 이어가기·중단 알림을 만들지 않은 것.
   * 쉬던 중 한도에 걸렸으면(마지막 실행이 성공했거나, 한도 메뉴 때문에 넣지 못한 입력뿐이면) runId 는 null 이다. 보류 중이 아니면 null.
   */
  private usageStop(member: Member): UsageStop | null {
    if (!this.apiRecovery.usageLimited(member.id)) return null;
    const run = this.store.lastWrittenExecution(member.id, this.store.memberRevisions(member.id).sessionGeneration);
    const stopped = !!run && run.phase === "ended" && run.result === "error" && classifyTurnError(run.reason ?? "") === "usage_limit" && !run.interruptionNotifiedAt;
    return { runId: stopped ? run!.runId : null };
  }

  /**
   * 사용 한도 메뉴가 떠 있으면 Esc 로만 닫는다(ApiRecovery.closeMenu). 못 닫으면 409: 세션을 끝내거나 다시 열지 않고 그대로 둔다.
   * 메뉴가 떠 있었고 닫았으면 true(뒤에 끝내기가 실패하면 restoreAfterUsageMenu 로 상태를 다시 적는다).
   * 거절 글에 '사용 한도'를 쓰지 않는다: 앱은 그 낱말이 든 오류를 모두 '…다른 모델로 바꾸면 바로 이어 갑니다'로 바꿔 보여 줘 실제 까닭이 가려졌다.
   */
  private async closeUsageMenu(member: Member): Promise<boolean> {
    let result: { ok: boolean; note?: string; closed?: boolean };
    try { result = await this.apiRecovery.closeMenu(member); }
    catch (e) {
      // 이 서버가 지켜보지 않는 터미널이다(끝났거나 없다). 닫을 메뉴도 없다. 끝내기 쪽이 그대로 판정한다.
      if (e instanceof CoreError && e.kind === "not_found" && !e.uncertain) return false;
      throw new ApiError(409, `한도 창을 확인하지 못했습니다: ${(e as Error).message}. 잠시 뒤 다시 해 주세요`, "usage_menu_unreadable");
    }
    if (!result.ok) throw new ApiError(409, `한도 창을 Esc로 닫지 못했습니다(${result.note ?? "창을 닫지 못했습니다"}). 터미널을 확인한 뒤 다시 해 주세요`, "usage_menu_close_failed");
    return !!result.closed;
  }

  /**
   * 한도 메뉴를 Esc 로 닫은 뒤 끝내기가 실패했다(입력칸 거절·조작권·kill 시간 초과). 닫는 동안(closing) 온 상태 이벤트는 버려졌고 core 는 상태가 바뀔 때만
   * 다시 알리므로, 명부가 blocked 로 굳어 팀 설정의 '적용'이 막혔다. 지금 관측으로 상태를 고쳐 적는다. 한도 보류·표시(막힘 사유·오류 글)는 그대로다:
   * 메뉴 없이 한도 오류로 멈춘 팀장과 같은 모양(error)이 된다.
   */
  private restoreAfterUsageMenu(member: Member): void {
    const current = this.store.getMember(member.id);
    if (!current || current.status !== "blocked") return;
    const runner = this.runnerOf(current);
    const state = runner instanceof CoreRunner ? runner.observationState(member.id)?.state ?? null : null;
    if (state === "working") this.store.patchMember(member.id, { status: "working" });
    else if (["error", "idle", "done"].includes(state ?? "")) this.store.patchMember(member.id, { status: this.apiRecovery.usageLimited(member.id) ? "error" : "idle" });
  }

  /** 설정 변경 인계 글의 첫머리. 같은 CLI 면 'claude → claude' 가 아니라 실제로 바뀐 것(모델·effort)을 적는다. */
  private configChangeLine(before: Member, after: Member, freshSession: boolean): string {
    if (before.cli !== after.cli) return `CLI 설정 변경: ${before.cli} → ${after.cli}`;
    const was = this.desiredConfig(before), now = this.desiredConfig(after);
    const changes = [
      was.model !== now.model ? `모델 변경: ${this.modelLabel(before)} → ${this.modelLabel(after)}` : null,
      was.effort !== now.effort ? `effort 변경: ${was.effort ?? "기본"} → ${now.effort ?? "기본"}` : null,
    ].filter(Boolean);
    return changes.length ? changes.join(" · ") : freshSession ? "새 세션 시작" : "설정 변경";
  }

  /**
   * 사용 한도로 멈춘 팀장을 새 모델(또는 새 CLI)로 다시 열 때(설정 변경). 그 팀장의 한도 보류만 풀고(같은 계정의 다른 팀장은 그대로), 멈출 때 하던 일이 있었으면
   * 이어가기 글을 넣는다. 재시작 이어가기와 같은 장치다: execution journal 의 중단 통지 칸으로 실행마다 한 번(서버를 다시 띄워도),
   * 기다리던 다른 전달보다 먼저 혼자 나가고, 원래 지시는 다시 넣지 않는다. 총괄에게는 깨우지 않는 소식만 간다.
   * 같은 대화를 이어 열지 못하면(세션 기록 없음, 다른 CLI) 이어가기 글 대신 예전처럼 총괄을 깨워 중단을 알린다.
   * 이어가기 글을 넣었으면 true(총괄의 team_model 답이 이것으로 '이어서 한다'를 말한다).
   */
  private resumeAfterUsageStop(member: Member, stop: UsageStop, continued: boolean, change: { kind: "model" | "cli"; label: string }): boolean {
    const model = change.label;
    const what = `${change.kind === "model" ? "모델을" : "CLI를"} ${withRo(model)}`;
    this.apiRecovery.releaseMember(member.id);
    this.store.appendActivity(member.id, "system", `사용 한도로 멈춘 세션의 ${what} 바꿔 ${continued ? "같은 대화를 이어 엽니다" : "새 세션으로 엽니다"}`);
    const run = stop.runId ? this.store.getExecutionJournal(stop.runId) : null;
    if (!run || run.memberId !== member.id) return false;
    let wakeConductor: string | null = null;
    let resumed = false;
    this.store.claimExecutionNotice(run.runId, "interruption", () => {
      const conductor = this.store.getConductor(member.projectId);
      const lead = conductor && conductor.id !== member.id ? conductor : null;
      if (!continued || change.kind !== "model") {
        this.noticeInterrupted(member, run, change.kind === "model" ? `사용 한도로 멈췄습니다. ${what} 바꿨지만 이어 열 세션 기록이 없어 새 세션으로 엽니다`
          : `사용 한도로 멈췄습니다. ${what} 바꿔 새 세션으로 엽니다(이전 CLI의 대화는 이어지지 않습니다)`);
        wakeConductor = lead?.id ?? null;
        return;
      }
      resumed = true;
      this.apiRecovery.continueAfter(member, usageModelResumeText(model));
      this.systemMessage(member.projectId, `${member.name}: 실행 ${run.runId} — 사용 한도로 멈춰 모델을 ${withRo(model)} 바꿔 이어서 하게 했습니다`);
      // 총괄이 같은 일을 또 맡기거나 새 직원에게 넘겨 두 번 하게 되지 않도록, 깨우지 않는 소식으로만 알린다.
      if (lead) this.store.enqueue({ projectId: member.projectId, memberId: lead.id, kind: "system", wake: false,
        text: formatSystem(`${member.name}의 일(실행 ${run.runId})이 사용 한도로 멈춰, 모델을 ${withRo(model)} 바꿔 같은 대화를 이어 열고 멈춘 곳부터 이어서 하게 했습니다. 같은 일을 다시 지시하거나 다른 직원을 새로 띄워 넘기지 마세요. 결과는 ${member.name}의 보고로 옵니다. 전달 ${run.deliveryIds.join(", ")}.`) });
    });
    this.store.afterCommit(() => { if (wakeConductor && !this.closed && !this.recovering) void this.pump(wakeConductor); });
    return resumed;
  }

  /** 화면·글에 쓰는 모델 이름: 모델 목록의 표시 이름, 목록에 없으면 값 그대로, 정하지 않았으면 'CLI 기본 모델'. */
  private modelLabel(member: Member): string {
    const model = this.desiredConfig(member).model;
    if (!model) return "CLI 기본 모델";
    return this.models.read()[member.cli].models.find(option => option.value === model)?.label ?? model;
  }

  /**
   * 사용 한도 카드의 모델 선택지(`model:<값>`, 글 '<표시 이름>로 바꿔 이어가기'): 그 CLI 의 모델 목록(/api/models 와 같은 목록)에서
   * 카드 전체에서 한도에 걸린 모델을 뺀 것. 한도에 걸린 모델은 카드의 팀장들이 지금 쓰는 모델(설정), 한도 글에 이름이 나온 모델
   * (예: 'keep using Fable 5.2' 의 Fable 5.2), 그리고 이 카드에서 앞서 걸린 모델(blocked: 그 팀장이 모델을 바꿔 빠졌어도 그 한도는 그대로다)이다.
   * 팀장마다 모델이 달라도 교집합이 아니라 카드 전체에서 걸린 모델들을 뺀다.
   * 모델에 한정된 한도(모델 크레딧 소진, 목록의 모델 이름이 붙은 한도)가 하나도 없으면 [] 다: 계정 전체의 한도는 모델을 바꿔도 곧바로 다시 걸린다.
   */
  private usageModelChoices(cli: CliProvider, limited: { memberId: string; raw: string }[], blocked: string[] = []): DecisionOption[] {
    const catalog = this.models.read()[cli].models;
    const scoped = limited.some(entry => modelCreditLimit(entry.raw) !== null || this.catalogValuesNamed(cli, limitedModelName(entry.raw)).length > 0);
    if (!scoped) return [];
    const excluded = new Set(blocked.map(model => model.toLowerCase()));
    for (const entry of limited) {
      const member = this.store.getMember(entry.memberId);
      for (const model of member ? this.usageBlockedModels(member, entry.raw) : this.catalogValuesNamed(cli, limitedModelName(entry.raw))) excluded.add(model);
    }
    return catalog.filter(option => !excluded.has(option.value.toLowerCase())).map(option => ({ k: `${USAGE_MODEL_PREFIX}${option.value}`, label: `${withRo(option.label)} 바꿔 이어가기` }));
  }

  /** 이 팀장이 이 글로 한도에 걸렸을 때 막힌 모델 값(소문자): 쓰던 모델(설정)과 글에 이름이 나온 모델. 카드가 blockedModels 로 기억한다. */
  private usageBlockedModels(member: Member, raw: string): string[] {
    const model = this.desiredConfig(member).model;
    return [...new Set([...(model ? [model.toLowerCase()] : []), ...this.catalogValuesNamed(member.cli, limitedModelName(raw))])];
  }

  /**
   * 한도 글에 나온 모델 이름에 맞는 그 CLI 모델 목록의 값들(소문자). 'Fable 5.2'(크레딧 글)는 그 모델, 'Fable'·'Opus'(메뉴 제목의 모델 한도)는
   * 그 계열 전부(표시 이름이 'Fable 5.2' 거나 값이 claude-fable-5-2 인 것)다.
   */
  private catalogValuesNamed(cli: CliProvider, name: string | null): string[] {
    const named = name?.trim().toLowerCase();
    if (!named) return [];
    return this.models.read()[cli].models.filter(option => {
      const label = option.label.toLowerCase(), value = option.value.toLowerCase();
      return named === label || named === value || named.startsWith(`${label} `) || label.startsWith(`${named} `) || value.split(/[-:/ ]/).includes(named);
    }).map(option => option.value.toLowerCase());
  }

  /**
   * 사용 한도 카드에서 다른 모델을 골랐다: 카드에 남은(아직 기다리는) 팀장마다 모델을 그 값으로 바꾼다. 대표가 팀장 설정에서 바꾼 것과 같은 길이라
   * (patchMemberConfig) 같은 세션을 새 모델로 이어 열고, 일하던 중이었으면 이어가기 글이 한 번 들어가며, 그 팀장은 카드에서 빠진다.
   * 새 모델이 그 팀장의 effort 를 받지 않으면 effort 지정은 직급 기본으로 되돌린다. 바꾸지 못한 팀장은 까닭과 함께 카드에 남는다.
   */
  private async switchUsageCard(card: Decision, choice: string, model: string): Promise<Decision> {
    const ids = (card.usageLimit?.memberIds ?? []).filter(id => this.apiRecovery.usageLimited(id));
    // 카드의 팀장이 모두 이어가기 결과를 기다리는 중이다(보류가 아니다). 아무것도 하지 않고 200 을 주면 앱은 바꾼 줄 안다.
    if (!ids.length) throw new ApiError(409, "카드의 팀장이 모두 이어가기 결과를 기다리는 중입니다. 잠시 뒤 카드를 다시 확인해 주세요", "usage_notice_pending");
    const failures: string[] = [];
    let noted = false;
    for (const id of ids) {
      const member = this.store.getMember(id);
      if (!member) continue;
      const effort = member.effortOverride && !this.models.efforts(member.cli, model).includes(member.effortOverride) ? { effortOverride: null } : {};
      try {
        await this.patchMemberConfig(id, { modelOverride: model, ...effort });
        // 한 명이라도 바꾼 뒤에 적어 둔다: 같은 답이 다시 오면(응답을 잃은 앱의 재시도) 닫힌 카드를 그대로 돌려준다. 아무도 못 바꿨으면 적지 않는다.
        if (!noted) { this.apiRecovery.noteAnswer(card.id, choice); noted = true; }
      } catch (e) {
        const why = (e as Error).message;
        failures.push(`${member.name}: ${why}`);
        if (this.store.getMember(id) && this.apiRecovery.usageLimited(id)) this.apiRecovery.noteFailure(id, `모델을 바꾸지 못했습니다(${why})`);
      }
    }
    if (failures.length === ids.length) throw new ApiError(409, `모델을 바꾸지 못했습니다. ${failures.join(" / ")}`, "model_switch_failed");
    return this.store.requireDecision(card.id);
  }

  /** 보관하면 화면에서 사라진다. 답을 기다리는 세션이나 일하는 세션을 두고 사라지면 아무도 풀어 줄 수 없다. */
  private checkArchivable(project: Project): void {
    const members = this.store.listMembers(project.id);
    if (this.settingsWriting) throw new ApiError(409, "실행 설정을 처리하는 중입니다", "runner_settings_busy");
    for (const member of members) {
      const rt = this.runtime(member.id);
      if (rt.starting || rt.reopening || rt.pumping || rt.closing || this.configWrites.has(member.id) || this.terminalMutations.has(member.id)) throw new ApiError(409, `${member.name}의 세션을 처리하는 중입니다`, "session_busy");
    }
    const busy = members.find((m) => m.status === "working" || m.status === "blocked" || (m.origin !== "manual" && this.isBusy(m)));
    if (busy) throw new ApiError(409, `${josa(busy.name, "이")} 일하는 중이라 보관할 수 없습니다`, "archive_member_working");
    const open = this.store.listDecisions(project.id).filter((d) => d.status === "open").length;
    if (open > 0) throw new ApiError(409, `열린 결재 ${open}건에 답한 뒤 보관하세요`, "archive_open_decisions");
    const todos = this.store.listTodos(project.id).filter((t) => !t.done).length;
    if (todos > 0) throw new ApiError(409, `안 한 할 일 ${todos}건을 처리한 뒤 보관하세요`, "archive_open_todos");
  }

  async onProjectPatched(project: Project, patch: PatchProjectReq): Promise<void> {
    try {
      if (patch.archived === true) {
        // 사전 hook에서 전원 종료했다. commit 뒤 새 입력은 없다.
        for (const d of this.store.listUndelivered(project.id)) if (d.status === "queued" && d.attempts === 0) this.hold(d, "archived");
      }
      if (patch.runnerEnabled === true) {
        this.store.setRunnerByAdopt(project.id, false);
        if (patch.archived !== false) await this.enableProject(project.id);
      }
    } finally { this.archiving.delete(project.id); }
    // E3: 보관하거나 실행을 끄면 기다리던 전달의 까닭이 바뀐다. 펌프가 다시 판정해 남기게 한다(펌프는 그 상태에서 보내지 않는다).
    if (patch.archived === true || patch.runnerEnabled === false) for (const id of new Set(this.store.listUndelivered(project.id).map(d => d.memberId))) void this.pump(id);
    if (patch.archived === false) {
      const stopped = this.store.listUndelivered(project.id).filter(d => d.status === "held" && d.holdReason === "archived");
      for (const id of new Set(stopped.map(d => d.memberId))) void this.pump(id);
    }
  }

  async startConductor(projectId: string): Promise<Member> {
    const project = this.store.requireProject(projectId);
    this.requireActive(project);
    // 먼저 본다. 실행기가 없는데 켜 두면 연결된 것처럼 보인다.
    const backend = this.store.effectiveBackend();
    const runner = this.runners.get(backend);
    if (!runner) throw new ApiError(503, `실행기가 없습니다: ${backend}`, "backend_missing");
    const available = await runner.available();
    if (!available.ok) throw new ApiError(503, available.detail ?? "실행기를 쓸 수 없습니다", "backend_unavailable");
    this.requireActive(this.store.requireProject(projectId));
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
        text: formatUserMessage(message.body, this.attachmentsFor(conductor, message.attachments), message.id, false) + this.messageContext(message),
        refType: "message",
        refId: message.id,
      });
    }
    for (const d of answers) this.store.enqueue({ projectId, memberId: conductor.id, kind: "answer", text: formatAnswer(d), refType: "decision", refId: d.id });
    for (const t of todos) {
      this.store.enqueue({ projectId, memberId: conductor.id, kind: "todo_done", text: this.todoDoneText(t, conductor), refType: "todo", refId: t.id });
      this.store.setTodoNoticePending(t.id, false);
    }
  }

  /** 실행이 켜진 프로젝트에서 총괄을 못 띄워 멈춘 말이 있으면 다시 시도한다. 실행기가 돌아오면 저절로 풀린다. */
  private repairSourceIntents(projectId: string): void {
    this.store.transaction(() => {
      for (const message of this.store.listMessagesMissingDeliveries(projectId)) {
        const member = message.targetMemberId ? this.store.getMember(message.targetMemberId) : null;
        if (member) this.store.enqueue({ projectId, memberId: member.id, kind: "user_message", text: formatUserMessage(message.body, this.attachmentsFor(member, message.attachments), message.id, true) + this.messageContext(message), refType: "message", refId: message.id });
      }
      for (const decision of this.store.listAnswersMissingDeliveries(projectId)) {
        const member = decision.memberId ? this.store.getMember(decision.memberId) : null;
        if (member && member.origin !== "manual") this.store.enqueue({ projectId, memberId: member.id, kind: "answer", text: formatAnswer(decision), refType: "decision", refId: decision.id });
      }
      const lead = this.store.getConductor(projectId);
      if (lead) for (const message of this.store.listReportsMissingDeliveries(projectId)) {
        const author = message.memberId ? this.store.getMember(message.memberId) : null;
        if (author?.kind === "worker" && author.id !== lead.id) this.store.enqueue({ projectId, memberId: lead.id, kind: "report", text: this.reportText(message), wake: WAKE_POST_KINDS.has(message.kind), refType: "message", refId: message.id });
      }
    });
  }

  private async retryOrphans(): Promise<void> {
    if (this.closed) return;
    for (const project of this.store.listProjects()) {
      if (!project.runnerEnabled) continue;
      this.repairSourceIntents(project.id);
      if (this.store.getConductor(project.id)) {
        await this.adoptOrphans(project.id);
        for (const id of new Set(this.store.listUndelivered(project.id).map(d => d.memberId))) void this.pump(id);
        continue;
      }
      // 편입은 세션 하나를 넘겨준 것이다. 대표가 시키지 않은 총괄을 띄워 옛 지시를 실행하지 않는다.
      if (this.store.runnerByAdopt(project.id)) continue;
      if (this.orphanMessages(project.id).length + this.orphanAnswers(project.id).length + this.orphanTodos(project.id).length === 0) continue;
      await this.enableProject(project.id).catch((e) => console.warn(`${project.name} 총괄 띄우기 재시도 실패:`, (e as Error).message));
    }
  }

  /** 전달 항목이 없는 대표 메시지: 총괄이 없을 때 보류됐거나, 총괄을 띄우다 실패해 항목째 사라졌다. */
  private orphanMessages(projectId: string): Message[] {
    return this.store.listMessagesMissingDeliveries(projectId).filter(m => !m.targetMemberId);
  }

  /** 답했는데 물은 직원이 없어(가져온 카드, 닫힌 직원) 아무에게도 가지 않은 결재. */
  private orphanAnswers(projectId: string): Decision[] {
    return this.store.listAnswersMissingDeliveries(projectId).filter(d => !d.memberId || !this.store.getMember(d.memberId));
  }

  private orphanTodos(projectId: string): Todo[] {
    return this.store.listTodoNoticesPending(projectId);
  }

  /** Legacy retry requests schedule evidence collection and never bypass a fence. */
  async resendMessage(existing: Message): Promise<Message> {
    const current = this.store.requireMessage(existing.id);
    if (current.delivery !== "failed") return current;
    const target = current.targetMemberId ? this.store.getMember(current.targetMemberId) : null;
    if (current.targetMemberId && !target) throw new ApiError(409, "그 팀원이 닫혀 다시 보낼 수 없습니다. 새 글로 보내세요", "resend_member_closed");
    await this.refreshHealth();
    this.store.requireReachable(current.projectId, target);
    let deliveries = this.store.listDeliveries(current.projectId).filter(d => d.refType === "message" && d.refId === current.id);
    if (!deliveries.length) deliveries = [this.deliveryRecovery.materializeLegacyMessage(current.id)];
    for (const d of deliveries) {
      if (d.status !== "delivered") this.deliveryRecovery.beginRecovery(d.id);
    }
    await this.deliveryRecovery.tick();
    return this.store.requireMessage(current.id);
  }

  private messageContext(message: Message): string {
    if (!message.contextFileId) return "";
    const file = this.store.getFile(message.contextFileId);
    return file && file.projectId === message.projectId ? `\n[시스템 자료 맥락 · 대표 원문 아님]\n대표가 보던 자료: ${file.title.replace(/[\r\n]+/g, " ")} (${file.id})` : "";
  }

  async sendUserMessage(projectId: string, req: SendMessageReq): Promise<Message> {
    const project = this.store.requireProject(projectId);
    this.requireActive(project);
    if (req.contextFileId && this.store.getFile(req.contextFileId)?.projectId !== projectId) throw new ApiError(400, "이 프로젝트의 자료가 아닙니다", "file_other_project");
    const attachments = (req.attachmentIds ?? []).map(id => this.store.getAttachment(id)).filter((a): a is Attachment => a !== null);
    const target = req.targetMemberId ? this.store.requireMember(req.targetMemberId) : null;
    if (target && target.projectId !== projectId) throw new ApiError(400, "이 프로젝트의 팀원이 아닙니다", "member_not_in_project");
    let recipient = target ?? this.store.getConductor(projectId);
    let booting: Promise<void> | null = null;
    const { value: message, deliveries } = this.store.withDeliveryIntents(() => {
      const message = this.store.createMessage({ id: req.id, projectId, mine: true, who: "나", kind: "나", body: req.text,
        targetMemberId: target?.id ?? null, targetName: target?.name ?? null, attachments, contextFileId: req.contextFileId, delivery: "queued" });
      if (!recipient && project.runnerEnabled) {
        const spawn = this.beginConductor(project, true);
        recipient = spawn.member;
        booting = spawn.ready;
      }
      if (!recipient) return this.store.setMessageDelivery(message.id, "held", HOLD_NOTES.runner_disabled);
      return message;
    }, message => {
      if (!recipient) return [];
      const intents: NewDelivery[] = [{ projectId, memberId: recipient.id, kind: "user_message",
        text: formatUserMessage(message.body, this.attachmentsFor(recipient, attachments), message.id, !!target) + this.messageContext(message), refType: "message", refId: message.id }];
      const conductor = this.store.getConductor(projectId);
      if (target && conductor && conductor.id !== target.id) intents.push({ projectId, memberId: conductor.id, kind: "system",
        text: formatSystem(`대표가 ${target.name}에게 직접 지시했습니다 #${message.id}. 이미 ${target.name}에게 전달했습니다. 같은 일을 다시 시키지 말고, 결과 보고를 기다려 판만 맞추세요.`) + this.messageContext(message), wake: false });
      return intents;
    });
    if (booting) void (booting as Promise<void>).catch(e => console.warn(`${project.name} 총괄을 띄우지 못했습니다:`, (e as Error).message));
    for (const id of new Set(deliveries.map(d => d.memberId))) void this.pump(id);
    return this.store.requireMessage(message.id);
  }

  /** 첨부를 그 직원의 폴더로 잇는다. CLI 는 이 폴더만 승인 없이 읽고, 다른 프로젝트의 첨부는 열지 않는다. */
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

  /** K(E2): 팀장의 CLI 가 도구 승인 창 앞에서 올린 요청(/agent/permission). 결재 카드를 띄우고 한 번 기다린다. */
  async requestToolPermission(member: Member, input: ToolPermissionRequest, signal?: AbortSignal): Promise<ToolPermissionPoll> {
    return this.toolPermissions.request(member, input, signal);
  }
  /** K(E2): 같은 카드를 다시 기다린다(/agent/permission/wait). */
  async waitToolPermission(member: Member, id: string, signal?: AbortSignal): Promise<ToolPermissionPoll> {
    return this.toolPermissions.wait(member, id, signal);
  }

  async answerDecision(decisionId: string, req: AnswerReq): Promise<Decision> {
    // K(E2): 도구 승인 카드의 답은 기다리는 훅에 바로 돌려준다. 팀장에게 결재 답 글로 보내지 않는다.
    if (this.store.requireDecision(decisionId).kind === "tool_permission") return this.toolPermissions.answer(decisionId, req);
    if (this.store.requireDecision(decisionId).kind === "usage_limit") {
      const card = this.store.requireDecision(decisionId);
      this.requireActive(this.store.requireProject(card.projectId));
      const choice = req.choice ?? "";
      if (choice !== "resume" && !choice.startsWith(USAGE_MODEL_PREFIX)) throw new ApiError(400, "이어가기나 다른 모델만 선택할 수 있습니다", "usage_choice_invalid");
      // 이 카드에 답한 것이 아직 도는 중이다(모델을 바꾸는 데는 팀장마다 Esc·끝내기·다시 열기가 차례로 걸린다). 같은 답은 그 결과를 함께 받고,
      // 다른 답(다른 기기, 다시 누른 다른 버튼)은 앞 답의 결과를 성공으로 받아 가지 않게 409 로 돌려보낸다. 두 전환이 같은 팀장들을 함께 바꾸지도 않는다.
      const running = this.usageAnswers.get(decisionId);
      if (running) {
        if (running.choice === choice) return running.task;
        throw new ApiError(409, "다른 선택을 처리하는 중입니다. 잠시 뒤 카드를 다시 확인해 주세요", "usage_choice_busy");
      }
      const model = choice.startsWith(USAGE_MODEL_PREFIX) ? choice.slice(USAGE_MODEL_PREFIX.length) : null;
      // 그 CLI 의 모델 목록에 없는 값(다른 CLI 의 모델 포함)은 거절한다.
      if (model !== null && !this.models.read()[card.usageLimit?.cli ?? "claude"].models.some(option => option.value === model)) throw new ApiError(400, "이 CLI의 모델 목록에 없는 모델입니다", "model_unknown");
      // 같은 모델 답이 다시 왔다(응답을 잃은 앱의 재시도 등). 이미 바꿔 카드가 닫혔으면 한 번만 한 것으로 답한다.
      if (model !== null && card.status !== "open" && this.apiRecovery.answeredWith(decisionId) === choice) return card;
      if (card.status !== "open" || req.expectedVersion && req.expectedVersion !== card.updatedAt) throw new ApiError(409, "알림 상태가 바뀌었습니다. 다시 확인해 주세요", "usage_notice_changed");
      // 카드의 판은 푸시 알림에 묶여 팀장이 붙거나 빠져도 오르지 않는다. 앱이 본 팀장을 함께 보냈으면 그것으로 확인한다:
      // 대표가 A 만 보이는 카드에서 고른 모델로 그 사이 붙은 B 까지 바꾸지 않는다.
      if (model !== null && req.memberIds && !sameMembers(req.memberIds, card.usageLimit?.memberIds ?? [])) throw new ApiError(409, "카드의 팀장이 바뀌었습니다. 카드를 다시 확인해 주세요", "usage_notice_member_changed");
      if (model !== null && !card.options.some(option => option.k === choice)) throw new ApiError(400, "한도에 걸린 모델이거나 선택지에 없는 모델입니다. 카드를 다시 확인해 주세요", "usage_model_unavailable");
      const task = model === null ? this.apiRecovery.resumeUsage(decisionId) : this.switchUsageCard(card, choice, model);
      this.usageAnswers.set(decisionId, { choice, task });
      const done = () => { if (this.usageAnswers.get(decisionId)?.task === task) this.usageAnswers.delete(decisionId); };
      void task.then(done, done);
      return task;
    }
    let booting: Promise<void> | null = null;
    const { value: { decision, changed }, deliveries } = this.store.withDeliveryIntents(() => this.store.answerDecision(decisionId, req), ({ decision, changed }) => {
      if (!changed) return [];
      const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
      let conductor = this.store.getConductor(decision.projectId);
      const project = this.store.requireProject(decision.projectId);
      if (!asker && !conductor && project.runnerEnabled && !this.store.runnerByAdopt(project.id)) {
        const spawn = this.beginConductor(project, true);
        conductor = spawn.member;
        booting = spawn.ready;
      }
      const recipient = asker ?? conductor;
      const intents: NewDelivery[] = [];
      if (recipient && asker?.origin !== "manual") intents.push({ projectId: project.id, memberId: recipient.id, kind: "answer", text: formatAnswer(decision), refType: "decision", refId: decision.id });
      if (conductor && recipient && conductor.id !== recipient.id) intents.push({ projectId: project.id, memberId: conductor.id, kind: "system",
        text: formatSystem(`대표가 ${decision.who}의 결재에 답했습니다. 이미 ${decision.who}에게 전달했습니다. 같은 일을 다시 시키지 말고, 결과 보고를 기다려 판만 맞추세요.\n${formatAnswer(decision)}`), wake: false });
      return intents;
    });
    if (!changed) return decision;
    if (booting) void (booting as Promise<void>).catch(e => console.warn("결재 답을 받을 총괄을 띄우지 못했습니다:", (e as Error).message));
    this.wakeAll(this.askWaiters, decisionId);
    if (decision.memberId) this.wakeAll(this.inboxWaiters, decision.memberId);
    for (const id of new Set(deliveries.map(d => d.memberId))) void this.pump(id);
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    if (asker && asker.origin !== "manual") this.refreshWaiting(asker.id);
    return this.store.requireDecision(decisionId);
  }

  private todoDoneText(todo: Todo, member: Member): string {
    const attachments = (todo.completionFileIds ?? []).map(id => this.store.getAttachment(id)).filter((a): a is Attachment => a !== null);
    return [formatTodoDone(todo), ...attachmentLines(this.attachmentsFor(member, attachments))].join("\n");
  }

  async dropTodo(todoId: string, reason?: string): Promise<Todo> {
    return this.writeTodo(todoId, true, {}, reason?.trim() || "대표가 필요 없음으로 정리");
  }

  async setTodoDone(todoId: string, done: boolean, completion: { note?: string; fileIds?: string[] } = {}): Promise<Todo> {
    return this.writeTodo(todoId, done, completion);
  }

  private async writeTodo(todoId: string, done: boolean, completion: { note?: string; fileIds?: string[] }, dropReason?: string): Promise<Todo> {
    for (const id of completion.fileIds ?? []) if (!this.store.getAttachment(id)) throw new ApiError(400, "업로드된 첨부를 찾을 수 없습니다", "upload_not_found");
    if (!done && (completion.note !== undefined || completion.fileIds?.length)) throw new ApiError(400, "완료할 때만 답과 첨부를 붙일 수 있습니다", "todo_answer_requires_done");
    let targetId: string | null = null;
    const { todo, changed } = this.store.transaction(() => {
      const before = this.store.requireTodo(todoId);
      if (before.done !== done) this.store.setTodoCompletion(todoId, done ? completion.note ?? null : null, done ? completion.fileIds ?? [] : []);
      if (dropReason !== undefined && before.done && before.outcome !== "dropped") throw new ApiError(409, "이미 끝났거나 정리된 할 일입니다", "todo_finished");
      const result = dropReason !== undefined && !before.done
        ? { todo: this.store.closeTodo(todoId, { outcome: "dropped", reason: dropReason, by: "대표" }), changed: true }
        : this.store.setTodoDone(todoId, done);
      if (!result.changed) return result;
      const todo = result.todo;
      const target = (todo.memberId ? this.store.getMember(todo.memberId) : null) ?? this.store.getConductor(todo.projectId);
      targetId = target?.id ?? null;
      if (!done) {
        this.store.setTodoNoticePending(todo.id, false);
        this.store.cancelPendingFor("todo", todo.id);
        this.reconcileTodoCorrections(todo.id);
      } else if (target) {
        const delivery = this.store.enqueue({ projectId: todo.projectId, memberId: target.id, kind: "todo_done", text: this.todoDoneText(todo, target), refType: "todo", refId: todo.id });
        this.store.patchDeliveryRetry(delivery.id, { correctionRevision: this.store.todoRevision(todo.id) });
        const conductor = this.store.getConductor(todo.projectId);
        if (conductor && conductor.id !== target.id) {
          const notice = this.store.enqueue({ projectId: todo.projectId, memberId: conductor.id, kind: "todo_done", text: this.todoDoneText(todo, conductor), refType: "todo", refId: todo.id });
          this.store.patchDeliveryRetry(notice.id, { correctionRevision: this.store.todoRevision(todo.id) });
          this.store.afterCommit(() => { void this.pump(conductor.id); });
        } else if (!conductor && target.kind === "worker") {
          this.store.setTodoNoticePending(todo.id, true);
        }
      } else this.store.setTodoNoticePending(todo.id, true);
      return result;
    });
    if (changed && done && !targetId && this.store.requireProject(todo.projectId).runnerEnabled && !this.store.runnerByAdopt(todo.projectId)) {
      await this.ensureConductor(todo.projectId).catch(e => console.warn("할 일 완료를 받을 총괄을 띄우지 못했습니다:", (e as Error).message));
      await this.adoptOrphans(todo.projectId);
      const conductor = this.store.getConductor(todo.projectId);
      if (conductor && targetId && conductor.id !== targetId) void this.pump(conductor.id);
      targetId ??= conductor?.id ?? null;
    }
    if (changed && targetId) {
      if (done) await this.pump(targetId);
      else void this.pump(targetId);
    }
    return todo;
  }

  /** A successful old send is an external fact. Compensate only after it settles. */
  private reconcileTodoCorrections(todoId?: string): void {
    this.store.transaction(() => {
      const groups = new Map<string, Delivery[]>();
      for (const delivery of this.store.listDeliveries()) if (delivery.refType === "todo" && delivery.refId && (!todoId || delivery.refId === todoId)) {
        const key = `${delivery.refId}:${delivery.memberId}`;
        groups.set(key, [...(groups.get(key) ?? []), delivery]);
      }
      for (const deliveries of groups.values()) {
        const delivered = deliveries.filter(d => d.status === "delivered").at(-1);
        if (!delivered?.refId) continue;
        const todo = this.store.getTodo(delivered.refId);
        if (!todo || todo.done) continue;
        const text = formatTodoUndone(todo);
        const revision = this.store.todoRevision(todo.id);
        if (delivered.text === text || deliveries.some(d => d.text === text && this.store.getDeliveryRetry(d.id).correctionRevision === revision)) continue;
        // A still unresolved older write can land after the correction. Wait for evidence.
        if (deliveries.some(d => d.status === "delivering" || this.store.inputState(d.memberId).unresolvedDispatches.some(dispatch => dispatch.items.some(item => item.deliveryId === d.id)))) continue;
        const correction = this.store.enqueue({ projectId: todo.projectId, memberId: delivered.memberId, kind: "todo_done", text, refType: "todo", refId: todo.id });
        this.store.patchDeliveryRetry(correction.id, { correctionRevision: revision });
        this.store.afterCommit(() => { void this.pump(correction.memberId); });
      }
    });
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
    this.requireActive(project);
    const runner = this.runners.get(this.backendOf(member));
    if (member.origin === "manual" || !runner) throw new ApiError(400, "실행기가 관리하지 않는 세션입니다", "member_not_runner_managed");
    if (rt.turn) rt.turn.interrupted = true;
    await runner.interrupt(this.runnerMember(member, project));
    this.interruptCoreCompaction(member);
    const state = this.store.getContextState(memberId);
    if (state?.compaction?.phase === "failed" && rt.turn?.kind === "compact") this.store.saveContextState({ ...state, compaction: { ...state.compaction, reason: "interrupted" } });
    rt.compactRequest = null;
    if (rt.turn?.kind === "compact") this.endCompact(memberId, rt, "대표가 압축을 중단했습니다");
    return this.store.requireMember(memberId);
  }

  /** 화면의 '명부에서 빼기'. 직접 띄운 세션만. 실행기 세션은 총괄이 team_close 로 닫는다. */
  async memberClose(memberId: string): Promise<void> {
    const member = this.store.requireMember(memberId);
    if (member.origin !== "manual") throw new ApiError(400, "직접 띄운 세션만 여기서 뺄 수 있습니다", "member_not_manual");
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
    try { return (await this.runners.get(this.backendOf(member))?.screen(this.runnerMember(member, project))) ?? ""; }
    catch (e) {
      // 터미널이 끝났거나 없는 팀장(잠듦·offline)은 보여 줄 화면이 없을 뿐이다. 빈 글로 답한다. 소유 불일치·연결 실패는 그대로 오류다.
      if (e instanceof CoreError && !e.uncertain && ["not_found", "finished"].includes(e.kind)) return "";
      throw e;
    }
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
    if (!runner?.answerApproval) throw new ApiError(501, "이 실행 방식에는 승인 창이 없습니다", "approval_unsupported");
    const project = this.store.requireProject(member.projectId);
    this.requireActive(project);
    const r = await runner.answerApproval(this.runnerMember(member, project), req.fingerprint, req.option);
    if (!r.ok) {
      const why = {
        not_blocked: "승인 창 앞이 아닙니다. 이미 풀렸을 수 있습니다",
        unrecognized: "승인 창으로 읽히지 않는 창입니다. 터미널에서 푸세요",
        changed: "창이 바뀌었습니다. 새 창을 보고 다시 고르세요",
        no_option: "그 번호의 선택지가 없습니다",
        no_effect: "키를 눌렀지만 창이 그대로입니다. 터미널에서 확인하세요",
        gone: "칸을 찾지 못했습니다",
        input_busy: "수동 조작 중이거나 터미널 입력 상태가 바뀌었습니다. 조작을 끝내고 창을 다시 확인하세요",
      }[r.reason];
      throw new ApiError(r.reason === "no_option" ? 400 : 409, why, `approval_${r.reason}`);
    }
    this.store.appendActivity(member.id, "system", `대표가 승인 창에서 ${r.chosen.n}번 '${r.chosen.label}' 을 골랐습니다 · ${approvalSummary(r.prompt, 200)}`);
    const note = req.note?.trim();
    if (r.chosen.reject && note) await this.sendUserMessage(member.projectId, { text: note, targetMemberId: member.id });
  }

  cliCommand(): string {
    return cliCommand();
  }

  async listAgentTools(member: Member): Promise<AgentToolDef[]> {
    return (await this.tools()).listAgentTools(member);
  }

  async handleAgentTool(member: Member, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> {
    const tools = await this.tools();
    const boardRevision = name === "board" ? this.store.boardRevision(member.projectId) : null;
    const result = await tools.handleAgentTool(this, member, name, args, signal);
    if (!result.isError) {
      if (boardRevision !== null) this.noteBoardReview(member, boardRevision);
      if (["team_assign", "team_add", "team_resume"].includes(name) && this.runtime(member.id).turn) {
        this.runtime(member.id).delegated = true;
        for (const run of this.store.listPendingExecutions().filter(run => run.memberId === member.id)) this.store.saveExecutionJournal({ ...run, reason: "awaiting_delegation", updatedAt: new Date().toISOString() });
      }
    }
    return result;
  }

  /** 영속 예약을 먼저 커밋한다. 프로세스가 죽으면 미확인 결과를 반환하며 효과를 재생하지 않는다. */
  async handleAgentOperation(member: Member, name: string, args: Record<string, unknown>, context: AgentOperationContext, signal?: AbortSignal): Promise<AgentToolResult> {
    const current = this.store.requireMember(member.id);
    if (current.projectId !== member.projectId) throw new ApiError(404, "팀원을 찾을 수 없습니다", "member_not_found");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(context.operationId)) throw new ApiError(400, "operationId가 잘못되었습니다", "invalid_operation_id");
    let reserved = false;
    const previous = this.store.agentOperation(current.id, name, context.operationId, args, () => {
      reserved = true;
      return { text: "이 작업의 결과를 확인할 수 없습니다. 같은 작업은 자동 재실행하지 않습니다", isError: true };
    });
    const running = this.agentOperations.get(context.operationId);
    if (running) return running;
    // 동기 Store 포트의 두 불변 receipt로 예약과 비동기 결과를 나눈다.
    // ':'는 외부 operation ID에 허용하지 않아 결과 namespace와 충돌하지 않는다.
    const resultId = `agent-result:${context.operationId}`;
    if (!reserved) {
      const missing = Symbol("result_pending");
      try { return this.store.agentOperation(current.id, name, resultId, args, () => { throw missing; }); }
      catch (error) { if (error !== missing) throw error; }
      return previous;
    }
    const execution = this.handleAgentTool(current, name, args, signal).then(result =>
      this.store.agentOperation(current.id, name, resultId, args, () => result),
    ).finally(() => { this.agentOperations.delete(context.operationId); });
    this.agentOperations.set(context.operationId, execution);
    return execution;
  }

  /** Called at the board read boundary; completion only covers the requested revision. */
  noteBoardReview(member: Member, revision = this.store.boardRevision(member.projectId)): void {
    const turn = this.runtime(member.id).turn;
    const runs = this.store.listPendingExecutions().filter(run => run.memberId === member.id);
    const tidy = runs.some(run => run.deliveryIds.some(id => { const delivery = this.store.getDelivery(id); return delivery && isTidy(delivery); }));
    const requestedRevision = turn?.boardReview?.requestedRevision ?? (tidy ? this.store.getBoardReview(member.projectId)?.requestedRevision : undefined);
    if (requestedRevision === undefined) return;
    const reviewedRevision = Math.min(requestedRevision, revision);
    if (turn?.boardReview) turn.boardReview.reviewedRevision = reviewedRevision;
    for (const run of runs) this.store.saveExecutionJournal({ ...run, reason: `board_review:${requestedRevision}:${reviewedRevision}`, updatedAt: new Date().toISOString() });
  }

  private async tools(): Promise<AgentToolsImpl> {
    // agent-tools.ts 가 이 파일의 타입을 쓰므로 정적 import 로 순환시키지 않는다.
    this.agentTools ??= await import("./agent-tools.ts");
    return this.agentTools;
  }

  async askWait(member: Member, decisionId: string, timeoutMs: number, signal?: AbortSignal): Promise<AskWaitResult> {
    const ready = (): AskWaitResult | null => {
      const current = this.store.requireMember(member.id);
      const decision = this.store.requireDecision(decisionId);
      if (decision.projectId !== current.projectId || decision.memberId !== member.id) throw new ApiError(403, "자신이 올린 결재만 기다릴 수 있습니다", "decision_not_own");
      if (signal?.aborted || this.store.requireProject(member.projectId).archived || this.archiving.has(member.projectId) || decision.status === "open") return null;
      const answered = decision.status === "answered" || decision.status === "delivered";
      if (decision.status === "answered") {
        this.materializeManualAnswers(current);
        // An unacknowledged wait batch owns its items. askWait must not consume it.
        if (this.store.manualInbox(member.id, [])?.items.some(item => item.ref?.type === "decision" && item.ref.id === decisionId)) return null;
        const delivery = this.store.listPending(member.id).find(d => d.refType === "decision" && d.refId === decisionId);
        if (delivery) {
          const batch = this.store.manualInbox(member.id, [delivery.id]);
          if (!batch?.items.some(item => item.deliveryId === delivery.id)) return null;
          this.store.acknowledgeManualInbox(member.id, batch.id);
        } else this.store.setDecisionStatus(decisionId, "delivered");
      }
      const text = answered ? formatAnswer(decision) : formatSystem(`결재가 닫혔습니다${decision.closeReason ? `: ${normalizeSpace(decision.closeReason)}` : ""}. 이 질문의 답은 오지 않습니다 #${decision.id}`);
      this.settle(current);
      return { done: true, text, decision: this.store.requireDecision(decisionId) };
    };
    if (signal?.aborted) return { done: false };
    const now = ready();
    if (now) return now;
    await this.waitOn(this.askWaiters, decisionId, Math.min(Math.max(timeoutMs, 0), 50_000), signal);
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

  private beginConductor(project: Project, retainOnFailure = false): { member: Member; ready: Promise<void> } {
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
      cli: this.store.chiefCli(project.id),
    }, retainOnFailure);
    if (project.now) {
      this.store.enqueue({ projectId: project.id, memberId: spawn.member.id, kind: "system", text: formatSystem(`지금 상황: ${guardLines(project.now)}`), wake: false });
    }
    return spawn;
  }

  async addMember(projectId: string, input: NewMemberInput, assignedBy?: Member): Promise<{ member: Member; assigned: AssignResult | null }> {
    this.models.requireModel(input.cli ?? "claude", input.modelOverride);
    const project = this.store.requireProject(projectId);
    if (!project.runnerEnabled) throw new ApiError(409, "이 프로젝트는 실행이 꺼져 있습니다", "runner_disabled");
    const name = input.name.trim();
    if (!name) throw new ApiError(400, "이름이 필요합니다", "name_required");
    const source = input.userQuote?.trim() ? this.findQuoteSource(projectId, input.userQuote) : null;
    const quote = input.userQuote?.trim() ? { text: input.userQuote, verified: source !== null, source } : null;
    const { value: { member, ready }, deliveries } = this.store.transaction(() => {
      const spawned = this.store.withDeliveryIntents(() => this.beginSpawn(project, {
        kind: input.kind ?? "worker",
        handle: input.handle ?? this.deriveHandle(projectId, name),
        name,
        role: input.role ?? "",
        cli: input.cli ?? "claude",
        modelOverride: input.modelOverride,
        cwd: input.cwd ? this.resolveCwd(project, input.cwd) : undefined,
      }), ({ member }) => {
        if (!input.firstInstruction) return [];
        return [{ projectId, memberId: member.id, kind: "instruction", text: formatInstruction(member.name, input.firstInstruction, quote) }];
      });
      if (assignedBy) for (const delivery of spawned.deliveries) this.store.noteDelegation(assignedBy.id, delivery, false);
      return spawned;
    });
    if (input.parallel) this.runtime(member.id).wantParallel = true;
    await ready;
    await this.pump(member.id);
    const assigned = deliveries[0] ? { delivery: this.store.requireDelivery(deliveries[0].id), position: 0,
      verified: quote?.verified ?? null, needsContext: quote ? quoteNeedsContext(quote) : false } : null;
    this.checkAwakeLimit(projectId);
    return { member: this.store.requireMember(member.id), assigned };
  }

  /** 명부에 올리고 세션을 띄우기 시작한다. 끝나기 전에는 pump 가 건너뛰고, 끝나면 다시 민다. */
  private beginSpawn(project: Project, input: { kind: MemberKind; handle: string; name: string; role: string; cwd?: string; cli?: CliProvider; modelOverride?: string | null }, retainOnFailure = false): { member: Member; ready: Promise<void> } {
    this.requireActive(this.store.requireProject(project.id));
    const member = this.store.createMember({ projectId: project.id, ...input, origin: "runner", status: "idle" });
    if (!project.runnerEnabled) return { member, ready: Promise.resolve() };
    const rt = this.runtime(member.id);
    const intent = this.prepareLifecycle(member, "start");
    // No external start can observe a source transaction that may still roll back.
    const ready = new Promise<void>((resolve, reject) => {
      this.store.afterCommit(() => {
        void (async () => {
          this.openRunner(member);
          const sent = this.desiredConfig(member);
          const started = await this.startManaged(member, project, false, intent);
          this.applyStarted(member.id, started, sent);
        })().then(resolve, e => {
          // 정리 중의 오류가 reject 를 건너뛰면 rt.starting 이 영영 남아 이 직원의 전달이 멈춘다.
          try {
            const journal = this.store.getLifecycleJournal(intent.operationId);
            if (journal?.phase === "prepared") this.finishLifecycle(journal, "refused", (e as Error).message.slice(0, 500));
            if (retainOnFailure) {
              this.store.patchMember(member.id, { status: "offline", lastError: (e as Error).message });
              for (const d of this.store.listPending(member.id)) this.hold(d, "backend_down");
              // E3: 펌프 밖에서 보류했다. 그 까닭을 판정으로 남긴다.
              this.judged(member.id, "runner_off");
            } else if (this.backendOf(member) !== "core" || (e instanceof CoreError && !e.uncertain && !["starting_unknown", "conflict", "unknown"].includes(e.kind))) this.abandonSpawn(member.id);
          } catch (cleanup) { console.error("세션 기동 실패 정리 오류:", member.id, cleanup); }
          finally { reject(new ApiError(502, `세션을 띄우지 못했습니다: ${(e as Error).message}`, "session_start_failed")); }
        });
      });
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
    this.forgetMember(memberId);
  }

  /** 명부에서 뺀다. 그 직원의 실행 파일(규칙·MCP 설정·CLI 설정)도 지운다: MCP 설정에는 그 직원의 토큰이 들어 있다. */
  private forgetMember(memberId: string): void {
    this.blockedNotices.delete(memberId);
    this.cancelBlockedNotices(memberId);
    this.autoTrusts.delete(memberId);
    this.store.setRestartWake(memberId, null);
    this.store.removeMember(memberId);
    this.store.afterCommit(() => {
      for (const suffix of ["rules.md", "mcp.json", "settings.json"]) {
        try { unlinkSync(join(this.config.home, "run", `${memberId}.${suffix}`)); } catch { /* 만든 적이 없거나 이미 없다 */ }
      }
    });
  }

  /** sent 는 start 에 실제로 넘긴 설정이다. 띄우는 동안 바뀐 값을 적으면 옛 값으로 돌면서 맞춘 것으로 기록된다. */
  private applyStarted(memberId: string, started: { sessionId: string | null; paneId: string | null; rejoined?: boolean }, sent?: AppliedConfig): void {
    const runner = this.runnerOf(this.store.requireMember(memberId));
    const currentError = runner instanceof CoreRunner ? runner.observationState(memberId)?.lastError : null;
    const stored = this.store.requireMember(memberId);
    this.store.patchMember(memberId, { sessionId: started.sessionId, paneId: started.paneId, ...(!currentError && !(started.rejoined && stored.fenceCode === "control_unknown") && !this.keepsUsageNote(stored) ? { lastError: null } : {}) });
    if (!started.rejoined) this.runtime(memberId).launchedAt = Date.now();
    // 이미 떠 있던 칸에 붙었으면 이번 인자가 들어간 것이 아니다.
    if (!started.rejoined && sent) {
      this.store.setAppliedConfig(memberId, sent);
      this.runtime(memberId).configGaveUp = null;
      this.store.clearDeferredMemberConfig(memberId);
    }
  }

  private resolveCwd(project: Project, raw: string): string {
    const path = isAbsolute(raw) ? raw : resolve(project.cwd, raw);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      // 없는 경로는 아래에서 같은 오류로 처리한다.
    }
    if (!isDir) throw new ApiError(400, `폴더가 없습니다: ${path}`, "folder_missing");
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

  private refuseOwnerDirectRepeat(target: Member, quote: VerifiedQuote | null): void {
    if (quote?.verified && quote.source) {
      const message = this.store.getMessage(quote.source.id);
      if (message?.mine && message.targetMemberId === target.id && this.store.listDeliveries(target.projectId).some(d =>
        d.memberId === target.id && d.kind === "user_message" && d.refType === "message" && d.refId === message.id &&
        ["queued", "delivering", "delivered"].includes(d.status))) {
        const reason = `대표가 이미 ${target.name}에게 직접 보낸 지시입니다(#${message.id}). 다시 보내지 마세요. 더할 일이 있으면 인용 없이 그 부분만 쓰세요.`;
        this.store.appendActivity(target.id, "system", reason);
        throw new ApiError(409, reason, "owner_direct_repeat");
      }
    }
  }

  /** team_assign. member 는 핸들 또는 화면 이름. 다른 프로젝트 직원은 찾지 못한다. */
  async assign(projectId: string, memberRef: string, input: AssignInput, assignedBy?: Member): Promise<AssignResult> {
    const target = this.requireInProject(projectId, memberRef);
    const source = input.userQuote?.trim() ? this.findQuoteSource(projectId, input.userQuote) : null;
    const quote = input.userQuote?.trim() ? { text: input.userQuote, verified: source !== null, source } : null;
    this.refuseOwnerDirectRepeat(target, quote);
    // 마지막 지시가 이긴다. 거절된 지시는 병렬 설정도 바꾸지 않는다.
    if (input.parallel !== undefined) this.runtime(target.id).wantParallel = input.parallel;
    const project = this.store.requireProject(projectId);
    const busy = this.isBusy(target);
    const attachments = (input.attachmentIds ?? []).map((id) => {
      const attachment = this.store.getAttachment(id);
      if (!attachment || !this.store.isProjectAttachment(projectId, id)) throw new ApiError(404, `이 프로젝트에서 대표가 보낸 첨부가 아닙니다: ${id}`, "attachment_not_found");
      return attachment;
    });
    const delivery = this.store.transaction(() => {
      const delivery = this.store.enqueue({
        projectId,
        memberId: target.id,
        kind: "instruction",
        text: [formatInstruction(target.name, input.text, quote), ...attachmentLines(this.attachmentsFor(target, attachments))].join("\n"),
        urgent: input.urgent,
      });
      // 끼워 넣을 수 없는 실행기에서는 긴급도 턴이 끝나야 나간다. 지시한 쪽에 '대기'로 알린다.
      if (assignedBy) { this.store.setDeliveryAuthor(delivery.id, assignedBy.id); this.store.noteDelegation(assignedBy.id, delivery, busy && !(input.urgent && this.interjects(this.runners.get(this.backendOf(target))))); }
      return delivery;
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
    for (const todo of this.store.listTodos(projectId)) if (todo.done && todo.completionNote && matches(todo.completionNote)) return { id: todo.id, text: todo.completionNote, at: todo.doneAt, card: todo.title };
    const project = this.store.requireProject(projectId);
    if (project.creationGoal && matches(project.creationGoal)) return { id: project.id, text: project.creationGoal, at: project.createdAt };
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

  /** team_compact·화면 압축. 실행 중이어도 안전 조건을 우회하지 않고 예약한다. */
  async compactMember(memberId: string, focus?: string): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 압축할 수 없습니다", "manual_session_unsupported");
    const project = this.store.requireProject(member.projectId);
    this.requireActive(project);
    if (!project.runnerEnabled || ["asleep", "offline"].includes(member.status)) throw new ApiError(409, "깨어 있고 실행이 켜진 팀원만 압축할 수 있습니다", "compact_not_awake");
    if (!member.sessionId) throw new ApiError(this.backendOf(member) === "core" ? 409 : 400, "아직 native 세션을 확인하지 못했습니다", "session_id_unknown");
    const normalized = (focus ? normalizeSpace(focus) : "") || this.compactFocus(member);
    if (this.backendOf(member) === "core") {
      if (!member.paneId) throw new ApiError(409, "세션 터미널이 없습니다", "session_terminal_missing");
      if (this.runnerOf(member) instanceof CoreRunner && !this.contextLog(member)) throw new ApiError(409, "압축 완료를 관찰할 native 세션 기록이 없습니다", "compact_record_missing");
      this.coreCompactFenced(member); // 손상된 영속 상태도 새 예약으로 덮지 않는다.
      const state = this.store.ensureContextState(memberId);
      if (state.compaction && ["queued", "sending", "running", "uncertain"].includes(state.compaction.phase)) return this.store.requireMember(memberId);
      const generation = this.store.memberRevisions(memberId).sessionGeneration;
      const available = await this.runnerOf(member).available();
      this.requireActive(this.store.requireProject(project.id));
      if (!available.ok) throw new ApiError(409, "실행기에 연결할 수 없습니다", "backend_unreachable");
      const current = this.store.requireMember(memberId);
      if (this.store.memberRevisions(memberId).sessionGeneration !== generation || current.sessionId !== member.sessionId || current.paneId !== member.paneId || ["asleep", "offline"].includes(current.status)) throw new ApiError(409, "압축을 예약하는 동안 세션이 변경되었습니다", "compact_session_changed");
      this.queueCoreCompact(this.store.requireMember(memberId), "manual", normalized);
    } else this.runtime(memberId).compactRequest = normalized;
    await this.pump(memberId);
    return this.store.requireMember(memberId);
  }

  private queueCoreCompact(member: Member, trigger: "manual" | "auto", focus: string): void {
    const state = this.store.ensureContextState(member.id);
    if (state.compaction && ["queued", "sending", "running", "uncertain"].includes(state.compaction.phase)) return;
    this.store.saveContextState({ ...state, baseline: { ...state.baseline, focus,
      ...(trigger === "auto" ? { autoTurn: state.measurement?.turn } : {}) },
      compaction: { id: randomUUID(), trigger, phase: "queued", reason: member.status === "working" ? "working" : member.status === "blocked" ? "blocked" : null,
        requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null } });
    this.runtime(member.id).compactRequest = focus;
    this.runtime(member.id).compactBusySince = null;
  }

  private contextLog(member: Member): { path: string; home: string } | null {
    if (!this.providerHomes || !member.sessionId) return null;
    const home = member.cli === "codex" ? this.providerHomes.codexHome : this.providerHomes.claudeHome;
    if (member.cli !== "codex") {
      const path = findSessionFile(home, member.cwd, member.sessionId);
      return path ? { path, home } : null;
    }
    const root = join(home, "sessions");
    // 턴이 끝날 때마다 부른다. 찾은 경로는 기억하고, 못 찾았을 때만 다시 훑는다.
    const known = this.codexLogs.get(member.id);
    if (known && known.sessionId === member.sessionId && known.cwd === member.cwd && existsSync(known.path)) return { path: known.path, home };
    try {
      const matching = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false })].filter(path => {
        const meta = parseCodexSessionMeta(readJsonlRange(root, path, null, { maxBytes: 1024 * 1024 }).records[0]?.value);
        return meta?.sessionId === member.sessionId && meta.cwd === member.cwd;
      });
      // Codex 는 기록 이름 끝에 세션 ID 를 붙인다. 그 이름부터 본다: 전체 rollout(수백 개)의 앞 1MB 를 다 읽으면 0.5초씩 멈춘다.
      let paths = matching(`**/rollout-*-${member.sessionId}.jsonl`);
      if (!paths.length) paths = matching("**/rollout-*.jsonl");
      if (paths.length !== 1) return null;
      this.codexLogs.set(member.id, { sessionId: member.sessionId, cwd: member.cwd, path: paths[0]! });
      return { path: paths[0]!, home };
    } catch { return null; }
  }
  private readonly codexLogs = new Map<string, { sessionId: string; cwd: string; path: string }>();

  private invalidateCoreMeasurement(member: Member): void {
    if (this.backendOf(member) !== "core") return;
    const state = this.store.getContextState(member.id);
    if (state?.measurement?.fresh) this.store.saveContextState({ ...state, measurement: { ...state.measurement, fresh: false } });
  }

  private deferCoreCompact(member: Member, reason: "manual_control" | "working" | "blocked" | "backend_down"): void {
    if (this.backendOf(member) !== "core") return;
    const state = this.store.getContextState(member.id);
    if (state?.compaction?.phase === "queued" && state.compaction.reason !== reason) this.store.saveContextState({ ...state, compaction: { ...state.compaction, reason } });
  }

  private interruptCoreCompaction(member: Member): void {
    if (this.backendOf(member) !== "core") return;
    const state = this.store.getContextState(member.id);
    if (!state?.compaction || ["succeeded", "failed"].includes(state.compaction.phase)) return;
    const saved = state.baseline?.coreCompact as CoreCompactState | undefined;
    this.store.saveContextState({ ...state, measurement: state.measurement ? { ...state.measurement, fresh: false } : null,
      baseline: { ...state.baseline, ...(saved?.id === state.compaction.id ? { coreCompact: { ...saved, phase: "failed" } } : {}) },
      compaction: { ...state.compaction, phase: "failed", reason: "interrupted", finishedAt: new Date().toISOString() } });
    this.runtime(member.id).compactRequest = null;
    this.runtime(member.id).skipCompact = true;
  }

  /**
   * 미확정 압축(sending·running·uncertain)은 그 명령을 받은 터미널에 묶여 있다. 실행기는 같은 터미널에 다시 붙을 때만 그 압축을
   * 이어 확인하므로(CoreRunner.restore), 터미널이 사라졌으면(Mac 재시작, 터미널 종료 뒤 새로 열림) 아무도 결과를 확정하지 못하고
   * 자동 입력이 끝없이 막힌다. 2026-11-12 실측: 재시작 뒤 14시간 동안 한 팀장이 지시를 하나도 받지 못했다.
   * 그 터미널이 없으면 거기서 돌던 압축도 없다: '중단'으로 닫고 대기열을 이어 간다.
   * - gone: 사라진 것이 확정된 터미널(releaseGoneTerminal 이 넘긴다). 그 터미널이 받은 압축은 띄우기·끝내기 결과와 무관하게 닫는다.
   * - gone 없이(전달 직전의 확인): 묶인 터미널이 지금 터미널과 다를 때 닫는다. 띄우기·끝내기 결과를 모르는 동안은 닫지 않는다.
   * - 묶인 터미널이 적히지 않은 미확정 압축: 실행기는 명령을 넣기 전에 기준선(받을 터미널)부터 저장하므로, 기준선이 없으면 넣은 적이 없다.
   *   예전 서버가 '넣기 전의 시간 초과'를 불확실로 적어 남긴 것이다(지금은 beginCompact 가 다시 예약한다). 어떤 조작으로도 풀리지 않았고,
   *   그 팀장을 다시 여는 것까지 실패시켰다. 터미널과 무관하게 닫는다.
   */
  private releaseOrphanCompact(memberId: string, gone: string | null = null): void {
    const member = this.store.getMember(memberId);
    if (!member || this.backendOf(member) !== "core") return;
    const state = this.store.getContextState(member.id);
    const compact = state?.compaction;
    if (!state || !compact || !["sending", "running", "uncertain"].includes(compact.phase)) return;
    const saved = state.baseline?.coreCompact as CoreCompactState | undefined;
    const own = saved?.id === compact.id ? saved : null;
    const bound = own?.baseline.terminalId ?? null;
    // 기준선 없는 압축을 넣은 적이 없다고 볼 수 있는 것은 넣기 전에 기준선부터 저장하는 실행기(CoreRunner)뿐이다.
    // 지금 넣는 중인 압축(기준선 저장 직전)은 건드리지 않는다. 그때의 단계는 queued 라 여기 오지 않지만, 넣는 중의 턴 표시도 함께 본다.
    if (!own && (!(this.runners.get("core") instanceof CoreRunner) || this.runtime(member.id).turn?.kind === "compact")) return;
    if (own && !(gone !== null && bound === gone) && (this.pendingLifecycle(member.id) || !bound || bound === member.paneId)) return;
    this.store.saveContextState({ ...state, measurement: state.measurement ? { ...state.measurement, fresh: false } : null,
      baseline: { ...state.baseline, ...(own ? { coreCompact: { ...own, phase: "failed" } } : {}) },
      compaction: { ...compact, phase: "failed", reason: "interrupted", finishedAt: new Date().toISOString() } });
    const rt = this.runtime(member.id);
    rt.compactRequest = null;
    rt.skipCompact = true; // 밀린 일이 먼저다. 압축은 다음 측정에서 다시 판단한다.
    this.store.appendActivity(member.id, "system", own ? "압축을 받은 터미널이 끝나 그 압축을 닫았습니다. 밀린 전달을 이어 갑니다" : "넣지 못한 압축이 확인 대기로 남아 있어 닫았습니다. 밀린 전달을 이어 갑니다", `${compact.id}:orphan_compact`);
  }

  private coreCompactFenced(member: Member): boolean {
    if (this.backendOf(member) !== "core") return false;
    this.releaseOrphanCompact(member.id);
    const compact = this.store.getContextState(member.id)?.compaction;
    if (compact && !["queued", "sending", "running", "uncertain", "succeeded", "failed"].includes(compact.phase)) throw new ApiError(409, "압축 상태를 읽을 수 없어 자동 입력을 보류합니다", "compact_state_unreadable");
    return !!compact && ["sending", "running", "uncertain"].includes(compact.phase);
  }

  /** 실패/불확실도 Runner가 저장한 결과만 반영한다. idle이나 ACK는 완료 근거가 아니다. */
  private reconcileCoreCompact(member: Member): void {
    if (this.backendOf(member) !== "core") return;
    const state = this.store.getContextState(member.id);
    const rt = this.runtime(member.id);
    if (state?.compaction?.phase === "queued") rt.compactRequest ??= (state.baseline?.focus as string | undefined) ?? this.compactFocus(member);
    if (state?.compaction?.phase === "failed" && rt.turn?.kind === "compact") this.endCompact(member.id, rt, "제공자가 압축 종료/실패를 확인했습니다");
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

  /**
   * 일하는 중·열린 결재·깨우는 입력이나 미수신 답이 있으면 거부(force 로만). 깨우지 않는 소식은 보존한다. sessionId 는 유지한다.
   * recovering 은 이미 시작한 종료를 마저 확인하는 내부 복구다. 그 사이 쌓인 결재·대기열로는 거부하지 않는다.
   */
  async sleepMember(memberId: string, opts: { force?: boolean; holdAs?: "archived"; recovering?: boolean } = {}): Promise<Member> {
    const member = this.store.requireMember(memberId);
    if (member.status === "asleep" && !this.pendingLifecycle(memberId)) return member;
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 잠재울 수 없습니다", "manual_session_unsupported");
    const project = this.store.requireProject(member.projectId);
    if (!opts.holdAs) this.requireActive(project);
    const rt = this.runtime(memberId);
    const pending = this.store.listPending(memberId);
    if (!opts.force) {
      if (this.store.inputState(memberId).lease) throw new ApiError(409, "직접 조작권이 남아 있어 잠재울 수 없습니다. 조작을 끝내고 조작권을 놓아 주세요", "sleep_terminal_lease");
      if (this.deliveryRecovery.fenced(memberId)) throw new ApiError(409, "전달 결과가 확인되지 않은 입력이 있어 잠재울 수 없습니다. 전달 확인을 먼저 끝내세요", "sleep_delivery_unknown");
      if (this.coreCompactFenced(member)) throw new ApiError(409, "문맥 압축을 처리하고 있어 잠재울 수 없습니다. 압축 결과를 확인해 주세요", "sleep_compacting");
      if (this.isBusy(member)) throw new ApiError(409, `${josa(member.name, "은")} 일하는 중입니다`, "member_working");
      // 미확정 종료가 열려 있는 동안 전달 펌프는 멈춘다. 그 사이 온 입력으로 복구까지 거부하면 서로 영영 물린다.
      if (!opts.recovering) {
        if (this.store.listOpenDecisionsByMember(memberId).length > 0) throw new ApiError(409, `${member.name}에게 열린 결재가 있습니다`, "member_open_decision");
        if (pending.some(d => d.wake) || this.store.listUnreceivedAnswers(memberId).length > 0) throw new ApiError(409, `${member.name}의 대기열이 남아 있습니다`, "member_queue_pending");
      }
    }
    if (rt.closing || rt.starting || rt.reopening) throw new ApiError(409, "세션을 처리하는 중입니다", "session_busy");
    // 재우기 시작한 뒤에 온 깨움을 가린다: 지금 대기열에 없던 것, 또는 앞선 미확정 종료가 시작된 뒤에 생긴 것.
    const queuedBefore = new Set(pending.map(d => d.id));
    const prior = this.pendingLifecycle(memberId);
    const priorStopAt = prior && prior.intent !== "start" ? prior.createdAt : null;
    let rewake = false;
    rt.closing = true;
    try {
      if (opts.holdAs === "archived") {
        await this.verifyArchiveSession(member);
        await this.runnerOf(member).checkStop?.(this.runnerMember(member, project), { whileWorking: false });
      }
      // 넘겨받은 명부(origin adopted)의 세션은 서버가 띄운 것이 아니다. 끊기 전에 끝낼 수 있는지부터 본다: 못 끝내면 아무것도 바꾸지 않고 이유를 돌려준다.
      if (member.origin === "adopted" && opts.force && !opts.holdAs && (this.isBusy(member) || member.status === "blocked")) {
        const runner = this.runnerOf(member);
        const target = this.runnerMember(member, project);
        await runner.checkStop?.(target, { whileWorking: true });
        if (member.status !== "blocked") await runner.interrupt(target);
      }
      // 사용 한도로 멈춘 팀장: 그 턴은 이미 한도 오류로 끝났다. 한도 메뉴가 떠 있으면 Esc 로만 닫은 뒤, 쉬는 CLI 처럼 끝낸다(초안 확인은 그대로).
      const menuClosed = !opts.force && !opts.holdAs && this.apiRecovery.usageLimited(memberId) ? await this.closeUsageMenu(member) : false;
      try { await this.stopManaged(member, opts.holdAs === "archived" ? "archive" : "sleep", !!opts.force && !opts.holdAs); }
      catch (e) { if (menuClosed) this.restoreAfterUsageMenu(member); throw e; }
      this.endExecution(member, "interrupted", "팀원을 잠재워 실행을 종료했습니다");
      if (rt.turn) rt.turn.interrupted = true;
      rt.compactRequest = null;
      this.store.transaction(() => {
        this.interruptCoreCompaction(member);
        this.store.patchMember(memberId, { status: "asleep", subagents: 0, paneId: null });
        // 재시작으로 꺼진 팀장을 재웠다: 스스로 다시 열지 않는다. 잠든 팀장은 그대로 잔다.
        this.settleRestartWake(memberId, "dropped");
        for (const d of this.store.listPending(memberId)) {
          const history = this.store.listDispatches(memberId).filter(dispatch => dispatch.items.some(item => item.deliveryId === d.id));
          const unwritten = history.length ? history.every(dispatch => dispatch.transportState === "rejected") : d.attempts === 0 && d.holdReason !== "delivery_unknown";
          if (opts.holdAs && !unwritten && (d.attempts > 0 || d.status === "held" && d.holdReason !== "archived")) continue;
          // 재우는 사이 새로 온 깨움은 '잠듦'으로 묻지 않는다. 잠든 직후 온 말처럼 곧바로 다시 깨운다.
          if (!opts.holdAs && d.wake && (!queuedBefore.has(d.id) || (priorStopAt !== null && d.createdAt >= priorStopAt))) { rewake = true; continue; }
          this.hold(d, opts.holdAs ?? "asleep");
        }
        this.confirmStop(memberId);
      });
      // 터미널을 끝내면 turn_end 가 오지 않는다. 턴을 비우지 않으면 깨운 뒤 전달이 영영 막힌다.
      if (rt.compactTimer) clearTimeout(rt.compactTimer);
      rt.compactTimer = null;
      if (rt.turn) {
        rt.turn = null;
        this.releaseSlots();
      }
      // E3: 재우며 보류한 전달의 까닭을 남긴다(다시 깨우면 펌프가 새로 판정한다).
      if (!rewake && this.store.listPending(memberId).length) this.judged(memberId, opts.holdAs === "archived" ? "archived" : "asleep_hold");
      return this.store.requireMember(memberId);
    } finally {
      rt.closing = false;
      if (rewake) void this.pump(memberId);
    }
  }

  /** --resume 으로 다시 연다. 실패하면 같은 핸들로 새 세션을 띄우고 마지막 일을 첫 지시에 넣는다. */
  async resumeMember(memberId: string, firstInstruction?: string, assignedBy?: Member): Promise<Member> {
    let member = this.store.requireMember(memberId);
    if (member.origin === "manual") throw new ApiError(400, "직접 띄운 세션은 다시 열 수 없습니다", "manual_session_unsupported");
    this.requireActive(this.store.requireProject(member.projectId));
    if (member.backend !== "core" && (member.sessionId || member.paneId)) throw new ApiError(409, "이전 실행기의 세션은 자동으로 다시 열지 않습니다", "legacy_session");
    // 깨우기가 성공으로 답하고 아무 일도 하지 않는 경우를 남기지 않는다.
    // 결과를 모르는 끝내기가 남아 있으면 지금 확인해 본다(터미널이 사라졌으면 여기서 닫힌다). 그래도 남으면 그 사실을 답한다.
    if (this.pendingLifecycle(memberId) && this.pendingLifecycle(memberId)!.intent !== "start") {
      await this.recoverStops();
      member = this.store.requireMember(memberId);
      const stop = this.pendingLifecycle(memberId);
      if (stop && stop.intent !== "start") throw new ApiError(409, `${member.name}의 세션을 끝내던 작업의 결과를 아직 확인하지 못했습니다. 실행 엔진이 답하면 스스로 정리합니다. 잠시 뒤 다시 깨워 주세요`, "stop_unverified");
    }
    const rt = this.runtime(memberId);
    if (rt.starting) { await rt.starting; member = this.store.requireMember(memberId); }
    // 터미널이 없는데 꺼짐·잠듦으로 적히지 않은 팀장(새 세션 띄우기가 확정 실패해 오류로 남은 경우)도 다시 연다.
    const unopened = member.origin === "runner" && member.backend === "core" && !member.paneId && !this.pendingLifecycle(memberId);
    if (member.status === "asleep" || member.status === "offline" || unopened) {
      // 가져온 프로젝트는 총괄을 시작하기 전에는 어떤 세션도 움직이지 않는다고 약속했다.
      if (!this.store.requireProject(member.projectId).runnerEnabled) throw new ApiError(409, "이 프로젝트는 실행이 꺼져 있습니다. 총괄을 먼저 시작하세요", "runner_disabled");
      rt.quickExits = 0; rt.quickExitNotified = false;
      const reopened = await this.reopen(member);
      if (!reopened) {
        const why = this.store.requireMember(memberId).lastError;
        throw new ApiError(502, `${josa(member.name, "을")} 다시 열지 못했습니다${why ? `: ${why}` : ""}`, "reopen_failed");
      }
      this.checkAwakeLimit(member.projectId);
    }
    if (firstInstruction?.trim()) {
      await this.assign(member.projectId, member.handle, { text: firstInstruction }, assignedBy);
    } else {
      await this.pump(memberId);
    }
    return this.store.requireMember(memberId);
  }

  /**
   * 띄우자마자 끝나는 세션을 틱마다 다시 띄우면 CLI 프로세스만 계속 만들고 전달은 엉뚱한 사유로 남는다.
   * 세 번 이어지면 한동안 자동으로 깨우지 않고 이유를 한 번 알린다. 대표가 직접 깨우면 바로 다시 시도한다.
   */
  private quickExitHeld(member: Member, rt: Runtime, pending: Delivery[]): boolean {
    if (rt.quickExits < 3) return false;
    const until = rt.quickExitAt + this.timings.quickExitRetryMs;
    if (Date.now() >= until) { rt.quickExits = 2; return false; } // 한 번 더 띄워 본다. 또 끝나면 다시 멈춘다.
    for (const d of pending) this.hold(d, "offline");
    this.scheduleRetry(member.id, rt, until);
    if (!rt.quickExitNotified) {
      rt.quickExitNotified = true;
      const text = `${member.name}의 세션이 시작하자마자 끝나기를 되풀이해 자동으로 다시 깨우지 않습니다. 터미널에서 원인을 확인한 뒤 팀원을 깨워 주세요.${member.lastError ? ` (${member.lastError})` : ""}`;
      this.store.appendActivity(member.id, "error", text);
      this.systemMessage(member.projectId, text);
      this.notifyInbox(`${member.name} 세션 시작 실패`, text);
    }
    return true;
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
    // 세션도 터미널도 없는 넘겨받은 명부(가져온 팀)는 넘겨받을 것이 없다. 서버가 새 세션을 띄운다. 실행기는 남의 터미널을 건드리지 않으려고
    // origin adopted 를 거절하므로 띄울 때만 서버 세션으로 넘기고, 명부의 origin 은 뜬 뒤에 바꾼다.
    // 세션 ID 가 남은 행은 대표의 터미널에서 살아 있을 수 있어 그대로 둔다('새 세션으로 이어가기'로 푼다).
    const launch = member.origin === "adopted" && !member.sessionId && !member.paneId ? { ...member, origin: "runner" as const } : member;
    const claimed = launch !== member;
    // 띄운 결과를 모르면 이 팀장 라벨의 터미널이 뒤늦게 나타날 수 있다. 그것은 서버가 띄운 것이라 명부도 서버 세션으로 맞춘다
    // (넘겨받은 채로 두면 재우기·닫기가 그 터미널을 끝내지 못한다).
    const claimIfUnknown = () => {
      if (claimed && this.store.getMember(member.id) && this.pendingLifecycle(member.id)?.intent === "start") this.store.patchMember(member.id, { origin: "runner" });
    };
    // 같은 세션을 이어 열었는가. 세션 기록이 없어 새 세션으로 열면 끊긴 턴의 맥락이 없다.
    let continued = !!member.sessionId;
    try {
      // core 는 터미널만 만들면 성공으로 답하므로, 없는 세션을 --resume 하면 오류 없이 CLI 가 곧바로 끝나고 끝없이 되풀이됐다.
      if (member.sessionId && runner.sessionExists?.(this.runnerMember(member, project)) === false) throw new MissingSessionError();
      const sent = this.desiredConfig(member);
      const started = await this.startManaged(launch, project, !!member.sessionId);
      if (await this.dropIfClosed(launch, project, runner, started)) return null;
      this.applyStarted(member.id, started, sent);
      // 넘겨받은 세션도 서버가 다시 띄우면 도구와 규칙을 갖고 뜬다. 이제 서버가 띄운 세션과 같다.
      // 대표가 칸에서 그 세션을 다시 열어 거기 붙었으면(rejoined) 도구가 없는 그대로다.
      // 세션 없이 서버가 띄운 자리(claimed)는 다시 붙은 터미널도 서버가 띄운 것이다(이 팀장의 소유 라벨로만 붙는다).
      if (member.origin === "adopted" && (claimed || !started.rejoined)) {
        this.store.patchMember(member.id, { origin: "runner" });
        this.store.enqueue({ projectId: project.id, memberId: member.id, kind: "system", text: formatSystem("이제 이 세션에 iamceo 도구(post·ask·status·file·todo)가 연결되었습니다. 앞서 받은 '도구가 없다'는 안내는 취소입니다. 보고와 질문은 도구로 하세요."), wake: false });
      }
    } catch (e) {
      const message = (e as Error).message;
      // 잠깐의 시간 초과·소켓 끊김으로 멀쩡한 세션을 버리면 직원이 맥락을 잃는다. 세션이 정말 없을 때만 새로 연다.
      const missing = e instanceof MissingSessionError || isMissingSessionError(message) || runner.sessionExists?.(this.runnerMember(member, project)) === false;
      if (!missing) {
        console.warn(`${member.name} 이어 열기 실패, 세션을 그대로 두고 다시 시도합니다:`, message);
        if (this.store.getMember(member.id)) this.store.patchMember(member.id, { lastError: message });
        claimIfUnknown();
        return null;
      }
      console.warn(`${member.name}의 이전 세션이 없어 새 세션을 엽니다:`, message);
      continued = false;
      try {
        const fresh = { ...launch, sessionId: null };
        const sent = this.desiredConfig(fresh);
        const started = await this.startManaged(fresh, project, false);
        if (await this.dropIfClosed(launch, project, runner, started)) return null;
        this.applyStarted(member.id, started, sent);
        this.store.patchMember(member.id, { contextPct: null, parallel: false, ...(member.origin === "adopted" ? { origin: "runner" as const } : {}) });
        this.store.enqueue({ projectId: project.id, memberId: member.id, kind: "system", text: this.newSessionNote(member), wake: false });
      } catch (e2) {
        // 새 세션을 띄운 결과를 모른다. 옛 세션 ID 를 그대로 두면 뒤늦게 뜬 새 터미널이 '다른 세션'으로 보여 재결합이 영영 막힌다.
        if (this.store.getMember(member.id) && member.sessionId && this.pendingLifecycle(member.id)?.intent === "start") {
          this.store.patchMember(member.id, { sessionId: null, contextPct: null, parallel: false });
          this.store.enqueue({ projectId: project.id, memberId: member.id, kind: "system", text: this.newSessionNote(member), wake: false });
        }
        if (this.store.getMember(member.id)) this.store.patchMember(member.id, { lastError: (e2 as Error).message });
        claimIfUnknown();
        return null;
      }
    }
    // 재시작으로 꺼졌던 팀장이면(누가 깨웠든) 표식을 닫는다. 턴 도중에 끊긴 실행이 있었으면 이어가기 글이 여기서 줄에 선다.
    this.settleRestartWake(member.id, continued ? "resumed" : "dropped");
    this.settle(this.store.requireMember(member.id));
    return this.store.requireMember(member.id);
  }

  /** 띄우는 사이 직원이 닫혔다. 띄운 칸을 남기면 명부 밖에서 계속 산다. */
  private async dropIfClosed(member: Member, project: Project, runner: Runner, started: { sessionId: string | null; paneId: string | null; rejoined?: boolean }): Promise<boolean> {
    if (this.store.getMember(member.id)) return false;
    // 방금 띄운 칸은 서버 칸이다. 대표의 칸에 다시 붙은 경우(rejoined)만 넘겨받은 칸으로 다룬다.
    const origin = member.origin === "adopted" && !started.rejoined ? "runner" : member.origin;
    await this.pumpWait(member.id, "drop_closed_session", () => runner.stop(this.runnerMember({ ...member, origin, sessionId: started.sessionId, paneId: started.paneId }, project)), runner).catch((e) => console.warn("닫힌 팀원의 칸을 닫지 못했습니다:", (e as Error).message));
    return true;
  }

  private newSessionNote(member: Member): string {
    const last = [member.now && `지금 일: ${normalizeSpace(member.now)}`, member.next && `다음: ${normalizeSpace(member.next)}`].filter(Boolean).join(" · ");
    return formatSystem(`이전 세션을 찾지 못해 새 세션으로 시작합니다. ${last ? `마지막 일 — ${last}` : "이전 기록은 없습니다."}`);
  }

  /** 세션을 끝내고 명부에서 뺀다. 대화·결재 기록은 남는다. 나가지 않고 사라진 입력의 요약을 돌려준다. */
  async closeMember(memberId: string): Promise<string[]> {
    const member = this.store.requireMember(memberId);
    if (this.archiving.has(member.projectId)) throw new ApiError(409, "프로젝트 보관을 처리하는 중입니다", "archive_busy");
    if (member.kind !== "worker") throw new ApiError(400, "총괄은 닫을 수 없습니다", "lead_close_refused");
    const rt = this.runtime(memberId);
    if (rt.closing || (this.backendOf(member) === "core" && (rt.starting || rt.reopening || rt.pumping))) throw new ApiError(409, "세션을 처리하는 중입니다", "session_busy");
    if (this.backendOf(member) !== "core") {
      const starting = this.pendingLifecycle(memberId);
      if (starting?.intent === "start") this.finishLifecycle(starting, "refused", "띄우는 동안 팀원이 닫혔습니다");
    }
    rt.closing = true;
    try {
      if (member.origin !== "manual") {
        // 넘겨받은 명부(origin adopted)의 세션은 서버가 띄운 것이 아니다. 닫아도 끝내지 않고 명부에서만 뺀다.
        // 지워진 옛 실행기(backend 가 core 가 아닌 값)의 세션도 같다. 다룰 실행기가 없어 끝낼 수 없으니('실행기가 없습니다' 503 이 났다) 명부에서만 뺀다.
        if (member.origin !== "adopted" && this.backendOf(member) === "core") await this.stopManaged(member, "close", true);
      }
      this.endExecution(member, "interrupted", "팀원을 닫아 실행을 종료했습니다");
      if (rt.turn) rt.turn.interrupted = true;
      if (member.origin !== "manual") this.store.patchMember(memberId, { status: "asleep" });
      this.confirmStop(memberId);
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
      this.settleRestartWake(memberId, "dropped");
      this.clearRuntime(memberId, rt);
      this.forgetMember(memberId);
      this.releaseSlots();
      // 대표가 체크한 '했음'은 받을 직원이 사라져도 잃으면 안 된다. 총괄에게 넘긴다.
      const conductor = this.store.getConductor(member.projectId);
      for (const todo of doneTodos) {
        if (conductor) await this.deliver({ projectId: member.projectId, memberId: conductor.id, kind: "todo_done", text: this.todoDoneText(todo, conductor), refType: "todo", refId: todo.id, wake: false });
        else this.store.setTodoNoticePending(todo.id, true);
      }
      return dropped;
    } finally { rt.closing = false; }
  }

  roster(projectId: string): RosterEntry[] {
    const { ranks, codexRanks } = this.store.getSettings();
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
      ...memberConfig(m, ranks, codexRanks),
      subagentModel: (m.cli === "codex" ? codexRanks : ranks).staff.model,
      subagentEffort: m.cli === "codex" ? null : ranks.staff.effort,
    }));
  }

  requireInProject(projectId: string, memberRef: string): Member {
    const member = this.store.findMember(projectId, memberRef);
    if (!member) throw new ApiError(404, `이 프로젝트에 없는 직원입니다: ${memberRef}`, "member_not_in_project");
    return member;
  }

  // ---- 보고 ----
  async recordPost(member: Member, input: PostInput): Promise<Message & { systemInstruction?: string }> {
    const rt = this.runtime(member.id);
    if (input.supersedes && input.correctsMessageId && input.supersedes !== input.correctsMessageId) throw new ApiError(400, "정정 대상이 서로 다릅니다", "correction_target_mismatch");
    input = { ...input, correctsMessageId: input.supersedes ?? input.correctsMessageId };
    const files = (input.fileIds ?? []).map((id) => {
      const file = this.store.getFile(id);
      if (!file || file.projectId !== member.projectId) throw new ApiError(404, `자료를 찾을 수 없습니다: ${id}`, "file_not_found");
      return file;
    });
    if (input.decisionId && this.store.getDecision(input.decisionId)?.projectId !== member.projectId) {
      throw new ApiError(404, `결재를 찾을 수 없습니다: ${input.decisionId}`, "decision_not_found");
    }
    // 거부된 호출은 보고가 아니다. 턴 마지막 글의 자동 보고를 막으면 안 된다.
    // v1 웹은 첫 자료와 본문 링크를 계속 사용한다. 전체 목록은 Message.fileIds에도 projection한다.
    const extra = files
      .slice(1)
      .map((f) => `[자료: ${f.title.replace(/[\[\]\\]/g, "\\$&")}](#/p/${encodeURIComponent(member.projectId)}/files/${encodeURIComponent(f.id)})`)
      .join("\n\n");
    if (input.correctsMessageId) {
      const previous = this.store.requireMessage(input.correctsMessageId);
      if (previous.projectId !== member.projectId || previous.memberId !== member.id || previous.mine) throw new ApiError(400, "자신이 작성한 보고만 정정할 수 있습니다", "report_not_own");
    }
    const conductor = member.kind === "worker" ? this.store.getConductor(member.projectId) : null;
    let systemInstruction: string | undefined;
    const { value: message, deliveries } = this.store.withDeliveryIntents(() => this.store.createMessage({
      projectId: member.projectId, memberId: member.id, who: member.name, kind: input.kind,
      title: rt.direct ? `(직접) ${input.title}` : input.title,
      body: [input.body ?? "", extra].filter(Boolean).join("\n\n"), decisionId: input.decisionId ?? null, fileId: files[0]?.id ?? null,
    }), message => {
      this.store.noteDelegationPost(member.id, `${message.title}\n${message.body}`);
      this.store.saveReportReferences(member.projectId, { sourceMessageId: message.id, fileIds: files.map(file => file.id), decisionIds: input.decisionId ? [input.decisionId] : [], authoredAt: message.at, sequence: this.store.boardRevision(member.projectId), correctsMessageId: input.correctsMessageId ?? null });
      if (this.missingApprovalCard(member, input)) {
        systemInstruction = formatSystem(APPROVAL_CARD_INSTRUCTION);
        // post 응답으로 한 번만 돌려준다. 업무 입력을 enqueue하거나 직원을 깨우지 않는다.
        this.store.appendActivity(member.id, "system", systemInstruction, `approval-card:${message.id}`);
      }
      return conductor && conductor.id !== member.id ? [{ projectId: member.projectId, memberId: conductor.id, kind: "report", text: this.reportText(message), wake: WAKE_POST_KINDS.has(input.kind), refType: "message", refId: message.id }] : [];
    });
    rt.posted = true;
    await Promise.all(deliveries.map(d => this.pump(d.memberId)));
    return { ...this.store.requireMessage(message.id), ...(systemInstruction ? { systemInstruction } : {}) };
  }

  private missingApprovalCard(member: Member, input: PostInput): boolean {
    const report = `${input.title}\n${input.body ?? ""}`;
    if (!needsApprovalCard(report) || this.runtime(member.id).turn?.askedDecisionIds?.size) return false;
    const group = input.group?.trim() || (input.decisionId ? this.store.getDecision(input.decisionId)?.group?.trim() : null);
    const normalizedReport = normalizeSpace(report);
    return !this.store.listOpenDecisions(member.projectId).some(decision =>
      decision.memberId === member.id
      || decision.id === input.decisionId
      || new RegExp(`(?<![\\w-])${decision.id}(?![\\w-])`).test(report)
      || (normalizeSpace(decision.title).length >= 2 && normalizedReport.includes(normalizeSpace(decision.title)))
      || (!!group && decision.group?.trim() === group));
  }

  reportReferences(projectId: string, messageId: string): ReportReferences {
    const message = this.store.requireMessage(messageId);
    if (message.projectId !== projectId || message.mine || !message.memberId) throw new ApiError(404, "보고를 찾을 수 없습니다", "report_not_found");
    return this.store.getReportReferences(projectId, messageId) ?? { sourceMessageId: message.id, fileIds: message.fileId ? [message.fileId] : [], decisionIds: message.decisionId ? [message.decisionId] : [], authoredAt: message.at, sequence: 0, correctsMessageId: null };
  }

  private reportText(message: Message): string {
    const refs = this.reportReferences(message.projectId, message.id);
    const direct = message.title.startsWith("(직접) ");
    return `${formatReport(message.who, direct ? `(직접) ${message.kind}` : message.kind, direct ? message.title.slice(5) : message.title, message.body)}\n보고 원본 #${refs.sourceMessageId} · 작성 ${refs.authoredAt} · 순번 ${refs.sequence}\n자료: ${refs.fileIds.join(", ") || "없음"} · 결재: ${refs.decisionIds.join(", ") || "없음"}${refs.correctsMessageId ? ` · 정정 대상 #${refs.correctsMessageId}` : ""}`;
  }

  private async reportToConductor(member: Member, kind: string, title: string, body: string, wake: boolean): Promise<void> {
    const conductor = this.store.getConductor(member.projectId);
    if (!conductor || conductor.id === member.id) return;
    await this.deliver({ projectId: member.projectId, memberId: conductor.id, kind: "report", text: formatReport(member.name, kind, title, body), wake });
  }

  /** ask. blocking 이면(manual) 호출자가 askWait 로 기다리고, 아니면 text 를 도구 결과로 돌려준다. */
  async registerAsk(member: Member, input: AskInput): Promise<{ decision: Decision; blocking: boolean; text: string }> {
    // 보관한 프로젝트의 카드는 화면에 없고 답도 409 다. 올리면 세션이 답 없는 대기에 묶인다.
    if (this.store.requireProject(member.projectId).archived || this.archiving.has(member.projectId)) throw new ApiError(409, "프로젝트가 보관되어 대표가 답할 수 없습니다. 묻지 말고 턴을 끝내세요", "ask_project_archived");
    const { value: decision, deliveries } = this.store.withDeliveryIntents(() => {
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
      this.store.patchMember(member.id, { status: "waiting" });
      return decision;
    }, decision => {
      const conductor = member.kind === "worker" ? this.store.getConductor(member.projectId) : null;
      return conductor ? [{ projectId: member.projectId, memberId: conductor.id, kind: "system",
        text: formatSystem(`${josa(member.name, "이")} 대표에게 질문했습니다: ${normalizeSpace(input.title)} #${decision.id}`), wake: false }] : [];
    });
    const rt = this.runtime(member.id);
    rt.posted = true;
    if (rt.turn) (rt.turn.askedDecisionIds ??= new Set()).add(decision.id);
    this.notifyInbox(`${member.name}의 결재`, input.title);
    await Promise.all(deliveries.map(d => this.pump(d.memberId)));
    if (member.origin === "manual") return { decision, blocking: true, text: `질문 #${decision.id} 등록됨. 답을 기다립니다` };
    return { decision, blocking: false, text: `질문 #${decision.id} 등록됨. 턴을 끝내세요. 답은 다음 입력으로 옵니다` };
  }

  // ---- 판 정리: 결재 닫기·할 일 정리 ----
  /**
   * ask_close. decided는 검증된 대표 글 또는 같은 안건에서 실제 답한 결재의 원문으로만 닫는다.
   * 짧은 버튼 글만으로는 닫지 않는다. 답한 결재 ID·안건 연결·실제 답을 함께 검증하고 감사 기록을 남긴다.
   * 닫으면 물은 직원에게 깨우지 않고 알리고, ask 를 기다리던 직접 띄운 CLI 는 풀어 준다.
   */
  async closeDecision(member: Member, request: { id: string; kind: "decided" | "obsolete"; reason: string; userQuote?: string; answeredDecisionId?: string; sameIssue?: string; followUp: DecisionCloseFollowUp }): Promise<Decision> {
    if (this.store.requireDecision(request.id).kind === "usage_limit") throw new ApiError(403, "사용 한도 알림은 대표만 닫을 수 있습니다", "usage_notice_owner_only");
    // K(E2): 도구 승인 카드는 대표만 답한다. AI 가 닫으면 대표가 볼 승인 요청이 사라진다.
    if (this.store.requireDecision(request.id).kind === "tool_permission") throw new ApiError(403, "도구 승인 요청은 대표만 답할 수 있습니다", "tool_permission_owner_only");
    return this.closeAsk(member, request);
  }

  async closeAsk(member: Member, input: { id: string; kind: DecisionCloseKind; reason: string; userQuote?: string; answeredDecisionId?: string; sameIssue?: string; followUp?: DecisionCloseFollowUp }): Promise<Decision> {
    const decision = this.store.getDecision(input.id);
    if (!decision || decision.projectId !== member.projectId) throw new ApiError(404, `결재를 찾을 수 없습니다: ${input.id}`, "decision_not_found");
    if (member.kind === "worker" && decision.memberId !== member.id) throw new ApiError(403, "직원은 자기가 올린 결재만 닫을 수 있습니다", "decision_not_own");
    if (decision.status !== "open") throw new ApiError(409, decision.status === "closed" ? "이미 닫힌 결재입니다" : "대표가 이미 답한 결재입니다. 닫지 않습니다", "decision_closed");
    const reason = normalizeSpace(input.reason);
    let quote: string | null = null;
    let sourceId: string | null = null;
    let answered: Decision | null = null;
    if (input.answeredDecisionId) {
      if (input.kind !== "decided") throw new ApiError(400, "answered_decision_id는 decided에만 쓸 수 있습니다", "decision_close_invalid");
      answered = this.store.requireDecision(input.answeredDecisionId);
      if (answered.projectId !== member.projectId || !["answered", "delivered"].includes(answered.status) || !answered.answeredAt) throw new ApiError(409, "같은 프로젝트에서 대표가 실제로 답한 결재만 근거로 쓸 수 있습니다", "decision_close_evidence_invalid");
      if (!(decision.group?.trim() && decision.group === answered.group) && (member.kind === "worker" || !input.sameIssue?.trim())) throw new ApiError(409, "같은 그룹이거나 총괄이 same_issue에 같은 안건인 이유를 명시해야 합니다", "decision_close_group_mismatch");
      quote = formatAnswer(answered);
    } else if (input.kind === "decided") {
      const raw = input.userQuote?.trim();
      if (!raw) throw new ApiError(400, "decided 로 닫으려면 user_quote 에 대표가 정한 말을 글자 그대로 실어야 합니다. 대표가 아직 정하지 않았으면 닫지 마세요", "decision_close_quote_required");
      const source = this.findQuoteSource(member.projectId, raw);
      if (!source) throw new ApiError(409, "인용을 대표 글에서 찾지 못해 닫지 않았습니다. 대표가 정하지 않았으면 그대로 두세요", "decision_close_quote_not_found");
      if (quoteNeedsContext({ text: raw, verified: true, source })) throw new ApiError(409, "버튼 글이나 아주 짧은 글은 이 결재를 정했다는 근거가 못 되어 닫지 않았습니다. 대표가 이 일을 정한 문장을 인용하세요", "decision_close_quote_weak");
      quote = normalizeSpace(raw);
      sourceId = source.id;
    }
    const followUp = input.followUp;
    if (followUp?.kind === "instruction") {
      const target = this.store.requireMember(followUp.memberId);
      if (target.projectId !== member.projectId || !followUp.text.trim()) throw new ApiError(400, "후속 지시의 대상·내용을 확인하세요", "follow_up_invalid");
      if ("sourceDecisionId" in followUp) {
        if (!answered || followUp.sourceDecisionId !== answered.id) throw new ApiError(409, "후속 지시의 대표 답이 닫기 근거와 다릅니다", "follow_up_mismatch");
      } else {
        const source = this.store.requireMessage(followUp.sourceMessageId);
        if (answered || source.projectId !== member.projectId || !source.mine) throw new ApiError(400, "후속 지시의 대표 원문을 확인하세요", "follow_up_invalid");
        if (input.kind === "decided" && source.id !== sourceId) throw new ApiError(409, "후속 지시의 대표 원문이 닫기 근거와 다릅니다", "follow_up_mismatch");
        this.refuseOwnerDirectRepeat(target, { text: input.userQuote ?? source.body, verified: true,
          source: { id: source.id, text: source.body, at: source.at } });
      }
    }
    const closed = this.store.transaction(() => {
      const closed = this.store.closeDecision(decision.id, { kind: input.kind, reason, by: member.name, quote });
      if (answered) {
        this.store.auditDecisionClose(decision.id, answered.id, member.id, input.sameIssue?.trim() ?? null, quote!);
        this.store.appendActivity(member.id, "system", `결재 #${decision.id}를 대표 답 #${answered.id}에 따라 닫았습니다${input.sameIssue ? `: ${input.sameIssue}` : " (같은 그룹)"}`, `decision-close:${decision.id}:${decision.updatedAt}`);
        const target = decision.memberId ? this.store.getMember(decision.memberId) : null;
        if (target) this.store.enqueue({ projectId: decision.projectId, memberId: target.id, kind: "system", text: formatSystem(`같은 안건의 결재 #${decision.id}는 대표가 답한 결재 #${answered.id}에 따라 닫혔습니다. 대표 답 원문:\n${quote}`), wake: false });
      }
      if (followUp) {
        this.store.setDecisionFollowUp(decision.id, followUp);
        if (followUp.kind === "instruction") {
          const source = "sourceMessageId" in followUp ? this.store.requireMessage(followUp.sourceMessageId) : null;
          const original = source ? { id: source.id, text: source.body, at: source.at } : { id: answered!.id, text: quote!, at: answered!.answeredAt! };
          const delivery = this.store.enqueue({ projectId: member.projectId, memberId: followUp.memberId, kind: "instruction", text: formatInstruction(member.name, `${followUp.text}\n결재 #${decision.id} 닫기의 후속 지시`, { text: source ? input.userQuote ?? source.body : quote!, verified: true, source: original }) });
          this.store.noteDelegation(member.id, delivery, this.isBusy(this.store.requireMember(followUp.memberId)));
          this.store.afterCommit(() => { void this.pump(followUp.memberId); });
        }
      }
      return closed;
    });
    const why = `${reason}${sourceId ? ` (대표가 이미 정함, 대표 글 #${sourceId})` : answered ? ` (대표 답 #${answered.id})` : ""}`;
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    if (asker?.origin === "manual") this.wakeAll(this.askWaiters, decision.id);
    if (asker && asker.id !== member.id && asker.origin !== "manual" && !answered) {
      await this.deliver({ projectId: decision.projectId, memberId: asker.id, kind: "system", text: formatSystem(`결재 #${decision.id} 가 닫혔습니다: ${why}. 질문 '${quotedInline(decision.title)}' 의 답은 오지 않습니다`), wake: false });
    }
    if (asker && asker.origin !== "manual") this.refreshWaiting(asker.id);
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
    if (!todo || todo.projectId !== member.projectId) throw new ApiError(404, `할 일을 찾을 수 없습니다: ${input.id}`, "todo_not_found");
    if (member.kind === "worker" && todo.memberId !== member.id) throw new ApiError(403, "직원은 자기가 부탁한 할 일만 정리할 수 있습니다", "todo_not_own");
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
    if (decision.status !== "closed" || !decision.closeKind) throw new ApiError(409, "AI가 닫은 결재만 다시 열 수 있습니다", "decision_reopen_refused");
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
    if (!this.notifier || (!this.store.getSettings().notifyMac || this.store.getSettings().macScriptNotifications === false)) return;
    this.notifier(`IAMCEO · ${normalizeSpace(title).slice(0, 60)}`, normalizeSpace(body).slice(0, 200));
  }

  /**
   * 운영 안내(예: Tailscale 꺼짐). 결재 알림(notifyMac)을 꺼 두었어도 띄운다. 스크립트 알림 자체를 끈 설치
   * (macScriptNotifications=false: Mac 앱이 알림을 직접 맡는다)에서는 띄우지 않고 false 를 돌려준다.
   */
  notifyOperations(title: string, body: string): boolean {
    if (!this.notifier || this.store.getSettings().macScriptNotifications === false) return false;
    this.notifier(normalizeSpace(title).slice(0, 60), normalizeSpace(body).slice(0, 200));
    return true;
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

  private materializeManualAnswers(member: Member): void {
    if (this.store.requireProject(member.projectId).archived || this.archiving.has(member.projectId)) return;
    this.store.transaction(() => {
      for (const decision of this.store.listUnreceivedAnswers(member.id)) {
        if (!this.store.listDeliveries(member.projectId).some(d => d.refType === "decision" && d.refId === decision.id && d.memberId === member.id)) this.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "answer", text: formatAnswer(decision), refType: "decision", refId: decision.id });
      }
    });
  }

  async manualInbox(memberId: string, timeoutMs: number, signal?: AbortSignal): Promise<ManualInboxBatch | null> {
    const take = () => {
      const member = this.store.requireMember(memberId);
      if (member.origin !== "manual") throw new ApiError(409, "직접 띄운 직원만 수신함을 사용할 수 있습니다", "manual_inbox_only");
      if (signal?.aborted || this.store.requireProject(member.projectId).archived || this.archiving.has(member.projectId)) return null;
      this.materializeManualAnswers(member);
      return this.store.manualInbox(memberId);
    };
    if (signal?.aborted) return null;
    const first = take();
    if (first) return first;
    await this.waitOn(this.inboxWaiters, memberId, Math.min(Math.max(timeoutMs, 0), 50_000), signal);
    return take();
  }

  async acknowledgeManualInbox(memberId: string, request: ManualInboxAckRequest): Promise<ManualInboxAckResult> {
    const member = this.store.requireMember(memberId);
    this.requireActive(this.store.requireProject(member.projectId));
    if (member.origin !== "manual") throw new ApiError(409, "직접 띄운 직원만 수신함을 사용할 수 있습니다", "manual_inbox_only");
    const result = this.store.acknowledgeManualInbox(memberId, request.batchId);
    this.reconcileTodoCorrections();
    for (const item of this.store.getManualInboxBatch(memberId, request.batchId)!.items) if (item.ref?.type === "decision") this.wakeAll(this.askWaiters, item.ref.id);
    return result;
  }

  /** v1 compatibility: delivery and ACK are inseparable in the old string response. */
  private takeInbox(member: Member): string | null {
    if (this.store.requireProject(member.projectId).archived || this.archiving.has(member.projectId)) return null;
    this.materializeManualAnswers(member);
    const batch = this.store.manualInbox(member.id);
    if (!batch) return null;
    this.store.acknowledgeManualInbox(member.id, batch.id);
    this.reconcileTodoCorrections();
    return batch.items.map(item => item.text).join("\n\n");
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
    rt.pumpSince = Date.now(); rt.pumpStage = "start"; rt.pumpReported = false;
    rt.pumping = (async () => {
      try {
        do {
          rt.again = false;
          await this.pumpOnce(memberId);
        } while (rt.again && !this.closed);
      } catch (e) {
        // 정리 중의 오류가 다시 새면 rt.pumping 이 거부되고, 호출부 대부분은 void 라 프로세스가 끝난다.
        try { this.pumpFailed(memberId, rt, e); }
        catch (cleanup) { console.error("전달 펌프 오류 정리 실패:", memberId, cleanup); }
        console.error("전달 펌프 오류:", memberId, e);
      } finally {
        rt.pumping = null; rt.pumpStage = null; rt.pumpSince = null;
      }
    })();
    return rt.pumping;
  }

  /**
   * 이유 없이(또는 실제와 어긋난 이유로) 멈춘 전달을 알리기 전에 한 번 스스로 다시 민다. 입력은 하지 않는다:
   * '아직 못 받음'으로 미룬 재시도 간격을 풀고(한도·인증 간격은 그대로) 펌프를 돌릴 뿐이다.
   * 실행 기록도 없이 남은 턴 표시는, CLI 가 쉬는 중으로 관측될 때에만 지운다.
   */
  private nudgeStalled(memberId: string): void {
    const member = this.store.getMember(memberId);
    if (!member || this.closed || this.recovering) return;
    const rt = this.runtime(memberId), runner = this.runners.get(this.backendOf(member));
    const observed = runner instanceof CoreRunner ? runner.observationState(memberId) : null;
    if (rt.turn?.kind === "work" && !rt.pumping && !rt.starting && !rt.reopening && !this.eventQueues.has(memberId) && observed?.failures === 0 && ["idle", "done"].includes(observed.state ?? "") &&
      !runner!.isBusy(memberId) && !this.store.listPendingExecutions().some(run => run.memberId === memberId)) {
      rt.turn = null;
      this.store.appendActivity(memberId, "system", "끝난 턴의 표시가 남아 전달이 멈춰 있었습니다. 표시를 지우고 다시 보냅니다");
      if (member.status === "working") this.settle(member);
      this.releaseSlots();
    }
    void this.recheckMemberDelivery(memberId, true, true);
  }

  private pumpFailed(memberId: string, rt: Runtime, error: unknown): void {
    const turn = rt.turn;
    if (turn && !this.store.listPendingExecutions().some(run => run.memberId === memberId)) rt.turn = null;
    this.releaseSlots();
    if (!this.store.getMember(memberId)) return;
    // 실행기와 통신하다 난 오류만 '실행기에 연결할 수 없음'이다. 그 밖의 내부 오류에 그 사유를 붙이면 대표가 멀쩡한 실행기를 의심한다.
    if (error instanceof CoreError) {
      for (const delivery of this.store.listPending(memberId)) {
        if (delivery.attempts === 0 && this.store.getDeliveryRecovery(delivery.id)?.phase === "none") this.hold(delivery, "backend_down");
      }
      this.judged(memberId, "runner_off");
      return;
    }
    const detail = `전달 처리 오류: ${((error as Error)?.message ?? String(error)).slice(0, 300)}`;
    if (this.store.requireMember(memberId).lastError !== detail) this.store.patchMember(memberId, { lastError: detail });
    this.judged(memberId, "pump_error");
  }

  /**
   * E3: 펌프의 판정을 남긴다. 화면의 대기 사유는 이것만 읽는다(store.rawDeliveryWait). 값이 바뀔 때만 적히고, 바뀌면 앱에 알린다.
   * 판정을 적다 실패해도 전달은 이어 간다.
   */
  private judged(memberId: string, code: PumpVerdictCode, runLimit?: { used: number; limit: number }): void {
    try { this.store.recordPumpVerdict(memberId, runLimit ? { code, runLimit } : { code }); }
    catch (e) { console.warn("전달 판정 기록 실패:", memberId, code, (e as Error).message); }
  }

  /** 일하는 중이라는 판정에 CLI 관측이 맞는가. 쉬는 중으로 관측되면(관측 실패 없이) 확인되지 않은 일하는 중이다: 기한을 넘기면 이유 없는 대기로 다룬다. */
  private busyVerdict(member: Member, confirmed: PumpVerdictCode): PumpVerdictCode {
    // 관측을 주는 실행기(core)만 본다. 관측이 없으면 일하는 중을 그대로 믿는다.
    const runner = this.runners.get(this.backendOf(member)) as Partial<Pick<CoreRunner, "observationState">> | undefined;
    const observed = typeof runner?.observationState === "function" ? runner.observationState(member.id) : null;
    return observed && observed.failures === 0 && ["idle", "done"].includes(observed.state ?? "") ? "busy_unconfirmed" : confirmed;
  }

  /** readyOnly: CLI 가 입력을 받을 수 있게 됐다는 신호로 부른다. '아직 못 받음' 때문에 미룬 것만 풀고 한도·인증 간격은 그대로 둔다. */
  private recheckMemberDelivery(memberId: string, pump = true, readyOnly = false): Promise<void> {
    const rt = this.runtime(memberId);
    rt.holdUntil = 0;
    for (const d of this.store.listPending(memberId)) {
      const r = this.store.getDeliveryRecovery(d.id);
      if (readyOnly && ["processing_quota", "processing_auth"].includes(this.store.getDeliveryRetry(d.id).retryReason ?? "")) continue;
      if (["none", "resolved"].includes(r?.phase ?? "none") || r?.phase === "waiting" && r.reason === "input_busy") this.store.patchDeliveryRetry(d.id, { nextAttemptAt: null });
    }
    return pump ? this.pump(memberId) : Promise.resolve();
  }

  notifyDelayedDeliveries(now = Date.now()): void {
    this.store.transaction(() => {
      for (const d of this.store.claimDelayedDeliveries(now)) {
        const member = this.store.requireMember(d.memberId);
        const text = `${member.name}에게 보낸 대표 ${josa(d.kind === "answer" ? "결재 답" : "메시지", "이")} 30분 넘게 전달되지 않았습니다. 전달 #${d.id}를 확인해 주세요.`;
        // Existing report_blocked path persists one APNs event with the domain message.
        this.store.createMessage({ projectId: d.projectId, memberId: member.id, who: "시스템", kind: "막힘", title: "대표 전달 지연", body: text });
        const conductor = this.store.getConductor(d.projectId);
        if (conductor) this.store.enqueue({ projectId: d.projectId, memberId: conductor.id, kind: "system", text: formatSystem(text), wake: false });
        this.store.afterCommit(() => { if (conductor) void this.pump(conductor.id); this.notifyInbox("대표 전달 지연", text); });
      }
    });
  }

  private sendablePending(memberId: string): Delivery[] {
    const pending = this.apiRecovery.prioritize(memberId, this.store.listSendablePending(memberId));
    // 재시작으로 끊긴 일의 이어가기 글은 기다리던 다른 전달보다 먼저, 혼자 나간다(끊긴 일을 정리한 뒤 새 일).
    const wake = this.store.getRestartWake(memberId);
    if (!wake?.resumeId) return pending;
    const resume = pending.find(d => d.id === wake.resumeId);
    if (resume) return [resume];
    if (wake.state === "resumed" && !["queued", "held", "delivering"].includes(this.store.getDelivery(wake.resumeId)?.status ?? "")) this.store.setRestartWake(memberId, null);
    return pending;
  }

  /**
   * 직원 한 명의 대기열을 한 번 민다. return 마다 그 까닭을 판정으로 남긴다(judged, E3): 화면의 대기 사유는 그 판정만 읽는다.
   * 오래 걸리는 단계(다시 열기·새로 띄우기·설정 적용·보내기)는 들어갈 때 판정을 남긴다. 그동안 화면이 앞 판정을 보여 주지 않게.
   */
  private async pumpOnce(memberId: string): Promise<void> {
    let member = this.store.getMember(memberId);
    if (!member) return;
    if (member.origin === "manual") {
      const pending = this.store.listPending(memberId);
      if (pending.some((d) => d.wake) || this.store.listUnreceivedAnswers(memberId).length > 0) {
        this.wakeAll(this.inboxWaiters, memberId);
      }
      // 서버가 넣어 줄 수 없는 세션이다. 왜 안 가는지 화면에 보여 준다.
      for (const d of this.store.listPending(memberId)) {
        if (d.refType === "message" && d.refId && !this.store.getMessage(d.refId)?.deliveryNote) {
          this.store.setMessageDelivery(d.refId, "queued", `${member.name}이 wait 를 부르면 전달됩니다`);
        }
      }
      return this.judged(memberId, ["working", "waiting"].includes(this.store.requireMember(memberId).status) ? "manual_busy" : "manual_idle");
    }
    const project = this.store.requireProject(member.projectId);
    let outageHold = this.apiRecovery.holdReason(memberId);
    // 이어가기를 포기해 멈춰 둔 직원에게 대표가 새로 말을 걸었다. 장애가 끝난 뒤라면 그 말은 보낸다.
    if (outageHold === "api_outage" && this.apiRecovery.releaseForOwnerInput(memberId, this.store.listPending(memberId))) outageHold = this.apiRecovery.holdReason(memberId);
    if (outageHold) { for (const d of this.store.listPending(memberId)) this.hold(d, outageHold); return this.judged(memberId, outageHold); }
    let pending = this.store.listPending(memberId);
    if (member.backend && member.backend !== "core" && (member.sessionId || member.paneId)) {
      for (const d of pending) this.hold(d, "legacy_session");
      return this.judged(memberId, "legacy_session");
    }
    // Previously attempted entries must be inspected, including legacy held rows.
    for (const d of pending) if (d.attempts > 0 && !this.deliveryRecovery.requeueRejected(d.id) && this.store.getDeliveryRecovery(d.id)?.phase === "none") this.deliveryRecovery.beginRecovery(d.id);
    pending = this.sendablePending(memberId);
    if (this.recovering || this.configWrites.has(memberId) || this.terminalMutations.has(memberId) || this.pendingLifecycle(memberId)) return this.judged(memberId, "session_busy");
    if (this.store.inputState(memberId).lease) { this.deferCoreCompact(member, "manual_control"); return this.judged(memberId, "manual_control"); }
    // Expiry/replacement can be discovered by the runner/store before the socket timer.
    // Fence every delivery until old control attaches have detached and restored core.
    if (member.backend === "core" && this.terminalLeaseListeners.size) {
      await this.pumpWait(memberId, "lease_cleanup", () => Promise.all([...this.terminalLeaseListeners].map(ended => ended(memberId, null))));
    }
    if (this.store.inputState(memberId).lease) return this.judged(memberId, "manual_control");
    if (this.terminalMutations.has(memberId)) return this.judged(memberId, "session_busy");
    if (member.backend === "core" && member.statusObservation && member.statusObservation.ownership !== "verified" && !(member.status === "offline" && member.statusObservation.error?.code === "no_owned_terminal")) return this.judged(memberId, "ownership_unverified");
    const openRuns = member.backend === "core" ? this.store.listPendingExecutions().filter(run => run.memberId === memberId && run.identity.sessionGeneration === this.store.memberRevisions(memberId).sessionGeneration) : [];
    // 끝나지 않은 실행 기록이 남았다. 받았는지 모르는 봉투(넣는 중·결과 모름)면 수신 확인 중이고, 받은 뒤면 일하는 중이다.
    if (openRuns.length && !this.runtime(memberId).turn) return this.judged(memberId, openRuns.some(run => run.phase === "starting" || run.phase === "unknown") ? "receipt_check" : this.busyVerdict(member, "pending_run"));
    if (this.controlFenced(member)) return this.judged(memberId, "control_unknown");
    if (this.deliveryRecovery.fenced(memberId)) return this.judged(memberId, "receipt_check");
    const rt = this.runtime(memberId);
    // 설정을 바꿔 다시 여는 데 실패한 직원. 세션이 살아 있으면(멈추지 못했거나 재결합으로 돌아왔으면) 옛 설정으로 계속 일하고
    // 설정은 다음 기동 때 맞춘다. 꺼져 있으면 곧바로 다시 열기를 되풀이하지 않고 간격을 두되, 영영 막지는 않는다.
    const deferred = this.store.deferredMemberConfig(memberId);
    const configFailed = !!deferred?.failed && deferred.signature === JSON.stringify(this.desiredConfig(member));
    if (configFailed && (member.status === "offline" || member.status === "asleep")) {
      const retryAt = (Date.parse(deferred!.failedAt ?? "") || 0) + this.timings.configRetryMs * ((deferred!.attempts ?? 1) > 1 ? 5 : 1);
      if (Date.now() < retryAt) {
        for (const d of pending) if (!(d.status === "held" && d.holdReason === "asleep")) {
          if (!(d.status === "held" && d.holdReason === "offline")) this.store.markHeld(d.id, "offline");
          if (d.refType === "message" && d.refId) this.store.setMessageDelivery(d.refId, "held", REOPEN_RETRY_NOTE);
        }
        if (pending.some(d => d.wake)) this.scheduleRetry(memberId, rt, retryAt);
        return this.judged(memberId, "retry_wait");
      }
    }
    this.reconcileCoreCompact(member);
    if (this.coreCompactFenced(member)) return this.judged(memberId, "compacting");
    if (rt.closing) return this.judged(memberId, "session_busy"); // 닫는 중에 다시 열면 명부 밖 칸이 남는다.
    if (this.settingsWriting) return this.judged(memberId, "session_busy"); // 설정 적용이 끝나면 다시 민다.
    if (rt.starting) return this.judged(memberId, "waking"); // 다 뜨면 다시 민다.
    const due = this.retryDue(member);
    if (Date.now() < Math.max(rt.holdUntil, due)) {
      this.scheduleRetry(memberId, rt, Math.max(rt.holdUntil, due));
      return this.judged(memberId, "retry_wait");
    }

    // 보관 중에는 아무도 깨우지 않는다. 꺼낼 때 onProjectPatched 가 다시 민다.
    if (project.archived || this.archiving.has(project.id)) {
      for (const d of pending) if (d.status === "queued") this.hold(d, "archived");
      return this.judged(memberId, "archived");
    }
    if (!project.runnerEnabled) {
      for (const d of pending) this.hold(d, "runner_disabled");
      return this.judged(memberId, "runner_off");
    }
    // 세션이 없거나 잠들었으면 새로 연다: 전역 실행 방식을 따른다. 살아 있는 세션은 시작한 실행기로 계속 다룬다.
    const opening = member.status === "asleep" || member.status === "offline" || (!member.sessionId && !member.paneId);
    let runner = this.runners.get(opening ? this.store.effectiveBackend() : this.backendOf(member));
    if (!runner) {
      for (const d of pending) this.hold(d, "backend_down");
      return this.judged(memberId, "runner_off");
    }

    let opened = false;
    if (member.status === "asleep" || member.status === "offline") {
      // 잠들 때 보류된 것만 있으면 깨우지 않는다. 새 깨움이 와야 함께 나간다.
      const wakes = pending.some((d) => d.wake && !(d.status === "held" && d.holdReason === "asleep"));
      if (!wakes) return this.judged(memberId, "asleep_hold");
      if (this.quickExitHeld(member, rt, pending)) return this.judged(memberId, "retry_wait");
      rt.pumpStage = "reopen";
      this.judged(memberId, "waking");
      const reopened = await this.reopen(member);
      if (!reopened) {
        // 실패한 설정으로 다시 여는 것이 또 실패했다. 다음 시도는 더 멀리 둔다.
        if (configFailed && this.store.getMember(memberId)) this.store.deferMemberConfig(memberId, deferred!.signature, true);
        for (const d of pending) this.hold(d, member.status === "offline" ? "offline" : "backend_down");
        return this.judged(memberId, member.status === "offline" ? "reopen_failed" : "runner_off");
      }
      member = reopened;
      runner = this.runnerOf(member);
      this.checkAwakeLimit(member.projectId);
      opened = true;
    }

    // 턴 도중 승인 창에 걸려도 보류로 보여 준다. isBusy 보다 먼저 본다(§6).
    if (member.status === "blocked") {
      this.deferCoreCompact(member, "blocked");
      for (const d of pending) this.hold(d, "blocked");
      return this.judged(memberId, "approval");
    }
    if (this.isBusy(member)) {
      this.deferCoreCompact(member, "working");
      const urgent = pending.filter((d) => d.urgent);
      // 일하는 중이라는 판정은 긴급을 넣기 전에 남긴다(넣는 동안 화면이 앞 판정을 보여 주지 않게).
      this.judged(memberId, this.busyVerdict(member, "busy"));
      // core 는 돌고 있는 턴에 끼워 넣을 수 없다(interjects=false). 끝나면 묶어서 나간다.
      if (urgent.length > 0 && this.interjects(runner)) { rt.pumpStage = "send_urgent"; await this.sendUrgent(member, project, runner, urgent); }
      return;
    }

    // 쉬는 동안 바뀐 설정을 먼저 맞춘다. 일을 넣고 나면 턴이 끝날 때까지 못 맞춘다.
    if (runner.applyConfig && this.configPending(member)) {
      rt.pumpStage = "sync_config";
      this.judged(memberId, "session_busy");
      if (!(await this.syncConfig(member, rt))) return this.judged(memberId, rt.holdUntil > Date.now() ? "retry_wait" : "config_failed");
      member = this.store.requireMember(memberId);
    }

    const hasWake = pending.some((d) => d.wake);
    if (!hasWake && rt.compactRequest === null) {
      for (const d of pending) if (d.status === "held") this.requeue(d);
      return this.judged(memberId, "no_wake");
    }

    // 상한 검사와 자리 잡기(rt.turn) 사이에 await 가 끼면 상한을 넘을 수 있어 세션부터 마련한다.
    if (!member.sessionId && !member.paneId) {
      let failure: Error | null = null;
      const current = member;
      runner = this.openRunner(current);
      const started = (async () => {
        try {
          const sent = this.desiredConfig(current);
          const result = await this.startManaged(current, project, false);
          this.applyStarted(current.id, result, sent);
        } catch (e) {
          failure = e as Error;
        } finally {
          rt.starting = null;
        }
      })();
      rt.starting = started;
      rt.pumpStage = "start_session";
      this.judged(memberId, "waking");
      await started;
      if (failure) {
        this.store.patchMember(member.id, { lastError: (failure as Error).message });
        for (const d of pending) this.hold(d, "backend_down");
        return this.judged(memberId, "runner_off");
      }
      member = this.store.requireMember(member.id);
      opened = true;
    }

    // 아직 준비를 보고하지 않은 core CLI(방금 띄웠거나 상태 보고 전)는 입력을 받지 못한다. 지금 넣으면 거절 기록만 쌓여
    // 그 직원의 대기열이 통째로 미뤄진다. 준비 신호(idle)가 다시 밀고, 안 오면 조금 뒤 다시 본다.
    const observedState = runner instanceof CoreRunner ? runner.observationState(member.id)?.state : undefined;
    if (runner instanceof CoreRunner && (opened || observedState !== undefined) && !["idle", "done", "error"].includes(observedState ?? "")) {
      rt.pumpStage = "await_ready";
      // 끝내 준비를 보고하지 않는 CLI(로그인 요구, 이어 열기 선택 창 등)는 사유 없이 대기로만 남았다. 오래 이어지면 막힘으로 드러낸다(준비 신호가 오면 풀린다).
      if (opened || rt.readySince === null) rt.readySince = Date.now();
      if (Date.now() - rt.readySince >= this.timings.inputBusyLimitMs) {
        rt.readySince = null;
        // 한 번도 준비를 알리지 않은 CLI 다. 승인 창이라고 단정하지 않고 '시작이 늦어짐'으로 알린다.
        this.markBlocked(member, runner.observationState(member.id)?.turn ? undefined : "start_not_ready");
        for (const d of pending) this.hold(d, "blocked");
        return this.judged(memberId, "approval");
      }
      this.scheduleRetry(memberId, rt, Date.now() + this.timings.retryMs);
      return this.judged(memberId, "waking");
    }
    rt.readySince = null;

    const used = this.activeAutomaticTurns(), limit = this.store.getSettings().maxConcurrentTurns;
    if (used >= limit) {
      this.waiting.add(memberId);
      for (const d of pending) if (d.status === "held") this.requeue(d);
      return this.judged(memberId, "run_limit", { used, limit });
    }

    const compactAt = this.store.getSettings().compactAtPct;
    const state = this.store.getContextState(memberId);
    const measurement = state?.measurement;
    const exact = measurement?.fresh && measurement.quality === "exact" && measurement.sessionId === member.sessionId &&
      measurement.sessionGeneration === this.store.memberRevisions(memberId).sessionGeneration && measurement.turn !== null &&
      state?.baseline?.completedTurn === measurement.turn && state.baseline.autoTurn !== measurement.turn &&
      state.baseline.configRevision === this.store.memberRevisions(memberId).configRevision;
    const autoCompact = hasWake && !rt.skipCompact && member.contextPct !== null && member.contextPct >= compactAt && !!exact;
    if (autoCompact) this.queueCoreCompact(member, "auto", this.compactFocus(member));
    if (rt.compactRequest !== null || autoCompact) {
      rt.pumpStage = "compact";
      this.judged(memberId, "compacting");
      await this.beginCompact(member, project, runner, rt, rt.compactRequest ?? this.compactFocus(member));
      return;
    }
    if (!hasWake) return this.judged(memberId, "no_wake");

    const turn: Turn = { kind: "work", text: "", interrupted: false };
    rt.turn = turn;
    if (rt.wantParallel !== null) {
      rt.pumpStage = "parallel";
      const go = await this.applyParallel(member, project, runner, rt, this.store.listPending(memberId));
      if (!go || this.store.requireMember(memberId).status === "asleep") {
        rt.turn = null;
        this.releaseSlots();
        // 병렬 설정을 바꾸지 못해 일을 미뤘다. 미룬 까닭(잠듦·승인 창·결과 모름·장애·재시도 시각)을 그대로 남긴다.
        const after = this.store.requireMember(memberId), hold = this.apiRecovery.holdReason(memberId);
        return this.judged(memberId, after.status === "asleep" ? "asleep_hold" : after.status === "blocked" ? "approval" : this.controlFenced(after) ? "control_unknown"
          : hold ?? (Math.max(rt.holdUntil, this.retryDue(after)) > Date.now() ? "retry_wait" : "parallel_failed"));
      }
    }

    const fresh = this.dropChangedSources(this.sendablePending(memberId));
    if (!fresh.some(d => d.wake) || this.retryDue(member) > Date.now()) {
      rt.turn = null;
      this.releaseSlots();
      return this.judged(memberId, fresh.some(d => d.wake) ? "retry_wait" : "no_wake");
    }
    const ordered = this.apiRecovery.preservesOrder(memberId) ? fresh : orderForBundle(fresh);
    turn.text = ordered.map((d) => d.text).join("\n\n");
    rt.posted = false;
    rt.delegated = false;
    if (ordered.some(isTidy)) {
      const review = this.store.getBoardReview(project.id) ?? this.store.requestBoardReview(project.id);
      turn.boardReview = { requestedRevision: review.requestedRevision, reviewedRevision: null };
    }
    // 대표가 이 팀장을 골라 보낸 글이 있는가. 전달 글의 '[대표 직접]' 표지(사람과 AI가 읽는 글)가 아니라 원본 메시지의 받는 사람으로 가른다.
    rt.direct = ordered.some((d) => d.kind === "user_message" && d.refType === "message" && !!d.refId && this.store.getMessage(d.refId)?.targetMemberId === d.memberId);
    turn.deliveries = ordered;
    const current = this.store.requireMember(memberId);
    let result: SendResult;
    rt.pumpStage = "send";
    this.judged(memberId, "sending");
    try { result = await this.sendEnvelope(current, project, runner, ordered, false); }
    catch (error) {
      if (rt.turn === turn) rt.turn = null;
      this.releaseSlots();
      throw error;
    }
    if (!result.ok) {
      if (rt.turn === turn) rt.turn = null;
      // 넣었는지 모르는 결과는 전달 확인이 맡는다(수신 확인 중).
      const failed: PumpVerdictCode = ["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown") ? this.onSendFailed(member, rt, ordered, result) : "receipt_check";
      this.releaseSlots();
      return this.judged(memberId, failed);
    }
    this.judged(memberId, "sent");
    rt.inputBusySince = null;
    this.store.appendActivity(memberId, "turn_start", normalizeSpace(turn.text).slice(0, 300));
    // 아주 빠른 턴은 send 가 돌아오기 전에 끝날 수 있다. 그때는 이미 정리되어 있다.
    if (rt.turn === turn && this.store.requireMember(memberId).status !== "asleep") this.store.patchMember(memberId, { status: "working", lastError: null, ...(this.store.requireMember(memberId).statusObservation?.error && ["network_outage", "usage_limit"].includes(this.store.requireMember(memberId).statusObservation!.error!.code) ? { statusObservation: { ...this.store.requireMember(memberId).statusObservation!, error: null } } : {}) });
  }

  /** 이 직원의 세션에 들어가 있어야 할 설정. */
  private desiredConfig(member: Member): AppliedConfig {
    const { ranks, codexRanks } = this.store.getSettings();
    const { model, effort } = memberConfig(member, ranks, codexRanks);
    return { model, effort, staffModel: (member.cli === "codex" ? codexRanks : ranks).staff.model, staffEffort: member.cli === "codex" ? null : ranks.staff.effort };
  }

  /** 서버가 띄운 세션이 지금 설정과 다른가. 넘겨받은 세션은 대표가 쓰던 칸이라 스스로 닫지 않는다(깨울 때 맞춰진다). 잠든 세션은 깨울 때 맞춰진다. */
  private configPending(member: Member): boolean {
    if (member.origin !== "runner" || (!member.sessionId && !member.paneId) || member.status === "asleep" || member.status === "offline") return false;
    if (!this.runners.get(this.backendOf(member))?.applyConfig) return false;
    const want = this.desiredConfig(member);
    if (this.runtime(member.id).configGaveUp === JSON.stringify(want) || this.store.deferredMemberConfig(member.id)?.signature === JSON.stringify(want)) return false;
    const have = this.store.getAppliedConfig(member.id);
    return want.model !== (have?.model ?? null) || want.effort !== (have?.effort ?? null) || want.staffModel !== (have?.staffModel ?? null) || want.staffEffort !== (have?.staffEffort ?? null);
  }

  /** 쉬는 세션을 새 설정으로 다시 연다(같은 대화를 이어 띄운다). 이번 전달을 그대로 이어가도 되면 true. */
  private async syncConfig(member: Member, rt: Runtime): Promise<boolean> {
    const want = this.desiredConfig(member);
    if (!member.sessionId) {
      rt.configGaveUp = JSON.stringify(want);
      this.store.deferMemberConfig(member.id, JSON.stringify(want));
      this.store.appendActivity(member.id, "system", "설정 적용 보류: 같은 대화의 세션 ID를 확인하지 못했습니다. 다음 자연 기동 때 적용합니다");
      return true;
    }
    try {
      await this.switchProvider(member, { cli: member.cli }, true);
      return true;
    } catch (e) {
      if (e instanceof CoreError && !e.uncertain && ["timeout", "down", "closed", "unavailable"].includes(e.kind)) {
        this.retryLater(member.id, rt, this.timings.retryMs);
        return false;
      }
      rt.configGaveUp = JSON.stringify(want);
      // switchProvider 가 같은 실패를 이미 적었으면 다시 세지 않는다. 두 번 세면 첫 재시도가 60초가 아니라 5분 뒤가 된다.
      const noted = this.store.deferredMemberConfig(member.id);
      if (!(noted?.failed && noted.signature === rt.configGaveUp)) this.store.deferMemberConfig(member.id, rt.configGaveUp, true);
      this.store.patchMember(member.id, { lastError: `설정 적용 보류: ${(e as Error).message}` });
      return false;
    }
  }

  /**
   * 원본이 바뀐 전달(체크를 푼 할 일의 완료 알림, 다시 열린 결재의 답, 지워진 글)은 봉투에 넣을 수 없다.
   * 한 건이 봉투 전체를 거절시켜 그 직원의 대기열이 통째로 영영 막혔다. 보낼 뜻이 없어진 것만 거두고 나머지는 보낸다.
   */
  private dropChangedSources(deliveries: Delivery[]): Delivery[] {
    return deliveries.filter(d => {
      if (d.kind === "compact" || this.deliveryRecovery.sourceRevision(d) !== null) return true;
      this.store.transaction(() => {
        const r = this.store.getDeliveryRecovery(d.id);
        if (r && r.phase !== "stopped") this.store.updateDeliveryRecovery(d.id, r.version, { phase: "stopped", reason: "source_changed", nextCheckAt: null });
        this.store.patchDeliveryRetry(d.id, { nextAttemptAt: null, retryReason: null });
        this.store.markFailed(d.id, "원본이 바뀌어 보내지 않았습니다");
        if (d.refType === "message" && d.refId && this.store.getMessage(d.refId)) this.store.setMessageDelivery(d.refId, "failed", "원본이 바뀌어 보내지 않았습니다");
        this.store.appendActivity(d.memberId, "system", `원본이 바뀐 전달을 보내지 않고 거뒀습니다 (${d.id})`, `source-changed:${d.id}`);
      });
      return false;
    });
  }

  private interjects(runner: Runner | undefined): boolean {
    return !!runner && runner.interjects !== false;
  }

  private async sendUrgent(member: Member, project: Project, runner: Runner, urgent: Delivery[]): Promise<void> {
    await this.sendEnvelope(member, project, runner, orderForBundle(urgent), true);
  }

  /** Commit the exact envelope before I/O; all ambiguous results belong to recovery. */
  private async sendEnvelope(member: Member, project: Project, runner: Runner, deliveries: Delivery[], urgent: boolean): Promise<SendResult> {
    if (this.apiRecovery.holdReason(member.id) || project.archived || this.archiving.has(project.id) || this.coreCompactFenced(member) || !deliveries.length || this.deliveryRecovery.fenced(member.id)) return { ok: false, reason: "busy", retryable: false, deliveryEffect: "not_written" };
    const observed = runner instanceof CoreRunner ? runner.observationState(member.id) : null;
    const dispatch = this.deliveryRecovery.prepareDispatch(deliveries.map(d => d.id), observed?.identity ?? {
      terminalId: member.paneId, sessionId: member.sessionId, sessionGeneration: this.store.memberRevisions(member.id).sessionGeneration, process: null,
    // 세션 기록의 지금 끝 위치를 함께 적는다. 수신 확인이 이 봉투 뒤에 덧붙은 부분만 읽게 된다.
    }, { serverEpoch: this.deliveryEpoch, turn: observed?.turn ?? null, inputEpoch: observed?.inputEpoch ?? null, logs: runner instanceof CoreRunner ? runner.deliveryBaseline(this.runnerMember(member, project)) : [], capturedAt: new Date().toISOString() });
    this.store.transaction(() => {
      this.store.updateDispatch(dispatch.dispatchId, "prepared", "write_started");
      for (const d of deliveries) this.store.setDeliveryStatus(d.id, "delivering", { attempt: true });
    });
    this.invalidateCoreMeasurement(member);
    return this.executeDispatch(member, dispatch, () => runner.send(this.runnerMember(member, project), dispatch.wireText, { ...this.writeRunFiles(member, project), marker: dispatch.bundleMarker }, urgent));
  }

  private async executeDispatch(member: Member, dispatch: DeliveryDispatch, send: () => Promise<SendResult>): Promise<SendResult> {
    const at = new Date().toISOString();
    const review = dispatch.items.some(item => { const delivery = this.store.getDelivery(item.deliveryId); return delivery && isTidy(delivery); }) ? this.store.getBoardReview(member.projectId) : null;
    const run: ExecutionJournal = { runId: dispatch.dispatchId, memberId: member.id, projectId: member.projectId, identity: dispatch.identity, turn: null, deliveryIds: dispatch.items.map(item => item.deliveryId), phase: "starting", inputReceivedAt: null, startedAt: null, lastProgressAt: null, endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at };
    if (review) run.reason = `board_review:${review.requestedRevision}:pending`;
    this.store.transaction(() => {
      this.store.saveExecutionJournal(run);
      this.store.beginDelegationAck(run.runId, member.id, run.deliveryIds.map(id => this.store.requireDelivery(id)));
    });
    let original: Promise<SendResult> | null = null;
    this.liveWrites.add(dispatch.dispatchId);
    const tracked = (): Promise<SendResult> => {
      const call = send();
      original = call;
      void call.then(() => {}, () => {}).finally(() => this.liveWrites.delete(dispatch.dispatchId));
      return call;
    };
    let result = await this.safeSend(() => this.pumpWait(member.id, this.runtime(member.id).pumpStage?.startsWith("send_urgent") ? "send_urgent" : "send", tracked, this.runnerOf(member)));
    if (!original) this.liveWrites.delete(dispatch.dispatchId);
    const first = result;
    if (result.ok && result.receipt && result.receipt.dispatchId !== dispatch.dispatchId) result = { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown", detail: "다른 봉투의 수신 영수증입니다" };
    // The existing Runner.send success contract guarantees received input,
    // including core started:false. Bind legacy ACKs to the submitted envelope;
    // adapters with explicit receipts must identify this exact dispatch.
    this.deliveryRecovery.recordResult(dispatch.dispatchId, result.ok ? { ...result, receipt: result.receipt ?? { dispatchId: dispatch.dispatchId, receivedAt: new Date().toISOString(), source: "transport" } } : result);
    for (const item of dispatch.items) if (this.store.getDelivery(item.deliveryId)?.status === "delivered") this.apiRecovery.received(item.deliveryId);
    if (!result.ok) this.scheduleRecoveryCheck();
    // 단계 제한이 먼저 끝났어도 호출은 계속 돈다. 그 확정 결과가 뒤에 오면 버리지 않는다.
    const pending = original as Promise<SendResult> | null;
    if (!result.ok && !["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown") && pending) void pending.then(late => { if (late !== first) this.lateSendResult(member.id, dispatch, late); }, () => {});
    this.reconcileTodoCorrections();
    const current = this.store.getExecutionJournal(run.runId)!;
    if (!["ended", "interrupted"].includes(current.phase)) {
      const updatedAt = new Date().toISOString();
      this.store.saveExecutionJournal({ ...current, ...(result.ok ? { phase: current.startedAt || result.started ? "running" as const : "received" as const, inputReceivedAt: result.receipt?.receivedAt ?? updatedAt, startedAt: current.startedAt ?? (result.started ? updatedAt : null), turn: result.turn ?? current.turn } : result.deliveryEffect === "not_written" || result.deliveryEffect === "rejected" ? { phase: "ended" as const, result: "error" as const, reason: result.detail ?? result.reason, endedAt: updatedAt } : { phase: "unknown" as const, reason: result.detail ?? result.reason }), updatedAt });
    }
    return result;
  }

  /**
   * 복구 쓰기를 지금 넣을 수 있는가(동시 턴 상한·장애 보류·재시도 간격·세션 처리 중이 아님). 전달 복구는 새 봉투를 남기기 전에도
   * 이것을 묻는다: 넣지 못하는 동안 확인할 때마다 쓰지 못한 봉투가 하나씩 쌓였다.
   */
  repairAdmitted(memberId: string): boolean {
    this.reconcileRejectedExecutions();
    const member = this.store.getMember(memberId), rt = this.runtime(memberId);
    if (member && !this.apiRecovery.holdReason(memberId) && !this.closed && !this.recovering && !this.settingsWriting && !this.configWrites.has(memberId) && !rt.turn && !rt.starting && !rt.closing && !rt.reopening && this.retryDue(member) <= Date.now() && this.activeAutomaticTurns() < this.store.getSettings().maxConcurrentTurns) return true;
    if (member) this.waiting.add(memberId);
    return false;
  }

  /** Recovery writes share admission with ordinary work; inspection remains read-only. */
  recoveryRunner(member: Member): RecoveryRunner | null {
    const runner = this.runners.get(this.backendOf(member));
    if (!runner) return null;
    return {
      ...(runner.inspectDelivery ? { inspectDelivery: runner.inspectDelivery.bind(runner) } : {}),
      ...(runner.terminalGone ? { terminalGone: runner.terminalGone.bind(runner) } : {}),
      ...(runner.inspectGoneDelivery ? { inspectGoneDelivery: runner.inspectGoneDelivery.bind(runner) } : {}),
      ...(runner.repairDelivery ? { repairDelivery: async (m: RunnerMember, request: DeliveryRepair): Promise<SendResult> => {
        const rt = this.runtime(member.id);
        const dispatch = this.store.getDispatch(request.dispatchId);
        if (!this.repairAdmitted(member.id) || !dispatch) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
        const turn: Turn = { kind: "work", text: dispatch.wireText, interrupted: false, deliveries: dispatch.items.map(item => this.store.requireDelivery(item.deliveryId)) };
        rt.turn = turn; rt.posted = false; rt.delegated = false;
        try {
          const result = await this.executeDispatch(member, dispatch, () => runner.repairDelivery!(m, request));
          if (!result.ok && rt.turn === turn) rt.turn = null;
          return result;
        } finally {
          if (!this.store.listPendingExecutions().some(run => run.memberId === member.id) && rt.turn === turn) rt.turn = null;
          this.releaseSlots();
        }
      } } : {}),
    };
  }

  /** Only race external leaves: late results cannot resume lifecycle/send continuations. */
  private async pumpWait<T>(memberId: string, stage: string, action: () => Promise<T>, runner?: Runner): Promise<T> {
    const rt = this.runtime(memberId);
    rt.pumpStage = stage;
    const controller = new AbortController();
    const deadline = Date.now() + this.timings.pumpStageTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // 진단 기록이 실패해도 단계 제한은 반드시 걸려야 한다. 안 그러면 이 펌프가 영영 끝나지 않는다.
            try { this.reportStuckPumps(memberId); } catch (e) { console.error("전달 펌프 정체 기록 실패:", memberId, e); }
            const error = new CoreError("timeout", `Pump stage ${rt.pumpStage ?? stage} exceeded ${this.timings.pumpStageTimeoutMs}ms`, true);
            controller.abort(error);
            reject(error);
          }, this.timings.pumpStageTimeoutMs);
        }),
        runner instanceof CoreRunner ? runner.withSignal(controller.signal, waiting => { rt.pumpStage = `${stage}:${waiting}`; }, action, deadline) : action(),
      ]);
    } catch (error) {
      if (error instanceof CoreError && error.kind === "timeout") {
        const waiting = /^(hello|terminal\.[a-z_]+|context_file):/.exec(error.message)?.[1];
        if (waiting) rt.pumpStage = `${stage}:${waiting}`;
        this.reportStuckPumps(memberId);
      }
      throw error;
    } finally { if (timer) clearTimeout(timer); }
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
    rt.turn = { kind: "control", text: "", interrupted: false };
    const result = await this.safeSend(() => this.pumpWait(member.id, "parallel", () => runner.setParallel(this.runnerMember(member, project), want, this.writeRunFiles(member, project)), runner));
    rt.turn = held;
    if (result.ok) {
      rt.parallelFails = 0;
      this.store.patchMember(member.id, { parallel: want });
      this.store.appendActivity(member.id, "system", `병렬 ${want ? "켬" : "끔"}`);
      return true;
    }
    if (!["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown")) {
      this.store.transaction(() => {
        this.store.deferMemberConfig(member.id, `parallel_unknown:${this.store.memberRevisions(member.id).sessionGeneration}`, true);
        this.store.patchMember(member.id, { lastError: CONTROL_UNKNOWN_NOTE, fenceCode: "control_unknown" });
      });
      rt.wantParallel = null;
      return false;
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

  /** 넣지 못한 봉투를 정리한다. 돌려주는 값은 그 뒤 펌프의 판정이다(동작은 그대로, 판정만 함께 정한다). */
  private onSendFailed(member: Member, rt: Runtime, deliveries: Delivery[], result: Extract<SendResult, { ok: false }>): PumpVerdictCode {
    const memberId = member.id;
    const availability = this.apiRecovery.holdReason(memberId);
    if (availability) { for (const delivery of deliveries) this.hold(delivery, availability); return availability; }
    if (["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown")) {
      for (const d of deliveries) this.deliveryRecovery.requeueRejected(d.id);
      const waits = deliveries.map(d => this.store.getDeliveryRetry(d.id).nextAttemptAt).filter((at): at is string => !!at);
      if (waits.length) { this.scheduleRetry(memberId, rt, Math.max(...waits.map(Date.parse))); return "retry_wait"; }
    }
    if (result.reason === "error" && ["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown")) {
      // A provider's non-retryable refusal is still not an ambiguous write.
      // Durable rejected-count admission bounds these ordinary retries.
      for (const d of deliveries) this.requeue(d);
      this.retryLater(memberId, rt, this.timings.retryMs);
      return "retry_wait";
    }
    if (this.backendOf(member) === "core" && !["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown") && (result.reason === "error" || (result as { reason: string }).reason === "unknown")) {
      for (const d of deliveries) this.hold(d, "delivery_unknown");
      this.store.patchMember(memberId, { lastError: result.detail ?? "전달 여부를 확인할 수 없습니다" });
      return "receipt_check";
    }
    switch (result.reason) {
      case "busy":
        for (const d of deliveries) this.requeue(d);
        this.retryLater(memberId, rt, this.timings.retryMs);
        return "retry_wait";
      case "blocked":
        this.markBlocked(member);
        for (const d of deliveries) this.hold(d, "blocked");
        return "approval";
      case "input_busy": {
        rt.inputBusySince ??= Date.now();
        if (Date.now() - rt.inputBusySince < this.timings.inputBusyLimitMs) {
          for (const d of deliveries) this.requeue(d);
          this.retryLater(memberId, rt, this.timings.inputBusyRetryMs);
          return "retry_wait";
        }
        rt.inputBusySince = null;
        for (const d of deliveries) this.hold(d, "input_busy");
        return "input_hold";
      }
      case "down":
        this.store.patchMember(memberId, { lastError: result.detail ?? "실행기에 연결할 수 없습니다" });
        for (const d of deliveries) this.hold(d, "backend_down");
        return "runner_off";
      case "gone":
        this.store.patchMember(memberId, { status: "offline", paneId: null });
        for (const d of deliveries) this.hold(d, "offline");
        return "session_gone";
      case "error": {
        const detail = result.detail ?? "전달 실패";
        const attempts = Math.max(...deliveries.map((d) => this.store.requireDelivery(d.id).attempts));
        if (result.retryable && attempts < 3) {
          for (const d of deliveries) this.requeue(d);
          this.retryLater(memberId, rt, this.timings.retryMs);
          return "retry_wait";
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
        return "retry_wait";
      }
    }
    return "pump_error";
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

  private retryDue(member: Member): number {
    return this.store.deliveryRetryDue(member.id, this.backendOf(member));
  }

  private scheduleRetry(memberId: string, rt: Runtime, due: number): void {
    if (rt.retryTimer) clearTimeout(rt.retryTimer);
    if (this.closed) return;
    rt.retryTimer = setTimeout(() => {
      rt.retryTimer = null;
      void this.pump(memberId);
    }, Math.min(Math.max(due - Date.now(), 1), 2_147_483_647));
    rt.retryTimer.unref?.();
  }

  private retryLater(memberId: string, rt: Runtime, ms: number): void {
    const due = Date.now() + Math.max(ms, 0);
    this.store.transaction(() => {
      for (const delivery of this.store.listPending(memberId)) {
        if (!["none", "resolved"].includes(this.store.getDeliveryRecovery(delivery.id)?.phase ?? "none")) continue;
        const retry = this.store.getDeliveryRetry(delivery.id);
        this.store.patchDeliveryRetry(delivery.id, { nextAttemptAt: new Date(Math.max(due, Date.parse(retry.nextAttemptAt ?? "") || 0)).toISOString(), retryScope: `member:${memberId}`, retryReason: retry.retryReason ?? "control_retry" });
      }
    });
    rt.holdUntil = Math.max(rt.holdUntil, due);
    this.scheduleRetry(memberId, rt, rt.holdUntil);
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
    return this.coreCompactFenced(member) || this.runtime(member.id).turn !== null || !!this.runners.get(this.backendOf(member))?.isBusy(member.id);
  }

  /** Count persisted executions before admitting new work, including unknown/received turns. */
  private activeAutomaticTurns(): number {
    const ids = new Set<string>();
    for (const run of this.store.listPendingExecutions()) {
      const member = this.store.getMember(run.memberId);
      if (member && this.backendOf(member) === "core" && this.store.memberRevisions(member.id).sessionGeneration === run.identity.sessionGeneration) ids.add(member.id);
    }
    for (const [id, rt] of this.runtimes) if (rt.turn) ids.add(id);
    for (const member of this.store.listAllMembers()) if (member.origin !== "manual" && member.status !== "offline" && member.status !== "asleep" && this.backendOf(member) === "core" && this.coreOccupiesSlot(member.id)) ids.add(member.id);
    return ids.size;
  }

  private coreOccupiesSlot(memberId: string): boolean {
    const runner = this.runners.get("core");
    return !!runner && (runner.occupiesTurnSlot ? runner.occupiesTurnSlot(memberId) : runner.isBusy(memberId));
  }

  private resumePumps(): void {
    if (this.closed) return;
    this.releaseSlots();
    for (const member of this.store.listAllMembers()) if (this.configPending(member) || this.store.listPending(member.id).length) void this.pump(member.id);
  }

  private releaseSlots(): void {
    const ids = [...this.waiting];
    this.waiting.clear();
    for (const id of ids) void this.pump(id);
  }

  // ---- 압축 ----
  private async beginCompact(member: Member, project: Project, runner: Runner, rt: Runtime, focus: string): Promise<void> {
    const state = this.store.ensureContextState(member.id);
    if (state.compaction?.phase !== "queued") {
      // 예약이 이미 돌았거나 닫혔는데 요청 표시만 남았다. 압축을 넣는 사이(예약이 아직 queued 인 동안) 온 실행기 이벤트가 표시를 되살린 것이다
      // (reconcileCoreCompact). 남겨 두면 전달마다 여기서 돌아가 그 팀장의 대기열이 영영 멈춘다. 표시를 지우고 전달을 이어 간다.
      rt.compactRequest = null;
      rt.again = true;
      return;
    }
    this.requireActive(this.store.requireProject(project.id));
    const turn: Turn = { kind: "compact", text: "", interrupted: false };
    rt.turn = turn; // admission은 첫 await 이전에 예약한다.
    rt.compactRequest = null;
    const result = await this.safeSend(() => this.pumpWait(member.id, "compact", () => runner.compact(this.runnerMember(member, project), focus, this.writeRunFiles(member, project)), runner));
    if (rt.turn !== turn) return;
    const latest = this.store.ensureContextState(member.id);
    if (latest.compaction?.phase === "succeeded") { this.endCompact(member.id, rt, null); return; }
    if (result.ok) {
      rt.compactBusySince = null;
      this.store.appendActivity(member.id, "compact", `압축 시작 (문맥 ${member.contextPct ?? "?"}%)`);
      this.store.patchMember(member.id, { status: "working" });
      const id = latest.compaction?.id;
      rt.compactTimer = setTimeout(() => {
        rt.compactTimer = null;
        try {
          const current = this.store.getContextState(member.id);
          if (!current?.compaction || current.compaction.id !== id || !["sending", "running"].includes(current.compaction.phase)) return;
          this.store.saveContextState({ ...current, compaction: { ...current.compaction, phase: "uncertain", reason: "completion_timeout" } });
          this.store.appendActivity(member.id, "error", "압축 완료를 확인할 수 없어 후속 자동 입력을 보류합니다");
        } catch (e) { console.error("압축 시간 초과 처리 실패:", member.id, e); }
      }, this.timings.compactTimeoutMs);
      return;
    }
    // 실행기는 압축 명령을 넣기 전에 기준선(받을 터미널)부터 저장한다. 결과를 모르는 실패(단계 제한, 끊긴 응답)라도 기준선이 없으면 넣은 적이 없고,
    // 단계 제한 뒤에는 실행기도 더 진행하지 않는다(CoreRunner.compact). 예전에는 이것을 '불확실'로 적어, 묶인 터미널이 없는 미확정 압축이
    // 어떤 조작으로도 풀리지 않은 채 남았다. 넣지 못한 것으로 보고 다시 예약한다.
    const unknownEffect = !["not_written", "rejected"].includes(result.deliveryEffect ?? "unknown");
    const neverWritten = unknownEffect && runner instanceof CoreRunner && (latest.baseline?.coreCompact as CoreCompactState | undefined)?.id !== latest.compaction?.id;
    const uncertain = unknownEffect && !neverWritten;
    const retryable = !uncertain && (neverWritten || result.deliveryEffect === "rejected" || ["busy", "blocked", "input_busy", "down"].includes(result.reason));
    // 입력칸의 글·창·CLI 상태 때문에 압축을 못 넣는 동안 전달은 모두 압축 뒤에 선다. 끝없이 되풀이하면 그 직원의 전달이 이유 없이 굶는다.
    if (retryable) rt.compactBusySince ??= Date.now(); else rt.compactBusySince = null;
    const retry = retryable && Date.now() - rt.compactBusySince! < this.timings.inputBusyLimitMs;
    if (retryable && !retry) rt.compactBusySince = null;
    if (latest.compaction && (latest.compaction.phase !== "failed" || retry)) this.store.saveContextState({ ...latest,
      compaction: { ...latest.compaction, phase: uncertain ? "uncertain" : retry ? "queued" : "failed",
        reason: uncertain ? "send_uncertain" : neverWritten ? "backend_down" : result.reason === "input_busy" ? "draft" : result.reason === "blocked" ? "blocked" : result.reason === "down" ? "backend_down" : retryable ? "working" : "provider_error",
        finishedAt: !uncertain && !retry ? new Date().toISOString() : null } });
    if (uncertain) {
      this.store.appendActivity(member.id, "error", "압축 응답을 확인할 수 없어 자동 재전송을 중지했습니다");
      return;
    }
    rt.turn = null;
    if (retry) { rt.compactRequest = focus; this.retryLater(member.id, rt, this.timings.retryMs); }
    else {
      rt.skipCompact = true; rt.again = true;
      this.store.appendActivity(member.id, "error", neverWritten ? "압축 실패: 실행 엔진이 제때 답하지 않아 압축을 시작하지 못했습니다. 기다리던 전달을 먼저 보냅니다"
        : retryable ? "압축 실패: 입력칸의 글이나 CLI 화면 때문에 압축을 시작하지 못했습니다. 기다리던 전달을 먼저 보냅니다" : `압축 실패: ${result.detail ?? result.reason}`);
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
    if (this.backendOf(member) !== "core") this.store.patchMember(member.id, { contextPct: null });
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
    if (this.closed) return;
    const member = this.store.getMember(e.memberId);
    if (!member) {
      const rt = this.runtimes.get(e.memberId);
      if (rt && e.type === "turn_end") {
        this.clearRuntime(e.memberId, rt);
        this.releaseSlots();
      }
      return;
    }
    const generation = this.store.memberRevisions(member.id).sessionGeneration;
    if (e.sessionGeneration !== undefined && e.sessionGeneration !== generation) return;
    if (e.terminalId && member.paneId && e.terminalId !== member.paneId) return;
    if (this.runtime(member.id).closing) return;
    this.reconcileCoreCompact(member);
    if (e.turn !== undefined && e.turn !== null) {
      const previous = this.observedTurns.get(member.id);
      const same = previous?.generation === generation && previous.terminal === (e.terminalId ?? member.paneId);
      if (same && (e.turn < previous.turn || (e.type === "turn_end" && e.turn <= previous.ended))) return;
      this.observedTurns.set(member.id, { generation, terminal: e.terminalId ?? member.paneId, turn: e.turn, ended: e.type === "turn_end" ? e.turn : same ? previous.ended : -1 });
    }
    const pending = this.store.listPendingExecutions().filter(r => r.memberId === member.id && r.identity.sessionGeneration === generation && (!e.terminalId || !r.identity.terminalId || e.terminalId === r.identity.terminalId));
    const at = e.observedAt ?? new Date().toISOString();
    if (e.type === "activity" || (e.type === "status" && e.status === "working" && (!e.observation || e.observation.freshness === "fresh"))) for (const run of pending) {
      this.store.saveExecutionJournal({ ...run, turn: e.turn ?? run.turn, phase: "running", startedAt: run.startedAt ?? at, lastProgressAt: at, updatedAt: at });
    }
    switch (e.type) {
      case "input_ready": this.recheckMemberDelivery(member.id); return;
      case "status":
        // K(E2): 승인 창 앞이던 팀장이 다른 상태로 가면(터미널에서 먼저 답함) 그 도구 승인 카드를 닫는다.
        this.toolPermissions.memberStatus(member.id, e.status);
        // 관측을 명부에 적기 전에, 저장돼 있던 막힘의 까닭을 이미 알린 것으로 잇는다.
        if (e.status === "blocked") this.recallBlockedNotice(member);
        if (this.apiRecovery.holdReason(member.id) === "api_outage" && this.store.requireMember(member.id).statusObservation?.error?.code === "network_outage" && e.status === "idle") return;
        if (["idle", "working"].includes(e.status) && (!e.observation || e.observation.freshness === "fresh") && member.lastError && member.fenceCode !== "control_unknown" && !this.keepsUsageNote(member)) this.store.patchMember(member.id, { lastError: null });
        if (e.status === "working" || e.observation?.freshness === "stale") this.invalidateCoreMeasurement(member);
        if (e.status === "idle" && e.turn !== undefined && e.turn !== null && pending.some(run => run.turn !== null && e.turn! > run.turn)) {
          this.endExecution(member, "success", "서버 부재 중 더 뒤의 종결 turn을 확인했습니다");
          this.runtime(member.id).turn = null;
          this.releaseSlots();
        }
        if (e.status === "gone") {
          // 실행기가 종료를 알렸다(엔진이 끝났다고 답했거나 그 터미널을 모른다고 답했다). 실행을 끝내기 전에 그 터미널에 묶인 상태부터 정리한다.
          this.releaseGoneTerminal(member.id, e.terminalId ?? member.paneId);
          const lost = restartLossOf(e.exit?.reason, e.exit?.exitCode);
          this.endExecution(member, "interrupted", e.exit?.reason ?? "소유 터미널이 종료되거나 사라졌습니다", e.exit?.exitCode ?? null, e.turn, lost !== null && this.noteRestartLoss(member, lost));
          if (e.exit) {
            const detail = exitDetail(e.exit.reason, e.exit.exitCode);
            if (member.lastError !== detail) this.store.appendActivity(member.id, endedByRestart(e.exit.reason) ? "system" : "error", detail.slice(0, 500));
            // 한도로 보류 중인 팀장의 표시는 남긴다('말을 걸면 이어 연다'는 안내는 한도가 풀릴 때까지 맞지 않는다). 종료 사유는 활동에 남았다.
            if (!this.keepsUsageNote(this.store.requireMember(member.id))) this.store.patchMember(member.id, { lastError: detail.slice(0, 500) });
          }
        }

        if (e.usageLimit) {
          this.endExecution(member, "error", e.usageLimit.raw, null, e.turn);
          this.runtime(member.id).turn = null;
          this.apiRecovery.usageFailure(member, e.usageLimit.raw, e.usageLimit);
          this.releaseSlots();
        }
        if (e.observation?.error?.code === "network_retry") this.apiRecovery.networkFailure(member, false);
        // 한도로 보류 중인 팀장의 막힘 사유(usage_limit)는 CLI 의 쉬는 중·일하는 중 보고(막힘 사유 없음)로 지우지 않는다. 한도 그룹에서 풀릴 때 지운다.
        const keepUsageReason = e.blockedReason === null && this.store.requireMember(member.id).blockedReason === "usage_limit" && this.apiRecovery.usageLimited(member.id);
        if ((e.blockedReason !== undefined && !keepUsageReason) || e.observation !== undefined) this.store.patchMember(member.id, {
          ...(e.blockedReason !== undefined && !keepUsageReason ? { blockedReason: e.blockedReason } : {}),
          ...(e.observation !== undefined ? { statusObservation: this.executionObservation(this.store.requireMember(member.id), e.observation, e.status) } : {}),
        });
        // 깨운 직후나 턴이 끝난 직후에는 DB 상태가 이미 idle 이다. 그때 온 준비 신호도 '아직 못 받음'으로 미뤄 둔 전달을 곧바로 다시 보내게 한다.
        if (e.status === "idle" && this.backendOf(member) === "core") {
          if (member.status !== "idle") this.recheckMemberDelivery(member.id, false);
          else if (!e.observation || e.observation.freshness === "fresh") this.recheckMemberDelivery(member.id, false, true);
        }
        return this.onStatus(this.store.requireMember(member.id), e.status);
      case "turn_end":
        if (this.backendOf(member) === "core" && e.isError && /quota|rate.?limit|usage.?limit|authentication|unauthorized|한도|인증/i.test(e.errorText ?? "")) {
          const reason = /auth|unauthorized|인증/i.test(e.errorText ?? "") ? "processing_auth" : "processing_quota";
          const due = new Date(Date.now() + this.timings.turnErrorRetryMs).toISOString();
          for (const run of pending) for (const id of run.deliveryIds) this.store.patchDeliveryRetry(id, { nextAttemptAt: due, retryScope: `member:${member.id}`, retryReason: reason });
        }
        this.endExecution(member, e.isError ? "error" : "success", e.errorText ?? e.reason ?? null, e.exitCode ?? null, e.turn);
        if (e.isError && !pending.length && member.status === "error" && member.lastError === (e.errorText ?? "오류")) return;
        return this.onTurnEnd(member, e);
      case "activity":
        this.store.appendActivity(member.id, e.kind, e.text);
        return;
      case "context_usage":
        this.onContextUsage(member, e);
        return;
      case "session":
        if (e.sessionId !== member.sessionId) this.store.patchMember(member.id, { sessionId: e.sessionId });
        return;
      case "compacted": {
        const rt = this.runtime(member.id);
        if (this.backendOf(member) === "core") {
          const state = this.store.getContextState(member.id);
          if (state?.compaction?.phase !== "succeeded" || e.runId !== state.compaction.id || state.baseline?.reportedCompact === e.runId) return;
          this.store.saveContextState({ ...state, baseline: { ...state.baseline, reportedCompact: e.runId } });
        }
        if (rt.turn?.kind === "compact") {
          this.endCompact(member.id, rt, null);
        } else {
          rt.skipCompact = true;
          this.afterCompacted(member);
          this.releaseSlots();
          void this.pump(member.id);
        }
        return;
      }
      case "pane":
        this.store.patchMember(member.id, { paneId: e.paneId });
        return;
    }
  }

  /** 지금의 막힘에서 이미 알린 까닭들. 메모리에만 있다. */
  private readonly blockedNotices = new Map<string, Set<string>>();
  /** 막힘이 이어지는지 지켜보는 중인 알림(팀장 → 까닭 → 타이머). 아직 보내지 않았으므로 '알린 것'이 아니다. */
  private readonly blockedNoticeTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  private cancelBlockedNotices(memberId: string): void {
    for (const timer of this.blockedNoticeTimers.get(memberId)?.values() ?? []) clearTimeout(timer);
    this.blockedNoticeTimers.delete(memberId);
  }
  /**
   * 막힘이 blockedNoticeMs 동안 이어지면 그때 대표에게 알린다. 그사이 풀렸거나 까닭이 달라졌거나 서버가 닫히는 중이면 보내지 않고,
   * 보내지 않은 것은 '알린 것'으로 적지 않는다(같은 막힘이 다시 이어질 때의 알림을 삼키지 않는다). waited 는 이미 지켜본 시간이다.
   */
  private scheduleBlockedNotice(memberId: string, key: string, waited = 0): void {
    if (this.closed) return;
    const pending = this.blockedNoticeTimers.get(memberId) ?? new Map<string, ReturnType<typeof setTimeout>>();
    if (pending.has(key)) return;
    const fire = () => {
      pending.delete(key);
      if (!pending.size && this.blockedNoticeTimers.get(memberId) === pending) this.blockedNoticeTimers.delete(memberId);
      if (this.closed) return;
      const current = this.store.getMember(memberId);
      if (!current || current.status !== "blocked" || (current.blockedCode ?? "blocked") !== key) return;
      const noticed = this.blockedNotices.get(memberId) ?? new Set<string>();
      if (noticed.has(key)) return;
      this.blockedNotices.set(memberId, noticed.add(key));
      void this.notifyBlocked(current).catch(e => console.warn("막힘 알림 실패:", memberId, (e as Error).message));
    };
    const delay = this.timings.blockedNoticeMs - waited;
    if (!(delay > 0)) { fire(); return; }
    this.blockedNoticeTimers.set(memberId, pending);
    const timer = setTimeout(() => { try { fire(); } catch (e) { console.error("막힘 알림 처리 실패:", memberId, e); } }, delay);
    timer.unref?.();
    pending.set(key, timer);
  }
  /**
   * 서버를 다시 띄운 뒤 처음 보는 팀장이 이미 막혀 있었다면, 저장돼 있던 까닭은 지난 실행에서 알린 것이다.
   * 알림 기록이 메모리에만 있어, 잇지 않으면 재시작(배포)마다 같은 알림이 다시 나갔다. stored 는 이번 관측을 적기 전의 명부 값이어야 한다.
   */
  private recallBlockedNotice(stored: Member): void {
    if (stored.status === "blocked" && !this.blockedNotices.has(stored.id)) this.blockedNotices.set(stored.id, new Set([stored.blockedCode ?? "blocked"]));
  }
  private readonly autoTrusts = new Map<string, { generation: number; fingerprints: Set<string> }>();
  /**
   * 승인 창 앞에서는 대표가 풀어 줘야 움직인다. 결재함에 안 보이므로 다른 창을 보고 있어도 알린다.
   * code 는 서버가 스스로 판단한 까닭(준비 신호 없음)이다. 실행기가 이미 까닭을 관측했으면 그것을 둔다.
   */
  private markBlocked(member: Member, code?: BlockedCode): void {
    const entering = member.status !== "blocked";
    const observation = code && !member.statusObservation?.error ? { statusObservation: {
      ...(member.statusObservation ?? { source: this.backendOf(member), observedAt: new Date().toISOString(), freshness: "unknown" as const, ownership: "unknown" as const, consecutiveFailures: 0 }),
      error: { code, note: "띄운 뒤 60초 넘게 준비를 알리지 않았습니다. 터미널을 열어 화면을 확인해 주세요" } } } : {};
    // The observation's verified reason may have arrived before this status transition. `member` can be an older
    // snapshot than the roster (the pump holds one from its start), so the stored reason wins over it.
    const storedReason = this.store.getMember(member.id)?.blockedReason;
    const blocked = this.store.patchMember(member.id, { status: "blocked", blockedReason: storedReason ?? member.blockedReason ?? "status_unknown", ...observation });
    // 이미 막혀 있던 팀장은 이 막힘에서 처음 보는 까닭이 붙을 때만 다시 알린다(까닭이 오가도 한 번씩만).
    // 새 막힘이면 앞선 막힘에서 지켜보던 알림은 거둔다.
    // 빈 기록을 둔다: 이 막힘은 이 서버가 처음 본 것이다(지난 실행에서 알린 막힘으로 잇지 않는다. recallBlockedNotice).
    if (entering) { this.blockedNotices.set(member.id, new Set()); this.cancelBlockedNotices(member.id); } else this.recallBlockedNotice(member);
    const key = blocked.blockedCode ?? "blocked";
    const notify = entering || (!!blocked.blockedCode && !this.blockedNotices.get(member.id)?.has(key));
    // 명부의 막힘과 승인 카드는 위에서 곧바로 반영됐다. 늦추는 것은 대표에게 가는 알림뿐이다(scheduleBlockedNotice).
    if (this.trustsFolder(blocked)) {
      // 대표가 프로젝트를 만들며 이미 답했다. 정확히 알아본 창에만 답하고, 안 되면 평소처럼 알린다.
      const since = Date.now();
      void this.autoTrust(blocked).then(answered => answered, e => { console.warn("폴더 신뢰 자동 답 실패:", member.id, (e as Error).message); return false; })
        .then(answered => {
          // 스스로 답한 창은 알린 것으로 친다: 그 창을 두고 대표에게 승인 대기라고 알리지 않는다.
          if (answered) this.blockedNotices.set(member.id, (this.blockedNotices.get(member.id) ?? new Set<string>()).add(key));
          else if (notify) this.scheduleBlockedNotice(member.id, key, Date.now() - since);
        });
      return;
    }
    if (notify) this.scheduleBlockedNotice(member.id, key);
  }

  /** 이 팀장이 멈춘 곳이, 대표가 프로젝트를 만들 때 신뢰한다고 답한 바로 그 폴더의 폴더 신뢰 창인가. */
  private trustsFolder(member: Member): boolean {
    if (member.blockedReason !== "setup" || member.statusObservation?.error?.code !== "folder_trust" || member.origin !== "runner") return false;
    const project = this.store.getProject(member.projectId);
    return !!project && !project.archived && project.runnerEnabled && member.cwd === project.cwd && this.store.projectFolderTrusted(project.id, member.cwd);
  }

  /**
   * 기존 승인 답 경로(runner.answerApproval)로 '신뢰'를 고른다. 실행기가 누르기 직전 창을 다시 읽어 폴더 경로와 글자가
   * 정확히 맞을 때만 누른다. 창을 못 읽었거나 선택지가 실측과 다르면 아무것도 누르지 않는다.
   */
  private async autoTrust(member: Member): Promise<boolean> {
    const runner = this.runners.get(this.backendOf(member));
    // 자동으로 고르는 것은 CoreRunner 가 정확히 알아본 폴더 신뢰 창뿐이다. 다른 실행기(시험용 가짜)의 approval 에는 답하지 않는다.
    if (!(runner instanceof CoreRunner) || this.runtime(member.id).closing) return false;
    const generation = this.store.memberRevisions(member.id).sessionGeneration;
    let tried = this.autoTrusts.get(member.id);
    if (!tried || tried.generation !== generation) this.autoTrusts.set(member.id, tried = { generation, fingerprints: new Set() });
    const target = this.runnerMember(member, this.store.requireProject(member.projectId));
    const prompt = await runner.approval(target);
    if (!prompt || prompt.options.length !== 2 || tried.fingerprints.has(prompt.fingerprint) || tried.fingerprints.size >= MAX_AUTO_TRUST_ATTEMPTS) return false;
    const trust = prompt.options.find(option => !option.reject && TRUST_OPTION_LABELS.includes(option.label));
    if (!trust || !prompt.options.some(option => option !== trust && option.reject)) return false;
    // 누르기 전에 다시 본다: 그 사이 폴더가 바뀌었거나 프로젝트가 보관됐으면 그만둔다.
    const current = this.store.getMember(member.id);
    if (!current || !this.trustsFolder(current)) return false;
    tried.fingerprints.add(prompt.fingerprint);
    let result = await runner.answerApproval(target, prompt.fingerprint, trust.n);
    // 막 띄운 직후에는 기동이 입력 자리를 잠깐 잡고 있다. 그때의 거절은 아무것도 누르지 않은 것이라 조금 뒤 다시 해 본다.
    for (let i = 0; i < 5 && !result.ok && result.reason === "input_busy" && !this.closed; i++) {
      await Bun.sleep(200);
      result = await runner.answerApproval(target, prompt.fingerprint, trust.n);
    }
    if (!result.ok) return false;
    this.store.appendActivity(member.id, "system", `프로젝트를 만들 때 대표가 이 폴더를 신뢰한다고 답해, 폴더 신뢰 확인 창에서 '${trust.label}' 을 골랐습니다 · ${member.cwd}`);
    return true;
  }

  /** 무엇을 승인할지 알림에 같이 싣는다. 창을 못 읽으면 예전 문구다. */
  private async notifyBlocked(member: Member): Promise<void> {
    // 승인 창이 아닌 막힘은 승인 대기라고 알리지 않는다.
    if (member.blockedCode === "start_not_ready") return this.notifyInbox(`${member.name} 시작 지연`, "시작이 늦어지고 있습니다. 터미널을 열어 화면을 확인해 주세요");
    if (member.blockedCode === "trust_dialog_unrecognized") return this.notifyInbox(`${member.name} 확인 필요`, "폴더 신뢰 확인 창을 읽지 못했습니다. 터미널을 열어 직접 답해 주세요");
    // K(E2): 이 승인 창은 도구 승인 카드로 이미 알렸다(또는 방금 답했다). 같은 일을 두 번 알리지 않는다.
    if (this.toolPermissions.covers(member.id)) return;
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
        // waiting 은 답하지 않은 결재가 있을 때만 남긴다(이번 턴에 ask 했으면 턴이 끝날 때 정한다). 답이 끝난 waiting 은 지금 일하는 대로 고친다.
        if (member.status !== "working" && !(member.status === "waiting" && this.hasOpenAsk(member))) this.store.patchMember(member.id, { status: "working" });
        break;
      case "idle":
        // turn_end 가 뒤따른다. 그때 정한다.
        if (!rt.turn && member.status !== "error") this.settle(member);
        break;
      case "blocked":
        this.markBlocked(member);
        break;
      case "gone":
        if (rt.launchedAt !== null) {
          if (Date.now() - rt.launchedAt < this.timings.quickExitMs) { rt.quickExits++; rt.quickExitAt = Date.now(); }
          else rt.quickExits = 0;
          rt.launchedAt = null;
        }
        this.interruptCoreCompaction(member);
        if (rt.compactTimer) clearTimeout(rt.compactTimer);
        rt.compactTimer = null;
        this.store.patchMember(member.id, { status: "offline", ...(this.backendOf(member) === "core" ? {} : { paneId: null }), subagents: 0 });
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
      if (this.backendOf(member) === "core") return;
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

    rt.turn = null;
    const { posted, direct } = rt;
    rt.posted = false;
    rt.direct = false;
    rt.skipCompact = false;
    rt.quickExits = 0; rt.quickExitNotified = false; rt.launchedAt = null;
    if (this.backendOf(member) === "core") {
      const state = this.store.ensureContextState(member.id);
      this.store.saveContextState({ ...state, baseline: { ...state.baseline, completedTurn: e.turn ?? null } });
    }
    this.store.finishDelegationAck(member.id);
    this.store.appendActivity(member.id, e.isError ? "error" : "turn_end", e.isError ? (e.errorText ?? "오류") : "턴 끝");
    if (member.subagents !== 0) this.store.patchMember(member.id, { subagents: 0 });

    if (member.status === "asleep") {
      this.releaseSlots();
      return;
    }
    const errorKey = e.turn == null ? undefined : JSON.stringify([this.store.memberRevisions(member.id).sessionGeneration, e.terminalId ?? member.paneId, e.turn]);
    if (turn?.interrupted) {
      this.settle(member);
    } else if (e.isError) {
      await this.onTurnError(member, e.errorText ?? "오류", errorKey);
    } else {
      // 상태 보고가 사라져 끝난 것으로 읽은 턴은 성공의 증거가 아니다(주로 API 오류 뒤다). 장애·한도 보류를 풀지 않는다.
      if (!e.inferred) this.apiRecovery.completed(member.id);
      // 턴을 잘 마쳤으니 입력을 받을 수 있다. '아직 못 받음'으로 미뤄 둔 재시도 간격을 지금 푼다(한도·인증 간격은 그대로).
      void this.recheckMemberDelivery(member.id, false, true);
      this.settle(member, true);
      const tidied = member.kind !== "worker" && !!turn?.deliveries?.some(isTidy);
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

  private async onTurnError(member: Member, errorText: string, errorKey?: string): Promise<void> {
    const kind = classifyTurnError(errorText);
    if (kind === "network") { this.apiRecovery.networkFailure(member, true, errorKey); return; }
    this.apiRecovery.finishNetwork(member.id);
    if (kind === "usage_limit") { this.apiRecovery.usageFailure(member, errorText, null, errorKey); return; }
    this.store.patchMember(member.id, { status: "error", lastError: errorText });
    this.systemMessage(member.projectId, `${member.name} 오류: ${errorText}`);
    if (member.kind === "worker") await this.reportToConductor(member, "막힘", "(자동) 턴 오류", errorText, true);
  }

  /** post 를 안 부른 턴의 마지막 글(§6). 직원은 총괄에게 보고, 총괄·본사 AI 는 대표에게 하는 말. */
  private async fallbackReport(member: Member, finalText: string, direct: boolean): Promise<void> {
    if (member.kind !== "worker") {
      this.store.createMessage({ projectId: member.projectId, memberId: member.id, who: member.name, kind: "답변", body: finalText });
      return;
    }
    const firstLine = normalizeSpace(finalText.split("\n")[0] ?? "").slice(0, 60);
    const title = `${direct ? "(직접) " : ""}(자동) ${firstLine}`;
    const conductor = this.store.getConductor(member.projectId);
    const { deliveries } = this.store.withDeliveryIntents(() => this.store.createMessage({ projectId: member.projectId, memberId: member.id, who: member.name, kind: "알림", title, body: finalText }), message => conductor && conductor.id !== member.id ? [{
      projectId: member.projectId, memberId: conductor.id, kind: "report", text: formatReport(member.name, direct ? "(직접) (자동) 알림" : "(자동) 알림", firstLine, finalText.trim() === firstLine ? "" : finalText), wake: true, refType: "message", refId: message.id,
    }] : []);
    await Promise.all(deliveries.map(d => this.pump(d.memberId)));
  }

  private async resetSession(member: Member): Promise<Member> {
    const project = this.store.requireProject(member.projectId);
    this.store.patchMember(member.id, { sessionId: null, contextPct: null });
    const fresh = this.store.requireMember(member.id);
    const sent = this.desiredConfig(fresh);
    const started = await this.startManaged(fresh, project, false);
    this.applyStarted(member.id, started, sent);
    return this.store.requireMember(member.id);
  }

  /** 턴 밖의 상태. 답하지 않은 결재가 있으면 waiting, 없으면 idle. */
  private settle(member: Member, clearError = false): void {
    const open = member.origin !== "manual" && this.store.listOpenDecisionsByMember(member.id).length > 0;
    const status = open ? "waiting" : "idle";
    if (member.status === "error" && !clearError) return;
    if (member.status === status && !clearError) return;
    this.store.patchMember(member.id, { status, ...(clearError ? { lastError: null } : {}) });
  }

  private hasOpenAsk(member: Member): boolean {
    return member.origin !== "manual" && this.store.listOpenDecisionsByMember(member.id).length > 0;
  }

  /** waiting 인데 답하지 않은 결재가 남지 않았으면 지금 하는 대로(일하는 중·쉼) 바로 고친다. */
  private refreshWaiting(memberId: string): void {
    const member = this.store.getMember(memberId);
    if (!member || member.status !== "waiting" || member.origin === "manual" || this.hasOpenAsk(member)) return;
    if (this.isBusy(member)) this.store.patchMember(member.id, { status: "working" });
    else this.settle(member);
  }

  /**
   * 화면 % 는 바로 표시하고, 창 추정은 두 읽기가 맞아야 저장한다.
   */
  private onContextUsage(member: Member, e: Extract<RunnerEvent, { type: "context_usage" }>): void {
    if (this.backendOf(member) === "core") {
      if (!member.sessionId || !member.paneId || e.sessionId && e.sessionId !== member.sessionId) return;
      const state = this.store.ensureContextState(member.id);
      const settings = this.store.getSettings();
      const identity = { sessionId: member.sessionId, generation: state.generation, terminalId: member.paneId, turn: e.turn ?? null, model: e.model };
      const measurement = coreContextMeasurement(e, identity, identity,
        { learned: member.contextWindow, source: member.contextWindowSource, fallback: settings.contextWindowDefault, windows: settings.contextWindows },
        { complete: true, fresh: e.sessionGeneration === state.generation && e.terminalId === member.paneId, measuredAt: e.observedAt ?? new Date().toISOString() });
      if (!measurement) return;
      const measured = measureContext(e, { learned: member.contextWindow, source: member.contextWindowSource, fallback: settings.contextWindowDefault, windows: settings.contextWindows });
      const log = this.contextLog(member);
      const old = state.baseline?.measurementLog as CompactBoundaryBaseline | undefined;
      let builtin = false;
      if (log && old) builtin = observeCompactBoundary({ cli: member.cli, home: log.home, cwd: member.cwd, baseline: old, current: identity, settled: true, providerError: false }).outcome === "succeeded";
      // 지금 기록의 끝 위치만 적는다. 처음부터 4MB 를 읽으면 큰 기록(수십~수백 MB)에서는 끝에 닿지 못해 읽은 것을 버렸다.
      const end = log ? eofLogBaseline(join(log.home, member.cli === "codex" ? "sessions" : "projects"), log.path) : null;
      const baseline = end?.fileIdentity && log ? { ...identity, path: log.path, fileIdentity: end.fileIdentity, offset: end.offset } : null;
      this.store.saveContextState({ ...state, measurement, baseline: { ...state.baseline, configRevision: this.store.memberRevisions(member.id).configRevision,
        measurementLog: baseline, ...(builtin ? { autoTurn: measurement.turn } : {}) } },
        { contextPct: measured?.pct ?? null, ...(measured?.learned !== null && measured?.learned !== undefined ? { contextWindow: measured.learned, contextWindowSource: measured.source } : {}) });
      return;
    }
    const rt = this.runtime(member.id);
    if (rt.contextCandidate?.sessionId !== member.sessionId) rt.contextCandidate = null;
    if (e.sessionId && e.sessionId !== member.sessionId) return;
    const settings = this.store.getSettings();
    const measured = measureContext(e, { learned: member.contextWindow, source: member.contextWindowSource, fallback: settings.contextWindowDefault, windows: settings.contextWindows });
    if (!measured) return;
    if (exactSource(measured.source)) rt.contextCandidate = null;
    let learned: Partial<Member> = {};
    if (measured.learned !== null) {
      if (measured.source === "screen") {
        const candidate = rt.contextCandidate;
        if (member.contextWindow === measured.learned) {
          rt.contextCandidate = null;
        } else if (candidate && candidate.tokens !== e.tokens && Math.abs(candidate.window - measured.learned) / candidate.window <= 0.05) {
          learned = { contextWindow: measured.learned, contextWindowSource: "screen" };
          rt.contextCandidate = null;
        } else {
          rt.contextCandidate = { sessionId: member.sessionId, window: measured.learned, tokens: e.tokens! };
        }
      } else {
        learned = { contextWindow: measured.learned, contextWindowSource: measured.source ?? null };
      }
    }
    this.store.patchMember(member.id, { ...(measured.pct !== null ? { contextPct: measured.pct } : {}), ...learned });
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
      rt = { contextCandidate: null, turn: null, pumping: null, pumpStage: null, pumpSince: null, pumpReported: false, again: false, posted: false, delegated: false, direct: false, skipCompact: false, compactRequest: null, compactTimer: null, retryTimer: null, inputBusySince: null, readySince: null, compactBusySince: null, wantParallel: null, starting: null, reopening: null, closing: false, parallelFails: 0, holdUntil: 0, configGaveUp: null, launchedAt: null, quickExits: 0, quickExitAt: 0, quickExitNotified: false };
      this.runtimes.set(memberId, rt);
    }
    return rt;
  }

  private clearRuntime(memberId: string, rt: Runtime): void {
    if (rt.compactTimer) clearTimeout(rt.compactTimer);
    if (rt.retryTimer) clearTimeout(rt.retryTimer);
    this.waiting.delete(memberId);
    this.absentCoreMembers.delete(memberId);
    this.codexLogs.delete(memberId);
    this.runtimes.delete(memberId);
  }

  /** 이 직원의 세션을 다루는 실행 방식. 세션을 시작한 실행기로 계속 다룬다. 아직 없으면 전역 설정. */
  private backendOf(member: Member): Backend {
    return member.backend ?? this.store.effectiveBackend();
  }

  private runnerOf(member: Member): Runner {
    const backend = this.backendOf(member);
    const runner = this.runners.get(backend);
    if (!runner) throw new ApiError(503, `실행기가 없습니다: ${backend}`, "backend_missing");
    return runner;
  }

  /** 세션을 새로 띄우거나 다시 열 때. 전역 실행 방식을 따르고 그것을 기억한다. */
  private openRunner(member: Member): Runner {
    if (member.backend !== "core" && (member.sessionId || member.paneId)) {
      throw new ApiError(409, "이전 실행기의 세션은 자동 전환하지 않습니다. 새 팀장을 만들거나 CLI 전환으로 새 세션을 시작하세요", "legacy_session");
    }
    const backend = this.store.effectiveBackend();
    const runner = this.runners.get(backend);
    if (!runner) throw new ApiError(503, `실행기가 없습니다: ${backend}`, "backend_missing");
    if (backend === "core" && this.store.getMember(member.id)) this.store.ensureContextState(member.id);
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
      cli: member.cli,
      parallel: member.parallel,
      cwd: member.cwd,
      sessionId: member.sessionId,
      paneId: member.paneId,
      ...memberConfig(member, settings.ranks, settings.codexRanks),
      subagentModel: (member.cli === "codex" ? settings.codexRanks : settings.ranks).staff.model,
      permissionMode: settings.permissionMode,
      kind: member.kind,
      origin: member.origin,
      sessionGeneration: this.store.getMember(member.id) ? this.store.memberRevisions(member.id).sessionGeneration : undefined,
    };
  }

  private rulesFor(member: Member, project: Project): string {
    const conductor = this.store.getConductor(project.id);
    const settings = this.store.getSettings();
    const staffEffort = member.cli === "codex" ? null : settings.ranks.staff.effort;
    // B1: 보고 언어가 en 이면 지침 끝에 영어 보고 줄이 붙는다. 세션을 띄울 때마다(깨우기·재시작·압축 뒤 규칙) 지금 설정을 읽는다.
    return renderRole(member.kind, { PROJECT: project.name, NAME: member.name, ROLE: member.role, CONDUCTOR: conductor?.name ?? "총괄", SUBAGENT_EFFORT: staffEffort ? `- 서브에이전트·워크플로를 부를 때 effort=${staffEffort} 을 넘긴다.` : "", REPORT_LANGUAGE: settings.reportLanguage }, this.config.rolesDir);
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
    // 바이패스는 대표가 확인한 모드일 때만 경고 창을 끈다. 그래야 첫 경고 창이 아무도 안 보는 칸에서 일을 막지 않는다.
    let settingsFile: string | undefined;
    if (member.cli !== "codex") {
      settingsFile = join(dir, `${member.id}.settings.json`);
      const settings = { statusLine: writeStatuslineWrapper(this.config.home),
        // 대표가 권한 방식을 확인하기 전에는 CLI 의 위험 모드 경고를 대신 꺼 주지 않는다.
        ...(this.store.getSettings().permissionMode === "bypassPermissions" && this.store.getSettings().permissionAcknowledged !== false ? { skipDangerousModePermissionPrompt: true } : {}) };
      writeFileSync(settingsFile, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
    }
    return { systemPromptFile, mcpConfigFile, resume, settingsFile };
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

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./:=@]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
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
