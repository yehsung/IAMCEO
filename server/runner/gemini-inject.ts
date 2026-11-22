// Gemini(Antigravity CLI, `agy`) 팀장에게 이번 세션에만 넣는 것들: 역할 지침(규칙 조각), MCP 서버, 훅.
//
// agy 는 지침·MCP·훅을 명령줄이나 --settings 로 받지 않는다. `--add-dir <폴더>` 로 넘긴 폴더의 `.agents/` 를 읽는다(1.5.14 실측).
// 그래서 팀장마다 IAMCEO 홈 안에 주입 폴더를 하나 두고 띄울 때마다 다시 쓴다. 전역 설정(~/.gemini/config)과 대표의 프로젝트 폴더는 건드리지 않는다.
//
//   <주입 폴더>/.agents/rules/iamceo-NN.md   역할 지침 조각(머리에 trigger: always_on)
//   <주입 폴더>/.agents/mcp_config.json      IAMCEO MCP 서버를 띄우는 명령. 팀장 열쇠는 여기 없다(아래 환경 파일에서 읽어 넘긴다)
//   <주입 폴더 옆>/<팀장 id>.env               MCP 서버에 넘길 환경(팀장 열쇠가 든다. 0600). 주입 폴더 **밖**이다
//   <주입 폴더>/.agents/hooks.json           훅(gemini-hooks.ts geminiHooksFile): 사건 기록과 도구 호출 직전 판정(gemini-tool-hook.ts). 훅을 넣지 않으면 없다
//   <주입 폴더 옆>/<팀장 id>.hook.json         도구 훅의 설정(작업 폴더·주입 폴더). 주입 폴더 **밖**이다
//
// agy 는 작업 공간(실행 폴더 + --add-dir)을 경로 글자 순으로 정렬해 첫째를 '현재 폴더'로 쓴다(1.5.14 실측). 주입 폴더는 홈의 `.iamceo` 때문에 대개
// 프로젝트보다 앞이라, 규칙 첫 조각에 작업 폴더를 적고(geminiWorkspaceRule) 도구 훅이 명령 폴더를 바로잡고 주입 폴더 쓰기를 막는다.
//
// 주입 폴더는 팀장마다 따로다: <지침 파일의 폴더>/agy/<팀장 id>. 총괄은 Gemini 팀장의 지침·MCP 설정을 팀장만의 폴더(run/<id>.gemini)에 쓰지만,
// 실행기는 그것을 믿지 않고 팀장 id 를 한 단계 더 둔다: 부르는 쪽이 여러 팀장의 파일을 한 폴더에 두어도 지침과 열쇠(mcp_config.json)가 서로 덮이지 않는다.
// agy 는 넘겨받은 폴더의 부모 쪽 `.agents` 도 읽으므로 부모(…/agy, 지침 파일의 폴더)에는 `.agents` 를 두지 않는다.
// 이 폴더는 agy 의 작업 폴더로 더해진다(--add-dir). 그 팀장의 AI 가 자기 규칙·MCP 설정·훅 파일을 읽고 고칠 수 있다(같은 사용자 권한이라 막을 수 없다).
// 그래서 띄울 때마다 지금 값으로 다시 맞춘다. 같은 까닭으로 팀장 열쇠(IAMCEO_TOKEN)는 이 폴더 안에 두지 않는다: agy 의 폴더 검색·색인·@파일 끼워넣기가
// 작업 폴더를 훑어도 열쇠가 모델 입력·대화 기록·산출물에 실리지 않게, 폴더 밖의 환경 파일에 두고 MCP 서버를 띄우는 sh 한 줄이 읽어 넘긴다(1.5.14 실측: 이 꼴로 도구가 불린다).
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { CoreError } from "./core-client.ts";

/** 규칙 조각 하나의 본문 상한(바이트). 1.5.14 실측: 26.7KB 지침을 8KB 안팎 4조각으로 넣으니 전부 실렸다. */
export const GEMINI_RULE_CHUNK_BYTES = 8000;
/** agy 가 규칙 파일 하나를 자르는 크기(바이트, 문서·실측). 머리말을 더한 파일이 이것을 넘으면 쓰지 않고 던진다. */
export const GEMINI_RULE_FILE_MAX_BYTES = 24_000;
const RULE_FILE = /^iamceo-\d+\.md$/;
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/** 한 줄이 상한보다 길 때만 쓴다. 코드 포인트 경계에서 자른다(한글 한 글자의 바이트를 가르지 않는다). */
function splitLongLine(line: string, maxBytes: number): string[] {
  const out: string[] = [];
  let piece = "", size = 0;
  for (const char of line) {
    const width = bytesOf(char);
    if (size + width > maxBytes && piece) { out.push(piece); piece = ""; size = 0; }
    piece += char; size += width;
  }
  if (piece) out.push(piece);
  return out;
}

