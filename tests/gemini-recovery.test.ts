// Gemini(Antigravity CLI) 팀장의 한도·장애 자동 이어가기와 압축의 바탕: 오류 글 갈래(gemini-errors.ts), /usage 읽기(gemini-quota.ts),
// 대화 기록 읽기(gemini-transcript.ts), 압축 경계(core-context.ts 의 gemini 갈래).
// 견본(tests/fixtures/agy-headless/1.5.14)은 실제 agy 1.5.14 헤드리스 실행의 출력이다: usage.json·usage-offline.json 은 `agy -p /usage --output-format json`
// 의 표준 출력 그대로(메일 없음), transcript-compact.jsonl 은 시험 대화의 transcript.jsonl 에서 글 본문만 줄인 것(줄 종류·칸·토큰 수는 그대로).
// 실제 agy 는 띄우지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyGeminiTurnError, cleanGeminiError, GEMINI_PROBE_URL, geminiReportedText, geminiTransientLimit, geminiTurnErrorText } from "../server/gemini-errors.ts";
import { GeminiQuotaReader, geminiExhaustedResetAt, geminiGroupAvailable, geminiGroupExhausted, geminiModelKey, geminiStatusExhausted, geminiStatusResetAt, geminiUsageGroup, parseAgyUsage, type AgyUsageRun } from "../server/gemini-quota.ts";
import { GEMINI_CHECKPOINT_HEAD, geminiHasModelResponse, geminiPromptTokens, geminiTranscriptPath, geminiTranscriptRoot, isGeminiCheckpoint } from "../server/runner/gemini-transcript.ts";
import { observeCompactBoundary, type CompactBoundaryBaseline } from "../server/runner/core-context.ts";
import { classifyTurnError } from "../server/api-outage.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "agy-headless", "1.5.14");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-grec-"))); dirs.push(dir); return dir; };

describe("classifyGeminiTurnError: agy 오류 글의 갈래", () => {
  test("실측 장애 글(재시도를 다 쓰고 끝난 턴, 죽은 프록시)은 장애다", () => {
    for (const text of [
      "There was a network issue connecting to the server, please try again.",
      'generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": unexpected EOF',
      'There was a network issue connecting to the server, please try again. · generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": unexpected EOF',
      '/usage failed: retrieving quota summary: failed to retrieve user quota summary: failed to get load code assist response: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused',
      "The model API is currently overloaded and may experience intermittent errors.",
      "Model unavailable (attempt 2/10), retrying in 12s",
      "Error 503: UNAVAILABLE",
      "MODEL_CAPACITY_EXHAUSTED: no capacity available for this model",
    ]) expect(classifyGeminiTurnError(text)).toBe("network");
  });
  test("계정 한도 글(실행 파일의 문구, agy 자기 규칙 QUOTA_RE)은 사용 한도다", () => {
    for (const text of ["You have exhausted your quota on this model.", "Your AI credits balance is too low to continue.", "RESOURCE_EXHAUSTED", "Error 429: rate limit exceeded",
      "individual quota reached", "You have exhausted your capacity on this model", "spend cap reached for this billing account"]) expect(classifyGeminiTurnError(text)).toBe("usage_limit");
  });
  test("로그인 글은 인증, 4xx 가 붙은 request failed·모르는 글은 그 밖(일반 오류)이다", () => {
    for (const text of ["Verification required. Please complete verification in your browser to continue.", "Sign in required", "UNAUTHENTICATED: request had invalid credentials", "oauth2: invalid_grant"]) expect(classifyGeminiTurnError(text)).toBe("auth");
    expect(classifyGeminiTurnError("request failed: 400 Bad Request: invalid argument")).toBe("error");
    expect(classifyGeminiTurnError("CLI reported an error")).toBe("error");
    expect(classifyGeminiTurnError("")).toBe("error");
  });
  test("429·rate limit·RESOURCE_EXHAUSTED 만 말하는 글은 잠깐의 용량 제한일 수 있다(할당량을 말하면 아니다)", () => {
    expect(geminiTransientLimit("RESOURCE_EXHAUSTED: Error 429 rate limit")).toBe(true);
    expect(geminiTransientLimit("You have exhausted your quota on this model.")).toBe(false);
    expect(geminiTransientLimit("Your AI credits balance is too low to continue.")).toBe(false);
    expect(geminiTransientLimit("unexpected EOF")).toBe(false);
  });
  test("Claude·Codex 의 갈래 규칙(classifyTurnError)은 그대로다", () => {
    expect(classifyTurnError("connection error: fetch failed (ECONNRESET)")).toBe("network");
    expect(classifyTurnError("You've hit your weekly limit")).toBe("usage_limit");
    expect(classifyTurnError("There was a network issue connecting to the server, please try again.")).toBe("error");
  });
  test("장애 탐침 주소는 agy 가 닿는 곳이다(실측 프록시 기록)", () => {
    expect(GEMINI_PROBE_URL).toBe("https://daily-cloudcode-pa.googleapis.com");
  });
});

