import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { renderRole } from "../server/roles.ts";
import { Store } from "../server/store.ts";
import { CoreError } from "../server/runner/core-client.ts";
import type { Member } from "../shared/types.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

// All execution is in-memory; no HTTP listener, core or herdr connection.
class AckRunner implements Runner {
  readonly kind = "core" as const;
  busy = new Set<string>();
  failStart = false;
  callback: (e: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember) {
    if (this.failStart) throw new CoreError("rejected", "fixture: start rejected");
    return { sessionId: `session-${m.id}`, paneId: `pane-${m.id}` }; }
  async send(m: RunnerMember): Promise<SendResult> { this.busy.add(m.id); return { ok: true, started: true, turn: 0 }; }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: RunnerMember) { this.busy.delete(m.id); }
  async screen() { return ""; }
  async shutdown() {}
  on(callback: (e: RunnerEvent) => void) { this.callback = callback; }
  end(m: Member, turn = 1) {
    this.busy.delete(m.id);
    this.callback({ type: "turn_end", memberId: m.id, terminalId: m.paneId, sessionGeneration: 0, turn, finalText: "", isError: false });
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
function fixture(kind: "conductor" | "root" = "conductor") {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  let db = openDb(config.dbPath);
  let store = new Store(db, new Bus());
  store.patchSettings({ maxConcurrentTurns: 8, boardTidyHours: 0 });
  const project = store.createProject({ name: "배정 확인", cwd: isolated.paths.work });
  const lead = store.createMember({ projectId: project.id, handle: "lead", name: "업무 총괄", kind, origin: "runner", backend: "core", status: "idle", cwd: project.cwd, paneId: "lead-pane", sessionId: "lead-session" });
  const runner = new AckRunner();
  const makeOrch = () => new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000 } });
  let orch = makeOrch();
  let seq = 0;
  const notices = () => store.listMessages(project.id, { limit: 500 }).filter(m => m.id.startsWith("msg_delegation_ack_"));
  const member = () => store.createMember({ projectId: project.id, handle: `w${++seq}`, name: `검토 ${seq}`, kind: "worker", origin: "runner", backend: "core", status: "idle", cwd: project.cwd, paneId: `pane-${seq}`, sessionId: `session-${seq}` });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await orch.handleAgentTool(store.requireMember(lead.id), name, args);
    expect(result.isError, result.text).not.toBe(true);
    return result;
  };
  const start = () => orch.sendUserMessage(project.id, { text: "결제 오류를 검토해 주세요", id: "owner-command" });
  const end = async (turn = 1) => {
    runner.end(store.requireMember(lead.id), turn);
    await until(() => store.listActivity(lead.id).filter(a => a.kind === "turn_end").length >= turn);
  };
  const restart = async () => {
    await orch.shutdown(); db.close();
    db = openDb(config.dbPath); store = new Store(db, new Bus());
    orch = makeOrch(); await orch.recover();
  };
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  return { get orch() { return orch; }, get store() { return store; }, project, lead, runner, member, tool, start, end, restart, notices };
}

for (const kind of ["conductor", "root"] as const) {
  test(`${kind}: post 없이 맡기면 직원별 시스템 줄을 한 번만 남긴다`, async () => {
    const f = fixture(kind); const w = f.member(), other = f.member();
    await f.start();
    if (kind === "root") {
      // 본사는 현재 팀 도구를 노출하지 않는다. 서버의 방어 규칙 자체는 같은 수준으로 검증한다.
      await f.orch.assign(f.project.id, w.handle, { text: "결제 오류 확인\n둘째 줄은 요약하지 않는다" }, f.lead);
      await f.orch.assign(f.project.id, other.handle, { text: "가".repeat(80) }, f.lead);
    } else {
      await f.tool("team_assign", { member: w.handle, text: "결제 오류 확인\n둘째 줄은 요약하지 않는다" });
      await f.tool("team_assign", { member: other.handle, text: "가".repeat(80) });
    }
    expect(f.notices()).toHaveLength(0);
    await f.end();
    expect(f.notices().map(m => m.body)).toEqual([`총괄이 ${w.name}에게 맡겼습니다: 결제 오류 확인`, `총괄이 ${other.name}에게 맡겼습니다: ${"가".repeat(60)}`]);
    expect(f.notices().every(m => m.kind === "시스템" && m.who === "시스템" && m.memberId === null)).toBe(true);
    f.runner.end(f.store.requireMember(f.lead.id));
    await Bun.sleep(10);
    expect(f.notices()).toHaveLength(2);
    await f.restart();
    f.runner.end(f.store.requireMember(f.lead.id));
    await Bun.sleep(10);
    expect(f.notices()).toHaveLength(2);
  });
}

