// Antigravity CLI(`agy`) 화면과 상태 보고 해석: 입력칸 판독, 진행 줄(재시도), 승인 창·폴더 신뢰 창 모양, 첫 설정·로그인 막힘.
//
// 근거: agy 1.5.14 대화형 화면 실측(2026-11-23, 격리 herdr-core 160x50 과 격리 IAMCEO 서버의 GET /api/members/:id/screen,
// 견본 tests/fixtures/cli/gemini/1.5.14/ — 실측 기록 원본은 scratchpad agy-real/). 원칙은 '모르면 null' 이다: 조금이라도 다른 화면은
// 입력칸으로 보지 않고 글을 넣지 않는다. 판독 순서는 composerBox 하나에 있다.
//
//   ────────────────────────────────────────────────────────────  지난 입력 상자(60칸 가로줄, 아래 가로줄 없음). 대화마다 위에 쌓인다.
//   > 지난번에 넣은 글(긴 글은 두 칸 들여 접힌다)
//   ⣻  Generating...                        ← 진행 줄(일하는 중). 지난 입력 상자 바로 밑에 빈 줄 없이 붙기도 한다.
//   ──────────────────────────────────────────────────────────────────────────────── 입력칸 위 가로줄(터미널 전체 너비)
//   > 입력한 글(빈 칸이면 `>` 하나, 여러 줄은 두 칸 들여 잇는다)
//   ──────────────────────────────────────────────────────────────────────────────── 입력칸 아래 가로줄(전체 너비)
//     ● Agent(self: Number Responder) · Gemini 3.8 Flash  Working · 1s   ← 서브에이전트가 도는 동안만, 전체 너비 가로줄 둘 사이
//   ────────────────────────────────────────────────────────────────────────────────
//   IAMCEO · Gemini 3.8 Flash (Low) · ctx 0%     ← IAMCEO 상태줄 래퍼(gemini-statusline.ts)가 그리는 바닥줄
//   ? for shortcuts            Gemini 3.8 Flash · low   ← 상태줄을 주지 않았을 때 agy 의 기본 바닥줄(auto 등이면 오른쪽에 `auto · ` 가 붙는다)

import { ERROR_CODES } from "../../shared/error-codes.ts";

/** 가로줄: 줄 첫 칸부터 `─` 만 8칸 이상. 입력칸의 위·아래 줄은 터미널 전체 너비이고, 지난 입력 상자의 줄은 60칸이다(1.5.14 실측, 160칸 화면). */
export const GEMINI_RULE = /^─{8,}$/;
/** 입력칸의 첫 줄(`> 글`, 빈 칸이면 `>`). 줄 첫 칸부터다. 이어진 줄은 두 칸 들여 쓴다(1.5.14 실측). */
export const GEMINI_PROMPT = /^>(?: (.*))?$/;
/** 바닥줄 ①: IAMCEO 상태줄 래퍼의 줄. `IAMCEO`, `IAMCEO · <모델 이름>`, `IAMCEO · <모델 이름> · ctx <N>%`(1.5.14 실측: `IAMCEO · Gemini 3.8 Flash (Low) · ctx 0%`, 모델을 모르면 `IAMCEO · ctx 0%`). */
export const GEMINI_STATUS_OURS = /^\s*IAMCEO(?: · \S.*)?$/;
/**
 * 바닥줄 ②: agy 의 기본 상태줄(`? for shortcuts` … 오른쪽 끝 `Gemini 3.8 Flash · low`, 1.5.14 실측). 승인·신뢰·메뉴 창에서도 맨 아래 줄은 그대로이고
 * 그 위에 `↑/↓ Navigate · …` 안내 줄이 붙는다(그래서 그런 화면은 입력칸으로 읽히지 않는다).
 */
