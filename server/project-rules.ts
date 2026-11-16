// 0.2.7 묶음 5(D5-5): 대표 상시 규칙.
// 대표가 대화로 "앞으로 늘 이렇게"라고 정한 일하는 방식을 총괄(본사는 본사 AI)이 `rule` 도구로 프로젝트에 남긴다.
// - 더하기·빼기는 그렇게 정한 대표 원문(user_quote)이 서버 대조(findQuoteSource)로 맞을 때만 된다. 버튼 글·아주 짧은 글은 근거가 못 된다.
// - 남은 규칙은 그 프로젝트에서 새로 여는 모든 세션의 지침 끝(roles.ts ownerRulesSection)에 실린다.
// - 이미 떠 있는 세션은 시스템 프롬프트를 다시 읽지 않는다. 그래서 바뀌면 잠들지 않은 세션마다 '알릴 것'을 적어 두고(project_rule_notices),
//   그 세션에 다음 봉투를 실제로 보낼 때 바뀐 것과 지금 규칙 전체를 깨우지 않는 시스템 글 한 건으로 만들어 같은 봉투에 싣는다(takeRuleNotice).
//   압축 뒤(서버가 시킨 압축, Claude 가 쉬는 동안 스스로 한 압축)에도 같은 길로 지금 목록을 다시 싣는다(요약에서 흐려지지 않게).
//   묶음 5 검토: 처음에는 대기열에 깨우지 않는 글로 바로 넣었는데, 다음 깨우는 지시가 올 때까지 쉬는 팀장마다 대기열 수가 1로 남아
//   앱에 '대기열 1'이 뜨고 AI CLI 전환이 막히며, 서버가 총괄에게 '잠재울 수 있는 직원이 없다'고 알렸다.
//   직접 붙인 세션(iamceo join)은 서버가 봉투를 보내지 않고 wait 로 받아 가므로 예전처럼 대기열에 바로 넣는다.
// 표는 db.ts PROJECT_RULES_TABLES(판 번호를 올리지 않는 보조 표)다.
import type { Database } from "bun:sqlite";
import type { Delivery, Member } from "../shared/types.ts";
import { ensureProjectRules, newId, nowIso } from "./db.ts";
import { formatSystem, normalizeSpace, quotedInline, quoteNeedsContext, type QuoteSource } from "./delivery-text.ts";
import { josa, ownerRulesLines, type OwnerRuleLine } from "./roles.ts";
import { ApiError, type Store } from "./store.ts";

/** 프로젝트마다 살아 있는 규칙 수의 한도. 지침이 끝없이 길어지지 않게 한다. */
export const MAX_PROJECT_RULES = 30;
/** 규칙 한 줄의 길이 한도(도구 스키마와 같다). */
export const RULE_TEXT_MAX = 300;
/** 지침과 알림에 싣는 대표 원문의 길이 한도. 넘으면 잘라 '…'을 붙인다(원문 전체는 출처 id 로 찾는다). */
const RULE_QUOTE_MAX = 500;

export interface ProjectRule extends OwnerRuleLine {
  projectId: string;
  /** 대조로 찾은 대표 글(메시지·결재·할 일·프로젝트 목표)의 id. */
  sourceId: string | null;
  sourceAt: string | null;
  /** 남긴 세션의 화면 이름. */
  addedBy: string;
  createdAt: string;
}

type Row = Record<string, string | null>;

function toRule(r: Row): ProjectRule {
  return { id: r.id!, projectId: r.project_id!, text: r.text!, quote: r.quote!, sourceId: r.source_id ?? null, sourceAt: r.source_at ?? null, addedBy: r.added_by!, createdAt: r.created_at! };
}

/** 규칙 본문을 견주는 열쇠. 공백·대소문자만 다른 같은 규칙을 두 번 남기지 않는다. */
function sameText(a: string, b: string): boolean {
  return normalizeSpace(a).toLowerCase() === normalizeSpace(b).toLowerCase();
}

function clipQuote(text: string): string {
  const one = normalizeSpace(text);
  return one.length > RULE_QUOTE_MAX ? `${one.slice(0, RULE_QUOTE_MAX)}…` : one;
}

export class ProjectRuleBook {
  private ready: boolean | null = null;
  constructor(private readonly db: Database) {}

  /** 표를 쓸 수 있는가. openDb 가 만들지만, 이주 도중의 DB 를 바로 넘겨받은 경우에도 쓸 수 있게 없으면 만든다. */
  available(): boolean {
    if (this.ready !== true) this.ready = ensureProjectRules(this.db);
    return this.ready;
  }

