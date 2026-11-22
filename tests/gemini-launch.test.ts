// Gemini(Antigravity CLI, `agy`) 띄우기: 명령줄(providerLaunch), 주입 폴더(규칙 조각·MCP·훅), --settings 값, 실행 파일 이름 표.
// 실제 agy 는 실행하지 않는다. 실행 파일 자리는 가짜 경로이고, 파일은 임시 폴더에만 쓴다.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMINI_LAUNCH_LABEL, isProviderArgv, providerBin, providerFor, providerLaunch } from "../server/runner/providers.ts";
import { GEMINI_MCP_LAUNCHER, GEMINI_RULE_CHUNK_BYTES, GEMINI_RULE_FILE_MAX_BYTES, geminiInjectDir, geminiMcpEnvText, geminiRuleFile, geminiSettings, geminiWorkspaceRule, parseGeminiMcpEnv, readGeminiMcpBridge, splitGeminiRules, writeGeminiInjectDir } from "../server/runner/gemini-inject.ts";
import { GEMINI_HOOKS_NAME, geminiHookEventsDir } from "../server/runner/gemini-hooks.ts";
import { GEMINI_STATUSLINE_MARKER, geminiStatusLineLaunch } from "../server/runner/gemini-statusline.ts";
import { CoreError } from "../server/runner/core-client.ts";
import type { RunnerMember, StartOpts } from "../server/runner/types.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-gln-"))); dirs.push(dir); return dir; }
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const member = (extra: Partial<RunnerMember> = {}): RunnerMember => ({ id: "m_lead1", sessionGeneration: 1, projectId: "p_one", cli: "gemini", handle: "lead", name: "결제 연동", cwd: "/tmp", sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "bypassPermissions", kind: "worker", ...extra });
const RULES = "너는 '시험' 프로젝트의 팀장이다.\n\n## 입력 구분\n- 첫 줄의 접두어가 출처다.\n\n## 보고\n- 끝나면 post 로 보고한다.\n";
/** 서버가 팀장마다 쓰는 실행 파일 자리(run/<id>.rules.md, run/<id>.mcp.json)와 같은 모양. */
function runFiles(home: string, id = "m_lead1", rules = RULES): StartOpts {
  const run = join(home, "run");
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const opts: StartOpts = { systemPromptFile: join(run, `${id}.rules.md`), mcpConfigFile: join(run, `${id}.mcp.json`), resume: false };
  writeFileSync(opts.systemPromptFile, rules);
  writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: ["bridge", "a'b"], env: { IAMCEO_TOKEN: `secret-${id}`, IAMCEO_URL: "http://127.0.0.1:1" } } } }), { mode: 0o600 });
  return opts;
}
const flag = (argv: string[], name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };

