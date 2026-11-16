// 11-16: Claude 자기 근거(세션 기록·훅)로 한 전달 뒤의 턴이 끝났는지 읽는다. 읽기만 한다. 시간은 보지 않는다.
//
// 까닭: Claude 가 뒤 작업(Workflow·백그라운드 에이전트·백그라운드 셸·Monitor)을 띄우고 턴을 끝내면, 실행 엔진(core)은 그 작업이 끝날 때까지
// working 을 알린다(2026-11-16 라이브: 3시간 10분, 0.2.6 기간 47건). 로그인 오류(authentication_failed)로 끝난 턴에서도 core 가 끝을 알리지 않아
// 99분 동안 '일하는 중'이었다. 그 동안에도 Claude 는 턴 끝을 자기 기록에 남긴다.
//
// Claude Code 2.1.323 실측(줄 종류·키만):
// - 턴 끝: system stop_hook_summary(Stop 훅을 돌린 뒤) → system turn_duration. API 오류로 끝난 턴은 stop_hook_summary 없이
//   assistant(isApiErrorMessage, error: "authentication_failed", 글 "Please run /login · API Error: 403 …") 뒤 turn_duration 이다.
// - 새 턴: 받은 글(user, 문자열 또는 text 블록), 큐에서 꺼낸 글(queue-operation dequeue → user origin task-notification), assistant 줄.
// - 턴이 아닌 줄: isMeta·isCompactSummary 줄, 로컬 명령(<command-name>…, <local-command-stdout>…), attachment, api-request*, queue-operation
//   enqueue·remove, system 의 다른 종류(compact_boundary, informational, local_command …). 사이드체인(isSidechain) 줄은 보지 않는다.
// 훅(hook-events.ts): UserPromptSubmit(전달 표지) 이 턴을 열고 Stop·StopFailure(error) 가 닫는다.
import { join } from "node:path";
import type { HookEventRecord } from "./hook-events.ts";
import { hasExactMarker, jsonObject, parseProviderUserText, providerLogPath, readJsonlRange, type JsonlCursor } from "./delivery-evidence.ts";

/**
 * 이 오류로 끝난 턴은 다시 로그인해야 다시 돈다. StopFailure·기록의 error 분류값. 라이브에서 /login 뒤 Claude 가 같은 일을 스스로 이어 간 것은
 * authentication_failed 뿐이다. billing_error(크레딧 부족 등)는 결제를 고쳐도 /login 이 없어 Claude 가 스스로 새 턴을 열지 않으므로 여기에 넣지 않는다:
 * 로그인 밖의 API 오류처럼 오류로 닫고 막지 않는다(다음 전달이 새 턴을 연다).
 */
export const CLAUDE_LOGIN_ERRORS: ReadonlySet<string> = new Set(["authentication_failed"]);
/** 실행 기록의 사유(진단 코드): 뒤 작업이 남은 채 Claude 자기 근거로 닫은 턴. 결과 보고 확인은 그 작업이 끝난 뒤로 미룬다. */
export const CLAUDE_BACKGROUND_REASON = "claude_background_task";
/** 실행 기록의 사유(진단 코드): 로그인(계정) 오류로 끝난 턴. */
export const CLAUDE_LOGIN_REASON = "claude_login_required";

export interface ClaudeTurnQuery {
  /** CLAUDE_CONFIG_DIR. 기록은 <home>/projects 아래에 있어야 한다. */
  home: string;
  path: string;
  sessionId: string;
  /** 봉투의 기록 기준선(쓰기 직전의 기록 끝). 이 뒤에 덧붙은 줄만 본다. */
  baseline: { offset: number; fileIdentity: string | null };
  /** 그 전달의 묶음 표지와 전달 표지. 이것이 든 받은 글 뒤의 턴만 센다. */
  markers: string[];
}
/** 턴의 오류 분류값(기록의 error 또는 StopFailure 의 error)과 CLI 가 보인 오류 글(기록에만 있다). */
export interface ClaudeTurnError { error: string; text: string | null }
export interface ClaudeTurnCursor {
  key: string;
  log: JsonlCursor | null;
  anchored: boolean;
  open: boolean;
  /** 표지가 든 받은 글 뒤에 닫힌 턴 수. */
  ended: number;
  /** 지금 열린 턴의 마지막 assistant 줄이 API 오류였다. */
  pending: ClaudeTurnError | null;
  /** 마지막으로 닫힌 턴의 오류. */
  last: ClaudeTurnError | null;
}
export interface ClaudeTurnResult {
  outcome: "ended" | "running" | "unknown";
  /** turn_end · turn_open · marker_missing · session_conflict · corrupt_log · scan_pending · partial_log · path_unavailable · file_changed … */
  code: string;
  /** ended 일 때 마지막으로 닫힌 턴이 API 오류로 끝났으면 그 오류. */
  error: ClaudeTurnError | null;
  cursor: ClaudeTurnCursor | null;
}

/** 한 번에 읽는 상한. 넘으면 scan_pending 이고 다음 관측이 이어 읽는다. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** 받은 글이지만 모델 턴을 열지 않는 것(로컬 명령, ! 셸). */
const LOCAL_INPUT = /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/;

