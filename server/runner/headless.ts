import { validWindow } from "./context.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { cleanText, SESSION_ID_RE } from "../text.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "./types.ts";

// 뒤쪽 변수들은 서버를 Claude Code 안에서 띄웠을 때 바깥 세션의 신원·설정이 새는 것을 막는다.
const STRIPPED_ENV = /^(HERDR_.*|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CODE_SESSION_.*|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_.*|CLAUDE_CODE_EXECPATH|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_EFFORT_LEVEL|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_SUBAGENT_MODEL_FORCE)$/;
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
const STDERR_TAIL = 4000;
const BRIEF = 300;

export interface HeadlessTimings {
  /** result 를 받은 뒤 스스로 끝나기를 기다리는 시간. MCP 정리 등으로 매달리면 끝낸다. */
  afterResultMs: number;
  interruptToTermMs: number;
  termToKillMs: number;
  /** 종료 뒤 stdout 끝을 기다리는 시간. 손자 프로세스가 파이프를 쥐고 있어도 턴은 끝나야 한다. */
  drainMs: number;
}

const DEFAULT_TIMINGS: HeadlessTimings = { afterResultMs: 5000, interruptToTermMs: 5000, termToKillMs: 3000, drainMs: 1000 };

/** 자식 환경. 지우지 않으면 자식 훅이 라이브 herdr 칸 상태를 오염시킨다(spec §0). */
export function childEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !STRIPPED_ENV.test(key)) env[key] = value;
  }
  return env;
}

/** 서브에이전트 모델을 강제하는 환경변수. 세션 모델과 따로 둔다. */
export function subagentEnv(model: string | null): Record<string, string> {
  return model ? { CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" } : {};
}

/** 어느 백엔드든 "세션 파일이 없어 이어갈 수 없다"는 오류인지. */
export function isMissingSessionError(text: string | null | undefined): boolean {
  return !!text && /no conversation found|session .*(not found|does not exist)/i.test(text);
}

/** 프로세스 표에서 그 아래 프로세스까지 모은다. pgrep 은 플랫폼마다 옵션 순서가 달라 쓰지 않는다. */
function processTree(root: number): number[] {
  const p = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const children = new Map<number, number[]>();
  for (const line of p.stdout.toString().split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const list = children.get(Number(m[2])) ?? [];
    list.push(Number(m[1]));
    children.set(Number(m[2]), list);
  }
  const out: number[] = [];
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) walk(child);
    out.push(pid);
  };
  walk(root);
  return out;
}

