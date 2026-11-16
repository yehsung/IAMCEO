// 11-16(0.2.7 묶음 6): 팀장마다 지금 돌고 있는 서브에이전트 수를 CLI 자기 기록으로 잰다. 읽기만 한다. 시간만으로 줄이거나 지우지 않는다
// (근거를 읽지 못하면 unknown).
//
// 까닭: core 실행 방식으로 바꾼 뒤 서버가 서브에이전트 수를 재지 않아 모든 팀장이 subagentState unknown·subagents 0 이었다. 핫픽스 C 뒤로는
// 팀장이 뒤 작업(백그라운드 에이전트·워크플로)을 남기고 턴을 끝내면 '쉬는 중'으로 보여, 서브에이전트만 일하는 동안 팀장은 그냥 쉬는 것처럼 보였다.
//
// Claude Code 실측(2.1.296~2.1.323, 줄 종류·키만):
// - 턴 끝 system turn_duration 에 그때 남은 뒤 작업 수가 실린다: pendingBackgroundAgentCount(백그라운드 에이전트), pendingWorkflowCount(워크플로).
//   0 이면 키가 없다. 이것이 CLI 자기 셈이다(팀장 세션 기록 5개의 턴 끝 869개 전부 '띄운 것 − 끝 알림'과 맞았다).
// - 띄움: user 줄의 toolUseResult {status:"async_launched", agentId…}(에이전트), {status:"async_launched", taskType:"local_workflow", taskId, runId}(워크플로).
// - 끝: queue-operation enqueue 의 content 에 <task-notification><task-id>…</task-id><status>completed|failed|killed|stopped</status>
//   <summary>Agent "…" finished | Dynamic workflow "…" completed | Task "…" was stopped by main session …</summary>. 알림은 모두 enqueue 줄로 먼저 적힌다.
//   'is waiting on its own background work' 는 중간 알림이다(같은 task-id 가 다시 알린다). 끝으로 세지 않는다.
// - 쉬는 동안 뒤 작업이 끝나면 그 알림으로 Claude 가 스스로 새 턴을 연다(queue-operation dequeue). 그래서 턴이 닫혀 있는 동안의 수는 마지막 턴 끝의 수다.
// - 워크플로 안의 에이전트: <세션>/subagents/workflows/<run>/journal.jsonl 의 started(agentId, key) · result(agentId) · failed(agentId).
//   같은 key 로 다시 started 가 오면 앞 시도는 끝난 것이다(다시 시도: 실측 37건 모두 앞 시도의 기록이 뒤 시도 전에 멈춤). 끝 표시 없이 멈춘
//   에이전트도 남는다(실측: 완료된 실행에서도 끝 표시 없는 에이전트가 워크플로가 끝나기 34~63분 전에 멈춤). 그래서 이 기록으로 센 수는 CLI 자기
//   셈이 아니라 추정(estimated)이다. 끝난 워크플로는 <세션>/workflows/<run>.json 이 생긴다(status completed|failed|killed).
// - 앞 CLI 프로세스의 뒤 작업은 그 프로세스와 함께 끝난다(다음 세션 첫머리 "didn't finish before the previous session ended"). 그래서 이 CLI 를
//   띄운 시각(터미널 라벨 iamceo.startedAt) 뒤의 줄만 센다.
// Codex 실측(0.16x): 네이티브 서브에이전트는 자기 rollout 을 가진다. 첫 줄 session_meta.payload.source.subagent.thread_spawn.parent_thread_id 가
//   부모 세션을 가리키고, 일은 event_msg task_started → task_complete(중단은 turn_aborted)다. 부모는 자식이 일하는 동안 대개 자기 턴을 열어 둔다.
//   자식이 끝 사건 없이 끝나는 길(부모 턴 중단·close_agent)은 실측하지 못했다: 열린 자식의 수는 추정(estimated)이고, 0 일 때만 exact 다.
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTurnInput } from "./claude-turn.ts";
import { jsonObject, providerLogPath, readJsonlRange, type JsonlCursor } from "./delivery-evidence.ts";

