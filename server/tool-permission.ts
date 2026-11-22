// K(E2): 도구 승인을 결재함에서 답하기.
//
// 팀장의 Claude Code 가 도구 승인 창 앞에 서면 PermissionRequest 훅(server/runner/permission-hook.ts)이 이 Mac 의 서버
// (팀장용 /agent 통로, 팀장 열쇠)에 요청을 올린다. 서버는 그 요청을 결재 카드(kind "tool_permission")로 띄우고 대표의 답을 훅에 돌려준다.
//
// 지키는 것
// - 답이 없으면(시간이 지남, 서버가 없음, 훅이 끊김) 훅은 아무것도 출력하지 않고 끝난다. CLI 는 터미널의 원래 승인 창으로 간다.
// - 허용은 '이번 한 번만'이다. 승인 규칙(앞으로 늘 허용)은 넣지 않는다.
// - 도구 입력 원문은 저장하지 않는다. 비밀로 보이는 값은 가리고 길면 자른 요약만 카드에 싣는다.
// - 카드는 대표가 답하거나, 시간이 지나거나, 훅이 끊기거나(CLI 가 다른 길로 답을 받음·턴을 멈춤·서버 재시작), 터미널에서 먼저 답한 것으로
//   보이면(승인 창이 닫힘) 닫힌다. 닫힌 카드는 다시 열 수 없다.
// - 한 번의 기다림은 50초까지다(서버의 유휴 연결 제한 255초 아래). 훅이 같은 카드를 다시 기다린다. 기다리는 요청이 없는 채로
//   20초가 지나면 훅이 끊긴 것으로 본다.
import type { AnswerReq, Decision, DecisionOption, Member, ToolPermissionInfo } from "../shared/types.ts";
import { ApiError, type Store } from "./store.ts";
import { josa } from "./roles.ts";
import { TOOL_PERMISSION_POLL_MS, TOOL_PERMISSION_TTL_MS } from "./runner/permission-hook.ts";
import { GEMINI_TOOL_KINDS, type GeminiToolKind } from "./runner/gemini-tool-hook.ts";
import { langsParam, mustRender, SERVER_TEXTS, textRef, type ServerTextCode, type ServerTextRef, type TextLang } from "../shared/server-text.ts";

export { TOOL_PERMISSION_POLL_MS, TOOL_PERMISSION_TTL_MS };
/** 기다리는 요청이 없는 채로 이만큼 지나면 훅이 끊긴 것으로 보고 닫는다. */
export const TOOL_PERMISSION_GONE_MS = 20_000;
/** 승인 창 앞(blocked)이던 팀장이 이만큼 계속 다른 상태면 터미널에서 먼저 답한 것으로 보고 닫는다. 연이은 승인 창 사이의 깜빡임은 넘긴다. */
export const TOOL_PERMISSION_TERMINAL_GRACE_MS = 3_000;
/** 답한 뒤 이만큼은 같은 팀장의 '승인 대기' 알림을 내지 않는다(상태 반영이 늦어 막힘이 잠깐 남는다). */
const ANSWERED_QUIET_MS = 15_000;

export const TOOL_PERMISSION_OPTIONS: DecisionOption[] = [
  { k: "allow", label: "허용", desc: "이번 한 번만 실행합니다" },
  { k: "deny", label: "거절", desc: "실행하지 않고 팀장에게 알립니다" },
];

/** 훅이 올리는 요청(POST /agent/permission). 도구 입력은 훅이 미리 줄여 보낸다. */
export interface ToolPermissionRequest {
  toolName: string;
  toolInput?: unknown;
  sessionId?: string | null;
  cwd?: string | null;
  permissionMode?: string | null;
  agentId?: string | null;
  /** 0.2.10: "gemini" 면 Antigravity CLI 의 도구 훅(PreToolUse)이 올린 것이다. 없으면 Claude 의 PermissionRequest 훅이다. */
  cli?: string | null;
  /** Gemini: 훅이 정한 도구의 종류(gemini-tool-hook.ts GEMINI_TOOL_KINDS). 서버가 지금 모드에서 agy 가 물을 종류인지 가린다. */
  geminiKind?: string | null;
  /** Gemini: 그 도구 호출의 id(훅 입력 toolCall.id). 기록에만 쓴다. */
  toolCallId?: string | null;
}

/**
 * Gemini(Antigravity CLI) 팀장의 지금 모드. agy 의 PreToolUse 훅은 모든 도구 호출에 와서, 카드를 열지는 '그 모드에서 agy 가 물을 것인가'로 정한다.
 * default: 권한 '매번 묻기'(agentMode "")·plan, 또는 auto 가 들지 않은 실행. accept-edits: 작업 폴더 안 파일 쓰기만 묻지 않는다(사람이 Shift+Tab 으로 고름).
 * auto: agy auto 모드(파일 고치기·샌드박스 안 명령은 묻지 않고, 샌드박스 밖 명령은 agy 의 평가기가 위험한 것만 묻는다).
 * fallback: auto 대신의 모드(accept-edits + 터미널 샌드박스 + proceed-in-sandbox).
 */
