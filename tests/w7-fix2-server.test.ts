// 0.2.7 배포 전 재확인(실제 CLI, verify/real-cli-2.md '새로 찾은 문제' P5·P6·P7)에서 나온 서버 문제.
// 실행기는 실제 CoreRunner, 총괄은 운영 배선, core 는 가짜(tests/fixtures/core-harness.ts). 글은 가짜다.
// - P5: Claude 의 압축을 '중단'으로 끊으면 세션 기록에 local-command-caveat 만 남아, 바로 다음 입력을 Claude 가 '그 로컬 명령의 기록'으로 읽고 하지 않았다.
//       끊은 뒤 처음 넣는 봉투의 맨 앞에 그 사실을 밝히는 한 줄(COMPACT_STOP_NOTICE)을 한 번 싣는다.
// - P6: 약 990자 '/compact …' 는 Claude 가 슬래시 명령이 아니라 붙여넣은 글로 받아 압축이 돌지 않았다. 명령 전체를 400자 안으로 자른다.
// - P7: '압축을 멈춘 뒤 입력칸에 글이 남음' 상태 줄이 core 감독의 다시 붙기(healthMs 마다)로 몇 초 만에 지워졌다.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handleAgentTool } from "../server/agent-tools.ts";
import { COMPACT_STOP_NOTICE } from "../server/delivery-text.ts";
import { CLAUDE_COMPACT_COMMAND_MAX, claudeCompactCommand, type CoreCompactState } from "../server/runner/core.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import { ApiError } from "../server/store.ts";
import { ERROR_CODES } from "../shared/error-codes.ts";
import type { Member } from "../shared/types.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions, type FakeCoreCall } from "./fixtures/core-harness.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup(opts: CoreSetupOptions = {}): Promise<CoreEnv> {
  const t = await coreSetup(opts);
  cleanups.push(() => t.close());
  return t;
}
const codes = (t: CoreEnv, id: string) => t.store.listActivity(id, 500).map(a => a.textCode).filter(Boolean);
const promptsWith = (t: CoreEnv, id: string, text: string) => t.core.turns(id).filter(turn => turn.prompt.includes(text));
const noticeTurns = (t: CoreEnv, id: string) => t.core.turns(id).filter(turn => turn.prompt.includes(COMPACT_STOP_NOTICE));
/** 봉투 맨 앞이 그 한 줄인가(바로 뒤가 그 전달의 표지 줄). */
const startsWithNotice = (prompt: string) => prompt.startsWith(`${COMPACT_STOP_NOTICE}\n#iamceo_`);
const stopNote = (t: CoreEnv, id: string) => t.store.getContextState(id)?.baseline?.compactStopNotice;

/**
 * 첫 일을 마친 Claude 팀장에게 압축을 넣고(가짜 core 는 압축 명령을 받으면 끝내지 않고 working 으로 둔다) 앱 '중단'으로 끊는다.
 * restore: 끊긴 뒤 입력칸에 되돌릴 글(Claude 2.1.323 은 끊긴 명령을 되돌린다). null 이면 입력칸은 빈 채다.
 */
async function interruptedCompact(t: CoreEnv, restore: (command: string) => string | null, before?: (m: Member) => void) {
  const m = await t.orch.createMember(t.project.id, { name: "자료 정리" });
  await t.orch.assign(t.project.id, m.handle, { text: "첫 일 @fake:post=첫일끝" });
  await t.idle(m.id);
  await t.waitFor("세션 기록", () => !!t.member(m.id).sessionId);
  before?.(t.member(m.id));
  let command = "";
  t.core.intercept((call: FakeCoreCall) => {
    const terminal = t.core.terminalOf(m.id)!;
    if (call.params.terminal !== terminal.address) return undefined;
    if (call.method === "terminal.send" && String(call.params.text).startsWith("/compact")) {
      command = String(call.params.text);
      terminal.status = { state: "working" };
      return { result: { turn: terminal.turn ?? 0, started: true } };
    }
    if (call.method === "terminal.interrupt") {
      terminal.status = { state: "done" }; terminal.turn = (terminal.turn ?? 0) + 1;
      const draft = restore(command);
      if (draft !== null) t.core.setDraft(m.id, draft);
      return { result: { outcome: "stopped", key: "esc" } };
    }
    return undefined;
  });
  // Claude 의 입력칸: 글이 있을 때 ctrl+c 는 입력 비우기다(P3 의 자동 지우기).
  t.core.onKeys((_terminal, pressed) => { if (pressed.includes("ctrl+c")) t.core.setDraft(m.id, ""); });
  await t.orch.memberCompact(m.id);
  await t.waitFor("압축 도는 중", () => t.store.getContextState(m.id)?.compaction?.phase === "running" && t.core.terminalOf(m.id)!.status?.state === "working");
  await t.orch.memberInterrupt(m.id);
  expect(t.store.getContextState(m.id)?.compaction).toMatchObject({ phase: "failed", reason: "interrupted" });
  return { m: t.member(m.id), command: () => command };
}

