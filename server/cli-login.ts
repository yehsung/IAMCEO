// 0.2.8: AI 계정 로그인 — 폰에서도 Claude Code·Codex 계정을 바꾸거나 다시 로그인한다.
//
// 서버가 이 Mac 에서 CLI 의 로그인 명령을 대신 띄우고, 대표가 어느 기기에서나 끝낼 수 있는 것만 앱에 넘긴다.
// - Claude Code(`claude auth login --claudeai`): 붙여넣기 주소(redirect platform.claude.com/oauth/code/callback)를 출력하고
//   "Paste code here if prompted >" 로 표준 입력을 기다린다. 대표가 그 주소에서 로그인하면 페이지가 `코드#state` 를 보여 주고,
//   앱이 그것을 보내면 서버가 CLI 의 표준 입력에 넣는다. CLI 가 여는 브라우저 주소(localhost 로 돌아오는 자동 주소)는 BROWSER
//   스크립트로 받아 둔다: 서버가 도는 Mac 의 앱은 그 주소를 열어 코드 없이 끝낸다. 다른 기기에서는 쓸 수 없는 주소다.
// - Codex(`codex login --device-auth`): 기기 코드 로그인. 로그인 페이지와 일회용 코드를 출력하고 스스로 기다린다(15분).
//   대표가 페이지에서 로그인하고 코드를 넣으면 CLI 가 저장하고 끝난다.
// 로그인이 끝나면 계정을 다시 읽고(전과 같은 계정인지), 오케스트레이터가 떠 있는 팀장에게 새 계정을 적용한다(orchestrator.cliLoggedIn).
//
// 지키는 것: 코드·토큰·주소를 로그에 남기지 않는다. 계정 메일은 앱 응답에만 싣는다(대표 자신의 기기). 한 CLI 에 로그인은 하나씩.
// 시간 제한을 넘기거나 대표가 그만두면 CLI 를 끝낸다(SIGTERM, 2초 뒤 SIGKILL). 서버가 끝날 때도 남기지 않는다.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CliAccount, CliAccountCli, CliLogin, CliLoginApplied, CliLoginPhase } from "../shared/types.ts";
import { ERROR_CODES, type ErrorCode } from "../shared/error-codes.ts";
import { childEnv } from "./runner/env.ts";

/**
 * 로그인을 다루는 CLI. Gemini(Antigravity CLI)는 넣지 않는다: 로그인 하위 명령이 없고 브라우저로만 로그인한다.
 * 이미 나간 앱(0.2.8·0.2.9)은 모르는 CLI 의 계정 줄을 'Claude Code' 로 그리므로, 계정 목록(GET /api/cli-accounts)에도 싣지 않는다.
 */
export const CLI_LOGIN_CLIS: readonly CliAccountCli[] = ["claude", "codex"];
// 이 파일의 갈림(claude 가 아니면 codex)은 CliAccountCli 가 이 둘뿐이라는 데 기댄다. 값을 더하면 아래 줄이 컴파일 오류가 된다:
// 새 CLI 가 Codex 길(`codex login --device-auth`, ~/.codex/auth.json, Codex 출력 해석)로 빠지기 전에 갈림마다 가지를 더하게 한다.
const ONLY_CLAUDE_AND_CODEX: [Exclude<CliAccountCli, "claude" | "codex">] extends [never] ? true : never = true;
void ONLY_CLAUDE_AND_CODEX;
/** 타입을 거치지 않은 값(요청 본문 등)이 로그인을 다루는 CLI 인가. */
export function isCliLoginCli(value: unknown): value is CliAccountCli {
  return (CLI_LOGIN_CLIS as readonly unknown[]).includes(value);
}
const CLAUDE_LOGIN_MS = 15 * 60_000;
/** Codex 의 기기 코드는 15분. CLI 가 스스로 끝내지 못했을 때를 위해 1분 더 둔다. */
const CODEX_LOGIN_MS = 16 * 60_000;
const KEEP_FINISHED_MS = 10 * 60_000;
const ACCOUNT_CACHE_MS = 60_000;
const STATUS_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 2_000;
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

function emptyAccount(cli: CliAccountCli, installed: boolean, now: number, loggedIn: boolean | null, problem?: string): CliAccount {
  return { cli, installed, loggedIn, email: null, organization: null, plan: null, method: null, checkedAt: nowIso(now), ...(problem ? { problem } : {}) };
}

const str = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;

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

// ---- 로그인 ----
export interface CliLoginDeps {
  claudeBin: string;
  codexBin?: string;
  claudeHome?: string;
  codexHome?: string;
  /** BROWSER 스크립트와 자동 주소를 받는 파일을 두는 곳(<IAMCEO_HOME>/run). */
  runDir: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** 시험용: 로그인 시간 제한(ms). 기본 Claude 15분, Codex 16분. */
  limitMs?: Partial<Record<CliAccountCli, number>>;
  keepMs?: number;
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

export class CliLoginError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message?: string) { super(message ?? ERROR_CODES[code].ko); }
}

