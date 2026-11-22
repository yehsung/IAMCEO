// 0.2.10 폰에서 Gemini(Antigravity CLI) 로그인: 서버가 이 Mac 에서 `agy acp --login`(파이프로 도는 붙여넣기 로그인)을 대신 띄우고,
// 대표가 어느 기기에서나 끝낼 수 있는 주소만 앱에 넘긴다. 진짜 agy 를 띄우지 않는다: 역분석한 출력 글자(조사 노트 parity/login)와 같은 글을 내는
// 가짜 실행 파일을 임시 폴더에 만든다. 대표 계정·키체인에 아무것도 쓰지 않는다. 출력 글자는 실제 로그인으로 아직 확인하지 않았다(UNVERIFIED-INTERACTIVE).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import { Bus } from "../server/bus.ts";
import {
  accountIdentity, CliLogins, geminiAuthUrl, geminiCliEnv, GEMINI_REDIRECT, normalizeGeminiCode, parseGeminiLoggedIn, parseGeminiLoginOutput,
  readGeminiAccount, readGeminiSetupPending, type CliLoginDeps,
} from "../server/cli-login.ts";
import { loadConfig, updateConfigFile, VERSION, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { latestGeminiPlan, startServer, type RunningServer } from "../server/http.ts";
import { geminiStatusFromPayload, geminiStatusPath } from "../server/runner/gemini-status.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import type { CliAccountsResponse, CliLogin, DecisionOption, Member } from "../shared/types.ts";
import { coreSetup, type CoreEnv } from "./fixtures/core-harness.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function temp(prefix: string): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }

const STATE = "c3RhdGUtZm9yLXRlc3Qtb25seQ";
const AUTH_URL = `https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=fake-client.apps.googleusercontent.com&code_challenge=fakechallenge&code_challenge_method=S256&prompt=consent&redirect_uri=${encodeURIComponent(GEMINI_REDIRECT)}&response_type=code&scope=openid+email&state=${STATE}`;
const CODE = "4/0AVGzR1Bfake-code_for.tests~only";
const CALLBACK = `${GEMINI_REDIRECT}?state=${STATE}&code=${encodeURIComponent(CODE)}&scope=email+openid`;
const EMAIL = "test@example.invalid";
/** runLogin 의 안내 글(역분석: fmt.Fprintf 한 번). */
const LOGIN_PROMPT = (url: string) => `Open this link in a browser to log in with Google:\n\n  ${url}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`;

/**
 * 가짜 agy. `models` 는 로그인 여부에 따라 모델 목록이나 인증 오류를, `acp --login` 은 브라우저를 `open`(PATH 에서 찾는 이름)으로 열고
 * 안내 글을 찍은 뒤 표준 입력 한 줄을 기다린다. 맞는 코드면 `Logged in as <메일>.` 을 찍고 0, 아니면 코드 교환 실패로 1.
 * FAKE_DIR 의 표시 파일로 모양을 바꾼다: mode-setup(첫 설정 물음), mode-unavailable(Google 로그인을 못 하는 설정), mode-nourl(출력에 주소 없음).
 */
const FAKE_AGY = `#!/bin/bash
D="$FAKE_DIR"
URL='${AUTH_URL}'
if [ "$1" = "models" ]; then
  pwd > "$D/models-cwd"; env > "$D/models-env"; echo x >> "$D/models-calls"
  if [ -f "$D/models-hang" ]; then sleep 30; fi
  if [ -f "$D/signed-out" ]; then echo "Fetching available models..." >&2; echo "Error: authentication failed: no saved credentials"; exit 1; fi
  echo "Fetching available models..." >&2
  printf 'gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n'
  exit 0
fi
if [ "$1" = "acp" ] && [ "$2" = "--login" ]; then
  echo "$*" > "$D/agy-args"; env > "$D/agy-env"; echo $$ > "$D/agy-pid"; pwd > "$D/agy-cwd"; command -v open > "$D/open-path"
  if [ -f "$D/mode-setup" ]; then
    printf 'Welcome to Antigravity CLI!\\n\\nTerms of Service & Data Use\\n[x] Yes, I agree to help improve Antigravity CLI\\n'
    read -r line; echo "$line" > "$D/agy-pasted"; exit 0
  fi
  if [ -f "$D/mode-unavailable" ]; then echo "Error: interactive Google sign-in isn't available in this configuration" >&2; exit 1; fi
  open "$URL"
  if [ -f "$D/mode-nourl" ]; then
    printf 'Open this link in a browser to log in with Google:\\n\\n  (opened in your browser)\\n\\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\\n'
  else
    printf 'Open this link in a browser to log in with Google:\\n\\n  %s\\n\\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\\n' "$URL"
  fi
  if ! read -r line || [ -z "$line" ]; then echo "Error: login cancelled: no authorization code was entered" >&2; exit 1; fi
  echo "$line" > "$D/agy-pasted"
  if [ "$line" = '${CODE}' ]; then echo "Logged in as ${EMAIL}."; exit 0; fi
  echo "Error: couldn't log in: oauth2: \\"invalid_grant\\" \\"Bad Request\\"" >&2
  exit 1
fi
exit 2
`;

function fakeAgy(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "agy"), FAKE_AGY); chmodSync(join(bin, "agy"), 0o755);
  return join(bin, "agy");
}

