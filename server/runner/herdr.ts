import { capturedContext } from "./statusline.ts";
// herdr 어댑터. 칸 안의 대화형 Claude 세션을 소켓으로 부린다.
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { adoptRefusal, type ApprovalPrompt, type Backend, type HerdrInfo, type LiveAgent } from "../../shared/types.ts";
import { HerdrError, isForbiddenTestSocket, rpc, subscribe, type HerdrEvent, type Subscription } from "./herdr-client.ts";
import { cleanText, SESSION_ID_RE } from "../text.ts";
import { subagentEnv } from "./headless.ts";
import { readTranscriptTail, transcriptPath } from "./transcript.ts";
import { parseApproval } from "./approval.ts";
import type { ApprovalAnswer, Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "./types.ts";

const SUPPORTED_PROTOCOL = 22;
const CONDUCTOR_RATIO = 0.3;
const LONG_TEXT = 1500;
const SHELL_GRACE_MS = 8000;
const SHELL_WAIT_MS = 15_000;
const TAIL_POLL_MS = 1500;
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
const BRIEF = 300;
const EXIT_WAIT_MS = 6000;
/**
 * 입력칸에 남은 글을 지우는 키. Claude Code 2.1.316 실측: 글이 있으면 한 번에 다 지운다(여러 줄도, 150ms 안).
 * Ctrl+U 는 커서가 있는 줄만 지우고, Esc 한 번은 아무것도 지우지 않는다(두 번은 되감기 창).
 */
const CLEAR_KEY = "ctrl+c";
/**
 * 같은 칸에 지우는 키를 다시 누르기 전 간격. 누르면(글이 있어도) 약 0.8초 동안 종료 창이 열리고,
 * 그 안에 빈 입력칸에 또 누르면 세션이 끝난다(실측: 400ms 간격은 끝남, 1000·1300ms 는 살아 있음).
 * 메시지 사이에도 같은 간격을 지킨다(대기열의 두 말이 잇달아 들어갈 때).
 */
const CLEAR_GAP_MS = 1500;
/** 누른 뒤 다시 읽는 때: 300ms 에 처음 읽고 500ms 까지 본다(실측: 150ms 에 이미 비었다). 그 뒤에는 다시 누르지 않고 미룬다. */
const CLEAR_SETTLE_MS = 300;
const CLEAR_WAIT_MS = 500;
const CLEAR_POLL_MS = 100;
const NO_INPUT_BOX = "입력칸을 찾지 못했습니다(선택 창·승인 창·셸 모드 등)";
/** herdr 가 working 이라는 동안 '턴은 끝났고 뒤 작업만 기다림'인지 살피는 간격 */
const BG_CHECK_MS = 3000;
/** 뒤 작업 판정에 읽는 세션 기록 끝부분 */
const BG_TAIL_BYTES = 256 * 1024;

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
type Reported = "working" | "idle" | "blocked";
type LayoutNode =
  | { type: "pane"; pane_id: string }
  | { type: "split"; direction: "right" | "down"; ratio: number; first: LayoutNode; second: LayoutNode };

interface AgentInfo {
  pane_id: string; workspace_id: string; tab_id: string; name?: string | null; agent?: string | null;
  agent_status: AgentStatus; agent_session?: { value: string } | null; cwd?: string | null;
  foreground_cwd?: string | null; interactive_ready?: boolean; launch_pending?: boolean;
}
interface PaneInfo { pane_id: string; tab_id: string; agent?: string | null }
interface Snapshot { version: string; protocol: number; agents: AgentInfo[]; panes: PaneInfo[] }

interface Track {
  m: RunnerMember;
  paneId: string;
  tabId: string | null;
  sessionId: string | null;
  status: AgentStatus;
  reported: Reported | null;
  inTurn: boolean;
  /** 글을 넣었지만 아직 working 을 못 봄. */
  awaiting: { size: number; at: number; marker: string; markerCount: number } | null;
  settle: ReturnType<typeof setTimeout> | null;
  stall: ReturnType<typeof setTimeout> | null;
  compact: { baseline: number; startedAt: number; idleSince: number | null; poll: ReturnType<typeof setInterval> } | null;
  /** 슬래시 명령의 짧은 working 을 턴으로 치지 않는다. */
  muteUntil: number;
  /** 턴이 끝날 때마다 는다. 글 넣기 응답이 턴보다 늦게 오면 이미 끝난 턴을 다시 기다리지 않는다. */
  turnGen: number;
  /** 글을 넣은 뒤 승인 창을 거쳤다. 거절하면 working 없이 idle 로 돌아온다. */
  sawBlocked: boolean;
  /** 이 칸의 인자를 확인했다. herdr 가 되살린 세션에는 --mcp-config 등이 없다. */
  argsOk: boolean;
  /** 넘겨받을 때 폴더 허용을 못 했다(일하는 중이었거나 입력칸을 못 찾았다). 다음 전달 때 다시 한다. */
  grantPending: boolean;
  /** 세션 기록을 이어 읽어 도구·서브에이전트를 알린다. */
  tail: { offset: number; poll: ReturnType<typeof setInterval>; subagents: Set<string> } | null;
  /**
   * 턴을 마치고 뒤 작업(워크플로 등)을 기다리는 중이면 화면에 적힌 그 작업(예: "1 dynamic workflow").
   * herdr 는 이때도 working 이라 하지만 주 세션은 비어 있어 넣은 글을 곧바로 받는다(실측).
   */
  bg: string | null;
  /** herdr 가 working 인 동안만 도는 뒤 작업 판정 타이머 */
  bgPoll: ReturnType<typeof setInterval> | null;
  bgChecking: boolean;
  /** 뒤 작업 중에 시작한 턴: 그 끝은 이 위치(기록 바이트) 뒤에 써진 턴 끝이어야 한다. 넣은 시각은 시작 안 됨을 가른다. */
  bgTurn: { from: number; at: number } | null;
  /** 지난 판정의 기록 크기와 결과. 기록이 그대로면 다시 읽지 않는다. */
  bgSeen: { size: number; ended: boolean } | null;
}

export interface HerdrDeps {
  inboxDir: string;
  /** 기본은 CLAUDE_CONFIG_DIR 또는 ~/.claude. 세션 jsonl 위치를 정한다. */
  claudeHome?: string;
  contextHome?: string;
  settleMs?: number;
  resyncMs?: number;
  stallMs?: number;
  startTimeoutMs?: number;
  promptTimeoutMs?: number;
  compactGraceMs?: number;
  compactTimeoutMs?: number;
  bgCheckMs?: number;
}

const TAIL_BYTES = 4 * 1024 * 1024;

function readTail(path: string, maxBytes = TAIL_BYTES): string {
  const size = statSync(path).size;
  const length = Math.min(size, maxBytes);
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, length, size - length); } finally { closeSync(fd); }
  return buf.toString("utf8");
}

/** 승인 키를 누른 뒤 창이 닫혔는지 다시 보는 간격(ms). 실측으로 300ms 안에 닫혔다. */
const APPROVAL_CHECK_MS = [300, 500, 1200];

const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const stripAnsi = (s: string) => s.replace(OSC_RE, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const isRule = (l: string) => /^\s*[╭╰]?─{5,}/.test(l);

/**
 * 화면을 줄로 나누고 글자마다 흐린 글씨(SGR 2)인지 함께 돌려준다. 글자 모양 상태는 줄을 넘어 이어진다.
 * 확장 색(38;5;n, 38;2;r;g;b)의 숫자 2 는 흐림이 아니다.
 */
function scanDim(screen: string): { text: string; dim: boolean[] }[] {
  const lines: { text: string; dim: boolean[] }[] = [];
  let text = "";
  let dim: boolean[] = [];
  let faint = false;
  const token = /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[^[\]]?|\n|[^\x1b\n]+/gy;
  for (let m = token.exec(screen); m; m = token.exec(screen)) {
    const t = m[0];
    if (t === "\n") {
      lines.push({ text, dim });
      text = "";
      dim = [];
    } else if (t[0] !== "\x1b") {
      text += t;
      for (let i = 0; i < t.length; i++) dim.push(faint);
    } else if (m[2] === "m" && !/[<=>?]/.test(m[1]!)) {
      const params = m[1] === "" ? ["0"] : m[1]!.split(";");
      for (let i = 0; i < params.length; i++) {
        const p = params[i]!;
        if (p.includes(":")) continue;
        const n = Number(p || "0");
        if (n === 38 || n === 48 || n === 58) {
          i += params[i + 1] === "5" ? 2 : params[i + 1] === "2" ? 4 : 0;
          continue;
        }
        if (n === 0) faint = false;
        else if (n === 2) faint = true;
        else if (n === 22) faint = false;
      }
    }
  }
  lines.push({ text, dim });
  return lines;
}

/**
 * Claude 입력칸에 친 글. 두 가로줄 사이의 `❯`(또는 `>`) 줄부터 읽는다. 빈 문자열이면 비었다.
 * null 은 입력칸을 못 찾음(승인 창·선택 창·다른 프로그램).
 * 흐린 글씨(빈 입력칸의 안내 글, 다음에 칠 말 추천)는 친 글이 아니다. 색을 지운 화면에서는 구분되지 않아
 * 화면을 ansi 로 읽어 글자마다 흐림을 본다. 글자만 있는 화면이면 알려진 안내 문구로 거른다.
 */
export function inputText(screen: string): string | null {
  const scanned = scanDim(screen);
  const box = inputBox(scanned.map((l) => l.text));
  if (!box) return null;
  const typed = (i: number, from = 0): string => {
    const l = scanned[i]!;
    let s = "";
    for (let k = from; k < l.text.length; k++) if (!l.dim[k]) s += l.text[k];
    return s;
  };
  const first = typed(box.top + 1, box.prefix).replace(/\s*[│┃]?\s*$/, "").trim();
  const hint = /^Try "[^"]*"$/.test(first) || /^Press up to edit queued( messages?)?$/.test(first);
  const rest: string[] = [];
  for (let i = box.top + 2; i < box.bottom; i++) rest.push(typed(i).replace(/[│┃]/g, "").trim());
  return [hint ? "" : first, ...rest].join("\n").trim();
}

/** 화면 아래에서부터 찾은 입력칸: 위·아래 가로줄 줄 번호와 첫 줄 `❯ ` 머리의 길이. */
function inputBox(lines: string[]): { top: number; bottom: number; prefix: number } | null {
  for (let bottom = lines.length - 1; bottom > 0; bottom--) {
    if (!isRule(lines[bottom]!)) continue;
    let top = bottom - 1;
    while (top >= 0 && !isRule(lines[top]!)) top--;
    if (top < 0) return null;
    const m = top + 1 < bottom ? /^(\s*[│┃]?\s*[❯>›]\s?)(.*?)\s*[│┃]?\s*$/.exec(lines[top + 1]!) : null;
    if (!m) { bottom = top + 1; continue; }
    return { top, bottom, prefix: m[1]!.length };
  }
  return null;
}

/** Claude 입력칸이 비었는가. null 은 입력칸을 못 찾음(승인 창·선택 창·다른 프로그램). */
export function inputLooksEmpty(screen: string): boolean | null {
  const text = inputText(screen);
  return text === null ? null : text === "";
}

/**
 * 지우는 키를 누른 뒤 Claude Code 가 입력칸 아래 상태줄 자리에 띄우는 종료 안내. 떠 있는 동안 빈 칸에 또 누르면 세션이 끝난다.
 * 입력칸 아래만 본다. 위쪽 대화에 같은 글이 인용돼 있어도 안내가 아니다.
 */
export function exitHintShown(screen: string): boolean {
  const lines = scanDim(screen).map((l) => l.text);
  const box = inputBox(lines);
  return lines.slice(box ? box.bottom + 1 : 0).some((l) => /Press Ctrl-C again to exit/i.test(l));
}

/** Claude 의 상태 줄 머리(도는 별). 일할 때는 모양이 바뀌며 돌고, 끝난 턴의 줄과 뒤 작업 기다림 줄에도 붙는다. */
const SPINNER_HEAD = /^\s*[·✢✳✶✻✽]\s+\S/;
/** 대화 글 머리(입력 되풀이·답·도구 결과). 상태 줄보다 이것이 입력칸에 가까우면 그 위의 상태 줄은 지난 것이다. */
const CONVERSATION_HEAD = /^\s*[❯>⏺⎿]/;

/** 입력칸 아래 뒤 작업 표시: 이름과 진행 막대(실측 "◯ mahjong-…  ▰▰▰▰▰▰▱▱"). */
const BACKGROUND_BAR = /^\s*\S\s+(\S.*?)\s+[▰▱]{3,}\s*$/;

/**
 * 턴을 마치고 뒤 작업만 기다리는 화면이면 그 작업(예: "1 dynamic workflow"), 아니면 null. herdr 는 이 동안 working 이라 하지만
 * 넣은 글은 곧바로 처리된다(실측 Claude Code 2.1.316). 두 모양이 있다:
 * - 입력칸 바로 위 상태 줄 "✻ Waiting for 1 dynamic workflow to finish"(좁은 칸에서는 다음 줄로 접힌다).
 * - 상태 줄 없이(또는 끝난 턴의 줄만 있고) 입력칸 아래에 뒤 작업 막대 "◯ 이름  ▰▰▰▱"만 있다.
 * 일하는 중의 상태 줄(Thinking… (esc to interrupt) 등)이 있거나, 넣은 글의 되풀이(❯)가 가장 가까우면 아니다.
 * 기록이 턴 끝인지는 따로 본다(transcriptTurnEnded).
 */