export type SubagentQuality = "exact" | "estimated" | "unknown";
/**
 * exact: CLI 자기 셈(마지막 턴 끝의 남은 백그라운드 에이전트 수) 그대로다. estimated: 그 뒤 띄움·끝 알림·전경 에이전트를 더하고 뺀 값이거나
 * (턴이 열려 있거나, 기록 일부를 건너뛰었다), 워크플로 안의 에이전트처럼 실행 기록에서 센 값이다(끝 표시 없이 멈춘 에이전트가 남을 수 있다).
 * unknown: 근거가 없다(count null).
 */
export interface SubagentReading { quality: SubagentQuality; count: number | null; code: string }

/** 처음 붙을 때 기록 끝에서부터 읽는 양, 한 번에 이어 읽는 상한. 마지막 턴 끝은 대개 기록 맨 끝에 있다. */
const TAIL_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const TERMINAL_STATUS = new Set(["completed", "failed", "killed", "stopped"]);
const INTERIM = "waiting on its own background work";
const RUN_ID = /^wf_[A-Za-z0-9_-]{1,64}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** 기억해 두는 띄운 작업 종류의 상한(오래된 것부터 버린다). */
const MAX_KINDS = 512;

const unknownReading = (code: string): SubagentReading => ({ quality: "unknown", count: null, code });

/**
 * 이번에 읽은 범위에서 건너뛴 줄(망가진 줄·4MiB 넘는 줄)의 자리. 읽은 줄들의 바이트 구간 사이에 빈틈이 있으면 그 사이 줄을 건너뛴 것이다.
 * 범위에 망가진 줄이 없으면(빈 줄만 있으면) 빈틈을 보지 않는다. before[i]: i 번째 줄 앞에 건너뛴 줄이 있다. trailing: 마지막 줄 뒤에 있다.
 */
function gapsOf(range: { records: { start: number; end: number }[]; cursor: JsonlCursor | null }, from: number): { before: boolean[]; trailing: boolean } {
  if (!range.cursor?.invalid) return { before: [], trailing: false };
  let end = from;
  const before = range.records.map(record => { const gap = record.start > end; end = record.end; return gap; });
  return { before, trailing: range.cursor.dropping || range.cursor.offset > end };
}
const count = (value: unknown): number | null => value === undefined ? 0 : Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;

// ───────── Claude ─────────

export interface ClaudeSubagentQuery {
  /** CLAUDE_CONFIG_DIR. 기록은 <home>/projects 아래에 있어야 한다. */
  home: string;
  /** 주 대화 기록(<세션>.jsonl). */
  path: string;
  sessionId: string;
  /** 이 CLI 프로세스를 띄운 시각(ms). 이보다 앞 시각의 줄은 앞 프로세스의 것이라 세지 않는다. */
  since: number;
}
interface WorkflowRun {
  /** 이 CLI 를 띄우기 전에 만든 실행(앞 프로세스의 것)이면 true. 다시 보지 않는다. */
  old: boolean;
  /** 끝난 실행(<세션>/workflows/<run>.json 이 있다). 다시 보지 않는다. */
  finished: boolean;
  birth: number;
  journal: JsonlCursor | null;
  /** 실행 기록을 이어 읽을 자리(줄 머리). 망가진 줄을 지나면 그 뒤로 옮긴다. */
  start: number;
  /** 시작한 에이전트(기록 차례). */
  started: string[];
  /** 에이전트의 key. 같은 key 로 뒤에 다시 시작한 에이전트가 있으면 앞 시도는 끝난 것이다. */
  keys: Record<string, string>;
  /** 끝 표시(result·failed)가 있는 에이전트. */
  ended: string[];
}

