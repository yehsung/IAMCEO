// Gemini(Antigravity CLI, `agy`) 팀장의 상태줄 래퍼. agy 는 상태가 바뀔 때마다(300ms 에 한 번까지) 이 명령을 `sh -c` 로 돌리고
// 표준 입력에 JSON 을 준다. 래퍼는 그 JSON 을 기록 모양(gemini-status.ts 의 GeminiStatusRecord)으로 바꿔
// <contextHome>/context/gemini/<팀장>.json 에 쓰고(임시 파일 → rename), 표준 출력에 상태줄 한 줄을 낸다.
//
// 지키는 것
// - 어떤 경우에도 0 으로 끝나고 한 줄을 낸다(최소 `IAMCEO`). agy 는 실패가 30번 이어지면 그 세션의 상태줄을 꺼 버린다.
//   실행 파일이 사라져 스크립트가 돌지 못해도 셸이 `IAMCEO` 를 찍고 0 으로 끝낸다.
// - 낸 줄은 고정 모양이다: `IAMCEO · <모델 이름> · ctx <N>%` (값이 없는 칸은 뺀다). 입력칸 판독기(gemini-screen.ts)가 이 줄을 바닥줄로 알아본다.
// - 전역 설정(~/.gemini)은 건드리지 않는다. 이 명령은 띄울 때의 --settings 에만 싣는다(providers.ts).
// - 계정 메일은 쓰지 않는다(기록 모양에 없다).
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { bunScriptCommand, shellQuote as quote } from "./bun-script.ts";
import { geminiStatusFromPayload } from "./gemini-status.ts";

export const GEMINI_STATUSLINE_MARKER = "iamceo-gemini-statusline";
/** agy 가 상태줄 명령을 끊는 시간은 5초다. 스크립트는 그 전에 스스로 끝낸다. */
const SAFETY_MS = 1500;
/** 입력이 이보다 크면 읽지 않는다(기록을 쓰지 않고 `IAMCEO` 만 낸다). 실제 입력은 수 KB 다. */
const MAX_INPUT_BYTES = 1024 * 1024;
const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** 띄우기 값의 모양(gemini-status.ts 의 LAUNCH 와 같다). 명령의 인자로 실리므로 따옴표 없이도 한 낱말인 글자만 받는다. */
const LAUNCH = /^[A-Za-z0-9_-]{1,64}$/;

/** 독립 JS: 소스·컴파일 실행 모두 같은 파일을 Bun 으로 실행한다(statusline.ts 와 같은 방식). fromPayload 는 서버의 함수 글 그대로다. */
const SCRIPT = String.raw`
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
let line = 'IAMCEO';
let finished = false;
// 어떤 경우에도 한 줄을 내고 0 으로 끝낸다.
const finish = () => {
  if (finished) return;
  finished = true;
  try { writeSync(1, line + '\n'); } catch {}
  try { process.exit(0); } catch {}
};
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE']) { try { process.on(signal, finish); } catch {} }
const deadline = setTimeout(finish, SAFETY_MS);
// 화면에 그릴 글: 한 줄, 제어 문자 없음, 길이 제한.
const label = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f  ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
try {
  const home = process.argv[2];
  const member = process.argv[3] || process.env.IAMCEO_MEMBER_ID || '';
  // 이 터미널을 띄울 때 서버가 정한 값. 기록에 그대로 적어, 서버가 다른 터미널(방금 끝낸 예전 것)의 기록과 가르게 한다. 없으면 null 로 적힌다.
  const launch = process.argv[4] || null;
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT) break;
    chunks.push(bytes);
  }
  let input = null;
  if (size <= MAX_INPUT) { try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} }
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const model = input.model !== null && typeof input.model === 'object' ? label(input.model.display_name, 60) || label(input.model.id, 60) : '';
    const used = input.context_window !== null && typeof input.context_window === 'object' ? input.context_window.used_percentage : null;
    const parts = ['IAMCEO'];
    if (model) parts.push(model);
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100) parts.push('ctx ' + Math.round(used) + '%');
    line = parts.join(' · ');
    if (typeof home === 'string' && home.startsWith('/') && MEMBER_ID.test(member)) {
      const record = fromPayload(member, input, new Date(), launch);
      const dir = join(home, 'context', 'gemini');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { chmodSync(dir, 0o700); } catch {}
      const tmp = join(dir, member + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp');
      try { writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 }); renameSync(tmp, join(dir, member + '.json')); }
      finally { try { unlinkSync(tmp); } catch {} }
    }
  }
} catch {}
clearTimeout(deadline);
finish();
`;

export interface GeminiStatuslineOptions {
  execPath?: string;
  /** 시험에서만 줄인다. */
  safetyTimeoutMs?: number;
  /**
   * 이 터미널을 띄울 때 정한 임의 값(providers.ts 가 만들고 터미널 라벨 iamceo.launch 에도 싣는다). 명령의 셋째 인자로 실려 기록의 launch 칸에 적힌다.
   * 없으면 인자를 붙이지 않는다(기록의 launch 는 null). 모양이 다르면 던진다.
   */
  launch?: string;
}

