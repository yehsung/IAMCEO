// D9: 확인된 CLI 버전마다 실제 화면·기록 견본을 두고, 지금 해석기를 견본마다 돌린다.
// 새 CLI 버전을 확인하면 tests/fixtures/cli/<provider>/<version>/ 에 화면·기록과 manifest.json 을 넣고 VERIFIED_CLI_VERSIONS 에 더한다.
// 해석기를 고쳐 옛 버전 견본이 깨지면 그것이 곧 그 버전과의 약속 위반이다.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCliVersion, VERIFIED_CLI_VERSIONS } from "../server/cli-version.ts";
import { claudeQuietScreen, inputLooksEmpty } from "../server/runner/claude-screen.ts";
import { readClaudeTurn } from "../server/runner/claude-turn.ts";
import { parseTranscriptTail } from "../server/runner/transcript.ts";
import { claudeFolderTrust, codexFolderTrust, looksLikeFolderTrust } from "../server/runner/core-approval.ts";
import { codexBackgroundTerminals, codexDraft, trustDialogLike } from "../server/runner/core.ts";
import { readCodexTurnEnd } from "../server/runner/codex-turn.ts";
import { parseCodexSessionMeta, readDeliveryEvidence, readJsonlRange } from "../server/runner/delivery-evidence.ts";
import { observeCompactBoundary } from "../server/runner/core-context.ts";
import { geminiApprovalDialog, geminiDraft, geminiFolderTrust, geminiProgress, geminiRetry, geminiSetupBlocked, geminiTurnToStop } from "../server/runner/gemini-screen.ts";
import { geminiStatusFromPayload } from "../server/runner/gemini-status.ts";
import { GEMINI_HOOKS_NAME, geminiHookEventsDir, geminiHooksConfig, geminiTurnWatch, parseGeminiHookLine, readGeminiTurnStop } from "../server/runner/gemini-hooks.ts";
import { geminiHasModelResponse, geminiPromptTokens, geminiTranscriptPath, geminiTranscriptRoot } from "../server/runner/gemini-transcript.ts";
import { classifyGeminiTurnError, geminiReportedText, geminiTurnErrorText } from "../server/gemini-errors.ts";
import { geminiBucketFamily } from "../server/gemini-quota.ts";
import { HookFileReader } from "../server/runner/hook-events.ts";

type Provider = "claude" | "codex" | "gemini";
/** quiet: Claude 가 턴을 끝내고 입력을 받을 수 있는 화면인가(claudeQuietScreen, 아니면 null). */
interface ScreenExpect { inputEmpty?: boolean | null; draft?: string | null; folderTrustLike?: boolean; trustDialogLike?: boolean; folderTrust?: { selected: number; options: string[] } | null; backgroundTerminals?: number | null; quiet?: { label: string | null } | null }
/**
 * turnEnd: Codex 기록에서 표지가 든 사용자 글 뒤의 턴이 끝났는가(codex-turn.ts, 기준선 없이).
 * claudeTurn·claudeTurnError: Claude 기록의 처음(기준선 0)부터 표지가 든 받은 글 뒤의 턴이 닫혔는가와 그 오류(claude-turn.ts).
 * idleCompaction·tailTokens: 기록 꼬리가 쉬는 동안 압축으로 끝나는가와 그때의 문맥 토큰(transcript.ts).
 * compactOutcome: 기록 처음(기준선 0)부터 읽어 서버가 넣은 압축의 결과를 어떻게 보는가(core-context.ts observeCompactBoundary, CLI 는 쉬는 중).
 */
interface LogExpect { received: string[]; verdict?: string; code?: string; complete?: boolean; sessionMeta?: boolean; turnEnd?: string; claudeTurn?: string; claudeTurnError?: string | null; idleCompaction?: boolean; tailTokens?: number | null; compactOutcome?: string }
interface Fixture {
  /** observed: 실제 CLI 화면·기록을 옮김. synthetic: 실측 구조로 만든 화면(그것만으로는 버전을 확인했다고 하지 않는다). */
  file: string; kind: "screen" | "log" | "statusline" | "osc"; origin: "observed" | "synthetic"; cwd: string; bannerVersion?: boolean; note?: string;
  sessionId?: string; markers?: Record<string, string>; bundleMarker?: string; expect: ScreenExpect | LogExpect | Record<string, unknown>;
  /** Gemini 화면: 그 화면 때의 herdr-core terminal.get status(msg 는 풀린 글). 판독 함수에 그대로 넘긴다. */
  osc?: { state: string; kind?: string; msg?: string } | null;
}
interface Manifest { provider: Provider; version: string; source: string; fixtures: Fixture[] }

const ROOT = join(import.meta.dir, "fixtures", "cli");
const scratch = mkdtempSync(join(tmpdir(), "iamceo-cli-fixtures-"));
afterAll(() => { /* 임시 폴더는 게이트가 지운다 */ });

