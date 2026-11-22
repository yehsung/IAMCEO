// Gemini(Antigravity CLI, `agy`) 팀장의 훅: 세션 시작·모델 호출 직전·턴 끝을 CLI 가 직접 파일에 남기게 한다.
//
// agy 는 훅을 설정 파일(--settings)로 받지 않는다. 띄울 때 --add-dir 로 넘기는 주입 폴더의 `.agents/hooks.json` 에 둔다(providers.ts).
// 훅 명령은 `sh -c` 로 돌고, 표준 입력에 JSON(camelCase)을 받고, 표준 출력에 JSON 을 내야 한다. 훅이 도는 동안 에이전트가 기다린다.
//
// 지키는 것
// - 표준 출력은 언제나 `{}` 다(아무것도 바꾸지 않는다는 답). 기록 스크립트가 실패하거나 실행 파일이 사라져도 셸이 `{}` 를 찍고 0 으로 끝낸다.
// - 스크립트는 0.5초 안에 스스로 끝낸다(SAFETY_MS). 기록을 못 남겨도 에이전트를 붙잡지 않는다.
// - 글 본문은 남기지 않는다. 받은 글에서는 IAMCEO 전달 표지(#iamceo_…)와 글자 수만 남긴다(Claude 훅 기록과 같다, hooks.ts).
// - Claude 훅 기록(run/events)과 파일을 섞지 않는다: 그쪽 읽기는 자기 다섯 사건 밖의 줄을 못 읽은 줄로 세고, Stop 줄을 Claude 턴 끝의 근거로 읽는다.
//   그래서 폴더를 따로 둔다(run/gemini-events). 파일 이름·돌리기·자리(HookEventsMark)는 같아 같은 읽기(HookFileReader)를 쓴다.
//
// 이 기록의 쓰임은 둘이다. 턴의 시작·끝 판정은 지금처럼 OSC 상태 보고로만 한다.
// - 모델 호출 직전(PreInvocation)의 lastUserInput 에 든 전달 표지가 '그 글이 CLI 에 들어갔다'는 수신 증거다(readGeminiDeliveryEvidence).
// - 그 줄의 conversationId 가 대화 id 의 둘째 근거다(readGeminiHookConversation): 상태줄 기록에서 id 를 얻지 못했을 때, 서버가 그 터미널에 넣은
//   전달 묶음의 표지가 든 줄만 그 터미널의 대화로 묶는다. 훅 입력의 conversationId 는 실제 agy(1.5.14)로 확인했다.
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { DeliveryEvidence } from "../../shared/types.ts";
import { bunScriptCommand, shellQuote as quote } from "./bun-script.ts";
import { HookFileReader, hookEventsTrusted, isHookEventsMark } from "./hook-events.ts";
import { hookEventsFile } from "./hooks.ts";

export const GEMINI_HOOK_RECORDER_MARKER = "iamceo-gemini-hook-recorder";
/** hooks.json 안에서 이 훅 묶음의 이름. */
export const GEMINI_HOOKS_NAME = "iamceo";
export const GEMINI_HOOK_EVENTS = ["SessionStart", "PreInvocation", "Stop"] as const;
export type GeminiHookEventName = (typeof GEMINI_HOOK_EVENTS)[number];
/** agy 가 훅을 기다리는 최대 시간(초, 문서: 기본 30). 스크립트는 그 전에 스스로 끝난다. */
export const GEMINI_HOOK_TIMEOUT_SEC = 5;
/** 팀장 한 명의 사건 파일 상한. 넘으면 <팀장>.1.jsonl 로 돌린다. */
export const GEMINI_HOOK_EVENTS_MAX_BYTES = 1024 * 1024;
const SAFETY_MS = 400;
/** 입력이 이보다 크면 앞부분과 끝부분만 본다(전달 묶음 표지는 글 끝에 있다). */
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const MEMBER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MARKER_RE = /^#iamceo_(?:b_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{22})$/;
const ITEM_MARKER_RE = /^#iamceo_[A-Za-z0-9_-]{22}$/;
const BUNDLE_MARKER_RE = /^#iamceo_b_[A-Za-z0-9_-]{22}$/;