function fixture(extra: Partial<CliLoginDeps> = {}) {
  const dir = temp("iamceo-gemini-login-");
  const agy = fakeAgy(dir);
  const geminiHome = join(dir, "gemini-home");
  mkdirSync(join(geminiHome, "cache"), { recursive: true });
  const calls: Array<{ cli: string; after: string | null; before: string | null }> = [];
  const logs: string[] = [];
  const logins = new CliLogins({
    claudeBin: "/nonexistent/claude", codexBin: "/nonexistent/codex", geminiBin: agy, geminiHome, runDir: join(dir, "run"),
    // 서버를 SSH 세션에서 띄웠더라도 agy 에는 SSH_* 를 넘기지 않는다(넘기면 토큰이 키체인이 아닌 파일로 간다).
    env: { PATH: process.env.PATH, HOME: dir, USER: process.env.USER, FAKE_DIR: dir, IAMCEO_HOME: "/should/not/leak", HERDR_SOCKET_PATH: "/nope",
      SSH_CLIENT: "10.0.0.1 5555 22", SSH_TTY: "/dev/ttys009", SSH_CONNECTION: "10.0.0.1 5555 10.0.0.2 22", BROWSER: "/usr/bin/false" },
    geminiPlan: () => "pro",
    onLoggedIn: async (cli, after, before) => { calls.push({ cli, after, before }); return { changed: null, reopenedNow: 0, atNextTurn: 2, setupBlocked: 1 }; },
    log: line => logs.push(line),
    ...extra,
  });
  cleanups.push(() => logins.close());
  return { dir, agy, geminiHome, logins, calls, logs };
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
const envOf = (file: string) => Object.fromEntries(readFileSync(file, "utf8").split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
/** 폴더 아래 모든 보통 파일에서 글을 찾는다(메일이 디스크에 남지 않았는지). */
function filesContaining(root: string, needle: string, skip: (path: string) => boolean = () => false): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (skip(path)) continue;
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile() && readFileSync(path).includes(needle)) found.push(path);
    }
  };
  walk(root);
  return found;
}

