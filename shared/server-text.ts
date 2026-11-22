// 0.2.6 Y: 서버가 만들어 DB 에 남기는 글(대화의 시스템 메시지·서버가 만드는 결재 카드·팀장 활동 줄)의 문장 표와 그리기.
//
// 원칙
// - 글은 만들 때의 '보고 언어'(Settings.reportLanguage)로 그려 지금처럼 문장(title·body·text·detail…)에 저장한다.
//   출시된 앱(0.2.5 이하)은 그 문장을 그대로 보인다. 보고 언어 한국어면 문장은 바꾸기 전과 글자까지 같다(tests/server-text.test.ts 대조).
// - 함께 '코드와 값'(ServerTextRef)과 그린 언어를 선택 필드로 싣는다(Message.textCode/textParams/textLang 등).
//   새 앱은 자기 화면 언어가 textLang 과 다르면 코드로 다시 그린다(앱 사본: native/…/Models/ServerTextCatalog.swift, 문구 표 server.text.*).
//   모르는 코드·빠진 값이면 문장을 그대로 보인다.
// - 서버는 응답에 실을 때 코드로 다시 그린 문장이 저장된 문장과 같은지 확인한다. 다르면(이전 판 서버가 문장만 고쳤거나 잘렸으면) 코드를 싣지 않는다.
// - AI 에게 주는 글(역할 지침, [대표]·[총괄]·[시스템] 머리, 전달 글)은 여기 넣지 않는다. 바꾸지 않는다.
//
// 틀 문법: {이름} 은 값, 한국어 틀의 {이름:이}·{이름:을}·{이름:은}·{이름:으로} 는 값 뒤에 조사를 붙인다(roles.ts josa, api-outage.ts particleRo 와 같은 규칙).
// 값 자리에 다른 코드(중첩)나 시각({ at }), 언어별 글자({ ko, en }: 서버가 자른 글의 '…(N자 더 있음)' 같은 붙임말처럼 서버가 언어마다
// 따로 만든 값)를 넣을 수 있다. 값 안의 { } 는 다시 풀지 않는다.
// 코드 이름: 소문자와 밑줄을 점으로 이은 것(숫자 없음). 앱 문구 표 열쇠가 `server.text.<코드>` 다.
// 대화 글의 제목은 `<코드>.title` 이 있으면 그것이다. 'notice.' 로 시작하는 코드는 서버의 Mac 스크립트 알림 전용이라 앱 표에 넣지 않는다.

export type TextLang = "ko" | "en";
/** 시각 값. 한국어는 '11월 14일 오후 3시', 영어는 'Nov 14, 3 PM'(서버가 도는 Mac 의 시간대). */
export interface ServerTextDate { at: string }
/** 언어별 글자. 서버가 두 언어로 따로 만든 값(도구 승인 카드의 '대상'처럼 붙임말이 든 값). 그 언어 쪽을 쓴다. */
export interface ServerTextLangs { ko: string; en: string }
export type ServerTextParam = string | ServerTextRef | ServerTextDate | ServerTextLangs;
export interface ServerTextRef { code: string; params?: Record<string, ServerTextParam> }
export interface ServerTextTemplate { ko: string; en: string }

const ELSEWHERE_KO = "(고를 버튼이 없으면 팀장 설정에서 모델을 바꾸거나 총괄에게 모델을 바꿔 이어 가라고 하세요)";
const ELSEWHERE_EN = " (if there is no button to pick one, change the model in the staff member's settings, or ask the lead to switch the model and continue)";
const ANOTHER_ACCOUNT_KO = "다른 계정으로 로그인했거나 한도를 늘렸다면 '이어가기'를 누르세요.";
const ANOTHER_ACCOUNT_EN = "If you signed in with another account or raised your limit, press 'Continue'.";
const PICK_MODEL_KO = `바로 이어 가려면 다른 모델을 고르세요${ELSEWHERE_KO}. `;
const PICK_MODEL_EN = `To continue right away, pick another model${ELSEWHERE_EN}. `;
const TOOL_WAIT_KO = "{name:이} 터미널의 승인 창 앞에서 기다립니다. 허용하면 이번 한 번만 실행합니다.\n\n**{action}**\n{bar}\n{target}\n{bar}";
const TOOL_WAIT_EN = "{name} is waiting at an approval prompt in the terminal. Allowing runs it this one time only.\n\n**{action}**\n{bar}\n{target}\n{bar}";
const TOOL_TAIL_KO = "\n\n{minutes}분 안에 답하지 않으면 이 카드는 닫히고, 터미널의 승인 창에서 직접 답해야 합니다. 터미널에서 먼저 답해도 닫힙니다.\n허용·거절 가운데 하나를 고르세요. 메모만 보내면 거절로 처리합니다.";
const TOOL_TAIL_EN = "\n\nIf you don't answer within {minutes} min, this card closes and you have to answer at the approval prompt in the terminal. It also closes if you answer in the terminal first.\nChoose Allow or Deny. Sending only a note counts as Deny.";

