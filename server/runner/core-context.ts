/** Provider parsing and observations only. No CLI input, timers, DB writes, or success ACKs. */
import { basename, isAbsolute, join } from "node:path";
import type { CliProvider, ContextMeasurement } from "../../shared/types.ts";
import { contextWindowFor, measureContext, validWindow, type ContextReading, type WindowHints } from "./context.ts";
import { jsonObject, parseCodexSessionMeta, parseProviderUserText, providerLogPath, readJsonlRange, supportedUserTextLayout, type CodexSessionMeta, type JsonlCursor } from "./delivery-evidence.ts";
import { geminiTranscriptPath, geminiTranscriptRoot, isGeminiCheckpoint } from "./gemini-transcript.ts";

export function codexBindingMarker(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) throw new Error("Invalid session binding nonce");
  return `[IAMCEO session binding: ${nonce}]`;
}
export interface CodexBindingCursor {
  generation: number;
  nonce: string;
  cwd: string;
  home: string;
  since: string | null;
  next: number;
  files: { path: string; log: JsonlCursor | null; meta: CodexSessionMeta | null; matched: boolean; invalid: boolean; excluded: boolean }[];
}
export interface CodexBindingResult {
  outcome: "bound" | "pending" | "conflict" | "unknown";
  sessionId: string | null;
  path: string | null;
  cursor: CodexBindingCursor;
  code: string;
}
/** One binding port for context and delivery. Exhaust candidates before claiming uniqueness. */
export function discoverCodexSession(options: { home: string; cwd: string; generation: number; nonce: string; since?: string; cursor?: CodexBindingCursor | null }): CodexBindingResult {
  const marker = codexBindingMarker(options.nonce);
  const old = options.cursor;
  const state: CodexBindingCursor = old ? { ...old, files: old.files.map((file) => ({ ...file })) } :
    { home: options.home, generation: options.generation, nonce: options.nonce, cwd: options.cwd, since: options.since ?? null, next: 0, files: [] };
  const result = (outcome: CodexBindingResult["outcome"], code: string, sessionId: string | null = null, path: string | null = null): CodexBindingResult => ({ outcome, code, sessionId, path, cursor: state });
  if (!isAbsolute(options.home) || !isAbsolute(options.cwd) || !Number.isSafeInteger(options.generation) || options.generation < 0 || (options.since !== undefined && !Number.isFinite(Date.parse(options.since))) ||
    (old && (old.home !== options.home || old.generation !== options.generation || old.nonce !== options.nonce || old.cwd !== options.cwd || old.since !== (options.since ?? null)))) return result("unknown", "generation_changed");
  const root = join(options.home, "sessions");
  let paths: string[];
  try {
    paths = [...new Bun.Glob("**/rollout-*.jsonl").scanSync({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false })].sort();
  } catch { return result("unknown", "path_unavailable"); }
  // Filename time excludes historical schemas before reading their potentially huge bodies.
  const cutoff = options.since ? Date.parse(options.since) - 120_000 : null;
  // Codex names the file in local time. Read as UTC, the real file was filtered out in every zone west of UTC and
  // the session never bound. The name is only a coarse filter (slack beyond any zone/DST difference); the exact
  // check is the session_meta UTC timestamp below.
  const nameCutoff = cutoff === null ? null : cutoff - 26 * 3_600_000;
  paths = paths.filter(path => {
    const stamp = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})[-:](\d{2})[-:](\d{2})/.exec(basename(path));
    const time = stamp ? new Date(+stamp[1]!, +stamp[2]! - 1, +stamp[3]!, +stamp[4]!, +stamp[5]!, +stamp[6]!).getTime() : NaN;
    return nameCutoff === null || !Number.isFinite(time) || time >= nameCutoff;
  });
  if (!paths.length) return result("pending", "session_unbound");
  // A disappeared/rotated candidate cannot retain a positive nonce match.
  if (state.files.some((file) => !paths.includes(file.path))) return result("unknown", "file_changed");
  for (const path of paths) if (!state.files.some((file) => file.path === path)) state.files.push({ path, log: null, meta: null, matched: false, invalid: false, excluded: false });
  let visited = 0;
  while (visited < 8 && state.next < state.files.length) {
    const file = state.files[state.next]!;
    if (file.excluded) { visited++; state.next++; continue; }
    const range = readJsonlRange(root, file.path, file.log, { maxBytes: 1024 * 1024 });
    if (range.code === "file_changed") { file.log = null; file.meta = null; file.matched = false; file.invalid = false; file.excluded = false; return result("pending", "file_changed"); }
    file.log = range.cursor;
    file.invalid ||= ["corrupt_log", "path_unavailable", "file_unreadable", "path_changed"].includes(range.code);
    for (const record of range.records) {
      const entry = jsonObject(record.value);
      if (record.start === 0) {
        file.meta = parseCodexSessionMeta(entry);
        const payload = jsonObject(entry?.payload), source = jsonObject(payload?.source);
        const timestamp = payload?.timestamp ?? entry?.timestamp;
        file.excluded = !!(file.meta && file.meta.cwd !== options.cwd) || !!(cutoff !== null && entry?.type === "session_meta" && typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) < cutoff) || (entry?.type === "session_meta" && source !== null && Object.hasOwn(source, "subagent"));
        if (file.excluded) break;
        if (!file.meta) file.invalid = true;
      } else if (entry?.type === "session_meta") file.invalid = true;
      if (!supportedUserTextLayout("codex", entry)) file.invalid = true;
      const user = parseProviderUserText("codex", entry);
      if (!user || !file.meta || file.meta.cwd !== options.cwd ||
        (user.sessionId !== null && user.sessionId !== file.meta.sessionId) || (user.cwd !== null && user.cwd !== options.cwd) ||
        (options.since && user.timestamp && Date.parse(user.timestamp) < cutoff!)) continue;
      if (user.texts.some((text) => text.split("\n").some((line) => line === marker))) file.matched = true;
    }
    visited++;
    if (!file.excluded && range.code === "scan_pending") return result("pending", "scan_pending");
    state.next++;
  }
  if (state.next < state.files.length) return result("pending", "scan_pending");
  state.next = 0; // next tick checks append-only changes, not the full historical bytes
  const matches = state.files.filter((file) => file.matched && !file.excluded && !file.invalid && file.meta?.cwd === options.cwd);
  if (matches.length > 1) return result("conflict", "binding_conflict");
  // Invalid other-parent candidates can conceal another copy of this nonce.
  const unresolved = state.files.some((file) => !file.excluded && (file.invalid || !file.meta || !file.log || file.log.offset !== file.log.readOffset || file.log.invalid));
  if (unresolved) return result("unknown", "incomplete_candidates");
  for (let i = 0; i < state.files.length; i++) {
    const file = state.files[i]!;
    if (file.excluded) continue;
    const check = readJsonlRange(root, file.path, file.log, { maxBytes: 0 });
    if (!check.complete && !file.excluded) { state.next = i; return result("pending", check.code); }
  }
  return matches.length === 1 ? result("bound", "nonce_in_user_input", matches[0]!.meta!.sessionId, matches[0]!.path) : result("pending", "session_unbound");
}