/** 실행 안에서 돌고 있는 에이전트: 시작했고, 끝 표시(result·failed)가 없고, 같은 key 의 뒤 시도가 없는 것. */
function runningIn(run: WorkflowRun): number {
  const ended = new Set(run.ended), latest = new Map<string, string>();
  for (const id of run.started) if (run.keys[id]) latest.set(run.keys[id]!, id);
  return run.started.filter(id => !ended.has(id) && (!run.keys[id] || latest.get(run.keys[id]!) === id)).length;
}
export interface ClaudeSubagentCursor {
  key: string;
  log: JsonlCursor | null;
  /** 읽기를 시작한 자리(줄 머리). */
  start: number;
  /** 읽은 범위가 이 CLI 의 첫 줄 앞까지 닿는가(기록 처음부터 읽었거나, 첫 줄이 since 앞이다). 아직 모르면 null. */
  covered: boolean | null;
  /** 이 CLI 의 마지막 턴 끝(turn_duration)에 CLI 가 적은 남은 뒤 작업 수. */
  snapshot: { agents: number; workflows: number } | null;
  /** 주 대화의 턴이 열려 있다(팀장이 일하는 중). */
  open: boolean;
  /** 마지막 턴 끝 뒤의 띄움·끝 알림. */
  launchedAgents: number; doneAgents: number; launchedWorkflows: number; doneWorkflows: number;
  /** 끝으로 센 작업(task-id). 같은 끝을 두 번 세지 않는다. */
  done: string[];
  /** 띄운 작업의 종류(task-id → 종류). 'Task "…" was stopped' 처럼 요약으로 종류를 모르는 끝 알림을 가른다. */
  kinds: Record<string, "agent" | "workflow">;
  /** 열린 턴에서 결과를 기다리는 전경 에이전트 호출(tool_use id). */
  foreground: string[];
  /** 기록 일부(망가진 줄)를 건너뛰었다. 다음 턴 끝까지 estimated 다. */
  skipped: boolean;
  /** 다른 세션의 줄을 만났다. 이 세션의 다음 턴 끝까지 unknown 이다. */
  conflict?: boolean;
  runs: Record<string, WorkflowRun>;
}
export interface ClaudeSubagentResult extends SubagentReading {
  /** 다음 읽기가 이어 갈 자리. null 이면 다음에 기록 끝에서부터 다시 잡는다. */
  cursor: ClaudeSubagentCursor | null;
  /** 진단: 이번 값의 내역. */
  detail?: { agents: number; workflows: number; workflowAgents: number; foreground: number };
}

/** 기록 끝에서 bytes 앞 자리 다음의 줄 머리. 파일이 그보다 작으면 0. 줄 머리를 못 찾으면 null. */
function tailStart(target: string, bytes: number): number | null {
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const size = fstatSync(fd).size;
    if (size <= bytes) return 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (let at = size - bytes - 1; at < size;) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - at), at);
      if (!read) return null;
      const newline = buffer.subarray(0, read).indexOf(10);
      if (newline >= 0) return at + newline + 1;
      at += read;
    }
    return null;
  } catch { return null; }
  finally { closeSync(fd); }
}

function freshClaude(key: string, start: number): ClaudeSubagentCursor {
  return { key, log: null, start, covered: start === 0 ? true : null, snapshot: null, open: false, launchedAgents: 0, doneAgents: 0, launchedWorkflows: 0, doneWorkflows: 0,
    done: [], kinds: {}, foreground: [], skipped: false, runs: {} };
}

/** <task-notification> 묶음들. 종류를 모르면 null(셸·Monitor 등은 서브에이전트가 아니다). */
function notifications(text: string): { taskId: string; status: string | null; summary: string }[] {
  const out: { taskId: string; status: string | null; summary: string }[] = [];
  for (const block of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const taskId = /<task-id>([^<]*)<\/task-id>/.exec(block)?.[1]?.trim();
    if (!taskId || !TASK_ID.test(taskId)) continue;
    out.push({ taskId, status: /<status>([^<]*)<\/status>/.exec(block)?.[1]?.trim() ?? null, summary: /<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1]?.trim() ?? "" });
  }
  return out;
}

