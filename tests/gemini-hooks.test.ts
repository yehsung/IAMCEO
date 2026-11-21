// Gemini(Antigravity CLI) 훅(server/runner/gemini-hooks.ts): hooks.json 값, 기록 스크립트(실제로 실행), 기록 읽기, 전달 수신 증거.
// 실제 agy 는 띄우지 않는다. 훅 명령은 agy 가 하듯 `/bin/sh -c` 로 돌리고 표준 입력에 훅 JSON(camelCase)을 넣는다.
// 입력 견본은 agy 1.5.14 가 실제로 넘긴 훅 입력의 칸 이름을 따랐다(값은 지어낸 것).
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMINI_HOOK_EVENTS, GEMINI_HOOK_RECORDER_MARKER, GEMINI_HOOK_TIMEOUT_SEC, GEMINI_HOOKS_NAME, geminiHookEventsDir, geminiHookLastWrite, geminiHooksConfig, parseGeminiHookLine, readGeminiDeliveryEvidence, readGeminiHookConversation, type GeminiHookConversationWatch } from "../server/runner/gemini-hooks.ts";
import { HookEventReader, HookFileReader, hookEventsMark, parseHookEventLine } from "../server/runner/hook-events.ts";
import { hookEventsDir, hookEventsFile } from "../server/runner/hooks.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "iamceo-ghk-")); dirs.push(dir); return dir; }

const ITEM = "#iamceo_AAAAAAAAAAAAAAAAAAAAAA";
const ITEM2 = "#iamceo_CCCCCCCCCCCCCCCCCCCCCC";
const BUNDLE = "#iamceo_b_BBBBBBBBBBBBBBBBBBBBBB";
const CONV = "f0469d2b-813c-4d72-9c13-f80e0a315968";

type Handler = { type: string; command: string; timeout: number };
function commandOf(config: Record<string, unknown>, event = "PreInvocation"): string {
  return ((config[GEMINI_HOOKS_NAME] as Record<string, Handler[]>)[event]![0]!).command;
}
async function runHook(command: string, input: string | null, opts: { cwd?: string } = {}) {
  const started = Date.now();
  const child = Bun.spawn(["/bin/sh", "-c", command], { stdin: input === null ? "pipe" : new Blob([input]), stdout: "pipe", stderr: "pipe", cwd: opts.cwd });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, ms: Date.now() - started };
}
const hookInput = (event: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  artifactDirectoryPath: `/Users/dev/.gemini/antigravity-cli/brain/${CONV}`, conversationId: CONV, cwd: "/work/app", hookEventName: event,
  lastUserInput: "hello", modelName: "gemini-3.8-flash-low", transcriptPath: `/Users/dev/.gemini/antigravity-cli/brain/${CONV}/.system_generated/logs/transcript_full.jsonl`,
  workspacePaths: ["/work/app", "/iamceo/run/agy/m_one"], ...extra });
function lines(path: string): Record<string, unknown>[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

describe("geminiHooksConfig: 주입 폴더의 hooks.json 값", () => {
  test("이름 하나 아래 세 사건, 같은 명령, 제한 시간(초), 끝은 언제나 `{}` 와 0", () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home);
    const config = geminiHooksConfig({ memberId: "m_one", eventsDir });
    expect(Object.keys(config)).toEqual([GEMINI_HOOKS_NAME]);
    const events = config[GEMINI_HOOKS_NAME] as Record<string, Handler[]>;
    expect(Object.keys(events).sort()).toEqual([...GEMINI_HOOK_EVENTS].sort());
    const command = commandOf(config);
    // SessionStart·PreInvocation·Stop 은 매처 없이 처리기를 바로 늘어놓는다(agy 문서).
    for (const name of GEMINI_HOOK_EVENTS) expect(events[name]).toEqual([{ type: "command", command, timeout: GEMINI_HOOK_TIMEOUT_SEC }]);
    expect(command).toContain(`${GEMINI_HOOK_RECORDER_MARKER}.mjs`);
    expect(command).toContain(`'${eventsDir}' 'm_one'`);
    expect(command).toContain("--no-env-file");
    expect(command.endsWith(">/dev/null 2>&1; printf '{}'; exit 0")).toBe(true);
    expect(eventsDir).toBe(join(home, "run", "gemini-events"));
    // Claude 훅 기록 폴더와 다른 폴더다.
    expect(eventsDir).not.toBe(hookEventsDir(home));
    expect(statSync(join(home, "run", `${GEMINI_HOOK_RECORDER_MARKER}.mjs`)).mode & 0o777).toBe(0o600);
  });
  test("잘못된 팀장 ID·상대 경로는 던진다", () => {
    expect(() => geminiHooksConfig({ memberId: "../x", eventsDir: geminiHookEventsDir(temp()) })).toThrow();
    expect(() => geminiHooksConfig({ memberId: "m_one", eventsDir: "run/gemini-events" })).toThrow();
    expect(() => geminiHooksConfig({ memberId: "m_one", eventsDir: geminiHookEventsDir(temp()), recorder: { safetyTimeoutMs: 0 } })).toThrow();
  });
});

