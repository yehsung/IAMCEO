// 시험용 core 틀(tests/fixtures/core-harness.ts)이 실제로 되는지의 증명.
// tests/orchestrator.test.ts 의 대표 시험을 운영과 같은 실행기 종류(core)로 옮긴 것이다.
// 옛 시험과 달라진 단정에는 까닭을 적었다: 달라진 쪽이 운영 경로의 실제 동작이다.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bootstrap, DecisionOption, Member, SyncSnapshot } from "../shared/types.ts";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import { coreSetup, isReportNudge, type CoreEnv, type CoreSetupOptions } from "./fixtures/core-harness.ts";

// orchestrator.test.ts 와 같은 최소 도구: HTTP → Orchestrator 경로만 재현한다.
const TOOLS: AgentToolsImpl = {
  listAgentTools: () => [],
  async handleAgentTool(orch, member, name, args) {
    if (name === "post") {
      const message = await orch.recordPost(member, args as unknown as PostInput);
      return { text: `보고함 ${message.id}` };
    }
    if (name === "ask") {
      const r = await orch.registerAsk(member, args as { title: string; detail?: string; options?: DecisionOption[] });
      return { text: r.text };
    }
    return { text: "모르는 도구", isError: true };
  },
};

const open: CoreEnv[] = [];
afterAll(async () => { await Promise.all(open.map(t => t.close())); });
async function setup(opts: CoreSetupOptions = {}) {
  const t = await coreSetup({ agentTools: TOOLS, ...opts });
  open.push(t);
  return t;
}
async function worker(t: CoreEnv, name = "철수", handle = "chulsu") {
  return (await t.orch.addMember(t.project.id, { name, handle, role: "개발" })).member;
}
const conductor = (t: CoreEnv): Promise<Member> => t.orch.ensureConductor(t.project.id);

describe("실행기 종류", () => {
  test("운영과 같은 core 로 보고되고 직원은 core 터미널을 받는다", async () => {
    const t = await setup();
    expect(t.runner.kind).toBe("core");
    const w = await worker(t);
    expect(t.member(w.id)).toMatchObject({ backend: "core", status: "idle" });
    expect(t.member(w.id).paneId).toBe(t.core.terminalOf(w.id)!.address);
    expect(t.store.getSettings().backend).toBe("core");
  });
});

