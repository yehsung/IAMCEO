// E1: 훅이 남긴 사건 기록($IAMCEO_HOME/run/events/<팀장>.jsonl)을 읽기만 한다. 쓰는 쪽은 hooks.ts 의 기록 스크립트다.
// 파일이 상한을 넘으면 기록 스크립트가 <팀장>.1.jsonl 로 돌린다. 읽던 파일이 돌아갔으면 .1 에서 남은 부분을 마저 읽고 새 파일로 넘어간다.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
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
interface Chunk<T> { records: T[]; invalid: number; offset: number; identity: string }

/** 열 수 없거나 일반 파일이 아니거나 바꿔치기(심볼릭 링크)면 null. parse 가 null 을 돌려준 줄은 invalid 로 센다. */
function readFrom<T>(path: string, cursor: Cursor | null, maxBytes: number, parse: (line: string) => T | null): Chunk<T> | null {
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
    const records: T[] = [];
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
      const record = parse(piece.toString("utf8"));
      if (record) records.push(record); else invalid++;
    }
    offset += end + 1;
    return { records, invalid, offset, identity };
  } catch { return null; }
  finally { try { closeSync(fd); } catch { /* 읽기만 했다 */ } }
}

/**
 * 사건 파일의 한 자리. 압축을 넣기 직전에 적어 두고, 압축 끝 훅은 이 뒤에 덧붙은 줄에서만 찾는다(세션 기록의 기준선 offset 과 같은 뜻).
 * identity 가 null 이면 그때 파일이 없었다: 그 뒤에 생긴 파일의 줄은 모두 그 뒤의 것이다.
 */
export interface HookEventsMark { identity: string | null; offset: number }

/** 저장해 둔 값이 자리 모양인가(망가진 값으로 처음부터 읽지 않게). */
export function isHookEventsMark(value: unknown): value is HookEventsMark {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { identity, offset } = value as Record<string, unknown>;
  return (identity === null || typeof identity === "string" && /^\d+:\d+$/.test(identity)) && Number.isSafeInteger(offset) && (offset as number) >= 0 && (identity !== null || offset === 0);
}

