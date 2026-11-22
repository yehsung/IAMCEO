// Gemini(Antigravity CLI, `agy`) 팀장의 도구 호출 직전 훅(PreToolUse). 한 번의 호출에서 다음을 함께 판정한다.
//
// 1) 작업 폴더. agy 는 작업 공간(실행 폴더 + --add-dir 폴더)을 경로 글자 순으로 정렬해 첫째를 '현재 폴더'로 쓴다(1.5.14 실측 8회 일치:
//    훅 입력의 cwd·workspacePaths[0], run_command 의 기본 폴더, "현재 폴더에 만들어" 의 파일 자리). IAMCEO 주입 폴더(<홈>/run/<id>.gemini/agy/<id>)는
//    홈의 `.iamceo`('.' 은 영문자보다 앞) 때문에 대개 프로젝트보다 앞서, 고치지 않으면 팀장의 산출물·명령이 주입 폴더에서 돈다. 그래서
//    - run_command 의 Cwd 가 없거나 주입 폴더 안이면 프로젝트 폴더로 바꿔 쓴다(overwrite, 얕은 병합: agy 가 모델에게 "Changed: Cwd" 를 알린다).
//    - 파일을 쓰는 도구의 경로가 주입 폴더 안이면 막는다(deny, 까닭에 작업 폴더를 적는다). 읽기는 막지 않는다(자기 규칙을 읽는 것은 해가 없다).
//    다른 길은 실측으로 닫혔다: --settings 는 hooks 를 받지 않는다(`Error: --settings: unknown setting "hooks"`, 규칙·MCP 칸도 문서에 없다).
//    주입 폴더를 프로젝트보다 뒤로 정렬되는 곳에 두려면 IAMCEO 홈 밖(지속되지 않는 임시 폴더)이나 대표의 프로젝트 옆에 둬야 해 하지 않는다.
//    규칙 첫 조각에도 작업 폴더를 적는다(gemini-inject.ts).
// 2) 결재함 도구 승인(K(E2), Claude 의 PermissionRequest 훅 permission-hook.ts 와 같은 결재 카드). agy 에는 '승인 창을 띄우려 할 때만' 오는 훅이 없고,
//    PreToolUse 는 정책 판단 전에 모든 호출에 온다. 그래서 훅이 도구의 종류(geminiKind: 명령·작업 폴더 안/밖 파일 쓰기·밖 읽기·연결 도구·웹)를 정해
//    서버(/agent/permission)에 올리고, 서버가 지금 모드(상태줄의 cycle_mode)에서 agy 가 물을 종류일 때만 카드를 연다(tool-permission.ts geminiNeedsCard).
//    대표가 허용하면 `auto_approve`(agy 가 물으려던 것을 승인. 대표가 agy 에 둔 거절 규칙은 그대로 듣는다), 거절하면 `deny` + 까닭(모델이 받는다).
//    카드가 필요 없거나 답이 없으면(닫힘·시간 초과·서버 없음) 승인 판정 없이 끝난다 = agy 의 원래 창(오늘의 동작). 읽기 전용 도구(작업 폴더 안 읽기)와
//    IAMCEO 의 MCP 도구(call_mcp_tool ServerName=iamceo, --settings 의 허용 규칙)는 서버에 묻지 않는다.
//    1.5.14 실측: auto_approve·deny 가 run_command·write_file·edit_file·call_mcp_tool·invoke_subagent 에 듣고, 서브에이전트의 도구 호출도 이 훅을 거치며,
//    훅을 630초 붙잡아도 agy 가 기다린다(제한 시간 700). 한 대화 안에서는 훅이 하나씩 돈다(부모와 서브에이전트는 동시에 돌 수 있다).
// 3) 서브에이전트 단계는 아래 설정의 tier 가 있을 때 invoke_subagent 의 Model 을 바꿔 쓴다(뒤 커밋).
//
// 지키는 것
// - 언제나 0 으로 끝난다. 표준 출력에는 판정 JSON 하나를 내거나 아무것도 내지 않는다. agy 1.5.14 실측: 빈 출력 + 0 = agy 의 기본 정책,
//   `{}`(decision 없음)·0 아닌 종료·JSON 아닌 출력·모르는 decision·시간 초과(SIGKILL) = 도구가 막힌다. 그래서 스크립트가 돌지 못하거나 실패하면
//   (실행 파일이 사라짐, 설정 파일 없음, 입력이 이상함) 아무것도 내지 않는다: 그때는 오늘처럼 agy 가 정한다(폴더 고치기만 빠진다).
// - 바꿀 것이 없으면 아무것도 내지 않는다. 바꿀 것이 있으면 `{"decision":"allow","overwrite":{…}}`: allow 는 '다음 훅이나 기본 정책에 맡김'이다(문서·실측).
// - 팀장의 작업 폴더에 있는 bunfig.toml·.env 를 읽지 않는다(bun-script.ts). 설정 파일은 주입 폴더 밖(<주입 폴더>.hook.json, 0600)이다.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { bunScriptCommand, shellQuote as quote } from "./bun-script.ts";
import type { GeminiHookSet } from "./gemini-hooks.ts";
import { PERMISSION_HOOK_TIMEOUT_SEC, TOOL_PERMISSION_POLL_MS, TOOL_PERMISSION_TTL_MS } from "./permission-hook.ts";

