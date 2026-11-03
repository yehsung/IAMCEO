import type { Database, SQLQueryBindings } from "bun:sqlite";
import { homedir } from "node:os";
import type {
  ActivityKind,
  Activity,
  AnswerReq,
  Attachment,
  Backend,
  Decision,
  DecisionCloseKind,
  DecisionOption,
  DecisionStatus,
  Delivery,
  DeliveryKind,
  DeliveryStatus,
  Effort,
  FileDoc,
  FileKind,
  Member,
  MemberKind,
  MemberOrigin,
  MemberStatus,
  Message,
  MessageKind,
  Project,
  ProjectConnection,
  ProjectState,
  ProjectSummary,
  Rank,
  Settings,
  SettingsPatch,
  Todo,
  TodoOutcome,
  WorkItem,
  WorkSec,
  WsEvent,
} from "../shared/types.ts";
import { DEFAULT_RANKS, fileKindOf } from "../shared/types.ts";
import type { Bus } from "./bus.ts";
import { newId, nowIso } from "./db.ts";
import { MAX_PROJECT_NAME, MAX_ROLE, nameProblem, oneLineProblem, RESERVED_HANDLES, workerNameProblem } from "./text.ts";
import { conductorName } from "./text.ts";

/** status 가 그대로 HTTP 응답 코드가 되는 오류. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---- 입력 타입 ----
export interface NewProject {
  id?: string;
  name: string;
  cwd: string;
  runnerEnabled?: boolean;
  now?: string;
}
export type ProjectPatch = Partial<
  Pick<
    Project,
    "name" | "cwd" | "runnerEnabled" | "now" | "herdrTabId" | "archived"
  >
>;

export interface NewMember {
  projectId: string;
  handle: string;
  name: string;
  role?: string;
  kind: MemberKind;
  origin?: MemberOrigin;
  status?: MemberStatus;
  cwd?: string;
  sessionId?: string | null;
  paneId?: string | null;
  parallel?: boolean;
  backend?: Backend | null;
}
export type MemberPatch = Partial<
  Pick<
    Member,
    "name" | "role" | "origin" | "backend" | "modelOverride" | "effortOverride" | "status" | "now" | "next" | "cwd" | "sessionId" | "paneId" | "contextPct" | "subagents" | "parallel" | "lastError"
  >
>;

export interface AdoptedInfo { turnedOnRunner: boolean }

/** 지금 세션에 실제로 들어간 설정. 값이 달라지면 쉴 때 세션을 다시 연다. */
export interface AppliedConfig {
  model: string | null;
  effort: Effort | null;
  staffModel: string | null;
  staffEffort: Effort | null;
}

export interface NewDecision {
  projectId: string;
  memberId?: string | null;
  who: string;
  title: string;
  detail?: string;
  options?: DecisionOption[];
  rec?: string | null;
  group?: string | null;
  fileId?: string | null;
  images?: Attachment[];
}

export interface NewTodo {
  projectId: string;
  memberId?: string | null;
  who?: string;
  title: string;
  detail?: string;
}

export interface WorkInput {
  id?: string;
  projectId: string;
  sec: WorkSec;
  title: string;
  detail?: string;
  who?: string;
}

export interface NewMessage {
  id?: string;
  projectId: string;
  at?: string;
  mine?: boolean;
  memberId?: string | null;
  who?: string;
  kind: MessageKind;
  title?: string;
  body?: string;
  targetMemberId?: string | null;
  targetName?: string | null;
  decisionId?: string | null;
  fileId?: string | null;
  attachments?: Attachment[];
  delivery?: DeliveryStatus | null;
  deliveryNote?: string | null;
}

export interface NewFile {
  projectId: string;
  title: string;
  who?: string;
  memberId?: string | null;
  summary?: string;
  body?: string;
  path?: string | null;
  attachments?: Attachment[];
  kind?: FileKind;
  /** kind=artifact 의 원본. 화면 상태에 싣지 않는다. */
  html?: string | null;
}

export interface NewDelivery {
  projectId: string;
  memberId: string;
  kind: DeliveryKind;
  text: string;
  wake?: boolean;
  urgent?: boolean;
  status?: Extract<DeliveryStatus, "queued" | "held">;
  holdReason?: string | null;
  refType?: Delivery["refType"];
  refId?: string | null;
}

export interface DeliveryUpdate {
  holdReason?: string | null;
  lastError?: string | null;
  /** 시도 횟수를 하나 올린다. */
  attempt?: boolean;
}

/** 가져온 프로젝트의 못 읽은 말에 붙는 표시. 재시작 정리가 이 말을 실패로 바꾸지 않게 가른다. */
export const IMPORT_HOLD_NOTE = "총괄을 시작하면 전달됩니다";

export const DEFAULT_SETTINGS: Settings = {
  backend: null,
  permissionMode: "bypassPermissions",
  ranks: DEFAULT_RANKS,
  maxConcurrentTurns: 4,
  compactAtPct: 70,
  maxAwakeWorkers: 8,
  notifyMac: false,
  boardTidyHours: 6,
};

type TimeField = "createdAt" | "updatedAt" | "answeredAt" | "deliveredAt" | "doneAt";
const RESTORABLE_TIMES = {
  decisions: { createdAt: "created_at", answeredAt: "answered_at", deliveredAt: "delivered_at" },
  todos: { createdAt: "created_at", doneAt: "done_at" },
  work: { createdAt: "created_at", updatedAt: "updated_at", doneAt: "done_at" },
  files: { createdAt: "created_at" },
} as const;

const HANDLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const MAX_ACTIVITY_PER_MEMBER = 500;
// 도구 결과 하나가 수 MB 일 수 있다. 활동 판은 훑어보는 용도라 잘라도 된다.
const MAX_ACTIVITY_TEXT = 4000;
const MEMBER_SELECT = `SELECT m.*, (SELECT COUNT(*) FROM deliveries d WHERE d.member_id = m.id AND d.status IN ('queued','held')) AS queued_count FROM members m`;

// SQL 행은 컬럼 이름이 곧 스키마(db.ts)다. 아래 toX 함수가 타입 경계다.
type Row = Record<string, any>;

function json<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export function attachmentUrl(id: string, name: string): string {
  return `/files/${id}/${encodeURIComponent(name)}`;
}

function toProject(r: Row, connection: ProjectConnection): Project {
  return {
    id: r.id,
    name: r.name,
    isHq: !!r.is_hq,
    cwd: r.cwd,
    runnerEnabled: !!r.runner_enabled,
    now: r.now,
    nowAt: r.now_at,
    herdrTabId: r.herdr_tab_id,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    connection,
    tidiedAt: r.board_tidied_at ?? null,
  };
}

function appliedOf(r: Row): AppliedConfig | null {
  return r.applied_config ? json<AppliedConfig>(r.applied_config) : null;
}

// token 은 일부러 옮기지 않는다: Member 는 화면까지 나간다.
function toMember(r: Row): Member {
  return {
    id: r.id,
    projectId: r.project_id,
    handle: r.handle,
    name: r.name,
    role: r.role,
    kind: r.kind,
    origin: r.origin,
    wasAdopted: r.adopted_info != null,
    cli: r.cli,
    backend: r.backend ?? null,
    modelOverride: r.model_override ?? null,
    effortOverride: r.effort_override ?? null,
    appliedModel: appliedOf(r)?.model ?? null,
    appliedEffort: appliedOf(r)?.effort ?? null,
    status: r.status,
    now: r.now,
    next: r.next,
    cwd: r.cwd,
    sessionId: r.session_id,
    paneId: r.pane_id,
    contextPct: r.context_pct,
    subagents: r.subagents,
    parallel: !!r.parallel,
    queuedCount: r.queued_count,
    lastError: r.last_error,
    updatedAt: r.updated_at,
    createdAt: r.created_at,
  };
}

