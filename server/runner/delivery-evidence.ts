/** Read-only provider evidence. A completed range is not a transport drain barrier. */
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { CliProvider, DeliveryEvidence } from "../../shared/types.ts";
import type { DeliveryLogBaseline } from "./types.ts";

export interface JsonlCursor {
  path: string;
  fileIdentity: string;
  /** Next complete line and next unread byte, respectively. */
  offset: number;
  readOffset: number;
  pending: string; // base64: never decode incomplete UTF-8
  dropping: boolean;
  invalid: boolean;
  anchor: string;
}
export interface JsonlRecord { value: unknown; start: number; end: number }
export interface JsonlRange {
  cursor: JsonlCursor | null;
  records: JsonlRecord[];
  complete: boolean;
  code: string;
  bytesRead: number;
}
export function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Resolve both root and file before opening. Symlinks outside the provider root fail closed. */
export function providerLogPath(root: string, path: string): string | null {
  if (!root || !path || !isAbsolute(root) || !isAbsolute(path)) return null;
  try {
    const base = realpathSync(root), target = realpathSync(path);
    const rel = relative(base, target);
    return rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) ? target : null;
  } catch { return null; }
}
function anchorAt(fd: number, offset: number): string {
  const bytes = Buffer.alloc(Math.min(offset, 256));
  if (readSync(fd, bytes, 0, bytes.length, offset - bytes.length) !== bytes.length) throw new Error("Short anchor read");
  return createHash("sha256").update(bytes).digest("hex");
}
/** Bounded, serializable forward scan. Oversized/corrupt lines permanently invalidate absence. */
export function readJsonlRange(root: string, path: string, cursor?: JsonlCursor | null, options: { maxBytes?: number; startOffset?: number; fileIdentity?: string | null; maxLineBytes?: number } = {}): JsonlRange {
  const unknown = (code: string): JsonlRange => ({ cursor: cursor ?? null, records: [], complete: false, code, bytesRead: 0 });
  const target = providerLogPath(root, path);
  if (!target) return unknown("path_unavailable");
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return unknown("file_unreadable"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || providerLogPath(root, path) !== target) return unknown("path_changed");
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const start = options.startOffset ?? 0;
    if (!Number.isSafeInteger(start) || start < 0 || start > stat.size) return unknown("invalid_offset");
    if (options.fileIdentity && identity !== options.fileIdentity) return unknown("file_changed");
    if (cursor && (cursor.path !== target || cursor.fileIdentity !== identity || cursor.readOffset > stat.size ||
      !Number.isSafeInteger(cursor.readOffset) || !Number.isSafeInteger(cursor.offset) || cursor.offset < start || cursor.readOffset < cursor.offset ||
      anchorAt(fd, cursor.readOffset) !== cursor.anchor)) return unknown("file_changed");
    if (!cursor && start > 0) {
      const previous = Buffer.alloc(1);
      readSync(fd, previous, 0, 1, start - 1);
      if (previous[0] !== 10) return unknown("invalid_offset");
    }
    const next: JsonlCursor = cursor ? { ...cursor } : { path: target, fileIdentity: identity, offset: start, readOffset: start, pending: "", dropping: false, invalid: false, anchor: "" };
    const maxBytes = Math.min(4 * 1024 * 1024, Math.max(0, Math.floor(options.maxBytes ?? 4 * 1024 * 1024)));
    const maxLine = Math.min(4 * 1024 * 1024, Math.max(1, Math.floor(options.maxLineBytes ?? 4 * 1024 * 1024)));
    if (!Number.isFinite(maxBytes) || !Number.isFinite(maxLine)) return unknown("invalid_budget");
    let remaining = Math.min(maxBytes, stat.size - next.readOffset), bytesRead = 0;
    let pending = Buffer.from(next.pending, "base64");
    if ((!next.dropping && pending.length !== next.readOffset - next.offset) || pending.length > maxLine) return unknown("invalid_cursor");
    const records: JsonlRecord[] = [];
    while (remaining > 0) {
      const bytes = Buffer.alloc(Math.min(64 * 1024, remaining));
      const length = readSync(fd, bytes, 0, bytes.length, next.readOffset);
      if (!length) return { cursor: next, records: [], complete: false, code: "short_read", bytesRead };
      let from = 0;
      for (let at = 0; at < length; at++) {
        if (bytes[at] !== 10) continue;
        const piece = bytes.subarray(from, at);
        if (!next.dropping && pending.length + piece.length <= maxLine) {
          const line = Buffer.concat([pending, piece]);
          if (line.length && line.toString("utf8").trim()) {
            try {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
              records.push({ value: JSON.parse(text), start: next.offset, end: next.readOffset + at + 1 });
            } catch { next.invalid = true; }
          }
        } else next.invalid = true;
        next.offset = next.readOffset + at + 1;
        pending = Buffer.alloc(0);
        next.dropping = false;
        from = at + 1;
      }
      const piece = bytes.subarray(from, length);
      if (!next.dropping && pending.length + piece.length <= maxLine) pending = Buffer.concat([pending, piece]);
      else { next.dropping = true; next.invalid = true; pending = Buffer.alloc(0); }
      next.readOffset += length;
      remaining -= length;
      bytesRead += length;
    }
    next.pending = pending.toString("base64");
    next.anchor = anchorAt(fd, next.readOffset);
    const after = fstatSync(fd);
    // Also detect rename+replacement at the same canonical pathname while open.
    let checkFd: number;
    try { checkFd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { return unknown("file_changed"); }
    try {
      const check = fstatSync(checkFd);
      if (`${check.dev}:${check.ino}:${check.birthtimeMs}` !== identity) return unknown("file_changed");
    } finally { closeSync(checkFd); }
    if (after.size < stat.size || providerLogPath(root, path) !== target) return unknown("file_changed");
    const eof = next.readOffset === after.size;
    const complete = eof && next.offset === next.readOffset && !next.invalid && !next.dropping;
    return { cursor: next, records, complete, code: complete ? "complete_range" : next.invalid ? "corrupt_log" : eof ? "partial_log" : "scan_pending", bytesRead };
  } catch { return unknown("file_unreadable"); }
  finally { closeSync(fd); }
}