export type GeminiEffectiveMode = "default" | "accept-edits" | "auto" | "fallback";
/**
 * 그 모드에서 agy 가 묻는 종류(문서 docs_permissions.md·docs_cli_modes.md, 1.5.14 헤드리스 실측). Claude 와 같은 뜻이 되게 한다:
 * Claude 의 PermissionRequest 는 CLI 가 승인 창을 띄우려 할 때만 오므로, agy 가 창을 띄울 종류만 카드로 연다.
 * - 명령: default·accept-edits 는 매번 묻는다(request-review). auto·fallback 은 샌드박스 안이면 묻지 않고 밖은 agy 의 평가기·창이 정한다:
 *   훅에서는 어느 쪽인지 모르므로 카드를 열지 않고 agy 에 맡긴다(위험한 명령은 오늘처럼 agy 의 창 = 터미널 승인 대기).
 * - 작업 공간 안 파일 쓰기: default 만 묻는다(diff 검토). 임시 폴더: auto·fallback 은 묻지 않는다. 그 밖의 폴더·IAMCEO 밖의 연결 도구·웹: 늘 묻는다.
 * 1.5.14 대화형 실측(agy-real, 훅 없이 agy 자기 창): default 는 run_command·write_file(새 파일)·edit_file 을 모두 물었고, accept-edits 는 새 파일을 묻지 않고
 * run_command 는 물었고, auto 는 새 파일·'ls && rm a.txt' 를 묻지 않았다(작업 공간 안). 표의 그 칸들과 같다.
 * 1.5.14 격리 서버 대화형 실측(11-23, 결재함 훅이 붙은 실제 팀장): default 팀장의 run_command·write_file 은 카드로 떴고, auto 팀장(상태줄 cycle_mode auto)의
 * 작업 폴더 안 write_file·명령은 카드 없이 돌았다. auto 에서 agy 의 평가기가 물은 명령 하나를 보았다: 이 Mac 의 서버로 가는 `curl -X POST …/agent/tool`
 * (까닭 'sends a POST request to a pre-existing local … server that was not spawned by the agent'). 명령은 카드를 열지 않는 종류라 그 창(터미널 승인 대기)으로 남았다.
 * UNVERIFIED-INTERACTIVE: auto·accept-edits 의 임시 폴더·작업 공간 밖·웹·연결 도구는 유도하지 못했다.
 * 대표가 agy 에 둔 허용 규칙(settings.json permissions.allow)은 보지 않는다: 그 규칙으로 agy 가 묻지 않을 도구에도 카드가 열릴 수 있다(허용하면 그대로 돈다).
 */
const GEMINI_ASKS: Record<GeminiEffectiveMode, ReadonlySet<GeminiToolKind>> = {
  default: new Set(GEMINI_TOOL_KINDS),
  "accept-edits": new Set<GeminiToolKind>(["command", "edit_temp", "edit_outside", "read_temp", "read_outside", "mcp", "web"]),
  auto: new Set<GeminiToolKind>(["edit_outside", "read_outside", "mcp", "web"]),
  fallback: new Set<GeminiToolKind>(["edit_outside", "read_outside", "mcp", "web"]),
};
/** 그 모드에서 이 종류의 도구에 결재함 카드를 열 것인가. 모르는 종류는 열지 않는다(agy 의 원래 창으로 둔다). */
export function geminiNeedsCard(kind: string | null | undefined, mode: GeminiEffectiveMode): boolean {
  return typeof kind === "string" && (GEMINI_TOOL_KINDS as readonly string[]).includes(kind) && GEMINI_ASKS[mode].has(kind as GeminiToolKind);
}
/**
 * Gemini 훅이 올린 도구를 카드에 보일 이름·입력으로 바꾼다. call_mcp_tool 은 Claude 와 같은 `mcp__<서버>__<도구>` 와 그 인자로 보인다(연결 도구 카드).
 * 그 밖은 이름 그대로다(run_command·write_file … 은 ACTIONS 에서 '명령 실행'·'파일 쓰기' 등으로 그린다).
 */
export function geminiToolForCard(toolName: string, toolInput: unknown): { toolName: string; toolInput: unknown } {
  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput as Record<string, unknown> : {};
  if (toolName === "call_mcp_tool" && typeof input.ServerName === "string" && typeof input.ToolName === "string") {
    const part = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "_";
    return { toolName: `mcp__${part(input.ServerName)}__${part(input.ToolName)}`, toolInput: input.Arguments ?? {} };
  }
  return { toolName, toolInput };
}
/** 훅이 받는 답. pending 이면 같은 id 로 다시 기다린다. allow·deny 면 CLI 에 그대로 답하고, closed 면 아무것도 출력하지 않는다. */
export interface ToolPermissionPoll { id: string | null; state: "pending" | "allow" | "deny" | "closed"; message?: string }

export interface ToolPermissionDeps {
  store: Store;
  /** 이 Mac 의 알림(결재 알림 설정을 따른다). */
  notify(title: string | ServerTextRef, body: string | ServerTextRef): void;
  /** 허용하며 남긴 메모. 훅의 허용 답에는 글을 실을 수 없어, 팀장의 다음 입력으로 보낸다. */
  deliverNote(member: Member, decision: Decision): void;
  /** 답 없이 시간이 지나 닫았는데 팀장이 아직 승인 창 앞이다. */
  stillBlocked?(member: Member): void;
  /** Gemini 팀장의 지금 모드(Orchestrator: 권한 방식·대신하는 모드·상태줄의 cycle_mode). 없으면 default 로 본다(모든 종류에 카드). */
  geminiMode?(member: Member): GeminiEffectiveMode;
  now?(): number;
  ttlMs?: number;
  pollMs?: number;
  goneMs?: number;
  graceMs?: number;
  /** 끊긴 훅을 찾는 주기. 기본 5초. */
  sweepMs?: number;
}

