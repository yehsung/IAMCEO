import { classifyTurnError, usageLimitMenu, networkRetryScreen } from "../api-outage.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { capturedContext } from "./statusline.ts";
import { readCodexContextFile } from "./codex-context.ts";
import { readCodexTurnEnd, type CodexTurnCursor } from "./codex-turn.ts";
import { textRef } from "../../shared/server-text.ts";
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovalPrompt, Backend } from "../../shared/types.ts";
import { claudeFolderTrust, codexFolderTrust, looksLikeFolderTrust } from "./core-approval.ts";
import { cleanText, clipUtf16 } from "../text.ts";
import { childEnv } from "./env.ts";
import { claudeQuietScreen, inputText, screenContextPct } from "./claude-screen.ts";
import { CLAUDE_BACKGROUND_REASON, CLAUDE_LOGIN_ERRORS, CLAUDE_LOGIN_REASON, claudeHookTurn, readClaudeTurn, type ClaudeHookTurnState, type ClaudeTurnCursor, type ClaudeTurnError } from "./claude-turn.ts";
import { defaultClaudeHome, findSessionFile } from "./session-files.ts";
import { readClaudeSubagents, readCodexSubagents, type ClaudeSubagentCursor, type CodexSubagentState, type SubagentReading } from "./subagents.ts";
import { CoreError, coreRpc, coreSocketPath, type CoreHello, type CoreTerminal } from "./core-client.ts";
import { providerFor, providerLaunch, isProviderArgv, type ProviderBins } from "./providers.ts";
import { codexBindingMarker, discoverCodexSession, observeCompactBoundary, type CodexBindingCursor, type CompactBoundaryBaseline, type CompactBoundaryCursor } from "./core-context.ts";
import { readDeliveryEvidence, readJsonlRange, parseCodexSessionMeta, providerLogPath, type DeliveryEvidenceCursor, type JsonlCursor } from "./delivery-evidence.ts";
import type { DeliveryDispatch, RunnerRecoveryStore, TerminalLease } from "../service-contracts.ts";
import { readTranscriptTail, transcriptPath } from "./transcript.ts";
import { HookShadow } from "./hook-compare.ts";
import { HookEventReader, hookEventsMark, hookEventsTrusted, isCompactEndHook, isHookEventsMark, type HookEventsMark } from "./hook-events.ts";
import { hookEventsDir } from "./hooks.ts";
import type { FullRunner, RunnerEvent, RunnerMember, SendResult, StartOpts, TerminalControlAction, TerminalControlResult, DeliveryProbe, DeliveryInspection, DeliveryRepair, DeliveryLogBaseline, RunnerTerminalIdentity, RunnerReattachResult, RunnerObservation } from "./types.ts";
import { ERROR_CODES } from "../../shared/error-codes.ts";

/** claudeHome: Claude session transcripts (default CLAUDE_CONFIG_DIR or ~/.claude), read for context usage only. */
export interface CoreRunnerOptions extends ProviderBins { coreBin?: string; socketPath?: string; session?: string; stateDir?: string; configDir?: string; claudeHome?: string; codexHome?: string; contextHome?: string }
export interface CoreCompactState {
  id: string; baseline: CompactBoundaryBaseline; phase: "sending" | "running" | "uncertain" | "succeeded" | "failed";
  startedAt: number; cursor: CompactBoundaryCursor | null;
  /**
   * user_resolved: 대표의 확인으로 닫음. completion_timeout: 넣은 것이 확인된(running) 압축의 완료를 기한 안에 확인하지 못함
   * (기한 전에 기록을 읽을 수 없어 관측이 '모름'이 된 경우도 같다. 넣기가 불확실한 send_uncertain 과 구별한다. 저장소가 compaction.reason 으로 옮긴다).
   * nothing_to_compact(phase failed): Claude 가 그 압축 명령을 'Not enough messages to compact.' 로 끝냈다(압축은 일어나지 않았고 CLI 는 쉰다,
   * CLAUDE_COMPACT_NOTHING). 문맥 상태(compaction)에도 failed/nothing_to_compact 로 옮긴다(지휘자 결정: 출시 앱은 reason 을 글자로 읽어 failed 의
   * 기본 글을 보이고, 0.2.7 앱은 줄을 보이지 않는다). 총괄은 이 까닭을 보고 '압축 실패' 줄 대신 짧은 활동 줄(activity.compact_nothing)만 남긴다.
   */
  reason?: "user_resolved" | "completion_timeout" | "nothing_to_compact";
  /** 무엇으로 완료를 확인했나. hook: 세션 기록의 경계 대신 CLI 의 압축 끝 훅(같은 세션, 넣은 뒤)과 정착한 CLI. 없으면 기록 경계. */
  evidence?: "hook";
  /**
   * 압축을 넣기 직전의 훅 사건 파일 자리(Claude). 압축 끝 훅은 이 뒤에 덧붙은 줄에서만 찾는다(세션 기록의 baseline.offset 과 같은 뜻).
   * null: 그때 자리를 읽지 못해 이 압축에는 훅을 근거로 쓰지 않는다. 없음: 이 칸을 모르던 서버가 넣은 압축이다. 그때는 사건 파일을 처음부터
   * 읽고 줄이 적은 시각으로만 거르며, 지금보다 뒤 시각을 적은 줄은 버린다.
   */
  hookMark?: HookEventsMark | null;
  /** Only acknowledged human input can arm resolution; idle alone is insufficient. */
  manualResolution?: { turn: number | null; unsettled: boolean };
  /**
   * 0.2.7 배포 전 확인(real-cli P3): IAMCEO 가 입력칸에 넣은 압축 명령 그대로('/compact 이어갈 일: …'). 이 압축을 '중단'으로 멈춘 뒤 Claude 가 그 글을
   * 입력칸에 되돌리면, 입력칸 글이 이것과 글자까지 같을 때만 IAMCEO 의 글로 보고 지운다(CoreRunner.clearCompactDraft). 없으면(옛 서버가 넣은 압축) 지우지 않는다.
   */
  command?: string;
}
export interface CoreRunnerDeps {
  pollMs?: number; pollConcurrency?: number; rpcTimeoutMs?: number; sendTimeoutMs?: number; compactTimeoutMs?: number;
  /** Poll scheduling clock; does not change persisted observation timestamps or RPC deadlines. */
  pollNow?: () => number;
  contextTimeoutMs?: number; usageLimitCloseTimeoutMs?: number;
  /** How long a launched CLI may stay without any status report before the block is labelled start_not_ready. Default 60s. */
  startNotReadyMs?: number;
  /**
   * How long a just-launched CLI that has not reported yet is treated as starting rather than blocked. Default 0 (off);
   * the production assembly (createOrchestrator) turns it on. Recognized dialogs are never held back.
   */
  startQuietMs?: number;
  /** How long one inspection keeps reading a legacy (baseline-less) provider log before returning scan_pending. */
  evidenceScanMs?: number;
  readContext?: typeof capturedContext;
  recoveryStore?: RunnerRecoveryStore;
  /** Synchronous transaction ports. A throw prevents external input. */
  repair?: { load(memberId: string, request: DeliveryRepair): DeliveryDispatch | null; prepare(memberId: string, request: DeliveryRepair, dispatch: DeliveryDispatch): boolean };
  /**
   * unconfirmed: the write ended without a receipt (its outcome is unknown, but nothing more can arrive from it).
   * riskApproved: the owner accepted the risk of a duplicate for every item of this envelope.
   */
  quiescence?: (memberId: string, dispatch: DeliveryDispatch) => { originalWrite: "not_written" | "rejected" | "settled" | "unresolved"; externalInput: boolean | null; unconfirmed?: boolean; riskApproved?: boolean };
  submitKeyVerified?: boolean;
  compactStore?: { load(memberId: string): CoreCompactState | null; save(memberId: string, state: CoreCompactState): void };
  /** E1: 훅 기록과 지금 판정을 맞대어 세기만 한다. 없으면 contextHome 이 있고 훅을 넣을 때 만든다. false 면 끈다. */
  hookShadow?: HookShadow | false;
  /**
   * Codex 가 남긴 백그라운드 터미널 때문에 working 으로 보이는데 그 턴의 끝을 Codex 기록으로 확인하지 못한 상태가 같은 까닭으로
   * 이만큼(pollNow) 이어지면 팀장 활동에 까닭을 한 번 남긴다. 판정은 바꾸지 않는다. 기본 30초.
   */
  backgroundNoticeMs?: number;
}
interface Track {
  composerEmpty: boolean | null;
  /**
   * 0.2.7(D2-7): 쉬는 CLI 의 화면에서 입력칸을 알아보았는가(빈 칸이든 사람이 쓴 글이든). false 면 입력칸을 아직 못 알아본다:
   * Codex 는 쉬는 중을 알린 뒤에도 입력칸을 그리기 전이 있다(11-15 새로 띄운 팀장, 넣기 4번 실패). null 은 아직 모른다.
   */
  composerSeen: boolean | null;
  statusPublishedAt: number;
  publishedStatus: string | null;
  pendingStatus: Extract<RunnerEvent, { type: "status" }> | null;
  statusTimer: ReturnType<typeof setTimeout> | null;
  statusKey: string | null;
  setupAttempted: string | null;
  setupError: { code: string; note: string } | null;
  member: RunnerMember; terminal: CoreTerminal; sessionId: string | null; pending: boolean; uncertain: boolean; status: string | null;
  /** Uncertainty from input that has no dispatch (manual control, approval keys, parallel command). The store cannot resolve it. */
  controlUncertain: boolean;
  /** The persisted input state could not be read when this terminal was bound. Input stays fenced until a re-read succeeds. */
  restorePending: boolean;
  /** The Codex rollout file of this session, once found. */
  logFile: { sessionId: string; path: string } | null;
  /** The status report is gone but the turn is known to be over (decided by observe, which also reads the screen). */
  lost: boolean;
  /** When a live terminal's status report first went missing (pollNow). */
  silentSince: number | null;
  /** Last store re-read of the uncertain fence (pollNow) and how many re-reads left it in place. */
  settledAt: number; settleTries: number;
  epoch: number; endedTurn: number; completing: boolean; refresh: Promise<CoreTerminal> | null;
  nonce: string | null; bindingSince: string; binding: CodexBindingCursor | null; compact: CoreCompactState | null;
  /** 이 압축(id)의 끝을 알리는 훅을 찾는 읽기. 한 번 찾으면 seen 이 남는다. */
  compactHook: { id: string; reader: HookEventReader; seen: boolean } | null;
  dispatches: DeliveryDispatch[]; evidence: Map<string, DeliveryEvidenceCursor>; lastError: string | null;
  nextPollAt: number; pollDelay: number;
  observedAt: string; failures: number; failure: string | null;
}
const REQUIRED_METHODS = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill"];
/** herdr-core actually sends permission, question and auth; the other words are legacy. */
const BLOCKED_KINDS: Record<string, "permission" | "selection" | "setup"> = { permission: "permission", selection: "selection", setup: "setup", question: "selection", auth: "setup" };
const SILENT_SETTLE_MS = 750;
const unsupported = (detail: string): Extract<SendResult, { ok: false }> => ({ ok: false, reason: "error", retryable: false, deliveryEffect: "not_written", detail });

/**
 * 0.2.7 배포 전 재확인(real-cli-2 P6): Claude 에게 넣는 압축 명령 전체('/compact …')의 길이 상한(JS 글자 수 = UTF-16 단위).
 * Claude 2.1.323 은 붙여넣은 글이 800 단위를 넘거나(입력 처리의 `lf.length>h9`, h9=800) 줄바꿈이 3개 이상이면 `[Pasted text #N +M lines]`
 * 자리표시로 접는다. 그렇게 접힌 '/compact …' 는 슬래시 명령이 아니라 보통 글(<pasted_content>)로 들어가 압축이 돌지 않았다(실측 약 990자,
 * 60~80자는 매번 돌았다). 그러면 서버는 그 압축을 10분 붙잡고 전달을 막은 뒤 대표에게 '막힘'을 보냈다. 경계를 정확히 재지 못했으니 절반으로 둔다.
 */
export const CLAUDE_COMPACT_COMMAND_MAX = 400;
/**
 * Claude 의 압축 명령. 초점 글을 한 줄로 만든 뒤 전체가 CLAUDE_COMPACT_COMMAND_MAX 를 넘으면 초점 글 뒤쪽을 낱말 경계에서 자르고 '…'을 붙인다
 * (초점 글은 중요한 것을 앞에 둔다: Orchestrator.compactFocus). 이 글이 그대로 입력칸에 들어가고 CoreCompactState.command 로 저장된다.
 */
export function claudeCompactCommand(focus: string): string {
  const text = cleanText(focus).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  const full = `/compact ${text}`.trim();
  if (full.length <= CLAUDE_COMPACT_COMMAND_MAX) return full;
  const head = "/compact ", room = CLAUDE_COMPACT_COMMAND_MAX - head.length - 1; // 끝의 '…' 한 자
  // 코드 포인트 경계에서 자른다(이모지 같은 두 단위 글자를 가르지 않는다, clipUtf16).
  let cut = clipUtf16(text, room);
  // 낱말 경계: 잘린 자리가 낱말 중간이면 앞 칸까지. 앞 칸이 너무 앞이면(긴 낱말 하나) 그대로 자른다.
  if (text[cut.length] !== " ") { const space = cut.lastIndexOf(" "); if (space >= room / 2) cut = cut.slice(0, space); }
  // 끝에 남은 구분 기호(' · ', ', ', ' / ', ':')는 뗀다.
  cut = cut.replace(/[\s·,/:]+$/, "");
  return `${head}${cut}…`;
}

