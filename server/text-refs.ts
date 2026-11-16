// 0.2.6 Y: 서버가 만든 글의 코드·값(shared/server-text.ts)을 DB 열(text_ref)과 응답 필드로 옮긴다.
//
// 저장: 글을 만들 때 보고 언어로 그린 문장은 지금처럼 문장 칸(body·text·title·detail…)에, 코드·값·언어는 text_ref JSON 에.
// 응답: text_ref 를 그 언어로 다시 그려 문장 칸과 같을 때만 코드를 싣는다. 다르면(이전 판 서버가 문장만 고쳤거나, 길어서 잘렸거나,
// 코드 표가 바뀌었으면) 싣지 않는다. 그래서 앱은 받은 코드를 믿고 자기 화면 언어로 다시 그려도 뜻이 어긋나지 않는다.
import type { Decision, DecisionOption } from "../shared/types.ts";
import { ERROR_CODES, type ErrorCode } from "../shared/error-codes.ts";
import { isServerTextRef, mustRender, renderServerText, textLang, textRef, titleCodeOf, type ServerTextRef, type TextLang } from "../shared/server-text.ts";
import { endedByRestart, RESTART_EXIT_NOTE } from "./restart-wake.ts";

export interface OptionTextRefs { label: ServerTextRef; desc?: ServerTextRef }
/** 결재 카드의 글 코드. text 는 detail(제목은 `<코드>.title`), options 는 선택지 키별 이름·설명. */
export interface DecisionTextRefs { text?: ServerTextRef; options?: Record<string, OptionTextRefs>; closeReason?: ServerTextRef; reopenNote?: ServerTextRef }
export interface StoredDecisionTexts extends DecisionTextRefs { lang: TextLang }
interface StoredText { lang: TextLang; code: string; params?: ServerTextRef["params"] }