export const SERVER_TEXTS = {
  // ---- 대화의 시스템 글 ----
  "chat.member_error": { ko: "{name} 오류: {error}", en: "{name} error: {error}" },
  "chat.run_interrupted": { ko: "{name}: 실행 {run} 중단 — {why}", en: "{name}: run {run} stopped — {why}" },
  "chat.run_restart_resumed": { ko: "{name}: 실행 {run} — 재시작으로 끊겨 이어서 하게 했습니다", en: "{name}: run {run} — cut off by a restart; told to pick up where it left off" },
  "chat.usage_model_resumed": { ko: "{name}: 실행 {run} — 사용 한도로 멈춰 모델을 {model:으로} 바꿔 이어서 하게 했습니다", en: "{name}: run {run} — stopped at the usage limit; switched to {model} and told to continue" },
  // 0.2.8: 대표가 앱에서 다른 계정으로 로그인한 뒤(사용 한도) 또는 다시 로그인한 뒤(로그인 오류) 같은 대화를 이어 열었다.
  "chat.usage_account_resumed": { ko: "{name}: 실행 {run} — 사용 한도로 멈춰 다른 계정으로 로그인한 뒤 같은 대화를 이어서 하게 했습니다", en: "{name}: run {run} — stopped at the usage limit; signed in with another account and told to continue the same conversation" },
  "chat.login_resumed": { ko: "{name}: 실행 {run} — 로그인 오류로 멈춰 다시 로그인한 뒤 이어서 하게 했습니다", en: "{name}: run {run} — stopped by a sign-in error; signed in again and told to continue" },
  "chat.missing_report": { ko: "{name}의 결과 보고가 보완 요청 뒤에도 남지 않았습니다. 기존 업무를 다시 실행하지 않고 결과를 확인해 주세요.", en: "{name} still left no result report after being asked for one. Check the result without running the work again." },
  "chat.missing_report.title": { ko: "결과 보고 누락", en: "Missing result report" },
  "chat.quick_exit": { ko: "{name}의 세션이 시작하자마자 끝나기를 되풀이해 자동으로 다시 깨우지 않습니다. 터미널에서 원인을 확인한 뒤 팀원을 깨워 주세요.", en: "{name}'s session keeps ending right after it starts, so it won't be woken automatically. Check the cause in the terminal, then wake the staff member." },
  "chat.quick_exit_error": { ko: "{name}의 세션이 시작하자마자 끝나기를 되풀이해 자동으로 다시 깨우지 않습니다. 터미널에서 원인을 확인한 뒤 팀원을 깨워 주세요. ({error})", en: "{name}'s session keeps ending right after it starts, so it won't be woken automatically. Check the cause in the terminal, then wake the staff member. ({error})" },
  "chat.owner_message_late": { ko: "{name}에게 보낸 대표 메시지가 30분 넘게 전달되지 않았습니다. 전달 #{id}를 확인해 주세요.", en: "Your message to {name} has not been delivered for over 30 minutes. Check delivery #{id}." },
  "chat.owner_message_late.title": { ko: "대표 전달 지연", en: "Delivery delayed" },
  "chat.owner_answer_late": { ko: "{name}에게 보낸 대표 결재 답이 30분 넘게 전달되지 않았습니다. 전달 #{id}를 확인해 주세요.", en: "Your decision answer to {name} has not been delivered for over 30 minutes. Check delivery #{id}." },
  "chat.owner_answer_late.title": { ko: "대표 전달 지연", en: "Delivery delayed" },
  "chat.delivery_failed": { ko: "{name}에게 전달하지 못했습니다: {detail}", en: "Couldn't deliver to {name}: {detail}" },
  "chat.delivery_stalled": { ko: "{name}에게 전달이 진행되지 않고 있습니다. 전달 정보에서 '다시 확인'을 눌러 주세요. 원래 입력을 중복해서 보내지 않습니다.", en: "Delivery to {name} is not moving. Press 'Check again' in the delivery details. The original input won't be sent twice." },
  "chat.delivery_stalled.title": { ko: "전달 확인 필요", en: "Delivery needs checking" },
  // 0.2.7 묶음 1(점검 D1-3·D5-2): 대표의 일이 30분 넘게 기다리는 까닭이 '받는 팀장이 하던 일을 마치는 중'이면 막힘이 아니라 이 알림(푸시 없음)이다.
  // 0.2.7 배포 전 확인(문제 3): 대표 화면에 내부 번호(#dl_…)를 싣지 않는다(총괄 사본에는 서버가 따로 붙인다). {since} 는 오늘이면 시각만(sinceParam).
  "chat.owner_delivery_behind": { ko: "{name:이} {since}부터 하던 일을 마치는 중입니다. 그 일이 끝나면 {what:이} 들어갑니다.", en: "{name} has been finishing earlier work since {since}. When it ends, {what} goes in." },
  "chat.owner_delivery_behind.title": { ko: "전달 대기", en: "Delivery waiting" },
  // 대표 원문을 실은 총괄 지시·할 일 완료 소식이 진짜로 막혔을 때(막힘·푸시). 결재 답·대표 메시지는 위의 예전 글 그대로다.
  "chat.owner_instruction_late": { ko: "{name}에게 넘긴 대표 요청(총괄 지시)이 30분 넘게 전달되지 않았습니다. 팀 화면에서 {name}의 상태를 확인해 주세요.", en: "The lead's instruction carrying your request to {name} has not been delivered for over 30 minutes. Check {name}'s status in Team." },
  "chat.owner_instruction_late.title": { ko: "대표 전달 지연", en: "Delivery delayed" },
  "chat.owner_todo_done_late": { ko: "{name}에게 보낸 할 일 완료 소식이 30분 넘게 전달되지 않았습니다. 팀 화면에서 {name}의 상태를 확인해 주세요.", en: "Your to-do completion for {name} has not been delivered for over 30 minutes. Check {name}'s status in Team." },
  "chat.owner_todo_done_late.title": { ko: "대표 전달 지연", en: "Delivery delayed" },
  // 0.2.7 배포 전 확인(real-cli P2): 대표의 일이 Codex 가 남긴 백그라운드 프로그램 뒤에서 30분 넘게 기다린다. 스스로 풀리지 않으므로 막힘·푸시다.
  "chat.owner_delivery_background": { ko: "{name:이} 턴은 끝냈지만 Codex가 띄운 백그라운드 프로그램({count}개)이 남아 있어 {what:이} 들어가지 못합니다. {name}의 터미널에서 /ps 로 보고 /stop 으로 닫으면 들어갑니다.", en: "{name} finished its turn, but background programs that Codex started ({count}) are still running, so {what} can't go in. In {name}'s terminal, /ps lists them and /stop closes them; then it goes in." },
  "chat.owner_delivery_background.title": { ko: "전달 막힘", en: "Delivery blocked" },
  // 0.2.7 묶음 1(점검 D1-1): 넣은 압축의 끝을 10분 안에 확인하지 못했다. 그 팀장에게 가는 전달이 모두 멈춰 있다(막힘·푸시).
  "chat.compact_unconfirmed": { ko: "{name}의 문맥 정리(압축)가 끝났는지 10분 넘게 확인되지 않아 {name}에게 가는 전달을 멈춰 두었습니다. 팀 화면에서 {name}의 터미널을 보고, 압축이 끝나 있으면 '중단'을 눌러 주세요. 기다리던 전달이 이어서 나갑니다.", en: "{name}'s context compaction hasn't been confirmed as finished for over 10 minutes, so deliveries to {name} are on hold. Check {name}'s terminal in Team, and if the compaction has finished, press 'Interrupt'. The waiting deliveries then go out." },
  "chat.compact_unconfirmed.title": { ko: "압축 확인 필요", en: "Compaction needs a check" },
  "chat.assigned": { ko: "총괄이 {name}에게 맡겼습니다: {summary}", en: "The lead handed {name} a task: {summary}" },
  "chat.assigned_queued": { ko: "총괄이 {name}에게 맡겼습니다: {summary} (앞 일 끝나면 시작)", en: "The lead handed {name} a task: {summary} (starts after the current work)" },
  "chat.api_resume_failed": { ko: "{name}의 인터넷 연결 복구 후 이어가기가 3회 실패했습니다. 터미널을 확인해 주세요.", en: "{name} failed to continue 3 times after the internet connection came back. Check the terminal." },
  "chat.api_outage": { ko: "인터넷 연결이 불안정해 팀원 {count}명이 멈췄습니다. 연결이 돌아오면 자동으로 이어 갑니다.", en: "The internet connection is unstable, so {count} staff stopped. They continue automatically when it is back." },
  "chat.api_recovered": { ko: "인터넷 연결이 돌아와 팀원 {count}명이 이어서 일합니다.", en: "The internet connection is back, and {count} staff continue working." },
  // 0.2.7(D2-4·D4-2): 재시작(Mac·실행 엔진)으로 꺼진 팀원을 서버가 다시 연 한 묶음의 요약. 팀원마다 '오류' 알림을 보내던 것을 대신한다.
  "chat.restart_reopened_summary": { ko: "Mac이나 실행 엔진이 다시 시작되어 꺼졌던 팀원 {count}명을 다시 열었습니다.", en: "The Mac or the engine restarted; {count} staff whose sessions closed were reopened." },
  "chat.restart_reopen_failed_summary": { ko: "Mac이나 실행 엔진이 다시 시작되어 꺼졌던 팀원 {total}명 가운데 {opened}명을 다시 열었습니다. 다시 열지 못한 팀원: {names}. 팀 화면에서 깨워 주세요.", en: "The Mac or the engine restarted; reopened {opened} of {total} staff whose sessions closed. Couldn't reopen: {names}. Wake them from the Team screen." },
  // 실행이 끊긴 까닭(chat.run_interrupted 의 why)
  "why.restart_session_off": { ko: "Mac이나 실행 엔진이 다시 시작되어 세션이 꺼졌습니다", en: "the Mac or the engine restarted and the session closed" },
  "why.session_vanished": { ko: "종료 근거 없이 세션이 사라졌습니다", en: "the session disappeared without a recorded exit" },
  "why.restart_cut": { ko: "Mac이나 실행 엔진이 다시 시작되어 끊겼습니다", en: "cut off because the Mac or the engine restarted" },
  "why.restart_cut_reopen_failed": { ko: "Mac이나 실행 엔진이 다시 시작되어 끊겼습니다. 세션을 다시 열지 못했습니다", en: "cut off because the Mac or the engine restarted. The session couldn't be reopened" },
  "why.usage_model_new_session": { ko: "사용 한도로 멈췄습니다. 모델을 {model:으로} 바꿨지만 이어 열 세션 기록이 없어 새 세션으로 엽니다", en: "stopped at the usage limit. Switched to {model}, but there is no session record to continue, so it opens a new session" },
  "why.usage_account_new_session": { ko: "사용 한도로 멈췄습니다. 다른 계정으로 로그인했지만 이어 열 세션 기록이 없어 새 세션으로 엽니다", en: "stopped at the usage limit. Signed in with another account, but there is no session record to continue, so it opens a new session" },
  "why.login_new_session": { ko: "로그인 오류로 멈췄습니다. 다시 로그인했지만 이어 열 세션 기록이 없어 새 세션으로 엽니다", en: "stopped by a sign-in error. Signed in again, but there is no session record to continue, so it opens a new session" },
  // 0.2.10: 이어 연 줄 알았던 Gemini(Antigravity CLI) 대화가 실제로는 새 대화였다(재시작 이어가기로 처리했던 실행을 중단으로 다시 알린다).
  "why.gemini_resume_lost": { ko: "이전 대화를 이어 열지 못해 새 대화로 열렸습니다(앞 대화의 맥락 없음)", en: "the previous conversation couldn't be reopened, so a new one was opened (the earlier context is gone)" },
  // 실행 중단의 까닭(endExecution 의 사유). journal 에는 한국어 문장 그대로 남는다.
  "why.slept": { ko: "팀원을 잠재워 실행을 종료했습니다", en: "the staff member was put to sleep, which ended the run" },
  "why.closed": { ko: "팀원을 닫아 실행을 종료했습니다", en: "the staff member was closed, which ended the run" },
  "why.settings_changed": { ko: "세션 설정을 변경했습니다", en: "the session settings changed" },
  "why.fresh_session": { ko: "명시적 새 세션으로 전환했습니다", en: "switched to a new session on request" },
  "why.terminal_absent": { ko: "소유 터미널의 부재를 확인했습니다", en: "its terminal was confirmed gone" },
  "why.terminal_absent_rejoin": { ko: "재결합 조회에서 소유 터미널의 부재를 확인했습니다", en: "a reconnect check confirmed its terminal was gone" },
  "why.terminal_ended": { ko: "소유 터미널이 종료되었습니다", en: "its terminal ended" },
  "why.terminal_ended_or_gone": { ko: "소유 터미널이 종료되거나 사라졌습니다", en: "its terminal ended or disappeared" },
  "why.delivery_failed": { ko: "전달 실패", en: "delivery failed" },
  "why.usage_cli_new_session": { ko: "사용 한도로 멈췄습니다. CLI를 {cli:으로} 바꿔 새 세션으로 엽니다(이전 CLI의 대화는 이어지지 않습니다)", en: "stopped at the usage limit. Switched the CLI to {cli} and opens a new session (the previous CLI's conversation does not carry over)" },

  // ---- 팀장 활동 줄 ----
  "activity.turn_end": { ko: "턴 끝", en: "Turn ended" },
  "activity.start_cancelled": { ko: "세션 기동 결과를 확인하지 못했고 터미널이 생기지 않아 기동을 취소했습니다. 필요하면 다시 깨웁니다", en: "Couldn't confirm the session start and no terminal appeared, so the start was cancelled. It is woken again when needed" },
  "activity.reopen_live_stop": { ko: "세션을 다시 열려던 작업이 끊겨 있었습니다. 터미널이 그대로 살아 있어 그 작업을 닫았습니다. 바꾸려던 설정이나 새 세션은 적용되지 않았으니 다시 해 주세요", en: "An attempt to reopen the session had been cut off. The terminal is still running, so that attempt was closed. The settings change or new session was not applied; please do it again" },
  "activity.reopen_gone_stop": { ko: "세션을 다시 열려던 작업이 끊겨 있었습니다. 터미널이 끝난 것을 확인해 그 작업을 닫았습니다. 바꾸려던 설정이나 새 세션이 적용되지 않았으면 다시 해 주세요", en: "An attempt to reopen the session had been cut off. The terminal was confirmed closed, so that attempt was closed. If the settings change or new session was not applied, please do it again" },
  "activity.parallel_released": { ko: "병렬 설정을 받은 터미널이 끝나 그 설정의 확인 대기를 풀었습니다. 밀린 전달을 이어 갑니다", en: "The terminal that received the parallel setting closed, so the wait for its confirmation was released. Pending deliveries continue" },
  "activity.lease_released": { ko: "직접 조작하던 터미널이 끝나 그 조작권을 거뒀습니다. 밀린 전달을 이어 갑니다", en: "The terminal under direct control closed, so control was released. Pending deliveries continue" },
  "activity.restart_exit": { ko: "Mac이나 실행 엔진이 다시 시작되어 세션이 꺼졌습니다. 말을 걸거나 깨우면 하던 대화를 이어서 엽니다", en: "The Mac or the engine restarted and the session closed. Message it or wake it to reopen the same conversation" },
  "activity.exit": { ko: "초기/실행 종료: {reason} (exit_code={code})", en: "Session ended: {reason} (exit code {code})" },
  "activity.decision_closed_by_answer": { ko: "결재 #{id}를 대표 답 #{answer}에 따라 닫았습니다: {issue}", en: "Closed decision #{id} based on your answer #{answer}: {issue}" },
  "activity.decision_closed_by_answer_group": { ko: "결재 #{id}를 대표 답 #{answer}에 따라 닫았습니다 (같은 그룹)", en: "Closed decision #{id} based on your answer #{answer} (same group)" },
  "activity.restart_reopened": { ko: "Mac이나 실행 엔진이 다시 시작되어 꺼졌던 세션을 이어서 열었습니다", en: "The Mac or the engine restarted; the session that closed was reopened to continue" },
  // 0.2.10: Gemini(Antigravity CLI)는 이어 열 대화를 열지 못하면 오류 없이 새 대화를 연다. 대화 id 가 바뀐 것으로 안다.
  "activity.gemini_auto_fallback": { ko: "Antigravity CLI가 이번 실행에서 auto 모드로 뜨지 않았습니다. 쉬는 때에 같은 대화를 auto 대신의 모드(파일 고치기·샌드박스 안 명령만 자동 승인)로 다시 엽니다", en: "Antigravity CLI didn't start in auto mode this time. When idle, the same conversation reopens in a mode that stands in for auto (only file edits and sandboxed commands are approved automatically)" },
  "activity.gemini_resume_lost": { ko: "이전 대화를 이어 열지 못해 새 대화로 열렸습니다. 앞 대화의 맥락은 없습니다", en: "Couldn't reopen the previous conversation, so a new one was opened. The earlier context is gone" },
  "activity.gemini_conversation_changed": { ko: "대화가 새로 열렸습니다. 앞 대화의 맥락은 이어지지 않습니다", en: "A new conversation was opened. The earlier context doesn't carry over" },
  "activity.missing_report_final": { ko: "결과 보고 누락: 보완 요청 뒤에도 결과가 남지 않았습니다", en: "Missing result report: no result even after it was asked for" },
  "activity.missing_report_requested": { ko: "필수 보고가 없어 보고 보완을 요청했습니다", en: "The required report was missing, so it was asked for" },
  "activity.late_receipt": { ko: "늦게 도착한 수신 확인으로 전달을 확정했습니다", en: "A late receipt confirmed the delivery" },
  "activity.late_not_written": { ko: "늦게 도착한 결과로 넣지 못한 것을 확인했습니다. 다시 보냅니다", en: "A late result showed it was not entered. Sending again" },
  "activity.pump_stuck": { ko: "전달 처리가 {seconds}초째 끝나지 않았습니다(대기 단계: {stage}). 자동으로 다시 넣거나 중단하지 않습니다", en: "Delivery processing has not finished for {seconds} s (waiting at: {stage}). It is not re-entered or interrupted automatically" },
  "activity.overrides_reset": { ko: "CLI 변경으로 지원하지 않는 {fields} 지정을 비우고 직급 기본값으로 되돌렸습니다", en: "The CLI change cleared the unsupported {fields} setting and went back to the rank default" },
  "activity.settings_held_session": { ko: "설정 적용 보류: 같은 대화의 세션 ID를 확인하지 못했습니다. 다음 자연 기동 때 적용합니다", en: "Settings change on hold: couldn't confirm the session ID of the same conversation. It is applied at the next natural start" },
  "activity.usage_reopen_model_continue": { ko: "사용 한도로 멈춘 세션의 모델을 {model:으로} 바꿔 같은 대화를 이어 엽니다", en: "Switching the session stopped at the usage limit to {model} and reopening the same conversation" },
  "activity.usage_reopen_model_new": { ko: "사용 한도로 멈춘 세션의 모델을 {model:으로} 바꿔 새 세션으로 엽니다", en: "Switching the session stopped at the usage limit to {model} and opening a new session" },
  "activity.usage_reopen_cli_continue": { ko: "사용 한도로 멈춘 세션의 CLI를 {cli:으로} 바꿔 같은 대화를 이어 엽니다", en: "Switching the session stopped at the usage limit to the {cli} CLI and reopening the same conversation" },
  "activity.usage_reopen_cli_new": { ko: "사용 한도로 멈춘 세션의 CLI를 {cli:으로} 바꿔 새 세션으로 엽니다", en: "Switching the session stopped at the usage limit to the {cli} CLI and opening a new session" },
  "activity.usage_reopen_account_continue": { ko: "사용 한도로 멈춘 세션을 새로 로그인한 계정으로 같은 대화를 이어 엽니다", en: "Reopening the session stopped at the usage limit in the same conversation with the newly signed-in account" },
  "activity.usage_reopen_account_new": { ko: "사용 한도로 멈춘 세션을 새로 로그인한 계정으로 새 세션으로 엽니다", en: "Opening a new session with the newly signed-in account for the session stopped at the usage limit" },
  "activity.login_reopen_continue": { ko: "다시 로그인해 로그인 오류로 멈춘 세션을 같은 대화로 이어 엽니다", en: "Signed in again; reopening the session stopped by the sign-in error in the same conversation" },
  "activity.login_reopen_new": { ko: "다시 로그인해 로그인 오류로 멈춘 세션을 새 세션으로 엽니다", en: "Signed in again; opening a new session for the session stopped by the sign-in error" },
  "activity.account_reopen": { ko: "CLI 계정이 바뀌어(대표가 다른 계정으로 로그인) 같은 대화를 새 계정으로 이어 열었습니다", en: "The CLI account changed (the owner signed in with another account), so the same conversation was reopened with the new account" },
  "activity.orphan_compact_own": { ko: "압축을 받은 터미널이 끝나 그 압축을 닫았습니다. 밀린 전달을 이어 갑니다", en: "The terminal that received the compaction closed, so the compaction was closed. Pending deliveries continue" },
  "activity.orphan_compact_left": { ko: "넣지 못한 압축이 확인 대기로 남아 있어 닫았습니다. 밀린 전달을 이어 갑니다", en: "A compaction that was never entered was left waiting for confirmation, so it was closed. Pending deliveries continue" },
  "activity.stale_turn_cleared": { ko: "끝난 턴의 표시가 남아 전달이 멈춰 있었습니다. 표시를 지우고 다시 보냅니다", en: "A finished turn was still marked as running and held up delivery. Cleared the mark and sending again" },
  "activity.source_changed": { ko: "원본이 바뀐 전달을 보내지 않고 거뒀습니다 ({id})", en: "Withdrew a delivery whose original changed instead of sending it ({id})" },
  "activity.parallel_on": { ko: "병렬 켬", en: "Parallel on" },
  "activity.parallel_off": { ko: "병렬 끔", en: "Parallel off" },
  "activity.parallel_failed": { ko: "병렬 설정 실패: {detail}", en: "Couldn't change the parallel setting: {detail}" },
  "activity.compact_start": { ko: "압축 시작 (문맥 {pct})", en: "Compaction started (context {pct})" },
  "activity.compact_done": { ko: "압축 완료", en: "Compaction done" },
  "activity.compact_unconfirmed": { ko: "압축 완료를 확인할 수 없어 후속 자동 입력을 보류합니다", en: "Couldn't confirm the compaction finished, so further automatic input is on hold" },
  "activity.compact_uncertain": { ko: "압축 응답을 확인할 수 없어 자동 재전송을 중지했습니다", en: "Couldn't confirm the compaction response, so automatic resending stopped" },
  // 0.2.7 묶음 1(점검 D5-1): 대표 원문을 실은 급한 지시로 하던 턴을 멈춤('하던 턴 멈추고 넣기').
  // 0.2.7 배포 전 확인(문제 3): 대표가 보는 활동 줄에 내부 번호(#dl_…)를 싣지 않는다.
  "activity.urgent_interrupt": { ko: "대표의 급한 지시를 넣으려고 하던 턴을 멈췄습니다", en: "Stopped the current turn to put in your urgent instruction" },
  "activity.urgent_interrupt_failed": { ko: "대표의 급한 지시를 넣으려고 하던 턴을 멈추려 했지만 멈추지 못했습니다. 그 턴이 끝나면 들어갑니다 ({detail})", en: "Tried to stop the current turn for your urgent instruction but couldn't. It goes in when that turn ends ({detail})" },
  "activity.urgent_interrupt_unconfirmed": { ko: "대표의 급한 지시를 넣으려고 하던 턴에 멈춤 키를 보냈지만 바로 멈춘 것은 확인하지 못했습니다. 멈추거나 그 턴이 끝나면 들어갑니다 ({detail})", en: "Sent the stop key to the current turn for your urgent instruction but couldn't confirm it stopped right away. It goes in when the turn stops or ends ({detail})" },
  // 0.2.7 배포 전 확인(real-cli P1): Codex 의 턴은 멈췄지만 실행하던 셸 명령이 백그라운드 터미널로 계속 돈다. IAMCEO 는 그 명령을 끄지 않는다.
  "activity.urgent_interrupt_background": { ko: "대표의 급한 지시를 넣으려고 하던 턴을 멈췄지만, 실행하던 명령(백그라운드 터미널 {count}개)이 계속 돌고 있습니다. 그 명령이 끝나거나 터미널에서 /stop 으로 닫아야 급한 지시가 들어갑니다. IAMCEO는 그 명령을 끄지 않습니다", en: "Stopped the current turn for your urgent instruction, but the command it was running keeps going in background terminals ({count}). The urgent instruction goes in when that command ends or you close it with /stop in the terminal. IAMCEO doesn't stop it" },
  "activity.compact_failed_engine": { ko: "압축 실패: 실행 엔진이 제때 답하지 않아 압축을 시작하지 못했습니다. 기다리던 전달을 먼저 보냅니다", en: "Compaction failed: the engine didn't answer in time, so compaction couldn't start. Waiting deliveries go first" },
  "activity.compact_failed_busy": { ko: "압축 실패: 입력칸의 글이나 CLI 화면 때문에 압축을 시작하지 못했습니다. 기다리던 전달을 먼저 보냅니다", en: "Compaction failed: text in the input box or the CLI screen kept it from starting. Waiting deliveries go first" },
  "activity.compact_failed": { ko: "압축 실패: {detail}", en: "Compaction failed: {detail}" },
  // 0.2.7 배포 전 확인(real-cli P3): Claude 의 도는 압축을 '중단'하면 Claude 가 끊긴 /compact 명령을 입력칸에 되돌려 전달이 막혔다.
  // IAMCEO 가 넣은 그 명령과 글자까지 같을 때만 지운다(대표가 쓴 글은 지우지 않는다). 같다고 확인하지 못하면 지우지 않고 안내만 남긴다.
  "activity.compact_draft_cleared": { ko: "압축을 멈춘 뒤 입력칸에 되살아난 IAMCEO의 압축 명령을 지웠습니다(IAMCEO가 넣은 글과 글자까지 같을 때만 지웁니다). 기다리던 전달을 이어 넣습니다", en: "After the compaction was stopped, the compaction command IAMCEO had typed came back in the input box, so it was cleared (only text identical to what IAMCEO typed is cleared). Waiting deliveries continue" },
  "activity.compact_draft_left": { ko: "압축을 멈춘 뒤 입력칸에 글이 남아 있어 전달을 기다립니다. IAMCEO가 넣은 압축 명령이 되살아난 것이면 터미널에서 지워 주세요(대표가 쓴 글일 수 있어 IAMCEO는 지우지 않습니다)", en: "Text was left in the input box after the compaction was stopped, so deliveries wait. If it is the compaction command IAMCEO typed, clear it in the terminal (IAMCEO doesn't clear it because it may be yours)" },
  // 0.2.7 배포 전 재확인(real-cli-3 곁 문제): Claude 가 압축할 대화가 적어 압축 명령을 'Not enough messages to compact.' 로 끝냈다. 막힘이 아니다.
  "activity.compact_nothing": { ko: "압축하지 않았습니다: 압축할 대화가 아직 적다고 Claude가 답했습니다. 기다리던 전달을 이어 넣습니다", en: "Not compacted: Claude said there isn't enough conversation to compact yet. Waiting deliveries continue" },
  "activity.trust_auto": { ko: "프로젝트를 만들 때 대표가 이 폴더를 신뢰한다고 답해, 폴더 신뢰 확인 창에서 '{label}' 을 골랐습니다 · {cwd}", en: "You said you trust this folder when creating the project, so '{label}' was chosen at the folder trust prompt · {cwd}" },
  "activity.tidy": { ko: "판 정리: {text}", en: "Board tidy-up: {text}" },
  "activity.delivery_stalled": { ko: "전달이 진행되지 않고 있습니다. 다시 확인해 주세요", en: "Delivery is not moving. Please check it again" },
  "activity.delivery_corrected": { ko: "전달 기록에서 수신을 확인해 표시를 바로잡았습니다 ({id})", en: "The delivery record showed it was received, so the status was corrected ({id})" },
  "activity.submit_only": { ko: "입력칸의 지시를 다시 넣지 않고 제출합니다 ({id})", en: "Submitting the instruction already in the input box without entering it again ({id})" },
  "activity.resend_risk": { ko: "중복 위험 동의를 받아 지시를 재전송합니다 ({id})", en: "Resending the instruction with your consent to the duplicate risk ({id})" },
  "activity.resend_auto": { ko: "미전달을 확인해 같은 지시를 자동 재전송합니다 ({id})", en: "Confirmed it was not delivered; resending the same instruction automatically ({id})" },
  "activity.gone_resend_risk": { ko: "전달을 받던 터미널이 끝났습니다. 중복 위험 동의를 받아 다시 열린 세션에 다시 보냅니다 ({id})", en: "The terminal receiving the delivery closed. Sending again to the reopened session with your consent to the duplicate risk ({id})" },
  "activity.gone_resend": { ko: "전달을 받던 터미널이 끝났고 세션 기록에 받은 흔적이 없습니다. 다시 열린 세션에 다시 보냅니다 ({id})", en: "The terminal receiving the delivery closed and the session record shows no receipt. Sending again to the reopened session ({id})" },
  "activity.resize_unconfirmed": { ko: "경고: 2초 안에 터미널 크기 복원을 확인하지 못해 계속 진행합니다", en: "Warning: couldn't confirm the terminal size was restored within 2 seconds; continuing" },
  "activity.control_dropped": { ko: "터미널 연결이 끊겨 직접 조작을 자동으로 끝냈습니다", en: "The terminal connection dropped, so direct control ended automatically" },
  "activity.control_started": { ko: "대표가 터미널에서 직접 입력을 시작했습니다", en: "You started typing in the terminal directly" },
  "activity.control_ended": { ko: "대표가 터미널에서 직접 입력을 마쳤습니다", en: "You finished typing in the terminal directly" },
  "activity.tool_requested": { ko: "도구 승인 요청을 결재함에 올렸습니다 · {action}: {target}", en: "Posted a tool approval request to the Inbox · {action}: {target}" },
  "activity.tool_allowed": { ko: "대표가 결재함에서 도구 승인 요청을 허용했습니다 · {action}: {target}", en: "You allowed the tool approval request in the Inbox · {action}: {target}" },
  "activity.tool_denied": { ko: "대표가 결재함에서 도구 승인 요청을 거절했습니다 · {action}: {target}", en: "You denied the tool approval request in the Inbox · {action}: {target}" },
  "activity.tool_allowed_plain": { ko: "대표가 결재함에서 도구 승인 요청을 허용했습니다", en: "You allowed the tool approval request in the Inbox" },
  "activity.tool_denied_plain": { ko: "대표가 결재함에서 도구 승인 요청을 거절했습니다", en: "You denied the tool approval request in the Inbox" },
  "activity.tool_card_closed": { ko: "도구 승인 카드를 닫았습니다 · {reason}", en: "Closed the tool approval card · {reason}" },
  // Codex 가 띄우고 남겨 둔 백그라운드 터미널: 그동안 실행 엔진은 일하는 중으로 알린다(CoreRunner.codexBackground, server/runner/codex-turn.ts).
  "activity.codex_background_left": { ko: "턴은 끝났습니다. Codex가 띄운 백그라운드 프로그램({count}개)이 아직 돌고 있어, 다음 전달은 그 프로그램이 끝날 때까지 기다립니다. IAMCEO는 그 프로그램을 끄지 않습니다. 터미널에서 /ps 로 보고 /stop 으로 닫을 수 있습니다", en: "The turn ended. Background programs that Codex started ({count}) are still running, so the next delivery waits until they finish. IAMCEO doesn't stop them. In the terminal, /ps lists them and /stop closes them" },
  // 0.2.7 배포 전 확인(real-cli P1): 중단(turn_aborted)으로 끝난 턴의 명령이 백그라운드 터미널로 남았다.
  "activity.codex_background_after_stop": { ko: "턴은 멈췄지만 실행하던 명령(백그라운드 터미널 {count}개)이 계속 돌고 있습니다. 그 명령이 끝나거나 터미널에서 /stop 으로 닫아야 다음 전달이 들어갑니다. IAMCEO는 그 명령을 끄지 않습니다(/ps 로 볼 수 있습니다)", en: "The turn stopped, but the command it was running keeps going in background terminals ({count}). The next delivery goes in when that command ends or you close it with /stop in the terminal. IAMCEO doesn't stop it (/ps lists it)" },
  "activity.codex_background_unverified": { ko: "Codex가 띄운 백그라운드 프로그램({count}개) 때문에 일하는 중으로 보입니다. 턴이 끝났는지 확인하지 못해 그대로 둡니다: {why}", en: "It shows as working because of background programs that Codex started ({count}). Couldn't confirm the turn ended, so it is left as is: {why}" },
  "why.codex_log_unbound": { ko: "Codex 세션 기록을 아직 이 팀장과 연결하지 못했습니다", en: "the Codex session record isn't linked to this staff member yet" },
  "why.codex_turn_unconfirmed": { ko: "Codex 세션 기록에서 이 턴이 끝났다는 기록을 찾지 못했습니다", en: "the Codex session record doesn't show that this turn finished" },
  "why.codex_log_unreadable": { ko: "Codex 세션 기록을 끝까지 읽지 못했습니다", en: "couldn't read the Codex session record to the end" },
  // Claude 가 자기 근거(세션 기록의 턴 끝·훅)로 끝낸 턴인데 실행 엔진은 working 을 알린다(CoreRunner.claudeQuiet, server/runner/claude-turn.ts).
  "activity.claude_background_left": { ko: "턴은 끝났습니다. Claude가 띄운 뒤 작업(워크플로·백그라운드 에이전트·셸 등)이 아직 돌고 있어 쉬는 중으로 둡니다. 그동안 온 전달은 바로 넣고, 잠재우기·CLI 바꾸기·설정 적용·문맥 압축은 그 작업이 끝난 뒤에 합니다. 작업이 끝나면 Claude가 그 알림을 받아 스스로 이어 갑니다", en: "The turn ended. Background work that Claude started (workflows, background agents, shells and so on) is still running, so it shows as idle. New deliveries go in right away; sleep, CLI switch, settings changes and context compaction wait until that work ends. When it ends, Claude gets notified and continues on its own" },
  "activity.claude_login_required": { ko: "Claude 로그인(계정) 오류로 이 턴이 끝났습니다. 터미널에서 /login 으로 다시 로그인하세요. 다음 턴이 정상으로 돌 때까지 이 팀장에게 가는 전달은 보류합니다", en: "This turn ended with a Claude sign-in (account) error. Run /login in the terminal to sign in again. Deliveries to this staff member are held until the next turn runs normally" },
  "activity.claude_idle_compacted": { ko: "쉬는 동안 Claude가 스스로 대화를 압축했습니다(턴이 아닙니다). 문맥 사용량은 압축 뒤 값으로 다시 잽니다", en: "Claude compacted the conversation on its own while idle (not a turn). Context usage is measured again after compaction" },

  // ---- 서버가 만드는 결재 카드 ----
  "card.tool_permission.title": { ko: "{action}: {titleTarget}", en: "{action}: {titleTarget}" },
  "card.tool_permission": { ko: `${TOOL_WAIT_KO}{folderLine}${TOOL_TAIL_KO}`, en: `${TOOL_WAIT_EN}{folderLine}${TOOL_TAIL_EN}` },
  "card.tool_permission.folder": { ko: "\n폴더: {folder}", en: "\nFolder: {folder}" },
  "card.tool_permission.allow": { ko: "허용", en: "Allow" },
  "card.tool_permission.allow_desc": { ko: "이번 한 번만 실행합니다", en: "Runs it this one time only" },
  "card.tool_permission.deny": { ko: "거절", en: "Deny" },
  "card.tool_permission.deny_desc": { ko: "실행하지 않고 팀장에게 알립니다", en: "Doesn't run it and tells the staff member" },
  "card.tool_permission.closed_restart": { ko: "서버가 다시 시작되어 승인 요청이 끊겼습니다. 터미널의 승인 창에서 답해 주세요", en: "The server restarted and the approval request was cut off. Answer at the approval prompt in the terminal" },
  "card.tool_permission.closed_cut": { ko: "승인 요청이 끊겼습니다. 터미널의 승인 창에서 답해 주세요", en: "The approval request was cut off. Answer at the approval prompt in the terminal" },
  "card.tool_permission.closed_terminal_side_ended": { ko: "터미널 쪽 요청이 끝나 닫았습니다. 터미널에서 답했거나 일이 멈췄습니다", en: "Closed because the request ended on the terminal side. It was answered in the terminal or the work stopped" },
  "card.tool_permission.closed_already_over": { ko: "승인 요청이 이미 끝났습니다. 터미널의 승인 창에서 답해 주세요", en: "The approval request already ended. Answer at the approval prompt in the terminal" },
  "card.tool_permission.closed_terminal_ended": { ko: "팀장의 터미널이 끝나 닫았습니다", en: "Closed because the staff member's terminal ended" },
  "card.tool_permission.closed_answered_in_terminal": { ko: "터미널에서 먼저 답해 승인 창이 닫혔습니다", en: "It was answered in the terminal first, so the approval prompt closed" },
  "card.tool_permission.closed_terminal_side_cut": { ko: "터미널 쪽 요청이 끊겨 닫았습니다. 터미널의 승인 창에서 답해 주세요", en: "Closed because the request was cut off on the terminal side. Answer at the approval prompt in the terminal" },
  "card.tool_permission.closed_timeout": { ko: "{minutes}분 동안 답이 없어 터미널의 승인 창으로 넘겼습니다", en: "No answer for {minutes} min, so it went back to the approval prompt in the terminal" },
  "card.tool_permission.closed_server_stopped": { ko: "서버가 멈춰 승인 요청이 끊겼습니다. 터미널의 승인 창에서 답해 주세요", en: "The server stopped and the approval request was cut off. Answer at the approval prompt in the terminal" },
  // 도구 승인 카드의 '무엇을'(ToolPermissionInfo.action)
  "tool.action.bash": { ko: "명령 실행", en: "Run a command" },
  "tool.action.bash_output": { ko: "명령 출력 읽기", en: "Read command output" },
  "tool.action.kill_shell": { ko: "실행 중인 명령 끝내기", en: "Stop a running command" },
  "tool.action.edit": { ko: "파일 고치기", en: "Edit a file" },
  "tool.action.write": { ko: "파일 쓰기", en: "Write a file" },
  "tool.action.notebook_edit": { ko: "노트북 고치기", en: "Edit a notebook" },
  "tool.action.read": { ko: "파일 읽기", en: "Read a file" },
  "tool.action.glob": { ko: "파일 찾기", en: "Find files" },
  "tool.action.grep": { ko: "파일 내용 찾기", en: "Search file contents" },
  "tool.action.ls": { ko: "폴더 보기", en: "List a folder" },
  "tool.action.web_fetch": { ko: "웹 페이지 가져오기", en: "Fetch a web page" },
  "tool.action.web_search": { ko: "웹 검색", en: "Search the web" },
  "tool.action.task": { ko: "하위 작업 맡기기", en: "Hand off a subtask" },
  "tool.action.skill": { ko: "스킬 쓰기", en: "Use a skill" },
  "tool.action.slash_command": { ko: "명령어 쓰기", en: "Use a slash command" },
  "tool.action.mcp": { ko: "연결 도구 쓰기({server})", en: "Use a connected tool ({server})" },
  "tool.action.other": { ko: "도구 쓰기({tool})", en: "Use a tool ({tool})" },
  // 한국어로 그린 '무엇을'이 60자를 넘을 때(예전 clip(action, 60) 과 같은 글자): 값은 잘린 앞부분, count 는 잘려 나간 글자 수.
  "tool.action.mcp_clipped": { ko: "연결 도구 쓰기({server}…({count}자 더 있음)", en: "Use a connected tool ({server}… {count} more characters)" },
  "tool.action.other_clipped": { ko: "도구 쓰기({tool}…({count}자 더 있음)", en: "Use a tool ({tool}… {count} more characters)" },
  // 사용 한도 카드
  "card.usage_limit.title_initial": { ko: "사용 한도 도달", en: "Usage limit reached" },
  "card.usage_limit.title": { ko: "{cli} 사용 한도 도달 · 팀원 {count}명 멈춤", en: "{cli} usage limit reached · {count} staff stopped" },
  "card.usage_limit": { ko: "{lead}\n\n{names}\n\n{raw}", en: "{lead}\n\n{names}\n\n{raw}" },
  "card.usage_limit.short": { ko: "{lead}\n\n{names}", en: "{lead}\n\n{names}" },
  "card.usage_limit.short.title": { ko: "{cli} 사용 한도 도달 · 팀원 {count}명 멈춤", en: "{cli} usage limit reached · {count} staff stopped" },
  "card.usage_limit.still_models": { ko: `아직 한도가 남아 있지 않습니다. 기다리거나 다른 모델을 고르세요${ELSEWHERE_KO}.`, en: `There is still no limit left. Wait, or pick another model${ELSEWHERE_EN}.` },
  "card.usage_limit.still_wait": { ko: "아직 한도가 남아 있지 않습니다. 한도가 풀리면 자동으로 이어 갑니다.", en: "There is still no limit left. It continues automatically when the limit resets." },
  "card.usage_limit.lead": { ko: `{core} ${ANOTHER_ACCOUNT_KO}`, en: `{core} ${ANOTHER_ACCOUNT_EN}` },
  "card.usage_limit.lead_models": { ko: `{core} ${PICK_MODEL_KO}${ANOTHER_ACCOUNT_KO}`, en: `{core} ${PICK_MODEL_EN}${ANOTHER_ACCOUNT_EN}` },
  "card.usage_limit.credit_named": { ko: "{model} 사용 크레딧이 떨어졌습니다. 다른 모델로 바꾸면 바로 이어 갑니다. 기다리면 크레딧이 채워질 때 자동으로 이어 갑니다.", en: "{model} is out of usage credits. Switching to another model continues right away. If you wait, it continues automatically when the credits refill." },
  "card.usage_limit.credit_named_at": { ko: "{model} 사용 크레딧이 떨어졌습니다. 다른 모델로 바꾸면 바로 이어 갑니다. 기다리면 {at}에 크레딧이 채워질 때 자동으로 이어 갑니다.", en: "{model} is out of usage credits. Switching to another model continues right away. If you wait, it continues automatically when the credits refill at {at}." },
  "card.usage_limit.credit": { ko: "이 모델의 사용 크레딧이 떨어졌습니다. 다른 모델로 바꾸면 바로 이어 갑니다. 기다리면 크레딧이 채워질 때 자동으로 이어 갑니다.", en: "This model is out of usage credits. Switching to another model continues right away. If you wait, it continues automatically when the credits refill." },
  "card.usage_limit.credit_at": { ko: "이 모델의 사용 크레딧이 떨어졌습니다. 다른 모델로 바꾸면 바로 이어 갑니다. 기다리면 {at}에 크레딧이 채워질 때 자동으로 이어 갑니다.", en: "This model is out of usage credits. Switching to another model continues right away. If you wait, it continues automatically when the credits refill at {at}." },
  "card.usage_limit.reset_at": { ko: "{at}에 한도가 풀리면 자동으로 이어 갑니다. 기다리셔도 됩니다.", en: "It continues automatically when the limit resets at {at}. You can just wait." },
  "card.usage_limit.probe": { ko: "한도가 풀렸는지 가끔 다시 확인해 자동으로 이어 갑니다. 기다리셔도 됩니다.", en: "It checks now and then whether the limit has reset and continues automatically. You can just wait." },
  "card.usage_limit.option_model": { ko: "{model:으로} 바꿔 이어가기", en: "Switch to {model} and continue" },
  "card.usage_limit.option_resume": { ko: "계정을 바꿨거나 한도를 늘렸어요 · 이어가기", en: "I switched accounts or raised my limit · Continue" },
  // 결재 카드의 닫힘·다시 열림
  "card.closed_member_removed": { ko: "{name:이} 명부에서 빠져 함께 닫혔습니다", en: "Closed along with {name}, who left the team" },
  "card.reopen_undelivered": { ko: "전달하지 못했습니다. 다시 결정해 주세요", en: "It couldn't be delivered. Please decide again" },
  "card.reopen_not_connected": { ko: "연결 전이라 전달되지 않았습니다. 다시 결정해 주세요", en: "It wasn't delivered because nothing was connected yet. Please decide again" },
  // 0.2.7 묶음 1(점검 D3-10): 대표가 결재 답의 전달을 그만뒀다.
  "card.reopen_stopped": { ko: "전달을 그만둔 답입니다. {name:이} 받지 못했을 수 있으니 다시 결정해 주세요", en: "You stopped delivering this answer, so {name} may not have it. Please decide again" },
  "card.reopen_by_owner": { ko: "{who:이} 닫았던 결재를 대표가 다시 열었습니다", en: "You reopened the decision {who} had closed" },
  "card.reopen_by_owner_reason": { ko: "{who:이} 닫았던 결재를 대표가 다시 열었습니다(닫은 이유: {reason})", en: "You reopened the decision {who} had closed (reason it was closed: {reason})" },
  // 0.2.7 묶음 4: ask 도구 replaces 로 새 카드가 앞 카드를 대신해 닫힌 이유.
  // 0.2.7 배포 전 확인(문제 3): 내부 번호(#d_…)를 싣지 않는다. 새 카드는 앱의 '새 카드 보기'(replacedBy)로 간다.
  "card.replaced": { ko: "새 카드로 대신했습니다", en: "Replaced by a newer card" },

  // ---- 낱말 ----
  "word.unknown": { ko: "알 수 없음", en: "unknown" },
  "word.unknown_cause": { ko: "원인 미확인", en: "unknown cause" },
  // 0.2.7 묶음 1: chat.owner_delivery_behind 의 {what}
  "word.owner_answer": { ko: "대표 결재 답", en: "your decision answer" },
  "word.owner_message": { ko: "대표 메시지", en: "your message" },
  "word.owner_todo_done": { ko: "할 일 완료 소식", en: "your to-do completion" },
  "word.owner_instruction": { ko: "대표 요청을 옮긴 총괄 지시", en: "the lead's instruction with your request" },

  // ---- 서버의 Mac 스크립트 알림(osascript) 전용. 앱 표에는 넣지 않는다 ----
  "notice.api_usage.title": { ko: "API 연결·사용 한도", en: "Internet connection · usage limit" },
  "notice.approval_wait.title": { ko: "{name} 승인 대기", en: "{name} is waiting for approval" },
  "notice.tool_card_unanswered": { ko: "도구 승인 요청에 답이 없어 카드를 닫았습니다. 터미널의 승인 창에서 답해 주세요", en: "No answer to the tool approval request, so the card was closed. Answer at the approval prompt in the terminal" },
  "notice.start_failed.title": { ko: "{name} 세션 시작 실패", en: "{name} session didn't start" },
  "notice.start_slow.title": { ko: "{name} 시작 지연", en: "{name} is slow to start" },
  "notice.start_slow": { ko: "시작이 늦어지고 있습니다. 터미널을 열어 화면을 확인해 주세요", en: "Starting is taking long. Open the terminal and check the screen" },
  "notice.check_needed.title": { ko: "{name} 확인 필요", en: "{name} needs a check" },
  "notice.trust_unreadable": { ko: "폴더 신뢰 확인 창을 읽지 못했습니다. 터미널을 열어 직접 답해 주세요", en: "Couldn't read the folder trust prompt. Open the terminal and answer it yourself" },
  "notice.gemini_setup": { ko: "Antigravity CLI의 로그인·첫 설정이 끝나지 않았습니다. 터미널을 열어 직접 끝내 주세요", en: "Antigravity CLI hasn't finished sign-in or first-run setup. Open the terminal and finish it yourself" },
  "notice.approval_prompt": { ko: "승인 창 앞에서 멈췄습니다", en: "Stopped at an approval prompt" },
  "notice.approval_summary": { ko: "{summary} · 결재함에서 승인·거절할 수 있습니다", en: "{summary} · you can approve or deny it in the Inbox" },
  "notice.tool_permission.title": { ko: "{name} 도구 승인", en: "{name} tool approval" },
  "notice.decision.title": { ko: "{name}의 결재", en: "Decision from {name}" },
  "notice.request.title": { ko: "{name}의 부탁", en: "Request from {name}" },
} as const satisfies Record<string, ServerTextTemplate>;