interface Entry {
  id: string;
  memberId: string;
  expiresAt: number;
  /** 지금 기다리는 요청 수. */
  inflight: number;
  /** 두 언어의 대상(답한 뒤의 활동 줄). */
  targets: ToolTargets;
  /** 마지막으로 요청이 들어오거나 끝난 때. */
  lastSeen: number;
  answer: { state: "allow" | "deny"; message?: string } | null;
  closed: boolean;
  /** 이 카드가 열린 뒤 팀장이 승인 창 앞(blocked)으로 관측된 적이 있다. */
  sawBlocked: boolean;
  /**
   * '승인 창이 닫혔으니 터미널에서 먼저 답했다'로 닫을 수 있는 카드인가. Gemini 카드는 아니다: agy 는 훅이 붙잡는 동안 그 호출의 창을 띄우지 않으므로
   * 터미널에서 먼저 답할 수 없고, 같은 팀장의 서브에이전트가 띄운 다른 창(blocked)이 닫힌 것을 이 카드의 답으로 읽으면 안 된다.
   * 1.5.14 대화형 실측(훅 없이): agy 자기 승인 창이 뜨면 OSC 는 blocked·permission(msg 'Approve Bash: …'·'Approve Edit: Write: …'), 상태줄은 agent_state tool_use·
   * tool_confirmation_pending true 다(gemini-screen.ts geminiApprovalDialog). 서버는 그 창에 키를 보내지 않는다(대표가 터미널에서 답한다).
   * 1.5.14 대화형 실측(격리 서버 + 실제 agy, 11-23, 견본 srv-hook-wait.txt): 훅이 카드의 답을 4분 붙잡는 동안 agy 자기 승인 창은 뜨지 않았다. 화면은 '○ Running (pwd)'
   * 와 진행 줄 'Running command...', OSC 는 working, 상태줄 agent_state 는 working(tool_use 아님)이었고, 허용하자 명령이 돌고 턴이 done 으로 끝났다.
   * UNVERIFIED-INTERACTIVE: 훅이 붙잡는 동안 Esc 로 턴을 멈추면 훅이 끊기는지(카드가 '터미널 쪽이 끝남'으로 닫히는지)는 아직 못 봤다.
   */
  terminalAnswerable: boolean;
  grace: ReturnType<typeof setTimeout> | null;
  wake: Set<() => void>;
}

/** 훅의 허용이 듣지 않는, 사람이 직접 답하는 도구. */
const PERSON_ONLY_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

const MASK = "••••";
const MAX_TARGET = 600;
const MAX_TARGET_LINES = 12;
const MAX_TITLE_TARGET = 70;
const MAX_ACTION = 60;

/**
 * 0.2.6 Y 리뷰: 서버가 '대상'(target)에 붙이는 말. 한국어는 예전 글자 그대로다. 영어 카드·활동 줄에 한국어 조각이 섞이지 않게
 * 대상을 두 언어로 따로 만들어(langsParam) 카드의 값으로 싣는다. 앱은 화면 언어 쪽을 쓴다.
 */
const FRAGMENTS: Record<TextLang, { more(count: number): string; moreLines(count: number): string; size(count: number): string; noPath: string; empty: string; privateKey: string }> = {
  ko: { more: count => `…(${count}자 더 있음)`, moreLines: count => `\n…(${count}줄 더 있음)`, size: count => ` (${count}자)`, noPath: "(경로 없음)", empty: "(내용 없음)", privateKey: "[가린 개인 키]" },
  en: { more: count => `… (${count} more characters)`, moreLines: count => `\n… (${count} more lines)`, size: count => ` (${count} characters)`, noPath: "(no path)", empty: "(no content)", privateKey: "[private key hidden]" },
};

/** 이름 뒤의 값만 가린다. 따옴표는 남겨 모양을 알아볼 수 있게 한다. */
function maskValue(_match: string, name: string, value: string): string {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
  return `${name}${quote}${MASK}${quote}`;
}