describe("오류 글 다듬기·합치기", () => {
  test("OSC 보고 글이 base64 면 풀고, 아니면 그대로 쓴다", () => {
    const network = "There was a network issue connecting to the server, please try again.";
    expect(geminiReportedText(Buffer.from(network).toString("base64"))).toBe(network);
    expect(geminiReportedText(network)).toBe(network);
    expect(geminiReportedText("Done")).toBe("Done");
    expect(geminiReportedText("  ")).toBeNull();
    expect(geminiReportedText(undefined)).toBeNull();
  });
  test("OSC 글과 Stop 오류 글을 ' · ' 로 잇고, 같거나 품은 글은 한 번만 쓴다. 메일은 <email>, 제어 문자는 칸", () => {
    expect(geminiTurnErrorText({ oscMsg: "A failed", stopError: "unexpected EOF" })).toBe("A failed · unexpected EOF");
    expect(geminiTurnErrorText({ oscMsg: "RESOURCE_EXHAUSTED", stopError: "RESOURCE_EXHAUSTED" })).toBe("RESOURCE_EXHAUSTED");
    expect(geminiTurnErrorText({ oscMsg: "quota", stopError: "quota exhausted" })).toBe("quota exhausted");
    expect(geminiTurnErrorText({ oscMsg: null, stopError: "for dev@example.com\nnow" })).toBe("for <email> now");
    expect(geminiTurnErrorText({})).toBe("CLI reported an error");
    expect(cleanGeminiError("x".repeat(700)).length).toBe(600);
  });
});

