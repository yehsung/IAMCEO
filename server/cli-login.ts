// 0.2.8: AI 계정 로그인 — 폰에서도 Claude Code·Codex 계정을 바꾸거나 다시 로그인한다.
//
// 서버가 이 Mac 에서 CLI 의 로그인 명령을 대신 띄우고, 대표가 어느 기기에서나 끝낼 수 있는 것만 앱에 넘긴다.
// - Claude Code(`claude auth login --claudeai`): 붙여넣기 주소(redirect platform.claude.com/oauth/code/callback)를 출력하고
//   "Paste code here if prompted >" 로 표준 입력을 기다린다. 대표가 그 주소에서 로그인하면 페이지가 `코드#state` 를 보여 주고,
//   앱이 그것을 보내면 서버가 CLI 의 표준 입력에 넣는다. CLI 가 여는 브라우저 주소(localhost 로 돌아오는 자동 주소)는 BROWSER
//   스크립트로 받아 둔다: 서버가 도는 Mac 의 앱은 그 주소를 열어 코드 없이 끝낸다. 다른 기기에서는 쓸 수 없는 주소다.
// - Codex(`codex login --device-auth`): 기기 코드 로그인. 로그인 페이지와 일회용 코드를 출력하고 스스로 기다린다(15분).
//   대표가 페이지에서 로그인하고 코드를 넣으면 CLI 가 저장하고 끝난다.
// - Gemini(0.2.10, Antigravity CLI `agy acp --login`): 파이프로 도는 붙여넣기 로그인(대화형 화면이 아니다). 로그인 주소(redirect
//   https://antigravity.google/oauth-callback)를 출력하고 표준 입력 한 줄로 '코드 또는 도착한 페이지 주소 전체'를 받는다. 성공하면
//   `Logged in as <메일>.` 을 찍고 0 으로 끝난다. agy 는 BROWSER 를 보지 않고 `open <주소>` 로 브라우저를 연다: PATH 맨 앞에 가짜 `open` 을 두어
//   서버가 대표의 브라우저를 열지 않는다. 계정은 키체인 항목 하나라 다른 계정으로 로그인하면 덮어쓴다(이 Mac 의 Antigravity 앱·IDE 계정도 바뀐다).
//   SSH_* 를 넘기지 않는다: 그 값이 있으면 agy 가 토큰을 키체인이 아닌 파일에 써 팀장(키체인을 읽는다)과 계정이 갈린다.
//   첫 설정(색상·약관·데이터 수집 동의)은 대화형 화면에만 있고 서버는 누르지 않는다. 로그인 도중 그런 물음이 보이면 키를 넣지 않고 끝낸다.
//   근거: 실행 파일 역분석(agy 1.5.14, 조사 노트 parity/login). 실제 로그인으로는 아직 확인하지 않았다 — UNVERIFIED-INTERACTIVE 표시 자리.
// 로그인이 끝나면 계정을 다시 읽고(전과 같은 계정인지), 오케스트레이터가 떠 있는 팀장에게 새 계정을 적용한다(orchestrator.cliLoggedIn).
//
// 지키는 것: 코드·토큰·주소를 로그에 남기지 않는다. 계정 메일은 앱 응답에만 싣는다(대표 자신의 기기). Gemini 의 메일은 그 로그인의 응답에만 싣고
// 계정 줄에는 싣지 않는다(서버는 메일을 디스크에 쓰지 않는다. 같은 계정인지는 해시 지문으로만 견준다). 한 CLI 에 로그인은 하나씩.
// 시간 제한을 넘기거나 대표가 그만두면 CLI 를 끝낸다(SIGTERM, 2초 뒤 SIGKILL). 서버가 끝날 때도 남기지 않는다.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { LEGACY_CLI_ACCOUNT_CLIS, type CliAccount, type CliAccountCli, type CliLogin, type CliLoginApplied, type CliLoginPhase } from "../shared/types.ts";
import { ERROR_CODES, type ErrorCode } from "../shared/error-codes.ts";
import { AGY_FILE_TOKEN_ENV, parseAgyModels } from "./models.ts";
import { childEnv } from "./runner/env.ts";

/**
 * 로그인을 다루는 CLI. 0.2.10 부터 Gemini(Antigravity CLI)도 다룬다(`agy acp --login`).
 * 이미 나간 앱(0.2.8·0.2.9)은 모르는 CLI 의 계정 줄을 'Claude Code' 로 그리므로, 계정 목록(GET /api/cli-accounts)의 옛 칸에는 Gemini 를 싣지 않는다
 * (LEGACY_CLI_ACCOUNT_CLIS. Gemini 는 새 칸 allAccounts·allLogins 에만).
 */
export const CLI_LOGIN_CLIS: readonly CliAccountCli[] = ["claude", "codex", "gemini"];
/** 타입을 거치지 않은 값(요청 본문 등)이 로그인을 다루는 CLI 인가. */
export function isCliLoginCli(value: unknown): value is CliAccountCli {
  return (CLI_LOGIN_CLIS as readonly unknown[]).includes(value);
}
/** 출시 앱이 아는 CLI 인가(응답의 옛 칸에 싣는다). */
export function isLegacyLoginCli(cli: CliAccountCli): boolean {
  return LEGACY_CLI_ACCOUNT_CLIS.includes(cli);
}
/**
 * CLI 마다 갈리는 자리(switch)의 끝. 타입에 값을 더하면 각 switch 가 이 줄에서 컴파일 오류가 된다: 새 CLI 가 다른 CLI 의 길
 * (다른 로그인 명령·계정 파일·출력 해석)로 빠지기 전에 갈림마다 가지를 더하게 한다. 타입 밖의 값으로 불리면 거절한다.
 */
function unknownCli(cli: never): never {
  void cli;
  throw new CliLoginError(400, "cli_login_start_failed");
}
const CLAUDE_LOGIN_MS = 15 * 60_000;
/** Codex 의 기기 코드는 15분. CLI 가 스스로 끝내지 못했을 때를 위해 1분 더 둔다. */
const CODEX_LOGIN_MS = 16 * 60_000;
/** Gemini(`agy acp --login`)는 스스로 시간을 재지 않는다(코드 한 줄을 기다린다). Claude 와 같은 15분. */
const GEMINI_LOGIN_MS = 15 * 60_000;
const KEEP_FINISHED_MS = 10 * 60_000;
const ACCOUNT_CACHE_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 2_000;
/**
 * 로그인 CLI 가 끝난 뒤 남은 출력을 더 읽는 시간. CLI 가 띄운 하위 프로세스가 출력 관을 물려받아 쥐고 있으면 관이 닫히지 않는다:
 * 그때도 이만큼만 읽고 종료 코드로 판정한다(runAgy·models.ts 의 `agy models` 와 같은 보호). 보통은 끝나자마자 관이 닫혀 기다리지 않는다.
 */
const PIPE_DRAIN_MS = 2_000;
const OUTPUT_LIMIT = 64 * 1024;

/** 계정 지문: 같은 계정인지 견줄 때만 쓴다(메일·조직을 그대로 저장하지 않는다). 로그인하지 않았거나 모르면 null. */
export function accountIdentity(cli: CliAccountCli, parts: Array<string | null | undefined>): string | null {
  const known = parts.filter((p): p is string => typeof p === "string" && p.length > 0);
  if (!known.length) return null;
  return createHash("sha256").update([cli, ...parts.map(p => p ?? "")].join("\u0000")).digest("hex").slice(0, 32);
}

export interface AccountRead { account: CliAccount; identity: string | null }

// ---- 출력 읽기(시험이 직접 부른다) ----
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
export function stripAnsi(text: string): string { return text.replace(ANSI, ""); }

const CLAUDE_HOSTS = ["claude.com", "claude.ai", "anthropic.com"];
const CODEX_HOSTS = ["openai.com", "chatgpt.com"];
function allowedHost(raw: string, hosts: readonly string[]): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    return hosts.some(h => host === h || host.endsWith(`.${h}`)) ? url : null;
  } catch { return null; }
}