function noteKind(state: ClaudeSubagentCursor, taskId: unknown, kind: "agent" | "workflow"): void {
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) return;
  state.kinds[taskId] = kind;
  const keys = Object.keys(state.kinds);
  if (keys.length > MAX_KINDS) for (const old of keys.slice(0, keys.length - MAX_KINDS)) delete state.kinds[old];
}

/** 한 줄을 반영한다. 다른 세션의 줄이면 false(부르는 쪽이 근거를 지운다). */
function takeClaude(state: ClaudeSubagentCursor, entry: Record<string, unknown>, query: ClaudeSubagentQuery): boolean {
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (state.covered === null && Number.isFinite(at)) state.covered = at < query.since;
  // 서브에이전트(사이드체인)의 줄은 주 대화가 아니다.
  if (entry.isSidechain) return true;
  if (typeof entry.sessionId === "string" && entry.sessionId !== query.sessionId) return false;
  // 앞 프로세스의 줄(그때의 뒤 작업은 그 프로세스와 함께 끝났다)과 시각 없는 줄은 세지 않는다.
  if (!Number.isFinite(at) || at < query.since) return true;
  if (entry.type === "system") {
    if (entry.subtype === "turn_duration") {
      const agents = count(entry.pendingBackgroundAgentCount), workflows = count(entry.pendingWorkflowCount);
      Object.assign(state, { snapshot: agents === null || workflows === null ? null : { agents, workflows }, open: false, launchedAgents: 0, doneAgents: 0, launchedWorkflows: 0, doneWorkflows: 0, done: [], foreground: [], skipped: false, conflict: false });
      // 모르는 모양의 수: 다음 턴 끝까지 근거가 없다.
      if (agents === null || workflows === null) state.covered = false;
    } else if (entry.subtype === "stop_hook_summary") state.open = false;
    return true;
  }
  if (entry.type === "queue-operation") {
    if (entry.operation === "dequeue") state.open = true;
    if (entry.operation === "enqueue" && typeof entry.content === "string") {
      for (const note of notifications(entry.content)) {
        if (!note.status || !TERMINAL_STATUS.has(note.status) || note.summary.includes(INTERIM) || state.done.includes(note.taskId)) continue;
        const kind = state.kinds[note.taskId] ?? (note.summary.startsWith("Agent \"") ? "agent" : note.summary.startsWith("Dynamic workflow \"") ? "workflow" : null);
        if (!kind) continue;
        state.done.push(note.taskId);
        if (kind === "agent") state.doneAgents++; else state.doneWorkflows++;
      }
    }
    return true;
  }
  if (entry.type === "assistant") {
    state.open = true;
    const content = jsonObject(entry.message)?.content;
    if (Array.isArray(content)) for (const block of content) {
      const item = jsonObject(block), input = jsonObject(item?.input);
      // 전경 에이전트(턴 안에서 결과를 기다리는 Agent·Task 호출). 뒤로 띄운 것은 결과 줄의 async_launched 로 센다.
      if (item?.type === "tool_use" && (item.name === "Agent" || item.name === "Task") && typeof item.id === "string" && input?.run_in_background !== true && !state.foreground.includes(item.id)) state.foreground.push(item.id);
    }
    return true;
  }
  if (entry.type !== "user") return true;
  const result = jsonObject(entry.toolUseResult);
  if (result?.status === "async_launched") {
    if (typeof result.taskType === "string" && result.taskType.includes("workflow")) { state.launchedWorkflows++; noteKind(state, result.taskId, "workflow"); }
    else if (typeof result.agentId === "string") { state.launchedAgents++; noteKind(state, result.agentId, "agent"); }
  }
  const content = jsonObject(entry.message)?.content;
  if (Array.isArray(content) && state.foreground.length) {
    const answered = new Set(content.map(block => jsonObject(block)).filter(item => item?.type === "tool_result" && typeof item.tool_use_id === "string").map(item => item!.tool_use_id as string));
    if (answered.size) state.foreground = state.foreground.filter(id => !answered.has(id));
  }
  if (isTurnInput(entry)) state.open = true;
  return true;
}