export interface CodexSessionMeta { sessionId: string; cwd: string; model: string | null }
export function parseCodexSessionMeta(value: unknown): CodexSessionMeta | null {
  const entry = jsonObject(value), payload = jsonObject(entry?.payload);
  if (entry?.type !== "session_meta" || !payload) return null;
  const id = payload.id ?? payload.session_id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) ||
    (payload.id !== undefined && payload.session_id !== undefined && payload.id !== payload.session_id) || typeof payload.cwd !== "string" || !isAbsolute(payload.cwd)) return null;
  // Parent CLI only. In particular source:{subagent:...} is never a parent.
  if (payload.source !== undefined && !["cli", "exec", "vscode"].includes(payload.source as string)) return null;
  return { sessionId: id, cwd: payload.cwd, model: typeof payload.model === "string" ? payload.model : null };
}
export interface ProviderUserText { texts: string[]; sessionId: string | null; cwd: string | null; eventId: string | null; timestamp: string | null }
/** Only direct user text, never recursively search a tool result or raw JSON. */
export function parseProviderUserText(cli: CliProvider, value: unknown): ProviderUserText | null {
  const entry = jsonObject(value);
  if (!entry || entry.isSidechain || entry.isMeta || entry.isReplay || entry.is_replay) return null;
  const message = jsonObject(cli === "claude" ? entry.message : entry.payload);
  if (!message || message.isSidechain || message.isMeta || message.isReplay || message.is_replay) return null;
  let texts: string[];
  if (cli === "claude") {
    if (entry.type !== "user" || message.role !== "user") return null;
    texts = typeof message.content === "string" ? [message.content] : textBlocks(message.content, ["text"]);
  } else if (entry.type === "response_item" && message.type === "message" && message.role === "user") {
    texts = textBlocks(message.content, ["input_text", "text"]);
  } else if (entry.type === "event_msg" && message.type === "user_message" && typeof message.message === "string") texts = [message.message];
  else return null;
  return { texts, sessionId: typeof entry.sessionId === "string" ? entry.sessionId : typeof message.session_id === "string" ? message.session_id : null,
    cwd: typeof entry.cwd === "string" ? entry.cwd : typeof message.cwd === "string" ? message.cwd : null,
    eventId: typeof entry.uuid === "string" ? entry.uuid : typeof message.id === "string" ? message.id : null,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null };
}
function textBlocks(content: unknown, kinds: string[]): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    const item = jsonObject(block);
    return item && kinds.includes(item.type as string) && typeof item.text === "string" ? [item.text] : [];
  });
}
/** Recognizable non-text user blocks are safe to skip; future text layouts are not absence. */
export function supportedUserTextLayout(cli: CliProvider, value: unknown): boolean {
  const entry = jsonObject(value);
  if (!entry || entry.isSidechain || entry.isMeta || entry.isReplay || entry.is_replay) return true;
  const message = jsonObject(cli === "claude" ? entry.message : entry.payload);
  const relevant = cli === "claude" ? entry.type === "user" :
    (entry.type === "response_item" && message?.type === "message" && message.role === "user") || (entry.type === "event_msg" && message?.type === "user_message");
  if (!relevant || message?.isSidechain || message?.isMeta) return true;
  if (!message) return false;
  if (cli === "codex" && entry.type === "event_msg") return typeof message.message === "string";
  if (cli === "claude" && message.role !== "user") return false;
  if (cli === "claude" && typeof message.content === "string") return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.every((block: unknown) => {
    const item = jsonObject(block);
    if (!item) return false;
    if (item.type === "text" || (cli === "codex" && item.type === "input_text")) return typeof item.text === "string";
    return (cli === "claude" ? ["tool_result", "image", "document"] : ["input_image", "image", "tool_result"]).includes(item.type as string);
  });
}
/**
 * Claude transcript record types. Everything except "user" is metadata for evidence purposes. Claude Code 2.1.31x
 * added the second row (observed in a real 2.1.319 session: hooks/context attachments, request shapes and
 * per-message request blobs, mode/owner/tool bookkeeping). An unknown type still makes the range unsupported.
 */
