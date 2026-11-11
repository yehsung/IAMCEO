// 기존 운영판(아티팩트) 덤프 JSON → 프로젝트. 아래 입력 타입이 가져오기 필드 형식을 정의한다.
// 어떤 세션도 띄우거나 깨우지 않는다: runnerEnabled=false, 직원은 칸 없는 offline.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { DecisionOption, Member, MessageKind, WorkSec } from "../shared/types.ts";
import { IMPORT_HOLD_NOTE, type Store } from "../server/store.ts";
import { cleanName, cleanRole, MAX_NAME, RESERVED_HANDLES, workerNameProblem } from "../server/text.ts";

type Doc = Record<string, unknown> & { id: string };

export interface ImportOptions {
  /** 없으면 덤프의 meta.board.title, 그것도 없으면 fallbackName. */
  name?: string;
  fallbackName: string;
  cwd: string;
  now?: Date;
}

export interface ImportSummary {
  projectId: string;
  name: string;
  members: number;
  decisions: number;
  answered: number;
  todos: number;
  work: number;
  files: number;
  feed: number;
  userMessages: number;
  heldMessages: number;
}

const HUMAN_TODO_GROUP = "직접 하실 일";
const WORK_SECS: Record<string, WorkSec> = { doing: "doing", todo: "next", hold: "hold", done: "done" };
const FEED_KINDS = new Set<MessageKind>(["완료", "진행", "질문", "막힘", "답변", "알림"]);
const HANDLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** 덤프 도구마다 모양이 다르다: id→필드 맵, {id,...} 배열, {id,data|value:{...}} 문서 배열 모두 받는다. */
export function normalizeCollection(raw: unknown): Doc[] {
  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.map((v, i) => [isRecord(v) ? str(v.id ?? v.key) || String(i) : String(i), v])
    : isRecord(raw)
      ? Object.entries(raw)
      : [];
  const docs: Doc[] = [];
  for (const [id, value] of entries) {
    if (!isRecord(value)) continue;
    const inner = isRecord(value.data) ? value.data : isRecord(value.value) ? value.value : null;
    // 문서의 자체 필드가 겉 포장(updatedAt 등)보다 앞선다. 안쪽이 비어 있을 때만 겉 시각을 쓴다.
    docs.push({ ...(inner ? value : {}), ...(inner ?? value), id });
  }
  return docs;
}

const order = (d: Doc): number => (typeof d.order === "number" ? d.order : 0);
const byOrder = (a: Doc, b: Doc): number => order(a) - order(b);

const KST_OFFSET = "+09:00";