/**
 * 역할 지침을 규칙 조각으로 나눈다. 순수 함수다.
 * - 조각은 `## ` 로 시작하는 줄(절 제목) 앞에서 끊는다. 이어진 절은 상한 안에서 한 조각에 함께 담는다.
 * - 한 절이 상한을 넘으면 줄 경계에서 더 끊는다. 한 줄이 상한을 넘으면 글자 경계에서 끊는다(글자 중간의 바이트를 가르지 않는다).
 * - 모든 조각은 maxBytes 이하이고, 조각을 차례로 이으면 원문과 글자까지 같다(지우거나 다듬지 않는다). 빈 글이면 조각이 없다.
 */
export function splitGeminiRules(text: string, maxBytes: number = GEMINI_RULE_CHUNK_BYTES): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error("Invalid rule chunk size");
  if (!text) return [];
  // 줄바꿈을 줄 끝에 붙여 둔다. 이으면 원문이 된다.
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const sections: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ") || !sections.length) sections.push(line);
    else sections[sections.length - 1] += line;
  }
  const chunks: string[] = [];
  let current = "", size = 0;
  const flush = () => { if (current) { chunks.push(current); current = ""; size = 0; } };
  const add = (piece: string) => {
    const width = bytesOf(piece);
    if (size + width > maxBytes) flush();
    current += piece; size += width;
  };
  for (const section of sections) {
    if (bytesOf(section) <= maxBytes) { add(section); continue; }
    // 긴 절: 앞 조각과 섞지 않고 줄 단위로 채운다.
    flush();
    for (const line of section.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (bytesOf(line) <= maxBytes) add(line);
      else for (const piece of splitLongLine(line, maxBytes)) add(piece);
    }
    flush();
  }
  flush();
  return chunks;
}

/** 규칙 파일 하나의 글: 머리말(항상 켜짐)과 조각 본문. */
export function geminiRuleFile(chunk: string, index: number, total: number): string {
  return `---\ntrigger: always_on\ndescription: "IAMCEO 역할 지침 ${index}/${total}"\n---\n\n${chunk}`;
}

/** 내용이 다를 때만 임시 파일 → rename 으로 바꾼다(띄워 둔 CLI 가 반쯤 쓴 파일을 읽지 않게). */
function writeAtomic(path: string, content: string): void {
  let same = false;
  try { same = readFileSync(path, "utf8") === content; } catch { /* 처음 */ }
  if (!same) {
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try { writeFileSync(tmp, content, { mode: 0o600 }); renameSync(tmp, path); }
    finally { try { unlinkSync(tmp); } catch { /* rename 성공 */ } }
  }
  chmodSync(path, 0o600);
}
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export interface GeminiMcpBridge { command: string; args: string[]; env: Record<string, string> }
/** IAMCEO 의 MCP 설정 파일에서 iamceo 서버를 읽는다. 검증은 Codex 가지와 같다(stdio 명령과 글자 인자, 환경 변수 이름·값). */
export function readGeminiMcpBridge(mcpConfigFile: string): GeminiMcpBridge {
  const config = JSON.parse(readFileSync(mcpConfigFile, "utf8")) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> };
  const bridge = config.mcpServers?.iamceo;
  if (!bridge?.command || typeof bridge.command !== "string" || !Array.isArray(bridge.args) || bridge.args.some((arg) => typeof arg !== "string")) throw new CoreError("config", "IAMCEO MCP bridge must use a stdio command and args");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(bridge.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") throw new CoreError("config", `Invalid MCP environment value: ${key}`);
    env[key] = value;
  }
  return { command: bridge.command, args: bridge.args, env };
}