/** 이 CLI 가 띄우고 아직 끝나지 않은 워크플로 실행과 그 안에서 돌고 있는 에이전트 수(실행 기록에서 센 추정). */
function pendingRuns(root: string, query: ClaudeSubagentQuery, state: ClaudeSubagentCursor): { runId: string; birth: number; running: number }[] {
  const sessionDir = join(dirname(query.path), query.sessionId);
  const flows = join(sessionDir, "subagents", "workflows");
  let names: string[];
  try { names = readdirSync(flows); }
  catch { return []; }
  // 세션 폴더가 기록 폴더 밖(심볼릭 링크)이면 읽지 않는다.
  if (!providerLogPath(root, flows)) return [];
  const out: { runId: string; birth: number; running: number }[] = [];
  for (const runId of names) {
    if (!RUN_ID.test(runId)) continue;
    let run = state.runs[runId];
    if (!run) {
      let stat: ReturnType<typeof lstatSync>;
      try { stat = lstatSync(join(flows, runId)); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const birth = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      run = state.runs[runId] = { old: birth < query.since, finished: false, birth, journal: null, start: 0, started: [], keys: {}, ended: [] };
    }
    if (run.old || run.finished) continue;
    if (existsSync(join(sessionDir, "workflows", `${runId}.json`))) { run.finished = true; continue; }
    const range = readJsonlRange(root, join(flows, runId, "journal.jsonl"), run.journal, { startOffset: run.start, maxBytes: CHUNK_BYTES });
    const read = !!range.cursor && ["complete_range", "partial_log", "scan_pending", "corrupt_log"].includes(range.code);
    if (read) {
      for (const record of range.records) {
        const line = jsonObject(record.value);
        if (typeof line?.agentId !== "string") continue;
        if (line.type === "started" && !run.started.includes(line.agentId)) {
          run.started.push(line.agentId);
          if (typeof line.key === "string") run.keys[line.agentId] = line.key;
        }
        // 끝 표시: 결과(result)와 실패(failed, 실측 {type, key, agentId}).
        if ((line.type === "result" || line.type === "failed") && !run.ended.includes(line.agentId)) run.ended.push(line.agentId);
      }
      run.journal = range.cursor;
      // 망가진 줄을 지났으면 그 뒤 줄 머리부터 새로 이어 읽는다(처음부터 다시 읽지 않는다).
      if (range.cursor!.invalid && !range.cursor!.dropping) { run.journal = null; run.start = range.cursor!.offset; }
    } else { run.journal = null; run.start = 0; run.started = []; run.keys = {}; run.ended = []; }
    // 따라잡는 중(scan_pending)이면 다음 관측이 이어 읽는다. 아직 없는 기록 파일은 다음에 처음부터 읽는다.
    out.push({ runId, birth: run.birth, running: runningIn(run) });
  }
  return out;
}

/**
 * 주 대화 기록(봉투 기준선과 무관하게 기록 끝 쪽부터)을 이어 읽어 지금 돌고 있는 서브에이전트 수를 낸다.
 * 수 = 백그라운드 에이전트 + 워크플로마다 그 안에서 돌고 있는 에이전트(단계 사이라 없으면 1) + 열린 턴의 전경 에이전트.
 */
export function readClaudeSubagents(query: ClaudeSubagentQuery, previous?: ClaudeSubagentCursor | null): ClaudeSubagentResult {
  const root = join(query.home, "projects");
  const key = JSON.stringify([root, query.path, query.sessionId, query.since]);
  const unknown = (code: string, cursor: ClaudeSubagentCursor | null = null): ClaudeSubagentResult => ({ ...unknownReading(code), cursor });
  if (!Number.isFinite(query.since)) return unknown("since_unknown");
  const target = providerLogPath(root, query.path);
  if (!target) return unknown("path_unavailable");
  let state = previous && previous.key === key ? previous : null;
  if (!state) {
    const start = tailStart(target, TAIL_BYTES);
    if (start === null) return unknown("tail_unreadable");
    state = freshClaude(key, start);
  }
  const range = readJsonlRange(root, query.path, state.log, { startOffset: state.start, maxBytes: CHUNK_BYTES });
  // 파일이 바뀌었거나 읽지 못했다: 다음에 기록 끝에서부터 다시 잡는다.
  if (!range.cursor || !["complete_range", "corrupt_log", "partial_log", "scan_pending"].includes(range.code)) return unknown(range.code);
  const next: ClaudeSubagentCursor = { ...state, log: range.cursor, done: [...state.done], kinds: { ...state.kinds }, foreground: [...state.foreground], runs: state.runs };
  const gaps = gapsOf(range, state.log?.offset ?? state.start);
  range.records.forEach((record, i) => {
    // 망가진 줄(또는 4MiB 넘는 줄)을 건너뛴 자리: 그 줄에 띄움·끝이 있었을 수 있어 다음 턴 끝까지 estimated 다.
    if (gaps.before[i]) next.skipped = true;
    const entry = jsonObject(record.value);
    // 다른 세션의 줄이 섞였다: 지금까지의 근거를 버리고 이 세션의 다음 턴 끝까지 모른다(그 줄 뒤부터 이어 읽는다. 기록 끝을 다시 통째로 읽지 않는다).
    if (entry && !takeClaude(next, entry, query)) Object.assign(next, { snapshot: null, covered: false, open: false, launchedAgents: 0, doneAgents: 0, launchedWorkflows: 0, doneWorkflows: 0, done: [], foreground: [], conflict: true });
  });
  if (gaps.trailing) next.skipped = true;
  // 망가진 줄을 지났으면 다음 줄 머리부터 새로 이어 읽는다(그 줄은 한 번만 건너뛴다).
  if (range.cursor.invalid && !range.cursor.dropping) { next.log = null; next.start = range.cursor.offset; }
  // 기록 끝까지 따라잡는 중이다(한 관측 사이에 4MiB 넘게 덧붙었다). 읽은 데까지의 값을 estimated 로 내고 다음 관측이 이어 읽는다.
  const behind = range.code === "scan_pending";
  // 이 CLI 의 턴 끝을 아직 못 봤고 읽은 범위가 이 CLI 의 첫 줄까지 닿지도 않는다: 근거가 없다.
  if (!next.snapshot && next.covered !== true) return unknown(next.conflict ? "session_conflict" : "no_turn_end", next);
  const base = next.snapshot ?? { agents: 0, workflows: 0 };
  const agents = Math.max(0, base.agents + next.launchedAgents - next.doneAgents);
  const workflows = Math.max(0, base.workflows + next.launchedWorkflows - next.doneWorkflows);
  let workflowAgents = 0;
  if (workflows > 0) {
    // CLI 가 센 워크플로 수만큼, 가장 최근에 띄운 실행부터 본다. 실행 기록이 모자라면 남은 워크플로는 하나로 센다.
    const runs = pendingRuns(root, query, next).sort((a, b) => b.birth - a.birth).slice(0, workflows);
    workflowAgents = runs.reduce((sum, run) => sum + Math.max(1, run.running), 0) + (workflows - runs.length);
  }
  // 워크플로 안의 에이전트 수는 실행 기록에서 센 추정이다(끝 표시 없이 멈춘 에이전트가 남을 수 있다). CLI 자기 셈만 있을 때 exact.
  const changed = behind || next.open || next.skipped || next.launchedAgents > 0 || next.doneAgents > 0 || next.launchedWorkflows > 0 || next.doneWorkflows > 0 || next.foreground.length > 0 || workflows > 0;
  return { quality: changed ? "estimated" : "exact", count: agents + workflowAgents + next.foreground.length,
    code: behind ? "scan_pending" : next.open ? "turn_open" : workflows > 0 ? "workflow_journal" : next.snapshot ? "turn_end" : "no_turn_yet", cursor: next,
    detail: { agents, workflows, workflowAgents, foreground: next.foreground.length } };
}

// ───────── Codex ─────────

export interface CodexSubagentQuery {
  /** CODEX_HOME. 기록은 <home>/sessions/YYYY/MM/DD 아래에 있다(지역 날짜). */
  home: string;
  /** 부모(팀장) 세션 id. */
  sessionId: string;
  /** 이 CLI 프로세스를 띄운 시각(ms). 그 뒤에 쓰인 rollout 만 본다. */
  since: number;
  now: number;
}
interface CodexFile { identity: string; id: string | null; parent: string | null }
/** start: 이어 읽을 자리(줄 머리). skipped: 망가진 줄을 건너뛴 뒤 아직 일 사건(task_started·task_complete·turn_aborted)을 못 봤다(열림이 추정이다). */
interface CodexChild { cursor: JsonlCursor | null; start: number; open: boolean; ok: boolean; skipped: boolean }
export interface CodexSubagentState {
  key: string;
  /** 첫 줄을 읽어 가른 rollout(경로 → 세션 id·부모 id). 첫 줄은 바뀌지 않아 한 번만 읽는다. */
  files: Record<string, CodexFile>;
  /** since 앞에 마지막으로 쓰인 rollout(앞 프로세스의 것). 다시 보지 않는다. */
  old: Record<string, string>;
  children: Record<string, CodexChild>;
}
export interface CodexSubagentResult extends SubagentReading { state: CodexSubagentState | null }
/** 날짜 폴더를 거슬러 보는 상한(일). 그보다 오래 띄운 CLI 는 최근 폴더만 본다. */
const CODEX_MAX_DAYS = 8;

function dayDirs(root: string, since: number, now: number): string[] {
  const out: string[] = [];
  const day = 24 * 60 * 60 * 1000;
  const from = Math.max(since - 60 * 60 * 1000, now - CODEX_MAX_DAYS * day);
  for (let t = now; t >= from - day; t -= day) {
    const d = new Date(t);
    const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * rollout 첫 줄(session_meta)만 읽어 그 세션 id 와 부모 id 를 가른다. 파일 전체를 읽지 않는다(exec rollout 은 수십 MB 다).
 * 첫 줄이 아직 덜 쓰였으면 "pending"(다음에 다시), 읽을 수 없으면 null.
 */
function codexMeta(root: string, path: string): CodexFile | "pending" | null {
  const target = providerLogPath(root, path);
  if (!target) return null;
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const chunks: Buffer[] = [];
    let line: Buffer | null = null;
    for (let at = 0, total = 0; at < stat.size && total <= 4 * 1024 * 1024;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - at));
      const read = readSync(fd, buffer, 0, buffer.length, at);
      if (!read) break;
      const newline = buffer.subarray(0, read).indexOf(10);
      if (newline >= 0) { chunks.push(buffer.subarray(0, newline)); line = Buffer.concat(chunks); break; }
      chunks.push(buffer.subarray(0, read)); at += read; total += read;
    }
    if (!line) return stat.size > 4 * 1024 * 1024 ? { identity, id: null, parent: null } : "pending";
    let entry: Record<string, unknown> | null;
    try { entry = jsonObject(JSON.parse(line.toString("utf8"))); } catch { return { identity, id: null, parent: null }; }
    const payload = jsonObject(entry?.payload);
    if (entry?.type !== "session_meta" || !payload) return { identity, id: null, parent: null };
    const id = typeof payload.id === "string" ? payload.id : typeof payload.session_id === "string" ? payload.session_id : null;
    const spawn = jsonObject(jsonObject(jsonObject(payload.source)?.subagent)?.thread_spawn);
    return { identity, id, parent: typeof spawn?.parent_thread_id === "string" ? spawn.parent_thread_id : null };
  } catch { return null; }
  finally { closeSync(fd); }
}