export const GEMINI_STATUS_DEFAULT = /^\s*\? for shortcuts(?:\s.*)?$/;
/** 입력칸 아래에 올 수 있는 바닥줄 수의 상한. 넘으면 모르는 화면이다. */
export const GEMINI_STATUS_MAX_LINES = 3;
/** 입력칸 한 칸의 줄 수 상한(여러 줄 초안). 넘으면 모르는 화면이다. */
export const GEMINI_DRAFT_MAX_LINES = 60;
/**
 * 서브에이전트가 도는 동안 입력칸 아래 가로줄과 또 하나의 전체 너비 가로줄 사이에 끼는 줄(1.5.14 실측: `  ● Agent(self: Number Responder) · Gemini 3.8 Flash  Working · 1s`,
 * 부모 턴이 끝난 뒤에도 몇 초 `Generating · 6s` 로 남는다). 이 꼴이 아닌 줄이 끼면 모르는 화면이다.
 */
export const GEMINI_SUBAGENT_ROW = /^\s{1,4}● Agent\(.+\)/;
const SUBAGENT_ROWS_MAX = 16;
/**
 * 진행 줄: 점자 돌림 글자 하나 + 두 칸 + 글(1.5.14 실측). 일하는 중 `⣻  Generating...`, 도구 뒤 `⡿  Running command...`·`⢿  Editing files...`,
 * 서브에이전트 `⣟  Delegating...`, 재시도 `⣽  Model unavailable (attempt 3/9), retrying in 9s...`, 압축 `⣷  Compacting conversation… (0s · esc to cancel)`.
 * `esc to cancel` 은 압축 줄에만 있다(일하는 중·재시도 줄에는 esc 안내가 없다).
 * 1.5.16 실측(tests/fixtures/cli/gemini/1.5.16): 도구 진행 줄 끝에 지난 시간이 붙고(`Running command... 2s`, `Editing files... 11s`, `Running command... 1m 1s`),
 * 서브에이전트가 부모에게 답한 뒤 부모의 진행 줄은 `Working...` 다. 재시도 줄에는 시간이 붙지 않는다(GEMINI_RETRY 그대로). 진행 줄의 글로 판정하는 곳은 재시도뿐이다.
 */
export const GEMINI_PROGRESS = /^[⠀-⣿]\s+(\S.*)$/;
/** 재시도 진행 줄의 글(1.5.14 실측: API 연결을 끊으면 9번까지 2~9초 간격으로 다시 하고, 약 133초 뒤 턴을 오류로 끝낸다). */
export const GEMINI_RETRY = /^Model unavailable \(attempt (\d{1,3})\/(\d{1,3})\), retrying in (\d{1,4})s\.{3}$/;
/**
 * 빈 입력칸에 흐리게 보이는 자리표시 글. terminal.read 는 색이 없는 글이라 사람이 똑같이 친 글과 구별되지 않는다(Codex 의 자리표시 글과 같다).
 * 1.5.14 실측: 앞의 세 줄을 글자 그대로 보았다. 권한 '매번 묻기'(agentMode "")에는 자리표시 글이 없다(입력 줄이 `>` 하나).
 * 자리표시 글은 그 모드로 첫 글을 넣으면 사라지고(auto 모드인데 `>` 만 보인다) shift+tab 으로 모드를 바꿔야 다시 보인다.
 * Best-of-N 은 shift+tab 순환(default → accept-edits → auto → plan)에 없어 보지 못했다(실행 파일의 글).
 */
export const GEMINI_PLACEHOLDERS: readonly string[] = [
  "Auto mode: edits & safe commands auto-approved (shift+tab to cycle)",
  "Accept-edits mode: file edits auto-approved (shift+tab to cycle)",
  "Plan mode: research & plan only (shift+tab to cycle)",
  "Best-of-N mode: fork into parallel arms and pick a winner (shift+tab to cycle)",
];
/**
 * 승인 창의 고른 줄(`> 1. Yes, run command`, `> 2. No, reject this change`, 1.5.14 실측). 안내에만 쓴다(키를 보내는 근거가 아니다).
 * 폴더 신뢰 창의 고른 줄은 번호가 없다(`> Yes, I trust this folder`): 그 창은 geminiFolderTrust 가 따로 알아본다.
 */