describe("splitGeminiRules: 역할 지침을 규칙 조각으로", () => {
  const joined = (text: string, max?: number) => { const chunks = splitGeminiRules(text, max); expect(chunks.join("")).toBe(text); return chunks; };
  test("짧은 지침은 한 조각, 빈 글은 조각 없음", () => {
    expect(joined(RULES)).toEqual([RULES]);
    expect(splitGeminiRules("")).toEqual([]);
    expect(joined("한 줄")).toEqual(["한 줄"]);
    expect(joined("\n\n")).toEqual(["\n\n"]);
  });
  test("`## ` 제목 앞에서 끊고, 이어진 절은 상한 안에서 함께 담는다", () => {
    const section = (name: string, size: number) => `## ${name}\n${"가".repeat(size)}\n`;
    const text = `머리말\n\n${section("하나", 900)}${section("둘", 900)}${section("셋", 900)}${section("넷", 900)}`;
    const chunks = joined(text);
    // 한 절이 약 2.7KB 라 8,000바이트에 두 절씩(머리말 포함) 들어간다.
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) expect(bytes(chunk)).toBeLessThanOrEqual(GEMINI_RULE_CHUNK_BYTES);
    expect(chunks[0]!.startsWith("머리말")).toBe(true);
    expect(chunks[1]!.startsWith("## 셋\n")).toBe(true);
    // `### ` 는 절 경계가 아니다.
    const nested = `## 가\n### 나\n${"x".repeat(50)}\n## 다\n`;
    expect(joined(nested, 70)).toEqual([`## 가\n### 나\n${"x".repeat(50)}\n`, "## 다\n"]);
  });
  test("실제 크기(약 27KB, 한글)의 지침: 모두 8,000바이트 이하이고 이으면 원문과 같다", () => {
    const sections = Array.from({ length: 14 }, (_, i) => `## 절 ${i + 1}\n${Array.from({ length: 12 }, (_, j) => `- 규칙 ${i + 1}.${j + 1}: 직원 보고에 대표 승인·확인·결정이 필요한 다음 단계가 있으면 결재함에 그 카드가 열려 있는지 확인한다.`).join("\n")}\n\n`);
    const text = `너는 '{{PROJECT}}' 프로젝트의 총괄이다.\n\n${sections.join("")}`;
    expect(bytes(text)).toBeGreaterThan(24_000);
    const chunks = joined(text);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(GEMINI_RULE_CHUNK_BYTES);
      // 조각마다 온전한 UTF-8 이다(한글 한 글자의 바이트를 가르지 않았다).
      expect(Buffer.from(chunk, "utf8").toString("utf8")).toBe(chunk);
      expect(chunk.includes("�")).toBe(false);
    }
    // 첫 조각 뒤의 조각은 절 제목에서 시작한다.
    for (const chunk of chunks.slice(1)) expect(chunk.startsWith("## 절 ")).toBe(true);
  });
  test("한 절이 상한을 넘으면 줄 경계에서 더 끊는다", () => {
    const line = `- ${"한글 규칙 ".repeat(40)}\n`; // 약 600바이트
    const text = `## 긴 절\n${line.repeat(40)}## 다음 절\n짧다\n`;
    const chunks = joined(text);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const chunk of chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(GEMINI_RULE_CHUNK_BYTES);
      // 줄 중간에서 끊지 않았다: 마지막 조각이 아니면 줄바꿈으로 끝난다.
      expect(chunk.endsWith("\n")).toBe(true);
    }
    expect(chunks.at(-1)).toBe("## 다음 절\n짧다\n");
  });
  test("한 줄이 상한을 넘으면 글자 경계에서 끊는다(바이트 경계에서 한글이 깨지지 않는다)", () => {
    // 3바이트 글자와 4바이트 글자(이모지)를 섞어 경계가 글자 중간에 걸리게 한다.
    const long = `${"가나다".repeat(3000)}😀${"라".repeat(2999)}`;
    const text = `## 줄바꿈 없는 절\n${long}`;
    for (const max of [GEMINI_RULE_CHUNK_BYTES, 1000, 7, 4]) {
      const chunks = joined(text, max);
      for (const chunk of chunks) {
        expect(bytes(chunk)).toBeLessThanOrEqual(max);
        expect(chunk.includes("�")).toBe(false);
        // 짝이 끊긴 대리 문자가 없다.
        expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(chunk)).toBe(false);
      }
    }
  });
  test("어떤 글이든 조각을 이으면 원문과 같고 상한을 넘지 않는다", () => {
    const samples = ["a", "\n", "## \n", "## 가\n## 나\n## 다", "끝에 줄바꿈 없음\n## 제목", "\r\n## 윈도 줄바꿈\r\n글\r\n", `${"x".repeat(7999)}\n## y\n`, `${"x".repeat(8000)}\n${"y".repeat(8001)}`,
      Array.from({ length: 500 }, (_, i) => (i % 7 === 0 ? `## 절 ${i}` : `줄 ${i} ${"한".repeat(i % 90)}`)).join("\n")];
    for (const text of samples) {
      for (const max of [GEMINI_RULE_CHUNK_BYTES, 64, 16]) {
        const chunks = joined(text, max);
        for (const chunk of chunks) { expect(bytes(chunk)).toBeLessThanOrEqual(max); expect(chunk.length).toBeGreaterThan(0); }
      }
    }
    expect(() => splitGeminiRules("x", 3)).toThrow();
    expect(() => splitGeminiRules("x", 1.5)).toThrow();
  });
  test("규칙 파일은 머리말(항상 켜짐)과 본문이고, 24,000바이트를 넘지 않는다", () => {
    expect(geminiRuleFile("본문\n", 2, 4)).toBe(`---\ntrigger: always_on\ndescription: "IAMCEO 역할 지침 2/4"\n---\n\n본문\n`);
    const biggest = geminiRuleFile("가".repeat(Math.floor(GEMINI_RULE_CHUNK_BYTES / 3)), 99, 99);
    expect(bytes(biggest)).toBeLessThan(GEMINI_RULE_FILE_MAX_BYTES);
    expect(GEMINI_RULE_CHUNK_BYTES).toBe(8000);
    expect(GEMINI_RULE_FILE_MAX_BYTES).toBe(24_000);
  });
});

describe("실행 파일 이름: provider 값이 아니라 표(agy)", () => {
  test("gemini 의 기본 실행 파일은 agy 다. `gemini` 라는 명령은 어디에도 쓰지 않는다", () => {
    expect(providerBin("gemini", {})).toBe("agy");
    expect(providerBin("gemini", { geminiBin: "/opt/agy/bin/agy" })).toBe("/opt/agy/bin/agy");
    expect(providerBin("claude", {})).toBe("claude");
    expect(providerBin("codex", { codexBin: "/x/codex" })).toBe("/x/codex");
    // 다른 CLI 의 설정값을 쓰지 않는다.
    expect(providerBin("gemini", { claudeBin: "/x/claude", codexBin: "/x/codex" })).toBe("agy");
    expect(providerFor(member())).toBe("gemini");
    expect(providerFor(member({ cli: undefined }))).toBe("claude");
  });
  test("isProviderArgv: agy 이거나 설정한 실행 파일이면 gemini 터미널이다", () => {
    expect(isProviderArgv(["/opt/homebrew/bin/agy", "--add-dir", "/x"], "gemini")).toBe(true);
    expect(isProviderArgv(["agy"], "gemini")).toBe(true);
    expect(isProviderArgv(["/custom/antigravity"], "gemini", "/custom/antigravity")).toBe(true);
    // 값 이름("gemini")은 실행 파일 이름이 아니다: 옛 Gemini CLI 를 gemini 팀장의 터미널로 보지 않는다.
    expect(isProviderArgv(["/Users/x/.npm-global/bin/gemini"], "gemini")).toBe(false);
    expect(isProviderArgv(["/usr/local/bin/codex"], "gemini")).toBe(false);
    expect(isProviderArgv(["/usr/local/bin/codex"], "gemini", "/fake/agy")).toBe(false);
    expect(isProviderArgv([], "gemini", "/fake/agy")).toBe(false);
    // Claude·Codex 는 그대로다.
    expect(isProviderArgv(["/usr/local/bin/claude"], "claude")).toBe(true);
    expect(isProviderArgv(["/usr/local/bin/codex", "resume"], "codex")).toBe(true);
    expect(isProviderArgv(["/usr/local/bin/agy"], "claude")).toBe(false);
    expect(isProviderArgv(["/usr/local/bin/agy"], "codex", "/fake/codex")).toBe(false);
    expect(isProviderArgv(["/fake/claude"], "claude", "/fake/claude")).toBe(true);
  });
  test("실행 파일을 찾지 못하면 띄우지 않는다(다른 CLI 로 떨어지지 않는다)", () => {
    const home = temp();
    expect(() => providerLaunch(member(), runFiles(home), { geminiBin: "iamceo-no-such-agy-binary", codexBin: "/fake/codex", claudeBin: "/fake/claude" })).toThrow("gemini executable not found: iamceo-no-such-agy-binary");
  });
});

