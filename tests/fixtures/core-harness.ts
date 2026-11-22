// 시험용 core 틀. 총괄(Orchestrator) 시험을 운영과 같은 실행기 종류(kind "core")로 돌린다.
//
//   가짜 core 소켓(startFakeCore)  ← 실제 CoreRunner ← 실제 Orchestrator(createOrchestrator 의 운영 배선) ← 실제 HTTP 서버
//
// 실제 herdr-core 와 실제 CLI 는 띄우지 않는다. 가짜 core 가 소켓 약속(generation 1)과 그 안의 Claude CLI 를 한 프로세스에서 흉내 낸다:
// terminal.send 로 글이 들어오면 세션 기록(JSONL)에 받은 글을 적고, 글 안의 @fake: 지시대로 도구를 부르고(/agent/tool),
// 답을 적은 뒤 상태 보고를 끝남(done)으로 바꾸고 턴 번호를 올린다. 쓰는 법은 .pumasi/completeness/runner-removal/HARNESS.md.
//
// Gemini 팀장(라벨 iamceo.cli=gemini)이면 Antigravity CLI(agy)를 흉내 낸다: 인자의 --conversation·--add-dir·--settings 를 읽고,
// 도구는 주입 폴더(--add-dir)의 .agents/mcp_config.json 이 가리키는 환경 파일의 주소·토큰으로 부르고, 상태 보고의 app 은 "antigravity" 다.
// 대화 id 는 agy 처럼 스스로 정한다: 첫 글을 받을 때 새 id 를 만들고, 상태줄 명령이 설정돼 있으면 상태줄 기록(<contextHome>/context/gemini/<팀장>.json)에
// 적어 서버가 알아내게 한다. 없는 id 로 이어 열면 경고 한 줄을 남기고 새 대화가 된다. 세션 기록(JSONL)은 쓰지 않는다.
// 상태줄 기록에는 실제 래퍼처럼 상태줄 명령의 인자에 실린 띄우기 값(launch)을 적는다(터미널 라벨을 읽지 않는다. agy 는 라벨을 모른다).
//
// 불러오기만으로는 아무것도 하지 않는다(환경 읽기·소켓 열기·파일 쓰기 없음).
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bus } from "../../server/bus.ts";
import { CORE_VERSION, loadConfig, updateConfigFile } from "../../server/config.ts";
import { openDb } from "../../server/db.ts";
import { startServer, type RunningServer } from "../../server/http.ts";
import { createOrchestrator, type AgentToolsImpl, type AssemblyOverrides, type Orchestrator, type OrchestratorTimings } from "../../server/orchestrator.ts";
import type { CoreRunner, CoreRunnerDeps } from "../../server/runner/core.ts";
import type { CoreTerminal } from "../../server/runner/core-client.ts";
import { transcriptPath } from "../../server/runner/transcript.ts";
import { geminiStatusFromPayload, geminiStatusPath } from "../../server/runner/gemini-status.ts";
import { geminiStatusLineLaunch } from "../../server/runner/gemini-statusline.ts";
import { geminiHookEventsDir, geminiHooksRecordTurns } from "../../server/runner/gemini-hooks.ts";
import { parseGeminiMcpEnv } from "../../server/runner/gemini-inject.ts";
import type { Runner } from "../../server/runner/types.ts";
import { Store } from "../../server/store.ts";
import { PushEventRecorder } from "../../server/push/events.ts";
import { PushStore } from "../../server/push/store.ts";
import type { Backend, Member } from "../../shared/types.ts";

const METHODS = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill", "terminal.keys"];
const RULE = "─".repeat(40);
/** Claude 의 빈 입력칸이 보이는 화면. 위에 대화가 쌓이고 아래에 입력칸이 있다. */
export const composerScreen = (history = "", draft = "") => `${history}\n${RULE}\n❯ ${draft}\n${RULE}\n  ? for shortcuts\n`;
/** 가짜 agy 터미널의 너비(전체 너비 가로줄)와 지난 입력 상자의 가로줄(1.5.14 실측: 60칸). */
const GEMINI_RULE = "─".repeat(80);
const GEMINI_BOX = "─".repeat(60);
/**
 * Antigravity CLI(agy)의 입력칸이 보이는 화면(1.5.14 실측 모양, tests/fixtures/cli/gemini/1.5.14): 전체 너비 가로줄 사이의 `> ` 줄과 그 아래 IAMCEO 상태줄.
 * 위에는 지난 입력 상자(60칸 가로줄 + `> 글`)와 답이 쌓이고, 일하는 중이면 입력칸 바로 위에 진행 줄(`⣻  Generating...`)이 붙는다.
 */
export const geminiComposerScreen = (history = "", draft = "", status = "IAMCEO · fake-model", progress: string | null = null) =>
  `${history}${progress ? `${progress}\n` : "\n"}${GEMINI_RULE}\n> ${draft}\n${GEMINI_RULE}\n${status}\n`;

/**
 * core 에서만 생기는 턴: 깨우는 지시를 받고도 보고(완료·막힘·질문 post, 열린 결재) 없이 끝난 실행에 서버가 한 번 보내는 '보고 보완' 요청.
 * 옛 실행기(headless·herdr)에는 없던 턴이라, 턴 수를 세는 시험은 이것을 빼고 세거나(workTurns) 직원이 보고하고 끝내게 한다.
 */
export const isReportNudge = (turn: Pick<FakeTurn, "prompt">) => turn.prompt.startsWith("[시스템] 보고 보완:");

/**
 * 가짜 core 를 거치는 동작(재우기·닫기 등)의 거절은 `await expect(p).rejects` 대신 rejection·thrower 로 받아 단정한다.
 * 까닭(bun:test 의 안쪽 이벤트 루프에서 가짜 core 가 요청을 못 받음)은 ./settle.ts 머리말.
 */
export { rejection, thrower } from "./settle.ts";

export interface FakeCoreCall { id: string | number; method: string; params: Record<string, any> }
/** RPC 하나를 가로챈 결과. 돌려주지 않으면(undefined) 평소대로 처리한다. */
export type FakeCoreReply = { result: unknown } | { error: { kind: string; message: string } } | "drop" | undefined;