export const GEMINI_SELECTED_OPTION = /^\s*>\s*\d+\.\s+\S/;
/**
 * agy 가 OSC 7501 로 알리는 막힘의 글(msg) 가운데 '이 Mac 에서 사람이 끝내야 하는 설정'을 뜻하는 것(1.5.14 첫 설정 전 실측).
 * "Sign in required"(kind auth): 브라우저 로그인이 필요하다. "Finish setup"(kind question): 색상·약관·데이터 수집 동의가 남았다.
 * UNVERIFIED-INTERACTIVE: 첫 설정을 마친 뒤의 실측(11-23)에서는 두 화면이 나오지 않았다(로그인이 풀리거나 새 약관이 뜰 때의 글은 그때 본 것뿐이다).
 */
export const GEMINI_SETUP_MESSAGES: readonly string[] = ["Finish setup", "Sign in required"];
/** 관측 메모의 코드와 문장(statusObservation.error). 문장은 오류 표의 대표 문장(observation_gemini_setup)이다: 앱은 영어 화면에서 코드로 영어 문장을 고른다. */
export const GEMINI_SETUP_CODE = "gemini_setup";
export const GEMINI_SETUP_NOTE = ERROR_CODES.observation_gemini_setup.ko;
/**
 * 폴더 신뢰 창(1.5.14 실측). 신뢰 목록에 없는 폴더에서 띄우면 `Accessing workspace:` / 경로 / `Do you trust the contents of this project?` /
 * 설명 / `> Yes, I trust this folder` / `  No, exit` / `  ↑/↓ Navigate · enter Confirm` / 바닥줄 이 뜨고, OSC 는 도구 승인과 같은 kind 의
 * `blocked` · `permission` · msg `Trust this folder?` 다. Enter 는 신뢰(전역 settings.json 의 trustedWorkspaces 에 그 폴더가 더해진다)다.
 * IAMCEO 는 띄울 때 --settings 의 trustedWorkspaces 로 이 창을 피한다(실측: 서버가 띄운 팀장은 이 창 없이 떴다). 그래도 뜨면 대표가 볼 창이다:
 * 서버는 키(Esc·Enter·숫자)를 하나도 보내지 않고 전달을 보류한 채 알리기만 한다(core.ts, 관측 코드 gemini_folder_trust).
 */
export const GEMINI_TRUST_MESSAGE = "Trust this folder?";
export const GEMINI_TRUST_QUESTION = "Do you trust the contents of this project?";
export const GEMINI_FOLDER_TRUST_CODE = "gemini_folder_trust";

const strip = (screen: string): string => screen.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const linesOf = (screen: string): string[] => strip(screen).split("\n").map(line => line.replace(/\s+$/, ""));
/** 가로줄이면 그 칸 수, 아니면 0. */
const ruleWidth = (line: string | undefined): number => line !== undefined && GEMINI_RULE.test(line) ? line.length : 0;

interface ComposerBox { lines: string[]; top: number; bottom: number; width: number }

/**
 * 입력칸의 자리. 화면 맨 아래에서 위로 [바닥줄 1~3줄] → 전체 너비 가로줄 → ([서브에이전트 줄들] → 같은 너비 가로줄) → 입력 줄들 → 같은 너비 가로줄이
 * 정확히 맞을 때만 돌려준다. 아니면 null.
 * - 바닥줄은 IAMCEO 상태줄이나 agy 기본 상태줄뿐이어야 한다. 다른 줄(안내 줄 `↑/↓ Navigate …`, 메뉴, 빈 줄)이 하나라도 섞이면 null.
 * - '전체 너비'는 바닥줄 바로 위 가로줄의 칸 수로 정한다. 입력칸 위 가로줄은 그 위로 처음 만나는 같은 칸 수의 가로줄이다: 지난 입력 상자의
 *   60칸 가로줄과 그 밑의 진행 줄은 입력칸으로 오인하지 않는다. 초안 속 가로줄은 두 칸 들여 쓰이므로 줄 첫 칸의 가로줄로 읽히지 않는다.
 */
