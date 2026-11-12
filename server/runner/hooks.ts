// E1: Claude Code 의 공식 훅으로 CLI 가 직접 사건(입력 접수, 턴 끝, 오류 종류, 압축, 세션 시작)을 파일에 남기게 한다.
// 이번 단계는 '나란히 모으기'다. 서버의 판정은 지금 근거(OSC 상태 보고, 세션 기록, 화면) 그대로이고, 이 기록은 비교에만 쓴다(hook-compare.ts).
//
// 지키는 것
// - 전역 설정(~/.claude/settings.json 등)은 건드리지 않는다. 훅은 statusLine 과 같은 --settings 하나에 호출마다 넣는다(providers.ts).
// - 훅 스크립트는 어떤 경우에도 빨리 0 으로 끝나고 표준 출력에 아무것도 쓰지 않는다. UserPromptSubmit·SessionStart 의 표준 출력은
//   AI 의 문맥에 들어가고, 종료 코드 2 는 대표의 입력을 지운다. 실행 파일이 사라져도 셸이 0 으로 끝낸다(`; exit 0`).
// - 글 본문은 남기지 않는다. 입력에서는 IAMCEO 전달 표지(#iamceo_…)와 글자 수만, 오류는 분류값만 남긴다.
// - 팀장마다 파일 하나, 상한을 넘으면 .1 로 한 번 돌린다(팀장당 최대 약 2배 상한).
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const HOOK_RECORDER_MARKER = "iamceo-hook-recorder";
/** 나란히 모으는 다섯 사건. PermissionRequest 는 K(도구 승인)가 permissionHook 으로 따로 넣는다. */
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "PostCompact"] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];
/** 팀장 한 명의 사건 파일 상한. 넘으면 <팀장>.1.jsonl 로 돌린다. 한 줄은 수백 바이트라 수천 건이 들어간다. */
export const HOOK_EVENTS_MAX_BYTES = 1024 * 1024;
/** CLI 가 훅을 기다리는 최대 시간(초). 스크립트는 그 전에 스스로 끝난다(HOOK_SAFETY_MS). */
export const HOOK_TIMEOUT_SEC = 5;
const HOOK_SAFETY_MS = 2000;
/** 입력이 이보다 크면 앞부분과 끝부분만 본다(전달 묶음 표지는 글 끝에 있다). */
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const MEMBER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** 사건 폴더 안의 비교 결과 파일(숫자만). hook-compare.ts 가 쓰고 진단 파일이 옮긴다. */
export const HOOK_COMPARE_FILE = "compare.json";
/** $IAMCEO_HOME/run/events */
export function hookEventsDir(home: string): string { return join(home, "run", "events"); }
export function hookEventsFile(eventsDir: string, memberId: string, rotated = false): string {
  return join(eventsDir, `${memberId}${rotated ? ".1" : ""}.jsonl`);
}

/** 독립 JS: 소스·컴파일 실행 모두 같은 파일을 Bun 으로 실행한다(statusline.ts 와 같은 방식). */
const SCRIPT = String.raw`
import { closeSync, constants, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
// 어떤 경우에도 0 으로 끝낸다. 표준 출력·오류에는 아무것도 쓰지 않는다.
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
const oneOf = (value, list) => typeof value === 'string' && list.includes(value) ? value : 'other';
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
    const raw = (name) => { const m = new RegExp('"' + name + '"\\s*:\\s*"([A-Za-z0-9_-]{1,128})"').exec(text); return m ? m[1] : undefined; };
    const event = input ? input.hook_event_name : raw('hook_event_name');
    if (typeof event === 'string' && EVENTS.includes(event)) {
      const sid = input ? input.session_id : raw('session_id');
      const record = { v: 1, at: Date.now(), event, sessionId: typeof sid === 'string' && ID.test(sid) ? sid : null };
      if (event === 'SessionStart') record.source = oneOf(input ? input.source : raw('source'), ['startup', 'resume', 'clear', 'compact']);
      if (event === 'PostCompact') record.trigger = oneOf(input ? input.trigger : raw('trigger'), ['manual', 'auto']);
      if (event === 'StopFailure') {
        const error = input ? input.error : raw('error');
        record.error = typeof error === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(error) ? error : 'other';
      }
      if (event === 'UserPromptSubmit') {
        const prompt = input && typeof input.prompt === 'string' ? input.prompt : null;
        const found = prompt !== null ? prompt.match(MARKER) : (text + tail.toString('utf8')).match(RAW_MARKER);
        record.markers = [...new Set(found ?? [])].slice(0, 64);
        record.chars = prompt !== null ? prompt.length : null;
        if (truncated || prompt === null) record.truncated = true;
      }
      write(dir, member, JSON.stringify(record) + '\n');
    }
  }
} catch {}
clearTimeout(deadline);
finish();
`;

