// 직원 쪽 업무 흐름(H): MCP 도구, 지시(team_assign), 보고(post), ask, 결재 닫기·할 일 정리, 직접 띄운 CLI 의 수신함과 대기.
// orchestrator.ts 에서 옮겨 왔다(동작은 그대로다). 원본을 저장소에 쓰고 전달 의도를 줄 세운 뒤 펌프를 민다.
// 턴 상태는 Orchestrator 의 것을 TurnContext 로만 읽고 쓴다. 세션 수명·펌프는 Orchestrator 가 맡고, 여기서는 포트로만 부른다.
import type { AgentOperationContext, ManualInboxAckRequest, ManualInboxAckResult, ManualInboxBatch } from "../../shared/operations.ts";
import type { Attachment, Decision, DecisionCloseFollowUp, DecisionCloseKind, DecisionOption, Delivery, Member, Message, MessageKind, Project, Todo, TodoOutcome, WorkItem, WorkSec } from "../../shared/types.ts";
import { attachmentLines, formatAnswer, formatAnswerFor, formatInstruction, formatReport, formatSystem, isTidy, normalizeSpace, QUOTE_SCAN_PAGES, quotedInline, quoteNeedsContext, SHORT_QUOTE, type QuoteSource, type VerifiedQuote } from "../delivery-text.ts";
import type { AgentToolDef, AgentToolResult, AskWaitResult } from "../orchestrator-api.ts";
import type { AgentToolsImpl, Orchestrator, UrgentOutcome, UrgentStop, UrgentWaitReason } from "../orchestrator.ts";
import { josa } from "../roles.ts";
import type { ReportReferences } from "../service-contracts.ts";
import { ApiError, type NewDelivery, type Store } from "../store.ts";
import { textRef, type ServerTextRef } from "../../shared/server-text.ts";

export interface AssignInput {
  text: string;
  userQuote?: string;
  parallel?: boolean;
  urgent?: boolean;
  /** 대표 메시지의 첨부 id. 그 직원 폴더로 이어 경로를 알린다. */
  attachmentIds?: string[];
}

export interface AssignResult {
  delivery: Delivery;
  /** 앞에 일이 있어 기다리면 대기열 위치(1부터), 곧바로 들어가면 0. */
  position: number;
  verified: boolean | null;
  /** 맞았지만 버튼 글·짧은 글이라 '문맥 확인 필요'로 나갔다. */
  needsContext: boolean;
  /** 0.2.7 묶음 1: 급한 지시를 일하는 중인 팀장에게 줄 때 서버가 한 일('하던 턴 멈추고 넣기' 또는 기다림과 그 까닭). 그 밖에는 없다. */
  urgent?: UrgentOutcome;
  /** 0.2.7 묶음 1: 받는 팀장이 지금 하던 일을 시작한 때(일하는 중이라 기다릴 때만). */
  busySince?: string | null;
  /**
   * 0.2.7 배포 전 확인(real-cli P1·P2): 받는 팀장의 턴은 끝났지만 Codex 가 띄운 백그라운드 프로그램(이 수)이 남아 이 지시가 기다린다.
   * 그 프로그램이 끝나거나 터미널에서 /stop 으로 닫아야 들어간다(IAMCEO 는 끄지 않는다). 그 밖에는 없다.
   */
  backgroundPrograms?: number;
}

export interface PostInput {
  kind: Extract<MessageKind, "완료" | "진행" | "막힘" | "알림" | "질문">;
  title: string;
  body?: string;
  fileIds?: string[];
  decisionId?: string | null;
  group?: string | null;
  correctsMessageId?: string | null;
  supersedes?: string | null;
}

export interface AskInput {
  title: string;
  detail?: string;
  options?: DecisionOption[];
  rec?: string | null;
  group?: string | null;
  fileId?: string | null;
  images?: Attachment[];
  /** 0.2.7 묶음 4(D3-5): 이 카드가 대신할 자기 열린 카드. 같은 트랜잭션에서 그 카드를 '대체됨'(obsolete)으로 닫고 서로 잇는다. */
  replaces?: string | null;
}

/** 0.2.7 묶음 4: detail 이 자기 열린 카드를 대신한다고 쓰고 replaces 를 주지 않았을 때 알린다(점검 D3-5: 옛 카드가 열린 채 남았다). */
const REPLACE_WORDS = /대신|대체|바꿔|갈음|새 카드|다시 여쭙|replac|supersed/i;

// 0.2.7(D3-3): 지금 카드를 올리라는 것과, 걸린 문장이 나중의 예고·남의 카드·이미 받은 결정이면 아무것도 하지 말라는 것을 함께 말한다.
// 예전 글('필요 없으면 보고를 정정하라')은 맞는 문장을 지우거나 거의 같은 보고를 1분 안에 다시 올리게 했다(0.2.6 뒤 감지 16번 중 정정만 14번).
const APPROVAL_CARD_INSTRUCTION = "보고에 대표 승인·결정을 지금 구하는 문장이 있는데 열린 결재 카드가 없다. 지금 정할 일이면 ask 로 카드를 올려라. 승인이 필요 없는데 잘못 썼으면 그 문장만 정정하라. 나중에 물을 예고·조건부 안내·다른 팀장의 카드·이미 받은 결정을 말한 것이면 아무것도 하지 마라(보고를 다시 올리지 않는다).";

// 승인 뒤에 오는 말 가운데 지금 승인을 구하거나 기다린다는 것(뒤·후·전은 '승인 뒤 진행'처럼 아직 받지 않은 승인을 전제한다).
const APPROVAL_PENDING = /(?:승인|허락|결재)(?:을|를|이|가|은|는)?\s*(?:뒤|후|전|대기|필요|요청|받아야|받으면|받고|받은\s*(?:뒤|후)|받기\s*전|부탁|올려야|올릴)/;
const OWNER_PENDING = /대표(?:님)?(?:의)?\s*(?:확인|결정)(?:을|를|이|가|은|는)?\s*(?:필요|대기|기다|요청|뒤|후|전|받아야|받으면|받고|부탁|바랍니다|해\s*주)/;
/** 대표에게 묻는 말(여쭙다)과 대표에게 고르라고 청하는 말. 이것만 '언제·누가' 묻는지(조건·나중·다른 팀장)를 본다. */
const ASK_VERB = /여쭙|여쭘|여쭈|여쭤|여쭐|(?:정해|골라|결정해|승인해|허락해)\s*주(?:시면|세요|십시오)/g;
/** 낱말 끝의 '면'이 조건(-면·-으면·-려면·-다면)이 아니라 이름씨인 것. 이 앞의 '면'은 조건으로 보지 않는다. */
const NOUN_MYEON = /(?:화|장|측|전|정|표|방|단|국|평|서|당|직|체|안|반|수|후|앞|뒷|윗|옆|겉|양|외|대|도)면$/;
/** 물음이 지금이 아니라 나중·조건부라는 표지(물음 동사 앞, 같은 문장 안). 부사(LATER)와 때·뒤·후·다음·날(TEMPORAL)은 따로 본다. */
const DEFERRED = [
  /경우/,
  /는\s*대로(?=[\s,]|$)/,
  /거든(?=[\s,]|$)/,
  /는\s*것(?:은|이면)(?=[\s,]|$)/,
];
/** 물음을 나중으로 미루는 부사. */
const LATER = /^(?:다시|따로|나중에?|추후|그때|이때|그날|만약|만일|혹시)$/;
/** 절을 끝내는 이음 꼴(없어서·끝나서·하고·보며·했는데·되도록). 이 앞의 부사는 그 절의 것이지 물음 동사의 것이 아니다. */
const CONNECTIVE = /(?:[가-힣]서|[가-힣]고|며|면서|니까|는데|은데|지만|도록|려고)$/;
/** '서'·'고'로 끝나는 이름씨(문서·순서·보고서, 광고·보고 …)와 조사 '에서'·'로서'는 이음 꼴이 아니다. */
const NOUN_GO = /(?:문|순|획|명|약|각|부|청|관|무|증|의|도|고|에|로)서$|(?:광|보|참|재|신|경|최|창|원|사|공|금|등|제|휴|선|예)고$/;
/** 때·뒤·후·이후·다음·날(+에·엔·에는·부터·만 …). PLACE_TIME: 그 말이 묻는 때·곳을 꾸미는 조사(다음 카드에서, 점검 뒤에). */
const TEMPORAL = /^(?:뒤|후|이후|다음|날|때)(?:에|엔|에는|에도|부터|는|만|도|까지|마다)?$/;
const PLACE_TIME = /(?:에|엔|에는|에도|에서|부터)$/;
/**
 * '…전에'·'…와 함께' 는 앞으로 물을 예고(여쭙겠습니다)에서만 나중이다. '내기 전에 방향부터 여쭙니다'는 지금 묻는 말이고,
 * '적용 보고와 함께 카드로 여쭙겠습니다'는 아직 오지 않은 보고와 함께 물을 예고다.
 */