/** $IAMCEO_HOME/run/gemini-events (Claude 의 run/events 옆). */
export function geminiHookEventsDir(home: string): string { return join(home, "run", "gemini-events"); }

/** 독립 JS: 소스·컴파일 실행 모두 같은 파일을 Bun 으로 실행한다(hooks.ts 의 기록 스크립트와 같은 방식). 표준 출력에는 아무것도 쓰지 않는다(`{}` 는 셸이 찍는다). */
const SCRIPT = String.raw`
import { closeSync, constants, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
const finish = () => { try { process.exit(0); } catch {} };
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE']) { try { process.on(signal, finish); } catch {} }
const deadline = setTimeout(finish, SAFETY_MS);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// 낱말 경계는 delivery-evidence.ts 의 hasExactMarker 와 같다. 잘린 입력은 JSON 이스케이프(\n 등) 때문에 앞 경계를 보지 않는다.
const MARKER = /(?<![\p{L}\p{N}\p{M}_#\-])#iamceo_(?:b_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{22})(?![\p{L}\p{N}\p{M}_#\-])/gu;
const RAW_MARKER = /#iamceo_(?:b_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/g;
const EVENTS = EVENT_NAMES;
function write(dir, member, line) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, member + '.jsonl');
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
  const bytes = Buffer.from(line, 'utf8');
  let fd = openSync(path, flags, 0o600);
  try {
    if (fstatSync(fd).size + bytes.length > MAX_FILE_BYTES) {
      closeSync(fd); fd = -1;
      try { renameSync(path, join(dir, member + '.1.jsonl')); } catch {}
      fd = openSync(path, flags, 0o600);
    }
    writeSync(fd, bytes);
  } finally { if (fd >= 0) { try { closeSync(fd); } catch {} } }
}
try {
  const dir = process.argv[2], member = process.argv[3];
  if (typeof dir === 'string' && dir.startsWith('/') && ID.test(member ?? '')) {
    const head = [];
    let headBytes = 0, tail = Buffer.alloc(0), truncated = false;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      if (!truncated && headBytes + bytes.length <= MAX_INPUT) { head.push(bytes); headBytes += bytes.length; continue; }
      truncated = true;
      tail = Buffer.concat([tail, bytes]);
      if (tail.length > TAIL) tail = tail.subarray(tail.length - TAIL);
    }
    const text = Buffer.concat(head).toString('utf8');
    let input = null;
    if (!truncated) { try { input = JSON.parse(text); } catch {} }
    if (input !== null && (typeof input !== 'object' || Array.isArray(input))) input = null;
    const raw = (name) => { const m = new RegExp('"' + name + '"\\s*:\\s*"([A-Za-z0-9_-]{1,128})"').exec(text); return m ? m[1] : undefined; };
    const event = input ? input.hookEventName : raw('hookEventName');
    if (typeof event === 'string' && EVENTS.includes(event)) {
      const id = input ? input.conversationId : raw('conversationId');
      const record = { v: 1, cli: 'gemini', at: Date.now(), event, conversationId: typeof id === 'string' && ID.test(id) ? id : null };
      if (event === 'PreInvocation') {
        const number = input ? input.invocationNum : null;
        record.invocation = Number.isSafeInteger(number) && number >= 0 ? number : null;
        const prompt = input && typeof input.lastUserInput === 'string' ? input.lastUserInput : null;
        const found = prompt !== null ? prompt.match(MARKER) : (text + tail.toString('utf8')).match(RAW_MARKER);
        record.markers = [...new Set(found ?? [])].slice(0, 64);
        record.chars = prompt !== null ? prompt.length : null;
        if (truncated || prompt === null) record.truncated = true;
      }
      if (event === 'Stop') {
        const reason = input ? input.terminationReason : raw('terminationReason');
        record.reason = typeof reason === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(reason) ? reason : 'other';
        record.fullyIdle = input && typeof input.fullyIdle === 'boolean' ? input.fullyIdle : null;
        // 오류 글은 남기지 않는다. 있었는지만 남긴다.
        record.failed = !!(input && typeof input.error === 'string' && input.error.length > 0);
      }
      write(dir, member, JSON.stringify(record) + '\n');
    }
  }
} catch {}
clearTimeout(deadline);
finish();
`;

