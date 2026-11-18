// 0.2.8 AI 계정 로그인(server/cli-login.ts): 서버가 이 Mac 에서 CLI 의 로그인 명령을 대신 띄우고, 대표가 어느 기기에서나 끝낼 수 있는 것만 앱에 넘긴다.
// 진짜 claude·codex 를 띄우지 않는다. 실측(Claude Code 2.1.323 `claude auth login`, Codex 0.166 `codex login --device-auth`)과 같은 출력을 내는
// 가짜 실행 파일을 임시 폴더에 만든다. 대표 계정·키체인에 아무것도 쓰지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { cliEnv, CliLogins, normalizeClaudeCode, parseClaudeLocalUrl, parseClaudeLoginOutput, parseCodexDeviceOutput, readCodexAccount, stripAnsi, type CliLoginDeps } from "../server/cli-login.ts";
import { loadConfig, updateConfigFile, VERSION, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import type { CliAccountsResponse, CliLogin } from "../shared/types.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function temp(prefix: string): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }

const STATE = "STATEabcdef123456";
const MANUAL = `https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=fakechallenge&code_challenge_method=S256&state=${STATE}`;
const AUTOMATIC = `https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A58581%2Fcallback&scope=user%3Ainference&code_challenge=fakechallenge&code_challenge_method=S256&state=${STATE}`;
const GOOD = `GOODCODE1234567#${STATE}`;

/** 실측 출력 그대로의 가짜 claude. 붙여넣은 줄이 GOOD 이면 로그인(상태 파일을 바꾼다), 아니면 실측의 거절 글로 끝난다. */
const FAKE_CLAUDE = `#!/bin/bash
D="$FAKE_DIR"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then cat "$D/claude-status.json"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo "$*" > "$D/claude-args"; env > "$D/claude-env"; echo $$ > "$D/claude-pid"
  "$BROWSER" '${AUTOMATIC}'
  echo "Opening browser to sign in…"
  echo "If the browser didn't open, visit: ${MANUAL}"
  printf "Paste code here if prompted > "
  read -r line
  echo "$line" > "$D/claude-pasted"
  if [ "$line" = "${GOOD}" ]; then cp "$D/claude-status-after.json" "$D/claude-status.json"; echo "Login successful."; exit 0; fi
  echo "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code." >&2
  exit 1
fi
exit 2
`;
/** 실측(0.166) 그대로의 색 글자를 내는 가짜 codex. 시험이 파일을 놓으면 로그인을 끝낸다. */
const FAKE_CODEX = `#!/bin/bash
D="$FAKE_DIR"
if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then
  echo "$*" > "$D/codex-args"; env > "$D/codex-env"
  printf '\\nWelcome to Codex [v\\033[90m0.166.0\\033[0m]\\n\\033[90mOpenAI'"'"'s command-line coding agent\\033[0m\\n\\nFollow these steps to sign in with ChatGPT using device code authorization:\\n\\n1. Open this link in your browser and sign in to your account\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n\\n2. Enter this one-time code \\033[90m(expires in 15 minutes)\\033[0m\\n   \\033[94mPPYN-794W3\\033[0m\\n\\n'
  for i in $(seq 1 600); do
    if [ -f "$D/codex-approve" ]; then cp "$D/codex-auth-after.json" "$CODEX_HOME/auth.json"; echo "Successfully logged in"; exit 0; fi
    if [ -f "$D/codex-disabled" ]; then echo "Error: device code login is not enabled for this Codex server. Use the browser login or verify the server URL." >&2; exit 1; fi
    sleep 0.05
  done
  exit 1
fi
exit 2
`;

const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const codexAuth = (email: string, plan: string, accountId: string) => JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
  tokens: { id_token: jwt({ email, "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: accountId } }), access_token: "a", refresh_token: "r", account_id: accountId }, last_refresh: "2026-11-18T00:00:00Z" });

function fixture(extra: Partial<CliLoginDeps> = {}) {
  const dir = temp("iamceo-cli-login-");
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE); chmodSync(join(bin, "claude"), 0o755);
  writeFileSync(join(bin, "codex"), FAKE_CODEX); chmodSync(join(bin, "codex"), 0o755);
  const codexHome = join(dir, "codex-home"); mkdirSync(codexHome);
  writeFileSync(join(dir, "claude-status.json"), JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "old@example.com", orgId: "org-old", orgName: "Old Org", subscriptionType: "max" }));
  writeFileSync(join(dir, "claude-status-after.json"), JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "new@example.com", orgId: "org-new", orgName: "New Org", subscriptionType: "pro" }));
  writeFileSync(join(codexHome, "auth.json"), codexAuth("old@example.com", "plus", "acct-old"));
  writeFileSync(join(dir, "codex-auth-after.json"), codexAuth("new@example.com", "prolite", "acct-new"));
  const calls: Array<{ cli: string; after: string | null; before: string | null }> = [];
  const logs: string[] = [];
  const logins = new CliLogins({
    claudeBin: join(bin, "claude"), codexBin: join(bin, "codex"), claudeHome: join(dir, "claude-home"), codexHome, runDir: join(dir, "run"),
    env: { PATH: process.env.PATH, HOME: dir, USER: process.env.USER, FAKE_DIR: dir, IAMCEO_HOME: "/should/not/leak", HERDR_SOCKET_PATH: "/nope", CLAUDECODE: "1" },
    onLoggedIn: async (cli, after, before) => { calls.push({ cli, after, before }); return { changed: after !== before, reopenedNow: 1, atNextTurn: 2 }; },
    log: line => logs.push(line),
    ...extra,
  });
  cleanups.push(() => logins.close());
  return { dir, codexHome, logins, calls, logs };
}