describe("P5 Claude 의 압축을 '중단'한 뒤 처음 넣는 봉투", () => {
  test("맨 앞에 '그 명령의 기록이 아니라 새 입력'이라는 한 줄을 한 번 싣는다(대기열에 먼저 있던 깨우지 않는 글보다도 앞). 다음 봉투에는 없다", async () => {
    const t = await setup();
    let earlier = "";
    const { m } = await interruptedCompact(t, cmd => cmd, member => {
      // 압축 전에 대기열에 들어 있던 깨우지 않는 소식(봉투에서 이 글보다 앞 순번).
      earlier = t.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "system", text: "[시스템] 가짜 소식(깨우지 않음)", wake: false }).id;
    });
    expect(stopNote(t, m.id)).toMatchObject({ compactionId: t.store.getContextState(m.id)!.compaction!.id, sessionId: m.sessionId });
    await t.orch.assign(t.project.id, m.handle, { text: "기다리던 일 @fake:post=끝" });
    const first = await t.waitFor("전달", () => promptsWith(t, m.id, "기다리던 일")[0]);
    // 되살아난 압축 명령은 P3 대로 지우고 넣었다.
    await t.waitFor("지운 활동 줄", () => codes(t, m.id).includes("activity.compact_draft_cleared"));
    expect(startsWithNotice(first.prompt)).toBe(true);
    expect(first.prompt.indexOf("가짜 소식")).toBeGreaterThan(first.prompt.indexOf(COMPACT_STOP_NOTICE));
    expect(first.prompt.indexOf("기다리던 일")).toBeGreaterThan(first.prompt.indexOf("가짜 소식"));
    await t.waitFor("앞 소식 들어감", () => t.store.requireDelivery(earlier).status === "delivered");
    expect(stopNote(t, m.id)).toBeUndefined();
    await t.idle(m.id);
    await t.orch.assign(t.project.id, m.handle, { text: "다음 일 @fake:post=끝" });
    const second = await t.waitFor("다음 전달", () => promptsWith(t, m.id, "다음 일")[0]);
    expect(second.prompt).not.toContain(COMPACT_STOP_NOTICE);
    expect(noticeTurns(t, m.id)).toHaveLength(1);
  }, 30_000);

  test("첫 봉투가 입력칸 글 때문에 들어가지 못하면, 그 한 줄은 대기열에 남아 실제로 들어가는 봉투의 맨 앞에 한 번만 실린다", async () => {
    const t = await setup({ timings: { inputBusyRetryMs: 20 } });
    const { m } = await interruptedCompact(t, () => "/compact 내가 쓴 다른 요약 지시");
    await t.orch.assign(t.project.id, m.handle, { text: "기다리던 일" });
    await t.waitFor("안내 줄", () => codes(t, m.id).includes("activity.compact_draft_left"));
    for (let i = 0; i < 3; i++) { await t.orch.pump(m.id); await Bun.sleep(40); }
    expect(t.core.turns(m.id).some(turn => turn.prompt.includes("기다리던 일"))).toBe(false);
    // 한 줄은 하나만 만들어져 대기열에 남아 있다(거절이 거듭돼도 더 만들지 않는다. 펌프가 넣어 보는 동안이면 delivering).
    const queued = t.store.listDeliveries(t.project.id).filter(d => d.memberId === m.id && d.text === COMPACT_STOP_NOTICE);
    expect(queued).toHaveLength(1);
    expect(["queued", "held", "delivering"]).toContain(queued[0]!.status);
    t.core.setDraft(m.id, "");
    await t.orch.pump(m.id);
    const first = await t.waitFor("전달", () => promptsWith(t, m.id, "기다리던 일")[0]);
    expect(startsWithNotice(first.prompt)).toBe(true);
    await t.waitFor("그 한 줄 들어감", () => t.store.requireDelivery(queued[0]!.id).status === "delivered");
    await t.idle(m.id);
    await t.orch.assign(t.project.id, m.handle, { text: "다음 일 @fake:post=끝" });
    await t.waitFor("다음 전달", () => promptsWith(t, m.id, "다음 일")[0]);
    expect(noticeTurns(t, m.id)).toHaveLength(1);
  }, 30_000);

  test("서버가 그 사이 다시 떠도 잃지 않는다(문맥 상태에 저장)", async () => {
    const t = await setup();
    const { m } = await interruptedCompact(t, () => null);
    expect(stopNote(t, m.id)).toBeTruthy();
    const t2 = await t.restart();
    cleanups.push(() => t2.close());
    await t2.waitFor("다시 붙음", () => !t2.runner.isBusy(m.id) && t2.member(m.id).status === "idle");
    await t2.orch.assign(t2.project.id, m.handle, { text: "재시작 뒤 일 @fake:post=끝" });
    const first = await t2.waitFor("전달", () => promptsWith(t2, m.id, "재시작 뒤 일")[0]);
    expect(startsWithNotice(first.prompt)).toBe(true);
    expect(noticeTurns(t2, m.id)).toHaveLength(1);
  }, 30_000);

  test("압축 확인 안내의 '중단'(쉬는 CLI 의 미확정 압축을 키 없이 닫음)에도 그 한 줄을 한 번 싣는다", async () => {
    const t = await setup();
    const m = await t.orch.createMember(t.project.id, { name: "자료 정리" });
    await t.orch.assign(t.project.id, m.handle, { text: "첫 일 @fake:post=첫일끝" });
    await t.idle(m.id);
    // 압축 명령은 들어갔지만 CLI 는 곧 쉬고, 세션 기록에 압축 경계는 남지 않았다(끝을 확인하지 못한 압축).
    t.core.intercept((call: FakeCoreCall) => {
      if (call.method === "terminal.send" && String(call.params.text).startsWith("/compact")) return { result: { turn: t.core.terminalOf(m.id)!.turn ?? 0, started: false } };
      return undefined;
    });
    await t.orch.memberCompact(m.id);
    await t.waitFor("미확정 압축", () => ["running", "uncertain"].includes(t.store.getContextState(m.id)?.compaction?.phase ?? ""));
    t.core.intercept(null);
    await t.orch.memberInterrupt(m.id);
    expect(t.core.calls.filter(c => c.method === "terminal.interrupt")).toHaveLength(0);
    await t.orch.assign(t.project.id, m.handle, { text: "다음 일 @fake:post=끝" });
    const first = await t.waitFor("다음 일", () => promptsWith(t, m.id, "다음 일")[0]);
    expect(startsWithNotice(first.prompt)).toBe(true);
    await t.idle(m.id);
    await t.orch.assign(t.project.id, m.handle, { text: "그다음 일 @fake:post=끝" });
    await t.waitFor("그다음 일", () => promptsWith(t, m.id, "그다음 일")[0]);
    expect(noticeTurns(t, m.id)).toHaveLength(1);
  }, 30_000);

  test("끊은 뒤 첫 봉투 전에 새 압축이 끝났으면 싣지 않는다(그 한 줄은 끊긴 압축 바로 뒤의 입력에만 맞다). 넣지 않은 압축을 끊은 것도 싣지 않는다", async () => {
    const t = await setup();
    const { m } = await interruptedCompact(t, () => null);
    expect(stopNote(t, m.id)).toBeTruthy();
    t.core.intercept(null); // 가짜 core 가 압축 명령을 받아 세션 기록에 압축 경계를 남긴다(압축 성공).
    await t.orch.memberCompact(m.id);
    await t.waitFor("새 압축 성공", () => t.store.getContextState(m.id)?.compaction?.phase === "succeeded");
    await t.idle(m.id);
    await t.orch.assign(t.project.id, m.handle, { text: "다음 일 @fake:post=끝" });
    await t.waitFor("다음 일", () => promptsWith(t, m.id, "다음 일")[0]);
    expect(noticeTurns(t, m.id)).toHaveLength(0);
    expect(stopNote(t, m.id)).toBeUndefined();

    // 예약만 되고 넣지 않은 압축(실행기 기준선 없음)을 '중단'으로 닫으면 로컬 명령 기록도 없다.
    const t2 = await setup();
    const w = await t2.orch.createMember(t2.project.id, { name: "자료 정리" });
    await t2.orch.assign(t2.project.id, w.handle, { text: "첫 일 @fake:post=첫일끝" });
    await t2.idle(w.id);
    t2.core.setStatus(w.id, { state: "working" }); // 일하는 중이라 압축은 예약(queued)으로 남는다.
    await t2.waitFor("일하는 중 관측", () => t2.runner.observationState(w.id)?.state === "working");
    await t2.orch.memberCompact(w.id);
    expect(t2.store.getContextState(w.id)?.compaction?.phase).toBe("queued");
    t2.core.intercept((call: FakeCoreCall) => {
      if (call.method !== "terminal.interrupt") return undefined;
      t2.core.setStatus(w.id, { state: "done" });
      return { result: { outcome: "stopped", key: "esc" } };
    });
    await t2.orch.memberInterrupt(w.id);
    expect(t2.store.getContextState(w.id)?.compaction?.phase).toBe("failed");
    expect(stopNote(t2, w.id)).toBeUndefined();
  }, 30_000);
});