export class CliLogins {
  private readonly sessions = new Map<string, Session>();
  /** CLI 마다 지금 도는 start(). 두 기기에서 함께 눌러도 CLI 를 둘 띄우지 않는다. */
  private readonly starting = new Map<CliAccountCli, Promise<CliLogin>>();
  private readonly accountCache = new Map<CliAccountCli, { at: number; read: Promise<AccountRead> }>();
  private closed = false;
  constructor(private readonly deps: CliLoginDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private log(line: string): void { (this.deps.log ?? ((l: string) => console.log(l)))(`[cli-login] ${line}`); }

  /** 두 CLI 의 지금 계정. force 면 캐시(1분)를 건너뛴다. */
  async accounts(force = false): Promise<CliAccount[]> {
    return Promise.all(CLI_LOGIN_CLIS.map(async cli => (await this.account(cli, force)).account));
  }

  private account(cli: CliAccountCli, force = false): Promise<AccountRead> {
    const cached = this.accountCache.get(cli);
    if (!force && cached && this.now() - cached.at < ACCOUNT_CACHE_MS) return cached.read;
    const read = (this.deps.readAccount ? this.deps.readAccount(cli)
      : cli === "claude" ? readClaudeAccount({ bin: this.deps.claudeBin, home: this.deps.claudeHome, env: this.deps.env, now: () => this.now() })
      : readCodexAccount({ bin: this.deps.codexBin, home: this.deps.codexHome, env: this.deps.env, now: () => this.now() }))
      .catch((): AccountRead => ({ account: emptyAccount(cli, true, this.now(), null, "cli_account_unreadable"), identity: null }));
    this.accountCache.set(cli, { at: this.now(), read });
    return read;
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
    // 타입 밖의 값(gemini 등)으로 불렸으면 Codex 로그인으로 흘려보내지 않고 거절한다.
    if (!isCliLoginCli(cli)) throw new CliLoginError(400, "cli_login_start_failed");
    if (this.closed) throw new CliLoginError(503, "cli_login_start_failed");
    const running = [...this.sessions.values()].find(s => s.view.cli === cli && ACTIVE.has(s.view.phase));
    if (running && !restart) return { ...running.view };
    if (running) await this.cancel(running.view.id);
    const bin = cli === "claude" ? this.deps.claudeBin : this.deps.codexBin;
    if (!bin || !binInstalled(bin)) throw new CliLoginError(409, "cli_login_cli_missing");
    // 로그인 전 계정(같은 계정을 다시 로그인한 것인지 견준다). 못 읽어도 로그인은 한다.
    const before = (await this.account(cli, true)).identity;
    // 기다리는 사이 서버가 끝나기 시작했으면 CLI 를 띄우지 않는다(끝난 뒤에 CLI 가 남는다).
    if (this.closed) throw new CliLoginError(503, "cli_login_start_failed");
    const now = this.now();
    const id = `cl_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const view: CliLogin = { id, cli, flow: cli === "claude" ? "paste_code" : "device_code", phase: "starting", startedAt: nowIso(now),
      expiresAt: nowIso(now + (this.deps.limitMs?.[cli] ?? (cli === "claude" ? CLAUDE_LOGIN_MS : CODEX_LOGIN_MS))),
      endedAt: null, url: null, localUrl: null, userCode: null, error: null, account: null, accountChanged: null, applied: null };
    const session: Session = { view, proc: null, stdout: "", stderr: "", state: null, urlFile: null, before, timer: null, ending: false, saved: false, done: Promise.resolve() };
    this.sessions.set(id, session);
    let argv: string[], extra: Record<string, string | undefined>;
    try {
      if (cli === "claude") {
        mkdirSync(this.deps.runDir, { recursive: true, mode: 0o700 });
        const script = join(this.deps.runDir, "cli-login-browser.sh");
        // CLI 가 여는 브라우저 대신 주소를 파일에 적는다(서버가 도는 Mac 의 앱이 연다). 대표의 브라우저를 서버가 열지 않는다.
        writeFileSync(script, `#!/bin/sh\n[ -n "$IAMCEO_LOGIN_URL_FILE" ] && printf '%s\\n' "$1" > "$IAMCEO_LOGIN_URL_FILE"\nexit 0\n`, { mode: 0o700 });
        chmodSync(script, 0o700);
        session.urlFile = join(this.deps.runDir, `cli-login-${id}.url`);
        argv = [bin, "auth", "login", "--claudeai"];
        extra = { CLAUDE_CONFIG_DIR: this.deps.claudeHome, BROWSER: script, IAMCEO_LOGIN_URL_FILE: session.urlFile };
      } else {
        argv = [bin, "login", "--device-auth"];
        extra = { CODEX_HOME: this.deps.codexHome };
      }
      session.proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: cliEnv(this.deps.env ?? process.env, extra) });
    } catch (e) {
      this.finish(session, "failed", { code: "cli_login_start_failed", message: `${ERROR_CODES.cli_login_start_failed.ko} (${(e as Error).message})` });
      return { ...session.view };
    }
    this.log(`${cli} 로그인 시작 ${id}`);
    session.timer = setTimeout(() => { void this.expire(id); }, Math.max(0, Date.parse(view.expiresAt) - now));
    session.done = this.watch(session);
    return { ...session.view };
  }

  /** Claude: 로그인 페이지가 보여 준 코드(또는 콜백 주소)를 CLI 에 넣는다. */
  async submitCode(id: string, input: string): Promise<CliLogin> {
    const s = this.sessions.get(id);
    if (!s) throw new CliLoginError(404, "cli_login_not_found");
    if (s.view.flow !== "paste_code") throw new CliLoginError(400, "cli_login_code_unsupported");
    if (s.view.phase !== "waiting" || !s.state || !s.proc) throw new CliLoginError(409, "cli_login_not_waiting");
    const normalized = normalizeClaudeCode(input, s.state);
    if (!normalized.ok) throw new CliLoginError(400, normalized.code);
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

  private async pipe(stream: ReadableStream<Uint8Array>, into: "stdout" | "stderr", s: Session): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (s[into].length < OUTPUT_LIMIT) s[into] += text;
        if (into === "stdout") this.onOutput(s);
      }
    } catch { /* 끝난 프로세스 */ }
  }

  private onOutput(s: Session): void {
    if (s.view.phase !== "starting") return;
    if (s.view.cli === "claude") {
      const parsed = parseClaudeLoginOutput(s.stdout);
      if (!parsed || !/Paste code here/i.test(s.stdout)) return;
      s.state = parsed.state;
      const localUrl = s.urlFile && existsSync(s.urlFile) ? parseClaudeLocalUrl(readFileSync(s.urlFile, "utf8")) : null;
      s.view = { ...s.view, phase: "waiting", url: parsed.url, localUrl };
    } else {
      const parsed = parseCodexDeviceOutput(s.stdout);
      if (!parsed) return;
      const expiresAt = parsed.minutes ? Math.min(Date.parse(s.view.expiresAt), this.now() + parsed.minutes * 60_000) : Date.parse(s.view.expiresAt);
      s.view = { ...s.view, phase: "waiting", url: parsed.url, userCode: parsed.userCode, expiresAt: nowIso(expiresAt) };
    }
  }

  /** 자동 주소는 CLI 가 붙여넣기 주소를 찍은 바로 뒤에 BROWSER 스크립트로 온다. 앱이 처음 물을 때 아직 없으면 그때 다시 본다. */
  private refreshLocalUrl(s: Session): void {
    if (s.view.cli !== "claude" || s.view.localUrl || !s.urlFile || !ACTIVE.has(s.view.phase)) return;
    try { if (existsSync(s.urlFile)) s.view = { ...s.view, localUrl: parseClaudeLocalUrl(readFileSync(s.urlFile, "utf8")) }; } catch { /* 다음에 다시 본다 */ }
  }

  private async watch(s: Session): Promise<void> {
    const proc = s.proc!;
    const out = this.pipe(proc.stdout as ReadableStream<Uint8Array>, "stdout", s);
    const err = this.pipe(proc.stderr as ReadableStream<Uint8Array>, "stderr", s);
    const code = await proc.exited;
    await Promise.all([out, err]);
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
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.view = { ...s.view, phase: "verifying" };
    const after = await this.account(s.view.cli, true);
    let applied: (CliLoginApplied & { changed: boolean | null }) | null = null;
    try { applied = await this.deps.onLoggedIn?.(s.view.cli, after.identity, s.before) ?? null; }
    catch (e) { this.log(`${s.view.cli} 새 계정 적용 실패: ${(e as Error).message}`); }
    const changed = applied?.changed ?? (after.identity && s.before ? after.identity !== s.before : null);
    s.view = { ...s.view, account: after.account, accountChanged: changed, applied: applied ? { reopenedNow: applied.reopenedNow, atNextTurn: applied.atNextTurn } : null };
    this.finish(s, "succeeded", null);
  }

  /** CLI 가 남긴 실패 글에서 대표에게 보일 까닭을 고른다(토큰·주소는 싣지 않는다). */
  private failure(cli: CliAccountCli, stdout: string, stderr: string): { code: string; message: string } {
    const text = `${stderr}\n${stdout}`;
    if (cli === "codex" && /device code login is not enabled/i.test(text)) return { code: "cli_login_device_disabled", message: ERROR_CODES.cli_login_device_disabled.ko };
    if (/timed out/i.test(text)) return { code: "cli_login_expired", message: ERROR_CODES.cli_login_expired.ko };
    if (cli === "claude" && /wasn't accepted|not accepted|invalid code|invalid_grant/i.test(text)) return { code: "cli_login_code_rejected", message: ERROR_CODES.cli_login_code_rejected.ko };
    const line = (/Login failed:\s*([^\n]+)/i.exec(stderr)?.[1] ?? /error[^\n]*/i.exec(stderr)?.[0] ?? "").replace(/https?:\/\/\S+/g, "").replace(/[A-Za-z0-9_-]{24,}/g, "…").trim().slice(0, 300);
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