describe("기록 스크립트를 실제로 돌린다", () => {
  test("세 사건을 한 줄씩 남기고, 표준 출력은 언제나 `{}`", async () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home), file = hookEventsFile(eventsDir, "m_one");
    const command = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir }));
    const before = Date.now();
    expect(await runHook(command, hookInput("SessionStart"))).toMatchObject({ code: 0, stdout: "{}", stderr: "" });
    const wire = `[총괄 → 팀장] 일을 시작해 주세요 ${ITEM}\n둘째 건 ${ITEM2}\n\n${BUNDLE}`;
    expect(await runHook(command, hookInput("PreInvocation", { invocationNum: 0, initialNumSteps: 5, lastUserInput: wire }))).toMatchObject({ code: 0, stdout: "{}", stderr: "" });
    expect(await runHook(command, hookInput("Stop", { executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true, error: "", continuationActive: false }))).toMatchObject({ code: 0, stdout: "{}", stderr: "" });
    const records = lines(file);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ v: 1, cli: "gemini", event: "SessionStart", conversationId: CONV });
    expect(records[1]).toEqual({ v: 1, cli: "gemini", at: records[1]!.at, event: "PreInvocation", conversationId: CONV, invocation: 0, markers: [ITEM, ITEM2, BUNDLE], chars: wire.length });
    expect(records[2]).toEqual({ v: 1, cli: "gemini", at: records[2]!.at, event: "Stop", conversationId: CONV, reason: "NO_TOOL_CALL", fullyIdle: true, failed: false });
    for (const record of records) expect(record.at as number).toBeGreaterThanOrEqual(before - 1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(eventsDir).mode & 0o777).toBe(0o700);
    // 글 본문은 남기지 않는다.
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("일을 시작해");
    expect(raw).not.toContain("hello");
    expect(raw).not.toContain("transcript");
  });
  test("Stop: 오류 글은 남기지 않고 있었다는 것만, 모르는 사유는 other", async () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home);
    const command = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir }));
    await runHook(command, hookInput("Stop", { terminationReason: "ERROR", fullyIdle: false, error: "quota exhausted for project secret-project" }));
    await runHook(command, hookInput("Stop", { terminationReason: "some reason with spaces", error: "" }));
    await runHook(command, hookInput("Stop", { terminationReason: "USER_CANCELED" }));
    const records = lines(hookEventsFile(eventsDir, "m_one"));
    expect(records.map(r => [r.reason, r.fullyIdle, r.failed])).toEqual([["ERROR", false, true], ["other", null, false], ["USER_CANCELED", null, false]]);
    expect(readFileSync(hookEventsFile(eventsDir, "m_one"), "utf8")).not.toContain("secret-project");
  });
  test("모르는 사건·JSON 이 아닌 입력·빈 입력은 남기지 않는다. 그래도 `{}` 와 0", async () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home);
    const command = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir }));
    for (const input of [hookInput("PreToolUse", { toolCall: { name: "run_command" } }), hookInput("PostInvocation"), "not json", "", "[]", "null"]) {
      expect(await runHook(command, input)).toMatchObject({ code: 0, stdout: "{}", stderr: "" });
    }
    expect(lines(hookEventsFile(eventsDir, "m_one"))).toEqual([]);
  });
  test("표지는 낱말 경계를 지킨다(긴 토큰 안의 글은 표지가 아니다). 대화 id 모양이 다르면 null", async () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home);
    const command = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir }));
    await runHook(command, hookInput("PreInvocation", { conversationId: "../../etc", invocationNum: 2, lastUserInput: `x${ITEM} ${ITEM}z ${ITEM2}` }));
    const [record] = lines(hookEventsFile(eventsDir, "m_one"));
    expect(record).toMatchObject({ conversationId: null, invocation: 2, markers: [ITEM2] });
  });
  test("실행 파일·스크립트가 없어도 셸이 `{}` 를 찍고 0 으로 끝낸다(에이전트를 붙잡지 않는다)", async () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home);
    const missing = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir, recorder: { execPath: "/nonexistent/bun" } }));
    expect(await runHook(missing, hookInput("Stop"))).toMatchObject({ code: 0, stdout: "{}", stderr: "" });
    const command = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir }));
    rmSync(join(home, "run", `${GEMINI_HOOK_RECORDER_MARKER}.mjs`));
    expect(await runHook(command, hookInput("Stop"))).toMatchObject({ code: 0, stdout: "{}", stderr: "" });
    rmSync(join(home, "run"), { recursive: true });
    expect(await runHook(command, hookInput("Stop"))).toMatchObject({ code: 0, stdout: "{}", stderr: "" });
  });
  test("표준 입력이 닫히지 않아도 0.5초 안팎에 `{}` 로 끝난다", async () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home);
    const command = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir }));
    const result = await runHook(command, null);
    expect(result).toMatchObject({ code: 0, stdout: "{}" });
    expect(result.ms).toBeLessThan(3000);
  });
  test("사건 파일이 링크면 따라가 쓰지 않는다. 그래도 `{}`", async () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home), target = join(home, "elsewhere.txt");
    const command = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir }));
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(target, "");
    symlinkSync(target, hookEventsFile(eventsDir, "m_one"));
    expect(await runHook(command, hookInput("Stop"))).toMatchObject({ code: 0, stdout: "{}" });
    expect(readFileSync(target, "utf8")).toBe("");
  });
  test("상한을 넘으면 .1 로 한 번 돌린다", async () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home);
    const command = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir, recorder: { maxFileBytes: 300 } }));
    for (let i = 0; i < 4; i++) await runHook(command, hookInput("PreInvocation", { invocationNum: i, lastUserInput: `글 ${ITEM}` }));
    expect(existsSync(hookEventsFile(eventsDir, "m_one", true))).toBe(true);
    expect(lines(hookEventsFile(eventsDir, "m_one")).length + lines(hookEventsFile(eventsDir, "m_one", true)).length).toBeGreaterThanOrEqual(2);
  });
  test("팀장 작업 폴더의 bunfig.toml(preload)을 읽지 않는다: 그 폴더의 코드가 훅 출력을 바꾸지 못한다", async () => {
    const home = temp(), project = temp(), eventsDir = geminiHookEventsDir(home);
    writeFileSync(join(project, "preload.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(project, "preloaded"))}, "x"); console.log('{"decision":"continue"}');`);
    writeFileSync(join(project, "bunfig.toml"), `preload = ["./preload.ts"]\n`);
    const command = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir }));
    expect(await runHook(command, hookInput("Stop"), { cwd: project })).toMatchObject({ code: 0, stdout: "{}" });
    expect(existsSync(join(project, "preloaded"))).toBe(false);
    expect(lines(hookEventsFile(eventsDir, "m_one"))).toHaveLength(1);
  });
});