describe("P6 Claude 의 압축 명령은 400자 안으로", () => {
  const long = Array.from({ length: 80 }, (_, i) => `정렬 시험 파일 정리 ${i + 1}번째`).join(" · "); // 1000자를 넘는 한국어 한 줄
  test("긴 초점 글은 낱말 경계에서 자르고 '…'를 붙인다. 짧은 글은 그대로다", () => {
    expect(long.length).toBeGreaterThan(1000);
    const command = claudeCompactCommand(long);
    expect(command.length).toBeLessThanOrEqual(CLAUDE_COMPACT_COMMAND_MAX);
    expect(command.length).toBeGreaterThan(CLAUDE_COMPACT_COMMAND_MAX - 40);
    expect(command.startsWith("/compact 정렬 시험 파일 정리 1번째 · ")).toBe(true);
    expect(command.endsWith("…")).toBe(true);
    const kept = command.slice("/compact ".length, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect([" ", " ·"].some(after => long.slice(kept.length).startsWith(after))).toBe(true); // 낱말 중간에서 자르지 않았다
    expect(claudeCompactCommand("이어갈 일: 짧은 일 · 대기 질문: 짧은 질문")).toBe("/compact 이어갈 일: 짧은 일 · 대기 질문: 짧은 질문");
    expect(claudeCompactCommand("줄\n바꿈\t섞인   글")).toBe("/compact 줄 바꿈 섞인 글");
    // 띄어쓰기 없는 긴 글(낱말 경계 없음)과 두 단위 글자도 상한을 넘지 않고, 반쪽 글자를 남기지 않는다.
    const solid = claudeCompactCommand("가".repeat(1000));
    expect(solid.length).toBeLessThanOrEqual(CLAUDE_COMPACT_COMMAND_MAX);
    const emoji = claudeCompactCommand("😀".repeat(600));
    expect(emoji.length).toBeLessThanOrEqual(CLAUDE_COMPACT_COMMAND_MAX);
    expect(/[\ud800-\udbff]…$/.test(emoji)).toBe(false);
  });

  test("team_compact 의 긴 초점(1000자)도 400자 안의 명령으로 넣고, 저장한 명령(command)은 실제로 넣은 글이다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    await t.idle(lead.id);
    const m = await t.orch.createMember(t.project.id, { name: "자료 정리" });
    await t.orch.assign(t.project.id, m.handle, { text: "첫 일 @fake:post=첫일끝" });
    await t.idle(m.id);
    await t.waitFor("세션 기록", () => !!t.member(m.id).sessionId);
    const focus = long.slice(0, 1000);
    const reply = await handleAgentTool(t.orch, t.member(lead.id), "team_compact", { member: m.handle, focus });
    expect(reply.text).toContain("압축을 넣었습니다");
    const sent = await t.waitFor("압축 명령", () => t.core.calls.find(c => c.method === "terminal.send" && String(c.params.text).startsWith("/compact")));
    const text = String(sent.params.text);
    expect(text.length).toBeLessThanOrEqual(CLAUDE_COMPACT_COMMAND_MAX);
    expect(text).toBe(claudeCompactCommand(focus));
    expect((t.store.getContextState(m.id)?.baseline?.coreCompact as CoreCompactState | undefined)?.command).toBe(text);
    await t.waitFor("압축 성공", () => t.store.getContextState(m.id)?.compaction?.phase === "succeeded");
  }, 30_000);

  test("자동 압축의 초점 글은 지금 일·다음 일·대기 질문이 앞에 와서, 일 항목이 많거나 지금 일이 길어도 그것들이 400자 명령 안에 남는다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    t.store.patchMember(lead.id, { now: `지금 일 ${"가나다라 ".repeat(110)}`.trim(), next: "다음 일: 배포 준비" });
    t.store.createDecision({ projectId: t.project.id, memberId: lead.id, who: t.member(lead.id).name, title: "가짜 질문: 정렬 결과 표를 어디에 둘까요", options: [{ k: "a", label: "문서" }, { k: "b", label: "표" }] });
    for (let i = 1; i <= 12; i++) t.store.upsertWork({ projectId: t.project.id, sec: "doing", title: `정렬 시험 파일 정리와 결과 표 다시 만들기 ${i}` });
    const focus = (t.orch as unknown as { compactFocus(member: Member): string }).compactFocus(t.member(lead.id));
    expect(focus.length).toBeGreaterThan(CLAUDE_COMPACT_COMMAND_MAX);
    const command = claudeCompactCommand(focus);
    expect(command.length).toBeLessThanOrEqual(CLAUDE_COMPACT_COMMAND_MAX);
    expect(command.startsWith("/compact 이어갈 일: 지금 일 가나다라")).toBe(true);
    expect(command).toContain("다음 일: 배포 준비");
    expect(command).toContain("대기 질문: 가짜 질문: 정렬 결과 표를 어디에 둘까요");
    // 일 항목은 뒤에 있어 잘리는 쪽이다.
    expect(focus.indexOf("일 항목:")).toBeGreaterThan(focus.indexOf("대기 질문:"));
  }, 30_000);
});