/** Claude 의 붙여넣기 주소(`visit: <주소>` 또는 콜백을 못 연 때의 `Sign in at: <주소>`)와 그 state. */
export function parseClaudeLoginOutput(text: string): { url: string; state: string } | null {
  const plain = stripAnsi(text);
  const m = /(?:visit|Sign in at):\s*(https:\/\/\S+)/.exec(plain);
  if (!m) return null;
  const url = allowedHost(m[1]!, CLAUDE_HOSTS);
  const state = url?.searchParams.get("state");
  const redirect = url?.searchParams.get("redirect_uri") ?? "";
  // 붙여넣기 주소만 받는다: 돌아오는 곳이 localhost 인 자동 주소는 다른 기기에서 쓸 수 없다.
  if (!url || !state || /^https?:\/\/(?:localhost|127\.0\.0\.1)/i.test(redirect)) return null;
  return { url: url.toString(), state };
}

/** BROWSER 스크립트가 받은 자동 주소(localhost 로 돌아온다). 서버가 도는 Mac 에서만 쓴다. */
export function parseClaudeLocalUrl(raw: string): string | null {
  const line = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
  const url = line ? allowedHost(line, CLAUDE_HOSTS) : null;
  const redirect = url?.searchParams.get("redirect_uri") ?? "";
  return url && /^http:\/\/localhost:\d+\//.test(redirect) ? url.toString() : null;
}

/** Codex 기기 코드 로그인의 페이지·일회용 코드·남은 분. */
export function parseCodexDeviceOutput(text: string): { url: string; userCode: string; minutes: number | null } | null {
  const plain = stripAnsi(text);
  const urlMatch = /(https:\/\/\S+)/.exec(plain.slice(plain.indexOf("Open this link") >= 0 ? plain.indexOf("Open this link") : 0));
  const url = urlMatch ? allowedHost(urlMatch[1]!, CODEX_HOSTS) : null;
  const after = plain.slice(Math.max(0, plain.indexOf("one-time code")));
  const code = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/.exec(after);
  if (!url || !code || plain.indexOf("one-time code") < 0) return null;
  const minutes = /expires in (\d+) minutes?/i.exec(plain);
  return { url: url.toString(), userCode: code[1]!, minutes: minutes ? Number(minutes[1]) : null };
}

/**
 * 대표가 붙여넣은 것을 CLI 가 받는 `코드#state` 로 바꾼다. 페이지의 코드 그대로(`코드#state`)나, 주소창의 콜백 주소 전체
 * (`https://platform.claude.com/oauth/code/callback?code=…&state=…`)를 받는다. state 가 이 로그인의 것이 아니면 거절한다.
 */
export function normalizeClaudeCode(input: string, expectedState: string): { ok: true; line: string } | { ok: false; code: ErrorCode } {
  const raw = input.replace(/[\s​‌‍﻿]+/g, "");
  if (!raw || raw.length > 4096) return { ok: false, code: "cli_login_code_invalid" };
  let code: string | null = null, state: string | null = null;
  if (/^https:\/\//i.test(raw)) {
    const url = allowedHost(raw, CLAUDE_HOSTS);
    code = url?.searchParams.get("code") ?? null;
    state = url?.searchParams.get("state") ?? null;
  } else {
    const parts = raw.split("#");
    if (parts.length === 2) [code, state] = parts as [string, string];
  }
  const part = /^[A-Za-z0-9._~-]{8,2048}$/;
  if (!code || !state || !part.test(code) || !part.test(state)) return { ok: false, code: "cli_login_code_invalid" };
  if (state !== expectedState) return { ok: false, code: "cli_login_code_other" };
  return { ok: true, line: `${code}#${state}` };
}

// ---- Gemini(Antigravity CLI, `agy acp --login`) ----
// UNVERIFIED-INTERACTIVE: 아래 글자(안내 문장·돌아오는 주소·`Logged in as`)는 agy 1.5.14 실행 파일의 글자열과 역어셈블에서 읽은 것이다
// (runLogin 의 `Open this link in a browser to log in with Google:\n\n  %s\n\nThen paste the authorization code, or the full URL of the page you
// land on, and press Enter:\n`, oauthMethod.StartInteractive 의 redirect, 끝의 `Logged in as %s.\n`). 대표의 첫 설정 뒤 실제 로그인 한 번으로 확인한다.
/** agy 가 로그인 주소에 넣는 돌아오는 곳. 이 페이지가 코드를 보여 준다(붙여넣기 방식, 어느 기기에서나 끝낼 수 있다). */
export const GEMINI_REDIRECT = "https://antigravity.google/oauth-callback";
const GEMINI_AUTH_HOSTS = ["accounts.google.com"];
const GEMINI_CALLBACK_HOSTS = ["antigravity.google"];
/** 로그인 주소 앞의 안내 문장(없어도 주소를 찾는다: 주소 모양이 더 엄격하다). */
const GEMINI_URL_LEAD = /Open this link in a browser to log in/i;
/** 주소 뒤에 오는 코드 물음. 이것까지 보여야 agy 가 표준 입력을 기다리는 중이다(같은 Fprintf 한 번에 나온다). */
const GEMINI_CODE_PROMPT = /authorization code/i;
/**
 * 로그인 도중 나오면 안 되는 대화형 물음: 첫 설정(색상·약관·데이터 수집 동의). `acp --login` 은 이 화면이 없는 파이프 흐름이지만(역분석),
 * 보이면 키를 하나도 넣지 않고 끝낸다(서버는 동의를 누르지 않는다). UNVERIFIED-INTERACTIVE: 글자는 11-21 의 대화형 첫 설정 화면 기록에서 옮겼다.
 */
const GEMINI_SETUP_PROMPT = /Terms of Service|Data Use|color scheme|Finish setup|I agree to/i;
/** 로그인 방식을 고르는 대화형 화면(Google Cloud 프로젝트·고급 SSO 등)이나, Google 계정 로그인이 아닌 설정(API 키·ADC·게이트웨이). 앱에서 다루지 않는다. */
const GEMINI_TERMINAL_ONLY = /Select login method|Select Google Cloud sign-in method|interactive Google sign-in isn.t available/i;
/**
 * 로그인되어 있지 않다는 agy 의 글(`agy models` 의 `Error: authentication failed: …`, 헤드리스의 `authentication required`).
 * UNVERIFIED-INTERACTIVE: 로그인된 상태의 `agy models`(모델 23줄, 종료 0)만 실측했다. 로그아웃 상태의 글·종료 코드는 역분석 추론이다.
 */
const GEMINI_SIGNED_OUT = /authentication (?:failed|required)|not (?:signed|logged) in|sign in required|please log back in/i;

/** 로그인 주소(https, accounts.google.com, 돌아오는 곳이 GEMINI_REDIRECT, state 있음)와 그 state. 아니면 null. */
export function geminiAuthUrl(raw: string): { url: string; state: string } | null {
  const url = allowedHost(raw.trim(), GEMINI_AUTH_HOSTS);
  const state = url?.searchParams.get("state");
  if (!url || !state || url.searchParams.get("redirect_uri") !== GEMINI_REDIRECT) return null;
  return { url: url.toString(), state };
}

/** `agy acp --login` 의 출력에서 로그인 주소와 state. 주소 뒤에 코드 물음까지 나왔을 때만(표준 입력을 기다린다) 준다. */
export function parseGeminiLoginOutput(text: string): { url: string; state: string } | null {
  const plain = stripAnsi(text);
  const lead = plain.search(GEMINI_URL_LEAD);
  const rest = lead >= 0 ? plain.slice(lead) : plain;
  for (const m of rest.matchAll(/https:\/\/\S+/g)) {
    const parsed = geminiAuthUrl(m[0]);
    if (!parsed) continue;
    return GEMINI_CODE_PROMPT.test(rest.slice(m.index! + m[0].length)) ? parsed : null;
  }
  return null;
}

