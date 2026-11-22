// 0.2.10 자료 판 잇기: 제목 정규화, 자동 잇기 규칙, 일회성 정리(iamceo files tidy)의 계획.
// 순수 함수만 둔다. DB 읽기·쓰기는 store.ts(createFile 의 자동 잇기, tidy 적용·되돌리기)가 한다.
// 원칙: 놓친 잇기는 자료함이 조금 어수선할 뿐이지만, 잘못 이은 판은 다른 자료를 '이전 판' 아래로 숨긴다. 애매하면 잇지 않는다.
import { createHash } from "node:crypto";

const DAY = 86_400_000;
/** 판 표시가 있는 제목을 이을 때 앞 판이 이만큼 안에 올라왔어야 한다(실측: 앞뒤 판 간격 중앙값 0.18시간, 최대 99시간). */
export const VERSION_WINDOW_MS = 14 * DAY;
/** 판 표시 없이 같은 제목으로 다시 올린 자료를 이을 때의 창(역할 규칙이 '새 판은 같은 제목으로'라고 가르친다). */
export const SAME_TITLE_WINDOW_MS = 14 * DAY;
/** 판 표시 없이 같은 제목으로 다시 올렸을 때 잇는 종류. 사진·영상·소리는 '화면 캡처'처럼 흔한 제목이 많아 잇지 않는다. */
const SAME_TITLE_KINDS = new Set(["artifact", "document", "table", "code", "pdf", "file"]);

const H = "\\uac00-\\ud7a3"; // 한글 음절
const NUM = "\\d+(?:\\.\\d+)*";

/** 판 번호가 있는 표시. 첫 무리에서 번호를 읽는다(판 번호가 거꾸로 가는지 본다). */
const NUMBERED: RegExp[] = [
  new RegExp(`(?<![0-9a-z])(?:v|ver|version|rev)\\.?\\s?(${NUM})(?![0-9a-z])`, "g"), // v12 V3 v1.2 ver 2 rev3
  new RegExp(`새\\s?판\\s?\\(?\\s?(\\d+)\\s?\\)?`, "g"), // 새 판 4, 새판(4)
  new RegExp(`(?<![0-9${H}])제?(\\d+)\\s?판(?![${H}])`, "g"), // 3판 제3판 (판매·판단 아님)
  new RegExp(`(?<![${H}])판\\s?(\\d+)(?![0-9])`, "g"), // 판 3, 판3
  new RegExp(`(?<![0-9])(\\d+)\\s?차\\s?(?:시안|수정본?|안|본|판)(?![${H}])`, "g"), // 2차 시안, 3차안 (1차 기출·2차 회의 아님)
  new RegExp(`버전\\s?(\\d+)(?![0-9])|(?<![0-9])(\\d+)\\s?버전(?![${H}])`, "g"), // 버전 2, 2버전
];
/** 번호 없는 판 표시. 어디에 있어도 판 표시인 것. */
const ANYWHERE: RegExp[] = [
  /[(\[]\s*최신\s*[)\]]/g, // (최신) [최신]
  /최신\s?(?:판|본)/g,
  new RegExp(`(?<![${H}])새\\s?판(?![${H}])`, "g"),
  /재\s?수정본?|수정\s?(?:본|판|안)|개정\s?(?:판|본)|재작성본|보완본|업데이트\s?본|갱신본/g,
  /최종\s?(?:본|안|판)?|초안/g,
  /(?<![a-z])(?:final|draft|latest|revised)(?![a-z])/g,
];
/** 괄호 안에 홀로 있거나 제목 끝에 있을 때만 판 표시인 낱말('오류 수정 내역'의 수정은 판 표시가 아니다). */
const EDGE_WORDS = "수정|수정됨|재수정|업데이트|갱신|보완|개정|재작성|정정|최신|updated|update|fixed";
const EDGE: RegExp[] = [
  new RegExp(`[(\\[]\\s*(?:${EDGE_WORDS})\\s*[)\\]]`, "g"),
  new RegExp(`(?<=^|[\\s,·\\-–—:;/|])(?:${EDGE_WORDS})\\s*$`, "g"),
];
/** 날짜. 판 표시로 세지 않고 줄기에서만 걷는다. 'M-D' 로 맞춰 비교한다(연도는 버린다). 괄호 밖의 '1-2'는 단원 번호일 수 있어 날짜로 보지 않는다. */
const DATES: RegExp[] = [
  /(?<!\d)(?:20\d{2})\s?[-./년]\s?(\d{1,2})\s?[-./월]\s?(\d{1,2})\s?일?(?!\d)/g, // 2026-11-17, 2026.11.17, 2026년 11월 17일
  /(?<!\d)(\d{1,2})\s?월\s?(\d{1,2})\s?일/g, // 11월 17일
  /(?<=[(\[]\s*)(\d{1,2})\s?[-./]\s?(\d{1,2})(?=\s*[)\],·]|\s)/g, // (11-17) (11/17 기준) [11.17]
];
/** 미리보기·원본 짝은 같은 판이다: 형식 낱말과 '미리보기'·'원본'을 걷는다. */
const ROLE_WORDS = /(?<![a-z])(?:pptx|ppt|keynote|key|pdf|docx|doc|xlsx|xls|csv|hwp|html|htm|md|markdown|png|jpe?g|gif|webp|mp4|mov|zip)(?![a-z])|미리\s?보기|preview|원본/g;
/** 판이 아니라 '다른 편'을 가리키는 순번(1회·2화·3편·Part 2·Day 3·#4·1주차·2/5). 꼬리에 있으면 줄기로 느슨하게 맞추지 않는다. '12장'처럼 분량을 세는 숫자는 순번이 아니다. */
const ORDINAL = new RegExp(`\\d+\\s?(?:회차|회|화|편|권|부|강|과|번|호|주차|일차|단원|교시|차시|라운드)(?![${H}])|(?<![a-z])(?:part|day|ep|episode|chapter|ch|round|week|session|lesson|unit)\\.?\\s?\\d+|#\\d+|\\d+\\s?/\\s?\\d+`);