export const GEMINI_TOOL_HOOK_MARKER = "iamceo-gemini-tool-hook";
/** 판정만 하는 훅의 제한 시간(초). 스크립트는 그 전에 스스로 끝난다(LOCAL_MS). 넘기면 agy 가 끊고 도구를 막는다. */
export const GEMINI_TOOL_HOOK_LOCAL_TIMEOUT_SEC = 30;
const LOCAL_MS = 20_000;
/** 파일을 쓰는 도구(훅에 보이는 이름). 1.5.14 의 실제 호출은 write_file·edit_file 이고, 나머지는 문서·init.tools 의 이름이다(맞지 않아도 해가 없다). */
export const GEMINI_WRITE_TOOLS = ["write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"] as const;
/** 파일을 읽는 도구. 작업 폴더 밖을 읽을 때만 결재함에 묻는다(agy 도 그때만 묻는다). */
export const GEMINI_READ_TOOLS = ["read_file", "view_file"] as const;
/** 웹 페이지를 읽거나 여는 도구(agy 의 read_url·execute_url 허락. 허용 규칙이 없으면 묻는다). */
export const GEMINI_WEB_TOOLS = ["read_url_content", "open_browser_url", "browser_subagent"] as const;
/** 경로를 담는 인자 이름(실측: write_file·edit_file·read_file 은 Path). */
const PATH_KEYS = ["Path", "TargetFile", "AbsolutePath", "FilePath"];
/**
 * 훅이 서버에 알리는 도구의 종류. command: 셸 명령, edit: 작업 공간 안 파일 쓰기, edit_temp·read_temp: 임시 폴더, edit_outside·read_outside: 그 밖,
 * mcp: IAMCEO 밖의 연결 도구, web: 웹 페이지. 작업 공간 안 읽기와 IAMCEO 연결 도구는 종류가 없다(묻지 않는다).
 */
export const GEMINI_TOOL_KINDS = ["command", "edit", "edit_temp", "edit_outside", "read_temp", "read_outside", "mcp", "web"] as const;
export type GeminiToolKind = (typeof GEMINI_TOOL_KINDS)[number];

/** 정규식의 이름 묶음: `^(a|b|c)$`. 도구 이름은 영문 소문자·숫자·`_` 뿐이라 따로 이스케이프하지 않는다. */
function anchored(names: readonly string[]): string {
  return `^(${[...new Set(names)].join("|")})$`;
}

