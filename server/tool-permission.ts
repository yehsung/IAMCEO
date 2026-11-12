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
}
/** 훅이 받는 답. pending 이면 같은 id 로 다시 기다린다. allow·deny 면 CLI 에 그대로 답하고, closed 면 아무것도 출력하지 않는다. */
export interface ToolPermissionPoll { id: string | null; state: "pending" | "allow" | "deny" | "closed"; message?: string }

export interface ToolPermissionDeps {
  store: Store;
  /** 이 Mac 의 알림(결재 알림 설정을 따른다). */
  notify(title: string, body: string): void;
  /** 허용하며 남긴 메모. 훅의 허용 답에는 글을 실을 수 없어, 팀장의 다음 입력으로 보낸다. */
  deliverNote(member: Member, decision: Decision): void;
  /** 답 없이 시간이 지나 닫았는데 팀장이 아직 승인 창 앞이다. */
  stillBlocked?(member: Member): void;
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
  /** 마지막으로 요청이 들어오거나 끝난 때. */
  lastSeen: number;
  answer: { state: "allow" | "deny"; message?: string } | null;
  closed: boolean;
  /** 이 카드가 열린 뒤 팀장이 승인 창 앞(blocked)으로 관측된 적이 있다. */
  sawBlocked: boolean;
  grace: ReturnType<typeof setTimeout> | null;
  wake: Set<() => void>;
}

/** 훅의 허용이 듣지 않는, 사람이 직접 답하는 도구. */
const PERSON_ONLY_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

const MASK = "••••";
const MAX_TARGET = 600;
const MAX_TARGET_LINES = 12;
const MAX_TITLE_TARGET = 70;

/** 이름 뒤의 값만 가린다. 따옴표는 남겨 모양을 알아볼 수 있게 한다. */
function maskValue(_match: string, name: string, value: string): string {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
  return `${name}${quote}${MASK}${quote}`;
}