describe("parseGeminiHookLine", () => {
  test("아는 모양만 받는다", () => {
    expect(parseGeminiHookLine(JSON.stringify({ v: 1, cli: "gemini", at: 5, event: "PreInvocation", conversationId: CONV, invocation: 1, markers: [ITEM, "nope", BUNDLE], chars: 10 })))
      .toEqual({ at: 5, event: "PreInvocation", conversationId: CONV, invocation: 1, markers: [ITEM, BUNDLE], chars: 10 });
    expect(parseGeminiHookLine(JSON.stringify({ v: 1, cli: "gemini", at: 5, event: "Stop", conversationId: null, reason: "bad reason", fullyIdle: "yes" })))
      .toEqual({ at: 5, event: "Stop", conversationId: null, reason: "other", fullyIdle: null, failed: false });
    expect(parseGeminiHookLine(JSON.stringify({ v: 1, cli: "gemini", at: 5, event: "SessionStart", conversationId: CONV }))).toEqual({ at: 5, event: "SessionStart", conversationId: CONV });
  });
  test("다른 판·다른 CLI·모르는 사건·깨진 줄은 null", () => {
    for (const line of ["", "{", "[]", "null", JSON.stringify({ v: 2, cli: "gemini", at: 5, event: "Stop" }), JSON.stringify({ v: 1, cli: "claude", at: 5, event: "Stop" }),
      JSON.stringify({ v: 1, at: 5, event: "Stop", sessionId: "s" }), JSON.stringify({ v: 1, cli: "gemini", at: 0, event: "Stop" }), JSON.stringify({ v: 1, cli: "gemini", at: 5, event: "UserPromptSubmit" })]) {
      expect(parseGeminiHookLine(line)).toBeNull();
    }
  });
  test("Claude 훅 기록과 서로 읽지 않는다(파일을 섞지 않는 까닭)", () => {
    const gemini = JSON.stringify({ v: 1, cli: "gemini", at: 5, event: "PreInvocation", conversationId: CONV, invocation: 0, markers: [ITEM], chars: 3 });
    const claude = JSON.stringify({ v: 1, at: 5, event: "Stop", sessionId: "sess-1" });
    expect(parseHookEventLine(gemini)).toBeNull();
    expect(parseGeminiHookLine(claude)).toBeNull();
    // Claude 쪽 읽기(HookEventReader)는 줄 풀이만 다른 같은 읽기다.
    const home = temp(), dir = hookEventsDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(hookEventsFile(dir, "m_one"), `${claude}\n${gemini}\n`);
    expect(new HookEventReader(dir, "m_one").read()).toMatchObject({ records: [{ event: "Stop", sessionId: "sess-1" }], invalid: 1 });
    expect(new HookFileReader(dir, "m_one", parseGeminiHookLine).read()).toMatchObject({ records: [{ event: "PreInvocation" }], invalid: 1 });
  });
});