/** MCP 서버를 띄우는 sh 한 줄: 첫 인자의 환경 파일을 읽어 내보낸 뒤 나머지 인자(다리 명령)로 바꿔 돈다. 환경 파일을 읽지 못하면 띄우지 않는다. */
export const GEMINI_MCP_LAUNCHER = 'f="$1"; shift; set -a; . "$f" || exit 1; set +a; exec "$@"';
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
/** 환경 파일의 글: 한 줄에 `이름='값'`. 이름은 readGeminiMcpBridge 가 확인한 것만, 값은 작은따옴표로 싼다(sh 가 그대로 읽는다). */
export function geminiMcpEnvText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}\n`).join("");
}
/** 환경 파일을 다시 값으로 푼다(시험·가짜 CLI 가 쓴다). geminiMcpEnvText 가 쓴 꼴만 읽는다. */
export function parseGeminiMcpEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const match of text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'\\'')*)'$/gm)) env[match[1]!] = match[2]!.replace(/'\\''/g, "'");
  return env;
}
/** 이 팀장의 MCP 환경 파일. 주입 폴더의 옆(같은 agy 폴더 안)이라 agy 의 작업 폴더에 들지 않는다. */
export function geminiMcpEnvFile(injectDir: string): string { return `${injectDir}.env`; }

/**
 * 규칙 첫 조각의 맨 앞에 싣는 '작업 폴더' 절. agy 가 주입 폴더를 첫째 작업 공간(현재 폴더)으로 보여 주더라도 산출물·명령은 프로젝트에서 하게 한다.
 * 훅(gemini-tool-hook.ts)이 run_command 의 폴더를 바로잡고 주입 폴더 쓰기를 막지만, 모델이 처음부터 바른 폴더를 쓰면 되묻기·재시도가 없다.
 */
export function geminiWorkspaceRule(cwd: string, injectDir: string): string {
  return `## 작업 폴더\n- 이 세션의 작업 폴더(현재 폴더)는 \`${cwd}\` 다. 파일은 그 아래에 만들고 고친다. 명령(run_command)은 Cwd 를 \`${cwd}\` 또는 그 아래 폴더로 준다.\n`
    + `- \`${injectDir}\` 는 IAMCEO 가 이 세션에 넣은 설정 폴더(규칙·MCP·훅)다. 작업 공간 목록의 첫째로 보여도 현재 폴더가 아니다. 거기에 파일을 만들거나 고치지 않는다.\n\n`;
}

/** 이 팀장의 주입 폴더. 지침 파일이 있는 폴더 아래 agy/<팀장 id>. 경로로 쓸 수 없는 id 면 던진다. */
export function geminiInjectDir(systemPromptFile: string, memberId: string): string {
  if (!isAbsolute(systemPromptFile)) throw new CoreError("config", "Antigravity launch files need an absolute rules file path");
  if (!MEMBER_ID.test(memberId)) throw new CoreError("config", "Invalid member id for Antigravity launch files");
  return join(dirname(systemPromptFile), "agy", memberId);
}

export interface GeminiInjectInput {
  memberId: string;
  /**
   * 팀장의 작업 폴더(프로젝트). 있으면 규칙 첫 조각의 맨 앞에 '작업 폴더' 절을 싣는다(geminiWorkspaceRule). agy 는 작업 공간을 경로 글자 순으로 정렬해
   * 첫째를 현재 폴더로 쓰는데, 주입 폴더가 대개 프로젝트보다 앞이라 모델이 주입 폴더를 현재 폴더로 안다(gemini-tool-hook.ts).
   */
  cwd?: string;
  /** 역할 지침 파일. 본문을 규칙 조각으로 나눠 싣는다. */
  systemPromptFile: string;
  /** IAMCEO 의 MCP 설정 파일(mcpServers.iamceo). */
  mcpConfigFile: string;
  /** `.agents/hooks.json` 에 쓸 값(gemini-hooks.ts geminiHooksConfig). null 이면 훅 파일을 두지 않는다(예전 것은 지운다). */
  hooks: Record<string, unknown> | null;
}

/**
 * 주입 폴더와 그 옆의 MCP 환경 파일을 지금 값으로 맞춘다(폴더 0700, 파일 0600). 띄울 때마다 부른다. 폴더 경로를 돌려준다.
 * 파일은 내용이 다를 때만 바꾸고, 이번에 쓰지 않은 예전 규칙 조각·훅 파일은 지운다. 지침·MCP 설정을 읽지 못하면 던진다(띄우지 않는다).
 */
export function writeGeminiInjectDir(input: GeminiInjectInput): string {
  const dir = geminiInjectDir(input.systemPromptFile, input.memberId);
  const bridge = readGeminiMcpBridge(input.mcpConfigFile);
  const roleText = readFileSync(input.systemPromptFile, "utf8");
  const chunks = splitGeminiRules(input.cwd ? `${geminiWorkspaceRule(input.cwd, dir)}${roleText}` : roleText);
  const files = chunks.map((chunk, i) => geminiRuleFile(chunk, i + 1, chunks.length));
  if (files.some(file => bytesOf(file) > GEMINI_RULE_FILE_MAX_BYTES)) throw new CoreError("config", "Antigravity rule file would exceed the 24,000 byte limit");
  const agents = join(dir, ".agents"), rules = join(agents, "rules");
  for (const path of [dirname(dir), dir, agents, rules]) privateDir(path);
  const width = Math.max(2, String(files.length).length);
  const names = files.map((_, i) => `iamceo-${String(i + 1).padStart(width, "0")}.md`);
  files.forEach((file, i) => writeAtomic(join(rules, names[i]!), file));
  // 예전에 쓴 조각 가운데 이번에 없는 것(지침이 짧아졌다). 우리 이름 규칙의 파일만 지운다.
  for (const name of readdirSync(rules)) {
    if (RULE_FILE.test(name) && !names.includes(name)) { try { unlinkSync(join(rules, name)); } catch { /* 다음에 다시 */ } }
  }
  // 열쇠가 든 환경은 주입 폴더 밖의 파일에 쓰고, 설정에는 그 파일을 읽어 다리를 띄우는 명령만 싣는다.
  const envFile = geminiMcpEnvFile(dir);
  writeAtomic(envFile, geminiMcpEnvText(bridge.env));
  writeAtomic(join(agents, "mcp_config.json"), `${JSON.stringify({ mcpServers: { iamceo: { command: "/bin/sh", args: ["-c", GEMINI_MCP_LAUNCHER, "iamceo-mcp", envFile, bridge.command, ...bridge.args] } } }, null, 2)}\n`);
  const hooksFile = join(agents, "hooks.json");
  if (input.hooks) writeAtomic(hooksFile, `${JSON.stringify(input.hooks, null, 2)}\n`);
  else { try { unlinkSync(hooksFile); } catch { /* 없었다 */ } }
  return dir;
}