export interface CoreContextIdentity { sessionId: string; generation: number; terminalId: string; turn: number | null; model: string | null }
export function coreContextMeasurement(reading: ContextReading, observed: CoreContextIdentity, current: CoreContextIdentity, hints: Omit<WindowHints, "model">, options: { complete: boolean; measuredAt: string; fresh: boolean }): ContextMeasurement | null {
  if (observed.sessionId !== current.sessionId || observed.generation !== current.generation || observed.terminalId !== current.terminalId || observed.turn !== current.turn ||
    observed.model !== current.model || (reading.sessionId !== undefined && reading.sessionId !== current.sessionId) || (reading.model !== null && current.model !== null && reading.model !== current.model)) return null;
  const measured = measureContext(reading, hints);
  if (!measured) return null;
  const exact = reading.exact;
  const quality = exact && validWindow(exact.window) && (reading.tokens === null || (Number.isFinite(reading.tokens) && reading.tokens >= 0 && reading.tokens <= exact.window)) ? "exact" : "estimated";
  return { sessionId: current.sessionId, sessionGeneration: current.generation, turn: current.turn, model: reading.model ?? current.model,
    tokens: reading.tokens !== null && Number.isFinite(reading.tokens) && reading.tokens >= 0 ? reading.tokens : null,
    window: measured.learned ?? (reading.tokens !== null && Number.isFinite(reading.tokens) && reading.tokens >= 0 ? contextWindowFor(reading.tokens, { ...hints, model: reading.model ?? current.model }) : validWindow(hints.learned) ? hints.learned : null), source: measured.source ?? (validWindow(hints.learned) ? "stored" : "default"), quality,
    measuredAt: options.measuredAt, fresh: options.fresh && options.complete && quality === "exact" && reading.tokens !== null && reading.model !== null && current.model !== null && current.turn !== null };
}