describe("/usage 읽기", () => {
  test("실측 응답: 묶음마다 모델 표시 이름·칸(남은 비율·초기화 시각)", () => {
    const usage = parseAgyUsage(fixture("usage.json"), new Date("2026-11-22T08:00:00Z"))!;
    expect(usage.at).toBe("2026-11-22T08:00:00.000Z");
    expect(usage.groups.map(g => g.name)).toEqual(["Gemini Models", "Claude and GPT models", "Gemini 4 Argon"]);
    expect(usage.groups[0]!.models).toEqual(["Gemini 4 Neon", "Gemini 4 Hydrogen", "Orchestrator (Neon)", "Gemini 3.8 Flash"]);
    expect(usage.groups[1]!.models).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B"]);
    // 모델 목록 글이 없는 묶음은 묶음 이름이 곧 모델 이름이다.
    expect(usage.groups[2]!.models).toEqual(["Gemini 4 Argon"]);
    expect(usage.groups[0]!.buckets).toEqual([
      { id: "gemini-weekly", window: "weekly", remainingFraction: 0.9925086498260498, resetAt: "2026-11-28T09:10:29.000Z" },
      { id: "gemini-5h", window: "5h", remainingFraction: 0.9894714951515198, resetAt: "2026-11-22T12:48:36.000Z" },
    ]);
    expect(usage.groups.every(geminiGroupAvailable)).toBe(true);
    expect(usage.groups.some(geminiGroupExhausted)).toBe(false);
  });
  test("연결이 없을 때의 응답(status ERROR)·JSON 이 아닌 글·다른 명령의 답은 null", () => {
    expect(parseAgyUsage(fixture("usage-offline.json"))).toBeNull();
    expect(parseAgyUsage("Gemini Models\tWeekly Limit Remaining\t99%")).toBeNull();
    expect(parseAgyUsage(JSON.stringify({ status: "SUCCESS", command: { name: "credits", data: { remaining_credits: 0 } } }))).toBeNull();
  });
  test("모델 → 묶음: 표시 이름·effort 꼬리를 뗀 이름으로 견주고, 앞의 이름부터 찾는다", () => {
    const usage = parseAgyUsage(fixture("usage.json"))!;
    expect(geminiUsageGroup(usage, ["Gemini 3.8 Flash"])?.name).toBe("Gemini Models");
    expect(geminiUsageGroup(usage, ["Gemini 4 Argon (Medium)"])?.name).toBe("Gemini 4 Argon");
    expect(geminiUsageGroup(usage, ["nope", "claude opus 5.5"])?.name).toBe("Claude and GPT models");
    expect(geminiUsageGroup(usage, ["Claude Opus 5.5", "Gemini 3.8 Flash"])?.name).toBe("Claude and GPT models");
    expect(geminiUsageGroup(usage, ["gemini-3.8-flash"])).toBeNull();
    expect(geminiUsageGroup(null, ["Gemini 3.8 Flash"])).toBeNull();
    expect(geminiModelKey("  Gemini  4 Neon (High) ")).toBe("gemini 4 neon");
  });
  test("다 쓴 칸들의 가장 늦은 초기화 시각(주간·5시간이 함께 바닥이면 늦은 쪽). 상태줄 기록의 묶음도 같은 규칙이다", () => {
    const buckets = [{ remainingFraction: 0, resetAt: "2026-11-22T12:48:36.000Z" }, { remainingFraction: 0, resetAt: "2026-11-28T09:10:29.000Z" }, { remainingFraction: 0.5, resetAt: "2026-12-01T00:00:00.000Z" }];
    expect(geminiExhaustedResetAt(buckets)).toBe("2026-11-28T09:10:29.000Z");
    expect(geminiExhaustedResetAt(buckets.slice(2))).toBeNull();
    const record = { quota: { "gemini-5h": { remainingFraction: 0, resetAt: "2026-11-22T12:48:36.000Z", disabled: false }, "3p-weekly": { remainingFraction: 1, resetAt: "2026-11-29T00:00:00.000Z", disabled: false } } };
    expect(geminiStatusResetAt(record)).toBe("2026-11-22T12:48:36.000Z");
    expect(geminiStatusExhausted(record)).toBe(true);
    expect(geminiStatusExhausted({ quota: { "gemini-5h": { remainingFraction: 0.4, resetAt: null, disabled: false } } })).toBe(false);
    expect(geminiStatusExhausted({ quota: {} })).toBeNull();
    expect(geminiStatusResetAt(null)).toBeNull();
  });
  test("GeminiQuotaReader: `agy -p /usage --output-format json` 을 빈 폴더에서 띄우고, 60초 안에는 다시 띄우지 않으며, 한 번에 하나만 돈다. 실패는 예전 답을 지우지 않는다", async () => {
    const home = temp(), bin = join(home, "agy"), cwd = join(home, "run", "gemini-usage");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    let now = 1_000_000;
    const calls: { bin: string; cwd: string }[] = [];
    let reply: AgyUsageRun = { exitCode: 0, stdout: fixture("usage.json") };
    let gate: Promise<void> = Promise.resolve();
    const reader = new GeminiQuotaReader({ bin, cwd, now: () => now, spawn: async (b, c) => { calls.push({ bin: b, cwd: c }); await gate; return reply; } });
    expect(reader.latest()).toBeNull();
    let open!: () => void;
    gate = new Promise(resolve => { open = resolve; });
    const [a, b] = [reader.read(), reader.read()];
    open();
    expect((await a)?.groups).toHaveLength(3);
    expect(await b).toBe(await a);
    expect(calls).toEqual([{ bin, cwd }]);
    expect(statSync(cwd).isDirectory()).toBe(true);
    now += 30_000;
    await reader.read();
    expect(calls).toHaveLength(1);
    now += 31_000;
    reply = { exitCode: 1, stdout: fixture("usage-offline.json") };
    expect(await reader.read()).toBeNull();
    expect(calls).toHaveLength(2);
    expect(reader.latest()?.groups).toHaveLength(3);
    reply = { exitCode: null, stdout: "" };
    expect(await reader.read(true)).toBeNull();
    now += 31 * 60_000;
    expect(reader.latest()).toBeNull();
    // 실행 파일이 없으면 띄우지 않는다.
    const missing = new GeminiQuotaReader({ bin: join(home, "nope"), cwd, spawn: async () => { throw new Error("띄우면 안 된다"); } });
    expect(await missing.read()).toBeNull();
    reader.stop();
    expect(await reader.read(true)).toBeNull();
  });
});