export interface GeminiHookRecorderOptions {
  execPath?: string;
  /** 시험에서만 바꾼다. */
  safetyTimeoutMs?: number;
  maxFileBytes?: number;
}

/** run/iamceo-gemini-hook-recorder.mjs 를 쓴다(내용이 같으면 다시 쓰지 않는다). 스크립트 경로를 돌려준다. */
export function writeGeminiHookRecorder(runDir: string, options: GeminiHookRecorderOptions = {}): string {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, `${GEMINI_HOOK_RECORDER_MARKER}.mjs`);
  const safety = options.safetyTimeoutMs ?? SAFETY_MS;
  const maxFile = options.maxFileBytes ?? GEMINI_HOOK_EVENTS_MAX_BYTES;
  if (!Number.isSafeInteger(safety) || safety <= 0 || !Number.isSafeInteger(maxFile) || maxFile <= 0) throw new Error("Invalid gemini hook recorder limits");
  const content = `const SAFETY_MS = ${safety};\nconst MAX_FILE_BYTES = ${maxFile};\nconst MAX_INPUT = ${MAX_INPUT_BYTES};\nconst TAIL = ${TAIL_BYTES};\nconst EVENT_NAMES = ${JSON.stringify(GEMINI_HOOK_EVENTS)};\n${SCRIPT}`;
  let same = false;
  try { same = readFileSync(path, "utf8") === content; } catch { /* 처음 */ }
  if (!same) {
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try { writeFileSync(tmp, content, { mode: 0o600 }); renameSync(tmp, path); }
    finally { try { unlinkSync(tmp); } catch { /* rename 성공 */ } }
  }
  chmodSync(path, 0o600);
  return path;
}

export interface GeminiHooksInput {
  memberId: string;
  /** $IAMCEO_HOME/run/gemini-events. 기록 스크립트는 그 위 폴더(run/)에 둔다. */
  eventsDir: string;
  recorder?: GeminiHookRecorderOptions;
}

// ---- hooks.json 모으기 ----
// 주입 폴더의 hooks.json 은 여러 장치의 처리기를 한 묶음("iamceo")에 모은 것이다: 사건 기록(아래 geminiRecorderHookSet), 도구 호출 직전 판정
// (gemini-tool-hook.ts: 작업 폴더·서브에이전트 단계·결재함 승인). 장치마다 GeminiHookSet 을 만들고 geminiHooksFile 이 사건별로 잇는다.
// 새 장치(예: 턴 끝 기록을 더 남기는 Stop 처리기)는 자기 GeminiHookSet 을 만들어 providers.ts 의 geminiHooksFile(...) 인자에 더하면 된다.
// 같은 사건에 처리기가 여럿이면 agy 는 적힌 차례로 돈다(문서). PreToolUse·PostToolUse 는 matcher 묶음, 나머지는 처리기 목록이다(agy 의 모양 그대로).

/** 처리기 하나. agy 는 `sh -c <command>` 로 돌리고 timeout 초가 지나면 끊는다(SIGKILL, 1.5.14 실측: PreToolUse 면 그 도구가 막힌다). */
export interface GeminiHookHandler { type: "command"; command: string; timeout: number }
/** PreToolUse·PostToolUse 의 묶음: matcher(도구 이름 정규식)에 맞는 호출에만 처리기를 돌린다. */
export interface GeminiHookToolGroup { matcher: string; hooks: GeminiHookHandler[] }
/** 한 장치의 처리기들. 사건 이름은 agy 의 것 그대로다. */
export interface GeminiHookSet {
  SessionStart?: GeminiHookHandler[];
  PreInvocation?: GeminiHookHandler[];
  PostInvocation?: GeminiHookHandler[];
  Stop?: GeminiHookHandler[];
  PreToolUse?: GeminiHookToolGroup[];
  PostToolUse?: GeminiHookToolGroup[];
}
const HOOK_SET_EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "Stop", "PreToolUse", "PostToolUse"] as const;

