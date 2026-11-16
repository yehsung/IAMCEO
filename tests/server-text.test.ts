// 0.2.6 Y: 영어 사용자에게 서버가 보내는 글. 코드 표(shared/server-text.ts)·한국어 대조·저장과 응답·기본 이름·알림 언어.
//
// 한국어 대조: 바꾸기 전(59f26a9) 코드의 식을 그대로 옮겨 같은 값으로 문장을 만들고, 새 코드가 보고 언어 한국어로 그린 문장과
// 글자까지 같은지 본다. 여기 OLD 의 식은 고치지 않는다(바꾸면 대조가 뜻이 없어진다).
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { ERROR_CODES } from "../shared/error-codes.ts";
import { formatTextDate, isServerOnlyText, mustRender, renderServerText, SERVER_TEXTS, textRef, type ServerTextRef, type TextLang } from "../shared/server-text.ts";
import { Store } from "../server/store.ts";
import { josa } from "../server/roles.ts";
import { ApiRecovery, USAGE_RESUME_OPTION, withRo } from "../server/api-outage.ts";
import { describeToolRequest, describeToolTargets, TOOL_PERMISSION_OPTIONS, toolActionRef, toolPermissionCard, toolPermissionCardTexts } from "../server/tool-permission.ts";
import { RESTART_EXIT_NOTE, RESTART_REOPENED_NOTE } from "../server/restart-wake.ts";
import { conductorName, DEFAULT_NAMES, firstRunLang } from "../server/text.ts";
import { deliveryNoteCode, NOTE_CODES } from "../server/hold-codes.ts";
import { exitActivity, exitDetail, exitDetailRef, LAST_ERROR_CODES, lastErrorParam } from "../server/text-refs.ts";
import { APNsClient, buildAPNsPayload, PUSH_BODIES } from "../server/push/apns.ts";
import type { APNsNotification, APNsTransport, APNsTransportRequest, APNsTransportResult } from "../server/push/apns.ts";
import type { APNsConfig } from "../server/push/config.ts";
import { relayPushBody } from "../server/push/relay.ts";
import { createPushHandler, requestLanguage } from "../server/push/routes.ts";
import { PushStore } from "../server/push/store.ts";
import { PushWorker } from "../server/push/worker.ts";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";
import { CATALOG_PATH, KEY_PREFIX, renderCatalog, renderServerTextSwift, SWIFT_PATH, xcstrings } from "../scripts/gen-server-text-swift.ts";

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
const ko = (ref: ServerTextRef) => mustRender(ref, "ko");
const en = (ref: ServerTextRef) => mustRender(ref, "en");
const HANGUL = /[가-힣ㄱ-ㆎ]/;

function freshStore() {
  const db = openDb(":memory:"); closers.push(() => db.close());
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "결제", cwd: "/private/tmp/iamceo-y-work" });
  const member = store.createMember({ projectId: project.id, handle: "pay", name: "결제 연동", cli: "claude", kind: "worker", backend: "core" });
  return { db, store, project, member };
}

describe("코드 표", () => {
  const entries = Object.entries(SERVER_TEXTS as Record<string, { ko: string; en: string }>);
  const placeholders = (template: string) => [...template.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)(?::[^}]*)?\}/g)].map(m => m[1]).sort();

  test("코드 이름은 앱 문구 표 열쇠(server.text.<코드>)가 될 수 있는 모양이다", () => {
    for (const [code] of entries) expect(`${KEY_PREFIX}${code}`).toMatch(/^[a-z]+(?:\.[a-z_]+)+$/);
  });

  test("영어에 한글이 없고, 두 언어의 값 자리가 같고, 조사 표시는 한국어에만, % 는 쓰지 않는다", () => {
    for (const [code, text] of entries) {
      expect([code, HANGUL.test(text.en)]).toEqual([code, false]);
      expect([code, placeholders(text.en)]).toEqual([code, placeholders(text.ko)]);
      expect([code, /\{[a-zA-Z0-9_]+:/.test(text.en)]).toEqual([code, false]);
      expect([code, text.ko.includes("%") || text.en.includes("%")]).toEqual([code, false]);
    }
  });

  test("모르는 코드·빠진 값은 그리지 않는다. 값 안의 { } 는 다시 풀지 않는다", () => {
    expect(renderServerText({ code: "chat.nope" }, "ko")).toBeNull();
    expect(renderServerText({ code: "chat.member_error", params: { name: "a" } }, "ko")).toBeNull();
    expect(ko(textRef("chat.member_error", { name: "a", error: "{name} {\"x\":1}" }))).toBe("a 오류: {name} {\"x\":1}");
  });

  test("앱 사본(ServerTextCatalog.swift)과 문구 표(server.text.*)가 이 표와 같다", () => {
    // 다르면: bun scripts/gen-server-text-swift.ts
    expect(readFileSync(SWIFT_PATH, "utf8")).toBe(renderServerTextSwift());
    const current = readFileSync(CATALOG_PATH, "utf8");
    expect(current).toBe(renderCatalog(current));
    // 표의 다른 열쇠는 Xcode 꼴 그대로(다시 써도 글자까지 같다).
    expect(xcstrings(JSON.parse(current)) + "\n").toBe(current);
    const strings = JSON.parse(current).strings as Record<string, { localizations: Record<string, { stringUnit: { value: string } }> }>;
    for (const [code, text] of entries) {
      const entry = strings[`${KEY_PREFIX}${code}`];
      if (isServerOnlyText(code)) { expect(entry).toBeUndefined(); continue; }
      expect(entry?.localizations.ko?.stringUnit.value).toBe(text.ko);
      expect(entry?.localizations.en?.stringUnit.value).toBe(text.en);
    }
  });
});