test("대기열 배정은 앞 일 뒤 시작을 표시하고 같은 직원은 한 줄로 합친다", async () => {
  const f = fixture(); const w = f.member();
  await f.start();
  await f.tool("team_assign", { member: w.handle, text: "앞 일" });
  await f.tool("team_assign", { member: w.handle, text: "다음 일" });
  await f.end();
  expect(f.notices().map(m => m.body)).toEqual([`총괄이 ${w.name}에게 맡겼습니다: 다음 일 (앞 일 끝나면 시작)`]);
});

for (const postFirst of [true, false]) {
  test(`실제 post가 ${postFirst ? "배정 전" : "배정 후"} 있으면 재시작 후에도 시스템 줄을 남기지 않는다`, async () => {
    const f = fixture(); const w = f.member();
    await f.start();
    if (postFirst) await f.tool("post", { kind: "진행", title: "알겠습니다. 검토 담당에게 맡기겠습니다" });
    await f.tool("team_assign", { member: w.handle, text: "결제 확인" });
    if (!postFirst) await f.tool("post", { kind: "진행", title: "알겠습니다. 검토 담당에게 맡겼습니다" });
    await f.restart(); await f.end();
    expect(f.notices()).toHaveLength(0);
  });
}

test("직원 보고로 깨어난 턴에 다음 직원에게 맡기면 시스템 줄을 남기지 않는다", async () => {
  const f = fixture(); const w = f.member(), next = f.member();
  await f.orch.recordPost(w, { kind: "완료", title: "검토 완료" });
  await until(() => f.runner.busy.has(f.lead.id));
  await f.tool("team_assign", { member: next.handle, text: "확인된 오류 수정" });
  await f.end(); expect(f.notices()).toHaveLength(0);
});

test("보고 턴에 묶여 온 wake=false 대표 답은 대표가 깨운 턴으로 세지 않는다", async () => {
  const f = fixture(); const w = f.member(), next = f.member();
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: f.lead.id, who: f.lead.name, title: "검토" });
  f.store.answerDecision(decision.id, { note: "진행" });
  f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "answer", text: '[대표 답(원문) \'검토\'] "진행"', wake: false, refType: "decision", refId: decision.id });
  await f.orch.recordPost(w, { kind: "완료", title: "검토 완료" });
  await until(() => f.runner.busy.has(f.lead.id));
  await f.tool("team_assign", { member: next.handle, text: "다음 검토" });
  await f.end(); expect(f.notices()).toHaveLength(0);
});

test("배정 뒤 ask는 post가 아니므로 누락된 배정 확인을 보완한다", async () => {
  const f = fixture(); const w = f.member();
  await f.start(); await f.tool("team_assign", { member: w.handle, text: "결제 검토" });
  await f.tool("ask", { title: "검토 범위", detail: "추가 범위를 선택해 주세요" });
  await f.end(); expect(f.notices()).toHaveLength(1);
});

test("배정 중 서버 재시작 뒤에도 턴 종료 때 한 번만 보완한다", async () => {
  const f = fixture(); const w = f.member();
  await f.start(); await f.tool("team_assign", { member: w.handle, text: "결제 검토" });
  await f.restart();
  expect(f.notices()).toHaveLength(0);
  await f.end(); expect(f.notices()).toHaveLength(1);
  await f.restart(); f.runner.end(f.store.requireMember(f.lead.id));
  await Bun.sleep(10); expect(f.notices()).toHaveLength(1);
});

for (const posted of [false, true]) {
  test(`대표 원문 재전달도 ${posted ? "기존 post" : "기존 시스템 안내"}와 중복되지 않는다`, async () => {
    const f = fixture(); const w = f.member();
    await f.start(); await f.tool("team_assign", { member: w.handle, text: "결제 검토" });
    if (posted) await f.tool("post", { kind: "진행", title: "알겠습니다. 검토를 맡겼습니다" });
    await f.end();
    const expected = posted ? 0 : 1;
    expect(f.notices()).toHaveLength(expected);
    f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "user_message", text: '[대표] "결제 오류를 검토해 주세요"', refType: "message", refId: "owner-command" });
    await f.restart();
    await until(() => f.runner.busy.has(f.lead.id));
    await f.tool("team_assign", { member: w.handle, text: "결제 검토" });
    await f.end(2); expect(f.notices()).toHaveLength(expected);
  });
}

