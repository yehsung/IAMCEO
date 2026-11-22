// Gemini(Antigravity CLI, `agy`) 팀장의 턴 오류를 장애·사용 한도·인증·그 밖으로 가른다(Claude·Codex 의 classifyTurnError 와 같은 갈래).
//
// 근거(조사 parity/limits, agy 1.5.14):
// - 실측(헤드리스): 연결이 끊기면 agy 가 스스로 9번(약 140초) 재시도한 뒤 턴을 끝낸다. 그때 Stop 훅의 terminationReason 은 "ERROR",
//   error 는 `generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/…": unexpected EOF`,
//   화면·결과 글은 "There was a network issue connecting to the server, please try again." 이다.
//   /usage 를 죽은 프록시로 부르면 `… proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused`.
// - 실행 파일의 변경 기록: 일시적 오류(5xx, 분당 429, 스트림 끊김)는 agy 가 스스로 재시도하고(서버가 준 대기 최대 4분), 계정 한도(주간·개인 할당량·
//   지출 상한·선불 잔액)는 재시도 없이 곧바로 턴을 끝낸다. 크레딧까지 바닥나면 "Your AI credits balance is too low to continue."
// - 실행 파일 안 agy 자기 규칙(스웜 보드): `QUOTA_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i`.
// - 1.5.14 대화형 실측(agy-real net2): 장애로 끝난 턴의 OSC 는 error, msg 'There was a network issue connecting to the server, please try again.'(화면의 ⚠ 줄과 같은 글),
//   Stop 은 ERROR, error 'generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": unexpected EOF'
//   로 헤드리스와 같다. 그 전 약 133초 동안 진행 줄 'Model unavailable (attempt N/9), retrying in Ns...' 를 보인다(core.ts 가 network_retry 관측으로 쓴다).
//   처음부터 연결 없이 띄운 agy 는 첫 글에 곧바로 OSC error 'failed to construct executor: plan model not specified; you must specify a valid model' 이고
//   훅이 하나도 돌지 않는다(모델 목록을 못 받음). 이 글은 모델 설정 오류와 구별되지 않아 '그 밖'(일반 오류)으로 둔다.
// UNVERIFIED-INTERACTIVE: 한도로 끝난 턴의 OSC 글과 Stop error 글은 아직 보지 못했다(한도를 유도하지 못했다).
// 아래 한도 문구는 실행 파일에 든 글이고, 장애 문구는 실측 글이다. 모르는 글은 '그 밖'(일반 오류)이다: 지금까지처럼 오류로 알린다(퇴보 없음).
import type { TurnErrorKind } from "./api-outage.ts";

/** agy 가 모델·한도·계정을 묻는 곳(실측 프록시 기록). 장애 탐침이 Gemini 팀장이 있을 때 이 주소에 닿는지 본다(어떤 HTTP 답이든 닿은 것이다). */
export const GEMINI_PROBE_URL = "https://daily-cloudcode-pa.googleapis.com";

const AUTH = /UNAUTHENTICATED|\b401\b|not logged in|Sign in required|token (?:has )?expired|refresh token|invalid_grant|Verification required|Eligibility check failed/i;
/**
 * 사용 한도. agy 자기 규칙(QUOTA_RE)에 실행 파일의 한도 문구를 더했다.
 * UNVERIFIED-INTERACTIVE: "You have exhausted your quota on this model." 등 대화형 화면의 실제 글은 첫 설정 뒤 확인한다.
 */
const USAGE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit|AI credits balance is too low|MODEL_QUOTA_EXHAUSTED|spend.?(?:cap|limit)|prepaid balance|weekly limit|5-hour limit|five.hour limit/i;
/** 할당량(계정 한도)이라고 글이 직접 말하는 것. 이것 없이 429·rate limit·RESOURCE_EXHAUSTED 뿐이면 분당 한도일 수 있다(geminiTransientLimit). */
const QUOTA_WORDS = /quota|exhausted your capacity|AI credits balance|MODEL_QUOTA_EXHAUSTED|spend.?(?:cap|limit)|prepaid balance|weekly limit|5-hour limit|five.hour limit/i;
/**
 * 연결 자체가 안 된 것(서버의 답을 받지 못했다). 이런 글은 '할당량'이라는 낱말이 섞여 있어도(예: `/usage failed: retrieving quota summary: … connection refused`)
 * 한도일 수 없다: 한도보다 먼저 본다.
 */
