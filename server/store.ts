import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { homedir } from "node:os";
import type {
  ArchiveProjectState,
  CoreContextState,
  MessagePage,
  MessagePageOptions,
  MessageScope,
  ActivityKind,
  Activity,
  AnswerReq,
  Attachment,
  Backend,
  CliProvider,
  Decision,
  DonePage,
  DoneTodosPage,
  DecisionCloseKind,
  DecisionCloseFollowUp,
  DecisionOption,
  DecisionStatus,
  Delivery,
  DeliveryKind,
  DeliveryWaitInfo,
  DeliveryWaitReason,
  MissingReportNotice,
  DeliveryStatus,
  Effort,
  FileDoc,
  FileKind,
  FileSearchResult,
  Member,
  MemberLifecycleState,
  MemberKind,
  MemberOrigin,
  MemberStatus,
  Message,
  MessageKind,
  Project,
  ProjectConnection,
  ProjectState,
  ProjectStateWindow,
  ProjectSummary,
  Rank,
  Settings,
  SettingsPatch,
  Todo,
  TodoOutcome,
  ToolPermissionInfo,
  WorkItem,
  WorkSec,
  WsEvent,
} from "../shared/types.ts";
import { BLOCKED_CODES, DEFAULT_CODEX_RANKS, DEFAULT_GEMINI_RANKS, DEFAULT_RANKS, fileKindOf, type BlockedCode } from "../shared/types.ts";
import type { MemberRevisions, OperationKind, OperationReceipt, OperationStatus, SyncRevisions, ManualInboxBatch } from "../shared/operations.ts";
import type { DeliveryDispatch, DeliveryIntentResult, DeliveryRecoveryRecord, DomainRecorder, LifecycleJournal, MessageReadStore, ProjectPatchStore, RunnerRecoveryStore, TerminalLease, RunnerRecoveryState, ReportReferences, BoardReview } from "./service-contracts.ts";
import type { RunnerTerminalIdentity } from "./runner/types.ts";
import type { Bus } from "./bus.ts";
import { ensureDeliveryVerdicts, newId, nowIso } from "./db.ts";
import { baseTitle, pickPrevious, planTidy, tidyFamilies, tidyReport, unchainedKey, VERSION_WINDOW_MS, type ChainBasis, type ChainFile, type TidyBlocks, type TidyPlan, type TidyReport } from "./file-versions.ts";
import { parseTailnetHttpsRecord, TAILNET_HTTPS_KEY } from "./tailnet-https.ts";
import { isDeliveryWaitReason, MEMBER_GATE_WAITS, verdictPatience, verdictWait, WATCHED_WAITS, type PumpVerdict, type StoredPumpVerdict } from "./pump-verdict.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOWS, exactSource } from "./runner/context.ts";
import { MAX_PROJECT_NAME, MAX_ROLE, nameProblem, oneLineProblem, RESERVED_HANDLES, workerNameProblem } from "./text.ts";
import { cleanName, cleanText, conductorName, DEFAULT_NAMES, firstRunLang, stripControls } from "./text.ts";
import { parseRestartWake, type RestartWake } from "./restart-wake.ts";
import type { ErrorCode } from "../shared/error-codes.ts";
import { deliveryNoteCode } from "./hold-codes.ts";
import type { MessageReply } from "../shared/types.ts";
import { judgeReply, replySettled, type ReplyFacts } from "./reply-state.ts";
import { formatSystem, OWNER_QUOTE_LABELS } from "./delivery-text.ts";
import { API_RESUME_TEXT, USAGE_RESUME_TEXT } from "./api-outage.ts";
import { RESTART_RESUME_TEXT } from "./restart-wake.ts";
import { CLAUDE_BACKGROUND_REASON } from "./runner/claude-turn.ts";

// Z(0.2.6): 답 상태가 '이 실행을 잇는 서버 글'을 가려내는 규칙.
/** 끊긴 턴을 잇는 서버 글(사용 한도·인터넷이 풀림, 재시작 뒤 다시 엶). api-outage.ts 가 이 모듈을 불러오므로 모듈을 읽을 때가 아니라 부를 때 본다. */
function resumeText(text: string): boolean {
  return text === USAGE_RESUME_TEXT || text === API_RESUME_TEXT || text === RESTART_RESUME_TEXT;
}
/** 그 실행들 가운데 하나에 서버가 요청한 보고 보완이다(orchestrator requestMissingReport 의 글 머리). */
function supplementFor(text: string, runs: ExecutionJournal[]): boolean {
  return runs.some(run => text.startsWith(formatSystem(`보고 보완: 실행 ${run.runId}의`)));
}
/** 그 실행들을 잇는 글인가: 같은 대표 글을 다시 넣음, 그 실행들의 보고 보완, 바로 앞 실행이 끊긴 뒤의 이어가기. */
function continuesReplyRun(d: { id: string; kind: string; text: string }, own: string[], runs: ExecutionJournal[]): boolean {
  return own.includes(d.id) || (d.kind === "system" && (resumeText(d.text) || supplementFor(d.text, runs)));
}
/**
 * 0.2.7(D3-1): 실행의 결과 보고로 세는 글. 그 팀장이 쓴 완료·답변·막힘·질문, 그리고 progress 가 참이면 SQL 자리표(?)로 넘긴 때부터의 진행·알림.
 * 서버가 그 팀장 이름으로 남긴 글(who='시스템', 서버 글 코드 text_ref 가 있는 글)은 빼 둔다. 진행·알림을 세는 때는 Store.progressReportFrom.
 */
const MEMBER_REPORT_SQL = (alias: string, progress: boolean) => `${alias}who <> '시스템' AND ${alias}text_ref IS NULL AND (${alias}kind IN ('완료', '답변', '막힘', '질문')${
  progress ? ` OR (${alias}kind IN ('진행', '알림') AND ${alias}at >= ?)` : ""})`;
import { mustRender, textLang, textRef, type ServerTextRef, type TextLang } from "../shared/server-text.ts";
import { activityTextFields, decisionTextFields, lastErrorCodeField, messageTextFields, readDecisionTexts, relocalizeDecisionTexts, renderDecisionText, renderOptions, storedDecisionTexts, storedText, type DecisionTextRefs } from "./text-refs.ts";

/**
 * status 가 그대로 HTTP 응답 코드가 되는 오류. 응답 몸은 `{ error: message, code, reason? }`.
 * 동작은 code(·reason)로만 가른다. message 는 표시용이라 문구를 다듬어도 동작이 바뀌지 않아야 한다(shared/error-codes.ts).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: ErrorCode,
    /** 이미 내보낸 넓은 코드(TERMINAL_REFUSED 등) 아래의 좁은 사유. 넓은 코드 이름은 출시된 앱이 보므로 바꾸지 않고 이 칸으로 더한다. */
    readonly reason?: ErrorCode,
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
  chiefCli?: CliProvider;
  runnerEnabled?: boolean;
  now?: string;
  creationGoal?: string | null;
}
export type ProjectPatch = Partial<
  Pick<
    Project,
    "name" | "cwd" | "runnerEnabled" | "now" | "herdrTabId" | "archived"
  >
>;

export interface NewMember {
  cli?: CliProvider;
  modelOverride?: string | null;
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
    "name" | "role" | "cli" | "origin" | "backend" | "modelOverride" | "effortOverride" | "status" | "now" | "next" | "cwd" | "sessionId" | "paneId" | "contextPct" | "contextWindow" | "contextWindowSource" | "subagents" | "parallel" | "lastError" | "statusObservation" | "blockedReason" | "subagentState" | "nowAt" | "manualActivityAt"
  >
> & {
  /** lastError 가 뜻하는 보류의 코드(server/hold-codes.ts). lastError 를 바꾸면서 이 칸을 주지 않으면 지운다(보류가 아닌 글로 덮였다). */
  fenceCode?: ErrorCode | null;
};


/** 지금 세션에 실제로 들어간 설정. 값이 달라지면 쉴 때 세션을 다시 연다. */
export interface AppliedConfig {
  model: string | null;
  effort: Effort | null;
  staffModel: string | null;
  staffEffort: Effort | null;
  /**
   * 0.2.8: 이 세션을 띄울 때의 CLI 계정 세대(orchestrator 의 CliAccountEpoch). 앱에서 다른 계정으로 로그인한 적이 없으면 없다(0).
   * 세대가 다르면 쉴 때 같은 대화를 새 계정으로 다시 연다.
   */
  account?: number;
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
  /** 0.2.6 Y: 서버가 만든 카드의 글 코드. 주면 제목·본문·선택지 이름을 보고 언어로 그려 넣고(위 칸을 덮는다) 코드를 함께 저장한다. */
  texts?: DecisionTextRefs;
  /** 0.2.7 묶음 4: 이 카드가 대신하는 앞 카드. 앞 카드를 닫고 잇는 것은 replaceDecision 이 한다. */
  replaces?: string | null;
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
  contextFileId?: string | null;
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
  /** 0.2.6 Y: 서버가 만든 글의 코드와 값. 주면 body(와 `<코드>.title` 제목)를 보고 언어로 그려 넣고 코드를 함께 저장한다. */
  text?: ServerTextRef;
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
  /** 0.2.7 묶음 4: 이 판이 대신하는 앞 판(같은 프로젝트, 아직 최신 판). 같은 트랜잭션에서 앞 판에 새 판을 잇고 열린 결재의 근거 자료를 새 판으로 옮긴다. */
  replaces?: string | null;
  /**
   * 0.2.10: replaces 가 없을 때 서버가 같은 팀장·같은 종류의 같은 제목(판 표시·날짜를 걷고 비교) 최신 판을 찾아 잇는다(server/file-versions.ts pickPrevious).
   * file 도구만 켠다(대표가 올린 자료·가져오기는 잇지 않는다). 자동으로 이은 판은 열린 결재의 근거 자료를 옮기지 않는다(대표가 보던 근거를 몰래 바꾸지 않는다).
   * false 는 팀장이 new_item:true 로 '새 자료'라고 밝힌 것이다(file 도구가 autoChain: !new_item 으로 넘긴다): file_chain_journal 에 new_item 행을 남겨
   * iamceo files tidy 도 이 자료를 앞 판에 잇지 않는다. 생략(undefined)은 잇지 않을 뿐 아무것도 적지 않는다.
   */
  autoChain?: boolean;
}

/** 0.2.10: 자료를 올린 결과와 서버가 자동으로 이은 앞 판. */
export interface FileChainResult {
  file: FileDoc;
  /** versions: 이 판까지의 판 수(앞 판들 + 이 판). */
  chained?: { previous: FileDoc; basis: ChainBasis; versions: number };
  /** 이을 만한 앞 판이 여럿이라 잇지 않았다(도구 답이 replaces 로 고르라고 알린다). */
  ambiguous?: FileDoc[];
}

/**
 * 0.2.10 file_chain_journal 의 source. auto: 자동 잇기, tidy: iamceo files tidy 적용(batch_id 가 묶음 번호), unchain: 팀장이 끊은 쌍
 * (서버가 이은 것이든 명시한 replaces 든), new_item: 팀장이 new_item:true 로 올린 자료. auto·unchain·new_item 의 batch_id 는 그 자료 id 다.
 */
type FileJournalSource = "auto" | "tidy" | "unchain" | "new_item";
/** new_item 행의 replaces. 열이 NOT NULL 이라(표 정의는 그대로 둔다) '어느 앞 판에도 잇지 않음'을 이 표지로 적는다. 자료 id(f_…)와 겹치지 않는다. */
const FILE_JOURNAL_ANY_PREVIOUS = "*";
const FILE_TIDY_CYCLE_TEXT = "판 사슬이 고리가 되는 잇기가 있어 적용하지 않았습니다. 바꾼 것은 없습니다";

/** 0.2.10 iamceo files tidy 의 적용 기록 한 묶음. */
export interface FileTidyBatch {
  batchId: string;
  createdAt: string;
  links: number;
  undone: number;
}

/** File projection schema, appended by db.ts's versioned migrations. */
export function fileSearchMigration(): string {
  return `
    CREATE TABLE file_search_documents (
      rowid INTEGER PRIMARY KEY,
      file_id TEXT NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      archived INTEGER NOT NULL,
      title TEXT NOT NULL, path TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL,
      title_fold TEXT NOT NULL, path_fold TEXT NOT NULL, summary_fold TEXT NOT NULL, body_fold TEXT NOT NULL
    );
    CREATE INDEX file_search_project ON file_search_documents(project_id, archived);
    CREATE VIRTUAL TABLE file_search_fts USING fts5(title_fold, path_fold, summary_fold, body_fold,
      content='file_search_documents', content_rowid='rowid', tokenize='trigram');
    CREATE TABLE file_search_pending (file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE);
    CREATE TABLE file_search_migration_audit (
      id INTEGER PRIMARY KEY CHECK(id = 1), indexed_files INTEGER NOT NULL,
      body_limit INTEGER NOT NULL, completed_at TEXT
    );
    INSERT INTO file_search_migration_audit VALUES (1, 0, 65536, NULL);
    CREATE TRIGGER file_search_document_insert AFTER INSERT ON file_search_documents BEGIN
      INSERT INTO file_search_fts(rowid,title_fold,path_fold,summary_fold,body_fold) VALUES(new.rowid,new.title_fold,new.path_fold,new.summary_fold,new.body_fold);
    END;
    CREATE TRIGGER file_search_document_delete AFTER DELETE ON file_search_documents BEGIN
      INSERT INTO file_search_fts(file_search_fts,rowid,title_fold,path_fold,summary_fold,body_fold) VALUES('delete',old.rowid,old.title_fold,old.path_fold,old.summary_fold,old.body_fold);
    END;
    CREATE TRIGGER file_search_document_update AFTER UPDATE OF title_fold,path_fold,summary_fold,body_fold ON file_search_documents BEGIN
      INSERT INTO file_search_fts(file_search_fts,rowid,title_fold,path_fold,summary_fold,body_fold) VALUES('delete',old.rowid,old.title_fold,old.path_fold,old.summary_fold,old.body_fold);
      INSERT INTO file_search_fts(rowid,title_fold,path_fold,summary_fold,body_fold) VALUES(new.rowid,new.title_fold,new.path_fold,new.summary_fold,new.body_fold);
    END;
    CREATE TRIGGER file_search_file_insert AFTER INSERT ON files BEGIN
      INSERT OR IGNORE INTO file_search_pending VALUES(new.id);
    END;
    CREATE TRIGGER file_search_file_update AFTER UPDATE OF id,project_id,title,path,summary,body,kind,html,attachments ON files BEGIN
      DELETE FROM file_search_documents WHERE file_id=old.id;
      INSERT OR IGNORE INTO file_search_pending VALUES(new.id);
    END;
    CREATE TRIGGER file_search_project_archive AFTER UPDATE OF archived ON projects BEGIN
      UPDATE file_search_documents SET archived=new.archived WHERE project_id=new.id;
    END;
    INSERT INTO file_search_pending SELECT id FROM files;
  `;
}

/** Best-effort, bounded projection work. Failed rows remain durable for the next refresh/open. */
export function refreshFileSearchIndex(db: Database, options: { fileId?: string; projectId?: string; limit?: number } = {}): number {
  try {
    // Hosts without the migration continue to serve legacy file routes.
    if (!db.query("SELECT 1 FROM sqlite_schema WHERE name='file_search_pending'").get()) return 0;
    if (!db.query("SELECT 1 FROM file_search_pending LIMIT 1").get()) return 0;
    return db.transaction(() => {
      const pending = db.query<{ id: string; project_id: string; archived: number; title: string; path: string | null;
        summary: string; body: string | null; html: string | null; kind: FileKind | null; attachments: string; binary: number },
        [number, string | null, string | null]>(`
        SELECT f.id,f.project_id,p.archived,CAST(f.title AS TEXT) AS title,CAST(f.path AS TEXT) AS path,
          CAST(f.summary AS TEXT) AS summary,
          CASE WHEN typeof(f.body)='text' THEN substr(f.body,1,65536) END AS body,
          CASE WHEN typeof(f.html)='text' THEN substr(f.html,1,65536) END AS html,
          f.kind,f.attachments,(typeof(f.body)='blob' OR typeof(f.html)='blob') AS binary
        FROM file_search_pending q JOIN files f ON f.id=q.file_id JOIN projects p ON p.id=f.project_id
        WHERE (?2 IS NULL OR f.id=?2) AND (?3 IS NULL OR f.project_id=?3) LIMIT ?1`)
        .all(Math.min(Math.max(options.limit ?? 32, 1), 32), options.fileId ?? null, options.projectId ?? null);
      const insert = db.query(`INSERT INTO file_search_documents(file_id,project_id,archived,title,path,summary,body,title_fold,path_fold,summary_fold,body_fold)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET project_id=excluded.project_id,archived=excluded.archived,
        title=excluded.title,path=excluded.path,summary=excluded.summary,body=excluded.body,
        title_fold=excluded.title_fold,path_fold=excluded.path_fold,summary_fold=excluded.summary_fold,body_fold=excluded.body_fold`);
      const save = (file: typeof pending[number], fields: string[]) => db.transaction(() => {
        insert.run(file.id, file.project_id, file.archived, ...fields, ...fields.map(value => value.toLowerCase()));
        db.query("DELETE FROM file_search_pending WHERE file_id=?").run(file.id);
      })();
      const started = performance.now();
      let processed = 0;
      for (const file of pending) {
        const metadata = [file.title.normalize("NFC"), (file.path ?? "").normalize("NFC"), "", ""];
        try {
          const attachments = JSON.parse(file.attachments) as Attachment[];
          const kind = file.kind ?? fileKindOf(file.path ?? file.title, attachments[0]?.mime ?? "");
          const text = ["document", "artifact", "table", "code"].includes(kind) ||
            (kind === "file" && !attachments.length && (!file.path || ["document", "artifact", "table", "code"].includes(fileKindOf(file.path))));
          let body = text ? file.body ?? "" : "";
          if (text) {
            if (file.binary || /[\u0000-\u0008\u000b\u000e-\u001f]/u.test((file.html ?? "") + body)) throw new Error("Non-text body");
            if (kind === "artifact" || /\.html?$/i.test(file.path ?? "")) body = fileSearchHTMLText(file.html ?? body);
          }
          save(file, [metadata[0], metadata[1], text ? file.summary.normalize("NFC") : "",
            Array.from(body.normalize("NFC")).slice(0, 65536).join("")]);
          processed++;
        } catch (error) {
          // No source contents in logs. Even SQL/FTS failures must not prevent schema upgrades or source writes.
          console.warn(`[file-search] file=${JSON.stringify(file.id)} metadata-only fallback (${error instanceof Error ? error.name : "index error"})`);
          try { save(file, metadata); processed++; }
          catch { /* Keep pending when even the metadata projection cannot be written. */ }
        }
        // One bounded input may exceed the budget; always yield before attempting the next one.
        if (performance.now() - started >= 10) break;
      }
      if (processed) db.exec(`UPDATE file_search_migration_audit SET indexed_files=(SELECT COUNT(*) FROM file_search_documents),
        completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1 AND completed_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM file_search_pending)`);
      return processed;
    })();
  } catch (error) {
    console.warn(`[file-search] backfill deferred (${error instanceof Error ? error.name : "index error"}); pending rows will retry`);
    return 0;
  }
}

/** Start only after openDb returns. Each timer commits a small batch and yields to HTTP/I/O. */
export function scheduleFileSearchBackfill(db: Database): void {
  try {
    if (!db.query("SELECT 1 FROM file_search_pending LIMIT 1").get()) return;
  } catch { return; }
  const tick = () => {
    // The owner may close the connection before this timer fires (tests, restore, shutdown).
    try { db.query("SELECT 1").get(); } catch { return; }
    const processed = refreshFileSearchIndex(db, { limit: 16 });
    try {
      if (processed && db.query("SELECT 1 FROM file_search_pending LIMIT 1").get()) setTimeout(tick, 10).unref();
    } catch { /* Retry on the next open/refresh; never surface a background rejection. */ }
  };
  setTimeout(tick, 10).unref();
}

function fileSearchHTMLText(html: string): string {
  let text = "", hidden = 0;
  new HTMLRewriter().on("*", {
    element(element) {
      if (["script", "style", "template", "noscript"].includes(element.tagName)) {
        if (element.canHaveContent) {
          hidden++;
          element.onEndTag(() => { hidden--; });
        }
      } else if (!hidden && ["p", "div", "br", "li", "tr", "td", "th", "h1", "h2", "h3", "section", "article"].includes(element.tagName)) {
        text += " ";
        if (element.canHaveContent) element.onEndTag(() => { text += " "; });
      }
    },
    text(chunk) { if (!hidden) text += chunk.text; },
  }).transform(html);
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, value: string) => {
    if (value[0] !== "#") return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[value.toLowerCase()] ?? entity;
    const point = value[1].toLowerCase() === "x" ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "�";
  }).replace(/\s+/g, " ").trim();
}

export interface NewDelivery {
  sourceRevision?: string | null;
  nextAttemptAt?: string | null;
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

/** 가져온 프로젝트의 못 읽은 말에 붙는 표시. 재시작 정리는 이 표시의 코드(held_import)로 이 말을 실패로 바꾸지 않게 가른다. */
export { IMPORT_HOLD_NOTE } from "./hold-codes.ts";

export const DEFAULT_SETTINGS: Settings = {
  backend: "core",
  permissionMode: "bypassPermissions",
  ranks: DEFAULT_RANKS,
  codexRanks: DEFAULT_CODEX_RANKS,
  // Gemini(Antigravity CLI)의 직급표. settings 표의 키 하나라 DB 를 바꾸지 않고, 옛 판으로 되돌려도 무시된다.
  geminiRanks: DEFAULT_GEMINI_RANKS,
  maxConcurrentTurns: 4,
  compactAtPct: 70,
  contextWindowDefault: DEFAULT_CONTEXT_WINDOW,
  contextWindows: { ...DEFAULT_CONTEXT_WINDOWS },
  maxAwakeWorkers: 8,
  notifyMac: false,
  macScriptNotifications: true,
  boardTidyHours: 6,
  // 저장된 값이 없는 DB 는 이 Store 를 처음 열 때 정한다(initPermissionAcknowledged). 여기 값은 그 전의 안전한 기본이다.
  permissionAcknowledged: true,
  // B1: 늘 내려 보내 앱이 '이 서버는 보고 언어를 안다'고 알게 한다. settings 표의 키 하나라 옛 판으로 되돌려도 무시된다.
  reportLanguage: "ko",
};

/** 대표가 새 프로젝트를 만들며 신뢰한다고 답한 폴더(프로젝트 id → 그때의 폴더). settings 표의 별도 키라 스키마를 바꾸지 않는다. */
const FOLDER_TRUST_KEY = "folderTrust";
/** 재시작으로 꺼졌고 아직 다시 열지 않은 팀장의 표식(팀장 id → RestartWake). 같은 까닭으로 settings 표의 별도 키다. */
const RESTART_WAKE_KEY = "restartWake";

/** 이 설치가 Tailscale 주소를 연 적이 있다는 기록({ address, at }). 같은 표의 별도 키라 설정 응답에는 나가지 않는다. */
const TAILNET_SEEN_KEY = "tailnetSeen";
/** 0.2.7(D4-3): 지금 이어지는 Tailscale 꺼짐에 iPhone 알림을 이미 냈다는 기록({ since }). 서버를 다시 띄워도 같은 꺼짐에 다시 알리지 않는다. */
const TAILNET_PHONE_ALERT_KEY = "tailnetPhoneAlert";
/** C8: 대표가 켠 HTTPS 주소(tailscale serve)의 기록({ url, port, at }). 같은 표의 별도 키라 설정 응답에 나가지 않고 이전 판도 무시한다. */


/** 막힘의 까닭은 관측 기록의 오류 코드에서 읽는다. 막힘이 아니면 싣지 않는다. */
function blockedCodeOf(status: string, observation: Member["statusObservation"]): BlockedCode | undefined {
  if (status !== "blocked") return undefined;
  const code = observation?.error?.code;
  return BLOCKED_CODES.find(known => known === code);
}

type TimeField = "createdAt" | "updatedAt" | "answeredAt" | "deliveredAt" | "doneAt";
const RESTORABLE_TIMES = {
  decisions: { createdAt: "created_at", answeredAt: "answered_at", deliveredAt: "delivered_at" },
  todos: { createdAt: "created_at", doneAt: "done_at" },
  work: { createdAt: "created_at", updatedAt: "updated_at", doneAt: "done_at" },
  files: { createdAt: "created_at" },
} as const;

/**
 * 0.2.10: 프로젝트의 살아 있는 전달. 아직 전달되지 않았거나(status != 'delivered', 색인 deliveries_open) 전달됐어도 확인이 끝나지 않은 것
 * (복구 phase 가 checking·waiting·retry_wait·needs_owner, 색인 delivery_recovery_due). 만든 순서(rowid).
 * 전달 알림(DeliveryRecovery.item)이 내보낼 수 있는 전달은 모두 여기 든다: 알림은 전달되지 않은 것이거나 phase 가 끝나지 않은 duplicate_draft 다.
 * phase 'none' 은 사유가 언제나 NULL 이다(넣을 때 기본값, 다시 none 으로 돌릴 때도 reason: null). 전달되고 phase 가 resolved·stopped·none 인
 * 이력은 읽지 않는다. 아래 두 조건은 db.ts LIVE_INDEXES 의 부분 색인과 글자까지 같아야 한다(tests/record-retention.test.ts).
 */
const LIVE_DELIVERIES_SQL = `SELECT * FROM deliveries WHERE rowid IN (
    SELECT rowid FROM deliveries WHERE project_id = ? AND status != 'delivered'
    UNION ALL SELECT d.rowid FROM delivery_recovery r CROSS JOIN deliveries d ON d.id = r.delivery_id
      WHERE r.phase IN ('checking','waiting','retry_wait','needs_owner') AND d.project_id = ?)
  ORDER BY rowid`;

/** 결과 보고 누락 안내 글의 id 는 이 접두사 + 실행 id 다(Orchestrator). END 는 접두사 끝 글자 '_'(0x5F)의 다음 글자 '`'로 바꾼 것: [접두사, END) 가 그 접두사로 시작하는 id 전부. */
const MISSING_REPORT_PREFIX = "msg_missing_report_";
const MISSING_REPORT_END = "msg_missing_report`";

/** 이 글자로 시작하는 쓰기는 고아 보고 점검의 물높이를 버린다(Store.run). 전달·팀장·프로젝트 행을 지우거나 팀장을 만드는 문장은 모두 Store.run 을 거친다. */
const REPORT_SCAN_RESET = ["DELETE FROM deliveries", "DELETE FROM members", "DELETE FROM projects", "INSERT INTO members"];

const HANDLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const MAX_ACTIVITY_PER_MEMBER = 500;
// 도구 결과 하나가 수 MB 일 수 있다. 활동 판은 훑어보는 용도라 잘라도 된다.
const MAX_ACTIVITY_TEXT = 4000;
// 현재 세대의 마지막 생성 순서를 따른다. 이전 journal의 늦은 갱신은 새 작업을 덮지 않는다.
const MEMBER_SELECT = `SELECT m.*, (SELECT COUNT(*) FROM deliveries d WHERE d.member_id = m.id AND d.status IN ('queued','held')) AS queued_count,
  (SELECT c.measurement_json FROM member_context_state c WHERE c.member_id = m.id AND c.generation = m.session_generation) AS measurement_json,
  (SELECT c.compaction_json FROM member_context_state c WHERE c.member_id = m.id AND c.generation = m.session_generation) AS compaction_json,
  (SELECT c.member_id FROM member_context_state c WHERE c.member_id = m.id AND c.generation = m.session_generation) AS context_member_id,
  l.operation_id AS lifecycle_operation_id, l.intent AS lifecycle_intent, l.phase AS lifecycle_phase,
  l.reason AS lifecycle_reason, l.exit_code AS lifecycle_exit_code, l.updated_at AS lifecycle_updated_at,
  e.run_id AS execution_run_id, e.turn AS execution_turn, e.delivery_ids_json AS execution_delivery_ids_json,
  e.phase AS execution_phase, e.input_received_at AS execution_input_received_at, e.started_at AS execution_started_at,
  e.last_progress_at AS execution_last_progress_at, e.ended_at AS execution_ended_at,
  e.result AS execution_result, e.reason AS execution_reason, e.exit_code AS execution_exit_code
  FROM members m
  LEFT JOIN lifecycle_journal l ON l.rowid = (
    SELECT j.rowid FROM lifecycle_journal j
    WHERE j.member_id = m.id AND j.project_id = m.project_id AND j.generation = m.session_generation
    ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1)
  LEFT JOIN execution_journal e ON e.rowid = (
    SELECT j.rowid FROM execution_journal j
    WHERE j.member_id = m.id AND j.project_id = m.project_id AND j.generation = m.session_generation
    ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1)`;

// SQL 행은 컬럼 이름이 곧 스키마(db.ts)다. 아래 toX 함수가 타입 경계다.
type Row = Record<string, any>;
/** 답 창 안이지만 그 글과 무관한 실행이 돈 구간(만든 때 ~ 끝난 때, 끝나지 않았으면 null). 핫픽스 C. */
type ReplySpan = { from: string; to: string | null };

function json<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
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
    creationGoal: r.creation_goal ?? null,
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

function lifecyclePhase(intent: LifecycleJournal["intent"], phase: LifecycleJournal["phase"]): MemberLifecycleState["phase"] {
  switch (phase) {
    case "confirmed": return intent === "start" ? "started_confirmed" : "stopped_confirmed";
    case "refused": return "refused";
    case "unknown": return intent === "start" ? "starting_unknown" : "stopping_unknown";
    default: return intent === "start" ? "starting" : intent === "close" ? "closing" : "stopping";
  }
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
    contextWindow: r.context_window ?? null,
    contextWindowSource: r.context_window_source ?? null,
    subagents: r.subagents,
    parallel: !!r.parallel,
    queuedCount: r.queued_count,
    lastError: r.last_error,
    ...(r.fence_code ? { fenceCode: r.fence_code } : {}),
    ...lastErrorCodeField(r.last_error),
    lastActiveAt: r.last_active_at ?? null,
    updatedAt: r.updated_at,
    createdAt: r.created_at,
    statusObservation: r.status_observation_json === null ? null : json<Member["statusObservation"]>(r.status_observation_json),
    blockedReason: r.blocked_reason,
    ...(() => {
      const blockedCode = blockedCodeOf(r.status, r.status_observation_json === null ? null : json<Member["statusObservation"]>(r.status_observation_json));
      return blockedCode ? { blockedCode } : {};
    })(),
    subagentState: r.subagent_state_json === null ? null : json<Member["subagentState"]>(r.subagent_state_json),
    nowAt: r.now_at,
    manualActivityAt: r.manual_activity_at,
    lifecycleState: r.lifecycle_operation_id === null ? null : {
      operationId: r.lifecycle_operation_id,
      sessionGeneration: r.session_generation,
      intent: r.lifecycle_intent,
      phase: lifecyclePhase(r.lifecycle_intent, r.lifecycle_phase),
      reason: r.lifecycle_reason,
      exitCode: r.lifecycle_exit_code,
      updatedAt: r.lifecycle_updated_at,
    },
    executionState: r.execution_run_id === null ? null : {
      runId: r.execution_run_id,
      sessionGeneration: r.session_generation,
      turn: r.execution_turn,
      deliveryIds: json<string[]>(r.execution_delivery_ids_json),
      phase: r.execution_phase,
      inputReceivedAt: r.execution_input_received_at,
      startedAt: r.execution_started_at,
      lastProgressAt: r.execution_last_progress_at,
      endedAt: r.execution_ended_at,
      result: r.execution_result,
      reason: r.execution_reason,
      exitCode: r.execution_exit_code,
    },
    ...(r.context_member_id ? { contextState: { measurement: r.measurement_json === null ? null : json<CoreContextState["measurement"]>(r.measurement_json), compaction: r.compaction_json === null ? null : json<CoreContextState["compaction"]>(r.compaction_json) } } : {}),
  };
}

function toDecision(r: Row): Decision {
  const decision = toDecisionBase(r);
  // Y: 서버가 만든 카드의 글 코드. 열(text_ref)이 없는 옛 DB 나 맞지 않는 코드는 싣지 않는다.
  return { ...decision, ...decisionTextFields(r.text_ref, decision) };
}

function toDecisionBase(r: Row): Decision {
  return {
    ...(r.usage_limit_json ? { kind: "usage_limit" as const, usageLimit: json<NonNullable<Decision["usageLimit"]>>(r.usage_limit_json) } : {}),
    // K(E2): 도구 승인 카드. 열(tool_permission_json)은 db.ts 의 ensureToolPermissionColumn 이 더한다.
    ...(r.tool_permission_json ? { kind: "tool_permission" as const, toolPermission: json<NonNullable<Decision["toolPermission"]>>(r.tool_permission_json) } : {}),
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
    // 0.2.7 묶음 4: 있을 때만 싣는다(열은 db.ts ensureRevisionColumns).
    ...(r.replaces ? { replaces: r.replaces as string } : {}),
    ...(r.replaced_by ? { replacedBy: r.replaced_by as string } : {}),
    ...(r.answer_attachments && r.answer_attachments !== "[]" ? { answerAttachments: json<Attachment[]>(r.answer_attachments) } : {}),
    ...(r.last_answer_attachments && r.last_answer_attachments !== "[]" ? { lastAnswerAttachments: json<Attachment[]>(r.last_answer_attachments) } : {}),
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
    completionNote: r.completion_note ?? null,
    completionFileIds: json(r.completion_file_ids ?? "[]"),
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
    delivery: r.delivery === "dismissed" ? "held" : r.delivery,
    ...(r.delivery === "dismissed" ? { deliveryDisposition: "dismissed" as const } : {}),
    deliveryNote: r.delivery_note,
    ...(r.delivery_code ? { deliveryCode: r.delivery_code } : {}),
    deliveryRevision: r.delivery_revision,
    contextFileId: r.context_file_id ?? null,
    // Y: 서버가 만든 글의 코드. 문장이 코드와 맞을 때만.
    ...messageTextFields(r.text_ref, r.title, r.body),
  };
}

/** 0.2.10: 끝난 할 일·업무의 쪽 위치. (정렬 열쇠, id)를 base64url JSON 으로 싼다. 앱은 받은 그대로 돌려줄 뿐 풀지 않는다. */
function encodeDoneCursor(key: string, id: string): string {
  return Buffer.from(JSON.stringify([key, id])).toString("base64url");
}
function parseDoneCursor(raw: string): [string, string] {
  if (raw.length > 0 && raw.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(raw)) {
    try {
      const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string") return [value[0], value[1]];
    } catch { /* 아래에서 거절한다 */ }
  }
  throw new ApiError(400, "조회 조건이 잘못되었습니다", "invalid_query");
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

// html(아티팩트 원본)은 getFileHtml로만 읽는다. 목록·단건 조회가 매번 통째로 읽지 않게 열을 명시한다.
const FILE_COLUMNS = "id, kind, project_id, title, who, member_id, summary, body, path, attachments, created_at, sort_order";
/** 0.2.10: 본문을 뺀 목록(lite). kind 가 없는 예전 자료만 본문이 비었는지 본다(CASE 라 kind 가 있는 행은 본문을 읽지 않는다). */
const FILE_LITE_COLUMNS = "id, kind, project_id, title, who, member_id, summary, CASE WHEN kind IS NULL THEN body <> '' END AS body_present, path, attachments, created_at, sort_order";
/** 0.2.10 창 묶음: 끝난 할 일·업무를 최근 끝낸 순서로 이만큼(24시간 안에 끝낸 것이 더 많으면 그것 전부) 싣는다. 쪽 받기의 기본 개수도 같다. */
export const STATE_WINDOW_DONE = 50;
export const STATE_WINDOW_RECENT_MS = 86_400_000;
export const DONE_PAGE_MAX = 200;
/** 끝난 할 일·업무의 정렬 열쇠(최근 끝낸 것이 먼저, 같으면 id 큰 것이 먼저). 쪽 위치(cursor)도 이 두 값이다. */
const TODO_DONE_KEY = "COALESCE(done_at, created_at)";
const WORK_DONE_KEY = "COALESCE(done_at, updated_at, created_at)";
export interface StateReadOptions {
  /** 자료 본문을 DB 에서 읽지 않는다(응답의 lite=1 과 같다). */
  lite?: boolean;
  /** 0.2.10 창 묶음(ProjectState.window). 새 앱만 요청한다. */
  window?: boolean;
}

function toFile(r: Row): FileDoc {
  const attachments = json<Attachment[]>(r.attachments);
  // 0.2.10: lite 목록(FILE_LITE_COLUMNS)은 본문을 읽지 않는다. 본문 칸은 빈 글자로 두고(보내는 쪽 liteFile 이 칸을 뺀다),
  // kind 가 없는 예전 자료는 '본문이 있는가'(body_present)만으로 정한다(deriveFileKind 는 본문의 유무만 본다).
  const lite = !("body" in r);
  return {
    id: r.id,
    kind: r.kind ?? deriveFileKind(lite ? (r.body_present ? "-" : "") : r.body, attachments),
    projectId: r.project_id,
    title: r.title,
    who: r.who,
    memberId: r.member_id,
    summary: r.summary,
    body: lite ? "" : r.body,
    path: r.path,
    attachments,
    createdAt: r.created_at,
    order: r.sort_order,
    // 0.2.7 묶음 4: 판 갈이. 있을 때만 싣는다.
    ...(r.replaces ? { replaces: r.replaces as string } : {}),
    ...(r.replaced_by ? { replacedBy: r.replaced_by as string } : {}),
  };
}

/** 0.2.10: 판 연결은 덮는 색인에서 따로 읽어 행에 붙인다(Store.fileLinkOf). toFile 이 예전처럼 있을 때만 싣는다. */
function withFileLink(r: Row, link: Row | undefined): Row {
  if (link) { r.replaces = link.replaces; r.replaced_by = link.replaced_by; }
  return r;
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
    ...(r.next_attempt_at !== null && r.next_attempt_at !== undefined ? { nextAttemptAt: r.next_attempt_at } : {}),
  };
}

function toActivity(r: Row): Activity {
  return { id: r.id, memberId: r.member_id, at: r.at, kind: r.kind, text: r.text, ...activityTextFields(r.text_ref, r.text) };
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
  cli: "cli",
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
  contextWindow: "context_window",
  contextWindowSource: "context_window_source",
  subagents: "subagents",
  parallel: "parallel",
  lastError: "last_error",
  fenceCode: "fence_code",
  statusObservation: "status_observation_json",
  blockedReason: "blocked_reason",
  subagentState: "subagent_state_json",
  nowAt: "now_at",
  manualActivityAt: "manual_activity_at",
};