async function until<T>(what: string, get: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`기다림 시간 초과: ${what}`);
    await Bun.sleep(20);
  }
}
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("출력 읽기", () => {
  test("Claude: 붙여넣기 주소와 state 만 받는다. localhost 로 돌아오는 주소·다른 곳의 주소는 받지 않는다", () => {
    expect(parseClaudeLoginOutput(`Opening browser to sign in…\nIf the browser didn't open, visit: ${MANUAL}\nPaste code here if prompted > `)).toEqual({ url: MANUAL, state: STATE });
    expect(parseClaudeLoginOutput(`The browser can't return the sign-in to Claude Code automatically. After you sign in, paste the code shown.\nSign in at: ${MANUAL}\nPaste code here > `)?.state).toBe(STATE);
    expect(parseClaudeLoginOutput(`visit: ${AUTOMATIC}`)).toBeNull();
    expect(parseClaudeLoginOutput(`visit: ${MANUAL.replace("claude.com", "claude.com.evil.example")}`)).toBeNull();
    expect(parseClaudeLoginOutput(`visit: ${MANUAL.replace("https://", "http://")}`)).toBeNull();
    expect(parseClaudeLocalUrl(`${AUTOMATIC}\n`)).toBe(AUTOMATIC);
    expect(parseClaudeLocalUrl(MANUAL)).toBeNull();
  });
  test("Codex: 색 글자를 걷어 내고 페이지·일회용 코드·남은 분을 읽는다", () => {
    const out = "\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mPPYN-794W3\u001b[0m\n";
    expect(parseCodexDeviceOutput(out)).toEqual({ url: "https://auth.openai.com/codex/device", userCode: "PPYN-794W3", minutes: 15 });
    expect(parseCodexDeviceOutput("Starting local login server on http://localhost:1455")).toBeNull();
    expect(stripAnsi("\u001b[94mX\u001b[0m")).toBe("X");
  });
  test("붙여넣은 코드: 페이지의 코드#state, 앞뒤 빈칸·줄바꿈, 콜백 주소 전체를 받는다. state 가 다르면 다른 로그인, 모양이 틀리면 거절", () => {
    expect(normalizeClaudeCode(GOOD, STATE)).toEqual({ ok: true, line: GOOD });
    expect(normalizeClaudeCode(`  ${GOOD}\n`, STATE)).toEqual({ ok: true, line: GOOD });
    expect(normalizeClaudeCode(`https://platform.claude.com/oauth/code/callback?code=GOODCODE1234567&state=${STATE}`, STATE)).toEqual({ ok: true, line: GOOD });
    expect(normalizeClaudeCode("GOODCODE1234567#OTHERSTATE12345", STATE)).toEqual({ ok: false, code: "cli_login_code_other" });
    for (const bad of ["", "GOODCODE1234567", "a#b", `GOOD CODE#${STATE}x;rm`, `${GOOD}#extra`, `https://evil.example/cb?code=GOODCODE1234567&state=${STATE}`]) {
      expect(normalizeClaudeCode(bad, STATE)).toMatchObject({ ok: false });
    }
  });
  test("Codex 계정 파일: id_token 의 메일·요금제. 파일이 없으면(키체인에 둔 설정) codex login status 로 로그인 여부만 보고 계정은 모른다", async () => {
    const home = temp("iamceo-codex-auth-");
    expect((await readCodexAccount({ home })).account).toMatchObject({ cli: "codex", loggedIn: null });
    // 파일 없이 키체인에 둔 Codex: 로그인 여부만, 계정 지문은 없다.
    const bin = join(home, "codex-status");
    // 실측(0.166): 결과를 표준 오류로 찍고, 로그인 안 됨이면 1 로 끝난다.
    writeFileSync(bin, `#!/bin/bash\n[ "$1 $2" = "login status" ] && { [ -f "$CODEX_HOME/out" ] && { cat "$CODEX_HOME/out" >&2; exit 1; } || { echo "Logged in using ChatGPT" >&2; exit 0; }; }\nexit 2\n`); chmodSync(bin, 0o755);
    expect(await readCodexAccount({ home, bin })).toMatchObject({ account: { loggedIn: true, method: "chatgpt", email: null }, identity: null });
    writeFileSync(join(home, "out"), "Not logged in\n");
    expect((await readCodexAccount({ home, bin })).account.loggedIn).toBe(false);
    writeFileSync(join(home, "auth.json"), codexAuth("me@example.com", "prolite", "acct-1"));
    const read = await readCodexAccount({ home, bin: "/bin/sh" });
    expect(read.account).toMatchObject({ cli: "codex", installed: true, loggedIn: true, email: "me@example.com", plan: "prolite", method: "chatgpt" });
    expect(read.identity).toMatch(/^[0-9a-f]{32}$/);
    writeFileSync(join(home, "auth.json"), codexAuth("me@example.com", "prolite", "acct-2"));
    expect((await readCodexAccount({ home, bin: "/bin/sh" })).identity).not.toBe(read.identity);
  });
  test("CLI 환경: 서버가 USER 없이 떴어도 채운다(키체인 'unknown' 항목 사고). IAMCEO·herdr·바깥 Claude Code 의 값은 넘기지 않는다", () => {
    const env = cliEnv({ PATH: "/usr/bin", HOME: "/h", IAMCEO_HOME: "/x", HERDR_SOCKET_PATH: "/s", HC_SOCKET: "/c", CLAUDECODE: "1", CLAUDE_CODE_SSE_PORT: "1234" }, { CODEX_HOME: "/cx", CLAUDE_CONFIG_DIR: undefined }, () => "tester");
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/h", USER: "tester", LOGNAME: "tester", CODEX_HOME: "/cx", NO_COLOR: "1" });
    for (const k of ["IAMCEO_HOME", "HERDR_SOCKET_PATH", "HC_SOCKET", "CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CONFIG_DIR"]) expect(env[k]).toBeUndefined();
    expect(cliEnv({ USER: "owner" }, {}, () => "other").USER).toBe("owner");
  });
});

