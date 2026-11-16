// 11-16: Codex 자기 기록(rollout)에서 한 전달 뒤의 턴이 모두 끝났는지 읽는다. 읽기만 한다. 시간은 보지 않는다.
//
// 까닭: Codex 는 턴을 끝냈어도 자기가 띄운 백그라운드 터미널(exec 세션)이 살아 있으면 실행 엔진(core)에 working 으로 보인다.
// 2026-11-15 라이브에서 미리보기 서버 하나 때문에 팀장이 15시간 '일하는 중'이었다. 그 동안에도 Codex 는 턴 끝을 자기 기록에 남긴다.
//
// Codex 0.166.0 실측: 턴마다 event_msg task_started(payload.turn_id) → 개발자·사용자 글 → … → token_count → 같은 turn_id 의 task_complete.
// 중단된 턴은 turn_aborted 로 끝난다. 0.2.7 배포 전 확인(실제 Codex 0.166.0, real-cli P1): 오래 도는 셸 명령을 하던 턴을 Esc 로 멈추면 턴은
// 곧바로 turn_aborted(interrupted)로 끝나고 Codex 는 입력을 받지만, 그 명령은 백그라운드 터미널로 계속 돌아 core 는 working 이다. 이것도 그 턴의 끝이다
// (code turn_aborted). 예전에는 '끝났는지 모름'으로 두어 팀장이 그 명령이 끝날 때까지 '일하는 중'이었고 활동 줄은 '끝났다는 기록을 찾지 못했다'고 했다.
// - 기준선(봉투가 쓰기 직전에 잡은 기록 끝)이 있으면 그 뒤만 읽는다. 없으면(세션을 아직 몰랐던 첫 전달) 처음부터 읽되,
//   그 전달의 표지(#iamceo_…)가 든 사용자 글 뒤에 끝난 턴만 센다.
// - 끝났다(ended): 읽은 범위 안에서 시작한 턴이 그 범위에서 task_complete(또는 turn_aborted)로 끝났고, 열린 턴이 없고, 마지막 턴 사건이
//   그 끝이다. 마지막이 중단이면 code 는 turn_aborted 다(멈춘 턴: 실행하던 명령이 뒤에 남았을 수 있다).
// - 열린 턴이 있으면 running. 기록을 끝까지 읽지 못했거나(덜 쓴 줄·망가진 줄·아직 읽는 중) 세션·폴더가 다르거나 표지를 못 찾으면 unknown.
import { join } from "node:path";
import { hasExactMarker, jsonObject, parseCodexSessionMeta, parseProviderUserText, providerLogPath, readJsonlRange, type JsonlCursor } from "./delivery-evidence.ts";

export interface CodexTurnQuery {
  /** CODEX_HOME. 기록은 <home>/sessions 아래에 있어야 한다. */
  home: string;
  path: string;
  sessionId: string;
  cwd: string;
  /** 봉투의 기록 기준선. null 이면 markers 가 든 사용자 글부터 센다. */
  baseline: { offset: number; fileIdentity: string | null } | null;
  /** 그 전달의 묶음 표지와 전달 표지. */
  markers: string[];
}
export interface CodexTurnCursor {
  /** 이 질문(기록·세션·기준선·표지)의 열쇠. 다르면 처음부터 다시 읽는다. */
  key: string;
  log: JsonlCursor | null;
  /** 기준선 뒤이거나, 표지가 든 사용자 글을 지났다. */
  anchored: boolean;
  /** 읽은 범위에서 시작해 아직 끝나지 않은 턴(turn_id). turn_id 가 없는 기록은 anonymous 로 센다. */
  open: string[];
  anonymous: number;
  /** anchored 뒤에 task_complete(또는 turn_aborted)로 끝난, 읽은 범위 안에서 시작한 턴 수. */
  completed: number;
  last: "started" | "complete" | "aborted" | null;
}
export interface CodexTurnResult {
  outcome: "ended" | "running" | "unknown";
  /** turn_complete · turn_open · no_turn_complete · turn_aborted · marker_missing · session_conflict · corrupt_log · scan_pending · partial_log · path_unavailable · file_changed … */
  code: string;
  /** 다음 읽기가 이어 갈 자리. 처음부터 다시 읽어야 하면 null. */
  cursor: CodexTurnCursor | null;
}

/** 한 번에 읽는 상한. 넘으면 scan_pending 이고 다음 관측이 이어 읽는다. */
const CHUNK_BYTES = 4 * 1024 * 1024;

