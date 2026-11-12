// E1: 훅이 남긴 사건 기록($IAMCEO_HOME/run/events/<팀장>.jsonl)을 읽기만 한다. 쓰는 쪽은 hooks.ts 의 기록 스크립트다.
// 파일이 상한을 넘으면 기록 스크립트가 <팀장>.1.jsonl 로 돌린다. 읽던 파일이 돌아갔으면 .1 에서 남은 부분을 마저 읽고 새 파일로 넘어간다.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { HOOK_EVENTS, hookEventsFile, type HookEventName } from "./hooks.ts";

export interface HookEventRecord {
  at: number;
  event: HookEventName;
  sessionId: string | null;
  /** SessionStart: startup·resume·clear·compact */
  source?: "startup" | "resume" | "clear" | "compact" | "other";
  /** PostCompact: manual·auto */
  trigger?: "manual" | "auto" | "other";
  /** StopFailure 의 분류값(rate_limit, authentication_failed, billing_error, server_error …). 본문은 없다. */
  error?: string;
  /** UserPromptSubmit: 글 안의 IAMCEO 전달 표지. 글 본문은 없다. */
  markers?: string[];
  chars?: number | null;
  truncated?: boolean;
}

const SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MARKER_RE = /^#iamceo_(?:b_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{22})$/;
const MEMBER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_LINE_BYTES = 64 * 1024;

/** 한 줄을 엄격하게 푼다. 모르는 모양이면 null(그 줄은 비교에 쓰지 않는다). */
export function parseHookEventLine(line: string): HookEventRecord | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || typeof r.at !== "number" || !Number.isFinite(r.at) || r.at <= 0) return null;
  if (typeof r.event !== "string" || !(HOOK_EVENTS as readonly string[]).includes(r.event)) return null;
  const sessionId = typeof r.sessionId === "string" && SESSION_RE.test(r.sessionId) ? r.sessionId : null;
  const out: HookEventRecord = { at: r.at, event: r.event as HookEventName, sessionId };
  if (out.event === "SessionStart") out.source = (["startup", "resume", "clear", "compact"] as const).find(s => s === r.source) ?? "other";
  if (out.event === "PostCompact") out.trigger = (["manual", "auto"] as const).find(s => s === r.trigger) ?? "other";
  if (out.event === "StopFailure") out.error = typeof r.error === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(r.error) ? r.error : "other";
  if (out.event === "UserPromptSubmit") {
    out.markers = Array.isArray(r.markers) ? r.markers.filter((m): m is string => typeof m === "string" && MARKER_RE.test(m)).slice(0, 64) : [];
    out.chars = typeof r.chars === "number" && Number.isSafeInteger(r.chars) && r.chars >= 0 ? r.chars : null;
    if (r.truncated === true) out.truncated = true;
  }
  return out;
}

interface Cursor { identity: string; offset: number }
interface Chunk { records: HookEventRecord[]; invalid: number; offset: number; identity: string }

/** 열 수 없거나 일반 파일이 아니거나 바꿔치기(심볼릭 링크)면 null. */
function readFrom(path: string, cursor: Cursor | null, maxBytes: number): Chunk | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const identity = `${stat.dev}:${stat.ino}`;
    // 다른 파일이거나 제자리에서 줄었으면 처음부터 읽는다.
    let offset = cursor && cursor.identity === identity && cursor.offset <= stat.size ? cursor.offset : 0;
    const length = Math.min(stat.size - offset, maxBytes);
    const records: HookEventRecord[] = [];
    let invalid = 0;
    if (length <= 0) return { records, invalid, offset, identity };
    const bytes = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, bytes, got, length - got, offset + got);
      if (!n) break;
      got += n;
    }
    // 끝의 덜 쓴 줄은 다음에 다시 읽는다. 기록 스크립트는 한 줄을 한 번에 쓴다.
    const end = bytes.subarray(0, got).lastIndexOf(10);
    if (end < 0) {
      // 줄바꿈 없이 상한만큼 찼으면 망가진 줄이다. 건너뛴다.
      if (got >= maxBytes) return { records, invalid: 1, offset: offset + got, identity };
      return { records, invalid, offset, identity };
    }
    let from = 0;
    for (let at = 0; at <= end; at++) {
      if (bytes[at] !== 10) continue;
      const piece = bytes.subarray(from, at);
      from = at + 1;
      if (!piece.length) continue;
      if (piece.length > MAX_LINE_BYTES) { invalid++; continue; }
      const record = parseHookEventLine(piece.toString("utf8"));
      if (record) records.push(record); else invalid++;
    }
    offset += end + 1;
    return { records, invalid, offset, identity };
  } catch { return null; }
  finally { try { closeSync(fd); } catch { /* 읽기만 했다 */ } }
}

/** 팀장 한 명의 사건 파일을 앞으로만 읽는다. 처음 부르면 지금 파일의 처음부터(상한 1 MiB) 읽는다. */
export class HookEventReader {
  private cursor: Cursor | null = null;
  /** 돌린 파일을 놓쳐 읽지 못한 구간이 있었던 횟수(진단용). */
  gaps = 0;
  constructor(private readonly eventsDir: string, readonly memberId: string, private readonly maxBytes = 1024 * 1024) {
    if (!MEMBER_RE.test(memberId)) throw new Error("Invalid member id for hook events");
  }
  read(): { records: HookEventRecord[]; invalid: number } {
    const records: HookEventRecord[] = [];
    let invalid = 0;
    const current = readFrom(hookEventsFile(this.eventsDir, this.memberId), this.cursor, this.maxBytes);
    if (this.cursor && (!current || current.identity !== this.cursor.identity)) {
      // 읽던 파일이 .1 로 돌아갔다. 같은 파일이면 남은 부분을 마저 읽는다.
      const rotated = readFrom(hookEventsFile(this.eventsDir, this.memberId, true), this.cursor, this.maxBytes);
      if (rotated && rotated.identity === this.cursor.identity) {
        records.push(...rotated.records); invalid += rotated.invalid;
        // 새 파일이 아직 없을 수 있다(돌린 직후). 그때는 다음에 .1 을 같은 자리부터 다시 본다.
        this.cursor = { identity: rotated.identity, offset: rotated.offset };
      } else if (current) this.gaps++;
    }
    if (current) {
      // 새 파일로 넘어갔으면 readFrom 이 처음부터 읽었다.
      records.push(...current.records); invalid += current.invalid;
      this.cursor = { identity: current.identity, offset: current.offset };
    }
    return { records, invalid };
  }
}