describe("Claude 로그인(붙여넣기 코드)", () => {
  test("주소가 나오면 waiting, 다른 로그인의 코드는 거절, 맞는 코드는 CLI 표준 입력에 넣고 끝나면 새 계정을 읽어 적용한다", async () => {
    const t = fixture();
    const started = await t.logins.start("claude");
    expect(started).toMatchObject({ cli: "claude", flow: "paste_code", phase: "starting", url: null });
    const waiting = await until("주소", () => { const v = t.logins.get(started.id); return v.phase === "waiting" ? v : null; });
    expect(waiting.url).toBe(MANUAL);
    const local = await until("자동 주소", () => t.logins.get(started.id).localUrl);
    expect(local).toBe(AUTOMATIC);
    // CLI 를 띄운 방식: 구독 로그인, 브라우저 대신 주소를 받는 스크립트, 설정 폴더. 서버 안의 환경 변수는 넘기지 않는다.
    expect(readFileSync(join(t.dir, "claude-args"), "utf8").trim()).toBe("auth login --claudeai");
    const env = readFileSync(join(t.dir, "claude-env"), "utf8");
    expect(env).toContain(`CLAUDE_CONFIG_DIR=${join(t.dir, "claude-home")}`);
    expect(env).toContain(`BROWSER=${join(t.dir, "run", "cli-login-browser.sh")}`);
    expect(env).not.toContain("IAMCEO_HOME=");
    expect(env).not.toContain("HERDR_SOCKET_PATH=");
    expect(env).not.toMatch(/^CLAUDECODE=/m);
    // 같은 CLI 를 다시 시작하면 진행 중인 것을 돌려준다.
    expect((await t.logins.start("claude")).id).toBe(started.id);
    // 다른 로그인의 코드·모양이 틀린 것은 CLI 에 넣지 않는다.
    await expect(t.logins.submitCode(started.id, "GOODCODE1234567#OTHERSTATE12345")).rejects.toMatchObject({ status: 400, code: "cli_login_code_other" });
    await expect(t.logins.submitCode(started.id, "그냥 글")).rejects.toMatchObject({ status: 400, code: "cli_login_code_invalid" });
    expect(existsSync(join(t.dir, "claude-pasted"))).toBe(false);
    const verifying = await t.logins.submitCode(started.id, ` ${GOOD} `);
    expect(verifying.phase).toBe("verifying");
    await t.logins.settled(started.id);
    const done = t.logins.get(started.id);
    expect(readFileSync(join(t.dir, "claude-pasted"), "utf8").trim()).toBe(GOOD);
    expect(done).toMatchObject({ phase: "succeeded", error: null, accountChanged: true, applied: { reopenedNow: 1, atNextTurn: 2 },
      account: { cli: "claude", loggedIn: true, email: "new@example.com", organization: "New Org", plan: "pro", method: "claude.ai" } });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.cli).toBe("claude");
    expect(t.calls[0]!.after).not.toBe(t.calls[0]!.before);
    // 끝난 뒤에는 코드를 받지 않는다. 자동 주소 파일은 지운다. 로그에 코드·주소를 남기지 않는다.
    await expect(t.logins.submitCode(started.id, GOOD)).rejects.toMatchObject({ status: 409, code: "cli_login_not_waiting" });
    expect(existsSync(join(t.dir, "run", `cli-login-${started.id}.url`))).toBe(false);
    expect(t.logs.join("\n")).not.toContain("GOODCODE");
    expect(t.logs.join("\n")).not.toContain(STATE);
    // 계정 목록도 새 계정이다.
    expect((await t.logins.accounts()).find(a => a.cli === "claude")).toMatchObject({ email: "new@example.com" });
  }, 20_000);

  test("CLI 가 코드를 거절하면 실패(다시 시작하게 한다). 적용은 부르지 않는다", async () => {
    const t = fixture();
    const started = await t.logins.start("claude");
    await until("주소", () => t.logins.get(started.id).phase === "waiting");
    await t.logins.submitCode(started.id, `BADCODE12345678#${STATE}`);
    await t.logins.settled(started.id);
    expect(t.logins.get(started.id)).toMatchObject({ phase: "failed", error: { code: "cli_login_code_rejected" }, account: null });
    expect(t.calls).toHaveLength(0);
  }, 20_000);

  test("그만두면 CLI 를 끝낸다. restart 면 앞 로그인을 끝내고 새로 띄운다. 시간을 넘기면 expired", async () => {
    const t = fixture({ limitMs: { claude: 1_500 } });
    const first = await t.logins.start("claude");
    await until("주소", () => t.logins.get(first.id).phase === "waiting");
    const pid = Number(readFileSync(join(t.dir, "claude-pid"), "utf8"));
    expect(pidAlive(pid)).toBe(true);
    const second = await t.logins.start("claude", true);
    expect(second.id).not.toBe(first.id);
    expect(t.logins.get(first.id).phase).toBe("cancelled");
    await until("앞 CLI 끝남", () => !pidAlive(pid));
    await until("주소", () => t.logins.get(second.id).phase === "waiting");
    const cancelled = await t.logins.cancel(second.id);
    expect(cancelled.phase).toBe("cancelled");
    const third = await t.logins.start("claude");
    await until("시간 초과", () => t.logins.get(third.id).phase === "expired", 6_000);
    expect(t.logins.get(third.id).error?.code).toBe("cli_login_expired");
    await expect(t.logins.submitCode("cl_nope", GOOD)).rejects.toMatchObject({ status: 404, code: "cli_login_not_found" });
  }, 20_000);

  test("두 기기에서 함께 시작해도 CLI 는 하나만 띄운다", async () => {
    const t = fixture();
    const [a, b] = await Promise.all([t.logins.start("claude"), t.logins.start("claude")]);
    expect(a.id).toBe(b.id);
    expect(t.logins.list().filter(l => l.cli === "claude")).toHaveLength(1);
  }, 20_000);

  test("CLI 가 새 계정을 저장한 뒤(확인 중)에는 그만두기·서버 끝남이 와도 팀장에게 적용하고 성공으로 끝난다", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const t = fixture({ readAccount: async (cli) => {
      reads++;
      if (cli === "claude" && reads > 1) await gate;
      return { account: { cli, installed: true, loggedIn: true, email: reads > 1 ? "new@example.com" : "old@example.com", organization: null, plan: null, method: null, checkedAt: new Date().toISOString() }, identity: reads > 1 ? "new" : "old" };
    } });
    const started = await t.logins.start("claude");
    await until("주소", () => t.logins.get(started.id).phase === "waiting");
    await t.logins.submitCode(started.id, GOOD);
    await until("CLI 끝남", () => existsSync(join(t.dir, "claude-pasted")) && t.calls.length === 0 && reads > 1);
    const cancelled = await t.logins.cancel(started.id);
    expect(cancelled.phase).toBe("verifying");
    const closing = t.logins.close();
    release();
    await closing;
    expect(t.logins.get(started.id)).toMatchObject({ phase: "succeeded", accountChanged: true, account: { email: "new@example.com" } });
    expect(t.calls).toEqual([{ cli: "claude", after: "new", before: "old" }]);
  }, 20_000);

  test("CLI 가 없으면 409", async () => {
    const t = fixture({ claudeBin: "/nonexistent/claude" });
    await expect(t.logins.start("claude")).rejects.toMatchObject({ status: 409, code: "cli_login_cli_missing" });
  });
});