function folders(provider: Provider): string[] {
  const dir = join(ROOT, provider);
  return existsSync(dir) ? readdirSync(dir).filter(name => statSync(join(dir, name)).isDirectory()).sort() : [];
}
function manifest(provider: Provider, version: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, provider, version, "manifest.json"), "utf8")) as Manifest;
}
const all = (["claude", "codex", "gemini"] as const).flatMap(provider => folders(provider).map(version => ({ provider, version })));

describe("확인된 버전 목록과 견본 폴더", () => {
  test("VERIFIED_CLI_VERSIONS 와 견본 폴더가 정확히 같다(견본 없는 버전을 확인됐다고 하지 않는다)", () => {
    for (const provider of ["claude", "codex", "gemini"] as const) expect(folders(provider)).toEqual([...VERIFIED_CLI_VERSIONS[provider]].sort());
  });
  test("Gemini(Antigravity CLI) 견본은 모두 실측이고, 계정 메일·이 Mac 의 경로·대화 id 를 담지 않는다", () => {
    // 2026-11-23 대표가 agy 첫 설정을 마친 뒤 받은 대화형 화면(1.5.14). 메일은 user@example.com, 경로는 견본 폴더, 대화 id 는 가짜 UUID 로 바꿨다.
    for (const version of folders("gemini")) {
      const m = manifest("gemini", version);
      expect(m.fixtures.every(f => f.origin === "observed")).toBe(true);
      for (const fixture of m.fixtures) {
        const text = readFileSync(join(ROOT, "gemini", version, fixture.file), "utf8");
        const decoded = fixture.kind === "osc" ? text.split("\n").map(line => /msg=([A-Za-z0-9+/=]+)/.exec(line)?.[1]).filter(Boolean).map(msg => Buffer.from(msg!, "base64").toString("utf8")).join("\n") : "";
        for (const body of [text, decoded]) {
          expect([fixture.file, (body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).filter(mail => mail !== "user@example.com")]).toEqual([fixture.file, []]);
          expect([fixture.file, /claude-\d+|\/Users\/(?!user\b)[A-Za-z]/.test(body)]).toEqual([fixture.file, false]);
        }
      }
    }
  });
  test.each(all)("$provider $version: manifest 가 폴더와 맞고 견본 파일이 모두 있다", ({ provider, version }) => {
    const m = manifest(provider, version);
    expect(m.provider).toBe(provider);
    expect(m.version).toBe(version);
    expect(m.source.length).toBeGreaterThan(0);
    expect(m.fixtures.length).toBeGreaterThan(0);
    // 실측 견본이 적어도 하나 있어야 그 버전을 확인했다고 할 수 있다.
    expect(m.fixtures.some(f => f.origin === "observed")).toBe(true);
    const files = readdirSync(join(ROOT, provider, version)).filter(name => name !== "manifest.json").sort();
    expect(m.fixtures.map(f => f.file).sort()).toEqual(files);
  });
});

function screenResults(provider: Provider, screen: string, cwd: string) {
  const trust = provider === "claude" ? claudeFolderTrust(screen, cwd) : codexFolderTrust(screen, cwd);
  return {
    ...(provider === "claude" ? { inputEmpty: inputLooksEmpty(screen), quiet: claudeQuietScreen(screen) } : { draft: codexDraft(screen), backgroundTerminals: codexBackgroundTerminals(screen) }),
    folderTrustLike: looksLikeFolderTrust(screen),
    trustDialogLike: trustDialogLike(screen, provider),
    folderTrust: trust ? { selected: trust.selected, options: trust.prompt.options.map(option => option.label) } : null,
  };
}

/** Gemini 화면: 그 화면 때의 OSC 상태(fixture.osc)와 함께 판독 함수를 돌린다. 멈춤 키 판정은 보고만으로(화면 없이) 본다. */
function geminiScreenResults(screen: string, fixture: Fixture) {
  const osc = fixture.osc ?? null;
  return {
    draft: geminiDraft(screen), turnToStop: geminiTurnToStop(osc, false), folderTrust: geminiFolderTrust(osc, screen), folderTrustFromScreen: geminiFolderTrust(null, screen),
    setupBlocked: geminiSetupBlocked(osc), approval: geminiApprovalDialog(screen), progress: geminiProgress(screen), retry: geminiRetry(screen), trustDialogLike: trustDialogLike(screen, "gemini"),
  };
}