/** 독립 JS: 소스·컴파일 실행 모두 같은 파일을 Bun 으로 실행한다(permission-hook.ts 와 같은 방식). */
const SCRIPT = String.raw`
import { readFileSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
let finished = false;
// 답을 받지 못하고 끝날 때 낼 글. 바꿀 인자가 있으면 'allow + overwrite', 없으면 아무것도 내지 않는다.
let fallback = null;
const finish = (out) => {
  if (finished) return;
  finished = true;
  const text = out === undefined ? fallback : out;
  try { if (text) writeSync(1, text); } catch {}
  try { process.exit(0); } catch {}
};
process.on('uncaughtException', () => finish());
process.on('unhandledRejection', () => finish());
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE']) { try { process.on(signal, () => finish()); } catch {} }
let safety = setTimeout(() => finish(), LOCAL_MS);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const absText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && isAbsolute(value) && !value.includes('\0');
// 한 경로가 가리키는 자리들: 적힌 것(정규화)과 실제 경로(/tmp → /private/tmp). 아직 없는 파일은 가장 가까운 있는 부모의 실제 경로로 잇는다.
function forms(path) {
  const out = [resolve(path)];
  let probe = out[0], tail = '';
  for (let i = 0; i < 64; i++) {
    try { const real = realpathSync(probe); const full = tail ? join(real, tail) : real; if (!out.includes(full)) out.push(full); break; } catch {}
    const parent = dirname(probe);
    if (parent === probe) break;
    tail = tail ? join(basename(probe), tail) : basename(probe);
    probe = parent;
  }
  return out;
}
const within = (path, dirs) => dirs.some((dir) => path === dir || path.startsWith(dir.endsWith('/') ? dir : dir + '/'));
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
  if (!isObject(input) || input.hookEventName !== 'PreToolUse' || !isObject(input.toolCall) || typeof input.toolCall.name !== 'string') finish();
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!isObject(config) || config.v !== 1 || !absText(config.cwd) || !absText(config.injectDir)) finish();
  const name = input.toolCall.name;
  const args = isObject(input.toolCall.args) ? input.toolCall.args : {};
  const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths.filter(absText) : [];
  // 상대 경로는 agy 가 하듯 첫째 작업 공간에 붙여 읽는다(그것이 주입 폴더면 주입 폴더 안이다).
  const base = workspaces[0] ?? (absText(input.cwd) ? input.cwd : config.cwd);
  const injectForms = forms(config.injectDir);
  const inInject = (path) => typeof path === 'string' && path.length > 0 && forms(resolve(base, path)).some((form) => within(form, injectForms));
  const overwrite = {};
  // 1) 작업 폴더
  if (name === 'run_command') {
    const cwd = args.Cwd;
    if (typeof cwd !== 'string' || !cwd.trim() || inInject(cwd)) overwrite.Cwd = config.cwd;
  }
  const paths = PATH_KEYS.map((key) => args[key]).filter((value) => typeof value === 'string' && value.length > 0);
  if (WRITE_TOOLS.includes(name) && paths.some(inInject)) finish(JSON.stringify({ decision: 'deny', reason: String(config.injectDeny || '') }));
  const changed = Object.keys(overwrite).length > 0;
  if (changed) fallback = JSON.stringify({ decision: 'allow', overwrite });
  // 2) 결재함 승인: 도구의 종류. 서버가 지금 모드에서 agy 가 물을 종류인지 정한다.
  const permission = isObject(config.permission) ? config.permission : null;
  if (!permission || typeof permission.mcpConfigFile !== 'string') finish();
  const spaceForms = workspaces.flatMap(forms);
  const tempForms = ['/tmp', '/private/tmp', '/var/folders', process.env.TMPDIR].filter(absText).flatMap(forms);
  const place = (path) => {
    const at = forms(resolve(base, path));
    if (at.some((form) => within(form, spaceForms))) return 'inside';
    return at.some((form) => within(form, tempForms)) ? 'temp' : 'outside';
  };
  const worst = () => paths.map(place).reduce((a, b) => (a === 'outside' || b === 'outside' ? 'outside' : a === 'temp' || b === 'temp' ? 'temp' : 'inside'), 'inside');
  let kind = null;
  if (name === 'run_command') kind = 'command';
  else if (WRITE_TOOLS.includes(name)) { const at = worst(); kind = at === 'inside' ? 'edit' : at === 'temp' ? 'edit_temp' : 'edit_outside'; }
  else if (READ_TOOLS.includes(name)) { const at = worst(); kind = at === 'inside' ? null : at === 'temp' ? 'read_temp' : 'read_outside'; }
  else if (name === 'call_mcp_tool') kind = args.ServerName === 'iamceo' ? null : 'mcp';
  else if (WEB_TOOLS.includes(name)) kind = 'web';
  if (!kind) finish();
  const env = JSON.parse(readFileSync(permission.mcpConfigFile, 'utf8'))?.mcpServers?.iamceo?.env ?? {};
  const serverBase = typeof env.IAMCEO_URL === 'string' ? env.IAMCEO_URL.replace(/\/+$/, '') : '';
  const token = env.IAMCEO_TOKEN;
  if (!/^https?:\/\/[^\s]+$/.test(serverBase) || typeof token !== 'string' || !token) finish();
  // 이 Mac 의 서버(127.0.0.1)로 가는 요청은 프록시를 거치지 않는다(permission-hook.ts 와 같은 까닭: 팀장 열쇠가 실린 요청이 밖으로 나가지 않게).
  for (const key of ['NO_PROXY', 'no_proxy']) process.env[key] = [process.env[key], '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
  clearTimeout(safety);
  safety = setTimeout(() => finish(), TOTAL_MS + 5000);
  const started = Date.now();
  const post = async (path, body) => {
    const left = TOTAL_MS - (Date.now() - started);
    if (left <= 0) return null;
    const response = await fetch(serverBase + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(POLL_MS + 20000, left + 5000)),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return isObject(data) ? data : null;
  };
  // 긴 글은 자르고, 깊은 구조·긴 목록은 잘라 낸다. 가리기·요약은 서버가 한다.
  const shrink = (value, depth) => {
    if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth >= 5) return '…';
    if (Array.isArray(value)) return value.slice(0, 40).map((item) => shrink(item, depth + 1));
    if (isObject(value)) { const out = {}; for (const key of Object.keys(value).slice(0, 60)) out[key] = shrink(value[key], depth + 1); return out; }
    return null;
  };
  const text = (value, max) => typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
  // 바꿔 쓴 인자(Cwd)가 실제로 돌 값이다. 카드에도 그 값을 보인다.
  const effective = { ...args, ...overwrite };
  let answer = await post('/agent/permission', {
    toolName: name.slice(0, 200),
    toolInput: shrink(effective, 0),
    sessionId: text(input.conversationId, 128),
    cwd: text(typeof effective.Cwd === 'string' ? effective.Cwd : config.cwd, 4096),
    cli: 'gemini',
    geminiKind: kind,
    toolCallId: text(input.toolCall.id, 128),
  });
  while (answer && answer.state === 'pending' && typeof answer.id === 'string') answer = await post('/agent/permission/wait', { id: answer.id });
  if (answer && answer.state === 'allow') finish(JSON.stringify({ decision: 'auto_approve', ...(changed ? { overwrite } : {}) }));
  if (answer && answer.state === 'deny') {
    const message = typeof answer.message === 'string' && answer.message ? answer.message.slice(0, 2000) : '대표가 결재함에서 거절했습니다.';
    finish(JSON.stringify({ decision: 'deny', reason: message }));
  }
} catch {}
finish();
`;