describe("턴 왕복", () => {
  // 옛 시험: "대표 메시지 → 총괄 자동 기동 → 첫 턴 --session-id → 최종 글 게시 → 둘째 턴 --resume"
  test("대표 메시지 → 총괄 자동 기동 → --session-id 로 띄운 터미널에 첫 턴 → 둘째 턴은 같은 터미널에", async () => {
    const t = await setup();
    const sent = await t.orch.sendUserMessage(t.project.id, { id: "msgclient1", text: "안녕 @fake:post=첫답변" });
    const lead = t.store.getConductor(t.project.id)!;
    expect(lead.kind).toBe("conductor");
    expect(sent.delivery).toBe("queued");
    await t.waitFor("원문 전달", () => t.store.requireMessage(sent.id).delivery === "delivered");
    await t.idle(lead.id);

    const first = t.turns()[0]!;
    expect(first.prompt).toMatch(/^\[대표\] "안녕 @fake:post=첫답변"\n#msgclient1\n#iamceo_[A-Za-z0-9_-]{22}\n#iamceo_b_[A-Za-z0-9_-]{22}$/);
    expect(first.run.sessionFlag).toBe(t.member(lead.id).sessionId);
    expect(first.run.resumeFlag).toBeNull();
    // 달라진 점: core 는 턴의 마지막 글을 서버에 넘기지 않는다(turn_end 의 finalText 가 늘 빈 글).
    // 그래서 '답변' 글이 저절로 생기지 않고, 총괄이 post 도구로 올린 글만 대화에 남는다.
    expect(t.texts().some(m => m.kind === "답변")).toBe(false);
    expect(t.texts().find(m => m.title === "첫답변")).toMatchObject({ kind: "완료", memberId: lead.id, who: lead.name, mine: false });
    expect(t.member(lead.id).status).toBe("idle");
    // 가짜 CLI 의 기본 사용량 1000 토큰 / 창 200000 → 1%.
    expect(t.member(lead.id).contextPct).toBe(1);

    await t.orch.sendUserMessage(t.project.id, { text: "다음 @fake:post=둘째답변" });
    await t.waitFor("둘째 답", () => t.texts().some(m => m.title === "둘째답변"));
    // 달라진 점: headless 는 턴마다 CLI 를 새로 띄워 둘째 턴이 --resume 이었다. core 는 띄운 터미널이 살아 있어
    // 둘째 턴도 같은 터미널에 들어간다. 새로 띄우지 않으므로 --resume 도 없다.
    expect(t.runs(lead.id)).toHaveLength(1);
    expect(t.turns(lead.id)).toHaveLength(2);
    expect(t.turns(lead.id)[1]!.terminal).toBe(first.terminal);
  });

  test("@직원 직접: [대표 직접] + 총괄에게 wake=false 사실 알림 → 보고에 (직접)", async () => {
    const t = await setup();
    const lead = await conductor(t);
    const w = await worker(t);
    await t.orch.sendUserMessage(t.project.id, { text: "직접 해 @fake:post=했습니다", targetMemberId: w.id });
    await t.waitFor("철수 턴", () => t.turns(w.id).some(c => c.prompt.startsWith("[대표 직접]")));
    await t.waitFor("보고 받은 총괄 턴", () => t.turns(lead.id).some(c => c.prompt.includes("[보고 철수] (직접) 완료: 했습니다")));
    const leadTurn = t.turns(lead.id).find(c => c.prompt.includes("[보고 철수]"))!;
    // wake=false 알림이 깨우는 보고 앞에 묶인다.
    expect(leadTurn.prompt.indexOf("[시스템] 대표가 철수에게 직접 지시했습니다")).toBeLessThan(leadTurn.prompt.indexOf("[보고 철수]"));
    await t.idle(lead.id);
    // 알림만으로 총괄을 깨우지 않았다: 총괄 턴은 보고 때문의 한 번뿐.
    expect(t.turns().filter(c => c.prompt.includes("대표가 철수에게")).length).toBe(1);
  });
});

describe("턴 종료 처리", () => {
  test("post 한 직원은 대화에 그 글만, 총괄에게 wake=true 보고", async () => {
    const t = await setup();
    const lead = await conductor(t);
    const w = await worker(t);
    await t.orch.assign(t.project.id, w.handle, { text: "@fake:post=끝냄 @fake:text=턴마지막글" });
    await t.waitFor("총괄에게 보고", () => t.turns(lead.id).some(c => c.prompt.startsWith("[보고 철수] 완료: 끝냄")));
    const texts = t.texts();
    expect(texts.some(m => m.title === "끝냄" && m.kind === "완료" && m.memberId === w.id)).toBe(true);
    expect(texts.some(m => m.body === "턴마지막글")).toBe(false);
    // 가짜 CLI 가 부른 도구와 서버의 답이 턴 기록에 남는다.
    expect(t.turns(w.id)[0]!.tools).toMatchObject([{ name: "post", status: 200 }]);
  });

  // 옛 시험: "post 안 부른 직원: (자동) 표시로 대화에 남기고 총괄에게 보고"
  test("post 안 부른 직원: 보고 보완을 한 번 요청하고, 그래도 없으면 '결과 보고 누락'을 남긴다", async () => {
    const t = await setup();
    const lead = await conductor(t);
    const w = await worker(t);
    await t.orch.assign(t.project.id, w.handle, { text: "@fake:text=알아서끝냄" });
    // 달라진 점: headless 는 턴의 마지막 글을 받아 '(자동) 알림'으로 올리고 총괄에게 보고했다.
    // core 는 마지막 글을 받지 못한다. 대신 보고 없이 끝난 실행에 '보고 보완'을 한 번 요청한다.
    await t.waitFor("보고 보완 턴", () => t.turns(w.id).length === 2);
    expect(t.turns(w.id)[1]!.prompt).toStartWith("[시스템] 보고 보완: 실행 ");
    expect(isReportNudge(t.turns(w.id)[1]!)).toBe(true);
    expect(t.workTurns(w.id)).toHaveLength(1);
    // 보완 턴도 보고 없이 끝나면 다시 묻지 않고 대표가 볼 글을 남긴다.
    await t.waitFor("누락 글", () => t.texts().some(m => m.kind === "시스템" && m.title === "결과 보고 누락"));
    await t.idle(w.id);
    expect(t.turns(w.id)).toHaveLength(2);
    expect(t.texts().some(m => m.body === "알아서끝냄")).toBe(false);
    expect(t.turns(lead.id).some(c => c.prompt.includes("(자동) 알림"))).toBe(false);
  });

  test("오류: lastError·status=error·시스템 글·총괄에게 막힘, 다음 턴이 되살린다", async () => {
    const t = await setup();
    const lead = await conductor(t);
    const w = await worker(t);
    await t.orch.assign(t.project.id, w.handle, { text: "@fake:error=도구실패" });
    await t.waitFor("오류 상태", () => t.member(w.id).status === "error");
    expect(t.member(w.id).lastError).toBe("도구실패");
    expect(t.texts().some(m => m.kind === "시스템" && m.body.includes("도구실패"))).toBe(true);
    await t.waitFor("총괄 막힘 보고", () => t.turns(lead.id).some(c => c.prompt.includes("[보고 철수] 막힘: (자동) 턴 오류")));
    await t.orch.assign(t.project.id, w.handle, { text: "다시 @fake:post=고침" });
    await t.waitFor("회복", () => t.member(w.id).status === "idle" && t.member(w.id).lastError === null);
  });

  test("중단: 끊긴 턴은 보고로 치지 않고 대기열은 이어 간다", async () => {
    const t = await setup();
    const w = await worker(t);
    await t.orch.assign(t.project.id, w.handle, { text: "@fake:hang @fake:text=끊길글" });
    await t.waitFor("일하는 중", () => t.member(w.id).status === "working");
    const queued = await t.orch.assign(t.project.id, w.handle, { text: "다음 일 @fake:post=다음일끝" });
    expect(queued.position).toBe(1);
    await t.orch.memberInterrupt(w.id);
    await t.waitFor("다음 일 전달", () => t.turns(w.id).some(c => c.prompt.includes("다음 일")));
    await t.idle(w.id);
    expect(t.turns(w.id)[0]!.outcome).toBe("interrupted");
    expect(t.texts().some(m => m.body === "끊길글")).toBe(false);
    expect(t.member(w.id).lastError).toBeNull();
  });
});

describe("대기열·동시 상한", () => {
  // 옛 시험의 손으로 끝내는 가짜 실행기(send 는 적기만 하고 시험이 turn_end 를 냄) 자리.
  test("@fake:hold 로 잡아 둔 턴은 시험이 놓아 줄 때 끝나고, 그사이 온 지시는 한 글로 묶여 다음 턴에 들어간다", async () => {
    const t = await setup();
    const w = await worker(t);
    await t.orch.assign(t.project.id, w.handle, { text: "먼저 @fake:hold @fake:post=먼저끝" });
    await t.waitFor("잡힘", () => t.core.held(w.id) && t.member(w.id).status === "working");
    const second = await t.orch.assign(t.project.id, w.handle, { text: "둘째 @fake:post=둘째끝" });
    const third = await t.orch.assign(t.project.id, w.handle, { text: "셋째" });
    expect([second.position, third.position]).toEqual([1, 2]);
    await Bun.sleep(60);
    // 일하는 중인 CLI 에는 넣지 않는다.
    expect(t.turns(w.id)).toHaveLength(1);
    expect(t.member(w.id).queuedCount).toBe(2);
    expect(t.core.release(w.id)).toBe(true);
    await t.waitFor("묶음 턴", () => t.turns(w.id).length === 2);
    const bundle = t.turns(w.id)[1]!.prompt;
    expect(bundle.indexOf("둘째")).toBeGreaterThan(-1);
    expect(bundle.indexOf("둘째")).toBeLessThan(bundle.indexOf("셋째"));
    await t.idle(w.id);
    expect(t.member(w.id).queuedCount).toBe(0);
  });


  test("동시 턴 상한을 지키고 전부 끝낸다", async () => {
    const t = await setup();
    t.store.patchSettings({ maxConcurrentTurns: 2 });
    const members = await Promise.all(["a", "b", "c", "d", "e"].map(h => worker(t, `직원${h}`, h)));
    // 달라진 점: core 에서는 보고 없이 끝난 턴에 '보고 보완' 턴이 하나 더 붙는다. 턴 수를 세는 시험이라 직원이 보고하고 끝내게 한다.
    await Promise.all(members.map(m => t.orch.assign(t.project.id, m.handle, { text: "@fake:delay=150 @fake:post=끝" })));
    await t.waitFor("모두 끝", () => t.core.events().filter(c => c.event === "end").length === 5, 15_000);
    let running = 0, peak = 0;
    for (const e of t.core.events()) {
      running += e.event === "start" ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
    await Promise.all(members.map(m => t.idle(m.id)));
    expect(members.every(m => t.member(m.id).queuedCount === 0)).toBe(true);
  });
});

describe("잠재우기·압축·결재", () => {
  // 옛 시험: "잠든 직원에게 깨우는 입력이 오면 자동으로 이어서 연다. wake=false 는 깨우지 않는다"
  test("잠든 직원에게 깨우는 입력이 오면 --resume 으로 새 터미널을 띄워 이어서 연다", async () => {
    const t = await setup();
    const w = await worker(t);
    await t.orch.assign(t.project.id, w.handle, { text: "처음 @fake:post=처음끝" });
    await t.waitFor("첫 턴", () => t.turns(w.id).length === 1);
    await t.idle(w.id);
    const sid = t.member(w.id).sessionId;
    const firstTerminal = t.member(w.id).paneId!;
    await t.orch.memberSleep(w.id);
    expect(t.member(w.id).status).toBe("asleep");
    // 재우면 core 의 터미널이 끝난다(headless 는 턴 사이에 프로세스가 없어 끝낼 것이 없었다).
    expect(t.core.terminals().find(x => x.address === firstTerminal)!.state).toBe("finished");
    t.store.enqueue({ projectId: t.project.id, memberId: w.id, kind: "system", text: "[시스템] 사실", wake: false });
    await t.orch.pump(w.id);
    expect(t.member(w.id).status).toBe("asleep");
    await t.orch.assign(t.project.id, w.handle, { text: "일어나 @fake:post=일어남" });
    await t.waitFor("재개", () => t.turns(w.id).at(-1)!.prompt.includes("일어나"));
    const resumed = t.turns(w.id).at(-1)!;
    expect(resumed.run.resumeFlag).toBe(sid);
    expect(resumed.run.sessionFlag).toBeNull();
    expect(resumed.terminal).not.toBe(firstTerminal);
    expect(resumed.prompt.startsWith("[시스템] 사실")).toBe(true);
    await t.idle(w.id);
    expect(t.member(w.id).status).toBe("idle");
    expect(t.runs(w.id)).toHaveLength(2);
  });

  // 옛 시험: "문맥이 상한을 넘으면 먼저 압축하고 compacted 뒤에 전달한다"
  test("문맥이 상한을 넘으면 먼저 /compact 를 넣고, 세션 기록의 압축 경계를 본 뒤에 전달한다", async () => {
    const t = await setup();
    t.store.patchSettings({ compactAtPct: 70 });
    const w = await worker(t);
    await t.orch.assign(t.project.id, w.handle, { text: "@fake:usage=150000 @fake:post=많이씀" });
    await t.waitFor("문맥 75%", () => t.member(w.id).contextPct === 75);
    await t.idle(w.id);

    t.store.patchMember(w.id, { now: "시험 고치기", next: "배포" });
    const d = await t.orch.assign(t.project.id, w.handle, { text: "다음 일 @fake:post=다음끝" });
    const compact = await t.waitFor("압축 턴", () => t.turns(w.id).find(c => c.prompt.startsWith("/compact")));
    expect(compact.prompt.startsWith("/compact 이어갈 일: 시험 고치기 · 배포")).toBe(true);
    // /compact 글에도 대기열 앞부분으로 "다음 일"이 들어 있다. 압축 턴이 아닌 전달 턴을 기다린다(압축 턴에서 먼저 참이 되어 가끔 실패했다).
    await t.waitFor("압축 뒤 전달", () => { const last = t.turns(w.id).at(-1)!; return !last.prompt.startsWith("/compact") && last.prompt.includes("다음 일"); });
    await t.idle(w.id);
    expect(t.turns(w.id).filter(c => c.prompt.startsWith("/compact")).length).toBe(1);
    expect(t.store.requireDelivery(d.delivery.id).status).toBe("delivered");
    expect(t.turns(w.id).map(c => c.prompt.slice(0, 8))).toEqual([expect.stringContaining("[총괄]"), "/compact", expect.stringContaining("[총괄]")]);
  });

  // 옛 시험: "실행기 멤버: 즉시 반환 → waiting → 답하면 [대표 답(원문)] → delivered·working"
  test("ask: 결재를 올리면 waiting, 대표가 답하면 답이 같은 터미널의 다음 턴으로 들어간다", async () => {
    const t = await setup();
    const w = await worker(t);
    await t.orch.assign(t.project.id, w.handle, { text: "물어봐 @fake:ask=진행할까요" });
    const decision = await t.waitFor("결재", () => t.store.listOpenDecisionsByMember(w.id)[0]);
    await t.waitFor("내 답 기다림", () => t.member(w.id).status === "waiting");
    // 열린 결재는 보고로 친다: 보고 보완 턴이 붙지 않는다.
    expect(t.turns(w.id)).toHaveLength(1);
    await t.orch.answerDecision(decision.id, { choice: "a" });
    const answer = await t.waitFor("답 턴", () => t.turns(w.id).find(c => c.prompt.includes("[대표 답")));
    expect(answer.prompt).toContain("그렇게 하세요");
    expect(answer.terminal).toBe(t.turns(w.id)[0]!.terminal);
  });
});

describe("틀의 손잡이", () => {
  test("onTurn 과 script 로 턴을 짠다: 도구를 여러 번 부르고, 부른 기록이 턴에 남는다", async () => {
    const t = await setup({
      script: [{ when: "규칙대로", tools: [{ name: "post", args: { kind: "완료", title: "규칙 보고" } }], silent: true }],
      onTurn: async ({ prompt, tool, say }) => {
        if (!prompt.includes("두 번 보고")) return;
        await tool("post", { kind: "진행", title: "절반 했습니다" });
        const answer = await tool("post", { kind: "완료", title: "다 했습니다" });
        say(`보고했습니다: ${answer}`);
        return true;
      },
    });
    const w = await worker(t);
    await t.orch.assign(t.project.id, w.handle, { text: "두 번 보고" });
    await t.waitFor("첫 턴 끝", () => t.turns(w.id)[0]?.outcome === "done");
    expect(t.turns(w.id)[0]!.tools.map(c => [c.name, c.args.title, c.status])).toEqual([["post", "절반 했습니다", 200], ["post", "다 했습니다", 200]]);
    expect(t.texts().filter(m => m.memberId === w.id).map(m => [m.kind, m.title])).toEqual([["진행", "절반 했습니다"], ["완료", "다 했습니다"]]);
    // tool() 은 서버가 준 답(JSON 글)을 그대로 돌려준다. 가짜 CLI 의 마지막 글은 화면에 남는다.
    expect(t.core.screenOf(w.id)).toMatch(/⏺ 보고했습니다: \{"text":"보고함 msg_/);
    await t.idle(w.id);
    await t.orch.assign(t.project.id, w.handle, { text: "규칙대로" });
    await t.waitFor("둘째 턴 끝", () => t.turns(w.id)[1]?.outcome === "done");
    expect(t.turns(w.id)[1]!.tools).toMatchObject([{ name: "post", args: { title: "규칙 보고" }, status: 200 }]);
  });

  test("입력칸에 사람이 쓰던 글이 있으면 넣지 않고, 비면 넣는다. 승인 창 앞이면 blocked 로 보인다", async () => {
    const t = await setup({ timings: { inputBusyRetryMs: 30, retryMs: 30 } });
    const w = await worker(t);
    t.core.setDraft(w.id, "사람이 쓰던 글");
    const sent = await t.orch.assign(t.project.id, w.handle, { text: "일 @fake:post=끝" });
    await Bun.sleep(150);
    // 쓰던 글을 지우지 않는다: 가짜 core 는 terminal.send 를 한 번도 받지 않았다.
    expect(t.core.count("terminal.send")).toBe(0);
    expect(t.store.requireDelivery(sent.delivery.id).status).not.toBe("delivered");
    t.core.setDraft(w.id, "");
    await t.waitFor("전달", () => t.turns(w.id).length === 1);
    await t.idle(w.id);
    expect(t.store.requireDelivery(sent.delivery.id).status).toBe("delivered");

    // CLI 가 승인 창 앞이라고 알리면 서버 기록도 blocked 가 된다.
    t.core.setStatus(w.id, { state: "blocked", kind: "permission" });
    await t.waitFor("막힘", () => t.member(w.id).status === "blocked");
    expect(t.member(w.id).blockedReason).toBe("permission");
    t.core.setStatus(w.id, { state: "idle" });
    await t.waitFor("풀림", () => t.member(w.id).status === "idle");
  });
});

describe("herdr 조회 없음", () => {
  // 옛 herdr 실행기를 지운 뒤: 소켓 설정 자체를 읽지 않는다. 환경 변수와 설정 파일 양쪽에 살아 있는 소켓을 적어 두고도 연결이 없음을 본다.
  test("환경·설정 파일에 herdr 소켓이 적혀 있어도 한 번도 연결하지 않고, bootstrap.herdr 는 '쓰지 않음' 고정값으로 내려간다", async () => {
    // 대표 개인 herdr 자리에 실제로 듣고 있는 소켓을 둔다. 연결이 오면 센다.
    const dir = mkdtempSync(join(existsSync("/private/tmp") ? "/private/tmp" : tmpdir(), "ich-h-"));
    const path = join(dir, "herdr.sock");
    let connections = 0;
    const herdr = createServer(socket => { connections++; socket.destroy(); });
    await new Promise<void>(resolve => herdr.listen(path, resolve));
    try {
      const t = await setup({ herdrSocket: path, timings: { tickMs: 15, healthMs: 15 } });
      expect(JSON.parse(readFileSync(t.config.configPath, "utf8")).herdrSocket).toBe(path);
      expect(t.config).not.toHaveProperty("herdrSocket");
      await t.orch.recover(); // 틱과 상태 확인이 돌기 시작한다.
      const w = await worker(t);
      await t.orch.assign(t.project.id, w.handle, { text: "일 @fake:post=끝" });
      await t.waitFor("턴 끝", () => t.turns(w.id).length === 1);
      await t.idle(w.id);
      const unused = { installed: false, running: false, version: null, protocol: null, compatible: false, warning: null };
      // 0.2.2 앱은 이 필드를 풀기만 한다(모든 칸이 없어도 되는 값). 같은 모양·같은 값으로 계속 내려간다.
      const boot = await (await t.api("GET", "/api/bootstrap")).json() as Bootstrap;
      expect(boot.herdr).toEqual(unused);
      const sync = await (await t.api("GET", `/api/sync?projectId=${t.project.id}`)).json() as SyncSnapshot;
      expect(sync.bootstrap.herdr).toEqual(unused);
      // herdr 세션 목록 주소는 없어진 기능이라 410 이다.
      const agents = await t.api("GET", "/api/herdr/agents");
      expect(agents.status).toBe(410);
      expect(((await agents.json()) as { error: string }).error).toContain("herdr 세션 목록은 없어졌습니다");
      await Bun.sleep(150); // 틱 여러 번.
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>(resolve => herdr.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("옛 실행기의 흔적", () => {
  // 편입(herdr 칸 넘겨받기)은 지웠다. 남은 것은 명부 행뿐이다: 가져온 명부나 옛 편입으로 생긴 origin "adopted" 팀장.
  // tests/regress.test.ts 는 가짜 실행기로 "깨우면 서버 세션(origin=runner)이 된다"를 보지만, 실제 CoreRunner 는 그 행의 터미널을 띄우지 않는다.
  // 운영의 실제 동작을 여기에 고정해 둔다(고친 것이 아니라 지금 동작을 적은 것이다).
  test("넘겨받은 명부(origin adopted)의 팀장은 실제 core 실행기로 깨워지지 않는다: 502, 터미널 0건, 명부는 그대로", async () => {
    const t = await setup();
    await conductor(t);
    const m = t.store.createMember({ projectId: t.project.id, handle: "im", name: "가져옴", kind: "worker", origin: "adopted", status: "offline" });
    await expect(t.orch.resumeMember(m.id)).rejects.toMatchObject({ name: "ApiError", status: 502, message: expect.stringContaining("Core does not adopt terminals") });
    expect(t.runs(m.id)).toHaveLength(0);
    expect(t.core.count("terminal.run")).toBe(t.runs().length);
    expect(t.member(m.id)).toMatchObject({ origin: "adopted", status: "offline", paneId: null, sessionId: null });
    // 옛 backend 값과 세션이 함께 남은 행은 띄우려 들지도 않는다(legacy_session).
    const legacy = t.store.createMember({ projectId: t.project.id, handle: "old", name: "옛팀장", kind: "worker", origin: "adopted", backend: "herdr", status: "offline", paneId: "old:p1", sessionId: "11111111-1111-4111-8111-111111111111" });
    await expect(t.orch.resumeMember(legacy.id)).rejects.toMatchObject({ status: 409, message: "이전 실행기의 세션은 자동으로 다시 열지 않습니다" });
    const sent = await t.orch.assign(t.project.id, legacy.handle, { text: "일 @fake:post=끝" });
    await t.waitFor("보류", () => t.store.requireDelivery(sent.delivery.id).status === "held");
    expect(t.store.requireDelivery(sent.delivery.id).holdReason).toBe("legacy_session");
    expect(t.member(legacy.id)).toMatchObject({ backend: "herdr", paneId: "old:p1", sessionId: "11111111-1111-4111-8111-111111111111" });
    expect(t.runs(legacy.id)).toHaveLength(0);
  });
});

describe("재시작", () => {
  test("서버만 다시 떠도 터미널은 core 에 남고, 새 서버가 같은 터미널에 이어서 넣는다", async () => {
    const t = await setup();
    const w = await worker(t);
    await t.orch.assign(t.project.id, w.handle, { text: "첫 일 @fake:post=첫일끝" });
    await t.waitFor("첫 턴", () => t.turns(w.id).length === 1);
    await t.idle(w.id);
    const terminal = t.member(w.id).paneId;

    const next = await t.restart();
    open.push(next);
    await next.orch.recover();
    expect(next.member(w.id)).toMatchObject({ backend: "core", paneId: terminal });
    await next.orch.assign(next.project.id, w.handle, { text: "둘째 일 @fake:post=둘째일끝" });
    await next.waitFor("둘째 턴", () => next.turns(w.id).length === 2);
    // 새로 띄우지 않았다: 같은 터미널에 들어갔다.
    expect(next.runs(w.id)).toHaveLength(1);
    expect(next.turns(w.id)[1]!.terminal).toBe(terminal!);
    await next.idle(w.id);
  });
});