const BEFORE = /(?:^|\s)(?:\S*기\s*)?전(?:에|엔|에는)?(?=[\s,(]|$)|(?:와|과)\s*함께(?=[\s,]|$)/;
const FUTURE_ASK = /^(?:여쭙|여쭤|여쭈)\S*?(?:\s*보)?겠|^여쭐/;
/** 물음 내용 절을 여는 물음 낱말(어떤 색이면 좋을지, 어느 것으로 할지). */
const WH_WORD = /(?:^|\s)(?:어떤|어느|무슨|무엇|뭘|뭐|언제|어디|누가|누구|얼마|몇|왜|어떻게)/;
/** 다른 팀장 이름 바로 뒤에 와도 그 이름이 여전히 묻는 이인 부사(오늘 끝나서 → '끝나서'가 그 이름의 풀이말). */
const ADVERB = /^(?:오늘|어제|내일|방금|지금|곧|이미|벌써|아직|다|모두|먼저|따로|직접|바로|다시|함께|같이|이어서|대신)$/;

/** 한글 글자의 받침 번호(없으면 0, ㄴ=4, ㄹ=8). 한글이 아니면 -1. */
function jong(ch: string | undefined): number {
  const code = ch ? ch.charCodeAt(0) - 0xac00 : -1;
  return code >= 0 && code < 11172 ? code % 28 : -1;
}
/** 꾸밈 꼴(끝난·만든·할·올리는)로 끝나는 낱말인가: 뒤에 오는 때·뒤·후·날이 '…한 뒤에'라는 절이 된다. */
function modifier(word: string | undefined): boolean {
  if (!word) return false;
  if (/^(?:그|이|저|그런|이런)$/.test(word)) return true;
  const last = word.at(-1);
  return jong(last) === 4 || jong(last) === 8;
}
/** 물음 내용 절의 끝 낱말(올릴지·넣을지·하는지·무엇인지): ㄹ 받침 글자 또는 는·은·인·던·건 뒤의 '지'(+는·를·도·만·가). */
function contentEnd(word: string): boolean {
  const m = /([가-힣])지(?:는|를|도|만|가)?$/.exec(word);
  return !!m && (jong(m[1]) === 8 || "는은인던건".includes(m[1]!));
}

/** 낱말로 나누고 앞뒤 꾸밈 글자(**, -, 괄호, 따옴표 …)를 뗀다. */
function wordsOf(text: string): string[] {
  return text.split(/[\s,()]+/).map(word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
}

/**
 * 물음 동사 앞(scope, 물음 내용 절을 뺀 것)에 그 물음을 나중·조건부로 미루는 표지가 있는가. before 는 빼기 전의 물음 동사 앞 글.
 * strong(앞으로 물을 예고 '여쭙겠습니다'): 때·뒤·후·다음·날·다시·따로가 어디 있든 나중이다(0.2.7 첫 판의 기준 그대로).
 * 지금 묻는 현재형('여쭙니다', '골라 주세요')에서는 표지를 약하게 본다(검토 지적):
 * - 때·뒤·후·날·다음: '…한 뒤', '할 때', '그 다음', '뒤에'처럼 절·부사로 쓰이면 나중이다. 이름씨에 붙은 때·뒤·후·날('출시 후', '회의 때')은
 *   뒤에 물음 내용 낱말(…할지)이 오면 그 내용이고('출시 후 가격을 올릴지'), 아니면 나중이다('점검 뒤 카드로 여쭙니다'). 꾸미는 '다음'은 '다음 카드에서',
 *   '다음 판에서'처럼 묻는 곳·때를 꾸밀 때만 나중이다('다음 판에 넣을지', '다음 교대 시각은'은 내용).
 * - 다시·따로 같은 부사: 마지막 절(이음 꼴·물음 내용 낱말 뒤)에 있을 때만('다시 켤지는'의 '다시'는 켜는 것, '따로 말씀하신 적이 없어서'의
 *   '따로'는 말씀의 것).
 */
function deferred(scope: string, before: string, strong: boolean): boolean {
  const words = wordsOf(scope);
  // 조건의 '면': 낱말 끝의 '면'(…하면, 있으면, 원인이면, 바꾸려면). 화면·장면 같은 이름씨는 뺀다.
  if (words.some(word => /면$/.test(word) && !NOUN_MYEON.test(word))) return true;
  if (DEFERRED.some(re => re.test(scope))) return true;
  // 지금 묻는 말에서는 마지막 절(이음 꼴·물음 내용 낱말 뒤)의 부사만 묻는 때를 꾸민다. '다시 켤지는 카드로 여쭙니다'의 '다시'는 켜는 것,
  // '따로 말씀하신 적이 없어서 여쭙니다'의 '따로'는 말씀의 것이다. 앞으로 물을 예고는 어디 있든 나중이다.
  const tail = strong ? 0 : words.reduce((at, word, i) => contentEnd(word) || (CONNECTIVE.test(word) && !NOUN_GO.test(word)) ? i + 1 : at, 0);
  if (words.some((word, i) => i >= tail && LATER.test(word))) return true;
  const all = wordsOf(before);
  const contentAfter = (i: number) => all.slice(i + 1).some(contentEnd);
  return all.some((word, i) => {
    // 붙여 쓴 '때'(할때·회의때)는 떼어 본다. '때문'은 까닭이다.
    const attached = /^(.+?)(때(?:에|엔|에는|에도|부터|는|만|도|까지|마다)?)$/.exec(word);
    const [prev, marker] = TEMPORAL.test(word) ? [all[i - 1], word] : attached && !/때문/.test(word) && !LATER.test(word) ? [attached[1]!, attached[2]!] : [null, null];
    if (!marker) return false;
    if (strong || PLACE_TIME.test(marker.slice(marker.startsWith("이후") || marker.startsWith("다음") ? 2 : 1)) || modifier(prev ?? undefined)) return true;
    if (marker.startsWith("다음")) return !contentAfter(i) && all.slice(i + 1, i + 3).some(next => PLACE_TIME.test(next));
    return !contentAfter(i);
  });
}

/**
 * 지금 대표 승인·결정을 구하는 문장 조각(쉼표로 나눈 절)들(0.2.7 D3-3). 단어만으로 막지 않는다. 앞으로 받을 판단과 이미 받은 판단·불필요·CLI
 * 승인을 구분하고, 다음은 걸지 않는다: 인용(따옴표 안·> 줄·코드), 부정('승인이 필요한 일은 없습니다', '필요한 건 없습니다'), 이미 물음
 * ('카드로 여쭤 두었습니다', '여쭙게 했습니다'), 바깥 심사의 승인(스토어·플랫폼 검토), 조건·나중의 물음('~면 여쭙겠습니다', '다시/따로 여쭙겠습니다',
 * '올리는 날 여쭙겠습니다'), 다른 팀장이 묻거나 다른 팀장에게 하는 말('디자인 2가 카드로 여쭙습니다', '총괄에게: … 정해 주시면').
 * others: 이 프로젝트의 다른 팀장 이름.
 */
export function approvalRequests(text: string, others: readonly string[] = []): string[] {
  const prose = text.replace(/```[^]*?```|~~~[^]*?~~~/g, "").replace(/^\s*>.*$/gm, "")
    // 따옴표 안은 앞 글·남의 말의 인용이다(정정 글이 "'다시 여쭙겠습니다'라고 쓴 줄을 뺐습니다"로 다시 걸렸다).
    .replace(/'[^'\n]{0,160}'|"[^"\n]{0,160}"|‘[^’\n]{0,160}’|“[^”\n]{0,160}”|「[^」\n]{0,160}」|『[^』\n]{0,160}』/g, " ");
  const names = others.map(name => name.trim()).filter(name => name.length >= 2).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // 받는 이(에게·께·한테)로 쓴 다른 팀장: 그 사람에게 하는 말이다.
  const toOther = names.length ? new RegExp(`(?:${names.join("|")})\\s*(?:에게|께|한테)(?=[\\s,:]|$)`) : null;
  // 묻는 이(이·가·께서)로 쓴 다른 팀장. 이름이 흔한 낱말과 겹칠 수 있어('앱 빌드가 끝나서 배포할지 여쭙니다') 물음 동사 바로 앞 주어 자리만 본다.
  const askerOther = names.length ? new RegExp(`(?:${names.join("|")})\\s*(?:이|가|께서)(?=[\\s,]|$)`, "g") : null;
  // 그 이름의 풀이말이 따로 있으면('앱 빌드가 끝나서 배포할지') 묻는 이가 아니다: 이름 뒤의 첫 말(부사 건너)이 이음 꼴이거나, 이름과 물음 동사 사이에
  // 물음 내용 낱말(…할지)이 있으면 그 이름은 내용 안에 있다('디자인 2가 만든 시안을 쓸지').
  const otherAsks = (before: string) => !!askerOther && [...before.matchAll(askerOther)].some(m => {
    const between = wordsOf(before.slice(m.index! + m[0].length));
    const first = between.find(word => !ADVERB.test(word));
    return !between.some(contentEnd) && !(first && CONNECTIVE.test(first) && !NOUN_GO.test(first));
  });
  const found: string[] = [];
  // 문장 끝의 마침표만 나눈다. '1.2.34 출시를 … 여쭙겠습니다'의 판 번호에서 나누면 앞의 조건('끝나면')을 잃는다.
  for (const part of prose.split(/\n|[.!?;。](?=\s|$)|(?:하지만|그러나|지만)/)) {
    const sentence = part
      .replace(/(?:터미널|CLI|cli|명령(?:어)?|도구|실행|권한|샌드박스)\s*(?:승인|허락)(?:\s*창)?/g, "")
      .replace(/승인\s*창/g, "")
      .replace(/(?:승인|결재|허락)\s*(?:요청\s*)?(?:기능|로직|문구|테스트|시험|규칙|카드\s*UI)/g, "")
      .replace(/(?:승인|허락|결재)\s*요청(?:은|을)?\s*(?:하지\s*않|안\s*했)/g, "")
      // 바깥 심사(스토어·광고 플랫폼)의 승인은 대표 승인이 아니다. 심사 이름과 '승인' 사이의 낱말 둘까지('구글 플레이 승인', 'TestFlight 외부 테스트 승인').
      .replace(/(?:심사|검수|스토어|앱\s*스토어|App\s*Store|Play|플레이|구글|애플|메타|Google|Apple|Meta|TestFlight|테스트\s*플라이트|Console|콘솔|광고\s*검토|관리형\s*게시\S*)(?:\s+(?!대표)[^\s,]+){0,2}?\s*(?:의\s*)?(?:승인|허가)/gi, "")
      .replace(/(?:대표(?:님)?(?:의)?\s*)?(?:승인|허락|결재|확인|결정)(?:은|는|이|가|을|를)?\s*(?:불필요|필요\s*(?:없|하지\s*않)|요청하지\s*않|받지\s*않아도|(?:이미\s*)?(?:받았|받음|완료|끝났|끝남))/g, "")
      // 부정: '승인이 필요한 (다음) 단계는 없습니다', '승인이 필요한 일이 아닙니다', '필요한 건 없습니다', '승인 대기 중인 건은 없습니다'.
      .replace(/(?:대표(?:님)?(?:의)?\s*)?(?:승인|허락|결재|확인|결정)(?:이|가)?\s*(?:필요한|대기\s*중인|대기인|기다리는)\s*(?:[^,]{0,24}?(?:은|는|이|가)|건|게)\s*(?:없|아니|아닙)/g, "")
      // '따로 받을 결정은 없습니다', '결재 올릴 것은 없습니다', '대표님께 여쭐 건 없습니다'.
      .replace(/(?:(?:대표(?:님)?(?:의)?\s*)?(?:승인|허락|결재|결정|확인)(?:을|를)?\s*)?(?:정하실|정할|고르실|받으실|받을|여쭐|드릴|올릴|요청할|구할)\s*(?:결정|승인|결재|것|일|사항|건|게|카드)(?:은|는|이|가)?\s*(?:따로\s*)?(?:없|아니|아닙)/g, "")
      .replace(/(?:대표(?:님)?(?:이|께서)?\s*)?(?:승인|허락|결재|확인|결정)(?:을|를)?\s*(?:해\s*주셨|하셨|했습|했음)/g, "")
      // 이미 물었거나(여쭤 두었습니다·여쭌) 남에게 묻게 했다(여쭙게 했습니다).
      .replace(/(?:여쭙|여쭈|여쭤)(?:지\s*않|지\s*말|지\s*않아도|었|봤|\s*(?:두었|뒀|둔|놓았|놨|보았|드렸)|게\s*(?:했|하였|시켰|맡겼))|여쭌/g, "");
    let offset = 0;
    for (const clause of sentence.split(",")) {
      const start = offset;
      offset += clause.length + 1;
      if (/(?:승인|허락|결재|대표(?:님)?(?:의)?\s*(?:확인|결정))\s*(?:후|뒤).*(?:했습니다|했음|끝냈습니다|마쳤습니다)\s*$/.test(clause)
        && !/(?:필요|대기|여쭙|여쭈|여쭤)/.test(clause)) continue;
      if (APPROVAL_PENDING.test(clause) || OWNER_PENDING.test(clause) || /(?:대표(?:님)?(?:의)?\s*(?:확인|결정)|승인|허락|결재)\s*$/.test(clause)) { found.push(clause.trim()); continue; }
      for (const ask of clause.matchAll(ASK_VERB)) {
        // 다른 팀장에게 하는 말(총괄에게: … 정해 주시면)이나 다른 팀장이 묻는 말(디자인 2가 카드로 여쭙습니다)은 대표에게 지금 묻는 말이 아니다.
        if (toOther?.test(sentence) || /(?:총괄|팀장|직원)(?:님)?(?:에게|께|한테)/.test(sentence)) continue;
        const before = sentence.slice(0, start + ask.index!);
        if (otherAsks(before)) continue;
        const future = FUTURE_ASK.test(clause.slice(ask.index!));
        let scope = before;
        if (!future) {
          // 지금 묻는 말이면 물음 내용 절('어떤 색이면 좋을지', '어느 것으로 할지') 안의 표지는 묻는 때가 아니라 묻는 내용이다.
          const local = clause.slice(0, ask.index!), wh = WH_WORD.exec(local);
          if (wh) {
            const words = [...local.slice(wh.index).matchAll(/\S+/g)];
            const last = words.findLast(w => contentEnd(w[0].replace(/[^\p{L}\p{N}]+$/u, "")));
            if (last) scope = sentence.slice(0, start) + local.slice(0, wh.index) + local.slice(wh.index + last.index! + last[0].length);
          }
        }
        if (deferred(scope, before, future)) continue;
        if (future && BEFORE.test(before)) continue;
        found.push(clause.trim());
        break;
      }
    }
  }
  return found;
}

export function needsApprovalCard(text: string, others: readonly string[] = []): boolean {
  return approvalRequests(text, others).length > 0;
}

/** 총괄을 깨우는 보고 종류. 진행·알림은 깨우지 않고 다음 턴에 함께 읽힌다. */
export const WAKE_POST_KINDS = new Set<string>(["완료", "막힘", "질문"]);

/**
 * 지금 턴의 문맥. Orchestrator 가 직원별로 들고 있는 실행 상태를 그대로 넘긴다(같은 객체라 여기서 쓴 값을 턴 끝 처리가 그대로 본다).
 */
export interface TurnContext {
  /** 이번 턴에 post·ask 로 보고했다. 턴이 끝날 때 마지막 글을 자동 보고로 올리지 않는다. */
  posted: boolean;
  /** 이번 턴에 일을 맡겼다(team_assign·team_add·team_resume). 보고가 없어도 보고 보완을 요구하지 않는다. */
  delegated: boolean;
  /** 대표가 이 직원에게 직접 보낸 글로 도는 턴이다. 보고 제목에 '(직접)'을 붙인다. */
  readonly direct: boolean;
  /** 다음 지시를 병렬로 받을지. 마지막 지시가 이긴다. */
  wantParallel: boolean | null;
  /** 지금 도는 턴. 같은 턴에 올린 결재와 판 정리 확인을 여기에 적는다. */
  readonly turn: { askedDecisionIds?: Set<string>; boardReview?: { requestedRevision: number; reviewedRevision: number | null } } | null;
}

/** 직원 쪽 흐름이 Orchestrator 에서 받는 것: 원본 저장(store), 전달 의도와 펌프, 턴 문맥, 그리고 세션 상태를 묻는 몇 가지. */
export interface MemberFlowPort {
  readonly store: Store;
  /** MCP 도구 구현(agent-tools.ts)에 넘기는 Orchestrator. */
  readonly host: Orchestrator;
  /** 서버를 닫는 중이다. 새 대기를 걸지 않는다. */
  closed(): boolean;
  /** 보관 전에 칸을 끝내는 중인 프로젝트. 보관된 것처럼 다룬다. */
  archiving(projectId: string): boolean;
  pump(memberId: string): Promise<void>;
  /** 줄 세우고 곧바로 민다. */
  deliver(input: NewDelivery): Promise<Delivery>;
  /** 보관했거나 보관 중인 프로젝트면 ApiError(409). */
  requireActive(project: Project): void;
  /** 핸들이나 화면 이름으로 이 프로젝트의 직원을 찾는다. 없으면 ApiError(404). */
  requireInProject(projectId: string, memberRef: string): Member;
  turnContext(memberId: string): TurnContext;
  isBusy(member: Member): boolean;
  /** 이 직원의 실행기가 턴 중에 긴급 입력을 끼워 넣을 수 있다. */
  interjects(member: Member): boolean;
  /** 0.2.7 묶음 1: 급한 지시로 지금 '하던 턴 멈추고 넣기'를 할 수 없는 까닭(할 수 있으면 null). */
  urgentBlocker(member: Member, quote: VerifiedQuote | null): UrgentWaitReason | null;
  /**
   * 0.2.7 묶음 1: 앱의 '중단'과 같은 길로 하던 턴을 멈춘다. 멈춘 것을 확인했으면 interrupted, 멈춤 키는 보냈지만 확인하지 못했으면 unconfirmed, 보내지 못했으면 false.
   * sourceId 는 근거인 대표 글(한 번만 멈추는 표식). 0.2.7 배포 전 확인: 턴은 멈췄지만 하던 명령이 Codex 백그라운드 터미널로 남았으면 { background },
   * 멈출 턴이 없었으면(쉬는 CLI, 키를 보내지 않음) no_turn.
   */
  interruptForUrgent(member: Member, delivery: Delivery, sourceId: string): Promise<UrgentStop>;
  /** 0.2.7 배포 전 확인(real-cli P1·P2): 턴은 끝났고 Codex 가 띄운 백그라운드 프로그램 때문에만 기다리는 팀장이면 그 수, 아니면 null. */
  backgroundPrograms(member: Member): number | null;
  /** 0.2.7 묶음 1: 지금 하던 일을 시작한 때. */
  busySince(memberId: string): string | null;
  /** 턴 밖의 상태로 돌린다(답하지 않은 결재가 있으면 waiting, 없으면 idle). */
  settle(member: Member): void;
  /** waiting 인데 답하지 않은 결재가 남지 않았으면 지금 하는 대로 고친다. */
  refreshWaiting(memberId: string): void;
  /** 대표에게 Mac 알림(설정에서 켠 때만). */
  notifyInbox(title: string | ServerTextRef, body: string | ServerTextRef): void;
  /** 대표가 체크를 푼 할 일의 '아직 안 했음' 정정을 맞춘다(flows/owner.ts). */
  reconcileTodoCorrections(): void;
  /** 첨부를 그 직원의 폴더로 잇는다(flows/owner.ts). */
  attachmentsFor(member: Member, attachments: Attachment[]): Attachment[];
}

export class MemberFlows {
  private readonly store: Store;
  private agentTools: AgentToolsImpl | null;
  private askWaiters = new Map<string, Set<() => void>>();
  private inboxWaiters = new Map<string, Set<() => void>>();
  private readonly agentOperations = new Map<string, Promise<AgentToolResult>>();

  constructor(private readonly port: MemberFlowPort, agentTools: AgentToolsImpl | null) {
    this.store = port.store;
    this.agentTools = agentTools;
  }

  /** 결재 답을 기다리는 직접 띄운 CLI(askWait)를 깨운다. */
  wakeAsk(decisionId: string): void {
    this.wakeAll(this.askWaiters, decisionId);
  }

  /** 직접 띄운 CLI 의 수신함 대기(wait·manualInbox)를 깨운다. */
  wakeInbox(memberId: string): void {
    this.wakeAll(this.inboxWaiters, memberId);
  }

  /** 서버를 닫는다: 기다리는 것을 모두 풀어 준다. */
  wakeEveryone(): void {
    for (const waiters of [...this.askWaiters.values(), ...this.inboxWaiters.values()]) {
      for (const wake of waiters) wake();
    }
  }

  async listAgentTools(member: Member): Promise<AgentToolDef[]> {
    return (await this.tools()).listAgentTools(member);
  }

  async handleAgentTool(member: Member, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult> {
    const tools = await this.tools();
    const boardRevision = name === "board" ? this.store.boardRevision(member.projectId) : null;
    const result = await tools.handleAgentTool(this.port.host, member, name, args, signal);
    if (!result.isError) {
      if (boardRevision !== null) this.noteBoardReview(member, boardRevision);
      if (["team_assign", "team_add", "team_resume"].includes(name) && this.port.turnContext(member.id).turn) {
        this.port.turnContext(member.id).delegated = true;
        for (const run of this.store.listPendingExecutions().filter(run => run.memberId === member.id)) this.store.saveExecutionJournal({ ...run, reason: "awaiting_delegation", updatedAt: new Date().toISOString() });
      }
    }
    return result;
  }

  /** 영속 예약을 먼저 커밋한다. 프로세스가 죽으면 미확인 결과를 반환하며 효과를 재생하지 않는다. */
  async handleAgentOperation(member: Member, name: string, args: Record<string, unknown>, context: AgentOperationContext, signal?: AbortSignal): Promise<AgentToolResult> {
    const current = this.store.requireMember(member.id);
    if (current.projectId !== member.projectId) throw new ApiError(404, "팀원을 찾을 수 없습니다", "member_not_found");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(context.operationId)) throw new ApiError(400, "operationId가 잘못되었습니다", "invalid_operation_id");
    let reserved = false;
    const previous = this.store.agentOperation(current.id, name, context.operationId, args, () => {
      reserved = true;
      return { text: "이 작업의 결과를 확인할 수 없습니다. 같은 작업은 자동 재실행하지 않습니다", isError: true };
    });
    const running = this.agentOperations.get(context.operationId);
    if (running) return running;
    // 동기 Store 포트의 두 불변 receipt로 예약과 비동기 결과를 나눈다.
    // ':'는 외부 operation ID에 허용하지 않아 결과 namespace와 충돌하지 않는다.
    const resultId = `agent-result:${context.operationId}`;
    if (!reserved) {
      const missing = Symbol("result_pending");
      try { return this.store.agentOperation(current.id, name, resultId, args, () => { throw missing; }); }
      catch (error) { if (error !== missing) throw error; }
      return previous;
    }
    const execution = this.handleAgentTool(current, name, args, signal).then(result =>
      this.store.agentOperation(current.id, name, resultId, args, () => result),
    ).finally(() => { this.agentOperations.delete(context.operationId); });
    this.agentOperations.set(context.operationId, execution);
    return execution;
  }

  /** Called at the board read boundary; completion only covers the requested revision. */
  noteBoardReview(member: Member, revision = this.store.boardRevision(member.projectId)): void {
    const turn = this.port.turnContext(member.id).turn;
    const runs = this.store.listPendingExecutions().filter(run => run.memberId === member.id);
    const tidy = runs.some(run => run.deliveryIds.some(id => { const delivery = this.store.getDelivery(id); return delivery && isTidy(delivery); }));
    const requestedRevision = turn?.boardReview?.requestedRevision ?? (tidy ? this.store.getBoardReview(member.projectId)?.requestedRevision : undefined);
    if (requestedRevision === undefined) return;
    const reviewedRevision = Math.min(requestedRevision, revision);
    if (turn?.boardReview) turn.boardReview.reviewedRevision = reviewedRevision;
    for (const run of runs) this.store.saveExecutionJournal({ ...run, reason: `board_review:${requestedRevision}:${reviewedRevision}`, updatedAt: new Date().toISOString() });
  }

  private async tools(): Promise<AgentToolsImpl> {
    // agent-tools.ts 가 Orchestrator 의 타입을 쓰므로 정적 import 로 순환시키지 않는다.
    this.agentTools ??= await import("../agent-tools.ts");
    return this.agentTools;
  }

  async askWait(member: Member, decisionId: string, timeoutMs: number, signal?: AbortSignal): Promise<AskWaitResult> {
    const ready = (): AskWaitResult | null => {
      const current = this.store.requireMember(member.id);
      const decision = this.store.requireDecision(decisionId);
      if (decision.projectId !== current.projectId || decision.memberId !== member.id) throw new ApiError(403, "자신이 올린 결재만 기다릴 수 있습니다", "decision_not_own");
      if (signal?.aborted || this.store.requireProject(member.projectId).archived || this.port.archiving(member.projectId) || decision.status === "open") return null;
      const answered = decision.status === "answered" || decision.status === "delivered";
      if (decision.status === "answered") {
        this.materializeManualAnswers(current);
        // An unacknowledged wait batch owns its items. askWait must not consume it.
        if (this.store.manualInbox(member.id, [])?.items.some(item => item.ref?.type === "decision" && item.ref.id === decisionId)) return null;
        const delivery = this.store.listPending(member.id).find(d => d.refType === "decision" && d.refId === decisionId);
        if (delivery) {
          const batch = this.store.manualInbox(member.id, [delivery.id]);
          if (!batch?.items.some(item => item.deliveryId === delivery.id)) return null;
          this.store.acknowledgeManualInbox(member.id, batch.id);
        } else this.store.setDecisionStatus(decisionId, "delivered");
      }
      const text = answered ? formatAnswerFor(decision, this.port.attachmentsFor(current, decision.answerAttachments ?? [])) : formatSystem(`결재가 닫혔습니다${decision.closeReason ? `: ${normalizeSpace(decision.closeReason)}` : ""}. 이 질문의 답은 오지 않습니다 #${decision.id}`);
      this.port.settle(current);
      return { done: true, text, decision: this.store.requireDecision(decisionId) };
    };
    if (signal?.aborted) return { done: false };
    const now = ready();
    if (now) return now;
    await this.waitOn(this.askWaiters, decisionId, Math.min(Math.max(timeoutMs, 0), 50_000), signal);
    return ready() ?? { done: false };
  }

  private refuseOwnerDirectRepeat(target: Member, quote: VerifiedQuote | null): void {
    if (quote?.verified && quote.source) {
      const message = this.store.getMessage(quote.source.id);
      if (message?.mine && message.targetMemberId === target.id && this.store.listDeliveries(target.projectId).some(d =>
        d.memberId === target.id && d.kind === "user_message" && d.refType === "message" && d.refId === message.id &&
        ["queued", "delivering", "delivered"].includes(d.status))) {
        const reason = `대표가 이미 ${target.name}에게 직접 보낸 지시입니다(#${message.id}). 다시 보내지 마세요. 더할 일이 있으면 인용 없이 그 부분만 쓰세요.`;
        this.store.appendActivity(target.id, "system", reason);
        throw new ApiError(409, reason, "owner_direct_repeat");
      }
    }
  }

  /** team_assign. member 는 핸들 또는 화면 이름. 다른 프로젝트 직원은 찾지 못한다. */
  async assign(projectId: string, memberRef: string, input: AssignInput, assignedBy?: Member): Promise<AssignResult> {
    const target = this.port.requireInProject(projectId, memberRef);
    const source = input.userQuote?.trim() ? this.findQuoteSource(projectId, input.userQuote) : null;
    const quote = input.userQuote?.trim() ? { text: input.userQuote, verified: source !== null, source } : null;
    this.refuseOwnerDirectRepeat(target, quote);
    // 마지막 지시가 이긴다. 거절된 지시는 병렬 설정도 바꾸지 않는다.
    if (input.parallel !== undefined) this.port.turnContext(target.id).wantParallel = input.parallel;
    const project = this.store.requireProject(projectId);
    const busy = this.port.isBusy(target);
    const attachments = (input.attachmentIds ?? []).map((id) => {
      const attachment = this.store.getAttachment(id);
      if (!attachment || !this.store.isProjectAttachment(projectId, id)) throw new ApiError(404, `이 프로젝트에서 대표가 보낸 첨부가 아닙니다: ${id}`, "attachment_not_found");
      return attachment;
    });
    // 0.2.7 묶음 1(점검 D5-1): 끼워 넣을 수 없는 실행기(core)에서, 대표 원문을 실은 급한 지시는 안전할 때 하던 턴을 멈추고 넣는다('하던 턴 멈추고 넣기').
    // 그럴 수 없으면 지금처럼 그 턴이 끝나길 기다리고, 그 까닭과 기다림을 도구 응답에 그대로 싣는다(총괄이 '급히 넣었다'고 잘못 말하지 않게).
    const interjects = this.port.interjects(target);
    const blocker = input.urgent && busy && !interjects ? this.port.urgentBlocker(target, quote) : undefined;
    const stopping = blocker === null;
    const delivery = this.store.transaction(() => {
      const delivery = this.store.enqueue({
        projectId,
        memberId: target.id,
        kind: "instruction",
        text: [formatInstruction(target.name, input.text, quote), ...attachmentLines(this.port.attachmentsFor(target, attachments))].join("\n"),
        urgent: input.urgent,
      });
      // 끼워 넣을 수 없는 실행기에서는 긴급도 턴이 끝나야 나간다. 지시한 쪽에 '대기'로 알린다(하던 턴을 멈추고 넣을 때는 대기가 아니다).
      if (assignedBy) { this.store.setDeliveryAuthor(delivery.id, assignedBy.id); this.store.noteDelegation(assignedBy.id, delivery, busy && !(input.urgent && interjects) && !stopping); }
      return delivery;
    });
    const busySince = busy ? this.port.busySince(target.id) : null;
    let urgent: UrgentOutcome | undefined;
    if (stopping) {
      const stopped = await this.port.interruptForUrgent(target, delivery, quote!.source!.id);
      urgent = stopped === "interrupted" ? { outcome: "interrupted" } : stopped === "unconfirmed" ? { outcome: "unconfirmed", busySince }
        : stopped === "no_turn" ? { outcome: "waiting", reason: "no_turn", busySince }
        : stopped ? { outcome: "background", terminals: stopped.background } : { outcome: "waiting", reason: "interrupt_failed", busySince };
      // 멈춘 것을 확인하지 못했으면 그 턴이 멈추거나 끝나야 들어간다: 배정 기록도 '앞 일 끝나면 시작'으로 고친다(검토 뒤).
      if (assignedBy && stopped !== "interrupted") this.store.noteDelegation(assignedBy.id, delivery, true);
    } else if (blocker) urgent = { outcome: "waiting", reason: blocker, busySince };
    const position = busy && urgent?.outcome !== "interrupted" ? this.store.listPending(target.id).length : 0;
    await this.port.pump(target.id);
    // 0.2.7 배포 전 확인(real-cli P1·P2): 턴은 끝났지만 Codex 백그라운드 프로그램 때문에 기다리면 '하던 일이 끝나면'이 아니라 그 사실을 알린다.
    const programs = urgent?.outcome === "background" || this.store.requireDelivery(delivery.id).status === "delivered" ? null : this.port.backgroundPrograms(this.store.requireMember(target.id));
    return { delivery: this.store.requireDelivery(delivery.id), position, verified: quote?.verified ?? null, needsContext: quote ? quoteNeedsContext(quote) : false,
      ...(urgent ? { urgent } : {}), ...(busy && urgent?.outcome !== "interrupted" ? { busySince } : {}), ...(programs ? { backgroundPrograms: programs } : {}) };
  }

  /**
   * 인용이 이 프로젝트의 대표 메시지·결재 답에 (공백 정규화 후) 그대로 있으면 그 글. 총괄의 말은 승인이 아니다.
   * 직원에게 전문·시각·카드 제목을 함께 보내 잘린 인용이나 다른 안건의 답으로 뜻이 뒤집히지 않게 한다.
   */
  findQuoteSource(projectId: string, rawQuote: string): QuoteSource | null {
    const quote = normalizeSpace(rawQuote).replace(/^["'“”‘’](.*)["'“”‘’]$/, "$1").trim();
    if (!quote) return null;
    // "네" 같은 짧은 인용은 다른 글의 일부로 우연히 맞는다. 글 전체가 같아야 한다.
    const matches = (source: string): boolean => {
      const text = normalizeSpace(source);
      return quote.length < SHORT_QUOTE ? text === quote : includesWhole(text, quote);
    };
    for (const d of this.store.listAllDoneDecisions(projectId)) {
      const option = d.options.find((o) => o.k === d.choice);
      // 버튼 글은 대표가 보고 누른 그대로만 친다. 설명·버튼 글의 일부는 직원이 쓴 글이라 대표의 말이 아니다.
      if (option && normalizeSpace(option.label) === quote) return { id: d.id, text: option.label, at: d.answeredAt, card: d.title };
      if (d.note && matches(d.note)) return { id: d.id, text: d.note, at: d.answeredAt };
    }
    for (const todo of this.store.listTodos(projectId)) if (todo.done && todo.completionNote && matches(todo.completionNote)) return { id: todo.id, text: todo.completionNote, at: todo.doneAt, card: todo.title };
    const project = this.store.requireProject(projectId);
    if (project.creationGoal && matches(project.creationGoal)) return { id: project.id, text: project.creationGoal, at: project.createdAt };
    let before: string | undefined;
    for (let page = 0; page < QUOTE_SCAN_PAGES; page++) {
      const messages = this.store.listMessages(projectId, { before, limit: 500 });
      const found = [...messages].reverse().find((m) => m.mine && matches(m.body));
      if (found) return { id: found.id, text: found.body, at: found.at };
      if (messages.length < 500) return null;
      before = messages[0]!.at;
    }
    return null;
  }

  async recordPost(member: Member, input: PostInput): Promise<Message & { systemInstruction?: string }> {
    const rt = this.port.turnContext(member.id);
    if (input.supersedes && input.correctsMessageId && input.supersedes !== input.correctsMessageId) throw new ApiError(400, "정정 대상이 서로 다릅니다", "correction_target_mismatch");
    input = { ...input, correctsMessageId: input.supersedes ?? input.correctsMessageId };
    const files = (input.fileIds ?? []).map((id) => {
      const file = this.store.getFile(id);
      if (!file || file.projectId !== member.projectId) throw new ApiError(404, `자료를 찾을 수 없습니다: ${id}`, "file_not_found");
      return file;
    });
    if (input.decisionId && this.store.getDecision(input.decisionId)?.projectId !== member.projectId) {
      throw new ApiError(404, `결재를 찾을 수 없습니다: ${input.decisionId}`, "decision_not_found");
    }
    // 거부된 호출은 보고가 아니다. 턴 마지막 글의 자동 보고를 막으면 안 된다.
    // v1 웹은 첫 자료와 본문 링크를 계속 사용한다. 전체 목록은 Message.fileIds에도 projection한다.
    const extra = files
      .slice(1)
      .map((f) => `[자료: ${f.title.replace(/[\[\]\\]/g, "\\$&")}](#/p/${encodeURIComponent(member.projectId)}/files/${encodeURIComponent(f.id)})`)
      .join("\n\n");
    if (input.correctsMessageId) {
      const previous = this.store.requireMessage(input.correctsMessageId);
      if (previous.projectId !== member.projectId || previous.memberId !== member.id || previous.mine) throw new ApiError(400, "자신이 작성한 보고만 정정할 수 있습니다", "report_not_own");
    }
    const conductor = member.kind === "worker" ? this.store.getConductor(member.projectId) : null;
    let systemInstruction: string | undefined;
    const { value: message, deliveries } = this.store.withDeliveryIntents(() => this.store.createMessage({
      projectId: member.projectId, memberId: member.id, who: member.name, kind: input.kind,
      title: rt.direct ? `(직접) ${input.title}` : input.title,
      body: [input.body ?? "", extra].filter(Boolean).join("\n\n"), decisionId: input.decisionId ?? null, fileId: files[0]?.id ?? null,
    }), message => {
      this.store.noteDelegationPost(member.id, `${message.title}\n${message.body}`);
      this.store.saveReportReferences(member.projectId, { sourceMessageId: message.id, fileIds: files.map(file => file.id), decisionIds: input.decisionId ? [input.decisionId] : [], authoredAt: message.at, sequence: this.store.boardRevision(member.projectId), correctsMessageId: input.correctsMessageId ?? null });
      if (this.missingApprovalCard(member, input)) {
        systemInstruction = formatSystem(APPROVAL_CARD_INSTRUCTION);
        // post 응답으로 한 번만 돌려준다. 업무 입력을 enqueue하거나 직원을 깨우지 않는다.
        this.store.appendActivity(member.id, "system", systemInstruction, `approval-card:${message.id}`);
      }
      return conductor && conductor.id !== member.id ? [{ projectId: member.projectId, memberId: conductor.id, kind: "report", text: this.reportText(message), wake: WAKE_POST_KINDS.has(input.kind), refType: "message", refId: message.id }] : [];
    });
    rt.posted = true;
    await Promise.all(deliveries.map(d => this.port.pump(d.memberId)));
    return { ...this.store.requireMessage(message.id), ...(systemInstruction ? { systemInstruction } : {}) };
  }

  private missingApprovalCard(member: Member, input: PostInput): boolean {
    const report = `${input.title}\n${input.body ?? ""}`;
    const others = this.store.listMembers(member.projectId).filter(m => m.id !== member.id);
    const requests = approvalRequests(report, others.map(m => m.name));
    if (!requests.length || this.port.turnContext(member.id).turn?.askedDecisionIds?.size) return false;
    // 0.2.7(D3-3): 이 안내를 받은 보고의 정정(정정의 정정도)에는 다시 안내하지 않는다. 정정 글이 다시 걸려 같은 보고가 서너 번 올라왔다.
    if (input.correctsMessageId && this.correctionChainNoticed(member.projectId, input.correctsMessageId)) return false;
    const group = input.group?.trim() || (input.decisionId ? this.store.getDecision(input.decisionId)?.group?.trim() : null);
    const normalizedReport = normalizeSpace(report);
    // 승인을 구하는 그 절이 다른 팀장을 그 승인의 임자로 들면('광고 담당 3 쪽 결재 대기', '디자인 2의 카드') 그 팀장의 열린 카드가 그 절이 말하는 카드다.
    // 이름이 보고 어디에 나오기만 해서는 아니다(검토 지적: '디자인 2 시안 반영 끝, 배포는 대표님 승인 후'의 배포 승인은 디자인 2 의 카드가 아니다).
    const owners = others.filter(m => {
      const name = normalizeSpace(m.name);
      if (name.length < 2) return false;
      const owner = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:이|가|께서|쪽|측|의)(?=[\\s,]|$)`);
      return requests.some(clause => owner.test(normalizeSpace(clause)));
    });
    const mentioned = new Set(owners.map(m => m.id));
    return !this.store.listOpenDecisions(member.projectId).some(decision =>
      decision.memberId === member.id
      || (!!decision.memberId && mentioned.has(decision.memberId))
      || decision.id === input.decisionId
      || new RegExp(`(?<![\\w-])${decision.id}(?![\\w-])`).test(report)
      || (normalizeSpace(decision.title).length >= 2 && normalizedReport.includes(normalizeSpace(decision.title)))
      || (!!group && decision.group?.trim() === group));
  }

  /** 정정 사슬(정정 대상 → 그것이 정정한 글 …)의 어느 글이 이미 결재 누락 안내를 받았는가. */
  private correctionChainNoticed(projectId: string, messageId: string): boolean {
    const seen = new Set<string>();
    for (let id: string | null | undefined = messageId; id && !seen.has(id) && seen.size < 32; id = this.store.getReportReferences(projectId, id)?.correctsMessageId) {
      seen.add(id);
      if (this.store.hasActivityEvent(`approval-card:${id}`)) return true;
    }
    return false;
  }

  reportReferences(projectId: string, messageId: string): ReportReferences {
    const message = this.store.requireMessage(messageId);
    if (message.projectId !== projectId || message.mine || !message.memberId) throw new ApiError(404, "보고를 찾을 수 없습니다", "report_not_found");
    return this.store.getReportReferences(projectId, messageId) ?? { sourceMessageId: message.id, fileIds: message.fileId ? [message.fileId] : [], decisionIds: message.decisionId ? [message.decisionId] : [], authoredAt: message.at, sequence: 0, correctsMessageId: null };
  }

  reportText(message: Message): string {
    const refs = this.reportReferences(message.projectId, message.id);
    const direct = message.title.startsWith("(직접) ");
    return `${formatReport(message.who, direct ? `(직접) ${message.kind}` : message.kind, direct ? message.title.slice(5) : message.title, message.body)}\n보고 원본 #${refs.sourceMessageId} · 작성 ${refs.authoredAt} · 순번 ${refs.sequence}\n자료: ${refs.fileIds.join(", ") || "없음"} · 결재: ${refs.decisionIds.join(", ") || "없음"}${refs.correctsMessageId ? ` · 정정 대상 #${refs.correctsMessageId}` : ""}`;
  }

  /** ask. blocking 이면(manual) 호출자가 askWait 로 기다리고, 아니면 text 를 도구 결과로 돌려준다. */
  async registerAsk(member: Member, input: AskInput): Promise<{ decision: Decision; blocking: boolean; text: string }> {
    // 보관한 프로젝트의 카드는 화면에 없고 답도 409 다. 올리면 세션이 답 없는 대기에 묶인다.
    if (this.store.requireProject(member.projectId).archived || this.port.archiving(member.projectId)) throw new ApiError(409, "프로젝트가 보관되어 대표가 답할 수 없습니다. 묻지 말고 턴을 끝내세요", "ask_project_archived");
    // 0.2.7 묶음 4(D3-5): 대신할 카드는 자기가 올린, 아직 열린 보통 결재만. 도구 승인·사용 한도 카드는 서버가 연 것이라 대신하지 않는다.
    const replaced = input.replaces ? this.store.getDecision(input.replaces) : null;
    if (input.replaces) {
      if (!replaced || replaced.projectId !== member.projectId) throw new ApiError(404, `결재를 찾을 수 없습니다: ${input.replaces}`, "decision_not_found");
      if (replaced.memberId !== member.id || replaced.kind) throw new ApiError(403, "자기가 올린 결재 카드만 대신할 수 있습니다", "decision_not_own");
      if (replaced.status !== "open") throw new ApiError(409, replaced.status === "closed" ? "이미 닫힌 결재입니다. replaces 없이 새로 올리세요" : "대표가 이미 답한 결재입니다. 그 답을 먼저 확인하세요", "decision_closed");
    }
    // 0.2.7 묶음 4(D5-7): 근거 자료가 이미 새 판이 있는 옛 판이면 최신 판을 붙인다. 열린 결재는 판을 갈 때만 옮겨지므로, 그 뒤에 옛 id 로 올린 카드가 옛 글을 가리키지 않게.
    const fileId = input.fileId && this.store.getFile(input.fileId) ? this.store.listFileVersions(input.fileId)[0]!.id : input.fileId;
    const { value: decision, deliveries } = this.store.withDeliveryIntents(() => {
      const decision = this.store.createDecision({
        projectId: member.projectId,
        memberId: member.id,
        who: member.name,
        title: input.title,
        detail: input.detail,
        options: input.options,
        rec: input.rec,
        group: input.group,
        fileId,
        images: input.images,
        replaces: replaced?.id ?? null,
      });
      if (replaced) {
        // 앞 카드를 새 카드에 잇고 같은 거래에서 닫는다. 대표가 옛 카드에 답하는 일(점검 D3-5)이 없다. 대표는 다시 열 수 있다(obsolete).
        this.store.setDecisionReplacedBy(replaced.id, decision.id);
        this.store.closeDecision(replaced.id, { kind: "obsolete", reason: textRef("card.replaced"), by: member.name });
      }
      this.store.createMessage({
        projectId: member.projectId,
        memberId: member.id,
        who: member.name,
        kind: "질문",
        title: input.title,
        body: input.detail ?? "",
        decisionId: decision.id,
        fileId: fileId ?? null,
        attachments: input.images,
      });
      this.store.patchMember(member.id, { status: "waiting" });
      return decision;
    }, decision => {
      const conductor = member.kind === "worker" ? this.store.getConductor(member.projectId) : null;
      return conductor ? [{ projectId: member.projectId, memberId: conductor.id, kind: "system",
        text: formatSystem(`${josa(member.name, "이")} 대표에게 질문했습니다: ${normalizeSpace(input.title)} #${decision.id}${replaced ? ` (앞 카드 #${replaced.id} 를 대신합니다. 앞 카드는 닫혔습니다)` : ""}`), wake: false }] : [];
    });
    if (replaced && member.origin === "manual") this.wakeAll(this.askWaiters, replaced.id);
    const rt = this.port.turnContext(member.id);
    rt.posted = true;
    if (rt.turn) (rt.turn.askedDecisionIds ??= new Set()).add(decision.id);
    this.port.notifyInbox(textRef("notice.decision.title", { name: member.name }), input.title);
    await Promise.all(deliveries.map(d => this.port.pump(d.memberId)));
    const replacedNote = (replaced ? ` 앞 카드 #${replaced.id} 는 닫고 이 카드에 이었습니다.` : this.replaceHint(member, decision, input))
      + (fileId && fileId !== input.fileId ? ` 근거 자료 #${input.fileId} 는 새 판이 있어 최신 판 #${fileId} 를 붙였습니다.` : "");
    if (member.origin === "manual") return { decision, blocking: true, text: `질문 #${decision.id} 등록됨.${replacedNote} 답을 기다립니다` };
    return { decision, blocking: false, text: `질문 #${decision.id} 등록됨.${replacedNote} 턴을 끝내세요. 답은 다음 입력으로 옵니다` };
  }

  /** detail 이 자기의 다른 열린 카드를 대신한다고 쓰는데 replaces 가 없으면, 그 카드가 열린 채라고 알린다. */
  private replaceHint(member: Member, decision: Decision, input: AskInput): string {
    const text = `${input.title}\n${input.detail ?? ""}`;
    if (!REPLACE_WORDS.test(text)) return "";
    const mentioned = this.store.listOpenDecisionsByMember(member.id).filter(d => d.id !== decision.id && text.includes(d.id));
    if (!mentioned.length) return "";
    return ` 이 카드가 대신한다고 쓴 ${mentioned.map(d => `#${d.id}`).join(", ")} 는 아직 열려 있습니다. 대신하는 카드면 ask_close 로 그 카드를 obsolete 로 닫으세요(다음부터는 ask 의 replaces 에 앞 카드 id 를 넣으면 한 번에 닫힙니다).`;
  }

  /**
   * 0.2.7 묶음 4(D3-5): todo_update. 열린 할 일의 제목·내용을 고친다(닫고 새로 올리지 않는다). 직원은 자기가 부탁한 것만.
   * 새 알림(푸시)은 없다. 대표 화면의 할 일이 그 자리에서 바뀐다.
   */
  updateTodo(member: Member, input: { id: string; title?: string; detail?: string }): { todo: Todo; changed: boolean } {
    const todo = this.store.getTodo(input.id);
    if (!todo || todo.projectId !== member.projectId) throw new ApiError(404, `할 일을 찾을 수 없습니다: ${input.id}`, "todo_not_found");
    if (member.kind === "worker" && todo.memberId !== member.id) throw new ApiError(403, "직원은 자기가 부탁한 할 일만 고칠 수 있습니다", "todo_not_own");
    if (todo.done) throw new ApiError(409, "이미 끝났거나 정리된 할 일입니다. 다시 필요하면 todo 로 새로 부탁하세요", "todo_finished");
    return this.store.updateTodo(todo.id, { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.detail !== undefined ? { detail: input.detail } : {}) });
  }

  /**
   * ask_close. decided는 검증된 대표 글 또는 같은 안건에서 실제 답한 결재의 원문으로만 닫는다.
   * 짧은 버튼 글만으로는 닫지 않는다. 답한 결재 ID·안건 연결·실제 답을 함께 검증하고 감사 기록을 남긴다.
   * 닫으면 물은 직원에게 깨우지 않고 알리고, ask 를 기다리던 직접 띄운 CLI 는 풀어 준다.
   */
  async closeDecision(member: Member, request: { id: string; kind: "decided" | "obsolete"; reason: string; userQuote?: string; answeredDecisionId?: string; sameIssue?: string; followUp: DecisionCloseFollowUp }): Promise<Decision> {
    if (this.store.requireDecision(request.id).kind === "usage_limit") throw new ApiError(403, "사용 한도 알림은 대표만 닫을 수 있습니다", "usage_notice_owner_only");
    // K(E2): 도구 승인 카드는 대표만 답한다. AI 가 닫으면 대표가 볼 승인 요청이 사라진다.
    if (this.store.requireDecision(request.id).kind === "tool_permission") throw new ApiError(403, "도구 승인 요청은 대표만 답할 수 있습니다", "tool_permission_owner_only");
    return this.closeAsk(member, request);
  }

  async closeAsk(member: Member, input: { id: string; kind: DecisionCloseKind; reason: string; userQuote?: string; answeredDecisionId?: string; sameIssue?: string; followUp?: DecisionCloseFollowUp }): Promise<Decision> {
    const decision = this.store.getDecision(input.id);
    if (!decision || decision.projectId !== member.projectId) throw new ApiError(404, `결재를 찾을 수 없습니다: ${input.id}`, "decision_not_found");
    if (member.kind === "worker" && decision.memberId !== member.id) throw new ApiError(403, "직원은 자기가 올린 결재만 닫을 수 있습니다", "decision_not_own");
    if (decision.status !== "open") throw new ApiError(409, decision.status === "closed" ? "이미 닫힌 결재입니다" : "대표가 이미 답한 결재입니다. 닫지 않습니다", "decision_closed");
    const reason = normalizeSpace(input.reason);
    let quote: string | null = null;
    let sourceId: string | null = null;
    let answered: Decision | null = null;
    if (input.answeredDecisionId) {
      if (input.kind !== "decided") throw new ApiError(400, "answered_decision_id는 decided에만 쓸 수 있습니다", "decision_close_invalid");
      answered = this.store.requireDecision(input.answeredDecisionId);
      if (answered.projectId !== member.projectId || !["answered", "delivered"].includes(answered.status) || !answered.answeredAt) throw new ApiError(409, "같은 프로젝트에서 대표가 실제로 답한 결재만 근거로 쓸 수 있습니다", "decision_close_evidence_invalid");
      if (!(decision.group?.trim() && decision.group === answered.group) && (member.kind === "worker" || !input.sameIssue?.trim())) throw new ApiError(409, "같은 그룹이거나 총괄이 same_issue에 같은 안건인 이유를 명시해야 합니다", "decision_close_group_mismatch");
      quote = formatAnswer(answered);
    } else if (input.kind === "decided") {
      const raw = input.userQuote?.trim();
      if (!raw) throw new ApiError(400, "decided 로 닫으려면 user_quote 에 대표가 정한 말을 글자 그대로 실어야 합니다. 대표가 아직 정하지 않았으면 닫지 마세요", "decision_close_quote_required");
      const source = this.findQuoteSource(member.projectId, raw);
      if (!source) throw new ApiError(409, "인용을 대표 글에서 찾지 못해 닫지 않았습니다. 대표가 정하지 않았으면 그대로 두세요", "decision_close_quote_not_found");
      if (quoteNeedsContext({ text: raw, verified: true, source })) throw new ApiError(409, "버튼 글이나 아주 짧은 글은 이 결재를 정했다는 근거가 못 되어 닫지 않았습니다. 대표가 이 일을 정한 문장을 인용하세요", "decision_close_quote_weak");
      quote = normalizeSpace(raw);
      sourceId = source.id;
    }
    const followUp = input.followUp;
    if (followUp?.kind === "instruction") {
      const target = this.store.requireMember(followUp.memberId);
      if (target.projectId !== member.projectId || !followUp.text.trim()) throw new ApiError(400, "후속 지시의 대상·내용을 확인하세요", "follow_up_invalid");
      if ("sourceDecisionId" in followUp) {
        if (!answered || followUp.sourceDecisionId !== answered.id) throw new ApiError(409, "후속 지시의 대표 답이 닫기 근거와 다릅니다", "follow_up_mismatch");
      } else {
        const source = this.store.requireMessage(followUp.sourceMessageId);
        if (answered || source.projectId !== member.projectId || !source.mine) throw new ApiError(400, "후속 지시의 대표 원문을 확인하세요", "follow_up_invalid");
        if (input.kind === "decided" && source.id !== sourceId) throw new ApiError(409, "후속 지시의 대표 원문이 닫기 근거와 다릅니다", "follow_up_mismatch");
        this.refuseOwnerDirectRepeat(target, { text: input.userQuote ?? source.body, verified: true,
          source: { id: source.id, text: source.body, at: source.at } });
      }
    }
    const closed = this.store.transaction(() => {
      const closed = this.store.closeDecision(decision.id, { kind: input.kind, reason, by: member.name, quote });
      if (answered) {
        this.store.auditDecisionClose(decision.id, answered.id, member.id, input.sameIssue?.trim() ?? null, quote!);
        this.store.appendActivity(member.id, "system", input.sameIssue
          ? textRef("activity.decision_closed_by_answer", { id: decision.id, answer: answered.id, issue: input.sameIssue })
          : textRef("activity.decision_closed_by_answer_group", { id: decision.id, answer: answered.id }), `decision-close:${decision.id}:${decision.updatedAt}`);
        const target = decision.memberId ? this.store.getMember(decision.memberId) : null;
        if (target) this.store.enqueue({ projectId: decision.projectId, memberId: target.id, kind: "system", text: formatSystem(`같은 안건의 결재 #${decision.id}는 대표가 답한 결재 #${answered.id}에 따라 닫혔습니다. 대표 답 원문:\n${quote}`), wake: false });
      }
      if (followUp) {
        this.store.setDecisionFollowUp(decision.id, followUp);
        if (followUp.kind === "instruction") {
          const source = "sourceMessageId" in followUp ? this.store.requireMessage(followUp.sourceMessageId) : null;
          const original = source ? { id: source.id, text: source.body, at: source.at } : { id: answered!.id, text: quote!, at: answered!.answeredAt! };
          const delivery = this.store.enqueue({ projectId: member.projectId, memberId: followUp.memberId, kind: "instruction", text: formatInstruction(member.name, `${followUp.text}\n결재 #${decision.id} 닫기의 후속 지시`, { text: source ? input.userQuote ?? source.body : quote!, verified: true, source: original }) });
          this.store.noteDelegation(member.id, delivery, this.port.isBusy(this.store.requireMember(followUp.memberId)));
          this.store.afterCommit(() => { void this.port.pump(followUp.memberId); });
        }
      }
      return closed;
    });
    const why = `${reason}${sourceId ? ` (대표가 이미 정함, 대표 글 #${sourceId})` : answered ? ` (대표 답 #${answered.id})` : ""}`;
    const asker = decision.memberId ? this.store.getMember(decision.memberId) : null;
    if (asker?.origin === "manual") this.wakeAll(this.askWaiters, decision.id);
    if (asker && asker.id !== member.id && asker.origin !== "manual" && !answered) {
      await this.port.deliver({ projectId: decision.projectId, memberId: asker.id, kind: "system", text: formatSystem(`결재 #${decision.id} 가 닫혔습니다: ${why}. 질문 '${quotedInline(decision.title)}' 의 답은 오지 않습니다`), wake: false });
    }
    if (asker && asker.origin !== "manual") this.port.refreshWaiting(asker.id);
    // 직원이 스스로 닫았으면 총괄의 판도 맞춘다.
    const lead = this.store.getConductor(decision.projectId);
    if (lead && lead.id !== member.id && lead.id !== asker?.id) {
      await this.port.deliver({ projectId: decision.projectId, memberId: lead.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 결재 #${decision.id} 를 닫았습니다: ${why} (질문 '${quotedInline(decision.title)}')`), wake: false });
    }
    return closed;
  }

  /** todo_close. 대표의 할 일을 끝남·필요 없어짐으로 정리한다. 직원은 자기가 부탁한 할 일만. 부탁한 직원에게 깨우지 않고 알린다. */
  async closeTodo(member: Member, input: { id: string; outcome: TodoOutcome; reason: string }): Promise<Todo> {
    const todo = this.store.getTodo(input.id);
    if (!todo || todo.projectId !== member.projectId) throw new ApiError(404, `할 일을 찾을 수 없습니다: ${input.id}`, "todo_not_found");
    if (member.kind === "worker" && todo.memberId !== member.id) throw new ApiError(403, "직원은 자기가 부탁한 할 일만 정리할 수 있습니다", "todo_not_own");
    const reason = normalizeSpace(input.reason);
    const closed = this.store.closeTodo(todo.id, { outcome: input.outcome, reason, by: member.name });
    const label = input.outcome === "done" ? "끝남" : "필요 없어짐";
    const requester = todo.memberId ? this.store.getMember(todo.memberId) : null;
    if (requester && requester.id !== member.id) {
      // 대표가 체크를 풀면 '아직 안 했음'이 이 글을 바로잡도록 할 일에 잇는다.
      await this.port.deliver({ projectId: todo.projectId, memberId: requester.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 대표의 할 일 #${todo.id} 를 정리했습니다(${label}): ${reason} (할 일 '${quotedInline(todo.title)}')`), wake: false, refType: "todo", refId: todo.id });
    }
    const lead = this.store.getConductor(todo.projectId);
    if (lead && lead.id !== member.id && lead.id !== requester?.id) {
      await this.port.deliver({ projectId: todo.projectId, memberId: lead.id, kind: "system", text: formatSystem(`${josa(member.name, "이")} 대표의 할 일 #${todo.id} 를 정리했습니다(${label}): ${reason} (할 일 '${quotedInline(todo.title)}')`), wake: false });
    }
    return closed;
  }

  setMemberStatus(member: Member, now: string, next?: string): Member {
    return this.store.patchMember(member.id, { now: normalizeSpace(now), ...(next !== undefined ? { next: normalizeSpace(next) } : {}) });
  }

  setProjectNow(projectId: string, text: string): Project {
    return this.store.patchProject(projectId, { now: text });
  }

  setWork(projectId: string, input: { id?: string; sec: WorkSec; title: string; detail?: string; who?: string }): WorkItem {
    return this.store.upsertWork({ projectId, ...input });
  }

  /** 직접 띄운 CLI 의 wait. 밀린 지시를 한 글로 묶어 돌려준다. 없으면 null. */
  async waitInbox(member: Member, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    const first = this.takeInbox(member);
    if (first) return first;
    await this.waitOn(this.inboxWaiters, member.id, timeoutMs, signal);
    // 끊긴 연결로 응답을 보내면 지시가 받은 것으로 표시된 채 사라진다.
    if (signal?.aborted) return null;
    return this.takeInbox(member);
  }

  private materializeManualAnswers(member: Member): void {
    if (this.store.requireProject(member.projectId).archived || this.port.archiving(member.projectId)) return;
    this.store.transaction(() => {
      for (const decision of this.store.listUnreceivedAnswers(member.id)) {
        if (!this.store.listDeliveries(member.projectId).some(d => d.refType === "decision" && d.refId === decision.id && d.memberId === member.id)) this.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "answer", text: formatAnswerFor(decision, this.port.attachmentsFor(member, decision.answerAttachments ?? [])), refType: "decision", refId: decision.id });
      }
    });
  }

  async manualInbox(memberId: string, timeoutMs: number, signal?: AbortSignal): Promise<ManualInboxBatch | null> {
    const take = () => {
      const member = this.store.requireMember(memberId);
      if (member.origin !== "manual") throw new ApiError(409, "직접 띄운 직원만 수신함을 사용할 수 있습니다", "manual_inbox_only");
      if (signal?.aborted || this.store.requireProject(member.projectId).archived || this.port.archiving(member.projectId)) return null;
      this.materializeManualAnswers(member);
      return this.store.manualInbox(memberId);
    };
    if (signal?.aborted) return null;
    const first = take();
    if (first) return first;
    await this.waitOn(this.inboxWaiters, memberId, Math.min(Math.max(timeoutMs, 0), 50_000), signal);
    return take();
  }

  async acknowledgeManualInbox(memberId: string, request: ManualInboxAckRequest): Promise<ManualInboxAckResult> {
    const member = this.store.requireMember(memberId);
    this.port.requireActive(this.store.requireProject(member.projectId));
    if (member.origin !== "manual") throw new ApiError(409, "직접 띄운 직원만 수신함을 사용할 수 있습니다", "manual_inbox_only");
    const result = this.store.acknowledgeManualInbox(memberId, request.batchId);
    this.port.reconcileTodoCorrections();
    for (const item of this.store.getManualInboxBatch(memberId, request.batchId)!.items) if (item.ref?.type === "decision") this.wakeAll(this.askWaiters, item.ref.id);
    return result;
  }

  /** v1 compatibility: delivery and ACK are inseparable in the old string response. */
  private takeInbox(member: Member): string | null {
    if (this.store.requireProject(member.projectId).archived || this.port.archiving(member.projectId)) return null;
    this.materializeManualAnswers(member);
    const batch = this.store.manualInbox(member.id);
    if (!batch) return null;
    this.store.acknowledgeManualInbox(member.id, batch.id);
    this.port.reconcileTodoCorrections();
    return batch.items.map(item => item.text).join("\n\n");
  }

  private waitOn(table: Map<string, Set<() => void>>, key: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((done) => {
      if (this.port.closed() || signal?.aborted) return done();
      const waiters = table.get(key) ?? new Set<() => void>();
      table.set(key, waiters);
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        waiters.delete(finish);
        if (waiters.size === 0 && table.get(key) === waiters) table.delete(key);
        done();
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
      waiters.add(finish);
    });
  }

  private wakeAll(table: Map<string, Set<() => void>>, key: string): void {
    for (const wake of [...(table.get(key) ?? [])]) wake();
  }
}

/**
 * 인용이 낱말 경계에 맞게 들어 있는가. '삭제는 하지 마'에서 '삭제'만 잘라 오면 조사에서 끊겨 맞지 않는다.
 * 공백·문장 부호에서 시작하고 끝나야 한다.
 */
function includesWhole(text: string, quote: string): boolean {
  const boundary = /[\s.,!?;:…·"'“”‘’()[\]{}<>~\-—–/]/;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const before = at === 0 ? " " : text[at - 1]!;
    const after = at + quote.length >= text.length ? " " : text[at + quote.length]!;
    if (boundary.test(before) && boundary.test(after)) return true;
  }
  return false;
}