test("서버 부재 중 종료는 execution journal과 새 idle 관측으로도 보완한다", async () => {
  const f = fixture(); const w = f.member();
  await f.start(); await f.tool("team_assign", { member: w.handle, text: "결제 검토" });
  await f.restart();
  f.runner.busy.delete(f.lead.id);
  f.runner.callback({ type: "status", memberId: f.lead.id, terminalId: f.lead.paneId, sessionGeneration: 0, turn: 1, status: "idle" });
  await until(() => f.notices().length === 1);
  f.runner.end(f.store.requireMember(f.lead.id));
  await Bun.sleep(10); expect(f.notices()).toHaveLength(1);
});

test("team_add와 team_resume의 실제 첫 지시도 배정 확인에 포함한다", async () => {
  const f = fixture(); const w = f.member();
  f.store.patchMember(w.id, { status: "asleep" });
  await f.start();
  await f.tool("team_add", { name: "결제 구현", role: "결제", first_instruction: "새 결제 구현" });
  await f.tool("team_resume", { member: w.handle, first_instruction: "이어 검토" });
  await f.end();
  expect(f.notices().map(m => m.body)).toEqual(["총괄이 결제 구현에게 맡겼습니다: 새 결제 구현", `총괄이 ${w.name}에게 맡겼습니다: 이어 검토`]);
});

test("지시 없는 team_add·team_resume와 실패한 배정은 확인 안내를 만들지 않는다", async () => {
  const f = fixture(); const w = f.member();
  f.store.patchMember(w.id, { status: "asleep" });
  await f.start(); await f.tool("team_add", { name: "결제 구현", role: "결제" });
  await f.tool("team_resume", { member: w.handle });
  const failed = await f.orch.handleAgentTool(f.lead, "team_assign", { member: "없는 직원", text: "일" });
  expect(failed.isError).toBe(true);
  await f.end(); expect(f.notices()).toHaveLength(0);
});

test("신규 직원 기동 실패로 취소된 첫 지시는 배정으로 알리지 않는다", async () => {
  const f = fixture(); await f.start(); f.runner.failStart = true;
  const result = await f.orch.handleAgentTool(f.lead, "team_add", { name: "결제 구현", role: "결제", first_instruction: "새 결제 구현" });
  expect(result.isError).toBe(true);
  await f.end(); expect(f.notices()).toHaveLength(0);
});

test("대표 결재 답 턴의 ask_close follow_up도 배정 안내를 남긴다", async () => {
  const f = fixture(); const w = f.member();
  const pending = await f.orch.registerAsk(f.lead, { title: "결제 검토", detail: "어떻게 할까요" });
  await f.orch.answerDecision(pending.decision.id, { note: "검토를 시작하도록 승인합니다" });
  await until(() => f.runner.busy.has(f.lead.id));
  // 대화에서 정해진 별도 카드의 후속 지시를 같은 대표 원문에 연결한다.
  const source = f.store.createMessage({ projectId: f.project.id, mine: true, who: "대표", kind: "나", body: "결제 오류를 검토해 주세요" });
  const other = f.store.createDecision({ projectId: f.project.id, memberId: w.id, who: w.name, title: "중복 질문" });
  await f.tool("ask_close", { id: other.id, kind: "decided", reason: "대표가 정함", user_quote: source.body,
    follow_up: { kind: "instruction", member_id: w.id, text: "결제 오류 검토", source_message_id: source.id } });
  await f.end(); expect(f.notices().map(m => m.body)).toEqual([`총괄이 ${w.name}에게 맡겼습니다: 결제 오류 검토`]);
});

test("역할 렌더: 대표 지시 직후 확인·배정 안내, 예고 금지, 대기 중 침묵을 구분한다", () => {
  const vars = { PROJECT: "P", NAME: "N", ROLE: "R", CONDUCTOR: "C" };
  for (const kind of ["conductor", "root"] as const) {
    const role = renderRole(kind, vars);
    expect(role).toContain("알겠다는 확인과 누구에게 무엇을 맡겼는지 한두 줄로 답한다");
    expect(role).toContain("`follow_up`으로 후속 지시를 보낸 경우도 같다");
    expect(role).toContain('"언제 알려드리겠다" 같은 예고는 쓰지 않는다');
    expect(role).not.toContain("직원에게 위임한 뒤 보고 대기,");
  }
  const conductor = renderRole("conductor", vars);
  expect(conductor).toContain("직원 보고를 기다리는 동안에는 따로 말하지 않는다");
  expect(conductor).toContain("직원 보고를 받아 다음 직원에게 넘기는 턴에는 필요한 소식만");
  expect(renderRole("worker", vars)).toContain("첫 `status` 직후 바로 `post`(진행)로 알겠다는 확인과 무엇을 하겠는지");
});