export type ServerTextCode = keyof typeof SERVER_TEXTS;

/** 앱 표(Localizable.xcstrings 의 server.text.*)에 넣지 않는 코드: 서버의 Mac 스크립트 알림 전용. */
export function isServerOnlyText(code: string): boolean { return code.startsWith("notice."); }

export function isServerTextCode(code: unknown): code is ServerTextCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(SERVER_TEXTS, code);
}

/** 보고 언어 값을 고른다. "en" 만 영어, 그 밖에(없음 포함) 한국어. */
export function textLang(value: unknown): TextLang { return value === "en" ? "en" : "ko"; }

/** 코드와 값을 묶는다. */
export function textRef(code: ServerTextCode, params?: Record<string, ServerTextParam>): ServerTextRef {
  return params && Object.keys(params).length ? { code, params } : { code };
}

/** 이름 뒤 조사(이·을·은). 받침이 없으면 가·를·는. 한글이 아닌 끝은 받침 없는 것으로 친다(server/roles.ts josa 와 같다). */
export function josaKo(word: string, withFinal: "이" | "을" | "은"): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  const hasFinal = code >= 0 && code <= 11171 && code % 28 !== 0;
  return word + (hasFinal ? withFinal : { 이: "가", 을: "를", 은: "는" }[withFinal]);
}