export interface CompactBoundaryBaseline extends CoreContextIdentity { path: string; fileIdentity: string; offset: number }
/**
 * 경계 판정 규칙의 판. 2: Claude 경계 줄의 cwd 를 보지 않는다. 그 값은 Bash 의 cd 를 따라 바뀌는 지금 폴더일 뿐이고(2026-11-15 실측:
 * 하위 폴더에 들어가 있던 팀장의 경계 줄을 못 알아봐 압축이 '결과 모름'으로 13시간 남음), 세션은 파일(세션 ID 이름)과 줄의 sessionId 로 묶는다.
 * 판이 다른 커서(옛 규칙으로 이미 지나 읽은 것)는 버리고 기준선부터 다시 읽는다.
 */
export const COMPACT_BOUNDARY_RULES = 2;
/**
 * nothing: 기준선 뒤 같은 세션에 Claude 가 압축 명령을 '할 것 없음'으로 끝낸 출력(CLAUDE_COMPACT_NOTHING)을 적었다.
 */
export interface CompactBoundaryCursor { baseline: CompactBoundaryBaseline; queryKey: string; log: JsonlCursor | null; boundary: boolean; invalid: boolean; rules?: number; nothing?: boolean }
/**
 * nothing: 압축 경계는 없고, Claude 가 그 압축 명령을 'Not enough messages to compact.' 로 끝냈으며 CLI 가 쉰다(성공도 실패도 아닌 '할 것 없음').
 */
export interface CompactBoundaryResult { outcome: "succeeded" | "nothing" | "pending" | "unknown"; code: string; cursor: CompactBoundaryCursor | null }
/**
 * 0.2.7 배포 전 재확인(real-cli-3 곁 문제, 0.1.0 부터): Claude 2.1.323 은 압축할 대화가 적으면 수동 압축(/compact)을 곧바로 이 출력으로 끝내고 쉰다.
 * 세션 기록 줄: `{"type":"system","subtype":"local_command","content":"<local-command-stdout>Not enough messages to compact.</local-command-stdout>",
 * "commandRun":{"command":"compact","args":…},"isMeta":false,…}`(견본 tests/fixtures/cli/claude/2.1.323/transcript-compact-nothing.jsonl).
 * 경계도 압축 끝 훅도 오지 않아 서버가 그 압축을 10분 붙잡고 대표에게 막힘을 보냈다. 글자까지 같을 때만 '할 것 없음'으로 본다(다른 출력은 지금처럼).
 */