describe("출력·코드 읽기", () => {
  test("로그인 주소: accounts.google.com, 돌아오는 곳이 antigravity.google/oauth-callback, state 가 있고 코드 물음까지 나와야 받는다", () => {
    expect(parseGeminiLoginOutput(LOGIN_PROMPT(AUTH_URL))).toEqual({ url: new URL(AUTH_URL).toString(), state: STATE });
    expect(parseGeminiLoginOutput(`\u001b[1m${LOGIN_PROMPT(AUTH_URL)}\u001b[0m`)?.state).toBe(STATE);
    // 물음이 아직 안 나왔다(표준 입력을 기다리는지 모른다).
    expect(parseGeminiLoginOutput(`Open this link in a browser to log in with Google:\n\n  ${AUTH_URL}\n`)).toBeNull();
    for (const bad of [AUTH_URL.replace("accounts.google.com", "accounts.google.com.evil.example"), AUTH_URL.replace("https://", "http://"),
      AUTH_URL.replace(encodeURIComponent(GEMINI_REDIRECT), encodeURIComponent("http://localhost:8080/cb")), AUTH_URL.replace(`&state=${STATE}`, "")]) {
      expect(parseGeminiLoginOutput(LOGIN_PROMPT(bad))).toBeNull();
    }
    expect(geminiAuthUrl(` ${AUTH_URL}\n`)?.state).toBe(STATE);
  });

  test("붙여넣은 것: 페이지의 코드 그대로·주소창에서 뗀 %2F 코드·도착한 페이지 주소 전체를 받아 코드만 넣는다. 다른 로그인의 주소·모양이 틀린 것은 거절", () => {
    expect(normalizeGeminiCode(CODE, STATE)).toEqual({ ok: true, line: CODE });
    expect(normalizeGeminiCode(`  ${CODE}\n`, STATE)).toEqual({ ok: true, line: CODE });
    expect(normalizeGeminiCode(encodeURIComponent(CODE), STATE)).toEqual({ ok: true, line: CODE });
    expect(normalizeGeminiCode(CALLBACK, STATE)).toEqual({ ok: true, line: CODE });
    expect(normalizeGeminiCode(CALLBACK.replace(STATE, "otherstate123"), STATE)).toEqual({ ok: false, code: "cli_login_code_other" });
    for (const bad of ["", "short", `${CODE} ; rm -rf ~`.replace(/ /g, "\u0000"), `${CODE}#x`, CALLBACK.replace("antigravity.google", "evil.example"),
      CALLBACK.replace("/oauth-callback", "/other"), CALLBACK.replace(`state=${STATE}&`, ""), "%E0%A4%A", "x".repeat(5000)]) {
      expect([bad.slice(0, 40), normalizeGeminiCode(bad, STATE).ok]).toEqual([bad.slice(0, 40), false]);
    }
  });

  test("성공 글의 메일, 첫 설정 표시(onboarding.json 의 완료 표시만 읽는다)", () => {
    expect(parseGeminiLoggedIn(`Logged in as ${EMAIL}.\n`)).toBe(EMAIL);
    expect(parseGeminiLoggedIn(`\u001b[32mLogged in as ${EMAIL}\u001b[0m\n`)).toBe(EMAIL);
    expect(parseGeminiLoggedIn("Logged in.\n")).toBeNull();
    expect(parseGeminiLoggedIn("Logged in as someone without mail.\n")).toBeNull();
    const home = temp("iamceo-gemini-onboarding-");
    expect(readGeminiSetupPending(home)).toBeNull();
    mkdirSync(join(home, "cache"));
    const file = join(home, "cache", "onboarding.json");
    writeFileSync(file, JSON.stringify({ onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false }));
    expect(readGeminiSetupPending(home)).toBe(true);
    writeFileSync(file, JSON.stringify({ onboardingComplete: false, consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, email: EMAIL }));
    expect(readGeminiSetupPending(home)).toBe(false);
    for (const bad of ["{", "null", "[]", JSON.stringify({ other: true })]) { writeFileSync(file, bad); expect(readGeminiSetupPending(home)).toBeNull(); }
  });

  test("agy 를 띄우는 환경: PATH 맨 앞이 가짜 open 폴더, SSH_*·BROWSER·IAMCEO·herdr 값은 넘기지 않는다", () => {
    const run = temp("iamceo-gemini-env-");
    const env = geminiCliEnv({ PATH: "/usr/bin:/bin", HOME: "/h", SSH_CLIENT: "a", SSH_TTY: "b", SSH_CONNECTION: "c", BROWSER: "x", IAMCEO_HOME: "/x", HERDR_SOCKET_PATH: "/s" }, run, {}, () => "tester");
    expect(env.PATH).toBe(`${join(run, "agy-open")}:/usr/bin:/bin`);
    expect(env).toMatchObject({ HOME: "/h", USER: "tester", NO_COLOR: "1" });
    for (const k of ["SSH_CLIENT", "SSH_TTY", "SSH_CONNECTION", "BROWSER", "IAMCEO_HOME", "HERDR_SOCKET_PATH"]) expect(env[k]).toBeUndefined();
    const shim = join(run, "agy-open", "open");
    expect(statSync(shim).mode & 0o777).toBe(0o700);
    expect(readFileSync(shim, "utf8")).toContain("IAMCEO_LOGIN_URL_FILE");
  });
});