/**
 * 여러 장치의 처리기를 사건별로 이어 hooks.json 값 `{ "iamceo": { <사건>: [...] } }` 을 만든다. 인자의 차례가 같은 사건 안의 차례다.
 * null·빈 장치는 건너뛴다. 처리기가 하나도 없으면 null 이다(부르는 쪽은 hooks.json 을 두지 않는다).
 */
export function geminiHooksFile(...sets: (GeminiHookSet | null | undefined)[]): Record<string, unknown> | null {
  const merged: Record<string, unknown[]> = {};
  for (const set of sets) {
    if (!set) continue;
    for (const event of HOOK_SET_EVENTS) {
      const handlers = set[event] as unknown[] | undefined;
      if (handlers?.length) (merged[event] ??= []).push(...handlers);
    }
  }
  return Object.keys(merged).length ? { [GEMINI_HOOKS_NAME]: merged } : null;
}

/**
 * 사건 기록 장치의 처리기: SessionStart·PreInvocation·Stop 에 같은 명령이다(사건 이름은 입력의 hookEventName 으로 가른다):
 * `{ cd <run> && BUN_BE_BUN=1 <실행 파일> --config=<빈 설정> --no-env-file <스크립트> <사건 폴더> <팀장>; } >/dev/null 2>&1; printf '{}'; exit 0`
 * 팀장의 작업 폴더에 있는 bunfig.toml(preload)·.env 를 읽지 않는다(bun-script.ts). 표준 출력의 `{}` 는 셸이 찍으므로 스크립트가 돌지 못해도 나온다.
 * (이 `{}` 꼴은 판정이 없는 사건에만 쓴다. PreToolUse 에 `{}` 를 내면 agy 가 도구를 막는다: gemini-tool-hook.ts.)
 * 잘못된 팀장 ID·상대 경로면 던진다. 부르는 쪽(providers.ts)은 던지면 기록 훅 없이 CLI 를 띄운다.
 */
export function geminiRecorderHookSet(input: GeminiHooksInput): GeminiHookSet {
  if (!MEMBER_ID_RE.test(input.memberId)) throw new Error("Invalid member id for gemini hook events");
  if (!isAbsolute(input.eventsDir)) throw new Error("Gemini hook events directory must be absolute");
  const runDir = dirname(input.eventsDir);
  const script = writeGeminiHookRecorder(runDir, input.recorder);
  const run = `${bunScriptCommand(input.recorder?.execPath ?? process.execPath, runDir, script)} ${quote(input.eventsDir)} ${quote(input.memberId)}`;
  const command = `{ cd ${quote(runDir)} && ${run}; } >/dev/null 2>&1; printf '{}'; exit 0`;
  const handler: GeminiHookHandler = { type: "command", command, timeout: GEMINI_HOOK_TIMEOUT_SEC };
  return Object.fromEntries(GEMINI_HOOK_EVENTS.map(name => [name, [handler]])) as GeminiHookSet;
}

/** 사건 기록 장치만 실은 hooks.json 값: `{ "iamceo": { "SessionStart": [...], "PreInvocation": [...], "Stop": [...] } }`. */
export function geminiHooksConfig(input: GeminiHooksInput): Record<string, unknown> {
  return geminiHooksFile(geminiRecorderHookSet(input))!;
}

export interface GeminiHookRecord {
  at: number;
  event: GeminiHookEventName;
  conversationId: string | null;
  /** PreInvocation: 그 턴에서 몇 번째 모델 호출인가(0 부터). */
  invocation?: number | null;
  /** PreInvocation: 마지막 사용자 글(lastUserInput) 안의 IAMCEO 전달 표지. 글 본문은 없다. */
  markers?: string[];
  chars?: number | null;
  truncated?: boolean;
  /** Stop: terminationReason(NO_TOOL_CALL=정상, ERROR, USER_CANCELED, MAX_INVOCATIONS …). 모르는 모양이면 other. */
  reason?: string;
  fullyIdle?: boolean | null;
  /** Stop: 오류 글이 있었다. 글은 남기지 않는다. */
  failed?: boolean;
}