describe("P7 압축 글 상태 줄은 core 감독의 다시 붙기로 지워지지 않는다", () => {
  test("감독이 여러 번 같은 터미널에 다시 붙어도(healthMs) 상태 줄이 남고, 대표가 그 글을 지워 전달이 들어가면 지워진다", async () => {
    const t = await setup({ timings: { inputBusyRetryMs: 20, healthMs: 40 } });
    const { m } = await interruptedCompact(t, () => "/compact 내가 쓴 다른 요약 지시");
    await t.orch.assign(t.project.id, m.handle, { text: "기다리던 일" });
    await t.waitFor("상태 줄", () => t.member(m.id).lastError === ERROR_CODES.last_error_compact_draft.ko);
    const supervisor = (t.orch as unknown as { coreSupervisor: { observations(): { memberId: string; outcome: string; lastObservedAt: number | null }[] } }).coreSupervisor;
    const since = Date.now();
    const seen = new Set<number>();
    await t.waitFor("감독의 다시 붙기 세 번", () => {
      const o = supervisor.observations().find(x => x.memberId === m.id);
      if (o?.outcome === "rejoined" && o.lastObservedAt !== null && o.lastObservedAt >= since) seen.add(o.lastObservedAt);
      return seen.size >= 3;
    });
    expect(t.member(m.id)).toMatchObject({ lastError: ERROR_CODES.last_error_compact_draft.ko, lastErrorCode: "last_error_compact_draft" });
    t.core.setDraft(m.id, "");
    await t.orch.pump(m.id);
    await t.waitFor("전달", () => promptsWith(t, m.id, "기다리던 일")[0]);
    await t.waitFor("상태 줄 지움", () => t.member(m.id).lastError === null);
  }, 30_000);
});