function toDecision(r: Row): Decision {
  return {
    id: r.id,
    projectId: r.project_id,
    memberId: r.member_id,
    who: r.who,
    title: r.title,
    detail: r.detail,
    options: json(r.options),
    rec: r.rec,
    group: r.grp,
    fileId: r.file_id,
    images: json(r.images),
    status: r.status,
    choice: r.choice,
    note: r.note,
    batch: !!r.batch,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
    deliveredAt: r.delivered_at,
    updatedAt: r.updated_at ?? r.created_at,
    lastChoice: r.last_choice ?? null,
    lastNote: r.last_note ?? null,
    reopenNote: r.reopen_note ?? null,
    closeKind: r.close_kind ?? null,
    closeReason: r.close_reason ?? null,
    closeQuote: r.close_quote ?? null,
    closedBy: r.closed_by ?? null,
    closedAt: r.closed_at ?? null,
  };
}

function toTodo(r: Row): Todo {
  return {
    id: r.id,
    projectId: r.project_id,
    memberId: r.member_id,
    who: r.who,
    title: r.title,
    detail: r.detail,
    done: !!r.done,
    doneAt: r.done_at,
    createdAt: r.created_at,
    outcome: r.outcome ?? (r.done ? "done" : null),
    closeReason: r.close_reason ?? null,
    closedBy: r.closed_by ?? null,
  };
}