function composerBox(screen: string): ComposerBox | null {
  const lines = linesOf(screen);
  let at = lines.length - 1;
  while (at >= 0 && !lines[at]) at--;
  let status = 0;
  while (at >= 0 && (GEMINI_STATUS_OURS.test(lines[at]!) || GEMINI_STATUS_DEFAULT.test(lines[at]!))) { status++; at--; }
  if (status < 1 || status > GEMINI_STATUS_MAX_LINES) return null;
  const width = ruleWidth(lines[at]);
  if (!width || at < 2) return null;
  let bottom = at;
  // 서브에이전트 줄: 입력칸 아래 가로줄과 또 하나의 같은 너비 가로줄 사이(1.5.14 실측). 그 위가 같은 너비 가로줄이 아니면 모르는 화면이다.
  let probe = bottom - 1, rows = 0;
  while (probe >= 0 && rows <= SUBAGENT_ROWS_MAX && GEMINI_SUBAGENT_ROW.test(lines[probe]!)) { rows++; probe--; }
  if (rows) {
    if (rows > SUBAGENT_ROWS_MAX || ruleWidth(lines[probe]) !== width) return null;
    bottom = probe;
  }
  let top = bottom - 1;
  while (top >= 0 && ruleWidth(lines[top]) !== width) top--;
  if (top < 0 || bottom - top - 1 < 1 || bottom - top - 1 > GEMINI_DRAFT_MAX_LINES) return null;
  return { lines, top, bottom, width };
}

/**
 * agy 입력칸에 쓰인 글. 빈 문자열이면 빈 칸(자리표시 글 포함), null 이면 입력칸을 알아보지 못했다(승인 창·신뢰 창·메뉴·첫 설정 화면·모르는 모양).
 * 입력칸 자리는 composerBox 가 정한다. 입력 줄의 첫 줄은 `>` 로 시작하고, 여러 줄 초안의 이어진 줄은 그대로 잇는다(두 칸 들여쓰기는 뗀다).
 * 입력 안전에만 쓴다: 이 값이 "" 일 때만 서버가 글을 넣는다. 상태(쉬는 중)는 따로 OSC 보고로 확인한다.
 */
export function geminiDraft(screen: string): string | null {
  const box = composerBox(screen);
  if (!box) return null;
  const { lines, top, bottom, width } = box;
  const first = GEMINI_PROMPT.exec(lines[top + 1]!);
  if (!first) return null;
  // 지켜 두는 검사: 위에서 찾은 가로줄 바로 위에 빈 줄 없이 이어 붙은 구간에 같은 너비 가로줄 + `>` 줄이 있으면, 그 가로줄이 입력칸의 위쪽 줄이고
  // 지금 것은 초안 속 줄일 수 있다(어느 쪽인지 모른다): 빈 칸으로 읽지 않는다. 다른 너비의 가로줄(지난 입력 상자)이나 진행 줄, 빈 줄을 만나면 멈춘다:
  // 그 위는 지난 대화라 거기까지 걸러 내면 그런 글이 화면에 보이는 동안 전달이 멈춘다(1.5.14 실측: 지난 입력 상자 바로 밑에 진행 줄이 붙는다).
  for (let above = top - 1; above >= 0 && top - above <= GEMINI_DRAFT_MAX_LINES && lines[above]; above--) {
    if (GEMINI_PROGRESS.test(lines[above]!)) break;
    const rule = ruleWidth(lines[above]);
    if (!rule) continue;
    if (rule === width && GEMINI_PROMPT.test(lines[above + 1]!)) return null;
    break;
  }
  const rows = [first[1]?.trim() ?? "", ...lines.slice(top + 2, bottom).map(line => line.trim())];
  // 좁은 칸에서는 자리표시 글이 다음 줄로 접힌다. 이어 붙인 글 전체가 자리표시 글일 때만 빈 칸이다.
  const whole = rows.filter(Boolean).join(" ");
  if (GEMINI_PLACEHOLDERS.includes(whole)) return "";
  return rows.join("\n").trim();
}

