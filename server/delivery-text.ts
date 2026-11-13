// 전달 글(§4). 서버만 만든다. 대표·총괄·직원·시스템이 보내는 글의 머리와 인용 표시, 위조 방지.
// 상태가 없는 순수 함수만 둔다. orchestrator.ts 에서 옮겨 왔다(동작은 그대로다).
import type { Attachment, Decision, DecisionOption, Delivery, MemberKind, Todo } from "../shared/types.ts";
import { cleanText } from "./text.ts";

export const SHORT_QUOTE = 4;
export const QUOTE_SCAN_PAGES = 10;

export function normalizeSpace(text: string): string {
  return cleanText(text).replace(/\s+/g, " ").trim();
}

// 묶음 전달에서 글 안의 한 줄이 출처 접두어처럼 보이면 위조가 된다. 그런 줄의 맨 앞을 막는다.
// 목록·강조·표 기호를 씌우거나 다른 괄호로 바꿔도 같은 줄로 본다. 전각 괄호·호환 글자는 정규화해서 보고, 글자 사이 공백도 뺀다.
const LINE_NOISE = /^[\s\-*+#|`~_=:.,·•◦‣▪■□▶▷►●○※"'“”‘’«»]*(?:\d+[.)]\s*)?[\s*_`"'“”‘’]*/;
const OPENING = /^[\s*_`"'“”‘’\[({<【〔〖〘〚⟦「『〈《❲❴｟⟨⟪]+/;
const WITH_BRACKET = /^(?:대표|代表|총괄|보고|시스템)/;
const BARE_PREFIX = /^(?:대표(?:직접|답|글전문)|代表|사용자요청\(|총괄인용\(|(?:대표|총괄|보고|시스템):)/;

function looksForged(line: string): boolean {
  const head = line.normalize("NFKC").replace(LINE_NOISE, "");
  const opened = OPENING.exec(head);
  const rest = (opened ? head.slice(opened[0].length) : head).replace(/\s+/g, "");
  if (opened && /[\[({<【〔〖〘〚⟦「『〈《❲❴｟⟨⟪]/.test(opened[0]) && WITH_BRACKET.test(rest)) return true;
  return BARE_PREFIX.test(rest);
}

/** CR·U+2028 같은 숨은 줄바꿈과 제로폭 글자를 먼저 없앤 뒤 줄 머리를 본다. */
export function guardLines(text: string): string {
  return cleanText(text)
    .split("\n")
    .map((line) => (!line.trimStart().startsWith(">") && looksForged(line) ? `> ${line}` : line))
    .join("\n");
}

/** 직원·총괄이 쓴 여러 줄 글은 목록으로 막는 대신 줄마다 인용 표시를 붙인다. 어떤 모양을 지어내도 접두어 없는 입력으로 보이지 않는다. */
function quoteBlock(text: string): string {
  return cleanText(text)
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/** 직원이 쓴 값(카드 제목·버튼 글·설명·할 일 제목)을 따옴표 안에 넣는다. 따옴표를 닫아 대표 답을 지어내지 못하게 한다. */
export function quotedInline(text: string): string {
  return normalizeSpace(text).replace(/[\\'"]/g, "\\$&");
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 경로와 형식은 바깥에서 온 값이 섞인다. 한 줄이어야 줄을 끊어 접두어를 지어내지 못한다. */
export function attachmentLines(attachments: Attachment[]): string[] {
  return attachments.map((a) => `첨부: ${normalizeSpace(a.path)} (${normalizeSpace(a.mime)}, ${humanSize(a.size)})`);
}

export function formatUserMessage(text: string, attachments: Attachment[], id: string, direct: boolean): string {
  const lines = [`[대표${direct ? " 직접" : ""}] "${guardLines(text)}"`];
  lines.push(...attachmentLines(attachments));
  lines.push(`#${id}`);
  return lines.join("\n");
}

export function formatAnswer(d: Decision): string {
  const option: DecisionOption | undefined = d.options.find((o) => o.k === d.choice);
  const head = `[대표 답(원문) '${quotedInline(d.title)}']`;
  const note = d.note ? guardLines(d.note) : null;
  const parts = [head];
  if (option) {
    parts.push(`"${quotedInline(option.label)}"${option.desc ? `(${quotedInline(option.desc)})` : ""}`);
    if (note) parts.push(`메모 "${note}"`);
  } else if (note) {
    parts.push(`"${note}"`);
  }
  if (d.batch) parts.push("(묶음 추천대로)");
  parts.push(`#${d.id}`);
  return parts.join(" ");
}

export function formatTodoDone(t: Todo): string {
  if (t.outcome === "dropped") return `[대표] '${quotedInline(t.title)}' 필요 없음 #${t.id}\n${t.closeReason ?? "대표가 필요 없음으로 정리"}`;
  return `[대표] '${quotedInline(t.title)}' 했음 #${t.id}${t.completionNote != null ? `\n[대표 완료 답 원문]\n${t.completionNote}\n[대표 완료 답 끝]` : ""}${t.completionFileIds?.length ? `\n대표가 올린 첨부: ${t.completionFileIds.join(", ")}` : ""}`;
}

export function formatTodoUndone(t: Todo): string {
  return `[대표] '${quotedInline(t.title)}' 아직 안 했음(체크를 풀었습니다) #${t.id}`;
}

export interface QuoteSource {
  id: string;
  text: string;
  /** 대표가 쓰거나 고른 시각 */
  at?: string | null;
  /** 버튼 글이면 그 결재 카드의 제목. 버튼 글만으로는 무엇에 대한 답인지 알 수 없다. */
  card?: string | null;
}

export interface VerifiedQuote {
  text: string;
  verified: boolean;
  /** 맞은 대표 글. 일부 인용이면 전문을, 전체 인용이면 #id 와 시각을 함께 보내 판단 재료를 준다. */
  source?: QuoteSource | null;
}

/** '진행' 같은 버튼 글·짧은 글은 다른 안건의 답일 수 있다. 맞더라도 승인으로 바로 치지 말라고 표시한다. */
export function quoteNeedsContext(quote: VerifiedQuote): boolean {
  if (!quote.verified || !quote.source) return false;
  return quote.source.card != null || normalizeSpace(quote.text).length < SHORT_QUOTE;
}

const QUOTE_SOURCE_MAX = 1000;

export function formatInstruction(name: string, text: string, quote: VerifiedQuote | null): string {
  const lines = [`[총괄] ${name}에게`];
  if (quote) {
    const cited = normalizeSpace(quote.text);
    const label = !quote.verified ? "총괄 인용(미확인)" : quoteNeedsContext(quote) ? "사용자 요청(문맥 확인 필요)" : "사용자 요청(원문, 서버 확인)";
    const source = quote.source ? normalizeSpace(quote.source.text) : "";
    const whole = !!quote.source && source === cited;
    const stamp = quote.source?.at ? ` ${quote.source.at}` : "";
    const origin = !whole || !quote.source ? "" : quote.source.card != null ? ` 결재 #${quote.source.id} '${quotedInline(quote.source.card)}'에서 고른 답${stamp}` : ` #${quote.source.id}${stamp}`;
    lines.push(`${label}: "${cited}"${origin}`);
    if (quote.source && !whole) {
      lines.push(`대표 글 전문 #${quote.source.id}: "${source.length > QUOTE_SOURCE_MAX ? `${source.slice(0, QUOTE_SOURCE_MAX)}…` : source}"`);
    }
  }
  // 첫 줄 뒤는 총괄이 쓴 글이다. 어떤 모양이어도 줄 머리가 접두어처럼 보이지 않게 인용 표시를 붙인다.
  const [first, ...rest] = cleanText(text).split("\n");
  lines.push(`할 일: ${first}`);
  if (rest.length > 0) lines.push(quoteBlock(rest.join("\n")));
  return lines.join("\n");
}

export function formatReport(name: string, kind: string, title: string, body: string): string {
  const head = `[보고 ${name}] ${kind}: ${normalizeSpace(title)}`;
  return body ? `${head}\n${quoteBlock(body)}` : head;
}

export function formatSystem(text: string): string {
  return `[시스템] ${text}`;
}

/** 판 정리 지시의 머리. 대기열에 이미 있는지, 이번 턴이 판 정리였는지 이것으로 가린다. */
export const TIDY_HEAD = formatSystem("판 정리");

/** 총괄(본사는 본사 AI)에게 넣는 판 정리 지시. 본사 AI 에게는 진행판·지금 상황 도구가 없다. */
export function formatTidy(kind: MemberKind, manual: boolean): string {
  const tools =
    kind === "root"
      ? "이미 정해졌거나 필요 없어진 결재는 `ask_close`, 끝났거나 필요 없어진 할 일은 `todo_close`."
      : "이미 정해졌거나 필요 없어진 결재는 `ask_close`, 끝났거나 필요 없어진 할 일은 `todo_close`, 진행판은 `work_set`·`work_remove`, 전체 그림은 `project_now`.";
  return [
    `${TIDY_HEAD}${manual ? "(대표가 눌렀습니다)" : ""}: 열린 결재·내 할 일·진행판·지금 상황을 지금 상태에 맞춰라.`,
    "- `board` 로 판을 보고, 대화·보고·세션 기록으로 판단한다.",
    `- ${tools}`,
    "- 3일 넘은 열린 할 일은 직접 확인할 수 있으면 확인 결과를 이유로 todo_close(done), 필요 없어졌으면 dropped로 닫는다. 대표 브라우저를 여는 확인(Aside 등)은 하지 않는다. 확인할 수 없으면 그대로 둔다. 부탁한 직원(없으면 총괄)에게 깨우지 않는 자동 안내가 가며 다음에 그 일을 할 때 확인한다.",
    "- 대표가 아직 정하지 않은 결재는 대신 닫지 않는다. 확실하지 않으면 그대로 둔다. 직원은 깨우지 않는다.",
    "- 바뀐 게 있으면 `post`(알림) 한 줄로 무엇을 정리했는지 알린다. 없으면 아무것도 올리지 말고 턴을 끝낸다.",
  ].join("\n");
}

export function isTidy(d: Pick<Delivery, "kind" | "text">): boolean {
  return d.kind === "system" && d.text.startsWith(TIDY_HEAD);
}