function commandOf(pid: number): string {
  const p = Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString() : "";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 글은 stdin 으로 넘긴다. 인자로 넘기면 턴 동안 `ps` 로 대표 글이 보이고(맥의 다른 계정까지), 약 1MB 를 넘으면 E2BIG 로 실행 자체가 안 된다.
 * 실측(2.1.316): `claude -p` 는 인자 없으면 stdin 을 읽고, /compact·/effort 도 같은 길로 동작한다.
 */
export function buildClaudeArgs(m: RunnerMember, o: StartOpts, established: boolean, inbox?: string): string[] {
  const args = ["-p"];
  args.push(established ? "--resume" : "--session-id", m.sessionId!);
  args.push("--mcp-config", o.mcpConfigFile);
  args.push("--append-system-prompt-file", o.systemPromptFile);
  args.push("--permission-mode", m.permissionMode);
  args.push("--permission-prompts", "none");
  args.push("--allowedTools", "mcp__iamceo");
  // 첨부는 프로젝트 폴더 밖에 있다. default 모드는 승인 창이 없어 이 폴더를 열어 주지 않으면 읽지 못한다. herdr 칸과 같다.
  if (inbox) args.push("--add-dir", inbox);
  args.push("--output-format", "stream-json", "--verbose");
  if (m.model) args.push("--model", m.model);
  if (m.effort) args.push("--effort", m.effort);
  args.push("-n", m.name);
  // 글자 하나라도 널이 있으면 Bun.spawn 이 예외를 던져 전달이 영영 막히고 대기열 전체가 멈춘다(실측).
  return args.map((arg) => arg.replaceAll("\0", ""));
}

/** 세션 입력의 마지막 관문. 어떤 경로로 온 글이든 제어문자가 입력을 조작하지 못한다. */
export function claudeInput(text: string): string {
  return cleanText(text);
}

function brief(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length > BRIEF ? `${text.slice(0, BRIEF)}…` : text;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean).join("\n");
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

export interface ParsedResult {
  finalText: string;
  isError: boolean;
  errorText?: string;
}

/** stream-json 한 턴을 줄 단위로 읽는다. JSON 이 아닌 줄·모르는 종류(hook 등)는 그냥 지나간다. */
export class StreamParser {
  sessionId: string | null = null;
  result: ParsedResult | null = null;
  sawCompactBoundary = false;
  /** 모델이 실제로 응답했는가. 사용량 한도처럼 입력을 읽기 전에 끝난 턴을 가른다. */
  sawOutput = false;
  /** 다음 턴의 진행 중 % 계산에 쓴다. */
  contextWindow: number | null;
  private lastText = "";
  private contextTokens: number | null = null;
  private model: string | null = null;
  private subagents = new Set<string>();

  constructor(
    private readonly memberId: string,
    private readonly emit: (e: RunnerEvent) => void,
    private readonly opts: { reportContext: boolean; contextWindow: number | null; onCompactBoundary?: () => void },
  ) {
    this.contextWindow = opts.contextWindow;
  }

  feed(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const o = asRecord(parsed);
    if (!o) return;
    if (o.type === "system") this.onSystem(o);
    else if (o.type === "assistant") this.onAssistant(o);
    else if (o.type === "user") this.onUser(o);
    else if (o.type === "result") this.onResult(o);
  }

  /** 턴이 끝났는데 result 없이 끝났거나 도구가 안 닫혔을 때 수를 되돌린다. */
  finish(): void {
    if (this.subagents.size === 0) return;
    this.subagents.clear();
    this.emit({ type: "subagents", memberId: this.memberId, count: 0 });
  }

  private onSystem(o: Record<string, any>): void {
    if (o.subtype === "init" && typeof o.session_id === "string") {
      this.sessionId = o.session_id;
    } else if (o.subtype === "compact_boundary") {
      this.sawCompactBoundary = true;
      this.emit({ type: "activity", memberId: this.memberId, kind: "compact", text: "문맥을 압축했습니다" });
      this.opts.onCompactBoundary?.();
    }
  }

  private onAssistant(o: Record<string, any>): void {
    // 서브에이전트의 메시지. 그 문맥·글은 이 세션의 것이 아니다.
    if (o.parent_tool_use_id) return;
    const message = asRecord(o.message);
    if (!message) return;
    if (typeof message.model === "string" && message.model !== "<synthetic>") this.model = message.model;
    // 오류 안내는 CLI 가 지어낸 assistant 줄로 온다. 일한 흔적이 아니다.
    if (message.model !== "<synthetic>" && o.isApiErrorMessage !== true && o.error === undefined && Array.isArray(message.content) && message.content.length > 0) this.sawOutput = true;
    const usage = asRecord(message.usage);
    if (usage) {
      this.contextTokens = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
      if (this.contextWindow) this.emitContext(this.contextWindow);
    }
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        this.lastText = block.text;
        this.emit({ type: "activity", memberId: this.memberId, kind: "text", text: block.text });
      } else if (block?.type === "tool_use") {
        this.emit({ type: "activity", memberId: this.memberId, kind: "tool", text: `${block.name} ${brief(block.input)}` });
        if (SUBAGENT_TOOLS.has(block.name) && typeof block.id === "string") {
          this.subagents.add(block.id);
          this.emit({ type: "subagents", memberId: this.memberId, count: this.subagents.size });
        }
      }
    }
  }

  private onUser(o: Record<string, any>): void {
    if (o.parent_tool_use_id) return;
    const content = asRecord(o.message)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      this.emit({ type: "activity", memberId: this.memberId, kind: "tool_result", text: brief(toolResultText(block.content)) });
      if (this.subagents.delete(block.tool_use_id)) {
        this.emit({ type: "subagents", memberId: this.memberId, count: this.subagents.size });
      }
    }
  }

  private onResult(o: Record<string, any>): void {
    if (typeof o.session_id === "string") this.sessionId = o.session_id;
    const isError = o.is_error === true || (typeof o.subtype === "string" && o.subtype.startsWith("error"));
    const text = typeof o.result === "string" ? o.result : "";
    const errors = Array.isArray(o.errors) ? o.errors.filter((e): e is string => typeof e === "string") : [];
    this.result = {
      finalText: text || this.lastText,
      isError,
      ...(isError ? { errorText: errors.join("\n") || text || String(o.subtype ?? "알 수 없는 오류") } : {}),
    };
    // 승인할 사람이 없어(--permission-prompts none) 막힌 도구. 왜 일이 안 됐는지 활동에 남긴다.
    const denied = Array.isArray(o.permission_denials) ? o.permission_denials : [];
    if (denied.length > 0) {
      const tools = [...new Set(denied.map((d: unknown) => String(asRecord(d)?.tool_name ?? "도구")))].join(", ");
      this.emit({ type: "activity", memberId: this.memberId, kind: "error", text: `승인 창이 없어 막혔습니다(${denied.length}건): ${tools}. 권한 모드를 바꾸거나 herdr 로 돌리면 풀립니다` });
    }
    const window = this.windowFrom(asRecord(o.modelUsage));
    if (window) this.contextWindow = window;
    if (this.contextTokens === null) return;
    const exactWindow = this.model ? Number(asRecord(asRecord(o.modelUsage)?.[this.model])?.contextWindow) : NaN;
    if (this.contextWindow) this.emitContext(this.contextWindow, validWindow(exactWindow) ? exactWindow : undefined);
    // modelUsage 에 창 크기가 없으면 herdr 처럼 서버가 정한다(설정 기본값 등).
    else if (this.opts.reportContext) this.emit({ type: "context_usage", memberId: this.memberId, tokens: this.contextTokens, shownPct: null, model: this.model });
  }

  private windowFrom(usage: Record<string, any> | null): number | null {
    if (!usage) return null;
    const own = this.model ? Number(asRecord(usage[this.model])?.contextWindow) : NaN;
    if (own > 0) return own;
    // 서브에이전트 모델이 섞여 있을 수 있다. 주 모델을 못 찾으면 가장 큰 창으로 본다.
    const all = Object.values(usage).map((u) => Number(asRecord(u)?.contextWindow)).filter((n) => n > 0);
    return all.length ? Math.max(...all) : null;
  }

  private emitContext(window: number, exactWindow?: number): void {
    if (!this.opts.reportContext || this.contextTokens === null) return;
    this.emit({ type: "context", memberId: this.memberId, pct: Math.min(100, Math.round((this.contextTokens / window) * 100)), ...(exactWindow !== undefined ? { window: exactWindow } : {}) });
  }
}