describe("계정 줄(`agy models`)", () => {
  test("모델이 오면 로그인됨(요금제는 상태줄 기록에서), 인증 오류면 로그인 안 됨, 시간을 넘기면 모름. 메일·지문은 늘 비어 있다", async () => {
    const t = fixture();
    writeFileSync(join(t.geminiHome, "cache", "onboarding.json"), JSON.stringify({ onboardingComplete: false, consumerOnboardingComplete: false, enterpriseOnboardingComplete: false }));
    const base = { bin: t.agy, geminiHome: t.geminiHome, runDir: join(t.dir, "run"), env: { PATH: process.env.PATH, HOME: t.dir, FAKE_DIR: t.dir, SSH_TTY: "/dev/ttys1" }, plan: () => "pro" };
    const read = await readGeminiAccount(base);
    expect(read).toEqual({ identity: null, account: { cli: "gemini", installed: true, loggedIn: true, email: null, organization: null, plan: "pro", method: null, checkedAt: expect.any(String), setupPending: true } });
    // 프로젝트 폴더가 아니라 빈 폴더에서, 가짜 open 을 앞에 둔 PATH 로 띄운다.
    expect(readFileSync(join(t.dir, "models-cwd"), "utf8").trim()).toBe(realpathSync(join(t.dir, "run", "agy-login")));
    const env = envOf(join(t.dir, "models-env"));
    expect(env.PATH!.startsWith(`${join(t.dir, "run", "agy-open")}:`)).toBe(true);
    expect(env.SSH_TTY).toBeUndefined();
    writeFileSync(join(t.dir, "signed-out"), "");
    expect((await readGeminiAccount(base)).account).toMatchObject({ loggedIn: false, plan: null });
    writeFileSync(join(t.dir, "models-hang"), "");
    expect((await readGeminiAccount({ ...base, timeoutMs: 300 })).account).toMatchObject({ loggedIn: null, problem: "cli_account_unreadable" });
    expect((await readGeminiAccount({ ...base, bin: join(t.dir, "nope") })).account).toMatchObject({ installed: false, loggedIn: null, problem: "cli_login_cli_missing" });
  }, 20_000);
});

