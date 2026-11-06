/** Provider parsing and observations only. No CLI input, timers, DB writes, or success ACKs. */
import { isAbsolute, join } from "node:path";
import type { CliProvider, ContextMeasurement } from "../../shared/types.ts";
import { contextWindowFor, measureContext, validWindow, type ContextReading, type WindowHints } from "./context.ts";
import { jsonObject, parseCodexSessionMeta, parseProviderUserText, providerLogPath, readJsonlRange, supportedUserTextLayout, type CodexSessionMeta, type JsonlCursor } from "./delivery-evidence.ts";

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
  if (!paths.length) return result("pending", "session_unbound");
  // A disappeared/rotated candidate cannot retain a positive nonce match.
  if (state.files.some((file) => !paths.includes(file.path))) return result("unknown", "file_changed");
  for (const path of paths) if (!state.files.some((file) => file.path === path)) state.files.push({ path, log: null, meta: null, matched: false, invalid: false, excluded: false });
  let visited = 0;
  while (visited < 8 && state.next < state.files.length) {
    const file = state.files[state.next]!;
    const range = readJsonlRange(root, file.path, file.log, { maxBytes: 1024 * 1024 });
    if (range.code === "file_changed") { file.log = null; file.meta = null; file.matched = false; file.invalid = false; file.excluded = false; return result("pending", "file_changed"); }
    file.log = range.cursor;
    file.invalid ||= ["corrupt_log", "path_unavailable", "file_unreadable", "path_changed"].includes(range.code);
    for (const record of range.records) {
      const entry = jsonObject(record.value);
      if (record.start === 0) {
        file.meta = parseCodexSessionMeta(entry);
        const payload = jsonObject(entry?.payload), source = jsonObject(payload?.source);
        file.excluded = !!(file.meta && file.meta.cwd !== options.cwd) || (entry?.type === "session_meta" && source !== null && Object.hasOwn(source, "subagent"));
        if (!file.meta && !file.excluded) file.invalid = true;
      } else if (entry?.type === "session_meta") file.invalid = true;
      if (!supportedUserTextLayout("codex", entry)) file.invalid = true;
      const user = parseProviderUserText("codex", entry);
      if (!user || !file.meta || file.meta.cwd !== options.cwd ||
        (user.sessionId !== null && user.sessionId !== file.meta.sessionId) || (user.cwd !== null && user.cwd !== options.cwd) ||
        (options.since && user.timestamp && Date.parse(user.timestamp) < Date.parse(options.since))) continue;
      if (user.texts.some((text) => text.split("\n").some((line) => line === marker))) file.matched = true;
    }
    visited++;
    if (range.code === "scan_pending") return result("pending", "scan_pending");
    state.next++;
  }
  if (state.next < state.files.length) return result("pending", "scan_pending");
  state.next = 0; // next tick checks append-only changes, not the full historical bytes
  const matches = state.files.filter((file) => file.matched && !file.invalid && file.meta?.cwd === options.cwd);
  if (matches.length > 1) return result("conflict", "binding_conflict");
  // Invalid other-parent candidates can conceal another copy of this nonce.
  const unresolved = state.files.some((file) => !file.excluded && (file.invalid || !file.meta || !file.log || file.log.offset !== file.log.readOffset || file.log.invalid));
  if (unresolved) return result("unknown", "incomplete_candidates");
  for (let i = 0; i < state.files.length; i++) {
    const file = state.files[i]!;
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
export interface CompactBoundaryCursor { baseline: CompactBoundaryBaseline; queryKey: string; log: JsonlCursor | null; boundary: boolean; invalid: boolean }
export interface CompactBoundaryResult { outcome: "succeeded" | "pending" | "unknown"; code: string; cursor: CompactBoundaryCursor | null }
/** Boundary is a candidate; success additionally requires same-owner settled CLI and no provider error. */
export function observeCompactBoundary(options: { cli: CliProvider; home: string; cwd: string; baseline: CompactBoundaryBaseline; current: CoreContextIdentity; settled: boolean; providerError: boolean; cursor?: CompactBoundaryCursor | null }): CompactBoundaryResult {
  const { baseline, current } = options;
  const queryKey = JSON.stringify([options.cli, options.home, options.cwd, baseline]);
  const unknown = (code: string): CompactBoundaryResult => ({ outcome: "unknown", code, cursor: options.cursor ?? null });
  if (baseline.sessionId !== current.sessionId || baseline.generation !== current.generation || baseline.terminalId !== current.terminalId || baseline.model !== current.model ||
    (baseline.turn !== null && (current.turn === null || current.turn < baseline.turn)) || !baseline.fileIdentity ||
    (options.cursor && options.cursor.queryKey !== queryKey)) return unknown("session_changed");
  const root = options.cli === "codex" ? join(options.home, "sessions") : join(options.home, "projects");
  if (!providerLogPath(root, baseline.path)) return unknown("path_unavailable");
  if (options.cli === "codex") {
    const head = readJsonlRange(root, baseline.path, null, { maxBytes: 1024 * 1024, fileIdentity: baseline.fileIdentity });
    const meta = parseCodexSessionMeta(head.records[0]?.value);
    if (meta?.sessionId !== current.sessionId || meta.cwd !== options.cwd || head.records[0]?.start !== 0) return unknown("session_conflict");
  }
  const range = readJsonlRange(root, baseline.path, options.cursor?.log, { startOffset: baseline.offset, fileIdentity: baseline.fileIdentity, maxBytes: 1024 * 1024 });
  if (!range.cursor || !["complete_range", "corrupt_log", "partial_log", "scan_pending"].includes(range.code)) return unknown(range.code);
  const state: CompactBoundaryCursor = { baseline: { ...baseline }, queryKey, log: range.cursor, boundary: options.cursor?.boundary ?? false, invalid: options.cursor?.invalid ?? false };
  for (const record of range.records) {
    const entry = jsonObject(record.value);
    if (!entry) { state.invalid = true; continue; }
    if (entry.isSidechain || entry.isMeta || entry.isReplay || entry.is_replay) continue;
    if (options.cli === "codex" && entry.type === "session_meta") state.invalid = true;
    if (options.cli === "claude" && entry.type === "system" && entry.subtype === "compact_boundary" && entry.sessionId === current.sessionId && entry.cwd === options.cwd) state.boundary = true;
    if (options.cli === "codex" && entry.type === "compacted" && (entry.sessionId === undefined || entry.sessionId === current.sessionId)) state.boundary = true;
  }
  if (options.providerError) return { outcome: "unknown", code: "provider_error", cursor: state };
  if (state.invalid || !range.complete) return { outcome: "unknown", code: range.code, cursor: state };
  return { outcome: state.boundary && options.settled ? "succeeded" : "pending", code: state.boundary ? options.settled ? "boundary_and_settled" : "awaiting_settled" : "awaiting_boundary", cursor: state };
}