type TurnMode = "work" | "compact" | "control";

interface LiveTurn {
  mode: TurnMode;
  proc: Subprocess<Uint8Array, "pipe", "pipe">;
  stopping: boolean;
  pidFile: string | null;
  timers: Set<ReturnType<typeof setTimeout>>;
  done: Promise<SendResult>;
}

interface SessionState {
  sessionId: string;
  /** 첫 턴이 세션을 만들었는지. 거짓이면 --session-id, 참이면 --resume. */
  established: boolean;
  contextWindow: number | null;
}

/** `claude -p` 어댑터. 턴마다 프로세스를 새로 띄운다. 턴 하나에 turn_end 는 정확히 한 번. */
export class HeadlessRunner implements Runner {
  readonly kind = "headless" as const;
  private listeners: ((e: RunnerEvent) => void)[] = [];
  private live = new Map<string, LiveTurn>();
  private sessions = new Map<string, SessionState>();
  private closed = false;
  private readonly env: Record<string, string>;
  private readonly timings: HeadlessTimings;

  constructor(
    private readonly config: { claudeBin: string; runDir?: string; inboxDir?: string },
    deps: { env?: Record<string, string | undefined>; timings?: Partial<HeadlessTimings> } = {},
  ) {
    this.env = childEnv(deps.env ?? process.env);
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
  }