/** 코드 물음은 나왔는데 출력에서 주소를 읽지 못했을 때(줄이 꺾였거나 모양이 바뀌었다), 가짜 `open` 이 받은 주소를 쓴다. */
export function geminiPromptShown(text: string): boolean {
  const plain = stripAnsi(text);
  return GEMINI_URL_LEAD.test(plain) && GEMINI_CODE_PROMPT.test(plain);
}

/**
 * 대표가 붙여넣은 것을 agy 가 받는 한 줄로 바꾼다. 페이지에 나온 코드 그대로(`4/0A…`, `/` 가 들어간다)나 도착한 페이지의 주소 전체
 * (`https://antigravity.google/oauth-callback?code=…&state=…`)를 받는다. 주소면 state 가 이 로그인의 것이어야 하고, 넣는 것은 코드만이다.
 */
export function normalizeGeminiCode(input: string, expectedState: string): { ok: true; line: string } | { ok: false; code: ErrorCode } {
  let raw = input.replace(/[\s\u200B\u200C\u200D\uFEFF]+/g, "");
  if (!raw || raw.length > 4096) return { ok: false, code: "cli_login_code_invalid" };
  let code: string | null;
  if (/^https?:\/\//i.test(raw)) {
    const url = allowedHost(raw, GEMINI_CALLBACK_HOSTS);
    if (!url || url.pathname.replace(/\/+$/, "") !== "/oauth-callback") return { ok: false, code: "cli_login_code_invalid" };
    const state = url.searchParams.get("state");
    code = url.searchParams.get("code");
    if (!code || !state) return { ok: false, code: "cli_login_code_invalid" };
    if (state !== expectedState) return { ok: false, code: "cli_login_code_other" };
  } else {
    // 주소창에서 코드만 떼어 오면 `/` 가 `%2F` 로 남는다.
    if (/%[0-9A-Fa-f]{2}/.test(raw)) { try { raw = decodeURIComponent(raw); } catch { return { ok: false, code: "cli_login_code_invalid" }; } }
    code = raw.replace(/^code=/i, "");
  }
  if (!/^[A-Za-z0-9/._~-]{10,2048}$/.test(code)) return { ok: false, code: "cli_login_code_invalid" };
  return { ok: true, line: code };
}

/** 성공 출력의 `Logged in as <메일>.` 에서 메일. 메일 모양이 아니면 null. 메모리에서만 쓴다(로그·디스크에 남기지 않는다). */
export function parseGeminiLoggedIn(text: string): string | null {
  const lines = [...stripAnsi(text).matchAll(/Logged in as\s+(\S+?)\.?\s*$/gim)];
  const email = lines.at(-1)?.[1] ?? null;
  return email && email.length <= 320 && /^[^\s@]{1,128}@[^\s@]{1,190}$/.test(email) ? email : null;
}

/**
 * agy 의 첫 설정이 끝나지 않았는가: <geminiHome>/cache/onboarding.json 의 완료 표시(onboardingComplete·consumerOnboardingComplete·
 * enterpriseOnboardingComplete)가 모두 false 면 true, 하나라도 true 면 false. 파일이 없거나 읽지 못하거나 표시가 없으면 null(모른다).
 * 1.5.14 실측: 11-22 첫 설정 전에는 셋 다 false, 대표가 개인 계정으로 첫 설정을 마친 뒤(11-23)에는 onboardingComplete·consumerOnboardingComplete 가 true,
 * enterpriseOnboardingComplete 는 false 였다(하나라도 true 면 끝남이라는 판정과 같다). 메일 같은 다른 칸은 읽지 않는다.
 */
export function readGeminiSetupPending(geminiHome: string): boolean | null {
  try {
    const file = join(geminiHome, "cache", "onboarding.json");
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    if (text.length > 64 * 1024) return null;
    const data = JSON.parse(text) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return null;
    const flags = ["onboardingComplete", "consumerOnboardingComplete", "enterpriseOnboardingComplete"].map(k => data[k]).filter((v): v is boolean => typeof v === "boolean");
    return flags.length ? !flags.some(Boolean) : null;
  } catch { return null; }
}

// ---- 계정 읽기 ----
function binInstalled(bin: string | undefined): boolean {
  if (!bin) return false;
  if (isAbsolute(bin) || bin.includes("/")) return existsSync(bin);
  return !!Bun.which(bin);
}

/**
 * CLI 를 띄울 환경: 팀장 세션과 같은 childEnv(Claude Code 안에서만 뜻이 있는 값을 빼고, USER 가 없으면 채운다 — 없으면 Claude Code 가 키체인의
 * 'unknown' 항목에 로그인을 써 세션이 읽는 항목과 갈린다. 2026-11-11 사고)에서 IAMCEO·herdr 값을 더 뺀다. 대표의 HOME·PATH 는 그대로.
 */
export function cliEnv(base: Record<string, string | undefined>, extra: Record<string, string | undefined>, username?: () => string): Record<string, string> {
  const env = username ? childEnv(base, username) : childEnv(base);
  for (const k of Object.keys(env)) if (/^(?:HC_|HERDR_|IAMCEO_)/.test(k)) delete env[k];
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  env.NO_COLOR = "1";
  return env;
}

function nowIso(now: number): string { return new Date(now).toISOString(); }

/** 약속이 ms 안에 풀리면 그 값, 아니면 null. 타이머는 남기지 않는다. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, ms)); });
  try { return await Promise.race([promise, late]); } finally { if (timer) clearTimeout(timer); }
}

function emptyAccount(cli: CliAccountCli, installed: boolean, now: number, loggedIn: boolean | null, problem?: string): CliAccount {
  return { cli, installed, loggedIn, email: null, organization: null, plan: null, method: null, checkedAt: nowIso(now), ...(problem ? { problem } : {}) };
}

const str = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Antigravity CLI 를 띄우는 부분(계정 확인 `agy models`). 손주 프로세스가 출력 관을 쥐고 있어도 끝나도록 읽기도 제한 시간과 겨룬다(models.ts 와 같다).
 * 시간을 넘기면 code null.
 */
async function runAgy(argv: string[], env: Record<string, string>, cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, cwd });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ code: null; stdout: string; stderr: string }>(resolve => {
    timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* 이미 끝났다 */ } resolve({ code: null, stdout: "", stderr: "" }); }, Math.max(1, timeoutMs));
  });
  const read = (async () => {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout: stdout.slice(0, OUTPUT_LIMIT), stderr: stderr.slice(0, OUTPUT_LIMIT) };
  })();
  try { return await Promise.race([read, deadline]); } finally { if (timer) clearTimeout(timer); }
}

async function runText(argv: string[], env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* 이미 끝났다 */ } }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { code, stdout: stdout.slice(0, OUTPUT_LIMIT), stderr: stderr.slice(0, OUTPUT_LIMIT) };
  } finally { clearTimeout(timer); }
}

/** `claude auth status --json`(Claude Code 2.1.3xx). 로그인하지 않았으면 loggedIn false. */
export async function readClaudeAccount(opts: { bin: string; home?: string; env?: Record<string, string | undefined>; now?: () => number; timeoutMs?: number }): Promise<AccountRead> {
  const now = opts.now ?? Date.now;
  const installed = binInstalled(opts.bin);
  if (!installed) return { account: emptyAccount("claude", false, now(), null, "cli_login_cli_missing"), identity: null };
  try {
    const env = cliEnv(opts.env ?? process.env, { CLAUDE_CONFIG_DIR: opts.home });
    const { stdout } = await runText([opts.bin, "auth", "status", "--json"], env, opts.timeoutMs ?? STATUS_TIMEOUT_MS);
    const start = stdout.indexOf("{");
    const data = JSON.parse(start >= 0 ? stdout.slice(start) : stdout) as Record<string, unknown>;
    const loggedIn = data.loggedIn === true;
    const email = loggedIn ? str(data.email) : null;
    const organization = loggedIn ? str(data.orgName) : null;
    const account: CliAccount = { cli: "claude", installed, loggedIn, email, organization,
      plan: loggedIn ? str(data.subscriptionType) ?? str(data.planTier) : null, method: loggedIn ? str(data.authMethod) : null, checkedAt: nowIso(now()) };
    return { account, identity: loggedIn ? accountIdentity("claude", [email, str(data.orgId)]) : null };
  } catch {
    return { account: emptyAccount("claude", installed, now(), null, "cli_account_unreadable"), identity: null };
  }
}