/** '로'/'으로'(server/api-outage.ts particleRo 와 같다). 숫자·영문은 우리말로 읽을 때의 끝소리로, 정할 수 없으면 '(으)로'. */
export function particleRoKo(word: string): string {
  const text = word.trim();
  const last = text.at(-1) ?? "";
  const code = last.charCodeAt(0) - 0xac00;
  if (code >= 0 && code <= 11171) return code % 28 === 0 || code % 28 === 8 ? "로" : "으로";
  if (/[0-9]/.test(last)) return "036".includes(last) ? "으로" : "로";
  const lower = text.toLowerCase();
  if (!/[a-z]$/.test(lower)) return "(으)로";
  return /(?:ng|[mnbckpt])$/.test(lower) ? "으로" : "로";
}

/** 사용 한도가 풀리는 때. 한국어는 예전 카드와 같은 '11월 14일 오후 3시 30분', 영어는 'Nov 14, 3:30 PM'. 서버가 도는 Mac 의 시간대. */
export function formatTextDate(at: string, lang: TextLang): string | null {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (lang === "ko") {
    const parts = new Intl.DateTimeFormat("ko-KR", { timeZone, month: "long", day: "numeric", hour: "numeric", minute: "numeric", hour12: true }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? "";
    return `${part("month")} ${part("day")}일 ${part("dayPeriod")} ${part("hour")}시${Number(part("minute")) ? ` ${Number(part("minute"))}분` : ""}`;
  }
  const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric" }).format(date));
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", ...(minute ? { minute: "2-digit" } : {}), hour12: true }).format(date);
}

/**
 * 0.2.7 배포 전 확인(문제 3): 시각만. 한국어 '오후 3시 23분'(정각이면 '오후 3시'), 영어 '3:23 PM'(정각이면 '3 PM'). formatTextDate 의 시각 부분과 같은 꼴이다.
 */
export function formatTextTime(at: string, lang: TextLang): string | null {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (lang === "ko") {
    const parts = new Intl.DateTimeFormat("ko-KR", { timeZone, hour: "numeric", minute: "numeric", hour12: true }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? "";
    return `${part("dayPeriod")} ${part("hour")}시${Number(part("minute")) ? ` ${Number(part("minute"))}분` : ""}`;
  }
  const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric" }).format(date));
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", ...(minute ? { minute: "2-digit" } : {}), hour12: true }).format(date);
}

/**
 * 0.2.7 배포 전 확인(문제 3): '…부터' 같은 시각 값. 글을 만드는 지금과 같은 날(서버가 도는 Mac 의 시간대)이면 시각만('오후 3시 23분부터'),
 * 다른 날이면 날짜까지({ at }: '11월 15일 오후 11시 40분부터'). 같은 날인지는 만들 때 정해 언어별 글자로 싣는다: 앱이 나중에(다음 날) 다시 그려도
 * 저장된 문장과 같게 나온다(코드로 다시 그린 문장이 저장된 문장과 같을 때만 코드를 싣는 규칙).
 */
export function sinceParam(at: string, now: number = Date.now()): ServerTextParam {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return { at };
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  if (day(date) !== day(new Date(now))) return { at };
  const ko = formatTextTime(at, "ko"), en = formatTextTime(at, "en");
  return ko && en ? langsParam(ko, en) : { at };
}

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)(?::(이|을|은|으로))?\}/g;