/** 이 팀장(과 그 자식)이 띄운 Codex 서브에이전트 가운데 일이 열려 있는 것의 수. */
export function readCodexSubagents(query: CodexSubagentQuery, previous?: CodexSubagentState | null): CodexSubagentResult {
  const root = join(query.home, "sessions");
  const key = JSON.stringify([root, query.sessionId, query.since]);
  if (!Number.isFinite(query.since) || !query.sessionId) return { ...unknownReading("since_unknown"), state: null };
  const state: CodexSubagentState = previous && previous.key === key ? previous : { key, files: {}, old: {}, children: {} };
  let listed = false;
  for (const dir of dayDirs(root, query.since, query.now)) {
    let names: string[];
    try { names = readdirSync(dir); listed = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return { ...unknownReading("sessions_unreadable"), state }; }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      if (state.files[path] || state.old[path]) continue;
      let stat: ReturnType<typeof lstatSync>;
      try { stat = lstatSync(path); } catch { continue; }
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < query.since) { state.old[path] = `${stat.dev}:${stat.ino}`; continue; }
      const meta = codexMeta(root, path);
      if (meta && meta !== "pending") state.files[path] = meta;
    }
  }
  // 날짜 폴더가 하나도 없으면(아직 아무 rollout 도 없다) 자식도 없다.
  if (!listed) return { quality: "exact", count: 0, code: "no_sessions", state };
  // 이 팀장에서 이어지는 자식들(손자 포함).
  const family = new Set([query.sessionId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const file of Object.values(state.files)) if (file.parent && file.id && family.has(file.parent) && !family.has(file.id)) { family.add(file.id); grew = true; }
  }
  let open = 0, exact = true;
  for (const [path, file] of Object.entries(state.files)) {
    if (!file.parent || !family.has(file.parent) || file.id === query.sessionId) continue;
    const child = state.children[path] ??= { cursor: null, start: 0, open: false, ok: true, skipped: false };
    // 처음부터 읽을 때는 일의 열림도 처음부터 다시 정한다.
    if (!child.cursor && child.start === 0) child.open = false;
    const range = readJsonlRange(root, path, child.cursor, { startOffset: child.start, maxBytes: CHUNK_BYTES, fileIdentity: file.identity });
    if (!range.cursor || !["complete_range", "partial_log", "scan_pending", "corrupt_log"].includes(range.code)) {
      // 이번에는 앞에서 본 열림을 그대로 세고(estimated), 다음에는 처음부터 다시 읽는다.
      child.cursor = null; child.start = 0; child.ok = false; exact = false;
      if (child.open) open++;
      continue;
    }
    const gaps = gapsOf(range, child.cursor?.offset ?? child.start);
    child.cursor = range.cursor;
    range.records.forEach((record, i) => {
      // 망가진 줄(또는 4MiB 넘는 줄)을 건너뛴 자리: 그 줄이 일 사건이었을 수 있어 다음 일 사건까지 열림은 추정이다.
      if (gaps.before[i]) child.skipped = true;
      const entry = jsonObject(record.value), payload = jsonObject(entry?.payload);
      if (entry?.type !== "event_msg" || !payload) return;
      if (payload.type === "task_started") { child.open = true; child.skipped = false; }
      else if (payload.type === "task_complete" || payload.type === "turn_aborted") { child.open = false; child.skipped = false; }
    });
    if (gaps.trailing) child.skipped = true;
    // 망가진 줄을 지났으면 그 뒤 줄 머리부터 새로 이어 읽는다(처음부터 다시 읽지 않는다).
    if (range.cursor.invalid && !range.cursor.dropping) { child.cursor = null; child.start = range.cursor.offset; }
    child.ok = (range.code === "complete_range" || range.code === "partial_log" || (range.code === "corrupt_log" && !range.cursor.dropping)) && !child.skipped;
    if (!child.ok) exact = false;
    if (child.open) open++;
  }
  // 열린 자식은 끝 사건이 아직 없는 것이다. 끝 사건 없이 끝나는 길이 있을 수 있어(실측 못함) 그 수는 추정이다. 0 은 기록 그대로다.
  return { quality: exact && open === 0 ? "exact" : "estimated", count: open, code: "children", state };
}