describe("providerLaunch(gemini): 명령줄과 환경", () => {
  test("새 세션: --add-dir·--settings, 권한 플래그, 환경(OSC·팀장 id), 세션 id 는 null", () => {
    const home = temp(), opts = runFiles(home);
    const launch = providerLaunch(member({ cwd: home }), opts, { geminiBin: "/fake/agy", contextHome: home });
    const inject = join(home, "run", "agy", "m_lead1");
    expect(launch.argv[0]).toBe("/fake/agy");
    expect(launch.argv.slice(1, 3)).toEqual(["--add-dir", inject]);
    expect(launch.argv[3]).toBe("--settings");
    expect(launch.argv.slice(5)).toEqual(["--dangerously-skip-permissions"]);
    expect(launch.env).toEqual({ AGY_CLI_OSC7501: "on", IAMCEO_MEMBER_ID: "m_lead1" });
    expect(launch.sessionId).toBeNull();
    // 열쇠는 명령줄·환경에 없다(주입 폴더 밖의 MCP 환경 파일에만 있다).
    expect(launch.argv.join(" ")).not.toContain("secret-m_lead1");
    expect(JSON.stringify(launch.env)).not.toContain("secret");
    // Claude·Codex 의 인자가 섞이지 않는다.
    for (const foreign of ["--session-id", "--resume", "--append-system-prompt-file", "--mcp-config", "--permission-mode", "--allowedTools", "-c", "resume", "--ask-for-approval", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "--conversation", "--model", "--effort", "--mode"]) {
      expect(launch.argv).not.toContain(foreign);
    }
    const settings = JSON.parse(launch.argv[4]!) as Record<string, any>;
    expect(settings.trustedWorkspaces).toEqual([home, inject]);
    expect(settings.permissions).toEqual({ allow: ["mcp(iamceo/*)"] });
    expect(settings).toMatchObject({ showTips: false, showFeedbackSurvey: false, notifications: false, queuedMessages: "queue" });
    expect(settings.statusLine.type).toBe("command");
    expect(settings.statusLine.command).toContain(`${GEMINI_STATUSLINE_MARKER}.mjs`);
    expect(settings.statusLine.command).toContain(`'${home}' 'm_lead1'`);
    // 띄우기 값: 띄울 때마다 새 임의 값을 터미널 라벨과 상태줄 명령의 인자에 함께 싣는다. Codex 의 묶기 라벨(iamceo.binding)은 쓰지 않는다.
    expect(Object.keys(launch.labels!)).toEqual([GEMINI_LAUNCH_LABEL]);
    expect(GEMINI_LAUNCH_LABEL).toBe("iamceo.launch");
    expect(launch.labels![GEMINI_LAUNCH_LABEL]).toMatch(/^[0-9a-f]{32}$/);
    expect(geminiStatusLineLaunch(settings.statusLine.command)).toBe(launch.labels![GEMINI_LAUNCH_LABEL]!);
    const again = providerLaunch(member({ cwd: home }), opts, { geminiBin: "/fake/agy", contextHome: home });
    expect(again.labels![GEMINI_LAUNCH_LABEL]).not.toBe(launch.labels![GEMINI_LAUNCH_LABEL]);
    expect(geminiStatusLineLaunch(JSON.parse(again.argv[4]!).statusLine.command)).toBe(again.labels![GEMINI_LAUNCH_LABEL]!);
    expect("agentMode" in settings).toBe(false);
    // settings.json 에 없는 키(hooks·MCP)는 넣지 않는다.
    expect(Object.keys(settings).sort()).toEqual(["notifications", "permissions", "queuedMessages", "showFeedbackSurvey", "showTips", "statusLine", "trustedWorkspaces"]);
  });
  test("권한: 묻지 않기 → --dangerously-skip-permissions, auto → 플래그 없이 agentMode \"auto\"(대신하는 모드면 accept-edits + 샌드박스), 전부 묻기 → 플래그 없이 agentMode \"\"", () => {
    const home = temp(), opts = runFiles(home), bins = { geminiBin: "/fake/agy", contextHome: home };
    const auto = providerLaunch(member({ permissionMode: "auto" }), opts, bins);
    // `--mode auto` 는 로그인 전에 판정해 auto 를 쓸 수 있는 계정에도 경고를 찍는다(1.5.14 실측). 설정 칸은 경고 없이 같은 결과다.
    expect(auto.argv).not.toContain("--mode");
    expect(auto.argv).not.toContain("--dangerously-skip-permissions");
    expect(auto.argv.at(-2)).toBe("--settings");
    const autoSettings = JSON.parse(flag(auto.argv, "--settings")!);
    expect(autoSettings.agentMode).toBe("auto");
    expect("enableTerminalSandbox" in autoSettings || "toolPermission" in autoSettings).toBe(false);
    const fallback = providerLaunch(member({ permissionMode: "auto", geminiAutoFallback: true }), opts, bins);
    expect(fallback.argv).not.toContain("--mode");
    expect(JSON.parse(flag(fallback.argv, "--settings")!)).toMatchObject({ agentMode: "accept-edits", enableTerminalSandbox: true, toolPermission: "proceed-in-sandbox" });
    // 대신하는 모드 칸은 권한 auto 에서만 뜻이 있다.
    expect(JSON.parse(flag(providerLaunch(member({ permissionMode: "default", geminiAutoFallback: true }), opts, bins).argv, "--settings")!).agentMode).toBe("");
    expect("agentMode" in JSON.parse(flag(providerLaunch(member({ permissionMode: "bypassPermissions", geminiAutoFallback: true }), opts, bins).argv, "--settings")!)).toBe(false);
    const ask = providerLaunch(member({ permissionMode: "default" }), opts, bins);
    expect(ask.argv).not.toContain("--mode");
    expect(ask.argv).not.toContain("--dangerously-skip-permissions");
    expect(JSON.parse(flag(ask.argv, "--settings")!).agentMode).toBe("");
    expect(ask.argv.at(-2)).toBe("--settings");
  });
  test("모델·effort 는 그대로 넘기고, 서브에이전트 모델과 Claude 용 설정 파일은 쓰지 않는다", () => {
    const home = temp(), opts = runFiles(home);
    const claudeSettings = join(home, "run", "m_lead1.settings.json");
    writeFileSync(claudeSettings, JSON.stringify({ statusLine: { type: "command", command: "claude-statusline" }, skipDangerousModePermissionPrompt: true }));
    const launch = providerLaunch(member({ model: "gemini-4-neon", effort: "high", subagentModel: "gemini-3.8-flash" }), { ...opts, settingsFile: claudeSettings }, { geminiBin: "/fake/agy", contextHome: home });
    expect(flag(launch.argv, "--model")).toBe("gemini-4-neon");
    expect(flag(launch.argv, "--effort")).toBe("high");
    expect(launch.argv.join(" ")).not.toContain("gemini-3.8-flash");
    expect(launch.argv.join(" ")).not.toContain("claude-statusline");
    expect(launch.argv.join(" ")).not.toContain("skipDangerousModePermissionPrompt");
    expect(Object.keys(launch.env).sort()).toEqual(["AGY_CLI_OSC7501", "IAMCEO_MEMBER_ID"]);
    // 순서: [--conversation] --add-dir --settings [--model] [--effort] [권한]
    expect(launch.argv.filter(arg => arg.startsWith("--"))).toEqual(["--add-dir", "--settings", "--model", "--effort", "--dangerously-skip-permissions"]);
  });
  test("모델을 정하지 않았으면 effort 도 넘기지 않는다(모델 없이 --effort 만 주면 agy 가 사용자의 기본 모델로 판정해 뜨지 못할 수 있다)", () => {
    const home = temp(), opts = runFiles(home), bins = { geminiBin: "/fake/agy", contextHome: home };
    // 1.5.14 실측: `agy --effort max`(모델 없음) → exit 1 `gemini-4-neon has no "max" effort`. 기본 모델은 사용자마다 다르다.
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const launch = providerLaunch(member({ model: null, effort }), opts, bins);
      expect(launch.argv).not.toContain("--effort");
      expect(launch.argv).not.toContain("--model");
      expect(launch.argv).not.toContain(effort);
      expect(launch.argv.filter(arg => arg.startsWith("--"))).toEqual(["--add-dir", "--settings", "--dangerously-skip-permissions"]);
    }
    // 이어 열 때도 같다.
    const resumed = providerLaunch(member({ model: null, effort: "max", sessionId: "f0469d2b-813c-4d72-9c13-f80e0a315968" }), { ...opts, resume: true }, bins);
    expect(resumed.argv.filter(arg => arg.startsWith("--"))).toEqual(["--conversation", "--add-dir", "--settings", "--dangerously-skip-permissions"]);
    // 모델만 정하고 effort 를 정하지 않으면 모델만 넘긴다.
    const modelOnly = providerLaunch(member({ model: "gemini-4-argon", effort: null }), opts, bins);
    expect(flag(modelOnly.argv, "--model")).toBe("gemini-4-argon");
    expect(modelOnly.argv).not.toContain("--effort");
    // Claude·Codex 는 지금처럼 모델 없이도 effort 를 넘긴다.
    expect(flag(providerLaunch(member({ cli: "claude", model: null, effort: "high" }), opts, { claudeBin: "/fake/claude" }).argv, "--effort")).toBe("high");
    expect(providerLaunch(member({ cli: "codex", model: null, effort: "high" }), opts, { codexBin: "/fake/codex" }).argv).toContain('model_reasoning_effort="high"');
  });
  test("이어 열기: --conversation <id>, 세션 id 를 돌려준다. id 를 모르면 session_unknown", () => {
    const home = temp(), opts = runFiles(home), bins = { geminiBin: "/fake/agy", contextHome: home };
    const id = "f0469d2b-813c-4d72-9c13-f80e0a315968";
    const resumed = providerLaunch(member({ sessionId: id }), { ...opts, resume: true }, bins);
    expect(resumed.argv.slice(1, 3)).toEqual(["--conversation", id]);
    expect(resumed.sessionId).toBe(id);
    // 이어 열기가 아니면 아는 id 가 있어도 넘기지 않는다(새 대화).
    const fresh = providerLaunch(member({ sessionId: id }), opts, bins);
    expect(fresh.argv).not.toContain("--conversation");
    expect(fresh.sessionId).toBeNull();
    let thrown: unknown;
    try { providerLaunch(member(), { ...opts, resume: true }, bins); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(CoreError);
    expect((thrown as CoreError).kind).toBe("session_unknown");
    expect(() => providerLaunch(member({ sessionId: "bad id; rm -rf" }), { ...opts, resume: true }, bins)).toThrow("Invalid CLI session id");
  });
  test("contextHome 이 없으면 상태줄·훅 없이 띄운다", () => {
    const home = temp(), opts = runFiles(home);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const launch = providerLaunch(member(), opts, { geminiBin: "/fake/agy" });
      const settings = JSON.parse(flag(launch.argv, "--settings")!);
      expect("statusLine" in settings).toBe(false);
      expect(existsSync(join(home, "run", "agy", "m_lead1", ".agents", "hooks.json"))).toBe(false);
      expect(existsSync(join(home, "run", "agy", "m_lead1", ".agents", "mcp_config.json"))).toBe(true);
      // 상태줄이 없어도 띄우기 값 라벨은 붙는다: 다른 터미널이 남긴 상태줄 기록을 이 터미널 것으로 읽지 않는다.
      expect(launch.labels![GEMINI_LAUNCH_LABEL]).toMatch(/^[0-9a-f]{32}$/);
      // 넣지 않기로 한 것이지 만들지 못한 것이 아니다: 알릴 것이 없다.
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  test("훅·상태줄을 만들지 못하면 그것을 빼고 띄우되, 서버 기록에 팀장과 뺀 것을 한 줄씩 남긴다(경로·열쇠는 적지 않는다)", () => {
    const home = temp(), opts = runFiles(home);
    const lines: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    try {
      // 잘 만들어지면 남기지 않는다.
      providerLaunch(member(), opts, { geminiBin: "/fake/agy", contextHome: home });
      expect(lines).toEqual([]);
      // run 자리가 폴더가 아니어서 기록 스크립트·상태줄 스크립트를 쓸 수 없다(권한 문제·디스크 문제와 같은 길).
      const broken = join(home, "broken-home");
      mkdirSync(broken);
      writeFileSync(join(broken, "run"), "폴더가 아니다");
      const launch = providerLaunch(member(), opts, { geminiBin: "/fake/agy", contextHome: broken });
      const settings = JSON.parse(flag(launch.argv, "--settings")!);
      expect("statusLine" in settings).toBe(false);
      expect(existsSync(join(home, "run", "agy", "m_lead1", ".agents", "hooks.json"))).toBe(false);
      expect(existsSync(join(home, "run", "agy", "m_lead1", ".agents", "mcp_config.json"))).toBe(true);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toStartWith("[gemini] m_lead1: 훅 기록을 만들지 못해 훅 없이 띄웁니다");
      expect(lines[1]).toStartWith("[gemini] m_lead1: 도구 훅을 만들지 못해 빼고 띄웁니다");
      expect(lines[2]).toStartWith("[gemini] m_lead1: 상태줄 명령을 만들지 못해 상태줄 없이 띄웁니다");
      for (const line of lines) {
        expect(line).not.toContain(home);
        expect(line).not.toContain("secret");
        expect(line).not.toContain("/");
        expect(line.split("\n")).toHaveLength(1);
      }
      // 사건 기록 훅을 끈 환경에서는 도구 훅·상태줄 줄만 남는다(도구 훅은 기록과 따로 싣는다).
      lines.length = 0;
      providerLaunch(member(), opts, { geminiBin: "/fake/agy", contextHome: broken, hookEvents: false });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("도구 훅");
      expect(lines[1]).toContain("상태줄");
    } finally { warn.mockRestore(); }
  });
  test("사건 기록 훅을 끄면(hookEvents false) 기록 사건은 빼고 도구 훅(PreToolUse)만 남긴다. contextHome 이 없으면 hooks.json 을 두지 않고 예전 것은 지운다", () => {
    const home = temp(), opts = runFiles(home), hooks = join(home, "run", "agy", "m_lead1", ".agents", "hooks.json");
    providerLaunch(member(), opts, { geminiBin: "/fake/agy", contextHome: home });
    expect(Object.keys(JSON.parse(readFileSync(hooks, "utf8"))[GEMINI_HOOKS_NAME]).sort()).toEqual(["PreInvocation", "PreToolUse", "SessionStart", "Stop"]);
    providerLaunch(member(), opts, { geminiBin: "/fake/agy", contextHome: home, hookEvents: false });
    expect(Object.keys(JSON.parse(readFileSync(hooks, "utf8"))[GEMINI_HOOKS_NAME])).toEqual(["PreToolUse"]);
    providerLaunch(member(), opts, { geminiBin: "/fake/agy" });
    expect(existsSync(hooks)).toBe(false);
  });
  test("Claude·Codex 의 명령줄은 그대로다(gemini 가지가 섞이지 않는다)", () => {
    const home = temp(), opts = runFiles(home);
    const claude = providerLaunch(member({ cli: "claude" }), opts, { claudeBin: "/fake/claude", geminiBin: "/fake/agy" });
    expect(claude.argv[0]).toBe("/fake/claude");
    expect(claude.argv).toContain("--append-system-prompt-file");
    expect(claude.argv).not.toContain("--add-dir");
    expect(claude.env.AGY_CLI_OSC7501).toBeUndefined();
    const codex = providerLaunch(member({ cli: "codex" }), opts, { codexBin: "/fake/codex", geminiBin: "/fake/agy" });
    expect(codex.argv[0]).toBe("/fake/codex");
    expect(codex.argv).toContain("features.multi_agent=true");
    expect(codex.argv).not.toContain("--add-dir");
    expect(codex.env.AGY_CLI_OSC7501).toBeUndefined();
    expect(existsSync(join(home, "run", "agy"))).toBe(false);
  });
});

describe("주입 폴더: 규칙 조각·MCP·훅", () => {
  test("팀장마다 따로, 0700 폴더와 0600 파일", () => {
    const home = temp();
    providerLaunch(member(), runFiles(home), { geminiBin: "/fake/agy", contextHome: home });
    providerLaunch(member({ id: "m_lead2" }), runFiles(home, "m_lead2", "## 둘째 팀장의 지침\n"), { geminiBin: "/fake/agy", contextHome: home });
    const one = join(home, "run", "agy", "m_lead1"), two = join(home, "run", "agy", "m_lead2");
    for (const dir of [join(home, "run", "agy"), one, join(one, ".agents"), join(one, ".agents", "rules"), two]) expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of [join(one, ".agents", "rules", "iamceo-01.md"), join(one, ".agents", "mcp_config.json"), join(one, ".agents", "hooks.json"), `${one}.env`]) expect(statSync(file).mode & 0o777).toBe(0o600);
    // 팀장끼리 지침·열쇠가 섞이지 않는다. 열쇠는 주입 폴더 옆의 환경 파일에 있다.
    expect(readFileSync(`${one}.env`, "utf8")).toContain("secret-m_lead1");
    expect(readFileSync(`${one}.env`, "utf8")).not.toContain("secret-m_lead2");
    expect(readFileSync(`${two}.env`, "utf8")).toContain("secret-m_lead2");
    expect(readFileSync(join(two, ".agents", "rules", "iamceo-01.md"), "utf8")).toContain("둘째 팀장의 지침");
    expect(readFileSync(join(one, ".agents", "rules", "iamceo-01.md"), "utf8")).not.toContain("둘째 팀장의 지침");
    // agy 는 넘겨받은 폴더의 부모 쪽 .agents 도 읽는다: 부모에는 두지 않는다.
    expect(existsSync(join(home, "run", "agy", ".agents"))).toBe(false);
    expect(existsSync(join(home, "run", ".agents"))).toBe(false);
    expect(geminiInjectDir(join(home, "run", "m_lead1.rules.md"), "m_lead1")).toBe(one);
  });
  test("규칙 조각: 머리말과 본문, 이으면 지침 원문과 같다", () => {
    const home = temp();
    const body = Array.from({ length: 30 }, (_, i) => `## 절 ${i + 1}\n${"가나다라마바사 ".repeat(60)}\n`).join("");
    const rules = `너는 총괄이다.\n\n${body}`;
    const launch = providerLaunch(member(), runFiles(home, "m_lead1", rules), { geminiBin: "/fake/agy", contextHome: home });
    const dir = join(flag(launch.argv, "--add-dir")!, ".agents", "rules");
    const names = readdirSync(dir).sort();
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(names).toEqual(names.map((_, i) => `iamceo-${String(i + 1).padStart(2, "0")}.md`));
    let restored = "";
    names.forEach((name, i) => {
      const file = readFileSync(join(dir, name), "utf8");
      const head = `---\ntrigger: always_on\ndescription: "IAMCEO 역할 지침 ${i + 1}/${names.length}"\n---\n\n`;
      expect(file.startsWith(head)).toBe(true);
      expect(bytes(file)).toBeLessThanOrEqual(GEMINI_RULE_CHUNK_BYTES + bytes(head));
      expect(bytes(file)).toBeLessThan(GEMINI_RULE_FILE_MAX_BYTES);
      restored += file.slice(head.length);
    });
    // 첫 조각의 맨 앞은 '작업 폴더' 절이다(agy 가 주입 폴더를 현재 폴더로 보여 줘도 산출물은 프로젝트에). 그 뒤는 지침 원문 그대로다.
    const injectDir = flag(launch.argv, "--add-dir")!;
    expect(restored).toBe(`${geminiWorkspaceRule("/tmp", injectDir)}${rules}`);
    expect(restored.startsWith("## 작업 폴더\n- 이 세션의 작업 폴더(현재 폴더)는 `/tmp` 다.")).toBe(true);
    expect(restored).toContain(`\`${injectDir}\` 는 IAMCEO 가 이 세션에 넣은 설정 폴더`);
  });
  test("다시 띄우면 지금 지침으로 맞춘다: 남는 예전 조각은 지우고, 같은 내용은 다시 쓰지 않는다", () => {
    const home = temp(), bins = { geminiBin: "/fake/agy", contextHome: home };
    const long = Array.from({ length: 30 }, (_, i) => `## 절 ${i + 1}\n${"가나다라마바사 ".repeat(60)}\n`).join("");
    providerLaunch(member(), runFiles(home, "m_lead1", long), bins);
    const dir = join(home, "run", "agy", "m_lead1", ".agents", "rules");
    expect(readdirSync(dir).length).toBeGreaterThan(1);
    // 남의 파일(우리 이름 규칙이 아닌 것)은 건드리지 않는다.
    writeFileSync(join(dir, "note.txt"), "x");
    providerLaunch(member(), runFiles(home, "m_lead1", RULES), bins);
    expect(readdirSync(dir).sort()).toEqual(["iamceo-01.md", "note.txt"]);
    expect(readFileSync(join(dir, "iamceo-01.md"), "utf8").endsWith(`${geminiWorkspaceRule("/tmp", join(home, "run", "agy", "m_lead1"))}${RULES}`)).toBe(true);
    const before = statSync(join(dir, "iamceo-01.md")).mtimeMs, mcpBefore = statSync(join(home, "run", "agy", "m_lead1", ".agents", "mcp_config.json")).mtimeMs;
    Bun.sleepSync(15);
    providerLaunch(member(), runFiles(home, "m_lead1", RULES), bins);
    expect(statSync(join(dir, "iamceo-01.md")).mtimeMs).toBe(before);
    expect(statSync(join(home, "run", "agy", "m_lead1", ".agents", "mcp_config.json")).mtimeMs).toBe(mcpBefore);
    expect(readdirSync(join(home, "run", "agy", "m_lead1", ".agents")).filter(name => name.endsWith(".tmp"))).toEqual([]);
    // 빈 지침이면 '작업 폴더' 절 한 조각뿐이다.
    providerLaunch(member(), runFiles(home, "m_lead1", ""), bins);
    expect(readdirSync(dir).sort()).toEqual(["iamceo-01.md", "note.txt"]);
    expect(readFileSync(join(dir, "iamceo-01.md"), "utf8").endsWith(geminiWorkspaceRule("/tmp", join(home, "run", "agy", "m_lead1")))).toBe(true);
  });
  test("mcp_config.json: 열쇠를 싣지 않는다. 주입 폴더 밖의 환경 파일을 읽어 IAMCEO MCP 다리(command·args)를 띄우는 sh 명령이다", () => {
    const home = temp();
    const launch = providerLaunch(member(), runFiles(home), { geminiBin: "/fake/agy", contextHome: home });
    const dir = flag(launch.argv, "--add-dir")!;
    const config = JSON.parse(readFileSync(join(dir, ".agents", "mcp_config.json"), "utf8"));
    const envFile = `${dir}.env`;
    expect(config).toEqual({ mcpServers: { iamceo: { command: "/bin/sh", args: ["-c", GEMINI_MCP_LAUNCHER, "iamceo-mcp", envFile, "/bin/echo", "bridge", "a'b"] } } });
    // agy 의 작업 폴더(주입 폴더) 안 어디에도 열쇠가 없다: 폴더 검색·색인이 훑어도 모델 입력에 실리지 않는다.
    const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]);
    for (const file of walk(dir)) expect(readFileSync(file, "utf8")).not.toContain("secret-m_lead1");
    expect(envFile.startsWith(`${dir}/`)).toBe(false);
    expect(parseGeminiMcpEnv(readFileSync(envFile, "utf8"))).toEqual({ IAMCEO_TOKEN: "secret-m_lead1", IAMCEO_URL: "http://127.0.0.1:1" });
    // sh 가 그 파일을 읽어 다리에 환경을 넘긴다(실제로 돌려 본다). 값의 따옴표·달러·줄바꿈도 그대로다.
    const tricky = { IAMCEO_TOKEN: "a'b c\"d$e\\f", MULTI: "x\ny" };
    writeFileSync(envFile, geminiMcpEnvText(tricky), { mode: 0o600 });
    expect(parseGeminiMcpEnv(readFileSync(envFile, "utf8"))).toEqual(tricky);
    const ran = Bun.spawnSync(["/bin/sh", "-c", GEMINI_MCP_LAUNCHER, "iamceo-mcp", envFile, "/usr/bin/env"], { env: {} });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toContain(`IAMCEO_TOKEN=${tricky.IAMCEO_TOKEN}\n`);
    expect(ran.stdout.toString()).toContain("MULTI=x\ny\n");
    // 환경 파일이 없으면 다리를 띄우지 않는다.
    expect(Bun.spawnSync(["/bin/sh", "-c", GEMINI_MCP_LAUNCHER, "iamceo-mcp", `${envFile}.missing`, "/usr/bin/env"], { env: {}, stderr: "ignore" }).exitCode).not.toBe(0);
  });
  test("MCP 설정이 잘못됐으면 띄우지 않는다(Codex 가지와 같은 검사)", () => {
    const home = temp(), opts = runFiles(home), bins = { geminiBin: "/fake/agy", contextHome: home };
    const cases: [unknown, string][] = [
      [{ mcpServers: {} }, "IAMCEO MCP bridge must use a stdio command and args"],
      [{ mcpServers: { iamceo: { command: "/bin/echo", args: "bridge" } } }, "IAMCEO MCP bridge must use a stdio command and args"],
      [{ mcpServers: { iamceo: { command: "/bin/echo", args: ["ok", 3] } } }, "IAMCEO MCP bridge must use a stdio command and args"],
      [{ mcpServers: { iamceo: { url: "http://x" } } }, "IAMCEO MCP bridge must use a stdio command and args"],
      [{ mcpServers: { iamceo: { command: "/bin/echo", args: [], env: { "BAD-NAME": "x" } } } }, "Invalid MCP environment value: BAD-NAME"],
      [{ mcpServers: { iamceo: { command: "/bin/echo", args: [], env: { TOKEN: 5 } } } }, "Invalid MCP environment value: TOKEN"],
    ];
    for (const [config, message] of cases) {
      writeFileSync(opts.mcpConfigFile, JSON.stringify(config));
      expect(() => providerLaunch(member(), opts, bins)).toThrow(message);
      expect(() => readGeminiMcpBridge(opts.mcpConfigFile)).toThrow(message);
    }
    rmSync(opts.mcpConfigFile);
    expect(() => providerLaunch(member(), opts, bins)).toThrow();
  });
  test("hooks.json: 세 사건의 기록 명령(이 팀장의 사건 파일로)과 도구 훅(PreToolUse) 한 묶음", () => {
    const home = temp();
    const launch = providerLaunch(member(), runFiles(home), { geminiBin: "/fake/agy", contextHome: home });
    const hooks = JSON.parse(readFileSync(join(flag(launch.argv, "--add-dir")!, ".agents", "hooks.json"), "utf8"));
    expect(Object.keys(hooks)).toEqual([GEMINI_HOOKS_NAME]);
    expect(Object.keys(hooks[GEMINI_HOOKS_NAME]).sort()).toEqual(["PreInvocation", "PreToolUse", "SessionStart", "Stop"]);
    // 도구 훅: 기록 명령과 달리 `{}` 를 찍지 않는다(PreToolUse 에서 `{}` 는 도구를 막는다). 설정 파일은 주입 폴더 밖이다.
    const tool = hooks[GEMINI_HOOKS_NAME].PreToolUse;
    expect(tool).toHaveLength(1);
    expect(tool[0].matcher).toStartWith("^(run_command|write_file|edit_file");
    expect(tool[0].hooks[0].command).not.toContain("printf");
    expect(tool[0].hooks[0].command.endsWith("2>/dev/null; exit 0")).toBe(true);
    expect(tool[0].hooks[0].command).toContain(`'${join(home, "run", "agy", "m_lead1")}.hook.json'`);
    const handler = hooks[GEMINI_HOOKS_NAME].PreInvocation[0];
    expect(handler.type).toBe("command");
    expect(handler.timeout).toBe(5);
    expect(handler.command).toContain(`'${geminiHookEventsDir(home)}' 'm_lead1'`);
    expect(handler.command.endsWith("printf '{}'; exit 0")).toBe(true);
  });
  test("경로로 쓸 수 없는 팀장 id·상대 경로는 던진다", () => {
    const home = temp(), opts = runFiles(home);
    for (const id of ["../escape", "a/b", "", ".hidden", "x".repeat(65)]) {
      expect(() => providerLaunch(member({ id }), opts, { geminiBin: "/fake/agy", contextHome: home })).toThrow("Invalid member id for Antigravity launch files");
    }
    expect(() => geminiInjectDir("run/m.rules.md", "m_lead1")).toThrow();
    expect(readdirSync(join(home, "run")).sort()).not.toContain("escape");
    expect(() => writeGeminiInjectDir({ memberId: "m_lead1", systemPromptFile: join(home, "run", "missing.rules.md"), mcpConfigFile: opts.mcpConfigFile, hooks: null })).toThrow();
  });
});

describe("geminiSettings", () => {
  test("실제 경로와 적힌 경로가 다르면 둘 다 신뢰 폴더에 싣는다", () => {
    const home = temp(), real = join(home, "real"), link = join(home, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    const settings = geminiSettings({ cwd: link, injectDir: join(home, "inject-missing"), permissionMode: "bypassPermissions", statusLine: null });
    expect(settings.trustedWorkspaces).toEqual([real, link, join(home, "inject-missing")]);
    expect("statusLine" in settings).toBe(false);
    expect("agentMode" in settings).toBe(false);
    expect(geminiSettings({ cwd: real, injectDir: real, permissionMode: "default", statusLine: { type: "command", command: "x" } })).toMatchObject({ trustedWorkspaces: [real], agentMode: "", statusLine: { type: "command", command: "x" } });
    expect(geminiSettings({ cwd: real, injectDir: real, permissionMode: "auto", statusLine: null }).agentMode).toBe("auto");
    expect("agentMode" in geminiSettings({ cwd: real, injectDir: real, permissionMode: "bypassPermissions", statusLine: null })).toBe(false);
  });
});