/** terminal.run 한 번 = CLI 한 번 띄움. 옛 틀의 "가짜 CLI 프로세스 시작"에서 인자·환경을 보던 자리다. */
export interface FakeRun {
  terminal: string; memberId: string | null; projectId: string | null; cli: string; at: number;
  argv: string[]; env: Record<string, string>; cwd: string; labels: Record<string, string>;
  /** `--session-id` 로 새로 연 세션이면 그 값. 이어 연 것이면 null. */
  sessionFlag: string | null;
  /** `--resume` 으로 이어 연 세션이면 그 값. 새로 연 것이면 null. */
  resumeFlag: string | null;
  /** Gemini(agy): `--conversation` 으로 이어 열라고 넘긴 대화 id. 없으면 null. */
  conversationFlag: string | null;
  /** Gemini(agy): `--add-dir` 로 넘긴 주입 폴더. 없으면 null. */
  addDir: string | null;
  /** Gemini(agy): `--settings` 로 넘긴 한 줄 JSON 을 푼 값. 없거나 풀지 못하면 null. */
  settings: Record<string, unknown> | null;
  /** Claude 는 띄울 때 정해진다. Gemini 는 대화가 열릴 때(이어 연 대화면 띄울 때, 새 대화면 첫 글을 받을 때) 채워진다. */
  sessionId: string | null;
}
/** terminal.send 한 번 = 턴 하나. 옛 틀의 "가짜 CLI 프로세스 시작"에서 받은 글(prompt)을 보던 자리다. */
export interface FakeTurn {
  index: number; terminal: string; memberId: string | null; prompt: string;
  at: number; endedAt: number | null;
  outcome: "running" | "done" | "error" | "interrupted" | "crashed" | "killed";
  /** 이 턴이 들어간 터미널을 띄운 기록. 같은 터미널의 여러 턴이 같은 run 을 가리킨다. */
  run: FakeRun;
  /** 이 턴에서 부른 도구와 그 답. */
  tools: { name: string; args: Record<string, unknown>; status: number; text: string }[];
}
/** 턴을 직접 짜는 손잡이(onTurn). 아무것도 하지 않고 돌아오면 그 턴은 조용히 끝난다. */
export interface FakeTurnContext {
  turn: FakeTurn; prompt: string; memberId: string | null; terminal: CoreTerminal;
  directives: Map<string, string>;
  /** 이 직원의 MCP 설정에 적힌 주소·토큰으로 /agent/tool 을 부른다. 서버가 준 답(JSON 글)을 그대로 돌려준다. */
  tool(name: string, args: Record<string, unknown>): Promise<string>;
  /** CLI 의 마지막 글. 세션 기록과 화면에만 남는다(core 는 마지막 글을 서버에 넘기지 않는다). */
  say(text: string): void;
  /** 끊기면(중단·종료) 던진다. */
  sleep(ms: number): Promise<void>;
  signal: AbortSignal;
}
export interface FakeScriptRule {
  when: string;
  tools?: { name: string; args: Record<string, unknown> }[];
  text?: string; delay?: number; usage?: number; silent?: boolean;
}
export interface FakeCoreOptions {
  /** 소켓 경로. 넘기지 않으면 /private/tmp 아래 짧은 임시 폴더에 만들고 stop() 에서 지운다(macOS 소켓 경로 104바이트 제한). */
  socketPath?: string;
  /** 가짜 CLI 가 세션 기록을 쓰는 곳. CoreRunner 의 claudeHome 과 같아야 수신 확인·문맥 측정이 된다. */
  claudeHome: string;
  /** 가짜 CLI 가 상태줄 문맥 기록을 쓰는 곳(<contextHome>/context/<세션>.json). CoreRunner 의 contextHome 과 같아야 한다. */
  contextHome?: string;
  /** 가짜 agy 가 대화를 두는 곳(<geminiHome>/conversations/<id>.db, 빈 파일). CoreRunner 의 geminiHome 과 같아야 이어 열기 판단이 맞는다. */
  geminiHome?: string;
  /** 모든 턴에 붙는 기본 지시(옛 FAKE_CLAUDE_DIRECTIVES). 글 안의 @fake: 가 같은 이름이면 그쪽이 이긴다. */
  directives?: string;
  /** 글에 when 이 든 첫 규칙의 도구를 차례로 부른다(옛 FAKE_CLAUDE_SCRIPT). 인자의 $last 는 앞 도구 답의 마지막 #id 다. */
  script?: FakeScriptRule[];
  /** 턴을 직접 짠다. true 를 돌려주면 @fake: 지시·규칙 처리를 건너뛴다. */
  onTurn?: (ctx: FakeTurnContext) => Promise<boolean | void> | boolean | void;
  /** hello 가 알리는 엔진 버전. 기본은 서버가 고정한 버전이라 버전 경고가 뜨지 않는다. */
  version?: string;
  /** 정상으로 끝난 턴 뒤의 상태 보고. 실제 core 는 다음 입력 전까지 done 을 알린다. */
  endState?: "done" | "idle";
  /** 새로 띄운 CLI 의 첫 상태 보고. null 이면 준비를 알리지 않은 CLI(폴더 신뢰 창 등)다. */
  startState?: "idle" | null;
  /**
   * 가짜 agy 의 상태줄이 무엇을 남기는가. 실제 agy 의 상태줄 입력은 아직 본 적이 없다(대화형 화면이 있어야 한다): 설계와 다르게 오는 경우를 시험한다.
   * "full"(기본): 대화 id 를 실어 그린다. "no_conversation": 그리되 대화 id 는 늘 빈 글이다(서버는 훅 기록으로만 id 를 알 수 있다).
   * "none": 상태줄 명령이 한 번도 돌지 않는다(기록이 없다). 훅 기록은 어느 경우에나 그대로 남는다.
   */
  geminiStatus?: "full" | "no_conversation" | "none";
  /**
   * 가짜 agy 가 auto 모드를 쓸 수 없는 계정·환경인가. 그러면 --settings 의 agentMode "auto" 를 받아도 default 로 뜬다(상태줄에 cycle_mode 가 없다, 문서).
   * 기본(false)은 agentMode 그대로다: "auto"·"accept-edits"·"plan" 은 cycle_mode 에 싣고 ""(default) 는 뺀다.
   */
  geminiAutoUnavailable?: boolean;
  /**
   * 가짜 agy 가 맨 `/compact` 를 받았을 때 무엇을 하는가(실제 agy 1.5.14 헤드리스 실측의 모양):
   * "checkpoint"(기본): 대화 기록에 USER_INPUT·SYSTEM_MESSAGE·CHECKPOINT 줄, 훅 PreInvocation(compact) → Stop(TERMINAL_CUSTOM_HOOK).
   * "hook_only": 훅만 남고 기록에는 CHECKPOINT 가 없다(기록 모양이 바뀐 판). "silent": 아무것도 남기지 않는다(압축이 돌지 않았다).
   */
  geminiCompact?: "checkpoint" | "hook_only" | "silent";
}
interface Holder {
  terminal: CoreTerminal; run: FakeRun; history: string; screen: string | null; draft: string;
  abort: AbortController | null; turn: FakeTurn | null; sent: number;
  /** @fake:hold 로 잡혀 있는 턴을 놓아 주는 손잡이. */
  release: ((result: { error?: string }) => void) | null;
}

/**
 * 가짜 core. 총괄 없이 CoreRunner 만 붙여도 된다.
 * 한 프로세스 안에서 돌기 때문에 시험이 터미널의 상태·화면을 직접 바꿔 승인 창·막힘·죽은 CLI 를 만들 수 있다.
 */