function parse(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** 한 칸짜리 글(대화 글의 body, 활동 줄의 text)의 저장값. */
export function storedText(ref: ServerTextRef, lang: TextLang): string {
  return JSON.stringify({ lang, code: ref.code, ...(ref.params ? { params: ref.params } : {}) } satisfies StoredText);
}

function readText(raw: unknown): (ServerTextRef & { lang: TextLang }) | null {
  const value = parse(raw);
  if (!value || (value.lang !== "ko" && value.lang !== "en")) return null;
  const ref = { code: value.code, ...(value.params !== undefined ? { params: value.params } : {}) };
  return isServerTextRef(ref) ? { ...ref, lang: value.lang } : null;
}

function same(ref: ServerTextRef, lang: TextLang, text: string | null | undefined): boolean {
  return typeof text === "string" && renderServerText(ref, lang) === text;
}

function fields(ref: ServerTextRef, lang: TextLang): { textCode: string; textParams?: ServerTextRef["params"]; textLang: TextLang } {
  return { textCode: ref.code, ...(ref.params ? { textParams: ref.params } : {}), textLang: lang };
}

/** 대화 글: body 와 (있으면) 제목이 코드로 다시 그린 것과 같을 때만 textCode·textParams·textLang. */
export function messageTextFields(raw: unknown, title: string, body: string) {
  const ref = readText(raw);
  if (!ref || !same(ref, ref.lang, body)) return {};
  const titleCode = titleCodeOf(ref.code);
  if (titleCode ? !same({ code: titleCode, params: ref.params }, ref.lang, title) : title !== "") return {};
  return fields({ code: ref.code, params: ref.params }, ref.lang);
}

/** 활동 줄: text 가 코드로 다시 그린 것과 같을 때만(500자에서 잘린 줄은 코드가 없다). */
export function activityTextFields(raw: unknown, text: string) {
  const ref = readText(raw);
  return ref && same(ref, ref.lang, text) ? fields({ code: ref.code, params: ref.params }, ref.lang) : {};
}

export function storedDecisionTexts(refs: DecisionTextRefs, lang: TextLang): string {
  return JSON.stringify({ lang, ...refs } satisfies StoredDecisionTexts);
}

export function readDecisionTexts(raw: unknown): StoredDecisionTexts | null {
  const value = parse(raw);
  if (!value || (value.lang !== "ko" && value.lang !== "en")) return null;
  const out: StoredDecisionTexts = { lang: value.lang };
  if (isServerTextRef(value.text)) out.text = value.text;
  if (isServerTextRef(value.closeReason)) out.closeReason = value.closeReason;
  if (isServerTextRef(value.reopenNote)) out.reopenNote = value.reopenNote;
  if (value.options && typeof value.options === "object" && !Array.isArray(value.options)) {
    const options: Record<string, OptionTextRefs> = {};
    for (const [k, option] of Object.entries(value.options as Record<string, unknown>)) {
      const o = option as Partial<OptionTextRefs> | null;
      if (o && isServerTextRef(o.label) && (o.desc === undefined || isServerTextRef(o.desc))) options[k] = { label: o.label, ...(o.desc ? { desc: o.desc } : {}) };
    }
    if (Object.keys(options).length) out.options = options;
  }
  return out;
}

/** 결재 카드: 칸마다 따로 맞춰 보고, 맞는 칸의 코드만 싣는다. */
export function decisionTextFields(raw: unknown, d: Pick<Decision, "title" | "detail" | "options" | "closeReason" | "reopenNote">) {
  const stored = readDecisionTexts(raw);
  if (!stored) return {};
  const { lang } = stored;
  const out: Pick<Decision, "textCode" | "textParams" | "optionTexts" | "closeReasonText" | "reopenNoteText"> = {};
  if (stored.text && same(stored.text, lang, d.detail)) {
    const titleCode = titleCodeOf(stored.text.code);
    if (!titleCode || same({ code: titleCode, params: stored.text.params }, lang, d.title)) {
      out.textCode = stored.text.code;
      if (stored.text.params) out.textParams = stored.text.params;
    }
  }
  if (stored.options) {
    const options: NonNullable<Decision["optionTexts"]> = {};
    for (const [k, refs] of Object.entries(stored.options)) {
      const option = d.options.find(o => o.k === k);
      if (!option || !same(refs.label, lang, option.label)) continue;
      if (refs.desc ? !same(refs.desc, lang, option.desc) : option.desc !== undefined) continue;
      options[k] = refs;
    }
    if (Object.keys(options).length) out.optionTexts = options;
  }
  if (stored.closeReason && same(stored.closeReason, lang, d.closeReason)) out.closeReasonText = stored.closeReason;
  if (stored.reopenNote && same(stored.reopenNote, lang, d.reopenNote)) out.reopenNoteText = stored.reopenNote;
  return Object.keys(out).length ? { ...out, textLang: lang } : {};
}

type DecisionTextFields = Pick<Decision, "title" | "detail" | "options" | "closeReason" | "reopenNote">;

/**
 * 0.2.6 Y 리뷰: 보고 언어가 바뀐 뒤 서버가 카드의 한 칸(닫힌 이유·다시 연 까닭)을 새 언어로 쓸 때, 앞 칸들도 새 언어로 다시 그린다.
 * 한 카드의 글은 한 언어다(textLang 하나): 앞 칸의 코드를 버리면 그 칸은 앞 언어 문장 그대로 남아, 새 앱에서도 한 카드 안에 두 언어가 섞였다.
 * 문장이 코드와 맞는 칸만 다시 그린다(이전 판이 문장만 고쳤거나 잘린 칸은 문장을 두고 코드를 뺀다). 돌려주는 patch 는 바뀐 칸만.
 */
export function relocalizeDecisionTexts(stored: StoredDecisionTexts, d: DecisionTextFields, lang: TextLang): { refs: DecisionTextRefs; patch: Partial<DecisionTextFields> } {
  const from = stored.lang;
  const refs: DecisionTextRefs = {};
  const patch: Partial<DecisionTextFields> = {};
  if (stored.text && same(stored.text, from, d.detail)) {
    const titleCode = titleCodeOf(stored.text.code);
    if (!titleCode || same({ code: titleCode, params: stored.text.params }, from, d.title)) {
      const shown = renderDecisionText(stored.text, lang, d.title);
      refs.text = stored.text;
      if (shown.title !== d.title) patch.title = shown.title;
      if (shown.detail !== d.detail) patch.detail = shown.detail;
    }
  }
  if (stored.options) {
    const kept: Record<string, OptionTextRefs> = {};
    for (const [k, option] of Object.entries(stored.options)) {
      const current = d.options.find(o => o.k === k);
      if (!current || !same(option.label, from, current.label)) continue;
      if (option.desc ? !same(option.desc, from, current.desc) : current.desc !== undefined) continue;
      kept[k] = option;
    }
    if (Object.keys(kept).length) {
      refs.options = kept;
      const options = renderOptions(d.options, kept, lang);
      if (JSON.stringify(options) !== JSON.stringify(d.options)) patch.options = options;
    }
  }
  for (const field of ["closeReason", "reopenNote"] as const) {
    const ref = stored[field];
    if (!ref || !same(ref, from, d[field])) continue;
    refs[field] = ref;
    const shown = mustRender(ref, lang);
    if (shown !== d[field]) patch[field] = shown;
  }
  return { refs, patch };
}

/** 카드의 선택지를 코드로 그린다. 코드가 없는 선택지는 그대로 둔다. */
export function renderOptions(options: DecisionOption[], refs: Record<string, OptionTextRefs> | undefined, lang: TextLang): DecisionOption[] {
  if (!refs) return options;
  return options.map(option => {
    const ref = refs[option.k];
    if (!ref) return option;
    return { ...option, label: mustRender(ref.label, lang), ...(ref.desc ? { desc: mustRender(ref.desc, lang) } : {}) };
  });
}

/** 카드의 제목·본문을 코드로 그린다. 제목 코드(`<코드>.title`)가 없으면 제목은 넘겨받은 것 그대로. */
export function renderDecisionText(ref: ServerTextRef, lang: TextLang, title: string): { title: string; detail: string } {
  const titleCode = titleCodeOf(ref.code);
  return { title: titleCode ? mustRender({ code: titleCode, params: ref.params }, lang) : title, detail: mustRender(ref, lang) };
}

/**
 * 팀장의 lastError 가 정해진 문장일 때 그 코드(shared/error-codes.ts). 앱은 영어 화면에서 이 코드로 영어 문장을 고른다.
 * lastError 문장은 바꾸지 않는다: 출시된 앱과 서버 자신(hold-codes.ts 의 앞머리 판정)이 한국어 문장을 읽는다.
 * fenceCode 가 있는 보류 문장은 거기서 이미 코드를 싣는다.
 */
export const LAST_ERROR_CODES: ReadonlyMap<string, ErrorCode> = new Map<string, ErrorCode>([
  ["인터넷 연결 문제로 멈춤", "last_error_api_outage"],
  [RESTART_EXIT_NOTE, "last_error_restart_exit"],
  ["이전 실행기의 세션입니다. 새 core 세션으로 명시적으로 전환해야 합니다", "last_error_legacy_session"],
  ["실행기에 연결할 수 없습니다", "last_error_backend_unreachable"],
  ["전달 여부를 확인할 수 없습니다", "last_error_delivery_unknown"],
  ["전달 실패", "last_error_delivery_failed"],
  // 0.2.7 배포 전 확인 검토(real-cli P3).
  [ERROR_CODES.last_error_compact_draft.ko, "last_error_compact_draft"],
]);

export function lastErrorCodeField(lastError: string | null | undefined): { lastErrorCode?: ErrorCode } {
  const code = lastError ? LAST_ERROR_CODES.get(lastError) : undefined;
  return code ? { lastErrorCode: code } : {};
}

// ---- 터미널 종료 글(orchestrator 에서 옮김) ----

/**
 * 팀장의 lastError·활동에 남는 터미널 종료 글. 터미널을 붙잡던 실행 엔진이나 Mac 이 다시 시작돼 CLI 가 함께 꺼진 것(endedByRestart)은
 * CLI 의 잘못이 아니다: 서버가 같은 세션을 스스로 다시 연다(restart-wake.ts).
 */
export function exitDetail(reason: string | null | undefined, exitCode: number | null | undefined): string {
  return mustRender(exitDetailRef(reason, exitCode), "ko");
}
/**
 * 0.2.6 Y 리뷰: 같은 종료 글의 코드. 한국어로 그리면 exitDetail 과 글자까지 같다(lastError 는 한국어 문장 그대로 두고 lastErrorCode 를 싣는다).
 * 활동 줄은 이 코드로 남긴다.
 */
export function exitDetailRef(reason: string | null | undefined, exitCode: number | null | undefined): ServerTextRef {
  if (endedByRestart(reason)) return textRef("activity.restart_exit");
  return textRef("activity.exit", { reason: reason ?? textRef("word.unknown_cause"), code: String(exitCode ?? "unknown") });
}
/** 활동 줄로: 예전처럼 500자에서 자른다. 잘리는 글은 코드 없이 문장으로 남긴다(잘린 줄의 코드는 어차피 응답에 실리지 않는다). */
export function exitActivity(reason: string | null | undefined, exitCode: number | null | undefined): string | ServerTextRef {
  const detail = exitDetail(reason, exitCode);
  return detail.length > 500 ? detail.slice(0, 500) : exitDetailRef(reason, exitCode);
}
/**
 * 팀장의 lastError 를 대화 글의 값으로 넣을 때(빠른 종료 안내). 서버가 만든 정해진 종료 글이면 그 코드로, 아니면 문장 그대로.
 * 코드는 한국어로 그린 것이 그 문장과 같을 때만 쓴다(글자가 바뀌지 않는다).
 */
export function lastErrorParam(lastError: string): string | ServerTextRef {
  if (lastError === RESTART_EXIT_NOTE) return textRef("activity.restart_exit");
  const exit = /^초기\/실행 종료: ([\s\S]*) \(exit_code=([^()]*)\)$/.exec(lastError);
  if (!exit) return lastError;
  const ref = textRef("activity.exit", { reason: exit[1] === "원인 미확인" ? textRef("word.unknown_cause") : exit[1]!, code: exit[2]! });
  return mustRender(ref, "ko") === lastError ? ref : lastError;
}

export { textLang };
