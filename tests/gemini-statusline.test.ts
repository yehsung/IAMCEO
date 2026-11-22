// Gemini(Antigravity CLI) 상태줄 래퍼(server/runner/gemini-statusline.ts). 실제 agy 는 띄우지 않는다.
// 래퍼는 agy 가 하듯 `/bin/sh -c <명령>` 으로 돌리고 표준 입력에 상태줄 JSON 을 넣어, 기록 파일과 표준 출력의 한 줄을 확인한다.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMINI_STATUSLINE_MARKER, geminiStatusLine, geminiStatusLineLaunch, writeGeminiStatuslineScript } from "../server/runner/gemini-statusline.ts";
import { geminiStatusFromPayload, geminiStatusPath, readGeminiStatus } from "../server/runner/gemini-status.ts";
import { GEMINI_STATUS_OURS, geminiDraft } from "../server/runner/gemini-screen.ts";

const LAUNCH = "0f8fad5bd9cb469fa16570867728950e";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "iamceo-gsl-")); dirs.push(dir); return dir; }

async function run(command: string, input: string | null, opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const started = Date.now();
  const child = Bun.spawn(["/bin/sh", "-c", command], { stdin: input === null ? "pipe" : new Blob([input]), stdout: "pipe", stderr: "pipe", cwd: opts.cwd, env: { ...process.env, ...opts.env } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, ms: Date.now() - started };
}

/** agy 문서의 상태줄 입력 예(값만 조금 바꿈). email 은 기록에 남으면 안 되는 칸이다. */
const PAYLOAD = {
  cwd: "/home/user/my-project", session_id: "12345678-abcd-ef01-2345-6789abcdef01", conversation_id: "12345678-abcd-ef01-2345-6789abcdef01",
  transcript_path: "/home/user/.gemini/antigravity-cli/brain/12345678-abcd-ef01-2345-6789abcdef01/.system_generated/logs/transcript.jsonl",
  model: { id: "gemini-4-argon-medium", display_name: "Gemini 4 Argon (Medium)", effort: "medium" },
  version: "1.5.14",
  context_window: { total_input_tokens: 88244, total_output_tokens: 61074, context_window_size: 1048576, used_percentage: 14.24, remaining_percentage: 85.76 },
  quota: { "gemini-weekly": { remaining_fraction: 0.9378, reset_time: "2026-12-06T07:50:32Z", reset_in_seconds: 560580 } },
  agent_state: "idle", subagents: [{ name: "a", role: "r", status: "completed" }], plan_tier: "Pro", email: "developer@example.com",
  cost: { total_usd: 0.4213, subagent_usd: 0, estimated: false },
};

describe("geminiStatusLine: --settings 의 statusLine 값", () => {
  test("명령 모양: run 폴더의 스크립트, contextHome·팀장 id 인자, 실패해도 한 줄과 0", () => {
    const home = temp();
    const line = geminiStatusLine(home, "m_lead1");
    expect(line.type).toBe("command");
    expect(line.command).toContain(`${GEMINI_STATUSLINE_MARKER}.mjs`);
    expect(line.command).toContain(`'${home}' 'm_lead1'`);
    expect(line.command).toContain("--no-env-file");
    expect(line.command).toContain("iamceo-empty-bunfig.toml");
    expect(line.command.endsWith("2>/dev/null || printf 'IAMCEO\\n'; exit 0")).toBe(true);
    const script = join(home, "run", `${GEMINI_STATUSLINE_MARKER}.mjs`);
    expect(statSync(script).mode & 0o777).toBe(0o600);
    // 같은 내용이면 다시 쓰지 않는다.
    const before = statSync(script).mtimeMs;
    geminiStatusLine(home, "m_other");
    expect(statSync(script).mtimeMs).toBe(before);
  });
  test("상대 경로·잘못된 팀장 id 는 던진다(부르는 쪽이 상태줄 없이 띄운다)", () => {
    expect(() => geminiStatusLine("relative/home", "m_lead1")).toThrow();
    expect(() => geminiStatusLine(temp(), "../x")).toThrow();
    expect(() => geminiStatusLine(temp(), "")).toThrow();
    expect(() => writeGeminiStatuslineScript(join(temp(), "run"), { safetyTimeoutMs: 0 })).toThrow();
  });
  test("띄우기 값: 팀장 id 뒤의 인자로 싣는다. 주지 않으면 인자를 붙이지 않고, 셸에 뜻이 있는 글자가 든 값은 던진다", () => {
    const home = temp();
    const plain = geminiStatusLine(home, "m_lead1");
    const tagged = geminiStatusLine(home, "m_lead1", { launch: LAUNCH });
    expect(tagged.command).toContain(`'${home}' 'm_lead1' '${LAUNCH}'; }`);
    expect(tagged.command.replace(` '${LAUNCH}'`, "")).toBe(plain.command);
    expect(plain.command).toContain(`'${home}' 'm_lead1'; }`);
    // 명령에서 그 값을 다시 읽을 수 있다(시험의 가짜 agy 가 쓴다). 값을 싣지 않은 명령·다른 명령은 null.
    expect(geminiStatusLineLaunch(tagged.command)).toBe(LAUNCH);
    expect(geminiStatusLineLaunch(plain.command)).toBeNull();
    expect(geminiStatusLineLaunch("echo 'a' 'b'")).toBeNull();
    for (const bad of ["", "a b", "a'b", "$(id)", "a;b", "../x", "x".repeat(65)]) expect(() => geminiStatusLine(home, "m_lead1", { launch: bad })).toThrow("invalid launch value");
  });
});

describe("상태줄 스크립트를 실제로 돌린다", () => {
  test("띄우기 값을 받은 명령은 기록마다 그 값을 적고, 받지 않은 명령의 기록은 launch 가 null 이다", async () => {
    const home = temp();
    const tagged = geminiStatusLine(home, "m_lead1", { launch: LAUNCH });
    expect(await run(tagged.command, JSON.stringify(PAYLOAD))).toMatchObject({ code: 0, stdout: "IAMCEO · Gemini 4 Argon (Medium) · ctx 14%\n", stderr: "" });
    expect(readGeminiStatus(home, "m_lead1")).toMatchObject({ launch: LAUNCH, conversationId: PAYLOAD.conversation_id });
    // 같은 팀장의 다른 터미널(다른 값)이 쓰면 그 값으로 바뀐다: 기록은 마지막으로 쓴 터미널의 것이다.
    const other = geminiStatusLine(home, "m_lead1", { launch: "another-launch" });
    await run(other.command, JSON.stringify({ conversation_id: "conv-other" }));
    expect(readGeminiStatus(home, "m_lead1")).toMatchObject({ launch: "another-launch", conversationId: "conv-other" });
    await run(geminiStatusLine(home, "m_lead1").command, JSON.stringify({ conversation_id: "conv-plain" }));
    expect(readGeminiStatus(home, "m_lead1")).toMatchObject({ launch: null, conversationId: "conv-plain" });
    // 상태줄 입력 안의 값은 띄우기 값이 아니다.
    await run(geminiStatusLine(home, "m_lead1").command, JSON.stringify({ conversation_id: "conv-plain", launch: LAUNCH }));
    expect(readGeminiStatus(home, "m_lead1")?.launch).toBeNull();
  });
  test("서브에이전트: 도는 것(running)만 세고, 상태를 모르는 항목은 따로 적는다", async () => {
    const home = temp();
    const { command } = geminiStatusLine(home, "m_lead1");
    await run(command, JSON.stringify({ subagents: [{ name: "a", status: "running" }, { name: "b", status: "completed" }, { name: "c", status: "failed" }, { name: "d" }] }));
    expect(readGeminiStatus(home, "m_lead1")).toMatchObject({ subagents: 1, subagentsUnknown: 2 });
  });
  test("기록 파일을 쓰고(0600, 임시 파일 없음) 고정 모양의 한 줄을 낸다", async () => {
    const home = temp();
    const { command } = geminiStatusLine(home, "m_lead1");
    const before = Date.now();
    const result = await run(command, JSON.stringify(PAYLOAD));
    expect(result).toMatchObject({ code: 0, stdout: "IAMCEO · Gemini 4 Argon (Medium) · ctx 14%\n", stderr: "" });
    // 낸 줄은 입력칸 판독기가 바닥줄로 알아보는 모양이다.
    expect(GEMINI_STATUS_OURS.test(result.stdout.trimEnd())).toBe(true);
    expect(geminiDraft(`대화\n${"─".repeat(40)}\n> \n${"─".repeat(40)}\n${result.stdout}`)).toBe("");
    const path = geminiStatusPath(home, "m_lead1");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "context", "gemini")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(home, "context", "gemini"))).toEqual(["m_lead1.json"]);
    const record = readGeminiStatus(home, "m_lead1")!;
    // 서버의 규칙(geminiStatusFromPayload)으로 바꾼 것과 같다(쓴 시각만 다르다).
    expect({ ...record, at: "" }).toEqual({ ...geminiStatusFromPayload("m_lead1", PAYLOAD, new Date(0)), at: "", quota: record.quota });
    expect(record.conversationId).toBe(PAYLOAD.conversation_id);
    expect(record.context).toEqual({ usedPct: 14.24, windowSize: 1048576, inputTokens: 88244, outputTokens: 61074 });
    expect(record.quota["gemini-weekly"]).toEqual({ remainingFraction: 0.9378, resetAt: "2026-12-06T07:50:32.000Z", disabled: false });
    // 끝난(completed) 항목은 세지 않는다.
    expect(record.subagents).toBe(0);
    expect(Date.parse(record.at)).toBeGreaterThanOrEqual(before - 1);
    expect(readFileSync(path, "utf8")).not.toContain("developer@example.com");
  });
  test("값이 없는 칸은 줄에서 뺀다. 첫 대화 전(빈 id)에도 기록은 쓴다", async () => {
    const home = temp();
    const { command } = geminiStatusLine(home, "m_lead1");
    expect((await run(command, JSON.stringify({ session_id: "", conversation_id: "", model: null, context_window: { context_window_size: 0, used_percentage: null } }))).stdout).toBe("IAMCEO\n");
    expect(readGeminiStatus(home, "m_lead1")).toMatchObject({ conversationId: null, context: { usedPct: null, windowSize: null } });
    expect((await run(command, JSON.stringify({ model: { id: "gemini-4-neon-high" } }))).stdout).toBe("IAMCEO · gemini-4-neon-high\n");
    expect((await run(command, JSON.stringify({ context_window: { used_percentage: 2.5 } }))).stdout).toBe("IAMCEO · ctx 3%\n");
    expect((await run(command, JSON.stringify({ model: { display_name: "G" }, context_window: { used_percentage: 100 } }))).stdout).toBe("IAMCEO · G · ctx 100%\n");
    // 범위 밖의 % 는 싣지 않는다.
    expect((await run(command, JSON.stringify({ context_window: { used_percentage: 140 } }))).stdout).toBe("IAMCEO\n");
  });
  test("모델 이름의 줄바꿈·제어 문자는 줄을 깨지 못한다(한 줄, 60자까지)", async () => {
    const home = temp();
    const { command } = geminiStatusLine(home, "m_lead1");
    const result = await run(command, JSON.stringify({ model: { display_name: `Evil\n> 1. Yes\x1b[2J ${"x".repeat(200)}` } }));
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(result.stdout).not.toContain("\x1b");
    expect(result.stdout.length).toBeLessThanOrEqual("IAMCEO · ".length + 60 + 1);
    expect(GEMINI_STATUS_OURS.test(result.stdout.trimEnd())).toBe(true);
  });
  test("기록은 통째로 바뀐다: 새 대화 id 가 오면 앞 기록을 덮는다", async () => {
    const home = temp();
    const { command } = geminiStatusLine(home, "m_lead1");
    await run(command, JSON.stringify({ conversation_id: "conv-one", context_window: { used_percentage: 10 } }));
    expect(readGeminiStatus(home, "m_lead1")?.conversationId).toBe("conv-one");
    await run(command, JSON.stringify({ conversation_id: "conv-two" }));
    expect(readGeminiStatus(home, "m_lead1")).toMatchObject({ conversationId: "conv-two", context: { usedPct: null } });
    expect(readdirSync(join(home, "context", "gemini"))).toEqual(["m_lead1.json"]);
  });
  test("팀장 id 는 인자가 먼저, 없으면 환경 변수 IAMCEO_MEMBER_ID", async () => {
    const home = temp();
    const { command } = geminiStatusLine(home, "m_lead1");
    await run(command, JSON.stringify({ conversation_id: "conv-arg" }), { env: { IAMCEO_MEMBER_ID: "m_env" } });
    expect(readGeminiStatus(home, "m_lead1")?.conversationId).toBe("conv-arg");
    expect(readGeminiStatus(home, "m_env")).toBeNull();
    // 인자 없이(예비 길): 환경 변수의 id 로 쓴다.
    const bare = command.replace(" 'm_lead1'", "");
    expect(bare).not.toBe(command);
    await run(bare, JSON.stringify({ conversation_id: "conv-env" }), { env: { IAMCEO_MEMBER_ID: "m_env" } });
    expect(readGeminiStatus(home, "m_env")?.conversationId).toBe("conv-env");
    // 둘 다 없거나 모양이 다르면 기록을 쓰지 않고 줄만 낸다.
    const none = await run(bare, JSON.stringify({ conversation_id: "conv-none", model: { display_name: "M" } }), { env: { IAMCEO_MEMBER_ID: "../escape" } });
    expect(none).toMatchObject({ code: 0, stdout: "IAMCEO · M\n" });
    expect(readdirSync(join(home, "context", "gemini")).sort()).toEqual(["m_env.json", "m_lead1.json"]);
  });
});