export function backgroundWait(screen: string): string | null {
  const lines = scanDim(screen).map((l) => l.text);
  const box = inputBox(lines);
  if (!box) return null;
  let seen = 0;
  for (let i = box.top - 1; i >= 0 && seen < 8; i--) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    seen++;
    // 넣은 글의 되풀이가 가장 가깝다: 곧 일을 시작한다.
    if (/^\s*[❯>]/.test(line)) return null;
    if (CONVERSATION_HEAD.test(line)) break;
    if (!SPINNER_HEAD.test(line)) continue;
    const joined = lines.slice(i, box.top).map((l) => l.trim()).filter(Boolean).join(" ");
    const m = /^[·✢✳✶✻✽]\s+Waiting for (\d+ .+?) to finish\b/.exec(joined);
    if (m) return m[1]!.replace(/\s+/g, " ");
    // 도는 상태 줄: 일하는 중이다. 끝난 턴의 줄(Worked for 3m · Cogitated for 13s · done …)이면 아래 막대를 본다.
    if (/esc to interrupt|…\s*\(|\.\.\.\s*\(/i.test(joined)) return null;
    break;
  }
  for (const line of lines.slice(box.bottom + 1)) {
    const bar = BACKGROUND_BAR.exec(line);
    if (bar) return bar[1]!.replace(/\s+/g, " ");
  }
  return null;
}

/**
 * 세션 기록의 주 대화가 턴 끝에 와 있는가. 마지막 대화 줄이 턴 끝 표지(turn_duration)이거나 도구를 부르지 않은 assistant 글이면 끝이다.
 * 입력·도구 결과·도구를 부르는 글이면 아직 일하는 중이다. 넣은 글의 턴을 볼 때는 넣은 위치 뒤에 써진 부분만 넘긴다.
 */
export function transcriptTurnEnded(text: string): boolean {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"') && !line.includes('"turn_duration"')) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; } // 잘라 읽은 첫 줄
    if (entry?.isSidechain) continue;
    if (entry?.type === "system") { if (entry.subtype === "turn_duration") return true; continue; }
    if (entry?.type === "user") return false;
    if (entry?.type !== "assistant") continue;
    const content = entry.message?.content;
    if (Array.isArray(content) && content.some((b: { type?: string }) => b?.type === "tool_use")) return false;
    return entry.message?.stop_reason !== "tool_use";
  }
  return false;
}

/** git 저장소를 처음 열 때 뜨는 폴더 신뢰 창. 기본 선택이 "No, exit" 라 Enter 만 치면 세션이 끝난다. */
export function isTrustDialog(screen: string): boolean {
  return /Yes, I trust this folder/.test(stripAnsi(screen));
}

/** 처음 바이패스 모드로 열 때 뜨는 경고 창. --settings 로 건너뛰지만, 조직 정책 등으로 뜨면 그 자리에서 멈춘 것을 알린다. */
export function isBypassDialog(screen: string): boolean {
  return /Bypass Permissions mode/.test(stripAnsi(screen));
}

/** 칸 환경. 서브에이전트 모델은 agent.start 에 넘길 곳이 없어 칸을 만들 때 준다(pane.split·workspace.create 의 env). */
function paneEnv(m: RunnerMember): { env?: Record<string, string> } {
  return m.subagentModel ? { env: subagentEnv(m.subagentModel) } : {};
}

/**
 * 상태줄의 문맥 %(`│ ███░░░░░░░ │ 27% │`). 실제 창 크기를 반영하므로 토큰 계산보다 먼저 쓴다.
 * 상태줄은 입력칸 바로 아래에 있다. 입력칸 아래에서 막대(█░)가 있는 첫 줄이 상태줄이고, 그 줄의 막대 바로 다음 칸 % 만 읽는다.
 * 좁은 칸에서는 상태줄이 잘린다(`│ ██░░░░░░…`, `│ ███░░░░░░░ │ 2…`). 그때는 null 이고, 다른 줄로 넘어가지 않는다:
 * 더 올라가면 대화에 그린 표·막대를, 더 내려가면 다른 % 칸(사용량 한도 등)을 문맥 %로 잘못 읽는다. 입력칸을 못 찾아도 null.
 */
export function screenContextPct(screen: string): number | null {
  const lines = stripAnsi(screen).split("\n");
  const box = inputBox(lines);
  if (!box) return null;
  const status = lines.slice(box.bottom + 1).find((l) => /[█░]/.test(l));
  if (!status) return null;
  const m = /[█░]+\s*│\s*(\d{1,3})%/.exec(status);
  return m ? Math.min(100, Number(m[1])) : null;
}

export async function detectHerdr(socketPath: string): Promise<HerdrInfo> {
  const bin = Bun.which("herdr");
  let version: string | null = null;
  if (bin) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_"))) as Record<string, string>;
    const p = Bun.spawn([bin, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env });
    const text = await new Response(p.stdout).text();
    await p.exited;
    version = /(\d+\.\d+\.\d+\S*)/.exec(text)?.[1] ?? null;
  }
  try {
    const pong = await rpc<{ version: string; protocol: number }>(socketPath, "ping", {}, 2000);
    const compatible = pong.protocol === SUPPORTED_PROTOCOL;
    return {
      installed: true, running: true, version: pong.version ?? version, protocol: pong.protocol, compatible,
      warning: compatible ? null : `herdr 프로토콜이 ${pong.protocol} 입니다. 시험한 번호는 ${SUPPORTED_PROTOCOL} 이라 일부 동작이 다를 수 있습니다.`,
    };
  } catch {
    return { installed: bin !== null, running: false, version, protocol: null, compatible: false, warning: null };
  }
}

async function snapshot(socketPath: string): Promise<Snapshot> {
  const r = await rpc<{ snapshot: Snapshot }>(socketPath, "session.snapshot", {}, 8000);
  return r.snapshot;
}

export async function listAgents(socketPath: string): Promise<LiveAgent[]> {
  const snap = await snapshot(socketPath);
  return snap.agents.map((a) => ({
    paneId: a.pane_id, name: a.name ?? null, agent: a.agent ?? null, status: a.agent_status,
    cwd: a.foreground_cwd ?? a.cwd ?? null, sessionId: a.agent_session?.value ?? null,
    workspaceId: a.workspace_id, tabId: a.tab_id, adopted: false,
  }));
}

/** 세션 기록 위치. 세션 안에서 cd 하면 다른 폴더 아래에 기록된다. */
export function findSessionFile(claudeHome: string, cwd: string, sessionId: string): string | null {
  const direct = transcriptPath(cwd, sessionId, claudeHome);
  if (existsSync(direct)) return direct;
  const projects = join(claudeHome, "projects");
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* projects 폴더 없음 */ }
  return null;
}

export const defaultClaudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

const CONDUCTOR_NAME = /^(lead|root)\b|총괄|지휘|오케스트라|orchestra|conductor/i;

/** 다른 지휘자·오케스트라 아래서 돌던 흔적. 근거 문구를 돌려준다. 흔적일 뿐이라 막지 않고 경고만 한다. */
export function conductorTraces(a: { name: string | null; argv: string[]; transcript: string }): string[] {
  const out: string[] = [];
  if (a.argv.some((x) => x.includes("worker-rules"))) out.push("시스템 프롬프트 인자에 worker-rules 가 있습니다");
  if (a.name && CONDUCTOR_NAME.test(a.name)) out.push(`칸 이름이 '${a.name}' 입니다`);
  if (/"name":\s*"SendMessage"/.test(a.transcript)) out.push("SendMessage 로 보고한 기록이 있습니다");
  if (/"skill":\s*"orchestra"|skills\/orchestra\/SKILL\.md|orchestra\/worker-rules/.test(a.transcript)) out.push("오케스트라 스킬을 쓴 기록이 있습니다");
  return out;
}

export interface PaneInspection { screen: string; inputEmpty: boolean | null; argv: string[]; traces: string[] }

/** 편입 전 살펴보기. 읽기만 한다(pane.read·pane.process_info·세션 기록). */
export async function inspectPane(socketPath: string, a: Pick<LiveAgent, "paneId" | "name" | "cwd" | "sessionId">, claudeHome = defaultClaudeHome()): Promise<PaneInspection> {
  const read = await rpc<{ read: { text: string } }>(socketPath, "pane.read", { pane_id: a.paneId, source: "visible", format: "ansi", strip_ansi: false }).catch(() => null);
  const screen = read?.read.text ?? "";
  const proc = await rpc<{ process_info: { foreground_processes?: { argv?: string[] | null; cmdline?: string | null }[] } }>(socketPath, "pane.process_info", { pane_id: a.paneId }).catch(() => null);
  const argv = (proc?.process_info.foreground_processes ?? []).flatMap((p) => p.argv ?? p.cmdline?.split(/\s+/) ?? []);
  const file = a.sessionId ? findSessionFile(claudeHome, a.cwd ?? "", a.sessionId) : null;
  let transcript = "";
  try { transcript = file ? readTail(file) : ""; } catch { /* 기록을 못 읽어도 나머지 흔적은 본다 */ }
  return { screen: stripAnsi(screen), inputEmpty: read ? inputLooksEmpty(screen) : null, argv, traces: conductorTraces({ name: a.name, argv, transcript }) };
}

function leaves(n: LayoutNode): string[] { return n.type === "pane" ? [n.pane_id] : [...leaves(n.first), ...leaves(n.second)]; }
function rightmost(n: LayoutNode): string { return n.type === "pane" ? n.pane_id : rightmost(n.second); }

const GONE_CODES = new Set(["pane_not_found", "agent_not_found", "agent_pane_not_found", "agent_not_running"]);
function isGone(e: unknown): boolean { return e instanceof HerdrError && GONE_CODES.has(e.code); }
function isDown(e: unknown): boolean { return e instanceof HerdrError && (e.code === "down" || e.code === "closed"); }

/** 시간 초과 때 화면·기록에서 찾을 표지. 서버 전달 글은 끝에 #id 가 붙는다. */
// 메시지 id 는 화면이 보낸 UUID 일 수 있다(§3).
const ID_MARK = /#(?:[a-z]+_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
function markerOf(text: string): string {
  const ids = [...text.matchAll(ID_MARK)];
  return ids.length ? ids[ids.length - 1]![0] : text.trim().split("\n")[0]!.slice(0, 24);
}

/** 글 끝에 그 글만의 표지가 없으면 붙인다. 머리글만으로는 어제 같은 글과 가를 수 없다. */
function withMarker(text: string, marker?: string): string {
  const lastLine = text.trimEnd().split("\n").at(-1) ?? "";
  if (new RegExp(`${ID_MARK.source}$`).test(lastLine)) return text;
  return `${text}\n${marker ?? `#dl_${crypto.randomUUID().slice(0, 12)}`}`;
}

function countOf(text: string, needle: string): number {
  return needle ? text.split(needle).length - 1 : 0;
}

function brief(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length > BRIEF ? `${text.slice(0, BRIEF)}…` : text;
}

function projectSuffix(m: RunnerMember): string {
  return m.projectId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6);
}

function qualifiedName(m: RunnerMember): string {
  const suffix = projectSuffix(m);
  return `${m.handle.slice(0, 31 - suffix.length)}-${suffix}`;
}

/** 칸 이름은 어댑터가 핸들로 붙인다(겹치면 프로젝트 표지를 붙인다). 재시작 뒤에도 같게 계산되므로 따로 저장하지 않는다. 'dev-api' 는 dev 의 칸이 아니다. */
function nameMatches(a: AgentInfo, m: RunnerMember): boolean {
  if (!a.name) return false;
  if (a.name === m.handle || a.name === qualifiedName(m)) return true;
  return a.name.startsWith(`${m.handle.slice(0, 24)}-${projectSuffix(m)}-`);
}

/**
 * 세션이 맞는 칸이 서버가 띄운 칸인가. 대표가 복사한 `claude --resume` 칸도 세션은 같지만 닫거나 지시를 넣으면 안 된다.
 * 실측: herdr 를 다시 켜면 되살린 칸의 이름이 사라지고 번호는 유지된다. 그래서 이름이 없으면 번호가 DB 와 같을 때만 내 칸으로 친다.
 */
function ownsPane(a: AgentInfo, m: RunnerMember): boolean {
  return nameMatches(a, m) || (!a.name && !!m.paneId && a.pane_id === m.paneId);
}

export class HerdrRunner implements Runner {
  readonly kind: Backend = "herdr";
  private readonly socketPath: string;
  private readonly inboxDir: string;
  private readonly claudeHome: string;
  private readonly contextHome: string;
  private readonly settleMs: number;
  private readonly stallMs: number;
  private readonly startTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly compactGraceMs: number;
  private readonly compactTimeoutMs: number;
  private readonly bgCheckMs: number;
  private readonly tracks = new Map<string, Track>();
  private readonly byPane = new Map<string, string>();
  private readonly projectTabs = new Map<string, string>();
  /** 손을 뗀 직원. 직원 id 는 다시 쓰이지 않는다. */
  private readonly letGo = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** 칸마다 지우는 키를 마지막으로 누른 시각. 종료 창 안에 두 번 누르지 않게 한다(직원을 놓아도 칸 기준으로 남긴다). */
  private readonly lastClear = new Map<string, number>();
  private readonly listeners: Array<(e: RunnerEvent) => void> = [];
  private sub: Subscription | null = null;
  private subKey: string | null = null;
  private subTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncSoon: ReturnType<typeof setTimeout> | null = null;
  private readonly resyncTimer: ReturnType<typeof setInterval>;
  private backoff = 1000;
  private connected = true;
  private stopped = false;

  constructor(config: { socketPath: string }, deps: HerdrDeps) {
    if (isForbiddenTestSocket(config.socketPath)) throw new Error(`IAMCEO_TEST=1 인데 시험 소켓이 아닙니다: ${config.socketPath}`);
    this.socketPath = config.socketPath;
    this.inboxDir = deps.inboxDir;
    this.claudeHome = deps.claudeHome ?? defaultClaudeHome();
    this.contextHome = deps.contextHome ?? dirname(deps.inboxDir);
    this.settleMs = deps.settleMs ?? 1200;
    this.stallMs = deps.stallMs ?? 20_000;
    this.startTimeoutMs = deps.startTimeoutMs ?? 120_000;
    this.promptTimeoutMs = deps.promptTimeoutMs ?? 15_000;
    this.compactGraceMs = deps.compactGraceMs ?? 20_000;
    this.compactTimeoutMs = deps.compactTimeoutMs ?? 15 * 60_000;
    this.bgCheckMs = deps.bgCheckMs ?? BG_CHECK_MS;
    this.resyncTimer = setInterval(() => void this.resync(), deps.resyncMs ?? 60_000);
    this.resyncTimer.unref?.();
  }

