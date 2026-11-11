// 시험용 core 틀(tests/fixtures/core-harness.ts)의 자체 시험: 틀의 손잡이(onTurn·script·setDraft·setStatus·restart)와
// 실행기 종류가 운영과 같다는 것, 옛 실행기의 흔적(herdr 소켓·넘겨받은 명부)을 다루는 법을 본다.
// 처음에는 tests/orchestrator.test.ts 의 대표 시험 11건을 core 로 옮겨 본 증명도 함께 있었다. 그 11건은 orchestrator.test.ts 에
// 같거나 더 넓은 단정으로 있어 여기서는 지웠다(턴 왕복·턴 종료 처리·대기열·동시 상한·잠재우기·자동 압축·ask).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bootstrap, DecisionOption, Member, SyncSnapshot } from "../shared/types.ts";
import type { AgentToolsImpl, PostInput } from "../server/orchestrator.ts";
import type { RunnerMember, StartOpts } from "../server/runner/types.ts";
import { coreRpc, type CoreHello } from "../server/runner/core-client.ts";
import { coreSetup, type CoreEnv, type CoreSetupOptions } from "./fixtures/core-harness.ts";

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

describe("엔진이 닿지 않는 두 가지 모양", () => {
  // 둘은 운영에서 다른 갈래를 탄다. 손잡이를 바꿔 쓰면 '했는지 모름'과 '하지 못함'이 뒤바뀐 동작을 고정하게 된다.
  test("setDown 은 요청을 받은 뒤 끊어 결과를 모르는 실패, setRefusing 은 연결이 거절돼 보내지 못한 실패다. 어느 쪽도 터미널은 남는다", async () => {
    const t = await setup();
    const w = await worker(t);
    const hello = () => coreRpc<CoreHello>(t.core.socketPath, "hello", { generation: 1 }, 1000);
    expect((await hello()).generation).toBe(1);

    // 받고 끊음: 요청은 엔진에 닿았다(calls 에 남는다). 보낸 쪽은 됐는지 모른다.
    t.core.setDown(true);
    const received = t.core.count("hello");
    await expect(hello()).rejects.toMatchObject({ name: "CoreError", kind: "closed", uncertain: true, deliveryEffect: "unknown" });
    expect(t.core.count("hello")).toBeGreaterThan(received);
    t.core.setDown(false);
    expect((await hello()).generation).toBe(1);

    // 연결 거절: 소켓이 없다. 요청은 엔진에 닿지 않았고(calls 에 남지 않는다) 보낸 쪽은 보내지 못했음을 안다.
    await t.core.setRefusing(true);
    const before = t.core.calls.length;
    await expect(hello()).rejects.toMatchObject({ name: "CoreError", kind: "down", uncertain: false, deliveryEffect: "not_written", causeCode: "ENOENT" });
    expect(t.core.calls.length).toBe(before);
    expect((await t.runner.available()).ok).toBe(false);
    await t.core.setRefusing(false);
    expect((await hello()).generation).toBe(1);
    expect((await t.runner.available()).ok).toBe(true);

    // 엔진이 돌아오면 같은 터미널이 그대로 있고, 서버는 그 터미널에 이어 넣는다.
    expect(t.core.terminalOf(w.id)).toMatchObject({ address: t.member(w.id).paneId!, state: "live" });
    await t.orch.refreshConnection();
    await t.orch.assign(t.project.id, w.handle, { text: "돌아온 뒤 @fake:post=끝" });
    await t.waitFor("턴", () => t.turns(w.id).some(c => c.prompt.includes("돌아온 뒤") && c.outcome === "done"));
    await t.idle(w.id);
    expect(t.runs(w.id)).toHaveLength(1);
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
      // 틱과 상태 확인은 틀(coreSetup)이 운영 조립처럼 recover() 를 불러 이미 돌고 있다.
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
  // 편입(herdr 칸 넘겨받기)은 지웠다. 남은 것은 명부 행뿐이다: 가져온 명부(iamceo import)나 옛 편입으로 생긴 origin "adopted" 팀장.
  // 실제 CoreRunner 는 넘겨받은 명부(origin adopted)의 터미널을 띄우지 않는다(남의 터미널을 건드리지 않으려는 거절이다).
  // 세션도 터미널도 없는 행은 넘겨받을 것이 없으므로, 총괄이 깨울 때 서버가 띄운 세션(origin runner)으로 바꿔 실행기에 넘긴다.
  test("넘겨받은 명부(origin adopted): 세션·터미널이 없으면 깨울 때 서버가 새 세션을 띄운다. 세션 ID 가 남은 행과 옛 실행기의 행은 그대로 둔다", async () => {
    const t = await setup();
    await conductor(t);
    const m = t.store.createMember({ projectId: t.project.id, handle: "im", name: "가져옴", kind: "worker", origin: "adopted", status: "offline" });
    // 실행기 자체는 넘겨받은 명부를 여전히 거절한다. 바뀐 것은 총괄이 넘기는 값이다.
    await expect(t.runner.start({ ...t.member(m.id), cli: "claude" } as unknown as RunnerMember, {} as StartOpts)).rejects.toMatchObject({ name: "CoreError", kind: "unsupported", message: "Core does not adopt terminals without IAMCEO ownership labels" });
    expect(t.runs(m.id)).toHaveLength(0);

    const woken = await t.orch.resumeMember(m.id);
    expect(woken).toMatchObject({ origin: "runner", status: "idle", backend: "core", lastError: null });
    expect(t.runs(m.id)).toHaveLength(1);
    const run = t.runs(m.id)[0]!;
    expect(run).toMatchObject({ resumeFlag: null, sessionFlag: woken.sessionId, terminal: woken.paneId });
    expect(run.labels).toMatchObject({ "iamceo.member": m.id, "iamceo.project": t.project.id });
    expect(t.core.terminalOf(m.id)).toMatchObject({ address: run.terminal, state: "live" });
    // 도구가 연결됐다는 안내가 쌓이고, 맡긴 일은 그 세션에서 돌아 도구로 보고한다.
    expect(t.store.listPending(m.id).some(d => d.text.includes("iamceo 도구") && !d.wake)).toBe(true);
    await t.orch.assign(t.project.id, m.handle, { text: "가져온 자리의 일 @fake:post=끝" });
    const turn = await t.waitFor("일함", () => t.turns(m.id).find(c => c.prompt.includes("가져온 자리의 일") && c.outcome === "done"));
    expect(turn.run).toBe(run);
    expect(turn.tools).toMatchObject([{ name: "post", status: 200 }]);
    await t.idle(m.id);
    // 이제 서버 세션이다: 재우면 터미널이 끝나고(넘겨받은 터미널은 닫지 않는다), 깨우면 그 세션을 이어 연다.
    await t.orch.sleepMember(m.id);
    expect(t.core.terminalOf(m.id)).toMatchObject({ address: run.terminal, state: "finished" });
    expect(t.member(m.id)).toMatchObject({ status: "asleep", paneId: null, sessionId: run.sessionFlag });
    await t.orch.resumeMember(m.id);
    expect(t.runs(m.id).at(-1)!.resumeFlag).toBe(run.sessionFlag);

    // 일을 맡겨서 깨우는 길도 같다(가져온 프로젝트에서 총괄이 가져온 팀장에게 지시).
    const second = t.store.createMember({ projectId: t.project.id, handle: "im2", name: "가져옴둘", kind: "worker", origin: "adopted", status: "offline" });
    await t.orch.assign(t.project.id, second.handle, { text: "바로 맡긴 일 @fake:post=끝" });
    await t.waitFor("맡긴 일로 깨어남", () => t.turns(second.id).some(c => c.prompt.includes("바로 맡긴 일") && c.outcome === "done"));
    expect(t.member(second.id)).toMatchObject({ origin: "runner", lastError: null });
    expect(t.runs(second.id)).toHaveLength(1);
    expect(t.runs(second.id)[0]!.resumeFlag).toBeNull();

    // 세션 ID 가 남은 넘겨받은 행은 서버 세션으로 바꿔 띄우지 않는다: 대표의 터미널에서 그 세션이 살아 있는지 서버가 확인할 수 없다.
    // (backend 가 비었거나 옛 값이면 아래 legacy 행처럼 깨우기 전에 409 로 막힌다. 여기서는 실행기까지 가는 행으로 거절이 그대로임을 본다.)
    const kept = t.store.createMember({ projectId: t.project.id, handle: "keep", name: "세션남음", kind: "worker", origin: "adopted", backend: "core", status: "offline", sessionId: "33333333-3333-4333-8333-333333333333" });
    await expect(t.orch.resumeMember(kept.id)).rejects.toMatchObject({ name: "ApiError", status: 502, message: expect.stringContaining("Core does not adopt terminals") });
    expect(t.runs(kept.id)).toHaveLength(0);
    expect(t.member(kept.id)).toMatchObject({ origin: "adopted", status: "offline", paneId: null, sessionId: "33333333-3333-4333-8333-333333333333" });
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
    expect(next.member(w.id)).toMatchObject({ backend: "core", paneId: terminal });
    await next.orch.assign(next.project.id, w.handle, { text: "둘째 일 @fake:post=둘째일끝" });
    await next.waitFor("둘째 턴", () => next.turns(w.id).length === 2);
    // 새로 띄우지 않았다: 같은 터미널에 들어갔다.
    expect(next.runs(w.id)).toHaveLength(1);
    expect(next.turns(w.id)[1]!.terminal).toBe(terminal!);
    await next.idle(w.id);
  });
});