describe("Gemini 로그인(`agy acp --login`)", () => {
  test("주소가 나오면 waiting. 다른 로그인의 주소는 거절, 도착한 페이지 주소를 붙여넣으면 코드만 표준 입력에 넣고, 끝나면 메일은 이 로그인의 응답에만 싣는다", async () => {
    const t = fixture();
    const started = await t.logins.start("gemini");
    expect(started).toMatchObject({ cli: "gemini", flow: "paste_code", phase: "starting", url: null, localUrl: null, userCode: null });
    const waiting = await until("주소", () => { const v = t.logins.get(started.id); return v.phase === "waiting" ? v : null; });
    expect(waiting).toMatchObject({ url: new URL(AUTH_URL).toString(), localUrl: null });
    expect(Date.parse(waiting.expiresAt) - Date.parse(waiting.startedAt)).toBe(15 * 60_000);
    // 띄운 방식: `acp --login`, 빈 폴더, PATH 맨 앞의 가짜 open(대표의 브라우저를 열지 않는다), SSH_*·서버 안 값은 넘기지 않는다.
    expect(readFileSync(join(t.dir, "agy-args"), "utf8").trim()).toBe("acp --login");
    expect(readFileSync(join(t.dir, "agy-cwd"), "utf8").trim()).toBe(realpathSync(join(t.dir, "run", "agy-login")));
    expect(readFileSync(join(t.dir, "open-path"), "utf8").trim()).toBe(join(t.dir, "run", "agy-open", "open"));
    const env = envOf(join(t.dir, "agy-env"));
    for (const k of ["SSH_CLIENT", "SSH_TTY", "SSH_CONNECTION", "BROWSER", "IAMCEO_HOME", "HERDR_SOCKET_PATH"]) expect(`${k}=${env[k] ?? "(없음)"}`).toBe(`${k}=(없음)`);
    expect(env.USER).toBe(process.env.USER!);
    expect(env.IAMCEO_LOGIN_URL_FILE).toBe(join(t.dir, "run", `cli-login-${started.id}.url`));
    // 가짜 open 이 브라우저 대신 주소를 받았다.
    await until("가짜 open", () => existsSync(env.IAMCEO_LOGIN_URL_FILE!));
    expect(readFileSync(env.IAMCEO_LOGIN_URL_FILE!, "utf8").trim()).toBe(AUTH_URL);
    // 같은 CLI 를 다시 시작하면 진행 중인 것을 돌려준다.
    expect((await t.logins.start("gemini")).id).toBe(started.id);
    await expect(t.logins.submitCode(started.id, CALLBACK.replace(STATE, "otherstate123"))).rejects.toMatchObject({ status: 400, code: "cli_login_code_other" });
    await expect(t.logins.submitCode(started.id, "그냥 글")).rejects.toMatchObject({ status: 400, code: "cli_login_code_invalid" });
    expect(existsSync(join(t.dir, "agy-pasted"))).toBe(false);
    const verifying = await t.logins.submitCode(started.id, ` ${CALLBACK}\n`);
    expect(verifying.phase).toBe("verifying");
    await t.logins.settled(started.id);
    expect(readFileSync(join(t.dir, "agy-pasted"), "utf8").trim()).toBe(CODE);
    const done = t.logins.get(started.id);
    expect(done).toMatchObject({ phase: "succeeded", error: null, accountChanged: null, applied: { reopenedNow: 0, atNextTurn: 2, setupBlocked: 1 },
      account: { cli: "gemini", installed: true, loggedIn: true, email: EMAIL, plan: "pro" } });
    // 오케스트레이터에는 메일이 아니라 지문만 간다. 앞 계정은 모른다(agy 에 계정을 묻는 명령이 없다).
    expect(t.calls).toEqual([{ cli: "gemini", after: accountIdentity("gemini", [EMAIL]), before: null }]);
    expect(t.calls[0]!.after).toMatch(/^[0-9a-f]{32}$/);
    // 끝난 뒤에는 코드를 받지 않는다. 주소 파일은 지운다. 로그에 코드·state·메일을 남기지 않는다.
    await expect(t.logins.submitCode(started.id, CODE)).rejects.toMatchObject({ status: 409, code: "cli_login_not_waiting" });
    expect(existsSync(env.IAMCEO_LOGIN_URL_FILE!)).toBe(false);
    const logs = t.logs.join("\n");
    for (const secret of [CODE, STATE, EMAIL, "4/0A"]) expect([secret, logs.includes(secret)]).toEqual([secret, false]);
    // 계정 줄에는 메일이 없다(그 로그인의 응답에만). 서버가 만든 파일 어디에도 메일이 없다.
    expect(await t.logins.geminiAccount()).toMatchObject({ cli: "gemini", loggedIn: true, email: null });
    expect(filesContaining(join(t.dir, "run"), EMAIL)).toEqual([]);
  }, 20_000);

  test("코드를 거절하면 cli_login_code_rejected, 적용은 부르지 않는다", async () => {
    const t = fixture();
    const started = await t.logins.start("gemini");
    await until("주소", () => t.logins.get(started.id).phase === "waiting");
    await t.logins.submitCode(started.id, "4/0AVGzR1Bwrong-code-xyz");
    await t.logins.settled(started.id);
    expect(t.logins.get(started.id)).toMatchObject({ phase: "failed", error: { code: "cli_login_code_rejected" }, account: null });
    expect(t.calls).toEqual([]);
  }, 20_000);

  test("첫 설정(약관·데이터 수집 동의)을 물으면 키를 하나도 넣지 않고 끝낸다: cli_login_gemini_setup", async () => {
    const t = fixture();
    writeFileSync(join(t.dir, "mode-setup"), "");
    const started = await t.logins.start("gemini");
    await until("실패", () => t.logins.get(started.id).phase === "failed");
    expect(t.logins.get(started.id).error?.code).toBe("cli_login_gemini_setup");
    const pid = Number(readFileSync(join(t.dir, "agy-pid"), "utf8"));
    await until("agy 끝남", () => !pidAlive(pid));
    expect(existsSync(join(t.dir, "agy-pasted"))).toBe(false);
    await expect(t.logins.submitCode(started.id, CODE)).rejects.toMatchObject({ status: 409, code: "cli_login_not_waiting" });
    expect(t.calls).toEqual([]);
  }, 20_000);

  test("Google 계정 로그인을 못 하는 설정(API 키·ADC 등)이면 cli_login_gemini_unavailable", async () => {
    const t = fixture();
    writeFileSync(join(t.dir, "mode-unavailable"), "");
    const started = await t.logins.start("gemini");
    await until("실패", () => t.logins.get(started.id).phase === "failed");
    expect(t.logins.get(started.id).error?.code).toBe("cli_login_gemini_unavailable");
  }, 20_000);

  test("출력에서 주소를 읽지 못해도 코드 물음이 나오면 가짜 open 이 받은 주소를 쓴다", async () => {
    const t = fixture();
    writeFileSync(join(t.dir, "mode-nourl"), "");
    const started = await t.logins.start("gemini");
    const waiting = await until("주소", () => { const v = t.logins.get(started.id); return v.phase === "waiting" ? v : null; });
    expect(waiting.url).toBe(new URL(AUTH_URL).toString());
    await t.logins.submitCode(started.id, CODE);
    await t.logins.settled(started.id);
    expect(t.logins.get(started.id)).toMatchObject({ phase: "succeeded", account: { email: EMAIL } });
  }, 20_000);

  test("그만두면 agy 를 끝내고 주소 파일을 남기지 않는다. 시간을 넘기면 expired", async () => {
    const t = fixture({ limitMs: { gemini: 1_500 } });
    const first = await t.logins.start("gemini");
    await until("주소", () => t.logins.get(first.id).phase === "waiting");
    const pid = Number(readFileSync(join(t.dir, "agy-pid"), "utf8"));
    expect(pidAlive(pid)).toBe(true);
    expect((await t.logins.cancel(first.id)).phase).toBe("cancelled");
    await until("agy 끝남", () => !pidAlive(pid));
    expect(existsSync(join(t.dir, "run", `cli-login-${first.id}.url`))).toBe(false);
    const second = await t.logins.start("gemini");
    await until("시간 초과", () => t.logins.get(second.id).phase === "expired", 6_000);
    expect(t.logins.get(second.id).error?.code).toBe("cli_login_expired");
    expect(t.calls).toEqual([]);
  }, 20_000);

  test("agy 가 없으면 409, Gemini 줄도 싣지 않는다", async () => {
    const t = fixture({ geminiBin: "/nonexistent/agy" });
    await expect(t.logins.start("gemini")).rejects.toMatchObject({ status: 409, code: "cli_login_cli_missing" });
    expect(t.logins.geminiShown()).toBe(false);
    expect(await t.logins.geminiAccount()).toBeNull();
  });
});