/**
 * 입력칸 바로 위의 진행 줄 글(돌림 글자 뒤). 입력칸을 알아보지 못했거나 그 자리에 진행 줄이 없으면 null.
 * 예: "Generating...", "Running command...", "Model unavailable (attempt 3/9), retrying in 9s...", "Compacting conversation… (0s · esc to cancel)".
 */
export function geminiProgress(screen: string): string | null {
  const box = composerBox(screen);
  if (!box || !GEMINI_PROMPT.test(box.lines[box.top + 1]!)) return null;
  return GEMINI_PROGRESS.exec(box.lines[box.top - 1] ?? "")?.[1] ?? null;
}

/**
 * agy 가 API 에 닿지 못해 스스로 다시 하는 중인가(진행 줄 `Model unavailable (attempt N/M), retrying in Ns...`). Claude 의 응답 대기 화면
 * (`Waiting for API response … check your network`, networkRetryScreen)과 같은 뜻의 관측(network_retry)으로 쓴다. 아니면 null.
 */
export function geminiRetry(screen: string): { attempt: number; max: number; seconds: number } | null {
  const match = GEMINI_RETRY.exec(geminiProgress(screen) ?? "");
  return match ? { attempt: Number(match[1]), max: Number(match[2]), seconds: Number(match[3]) } : null;
}