function isRef(value: ServerTextParam): value is ServerTextRef {
  return typeof value === "object" && value !== null && typeof (value as ServerTextRef).code === "string";
}

function isLangs(value: unknown): value is ServerTextLangs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && typeof (value as ServerTextLangs).ko === "string" && typeof (value as ServerTextLangs).en === "string";
}

function paramText(value: ServerTextParam | undefined, lang: TextLang, depth: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (isRef(value)) return depth >= 4 ? null : render(value, lang, depth + 1);
  if (isLangs(value)) return value[lang];
  if (typeof (value as ServerTextDate).at === "string") return formatTextDate((value as ServerTextDate).at, lang);
  return null;
}

/** 언어별 글자 값. 두 언어가 같으면 그냥 글자로 둔다(저장이 짧고, 그 앞 판의 앱도 그대로 읽는다). */
export function langsParam(ko: string, en: string): string | ServerTextLangs {
  return ko === en ? ko : { ko, en };
}

function render(ref: ServerTextRef, lang: TextLang, depth: number): string | null {
  if (!isServerTextCode(ref.code)) return null;
  const template = SERVER_TEXTS[ref.code][lang];
  let missing = false;
  const out = template.replace(PLACEHOLDER, (_whole, name: string, particle: string | undefined) => {
    const value = paramText(ref.params?.[name], lang, depth);
    if (value === null) { missing = true; return ""; }
    if (!particle || lang !== "ko") return value;
    return particle === "으로" ? `${value}${particleRoKo(value)}` : josaKo(value, particle as "이" | "을" | "은");
  });
  return missing ? null : out;
}