/** Gemini 상태줄 입력 원본(.json 하나 또는 .jsonl 여러 줄)을 상태줄 래퍼와 같은 규칙(geminiStatusFromPayload)으로 기록으로 바꾼다. 여러 줄이면 칸마다 목록이다. */
function geminiStatuslineResults(fixture: Fixture, text: string) {
  const payloads = fixture.file.endsWith(".jsonl") ? text.split("\n").filter(Boolean).map(line => JSON.parse(line) as unknown) : [JSON.parse(text) as unknown];
  const records = payloads.map(payload => geminiStatusFromPayload("m_fixture", payload, new Date("2026-11-22T15:30:00Z")));
  const pick = <T>(read: (record: (typeof records)[number]) => T): T | T[] => records.length === 1 ? read(records[0]!) : records.map(read);
  return {
    conversationId: pick(r => r.conversationId), cycleMode: pick(r => r.cycleMode), agentState: pick(r => r.agentState), transcriptPath: pick(r => r.transcriptPath),
    subagents: pick(r => r.subagents), subagentsUnknown: pick(r => r.subagentsUnknown), costUsd: pick(r => r.costUsd), quotaBuckets: pick(r => Object.keys(r.quota).sort()),
    quotaFamilies: pick(r => Object.fromEntries(Object.keys(r.quota).sort().map(id => [id, geminiBucketFamily(id)]))),
    emailKept: records.some(record => JSON.stringify(record).includes("@")),
  };
}

/** Gemini 의 OSC 7501 본문(줄마다 state=…[:kind=…]:app=…[:msg=<base64>]). */
function geminiOscResults(text: string) {
  const rows = text.split("\n").filter(line => line.trim()).map(line => Object.fromEntries(line.split(":").filter(part => part.includes("=")).map(part => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)])) as Record<string, string>);
  return {
    states: rows.map(row => row.state), blockedMessages: rows.filter(row => row.state === "blocked").map(row => geminiReportedText(row.msg)),
    doneMessages: rows.filter(row => row.state === "done").map(row => geminiReportedText(row.msg)),
    turnToStop: rows.map(row => geminiTurnToStop({ state: row.state, kind: row.kind ?? null, msg: row.msg }, false)),
  };
}

/**
 * Gemini 기록: hooks.jsonl 은 agy 가 훅 명령에 준 입력 원본이다. 그 입력을 IAMCEO 의 실제 기록 스크립트(hooks.json 명령을 /bin/sh -c 로)에 차례로 넣어
 * 서버가 읽는 기록을 만든 뒤 턴 끝 판정을 돌린다. transcript-compact.jsonl 은 그 대화의 transcript.jsonl 끝부분이다.
 */