export interface GeminiToolHookScriptOptions {
  execPath?: string;
  /** 시험에서만 바꾼다. */
  localMs?: number;
  /** 시험에서만 줄인다. 실제로는 TOOL_PERMISSION_TTL_MS 보다 조금 길다(permission-hook.ts 와 같다). */
  totalMs?: number;
  pollMs?: number;
}

/** run/iamceo-gemini-tool-hook.mjs 를 쓴다(내용이 같으면 다시 쓰지 않는다). 스크립트 경로를 돌려준다. */
export function writeGeminiToolHook(runDir: string, options: GeminiToolHookScriptOptions = {}): string {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, `${GEMINI_TOOL_HOOK_MARKER}.mjs`);
  const local = options.localMs ?? LOCAL_MS;
  const total = options.totalMs ?? TOOL_PERMISSION_TTL_MS + 30_000;
  const poll = options.pollMs ?? TOOL_PERMISSION_POLL_MS;
  if (![local, total, poll].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid gemini tool hook limits");
  const content = [`const LOCAL_MS = ${local};`, `const TOTAL_MS = ${total};`, `const POLL_MS = ${poll};`, "const MAX_STRING = 4000;", `const MAX_INPUT = ${16 * 1024 * 1024};`,
    `const WRITE_TOOLS = ${JSON.stringify(GEMINI_WRITE_TOOLS)};`, `const READ_TOOLS = ${JSON.stringify(GEMINI_READ_TOOLS)};`, `const WEB_TOOLS = ${JSON.stringify(GEMINI_WEB_TOOLS)};`,
    `const PATH_KEYS = ${JSON.stringify(PATH_KEYS)};`, SCRIPT].join("\n");
  writePrivate(path, content);
  return path;
}

/** 내용이 다를 때만 임시 파일 → rename 으로 바꾼다(0600). */
function writePrivate(path: string, content: string): void {
  let same = false;
  try { same = readFileSync(path, "utf8") === content; } catch { /* 처음 */ }
  if (!same) {
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try { writeFileSync(tmp, content, { mode: 0o600 }); renameSync(tmp, path); }
    finally { try { unlinkSync(tmp); } catch { /* rename 성공 */ } }
  }
  chmodSync(path, 0o600);
}

