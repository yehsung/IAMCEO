// 압축 완료의 근거가 실제 CLI 의 모양과 어긋나 팀장이 '결과 모름(uncertain)'에 붙들리던 것(2026-11-15 라이브)을 서버 끝까지 확인한다.
//
//   가짜 core(tests/fixtures/core-harness.ts) ← 실제 CoreRunner ← 실제 Orchestrator(운영 배선) ← 실제 HTTP 서버
//
// 1. Claude Code 는 Bash 의 cd 를 다음 명령까지 유지하고 기록의 줄마다 그때의 폴더를 cwd 로 적는다. 하위 폴더에 들어가 있던 팀장의 압축 경계 줄은
//    cwd 가 팀장 시작 폴더와 달라, 예전 서버는 경계를 못 알아보고 10분 뒤 압축을 '결과 모름'으로 남겼다(커서는 파일 끝까지 읽은 채 boundary=false).
//    고친 서버는 그 저장 상태를 이어받아도 옛 커서를 버리고 기준선부터 다시 읽어 압축을 닫고, 막혀 있던 전달을 내보낸다.
// 2. 세션 기록에 경계가 보이지 않아도, 그 압축을 넣은 뒤(넣기 직전의 사건 파일 자리 뒤에 덧붙은) 같은 세션의 '압축 끝' 훅과 쉬는 CLI 가 있으면 압축을 닫는다.
//
// 견본의 폴더 이름·글은 모두 지어낸 것이다(실제 프로젝트 내용 없음).
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import type { CoreCompactState } from "../server/runner/core.ts";
import { COMPACT_BOUNDARY_RULES, type CompactBoundaryBaseline } from "../server/runner/core-context.ts";
import { readJsonlRange } from "../server/runner/delivery-evidence.ts";
import { hookEventsDir, hookEventsFile } from "../server/runner/hooks.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import { memberConfig, type DecisionOption, type Member } from "../shared/types.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions } from "./fixtures/core-harness.ts";

const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") return { text: `보고함 ${(await orch.recordPost(member, args as unknown as PostInput)).id}` };
    if (name === "ask") return { text: (await orch.registerAsk(member, args as { title: string; detail?: string; options?: DecisionOption[] })).text };
    return { text: "모르는 도구", isError: true };
  },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close().catch(() => {}); });
const FAST = { tickMs: 150, healthMs: 40, retryMs: 30, inputBusyRetryMs: 30, writeSettleMs: 40, startGraceMs: 200 };
/** '일어났다'를 기다리는 상한. 일어나면 곧바로 지나간다. */
const SETTLE_MS = 8000;
/** '일어나지 않는다'를 보는 대기. 관측(20ms)·틱(150ms)이 여러 번 돌 시간이다. */
const QUIET_MS = 600;

async function setup(opts: CoreSetupOptions = {}): Promise<CoreEnv> {
  const t = await coreSetup({ agentTools: TOOLS, ...opts, timings: { ...FAST, ...opts.timings } });
  cleanups.push(() => t.close());
  return t;
}
async function worker(t: CoreEnv): Promise<Member> {
  const w = (await t.orch.addMember(t.project.id, { name: "자료 정리", handle: "docs", role: "개발" })).member;
  await t.orch.assign(t.project.id, w.handle, { text: "첫 일 @fake:post=첫일끝" });
  await t.waitFor("첫 일 보고", () => t.texts().some((m) => m.title === "첫일끝"));
  await t.idle(w.id);
  return t.member(w.id);
}
/** 그 팀장이 무엇에 막혀 있는지. 기다림이 끝내 안 되면 실패 글에 싣는다. */
function fences(t: CoreEnv, memberId: string) {
  const m = t.store.requireMember(memberId);
  const c = t.store.getContextState(memberId)?.compaction;
  return { status: m.status, compaction: c ? `${c.phase}/${c.reason ?? "-"}` : null, runnerBusy: t.runner.isBusy(memberId),
    deliveries: t.store.listDeliveries(m.projectId).filter((d) => d.memberId === memberId && d.status !== "delivered").map((d) => `${d.kind}:${d.status}/${d.holdReason ?? "-"}`) };
}
async function eventually(t: CoreEnv, memberId: string, what: string, read: () => unknown, ms = SETTLE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (read()) return; await Bun.sleep(20); }
  expect({ 기대: what, 결과: `${ms}ms 안에 일어나지 않음`, 막힘: fences(t, memberId) }).toEqual({ 기대: what, 결과: "일어남", 막힘: {} } as never);
}
const delivered = (t: CoreEnv, deliveryId: string) => t.store.requireDelivery(deliveryId).status === "delivered";
const instruct = async (t: CoreEnv, w: Member, text: string) => (await t.orch.assign(t.project.id, w.handle, { text })).delivery.id;
const compactTurns = (t: CoreEnv, w: Member) => t.turns(w.id).filter((x) => x.prompt.startsWith("/compact"));
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

