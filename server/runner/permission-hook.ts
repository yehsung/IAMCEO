// K(E2): Claude Code 의 PermissionRequest 훅. 팀장이 도구 승인 창 앞에 서면 이 Mac 의 서버에 요청을 올리고 대표의 답을 기다린다.
//
// 지키는 것
// - 어떤 경우에도 0 으로 끝난다. 답(허용·거절)을 받았을 때만 표준 출력에 훅 답(JSON)을 쓰고, 그 밖에는 아무것도 쓰지 않는다.
//   아무것도 쓰지 않으면 CLI 는 터미널의 원래 승인 창으로 간다(서버가 없음, 시간이 지남, 연결이 끊김, 모르는 응답).
//   종료 코드 2 는 CLI 가 '거절'로 읽으므로 셸에서도 0 으로 끝낸다(`; exit 0`).
// - 팀장 열쇠는 명령줄에 싣지 않는다. 서버가 팀장마다 쓰는 MCP 설정 파일(0600)에서 주소와 열쇠를 읽는다.
// - 도구 입력은 줄여서 보낸다(긴 글은 자르고, 깊은 구조는 잘라 냄). 가리기·요약은 서버가 한다(server/tool-permission.ts).
// - 허용은 '이번 한 번만'이다. 승인 규칙(updatedPermissions)은 보내지 않는다.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** 도구 승인 카드가 열려 있는 최대 시간. 지나면 닫히고 터미널의 원래 승인 창에서 답해야 한다(server/tool-permission.ts). */
export const TOOL_PERMISSION_TTL_MS = 10 * 60_000;
/** 서버의 한 번 기다림. 훅은 pending 을 받으면 같은 카드를 다시 기다린다(서버의 유휴 연결 제한 255초 아래). */
export const TOOL_PERMISSION_POLL_MS = 50_000;

export const PERMISSION_HOOK_MARKER = "iamceo-permission-hook";
/** CLI 가 이 훅을 기다리는 최대 시간(초). 서버가 카드를 닫는 시간보다 넉넉히 길다(서버가 먼저 '닫힘'으로 답한다). */
export const PERMISSION_HOOK_TIMEOUT_SEC = Math.ceil(TOOL_PERMISSION_TTL_MS / 1000) + 60;

/** 독립 JS: 소스·컴파일 실행 모두 같은 파일을 Bun 으로 실행한다(statusline.ts·hooks.ts 와 같은 방식). */
const SCRIPT = String.raw`
import { readFileSync, writeSync } from 'node:fs';
let finished = false;
// 답이 있을 때만 쓰고, 어떤 경우에도 0 으로 끝낸다.
const finish = (out) => {
  if (finished) return;
  finished = true;
  try { if (out) writeSync(1, out); } catch {}
  try { process.exit(0); } catch {}
};
process.on('uncaughtException', () => finish());
process.on('unhandledRejection', () => finish());
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE']) { try { process.on(signal, () => finish()); } catch {} }
const started = Date.now();
const safety = setTimeout(() => finish(), TOTAL_MS + 5000);
// 긴 글은 자르고, 깊은 구조·긴 목록은 잘라 낸다. 서버는 이것으로 요약을 만든다.
function shrink(value, depth) {
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 5) return '…';
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => shrink(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 60)) out[key] = shrink(value[key], depth + 1);
    return out;
  }
  return null;
}
const text = (value, max) => typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
try {
  const configPath = process.argv[2];
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) finish();
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || input.hook_event_name !== 'PermissionRequest' || typeof input.tool_name !== 'string') finish();
  const env = JSON.parse(readFileSync(configPath, 'utf8'))?.mcpServers?.iamceo?.env ?? {};
  const base = typeof env.IAMCEO_URL === 'string' ? env.IAMCEO_URL.replace(/\/+$/, '') : '';
  const token = env.IAMCEO_TOKEN;
  if (!/^https?:\/\/[^\s]+$/.test(base) || typeof token !== 'string' || !token) finish();
  const post = async (path, body) => {
    const left = TOTAL_MS - (Date.now() - started);
    if (left <= 0) return null;
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(POLL_MS + 20000, left + 5000)),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data && typeof data === 'object' ? data : null;
  };
  let answer = await post('/agent/permission', {
    toolName: input.tool_name.slice(0, 200),
    toolInput: shrink(input.tool_input, 0),
    sessionId: text(input.session_id, 128),
    cwd: text(input.cwd, 4096),
    permissionMode: text(input.permission_mode, 64),
    agentId: text(input.agent_id, 128),
  });
  while (answer && answer.state === 'pending' && typeof answer.id === 'string') answer = await post('/agent/permission/wait', { id: answer.id });
  if (answer && answer.state === 'allow') {
    finish(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
  } else if (answer && answer.state === 'deny') {
    const message = typeof answer.message === 'string' && answer.message ? answer.message.slice(0, 2000) : '대표가 결재함에서 거절했습니다.';
    finish(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } }));
  }
} catch {}
clearTimeout(safety);
finish();
`;

function quote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

export interface PermissionHookOptions {
  execPath?: string;
  /** 시험에서만 줄인다. 실제로는 TOOL_PERMISSION_TTL_MS 보다 조금 길다. */
  totalMs?: number;
  pollMs?: number;
}

/** run/iamceo-permission-hook.mjs 를 쓴다(내용이 같으면 다시 쓰지 않는다). 스크립트 경로를 돌려준다. */
export function writePermissionHook(runDir: string, options: PermissionHookOptions = {}): string {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, `${PERMISSION_HOOK_MARKER}.mjs`);
  const total = options.totalMs ?? TOOL_PERMISSION_TTL_MS + 30_000;
  const poll = options.pollMs ?? TOOL_PERMISSION_POLL_MS;
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(poll) || poll <= 0) throw new Error("Invalid permission hook limits");
  const content = `const TOTAL_MS = ${total};\nconst POLL_MS = ${poll};\nconst MAX_STRING = 4000;\nconst MAX_INPUT = ${16 * 1024 * 1024};\n${SCRIPT}`;
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
 * hooks.ts 의 permissionHook 칸에 넣을 값. 명령은 `BUN_BE_BUN=1 <실행 파일> <스크립트> <MCP 설정 파일> 2>/dev/null; exit 0` 이다.
 * MCP 설정 파일(팀장 열쇠가 든 0600 파일)의 경로만 싣고 열쇠는 싣지 않는다. 상대 경로면 던진다.
 */
export function permissionHook(input: { runDir: string; mcpConfigFile: string } & PermissionHookOptions): { command: string; timeoutSec: number } {
  if (!isAbsolute(input.runDir) || !isAbsolute(input.mcpConfigFile)) throw new Error("Permission hook paths must be absolute");
  const script = writePermissionHook(input.runDir, input);
  const command = `BUN_BE_BUN=1 ${quote(input.execPath ?? process.execPath)} ${quote(script)} ${quote(input.mcpConfigFile)} 2>/dev/null; exit 0`;
  return { command, timeoutSec: PERMISSION_HOOK_TIMEOUT_SEC };
}
