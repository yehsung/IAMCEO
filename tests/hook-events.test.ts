// E1 나란히 모으기: 훅 설정 조립, 기록 스크립트(실제로 실행), 사건 기록 읽기, 지금 판정과의 비교, 진단 파일, CoreRunner 연결.
// 진짜 Claude Code 는 띄우지 않는다. 기록 스크립트는 CLI 가 하듯 /bin/sh -c 로 명령을 돌리고 표준 입력에 훅 JSON 을 넣어 확인한다.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_EVENTS, HOOK_TIMEOUT_SEC, hookEventsDir, hookEventsFile, hookSettings, mergeHooks, HOOK_COMPARE_FILE } from "../server/runner/hooks.ts";
import { HookEventReader, parseHookEventLine } from "../server/runner/hook-events.ts";
import { HookShadow, hookErrorKind, summaryLine } from "../server/runner/hook-compare.ts";
import { providerLaunch } from "../server/runner/providers.ts";
import { CoreRunner } from "../server/runner/core.ts";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import type { RunnerEvent, RunnerMember, StartOpts } from "../server/runner/types.ts";
import { createDiagnostics } from "../server/diagnose.ts";

const dirs: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "iamceo-hooks-")); dirs.push(dir); return dir; }
const member = (extra: Partial<RunnerMember> = {}): RunnerMember => ({ id: "m_one", sessionGeneration: 1, projectId: "p_one", cli: "claude", handle: "w", name: "Worker", cwd: "/tmp", sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker", ...extra });
const ITEM = "#iamceo_AAAAAAAAAAAAAAAAAAAAAA";
const ITEM2 = "#iamceo_CCCCCCCCCCCCCCCCCCCCCC";
const BUNDLE = "#iamceo_b_BBBBBBBBBBBBBBBBBBBBBB";

function commandOf(hooks: Record<string, unknown>, event: string): string {
  return ((hooks[event] as { hooks: { command: string }[] }[])[0]!.hooks[0]!).command;
}
async function runHook(command: string, input: string, opts: { closeStdin?: boolean } = {}) {
  const started = Date.now();
  const child = Bun.spawn(["/bin/sh", "-c", command], { stdin: opts.closeStdin === false ? "pipe" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, ms: Date.now() - started };
}
const hookInput = (event: string, extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: "sess-1", transcript_path: "/x/sess-1.jsonl", cwd: "/tmp", permission_mode: "default", hook_event_name: event, ...extra });
function lines(path: string): Record<string, unknown>[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

describe("hookSettings: --settings 에 넣을 hooks", () => {
  test("다섯 사건 모두 같은 기록 명령, 매처 없음, 제한 시간, 출력은 버리고 언제나 0 으로 끝남", () => {
    const home = temp(), eventsDir = hookEventsDir(home);
    const hooks = hookSettings({ memberId: "m_one", eventsDir });
    expect(Object.keys(hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    for (const name of HOOK_EVENTS) {
      const groups = hooks[name] as { matcher?: string; hooks: { type: string; command: string; timeout: number }[] }[];
      expect(groups).toHaveLength(1);
      expect(groups[0]!.matcher).toBeUndefined();
      expect(groups[0]!.hooks).toEqual([{ type: "command", command: commandOf(hooks, "Stop"), timeout: HOOK_TIMEOUT_SEC }]);
    }
    const command = commandOf(hooks, "Stop");
    expect(command).toContain("iamceo-hook-recorder.mjs");
    expect(command).toContain(`'${eventsDir}' 'm_one'`);
    expect(command.endsWith(">/dev/null 2>&1; exit 0")).toBe(true);
    expect(existsSync(join(home, "run", "iamceo-hook-recorder.mjs"))).toBe(true);
    expect(statSync(join(home, "run", "iamceo-hook-recorder.mjs")).mode & 0o777).toBe(0o600);
  });
  test("K 의 permissionHook 은 같은 객체의 PermissionRequest 로, events:false 면 그것만", () => {
    const eventsDir = hookEventsDir(temp());
    const hooks = hookSettings({ memberId: "m_one", eventsDir, permissionHook: { command: "/bin/true", timeoutSec: 120 } });
    expect(hooks.PermissionRequest).toEqual([{ hooks: [{ type: "command", command: "/bin/true", timeout: 120 }] }]);
    expect(Object.keys(hookSettings({ memberId: "m_one", eventsDir, events: false, permissionHook: { command: "/bin/true", timeoutSec: 30 } }))).toEqual(["PermissionRequest"]);
    expect(hookSettings({ memberId: "m_one", eventsDir, events: false })).toEqual({});
    expect(() => hookSettings({ memberId: "m_one", eventsDir, permissionHook: { command: " ", timeoutSec: 30 } })).toThrow();
  });
  test("잘못된 팀장 ID·상대 경로는 던진다(부르는 쪽이 훅 없이 띄운다)", () => {
    expect(() => hookSettings({ memberId: "../x", eventsDir: hookEventsDir(temp()) })).toThrow();
    expect(() => hookSettings({ memberId: "m_one", eventsDir: "run/events" })).toThrow();
  });
  test("mergeHooks 는 사용자가 넘긴 hooks 를 덮지 않고 잇는다", () => {
    const mine = { type: "command", command: "echo mine" };
    const merged = mergeHooks({ Stop: [{ hooks: [mine] }], PreToolUse: [{ matcher: "Bash", hooks: [mine] }] }, { Stop: [{ hooks: [{ type: "command", command: "ours" }] }], SessionStart: [] });
    expect(merged.PreToolUse).toEqual([{ matcher: "Bash", hooks: [mine] }]);
    expect(merged.Stop).toEqual([{ hooks: [mine] }, { hooks: [{ type: "command", command: "ours" }] }]);
    expect(merged.SessionStart).toEqual([]);
    expect(mergeHooks("nonsense", { Stop: [] })).toEqual({ Stop: [] });
  });
});

describe("providerLaunch: statusLine 과 같은 --settings 하나", () => {
  function opts(dir: string, settings?: Record<string, unknown>): StartOpts {
    const o: StartOpts = { systemPromptFile: join(dir, "rules.md"), mcpConfigFile: join(dir, "mcp.json"), resume: false };
    writeFileSync(o.systemPromptFile, "rules");
    writeFileSync(o.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: [] } } }));
    if (settings) { o.settingsFile = join(dir, "settings.json"); writeFileSync(o.settingsFile, JSON.stringify(settings)); }
    return o;
  }
  const settingsOf = (argv: string[]) => JSON.parse(argv[argv.indexOf("--settings") + 1]!);
  test("Claude: statusLine·기존 설정·hooks 가 한 JSON 에, 사용자 hooks 는 이어 붙는다", () => {
    const dir = temp();
    const launch = providerLaunch(member(), opts(dir, { skipDangerousModePermissionPrompt: true, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user" }] }] } }), { claudeBin: "/fake/claude", contextHome: dir });
    expect(launch.argv.filter(a => a === "--settings")).toHaveLength(1);
    const settings = settingsOf(launch.argv);
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.statusLine.command).toContain("iamceo-context-statusline");
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo user");
    expect(settings.hooks.Stop[1].hooks[0].command).toContain(`'${hookEventsDir(dir)}' 'm_one'`);
  });
  test("hookEvents:false 또는 IAMCEO_HOOK_EVENTS=0 이면 hooks 를 넣지 않는다", () => {
    const dir = temp();
    expect(settingsOf(providerLaunch(member(), opts(dir), { claudeBin: "/fake/claude", contextHome: dir, hookEvents: false }).argv).hooks).toBeUndefined();
    const before = process.env.IAMCEO_HOOK_EVENTS;
    process.env.IAMCEO_HOOK_EVENTS = "0";
    try { expect(settingsOf(providerLaunch(member(), opts(dir), { claudeBin: "/fake/claude", contextHome: dir }).argv).hooks).toBeUndefined(); }
    finally { if (before === undefined) delete process.env.IAMCEO_HOOK_EVENTS; else process.env.IAMCEO_HOOK_EVENTS = before; }
  });
  test("훅을 만들 수 없는 팀장 ID 여도 CLI 는 그대로 띄운다", () => {
    const dir = temp();
    const launch = providerLaunch(member({ id: "bad id/.." }), opts(dir), { claudeBin: "/fake/claude", contextHome: dir });
    expect(launch.argv).toContain("--session-id");
    expect(settingsOf(launch.argv).hooks).toBeUndefined();
    expect(settingsOf(launch.argv).statusLine.command).toContain("iamceo-context-statusline");
  });
  test("Codex 와 contextHome 없는 Claude 에는 넣지 않는다(지금과 같다)", () => {
    const dir = temp();
    const codex = providerLaunch(member({ cli: "codex" }), opts(dir), { codexBin: "/fake/codex", contextHome: dir });
    expect(codex.argv.join(" ")).not.toContain("hooks");
    const plain = providerLaunch(member(), opts(dir, { a: 1 }), { claudeBin: "/fake/claude" });
    expect(plain.argv[plain.argv.indexOf("--settings") + 1]).toBe(join(dir, "settings.json"));
  });
});

describe("기록 스크립트: CLI 를 막지 않고 본문 없이 한 줄씩", () => {
  function setup(recorder: Parameters<typeof hookSettings>[0]["recorder"] = {}) {
    const home = temp(), eventsDir = hookEventsDir(home);
    const command = commandOf(hookSettings({ memberId: "m_one", eventsDir, recorder }), "Stop");
    return { home, eventsDir, command, file: hookEventsFile(eventsDir, "m_one") };
  }
  test("UserPromptSubmit: 표지와 글자 수만 남고 글 본문·표준 출력은 없다", async () => {
    const s = setup();
    const prompt = `비밀 계획서 내용\n${ITEM}\n\nmemo\n${ITEM2}\n${BUNDLE}\nnot-a-marker #iamceo_b_short x${ITEM}`;
    const r = await runHook(s.command, hookInput("UserPromptSubmit", { prompt }));
    expect(r).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const [line] = lines(s.file);
    expect(line).toMatchObject({ v: 1, event: "UserPromptSubmit", sessionId: "sess-1", markers: [ITEM, ITEM2, BUNDLE], chars: prompt.length });
    expect(readFileSync(s.file, "utf8")).not.toContain("비밀");
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    expect(statSync(s.eventsDir).mode & 0o777).toBe(0o700);
  });
  test("다섯 사건의 분류값만 남긴다(모르는 값은 other), 다른 사건은 남기지 않는다", async () => {
    const s = setup();
    await runHook(s.command, hookInput("SessionStart", { source: "clear", model: "x" }));
    await runHook(s.command, hookInput("Stop", { stop_hook_active: false, last_assistant_message: "비밀 답" }));
    await runHook(s.command, hookInput("StopFailure", { error: "rate_limit", error_details: "비밀 세부" }));
    await runHook(s.command, hookInput("StopFailure", { error: "Weird Value!" }));
    await runHook(s.command, hookInput("PostCompact", { trigger: "auto", compact_summary: "비밀 요약" }));
    await runHook(s.command, hookInput("PreToolUse", { tool_name: "Bash" }));
    await runHook(s.command, hookInput("SessionStart", { session_id: "../bad", source: "startup" }));
    const got = lines(s.file);
    expect(got.map(l => [l.event, l.source ?? l.error ?? l.trigger ?? null])).toEqual([["SessionStart", "clear"], ["Stop", null], ["StopFailure", "rate_limit"], ["StopFailure", "other"], ["PostCompact", "auto"], ["SessionStart", "startup"]]);
    expect(got.at(-1)!.sessionId).toBeNull();
    expect(readFileSync(s.file, "utf8")).not.toContain("비밀");
  });
  test("깨진 입력·빈 입력·실행 파일이 없을 때도 0 으로, 출력 없이 끝난다", async () => {
    const s = setup();
    for (const input of ["not json", "", "{\"hook_event_name\":123}"]) expect(await runHook(s.command, input)).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(s.file)).toBe(false);
    const missing = setup({ execPath: "/nonexistent/iamceo-bun" });
    expect(await runHook(missing.command, hookInput("Stop"))).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });
  test("사건 폴더를 쓸 수 없거나 기록 파일이 심볼릭 링크여도 0 으로 끝나고 링크 대상은 건드리지 않는다", async () => {
    const s = setup();
    mkdirSync(s.eventsDir, { recursive: true });
    const target = join(s.home, "target.txt"); writeFileSync(target, "original");
    symlinkSync(target, s.file);
    expect(await runHook(s.command, hookInput("Stop"))).toMatchObject({ code: 0, stdout: "" });
    expect(readFileSync(target, "utf8")).toBe("original");
    const blocked = setup();
    mkdirSync(join(blocked.home, "run"), { recursive: true }); writeFileSync(blocked.eventsDir, "a file, not a folder");
    expect(await runHook(blocked.command, hookInput("Stop"))).toMatchObject({ code: 0, stdout: "" });
  });
  test("표준 입력이 닫히지 않아도 스스로 정한 시간 안에 0 으로 끝난다", async () => {
    const s = setup({ safetyTimeoutMs: 300 });
    const r = await runHook(s.command, "", { closeStdin: false });
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(4000);
  });
  test("아주 큰 입력이면 앞·끝만 보고 글 끝의 묶음 표지를 찾는다(truncated)", async () => {
    const s = setup();
    const prompt = `${"가".repeat(2_000_000)}\n${ITEM}\n${BUNDLE}`;
    const r = await runHook(s.command, hookInput("UserPromptSubmit", { prompt }));
    expect(r.code).toBe(0);
    const [line] = lines(s.file);
    expect(line).toMatchObject({ event: "UserPromptSubmit", sessionId: "sess-1", truncated: true, chars: null });
    expect(line!.markers).toContain(BUNDLE);
    expect(readFileSync(s.file, "utf8")).not.toContain("가");
  });
  test("파일 상한을 넘으면 .1 로 한 번 돌리고 계속 쓴다", async () => {
    const s = setup({ maxFileBytes: 400 });
    for (let i = 0; i < 8; i++) await runHook(s.command, hookInput("Stop"));
    expect(existsSync(hookEventsFile(s.eventsDir, "m_one", true))).toBe(true);
    expect(statSync(s.file).size).toBeLessThanOrEqual(400);
    expect(lines(s.file).length + lines(hookEventsFile(s.eventsDir, "m_one", true)).length).toBeGreaterThanOrEqual(4);
  });
});

describe("HookEventReader", () => {
  const rec = (event: string, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, at: 1000, event, sessionId: "s1", ...extra }) + "\n";
  test("앞으로만 읽고, 덜 쓴 줄은 다음에, 모르는 줄은 센다", () => {
    const eventsDir = join(temp(), "events"); mkdirSync(eventsDir);
    const file = hookEventsFile(eventsDir, "m_one");
    const reader = new HookEventReader(eventsDir, "m_one");
    expect(reader.read()).toEqual({ records: [], invalid: 0 });
    writeFileSync(file, rec("Stop") + "garbage\n" + rec("PreToolUse") + rec("Stop").slice(0, 10));
    let got = reader.read();
    expect(got.records.map(r => r.event)).toEqual(["Stop"]);
    expect(got.invalid).toBe(2);
    appendFileSync(file, rec("Stop").slice(10) + rec("StopFailure", { error: "server_error" }));
    got = reader.read();
    expect(got.records.map(r => [r.event, r.error ?? null])).toEqual([["Stop", null], ["StopFailure", "server_error"]]);
    expect(reader.read().records).toEqual([]);
  });
  test("읽던 파일이 .1 로 돌면 남은 부분을 마저 읽고 새 파일로 넘어간다", () => {
    const eventsDir = join(temp(), "events"); mkdirSync(eventsDir);
    const file = hookEventsFile(eventsDir, "m_one");
    const reader = new HookEventReader(eventsDir, "m_one");
    writeFileSync(file, rec("Stop", { at: 1 }));
    expect(reader.read().records).toHaveLength(1);
    appendFileSync(file, rec("Stop", { at: 2 }));
    renameSync(file, hookEventsFile(eventsDir, "m_one", true));
    writeFileSync(file, rec("Stop", { at: 3 }));
    expect(reader.read().records.map(r => r.at)).toEqual([2, 3]);
    expect(reader.gaps).toBe(0);
  });
  test("심볼릭 링크는 읽지 않는다", () => {
    const dir = temp(), eventsDir = join(dir, "events"); mkdirSync(eventsDir);
    writeFileSync(join(dir, "elsewhere.jsonl"), rec("Stop"));
    symlinkSync(join(dir, "elsewhere.jsonl"), hookEventsFile(eventsDir, "m_one"));
    expect(new HookEventReader(eventsDir, "m_one").read().records).toEqual([]);
  });
  test("parseHookEventLine 은 엄격하다", () => {
    expect(parseHookEventLine(JSON.stringify({ v: 2, at: 1, event: "Stop" }))).toBeNull();
    expect(parseHookEventLine(JSON.stringify({ v: 1, at: 1, event: "Notification" }))).toBeNull();
    expect(parseHookEventLine(JSON.stringify({ v: 1, at: 1, event: "UserPromptSubmit", sessionId: "../x", markers: [ITEM, "#iamceo_bad", 3] }))).toEqual({ at: 1, event: "UserPromptSubmit", sessionId: null, markers: [ITEM], chars: null });
    expect(parseHookEventLine(JSON.stringify({ v: 1, at: 1, event: "SessionStart", sessionId: "s", source: "weird" }))?.source).toBe("other");
  });
});

describe("HookShadow: 지금 판정과 맞대어 세기만", () => {
  function shadow() {
    const dir = temp(), eventsDir = join(dir, "events"); mkdirSync(eventsDir);
    let now = 1_000_000;
    const logs: string[] = [];
    const s = new HookShadow({ eventsDir, now: () => now, tickMs: 0, log: line => logs.push(line) });
    const file = hookEventsFile(eventsDir, "m_one");
    const write = (event: string, extra: Record<string, unknown> = {}) => appendFileSync(file, JSON.stringify({ v: 1, at: now, event, sessionId: "sess-1", ...extra }) + "\n");
    const ev = (event: Record<string, unknown>) => s.observe({ memberId: "m_one", terminalId: "t1", ...event } as RunnerEvent, "claude");
    const begin = () => { ev({ type: "pane", paneId: "t1" }); ev({ type: "session", sessionId: "sess-1" }); };
    return { s, eventsDir, logs, write, ev, begin, file, advance: (ms: number) => { now += ms; }, get now() { return now; } };
  }
  test("수신 표지·턴 끝·오류 분류·압축·세션이 모두 맞으면 일치만 센다", () => {
    const t = shadow(); t.begin();
    t.write("SessionStart", { source: "startup" });
    t.s.sent("m_one", "claude", { sessionId: "sess-1", text: `일\n${ITEM}\n${BUNDLE}` });
    t.write("UserPromptSubmit", { markers: [ITEM, BUNDLE], chars: 10 });
    t.advance(5000); t.write("StopFailure", { error: "rate_limit" });
    t.advance(1500); t.ev({ type: "turn_end", finalText: "", isError: true, errorText: "You've hit your limit · resets 3pm" });
    t.write("PostCompact", { trigger: "manual" }); t.advance(2000); t.ev({ type: "compacted" });
    t.s.tick();
    const snap = t.s.snapshot();
    expect(snap.categories.receipt).toMatchObject({ matched: 1, mismatched: 0 });
    expect(snap.categories.turn_end).toMatchObject({ matched: 1, mismatched: 0 });
    expect(snap.categories.error_kind).toMatchObject({ matched: 1, mismatched: 0 });
    expect(snap.categories.compact).toMatchObject({ matched: 1, mismatched: 0 });
    expect(snap.categories.session).toMatchObject({ matched: 4, mismatched: 0 });
    expect(snap.overall.rate).toBe(100);
    expect(snap.membersWithHooks).toBe(1);
    expect(t.logs).toEqual([]);
  });
  test("훅이 없는 쪽·지금 판정이 없는 쪽을 각각 불일치로 센다", () => {
    const t = shadow(); t.begin();
    t.write("SessionStart", { source: "resume" });
    t.s.sent("m_one", "claude", { sessionId: "sess-1", text: `일\n${BUNDLE}` }); // 훅 기록 없음
    t.ev({ type: "turn_end", finalText: "", isError: false, inferred: true }); // Stop 없음
    t.write("UserPromptSubmit", { markers: ["#iamceo_b_ZZZZZZZZZZZZZZZZZZZZZZ"] }); // 보낸 적 없는 봉투
    t.write("PostCompact", { trigger: "auto" }); // 서버가 모르는 자동 압축
    t.write("UserPromptSubmit", { markers: [] }); // 대표가 직접 친 글: 맞대지 않음
    t.s.tick(); t.advance(400_000); t.s.tick();
    const snap = t.s.snapshot();
    expect(snap.categories.receipt.reasons).toEqual({ hook_missing: 1, hook_only: 1 });
    expect(snap.categories.turn_end.reasons).toEqual({ hook_missing_inferred: 1 });
    expect(snap.categories.compact.reasons).toEqual({ hook_only_auto: 1 });
    expect(t.logs.every(line => line.startsWith("[hooks] 불일치(판정은 그대로)"))).toBe(true);
    expect(t.logs).toHaveLength(4);
  });
  test("오류 분류가 다르거나 한쪽만 오류면 error_kind 불일치", () => {
    const t = shadow(); t.begin();
    t.write("StopFailure", { error: "authentication_failed" });
    t.ev({ type: "turn_end", finalText: "", isError: true, errorText: "API Error: 500 Internal" });
    t.advance(10_000); t.write("StopFailure", { error: "server_error" });
    t.ev({ type: "turn_end", finalText: "", isError: false });
    t.advance(10_000); t.write("Stop");
    t.ev({ type: "turn_end", finalText: "", isError: true, errorText: "API Error: 529 overloaded" });
    t.s.tick();
    expect(t.s.snapshot().categories.turn_end).toMatchObject({ matched: 3, mismatched: 0 });
    expect(t.s.snapshot().categories.error_kind.reasons).toEqual({ "network->auth(authentication_failed)": 1, "hook_error_only:server_error": 1, "server_error_only:network": 1 });
    expect(hookErrorKind("rate_limit")).toBe("usage_limit");
    expect(hookErrorKind("overloaded")).toBe("network");
    expect(hookErrorKind(undefined)).toBe("error");
  });
  test("/clear: 세션이 바뀐 것을 세고 로그에 남기기만 한다(서버 세션은 그대로)", () => {
    const t = shadow(); t.begin();
    t.write("SessionStart", { source: "startup" });
    t.advance(1000); t.write("SessionStart", { source: "clear", sessionId: "sess-2" });
    t.advance(1000); t.write("Stop", { sessionId: "sess-2" });
    t.ev({ type: "turn_end", finalText: "", isError: false });
    t.s.tick();
    const snap = t.s.snapshot();
    expect(snap.categories.session).toMatchObject({ matched: 1, mismatched: 2, reasons: { clear: 1, after_clear: 1 } });
    expect(snap.clears).toMatchObject({ count: 1, decision: "record_only" });
    expect(t.logs.some(line => line.includes("/clear") && line.includes("기록만"))).toBe(true);
    // 다음 판정 근거(서버가 아는 세션)는 그대로 sess-1 이다: 같은 기록이 와도 계속 불일치로 센다.
    t.advance(1000); t.write("Stop", { sessionId: "sess-2" }); t.s.tick();
    expect(t.s.snapshot().categories.session.reasons.after_clear).toBe(2);
  });
  test("훅 기록이 아예 없는 팀장(옛 CLI·훅 꺼짐)은 비율에 넣지 않고 따로 센다. Codex 는 보지 않는다", () => {
    const t = shadow(); t.begin();
    t.s.sent("m_one", "claude", { sessionId: "sess-1", text: BUNDLE });
    t.ev({ type: "turn_end", finalText: "", isError: false });
    t.s.observe({ memberId: "m_codex", terminalId: "t9", type: "turn_end", finalText: "", isError: false } as RunnerEvent, "codex");
    t.s.sent("m_codex", "codex", { sessionId: null, text: BUNDLE });
    t.advance(120_000); t.s.tick();
    const snap = t.s.snapshot();
    expect(snap.noHookData).toBe(2);
    expect(snap.overall).toEqual({ matched: 0, mismatched: 0, rate: null });
    expect(snap.membersWatched).toBe(1);
  });
  test("서버를 켜기 전의 기록·붙는 순간의 첫 turn_end 는 맞대지 않는다", () => {
    const t = shadow();
    appendFileSync(t.file, JSON.stringify({ v: 1, at: t.now - 60_000, event: "Stop", sessionId: "sess-1" }) + "\n");
    // CoreRunner.bind: 첫 관측의 turn_end 가 pane 보다 먼저 온다.
    t.ev({ type: "turn_end", finalText: "", isError: true, errorText: "API Error" });
    t.begin();
    t.s.tick(); t.advance(120_000); t.s.tick();
    const snap = t.s.snapshot();
    expect(snap.overall).toEqual({ matched: 0, mismatched: 0, rate: null });
    expect(snap.membersWithHooks).toBe(1);
  });
  test("같은 까닭의 불일치 로그는 10분에 한 번, 요약 줄과 비교 파일은 숫자만", () => {
    const t = shadow(); t.begin();
    t.write("SessionStart", { source: "startup" });
    for (let i = 0; i < 3; i++) { t.s.sent("m_one", "claude", { sessionId: "sess-1", text: `x\n${ITEM}\n${BUNDLE}` }); t.advance(61_000); t.s.tick(); }
    expect(t.logs.filter(line => line.includes("hook_missing"))).toHaveLength(1);
    t.advance(10 * 60_000); t.s.sent("m_one", "claude", { sessionId: "sess-1", text: BUNDLE }); t.advance(61_000); t.s.tick();
    expect(t.logs.filter(line => line.includes("hook_missing")).at(-1)).toContain("같은 까닭 2건 더");
    t.advance(30 * 60_000); t.s.tick();
    expect(t.logs.some(line => line.startsWith("[hooks] 훅 기록 비교(판정은 그대로): 일치"))).toBe(true);
    t.s.stop();
    const saved = readFileSync(join(t.eventsDir, HOOK_COMPARE_FILE), "utf8");
    expect(JSON.parse(saved)).toMatchObject({ version: 1, categories: { receipt: { mismatched: 4 } }, clears: { decision: "record_only" } });
    expect(saved).not.toContain("#iamceo_");
    expect(saved).not.toContain("sess-1");
    expect(statSync(join(t.eventsDir, HOOK_COMPARE_FILE)).mode & 0o777).toBe(0o600);
    expect(summaryLine(t.s.snapshot())).toContain("수신 표지 0/4");
  });
  test("시작할 때 30일 넘게 안 쓴 사건 파일만 지운다", () => {
    const dir = temp(), eventsDir = join(dir, "events"); mkdirSync(eventsDir);
    const old = hookEventsFile(eventsDir, "m_old"), fresh = hookEventsFile(eventsDir, "m_new"), other = join(eventsDir, "keep.txt");
    for (const path of [old, fresh, other]) writeFileSync(path, "x\n");
    const past = (Date.now() - 31 * 24 * 3_600_000) / 1000;
    utimesSync(old, past, past); utimesSync(other, past, past);
    new HookShadow({ eventsDir, tickMs: 0 }).stop();
    expect(readdirSync(eventsDir).sort()).toEqual(["keep.txt", "m_new.jsonl"]);
  });
  test("관측·보내기 알림에 이상한 값이 와도 던지지 않는다", () => {
    const t = shadow();
    expect(() => t.s.observe({ memberId: "../../x", type: "turn_end", finalText: "", isError: false } as RunnerEvent, "claude")).not.toThrow();
    expect(() => t.s.sent("m_one", "claude", { sessionId: null, text: "" })).not.toThrow();
    expect(() => t.s.tick()).not.toThrow();
  });
});

describe("진단 파일", () => {
  test("비교 숫자 파일과 [hooks] 로그 줄이 들어간다", async () => {
    const home = temp();
    mkdirSync(hookEventsDir(home), { recursive: true });
    writeFileSync(join(hookEventsDir(home), HOOK_COMPARE_FILE), JSON.stringify({ version: 1, overall: { matched: 3, mismatched: 1, rate: 75 } }));
    writeFileSync(hookEventsFile(hookEventsDir(home), "m_one"), JSON.stringify({ v: 1, at: 1, event: "UserPromptSubmit", sessionId: "s", markers: [BUNDLE] }) + "\n");
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(join(home, "logs", "server.err.log"), "[hooks] 불일치(판정은 그대로): 턴 끝 · hook_missing · m_one\nother line\n");
    const result = await createDiagnostics({ home, dbPath: join(home, "iamceo.db"), config: null, db: null, source: "cli", versions: { server: "test" }, doctor: null, service: async () => null, crashReportsDir: null });
    const dir = result.path.replace(/\.zip$/, "");
    expect(JSON.parse(readFileSync(join(dir, "hook-compare.json"), "utf8")).overall.rate).toBe(75);
    expect(readFileSync(join(dir, "events.txt"), "utf8")).toContain("[hooks] 불일치");
    expect(readFileSync(join(dir, "README.txt"), "utf8")).toContain("hook-compare.json");
    // 사건 기록 원본(세션·표지)은 넣지 않는다.
    expect(readdirSync(dir).some(name => name.endsWith(".jsonl"))).toBe(false);
  });
});

// ---- CoreRunner 연결: 판정은 그대로, 보내기·턴 끝만 비교로 흘러간다 ----
interface Request { jsonrpc: string; id: string; method: string; params: Record<string, any> }
async function fakeCore(dir: string) {
  const socketPath = join(dir, "c.sock");
  const terminals = new Map<string, CoreTerminal>();
  const calls: Request[] = [];
  const sockets = new Set<Socket>();
  const composer = `out\n${"─".repeat(30)}\n❯ \n${"─".repeat(30)}\n`;
  const methods = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill"];
  const server: Server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n"); const request = JSON.parse(buffer.slice(0, at)) as Request; buffer = buffer.slice(at + 1); calls.push(request);
        const p = request.params; let result: unknown;
        if (request.method === "hello") result = { generation: 1, version: "test", methods, features: [] };
        else if (request.method === "terminal.list") result = { terminals: [...terminals.values()] };
        else if (request.method === "terminal.run") { const t: CoreTerminal = { address: `t${terminals.size + 1}`, argv: p.argv, cwd: p.cwd, labels: p.labels, state: "live", cols: 160, rows: 50, turn: 0, status: { state: "idle", app: "claude-code" }, reported: true }; terminals.set(t.address, t); result = t; }
        else if (request.method === "terminal.get") result = terminals.get(p.terminal);
        else if (request.method === "terminal.read") result = { text: composer, complete: true, how: "screen" };
        else if (request.method === "terminal.send") { const t = terminals.get(p.terminal)!; result = { turn: t.turn, started: true, status: "idle" }; t.status = { state: "working" }; }
        else if (request.method === "terminal.kill") { const t = terminals.get(p.terminal)!; t.state = "finished"; result = t; }
        socket.write(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "no", data: { kind: "not_found" } } } : { jsonrpc: "2.0", id: request.id, result }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(async () => { for (const s of sockets) s.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { socketPath, terminals, calls };
}

describe("CoreRunner 연결", () => {
  test("띄울 때 hooks 가 실리고, 보내기·턴 끝이 비교에 들어가며 실행기 사건은 그대로다", async () => {
    const dir = temp(), core = await fakeCore(dir);
    const opts: StartOpts = { systemPromptFile: join(dir, "rules.md"), mcpConfigFile: join(dir, "mcp.json"), resume: false };
    writeFileSync(opts.systemPromptFile, "rules"); writeFileSync(opts.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: [] } } }));
    const eventsDir = hookEventsDir(dir);
    const shadow = new HookShadow({ eventsDir, tickMs: 0, log: () => {} });
    const make = (hookShadow: HookShadow | false) => new CoreRunner({ socketPath: core.socketPath, claudeBin: "/fake/claude", codexBin: "/fake/codex", claudeHome: join(dir, "claude-home"), contextHome: dir }, { pollMs: 20, rpcTimeoutMs: 200, sendTimeoutMs: 300, hookShadow });
    const runner = make(shadow);
    cleanups.push(() => runner.shutdown());
    const events: RunnerEvent[] = []; runner.on(e => events.push(e));
    const started = await runner.start(member(), opts);
    const run = core.calls.find(c => c.method === "terminal.run")!;
    const settings = JSON.parse(run.params.argv[run.params.argv.indexOf("--settings") + 1]);
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    // 훅이 한 일을 흉내 낸다(실제 CLI 는 이 명령을 부른다).
    const sessionId = started.sessionId!;
    const hookCommand = settings.hooks.UserPromptSubmit[0].hooks[0].command as string;
    await runHook(hookCommand, JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart", source: "startup" }));
    const text = `할 일\n${ITEM}\n${BUNDLE}`;
    const result = await runner.send(member({ paneId: started.paneId, sessionId }), text, { ...opts, marker: BUNDLE });
    expect(result).toMatchObject({ ok: true });
    await runHook(hookCommand, JSON.stringify({ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: text }));
    const terminal = core.terminals.get(started.paneId)!;
    terminal.turn = 1; terminal.status = { state: "idle", app: "claude-code" };
    await runHook(hookCommand, JSON.stringify({ session_id: sessionId, hook_event_name: "Stop" }));
    for (let i = 0; i < 200 && !events.some(e => e.type === "turn_end"); i++) await Bun.sleep(10);
    expect(events.find(e => e.type === "turn_end")).toMatchObject({ type: "turn_end", isError: false });
    shadow.tick();
    const snap = shadow.snapshot();
    expect(snap.categories.receipt).toMatchObject({ matched: 1, mismatched: 0 });
    expect(snap.categories.turn_end).toMatchObject({ matched: 1, mismatched: 0 });
    expect(snap.categories.session.mismatched).toBe(0);
    expect(snap.categories.session.matched).toBeGreaterThanOrEqual(3);
    // 판정 쪽 사건 모양은 비교가 없을 때와 같다(비교는 사건을 더하거나 바꾸지 않는다).
    expect(events.map(e => e.type).filter(type => !["status", "input_ready", "context_usage"].includes(type))).toEqual(["pane", "session", "turn_end"]);
    await runner.shutdown();
    expect(existsSync(join(eventsDir, HOOK_COMPARE_FILE))).toBe(true);
  });
});