/** MCP 관리 창의 머리 줄과 안내 줄(1.5.14 대화형 실측 11-23: `MCP Servers` … `Keyboard: ↑/↓ Navigate  enter Actions  esc Exit`). */
export const GEMINI_MCP_PANEL_TITLE = "MCP Servers";
const MCP_PANEL_KEYS = /^Keyboard: .*\besc\b/;
/** 관리 창에서 그 서버가 붙은 줄(`>  ✓ iamceo  Tools: status, ask, post, …`, 고른 줄은 앞에 `>`). */
const mcpServerReady = (server: string) => new RegExp(`^\\s*(?:>\\s*)?✓\\s+${server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);

/**
 * `/mcp` 로 여는 MCP 관리 창(1.5.14 대화형 실측 11-23). 입력칸 아래 가로줄과 바닥줄 사이에 `MCP Servers` / 빈 줄 / `Plugins (…)` / 서버 줄들 /
 * (고른 서버의 `[Restart]   Disable` 줄) / 빈 줄 / `Keyboard: …` 로 그려진다. 맨 `/mcp` + Enter 는 모델을 부르지 않는다(OSC 는 쉬는 중 그대로, 훅 없음).
 * 대화형 agy 는 MCP 서버를 프로세스의 첫 입력 때에야 띄워 그 첫 턴의 모델 호출에는 연결 도구가 없다(실측): 그래서 서버가 첫 전달 앞에 이 창을 열어
 * MCP 를 띄운다(core.ts primeGeminiMcp). open: 바닥줄 바로 위 몇 줄 안에 안내 줄이 있고 그 위에 머리 줄이 있다. ready: 그 사이에 `✓ <서버>` 줄이 있다.
 * Esc 는 서버 줄의 동작 줄을 접고(안내 `esc Cancel`), 한 번 더 누르면 창을 닫는다(`esc Exit`). 창이 닫히면 입력칸은 빈 칸 그대로다.
 */
export function geminiMcpPanel(screen: string, server = "iamceo"): { open: boolean; ready: boolean } {
  const lines = linesOf(screen);
  let at = lines.length - 1;
  while (at >= 0 && !lines[at]) at--;
  while (at >= 0 && (GEMINI_STATUS_OURS.test(lines[at]!) || GEMINI_STATUS_DEFAULT.test(lines[at]!))) at--;
  while (at >= 0 && !lines[at]) at--;
  if (at < 0 || !MCP_PANEL_KEYS.test(lines[at]!.trim())) return { open: false, ready: false };
  const keys = at;
  let title = -1;
  for (let probe = keys - 1; probe >= 0 && keys - probe <= 40; probe--) {
    if (ruleWidth(lines[probe])) break;
    if (lines[probe]!.trim() === GEMINI_MCP_PANEL_TITLE) { title = probe; break; }
  }
  if (title < 0) return { open: false, ready: false };
  const ready = mcpServerReady(server);
  return { open: true, ready: lines.slice(title + 1, keys).some(line => ready.test(line)) };
}

/** 승인 창의 모양(안내용 판독). 키를 보내는 근거가 아니다: 서버는 이 창에 답하지 않는다(대표가 터미널에서 답하거나 결재함 카드가 훅으로 답한다). */
export interface GeminiApprovalDialog { title: string | null; question: string; options: string[]; selected: number; hint: string }
const OPTION_ROW = /^(>| ) (\d{1,2})\. (\S.*)$/;
const HINT_ROW = /^\s{2}(↑\/↓ Navigate(?: · .+)?)$/;

/**
 * agy 자기 승인 창(1.5.14 실측). 아래에서 위로 [바닥줄] → 안내 줄(`  ↑/↓ Navigate · …`) → 빈 줄 → 번호 선택지(1 부터 차례, 고른 줄은 `> `) → 물음 줄.
 * 제목은 물음 위로 처음 만나는 전체 너비 가로줄 바로 위 줄이다(`Command`·`Create file`·`Pending edit`). 모양이 하나라도 다르면 null.
 * - 명령: `Run this command?` / `1. Yes, run command` · `2·3. Yes, and always allow …` · `4. No, cancel`, 안내 `↑/↓ Navigate · tab Amend · ctrl+g edit/expand command`
 * - 새 파일: `Allow creation of this file?` / `1. Yes, allow creation` · `2. No, deny creation`, 안내 `↑/↓ Navigate · f full diff`
 * - 고치기: `Accept this file edit?` / `1. Yes, accept this change` · `2. No, reject this change`(2번을 고르면 안내에 `tab Amend` 가 더해진다)
 * OSC 는 셋 다 blocked · permission 이고 msg 는 `Approve Bash: <명령>`·`Approve Edit: Write: <경로>`(약 100자에서 `…`)다.
 * 승인 창이 떠 있는 동안 입력칸은 사라진다(geminiDraft 는 null). Esc·`No` 는 거절이고 턴을 끝낸다(done 없이 idle, Stop 훅 없음).
 */
export function geminiApprovalDialog(screen: string): GeminiApprovalDialog | null {
  const lines = linesOf(screen);
  let at = lines.length - 1;
  while (at >= 0 && !lines[at]) at--;
  if (at < 0 || !(GEMINI_STATUS_OURS.test(lines[at]!) || GEMINI_STATUS_DEFAULT.test(lines[at]!))) return null;
  const hint = HINT_ROW.exec(lines[--at] ?? "");
  if (!hint || lines[--at] !== "") return null;
  const options: { selected: boolean; n: number; label: string }[] = [];
  for (at--; at >= 0; at--) {
    const row = OPTION_ROW.exec(lines[at]!);
    if (!row) break;
    options.unshift({ selected: row[1] === ">", n: Number(row[2]), label: row[3]!.trim() });
  }
  if (options.length < 2 || options.some((option, i) => option.n !== i + 1) || options.filter(option => option.selected).length !== 1) return null;
  const question = lines[at]?.trim() ?? "";
  if (!question.endsWith("?") || at < 1) return null;
  let title: string | null = null;
  for (let probe = at - 1; probe >= 1 && at - probe <= 40; probe--) {
    if (!ruleWidth(lines[probe])) continue;
    title = lines[probe - 1]?.trim() || null;
    break;
  }
  return { title, question, options: options.map(option => option.label), selected: options.findIndex(option => option.selected), hint: hint[1]! };
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** 상태 보고의 글. 실행 엔진이 base64 를 풀어 주든 그대로 주든 같은 글로 읽는다(1.5.14 의 원시 보고는 base64, herdr-core terminal.get 의 msg 는 푼 글이다). */
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

type ReportedStatus = { state?: string; kind?: string | null; msg?: string } | null | undefined;

/**
 * agy 가 '로그인·첫 설정이 필요하다'고 막혀 있는가. 막힘(blocked) 보고이고, 종류가 auth 이거나 글이 GEMINI_SETUP_MESSAGES 가운데 하나일 때다.
 * 이 화면에는 서버가 어떤 키도 보내지 않는다(약관·데이터 수집 동의와 브라우저 로그인은 사람만 한다). 알리기만 한다.
 */
export function geminiSetupBlocked(status: ReportedStatus): boolean {
  if (!status || status.state !== "blocked") return false;
  if (status.kind === "auth") return true;
  return reportedText(status.msg).some(text => GEMINI_SETUP_MESSAGES.includes(text));
}

/**
 * agy 가 폴더 신뢰 창에서 기다리는가(GEMINI_TRUST_MESSAGE 위 설명). 둘 중 하나면 그렇다:
 * - 막힘 보고의 글이 `Trust this folder?` 다(종류는 보지 않는다: 1.5.14 는 도구 승인과 같은 permission 으로 알린다).
 * - 보고가 쉬는 중·일하는 중이 아니고(막힘이거나 아직 보고가 없다), 화면 아래쪽에 신뢰 물음 줄과 그 선택지 줄이 있고 입력칸이 보이지 않는다.
 * 넓게 잡는다: 도구 승인 창을 신뢰 창으로 잘못 읽으면 멈춤 키가 가지 않을 뿐이지만(안전한 쪽), 반대면 Esc 가 이 창의 답이 될 수 있다.
 */
export function geminiFolderTrust(status: ReportedStatus, screen?: string | null): boolean {
  if (status?.state === "blocked" && reportedText(status.msg).some(text => text.toLowerCase() === GEMINI_TRUST_MESSAGE.toLowerCase())) return true;
  if (typeof screen !== "string" || (status?.state && status.state !== "blocked")) return false;
  const lines = linesOf(screen).filter(Boolean).slice(-30);
  const question = lines.findLastIndex(line => line.trim() === GEMINI_TRUST_QUESTION);
  if (question < 0) return false;
  const after = lines.slice(question + 1);
  return after.some(line => /^\s*>?\s*Yes, I trust this folder$/.test(line) || /^\s*>?\s*No, exit$/.test(line)) && geminiDraft(screen) === null;
}

/**
 * Antigravity CLI 에 멈춤 키(Esc)를 보내도 되는가. 멈출 턴이 확실할 때만이다: 턴이 도는 중(working)이거나, 턴 중의 도구 승인 창(blocked·permission:
 * 1.5.14 실측으로 Esc 는 그 도구를 거절하고 턴을 끝낸다)이거나, 방금 넣은 글이 아직 턴을 열지 않았을 때(pending 이고 쉬는 중 보고).
 * 로그인·첫 설정 화면과 폴더 신뢰 창(같은 permission 으로 알린다)은 물론이고, 상태 보고가 아직 없거나(뜨는 중: 첫 화면이 약관 동의일 수 있다)
 * 무엇을 묻는지 모르는 막힘(auth·question·그 밖)에는 보내지 않는다: 그 화면에서 Esc 는 사람이 해야 할 답이 될 수 있다.
 * 문구가 바뀌거나 현지화되어 알아보지 못해도 키는 가지 않는다(모르는 막힘). screen 을 주면 화면으로도 신뢰 창을 가린다.
 */
export function geminiTurnToStop(status: ReportedStatus, pending: boolean, screen?: string | null): boolean {
  if (!status || geminiSetupBlocked(status) || geminiFolderTrust(status, screen)) return false;
  if (status.state === "working") return true;
  if (status.state === "blocked") return status.kind === "permission";
  return pending;
}