/** 흔히 쓰이는 비밀 모양을 가린다. 지나치게 가리더라도 새는 것보다 낫다. */
export function redactSecrets(text: string, lang: TextLang = "ko"): string {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, FRAGMENTS[lang].privateKey)
    .replace(/\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1$2${MASK}`)
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, MASK)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK)
    .replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, MASK)
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK)
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK)
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, MASK)
    .replace(/\bnpm_[A-Za-z0-9]{30,}/g, MASK)
    // 주소 안의 사용자:비밀번호@
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${MASK}@`)
    // 이름이 비밀을 뜻하는 값: TOKEN=…, "password": "따옴표 안 글", api_key: …
    .replace(/(\b[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)("[^"\n]+"|'[^'\n]+'|[^\s"'&;|,}]{3,})/gi, maskValue)
    // --password xxx, --token=xxx, --key "따옴표 안 글" 같은 명령 옵션
    .replace(/(--?(?:token|password|passwd|secret|api-?key|auth|key)(?:=|\s+))("[^"\n]+"|'[^'\n]+'|[^\s"']{3,})/gi, maskValue)
    // 글자와 숫자가 섞인 아주 긴 조각(열쇠·토큰). 경로(/)·점이 든 것은 두고, 40자 커밋 해시는 남는다.
    .replace(/[A-Za-z0-9+_-]{48,}={0,2}/g, match => /[0-9]/.test(match) && /[A-Za-z]/.test(match) ? MASK : match);
}

function clip(text: string, max: number, lang: TextLang = "ko"): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}${FRAGMENTS[lang].more(chars.length - max)}`;
}
function clipLines(text: string, maxLines: number, lang: TextLang = "ko"): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : `${lines.slice(0, maxLines).join("\n")}${FRAGMENTS[lang].moreLines(lines.length - maxLines)}`;
}
function oneLine(text: string): string { return text.replace(/\s+/g, " ").trim(); }
/** 활동 줄(300자)의 끝 값. 예전처럼 그 언어의 줄 전체를 300자에서 자른 것과 같게, 머리의 길이를 뺀 만큼 값을 자른다(한국어는 예전 글자 그대로). */
function clipAfter(code: ServerTextCode, action: ServerTextRef, target: string, lang: TextLang = "ko"): string {
  return clip(target, Math.max(1, 300 - Array.from(mustRender(textRef(code, { action, target: "" }), lang)).length), lang);
}
/** 두 언어의 대상. ko 는 예전 글자 그대로, en 은 영어 붙임말. */
export interface ToolTargets { ko: string; en: string }
function activityTarget(code: ServerTextCode, action: ServerTextRef, targets: ToolTargets) {
  return langsParam(clipAfter(code, action, oneLine(targets.ko), "ko"), clipAfter(code, action, oneLine(targets.en), "en"));
}
function str(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function homeShort(path: string): string {
  const home = process.env.HOME;
  return home && home.length > 1 && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}
function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

const ACTIONS: Record<string, string> = {
  Bash: "명령 실행",
  BashOutput: "명령 출력 읽기",
  KillShell: "실행 중인 명령 끝내기",
  KillBash: "실행 중인 명령 끝내기",
  Edit: "파일 고치기",
  MultiEdit: "파일 고치기",
  Write: "파일 쓰기",
  NotebookEdit: "노트북 고치기",
  Read: "파일 읽기",
  Glob: "파일 찾기",
  Grep: "파일 내용 찾기",
  LS: "폴더 보기",
  WebFetch: "웹 페이지 가져오기",
  WebSearch: "웹 검색",
  Task: "하위 작업 맡기기",
  Agent: "하위 작업 맡기기",
  Skill: "스킬 쓰기",
  SlashCommand: "명령어 쓰기",
  // Gemini(Antigravity CLI) 의 도구 이름(훅에 보이는 이름). 같은 '무엇을'로 그린다.
  run_command: "명령 실행",
  write_file: "파일 쓰기",
  write_to_file: "파일 쓰기",
  edit_file: "파일 고치기",
  replace_file_content: "파일 고치기",
  multi_replace_file_content: "파일 고치기",
  sed_file: "파일 고치기",
  notebook_edit: "노트북 고치기",
  read_file: "파일 읽기",
  view_file: "파일 읽기",
  read_url_content: "웹 페이지 가져오기",
  open_browser_url: "웹 페이지 가져오기",
  browser_subagent: "웹 페이지 가져오기",
  search_web: "웹 검색",
  invoke_subagent: "하위 작업 맡기기",
};

/**
 * 도구 이름과 입력에서 '무엇을'(action)과 '어디에'(target)를 만든다. target 은 가리고 자른 것이다.
 * lang: 대상에 붙이는 말('(5자)', '…(N자 더 있음)' 등)의 언어. 한국어가 예전 그대로다. action 은 늘 한국어(대조용, 카드는 toolActionRef 로 그린다).
 */
export function describeToolRequest(toolName: string, toolInput: unknown, lang: TextLang = "ko"): { action: string; target: string } {
  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput as Record<string, unknown> : {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  let action = ACTIONS[toolName] ?? (mcp ? `연결 도구 쓰기(${mcp[1]})` : `도구 쓰기(${toolName})`);
  let target: string;
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (toolName) {
    case "Bash": target = str(input.command) ?? ""; break;
    case "Write": {
      const size = typeof input.content === "string" ? Array.from(input.content).length : null;
      target = `${path ? homeShort(path) : FRAGMENTS[lang].noPath}${size !== null ? FRAGMENTS[lang].size(size) : ""}`;
      break;
    }
    case "Edit": case "MultiEdit": case "NotebookEdit": case "Read": case "LS":
      target = path ? homeShort(path) : ""; break;
    case "Glob": case "Grep":
      target = [str(input.pattern), path ? homeShort(path) : null].filter(Boolean).join(" · "); break;
    case "WebFetch": target = str(input.url) ?? ""; break;
    case "WebSearch": target = str(input.query) ?? ""; break;
    case "Task": case "Agent":
      target = [str(input.subagent_type), str(input.description)].filter(Boolean).join(" · "); break;
    // Gemini(Antigravity CLI) 의 인자 이름(1.5.14 실측: run_command CommandLine·Cwd, write_file Path·Content, edit_file Path, read_file Path).
    case "run_command": target = str(input.CommandLine) ?? ""; break;
    case "write_file": case "write_to_file": {
      const file = str(input.Path) ?? str(input.TargetFile);
      const body = typeof input.Content === "string" ? input.Content : typeof input.CodeContent === "string" ? input.CodeContent : null;
      target = `${file ? homeShort(file) : FRAGMENTS[lang].noPath}${body !== null ? FRAGMENTS[lang].size(Array.from(body).length) : ""}`;
      break;
    }
    case "edit_file": case "replace_file_content": case "multi_replace_file_content": case "sed_file": case "notebook_edit": case "read_file": case "view_file": {
      const file = str(input.Path) ?? str(input.TargetFile) ?? str(input.AbsolutePath) ?? str(input.FilePath);
      target = file ? homeShort(file) : "";
      break;
    }
    case "read_url_content": case "open_browser_url": target = str(input.Url) ?? str(input.url) ?? ""; break;
    case "search_web": target = str(input.query) ?? str(input.Query) ?? ""; break;
    case "invoke_subagent": target = [str(input.TypeName), str(input.Role)].filter(Boolean).join(" · "); break;
    default:
      target = mcp ? `${mcp[2]} ${safeJson(toolInput)}` : safeJson(toolInput);
  }
  if (!target.trim()) target = clip(safeJson(toolInput), 200, lang) || FRAGMENTS[lang].empty;
  action = clip(oneLine(action), MAX_ACTION);
  return { action, target: clipLines(clip(redactSecrets(target, lang), MAX_TARGET, lang), MAX_TARGET_LINES, lang) };
}

/** 두 언어의 대상(ko 는 describeToolRequest 그대로). */
export function describeToolTargets(toolName: string, toolInput: unknown): ToolTargets {
  return { ko: describeToolRequest(toolName, toolInput, "ko").target, en: describeToolRequest(toolName, toolInput, "en").target };
}

/** 마크다운 코드 블록 울타리. 내용 안의 가장 긴 ` 줄보다 길게 둔다. */
function fence(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), m => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** 카드 본문의 마지막 줄. 선택 없이 메모만 보낸 답은 거절이다(answer). */
export const TOOL_PERMISSION_NOTE_ONLY = "허용·거절 가운데 하나를 고르세요. 메모만 보내면 거절로 처리합니다.";

/** 0.2.6 Y: 도구 이름의 '무엇을' 코드(shared/server-text.ts tool.action.*). 한국어로 그리면 ACTIONS 와 같다. */
const ACTION_CODES: Record<string, ServerTextCode> = {
  Bash: "tool.action.bash", BashOutput: "tool.action.bash_output", KillShell: "tool.action.kill_shell", KillBash: "tool.action.kill_shell",
  Edit: "tool.action.edit", MultiEdit: "tool.action.edit", Write: "tool.action.write", NotebookEdit: "tool.action.notebook_edit",
  Read: "tool.action.read", Glob: "tool.action.glob", Grep: "tool.action.grep", LS: "tool.action.ls", WebFetch: "tool.action.web_fetch",
  WebSearch: "tool.action.web_search", Task: "tool.action.task", Agent: "tool.action.task", Skill: "tool.action.skill", SlashCommand: "tool.action.slash_command",
  // Gemini(Antigravity CLI): 기존 코드에 잇는다(새 글 코드·앱 변경 없음).
  run_command: "tool.action.bash", write_file: "tool.action.write", write_to_file: "tool.action.write", edit_file: "tool.action.edit", replace_file_content: "tool.action.edit",
  multi_replace_file_content: "tool.action.edit", sed_file: "tool.action.edit", notebook_edit: "tool.action.notebook_edit", read_file: "tool.action.read", view_file: "tool.action.read",
  read_url_content: "tool.action.web_fetch", open_browser_url: "tool.action.web_fetch", browser_subagent: "tool.action.web_fetch", search_web: "tool.action.web_search", invoke_subagent: "tool.action.task",
};
export function toolActionRef(toolName: string): ServerTextRef {
  const known = ACTION_CODES[toolName];
  if (known) return textRef(known);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  const [code, clipped, key, raw] = mcp ? ["tool.action.mcp", "tool.action.mcp_clipped", "server", mcp[1]!] as const : ["tool.action.other", "tool.action.other_clipped", "tool", toolName] as const;
  // 0.2.6 Y 리뷰: 예전 '무엇을'은 한국어 문장을 한 줄로 펴(oneLine) 60자에서 잘랐다(clip). 코드로 그려도 한국어는 그 글자 그대로가 되게
  // 값을 펴고, 한국어 문장이 60자를 넘으면 잘린 앞부분과 잘려 나간 글자 수를 값으로 싣는다(값 앞 머리는 '연결 도구 쓰기(' 9자, '도구 쓰기(' 6자).
  const value = raw.replace(/\s+/g, " ");
  const whole = Array.from(mustRender(textRef(code, { [key]: value }), "ko")).length;
  if (whole <= MAX_ACTION) return textRef(code, { [key]: value });
  const head = Array.from(SERVER_TEXTS[code].ko.slice(0, SERVER_TEXTS[code].ko.indexOf(`{${key}}`))).length;
  return textRef(clipped, { [key]: Array.from(value).slice(0, MAX_ACTION - head).join(""), count: String(whole - MAX_ACTION) });
}

/**
 * 0.2.6 Y: 카드의 글 코드. 보고 언어 한국어로 그리면 toolPermissionCard 와 글자까지 같다(tests/server-text.test.ts 대조).
 * 제목은 card.tool_permission.title(=`<무엇을>: <대상 한 줄>`), 선택지는 허용·거절의 이름과 설명.
 */
export function toolPermissionCardTexts(member: Pick<Member, "name">, info: ToolPermissionInfo, ttlMs: number, targets: ToolTargets = { ko: info.target, en: info.target }) {
  const minutes = Math.max(1, Math.round(ttlMs / 60_000));
  // 울타리는 대상 안의 가장 긴 ` 줄로 정한다. 두 언어의 대상은 가린 말의 길이가 달라 잘리는 자리가 다를 수 있어 따로 정한다.
  const bar = langsParam(fence(targets.ko), fence(targets.en));
  const action = toolActionRef(info.tool);
  return {
    text: textRef("card.tool_permission", { name: member.name, action, bar, target: langsParam(targets.ko, targets.en),
      titleTarget: langsParam(clip(oneLine(targets.ko), MAX_TITLE_TARGET, "ko"), clip(oneLine(targets.en), MAX_TITLE_TARGET, "en")),
      folderLine: info.cwd ? textRef("card.tool_permission.folder", { folder: homeShort(info.cwd) }) : "", minutes: String(minutes) }),
    options: {
      allow: { label: textRef("card.tool_permission.allow"), desc: textRef("card.tool_permission.allow_desc") },
      deny: { label: textRef("card.tool_permission.deny"), desc: textRef("card.tool_permission.deny_desc") },
    },
  };
}

export function toolPermissionCard(member: Pick<Member, "name">, info: ToolPermissionInfo, ttlMs: number): { title: string; detail: string } {
  const minutes = Math.max(1, Math.round(ttlMs / 60_000));
  const bar = fence(info.target);
  const detail = [
    `${josa(member.name, "이")} 터미널의 승인 창 앞에서 기다립니다. 허용하면 이번 한 번만 실행합니다.`,
    "",
    `**${info.action}**`,
    bar, info.target, bar,
    ...(info.cwd ? [`폴더: ${homeShort(info.cwd)}`] : []),
    "",
    `${minutes}분 안에 답하지 않으면 이 카드는 닫히고, 터미널의 승인 창에서 직접 답해야 합니다. 터미널에서 먼저 답해도 닫힙니다.`,
    // 출시된 앱(0.2.2·0.2.3)은 이 카드에도 '메모만 보내기'를 낸다. answer() 는 선택 없는 메모를 거절로 처리한다.
    TOOL_PERMISSION_NOTE_ONLY,
  ].join("\n");
  return { title: clip(`${info.action}: ${oneLine(info.target)}`, MAX_TITLE_TARGET + info.action.length + 2), detail };
}

/** 대표가 거절했을 때 CLI 가 AI 에게 전하는 글. */
export function denyMessage(note: string | null): string {
  return note ? `대표가 결재함에서 거절했습니다. 대표 메모: "${note.replace(/\s+/g, " ").trim().slice(0, 1500)}"` : "대표가 결재함에서 거절했습니다.";
}

export class ToolPermissions {
  private readonly entries = new Map<string, Entry>();
  /** 팀장별 마지막 답 시각(알림 조용히 하기). */
  private readonly answeredAt = new Map<string, number>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly deps: ToolPermissionDeps) {
    this.sweeper = setInterval(() => this.sweep(), deps.sweepMs ?? 5_000);
    this.sweeper.unref?.();
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private get ttl(): number { return this.deps.ttlMs ?? TOOL_PERMISSION_TTL_MS; }
  private get pollMs(): number { return this.deps.pollMs ?? TOOL_PERMISSION_POLL_MS; }
  private get goneMs(): number { return this.deps.goneMs ?? TOOL_PERMISSION_GONE_MS; }
  private get graceMs(): number { return this.deps.graceMs ?? TOOL_PERMISSION_TERMINAL_GRACE_MS; }

  /** 서버가 시작할 때: 지난 실행이 남긴 열린 카드를 닫는다(그 훅은 이미 끊겼다). 닫은 수를 돌려준다. */
  closeLeftovers(): number {
    let closed = 0;
    for (const decision of this.deps.store.listOpenToolPermissions()) {
      if (this.entries.has(decision.id)) continue;
      if (this.closeRow(decision.id, textRef("card.tool_permission.closed_restart"))) closed++;
    }
    return closed;
  }

  /** 이 팀장에게 대표의 답을 기다리는 카드가 열려 있다(답했거나 닫힌 카드는 빼고). 전달 펌프의 판정(tool_permission)이 쓴다. */
  waiting(memberId: string): boolean {
    for (const entry of this.entries.values()) if (entry.memberId === memberId && !entry.closed && !entry.answer) return true;
    return false;
  }

  /** 이 팀장에게 열린 카드가 있거나 방금 답했다. 그동안 '승인 대기' 알림을 따로 내지 않는다. */
  covers(memberId: string): boolean {
    if (this.waiting(memberId)) return true;
    const at = this.answeredAt.get(memberId);
    return at !== undefined && this.now() - at < ANSWERED_QUIET_MS;
  }

  /** 훅의 첫 요청. 카드를 열고 한 번 기다린다. */
  async request(member: Member, input: ToolPermissionRequest, signal?: AbortSignal): Promise<ToolPermissionPoll> {
    const { store } = this.deps;
    if (this.disposed || signal?.aborted) return { id: null, state: "closed" };
    const project = store.getProject(member.projectId);
    // 보관한 프로젝트의 카드는 화면에 없고 답도 409 다. 띄우지 않고 터미널의 원래 승인 창으로 둔다.
    // 설정의 권한 방식은 보지 않는다: 훅이 불렸다는 것은 CLI 가 지금 묻고 있다는 뜻이다.
    if (!project || project.archived) return { id: null, state: "closed" };
    // 사람이 터미널에서 직접 골라야 하는 도구(질문 창·계획 확정)는 CLI 가 훅의 허용을 받지 않는다. 카드를 띄우지 않는다.
    if (PERSON_ONLY_TOOLS.has(input.toolName)) return { id: null, state: "closed" };
    // Gemini: 훅은 모든 도구 호출에 온다. 지금 모드에서 agy 가 물을 종류일 때만 카드를 연다(아니면 훅은 판정 없이 끝나 agy 가 정한다).
    const gemini = input.cli === "gemini";
    if (gemini) {
      if (member.cli !== "gemini" || !geminiNeedsCard(input.geminiKind, this.deps.geminiMode?.(member) ?? "default")) return { id: null, state: "closed" };
      input = { ...input, ...geminiToolForCard(input.toolName, input.toolInput) };
    }
    // Y: '무엇을'·대상은 보고 언어로 적는다(한국어면 예전과 같다). 카드의 글은 코드로 넘겨 저장소가 보고 언어로 그린다.
    const lang = store.reportLang();
    const targets = describeToolTargets(input.toolName, input.toolInput);
    const target = targets[lang];
    const cwd = str(input.cwd) ?? member.cwd ?? null;
    const expiresAt = this.now() + this.ttl;
    // 코드가 이미 예전 60자 자르기를 담는다(toolActionRef). 한국어로 그리면 예전 clip(oneLine(action), 60) 과 같다.
    const actionRef = toolActionRef(input.toolName);
    const action = store.renderText(actionRef);
    const info: ToolPermissionInfo = { tool: clip(input.toolName, 200, lang), action, target, cwd, expiresAt: new Date(expiresAt).toISOString() };
    const { title, detail } = toolPermissionCard(member, info, this.ttl);
    const decision = store.createToolPermissionDecision({ projectId: member.projectId, memberId: member.id, who: member.name, title, detail, options: TOOL_PERMISSION_OPTIONS, toolPermission: info,
      texts: toolPermissionCardTexts(member, info, this.ttl, targets) });
    const entry: Entry = { id: decision.id, memberId: member.id, expiresAt, inflight: 0, targets, lastSeen: this.now(), answer: null, closed: false,
      sawBlocked: member.status === "blocked", terminalAnswerable: !gemini, grace: null, wake: new Set() };
    this.entries.set(decision.id, entry);
    store.appendActivity(member.id, "system", textRef("activity.tool_requested", { action: actionRef, target: activityTarget("activity.tool_requested", actionRef, targets) }));
    this.deps.notify(textRef("notice.tool_permission.title", { name: member.name }), textRef("card.tool_permission.title", { action: actionRef, titleTarget: oneLine(target) }));
    return this.waitOn(entry, signal);
  }

  /** 훅의 다음 기다림. 모르는 카드(서버 재시작 등)는 닫힌 것으로 답하고, 열려 있으면 닫는다. */
  async wait(member: Member, id: string, signal?: AbortSignal): Promise<ToolPermissionPoll> {
    const entry = this.entries.get(id);
    if (!entry) {
      const decision = this.deps.store.getDecision(id);
      if (decision?.kind === "tool_permission" && decision.memberId === member.id && decision.status === "open") this.closeRow(id, textRef("card.tool_permission.closed_cut"));
      return { id, state: "closed" };
    }
    if (entry.memberId !== member.id) throw new ApiError(403, "다른 팀장의 승인 요청입니다", "decision_not_own");
    return this.waitOn(entry, signal);
  }

  private result(entry: Entry): ToolPermissionPoll | null {
    if (entry.answer) {
      // 훅에 답을 건넸다. 더는 기다릴 일이 없다.
      this.entries.delete(entry.id);
      return { id: entry.id, state: entry.answer.state, ...(entry.answer.message ? { message: entry.answer.message } : {}) };
    }
    if (entry.closed) return { id: entry.id, state: "closed" };
    return null;
  }

  private async waitOn(entry: Entry, signal?: AbortSignal): Promise<ToolPermissionPoll> {
    const ready = this.result(entry);
    if (ready) return ready;
    entry.inflight++;
    entry.lastSeen = this.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wake: (() => void) | null = null;
    const onAbort = () => wake?.();
    try {
      await new Promise<void>(resolve => {
        wake = resolve;
        entry.wake.add(resolve);
        timer = setTimeout(resolve, Math.max(0, Math.min(this.pollMs, entry.expiresAt - this.now())));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) resolve();
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (wake) entry.wake.delete(wake);
      signal?.removeEventListener("abort", onAbort);
      entry.inflight--;
      entry.lastSeen = this.now();
    }
    // 훅이 끊겼다(CLI 가 훅을 거두었거나 턴이 멈췄다). 받을 이가 없으니 답을 건네지 않고 닫는다.
    if (signal?.aborted && !entry.answer) {
      this.close(entry, textRef("card.tool_permission.closed_terminal_side_ended"));
      return { id: entry.id, state: "closed" };
    }
    const done = this.result(entry);
    if (done) return done;
    if (this.now() >= entry.expiresAt) {
      this.expire(entry);
      return { id: entry.id, state: "closed" };
    }
    return { id: entry.id, state: "pending" };
  }

  /**
   * 대표의 답(POST /api/decisions/:id/answer 의 도구 승인 카드). 같은 답의 재전송·다른 답은 http.ts 가 먼저 거른다(checkAnswer).
   * 선택 없이 메모만 보내면 거절로 본다: 대표가 분명히 허용하지 않은 도구는 실행하지 않는다.
   */
  answer(decisionId: string, req: AnswerReq): Decision {
    const { store } = this.deps;
    const decision = store.requireDecision(decisionId);
    if (decision.kind !== "tool_permission") throw new ApiError(400, "도구 승인 카드가 아닙니다", "tool_permission_only");
    if (decision.status !== "open") throw new ApiError(409, "이미 닫혔거나 대표가 답한 결재입니다", "decision_closed");
    if (req.expectedVersion && req.expectedVersion !== decision.updatedAt) throw new ApiError(409, "결재가 변경되었습니다. 새로 불러온 뒤 다시 답하세요", "decision_changed");
    const choice = req.choice?.trim() || null;
    const note = req.note?.trim() || null;
    if (!choice && !note) throw new ApiError(400, "선택지나 메모가 필요합니다", "decision_answer_empty");
    if (choice && !decision.options.some(option => option.k === choice)) throw new ApiError(400, `없는 선택지입니다: ${choice}`, "decision_option_unknown");
    const entry = this.entries.get(decisionId);
    if (!entry || entry.closed) {
      // 기다리던 훅이 없다(서버 재시작 등). 답해도 CLI 에 닿지 않으니 카드를 닫고 알린다.
      this.closeRow(decisionId, textRef("card.tool_permission.closed_already_over"));
      throw new ApiError(409, "승인 요청이 이미 끝났습니다. 터미널의 승인 창에서 답해 주세요", "tool_permission_gone");
    }
    const state = choice === "allow" ? "allow" : "deny";
    const answered = store.answerToolPermission(decisionId, { choice, note });
    entry.answer = state === "allow" ? { state } : { state, message: denyMessage(note) };
    if (entry.grace) { clearTimeout(entry.grace); entry.grace = null; }
    this.answeredAt.set(entry.memberId, this.now());
    for (const wake of [...entry.wake]) wake();
    const member = store.getMember(entry.memberId);
    if (member) {
      const info = decision.toolPermission;
      if (info) {
        const code = state === "allow" ? "activity.tool_allowed" : "activity.tool_denied";
        const actionRef = toolActionRef(info.tool);
        store.appendActivity(member.id, "system", textRef(code, { action: actionRef, target: activityTarget(code, actionRef, entry.targets) }));
      } else store.appendActivity(member.id, "system", textRef(state === "allow" ? "activity.tool_allowed_plain" : "activity.tool_denied_plain"));
      if (state === "allow" && note) this.deps.deliverNote(member, answered);
    }
    return answered;
  }

  /**
   * 팀장 상태 관측. 승인 창 앞(blocked)이던 팀장이 잠깐 넘게 다른 상태면 터미널에서 먼저 답한 것으로 보고 카드를 닫는다.
   * 터미널이 끝났으면(gone) 바로 닫는다.
   */
  memberStatus(memberId: string, status: string): void {
    for (const entry of this.entries.values()) {
      if (entry.memberId !== memberId || entry.closed || entry.answer) continue;
      // Gemini 카드는 터미널 상태로 닫지 않는다(terminalAnswerable). 터미널이 끝나면(gone) 닫는다.
      if (!entry.terminalAnswerable && status !== "gone") continue;
      if (status === "blocked") {
        entry.sawBlocked = true;
        if (entry.grace) { clearTimeout(entry.grace); entry.grace = null; }
      } else if (status === "gone") {
        this.close(entry, textRef("card.tool_permission.closed_terminal_ended"));
      } else if (entry.sawBlocked && !entry.grace) {
        entry.grace = setTimeout(() => {
          entry.grace = null;
          if (entry.closed || entry.answer) return;
          const current = this.deps.store.getMember(memberId);
          if (current?.status === "blocked") return;
          this.close(entry, textRef("card.tool_permission.closed_answered_in_terminal"));
        }, this.graceMs);
        entry.grace.unref?.();
      }
    }
  }

  /** 끊긴 훅·시간이 지난 카드를 닫는다. 기다리는 요청이 있으면 그 요청이 직접 닫는다. */
  sweep(): void {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.inflight > 0) continue;
      if (entry.answer) {
        // 답을 건네기 전에 훅이 사라졌다. 카드는 이미 답한 상태라 그대로 두고 기억만 지운다.
        if (now - entry.lastSeen > this.goneMs) this.entries.delete(entry.id);
        continue;
      }
      if (now >= entry.expiresAt) this.expire(entry);
      else if (now - entry.lastSeen > this.goneMs) this.close(entry, textRef("card.tool_permission.closed_terminal_side_cut"));
    }
  }

  private expire(entry: Entry): void {
    if (entry.closed) return;
    const minutes = Math.max(1, Math.round(this.ttl / 60_000));
    this.close(entry, textRef("card.tool_permission.closed_timeout", { minutes: String(minutes) }));
    const member = this.deps.store.getMember(entry.memberId);
    if (member?.status === "blocked") this.deps.stillBlocked?.(member);
  }

  private close(entry: Entry, reason: ServerTextRef): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.grace) { clearTimeout(entry.grace); entry.grace = null; }
    this.entries.delete(entry.id);
    for (const wake of [...entry.wake]) wake();
    this.closeRow(entry.id, reason);
  }

  /** 열린 카드만 닫는다(이미 답했거나 닫혔으면 그대로). 닫았으면 true. */
  private closeRow(id: string, reason: ServerTextRef): boolean {
    const { store } = this.deps;
    try {
      const decision = store.getDecision(id);
      if (!decision || decision.status !== "open") return false;
      store.closeDecision(id, { kind: null, reason, by: "시스템" });
      if (decision.memberId && store.getMember(decision.memberId)) store.appendActivity(decision.memberId, "system", textRef("activity.tool_card_closed", { reason }));
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return false;
      console.warn("도구 승인 카드를 닫지 못했습니다:", id, (error as Error).message);
      return false;
    }
  }

  /**
   * 서버를 닫는다(DB 가 열려 있는 동안 부른다: Orchestrator.shutdown). 기다리는 훅은 '닫힘'을 받아 터미널의 원래 승인 창으로 간다.
   * 답을 기다리던 카드는 여기서 닫는다. 다음 시작까지 열어 두면, 그 사이 이 카드를 모르는 옛 판(되돌리기)이 보통 결재로 보여
   * 팀장을 '결재 대기'로 두고 그 판의 답을 팀장에게 글로 보낸다. 비정상 종료로 남은 카드는 다음 시작의 closeLeftovers 가 닫는다.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.sweeper);
    for (const entry of [...this.entries.values()]) {
      if (entry.grace) { clearTimeout(entry.grace); entry.grace = null; }
      if (!entry.answer && !entry.closed) this.close(entry, textRef("card.tool_permission.closed_server_stopped"));
      else for (const wake of [...entry.wake]) wake();
    }
  }
}