// ---- 162015f 독립 검토·실제 CLI(real-cli-3) 뒤 대응 ----
/** 짝 없는 서로게이트(반쪽 글자)가 있는가. */
const loneSurrogate = (text: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

describe("검토 지적 1 — 압축 중단 표시는 'CLI 에 실제로 넣은 마지막 압축'으로 판단한다", () => {
  test("끊은 뒤 새 압축을 예약했지만 입력칸 글 때문에 넣지 못하고 닫혀도, 다음 봉투 맨 앞에 그 한 줄을 싣는다", async () => {
    const t = await setup({ timings: { inputBusyRetryMs: 20, inputBusyLimitMs: 300, retryMs: 30 } });
    const { m } = await interruptedCompact(t, () => "/compact 내가 쓴 다른 요약 지시");
    const noted = (stopNote(t, m.id) as { compactionId?: string } | undefined)?.compactionId;
    expect(noted).toBeTruthy();
    await t.orch.memberCompact(m.id);
    await t.waitFor("새 압축이 넣지 못하고 닫힘", () => { const c = t.store.getContextState(m.id)?.compaction; return !!c && c.id !== noted && c.phase === "failed"; });
    // 실행기가 넣은 마지막 압축은 여전히 끊긴 그 압축이고, 표시도 남아 있다.
    expect((t.store.getContextState(m.id)?.baseline?.coreCompact as CoreCompactState | undefined)?.id).toBe(noted);
    expect(stopNote(t, m.id)).toMatchObject({ compactionId: noted });
    t.core.setDraft(m.id, "");
    await t.orch.assign(t.project.id, m.handle, { text: "기다리던 일 @fake:post=끝" });
    const first = await t.waitFor("전달", () => promptsWith(t, m.id, "기다리던 일")[0]);
    expect(startsWithNotice(first.prompt)).toBe(true);
    expect(noticeTurns(t, m.id)).toHaveLength(1);
  }, 30_000);
});

describe("검토 지적 2 — 설정 변경으로 같은 Claude 세션을 이어 열어도 표시가 남는다", () => {
  /** 중단 뒤 쉬는 팀장에게 설정 변경을 건다. 중단 뒤의 펌프가 끝나기 전이면(cli_switch_busy) 조금 뒤 다시 한다. */
  async function whenIdle<T>(t: CoreEnv, id: string, act: () => Promise<T>): Promise<T> {
    await t.waitFor("중단 뒤 쉼", () => !t.runner.isBusy(id) && t.member(id).status === "idle");
    for (let i = 0; ; i++) {
      try { return await act(); }
      catch (e) { if (i >= 100 || !(e instanceof ApiError) || e.code !== "cli_switch_busy") throw e; await Bun.sleep(20); }
    }
  }
  test("effort 를 바꿔 같은 세션을 --resume 으로 이어 열면(세대가 바뀜) 표시를 새 세대로 옮겨 첫 봉투 맨 앞에 싣는다", async () => {
    const t = await setup();
    const { m } = await interruptedCompact(t, () => null);
    const before = { session: m.sessionId, generation: t.store.memberRevisions(m.id).sessionGeneration };
    await whenIdle(t, m.id, () => t.orch.patchMemberConfig(m.id, { effortOverride: "low" }));
    await t.waitFor("다시 쉼", () => !t.runner.isBusy(m.id) && t.member(m.id).status === "idle");
    expect(t.store.memberRevisions(m.id).sessionGeneration).toBe(before.generation + 1);
    expect(t.member(m.id).sessionId).toBe(before.session);
    expect(t.runs(m.id).at(-1)?.resumeFlag).toBe(before.session);
    expect(stopNote(t, m.id)).toMatchObject({ sessionId: before.session });
    await t.orch.assign(t.project.id, m.handle, { text: "기다리던 일 @fake:post=끝" });
    const first = await t.waitFor("전달", () => promptsWith(t, m.id, "기다리던 일")[0]);
    expect(startsWithNotice(first.prompt)).toBe(true);
    // 설정 변경의 인계 글(깨우지 않는 시스템 글)보다도 앞이다.
    expect(first.prompt.indexOf("같은 세션을 새 설정으로 이어 열었습니다")).toBeGreaterThan(first.prompt.indexOf(COMPACT_STOP_NOTICE));
    expect(noticeTurns(t, m.id)).toHaveLength(1);
  }, 30_000);

  test("새 세션으로 열면 표시를 옮기지 않고, 이미 대기열에 든 그 한 줄도 거둔다", async () => {
    const t = await setup();
    const { m } = await interruptedCompact(t, () => null);
    // 앞 봉투가 거절돼 대기열에 남은 그 한 줄(실제로는 takeCompactStopNotice 가 만든다).
    const queued = t.store.enqueue({ projectId: m.projectId, memberId: m.id, kind: "system", text: COMPACT_STOP_NOTICE, wake: false });
    await whenIdle(t, m.id, () => t.orch.freshMemberSession(m.id));
    await t.waitFor("다시 쉼", () => !t.runner.isBusy(m.id) && t.member(m.id).status === "idle");
    expect(t.runs(m.id).at(-1)?.resumeFlag).toBeNull();
    expect(stopNote(t, m.id)).toBeUndefined();
    expect(t.store.requireDelivery(queued.id).status).toBe("failed");
    await t.orch.assign(t.project.id, m.handle, { text: "새 세션의 일 @fake:post=끝" });
    const first = await t.waitFor("전달", () => promptsWith(t, m.id, "새 세션의 일")[0]);
    expect(first.prompt).not.toContain(COMPACT_STOP_NOTICE);
  }, 30_000);
});

describe("검토 지적 4 — 압축 명령·초점 글은 코드 포인트 경계에서 자른다", () => {
  test("Claude 압축 명령: 잘리는 자리에 이모지가 걸려도 반쪽 글자를 남기지 않는다", () => {
    for (const text of ["a".repeat(389) + "😀".repeat(50), "가".repeat(380) + " " + "😀".repeat(40), ("😀 ".repeat(200)), "가나 ".repeat(129) + "😀😀😀"]) {
      const command = claudeCompactCommand(text);
      expect(command.length).toBeLessThanOrEqual(CLAUDE_COMPACT_COMMAND_MAX);
      expect(loneSurrogate(command)).toBe(false);
    }
  });

  test("초점 글: 지금 일·다음 일·질문 제목·대기열 앞부분·일 항목을 자르는 자리에 이모지가 걸려도 반쪽 글자를 남기지 않는다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    // 자르는 자리(지금 일 159, 다음 일 99, 질문 59, 대기열 80, 일 항목 40 단위)에 두 단위 글자의 앞쪽이 걸리게 한다.
    t.store.patchMember(lead.id, { now: "가".repeat(158) + "😀".repeat(5), next: "나".repeat(98) + "😀".repeat(5) });
    t.store.createDecision({ projectId: t.project.id, memberId: lead.id, who: t.member(lead.id).name, title: "다".repeat(58) + "😀".repeat(5), options: [{ k: "a", label: "예" }, { k: "b", label: "아니오" }] });
    t.store.enqueue({ projectId: t.project.id, memberId: lead.id, kind: "system", text: "라".repeat(79) + "😀".repeat(5), wake: false });
    t.store.upsertWork({ projectId: t.project.id, sec: "doing", title: "마".repeat(39) + "😀".repeat(5) });
    const focus = (t.orch as unknown as { compactFocus(member: Member): string }).compactFocus(t.member(lead.id));
    expect(focus).toContain(`${"가".repeat(158)}…`);
    expect(focus).toContain(`${"나".repeat(98)}…`);
    expect(focus).toContain(`${"다".repeat(58)}…`);
    expect(focus).toContain("라".repeat(79));
    expect(focus).toContain("마".repeat(39));
    expect(loneSurrogate(focus)).toBe(false);
    expect(loneSurrogate(claudeCompactCommand(focus))).toBe(false);
  }, 30_000);
});

