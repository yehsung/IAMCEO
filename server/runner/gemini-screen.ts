// Antigravity CLI(`agy`) 화면과 상태 보고 해석: 입력칸 판독, 승인 창 모양, 첫 설정·로그인 막힘.
//
// 여기 적은 화면 모양은 실제 화면을 받아 본 것이 아니다. 공식 문서의 그림(입력칸 위·아래 가로줄, `> ` 입력 줄, 그 아래 상태줄)과
// agy 1.5.14 실행 파일에 든 문구를 바탕으로 했다. 원칙은 '모르면 null' 이다: 조금이라도 다른 화면은 입력칸으로 보지 않고 글을 넣지 않는다.
// 실제 화면 견본을 얻으면 아래 상수와 정규식만 고치면 된다(판독 순서는 geminiDraft 하나에 있다).
//
//   ──────────────────────────────  가로줄
//   > 입력한 글 또는 자리표시 글
//   ──────────────────────────────  가로줄
//   IAMCEO · Gemini 4 Argon · ctx 14%      ← IAMCEO 상태줄 래퍼(gemini-statusline.ts)가 그리는 줄
//   ? for shortcuts        auto · Gemini 4 Argon · high   ← 상태줄을 주지 않았을 때 agy 의 기본 줄

import { ERROR_CODES } from "../../shared/error-codes.ts";

/** 입력칸 위·아래의 가로줄. 줄 전체가 이 글자뿐이어야 한다. */
export const GEMINI_RULE = /^\s*[─━]{8,}\s*$/;
/** 입력칸의 첫 줄(`> 글`, 빈 칸이면 `>`). */
export const GEMINI_PROMPT = /^\s*>(?: (.*))?$/;
/** 바닥줄 ①: IAMCEO 상태줄 래퍼의 줄. `IAMCEO`, `IAMCEO · <모델 이름>`, `IAMCEO · <모델 이름> · ctx <N>%`. */
export const GEMINI_STATUS_OURS = /^\s*IAMCEO(?: · \S.*)?$/;
/** 바닥줄 ②: agy 의 기본 상태줄. 승인·선택 창에서는 이 자리가 `esc to cancel` 로 바뀐다(문서 그림). */
export const GEMINI_STATUS_DEFAULT = /^\s*\? for shortcuts(?:\s.*)?$/;
/** 입력칸 아래에 올 수 있는 바닥줄 수의 상한. 넘으면 모르는 화면이다. */
export const GEMINI_STATUS_MAX_LINES = 3;
/** 입력칸 한 칸의 줄 수 상한(여러 줄 초안). 넘으면 모르는 화면이다. */
export const GEMINI_DRAFT_MAX_LINES = 60;
/**
 * 빈 입력칸에 흐리게 보이는 자리표시 글. terminal.read 는 색이 없는 글이라 사람이 똑같이 친 글과 구별되지 않는다(Codex 의 자리표시 글과 같다).
 * 첫 줄(auto)은 공식 문서에 적힌 글이다. 나머지 셋은 agy 1.5.14 실행 파일에 든 글이고 화면에서 본 적은 없다.
 * 권한을 '전부 묻기'로 띄웠을 때(agentMode "")의 자리표시 글은 아직 모른다: 그때 글이 보이면 초안으로 읽혀 넣지 않는다.
 */
export const GEMINI_PLACEHOLDERS: readonly string[] = [
  "Auto mode: edits & safe commands auto-approved (shift+tab to cycle)",
  "Accept-edits mode: file edits auto-approved (shift+tab to cycle)",
  "Plan mode: research & plan only (shift+tab to cycle)",
  "Best-of-N mode: fork into parallel arms and pick a winner (shift+tab to cycle)",
];
/** 승인·선택 창의 고른 줄(`> 1. Yes, accept this change`). 안내에만 쓴다(키를 보내는 근거가 아니다). */
export const GEMINI_SELECTED_OPTION = /^\s*>\s*\d+\.\s+\S/;
/**
 * agy 가 OSC 7501 로 알리는 막힘의 글(msg) 가운데 '이 Mac 에서 사람이 끝내야 하는 설정'을 뜻하는 것(1.5.14 실측).
 * "Sign in required"(kind auth): 브라우저 로그인이 필요하다. "Finish setup"(kind question): 색상·약관·데이터 수집 동의가 남았다.
 */
export const GEMINI_SETUP_MESSAGES: readonly string[] = ["Finish setup", "Sign in required"];
/** 관측 메모의 코드와 문장(statusObservation.error). 문장은 오류 표의 대표 문장(observation_gemini_setup)이다: 앱은 영어 화면에서 코드로 영어 문장을 고른다. */
export const GEMINI_SETUP_CODE = "gemini_setup";
export const GEMINI_SETUP_NOTE = ERROR_CODES.observation_gemini_setup.ko;

const strip = (screen: string): string => screen.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

/**
 * agy 입력칸에 쓰인 글. 빈 문자열이면 빈 칸(자리표시 글 포함), null 이면 입력칸을 알아보지 못했다(승인 창·첫 설정 화면·모르는 모양).
 * 화면 맨 아래에서 위로 [바닥줄 1~3줄] → 가로줄 → 입력 줄들 → 가로줄 순서가 정확히 맞을 때만 읽는다:
 * - 바닥줄은 IAMCEO 상태줄이나 agy 기본 상태줄(`? for shortcuts`)뿐이어야 한다. 다른 줄이 하나라도 섞이면 null.
 * - 아래 가로줄과 바닥줄 사이, 가로줄과 입력 줄 사이에 빈 줄이 없어야 한다.
 * - 입력 줄의 첫 줄은 `>` 로 시작한다. 여러 줄 초안의 이어진 줄은 그대로 잇는다.
 * 입력 안전에만 쓴다: 이 값이 "" 일 때만 서버가 글을 넣는다. 상태(쉬는 중)는 따로 OSC 보고로 확인한다.
 */