describe("Codex 로그인(기기 코드)", () => {
  test("페이지와 일회용 코드를 보이고, 대표가 로그인하면 CLI 가 스스로 끝낸다. 붙여넣기는 받지 않는다", async () => {
    const t = fixture();
    const started = await t.logins.start("codex");
    const waiting = await until("코드", () => { const v = t.logins.get(started.id); return v.phase === "waiting" ? v : null; });
    expect(waiting).toMatchObject({ flow: "device_code", url: "https://auth.openai.com/codex/device", userCode: "PPYN-794W3", localUrl: null });
    expect(Date.parse(waiting.expiresAt) - Date.parse(waiting.startedAt)).toBeLessThanOrEqual(15 * 60_000 + 1000);
    expect(readFileSync(join(t.dir, "codex-env"), "utf8")).toContain(`CODEX_HOME=${t.codexHome}`);
    await expect(t.logins.submitCode(started.id, GOOD)).rejects.toMatchObject({ status: 400, code: "cli_login_code_unsupported" });
    writeFileSync(join(t.dir, "codex-approve"), "");
    await t.logins.settled(started.id);
    expect(t.logins.get(started.id)).toMatchObject({ phase: "succeeded", accountChanged: true, account: { cli: "codex", email: "new@example.com", plan: "prolite" } });
    expect(t.calls.map(c => c.cli)).toEqual(["codex"]);
  }, 20_000);

  test("기기 코드 로그인이 꺼져 있으면 그 까닭으로 실패한다", async () => {
    const t = fixture();
    const started = await t.logins.start("codex");
    await until("코드", () => t.logins.get(started.id).phase === "waiting");
    writeFileSync(join(t.dir, "codex-disabled"), "");
    await t.logins.settled(started.id);
    expect(t.logins.get(started.id)).toMatchObject({ phase: "failed", error: { code: "cli_login_device_disabled" } });
  }, 20_000);
});