function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>; } catch { return null; }
}

/**
 * Codex 의 로그인 파일(<CODEX_HOME>/auth.json)을 읽는다. 파일이 없으면(키체인에 둔 설정이거나 로그인하지 않았다) `codex login status` 로 로그인 여부만 본다:
 * 그때 계정은 모른다(identity null — 계정을 바꿔도 세대를 올리지 못한다).
 */
export async function readCodexAccount(opts: { bin?: string; home?: string; env?: Record<string, string | undefined>; now?: () => number; timeoutMs?: number }): Promise<AccountRead> {
  const now = opts.now ?? Date.now;
  const installed = binInstalled(opts.bin);
  const file = join(opts.home ?? join(homedir(), ".codex"), "auth.json");
  if (!existsSync(file)) {
    if (!installed || !opts.bin) return { account: emptyAccount("codex", installed, now(), null, installed ? undefined : "cli_login_cli_missing"), identity: null };
    try {
      // Codex 0.166 은 이 결과('Logged in using ChatGPT'·'Not logged in')를 표준 오류로 찍는다(로그인 안 됨이면 종료 코드 1).
      const { code, stdout, stderr } = await runText([opts.bin, "login", "status"], cliEnv(opts.env ?? process.env, { CODEX_HOME: opts.home }), opts.timeoutMs ?? STATUS_TIMEOUT_MS);
      const text = stripAnsi(`${stdout}\n${stderr}`);
      const loggedIn = /not logged in/i.test(text) ? false : code === 0 && /logged in/i.test(text) ? true : null;
      return { account: { ...emptyAccount("codex", installed, now(), loggedIn, loggedIn === null ? "cli_account_unreadable" : undefined), ...(loggedIn ? { method: /api key/i.test(text) ? "api_key" : "chatgpt" } : {}) }, identity: null };
    } catch { return { account: emptyAccount("codex", installed, now(), null, "cli_account_unreadable"), identity: null }; }
  }
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const tokens = (data.tokens && typeof data.tokens === "object" ? data.tokens : null) as Record<string, unknown> | null;
    const apiKey = str(data.OPENAI_API_KEY);
    if (!tokens && apiKey) return { account: { ...emptyAccount("codex", installed, now(), true), method: "api_key" }, identity: accountIdentity("codex", ["api_key", createHash("sha256").update(apiKey).digest("hex")]) };
    if (!tokens) return { account: emptyAccount("codex", installed, now(), false), identity: null };
    const claims = jwtClaims(tokens.id_token);
    const auth = (claims?.["https://api.openai.com/auth"] && typeof claims["https://api.openai.com/auth"] === "object" ? claims["https://api.openai.com/auth"] : {}) as Record<string, unknown>;
    const email = str(claims?.email);
    const accountId = str(tokens.account_id) ?? str(auth.chatgpt_account_id);
    const account: CliAccount = { cli: "codex", installed, loggedIn: true, email, organization: null, plan: str(auth.chatgpt_plan_type), method: str(data.auth_mode) ?? "chatgpt", checkedAt: nowIso(now()) };
    return { account, identity: accountIdentity("codex", [email, accountId]) };
  } catch {
    return { account: emptyAccount("codex", installed, now(), null, "cli_account_unreadable"), identity: null };
  }
}

/**
 * Antigravity CLI 가 브라우저를 열 때 부르는 `open` 대신 쓰는 스크립트(<runDir>/agy-open/open). 받은 주소를 IAMCEO_LOGIN_URL_FILE 에 적고(있을 때만) 0 으로 끝난다:
 * 서버가 대표의 브라우저를 열지 않는다. agy 는 BROWSER 를 보지 않고 이름 `open` 을 PATH 에서 찾아 부른다(역분석, UNVERIFIED-INTERACTIVE). 폴더를 돌려준다.
 */
export function geminiOpenShim(runDir: string): string {
  const dir = join(runDir, "agy-open");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const script = join(dir, "open");
  writeFileSync(script, `#!/bin/sh\n# IAMCEO: Antigravity CLI 가 여는 브라우저 대신 주소를 적는다(서버가 대표의 브라우저를 열지 않는다).\n[ -n "$IAMCEO_LOGIN_URL_FILE" ] && printf '%s\\n' "$1" > "$IAMCEO_LOGIN_URL_FILE"\nexit 0\n`, { mode: 0o700 });
  chmodSync(script, 0o700);
  return dir;
}

/**
 * Antigravity CLI 를 띄울 환경: cliEnv 에 PATH 맨 앞의 가짜 `open` 폴더를 더하고 SSH_CLIENT·SSH_TTY·SSH_CONNECTION·BROWSER 를 뺀다.
 * SSH_* 가 있으면 agy 는 원격으로 보고 토큰을 키체인이 아닌 <geminiHome>/antigravity-oauth-token 파일에 쓴다: 키체인을 읽는 팀장과 계정이 갈린다(역분석).
 */