async function geminiLogResults(fixture: Fixture, text: string) {
  const home = mkdtempSync(join(scratch, "gemini-"));
  if (fixture.file === "transcript-compact.jsonl") {
    const id = "aaaaaaaa-1111-4111-8111-000000000001";
    const path = geminiTranscriptPath(home, id)!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    const identity = { sessionId: id, generation: 1, terminalId: "t1", turn: null, model: null };
    const log = readJsonlRange(geminiTranscriptRoot(home), path).cursor!;
    const compactOutcome = observeCompactBoundary({ cli: "gemini", home, cwd: fixture.cwd, baseline: { ...identity, path, fileIdentity: log.fileIdentity, offset: 0 }, current: identity, settled: true, providerError: false }).outcome;
    return { compactOutcome, promptTokens: geminiPromptTokens(home, id), hasModelResponse: geminiHasModelResponse(home, id) };
  }
  const eventsDir = geminiHookEventsDir(home), member = "m_fixture";
  const command = ((geminiHooksConfig({ memberId: member, eventsDir })[GEMINI_HOOKS_NAME] as Record<string, { command: string }[]>).Stop![0]!).command;
  const inputs = text.split("\n").filter(Boolean).map(line => (JSON.parse(line) as { input: Record<string, unknown> }).input);
  const watch = geminiTurnWatch(eventsDir, member);
  const record = async (input: Record<string, unknown>) => {
    const child = Bun.spawn(["/bin/sh", "-c", command], { stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(stdout).toBe("{}");
  };
  // 서브에이전트가 일하고 부모 턴이 끝난 자리(서브에이전트가 시작한 뒤 부모의 Stop fullyIdle true)까지 넣고 턴 끝을 판정한다.
  const parent = inputs[0]!.conversationId as string;
  const subagentStart = inputs.findIndex(input => input.hookEventName === "SessionStart" && input.conversationId !== parent);
  const parentEnd = inputs.findIndex((input, i) => i > subagentStart && input.hookEventName === "Stop" && input.conversationId === parent && input.fullyIdle === true);
  expect(subagentStart > 0 && parentEnd > subagentStart).toBe(true);
  for (const input of inputs.slice(0, parentEnd + 1)) await record(input);
  const shape = (stop: ReturnType<typeof readGeminiTurnStop>) => stop && { reason: stop.reason, fullyIdle: stop.fullyIdle, conversationId: stop.conversationId };
  // 대화 id 를 아는 터미널(보통), 모르는 터미널(상태줄 기록이 아직 없음: 처음부터 읽는 읽기).
  const parentTurnStop = shape(readGeminiTurnStop(watch, eventsDir, parent));
  const unknownConversationTurnStop = shape(readGeminiTurnStop({ reader: new HookFileReader(eventsDir, member, parseGeminiHookLine), pending: [] }, eventsDir, null));
  for (const input of inputs.slice(parentEnd + 1)) await record(input);
  const records = readFileSync(join(eventsDir, `${member}.jsonl`), "utf8").split("\n").filter(Boolean).map(line => parseGeminiHookLine(line)!);
  const stops = records.filter(r => r.event === "Stop");
  const errorStop = stops.find(r => r.reason === "ERROR");
  const compactAt = records.findIndex(r => r.event === "PreInvocation" && r.compact);
  return {
    stopReasons: [...new Set(stops.map(r => r.reason))], conversations: new Set(records.map(r => r.conversationId)).size, parentTurnStop, unknownConversationTurnStop,
    errorStopKind: errorStop ? classifyGeminiTurnError(geminiTurnErrorText({ stopError: errorStop.error ?? null })) : null,
    compactEnd: compactAt >= 0 && records.slice(compactAt + 1).find(r => r.event === "Stop")?.reason === "TERMINAL_CUSTOM_HOOK",
  };
}

function logResults(provider: Provider, fixture: Fixture, text: string) {
  const home = mkdtempSync(join(scratch, `${provider}-`));
  const path = provider === "claude" ? join(home, "projects", "encoded-cwd", `${fixture.sessionId}.jsonl`) : join(home, "sessions", "2026", "11", "07", `rollout-time-${fixture.sessionId}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const result = readDeliveryEvidence({ cli: provider, home, path, cwd: fixture.cwd, sessionId: fixture.sessionId!, sessionGeneration: 1,
    markers: Object.entries(fixture.markers ?? {}).map(([deliveryId, marker]) => ({ deliveryId, marker })) });
  const first = JSON.parse(text.split("\n")[0]!) as unknown;
  const turnEnd = provider === "codex" ? readCodexTurnEnd({ home, path, sessionId: fixture.sessionId!, cwd: fixture.cwd, baseline: null, markers: Object.values(fixture.markers ?? {}) }).outcome : undefined;
  const claude = provider === "claude" ? readClaudeTurn({ home, path, sessionId: fixture.sessionId!, baseline: { offset: 0, fileIdentity: null }, markers: [...(fixture.bundleMarker ? [fixture.bundleMarker] : []), ...Object.values(fixture.markers ?? {})] }) : null;
  const tail = provider === "claude" ? parseTranscriptTail(text) : null;
  const log = provider === "claude" ? readJsonlRange(join(home, "projects"), path).cursor : null;
  const identity = { sessionId: fixture.sessionId!, generation: 1, terminalId: "t1", turn: null, model: null };
  const compactOutcome = log ? observeCompactBoundary({ cli: "claude", home, cwd: fixture.cwd, baseline: { ...identity, path, fileIdentity: log.fileIdentity, offset: 0 }, current: identity, settled: true, providerError: false }).outcome : undefined;
  return { compactOutcome, received: result.receivedDeliveryIds, verdict: result.evidence.verdict, code: result.evidence.code, complete: result.evidence.complete,
    sessionMeta: provider === "codex" ? parseCodexSessionMeta(first) !== null : undefined, turnEnd,
    claudeTurn: claude?.outcome, claudeTurnError: claude ? claude.error?.error ?? null : undefined, idleCompaction: tail ? !!tail.idleCompaction : undefined, tailTokens: tail?.contextTokens };
}

describe.each(all)("$provider $version 견본을 지금 해석기로 읽는다", ({ provider, version }) => {
  const m = manifest(provider, version);
  test.each(m.fixtures.map(f => [f.file, f] as const))("%s", async (_name, fixture) => {
    const text = readFileSync(join(ROOT, provider, version, fixture.file), "utf8");
    // 견본 안에 CLI 가 스스로 적은 버전이 있으면 폴더 이름과 같아야 한다(다른 버전의 화면을 잘못 넣지 않게).
    if (fixture.bannerVersion) expect(parseCliVersion(text)).toBe(version);
    const actual: Record<string, unknown> = provider === "gemini"
      ? fixture.kind === "screen" ? geminiScreenResults(text, fixture) : fixture.kind === "statusline" ? geminiStatuslineResults(fixture, text) : fixture.kind === "osc" ? geminiOscResults(text) : await geminiLogResults(fixture, text)
      : fixture.kind === "screen" ? screenResults(provider, text, fixture.cwd) : logResults(provider, fixture, text);
    const expected = fixture.expect as Record<string, unknown>;
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    for (const key of Object.keys(expected)) expect([key, actual[key]]).toEqual([key, expected[key]]);
  });
});