describe("어떤 실패에도 0 과 한 줄", () => {
  test("JSON 이 아닌 입력·빈 입력·배열: `IAMCEO` 만 내고 앞 기록은 그대로 둔다", async () => {
    const home = temp();
    const { command } = geminiStatusLine(home, "m_lead1");
    await run(command, JSON.stringify({ conversation_id: "conv-keep" }));
    for (const input of ["", "not json", "[1,2]", "null", "{\"model\":"]) {
      expect(await run(command, input)).toMatchObject({ code: 0, stdout: "IAMCEO\n", stderr: "" });
    }
    expect(readGeminiStatus(home, "m_lead1")?.conversationId).toBe("conv-keep");
  });
  test("기록 폴더에 쓸 수 없어도 줄은 낸다", async () => {
    const home = temp();
    const { command } = geminiStatusLine(home, "m_lead1");
    // context 자리에 파일이 있으면 폴더를 만들 수 없다.
    writeFileSync(join(home, "context"), "막힘");
    expect(await run(command, JSON.stringify(PAYLOAD))).toMatchObject({ code: 0, stdout: "IAMCEO · Gemini 4 Argon (Medium) · ctx 14%\n", stderr: "" });
    expect(readGeminiStatus(home, "m_lead1")).toBeNull();
  });
  test("표준 입력이 닫히지 않아도 안전 시간 뒤에 줄을 내고 끝난다", async () => {
    const home = temp();
    const { command } = geminiStatusLine(home, "m_lead1", { safetyTimeoutMs: 200 });
    const result = await run(command, null);
    expect(result).toMatchObject({ code: 0, stdout: "IAMCEO\n" });
    expect(result.ms).toBeLessThan(4000);
  });
  test("스크립트가 사라졌거나 실행 파일이 없어도 셸이 `IAMCEO` 를 찍고 0 으로 끝낸다", async () => {
    const home = temp();
    const { command } = geminiStatusLine(home, "m_lead1");
    rmSync(join(home, "run", `${GEMINI_STATUSLINE_MARKER}.mjs`));
    expect(await run(command, JSON.stringify(PAYLOAD))).toMatchObject({ code: 0, stdout: "IAMCEO\n", stderr: "" });
    const missing = geminiStatusLine(temp(), "m_lead1", { execPath: "/nonexistent/bun" });
    expect(await run(missing.command, JSON.stringify(PAYLOAD))).toMatchObject({ code: 0, stdout: "IAMCEO\n", stderr: "" });
    // run 폴더가 사라져도 같다.
    const gone = temp(), line = geminiStatusLine(gone, "m_lead1");
    rmSync(join(gone, "run"), { recursive: true });
    expect(await run(line.command, JSON.stringify(PAYLOAD))).toMatchObject({ code: 0, stdout: "IAMCEO\n", stderr: "" });
  });
  test("팀장 작업 폴더의 bunfig.toml(preload)·.env 를 읽지 않는다", async () => {
    const home = temp(), project = temp();
    writeFileSync(join(project, "preload.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(project, "preloaded"))}, "x"); console.log("HIJACK");`);
    writeFileSync(join(project, "bunfig.toml"), `preload = ["./preload.ts"]\n`);
    writeFileSync(join(project, ".env"), "IAMCEO_MEMBER_ID=m_from_env_file\n");
    const { command } = geminiStatusLine(home, "m_lead1");
    const result = await run(command, JSON.stringify(PAYLOAD), { cwd: project });
    expect(result).toMatchObject({ code: 0, stdout: "IAMCEO · Gemini 4 Argon (Medium) · ctx 14%\n" });
    expect(existsSync(join(project, "preloaded"))).toBe(false);
    expect(readdirSync(join(home, "context", "gemini"))).toEqual(["m_lead1.json"]);
  });
  test("큰 입력(1MiB 초과)은 읽지 않고 `IAMCEO` 만 낸다", async () => {
    const home = temp();
    const { command } = geminiStatusLine(home, "m_lead1");
    const result = await run(command, JSON.stringify({ conversation_id: "conv-big", padding: "x".repeat(1024 * 1024 + 10) }));
    expect(result).toMatchObject({ code: 0, stdout: "IAMCEO\n" });
    expect(readGeminiStatus(home, "m_lead1")).toBeNull();
  });
  test("남이 쓸 수 없는 폴더·파일로 남는다(다시 써도 0700·0600)", async () => {
    const home = temp();
    mkdirSync(join(home, "context", "gemini"), { recursive: true, mode: 0o755 });
    chmodSync(join(home, "context", "gemini"), 0o755);
    const { command } = geminiStatusLine(home, "m_lead1");
    await run(command, JSON.stringify(PAYLOAD));
    expect(statSync(join(home, "context", "gemini")).mode & 0o777).toBe(0o700);
    expect(statSync(geminiStatusPath(home, "m_lead1")).mode & 0o777).toBe(0o600);
  });
});