  on(cb: (e: RunnerEvent) => void): void { this.listeners.push(cb); }

  private emit(e: RunnerEvent): void {
    for (const cb of this.listeners) {
      try { cb(e); } catch (err) { console.error("[herdr] 이벤트 처리 실패:", err); }
    }
  }

  private call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return rpc<T>(this.socketPath, method, params, timeoutMs);
  }

  async available(): Promise<{ ok: boolean; detail?: string }> {
    const info = await detectHerdr(this.socketPath);
    if (!info.running) return { ok: false, detail: info.installed ? "herdr 서버에 연결할 수 없습니다" : "herdr 가 설치되어 있지 않습니다" };
    return info.warning ? { ok: true, detail: info.warning } : { ok: true };
  }

  isBusy(memberId: string): boolean {
    const t = this.tracks.get(memberId);
    // 뒤 작업만 기다리는 세션은 herdr 가 working 이라 해도 글을 받는다.
    return !!t && ((t.status === "working" && t.bg === null) || t.inTurn || t.awaiting !== null || t.compact !== null);
  }

  // 같은 프로젝트의 칸 배치가 겹치면 트리가 어긋나므로 한 줄로 세운다.
  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => {}));
    return next;
  }

  async start(m: RunnerMember, o: StartOpts): Promise<{ sessionId: string | null; paneId: string | null; tabId?: string | null; rejoined?: boolean }> {
    const result = await this.lock(m.projectId, () => this.startLocked(m, o));
    if (o.firstPrompt && !result.rejoined) {
      const sent = await this.send({ ...m, paneId: result.paneId, sessionId: result.sessionId }, o.firstPrompt, o);
      if (!sent.ok) this.emit({ type: "activity", memberId: m.id, kind: "error", text: `첫 지시 전달 실패: ${sent.reason}${sent.detail ? ` (${sent.detail})` : ""}` });
    }
    return { sessionId: result.sessionId, paneId: result.paneId, tabId: result.tabId, rejoined: result.rejoined };
  }

  private async startLocked(m: RunnerMember, o: StartOpts) {
    const snap = await snapshot(this.socketPath);
    const { live, conflict } = this.findLive(snap, m, o.resume);
    // 같은 세션을 다른 칸이 쥐고 있다. 또 띄우면 한 세션을 여러 프로세스가 쓴다. 대표가 칸을 정리해야 풀린다.
    if (conflict) throw new HerdrError("session_in_use", conflict);
    if (live) {
      const t = this.bind(m, live);
      await this.reclaimName(t, live, snap);
      this.emitPane(t);
      // 칸이 사용자 탭으로 옮겨져 있을 수 있다. 프로젝트 탭으로 치지 않는다.
      return { sessionId: t.sessionId, paneId: t.paneId, tabId: null, rejoined: true };
    }

    // 값이 '--플래그' 면 --resume 뒤에서 옵션으로 해석된다.
    if (m.sessionId && !SESSION_ID_RE.test(m.sessionId)) throw new HerdrError("invalid_session", `세션 ID 형식이 잘못되었습니다: ${m.sessionId.slice(0, 80)}`);
    const sessionId = m.sessionId ?? crypto.randomUUID();
    const resume = o.resume && m.sessionId !== null;
    const inbox = this.memberInbox(m);
    mkdirSync(inbox, { recursive: true, mode: 0o700 });
    const args = [
      resume ? "--resume" : "--session-id", sessionId,
      "-n", m.name,
      // herdr 는 여러 줄 인자를 invalid_agent_argument 로 거부한다. 규칙은 파일로만 넘긴다.
      "--append-system-prompt-file", o.systemPromptFile,
      "--mcp-config", o.mcpConfigFile,
      "--permission-mode", m.permissionMode,
      "--allowedTools", "mcp__iamceo",
      // 긴 글·첨부는 이 직원의 폴더에 있다. 없으면 default 모드에서 읽을 때마다 승인 창이 뜬다. ~/.iamceo 와 다른 프로젝트의 첨부는 열지 않는다.
      "--add-dir", inbox,
      ...(m.model ? ["--model", m.model] : []),
      ...(m.effort ? ["--effort", m.effort] : []),
      ...(o.settingsFile ? ["--settings", o.settingsFile] : []),
    ];

    const { paneId, tabId, created } = await this.allocatePane(m, o);
    const name = this.uniqueName(m, snap, paneId);
    try {
      // 새 칸의 셸이 아직 뜨는 중이면 "not an available shell" 로 거부된다(실측, zshrc 가 느릴수록 잦다).
      const shellDeadline = Date.now() + SHELL_WAIT_MS;
      for (;;) {
        try {
          await this.call("agent.start", { name, kind: "claude", pane_id: paneId, args, timeout_ms: this.startTimeoutMs }, this.startTimeoutMs + 10_000);
          break;
        } catch (e) {
          if (e instanceof HerdrError && e.code === "agent_not_ready") break; // 시작 중 승인 창이면 칸은 살아 있다.
          if (!(e instanceof HerdrError && /not an available shell/.test(e.message)) || Date.now() > shellDeadline) throw e;
          await Bun.sleep(300);
        }
      }
      const info = await this.waitReady(paneId);
      // 서버가 새로 띄운 칸이다. 넘겨받았던 세션을 다시 열었어도 이제 대표의 칸이 아니다.
      const t = this.bind({ ...m, sessionId, paneId, origin: m.origin === "adopted" ? "runner" : m.origin }, info);
      t.sessionId = sessionId;
      t.argsOk = true;
      this.emit({ type: "session", memberId: m.id, sessionId });
      this.emitPane(t);
      const opening = info.agent_status === "blocked" ? await this.readPane(paneId, "visible").catch(() => "") : "";
      if (isTrustDialog(opening)) {
        // 대신 고르지 않는다. 폴더 신뢰는 사용자의 판단이다.
        this.emit({ type: "activity", memberId: m.id, kind: "error", text: `폴더 신뢰 확인 창에서 멈췄습니다. 터미널의 칸(${paneId})에서 'Yes, I trust this folder' 를 고르면 이어집니다: ${m.cwd}` });
      } else if (isBypassDialog(opening)) {
        this.emit({ type: "activity", memberId: m.id, kind: "error", text: `바이패스 모드 확인 창에서 멈췄습니다. 터미널의 칸(${paneId})에서 동의하면 이어집니다` });
      }
      return { sessionId, paneId: t.paneId, tabId: t.tabId ?? tabId, rejoined: false };
    } catch (e) {
      if (created) await this.closePane(paneId, tabId);
      throw e;
    }
  }

  /** 서버 재시작 뒤 칸에 다시 붙는다. 실행 중 세션을 건드리지 않는다. */
  async reattach(m: RunnerMember): Promise<{ paneId: string; tabId: string | null } | null> {
    if (this.letGo.has(m.id)) return null;
    const snap = await snapshot(this.socketPath);
    // 스냅샷을 기다리는 사이 손을 뗐을 수 있다.
    if (this.letGo.has(m.id)) return null;
    const { live } = this.findLive(snap, m, true);
    if (!live) return null;
    const t = this.bind(m, live);
    await this.reclaimName(t, live, snap);
    this.emitPane(t);
    return { paneId: t.paneId, tabId: t.tabId };
  }

  /** 되살린 칸에는 이름이 없다. 다시 붙여 두어야 이후 칸 번호가 바뀌어도 내 칸으로 안다. */
  private async reclaimName(t: Track, a: AgentInfo, snap: Snapshot): Promise<void> {
    // 넘겨받은 칸의 이름은 대표의 것이다. 세션으로 알아본다.
    if (a.name || t.m.origin === "adopted") return;
    await this.call("agent.rename", { target: t.paneId, name: this.uniqueName(t.m, snap, t.paneId) }).catch(() => {});
  }

  /** 재시작 복구: 넣다가 죽은 글이 이미 칸에 들어갔는가. 세션 기록과 그 칸의 화면을 본다. */
  async promptSeen(m: RunnerMember, markers: string[]): Promise<boolean> {
    if (!m.sessionId) return false;
    const path = this.sessionFile(m.cwd, m.sessionId);
    const recorded = path ? readTail(path) : "";
    if (markers.some((marker) => recorded.includes(marker))) return true;
    const { live } = this.findLive(await snapshot(this.socketPath), m, true);
    if (!live) return false;
    const screen = await this.readPane(live.pane_id, "recent_unwrapped", 200).catch(() => "");
    return markers.some((marker) => screen.includes(marker));
  }

  sessionExists(m: RunnerMember): boolean {
    return !!m.sessionId && this.sessionFile(m.cwd, m.sessionId) !== null;
  }

  /**
   * 기존 칸을 이 직원으로 등록한다. 사용자가 눌렀을 때만 부른다.
   * 칸은 대표의 것이다: 옮기지도(pane.move 는 번호를 바꾸고 row.py 같은 도구의 탭 구조를 깬다), 이름을 바꾸지도 않는다. 세션으로 알아본다.
   */
  async adopt(m: RunnerMember, paneId: string, _o: StartOpts): Promise<{ sessionId: string | null; paneId: string; tabId: null }> {
    return this.lock(m.projectId, async () => {
      this.letGo.delete(m.id);
      const snap = await snapshot(this.socketPath);
      const source = snap.agents.find((a) => a.pane_id === paneId);
      if (!source) throw new HerdrError("pane_not_found", `에이전트 칸을 찾을 수 없음: ${paneId}`);
      const refusal = adoptRefusal({ agent: source.agent ?? null, status: source.agent_status, sessionId: source.agent_session?.value ?? null, adopted: false });
      if (refusal) throw new HerdrError("cannot_adopt", refusal);
      const t = this.bind({ ...m, paneId, sessionId: source.agent_session!.value }, source);
      this.emitPane(t);
      if (t.sessionId) this.emit({ type: "session", memberId: m.id, sessionId: t.sessionId });
      mkdirSync(this.memberInbox(m), { recursive: true, mode: 0o700 });
      await this.grantDirs(t);
      return { sessionId: t.sessionId, paneId: t.paneId, tabId: null };
    });
  }

  /**
   * 편입 해제: 칸과 세션은 그대로 두고 손을 뗀다. 쉬고 있을 때만 notice 를 넣는다. 입력칸에 남은 글은 지우고 넣는다(합쳐지지 않게).
   * 입력칸을 못 찾으면(선택 창 등) 알리지 않는다.
   */
  async release(m: RunnerMember, notice: string | null): Promise<{ notified: boolean }> {
    // 알리는 동안 화면 폴링 등이 칸을 다시 묶으면, 명부에서 빠진 뒤에도 칸이 죽은 직원 것으로 남아 다시 넘겨받을 수 없다.
    this.letGo.add(m.id);
    return this.lock(m.projectId, async () => {
      let t = this.tracks.get(m.id);
      if (!t && (m.paneId || m.sessionId)) {
        const { live } = this.findLive(await snapshot(this.socketPath), m, true);
        if (live) t = this.bind(m, live);
      }
      if (!t) return { notified: false };
      const { paneId, inTurn, awaiting, compact } = t;
      this.forget(t);
      if (!notice || inTurn || awaiting || compact) return { notified: false };
      try {
        const { agent } = await this.call<{ agent: AgentInfo }>("agent.get", { target: paneId });
        if (agent.agent_status !== "idle" && agent.agent_status !== "done") return { notified: false };
        if (await this.clearInput(paneId, true)) return { notified: false };
        await this.call("agent.prompt", { target: paneId, text: cleanText(notice) }, this.promptTimeoutMs);
        return { notified: true };
      } catch {
        return { notified: false };
      }
    });
  }

  /** 명부에서 빠진 직원. 남은 추적을 지우고 다시 묶지 않는다. */
  dropMember(memberId: string): void {
    this.letGo.add(memberId);
    const t = this.tracks.get(memberId);
    if (t) this.forget(t);
  }

  /**
   * 넘겨받은 세션은 --add-dir 없이 떠 있다. 규칙 전문이 inbox 파일로 가므로 이 세션 동안만 읽게 한다.
   * 실측: /add-dir 은 선택 창을 띄우고 Enter 면 "Yes, for this session" 이다. 실패해도 편입은 이어간다(읽을 때 승인 창이 뜰 뿐).
   * 입력칸에 남은 글은 지우고 넣는다(합쳐져 전송되지 않게). 일하는 중이거나 입력칸을 못 찾으면(선택 창 등) 다음 전달 때로 미룬다.
   */
  private async grantDirs(t: Track): Promise<void> {
    const dir = this.memberInbox(t.m);
    t.grantPending = false;
    try {
      const { agent } = await this.call<{ agent: AgentInfo }>("agent.get", { target: t.paneId });
      if (agent.agent_status !== "idle" && agent.agent_status !== "done") { t.grantPending = true; return; }
      const problem = await this.clearInput(t.paneId, this.quiet(t), t.m.id);
      if (problem) {
        t.grantPending = true;
        this.emit({ type: "activity", memberId: t.m.id, kind: "system", text: `폴더 허용을 미뤘습니다(${problem}). 다음 전달 때 다시 합니다` });
        return;
      }
      t.muteUntil = Date.now() + 5000;
      await this.call("agent.prompt", { target: t.paneId, text: `/add-dir ${dir}` }, this.promptTimeoutMs);
      const deadline = Date.now() + 5000;
      let confirmed = false;
      while (Date.now() < deadline) {
        const screen = await this.readPane(t.paneId, "visible");
        // 지난 기록의 글자가 아니라 지금 떠 있는 선택 창(화면 아래쪽, 이번 명령 뒤)일 때만 Enter 를 보낸다.
        const dialog = screen.split("\n").filter((l) => l.trim()).slice(-12).some((l) => l.includes("Add directory to workspace")) && screen.lastIndexOf("Add directory to workspace") > screen.lastIndexOf(`/add-dir ${dir}`);
        if (!confirmed && dialog) {
          await this.call("agent.send_keys", { target: t.paneId, keys: ["Enter"] });
          confirmed = true;
        } else {
          // 칸이 좁으면 긴 경로가 여러 줄로 접힌다.
          const flat = screen.replace(/\s+/g, "");
          if (flat.lastIndexOf(`Added${dir}`) > flat.lastIndexOf(`/add-dir${dir}`) || /alreadyaccessible/.test(flat)) break;
        }
        await Bun.sleep(150);
      }
    } catch (e) {
      this.emit({ type: "activity", memberId: t.m.id, kind: "error", text: `폴더 허용 실패(${dir}): ${String(e)}` });
    }
  }

  private memberInbox(m: RunnerMember): string {
    return join(this.inboxDir, m.id);
  }

  /**
   * 번호는 herdr 를 다시 켜면 재사용된다. 세션이 맞고 내 칸이거나, 세션 보고가 없으면 어댑터가 준 이름까지 맞아야 그 직원의 칸이다.
   * 세션은 맞는데 내 칸이 아니면(대표가 복사한 명령으로 연 칸) 붙지도 닫지도 않고 conflict 로 알린다. 이미 다른 직원이 쥔 칸에도 붙지 않는다.
   */
  private findLive(snap: Snapshot, m: RunnerMember, allowPane: boolean): { live: AgentInfo | null; conflict: string | null } {
    const taken = (a: AgentInfo) => {
      const holder = this.byPane.get(a.pane_id);
      return holder !== undefined && holder !== m.id;
    };
    if (m.sessionId) {
      const same = snap.agents.filter((a) => a.agent_session?.value === m.sessionId && !taken(a));
      // 넘겨받은 칸은 이름을 주지 않았다. 세션이 곧 근거다. 대표가 칸을 옮겨 번호가 바뀌어도 따라간다.
      if (m.origin === "adopted" && same.length > 0) {
        const here = same.find((a) => a.pane_id === m.paneId) ?? (same.length === 1 ? same[0]! : null);
        if (here) return { live: here, conflict: null };
      }
      const owned = same.filter((a) => ownsPane(a, m));
      if (owned.length === 1) return { live: owned[0]!, conflict: null };
      const exact = same.find((a) => a.pane_id === m.paneId);
      if (owned.length > 1 && exact) return { live: exact, conflict: null };
      if (same.length > 0) {
        const panes = same.map((a) => a.pane_id).join(", ");
        const conflict = `같은 세션이 터미널 칸(${panes})에 열려 있어 붙지 않았습니다. 그 칸을 닫은 뒤 다시 시도하세요`;
        this.emit({ type: "activity", memberId: m.id, kind: "error", text: conflict });
        return { live: null, conflict };
      }
    }
    if (allowPane && m.paneId) {
      const byPane = snap.agents.find((a) => a.pane_id === m.paneId);
      if (byPane && !taken(byPane) && byPane.agent === "claude" && nameMatches(byPane, m) && (!m.sessionId || !byPane.agent_session)) return { live: byPane, conflict: null };
    }
    return { live: null, conflict: null };
  }

  private bind(m: RunnerMember, a: AgentInfo): Track {
    const holder = this.byPane.get(a.pane_id);
    if (holder !== undefined && holder !== m.id) throw new HerdrError("pane_taken", `칸 ${a.pane_id} 은 이미 다른 직원의 칸입니다`);
    const existing = this.tracks.get(m.id);
    if (existing) this.dropTimers(existing);
    if (existing) this.byPane.delete(existing.paneId);
    const t: Track = {
      m, paneId: a.pane_id, tabId: a.tab_id ?? null, sessionId: a.agent_session?.value ?? m.sessionId,
      status: a.agent_status, reported: null, inTurn: a.agent_status === "working", awaiting: null,
      settle: null, stall: null, compact: null, muteUntil: 0, turnGen: existing?.turnGen ?? 0, sawBlocked: false, argsOk: false, grantPending: false, tail: null,
      bg: null, bgPoll: null, bgChecking: false, bgTurn: null, bgSeen: null,
    };
    if (existing?.bg) this.emit({ type: "background", memberId: m.id, label: null });
    this.tracks.set(m.id, t);
    this.byPane.set(t.paneId, m.id);
    this.scheduleResubscribe();
    this.reportStatus(t);
    if (t.inTurn) this.startTail(t);
    // 다시 붙은 칸이 이미 뒤 작업을 기다리고 있을 수 있다(서버를 다시 켰을 때).
    this.syncBgPoll(t);
    return t;
  }

  private emitPane(t: Track): void {
    this.emit({ type: "pane", memberId: t.m.id, paneId: t.paneId, ...(t.tabId ? { tabId: t.tabId } : {}) });
  }

  private reportStatus(t: Track): void {
    if (t.status === "working") this.report(t, "working");
    else if (t.status === "blocked") this.report(t, "blocked");
    else if (t.status === "idle" || t.status === "done") this.report(t, "idle");
  }

  private report(t: Track, status: Reported): void {
    if (t.reported === status) return;
    t.reported = status;
    this.emit({ type: "status", memberId: t.m.id, status });
  }

  private uniqueName(m: RunnerMember, snap: Snapshot, ownPane: string): string {
    // 핸들은 프로젝트 안에서만 유일한데 herdr 이름은 서버 전체에서 유일해야 한다.
    const taken = new Set(snap.agents.filter((a) => a.pane_id !== ownPane && a.name).map((a) => a.name!));
    if (!taken.has(m.handle)) return m.handle;
    const qualified = qualifiedName(m);
    if (!taken.has(qualified)) return qualified;
    return `${m.handle.slice(0, 24)}-${projectSuffix(m)}-${Math.random().toString(36).slice(2, 4)}`;
  }

  private async waitReady(paneId: string): Promise<AgentInfo> {
    const deadline = Date.now() + this.startTimeoutMs;
    let lastError: unknown = null;
    let shellSince: number | null = null;
    let sawProgram = false;
    while (Date.now() < deadline) {
      try {
        const { agent } = await this.call<{ agent: AgentInfo }>("agent.get", { target: paneId });
        if (agent.interactive_ready || agent.agent_status === "blocked" || agent.agent_status === "working") return agent;
        if (agent.agent_status === "idle" || agent.agent_status === "done") return agent;
        // 인식되기 전에 Claude 가 끝나면 herdr 는 launch_pending 을 시간 초과까지 유지한다.
        if (!agent.agent) {
          const { process_info: info } = await this.call<{ process_info: { shell_pid?: number | null; foreground_process_group_id?: number | null } }>("pane.process_info", { pane_id: paneId });
          const atShell = info.foreground_process_group_id === info.shell_pid;
          if (!atShell) { sawProgram = true; shellSince = null; }
          else {
            shellSince ??= Date.now();
            if (sawProgram || Date.now() - shellSince > SHELL_GRACE_MS) throw new HerdrError("agent_exited", `Claude 가 시작하자마자 끝났습니다: ${await this.tailOf(paneId)}`);
          }
        }
      } catch (e) {
        if (e instanceof HerdrError && e.code === "agent_exited") throw e;
        lastError = e;
        if (isGone(e)) throw new HerdrError("agent_exited", `Claude 가 시작하자마자 끝났습니다: ${await this.tailOf(paneId)}`);
        if (isDown(e)) throw e;
      }
      await Bun.sleep(250);
    }
    throw new HerdrError("agent_not_ready", `Claude 가 준비되지 않았습니다${lastError ? `: ${String(lastError)}` : ""}`);
  }

  private async tailOf(paneId: string): Promise<string> {
    const text = await this.readPane(paneId, "recent_unwrapped", 20).catch(() => "");
    return text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" / ");
  }

  /**
   * 프로젝트 탭을 찾는다. DB 의 번호는 herdr 를 다시 켜면 남의 탭 번호가 될 수 있어,
   * 이번 연결에서 어댑터가 직접 만든 탭이거나 그 탭에 이 프로젝트의 세션이 실제로 있을 때만 믿는다.
   * 이름은 근거가 못 된다: 이름 없이 만든 워크스페이스의 이름은 폴더 이름이라 프로젝트 이름과 흔히 같다.
   */
  private async liveTab(m: RunnerMember, o: StartOpts): Promise<string | null> {
    const mine = this.projectTabs.get(m.projectId);
    if (mine) {
      try { await this.call("tab.get", { tab_id: mine }); return mine; }
      catch (e) { if (isDown(e)) throw e; this.projectTabs.delete(m.projectId); }
    }
    if (!o.herdrTabId) return null;
    // 세션으로 확인한 직원이 그 탭에 있으면 프로젝트 이름이 바뀌었어도 내 탭이다.
    if ([...this.tracks.values()].some((t) => t.m.projectId === m.projectId && t.m.origin !== "adopted" && t.tabId === o.herdrTabId)) return o.herdrTabId;
    const sessions = new Set(o.projectSessions ?? []);
    const snap = await snapshot(this.socketPath);
    return snap.agents.some((a) => a.tab_id === o.herdrTabId && !!a.agent_session && sessions.has(a.agent_session.value)) ? o.herdrTabId : null;
  }

  private async createWorkspace(m: RunnerMember, o: StartOpts): Promise<{ tabId: string; paneId: string }> {
    const r = await this.call("workspace.create", { cwd: m.cwd, label: o.projectName, focus: false, ...paneEnv(m) });
    return { tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
  }

  private async allocatePane(m: RunnerMember, o: StartOpts): Promise<{ paneId: string; tabId: string; created: boolean }> {
    // 있는 칸은 다시 쓰지 않는다. agent.start 는 셸에 글자를 치는 방식이라, 사용자가 쓰던 명령과 합쳐져 실행되거나
    // 번호가 재사용된 남의 칸에 명령이 들어간다. 항상 새로 나눈 칸에 띄운다.
    const tabId = await this.liveTab(m, o);
    if (!tabId) {
      const w = await this.createWorkspace(m, o);
      this.projectTabs.set(m.projectId, w.tabId);
      return { paneId: w.paneId, tabId: w.tabId, created: true };
    }
    this.projectTabs.set(m.projectId, tabId);
    const paneId = await this.place(tabId, m.kind, async (target, split) => {
      const r = await this.call("pane.split", { target_pane_id: target, direction: split, cwd: m.cwd, focus: false, ...paneEnv(m) });
      return r.pane.pane_id as string;
    });
    await this.balance(tabId);
    return { paneId, tabId, created: true };
  }

  /**
   * 위 줄 직원, 아래 총괄 모양을 유지하며 새 칸을 놓는다. layout.apply 는 칸을 새로 만들어
   * 안의 세션을 죽이므로 쓰지 않고 split·swap·move 로만 움직인다.
   */
  private async place(
    tabId: string,
    kind: RunnerMember["kind"],
    make: (target: string, split: "right" | "down") => Promise<string>,
  ): Promise<string> {
    const { layout } = await this.call<{ layout: { root: LayoutNode } }>("layout.export", { tab_id: tabId });
    const root = layout.root;
    const newIsWorker = kind === "worker";

    if (root.type === "pane") {
      const occupant = root.pane_id;
      const occupantIsWorker = this.kindOfPane(occupant) === "worker";
      if (newIsWorker && occupantIsWorker) return make(occupant, "right");
      if (!newIsWorker) return make(occupant, "down");
      const pane = await make(occupant, "down");
      await this.call("pane.swap", { source_pane_id: occupant, target_pane_id: pane });
      return pane;
    }

    const hasBottom = root.direction === "down" && root.second.type === "pane";
    if (newIsWorker) return make(rightmost(hasBottom ? root.first : root), "right");
    if (hasBottom) return make(rightmost(root.second), "right");

    // 직원만 있던 탭에 총괄이 온다: 첫 칸 아래로 나눈 뒤 나머지를 첫 칸 옆으로 옮겨 아래를 통째로 비운다.
    // 같은 탭 안 pane.move 는 same_tab 으로 무시되므로 임시 탭을 거친다.
    const { tab } = await this.call<{ tab: { workspace_id: string } }>("tab.get", { tab_id: tabId });
    const row = leaves(root);
    const pane = await make(row[0]!, "down");
    let prev = row[0]!;
    for (const other of row.slice(1)) {
      const out = await this.call("pane.move", { pane_id: other, focus: false, destination: { type: "new_tab", workspace_id: tab.workspace_id } });
      const back = await this.call("pane.move", { pane_id: out.move_result.pane.pane_id, focus: false, destination: { type: "tab", tab_id: tabId, split: "right", target_pane_id: prev } });
      prev = back.move_result.pane.pane_id;
      this.rekeyPane(other, prev);
    }
    return pane;
  }

  private rekeyPane(oldId: string, newId: string, tabId?: string): void {
    const memberId = this.byPane.get(oldId);
    const t = memberId ? this.tracks.get(memberId) : undefined;
    if (!t) return;
    if (tabId) t.tabId = tabId;
    if (oldId === newId) return;
    const cleared = this.lastClear.get(oldId);
    if (cleared !== undefined) this.lastClear.set(newId, cleared);
    this.byPane.delete(oldId);
    t.paneId = newId;
    this.byPane.set(newId, t.m.id);
    this.scheduleResubscribe();
    this.emitPane(t);
  }

  private kindOfPane(paneId: string): RunnerMember["kind"] | null {
    const memberId = this.byPane.get(paneId);
    return memberId ? this.tracks.get(memberId)?.m.kind ?? null : null;
  }

  /** 아래 총괄 30%, 위 줄은 같은 너비. 배치 실패는 일에 지장이 없어 삼킨다. */
  private async balance(tabId: string): Promise<void> {
    try {
      const { layout } = await this.call<{ layout: { root: LayoutNode } }>("layout.export", { tab_id: tabId });
      const set = (path: boolean[], ratio: number) => this.call("layout.set_split_ratio", { tab_id: tabId, path, ratio });
      const walk = async (node: LayoutNode, path: boolean[]): Promise<void> => {
        if (node.type === "pane") return;
        if (node.direction === "right") await set(path, leaves(node.first).length / leaves(node).length);
        await walk(node.first, [...path, false]);
        await walk(node.second, [...path, true]);
      };
      const root = layout.root;
      if (root.type === "split" && root.direction === "down" && root.second.type === "pane") {
        await set([], 1 - CONDUCTOR_RATIO);
        await walk(root.first, [false]);
      } else {
        await walk(root, []);
      }
    } catch (e) {
      console.error("[herdr] 칸 배치 조정 실패:", e);
    }
  }

  private async closePane(paneId: string, tabId: string | null): Promise<void> {
    try { await this.call("pane.close", { pane_id: paneId }); }
    catch (e) { if (!isGone(e)) throw e; }
    if (!tabId) return;
    try { await this.call("tab.get", { tab_id: tabId }); }
    catch { return; } // 마지막 칸이면 탭도 함께 닫힌다.
    // 사용자가 칸을 자기 탭으로 옮겼으면 그 탭의 비율은 사용자의 것이다.
    if ([...this.projectTabs.values()].includes(tabId)) await this.balance(tabId);
  }

  async stop(m: RunnerMember): Promise<void> {
    await this.lock(m.projectId, async () => {
      let t = this.tracks.get(m.id);
      if (!t && (m.paneId || m.sessionId)) {
        // 내 칸일 때만 닫는다. 잠든 직원의 세션을 대표가 터미널에서 연 칸은 닫지 않는다.
        const { live } = this.findLive(await snapshot(this.socketPath), m, true);
        if (live) t = this.bind(m, live);
      }
      if (!t) return;
      const { paneId, tabId } = t;
      // 넘겨받은 칸은 어느 탭에 있든 대표의 것이다(대표가 프로젝트 탭에 직접 나눈 칸일 수 있다). 칸을 닫으면 배치가 무너지므로 Claude 만 끝내고 칸은 셸로 남긴다.
      // 서버 칸으로 옮겨진 세션은 origin=runner 라 여기 오지 않는다.
      if (m.origin === "adopted") {
        await this.exitInPlace(t, m);
        return;
      }
      this.forget(t);
      await this.closePane(paneId, tabId);
    });
  }

  async checkStop(m: RunnerMember, opts: { whileWorking?: boolean } = {}): Promise<void> {
    if (m.origin !== "adopted") return;
    await this.lock(m.projectId, async () => {
      const t = this.tracks.get(m.id);
      const live = t ? null : m.paneId || m.sessionId ? this.findLive(await snapshot(this.socketPath), m, true).live : null;
      const paneId = t?.paneId ?? live?.pane_id;
      if (!paneId) return;
      try {
        const { agent } = await this.call<{ agent: AgentInfo }>("agent.get", { target: paneId });
        await this.assertExitable(opts.whileWorking && agent.agent_status === "working" ? { ...agent, agent_status: "idle" } : agent, paneId, false);
      } catch (e) {
        if (!isGone(e)) throw e;
      }
    });
  }

  /**
   * /exit 를 넣어도 되는가. 입력칸에 남은 글은 끝낼 때 지우므로 막지 않는다. 입력칸을 못 찾으면(선택 창 등) 글자가 선택이 되므로 거부한다.
   * clear 가 false 면 읽기만 한다(미리 보기). true 면 남은 글을 지운다.
   */
  private async assertExitable(info: AgentInfo, paneId: string, clear: boolean, memberId?: string): Promise<void> {
    if (info.agent_status === "blocked") throw new HerdrError("cannot_exit", "승인 창 앞에서 멈춰 있어 세션을 끝낼 수 없습니다. 터미널에서 푼 뒤 다시 시도하세요");
    if (info.agent_status !== "idle" && info.agent_status !== "done") throw new HerdrError("cannot_exit", "일하는 중이라 세션을 끝낼 수 없습니다. 턴이 끝난 뒤 다시 시도하세요");
    const problem = clear ? await this.clearInput(paneId, true, memberId) : inputText(await this.readInputScreen(paneId)) === null ? NO_INPUT_BOX : null;
    if (problem) throw new HerdrError("cannot_exit", `세션을 끝내지 않았습니다: ${problem}. 터미널에서 칸을 확인한 뒤 다시 시도하세요`);
  }

  /** 쉬고 있을 때만 입력칸에 남은 글을 지우고 /exit 를 넣는다. 끝나지 않으면 다시 붙고 오류를 던진다(호출한 쪽은 아무것도 바꾸지 않는다). */
  private async exitInPlace(t: Track, m: RunnerMember): Promise<void> {
    const { paneId } = t;
    const idleBy = Date.now() + EXIT_WAIT_MS;
    let info = (await this.call<{ agent: AgentInfo }>("agent.get", { target: paneId })).agent;
    // 강제 재우기는 먼저 끊고 온다. 끊기는 동안만 기다린다.
    while (info.agent_status === "working" && Date.now() < idleBy) {
      await Bun.sleep(200);
      info = (await this.call<{ agent: AgentInfo }>("agent.get", { target: paneId })).agent;
    }
    await this.assertExitable(info, paneId, true, m.id);
    // 칸에서 Claude 가 끝나는 동안 나오는 신호를 '칸이 사라졌다'로 읽지 않게 먼저 손을 뗀다.
    this.forget(t);
    try {
      await this.call("agent.prompt", { target: paneId, text: "/exit" }, this.promptTimeoutMs);
      const end = Date.now() + EXIT_WAIT_MS;
      while (Date.now() < end) {
        const snap = await snapshot(this.socketPath);
        if (!snap.agents.some((a) => a.pane_id === paneId && a.agent === "claude")) return;
        await Bun.sleep(200);
      }
    } catch (e) {
      if (isGone(e)) return;
      this.bind(m, info);
      if (isDown(e)) throw e;
      throw new HerdrError("cannot_exit", `칸에서 세션을 끝내지 못했습니다: ${(e as Error).message}`);
    }
    this.bind(m, info);
    throw new HerdrError("cannot_exit", "칸에서 세션이 끝나지 않았습니다. 터미널에서 확인하세요");
  }

  private dropTimers(t: Track): void {
    if (t.settle) clearTimeout(t.settle);
    if (t.stall) clearTimeout(t.stall);
    if (t.compact) clearInterval(t.compact.poll);
    t.settle = t.stall = null;
    t.compact = null;
    if (t.tail) clearInterval(t.tail.poll);
    t.tail = null;
    if (t.bgPoll) clearInterval(t.bgPoll);
    t.bgPoll = null;
  }

  private forget(t: Track): void {
    this.dropTimers(t);
    this.setBg(t, null);
    if (this.tracks.get(t.m.id) === t) this.tracks.delete(t.m.id);
    this.byPane.delete(t.paneId);
    this.scheduleResubscribe();
  }

  private sessionPath(t: Track): string | null {
    return t.sessionId ? this.sessionFile(t.m.cwd, t.sessionId) : null;
  }

  private sessionFile(cwd: string, sessionId: string): string | null {
    return findSessionFile(this.claudeHome, cwd, sessionId);
  }

  private transcriptSize(t: Track): number {
    const path = this.sessionPath(t);
    return path ? statSync(path).size : -1;
  }

  private compactBoundaries(t: Track): number {
    const path = this.sessionPath(t);
    return path ? readTail(path).split('"compact_boundary"').length - 1 : 0;
  }

  private transcriptCount(t: Track, needle: string): number {
    const path = this.sessionPath(t);
    return path ? countOf(readTail(path), needle) : 0;
  }

  private lastTurn(t: Track): { finalText: string; contextTokens: number | null; model: string | null; isError: boolean; noOutput: boolean } {
    const path = this.sessionPath(t);
    const tail = path ? readTranscriptTail(path) : null;
    if (!path || !tail) return { finalText: "", contextTokens: null, model: null, isError: false, noOutput: false };
    // 주 세션의 대화 줄만 본다. 마지막 assistant 줄이 API 오류면 Claude 가 표시한다.
    const lines = readTail(path).split("\n").filter((l) => (l.includes('"type":"assistant"') || l.includes('"type":"user"')) && !l.includes('"isSidechain":true'));
    const last = lines.findLastIndex((l) => l.includes('"type":"assistant"'));
    const isError = last >= 0 && lines[last]!.includes('"isApiErrorMessage":true');
    // 오류 줄 바로 앞이 도구 결과가 아니라 입력이면 일을 시작하기 전에 끝난 것이다(사용량 한도 등).
    const before = last > 0 ? lines[last - 1]! : "";
    const noOutput = isError && before.includes('"type":"user"') && !before.includes('"tool_result"');
    return { ...tail, isError, noOutput };
  }

  /** 세션 기록을 이어 읽어 도구 호출과 서브에이전트 수를 headless 와 같게 알린다. */
  private startTail(t: Track, from?: number): void {
    if (t.tail) return;
    const poll = setInterval(() => this.pollTail(t), TAIL_POLL_MS);
    poll.unref?.();
    t.tail = { offset: Math.max(0, from ?? t.awaiting?.size ?? this.transcriptSize(t)), poll, subagents: new Set() };
  }

  private stopTail(t: Track): void {
    if (!t.tail) return;
    this.pollTail(t);
    const had = t.tail.subagents.size;
    clearInterval(t.tail.poll);
    t.tail = null;
    if (had > 0) this.emit({ type: "subagents", memberId: t.m.id, count: 0 });
  }

  private pollTail(t: Track): void {
    const tail = t.tail;
    const path = tail ? this.sessionPath(t) : null;
    if (!tail || !path) return;
    let chunk: Buffer;
    try {
      const size = statSync(path).size;
      if (size <= tail.offset) return;
      chunk = Buffer.alloc(Math.min(size - tail.offset, TAIL_BYTES));
      const fd = openSync(path, "r");
      try { readSync(fd, chunk, 0, chunk.length, tail.offset); } finally { closeSync(fd); }
    } catch { return; }
    // 쓰다 만 줄은 다음에 읽는다.
    const end = chunk.lastIndexOf(10);
    if (end < 0) return;
    tail.offset += end + 1;
    for (const line of chunk.subarray(0, end).toString("utf8").split("\n")) this.feedTailLine(t, tail, line);
  }

  private feedTailLine(t: Track, tail: NonNullable<Track["tail"]>, line: string): void {
    let entry: any;
    try { entry = JSON.parse(line); } catch { return; }
    if (!entry || entry.isSidechain) return;
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    const before = tail.subagents.size;
    for (const block of content) {
      if (entry.type === "assistant" && block?.type === "tool_use") {
        this.emit({ type: "activity", memberId: t.m.id, kind: "tool", text: `${block.name} ${brief(block.input)}` });
        if (SUBAGENT_TOOLS.has(block.name) && typeof block.id === "string") tail.subagents.add(block.id);
      } else if (entry.type === "user" && block?.type === "tool_result") {
        this.emit({ type: "activity", memberId: t.m.id, kind: "tool_result", text: brief(Array.isArray(block.content) ? block.content.map((c: any) => c?.text ?? "").join("\n") : block.content) });
        tail.subagents.delete(block.tool_use_id);
      }
    }
    if (tail.subagents.size !== before) this.emit({ type: "subagents", memberId: t.m.id, count: tail.subagents.size });
  }

  /** 서버가 꺼진 사이 끝난 턴. since(입력을 넣은 시각) 뒤에 쓰인 마지막 글이 있을 때만 준다. */
  finishedWhileAway(m: RunnerMember, since: string): { finalText: string; isError: boolean } | null {
    const t = this.tracks.get(m.id);
    if (!t || t.status === "working" || t.status === "blocked") return null;
    const path = this.sessionPath(t);
    if (!path) return null;
    const stamped = readTail(path).split("\n").filter((l) => l.includes('"type":"assistant"') && !l.includes('"isSidechain":true')).at(-1);
    let at: string | undefined;
    try {
      const entry = stamped ? JSON.parse(stamped) : null;
      at = entry?.timestamp;
      // 도구를 부르다 끊긴 턴의 중간 글은 끝난 보고가 아니다.
      const content = entry?.message?.content;
      if (Array.isArray(content) && content.some((block: { type?: string }) => block?.type === "tool_use")) return null;
    } catch { return null; }
    if (typeof at !== "string" || new Date(at).getTime() <= new Date(since).getTime()) return null;
    const { finalText, isError } = this.lastTurn(t);
    return finalText ? { finalText, isError } : null;
  }

  private async trackOf(m: RunnerMember): Promise<Track | null> {
    const t = this.tracks.get(m.id);
    if (t) return t;
    await this.reattach(m);
    return this.tracks.get(m.id) ?? null;
  }

  private async readPane(paneId: string, source: "visible" | "recent_unwrapped", lines?: number): Promise<string> {
    const r = await this.call<{ read: { text: string } }>("pane.read", { pane_id: paneId, source, ...(lines ? { lines } : {}) });
    return r.read.text;
  }

  /** 입력칸 판정용 화면. 흐린 글씨(추천·안내 글)를 친 글과 가르려고 글자 모양을 함께 읽는다. */
  private async readInputScreen(paneId: string): Promise<string> {
    const r = await this.call<{ read: { text: string } }>("pane.read", { pane_id: paneId, source: "visible", format: "ansi", strip_ansi: false });
    return r.read.text;
  }

  /** 턴 밖으로 보인다. 상태가 idle 로 흔들리는 턴 중간(settle 전)이나 넣은 글의 working 을 기다리는 동안에는 아니다. */
  private quiet(t: Track): boolean {
    return !t.inTurn && t.awaiting === null && t.compact === null;
  }

  /**
   * IAMCEO 가 글을 넣기 전에 입력칸을 비운다. 넣어도 되면 null, 아니면 넣지 못한 이유.
   * IAMCEO 로 보낸 말은 넣는다. 대표가 칸에 동시에 칠 일은 없으니 입력칸에 남은 글은 실수로 남은 것이라 지우고 넣는다.
   * 흐린 추천·안내 글은 친 글이 아니라 키 없이 그대로 넣는다(글을 치면 추천은 사라진다. 이때 누르면 종료 창만 열린다).
   * 입력칸을 못 찾으면(선택 창·승인 창·셸 모드 `!`·다른 프로그램) 넣지 않는다. 친 글자가 선택이나 명령이 된다.
   * idle 은 쉬는 세션이라고 확인했는가: 일하는 중에 지우는 키를 누르면 턴이 끊기므로 그때는 지우지 않는다.
   * 지우는 키는 한 번만 누른다. 안 비었다고 곧바로 또 누르면 빈 칸에 두 번 누른 셈이 되어 세션이 끝난다.
   */
  private async clearInput(paneId: string, idle: boolean, memberId?: string): Promise<string | null> {
    const screen = await this.readInputScreen(paneId);
    const left = inputText(screen);
    if (left === "") return null;
    if (left === null) return NO_INPUT_BOX;
    if (!idle) return "일하는 중이라 입력칸에 남은 글을 지우지 않았습니다(지우는 키가 턴을 끊습니다)";
    // 누가 방금 눌렀다. 이 창 안에 또 누르면 세션이 끝날 수 있다.
    if (exitHintShown(screen)) return "종료 안내(Press Ctrl-C again to exit)가 떠 있어 입력칸에 남은 글을 아직 지우지 않았습니다";
    const now = Date.now();
    if (now - (this.lastClear.get(paneId) ?? 0) < CLEAR_GAP_MS) return "방금 입력칸을 지웠는데 다시 글이 있습니다. 세션이 끝나지 않게 잠시 뒤 다시 지웁니다";
    this.lastClear.set(paneId, now);
    await this.call("agent.send_keys", { target: paneId, keys: [CLEAR_KEY] });
    const pressed = Date.now();
    await Bun.sleep(CLEAR_SETTLE_MS);
    for (;;) {
      const after = inputText(await this.readInputScreen(paneId));
      if (after === "") {
        const shown = left.replace(/\s+/g, " ");
        if (memberId) this.emit({ type: "activity", memberId, kind: "system", text: `입력칸에 남아 있던 글을 지웠습니다: ${shown.length > 80 ? `${shown.slice(0, 80)}…` : shown}` });
        return null;
      }
      if (Date.now() - pressed >= CLEAR_WAIT_MS) return after === null ? `남은 글을 지운 뒤 ${NO_INPUT_BOX}` : "입력칸에 남은 글을 지우는 키를 눌렀지만 비지 않았습니다";
      await Bun.sleep(CLEAR_POLL_MS);
    }
  }

  /** DB 의 번호만 믿으면 재사용된 남의 칸을 읽고 Escape 를 보낸다. 추적 중이거나 세션이 맞는 칸만 쓴다. */
  private async verifiedPane(m: RunnerMember): Promise<string | null> {
    const known = this.tracks.get(m.id);
    if (known) return known.paneId;
    if (!m.sessionId && !m.paneId) return null;
    try { return (await this.trackOf(m))?.paneId ?? null; }
    catch { return null; }
  }

  async screen(m: RunnerMember): Promise<string> {
    const paneId = await this.verifiedPane(m);
    if (!paneId) return "";
    return this.readPane(paneId, "visible").catch(() => "");
  }

  /** 승인 창 앞일 때만 읽는다. 상태는 칸에 직접 묻는다(DB 값은 늦을 수 있다). */
  async approval(m: RunnerMember): Promise<ApprovalPrompt | null> {
    const paneId = await this.verifiedPane(m);
    if (!paneId) return null;
    try {
      const { agent } = await this.call<{ agent: AgentInfo }>("agent.get", { target: paneId });
      if (agent.agent_status !== "blocked") return null;
      return parseApproval(await this.readPane(paneId, "visible"));
    } catch (e) {
      if (isGone(e) || isDown(e)) return null;
      throw e;
    }
  }

  /**
   * 대표가 고른 번호 키를 누른다. 누르기 직전에 다시 읽어 대표가 본 창과 같을 때만 누른다(그사이 다른 창이 떴으면 엉뚱한 것을 승인한다).
   * 같은 칸에 두 번 눌리지 않게 칸마다 한 줄로 세운다. 두 번째 요청은 창이 바뀌었거나 닫혀 있어 거절된다.
   */
  async answerApproval(m: RunnerMember, fingerprint: string, option: number): Promise<ApprovalAnswer> {
    const paneId = await this.verifiedPane(m);
    if (!paneId) return { ok: false, reason: "gone" };
    return this.lock(`approval:${paneId}`, async (): Promise<ApprovalAnswer> => {
      const state = async (): Promise<ApprovalPrompt | null | "not_blocked"> => {
        const { agent } = await this.call<{ agent: AgentInfo }>("agent.get", { target: paneId });
        if (agent.agent_status !== "blocked") return "not_blocked";
        return parseApproval(await this.readPane(paneId, "visible"));
      };
      try {
        const cur = await state();
        if (cur === "not_blocked") return { ok: false, reason: "not_blocked" };
        if (!cur) return { ok: false, reason: "unrecognized" };
        if (cur.fingerprint !== fingerprint) return { ok: false, reason: "changed", current: cur };
        const chosen = cur.options.find((o) => o.n === option);
        if (!chosen) return { ok: false, reason: "no_option", current: cur };
        // 실측: 숫자 키 하나가 고르고 바로 확정한다. Enter 를 더 누르면 다음 창이나 입력칸에 들어간다.
        await this.call("agent.send_keys", { target: paneId, keys: [String(option)] });
        for (const wait of APPROVAL_CHECK_MS) {
          await Bun.sleep(wait);
          const after = await state();
          if (after === "not_blocked" || !after || after.fingerprint !== fingerprint) return { ok: true, prompt: cur, chosen };
        }
        return { ok: false, reason: "no_effect", current: cur };
      } catch (e) {
        if (isGone(e) || isDown(e)) return { ok: false, reason: "gone" };
        throw e;
      }
    });
  }

  async interrupt(m: RunnerMember): Promise<void> {
    const paneId = await this.verifiedPane(m);
    if (!paneId) return;
    try { await this.call("agent.send_keys", { target: paneId, keys: ["Escape"] }); }
    catch (e) { if (!isGone(e) && !isDown(e)) throw e; }
  }

  /**
   * herdr 를 다시 켜면 세션을 `claude --resume <id>` 만으로 되살린다. MCP·권한·폴더 인자가 사라져
   * 도구 없이 지시를 받게 된다. 그런 칸이면 닫고 전체 인자로 다시 연다. 넘겨받은 세션은 원래 인자가 없다.
   */
  private async ensureServerArgs(t: Track, m: RunnerMember, o: StartOpts): Promise<Track> {
    if (t.argsOk || m.origin === "adopted") return t;
    // 돌고 있는 턴을 죽이지 않는다. 다음 전달 때 다시 본다.
    if (t.status === "working" || t.inTurn) return t;
    let argv: string[] | null = null;
    try {
      const { process_info: info } = await this.call<{ process_info: { foreground_processes?: { argv?: string[] | null; cmdline?: string | null }[] } }>("pane.process_info", { pane_id: t.paneId });
      argv = (info.foreground_processes ?? []).flatMap((p) => p.argv ?? p.cmdline?.split(/\s+/) ?? []);
    } catch (e) {
      if (isDown(e)) throw e;
    }
    // 확인할 수 없으면 있는 칸을 닫지 않는다.
    const flagOk = (flag: string, want: string | null | undefined) => !want || argv![argv!.indexOf(flag) + 1] === want;
    if (!argv || argv.length === 0 || (argv.includes("--mcp-config") && flagOk("--model", m.model) && flagOk("--effort", m.effort))) {
      t.argsOk = true;
      return t;
    }
    this.emit({ type: "activity", memberId: m.id, kind: "system", text: "herdr 가 되살린 칸에 도구·권한 설정이 없어 전체 설정으로 다시 엽니다" });
    const { paneId, tabId } = t;
    await this.lock(m.projectId, async () => {
      this.forget(t);
      await this.closePane(paneId, tabId);
      await this.startLocked({ ...m, sessionId: t.sessionId ?? m.sessionId, paneId: null }, { ...o, resume: true });
    });
    const fresh = this.tracks.get(m.id);
    if (!fresh) throw new HerdrError("agent_not_ready", "칸을 다시 열지 못했습니다");
    return fresh;
  }

  /**
   * /model·/effort 를 칸에 넣으면 사용자 전체 기본값(~/.claude/settings.json)까지 바뀐다(2.1.316 실측: "saved as your default for new sessions").
   * 그래서 쉴 때 입력칸을 확인하고 칸을 닫은 뒤 --resume 으로 새 인자와 환경으로 다시 연다. 기록은 그대로 이어진다.
   */
  async applyConfig(m: RunnerMember, o: StartOpts): Promise<SendResult> {
    try {
      const t = await this.trackOf(m);
      if (!t) return { ok: false, reason: "gone", retryable: false };
      const blocked = await this.precheck(t, false);
      if (blocked) return blocked;
      // 일하는 중으로 안 보여도 턴 안이면 끊지 않는다. 뒤 작업을 기다리는 칸을 닫으면 그 작업이 죽는다.
      if (t.inTurn || t.bg) return { ok: false, reason: "busy", retryable: true };
      const { paneId, tabId } = t;
      await this.lock(m.projectId, async () => {
        this.forget(t);
        await this.closePane(paneId, tabId);
        await this.startLocked({ ...m, sessionId: t.sessionId ?? m.sessionId, paneId: null }, { ...o, resume: true });
      });
      const fresh = this.tracks.get(m.id);
      if (!fresh) return { ok: false, reason: "gone", detail: "칸을 다시 열지 못했습니다", retryable: false };
      // 새 칸의 명령줄로 확인한다. 알 수 없으면 믿고 간다(프로세스 정보가 없는 칸이 있다).
      const problem = await this.argsProblem(fresh.paneId, m);
      if (problem) return { ok: false, reason: "error", detail: problem, retryable: true };
      return { ok: true };
    } catch (e) {
      return this.failure(e);
    }
  }

  private async argsProblem(paneId: string, m: RunnerMember): Promise<string | null> {
    const { process_info: info } = await this.call<{ process_info: { foreground_processes?: { argv?: string[] | null; cmdline?: string | null }[] } }>("pane.process_info", { pane_id: paneId }).catch(() => ({ process_info: {} as { foreground_processes?: { argv?: string[] | null; cmdline?: string | null }[] } }));
    const argv = (info.foreground_processes ?? []).flatMap((p) => p.argv ?? p.cmdline?.split(/\s+/) ?? []);
    if (argv.length === 0 || !argv.includes("--mcp-config")) return null;
    if (m.model && argv[argv.indexOf("--model") + 1] !== m.model) return `다시 연 칸의 모델이 ${m.model} 이 아닙니다`;
    if (m.effort && argv[argv.indexOf("--effort") + 1] !== m.effort) return `다시 연 칸의 effort 가 ${m.effort} 가 아닙니다`;
    return null;
  }

  /** 넣기 전 공통 점검. 넣어도 되면 null. */
  private async precheck(t: Track, urgent: boolean): Promise<SendResult | null> {
    let info: AgentInfo;
    try {
      info = (await this.call<{ agent: AgentInfo }>("agent.get", { target: t.paneId })).agent;
    } catch (e) {
      return this.failure(e);
    }
    this.connected = true;
    if (this.isForeign(info, t)) {
      this.gone(t);
      return { ok: false, reason: "gone", detail: `칸 ${t.paneId} 에 다른 세션이 들어와 있습니다`, retryable: false };
    }
    if (info.agent_status !== t.status && info.agent_status !== "unknown") this.applyStatus(t, info.agent_status);
    if (info.agent_status === "blocked") return { ok: false, reason: "blocked", retryable: true };
    // 뒤 작업만 기다리는 세션은 working 이라도 넣는다. 넣기 직전 화면으로 다시 확인한다.
    const background = info.agent_status === "working" && t.bg !== null && this.quiet(t) && (await this.stillBackground(t));
    if (((info.agent_status === "working" && !background) || t.compact !== null || t.awaiting !== null) && !urgent) return { ok: false, reason: "busy", retryable: true };
    // 입력칸을 못 찾으면(셸 모드 `!`, 선택 창, 다른 프로그램) 넣은 글이 명령으로 실행되거나 선택이 된다. 남은 글은 지우고 넣는다.
    // urgent 는 일하는 중에도 넣는다. 그때 남은 글을 지우는 키는 턴을 끊으므로 누르지 않는다.
    const idle = (info.agent_status === "idle" || info.agent_status === "done") && this.quiet(t);
    const problem = await this.clearInput(t.paneId, idle, t.m.id);
    if (problem) return { ok: false, reason: "input_busy", detail: problem, retryable: true };
    return null;
  }

  /** 번호가 재사용되어 남의 에이전트가 이 칸에 들어왔는가. 세션이 맞으면 내 칸이다. 세션 보고가 없으면 이름으로 본다(이름도 없으면 알 수 없어 그대로 둔다). */
  private isForeign(a: AgentInfo, t: Track): boolean {
    const session = a.agent_session?.value;
    if (session && session === t.sessionId) return false;
    if (a.agent && a.agent !== "claude") return true;
    // 넘겨받은 칸의 근거는 세션뿐이다. 칸 이름이 우연히 핸들과 같아도 /clear 로 바뀐 세션은 규칙을 받지 않았으니 놓는다.
    if (session && t.sessionId && t.m.origin === "adopted") return true;
    if (nameMatches(a, t.m)) return false;
    return !!session || !!a.name;
  }

  private failure(e: unknown): SendResult {
    if (isDown(e)) { this.connected = false; return { ok: false, reason: "down", detail: String(e), retryable: true }; }
    if (isGone(e)) return { ok: false, reason: "gone", detail: String(e), retryable: false };
    if (e instanceof HerdrError) {
      if (e.code === "agent_blocked") return { ok: false, reason: "blocked", retryable: true };
      if (e.code === "agent_not_ready") return { ok: false, reason: "busy", detail: e.message, retryable: true };
      return { ok: false, reason: "error", detail: `${e.code}: ${e.message}`, retryable: e.code === "timeout" };
    }
    return { ok: false, reason: "error", detail: String(e), retryable: false };
  }

  private spillIfLong(text: string, m: RunnerMember): string {
    if (text.length <= LONG_TEXT) return text;
    const dir = this.memberInbox(m);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const marker = [...text.matchAll(ID_MARK)].at(-1)?.[0].slice(1);
    const path = join(dir, `${marker ?? crypto.randomUUID()}.md`);
    writeFileSync(path, text, { mode: 0o600 });
    // 첫 줄의 접두어가 출처이므로 그대로 남긴다.
    const first = text.split("\n")[0]!;
    const head = first.length > 300 ? `${first.slice(0, 300)}…` : first;
    return `${head}\n(전문이 길어 파일로 두었습니다. 먼저 읽으세요: ${path})${marker ? ` #${marker}` : ""}`;
  }

  /** 넣기 전 화면·기록의 표지 수. timeout 뒤 이번 글의 흔적과 지난 글의 흔적을 가른다. */
  private async promptBaseline(t: Track, marker: string): Promise<{ marks: number; pasted: number; recorded: number }> {
    const screen = await this.readPane(t.paneId, "recent_unwrapped", 200).catch(() => "");
    return { marks: countOf(screen, marker), pasted: countOf(screen, "[Pasted text"), recorded: this.transcriptCount(t, marker) };
  }

  /** timeout 은 안 들어갔다는 증거가 아니다. 들어갔으면 true. 넣기 전보다 늘었을 때만 이번 글의 증거로 친다. */
  private async delivered(t: Track, marker: string, base: { marks: number; pasted: number; recorded: number }, urgent: boolean): Promise<boolean> {
    try {
      const { agent } = await this.call<{ agent: AgentInfo }>("agent.get", { target: t.paneId });
      if (agent.agent_status === "working" && !urgent) return true;
      const screen = await this.readPane(t.paneId, "recent_unwrapped", 200);
      if (countOf(screen, marker) > base.marks || countOf(screen, "[Pasted text") > base.pasted) return true;
    } catch (e) {
      if (isDown(e)) return true; // 확인할 수 없을 때 다시 넣으면 두 번 들어갈 수 있다.
    }
    return this.transcriptCount(t, marker) > base.recorded;
  }

  private async prompt(t: Track, raw: string, urgent = false): Promise<SendResult> {
    // 칸에 넣기 전 마지막 관문. herdr 는 ESC·DEL 을 그대로 터미널로 보내 붙여넣기를 끝내고 입력을 고칠 수 있다.
    const text = cleanText(raw);
    const marker = markerOf(text);
    const base = await this.promptBaseline(t, marker);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.call("agent.prompt", { target: t.paneId, text }, this.promptTimeoutMs);
        return { ok: true };
      } catch (e) {
        if (e instanceof HerdrError && e.code === "timeout") {
          if (await this.delivered(t, marker, base, urgent)) return { ok: true };
          if (attempt === 0) {
            // 입력칸에 이번 글이 반쯤 들어갔거나 다른 글이 남았을 수 있다. 그대로 넣으면 합쳐져 제출된다.
            // 넣을 때와 같은 규칙: 쉬고 있을 때만 지우고 다시 넣는다. 일하는 중이면 다시 넣지 않는다(지우는 키는 턴을 끊고, 넣던 글이 늦게 들어갈 수 있다).
            let problem: string | null;
            try {
              const { agent } = await this.call<{ agent: AgentInfo }>("agent.get", { target: t.paneId });
              if (agent.agent_status === "blocked") return { ok: false, reason: "blocked", retryable: true };
              if (agent.agent_status !== "idle" && agent.agent_status !== "done") return { ok: false, reason: "busy", detail: "시간 초과 뒤 일하는 중이라 다시 넣지 않았습니다", retryable: true };
              problem = await this.clearInput(t.paneId, !t.inTurn, t.m.id);
            } catch (err) {
              return this.failure(err);
            }
            if (problem) return { ok: false, reason: "input_busy", detail: `시간 초과 뒤 다시 넣지 않았습니다: ${problem}`, retryable: true };
            continue;
          }
        }
        return this.failure(e);
      }
    }
  }

  async send(m: RunnerMember, text: string, o: StartOpts, urgent = false): Promise<SendResult> {
    try {
      const found = await this.trackOf(m);
      if (!found) return { ok: false, reason: "gone", retryable: false };
      const blocked = await this.precheck(found, urgent);
      if (blocked) return blocked;
      const t = await this.ensureServerArgs(found, m, o);
      if (t.grantPending) await this.grantDirs(t);
      const marked = withMarker(cleanText(text), o.marker);
      const marker = markerOf(marked);
      const size = this.transcriptSize(t);
      const markerCount = this.transcriptCount(t, marker);
      const gen = t.turnGen;
      t.sawBlocked = false;
      // 무음은 슬래시 명령 자체에만 쓴다. 일 글의 working 까지 묻히면 턴 시작을 놓쳐 turn_end 가 영영 안 난다.
      t.muteUntil = 0;
      const background = t.bg !== null && t.status === "working" && this.quiet(t);
      const sent = await this.prompt(t, this.spillIfLong(marked, m), urgent);
      if (!sent.ok) return sent;
      if (background) {
        // herdr 는 이미 working 이라 턴 시작 신호가 오지 않는다. 넣은 것으로 턴을 연다. 끝은 checkBackground 가 기록과 화면으로 본다.
        t.inTurn = true;
        t.bgTurn = { from: Math.max(0, size), at: Date.now() };
        t.bgSeen = null;
        this.startTail(t, size);
        return { ok: true };
      }
      // 응답이 늦어 그 사이 턴 시작을 봤거나 턴이 이미 끝났으면 다시 기다리지 않는다. 안 그러면 turn_end 가 두 번 나거나 스톨까지 늦어진다.
      // status 만 working 이고 inTurn 이 아니면 슬래시 명령의 남은 working 이다. 이번 글의 턴은 아직 못 봤다.
      if (!t.inTurn && t.turnGen === gen) {
        t.awaiting = { size, at: Date.now(), marker, markerCount };
        this.armStall(t);
      }
      return { ok: true };
    } catch (e) {
      return this.failure(e);
    }
  }

  async compact(m: RunnerMember, focus: string, _o: StartOpts): Promise<SendResult> {
    try {
      const t = await this.trackOf(m);
      if (!t) return { ok: false, reason: "gone", retryable: false };
      const blocked = await this.precheck(t, false);
      if (blocked) return blocked;
      // 압축 끝은 쉬는 상태로 가른다. 뒤 작업이 도는 동안은 하지 않는다.
      if (t.bg) return { ok: false, reason: "busy", detail: "뒤 작업을 기다리는 중이라 압축하지 않았습니다", retryable: true };
      if (!t.sessionId) return { ok: false, reason: "error", detail: "세션 ID 를 몰라 압축 끝을 알 수 없습니다", retryable: false };
      const baseline = this.compactBoundaries(t);
      const poll = setInterval(() => this.pollCompact(t), 500);
      poll.unref?.();
      t.compact = { baseline, startedAt: Date.now(), idleSince: null, poll };
      // /compact 앞에 공백이 붙거나 줄이 나뉘면 일반 메시지로 들어간다.
      const sent = await this.prompt(t, `/compact ${cleanText(focus).replace(/\s+/g, " ").trim()}`.trimEnd());
      if (!sent.ok) {
        clearInterval(poll);
        t.compact = null;
        return sent;
      }
      this.emit({ type: "activity", memberId: m.id, kind: "compact", text: "압축 시작" });
      return { ok: true };
    } catch (e) {
      return this.failure(e);
    }
  }

  private pollCompact(t: Track): void {
    const c = t.compact;
    if (!c || !t.sessionId) return;
    const now = Date.now();
    if (this.compactBoundaries(t) > c.baseline) {
      this.finishCompact(t);
      return;
    }
    const idle = t.status === "idle" || t.status === "done";
    c.idleSince = idle ? c.idleSince ?? now : null;
    const stuckIdle = c.idleSince !== null && now - c.idleSince > this.compactGraceMs;
    if (stuckIdle || now - c.startedAt > this.compactTimeoutMs) {
      clearInterval(c.poll);
      t.compact = null;
      t.inTurn = false;
      this.report(t, idle ? "idle" : t.status === "blocked" ? "blocked" : "working");
      const errorText = "압축이 끝났다는 기록(compact_boundary)을 찾지 못했습니다";
      this.emit({ type: "activity", memberId: t.m.id, kind: "error", text: errorText });
      this.emit({ type: "turn_end", memberId: t.m.id, finalText: "", isError: true, errorText });
    }
  }

  private finishCompact(t: Track): void {
    if (t.compact) clearInterval(t.compact.poll);
    t.compact = null;
    t.inTurn = false;
    if (t.status === "idle" || t.status === "done") this.report(t, "idle");
    // 상태줄 숫자는 다음 요청 전까지 옛 값이라 0 으로 돌린다. 안 그러면 압축이 되풀이된다.
    this.emit({ type: "context", memberId: t.m.id, pct: 0 });
    this.emit({ type: "activity", memberId: t.m.id, kind: "compact", text: "압축 완료" });
    this.emit({ type: "compacted", memberId: t.m.id });
  }

  async setParallel(m: RunnerMember, on: boolean, _o: StartOpts): Promise<SendResult> {
    try {
      const t = await this.trackOf(m);
      if (!t) return { ok: false, reason: "gone", retryable: false };
      const blocked = await this.precheck(t, false);
      if (blocked) return blocked;
      t.muteUntil = Date.now() + 5000;
      const word = on ? "on" : "off";
      const sent = await this.prompt(t, `/effort ultracode ${word}`);
      if (!sent.ok) return sent;
      // 실측 응답: "Ultracode on (this session only): ..." / "Ultracode off. Effort stays medium."
      // 앞서 켜고 끈 줄이 화면에 남아 있으므로 이번 명령 줄 아래만 본다.
      const expected = new RegExp(`^\\W*ultracode ${word}\\b`, "i");
      const command = `/effort ultracode ${word}`;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const screen = await this.readPane(t.paneId, "visible");
        const after = screen.slice(screen.lastIndexOf(command) + 1).split("\n").slice(1);
        if (screen.includes(command) && after.some((l) => expected.test(l))) return { ok: true };
        await Bun.sleep(150);
      }
      return { ok: false, reason: "error", detail: `화면에서 'Ultracode ${word}' 를 확인하지 못했습니다`, retryable: true };
    } catch (e) {
      return this.failure(e);
    }
  }

  private armStall(t: Track): void {
    if (t.stall) clearTimeout(t.stall);
    t.stall = setTimeout(() => void this.checkStall(t), this.stallMs);
    t.stall.unref?.();
  }

  private async checkStall(t: Track): Promise<void> {
    t.stall = null;
    const waiting = t.awaiting;
    if (!waiting || this.tracks.get(t.m.id) !== t) return;
    try {
      const { agent } = await this.call<{ agent: AgentInfo }>("agent.get", { target: t.paneId });
      if (agent.agent_status === "working" || agent.agent_status === "blocked") {
        this.applyStatus(t, agent.agent_status);
        // 승인 창 앞이거나 무음 창에 묻힌 working 일 수 있다. 끝날 때까지 계속 본다.
        if (t.awaiting) this.armStall(t);
        return;
      }
    } catch (e) {
      // 재접속 뒤 다시 본다. 타이머 없이 나가면 awaiting 이 영영 남는다.
      if (isDown(e)) { this.armStall(t); return; }
    }
    t.awaiting = null;
    // working 을 보기 전에 턴이 끝났을 수 있다. 기록에 이번 글이 있으면 정상 종료로 친다.
    if (this.transcriptCount(t, waiting.marker) > waiting.markerCount) { await this.finishTurn(t); return; }
    t.inTurn = false;
    t.turnGen++;
    this.report(t, "idle");
    const errorText = "글을 넣었지만 턴이 시작되지 않았습니다";
    this.emit({ type: "activity", memberId: t.m.id, kind: "error", text: errorText });
    this.emit({ type: "turn_end", memberId: t.m.id, finalText: "", isError: true, errorText, noOutput: true });
  }

  // ---- 뒤 작업 기다림 ----
  // Claude 가 워크플로를 뒤에 걸고 턴을 마치면 화면에 'Waiting for … to finish' 가 뜨고 herdr 는 그 작업이 끝날 때까지(몇 시간이라도) working 이라 한다.
  // 그 동안 턴이 안 끝난 것으로 보면 대표의 답과 지시가 묶인다. 기록과 화면으로 턴 끝을 가려 turn_end 를 내고, 들어온 글은 곧바로 넣는다.

  /** herdr 가 working 인 동안만 판정한다. */
  private syncBgPoll(t: Track): void {
    const want = t.status === "working" && this.tracks.get(t.m.id) === t && !this.stopped;
    if (want && !t.bgPoll) {
      t.bgPoll = setInterval(() => void this.checkBackground(t), this.bgCheckMs);
      t.bgPoll.unref?.();
    } else if (!want && t.bgPoll) {
      clearInterval(t.bgPoll);
      t.bgPoll = null;
    }
  }

  private setBg(t: Track, label: string | null): void {
    if (t.bg === label) return;
    t.bg = label;
    this.emit({ type: "background", memberId: t.m.id, label });
  }

  /** 기록의 주 대화가 턴 끝에 와 있는가. 넣은 글의 턴이면 넣은 위치 뒤만 본다. 기록이 그대로면 지난 판정을 쓴다. */
  private turnEndedInTranscript(t: Track): { ended: boolean; grew: boolean } {
    const path = this.sessionPath(t);
    if (!path) return { ended: false, grew: false };
    const size = statSync(path).size;
    const from = t.bgTurn?.from ?? 0;
    const grew = size > from;
    if (t.bgSeen?.size === size) return { ended: t.bgSeen.ended, grew };
    let ended = false;
    if (grew) {
      const text = readTail(path, Math.min(BG_TAIL_BYTES, size - from));
      ended = transcriptTurnEnded(text);
    }
    t.bgSeen = { size, ended };
    return { ended, grew };
  }

  /** 넣기 직전: 지금도 뒤 작업만 기다리고 있는가. */
  private async stillBackground(t: Track): Promise<boolean> {
    try {
      if (!this.turnEndedInTranscript(t).ended) return false;
      const screen = await this.readInputScreen(t.paneId);
      return backgroundWait(screen) !== null;
    } catch {
      return false;
    }
  }

  /**
   * herdr 가 working 이라는데 턴은 끝났고 뒤 작업만 기다리는가: 기록이 턴 끝이고, 입력칸 위 상태 줄이 'Waiting for … to finish' 이며 입력칸이 비었다.
   * 그러면 턴을 끝낸다(turn_end). 그 사이 넣은 글은 곧바로 처리되고(실측) 끝나면 다시 이 상태로 온다.
   * 뒤 작업이 끝나 Claude 가 알림을 받고 스스로 이어 일하면(기록에 새 입력) 그 일을 턴으로 센다.
   */
  private async checkBackground(t: Track): Promise<void> {
    if (t.bgChecking || this.tracks.get(t.m.id) !== t) return;
    if (t.status !== "working" || t.compact || t.awaiting) return;
    t.bgChecking = true;
    try {
      const { ended, grew } = this.turnEndedInTranscript(t);
      if (!ended) {
        if (t.bg && !t.inTurn) this.selfTurn(t);
        // 뒤 작업 중에 넣은 글이 기록에 끝내 안 나타나면 들어가지 않은 것이다.
        else if (t.inTurn && t.bgTurn && !grew && Date.now() - t.bgTurn.at > this.stallMs) this.bgTurnNeverStarted(t);
        return;
      }
      const screen = await this.readInputScreen(t.paneId);
      if (this.tracks.get(t.m.id) !== t || t.status !== "working" || t.awaiting || t.compact) return;
      const label = inputLooksEmpty(screen) === true ? backgroundWait(screen) : null;
      if (!label) return;
      this.setBg(t, label);
      if (t.inTurn) await this.finishTurn(t);
      else this.report(t, "idle");
    } catch {
      // 기록·화면을 못 읽었다. 다음 차례에 다시 본다.
    } finally {
      t.bgChecking = false;
    }
  }

  /** 뒤 작업을 기다리던 세션이 스스로 다시 일한다(뒤 작업이 끝나 알림을 받음). 서버가 넣은 글이 아니다. */
  private selfTurn(t: Track): void {
    this.setBg(t, null);
    t.inTurn = true;
    t.bgTurn = { from: this.transcriptSize(t), at: Date.now() };
    t.bgSeen = null;
    this.startTail(t);
    this.report(t, "working");
  }

  private bgTurnNeverStarted(t: Track): void {
    t.inTurn = false;
    t.bgTurn = null;
    t.turnGen++;
    this.stopTail(t);
    this.report(t, "idle");
    const errorText = "글을 넣었지만 턴이 시작되지 않았습니다";
    this.emit({ type: "activity", memberId: t.m.id, kind: "error", text: errorText });
    this.emit({ type: "turn_end", memberId: t.m.id, finalText: "", isError: true, errorText, noOutput: true });
  }

  private applyStatus(t: Track, status: AgentStatus): void {
    if (status === "unknown") return;
    t.status = status;
    this.syncBgPoll(t);
    if (status === "working" || status === "blocked") {
      if (t.settle) { clearTimeout(t.settle); t.settle = null; }
      const muted = status === "working" && Date.now() < t.muteUntil;
      if (status === "blocked" && t.awaiting) t.sawBlocked = true;
      if (status === "working" && !muted) {
        if (t.stall) { clearTimeout(t.stall); t.stall = null; }
        t.awaiting = null;
        if (!t.compact) { t.inTurn = true; this.startTail(t); }
      }
      if (!muted) this.report(t, status);
      return;
    }
    if (t.settle) return;
    // 도구 사이에 잠깐 idle 이 끼므로 잠시 지켜본 뒤 끝으로 판단한다.
    t.settle = setTimeout(() => void this.settled(t), this.settleMs);
    t.settle.unref?.();
  }

  private async settled(t: Track): Promise<void> {
    t.settle = null;
    if (this.tracks.get(t.m.id) !== t) return;
    if (t.status !== "idle" && t.status !== "done") return;
    // 정말 쉰다: 기다리던 뒤 작업도 끝났다.
    this.setBg(t, null);
    t.bgTurn = null;
    if (t.compact) return;
    if (t.awaiting) {
      if (!t.sawBlocked) return;
      // 승인 창을 거절하면 working 없이 idle 로 돌아온다. 이번 글의 턴은 그걸로 끝이다.
      if (t.stall) { clearTimeout(t.stall); t.stall = null; }
      t.awaiting = null;
      t.sawBlocked = false;
      await this.finishTurn(t);
      return;
    }
    if (t.inTurn) await this.finishTurn(t);
    else this.report(t, "idle");
  }

  private async finishTurn(t: Track): Promise<void> {
    const endedAt = Date.now();
    const sessionId = t.sessionId;
    t.inTurn = false;
    t.bgTurn = null;
    t.turnGen++;
    this.stopTail(t);
    let turn = this.lastTurn(t);
    if (!turn.finalText) {
      await Bun.sleep(400); // 기록이 턴 끝 신호보다 조금 늦게 써질 때가 있다.
      turn = this.lastTurn(t);
    }
    const screen = await this.readPane(t.paneId, "visible").catch(() => "");
    // 턴 처리에서 waiting 으로 갈 수 있으므로 idle 을 먼저 낸다.
    this.report(t, "idle");
    // 창 크기는 서버가 정한다(직원별로 배운 값·설정 기본값). 턴 처리가 압축을 고르기 전에 알린다.
    const shownPct = screenContextPct(screen);
    const base = { tokens: turn.contextTokens, shownPct, model: t.m.model ?? turn.model };
    const reading = sessionId ? await capturedContext(this.contextHome, sessionId, base, endedAt) : base;
    const current = !this.stopped && this.tracks.get(t.m.id) === t && t.sessionId === sessionId;
    if (current && (reading.shownPct !== null || reading.tokens !== null || ("exact" in reading && reading.exact))) {
      this.emit({ type: "context_usage", memberId: t.m.id, ...(sessionId ? { sessionId } : {}), ...reading });
    }
    this.emit({ type: "turn_end", memberId: t.m.id, finalText: turn.finalText, isError: turn.isError, ...(turn.isError ? { errorText: turn.finalText, noOutput: turn.noOutput } : {}) });
  }

  private gone(t: Track): void {
    if (t.inTurn || t.awaiting || t.compact) {
      this.emit({ type: "turn_end", memberId: t.m.id, finalText: "", isError: true, errorText: "herdr 칸이 사라져 턴이 끊겼습니다", ...(t.awaiting ? { noOutput: true } : {}) });
    }
    this.forget(t);
    this.emit({ type: "status", memberId: t.m.id, status: "gone" });
  }

  private rebindPane(t: Track, a: AgentInfo): void {
    this.byPane.delete(t.paneId);
    t.paneId = a.pane_id;
    t.tabId = a.tab_id;
    this.byPane.set(t.paneId, t.m.id);
    this.scheduleResubscribe();
    this.emitPane(t);
  }

  private async resync(): Promise<void> {
    if (this.stopped || this.tracks.size === 0) return;
    let snap: Snapshot;
    try { snap = await snapshot(this.socketPath); }
    catch { this.connected = false; return; }
    this.connected = true;
    for (const t of [...this.tracks.values()]) {
      let agent = snap.agents.find((a) => a.pane_id === t.paneId) ?? null;
      const here = agent?.agent_session?.value;
      // 번호가 재사용되어 남의 에이전트가 들어와 있으면 이 칸은 끝났다.
      if (agent && this.isForeign(agent, t)) agent = null;
      // 지금 칸의 세션이 맞으면 옮기지 않는다. 사용자가 복사한 명령으로 같은 세션을 다른 칸에도 열 수 있다.
      if (t.sessionId && here !== t.sessionId && !(agent && !here)) {
        // 옮겨 간 칸은 이름이 그대로다. 이름이 다르면 대표가 연 칸이니 따라가지 않는다.
        const named = snap.agents.filter((a) => a.agent_session?.value === t.sessionId && (t.m.origin === "adopted" || nameMatches(a, t.m)));
        const moved = named.length === 1 ? named[0]! : null;
        if (moved) { this.rebindPane(t, moved); agent = moved; }
      }
      if (!agent) { this.gone(t); continue; }
      const live = agent.agent_session?.value;
      if (live && live !== t.sessionId) {
        t.sessionId = live;
        this.emit({ type: "session", memberId: t.m.id, sessionId: live });
      }
      if (agent.agent_status !== t.status) this.applyStatus(t, agent.agent_status);
    }
  }

  private queueResync(): void {
    if (this.resyncSoon || this.stopped) return;
    this.resyncSoon = setTimeout(() => { this.resyncSoon = null; void this.resync(); }, 200);
    this.resyncSoon.unref?.();
  }

  private onEvent(e: HerdrEvent): void {
    // herdr 는 구독 이벤트 이름을 pane_updated 와 pane.agent_status_changed 처럼 섞어 보낸다.
    const kind = e.event.replace(/\./g, "_");
    // 칸을 옮기면 번호가 바뀐다. 세션 보고가 없는 칸은 스냅샷만으로 찾을 수 없어 이벤트로 옮겨 적는다.
    if (kind === "pane_moved" && e.data.previous_pane_id && e.data.pane?.pane_id) this.rekeyPane(e.data.previous_pane_id, e.data.pane.pane_id, e.data.pane.tab_id);
    const paneId: string | undefined = e.data.pane_id ?? e.data.pane?.pane_id;
    const memberId = paneId ? this.byPane.get(paneId) : undefined;
    const t = memberId ? this.tracks.get(memberId) : undefined;
    if (kind === "pane_agent_status_changed") {
      if (t) this.applyStatus(t, e.data.agent_status);
      return;
    }
    if (kind === "pane_updated") {
      if (!t) return;
      if (e.data.pane?.agent === null || e.data.pane?.agent === undefined) this.queueResync();
      else if (e.data.pane.agent_status) this.applyStatus(t, e.data.pane.agent_status);
      return;
    }
    if (kind === "pane_closed" || kind === "pane_exited" || kind === "pane_moved") this.queueResync();
  }

  private subscriptions(): Array<Record<string, unknown>> {
    return [
      { type: "pane.closed" }, { type: "pane.exited" }, { type: "pane.moved" }, { type: "pane.updated" },
      ...[...this.byPane.keys()].sort().map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
    ];
  }

  // pane.agent_status_changed 는 pane_id 가 필수라 칸이 바뀌면 다시 구독한다.
  private scheduleResubscribe(): void {
    if (this.subTimer || this.stopped) return;
    this.subTimer = setTimeout(() => { this.subTimer = null; this.openEvents(); }, 50);
    this.subTimer.unref?.();
  }

  private openEvents(): void {
    if (this.stopped) return;
    const subs = this.subscriptions();
    const key = JSON.stringify(subs);
    if (this.sub && key === this.subKey) return;
    const old = this.sub;
    this.subKey = key;
    const sub: Subscription = subscribe(this.socketPath, subs, {
      onOpen: () => {
        old?.close();
        this.backoff = 1000;
        this.connected = true;
        this.queueResync();
      },
      onEvent: (e) => { if (this.sub === sub) this.onEvent(e); },
      onClose: () => {
        if (this.sub !== sub || this.stopped) return;
        old?.close();
        this.sub = null;
        this.subKey = null;
        this.connected = false;
        // 다시 이어졌을 때 herdr 가 새로 켜진 것일 수 있다. 번호를 믿지 않고 다시 확인한다.
        this.projectTabs.clear();
        for (const t of this.tracks.values()) t.argsOk = false;
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.openEvents(); }, this.backoff);
        this.retryTimer.unref?.();
        this.backoff = Math.min(this.backoff * 2, 10_000);
        // 방금 닫힌 칸이 구독 목록에 있으면 서버가 구독째 거부한다. 스냅샷으로 그 칸을 빼야 다음 재시도가 붙는다.
        this.queueResync();
      },
    });
    this.sub = sub;
  }

  isConnected(): boolean { return this.connected; }

  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.resyncTimer);
    for (const timer of [this.subTimer, this.retryTimer, this.resyncSoon]) if (timer) clearTimeout(timer);
    for (const t of this.tracks.values()) this.dropTimers(t);
    this.sub?.close();
    this.sub = null;
  }
}