describe("readGeminiDeliveryEvidence: 전달 수신 증거", () => {
  const markers = [{ deliveryId: "d1", marker: ITEM }, { deliveryId: "d2", marker: ITEM2 }];
  function setup() {
    const home = temp(), eventsDir = geminiHookEventsDir(home), file = hookEventsFile(eventsDir, "m_one");
    mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
    chmodSync(join(home, "run"), 0o700); chmodSync(eventsDir, 0o700);
    const append = (record: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify({ v: 1, cli: "gemini", at: Date.now(), conversationId: CONV, ...record })}\n`, { mode: 0o600 });
    return { home, eventsDir, file, append };
  }
  test("자리 뒤의 PreInvocation 에 표지가 있으면 받은 것(묶음 표지면 묶음 전부)", () => {
    const f = setup();
    f.append({ event: "PreInvocation", invocation: 0, markers: [ITEM], chars: 5 }); // 자리 앞: 앞선 전달
    const mark = hookEventsMark(f.eventsDir, "m_one");
    expect(readGeminiDeliveryEvidence({ eventsDir: f.eventsDir, memberId: "m_one", markers, bundleMarker: BUNDLE, mark }))
      .toMatchObject({ evidence: { source: "gemini_log", verdict: "unknown", code: "marker_not_in_hook_log", location: "none", complete: false }, receivedDeliveryIds: [] });
    f.append({ event: "SessionStart" });
    f.append({ event: "PreInvocation", invocation: 0, markers: [ITEM2], chars: 9 });
    expect(readGeminiDeliveryEvidence({ eventsDir: f.eventsDir, memberId: "m_one", markers, bundleMarker: BUNDLE, mark }))
      .toMatchObject({ evidence: { source: "gemini_log", verdict: "present", code: "marker_in_user_input", location: "received_input" }, receivedDeliveryIds: ["d2"] });
    f.append({ event: "PreInvocation", invocation: 1, markers: [BUNDLE], chars: 9 });
    expect(readGeminiDeliveryEvidence({ eventsDir: f.eventsDir, memberId: "m_one", markers, bundleMarker: BUNDLE, mark }).receivedDeliveryIds.sort()).toEqual(["d1", "d2"]);
    // Stop 줄의 표지 칸(있을 리 없지만)은 근거가 아니다.
    const g = setup(), start = hookEventsMark(g.eventsDir, "m_one");
    g.append({ event: "Stop", reason: "NO_TOOL_CALL", markers: [ITEM] });
    expect(readGeminiDeliveryEvidence({ eventsDir: g.eventsDir, memberId: "m_one", markers, mark: start }).evidence.verdict).toBe("unknown");
  });
  test("그때 파일이 없었으면(자리의 identity null) 뒤에 생긴 파일의 줄은 모두 그 뒤의 것이다", () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home);
    const mark = hookEventsMark(eventsDir, "m_one");
    expect(mark).toEqual({ identity: null, offset: 0 });
    expect(readGeminiDeliveryEvidence({ eventsDir, memberId: "m_one", markers, mark }).evidence).toMatchObject({ verdict: "unknown", code: "hook_log_missing" });
    mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
    chmodSync(join(home, "run"), 0o700); chmodSync(eventsDir, 0o700);
    writeFileSync(hookEventsFile(eventsDir, "m_one"), `${JSON.stringify({ v: 1, cli: "gemini", at: Date.now(), event: "PreInvocation", conversationId: CONV, invocation: 0, markers: [ITEM, ITEM2], chars: 1 })}\n`, { mode: 0o600 });
    expect(readGeminiDeliveryEvidence({ eventsDir, memberId: "m_one", markers, mark }).receivedDeliveryIds.sort()).toEqual(["d1", "d2"]);
  });
  test("근거가 없으면 모른다: absent(안 받음)는 내지 않는다", () => {
    const f = setup();
    f.append({ event: "PreInvocation", invocation: 0, markers: [], chars: 5 });
    const cases: [string, Parameters<typeof readGeminiDeliveryEvidence>[0]][] = [
      ["hooks_off", { eventsDir: null, memberId: "m_one", markers, mark: { identity: null, offset: 0 } }],
      ["no_baseline", { eventsDir: f.eventsDir, memberId: "m_one", markers, mark: undefined }],
      ["no_baseline", { eventsDir: f.eventsDir, memberId: "m_one", markers, mark: null }],
      ["no_baseline", { eventsDir: f.eventsDir, memberId: "m_one", markers, mark: { identity: "nope", offset: 3 } }],
      ["hook_log_missing", { eventsDir: f.eventsDir, memberId: "m_none", markers, mark: { identity: null, offset: 0 } }],
      ["invalid_member", { eventsDir: f.eventsDir, memberId: "../x", markers, mark: { identity: null, offset: 0 } }],
      ["invalid_marker", { eventsDir: f.eventsDir, memberId: "m_one", markers: [{ deliveryId: "d1", marker: "#iamceo_short" }], mark: { identity: null, offset: 0 } }],
      ["invalid_marker", { eventsDir: f.eventsDir, memberId: "m_one", markers: [{ deliveryId: "d1", marker: ITEM }, { deliveryId: "d1", marker: ITEM2 }], mark: { identity: null, offset: 0 } }],
      ["invalid_marker", { eventsDir: f.eventsDir, memberId: "m_one", markers, bundleMarker: ITEM, mark: { identity: null, offset: 0 } }],
      ["marker_not_in_hook_log", { eventsDir: f.eventsDir, memberId: "m_one", markers, mark: { identity: null, offset: 0 } }],
    ];
    for (const [code, options] of cases) {
      const read = readGeminiDeliveryEvidence(options);
      expect([code, read.evidence.verdict, read.evidence.code, read.receivedDeliveryIds]).toEqual([code, "unknown", code, []]);
      expect(read.evidence.verdict).not.toBe("absent");
    }
  });
  test("남이 쓸 수 있는 폴더·링크로 바꿔친 파일은 근거로 읽지 않는다", () => {
    const f = setup();
    f.append({ event: "PreInvocation", invocation: 0, markers: [ITEM, ITEM2], chars: 5 });
    const mark = { identity: null, offset: 0 };
    expect(readGeminiDeliveryEvidence({ eventsDir: f.eventsDir, memberId: "m_one", markers, mark }).evidence.verdict).toBe("present");
    chmodSync(f.eventsDir, 0o777);
    expect(readGeminiDeliveryEvidence({ eventsDir: f.eventsDir, memberId: "m_one", markers, mark }).evidence).toMatchObject({ verdict: "unknown", code: "hook_log_untrusted" });
    chmodSync(f.eventsDir, 0o700);
    const real = join(f.home, "real.jsonl");
    renameSync(f.file, real);
    symlinkSync(real, f.file);
    expect(readGeminiDeliveryEvidence({ eventsDir: f.eventsDir, memberId: "m_one", markers, mark }).evidence).toMatchObject({ verdict: "unknown", code: "hook_log_untrusted" });
  });
  test("돌린 파일(.1)에 남은 줄도 자리 뒤면 읽는다", () => {
    const f = setup();
    f.append({ event: "SessionStart" });
    const mark = hookEventsMark(f.eventsDir, "m_one");
    f.append({ event: "PreInvocation", invocation: 0, markers: [ITEM], chars: 5 });
    renameSync(f.file, hookEventsFile(f.eventsDir, "m_one", true));
    f.append({ event: "PreInvocation", invocation: 0, markers: [ITEM2], chars: 5 });
    expect(readGeminiDeliveryEvidence({ eventsDir: f.eventsDir, memberId: "m_one", markers, mark }).receivedDeliveryIds.sort()).toEqual(["d1", "d2"]);
  });
  test("스크립트가 남긴 줄을 그대로 읽는다(쓰기와 읽기의 모양이 맞다)", async () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home);
    const command = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir }));
    const mark = hookEventsMark(eventsDir, "m_one");
    await runHook(command, hookInput("PreInvocation", { invocationNum: 0, lastUserInput: `전달 ${ITEM}\n\n${BUNDLE}` }));
    const read = readGeminiDeliveryEvidence({ eventsDir, memberId: "m_one", markers, bundleMarker: BUNDLE, mark });
    expect(read.evidence).toMatchObject({ source: "gemini_log", verdict: "present" });
    expect(read.receivedDeliveryIds.sort()).toEqual(["d1", "d2"]);
  });
});

describe("readGeminiHookConversation: 대화 id 의 둘째 근거", () => {
  const BUNDLE2 = "#iamceo_b_EEEEEEEEEEEEEEEEEEEEEE";
  function setup() {
    const home = temp(), eventsDir = geminiHookEventsDir(home), file = hookEventsFile(eventsDir, "m_one");
    mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
    chmodSync(join(home, "run"), 0o700); chmodSync(eventsDir, 0o700);
    const append = (record: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify({ v: 1, cli: "gemini", at: Date.now(), conversationId: CONV, ...record })}\n`, { mode: 0o600 });
    const launched = Date.now() - 1000;
    let watch: GeminiHookConversationWatch | null = null;
    /** 같은 터미널이 이어서 묻는다(읽던 자리를 잇는다). */
    const ask = (bundleMarkers: string[], since = launched, memberId = "m_one", dir: string | null = eventsDir) => {
      const read = readGeminiHookConversation({ eventsDir: dir, memberId, since, bundleMarkers }, watch);
      watch = read.watch;
      return read.conversationId;
    };
    return { home, eventsDir, file, append, ask, launched };
  }
  test("띄운 뒤에 적혔고 서버가 넣은 묶음 표지가 든 PreInvocation 줄의 conversationId 다. 여럿이면 가장 나중 것", () => {
    const f = setup();
    expect(f.ask([BUNDLE])).toBeNull(); // 파일이 없다
    f.append({ event: "SessionStart" });
    f.append({ event: "PreInvocation", invocation: 0, markers: [ITEM, BUNDLE], chars: 40 });
    f.append({ event: "Stop", reason: "NO_TOOL_CALL", fullyIdle: true, failed: false });
    expect(f.ask([BUNDLE])).toBe(CONV);
    // 다시 물어도 같다(읽던 자리 뒤에 새 줄이 없어도 기억한 줄로 답한다).
    expect(f.ask([BUNDLE])).toBe(CONV);
    // 그 줄이 적힌 시각도 함께 준다. 그 시각을 since 로 주면(이미 그 id 를 안다) 같은 줄은 다시 근거가 되지 않는다.
    const found = readGeminiHookConversation({ eventsDir: f.eventsDir, memberId: "m_one", since: f.launched, bundleMarkers: [BUNDLE] });
    expect(found).toMatchObject({ conversationId: CONV });
    expect(found.at).toBeGreaterThan(f.launched);
    expect(readGeminiHookConversation({ eventsDir: f.eventsDir, memberId: "m_one", since: found.at!, bundleMarkers: [BUNDLE] })).toMatchObject({ conversationId: null, at: null });
    // 터미널 안에서 대화를 새로 열었다: 뒤의 봉투가 든 줄의 id 로 바뀐다.
    f.append({ event: "PreInvocation", conversationId: "conversation-two", invocation: 0, markers: [BUNDLE2], chars: 40 });
    expect(f.ask([BUNDLE])).toBe(CONV);
    expect(f.ask([BUNDLE, BUNDLE2])).toBe("conversation-two");
    expect(f.ask(new Array<string>())).toBeNull();
  });
  test("근거로 쓰지 않는 줄: 표지 없는 줄, 낱개 표지만 든 줄, 다른 봉투의 줄, 대화 id 없는 줄, 띄우기 전의 줄, SessionStart·Stop", () => {
    const f = setup();
    f.append({ at: f.launched - 5000, event: "PreInvocation", conversationId: "before-launch", invocation: 0, markers: [BUNDLE], chars: 40 });
    f.append({ at: f.launched, event: "PreInvocation", conversationId: "at-launch", invocation: 0, markers: [BUNDLE], chars: 40 });
    f.append({ event: "PreInvocation", conversationId: "typed-by-hand", invocation: 0, markers: [], chars: 40 });
    f.append({ event: "PreInvocation", conversationId: "item-only", invocation: 0, markers: [ITEM, ITEM2], chars: 40 });
    f.append({ event: "PreInvocation", conversationId: "other-envelope", invocation: 0, markers: [ITEM, BUNDLE2], chars: 40 });
    f.append({ event: "PreInvocation", conversationId: null, invocation: 0, markers: [BUNDLE], chars: 40 });
    f.append({ event: "PreInvocation", conversationId: "bad id/..", invocation: 0, markers: [BUNDLE], chars: 40 });
    f.append({ event: "SessionStart", conversationId: "session-start", markers: [BUNDLE] });
    f.append({ event: "Stop", conversationId: "stop", reason: "NO_TOOL_CALL", markers: [BUNDLE] });
    expect(f.ask([BUNDLE])).toBeNull();
    // 낱개 전달의 표지를 묶음 표지 자리에 넘겨도 견주지 않는다(다시 보낼 때 그대로 쓰여 다른 터미널에도 들어갔을 수 있다).
    expect(f.ask([ITEM, ITEM2])).toBeNull();
    // 띄운 시각이 더 앞이면 그 줄들이 근거가 된다(가장 나중 것).
    expect(f.ask([BUNDLE], f.launched - 10_000)).toBe("at-launch");
    expect(f.ask([BUNDLE], Number.NaN)).toBeNull();
  });
  test("읽을 수 없으면 null: 훅을 넣지 않음, 잘못된 팀장 id, 남이 쓸 수 있는 폴더·파일, 링크로 바꿔친 파일", () => {
    const f = setup();
    f.append({ event: "PreInvocation", invocation: 0, markers: [BUNDLE], chars: 40 });
    expect(f.ask([BUNDLE], f.launched, "m_one", null)).toBeNull();
    expect(f.ask([BUNDLE], f.launched, "../x")).toBeNull();
    expect(f.ask([BUNDLE], f.launched, "m_none")).toBeNull();
    chmodSync(f.eventsDir, 0o777);
    expect(f.ask([BUNDLE])).toBeNull();
    chmodSync(f.eventsDir, 0o700);
    chmodSync(f.file, 0o666);
    expect(f.ask([BUNDLE])).toBeNull();
    chmodSync(f.file, 0o600);
    expect(f.ask([BUNDLE])).toBe(CONV);
    const real = join(f.home, "real.jsonl");
    renameSync(f.file, real);
    symlinkSync(real, f.file);
    const fresh = readGeminiHookConversation({ eventsDir: f.eventsDir, memberId: "m_one", since: f.launched, bundleMarkers: [BUNDLE] });
    expect(fresh.conversationId).toBeNull();
  });
  test("앞으로만 읽는다: 돌린 파일(.1)에 남은 줄을 마저 읽고 새 파일로 넘어간다", () => {
    const f = setup();
    f.append({ event: "SessionStart" });
    expect(f.ask([BUNDLE, BUNDLE2])).toBeNull();
    f.append({ event: "PreInvocation", invocation: 0, markers: [BUNDLE], chars: 40 });
    renameSync(f.file, hookEventsFile(f.eventsDir, "m_one", true));
    // 돌린 직후(새 파일이 아직 없다)에는 읽지 않는다. 기록 스크립트가 곧 새 파일에 줄을 쓴다.
    expect(f.ask([BUNDLE, BUNDLE2])).toBeNull();
    f.append({ event: "PreInvocation", conversationId: "conversation-two", invocation: 0, markers: [BUNDLE2], chars: 40 });
    // 돌린 파일에 남은 줄(읽던 자리 뒤)과 새 파일의 줄을 모두 읽었다.
    expect(f.ask([BUNDLE])).toBe(CONV);
    expect(f.ask([BUNDLE, BUNDLE2])).toBe("conversation-two");
  });
  test("스크립트가 남긴 줄을 그대로 읽는다(쓰기와 읽기의 모양이 맞다)", async () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home), since = Date.now() - 1000;
    const command = commandOf(geminiHooksConfig({ memberId: "m_one", eventsDir }));
    await runHook(command, hookInput("SessionStart"));
    await runHook(command, hookInput("PreInvocation", { invocationNum: 0, lastUserInput: "사람이 친 글" }));
    expect(readGeminiHookConversation({ eventsDir, memberId: "m_one", since, bundleMarkers: [BUNDLE] }).conversationId).toBeNull();
    await runHook(command, hookInput("PreInvocation", { invocationNum: 0, lastUserInput: `[총괄 → 팀장] 전달 ${ITEM}\n\n${BUNDLE}` }));
    expect(readGeminiHookConversation({ eventsDir, memberId: "m_one", since, bundleMarkers: [BUNDLE] }).conversationId).toBe(CONV);
  });
});