describe("한국어 대조: 보고 언어 한국어로 그린 글은 바꾸기 전과 글자까지 같다", () => {
  const name = "결제 연동", latin = "dev", run = "run_7", id = "dl_9";

  test("대화의 시스템 글", () => {
    const pairs: [ServerTextRef, string][] = [];
    for (const who of [name, latin]) {
      pairs.push(
        [textRef("chat.member_error", { name: who, error: "boom" }), `${who} 오류: ${"boom"}`],
        [textRef("chat.run_interrupted", { name: who, run, why: "raw reason" }), `${who}: 실행 ${run} 중단 — ${"raw reason"}`],
        [textRef("chat.run_interrupted", { name: who, run, why: textRef("why.restart_session_off") }), `${who}: 실행 ${run} 중단 — ${"Mac이나 실행 엔진이 다시 시작되어 세션이 꺼졌습니다"}`],
        [textRef("chat.run_interrupted", { name: who, run, why: textRef("why.session_vanished") }), `${who}: 실행 ${run} 중단 — ${"종료 근거 없이 세션이 사라졌습니다"}`],
        [textRef("chat.run_restart_resumed", { name: who, run }), `${who}: 실행 ${run} — 재시작으로 끊겨 이어서 하게 했습니다`],
        [textRef("chat.missing_report", { name: who }), `${who}의 결과 보고가 보완 요청 뒤에도 남지 않았습니다. 기존 업무를 다시 실행하지 않고 결과를 확인해 주세요.`],
        [textRef("chat.missing_report.title", { name: who }), "결과 보고 누락"],
        [textRef("chat.delivery_failed", { name: who, detail: "x" }), `${who}에게 전달하지 못했습니다: ${"x"}`],
        [textRef("chat.delivery_stalled", { name: who }), `${who}에게 전달이 진행되지 않고 있습니다. 전달 정보에서 '다시 확인'을 눌러 주세요. 원래 입력을 중복해서 보내지 않습니다.`],
        [textRef("chat.delivery_stalled.title", { name: who }), "전달 확인 필요"],
        [textRef("chat.assigned", { name: who, summary: "결제 화면" }), `총괄이 ${who}에게 맡겼습니다: ${"결제 화면"}${""}`],
        [textRef("chat.assigned_queued", { name: who, summary: "결제 화면" }), `총괄이 ${who}에게 맡겼습니다: ${"결제 화면"}${" (앞 일 끝나면 시작)"}`],
        [textRef("chat.api_resume_failed", { name: who }), `${who}의 인터넷 연결 복구 후 이어가기가 3회 실패했습니다. 터미널을 확인해 주세요.`],
        [textRef("chat.delivery_failed", { name: who, detail: textRef("why.delivery_failed") }), `${who}에게 전달하지 못했습니다: ${"전달 실패"}`],
      );
      // 리뷰: endExecution 이 넘기던 사유 문장(59f26a9 orchestrator.ts 947·957·964·2050·2963·3161·4283).
      for (const [code, old] of [["why.terminal_absent_rejoin", "재결합 조회에서 소유 터미널의 부재를 확인했습니다"], ["why.terminal_absent", "소유 터미널의 부재를 확인했습니다"],
        ["why.terminal_ended", "소유 터미널이 종료되었습니다"], ["why.fresh_session", "명시적 새 세션으로 전환했습니다"], ["why.settings_changed", "세션 설정을 변경했습니다"],
        ["why.slept", "팀원을 잠재워 실행을 종료했습니다"], ["why.closed", "팀원을 닫아 실행을 종료했습니다"], ["why.terminal_ended_or_gone", "소유 터미널이 종료되거나 사라졌습니다"]] as const) {
        pairs.push([textRef("chat.run_interrupted", { name: who, run, why: textRef(code) }), `${who}: 실행 ${run} 중단 — ${old}`]);
      }
      for (const lastError of [null, "exit 1", RESTART_EXIT_NOTE, "초기/실행 종료: exited (exit_code=1)", "초기/실행 종료: 원인 미확인 (exit_code=unknown)", "초기/실행 종료: a (b) (exit_code=1)"]) {
        const ref = lastError ? textRef("chat.quick_exit_error", { name: who, error: lastErrorParam(lastError) }) : textRef("chat.quick_exit", { name: who });
        pairs.push([ref, `${who}의 세션이 시작하자마자 끝나기를 되풀이해 자동으로 다시 깨우지 않습니다. 터미널에서 원인을 확인한 뒤 팀원을 깨워 주세요.${lastError ? ` (${lastError})` : ""}`]);
      }
      for (const kind of ["answer", "user_message"]) {
        const ref = textRef(kind === "answer" ? "chat.owner_answer_late" : "chat.owner_message_late", { name: who, id });
        pairs.push([ref, `${who}에게 보낸 대표 ${josa(kind === "answer" ? "결재 답" : "메시지", "이")} 30분 넘게 전달되지 않았습니다. 전달 #${id}를 확인해 주세요.`]);
        pairs.push([{ ...ref, code: `${ref.code}.title` }, "대표 전달 지연"]);
      }
      for (const outcome of ["failed", "other"]) {
        pairs.push([textRef(outcome === "failed" ? "why.restart_cut_reopen_failed" : "why.restart_cut"), `Mac이나 실행 엔진이 다시 시작되어 끊겼습니다${outcome === "failed" ? ". 세션을 다시 열지 못했습니다" : ""}`]);
      }
      for (const model of ["Opus", "Sonnet", "Fable 5.3", "gpt-6.1-sol", "모델"]) {
        pairs.push(
          [textRef("chat.usage_model_resumed", { name: who, run, model }), `${who}: 실행 ${run} — 사용 한도로 멈춰 모델을 ${withRo(model)} 바꿔 이어서 하게 했습니다`],
          [textRef("why.usage_model_new_session", { model }), `사용 한도로 멈췄습니다. ${`모델을 ${withRo(model)}`} 바꿨지만 이어 열 세션 기록이 없어 새 세션으로 엽니다`],
          [textRef("why.usage_cli_new_session", { cli: model }), `사용 한도로 멈췄습니다. ${`CLI를 ${withRo(model)}`} 바꿔 새 세션으로 엽니다(이전 CLI의 대화는 이어지지 않습니다)`],
        );
      }
    }
    for (const count of [1, 12]) {
      pairs.push(
        [textRef("chat.api_outage", { count: String(count) }), `인터넷 연결이 불안정해 팀원 ${count}명이 멈췄습니다. 연결이 돌아오면 자동으로 이어 갑니다.`],
        [textRef("chat.api_recovered", { count: String(count) }), `인터넷 연결이 돌아와 팀원 ${count}명이 이어서 일합니다.`],
      );
    }
    for (const [ref, old] of pairs) expect([ref.code, ko(ref)]).toEqual([ref.code, old]);
  });

  test("팀장 활동 줄", () => {
    const pairs: [ServerTextRef, string][] = [
      [textRef("activity.turn_end"), "턴 끝"],
      [textRef("activity.start_cancelled"), "세션 기동 결과를 확인하지 못했고 터미널이 생기지 않아 기동을 취소했습니다. 필요하면 다시 깨웁니다"],
      [textRef("activity.reopen_live_stop"), "세션을 다시 열려던 작업이 끊겨 있었습니다. 터미널이 그대로 살아 있어 그 작업을 닫았습니다. 바꾸려던 설정이나 새 세션은 적용되지 않았으니 다시 해 주세요"],
      [textRef("activity.reopen_gone_stop"), "세션을 다시 열려던 작업이 끊겨 있었습니다. 터미널이 끝난 것을 확인해 그 작업을 닫았습니다. 바꾸려던 설정이나 새 세션이 적용되지 않았으면 다시 해 주세요"],
      [textRef("activity.parallel_released"), "병렬 설정을 받은 터미널이 끝나 그 설정의 확인 대기를 풀었습니다. 밀린 전달을 이어 갑니다"],
      [textRef("activity.lease_released"), "직접 조작하던 터미널이 끝나 그 조작권을 거뒀습니다. 밀린 전달을 이어 갑니다"],
      [textRef("activity.restart_reopened"), RESTART_REOPENED_NOTE],
      [textRef("activity.missing_report_final"), "결과 보고 누락: 보완 요청 뒤에도 결과가 남지 않았습니다"],
      [textRef("activity.missing_report_requested"), "필수 보고가 없어 보고 보완을 요청했습니다"],
      [textRef("activity.late_receipt"), "늦게 도착한 수신 확인으로 전달을 확정했습니다"],
      [textRef("activity.late_not_written"), "늦게 도착한 결과로 넣지 못한 것을 확인했습니다. 다시 보냅니다"],
      [textRef("activity.pump_stuck", { seconds: "95", stage: "dispatch" }), `전달 처리가 ${95}초째 끝나지 않았습니다(대기 단계: ${"dispatch"}). 자동으로 다시 넣거나 중단하지 않습니다`],
      [textRef("activity.pump_stuck", { seconds: "95", stage: textRef("word.unknown") }), `전달 처리가 ${95}초째 끝나지 않았습니다(대기 단계: ${"알 수 없음"}). 자동으로 다시 넣거나 중단하지 않습니다`],
      [textRef("activity.overrides_reset", { fields: "modelOverride, effortOverride" }), `CLI 변경으로 지원하지 않는 ${"modelOverride, effortOverride"} 지정을 비우고 직급 기본값으로 되돌렸습니다`],
      [textRef("activity.settings_held_session"), "설정 적용 보류: 같은 대화의 세션 ID를 확인하지 못했습니다. 다음 자연 기동 때 적용합니다"],
      [textRef("activity.orphan_compact_own"), "압축을 받은 터미널이 끝나 그 압축을 닫았습니다. 밀린 전달을 이어 갑니다"],
      [textRef("activity.orphan_compact_left"), "넣지 못한 압축이 확인 대기로 남아 있어 닫았습니다. 밀린 전달을 이어 갑니다"],
      [textRef("activity.stale_turn_cleared"), "끝난 턴의 표시가 남아 전달이 멈춰 있었습니다. 표시를 지우고 다시 보냅니다"],
      [textRef("activity.source_changed", { id: "dl_1" }), `원본이 바뀐 전달을 보내지 않고 거뒀습니다 (${"dl_1"})`],
      [textRef("activity.parallel_on"), `병렬 ${"켬"}`],
      [textRef("activity.parallel_off"), `병렬 ${"끔"}`],
      [textRef("activity.parallel_failed", { detail: "busy" }), `병렬 설정 실패: ${"busy"}`],
      [textRef("activity.compact_start", { pct: `${71}%` }), `압축 시작 (문맥 ${71}%)`],
      [textRef("activity.compact_start", { pct: `${"?"}%` }), `압축 시작 (문맥 ${"?"}%)`],
      [textRef("activity.compact_done"), "압축 완료"],
      [textRef("activity.compact_unconfirmed"), "압축 완료를 확인할 수 없어 후속 자동 입력을 보류합니다"],
      [textRef("activity.compact_uncertain"), "압축 응답을 확인할 수 없어 자동 재전송을 중지했습니다"],
      [textRef("activity.compact_failed_engine"), "압축 실패: 실행 엔진이 제때 답하지 않아 압축을 시작하지 못했습니다. 기다리던 전달을 먼저 보냅니다"],
      [textRef("activity.compact_failed_busy"), "압축 실패: 입력칸의 글이나 CLI 화면 때문에 압축을 시작하지 못했습니다. 기다리던 전달을 먼저 보냅니다"],
      [textRef("activity.compact_failed", { detail: "timeout" }), `압축 실패: ${"timeout"}`],
      [textRef("activity.trust_auto", { label: "Yes, proceed", cwd: "/w" }), `프로젝트를 만들 때 대표가 이 폴더를 신뢰한다고 답해, 폴더 신뢰 확인 창에서 '${"Yes, proceed"}' 을 골랐습니다 · ${"/w"}`],
      [textRef("activity.tidy", { text: "정리함" }), `판 정리: ${"정리함"}`],
      [textRef("activity.delivery_stalled"), "전달이 진행되지 않고 있습니다. 다시 확인해 주세요"],
      [textRef("activity.delivery_corrected", { id: "dl_2" }), `전달 기록에서 수신을 확인해 표시를 바로잡았습니다 (${"dl_2"})`],
      [textRef("activity.submit_only", { id: "dl_3" }), `${"입력칸의 지시를 다시 넣지 않고 제출합니다"} (${"dl_3"})`],
      [textRef("activity.resend_risk", { id: "dl_3" }), `${"중복 위험 동의를 받아 지시를 재전송합니다"} (${"dl_3"})`],
      [textRef("activity.resend_auto", { id: "dl_3" }), `${"미전달을 확인해 같은 지시를 자동 재전송합니다"} (${"dl_3"})`],
      [textRef("activity.gone_resend_risk", { id: "dl_4" }), `${"전달을 받던 터미널이 끝났습니다. 중복 위험 동의를 받아 다시 열린 세션에 다시 보냅니다"} (${"dl_4"})`],
      [textRef("activity.gone_resend", { id: "dl_4" }), `${"전달을 받던 터미널이 끝났고 세션 기록에 받은 흔적이 없습니다. 다시 열린 세션에 다시 보냅니다"} (${"dl_4"})`],
      [textRef("activity.resize_unconfirmed"), "경고: 2초 안에 터미널 크기 복원을 확인하지 못해 계속 진행합니다"],
      [textRef("activity.control_dropped"), "터미널 연결이 끊겨 직접 조작을 자동으로 끝냈습니다"],
      [textRef("activity.control_started"), "대표가 터미널에서 직접 입력을 시작했습니다"],
      [textRef("activity.control_ended"), "대표가 터미널에서 직접 입력을 마쳤습니다"],
      [textRef("activity.tool_allowed_plain"), `대표가 결재함에서 도구 승인 요청을 ${"허용"}했습니다${""}`],
      [textRef("activity.tool_denied_plain"), `대표가 결재함에서 도구 승인 요청을 ${"거절"}했습니다${""}`],
      // 리뷰: 대표 답으로 결재를 닫은 줄(59f26a9 flows/member.ts 492).
      [textRef("activity.decision_closed_by_answer", { id: "d_1", answer: "d_2", issue: "같은 결제 범위" }), `결재 #${"d_1"}를 대표 답 #${"d_2"}에 따라 닫았습니다${`: ${"같은 결제 범위"}`}`],
      [textRef("activity.decision_closed_by_answer_group", { id: "d_1", answer: "d_2" }), `결재 #${"d_1"}를 대표 답 #${"d_2"}에 따라 닫았습니다${" (같은 그룹)"}`],
    ];
    // 리뷰: 터미널 종료 줄(59f26a9 orchestrator.ts exitDetail).
    const oldExitDetail = (reason: string | null, exitCode: number | null) => ["holder_lost", "stopped_by_restart"].includes(reason ?? "") ? RESTART_EXIT_NOTE
      : `초기/실행 종료: ${reason ?? "원인 미확인"} (exit_code=${exitCode ?? "unknown"})`;
    for (const reason of ["exited", null, "holder_lost", "stopped_by_restart", "not_found", "signal: SIGKILL", "x".repeat(600)]) for (const code of [1, 0, null, 137]) {
      const old = oldExitDetail(reason, code);
      expect(exitDetail(reason, code)).toBe(old);
      // 활동 줄: 예전처럼 500자에서 자른다. 잘리지 않으면 코드, 잘리면 문장.
      const line = exitActivity(reason, code);
      expect(typeof line === "string" ? line : ko(line)).toBe(old.slice(0, 500));
      expect(typeof line === "string").toBe(old.length > 500);
      if (old.length <= 500) pairs.push([exitDetailRef(reason, code), old]);
      // lastError(문장 그대로)를 대화 글에 넣을 때도 정해진 글이면 코드가 된다.
      const param = lastErrorParam(old.slice(0, 500));
      expect(typeof param === "string").toBe(old.length > 500);
    }
    pairs.push([textRef("activity.restart_exit"), RESTART_EXIT_NOTE]);
    expect(en(exitDetailRef("exited", 1))).toBe("Session ended: exited (exit code 1)");
    expect(en(exitDetailRef(null, null))).toBe("Session ended: unknown cause (exit code unknown)");
    for (const model of ["Opus", "Sonnet"]) for (const continued of [true, false]) {
      pairs.push([textRef(continued ? "activity.usage_reopen_model_continue" : "activity.usage_reopen_model_new", { model }),
        `사용 한도로 멈춘 세션의 ${`모델을 ${withRo(model)}`} 바꿔 ${continued ? "같은 대화를 이어 엽니다" : "새 세션으로 엽니다"}`]);
      pairs.push([textRef(continued ? "activity.usage_reopen_cli_continue" : "activity.usage_reopen_cli_new", { cli: model }),
        `사용 한도로 멈춘 세션의 ${`CLI를 ${withRo(model)}`} 바꿔 ${continued ? "같은 대화를 이어 엽니다" : "새 세션으로 엽니다"}`]);
    }
    for (const [ref, old] of pairs) expect([ref.code, ko(ref)]).toEqual([ref.code, old]);
  });

  test("도구 승인 카드: 제목·본문·선택지·닫힌 이유·활동 줄·'무엇을'", () => {
    const tools: [string, unknown][] = [
      ["Bash", { command: "git push origin main" }], ["Write", { file_path: "/tmp/x.txt", content: "hello" }], ["Edit", { file_path: "/tmp/y.ts" }],
      ["Read", { file_path: "/tmp/z" }], ["Glob", { pattern: "*.ts" }], ["Grep", { pattern: "x", path: "/tmp" }], ["WebFetch", { url: "https://e.example" }],
      ["WebSearch", { query: "q" }], ["Task", { description: "d" }], ["Agent", { description: "d" }], ["MultiEdit", { file_path: "/a" }], ["NotebookEdit", { notebook_path: "/n" }],
      ["LS", { path: "/" }], ["BashOutput", {}], ["KillShell", {}], ["KillBash", {}], ["Skill", {}], ["SlashCommand", {}],
      ["mcp__github__create_issue", { title: "t" }], ["SomethingNew", { a: 1 }], ["Bash", { command: "x".repeat(3000) }],
      // 리뷰: '무엇을'이 60자를 넘는 이름(예전에는 60자에서 잘렸다). 서버 이름 50·51·52자, 이름 없는 도구 53·54·80자, 공백이 든 이름.
      ["mcp__plugin_acme-enterprise-integrations_acme-enterprise-data-warehouse__run_query", { sql: "select 1" }],
      [`mcp__${"s".repeat(50)}__t`, {}], [`mcp__${"s".repeat(51)}__t`, {}], [`mcp__${"s".repeat(52)}__t`, {}],
      ["T".repeat(53), { a: 1 }], ["T".repeat(54), { a: 1 }], ["T".repeat(80), { a: 1 }], [`Odd  Tool\tName ${"n".repeat(60)}`, {}], [`mcp__a  b__c`, {}],
      // 리뷰: 대상에 서버가 붙이는 말(글자 수·더 있음·경로 없음·내용 없음·가린 개인 키·줄 더 있음).
      ["Write", { content: "hi" }], ["Bash", undefined], ["Bash", { command: "cat <<EOF\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\nEOF" }],
      ["Bash", { command: Array.from({ length: 40 }, (_, i) => `echo ${i}`).join("\n") }], ["Bash", { command: "echo ```x``` " + "y".repeat(700) }],
    ];
    for (const [tool, input] of tools) {
      const { action, target } = describeToolRequest(tool, input);
      expect([tool, ko(toolActionRef(tool))]).toEqual([tool, action]);
      for (const cwd of ["/private/tmp/w", null]) {
        const info = { tool, action, target, cwd, expiresAt: "2026-11-14T01:00:00.000Z" };
        const old = toolPermissionCard({ name: "결제 연동" }, info, 600_000);
        const refs = toolPermissionCardTexts({ name: "결제 연동" }, info, 600_000);
        expect(ko(refs.text)).toBe(old.detail);
        expect(ko({ code: "card.tool_permission.title", params: refs.text.params })).toBe(old.title);
        expect(en(refs.text)).not.toMatch(/명령 실행|폴더:|허용·거절/);
        // 두 언어의 대상을 실어도 한국어는 그대로, 영어에는 한국어 붙임말이 없다(이름도 영문이면 한글이 하나도 없다).
        const both = toolPermissionCardTexts({ name: "dev" }, { ...info, target: describeToolTargets(tool, input).ko }, 600_000, describeToolTargets(tool, input));
        const oldDev = toolPermissionCard({ name: "dev" }, info, 600_000);
        expect(ko(both.text)).toBe(oldDev.detail);
        expect(ko({ code: "card.tool_permission.title", params: both.text.params })).toBe(oldDev.title);
        expect([tool, HANGUL.test(en(both.text)), HANGUL.test(en({ code: "card.tool_permission.title", params: both.text.params }))]).toEqual([tool, false, false]);
      }
      expect([tool, HANGUL.test(en(toolActionRef(tool)))]).toEqual([tool, false]);
      expect([tool, HANGUL.test(describeToolRequest(tool, input, "en").target)]).toEqual([tool, false]);
    }
    expect(ko(toolActionRef("mcp__plugin_acme-enterprise-integrations_acme-enterprise-data-warehouse__run_query"))).toBe("연결 도구 쓰기(plugin_acme-enterprise-integrations_acme-enterprise…(16자 더 있음)");
    expect(en(toolActionRef("mcp__plugin_acme-enterprise-integrations_acme-enterprise-data-warehouse__run_query"))).toBe("Use a connected tool (plugin_acme-enterprise-integrations_acme-enterprise… 16 more characters)");
    expect(describeToolTargets("Write", { file_path: "/tmp/x.txt", content: "hello" })).toEqual({ ko: "/tmp/x.txt (5자)", en: "/tmp/x.txt (5 characters)" });
    expect(describeToolTargets("Write", { content: "hi" })).toEqual({ ko: "(경로 없음) (2자)", en: "(no path) (2 characters)" });
    expect(describeToolTargets("Bash", undefined)).toEqual({ ko: "(내용 없음)", en: "(no content)" });
    expect(describeToolTargets("Bash", { command: "x".repeat(700) }).en).toBe(`${"x".repeat(600)}… (100 more characters)`);
    expect(describeToolTargets("Bash", { command: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----" }).en).toBe("[private key hidden]");
    expect(describeToolTargets("Bash", { command: Array.from({ length: 14 }, (_, i) => `echo ${i}`).join("\n") }).en.endsWith("\n… (2 more lines)")).toBe(true);
    for (const option of TOOL_PERMISSION_OPTIONS) {
      const refs = toolPermissionCardTexts({ name: "a" }, { tool: "Bash", action: "명령 실행", target: "x", cwd: null, expiresAt: "" }, 60_000).options[option.k as "allow" | "deny"];
      expect(ko(refs.label)).toBe(option.label);
      expect(ko(refs.desc!)).toBe(option.desc!);
    }
    const closed: [string, string][] = [
      ["card.tool_permission.closed_restart", "서버가 다시 시작되어 승인 요청이 끊겼습니다. 터미널의 승인 창에서 답해 주세요"],
      ["card.tool_permission.closed_cut", "승인 요청이 끊겼습니다. 터미널의 승인 창에서 답해 주세요"],
      ["card.tool_permission.closed_terminal_side_ended", "터미널 쪽 요청이 끝나 닫았습니다. 터미널에서 답했거나 일이 멈췄습니다"],
      ["card.tool_permission.closed_already_over", "승인 요청이 이미 끝났습니다. 터미널의 승인 창에서 답해 주세요"],
      ["card.tool_permission.closed_terminal_ended", "팀장의 터미널이 끝나 닫았습니다"],
      ["card.tool_permission.closed_answered_in_terminal", "터미널에서 먼저 답해 승인 창이 닫혔습니다"],
      ["card.tool_permission.closed_terminal_side_cut", "터미널 쪽 요청이 끊겨 닫았습니다. 터미널의 승인 창에서 답해 주세요"],
      ["card.tool_permission.closed_server_stopped", "서버가 멈춰 승인 요청이 끊겼습니다. 터미널의 승인 창에서 답해 주세요"],
    ];
    for (const [code, old] of closed) {
      expect(ko({ code })).toBe(old);
      expect(ko(textRef("activity.tool_card_closed", { reason: { code } }))).toBe(`도구 승인 카드를 닫았습니다 · ${old}`);
    }
    expect(ko(textRef("card.tool_permission.closed_timeout", { minutes: "10" }))).toBe(`${10}분 동안 답이 없어 터미널의 승인 창으로 넘겼습니다`);
  });

  test("사용 한도 카드: 제목·첫 문단(모든 갈래)·본문 묶음·선택지·풀리는 때", () => {
    // 59f26a9 server/api-outage.ts 의 cardLead·formatUsageReset·MODEL_ELSEWHERE 그대로.
    const MODEL_ELSEWHERE = "(고를 버튼이 없으면 팀장 설정에서 모델을 바꾸거나 총괄에게 모델을 바꿔 이어 가라고 하세요)";
    function formatUsageReset(at: string): string {
      const parts = new Intl.DateTimeFormat("ko-KR", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, month: "long", day: "numeric", hour: "numeric", minute: "numeric", hour12: true }).formatToParts(new Date(at));
      const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
      return `${part("month")} ${part("day")}일 ${part("dayPeriod")} ${part("hour")}시${Number(part("minute")) ? ` ${Number(part("minute"))}분` : ""}`;
    }
    function oldLead(stillLimited: boolean, credit: { model: string | null } | null, resetsAt: string | null, hasModels: boolean): string {
      if (stillLimited) return hasModels ? `아직 한도가 남아 있지 않습니다. 기다리거나 다른 모델을 고르세요${MODEL_ELSEWHERE}.` : "아직 한도가 남아 있지 않습니다. 한도가 풀리면 자동으로 이어 갑니다.";
      const when = resetsAt ? `${formatUsageReset(resetsAt)}에 ` : "";
      const lead = credit ? `${credit.model ? `${credit.model} ` : "이 모델의 "}사용 크레딧이 떨어졌습니다. 다른 모델로 바꾸면 바로 이어 갑니다. 기다리면 ${when}크레딧이 채워질 때 자동으로 이어 갑니다.`
        : resetsAt ? `${when}한도가 풀리면 자동으로 이어 갑니다. 기다리셔도 됩니다.` : "한도가 풀렸는지 가끔 다시 확인해 자동으로 이어 갑니다. 기다리셔도 됩니다.";
      return `${lead} ${hasModels ? `바로 이어 가려면 다른 모델을 고르세요${MODEL_ELSEWHERE}. ` : ""}다른 계정으로 로그인했거나 한도를 늘렸다면 '이어가기'를 누르세요.`;
    }
    // 새 코드의 갈래(api-outage.ts cardLead 와 같은 식).
    function newLead(stillLimited: boolean, credit: { model: string | null } | null, resetsAt: string | null, hasModels: boolean): ServerTextRef {
      if (stillLimited) return textRef(hasModels ? "card.usage_limit.still_models" : "card.usage_limit.still_wait");
      const at = resetsAt ? { at: resetsAt } : null;
      const core = credit
        ? credit.model ? textRef(at ? "card.usage_limit.credit_named_at" : "card.usage_limit.credit_named", { model: credit.model, ...(at ? { at } : {}) })
          : textRef(at ? "card.usage_limit.credit_at" : "card.usage_limit.credit", at ? { at } : undefined)
        : at ? textRef("card.usage_limit.reset_at", { at }) : textRef("card.usage_limit.probe");
      return textRef(hasModels ? "card.usage_limit.lead_models" : "card.usage_limit.lead", { core });
    }
    for (const stillLimited of [false, true]) for (const credit of [null, { model: null }, { model: "Fable 5.2" }])
      for (const resetsAt of [null, "2026-11-14T06:00:00.000Z", "2026-11-14T15:30:00.000Z"]) for (const hasModels of [false, true]) {
        const ref = newLead(stillLimited, credit, resetsAt, hasModels);
        expect(ko(ref)).toBe(oldLead(stillLimited, credit, resetsAt, hasModels));
        expect(HANGUL.test(en(ref))).toBe(false);
      }
    for (const at of ["2026-11-14T06:00:00.000Z", "2026-11-14T15:30:00.000Z", "2026-01-02T23:05:00.000Z"]) expect(formatTextDate(at, "ko")).toBe(formatUsageReset(at));
    const lead = newLead(false, null, null, false);
    const params = { lead, names: "결제 연동\ndev — 창을 닫지 못했습니다", cli: "Claude", count: "2" };
    expect(ko(textRef("card.usage_limit", { ...params, raw: "You've hit your limit" }))).toBe([ko(lead), params.names, "You've hit your limit"].filter(Boolean).join("\n\n"));
    expect(ko(textRef("card.usage_limit.short", params))).toBe([ko(lead), params.names, ""].filter(Boolean).join("\n\n"));
    expect(ko(textRef("card.usage_limit.title", params))).toBe(`${"Claude"} 사용 한도 도달 · 팀원 ${2}명 멈춤`);
    expect(ko(textRef("card.usage_limit.title_initial"))).toBe("사용 한도 도달");
    for (const model of ["Opus", "Sonnet", "Fable 5.2", "GPT-6"]) expect(ko(textRef("card.usage_limit.option_model", { model }))).toBe(`${withRo(model)} 바꿔 이어가기`);
    expect(ko(textRef("card.usage_limit.option_resume"))).toBe(USAGE_RESUME_OPTION.label);
  });

  test("결재의 닫힘·다시 열림, 기본 이름, 알림 문구", () => {
    for (const who of ["결제 연동", "dev", "시스템", "AI"]) {
      expect(ko(textRef("card.closed_member_removed", { name: who }))).toBe(`${josa(who, "이")} 명부에서 빠져 함께 닫혔습니다`);
      expect(ko(textRef("card.reopen_by_owner", { who }))).toBe(`${josa(who, "이")} 닫았던 결재를 대표가 다시 열었습니다${""}`);
      expect(ko(textRef("card.reopen_by_owner_reason", { who, reason: "필요 없음" }))).toBe(`${josa(who, "이")} 닫았던 결재를 대표가 다시 열었습니다${`(닫은 이유: ${"필요 없음"})`}`);
    }
    expect(ko(textRef("card.reopen_undelivered"))).toBe("전달하지 못했습니다. 다시 결정해 주세요");
    expect(ko(textRef("card.reopen_not_connected"))).toBe("연결 전이라 전달되지 않았습니다. 다시 결정해 주세요");
    expect(DEFAULT_NAMES.ko).toEqual({ hq: "본사", hqAgent: "본사 AI", hqRole: "프로젝트 만들기와 잡다한 일", lead: "총괄", leadRole: "총괄" });
    expect(conductorName("결제")).toBe(`${"결제"} 총괄`);
    expect(conductorName("x".repeat(60)).length).toBeLessThanOrEqual(40);
    expect(PUSH_BODIES.ko).toEqual({ decision: "새 결재가 도착했습니다.", approval_wait: "진행을 위해 직접 확인이 필요합니다.", error: "실행 문제를 확인해 주세요.",
      report_complete: "완료 보고가 도착했습니다.", todo_created: "대표 할 일이 생겼습니다.", report_blocked: "막힘 보고를 확인해 주세요.",
      test: "iPhone 알림 연결을 확인합니다.", report_more: "추가 완료 보고가 도착했습니다.",
      // 0.2.7(D4-3) 새 종류. 기존 문구는 그대로다.
      tailnet_off: "서버 Mac의 Tailscale이 꺼져 있어 iPhone에서 연결할 수 없습니다. Mac에서 Tailscale을 켜 주세요." });
    for (const value of Object.values(PUSH_BODIES.en)) expect(HANGUL.test(value)).toBe(false);
  });

  test("전달 메모·lastError 의 정해진 문장은 코드가 붙고, 문장은 그대로 한국어다", () => {
    for (const code of NOTE_CODES) expect(deliveryNoteCode(ERROR_CODES[code].ko)).toBe(code);
    // 앱이 문장 머리로 알아보는 메모(자동 재전송 상한·미전달 확인·입력 제출 확인)에는 코드를 붙이지 않는다(앱의 다듬은 문장이 그대로 보인다).
    for (const note of ["자동 재전송 상한에 도달했습니다", "미전달을 확인했습니다. 안전 상태를 다시 확인한 뒤 재전송합니다", "입력 제출을 확인 중입니다"]) expect(deliveryNoteCode(note)).toBeNull();
    for (const [text, code] of LAST_ERROR_CODES) expect(ERROR_CODES[code].ko as string).toBe(text);
  });
});

describe("저장과 응답: 코드는 문장과 맞을 때만 싣는다", () => {
  test("보고 언어 한국어: 시스템 글은 예전 문장, 코드·값·언어(ko)가 함께 실린다", () => {
    const { store, project, member } = freshStore();
    const message = store.createMessage({ projectId: project.id, who: "시스템", kind: "시스템", text: textRef("chat.delivery_stalled", { name: member.name }) });
    expect(message).toMatchObject({ title: "전달 확인 필요", body: ko(textRef("chat.delivery_stalled", { name: member.name })),
      textCode: "chat.delivery_stalled", textParams: { name: member.name }, textLang: "ko" });
    // 코드 없는 글(대표의 글, AI 의 보고)에는 칸이 없다.
    const mine = store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: "안녕" });
    expect("textCode" in mine).toBe(false);
  });

  test("보고 언어 영어: 영어 문장으로 저장하고 textLang 은 en. AI 에게 주는 글은 아니다", () => {
    const { store, project, member } = freshStore();
    store.patchSettings({ reportLanguage: "en" });
    const message = store.createMessage({ projectId: project.id, who: "시스템", kind: "시스템", text: textRef("chat.missing_report", { name: member.name }) });
    expect(message).toMatchObject({ title: "Missing result report", body: `${member.name} still left no result report after being asked for one. Check the result without running the work again.`, textLang: "en" });
    const activity = store.appendActivity(member.id, "turn_end", textRef("activity.turn_end"));
    expect(activity).toMatchObject({ text: "Turn ended", textCode: "activity.turn_end", textLang: "en" });
    expect(store.listActivity(member.id).at(-1)).toMatchObject({ text: "Turn ended", textCode: "activity.turn_end" });
  });

  test("이전 판 서버가 문장만 고친 행·잘린 활동 줄은 코드를 싣지 않는다", () => {
    const { db, store, project, member } = freshStore();
    const message = store.createMessage({ projectId: project.id, who: "시스템", kind: "시스템", text: textRef("chat.member_error", { name: "a", error: "b" }) });
    db.query("UPDATE messages SET body = ? WHERE id = ?").run("다른 글", message.id);
    const read = store.getMessage(message.id)!;
    expect(read.body).toBe("다른 글");
    expect("textCode" in read).toBe(false);
    const long = store.appendActivity(member.id, "system", textRef("activity.tidy", { text: "x".repeat(4100) }));
    expect(long.text.endsWith("…")).toBe(true);
    expect("textCode" in long).toBe(false);
  });

  test("결재 카드: 선택지·닫힌 이유·다시 연 까닭의 코드, 언어가 바뀐 뒤의 칸", () => {
    const { store, project, member } = freshStore();
    const card = store.createDecision({ projectId: project.id, memberId: member.id, who: "시스템", title: "t", options: [USAGE_RESUME_OPTION],
      texts: { options: { resume: { label: textRef("card.usage_limit.option_resume") } } } });
    expect(card.options[0]!.label).toBe(USAGE_RESUME_OPTION.label);
    expect(card.optionTexts).toEqual({ resume: { label: { code: "card.usage_limit.option_resume" } } });
    expect(card.textLang).toBe("ko");
    expect(card.textCode).toBeUndefined();
    const closed = store.closeDecision(card.id, { kind: null, reason: textRef("card.closed_member_removed", { name: member.name }), by: "시스템" });
    expect(closed.closeReason).toBe(`${josa(member.name, "이")} 명부에서 빠져 함께 닫혔습니다`);
    expect(closed.closeReasonText).toEqual(textRef("card.closed_member_removed", { name: member.name }));
    expect(closed.optionTexts).toBeDefined();
    store.patchSettings({ reportLanguage: "en" });
    const reopened = store.reopenDecision(card.id);
    expect(reopened.reopenNote).toBe("It couldn't be delivered. Please decide again");
    expect(reopened).toMatchObject({ reopenNoteText: { code: "card.reopen_undelivered" }, textLang: "en" });
    // 리뷰: 한 카드는 한 언어다. 언어가 바뀐 뒤 서버가 한 칸을 쓰면 코드가 있는 앞 칸(선택지)도 새 언어로 다시 써 두고 코드를 이어 간다.
    // (예전에는 앞 칸 코드를 버려, 그 칸만 한국어로 남고 다시 연 까닭만 영어인 카드가 되었다.)
    expect(reopened.options[0]!.label).toBe("I switched accounts or raised my limit · Continue");
    expect(reopened.optionTexts).toEqual({ resume: { label: { code: "card.usage_limit.option_resume" } } });
    // 한국어 앱은 코드로 그 칸들을 다시 한국어로 그린다.
    expect(ko(reopened.optionTexts!.resume!.label)).toBe(USAGE_RESUME_OPTION.label);
    // 문자열로 닫으면(AI 의 ask_close) 코드가 없다.
    const plain = store.createDecision({ projectId: project.id, who: "결제 연동", title: "질문" });
    expect(store.closeDecision(plain.id, { kind: "obsolete", reason: "필요 없어짐", by: "결제 연동" }).closeReasonText).toBeUndefined();
  });

  // 리뷰 지적: 영어 앱·보고 언어 한국어에서 열린 카드가 있을 때 대표가 보고 언어를 English 로 바꾸고, 그 뒤 서버가 카드를 닫거나 다시 열면
  // 닫힌 이유·다시 연 까닭만 새 언어 코드를 갖고 제목·본문·선택지는 코드를 잃어, 한 카드 안에 두 언어가 섞였다.
  test("보고 언어가 바뀐 뒤 서버가 카드를 닫으면 제목·본문·선택지·닫힌 이유가 모두 새 언어로, 코드도 모두 실린다", () => {
    const { store, project, member } = freshStore();
    const info = { tool: "Bash", action: "명령 실행", target: "bun test", cwd: null, expiresAt: "2026-11-14T01:00:00.000Z" };
    const card = store.createToolPermissionDecision({ projectId: project.id, memberId: member.id, who: member.name, title: "t", detail: "d", options: TOOL_PERMISSION_OPTIONS,
      toolPermission: info, texts: toolPermissionCardTexts(member, info, 600_000) });
    expect(card).toMatchObject({ title: "명령 실행: bun test", textLang: "ko", textCode: "card.tool_permission" });
    expect(card.options.map(o => o.label)).toEqual(["허용", "거절"]);
    store.patchSettings({ reportLanguage: "en" });
    const closed = store.closeDecision(card.id, { kind: null, reason: textRef("card.closed_member_removed", { name: "dev" }), by: "시스템" });
    expect(closed).toMatchObject({ title: "Run a command: bun test", closeReason: "Closed along with dev, who left the team", textLang: "en", textCode: "card.tool_permission" });
    expect(HANGUL.test(closed.detail.replace(member.name, ""))).toBe(false);
    expect(closed.options.map(o => [o.label, o.desc])).toEqual([["Allow", "Runs it this one time only"], ["Deny", "Doesn't run it and tells the staff member"]]);
    expect(Object.keys(closed.optionTexts ?? {})).toEqual(["allow", "deny"]);
    expect(closed.closeReasonText).toEqual(textRef("card.closed_member_removed", { name: "dev" }));
    // 한국어 앱은 모든 칸을 코드로 다시 한국어로 그린다(한 카드가 한 언어).
    expect(ko({ code: closed.textCode!, params: closed.textParams })).toBe(card.detail);
    expect(ko({ code: "card.tool_permission.title", params: closed.textParams })).toBe(card.title);
    // 같은 언어로 다시 열면(대표가 다시 엶) 앞 칸은 그대로, 다시 연 까닭만 더해진다.
    const again = store.reopenDecision(card.id, textRef("card.reopen_by_owner", { who: "dev" }));
    expect(again).toMatchObject({ title: closed.title, detail: closed.detail, reopenNote: "You reopened the decision dev had closed", textLang: "en", textCode: "card.tool_permission" });
    expect(again.optionTexts).toEqual(closed.optionTexts);
  });

  test("언어가 바뀐 카드에서 문장이 코드와 맞지 않는 칸(이전 판이 고친 칸)은 문장을 두고 코드만 뺀다", () => {
    const { db, store, project, member } = freshStore();
    const card = store.createDecision({ projectId: project.id, memberId: member.id, who: "시스템", title: "t", options: [USAGE_RESUME_OPTION, { k: "x", label: "다른 판이 더한 선택지" }],
      texts: { options: { resume: { label: textRef("card.usage_limit.option_resume") } }, text: textRef("card.usage_limit.short", { lead: textRef("card.usage_limit.still_wait"), names: "a", cli: "Claude", count: "1" }) } });
    db.query("UPDATE decisions SET detail = ? WHERE id = ?").run("이전 판이 고친 본문", card.id);
    store.patchSettings({ reportLanguage: "en" });
    const reopened = store.reopenDecision(card.id);
    expect(reopened).toMatchObject({ detail: "이전 판이 고친 본문", title: "Claude 사용 한도 도달 · 팀원 1명 멈춤", reopenNote: "It couldn't be delivered. Please decide again", textLang: "en" });
    expect(reopened.textCode).toBeUndefined();
    expect(reopened.options.map(o => o.label)).toEqual(["I switched accounts or raised my limit · Continue", "다른 판이 더한 선택지"]);
    expect(Object.keys(reopened.optionTexts ?? {})).toEqual(["resume"]);
  });

  test("사용 한도 카드를 다시 열고 고쳐도 다시 연 까닭의 코드가 남는다(언어가 바뀌었으면 그 문장도 새 언어로)", () => {
    for (const switchTo of ["ko", "en"] as const) {
      const { store, member } = freshStore();
      const service = new ApiRecovery({ store, now: () => Date.parse("2026-11-14T00:00:00Z"), urls: [], notify: () => {}, pump: () => {},
        inspect: async () => ({ menu: null, state: "error" }), dismiss: async () => ({ ok: true }), choices: () => [] });
      closers.push(() => service.shutdown());
      service.usageFailure(member, "You've hit your limit · resets 3pm");
      const card = store.listDecisions(member.projectId).find(d => d.kind === "usage_limit")!;
      store.reopenDecision(card.id);
      expect(store.requireDecision(card.id).reopenNoteText).toEqual({ code: "card.reopen_undelivered" });
      if (switchTo === "en") store.patchSettings({ reportLanguage: "en" });
      service.usageFailure(member, "You've hit your limit · resets 4pm");
      const updated = store.requireDecision(card.id);
      expect(updated.reopenNoteText).toEqual({ code: "card.reopen_undelivered" });
      expect(updated.reopenNote).toBe(switchTo === "en" ? "It couldn't be delivered. Please decide again" : "전달하지 못했습니다. 다시 결정해 주세요");
      expect(updated.textLang).toBe(switchTo);
    }
  });

  test("사용 한도 카드: 한국어는 예전 글, 영어 보고 언어는 영어 글, 제목·본문·선택지의 코드가 맞다", () => {
    for (const lang of ["ko", "en"] as const) {
      const { store, member } = freshStore();
      if (lang === "en") store.patchSettings({ reportLanguage: "en" });
      const service = new ApiRecovery({ store, now: () => Date.parse("2026-11-14T00:00:00Z"), urls: [], notify: () => {}, pump: () => {},
        inspect: async () => ({ menu: null, state: "error" }), dismiss: async () => ({ ok: true }),
        choices: () => [{ k: "model:sonnet", label: "x", model: "Sonnet" }] });
      closers.push(() => service.shutdown());
      // 모델 크레딧 소진(모델 선택지가 나오는 한도), 풀리는 시각 모름.
      service.usageFailure(member, "You're out of usage credits. Run /usage-credits to keep using Fable 5.2 or /model to switch models.");
      const card = store.listDecisions(member.projectId).find(d => d.kind === "usage_limit")!;
      const names = member.name, raw = "You're out of usage credits. Run /usage-credits to keep using Fable 5.2 or /model to switch models.";
      if (lang === "ko") {
        expect(card.title).toBe(`Claude 사용 한도 도달 · 팀원 1명 멈춤`);
        expect(card.detail).toBe([`Fable 5.2 사용 크레딧이 떨어졌습니다. 다른 모델로 바꾸면 바로 이어 갑니다. 기다리면 크레딧이 채워질 때 자동으로 이어 갑니다. 바로 이어 가려면 다른 모델을 고르세요(고를 버튼이 없으면 팀장 설정에서 모델을 바꾸거나 총괄에게 모델을 바꿔 이어 가라고 하세요). 다른 계정으로 로그인했거나 한도를 늘렸다면 '이어가기'를 누르세요.`, names, raw].join("\n\n"));
        expect(card.options).toEqual([{ k: "model:sonnet", label: "Sonnet으로 바꿔 이어가기" }, USAGE_RESUME_OPTION]);
      } else {
        expect(card.title).toBe("Claude usage limit reached · 1 staff stopped");
        expect(card.detail.startsWith("Fable 5.2 is out of usage credits.")).toBe(true);
        expect(card.options.map(o => o.label)).toEqual(["Switch to Sonnet and continue", "I switched accounts or raised my limit · Continue"]);
      }
      expect(card).toMatchObject({ textCode: "card.usage_limit", textLang: lang });
      expect(Object.keys(card.optionTexts ?? {}).sort()).toEqual(["model:sonnet", "resume"]);
      expect(JSON.stringify(card.options)).not.toContain("\"model\":\"Sonnet\""); // 선택지 칸에 모델 값이 새지 않는다
      // 다른 언어로 다시 그리면 같은 카드의 다른 언어 문장이 된다.
      const other = lang === "ko" ? "en" : "ko";
      expect(mustRender({ code: "card.usage_limit.title", params: card.textParams }, other)).toBe(other === "en" ? "Claude usage limit reached · 1 staff stopped" : "Claude 사용 한도 도달 · 팀원 1명 멈춤");
    }
  });

  test("팀장의 정해진 lastError 에는 lastErrorCode 가 붙는다(문장은 그대로)", () => {
    const { store, member } = freshStore();
    expect(store.patchMember(member.id, { lastError: "인터넷 연결 문제로 멈춤" })).toMatchObject({ lastError: "인터넷 연결 문제로 멈춤", lastErrorCode: "last_error_api_outage" });
    expect("lastErrorCode" in store.patchMember(member.id, { lastError: "Claude Code said no" })).toBe(false);
  });

  test("대표 글의 전달 메모: 새로 코드가 붙은 문장", () => {
    const { store, project } = freshStore();
    const message = store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: "x", delivery: "queued" });
    expect(store.setMessageDelivery(message.id, "held", ERROR_CODES.note_checking.ko)).toMatchObject({ deliveryNote: "전달 여부를 시스템이 확인하고 있습니다", deliveryCode: "note_checking" });
    expect(store.setMessageDelivery(message.id, "failed", "원본이 바뀌어 보내지 않았습니다")).toMatchObject({ deliveryCode: "note_source_changed_unsent" });
  });
});