/** ISO 는 그대로, 운영판의 짧은 표기(`10-30`, `10-17 03:10`, KST)는 지금에서 가장 가까운 과거 해로 읽는다. */
export function parseWhen(raw: unknown, now: Date): string | null {
  const text = str(raw).trim();
  if (!text) return null;
  const short = /^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/.exec(text);
  if (short) {
    const [, mm, dd, hh, min] = short;
    const pad = (s: string | undefined, fallback: string) => (s ?? fallback).padStart(2, "0");
    const at = (year: number) => new Date(`${year}-${pad(mm, "")}-${pad(dd, "")}T${pad(hh, "00")}:${pad(min, "00")}:00${KST_OFFSET}`);
    const year = now.getUTCFullYear();
    const parsed = at(year) > now ? at(year - 1) : at(year);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** 운영판 자산(`/_blob/...`)은 로그인 없이 받을 수 없다. http 주소만 그림으로 남기고 나머지는 글로 적는다. */
function imagesMarkdown(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw
    .filter(isRecord)
    .map((img) => {
      const url = str(img.url);
      const caption = str(img.caption);
      return /^https?:\/\//.test(url) ? `![${caption}](${url})` : `(이미지: ${caption || "제목 없음"}, 원본 ${url || "없음"})`;
    })
    .join("\n");
}

function joinBlocks(...blocks: string[]): string {
  return blocks.filter((b) => b.trim()).join("\n\n");
}

function parseOptions(raw: unknown): DecisionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((o) => {
    const k = str(o.k);
    if (!k) return [];
    const desc = str(o.desc);
    return [{ k, label: str(o.label) || k, ...(desc ? { desc } : {}) }];
  });
}

export function importArtifact(store: Store, dump: unknown, opts: ImportOptions): ImportSummary {
  if (!isRecord(dump)) throw new Error("덤프가 JSON 객체가 아닙니다");
  const now = opts.now ?? new Date();
  const metaDocs = normalizeCollection(dump.meta);
  const board = metaDocs.find((d) => d.id === "board");
  const name = opts.name?.trim() || str(board?.title).trim() || opts.fallbackName;
  if (store.listProjects({ includeArchived: true }).some((p) => p.name === name)) {
    throw new Error(`같은 이름의 프로젝트가 이미 있습니다: ${name}. 다른 이름은 --name 으로 줍니다`);
  }

  const run = store.db.transaction((): ImportSummary => {
    const project = store.createProject({ name, cwd: opts.cwd, runnerEnabled: false, now: str(board?.now) });
    const projectId = project.id;
    const summary: ImportSummary = { projectId, name, members: 0, decisions: 0, answered: 0, todos: 0, work: 0, files: 0, feed: 0, userMessages: 0, heldMessages: 0 };

    const members = new Map<string, Member>();
    let spare = 0;
    for (const s of normalizeCollection(dump.sessions).sort(byOrder)) {
      // 예약된 이름·핸들을 그대로 받으면 나중에 총괄이 뜨지 못하거나 대표처럼 보인다. 거부할 수 없는 경로라 바꿔 받는다.
      const handle = HANDLE_RE.test(s.id) && !RESERVED_HANDLES.has(s.id) ? s.id : `s${++spare}`;
      const cleaned = cleanName(str(s.name), cleanName(s.id, handle));
      const memberName = workerNameProblem(cleaned) ? `직원 ${cleaned}`.slice(0, MAX_NAME) : cleaned;
      const queue = str(s.queue).trim();
      const created = store.createMember({ projectId, handle, name: memberName, role: cleanRole(str(s.role)), kind: "worker", origin: "adopted", status: "offline" });
      const member = store.patchMember(created.id, { now: str(s.now), next: queue && queue !== "—" ? `대기열: ${queue}` : "" });
      members.set(memberName, member);
      members.set(str(s.name).trim() || s.id, member);
      members.set(handle, member);
      summary.members++;
    }
    const memberIdOf = (who: string): string | null => members.get(who)?.id ?? null;

    const fileIds = new Map<string, string>();
    for (const d of normalizeCollection(dump.docs).sort(byOrder)) {
      const who = str(d.who);
      const file = store.createFile({
        projectId,
        title: str(d.title) || d.id,
        who,
        memberId: memberIdOf(who),
        summary: str(d.summary),
        body: joinBlocks(str(d.body), imagesMarkdown(d.images)),
        path: str(d.path) || null,
      });
      store.restoreTimes("files", file.id, { createdAt: parseWhen(d.when ?? d.createdAt, now) });
      fileIds.set(d.id, file.id);
      summary.files++;
    }
    const fileIdOf = (ref: unknown): string | null => fileIds.get(str(ref)) ?? null;

    const answers = new Map(normalizeCollection(dump.answers).map((a) => [a.id, a]));
    const decisionIds = new Map<string, string>();
    for (const item of normalizeCollection(dump.items).sort(byOrder)) {
      const who = str(item.who);
      const title = str(item.title) || item.id;
      const group = str(item.group).trim();
      const link = str(item.link) ? `[${str(item.linkLabel) || "링크"}](${str(item.link)})` : "";
      const detail = joinBlocks(str(item.detail), link, imagesMarkdown(item.images));
      const when = parseWhen(item.when ?? item.createdAt, now);
      const sec = str(item.sec);

      if (sec === "decide") {
        const options = parseOptions(item.options);
        const rec = str(item.rec);
        const decision = store.createDecision({
          projectId,
          memberId: memberIdOf(who),
          who,
          title,
          detail,
          options,
          rec: options.some((o) => o.k === rec) ? rec : null,
          group: group || null,
          fileId: fileIdOf(item.docId),
        });
        decisionIds.set(item.id, decision.id);
        summary.decisions++;
        const answer = answers.get(item.id);
        const choice = str(answer?.choice);
        const note = str(answer?.note);
        const known = options.some((o) => o.k === choice);
        let answeredAt: string | null = null;
        if (answer && (known || note)) {
          store.answerDecision(decision.id, { choice: known ? choice : null, note: note || null, batch: answer.batch === true });
          // 옛 총괄이 이미 처리했다. 다시 전달하지 않는다.
          store.setDecisionStatus(decision.id, "delivered");
          answeredAt = parseWhen(answer.at ?? answer.updatedAt, now);
          summary.answered++;
        }
        store.restoreTimes("decisions", decision.id, { createdAt: when, answeredAt, deliveredAt: answeredAt });
        continue;
      }

      if (sec === "todo" && group === HUMAN_TODO_GROUP) {
        const todo = store.createTodo({ projectId, memberId: memberIdOf(who), who, title, detail });
        store.restoreTimes("todos", todo.id, { createdAt: when });
        summary.todos++;
        continue;
      }

      const dateGroup = sec === "done" ? parseWhen(group, now) : null;
      const area = group && !dateGroup ? `영역: ${group}` : "";
      const work = store.upsertWork({ projectId, sec: WORK_SECS[sec] ?? "hold", title, detail: joinBlocks(detail, area, fileIdOf(item.docId) ? `자료: ${item.docId}` : ""), who });
      store.restoreTimes("work", work.id, { createdAt: when, updatedAt: when, doneAt: sec === "done" ? (dateGroup ?? when) : null });
      summary.work++;
    }

    const fallbackAt = parseWhen(board?.asof, now) ?? now.toISOString();
    for (const f of normalizeCollection(dump.feed).sort((a, b) => str(a.at).localeCompare(str(b.at)))) {
      const who = str(f.who);
      const kind = str(f.kind) as MessageKind;
      store.createMessage({
        projectId,
        at: parseWhen(f.at, now) ?? fallbackAt,
        memberId: memberIdOf(who),
        who,
        kind: FEED_KINDS.has(kind) ? kind : "알림",
        title: str(f.title),
        body: joinBlocks(str(f.body), imagesMarkdown(f.images)),
        decisionId: decisionIds.get(str(f.itemId)) ?? null,
        fileId: fileIdOf(f.docId),
      });
      summary.feed++;
    }

    for (const m of normalizeCollection(dump.messages).sort((a, b) => str(a.at).localeCompare(str(b.at)))) {
      const seen = !!str(m.seen);
      store.createMessage({
        projectId,
        at: parseWhen(m.at, now) ?? fallbackAt,
        mine: true,
        who: "나",
        kind: "나",
        body: str(m.text),
        // 옛 총괄이 못 읽은 말은 보류해 둔다. 총괄을 시작하면 그때 전달된다(서버가 재시작해도 같다. store 의 정리가 이 표시를 건너뛴다).
        delivery: seen ? "delivered" : "held",
        deliveryNote: seen ? null : IMPORT_HOLD_NOTE,
      });
      summary.userMessages++;
      if (!seen) summary.heldMessages++;
    }
    return summary;
  });
  return run();
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

export async function runImport(argv: { file: string; name?: string; cwd?: string }): Promise<ImportSummary> {
  const { Bus } = await import("../server/bus.ts");
  const { loadConfig } = await import("../server/config.ts");
  const { openDb } = await import("../server/db.ts");
  const { Store } = await import("../server/store.ts");

  const cwd = resolve(expandHome(argv.cwd ?? homedir()));
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    // 아래에서 같은 오류로 처리한다.
  }
  if (!isDir) throw new Error(`폴더가 없습니다: ${cwd}`);

  let dump: unknown;
  try {
    dump = JSON.parse(readFileSync(argv.file, "utf8"));
  } catch (e) {
    throw new Error(`덤프를 읽을 수 없습니다: ${argv.file} (${(e as Error).message})`);
  }
  const db = openDb(loadConfig().dbPath);
  const summary = importArtifact(new Store(db, new Bus()), dump, { name: argv.name, cwd, fallbackName: basename(argv.file).replace(/\.json$/i, "") });
  db.close();
  return summary;
}

export function describeImport(s: ImportSummary): string {
  return [
    `가져왔습니다: '${s.name}' #${s.projectId} (실행 꺼짐, herdr)`,
    `팀원 ${s.members} · 결재 ${s.decisions}(답 ${s.answered}) · 내 할 일 ${s.todos} · 일 ${s.work} · 자료 ${s.files} · 소식 ${s.feed} · 내 말 ${s.userMessages}(보류 ${s.heldMessages})`,
    "서버가 켜져 있으면 화면을 새로 고치면 보입니다. 총괄을 시작하거나 기존 세션을 편입하기 전에는 어떤 세션도 움직이지 않습니다.",
  ].join("\n");
}

if (import.meta.main) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error("쓰는 법: bun scripts/import-artifact.ts <덤프.json> [--name 이름] [--cwd 폴더]");
    process.exit(1);
  }
  const value = (flag: string) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    console.log(describeImport(await runImport({ file, name: value("--name"), cwd: value("--cwd") })));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