  /** 살아 있는 규칙(남긴 순서). 표를 쓸 수 없으면 빈 목록(지침에 싣지 않는다). */
  list(projectId: string): ProjectRule[] {
    if (!this.available()) return [];
    return this.db.query<Row, [string]>("SELECT * FROM project_rules WHERE project_id = ? AND removed_at IS NULL ORDER BY created_at, rowid").all(projectId).map(toRule);
  }

  get(projectId: string, id: string): ProjectRule | null {
    if (!this.available()) return null;
    const row = this.db.query<Row, [string, string]>("SELECT * FROM project_rules WHERE id = ? AND project_id = ? AND removed_at IS NULL").get(id, projectId);
    return row ? toRule(row) : null;
  }

  /** 프로젝트 내보내기용: 뺀 규칙까지 모든 행(남긴 순서). */
  exportRows(projectId: string): Record<string, string | null>[] {
    if (!this.available()) return [];
    return this.db.query<Row, [string]>("SELECT id, text, quote, source_id, source_at, added_by, created_at, removed_at, removed_by, remove_quote FROM project_rules WHERE project_id = ? ORDER BY created_at, rowid").all(projectId);
  }

  add(input: { projectId: string; text: string; quote: string; source: QuoteSource; addedBy: string }): ProjectRule {
    this.requireStorage();
    const live = this.list(input.projectId);
    const text = normalizeSpace(input.text);
    const same = live.find((rule) => sameText(rule.text, text));
    if (same) throw new ApiError(409, `같은 상시 규칙이 이미 있습니다 #${same.id}: ${same.text}`, "rule_duplicate");
    if (live.length >= MAX_PROJECT_RULES) throw new ApiError(409, `상시 규칙은 프로젝트마다 ${MAX_PROJECT_RULES}개까지입니다. rule(list)로 보고 낡은 규칙을 먼저 빼세요`, "rule_limit");
    const rule: ProjectRule = { id: newId("r_"), projectId: input.projectId, text, quote: clipQuote(input.quote), sourceId: input.source.id, sourceAt: input.source.at ?? null, addedBy: input.addedBy, createdAt: nowIso() };
    this.db.query("INSERT INTO project_rules (id, project_id, text, quote, source_id, source_at, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(rule.id, rule.projectId, rule.text, rule.quote, rule.sourceId, rule.sourceAt, rule.addedBy, rule.createdAt);
    return rule;
  }

  remove(input: { projectId: string; id: string; quote: string; removedBy: string }): ProjectRule {
    this.requireStorage();
    const rule = this.get(input.projectId, input.id);
    if (!rule) throw new ApiError(404, `이 프로젝트의 상시 규칙을 찾을 수 없습니다: ${input.id}. rule(list)로 id 를 보세요`, "rule_not_found");
    this.db.query("UPDATE project_rules SET removed_at = ?, removed_by = ?, remove_quote = ? WHERE id = ?").run(nowIso(), input.removedBy, clipQuote(input.quote), rule.id);
    return rule;
  }

  private requireStorage(): void {
    if (!this.available()) throw new ApiError(503, "대표 상시 규칙 표를 쓸 수 없어 규칙을 바꾸지 못했습니다. 잠시 뒤 다시 시도하세요", "storage_io");
  }
}

const books = new WeakMap<Database, ProjectRuleBook>();

/** 이 저장소의 규칙 책(같은 DB 면 같은 것). */
export function projectRules(store: Pick<Store, "db">): ProjectRuleBook {
  let book = books.get(store.db);
  if (!book) { book = new ProjectRuleBook(store.db); books.set(store.db, book); }
  return book;
}

/** `rule` 도구가 쓰는 오케스트레이터의 몫. */
export interface RuleToolHost {
  readonly store: Store;
  findQuoteSource(projectId: string, rawQuote: string): QuoteSource | null;
}

export type RuleChange =
  | { action: "add"; text: string; userQuote?: string }
  | { action: "remove"; id: string; userQuote?: string };

/** 대표 원문 대조. 맞지 않거나 버튼 글·아주 짧은 글이면 거절한다(결재 닫기의 decided 와 같은 기준). */
function requireOwnerQuote(host: RuleToolHost, projectId: string, raw: string | undefined): { quote: string; source: QuoteSource } {
  const quote = raw?.trim() ?? "";
  if (!quote) throw new ApiError(400, "상시 규칙을 더하거나 빼려면 user_quote 에 대표가 그렇게 정한 말을 글자 그대로 실어야 합니다", "rule_quote_required");
  const source = host.findQuoteSource(projectId, quote);
  if (!source) throw new ApiError(403, "인용을 대표 글에서 찾지 못해 상시 규칙을 바꾸지 않았습니다. 대표가 쓴 문장을 고치거나 요약하지 말고 그대로 실으세요", "rule_quote_not_found");
  if (quoteNeedsContext({ text: quote, verified: true, source })) throw new ApiError(403, "버튼 글이나 아주 짧은 글은 상시 규칙의 근거가 못 되어 바꾸지 않았습니다. 대표가 그렇게 정한 문장을 실으세요", "rule_quote_weak");
  return { quote, source };
}

/** 깨어 있는 세션에 보내는 규칙 글에도 지침 절과 같은 안전 줄을 싣는다(세션 중간에 바뀐 규칙이 승인 규칙을 넓히지 않게, 묶음 5 검토). */
const RULE_GUARD = "지침의 승인 규칙을 넓히지 않는다(승인이 필요한 일은 규칙이 있어도 그때마다 묻는다). 규칙과 대표 원문의 뜻이 다르면 원문을 따른다.";

type NoticeKind = "add" | "remove" | "compacted";

/** 이 세션에 다음 봉투와 함께 알릴 것을 적는다. 압축 뒤 알림은 이미 적혀 있으면 또 적지 않는다. */
function noteRuleNotice(db: Database, member: Member, kind: NoticeKind, ruleId: string | null): void {
  if (kind === "compacted" && db.query("SELECT 1 FROM project_rule_notices WHERE member_id = ? AND kind = 'compacted'").get(member.id)) return;
  db.query("INSERT INTO project_rule_notices (member_id, project_id, kind, rule_id, created_at) VALUES (?, ?, ?, ?, ?)").run(member.id, member.projectId, kind, ruleId, nowIso());
}

/** 직접 붙인 세션에 바로 넣는 알림(wait 로 받아 간다). 바뀐 것 한 건과 안전 줄. */
function manualNoticeText(kind: "add" | "remove", rule: ProjectRule, quote: string, actor: Member): string {
  const quoted = `"${quotedInline(rule.text)}"`;
  return kind === "add"
    ? formatSystem(`대표 상시 규칙이 하나 늘었습니다 #${rule.id}: ${quoted} (대표 원문 "${quotedInline(quote)}", ${josa(actor.name, "이")} 남김). 지금부터 이 규칙을 늘 따른다. 하던 일에도 해당되면 지금부터 바꾼다. ${RULE_GUARD}`)
    : formatSystem(`대표 상시 규칙 #${rule.id} ${quoted}를 뺐습니다(대표 원문 "${quotedInline(quote)}", ${josa(actor.name, "이")} 뺌). 지금부터 이 규칙은 따르지 않는다.`);
}

/** `rule` 도구. add·remove 는 저장과 알릴 것 적기를 한 트랜잭션으로 한다. 결과는 총괄에게 돌려줄 한 줄. */
export function changeProjectRule(host: RuleToolHost, actor: Member, change: RuleChange): string {
  const book = projectRules(host.store);
  const project = host.store.requireProject(actor.projectId);
  const { quote, source } = requireOwnerQuote(host, project.id, change.userQuote);
  const { rule, notified, asleep } = host.store.transaction(() => {
    const rule = change.action === "add"
      ? book.add({ projectId: project.id, text: change.text, quote, source, addedBy: actor.name })
      : book.remove({ projectId: project.id, id: change.id, quote, removedBy: actor.name });
    let notified = 0, asleep = 0;
    for (const member of host.store.listMembers(project.id)) {
      if (member.id === actor.id) continue;
      // 잠든 세션은 다음에 열 때 지침 파일로 받는다. 적어 두면 깨울 때 같은 말을 두 번 읽는다.
      if (member.status === "asleep") { asleep++; continue; }
      if (member.origin === "manual") host.store.enqueue({ projectId: project.id, memberId: member.id, kind: "system", text: manualNoticeText(change.action, rule, change.action === "add" ? rule.quote : clipQuote(quote), actor), wake: false });
      else noteRuleNotice(host.store.db, member, change.action, rule.id);
      notified++;
    }
    return { rule, notified, asleep };
  });
  const verb = change.action === "add" ? "남겼습니다" : "뺐습니다";
  const reach = notified || asleep
    ? ` 깨어 있는 ${notified}명에게는 다음 입력과 함께 알리고, 잠든 ${asleep}명은 다음에 열 때 지침에 들어 있습니다. 직원마다 따로 전하지 마세요`
    : " 이 프로젝트의 세션이 새로 열릴 때 지침에 들어 있습니다";
  return `상시 규칙 #${rule.id} 를 ${verb}.${reach}${change.action === "add" ? ". 대표에게 상시 규칙으로 남겼다고 한 줄 알리세요" : ""}`;
}

/** `rule`(list) 결과. */
export function listProjectRules(store: Pick<Store, "db">, projectId: string): string {
  return JSON.stringify(projectRules(store).list(projectId).map((r) => ({ id: r.id, text: r.text, quote: r.quote, addedBy: r.addedBy, createdAt: r.createdAt })));
}

/**
 * 압축이 끝난 세션에 지금 규칙 목록을 다음 봉투와 함께 다시 알리게 적는다. 규칙이 없으면 적지 않는다.
 * 서버가 띄운 세션의 시스템 프롬프트(지침)는 압축에도 남지만, 띄운 뒤 바뀐 규칙은 알림 글로만 받았으므로 요약에서 흐려질 수 있다.
 */
export function noteRulesAfterCompact(store: Pick<Store, "db">, member: Member): void {
  if (member.origin === "manual") return;
  const book = projectRules(store);
  if (!book.list(member.projectId).length) return;
  noteRuleNotice(store.db, member, "compacted", null);
}

/**
 * 적어 둔 알릴 것이 있으면 한 건의 시스템 글(바뀐 것 + 지금 규칙 전체 + 안전 줄)로 만든다. 없거나 알릴 것이 없으면 null.
 * 규칙이 하나도 없는데 압축 뒤 알림만 적혀 있으면 알릴 것이 없다.
 */
export function ruleNoticeText(store: Pick<Store, "db">, projectId: string, notes: { kind: string; ruleId: string | null }[]): string | null {
  const book = projectRules(store);
  if (!notes.length || !book.available()) return null;
  const rows = new Map<string, Row>();
  for (const note of notes) {
    if (!note.ruleId || rows.has(note.ruleId)) continue;
    const row = store.db.query<Row, [string, string]>("SELECT * FROM project_rules WHERE id = ? AND project_id = ?").get(note.ruleId, projectId);
    if (row) rows.set(note.ruleId, row);
  }
  const changes = notes.flatMap((note) => {
    const row = note.ruleId ? rows.get(note.ruleId) : undefined;
    if (!row) return [];
    const text = `"${quotedInline(normalizeSpace(row.text!))}"`;
    if (note.kind === "add") return [`- 더함 #${row.id}: ${text} (대표 원문 "${quotedInline(row.quote!)}", ${josa(row.added_by!, "이")} 남김)`];
    if (note.kind === "remove") return [`- 뺌 #${row.id}: ${text} (대표 원문 "${quotedInline(row.remove_quote ?? "")}", ${josa(row.removed_by ?? "총괄", "이")} 뺌)`];
    return [];
  });
  const lines = ownerRulesLines(book.list(projectId));
  if (!changes.length && !lines.length) return null;
  const head = changes.length
    ? `대표 상시 규칙이 바뀌었습니다:\n${changes.join("\n")}`
    : "압축 뒤 이 프로젝트의 대표 상시 규칙을 다시 보냅니다.";
  const body = lines.length
    ? `지금 이 프로젝트의 대표 상시 규칙 전체다. 지침 끝의 것과 다르면 이 목록이 지금 것이다. 늘 따르고, 하던 일에도 해당되면 지금부터 바꾼다. ${RULE_GUARD}\n${lines.join("\n")}`
    : "이제 남은 대표 상시 규칙은 없다. 지침 끝의 '대표 상시 규칙'은 더 따르지 않는다.";
  return formatSystem(`${head}\n${body}`);
}

/**
 * 이 세션에 지금 봉투를 보내려 할 때 부른다. 적어 둔 알릴 것을 지우고, 알릴 것이 있으면 깨우지 않는 시스템 글 한 건을 대기열에 넣어 돌려준다(같은 봉투에 싣는다).
 * 직접 붙인 세션은 여기를 지나지 않는다(바로 넣었다).
 */
export function takeRuleNotice(store: Store, member: Member): Delivery | null {
  const book = projectRules(store);
  if (!book.available()) return null;
  return store.transaction(() => {
    const notes = store.db.query<{ kind: string; rule_id: string | null }, [string]>("SELECT kind, rule_id FROM project_rule_notices WHERE member_id = ? ORDER BY id").all(member.id);
    if (!notes.length) return null;
    store.db.query("DELETE FROM project_rule_notices WHERE member_id = ?").run(member.id);
    const text = ruleNoticeText(store, member.projectId, notes.map((n) => ({ kind: n.kind, ruleId: n.rule_id })));
    return text ? store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "system", text, wake: false }) : null;
  });
}

/** 지금 적혀 있는 알릴 것(시험·진단용). */
export function pendingRuleNotices(store: Pick<Store, "db">, memberId: string): { kind: string; ruleId: string | null }[] {
  if (!projectRules(store).available()) return [];
  return store.db.query<{ kind: string; rule_id: string | null }, [string]>("SELECT kind, rule_id FROM project_rule_notices WHERE member_id = ? ORDER BY id").all(memberId).map((n) => ({ kind: n.kind, ruleId: n.rule_id }));
}