  on(cb: (e: RunnerEvent) => void): void {
    this.listeners.push(cb);
  }

  private emit(e: RunnerEvent): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener(e);
  }

  async available(): Promise<{ ok: boolean; detail?: string }> {
    const found = this.config.claudeBin.includes("/") ? existsSync(this.config.claudeBin) : Bun.which(this.config.claudeBin, { PATH: this.env.PATH ?? "" }) !== null;
    return found ? { ok: true } : { ok: false, detail: `claude 실행 파일을 찾지 못했습니다: ${this.config.claudeBin}` };
  }

  private sessionFor(m: RunnerMember, resume: boolean): SessionState {
    const known = this.sessions.get(m.id);
    if (known && (!m.sessionId || known.sessionId === m.sessionId)) return known;
    // 메모리에 없으면(재시작 뒤) 호출자의 판단을 믿는다. 틀려도 resume 실패 처리로 복구된다.
    const state: SessionState = { sessionId: m.sessionId ?? randomUUID(), established: !!m.sessionId && resume, contextWindow: known?.contextWindow ?? null };
    this.sessions.set(m.id, state);
    return state;
  }

  async start(m: RunnerMember, o: StartOpts): Promise<{ sessionId: string | null; paneId: string | null }> {
    if (!m.sessionId) this.sessions.delete(m.id);
    return { sessionId: this.sessionFor(m, o.resume).sessionId, paneId: null };
  }

  async send(m: RunnerMember, text: string, o: StartOpts): Promise<SendResult> {
    return this.launch(m, text, o, "work").result;
  }

  async compact(m: RunnerMember, focus: string, o: StartOpts): Promise<SendResult> {
    // 슬래시 명령은 한 줄이어야 한다. 줄이 나뉘면 일반 입력이 된다.
    return this.launch(m, `/compact ${claudeInput(focus).replace(/\s+/g, " ").trim()}`.trimEnd(), o, "compact").result;
  }

  async setParallel(m: RunnerMember, on: boolean, o: StartOpts): Promise<SendResult> {
    const started = this.launch(m, `/effort ultracode ${on ? "on" : "off"}`, o, "control");
    return started.result.ok ? (this.live.get(m.id)?.done ?? started.result) : started.result;
  }

  isBusy(memberId: string): boolean {
    return this.live.has(memberId);
  }

  async interrupt(m: RunnerMember): Promise<void> {
    const turn = this.live.get(m.id);
    if (turn) this.terminate(turn);
  }

  async stop(m: RunnerMember): Promise<void> {
    const turn = this.live.get(m.id);
    if (!turn) return;
    this.terminate(turn);
    await turn.done;
  }

  async screen(): Promise<string> {
    return "";
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.live.values()].map((turn) => {
        this.terminate(turn);
        return turn.done;
      }),
    );
  }

  private terminate(turn: LiveTurn): void {
    if (turn.stopping) return;
    turn.stopping = true;
    turn.proc.kill("SIGINT");
    this.later(turn, this.timings.interruptToTermMs, () => {
      turn.proc.kill("SIGTERM");
      this.later(turn, this.timings.termToKillMs, () => turn.proc.kill("SIGKILL"));
    });
  }

  /**
   * 서버가 강제로 죽으면(SIGKILL·충돌) 자식이 고아로 남아 같은 세션에 함께 쓰고, 유효한 토큰으로 도구까지 부른다.
   * 턴마다 남긴 pid 파일을 보고, 명령줄이 그 세션의 것일 때만 프로세스 나무째 끝낸다.
   */
  async reapOrphans(): Promise<void> {
    const dir = this.config.runDir;
    if (!dir || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".turn.json")) continue;
      const file = join(dir, name);
      let record: { pid?: unknown; sessionId?: unknown };
      try {
        record = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        rmSync(file, { force: true });
        continue;
      }
      const { pid, sessionId } = record;
      if (typeof pid === "number" && typeof sessionId === "string" && isAlive(pid)) {
        const command = commandOf(pid);
        // pid 는 재사용된다. 이 세션의 claude -p 가 아니면 절대 건드리지 않는다.
        if (command.includes(sessionId) && command.includes("--output-format")) {
          console.warn(`서버가 강제로 꺼진 뒤 남은 세션 프로세스를 끝냅니다: pid ${pid}, 세션 ${sessionId}`);
          await this.killTree(pid);
        }
      }
      rmSync(file, { force: true });
    }
  }

  private async killTree(pid: number): Promise<void> {
    const tree = processTree(pid);
    const signal = (name: "SIGTERM" | "SIGKILL") => {
      for (const p of tree) {
        try {
          process.kill(p, name);
        } catch {
          // 이미 끝났다.
        }
      }
    };
    signal("SIGTERM");
    const deadline = Date.now() + this.timings.termToKillMs;
    while (Date.now() < deadline && tree.some(isAlive)) await Bun.sleep(100);
    if (tree.some(isAlive)) signal("SIGKILL");
  }

  private recordTurn(memberId: string, pid: number, sessionId: string): string | null {
    const dir = this.config.runDir;
    if (!dir) return null;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${memberId}.turn.json`);
      writeFileSync(file, JSON.stringify({ pid, sessionId }), { mode: 0o600 });
      return file;
    } catch (e) {
      console.warn("턴 기록을 남기지 못했습니다:", (e as Error).message);
      return null;
    }
  }

  private later(turn: LiveTurn, ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      turn.timers.delete(timer);
      run();
    }, ms);
    turn.timers.add(timer);
  }

  private launch(m: RunnerMember, text: string, o: StartOpts, mode: TurnMode, retried = false): { result: SendResult } {
    if (this.closed) return { result: { ok: false, reason: "down", detail: "서버가 종료 중입니다", retryable: true } };
    if (this.live.has(m.id)) return { result: { ok: false, reason: "busy", retryable: true } };
    if (!existsSync(m.cwd)) return { result: { ok: false, reason: "error", detail: `폴더가 없습니다: ${m.cwd}`, retryable: false } };
    // 값이 '--플래그' 면 --resume 뒤에서 옵션으로 해석된다.
    if (m.sessionId && !SESSION_ID_RE.test(m.sessionId)) return { result: { ok: false, reason: "error", detail: `세션 ID 형식이 잘못되었습니다: ${m.sessionId.slice(0, 80)}`, retryable: false } };

    const hadSession = !!m.sessionId;
    const session = this.sessionFor(m, o.resume);
    if (!hadSession) this.emit({ type: "session", memberId: m.id, sessionId: session.sessionId });
    const member = { ...m, sessionId: session.sessionId };

    let inbox: string | undefined;
    if (this.config.inboxDir) {
      inbox = join(this.config.inboxDir, m.id);
      mkdirSync(inbox, { recursive: true, mode: 0o700 });
    }

    let proc: Subprocess<Uint8Array, "pipe", "pipe">;
    try {
      proc = Bun.spawn({
        cmd: [this.config.claudeBin, ...buildClaudeArgs(member, o, session.established, inbox)],
        cwd: m.cwd,
        env: { ...this.env, ...subagentEnv(member.subagentModel) },
        // 다 쓰면 Bun 이 닫는다. 열어 두면 claude -p 가 입력을 3초 기다린다.
        stdin: new TextEncoder().encode(claudeInput(text)),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      const message = (e as Error).message;
      // 인자가 너무 긴 것은 실행기 장애가 아니다. '연결 불가'로 두면 그 직원의 대기열 전체가 영구 보류된다.
      if (/E2BIG|argument list too long/i.test(message)) return { result: { ok: false, reason: "error", detail: `실행 인자가 너무 깁니다: ${message}`, retryable: false } };
      return { result: { ok: false, reason: "down", detail: `claude 를 실행하지 못했습니다: ${message}`, retryable: true } };
    }

    let settle!: (r: SendResult) => void;
    const done = new Promise<SendResult>((resolve) => (settle = resolve));
    const turn: LiveTurn = { mode, proc, stopping: false, pidFile: this.recordTurn(m.id, proc.pid, session.sessionId), timers: new Set(), done };
    this.live.set(m.id, turn);
    if (mode !== "control") this.emit({ type: "status", memberId: m.id, status: "working" });

    const parser = new StreamParser(m.id, (e) => this.emit(e), {
      reportContext: mode === "work",
      contextWindow: session.contextWindow,
      // 압축 턴은 프로세스가 끝난 뒤에야 다음 글을 받을 수 있어 끝에서 알린다.
      onCompactBoundary: mode === "compact" ? undefined : () => this.emit({ type: "compacted", memberId: m.id }),
    });

    void this.watch(turn, parser).then(async ({ stderrTail, exitCode }) => {
      parser.finish();
      if (turn.pidFile) rmSync(turn.pidFile, { force: true });
      for (const timer of turn.timers) clearTimeout(timer);
      this.live.delete(m.id);
      session.contextWindow = parser.contextWindow;

      if (parser.sessionId) {
        session.established = true;
        if (parser.sessionId !== session.sessionId) {
          session.sessionId = parser.sessionId;
          this.emit({ type: "session", memberId: m.id, sessionId: parser.sessionId });
        }
      }
      // 전에 세션이 만들어졌는데 우리가 모르는 경우: --resume 으로 한 번만 다시.
      if (!parser.result && !turn.stopping && !retried && !session.established && /already in use/i.test(stderrTail)) {
        session.established = true;
        const again = this.launch(m, text, o, mode, true);
        if (again.result.ok) {
          settle(await this.live.get(m.id)!.done);
          return;
        }
      }
      settle(this.finishTurn(m.id, turn, parser, stderrTail, exitCode));
    });
    return { result: { ok: true } };
  }

  private async watch(turn: LiveTurn, parser: StreamParser): Promise<{ stderrTail: string; exitCode: number }> {
    const onLine = (line: string) => {
      const hadResult = parser.result !== null;
      parser.feed(line);
      if (!hadResult && parser.result && !turn.stopping) {
        this.later(turn, this.timings.afterResultMs, () => this.terminateAfterResult(turn));
      }
    };
    const stdout = readLines(turn.proc.stdout, onLine);
    const stderr = readTail(turn.proc.stderr);
    const exitCode = await turn.proc.exited;
    await Promise.race([Promise.all([stdout, stderr]), Bun.sleep(this.timings.drainMs)]);
    return { stderrTail: stderr.current(), exitCode };
  }

  private terminateAfterResult(turn: LiveTurn): void {
    turn.proc.kill("SIGTERM");
    this.later(turn, this.timings.termToKillMs, () => turn.proc.kill("SIGKILL"));
  }

  private finishTurn(memberId: string, turn: LiveTurn, parser: StreamParser, stderrTail: string, exitCode: number): SendResult {
    const failure = (): string => stderrTail.trim() || `claude 가 결과 없이 끝났습니다(종료 코드 ${exitCode})`;
    const result = parser.result;
    if (turn.mode === "control") {
      if (result && !result.isError) return { ok: true };
      return { ok: false, reason: "error", detail: result?.errorText ?? failure(), retryable: false };
    }
    if (turn.stopping) {
      // 끊은 것은 오류가 아니다. 끊긴 턴의 글은 보고로 치지 않는다.
      this.emit({ type: "turn_end", memberId, finalText: "", isError: false });
      return { ok: true };
    }
    if (!result) {
      this.emit({ type: "turn_end", memberId, finalText: "", isError: true, errorText: failure(), noOutput: !parser.sawOutput });
    } else if (result.isError) {
      this.emit({ type: "turn_end", memberId, finalText: result.finalText, isError: true, errorText: result.errorText, noOutput: !parser.sawOutput });
    } else if (turn.mode === "compact") {
      this.emit({ type: "compacted", memberId });
    } else {
      this.emit({ type: "turn_end", memberId, finalText: result.finalText, isError: false });
    }
    return { ok: true };
  }
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) onLine(buffer);
}

function readTail(stream: ReadableStream<Uint8Array>): Promise<void> & { current(): string } {
  let tail = "";
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL);
    }
  })();
  return Object.assign(reading, { current: () => tail });
}