describe("기본 이름: 새로 설치한 서버의 첫 실행 언어", () => {
  const saved = process.env.IAMCEO_LANG;
  afterEach(() => { if (saved === undefined) delete process.env.IAMCEO_LANG; else process.env.IAMCEO_LANG = saved; });

  test("IAMCEO_LANG 만 본다. 없으면 예전처럼 한국어(LANG 은 보지 않는다)", () => {
    expect(firstRunLang({})).toBe("ko");
    expect(firstRunLang({ LANG: "en_US.UTF-8" })).toBe("ko");
    expect(firstRunLang({ IAMCEO_LANG: "ko" })).toBe("ko");
    expect(firstRunLang({ IAMCEO_LANG: "ko_KR.UTF-8" })).toBe("ko");
    expect(firstRunLang({ IAMCEO_LANG: "en" })).toBe("en");
    expect(firstRunLang({ IAMCEO_LANG: "ja" })).toBe("en");
  });

  test("영어로 처음 열면 본사는 HQ, 보고 언어는 영어. 이미 있는 본사·설정은 언어가 바뀌어도 그대로", () => {
    process.env.IAMCEO_LANG = "en";
    const db = openDb(":memory:"); closers.push(() => db.close());
    const store = new Store(db, new Bus());
    expect(store.requireProject("hq").name).toBe("HQ");
    expect(store.getSettings().reportLanguage).toBe("en");
    process.env.IAMCEO_LANG = "ko";
    const again = new Store(db, new Bus());
    expect(again.requireProject("hq").name).toBe("HQ");
    expect(again.getSettings().reportLanguage).toBe("en");
  });

  test("한국어(또는 언어 없음)로 처음 열면 예전과 같다", () => {
    delete process.env.IAMCEO_LANG;
    const { store } = freshStore();
    expect(store.requireProject("hq").name).toBe("본사");
    expect(store.getSettings().reportLanguage).toBe("ko");
  });

  test("프로젝트 이름을 바꾸면 총괄의 기본 이름도 같은 언어로 따라간다. 직접 바꾼 이름은 그대로", () => {
    const { store, project } = freshStore();
    const lead = store.createMember({ projectId: project.id, handle: "lead", name: conductorName(project.name, "en"), kind: "conductor", cli: "claude", backend: "core" });
    store.patchProject(project.id, { name: "결제2" });
    expect(store.requireMember(lead.id).name).toBe("결제2 Lead");
    store.patchMember(lead.id, { name: "우리 총괄님" });
    store.patchProject(project.id, { name: "결제3" });
    expect(store.requireMember(lead.id).name).toBe("우리 총괄님");
  });
});