/** 비교용 기본형: NFC·소문자·전각 괄호·밑줄을 맞추고 공백을 하나로. */
export function baseTitle(title: string): string {
  return title.normalize("NFC").toLowerCase()
    .replace(/[（【]/g, "(").replace(/[）】]/g, ")")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ").trim();
}

function tidy(t: string): string {
  return t
    .replace(/[(\[]\s*[,·\-–—:;/|+&\s]*\s*[)\]]/g, " ") // 비어 버린 괄호
    .replace(/\(\s*[,·;/+&]?\s*/g, "(").replace(/\s*[,·;/+&]?\s*\)/g, ")")
    .replace(/[\s,·\-–—:;/|_+&]+$/g, "").replace(/^[\s,·\-–—:;/|_+&]+/g, "")
    .replace(/\s+/g, " ").trim();
}

export interface TitleParts {
  /** 판 표시와 날짜를 걷은 제목. */
  key: string;
  /** key 에서 형식 낱말·미리보기·원본까지 걷은 것(자동 잇기의 '같은 제목'). */
  full: string;
  /** full 의 첫 ( [ : — – | ' - ' 앞까지. */
  stem: string;
  /** stem 뒤의 꼬리. */
  tail: string;
  /** 판 표시가 있었는가(날짜는 판 표시가 아니다). */
  marked: boolean;
  /** 걷은 판 표시의 첫 번호(v12 → [12], v1.2 → [1, 2], 3판 → [3]). 없으면 null. */
  version: number[] | null;
  /** 걷은 날짜('M-D'). */
  dates: string[];
  /** 꼬리에 순번(N회·N화·Part N…)이 있는가. */
  ordinal: boolean;
}