export interface GeminiSettingsInput {
  /** 팀장의 작업 폴더. */
  cwd: string;
  injectDir: string;
  permissionMode: "bypassPermissions" | "auto" | "default";
  /**
   * 권한 auto 를 대신하는 모드로 띄운다(permissionMode 가 auto 일 때만 뜻이 있다). 이 실행에서 agy 가 auto 로 뜨지 않았을 때(상태줄의 cycle_mode 가
   * 없음 = default) 서버가 다음 띄우기에 켠다(Orchestrator 의 gemini_mode 처리). 실측(1.5.14 헤드리스): accept-edits + 터미널 샌드박스 + proceed-in-sandbox 는
   * 작업 폴더 안 파일 쓰기와 샌드박스 안 명령을 묻지 않고, 작업 폴더 밖 쓰기·샌드박스 밖 명령만 묻는다(auto 의 안전 평가기만 없다).
   */
  autoFallback?: boolean;
  /** 상태줄 래퍼(gemini-statusline.ts). 없으면 agy 의 기본 상태줄이 보인다. */
  statusLine: { type: "command"; command: string } | null;
}

/** 실제 경로와 적힌 경로가 다르면(/tmp → /private/tmp) 둘 다 싣는다. agy 가 어느 쪽으로 견주는지 확인하지 못했다. */
function trustedPaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    let real = path;
    try { real = realpathSync(path); } catch { /* 없는 폴더는 적힌 대로 */ }
    for (const candidate of [real, path]) if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * agy `--settings` 에 한 줄 글로 넘길 값. 이번 세션에만 적용되고 저장되지 않는다(1.5.14 실측).
 * - trustedWorkspaces: 작업 폴더와 주입 폴더. 폴더 신뢰 창이 뜨지 않게 한다(그 창을 읽는 파서는 두지 않았다).
 * - permissions.allow: IAMCEO MCP 도구는 묻지 않고 부른다.
 * - 팁·설문·알림을 끈다. 일하는 중에 들어온 글은 줄 세운다(queuedMessages).
 * - 권한이 '전부 묻기'(default)면 agentMode 를 비운다: 플래그가 없을 때의 기본(auto, 1.5.7+)으로 뜨지 않게 한다.
 * - 권한이 auto 면 agentMode "auto" 다(`--mode auto` 는 쓰지 않는다). 1.5.14 실측: `--mode auto` 는 로그인 전에 판정해 auto 를 쓸 수 있는 계정에도
 *   `warning: --mode auto is not available for this account` 를 찍는다(그래도 로그인 뒤 auto 로 바뀐다). agentMode "auto" 는 경고 없이 같은 결과다.
 *   auto 를 쓸 수 없는 계정·환경이면 agy 가 default 로 띄운다(문서). 그것은 상태줄의 cycle_mode 로 알아낸다(gemini-status.ts).
 * - autoFallback 이면 auto 대신 accept-edits + 터미널 샌드박스 + proceed-in-sandbox(위 autoFallback 설명).
 */
export function geminiSettings(input: GeminiSettingsInput): Record<string, unknown> {
  return {
    trustedWorkspaces: trustedPaths([input.cwd, input.injectDir]),
    permissions: { allow: ["mcp(iamceo/*)"] },
    showTips: false,
    showFeedbackSurvey: false,
    notifications: false,
    queuedMessages: "queue",
    ...(input.statusLine ? { statusLine: input.statusLine } : {}),
    ...(input.permissionMode === "default" ? { agentMode: "" } : {}),
    ...(input.permissionMode === "auto" ? (input.autoFallback ? { agentMode: "accept-edits", enableTerminalSandbox: true, toolPermission: "proceed-in-sandbox" } : { agentMode: "auto" }) : {}),
  };
}