export const CLAUDE_COMPACT_NOTHING = "<local-command-stdout>Not enough messages to compact.</local-command-stdout>";
/** Boundary is a candidate; success additionally requires same-owner settled CLI and no provider error. */
export function observeCompactBoundary(options: { cli: CliProvider; home: string; cwd: string; baseline: CompactBoundaryBaseline; current: CoreContextIdentity; settled: boolean; providerError: boolean; cursor?: CompactBoundaryCursor | null }): CompactBoundaryResult {
  const { baseline, current } = options;
  const queryKey = JSON.stringify([options.cli, options.home, options.cwd, baseline]);
  // 옛 규칙의 커서는 그 위치까지 읽은 줄을 지금 규칙으로 다시 보지 못하게 한다. 버리고 기준선(baseline.offset)부터 읽는다.
  const cursor = options.cursor?.rules === COMPACT_BOUNDARY_RULES ? options.cursor : null;
  const unknown = (code: string): CompactBoundaryResult => ({ outcome: "unknown", code, cursor });
  if (baseline.sessionId !== current.sessionId || baseline.generation !== current.generation || baseline.terminalId !== current.terminalId || baseline.model !== current.model ||
    (baseline.turn !== null && (current.turn === null || current.turn < baseline.turn)) || !baseline.fileIdentity ||
    (cursor && cursor.queryKey !== queryKey)) return unknown("session_changed");
  // Antigravity CLI: <홈>/brain/<대화 id>/.system_generated/logs/transcript.jsonl(gemini-transcript.ts). 기록 파일이 대화마다 따로라 세션은 파일로 묶인다.
  const root = options.cli === "codex" ? join(options.home, "sessions") : options.cli === "gemini" ? geminiTranscriptRoot(options.home) : join(options.home, "projects");
  // Antigravity CLI 의 기록은 대화 id 로 정해지는 파일 하나다. 기준선의 파일이 지금 대화의 그 파일이 아니면 다른 대화의 것이다.
  if (options.cli === "gemini" && baseline.path !== geminiTranscriptPath(options.home, current.sessionId)) return unknown("session_conflict");
  if (!providerLogPath(root, baseline.path)) return unknown("path_unavailable");
  if (options.cli === "codex") {
    const head = readJsonlRange(root, baseline.path, null, { maxBytes: 1024 * 1024, fileIdentity: baseline.fileIdentity });
    const meta = parseCodexSessionMeta(head.records[0]?.value);
    if (meta?.sessionId !== current.sessionId || meta.cwd !== options.cwd || head.records[0]?.start !== 0) return unknown("session_conflict");
  }
  const range = readJsonlRange(root, baseline.path, cursor?.log, { startOffset: baseline.offset, fileIdentity: baseline.fileIdentity, maxBytes: 1024 * 1024 });
  if (!range.cursor || !["complete_range", "corrupt_log", "partial_log", "scan_pending"].includes(range.code)) return unknown(range.code);
  const state: CompactBoundaryCursor = { baseline: { ...baseline }, queryKey, log: range.cursor, boundary: cursor?.boundary ?? false, invalid: cursor?.invalid ?? false, rules: COMPACT_BOUNDARY_RULES, ...(cursor?.nothing ? { nothing: true } : {}) };
  for (const record of range.records) {
    const entry = jsonObject(record.value);
    if (!entry) { state.invalid = true; continue; }
    if (entry.isSidechain || entry.isMeta || entry.isReplay || entry.is_replay) continue;
    if (options.cli === "codex" && entry.type === "session_meta") state.invalid = true;
    // Claude 줄의 cwd 는 비교하지 않는다(COMPACT_BOUNDARY_RULES). 다른 세션·사이드체인 줄은 위·여기서 거른다.
    if (options.cli === "claude" && entry.type === "system" && entry.subtype === "compact_boundary" && entry.sessionId === current.sessionId) state.boundary = true;
    if (options.cli === "codex" && entry.type === "compacted" && (entry.sessionId === undefined || entry.sessionId === current.sessionId)) state.boundary = true;
    // Antigravity CLI: 압축 요약 줄(CHECKPOINT · SYSTEM · DONE, 머리말 '# Resuming from a compaction'). 줄에 대화 id 가 없다: 파일이 그 대화의 것이다.
    if (options.cli === "gemini" && isGeminiCheckpoint(entry)) state.boundary = true;
    // 압축 명령을 '할 것 없음'으로 끝낸 출력. 명령 이름이 적혀 있으면 compact 여야 한다(다른 로컬 명령의 출력이 아님).
    const run = jsonObject(entry.commandRun);
    if (options.cli === "claude" && entry.type === "system" && entry.subtype === "local_command" && entry.sessionId === current.sessionId &&
      typeof entry.content === "string" && entry.content.trim() === CLAUDE_COMPACT_NOTHING && (!run || run.command === "compact")) state.nothing = true;
  }
  if (options.providerError) return { outcome: "unknown", code: "provider_error", cursor: state };
  if (state.invalid || !range.complete) return { outcome: "unknown", code: range.code, cursor: state };
  // 경계가 있으면 그것이 먼저다. 경계 없이 '할 것 없음' 출력만 있고 CLI 가 쉬면 그 압축은 끝났다(압축은 일어나지 않았다).
  if (!state.boundary && state.nothing) return { outcome: options.settled ? "nothing" : "pending", code: options.settled ? "nothing_to_compact" : "awaiting_settled", cursor: state };
  return { outcome: state.boundary && options.settled ? "succeeded" : "pending", code: state.boundary ? options.settled ? "boundary_and_settled" : "awaiting_settled" : "awaiting_boundary", cursor: state };
}