/** 지금 사건 파일의 끝 자리. 파일(또는 폴더)이 없으면 identity null. 링크·일반 파일 아님·열기 오류면 null(그 자리를 모른다). */
export function hookEventsMark(eventsDir: string, memberId: string): HookEventsMark | null {
  if (!MEMBER_RE.test(memberId)) return null;
  let fd: number;
  try { fd = openSync(hookEventsFile(eventsDir, memberId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { identity: null, offset: 0 } : null; }
  try {
    const stat = fstatSync(fd);
    return stat.isFile() ? { identity: `${stat.dev}:${stat.ino}`, offset: stat.size } : null;
  } catch { return null; }
  finally { try { closeSync(fd); } catch { /* 읽기만 했다 */ } }
}

/**
 * 팀장 한 명의 사건 파일(<폴더>/<팀장>.jsonl, 돌린 파일은 .1.jsonl)을 앞으로만 읽는다. 처음 부르면 지금 파일의 처음부터(상한 1 MiB),
 * from 을 주면 그 자리부터 읽는다. 줄 풀이(parse)만 갈아 끼운다: Claude 훅 기록은 HookEventReader, Antigravity CLI 훅 기록은 gemini-hooks.ts 가 쓴다.
 */
export class HookFileReader<T> {
  private cursor: Cursor | null = null;
  /** 돌린 파일을 놓쳐 읽지 못한 구간이 있었던 횟수(진단용). */
  gaps = 0;
  constructor(private readonly eventsDir: string, readonly memberId: string, private readonly parse: (line: string) => T | null, private readonly maxBytes = 1024 * 1024, from?: HookEventsMark) {
    if (!MEMBER_RE.test(memberId)) throw new Error("Invalid member id for hook events");
    // 그 자리의 파일이 .1 로 돌았으면 read() 가 .1 의 그 자리부터 마저 읽는다. 그때 파일이 없었으면 지금 파일을 처음부터 읽는다.
    if (from?.identity) this.cursor = { identity: from.identity, offset: from.offset };
  }
  read(): { records: T[]; invalid: number } {
    const records: T[] = [];
    let invalid = 0;
    const current = readFrom(hookEventsFile(this.eventsDir, this.memberId), this.cursor, this.maxBytes, this.parse);
    if (this.cursor && (!current || current.identity !== this.cursor.identity)) {
      // 읽던 파일이 .1 로 돌아갔다. 같은 파일이면 남은 부분을 마저 읽는다.
      const rotated = readFrom(hookEventsFile(this.eventsDir, this.memberId, true), this.cursor, this.maxBytes, this.parse);
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

/** Claude 훅 기록(run/events)의 읽기. 줄은 parseHookEventLine 으로 푼다. */
export class HookEventReader extends HookFileReader<HookEventRecord> {
  constructor(eventsDir: string, memberId: string, maxBytes = 1024 * 1024, from?: HookEventsMark) {
    super(eventsDir, memberId, parseHookEventLine, maxBytes, from);
  }
}

/**
 * 압축 끝을 알리는 훅 기록인가(CoreRunner 가 압축 완료의 근거로 쓴다). 그 세션에서, since(서버가 압축 명령을 넣기 직전에 적은 시각, 같은 Mac 의 시계)
 * 뒤이고 until 을 넘지 않는 시각의 PostCompact(trigger=manual: 서버가 넣는 `/compact` 는 CLI 에게 수동 압축이다) 또는 SessionStart(source=compact).
 * 앞선 압축(since 전), 다른 세션·세션 ID 없는 기록, PostCompact 의 trigger=auto 는 아니다.
 * SessionStart(source=compact)는 trigger 를 싣지 않아 CLI 스스로의 자동 압축 뒤에도 똑같이 온다. 그래서 그 압축이 서버가 넣은 것인지 CLI 가
 * 스스로 한 것인지는 구별하지 않는다(세션 기록의 경계도 기준선 뒤의 어느 경계로나 닫는 것과 같다). 압축은 실제로 끝났고, 서버가 준 초점이
 * 쓰이지 않았을 수 있을 뿐이다.
 * 줄이 적은 시각은 그 줄을 쓴 프로세스가 정한다. 언제 덧붙었는지는 부르는 쪽이 사건 파일의 자리(HookEventsMark)로 묶는다.
 */
export function isCompactEndHook(record: HookEventRecord, sessionId: string, since: number, until = Number.POSITIVE_INFINITY): boolean {
  if (!sessionId || record.sessionId !== sessionId || !(record.at >= since) || !(record.at <= until)) return false;
  return (record.event === "PostCompact" && record.trigger === "manual") || (record.event === "SessionStart" && record.source === "compact");
}

/**
 * 판정 근거로 읽어도 되는 사건 파일인가: run 폴더·사건 폴더·그 팀장의 파일이 링크가 아니고 이 사용자의 것이며 그룹·다른 사용자가 쓸 수 없다.
 * 훅 기록에는 서명이 없다. 이 사용자로 도는 프로세스(그 팀장의 CLI 자신 포함)는 쓸 수 있다. 압축 끝 훅은 압축을 넣기 직전의 자리 뒤에
 * 덧붙은 줄에서만 찾으므로(HookEventsMark), 미리 넣어 둔 줄(앞으로의 시각을 적은 것 포함)로는 닫히지 않는다. 세션 기록(JSONL)의 경계와 같은 신뢰 수준이다.
 * 비교 기록(HookShadow)은 이것을 보지 않는다(판정에 쓰지 않으므로).
 */
export function hookEventsTrusted(eventsDir: string, memberId: string): boolean {
  if (!MEMBER_RE.test(memberId)) return false;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  try {
    for (const path of [dirname(eventsDir), eventsDir, hookEventsFile(eventsDir, memberId)]) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o022) !== 0) return false;
    }
    return true;
  } catch { return false; }
}