describe("geminiHookLastWrite: 마지막으로 줄이 덧붙은 때", () => {
  test("줄이 없으면 null, 있으면 파일의 수정 시각(돌린 파일 포함), 볼 수 없으면 unknown", () => {
    const home = temp(), eventsDir = geminiHookEventsDir(home), file = hookEventsFile(eventsDir, "m_one"), rotated = hookEventsFile(eventsDir, "m_one", true);
    // 폴더도 파일도 없다.
    expect(geminiHookLastWrite(eventsDir, "m_one")).toBeNull();
    mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
    expect(geminiHookLastWrite(eventsDir, "m_one")).toBeNull();
    // 빈 파일에는 줄이 없다.
    writeFileSync(file, "", { mode: 0o600 });
    expect(geminiHookLastWrite(eventsDir, "m_one")).toBeNull();
    appendFileSync(file, "{}\n");
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect(geminiHookLastWrite(eventsDir, "m_one")).toBe(1_700_000_000_000);
    // 다른 팀장의 파일은 보지 않는다.
    expect(geminiHookLastWrite(eventsDir, "m_two")).toBeNull();
    // 돌린 파일만 남았거나(돌린 직후) 둘 다 있으면 더 나중 것.
    writeFileSync(rotated, "{}\n", { mode: 0o600 });
    utimesSync(rotated, 1_700_000_500, 1_700_000_500);
    expect(geminiHookLastWrite(eventsDir, "m_one")).toBe(1_700_000_500_000);
    rmSync(file);
    expect(geminiHookLastWrite(eventsDir, "m_one")).toBe(1_700_000_500_000);
    // 볼 수 없는 것: 폴더가 그 자리에 있다, 링크다, 잘못된 팀장 id, 상대 경로.
    mkdirSync(file);
    expect(geminiHookLastWrite(eventsDir, "m_one")).toBe("unknown");
    rmSync(file, { recursive: true });
    symlinkSync(rotated, file);
    expect(geminiHookLastWrite(eventsDir, "m_one")).toBe("unknown");
    expect(geminiHookLastWrite(eventsDir, "../x")).toBe("unknown");
    expect(geminiHookLastWrite("run/gemini-events", "m_one")).toBe("unknown");
  });
});