export async function startFakeCore(options: FakeCoreOptions) {
  const ownedDir = options.socketPath ? null : mkdtempSync(join(existsSync("/private/tmp") ? "/private/tmp" : tmpdir(), "ich-"));
  const socketPath = options.socketPath ?? join(ownedDir!, "c.sock");
  if (existsSync(socketPath)) throw new Error(`가짜 core 소켓 자리가 이미 쓰이고 있습니다: ${socketPath}`);
  const holders = new Map<string, Holder>();
  const sockets = new Set<Socket>();
  const calls: FakeCoreCall[] = [];
  const runs: FakeRun[] = [];
  const turns: FakeTurn[] = [];
  const keys: { terminal: string; keys: string[] }[] = [];
  const state = { version: options.version ?? CORE_VERSION, directives: options.directives ?? "", script: options.script ?? [] as FakeScriptRule[], onTurn: options.onTurn ?? null, down: false,
    /** 가짜 agy 상태줄의 quota(묶음 id → { remaining_fraction, reset_time, reset_in_seconds }). setGeminiQuota 로 바꾼다. */
    geminiQuota: null as Record<string, unknown> | null };
  let interceptor: ((call: FakeCoreCall) => FakeCoreReply) | null = null;
  const dropped = new Map<string | number, Socket>();
  let onKeys: ((terminal: CoreTerminal, pressed: string[]) => void) | null = null;
  let counter = 0, stopping = false;
  const geminiSteps = new Map<string, number>();
  /** @fake 지시 값의 %XX 를 푼다(공백이 든 오류 글을 넣을 때). */
  const decode = (value: string | undefined): string | undefined => { if (value === undefined) return undefined; try { return decodeURIComponent(value); } catch { return value; } };

  const flagOf = (argv: string[], name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] ?? null : null; };
  const render = (holder: Holder) => holder.screen ?? (holder.run.cli === "gemini" ? geminiComposerScreen(holder.history, holder.draft, undefined, holder.turn ? "⣻  Generating..." : null) : composerScreen(holder.history, holder.draft));
  const conversationFile = (id: string) => options.geminiHome ? join(options.geminiHome, "conversations", `${id}.db`) : null;
  /**
   * 가짜 agy 의 상태줄: 실제 agy 가 상태줄 명령에 주는 JSON 을 서버와 같은 규칙(geminiStatusFromPayload)으로 기록 파일에 쓴다.
   * 띄울 때 --settings 에 상태줄 명령이 있었을 때만 쓴다(없으면 실제 agy 도 그 명령을 돌리지 않는다).
   * 띄우기 값은 실제 래퍼가 하듯 그 명령의 인자에서 얻는다: 서버가 명령에 싣지 않았으면 기록에도 없다(null).
   */
  function geminiStatus(holder: Holder, extra: Record<string, unknown> = {}) {
    const member = holder.run.memberId;
    const statusLine = holder.run.settings?.statusLine as { command?: unknown } | undefined;
    if (!options.contextHome || !member || !statusLine || options.geminiStatus === "none") return;
    const path = geminiStatusPath(options.contextHome, member);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const conversation = options.geminiStatus === "no_conversation" ? "" : holder.run.sessionId ?? "";
    // 모드: 띄울 때의 --settings agentMode(문서 docs_cli_statusline.md: default 모드에서는 cycle_mode 가 빠진다). sandbox 는 enableTerminalSandbox.
    const agentMode = holder.run.settings?.agentMode;
    const cycleMode = typeof agentMode === "string" && agentMode && !(agentMode === "auto" && options.geminiAutoUnavailable) ? { cycle_mode: agentMode } : {};
    const sandbox = { sandbox: { enabled: holder.run.settings?.enableTerminalSandbox === true } };
    const payload = { session_id: conversation, conversation_id: conversation, model: { id: "fake-model", display_name: "fake-model" }, agent_state: holder.turn ? "working" : "idle", ...cycleMode, ...sandbox, ...(state.geminiQuota ? { quota: state.geminiQuota } : {}), ...extra };
    const launch = typeof statusLine.command === "string" ? geminiStatusLineLaunch(statusLine.command) : null;
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(geminiStatusFromPayload(member, payload, new Date(), launch)), { mode: 0o600 });
    renameSync(tmp, path);
  }
  /** 가짜 agy 의 훅: 주입 폴더에 hooks.json 이 있으면 서버의 기록 스크립트가 남길 줄을 같은 모양으로 사건 파일에 덧붙인다(본문 없이 표지만). */
  function geminiHook(holder: Holder, entry: Record<string, unknown>) {
    const member = holder.run.memberId;
    // 주입 폴더의 hooks.json 에 기록 사건이 실렸을 때만이다(도구 훅 PreToolUse 만 있으면 기록 줄이 생기지 않는다).
    if (!options.contextHome || !member || !holder.run.addDir || !geminiHooksRecordTurns(join(holder.run.addDir, ".agents", "hooks.json"))) return;
    const dir = geminiHookEventsDir(options.contextHome);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `${member}.jsonl`), `${JSON.stringify({ v: 1, cli: "gemini", at: Date.now(), conversationId: holder.run.sessionId, ...entry })}\n`, { mode: 0o600 });
  }
  /**
   * 가짜 agy 의 대화 기록: <geminiHome>/brain/<대화 id>/.system_generated/logs/transcript.jsonl 에 실제 agy 와 같은 모양의 줄을 덧붙인다
   * (step_index·source·type·status·created_at, 모델 줄에는 model·input_tokens·cache_read_tokens·output_tokens).
   */
  function geminiTranscript(holder: Holder, entry: Record<string, unknown>) {
    const session = holder.run.sessionId;
    if (!options.geminiHome || !session || holder.run.cli !== "gemini") return;
    const path = join(options.geminiHome, "brain", session, ".system_generated", "logs", "transcript.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    const step = geminiSteps.get(session) ?? 0;
    geminiSteps.set(session, step + 1);
    appendFileSync(path, `${JSON.stringify({ step_index: step, status: "DONE", created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), ...entry })}\n`);
  }
  function record(holder: Holder, entry: Record<string, unknown>) {
    const session = holder.run.sessionId;
    if (!session || holder.run.cli !== "claude") return;
    const path = transcriptPath(holder.terminal.cwd, session, options.claudeHome);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: session, cwd: holder.terminal.cwd, ...entry })}\n`);
  }
  function bridge(holder: Holder): { url: string; token: string } {
    // agy 는 MCP 설정을 인자로 받지 않는다. 주입 폴더(--add-dir)의 .agents/mcp_config.json 을 읽는다. 그 설정은 열쇠를 싣지 않고,
    // 주입 폴더 밖의 환경 파일을 읽어 다리를 띄우는 sh 명령이다(gemini-inject.ts). 가짜 agy 도 그 파일에서 주소·열쇠를 읽는다.
    const file = holder.run.cli === "gemini" ? (holder.run.addDir ? join(holder.run.addDir, ".agents", "mcp_config.json") : null) : flagOf(holder.run.argv, "--mcp-config");
    if (!file) throw new Error(holder.run.cli === "gemini" ? "가짜 agy 가 도구를 부르려면 --add-dir 가 있어야 합니다" : "가짜 CLI 가 도구를 부르려면 --mcp-config 가 있어야 합니다");
    const server = JSON.parse(readFileSync(file, "utf8")).mcpServers?.iamceo;
    const env = holder.run.cli === "gemini" ? parseGeminiMcpEnv(readFileSync(String(server?.args?.[3]), "utf8")) : server?.env;
    if (!env?.IAMCEO_URL || !env.IAMCEO_TOKEN) throw new Error("MCP 설정에 IAMCEO_URL·IAMCEO_TOKEN 이 없습니다");
    const url = new URL(env.IAMCEO_URL);
    // 시험 서버만 부른다. 라이브 서버(7878)나 바깥 주소로는 나가지 않는다.
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "7878") throw new Error(`가짜 CLI 는 시험 서버만 부릅니다: ${env.IAMCEO_URL}`);
    return { url: url.origin, token: env.IAMCEO_TOKEN };
  }
  function finish(holder: Holder, turn: FakeTurn, outcome: FakeTurn["outcome"], status: CoreTerminal["status"]) {
    if (holder.turn !== turn) return;
    holder.turn = null; holder.abort = null;
    turn.outcome = outcome; turn.endedAt = Date.now();
    if (holder.terminal.state !== "live") return;
    holder.terminal.status = status;
    holder.terminal.turn = (holder.terminal.turn ?? 0) + 1;
  }
  async function play(holder: Holder, turn: FakeTurn, signal: AbortSignal) {
    const prompt = turn.prompt;
    const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
      const aborted = () => { clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener("abort", aborted, { once: true });
    });
    const directives = new Map<string, string>();
    for (const match of `${state.directives} ${prompt}`.matchAll(/@fake:([a-z-]+)(?:=([^\s"]+))?/g)) directives.set(match[1]!, match[2] ?? "");
    const rule = state.script.find(r => prompt.includes(r.when));
    if (rule?.text !== undefined) directives.set("text", rule.text);
    if (rule?.delay !== undefined) directives.set("delay", String(rule.delay));
    if (rule?.usage !== undefined) directives.set("usage", String(rule.usage));
    if (rule?.silent) directives.set("silent", "");
    let said: string | null = null;
    const tool = async (name: string, args: Record<string, unknown>): Promise<string> => {
      signal.throwIfAborted();
      const { url, token } = bridge(holder);
      const id = `toolu_${crypto.randomUUID()}`;
      record(holder, { type: "assistant", message: { id: `msg_${crypto.randomUUID()}`, model: "fake-model", role: "assistant", content: [{ type: "tool_use", id, name: `mcp__iamceo__${name}`, input: args }] } });
      const response = await fetch(`${url}/agent/tool`, { method: "POST", redirect: "error", signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, args }) });
      const text = await response.text();
      turn.tools.push({ name, args, status: response.status, text });
      record(holder, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
      return text;
    };
    const gemini = holder.run.cli === "gemini";
    if (gemini) {
      // agy 는 새 대화의 id 를 스스로 정한다(첫 글을 받을 때). 대화 파일을 만들고 상태줄·훅으로 알린다.
      if (!holder.run.sessionId) {
        holder.run.sessionId = crypto.randomUUID();
        const file = conversationFile(holder.run.sessionId);
        if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, ""); }
        geminiHook(holder, { event: "SessionStart" });
      }
      geminiStatus(holder);
      geminiTranscript(holder, { source: "USER_EXPLICIT", type: "USER_INPUT", content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>` });
      // 맨 /compact: 실제 agy 처럼 압축만 하고 멈춘다(모델의 답·PostInvocation 없음). 훅은 PreInvocation(compact) 다음 Stop(TERMINAL_CUSTOM_HOOK).
      if (prompt.trim() === "/compact") {
        const mode = options.geminiCompact ?? "checkpoint";
        if (mode === "silent") return;
        geminiHook(holder, { event: "PreInvocation", invocation: 0, markers: [], chars: prompt.length, compact: true });
        geminiTranscript(holder, { source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "The following is a <SYSTEM_MESSAGE> not actually sent by the user." });
        if (mode === "checkpoint") geminiTranscript(holder, { source: "SYSTEM", type: "CHECKPOINT", input_tokens: 3068, cache_read_tokens: 7755, output_tokens: 409, content: "# Resuming from a compaction\n\nYou are continuing work on the task described above." });
        holder.history += `${holder.history ? "\n" : ""}${GEMINI_BOX}\n> /compact\n`;
        geminiHook(holder, { event: "Stop", reason: "TERMINAL_CUSTOM_HOOK", fullyIdle: true, failed: false });
        return;
      }
      // 모델을 부르기 직전의 훅: 마지막 사용자 글의 전달 표지만 남는다(서버의 기록 스크립트와 같은 규칙).
      geminiHook(holder, { event: "PreInvocation", invocation: 0, markers: [...new Set(prompt.match(/#iamceo_(?:b_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/g) ?? [])], chars: prompt.length });
    }
    // 받은 글이 세션 기록에 남는다. CoreRunner 의 수신 확인(전달 표지 찾기)이 이 줄을 읽는다.
    record(holder, { type: "user", message: { role: "user", content: prompt } });
    // agy 는 넣은 글을 지난 입력 상자(60칸 가로줄 + `> 글`, 이어진 줄은 두 칸 들여)로 남긴다(1.5.14 실측).
    holder.history += gemini ? `${holder.history ? "\n" : ""}${GEMINI_BOX}\n> ${prompt.split("\n").join("\n  ")}\n` : `${holder.history ? "\n" : ""}❯ ${prompt}\n`;
    // 아래 두 명령은 Claude 의 것이다. agy 는 그런 명령을 모른다: 보통 글로 받는다(서버가 잘못 넣으면 시험에서 드러난다).
    if (!gemini && prompt.startsWith("/compact")) {
      record(holder, { type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { trigger: "manual", preTokens: 150_000 } });
      return;
    }
    const effort = gemini ? null : /^\/effort ultracode (on|off)$/.exec(prompt);
    if (effort) { holder.history += `⎿ Ultracode ${effort[1]}\n`; return; }
    if (directives.has("crash")) {
      holder.history += `${directives.get("crash")}\n`;
      throw Object.assign(new Error(directives.get("crash")), { fake: "crash" });
    }
    const handled = await state.onTurn?.({ turn, prompt, memberId: turn.memberId, terminal: holder.terminal, directives, tool, say: text => { said = text; }, sleep, signal });
    if (!handled) {
      if (directives.has("post")) await tool("post", { kind: directives.get("postkind") || "완료", title: directives.get("post") });
      if (directives.has("ask")) await tool("ask", { title: directives.get("ask"), detail: "배경", options: [{ k: "a", label: "그렇게 하세요", desc: "추천" }, { k: "b", label: "하지 마세요" }] });
      let last = "";
      for (const call of rule?.tools ?? []) {
        const result = await tool(call.name, JSON.parse(JSON.stringify(call.args).replaceAll("$last", last)) as Record<string, unknown>);
        last = [...result.matchAll(/#([A-Za-z0-9_]+)/g)].at(-1)?.[1] ?? last;
      }
    }
    const session = holder.run.sessionId ?? "";
    const text = said ?? (directives.has("silent") ? "" : directives.get("text") ?? (handled ? "" : `가짜 응답 ${session.slice(0, 8)} 한글확인`));
    const tokens = Number(directives.get("usage") ?? 1000), window = Number(directives.get("window") ?? 200_000);
    // 문맥 사용량은 답 한 줄의 usage 로 남는다(턴 끝에 CoreRunner 가 세션 기록의 꼬리를 읽는다).
    record(holder, { type: "assistant", message: { id: `msg_${crypto.randomUUID()}`, model: "fake-model", role: "assistant", content: text ? [{ type: "text", text }] : [],
      usage: { input_tokens: 10, cache_read_input_tokens: Math.max(0, tokens - 10), cache_creation_input_tokens: 0, output_tokens: 5 } } });
    if (text) holder.history += gemini ? `\n  ${text}\n` : `⏺ ${text}\n`;
    await sleep(Number(directives.get("delay") ?? 0));
    if (directives.has("hang")) await sleep(600_000);
    if (directives.has("hold")) {
      // 시험이 release() 로 놓아 줄 때까지 일하는 중으로 남는다(옛 시험의 손으로 끝내는 가짜 실행기 자리).
      const result = await new Promise<{ error?: string }>((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        if (signal.aborted) return aborted();
        signal.addEventListener("abort", aborted, { once: true });
        holder.release = value => { signal.removeEventListener("abort", aborted); holder.release = null; resolve(value); };
      });
      if (result.error) {
        if (gemini) geminiHook(holder, { event: "Stop", reason: "ERROR", fullyIdle: true, failed: true, error: result.error });
        throw Object.assign(new Error(result.error), { fake: "error" });
      }
    }
    if (directives.has("error")) {
      // agy: 재시도를 다 쓰고 끝난 턴은 Stop(ERROR) 에 오류 글을 싣는다(stoperror 로 따로 줄 수 있다). OSC 보고 글은 oscmsg(없으면 error 글)다.
      if (gemini) geminiHook(holder, { event: "Stop", reason: "ERROR", fullyIdle: true, failed: true, error: decode(directives.get("stoperror")) ?? directives.get("error") });
      throw Object.assign(new Error(gemini && directives.has("oscmsg") ? decode(directives.get("oscmsg")) : directives.get("error")), { fake: "error" });
    }
    if (gemini) {
      // agy 는 턴이 끝나면 상태줄을 다시 그리고(문맥 % 가 실린다) 턴 끝 훅을 돌린다. 모델의 답은 대화 기록에 프롬프트 크기와 함께 남는다.
      geminiTranscript(holder, { source: "MODEL", type: "PLANNER_RESPONSE", model: "fake-model", input_tokens: 10, cache_read_tokens: Math.max(0, tokens - 10), output_tokens: 5, content: text });
      geminiStatus(holder, { agent_state: "idle", context_window: { used_percentage: Math.min(100, Math.round(tokens / window * 1000) / 10), context_window_size: window, total_input_tokens: tokens, total_output_tokens: 5 } });
      // @fake:stopfail=<글>: OSC 는 끝남(done)으로 알리는데 Stop 은 ERROR 인 턴(대화형 화면에서 아직 못 본 모양).
      const stopfail = directives.has("stopfail") ? decode(directives.get("stopfail")) ?? "" : null;
      geminiHook(holder, { event: "Stop", reason: stopfail !== null ? "ERROR" : "NO_TOOL_CALL", fullyIdle: true, failed: !!stopfail, ...(stopfail ? { error: stopfail } : {}) });
      return;
    }
    // 실제 CLI 는 상태줄 명령으로 창 크기를 알린다. 턴 끝 직전에 같은 자리에 같은 모양으로 적는다.
    if (options.contextHome && session) {
      const dir = join(options.contextHome, "context");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, `${session}.json`), JSON.stringify({ session_id: session, model: "fake-model", context_window_size: window, used_percentage: null, tokens, at: Date.now() }), { mode: 0o600 });
    }
  }
  function begin(holder: Holder, prompt: string) {
    const turn: FakeTurn = { index: turns.length, terminal: holder.terminal.address, memberId: holder.run.memberId, prompt, at: Date.now(), endedAt: null, outcome: "running", run: holder.run, tools: [] };
    turns.push(turn);
    const abort = new AbortController();
    holder.turn = turn; holder.abort = abort; holder.sent++;
    holder.terminal.status = { state: "working" };
    void play(holder, turn, abort.signal).then(
      () => finish(holder, turn, "done", { state: options.endState ?? "done" }),
      (error: Error & { fake?: string }) => {
        if (stopping || abort.signal.aborted) return; // 중단·종료는 그 RPC 가 상태를 정한다.
        if (error.fake === "crash") {
          holder.turn = null; holder.abort = null; turn.outcome = "crashed"; turn.endedAt = Date.now();
          holder.terminal.state = "finished"; holder.terminal.reason = "exited"; holder.terminal.exit_code = 3; holder.terminal.status = null;
          return;
        }
        holder.history += `${error.message}\n`;
        finish(holder, turn, "error", { state: "error", msg: error.message });
      });
  }
  function apply(call: FakeCoreCall): FakeCoreReply {
    const p = call.params;
    if (call.method === "hello") return { result: { generation: 1, version: state.version, methods: METHODS, features: [] } };
    if (call.method === "terminal.list") return { result: { terminals: [...holders.values()].map(h => h.terminal).filter(t => Object.entries(p.labels ?? {}).every(([key, value]) => t.labels[key] === value)) } };
    if (call.method === "terminal.run") {
      if (!Array.isArray(p.argv) || !p.argv.length || typeof p.cwd !== "string") return { error: { kind: "invalid", message: "argv·cwd 가 필요합니다" } };
      const labels: Record<string, string> = p.labels ?? {};
      const cli = labels["iamceo.cli"] ?? "claude";
      const sessionFlag = flagOf(p.argv, "--session-id"), resumeFlag = flagOf(p.argv, "--resume");
      const conversationFlag = cli === "gemini" ? flagOf(p.argv, "--conversation") : null;
      let settings: Record<string, unknown> | null = null;
      if (cli === "gemini") { try { settings = JSON.parse(flagOf(p.argv, "--settings") ?? "") as Record<string, unknown>; } catch { settings = null; } }
      // agy: 넘겨받은 대화가 있으면 그것을 이어 열고, 없으면(또는 넘겨받지 않았으면) 첫 글에서 새 대화를 연다.
      const resumed = conversationFlag && conversationFile(conversationFlag) && existsSync(conversationFile(conversationFlag)!) ? conversationFlag : null;
      const run: FakeRun = { terminal: `t${++counter}`, memberId: labels["iamceo.member"] ?? null, projectId: labels["iamceo.project"] ?? null, cli, at: Date.now(),
        argv: p.argv, env: p.env ?? {}, cwd: p.cwd, labels, sessionFlag, resumeFlag, conversationFlag, addDir: cli === "gemini" ? flagOf(p.argv, "--add-dir") : null, settings,
        sessionId: cli === "claude" ? sessionFlag ?? resumeFlag : cli === "gemini" ? resumed : null };
      const terminal: CoreTerminal = { address: run.terminal, argv: p.argv, cwd: p.cwd, labels, state: "live", cols: p.size?.cols ?? 160, rows: p.size?.rows ?? 50, turn: 0,
        status: options.startState === null ? null : { state: "idle", app: cli === "claude" ? "claude-code" : cli === "gemini" ? "antigravity" : "codex" }, reported: options.startState !== null, pid: 40_000 + counter };
      const holder: Holder = { terminal, run, history: "", screen: null, draft: "", abort: null, turn: null, sent: 0, release: null };
      if (cli === "gemini") {
        // 실제 agy 는 없는 대화를 이어 열라고 해도 끝나지 않는다. 경고 한 줄을 찍고 새 대화를 연다.
        if (conversationFlag && !resumed) holder.history = `warning: conversation "${conversationFlag}" not found\n`;
        // 이어 연 대화의 id 는 뜨자마자 상태줄에 실린다.
        if (resumed) geminiStatus(holder);
      }
      // 실제 Claude 는 기록이 없는 세션을 이어 열라고 하면 한 줄 남기고 끝난다.
      if (cli === "claude" && resumeFlag && !existsSync(transcriptPath(p.cwd, resumeFlag, options.claudeHome))) {
        holder.history = `No conversation found with session ID: ${resumeFlag}\n`;
        terminal.state = "finished"; terminal.reason = "exited"; terminal.exit_code = 1; terminal.status = null;
      }
      holders.set(terminal.address, holder); runs.push(run);
      return { result: terminal };
    }
    const holder = holders.get(p.terminal);
    if (!holder) return { error: { kind: "not_found", message: `터미널이 없습니다: ${p.terminal}` } };
    const terminal = holder.terminal;
    if (call.method === "terminal.get") return { result: terminal };
    if (call.method === "terminal.read") return { result: { text: render(holder), complete: true, how: "screen" } };
    if (call.method === "terminal.send") {
      if (terminal.state !== "live") return { error: { kind: "finished", message: "터미널이 끝났습니다" } };
      if (p.if && terminal.status?.state !== p.if) return { error: { kind: "status_mismatch", message: "status changed" } };
      // 실제 core 는 working 에도 넣는다(force:false 는 승인 창만 거절). 이 틀은 조건 없는 넣기만 막고, if:"working" 은 받는다
      // (뒤 작업만 남은 Claude 에 넣는 길, CoreRunner.send). 받은 글은 새 턴으로 처리하고 turn 번호는 그 턴이 끝날 때 오른다.
      if (terminal.status?.state === "working" && p.if !== "working") return { error: { kind: "busy", message: "CLI is working" } };
      if (terminal.status?.state === "blocked" && !p.force) return { error: { kind: "blocked", message: "CLI dialog is open" } };
      const before = terminal.turn ?? 0;
      begin(holder, String(p.text ?? ""));
      return { result: { turn: before, started: true } };
    }
    if (call.method === "terminal.keys") {
      keys.push({ terminal: terminal.address, keys: p.keys });
      onKeys?.(terminal, p.keys);
      return { result: { status: terminal.status?.state ?? null, turn: terminal.turn ?? 0 } };
    }
    if (call.method === "terminal.interrupt") {
      const turn = holder.turn;
      if (turn && /@fake:ignore-sigint\b/.test(`${state.directives} ${turn.prompt}`)) return { result: { outcome: "timeout" } };
      // agy 는 Esc 로 멈춘 턴을 done 없이 곧바로 idle 로 알리고 Stop 훅을 돌리지 않는다(1.5.14 실측). 화면에는 'Interrupted' 줄이 남는다.
      if (turn && holder.run.cli === "gemini") holder.history += "  ⎿  Interrupted · What should Antigravity CLI do instead?\n";
      if (turn) { holder.abort?.abort(new Error("interrupted")); finish(holder, turn, "interrupted", holder.run.cli === "gemini" ? { state: "idle", app: "antigravity" } : { state: options.endState ?? "done" }); }
      return { result: { outcome: "stopped", key: "esc" } };
    }
    if (call.method === "terminal.kill") {
      const turn = holder.turn;
      if (turn) { holder.abort?.abort(new Error("killed")); holder.turn = null; holder.abort = null; turn.outcome = "killed"; turn.endedAt = Date.now(); }
      terminal.state = "finished"; terminal.reason = "killed"; terminal.exit_code = 137; terminal.status = null;
      return { result: terminal };
    }
    return { error: { kind: "unsupported", message: `모르는 메서드: ${call.method}` } };
  }
  const accept = (socket: Socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let request: { id: string | number; method: string; params?: Record<string, any> };
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        const call: FakeCoreCall = { id: request.id, method: request.method, params: request.params ?? {} };
        calls.push(call);
        if (state.down) { socket.destroy(); return; }
        let reply: FakeCoreReply;
        try { reply = interceptor?.(call) ?? apply(call); }
        catch (error) { reply = { error: { kind: "fixture", message: String(error) } }; }
        // "drop" 한 요청은 시험이 answer() 로 나중에 답할 수 있게 소켓을 기억한다(쓰는 사이에 상태가 바뀌는 경우를 만든다).
        if (reply === "drop") dropped.set(call.id, socket);
        if (reply === "drop" || reply === undefined || socket.destroyed || stopping) continue;
        // 답은 이 순간의 모습으로 굳힌다. 뒤에 바뀐 터미널 상태가 앞선 답에 섞이지 않는다.
        socket.write(`${JSON.stringify("result" in reply ? { jsonrpc: "2.0", id: call.id, result: reply.result } : { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: reply.error.message, data: { kind: reply.error.kind } } })}\n`);
      }
    });
  };
  // 듣는 쪽은 닫았다가 다시 열 수 있다(setRefusing). 터미널·기록은 그대로 남는다.
  let server: Server | null = null;
  const listen = async () => {
    if (server) return;
    rmSync(socketPath, { force: true });
    const next = createServer(accept);
    await new Promise<void>((resolve, reject) => { next.once("error", reject); next.listen(socketPath, resolve); });
    server = next;
  };
  const unlisten = async () => {
    const current = server;
    if (!current) return;
    server = null;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => current.close(() => resolve()));
    rmSync(socketPath, { force: true });
  };
  await listen();

  const holderOf = (memberId: string) => [...holders.values()].findLast(h => h.run.memberId === memberId) ?? null;
  const need = (memberId: string) => { const holder = holderOf(memberId); if (!holder) throw new Error(`이 직원의 터미널이 없습니다: ${memberId}`); return holder; };
  let stopped: Promise<void> | null = null;
  return {
    socketPath, claudeHome: options.claudeHome, contextHome: options.contextHome ?? null, geminiHome: options.geminiHome ?? null,
    /** 받은 RPC 전부(가로챈 것 포함). */
    calls,
    count: (method: string) => calls.filter(c => c.method === method).length,
    /** CLI 를 띄운 기록(terminal.run). */
    runs: () => [...runs],
    /** 턴 기록(terminal.send). memberId 를 주면 그 직원 것만. */
    turns: (memberId?: string) => turns.filter(t => !memberId || t.memberId === memberId),
    /** 턴의 시작·끝을 시간순으로. 동시에 도는 턴 수를 셀 때 쓴다(옛 calls() 의 start·end). */
    events: () => turns.flatMap(t => [{ event: "start" as const, at: t.at, turn: t }, ...(t.endedAt !== null ? [{ event: "end" as const, at: t.endedAt, turn: t }] : [])]).sort((a, b) => a.at - b.at || (a.event === "end" ? -1 : 1)),
    /** terminal.keys 로 눌린 키. */
    keys,
    /** 이 직원의 지금 터미널(가장 나중에 띄운 것). 없으면 null. 돌려준 객체를 고치면 다음 조회부터 그대로 보인다. */
    terminalOf: (memberId: string) => holderOf(memberId)?.terminal ?? null,
    terminals: () => [...holders.values()].map(h => h.terminal),
    /** 화면을 통째로 바꾼다(승인 창·폴더 신뢰 창·사용 한도 메뉴 등). null 이면 다시 대화+입력칸 화면이다. */
    setScreen(memberId: string, screen: string | null) { need(memberId).screen = screen; },
    /** 입력칸에 사람이 쳐 둔 글. 빈 글이 아니면 CoreRunner 는 넣지 않는다(input_busy). */
    setDraft(memberId: string, draft: string) { need(memberId).draft = draft; },
    screenOf: (memberId: string) => render(need(memberId)),
    /**
     * 가짜 agy 가 상태줄을 다시 그린다(실제 agy 는 뜰 때와 상태가 바뀔 때마다 상태줄 명령을 돌린다). extra 는 상태줄 입력에 덧붙이거나 바꿀 칸이다
     * (예: { subagents: [...] }, { conversation_id: "" }). 띄울 때 상태줄 명령을 받지 않은 터미널이면 아무것도 쓰지 않는다.
     */
    drawGeminiStatus(memberId: string, extra: Record<string, unknown> = {}) { geminiStatus(need(memberId), extra); },
    /** 가짜 agy 상태줄의 quota 를 바꾼다(다음에 그릴 때부터). null 이면 quota 칸 없이 그린다. */
    setGeminiQuota(quota: Record<string, unknown> | null) { state.geminiQuota = quota; },
    /** CLI 가 스스로 알리는 상태 보고를 바꾼다. null 은 보고가 사라진 것. 예: { state: "blocked", kind: "permission" } */
    setStatus(memberId: string, status: CoreTerminal["status"]) { need(memberId).terminal.status = status; },
    /** CLI 가 죽었다(터미널이 끝남). */
    exit(memberId: string, exitCode = 0, reason = "exited") {
      const holder = need(memberId);
      holder.abort?.abort(new Error("exited"));
      if (holder.turn) { holder.turn.outcome = "crashed"; holder.turn.endedAt = Date.now(); holder.turn = null; holder.abort = null; }
      holder.terminal.state = "finished"; holder.terminal.reason = reason; holder.terminal.exit_code = exitCode; holder.terminal.status = null;
    },
    /** @fake:hold 로 잡아 둔 턴을 끝낸다. error 를 주면 그 글의 오류로 끝난다. 잡힌 턴이 없으면 false. */
    release(memberId: string, result: { error?: string } = {}): boolean {
      const holder = need(memberId);
      if (!holder.release) return false;
      holder.release(result);
      return true;
    },
    /** 지금 @fake:hold 로 잡혀 있는가. */
    held: (memberId: string) => !!holderOf(memberId)?.release,
    /** 사람이 터미널에 직접 친 턴(서버를 거치지 않은 입력). */
    typeDirectly(memberId: string, prompt: string) { begin(need(memberId), prompt); },
    /** RPC 를 가로챈다. undefined 를 돌려주면 평소대로 처리한다. "drop" 은 답하지 않는다(제한 시간까지 기다리게 됨). */
    intercept(fn: ((call: FakeCoreCall) => FakeCoreReply) | null) { interceptor = fn; },
    /** intercept 가 "drop" 한 요청에 뒤늦게 답한다. 그 요청이 없거나 연결이 끊겼으면 false. */
    answer(call: FakeCoreCall, reply: Exclude<FakeCoreReply, "drop" | undefined>): boolean {
      const socket = dropped.get(call.id);
      dropped.delete(call.id);
      if (!socket || socket.destroyed) return false;
      socket.write(`${JSON.stringify("result" in reply ? { jsonrpc: "2.0", id: call.id, result: reply.result } : { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: reply.error.message, data: { kind: reply.error.kind } } })}\n`);
      return true;
    },
    onKeys(fn: typeof onKeys) { onKeys = fn; },
    /**
     * 연결은 받고, 요청을 읽은 뒤 답 없이 끊는다(엔진이 요청을 받은 직후 죽은 모양). false 로 되돌리면 터미널은 그대로 남아 있다.
     * CoreRunner 에게는 "보냈는데 답이 없다"라서 결과를 모르는 실패다(CoreError kind "closed", deliveryEffect "unknown").
     * 글을 넣거나 터미널을 끝내는 요청이면 '했는지 모름' 갈래를 탄다. 엔진이 처음부터 내려가 있는 상황(다시 시도해도 되는 실패)은 setRefusing 이다.
     */
    setDown(down: boolean) { state.down = down; if (down) for (const socket of sockets) socket.destroy(); },
    /**
     * 엔진이 내려가 있다: 소켓을 닫아 연결 자체가 거절된다(소켓 파일 없음, ENOENT). false 로 되돌리면 같은 자리에서 다시 듣고 터미널은 그대로 남아 있다.
     * CoreRunner 에게는 "보내지 못했다"라서 확정된 실패다(CoreError kind "down", deliveryEffect "not_written"). 전달은 `down` 사유로 돌아오고 다시 시도된다.
     * 내려간 동안의 요청은 calls 에 남지 않는다(받은 적이 없다).
     */
    async setRefusing(refusing: boolean) { await (refusing ? unlisten() : listen()); },
    setDirectives(directives: string) { state.directives = directives; },
    setScript(script: FakeScriptRule[]) { state.script = script; },
    setOnTurn(fn: FakeCoreOptions["onTurn"] | null) { state.onTurn = fn ?? null; },
    setVersion(version: string) { state.version = version; },
    stop(): Promise<void> {
      return stopped ??= (async () => {
        stopping = true;
        for (const holder of holders.values()) holder.abort?.abort(new Error("fixture stopped"));
        await unlisten();
        if (ownedDir) rmSync(ownedDir, { recursive: true, force: true });
      })();
    },
  };
}
export type FakeCore = Awaited<ReturnType<typeof startFakeCore>>;