// ---- HTTP ----
function freshConfig(): Config {
  const home = temp("iamceo-gemini-login-http-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  return { ...loadConfig(env), hosts: ["127.0.0.1"], hostsAuto: true };
}
async function boot(logins: CliLogins) {
  const config = freshConfig();
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const orch = new Orchestrator({ config, store, runners: new Map(), notifier: () => {} });
  const context = { config, store, bus, orch, detectHosts: () => [], daemon: () => ({ ready: true, buildId: "build", version: VERSION }), cliLogins: logins };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); store.db.close(); });
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { Authorization: "Bearer code", "Content-Type": "application/json", ...init.headers } });
  return { config, request, orch };
}

describe("Gemini 줄의 요금제", () => {
  test("Gemini 팀장 상태줄 기록 가운데 기준 시각 뒤에 쓰인 최신 plan_tier. 다른 CLI 팀장의 기록·메일은 보지 않는다", () => {
    const config = freshConfig();
    const store = new Store(openDb(config.dbPath), new Bus());
    cleanups.push(() => store.db.close());
    const project = store.createProject({ name: "요금제", cwd: config.home });
    const a = store.createMember({ projectId: project.id, handle: "a", name: "가", kind: "worker", cli: "gemini" });
    const b = store.createMember({ projectId: project.id, handle: "b", name: "나", kind: "worker", cli: "gemini" });
    const c = store.createMember({ projectId: project.id, handle: "c", name: "다", kind: "worker", cli: "claude" });
    const write = (id: string, plan: string, at: string) => {
      const path = geminiStatusPath(config.home, id);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(geminiStatusFromPayload(id, { plan_tier: plan, email: EMAIL }, new Date(at))));
    };
    expect(latestGeminiPlan(store, config.home, 0)).toBeNull();
    write(a.id, "Free", "2026-11-22T01:00:00.000Z");
    write(b.id, "Pro", "2026-11-22T02:00:00.000Z");
    write(c.id, "Ultra", "2026-11-22T03:00:00.000Z");
    expect(latestGeminiPlan(store, config.home, 0)).toBe("Pro");
    // 마지막 로그인 뒤에 쓰인 기록이 없으면(아직 앞 계정으로 떠 있다) 보이지 않는다.
    expect(latestGeminiPlan(store, config.home, Date.parse("2026-11-22T02:00:00.000Z"))).toBeNull();
    expect(latestGeminiPlan(store, config.home, Date.parse("2026-11-22T01:30:00.000Z"))).toBe("Pro");
    expect(readFileSync(geminiStatusPath(config.home, b.id), "utf8")).not.toContain(EMAIL);
  });
});