const TRANSPORT = /There was a network issue connecting to the server|unexpected EOF|connection (?:refused|reset)|proxyconnect|dial tcp|no such host|network is (?:down|unreachable)|i\/o timeout|TLS handshake|http2: client connection|broken pipe/i;
/**
 * 서버가 답은 했지만 잠깐 못 받는 것(agy 가 재시도를 다 쓰고 끝낸 것). "request failed" 만 있는 글은 4xx 응답 코드가 함께 있으면 연결 문제가 아니다.
 * 모델 용량 부족(MODEL_CAPACITY_EXHAUSTED, Model unavailable, overloaded)은 Claude 의 overloaded·529 처럼 장애 쪽이다(잠시 뒤 다시 하면 된다).
 */
const NETWORK = /deadline exceeded|\b50[0234]\b|\bUNAVAILABLE\b|overloaded|Model unavailable|MODEL_CAPACITY_EXHAUSTED|capacity constraints/i;
const REQUEST_FAILED = /request failed/i;
const CLIENT_ERROR = /\b4(?:0\d|1\d|2[0-8])\b/;

/**
 * Gemini 턴 오류의 갈래. 차례로 인증 → 연결 자체의 실패 → 사용 한도 → 장애(서버 쪽) → 그 밖이다(Claude·Codex 의 classifyTurnError 와 같은 갈래).
 * 같은 글이면 늘 같은 답이다(실행 기록의 reason 으로 다시 물어도 같다).
 */
export function classifyGeminiTurnError(text: string): TurnErrorKind {
  if (AUTH.test(text)) return "auth";
  if (TRANSPORT.test(text)) return "network";
  if (USAGE.test(text)) return "usage_limit";
  if (NETWORK.test(text)) return "network";
  if (REQUEST_FAILED.test(text) && !CLIENT_ERROR.test(text)) return "network";
  return "error";
}

/**
 * 한도 글이 할당량을 말하지 않고 429·rate limit·RESOURCE_EXHAUSTED 만 말하는가. agy 는 분당 한도를 4분까지 스스로 기다리므로 이런 글은 대개 계정 한도지만,
 * 그 팀장의 한도 묶음이 하나도 바닥나지 않았다고 상태줄이 알리면 잠깐의 용량 제한으로 본다(부르는 쪽이 장애로 다룬다).
 */
export function geminiTransientLimit(text: string): boolean {
  return classifyGeminiTurnError(text) === "usage_limit" && !QUOTA_WORDS.test(text);
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 오류 글 하나의 상한(대표에게 보이는 글, 실행 기록의 reason). */
export const GEMINI_ERROR_TEXT_MAX = 600;

/**
 * agy 의 OSC 7501 보고 글. 1.5.14 의 원시 보고는 base64 였다(막힘 msg 실측). 실행 엔진이 풀어 주면 그대로 온다: 둘 다 같은 글로 읽는다.
 * 풀린 글이 제어 문자 없는 글일 때만 푼 것을 쓴다(우연히 base64 모양인 짧은 낱말을 깨뜨리지 않게: 4자 이상, 512자 이하).
 */
export function geminiReportedText(msg: string | null | undefined): string | null {
  if (typeof msg !== "string" || !msg.trim()) return null;
  const text = msg.trim();
  if (text.length >= 8 && text.length <= 2048 && BASE64.test(text)) {
    try {
      const decoded = Buffer.from(text, "base64").toString("utf8").trim();
      if (decoded && !/[\u0000-\u0008\u000b-\u001f\u007f�]/.test(decoded) && /[ .:,]/.test(decoded)) return decoded;
    } catch { /* base64 가 아니다 */ }
  }
  return text;
}

/** 오류 글을 한 줄로 다듬는다: 제어 문자를 칸으로, 메일 주소를 <email> 로, 상한에서 자른다. */
export function cleanGeminiError(text: string, max = GEMINI_ERROR_TEXT_MAX): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(EMAIL, "<email>").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Gemini 턴이 오류로 끝났을 때 대표·총괄·실행 기록에 남길 글: OSC 보고 글(풀어서)과 그 턴의 Stop 훅 error 발췌를 ' · ' 로 잇는다(같은 글은 한 번).
 * 둘 다 없으면 'CLI reported an error'(지금까지와 같다). 이 글이 classifyGeminiTurnError 의 입력이다.
 * 예: "There was a network issue connecting to the server, please try again. · generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/…": unexpected EOF"
 */
export function geminiTurnErrorText(parts: { oscMsg?: string | null; stopError?: string | null }): string {
  const seen: string[] = [];
  for (const raw of [geminiReportedText(parts.oscMsg), parts.stopError]) {
    if (!raw) continue;
    const text = cleanGeminiError(raw);
    if (!text || seen.some(item => item === text || item.includes(text))) continue;
    for (let i = seen.length - 1; i >= 0; i--) if (text.includes(seen[i]!)) seen.splice(i, 1);
    seen.push(text);
  }
  return seen.length ? cleanGeminiError(seen.join(" · ")) : "CLI reported an error";
}