export function geminiDraft(screen: string): string | null {
  const lines = strip(screen).split("\n").map(line => line.replace(/\s+$/, ""));
  let at = lines.length - 1;
  while (at >= 0 && !lines[at]) at--;
  let status = 0;
  while (at >= 0 && (GEMINI_STATUS_OURS.test(lines[at]!) || GEMINI_STATUS_DEFAULT.test(lines[at]!))) { status++; at--; }
  if (status < 1 || status > GEMINI_STATUS_MAX_LINES) return null;
  if (at < 2 || !GEMINI_RULE.test(lines[at]!)) return null;
  const bottom = at;
  let top = bottom - 1;
  while (top >= 0 && !GEMINI_RULE.test(lines[top]!)) top--;
  if (top < 0 || bottom - top - 1 < 1 || bottom - top - 1 > GEMINI_DRAFT_MAX_LINES) return null;
  const first = GEMINI_PROMPT.exec(lines[top + 1]!);
  if (!first) return null;
  // 초안 안에 가로줄만 있는 줄이 있으면(표·인용을 붙여 넣은 글) 위에서 찾은 가로줄이 입력칸의 위쪽 줄이 아니라 초안 속 줄일 수 있다.
  // 그 가로줄에 **바로 이어 붙은** 위쪽 구간(빈 줄 없이 이어진 줄들)이 '가로줄 + `>` 로 시작하는 줄'로 시작하면 어느 쪽이 입력칸인지 모른다:
  // 빈 칸으로 읽지 않는다. 빈 줄을 만나면 멈춘다: 그 위의 지난 글(지난 입력이 상자로 남은 모양, 답 안의 인용)은 입력칸이 아니라서
  // 거기까지 걸러 내면 그런 글이 화면에 보이는 동안 전달이 멈춘다.
  for (let above = top - 1; above >= 0 && top - above <= GEMINI_DRAFT_MAX_LINES && lines[above]; above--) {
    if (!GEMINI_RULE.test(lines[above]!)) continue;
    if (GEMINI_PROMPT.test(lines[above + 1]!)) return null;
    break;
  }
  const rows = [first[1]?.trim() ?? "", ...lines.slice(top + 2, bottom).map(line => line.trim())];
  // 좁은 칸에서는 자리표시 글이 다음 줄로 접힌다. 이어 붙인 글 전체가 자리표시 글일 때만 빈 칸이다.
  const whole = rows.filter(Boolean).join(" ");
  if (GEMINI_PLACEHOLDERS.includes(whole)) return "";
  return rows.join("\n").trim();
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** 상태 보고의 글. 실행 엔진이 base64 를 풀어 주든 그대로 주든 같은 글로 읽는다(1.5.14 의 원시 보고는 base64 였다). */
function reportedText(msg: string | null | undefined): string[] {
  if (typeof msg !== "string" || !msg.trim()) return [];
  const text = msg.trim();
  const out = [text];
  if (text.length >= 4 && text.length <= 512 && BASE64.test(text)) {
    try {
      const decoded = Buffer.from(text, "base64").toString("utf8").trim();
      if (decoded && !/[\u0000-\u001f\u007f�]/.test(decoded)) out.push(decoded);
    } catch { /* base64 가 아니다 */ }
  }
  return out;
}

/**
 * agy 가 '로그인·첫 설정이 필요하다'고 막혀 있는가. 막힘(blocked) 보고이고, 종류가 auth 이거나 글이 GEMINI_SETUP_MESSAGES 가운데 하나일 때다.
 * 이 화면에는 서버가 어떤 키도 보내지 않는다(약관·데이터 수집 동의와 브라우저 로그인은 사람만 한다). 알리기만 한다.
 */
export function geminiSetupBlocked(status: { state?: string; kind?: string | null; msg?: string } | null | undefined): boolean {
  if (!status || status.state !== "blocked") return false;
  if (status.kind === "auth") return true;
  return reportedText(status.msg).some(text => GEMINI_SETUP_MESSAGES.includes(text));
}

/**
 * Antigravity CLI 에 멈춤 키(Esc)를 보내도 되는가. 멈출 턴이 확실할 때만이다: 턴이 도는 중(working)이거나, 턴 중의 승인 창(blocked·permission)이거나,
 * 방금 넣은 글이 아직 턴을 열지 않았을 때(pending 이고 쉬는 중 보고).
 * 로그인·첫 설정 화면은 물론이고, 상태 보고가 아직 없거나(뜨는 중: 첫 화면이 약관 동의일 수 있다) 무엇을 묻는지 모르는 막힘(auth·question·그 밖)에는
 * 보내지 않는다: 그 화면에서 Esc 는 사람이 해야 할 답이 될 수 있다. 문구가 바뀌거나 현지화되어 geminiSetupBlocked 가 알아보지 못해도 키는 가지 않는다.
 */
export function geminiTurnToStop(status: { state?: string; kind?: string | null; msg?: string } | null | undefined, pending: boolean): boolean {
  if (!status || geminiSetupBlocked(status)) return false;
  if (status.state === "working") return true;
  if (status.state === "blocked") return status.kind === "permission";
  return pending;
}