/** 코드와 값을 그 언어의 문장으로. 모르는 코드나 빠진 값이 있으면 null. */
export function renderServerText(ref: ServerTextRef, lang: TextLang): string | null {
  return render(ref, lang, 0);
}

/** 그릴 수 있어야 하는 자리(서버가 방금 만든 글). 못 그리면 예외: 코드 표와 부르는 쪽이 어긋난 버그다. */
export function mustRender(ref: ServerTextRef, lang: TextLang): string {
  const text = renderServerText(ref, lang);
  if (text === null) throw new Error(`server text cannot be rendered: ${ref.code}`);
  return text;
}

/** 대화 글의 제목 코드(`<코드>.title`). 없으면 null. */
export function titleCodeOf(code: string): ServerTextCode | null {
  const title = `${code}.title`;
  return isServerTextCode(title) ? title : null;
}

/** 값 모양 검사(저장된 JSON 을 읽을 때). 문자열·{code,params}·{at}·{ko,en} 만 받는다. */
export function isServerTextRef(value: unknown, depth = 0): value is ServerTextRef {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4) return false;
  const ref = value as Record<string, unknown>;
  if (typeof ref.code !== "string") return false;
  if (ref.params === undefined) return true;
  if (!ref.params || typeof ref.params !== "object" || Array.isArray(ref.params)) return false;
  return Object.values(ref.params as Record<string, unknown>).every(param =>
    typeof param === "string" || isServerTextRef(param, depth + 1) || isLangs(param) ||
    (!!param && typeof param === "object" && !Array.isArray(param) && typeof (param as ServerTextDate).at === "string" && Object.keys(param).length === 1));
}