export interface CoreSetupOptions {
  /** IAMCEO 홈(DB·설정·실행 파일). 넘기면 그 폴더를 그대로 쓴다(재시작 시험). 프로젝트 폴더도 기본은 이곳이다. */
  home?: string;
  /** 이미 떠 있는 가짜 core 를 이어 쓴다(서버만 다시 띄우는 시험). 넘기면 close() 가 core 를 내리지 않는다. */
  core?: FakeCore;
  /** 모든 턴의 기본 @fake: 지시. */
  directives?: string;
  script?: FakeScriptRule[];
  onTurn?: FakeCoreOptions["onTurn"];
  timings?: Partial<OrchestratorTimings>;
  /** 직원 도구 구현. 넘기지 않으면 도구 호출은 서버가 "도구 없음"으로 답한다. */
  agentTools?: AgentToolsImpl;
  notifier?: (title: string, body: string) => void;
  /** CoreRunner 의 간격·제한 시간. 기본은 빠른 시험용 값(pollMs 20 등)이다. */
  runnerDeps?: AssemblyOverrides["runnerDeps"];
  fake?: Pick<FakeCoreOptions, "version" | "endState" | "startState" | "geminiStatus" | "geminiAutoUnavailable" | "geminiCompact">;
  /**
   * 옛 herdr 소켓 설정 자리. 주면 환경 변수(IAMCEO_HERDR_SOCKET)와 설정 파일(herdrSocket) 양쪽에 적는다.
   * 서버는 이 값을 읽지 않는다: 적혀 있어도 그 소켓을 열지 않는다는 것을 시험할 때 쓴다.
   */
  herdrSocket?: string;
  /** 새 프로젝트를 만들지 않고 이 홈에 이미 있는 프로젝트를 쓴다(같은 홈으로 다시 띄울 때). */
  projectId?: string;
  /**
   * 운영 조립(bin/iamceo.ts)처럼 서버를 띄운 뒤 initializeRuntime()·recover() 를 부른다(감시 시작·연결 확인·틱 시작). 기본 true.
   * false 면 감시와 틱이 한 번도 시작되지 않은 총괄이다. 복구 전의 상태를 손으로 만들고 recover() 를 직접 부르는 시험에만 쓴다.
   */
  live?: boolean;
  /** 운영처럼 iPhone 알림 사건 기록기(PushEventRecorder)를 붙인다. 붙이면 push 로 그 사건 저장소를 읽는다(기기는 등록하지 않는다). */
  push?: boolean;
}
const FAST_RUNNER: NonNullable<CoreRunnerDeps> = { pollMs: 20, rpcTimeoutMs: 2000, sendTimeoutMs: 2000, contextTimeoutMs: 300 };
/** 재시작으로 꺼진 팀장을 다시 여는 줄의 빠른 시험용 간격. 한 번에 여는 수와 자리 잡기를 기다리는 상한은 운영 값 그대로다. */
const FAST_RESTART_WAKE: Partial<OrchestratorTimings> = { restartWakeGapMs: 0, restartWakePollMs: 15 };