export function geminiCliEnv(base: Record<string, string | undefined>, runDir: string, extra: Record<string, string | undefined> = {}, username?: () => string): Record<string, string> {
  const path = [geminiOpenShim(runDir), base.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"].join(":");
  const noSsh = Object.fromEntries(AGY_FILE_TOKEN_ENV.map(key => [key, undefined]));
  return cliEnv(base, { PATH: path, ...noSsh, BROWSER: undefined, ...extra }, username);
}

/** agy 를 띄우는 빈 폴더(<runDir>/agy-login). 프로젝트 폴더에서 띄우지 않는다. */
function geminiWorkDir(runDir: string): string {
  const dir = join(runDir, "agy-login");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Antigravity CLI 의 계정 줄. agy 에는 계정을 알려 주는 명령이 없다: `agy models`(로그인한 계정으로 모델 목록을 받아 온다, 헤드리스는 저장된 로그인을 쓴다)의
 * 결과로 로그인 여부만 본다. 모델이 한 줄 이상이면 로그인됨, 인증 오류 글이면 로그인 안 됨, 그 밖(시간 초과 등)은 모름.
 * 메일은 읽지도 싣지도 않는다(계정 지문 identity 도 null — 같은 계정인지는 로그인 때 agy 가 알려 준 메일의 지문으로만 안다).
 * plan: 떠 있는 Gemini 팀장의 상태줄 기록이 알려 준 요금제(plan_tier). setupPending: 첫 설정이 남았는가(readGeminiSetupPending).
 */
export async function readGeminiAccount(opts: { bin?: string; geminiHome?: string; runDir: string; env?: Record<string, string | undefined>; now?: () => number; timeoutMs?: number; plan?: () => string | null }): Promise<AccountRead> {
  const now = opts.now ?? Date.now;
  const installed = binInstalled(opts.bin);
  const pending = opts.geminiHome ? readGeminiSetupPending(opts.geminiHome) : null;
  const setup = pending === null ? {} : { setupPending: pending };
  if (!installed || !opts.bin) return { account: emptyAccount("gemini", false, now(), null, "cli_login_cli_missing"), identity: null };
  try {
    const env = geminiCliEnv(opts.env ?? process.env, opts.runDir);
    const { code, stdout, stderr } = await runAgy([opts.bin, "models"], env, geminiWorkDir(opts.runDir), opts.timeoutMs ?? STATUS_TIMEOUT_MS);
    const text = stripAnsi(`${stdout}\n${stderr}`);
    const loggedIn = code === 0 && parseAgyModels(stdout).length > 0 ? true : code !== null && GEMINI_SIGNED_OUT.test(text) ? false : null;
    let plan: string | null = null;
    if (loggedIn) { try { plan = str(opts.plan?.() ?? null); } catch { plan = null; } }
    return { account: { ...emptyAccount("gemini", true, now(), loggedIn, loggedIn === null ? "cli_account_unreadable" : undefined), plan, ...setup }, identity: null };
  } catch {
    return { account: { ...emptyAccount("gemini", true, now(), null, "cli_account_unreadable"), ...setup }, identity: null };
  }
}

// ---- 로그인 ----
export interface CliLoginDeps {
  claudeBin: string;
  codexBin?: string;
  /** 0.2.10: Antigravity CLI(`agy`). 없거나 깔려 있지 않으면 Gemini 줄을 싣지 않고 로그인은 409 cli_login_cli_missing. */
  geminiBin?: string;
  claudeHome?: string;
  codexHome?: string;
  /** Antigravity CLI 의 자료 폴더(Config.geminiHome). 첫 설정이 남았는지(onboarding.json)만 읽는다. */
  geminiHome?: string;
  /** 떠 있는 Gemini 팀장의 상태줄 기록 가운데 since(ms) 뒤에 쓰인 것의 최신 요금제(plan_tier). 메일은 받지 않는다. */
  geminiPlan?: (since: number) => string | null;
  /** BROWSER 스크립트·가짜 open 과 자동 주소를 받는 파일을 두는 곳(<IAMCEO_HOME>/run). */
  runDir: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** 시험용: 로그인 시간 제한(ms). 기본 Claude 15분, Codex 16분, Gemini 15분. */
  limitMs?: Partial<Record<CliAccountCli, number>>;
  keepMs?: number;
  /** 시험용: 계정 목록이 Gemini 줄을 다시 읽기를 기다리는 가장 긴 시간(ms). 기본 2초. */
  geminiRowWaitMs?: number;
  /** 시험용: 계정 읽기를 바꾼다. */
  readAccount?: (cli: CliAccountCli) => Promise<AccountRead>;
  /** 로그인이 끝난 뒤 떠 있는 팀장에게 새 계정을 적용한다(오케스트레이터). */
  onLoggedIn?: (cli: CliAccountCli, after: string | null, before: string | null) => Promise<(CliLoginApplied & { changed: boolean | null }) | null>;
  log?: (line: string) => void;
}

interface Session {
  view: CliLogin;
  proc: ReturnType<typeof Bun.spawn> | null;
  stdout: string;
  stderr: string;
  state: string | null;
  urlFile: string | null;
  before: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  ending: boolean;
  /** CLI 가 로그인을 마치고 0 으로 끝났다(새 계정이 저장됐다). 그 뒤의 그만두기·시간 초과는 적용을 막지 않는다. */
  saved: boolean;
  done: Promise<void>;
}

const ACTIVE: ReadonlySet<CliLoginPhase> = new Set(["starting", "waiting", "verifying"]);
/** 계정 목록 응답이 Gemini 줄을 다시 읽기(`agy models`)를 기다리는 가장 긴 시간. 넘으면 마지막으로 읽은 값을 싣는다(CliLogins.geminiRow). */
const GEMINI_ROW_WAIT_MS = 2_000;

export class CliLoginError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message?: string) { super(message ?? ERROR_CODES[code].ko); }
}