describe("GET /api/cli-accounts · /api/cli-login (Gemini)", () => {
  test("agy 가 깔려 있으면 새 칸 allAccounts·allLogins 에만 Gemini 를 싣는다(옛 칸은 Claude·Codex 그대로). 앱 흐름대로 시작·붙여넣기·끝. 메일은 DB 에 남지 않는다", async () => {
    // Claude·Codex 자리는 없는 실행 파일이다(그 줄은 '설치되어 있지 않음'). 로그인이 끝나면 실제 오케스트레이터가 세대를 올린다.
    let orch: Orchestrator | null = null;
    const t = fixture({ onLoggedIn: (cli, after, before) => orch!.cliLoggedIn(cli, after, before) });
    const h = await boot(t.logins);
    orch = h.orch;
    const accounts = await (await h.request("/api/cli-accounts?refresh=1")).json() as CliAccountsResponse;
    expect(Object.keys(accounts).sort()).toEqual(["accounts", "allAccounts", "allLogins", "logins"]);
    expect(accounts.accounts.map(a => [a.cli, a.installed])).toEqual([["claude", false], ["codex", false]]);
    expect(accounts.allAccounts!.slice(0, 2)).toEqual(accounts.accounts);
    expect(accounts.allAccounts!.map(a => a.cli)).toEqual(["claude", "codex", "gemini"]);
    expect(accounts.allAccounts![2]).toMatchObject({ cli: "gemini", installed: true, loggedIn: true, email: null, plan: "pro" });
    const res = await h.request("/api/cli-login", { method: "POST", body: JSON.stringify({ cli: "gemini" }) });
    expect(res.status).toBe(200);
    const login = await res.json() as CliLogin;
    // Claude 로그인과 같은 모양(칸을 더하지 않는다).
    expect(Object.keys(login).sort()).toEqual(["account", "accountChanged", "applied", "cli", "endedAt", "error", "expiresAt", "flow", "id", "localUrl", "phase", "startedAt", "url", "userCode"]);
    await until("주소", () => t.logins.get(login.id).phase === "waiting");
    const listed = await (await h.request("/api/cli-accounts")).json() as CliAccountsResponse;
    expect(listed.logins).toEqual([]);
    expect(listed.allLogins!.map(l => [l.cli, l.phase])).toEqual([["gemini", "waiting"]]);
    const polled = await (await h.request(`/api/cli-login/${login.id}`)).json() as CliLogin;
    expect(polled).toMatchObject({ phase: "waiting", url: new URL(AUTH_URL).toString(), flow: "paste_code" });
    const other = await h.request(`/api/cli-login/${login.id}/code`, { method: "POST", body: JSON.stringify({ code: CALLBACK.replace(STATE, "otherstate123") }) });
    expect([other.status, ((await other.json()) as { code?: string }).code]).toEqual([400, "cli_login_code_other"]);
    expect((await h.request(`/api/cli-login/${login.id}/code`, { method: "POST", body: JSON.stringify({ code: CODE }) })).status).toBe(200);
    await t.logins.settled(login.id);
    const done = await (await h.request(`/api/cli-login/${login.id}`)).json() as CliLogin;
    // 오케스트레이터(팀장 없음)가 세대를 올리고 수를 센다. 앞 계정을 몰랐으니 changed 는 null.
    expect(done).toMatchObject({ phase: "succeeded", accountChanged: null, account: { cli: "gemini", email: EMAIL }, applied: { reopenedNow: 0, atNextTurn: 0, setupBlocked: 0 } });
    const saved = h.orch.store.loadApiRecovery<Record<string, { epoch: number; identity: string | null }>>("cli_accounts");
    expect(saved?.gemini).toEqual({ epoch: 1, identity: accountIdentity("gemini", [EMAIL]) });
    // 메일 원문은 서버의 DB·데이터 폴더 어디에도 없다(지문만).
    h.orch.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(filesContaining(h.config.home, EMAIL)).toEqual([]);
  }, 30_000);
});

// ---- 오케스트레이터: 로그인 뒤 떠 있는 Gemini 팀장 ----
const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
    if (name === "ask") return { text: (await orch.registerAsk(member, args as { title: string; detail?: string; options?: DecisionOption[] })).text };
    return { text: "모르는 도구", isError: true };
  },
};
const FAST = { tickMs: 150, healthMs: 40, retryMs: 30, inputBusyRetryMs: 30, writeSettleMs: 40, startGraceMs: 200, blockedNoticeMs: 60 };
const QUIET_MS = 700;
async function setup(): Promise<CoreEnv> {
  const t = await coreSetup({ agentTools: TOOLS, timings: FAST });
  cleanups.push(() => t.close());
  return t;
}
async function geminiWorker(t: CoreEnv, name: string, handle: string): Promise<Member> {
  const w = (await t.orch.addMember(t.project.id, { name, handle, role: name, cli: "gemini" })).member;
  await t.orch.assign(t.project.id, w.handle, { text: `준비 @fake:post=${handle}준비` });
  await t.waitFor("첫 보고", () => t.texts().some((m) => m.title === `${handle}준비`));
  await t.waitFor("대화 id", () => t.member(w.id).sessionId);
  await t.idle(w.id);
  return t.member(w.id);
}
const epochs = (t: CoreEnv) => t.store.loadApiRecovery<Record<string, { epoch: number; identity: string | null }>>("cli_accounts");