function toWork(r: Row): WorkItem {
  return {
    id: r.id,
    projectId: r.project_id,
    sec: r.sec,
    title: r.title,
    detail: r.detail,
    who: r.who,
    order: r.sort_order,
    doneAt: r.done_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMessage(r: Row): Message {
  return {
    id: r.id,
    projectId: r.project_id,
    at: r.at,
    mine: !!r.mine,
    memberId: r.member_id,
    who: r.who,
    kind: r.kind,
    title: r.title,
    body: r.body,
    targetMemberId: r.target_member_id,
    targetName: r.target_name,
    decisionId: r.decision_id,
    fileId: r.file_id,
    attachments: json(r.attachments),
    delivery: r.delivery,
    deliveryNote: r.delivery_note,
  };
}

/** 예전 자료에는 kind 가 없다. 첨부와 본문으로 정한다. */
function deriveFileKind(body: string, attachments: { name: string; mime: string }[]): FileKind {
  const first = attachments[0];
  if (!first) return body ? "document" : "file";
  const kinds = attachments.map((a) => fileKindOf(a.name, a.mime));
  // 글에 그림을 곁들인 자료는 글이 주인이다.
  if (body && kinds.every((k) => k === "image")) return "document";
  return kinds[0]!;
}

function toFile(r: Row): FileDoc {
  const attachments = json<Attachment[]>(r.attachments);
  return {
    id: r.id,
    kind: r.kind ?? deriveFileKind(r.body, attachments),
    projectId: r.project_id,
    title: r.title,
    who: r.who,
    memberId: r.member_id,
    summary: r.summary,
    body: r.body,
    path: r.path,
    attachments,
    createdAt: r.created_at,
    order: r.sort_order,
  };
}

function toAttachment(r: Row): Attachment {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    url: attachmentUrl(r.id, r.name),
    path: r.path,
    isImage: String(r.mime).startsWith("image/"),
  };
}

function toDelivery(r: Row): Delivery {
  return {
    id: r.id,
    projectId: r.project_id,
    memberId: r.member_id,
    kind: r.kind,
    text: r.text,
    wake: !!r.wake,
    urgent: !!r.urgent,
    status: r.status,
    holdReason: r.hold_reason,
    refType: r.ref_type,
    refId: r.ref_id,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  };
}

function toActivity(r: Row): Activity {
  return { id: r.id, memberId: r.member_id, at: r.at, kind: r.kind, text: r.text };
}

function buildSet(patch: Record<string, unknown>, columns: Record<string, string>): { set: string[]; values: SQLQueryBindings[] } {
  const set: string[] = [];
  const values: SQLQueryBindings[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key];
    if (!column || value === undefined) continue;
    set.push(`${column} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as SQLQueryBindings));
  }
  return { set, values };
}

const PROJECT_COLUMNS: Record<keyof ProjectPatch, string> = {
  name: "name",
  cwd: "cwd",
  runnerEnabled: "runner_enabled",
  now: "now",
  herdrTabId: "herdr_tab_id",
  archived: "archived",
};

const MEMBER_COLUMNS: Record<keyof MemberPatch, string> = {
  name: "name",
  role: "role",
  origin: "origin",
  backend: "backend",
  modelOverride: "model_override",
  effortOverride: "effort_override",
  status: "status",
  now: "now",
  next: "next",
  cwd: "cwd",
  sessionId: "session_id",
  paneId: "pane_id",
  contextPct: "context_pct",
  subagents: "subagents",
  parallel: "parallel",
  lastError: "last_error",
};

function checkMemberText(name: string | undefined, role: string | undefined, kind: MemberKind): void {
  // 총괄·본사 AI 의 이름은 서버가 정한다. 직원만 대표·총괄처럼 보이는 이름을 못 쓴다.
  const problem = (name !== undefined && (kind === "worker" ? workerNameProblem(name) : nameProblem(name))) || null;
  if (problem) throw new ApiError(400, `이름이 잘못되었습니다: ${problem}`);
  const roleProblem = role !== undefined ? oneLineProblem(role, MAX_ROLE) : null;
  if (roleProblem) throw new ApiError(400, `역할이 잘못되었습니다: ${roleProblem}`);
}

function checkProjectName(name: string | undefined): void {
  const problem = name !== undefined ? oneLineProblem(name, MAX_PROJECT_NAME) : null;
  if (problem) throw new ApiError(400, `프로젝트 이름이 잘못되었습니다: ${problem}`);
}

/** 실행기가 지금 쓸 수 있는가. 모르면(아직 안 물어봄) 쓸 수 있는 것으로 친다. */
export interface RunnerHealth {
  ok: boolean;
  detail?: string | null;
}

export class Store {
  private lastMessageMs = 0;
  private runnerHealth = new Map<Backend, RunnerHealth>();
  private lastConnections = new Map<string, string>();

  constructor(
    readonly db: Database,
    private readonly bus: Bus,
  ) {
    this.ensureHq();
  }

  private ensureHq(): void {
    if (this.getProject("hq")) return;
    this.createProject({ id: "hq", name: "본사", cwd: homedir(), runnerEnabled: true });
  }

  private row(sql: string, ...params: SQLQueryBindings[]): Row | null {
    return this.db.query<Row, SQLQueryBindings[]>(sql).get(...params);
  }

  private rows(sql: string, ...params: SQLQueryBindings[]): Row[] {
    return this.db.query<Row, SQLQueryBindings[]>(sql).all(...params);
  }

  private run(sql: string, ...params: SQLQueryBindings[]): void {
    this.db.query<Row, SQLQueryBindings[]>(sql).run(...params);
  }

  private emitProjects(): void {
    this.bus.emit({ type: "projects", projects: this.projectSummaries() });
    // 연결 상태는 설정·실행기·직접 띄운 세션에 따라 저절로 바뀐다. 여는 화면이 보던 Project 도 고쳐 준다.
    for (const r of this.rows("SELECT * FROM projects")) {
      const project = this.projectFrom(r);
      const key = JSON.stringify(project.connection);
      const before = this.lastConnections.get(project.id);
      this.lastConnections.set(project.id, key);
      if (before !== undefined && before !== key) this.bus.emit({ type: "project", project });
    }
  }

  // ---- 연결 ----
  /** 전역 실행 방식. 첫 실행 선택 전에는 headless 로 친다. */
  effectiveBackend(): Backend {
    return this.getSettings().backend ?? "headless";
  }

  /** 실행기 상태를 적는다. 달라졌으면 화면에 알리고 true. */
  setRunnerHealth(backend: Backend, health: RunnerHealth): boolean {
    const before = this.runnerHealth.get(backend);
    this.runnerHealth.set(backend, health);
    if ((before?.ok ?? true) === health.ok && (before?.detail ?? null) === (health.detail ?? null)) return false;
    this.emitProjects();
    return true;
  }

  private hasLiveManual(projectId: string): boolean {
    return this.row("SELECT 1 FROM members WHERE project_id = ? AND origin = 'manual' AND status NOT IN ('offline','asleep','error') LIMIT 1", projectId) !== null;
  }

  private runnerUsable(runnerEnabled: boolean): boolean {
    return runnerEnabled && (this.runnerHealth.get(this.effectiveBackend())?.ok ?? true);
  }

  private connectionOf(id: string, runnerEnabled: boolean, archived: boolean): ProjectConnection {
    if (archived) return { ok: false, reason: "archived", detail: "보관된 프로젝트입니다. 보관함에서 꺼내면 쓸 수 있습니다" };
    if (this.runnerUsable(runnerEnabled) || this.hasLiveManual(id)) return { ok: true, reason: null, detail: null };
    if (!runnerEnabled) return { ok: false, reason: "runner_off", detail: "AI가 아직 연결되지 않았습니다. 총괄을 시작하거나 기존 세션을 편입하세요" };
    const backend = this.effectiveBackend();
    const health = this.runnerHealth.get(backend);
    return { ok: false, reason: "backend_down", detail: `${backend === "herdr" ? "herdr" : "claude"}에 연결할 수 없습니다. 연결되면 쓸 수 있습니다${health?.detail ? ` (${health.detail})` : ""}` };
  }

  private projectFrom(r: Row): Project {
    return toProject(r, this.connectionOf(r.id, !!r.runner_enabled, !!r.archived));
  }

  /**
   * 대표의 말·답을 지금 받을 수 있는지 본다. 없으면 409. 받는 쪽이 직접 띄운 세션이면 그 세션만 살아 있으면 되고,
   * 그 밖에는 실행기가 돌아야 한다(직접 띄운 세션이 살아 있어도 총괄에게 갈 말은 갈 곳이 없다).
   */
  requireReachable(projectId: string, target: Member | null): void {
    const project = this.requireProject(projectId);
    if (!project.connection.ok) throw new ApiError(409, project.connection.detail ?? "연결되어야 쓸 수 있습니다");
    if (this.runnerUsable(project.runnerEnabled)) return;
    if (target?.origin === "manual" && !["offline", "asleep", "error"].includes(target.status)) return;
    throw new ApiError(409, "실행기가 연결되지 않아 직접 띄운 세션에게만 보낼 수 있습니다. 받을 세션을 @로 골라 주세요");
  }

  /**
   * 시작할 때마다 도는 정리(멱등). 연결 전에 쌓인 말·결재 답을 돌려준다: 결재는 직전 답을 카드에 남기고 다시 열고, 대표 글은 실패로 표시해 다시 보낼 수 있게 한다.
   * 실행이 꺼진 뒤 대기 중이던 답도 이 길로 온다. 가져온 못 읽은 말(IMPORT_HOLD_NOTE)은 총괄을 시작하면 전달하기로 약속했으므로 건드리지 않는다. 돌려준 건수를 돌려준다.
   */
  releaseHeldBeforeConnection(): { messages: number; decisions: number } {
    const note = "연결 전이라 전달되지 않았습니다";
    const reopenNote = "연결 전이라 전달되지 않았습니다. 다시 결정해 주세요";
    const out = { messages: 0, decisions: 0 };
    const held = this.rows("SELECT * FROM deliveries WHERE status = 'held' AND hold_reason = 'runner_disabled' ORDER BY rowid").map(toDelivery);
    const released: string[] = [];
    for (const d of held) {
      if (d.refType === "decision" && d.refId) {
        const decisionId = d.refId;
        // 지우고 다시 여는 사이에 죽으면 답도 전달도 사라진다. 한 번에 한다.
        this.db.transaction(() => {
          this.run("DELETE FROM deliveries WHERE id = ?", d.id);
          if (this.getDecision(decisionId)?.status === "answered") {
            this.reopenDecision(decisionId, reopenNote);
            out.decisions++;
          }
        })();
        released.push(decisionId);
        this.emitMember(d.memberId);
      } else if (d.refType === "message" && d.refId) {
        this.run("DELETE FROM deliveries WHERE id = ?", d.id);
        released.push(d.refId);
        this.setMessageDelivery(d.refId, "failed", note);
        out.messages++;
        this.emitMember(d.memberId);
      }
    }
    // 총괄에게 묶어 둔 '대표가 답했습니다' 알림은 되돌린 답을 가리키므로 함께 거둔다.
    for (const d of held) {
      if (d.kind === "system" && released.some((id) => d.text.includes(id))) {
        this.run("DELETE FROM deliveries WHERE id = ?", d.id);
        this.emitMember(d.memberId);
      }
    }
    // 총괄이 없어 전달 항목 없이 보류된 말과, 받을 사람이 없어 멈춘 답.
    for (const p of this.rows("SELECT id FROM projects WHERE runner_enabled = 0")) {
      const linked = new Set(this.rows("SELECT ref_id FROM deliveries WHERE project_id = ? AND status IN ('queued','held','delivering')", p.id).map((r) => r.ref_id));
      for (const r of this.rows("SELECT id FROM messages WHERE project_id = ? AND mine = 1 AND delivery IN ('held','queued') AND target_member_id IS NULL AND COALESCE(delivery_note, '') != ?", p.id, IMPORT_HOLD_NOTE)) {
        if (linked.has(r.id)) continue;
        this.setMessageDelivery(r.id, "failed", note);
        out.messages++;
      }
      for (const d of this.listAnsweredDecisions(p.id)) {
        if (linked.has(d.id) || (d.memberId && this.getMember(d.memberId))) continue;
        this.reopenDecision(d.id, reopenNote);
        out.decisions++;
      }
    }
    return out;
  }

  // ---- 프로젝트 ----
  getProject(id: string): Project | null {
    const r = this.row("SELECT * FROM projects WHERE id = ?", id);
    return r ? this.projectFrom(r) : null;
  }

  requireProject(id: string): Project {
    const p = this.getProject(id);
    if (!p) throw new ApiError(404, "프로젝트를 찾을 수 없습니다");
    return p;
  }

  listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
    const where = opts.includeArchived ? "" : "WHERE archived = 0";
    return this.rows(`SELECT * FROM projects ${where} ORDER BY is_hq DESC, created_at, rowid`).map((r) => this.projectFrom(r));
  }

  createProject(input: NewProject): Project {
    checkProjectName(input.name);
    const at = nowIso();
    const id = input.id ?? newId("p_");
    const now = input.now ?? "";
    this.run(
      `INSERT INTO projects (id, name, is_hq, cwd, runner_enabled, now, now_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      id === "hq" ? 1 : 0,
      input.cwd,
      (input.runnerEnabled ?? true) ? 1 : 0,
      now,
      now ? at : null,
      at,
      at,
    );
    const project = this.requireProject(id);
    this.bus.emit({ type: "project", project });
    this.emitProjects();
    return project;
  }

  patchProject(id: string, patch: ProjectPatch): Project {
    checkProjectName(patch.name);
    const before = this.requireProject(id);
    const { set, values } = buildSet(patch, PROJECT_COLUMNS);
    if (set.length === 0) return before;
    const at = nowIso();
    set.push("updated_at = ?");
    values.push(at);
    if (patch.now !== undefined && patch.now !== before.now) {
      set.push("now_at = ?");
      values.push(at);
    }
    this.run(`UPDATE projects SET ${set.join(", ")} WHERE id = ?`, ...values, id);
    const project = this.requireProject(id);
    if (patch.name !== undefined && patch.name !== before.name) {
      const lead = this.getConductor(id);
      if (lead && lead.name === conductorName(before.name)) this.patchMember(lead.id, { name: conductorName(project.name) });
    }
    this.bus.emit({ type: "project", project });
    this.emitProjects();
    return project;
  }

  /** 실행을 켠 것이 편입인가. 맞으면 대표가 시키지 않은 총괄을 띄우지 않고, 남은 세션이 없을 때 실행을 끈다. */
  runnerByAdopt(id: string): boolean {
    return !!this.row("SELECT runner_by_adopt FROM projects WHERE id = ?", id)?.runner_by_adopt;
  }

  setRunnerByAdopt(id: string, on: boolean): void {
    this.run("UPDATE projects SET runner_by_adopt = ? WHERE id = ?", on ? 1 : 0, id);
  }

  projectSummaries(): ProjectSummary[] {
    return this.rows(
      `SELECT p.id, p.name, p.is_hq, p.cwd, p.now, p.runner_enabled, p.archived,
         (SELECT COUNT(*) FROM decisions d WHERE d.project_id = p.id AND d.status = 'open') AS decision_count,
         (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id AND t.done = 0) AS todo_count,
         (SELECT COUNT(*) FROM members m WHERE m.project_id = p.id AND m.status = 'working') AS working_count,
         (SELECT COUNT(*) FROM members m WHERE m.project_id = p.id AND m.status = 'blocked') AS blocked_count,
         (SELECT COUNT(*) FROM members m WHERE m.project_id = p.id AND m.status = 'error') AS error_count,
         (SELECT COUNT(*) FROM members m WHERE m.project_id = p.id) AS member_count
       FROM projects p WHERE p.archived = 0 ORDER BY p.is_hq DESC, p.created_at, p.rowid`,
    ).map((r) => ({
      id: r.id,
      name: r.name,
      isHq: !!r.is_hq,
      cwd: r.cwd,
      now: r.now,
      runnerEnabled: !!r.runner_enabled,
      connection: this.connectionOf(r.id, !!r.runner_enabled, !!r.archived),
      decisionCount: r.decision_count,
      todoCount: r.todo_count,
      inboxCount: r.decision_count + r.todo_count,
      workingCount: r.working_count,
      blockedCount: r.blocked_count,
      errorCount: r.error_count,
      memberCount: r.member_count,
    }));
  }

  projectState(id: string): ProjectState {
    const project = this.requireProject(id);
    return {
      project,
      members: this.listMembers(id),
      decisions: this.listDecisions(id),
      doneDecisionCount: this.row("SELECT COUNT(*) AS n FROM decisions WHERE project_id = ? AND status != 'open'", id)!.n as number,
      todos: this.listTodos(id),
      work: this.listWork(id),
      messages: this.listMessages(id, { limit: 200 }),
      files: this.listFiles(id),
    };
  }

  // ---- 직원 ----
  getMember(id: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.id = ?`, id);
    return r ? toMember(r) : null;
  }

  requireMember(id: string): Member {
    const m = this.getMember(id);
    if (!m) throw new ApiError(404, "직원을 찾을 수 없습니다");
    return m;
  }

  /** MCP 인증용. 없으면 null. */
  getMemberByToken(token: string): Member | null {
    if (!token) return null;
    const r = this.row(`${MEMBER_SELECT} WHERE m.token = ?`, token);
    return r ? toMember(r) : null;
  }

  /** MCP 설정 파일을 쓸 때만 쓴다. 화면으로 보내지 않는다. */
  getMemberToken(id: string): string {
    const r = this.row("SELECT token FROM members WHERE id = ?", id);
    if (!r) throw new ApiError(404, "직원을 찾을 수 없습니다");
    return r.token;
  }

  listMembers(projectId: string): Member[] {
    return this.rows(`${MEMBER_SELECT} WHERE m.project_id = ? ORDER BY m.created_at, m.rowid`, projectId).map(toMember);
  }

  listAllMembers(): Member[] {
    return this.rows(`${MEMBER_SELECT} ORDER BY m.created_at, m.rowid`).map(toMember);
  }

  getMemberByHandle(projectId: string, handle: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.project_id = ? AND m.handle = ?`, projectId, handle);
    return r ? toMember(r) : null;
  }

  /** 핸들 또는 화면 이름으로 찾는다. 같은 프로젝트 안에서만. */
  findMember(projectId: string, handleOrName: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.project_id = ? AND (m.handle = ? OR m.name = ?) ORDER BY m.handle = ? DESC`, projectId, handleOrName, handleOrName, handleOrName);
    return r ? toMember(r) : null;
  }

  /** 프로젝트의 총괄(본사는 root). */
  getConductor(projectId: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.project_id = ? AND m.kind IN ('root','conductor') ORDER BY m.created_at LIMIT 1`, projectId);
    return r ? toMember(r) : null;
  }

  getMemberBySession(sessionId: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.session_id = ?`, sessionId);
    return r ? toMember(r) : null;
  }

  getMemberByPane(paneId: string): Member | null {
    const r = this.row(`${MEMBER_SELECT} WHERE m.pane_id = ?`, paneId);
    return r ? toMember(r) : null;
  }

  createMember(input: NewMember): Member {
    const project = this.requireProject(input.projectId);
    checkMemberText(input.name, input.role, input.kind);
    if (input.kind === "worker" && RESERVED_HANDLES.has(input.handle)) throw new ApiError(400, `총괄 자리의 핸들이라 직원에게 쓸 수 없습니다: ${input.handle}`);
    if (!HANDLE_RE.test(input.handle)) throw new ApiError(400, "핸들은 영문 소문자로 시작하고 영문 소문자·숫자·_·- 만 쓸 수 있습니다(32자 이내)");
    if (this.getMemberByHandle(input.projectId, input.handle)) throw new ApiError(409, `이미 있는 핸들입니다: ${input.handle}`);
    if (this.row("SELECT 1 FROM members WHERE project_id = ? AND name = ?", input.projectId, input.name)) {
      throw new ApiError(409, `이미 있는 이름입니다: ${input.name}`);
    }
    const id = newId("m_");
    const at = nowIso();
    this.run(
      `INSERT INTO members (id, project_id, handle, name, role, kind, origin, backend, status, cwd, session_id, pane_id, parallel, token, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.projectId,
      input.handle,
      input.name,
      input.role ?? "",
      input.kind,
      input.origin ?? "runner",
      input.backend ?? null,
      input.status ?? "idle",
      input.cwd ?? project.cwd,
      input.sessionId ?? null,
      input.paneId ?? null,
      input.parallel ? 1 : 0,
      `tk_${newId("")}${newId("")}`,
      at,
      at,
    );
    const member = this.requireMember(id);
    this.bus.emit({ type: "member", member });
    this.emitProjects();
    return member;
  }

  patchMember(id: string, patch: MemberPatch): Member {
    const before = this.requireMember(id);
    checkMemberText(patch.name, patch.role, before.kind);
    const { set, values } = buildSet(patch, MEMBER_COLUMNS);
    if (set.length === 0) return before;
    set.push("updated_at = ?");
    values.push(nowIso());
    this.run(`UPDATE members SET ${set.join(", ")} WHERE id = ?`, ...values, id);
    const member = this.requireMember(id);
    this.bus.emit({ type: "member", member });
    if (member.status !== before.status) this.emitProjects();
    return member;
  }

  getAppliedConfig(id: string): AppliedConfig | null {
    const r = this.row("SELECT applied_config FROM members WHERE id = ?", id);
    return r ? appliedOf(r) : null;
  }

  /** 세션에 실제로 들어간 설정을 적는다. 잦지 않고, 바뀌었을 때만 화면에 알린다. */
  /** 비어 있는 직급 effort 를 채운다. 비어 있으면 세션을 다시 열 때 CLI 기본값(medium)으로 돌아간다. */
  fillRankEfforts(fallback: Effort): void {
    const { ranks } = this.getSettings();
    const missing = (Object.keys(ranks) as Rank[]).filter((r) => !ranks[r].effort);
    if (missing.length === 0) return;
    this.patchSettings({ ranks: Object.fromEntries(missing.map((r) => [r, { effort: fallback }])) });
  }

  setAppliedConfig(id: string, config: AppliedConfig | null): void {
    const value = config ? JSON.stringify(config) : null;
    if ((this.row("SELECT applied_config FROM members WHERE id = ?", id)?.applied_config ?? null) === value) return;
    this.run("UPDATE members SET applied_config = ? WHERE id = ?", value, id);
    this.emitMember(id);
  }

  /** 편입 표시. turnedOnRunner: 이 편입이 프로젝트 실행을 켰다(해제할 때 되돌린다). */
  setAdoptedInfo(id: string, info: AdoptedInfo | null): void {
    this.run("UPDATE members SET adopted_info = ? WHERE id = ?", info ? JSON.stringify(info) : null, id);
    this.emitMember(id);
  }

  getAdoptedInfo(id: string): AdoptedInfo | null {
    const raw = this.row("SELECT adopted_info FROM members WHERE id = ?", id)?.adopted_info;
    return raw ? json<AdoptedInfo>(raw) : null;
  }

  /** 도구 호출 때 updatedAt 만 갱신한다. 잦아서 방송하지 않는다. */
  touchMember(id: string): void {
    this.run("UPDATE members SET updated_at = ? WHERE id = ?", nowIso(), id);
  }

  /** 그 직원의 전달·활동도 함께 사라진다(CASCADE). 대화·결재 기록은 남는다. */
  removeMember(id: string): void {
    const member = this.requireMember(id);
    this.run("DELETE FROM members WHERE id = ?", id);
    this.bus.emit({ type: "member_removed", projectId: member.projectId, memberId: id });
    this.emitProjects();
  }

  // ---- 결재 ----
  getDecision(id: string): Decision | null {
    const r = this.row("SELECT * FROM decisions WHERE id = ?", id);
    return r ? toDecision(r) : null;
  }

  requireDecision(id: string): Decision {
    const d = this.getDecision(id);
    if (!d) throw new ApiError(404, "결재를 찾을 수 없습니다");
    return d;
  }

  /** 열린 것 전부(오래된 순) + 처리된 것 최근 50(최근 순). */
  listDecisions(projectId: string): Decision[] {
    const open = this.rows("SELECT * FROM decisions WHERE project_id = ? AND status = 'open' ORDER BY created_at, rowid", projectId);
    const done = this.rows(
      "SELECT * FROM decisions WHERE project_id = ? AND status != 'open' ORDER BY COALESCE(answered_at, created_at) DESC, rowid DESC LIMIT 50",
      projectId,
    );
    return [...open, ...done].map(toDecision);
  }

  listOpenDecisions(projectId: string): Decision[] {
    return this.rows("SELECT * FROM decisions WHERE project_id = ? AND status = 'open' ORDER BY created_at, rowid", projectId).map(toDecision);
  }

  /** 처리된 결재를 이어 받는다. before 는 그보다 앞서 답한 것만. */
  listDoneDecisions(projectId: string, opts: { before?: string; limit?: number } = {}): Decision[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const when = "COALESCE(answered_at, created_at)";
    const rows = opts.before
      ? this.rows(`SELECT * FROM decisions WHERE project_id = ? AND status != 'open' AND ${when} < ? ORDER BY ${when} DESC, rowid DESC LIMIT ?`, projectId, opts.before, limit)
      : this.rows(`SELECT * FROM decisions WHERE project_id = ? AND status != 'open' ORDER BY ${when} DESC, rowid DESC LIMIT ?`, projectId, limit);
    return rows.map(toDecision);
  }

  /** 대표가 답한 결재 전부. 승인 근거 대조는 화면용 50건 제한을 받지 않는다. */
  listAllDoneDecisions(projectId: string): Decision[] {
    return this.rows("SELECT * FROM decisions WHERE project_id = ? AND status != 'open' ORDER BY COALESCE(answered_at, created_at) DESC, rowid DESC", projectId).map(toDecision);
  }

  /** 앞 판보다 반드시 큰 시각. 같은 ms 안의 전이도 화면이 순서를 가른다. */
  private nextDecisionStamp(id: string): string {
    const before = this.row("SELECT updated_at FROM decisions WHERE id = ?", id)?.updated_at as string | null | undefined;
    const prev = before ? Date.parse(before) : 0;
    return new Date(Math.max(Date.now(), prev + 1)).toISOString();
  }

  listOpenDecisionsByMember(memberId: string): Decision[] {
    return this.rows("SELECT * FROM decisions WHERE member_id = ? AND status = 'open' ORDER BY created_at, rowid", memberId).map(toDecision);
  }

  createDecision(input: NewDecision): Decision {
    this.requireProject(input.projectId);
    const id = newId("d_");
    this.run(
      `INSERT INTO decisions (id, project_id, member_id, who, title, detail, options, rec, grp, file_id, images, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      id,
      input.projectId,
      input.memberId ?? null,
      input.who,
      input.title,
      input.detail ?? "",
      JSON.stringify(input.options ?? []),
      input.rec ?? null,
      input.group ?? null,
      input.fileId ?? null,
      JSON.stringify(input.images ?? []),
      nowIso(),
      nowIso(),
    );
    const decision = this.requireDecision(id);
    this.bus.emit({ type: "decision", decision });
    this.emitProjects();
    return decision;
  }

  private normalizeAnswer(d: Decision, req: AnswerReq): { choice: string | null; note: string | null; batch: boolean } {
    const batch = !!req.batch;
    const choice = req.choice?.trim() || (batch ? d.rec : null);
    const note = req.note?.trim() || null;
    if (!choice && !note) throw new ApiError(400, "선택지나 메모가 필요합니다");
    if (choice && !d.options.some((o) => o.k === choice)) throw new ApiError(400, `없는 선택지입니다: ${choice}`);
    return { choice, note, batch };
  }

  /**
   * 기록 없이 답을 검사한다. 이미 답한 카드에 같은 답이면 그 카드를 돌려주고,
   * 아직 열려 있으면 null, 다른 답이면 409.
   */
  checkAnswer(id: string, req: AnswerReq): Decision | null {
    const d = this.requireDecision(id);
    const a = this.normalizeAnswer(d, req);
    if (d.status === "open") return null;
    if (d.choice === a.choice && d.note === a.note && d.batch === a.batch) return d;
    throw new ApiError(409, "이미 처리한 결재입니다");
  }

  /** 멱등: changed=false 면 같은 답이 이미 기록되어 있어 아무것도 안 했다. 다른 답이면 409. */
  answerDecision(id: string, req: AnswerReq): { decision: Decision; changed: boolean } {
    const existing = this.checkAnswer(id, req);
    if (existing) return { decision: existing, changed: false };
    const a = this.normalizeAnswer(this.requireDecision(id), req);
    this.run(
      "UPDATE decisions SET status = 'answered', choice = ?, note = ?, batch = ?, answered_at = ?, updated_at = ?, last_choice = NULL, last_note = NULL, reopen_note = NULL WHERE id = ?",
      a.choice,
      a.note,
      a.batch ? 1 : 0,
      nowIso(),
      this.nextDecisionStamp(id),
      id,
    );
    const decision = this.requireDecision(id);
    this.bus.emit({ type: "decision", decision });
    this.emitProjects();
    return { decision, changed: true };
  }

  /** 전달됨·닫힘으로 옮기거나, 전달이 실패하면 answered 로 되돌린다. 닫으면 inbox 에서 빠진다. */
  setDecisionStatus(id: string, status: Extract<DecisionStatus, "answered" | "delivered" | "closed">): Decision {
    this.requireDecision(id);
    const stamp = this.nextDecisionStamp(id);
    if (status === "delivered") {
      this.run("UPDATE decisions SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE id = ?", nowIso(), stamp, id);
    } else if (status === "answered") {
      this.run("UPDATE decisions SET status = 'answered', delivered_at = NULL, updated_at = ? WHERE id = ?", stamp, id);
    } else {
      this.run("UPDATE decisions SET status = 'closed', updated_at = ? WHERE id = ?", stamp, id);
    }
    const decision = this.requireDecision(id);
    this.bus.emit({ type: "decision", decision });
    this.emitProjects();
    return decision;
  }

  /**
   * 열린 결재를 이유와 함께 닫는다. kind 가 있으면 AI 가 ask_close 로 닫은 것이라 대표가 다시 열 수 있다.
   * 열려 있지 않으면 409(대표가 이미 답했거나 닫혔다). 닫힌 카드는 결재된 항목으로 간다.
   */
  closeDecision(id: string, input: { kind: DecisionCloseKind | null; reason: string; by: string; quote?: string | null }): Decision {
    const before = this.requireDecision(id);
    if (before.status !== "open") throw new ApiError(409, before.status === "closed" ? "이미 닫힌 결재입니다" : "대표가 이미 답한 결재입니다");
    const at = nowIso();
    this.run(
      "UPDATE decisions SET status = 'closed', close_kind = ?, close_reason = ?, close_quote = ?, closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
      input.kind,
      input.reason,
      input.quote ?? null,
      input.by,
      at,
      this.nextDecisionStamp(id),
      id,
    );
    const decision = this.requireDecision(id);
    this.bus.emit({ type: "decision", decision });
    this.emitProjects();
    return decision;
  }

  /** 끝내 전달하지 못한 답은 대표가 다시 답할 수 있게 카드를 연다. 메모의 사본은 전달 글뿐이었으니 직전 답을 카드에 남긴다. 닫힌 카드를 다시 열 때도 쓴다(닫은 이유는 지운다). */
  reopenDecision(id: string, why = "전달하지 못했습니다. 다시 결정해 주세요"): Decision {
    this.requireDecision(id);
    this.run(
      "UPDATE decisions SET status = 'open', last_choice = COALESCE(choice, last_choice), last_note = COALESCE(note, last_note), reopen_note = ?, choice = NULL, note = NULL, batch = 0, answered_at = NULL, delivered_at = NULL, close_kind = NULL, close_reason = NULL, close_quote = NULL, closed_by = NULL, closed_at = NULL, updated_at = ? WHERE id = ?",
      why,
      this.nextDecisionStamp(id),
      id,
    );
    const decision = this.requireDecision(id);
    this.bus.emit({ type: "decision", decision });
    this.emitProjects();
    return decision;
  }

  /** 답했지만 아직 누구에게도 가지 않은 결재. */
  listAnsweredDecisions(projectId: string): Decision[] {
    return this.rows("SELECT * FROM decisions WHERE project_id = ? AND status = 'answered' ORDER BY answered_at, rowid", projectId).map(toDecision);
  }

  // ---- 내 할 일 ----
  getTodo(id: string): Todo | null {
    const r = this.row("SELECT * FROM todos WHERE id = ?", id);
    return r ? toTodo(r) : null;
  }

  requireTodo(id: string): Todo {
    const t = this.getTodo(id);
    if (!t) throw new ApiError(404, "할 일을 찾을 수 없습니다");
    return t;
  }

  listTodos(projectId: string): Todo[] {
    return this.rows("SELECT * FROM todos WHERE project_id = ? ORDER BY created_at, rowid", projectId).map(toTodo);
  }

  createTodo(input: NewTodo): Todo {
    this.requireProject(input.projectId);
    const id = newId("t_");
    const at = nowIso();
    this.run(
      "INSERT INTO todos (id, project_id, member_id, who, title, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.projectId,
      input.memberId ?? null,
      input.who ?? "",
      input.title,
      input.detail ?? "",
      at,
      at,
    );
    const todo = this.requireTodo(id);
    this.bus.emit({ type: "todo", todo });
    this.emitProjects();
    return todo;
  }

  /** 받을 사람이 없어 '했음'을 못 알린 할 일. 총괄이 뜨면 전한다. */
  setTodoNoticePending(id: string, pending: boolean): void {
    this.run("UPDATE todos SET notice_pending = ? WHERE id = ?", pending ? 1 : 0, id);
  }

  listTodoNoticesPending(projectId: string): Todo[] {
    return this.rows("SELECT * FROM todos WHERE project_id = ? AND notice_pending = 1 AND done = 1 ORDER BY done_at, rowid", projectId).map(toTodo);
  }

  /** 대표의 체크. changed=false 면 이미 그 값이었다. 체크를 풀면 AI 가 정리한 이유도 지운다. */
  setTodoDone(id: string, done: boolean): { todo: Todo; changed: boolean } {
    const before = this.requireTodo(id);
    if (before.done === done) return { todo: before, changed: false };
    const at = nowIso();
    this.run(
      "UPDATE todos SET done = ?, done_at = ?, outcome = ?, close_reason = NULL, closed_by = NULL, updated_at = ? WHERE id = ?",
      done ? 1 : 0,
      done ? at : null,
      done ? "done" : null,
      at,
      id,
    );
    const todo = this.requireTodo(id);
    this.bus.emit({ type: "todo", todo });
    this.emitProjects();
    return { todo, changed: true };
  }

  /** AI 의 todo_close. 안 끝난 할 일만. 끝남·필요 없어짐 모두 안 한 할 일 수에서 빠진다. */
  closeTodo(id: string, input: { outcome: TodoOutcome; reason: string; by: string }): Todo {
    const before = this.requireTodo(id);
    if (before.done) throw new ApiError(409, "이미 끝났거나 정리된 할 일입니다");
    const at = nowIso();
    this.run(
      "UPDATE todos SET done = 1, done_at = ?, outcome = ?, close_reason = ?, closed_by = ?, updated_at = ? WHERE id = ? AND done = 0",
      at,
      input.outcome,
      input.reason,
      input.by,
      at,
      id,
    );
    const todo = this.requireTodo(id);
    this.bus.emit({ type: "todo", todo });
    this.emitProjects();
    return todo;
  }

  // ---- 판 정리 ----
  /** 마지막으로 판 정리를 맡긴 시각. 화면도 알게 프로젝트로 방송한다. */
  setBoardTidiedAt(projectId: string, at: string): void {
    this.run("UPDATE projects SET board_tidied_at = ? WHERE id = ?", at, projectId);
    const project = this.getProject(projectId);
    if (project) this.bus.emit({ type: "project", project });
  }

  /** 결재·할 일·진행판·대화에서 가장 늦게 바뀐 시각. 아무것도 없으면 null. */
  lastBoardChangeAt(projectId: string): string | null {
    const r = this.row(
      `SELECT MAX(t) AS at FROM (
         SELECT MAX(COALESCE(updated_at, created_at)) AS t FROM decisions WHERE project_id = ?1
         UNION ALL SELECT MAX(COALESCE(updated_at, done_at, created_at)) FROM todos WHERE project_id = ?1
         UNION ALL SELECT MAX(updated_at) FROM work WHERE project_id = ?1
         UNION ALL SELECT MAX(at) FROM messages WHERE project_id = ?1)`,
      projectId,
    );
    return (r?.at as string | null | undefined) ?? null;
  }

  // ---- 진행 판 ----
  getWork(id: string): WorkItem | null {
    const r = this.row("SELECT * FROM work WHERE id = ?", id);
    return r ? toWork(r) : null;
  }

  listWork(projectId: string): WorkItem[] {
    return this.rows("SELECT * FROM work WHERE project_id = ? ORDER BY sort_order, rowid", projectId).map(toWork);
  }

  private emitWork(projectId: string): void {
    this.bus.emit({ type: "work", projectId, work: this.listWork(projectId) });
  }

  /** id 가 있으면 고치고(다른 프로젝트 항목이면 거부), 없으면 만든다. */
  upsertWork(input: WorkInput): WorkItem {
    this.requireProject(input.projectId);
    const at = nowIso();
    const doneAt = input.sec === "done" ? at : null;
    if (input.id) {
      const existing = this.getWork(input.id);
      if (!existing || existing.projectId !== input.projectId) throw new ApiError(404, `일 항목을 찾을 수 없습니다: ${input.id}`);
      this.run(
        "UPDATE work SET sec = ?, title = ?, detail = ?, who = ?, done_at = ?, updated_at = ? WHERE id = ?",
        input.sec,
        input.title,
        input.detail ?? existing.detail,
        input.who ?? existing.who,
        input.sec === "done" ? (existing.doneAt ?? at) : null,
        at,
        input.id,
      );
      this.emitWork(input.projectId);
      return this.getWork(input.id)!;
    }
    const id = newId("w_");
    const order = this.row("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM work WHERE project_id = ?", input.projectId)!.n as number;
    this.run(
      "INSERT INTO work (id, project_id, sec, title, detail, who, sort_order, done_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.projectId,
      input.sec,
      input.title,
      input.detail ?? "",
      input.who ?? "",
      order,
      doneAt,
      at,
      at,
    );
    this.emitWork(input.projectId);
    return this.getWork(id)!;
  }

  removeWork(id: string): void {
    const item = this.getWork(id);
    if (!item) return;
    this.run("DELETE FROM work WHERE id = ?", id);
    this.emitWork(item.projectId);
  }

  // ---- 대화 ----
  getMessage(id: string): Message | null {
    const r = this.row("SELECT * FROM messages WHERE id = ?", id);
    return r ? toMessage(r) : null;
  }

  requireMessage(id: string): Message {
    const m = this.getMessage(id);
    if (!m) throw new ApiError(404, "메시지를 찾을 수 없습니다");
    return m;
  }

  /** `before`(at) 보다 앞선 것 중 최신 limit 개를 오래된 → 최신으로. */
  listMessages(projectId: string, opts: { before?: string; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = opts.before
      ? this.rows("SELECT * FROM messages WHERE project_id = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?", projectId, opts.before, limit)
      : this.rows("SELECT * FROM messages WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?", projectId, limit);
    return rows.reverse().map(toMessage);
  }

  // before 페이징이 같은 at 의 글을 건너뛰지 않도록 at 을 프로세스 안에서 단조 증가시킨다.
  private nextMessageAt(): string {
    const ms = Math.max(Date.now(), this.lastMessageMs + 1);
    this.lastMessageMs = ms;
    return new Date(ms).toISOString();
  }

  /** 멱등: 같은 id 가 이미 있으면 새로 쓰지 않고 그 글을 돌려준다. */
  createMessage(input: NewMessage): Message {
    if (input.id) {
      const existing = this.getMessage(input.id);
      if (existing) return existing;
    }
    this.requireProject(input.projectId);
    const id = input.id ?? newId("msg_");
    this.run(
      `INSERT INTO messages (id, project_id, at, mine, member_id, who, kind, title, body, target_member_id, target_name, decision_id, file_id, attachments, delivery, delivery_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.projectId,
      input.at ?? this.nextMessageAt(),
      input.mine ? 1 : 0,
      input.memberId ?? null,
      input.who ?? "",
      input.kind,
      input.title ?? "",
      input.body ?? "",
      input.targetMemberId ?? null,
      input.targetName ?? null,
      input.decisionId ?? null,
      input.fileId ?? null,
      JSON.stringify(input.attachments ?? []),
      input.delivery ?? null,
      input.deliveryNote ?? null,
    );
    const message = this.requireMessage(id);
    this.bus.emit({ type: "message", message });
    return message;
  }

  setMessageDelivery(id: string, delivery: DeliveryStatus | null, note: string | null = null): Message {
    this.requireMessage(id);
    this.run("UPDATE messages SET delivery = ?, delivery_note = ? WHERE id = ?", delivery, note, id);
    const message = this.requireMessage(id);
    this.bus.emit({ type: "message", message });
    return message;
  }

  // ---- 자료 ----
  getFile(id: string): FileDoc | null {
    const r = this.row("SELECT * FROM files WHERE id = ?", id);
    return r ? toFile(r) : null;
  }

  /** 아티팩트 원본. 예전 자료는 첨부에 들어 있어 호출하는 쪽이 첨부에서 읽는다. */
  getFileHtml(id: string): string | null {
    return (this.row("SELECT html FROM files WHERE id = ?", id)?.html as string | null | undefined) ?? null;
  }

  listFiles(projectId: string): FileDoc[] {
    return this.rows("SELECT * FROM files WHERE project_id = ? ORDER BY sort_order DESC, rowid DESC", projectId).map(toFile);
  }

  createFile(input: NewFile): FileDoc {
    this.requireProject(input.projectId);
    const id = newId("f_");
    const order = this.row("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM files WHERE project_id = ?", input.projectId)!.n as number;
    this.run(
      "INSERT INTO files (id, project_id, title, who, member_id, summary, body, path, attachments, created_at, sort_order, kind, html) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.projectId,
      input.title,
      input.who ?? "",
      input.memberId ?? null,
      input.summary ?? "",
      input.body ?? "",
      input.path ?? null,
      JSON.stringify(input.attachments ?? []),
      nowIso(),
      order,
      input.kind ?? null,
      input.html ?? null,
    );
    const file = this.getFile(id)!;
    this.bus.emit({ type: "file", file });
    return file;
  }

  // ---- 첨부 ----
  createAttachment(saved: { id: string; name: string; mime: string; size: number; path: string }): Attachment {
    this.run(
      "INSERT INTO attachments (id, name, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      saved.id,
      saved.name,
      saved.mime,
      saved.size,
      saved.path,
      nowIso(),
    );
    return this.getAttachment(saved.id)!;
  }

  getAttachment(id: string): Attachment | null {
    const r = this.row("SELECT * FROM attachments WHERE id = ?", id);
    return r ? toAttachment(r) : null;
  }

  /** 가져오기 전용: 원본 시각을 그대로 옮긴다. 평소 흐름은 쓰지 않는다. */
  restoreTimes(table: keyof typeof RESTORABLE_TIMES, id: string, times: Partial<Record<TimeField, string | null>>): void {
    const allowed: Partial<Record<TimeField, string>> = RESTORABLE_TIMES[table];
    const fields = (Object.keys(times) as TimeField[]).filter((f) => allowed[f] && times[f]);
    if (fields.length === 0) return;
    this.run(`UPDATE ${table} SET ${fields.map((f) => `${allowed[f]} = ?`).join(", ")} WHERE id = ?`, ...fields.map((f) => times[f]!), id);
  }

  // ---- 전달 큐 ----
  getDelivery(id: string): Delivery | null {
    const r = this.row("SELECT * FROM deliveries WHERE id = ?", id);
    return r ? toDelivery(r) : null;
  }

  requireDelivery(id: string): Delivery {
    const d = this.getDelivery(id);
    if (!d) throw new ApiError(404, "전달 항목을 찾을 수 없습니다");
    return d;
  }

  private emitMember(memberId: string): void {
    const member = this.getMember(memberId);
    if (member) this.bus.emit({ type: "member", member });
  }

  enqueue(input: NewDelivery): Delivery {
    const member = this.requireMember(input.memberId);
    if (member.projectId !== input.projectId) throw new ApiError(400, "다른 프로젝트의 직원입니다");
    const id = newId("dl_");
    this.run(
      `INSERT INTO deliveries (id, project_id, member_id, kind, text, wake, urgent, status, hold_reason, ref_type, ref_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.projectId,
      input.memberId,
      input.kind,
      input.text,
      (input.wake ?? true) ? 1 : 0,
      input.urgent ? 1 : 0,
      input.status ?? "queued",
      input.holdReason ?? null,
      input.refType ?? null,
      input.refId ?? null,
      nowIso(),
    );
    this.emitMember(input.memberId);
    return this.requireDelivery(id);
  }

  /** 아직 전달되지 않은 것(queued·held), 넣은 순서대로. */
  listPending(memberId: string): Delivery[] {
    return this.rows("SELECT * FROM deliveries WHERE member_id = ? AND status IN ('queued','held') ORDER BY rowid", memberId).map(toDelivery);
  }

  /** 서버 재시작 복구용: 프로젝트 전체의 미전달 + 전달 중이던 것. */
  listUndelivered(projectId?: string): Delivery[] {
    const statuses = "status IN ('queued','held','delivering')";
    const rows = projectId
      ? this.rows(`SELECT * FROM deliveries WHERE project_id = ? AND ${statuses} ORDER BY rowid`, projectId)
      : this.rows(`SELECT * FROM deliveries WHERE ${statuses} ORDER BY rowid`);
    return rows.map(toDelivery);
  }

  /** 그 대상을 가리키는 전달 중 실제로 나간 마지막 글. 체크를 여러 번 풀어도 상대가 지금 무엇을 믿는지 안다. */
  lastDeliveredTextFor(refType: NonNullable<Delivery["refType"]>, refId: string): string | null {
    return (this.row("SELECT text FROM deliveries WHERE ref_type = ? AND ref_id = ? AND status = 'delivered' ORDER BY rowid DESC LIMIT 1", refType, refId)?.text as string | undefined) ?? null;
  }

  /** 서버가 죽기 직전에 넣고 있던 전달(복구 전). */
  listDelivering(): Delivery[] {
    return this.rows("SELECT * FROM deliveries WHERE status = 'delivering' ORDER BY rowid").map(toDelivery);
  }

  /** 아직 나가지 않은 전달을 거둔다. 거둔 수를 돌려준다. */
  cancelPendingFor(refType: NonNullable<Delivery["refType"]>, refId: string): number {
    const rows = this.rows("SELECT id, member_id FROM deliveries WHERE ref_type = ? AND ref_id = ? AND status IN ('queued','held')", refType, refId);
    for (const r of rows) {
      this.run("DELETE FROM deliveries WHERE id = ?", r.id);
      this.emitMember(r.member_id);
    }
    return rows.length;
  }

  /** 받은 줄 알았는데 턴이 입력을 읽기 전에 끝났다. 대기로 되돌린다. */
  requeueDelivered(id: string): Delivery {
    const d = this.requireDelivery(id);
    this.run("UPDATE deliveries SET status = 'queued', delivered_at = NULL, hold_reason = NULL WHERE id = ?", id);
    this.emitMember(d.memberId);
    return this.requireDelivery(id);
  }

  /** 서버가 죽어 delivering 에 멈춘 것을 되돌린다. 되돌린 수를 돌려준다. */
  requeueDelivering(): number {
    return this.db.query("UPDATE deliveries SET status = 'queued' WHERE status = 'delivering'").run().changes;
  }

  setDeliveryStatus(id: string, status: DeliveryStatus, update: DeliveryUpdate = {}): Delivery {
    const before = this.requireDelivery(id);
    this.run(
      `UPDATE deliveries SET status = ?, hold_reason = ?, last_error = ?, attempts = attempts + ?,
         delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END
       WHERE id = ?`,
      status,
      status === "held" ? (update.holdReason ?? before.holdReason) : null,
      update.lastError !== undefined ? update.lastError : before.lastError,
      update.attempt ? 1 : 0,
      status,
      nowIso(),
      id,
    );
    this.emitMember(before.memberId);
    return this.requireDelivery(id);
  }

  markDelivered(id: string): Delivery {
    return this.setDeliveryStatus(id, "delivered");
  }

  markHeld(id: string, reason: string): Delivery {
    return this.setDeliveryStatus(id, "held", { holdReason: reason });
  }

  markFailed(id: string, error: string): Delivery {
    return this.setDeliveryStatus(id, "failed", { lastError: error });
  }

  // ---- 활동 ----
  /** 직원당 최근 MAX_ACTIVITY_PER_MEMBER 개만 남긴다. */
  appendActivity(memberId: string, kind: ActivityKind, text: string): Activity {
    const member = this.requireMember(memberId);
    const clipped = text.length > MAX_ACTIVITY_TEXT ? `${text.slice(0, MAX_ACTIVITY_TEXT)}…` : text;
    const inserted = this.row("INSERT INTO activity (member_id, at, kind, text) VALUES (?, ?, ?, ?) RETURNING *", memberId, nowIso(), kind, clipped)!;
    // 마지막 턴 시작은 남긴다. 긴 턴이 500줄을 넘어도 재시작 뒤 '이번 턴'의 시작을 알아야 보고를 살린다.
    this.run(
      `DELETE FROM activity WHERE member_id = ? AND id <= COALESCE(
         (SELECT id FROM activity WHERE member_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?), 0)
         AND id != COALESCE((SELECT MAX(id) FROM activity WHERE member_id = ? AND kind = 'turn_start'), 0)`,
      memberId,
      memberId,
      MAX_ACTIVITY_PER_MEMBER,
      memberId,
    );
    const activity = toActivity(inserted);
    this.bus.emit({ type: "activity", projectId: member.projectId, activity });
    return activity;
  }

  /** 최신 limit 개를 오래된 → 최신으로. */
  listActivity(memberId: string, limit = 100): Activity[] {
    const n = Math.min(Math.max(limit, 1), MAX_ACTIVITY_PER_MEMBER);
    return this.rows("SELECT * FROM activity WHERE member_id = ? ORDER BY id DESC LIMIT ?", memberId, n).reverse().map(toActivity);
  }

  /** 마지막 턴 시작 시각. 활동이 아무리 쌓여도 찾는다. */
  lastTurnStart(memberId: string): string | null {
    return (this.row("SELECT at FROM activity WHERE member_id = ? AND kind = 'turn_start' ORDER BY id DESC LIMIT 1", memberId)?.at as string | undefined) ?? null;
  }

  /** since 이후에 그 직원이 쓴 글이 있는가(이번 턴에 이미 보고했는가). */
  hasMessageBySince(memberId: string, since: string): boolean {
    return this.row("SELECT 1 FROM messages WHERE member_id = ? AND at >= ? LIMIT 1", memberId, since) !== null;
  }

  /** 대표가 이 프로젝트에서 보낸 글에 그 첨부가 붙어 있는가. 다른 프로젝트의 첨부를 지시로 끌어오지 못하게 한다. */
  isProjectAttachment(projectId: string, attachmentId: string): boolean {
    return this.row("SELECT 1 FROM messages WHERE project_id = ? AND mine = 1 AND attachments LIKE ? LIMIT 1", projectId, `%"${attachmentId}"%`) !== null;
  }

  /** Store 를 거치지 않는 값(herdr 연결 상태 등)을 화면에 알린다. */
  broadcast(event: WsEvent): void {
    this.bus.emit(event);
  }

  // ---- 설정 ----
  getSettings(): Settings {
    const settings: Settings = { ...DEFAULT_SETTINGS };
    for (const r of this.rows("SELECT key, value FROM settings")) {
      if (r.key in settings) (settings as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
    }
    // 나중에 생긴 직급이 저장값에 없어도 칸은 늘 있어야 한다.
    settings.ranks = Object.fromEntries((Object.keys(DEFAULT_RANKS) as Rank[]).map((rank) => [rank, { ...DEFAULT_RANKS[rank], ...settings.ranks[rank] }])) as Settings["ranks"];
    return settings;
  }

  patchSettings(patch: SettingsPatch): Settings {
    const before = this.getSettings();
    const next: Record<string, unknown> = { ...patch };
    if (patch.ranks) {
      next.ranks = Object.fromEntries((Object.keys(DEFAULT_RANKS) as Rank[]).map((rank) => [rank, { ...before.ranks[rank], ...patch.ranks![rank] }]));
    }
    this.db.transaction(() => {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (next[key] === undefined) continue;
        this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(next[key]));
      }
    })();
    const settings = this.getSettings();
    this.bus.emit({ type: "settings", settings });
    if (settings.backend !== before.backend) this.emitProjects();
    return settings;
  }
}