let selfChecked: boolean | null = null;
/**
 * 기록 모양을 만드는 함수의 글(toString())이 혼자서 도는가. 스크립트는 서버 밖에서 돌아 이 모듈을 불러오지 못하므로 함수 글을 그대로 넣는다.
 * 묶음·줄이기 과정에서 그 글이 바깥 이름을 쓰게 바뀌었으면 스크립트가 기록을 쓰지 못한다. 그때는 래퍼를 만들지 않는다(부르는 쪽이 상태줄 없이 띄운다).
 */
function standaloneWorks(): boolean {
  if (selfChecked !== null) return selfChecked;
  try {
    const now = new Date(0);
    const sample = { conversation_id: "self-check", model: { id: "m", effort: "low" }, context_window: { used_percentage: 12.5, context_window_size: 1000 }, quota: { q: { remaining_fraction: 0.5, reset_in_seconds: 60 } }, subagents: [{}, { status: "running" }, { status: "completed" }] };
    const standalone = new Function(`return (${geminiStatusFromPayload.toString()});`)() as typeof geminiStatusFromPayload;
    selfChecked = JSON.stringify(standalone("self_check", sample, now, "self-check-launch")) === JSON.stringify(geminiStatusFromPayload("self_check", sample, now, "self-check-launch"));
  } catch { selfChecked = false; }
  return selfChecked;
}

/** run/iamceo-gemini-statusline.mjs 를 쓴다(내용이 같으면 다시 쓰지 않는다). 스크립트 경로를 돌려준다. */
export function writeGeminiStatuslineScript(runDir: string, options: GeminiStatuslineOptions = {}): string {
  const safety = options.safetyTimeoutMs ?? SAFETY_MS;
  if (!Number.isSafeInteger(safety) || safety <= 0) throw new Error("Invalid gemini statusline safety timeout");
  if (!standaloneWorks()) throw new Error("gemini statusline: record function is not self-contained in this build");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, `${GEMINI_STATUSLINE_MARKER}.mjs`);
  const content = `const SAFETY_MS = ${safety};\nconst MAX_INPUT = ${MAX_INPUT_BYTES};\nconst MEMBER_ID = ${MEMBER_ID};\nconst fromPayload = ${geminiStatusFromPayload.toString()};\n${SCRIPT}`;
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

/**
 * agy 의 --settings `statusLine` 칸에 넣을 값. 명령은
 * `{ cd <run> && BUN_BE_BUN=1 <실행 파일> --config=<빈 설정> --no-env-file <스크립트> <contextHome> <팀장> [<띄우기 값>]; } 2>/dev/null || printf 'IAMCEO\n'; exit 0` 이다.
 * 팀장의 작업 폴더에 있는 bunfig.toml(preload)·.env 를 읽지 않는다(bun-script.ts). 팀장 id 는 인자로 싣는다(환경 변수 IAMCEO_MEMBER_ID 는 예비다).
 * 띄우기 값(options.launch)은 이 명령이 쓰는 기록마다 적힌다: 명령은 그 터미널의 agy 만 돌리므로, 그 값이 적힌 기록은 그 터미널이 쓴 것이다.
 * 스크립트가 돌지 못하면(실행 파일 없음) 셸이 `IAMCEO` 한 줄을 낸다. 상대 경로·잘못된 팀장 id·잘못된 띄우기 값이면 던진다(부르는 쪽이 상태줄 없이 띄운다).
 */
export function geminiStatusLine(contextHome: string, memberId: string, options: GeminiStatuslineOptions = {}): { type: "command"; command: string } {
  if (!isAbsolute(contextHome) || contextHome.includes("\0")) throw new Error("gemini statusline: contextHome must be an absolute path");
  if (!MEMBER_ID.test(memberId)) throw new Error("gemini statusline: invalid member id");
  if (options.launch !== undefined && !LAUNCH.test(options.launch)) throw new Error("gemini statusline: invalid launch value");
  const runDir = join(contextHome, "run");
  const script = writeGeminiStatuslineScript(runDir, options);
  const run = `${bunScriptCommand(options.execPath ?? process.execPath, runDir, script)} ${quote(contextHome)} ${quote(memberId)}${options.launch !== undefined ? ` ${quote(options.launch)}` : ""}`;
  return { type: "command", command: `{ cd ${quote(runDir)} && ${run}; } 2>/dev/null || printf 'IAMCEO\\n'; exit 0` };
}

/**
 * 상태줄 명령(geminiStatusLine 이 만든 것)에 실린 띄우기 값. 없거나 그 명령 모양이 아니면 null.
 * 시험의 가짜 agy 가 쓴다: 실제 래퍼처럼 명령의 인자에서 값을 얻어 기록에 적는다(터미널 라벨을 읽지 않는다. agy 는 라벨을 모른다).
 */
export function geminiStatusLineLaunch(command: string): string | null {
  const match = / '([A-Za-z0-9_-]{1,64})' '([A-Za-z0-9_-]{1,64})'; \} 2>\/dev\/null \|\| printf 'IAMCEO\\n'; exit 0$/.exec(command);
  return match ? match[2]! : null;
}