function checkMemberText(name: string | undefined, role: string | undefined, kind: MemberKind): void {
  // 총괄·본사 AI 의 이름은 서버가 정한다. 직원만 대표·총괄처럼 보이는 이름을 못 쓴다.
  const problem = (name !== undefined && (kind === "worker" ? workerNameProblem(name) : nameProblem(name))) || null;
  if (problem) throw new ApiError(400, `이름이 잘못되었습니다: ${problem}`, "name_invalid");
  const roleProblem = role !== undefined ? oneLineProblem(role, MAX_ROLE) : null;
  if (roleProblem) throw new ApiError(400, `역할이 잘못되었습니다: ${roleProblem}`, "role_invalid");
}

function checkProjectName(name: string | undefined): void {
  const problem = name !== undefined ? oneLineProblem(name, MAX_PROJECT_NAME) : null;
  if (problem) throw new ApiError(400, `프로젝트 이름이 잘못되었습니다: ${problem}`, "project_name_invalid");
}

/** 실행기가 지금 쓸 수 있는가. 모르면(아직 안 물어봄) 쓸 수 있는 것으로 친다. */
export interface RunnerHealth {
  ok: boolean;
  detail?: string | null;
}

export interface StoredContextState extends CoreContextState {
  memberId: string;
  generation: number;
  bindingNonce: string;
  rolloutPath: string | null;
  rolloutOffset: number;
  baseline: Record<string, unknown> | null;
  updatedAt: string;
}

export interface ExecutionJournal {
  runId: string;
  memberId: string;
  projectId: string;
  identity: RunnerTerminalIdentity;
  turn: number | null;
  deliveryIds: string[];
  phase: "received" | "starting" | "running" | "ended" | "interrupted" | "unknown";
  inputReceivedAt: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  endedAt: string | null;
  result: "success" | "error" | "interrupted" | null;
  reason: string | null;
  exitCode: number | null;
  interruptionNotifiedAt: string | null;
  reportRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryRetryState {
  nextAttemptAt: string | null;
  sourceRevision: string | null;
  retryScope: string | null;
  retryReason: string | null;
  correctionRevision: number | null;
}

/**
 * 저장소가 전달 펌프 쪽에 부탁하는 일. 대기 사유는 여기서 읽지 않는다(펌프가 남긴 판정 줄을 읽는다).
 * - recheck: 대표가 '다시 확인'을 눌렀다(이어가기를 포기한 팀장도 다시 보내 본다).
 * - nudge: 정체로 알리기 전에 한 번 스스로 다시 밀어 본다(입력은 하지 않는다).
 * - judge: 아직 판정 줄이 없는 팀장을 펌프가 판정하게 한다(재시도 간격은 그대로 둔다). 업그레이드 첫 시작처럼 판정 표가 빈 때.
 */
export interface DeliveryHooks {
  recheck?: (memberId: string) => void;
  nudge?: (memberId: string) => void;
  judge?: (memberId: string) => void;
}

/** member_delivery_verdicts 한 줄. 알 수 없는 사유(다른 판의 서버가 적은 값)는 '이유 없는 대기'로 읽는다. */
function toPumpVerdict(row: Row): StoredPumpVerdict {
  let detail: { runLimit?: { used?: unknown; limit?: unknown } } = {};
  try { if (row.detail_json) detail = json(row.detail_json) ?? {}; } catch { /* 읽을 수 없는 상세는 버린다 */ }
  const limit = detail.runLimit;
  return { memberId: row.member_id, code: row.code, waitReason: isDeliveryWaitReason(row.wait_reason) ? row.wait_reason : "unknown", since: row.since,
    runLimit: limit && Number.isInteger(limit.used) && Number.isInteger(limit.limit) ? { used: limit.used as number, limit: limit.limit as number } : null,
    overdueAt: row.overdue_at ?? null, updatedAt: row.updated_at };
}

export class Store implements MessageReadStore, ProjectPatchStore, RunnerRecoveryStore {
  readonly db: Database;
  private readonly sqlTransaction: Database["transaction"];
  private commitFrames: (() => void)[][] = [];
  private lastMessageMs = 0;
  /**
   * 0.2.10: 읽기 묶음은 프로젝트의 전달 이력 전체가 아니라 살아 있는 전달(LIVE_DELIVERIES_SQL)과 그 복구 기록만 미리 읽는다.
   * 나머지(끝난 전달, 조립하는 글의 보고 출처·정정·대표 글 전달)는 키로 바로 읽거나 messagesFrom 이 쪽의 글 id 로 한 번에 읽는다.
   * 묶음 안에서는 쓰지 않으므로(run 이 막는다) 미리 읽은 값과 바로 읽은 값은 같다.
   */
  private deliveryRead: {
    projectId: string; live: Delivery[]; rows: Map<string, Row>; recoveries: Map<string, Row>;
    stalls: Set<string>; startedRuns: Map<string, number>; verdicts: Map<string, StoredPumpVerdict | null>;
    messageDeliveries: Map<string, Delivery[]>;
    /** listDeliveries(이 프로젝트)를 부른 때만 읽는 전체 이력. 자주 도는 길은 부르지 않는다. */
    all: Delivery[] | null;
    /** 글 id → 보고 출처 행 / 그 글을 정정한 글 / 그 대표 글의 마지막 전달 id. 없음(null)도 적는다. */
    reportRefs: Map<string, Row | null>; superseded: Map<string, string | null>; ownerDeliveries: Map<string, string | null>;
    memo: Map<string, unknown>;
  } | null = null;

  /** Request-local read snapshot. Never survives a synchronous read or caches runtime wait state across requests. */
  withDeliveryRead<T>(projectId: string, read: () => T): T {
    if (this.deliveryRead?.projectId === projectId) return read();
    const previous = this.deliveryRead;
    const rows = this.rows(LIVE_DELIVERIES_SQL, projectId, projectId);
    const messageDeliveries = new Map<string, Delivery[]>();
    for (const row of rows) if (row.ref_type === "message" && !["delivered", "failed"].includes(row.status)) {
      const own = messageDeliveries.get(row.ref_id) ?? [];
      own.push(toDelivery(row)); messageDeliveries.set(row.ref_id, own);
    }
    this.deliveryRead = { projectId, rows: new Map(rows.map(row => [row.id, row])), live: rows.map(toDelivery),
      recoveries: new Map((rows.length ? this.rows("SELECT r.* FROM json_each(?) j CROSS JOIN delivery_recovery r ON r.delivery_id = j.value", JSON.stringify(rows.map(row => row.id))) : []).map(row => [row.delivery_id, row])),
      // 풀리지 않은 정체 표시는 몇 줄뿐이다. 그 표에서 출발한다(전달 이력에서 출발하면 이력 전체를 훑는다).
      stalls: new Set(this.rows("SELECT s.delivery_id FROM delivery_stalls s CROSS JOIN deliveries d ON d.id = s.delivery_id WHERE s.resolved_at IS NULL AND d.project_id = ?", projectId).map(row => row.delivery_id)),
      // 그 프로젝트의 팀장마다 펌프의 마지막 판정(없으면 null). 전달마다 따로 읽지 않는다.
      verdicts: new Map(this.verdictsReady ? this.rows("SELECT m.id AS owner_id, v.* FROM members m LEFT JOIN member_delivery_verdicts v ON v.member_id = m.id WHERE m.project_id = ?", projectId)
        .map(row => [row.owner_id as string, row.member_id ? toPumpVerdict(row) : null]) : []),
      startedRuns: new Map(this.rows("SELECT member_id, MAX(rowid) AS last_run FROM execution_journal WHERE project_id = ? AND started_at IS NOT NULL GROUP BY member_id", projectId).map(row => [row.member_id, row.last_run])),
      messageDeliveries, all: null, reportRefs: new Map(), superseded: new Map(), ownerDeliveries: new Map(), memo: new Map() };
    try {
      const result = read();
      if (result instanceof Promise) throw new Error("withDeliveryRead requires a synchronous callback");
      return result;
    } finally { this.deliveryRead = previous; }
  }

  /**
   * 조립할 글들의 보고 출처·정정한 글·(대표 글이면) 마지막 대표 글 전달을 한 번에 읽어 묶음에 적는다. 예전에는 묶음을 만들 때
   * 프로젝트의 보고 출처와 전달 전체를 읽어 두었다. 값은 글마다 따로 읽는 것(getReportReferences·messageFrom·ownerDelivery)과 같다.
   */
  private prefetchMessageReads(projectId: string, rows: Row[]): void {
    const read = this.deliveryRead;
    if (!read || read.projectId !== projectId) return;
    const ids = rows.map(row => row.id as string).filter(id => !read.reportRefs.has(id));
    if (ids.length) {
      const list = JSON.stringify(ids);
      for (const id of ids) { read.reportRefs.set(id, null); read.superseded.set(id, null); }
      for (const row of this.rows("SELECT * FROM report_references WHERE source_message_id IN (SELECT value FROM json_each(?)) AND +project_id = ?", list, projectId)) read.reportRefs.set(row.source_message_id, row);
      // 같은 글을 여러 번 정정했으면 마지막(sequence, rowid) 것. 글마다 읽는 쿼리의 ORDER BY sequence DESC, rowid DESC LIMIT 1 과 같다.
      for (const row of this.rows(`SELECT corrects_message_id, source_message_id FROM report_references WHERE corrects_message_id IS NOT NULL
        AND corrects_message_id IN (SELECT value FROM json_each(?)) AND +project_id = ? ORDER BY sequence, rowid`, list, projectId)) read.superseded.set(row.corrects_message_id, row.source_message_id);
    }
    const mine = rows.filter(row => row.mine && !read.ownerDeliveries.has(row.id)).map(row => row.id as string);
    if (mine.length) {
      for (const id of mine) read.ownerDeliveries.set(id, null);
      // rowid 차례로 읽는다. 같은 글의 뒤 전달이 앞 것을 덮는다(받는 이가 바뀌어 여러 번 생긴 것).
      for (const row of this.rows(`SELECT ref_id, id FROM deliveries WHERE ref_type = 'message' AND ref_id IN (SELECT value FROM json_each(?))
        AND kind = 'user_message' AND +project_id = ? ORDER BY rowid`, JSON.stringify(mine), projectId)) read.ownerDeliveries.set(row.ref_id, row.id);
    }
  }

  private deliveryReadMemo<T>(key: string, read: () => T): T {
    if (!this.deliveryRead) return read();
    if (!this.deliveryRead.memo.has(key)) this.deliveryRead.memo.set(key, read());
    return this.deliveryRead.memo.get(key) as T;
  }

  /**
   * 전달 알림의 원문 미리보기(`종류:id` → 본문·제목). deliveries 를 주면(0.2.10, 알림으로 내보낼 전달들) 그 전달들이 가리키는 원문만 읽는다.
   * 주지 않으면 예전처럼 그 프로젝트의 전달이 가리킨 원문 전부. 그 전달들에 대한 값은 어느 쪽이든 같다.
   */
  deliveryNoticePreviews(projectId: string, deliveries?: Delivery[]): Map<string, string> {
    const previews = new Map<string, string>();
    for (const [type, table, column] of [["message", "messages", "body"], ["decision", "decisions", "title"], ["todo", "todos", "title"]]) {
      const rows = deliveries === undefined
        ? this.rows(`SELECT id, ${column} AS preview FROM ${table} WHERE id IN (SELECT ref_id FROM deliveries WHERE project_id = ? AND ref_type = ?)`, projectId, type)
        : this.rows(`SELECT id, ${column} AS preview FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`,
          JSON.stringify([...new Set(deliveries.filter(d => d.projectId === projectId && d.refType === type && d.refId !== null).map(d => d.refId!))]));
      for (const row of rows) previews.set(`${type}:${row.id}`, row.preview);
    }
    return previews;
  }

  listUnlinkedFailedMessages(projectId: string): Message[] {
    // 0.2.10: 실패한 대표 글만 담은 부분 색인(messages_owner_failed)에서 출발하고, 전달 확인은 ref 색인으로 한다(+d.project_id).
    return this.rows(`SELECT m.* FROM messages m WHERE m.project_id = ? AND m.mine = 1 AND m.delivery = 'failed'
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.ref_type = 'message' AND d.ref_id = m.id AND +d.project_id = m.project_id)
      ORDER BY m.at DESC, m.id DESC`, projectId).map(toMessage);
  }
  private recheckPending: ((memberId: string) => void) | null = null;
  private stallNudge: ((memberId: string) => void) | null = null;
  private judgeMember: ((memberId: string) => void) | null = null;
  /** 판정 줄이 없어 펌프에 판정을 처음 부탁한 시각(팀장별). 판정이 남거나 기다리는 전달이 없어지면 지운다. */
  private readonly judgeAsked = new Map<string, number>();
  /** 정체로 알리기 전에 한 번 스스로 다시 밀어 본 전달. */
  private readonly stallNudged = new Set<string>();
  /** 판정 표(member_delivery_verdicts)를 쓸 수 있는가. 만들지 못했으면 판정 없이(이유 없는 대기로) 읽는다. */
  private verdictsReady = false;

  /** failed 는 실패한 시각과 같은 설정으로 실패한 횟수를 함께 적는다(꺼진 세션을 다시 여는 간격에 쓴다). 옛 판은 두 값을 무시한다. */
  deferMemberConfig(memberId: string, signature: string, failed = false): void {
    const before = failed ? this.deferredMemberConfig(memberId) : null;
    this.run("UPDATE members SET config_deferred_json = ? WHERE id = ?", JSON.stringify(failed
      ? { signature, failed, failedAt: nowIso(), attempts: (before?.failed && before.signature === signature ? before.attempts ?? 1 : 0) + 1 }
      : { signature, failed }), memberId);
  }

  deferredMemberConfig(memberId: string): { signature: string; failed: boolean; failedAt?: string; attempts?: number } | null {
    const row = this.row("SELECT config_deferred_json FROM members WHERE id = ?", memberId);
    return row?.config_deferred_json ? json(row.config_deferred_json) : null;
  }

  /** 대표가 다시 확인을 눌렀다. 실패한 설정으로 다시 여는 것을 간격을 기다리지 않고 해 본다. */
  retryDeferredConfigNow(memberId: string): void {
    const deferred = this.deferredMemberConfig(memberId);
    if (deferred?.failed && deferred.failedAt) this.run("UPDATE members SET config_deferred_json = ? WHERE id = ?", JSON.stringify({ ...deferred, failedAt: new Date(0).toISOString() }), memberId);
  }

  clearDeferredMemberConfig(memberId: string): void {
    this.run("UPDATE members SET config_deferred_json = NULL WHERE id = ?", memberId);
  }

  setDeliveryHooks(hooks: DeliveryHooks): void {
    this.recheckPending = hooks.recheck ?? null;
    this.stallNudge = hooks.nudge ?? null;
    this.judgeMember = hooks.judge ?? null;
  }

  recheckPendingDelivery(memberId: string): void {
    this.afterCommit(() => this.recheckPending?.(memberId));
  }

  /** 전달 펌프가 남긴 이 팀장의 마지막 판정. 아직 판정한 적이 없으면 null. */
  pumpVerdict(memberId: string): StoredPumpVerdict | null {
    if (!this.verdictsReady) return null;
    if (this.deliveryRead?.verdicts.has(memberId)) return this.deliveryRead.verdicts.get(memberId) ?? null;
    const row = this.row("SELECT * FROM member_delivery_verdicts WHERE member_id = ?", memberId);
    return row ? toPumpVerdict(row) : null;
  }

  /**
   * 전달 펌프가 판정을 남긴다(pumpOnce 의 return 마다, 그리고 오래 걸리는 단계에 들어갈 때). 값이 바뀔 때만 쓴다.
   * 같은 판정이 이어지면 since 와 기한 넘김 표시를 그대로 둔다. 화면에 보이는 값이 바뀌었고 기다리는 전달이 있으면 member 이벤트를 낸다.
   * 판정을 적지 못해도 전달은 막지 않는다(그때 화면은 '이유 없는 대기'로 보고 정체 점검이 다시 민다).
   */
  recordPumpVerdict(memberId: string, verdict: PumpVerdict, at = Date.now()): void {
    if (!this.verdictsReady || this.deliveryRead) return;
    const wait = verdictWait(verdict.code);
    const detail = verdict.runLimit ? JSON.stringify({ runLimit: { used: verdict.runLimit.used, limit: verdict.runLimit.limit } }) : null;
    try {
      const before = this.row("SELECT code, wait_reason, detail_json, overdue_at FROM member_delivery_verdicts WHERE member_id = ?", memberId);
      if (before && before.code === verdict.code && before.wait_reason === wait && (before.detail_json ?? null) === detail) return;
      const iso = new Date(at).toISOString();
      this.run(`INSERT INTO member_delivery_verdicts (member_id, code, wait_reason, since, detail_json, overdue_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(member_id) DO UPDATE SET code = excluded.code, wait_reason = excluded.wait_reason, detail_json = excluded.detail_json, updated_at = excluded.updated_at,
          since = CASE WHEN member_delivery_verdicts.code = excluded.code THEN member_delivery_verdicts.since ELSE excluded.since END,
          overdue_at = CASE WHEN member_delivery_verdicts.code = excluded.code THEN member_delivery_verdicts.overdue_at ELSE NULL END`,
        memberId, verdict.code, wait, iso, detail, iso);
      const visible = !before || before.wait_reason !== wait || (before.detail_json ?? null) !== detail || (before.code !== verdict.code && !!before.overdue_at);
      if (visible && this.row("SELECT 1 FROM deliveries WHERE member_id = ? AND status IN ('queued','held','delivering') LIMIT 1", memberId)) this.emitMember(memberId);
    } catch (e) {
      // 지운 팀장(외래 키) 등. 같은 실패를 펌프마다 쏟지 않게 한 줄로만 남긴다.
      if (this.getMember(memberId)) console.warn("전달 판정을 적지 못했습니다:", memberId, (e as Error).message);
    }
  }

  deliveryWait(delivery: Delivery): DeliveryWaitInfo {
    return this.deliveryReadMemo(`wait:${delivery.id}`, () => this.rawDeliveryWait(delivery));
  }

  /**
   * 화면의 대기 사유. 그 팀장의 일(일하는 중·깨우는 중·승인 대기·직접 조작·보관·실행기·장애·한도·동시 상한·재시도 대기·수신 확인)은
   * 펌프가 남긴 판정을 그대로 읽는다. 다시 추측하지 않는다. 전달 하나하나의 사정(이 전달 자신의 수신 확인, 다음 턴에 묶인 수동 전달,
   * 이 전달의 다시 보낼 시각)만 이 전달의 기록에서 읽는다.
   */
  private rawDeliveryWait(delivery: Delivery): DeliveryWaitInfo {
    const waitingSince = delivery.createdAt;
    const verdict = this.pumpVerdict(delivery.memberId);
    // 기한을 넘긴 판정(일한다는데 CLI 는 쉬는 중, 끝나지 않는 깨우는 중)은 '이유 없는 대기'로 읽어 정체 알림과 '다시 확인'이 닿게 한다.
    const judged: DeliveryWaitReason | null = !verdict ? null : verdict.overdueAt && WATCHED_WAITS.has(verdict.waitReason) ? "unknown" : verdict.waitReason;
    if (judged && MEMBER_GATE_WAITS.has(judged)) return { waitReason: judged, waitingSince };
    // 이 전달 자신의 수신 확인. 거절이 이어져 다시 보낼 때를 기다리는 것은 수신 확인이 아니다.
    const recovery = this.getDeliveryRecovery(delivery.id);
    const backoff = recovery?.phase === "waiting" && recovery.reason === "input_busy";
    if (delivery.status === "delivering" || delivery.holdReason === "delivery_unknown" || recovery && !backoff && !["none", "resolved", "stopped"].includes(recovery.phase)) return { waitReason: "receipt_check", waitingSince };
    if (judged === "waking") return { waitReason: "waking", waitingSince };
    // A passive input belongs to the next turn, not the turn already in flight.
    // Persisted insertion order avoids same-millisecond and restart ambiguity.
    if (!delivery.wake && delivery.attempts === 0 && ["queued", "held"].includes(delivery.status) && !(this.deliveryRead?.rows.has(delivery.id)
      ? (this.deliveryRead.startedRuns.get(delivery.memberId) ?? 0) > this.deliveryRead.rows.get(delivery.id)!.next_turn_after_run
      : this.row(`
      SELECT 1 FROM execution_journal e JOIN deliveries d ON d.id = ?
      WHERE e.member_id = d.member_id AND e.project_id = d.project_id AND e.rowid > d.next_turn_after_run
        AND e.started_at IS NOT NULL LIMIT 1`, delivery.id))) {
      return { waitReason: "next_turn", waitingSince };
    }
    // Once a later turn started, leaving this passive delivery behind is
    // unexplained even while that turn is busy or the global slots are full.
    const missedNextTurn = !delivery.wake && delivery.attempts === 0;
    if (!missedNextTurn && judged === "member_busy") return { waitReason: "member_busy", waitingSince };
    if (!missedNextTurn && judged === "run_limit") return { waitReason: "run_limit", waitingSince, ...(verdict?.runLimit ? { runLimit: verdict.runLimit } : {}) };
    // 다시 보낼 시각이 아직 오지 않았다(펌프가 그 팀장의 재시도 시각을 기다리거나, 이 전달의 시각이 남았다). 그 시각이 지나고도 안 나가면 이유 없는 대기다.
    const nextAttemptAt = (this.deliveryRead?.rows.get(delivery.id) ?? this.row("SELECT next_attempt_at FROM deliveries WHERE id = ?", delivery.id))?.next_attempt_at as string | null | undefined;
    if (judged === "retry_wait" || nextAttemptAt && Date.parse(nextAttemptAt) > Date.now()) return { waitReason: "retry_wait", waitingSince };
    if (!missedNextTurn && judged === "next_turn") return { waitReason: "next_turn", waitingSince };
    return { waitReason: "unknown", waitingSince };
  }

  /**
   * 서버가 다시 뜰 때 부른다. 지난 프로세스의 판정은 사유만 이어 보이고, 기한을 재는 시각(since)과 기한 넘김 표시는 지금부터 다시 센다.
   * 그대로 두면 재시작 전에 시작한 '깨우는 중'이 다시 뜨자마자 기한을 넘긴 것으로 읽혀 거짓 정체 알림이 난다.
   */
  restartPumpVerdictClocks(at = Date.now()): void {
    if (!this.verdictsReady) return;
    const iso = new Date(at).toISOString();
    this.run("UPDATE member_delivery_verdicts SET since = ?, overdue_at = NULL, updated_at = ?", iso, iso);
  }

  /** 0.2.7 묶음 1 검토: 그 판정이 기한을 넘긴 채인 팀장들(정체 점검이 적은 overdue_at). */
  overdueVerdictMembers(code: string): string[] {
    if (!this.verdictsReady) return [];
    return this.rows("SELECT member_id FROM member_delivery_verdicts WHERE code = ? AND overdue_at IS NOT NULL", code).map(row => row.member_id as string);
  }

  /** 정체 점검: 기한을 재는 판정(일한다는데 CLI 는 쉬는 중, 깨우는 중)이 기한을 넘겼으면 그 줄에 적는다. 판정은 펌프가, 기한은 여기서 잰다. */
  private markOverdueVerdicts(memberIds: Iterable<string>, now: number, thresholdMs: number): void {
    if (!this.verdictsReady) return;
    for (const memberId of memberIds) {
      const verdict = this.pumpVerdict(memberId);
      if (!verdict || verdict.overdueAt) continue;
      const patience = verdictPatience(verdict.code, thresholdMs);
      if (patience === null || now - Date.parse(verdict.since) < patience) continue;
      this.run("UPDATE member_delivery_verdicts SET overdue_at = ? WHERE member_id = ? AND code = ? AND overdue_at IS NULL", new Date(now).toISOString(), memberId, verdict.code);
      this.emitMember(memberId);
    }
  }

  deliveryStalled(id: string): boolean {
    if (this.deliveryRead?.rows.has(id)) return this.deliveryRead.stalls.has(id);
    return !!this.row("SELECT 1 FROM delivery_stalls WHERE delivery_id = ? AND resolved_at IS NULL", id);
  }

  detectDeliveryStalls(now = Date.now(), thresholdMs = 120_000): void {
    // 풀리지 않은 정체 표시에서 출발한다. 전달된 이력 전체의 ID 목록을 매번 만들지 않는다.
    this.run("UPDATE delivery_stalls SET resolved_at = ? WHERE resolved_at IS NULL AND EXISTS (SELECT 1 FROM deliveries d WHERE d.id = delivery_stalls.delivery_id AND d.status IN ('delivered','failed'))", new Date(now).toISOString());
    const byProject = new Map<string, Delivery[]>();
    const live = new Set<string>();
    for (const delivery of this.listUndelivered()) {
      const own = byProject.get(delivery.projectId) ?? [];
      own.push(delivery); byProject.set(delivery.projectId, own);
      live.add(delivery.id);
    }
    for (const id of this.stallNudged) if (!live.has(id)) this.stallNudged.delete(id);
    const waitingMembers = new Set([...byProject.values()].flat().map(delivery => delivery.memberId));
    for (const id of this.judgeAsked.keys()) if (!waitingMembers.has(id) || this.pumpVerdict(id)) this.judgeAsked.delete(id);
    this.markOverdueVerdicts(waitingMembers, now, thresholdMs);
    const nudges = new Set<string>(), judges = new Set<string>();
    for (const [projectId, deliveries] of byProject) {
      const observations = this.withDeliveryRead(projectId, () => deliveries.map(delivery => {
        const waiting = this.deliveryWait(delivery).waitReason !== "unknown";
        // 기한을 넘긴 판정 때문에 이유 없는 대기가 됐다: 경과 시간을 기다리지 않고 곧바로 한 번 다시 밀고, 그래도 그대로면 알린다.
        const verdict = this.pumpVerdict(delivery.memberId);
        const suspect = !waiting && !!verdict?.overdueAt && WATCHED_WAITS.has(verdict.waitReason);
        // 판정 표는 있는데 이 팀장의 줄이 아직 없다(업그레이드 첫 시작, 새 판으로 처음 보는 팀장): '이유 없는 대기'가 아니라 '판정 전'이다.
        // 판정할 펌프가 붙어 있을 때만 그렇게 본다(펌프 없는 저장소·읽기 전용 도구는 예전처럼 이유 없는 대기로 다룬다).
        const unjudged = this.verdictsReady && !verdict && !!this.judgeMember;
        // 0.2.10: 이 전달의 마지막 봉투만 색인으로 찾는다(예전에는 그 팀장의 봉투 이력 전체를 읽어 걸렀다. 값은 같다).
        const progress = waiting ? delivery.createdAt : this.latestDispatchFor(delivery.memberId, delivery.id)?.updatedAt ?? delivery.createdAt;
        return { delivery, waiting, suspect, unjudged, stalled: this.deliveryStalled(delivery.id), progress };
      }));
      for (const { delivery, waiting, suspect, unjudged, stalled, progress } of observations) {
        if (waiting) {
          if (stalled) {
            this.run("UPDATE delivery_stalls SET resolved_at = ? WHERE delivery_id = ? AND resolved_at IS NULL", new Date(now).toISOString(), delivery.id);
            this.emitMember(delivery.memberId);
          }
          this.stallNudged.delete(delivery.id);
          continue;
        }
        if (stalled) continue;
        // 판정 전: 펌프가 판정하게만 하고(재시도 간격은 그대로) 알리지 않는다. '다시 밀어 봄'으로 세지도 않는다.
        // 판정이 남은 다음 점검부터 평소대로 본다. 판정 표를 만들지 못한 DB(verdictsReady=false)는 예전처럼 이유 없는 대기로 다룬다.
        // 판정을 부탁한 지 정체 기준 시간이 지나도 판정이 없으면(펌프가 막혔다 등) 아래의 평소 길(다시 밀기 → 알림)로 간다.
        if (unjudged) {
          if (now - Date.parse(progress) < thresholdMs / 2) continue;
          const asked = this.judgeAsked.get(delivery.memberId) ?? now;
          this.judgeAsked.set(delivery.memberId, asked);
          if (now - asked < thresholdMs) { judges.add(delivery.memberId); continue; }
        }
        // 알리기 전에 '다시 확인'과 같은 안전한 동작(재시도 간격을 풀고 다시 밀기)을 스스로 한 번 해 본다.
        if (this.stallNudge && !this.stallNudged.has(delivery.id) && (suspect || now - Date.parse(progress) >= thresholdMs / 2)) {
          this.stallNudged.add(delivery.id); nudges.add(delivery.memberId);
          continue;
        }
        if (!suspect && now - Date.parse(progress) < thresholdMs) continue;
        this.transaction(() => {
          this.run(`INSERT INTO delivery_stalls (delivery_id, detected_at) VALUES (?, ?)
            ON CONFLICT(delivery_id) DO UPDATE SET detected_at = excluded.detected_at, resolved_at = NULL`, delivery.id, new Date(now).toISOString());
          this.appendActivity(delivery.memberId, "error", textRef("activity.delivery_stalled"), `delivery-stalled:${delivery.id}`);
          this.createMessage({ id: `msg_delivery_stalled_${delivery.id}`, projectId: delivery.projectId, who: "시스템", kind: "시스템", text: textRef("chat.delivery_stalled", { name: this.requireMember(delivery.memberId).name }) });
        });
      }
    }
    for (const memberId of nudges) {
      try { this.stallNudge?.(memberId); } catch (e) { console.error("정체 전달 다시 밀기 실패:", memberId, e); }
    }
    for (const memberId of judges) {
      if (nudges.has(memberId)) continue;
      try { this.judgeMember?.(memberId); } catch (e) { console.error("전달 판정 요청 실패:", memberId, e); }
    }
  }

  /**
   * 그 실행의 결과 보고(그 팀장이 쓴 완료·답변·막힘·질문, 정해진 경우의 진행·알림, 또는 열린 결재)가 있는가. 그 실행(과 그것이 잇는 앞 실행)이
   * 만들어진 뒤의 글을 본다. 서버가 그 팀장 이름으로 남긴 글(대표 전달 지연 같은 시스템 막힘, who='시스템' 또는 서버 글 코드가 있는 글)은
   * 그 팀장이 쓴 것이 아니라 세지 않는다(0.2.7). 진행·알림을 세는 경우는 progressReportFrom.
   * ownTurnsOnly(핫픽스 C, 미룬 결과 보고 확인): 그 뒤에 들어간 다른 실행이 돈 구간([만든 때, 끝난 때])에 쓴 글은 그 실행의 보고라 세지 않는다.
   * 뒤 작업을 기다리는 동안 넣은 다른 업무의 보고가 이 실행의 보고 누락을 가리지 않게 한다.
   */
  hasExecutionReport(run: ExecutionJournal, opts: { ownTurnsOnly?: boolean } = {}): boolean {
    return this.hasOpenDecisionBy(run) || this.hasReportMessage(run, opts);
  }

  /** 그 팀장이 연 결재가 아직 열려 있다(답하거나 닫으면 바뀐다). */
  private hasOpenDecisionBy(run: ExecutionJournal): boolean {
    return !!this.row("SELECT 1 FROM decisions WHERE project_id = ? AND member_id = ? AND status = 'open' LIMIT 1", run.projectId, run.memberId);
  }