/** 한 줄을 엄격하게 푼다. 모르는 모양이면 null. */
export function parseGeminiHookLine(line: string): GeminiHookRecord | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || r.cli !== "gemini" || typeof r.at !== "number" || !Number.isFinite(r.at) || r.at <= 0) return null;
  if (typeof r.event !== "string" || !(GEMINI_HOOK_EVENTS as readonly string[]).includes(r.event)) return null;
  const out: GeminiHookRecord = { at: r.at, event: r.event as GeminiHookEventName, conversationId: typeof r.conversationId === "string" && SESSION_RE.test(r.conversationId) ? r.conversationId : null };
  if (out.event === "PreInvocation") {
    out.invocation = typeof r.invocation === "number" && Number.isSafeInteger(r.invocation) && r.invocation >= 0 ? r.invocation : null;
    out.markers = Array.isArray(r.markers) ? r.markers.filter((m): m is string => typeof m === "string" && MARKER_RE.test(m)).slice(0, 64) : [];
    out.chars = typeof r.chars === "number" && Number.isSafeInteger(r.chars) && r.chars >= 0 ? r.chars : null;
    if (r.truncated === true) out.truncated = true;
  }
  if (out.event === "Stop") {
    out.reason = typeof r.reason === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(r.reason) ? r.reason : "other";
    out.fullyIdle = typeof r.fullyIdle === "boolean" ? r.fullyIdle : null;
    out.failed = r.failed === true;
  }
  return out;
}

export interface GeminiDeliveryEvidenceOptions {
  /** 훅을 넣지 않는 환경이면 null. */
  eventsDir: string | null;
  memberId: string;
  markers: { deliveryId: string; marker: string }[];
  bundleMarker?: string;
  /** 봉투를 쓰기 직전의 사건 파일 자리(DeliveryBaseline.hookMark). 없거나 모양이 다르면 근거로 쓰지 않는다. */
  mark: unknown;
}
export interface GeminiDeliveryEvidence { evidence: DeliveryEvidence; receivedDeliveryIds: string[] }

/**
 * 전달 수신 증거. 봉투를 쓰기 직전의 자리 뒤에 덧붙은 PreInvocation 기록에 그 전달의 표지(묶음 표지면 묶음 전부)가 있으면 받은 것이다.
 * 그 팀장의 파일, 자리 뒤의 줄, 22자 임의 표지가 글자까지 같아야 하므로 다른 글과 섞이지 않는다.
 * 표지가 없다는 것은 '안 받았다'는 근거가 아니다(훅이 돌지 않았을 수 있다): 그때는 unknown 이다. absent 는 내지 않는다.
 * 읽지 못하는 경우(훅을 넣지 않음, 자리 없음, 파일 없음, 폴더·파일이 이 사용자 것이 아니거나 남이 쓸 수 있음)도 unknown 이다.
 */