describe("Gemini 로그인 뒤 떠 있는 팀장", () => {
  test("앞 계정을 모르면 세대를 올려 쉬는 Gemini 팀장을 같은 대화(--conversation)로 다시 연다. Claude 팀장은 그대로, 같은 계정을 다시 로그인하면 다시 열지 않는다", async () => {
    const t = await setup();
    const g = await geminiWorker(t, "자료 조사", "research");
    const c = (await t.orch.addMember(t.project.id, { name: "화면 개발", handle: "ui", role: "개발", cli: "claude" })).member;
    await t.idle(c.id);
    const gRuns = t.runs(g.id).length, cRuns = t.runs(c.id).length;

    const first = await t.orch.cliLoggedIn("gemini", "g-account", null);
    expect(first).toEqual({ changed: null, reopenedNow: 0, atNextTurn: 1, setupBlocked: 0 });
    await t.orch.accountReopening;
    await t.waitFor("Gemini 팀장 다시 열림", () => t.runs(g.id).length === gRuns + 1);
    expect(t.runs(g.id).at(-1)).toMatchObject({ cli: "gemini", conversationFlag: g.sessionId });
    expect(epochs(t)?.gemini).toEqual({ epoch: 1, identity: "g-account" });
    expect(epochs(t)?.claude.epoch).toBe(0);
    await t.waitFor("적용 기록", () => t.store.getAppliedConfig(g.id)?.account === 1);
    await t.idle(g.id);
    // 계정만 바뀐 것: 인계 글을 넣지 않는다.
    expect(t.store.listDeliveries(t.project.id).filter(d => d.memberId === g.id && /설정 변경|같은 세션을 새 설정으로/.test(d.text))).toEqual([]);
    await Bun.sleep(QUIET_MS);
    expect(t.runs(c.id)).toHaveLength(cRuns);

    // 같은 계정으로 다시: 세대 그대로, 다시 열지 않는다. 다른 계정이면 changed true.
    expect(await t.orch.cliLoggedIn("gemini", "g-account", null)).toEqual({ changed: false, reopenedNow: 0, atNextTurn: 0, setupBlocked: 0 });
    await t.orch.accountReopening;
    await Bun.sleep(QUIET_MS);
    expect(t.runs(g.id)).toHaveLength(gRuns + 1);
    // Claude 로그인은 Gemini 팀장을 다시 열지 않는다(세대가 CLI 마다 따로다).
    expect((await t.orch.cliLoggedIn("claude", "c-new", "c-old")).changed).toBe(true);
    await t.orch.accountReopening;
    await Bun.sleep(QUIET_MS);
    expect(t.runs(g.id)).toHaveLength(gRuns + 1);
    expect((await t.orch.cliLoggedIn("gemini", "g-other", null)).changed).toBe(true);
    expect(epochs(t)?.gemini).toEqual({ epoch: 2, identity: "g-other" });
  }, 60_000);

  test("로그인·첫 설정 화면에서 멈춘 Gemini 팀장은 건드리지 않고(키·끝내기 없음) 수만 센다. 그 화면이 끝나 쉬는 중이 되면 새 계정으로 다시 연다", async () => {
    const t = await setup();
    const g = await geminiWorker(t, "자료 조사", "research");
    t.core.setStatus(g.id, { state: "blocked", kind: "question", msg: Buffer.from("Finish setup").toString("base64") });
    await t.waitFor("막힘", () => t.member(g.id).status === "blocked" && t.member(g.id).blockedCode === "gemini_setup");
    const runs = t.runs(g.id).length;
    const written = () => [t.core.count("terminal.send"), t.core.count("terminal.keys"), t.core.count("terminal.interrupt"), t.core.count("terminal.kill")];
    const before = written();
    const result = await t.orch.cliLoggedIn("gemini", "g-account", null);
    expect(result).toEqual({ changed: null, reopenedNow: 0, atNextTurn: 0, setupBlocked: 1 });
    await t.orch.accountReopening;
    await Bun.sleep(QUIET_MS);
    expect(written()).toEqual(before);
    expect(t.runs(g.id)).toHaveLength(runs);
    // 대표가 터미널에서 그 화면을 끝냈다: 쉬는 중이 되면 펌프가 같은 대화를 새 계정 세대로 다시 연다.
    t.core.setStatus(g.id, { state: "idle" });
    await t.waitFor("다시 열림", () => t.runs(g.id).length === runs + 1, 20_000);
    expect(t.runs(g.id).at(-1)).toMatchObject({ conversationFlag: g.sessionId });
  }, 60_000);
});