describe("검토 지적 5 — Codex 팀장에는 압축 중단 표시를 적지도 꺼내지도 않는다", () => {
  test("Codex 팀장의 압축을 '중단'으로 닫아도 표시를 적지 않고, 표시가 있어도 그 한 줄을 만들지 않는다", async () => {
    const t = await setup();
    const m = await t.orch.createMember(t.project.id, { name: "서버 점검", cli: "codex" });
    t.store.patchMember(m.id, { sessionId: "codex-session" });
    const at = new Date().toISOString();
    const state = t.store.ensureContextState(m.id);
    t.store.saveContextState({ ...state,
      compaction: { id: "c1", trigger: "manual", phase: "failed", reason: "interrupted", requestedAt: at, startedAt: at, finishedAt: at },
      baseline: { ...state.baseline, coreCompact: { id: "c1", phase: "failed", startedAt: Date.now(), cursor: null, command: "/compact",
        baseline: { path: "/nowhere", fileIdentity: "x", offset: 0, sessionId: "codex-session", terminalId: t.member(m.id).paneId, generation: state.generation, turn: null, model: null } } } });
    const orch = t.orch as unknown as { noteCompactStop(member: Member, before: unknown, inFlight: boolean): void; takeCompactStopNotice(memberId: string): void };
    orch.noteCompactStop(t.member(m.id), { id: "c1", trigger: "manual", phase: "running", reason: null, requestedAt: at, startedAt: at, finishedAt: null }, true);
    expect(stopNote(t, m.id)).toBeUndefined();
    const current = t.store.getContextState(m.id)!;
    t.store.saveContextState({ ...current, baseline: { ...current.baseline, compactStopNotice: { compactionId: "c1", sessionId: "codex-session" } } });
    orch.takeCompactStopNotice(m.id);
    expect(t.store.listDeliveries(t.project.id).filter(d => d.memberId === m.id && d.text === COMPACT_STOP_NOTICE)).toHaveLength(0);
  }, 30_000);
});