/**
 * 총괄 시험 한 벌: 가짜 core + 실제 CoreRunner + 운영 배선의 Orchestrator + 실제 HTTP 서버.
 * 옛 tests/orchestrator.test.ts 의 setup() 자리다. 끝나면 close() 를 부른다(시험 파일의 afterAll·afterEach 에 모아 둔다).
 */
export async function coreSetup(opts: CoreSetupOptions = {}): Promise<CoreEnv> {
  const base = await assemble(opts);
  return {
    ...base,
    /** 서버를 내리고 같은 홈·같은 core 에 새 서버를 붙인다. 운영의 재시작처럼 initializeRuntime()·recover() 까지 돈 뒤에 돌아온다(live: false 로 끌 수 있다). */
    async restart(next = {}) {
      await base.stopServer();
      return coreSetup({ timings: opts.timings, agentTools: opts.agentTools, notifier: opts.notifier, runnerDeps: opts.runnerDeps, herdrSocket: opts.herdrSocket, live: opts.live, push: opts.push, ...next, home: base.home, core: base.core, projectId: base.project.id });
    },
  };
}
type CoreEnvBase = Awaited<ReturnType<typeof assemble>>;
export interface CoreEnv extends CoreEnvBase {
  restart(next?: Omit<CoreSetupOptions, "home" | "core" | "projectId">): Promise<CoreEnv>;
}
async function assemble(opts: CoreSetupOptions) {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "iamceo-core-"));
  const claudeHome = join(home, "claude-home"), codexHome = join(home, "codex-home"), geminiHome = join(home, "gemini-home");
  for (const dir of [claudeHome, codexHome, geminiHome]) mkdirSync(dir, { recursive: true });
  const core = opts.core ?? await startFakeCore({ claudeHome, contextHome: home, geminiHome, directives: opts.directives, script: opts.script, onTurn: opts.onTurn, ...opts.fake });
  if (opts.core) {
    if (core.claudeHome !== claudeHome) throw new Error("이어 쓰는 가짜 core 는 같은 home 으로 만든 것이어야 합니다");
    if (opts.directives !== undefined) core.setDirectives(opts.directives);
    if (opts.script) core.setScript(opts.script);
    if (opts.onTurn) core.setOnTurn(opts.onTurn);
  }
  // 실제 실행 파일은 어느 것도 부르지 않는다. CLI 자리는 실행하면 실패하는 파일이고(가짜 core 는 argv 를 적기만 한다), core 는 이미 떠 있는 가짜 소켓이다.
  // Gemini(agy)도 같다: 실행 파일 자리는 /usr/bin/false, 자료 폴더는 이 홈 안의 임시 폴더다(이 Mac 의 ~/.gemini 를 보지 않는다).
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_TEST: "1", IAMCEO_CORE_SOCKET: core.socketPath, IAMCEO_CORE_BIN: "/usr/bin/false",
    IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false", IAMCEO_GEMINI_BIN: "/usr/bin/false", IAMCEO_GEMINI_HOME: geminiHome,
    IAMCEO_HERDR_SOCKET: opts.herdrSocket ?? join(home, "no-herdr.sock"), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  if (opts.herdrSocket) {
    const path = join(home, "config.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), herdrSocket: opts.herdrSocket }), { mode: 0o600 });
  }
  const config = loadConfig(env);
  const bus = new Bus();
  const db = openDb(config.dbPath);
  const push = opts.push ? new PushStore(db) : null;
  const store = new Store(db, bus, push ? new PushEventRecorder(push) : undefined);
  const orch: Orchestrator = createOrchestrator(config, store, {
    runner: { claudeHome, codexHome, geminiHome, geminiBin: "/usr/bin/false" },
    runnerDeps: { ...FAST_RUNNER, ...opts.runnerDeps },
    orchestrator: { providerHomes: { claudeHome, codexHome }, agentTools: opts.agentTools, timings: { ...FAST_RESTART_WAKE, ...opts.timings }, notifier: opts.notifier },
  });
  const runner = (orch as unknown as { runners: Map<Backend, Runner> }).runners.get("core") as CoreRunner;
  const server: RunningServer = await startServer({ config, store, bus, orch });
  const base = server.urls[0]!;
  orch.setServerUrl(base);
  // 운영과 같은 순서: 서버 주소를 알린 뒤 감시를 시작하고(initializeRuntime) 복구를 돌려 틱을 시작한다(recover).
  if (opts.live ?? true) { await orch.initializeRuntime(); await orch.recover(); }
  let closed: Promise<void> | null = null;
  /** 서버만 내린다. 터미널은 core 에 남는다(운영에서 IAMCEO 를 내릴 때와 같다). */
  const stopServer = () => closed ??= (async () => { await orch.shutdown(); await server.stop(); db.close(); })();
  const project = opts.projectId ? store.requireProject(opts.projectId) : store.createProject({ name: "시험 프로젝트", cwd: home });
  const member = (id: string): Member => store.requireMember(id);
  async function waitFor<T>(what: string, read: () => T | null | undefined | false, ms = 10_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() > end) throw new Error(`시간 초과: ${what}`);
      await Bun.sleep(15);
    }
  }
  return {
    home, config, env, store, bus, db, orch, runner, server, core, push,
    /** 시험 서버 주소(http://127.0.0.1:포트). */
    base,
    /** 접속 코드를 붙여 시험 서버의 HTTP API 를 부른다. */
    api: (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { Authorization: "Bearer code", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    project,
    member,
    texts: (projectId = project.id) => store.listMessages(projectId, { limit: 500 }),
    /** 턴 기록. 옛 starts() 자리: 받은 글은 prompt, 띄운 인자는 run.argv·run.sessionFlag·run.resumeFlag. */
    turns: (memberId?: string) => core.turns(memberId),
    /** 서버가 스스로 붙인 '보고 보완' 턴을 뺀 턴 기록. */
    workTurns: (memberId?: string) => core.turns(memberId).filter(turn => !isReportNudge(turn)),
    /** CLI 를 띄운 기록. 옛 starts() 에서 --session-id·--resume·모델 인자를 보던 자리. */
    runs: (memberId?: string) => core.runs().filter(r => !memberId || r.memberId === memberId),
    waitFor,
    /** 그 직원이 쉬는 상태가 될 때까지 기다린다(실행기도 서버 기록도). */
    idle: (id: string) => waitFor(`${id} 쉼`, () => !runner.isBusy(id) && member(id).status !== "working" && member(id)),
    stopServer,
    /** 서버를 내리고, 이 호출이 만든 가짜 core 면 그것도 내린다. 임시 홈은 지우지 않는다(게이트가 TMPDIR 째로 지운다). */
    async close() {
      await stopServer();
      if (!opts.core) await core.stop();
    },
  };
}