/** 이 팀장의 도구 훅 설정 파일. 주입 폴더의 옆(MCP 환경 파일과 같은 자리)이라 agy 의 작업 공간에 들지 않는다. */
export function geminiToolHookConfigFile(injectDir: string): string { return `${injectDir}.hook.json`; }

/** 파일 쓰기를 막을 때 모델이 받는 까닭(agy 가 `tool call denied by pre-tool hook: <까닭>` 으로 전한다). */
export function geminiInjectDenyReason(cwd: string, injectDir: string): string {
  return `작업 폴더는 ${cwd} 입니다. ${injectDir} 는 IAMCEO 가 이 세션에 넣은 설정 폴더라 여기에 파일을 만들거나 고치지 않습니다. 같은 파일을 ${cwd} 아래 경로로 다시 쓰세요.`;
}

export interface GeminiToolHookInput extends GeminiToolHookScriptOptions {
  /** $IAMCEO_HOME/run. 스크립트와 빈 Bun 설정을 둔다. */
  runDir: string;
  /** 팀장의 작업 폴더(프로젝트). */
  cwd: string;
  /** 이 팀장의 주입 폴더(gemini-inject.ts geminiInjectDir). */
  injectDir: string;
  /**
   * 결재함 도구 승인. 있으면 묻는 도구를 이 Mac 의 서버에 올린다. mcpConfigFile 은 팀장 열쇠가 든 IAMCEO MCP 설정(0600, 주입 폴더 밖):
   * 주소와 열쇠를 거기서 읽는다(명령줄·설정 파일에 열쇠를 싣지 않는다). 없으면 승인은 agy 가 정한다(묻지 않기 팀장, 받을 서버가 없음).
   */
  permission?: { mcpConfigFile: string } | null;
}

/**
 * 도구 훅 장치의 처리기(hooks.json 의 PreToolUse 한 묶음)와 그 설정 파일을 만든다. 명령은
 * `cd <run> 2>/dev/null && BUN_BE_BUN=1 <실행 파일> --config=<빈 설정> --no-env-file <스크립트> <설정 파일> 2>/dev/null; exit 0` 이다:
 * 스크립트가 돌지 못하면 아무것도 내지 않고 0 으로 끝난다(= agy 의 기본 정책). 상대 경로면 던진다.
 */
export function geminiToolHookSet(input: GeminiToolHookInput): GeminiHookSet {
  if (!isAbsolute(input.runDir) || !isAbsolute(input.cwd) || !isAbsolute(input.injectDir) || (input.permission && !isAbsolute(input.permission.mcpConfigFile))) throw new Error("Gemini tool hook paths must be absolute");
  const script = writeGeminiToolHook(input.runDir, input);
  const configFile = geminiToolHookConfigFile(input.injectDir);
  // 주입 폴더의 부모(…/agy)는 처음 띄울 때 아직 없다. 주입 폴더를 쓰는 쪽(gemini-inject.ts)과 같은 권한(0700)으로 만든다.
  mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
  const permission = input.permission ? { mcpConfigFile: input.permission.mcpConfigFile } : null;
  writePrivate(configFile, `${JSON.stringify({ v: 1, cwd: input.cwd, injectDir: input.injectDir, injectDeny: geminiInjectDenyReason(input.cwd, input.injectDir), permission })}\n`);
  const command = `cd ${quote(input.runDir)} 2>/dev/null && ${bunScriptCommand(input.execPath ?? process.execPath, input.runDir, script)} ${quote(configFile)} 2>/dev/null; exit 0`;
  // 프로세스는 matcher 에 맞는 호출에만 뜬다: 폴더 바로잡기는 명령·쓰기, 승인은 읽기·연결 도구·웹을 더한다.
  const names = ["run_command", ...GEMINI_WRITE_TOOLS, ...(permission ? [...GEMINI_READ_TOOLS, "call_mcp_tool", ...GEMINI_WEB_TOOLS] : [])];
  // 승인을 기다리면 대표의 답까지 붙잡는다: 서버가 카드를 닫는 시간보다 넉넉히 길다(Claude 승인 훅과 같다).
  const timeout = permission ? PERMISSION_HOOK_TIMEOUT_SEC : GEMINI_TOOL_HOOK_LOCAL_TIMEOUT_SEC;
  return { PreToolUse: [{ matcher: anchored(names), hooks: [{ type: "command", command, timeout }] }] };
}