describe("검토 지적 6 — 압축 글 상태 줄은 할 일이 없어지면 지운다", () => {
  test("그 글 때문에 기다리던 전달이 없어지면(총괄이 거둠) CLI 가 쉬는 중이어도 상태 줄을 지운다", async () => {
    const t = await setup({ timings: { inputBusyRetryMs: 20, healthMs: 40 } });
    const lead = await t.orch.ensureConductor(t.project.id);
    const { m } = await interruptedCompact(t, () => "/compact 내가 쓴 다른 요약 지시");
    const assigned = await t.orch.assign(t.project.id, m.handle, { text: "기다리던 일" }, t.member(lead.id));
    await t.waitFor("상태 줄", () => t.member(m.id).lastError === ERROR_CODES.last_error_compact_draft.ko);
    let withdrawn = false;
    for (let i = 0; i < 100 && !withdrawn; i++) {
      try { t.store.withdrawInstruction(assigned.delivery.id, t.member(lead.id)); withdrawn = true; }
      catch (e) { if (!(e instanceof ApiError) || e.code !== "instruction_started") throw e; await Bun.sleep(10); }
    }
    expect(withdrawn).toBe(true);
    await t.waitFor("상태 줄 지움", () => t.member(m.id).lastError === null);
    expect(t.core.terminalOf(m.id)!.status?.state).not.toBe("working");
    expect(promptsWith(t, m.id, "기다리던 일")).toHaveLength(0);
  }, 30_000);

  test("입력칸이 빈 것이 보이면 전달이 들어가기 전에(CLI 가 쉬는 중) 상태 줄을 지운다", async () => {
    // 펌프가 스스로 다시 넣어 보지 않게(재시도 1분) 해, 입력칸이 빈 것을 관측(input_ready)한 길만 남긴다.
    const t = await setup({ timings: { inputBusyRetryMs: 60_000 } });
    const { m } = await interruptedCompact(t, () => "/compact 내가 쓴 다른 요약 지시");
    await t.orch.assign(t.project.id, m.handle, { text: "기다리던 일 @fake:post=끝" });
    await t.waitFor("상태 줄", () => t.member(m.id).lastError === ERROR_CODES.last_error_compact_draft.ko);
    let cleared: { delivered: boolean } | null = null;
    const stop = t.bus.subscribe(event => {
      if (cleared || event.type !== "member" || event.member.id !== m.id || event.member.lastError !== null) return;
      cleared = { delivered: promptsWith(t, m.id, "기다리던 일").length > 0 };
    });
    try {
      t.core.setDraft(m.id, "");
      await t.waitFor("상태 줄 지움", () => cleared);
      expect(cleared!).toEqual({ delivered: false });
      await t.waitFor("전달", () => promptsWith(t, m.id, "기다리던 일")[0]);
    } finally { stop(); }
  }, 30_000);
});