describe("iPhone 알림의 언어", () => {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  function config(): APNsConfig {
    const value: APNsConfig = { credentials: {}, providers: [] };
    for (const environment of ["sandbox", "production"] as const) {
      value.credentials[environment] = { environment, key, bundleId: DEFAULT_PUSH_BUNDLE_ID, keyId: "TESTKEY123", teamId: "TESTTEAM12", cacheKey: environment };
      value.providers.push({ environment, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready", lastError: null });
    }
    return value;
  }
  class Transport implements APNsTransport {
    requests: APNsTransportRequest[] = [];
    async send(request: APNsTransportRequest): Promise<APNsTransportResult> { this.requests.push(request); return { type: "response", status: 200, headers: {}, body: "" }; }
    close(): void {}
  }
  function fixture() {
    const db = openDb(":memory:"); closers.push(() => db.close());
    const transport = new Transport();
    const client = new APNsClient(config(), { transport });
    const push = new PushStore(db, { providers: () => client.status() });
    const worker = new PushWorker(push, client, { random: () => 0.5 });
    closers.push(() => worker.shutdown());
    const handler = createPushHandler({ store: push, providers: () => client.status() });
    return { push, worker, transport, handler };
  }
  const register = (handler: ReturnType<typeof createPushHandler>, id: string, token: string, headers: Record<string, string>) => {
    const url = new URL(`http://127.0.0.1/api/push/devices/${id}`);
    return handler(new Request(url, { method: "PUT", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: token, authorization: "authorized" }) }), url);
  };

  test("Accept-Language 의 첫 언어. 없거나 * 면 모른다", () => {
    const lang = (value?: string) => requestLanguage(new Request("http://x/", value === undefined ? {} : { headers: { "Accept-Language": value } }));
    expect(lang()).toBeNull();
    expect(lang("*")).toBeNull();
    expect(lang("ko")).toBe("ko");
    expect(lang("ko-KR,en;q=0.9")).toBe("ko");
    expect(lang("en")).toBe("en");
    expect(lang("en-US,ko;q=0.8")).toBe("en");
    expect(lang("ja-JP")).toBe("en");
  });

  test("등록 때의 언어로 문구를 만든다. 옛 앱(머리글 없음)은 한국어, 판(revision)은 언어 때문에 오르지 않는다", async () => {
    const { push, worker, transport, handler } = fixture();
    const english = randomUUID(), legacy = randomUUID();
    expect((await register(handler, english, "aa", { "Accept-Language": "en" })).status).toBe(201);
    expect((await register(handler, legacy, "bb", {})).status).toBe(201);
    for (const id of [english, legacy]) {
      const device = push.requireDevice(id);
      expect(device.revision).toBe(1);
      expect("language" in device).toBe(false); // 응답 DTO 에는 싣지 않는다
      push.patchDevice(id, { expectedRevision: device.revision, enabled: true });
    }
    expect(push.getRegistration(english)!.language).toBe("en");
    expect(push.getRegistration(legacy)!.language).toBe("ko");
    for (const id of [english, legacy]) push.recordEvent({ sourceKey: `test:${id}:1`, kind: "test", projectId: null, memberId: null, target: { screen: "home" }, occurredAt: push.timestamp() },
      [{ deviceId: id, registrationGeneration: push.getRegistration(id)!.registrationGeneration }]);
    await worker.tick();
    const bodies = transport.requests.map(r => JSON.parse(r.body).aps.alert.body).sort();
    expect(bodies).toEqual([PUSH_BODIES.en.test, PUSH_BODIES.ko.test].sort());
  });

  // 리뷰 지적: PATCH 는 그 iPhone 만 보내는 요청이 아니다. 한국어 Mac 앱의 설정 → 알림에서 대표가 영어 iPhone 줄의 스위치를 끄면
  // Accept-Language: ko 인 PATCH 가 나간다. 그것이 그 iPhone 의 알림 언어를 바꾸면 영어 iPhone 에 한국어 알림이 간다.
  test("다른 앱의 설정 바꾸기(PATCH)는 그 iPhone 의 알림 언어를 바꾸지 않는다. 언어는 그 iPhone 의 등록(PUT)만 정한다", async () => {
    const { push, worker, transport, handler } = fixture();
    const iphone = randomUUID();
    expect((await register(handler, iphone, "aa", { "Accept-Language": "en-US,ko;q=0.8" })).status).toBe(201);
    expect(push.getRegistration(iphone)!.language).toBe("en");
    const patch = async (body: Record<string, unknown>, headers: Record<string, string>) => {
      const url = new URL(`http://127.0.0.1/api/push/devices/${iphone}`);
      return handler(new Request(url, { method: "PATCH", headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ expectedRevision: push.requireDevice(iphone).revision, ...body }) }), url);
    };
    // iPhone 이 스스로 켠다(영어).
    expect((await patch({ enabled: true }, { "Accept-Language": "en" })).status).toBe(200);
    // 한국어 Mac 앱(0.2.6 은 화면 언어 ko, 출시된 Mac 0.2.3 도 ko)이 그 줄의 '완료 보고' 스위치를 끄고, 이름도 바꾼다.
    expect((await patch({ preferences: { report_complete: false } }, { "Accept-Language": "ko" })).status).toBe(200);
    expect((await patch({ label: "대표 폰" }, { "Accept-Language": "ko-KR" })).status).toBe(200);
    expect(push.requireDevice(iphone)).toMatchObject({ label: "대표 폰", preferences: { report_complete: false } });
    expect(push.getRegistration(iphone)!.language).toBe("en");
    push.recordEvent({ sourceKey: `test:${iphone}:1`, kind: "test", projectId: null, memberId: null, target: { screen: "home" }, occurredAt: push.timestamp() },
      [{ deviceId: iphone, registrationGeneration: push.getRegistration(iphone)!.registrationGeneration }]);
    await worker.tick();
    expect(transport.requests.map(r => JSON.parse(r.body).aps.alert.body)).toEqual([PUSH_BODIES.en.test]);
    // 그 iPhone 이 언어를 바꿔 다시 등록하면(iOS 는 언어를 바꾸면 앱을 다시 띄워 등록이 다시 나간다) 그 언어가 된다.
    const url = new URL(`http://127.0.0.1/api/push/devices/${iphone}`);
    const again = await handler(new Request(url, { method: "PUT", headers: { "Content-Type": "application/json", "Accept-Language": "ko-KR" },
      body: JSON.stringify({ expectedRevision: push.requireDevice(iphone).revision, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: "aa", authorization: "authorized" }) }), url);
    expect(again.status).toBe(200);
    expect(push.getRegistration(iphone)!.language).toBe("ko");
  });

  test("문구는 언어별 고정 문구. 중계 본문에는 lang 이 실린다(없으면 ko)", () => {
    const base: APNsNotification = { environment: "production", deviceToken: "ab", deliveryId: randomUUID(), eventId: randomUUID(), serverId: randomUUID(),
      kind: "decision", target: { screen: "inbox", projectId: "p", decisionId: "d" }, occurredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    expect(buildAPNsPayload(base).aps.alert.body).toBe("새 결재가 도착했습니다.");
    expect(buildAPNsPayload({ ...base, lang: "en" }).aps.alert.body).toBe(PUSH_BODIES.en.decision);
    expect(relayPushBody(base).lang).toBe("ko");
    expect(relayPushBody({ ...base, lang: "en" }).lang).toBe("en");
    // 앞 칸들은 예전과 같다(출시된 중계가 읽는 이름).
    expect(Object.keys(relayPushBody(base)).sort()).toEqual(["eventId", "expiresAt", "id", "kind", "lang", "serverId", "target", "token"]);
  });
});

describe("영어 문장의 쓸모", () => {
  test("서버가 만든 글 코드는 모두 어딘가에서 쓴다(죽은 항목이 없다)", () => {
    const sources = ["server/orchestrator.ts", "server/store.ts", "server/api-outage.ts", "server/tool-permission.ts", "server/delivery-recovery.ts",
      "server/terminal-stream.ts", "server/flows/owner.ts", "server/flows/member.ts", "server/agent-tools.ts", "server/text-refs.ts", "server/runner/core.ts"].map(p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")).join("\n");
    // 대화 글·카드의 제목(`<코드>.title`)은 코드에서 저절로 고른다. 나머지는 textRef("코드") 나 표(ACTION_CODES)로 쓴다.
    const unused = Object.keys(SERVER_TEXTS).filter(code => !code.endsWith(".title") && !sources.includes(`"${code}"`));
    expect(unused).toEqual([]);
  });
  test("보고 언어 값", () => {
    const langs: TextLang[] = ["ko", "en"];
    for (const lang of langs) expect(mustRender(textRef("activity.turn_end"), lang).length).toBeGreaterThan(0);
  });
});