describe("하위 폴더에서 끝난 압축이 '결과 모름'으로 남은 팀장", () => {
  test("옛 서버가 남긴 붙들린 압축을 고친 서버가 이어받아, 쉬는 CLI 에서 확인 한 번으로 닫고 막혀 있던 전달을 내보낸다", async () => {
    // 첫 서버는 틱을 돌리지 않는다(만든 상태를 그대로 넘긴다).
    const t = await setup({ timings: { tickMs: 60_000 } });
    const w = await worker(t);
    const sessionId = w.sessionId!, cwd = w.cwd;
    const path = transcriptPath(cwd, sessionId, t.core.claudeHome);
    const root = join(t.core.claudeHome, "projects");
    const head = readJsonlRange(root, path);
    expect(head.complete).toBe(true);
    const settings = t.store.getSettings();
    const terminal = t.core.terminalOf(w.id)!;
    // 압축 명령을 넣기 직전 기록의 끝(기준선). 실행기가 compact() 에서 적는 모양 그대로다.
    const baseline: CompactBoundaryBaseline = { path, fileIdentity: head.cursor!.fileIdentity, offset: head.cursor!.offset, sessionId, terminalId: w.paneId!,
      generation: t.store.memberRevisions(w.id).sessionGeneration, turn: terminal.turn ?? 0, model: memberConfig(w, settings.ranks, settings.codexRanks).model };
    // 팀장은 Bash 로 하위 폴더에 들어가 있었다. Claude Code 2.1.323 이 남긴 줄의 순서(바이트 순서) 그대로: 경계 줄, 압축 요약,
    // 그 뒤에 더 앞선 시각의 /compact 명령 줄 둘, 명령 출력. 글은 모두 지어낸 것이다.
    const sub = join(cwd, "drafts", "chapter-2");
    const sent = Date.parse("2026-11-15T14:42:11.730Z");
    const at = (ms: number) => new Date(sent + ms).toISOString();
    const common = { sessionId, cwd: sub, version: "2.1.323", gitBranch: "main", userType: "external", isSidechain: false };
    appendFileSync(path, [
      line({ ...common, type: "system", subtype: "compact_boundary", content: "Conversation compacted", level: "info", parentUuid: null, logicalParentUuid: crypto.randomUUID(),
        compactMetadata: { trigger: "manual", preTokens: 768_344, postTokens: 28_941, durationMs: 125_173 }, uuid: crypto.randomUUID(), timestamp: at(125_754) }),
      line({ ...common, type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, parentUuid: null, uuid: crypto.randomUUID(), timestamp: at(125_174),
        message: { role: "user", content: "This session is being continued from a previous conversation. 가짜 요약: 표 두 개를 정리했고 그림 하나가 남았다." } }),
      line({ ...common, type: "user", isMeta: true, uuid: crypto.randomUUID(), timestamp: at(0), message: { role: "user", content: "<local-command-caveat>Caveat: 가짜 안내</local-command-caveat>" } }),
      line({ ...common, type: "user", uuid: crypto.randomUUID(), timestamp: at(0), message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>가짜 초점</command-args>" } }),
      line({ ...common, type: "user", uuid: crypto.randomUUID(), timestamp: at(125_800), message: { role: "user", content: "<local-command-stdout>Compacted 가짜 출력</local-command-stdout>" } }),
    ].join(""));
    // 옛 서버(줄의 cwd 를 팀장 시작 폴더와 비교)가 저장한 모양: 커서는 파일 끝까지 읽었고 경계는 못 봤다. 규칙 판(rules)이 없다.
    const old = readJsonlRange(root, path, null, { startOffset: baseline.offset, fileIdentity: baseline.fileIdentity });
    expect(old.complete).toBe(true);
    const id = crypto.randomUUID(), startedAt = Date.now() - 13 * 3_600_000;
    const coreCompact: CoreCompactState = { id, phase: "uncertain", startedAt, baseline,
      cursor: { baseline, queryKey: JSON.stringify(["claude", t.core.claudeHome, cwd, baseline]), log: old.cursor, boundary: false, invalid: false } };
    const state = t.store.ensureContextState(w.id);
    t.store.saveContextState({ ...state, baseline: { ...state.baseline, coreCompact },
      compaction: { id, trigger: "auto", phase: "uncertain", reason: "send_uncertain", requestedAt: new Date(startedAt - 14).toISOString(), startedAt: new Date(startedAt).toISOString(), finishedAt: null } });
    t.store.patchMember(w.id, { status: "working" });
    // 붙들린 압축이 대표의 답을 막고 있다.
    const d = await instruct(t, w, "결재 답 @fake:post=답받음");
    await Bun.sleep(QUIET_MS);
    expect(delivered(t, d)).toBe(false);
    expect(t.turns(w.id).some((x) => x.prompt.includes("결재 답"))).toBe(false);
    // 배포: 서버만 내렸다가 다시 띄운다. 터미널(CLI)은 core 에 그대로 남아 있고, 압축 턴만큼 턴 번호가 올라 쉬고 있다.
    await t.stopServer();
    terminal.turn = baseline.turn! + 1; terminal.status = { state: "idle" };
    const next = await t.restart({ timings: FAST });
    cleanups.push(() => next.close());
    await eventually(next, w.id, "압축이 닫히고 막혀 있던 전달이 나감", () => delivered(next, d));
    const after = next.store.getContextState(w.id)!;
    expect(after.compaction).toMatchObject({ id, phase: "succeeded", reason: null });
    expect(after.compaction!.finishedAt).not.toBeNull();
    const saved = after.baseline?.coreCompact as CoreCompactState;
    expect(saved).toMatchObject({ id, phase: "succeeded", cursor: { boundary: true, rules: COMPACT_BOUNDARY_RULES } });
    expect(saved.evidence).toBeUndefined(); // 기록 경계로 닫았다(훅이 아니다).
    expect(next.store.listActivity(w.id).filter((a) => a.text === "압축 완료")).toHaveLength(1);
    // 압축은 다시 넣지 않았다. 기록을 다시 읽어 확인했을 뿐이다.
    expect(compactTurns(next, w)).toHaveLength(0);
    await next.waitFor("답 보고", () => next.texts().some((m) => m.title === "답받음"));
    await next.idle(w.id);
    expect(next.member(w.id).status).toBe("idle");
  }, 40_000);

  test("하위 폴더에서 일하던 팀장의 기록만 남아도 보관할 때 세션 기록 확인을 지나간다", async () => {
    const t = await setup();
    const w = await worker(t);
    const path = transcriptPath(w.cwd, w.sessionId!, t.core.claudeHome);
    // 모든 줄이 하위 폴더에서 쓰였다(시작하자마자 cd 한 팀장). 줄의 sessionId 는 그대로다.
    const sub = join(w.cwd, "drafts");
    const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((row) => JSON.stringify({ ...JSON.parse(row), cwd: sub }));
    writeFileSync(path, `${rows.join("\n")}\n`);
    await t.orch.patchProject(t.project.id, { archived: true });
    expect(t.store.requireProject(t.project.id).archived).toBe(true);
    expect(t.member(w.id)).toMatchObject({ status: "asleep", sessionId: w.sessionId });
  }, 40_000);
});

describe("세션 기록에 경계가 없어도 압축 끝 훅이 온 압축", () => {
  /** 압축 명령을 받은 CLI 가 일하는 중이 되지만 기록에는 경계를 남기지 않는다(기록 모양이 바뀐 CLI). */
  async function runningCompact() {
    const t = await setup();
    const w = await worker(t);
    t.core.intercept((call) => {
      if (call.method !== "terminal.send" || !String(call.params.text).startsWith("/compact")) return undefined;
      const terminal = t.core.terminalOf(w.id)!;
      const turn = terminal.turn ?? 0;
      terminal.status = { state: "working" };
      return { result: { turn, started: true } };
    });
    await t.orch.compactMember(w.id, "가짜 초점");
    await eventually(t, w.id, "압축 넣음", () => t.store.getContextState(w.id)?.compaction?.phase === "running");
    t.core.intercept(null);
    const d = await instruct(t, w, "압축 뒤 일 @fake:post=압축뒤끝");
    const events = hookEventsDir(t.home);
    mkdirSync(events, { recursive: true, mode: 0o700 });
    const file = hookEventsFile(events, w.id);
    const hook = (record: Record<string, unknown>) => appendFileSync(file, line({ v: 1, at: Date.now(), sessionId: w.sessionId, ...record }), { mode: 0o600 });
    const settle = () => { const terminal = t.core.terminalOf(w.id)!; terminal.turn = (terminal.turn ?? 0) + 1; terminal.status = { state: "idle" }; };
    return { t, w, d, file, hook, settle };
  }
  const running = (t: CoreEnv, w: Member) => t.store.getContextState(w.id)?.compaction?.phase === "running";

  test("넣은 뒤 같은 세션에서 온 PostCompact(manual)와 쉬는 CLI 로 압축을 닫고, 기다리던 전달을 내보낸다", async () => {
    const { t, w, d, hook, settle } = await runningCompact();
    // 압축 전의 같은 세션 훅(앞선 압축), 다른 세션의 훅, CLI 스스로의 자동 압축 훅은 이 압축의 끝이 아니다.
    hook({ event: "PostCompact", trigger: "manual", at: Date.now() - 60_000 });
    hook({ event: "PostCompact", trigger: "manual", sessionId: "other-session" });
    hook({ event: "PostCompact", trigger: "auto" });
    settle();
    await Bun.sleep(QUIET_MS);
    expect(running(t, w)).toBe(true);
    expect(delivered(t, d)).toBe(false);
    hook({ event: "PostCompact", trigger: "manual" });
    await eventually(t, w.id, "훅으로 압축이 닫히고 전달이 나감", () => delivered(t, d));
    const state = t.store.getContextState(w.id)!;
    expect(state.compaction).toMatchObject({ phase: "succeeded", reason: null });
    expect(state.baseline?.coreCompact).toMatchObject({ phase: "succeeded", evidence: "hook" });
    expect(t.store.listActivity(w.id).filter((a) => a.text === "압축 완료")).toHaveLength(1);
    expect(compactTurns(t, w)).toHaveLength(0); // 압축 명령은 가로챘다: 가짜 CLI 의 기록에는 경계가 없다.
    await t.waitFor("뒤 일 보고", () => t.texts().some((m) => m.title === "압축뒤끝"));
  }, 40_000);

  // 줄이 적은 시각은 그 줄을 쓴 프로세스가 정한다. 압축을 넣기 직전의 사건 파일 자리(coreCompact.hookMark) 뒤에 덧붙은 줄만 본다.
  test("압축 전에 사건 파일에 미리 넣어 둔 줄(한 시간 뒤 시각)은, 넣은 직후 core 가 앞 턴의 '끝남'을 알려도 압축을 닫지 않는다", async () => {
    const t = await setup();
    const w = await worker(t);
    const events = hookEventsDir(t.home);
    mkdirSync(events, { recursive: true, mode: 0o700 });
    const file = hookEventsFile(events, w.id);
    const hook = (record: Record<string, unknown>) => appendFileSync(file, line({ v: 1, at: Date.now(), event: "PostCompact", trigger: "manual", sessionId: w.sessionId, ...record }), { mode: 0o600 });
    hook({ at: Date.now() + 3_600_000 });
    hook({ event: "SessionStart", source: "compact", at: Date.now() + 3_600_000 });
    const planted = statSync(file);
    // 압축 명령은 받았지만 core 는 아직 앞 턴의 '끝남'을 알린다(정착한 CLI 로 보인다). 기록에는 경계가 없다.
    t.core.intercept((call) => {
      if (call.method !== "terminal.send" || !String(call.params.text).startsWith("/compact")) return undefined;
      const terminal = t.core.terminalOf(w.id)!;
      terminal.status = { state: "done" };
      return { result: { turn: terminal.turn ?? 0, started: true } };
    });
    await t.orch.compactMember(w.id, "가짜 초점");
    await eventually(t, w.id, "압축 넣음", () => running(t, w));
    t.core.intercept(null);
    expect((t.store.getContextState(w.id)!.baseline?.coreCompact as CoreCompactState).hookMark).toEqual({ identity: `${planted.dev}:${planted.ino}`, offset: planted.size });
    const d = await instruct(t, w, "압축 뒤 일 @fake:post=압축뒤끝");
    await Bun.sleep(QUIET_MS);
    expect(running(t, w)).toBe(true);
    expect(delivered(t, d)).toBe(false);
    // 넣은 뒤에 덧붙은 같은 세션의 압축 끝 훅으로는 닫힌다.
    hook({});
    await eventually(t, w.id, "넣은 뒤의 훅으로 압축이 닫히고 전달이 나감", () => delivered(t, d));
    expect(t.store.getContextState(w.id)!.baseline?.coreCompact).toMatchObject({ phase: "succeeded", evidence: "hook" });
    await t.waitFor("뒤 일 보고", () => t.texts().some((m) => m.title === "압축뒤끝"));
  }, 40_000);

  test("훅만 있고 CLI 가 아직 일하는 중이면, 또 남이 쓸 수 있는 사건 파일의 훅이면 닫지 않는다", async () => {
    const { t, w, d, file, hook, settle } = await runningCompact();
    hook({ event: "SessionStart", source: "compact" });
    await Bun.sleep(QUIET_MS); // CLI 는 아직 일하는 중이다.
    expect(running(t, w)).toBe(true);
    chmodSync(file, 0o666); // 다른 사용자도 쓸 수 있는 파일의 기록은 근거로 읽지 않는다.
    settle();
    await Bun.sleep(QUIET_MS);
    expect(running(t, w)).toBe(true);
    expect(delivered(t, d)).toBe(false);
    chmodSync(file, 0o600);
    await eventually(t, w.id, "믿을 수 있는 파일의 SessionStart(compact) 로 닫힘", () => delivered(t, d));
    expect(t.store.getContextState(w.id)!.baseline?.coreCompact).toMatchObject({ phase: "succeeded", evidence: "hook" });
  }, 40_000);
});