export function isTurnInput(entry: Record<string, unknown>): boolean {
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return false;
  const message = jsonObject(entry.message);
  if (!message || message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return !LOCAL_INPUT.test(content);
  if (!Array.isArray(content)) return false;
  // 도구 결과도 턴 안의 줄이다(모델이 이어 일한다).
  return content.some((block: unknown) => {
    const item = jsonObject(block);
    return !!item && (item.type === "tool_result" || item.type === "image" || item.type === "document" || (item.type === "text" && typeof item.text === "string" && !LOCAL_INPUT.test(item.text)));
  });
}

function errorText(message: Record<string, unknown> | null): string | null {
  const content = message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(block => jsonObject(block)).find(item => item?.type === "text" && typeof item.text === "string")?.text as string | undefined : undefined;
  return text ? text.replace(/\s+/g, " ").trim().slice(0, 300) || null : null;
}

export function readClaudeTurn(query: ClaudeTurnQuery, previous?: ClaudeTurnCursor | null): ClaudeTurnResult {
  const root = join(query.home, "projects");
  const markers = query.markers.filter(marker => typeof marker === "string" && marker.length > 0);
  const key = JSON.stringify([root, query.path, query.sessionId, query.baseline, markers]);
  const unknown = (code: string, cursor: ClaudeTurnCursor | null = null): ClaudeTurnResult => ({ outcome: "unknown", code, error: null, cursor });
  if (!providerLogPath(root, query.path)) return unknown("path_unavailable");
  if (!markers.length) return unknown("marker_missing");
  const state = previous && previous.key === key ? previous : { key, log: null, anchored: false, open: false, ended: 0, pending: null, last: null };
  const range = readJsonlRange(root, query.path, state.log, { startOffset: query.baseline.offset, fileIdentity: query.baseline.fileIdentity, maxBytes: CHUNK_BYTES });
  if (!range.cursor || !["complete_range", "corrupt_log", "partial_log", "scan_pending"].includes(range.code)) return unknown(range.code);
  const next: ClaudeTurnCursor = { ...state, log: range.cursor };
  for (const record of range.records) {
    const entry = jsonObject(record.value);
    if (!entry || entry.isSidechain) continue;
    // 세션은 파일 이름(세션 ID)과 줄의 sessionId 로 묶는다. 줄의 cwd 는 Bash 의 cd 를 따르는 지금 폴더라 보지 않는다(핫픽스 A).
    if (typeof entry.sessionId === "string" && entry.sessionId !== query.sessionId) return unknown("session_conflict", next);
    if (entry.type === "system") {
      if ((entry.subtype === "stop_hook_summary" || entry.subtype === "turn_duration") && next.open) {
        next.open = false;
        next.last = next.pending; next.pending = null;
        if (next.anchored) next.ended++;
      }
      continue;
    }
    if (entry.type === "queue-operation") {
      // 큐에 있던 글을 꺼냈다: 그 글로 새 턴이 열린다(뒤 작업이 끝난 알림, 일하는 동안 넣은 글).
      if (entry.operation === "dequeue" && !next.open) { next.open = true; next.pending = null; }
      continue;
    }
    if (entry.type === "assistant") {
      if (!next.open) { next.open = true; next.pending = null; }
      next.pending = entry.isApiErrorMessage === true ? { error: typeof entry.error === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(entry.error) ? entry.error : "other", text: errorText(jsonObject(entry.message)) } : null;
      continue;
    }
    if (!isTurnInput(entry)) continue;
    if (!next.open) { next.open = true; next.pending = null; }
    if (!next.anchored) {
      const user = parseProviderUserText("claude", entry);
      if (user?.texts.some(text => markers.some(marker => hasExactMarker(text, marker)))) next.anchored = true;
    }
  }
  // 망가진 줄은 턴 사건을 가렸을 수 있다. 덜 쓴 줄·아직 읽는 중이면 다음 관측이 이어 읽는다.
  if (range.code === "corrupt_log" || next.log?.invalid) return unknown("corrupt_log", next);
  if (!range.complete) return unknown(range.code, next);
  if (!next.anchored) return unknown("marker_missing", next);
  if (next.open) return { outcome: "running", code: "turn_open", error: null, cursor: next };
  if (!next.ended) return unknown("no_turn_end", next);
  return { outcome: "ended", code: "turn_end", error: next.last, cursor: next };
}

/**
 * 같은 질문을 훅 기록으로 본다(A 의 자리 묶기: 부르는 쪽이 봉투를 쓰기 직전의 사건 파일 자리부터 읽은 줄만 넘긴다).
 * 그 세션의 UserPromptSubmit 가운데 전달 표지가 든 것 뒤에, Stop·StopFailure 로 닫히고 다시 열리지 않았으면 ended.
 * 다른 세션·세션 없는 줄은 보지 않는다. SessionStart·PostCompact 는 턴을 열거나 닫지 않는다.
 */
export interface ClaudeHookTurnState { anchored: boolean; open: boolean; ended: number; last: ClaudeTurnError | null }
export function claudeHookTurn(state: ClaudeHookTurnState, records: HookEventRecord[], sessionId: string, markers: string[]): { outcome: "ended" | "running" | "unknown"; code: string; error: ClaudeTurnError | null } {
  for (const record of records) {
    if (!sessionId || record.sessionId !== sessionId) continue;
    if (record.event === "UserPromptSubmit") {
      state.open = true;
      if (!state.anchored && record.markers?.some(marker => markers.includes(marker))) state.anchored = true;
    } else if ((record.event === "Stop" || record.event === "StopFailure") && state.open) {
      state.open = false;
      state.last = record.event === "StopFailure" ? { error: record.error ?? "other", text: null } : null;
      if (state.anchored) state.ended++;
    }
  }
  if (!state.anchored) return { outcome: "unknown", code: "hook_marker_missing", error: null };
  if (state.open) return { outcome: "running", code: "hook_turn_open", error: null };
  if (!state.ended) return { outcome: "unknown", code: "hook_no_turn_end", error: null };
  return { outcome: "ended", code: "hook_turn_end", error: state.last };
}
