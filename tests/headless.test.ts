import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderRole } from "../server/roles.ts";
import { buildClaudeArgs, childEnv, claudeInput, HeadlessRunner, isMissingSessionError, StreamParser } from "../server/runner/headless.ts";
import { contextPct, parseTranscriptTail, readTranscriptTail, transcriptPath } from "../server/runner/transcript.ts";
import type { RunnerEvent, RunnerMember, StartOpts } from "../server/runner/types.ts";

const FAKE = resolve(import.meta.dir, "fixtures", "fake-claude.ts");
const opened: HeadlessRunner[] = [];
let seq = 0;

afterAll(async () => {
  await Promise.all(opened.map((r) => r.shutdown()));
});

function setup(timings = {}, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-headless-"));
  const logPath = join(dir, "calls.jsonl");
  const sessions = join(dir, "sessions");
  const runner = new HeadlessRunner(
    { claudeBin: FAKE },
    {
      timings,
      env: { ...process.env, FAKE_CLAUDE_LOG: logPath, FAKE_CLAUDE_SESSIONS: sessions, HERDR_SOCKET_PATH: "/live", HERDR_PANE_ID: "p1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SSE_PORT: "1", CLAUDE_CODE_SESSION_ID: "outer", CLAUDE_PID: "1", ...extraEnv },
    },
  );
  opened.push(runner);
  const events: RunnerEvent[] = [];
  const waiters: (() => void)[] = [];
  runner.on((e) => {
    events.push(e);
    for (const w of waiters.splice(0)) w();
  });
  const until = async (pred: (es: RunnerEvent[]) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!pred(events)) {
      if (Date.now() > end) throw new Error(`시간 초과: ${JSON.stringify(events.map((e) => e.type))}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  const member = (over: Partial<RunnerMember> = {}): RunnerMember => ({
    effort: null,
    subagentModel: null,
    id: `m_${++seq}`,
    projectId: "p",
    handle: "w",
    name: "직원 하나",
    cwd: dir,
    sessionId: null,
    paneId: null,
    model: null,
    permissionMode: "auto",
    kind: "worker",
    ...over,
  });
  const opts: StartOpts = { systemPromptFile: join(dir, "rules.md"), mcpConfigFile: join(dir, "mcp.json"), resume: false, projectName: "시험" };
  const calls = () =>
    existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>).filter((c) => c.event === "start")
      : [];
  const count = (type: RunnerEvent["type"]) => events.filter((e) => e.type === type).length;
  const turnEnds = (id: string) => events.filter((e): e is Extract<RunnerEvent, { type: "turn_end" }> => e.type === "turn_end" && e.memberId === id);
  return { dir, runner, events, until, member, opts, calls, count, turnEnds, sessions };
}

describe("HeadlessRunner", () => {
  test("첫 턴은 --session-id, 다음부터 --resume. 인자·stdin·환경이 계약대로다", async () => {
    const t = setup();
    const m0 = t.member({ model: "haiku" });
    const { sessionId } = await t.runner.start(m0, t.opts);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const m = { ...m0, sessionId };
    expect(await t.runner.send(m, "첫 글", t.opts)).toEqual({ ok: true });
    expect(t.runner.isBusy(m.id)).toBe(true);
    await t.until(() => t.turnEnds(m.id).length === 1);
    expect(t.runner.isBusy(m.id)).toBe(false);
    expect(await t.runner.send(m, "둘째 글", { ...t.opts, resume: true })).toEqual({ ok: true });
    await t.until(() => t.turnEnds(m.id).length === 2);

    const [first, second] = t.calls();
    expect(first!.sessionFlag).toBe(sessionId);
    expect(first!.resumeFlag).toBeNull();
    expect(second!.resumeFlag).toBe(sessionId);
    expect(second!.sessionFlag).toBeNull();
    expect(first!.args).toEqual([
      "-p",
      "--session-id", sessionId,
      "--mcp-config", t.opts.mcpConfigFile,
      "--append-system-prompt-file", t.opts.systemPromptFile,
      "--permission-mode", "auto",
      "--permission-prompts", "none",
      "--allowedTools", "mcp__iamceo",
      "--output-format", "stream-json", "--verbose",
      "--model", "haiku",
      "-n", "직원 하나",
    ]);
    // 글은 인자가 아니라 stdin 으로 간다. ps 로 보이지 않고 길이 제한도 없다.
    expect(first!.prompt).toBe("첫 글");
    expect(first!.stdinClosed).toBe(true);
    expect(first!.stdinMs).toBeLessThan(800);
    expect(first!.env.filter((k: string) => /^(HERDR_|CLAUDECODE$|CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|SESSION_ID|CHILD_SESSION)$|CLAUDE_PID$)/.test(k))).toEqual([]);
    expect(first!.cwd.endsWith(t.dir.split("/").pop()!)).toBe(true);
    const end = t.turnEnds(m.id)[0]!;
    expect(end.isError).toBe(false);
    expect(end.finalText).toContain("한글확인");
  });

  test("다시 시작한 서버처럼 메모리에 없으면 resume 값을 따른다", async () => {
    const t = setup();
    const m = t.member({ sessionId: crypto.randomUUID() });
    mkdirSync(t.sessions, { recursive: true });
    writeFileSync(join(t.sessions, `${m.sessionId}.txt`), "");
    await t.runner.start(m, { ...t.opts, resume: true });
    await t.runner.send(m, "이어서", { ...t.opts, resume: true });
    await t.until(() => t.turnEnds(m.id).length === 1);
    expect(t.calls()[0]!.resumeFlag).toBe(m.sessionId);
    expect(t.turnEnds(m.id)[0]!.isError).toBe(false);
  });

  test("없는 세션 resume 은 오류 턴으로 끝나고 판별할 수 있다", async () => {
    const t = setup();
    const m = t.member({ sessionId: crypto.randomUUID() });
    await t.runner.send(m, "이어서", { ...t.opts, resume: true });
    await t.until(() => t.turnEnds(m.id).length === 1);
    const end = t.turnEnds(m.id)[0]!;
    expect(end.isError).toBe(true);
    expect(isMissingSessionError(end.errorText)).toBe(true);
  });

  test("이미 있는 세션에 --session-id 면 --resume 으로 한 번 다시 시도한다", async () => {
    const t = setup();
    const m = t.member({ sessionId: crypto.randomUUID() });
    mkdirSync(t.sessions, { recursive: true });
    writeFileSync(join(t.sessions, `${m.sessionId}.txt`), "");
    await t.runner.start(m, t.opts);
    await t.runner.send(m, "글", t.opts);
    await t.until(() => t.turnEnds(m.id).length === 1);
    expect(t.turnEnds(m.id)[0]!.isError).toBe(false);
    const calls = t.calls();
    expect(calls.map((c) => [!!c.sessionFlag, !!c.resumeFlag])).toEqual([[true, false], [false, true]]);
  });

  test("문맥 %는 주 세션 usage / 주 모델 창. 서브에이전트 글·usage 는 섞이지 않는다", async () => {
    const t = setup();
    const m = t.member();
    await t.runner.send(m, "@fake:usage=50000 @fake:window=100000 @fake:noise @fake:text=주세션글", t.opts);
    await t.until(() => t.turnEnds(m.id).length === 1);
    const pct = t.events.filter((e) => e.type === "context").map((e) => (e as { pct: number }).pct);
    expect(pct.at(-1)).toBe(50);
    expect(t.turnEnds(m.id)[0]!.finalText).toBe("주세션글");
    expect(t.events.some((e) => e.type === "activity" && e.text.includes("서브에이전트 글"))).toBe(false);
  });

  test("한 번 안 창 크기는 다음 턴 진행 중 계산에 쓴다", async () => {
    const t = setup();
    const m = t.member();
    const sid = (await t.runner.start(m, t.opts)).sessionId;
    await t.runner.send({ ...m, sessionId: sid }, "@fake:window=100000", t.opts);
    await t.until(() => t.turnEnds(m.id).length === 1);
    const before = t.count("context");
    await t.runner.send({ ...m, sessionId: sid }, "@fake:usage=30000 @fake:window=100000", t.opts);
    await t.until(() => t.turnEnds(m.id).length === 2);
    expect(t.count("context") - before).toBeGreaterThanOrEqual(2);
  });

  test("Agent 도구 시작·끝으로 서브에이전트 수를 센다", async () => {
    const t = setup();
    const m = t.member();
    await t.runner.send(m, "@fake:agent=20", t.opts);
    await t.until(() => t.turnEnds(m.id).length === 1);
    expect(t.events.filter((e) => e.type === "subagents").map((e) => (e as { count: number }).count)).toEqual([1, 0]);
    expect(t.events.some((e) => e.type === "activity" && e.kind === "tool" && e.text.startsWith("Agent"))).toBe(true);
    expect(t.events.some((e) => e.type === "activity" && e.kind === "tool_result" && e.text === "조사 끝")).toBe(true);
  });

  test("오류 result·결과 없는 종료 모두 오류 turn_end", async () => {
    const t = setup();
    const a = t.member();
    await t.runner.send(a, "@fake:error=한도초과", t.opts);
    await t.until(() => t.turnEnds(a.id).length === 1);
    expect(t.turnEnds(a.id)[0]).toMatchObject({ isError: true, errorText: "한도초과" });
    const b = t.member();
    await t.runner.send(b, "@fake:crash=터짐", t.opts);
    await t.until(() => t.turnEnds(b.id).length === 1);
    expect(t.turnEnds(b.id)[0]!.isError).toBe(true);
    expect(t.turnEnds(b.id)[0]!.errorText).toContain("터짐");
  });

  test("실행 파일이 없으면 down, 폴더가 없으면 error", async () => {
    const t = setup();
    const missing = new HeadlessRunner({ claudeBin: join(t.dir, "없는파일") });
    opened.push(missing);
    expect((await missing.available()).ok).toBe(false);
    expect(await t.runner.available()).toEqual({ ok: true });
    const r = await missing.send(t.member(), "글", t.opts);
    expect(r).toMatchObject({ ok: false, reason: "down", retryable: true });
    const g = await t.runner.send(t.member({ cwd: join(t.dir, "없는폴더") }), "글", t.opts);
    expect(g).toMatchObject({ ok: false, reason: "error", retryable: false });
  });

  test("일하는 중이면 busy", async () => {
    const t = setup();
    const m = t.member();
    await t.runner.send(m, "@fake:delay=300", t.opts);
    expect(await t.runner.send(m, "또", t.opts)).toMatchObject({ ok: false, reason: "busy", retryable: true });
    await t.until(() => t.turnEnds(m.id).length === 1);
    expect(t.calls().length).toBe(1);
  });

  test("interrupt: SIGINT 로 끝나고 오류가 아니다", async () => {
    const t = setup();
    const m = t.member();
    await t.runner.send(m, "@fake:hang", t.opts);
    await t.until(() => t.events.some((e) => e.type === "activity" && e.kind === "text"));
    await t.runner.interrupt(m);
    await t.until(() => t.turnEnds(m.id).length === 1, 3000);
    expect(t.turnEnds(m.id)[0]).toMatchObject({ isError: false, finalText: "" });
  });

  test("SIGINT 를 무시하면 SIGTERM 으로 넘어간다", async () => {
    const t = setup({ interruptToTermMs: 100 });
    const m = t.member();
    await t.runner.send(m, "@fake:hang @fake:ignore-sigint", t.opts);
    await t.until(() => t.events.some((e) => e.type === "activity" && e.kind === "text"));
    await t.runner.stop(m);
    expect(t.runner.isBusy(m.id)).toBe(false);
    expect(t.turnEnds(m.id).length).toBe(1);
  });

  test("result 뒤 매달린 프로세스는 끝내고 turn_end 는 한 번", async () => {
    const t = setup({ afterResultMs: 100 });
    const m = t.member();
    await t.runner.send(m, "@fake:linger", t.opts);
    await t.until(() => t.turnEnds(m.id).length === 1, 3000);
    expect(t.turnEnds(m.id)[0]!.isError).toBe(false);
    await Bun.sleep(100);
    expect(t.turnEnds(m.id).length).toBe(1);
  });

  test("compact: 프로세스가 끝난 뒤 compacted 만 낸다", async () => {
    const t = setup();
    const m = t.member();
    expect(await t.runner.compact(m, "이어갈 일: 시험", t.opts)).toEqual({ ok: true });
    expect(t.runner.isBusy(m.id)).toBe(true);
    await t.until(() => t.count("compacted") === 1);
    expect(t.runner.isBusy(m.id)).toBe(false);
    expect(t.turnEnds(m.id).length).toBe(0);
    expect(t.calls()[0]!.prompt).toBe("/compact 이어갈 일: 시험");
    expect(t.count("context")).toBe(0);
  });

  test("일반 턴 안의 자동 압축도 알린다", () => {
    const events: RunnerEvent[] = [];
    let boundary = 0;
    const p = new StreamParser("m", (e) => events.push(e), { reportContext: true, contextWindow: null, onCompactBoundary: () => boundary++ });
    p.feed(JSON.stringify({ type: "system", subtype: "compact_boundary" }));
    expect(boundary).toBe(1);
    expect(p.sawCompactBoundary).toBe(true);
  });

  test("setParallel: 끝날 때까지 기다리고 turn_end 를 내지 않는다", async () => {
    const t = setup();
    const m = t.member();
    expect(await t.runner.setParallel(m, true, t.opts)).toEqual({ ok: true });
    expect(t.runner.isBusy(m.id)).toBe(false);
    expect(t.calls()[0]!.prompt).toBe("/effort ultracode on");
    expect(t.turnEnds(m.id).length).toBe(0);
    await t.runner.setParallel(m, false, t.opts);
    expect(t.calls()[1]!.prompt).toBe("/effort ultracode off");
    expect(t.calls()[1]!.resumeFlag).toBeTruthy();
  });

  test("shutdown: 자식을 끝내고 더는 이벤트를 내지 않는다", async () => {
    const t = setup();
    const m = t.member();
    await t.runner.send(m, "@fake:hang", t.opts);
    await t.until(() => t.events.some((e) => e.type === "activity" && e.kind === "text"));
    const started = Date.now();
    await t.runner.shutdown();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(t.turnEnds(m.id).length).toBe(0);
    expect(await t.runner.send(m, "글", t.opts)).toMatchObject({ ok: false, reason: "down" });
  });

  test("screen 은 빈 글", async () => {
    expect(await setup().runner.screen()).toBe("");
  });
});

describe("도움 함수", () => {
  test("childEnv 는 HERDR_*·CLAUDE 진입 변수만 지운다", () => {
    expect(childEnv({ HERDR_X: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "a", CLAUDE_CODE_SSE_PORT: "2", PATH: "/bin", IAMCEO_HOME: "/h", CLAUDE_CONFIG_DIR: "/c" })).toEqual({ PATH: "/bin", IAMCEO_HOME: "/h", CLAUDE_CONFIG_DIR: "/c" });
  });

  test("buildClaudeArgs: 널 문자를 뺀다(있으면 Bun.spawn 이 예외를 던져 대기열이 멈춘다). 글은 인자에 넣지 않는다", () => {
    const m = { id: "m", projectId: "p", handle: "h", name: "이\0름", cwd: "/", sessionId: "s", paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "auto", kind: "worker" } as const;
    const args = buildClaudeArgs(m, { systemPromptFile: "r", mcpConfigFile: "c", resume: true, projectName: "p" }, true);
    expect(args.some((a) => a.includes("\0"))).toBe(false);
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("--resume");
    expect(args).toContain("이름");
    expect(claudeInput("가\0나\t다\x1b[201~\x7f")).toBe("가나\t다[201~");
  });

  test("긴 글(ARG_MAX 넘김)도 stdin 으로 끝까지 가고 인자에는 글이 없다. 제어문자는 지워지고 직원 폴더를 연다", async () => {
    const t = setup();
    const inboxDir = join(t.dir, "inbox");
    const runner = new HeadlessRunner({ claudeBin: (t.runner as unknown as { config: { claudeBin: string } }).config.claudeBin, inboxDir }, { env: (t.runner as unknown as { env: Record<string, string> }).env });
    runner.on((e) => t.events.push(e));
    const m0 = t.member();
    const { sessionId } = await runner.start(m0, t.opts);
    const m = { ...m0, sessionId };
    const long = "비밀번호는 FAKE-SECRET 입니다. ".concat("가".repeat(1_200_000));
    expect(await runner.send(m, `${long}\x1b[201~\u202e`, t.opts)).toEqual({ ok: true });
    await t.until(() => t.turnEnds(m.id).length === 1, 15_000);
    const call = t.calls().at(-1)!;
    expect(call.prompt).toBe(`${long}[201~`);
    expect((call.args as string[]).join(" ")).not.toContain("FAKE-SECRET");
    const args = call.args as string[];
    expect(args[args.indexOf("--add-dir") + 1]).toBe(join(inboxDir, m.id));
    expect(existsSync(join(inboxDir, m.id))).toBe(true);
    await runner.shutdown();
  }, 30_000);

  test("buildClaudeArgs: 모델이 없으면 뺀다", () => {
    const m: RunnerMember = { id: "m", projectId: "p", handle: "h", name: "n", cwd: "/", sessionId: "s", paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker" };
    const args = buildClaudeArgs(m, { systemPromptFile: "r", mcpConfigFile: "c", resume: true, projectName: "p" }, true);
    expect(args).not.toContain("--model");
    expect(args.slice(1, 3)).toEqual(["--resume", "s"]);
  });

  test("StreamParser 는 망가진 줄과 모르는 종류를 지나친다", () => {
    const events: RunnerEvent[] = [];
    const p = new StreamParser("m", (e) => events.push(e), { reportContext: true, contextWindow: null });
    for (const line of ["", "not json", "[]", "null", "1", '{"type":"system","subtype":"hook_started"}', '{"type":"assistant"}', '{"type":"assistant","message":{"content":"x"}}', '{"type":"user","message":{"content":"x"}}', '{"type":"zzz"}']) {
      p.feed(line);
    }
    expect(events).toEqual([]);
    expect(p.result).toBeNull();
  });

  test("result 만 있어도 오류 글을 고른다", () => {
    const p = new StreamParser("m", () => {}, { reportContext: false, contextWindow: null });
    p.feed(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false }));
    expect(p.result).toEqual({ finalText: "", isError: true, errorText: "error_max_turns" });
  });

  test("transcript: 마지막 입력 뒤 같은 응답의 글을 잇고, usage·사이드체인을 가른다", () => {
    const lines = [
      '{"type":"assistant","message":{"id":"old","content":[{"type":"text","text":"지난 턴"}],"usage":{"input_tokens":1}}}',
      '{"type":"user","message":{"content":"새 입력"}}',
      '{"type":"assistant","isSidechain":true,"message":{"id":"s","content":[{"type":"text","text":"곁가지"}],"usage":{"input_tokens":999}}}',
      '{"type":"assistant","message":{"id":"a","model":"m1","content":[{"type":"text","text":"첫 응답"}],"usage":{"input_tokens":5}}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}',
      '{"type":"assistant","message":{"id":"b","model":"m2","content":[{"type":"text","text":"가"}],"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30}}}',
      '{"type":"assistant","message":{"id":"b","model":"m2","content":[{"type":"text","text":"나"},{"type":"tool_use","name":"x"}],"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30}}}',
      "잘린 줄",
      '{"type":"system","subtype":"turn_duration"}',
    ];
    expect(parseTranscriptTail(lines.join("\n"))).toEqual({ finalText: "가\n나", contextTokens: 60, model: "m2" });
    expect(parseTranscriptTail(lines.slice(0, 2).join("\n")).finalText).toBe("");
  });

  test("transcript 파일: 없으면 null, 꼬리만 읽어 잘린 첫 줄을 버린다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-transcript-"));
    expect(transcriptPath("/Users/a.b/c_d", "sid", dir)).toBe(join(dir, "projects", "-Users-a-b-c-d", "sid.jsonl"));
    expect(readTranscriptTail(join(dir, "없음.jsonl"))).toBeNull();
    const file = join(dir, "s.jsonl");
    const last = '{"type":"assistant","message":{"id":"z","content":[{"type":"text","text":"끝"}],"usage":{"input_tokens":7}}}';
    writeFileSync(file, `${"x".repeat(5000)}\n${last}\n`);
    expect(readTranscriptTail(file, last.length + 500)).toEqual({ finalText: "끝", contextTokens: 7, model: null });
    expect(contextPct(50_000)).toBe(25);
    expect(contextPct(500_000)).toBe(100);
  });

  test("renderRole: 치환, 사용자 템플릿 우선, 값 안의 자리표시는 그대로", () => {
    const vars = { PROJECT: "{{NAME}}", NAME: "철수", ROLE: "개발", CONDUCTOR: "총괄" };
    const text = renderRole("worker", vars);
    expect(text).toContain("철수");
    expect(text).toContain("{{NAME}}");
    expect(text).not.toContain("{{ROLE}}");
    const dir = mkdtempSync(join(tmpdir(), "iamceo-roles-"));
    writeFileSync(join(dir, "worker.md"), "맞춤 {{NAME}}/{{ROLE}}");
    expect(renderRole("worker", vars, dir)).toBe("맞춤 철수/개발");
    expect(renderRole("root", vars, dir)).not.toContain("맞춤");
  });
});