export function titleParts(title: string): TitleParts {
  let t = baseTitle(title);
  const dates: string[] = [];
  for (const re of DATES) {
    t = t.replace(re, (whole, m: string, d: string) => {
      const month = Number(m), day = Number(d);
      if (month < 1 || month > 12 || day < 1 || day > 31) return whole;
      dates.push(`${month}-${day}`);
      return " ";
    });
  }
  let marked = false;
  let version: number[] | null = null;
  for (const re of NUMBERED) {
    t = t.replace(re, (_whole, ...groups: unknown[]) => {
      marked = true;
      const n = groups.slice(0, 2).find((g): g is string => typeof g === "string");
      if (version === null && n !== undefined) version = n.split(".").map(Number);
      return " ";
    });
  }
  for (const re of [...ANYWHERE, ...EDGE]) t = t.replace(re, () => { marked = true; return " "; });
  // 끝의 '수정'을 걷고 나면 또 끝에 판 낱말이 남을 수 있다('… 최종 수정').
  for (const re of EDGE) t = t.replace(re, () => { marked = true; return " "; });
  const key = tidy(t);
  const full = tidy(key.replace(ROLE_WORDS, " "));
  const cut = full.search(/[(:\[—–|]| - /);
  const stem = (cut < 0 ? full : full.slice(0, cut)).trim();
  const tail = cut < 0 ? "" : full.slice(cut);
  return { key, full, stem, tail, marked, version, dates: [...new Set(dates)].sort(), ordinal: ORDINAL.test(tail) };
}

/** 글자 수(한글 음절·영문자 등). 숫자·기호·공백은 세지 않는다. */
export function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

/** 자동 잇기·정리가 보는 자료의 모양(본문·html 은 읽지 않는다). */
export interface ChainFile {
  id: string;
  projectId: string;
  memberId: string | null;
  kind: string | null;
  title: string;
  createdAt: string;
  replaces: string | null;
  replacedBy: string | null;
  /** 같은 시각에 올라온 자료의 순서(files.sort_order). 정리 계획이 같은 밀리초의 자료를 올린 순서대로 본다. */
  order?: number;
}
export type ChainBasis = "marker+full" | "marker+stem" | "same-title";
export type ChainSkip = "no-uploader" | "no-kind" | "no-marker" | "too-short" | "ordinal-tail" | "no-match" | "ambiguous" | "version-went-down" | "same-number-different-tail" | "different-date";
export type ChainVerdict = { chain: true; to: ChainFile; basis: ChainBasis } | { chain: false; why: ChainSkip; candidates?: ChainFile[] };

const MIN_FULL_LETTERS = 3;
const MIN_STEM_LETTERS = 4;

/** 판 번호 비교(1.2 < 1.10). 하나라도 없으면 null. */
export function compareVersions(a: number[] | null, b: number[] | null): number | null {
  if (!a || !b) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function newest(files: readonly ChainFile[]): ChainFile {
  return files.reduce((a, b) => {
    const order = Date.parse(b.createdAt) - Date.parse(a.createdAt) || (b.order ?? 0) - (a.order ?? 0);
    return order >= 0 ? b : a;
  });
}

/** 두 제목의 날짜가 다르면 다른 자료로 본다(주간 보고처럼). 판 번호가 분명히 올라가면 그 날짜는 고친 날로 본다. */
function datesAgree(previous: TitleParts, next: TitleParts): boolean {
  if (!previous.dates.length || !next.dates.length) return true;
  if (previous.dates.join(",") === next.dates.join(",")) return true;
  return compareVersions(next.version, previous.version) === 1;
}

/**
 * 새 자료 next 를 이을 앞 판을 고른다. heads 는 같은 프로젝트의 아직 최신인 판들(순서 무관).
 * 조건: 같은 팀장(member_id)·같은 종류, 앞 판이 아직 최신이고 next 보다 앞서 14일 안.
 * - 판 표시(v12·3판·새 판 4·2차 시안·초안·최종·(최신) 등)가 있으면: 판 표시·날짜·형식 낱말을 걷은 제목(full)이 같은 가장 새 판.
 *   없으면 줄기(stem, 괄호·쌍점 앞)가 같은 판이 꼭 하나일 때만(꼬리에 순번이 없을 때).
 * - 판 표시가 없으면: 사진·영상·소리가 아니고, 제목이 글자 그대로(날짜까지) 같은 가장 새 판.
 * - 판 번호가 거꾸로 가거나, 같은 번호인데 꼬리가 다르거나, 두 제목의 날짜가 다르면 잇지 않는다.
 */
export function pickPrevious(next: ChainFile, heads: readonly ChainFile[]): ChainVerdict {
  if (!next.memberId) return { chain: false, why: "no-uploader" };
  // 종류가 비어 있는 옛 자료(0.1 때)는 본문을 읽어야 종류를 안다. 잇지 않는다.
  if (!next.kind) return { chain: false, why: "no-kind" };
  const at = Date.parse(next.createdAt);
  const p = titleParts(next.title);
  const pool = heads.filter((h) => {
    if (h.id === next.id || h.replacedBy || h.memberId !== next.memberId || (h.kind ?? "") !== (next.kind ?? "")) return false;
    const gap = at - Date.parse(h.createdAt);
    return gap >= 0 && gap <= VERSION_WINDOW_MS;
  });
  if (!p.marked) {
    const exact = baseTitle(next.title);
    if (letterCount(exact) < MIN_STEM_LETTERS) return { chain: false, why: "too-short" };
    if (!SAME_TITLE_KINDS.has(next.kind)) return { chain: false, why: "no-marker" };
    const same = pool.filter((h) => at - Date.parse(h.createdAt) <= SAME_TITLE_WINDOW_MS && baseTitle(h.title) === exact);
    return same.length ? { chain: true, to: newest(same), basis: "same-title" } : { chain: false, why: "no-marker" };
  }
  const parts = new Map(pool.map((h) => [h.id, titleParts(h.title)]));
  const agrees = (h: ChainFile) => datesAgree(parts.get(h.id)!, p);
  const sameFull = letterCount(p.full) >= MIN_FULL_LETTERS ? pool.filter((h) => parts.get(h.id)!.full === p.full) : [];
  const byFull = sameFull.filter(agrees);
  if (byFull.length) {
    const to = newest(byFull);
    if (compareVersions(p.version, parts.get(to.id)!.version) === -1) return { chain: false, why: "version-went-down" };
    return { chain: true, to, basis: "marker+full" };
  }
  if (sameFull.length) return { chain: false, why: "different-date" };
  if (letterCount(p.stem) < MIN_STEM_LETTERS) return { chain: false, why: "too-short" };
  if (p.ordinal) return { chain: false, why: "ordinal-tail" };
  const sameStem = pool.filter((h) => { const q = parts.get(h.id)!; return q.stem === p.stem && !q.ordinal; });
  const byStem = sameStem.filter(agrees);
  if (byStem.length !== 1) {
    if (byStem.length > 1) return { chain: false, why: "ambiguous", candidates: byStem };
    return { chain: false, why: sameStem.length ? "different-date" : "no-match" };
  }
  const to = byStem[0]!;
  const q = parts.get(to.id)!;
  const order = compareVersions(p.version, q.version);
  if (order === -1) return { chain: false, why: "version-went-down" };
  // 같은 판 번호인데 꼬리가 다르면('v1 (오프닝)' 과 'v1 (클로징)') 판이 아니라 다른 부분일 수 있다.
  if (order === 0) return { chain: false, why: "same-number-different-tail" };
  return { chain: true, to, basis: "marker+stem" };
}

export interface TidyLink {
  projectId: string;
  /** 옛 판(이 링크로 replaced_by 가 생긴다). */
  previous: ChainFile;
  /** 새 판(이 링크로 replaces 가 생긴다). */
  next: ChainFile;
  basis: ChainBasis;
}
export interface TidyPlan {
  /** 링크 목록의 지문(앞 12자리). 확인한 계획과 적용하는 계획이 같은지 본다. */
  planId: string;
  links: TidyLink[];
  /** 잇지 않은 판 표시 있는 자료의 까닭별 수(판 표시 없는 '새 자료'는 no-marker 로 센다). */
  skipped: Partial<Record<ChainSkip, number>>;
}

/** 일회성 정리의 계획: 오래된 것부터 차례로 들여보내며 자동 잇기와 같은 규칙으로 고른다. 이미 이어진 판은 그대로 둔다. */
export function planTidy(files: readonly ChainFile[]): TidyPlan {
  const sorted = [...files].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  const heads = new Map<string, ChainFile[]>();
  const links: TidyLink[] = [];
  const skipped: Partial<Record<ChainSkip, number>> = {};
  for (const file of sorted) {
    const list = heads.get(file.projectId) ?? [];
    if (file.replaces) {
      const at = list.findIndex((h) => h.id === file.replaces);
      if (at >= 0) list.splice(at, 1);
    } else {
      const verdict = pickPrevious(file, list);
      if (verdict.chain) {
        links.push({ projectId: file.projectId, previous: verdict.to, next: file, basis: verdict.basis });
        list.splice(list.indexOf(verdict.to), 1);
      } else skipped[verdict.why] = (skipped[verdict.why] ?? 0) + 1;
    }
    if (!file.replacedBy) list.push(file);
    heads.set(file.projectId, list);
  }
  return { planId: tidyPlanId(links), links, skipped };
}

export function tidyPlanId(links: readonly { previous: { id: string }; next: { id: string } }[]): string {
  const text = links.map((l) => `${l.previous.id}>${l.next.id}`).sort().join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** 계획을 판 묶음(가족)으로 센다: 가족마다 판 수. 제목은 싣지 않는다. */
export function tidyFamilies(links: readonly TidyLink[]): { projectId: string; ids: string[] }[] {
  const nextOf = new Map(links.map((l) => [l.previous.id, l.next.id]));
  const hasPrevious = new Set(links.map((l) => l.next.id));
  const project = new Map(links.map((l) => [l.previous.id, l.projectId]));
  const families: { projectId: string; ids: string[] }[] = [];
  for (const link of links) {
    if (hasPrevious.has(link.previous.id)) continue;
    const ids = [link.previous.id];
    for (let id = nextOf.get(link.previous.id); id; id = nextOf.get(id)) ids.push(id);
    families.push({ projectId: project.get(link.previous.id)!, ids });
  }
  return families;
}

/** iamceo files tidy 가 보이는 계획 요약. 제목은 showTitles 일 때만 싣는다(기본은 개수만). */
export interface TidyReport {
  planId: string;
  /** 계획에 든 자료 수(보관하지 않은 프로젝트). */
  files: number;
  links: number;
  families: number;
  projects: { id: string; name: string; links: number; families: number; sizes: number[]; titles?: string[][] }[];
  basis: Partial<Record<ChainBasis, number>>;
  skipped: Partial<Record<ChainSkip, number>>;
}

export function tidyReport(plan: TidyPlan, files: readonly ChainFile[], projectNames: ReadonlyMap<string, string>, showTitles = false): TidyReport {
  const families = tidyFamilies(plan.links);
  const titleOf = new Map(files.map((f) => [f.id, f.title]));
  const basis: Partial<Record<ChainBasis, number>> = {};
  for (const link of plan.links) basis[link.basis] = (basis[link.basis] ?? 0) + 1;
  const projectIds = [...new Set(families.map((f) => f.projectId))];
  return {
    planId: plan.planId,
    files: files.length,
    links: plan.links.length,
    families: families.length,
    projects: projectIds.map((id) => {
      const mine = families.filter((f) => f.projectId === id);
      return {
        id, name: projectNames.get(id) ?? id,
        links: plan.links.filter((l) => l.projectId === id).length,
        families: mine.length,
        sizes: mine.map((f) => f.ids.length).sort((a, b) => b - a),
        ...(showTitles ? { titles: mine.map((f) => f.ids.map((fileId) => titleOf.get(fileId) ?? fileId)) } : {}),
      };
    }),
    basis,
    skipped: plan.skipped,
  };
}