export function readGeminiDeliveryEvidence(options: GeminiDeliveryEvidenceOptions): GeminiDeliveryEvidence {
  const result = (verdict: DeliveryEvidence["verdict"], code: string, received: string[] = []): GeminiDeliveryEvidence => ({
    evidence: { source: "gemini_log", verdict, location: verdict === "present" ? "received_input" : "none", code, complete: false, checkedAt: new Date().toISOString() },
    receivedDeliveryIds: received,
  });
  const { markers, bundleMarker, eventsDir, memberId, mark } = options;
  if (markers.some(({ marker }) => !ITEM_MARKER_RE.test(marker)) || new Set(markers.map(({ marker }) => marker)).size !== markers.length ||
    new Set(markers.map(({ deliveryId }) => deliveryId)).size !== markers.length || (bundleMarker !== undefined && !BUNDLE_MARKER_RE.test(bundleMarker))) return result("unknown", "invalid_marker");
  if (!eventsDir) return result("unknown", "hooks_off");
  if (!MEMBER_ID_RE.test(memberId)) return result("unknown", "invalid_member");
  if (!isHookEventsMark(mark)) return result("unknown", "no_baseline");
  try { lstatSync(hookEventsFile(eventsDir, memberId)); }
  catch (error) { return result("unknown", (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "hook_log_missing" : "hook_log_unreadable"); }
  if (!hookEventsTrusted(eventsDir, memberId)) return result("unknown", "hook_log_untrusted");
  const received = new Set<string>();
  let gaps = 0;
  try {
    const reader = new HookFileReader(eventsDir, memberId, parseGeminiHookLine, undefined, mark);
    // 파일 상한이 1 MiB 라 돌린 파일까지 두세 번이면 끝까지 읽는다.
    for (let pass = 0; pass < 8; pass++) {
      const { records, invalid } = reader.read();
      for (const record of records) {
        if (record.event !== "PreInvocation" || !record.markers?.length) continue;
        const bundle = bundleMarker !== undefined && record.markers.includes(bundleMarker);
        for (const { deliveryId, marker } of markers) if (bundle || record.markers.includes(marker)) received.add(deliveryId);
      }
      if (!records.length && !invalid) break;
    }
    gaps = reader.gaps;
  } catch { return result("unknown", "hook_log_unreadable"); }
  if (received.size) return result("present", "marker_in_user_input", [...received]);
  return result("unknown", gaps ? "hook_log_rotated" : "marker_not_in_hook_log");
}

/** 대화 id 의 근거가 될 수 있는 줄 하나: 대화 id 가 있고 전달 묶음의 표지가 든 PreInvocation. */
interface GeminiHookConversationLine { at: number; conversationId: string; bundles: string[] }
/** readGeminiHookConversation 의 읽기 자리(터미널마다 하나). 사건 파일을 앞으로만 읽고, 근거가 될 수 있는 줄을 최근 것부터 64개까지 기억한다. */
export interface GeminiHookConversationWatch { reader: HookFileReader<GeminiHookRecord>; lines: GeminiHookConversationLine[] }
const CONVERSATION_LINES_MAX = 64;

export interface GeminiHookConversationQuery {
  /** 훅을 넣지 않는 환경이면 null. */
  eventsDir: string | null;
  memberId: string;
  /**
   * 이 시각(ms)까지 적힌 줄은 보지 않는다. 부르는 쪽은 이 터미널을 띄운 시각을 준다(그때까지의 줄은 그 팀장의 예전 터미널이 남긴 것이다).
   * 이미 아는 대화 id 가 있으면 그 id 의 근거가 적힌 시각을 준다(더 앞선 줄이 나중에 안 id 를 되돌리지 않게).
   */
  since: number;
  /** 서버가 이 터미널에 넣은(넣으려 한) 전달 묶음의 표지(#iamceo_b_…). 봉투마다 새로 만드는 값이라 다른 터미널에 들어간 적이 없다. */
  bundleMarkers: Iterable<string>;
}

/**
 * 훅 기록에서 이 터미널의 대화 id 를 찾는다. 상태줄 기록이 id 를 주지 못할 때의 둘째 근거다(CoreRunner.discoverGeminiSession).
 * 그 팀장의 사건 파일에서, 이 터미널을 띄운 뒤에 적혔고, 서버가 이 터미널에 넣은 전달 묶음의 표지가 글자까지 같게 든 PreInvocation 줄만 본다.
 * 그런 줄이 여럿이면 가장 나중 것의 conversationId 와 그 줄이 적힌 시각(at)이다(터미널 안에서 대화를 새로 열면 id 가 바뀐다). 없으면 둘 다 null.
 * - 표지가 없는 줄(사람이 터미널에서 직접 친 글, SessionStart·Stop)은 근거로 쓰지 않는다: 사건 파일은 팀장마다 하나라 방금 끝낸 예전 터미널의 줄과
 *   섞일 수 있다. 묶음 표지는 봉투마다 새로 만드는 22자 임의 값이고 봉투는 한 터미널에만 쓰이므로, 그 표지가 든 줄은 그 터미널의 agy 가 남긴 것이다.
 *   낱개 전달의 표지(#iamceo_…)는 다시 보낼 때 그대로 쓰여 다른 터미널에도 들어갔을 수 있어 견주지 않는다.
 * - 사건 폴더·파일이 이 사용자 것이 아니거나 남이 쓸 수 있으면 읽지 않는다(hookEventsTrusted).
 * 읽기만 한다. 던지지 않는다. watch 는 다음 부름에 그대로 넘긴다(읽던 자리부터 잇는다).
 */
export function readGeminiHookConversation(query: GeminiHookConversationQuery, previous: GeminiHookConversationWatch | null = null): { conversationId: string | null; at: number | null; watch: GeminiHookConversationWatch | null } {
  const none = { conversationId: null, at: null, watch: previous };
  const { eventsDir, memberId, since } = query;
  if (!eventsDir || !MEMBER_ID_RE.test(memberId) || !Number.isFinite(since)) return none;
  const wanted = new Set([...query.bundleMarkers].filter(marker => BUNDLE_MARKER_RE.test(marker)));
  // 넣은 것이 없으면 찾을 줄도 없다. 읽지 않는다(표지가 생긴 뒤의 첫 부름이 파일을 처음부터 읽는다).
  if (!wanted.size || !hookEventsTrusted(eventsDir, memberId)) return none;
  let watch = previous;
  try {
    watch ??= { reader: new HookFileReader(eventsDir, memberId, parseGeminiHookLine), lines: [] };
    // 파일 상한이 1 MiB 라 돌린 파일까지 두세 번이면 끝까지 읽는다.
    for (let pass = 0; pass < 8; pass++) {
      const { records, invalid } = watch.reader.read();
      for (const record of records) {
        if (record.event !== "PreInvocation" || !record.conversationId) continue;
        const bundles = (record.markers ?? []).filter(marker => BUNDLE_MARKER_RE.test(marker));
        if (bundles.length) watch.lines.push({ at: record.at, conversationId: record.conversationId, bundles });
      }
      if (!records.length && !invalid) break;
    }
    if (watch.lines.length > CONVERSATION_LINES_MAX) watch.lines.splice(0, watch.lines.length - CONVERSATION_LINES_MAX);
  } catch { return { conversationId: null, at: null, watch: null }; }
  // 줄은 덧붙은 차례로 쌓인다: 뒤에서부터 본다.
  const line = watch.lines.findLast(item => item.at > since && item.bundles.some(marker => wanted.has(marker)));
  return { conversationId: line?.conversationId ?? null, at: line?.at ?? null, watch };
}

/**
 * 이 팀장의 훅 사건 파일(돌린 파일 포함)에 마지막으로 줄이 덧붙은 때(ms, 파일의 수정 시각). 줄이 하나도 없으면(파일이 없거나 비었다) null,
 * 볼 수 없으면(링크, 보통 파일이 아님, 읽기 오류) "unknown" 이다. 줄을 풀지 않고 크기와 수정 시각만 본다.
 * 서버를 다시 켠 뒤 사라진 터미널에 대화가 있었을 수 있는지 가릴 때 쓴다(CoreRunner 의 geminiGoneMayHaveConversed).
 */
export function geminiHookLastWrite(eventsDir: string, memberId: string): number | null | "unknown" {
  if (!isAbsolute(eventsDir) || !MEMBER_ID_RE.test(memberId)) return "unknown";
  let last: number | null = null;
  for (const rotated of [false, true]) {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(hookEventsFile(eventsDir, memberId, rotated)); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue; return "unknown"; }
    if (!stat.isFile()) return "unknown";
    if (stat.size > 0) last = Math.max(last ?? 0, stat.mtimeMs);
  }
  return last;
}