describe("새 문제(real-cli-3 곁) — Claude 가 압축을 'Not enough messages to compact.' 로 끝내면", () => {
  const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "cli", "claude", "2.1.323", "transcript-compact-nothing.jsonl"), "utf8");
  /** 가짜 core 가 압축 명령을 받으면 실측 견본의 세 줄(세션·폴더만 이 팀장 것으로)을 세션 기록에 적고 곧 쉰다. stdout: 바꿔 적을 출력 줄. */
  function nothingOnCompact(t: CoreEnv, m: Member, stdout?: string) {
    t.core.intercept((call: FakeCoreCall) => {
      const terminal = t.core.terminalOf(m.id)!;
      if (call.params.terminal !== terminal.address || call.method !== "terminal.send" || !String(call.params.text).startsWith("/compact")) return undefined;
      const session = t.member(m.id).sessionId!;
      const lines = FIXTURE.trim().split("\n").map(line => {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (stdout && entry.subtype === "local_command") entry.content = stdout;
        return JSON.stringify({ ...entry, sessionId: session, session_id: session, cwd: terminal.cwd, timestamp: new Date().toISOString() });
      });
      const turn = terminal.turn ?? 0;
      terminal.status = { state: "working" };
      setTimeout(() => {
        appendFileSync(transcriptPath(terminal.cwd, session, join(t.home, "claude-home")), lines.join("\n") + "\n");
        terminal.status = { state: "done" }; terminal.turn = turn + 1;
      }, 30);
      return { result: { turn, started: true } };
    });
  }

  test("곧바로 '할 것 없음'으로 닫고(막힘·푸시 없음, 압축 중단 표시 없음) 활동에 짧은 한 줄, 기다리던 전달을 잇는다", async () => {
    const t = await setup();
    const m = await t.orch.createMember(t.project.id, { name: "자료 정리" });
    await t.orch.assign(t.project.id, m.handle, { text: "첫 일 @fake:post=첫일끝" });
    await t.idle(m.id);
    await t.waitFor("세션 기록", () => !!t.member(m.id).sessionId);
    nothingOnCompact(t, t.member(m.id));
    await t.orch.memberCompact(m.id);
    // 압축이 도는 동안 온 일은 그 뒤에 선다.
    await t.orch.assign(t.project.id, m.handle, { text: "기다리던 일 @fake:post=끝" });
    await t.waitFor("할 것 없음으로 닫힘", () => (t.store.getContextState(m.id)?.baseline?.coreCompact as CoreCompactState | undefined)?.reason === "nothing_to_compact", 5000);
    const state = t.store.getContextState(m.id)!;
    // 문맥 상태(앱이 읽는 칸)도 failed/nothing_to_compact(지휘자 결정). 0.2.7 앱은 팀장 상세에 줄을 보이지 않는다.
    expect(state.compaction).toMatchObject({ phase: "failed", reason: "nothing_to_compact" });
    expect(state.baseline?.compactStopNotice).toBeUndefined();
    const first = await t.waitFor("기다리던 일", () => promptsWith(t, m.id, "기다리던 일")[0]);
    // 압축 턴을 정리하고 기다리던 일을 넣은 뒤에도 그 까닭이 다른 값(provider_error 등)으로 덮이지 않는다.
    await t.idle(m.id);
    expect(t.store.getContextState(m.id)?.compaction).toMatchObject({ phase: "failed", reason: "nothing_to_compact" });
    expect(t.member(m.id).contextState?.compaction).toMatchObject({ phase: "failed", reason: "nothing_to_compact" });
    expect(first.prompt).not.toContain(COMPACT_STOP_NOTICE);
    await t.waitFor("활동 줄", () => codes(t, m.id).includes("activity.compact_nothing"));
    expect(codes(t, m.id).filter(code => code === "activity.compact_nothing")).toHaveLength(1);
    expect(codes(t, m.id)).not.toContain("activity.compact_failed");
    expect(codes(t, m.id)).not.toContain("activity.compact_done");
    expect(codes(t, m.id)).not.toContain("activity.compact_unconfirmed");
    expect(t.texts().some(msg => msg.id.startsWith("msg_compact_unconfirmed_"))).toBe(false);
  }, 30_000);

  test("다른 출력(글자가 다름)이면 지금처럼 경계를 기다린다", async () => {
    const t = await setup();
    const m = await t.orch.createMember(t.project.id, { name: "자료 정리" });
    await t.orch.assign(t.project.id, m.handle, { text: "첫 일 @fake:post=첫일끝" });
    await t.idle(m.id);
    await t.waitFor("세션 기록", () => !!t.member(m.id).sessionId);
    nothingOnCompact(t, t.member(m.id), "<local-command-stdout>Error: compaction failed for another reason.</local-command-stdout>");
    await t.orch.memberCompact(m.id);
    await t.waitFor("CLI 가 쉼", () => t.runner.observationState(m.id)?.state === "done" && t.store.getContextState(m.id)?.compaction?.phase === "running");
    for (let i = 0; i < 10; i++) { await t.orch.pump(m.id); await Bun.sleep(30); }
    expect(t.store.getContextState(m.id)?.compaction?.phase).toBe("running");
    expect(codes(t, m.id)).not.toContain("activity.compact_nothing");
  }, 30_000);
});