/** 흔히 쓰이는 비밀 모양을 가린다. 지나치게 가리더라도 새는 것보다 낫다. */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[가린 개인 키]")
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

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…(${chars.length - max}자 더 있음)`;
}
function clipLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : `${lines.slice(0, maxLines).join("\n")}\n…(${lines.length - maxLines}줄 더 있음)`;
}
function oneLine(text: string): string { return text.replace(/\s+/g, " ").trim(); }
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
};

/** 도구 이름과 입력에서 '무엇을'(action)과 '어디에'(target)를 만든다. target 은 가리고 자른 것이다. */
export function describeToolRequest(toolName: string, toolInput: unknown): { action: string; target: string } {
  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput as Record<string, unknown> : {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  let action = ACTIONS[toolName] ?? (mcp ? `연결 도구 쓰기(${mcp[1]})` : `도구 쓰기(${toolName})`);
  let target: string;
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (toolName) {
    case "Bash": target = str(input.command) ?? ""; break;
    case "Write": {
      const size = typeof input.content === "string" ? Array.from(input.content).length : null;
      target = `${path ? homeShort(path) : "(경로 없음)"}${size !== null ? ` (${size}자)` : ""}`;
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
    default:
      target = mcp ? `${mcp[2]} ${safeJson(toolInput)}` : safeJson(toolInput);
  }
  if (!target.trim()) target = clip(safeJson(toolInput), 200) || "(내용 없음)";
  action = clip(oneLine(action), 60);
  return { action, target: clipLines(clip(redactSecrets(target), MAX_TARGET), MAX_TARGET_LINES) };
}

/** 마크다운 코드 블록 울타리. 내용 안의 가장 긴 ` 줄보다 길게 둔다. */
function fence(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), m => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
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
      if (this.closeRow(decision.id, "서버가 다시 시작되어 승인 요청이 끊겼습니다. 터미널의 승인 창에서 답해 주세요")) closed++;
    }
    return closed;
  }

  /** 이 팀장에게 열린 카드가 있거나 방금 답했다. 그동안 '승인 대기' 알림을 따로 내지 않는다. */
  covers(memberId: string): boolean {
    for (const entry of this.entries.values()) if (entry.memberId === memberId && !entry.closed && !entry.answer) return true;
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
    const { action, target } = describeToolRequest(input.toolName, input.toolInput);
    const cwd = str(input.cwd) ?? member.cwd ?? null;
    const expiresAt = this.now() + this.ttl;
    const info: ToolPermissionInfo = { tool: clip(input.toolName, 200), action, target, cwd, expiresAt: new Date(expiresAt).toISOString() };
    const { title, detail } = toolPermissionCard(member, info, this.ttl);
    const decision = store.createToolPermissionDecision({ projectId: member.projectId, memberId: member.id, who: member.name, title, detail, options: TOOL_PERMISSION_OPTIONS, toolPermission: info });
    const entry: Entry = { id: decision.id, memberId: member.id, expiresAt, inflight: 0, lastSeen: this.now(), answer: null, closed: false,
      sawBlocked: member.status === "blocked", grace: null, wake: new Set() };
    this.entries.set(decision.id, entry);
    store.appendActivity(member.id, "system", clip(`도구 승인 요청을 결재함에 올렸습니다 · ${action}: ${oneLine(target)}`, 300));
    this.deps.notify(`${member.name} 도구 승인`, `${action}: ${oneLine(target)}`);
    return this.waitOn(entry, signal);
  }

  /** 훅의 다음 기다림. 모르는 카드(서버 재시작 등)는 닫힌 것으로 답하고, 열려 있으면 닫는다. */
  async wait(member: Member, id: string, signal?: AbortSignal): Promise<ToolPermissionPoll> {
    const entry = this.entries.get(id);
    if (!entry) {
      const decision = this.deps.store.getDecision(id);
      if (decision?.kind === "tool_permission" && decision.memberId === member.id && decision.status === "open") this.closeRow(id, "승인 요청이 끊겼습니다. 터미널의 승인 창에서 답해 주세요");
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
      this.close(entry, "터미널 쪽 요청이 끝나 닫았습니다. 터미널에서 답했거나 일이 멈췄습니다");
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
      this.closeRow(decisionId, "승인 요청이 이미 끝났습니다. 터미널의 승인 창에서 답해 주세요");
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
      store.appendActivity(member.id, "system", clip(`대표가 결재함에서 도구 승인 요청을 ${state === "allow" ? "허용" : "거절"}했습니다${info ? ` · ${info.action}: ${oneLine(info.target)}` : ""}`, 300));
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
      if (status === "blocked") {
        entry.sawBlocked = true;
        if (entry.grace) { clearTimeout(entry.grace); entry.grace = null; }
      } else if (status === "gone") {
        this.close(entry, "팀장의 터미널이 끝나 닫았습니다");
      } else if (entry.sawBlocked && !entry.grace) {
        entry.grace = setTimeout(() => {
          entry.grace = null;
          if (entry.closed || entry.answer) return;
          const current = this.deps.store.getMember(memberId);
          if (current?.status === "blocked") return;
          this.close(entry, "터미널에서 먼저 답해 승인 창이 닫혔습니다");
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
      else if (now - entry.lastSeen > this.goneMs) this.close(entry, "터미널 쪽 요청이 끊겨 닫았습니다. 터미널의 승인 창에서 답해 주세요");
    }
  }

  private expire(entry: Entry): void {
    if (entry.closed) return;
    const minutes = Math.max(1, Math.round(this.ttl / 60_000));
    this.close(entry, `${minutes}분 동안 답이 없어 터미널의 승인 창으로 넘겼습니다`);
    const member = this.deps.store.getMember(entry.memberId);
    if (member?.status === "blocked") this.deps.stillBlocked?.(member);
  }

  private close(entry: Entry, reason: string): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.grace) { clearTimeout(entry.grace); entry.grace = null; }
    this.entries.delete(entry.id);
    for (const wake of [...entry.wake]) wake();
    this.closeRow(entry.id, reason);
  }

  /** 열린 카드만 닫는다(이미 답했거나 닫혔으면 그대로). 닫았으면 true. */
  private closeRow(id: string, reason: string): boolean {
    const { store } = this.deps;
    try {
      const decision = store.getDecision(id);
      if (!decision || decision.status !== "open") return false;
      store.closeDecision(id, { kind: null, reason, by: "시스템" });
      if (decision.memberId && store.getMember(decision.memberId)) store.appendActivity(decision.memberId, "system", clip(`도구 승인 카드를 닫았습니다 · ${reason}`, 300));
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return false;
      console.warn("도구 승인 카드를 닫지 못했습니다:", id, (error as Error).message);
      return false;
    }
  }

  /** 서버를 닫는다. 기다리는 훅은 곧 연결이 끊겨 원래 승인 창으로 간다. 카드는 다음 시작 때 닫는다(closeLeftovers). */
  dispose(): void {
    this.disposed = true;
    clearInterval(this.sweeper);
    for (const entry of this.entries.values()) {
      if (entry.grace) clearTimeout(entry.grace);
      for (const wake of [...entry.wake]) wake();
    }
  }
}