/** Capture an EOF baseline, not an exhaustive delivery/absence scan of history. */
function compactLogBaseline(root: string, path: string): JsonlCursor | null {
  const target = providerLogPath(root, path);
  if (!target) return null;
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || providerLogPath(root, path) !== target) return null;
    const tail = Buffer.alloc(Math.min(stat.size, 4 * 1024 * 1024));
    const start = stat.size - tail.length;
    if (readSync(fd, tail, 0, tail.length, start) !== tail.length || (tail.length && tail.at(-1) !== 10)) return null;
    // Skip the first potentially partial line. Never adopt a partial EOF or an
    // oversized last line as a completed baseline, even if it contains a marker.
    let offset = start;
    if (start > 0) {
      const previous = Buffer.alloc(1);
      if (readSync(fd, previous, 0, 1, start - 1) !== 1) return null;
      if (previous[0] !== 10) {
        offset += tail.indexOf(10) + 1;
        if (offset <= start || offset === stat.size) return null;
      }
    }
    const range = readJsonlRange(root, path, null, { startOffset: offset, fileIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` });
    return range.complete && range.cursor?.offset === stat.size ? range.cursor : null;
  } catch { return null; }
  finally { closeSync(fd); }
}

/**
 * EOF position of the provider log at a line boundary, without reading its history. A delivery envelope stores it so
 * that receipt checks read only what was appended after the send. Evidence used to be scanned from byte 0, 4 MiB per
 * check: on the real 200-500 MB transcripts a delivered message took 20 minutes to 2 hours to confirm.
 */
export function eofLogBaseline(root: string, path: string): DeliveryLogBaseline | null {
  const target = providerLogPath(root, path);
  if (!target) return null;
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || providerLogPath(root, path) !== target) return null;
    if (stat.size > 0) {
      // A partial last line cannot anchor a scan; that envelope falls back to the full scan.
      const last = Buffer.alloc(1);
      if (readSync(fd, last, 0, 1, stat.size - 1) !== 1 || last[0] !== 10) return null;
    }
    return { path, fileIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, offset: stat.size, eventId: null };
  } catch { return null; }
  finally { closeSync(fd); }
}

/**
 * 턴은 끝났는데 Codex 가 띄운 백그라운드 터미널이 살아 있어 core 가 working 을 알리는 상태(CoreRunner.codexBackground).
 * turn: 그동안의 core turn 번호(working 이 이어지는 동안 오르지 않는다). runEnded: 그 턴을 연 실행 기록이 이미 끝났다.
 * reported: 이 상태로 턴 끝과 활동 줄을 이미 냈다.
 */
interface CodexBackground { turn: number; terminals: number; runEnded: boolean; reported: boolean;
  /** 0.2.7 배포 전 확인(real-cli P1): 그 턴이 중단(turn_aborted)으로 끝났다. 하던 명령이 백그라운드 터미널로 남아 계속 돈다. */
  aborted: boolean;
  /** 0.2.7 배포 전 확인 검토: 이 상태를 처음 본 때(벽시계 ms, 같은 working·turn 번호 동안 잇는다). 30분 지연 막힘 알림의 정착 기다림과 '한 상태에 한 번'을 가른다. */
  since: number }
interface CodexBackgroundWatch {
  state: CodexBackground | null;
  cursor: CodexTurnCursor | null;
  /** 화면은 백그라운드 터미널만 남은 모양인데 Codex 기록으로 턴 끝을 확인하지 못한 까닭과 그 시작(pollNow). 턴마다 한 번 알린다. */
  unverified: { turn: number; code: string; since: number; noted: boolean } | null;
}

/**
 * 11-16: Claude 가 자기 근거(세션 기록의 턴 끝, 또는 봉투 자리 뒤의 Stop·StopFailure 훅)로 턴을 끝냈고 화면도 입력을 받을 수 있는데, core 는
 * working 을 알리는 상태(CoreRunner.claudeQuiet).
 * background: 뒤 작업(Workflow·백그라운드 에이전트·셸·Monitor)이 남았다. 쉬는 중으로 보이고 입력을 받는다.
 * error: 그 턴이 로그인 밖의 API 오류(invalid_request·overloaded·rate_limit·billing_error 등)로 끝났다. core 의 error 보고와 같게 본다:
 *   오류 상태로 두고 입력을 받으며(넣을 때는 if:"working"), 끝내도 일이 끊기지 않는다. core 가 working 인 까닭은 대개 끝을 못 본 것(StopFailure)이다.
 * login: 그 턴이 로그인(계정) 오류로 끝났다(CLAUDE_LOGIN_ERRORS). '로그인 필요' 막힘으로 보이고 전달은 보류한다.
 * turn: 그동안의 core turn 번호(working 이 이어지는 동안 오르지 않는다). runId·runEnded: 지금 업무(이 세대에서 입력이 들어간 마지막 실행)와 그것이 이미 끝났는가.
 * reported: 이 상태로 그 업무의 턴 끝을 이미 냈다. error: 끝난 턴의 API 오류. label: 화면에 적힌 뒤 작업.
 */
interface ClaudeQuiet { kind: "background" | "error" | "login"; turn: number; runId: string; runEnded: boolean; reported: boolean; error: ClaudeTurnError | null; label: string | null }
interface ClaudeWatch {
  state: ClaudeQuiet | null;
  /** 지금 업무의 세션 기록 읽기 자리(질문이 바뀌면 처음부터, readClaudeTurn). */
  cursor: ClaudeTurnCursor | null;
  /** 지금 업무의 훅 읽기. 봉투의 hookMark 부터 앞으로만 읽는다. */
  hook: { runId: string; reader: HookEventReader; state: ClaudeHookTurnState } | null;
  /** 이 서버가 claudeQuiet 으로 턴 끝을 이미 낸 업무. */
  closedRun: string | null;
}

/**
 * 0.2.7(묶음 6): 지금 돌고 있는 서브에이전트 수의 관측(track 마다, observeSubagents). 바뀔 때만 subagents 사건을 낸다.
 * path: 찾아 둔 Claude 주 대화 기록. key: 마지막으로 낸 값(quality:count).
 */
interface SubagentWatch { claude: ClaudeSubagentCursor | null; codex: CodexSubagentState | null; path: string | null; key: string | null }

/** Terminals belong to core's holders. IAMCEO shutdown only detaches. */
export class CoreRunner implements FullRunner {
  readonly kind: Backend = "core";
  /** send() never writes into a working CLI: an urgent delivery waits for the turn to end like any other. */
  readonly interjects: boolean = false;
  readonly socketPath: string;
  private readonly rpcTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly operation = new AsyncLocalStorage<{ signal: AbortSignal; waiting: (stage: string) => void; deadline: number }>();
  private readonly tracks = new Map<string, Track>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private readonly configuring = new Set<string>();
  private readonly parallelPreferences = new Map<string, boolean>();
  private readonly leases = new Map<string, TerminalLease>();
  private readonly lostCodex = new Map<string, number | undefined>();
  private readonly unknownStarts = new Set<string>();
  private readonly sending = new Set<string>();
  private readonly starts = new Map<string, Promise<{ sessionId: string | null; paneId: string; rejoined?: boolean }>>();
  /** Codex 가 남긴 백그라운드 터미널의 관측(track 마다). 새 track 은 처음부터 다시 본다. */
  private readonly codexWatch = new WeakMap<Track, CodexBackgroundWatch>();
  /** Claude 가 자기 근거로 끝낸 턴의 관측(track 마다, claudeQuiet). */
  private readonly claudeWatch = new WeakMap<Track, ClaudeWatch>();
  /** 서브에이전트 수의 관측(track 마다). 새 track(다시 띄운 CLI)은 처음부터 다시 잰다. */
  private readonly subagentWatch = new WeakMap<Track, SubagentWatch>();
  /** 0.2.7 배포 전 확인(P3): 멈춘 압축(id)의 되살아난 명령을 지웠는가·안내했는가(track 마다, 압축마다 한 번). */
  private readonly compactDrafts = new WeakMap<Track, { id: string; cleared: boolean; noted: boolean }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly polling = new Set<Track>();
  private readonly inputRefreshes = new Map<Track, ReturnType<typeof setTimeout>>();
  private closed = false;
  private methods = new Set<string>();
  /** E1 나란히 모으기. 판정에는 쓰지 않는다. */
  private readonly hookShadow: HookShadow | null;
  /** 훅 사건 폴더. 압축 끝 훅을 완료의 근거로 읽을 때만 쓴다(checkCompact). 훅을 넣지 않는 환경이면 null. */
  private readonly hookEvents: string | null;

  constructor(private readonly options: CoreRunnerOptions = {}, private readonly deps: CoreRunnerDeps = {}) {
    this.socketPath = options.socketPath || coreSocketPath(options.session);
    this.rpcTimeoutMs = deps.rpcTimeoutMs ?? 8000;
    this.sendTimeoutMs = deps.sendTimeoutMs ?? 20_000;
    // 훅은 contextHome 이 있을 때만 넣는다(providers.ts). 같은 조건에서만 비교한다.
    this.hookEvents = options.contextHome && (options.hookEvents ?? process.env.IAMCEO_HOOK_EVENTS !== "0") ? hookEventsDir(options.contextHome) : null;
    this.hookShadow = deps.hookShadow === false ? null : deps.hookShadow ?? (this.hookEvents ? new HookShadow({ eventsDir: this.hookEvents }) : null);
  }
  /** Scope cancellation to this attempt; a late read must never initiate another input. */
  withSignal<T>(signal: AbortSignal, waiting: (stage: string) => void, action: () => Promise<T>, deadline: number): Promise<T> {
    return this.operation.run({ signal, waiting, deadline }, action);
  }
  private waitFor<T>(stage: string, action: () => Promise<T>, timeoutMs: number): Promise<T> {
    const scope = this.operation?.getStore();
    if (scope?.signal.aborted) return Promise.reject(scope.signal.reason);
    scope?.waiting(stage);
    return new Promise<T>((resolve, reject) => {
      const finish = (error: unknown, value?: T) => {
        clearTimeout(timer);
        scope?.signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(value as T);
      };
      const aborted = () => finish(scope!.signal.reason);
      const timer = setTimeout(() => finish(new CoreError("timeout", `${stage}: no completion within ${timeoutMs}ms`, true)), timeoutMs);
      scope?.signal.addEventListener("abort", aborted, { once: true });
      try { action().then(value => finish(null, value), error => finish(error)); }
      catch (error) { finish(error); }
    });
  }
  private call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.rpcTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new CoreError("closed", "CoreRunner is shut down"));
    const scope = this.operation.getStore();
    if (scope) {
      if (scope.signal.aborted) return Promise.reject(scope.signal.reason);
      const remaining = scope.deadline - Date.now();
      if (remaining <= 0) return Promise.reject(new CoreError("timeout", `${method}: pump deadline expired before RPC`, false, "not_written"));
      scope.waiting(method);
      timeoutMs = Math.min(timeoutMs, remaining);
    }
    // Let coreRpc destroy its socket before releasing the runner's input lock.
    // Racing a live socket against abort could otherwise allow a late connect
    // to write after a manual lease had been admitted. Non-pump input is unchanged.
    return coreRpc<T>(this.socketPath, method, params, timeoutMs);
  }
  async available(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const hello = await this.call<CoreHello>("hello", { generation: 1 });
      if (hello.generation !== 1) throw new CoreError("unsupported_generation", `Unsupported herdr-core generation: ${hello.generation}`);
      const missing = REQUIRED_METHODS.filter((method) => !hello.methods?.includes(method));
      if (missing.length) throw new CoreError("unsupported", `Core is missing methods: ${missing.join(", ")}`);
      this.methods = new Set(hello.methods);
      return { ok: true, detail: `herdr-core ${hello.version} (${this.socketPath}); status requires OSC 7501; attach with hc attach` };
    } catch (error) { return { ok: false, detail: `${error instanceof Error ? error.message : error}. Start herdr-core with ${this.options.coreBin || "hc"} server start` }; }
  }
  on(callback: (event: RunnerEvent) => void): void { this.listeners.add(callback); }
  private emit(event: RunnerEvent): void { for (const callback of this.listeners) callback(event); }
  private observation(track: Track): RunnerObservation {
    return { terminalId: track.terminal.address, ...(track.member.sessionGeneration !== undefined ? { sessionGeneration: track.member.sessionGeneration } : {}), turn: track.terminal.turn ?? null, inputEpoch: track.epoch, observedAt: track.observedAt };
  }
  private event(track: Track, event: RunnerEvent): void {
    const observed = { ...this.observation(track), ...event };
    this.hookShadow?.observe(observed, providerFor(track.member));
    this.emit(observed);
  }
  private publishStatus(track: Track, event: Extract<RunnerEvent, { type: "status" }>): void {
    const delay = 250 - (Date.now() - track.statusPublishedAt);
    if (["working", "idle"].includes(event.status) && ["working", "idle"].includes(track.publishedStatus ?? "") && event.observation?.freshness === "fresh" && delay > 0) {
      track.pendingStatus = event;
      track.statusTimer ??= setTimeout(() => {
        track.statusTimer = null;
        const latest = track.pendingStatus; track.pendingStatus = null;
        if (!this.closed && this.tracks.get(track.member.id) === track && latest) this.publishStatus(track, latest);
      }, delay);
      return;
    }
    if (track.statusTimer) clearTimeout(track.statusTimer);
    track.statusTimer = null; track.pendingStatus = null;
    track.statusPublishedAt = Date.now();
    track.publishedStatus = event.status;
    this.event(track, event);
  }
  private identity(track: Track): RunnerTerminalIdentity {
    return { terminalId: track.terminal.address, sessionId: track.sessionId, sessionGeneration: track.member.sessionGeneration ?? -1,
      process: track.terminal.pid ? { pid: track.terminal.pid, startedAt: null } : null };
  }
  private sameIdentity(a: RunnerTerminalIdentity, b: RunnerTerminalIdentity): boolean {
    return a.terminalId === b.terminalId && a.sessionId === b.sessionId && a.sessionGeneration === b.sessionGeneration && (!a.process || !b.process || a.process.pid === b.process.pid);
  }
  private reserve(memberId: string): () => void {
    if (this.sending.has(memberId)) throw new CoreError("busy", "A terminal input mutation is in progress");
    this.sending.add(memberId);
    return () => this.sending.delete(memberId);
  }
  private bump(track: Track): void { track.epoch++; }
  private restore(track: Track): void {
    const state = this.deps.recoveryStore?.inputState(track.member.id);
    // Recovery phase can lag a durable pre-write refusal across a restart.
    track.dispatches = (state?.unresolvedDispatches ?? []).filter(d => d.transportState !== "rejected");
    track.uncertain ||= track.dispatches.length > 0;
    if (state?.lease && state.lease.expiresAt > Date.now() && this.sameIdentity({ ...state.lease.identity, sessionId: track.sessionId ?? state.lease.identity.sessionId }, { ...this.identity(track), sessionId: track.sessionId ?? state.lease.identity.sessionId })) this.leases.set(track.member.id, state.lease);
    const compact = this.deps.compactStore?.load(track.member.id);
    if (compact && compact.baseline.generation === track.member.sessionGeneration && compact.baseline.terminalId === track.terminal.address && compact.baseline.sessionId === track.sessionId && !["failed", "succeeded"].includes(compact.phase)) {
      track.compact = { ...compact, phase: "uncertain" }; track.uncertain = true;
    }
  }
  /**
   * A fence that came from a dispatch is lifted once the store has resolved that dispatch. It used to stay until
   * the server restarted, so the member accepted nothing (real 2026-11-07 and 11-10 runs). Fences from manual
   * input or compaction are left alone.
   */
  private settleUncertain(track: Track, marker?: string, polled = false): boolean {
    if (track.restorePending) {
      // Same pacing as the fence re-read below: soon at first, every 5 s while it keeps failing.
      const now = this.pollNow();
      if (polled && now >= track.settledAt && now - track.settledAt < Math.min(5000, 500 * 2 ** Math.min(track.settleTries, 4))) return false;
      track.settledAt = now; track.settleTries++;
      try { this.restore(track); } catch { return false; }
      track.restorePending = false; track.settleTries = 0; track.settledAt = -Infinity;
      // The fence set at bind stood in for whatever the store holds. Now that it was read, keep only what it says.
      track.uncertain = track.dispatches.length > 0 || !!track.compact && !["failed", "succeeded"].includes(track.compact.phase);
      if (!track.uncertain) { track.evidence.clear(); return true; }
    }
    if (!track.uncertain || track.controlUncertain || !this.deps.recoveryStore) return false;
    if (track.compact && !["failed", "succeeded"].includes(track.compact.phase)) return false;
    // The store read costs as much as the dispatch history. Recheck a fresh fence soon, a long one (waiting for the owner) every 5s.
    const now = this.pollNow();
    if (polled && now >= track.settledAt && now - track.settledAt < Math.min(5000, 500 * 2 ** Math.min(track.settleTries, 4))) return false;
    track.settledAt = now; track.settleTries++;
    let unresolved: DeliveryDispatch[];
    try { unresolved = this.deps.recoveryStore.inputState(track.member.id).unresolvedDispatches; }
    catch { return false; } // Unreadable (e.g. the member is being removed): stay fenced.
    // The dispatch being written right now is not a previous unresolved write.
    track.dispatches = unresolved.filter(d => d.transportState !== "rejected" && (!marker || d.bundleMarker !== marker));
    if (track.dispatches.length) return false;
    track.uncertain = false; track.settleTries = 0;
    track.evidence.clear();
    return true;
  }
  /**
   * A terminal whose report vanished after a finished turn reads as done. 11-16: so does a Claude whose own record ended the turn while
   * core still reports working for its background work (claudeQuiet background): it takes input (send guards it with if:"working").
   * A Claude turn that its own record ended with a non-login API error (claudeQuiet error) reads as core's error report.
   */
  private stateOf(track: Track | undefined, terminal: CoreTerminal): string | undefined {
    if (track?.lost && track.terminal === terminal && !terminal.status) return "done";
    const quiet = track ? this.claudeQuietOn(track, terminal) : null;
    if (quiet?.kind === "background") return "done";
    if (quiet?.kind === "error") return "error";
    return terminal.status?.state;
  }
  /** claudeQuiet 의 지금 판정. 그 track 의 지금 터미널이고 core 가 아직 working 이어야 한다. */
  private claudeQuietOn(track: Track, terminal: CoreTerminal = track.terminal): ClaudeQuiet | null {
    if (track.terminal !== terminal || terminal.state !== "live" || terminal.status?.state !== "working") return null;
    return this.claudeWatch.get(track)?.state ?? null;
  }
  /** 뒤 작업만 남은 Claude(claudeQuiet background)인가. 끝내거나 다시 열면 그 작업이 죽는다. */
  private claudeLingers(track: Track, terminal: CoreTerminal = track.terminal): boolean {
    return this.claudeQuietOn(track, terminal)?.kind === "background";
  }
  /**
   * core 에게는 working 이지만 Claude 자기 근거로 턴이 끝나 입력을 받는 Claude 인가: 뒤 작업만 남았거나(background), 로그인 밖의 API 오류로
   * 끝났다(error). 넣을 때는 넣기 직전에 다시 보고(stillClaudeQuiet) if:"working" 을 건다. 로그인 오류(login)는 받지 않는다(보류).
   */
  private claudeTakesInput(track: Track, terminal: CoreTerminal = track.terminal): boolean {
    const kind = this.claudeQuietOn(track, terminal)?.kind;
    return kind === "background" || kind === "error";
  }
  private validateTrack(track: Track): void {
    this.operation.getStore()?.signal.throwIfAborted();
    if (this.closed || this.tracks.get(track.member.id) !== track) throw new CoreError("conflict", "Terminal generation changed during operation");
  }
  private assertMember(track: Track, member: RunnerMember): void {
    if (track.member.sessionGeneration !== member.sessionGeneration || track.member.projectId !== member.projectId || providerFor(track.member) !== providerFor(member) || track.member.cwd !== member.cwd || (member.sessionId && track.sessionId && member.sessionId !== track.sessionId)) throw new CoreError("conflict", "Member identity or session generation changed");
  }
  private labels(member: RunnerMember) { return { "iamceo.member": member.id, "iamceo.project": member.projectId, "iamceo.cli": providerFor(member) }; }
  private owns(terminal: CoreTerminal, member: RunnerMember): boolean {
    return Object.entries(this.labels(member)).every(([key, value]) => terminal.labels?.[key] === value) && (member.sessionGeneration === undefined || terminal.labels?.["iamceo.generation"] === String(member.sessionGeneration));
  }
  private name(member: RunnerMember): string { return `iamceo-${createHash("sha256").update(`${member.projectId}:${member.id}`).digest("hex").slice(0, 24)}`; }
  private async bind(member: RunnerMember, terminal: CoreTerminal, sessionId: string | null): Promise<Track> {
    if (this.closed) throw new CoreError("closed", "CoreRunner shut down while starting; terminal remains owned by core");
    const launch = terminal.labels["iamceo.operation"] ? this.deps.recoveryStore?.getLifecycleJournal?.(terminal.labels["iamceo.operation"]) : null;
    const launchedAt = launch?.memberId === member.id && launch.intent === "start" ? launch.createdAt : null;
    const track: Track = { member: { ...member }, terminal, sessionId, pending: false, uncertain: false, controlUncertain: false, restorePending: false, lost: false, silentSince: null, settledAt: -Infinity, settleTries: 0, status: null, statusKey: null, composerEmpty: null, composerSeen: null, statusPublishedAt: 0, publishedStatus: null, pendingStatus: null, statusTimer: null, setupAttempted: null, setupError: null,
      epoch: 0, endedTurn: terminal.turn ?? 0, completing: false, refresh: null, nonce: terminal.labels["iamceo.binding"] || null, bindingSince: terminal.labels["iamceo.startedAt"] || launchedAt || new Date().toISOString(), binding: null, compact: null, compactHook: null,
      dispatches: [], evidence: new Map(), logFile: null, lastError: null, nextPollAt: 0, pollDelay: this.pollMs, observedAt: new Date().toISOString(), failures: 0, failure: null };
    // The terminal exists whether or not the persisted input state can be read. Throwing here left a terminal that
    // nobody tracked (terminal.run had already succeeded) and a start whose result read as unknown: every later
    // wake then failed the same way. Track it and fence input instead; the fence lifts once the state reads again.
    try { this.restore(track); } catch { track.restorePending = true; track.uncertain = true; }
    this.tracks.set(member.id, track);
    await this.observe(track, terminal, true);
    this.event(track, { type: "pane", memberId: member.id, paneId: terminal.address });
    if (sessionId) this.event(track, { type: "session", memberId: member.id, sessionId });
    if (!this.timer) {
      this.timer = this.operation.exit(() => setInterval(() => { this.poll(); }, Math.min(this.pollMs, 250)));
      this.timer.unref?.();
    }
    return track;
  }
  start(member: RunnerMember, opts: StartOpts): Promise<{ sessionId: string | null; paneId: string; rejoined?: boolean }> {
    const pending = this.starts.get(member.id);
    if (pending) return pending;
    let release: () => void;
    try { release = this.reserve(member.id); } catch (error) { return Promise.reject(error); }
    const promise = this.startLocked(member, opts).finally(() => { this.starts.delete(member.id); release(); });
    this.starts.set(member.id, promise);
    return promise;
  }
  private async startLocked(member: RunnerMember, opts: StartOpts) {
    const joined = await (async () => {
      const availability = await this.available();
      if (!availability.ok) throw new CoreError("unavailable", availability.detail || "Core unavailable");
      const snapshot = await this.call<{ terminals: CoreTerminal[] }>("terminal.list", {});
      return this.reattachFrom(member, snapshot.terminals.filter(terminal => terminal.state === "live"));
    })().catch(error => {
      // These RPCs only observe; a lost read reply cannot have created a CLI.
      if (error instanceof CoreError) throw new CoreError(error.kind, error.message, false, "not_written", error.causeCode);
      throw error;
    });
    if (joined.outcome === "rejoined") return { sessionId: joined.started.sessionId, paneId: joined.started.paneId!, rejoined: true };
    if (joined.outcome !== "not_found") throw new CoreError(joined.outcome, joined.detail || joined.code);
    if (this.unknownStarts.has(member.id)) throw new CoreError("starting_unknown", "Previous terminal.run may still create a holder; read-only reattach is required");
    // A persisted core pane is evidence of a previous program. Never replace it
    // on a transport failure, a missing snapshot, or an unknown Codex session.
    if (member.origin === "adopted") throw new CoreError("unsupported", "Core does not adopt terminals without IAMCEO ownership labels");
    if (providerFor(member) === "codex" && (member.paneId || (this.lostCodex.has(member.id) && this.lostCodex.get(member.id) === member.sessionGeneration)) && !member.sessionId) throw new CoreError("session_unknown", "The previous Codex terminal is gone and its native session id is unknown; explicitly start a fresh session with context handoff");
    const launch = providerLaunch(member, opts, this.options);
    const env = childEnv();
    for (const key of Object.keys(env)) if (/^(HC_|HERDR_)/.test(key)) delete env[key];
    // The core itself uses isolated XDG directories; its provider programs
    // retain the user's normal configuration/state roots.
    env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    env.XDG_STATE_HOME = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    if (this.options.claudeHome) env.CLAUDE_CONFIG_DIR = this.options.claudeHome;
    if (this.options.codexHome) env.CODEX_HOME = this.options.codexHome;
    Object.assign(env, launch.env);
    const nonce = providerFor(member) === "codex" ? crypto.randomUUID().replaceAll("-", "") : null;
    let terminal: CoreTerminal;
    try { terminal = await this.call<CoreTerminal>("terminal.run", {
      argv: launch.argv, cwd: member.cwd, env, name: this.name(member), size: { cols: 160, rows: 50 },
      labels: { ...this.labels(member), "iamceo.startedAt": new Date().toISOString(), ...(member.sessionGeneration !== undefined ? { "iamceo.generation": String(member.sessionGeneration) } : {}), ...(opts.operationId ? { "iamceo.operation": opts.operationId } : {}), ...(nonce ? { "iamceo.binding": nonce } : {}), ...(launch.sessionId ? { "iamceo.session": launch.sessionId } : {}) },
      no_parent: true, outlive_parent: true, no_notify: true, keep: false, rm: false, wait: false,
    }, this.sendTimeoutMs);
      if (!terminal?.address || !terminal.labels || !Array.isArray(terminal.argv) || terminal.cwd !== member.cwd || !this.owns(terminal, member) || (terminal.turn !== undefined && (!Number.isSafeInteger(terminal.turn) || terminal.turn < 0))) throw new CoreError("protocol", "Invalid terminal.run identity; creation may have occurred", true);
    } catch (error) { if (!(error instanceof CoreError) || error.uncertain) this.unknownStarts.add(member.id); throw error; }
    // A timed-out run may have spawned a holder. A later start first searches
    // the stable member labels/name, rather than replaying terminal.run.
    await this.bind(member, terminal, launch.sessionId);
    return { sessionId: launch.sessionId, paneId: terminal.address };
  }
  /** The orchestrator verified that no owned terminal appeared; a later start may create one again. */
  forgetUnknownStart(memberId: string): void { this.unknownStarts.delete(memberId); }
  async reattachOwned(member: RunnerMember): Promise<RunnerReattachResult> {
    // Re-observing an attached terminal only reads. Holding the input lock for it made the periodic supervisor
    // pass collide with deliveries, sleep and manual control ("busy"). Lock only when a terminal must be bound.
    const attached = this.tracks.get(member.id);
    if (attached && attached.member.sessionGeneration === member.sessionGeneration) {
      const result = await this.reattachWith(member, attached);
      if (result.outcome === "rejoined" || result.code !== "rebind_required") return result;
    }
    return this.reattachWith(member, null);
  }
  /** observed: re-observe that track without the lock; rebind_required means another terminal must be bound under it. */
  private async reattachWith(member: RunnerMember, observed: Track | null): Promise<RunnerReattachResult> {
    let release: (() => void) | null = null;
    try {
      if (!observed) release = this.reserve(member.id);
      const hello = await this.call<CoreHello>("hello", { generation: 1 });
      if (hello.generation !== 1) return { outcome: "conflict", code: "unsupported_generation" };
      this.methods = new Set(hello.methods);
      const snapshot = await this.call<{ terminals: CoreTerminal[] }>("terminal.list");
      const result = await this.reattachFrom(member, snapshot.terminals.filter((terminal) => terminal.state === "live"), observed);
      // A mutation ran while we looked without the lock: do not judge absence or conflict from that snapshot.
      if (observed && result.outcome !== "rejoined" && (this.sending.has(member.id) || this.tracks.get(member.id) !== observed)) return { outcome: "unknown", code: "mutation_in_progress" };
      return result;
    } catch (error) {
      // Sleep or start replaced the terminal while we looked without the lock; the observation is stale.
      if (observed && !this.closed && this.tracks.get(member.id) !== observed) return { outcome: "unknown", code: "mutation_in_progress" };
      return { outcome: error instanceof CoreError && error.kind === "conflict" ? "conflict" : "unknown", code: error instanceof CoreError ? error.kind : "error", detail: error instanceof Error ? error.message : String(error) };
    }
    finally { release?.(); }
  }
  private async reattachFrom(member: RunnerMember, live: CoreTerminal[], observed: Track | null = null): Promise<RunnerReattachResult> {
    const matches = live.filter((terminal) => terminal.labels?.["iamceo.member"] === member.id && terminal.labels?.["iamceo.project"] === member.projectId);
    if (live.some(terminal => (terminal.address === member.paneId || terminal.labels?.["iamceo.member"] === member.id) && !this.owns(terminal, member))) return { outcome: "conflict", code: "ownership_changed", detail: "A recorded terminal or member label has conflicting ownership" };
    if (member.sessionId && live.some((terminal) => terminal.labels?.["iamceo.session"] === member.sessionId && !this.owns(terminal, member))) return { outcome: "conflict", code: "session_owned", detail: "CLI session is already owned by another live terminal" };
    if (!matches.length) return { outcome: "not_found", code: "no_owned_terminal" };
    if (matches.length !== 1) return { outcome: "conflict", code: "multiple_terminals", detail: "Multiple live terminals claim this member" };
    const terminal = matches[0];
    if (!this.owns(terminal, member) || !isProviderArgv(terminal.argv, providerFor(member), providerFor(member) === "claude" ? this.options.claudeBin : this.options.codexBin) || terminal.cwd !== member.cwd ||
      (member.sessionId && terminal.labels["iamceo.session"] && terminal.labels["iamceo.session"] !== member.sessionId)) return { outcome: "conflict", code: "ownership_changed", detail: "Core terminal ownership, provider, cwd or generation changed" };
    const current = this.tracks.get(member.id);
    const sessionId = terminal.labels["iamceo.session"] || member.sessionId || (current?.terminal.address === terminal.address ? current.sessionId : null);
    const same = !!current && current.terminal.address === terminal.address && current.member.sessionGeneration === member.sessionGeneration;
    // A lock-free re-observation never binds: back off if the track changed, retry under the lock if another terminal is live.
    if (observed && current !== observed) return { outcome: "unknown", code: "mutation_in_progress" };
    if (observed && !same) return { outcome: "unknown", code: "rebind_required" };
    const track = same ? current! : await this.bind(member, terminal, sessionId);
    if (track === current) await this.refresh(track);
    if (observed && this.tracks.get(member.id) !== track) return { outcome: "unknown", code: "mutation_in_progress" };
    this.unknownStarts.delete(member.id);
    return { outcome: "rejoined", started: { sessionId: track.sessionId, paneId: terminal.address, rejoined: true, identity: this.identity(track) } };
  }
  private async observe(track: Track, terminal: CoreTerminal, initial = false): Promise<void> {
    this.validateTrack(track);
    const previous = track.terminal;
    if (terminal.turn !== undefined && (!Number.isSafeInteger(terminal.turn) || terminal.turn < 0)) throw new CoreError("protocol", "Invalid core turn counter");
    if (terminal.address !== previous.address || (previous.pid && terminal.pid && previous.pid !== terminal.pid)) throw new CoreError("conflict", "Core terminal process identity changed");
    if ((terminal.turn ?? 0) < (previous.turn ?? 0)) throw new CoreError("stale", "Discarded older core turn");
    track.terminal = terminal; track.lost = false;
    if (terminal.state !== "live" || terminal.status) track.silentSince = null; else track.silentSince ??= this.pollNow();
    track.observedAt = new Date().toISOString();
    const reported = terminal.status?.state;
    let status: "working" | "idle" | "blocked" | "gone" = terminal.state !== "live" ? "gone" : reported === "working" ? "working" : ["idle", "done", "error"].includes(reported || "") ? "idle" : "blocked";
    if (!initial && (terminal.turn !== previous.turn || reported !== previous.status?.state)) this.bump(track);
    if (status === "gone" && providerFor(track.member) === "codex" && !track.sessionId) this.lostCodex.set(track.member.id, track.member.sessionGeneration);
    // Pump input has its own mandatory composer read. Diagnostic screen reads must
    // not consume that attempt's deadline or hide its pre-write timeout boundary.
    const screen = terminal.state === "live" && (!this.operation.getStore() || status === "blocked") ? await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 }).then(r => r.text, () => null) : null;
    this.validateTrack(track);
    // 0.2.7: 서브에이전트 수. 붙는 순간의 첫 관측에서는 내지 않는다(아직 pane 사건 전이라 총괄이 이 터미널을 모른다). 다음 관측이 낸다.
    if (!initial) this.observeSubagents(track, terminal);
    // 11-16: Codex 가 남긴 백그라운드 터미널로 core 가 working 을 알려도, 화면과 Codex 자기 기록이 그 턴의 끝을 보이면 끝난 턴이다.
    const background = this.codexBackground(track, terminal, screen, initial);
    // 11-16: Claude 가 뒤 작업을 남기고(또는 로그인 오류로) 턴을 끝냈는데 core 가 working 을 알린다. 화면과 Claude 자기 기록(또는 훅)이 함께 그 끝을 보이면 끝난 턴이다.
    const claude = background ? null : this.claudeQuiet(track, terminal, screen, initial);
    // A CLI that has run turns, cleared its status report and shows its normal composer has finished its turn.
    // Real 2026-11-09/10 runs: after a turn ended with an API error the report vanished; the CLI reports again only
    // after input and IAMCEO typed only after a report, so the member was dead until slept by hand.
    // A CLI that never reported (turn 0) and any screen without the composer (dialog, setup) stay blocked.
    // A turn whose end was not seen (counter moved, no report) is ended only after the gap has lasted a moment.
    const silent = track.silentSince !== null && terminal.reported !== false && (terminal.turn ?? 0) > 0 && screen !== null &&
      (providerFor(track.member) === "claude" ? inputText(screen) : codexDraft(screen)) !== null;
    track.lost = silent && ((terminal.turn ?? 0) <= track.endedTurn || this.pollNow() - track.silentSince! >= SILENT_SETTLE_MS);
    const state = track.lost || background || claude ? "done" : reported;
    // 로그인 밖의 API 오류로 끝난 턴은 core 의 error 보고처럼 쉬는 CLI 다(관측 상태 error, stateOf).
    if (track.lost || background || claude?.kind === "background" || claude?.kind === "error") status = "idle";
    // 로그인(계정) 오류로 끝난 턴: 다시 로그인해 다음 턴이 돌 때까지 막힘으로 보이고 전달은 보류한다.
    if (claude?.kind === "login") status = "blocked";
    const usage = screen !== null && state !== "working" ? usageLimitMenu(screen) : null;
    const retry = state === "working" && (screen === null ? track.setupError?.code === "network_retry" : networkRetryScreen(screen));
    if (initial && state === "error" && !track.compact) {
      track.lastError = usage?.raw ?? (terminal.status?.msg || "CLI reported an error");
      this.event(track, { type: "turn_end", memberId: track.member.id, finalText: "", isError: true, errorText: track.lastError });
    }
    // A compact OSC turn belongs exclusively to its control operation.
    if (track.compact && !["failed", "succeeded"].includes(track.compact.phase)) { await this.checkCompact(track); track.endedTurn = Math.max(track.endedTurn, terminal.turn ?? 0); }
    else if (background && !background.reported) await this.endCodexBackgroundTurn(track, terminal, background, initial);
    else if (claude && !claude.reported) await this.endClaudeQuietTurn(track, terminal, claude, initial);
    else if (!initial && !claude && ["idle", "done", "error"].includes(state || "") && (terminal.turn ?? 0) > track.endedTurn && state !== "error" && !usage && !track.lost && this.claudeIdleCompaction(track, terminal)) {
      // 11-16: 실행 기록 없이 CLI 가 쉬는 동안 스스로 압축한 것(Compacted while idle)은 턴 끝이 아니다. 끝을 알리지 않고 문맥은 압축 뒤 값으로 둔다.
    }
    else if (!initial && !claude && ["idle", "done", "error"].includes(state || "") && (terminal.turn ?? 0) > track.endedTurn) {
      track.completing = true;
      try { if (!this.manualLease(track.member.id)) await this.reportContext(track); } finally { track.completing = false; }
      this.validateTrack(track);
      track.endedTurn = terminal.turn ?? track.endedTurn;
      track.pending = false;
      // An idle report never clears an unresolved external write fence.
      // A turn read as over only because its report vanished mostly ended in an API error, so it is no proof of a
      // working connection (inferred). When the CLI's own error line sits above the composer, end it as that error.
      const failed = track.lost && !usage ? screenTurnError(screen!) : null;
      track.lastError = usage?.raw ?? (state === "error" ? terminal.status?.msg || "CLI reported an error" : failed);
      this.event(track, { type: "turn_end", memberId: track.member.id, finalText: "", isError: state === "error" || !!usage || !!failed, ...(state === "error" || usage || failed ? { errorText: track.lastError! } : {}), ...(track.lost ? { inferred: true } : {}) });
    }
    if (status === "gone") track.pending = false;
    if (screen !== null && ["idle", "done", "error"].includes(state ?? "") && !usage) {
      const draft = providerFor(track.member) === "claude" ? inputText(screen) : codexDraft(screen);
      // D2-7: 입력칸을 못 알아보던 CLI 가 빈 입력칸을 그렸으면, 글이 남아 있던 칸이 비었을 때처럼 미뤄 둔 전달을 다시 밀게 한다.
      const unseen = track.composerSeen === false;
      track.composerSeen = draft !== null;
      if (draft === "" && (track.composerEmpty === false || unseen)) {
        track.composerEmpty = true;
        this.event(track, { type: "input_ready", memberId: track.member.id });
      }
    }
    const setup = screen !== null && !usage && status === "blocked" ? (providerFor(track.member) === "claude" ? claudeFolderTrust : codexFolderTrust)(screen, track.member.cwd) : null;
    // Labels for the owner only; neither sends a key. A dialog that merely reads like folder trust is never answered.
    const unreported = status === "blocked" && !usage && !setup && !reported;
    const trustLike = unreported && screen !== null && trustDialogLike(screen, providerFor(track.member));
    const notReady = unreported && !trustLike && (terminal.turn ?? 0) === 0 && Date.now() - Date.parse(track.bindingSince) >= (this.deps.startNotReadyMs ?? 60_000);
    // 0.2.6 Y: 정해진 메모는 오류 표의 대표 문장(observation_<code>). 앱은 영어 화면에서 코드로 영어 문장을 고른다(폴더는 ': ' 뒤 그대로).
    track.setupError = usage ? { code: "usage_limit", note: usage.raw } : claude?.kind === "login" ? { code: "login_required", note: ERROR_CODES.observation_login_required.ko }
      : retry ? { code: "network_retry", note: ERROR_CODES.observation_network_retry.ko } : setup ? { code: "folder_trust", note: `${ERROR_CODES.observation_folder_trust.ko}: ${track.member.cwd}` }
      : trustLike ? { code: "trust_dialog_unrecognized", note: `${ERROR_CODES.observation_trust_dialog_unrecognized.ko}: ${track.member.cwd}` }
      : notReady ? { code: "start_not_ready", note: ERROR_CODES.observation_start_not_ready.ko } : null;
    if (usage) { status = "blocked"; track.pending = false; }
    const blockedReason = usage ? "usage_limit" : setup || claude?.kind === "login" ? "setup" : state === "blocked" ? BLOCKED_KINDS[terminal.status?.kind || ""] ?? "status_unknown" : status === "blocked" ? "status_unknown" : null;
    if (state === "error" || claude?.kind === "error") {
      if (track.statusTimer) clearTimeout(track.statusTimer);
      track.statusTimer = null; track.pendingStatus = null;
    }
    // 백그라운드 터미널 상태에 들고 날 때도 쉬는 중을 다시 알린다: 나올 때의 알림이 미뤄 둔 전달을 곧바로 다시 밀게 한다.
    const statusKey = JSON.stringify([status, blockedReason, setup?.prompt.fingerprint ?? null, usage?.fingerprint ?? null, retry, trustLike ? "trust_dialog_unrecognized" : notReady ? "start_not_ready" : null, ...(background ? ["codex_background"] : []), ...(claude ? [`claude_${claude.kind}`] : [])]);
    // While the end of a silent turn is being watched (SILENT_SETTLE_MS) nothing is blocked yet: publishing it sent the
    // owner an approval alert for a dialog that does not exist. The next observation decides.
    if (silent && !track.lost && !track.failure && blockedReason === "status_unknown") return;
    // A CLI launched a moment ago that has not reported yet is starting, not stopped at a dialog. Publishing it as
    // blocked showed 'blocked' in the roster for a few seconds and alerted the owner to an approval dialog on every wake
    // (real 2026-11-12: a member woken by hand was idle 6 s later, no dialog). A recognized dialog (folder trust, usage
    // limit) is published at once; a CLI still silent after startQuietMs is published as before.
    const starting = unreported && !trustLike && !notReady && (terminal.turn ?? 0) === 0 && Date.now() - Date.parse(track.bindingSince) < (this.deps.startQuietMs ?? 0);
    if (starting && !track.failure) return;
    if (statusKey !== track.statusKey || track.failure) {
      track.status = status;
      track.statusKey = statusKey;
      if (state === "error" && !usage) return; // Keep the error result from being overwritten by an earlier queued status.
      // Claude 자기 근거로 닫은 턴이 (로그인 밖의) API 오류로 끝났으면 core 의 error 보고와 같게 다룬다: 그 오류 결과를 쉬는 중으로 덮지 않는다.
      if (claude?.kind === "error" && !usage) return;
      this.publishStatus(track, { type: "status", memberId: track.member.id, status, blockedReason, ...(usage ? { usageLimit: usage } : {}), observation: { source: "core", observedAt: track.observedAt, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: track.setupError }, ...(status === "gone" ? { exit: { reason: terminal.reason ?? null, exitCode: terminal.exit_code ?? null } } : {}) });
    }
  }
  /** 턴 끝 실측 창·사용량. core 는 문맥 표시만 하고 자동 압축은 하지 않는다. */
  private async reportContext(track: Track): Promise<void> {
    const sessionId = track.sessionId || track.member.sessionId;
    if (!sessionId) return;
    const endedAt = Date.now();
    const turn = track.terminal.turn;
    if (providerFor(track.member) === "codex") {
      const path = this.logPath(track);
      const reading = path ? readCodexContextFile(this.providerHome(track.member), path, sessionId).reading : null;
      if (reading) this.event(track, { type: "context_usage", memberId: track.member.id, ...reading, model: reading.model ?? track.member.model });
      return;
    }
    let tokens: number | null = null;
    let model: string | null = null;
    let compacted = false;
    try {
      const path = findSessionFile(this.options.claudeHome ?? defaultClaudeHome(), track.member.cwd, sessionId);
      const tail = path ? readTranscriptTail(path) : null;
      tokens = tail?.contextTokens ?? null;
      model = tail?.model ?? null;
      compacted = !!tail?.compactedAfterUsage;
    } catch { /* unreadable transcript: the screen may still show the % */ }
    // 11-16: 마지막 응답 뒤에 CLI 가 스스로 압축했다. 상태줄·화면의 % 는 압축 전 크기일 수 있어 쓰지 않고(정확한 값으로 적지 않는다),
    // 기록의 압축 뒤 크기(postTokens)만 싣는다. 그것도 없으면 재지 않는다: 측정은 신선하지 않은 채 다음 턴 끝을 기다린다.
    if (compacted) {
      if (tokens !== null) this.event(track, { type: "context_usage", memberId: track.member.id, sessionId, tokens, shownPct: null, model: track.member.model ?? model, exact: null });
      return;
    }
    const screen = await this.call<{ text: string }>("terminal.read", { terminal: track.terminal.address, lines: 0 }, Math.min(this.rpcTimeoutMs, 1900)).then((r) => r.text, () => "");
    if (this.closed || this.tracks.get(track.member.id) !== track) return;
    const shownPct = screenContextPct(screen);
    const reading = await this.waitFor("context_file", () => (this.deps?.readContext ?? capturedContext)(this.options.contextHome, sessionId, { tokens, shownPct, model: track.member.model ?? model }, endedAt), this.deps?.contextTimeoutMs ?? 2000).catch((error): Awaited<ReturnType<typeof capturedContext>> => {
      this.operation?.getStore()?.signal.throwIfAborted();
      if (!(error instanceof CoreError) || error.kind !== "timeout") throw error;
      // Optional usage capture must not prevent an observed turn from ending.
      return { tokens, shownPct, model: track.member.model ?? model };
    });
    if (this.closed || this.tracks.get(track.member.id) !== track || (track.sessionId || track.member.sessionId) !== sessionId || track.terminal.turn !== turn) return;
    if (reading.tokens === null && reading.shownPct === null && !reading.exact) return;
    this.event(track, { type: "context_usage", memberId: track.member.id, sessionId, ...reading });
  }
  private refresh(track: Track): Promise<CoreTerminal> {
    if (track.refresh) return track.refresh;
    const startedAt = this.pollNow();
    const pending = (async () => {
      try {
        const terminal = await this.call<CoreTerminal>("terminal.get", { terminal: track.terminal.address });
        this.validateTrack(track);
        if (!this.owns(terminal, track.member) || !isProviderArgv(terminal.argv, providerFor(track.member), providerFor(track.member) === "claude" ? this.options.claudeBin : this.options.codexBin) || terminal.cwd !== track.member.cwd) throw new CoreError("conflict", "Core terminal ownership changed");
        if (!this.manualLease(track.member.id)) this.discoverBinding(track);
        await this.observe(track, terminal);
        track.failures = 0; track.failure = null;
        // Lifted: tell the orchestrator to push the deliveries it had been holding back.
        if (!this.sending.has(track.member.id) && this.settleUncertain(track, undefined, true)) this.event(track, { type: "input_ready", memberId: track.member.id });
        return track.terminal;
      } catch (error) {
        const previousFailure = track.failure;
        track.failures++; track.failure = error instanceof CoreError ? error.kind : "error";
        if (!this.closed && this.tracks.get(track.member.id) === track && previousFailure !== track.failure && track.failure !== "not_found") this.publishStatus(track, { type: "status", memberId: track.member.id, status: track.status as "working" | "idle" | "blocked" | "gone" || "blocked",
          observation: { source: "core", observedAt: track.observedAt, freshness: "stale", ownership: track.failure === "conflict" ? "conflict" : "unknown", consecutiveFailures: track.failures, error: { code: track.failure, note: "Core terminal observation failed; retry read-only inspection" } } });
        throw error;
      }
    })().finally(() => {
      if (track.refresh === pending) track.refresh = null;
      // A slow read is local to this employee, even when it eventually succeeds.
      const completedAt = this.pollNow();
      const delayed = track.failures > 0 || completedAt - startedAt >= this.pollMs;
      track.pollDelay = delayed
        ? Math.min(Math.max(this.pollMs, 30_000), track.pollDelay * 2) : this.pollMs;
      track.nextPollAt = delayed ? completedAt + track.pollDelay : startedAt + this.pollMs;
    });
    track.refresh = pending;
    return pending;
  }
  /**
   * 0.2.7(D2-7): 쉬는 중을 알렸지만 마지막으로 본 화면에서 입력칸을 알아보지 못했다. 지금 넣으면 send 가 같은 화면 판독으로 거절하고
   * (input_busy, 'Cannot identify an empty CLI composer') 실패 실행 기록만 남는다. 입력칸이 보이면 input_ready 로 알린다.
   */
  composerUnidentified(memberId: string): boolean {
    const track = this.tracks.get(memberId);
    if (!track || track.composerSeen !== false || track.terminal.state !== "live") return false;
    return ["idle", "done", "error"].includes(this.stateOf(track, track.terminal) ?? "");
  }
  observationState(memberId: string): { observedAt: string; failures: number; failure: string | null; lastError: string | null; identity: RunnerTerminalIdentity; inputEpoch: number; setupError: Track["setupError"]; turn: number | null; state: string | null; composerEmpty: boolean | null } | null {
    const track = this.tracks.get(memberId);
    // composerEmpty: 마지막으로 본 입력칸이 비었는가(넣기 직전의 확인, 쉬는 CLI 화면 관측). 모르면 null.
    return track ? { observedAt: track.observedAt, failures: track.failures, failure: track.failure, lastError: track.lastError, identity: this.identity(track), inputEpoch: track.epoch, setupError: track.setupError, composerEmpty: track.composerEmpty,
      // A finished turn whose report vanished reads as done here too, exactly as send() judges it.
      turn: track.terminal.state === "live" ? track.terminal.turn ?? null : null, state: track.terminal.state === "live" ? this.stateOf(track, track.terminal) ?? null : null } : null;
  }
  private get pollMs(): number { return Math.max(1, this.deps.pollMs ?? 1000); }
  private pollNow(): number { return (this.deps.pollNow ?? Date.now)(); }
  private poll(): void {
    if (this.closed) return;
    const limit = Math.max(1, Math.floor(this.deps.pollConcurrency ?? 4));
    const active = new Set([...this.polling, ...[...this.tracks.values()].filter(track => track.refresh)]);
    const now = this.pollNow();
    const due = [...this.tracks.values()].filter(track => !track.refresh && !this.polling.has(track) && track.nextPollAt <= now)
      .sort((a, b) => a.nextPollAt - b.nextPollAt);
    for (const track of due) {
      if (active.size >= limit) break;
      active.add(track); this.polling.add(track);
      void this.refresh(track).catch(async error => {
        // A socket outage is not proof a holder died. Only not_found ends it.
        if (!this.closed && this.tracks.get(track.member.id) === track && error instanceof CoreError && error.kind === "not_found") {
          await this.observe(track, { ...track.terminal, state: "finished", reason: "not_found" });
        }
      }).catch(() => undefined).finally(() => {
        this.polling.delete(track);
        this.poll();
      });
    }
  }
  isBusy(memberId: string): boolean {
    const track = this.tracks.get(memberId);
    return !!track && (this.turnBusy(track) ||
      // 턴은 끝났어도 Codex 의 백그라운드 터미널이 남아 core 가 working 인 동안은 입력을 넣지 않는다(codexBackground).
      !!this.codexWatch.get(track)?.state);
  }
  /**
   * 턴은 끝났고 Codex 가 남긴 백그라운드 터미널 때문에만 바쁜 팀장(codexBackground)이면 그 터미널 수, 아니면 null.
   * 다른 까닭(입력 중·결과 모름·압축·정말 일하는 중)으로도 바쁘면 null 이다. 총괄이 잠재우기·보관·CLI 바꾸기 거절의 까닭과
   * 잠재울 후보를 가를 때 쓴다(바쁨 판정 자체는 isBusy 그대로).
   */
  backgroundTerminals(memberId: string): number | null {
    return this.codexLingering(memberId)?.terminals ?? null;
  }
  /** 0.2.7 배포 전 확인 검토: backgroundTerminals 와 같은 상태를 처음 본 때(벽시계 ms). 그 상태가 아니면 null. */
  backgroundSince(memberId: string): number | null {
    return this.codexLingering(memberId)?.since ?? null;
  }
  private codexLingering(memberId: string): CodexBackground | null {
    const track = this.tracks.get(memberId);
    const state = track ? this.codexWatch.get(track)?.state : null;
    return track && state && !this.turnBusy(track) ? state : null;
  }
  /**
   * 11-16: 턴은 끝났고 Claude 가 띄운 뒤 작업 때문에만 core 가 working 인 팀장(claudeQuiet background)인가. 다른 까닭(입력 중·결과 모름·압축·
   * 정말 일하는 중)으로 바쁘면 false. 이 팀장은 입력을 받지만(isBusy false), 잠재우기·보관·CLI 바꾸기·설정 적용·압축은 그 작업을 죽이므로 하지 않는다.
   */
  claudeBackground(memberId: string): boolean {
    const track = this.tracks.get(memberId);
    return !!track && this.claudeLingers(track) && !this.turnBusy(track);
  }
  /**
   * 0.2.7(D2-5): 이 팀장의 지금 세션 기록이 마지막으로 쓰인 때(파일 mtime, ISO). CLI 가 일하며 기록에 줄을 더하면 오른다.
   * 업무의 '마지막 진전'(실행 기록 lastProgressAt)을 앞당기는 데만 쓴다(턴 끝·입력 판정에는 쓰지 않는다). 상태 사건·건강 확인마다 불리므로
   * 이미 아는 경로만 본다: Claude 는 작업 폴더의 기록 경로, Codex 는 이미 찾아 둔 rollout. 폴더를 훑지 않는다. 모르면 null.
   */
  logWrittenAt(memberId: string): string | null {
    const track = this.tracks.get(memberId);
    if (!track?.sessionId) return null;
    let path: string | null = null;
    if (providerFor(track.member) === "claude") path = transcriptPath(track.member.cwd, track.sessionId, this.providerHome(track.member));
    else if (track.logFile?.sessionId === track.sessionId) path = track.logFile.path;
    else {
      const matches = track.binding?.files.filter(file => file.matched && !file.invalid && file.meta?.sessionId === track.sessionId) ?? [];
      if (matches.length === 1) path = matches[0]!.path;
    }
    if (!path) return null;
    try {
      const stat = statSync(path);
      return stat.isFile() ? new Date(stat.mtimeMs).toISOString() : null;
    } catch { return null; }
  }
  private turnBusy(track: Track): boolean {
    return track.pending || track.uncertain || track.restorePending || track.completing || track.status === "working" || !!track.compact && !["failed", "succeeded"].includes(track.compact.phase);
  }
  occupiesTurnSlot(memberId: string): boolean {
    const track = this.tracks.get(memberId);
    if (!track) return false;
    const compacting = !!track.compact && !["failed", "succeeded"].includes(track.compact.phase);
    // Real 2026-11-07 run: one needs_owner delivery left its track "uncertain" while the CLI sat idle, and that
    // phantom turn halved maxConcurrentTurns=2 for every other member. Unknown input on an observed-idle CLI
    // stays fenced for delivery, but it is not a running turn.
    const observedQuiet = track.status === "idle"; // includes done; a blocked CLI may be paused mid-turn and still counts
    return track.pending || track.completing || track.status === "working" || compacting || (track.uncertain && !observedQuiet);
  }
  async send(member: RunnerMember, text: string, opts: StartOpts, _urgent = false): Promise<SendResult> {
    if (!cleanText(text).trim()) return unsupported("Message is empty");
    if (this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: "CLI configuration is being reloaded" };
    if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written", detail: "Manual terminal control is active" };
    if (this.sending.has(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
    this.sending.add(member.id);
    let track = this.tracks.get(member.id);
    let deliveryAttempted = false;
    try {
      if (!track) { await this.startLocked(member, opts); track = this.tracks.get(member.id)!; }
      this.assertMember(track, member);
      this.settleUncertain(track, opts.marker);
      if (track.pending || track.uncertain || track.restorePending || track.completing || track.compact && !["failed", "succeeded"].includes(track.compact.phase)) return { ok: false, reason: "busy", retryable: false, deliveryEffect: "not_written", detail: "A previous send is still running or delivery is uncertain; inspect the terminal" };
      const terminal = await this.refresh(track);
      if (terminal.state !== "live") return { ok: false, reason: "gone", retryable: false, deliveryEffect: "not_written" };
      const state = this.stateOf(track, terminal);
      if (state === "working") return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      if (state === "blocked") return { ok: false, reason: "blocked", retryable: true, deliveryEffect: "not_written", detail: `Complete the CLI dialog with iamceo attach ${member.id}` };
      if (!["idle", "done", "error"].includes(state || "")) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: `No trustworthy idle OSC 7501 status; inspect CLI setup with iamceo attach ${member.id} (status=${JSON.stringify(terminal.status?.state ?? null)}, turn=${terminal.turn ?? null}, reported=${terminal.reported ?? null})` };
      let inputEpoch = track.epoch;
      let screen = await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 });
      const usage = usageLimitMenu(screen.text);
      if (usage) {
        track.status = "blocked";
        track.statusKey = JSON.stringify(["blocked", "usage_limit", null, usage.fingerprint, false]);
        track.setupError = { code: "usage_limit", note: usage.raw };
        this.publishStatus(track, { type: "status", memberId: member.id, status: "blocked", blockedReason: "usage_limit", usageLimit: usage,
          observation: { source: "core", observedAt: track.observedAt, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: track.setupError } });
        return { ok: false, reason: "blocked", retryable: true, deliveryEffect: "not_written", detail: "사용 한도 메뉴는 확인 후 Esc로만 닫을 수 있습니다" };
      }
      // Never erase a person's draft or deliver through an unidentified dialog.
      // An empty composer never establishes readiness; only the OSC gate above can permit input.
      let draft = providerFor(member) === "claude" ? inputText(screen.text) : codexDraft(screen.text);
      // 0.2.7 배포 전 확인(real-cli P3): 멈춘 압축의 명령을 Claude 가 입력칸에 되돌렸으면(IAMCEO 가 넣은 글과 글자까지 같을 때만) 지우고 다시 읽는다.
      // 지운 뒤에는 화면이 빈 입력칸을 보일 때까지만(최대 열 번 읽기) 기다린다. 비지 않으면 지금처럼 넣지 않는다(다음 시도가 다시 본다. 키는 다시 누르지 않는다).
      if (draft && await this.clearCompactDraft(track, terminal, draft)) {
        for (let read = 0; read < 10; read++) {
          if (read) await Bun.sleep(100);
          this.validateTrack(track);
          screen = await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 });
          draft = inputText(screen.text);
          if (draft === "") break;
        }
        inputEpoch = track.epoch;
      }
      track.composerEmpty = draft === "";
      track.composerSeen = draft !== null;
      if (draft !== "") return { ok: false, reason: "input_busy", retryable: false, deliveryEffect: "not_written", detail: draft === null ? "Cannot identify an empty CLI composer" : "A user draft is present; IAMCEO leaves it untouched" };
      // 11-16: 뒤 작업만 남은 Claude, 로그인 밖의 API 오류로 턴을 끝낸 Claude 에는 넣는다(core 에게는 working). 넣기 직전에 화면(일하는 중의
      // 상태 줄 없음)과 Claude 자기 기록(지금 업무의 턴이 닫혀 있음)으로 다시 본다. 그 사이 뒤 작업 알림으로 Claude 가 스스로 새 턴을 열었으면
      // 넣지 않는다(다음 관측이 다시 정한다).
      const quietInput = this.claudeTakesInput(track, terminal);
      if (quietInput && !this.stillClaudeQuiet(track, screen.text)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: "Claude started a turn of its own; waiting for it to end" };
      const preference = this.parallelPreferences.get(member.id) ?? member.parallel;
      const prefix = providerFor(member) === "codex" && preference !== undefined
        ? (preference ? "IAMCEO execution preference: Use native subagents for independent work in parallel when useful; retain your normal approvals and tool access.\n\n" : "IAMCEO execution preference: Work sequentially for this task; do not spawn subagents.\n\n") : "";
      const binding = providerFor(member) === "codex" && !track.sessionId && track.nonce ? codexBindingMarker(track.nonce) + "\n\n" : "";
      const cleaned = cleanText(binding + prefix + text);
      if (!cleaned.trim()) return unsupported("Message is empty");
      // Core generation 1 only permits if:idle|working. A done/error report has
      // no exact conditional; force:false still refuses any approval dialog.
      // IAMCEO manual controls use a lease; direct external attach cannot be
      // made atomic with this guard by the current core API.
      if (this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written", detail: "Manual terminal control is active" };
      const current = await this.refresh(track);
      this.validateTrack(track);
      if (current.state !== "live" || this.stateOf(track, current) !== state || track.epoch !== inputEpoch) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      track.pending = true; this.bump(track);
      deliveryAttempted = true;
      // 그런 Claude 는 core 에게 working 이다. if:"working" 으로 그 사이 승인 창(blocked)·끝남(idle)으로 바뀌었으면 넣지 않게 한다.
      const result = await this.call<{ turn: number; started?: boolean | null }>("terminal.send", { terminal: terminal.address, text: cleaned, ...(state === "idle" ? { if: "idle" } : quietInput ? { if: "working" } : {}), force: false, wait: false }, this.sendTimeoutMs);
      if (!Number.isSafeInteger(result.turn)) throw new CoreError("protocol", "Send reply has no valid turn counter", true);
      this.hookShadow?.sent(member.id, providerFor(member), { sessionId: track.sessionId, text: cleaned });
      // started:false still means paste+Enter was delivered. Never resend it.
      await this.refresh(track).catch(() => undefined);
      return { ok: true, started: result.started ?? null, turn: result.turn };
    } catch (error) {
      if (track && deliveryAttempted && (!(error instanceof CoreError) || error.uncertain)) { track.pending = false; track.uncertain = true; track.controlUncertain ||= !opts.marker; return { ...unsupported(`Delivery may have occurred; do not resend automatically. ${error instanceof Error ? error.message : String(error)}`), deliveryEffect: "unknown" }; }
      if (track && deliveryAttempted) track.pending = false;
      if (error instanceof CoreError && ["blocked", "status_mismatch", "busy"].includes(error.kind)) return { ok: false, reason: error.kind === "blocked" ? "blocked" : "busy", retryable: true, detail: error.message, deliveryEffect: deliveryAttempted ? "rejected" : "not_written" };
      return { ok: false, reason: error instanceof CoreError && error.deliveryEffect === "not_written" ? "down" : "error", retryable: error instanceof CoreError && error.deliveryEffect === "not_written", deliveryEffect: !deliveryAttempted ? "not_written" : error instanceof CoreError ? error.deliveryEffect : "unknown", detail: error instanceof Error ? error.message : String(error) };
    } finally { this.sending.delete(member.id); }
  }

  /** False only when the provider's own store holds no record of this session; an unreadable store is not proof. */
  sessionExists(member: RunnerMember): boolean {
    if (!member.sessionId) return false;
    const home = this.providerHome(member);
    if (providerFor(member) === "claude") {
      if (existsSync(transcriptPath(member.cwd, member.sessionId, home))) return true;
      // A session that changed directory is recorded under another project folder. Only a missing store is absence.
      const projects = join(home, "projects");
      try { return readdirSync(projects).some(dir => existsSync(join(projects, dir, `${member.sessionId}.jsonl`))); }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
    }
    try {
      for (const _ of new Bun.Glob(`**/rollout-*-${member.sessionId}.jsonl`).scanSync({ cwd: join(home, "sessions"), onlyFiles: true, followSymlinks: false })) return true;
      return false;
    } catch { return true; }
  }
  private providerHome(member: RunnerMember): string {
    return providerFor(member) === "claude" ? this.options.claudeHome ?? defaultClaudeHome() : this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  }
  private discoverBinding(track: Track): void {
    if (providerFor(track.member) !== "codex" || track.sessionId || !track.nonce || track.member.sessionGeneration === undefined) return;
    const result = discoverCodexSession({ home: this.providerHome(track.member), cwd: track.member.cwd, generation: track.member.sessionGeneration, nonce: track.nonce, since: track.bindingSince, cursor: track.binding });
    track.binding = result.cursor;
    if (result.outcome === "bound" && result.sessionId) {
      track.sessionId = result.sessionId;
      this.event(track, { type: "session", memberId: track.member.id, sessionId: result.sessionId });
    }
  }
  /**
   * 11-16 라이브: Codex 는 턴을 끝냈어도 자기가 띄운 백그라운드 터미널(exec 세션)이 살아 있으면 core 에 working 으로 보인다.
   * 화면이 빈 입력칸·진행 줄 없음·'N background terminal(s) running'(codexBackgroundTerminals)이고, Codex 자기 기록이 지금 업무의 턴이
   * 끝났다고 보이면(codex-turn.ts) 그 상태를 돌려준다. 그 밖에는 null 이고 지금처럼 core 의 working 을 따른다. 시간만으로는 정하지 않는다.
   * 이 상태에서도 입력은 넣지 않는다(isBusy): core 의 turn 번호는 working 이 끝날 때에야 올라, 넣은 다음 턴의 끝을 가려낼 수 없다.
   * 백그라운드 프로그램을 끄지도 않는다. 그것이 끝나 core 가 쉬는 중을 알리면 평소대로 이어 간다.
   */
  private codexBackground(track: Track, terminal: CoreTerminal, screen: string | null, initial: boolean): CodexBackground | null {
    if (providerFor(track.member) !== "codex") return null;
    let watch = this.codexWatch.get(track);
    if (!watch) this.codexWatch.set(track, watch = { state: null, cursor: null, unverified: null });
    const turn = terminal.turn ?? 0;
    if (terminal.state !== "live" || terminal.status?.state !== "working" || !!track.compact && !["failed", "succeeded"].includes(track.compact.phase)) {
      watch.unverified = null;
      return watch.state = null;
    }
    const previous = watch.state?.turn === turn ? watch.state : null;
    // 입력 직전의 관측은 화면을 읽지 않는다(그 시도의 기한을 쓰지 않게). 같은 working·같은 turn 번호면 앞 판정을 잇는다.
    if (screen === null) return watch.state = previous;
    const terminals = codexBackgroundTerminals(screen);
    if (terminals === null) { watch.unverified = null; return watch.state = null; }
    // 사람이 터미널을 쥐고 있으면 기록을 새로 읽지 않는다(inspectLocked 와 같다). 화면이 그 모양 그대로면 앞 판정을 잇는다.
    if (this.manualLease(track.member.id)) return watch.state = previous && { ...previous, terminals };
    const verdict = this.codexTurnEnd(track, watch);
    if (verdict.outcome === "ended") {
      watch.unverified = null;
      // 붙는 순간의 첫 관측에서는 아직 닫지 않은 업무의 턴 끝을 내지 않는다. 다음 관측이 턴 끝을 먼저 내고 쉬는 중을 알린다
      // (쉬는 중을 먼저 알리면 열린 업무 때문에 '진전 없음' 표시가 쉬는 팀장에 붙는다). 이미 닫힌 업무면(재시작) 곧바로 쉬는 중이다.
      if (initial && !verdict.runEnded) return watch.state = null;
      return watch.state = { turn, terminals, runEnded: verdict.runEnded, reported: previous?.reported ?? false, aborted: previous?.aborted ?? verdict.code === "turn_aborted", since: previous?.since ?? Date.now() };
    }
    // 열린 턴(running)은 정말 일하는 중이다. 아직 읽는 중이거나 덜 쓴 줄이면 다음 관측이 이어 읽는다.
    if (verdict.outcome === "unknown" && !["scan_pending", "partial_log"].includes(verdict.code)) this.noteCodexBackground(track, watch, terminal, terminals, verdict.code);
    else watch.unverified = null;
    return watch.state = null;
  }
  /** 지금 업무(이 세대에서 입력이 들어간 마지막 실행)의 턴이 Codex 기록에서 끝났는가. 같은 세대·같은 터미널·같은 세션의 기록만 본다. */
  private codexTurnEnd(track: Track, watch: CodexBackgroundWatch): { outcome: "ended" | "running" | "unknown"; code: string; runEnded: boolean } {
    const unknown = (code: string) => ({ outcome: "unknown" as const, code, runEnded: false });
    const generation = track.member.sessionGeneration;
    if (!track.sessionId) return unknown("session_unbound");
    const path = this.logPath(track);
    if (!path) return unknown("log_missing");
    let run: { dispatch: DeliveryDispatch | null; ended: boolean } | null;
    try { run = generation === undefined ? null : this.deps.recoveryStore?.lastWrittenRun?.(track.member.id, generation) ?? null; }
    catch { return unknown("store_unreadable"); }
    const dispatch = run?.dispatch;
    if (!run || !dispatch || dispatch.memberId !== track.member.id || dispatch.cli !== "codex" || dispatch.backend !== "core") return unknown("no_dispatch");
    if (dispatch.identity.sessionGeneration !== generation || dispatch.identity.terminalId !== track.terminal.address || (dispatch.identity.sessionId !== null && dispatch.identity.sessionId !== track.sessionId)) return unknown("other_terminal");
    const home = this.providerHome(track.member), root = join(home, "sessions"), target = providerLogPath(root, path);
    // 봉투를 쓸 때 세션을 몰랐으면(첫 전달) 기록 기준선이 없다. 그때는 그 전달의 표지가 든 사용자 글부터 센다.
    const log = target ? dispatch.baseline.logs.find(item => providerLogPath(root, item.path) === target) : undefined;
    const result = readCodexTurnEnd({ home, path, sessionId: track.sessionId, cwd: track.member.cwd, baseline: log ? { offset: log.offset, fileIdentity: log.fileIdentity } : null,
      markers: [dispatch.bundleMarker, ...dispatch.markers.map(item => item.marker)] }, watch.cursor);
    watch.cursor = result.cursor;
    return { outcome: result.outcome, code: result.code, runEnded: run.ended };
  }
  /** 백그라운드 터미널 상태로 끝난 턴을 평소의 턴 끝(성공)으로 알리고, 팀장 활동에 그 프로그램이 남아 있다는 줄을 한 번 남긴다. */
  private async endCodexBackgroundTurn(track: Track, terminal: CoreTerminal, background: CodexBackground, initial: boolean): Promise<void> {
    background.reported = true;
    // core 의 turn 번호는 이 working 이 끝날 때 하나 오른다. 그것은 이 턴의 끝이므로 그때 다시 알리지 않는다.
    track.endedTurn = Math.max(track.endedTurn, (terminal.turn ?? 0) + 1);
    track.pending = false;
    // 붙는 순간(재시작 뒤)에는 이미 닫힌 업무만 여기 온다. 활동 줄도 이미 남았다.
    if (initial) return;
    if (!background.runEnded) {
      // 이 끝의 문맥 측정(reportContext 의 context_usage)은 지금 core turn 번호(working 이 이어지는 동안의 번호)를 싣는다. 직접 조작 중이면 재지 않는다.
      const leased = !!this.manualLease(track.member.id);
      const measuredTurn = leased ? null : track.terminal.turn ?? null;
      track.completing = true;
      try { if (!leased) await this.reportContext(track); } finally { track.completing = false; }
      this.validateTrack(track);
      track.lastError = null;
      // turn 번호는 비운다. 끝을 나타낼 번호(위의 +1)는 core 가 아직 내지 않았다. 미리 쓰면 같은 working 의 다음 관측들이 지난 turn 으로 버려진다.
      // 대신 측정의 번호를 contextTurn 으로 실어, 총괄이 '방금 끝난 턴의 측정'으로 알아보게 한다(자동 압축, orchestrator pump 의 exact).
      this.event(track, { type: "turn_end", memberId: track.member.id, finalText: "", isError: false, reason: "codex_background_terminal", turn: null, ...(measuredTurn !== null ? { contextTurn: measuredTurn } : {}) });
    }
    // 멈춘 턴(중단·급한 지시)이면 '턴은 멈췄지만 실행하던 명령이 계속 돈다'고 쓴다. 그 명령이 끝나거나 /stop 으로 닫아야 다음 전달이 들어간다.
    this.event(track, { type: "activity", memberId: track.member.id, kind: "system", notice: true,
      text: textRef(background.aborted ? "activity.codex_background_after_stop" : "activity.codex_background_left", { count: String(background.terminals) }), eventKey: this.codexBackgroundKey(track, terminal, "left") });
  }
  /** 턴 끝을 확인하지 못한 까닭이 같은 working 에서 backgroundNoticeMs 동안 이어지면 서버 기록과 팀장 활동에 한 번 남긴다. 판정은 그대로다. */
  private noteCodexBackground(track: Track, watch: CodexBackgroundWatch, terminal: CoreTerminal, terminals: number, code: string): void {
    const turn = terminal.turn ?? 0, now = this.pollNow();
    if (watch.unverified?.turn !== turn || watch.unverified.code !== code) watch.unverified = { turn, code, since: now, noted: watch.unverified?.turn === turn && watch.unverified.noted };
    if (watch.unverified.noted || now - watch.unverified.since < (this.deps.backgroundNoticeMs ?? 30_000)) return;
    watch.unverified.noted = true;
    const why = ["session_unbound", "log_missing", "path_unavailable"].includes(code) ? "why.codex_log_unbound" as const
      : ["no_dispatch", "other_terminal", "marker_missing", "no_turn_complete", "turn_aborted"].includes(code) ? "why.codex_turn_unconfirmed" as const : "why.codex_log_unreadable" as const;
    console.warn(`[codex] ${track.member.id}: 백그라운드 터미널 ${terminals}개가 남아 실행 엔진이 일하는 중으로 알립니다. 턴 끝을 Codex 기록으로 확인하지 못해 그대로 둡니다 (${code})`);
    this.event(track, { type: "activity", memberId: track.member.id, kind: "system", notice: true,
      text: textRef("activity.codex_background_unverified", { count: String(terminals), why: textRef(why) }), eventKey: this.codexBackgroundKey(track, terminal, "unverified") });
  }
  private codexBackgroundKey(track: Track, terminal: CoreTerminal, kind: "left" | "unverified"): string {
    return `codex_background_${kind}:${track.member.id}:${track.member.sessionGeneration ?? -1}:${terminal.address}:${terminal.turn ?? 0}`;
  }
  /**
   * 11-16 라이브: Claude 가 뒤 작업(Workflow·백그라운드 에이전트·셸·Monitor)을 띄우고 턴을 끝내면 core 는 그 작업이 끝날 때까지 working 을 알린다
   * (라이브: 3시간 10분 동안 '일하는 중', 대표 전달 3건이 묶임). 로그인 오류로 끝난 턴에서도 core 가 끝을 알리지 않았다(99분).
   * core 가 working 이라도 화면이 입력을 받을 수 있고(claudeQuietScreen: 빈 입력칸, 일하는 중의 상태 줄 없음), 지금 업무(이 세대에서 입력이 들어간
   * 마지막 실행)의 봉투 기준선 뒤 Claude 자기 기록(같은 세션의 stop_hook_summary·turn_duration)이 그 턴을 닫았으면 끝난 턴이다. 기록으로 정하지 못하면
   * 봉투를 쓰기 직전의 훅 자리 뒤에 덧붙은 같은 세션의 Stop·StopFailure 를 본다(핫픽스 A 의 자리 묶기·신뢰 검사). 시간만으로는 정하지 않는다.
   * 그 턴이 로그인(계정) 오류로 끝났으면 login, 로그인 밖의 API 오류로 끝났으면 error, 아니면 background 다. 그 밖에는 null 이고 지금처럼 core 의
   * working 을 따른다.
   * 업무가 이미 끝났어도(재시작 뒤, 스스로 연 턴 뒤) 같은 판정으로 쉬는 중을 보인다. 열린 턴(뒤 작업 알림으로 Claude 가 스스로 연 턴)이면 null(일하는 중).
   */
  private claudeQuiet(track: Track, terminal: CoreTerminal, screen: string | null, initial: boolean): ClaudeQuiet | null {
    if (providerFor(track.member) !== "claude") return null;
    let watch = this.claudeWatch.get(track);
    if (!watch) this.claudeWatch.set(track, watch = { state: null, cursor: null, hook: null, closedRun: null });
    const turn = terminal.turn ?? 0;
    if (terminal.state !== "live" || terminal.status?.state !== "working" || !!track.compact && !["failed", "succeeded"].includes(track.compact.phase)) return watch.state = null;
    const previous = watch.state?.turn === turn ? watch.state : null;
    // 입력 직전의 관측은 화면을 읽지 않는다(그 시도의 기한을 쓰지 않게). 같은 working·같은 turn 번호면 앞 판정을 잇는다. 넣기 직전에 send 가 다시 본다.
    if (screen === null) return watch.state = previous;
    // 사람이 터미널을 쥐고 있으면 기록을 새로 읽지 않는다(inspectLocked 와 같다).
    if (this.manualLease(track.member.id)) return watch.state = previous;
    const quiet = claudeQuietScreen(screen);
    if (!quiet) return watch.state = null;
    const verdict = this.claudeTurnVerdict(track, watch);
    if (verdict.outcome !== "ended" || !verdict.runId) return watch.state = null;
    // 붙는 순간의 첫 관측에서는 아직 닫지 않은 업무를 닫지 않는다. 다음 관측이 턴 끝을 먼저 내고 쉬는 중을 알린다(Codex 와 같다).
    if (initial && !verdict.runEnded) return watch.state = null;
    const kind = !verdict.error ? "background" : CLAUDE_LOGIN_ERRORS.has(verdict.error.error) ? "login" : "error";
    const same = previous?.kind === kind && previous.runId === verdict.runId ? previous : null;
    return watch.state = { kind, turn, runId: verdict.runId, runEnded: verdict.runEnded, reported: !!same?.reported || verdict.runEnded || watch.closedRun === verdict.runId, error: verdict.error, label: quiet.label };
  }
  /**
   * 0.2.7(묶음 6): 이 팀장에게서 지금 돌고 있는 서브에이전트 수를 CLI 자기 기록으로 잰다(server/runner/subagents.ts). 읽기만 하고,
   * 값(quality·count)이 바뀔 때만 subagents 사건을 낸다. 판정(상태·전달)은 바꾸지 않는다. 읽지 못하면 unknown 이다(시간만으로 0 으로 두지 않는다).
   */
  private observeSubagents(track: Track, terminal: CoreTerminal): void {
    let watch = this.subagentWatch.get(track);
    if (!watch) this.subagentWatch.set(track, watch = { claude: null, codex: null, path: null, key: null });
    let reading: SubagentReading;
    try { reading = this.readSubagents(track, terminal, watch); }
    catch { reading = { quality: "unknown", count: null, code: "read_failed" }; }
    const key = `${reading.quality}:${reading.count}`;
    if (key === watch.key) return;
    watch.key = key;
    this.event(track, { type: "subagents", memberId: track.member.id, quality: reading.quality, count: reading.quality === "unknown" ? null : reading.count });
  }
  private readSubagents(track: Track, terminal: CoreTerminal, watch: SubagentWatch): SubagentReading {
    const unknown = (code: string): SubagentReading => ({ quality: "unknown", count: null, code });
    if (terminal.state !== "live") return unknown("terminal_gone");
    if (!track.sessionId) return unknown("session_unbound");
    // 이 CLI 를 띄운 시각(터미널 라벨 iamceo.startedAt, 0.2.0 부터 모든 터미널에 있다). 앞 프로세스의 뒤 작업은 그 프로세스와 함께 끝났다.
    // 라벨이 없으면 붙은 시각(bindingSince)으로 대신하지 않는다: 그 앞의 띄움을 앞 프로세스의 것으로 버려 0 을 정확한 값처럼 낼 수 있다.
    const started = terminal.labels?.["iamceo.startedAt"];
    if (!started) return unknown("since_unknown");
    const since = Date.parse(started);
    const home = this.providerHome(track.member);
    if (providerFor(track.member) === "codex") {
      const read = readCodexSubagents({ home, sessionId: track.sessionId, since, now: Date.now() }, watch.codex);
      watch.codex = read.state;
      return read;
    }
    // 세션 안에서 cd 하면 기록이 다른 폴더 아래에 있다(findSessionFile 이 projects 를 훑는다). 찾은 자리는 기억해 둔다.
    if (!watch.path || !watch.path.endsWith(`${track.sessionId}.jsonl`) || !existsSync(watch.path)) { watch.path = this.logPath(track); watch.claude = null; }
    if (!watch.path) return unknown("log_missing");
    const read = readClaudeSubagents({ home, path: watch.path, sessionId: track.sessionId, since }, watch.claude);
    watch.claude = read.cursor;
    return read;
  }
  /** 지금 업무의 턴이 Claude 자기 기록(없으면 훅)에서 닫혔는가. 같은 세대·같은 터미널·같은 세션의 봉투와 기록만 본다. */
  private claudeTurnVerdict(track: Track, watch: ClaudeWatch): { outcome: "ended" | "running" | "unknown"; code: string; error: ClaudeTurnError | null; runId: string | null; runEnded: boolean } {
    const unknown = (code: string) => ({ outcome: "unknown" as const, code, error: null, runId: null, runEnded: false });
    const generation = track.member.sessionGeneration;
    if (!track.sessionId) return unknown("session_unbound");
    let run: { dispatch: DeliveryDispatch | null; ended: boolean } | null;
    try { run = generation === undefined ? null : this.deps.recoveryStore?.lastWrittenRun?.(track.member.id, generation) ?? null; }
    catch { return unknown("store_unreadable"); }
    const dispatch = run?.dispatch;
    if (!run || !dispatch || dispatch.memberId !== track.member.id || dispatch.cli !== "claude" || dispatch.backend !== "core") return unknown("no_dispatch");
    if (dispatch.identity.sessionGeneration !== generation || dispatch.identity.terminalId !== track.terminal.address || (dispatch.identity.sessionId !== null && dispatch.identity.sessionId !== track.sessionId)) return unknown("other_terminal");
    const ids = { runId: dispatch.dispatchId, runEnded: run.ended };
    const markers = [dispatch.bundleMarker, ...dispatch.markers.map(item => item.marker)];
    const home = this.providerHome(track.member), root = join(home, "projects"), path = this.logPath(track);
    const target = path ? providerLogPath(root, path) : null;
    // 봉투의 기록 기준선(쓰기 직전의 기록 끝). 없으면 기록으로는 정하지 않는다(수백 MB 기록을 처음부터 읽지 않는다).
    const log = target ? dispatch.baseline.logs.find(item => providerLogPath(root, item.path) === target) : undefined;
    let record: { outcome: "ended" | "running" | "unknown"; code: string; error: ClaudeTurnError | null } = { outcome: "unknown", code: path ? "no_baseline" : "log_missing", error: null };
    if (path && log) {
      const read = readClaudeTurn({ home, path, sessionId: track.sessionId, baseline: { offset: log.offset, fileIdentity: log.fileIdentity }, markers }, watch.cursor);
      watch.cursor = read.cursor;
      record = read;
    }
    if (record.outcome !== "unknown") return { ...record, ...ids };
    return { ...(this.claudeHookVerdict(track, watch, dispatch, markers) ?? record), ...ids };
  }
  /**
   * 기록으로 정하지 못한 턴을 훅으로 본다. 봉투를 쓰기 직전의 사건 파일 자리(baseline.hookMark) 뒤에 덧붙은 줄만, 믿을 수 있는 사건 파일에서만 읽는다
   * (핫픽스 A 의 압축 끝 훅과 같은 묶기). 자리가 없는 봉투(이 칸을 모르던 서버가 썼거나 자리를 읽지 못함)는 훅으로 정하지 않는다.
   */
  private claudeHookVerdict(track: Track, watch: ClaudeWatch, dispatch: DeliveryDispatch, markers: string[]): { outcome: "ended" | "running"; code: string; error: ClaudeTurnError | null } | null {
    const mark = dispatch.baseline.hookMark;
    if (!this.hookEvents || !track.sessionId || !isHookEventsMark(mark)) return null;
    if (watch.hook?.runId !== dispatch.dispatchId) {
      try { watch.hook = { runId: dispatch.dispatchId, reader: new HookEventReader(this.hookEvents, track.member.id, undefined, mark), state: { anchored: false, open: false, ended: 0, last: null } }; }
      catch { watch.hook = null; return null; }
    }
    if (!hookEventsTrusted(this.hookEvents, track.member.id)) return null;
    let records: ReturnType<HookEventReader["read"]>["records"];
    try { records = watch.hook.reader.read().records; } catch { return null; }
    const verdict = claudeHookTurn(watch.hook.state, records, track.sessionId, markers);
    return verdict.outcome === "unknown" ? null : { outcome: verdict.outcome, code: verdict.code, error: verdict.error };
  }
  /**
   * 넣기 직전: 지금도 입력을 받는 Claude 인가(화면에 일하는 중의 상태 줄이 없고, 지금 업무의 턴이 기록에서 닫혀 있다). 그 턴이 로그인 오류로
   * 끝났으면 아니다(보류할 차례). 로그인 밖의 API 오류로 끝난 턴은 받는다(core 의 error 보고처럼 다음 글이 새 턴을 연다).
   */
  private stillClaudeQuiet(track: Track, screen: string): boolean {
    const watch = this.claudeWatch.get(track);
    if (!watch || !claudeQuietScreen(screen)) return false;
    const verdict = this.claudeTurnVerdict(track, watch);
    return verdict.outcome === "ended" && !(verdict.error && CLAUDE_LOGIN_ERRORS.has(verdict.error.error));
  }
  /**
   * claudeQuiet 으로 끝난 턴을 알린다. 뒤 작업이면 평소의 턴 끝(성공, 실행 기록 사유 claude_background_task)이고 팀장 활동에 뒤 작업이 남았다는 줄을
   * 그 working 구간에 한 번 남긴다. 로그인 오류면 오류 턴 끝(사유 claude_login_required)이고 '로그인 필요' 줄을 그 업무에 한 번 남긴다.
   * 로그인 밖의 API 오류면 core 의 error 보고처럼 오류 턴 끝만 낸다(실행 기록 사유는 그 오류 글).
   * turn 번호는 비운다(core 가 working 을 마칠 때에야 오른다. Codex 백그라운드와 같다). 그때 core 가 쉬는 중을 알리면 평소의 턴 끝이 한 번 더 나는데,
   * 그것은 그 사이 Claude 가 스스로 연 턴(뒤 작업 알림)의 끝이고 열린 실행 기록이 없으면 업무를 닫지 않는다(그 사이 넣은 업무가 그때 끝났으면 그것을 닫는다).
   */
  private async endClaudeQuietTurn(track: Track, terminal: CoreTerminal, quiet: ClaudeQuiet, initial: boolean): Promise<void> {
    quiet.reported = true;
    const watch = this.claudeWatch.get(track);
    if (watch) watch.closedRun = quiet.runId;
    track.pending = false;
    if (initial) return;
    if (!quiet.runEnded) {
      const leased = !!this.manualLease(track.member.id);
      // 이 끝의 문맥 측정(reportContext)은 지금 core turn 번호를 싣는다. 오류로 끝난 턴·직접 조작 중이면 재지 않는다.
      const measuredTurn = leased || quiet.error ? null : track.terminal.turn ?? null;
      if (measuredTurn !== null) {
        track.completing = true;
        try { await this.reportContext(track); } finally { track.completing = false; }
      }
      this.validateTrack(track);
      const errorText = quiet.error ? `${quiet.error.error}${quiet.error.text ? `: ${quiet.error.text}` : ""}` : null;
      track.lastError = errorText;
      this.event(track, { type: "turn_end", memberId: track.member.id, finalText: "", isError: !!errorText, ...(errorText ? { errorText } : {}),
        ...(quiet.kind === "error" ? {} : { reason: quiet.kind === "login" ? CLAUDE_LOGIN_REASON : CLAUDE_BACKGROUND_REASON }), turn: null, ...(measuredTurn !== null ? { contextTurn: measuredTurn } : {}) });
    }
    const key = `${track.member.id}:${track.member.sessionGeneration ?? -1}:${terminal.address}`;
    if (quiet.kind === "login") this.event(track, { type: "activity", memberId: track.member.id, kind: "system", notice: true, text: textRef("activity.claude_login_required"), eventKey: `claude_login_required:${key}:${quiet.runId}` });
    else if (quiet.kind === "background") this.event(track, { type: "activity", memberId: track.member.id, kind: "system", notice: true, text: textRef("activity.claude_background_left"), eventKey: `claude_background_left:${key}:${terminal.turn ?? 0}` });
  }
  /**
   * 11-16(D2-2·D4-8): 실행 기록이 없는데 Claude 가 쉬는 동안 스스로 압축(Compacted while idle, compact_boundary trigger auto)하면 core 는 그 1~2분을
   * working 으로 알리고 끝나면 turn 번호를 올린다. 예전에는 그것을 턴 끝으로 적고(turn_start 없는 '턴 끝') 압축 전 사용량을 정확한 문맥 값으로 저장해
   * 문맥 % 가 부풀었고(15/41명) 이미 압축된 세션을 다시 압축했다. 기록 꼬리가 '턴 끝 → (턴 아님) → 자동 압축 경계'로 끝나고 이 세대에 열린 업무가 없으면
   * 턴 끝을 내지 않고, 압축 뒤 크기(compactMetadata.postTokens)를 정확하지 않은 값으로 싣는다(없으면 재지 않아 측정은 신선하지 않은 채 다음 턴을 기다린다).
   * 서버가 넣는 압축은 이 길을 타지 않는다(track.compact, checkCompact). 이렇게 닫았으면 true.
   */
  private claudeIdleCompaction(track: Track, terminal: CoreTerminal): boolean {
    if (providerFor(track.member) !== "claude" || track.pending || track.uncertain || !track.sessionId || track.member.sessionGeneration === undefined || this.manualLease(track.member.id)) return false;
    const store = this.deps.recoveryStore;
    if (!store?.lastWrittenRun) return false; // 열린 업무가 있는지 모른다.
    let tail: ReturnType<typeof readTranscriptTail> = null;
    try {
      const run = store.lastWrittenRun(track.member.id, track.member.sessionGeneration);
      if (run && !run.ended) return false; // 이 끝을 기다리는 업무가 있다: 평소대로 턴 끝이다.
      const path = this.logPath(track);
      tail = path ? readTranscriptTail(path) : null;
    } catch { return false; }
    if (!tail?.idleCompaction) return false;
    track.endedTurn = terminal.turn ?? track.endedTurn;
    track.pending = false;
    this.event(track, { type: "activity", memberId: track.member.id, kind: "system", notice: true, text: textRef("activity.claude_idle_compacted"),
      eventKey: `claude_idle_compacted:${track.member.id}:${track.member.sessionGeneration}:${terminal.address}:${terminal.turn ?? 0}` });
    if (tail.contextTokens !== null) this.event(track, { type: "context_usage", memberId: track.member.id, sessionId: track.sessionId, tokens: tail.contextTokens, shownPct: null, model: track.member.model ?? tail.model, exact: null });
    return true;
  }
  private logPath(track: Track): string | null {
    if (!track.sessionId) return null;
    const home = this.providerHome(track.member);
    if (providerFor(track.member) === "claude") return findSessionFile(home, track.member.cwd, track.sessionId);
    if (track.binding) {
      const matches = track.binding.files.filter((file) => file.matched && !file.invalid && file.meta?.sessionId === track.sessionId);
      if (matches.length === 1) return matches[0].path;
    }
    // Asked on every send, inspection and turn end: remember the file once found.
    if (track.logFile?.sessionId === track.sessionId && existsSync(track.logFile.path)) return track.logFile.path;
    try {
      const matches = [...new Bun.Glob(`**/rollout-*-${track.sessionId}.jsonl`).scanSync({ cwd: join(home, "sessions"), absolute: true, onlyFiles: true, followSymlinks: false })].filter((path) => {
        const meta = parseCodexSessionMeta(readJsonlRange(join(home, "sessions"), path, null, { maxBytes: 1024 * 1024 }).records[0]?.value);
        return meta?.sessionId === track.sessionId && meta.cwd === track.member.cwd;
      });
      if (matches.length !== 1) return null;
      track.logFile = { sessionId: track.sessionId, path: matches[0] };
      return matches[0];
    } catch { return null; }
  }
  /** Captured just before an envelope is written. Empty when the log is not known yet or ends in a partial line. */
  deliveryBaseline(member: RunnerMember): DeliveryLogBaseline[] {
    const track = this.tracks.get(member.id);
    if (!track || !track.sessionId) return [];
    try {
      const path = this.logPath(track);
      const baseline = path ? eofLogBaseline(join(this.providerHome(member), providerFor(member) === "claude" ? "projects" : "sessions"), path) : null;
      return baseline ? [baseline] : [];
    } catch { return []; }
  }
  /**
   * 11-16(Claude): 봉투를 쓰기 직전의 훅 사건 파일 자리(DeliveryBaseline.hookMark). 그 전달의 턴 끝 훅은 이 뒤에 덧붙은 줄에서만 찾는다.
   * Claude 가 아니거나 훅을 넣지 않는 환경이면 undefined(칸을 두지 않는다).
   */
  deliveryHookMark(member: RunnerMember): HookEventsMark | null | undefined {
    if (providerFor(member) !== "claude" || !this.hookEvents) return undefined;
    return hookEventsMark(this.hookEvents, member.id);
  }
  async inspectDelivery(member: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection> {
    const release = this.reserve(member.id);
    try { return await this.inspectLocked(member, query); } finally { release(); }
  }
  /** Read-only. A live terminal or no answer is false: silence is never proof that a terminal is gone. */
  async terminalGone(terminalId: string): Promise<boolean> {
    try { return (await this.call<CoreTerminal>("terminal.get", { terminal: terminalId }, Math.min(this.rpcTimeoutMs, 2000))).state !== "live"; }
    catch (error) { return error instanceof CoreError && error.kind === "not_found" && !error.uncertain; }
  }
  /** Session log of a session that has no attached terminal. Null when it cannot be told apart. */
  private sessionLogPath(member: RunnerMember, sessionId: string): string | null {
    const home = this.providerHome(member);
    try {
      if (providerFor(member) === "claude") return findSessionFile(home, member.cwd, sessionId);
      const matches = [...new Bun.Glob(`**/rollout-*-${sessionId}.jsonl`).scanSync({ cwd: join(home, "sessions"), absolute: true, onlyFiles: true, followSymlinks: false })].filter((path) => {
        const meta = parseCodexSessionMeta(readJsonlRange(join(home, "sessions"), path, null, { maxBytes: 1024 * 1024 }).records[0]?.value);
        return meta?.sessionId === sessionId && meta.cwd === member.cwd;
      });
      return matches.length === 1 ? matches[0]! : null;
    } catch { return null; }
  }
  private readonly goneEvidence = new Map<string, DeliveryEvidenceCursor>();
  /**
   * The envelope's terminal is confirmed gone (the caller's precondition): a half-typed draft in its composer can
   * never be submitted, and its screen and turn counter no longer exist. Only the session log is left to ask.
   * received: every marker is a submitted user message. not_received: the whole range since the send was read and
   * holds none of them. Anything else (no log, a partial or unrecognized record, some markers only) is unknown.
   */
  inspectGoneDelivery(member: RunnerMember, query: DeliveryProbe): DeliveryInspection {
    const source = providerFor(member) === "claude" ? "claude_log" as const : "codex_log" as const;
    const unknown = (code: string): DeliveryInspection => ({ evidence: [{ source, verdict: "unknown", location: "none", code, complete: false, checkedAt: new Date().toISOString() }], finding: "unknown", receivedDeliveryIds: [], snapshot: null, quiescence: "unresolved" });
    const sessionId = query.identity.sessionId;
    if (query.cli !== providerFor(member) || query.backend !== "core" || !sessionId || sessionId !== member.sessionId || query.identity.sessionGeneration !== member.sessionGeneration) return unknown("identity_changed");
    const path = this.sessionLogPath(member, sessionId);
    if (!path) return unknown("file_missing");
    const baseline = query.baseline.logs.find((log) => log.path === path);
    const scan = () => readDeliveryEvidence({ cli: providerFor(member), home: this.providerHome(member), path, cwd: member.cwd, sessionId,
      sessionGeneration: query.identity.sessionGeneration, markers: query.markers, bundleMarker: query.bundleMarker, baseline,
      since: baseline ? undefined : query.baseline.capturedAt, cursor: this.goneEvidence.get(query.dispatchId) });
    let read = scan();
    if (read.evidence.code === "generation_changed" && this.goneEvidence.delete(query.dispatchId)) read = scan();
    // An envelope without a log baseline is read from the start, 4 MiB a piece. Bounded here; the next check continues.
    for (let pieces = 1; read.evidence.code === "scan_pending" && pieces < 8; pieces++) {
      if (read.cursor) this.goneEvidence.set(query.dispatchId, read.cursor);
      read = scan();
    }
    if (read.evidence.code === "scan_pending" && read.cursor) this.goneEvidence.set(query.dispatchId, read.cursor);
    else this.goneEvidence.delete(query.dispatchId);
    const allReceived = query.markers.length > 0 && query.markers.every((marker) => read.receivedDeliveryIds.includes(marker.deliveryId));
    const absent = read.evidence.complete && read.evidence.verdict === "absent" && !read.receivedDeliveryIds.length;
    return { evidence: [read.evidence], finding: allReceived ? "received" : absent ? "not_received" : "unknown", receivedDeliveryIds: read.receivedDeliveryIds, snapshot: null, quiescence: "settled" };
  }
  private async inspectLocked(member: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection> {
    const unknown = (code: string, finding: "unknown" | "wait" = "unknown"): DeliveryInspection => ({ evidence: [{ source: "transport", verdict: "unknown", location: "none", code, complete: false, checkedAt: new Date().toISOString() }], finding, receivedDeliveryIds: [], snapshot: null, quiescence: "unresolved" });
    const track = this.tracks.get(member.id);
    if (!track) return unknown("not_attached");
    this.assertMember(track, member);
    if (this.manualLease(member.id)) return unknown("manual_control", "wait"); // No provider record scan under lease.
    const terminal = await this.refresh(track);
    if (query.cli !== providerFor(member) || query.backend !== "core" || (!this.sameIdentity(query.identity, this.identity(track)) && (!query.identity.sessionId || query.identity.sessionId !== track.sessionId))) return unknown("identity_changed");
    const stored = this.deps.recoveryStore?.inputState(member.id).unresolvedDispatches ?? track.dispatches;
    const settledBefore = this.deps.recoveryStore?.getDispatch?.(query.dispatchId);
    const dispatch = stored.find((item) => item.dispatchId === query.dispatchId && item.wireSha256 === query.wireSha256) ??
      (settledBefore && settledBefore.memberId === member.id && settledBefore.wireSha256 === query.wireSha256 ? settledBefore : undefined);
    const barrier = dispatch && this.deps.quiescence?.(member.id, dispatch);
    const originalWrite = barrier?.originalWrite ?? (dispatch?.transportState === "accepted" ? "settled" : dispatch?.transportState === "rejected" ? "rejected" : "unresolved");
    const externalInput = barrier?.externalInput ?? null;
    const inputEpoch = track.epoch;
    const screen = (await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 })).text;
    this.validateTrack(track);
    if (track.epoch !== inputEpoch) return unknown("input_epoch_changed");
    const draft = providerFor(member) === "claude" ? inputText(screen) : codexDraft(screen);
    const composer = draft === null ? "unknown" : draft === "" ? "empty" : dispatch && exactComposer(screen, providerFor(member)) === dispatch.wireText ? "matches" : "different";
    const state = this.stateOf(track, terminal);
    const status = terminal.state !== "live" ? "gone" : ["idle", "done", "working", "blocked"].includes(state || "") ? state as "idle" | "done" | "working" | "blocked" : "unknown";
    const snapshot: NonNullable<DeliveryInspection["snapshot"]> = { identity: this.identity(track), observedAt: track.observedAt, turn: terminal.turn ?? null, inputEpoch: track.epoch, ownership: "verified", status,
      blockedReason: status === "blocked" ? terminal.status?.kind === "permission" ? "permission" : "status_unknown" : null,
      leaseActive: false, mutation: "none", composer, originalWrite, externalInput };
    const path = this.logPath(track);
    if (!path || !track.sessionId) return { ...unknown("session_unbound"), snapshot };
    const baseline = query.baseline.logs.find((log) => log.path === path);
    const scan = () => readDeliveryEvidence({ cli: providerFor(member), home: this.providerHome(member), path, cwd: member.cwd, sessionId: track.sessionId!,
      sessionGeneration: query.identity.sessionGeneration, markers: query.markers, bundleMarker: query.bundleMarker, baseline,
      since: baseline ? undefined : query.baseline.capturedAt, cursor: track.evidence.get(query.dispatchId) });
    let read = scan();
    // The cursor belongs to one exact question. A check that asks about fewer items of the envelope (they fall due
    // apart) is another question: without a fresh read every later check stayed generation_changed.
    if (read.evidence.code === "generation_changed" && track.evidence.delete(query.dispatchId)) read = scan();
    if (read.cursor) track.evidence.set(query.dispatchId, read.cursor);
    // An envelope without a log baseline (written by an older build) is read from the start. Keep reading in this
    // inspection, yielding between 4 MiB pieces, instead of one piece per 30 s check.
    for (let pieces = 1, started = Date.now(); read.evidence.code === "scan_pending" && pieces < 16 && Date.now() - started < (this.deps.evidenceScanMs ?? 250); pieces++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (this.closed || this.tracks.get(member.id) !== track || track.epoch !== inputEpoch || this.manualLease(member.id)) break;
      read = scan();
      if (read.cursor) track.evidence.set(query.dispatchId, read.cursor);
    }
    const settled = originalWrite !== "unresolved";
    const allReceived = query.markers.length > 0 && query.markers.every((marker) => read.receivedDeliveryIds.includes(marker.deliveryId));
    const completeAbsence = read.evidence.complete && read.evidence.verdict === "absent";
    // A write that ended without a receipt was not received when the whole log range since the send holds no record
    // of it, the composer is empty and the CLI's turn counter has not moved since the send. It used to stay unknown
    // forever (real restarts mid-send), fencing the member's whole queue until the member was removed.
    const untouched = query.baseline.turn !== null && (terminal.turn ?? null) === query.baseline.turn;
    const absentWrite = ["not_written", "rejected"].includes(originalWrite) || originalWrite === "settled" && barrier?.unconfirmed === true && untouched;
    const finding = allReceived ? "received" : ["working", "blocked"].includes(status) ? "wait" : completeAbsence && settled && externalInput === false && composer === "matches" ? "draft_only" : completeAbsence && absentWrite && externalInput === false && composer === "empty" ? "not_received" : "unknown";
    return { evidence: [read.evidence, { source: "core_screen", verdict: composer === "unknown" ? "unknown" : "present", location: "composer", code: composer, complete: composer !== "unknown", checkedAt: new Date().toISOString() }], finding, receivedDeliveryIds: read.receivedDeliveryIds, snapshot, quiescence: settled ? "settled" : "unresolved" };
  }
  async repairDelivery(member: RunnerMember, request: DeliveryRepair): Promise<SendResult> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" }; }
    let attempted = false;
    const track = this.tracks.get(member.id);
    try {
      if (track?.compact && !["failed", "succeeded"].includes(track.compact.phase)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      if (!track || !this.deps.repair) return { ...unsupported("A durable delivery repair port and attached terminal are required"), deliveryEffect: "not_written" };
      const dispatch = this.deps.repair.load(member.id, request);
      if (!dispatch || dispatch.memberId !== member.id || dispatch.projectId !== member.projectId || dispatch.dispatchId !== request.dispatchId || createHash("sha256").update(dispatch.wireText).digest("hex") !== dispatch.wireSha256 || cleanText(dispatch.wireText) !== dispatch.wireText) return { ...unsupported("Stored delivery or reviewed recovery version changed"), deliveryEffect: "not_written" };
      const inspected = await this.inspectLocked(member, dispatch);
      const snapshot = inspected.snapshot;
      if (!snapshot || request.expectedSessionGeneration !== snapshot.identity.sessionGeneration || request.expectedSessionId !== snapshot.identity.sessionId || request.expectedTerminalId !== snapshot.identity.terminalId || request.expectedInputEpoch !== snapshot.inputEpoch || snapshot.externalInput !== false || snapshot.leaseActive || !["idle", "done"].includes(snapshot.status)) return { ok: false, reason: "input_busy", retryable: false, deliveryEffect: "not_written", detail: "Delivery identity, epoch or safe idle state changed" };
      if (inspected.receivedDeliveryIds.length) return { ...unsupported("User receipt already exists; reconcile delivery without input"), deliveryEffect: "not_written" };
      // The owner's explicit consent replaces the proof of absence, never the idle state or the empty composer.
      const consented = this.deps.quiescence?.(member.id, dispatch)?.riskApproved === true && inspected.finding === "unknown" && snapshot.composer === "empty";
      if (request.action === "resend" ? inspected.finding !== "not_received" && !consented : inspected.finding !== "draft_only" || !this.deps.submitKeyVerified || !this.methods.has("terminal.keys") || dispatch.submitAttempts !== 0) return { ...unsupported("No verified safe repair or submit-key barrier"), deliveryEffect: "not_written" };
      const final = await this.inspectLocked(member, dispatch);
      if (final.finding !== inspected.finding || final.receivedDeliveryIds.length || !final.snapshot || !["idle", "done"].includes(final.snapshot.status) || final.snapshot.inputEpoch !== request.expectedInputEpoch || this.manualLease(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      const latest = track.terminal;
      // This port revalidates recovery version, source revisions and cancellation,
      // then commits the one write attempt in the same synchronous transaction.
      if (!this.deps.repair.prepare(member.id, request, dispatch)) return { ...unsupported("Recovery version or source changed before repair"), deliveryEffect: "not_written" };
      this.validateTrack(track); this.bump(track); attempted = true; track.uncertain = true;
      if (request.action === "submit_only") {
        await this.call("terminal.keys", { terminal: latest.address, keys: ["enter"] }, this.sendTimeoutMs);
        return { ...unsupported("Submit key was sent once; await user-record evidence before further input"), deliveryEffect: "unknown" };
      }
      // Same rule as send(): after any turn the CLI reports done until its next input, and core has no conditional for it.
      const result = await this.call<{ turn: number; started?: boolean }>("terminal.send", { terminal: latest.address, text: dispatch.wireText, ...(final.snapshot.status === "idle" ? { if: "idle" } : {}), force: false, wait: false }, this.sendTimeoutMs);
      if (!Number.isSafeInteger(result.turn)) throw new CoreError("protocol", "Invalid repair send receipt", true);
      this.hookShadow?.sent(member.id, providerFor(member), { sessionId: track.sessionId, text: dispatch.wireText });
      track.pending = true;
      // The previous write was proved absent and this exact resend has a verified receipt.
      track.dispatches = track.dispatches.filter(item => item.dispatchId !== dispatch.dispatchId);
      track.controlUncertain = false; track.uncertain = track.dispatches.length > 0;
      return { ok: true, turn: result.turn, started: result.started ?? null, receipt: { dispatchId: dispatch.dispatchId, receivedAt: new Date().toISOString(), source: "transport" } };
    } catch (error) {
      if (track && attempted) track.uncertain = true;
      return { ok: false, reason: "error", retryable: false, deliveryEffect: !attempted ? "not_written" : error instanceof CoreError ? error.deliveryEffect : "unknown", detail: error instanceof Error ? error.message : String(error) };
    } finally { release(); }
  }
  private saveCompact(track: Track, state: CoreCompactState): void {
    if (!this.deps.compactStore) throw new CoreError("unsupported", "Durable compact state port is required");
    this.deps.compactStore.save(track.member.id, state); track.compact = state;
  }
  async compact(member: RunnerMember, focus: string, _opts: StartOpts): Promise<SendResult> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" }; }
    let attempted = false;
    const track = this.tracks.get(member.id);
    try {
      if (!track || !track.sessionId || member.sessionGeneration === undefined || !this.deps.compactStore) return { ...unsupported("Compact requires an attached native session, generation and durable state port"), deliveryEffect: "not_written" };
      this.assertMember(track, member);
      // 뒤 작업만 남은 Claude 를 압축하면 끝을 확인할 수 없다(core 가 working 이다). 그 작업이 끝난 뒤에 한다.
      if (this.manualLease(member.id) || this.isBusy(member.id) || this.claudeLingers(track)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      const terminal = await this.refresh(track);
      if (this.claudeLingers(track, terminal)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      // After any turn core reports "done" until the next input, so "idle only" meant a compact requested after the
      // first turn never ran and fenced the member's queue forever (real 2026-11-07 run). Use the same rule as a
      // normal delivery: idle is sent with the core-side if:"idle" guard, done after the same client-side checks.
      if (terminal.state !== "live" || !["idle", "done"].includes(this.stateOf(track, terminal) || "")) return { ok: false, reason: "blocked", retryable: true, deliveryEffect: "not_written", detail: "Compact requires an idle or finished CLI" };
      const epoch = track.epoch;
      const screen = await this.screen(member);
      if ((providerFor(member) === "claude" ? inputText(screen) : codexDraft(screen)) !== "") return { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written" };
      const path = this.logPath(track), home = this.providerHome(member);
      if (!path) return { ...unsupported("Native session log is unavailable"), deliveryEffect: "not_written" };
      const root = join(home, providerFor(member) === "claude" ? "projects" : "sessions");
      const baseline = compactLogBaseline(root, path);
      if (!baseline) return { ...unsupported("Compact log baseline is incomplete"), deliveryEffect: "not_written" };
      const current = await this.refresh(track);
      const currentState = this.stateOf(track, current);
      if (current.state !== "live" || !["idle", "done"].includes(currentState || "") || track.epoch !== epoch || this.manualLease(member.id) || !readJsonlRange(root, path, baseline, { maxBytes: 0 }).complete) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      // The read above may have been shared with the poller and so outlived this attempt's deadline. Once the caller
      // gave up (stage limit) nothing is persisted or written: it has already recorded this attempt as not started.
      this.validateTrack(track);
      // 훅 사건 파일의 지금 끝. startedAt 보다 먼저 읽어, 이 자리 뒤의 줄은 모두 압축 명령을 넣기로 한 뒤에 덧붙은 것이다.
      const hookMark = providerFor(member) === "claude" ? (this.hookEvents ? hookEventsMark(this.hookEvents, member.id) : null) : undefined;
      // real-cli-2 P6: Claude 의 명령은 400자 안으로 자른다(긴 붙여넣기는 슬래시 명령이 되지 않는다). 잘린 그 글이 넣는 글이고 command 로 저장된다.
      const command = providerFor(member) === "codex" ? "/compact" : claudeCompactCommand(focus);
      this.saveCompact(track, { id: crypto.randomUUID(), phase: "sending", startedAt: Date.now(), cursor: null, baseline: { path, fileIdentity: baseline.fileIdentity, offset: baseline.offset,
        sessionId: track.sessionId, terminalId: current.address, generation: member.sessionGeneration, turn: current.turn ?? null, model: member.model },
        ...(hookMark !== undefined ? { hookMark } : {}), command });
      this.bump(track); track.pending = true; attempted = true;
      const result = await this.call<{ turn: number; started?: boolean }>("terminal.send", { terminal: current.address, text: command, ...(currentState === "idle" ? { if: "idle" } : {}), force: false, wait: false }, this.sendTimeoutMs);
      if (!Number.isSafeInteger(result.turn)) throw new CoreError("protocol", "Invalid compact receipt", true);
      this.saveCompact(track, { ...track.compact!, phase: "running" });
      return { ok: true, started: result.started ?? null, turn: result.turn };
    } catch (error) {
      if (track?.compact && attempted) {
        const uncertain = !(error instanceof CoreError) || error.uncertain;
        track.uncertain ||= uncertain;
        if (!uncertain) track.pending = false;
        const next: CoreCompactState = { ...track.compact, phase: uncertain ? "uncertain" : "failed" };
        track.compact = next; // Preserve in-memory fence even when persistence fails after input.
        try { this.saveCompact(track, next); } catch { track.uncertain = true; track.controlUncertain = true; }
      }
      return { ok: false, reason: "error", retryable: false, deliveryEffect: !attempted ? "not_written" : error instanceof CoreError ? error.deliveryEffect : "unknown", detail: error instanceof Error ? error.message : String(error) };
    } finally { release(); }
  }
  private async checkCompact(track: Track): Promise<void> {
    let operation = track.compact!;
    const state = track.terminal.status?.state;
    const resolution = operation.manualResolution;
    if (operation.phase === "uncertain" && resolution && track.terminal.state === "live") {
      if (["working", "blocked"].includes(state || "") && !resolution.unsettled) {
        this.saveCompact(track, { ...operation, manualResolution: { ...resolution, unsettled: true } });
        operation = track.compact!;
      }
      if (["idle", "done"].includes(state || "") && (resolution.unsettled || resolution.turn !== null && (track.terminal.turn ?? -1) > resolution.turn)) {
        this.saveCompact(track, { ...operation, phase: "failed", reason: "user_resolved" });
        track.pending = false; track.controlUncertain = false; track.uncertain = track.dispatches.length > 0;
        this.event(track, { type: "activity", memberId: track.member.id, kind: "system", text: "사용자 확인으로 압축 대기를 해제했습니다", runId: operation.id });
        return;
      }
    }
    if (this.manualLease(track.member.id) || operation.phase === "sending") return;
    const settled = track.terminal.state === "live" && ["idle", "done"].includes(state || "");
    const result = observeCompactBoundary({ cli: providerFor(track.member), home: this.providerHome(track.member), cwd: track.member.cwd, baseline: operation.baseline,
      current: { sessionId: track.sessionId!, generation: track.member.sessionGeneration ?? -1, terminalId: track.terminal.address, turn: track.terminal.turn ?? null, model: track.member.model },
      settled, providerError: state === "error", cursor: operation.cursor });
    // 세션 기록에 경계가 없어도(기록 모양이 바뀜, 읽지 못함) CLI 가 압축 끝을 훅으로 알렸고 쉬고 있으면 끝난 것이다. 시간만으로는 닫지 않는다.
    const hook = result.outcome !== "succeeded" && state !== "error" && settled && this.compactEndHook(track, operation, result.code);
    if (result.outcome === "succeeded" || hook) {
      this.saveCompact(track, { ...operation, cursor: result.cursor, phase: "succeeded", ...(hook ? { evidence: "hook" as const } : {}) });
      if (hook) console.warn(`[hooks] ${track.member.id}: 세션 기록에서 압축 경계를 확인하지 못했지만(${result.code}) 압축 끝 훅과 쉬는 CLI 로 압축을 닫았습니다`);
      track.pending = false; track.controlUncertain = false; track.uncertain = track.dispatches.length > 0; track.endedTurn = Math.max(track.endedTurn, track.terminal.turn ?? 0);
      this.event(track, { type: "compacted", memberId: track.member.id, runId: operation.id });
      // Post-compact usage is collected by the next fresh provider sample; never emit 0%.
    } else if (result.outcome === "nothing" && state !== "error") {
      // real-cli-3 곁 문제: Claude 가 압축할 것이 없다고 끝냈다(기록에 그 출력, CLI 는 쉰다). 10분 기다릴 것 없이 곧바로 닫고 전달을 잇는다.
      // 대표에게 막힘을 보내지 않는다(결과 모름이 아니다). '중단'이 아니므로 P5 의 한 줄 표시도 만들지 않는다(그 기록에는 명령·출력 줄이 다 있다).
      this.saveCompact(track, { ...operation, cursor: result.cursor, phase: "failed", reason: "nothing_to_compact" });
      track.pending = false; track.controlUncertain = false; track.uncertain = track.dispatches.length > 0; track.endedTurn = Math.max(track.endedTurn, track.terminal.turn ?? 0);
      this.event(track, { type: "activity", memberId: track.member.id, kind: "system", notice: true, text: textRef("activity.compact_nothing"), eventKey: `compact_nothing:${operation.id}` });
    } else if (state === "error") {
      this.saveCompact(track, { ...operation, cursor: result.cursor, phase: "failed" });
      track.pending = false; track.controlUncertain = false; track.uncertain = track.dispatches.length > 0;
      track.lastError = track.terminal.status?.msg || "CLI reported a compact error";
      this.event(track, { type: "activity", memberId: track.member.id, kind: "error", text: "CLI reported that context compaction failed", runId: operation.id });
    } else if (Date.now() - operation.startedAt >= (this.deps.compactTimeoutMs ?? 600_000) || result.outcome === "unknown") {
      // 넣은 것이 확인된(running) 압축이 여기서 '결과 모름'이 되면 완료를 확인하지 못한 것이다. 예전에는 저장소가 모든 uncertain 을
      // send_uncertain(넣기가 불확실)으로 적어, 넣기는 성공한 2026-11-15 압축도 그렇게 보였다.
      this.saveCompact(track, { ...operation, cursor: result.cursor, phase: "uncertain", ...(operation.phase === "running" ? { reason: "completion_timeout" as const } : {}) }); track.uncertain = true;
    } else operation.cursor = result.cursor;
  }
  /**
   * 이 압축의 끝을 알리는 훅이 왔는가. 같은 팀장(사건 파일), 압축을 넣은 그 세션·세대·터미널이 지금 것과 같고, 압축을 넣기 직전의 사건 파일 자리
   * (hookMark) 뒤에 덧붙은, 넣은 뒤(startedAt 이후) 시각의 PostCompact(manual)·SessionStart(compact) 기록이어야 한다(isCompactEndHook).
   * 자리로 묶으므로 압축 전에 미리 넣어 둔 줄(앞으로의 시각을 적은 것 포함)·앞선 압축의 훅은 시계와 상관없이 근거가 아니다. 자리를 모르던 서버가
   * 넣은 압축(hookMark 없음)은 처음부터 읽되 지금보다 뒤 시각의 줄은 버린다. 사건 폴더·파일이 이 사용자 것이 아니거나 남이 쓸 수 있으면 읽지 않는다.
   * 훅은 Claude 에만 있다. 정착한 CLI(쉼·끝남)는 부르는 쪽이 따로 요구한다.
   */
  private compactEndHook(track: Track, operation: CoreCompactState, code: string): boolean {
    if (!this.hookEvents || providerFor(track.member) !== "claude" || ["session_changed", "session_conflict"].includes(code)) return false;
    const { baseline, hookMark } = operation;
    if (hookMark !== undefined && !isHookEventsMark(hookMark)) return false; // 넣을 때 자리를 읽지 못했거나 저장값이 망가졌다.
    if (!track.sessionId || baseline.sessionId !== track.sessionId || baseline.generation !== (track.member.sessionGeneration ?? -1) || baseline.terminalId !== track.terminal.address) return false;
    let watch = track.compactHook;
    if (!watch || watch.id !== operation.id) {
      try { watch = track.compactHook = { id: operation.id, reader: new HookEventReader(this.hookEvents, track.member.id, undefined, hookMark), seen: false }; }
      catch { return false; }
    }
    if (watch.seen) return true;
    if (!hookEventsTrusted(this.hookEvents, track.member.id)) return false;
    let records: ReturnType<HookEventReader["read"]>["records"];
    try { records = watch.reader.read().records; } catch { return false; }
    const until = hookMark === undefined ? Date.now() : Number.POSITIVE_INFINITY;
    watch.seen = records.some(record => isCompactEndHook(record, baseline.sessionId, operation.startedAt, until));
    return watch.seen;
  }
  async setParallel(member: RunnerMember, on: boolean, opts: StartOpts): Promise<SendResult> {
    if (providerFor(member) === "codex") {
      // Codex has native subagents, not Claude's Ultracode switch. Its capability
      // stays enabled; this preference is added explicitly to each next task.
      this.parallelPreferences.set(member.id, on);
      return { ok: true };
    }
    const command = `/effort ultracode ${on ? "on" : "off"}`;
    const sent = await this.send(member, command, opts);
    if (!sent.ok) return sent;
    const deadline = Date.now() + 5000;
    const word = on ? "on" : "off";
    while (Date.now() < deadline && !this.closed) {
      this.operation.getStore()?.signal.throwIfAborted();
      const screen = await this.screen(member).catch(() => "");
      const index = screen.lastIndexOf(command);
      if (index >= 0 && screen.slice(index + command.length).split("\n").some((line) => new RegExp(`^\\W*ultracode ${word}\\b`, "i").test(line))) {
        const track = this.tracks.get(member.id);
        if (track) track.pending = false;
        return { ok: true };
      }
      await Bun.sleep(150);
    }
    return { ...unsupported(`The command was delivered, but Ultracode ${word} was not confirmed; inspect the terminal before retrying`), deliveryEffect: "unknown" };
  }
  async applyConfig(member: RunnerMember, opts: StartOpts): Promise<SendResult> {
    const track = this.tracks.get(member.id);
    if (!track) return { ok: false, reason: "gone", retryable: false };
    if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, detail: "Manual terminal control is active" };
    // 뒤 작업만 남은 Claude 를 다시 열면 그 작업이 끝난다. 그 작업이 끝난 뒤에 맞춘다.
    if (this.isBusy(member.id) || this.claudeLingers(track) || this.sending.has(member.id) || this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true };
    const sessionId = track.sessionId || member.sessionId;
    if (!sessionId) return unsupported("Native Codex session id is unknown; use the CLI /model menu or explicitly start a fresh session");
    const release = this.reserve(member.id);
    this.configuring.add(member.id);
    try {
      const terminal = await this.refresh(track);
      if (this.claudeLingers(track, terminal)) return { ok: false, reason: "busy", retryable: true };
      if (!["idle", "done"].includes(this.stateOf(track, terminal) || "")) return { ok: false, reason: "blocked", retryable: true };
      const screen = await this.screen(member);
      const draft = providerFor(member) === "claude" ? inputText(screen) : codexDraft(screen);
      if (draft !== "") return { ok: false, reason: "input_busy", retryable: false, detail: "Configuration reload requires an identifiable empty composer; the user draft is preserved" };
      const resumed = { ...member, sessionId, paneId: null };
      providerLaunch(resumed, { ...opts, resume: true }, this.options); // Validate before stopping.
      await this.stopLocked(member, { whileWorking: false });
      await this.startLocked(resumed, { ...opts, resume: true });
      return { ok: true };
    } catch (error) { return unsupported(error instanceof Error ? error.message : String(error)); }
    finally { this.configuring.delete(member.id); release(); }
  }
  private async owned(member: RunnerMember): Promise<CoreTerminal> {
    const track = this.tracks.get(member.id);
    if (track) { this.assertMember(track, member); return this.refresh(track); }
    const address = this.tracks.get(member.id)?.terminal.address || member.paneId;
    if (!address) throw new CoreError("not_found", "No core terminal for member", false, "rejected", undefined, "core_terminal_missing");
    const terminal = await this.call<CoreTerminal>("terminal.get", { terminal: address });
    if (!this.owns(terminal, member)) throw new CoreError("conflict", "Refusing to control a core terminal without matching IAMCEO ownership labels");
    return terminal;
  }
  async interrupt(member: RunnerMember): Promise<void> {
    const release = this.reserve(member.id);
    try {
      const terminal = await this.owned(member);
      const track = this.tracks.get(member.id);
      // 0.2.7 배포 전 확인(real-cli P4): 멈출 턴이 없는(쉬는) CLI 에는 멈춤 키를 보내지 않는다. 쉬는 Codex 에 Esc 가 가면 'esc again to edit previous
      // message' 가 남아 입력칸을 알아보지 못하고, 한 번 더 가면 기록 보기(rewind) 화면에 들어가 전달이 멈췄다(Claude 도 빈 입력칸에서 Esc 두 번은 되감기 창이다).
      if (track && this.noTurnToStop(track, terminal)) {
        if (track.compact && !["failed", "succeeded"].includes(track.compact.phase)) {
          // 압축 확인 안내(chat.compact_unconfirmed)를 보고 누른 '중단': CLI 는 이미 쉬므로 키 없이 그 미확정 압축을 닫는다
          // (예전에는 Esc 를 보내고 core 가 stopped 로 쉬는 중을 확인했다. 근거는 같은 core 상태다).
          this.saveCompact(track, { ...track.compact, phase: "failed" }); track.pending = false; track.controlUncertain = false; track.uncertain = track.dispatches.length > 0;
          return;
        }
        throw new CoreError("no_turn", "No turn to stop: the CLI is idle", false, "not_written");
      }
      if (track) this.bump(track);
      const result = await this.call<{ outcome: string }>("terminal.interrupt", { terminal: terminal.address, timeout: 3 }, 6000);
      if (!["stopped", "exited"].includes(result.outcome)) throw new CoreError("not_stopped", `CLI interrupt outcome: ${result.outcome}`);
      if (track?.compact) { this.saveCompact(track, { ...track.compact, phase: "failed" }); track.pending = false; track.controlUncertain = false; track.uncertain = track.dispatches.length > 0; }
    } finally { release(); }
  }
  /**
   * 0.2.7 배포 전 확인(P4): 이 CLI 에 멈출 턴이 없는가. core 가 쉬는 중(idle·done·error)을 알리거나(Claude 의 뒤 작업만 남은 끝난 턴도 done 이다),
   * core 는 working 이지만 Codex 의 턴은 끝났고 백그라운드 터미널만 남았다(codexBackground). 방금 넣은 입력이 아직 턴을 열지 않았거나(pending)
   * 승인 창(blocked)·상태를 모르는 CLI 는 지금처럼 멈춤 키를 보낸다. 미확정 압축은 확인될 때까지 pending 이지만, 그동안 core 가 쉬는 중을 알리면
   * 도는 압축이 없다(압축 턴은 working 이다): 압축 확인 안내의 '중단'에 키를 보내면 쉬는 Codex 가 'esc again' 상태로 남아 다음 전달이 막혔다.
   */
  private noTurnToStop(track: Track, terminal: CoreTerminal): boolean {
    const compacting = !!track.compact && !["failed", "succeeded"].includes(track.compact.phase);
    if (terminal.state !== "live" || track.terminal !== terminal || track.completing || track.pending && !compacting) return false;
    const state = this.stateOf(track, terminal);
    if (["idle", "done", "error"].includes(state ?? "")) return true;
    return state === "working" && !!this.codexWatch.get(track)?.state;
  }
  /**
   * 0.2.7 배포 전 확인(real-cli P3): Claude 2.1.323 은 도는 압축을 Esc 로 끊으면 끊긴 명령('/compact 이어갈 일: …')을 입력칸에 되돌린다. 그 글 때문에
   * 다음 전달이 input_busy 로 거듭 거절됐다(실측 6번, 사람이 터미널에서 지울 때까지). 대표가 쓴 글은 절대 지우지 않으므로, 입력칸 글이 이 터미널·세션·세대의
   * 멈춘 압축(phase failed)에 IAMCEO 가 넣은 명령(CoreCompactState.command)과 글자까지 같을 때만 IAMCEO 의 글로 보고 지운다(공백은 칸 너비로 접히므로 빼고 견준다).
   * 지우는 키는 ctrl+c 하나다: Claude 입력칸은 글이 있을 때 ctrl+c 를 '입력 비우기'로 받는다(2.1.323 의 입력 처리, 실측에서도 직접 조작의 ctrl+c 로 지워졌다).
   * 빈 칸에서는 '한 번 더 누르면 끝냄' 안내만 뜨고, 두 번째 ctrl+c 가 와야 끝나므로 압축마다 한 번만 누른다. CLI 가 쉬는 중(idle·done)이고 뒤 작업이 없고 대표가
   * 터미널을 쥐고 있지 않을 때만 누른다(일하는 턴에 ctrl+c 는 그 턴을 끊는다). 글자까지 같다고 확인하지 못했지만 압축 명령으로 보이는 글('/compact …'·
   * 긴 붙여넣기 자리표시)이면 지우지 않고 활동에 안내를 한 번 남긴다. 지웠으면 true(부르는 쪽이 입력칸을 다시 읽는다).
   */
  private async clearCompactDraft(track: Track, terminal: CoreTerminal, draft: string): Promise<boolean> {
    const compact = track.compact;
    if (providerFor(track.member) !== "claude" || compact?.phase !== "failed" || !compact.command) return false;
    const { baseline } = compact;
    if (baseline.terminalId !== terminal.address || baseline.generation !== track.member.sessionGeneration || baseline.sessionId !== track.sessionId) return false;
    let mark = this.compactDrafts.get(track);
    if (mark?.id !== compact.id) this.compactDrafts.set(track, mark = { id: compact.id, cleared: false, noted: false });
    const squash = (text: string) => text.replace(/\s+/g, "");
    const exact = squash(draft) === squash(compact.command);
    const safe = exact && !mark.cleared && !this.manualLease(track.member.id) && this.methods.has("terminal.keys") && !this.claudeLingers(track, terminal) &&
      ["idle", "done"].includes(this.stateOf(track, terminal) ?? "");
    if (!safe) {
      if (!mark.noted && (exact || /^\/compact(?:\s|$)|^\[Pasted text #\d+/.test(draft))) {
        mark.noted = true;
        this.event(track, { type: "activity", memberId: track.member.id, kind: "system", notice: true, text: textRef("activity.compact_draft_left") });
      }
      return false;
    }
    mark.cleared = true;
    this.bump(track);
    await this.call("terminal.keys", { terminal: terminal.address, keys: ["ctrl+c"] }, this.sendTimeoutMs);
    console.warn(`[core] ${track.member.id}: 멈춘 압축의 명령이 입력칸에 되살아나 지웠습니다(IAMCEO 가 넣은 글과 같음, ctrl+c 한 번)`);
    this.event(track, { type: "activity", memberId: track.member.id, kind: "system", notice: true, text: textRef("activity.compact_draft_cleared") });
    return true;
  }
  async checkStop(member: RunnerMember, opts: { whileWorking?: boolean } = {}): Promise<void> {
    if (member.origin === "adopted") throw new CoreError("unsupported", "Cannot close an adopted user terminal");
    if (this.manualLease(member.id)) throw new CoreError("input_busy", "Manual terminal control lease is active");
    const track = this.tracks.get(member.id);
    if (!opts.whileWorking && track && this.isBusy(member.id)) throw new CoreError("busy", "A turn or unresolved input is still active");
    let terminal: CoreTerminal;
    try { terminal = await this.owned(member); }
    catch (error) {
      // A terminal confirmed absent has nothing left to close: stop() treats the same error as success.
      if (error instanceof CoreError && error.kind === "not_found" && !error.uncertain) return;
      throw error;
    }
    if (terminal.state !== "live") return;
    const quiet = this.quietForStop(track, terminal);
    if (!opts.whileWorking && !quiet) throw new CoreError("busy", "Resolve the current CLI turn/dialog before changing its provider or configuration");
    if (quiet) {
      const screen = await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 });
      const draft = providerFor(member) === "claude" ? inputText(screen.text) : codexDraft(screen.text);
      // 닫기·강제 재우기(whileWorking)는 마지막 탈출구다. 오류로 끝난 CLI 는 예전에 초안 확인 없이 끝냈다: 오류 배너가 입력칸을 가려
      // 알아보지 못하는(null) 화면은 막지 않는다. 쓰던 글이 보이면 지금처럼 지킨다.
      const unreadableAfterError = draft === null && !!opts.whileWorking && this.stateOf(track, terminal) === "error";
      if (draft !== "" && !unreadableAfterError) throw new CoreError("input_busy", "Cannot close a CLI with a user draft or unknown composer; the draft is preserved");
    }
  }
  /**
   * 일을 끊지 않고 끝낼 수 있는 CLI 인가: 쉬는 중(idle·done), 또는 오류 보고(error)로 끝난 턴의 끝을 이미 본 CLI.
   * 오류로 끝난 턴(API 오류·사용 한도)은 창이 아니라 입력을 기다리는 CLI 다. 예전에는 error 를 '처리 중'으로 읽어,
   * 사용 한도로 멈춘 팀장을 재우거나 설정을 바꿔 다시 열 수 없었다(2026-11-13 라이브). 초안 확인은 쉬는 CLI 와 같다.
   * 끝을 보지 못한 턴(턴 번호가 앞섰다)이나 이 서버가 지켜보지 않는 터미널의 error 는 지금처럼 막는다.
   */
  private quietForStop(track: Track | undefined, terminal: CoreTerminal): boolean {
    // 뒤 작업만 남은 Claude 는 입력은 받지만 끝내면 그 작업이 죽는다(쉬는 중으로 보여도). 강제(whileWorking)로만 끝낸다.
    if (track && this.claudeLingers(track, terminal)) return false;
    const state = this.stateOf(track, terminal);
    if (["idle", "done"].includes(state || "")) return true;
    return state === "error" && !!track && track.terminal.address === terminal.address && (terminal.turn ?? 0) <= track.endedTurn;
  }
  async stop(member: RunnerMember, opts: { whileWorking?: boolean } = {}): Promise<void> {
    const release = this.reserve(member.id);
    try { await this.stopLocked(member, { whileWorking: opts.whileWorking ?? true }); } finally { release(); }
  }
  private async stopLocked(member: RunnerMember, opts: { whileWorking?: boolean }): Promise<void> {
    let terminal: CoreTerminal;
    try { await this.checkStop(member, opts); terminal = await this.owned(member); }
    catch (error) {
      if (error instanceof CoreError && error.kind === "not_found") { this.detachStopped(member); return; }
      // No terminal.kill has been attempted during these ownership/draft reads.
      if (error instanceof CoreError) throw new CoreError(error.kind, error.message, false, "not_written", error.causeCode);
      throw error;
    }
    if (terminal.state === "live") {
      if (!opts.whileWorking && !this.quietForStop(this.tracks.get(member.id), terminal)) throw new CoreError("busy", "CLI state changed before stop");
      try {
        const result = await this.call<CoreTerminal>("terminal.kill", { terminal: terminal.address }, 15_000);
        if (result.state !== "finished") throw new CoreError("not_stopped", "Core did not confirm terminal termination");
      } catch (error) {
        if (!(error instanceof CoreError) || !error.uncertain) throw error;
        try { if ((await this.owned(member)).state !== "finished") throw error; }
        catch (inspection) {
          // A failed/cancelled verification read cannot turn an unknown kill
          // into a definite pre-write refusal. Retain the original write fence.
          if (!(inspection instanceof CoreError) || inspection.kind !== "not_found" || inspection.uncertain) throw error;
        }
      }
    }
    this.detachStopped(member);
  }
  private detachStopped(member: RunnerMember): void {
    const lease = this.leases.get(member.id);
    if (lease) this.deps.recoveryStore?.removeLease(member.id, lease.claimId);
    this.leases.delete(member.id); this.parallelPreferences.delete(member.id);
    const track = this.tracks.get(member.id);
    if (track && providerFor(member) === "codex" && !track.sessionId) this.lostCodex.set(member.id, member.sessionGeneration);
    this.tracks.delete(member.id);
    if (track) this.event(track, { type: "status", memberId: member.id, status: "gone" });
  }
  async screen(member: RunnerMember): Promise<string> {
    const terminal = await this.owned(member);
    return (await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 })).text;
  }
  async terminalInfo(member: RunnerMember): Promise<{ cols: number; rows: number }> {
    const terminal = await this.owned(member);
    if (terminal.address !== member.paneId) throw new CoreError("conflict", "터미널 연결이 바뀌었습니다");
    if (terminal.state !== "live") throw new CoreError("finished", "터미널이 끝났습니다");
    if (!Number.isInteger(terminal.cols) || !Number.isInteger(terminal.rows) || terminal.cols! < 1 || terminal.rows! < 1) {
      throw new CoreError("unsupported", "터미널 크기를 확인할 수 없습니다");
    }
    return { cols: terminal.cols!, rows: terminal.rows! };
  }
  terminalLease(memberId: string): TerminalLease | null { return this.manualLease(memberId); }
  renewLease(memberId: string, leaseId: string): number {
    const lease = this.manualLease(memberId);
    if (!lease || lease.leaseId !== leaseId) throw new CoreError("conflict", "조작권이 없습니다");
    const next = { ...lease, expiresAt: Date.now() + 5 * 60_000 };
    this.deps.recoveryStore?.saveLease(next);
    this.leases.set(memberId, next);
    return next.expiresAt;
  }
  async noteTerminalInput(memberId: string, write: () => void): Promise<void> {
    const track = this.tracks.get(memberId);
    if (!track) throw new CoreError("not_found", "Terminal is no longer tracked");
    const terminal = track.terminal;
    clearTimeout(this.inputRefreshes.get(track));
    this.inputRefreshes.delete(track);
    this.bump(track);
    const compact = this.disarmManualResolution(track);
    write(); // A successful local PTY write is the stream's acknowledgement.
    // Keep pre-write observations disarmed without putting them on the input chain.
    const previous = track.refresh;
    if (!previous) this.armManualResolution(track, compact, terminal);
    const armed = previous?.catch(() => undefined).then(() => {
      if (!this.closed && this.tracks.get(memberId) === track && this.inputRefreshes.get(track) === timer) this.armManualResolution(track, compact, terminal);
    }).catch(() => undefined);
    const timer = setTimeout(() => {
      void (async () => {
        await armed;
        if (this.closed || this.tracks.get(memberId) !== track || this.inputRefreshes.get(track) !== timer) return;
        await this.refresh(track);
      })().catch(() => undefined).finally(() => {
        if (this.inputRefreshes.get(track) === timer) this.inputRefreshes.delete(track);
      });
    }, 200);
    timer.unref();
    this.inputRefreshes.set(track, timer);
  }
  private disarmManualResolution(track: Track) {
    const compact = track.compact && ["running", "uncertain"].includes(track.compact.phase) ? track.compact : null;
    if (compact?.manualResolution) this.saveCompact(track, { ...compact, manualResolution: undefined });
    return compact;
  }
  private armManualResolution(track: Track, compact: Track["compact"], terminal: CoreTerminal): void {
    if (compact && track.compact?.id === compact.id && ["running", "uncertain"].includes(track.compact.phase)) this.saveCompact(track, { ...track.compact,
      manualResolution: { turn: terminal.turn ?? null, unsettled: ["working", "blocked"].includes(terminal.status?.state || "") } });
  }
  private async readSetup(track: Track): Promise<ReturnType<typeof claudeFolderTrust>> {
    if (track.terminal.state !== "live" || ["working", "idle", "done", "error"].includes(track.terminal.status?.state || "")) return null;
    const epoch = track.epoch;
    const screen = await this.call<{ text: string }>("terminal.read", { terminal: track.terminal.address, lines: 0 });
    this.validateTrack(track);
    return epoch === track.epoch ? (providerFor(track.member) === "claude" ? claudeFolderTrust : codexFolderTrust)(screen.text, track.member.cwd) : null;
  }
  async usageLimitSnapshot(member: RunnerMember): Promise<{ menu: ReturnType<typeof usageLimitMenu>; state: string | null }> {
    const track = this.tracks.get(member.id);
    if (!track) throw new CoreError("not_found", "No owned terminal");
    this.assertMember(track, member);
    await this.refresh(track);
    const identity = this.identity(track), epoch = track.epoch;
    const screen = await this.call<{ text: string }>("terminal.read", { terminal: track.terminal.address, lines: 0 });
    this.validateTrack(track);
    if (track.terminal.state !== "live" || epoch !== track.epoch || !this.sameIdentity(identity, this.identity(track))) throw new CoreError("conflict", "Terminal changed while reading usage menu");
    const state = track.terminal.status?.state ?? null;
    return { menu: state === "working" ? null : usageLimitMenu(screen.text), state };
  }
  async dismissUsageLimit(member: RunnerMember, fingerprint: string): Promise<{ ok: boolean; note?: string }> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, note: "입력 처리 중입니다" }; }
    try {
      const track = this.tracks.get(member.id);
      if (track) this.settleUncertain(track);
      if (!track || this.manualLease(member.id) || track.pending || track.uncertain || track.compact && !["failed", "succeeded"].includes(track.compact.phase) || !this.methods.has("terminal.keys")) return { ok: false, note: "창을 닫지 못했습니다" };
      this.assertMember(track, member);
      const snapshot = await this.usageLimitSnapshot(member);
      if (!snapshot.menu || snapshot.menu.fingerprint !== fingerprint) return { ok: false, note: "화면이 바뀌었습니다. 다시 눌러 주세요" };
      const identity = this.identity(track), epoch = track.epoch;
      await this.refresh(track);
      const final = await this.usageLimitSnapshot(member);
      if (!final.menu || final.menu.fingerprint !== fingerprint || track.epoch !== epoch || !this.sameIdentity(identity, this.identity(track)) || this.manualLease(member.id)) return { ok: false, note: "화면이 바뀌었습니다. 다시 눌러 주세요" };
      this.bump(track);
      // This path must never select a paid option, submit, or move the selection.
      await this.call("terminal.keys", { terminal: track.terminal.address, keys: ["esc"] }, this.sendTimeoutMs);
      const deadline = Date.now() + Math.min(Math.max(this.deps.usageLimitCloseTimeoutMs ?? 10_000, 1), 10_000);
      do {
        const after = await this.waitFor("usage_limit_close", () => this.usageLimitSnapshot(member), Math.max(deadline - Date.now(), 1));
        if (after.menu) return { ok: false, note: "창을 닫지 못했습니다" };
        if (after.state !== "blocked") return { ok: true };
        await Bun.sleep(Math.min(100, Math.max(deadline - Date.now(), 0)));
      } while (Date.now() < deadline);
      return { ok: false, note: "창을 닫지 못했습니다" };
    } catch { return { ok: false, note: "창을 닫지 못했습니다" }; }
    finally { release(); }
  }
  async approval(member: RunnerMember): Promise<ApprovalPrompt | null> {
    const track = this.tracks.get(member.id);
    if (!track) return null;
    this.assertMember(track, member);
    await this.refresh(track);
    const setup = await this.readSetup(track);
    return setup && setup.prompt.fingerprint !== track.setupAttempted ? setup.prompt : null;
  }
  async answerApproval(member: RunnerMember, fingerprint: string, option: number): Promise<import("./types.ts").ApprovalAnswer> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, reason: "input_busy" }; }
    const track = this.tracks.get(member.id);
    let attempted = false;
    try {
      if (!track) return { ok: false, reason: "gone" };
      this.assertMember(track, member);
      this.settleUncertain(track);
      if (this.manualLease(member.id) || track.uncertain || track.compact && !["failed", "succeeded"].includes(track.compact.phase)) return { ok: false, reason: "input_busy" };
      if (!this.methods.has("terminal.keys")) return { ok: false, reason: "unrecognized" };
      const identity = this.identity(track);
      const epoch = track.epoch;
      await this.refresh(track);
      if (track.terminal.state !== "live") return { ok: false, reason: "gone" };
      const setup = await this.readSetup(track);
      if (!setup) return { ok: false, reason: "unrecognized" };
      const current = setup.prompt;
      if (fingerprint !== current.fingerprint || track.setupAttempted === fingerprint) return { ok: false, reason: "changed", current };
      const chosen = current.options.find((item) => item.n === option);
      if (!chosen) return { ok: false, reason: "no_option", current };
      // Revalidate identity/status after the screen read. No input crosses a lease or epoch change.
      await this.refresh(track);
      this.validateTrack(track);
      if (this.manualLease(member.id) || track.epoch !== epoch || !this.sameIdentity(identity, this.identity(track))) return { ok: false, reason: "input_busy" };
      const final = await this.readSetup(track);
      if (!final || final.prompt.fingerprint !== fingerprint || track.epoch !== epoch) return { ok: false, reason: "changed", current: final?.prompt ?? null };
      const distance = option - 1 - final.selected;
      const keys = [...Array(Math.abs(distance)).fill(distance < 0 ? "up" : "down"), "enter"];
      // Fence before the single write, including ambiguous replies. Never replay a setup answer.
      track.setupAttempted = fingerprint; this.bump(track); attempted = true;
      await this.call("terminal.keys", { terminal: track.terminal.address, keys }, this.sendTimeoutMs);
      await this.refresh(track).catch(() => undefined); // Exit after 'No' is an observed exit, never a successful work turn.
      return { ok: true, prompt: current, chosen };
    } catch (error) {
      if (track && attempted && (!(error instanceof CoreError) || error.uncertain)) track.uncertain = track.controlUncertain = true;
      if (!attempted && error instanceof CoreError && error.kind === "not_found") return { ok: false, reason: "gone" };
      if (!attempted && error instanceof CoreError && error.kind === "conflict") return { ok: false, reason: "changed" };
      throw error;
    } finally { release(); }
  }
  private manualLease(memberId: string): TerminalLease | null {
    const lease = this.leases.get(memberId);
    if (lease && this.deps.recoveryStore) {
      const saved = this.deps.recoveryStore.inputState(memberId).lease;
      if (!saved || saved.leaseId !== lease.leaseId || !this.sameIdentity(saved.identity, lease.identity)) {
        this.deps.recoveryStore.removeLease(memberId, lease.claimId);
        this.leases.delete(memberId);
        return null;
      }
      if (saved.expiresAt > Date.now()) { this.leases.set(memberId, saved); return saved; }
    }
    if (lease && lease.expiresAt > Date.now()) return lease;
    if (lease) this.deps.recoveryStore?.removeLease(memberId, lease.claimId);
    this.leases.delete(memberId);
    return null;
  }
  async terminalControl(member: RunnerMember, action: TerminalControlAction): Promise<TerminalControlResult> {
    const release = this.reserve(member.id);
    try {
      const lease = this.manualLease(member.id);
      // Revoking our own lease is local: terminal.get may already be not_found.
      if (action.action === "release") {
        const track = this.tracks.get(member.id);
        if (track) this.assertMember(track, member);
        if (!lease || action.leaseId !== lease.leaseId || lease.identity.sessionGeneration !== (member.sessionGeneration ?? -1) ||
            lease.identity.terminalId !== (member.paneId ?? track?.terminal.address)) throw new CoreError("conflict", "A matching active terminal control lease is required", false, "rejected", undefined, "core_lease_required");
        this.deps.recoveryStore?.removeLease(member.id, lease.claimId); this.leases.delete(member.id);
        if (track) this.bump(track);
        return {};
      }
      const terminal = await this.owned(member);
      const track = this.tracks.get(member.id);
      if (!track) throw new CoreError("not_found", "Reattach the owned terminal before claiming control");
      if (action.action === "claim") {
        if (lease && action.leaseId !== lease.leaseId && action.leaseId !== lease.claimId) throw new CoreError("conflict", "Another terminal control lease is active", false, "rejected", undefined, "core_lease_other");
        // Expired rows can also survive a restart, when there is no cached
        // lease left for manualLease to remove. Only clear this claim's row
        // after the store confirms there is no live holder.
        if (!lease && action.leaseId && this.deps.recoveryStore && !this.deps.recoveryStore.inputState(member.id).lease) {
          this.deps.recoveryStore.removeLease(member.id, action.leaseId);
        }
        const claimId = lease?.claimId || action.leaseId || crypto.randomUUID();
        // A claim is retry-stable; each new acquisition has a distinct incarnation.
        const next: TerminalLease = { memberId: member.id, claimId, leaseId: lease?.leaseId || crypto.randomUUID(), identity: this.identity(track), expiresAt: Date.now() + 5 * 60_000, lastInputSequence: lease?.lastInputSequence ?? 0 };
        this.deps.recoveryStore?.saveLease(next); this.leases.set(member.id, next); this.bump(track);
        return { leaseId: next.leaseId, expiresAt: next.expiresAt };
      }
      if (!lease || action.leaseId !== lease.leaseId) throw new CoreError("conflict", "A matching active terminal control lease is required", false, "rejected", undefined, "core_lease_required");
      if (terminal.state !== "live") throw new CoreError("finished", "Terminal has finished", false, "rejected", undefined, "core_terminal_finished");
      if (action.action === "input" && (!action.text?.length || Buffer.byteLength(action.text) > 128 * 1024)) throw new CoreError("invalid_params", "Terminal input must contain 1–131072 bytes");
      if (action.action === "key" && !this.methods.has("terminal.keys")) throw new CoreError("unsupported", "Core does not support terminal.keys");
      if (action.action === "key" && (!action.key || !["enter", "up", "down", "esc", "tab", "ctrl+c", "backspace"].includes(action.key))) throw new CoreError("invalid_params", "Unsupported terminal control key");
      const next = { ...lease, expiresAt: Date.now() + 5 * 60_000, lastInputSequence: lease.lastInputSequence + 1 };
      this.deps.recoveryStore?.saveLease(next); this.leases.set(member.id, next); this.bump(track);
      const compact = this.disarmManualResolution(track);
      try {
        if (action.action === "input") await this.call("terminal.send", { terminal: terminal.address, text: cleanText(action.text!), force: true, wait: false }, this.sendTimeoutMs);
        else await this.call("terminal.keys", { terminal: terminal.address, keys: [action.key] }, this.sendTimeoutMs);
      } catch (error) {
        if (!(error instanceof CoreError) || error.uncertain) track.uncertain = track.controlUncertain = true;
        throw error;
      }
      // Drain any observation started before the ACK while resolution remains
      // disarmed. Only a newly requested observation may prove settled input.
      await track.refresh?.catch(() => undefined);
      this.validateTrack(track);
      this.armManualResolution(track, compact, terminal);
      // Re-observe after the ACK. Claim/release, elapsed time and unchanged idle
      // cannot prove that a human intervention settled this compact operation.
      await this.refresh(track).catch(() => undefined);
      return { leaseId: next.leaseId, expiresAt: next.expiresAt };
    } finally { release(); }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.configuring.clear();
    this.parallelPreferences.clear();
    this.leases.clear();
    for (const timer of this.inputRefreshes.values()) clearTimeout(timer);
    this.inputRefreshes.clear();
    for (const track of this.tracks.values()) if (track.statusTimer) clearTimeout(track.statusTimer);
    this.tracks.clear();
    this.hookShadow?.stop();
  }
}

/** No trimming or whitespace normalization for a submit-only full-wire comparison. */
function exactComposer(screen: string, provider: "claude" | "codex"): string | null {
  if (/\x1b/.test(screen)) return null;
  const lines = screen.split("\n");
  if (provider === "codex") {
    if (codexDraft(screen) === null) return null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = /^\s*› (.*)$/.exec(lines[i]);
      if (match) return match[1];
    }
    return null;
  }
  for (let bottom = lines.length - 1; bottom > 0; bottom--) {
    if (!/^[─━]{3,}$/.test(lines[bottom])) continue;
    let top = bottom - 1;
    while (top >= 0 && !/^[─━]{3,}$/.test(lines[top])) top--;
    if (top < 0) return null;
    const first = /^[❯>] (.*)$/.exec(lines[top + 1]);
    if (!first || lines.slice(top + 2, bottom).some(line => /[│┃]/.test(line))) return null;
    return [first[1], ...lines.slice(top + 2, bottom)].join("\n");
  }
  return null;
}

/** How a CLI starts its own error line. Only the start of a line counts, so conversation text that mentions an error is not one. */
const SCREEN_ERROR_LINE = /^(?:API Error\b|you['’]ve (?:hit|reached) your\b|you['’]re out of usage credits\b|your org is out of usage\b|stream disconnected\b|error sending request\b)/i;
/**
 * The CLI's own connection or usage-limit error line among the last lines of the screen (just above the composer),
 * for a turn that ended without a status report. Any other ending is null.
 */
export function screenTurnError(screen: string): string | null {
  const lines = screen.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/)
    .map(line => line.replace(/^[^\p{L}\p{N}]+/u, "").trimEnd()).filter(Boolean).slice(-12);
  const line = lines.findLast(line => SCREEN_ERROR_LINE.test(line));
  return line && ["network", "usage_limit"].includes(classifyTurnError(line)) ? line : null;
}

/**
 * Guidance only, never a key: the screen reads like some version's folder-trust dialog. A screen that shows the
 * CLI's input box is not one (a real folder-trust dialog has no input box), whatever its banner path or its
 * conversation says about trust.
 */
export function trustDialogLike(screen: string, provider: "claude" | "codex"): boolean {
  return (provider === "claude" ? inputText(screen) : codexDraft(screen)) === null && looksLikeFolderTrust(screen);
}

/** Input safety only. Unknown composer layouts refuse delivery. */
export function codexDraft(screen: string): string | null {
  const clean = screen.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = clean.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^\s*›(?: (.*))?$/.exec(lines[i]);
    if (!match) continue;
    // terminal.read is plain text: the current native Codex placeholder is
    // indistinguishable from someone typing that exact sentence. A manual
    // control lease suspends automation while a person uses this composer.
    const below = lines.slice(i + 1).filter((line) => line.trim());
    if (below.some((line) => !/^\s*(?:\? for shortcuts|← for agents · \? for shortcuts|\d+% context left|(?:GPT-|gpt-|o\d|codex)[^·]* · [/~]|\S+\s+\d+% context left)/i.test(line))) return null;
    const draft = match[1]?.trim() || "";
    return draft === "Ask Codex to do anything" ? "" : draft;
  }
  return null;
}

/** Codex 의 진행 줄: '• Working (12s • esc to interrupt)', 요약 제목이 붙은 '• Inspecting files (1m 02s • esc to interrupt)'. */
const CODEX_PROGRESS = /esc to interrupt|\bWorking \(|\(\s*\d+[hms]\b[^)]*•/i;
/** 0.166.0: '  1 background terminal running · /ps to view · /stop to close', 여럿이면 terminals. */
const CODEX_BACKGROUND = /^\s*(\d{1,4}) background terminals? running(?=\s|·|$)/i;
/**
 * 턴은 끝났지만 Codex 가 띄운 백그라운드 터미널이 살아 있는 화면이면 그 수, 아니면 null. 빈 입력칸(codexDraft 가 "")이고, 화면 어디에도
 * 진행 줄이 없고, 입력칸 바로 위의 글 줄이 'N background terminal(s) running …' 이어야 한다. 조금이라도 다르면 null 이다.
 * 화면만으로 턴 끝을 정하지 않는다(Codex 기록과 함께 본다. CoreRunner.codexBackground).
 */
export function codexBackgroundTerminals(screen: string): number | null {
  if (codexDraft(screen) !== "") return null;
  const lines = screen.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
  if (lines.some(line => CODEX_PROGRESS.test(line))) return null;
  const composer = lines.findLastIndex(line => /^\s*›(?: (.*))?$/.test(line));
  for (let i = composer - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const count = Number(CODEX_BACKGROUND.exec(line)?.[1] ?? 0);
    return count > 0 ? count : null;
  }
  return null;
}


export { ensureCoreServer } from "../core-supervisor.ts";