export function readCodexTurnEnd(query: CodexTurnQuery, previous?: CodexTurnCursor | null): CodexTurnResult {
  const root = join(query.home, "sessions");
  const markers = query.markers.filter(marker => typeof marker === "string" && marker.length > 0);
  const key = JSON.stringify([root, query.path, query.sessionId, query.cwd, query.baseline, markers]);
  const unknown = (code: string, cursor: CodexTurnCursor | null = null): CodexTurnResult => ({ outcome: "unknown", code, cursor });
  if (!providerLogPath(root, query.path)) return unknown("path_unavailable");
  if (!query.baseline && !markers.length) return unknown("marker_missing");
  let state = previous && previous.key === key ? previous : null;
  if (!state) {
    // 기록의 첫 줄은 이 세션·이 폴더의 session_meta 여야 한다. 파일 이름은 근거가 아니다.
    const head = readJsonlRange(root, query.path, null, { maxBytes: 1024 * 1024, fileIdentity: query.baseline?.fileIdentity ?? null });
    if (head.code === "file_changed") return unknown("file_changed");
    const first = head.records[0];
    const meta = parseCodexSessionMeta(first?.value);
    if (!meta || first?.start !== 0 || meta.sessionId !== query.sessionId || meta.cwd !== query.cwd) return unknown("session_conflict");
    state = { key, log: null, anchored: query.baseline !== null, open: [], anonymous: 0, completed: 0, last: null };
  }
  const range = readJsonlRange(root, query.path, state.log, { startOffset: query.baseline?.offset ?? 0, fileIdentity: query.baseline?.fileIdentity ?? null, maxBytes: CHUNK_BYTES });
  if (!range.cursor || !["complete_range", "corrupt_log", "partial_log", "scan_pending"].includes(range.code)) return unknown(range.code);
  const next: CodexTurnCursor = { ...state, log: range.cursor, open: [...state.open] };
  for (const record of range.records) {
    const entry = jsonObject(record.value);
    if (!entry) continue;
    // 기록 가운데의 session_meta 는 다른 세션이 이어 붙은 것이다.
    if (entry.type === "session_meta") { if (record.start !== 0) return unknown("session_conflict"); continue; }
    if (!next.anchored) {
      const user = parseProviderUserText("codex", entry);
      if (user?.texts.some(text => markers.some(marker => hasExactMarker(text, marker)))) next.anchored = true;
    }
    if (entry.type !== "event_msg") continue;
    const payload = jsonObject(entry.payload);
    const id = typeof payload?.turn_id === "string" && payload.turn_id ? payload.turn_id : null;
    if (payload?.type === "task_started") {
      if (id === null) next.anonymous++;
      else if (!next.open.includes(id)) next.open.push(id);
      next.last = "started";
    } else if (payload?.type === "task_complete" || payload?.type === "turn_aborted") {
      // 범위 밖에서 시작한 턴(기준선을 잡을 때 이미 돌던 턴)의 끝은 이 전달의 턴 끝이 아니다.
      const begun = id !== null ? next.open.includes(id) : next.anonymous > 0;
      if (id !== null) next.open = next.open.filter(open => open !== id);
      else if (next.anonymous > 0) next.anonymous--;
      if (begun && next.anchored) next.completed++;
      next.last = payload.type === "task_complete" ? "complete" : "aborted";
    }
  }
  // 망가진 줄은 턴 사건을 가렸을 수 있다. 덜 쓴 줄·아직 읽는 중이면 다음 관측이 이어 읽는다.
  if (range.code === "corrupt_log" || next.log?.invalid) return unknown("corrupt_log", next);
  if (!range.complete) return unknown(range.code, next);
  if (!next.anchored) return unknown("marker_missing", next);
  if (next.open.length || next.anonymous || next.last === "started") return { outcome: "running", code: "turn_open", cursor: next };
  // 범위 밖에서 시작한 턴(기준선 전에 이미 돌던 턴)이 중단으로 끝났을 뿐이면 이 전달의 턴 끝이 아니다.
  if (!next.completed) return unknown(next.last === "aborted" ? "turn_aborted" : "no_turn_complete", next);
  if (next.last === "aborted") return { outcome: "ended", code: "turn_aborted", cursor: next };
  if (next.last !== "complete") return unknown("no_turn_complete", next);
  return { outcome: "ended", code: "turn_complete", cursor: next };
}