const CLAUDE_RECORD_TYPES = ["user", "assistant", "system", "progress", "summary", "file-history-snapshot", "queue-operation", "last-prompt", "custom-title", "agent-name", "agent-color", "pr-link",
  "attachment", "api-request", "api-request-blob", "api-request-shape", "mode", "permission-mode", "session-owner", "atis-latch", "tools-used"];
function blobHasMarker(entry: Record<string, unknown>, marker: string): boolean {
  const message = jsonObject(entry.message);
  if (!message || message.role !== "user") return false;
  const texts = typeof message.content === "string" ? [message.content] : textBlocks(message.content, ["text"]);
  return texts.some((text) => hasExactMarker(text, marker));
}
/** No trimming, normalization, or matching inside a longer token. */
export function hasExactMarker(text: string, marker: string): boolean {
  if (!marker) return false;
  let at = text.indexOf(marker);
  while (at >= 0) {
    const before = Array.from(text.slice(0, at)).at(-1) ?? "";
    const after = text.slice(at + marker.length).match(/^./u)?.[0] ?? "";
    if ((!before || !/[\p{L}\p{N}\p{M}_#\-]/u.test(before)) && (!after || !/[\p{L}\p{N}\p{M}_#\-]/u.test(after))) return true;
    at = text.indexOf(marker, at + 1);
  }
  return false;
}
export interface DeliveryEvidenceCursor {
  sessionGeneration: number;
  sessionId: string;
  cwd: string;
  queryKey: string;
  log: JsonlCursor | null;
  meta: CodexSessionMeta | null;
  receivedDeliveryIds: string[];
  seenEventIds: string[];
  /** Markers seen only in an API request copy, never in a user record (Claude). Absent in older cursors. */
  blobOnlyDeliveryIds?: string[];
  conflict: boolean;
  unsupported: boolean;
  recognized: boolean;
}
export interface DeliveryEvidenceOptions {
  cli: CliProvider;
  home: string;
  path: string;
  cwd: string;
  sessionId: string;
  sessionGeneration: number;
  markers: { deliveryId: string; marker: string }[];
  bundleMarker?: string;
  baseline?: DeliveryLogBaseline;
  since?: string;
  cursor?: DeliveryEvidenceCursor | null;
  maxBytes?: number;
}
export interface DeliveryLogResult {
  evidence: DeliveryEvidence;
  receivedDeliveryIds: string[];
  cursor: DeliveryEvidenceCursor | null;
}
export function readDeliveryEvidence(options: DeliveryEvidenceOptions): DeliveryLogResult {
  const { cli, home, path, sessionId, sessionGeneration, cwd, markers, baseline } = options;
  const root = join(home, cli === "claude" ? "projects" : "sessions");
  const queryKey = createHash("sha256").update(JSON.stringify([cli, resolve(home), resolve(path), markers, options.bundleMarker, baseline, options.since])).digest("hex");
  const unknown = (code: string): DeliveryLogResult => ({ evidence: { source: cli === "claude" ? "claude_log" : "codex_log", verdict: "unknown", location: "none", code, complete: false, checkedAt: new Date().toISOString() }, receivedDeliveryIds: [], cursor: options.cursor ?? null });
  const old = options.cursor;
  if (old && (old.sessionGeneration !== sessionGeneration || old.sessionId !== sessionId || old.cwd !== cwd || old.queryKey !== queryKey)) return unknown("generation_changed");
  if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId) || !isAbsolute(cwd)) return unknown("session_unbound");
  if (cli === "claude" ? basename(path) !== `${sessionId}.jsonl` || relative(root, path).split(/[\\/]/).length !== 2 : !/^rollout-.+\.jsonl$/.test(basename(path))) return unknown("unrecognized_path");
  if (markers.some(({ marker }) => !/^#iamceo_[A-Za-z0-9_-]{22}$/.test(marker)) || new Set(markers.map(({ marker }) => marker)).size !== markers.length ||
    new Set(markers.map(({ deliveryId }) => deliveryId)).size !== markers.length ||
    (options.bundleMarker !== undefined && !/^#iamceo_b_[A-Za-z0-9_-]{22}$/.test(options.bundleMarker))) return unknown("invalid_marker");
  if (baseline && (!baseline.fileIdentity || !providerLogPath(root, baseline.path) || providerLogPath(root, baseline.path) !== providerLogPath(root, path))) return unknown("invalid_baseline");
  if (options.since !== undefined && !Number.isFinite(Date.parse(options.since))) return unknown("invalid_baseline");
  const state: DeliveryEvidenceCursor = old ? { ...old, receivedDeliveryIds: [...old.receivedDeliveryIds], seenEventIds: [...old.seenEventIds] } : { sessionGeneration, sessionId, cwd, queryKey, log: null, meta: null, receivedDeliveryIds: [], seenEventIds: [], conflict: false, unsupported: false, recognized: false };
  const budget = Math.max(0, Math.min(options.maxBytes ?? 4 * 1024 * 1024, 4 * 1024 * 1024));
  let headerBytes = 0;
  // A post-baseline scan still validates the native metadata at the beginning.
  if (cli === "codex" && !state.meta && baseline?.offset) {
    const head = readJsonlRange(root, path, null, { maxBytes: Math.min(1024 * 1024, budget), fileIdentity: baseline.fileIdentity });
    headerBytes += head.bytesRead;
    state.meta = parseCodexSessionMeta(head.records[0]?.value);
    if (!state.meta || head.records[0]?.start !== 0) return unknown("unrecognized_layout");
  }
  if (cli === "claude" && !state.recognized && baseline?.offset) {
    const head = readJsonlRange(root, path, null, { maxBytes: Math.min(1024 * 1024, budget), fileIdentity: baseline.fileIdentity });
    headerBytes += head.bytesRead;
    state.recognized = head.records.some(({ value }) => {
      const entry = jsonObject(value);
      return entry?.sessionId === sessionId && entry.cwd === cwd && !entry.isSidechain;
    });
  }
  const range = readJsonlRange(root, path, state.log, { maxBytes: Math.max(0, budget - headerBytes), startOffset: baseline?.offset, fileIdentity: baseline?.fileIdentity });
  if (!["complete_range", "corrupt_log", "partial_log", "scan_pending"].includes(range.code)) return unknown(range.code);
  state.log = range.cursor;
  const received = new Set(state.receivedDeliveryIds), seen = new Set(state.seenEventIds), blobOnly = new Set(state.blobOnlyDeliveryIds ?? []);
  for (const record of range.records) {
    const entry = jsonObject(record.value);
    if (!entry || typeof entry.type !== "string") { state.unsupported = true; continue; }
    if (!supportedUserTextLayout(cli, entry)) state.unsupported = true;
    if (cli === "claude" && entry.sessionId === sessionId && entry.cwd === cwd && !entry.isSidechain) state.recognized = true;
    if (!(cli === "claude" ? CLAUDE_RECORD_TYPES : ["session_meta", "response_item", "event_msg", "turn_context", "compacted"]).includes(entry.type)) state.unsupported = true;
    // An API request copy is not the session's received input, but a marker that appears only there means the
    // user-record layout changed under us: never let it read as absence.
    if (cli === "claude" && entry.type === "api-request-blob") {
      for (const { deliveryId, marker } of markers) {
        if ((options.bundleMarker && blobHasMarker(entry, options.bundleMarker)) || blobHasMarker(entry, marker)) blobOnly.add(deliveryId);
      }
      continue;
    }
    if (cli === "codex" && entry.type === "session_meta") {
      const meta = parseCodexSessionMeta(entry);
      if (!meta || record.start !== 0 || (state.meta && (meta.sessionId !== state.meta.sessionId || meta.cwd !== state.meta.cwd))) state.unsupported = true;
      else state.meta = meta;
      continue;
    }
    const user = parseProviderUserText(cli, entry);
    if (!user) continue;
    if ((user.eventId && (seen.has(user.eventId) || user.eventId === baseline?.eventId)) ||
      (options.since && user.timestamp && Date.parse(user.timestamp) < Date.parse(options.since))) continue;
    if (user.eventId) seen.add(user.eventId);
    const correct = cli === "claude" ? user.sessionId === sessionId && user.cwd === cwd :
      state.meta?.sessionId === sessionId && state.meta.cwd === cwd && (user.sessionId === null || user.sessionId === sessionId) && (user.cwd === null || user.cwd === cwd);
    const bundle = options.bundleMarker && user.texts.some((text) => hasExactMarker(text, options.bundleMarker!));
    const matches = markers.filter(({ marker }) => bundle || user.texts.some((text) => hasExactMarker(text, marker)));
    if (matches.length && !correct) state.conflict = true;
    if (correct && !state.unsupported) for (const { deliveryId } of matches) received.add(deliveryId);
  }
  state.receivedDeliveryIds = [...received];
  state.seenEventIds = [...seen];
  state.blobOnlyDeliveryIds = [...blobOnly].filter((id) => !received.has(id));
  const blobMismatch = state.blobOnlyDeliveryIds.length > 0;
  const complete = range.complete && !state.conflict && !state.unsupported && !blobMismatch && (cli === "claude" ? state.recognized : state.meta?.sessionId === sessionId && state.meta.cwd === cwd);
  // Positive evidence survives an unrelated corrupt/partial line; conflicts do not authorize input.
  const code = state.conflict ? "session_conflict" : received.size ? "marker_in_user_input" : state.unsupported ? "unrecognized_layout" : blobMismatch ? "marker_outside_user_input" : complete ? "complete_range_without_marker" : range.code;
  return { evidence: { source: cli === "claude" ? "claude_log" : "codex_log", verdict: received.size ? "present" : complete ? "absent" : "unknown", location: received.size ? "received_input" : "none", code, complete, checkedAt: new Date().toISOString() }, receivedDeliveryIds: [...received], cursor: state };
}