// ---- HTTP ----
function freshConfig(): Config {
  const home = temp("iamceo-cli-login-http-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  return { ...loadConfig(env), hosts: ["127.0.0.1"], hostsAuto: true };
}
async function boot(logins?: CliLogins) {
  const config = freshConfig();
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const orch = new Orchestrator({ config, store, runners: new Map(), notifier: () => {} });
  const context = { config, store, bus, orch, detectHosts: () => [], daemon: () => ({ ready: true, buildId: "build", version: VERSION }), ...(logins ? { cliLogins: logins } : {}) };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); store.db.close(); });
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { Authorization: "Bearer code", "Content-Type": "application/json", ...init.headers } });
  return { server, request, orch };
}

describe("GET /api/cli-accounts · /api/cli-login", () => {
  test("인증이 필요하고, 계정·로그인 모양을 약속대로 준다. 코드 붙여넣기·그만두기·모르는 로그인·잘못된 요청", async () => {
    const t = fixture();
    const h = await boot(t.logins);
    expect((await fetch(`http://127.0.0.1:${h.server.port}/api/cli-accounts`)).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${h.server.port}/api/cli-login`, { method: "POST", body: JSON.stringify({ cli: "claude" }) })).status).toBe(401);
    const accounts = await (await h.request("/api/cli-accounts?refresh=1")).json() as CliAccountsResponse;
    expect(Object.keys(accounts).sort()).toEqual(["accounts", "logins"]);
    expect(accounts.accounts.map(a => a.cli)).toEqual(["claude", "codex"]);
    expect(accounts.accounts[0]).toMatchObject({ cli: "claude", installed: true, loggedIn: true, email: "old@example.com", organization: "Old Org", plan: "max" });
    expect(accounts.accounts[1]).toMatchObject({ cli: "codex", loggedIn: true, email: "old@example.com", plan: "plus" });
    expect((await h.request("/api/cli-accounts?x=1")).status).toBe(400);

    for (const bad of [{ cli: "gemini" }, {}, { cli: "claude", extra: 1 }]) expect((await h.request("/api/cli-login", { method: "POST", body: JSON.stringify(bad) })).status).toBe(400);
    const res = await h.request("/api/cli-login", { method: "POST", body: JSON.stringify({ cli: "claude" }) });
    expect(res.status).toBe(200);
    const login = await res.json() as CliLogin;
    expect(Object.keys(login).sort()).toEqual(["account", "accountChanged", "applied", "cli", "endedAt", "error", "expiresAt", "flow", "id", "localUrl", "phase", "startedAt", "url", "userCode"]);
    await until("주소", () => t.logins.get(login.id).phase === "waiting");
    const polled = await (await h.request(`/api/cli-login/${login.id}`)).json() as CliLogin;
    expect(polled).toMatchObject({ phase: "waiting", url: MANUAL });
    const other = await h.request(`/api/cli-login/${login.id}/code`, { method: "POST", body: JSON.stringify({ code: "GOODCODE1234567#OTHERSTATE12345" }) });
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ code: "cli_login_code_other" });
    expect((await h.request(`/api/cli-login/cl_nope`)).status).toBe(404);
    expect((await (await h.request("/api/cli-accounts")).json() as CliAccountsResponse).logins.map(l => l.id)).toEqual([login.id]);
    const cancelled = await h.request(`/api/cli-login/${login.id}`, { method: "DELETE" });
    expect((await cancelled.json() as CliLogin).phase).toBe("cancelled");
  }, 20_000);

  test("시험 서버가 만든 로그인 서비스가 없으면 501(진짜 CLI 로 로그인하지 않는다)", async () => {
    const h = await boot();
    expect((await h.request("/api/cli-accounts")).status).toBe(501);
  });
});
