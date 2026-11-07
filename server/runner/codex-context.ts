// Context may start at a bounded tail. Never use this collector to prove delivery absence.
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CONTEXT_SESSION_RE } from "./statusline.ts";
import { validWindow, type ContextReading } from "./context.ts";
import { jsonObject, parseCodexSessionMeta, providerLogPath, readJsonlRange, type JsonlCursor } from "./delivery-evidence.ts";

/** Only current-request usage; cached_input is already included in input_tokens. */
export function parseCodexTokenCount(value: unknown, sessionId: string, model: string | null = null): ContextReading | null {
  const entry = jsonObject(value), payload = jsonObject(entry?.payload), info = jsonObject(payload?.info);
  if (entry?.type !== "event_msg" || payload?.type !== "token_count") return null;
  if (!info) return { sessionId, tokens: null, shownPct: null, model, exact: null };
  const usage = jsonObject(info.last_token_usage);
  const validTokens = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  // A malformed explicit total must not be replaced by a different interpretation.
  const tokens = usage?.total_tokens !== undefined ? usage.total_tokens :
    validTokens(usage?.input_tokens) && validTokens(usage?.output_tokens) ? usage.input_tokens + usage.output_tokens : null;
  return { sessionId, tokens: validTokens(tokens) ? tokens : null, shownPct: null, model,
    exact: validWindow(info.model_context_window) ? { window: info.model_context_window, source: "codex" } : null };
}
export interface CodexContextCursor {
  log: JsonlCursor;
  sessionId: string;
  model: string | null;
  reading: ContextReading | null;
  measuredAt: string | null;
}
export interface CodexContextSample {
  reading: ContextReading | null;
  measuredAt: string | null;
  cursor: CodexContextCursor | null;
  complete: boolean;
  code: string;
}
/** First tick: metadata + at most 1MiB tail; later ticks: at most 1MiB of new bytes. */
export function readCodexContextFile(home: string, path: string, sessionId: string, previous?: CodexContextCursor | null): CodexContextSample {
  const unknown = (code: string): CodexContextSample => ({ reading: null, measuredAt: null, cursor: null, complete: false, code });
  if (!CONTEXT_SESSION_RE.test(sessionId)) return unknown("session_unbound");
  const target = providerLogPath(join(home, "sessions"), path);
  if (!target) return unknown("path_unavailable");
  // Revalidate metadata even for a cached path: filenames and prior cache entries are not identity.
  const head = readJsonlRange(join(home, "sessions"), target, null, { maxBytes: 1024 * 1024 });
  const meta = parseCodexSessionMeta(head.records[0]?.value);
  const sessionWindow = jsonObject(jsonObject(head.records[0]?.value)?.payload)?.context_window;
  if (!meta || meta.sessionId !== sessionId || head.records[0]?.start !== 0 || !head.cursor) return unknown("session_conflict");
  if (previous && (previous.sessionId !== sessionId || previous.log.fileIdentity !== head.cursor.fileIdentity)) previous = null;
  let start = 0;
  if (!previous) {
    let fd: number;
    try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { return unknown("file_unreadable"); }
    try {
      const stat = fstatSync(fd);
      if (`${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== head.cursor.fileIdentity) return unknown("file_changed");
      start = Math.max(0, stat.size - 1024 * 1024);
      if (start) {
        const bytes = Buffer.alloc(Math.min(1024 * 1024, stat.size - start));
        const length = readSync(fd, bytes, 0, bytes.length, start);
        const newline = bytes.subarray(0, length).indexOf(10);
        if (newline < 0) return unknown("partial_log");
        start += newline + 1;
      }
    } finally { closeSync(fd); }
  }
  const range = readJsonlRange(join(home, "sessions"), target, previous?.log, { maxBytes: 1024 * 1024, startOffset: start, fileIdentity: head.cursor.fileIdentity });
  if (range.code === "file_changed" && previous) return readCodexContextFile(home, path, sessionId);
  if (!range.cursor || !["complete_range", "corrupt_log", "partial_log", "scan_pending"].includes(range.code)) return unknown(range.code);
  let model = previous?.model ?? meta.model;
  let reading = previous?.reading ?? null;
  let measuredAt = previous?.measuredAt ?? null;
  for (const record of range.records) {
    const entry = jsonObject(record.value), payload = jsonObject(entry?.payload);
    if (entry?.type === "turn_context" || (entry?.type === "response_item" && payload?.type === "message" && payload.role === "user") || (entry?.type === "event_msg" && payload?.type === "user_message")) {
      if (entry.type === "turn_context" && typeof payload?.model === "string") model = payload.model;
      reading = null;
      measuredAt = null;
    }
    if (entry?.type === "compacted") { reading = null; measuredAt = null; }
    const parsed = parseCodexTokenCount(entry, sessionId, model);
    // Request-level window wins; session metadata supplies the same measured-window tier
    // when token_count omits it. Never infer a window from total usage.
    if (parsed && !parsed.exact && validWindow(sessionWindow)) {
      parsed.exact = { window: sessionWindow, source: "codex" };
    }
    if (parsed) {
      reading = parsed;
      measuredAt = typeof entry?.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : null;
    }
  }
  return { reading, measuredAt, cursor: { log: range.cursor, sessionId, model, reading, measuredAt }, complete: range.complete, code: range.code };
}

const cache = new Map<string, { path: string; cursor: CodexContextCursor | null }>();
/** W0-compatible entry point. Provider home is always an explicit argument. */
export function readCodexContext(home: string, sessionId: string): ContextReading | null {
  if (!isAbsolute(home) || !CONTEXT_SESSION_RE.test(sessionId)) return null;
  const key = `${home}\0${sessionId}`;
  try {
    const paths: string[] = [];
    for (const candidate of new Bun.Glob(`**/rollout-*-${sessionId}.jsonl`).scanSync({ cwd: join(home, "sessions"), absolute: true, onlyFiles: true, followSymlinks: false })) {
      const head = readJsonlRange(join(home, "sessions"), candidate, null, { maxBytes: 1024 * 1024 });
      if (parseCodexSessionMeta(head.records[0]?.value)?.sessionId === sessionId) paths.push(candidate);
    }
    if (paths.length !== 1) { cache.delete(key); return null; }
    const path = paths[0]!;
    const previous = cache.get(key);
    const sample = readCodexContextFile(home, path, sessionId, previous?.path === path ? previous.cursor : null);
    if (cache.size >= 128 && !cache.has(key)) cache.delete(cache.keys().next().value!);
    cache.set(key, { path, cursor: sample.cursor });
    return sample.reading;
  } catch { cache.delete(key); return null; }
}