function quote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

export interface HookRecorderOptions {
  execPath?: string;
  /** 시험에서만 줄인다. */
  safetyTimeoutMs?: number;
  maxFileBytes?: number;
}

/** run/iamceo-hook-recorder.mjs 를 쓴다(내용이 같으면 다시 쓰지 않는다). 스크립트 경로를 돌려준다. */
export function writeHookRecorder(runDir: string, options: HookRecorderOptions = {}): string {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, `${HOOK_RECORDER_MARKER}.mjs`);
  const safety = options.safetyTimeoutMs ?? HOOK_SAFETY_MS;
  const maxFile = options.maxFileBytes ?? HOOK_EVENTS_MAX_BYTES;
  if (!Number.isSafeInteger(safety) || safety <= 0 || !Number.isSafeInteger(maxFile) || maxFile <= 0) throw new Error("Invalid hook recorder limits");
  const content = `const SAFETY_MS = ${safety};\nconst MAX_FILE_BYTES = ${maxFile};\nconst MAX_INPUT = ${MAX_INPUT_BYTES};\nconst TAIL = ${TAIL_BYTES};\nconst EVENT_NAMES = ${JSON.stringify(HOOK_EVENTS)};\n${SCRIPT}`;
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

export interface HookSettingsInput {
  memberId: string;
  /** $IAMCEO_HOME/run/events. 기록 스크립트는 그 위 폴더(run/)에 둔다. */
  eventsDir: string;
  /** K(도구 승인): PermissionRequest 훅. 있으면 같은 hooks 객체에 넣는다. 묻지 않기 팀장에게는 넘기지 않는다(K 가 정한다). */
  permissionHook?: { command: string; timeoutSec: number };
  /** false 면 다섯 사건 기록을 빼고 permissionHook 만 넣는다(IAMCEO_HOOK_EVENTS=0). 기본 true. */
  events?: boolean;
  recorder?: HookRecorderOptions;
}

/**
 * --settings 의 `hooks` 키에 넣을 값을 돌려준다(이벤트 이름 → 매처 묶음 배열). 매처는 두지 않아 모든 경우에 돈다.
 * 기록 훅의 명령은 `BUN_BE_BUN=1 <실행 파일> <스크립트> <사건 폴더> <팀장> >/dev/null 2>&1; exit 0` 이다.
 * 잘못된 팀장 ID·상대 경로면 던진다. 부르는 쪽(providers.ts)은 던지면 훅 없이 CLI 를 띄운다.
 */
export function hookSettings(input: HookSettingsInput): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  if (input.events !== false) {
    if (!MEMBER_ID_RE.test(input.memberId)) throw new Error("Invalid member id for hook events");
    if (!isAbsolute(input.eventsDir)) throw new Error("Hook events directory must be absolute");
    const script = writeHookRecorder(dirname(input.eventsDir), input.recorder);
    const command = `BUN_BE_BUN=1 ${quote(input.recorder?.execPath ?? process.execPath)} ${quote(script)} ${quote(input.eventsDir)} ${quote(input.memberId)} >/dev/null 2>&1; exit 0`;
    for (const name of HOOK_EVENTS) hooks[name] = [{ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SEC }] }];
  }
  if (input.permissionHook) {
    const { command, timeoutSec } = input.permissionHook;
    if (typeof command !== "string" || !command.trim() || !Number.isSafeInteger(timeoutSec) || timeoutSec <= 0) throw new Error("Invalid permission hook");
    hooks.PermissionRequest = [{ hooks: [{ type: "command", command, timeout: timeoutSec }] }];
  }
  return hooks;
}

/**
 * 이미 있는 hooks(사용자가 넘긴 설정 파일의 것)에 우리 것을 덧붙인다. 같은 사건이면 배열을 잇는다(덮지 않는다).
 * 모양이 이상한 기존 값은 그 사건만 우리 것으로 둔다.
 */
export function mergeHooks(base: unknown, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
  for (const [name, groups] of Object.entries(extra)) {
    const before = out[name];
    out[name] = Array.isArray(before) && Array.isArray(groups) ? [...before, ...groups] : groups;
  }
  return out;
}
