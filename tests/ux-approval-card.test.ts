import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import type { Member } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const instruction = "[시스템] 보고에 대표 승인이 필요하다고 썼는데 열린 결재 카드가 없다. 지금 ask 로 카드를 올리거나, 필요 없으면 보고를 정정하라.";
const incident = "남은 것: 두 기기 실서버 확인(임시 계정, 승인 뒤) → 출시 전 다시 여쭘";

// 외부 서버·실제 CLI·소켓 없이 기존 보고/보완 펌프까지 확인한다.
class ApprovalRunner implements Runner {
  readonly kind = "core" as const;
  sent: { id: string; text: string }[] = [];
  busy = new Set<string>();
  callback: (event: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(member: RunnerMember) { return { sessionId: member.sessionId!, paneId: member.paneId }; }
  async send(member: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ id: member.id, text }); this.busy.add(member.id);
    return { ok: true, started: true, turn: 0 };
  }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(member: RunnerMember) { this.busy.delete(member.id); }
  async screen() { return ""; }
  async shutdown() {}
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
  end(store: Store, member: Member, turn = 1) {
    this.busy.delete(member.id);
    this.callback({ type: "turn_end", memberId: member.id, terminalId: member.paneId!, sessionGeneration: store.memberRevisions(member.id).sessionGeneration, turn, finalText: "", isError: false });
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => boolean) {
  for (let n = 0; n < 100 && !check(); n++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
function fixture() {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath), store = new Store(db, new Bus()), runner = new ApprovalRunner();
  store.patchSettings({ boardTidyHours: 0 });
  const project = store.createProject({ name: "check", cwd: isolated.paths.work });
  const makeOrch = () => new Orchestrator({ config, store, runners: new Map([["core", runner]]), notifier: () => {}, timings: { tickMs: 60_000, healthMs: 60_000 } });
  let orch = makeOrch(), sequence = 0;
  const member = (kind: Member["kind"] = "worker") => {
    const n = ++sequence;
    return store.createMember({ projectId: project.id, handle: `m${n}`, name: n === 1 ? "게임 추가" : `담당 ${n}`, kind, cwd: project.cwd,
      origin: "runner", backend: "core", status: "idle", sessionId: `session-${n}`, paneId: `pane-${n}` });
  };
  const call = (worker: Member, args: Record<string, unknown>) => orch.handleAgentTool(worker, "post", { kind: "완료", title: "구현 완료", ...args });
  const notices = (worker: Member) => store.listActivity(worker.id).filter(a => a.kind === "system" && a.text === instruction);
  const restart = async () => { await orch.shutdown(); orch = makeOrch(); };
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  return { get orch() { return orch; }, db, store, runner, project, member, call, notices, restart };
}

for (const kind of ["worker", "conductor"] as const) test(`${kind}: 실제 사례는 저장하고 한 줄만 응답하며 같은 operation 재조회로 중복하지 않는다`, async () => {
  const f = fixture(), worker = f.member(kind);
  const args = { kind: "완료", title: "구현 완료", body: incident };
  const context = { operationId: "approval-incident" };
  const result = await f.orch.handleAgentOperation(worker, "post", args, context);
  expect(result.isError).toBeUndefined();
  expect(result.text.split("\n").slice(1)).toEqual([instruction]);
  expect(f.store.listMessages(f.project.id).map(m => m.body)).toEqual([incident]);
  expect(f.notices(worker)).toHaveLength(1);
  expect(f.store.listPending(worker.id)).toEqual([]);
  expect(f.runner.sent).toEqual([]);
  await f.restart();
  expect(await f.orch.handleAgentOperation(worker, "post", args, context)).toEqual(result);
  const message = f.store.listMessages(f.project.id)[0]!;
  expect((await f.orch.handleAgentTool(worker, "post", { report_id: message.id })).text).not.toContain(instruction);
  expect(f.store.listMessages(f.project.id)).toHaveLength(1);
  expect(f.notices(worker)).toHaveLength(1);
});

for (const body of [
  "남은 것: 승인 후 두 기기 검증", "대표 확인이 필요합니다", "대표님 결정 요청", "다음 단계: 대표 확인",
  "출시 전에 여쭙겠습니다", "출시 전 여쭤보겠습니다", "대표가 정해 주시면 반영합니다", "허락을 받아야 합니다", "결재 대기 중입니다",
  "대표의 확인을 기다립니다",
  "승인 창 앞에서 멈췄습니다. 비용 사용은 대표 승인이 필요합니다",
  "승인은 필요 없지만 대표 확인이 필요합니다",
]) test(`미탐 고정: ${body}`, async () => {
  const f = fixture(), worker = f.member();
  expect((await f.call(worker, { body })).text).toContain(instruction);
  expect(f.notices(worker)).toHaveLength(1);
});

for (const body of [
  "운영 반영은 하지 않았습니다", "승인 창 앞", "터미널 승인 후 명령을 실행할 수 있습니다", "CLI 승인 대기 중입니다",
  "대표 승인은 필요 없습니다", "대표 확인이 필요하지 않습니다", "결재가 불필요합니다", "대표 승인을 이미 받았습니다",
  "대표 확인 완료", "대표가 승인해 주셨습니다", "승인 후 반영했습니다", "대표에게 여쭙지 않아도 됩니다",
  "대표 확인 후 반영했습니다", "승인 요청은 하지 않았습니다",
  "결재 기능 구현을 완료했습니다", "승인 요청 로직 테스트 완료", "> 승인 뒤 실행합니다\n인용 자료를 점검했습니다",
  "```text\n대표 확인이 필요합니다\n```\n문구 시험 완료",
]) test(`오탐 고정: ${body}`, async () => {
  const f = fixture(), worker = f.member();
  expect((await f.call(worker, { body })).text).not.toContain(instruction);
  expect(f.notices(worker)).toEqual([]);
});

for (const ref of ["author", "id", "body-id", "title", "group", "linked-group"] as const) test(`열린 결재 연결(${ref})은 지시하지 않는다`, async () => {
  const f = fixture(), worker = f.member(), other = f.member();
  const card = f.store.createDecision({ projectId: f.project.id, memberId: ref === "author" ? worker.id : other.id, who: other.name, title: "두 기기 출시 검증", group: "출시 확인" });
  let decisionId: string | undefined;
  if (ref === "linked-group") {
    const old = f.store.createDecision({ projectId: f.project.id, memberId: other.id, who: other.name, title: "이전 논의", group: card.group });
    f.store.closeDecision(old.id, { kind: "obsolete", reason: "다른 카드로 통합", by: other.name });
    decisionId = old.id;
  }
  const result = await f.call(worker, { body: `${incident}${ref === "body-id" ? ` 카드 #${card.id}` : ref === "title" ? ` 결재: ${card.title}` : ""}`,
    ...(ref === "id" ? { decision_id: card.id } : decisionId ? { decision_id: decisionId } : {}), ...(ref === "group" ? { group: card.group } : {}) });
  expect(result.isError, result.text).toBeUndefined();
  expect(result.text).not.toContain(instruction);
  expect(f.notices(worker)).toEqual([]);
});

test("다른 직원·그룹, 닫힌 카드, 다른 프로젝트 카드는 누락을 숨기지 않는다", async () => {
  const f = fixture(), worker = f.member(), other = f.member();
  f.store.createDecision({ projectId: f.project.id, memberId: other.id, who: other.name, title: "별도 비용", group: "다른 업무" });
  const closed = f.store.createDecision({ projectId: f.project.id, memberId: worker.id, who: worker.name, title: "이전 검증" });
  f.store.closeDecision(closed.id, { kind: "obsolete", reason: "불필요", by: worker.name });
  const foreign = f.store.createProject({ name: "다른 프로젝트", cwd: f.project.cwd });
  const foreignCard = f.store.createDecision({ projectId: foreign.id, who: "외부", title: "두 기기 확인", group: "출시 확인" });
  expect((await f.call(worker, { body: `${incident} #${closed.id} #${foreignCard.id} ${foreignCard.title}`, decision_id: closed.id, group: "출시 확인" })).text).toContain(instruction);
});

test("같은 턴 ask는 열린 카드가 사라져도 인정하고 다음 턴에는 물려주지 않는다", async () => {
  const f = fixture(), worker = f.member();
  await f.orch.assign(f.project.id, worker.handle, { text: "검증 준비" });
  const { decision } = await f.orch.registerAsk(worker, { title: "검증 승인" });
  f.store.closeDecision(decision.id, { kind: "obsolete", reason: "상황 변경", by: worker.name });
  expect((await f.call(worker, { body: incident })).text).not.toContain(instruction);
  f.runner.end(f.store, worker);
  await until(() => f.store.listActivity(worker.id).some(a => a.kind === "turn_end"));
  await f.orch.assign(f.project.id, worker.handle, { text: "다른 결과 정리" });
  expect((await f.call(worker, { body: incident })).text).toContain(instruction);
  expect(f.runner.sent).toHaveLength(2);
});

test("정정·자료·총괄 보고 전달을 보존하고 결재 누락이 업무 재실행을 만들지 않는다", async () => {
  const f = fixture(), worker = f.member(), conductor = f.member("conductor");
  await f.orch.assign(f.project.id, worker.handle, { text: "원 업무" });
  const file = f.store.createFile({ projectId: f.project.id, title: "검증 결과", body: "기존 결과" });
  const first = await f.orch.recordPost(worker, { kind: "완료", title: "완료", body: incident, fileIds: [file.id] });
  expect(first.systemInstruction).toBe(instruction);
  expect(f.store.listDeliveries(f.project.id).filter(d => d.memberId === conductor.id && d.refId === first.id && d.kind === "report")).toHaveLength(1);
  expect(f.orch.reportReferences(f.project.id, first.id).fileIds).toEqual([file.id]);
  const correction = await f.orch.recordPost(worker, { kind: "완료", title: "정정", body: "대표 승인은 필요 없습니다. 기존 결과만 전달합니다", supersedes: first.id });
  expect(correction.systemInstruction).toBeUndefined();
  expect(f.store.requireMessage(first.id).supersededBy).toBe(correction.id);
  f.runner.end(f.store, worker);
  await until(() => f.store.listActivity(worker.id).some(a => a.kind === "turn_end"));
  expect(f.runner.sent.filter(s => s.id === worker.id)).toHaveLength(1);
  expect(f.store.listDeliveries(f.project.id).filter(d => d.text.includes("보고 보완:"))).toEqual([]);
  expect(f.notices(worker)).toHaveLength(1);
});

test("기존 보고 보완 턴의 post에도 한 번 안내하고 추가 실행·보완은 만들지 않는다", async () => {
  const f = fixture(), worker = f.member();
  await f.orch.assign(f.project.id, worker.handle, { text: "원 업무" });
  f.runner.end(f.store, worker);
  await until(() => f.runner.sent.length === 2 && f.store.listActivity(worker.id).filter(a => a.kind === "turn_start").length === 2);
  expect((await f.call(worker, { body: incident })).text).toContain(instruction);
  f.runner.end(f.store, worker, 2);
  await until(() => f.store.listActivity(worker.id).filter(a => a.kind === "turn_end").length === 2);
  expect(f.runner.sent).toHaveLength(2);
  expect(f.store.listPending(worker.id)).toEqual([]);
  expect(f.store.listMissingReportNotices(f.project.id)).toEqual([]);
  expect(f.notices(worker)).toHaveLength(1);
});