  /** hasExecutionReport 의 글 쪽: 그 실행(과 그것이 잇는 앞 실행) 뒤에 그 팀장이 쓴 결과 보고 글이 있는가. 글은 지우지 않으므로 한 번 찾으면 그대로다. */
  private hasReportMessage(run: ExecutionJournal, opts: { ownTurnsOnly?: boolean }): boolean {
    let since = run.createdAt, own = run.createdAt;
    const pending = [run], seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current.runId)) continue;
      seen.add(current.runId);
      // A replay of the same source deliveries is still the original work.
      const original = this.row(`SELECT MIN(e.created_at) AS at FROM execution_journal e, json_each(e.delivery_ids_json) item
        WHERE e.project_id = ? AND e.member_id = ? AND item.value IN (SELECT value FROM json_each(?))`,
        run.projectId, run.memberId, JSON.stringify(current.deliveryIds))?.at;
      if (original && original < since) since = original;
      if (current.createdAt < since) since = current.createdAt;
      if (current === run) own = since;
      for (const id of current.deliveryIds) {
        const delivery = this.getDelivery(id);
        if (delivery?.kind !== "system" || delivery.projectId !== run.projectId || delivery.memberId !== run.memberId) continue;
        const sourceId = /^\[시스템\] 보고 보완: 실행 (\S+)의 결과만 post로/.exec(delivery.text)?.[1];
        const source = sourceId ? this.getExecutionJournal(sourceId) : null;
        if (source && source.projectId === run.projectId && source.memberId === run.memberId && source.createdAt <= current.createdAt) pending.push(source);
      }
    }
    let progress = this.progressReportFrom(run, own);
    // 미룬 확인은 뒤 작업을 남기고 닫힌 뒤(Claude 가 그 작업의 끝을 받아 스스로 연 턴)의 진행·알림만 센다. 닫기 전의 '뒤로 돌려 두었습니다'는 결과가 아니다.
    if (progress && opts.ownTurnsOnly) progress = run.endedAt && run.endedAt > progress ? run.endedAt : progress;
    const progressArgs = progress ? [progress] : [];
    if (opts.ownTurnsOnly) return !!this.row(`SELECT 1 FROM messages m WHERE m.project_id = ? AND m.member_id = ? AND m.mine = 0
      AND m.at >= ? AND ${MEMBER_REPORT_SQL("m.", !!progress)}
      AND NOT EXISTS (SELECT 1 FROM execution_journal e WHERE e.project_id = m.project_id AND e.member_id = m.member_id AND e.created_at > ?
        AND e.run_id NOT IN (SELECT value FROM json_each(?)) AND e.created_at <= m.at AND (e.ended_at IS NULL OR m.at <= e.ended_at)) LIMIT 1`,
      run.projectId, run.memberId, since, ...progressArgs, run.createdAt, JSON.stringify([...seen]));
    return !!this.row(`SELECT 1 FROM messages WHERE project_id = ? AND member_id = ? AND mine = 0
      AND at >= ? AND ${MEMBER_REPORT_SQL("", !!progress)} LIMIT 1`, run.projectId, run.memberId, since, ...progressArgs);
  }

  /**
   * 0.2.7(D3-1·D5-3, 검토 뒤 좁힘): 그 팀장의 진행·알림 글을 이 실행의 결과 보고로 세기 시작하는 때. null 이면 세지 않는다. own 은 이 실행
   * (과 같은 전달을 다시 넣은 실행)이 처음 만들어진 때.
   * - 보고 보완 턴: 그 턴에 쓴 진행·알림. 보완 요청 글이 '완료·막힘 또는 질문/위임 대기 상태를 명시'하라고 하므로 상태 글('빌드 중',
   *   '대표님 답 대기')이 곧 그 답이다(0.2.6 뒤 거짓 '결과 보고 누락' 8건이 모두 이것). 원 턴의 진행 글(일 초반의 확인 글)은 세지 않는다.
   * - 총괄(root·conductor)이 대표 글·결재 답으로 시작한 턴: 상태 질문에 진행으로 한 답, 일을 맡긴 턴의 확인 글(parts/ack-turn.md).
   * - 직원의 원 턴(총괄 지시·대표 직접 지시·결재 답)은 세지 않는다. 직원 지침은 일을 받자마자 진행 글로 확인하게 하고(worker.md), core 는 턴
   *   마지막 글을 올리지 않으므로, 그 글 하나로 보완을 끄면 결과가 끝내 대표·총괄에게 가지 않는다. 서버는 진행 글 뒤에 CLI 가 다른 일을 했는지
   *   볼 근거가 없다(MCP 밖의 도구 호출은 보이지 않는다). 진행으로 끝낸 직원 턴은 보완을 한 번 받고, 그 보완 턴의 진행 글은 보고로 센다.
   */
  private progressReportFrom(run: ExecutionJournal, own: string): string | null {
    const deliveries = run.deliveryIds.map(id => this.getDelivery(id)).filter((d): d is Delivery => !!d && d.memberId === run.memberId);
    if (deliveries.some(d => d.kind === "system" && d.text.startsWith(formatSystem("보고 보완: 실행 ")))) return own;
    if (this.getMember(run.memberId)?.kind === "worker") return null;
    return deliveries.some(d => d.wake && (d.kind === "user_message" || d.kind === "answer")) ? own : null;
  }

  /**
   * 0.2.10: 결과 보고 글을 이미 찾은 실행(run id). 글은 지우지 않으니 다시 판정해도 '있음'이다. 예전에는 동기화마다 해결된 안내까지 처음부터 다시
   * 판정해(그 팀장의 실행 기록 전체를 json_each 로 펼침) 안내가 쌓일수록 제곱으로 느려졌다. 프로세스 메모리에만 두고, 커밋된 뒤에만 적는다.
   * 열린 결재로 '있음'이 된 것은 적지 않는다(결재를 닫으면 다시 '누락'일 수 있다).
   */
  private readonly reportFound = new Map<string, true>();
  /** 고아 보고 점검의 물높이(listWorkerReportsMissingDeliveries). 프로세스 메모리. */
  private readonly reportScan = new Map<string, { through: number; epoch: number }>();
  /** 이미 본 보고가 다시 넘길 글이 될 수 있는 쓰기(전달·팀장·프로젝트 삭제, 팀장 생성)마다 올린다. 물높이를 모두 버린다. */
  private reportScanEpoch = 0;

  listMissingReportNotices(projectId: string): MissingReportNotice[] {
    // 안내 글 id 는 'msg_missing_report_' + run_id 다. 안내 글(몇 개뿐)의 id 범위에서 출발한다(예전에는 그 프로젝트의 실행 기록 전체에서 출발했다).
    // '`' 는 ASCII 에서 '_' 바로 다음 글자라 [prefix, prefix 끝 글자+1) 범위가 그 접두사로 시작하는 id 전부다. 짝은 예전 JOIN 조건과 같다.
    return this.rows(`SELECT e.run_id, e.member_id, m.id AS message_id, m.at
      FROM messages m CROSS JOIN execution_journal e ON e.run_id = substr(m.id, ?)
      WHERE m.id >= ? AND m.id < ? AND m.id = ? || e.run_id AND e.project_id = ? ORDER BY m.at, m.id`,
      MISSING_REPORT_PREFIX.length + 1, MISSING_REPORT_PREFIX, MISSING_REPORT_END, MISSING_REPORT_PREFIX, projectId)
      .filter(row => !this.executionReported(row.run_id))
      .map(row => ({ kind: "missing_report", runId: row.run_id, memberId: row.member_id, messageId: row.message_id, createdAt: row.at, title: "결과 보고 누락" }));
  }

  /** hasExecutionReport 와 같은 판정. 글로 찾은 것은 기억해 다시 보지 않는다(reportFound). */
  private executionReported(runId: string): boolean {
    if (this.reportFound.has(runId)) return true;
    const run = this.getExecutionJournal(runId)!;
    if (this.hasOpenDecisionBy(run)) return true;
    if (!this.hasReportMessage(run, {})) return false;
    // 지금 트랜잭션이 되돌려지면 그 안에서 본 글도 없던 것이 된다. 커밋된 뒤에만 기억한다(Store.transaction 밖의 트랜잭션 안이면 기억하지 않는다).
    const remember = () => Store.remember(this.reportFound, runId, true, 50_000);
    if (this.commitFrames.length) this.commitFrames.at(-1)!.push(remember);
    else if (!this.db.inTransaction) remember();
    return true;
  }

  private messageFrom(row: Row, includeDelivery = true): Message {
    const message = toMessage(row);
    const refs = this.getReportReferences(message.projectId, message.id);
    message.fileIds = refs?.fileIds ?? (message.fileId ? [message.fileId] : []);
    if (!refs) for (const link of message.body.matchAll(/\]\(#\/p\/([^/()]+)\/files\/([^/()]+)\)/g)) {
      try {
        const projectId = decodeURIComponent(link[1]!), fileId = decodeURIComponent(link[2]!);
        if (projectId === message.projectId && this.fileProjectId(fileId) === projectId && !message.fileIds.includes(fileId)) message.fileIds.push(fileId);
      } catch { /* Malformed legacy links are plain text, never cross-project references. */ }
    }
    message.supersedes = refs?.correctsMessageId ?? null;
    const prefetched = this.deliveryRead?.projectId === message.projectId ? this.deliveryRead.superseded.get(message.id) : undefined;
    message.supersededBy = prefetched !== undefined ? prefetched : this.row("SELECT source_message_id FROM report_references WHERE project_id = ? AND corrects_message_id = ? ORDER BY sequence DESC, rowid DESC LIMIT 1", message.projectId, message.id)?.source_message_id ?? null;
    if (!includeDelivery) return message;
    // Z(0.2.6): 대표 글에만 답 상태를 싣는다.
    const reply = message.mine ? this.messageReply(message) : null;
    if (reply) message.reply = reply;
    const deliveries = this.deliveryRead?.projectId === message.projectId ? this.deliveryRead.messageDeliveries.get(message.id) ?? [] : this.rows("SELECT * FROM deliveries WHERE ref_type = 'message' AND ref_id = ? AND status NOT IN ('delivered', 'failed') ORDER BY rowid", message.id).map(toDelivery);
    return deliveries.length ? { ...message, deliveryInfo: deliveries.map(d => ({ deliveryId: d.id, memberId: d.memberId, ...this.deliveryWait(d) })) } : message;
  }

  // ---- Z(0.2.6): 대표 글의 답 상태. 판정은 server/reply-state.ts, 여기서는 근거를 모으고 바뀌면 실시간으로 낸다 ----
  /** 더는 바뀌지 않는 답 상태(답함, 답 창이 닫힌 뒤의 답 없음·멈춤). 프로세스 메모리에만 둔다. */
  private readonly replySettledCache = new Map<string, MessageReply>();
  /** 대표 글마다 마지막으로 실시간에 실은 답 상태(JSON). 같은 값은 다시 내지 않는다. */
  private readonly replySeen = new Map<string, string>();
  /** 팀장마다 지켜볼 최근 대표 글(보낸 순서). 처음 볼 때 DB 에서 채운다. */
  private readonly replyWatch = new Map<string, string[]>();
  private readonly replyDirty = new Set<string>();

  /** 기억 칸이 끝없이 크지 않게 오래된 것부터 버린다. */
  private static remember<T>(map: Map<string, T>, key: string, value: T, limit = 4000): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value!);
  }

  private messageReply(message: Message): MessageReply | null {
    const settled = this.replySettledCache.get(message.id);
    if (settled) return settled;
    return this.deliveryReadMemo(`reply:${message.id}`, () => {
      const delivery = this.ownerDelivery(message);
      const member = delivery ? this.getMember(delivery.memberId) : null;
      if (!delivery || !member || member.projectId !== message.projectId) return null;
      const facts: ReplyFacts = { memberId: member.id, delivery,
        member: { status: member.status, blockedReason: member.blockedReason ?? null, fenceCode: member.fenceCode, observationError: member.statusObservation?.error?.code ?? null } };
      if (delivery.status === "queued" || delivery.status === "held" || delivery.status === "delivering") return judgeReply({ ...facts, wait: this.deliveryWait(delivery) });
      if (delivery.status !== "delivered") return null;
      const run = this.replyRun(delivery.id);
      const start = run?.createdAt ?? delivery.deliveredAt ?? delivery.createdAt;
      const own = run?.deliveryIds ?? [delivery.id];
      let end = this.replyWindowEnd(delivery, own, start);
      // 이 실행을 잇는 실행들. 이 글과 무관한 실행이 만들어졌으면 답 창이 거기서 닫힌다(그 턴에서 쓴 글은 이 글의 답이 아니다).
      // 핫픽스 C: 뒤 작업을 남기고 닫힌 실행이 그 작업을 기다리는 동안 들어간 무관한 실행은 창을 닫지 않고 그 구간만 뺀다(skipped).
      const chain = run ? this.replyChain(member.id, run, own, end) : null;
      if (chain) end = chain.end;
      if (chain?.closedAt && (end === null || chain.closedAt < end)) end = chain.closedAt;
      const reply = this.firstReply(message.projectId, member.id, start, end, chain?.skipped ?? []);
      const runs = !reply && run && (run.phase === "ended" || run.phase === "interrupted") ? chain!.runs : [];
      const tail = runs.at(-1);
      const tailEnded = !!tail && (tail.phase === "ended" || tail.phase === "interrupted");
      // 핫픽스 C: 그 실행이 뒤 작업을 남기고 닫혀 아직 그 작업의 끝(미룬 결과 보고 확인)을 보지 못했다. 답은 그 작업 뒤에 Claude 가 스스로 연 턴에서 온다.
      const awaiting = tailEnded && this.backgroundAwaiting(tail!, nowIso(), member.paneId ?? null);
      const result = judgeReply({ ...facts, run, reply,
        later: runs.length > 1 ? tail : null,
        delegatedAt: runs.find(r => r.result === "success" && this.runDelegated(r.runId))?.endedAt ?? null,
        continuing: tailEnded && end === null && (awaiting || this.continuationPending(member.id, runs)) });
      if (!this.db.inTransaction && replySettled(result, end !== null)) Store.remember(this.replySettledCache, message.id, result!);
      return result;
    });
  }

  /** 그 글의 가장 최근 대표 글 전달. 받는 이가 바뀌어(총괄에게 넘김) 여러 번 생겼으면 마지막 것이다. */
  private ownerDelivery(message: Message): Delivery | null {
    if (this.deliveryRead?.projectId === message.projectId) {
      // 묶음 안에서는 그 프로젝트의 전달만 본다(예전에 묶음이 프로젝트 전달 전체에서 고르던 것과 같다). 쪽의 글은 messagesFrom 이 미리 읽었다.
      const read = this.deliveryRead;
      if (!read.ownerDeliveries.has(message.id)) read.ownerDeliveries.set(message.id, this.row("SELECT id FROM deliveries WHERE ref_type = 'message' AND ref_id = ? AND kind = 'user_message' AND +project_id = ? ORDER BY rowid DESC LIMIT 1", message.id, message.projectId)?.id ?? null);
      const id = read.ownerDeliveries.get(message.id);
      return id ? this.getDelivery(id) : null;
    }
    const row = this.row("SELECT * FROM deliveries WHERE ref_type = 'message' AND ref_id = ? AND kind = 'user_message' ORDER BY rowid DESC LIMIT 1", message.id);
    return row ? toDelivery(row) : null;
  }

  /** 그 전달을 실은 실행(봉투 하나 = 실행 하나). 다시 넣었으면 실제로 받은 실행을 먼저 본다. */
  private replyRun(deliveryId: string): ExecutionJournal | null {
    const row = this.row(`SELECT e.run_id FROM delivery_dispatch_items i JOIN execution_journal e ON e.run_id = i.dispatch_id
      WHERE i.delivery_id = ? ORDER BY (e.input_received_at IS NOT NULL OR e.started_at IS NOT NULL) DESC, e.rowid DESC LIMIT 1`, deliveryId);
    return row ? this.getExecutionJournal(row.run_id) : null;
  }

  /**
   * 답 창의 끝: 그 팀장이 이 글 뒤에 대표의 다음 글이나 결재 답을 받은 때. 같은 봉투로 함께 받은 글은 세지 않는다. 아직 없으면 null(열린 창).
   * 그 뒤에 쓴 글은 다음 글의 답이다.
   */
  private replyWindowEnd(delivery: Delivery, own: string[], start: string): string | null {
    const row = this.row(`SELECT delivered_at FROM deliveries WHERE member_id = ? AND status = 'delivered'
        AND rowid > (SELECT rowid FROM deliveries WHERE id = ?) AND kind IN ('user_message', 'answer')
        AND id NOT IN (SELECT value FROM json_each(?)) AND delivered_at > ?
      ORDER BY rowid LIMIT 1`, delivery.memberId, delivery.id, JSON.stringify(own), start);
    return (row?.delivered_at as string | null | undefined) ?? null;
  }

  /**
   * 답 창 안에서 그 팀장이 대화에 쓴 첫 글. 서버가 만든 알림(시스템 글, '대표 전달 지연')은 답이 아니다.
   * skipped: 창 안이지만 이 글과 무관한 실행이 돈 구간([만든 때, 끝난 때], 끝나지 않았으면 끝없음). 그 구간에 쓴 글은 그 실행의 것이다.
   */
  private firstReply(projectId: string, memberId: string, start: string, end: string | null, skipped: ReplySpan[] = []): { id: string; at: string } | null {
    const row = this.row(`SELECT m.id, m.at FROM messages m WHERE m.project_id = ? AND m.member_id = ? AND m.mine = 0 AND m.at >= ?
        AND (? IS NULL OR m.at < ?) AND m.kind <> '시스템' AND m.who <> '시스템'
        AND NOT EXISTS (SELECT 1 FROM json_each(?) s WHERE m.at >= json_extract(s.value, '$[0]') AND (json_extract(s.value, '$[1]') IS NULL OR m.at <= json_extract(s.value, '$[1]')))
      ORDER BY m.at, m.id LIMIT 1`, projectId, memberId, start, end, end, JSON.stringify(skipped.map(span => [span.from, span.to])));
    return row ? { id: row.id, at: row.at } : null;
  }

  /**
   * 핫픽스 C: 그 실행은 Claude 가 뒤 작업(워크플로·백그라운드 에이전트·셸)을 남기고 끝낸 턴으로 닫혔고(사유 claude_background_task), at 시각에 아직 그
   * 작업의 끝을 보지 못했다: 미룬 결과 보고 확인(report_requested_at, 그 작업이 끝난 뒤의 첫 성공 턴 끝에 채운다)이 그 뒤이고, 같은 터미널이다.
   * 잠재우기·새 세션·다시 띄움으로 터미널이 바뀌었으면 그 작업은 없다. 판정은 DB 기록만으로 하므로 서버를 다시 띄워도 같다.
   */
  private backgroundAwaiting(run: ExecutionJournal, at: string, terminalId: string | null): boolean {
    return run.reason === CLAUDE_BACKGROUND_REASON && run.result === "success" && run.endedAt !== null && run.endedAt <= at &&
      (run.reportRequestedAt === null || at < run.reportRequestedAt) && !!terminalId && terminalId === run.identity.terminalId;
  }

  /** 그 실행에서 총괄이 다른 팀장에게 일을 맡겼다(배정 확인 기록). */
  private runDelegated(runId: string): boolean {
    const row = this.row("SELECT assignments FROM delegation_ack_turns WHERE run_id = ?", runId);
    try { return !!row && (JSON.parse(row.assignments) as unknown[]).length > 0; } catch { return false; }
  }

  /**
   * 이 글을 실은 실행과 그 실행을 잇는 그 팀장의 뒤 실행들(만든 차례), 그리고 이 글과 무관한 실행이 만들어진 때(답 창이 거기서 닫힌다).
   * 잇는 실행은 앞 실행을 잇는 서버 글을 실은 것뿐이다(continuesReplyRun). 팀장 보고로 깬 총괄의 턴, 총괄의 다른 지시, 중단 알림·할 일 완료·
   * 판 정리로 깬 턴, 대표의 다음 글은 잇지 않는다. 판정은 DB 기록만으로 하므로 서버를 다시 띄워도 같다.
   * 핫픽스 C: 이은 마지막 실행이 뒤 작업을 남기고 닫혀 그 작업을 기다리는 동안(backgroundAwaiting) 같은 터미널에 들어간 무관한 실행은 창을 닫지 않고
   * 그 구간(skipped)만 뺀다. 대표의 다음 글(end)이 그 구간에 들었으면 그 글로도 닫지 않는다(end 를 비워 돌려준다).
   */
  private replyChain(memberId: string, first: ExecutionJournal, own: string[], end: string | null): { runs: ExecutionJournal[]; closedAt: string | null; skipped: ReplySpan[]; end: string | null } {
    const runs = [first];
    const skipped: ReplySpan[] = [];
    // 핫픽스 C: 대표의 다음 글(end)이 뒤 작업을 기다리는 동안 건너뛴 실행으로 들어갔으면 그 글로는 창을 닫지 않는다(그 실행 구간만 뺀다).
    const inSkipped = (at: string) => skipped.some(span => span.from <= at && (span.to === null || at <= span.to));
    let seq = this.row("SELECT rowid AS seq FROM execution_journal WHERE run_id = ?", first.runId)?.seq as number | undefined;
    // 이어가기가 거듭되는 일(한도에 다시 걸림)은 있어도 끝없이 이어지지는 않는다. 계산이 길어지지 않게 한도를 둔다.
    for (let i = 0; seq !== undefined && i < 32; i++) {
      const next = this.row("SELECT rowid AS seq, run_id, created_at FROM execution_journal WHERE member_id = ? AND rowid > ? ORDER BY rowid LIMIT 1", memberId, seq);
      if (!next) break;
      if (end !== null && next.created_at >= end) {
        if (!inSkipped(end)) break;
        end = null;
      }
      const carried = this.rows("SELECT d.id, d.kind, d.text FROM delivery_dispatch_items i JOIN deliveries d ON d.id = i.delivery_id WHERE i.dispatch_id = ?", next.run_id);
      const entry = this.getExecutionJournal(next.run_id);
      if (!carried.some(d => continuesReplyRun({ id: d.id, kind: d.kind, text: d.text }, own, runs))) {
        // 핫픽스 C: 이은 마지막 실행이 뒤 작업을 남기고 닫혀 그 작업을 기다리는 동안 들어간 무관한 실행(그사이 온 지시·알림)은 창을 닫지 않는다.
        // 그 작업 뒤에 Claude 가 스스로 연 턴에서 쓴 답을 세야 한다. 그 실행이 돈 구간에 쓴 글은 그 실행의 것이라 답으로 세지 않는다.
        if (entry && this.backgroundAwaiting(runs.at(-1)!, entry.createdAt, entry.identity.terminalId)) {
          skipped.push({ from: entry.createdAt, to: entry.endedAt });
          seq = next.seq as number;
          continue;
        }
        return { runs, closedAt: next.created_at as string, skipped, end: end !== null && inSkipped(end) ? null : end };
      }
      if (!entry) break;
      runs.push(entry);
      seq = next.seq as number;
    }
    return { runs, closedAt: null, skipped, end: end !== null && inSkipped(end) ? null : end };
  }

  /**
   * 이은 실행들(runs)을 잇는 서버 글이 아직 들어가지 않았다: 그 실행들의 보고 보완(orchestrator requestMissingReport), 마지막 실행 뒤에 넣은
   * 이어가기(사용 한도·인터넷이 풀림, 재시작 뒤 다시 엶), 또는 재시작으로 끊긴 그 실행을 서버가 다시 열어 이어가게 할 차례(재시작 깨우기 표식).
   */
  private continuationPending(memberId: string, runs: ExecutionJournal[]): boolean {
    const tail = runs.at(-1)!;
    const pending = this.rows(`SELECT text, created_at FROM deliveries WHERE member_id = ? AND kind = 'system' AND status IN ('queued', 'held', 'delivering')`, memberId);
    if (pending.some(d => supplementFor(d.text, runs) || (resumeText(d.text) && d.created_at >= tail.createdAt))) return true;
    const wake = this.getRestartWake(memberId);
    return !!wake && (wake.state === "pending" || wake.state === "opening") && runs.some(r => wake.runIds.includes(r.runId));
  }

  /**
   * 이 팀장이 받은 대표 글의 답 상태가 바뀌었을 수 있다. 쓰기가 끝난 뒤(commit 뒤의 다른 알림까지 다 나간 뒤) 바뀐 글만 실시간으로 낸다.
   * 같은 쓰기가 글 사건을 따로 내면(전달 상태가 바뀐 글) 그 사건이 이미 새 답 상태를 실었으므로 다시 내지 않는다.
   */
  private noteReply(memberId: string | null | undefined): void {
    if (!memberId || this.deliveryRead) return;
    this.replyDirty.add(memberId);
    this.afterCommit(() => {
      if (this.replyFlushQueued) return;
      this.replyFlushQueued = true;
      queueMicrotask(() => { this.replyFlushQueued = false; this.flushReplies(); });
    });
  }
  private replyFlushQueued = false;

  private flushReplies(): void {
    if (!this.replyDirty.size || this.deliveryRead) return;
    try {
      // 동기 읽기·쓰기 도중에는 마이크로태스크가 돌지 않는다. 그래도 그런 자리면 남겨 두고 다음 변화 때 낸다(닫힌 DB 는 여기서 던진다).
      if (this.db.inTransaction) return;
      const members = [...this.replyDirty];
      this.replyDirty.clear();
      for (const memberId of members) {
        for (const id of this.replyCandidates(memberId)) {
          const message = this.getMessage(id);
          if (!message?.mine) continue;
          // 아직 넣지 못한 글의 답 상태는 대기 사유(펌프 판정)를 따른다. 그 변화는 이미 member 사건으로 나가고, 앱은 전달을 기다리는
          // 내 글이 보이는 동안 그 사건마다 대화를 다시 읽는다. 바쁜 팀장의 상태가 흔들릴 때 글 사건을 쏟지 않게 여기서는 내지 않는다.
          if (message.delivery === "queued" || message.delivery === "held" || message.delivery === "delivering") continue;
          if (this.replySeen.get(id) === JSON.stringify(message.reply ?? null)) continue;
          // 내보낸 값은 버스 구독(constructor)이 replySeen 에 적는다.
          this.bus.emit({ type: "message", message });
        }
      }
    } catch (error) {
      // 저장소를 닫은 뒤 늦게 돈 경우 등. 답 상태 알림은 다음 변화 때 다시 낸다.
      if (!/closed/i.test(String((error as Error)?.message ?? error))) console.warn("답 상태 알림 실패:", (error as Error).message);
    }
  }

  /** 팀장이 받은 최근 대표 글(많아야 5개, 보낸 순서). 그보다 오래된 글은 답 상태가 이미 굳었다. */
  private replyCandidates(memberId: string): string[] {
    let list = this.replyWatch.get(memberId);
    if (!list) {
      list = this.rows("SELECT ref_id FROM deliveries WHERE member_id = ? AND kind = 'user_message' AND ref_type = 'message' ORDER BY rowid DESC LIMIT 5", memberId)
        .map(row => row.ref_id as string).reverse();
      Store.remember(this.replyWatch, memberId, list, 500);
    }
    return list;
  }

  private watchReply(memberId: string, messageId: string): void {
    const list = this.replyWatch.get(memberId);
    if (!list) return;
    const next = [...list.filter(id => id !== messageId), messageId].slice(-5);
    Store.remember(this.replyWatch, memberId, next, 500);
  }
  private runnerHealth = new Map<Backend, RunnerHealth>();
  private lastConnections = new Map<string, string>();

  constructor(
    db: Database,
    private readonly bus: Bus,
    private readonly recorder?: DomainRecorder,
  ) {
    this.sqlTransaction = db.transaction.bind(db);
    // 기존 import의 store.db.transaction도 같은 commit 큐를 사용한다.
    // 원래 DB 객체/다른 저장소는 변조하지 않고 이 Store의 호환 facade만 제공한다.
    const transaction = <A extends unknown[], T>(write: (...args: A) => T) => {
      const run = (mode: "deferred" | "immediate" | "exclusive") => (...args: A) => this.transaction(() => write(...args), mode);
      return Object.assign(run("deferred"), { deferred: run("deferred"), immediate: run("immediate"), exclusive: run("exclusive") });
    };
    this.db = new Proxy(db, {
      get(target, key) {
        if (key === "transaction") return transaction;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // L: 판정 표는 openDb 가 만든다. 이주 도중의 DB 를 바로 넘겨받은 경우에도 쓸 수 있게 없으면 여기서 만든다(있으면 쓰지 않는다).
    this.verdictsReady = ensureDeliveryVerdicts(db);
    // Z(0.2.6): 대표 글을 실시간으로 낼 때마다 그때의 답 상태를 적는다. 같은 값은 flushReplies 가 다시 내지 않는다.
    (bus as Partial<Bus>).subscribe?.((event) => {
      if (event.type === "message" && event.message.mine) Store.remember(this.replySeen, event.message.id, JSON.stringify(event.message.reply ?? null));
    });
    const existing = !!this.getProject("hq");
    this.ensureHq();
    this.initPermissionAcknowledged(existing);
  }

  /**
   * 권한 방식 확인 여부를 한 번만 정해 적는다. 새로 만든 DB 와 아무것도 하지 않은 DB 는 false(앱이 첫 실행에서 묻는다),
   * 이미 쓰던 DB(본사 말고 프로젝트가 있거나 팀장·대화가 있는 DB)는 true 다. 쓰던 사람의 세션이 갑자기 경고 창에 멈추면 안 된다.
   */
  private initPermissionAcknowledged(existing: boolean): void {
    if (this.row("SELECT 1 FROM settings WHERE key = 'permissionAcknowledged'")) return;
    const used = existing && !!(this.row("SELECT 1 FROM projects WHERE is_hq = 0 LIMIT 1") ?? this.row("SELECT 1 FROM members LIMIT 1") ?? this.row("SELECT 1 FROM messages LIMIT 1"));
    this.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('permissionAcknowledged', ?)", JSON.stringify(used));
  }

  /** 새 프로젝트를 만들 때 대표가 그 폴더를 신뢰한다고 답했다. 폴더가 바뀌면 이 기록은 더 맞지 않는다. */
  trustProjectFolder(projectId: string, cwd: string): void {
    this.transaction(() => {
      this.requireProject(projectId);
      const saved = this.folderTrust();
      saved[projectId] = cwd;
      this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", FOLDER_TRUST_KEY, JSON.stringify(saved));
    });
  }

  /** 그 프로젝트를 만들 때 신뢰한다고 답한 바로 그 폴더인가. 글자 그대로 같을 때만 참이다. */
  projectFolderTrusted(projectId: string, cwd: string): boolean {
    return !!cwd && this.folderTrust()[projectId] === cwd;
  }

  private folderTrust(): Record<string, string> {
    const row = this.row("SELECT value FROM settings WHERE key = ?", FOLDER_TRUST_KEY);
    if (!row) return {};
    try {
      const saved: unknown = JSON.parse(row.value);
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
      return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch { return {}; }
  }

  /** 이 설치가 전에 연 Tailscale 주소와 그 시각. 연 적이 없으면 null. */
  tailnetSeen(): { address: string; at: string } | null {
    const row = this.row("SELECT value FROM settings WHERE key = ?", TAILNET_SEEN_KEY);
    if (!row) return null;
    try {
      const saved = JSON.parse(row.value) as { address?: unknown; at?: unknown } | null;
      return saved && typeof saved.address === "string" && saved.address && typeof saved.at === "string" ? { address: saved.address, at: saved.at } : null;
    } catch { return null; }
  }

  rememberTailnetSeen(seen: { address: string; at: string }): void {
    this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", TAILNET_SEEN_KEY, JSON.stringify({ address: seen.address, at: seen.at }));
  }

  /** D4-3: 지금 이어지는 Tailscale 꺼짐에 iPhone 알림을 냈으면 그 꺼짐의 시작 시각(알림 열쇠). 없거나 읽을 수 없으면 null. */
  tailnetPhoneAlert(): string | null {
    const row = this.row("SELECT value FROM settings WHERE key = ?", TAILNET_PHONE_ALERT_KEY);
    if (!row) return null;
    try {
      const saved = JSON.parse(row.value) as { since?: unknown } | null;
      return saved && typeof saved.since === "string" && saved.since ? saved.since : null;
    } catch { return null; }
  }

  /** D4-3: null 이면 지운다(Tailscale 이 다시 켜짐). */
  setTailnetPhoneAlert(since: string | null): void {
    if (since === null) { this.run("DELETE FROM settings WHERE key = ?", TAILNET_PHONE_ALERT_KEY); return; }
    this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", TAILNET_PHONE_ALERT_KEY, JSON.stringify({ since }));
  }

  /** C8: 대표가 켠 HTTPS 주소의 기록. 켠 적이 없거나 껐으면 null. 모양이 어긋난 값은 없는 것으로 본다. */
  tailnetHttps(): { url: string; port: number; at: string; home?: string } | null {
    const row = this.row("SELECT value FROM settings WHERE key = ?", TAILNET_HTTPS_KEY);
    return row ? parseTailnetHttpsRecord(row.value) : null;
  }

  /** home: 켠 설치의 데이터 폴더(tailnet-https.ts SavedTailnetHttps). 없던 판의 기록은 home 없이 읽는다. */
  rememberTailnetHttps(value: { url: string; port: number; at: string; home?: string } | null): void {
    if (!value) { this.run("DELETE FROM settings WHERE key = ?", TAILNET_HTTPS_KEY); return; }
    this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", TAILNET_HTTPS_KEY,
      JSON.stringify({ url: value.url, port: value.port, at: value.at, ...(typeof value.home === "string" ? { home: value.home } : {}) }));
  }

  loadApiRecovery<T>(key: string): T | null {
    const row = this.row("SELECT value FROM api_recovery_state WHERE key = ?", key);
    return row ? json<T>(row.value) : null;
  }
  saveApiRecovery(key: string, value: unknown): void {
    const encoded = JSON.stringify(value);
    if (this.row("SELECT value FROM api_recovery_state WHERE key = ?", key)?.value === encoded) return;
    this.run("INSERT INTO api_recovery_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, encoded);
    // Invalidate /sync's generation without introducing a new WS event for old apps.
    this.emitProjects();
  }
  apiOutage(): import("../shared/types.ts").ApiOutageState | null {
    return this.loadApiRecovery("outage_public");
  }
  /**
   * 사용 한도 카드를 고친다. options 를 주면 선택지도 바꾼다(모델 선택지·이어가기). 선택지만 바뀌어서는 판(updatedAt)을 올리지 않는다:
   * 카드의 푸시 알림이 그 판(`ask:<id>:<updatedAt>`)에 묶여 있어, 올리면 아직 안 나간 알림이 취소된다. 바뀐 카드는 decision 이벤트로 나가고,
   * 앱은 선택지가 바뀌면 카드를 새로 그리며, 서버는 답을 지금 선택지로 검사한다(없는 선택지는 400).
   */
  updateUsageDecision(id: string, usage: NonNullable<Decision["usageLimit"]>, title: string, detail: string, open: boolean, options?: DecisionOption[], refs?: DecisionTextRefs): Decision {
    if (!open) usage = { ...usage, stillLimited: false };
    return this.transaction(() => {
      const before = this.requireDecision(id);
      // Y: 글 코드를 주면 제목·본문·선택지를 보고 언어로 그린다(넘겨받은 문장은 쓰지 않는다).
      if (refs) {
        // 리뷰: 카드에 있던 다시 연 까닭·닫힌 이유의 코드는 이어 간다(버리면 그 칸만 코드 없이 남는다). 보고 언어가 바뀌었으면 그 문장도 새 언어로.
        const kept = this.decisionTextsIn(id, this.reportLang());
        const notes: DecisionTextRefs = { ...(kept.closeReason ? { closeReason: kept.closeReason } : {}), ...(kept.reopenNote ? { reopenNote: kept.reopenNote } : {}) };
        const texts = this.decisionTexts({ title, detail, options: options ?? before.options, texts: { ...refs, ...notes } });
        title = texts.input.title; detail = texts.input.detail ?? ""; options = texts.input.options;
        if (this.row("SELECT text_ref FROM decisions WHERE id = ?", id)?.text_ref !== texts.stored) this.run("UPDATE decisions SET text_ref = ? WHERE id = ?", texts.stored, id);
      }
      const status = open ? "open" : "closed";
      const nextOptions = options ?? before.options;
      const optionsChanged = JSON.stringify(nextOptions) !== JSON.stringify(before.options);
      if (JSON.stringify(before.usageLimit) === JSON.stringify(usage) && before.title === title && before.detail === detail && before.status === status && !optionsChanged) return before;
      this.run("UPDATE decisions SET usage_limit_json = ?, title = ?, detail = ?, status = ?, options = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(usage), title, detail, status, JSON.stringify(nextOptions), status === before.status ? before.updatedAt : this.nextDecisionStamp(id), id);
      const decision = this.requireDecision(id);
      this.recorder?.decision(before, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return decision;
    });
  }
  clearUsageRetry(memberId: string): void {
    this.run("UPDATE deliveries SET next_attempt_at = NULL, retry_scope = NULL, retry_reason = NULL WHERE member_id = ? AND retry_reason = 'processing_quota'", memberId);
  }
  setDeliveryAuthor(id: string, memberId: string): void { this.run("UPDATE deliveries SET assigned_by = ? WHERE id = ?", memberId, id); }
  withdrawInstruction(id: string, actor: Member): void {
    this.transaction(() => {
      const d = this.requireDelivery(id);
      if (actor.kind !== "conductor" || actor.projectId !== d.projectId || d.kind !== "instruction" || this.row("SELECT assigned_by FROM deliveries WHERE id = ?", id)?.assigned_by !== actor.id) throw new ApiError(403, "자신이 보낸 지시만 거둘 수 있습니다", "instruction_not_own");
      const envelopes = this.listDispatchesFor(d.memberId, id);
      if (!["queued", "held"].includes(d.status) || envelopes.some(x => ["write_started", "unknown", "accepted"].includes(x.transportState))) throw new ApiError(409, "이미 쓰기 시작한 지시는 거둘 수 없습니다", "instruction_started");
      for (const dispatch of envelopes) if (dispatch.transportState === "prepared") this.updateDispatch(dispatch.dispatchId, "prepared", "rejected");
      const r = this.getDeliveryRecovery(id)!;
      this.updateDeliveryRecovery(id, r.version, { phase: "stopped", reason: "withdrawn", nextCheckAt: null });
      this.markFailed(id, "총괄이 미전달 지시를 거뒀습니다");
    });
  }
  /**
   * 0.2.7 묶음 1(점검 D1-3·D5-2): 30분 넘게 나가지 않은, 대표에게서 온 깨우는 전달(대표 글·결재 답·할 일 완료, 대표 원문을 실은 총괄 지시) 가운데
   * '막힘' 알림을 아직 하지 않은 것. 알릴지·어떤 급으로 알릴지는 그 팀장의 지금 대기 사유를 보고 부르는 쪽(Orchestrator.notifyDelayedDeliveries)이 정한다.
   * 예전에는 사유와 상관없이 고르는 순간 알린 것으로 적어(claimDelayedDeliveries), 정상 대기도 '막힘'으로 알리고 진짜 막힘은 다시 보지 않았다.
   */
  listDelayedDeliveries(at: number): Delivery[] {
    return this.rows(`SELECT * FROM deliveries WHERE status IN ('queued','held') AND wake = 1 AND delay_notified_at IS NULL AND created_at <= ?
      AND (kind IN ('answer','user_message','todo_done') OR (kind = 'instruction' AND (instr(text, ?) > 0 OR instr(text, ?) > 0))) ORDER BY rowid`,
      new Date(at - 30 * 60_000).toISOString(), `\n${OWNER_QUOTE_LABELS[0]}: `, `\n${OWNER_QUOTE_LABELS[1]}: `).map(toDelivery);
  }
  /** '막힘' 급의 지연 알림을 했다고 적는다. 이미 적힌 것이면 false(같은 전달을 두 번 알리지 않는다). */
  markDelayNotified(id: string, at: number): boolean {
    if (!this.row("SELECT 1 FROM deliveries WHERE id = ? AND delay_notified_at IS NULL", id)) return false;
    this.run("UPDATE deliveries SET delay_notified_at = ? WHERE id = ?", new Date(at).toISOString(), id);
    return true;
  }
  repairRejectedLimit(at = Date.now()): void {
    this.transaction(() => {
      for (const row of this.rows("SELECT * FROM deliveries WHERE status = 'held' AND retry_reason = 'rejected_limit'")) {
        const d = toDelivery(row), r = this.getDeliveryRecovery(d.id)!;
        const stale = ["instruction", "system", "report"].includes(d.kind) && at - Date.parse(d.createdAt) > 3_600_000;
        this.patchDeliveryRetry(d.id, { retryReason: null, nextAttemptAt: null });
        if (!this.listDispatchesFor(d.memberId, d.id).length) this.run("UPDATE deliveries SET attempts = 0 WHERE id = ?", d.id);
        this.updateDeliveryRecovery(d.id, r.version, { phase: stale ? "needs_owner" : "resolved", reason: stale ? "stale_instruction" : "not_received", nextCheckAt: null });
        this.setDeliveryStatus(d.id, stale ? "held" : "queued", { holdReason: stale ? "stale_instruction" : null });
      }
    });
  }

  /** 동기 SQL 전용. await/외부 I/O는 이 경계 밖에서 한다. 중첩 실패는 해당 savepoint의 알림도 버린다. */
  transaction<T>(write: () => T, mode: "deferred" | "immediate" | "exclusive" = "deferred"): T {
    if (this.db.inTransaction && this.commitFrames.length === 0) {
      throw new Error("Store.transaction must own the outer transaction");
    }
    const frame: (() => void)[] = [];
    const messageMs = this.lastMessageMs;
    this.commitFrames.push(frame);
    let result: T;
    try {
      result = this.sqlTransaction(() => {
        const value = write();
        if (value instanceof Promise) throw new Error("Store.transaction requires a synchronous callback");
        return value;
      })[mode]();
    } catch (error) {
      this.commitFrames.pop();
      this.lastMessageMs = messageMs;
      throw error;
    }
    this.commitFrames.pop();
    const parent = this.commitFrames.at(-1);
    if (parent) parent.push(...frame);
    else for (const effect of frame) {
      // commit은 이미 성공했다. 알림 실패를 쓰기 실패로 오인해 재실행하지 않는다.
      try { effect(); } catch (error) { console.error("Store afterCommit 오류:", error); }
    }
    return result;
  }

  afterCommit(effect: () => void): void {
    const frame = this.commitFrames.at(-1);
    if (frame) frame.push(effect);
    else {
      if (this.db.inTransaction) throw new Error("Use Store.transaction for commit effects");
      effect();
    }
  }

  private emit(event: WsEvent): void {
    this.afterCommit(() => this.bus.emit(event));
  }

  /** 원본과 outbox를 하나로 접수한다. pump도 최외곽 commit 이후에만 실행한다. */
  withDeliveryIntents<T>(write: () => T, intents: (value: T) => NewDelivery[], pump?: (memberId: string) => void): DeliveryIntentResult<T> {
    return this.transaction(() => {
      const value = write();
      const pumpMembers = new Set<string>();
      const deliveries = intents(value).map((intent) => {
        if (intent.refType && intent.refId) {
          const existing = this.row("SELECT * FROM deliveries WHERE project_id = ? AND member_id = ? AND kind = ? AND ref_type = ? AND ref_id = ? AND source_revision IS ? ORDER BY rowid DESC LIMIT 1", intent.projectId, intent.memberId, intent.kind, intent.refType, intent.refId, intent.sourceRevision ?? null);
          if (existing) return toDelivery(existing);
        }
        pumpMembers.add(intent.memberId);
        return this.enqueue(intent);
      });
      if (pump) for (const id of pumpMembers) this.afterCommit(() => pump(id));
      return { value, deliveries };
    });
  }

  private ensureHq(): void {
    if (this.getProject("hq")) return;
    // Y: 새로 설치한 서버의 본사 이름과 보고 언어는 첫 실행의 언어를 따른다(IAMCEO_LANG, 없으면 예전처럼 한국어). 이미 있는 본사는 그대로다.
    const lang = firstRunLang();
    this.createProject({ id: "hq", name: DEFAULT_NAMES[lang].hq, cwd: homedir(), runnerEnabled: true });
    if (lang === "en") this.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('reportLanguage', ?)", JSON.stringify("en"));
  }

  private row(sql: string, ...params: SQLQueryBindings[]): Row | null {
    return this.db.query<Row, SQLQueryBindings[]>(sql).get(...params);
  }

  private rows(sql: string, ...params: SQLQueryBindings[]): Row[] {
    return this.db.query<Row, SQLQueryBindings[]>(sql).all(...params);
  }

  private run(sql: string, ...params: SQLQueryBindings[]): void {
    if (this.deliveryRead) throw new Error("Cannot write inside a delivery read snapshot");
    // 고아 보고 점검의 물높이를 버리는 쓰기(listWorkerReportsMissingDeliveries). 팀장·프로젝트 삭제는 그 전달을 연쇄로 지운다.
    if (REPORT_SCAN_RESET.some(prefix => sql.startsWith(prefix))) this.reportScanEpoch++;
    this.db.query<Row, SQLQueryBindings[]>(sql).run(...params);
  }

  /** 따로 이벤트가 없는 변화(실행 엔진 상태 등)를 알린다. 화면은 이 신호로 스냅샷을 다시 읽는다. */
  touchSnapshot(): void {
    this.emitProjects();
  }

  private emitProjects(): void {
    this.afterCommit(() => {
      this.emit({ type: "projects", projects: this.projectSummaries() });
      // 연결 상태는 설정·실행기·직접 띄운 세션에 따라 저절로 바뀐다. 여는 화면이 보던 Project 도 고쳐 준다.
      for (const r of this.rows("SELECT * FROM projects")) {
        const project = this.projectFrom(r);
        const key = JSON.stringify(project.connection);
        const before = this.lastConnections.get(project.id);
        this.lastConnections.set(project.id, key);
        if (before !== undefined && before !== key) this.emit({ type: "project", project });
      }
    });
  }

  // ---- 연결 ----
  /** The runtime is fixed to core. Historical backend values on member and settings rows remain readable, never selectable. */
  effectiveBackend(): Backend { return "core"; }

  /** 이 프로젝트의 총괄이 쓰는 CLI. 저장된 값이 아는 CLI 면 그대로, 모르는 값(없는 프로젝트 포함)이면 claude 다. */
  chiefCli(projectId: string): CliProvider {
    const saved: unknown = this.row("SELECT chief_cli FROM projects WHERE id = ?", projectId)?.chief_cli;
    switch (saved) {
      case "codex": return "codex";
      // gemini 를 claude 로 읽으면 Gemini 총괄을 골라도 다음에 띄울 때 Claude 로 뜨고, 그 총괄이 띄우는 팀장도 Claude 가 된다.
      case "gemini": return "gemini";
      default: return "claude";
    }
  }

  /**
   * Gemini(Antigravity CLI)를 쓰는 근거가 있는가: Gemini 인 팀장·총괄이 있거나(members.cli, projects.chief_cli) Gemini 직급표에 정한 값이 있다.
   * 근거가 없는 Mac 에서는 서버가 뒤에서 `agy models` 를 띄우지 않는다(모델 목록 갱신, orchestrator.ts).
   */
  geminiInUse(): boolean {
    if (this.row("SELECT 1 AS used FROM members WHERE cli = 'gemini' LIMIT 1") || this.row("SELECT 1 AS used FROM projects WHERE chief_cli = 'gemini' LIMIT 1")) return true;
    return Object.values(this.getSettings().geminiRanks).some(rank => rank.model !== null || rank.effort !== null);
  }

  setChiefCli(projectId: string, cli: CliProvider): void {
    this.requireProject(projectId);
    this.run("UPDATE projects SET chief_cli = ? WHERE id = ?", cli, projectId);
  }

  archiveAndRotateSession(memberId: string, cli: CliProvider, reason = "provider_switch"): void {
    return this.transaction(() => {
      this.requireMember(memberId);
      this.transaction(() => {
        this.run(`INSERT INTO member_session_history (id, member_id, cli, backend, session_id, pane_id, generation, applied_config, archived_at, reason)
          SELECT ?, id, cli, backend, session_id, pane_id, session_generation, applied_config, ?, ? FROM members WHERE id = ?`, newId("hist_"), nowIso(), reason, memberId);
        this.run(`UPDATE members SET cli = ?, token = ?, session_id = NULL, pane_id = NULL, context_pct = NULL, context_window = NULL, context_window_source = NULL,
          applied_config = NULL, parallel = 0, subagents = 0, config_revision = config_revision + 1, session_generation = session_generation + 1 WHERE id = ?`, cli, `tk_${newId("")}${newId("")}`, memberId);
      });
    });
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
    if (!runnerEnabled) return { ok: false, reason: "runner_off", detail: "AI가 아직 연결되지 않았습니다. 총괄을 시작하세요" };
    const health = this.runnerHealth.get(this.effectiveBackend());
    return { ok: false, reason: "backend_down", detail: `herdr-core에 연결할 수 없습니다. 연결되면 쓸 수 있습니다${health?.detail ? ` (${health.detail})` : ""}` };
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
    if (!project.connection.ok) throw new ApiError(409, project.connection.detail ?? "연결되어야 쓸 수 있습니다", "project_disconnected");
    if (this.runnerUsable(project.runnerEnabled)) return;
    if (target?.origin === "manual" && !["offline", "asleep", "error"].includes(target.status)) return;
    throw new ApiError(409, "실행기가 연결되지 않아 직접 띄운 세션에게만 보낼 수 있습니다. 받을 세션을 @로 골라 주세요", "runner_disconnected_manual_only");
  }

  /**
   * 시작할 때마다 도는 정리(멱등). 연결 전에 쌓인 말·결재 답을 돌려준다: 결재는 직전 답을 카드에 남기고 다시 열고, 대표 글은 실패로 표시해 다시 보낼 수 있게 한다.
   * 실행이 꺼진 뒤 대기 중이던 답도 이 길로 온다. 가져온 못 읽은 말(IMPORT_HOLD_NOTE)은 총괄을 시작하면 전달하기로 약속했으므로 건드리지 않는다. 돌려준 건수를 돌려준다.
   */
  releaseHeldBeforeConnection(): { messages: number; decisions: number } {
    const note = "연결 전이라 전달되지 않았습니다";
    const reopenNote = textRef("card.reopen_not_connected");
    const out = { messages: 0, decisions: 0 };
    const held = this.rows("SELECT * FROM deliveries WHERE status = 'held' AND hold_reason = 'runner_disabled' ORDER BY rowid").map(toDelivery);
    const released: string[] = [];
    for (const d of held) {
      if (d.refType === "decision" && d.refId) {
        const decisionId = d.refId;
        // 지우고 다시 여는 사이에 죽으면 답도 전달도 사라진다. 한 번에 한다.
        this.transaction(() => {
          this.run("DELETE FROM deliveries WHERE id = ?", d.id);
          if (this.getDecision(decisionId)?.status === "answered") {
            this.reopenDecision(decisionId, reopenNote);
            out.decisions++;
          }
        });
        released.push(decisionId);
        this.emitMember(d.memberId);
      } else if (d.kind !== "report" && d.refType === "message" && d.refId) {
        // 직원 보고는 대표 글이 아니다. 실행기가 꺼진 동안 보류된 보고는 지우지 않고 다시 켜졌을 때 전달한다.
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
      for (const r of this.rows("SELECT id FROM messages WHERE project_id = ? AND mine = 1 AND delivery IN ('held','queued') AND target_member_id IS NULL AND COALESCE(delivery_code, '') != 'held_import'", p.id)) {
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
    return this.deliveryReadMemo(`project:${id}`, () => {
      const r = this.row("SELECT * FROM projects WHERE id = ?", id);
      return r ? this.projectFrom(r) : null;
    });
  }

  requireProject(id: string): Project {
    const p = this.getProject(id);
    if (!p) throw new ApiError(404, "프로젝트를 찾을 수 없습니다", "project_not_found");
    return p;
  }

  listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
    const where = opts.includeArchived ? "" : "WHERE archived = 0";
    return this.rows(`SELECT * FROM projects ${where} ORDER BY is_hq DESC, created_at, rowid`).map((r) => this.projectFrom(r));
  }

  createProject(input: NewProject): Project {
    return this.transaction(() => {
      checkProjectName(input.name);
      const at = nowIso();
      const id = input.id ?? newId("p_");
      const now = input.now ?? "";
      this.run(
        `INSERT INTO projects (id, name, is_hq, cwd, runner_enabled, now, now_at, created_at, updated_at, creation_goal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.name,
        id === "hq" ? 1 : 0,
        input.cwd,
        (input.runnerEnabled ?? true) ? 1 : 0,
        now,
        now ? at : null,
        at,
        at,
        input.creationGoal ?? null,
      );
      if (input.chiefCli) this.setChiefCli(id, input.chiefCli);
      const project = this.requireProject(id);
      this.emit({ type: "project", project });
      this.emitProjects();
      return project;
    });
  }

  /** 총괄의 기본 이름. 언어를 주지 않으면 보고 언어(Y). 이름을 바꿀 때는 지금 이름이 어느 언어의 기본 이름인지 보고 그 언어로 맞춘다. */
  private projectConductorName(name: string, lang: TextLang = this.reportLang()): string {
    return cleanName(conductorName(name, lang), DEFAULT_NAMES[lang].lead);
  }
  /** 총괄의 지금 이름이 이 프로젝트 이름의 기본 이름(어느 언어든)이면 그 언어. 직접 바꾼 이름이면 null. */
  private defaultLeadLang(leadName: string, projectName: string): TextLang | null {
    for (const lang of ["ko", "en"] as const) if (leadName === conductorName(projectName, lang) || leadName === this.projectConductorName(projectName, lang)) return lang;
    return null;
  }

  validateProjectPatch(id: string, patch: ProjectPatch): ProjectPatch {
    const project = this.requireProject(id);
    if (patch.archived === true && patch.runnerEnabled === true) throw new ApiError(400, "보관과 실행 켜기를 함께 요청할 수 없습니다", "project_archive_and_run");
    if (project.isHq && patch.archived === true) throw new ApiError(400, "본사는 보관할 수 없습니다", "root_project_archive");
    if (patch.name !== undefined) {
      // trim 전에도 줄바꿈/제어문자는 거부한다.
      const problem = oneLineProblem(patch.name, Number.MAX_SAFE_INTEGER);
      if (problem) throw new ApiError(400, problem, "project_name_invalid");
      patch = { ...patch, name: patch.name.trim() };
      checkProjectName(patch.name);
      if (!patch.name) throw new ApiError(400, "프로젝트 이름이 필요합니다", "project_name_required");
      const lead = this.getConductor(id);
      const leadLang = lead?.kind === "conductor" ? this.defaultLeadLang(lead.name, project.name) : null;
      const name = this.projectConductorName(patch.name, leadLang ?? "ko");
      if (lead && leadLang && this.row("SELECT 1 FROM members WHERE project_id = ? AND id != ? AND name = ?", id, lead.id, name)) {
        throw new ApiError(409, "새 총괄 이름과 같은 팀장이 있습니다", "lead_name_taken");
      }
    }
    return { ...patch };
  }

  patchProject(id: string, patch: ProjectPatch): Project {
    return this.transaction(() => {
      patch = this.validateProjectPatch(id, patch);
      const before = this.requireProject(id);
      patch = Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== undefined && value !== before[key as keyof ProjectPatch]));
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
        const leadLang = lead?.kind === "conductor" ? this.defaultLeadLang(lead.name, before.name) : null;
        if (lead && leadLang) this.patchMember(lead.id, { name: this.projectConductorName(project.name, leadLang) });
      }
      this.emit({ type: "project", project });
      this.emitProjects();
      return project;
    });
  }

  /**
   * 옛 herdr 실행기 시절, 편입이 이 프로젝트의 실행을 켰다는 기록. 편입은 없어져 새로 켜지지 않는다.
   * 남아 있는 행에서는 대표가 시키지 않은 총괄을 띄우지 않는다. 대표가 총괄을 시작하면 꺼진다.
   */
  runnerByAdopt(id: string): boolean {
    return !!this.row("SELECT runner_by_adopt FROM projects WHERE id = ?", id)?.runner_by_adopt;
  }

  setRunnerByAdopt(id: string, on: boolean): void {
    this.run("UPDATE projects SET runner_by_adopt = ? WHERE id = ?", on ? 1 : 0, id);
  }

  private needsOwnerCounter: ((projectId: string) => number) | null = null;
  setNeedsOwnerCounter(counter: (projectId: string) => number): void { this.needsOwnerCounter = counter; }

  /** A negative result avoids hydrating ordinary queued deliveries for a summary count.
   * Positive candidates still use the full notice rules (including superseded sources). */
  hasDeliveryAttention(projectId: string): boolean {
    // 0.2.10: 대표 판단을 기다리는 복구(phase 색인)와 풀리지 않은 정체 표시(몇 줄뿐인 표)에서 출발한다. 예전 한 문장은 그 프로젝트의 전달 이력을
    // 하나씩 훑으며 복구·정체를 찾았다(찾을 것이 없을 때 가장 느렸다). 고르는 조건은 같다.
    return !!this.row(`SELECT 1 FROM delivery_recovery r CROSS JOIN deliveries d ON d.id = r.delivery_id WHERE r.phase = 'needs_owner' AND d.project_id = ?
      UNION ALL SELECT 1 FROM delivery_stalls s CROSS JOIN delivery_recovery r ON r.delivery_id = s.delivery_id CROSS JOIN deliveries d ON d.id = s.delivery_id
        WHERE s.resolved_at IS NULL AND r.phase IN ('none','resolved') AND d.project_id = ?
      LIMIT 1`, projectId, projectId);
  }

  projectSummaries(): ProjectSummary[] {
    return this.rows(
      `SELECT p.id, p.name, p.is_hq, p.cwd, p.now, p.runner_enabled, p.archived,
         (SELECT COUNT(*) FROM decisions d WHERE d.project_id = p.id AND d.status = 'open') AS decision_count,
         (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id AND t.done = 0) AS todo_count,
         (SELECT COUNT(*) FROM members m WHERE m.project_id = p.id AND m.status = 'working') AS working_count,
         (SELECT COUNT(*) FROM members m WHERE m.project_id = p.id AND m.status = 'idle' AND m.subagents > 0) AS subagent_working_count,
         (SELECT COUNT(*) FROM members m WHERE m.project_id = p.id AND m.status = 'blocked' AND m.blocked_reason = 'permission') AS blocked_count,
         (SELECT COUNT(*) FROM members m WHERE m.project_id = p.id AND m.status = 'blocked' AND m.blocked_reason IN ('permission', 'selection')) AS attention_blocked_count,
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
      needsCount: r.decision_count + r.todo_count + r.attention_blocked_count + r.error_count + (this.needsOwnerCounter?.(r.id) ?? this.row("SELECT COUNT(*) AS n FROM delivery_recovery r CROSS JOIN deliveries d ON d.id = r.delivery_id WHERE r.phase = 'needs_owner' AND d.project_id = ?", r.id)!.n),
      needsDanger: r.error_count > 0,
      inboxCount: r.decision_count + r.todo_count,
      workingCount: r.working_count,
      subagentWorkingCount: r.subagent_working_count,
      blockedCount: r.blocked_count,
      errorCount: r.error_count,
      memberCount: r.member_count,
    }));
  }

  /**
   * 프로젝트 상태 묶음. 선택 없이 부르면 예전과 같은 전체 묶음이다(출시 앱 0.2.2~0.2.9 가 받는 모양).
   * lite: 자료 본문을 읽지 않는다(본문 칸은 빈 글자, 보내는 쪽이 칸을 뺀다). window: 0.2.10 창 묶음(ProjectStateWindow).
   */
  projectState(id: string, opts: StateReadOptions = {}): ProjectState {
    return this.withDeliveryRead(id, () => this.readProjectState(id, opts));
  }

  private readProjectState(id: string, opts: StateReadOptions = {}): ProjectState {
    const project = this.requireProject(id);
    const members = this.listMembers(id);
    const decisions = this.listDecisions(id);
    const doneDecisionCount = this.row("SELECT COUNT(*) AS n FROM decisions WHERE project_id = ? AND status != 'open'", id)!.n as number;
    if (opts.window) {
      const todos = this.todoWindow(id), work = this.workWindow(id);
      const files = this.fileList(id, { lite: opts.lite, latestOnly: true });
      const window: ProjectStateWindow = { doneTodos: todos.total, doneWork: work.total, olderFileVersions: files.omitted,
        todosCursor: todos.cursor, workCursor: work.cursor };
      return { project, members, decisions, doneDecisionCount, todos: todos.items, work: work.items,
        messages: this.listMessages(id, { limit: 200 }), files: files.files, window };
    }
    return {
      project,
      members,
      decisions,
      doneDecisionCount,
      todos: this.listTodos(id),
      work: this.listWork(id),
      messages: this.listMessages(id, { limit: 200 }),
      // 0.2.7 묶음 4: 최신 판에 판 수를 더한다(옛 판은 replacedBy 로 가린다. 모든 판은 GET /api/files/:id/versions 로도).
      files: this.listFilesWithVersions(id, { lite: opts.lite }),
    };
  }

  /**
   * 0.2.10 창 묶음의 끝난 항목: 최근 끝낸 순서로 STATE_WINDOW_DONE 개, 24시간 안에 끝낸 것이 더 많으면 그것 전부.
   * 늘 '최근 끝낸 순서의 앞부분'이라 그 다음 쪽은 마지막 항목의 (열쇠, id) 로 이어 받는다.
   */
  private doneWindowLimit(table: "todos" | "work", projectId: string, now = Date.now()): { limit: number; total: number; shown: number } {
    const [key, finished] = table === "todos" ? [TODO_DONE_KEY, "done != 0"] : [WORK_DONE_KEY, "sec = 'done'"];
    // shown: 화면이 '완료'로 세는 수. 할 일은 '필요 없음'(dropped)을 뺀다(홈 '완료한 할 일 n'), 업무는 완료 칸 전부.
    const shown = table === "todos" ? "COALESCE(SUM(COALESCE(outcome, '') != 'dropped'), 0)" : "COUNT(*)";
    const r = this.row(`SELECT COUNT(*) AS total, ${shown} AS shown, COALESCE(SUM(${key} >= ?), 0) AS recent FROM ${table} WHERE project_id = ? AND ${finished}`,
      new Date(now - STATE_WINDOW_RECENT_MS).toISOString(), projectId)!;
    return { limit: Math.max(STATE_WINDOW_DONE, r.recent as number), total: r.total as number, shown: r.shown as number };
  }

  /** 안 끝난 할 일 전부 + 끝난 할 일의 창. 순서는 listTodos 와 같다(만든 순). */
  private todoWindow(projectId: string): { items: Todo[]; total: number; cursor: string | null } {
    const { limit, total, shown } = this.doneWindowLimit("todos", projectId);
    const rows = this.rows(`SELECT * FROM todos WHERE project_id = ?1 AND (done = 0 OR id IN (
        SELECT id FROM todos WHERE project_id = ?1 AND done != 0 ORDER BY ${TODO_DONE_KEY} DESC, id DESC LIMIT ?2))
      ORDER BY created_at, rowid`, projectId, limit);
    return { items: rows.map(toTodo), total: shown, cursor: total > limit ? this.doneCursorAt("todos", projectId, limit) : null };
  }

  /** 끝나지 않은 업무 전부 + 완료 칸의 창. 순서는 listWork 와 같다(sort_order). */
  private workWindow(projectId: string): { items: WorkItem[]; total: number; cursor: string | null } {
    const { limit, total } = this.doneWindowLimit("work", projectId);
    const rows = this.rows(`SELECT * FROM work WHERE project_id = ?1 AND (sec != 'done' OR id IN (
        SELECT id FROM work WHERE project_id = ?1 AND sec = 'done' ORDER BY ${WORK_DONE_KEY} DESC, id DESC LIMIT ?2))
      ORDER BY sort_order, rowid`, projectId, limit);
    return { items: rows.map(toWork), total, cursor: total > limit ? this.doneCursorAt("work", projectId, limit) : null };
  }

  /** 최근 끝낸 순서로 count 번째 항목(창의 마지막)의 쪽 위치. 정렬은 SQL 그대로라 쪽 받기와 어긋나지 않는다. */
  private doneCursorAt(table: "todos" | "work", projectId: string, count: number): string | null {
    const [key, finished] = table === "todos" ? [TODO_DONE_KEY, "done != 0"] : [WORK_DONE_KEY, "sec = 'done'"];
    const r = this.row(`SELECT ${key} AS done_key, id FROM ${table} WHERE project_id = ? AND ${finished} ORDER BY done_key DESC, id DESC LIMIT 1 OFFSET ?`, projectId, count - 1);
    return r ? encodeDoneCursor(r.done_key, r.id) : null;
  }

  /** 0.2.10: 끝난 할 일을 최근 끝낸 순서로 이어 받는다(창 묶음의 todosCursor 다음부터). 보관한 프로젝트는 없는 것으로 친다. */
  /** revisions: 실린 할 일의 쓰기 판 번호(같은 행에서 읽어 값과 어긋나지 않는다). 앱이 창 밖 할 일의 체크를 풀 때 쓴다. */
  listDoneTodosPage(projectId: string, opts: { cursor?: string; limit?: number } = {}): DoneTodosPage {
    const revisions: Record<string, number> = {};
    const page = this.donePage("todos", projectId, opts, (r) => { revisions[r.id] = r.revision; return toTodo(r); });
    return { ...page, revisions };
  }

  /** 0.2.10: 완료 칸 업무를 최근 끝낸 순서로 이어 받는다(창 묶음의 workCursor 다음부터). */
  listDoneWorkPage(projectId: string, opts: { cursor?: string; limit?: number } = {}): DonePage<WorkItem> {
    return this.donePage("work", projectId, opts, toWork);
  }

  private donePage<T>(table: "todos" | "work", projectId: string, opts: { cursor?: string; limit?: number }, map: (r: Row) => T): DonePage<T> {
    if (this.requireProject(projectId).archived) throw new ApiError(404, "보관된 프로젝트입니다", "project_archived");
    const limit = opts.limit ?? STATE_WINDOW_DONE;
    if (!Number.isInteger(limit) || limit < 1 || limit > DONE_PAGE_MAX) throw new ApiError(400, "조회 개수가 올바르지 않습니다", "invalid_limit");
    const [key, finished] = table === "todos" ? [TODO_DONE_KEY, "done != 0"] : [WORK_DONE_KEY, "sec = 'done'"];
    const after = opts.cursor === undefined ? null : parseDoneCursor(opts.cursor);
    const rows = after
      ? this.rows(`SELECT *, ${key} AS done_key FROM ${table} WHERE project_id = ? AND ${finished} AND (${key} < ? OR (${key} = ? AND id < ?))
          ORDER BY done_key DESC, id DESC LIMIT ?`, projectId, after[0], after[0], after[1], limit + 1)
      : this.rows(`SELECT *, ${key} AS done_key FROM ${table} WHERE project_id = ? AND ${finished} ORDER BY done_key DESC, id DESC LIMIT ?`, projectId, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(map), nextCursor: rows.length > limit && last ? encodeDoneCursor(last.done_key, last.id) : null };
  }

  // ---- 직원 ----
  getMember(id: string): Member | null {
    return this.deliveryReadMemo(`member:${id}`, () => {
      const r = this.row(`${MEMBER_SELECT} WHERE m.id = ?`, id);
      return r ? toMember(r) : null;
    });
  }

  requireMember(id: string): Member {
    const m = this.getMember(id);
    if (!m) throw new ApiError(404, "팀원을 찾을 수 없습니다", "member_not_found");
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
    if (!r) throw new ApiError(404, "팀원을 찾을 수 없습니다", "member_not_found");
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

  createMember(input: NewMember): Member {
    return this.transaction(() => {
      const project = this.requireProject(input.projectId);
      checkMemberText(input.name, input.role, input.kind);
      if (input.kind === "worker" && RESERVED_HANDLES.has(input.handle)) throw new ApiError(400, `총괄 자리의 핸들이라 팀장에게 쓸 수 없습니다: ${input.handle}`, "handle_reserved");
      if (!HANDLE_RE.test(input.handle)) throw new ApiError(400, "핸들은 영문 소문자로 시작하고 영문 소문자·숫자·_·- 만 쓸 수 있습니다(32자 이내)", "handle_invalid");
      if (this.getMemberByHandle(input.projectId, input.handle)) throw new ApiError(409, `이미 있는 핸들입니다: ${input.handle}`, "handle_taken");
      if (this.row("SELECT 1 FROM members WHERE project_id = ? AND name = ?", input.projectId, input.name)) {
        throw new ApiError(409, `이미 있는 이름입니다: ${input.name}`, "name_taken");
      }
      const id = newId("m_");
      const at = nowIso();
      this.run(
        `INSERT INTO members (id, project_id, handle, name, role, kind, origin, backend, status, cwd, session_id, pane_id, parallel, token, updated_at, created_at, cli, model_override)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.cli ?? "claude",
        input.modelOverride ?? null,
      );
      const member = this.requireMember(id);
      this.emit({ type: "member", member });
      this.emitProjects();
      return member;
    });
  }

  patchMember(id: string, patch: MemberPatch): Member {
    return this.transaction(() => {
      const before = this.requireMember(id);
      checkMemberText(patch.name, patch.role, before.kind);
      // 배운 창 크기는 그 세션·CLI 의 것이다. 세션이나 CLI 가 바뀌면 다음 턴 끝에 다시 배운다.
      const sessionChanged = (patch.sessionId !== undefined && patch.sessionId !== before.sessionId) || (patch.cli !== undefined && patch.cli !== before.cli);
      if (sessionChanged && patch.contextWindow === undefined) patch = { ...patch, contextWindow: null, contextWindowSource: null };
      if (patch.contextWindow === null) patch = { ...patch, contextWindowSource: null };
      if (sessionChanged && patch.contextWindowSource === undefined) patch = { ...patch, contextWindowSource: null };
      // 같은 세션의 실측 창은 화면 추정으로 덮지 않는다.
      if (!sessionChanged && exactSource(before.contextWindowSource) && patch.contextWindowSource === "screen") {
        patch = { ...patch, contextWindow: before.contextWindow, contextWindowSource: before.contextWindowSource };
      }
      // blocked 자체는 입력 보류다. 새 진입에서 이전 승인의 증거를 재사용하지 않는다.
      // 예외: usage_limit 은 창의 까닭이 아니라 사용 한도 보류의 표시다(메뉴 없이 한도 오류로 멈춘 팀장은 error 와 함께 적힌다. 예전에는 이 줄이 그것마저 지웠다).
      // 상태만 바뀌어서는(터미널이 사라져 꺼짐, 메뉴를 닫음, 다시 열기) 지우지 않는다. 보류가 풀릴 때 ApiRecovery 가 직접 지운다.
      // 지우면 화면(쉬는 중·안 보임)과 실제(한도 보류)가 어긋났다.
      const usageMark = patch.blockedReason === "usage_limit" || (patch.blockedReason === undefined && before.blockedReason === "usage_limit");
      if (patch.status !== undefined && patch.status !== "blocked" && !usageMark) patch = { ...patch, blockedReason: null };
      else if (patch.status === "blocked" && before.status !== "blocked" && patch.blockedReason === undefined) patch = { ...patch, blockedReason: "status_unknown" };
      // 보류 코드는 lastError 와 짝이다. lastError 를 바꾸면서 코드를 주지 않으면 보류가 아닌 글로 덮인 것이라 지운다(옛 앞머리 판정과 같은 결과).
      if (patch.lastError !== undefined && patch.fenceCode === undefined) patch = { ...patch, fenceCode: null };
      if (patch.fenceCode === null && !before.fenceCode) { const { fenceCode: _, ...rest } = patch; patch = rest; }
      const at = nowIso();
      if (patch.now !== undefined && patch.nowAt === undefined) patch = { ...patch, nowAt: at };
      const changed = Object.entries(patch).filter(([key, value]) => value !== undefined && JSON.stringify(value) !== JSON.stringify(before[key as keyof MemberPatch]));
      if (!changed.length) return before;
      const observationOnly = changed.every(([key]) => key === "statusObservation") && patch.statusObservation && before.statusObservation &&
        JSON.stringify({ ...patch.statusObservation, observedAt: null }) === JSON.stringify({ ...before.statusObservation, observedAt: null });
      // 관측 시각만 새로워진 것은 30초에 한 번만 적는다. 살아 있는 직원마다 5초에 한 번씩 적으면 스냅샷마다 전 직원이
      // 바뀐 것으로 보여 앱이 화면 전체를 다시 계산한다. 승인 창 앞(blocked)은 앱이 이 시각으로 창을 다시 읽으므로 그대로 적는다.
      if (observationOnly && before.status !== "blocked") {
        const last = Date.parse(before.statusObservation!.observedAt ?? ""), next = Date.parse(patch.statusObservation!.observedAt ?? "");
        if (Number.isFinite(last) && Number.isFinite(next) && next - last < 30_000 && next >= last) return before;
      }
      const { set, values } = buildSet({
        ...patch,
        statusObservation: patch.statusObservation == null ? patch.statusObservation : JSON.stringify(patch.statusObservation),
        subagentState: patch.subagentState == null ? patch.subagentState : JSON.stringify(patch.subagentState),
      }, MEMBER_COLUMNS);
      if (set.length === 0) return before;
      if (["name", "role", "cli", "modelOverride", "effortOverride", "cwd", "backend"].some((key) => patch[key as keyof MemberPatch] !== undefined && patch[key as keyof MemberPatch] !== before[key as keyof MemberPatch])) set.push("config_revision = config_revision + 1");
      set.push("updated_at = ?");
      values.push(at);
      this.run(`UPDATE members SET ${set.join(", ")} WHERE id = ?`, ...values, id);
      if ((patch.modelOverride !== undefined && patch.modelOverride !== before.modelOverride) || (patch.sessionId !== undefined && before.sessionId !== null && patch.sessionId !== before.sessionId) || (patch.cli !== undefined && patch.cli !== before.cli)) {
        this.run("UPDATE member_context_state SET measurement_json = NULL, updated_at = ? WHERE member_id = ?", nowIso(), id);
      }
      const member = this.requireMember(id);
      if (observationOnly) return member;
      // API incidents and usage cards own their notifications; avoid one generic error push per employee.
      // D2-4·D4-2: 재시작으로 꺼져 서버가 스스로 다시 여는 중인 팀장의 오류는 그 묶음이 끝날 때 한 번만 알린다(restartOwned).
      if (!["network_outage", "network_retry", "usage_limit"].includes(member.statusObservation?.error?.code ?? "")) this.recorder?.member(before, member, { restartOwned: this.restartOwned(id) });
      this.emit({ type: "member", member });
      // 0.2.7: 서브에이전트가 일하기 시작하거나 다 끝나면 프로젝트 요약의 subagentWorkingCount 가 바뀐다.
      if (member.status !== before.status || member.blockedReason !== before.blockedReason || (member.subagents > 0) !== (before.subagents > 0)) this.emitProjects();
      // Z: 턴 도중 승인 창·한도·오류로 멈추거나 풀리면 그 팀장이 받은 대표 글의 답 상태가 바뀐다.
      if (member.status !== before.status || member.blockedReason !== before.blockedReason || member.fenceCode !== before.fenceCode
        || member.statusObservation?.error?.code !== before.statusObservation?.error?.code) this.noteReply(id);
      return member;
    });
  }

  getAppliedConfig(id: string): AppliedConfig | null {
    const r = this.row("SELECT applied_config FROM members WHERE id = ?", id);
    return r ? appliedOf(r) : null;
  }

  /** 세션에 실제로 들어간 설정을 적는다. 잦지 않고, 바뀌었을 때만 화면에 알린다. */
  /**
   * 비어 있는 직급 effort 를 채운다. 비어 있으면 세션을 다시 열 때 CLI 기본값(medium)으로 돌아간다.
   * Claude 직급표(ranks)만 채운다. Gemini 직급표(geminiRanks)는 채우지 않는다: 모델을 정하지 않은 Gemini 에 effort 를 주면
   * agy 가 사용자 설정의 기본 모델로 따져 시작 전에 오류로 끝날 수 있다(server/models.ts 의 efforts). Codex 직급표도 예전부터 채우지 않는다.
   */
  fillRankEfforts(fallback: Effort): void {
    const { ranks } = this.getSettings();
    const missing = (Object.keys(ranks) as Rank[]).filter((r) => !ranks[r].effort);
    if (missing.length === 0) return;
    this.patchSettings({ ranks: Object.fromEntries(missing.map((r) => [r, { effort: fallback }])) });
  }

  setAppliedConfig(id: string, config: AppliedConfig | null): void {

    this.transaction(() => {
      const value = config ? JSON.stringify(config) : null;
      const before = this.row("SELECT applied_config FROM members WHERE id = ?", id);
      if ((before?.applied_config ?? null) === value) return;
      // 세션에 들어간 모델이 바뀌면 배운 창 크기도 그 모델의 것이 아니다.
      const modelChanged = (before ? appliedOf(before)?.model ?? null : null) !== (config?.model ?? null);
      this.run(`UPDATE members SET applied_config = ?${modelChanged ? ", context_window = NULL, context_window_source = NULL" : ""} WHERE id = ?`, value, id);
      if (modelChanged) this.run("UPDATE member_context_state SET measurement_json = NULL, updated_at = ? WHERE member_id = ?", nowIso(), id);
      this.emitMember(id);
    });
  }

  /** 도구 활동 시각은 일반 수정 시각과 분리한다. 잦아서 방송하지 않는다. */
  touchMember(id: string): void {
    const at = nowIso();
    this.run("UPDATE members SET updated_at = ?, manual_activity_at = CASE WHEN origin = 'manual' THEN ? ELSE manual_activity_at END WHERE id = ?", at, at, id);
  }

  /** 그 직원의 전달·활동도 함께 사라진다(CASCADE). 대화·결재 기록은 남는다. */
  removeMember(id: string): void {
    return this.transaction(() => {
      const member = this.requireMember(id);
      this.run("DELETE FROM members WHERE id = ?", id);
      this.emit({ type: "member_removed", projectId: member.projectId, memberId: id });
      this.emitProjects();
    });
  }

  // ---- 결재 ----
  getDecision(id: string): Decision | null {
    const r = this.row("SELECT * FROM decisions WHERE id = ?", id);
    return r ? toDecision(r) : null;
  }

  requireDecision(id: string): Decision {
    const d = this.getDecision(id);
    if (!d) throw new ApiError(404, "결재를 찾을 수 없습니다", "decision_not_found");
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

  // ---- 0.2.6 Y: 서버가 만든 글의 언어 ----
  /** 서버가 만드는 글을 그릴 언어(보고 언어). 없으면 한국어. */
  reportLang(): TextLang { return textLang(this.getSettings().reportLanguage); }
  /** 코드를 보고 언어의 문장으로. 코드 표와 부르는 쪽이 어긋나면 예외다. */
  renderText(ref: ServerTextRef): string { return mustRender(ref, this.reportLang()); }

  /** 카드 입력의 글 코드로 제목·본문·선택지를 그리고, 저장할 text_ref 를 만든다. */
  private decisionTexts<T extends Pick<NewDecision, "title" | "detail" | "options" | "texts">>(input: T): { input: T; stored: string } {
    const lang = this.reportLang();
    const refs = input.texts ?? {};
    const rendered = refs.text ? renderDecisionText(refs.text, lang, input.title) : { title: input.title, detail: input.detail ?? "" };
    return { input: { ...input, title: rendered.title, detail: rendered.detail, options: renderOptions(input.options ?? [], refs.options, lang) }, stored: storedDecisionTexts(refs, lang) };
  }

  /** 카드의 text_ref 한 칸(닫힌 이유·다시 연 까닭)을 바꾸고 그 문장을 돌려준다. 다른 칸의 코드는 그대로 둔다. */
  private withDecisionText(id: string, field: "closeReason" | "reopenNote", ref: ServerTextRef): string {
    const lang = this.reportLang();
    const base = this.decisionTextsIn(id, lang);
    this.run("UPDATE decisions SET text_ref = ? WHERE id = ?", storedDecisionTexts({ ...base, [field]: ref }, lang), id);
    return mustRender(ref, lang);
  }

  /**
   * 카드에 저장된 글 코드를 이 언어로. 같은 언어면 그대로, 보고 언어가 바뀐 뒤면 코드가 있는 칸(제목·본문·선택지·닫힌 이유·다시 연 까닭)의
   * 문장을 새 언어로 다시 써 둔다(0.2.6 Y 리뷰: 한 카드는 한 언어. 앞 칸 코드를 버리면 그 칸만 앞 언어로 남아 두 언어가 섞였다).
   * 부르는 쪽이 같은 거래 안에서 판(updated_at)을 올리고 알린다.
   */
  private decisionTextsIn(id: string, lang: TextLang): DecisionTextRefs {
    const stored = readDecisionTexts(this.row("SELECT text_ref FROM decisions WHERE id = ?", id)?.text_ref);
    if (!stored) return {};
    if (stored.lang === lang) return { text: stored.text, options: stored.options, closeReason: stored.closeReason, reopenNote: stored.reopenNote };
    const { refs, patch } = relocalizeDecisionTexts(stored, this.requireDecision(id), lang);
    if (patch.title !== undefined) this.run("UPDATE decisions SET title = ? WHERE id = ?", patch.title, id);
    if (patch.detail !== undefined) this.run("UPDATE decisions SET detail = ? WHERE id = ?", patch.detail, id);
    if (patch.options !== undefined) this.run("UPDATE decisions SET options = ? WHERE id = ?", JSON.stringify(patch.options), id);
    if (patch.closeReason !== undefined) this.run("UPDATE decisions SET close_reason = ? WHERE id = ?", patch.closeReason, id);
    if (patch.reopenNote !== undefined) this.run("UPDATE decisions SET reopen_note = ? WHERE id = ?", patch.reopenNote, id);
    return refs;
  }

  /** 앞 판보다 반드시 큰 시각. 같은 ms 안의 전이도 화면이 순서를 가른다. */
  private nextDecisionStamp(id: string): string {
    const before = this.row("SELECT updated_at FROM decisions WHERE id = ?", id)?.updated_at as string | null | undefined;
    const prev = before ? Date.parse(before) : 0;
    return new Date(Math.max(Date.now(), prev + 1)).toISOString();
  }

  /**
   * 팀장이 ask 로 올려 답을 기다리는 결재. 도구 승인 카드(K)는 뺀다: CLI 의 승인 창에 딸린 잠깐의 카드라 팀장의 '결재 대기'·잠재우기 판단에 넣지 않는다.
   */
  listOpenDecisionsByMember(memberId: string): Decision[] {
    return this.rows("SELECT * FROM decisions WHERE member_id = ? AND status = 'open' AND tool_permission_json IS NULL ORDER BY created_at, rowid", memberId).map(toDecision);
  }

  createDecision(input: NewDecision): Decision {
    return this.transaction(() => {
      this.requireProject(input.projectId);
      const id = newId("d_");
      const texts = input.texts ? this.decisionTexts(input) : null;
      if (texts) input = texts.input;
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
      if (texts) this.run("UPDATE decisions SET text_ref = ? WHERE id = ?", texts.stored, id);
      if (input.replaces) this.run("UPDATE decisions SET replaces = ? WHERE id = ?", input.replaces, id);
      const decision = this.requireDecision(id);
      this.recorder?.decision(null, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return decision;
    });
  }

  private normalizeAnswer(d: Decision, req: AnswerReq): { choice: string | null; note: string | null; batch: boolean; fileIds: string[] } {
    const batch = !!req.batch;
    const choice = req.choice?.trim() || (batch ? d.rec : null);
    // D5-10: 대표가 쓴 메모에 섞인 제어문자는 저장 전에 지운다.
    const note = req.note == null ? null : stripControls(req.note).trim() || null;
    if (!choice && !note) throw new ApiError(400, "선택지나 메모가 필요합니다", "decision_answer_empty");
    const option = choice ? d.options.find((o) => o.k === choice) : undefined;
    if (choice && !option) throw new ApiError(400, `없는 선택지입니다: ${choice}`, "decision_option_unknown");
    // D3-4: 결재 답 첨부. 같은 id 를 두 번 실어도 한 번으로 친다.
    const fileIds = [...new Set(req.fileIds ?? [])];
    // D3-7: '메모에 적음' 같은 선택지는 메모(또는 첨부)가 있어야 답이 된다(출시 앱은 이 표시를 몰라 여기서 막는다. 출시 앱은 첨부를 못 단다).
    if (option?.needsNote && !note && !fileIds.length) throw new ApiError(400, "이 선택지는 메모를 함께 적어야 합니다", "decision_note_required");
    if (fileIds.length && (d.kind === "usage_limit" || d.kind === "tool_permission")) throw new ApiError(400, "이 카드의 답에는 첨부를 붙일 수 없습니다", "decision_attachment_unsupported");
    return { choice, note, batch, fileIds };
  }

  /**
   * 기록 없이 답을 검사한다. 이미 답한 카드에 같은 답이면 그 카드를 돌려주고,
   * 아직 열려 있으면 null, 다른 답이면 409.
   */
  checkAnswer(id: string, req: AnswerReq): Decision | null {
    const d = this.requireDecision(id);
    const a = this.normalizeAnswer(d, req);
    if (d.status === "open") {
      if (req.expectedVersion && req.expectedVersion !== d.updatedAt) throw new ApiError(409, "결재가 변경되었습니다. 새로 불러온 뒤 다시 답하세요", "decision_changed");
      return null;
    }
    const files = (d.answerAttachments ?? []).map((f) => f.id);
    if (d.choice === a.choice && d.note === a.note && d.batch === a.batch && files.length === a.fileIds.length && files.every((id) => a.fileIds.includes(id))) return d;
    throw new ApiError(409, "이미 처리한 결재입니다", "decision_already_answered");
  }

  /** 멱등: changed=false 면 같은 답이 이미 기록되어 있어 아무것도 안 했다. 다른 답이면 409. */
  answerDecision(id: string, req: AnswerReq): { decision: Decision; changed: boolean } {
    return this.transaction(() => {
      const existing = this.checkAnswer(id, req);
      if (existing) return { decision: existing, changed: false };
      const before = this.requireDecision(id);
      const a = this.normalizeAnswer(before, req);
      const attachments = a.fileIds.map((fileId) => {
        const found = this.getAttachment(fileId);
        if (!found) throw new ApiError(400, "업로드된 첨부를 찾을 수 없습니다", "upload_not_found");
        return found;
      });
      this.run(
        "UPDATE decisions SET status = 'answered', choice = ?, note = ?, batch = ?, answered_at = ?, updated_at = ?, last_choice = NULL, last_note = NULL, last_answer_attachments = NULL, reopen_note = NULL, answer_attachments = ? WHERE id = ?",
        a.choice,
        a.note,
        a.batch ? 1 : 0,
        nowIso(),
        this.nextDecisionStamp(id),
        attachments.length ? JSON.stringify(attachments) : null,
        id,
      );
      const decision = this.requireDecision(id);
      this.recorder?.decision(before, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return { decision, changed: true };
    });
  }

  /** 전달됨·닫힘으로 옮기거나, 전달이 실패하면 answered 로 되돌린다. 닫으면 inbox 에서 빠진다. */
  setDecisionStatus(id: string, status: Extract<DecisionStatus, "answered" | "delivered" | "closed">): Decision {
    return this.transaction(() => {
      const before = this.requireDecision(id);
      const stamp = this.nextDecisionStamp(id);
      if (status === "delivered") {
        this.run("UPDATE decisions SET status = 'delivered', delivered_at = COALESCE(delivered_at, ?), updated_at = ? WHERE id = ?", nowIso(), stamp, id);
      } else if (status === "answered") {
        this.run("UPDATE decisions SET status = 'answered', delivered_at = NULL, updated_at = ? WHERE id = ?", stamp, id);
      } else {
        this.run("UPDATE decisions SET status = 'closed', updated_at = ? WHERE id = ?", stamp, id);
        if (before.usageLimit) this.run("UPDATE decisions SET usage_limit_json = ? WHERE id = ?", JSON.stringify({ ...before.usageLimit, stillLimited: false }), id);
      }
      const decision = this.requireDecision(id);
      this.recorder?.decision(before, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return decision;
    });
  }

  /**
   * 열린 결재를 이유와 함께 닫는다. kind 가 있으면 AI 가 ask_close 로 닫은 것이라 대표가 다시 열 수 있다.
   * 열려 있지 않으면 409(대표가 이미 답했거나 닫혔다). 닫힌 카드는 결재된 항목으로 간다.
   */
  closeDecision(id: string, input: { kind: DecisionCloseKind | null; reason: string | ServerTextRef; by: string; quote?: string | null }): Decision {
    return this.transaction(() => {
      const before = this.requireDecision(id);
      if (before.status !== "open") throw new ApiError(409, before.status === "closed" ? "이미 닫힌 결재입니다" : "대표가 이미 답한 결재입니다", "decision_closed");
      // Y: 서버가 정한 닫힌 이유는 코드로 보고 언어의 문장을 그리고 코드를 카드의 text_ref 에 더한다.
      const reason = typeof input.reason === "string" ? input.reason : this.withDecisionText(id, "closeReason", input.reason);
      const at = nowIso();
      if (before.usageLimit) this.run("UPDATE decisions SET usage_limit_json = ? WHERE id = ?", JSON.stringify({ ...before.usageLimit, stillLimited: false }), id);
      this.run(
        "UPDATE decisions SET status = 'closed', close_kind = ?, close_reason = ?, close_quote = ?, closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
        input.kind,
        reason,
        input.quote ?? null,
        input.by,
        at,
        this.nextDecisionStamp(id),
        id,
      );
      const decision = this.requireDecision(id);
      this.recorder?.decision(before, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return decision;
    });
  }

  /** 0.2.7 묶음 4: 앞 카드에 그것을 대신한 새 카드를 잇는다. 부르는 쪽이 같은 거래에서 앞 카드를 닫는다(closeDecision 이 알린다). */
  setDecisionReplacedBy(id: string, replacedBy: string): void {
    this.run("UPDATE decisions SET replaced_by = ? WHERE id = ?", replacedBy, id);
  }

  auditDecisionClose(decisionId: string, answeredDecisionId: string, actorId: string, sameIssue: string | null, quote: string): void {
    this.run("INSERT INTO decision_close_audit (decision_id, answered_decision_id, actor_id, same_issue, answer_quote, created_at) VALUES (?, ?, ?, ?, ?, ?)", decisionId, answeredDecisionId, actorId, sameIssue, quote, nowIso());
  }

  /**
   * 끝내 전달하지 못한 답은 대표가 다시 답할 수 있게 카드를 연다. 메모의 사본은 전달 글뿐이었으니 직전 답을 카드에 남긴다. 닫힌 카드를 다시 열 때도 쓴다(닫은 이유는 지운다).
   * 0.2.7 묶음 4: 직전 답의 첨부도 lastAnswerAttachments 로 남긴다(앱은 답할 때 첨부 초안을 비웠다. 남기지 않으면 다시 보낸 답에 첨부가 빠진다).
   */
  reopenDecision(id: string, reason: string | ServerTextRef = textRef("card.reopen_undelivered")): Decision {
    return this.transaction(() => {
      const before = this.requireDecision(id);
      // Y: 서버가 정한 다시 연 까닭은 코드로 그린다. 닫힌 이유의 코드는 닫힌 이유와 함께 지워진다(응답에서 문장과 맞춰 보므로 남아도 나가지 않는다).
      const why = typeof reason === "string" ? reason : this.withDecisionText(id, "reopenNote", reason);
      this.run(
        "UPDATE decisions SET status = 'open', last_choice = COALESCE(choice, last_choice), last_note = COALESCE(note, last_note), last_answer_attachments = COALESCE(answer_attachments, last_answer_attachments), reopen_note = ?, choice = NULL, note = NULL, batch = 0, answered_at = NULL, delivered_at = NULL, close_kind = NULL, close_reason = NULL, close_quote = NULL, closed_by = NULL, closed_at = NULL, answer_attachments = NULL, updated_at = ? WHERE id = ?",
        why,
        this.nextDecisionStamp(id),
        id,
      );
      const decision = this.requireDecision(id);
      this.recorder?.decision(before, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return decision;
    });
  }

  // ---- K(E2): 도구 승인 카드 ----
  /** CLI 의 PermissionRequest 훅이 올린 요청을 카드로 연다. 요약(toolPermission)만 저장한다. 질문 글·총괄 알림은 만들지 않는다. */
  createToolPermissionDecision(input: NewDecision & { memberId: string; toolPermission: ToolPermissionInfo }): Decision {
    return this.transaction(() => {
      this.requireProject(input.projectId);
      const id = newId("d_");
      const at = nowIso();
      const texts = input.texts ? this.decisionTexts(input) : null;
      if (texts) input = { ...input, ...texts.input };
      this.run(
        `INSERT INTO decisions (id, project_id, member_id, who, title, detail, options, rec, grp, file_id, images, status, created_at, updated_at, tool_permission_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]', 'open', ?, ?, ?)`,
        id, input.projectId, input.memberId, input.who, input.title, input.detail ?? "", JSON.stringify(input.options ?? []), at, at, JSON.stringify(input.toolPermission),
      );
      if (texts) this.run("UPDATE decisions SET text_ref = ? WHERE id = ?", texts.stored, id);
      const decision = this.requireDecision(id);
      this.recorder?.decision(null, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return decision;
    });
  }

  /**
   * 도구 승인 카드의 답. 훅이 기다리는 동안에만 부르며, 답은 곧바로 그 훅에 돌아가므로 answered 를 거치지 않고 delivered 로 둔다
   * (answered 로 남으면 결재 답 재전달 흐름이 팀장에게 글로 다시 보낸다). 열려 있지 않으면 409.
   */
  answerToolPermission(id: string, answer: { choice: string | null; note: string | null }): Decision {
    return this.transaction(() => {
      const before = this.requireDecision(id);
      if (before.kind !== "tool_permission") throw new ApiError(400, "도구 승인 카드가 아닙니다", "tool_permission_only");
      if (before.status !== "open") throw new ApiError(409, "이미 닫혔거나 대표가 답한 결재입니다", "decision_closed");
      const at = nowIso();
      this.run("UPDATE decisions SET status = 'delivered', choice = ?, note = ?, batch = 0, answered_at = ?, delivered_at = ?, updated_at = ? WHERE id = ? AND status = 'open'",
        answer.choice, answer.note, at, at, this.nextDecisionStamp(id), id);
      const decision = this.requireDecision(id);
      this.recorder?.decision(before, decision);
      this.bumpBoard(decision.projectId);
      this.emit({ type: "decision", decision });
      this.emitProjects();
      return decision;
    });
  }

  /** 열린 도구 승인 카드 전부(서버가 시작할 때 지난 실행의 것을 닫는다). */
  listOpenToolPermissions(): Decision[] {
    return this.rows("SELECT * FROM decisions WHERE status = 'open' AND tool_permission_json IS NOT NULL ORDER BY created_at, rowid").map(toDecision);
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
    if (!t) throw new ApiError(404, "할 일을 찾을 수 없습니다", "todo_not_found");
    return t;
  }

  listTodos(projectId: string): Todo[] {
    return this.rows("SELECT * FROM todos WHERE project_id = ? ORDER BY created_at, rowid", projectId).map(toTodo);
  }

  listStaleTodos(projectId: string, now = Date.now()): Todo[] {
    return this.rows("SELECT * FROM todos WHERE project_id = ? AND done = 0 AND created_at < ? ORDER BY created_at, rowid",
      projectId, new Date(now - 3 * 86_400_000).toISOString()).map(toTodo);
  }

  /** Queue and stamp atomically; no recipient means no stamp so a future lead can receive it. */
  remindStaleTodo(todo: Todo, memberId: string, text: string, now: number): boolean {
    return this.transaction(() => {
      const row = this.row("SELECT done, stale_notified_at FROM todos WHERE id = ?", todo.id);
      if (!row || row.done || row.stale_notified_at && now - Date.parse(row.stale_notified_at) < 3 * 86_400_000) return false;
      this.enqueue({ projectId: todo.projectId, memberId, kind: "system", text, wake: false });
      this.run("UPDATE todos SET stale_notified_at = ? WHERE id = ?", new Date(now).toISOString(), todo.id);
      return true;
    });
  }

  staleReviewDue(projectId: string, now: number): boolean {
    const row = this.row("SELECT stale_review_at FROM projects WHERE id = ?", projectId);
    return !row?.stale_review_at || now - Date.parse(row.stale_review_at) >= 86_400_000;
  }

  markStaleReview(projectId: string, at: string): void {
    this.run("UPDATE projects SET stale_review_at = ? WHERE id = ?", at, projectId);
  }

  createTodo(input: NewTodo): Todo {
    return this.transaction(() => {
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
      this.bumpBoard(todo.projectId);
      this.emit({ type: "todo", todo });
      this.emitProjects();
      return todo;
    });
  }

  /**
   * 0.2.7 묶음 4(todo_update): 열린 할 일의 제목·내용을 고친다. 판(revision)은 올리지 않는다: 판은 대표의 끝냄·정리 쓰기를 맞추는 값이라,
   * 글만 고친 것으로 대표가 고르던 '했음'을 충돌로 돌려보내지 않는다. 화면은 할 일 사건으로 다시 읽는다. 새 알림(푸시)은 없다.
   */
  updateTodo(id: string, patch: { title?: string; detail?: string }): { todo: Todo; changed: boolean } {
    return this.transaction(() => {
      const before = this.requireTodo(id);
      if (before.done) throw new ApiError(409, "이미 끝났거나 정리된 할 일입니다", "todo_finished");
      const title = patch.title ?? before.title, detail = patch.detail ?? before.detail;
      if (title === before.title && detail === before.detail) return { todo: before, changed: false };
      this.run("UPDATE todos SET title = ?, detail = ?, updated_at = ? WHERE id = ? AND done = 0", title, detail, nowIso(), id);
      const todo = this.requireTodo(id);
      this.bumpBoard(todo.projectId);
      this.emit({ type: "todo", todo });
      this.emitProjects();
      return { todo, changed: true };
    });
  }

  /** 받을 사람이 없어 '했음'을 못 알린 할 일. 총괄이 뜨면 전한다. */
  setTodoCompletion(id: string, note: string | null, fileIds: string[]): Todo {
    this.run("UPDATE todos SET completion_note = ?, completion_file_ids = ? WHERE id = ?", note, JSON.stringify(fileIds), id);
    return this.requireTodo(id);
  }

  setTodoNoticePending(id: string, pending: boolean): void {
    this.run("UPDATE todos SET notice_pending = ? WHERE id = ?", pending ? 1 : 0, id);
  }

  listTodoNoticesPending(projectId: string): Todo[] {
    return this.rows("SELECT * FROM todos WHERE project_id = ? AND notice_pending = 1 AND done = 1 ORDER BY done_at, rowid", projectId).map(toTodo);
  }

  /** 대표의 체크. changed=false 면 이미 그 값이었다. 체크를 풀면 AI 가 정리한 이유도 지운다. */
  setTodoDone(id: string, done: boolean): { todo: Todo; changed: boolean } {
    return this.transaction(() => {
      const before = this.requireTodo(id);
      if (before.done === done) return { todo: before, changed: false };
      const at = nowIso();
      this.run(
        "UPDATE todos SET revision = revision + 1, done = ?, done_at = ?, outcome = ?, close_reason = NULL, closed_by = NULL, updated_at = ? WHERE id = ?",
        done ? 1 : 0,
        done ? at : null,
        done ? "done" : null,
        at,
        id,
      );
      const todo = this.requireTodo(id);
      this.bumpBoard(todo.projectId);
      this.emit({ type: "todo", todo });
      this.emitProjects();
      return { todo, changed: true };
    });
  }

  /** AI 의 todo_close. 안 끝난 할 일만. 끝남·필요 없어짐 모두 안 한 할 일 수에서 빠진다. */
  closeTodo(id: string, input: { outcome: TodoOutcome; reason: string | null; by: string }): Todo {
    return this.transaction(() => {
      const before = this.requireTodo(id);
      if (before.done) throw new ApiError(409, "이미 끝났거나 정리된 할 일입니다", "todo_finished");
      const at = nowIso();
      this.run(
        "UPDATE todos SET revision = revision + 1, done = 1, done_at = ?, outcome = ?, close_reason = ?, closed_by = ?, updated_at = ? WHERE id = ? AND done = 0",
        at,
        input.outcome,
        input.reason,
        input.by,
        at,
        id,
      );
      const todo = this.requireTodo(id);
      this.bumpBoard(todo.projectId);
      this.emit({ type: "todo", todo });
      this.emitProjects();
      return todo;
    });
  }

  // ---- 판 정리 ----
  /** 마지막으로 판 정리를 맡긴 시각. 화면도 알게 프로젝트로 방송한다. */
  setBoardTidiedAt(projectId: string, at: string): void {
    this.run("UPDATE projects SET board_tidied_at = ? WHERE id = ?", at, projectId);
    const project = this.getProject(projectId);
    if (project) this.emit({ type: "project", project });
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
    this.bumpBoard(projectId);
    this.emit({ type: "work", projectId, work: this.listWork(projectId) });
  }

  /** id 가 있으면 고치고(다른 프로젝트 항목이면 거부), 없으면 만든다. */
  upsertWork(input: WorkInput): WorkItem {
    return this.transaction(() => {
      this.requireProject(input.projectId);
      const at = nowIso();
      const doneAt = input.sec === "done" ? at : null;
      if (input.id) {
        const existing = this.getWork(input.id);
        if (!existing || existing.projectId !== input.projectId) throw new ApiError(404, `일 항목을 찾을 수 없습니다: ${input.id}`, "board_item_not_found");
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
    });
  }

  removeWork(id: string): void {
    return this.transaction(() => {
      const item = this.getWork(id);
      if (!item) return;
      this.run("DELETE FROM work WHERE id = ?", id);
      this.emitWork(item.projectId);
    });
  }

  // ---- 대화 ----
  getMessage(id: string): Message | null {
    const r = this.row("SELECT * FROM messages WHERE id = ?", id);
    return r ? this.messageFrom(r) : null;
  }

  requireMessage(id: string): Message {
    const m = this.getMessage(id);
    if (!m) throw new ApiError(404, "메시지를 찾을 수 없습니다", "message_not_found");
    return m;
  }

  /** `before`(at) 보다 앞선 것 중 최신 limit 개를 오래된 → 최신으로. */
  listMessages(projectId: string, opts: { before?: string; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = opts.before
      ? this.rows("SELECT * FROM messages WHERE project_id = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?", projectId, opts.before, limit)
      : this.rows("SELECT * FROM messages WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?", projectId, limit);
    return this.messagesFrom(projectId, rows.reverse());
  }

  /** 글마다 출처·전달을 따로 묻지 않도록 프로젝트 읽기 스냅샷 안에서 조립한다. */
  private messagesFrom(projectId: string, rows: Row[]): Message[] {
    return rows.length ? this.withDeliveryRead(projectId, () => {
      this.prefetchMessageReads(projectId, rows);
      return rows.map(r => this.messageFrom(r));
    }) : [];
  }

  /**
   * 0.2.10 인용 대조(MemberFlows.findQuoteSource)용: listMessages 와 같은 쪽(같은 정렬·같은 before·같은 limit 범위)을 오래된 → 최신으로 주되,
   * 글을 조립하지 않고(전달·답 상태·보고 출처 없이) id·시각·본문·대표 글 여부만 준다.
   */
  listMessageBodies(projectId: string, opts: { before?: string; limit?: number } = {}): { id: string; at: string; body: string; mine: boolean }[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = opts.before
      ? this.rows("SELECT id, at, body, mine FROM messages WHERE project_id = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?", projectId, opts.before, limit)
      : this.rows("SELECT id, at, body, mine FROM messages WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?", projectId, limit);
    return rows.reverse().map(row => ({ id: row.id, at: row.at, body: row.body, mine: !!row.mine }));
  }

  private messageScope(projectId: string, scope: MessageScope = { kind: "project" }): MessageScope {
    if (scope.kind === "project") return { kind: "project" };
    if (!scope.memberId || Buffer.byteLength(scope.memberId) > 256) throw new ApiError(400, "대화 조회 조건이 잘못되었습니다", "INVALID_MESSAGE_PAGE_QUERY");
    const lead = this.listMembers(projectId).find((m) => m.kind === "root" || m.kind === "conductor");
    return lead?.id === scope.memberId ? { kind: "project" } : { kind: "member", memberId: scope.memberId };
  }

  private messagePage(projectId: string, opts: MessagePageOptions, archived: boolean): MessagePage {
    const project = this.requireProject(projectId);
    if (project.archived !== archived) throw new ApiError(404, "프로젝트를 찾을 수 없습니다", "project_not_found");
    const limit = opts.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !projectId || Buffer.byteLength(projectId) > 256) throw new ApiError(400, "대화 조회 조건이 잘못되었습니다", "INVALID_MESSAGE_PAGE_QUERY");
    const scope = this.messageScope(projectId, opts.scope);
    let before: { at: string; id: string } | null = null;
    if (opts.cursor !== undefined) {
      try {
        if (!opts.cursor || opts.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(opts.cursor)) throw new Error("encoding");
        const bytes = Buffer.from(opts.cursor, "base64url");
        if (bytes.toString("base64url") !== opts.cursor) throw new Error("encoding");
        const bounded = (max: number) => z.string().min(1).refine((value) => Buffer.byteLength(value) <= max);
        const cursor = z.strictObject({
          v: z.literal(1), projectId: bounded(256),
          scope: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("project") }), z.strictObject({ kind: z.literal("member"), memberId: bounded(256) })]),
          before: z.strictObject({ at: bounded(128), id: bounded(256) }),
        }).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (cursor.projectId !== projectId) throw new Error("project");
        if (JSON.stringify(cursor.scope) !== JSON.stringify(scope)) {
          if (opts.scope?.kind === "member" && (cursor.scope.kind === "project" || (scope.kind === "project" && cursor.scope.memberId === opts.scope.memberId))) {
            throw new ApiError(409, "대화 대상이 변경되었습니다", "MESSAGE_SCOPE_CHANGED");
          }
          throw new Error("scope");
        }
        before = cursor.before;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, "이전 기록의 위치 정보가 올바르지 않습니다", "INVALID_MESSAGE_CURSOR");
      }
    }
    const seek = before ? " AND (at, id) < ($at, $id)" : "";
    const params = { $project: projectId, $limit: limit + 1, ...(before ? { $at: before.at, $id: before.id } : {}) };
    const rows = scope.kind === "project"
      ? this.db.query<Row, typeof params>(`SELECT * FROM messages WHERE project_id = $project${seek} ORDER BY at COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT $limit`).all(params)
      : this.db.query<Row, typeof params & { $member: string }>(`WITH authored AS (
          SELECT id, at FROM messages WHERE project_id = $project AND member_id = $member${seek}
          ORDER BY at COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT $limit
        ), targeted AS (
          SELECT id, at FROM messages WHERE project_id = $project AND target_member_id = $member${seek}
          ORDER BY at COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT $limit
        ), candidates AS (SELECT id, at FROM authored UNION SELECT id, at FROM targeted), page_keys AS (
          SELECT id, at FROM candidates ORDER BY at COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT $limit
        ) SELECT m.* FROM page_keys k JOIN messages m ON m.id = k.id ORDER BY k.at COLLATE BINARY DESC, k.id COLLATE BINARY DESC`).all({ ...params, $member: scope.memberId });
    const hasOlder = rows.length > limit;
    const items = this.messagesFrom(projectId, rows.slice(0, limit).reverse());
    const first = items[0];
    if (hasOlder && first && (Buffer.byteLength(first.at) > 128 || Buffer.byteLength(first.id) > 256 || !first.at || !first.id)) throw new ApiError(500, "저장된 메시지의 위치 정보가 올바르지 않습니다", "message_cursor_corrupt");
    return { projectId, scope, items, hasOlder, nextCursor: hasOlder && first ? Buffer.from(JSON.stringify({ v: 1, projectId, scope, before: { at: first.at, id: first.id } })).toString("base64url") : null };
  }

  listMessagePage(projectId: string, opts: MessagePageOptions = {}): MessagePage {
    return this.messagePage(projectId, opts, false);
  }

  listArchiveMessagePage(projectId: string, opts: MessagePageOptions = {}): MessagePage {
    return this.messagePage(projectId, opts, true);
  }

  archiveState(projectId: string, opts: { lite?: boolean } = {}): ArchiveProjectState {
    return this.transaction(() => {
      const state = this.projectState(projectId, { lite: opts.lite });
      if (!state.project.archived) throw new ApiError(404, "프로젝트를 찾을 수 없습니다", "project_not_found");
      return { ...state, project: { ...state.project, archived: true } };
    });
  }

  listArchivedProjects(): Project[] {
    return this.rows("SELECT * FROM projects WHERE archived = 1 ORDER BY created_at, rowid").map((r) => this.projectFrom(r));
  }

  // ---- B 묶음(설치 수명): 보관한 프로젝트 지우기·내보내기 ----

  /**
   * 보관한 프로젝트를 지운다. 보관되지 않았으면 409 project_not_archived. 보관은 모든 팀장의 안전한 종료를 확인한 뒤에만 되므로
   * 지울 때 띄워 둔 세션은 없다. 대화·결재·할 일·업무·자료와 그 팀장들의 실행 기록·전달·푸시 사건을 한 트랜잭션에서 지운다.
   * 다른 프로젝트가 가리키지 않는 첨부의 행도 지우고 그 파일 경로를 돌려준다(디스크의 파일은 커밋 뒤 호출하는 쪽이 지운다).
   */
  deleteArchivedProject(id: string): { project: Project; memberIds: string[]; attachments: { id: string; path: string }[] } {
    return this.transaction(() => {
      const project = this.requireProject(id);
      if (!project.archived || project.isHq) throw new ApiError(409, "보관한 프로젝트만 지울 수 있습니다", "project_not_archived");
      const memberIds = this.rows("SELECT id FROM members WHERE project_id = ?", id).map(r => r.id as string);
      const candidates = new Set<string>();
      const collect = (raw: unknown) => {
        let refs: unknown;
        try { refs = JSON.parse(typeof raw === "string" ? raw : "[]"); } catch { return; }
        if (!Array.isArray(refs)) return;
        for (const ref of refs) {
          if (typeof ref === "string") candidates.add(ref);
          else if (ref && typeof ref === "object" && typeof (ref as { id?: unknown }).id === "string") candidates.add((ref as { id: string }).id);
        }
      };
      for (const r of this.rows("SELECT attachments AS v FROM messages WHERE project_id = ?", id)) collect(r.v);
      for (const r of this.rows("SELECT attachments AS v FROM files WHERE project_id = ?", id)) collect(r.v);
      for (const r of this.rows("SELECT images AS v FROM decisions WHERE project_id = ?", id)) collect(r.v);
      // 0.2.7 묶음 4: 결재 답 첨부와 다시 열린 카드의 직전 답 첨부.
      for (const r of this.rows("SELECT answer_attachments AS a, last_answer_attachments AS b FROM decisions WHERE project_id = ?", id)) { collect(r.a); collect(r.b); }
      for (const r of this.rows("SELECT completion_file_ids AS v FROM todos WHERE project_id = ?", id)) collect(r.v);
      // 다른 프로젝트의 기록이 같은 첨부를 가리키면 남긴다. 첨부 행이 있는 후보만, 다른 프로젝트의 기록을 한 번만 읽어 가린다.
      // 11-22: 예전에는 첨부마다 다른 프로젝트 전체를 instr 로 훑어(후보 × 기록) 큰 프로젝트 하나 지우는 동안 서버가 6초 멈췄다.
      const rows = [...candidates].map(attachmentId => this.row("SELECT id, path FROM attachments WHERE id = ?", attachmentId)).filter((r): r is Row => !!r);
      const elsewhere = this.attachmentsMentionedElsewhere(id, rows.map(r => r.id as string));
      const attachments = rows.filter(r => !elsewhere.has(r.id as string)).map(r => ({ id: r.id as string, path: r.path as string }));
      // 프로젝트 행에 외래 키로 묶이지 않은 기록부터 지운다. 나머지는 ON DELETE CASCADE 가 지운다.
      this.run(`DELETE FROM decision_close_audit WHERE decision_id IN (SELECT id FROM decisions WHERE project_id = ?1)
        OR answered_decision_id IN (SELECT id FROM decisions WHERE project_id = ?1)`, id);
      this.run("DELETE FROM operation_receipts WHERE project_id = ?1 OR member_id IN (SELECT id FROM members WHERE project_id = ?1)", id);
      this.run("DELETE FROM agent_operation_receipts WHERE project_id = ?1 OR member_id IN (SELECT id FROM members WHERE project_id = ?1)", id);
      this.run("DELETE FROM push_report_groups WHERE project_id = ?1 OR member_id IN (SELECT id FROM members WHERE project_id = ?1)", id);
      this.run("DELETE FROM push_events WHERE project_id = ?1 OR member_id IN (SELECT id FROM members WHERE project_id = ?1)", id);
      this.run("DELETE FROM lifecycle_journal WHERE project_id = ?1 OR member_id IN (SELECT id FROM members WHERE project_id = ?1)", id);
      this.run("DELETE FROM execution_journal WHERE project_id = ?1 OR member_id IN (SELECT id FROM members WHERE project_id = ?1)", id);
      if (this.row("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'project_settings_v4'")) this.run("DELETE FROM project_settings_v4 WHERE project_id = ?", id);
      this.run("DELETE FROM projects WHERE id = ?", id);
      for (const attachment of attachments) this.run("DELETE FROM attachments WHERE id = ?", attachment.id);
      const trust = this.folderTrust();
      if (id in trust) {
        delete trust[id];
        this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", FOLDER_TRUST_KEY, JSON.stringify(trust));
      }
      for (const memberId of memberIds) this.setRestartWake(memberId, null);
      this.lastConnections.delete(id);
      this.emitProjects();
      return { project, memberIds, attachments };
    }, "immediate");
  }

  /**
   * `ids` 중 다른 프로젝트의 대화·자료·결재(그림·답·직전 답)·할 일·전달 글 어딘가에 글자 그대로 들어 있는 것.
   * 예전 질의(첨부마다 `instr(열, id) > 0`)와 같은 답을, 그 기록을 한 번만 읽어 낸다: 어떤 id 든 그 첫 두 글자(앵커)가 나오는
   * 자리에서만 시작할 수 있으므로, 앵커가 나오는 자리마다 그 길이의 글자를 잘라 후보 집합에서 찾는다. 다 찾으면 바로 멈춘다.
   */
  private attachmentsMentionedElsewhere(projectId: string, ids: string[]): Set<string> {
    const found = new Set<string>();
    const remaining = new Set(ids);
    // 빈 id 는 앵커가 없다(instr 은 NULL 이 아닌 모든 값에서 1, COALESCE 한 열은 NULL 에서도 1): 예전 질의 그대로 묻는다.
    if (remaining.delete("") && this.row(`SELECT 1 FROM messages WHERE project_id != ?1 AND instr(attachments, ?2) > 0
        UNION ALL SELECT 1 FROM files WHERE project_id != ?1 AND instr(attachments, ?2) > 0
        UNION ALL SELECT 1 FROM decisions WHERE project_id != ?1 AND (instr(images, ?2) > 0 OR instr(COALESCE(answer_attachments, ''), ?2) > 0 OR instr(COALESCE(last_answer_attachments, ''), ?2) > 0)
        UNION ALL SELECT 1 FROM todos WHERE project_id != ?1 AND instr(completion_file_ids, ?2) > 0
        UNION ALL SELECT 1 FROM deliveries WHERE project_id != ?1 AND instr(text, ?2) > 0 LIMIT 1`, projectId, "")) found.add("");
    if (!remaining.size) return found;
    const anchors = new Map<string, Set<number>>();
    for (const id of remaining) {
      const anchor = id.slice(0, 2);
      let lengths = anchors.get(anchor);
      if (!lengths) anchors.set(anchor, lengths = new Set());
      lengths.add(id.length);
    }
    const decoder = new TextDecoder();
    const sql = `SELECT attachments AS v FROM messages WHERE project_id != ?1
      UNION ALL SELECT attachments FROM files WHERE project_id != ?1
      UNION ALL SELECT images FROM decisions WHERE project_id != ?1
      UNION ALL SELECT answer_attachments FROM decisions WHERE project_id != ?1
      UNION ALL SELECT last_answer_attachments FROM decisions WHERE project_id != ?1
      UNION ALL SELECT completion_file_ids FROM todos WHERE project_id != ?1
      UNION ALL SELECT text FROM deliveries WHERE project_id != ?1`;
    for (const row of this.db.query<{ v: unknown }, [string]>(sql).iterate(projectId)) {
      if (row.v === null || row.v === undefined) continue;
      const text = typeof row.v === "string" ? row.v : row.v instanceof Uint8Array ? decoder.decode(row.v) : String(row.v);
      for (const [anchor, lengths] of anchors) {
        for (let at = text.indexOf(anchor); at !== -1; at = text.indexOf(anchor, at + 1)) {
          for (const length of lengths) {
            const id = text.slice(at, at + length);
            if (remaining.delete(id)) found.add(id);
          }
        }
      }
      if (!remaining.size) break;
    }
    return found;
  }

  /** 프로젝트 내보내기용 읽기. 토큰·전달 내부 기록은 싣지 않는다. 대화는 오래된 것부터 묶음으로 읽는다(큰 프로젝트도 메모리에 다 올리지 않는다). */
  projectExport(id: string): { project: Project; members: Member[]; decisions: Decision[]; todos: Todo[]; work: WorkItem[];
    files: (FileDoc & { html: string | null })[]; messageCount: number; messages(batch?: number): Generator<Message[]> } {
    const project = this.requireProject(id);
    const read = (sql: string, ...params: SQLQueryBindings[]) => this.rows(sql, ...params);
    return {
      project,
      members: this.listMembers(id),
      decisions: this.rows("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at, rowid", id).map(toDecision),
      todos: this.listTodos(id),
      work: this.listWork(id),
      files: this.rows("SELECT * FROM files WHERE project_id = ? ORDER BY sort_order, rowid", id).map(r => ({ ...toFile(r), html: (r.html as string | null) ?? null })),
      messageCount: (this.row("SELECT COUNT(*) AS n FROM messages WHERE project_id = ?", id)?.n as number) ?? 0,
      *messages(batch = 500) {
        let after: { at: string; id: string } | null = null;
        for (;;) {
          const rows: Row[] = after
            ? read("SELECT * FROM messages WHERE project_id = ? AND (at, id) > (?, ?) ORDER BY at COLLATE BINARY, id COLLATE BINARY LIMIT ?", id, after.at, after.id, batch)
            : read("SELECT * FROM messages WHERE project_id = ? ORDER BY at COLLATE BINARY, id COLLATE BINARY LIMIT ?", id, batch);
          if (!rows.length) return;
          yield rows.map(toMessage);
          const last = rows.at(-1)!;
          after = { at: last.at as string, id: last.id as string };
          if (rows.length < batch) return;
        }
      },
    };
  }

  listMessagesAround(projectId: string, messageId: string, limit = 41): Message[] {
    this.requireProject(projectId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "대화 조회 조건이 잘못되었습니다", "INVALID_MESSAGE_PAGE_QUERY");
    const anchor = this.requireMessage(messageId);
    if (anchor.projectId !== projectId) throw new ApiError(404, "메시지를 찾을 수 없습니다", "message_not_found");
    const older = this.rows("SELECT * FROM messages WHERE project_id = ? AND (at, id) < (?, ?) ORDER BY at COLLATE BINARY DESC, id COLLATE BINARY DESC LIMIT ?", projectId, anchor.at, anchor.id, Math.floor((limit - 1) / 2));
    const newer = this.rows("SELECT * FROM messages WHERE project_id = ? AND (at, id) > (?, ?) ORDER BY at COLLATE BINARY, id COLLATE BINARY LIMIT ?", projectId, anchor.at, anchor.id, limit - 1 - older.length);
    const around = this.messagesFrom(projectId, [...older.reverse(), ...newer]);
    return [...around.slice(0, older.length), anchor, ...around.slice(older.length)];
  }

  // before 페이징이 같은 at 의 글을 건너뛰지 않도록 at 을 프로세스 안에서 단조 증가시킨다.
  private nextMessageAt(): string {
    const ms = Math.max(Date.now(), this.lastMessageMs + 1);
    this.lastMessageMs = ms;
    return new Date(ms).toISOString();
  }

  /** 멱등: 같은 id 가 이미 있으면 새로 쓰지 않고 그 글을 돌려준다. */
  createMessage(input: NewMessage): Message {
    return this.transaction(() => {
      if (input.id) {
        const row = this.row("SELECT * FROM messages WHERE id = ?", input.id);
        const existing = row ? this.messageFrom(row, false) : null;
        if (existing) {
          if (existing.projectId !== input.projectId) throw new ApiError(409, "다른 프로젝트에서 사용된 메시지 ID입니다", "message_id_conflict");
          return existing;
        }
      }
      this.requireProject(input.projectId);
      const id = input.id ?? newId("msg_");
      // Y: 서버가 만든 글은 코드로 보고 언어의 문장을 그린다(보고 언어 한국어면 예전 문장과 글자까지 같다).
      const lang = input.text ? this.reportLang() : null;
      if (input.text && lang) {
        const rendered = renderDecisionText(input.text, lang, input.title ?? "");
        input = { ...input, title: rendered.title, body: rendered.detail };
      }
      this.run(
        `INSERT INTO messages (id, project_id, at, mine, member_id, who, kind, title, body, target_member_id, target_name, decision_id, file_id, attachments, delivery, delivery_note, delivery_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        deliveryNoteCode(input.deliveryNote),
      );
      if (input.contextFileId) this.run("UPDATE messages SET context_file_id = ? WHERE id = ?", input.contextFileId, id);
      if (input.text && lang) this.run("UPDATE messages SET text_ref = ? WHERE id = ?", storedText(input.text, lang), id);
      const message = this.messageFrom(this.row("SELECT * FROM messages WHERE id = ?", id)!, false);
      // 보관 중 늦은 manual 보고도 저장한다. 푸시는 활성 프로젝트의 실제 작성자만 대상이다.
      if (this.recorder && !this.requireProject(message.projectId).archived && (!message.memberId || this.getMember(message.memberId)?.projectId === message.projectId)) this.recorder.message(message);
      this.bumpBoard(message.projectId);
      // 원본 생성 반환값은 저장된 Message다. 방송은 outbox까지 commit된 현재 전달 정보를 싣는다.
      this.afterCommit(() => {
        // Z: 이 쓰기로 바뀐 대표 글의 답 상태(팀장의 답 → 답함, 결과 보고 누락과 같은 쓰기의 턴 끝 → 답 없음)를 이 글보다 먼저 낸다.
        // 마이크로태스크까지 미루면 같은 처리의 다른 사건 뒤에 나가, 앱이 새 글과 '답 쓰는 중'을 함께 그리는 틈이 생긴다.
        // 같은 값은 다시 내지 않으므로(replySeen) 뒤의 마이크로태스크는 남은 변화만 낸다.
        if (!input.mine) this.flushReplies();
        const current = this.getMessage(id);
        if (current) this.bus.emit({ type: "message", message: current });
      });
      // Z: 팀장이 대화에 쓴 글은 그 팀장이 받은 대표 글의 답일 수 있다.
      if (!input.mine && input.memberId) this.noteReply(input.memberId);
      return message;
    });
  }

  setMessageDelivery(id: string, delivery: Message["delivery"] | "dismissed", note: string | null = null): Message {
    return this.transaction(() => {
      const current = this.requireMessage(id);
      if ((current.deliveryDisposition ?? current.delivery) === delivery && current.deliveryNote === note) return current;
      // 정해진 보류 문장이면 그 코드를 함께 쓴다(앱은 코드로 가른다). 문장은 출시된 앱의 표시와 이전 판 서버를 위해 그대로 둔다.
      this.run("UPDATE messages SET delivery = ?, delivery_note = ?, delivery_code = ?, delivery_revision = delivery_revision + 1 WHERE id = ?", delivery, note, deliveryNoteCode(note), id);
      const message = this.requireMessage(id);
      this.bumpBoard(message.projectId);
      this.emit({ type: "message", message });
      return message;
    });
  }

  // ---- 자료 ----
  private fileRevisionState?: { columns: boolean; index: boolean; journal: boolean };
  /**
   * 0.2.7 묶음 4: 판 갈이 열(db.ts ensureRevisionColumns)은 openDb 가 늘 더한다. 이주만 돌린 시험 DB 처럼 그 열이 없으면 판 연결 없이 읽는다.
   * 0.2.10: 판 열은 html 뒤에 붙어 있어 표에서 읽으면 큰 html 의 넘침 페이지를 끝까지 따라간다. 덮는 색인 files_revisions 가 있으면 판 연결은 그 색인에서만 읽는다
   * (db.ts ensureFileVersionSchema. 만들지 못했으면 예전처럼 표에서 읽는다: 느릴 뿐 결과는 같다).
   */
  private get fileRevisions(): { columns: boolean; index: boolean; journal: boolean } {
    return this.fileRevisionState ??= {
      columns: this.rows("PRAGMA table_info(files)").some((c) => c.name === "replaced_by"),
      // 덮는 색인일 때만 INDEXED BY 로 고른다(같은 이름의 부분 색인이면 한 건 조회가 'no query solution' 으로 실패한다).
      index: this.rows("PRAGMA index_list(files)").some((i) => i.name === "files_revisions" && i.partial === 0),
      journal: !!this.row("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'file_chain_journal'"),
    };
  }
  private get revisionSource(): string {
    return this.fileRevisions.index ? "files INDEXED BY files_revisions" : "files";
  }

  /** 한 자료의 판 연결. 본문·html 을 읽지 않는다. */
  private fileLinkOf(projectId: string, id: string): Row | undefined {
    if (!this.fileRevisions.columns) return undefined;
    return this.row(`SELECT replaces, replaced_by FROM ${this.revisionSource} WHERE project_id = ? AND id = ?`, projectId, id) ?? undefined;
  }

  /** 프로젝트의 판 연결이 있는 자료(id → replaces·replaced_by). 본문·html 을 읽지 않는다. */
  private fileLinksOf(projectId: string): Map<string, Row> {
    if (!this.fileRevisions.columns) return new Map();
    const rows = this.rows(`SELECT id, replaces, replaced_by FROM ${this.revisionSource} WHERE project_id = ? AND (replaces IS NOT NULL OR replaced_by IS NOT NULL)`, projectId);
    return new Map(rows.map((r) => [r.id as string, r]));
  }

  getFile(id: string): FileDoc | null {
    const r = this.row(`SELECT ${FILE_COLUMNS} FROM files WHERE id = ?`, id);
    return r ? toFile(withFileLink(r, this.fileLinkOf(r.project_id as string, id))) : null;
  }

  /** 소속만 확인할 때 쓴다. 본문·첨부를 읽지 않는다. */
  private fileProjectId(id: string): string | null {
    return (this.row("SELECT project_id FROM files WHERE id = ?", id)?.project_id as string | undefined) ?? null;
  }

  /** 아티팩트 원본. 예전 자료는 첨부에 들어 있어 호출하는 쪽이 첨부에서 읽는다. */
  getFileHtml(id: string): string | null {
    return (this.row("SELECT html FROM files WHERE id = ?", id)?.html as string | null | undefined) ?? null;
  }

  /**
   * 프로젝트의 자료(최신 것이 먼저). 판 갈이 열(replaces·replaced_by)은 html 뒤에 붙은 열이라 이 조회에서 함께 읽지 않고,
   * 덮는 색인(db.ts FILE_VERSION_SCHEMA files_revisions)만 읽는 따로 조회(fileLinksOf)로 붙인다. 결과는 예전과 같다.
   * lite 면 본문도 읽지 않는다(본문 칸은 빈 글자).
   */
  listFiles(projectId: string, opts: { lite?: boolean } = {}): FileDoc[] {
    const links = this.fileLinksOf(projectId);
    return this.rows(`SELECT ${opts.lite ? FILE_LITE_COLUMNS : FILE_COLUMNS} FROM files WHERE project_id = ? ORDER BY sort_order DESC, rowid DESC`, projectId).map((r) => toFile(withFileLink(r, links.get(r.id as string))));
  }

  /**
   * 0.2.7 묶음 4: 화면의 자료 목록(프로젝트 상태). 모든 판을 그대로 싣고(옛 판은 replacedBy 가 있다), 최신 판에 판 수(versions, 2 이상)를 더한다.
   * 옛 판을 빼지 않는다: 출시 앱은 보고·결재의 자료를 이 목록에서 찾아 연다(빼면 옛 판을 가리키는 보고를 열 수 없다).
   * 새 앱은 replacedBy 가 있는 판을 목록에서 감추고 '이전 판'으로 보인다.
   * 0.2.10: latestOnly(창 묶음)면 새 판이 목록에 있는 옛 판을 뺀다(앱의 FileVersions.listed 와 같은 규칙). 뺀 수를 omitted 로 센다.
   */
  listFilesWithVersions(projectId: string, opts: { lite?: boolean } = {}): FileDoc[] {
    return this.fileList(projectId, { ...opts, latestOnly: false }).files;
  }

  private fileList(projectId: string, opts: { lite?: boolean; latestOnly: boolean }): { files: FileDoc[]; omitted: number } {
    const files = this.listFiles(projectId, opts);
    const byId = new Map(files.map((file) => [file.id, file]));
    const result: FileDoc[] = [];
    let omitted = 0;
    for (const file of files) {
      if (file.replacedBy && byId.has(file.replacedBy)) {
        if (opts.latestOnly) omitted++; else result.push(file);
        continue;
      }
      let versions = 1;
      const seen = new Set([file.id]);
      for (let previous = file.replaces; previous && byId.has(previous) && !seen.has(previous); previous = byId.get(previous)!.replaces) {
        seen.add(previous);
        versions++;
      }
      result.push(versions > 1 ? { ...file, versions } : file);
    }
    return { files: result, omitted };
  }

  /** 0.2.7 묶음 4: 이 자료의 모든 판(최신 판이 먼저). 판 갈이가 없으면 그 자료 하나. */
  listFileVersions(id: string): FileDoc[] {
    const start = this.getFile(id);
    if (!start) throw new ApiError(404, "자료를 찾을 수 없습니다", "file_not_found");
    let newest = start;
    const seen = new Set([start.id]);
    for (let next = start.replacedBy; next && !seen.has(next);) {
      const file = this.getFile(next);
      if (!file || file.projectId !== start.projectId) break;
      seen.add(file.id);
      newest = file;
      next = file.replacedBy;
    }
    const chain = [newest];
    const walked = new Set([newest.id]);
    for (let previous = newest.replaces; previous && !walked.has(previous);) {
      const file = this.getFile(previous);
      if (!file || file.projectId !== start.projectId) break;
      walked.add(file.id);
      chain.push(file);
      previous = file.replaces;
    }
    return chain;
  }

  searchFiles(projectId: string, query: string, limit = 50, archived = false): FileSearchResult[] {
    if (this.requireProject(projectId).archived !== archived) throw new ApiError(404, "프로젝트를 찾을 수 없습니다", "project_not_found");
    const term = query.trim().normalize("NFC").toLowerCase();
    if (term.length > 512 || term.includes("\0")) throw new ApiError(400, "검색어는 512자 이하여야 합니다", "INVALID_FILE_SEARCH_QUERY");
    if (!Number.isInteger(limit)) throw new ApiError(400, "limit 값이 잘못되었습니다", "INVALID_FILE_SEARCH_QUERY");
    const count = Math.min(Math.max(limit, 0), 200);
    if (!term || !count) return [];
    if (!this.row("SELECT 1 FROM sqlite_schema WHERE name='file_search_documents'")) throw new ApiError(501, "자료 검색 색인 마이그레이션이 필요합니다", "file_search_index_missing");
    return this.transaction(() => {
      refreshFileSearchIndex(this.db, { projectId });
      const trigram = Array.from(term).length >= 3;
      const rows = this.db.query<{ file_id: string; title: string; path: string; summary: string; body: string }, [Record<string, string | number>]>(`
        SELECT d.file_id,d.title,d.path,d.summary,d.body FROM file_search_documents d
        ${trigram ? "JOIN file_search_fts ON file_search_fts.rowid=d.rowid" : ""}
        WHERE d.project_id=$project AND d.archived=$archived AND ${trigram ? "file_search_fts MATCH $fts" : `(
          instr(d.title_fold,$q)>0 OR instr(d.path_fold,$q)>0 OR
          instr(d.summary_fold,$q)>0 OR instr(d.body_fold,$q)>0)`}
        ORDER BY CASE WHEN instr(d.title_fold,$q)>0 THEN 0
          WHEN instr(d.path_fold,$q)>0 THEN 1
          WHEN instr(d.summary_fold,$q)>0 THEN 2 ELSE 3 END,
          ${trigram ? "bm25(file_search_fts,8,4,2,1)," : ""} d.rowid DESC LIMIT $limit`).all({
          $project: projectId, $archived: archived ? 1 : 0, $q: term, $limit: count,
          ...(trigram ? { $fts: `"${term.replaceAll('"', '""')}"` } : {}),
        });
      return rows.map((row, index) => {
        const metadata = [row.title, row.path, row.summary].find(text => text.toLowerCase().includes(term));
        const text = metadata ?? row.body;
        const characters = Array.from(text);
        const offset = Array.from(text.slice(0, Math.max(0, text.toLowerCase().indexOf(term)))).length;
        const start = Math.max(0, offset - 48), end = Math.min(characters.length, offset + Array.from(term).length + 80);
        return { id: row.file_id, match: metadata === undefined ? "body" : "title", rank: index + 1,
          excerpt: Array.from(((start > 0 ? "…" : "") + characters.slice(start, end).join("") + (end < characters.length ? "…" : "")).replace(/\s+/g, " ")).slice(0, 200).join("") };
      });
    });
  }

  createFile(input: NewFile): FileDoc {
    return this.createFileWithChain(input).file;
  }

  /** 자료를 올리고, replaces 나 자동 잇기(autoChain)로 앞 판에 잇는다. 한 거래다. */
  createFileWithChain(input: NewFile): FileChainResult {
    return this.transaction(() => {
      this.requireProject(input.projectId);
      // 0.2.7 묶음 4: 판 갈이. 같은 프로젝트의, 아직 최신인 판만 대신한다.
      let replaced = input.replaces ? this.getFile(input.replaces) : null;
      if (input.replaces && (!replaced || replaced.projectId !== input.projectId)) throw new ApiError(404, `자료를 찾을 수 없습니다: ${input.replaces}`, "file_not_found");
      if (replaced?.replacedBy) throw new ApiError(409, `이미 새 판(#${replaced.replacedBy})이 있는 자료입니다. 최신 판의 id 를 replaces 에 넣으세요`, "file_already_replaced");
      const createdAt = nowIso();
      let chained: { previous: FileDoc; basis: ChainBasis } | undefined;
      let ambiguous: FileDoc[] | undefined;
      if (!input.replaces && input.autoChain && input.memberId && this.fileRevisions.columns) {
        const verdict = pickPrevious({ id: "", projectId: input.projectId, memberId: input.memberId, kind: input.kind ?? null, title: input.title, createdAt, replaces: null, replacedBy: null },
          this.fileChainHeads(input.projectId, input.memberId, createdAt));
        if (verdict.chain) {
          replaced = this.getFile(verdict.to.id);
          if (replaced) chained = { previous: replaced, basis: verdict.basis };
        } else if (verdict.why === "ambiguous") ambiguous = (verdict.candidates ?? []).map((c) => this.getFile(c.id)).filter((f): f is FileDoc => !!f);
      }
      // 팀장이 끊은 쌍·'새 자료'(file_chain_journal 의 unchain·new_item 행)는 정리(planTidy)만 본다: 자동 잇기의 next 는 지금 막 만드는 자료라 그런 기록이 있을 수 없다.
      const id = newId("f_");
      const order = this.row("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM files WHERE project_id = ?", input.projectId)!.n as number;
      // 0.2.10: 새 판의 replaces 는 처음 넣을 때 함께 쓴다(큰 html 행을 한 번 더 고쳐 쓰지 않는다).
      const linkColumn = replaced && this.fileRevisions.columns;
      this.run(
        `INSERT INTO files (id, project_id, title, who, member_id, summary, body, path, attachments, created_at, sort_order, kind, html${linkColumn ? ", replaces" : ""}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${linkColumn ? ", ?" : ""})`,
        id,
        input.projectId,
        input.title,
        input.who ?? "",
        input.memberId ?? null,
        input.summary ?? "",
        input.body ?? "",
        input.path ?? null,
        JSON.stringify(input.attachments ?? []),
        createdAt,
        order,
        input.kind ?? null,
        input.html ?? null,
        ...(linkColumn ? [replaced!.id] : []),
      );
      if (replaced) {
        if (!linkColumn) this.run("UPDATE files SET replaces = ? WHERE id = ?", replaced.id, id);
        this.run("UPDATE files SET replaced_by = ? WHERE id = ?", id, replaced.id);
        if (chained) {
          // 0.2.10: 서버가 고른 판은 기록에 남긴다(팀장이 file 의 unchain 으로 끊을 수 있다). 열린 결재의 근거 자료는 옮기지 않는다.
          this.journalFileChain(id, "auto", input.projectId, [{ next: id, previous: replaced.id, basis: chained.basis }], createdAt);
        } else {
          // 열린 결재가 옛 판을 근거 자료로 가리키면 새 판으로 옮긴다(D5-7: 카드가 옛 글을 계속 가리켰다). 결재의 판(updated_at)은 올리지 않는다:
          // 대표가 고르던 답을 '바뀐 결재'로 돌려보내지 않고, 아직 나가지 않은 결재 알림이 낡은 것으로 지워지지 않게 한다. 화면은 결재 사건으로 다시 읽는다.
          for (const row of this.rows("SELECT id FROM decisions WHERE project_id = ? AND status = 'open' AND file_id = ?", input.projectId, replaced.id)) {
            this.run("UPDATE decisions SET file_id = ? WHERE id = ?", id, row.id);
            this.emit({ type: "decision", decision: this.requireDecision(row.id as string) });
          }
        }
      }
      // 0.2.10: new_item:true 로 '새 자료'라고 밝힌 것을 남긴다(iamceo files tidy 가 이 자료를 앞 판에 다시 잇지 않는다).
      if (!input.replaces && input.autoChain === false) this.journalFileChain(id, "new_item", input.projectId, [{ next: id, previous: FILE_JOURNAL_ANY_PREVIOUS, basis: "new_item" }], createdAt);
      refreshFileSearchIndex(this.db, { fileId: id, limit: 1 });
      const file = this.getFile(id)!;
      this.emit({ type: "file", file });
      return { file, ...(chained ? { chained: { basis: chained.basis, previous: this.getFile(chained.previous.id)!, versions: this.fileVersionCount(input.projectId, id) } } : {}), ...(ambiguous?.length ? { ambiguous } : {}) };
    });
  }

  /** 이 판까지의 판 수(앞 판을 따라 센다). 본문·html 을 읽지 않는다. */
  private fileVersionCount(projectId: string, id: string): number {
    let count = 1;
    const seen = new Set([id]);
    for (let at = this.fileLinkOf(projectId, id)?.replaces as string | null | undefined; at && !seen.has(at); at = this.fileLinkOf(projectId, at)?.replaces as string | null | undefined) {
      seen.add(at);
      count++;
    }
    return count;
  }

  /** 0.2.10 자동 잇기의 후보: 같은 팀장이 14일 안에 올린 아직 최신인 판. 본문·html 을 읽지 않는다(판 연결은 덮는 색인에서 본다). */
  private fileChainHeads(projectId: string, memberId: string, at: string): ChainFile[] {
    const since = new Date(Date.parse(at) - VERSION_WINDOW_MS).toISOString();
    const latest = this.fileRevisions.index
      ? "NOT EXISTS (SELECT 1 FROM files r INDEXED BY files_revisions WHERE r.project_id = f.project_id AND r.id = f.id AND r.replaced_by IS NOT NULL)"
      : "f.replaced_by IS NULL";
    return this.rows(`SELECT f.id, f.project_id, f.member_id, f.kind, f.title, f.created_at, f.sort_order FROM files f WHERE f.project_id = ? AND f.member_id = ? AND f.created_at >= ? AND ${latest}`, projectId, memberId, since)
      .map((r) => ({ id: r.id as string, projectId: r.project_id as string, memberId: r.member_id as string, kind: (r.kind as string | null) ?? null, title: r.title as string, createdAt: r.created_at as string, replaces: null, replacedBy: null, order: r.sort_order as number }));
  }

  /**
   * 서버가 고른 판 잇기(auto·tidy)와 팀장이 바로잡은 것(unchain: 끊은 쌍, new_item: '새 자료'라고 밝힌 자료)을 적는다.
   * 기록 표가 없으면(만들지 못한 DB) 적지 않는다: 잇기는 그대로 하고, 정리 적용만 표를 요구한다.
   */
  private journalFileChain(batchId: string, source: FileJournalSource, projectId: string, links: { next: string; previous: string; basis: string }[], at: string): void {
    if (!this.fileRevisions.journal) return;
    for (const link of links) {
      this.run("INSERT INTO file_chain_journal (batch_id, source, project_id, file_id, replaces, basis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", batchId, source, projectId, link.next, link.previous, link.basis, at);
    }
  }

  /**
   * 0.2.10 file 도구 unchain: 이 판과 앞 판의 잇기를 끊는다(서버가 잘못 이었을 때). 두 자료는 그대로 남고 각자 최신 판이 된다.
   * 열린 결재의 근거 자료는 건드리지 않는다. 권한(직원은 자기가 올린 판만)은 도구가 본다.
   */
  unchainFile(id: string): { file: FileDoc; previous: FileDoc | null } {
    return this.transaction(() => {
      const file = this.getFile(id);
      if (!file) throw new ApiError(404, `자료를 찾을 수 없습니다: ${id}`, "file_not_found");
      if (!file.replaces) throw new ApiError(409, `앞 판에 이어진 자료가 아닙니다: ${id}`, "file_not_chained");
      const previousId = file.replaces;
      const previous = this.getFile(previousId);
      const at = nowIso();
      this.run("UPDATE files SET replaces = NULL WHERE id = ?", id);
      if (previous?.replacedBy === id) this.run("UPDATE files SET replaced_by = NULL WHERE id = ?", previousId);
      if (this.fileRevisions.journal) this.run("UPDATE file_chain_journal SET undone_at = ? WHERE file_id = ? AND replaces = ? AND source IN ('auto', 'tidy') AND undone_at IS NULL", at, id, previousId);
      // 끊은 쌍을 남긴다(서버가 이은 것이든 명시한 replaces 든). iamceo files tidy 가 이 쌍을 다시 잇지 않는다.
      this.journalFileChain(id, "unchain", file.projectId, [{ next: id, previous: previousId, basis: "unchain" }], at);
      const after = this.getFile(id)!;
      const before = previous ? this.getFile(previousId) : null;
      this.emit({ type: "file", file: after });
      if (before) this.emit({ type: "file", file: before });
      return { file: after, previous: before };
    });
  }

  /** 0.2.10 file 도구 find: 프로젝트의 최신 판(옛 판 빼고) 가운데 제목에 낱말이 모두 든 것, 새것부터. 본문·html 을 읽지 않는다. */
  findLatestFiles(projectId: string, query: string, limit = 20): { files: (ChainFile & { who: string; versions: number })[]; more: number } {
    const links = this.fileLinksOf(projectId);
    const words = baseTitle(query).split(" ").filter(Boolean);
    const rows = this.rows("SELECT id, project_id, member_id, who, kind, title, created_at FROM files WHERE project_id = ? ORDER BY created_at DESC, rowid DESC", projectId);
    const found = rows.filter((r) => !links.get(r.id as string)?.replaced_by && words.every((w) => baseTitle(r.title as string).includes(w)));
    const versions = (id: string) => {
      let n = 1;
      const seen = new Set([id]);
      for (let at = links.get(id)?.replaces as string | null | undefined; at && !seen.has(at); at = links.get(at)?.replaces as string | null | undefined) { seen.add(at); n++; }
      return n;
    };
    return {
      files: found.slice(0, limit).map((r) => ({ id: r.id as string, projectId: r.project_id as string, memberId: (r.member_id as string | null) ?? null, who: r.who as string, kind: (r.kind as string | null) ?? null, title: r.title as string, createdAt: r.created_at as string, replaces: (links.get(r.id as string)?.replaces as string | null | undefined) ?? null, replacedBy: null, versions: versions(r.id as string) })),
      more: Math.max(0, found.length - limit),
    };
  }

  /** 0.2.10 iamceo files tidy: 계획에 쓰는 자료 모양(보관하지 않은 프로젝트, 본문·html 은 읽지 않는다). */
  fileChainFiles(projectId?: string): ChainFile[] {
    const projects = projectId ? [this.requireProject(projectId)] : this.listProjects();
    if (projectId && projects[0]!.archived) throw new ApiError(404, "프로젝트를 찾을 수 없습니다", "project_not_found");
    return projects.flatMap((project) => {
      const links = this.fileLinksOf(project.id);
      return this.rows("SELECT id, project_id, member_id, kind, title, created_at, sort_order FROM files WHERE project_id = ?", project.id).map((r) => ({
        id: r.id as string, projectId: r.project_id as string, memberId: (r.member_id as string | null) ?? null, kind: (r.kind as string | null) ?? null,
        title: r.title as string, createdAt: r.created_at as string, order: r.sort_order as number,
        replaces: (links.get(r.id as string)?.replaces as string | null | undefined) ?? null, replacedBy: (links.get(r.id as string)?.replaced_by as string | null | undefined) ?? null,
      }));
    });
  }

  /** 0.2.10: 팀장이 바로잡은 것(file_chain_journal 의 unchain·new_item 행). 정리 계획이 다시 잇지 않는다. */
  private fileChainBlocks(projectId?: string): TidyBlocks {
    const unchained = new Set<string>(), newItems = new Set<string>();
    if (this.fileRevisions.journal) {
      const rows = this.rows(`SELECT source, file_id, replaces FROM file_chain_journal WHERE source IN ('unchain', 'new_item')${projectId ? " AND project_id = ?" : ""}`, ...(projectId ? [projectId] : []));
      for (const row of rows) {
        if (row.source === "new_item") newItems.add(row.file_id as string);
        else unchained.add(unchainedKey(row.file_id as string, row.replaces as string));
      }
    }
    return { unchained, newItems };
  }

  planFileTidy(projectId?: string): TidyPlan {
    return planTidy(this.fileChainFiles(projectId), this.fileChainBlocks(projectId));
  }

  /** previous 의 앞 판 사슬(replaces)에 next 가 있는가: 있으면 next.replaces = previous 가 판 사슬을 고리로 만든다. 본문·html 을 읽지 않는다. */
  private fileReplacesChainHas(projectId: string, previous: string, next: string): boolean {
    const seen = new Set<string>();
    for (let at: string | null | undefined = previous; at && !seen.has(at); at = this.fileLinkOf(projectId, at)?.replaces as string | null | undefined) {
      if (at === next) return true;
      seen.add(at);
    }
    return false;
  }

  /**
   * 0.2.10 iamceo files tidy --apply: 지금 다시 계산한 계획이 확인한 계획(planId)과 같을 때만 한 거래로 잇고 기록(되돌리기용)을 남긴다.
   * 소급해 잇는 판은 열린 결재의 근거 자료를 옮기지 않는다(대표가 이미 보고 있는 카드의 근거를 바꾸지 않는다).
   */
  applyFileTidy(planId: string, projectId?: string): { batchId: string | null; plan: TidyPlan } {
    if (!this.fileRevisions.columns || !this.fileRevisions.journal) throw new ApiError(503, "판 정리 기록 표가 없어 적용하지 않았습니다. 서버를 다시 시작한 뒤 다시 하세요", "file_tidy_unavailable");
    const result = this.transaction(() => {
      const plan = this.planFileTidy(projectId);
      if (plan.planId !== planId) throw new ApiError(409, "확인한 뒤로 자료가 바뀌었습니다. 다시 확인(iamceo files tidy)한 뒤 새 계획 번호로 적용하세요", "file_tidy_plan_changed");
      if (!plan.links.length) return { batchId: null, plan };
      const batchId = newId("tb_");
      const at = nowIso();
      for (const link of plan.links) {
        // 계획(planTidy)이 뒤 판 사슬을 빼지만, 고리는 두 판을 모두 목록에서 지우므로 쓰기 전에 한 번 더 본다(앞서 쓴 링크도 이 거래 안에서 보인다).
        if (this.fileReplacesChainHas(link.projectId, link.previous.id, link.next.id)) throw new ApiError(409, FILE_TIDY_CYCLE_TEXT, "file_tidy_cycle");
        const set = this.db.query("UPDATE files SET replaces = ? WHERE id = ? AND project_id = ? AND replaces IS NULL").run(link.previous.id, link.next.id, link.projectId).changes;
        const back = this.db.query("UPDATE files SET replaced_by = ? WHERE id = ? AND project_id = ? AND replaced_by IS NULL").run(link.next.id, link.previous.id, link.projectId).changes;
        if (set !== 1 || back !== 1) throw new ApiError(409, "확인한 뒤로 자료가 바뀌었습니다. 다시 확인한 뒤 적용하세요", "file_tidy_plan_changed");
        this.journalFileChain(batchId, "tidy", link.projectId, [{ next: link.next.id, previous: link.previous.id, basis: link.basis }], at);
      }
      for (const link of plan.links) this.emit({ type: "file", file: this.getFile(link.next.id)! });
      return { batchId, plan };
    }, "immediate");
    return result;
  }

  /** 0.2.10 iamceo files tidy --undo: 그 묶음이 이은 판 가운데 아직 그대로인 것만 푼다. */
  undoFileTidy(batchId: string): { undone: number; skipped: number } {
    if (!this.fileRevisions.journal) throw new ApiError(404, `판 정리 기록을 찾을 수 없습니다: ${batchId}`, "file_tidy_batch_not_found");
    return this.transaction(() => {
      const rows = this.rows("SELECT seq, project_id, file_id, replaces, undone_at FROM file_chain_journal WHERE batch_id = ? AND source = 'tidy' ORDER BY seq", batchId);
      if (!rows.length) throw new ApiError(404, `판 정리 기록을 찾을 수 없습니다: ${batchId}`, "file_tidy_batch_not_found");
      const at = nowIso();
      let undone = 0, skipped = 0;
      for (const row of rows) {
        if (row.undone_at) continue;
        const next = this.fileLinkOf(row.project_id as string, row.file_id as string);
        const previous = this.fileLinkOf(row.project_id as string, row.replaces as string);
        if (next?.replaces !== row.replaces || previous?.replaced_by !== row.file_id) { skipped++; continue; }
        this.run("UPDATE files SET replaces = NULL WHERE id = ?", row.file_id);
        this.run("UPDATE files SET replaced_by = NULL WHERE id = ?", row.replaces);
        this.run("UPDATE file_chain_journal SET undone_at = ? WHERE seq = ?", at, row.seq);
        undone++;
        this.emit({ type: "file", file: this.getFile(row.file_id as string)! });
      }
      return { undone, skipped };
    }, "immediate");
  }

  /** 0.2.10 iamceo files tidy(바꾸지 않음): 계획 요약과 최근 적용 묶음. 서버를 거치든(GET /api/file-tidy) 꺼진 홈에서 바로 열든 같은 모양이다. */
  fileTidyReport(projectId?: string, showTitles = false): TidyReport & { batches: FileTidyBatch[] } {
    const files = this.fileChainFiles(projectId);
    const names = new Map(this.listProjects({ includeArchived: true }).map((p) => [p.id, p.name]));
    return { ...tidyReport(planTidy(files, this.fileChainBlocks(projectId)), files, names, showTitles), batches: this.listFileTidyBatches() };
  }

  /** 0.2.10 iamceo files tidy --apply 의 응답 모양. */
  applyFileTidyReport(planId: string, projectId?: string): { batchId: string | null; links: number; families: number } {
    const { batchId, plan } = this.applyFileTidy(planId, projectId);
    return { batchId, links: plan.links.length, families: tidyFamilies(plan.links).length };
  }

  /** 0.2.10: 최근 판 정리 묶음(새것부터). */
  listFileTidyBatches(limit = 10): FileTidyBatch[] {
    if (!this.fileRevisions.journal) return [];
    return this.rows(`SELECT batch_id, MIN(created_at) AS created_at, COUNT(*) AS links, SUM(undone_at IS NOT NULL) AS undone FROM file_chain_journal
      WHERE source = 'tidy' GROUP BY batch_id ORDER BY MIN(seq) DESC LIMIT ?`, limit)
      .map((r) => ({ batchId: r.batch_id as string, createdAt: r.created_at as string, links: Number(r.links), undone: Number(r.undone) }));
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
    if (this.deliveryRead?.rows.has(id)) return this.deliveryReadMemo(`delivery:${id}`, () => toDelivery(this.deliveryRead!.rows.get(id)!));
    const r = this.row("SELECT * FROM deliveries WHERE id = ?", id);
    return r ? toDelivery(r) : null;
  }

  requireDelivery(id: string): Delivery {
    const d = this.getDelivery(id);
    if (!d) throw new ApiError(404, "전달 항목을 찾을 수 없습니다", "delivery_not_found");
    return d;
  }

  private emitMember(memberId: string): void {
    const member = this.getMember(memberId);
    if (member) this.emit({ type: "member", member });
    // Z: 전달 상태·펌프 판정·팀장 상태가 바뀌면 그 팀장이 받은 대표 글의 답 상태도 바뀔 수 있다.
    this.noteReply(memberId);
  }

  enqueue(input: NewDelivery): Delivery {
    return this.transaction(() => {
      const member = this.requireMember(input.memberId);
      if (member.projectId !== input.projectId) throw new ApiError(400, "다른 프로젝트의 팀원입니다", "member_other_project");
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
      this.run("UPDATE deliveries SET source_revision = ?, next_attempt_at = ? WHERE id = ?", input.sourceRevision ?? null, input.nextAttemptAt ?? null, id);
      this.run(`UPDATE deliveries SET next_turn_after_run = COALESCE((SELECT MAX(rowid) FROM execution_journal
        WHERE member_id = ? AND project_id = ?), 0) WHERE id = ?`, input.memberId, input.projectId, id);
      this.run("INSERT INTO delivery_recovery (delivery_id, updated_at) VALUES (?, ?)", id, nowIso());
      if (input.kind === "user_message" && input.refType === "message" && input.refId) this.watchReply(input.memberId, input.refId);
      this.emitMember(input.memberId);
      return this.requireDelivery(id);
    });
  }

  /** 아직 전달되지 않은 것(queued·held), 넣은 순서대로. */
  listPending(memberId: string): Delivery[] {
    return this.rows("SELECT * FROM deliveries WHERE member_id = ? AND status IN ('queued','held') ORDER BY rowid", memberId).map(toDelivery);
  }

  listSendablePending(memberId: string): Delivery[] {
    return this.rows(`SELECT d.* FROM deliveries d WHERE d.member_id = ? AND d.status IN ('queued','held')
      AND NOT EXISTS (SELECT 1 FROM delivery_recovery r WHERE r.delivery_id = d.id AND r.phase = 'needs_owner' AND r.reason = 'stale_instruction') ORDER BY d.rowid`, memberId).map(toDelivery);
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
    return this.transaction(() => {
      const rows = this.rows(`SELECT id, member_id FROM deliveries WHERE ref_type = ? AND ref_id = ? AND status IN ('queued','held')
        AND NOT EXISTS (SELECT 1 FROM delivery_recovery r WHERE r.delivery_id = deliveries.id AND r.phase NOT IN ('none','resolved','stopped')
          AND NOT (r.phase = 'waiting' AND r.reason = 'input_busy'))
        AND NOT EXISTS (SELECT 1 FROM delivery_dispatch_items i JOIN delivery_dispatches x ON x.id = i.dispatch_id WHERE i.delivery_id = deliveries.id AND x.transport_state != 'rejected')
        AND NOT EXISTS (SELECT 1 FROM manual_inbox_items i JOIN manual_inbox_batches b ON b.id = i.batch_id WHERE i.delivery_id = deliveries.id AND b.acknowledged_at IS NULL)`, refType, refId);
      for (const r of rows) {
        this.run("DELETE FROM deliveries WHERE id = ?", r.id);
        this.emitMember(r.member_id);
      }
      return rows.length;
    });
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
    return this.transaction(() => {
      const before = this.requireDelivery(id);
      const holdReason = status === "held" ? (update.holdReason ?? before.holdReason) : null;
      const lastError = update.lastError !== undefined ? update.lastError : before.lastError;
      // 보류 중인 직원은 펌프마다 같은 값을 다시 적었다. 바뀐 것이 없으면 쓰지도 알리지도 않는다.
      if (!update.attempt && before.status === status && before.holdReason === holdReason && before.lastError === lastError) return before;
      this.run(
        `UPDATE deliveries SET status = ?, hold_reason = ?, last_error = ?, attempts = attempts + ?,
           delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END
         WHERE id = ?`,
        status,
        holdReason,
        lastError,
        update.attempt ? 1 : 0,
        status,
        nowIso(),
        id,
      );
      this.emitMember(before.memberId);
      return this.requireDelivery(id);
    });
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

  /** 전달 봉투를 턴 키로 사용한다. 대표가 깨운 턴만 배정 확인 대상이다. */
  beginDelegationAck(runId: string, memberId: string, deliveries: Delivery[]): void {
    if (this.requireMember(memberId).kind === "worker") return;
    const sourceIds = deliveries.filter(d => d.wake && (d.kind === "user_message" || d.kind === "answer"))
      .map(d => d.refId ?? d.id).sort();
    this.run("INSERT OR IGNORE INTO delegation_ack_turns (run_id, member_id, source_ids) VALUES (?, ?, ?)", runId, memberId, JSON.stringify(sourceIds));
  }

  /** 지시 outbox와 같은 트랜잭션에서 호출한다. 도구 응답 유실에도 배정 사실이 남는다. */
  noteDelegation(memberId: string, delivery: Delivery, queued: boolean): void {
    const turn = this.row("SELECT * FROM delegation_ack_turns WHERE member_id = ? AND ended = 0 ORDER BY rowid DESC LIMIT 1", memberId);
    if (!turn || JSON.parse(turn.source_ids).length === 0) return;
    const assignments: { deliveryId: string; memberId: string; name: string; summary: string; queued: boolean }[] = JSON.parse(turn.assignments);
    const known = assignments.find(a => a.deliveryId === delivery.id);
    if (known) {
      // 0.2.7 묶음 1 검토: 급한 지시로 하던 턴을 멈추려다 멈춘 것을 확인하지 못했으면 '앞 일 끝나면 시작'으로 고쳐 적는다(같은 전달은 한 줄).
      if (known.queued !== queued) { known.queued = queued; this.run("UPDATE delegation_ack_turns SET assignments = ? WHERE run_id = ?", JSON.stringify(assignments), turn.run_id); }
      return;
    }
    const target = this.requireMember(delivery.memberId);
    const first = delivery.text.split("\n").find(line => line.startsWith("할 일: "))?.slice(5) ?? "";
    const summary = Array.from(cleanText(first).replace(/\s+/g, " ").trim()).slice(0, 60).join("");
    assignments.push({ deliveryId: delivery.id, memberId: target.id, name: target.name, summary, queued });
    this.run("UPDATE delegation_ack_turns SET assignments = ? WHERE run_id = ?", JSON.stringify(assignments), turn.run_id);
  }

  /** ask·post 조회·자동 마지막 글은 post가 아니다. 실제 게시와 원자적으로 기록한다. */
  noteDelegationPost(memberId: string, text = ""): void {
    for (const turn of this.rows("SELECT * FROM delegation_ack_turns WHERE member_id = ? AND ended = 0", memberId)) {
      const texts: string[] = JSON.parse(turn.post_texts);
      texts.push(text);
      this.run("UPDATE delegation_ack_turns SET posted = 1, post_texts = ? WHERE run_id = ?", JSON.stringify(texts), turn.run_id);
    }
  }

  finishDelegationAck(memberId: string, runId?: string): void {
    this.transaction(() => {
      const turns = runId
        ? this.rows("SELECT * FROM delegation_ack_turns WHERE member_id = ? AND run_id = ? AND ended = 0", memberId, runId)
        : this.rows("SELECT * FROM delegation_ack_turns WHERE member_id = ? AND ended = 0", memberId);
      for (const turn of turns) {
        this.run("UPDATE delegation_ack_turns SET ended = 1 WHERE run_id = ?", turn.run_id);
        const sources: string[] = JSON.parse(turn.source_ids);
        if (!sources.length) continue;
        const assignments: { deliveryId: string; memberId: string; name: string; summary: string; queued: boolean }[] = JSON.parse(turn.assignments);
        // 확정 기동 실패로 취소된 신규 직원의 outbox는 배정으로 알리지 않는다.
        const retained = assignments.filter(a => this.getDelivery(a.deliveryId));
        // 같은 직원에게 여러 번 보냈으면 마지막 지시를 한 줄로 보여 준다.
        for (const assignment of new Map(retained.map(a => [a.memberId, a])).values()) {
          const pendingSources = sources.filter(source => !this.row("SELECT 1 FROM delegation_ack_receipts WHERE member_id = ? AND source_id = ? AND target_id = ?", memberId, source, assignment.memberId));
          for (const source of pendingSources) this.run("INSERT OR IGNORE INTO delegation_ack_receipts VALUES (?, ?, ?)", memberId, source, assignment.memberId);
          const texts: string[] = JSON.parse(turn.post_texts);
          if (!pendingSources.length || texts.some(text => new RegExp(`(?<![\\p{L}\\p{N}_])${assignment.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s\\p{P}]|(?:에게|이|가|은|는|와|과|님|씨)(?=$|[\\s\\p{P}]))`, "u").test(text))) continue;
          const key = createHash("sha256").update(JSON.stringify([memberId, pendingSources, assignment.memberId])).digest("hex").slice(0, 32);
          this.createMessage({ id: `msg_delegation_ack_${key}`, projectId: this.requireMember(memberId).projectId,
            who: "시스템", kind: "시스템", text: textRef(assignment.queued ? "chat.assigned_queued" : "chat.assigned", { name: assignment.name, summary: assignment.summary }) });
        }
      }
    });
  }

  // ---- 활동 ----
  /** 0.2.7 묶음 1 검토: 그 사건 키로 남긴 활동 줄이 있는가(급한 지시로 한 번 멈춘 대표 글의 표식 등). 오래된 줄은 지워질 수 있다(직원당 MAX_ACTIVITY_PER_MEMBER). */
  hasActivityEvent(eventKey: string): boolean {
    return !!this.row("SELECT 1 FROM activity WHERE delivery_event_key = ?", eventKey);
  }

  /** 직원당 최근 MAX_ACTIVITY_PER_MEMBER 개만 남긴다. */
  appendActivity(memberId: string, kind: ActivityKind, line: string | ServerTextRef, eventKey?: string): Activity {
    return this.transaction(() => {
      // Y: 서버가 만든 줄은 코드로 보고 언어의 문장을 그린다. 코드는 문장 옆(text_ref)에 둔다.
      const ref = typeof line === "string" ? null : line;
      const lang = ref ? this.reportLang() : null;
      const text = ref && lang ? mustRender(ref, lang) : line as string;
      if (eventKey !== undefined) {
        const before = this.row("SELECT * FROM activity WHERE delivery_event_key = ?", eventKey);
        if (before) {
          if (before.member_id !== memberId) throw new ApiError(409, "다른 팀원의 활동 표식입니다", "activity_marker_other_member");
          return toActivity(before);
        }
      }
      const member = this.requireMember(memberId);
      const clipped = text.length > MAX_ACTIVITY_TEXT ? `${text.slice(0, MAX_ACTIVITY_TEXT)}…` : text;
      let inserted = this.row("INSERT INTO activity (member_id, at, kind, text, delivery_event_key) VALUES (?, ?, ?, ?, ?) RETURNING *", memberId, nowIso(), kind, clipped, eventKey ?? null)!;
      if (ref && lang) inserted = this.row("UPDATE activity SET text_ref = ? WHERE id = ? RETURNING *", storedText(ref, lang), inserted.id)!;
      if (kind === "turn_start" || kind === "turn_end" || kind === "tool" || kind === "tool_result") {
        // updated_at/직원 알림은 건드리지 않는다. 시계가 뒤로 가도 최신 작업 시각을 보존한다.
        this.run("UPDATE members SET last_active_at = ? WHERE id = ? AND (last_active_at IS NULL OR last_active_at < ?)", inserted.at, memberId, inserted.at);
      }
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
      this.emit({ type: "activity", projectId: member.projectId, activity });
      return activity;
    });
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

  // ---- 재시작으로 꺼진 팀장의 표식 ----
  /** 표식 전부. 읽을 수 없는 값은 없는 것으로 본다(그 팀장은 예전처럼 꺼진 채 남는다). */
  restartWakes(): Record<string, RestartWake> {
    const row = this.row("SELECT value FROM settings WHERE key = ?", RESTART_WAKE_KEY);
    if (!row) return {};
    try {
      const saved: unknown = JSON.parse(row.value);
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
      const wakes: Record<string, RestartWake> = {};
      for (const [memberId, value] of Object.entries(saved)) {
        const wake = parseRestartWake(value);
        if (wake) wakes[memberId] = wake;
      }
      return wakes;
    } catch { return {}; }
  }

  getRestartWake(memberId: string): RestartWake | null {
    return this.restartWakes()[memberId] ?? null;
  }

  /** 재시작으로 꺼져 서버가 스스로 다시 열 차례이거나 여는 중이다(표식이 기다림·여는 중). */
  private restartOwned(memberId: string): boolean {
    const state = this.getRestartWake(memberId)?.state;
    return state === "pending" || state === "opening";
  }

  /** 재시작 다시 열기 한 묶음에서 열지 못한 팀장들: 오류 알림을 한 번만 낸다(D2-4·D4-2). 지운 팀장은 뺀다. */
  recordRestartFailures(memberIds: readonly string[]): void {
    const members = memberIds.map(id => this.getMember(id)).filter((member): member is Member => member !== null);
    if (!members.length) return;
    this.transaction(() => this.recorder?.restartFailures?.(members));
  }

  /** null 이면 지운다. 화면에 나가는 값이 아니라 알림(event)은 내지 않는다. */
  setRestartWake(memberId: string, wake: RestartWake | null): void {
    this.transaction(() => {
      const saved = this.restartWakes();
      if (wake) saved[memberId] = wake;
      else if (memberId in saved) delete saved[memberId];
      else return;
      if (Object.keys(saved).length === 0) this.run("DELETE FROM settings WHERE key = ?", RESTART_WAKE_KEY);
      else this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", RESTART_WAKE_KEY, JSON.stringify(saved));
      // Z: 재시작으로 끊긴 실행을 다시 열어 이어갈 차례인지가 그 팀장이 받은 대표 글의 답 상태(일하는 중·멈춤)를 가른다.
      this.noteReply(memberId);
    });
  }

  // ---- 설정 ----
  getSettings(): Settings {
    return this.deliveryReadMemo("settings", () => this.readSettings());
  }

  private readSettings(): Settings {
    const settings: Settings = { ...DEFAULT_SETTINGS };
    for (const r of this.rows("SELECT key, value FROM settings")) {
      if (r.key in settings) (settings as unknown as Record<string, unknown>)[r.key] = JSON.parse(r.value);
    }
    // 나중에 생긴 직급이 저장값에 없어도 칸은 늘 있어야 한다.
    settings.ranks = Object.fromEntries((Object.keys(DEFAULT_RANKS) as Rank[]).map((rank) => [rank, { ...DEFAULT_RANKS[rank], ...settings.ranks[rank] }])) as Settings["ranks"];
    settings.codexRanks = Object.fromEntries((Object.keys(DEFAULT_CODEX_RANKS) as Rank[]).map((rank) => [rank, { ...DEFAULT_CODEX_RANKS[rank], ...settings.codexRanks[rank] }])) as Settings["codexRanks"];
    // 저장값이 없는 DB(이 칸이 생기기 전)와 일부 직급만 저장된 값도 칸은 늘 다 있어야 한다.
    settings.geminiRanks = Object.fromEntries((Object.keys(DEFAULT_GEMINI_RANKS) as Rank[]).map((rank) => [rank, { ...DEFAULT_GEMINI_RANKS[rank], ...settings.geminiRanks?.[rank] }])) as Settings["geminiRanks"];
    settings.contextWindows = { ...DEFAULT_CONTEXT_WINDOWS, ...settings.contextWindows };
    return settings;
  }

  patchSettings(patch: SettingsPatch): Settings {
    return this.transaction(() => {
      const before = this.getSettings();
      const next: Record<string, unknown> = { ...patch };
      // 권한 방식 확인은 되돌리지 않는다.
      if (next.permissionAcknowledged === false && before.permissionAcknowledged !== false) delete next.permissionAcknowledged;
      if (patch.ranks) {
        next.ranks = Object.fromEntries((Object.keys(DEFAULT_RANKS) as Rank[]).map((rank) => [rank, { ...before.ranks[rank], ...patch.ranks![rank] }]));
      }
      if (patch.codexRanks) {
        next.codexRanks = Object.fromEntries((Object.keys(DEFAULT_CODEX_RANKS) as Rank[]).map((rank) => [rank, { ...before.codexRanks[rank], ...patch.codexRanks![rank] }]));
      }
      if (patch.geminiRanks) {
        next.geminiRanks = Object.fromEntries((Object.keys(DEFAULT_GEMINI_RANKS) as Rank[]).map((rank) => [rank, { ...before.geminiRanks[rank], ...patch.geminiRanks![rank] }]));
      }
      this.transaction(() => {
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (next[key] === undefined) continue;
          this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(next[key]));
        }
      });
      if (Object.keys(next).some((key) => next[key] !== undefined && key in DEFAULT_SETTINGS)) this.run("UPDATE domain_revisions SET revision = revision + 1 WHERE domain = 'settings'");
      const settings = this.getSettings();
      this.emit({ type: "settings", settings });
      if (settings.backend !== before.backend) this.emitProjects();
      return settings;
    });
  }

  // ---- 전체 DB 복구 조회: 화면의 50/200/500개 제한을 재사용하지 않는다 ----
  listMessagesMissingDeliveries(projectId?: string): Message[] {
    return this.rows(`SELECT m.* FROM messages m WHERE m.mine = 1 AND m.delivery IN ('queued','held')
      ${projectId === undefined ? "" : "AND m.project_id = ?"}
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.ref_type = 'message' AND d.ref_id = m.id)
      ORDER BY m.at COLLATE BINARY, m.id COLLATE BINARY`, ...(projectId === undefined ? [] : [projectId])).map(r => this.messageFrom(r));
  }

  /**
   * 팀장 보고 가운데 총괄에게 넘기는 전달이 없는 글(그 넘김이 사라졌을 때 다시 만든다). 서버가 그 팀장 이름으로 남긴 글(who='시스템': 30분 지연 알림·
   * 압축 확인 필요 등)은 팀장 보고가 아니다(0.2.7 배포 전 확인 real-cli P2: 총괄이 같은 알림을 '[시스템] …' 사본과 '[보고 시스템] 알림: …'으로 두 번 받았다).
   * '시스템'은 팀장 이름으로 쓸 수 없다(server/text.ts RESERVED_NAMES).
   */
  listReportsMissingDeliveries(projectId?: string): Message[] {
    return this.rows(`SELECT m.* FROM messages m WHERE m.mine = 0 AND m.member_id IS NOT NULL AND m.who <> '시스템' AND m.kind IN ('완료','진행','막힘','알림')
      AND m.rowid > COALESCE((SELECT legacy_max_rowid FROM report_delivery_tracking WHERE id = 1), 0)
      ${projectId === undefined ? "" : "AND m.project_id = ?"}
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.ref_type = 'message' AND d.ref_id = m.id AND d.kind = 'report')
      ORDER BY m.at COLLATE BINARY, m.id COLLATE BINARY`, ...(projectId === undefined ? [] : [projectId])).map(r => this.messageFrom(r));
  }

  /**
   * 0.2.10 고아 보고 점검(30초 틱, OwnerFlows.repairSourceIntents): listReportsMissingDeliveries 가운데 부르는 쪽이 실제로 넘기는 글만.
   * 그 쪽이 하던 작성자 거르기(작성자가 직원이고 지금 총괄이 아님)를 SQL 로 옮겨 넘길 글만 조립한다. 예전에는 총괄 자신의 보고(넘김이 영영 생기지
   * 않는 글, 지금 거의 전부)까지 30초마다 모두 조립하고 버렸다. 작성자는 프로젝트를 따지지 않고 id 로 찾는다(getMember 와 같다).
   * 총괄은 root·conductor 라 '직원' 조건이 '총괄이 아님'을 이미 담는다.
   *
   * 물높이(reportScan): 프로젝트마다 '이 rowid 까지는 넘길 글이 없다'를 기억하고 그 뒤의 글만 본다. 이미 본 글이 다시 넘길 글이 되는 길은
   * 그 글의 보고 전달이 지워지거나(전달 행 삭제, 팀장·프로젝트 삭제의 연쇄) 작성자가 새로 직원이 되는 것(팀장 생성)뿐이다. 글의 작성자·종류·
   * 대표 여부와 팀장의 종류는 바뀌지 않고, 글은 프로젝트를 지울 때만 지워진다(그때만 rowid 가 다시 쓰일 수 있다). 그 변화는 모두
   * reportScanEpoch 를 올려(run) 물높이를 버리고 처음부터 다시 본다. 넘길 글이 남으면 물높이는 그중 가장 앞의 글 바로 앞에 둔다.
   */
  listWorkerReportsMissingDeliveries(projectId: string, leadId: string): Message[] {
    const mark = this.reportScan.get(projectId);
    const epoch = this.reportScanEpoch;
    const from = mark && mark.epoch === epoch ? mark.through : 0;
    const top = (this.row("SELECT MAX(rowid) AS top FROM messages")?.top as number | null) ?? 0;
    // 물높이가 있으면 rowid 범위에서 출발하고(+m.project_id 로 프로젝트 색인을 고르지 않게 한다), 처음에는 프로젝트 색인에서 출발한다.
    // rowid 하한은 하나로 합친다(MAX). 둘로 두면 SQLite 가 옛 경계 쪽을 범위로 골라 물높이가 있어도 끝까지 훑었다.
    const rows = this.rows(`SELECT m.rowid AS report_scan_rowid, m.* FROM messages m WHERE m.mine = 0 AND m.member_id IS NOT NULL AND m.who <> '시스템' AND m.kind IN ('완료','진행','막힘','알림')
      AND m.rowid > MAX(?, COALESCE((SELECT legacy_max_rowid FROM report_delivery_tracking WHERE id = 1), 0))
      AND ${from ? "+m.project_id" : "m.project_id"} = ? AND m.member_id <> ?
      AND EXISTS (SELECT 1 FROM members a WHERE a.id = m.member_id AND a.kind = 'worker')
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.ref_type = 'message' AND d.ref_id = m.id AND d.kind = 'report')
      ORDER BY m.at COLLATE BINARY, m.id COLLATE BINARY`, from, projectId, leadId);
    const through = rows.length ? Math.min(...rows.map(row => row.report_scan_rowid as number)) - 1 : Math.max(top, from);
    // 이 트랜잭션이 되돌려지면 기억하지 않는다(그 사이 넣은 전달도 없던 것이 된다).
    const remember = () => { if (this.reportScanEpoch === epoch) this.reportScan.set(projectId, { through, epoch }); };
    if (this.commitFrames.length) this.commitFrames.at(-1)!.push(remember);
    else if (!this.db.inTransaction) remember();
    return rows.map(r => this.messageFrom(r));
  }

  listAnswersMissingDeliveries(projectId?: string): Decision[] {
    return this.rows(`SELECT a.* FROM decisions a WHERE a.status = 'answered'
      ${projectId === undefined ? "" : "AND a.project_id = ?"}
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.ref_type = 'decision' AND d.ref_id = a.id)
      ORDER BY a.answered_at, a.rowid`, ...(projectId === undefined ? [] : [projectId])).map(toDecision);
  }

  listUnreceivedAnswers(memberId: string): Decision[] {
    const member = this.requireMember(memberId);
    return this.rows("SELECT * FROM decisions WHERE project_id = ? AND member_id = ? AND status = 'answered' AND delivered_at IS NULL ORDER BY answered_at, rowid", member.projectId, memberId).map(toDecision);
  }

  /** 전달 이력 전체(만든 순서). 자주 도는 길은 쓰지 않는다: listLiveDeliveries·listDeliveriesByRef·listFenceCandidates 를 쓴다. */
  listDeliveries(projectId?: string): Delivery[] {
    if (projectId !== undefined && this.deliveryRead?.projectId === projectId) {
      return this.deliveryRead.all ??= this.rows("SELECT * FROM deliveries WHERE project_id = ? ORDER BY rowid", projectId).map(toDelivery);
    }
    return this.rows(`SELECT * FROM deliveries ${projectId === undefined ? "" : "WHERE project_id = ?"} ORDER BY rowid`, ...(projectId === undefined ? [] : [projectId])).map(toDelivery);
  }

  /** 0.2.10: 프로젝트의 살아 있는 전달(LIVE_DELIVERIES_SQL, 만든 순서). 전달 알림·대표 판단 수·정체 점검이 쓴다. */
  listLiveDeliveries(projectId: string): Delivery[] {
    if (this.deliveryRead?.projectId === projectId) return this.deliveryRead.live;
    return this.rows(LIVE_DELIVERIES_SQL, projectId, projectId).map(toDelivery);
  }

  /**
   * 0.2.10: 한 원문(글·결재·할 일)에 딸린 전달(만든 순서). listDeliveries(projectId).filter(같은 ref_type·ref_id) 와 같다. projectId 를 빼면 모든 프로젝트.
   * refId 를 빼면 그 종류 전부(ref_id 가 있는 것만).
   */
  listDeliveriesByRef(refType: string, refId?: string, projectId?: string): Delivery[] {
    // +project_id: project_id 색인(rowid 차례)을 고르면 그 프로젝트의 이력 전체를 훑는다. ref 색인을 타게 한다.
    const where = ["ref_type = ?", refId === undefined ? "ref_id IS NOT NULL" : "ref_id = ?", ...(projectId === undefined ? [] : ["+project_id = ?"])];
    return this.rows(`SELECT * FROM deliveries WHERE ${where.join(" AND ")} ORDER BY rowid`, refType, ...(refId === undefined ? [] : [refId]), ...(projectId === undefined ? [] : [projectId])).map(toDelivery);
  }

  /**
   * 0.2.10: 같은 팀장·같은 원문·같은 원문 판(source_revision)으로 이 전달보다 뒤에(rowid) 만든 전달이 같은 프로젝트에 있는가. 전달 알림이 앞선 실패를
   * 숨길 때 쓴다(예전에는 프로젝트 전달 전체에서 키마다 마지막 것을 골랐다). 원문이나 판이 없으면 false.
   */
  hasLaterSameSource(delivery: Delivery): boolean {
    const revision = this.getDeliveryRetry(delivery.id).sourceRevision;
    if (!delivery.refType || !delivery.refId || !revision) return false;
    return !!this.row(`SELECT 1 FROM deliveries o WHERE o.ref_type = ? AND o.ref_id = ? AND o.member_id = ? AND o.project_id = ? AND o.source_revision = ?
      AND o.rowid > (SELECT rowid FROM deliveries WHERE id = ?) LIMIT 1`, delivery.refType, delivery.refId, delivery.memberId, delivery.projectId, revision, delivery.id);
  }

  /**
   * 0.2.10: 이 팀장의 전달 가운데 논리 울타리(DeliveryRecovery.logicalFence)가 될 수 있는 것만(만든 순서): 넣는 중·보류이거나 확인이 끝나지 않은 것.
   * 울타리는 phase 가 none·resolved·stopped 가 아니거나(→ 확인 중인 phase), phase 가 none 이면서 넣는 중이거나 수신 확인 보류인 전달뿐이라 그 밖은 볼 필요가 없다.
   */
  listFenceCandidates(memberId: string): Delivery[] {
    const projectId = this.requireMember(memberId).projectId;
    return this.rows(`SELECT * FROM deliveries WHERE rowid IN (
        SELECT rowid FROM deliveries WHERE member_id = ? AND status IN ('delivering','held') AND +project_id = ?
        UNION ALL SELECT d.rowid FROM delivery_recovery r CROSS JOIN deliveries d ON d.id = r.delivery_id
          WHERE r.phase IN ('checking','waiting','retry_wait','needs_owner') AND d.member_id = ? AND d.project_id = ?)
      ORDER BY rowid`, memberId, projectId, memberId, projectId).map(toDelivery);
  }

  /**
   * Ordinary queued rows need no evidence scan. An unresolved physical write remains eligible even after logical resolution.
   * 0.2.10: 조건마다 색인을 타는 SELECT 로 나눠 합친다(예전 한 문장의 OR 는 전달 이력 전체를 훑었다). 고르는 전달은 같다.
   * phase 는 CHECK 로 일곱 값뿐이라 NOT IN ('none','resolved','stopped') 는 아래 IN 과 같다.
   */
  listDeliveryRecoveryCandidates(): Delivery[] {
    return this.rows(`SELECT * FROM deliveries WHERE rowid IN (
        SELECT d.rowid FROM delivery_recovery r CROSS JOIN deliveries d ON d.id = r.delivery_id WHERE r.phase IN ('checking','waiting','retry_wait','needs_owner')
        UNION SELECT d.rowid FROM deliveries d JOIN delivery_recovery r ON r.delivery_id = d.id WHERE d.status IN ('failed','delivering')
        UNION SELECT d.rowid FROM deliveries d JOIN delivery_recovery r ON r.delivery_id = d.id WHERE d.status = 'held' AND d.hold_reason = 'delivery_unknown'
        UNION SELECT d.rowid FROM delivery_dispatches p CROSS JOIN delivery_dispatch_items i ON i.dispatch_id = p.id CROSS JOIN deliveries d ON d.id = i.delivery_id
          CROSS JOIN delivery_recovery r ON r.delivery_id = d.id WHERE p.transport_state IN ('prepared','write_started','unknown'))
      ORDER BY rowid`).map(toDelivery);
  }

  deliveryRetryDue(memberId: string, backend: Backend): number {
    // 펌프마다 부른다. 조건을 둘로 나눠 각각 인덱스를 타게 한다(한 문장의 OR 는 전달 이력 전체를 훑었다).
    return this.rows(`SELECT next_attempt_at FROM deliveries WHERE member_id = ? AND status IN ('queued','held') AND next_attempt_at IS NOT NULL
      UNION ALL SELECT next_attempt_at FROM deliveries WHERE status IN ('queued','held','delivering','delivered','failed') AND next_attempt_at IS NOT NULL AND retry_scope IN (?, ?)`,
      memberId, `member:${memberId}`, `backend:${backend}`).reduce((due, row) => Math.max(due, Date.parse(row.next_attempt_at)), 0);
  }

  // ---- revision / CAS ----
  settingsRevision(): number {
    return this.row("SELECT revision FROM domain_revisions WHERE domain = 'settings'")!.revision;
  }

  memberRevisions(memberId: string): MemberRevisions {
    this.requireMember(memberId);
    const r = this.row("SELECT config_revision, session_generation FROM members WHERE id = ?", memberId)!;
    return { configRevision: r.config_revision, sessionGeneration: r.session_generation };
  }

  todoRevision(id: string): number {
    this.requireTodo(id);
    return this.row("SELECT revision FROM todos WHERE id = ?", id)!.revision;
  }

  syncRevisions(projectId: string): SyncRevisions {
    this.requireProject(projectId);
    return { settings: this.settingsRevision(), members: Object.fromEntries(this.rows("SELECT id, config_revision, session_generation FROM members WHERE project_id = ?", projectId).map((r) => [r.id, { configRevision: r.config_revision, sessionGeneration: r.session_generation }])), todos: Object.fromEntries(this.rows("SELECT id, revision FROM todos WHERE project_id = ?", projectId).map((r) => [r.id, r.revision])) };
  }

  private checkRevision(actual: number, expected: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new ApiError(400, "revision이 올바르지 않습니다", "invalid_revision_value");
    if (actual !== expected) throw new ApiError(409, "내용이 변경되었습니다. 다시 검토해 주세요", "REVISION_CONFLICT");
  }

  patchSettingsCas(patch: SettingsPatch, expectedRevision: number): { settings: Settings; revision: number } {
    return this.transaction(() => {
      this.checkRevision(this.settingsRevision(), expectedRevision);
      const settings = this.patchSettings(patch);
      return { settings, revision: this.settingsRevision() };
    });
  }

  patchMemberCas(id: string, patch: MemberPatch, expectedRevision: number): { member: Member } & MemberRevisions {
    return this.transaction(() => {
      this.checkRevision(this.memberRevisions(id).configRevision, expectedRevision);
      const member = this.patchMember(id, patch);
      return { member, ...this.memberRevisions(id) };
    });
  }

  setTodoDoneCas(id: string, done: boolean, expectedRevision: number): { todo: Todo; revision: number } {
    return this.transaction(() => {
      this.checkRevision(this.todoRevision(id), expectedRevision);
      const { todo } = this.setTodoDone(id, done);
      return { todo, revision: this.todoRevision(id) };
    });
  }

  // ---- 작업 영수증: 같은 ID/요청만 합치고 결과에는 내부 요청을 싣지 않는다 ----
  getOperation(operationId: string): OperationReceipt | null {
    const r = this.row("SELECT * FROM operation_receipts WHERE operation_id = ?", operationId);
    if (!r) return null;
    const base = { operationId: r.operation_id, kind: r.kind, projectId: r.project_id, memberId: r.member_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
    return { ...base, ...(r.status === "applied" ? { result: json(r.result_json) } : r.status === "pending" ? {} : { code: r.code, error: r.error, ...(r.reason ? { reason: r.reason } : {}) }) } as OperationReceipt;
  }

  beginOperation(input: { operationId: string; kind: OperationKind; projectId: string | null; memberId: string | null; request: unknown }): OperationReceipt {
    return this.transaction(() => {
      if (input.projectId !== null) this.requireProject(input.projectId);
      if (input.memberId !== null && this.requireMember(input.memberId).projectId !== input.projectId) throw new ApiError(400, "다른 프로젝트의 팀원입니다", "member_other_project");
      const r = this.row("SELECT * FROM operation_receipts WHERE operation_id = ?", input.operationId);
      if (r) {
        if (r.kind !== input.kind || r.project_id !== input.projectId || r.member_id !== input.memberId || r.request_json !== stableJson(input.request)) throw new ApiError(409, "다른 요청에 사용된 operationId입니다", "OPERATION_CONFLICT");
        return this.getOperation(input.operationId)!;
      }
      const at = nowIso();
      this.run("INSERT INTO operation_receipts (operation_id, kind, project_id, member_id, status, request_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)", input.operationId, input.kind, input.projectId, input.memberId, stableJson(input.request), at, at);
      return this.getOperation(input.operationId)!;
    });
  }

  finishOperation(receipt: OperationReceipt, expectedStatus: OperationStatus = "pending"): OperationReceipt {
    return this.transaction(() => {
      const before = this.getOperation(receipt.operationId);
      if (!before) throw new ApiError(404, "작업을 찾을 수 없습니다", "operation_not_found");
      if (before.kind !== receipt.kind || before.projectId !== receipt.projectId || before.memberId !== receipt.memberId) throw new ApiError(409, "작업 범위가 다릅니다", "operation_scope_mismatch");
      if (before.status !== expectedStatus || before.status === "applied" || before.status === "refused") throw new ApiError(409, "작업 결과가 변경되었습니다", "OPERATION_CONFLICT");
      const failed = receipt.status === "unknown" || receipt.status === "refused";
      this.run("UPDATE operation_receipts SET status = ?, result_json = ?, code = ?, error = ?, reason = ?, updated_at = ? WHERE operation_id = ? AND status = ?", receipt.status, receipt.status === "applied" ? JSON.stringify(receipt.result) : null, failed ? receipt.code : null, failed ? receipt.error : null, failed ? receipt.reason ?? null : null, nowIso(), receipt.operationId, expectedStatus);
      return this.getOperation(receipt.operationId)!;
    });
  }

  listPendingOperations(): OperationReceipt[] {
    return this.rows("SELECT operation_id FROM operation_receipts WHERE status = 'pending' ORDER BY created_at, rowid").map((r) => this.getOperation(r.operation_id)!);
  }

  agentOperation<T>(memberId: string, toolName: string, operationId: string, request: unknown, execute: () => T): T {
    return this.transaction(() => {
      const member = this.requireMember(memberId);
      const r = this.row("SELECT * FROM agent_operation_receipts WHERE operation_id = ?", operationId);
      if (r) {
        if (r.member_id !== memberId || r.project_id !== member.projectId || r.tool_name !== toolName || r.request_json !== stableJson(request)) throw new ApiError(409, "다른 요청에 사용된 operationId입니다", "OPERATION_CONFLICT");
        return json<T>(r.result_json);
      }
      const result = execute();
      if (result instanceof Promise) throw new Error("agentOperation requires synchronous Store writes");
      this.run("INSERT INTO agent_operation_receipts (operation_id, member_id, project_id, tool_name, request_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", operationId, memberId, member.projectId, toolName, stableJson(request), JSON.stringify(result), nowIso());
      return result;
    });
  }

  // ---- lease / 입력 fence ----
  saveLease(lease: TerminalLease): void {
    this.transaction(() => {
      this.checkRevision(this.memberRevisions(lease.memberId).sessionGeneration, lease.identity.sessionGeneration);
      // 지금 터미널이 아닌 터미널에 묶인 줄은 조작권이 아니다(leaseRow). 남아 있어도 새 조작권을 막지 않고 덮어쓴다.
      const r = this.leaseRow(lease.memberId, false);
      if (r && r.expires_at > Date.now() && (r.claim_id !== lease.claimId || r.lease_id !== lease.leaseId || r.terminal_identity_json !== stableJson(lease.identity))) throw new ApiError(409, "다른 조작권이 있습니다", "terminal_lease_other");
      if (r && r.claim_id === lease.claimId && lease.lastInputSequence < r.last_input_sequence) throw new ApiError(409, "입력 순번이 오래되었습니다", "terminal_input_sequence_stale");
      this.run(`INSERT INTO terminal_leases (member_id, claim_id, lease_id, generation, terminal_identity_json, expires_at, last_input_sequence) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(member_id) DO UPDATE SET claim_id = excluded.claim_id, lease_id = excluded.lease_id, generation = excluded.generation, terminal_identity_json = excluded.terminal_identity_json, expires_at = excluded.expires_at, last_input_sequence = excluded.last_input_sequence`, lease.memberId, lease.claimId, lease.leaseId, lease.identity.sessionGeneration, stableJson(lease.identity), lease.expiresAt, lease.lastInputSequence);
    });
  }

  removeLease(memberId: string, claimId: string): void {
    this.run("DELETE FROM terminal_leases WHERE member_id = ? AND claim_id = ?", memberId, claimId);
  }

  inputState(memberId: string): RunnerRecoveryState {
    return this.deliveryReadMemo(`input:${memberId}`, () => this.readInputState(memberId));
  }

  /**
   * 조작권은 그것을 얻은 터미널에 묶여 있다. 명부의 지금 터미널과 다른 터미널(사라져 비워졌거나 새로 열린 터미널)에 묶인 줄은 유효하지 않다:
   * 예전에는 Mac 재시작으로 터미널이 사라져도 만료(5분)까지 그 팀장의 전달을 모두 막았다.
   * current 가 참이면 이 세대의, 만료되지 않은 줄만 돌려준다.
   */
  private leaseRow(memberId: string, current: boolean): Row | null {
    const r = current
      ? this.row("SELECT * FROM terminal_leases WHERE member_id = ? AND generation = ? AND expires_at > ?", memberId, this.memberRevisions(memberId).sessionGeneration, Date.now())
      : this.row("SELECT * FROM terminal_leases WHERE member_id = ?", memberId);
    if (!r) return null;
    const pane = this.row("SELECT pane_id FROM members WHERE id = ?", memberId)?.pane_id ?? null;
    return json<RunnerTerminalIdentity>(r.terminal_identity_json).terminalId === pane ? r : null;
  }

  /** 사라진 것이 확정된 터미널에 묶인 조작권을 지운다. 지웠으면 그 조작권의 leaseId 를 돌려준다. */
  removeLeaseOfTerminal(memberId: string, terminalId: string): string | null {
    return this.transaction(() => {
      const r = this.row("SELECT * FROM terminal_leases WHERE member_id = ?", memberId);
      if (!r || json<RunnerTerminalIdentity>(r.terminal_identity_json).terminalId !== terminalId) return null;
      this.run("DELETE FROM terminal_leases WHERE member_id = ? AND claim_id = ?", memberId, r.claim_id);
      return r.lease_id as string;
    });
  }

  private readInputState(memberId: string): RunnerRecoveryState {
    const r = this.leaseRow(memberId, true);
    return { lease: r ? { memberId, claimId: r.claim_id, leaseId: r.lease_id, identity: json(r.terminal_identity_json), expiresAt: r.expires_at, lastInputSequence: r.last_input_sequence } : null, unresolvedDispatches: this.unresolvedDispatches(memberId) };
  }

  /**
   * 풀리지 않은 봉투: 쓰기 결과를 모르거나(prepared·write_started·unknown), 항목 하나라도 전달 확인이 끝나지 않았다
   * (none·resolved·stopped 가 아니고, 입력칸 대기·낡은 지시로 대표에게 묻는 중도 아니다). 만든 순서.
   * 11-16(D4-5): 예전에는 그 팀장의 봉투 이력 전체(바쁜 총괄은 560~632개, 본문·기준선 JSON 포함)를 읽어 걸렀다. 한 번에 5ms 쯤인데,
   * 봉투마다 이것을 부르는 전달 확인 반복(DeliveryRecovery.checkMember)이 이력 크기의 제곱으로 늘어 총괄 타이머가 CPU 로 3~9초 이벤트 루프를 막았다.
   * 같은 조건을 SQL 로 걸러 풀리지 않은 봉투만 읽는다.
   */
  private unresolvedDispatches(memberId: string): DeliveryDispatch[] {
    // 0.2.10: 두 조건을 각각 색인에서 출발하는 SELECT 로 나눠 합친다: 쓰기 결과를 모르는 봉투(delivery_dispatches_physical)와 확인이 끝나지 않은
    // 항목을 담은 봉투(복구 phase 색인 → 항목 → 봉투). 예전 한 문장은 그 팀장의 봉투를 모두 훑었다. phase 는 CHECK 로 일곱 값뿐이라
    // NOT IN ('none','resolved','stopped') 는 아래 IN 과 같다. 고르는 봉투와 차례는 같다.
    return this.rows(`SELECT id FROM delivery_dispatches WHERE rowid IN (
        SELECT rowid FROM delivery_dispatches WHERE member_id = ? AND transport_state IN ('prepared','write_started','unknown')
        UNION SELECT d.rowid FROM delivery_recovery r CROSS JOIN delivery_dispatch_items i ON i.delivery_id = r.delivery_id CROSS JOIN delivery_dispatches d ON d.id = i.dispatch_id
          WHERE r.phase IN ('checking','waiting','retry_wait','needs_owner')
            AND NOT (r.phase = 'waiting' AND COALESCE(r.reason, '') = 'input_busy')
            AND NOT (r.phase = 'needs_owner' AND COALESCE(r.reason, '') = 'stale_instruction') AND d.member_id = ?)
      ORDER BY created_at, rowid`, memberId, memberId).map(row => this.getDispatch(row.id)).filter((d): d is DeliveryDispatch => d !== null);
  }

  /**
   * 이 전달이 들어 있는 마지막 봉투(그 팀장의 봉투 가운데, 만든 순서로 마지막). listDispatches(팀장).filter(이 전달).at(-1) 과 같다.
   * 11-16(D4-5): 전달마다 그 팀장의 봉투 이력 전체를 읽던 것을 색인(delivery_dispatch_items_delivery)으로 바로 찾는다.
   */
  latestDispatchFor(memberId: string, deliveryId: string): DeliveryDispatch | null {
    return this.deliveryReadMemo(`latest-dispatch:${memberId}:${deliveryId}`, () => {
      // 0.2.10: CROSS JOIN 으로 이 전달의 항목에서 출발한다. 그냥 JOIN 이면 SQLite 가 그 팀장의 봉투를 최근 순으로 훑어 오래된 전달일수록 느렸다.
      const row = this.row(`SELECT d.id FROM delivery_dispatch_items i CROSS JOIN delivery_recovery r ON r.delivery_id = i.delivery_id CROSS JOIN delivery_dispatches d ON d.id = i.dispatch_id
        WHERE i.delivery_id = ? AND d.member_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`, deliveryId, memberId);
      return row ? this.getDispatch(row.id) : null;
    });
  }

  /** 0.2.10: 이 전달이 들어 있는 그 팀장의 봉투(만든 순서). listDispatches(팀장).filter(이 전달을 담은 것) 과 같다. */
  listDispatchesFor(memberId: string, deliveryId: string): DeliveryDispatch[] {
    return this.rows(`SELECT d.id FROM delivery_dispatch_items i CROSS JOIN delivery_recovery r ON r.delivery_id = i.delivery_id CROSS JOIN delivery_dispatches d ON d.id = i.dispatch_id
      WHERE i.delivery_id = ? AND d.member_id = ? ORDER BY d.created_at, d.rowid`, deliveryId, memberId).map(row => this.getDispatch(row.id)!);
  }

  /** 0.2.10: 쓰기 결과를 모르는 봉투(prepared·write_started·unknown)만(만든 순서). listDispatches(팀장)을 그 상태로 거른 것과 같다. 색인 delivery_dispatches_physical. */
  listPhysicalDispatches(memberId: string): DeliveryDispatch[] {
    return this.rows("SELECT id FROM delivery_dispatches WHERE member_id = ? AND transport_state IN ('prepared','write_started','unknown') ORDER BY created_at, rowid", memberId)
      .map(row => this.getDispatch(row.id)!);
  }

  /**
   * 0.2.10: 그 팀장의 봉투 가운데 쓰기 결과를 모르는 것과 주어진 전달 가운데 하나라도 담은 것(만든 순서). listDispatches(팀장)의 부분 집합이고,
   * 빠진 봉투는 쓰기가 끝났고 그 전달들을 담지 않은 것뿐이다.
   */
  listDispatchesTouching(memberId: string, deliveryIds: string[]): DeliveryDispatch[] {
    return this.rows(`SELECT id FROM delivery_dispatches WHERE rowid IN (
        SELECT rowid FROM delivery_dispatches WHERE member_id = ? AND transport_state IN ('prepared','write_started','unknown')
        UNION SELECT p.rowid FROM json_each(?) j CROSS JOIN delivery_dispatch_items i ON i.delivery_id = j.value CROSS JOIN delivery_dispatches p ON p.id = i.dispatch_id WHERE p.member_id = ?)
      ORDER BY created_at, rowid`, memberId, JSON.stringify(deliveryIds), memberId).map(row => this.getDispatch(row.id)!);
  }

  /** 0.2.10: 그 팀장의 마지막 봉투(만든 순서로 마지막, listDispatches(팀장).at(-1))의 id 와 만든 시각. 없으면 null. */
  lastDispatch(memberId: string): { dispatchId: string; createdAt: string } | null {
    const row = this.row("SELECT id, created_at FROM delivery_dispatches WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", memberId);
    return row ? { dispatchId: row.id, createdAt: row.created_at } : null;
  }

  // ---- 전달 복구 CAS / 봉투 ----
  getDeliveryRecovery(deliveryId: string): DeliveryRecoveryRecord | null {
    const r = this.deliveryRead?.rows.has(deliveryId) ? this.deliveryRead.recoveries.get(deliveryId) : this.row("SELECT * FROM delivery_recovery WHERE delivery_id = ?", deliveryId);
    return r ? this.deliveryRecoveryFrom(r) : null;
  }

  private deliveryRecoveryFrom(r: Row): DeliveryRecoveryRecord {
    return { deliveryId: r.delivery_id, marker: r.marker, phase: r.phase, reason: r.reason, version: r.version, autoAttempts: r.auto_attempts, checkCount: r.check_count, activeCheckMs: r.active_check_ms, nextCheckAt: r.next_check_at, lastCheckedAt: r.last_checked_at, evidence: json(r.evidence_json), updatedAt: r.updated_at };
  }

  updateDeliveryRecovery(deliveryId: string, expectedVersion: number, patch: Partial<Omit<DeliveryRecoveryRecord, "deliveryId" | "version" | "updatedAt">>): DeliveryRecoveryRecord {
    return this.transaction(() => {
      this.requireDelivery(deliveryId);
      const before = this.getDeliveryRecovery(deliveryId);
      if (!before) throw new ApiError(404, "전달 복구 상태를 찾을 수 없습니다", "delivery_recovery_missing");
      this.checkRevision(before.version, expectedVersion);
      if (before.marker !== null && patch.marker !== undefined && patch.marker !== before.marker) throw new ApiError(409, "저장된 전달 표식은 바꿀 수 없습니다", "delivery_marker_immutable");
      const { set, values } = buildSet({ ...patch, evidence: patch.evidence === undefined ? undefined : JSON.stringify(patch.evidence) }, { marker: "marker", phase: "phase", reason: "reason", autoAttempts: "auto_attempts", checkCount: "check_count", activeCheckMs: "active_check_ms", nextCheckAt: "next_check_at", lastCheckedAt: "last_checked_at", evidence: "evidence_json" });
      this.run(`UPDATE delivery_recovery SET ${[...set, "version = version + 1", "updated_at = ?"].join(", ")} WHERE delivery_id = ? AND version = ?`, ...values, nowIso(), deliveryId, expectedVersion);
      const phaseChanged = patch.phase !== undefined && patch.phase !== before.phase;
      if (phaseChanged && (patch.phase === "needs_owner" || before.phase === "needs_owner")) this.emitProjects();
      // 전달 단계·사유는 스냅샷(전달 알림)에 보인다. 이벤트 없이 바뀌면 cursor 로 묶인 /api/sync 캐시와 앱이 낡은 상태를 계속 보여 준다.
      // 확인할 때마다 바뀌는 시각(nextCheckAt·lastCheckedAt)만의 변경은 알리지 않는다.
      if (phaseChanged || patch.reason !== undefined && patch.reason !== before.reason) this.emitMember(this.requireDelivery(deliveryId).memberId);
      return this.getDeliveryRecovery(deliveryId)!;
    });
  }

  /**
   * 확인을 이어 가는 전달 중 가장 이른 다음 확인 시각. 대표를 기다리는 것(needs_owner)은 틱이 본다. waiting 은 직원이 일하는 동안 계속 이어지므로 따로 준다.
   * from: 그보다 앞선 확인 시각은 세지 않는다. 방금 돈 확인이 그대로 둔 행(보관된 프로젝트, 직접 조작 중)이다.
   */
  nextDeliveryCheckAt(from: number | null = null): { active: number | null; waiting: number | null } {
    const since = from === null ? [] : [new Date(from).toISOString()];
    const min = (phases: string) => {
      const at = this.row(`SELECT MIN(next_check_at) AS at FROM delivery_recovery WHERE phase IN (${phases}) AND next_check_at IS NOT NULL${since.length ? " AND next_check_at >= ?" : ""}`, ...since)?.at as string | null | undefined;
      return at ? Date.parse(at) : null;
    };
    return { active: min("'checking','retry_wait'"), waiting: min("'waiting'") };
  }

  listDeliveryRecoveries(projectId?: string): DeliveryRecoveryRecord[] {
    // 전달마다 다시 묻지 않고 한 번에 읽는다.
    return this.rows(`SELECT r.* FROM delivery_recovery r JOIN deliveries d ON d.id = r.delivery_id ${projectId === undefined ? "" : "WHERE d.project_id = ?"} ORDER BY d.rowid`, ...(projectId === undefined ? [] : [projectId])).map((r) => this.deliveryRecoveryFrom(r));
  }

  saveDispatch(dispatch: DeliveryDispatch): void {
    this.transaction(() => {
      if (this.requireMember(dispatch.memberId).projectId !== dispatch.projectId) throw new ApiError(400, "다른 프로젝트의 팀원입니다", "member_other_project");
      this.checkRevision(this.memberRevisions(dispatch.memberId).sessionGeneration, dispatch.identity.sessionGeneration);
      if (this.getDispatch(dispatch.dispatchId)) throw new ApiError(409, "이미 저장된 봉투입니다", "envelope_exists");
      if (!dispatch.items.length || dispatch.items.length !== dispatch.markers.length) throw new ApiError(400, "봉투 항목이 올바르지 않습니다", "envelope_invalid");
      if (createHash("sha256").update(dispatch.wireText).digest("hex") !== dispatch.wireSha256) throw new ApiError(400, "봉투의 해시가 다릅니다", "envelope_hash_mismatch");
      const at = dispatch.createdAt;
      this.run(`INSERT INTO delivery_dispatches (id, project_id, member_id, bundle_marker, cli, backend, generation, native_session_id, terminal_identity_json, baseline_json, wire_text, wire_sha256, transport_state, submit_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, dispatch.dispatchId, dispatch.projectId, dispatch.memberId, dispatch.bundleMarker, dispatch.cli, dispatch.backend, dispatch.identity.sessionGeneration, dispatch.identity.sessionId, JSON.stringify(dispatch.identity), JSON.stringify(dispatch.baseline), dispatch.wireText, dispatch.wireSha256, dispatch.transportState, dispatch.submitAttempts, at, dispatch.updatedAt);
      for (const item of dispatch.items) {
        const delivery = this.requireDelivery(item.deliveryId);
        const marker = dispatch.markers.find((m) => m.deliveryId === item.deliveryId)?.marker;
        if (delivery.memberId !== dispatch.memberId || delivery.projectId !== dispatch.projectId || !marker) throw new ApiError(400, "봉투 항목의 대상이 다릅니다", "envelope_target_mismatch");
        this.run("INSERT INTO delivery_dispatch_items (dispatch_id, delivery_id, ordinal, source_revision) VALUES (?, ?, ?, ?)", dispatch.dispatchId, item.deliveryId, item.ordinal, item.sourceRevision);
        this.updateDeliveryRecovery(item.deliveryId, this.getDeliveryRecovery(item.deliveryId)!.version, { marker });
      }
    });
  }

  getDispatch(id: string): DeliveryDispatch | null {
    const r = this.row("SELECT * FROM delivery_dispatches WHERE id = ?", id);
    if (!r) return null;
    const items = this.rows("SELECT i.*, r.marker FROM delivery_dispatch_items i JOIN delivery_recovery r ON r.delivery_id = i.delivery_id WHERE dispatch_id = ? ORDER BY ordinal", id);
    return this.dispatchFrom(r, items);
  }

  private dispatchFrom(r: Row, items: Row[]): DeliveryDispatch {
    return { dispatchId: r.id, projectId: r.project_id, memberId: r.member_id, cli: r.cli, backend: r.backend, bundleMarker: r.bundle_marker, identity: json(r.terminal_identity_json), baseline: json(r.baseline_json), wireText: r.wire_text, wireSha256: r.wire_sha256, transportState: r.transport_state, submitAttempts: r.submit_attempts, createdAt: r.created_at, updatedAt: r.updated_at, items: items.map((i) => ({ deliveryId: i.delivery_id, ordinal: i.ordinal, sourceRevision: i.source_revision })), markers: items.map((i) => ({ deliveryId: i.delivery_id, marker: i.marker })) };
  }

  listDispatches(memberId: string): DeliveryDispatch[] {
    return this.deliveryReadMemo(`dispatches:${memberId}`, () => {
      const items = new Map<string, Row[]>();
      for (const row of this.rows(`SELECT i.*, r.marker FROM delivery_dispatch_items i
        JOIN delivery_recovery r ON r.delivery_id = i.delivery_id JOIN delivery_dispatches d ON d.id = i.dispatch_id
        WHERE d.member_id = ? ORDER BY i.dispatch_id, i.ordinal`, memberId)) {
        const own = items.get(row.dispatch_id) ?? [];
        own.push(row); items.set(row.dispatch_id, own);
      }
      return this.rows("SELECT * FROM delivery_dispatches WHERE member_id = ? ORDER BY created_at, rowid", memberId).map(row => this.dispatchFrom(row, items.get(row.id) ?? []));
    });
  }

  /** 아직 쓰기를 시작하지 않은 봉투. 재시작 복구가 직원별 봉투 이력을 다 읽지 않고 찾는다. */
  listPreparedDispatches(): DeliveryDispatch[] {
    return this.rows("SELECT id FROM delivery_dispatches WHERE transport_state = 'prepared' ORDER BY created_at, rowid").map(row => this.getDispatch(row.id)!);
  }

  updateDispatch(id: string, expected: DeliveryDispatch["transportState"], state: DeliveryDispatch["transportState"], submit = false): DeliveryDispatch {
    return this.transaction(() => {
      const result = this.db.query("UPDATE delivery_dispatches SET transport_state = ?, submit_attempts = submit_attempts + ?, updated_at = ? WHERE id = ? AND transport_state = ? AND submit_attempts + ? <= 1").run(state, submit ? 1 : 0, nowIso(), id, expected, submit ? 1 : 0);
      if (result.changes !== 1) throw new ApiError(409, "봉투 상태가 변경되었습니다", "envelope_state_changed");
      return this.getDispatch(id)!;
    });
  }

  deliveryRecoveryOperation<T>(deliveryId: string, operationId: string, request: unknown, execute: () => T): T {
    return this.transaction(() => {
      this.requireDelivery(deliveryId);
      const r = this.row("SELECT * FROM delivery_recovery_operations WHERE operation_id = ?", operationId);
      if (r) {
        if (r.delivery_id !== deliveryId || r.request_json !== stableJson(request)) throw new ApiError(409, "다른 요청에 사용된 operationId입니다", "OPERATION_CONFLICT");
        return json<T>(r.result_json);
      }
      const result = execute();
      if (result instanceof Promise) throw new Error("deliveryRecoveryOperation requires synchronous Store writes");
      this.run("INSERT INTO delivery_recovery_operations (operation_id, delivery_id, request_json, result_json, created_at) VALUES (?, ?, ?, ?, ?)", operationId, deliveryId, stableJson(request), JSON.stringify(result), nowIso());
      return result;
    });
  }

  /** One terminal owner decision per virtual message. Receipt lookup precedes the reviewed-version check. */
  unassignedMessageOperation<T>(messageId: string, operationId: string, request: { operationId: string; expectedVersion: number; action: "send_to_conductor" | "dismiss" },
      action: "send_to_conductor" | "dismiss", execute: () => { result: T; memberId: string | null }): T {
    return this.transaction(() => {
      this.requireMessage(messageId);
      const reused = this.row("SELECT * FROM unassigned_message_recoveries WHERE operation_id = ?", operationId);
      if (reused) {
        if (reused.message_id !== messageId || reused.request_json !== stableJson(request)) throw new ApiError(409, "다른 요청에 사용된 operationId입니다", "OPERATION_CONFLICT");
        return json<T>(reused.result_json);
      }
      const existing = this.row("SELECT * FROM unassigned_message_recoveries WHERE message_id = ? ORDER BY rowid LIMIT 1", messageId);
      if (existing && existing.request_json !== stableJson({ ...request, operationId: existing.operation_id })) throw new ApiError(409, "이미 다른 동작으로 정리했거나 검토 버전이 바뀐 메시지입니다", "message_already_resolved");
      const { result, memberId } = existing
        ? { result: { ...json<T>(existing.result_json), operationId }, memberId: existing.member_id }
        : execute();
      this.run("INSERT INTO unassigned_message_recoveries (message_id, operation_id, request_json, result_json, action, actor, member_id, created_at) VALUES (?, ?, ?, ?, ?, 'owner', ?, ?)",
        messageId, operationId, stableJson(request), JSON.stringify(result), action, memberId, nowIso());
      return result;
    });
  }

  legacyAssignedMember(messageId: string): string | null {
    return this.row("SELECT member_id FROM unassigned_message_recoveries WHERE message_id = ? AND action = 'send_to_conductor' ORDER BY rowid LIMIT 1", messageId)?.member_id ?? null;
  }

  getDeliveryRetry(id: string): DeliveryRetryState {
    this.requireDelivery(id);
    const r = this.deliveryRead?.rows.get(id) ?? this.row("SELECT * FROM deliveries WHERE id = ?", id)!;
    return { nextAttemptAt: r.next_attempt_at, sourceRevision: r.source_revision, retryScope: r.retry_scope, retryReason: r.retry_reason, correctionRevision: r.correction_revision };
  }

  patchDeliveryRetry(id: string, patch: Partial<DeliveryRetryState>): void {
    this.requireDelivery(id);
    const { set, values } = buildSet(patch, { nextAttemptAt: "next_attempt_at", sourceRevision: "source_revision", retryScope: "retry_scope", retryReason: "retry_reason", correctionRevision: "correction_revision" });
    if (set.length) this.run(`UPDATE deliveries SET ${set.join(", ")} WHERE id = ?`, ...values, id);
  }

  // ---- lifecycle / execution journal ----
  saveLifecycleJournal(entry: LifecycleJournal): void {
    this.transaction(() => {
      const before = this.getLifecycleJournal(entry.operationId);
      if (before && (before.memberId !== entry.memberId || before.projectId !== entry.projectId || before.intent !== entry.intent || before.identity.sessionGeneration !== entry.identity.sessionGeneration)) throw new ApiError(409, "종료/생성 의도의 신원이 다릅니다", "lifecycle_intent_mismatch");
      if (before && ["confirmed", "refused"].includes(before.phase) && stableJson(before) !== stableJson(entry)) throw new ApiError(409, "이미 끝난 생성/종료 의도입니다", "lifecycle_intent_finished");
      this.run(`INSERT INTO lifecycle_journal (operation_id, member_id, project_id, intent, phase, generation, terminal_identity_json, run_id, delivery_ids_json, baseline_json, reason, exit_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(operation_id) DO UPDATE SET phase = excluded.phase, terminal_identity_json = excluded.terminal_identity_json, run_id = excluded.run_id, delivery_ids_json = excluded.delivery_ids_json, baseline_json = excluded.baseline_json, reason = excluded.reason, exit_code = excluded.exit_code, updated_at = excluded.updated_at`, entry.operationId, entry.memberId, entry.projectId, entry.intent, entry.phase, entry.identity.sessionGeneration, JSON.stringify(entry.identity), entry.runId, JSON.stringify(entry.deliveryIds), entry.baseline === null ? null : JSON.stringify(entry.baseline), entry.reason, entry.exitCode, entry.createdAt, entry.updatedAt);
    });
  }

  getLifecycleJournal(operationId: string): LifecycleJournal | null {
    const r = this.row("SELECT * FROM lifecycle_journal WHERE operation_id = ?", operationId);
    return r ? { operationId, memberId: r.member_id, projectId: r.project_id, intent: r.intent, phase: r.phase, identity: json(r.terminal_identity_json), runId: r.run_id, deliveryIds: json(r.delivery_ids_json), baseline: r.baseline_json === null ? null : json(r.baseline_json), reason: r.reason, exitCode: r.exit_code, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }

  listPendingLifecycleJournals(): LifecycleJournal[] {
    return this.rows("SELECT operation_id FROM lifecycle_journal WHERE phase IN ('prepared','started','unknown') ORDER BY created_at, rowid").map((r) => this.getLifecycleJournal(r.operation_id)!);
  }

  saveExecutionJournal(entry: ExecutionJournal): void {
    this.transaction(() => {
      const before = this.getExecutionJournal(entry.runId);
      if (before && (before.memberId !== entry.memberId || before.projectId !== entry.projectId || before.identity.sessionGeneration !== entry.identity.sessionGeneration)) throw new ApiError(409, "실행 신원이 다릅니다", "execution_identity_mismatch");
      if (before && (before.phase === "ended" || before.phase === "interrupted") && stableJson(before) !== stableJson(entry)) throw new ApiError(409, "이미 끝난 실행입니다", "execution_finished");
      this.run(`INSERT INTO execution_journal (run_id, member_id, project_id, generation, terminal_identity_json, turn, delivery_ids_json, phase, input_received_at, started_at, last_progress_at, ended_at, result, reason, exit_code, interruption_notified_at, report_requested_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET terminal_identity_json = excluded.terminal_identity_json, turn = excluded.turn, delivery_ids_json = excluded.delivery_ids_json, phase = excluded.phase, input_received_at = excluded.input_received_at, started_at = excluded.started_at, last_progress_at = excluded.last_progress_at, ended_at = excluded.ended_at, result = excluded.result, reason = excluded.reason, exit_code = excluded.exit_code, updated_at = excluded.updated_at`, entry.runId, entry.memberId, entry.projectId, entry.identity.sessionGeneration, JSON.stringify(entry.identity), entry.turn, JSON.stringify(entry.deliveryIds), entry.phase, entry.inputReceivedAt, entry.startedAt, entry.lastProgressAt, entry.endedAt, entry.result, entry.reason, entry.exitCode, entry.interruptionNotifiedAt, entry.reportRequestedAt, entry.createdAt, entry.updatedAt);
      // Z: 턴이 시작하거나 끝나면 그 팀장이 받은 대표 글의 답 상태가 바뀐다.
      this.noteReply(entry.memberId);
    });
  }

  getExecutionJournal(runId: string): ExecutionJournal | null {
    const r = this.row("SELECT * FROM execution_journal WHERE run_id = ?", runId);
    return r ? { runId, memberId: r.member_id, projectId: r.project_id, identity: json(r.terminal_identity_json), turn: r.turn, deliveryIds: json(r.delivery_ids_json), phase: r.phase, inputReceivedAt: r.input_received_at, startedAt: r.started_at, lastProgressAt: r.last_progress_at, endedAt: r.ended_at, result: r.result, reason: r.reason, exitCode: r.exit_code, interruptionNotifiedAt: r.interruption_notified_at, reportRequestedAt: r.report_requested_at, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }

  listPendingExecutions(): ExecutionJournal[] {
    return this.rows("SELECT run_id FROM execution_journal WHERE phase NOT IN ('ended','interrupted') ORDER BY created_at, rowid").map((r) => this.getExecutionJournal(r.run_id)!);
  }

  /**
   * 이 세션 세대에서 입력이 CLI 에 들어간 마지막 실행: 수신·시작이 적혔거나 그 봉투를 CLI 가 받았다(accepted).
   * 곧바로 오류로 끝난 턴은 수신을 적기 전에 끝나 수신 칸이 비어 있을 수 있어 봉투로도 본다. 넣지 못한 실행(거절·결과 모름)은 세지 않는다.
   */
  lastWrittenExecution(memberId: string, generation: number): ExecutionJournal | null {
    const r = this.row(`SELECT e.run_id FROM execution_journal e LEFT JOIN delivery_dispatches d ON d.id = e.run_id
      WHERE e.member_id = ? AND e.generation = ? AND (e.input_received_at IS NOT NULL OR e.started_at IS NOT NULL OR d.transport_state = 'accepted')
      ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`, memberId, generation);
    return r ? this.getExecutionJournal(r.run_id) : null;
  }

  /** 핫픽스 C: 이 세대에서 그 사유로 성공으로 끝났고 결과 보고 확인(report_requested_at)을 아직 하지 않은 실행. 오래된 것부터. */
  listUnreportedRuns(memberId: string, generation: number, reason: string): ExecutionJournal[] {
    return this.rows(`SELECT run_id FROM execution_journal WHERE member_id = ? AND generation = ? AND phase = 'ended' AND result = 'success' AND reason = ? AND report_requested_at IS NULL
      ORDER BY created_at, rowid`, memberId, generation, reason).map(r => this.getExecutionJournal(r.run_id)!).filter(Boolean);
  }

  /** RunnerRecoveryStore.lastWrittenRun: lastWrittenExecution 의 봉투와 그 실행이 끝났는가. */
  lastWrittenRun(memberId: string, generation: number): { dispatch: DeliveryDispatch | null; ended: boolean } | null {
    const run = this.lastWrittenExecution(memberId, generation);
    return run ? { dispatch: this.getDispatch(run.runId), ended: run.phase === "ended" || run.phase === "interrupted" } : null;
  }

  claimExecutionNotice(runId: string, kind: "interruption" | "report", write: () => void): boolean {
    return this.transaction(() => {
      const column = kind === "interruption" ? "interruption_notified_at" : "report_requested_at";
      if (this.db.query(`UPDATE execution_journal SET ${column} = ? WHERE run_id = ? AND ${column} IS NULL`).run(nowIso(), runId).changes !== 1) return false;
      write();
      // 핫픽스 C: 뒤 작업을 남기고 닫힌 실행의 답 상태는 결과 보고 확인 시각으로 '답 쓰는 중'이 끝난다(backgroundAwaiting).
      if (kind === "report") this.noteReply(this.row("SELECT member_id FROM execution_journal WHERE run_id = ?", runId)?.member_id);
      return true;
    });
  }

  // ---- E4: 안쪽 기록의 보존 기한. 대화·결재·할 일·자료·전달 행·활동은 여기서 지우지 않는다 ----
  /**
   * 끝난 지 오래된 안쪽 기록만 정리한다. storage-maintenance 가 한 시간마다 부른다.
   * - 보낸 글 사본(delivery_dispatches.wire_text): 전송이 끝났고(accepted·rejected) 봉투에 든 전달이 모두 끝난(delivered·failed,
   *   복구 none·resolved·stopped) 지 wireTextMs 가 지난 것만 비운다. 봉투 행과 해시는 남긴다: 무엇을 보냈는지의 증거,
   *   재전송 판정(전송 상태·원문 판), 수신 표지는 그대로다. 복구가 사본 글자를 다시 읽는 것은 끝나지 않은 봉투뿐이다.
   * - 실행 기록·생명주기 기록: 끝난(ended·interrupted / confirmed·refused) 지 recordMs 가 지난 것을 지운다. 단 아래는 남긴다.
   *   직원 상태가 읽는 세대별 마지막 행, 전달 대기 판정이 읽는 직원별 마지막 시작 실행, 사용 한도 판정이 읽는 세대별 마지막 입력 실행,
   *   결과 보고 누락 안내가 걸린 실행, 표에서 rowid 가 가장 큰 행(다음 rowid 가 줄어들지 않게).
   * - 영수증: 끝난 operation_receipts, agent_operation_receipts, delivery_recovery_operations 중 recordMs 가 지난 것.
   * 한 번에 batch 행씩 짧은 트랜잭션으로 하고, budgetMs 를 넘기면 남은 것은 다음 정리로 미룬다(complete=false).
   */
  pruneInternalRecords(options: { now?: number; wireTextMs?: number; recordMs?: number; batch?: number; budgetMs?: number; clock?: () => number } = {}): RecordPruneResult {
    const now = options.now ?? Date.now();
    const wireTextMs = options.wireTextMs ?? 30 * 86_400_000, recordMs = options.recordMs ?? 90 * 86_400_000;
    if (!Number.isFinite(now) || now < 0 || !(wireTextMs > 0) || !(recordMs > 0)) throw new Error("Invalid retention time");
    const wireCutoff = new Date(now - wireTextMs).toISOString(), recordCutoff = new Date(now - recordMs).toISOString();
    const batch = Math.max(1, Math.floor(options.batch ?? 500));
    const clock = options.clock ?? (() => performance.now());
    const started = clock(), budgetMs = options.budgetMs ?? 250;
    const result: RecordPruneResult = { wireTexts: 0, executions: 0, lifecycles: 0, receipts: 0, agentReceipts: 0, recoveryOperations: 0, complete: true };
    const steps: [keyof Omit<RecordPruneResult, "complete">, string, SQLQueryBindings[]][] = [
      // 복구 기록이 기한 안에 바뀐 전달(다시 확인·대표 판단)이 든 봉투도 아직 끝난 지 오래된 것이 아니다.
      ["wireTexts", `UPDATE delivery_dispatches SET wire_text = '' WHERE rowid IN (
        SELECT x.rowid FROM delivery_dispatches x
        WHERE x.transport_state IN ('accepted','rejected') AND x.updated_at < ? AND x.wire_text != ''
          AND NOT EXISTS (SELECT 1 FROM delivery_dispatch_items i JOIN deliveries d ON d.id = i.delivery_id
            LEFT JOIN delivery_recovery r ON r.delivery_id = d.id
            WHERE i.dispatch_id = x.id AND (d.status NOT IN ('delivered','failed') OR COALESCE(r.phase, 'none') NOT IN ('none','resolved','stopped')
              OR COALESCE(r.updated_at, '') >= ?))
        ORDER BY x.updated_at LIMIT ?)`, [wireCutoff, wireCutoff]],
      // 실행·생명주기 기록 정리가 기록 수의 제곱으로 느려지지 않게 하는 쓰기 꼴(tests/record-retention.test.ts 가 계획과 시간을 본다):
      // - '더 나중 행'은 (created_at, rowid) 순서다. created_at >= 를 따로 두어야 세대별 색인(member_id, generation, created_at)에서 그 자리부터 찾는다
      //   (OR 만 두면 그 직원의 행을 처음부터 훑는다). +project_id 는 같은 뜻의 조건을 색인 고르기에서만 빼는 표시다.
      // - 기록 표를 보는 EXISTS 안의 LIMIT 1 은 SQLite 가 EXISTS 를 조인으로 바꾸지 못하게 한다. 조인으로 바뀌면 ORDER BY … LIMIT 과 겹쳐
      //   첫 일치에서 멈추지 않아, 2만 줄에서 한 배치가 수 초씩 서버를 멈췄다. 상관 부분 질의로 두면 바깥이 시각 순으로 읽다가 LIMIT 에서 끊긴다.
      ["executions", `DELETE FROM execution_journal WHERE rowid IN (
        SELECT e.rowid FROM execution_journal e
        WHERE e.phase IN ('ended','interrupted') AND e.updated_at < ?
          AND e.rowid < (SELECT MAX(rowid) FROM execution_journal)
          AND EXISTS (SELECT 1 FROM execution_journal n WHERE n.member_id = e.member_id AND n.generation = e.generation AND +n.project_id = e.project_id
            AND n.created_at >= e.created_at AND (n.created_at > e.created_at OR n.rowid > e.rowid) LIMIT 1)
          AND (e.started_at IS NULL OR EXISTS (SELECT 1 FROM execution_journal n
            WHERE n.project_id = e.project_id AND n.member_id = e.member_id AND n.started_at IS NOT NULL AND n.rowid > e.rowid LIMIT 1))
          AND NOT ((e.input_received_at IS NOT NULL OR e.started_at IS NOT NULL
              OR EXISTS (SELECT 1 FROM delivery_dispatches d WHERE d.id = e.run_id AND d.transport_state = 'accepted'))
            AND NOT EXISTS (SELECT 1 FROM execution_journal n LEFT JOIN delivery_dispatches d ON d.id = n.run_id
              WHERE n.member_id = e.member_id AND n.generation = e.generation
                AND (n.input_received_at IS NOT NULL OR n.started_at IS NOT NULL OR d.transport_state = 'accepted')
                AND n.created_at >= e.created_at AND (n.created_at > e.created_at OR n.rowid > e.rowid) LIMIT 1))
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = 'msg_missing_report_' || e.run_id)
        ORDER BY e.updated_at LIMIT ?)`, [recordCutoff]],
      ["lifecycles", `DELETE FROM lifecycle_journal WHERE rowid IN (
        SELECT l.rowid FROM lifecycle_journal l
        WHERE l.phase IN ('confirmed','refused') AND l.updated_at < ?
          AND l.rowid < (SELECT MAX(rowid) FROM lifecycle_journal)
          AND EXISTS (SELECT 1 FROM lifecycle_journal n WHERE n.member_id = l.member_id AND n.generation = l.generation AND +n.project_id = l.project_id
            AND n.created_at >= l.created_at AND (n.created_at > l.created_at OR n.rowid > l.rowid) LIMIT 1)
        ORDER BY l.updated_at LIMIT ?)`, [recordCutoff]],
      ["receipts", `DELETE FROM operation_receipts WHERE rowid IN (
        SELECT rowid FROM operation_receipts WHERE status != 'pending' AND updated_at < ? ORDER BY updated_at LIMIT ?)`, [recordCutoff]],
      ["agentReceipts", `DELETE FROM agent_operation_receipts WHERE rowid IN (
        SELECT rowid FROM agent_operation_receipts WHERE created_at < ? ORDER BY created_at LIMIT ?)`, [recordCutoff]],
      ["recoveryOperations", `DELETE FROM delivery_recovery_operations WHERE rowid IN (
        SELECT rowid FROM delivery_recovery_operations WHERE created_at < ? ORDER BY created_at LIMIT ?)`, [recordCutoff]],
    ];
    for (const [key, sql, params] of steps) {
      const statement = this.db.query(sql);
      for (;;) {
        if (clock() - started > budgetMs) { result.complete = false; return result; }
        const changes = this.transaction(() => statement.run(...params, batch).changes, "immediate");
        result[key] += changes;
        if (changes < batch) break;
      }
    }
    return result;
  }

  // ---- 문맥: nonce는 같은 세대에서 재사용하고 늦은 세대 갱신은 거부한다 ----
  getContextState(memberId: string): StoredContextState | null {
    const r = this.row("SELECT c.* FROM member_context_state c JOIN members m ON m.id = c.member_id AND m.session_generation = c.generation WHERE c.member_id = ?", memberId);
    if (!r) return null;
    try {
      return { memberId, generation: r.generation, bindingNonce: r.binding_nonce, rolloutPath: r.rollout_path, rolloutOffset: r.rollout_offset, measurement: r.measurement_json === null ? null : json(r.measurement_json), compaction: r.compaction_json === null ? null : json(r.compaction_json), baseline: r.baseline_json === null ? null : json(r.baseline_json), updatedAt: r.updated_at };
    } catch { throw new ApiError(409, "문맥 상태를 읽을 수 없어 자동 입력을 보류합니다", "CONTEXT_STATE_CORRUPT"); }
  }

  ensureContextState(memberId: string): StoredContextState {
    return this.transaction(() => {
      const existing = this.getContextState(memberId);
      if (existing) return existing;
      const generation = this.memberRevisions(memberId).sessionGeneration;
      this.run(`INSERT INTO member_context_state (member_id, generation, binding_nonce, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(member_id) DO UPDATE SET generation = excluded.generation, binding_nonce = excluded.binding_nonce, rollout_path = NULL, rollout_offset = 0, measurement_json = NULL, compaction_json = NULL, baseline_json = NULL, updated_at = excluded.updated_at`, memberId, generation, crypto.randomUUID().replaceAll("-", ""), nowIso());
      return this.getContextState(memberId)!;
    });
  }

  saveContextState(state: StoredContextState, memberPatch: Pick<MemberPatch, "contextPct" | "contextWindow" | "contextWindowSource"> = {}): void {
    this.transaction(() => {
      this.checkRevision(this.memberRevisions(state.memberId).sessionGeneration, state.generation);
      const before = this.ensureContextState(state.memberId);
      if (before.bindingNonce !== state.bindingNonce || (state.measurement && state.measurement.sessionGeneration !== state.generation)) throw new ApiError(409, "문맥 세대가 변경되었습니다", "context_generation_changed");
      this.run("UPDATE member_context_state SET rollout_path = ?, rollout_offset = ?, measurement_json = ?, compaction_json = ?, baseline_json = ?, updated_at = ? WHERE member_id = ? AND generation = ? AND binding_nonce = ?", state.rolloutPath, state.rolloutOffset, state.measurement === null ? null : JSON.stringify(state.measurement), state.compaction === null ? null : JSON.stringify(state.compaction), state.baseline === null ? null : JSON.stringify(state.baseline), nowIso(), state.memberId, state.generation, state.bindingNonce);
      if (Object.keys(memberPatch).length) this.patchMember(state.memberId, memberPatch);
      else this.emitMember(state.memberId);
    });
  }

  getDecisionFollowUp(id: string): DecisionCloseFollowUp | null {
    this.requireDecision(id);
    const r = this.row("SELECT follow_up_json FROM decisions WHERE id = ?", id)!;
    return r.follow_up_json === null ? null : json(r.follow_up_json);
  }

  setDecisionFollowUp(id: string, followUp: DecisionCloseFollowUp): void {
    this.transaction(() => {
      const decision = this.requireDecision(id);
      if (followUp.kind === "instruction") {
        const source = "sourceMessageId" in followUp ? this.requireMessage(followUp.sourceMessageId) : this.requireDecision(followUp.sourceDecisionId);
        if (this.requireMember(followUp.memberId).projectId !== decision.projectId || source.projectId !== decision.projectId) throw new ApiError(400, "후속 지시의 프로젝트가 다릅니다", "follow_up_project_mismatch");
      }
      const before = this.getDecisionFollowUp(id);
      if (before !== null && stableJson(before) !== stableJson(followUp)) throw new ApiError(409, "이미 기록된 후속 지시가 다릅니다", "follow_up_conflict");
      this.run("UPDATE decisions SET follow_up_json = ? WHERE id = ?", JSON.stringify(followUp), id);
    });
  }

  // ---- board 검토와 보고 출처 ----
  boardRevision(projectId: string): number {
    this.requireProject(projectId);
    return this.row("SELECT board_revision FROM projects WHERE id = ?", projectId)!.board_revision;
  }

  private bumpBoard(projectId: string): void {
    this.run("UPDATE projects SET board_revision = board_revision + 1 WHERE id = ?", projectId);
  }

  requestBoardReview(projectId: string, at = nowIso()): BoardReview {
    this.requireProject(projectId);
    this.run("UPDATE projects SET board_requested_revision = board_revision, board_requested_at = ? WHERE id = ?", at, projectId);
    return this.getBoardReview(projectId)!;
  }

  getBoardReview(projectId: string): BoardReview | null {
    this.requireProject(projectId);
    const r = this.row("SELECT * FROM projects WHERE id = ?", projectId)!;
    return r.board_requested_revision === null ? null : { requestedRevision: r.board_requested_revision, reviewedRevision: r.board_reviewed_revision, requestedAt: r.board_requested_at, completedAt: r.board_completed_at };
  }

  completeBoardReview(projectId: string, requestedRevision: number, reviewedRevision: number, at = nowIso()): void {
    this.transaction(() => {
      const review = this.getBoardReview(projectId);
      if (!review || review.requestedRevision !== requestedRevision || reviewedRevision < 0 || reviewedRevision > requestedRevision || !Number.isSafeInteger(reviewedRevision)) throw new ApiError(409, "검토한 업무판이 변경되었습니다", "board_changed");
      this.run("UPDATE projects SET board_completed_revision = ?, board_reviewed_revision = ?, board_completed_at = ? WHERE id = ?", requestedRevision, reviewedRevision, at, projectId);
    });
  }

  saveReportReferences(projectId: string, refs: ReportReferences): void {
    this.transaction(() => {
      if (this.requireMessage(refs.sourceMessageId).projectId !== projectId || (refs.correctsMessageId && this.requireMessage(refs.correctsMessageId).projectId !== projectId)) throw new ApiError(400, "다른 프로젝트의 메시지입니다", "message_other_project");
      for (const id of refs.fileIds) if (this.fileProjectId(id) !== projectId) throw new ApiError(400, "자료의 프로젝트가 다릅니다", "file_other_project");
      for (const id of refs.decisionIds) if (this.requireDecision(id).projectId !== projectId) throw new ApiError(400, "결재의 프로젝트가 다릅니다", "decision_other_project");
      const before = this.getReportReferences(projectId, refs.sourceMessageId);
      if (before) {
        if (stableJson(before) !== stableJson(refs)) throw new ApiError(409, "이미 기록된 보고 출처가 다릅니다", "report_source_conflict");
        return;
      }
      if (refs.correctsMessageId) {
        const original = this.requireMessage(refs.correctsMessageId), replacement = this.requireMessage(refs.sourceMessageId);
        if (!replacement.memberId || original.memberId !== replacement.memberId || original.mine || replacement.mine || original.id === replacement.id) throw new ApiError(400, "자신이 작성한 보고만 정정할 수 있습니다", "report_not_own");
        if (original.supersededBy) throw new ApiError(409, "이미 정정된 보고입니다. 최신 보고를 정정하세요", "report_already_corrected");
      }
      this.run("INSERT INTO report_references (source_message_id, project_id, file_ids_json, decision_ids_json, authored_at, sequence, corrects_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)", refs.sourceMessageId, projectId, JSON.stringify(refs.fileIds), JSON.stringify(refs.decisionIds), refs.authoredAt, refs.sequence, refs.correctsMessageId);
      if (refs.correctsMessageId) this.afterCommit(() => this.bus.emit({ type: "message", message: this.requireMessage(refs.correctsMessageId!) }));
    });
  }

  getReportReferences(projectId: string, messageId: string): ReportReferences | null {
    const prefetched = this.deliveryRead?.projectId === projectId ? this.deliveryRead.reportRefs.get(messageId) : undefined;
    const r = prefetched !== undefined ? prefetched : this.row("SELECT * FROM report_references WHERE project_id = ? AND source_message_id = ?", projectId, messageId);
    return r ? { sourceMessageId: r.source_message_id, fileIds: json(r.file_ids_json), decisionIds: json(r.decision_ids_json), authoredAt: r.authored_at, sequence: r.sequence, correctsMessageId: r.corrects_message_id } : null;
  }

  // ---- manual ACK 전 batch 재조회. askWait도 이 소비 경계를 사용한다 ----
  manualInbox(memberId: string, deliveryIds?: string[]): ManualInboxBatch | null {
    return this.transaction(() => {
      const member = this.requireMember(memberId);
      if (this.requireProject(member.projectId).archived) return null;
      const existing = this.row("SELECT id FROM manual_inbox_batches WHERE member_id = ? AND acknowledged_at IS NULL", memberId);
      if (existing) return this.getManualInboxBatch(memberId, existing.id);
      const deliveries = deliveryIds === undefined ? this.listPending(memberId) : deliveryIds.map((id) => this.requireDelivery(id));
      if (!deliveries.length) return null;
      const id = newId("batch_");
      this.run("INSERT INTO manual_inbox_batches (id, member_id, created_at) VALUES (?, ?, ?)", id, memberId, nowIso());
      for (const [ordinal, d] of deliveries.entries()) {
        if (d.memberId !== memberId || d.projectId !== member.projectId || !["queued", "held"].includes(d.status)) throw new ApiError(409, "받을 전달 항목이 변경되었습니다", "inbox_items_changed");
        this.run("INSERT INTO manual_inbox_items (batch_id, delivery_id, ordinal) VALUES (?, ?, ?)", id, d.id, ordinal);
      }
      return this.getManualInboxBatch(memberId, id);
    });
  }

  getManualInboxBatch(memberId: string, batchId: string): ManualInboxBatch | null {
    const batch = this.row("SELECT * FROM manual_inbox_batches WHERE id = ? AND member_id = ?", batchId, memberId);
    if (!batch) return null;
    return { id: batchId, memberId, createdAt: batch.created_at, items: this.rows("SELECT d.* FROM manual_inbox_items i JOIN deliveries d ON d.id = i.delivery_id WHERE i.batch_id = ? ORDER BY i.ordinal", batchId).map((d) => ({ deliveryId: d.id, text: d.text, ref: d.ref_type && d.ref_id ? { type: d.ref_type, id: d.ref_id } : null })) };
  }

  acknowledgeManualInbox(memberId: string, batchId: string): { batchId: string; acknowledged: true } {
    return this.transaction(() => {
      const member = this.requireMember(memberId);
      if (this.requireProject(member.projectId).archived) throw new ApiError(409, "보관 중에는 지시를 소비할 수 없습니다", "inbox_archived");
      const batch = this.getManualInboxBatch(memberId, batchId);
      if (!batch) throw new ApiError(404, "수신 묶음을 찾을 수 없습니다", "inbox_batch_not_found");
      const r = this.row("SELECT acknowledged_at FROM manual_inbox_batches WHERE id = ?", batchId)!;
      if (r.acknowledged_at !== null) return { batchId, acknowledged: true };
      for (const item of batch.items) {
        this.markDelivered(item.deliveryId);
        if (item.ref?.type === "decision" && this.getDecision(item.ref.id)?.status === "answered") this.setDecisionStatus(item.ref.id, "delivered");
        if (item.ref?.type === "message" && this.getMessage(item.ref.id)) this.setMessageDelivery(item.ref.id, "delivered");
      }
      this.run("UPDATE manual_inbox_batches SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL", nowIso(), batchId);
      return { batchId, acknowledged: true };
    });
  }
}

/** E4: 보존 기한 정리 한 번의 결과. complete=false 면 시간 예산을 다 써서 남은 것은 다음 정리 때 한다. */
export interface RecordPruneResult {
  /** 비운 보낸 글 사본(봉투 행은 남는다). */
  wireTexts: number;
  executions: number;
  lifecycles: number;
  receipts: number;
  agentReceipts: number;
  recoveryOperations: number;
  complete: boolean;
}