export class CliLogins {
  private readonly sessions = new Map<string, Session>();
  /** CLI 마다 지금 도는 start(). 두 기기에서 함께 눌러도 CLI 를 둘 띄우지 않는다. */
  private readonly starting = new Map<CliAccountCli, Promise<CliLogin>>();
  private readonly accountCache = new Map<CliAccountCli, { at: number; seq: number; done: boolean; read: Promise<AccountRead> }>();
  /** CLI 마다 마지막으로 끝난 계정 읽기(늦게 시작한 것이 이긴다). 계정 목록이 Gemini 줄을 기다리지 않고 실을 때 쓴다. 메일은 담지 않는다. */
  private readonly lastRead = new Map<CliAccountCli, { seq: number; read: AccountRead }>();
  private readSeq = 0;
  /** CLI 마다 마지막으로 새 계정을 저장한 때(ms). Gemini 의 요금제는 이 뒤에 쓰인 상태줄 기록에서만 읽는다(앞 계정의 값을 보이지 않는다). */
  private readonly savedAt = new Map<CliAccountCli, number>();
  private closed = false;
  constructor(private readonly deps: CliLoginDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private log(line: string): void { (this.deps.log ?? ((l: string) => console.log(l)))(`[cli-login] ${line}`); }

  /** 출시 앱이 아는 두 CLI(Claude·Codex)의 지금 계정. force 면 캐시(1분)를 건너뛴다. */
  async accounts(force = false): Promise<CliAccount[]> {
    return Promise.all(LEGACY_CLI_ACCOUNT_CLIS.map(async cli => (await this.account(cli, force)).account));
  }

  /** Gemini 줄을 보일 때인가: agy 가 깔려 있거나, 진행 중·끝난 Gemini 로그인이 남아 있다. 아니면 응답이 예전 그대로다(새 칸 없음). */
  geminiShown(): boolean {
    return binInstalled(this.deps.geminiBin) || [...this.sessions.values()].some(s => s.view.cli === "gemini");
  }

  /** Gemini(Antigravity CLI)의 지금 계정. 보일 때가 아니면 null(agy 를 띄우지 않는다). */
  async geminiAccount(force = false): Promise<CliAccount | null> {
    if (!this.geminiShown()) return null;
    return (await this.account("gemini", force)).account;
  }

  /**
   * 계정 목록(GET /api/cli-accounts)에 실을 Gemini 줄. `agy models` 가 느리거나 멈춰도 응답(옛 칸의 Claude·Codex 줄까지)을 붙잡지 않는다.
   * - 이미 도는 읽기가 있으면 그것을 쓴다(agy 를 겹쳐 띄우지 않는다). 아니면 1분이 지났거나 force 일 때 다시 읽기를 건다.
   * - 마지막으로 읽은 값이 있으면: "wait" 는 그 읽기를 2초(GEMINI_ROW_WAIT_MS)까지만, "cached" 는 기다리지 않고, 그 안에 끝나지 않으면 마지막 값을 싣는다
   *   (읽기는 뒤에서 끝나 다음 응답에 실린다).
   * - 아직 한 번도 읽지 못했으면: "wait" 는 끝날 때까지(`agy models` 의 제한 시간 15초 안) 기다리고, "cached" 는 null(이번 응답에 Gemini 줄이 없다).
   * 보일 때가 아니면 null(agy 를 띄우지 않는다).
   */
  async geminiRow(force: boolean, mode: "wait" | "cached"): Promise<CliAccount | null> {
    if (!this.geminiShown()) return null;
    const cached = this.accountCache.get("gemini");
    const read = cached && !cached.done ? cached.read : this.account("gemini", force);
    const last = this.lastRead.get("gemini")?.read ?? null;
    if (!last) return mode === "wait" ? (await read).account : null;
    const fresh = await within(read, mode === "wait" ? (this.deps.geminiRowWaitMs ?? GEMINI_ROW_WAIT_MS) : 0);
    return (fresh ?? last).account;
  }

  private account(cli: CliAccountCli, force = false): Promise<AccountRead> {
    const cached = this.accountCache.get(cli);
    if (!force && cached && this.now() - cached.at < ACCOUNT_CACHE_MS) return cached.read;
    const seq = ++this.readSeq;
    const read = (this.deps.readAccount ? this.deps.readAccount(cli) : this.readAccount(cli))
      .catch((): AccountRead => ({ account: emptyAccount(cli, true, this.now(), null, "cli_account_unreadable"), identity: null }))
      .then(result => {
        const entry = this.accountCache.get(cli);
        if (entry?.seq === seq) entry.done = true;
        const last = this.lastRead.get(cli);
        if (!last || last.seq < seq) this.lastRead.set(cli, { seq, read: result });
        return result;
      });
    this.accountCache.set(cli, { at: this.now(), seq, done: false, read });
    return read;
  }

  private readAccount(cli: CliAccountCli): Promise<AccountRead> {
    const now = () => this.now();
    switch (cli) {
      case "claude": return readClaudeAccount({ bin: this.deps.claudeBin, home: this.deps.claudeHome, env: this.deps.env, now });
      case "codex": return readCodexAccount({ bin: this.deps.codexBin, home: this.deps.codexHome, env: this.deps.env, now });
      case "gemini": return readGeminiAccount({ bin: this.deps.geminiBin, geminiHome: this.deps.geminiHome, runDir: this.deps.runDir, env: this.deps.env, now,
        plan: () => this.deps.geminiPlan?.(this.savedAt.get("gemini") ?? 0) ?? null });
      default: return unknownCli(cli);
    }
  }

  /** 지금 진행 중이거나 10분 안에 끝난 로그인. */
  list(): CliLogin[] {
    this.prune();
    return [...this.sessions.values()].map(s => ({ ...s.view }));
  }

  get(id: string): CliLogin {
    this.prune();
    const s = this.sessions.get(id);
    if (!s) throw new CliLoginError(404, "cli_login_not_found");
    return { ...s.view };
  }

  /** 로그인을 시작한다. 같은 CLI 의 로그인이 진행 중이면 그것을 돌려준다(restart 면 그것을 끝내고 새로). */
  start(cli: CliAccountCli, restart = false): Promise<CliLogin> {
    const running = this.starting.get(cli);
    if (running) return running;
    const task = this.startOnce(cli, restart).finally(() => { if (this.starting.get(cli) === task) this.starting.delete(cli); });
    this.starting.set(cli, task);
    return task;
  }

  private async startOnce(cli: CliAccountCli, restart: boolean): Promise<CliLogin> {
    // 타입 밖의 값(agy 등)으로 불렸으면 다른 CLI 의 로그인으로 흘려보내지 않고 거절한다.
    if (!isCliLoginCli(cli)) throw new CliLoginError(400, "cli_login_start_failed");
    if (this.closed) throw new CliLoginError(503, "cli_login_start_failed");
    const running = [...this.sessions.values()].find(s => s.view.cli === cli && ACTIVE.has(s.view.phase));
    if (running && !restart) return { ...running.view };
    if (running) await this.cancel(running.view.id);
    const bin = this.binOf(cli);
    if (!bin || !binInstalled(bin)) throw new CliLoginError(409, "cli_login_cli_missing");
    // 로그인 전 계정(같은 계정을 다시 로그인한 것인지 견준다). 못 읽어도 로그인은 한다.
    // Gemini 는 지금 계정을 알 길이 없다(identity 가 늘 null): `agy models` 를 띄우지 않는다. 오케스트레이터가 마지막으로 적용한 지문과 견준다.
    const before = cli === "gemini" ? null : (await this.account(cli, true)).identity;
    // 기다리는 사이 서버가 끝나기 시작했으면 CLI 를 띄우지 않는다(끝난 뒤에 CLI 가 남는다).
    if (this.closed) throw new CliLoginError(503, "cli_login_start_failed");
    const now = this.now();
    const id = `cl_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const view: CliLogin = { id, cli, flow: cli === "codex" ? "device_code" : "paste_code", phase: "starting", startedAt: nowIso(now),
      expiresAt: nowIso(now + (this.deps.limitMs?.[cli] ?? (cli === "claude" ? CLAUDE_LOGIN_MS : cli === "codex" ? CODEX_LOGIN_MS : GEMINI_LOGIN_MS))),
      endedAt: null, url: null, localUrl: null, userCode: null, error: null, account: null, accountChanged: null, applied: null };
    const session: Session = { view, proc: null, stdout: "", stderr: "", state: null, urlFile: null, before, timer: null, ending: false, saved: false, done: Promise.resolve() };
    this.sessions.set(id, session);
    try {
      const base = this.deps.env ?? process.env;
      let argv: string[], env: Record<string, string>, cwd: string | undefined;
      switch (cli) {
        case "claude": {
          mkdirSync(this.deps.runDir, { recursive: true, mode: 0o700 });
          const script = join(this.deps.runDir, "cli-login-browser.sh");
          // CLI 가 여는 브라우저 대신 주소를 파일에 적는다(서버가 도는 Mac 의 앱이 연다). 대표의 브라우저를 서버가 열지 않는다.
          writeFileSync(script, `#!/bin/sh\n[ -n "$IAMCEO_LOGIN_URL_FILE" ] && printf '%s\\n' "$1" > "$IAMCEO_LOGIN_URL_FILE"\nexit 0\n`, { mode: 0o700 });
          chmodSync(script, 0o700);
          session.urlFile = join(this.deps.runDir, `cli-login-${id}.url`);
          argv = [bin, "auth", "login", "--claudeai"];
          env = cliEnv(base, { CLAUDE_CONFIG_DIR: this.deps.claudeHome, BROWSER: script, IAMCEO_LOGIN_URL_FILE: session.urlFile });
          break;
        }
        case "codex":
          argv = [bin, "login", "--device-auth"];
          env = cliEnv(base, { CODEX_HOME: this.deps.codexHome });
          break;
        case "gemini":
          // 파이프로 도는 로그인(대화형 화면이 아니다). 가짜 open 이 받은 주소는 출력에서 주소를 읽지 못할 때만 쓰고, 끝나면 지운다.
          mkdirSync(this.deps.runDir, { recursive: true, mode: 0o700 });
          session.urlFile = join(this.deps.runDir, `cli-login-${id}.url`);
          argv = [bin, "acp", "--login"];
          env = geminiCliEnv(base, this.deps.runDir, { IAMCEO_LOGIN_URL_FILE: session.urlFile });
          cwd = geminiWorkDir(this.deps.runDir);
          break;
        default: return unknownCli(cli);
      }
      session.proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env, ...(cwd ? { cwd } : {}) });
    } catch (e) {
      this.finish(session, "failed", { code: "cli_login_start_failed", message: `${ERROR_CODES.cli_login_start_failed.ko} (${(e as Error).message})` });
      return { ...session.view };
    }
    this.log(`${cli} 로그인 시작 ${id}`);
    session.timer = setTimeout(() => { void this.expire(id); }, Math.max(0, Date.parse(view.expiresAt) - now));
    session.done = this.watch(session);
    return { ...session.view };
  }

  private binOf(cli: CliAccountCli): string | undefined {
    switch (cli) {
      case "claude": return this.deps.claudeBin;
      case "codex": return this.deps.codexBin;
      case "gemini": return this.deps.geminiBin;
      default: return unknownCli(cli);
    }
  }

  /** Claude·Gemini: 로그인 페이지가 보여 준 코드(또는 도착한 페이지 주소)를 CLI 에 넣는다. */
  async submitCode(id: string, input: string): Promise<CliLogin> {
    const s = this.sessions.get(id);
    if (!s) throw new CliLoginError(404, "cli_login_not_found");
    if (s.view.flow !== "paste_code") throw new CliLoginError(400, "cli_login_code_unsupported");
    if (s.view.phase !== "waiting" || !s.state || !s.proc) throw new CliLoginError(409, "cli_login_not_waiting");
    const normalized = s.view.cli === "gemini" ? normalizeGeminiCode(input, s.state) : normalizeClaudeCode(input, s.state);
    if (!normalized.ok) throw new CliLoginError(400, normalized.code);
    // Gemini: 넣기 직전에 한 번 더 본다. 첫 설정·로그인 방식 물음이 떠 있으면 그 물음에 코드를 넣지 않고 로그인을 끝낸다.
    const interactive = s.view.cli === "gemini" ? this.geminiInteractive(s) : null;
    if (interactive) {
      this.finish(s, "failed", { code: interactive, message: ERROR_CODES[interactive].ko });
      void this.kill(s);
      throw new CliLoginError(409, interactive);
    }
    try {
      const stdin = s.proc.stdin as unknown as { write(chunk: string): number; flush?(): unknown };
      stdin.write(`${normalized.line}\n`);
      await stdin.flush?.();
    } catch { throw new CliLoginError(409, "cli_login_not_waiting"); }
    // 넣는 사이 그만두기·시간 초과·CLI 끝남이 왔으면 그 결과를 덮지 않는다.
    if (s.view.phase !== "waiting") return { ...s.view };
    s.view = { ...s.view, phase: "verifying", error: null };
    this.log(`${s.view.cli} 로그인 코드 넣음 ${id}`);
    return { ...s.view };
  }

  async cancel(id: string): Promise<CliLogin> {
    const s = this.sessions.get(id);
    if (!s) throw new CliLoginError(404, "cli_login_not_found");
    // CLI 가 이미 새 계정을 저장했다: 그만둘 것이 없다. 팀장에게 적용하는 것은 그대로 끝낸다.
    if (s.saved) return { ...s.view };
    if (ACTIVE.has(s.view.phase)) {
      this.finish(s, "cancelled", null);
      await this.kill(s);
    }
    return { ...s.view };
  }

  /** 서버가 끝날 때: 띄운 CLI 를 남기지 않는다. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.values()].filter(s => ACTIVE.has(s.view.phase) && !s.saved).map(async s => { this.finish(s, "cancelled", null); await this.kill(s); }));
    // 새 계정을 저장한 로그인은 적용(계정 다시 읽기·오케스트레이터)을 마칠 때까지 기다린다.
    await Promise.all([...this.sessions.values()].filter(s => s.saved).map(s => s.done.catch(() => undefined)));
  }

  private async expire(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || !ACTIVE.has(s.view.phase) || s.saved) return;
    this.finish(s, "expired", { code: "cli_login_expired", message: ERROR_CODES.cli_login_expired.ko });
    await this.kill(s);
  }

  private async kill(s: Session): Promise<void> {
    const proc = s.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill("SIGTERM"); } catch { /* 이미 끝났다 */ }
      const ended = await Promise.race([proc.exited.then(() => true), Bun.sleep(KILL_GRACE_MS).then(() => false)]);
      if (!ended) { try { proc.kill("SIGKILL"); } catch { /* 이미 끝났다 */ } await proc.exited.catch(() => undefined); }
    }
    // CLI 가 끝난 뒤에 한 번 더 지운다: 시작하자마자 그만두면 finish 가 지운 뒤에 BROWSER 스크립트가 주소를 적어 파일이 남았다(라이브 확인).
    if (s.urlFile) { try { rmSync(s.urlFile, { force: true }); } catch { /* 다음 로그인이 덮는다 */ } }
  }

  private finish(s: Session, phase: CliLoginPhase, error: CliLogin["error"]): void {
    if (!ACTIVE.has(s.view.phase)) return;
    s.ending = true;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.view = { ...s.view, phase, error, endedAt: nowIso(this.now()) };
    if (s.urlFile) { try { rmSync(s.urlFile, { force: true }); } catch { /* 지우지 못해도 다음 로그인이 덮는다 */ } }
    this.log(`${s.view.cli} 로그인 ${phase} ${s.view.id}${error ? ` (${error.code})` : ""}`);
  }

  private async pipe(stream: ReadableStream<Uint8Array>, into: "stdout" | "stderr", s: Session, readers: Array<ReadableStreamDefaultReader<Uint8Array>>): Promise<void> {
    const reader = stream.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (s[into].length < OUTPUT_LIMIT) s[into] += text;
        // Antigravity CLI 는 안내를 표준 출력에 쓰지만(역분석) 표준 오류에 써도 읽는다.
        if (into === "stdout" || s.view.cli === "gemini") this.onOutput(s);
      }
    } catch { /* 끝난 프로세스 */ }
  }

  private onOutput(s: Session): void {
    switch (s.view.cli) {
      case "claude": {
        if (s.view.phase !== "starting") return;
        const parsed = parseClaudeLoginOutput(s.stdout);
        if (!parsed || !/Paste code here/i.test(s.stdout)) return;
        s.state = parsed.state;
        const localUrl = s.urlFile && existsSync(s.urlFile) ? parseClaudeLocalUrl(readFileSync(s.urlFile, "utf8")) : null;
        s.view = { ...s.view, phase: "waiting", url: parsed.url, localUrl };
        return;
      }
      case "codex": {
        if (s.view.phase !== "starting") return;
        const parsed = parseCodexDeviceOutput(s.stdout);
        if (!parsed) return;
        const expiresAt = parsed.minutes ? Math.min(Date.parse(s.view.expiresAt), this.now() + parsed.minutes * 60_000) : Date.parse(s.view.expiresAt);
        s.view = { ...s.view, phase: "waiting", url: parsed.url, userCode: parsed.userCode, expiresAt: nowIso(expiresAt) };
        return;
      }
      // Gemini 는 waiting·verifying 에서도 본다: 그 뒤에 나온 첫 설정·로그인 방식 물음에 코드를 넣지 않는다.
      case "gemini": return this.onGeminiOutput(s);
      default: return unknownCli(s.view.cli);
    }
  }

  /**
   * Antigravity CLI: 주소와 코드 물음이 나오면 waiting. 대화형 물음(첫 설정·로그인 방식 고르기)이 보이면 키를 하나도 넣지 않고 끝낸다:
   * starting·waiting 은 언제나(코드를 아직 넣지 않았다), 코드를 넣은 뒤(verifying)에는 agy 가 아직 떠 있을 때만(물음을 띄운 채 입력을 기다린다.
   * 이미 끝났으면 종료 코드로 판정한다: 저장된 로그인을 글 때문에 실패로 두지 않는다).
   * 출력에서 주소를 읽지 못했는데 코드 물음은 나왔으면 가짜 open 이 받은 주소를 쓴다(그 파일이 늦게 오면 prune 이 다시 본다).
   */
  private onGeminiOutput(s: Session): void {
    if (!ACTIVE.has(s.view.phase) || s.ending || s.saved) return;
    const alive = !!s.proc && s.proc.exitCode === null && s.proc.signalCode === null;
    const interactive = s.view.phase === "verifying" && !alive ? null : this.geminiInteractive(s);
    if (interactive) {
      this.finish(s, "failed", { code: interactive, message: ERROR_CODES[interactive].ko });
      void this.kill(s);
      return;
    }
    if (s.view.phase !== "starting") return;
    const text = `${s.stdout}\n${s.stderr}`;
    const parsed = parseGeminiLoginOutput(text) ?? (geminiPromptShown(text) ? this.geminiUrlFromFile(s) : null);
    if (!parsed) return;
    s.state = parsed.state;
    s.view = { ...s.view, phase: "waiting", url: parsed.url, localUrl: null };
  }

  /** agy 의 출력에 대화형 물음이 보이면 그 실패 코드: 첫 설정(약관·데이터 수집 동의)이 먼저, 로그인 방식 고르기·Google 로그인을 못 하는 설정. 없으면 null. */
  private geminiInteractive(s: Session): ErrorCode | null {
    const plain = stripAnsi(`${s.stdout}\n${s.stderr}`);
    if (GEMINI_SETUP_PROMPT.test(plain)) return "cli_login_gemini_setup";
    if (GEMINI_TERMINAL_ONLY.test(plain)) return "cli_login_gemini_unavailable";
    return null;
  }

  private geminiUrlFromFile(s: Session): { url: string; state: string } | null {
    try {
      if (!s.urlFile || !existsSync(s.urlFile)) return null;
      const line = readFileSync(s.urlFile, "utf8").split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
      return line ? geminiAuthUrl(line) : null;
    } catch { return null; }
  }

  /** 자동 주소는 CLI 가 붙여넣기 주소를 찍은 바로 뒤에 BROWSER 스크립트로 온다. 앱이 처음 물을 때 아직 없으면 그때 다시 본다. */
  private refreshLocalUrl(s: Session): void {
    // Gemini: 코드 물음은 나왔는데 주소를 아직 못 받았으면(가짜 open 의 파일이 늦게 왔다) 다시 본다.
    if (s.view.cli === "gemini" && s.view.phase === "starting" && !s.ending) { this.onGeminiOutput(s); return; }
    if (s.view.cli !== "claude" || s.view.localUrl || !s.urlFile || !ACTIVE.has(s.view.phase)) return;
    try { if (existsSync(s.urlFile)) s.view = { ...s.view, localUrl: parseClaudeLocalUrl(readFileSync(s.urlFile, "utf8")) }; } catch { /* 다음에 다시 본다 */ }
  }

  private async watch(s: Session): Promise<void> {
    const proc = s.proc!;
    const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
    const out = this.pipe(proc.stdout as ReadableStream<Uint8Array>, "stdout", s, readers);
    const err = this.pipe(proc.stderr as ReadableStream<Uint8Array>, "stderr", s, readers);
    const code = await proc.exited;
    // CLI 가 띄운 하위 프로세스가 출력 관을 물려받아 쥐고 있으면 읽기가 끝나지 않는다: 남은 출력은 PIPE_DRAIN_MS 까지만 읽고 읽기를 접는다.
    // 그러지 않으면 저장된 로그인이 '확인 중'에 묶여 시간 초과로 끝나고 팀장에게 적용되지 않는다. 판정은 아래처럼 종료 코드로 한다.
    await within(Promise.all([out, err]), PIPE_DRAIN_MS);
    for (const reader of readers) reader.cancel().catch(() => undefined);
    if (s.ending || !ACTIVE.has(s.view.phase)) return;
    const plainOut = stripAnsi(s.stdout), plainErr = stripAnsi(s.stderr);
    // 종료 코드 0 이면 CLI 가 새 계정을 저장했다(Claude 는 'Login successful.' 을 찍고 0 으로, 실패는 1·130 으로 끝난다).
    // 끝 글을 성공의 조건으로 삼지 않는다: 저장된 로그인을 '실패'로 두면 팀장에게 영영 적용되지 않는다.
    if (code !== 0) {
      this.finish(s, "failed", this.failure(s.view.cli, plainOut, plainErr));
      return;
    }
    // 끝: 계정을 다시 읽고, 떠 있는 팀장에게 적용한다. 그동안은 verifying 으로 보이고, 그만두기·시간 초과·서버 끝남이 와도 끝까지 한다.
    s.saved = true;
    this.savedAt.set(s.view.cli, this.now());
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.view = { ...s.view, phase: "verifying" };
    const after = await this.loggedInAccount(s, `${plainOut}\n${plainErr}`);
    let applied: (CliLoginApplied & { changed: boolean | null }) | null = null;
    try { applied = await this.deps.onLoggedIn?.(s.view.cli, after.identity, s.before) ?? null; }
    catch (e) { this.log(`${s.view.cli} 새 계정 적용 실패: ${(e as Error).message}`); }
    const changed = applied?.changed ?? (after.identity && s.before ? after.identity !== s.before : null);
    const counts: CliLoginApplied | null = applied ? { reopenedNow: applied.reopenedNow, atNextTurn: applied.atNextTurn, ...(applied.setupBlocked !== undefined ? { setupBlocked: applied.setupBlocked } : {}) } : null;
    s.view = { ...s.view, account: after.account, accountChanged: changed, applied: counts };
    this.finish(s, "succeeded", null);
  }

  /**
   * 로그인을 마친 뒤의 계정. Claude·Codex 는 다시 읽은 것 그대로. Gemini 는 다시 읽어(로그인 여부·요금제) agy 가 끝에 알려 준 메일(`Logged in as …`)을
   * 이 응답에만 얹고, 같은 계정인지 견줄 지문은 그 메일의 해시다. 메일은 캐시·로그·디스크에 남기지 않는다(계정 줄은 메일 없이 보인다).
   */
  private async loggedInAccount(s: Session, stdout: string): Promise<AccountRead> {
    const read = await this.account(s.view.cli, true);
    if (s.view.cli !== "gemini") return read;
    const email = parseGeminiLoggedIn(stdout);
    return { account: { ...read.account, loggedIn: read.account.loggedIn ?? true, email }, identity: accountIdentity("gemini", [email]) };
  }

  /** CLI 가 남긴 실패 글에서 대표에게 보일 까닭을 고른다(토큰·주소는 싣지 않는다. Gemini 는 메일도 가린다). */
  private failure(cli: CliAccountCli, stdout: string, stderr: string): { code: string; message: string } {
    const text = `${stderr}\n${stdout}`;
    if (cli === "gemini") return this.geminiFailure(text);
    if (cli === "codex" && /device code login is not enabled/i.test(text)) return { code: "cli_login_device_disabled", message: ERROR_CODES.cli_login_device_disabled.ko };
    if (/timed out/i.test(text)) return { code: "cli_login_expired", message: ERROR_CODES.cli_login_expired.ko };
    if (cli === "claude" && /wasn't accepted|not accepted|invalid code|invalid_grant/i.test(text)) return { code: "cli_login_code_rejected", message: ERROR_CODES.cli_login_code_rejected.ko };
    const line = (/Login failed:\s*([^\n]+)/i.exec(stderr)?.[1] ?? /error[^\n]*/i.exec(stderr)?.[0] ?? "").replace(/https?:\/\/\S+/g, "").replace(/[A-Za-z0-9_-]{24,}/g, "…").trim().slice(0, 300);
    return { code: "cli_login_failed", message: line ? `${ERROR_CODES.cli_login_failed.ko}: ${line}` : ERROR_CODES.cli_login_failed.ko };
  }

  /**
   * Antigravity CLI(`agy acp --login`)의 실패 글(역분석 글자, UNVERIFIED-INTERACTIVE): `interactive Google sign-in isn't available in this configuration`
   * (API 키·ADC·게이트웨이 설정), `couldn't log in: …`(코드 교환 실패 — invalid_grant 등이면 코드가 틀렸거나 이미 쓴 것), 첫 설정 물음.
   */
  private geminiFailure(text: string): { code: string; message: string } {
    const plain = stripAnsi(text);
    const known = (code: ErrorCode) => ({ code, message: ERROR_CODES[code].ko });
    if (GEMINI_TERMINAL_ONLY.test(plain)) return known("cli_login_gemini_unavailable");
    if (GEMINI_SETUP_PROMPT.test(plain)) return known("cli_login_gemini_setup");
    if (/couldn.t log in:[^\n]*(?:invalid_grant|invalid_request|malformed|bad request|code (?:was )?(?:already )?(?:used|expired|invalid))/i.test(plain)) return known("cli_login_code_rejected");
    if (/timed out|deadline exceeded/i.test(plain)) return known("cli_login_expired");
    const raw = /couldn.t log in:\s*([^\n]+)/i.exec(plain)?.[1] ?? /Error:\s*([^\n]+)/.exec(plain)?.[1] ?? /error[^\n]*/i.exec(plain)?.[0] ?? "";
    const line = raw.replace(/https?:\/\/\S+/g, "").replace(/[^\s@]+@[^\s@]+/g, "…").replace(/[A-Za-z0-9_\/-]{24,}/g, "…").trim().slice(0, 300);
    return { code: "cli_login_failed", message: line ? `${ERROR_CODES.cli_login_failed.ko}: ${line}` : ERROR_CODES.cli_login_failed.ko };
  }

  private prune(): void {
    const keep = this.deps.keepMs ?? KEEP_FINISHED_MS;
    for (const [id, s] of this.sessions) {
      this.refreshLocalUrl(s);
      if (!ACTIVE.has(s.view.phase) && s.view.endedAt && this.now() - Date.parse(s.view.endedAt) > keep) this.sessions.delete(id);
    }
  }

  /** 시험용: 띄운 CLI 가 끝날 때까지 기다린다. */
  async settled(id: string): Promise<void> { await this.sessions.get(id)?.done; }
}