describe("대화 기록(transcript.jsonl)", () => {
  const CONV = "00984ad8-9b0b-4874-91d2-e2ddb32c8e79";
  function place(home: string, text: string, conversation = CONV): string {
    const path = geminiTranscriptPath(home, conversation)!;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    return path;
  }
  test("경로는 <홈>/brain/<대화 id>/.system_generated/logs/transcript.jsonl, 대화 id 모양이 다르면 null", () => {
    expect(geminiTranscriptPath("/h", CONV)).toBe(`/h/brain/${CONV}/.system_generated/logs/transcript.jsonl`);
    expect(geminiTranscriptRoot("/h")).toBe("/h/brain");
    expect(geminiTranscriptPath("/h", "../x")).toBeNull();
    expect(geminiTranscriptPath("/h", null)).toBeNull();
  });
  test("CHECKPOINT 줄(SYSTEM·DONE·머리말)만 압축 경계다", () => {
    const lines = fixture("transcript-compact.jsonl").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter(isGeminiCheckpoint).map(entry => entry.step_index)).toEqual([7, 13, 23, 26]);
    expect(isGeminiCheckpoint({ type: "CHECKPOINT", source: "SYSTEM", status: "RUNNING", content: GEMINI_CHECKPOINT_HEAD })).toBe(false);
    expect(isGeminiCheckpoint({ type: "CHECKPOINT", source: "SYSTEM", status: "DONE", content: "# Something else" })).toBe(false);
    expect(isGeminiCheckpoint(null)).toBe(false);
  });
  test("마지막 모델 호출의 프롬프트 크기(input + cache_read). 압축 뒤 아직 모델을 부르지 않았으면 null", () => {
    const home = temp();
    const text = fixture("transcript-compact.jsonl");
    const lines = text.trim().split("\n");
    // 둘째 압축 뒤의 답(step 14): 10,219 + 0.
    place(home, `${lines.slice(0, 15).join("\n")}\n`);
    expect(geminiPromptTokens(home, CONV)).toEqual({ tokens: 10_219, model: "gemini-3.8-flash-low", at: "2026-11-22T07:50:26Z" });
    // 끝이 압축(step 26)이면 압축 뒤 크기를 아직 모른다.
    place(home, text);
    expect(geminiPromptTokens(home, CONV)).toBeNull();
    // 반쯤 쓴 끝 줄은 버린다.
    place(home, `${lines.slice(0, 18).join("\n")}\n{"step_index": 18, "source": "MODEL", "input_tok`);
    expect(geminiPromptTokens(home, CONV)?.tokens).toBe(2257 + 8175);
    expect(geminiHasModelResponse(home, CONV)).toBe(true);
    place(home, `${lines[0]}\n`);
    expect(geminiHasModelResponse(home, CONV)).toBe(false);
    expect(geminiPromptTokens(home, "missing-conv")).toBeNull();
    expect(geminiHasModelResponse(home, "missing-conv")).toBeNull();
  });
  test("압축 경계(observeCompactBoundary, gemini): 기준선 뒤 CHECKPOINT 와 쉬는 CLI 면 끝. 기준선 앞·다른 대화·세션 바뀜은 아니다", () => {
    const home = temp();
    const lines = fixture("transcript-compact.jsonl").trim().split("\n");
    const before = `${lines.slice(0, 5).join("\n")}\n`;
    const path = place(home, before);
    const stat = statSync(path);
    const identity = { sessionId: CONV, generation: 1, terminalId: "t1", turn: 2, model: null };
    const baseline: CompactBoundaryBaseline = { ...identity, path, fileIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, offset: Buffer.byteLength(before) };
    const observe = (settled: boolean, extra: Partial<Parameters<typeof observeCompactBoundary>[0]> = {}) =>
      observeCompactBoundary({ cli: "gemini", home, cwd: "/work", baseline, current: { ...identity, turn: 3 }, settled, providerError: false, ...extra });
    expect(observe(true)).toMatchObject({ outcome: "pending", code: "awaiting_boundary" });
    // 맨 /compact 를 넣은 뒤 agy 가 쓴 세 줄(USER_INPUT·SYSTEM_MESSAGE·CHECKPOINT).
    appendFileSync(path, `${lines.slice(5, 8).join("\n")}\n`);
    expect(observe(false)).toMatchObject({ outcome: "pending", code: "awaiting_settled" });
    expect(observe(true)).toMatchObject({ outcome: "succeeded", code: "boundary_and_settled" });
    expect(observe(true, { providerError: true })).toMatchObject({ outcome: "unknown", code: "provider_error" });
    // 기준선을 압축 뒤로 옮기면(앞선 압축) 경계가 아니다.
    const later = { ...baseline, offset: statSync(path).size };
    expect(observeCompactBoundary({ cli: "gemini", home, cwd: "/work", baseline: later, current: { ...identity, turn: 3 }, settled: true, providerError: false })).toMatchObject({ outcome: "pending" });
    // 세션이 바뀌었거나 기준선의 파일이 지금 대화의 것이 아니면 모른다.
    expect(observe(true, { current: { ...identity, sessionId: "other-conv", turn: 3 } })).toMatchObject({ outcome: "unknown", code: "session_changed" });
    const other = place(home, before, "other-conv");
    expect(observeCompactBoundary({ cli: "gemini", home, cwd: "/work", baseline: { ...baseline, path: other }, current: { ...identity, turn: 3 }, settled: true, providerError: false })).toMatchObject({ outcome: "unknown", code: "session_conflict" });
  });
});
