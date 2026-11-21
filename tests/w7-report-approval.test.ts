// 0.2.7 묶음 2: 보고·승인 오판 고치기, 쓸데없는 기록 줄이기.
// - D3-1·D5-3: 진행·알림은 보고 보완 턴과 총괄의 대표 글·결재 답 턴에서만 그 실행의 보고다(직원 원 턴의 확인 글은 아님, 미룬 확인은 닫힌 뒤의 글만).
//   0.2.6 뒤 '결과 보고 누락' 8건의 모양을 가짜 글로 재현한다.
// - D3-3·D5-4: 결재 누락 감지는 지금 대표 승인·결정을 구하는 문장만 건다(조건·나중·부정·인용·남의 카드·이미 받은 결정은 아님). 실제로 걸린 문장 모양의 맞음/틀림 표.
// - D2-5: MCP 도구 호출과 세션 기록 쓰기도 업무의 진전이다. '진전 없음'은 마지막 진전부터 센다.
// - D4-10: APNs 연결이 여러 주소에서 실패해도 MaxListenersExceededWarning 이 나지 않는다.
// 글은 모두 같은 모양의 가짜 글이다(대표의 프로젝트 내용·이름 없음). 진짜 CLI·소켓·라이브 서버는 쓰지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { needsApprovalCard } from "../server/flows/member.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { apnsConnector, boundedLookup, type LookupFunction } from "../server/push/apns.ts";
import { CLAUDE_BACKGROUND_REASON } from "../server/runner/claude-turn.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { textRef } from "../shared/server-text.ts";
import type { Member } from "../shared/types.ts";
import { coreSetup } from "./fixtures/core-harness.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function pollUntil(what: string, check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`시간 초과: ${what}`);
    await Bun.sleep(5);
  }
}

// ---- 메모리 실행기(턴 시작은 보내기, 턴 끝은 end()) ----
class MemoryRunner implements Runner {
  readonly kind = "core" as const;
  sent: { id: string; text: string }[] = [];
  busy = new Set<string>();
  turns = new Map<string, number>();
  callback: (event: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(member: RunnerMember) { return { sessionId: member.sessionId!, paneId: member.paneId }; }
  async send(member: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ id: member.id, text }); this.busy.add(member.id);
    return { ok: true, started: true, turn: this.turns.get(member.id) ?? 0 };
  }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(member: RunnerMember) { this.busy.delete(member.id); }
  async screen() { return ""; }
  async shutdown() {}
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
  end(store: Store, member: Member, reason: string | null = null) {
    const turn = (this.turns.get(member.id) ?? 0) + 1;
    this.turns.set(member.id, turn);
    this.busy.delete(member.id);
    this.callback({ type: "turn_end", memberId: member.id, terminalId: member.paneId!, sessionGeneration: store.memberRevisions(member.id).sessionGeneration, turn, finalText: "", isError: false, reason });
  }
}

function fixture() {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin, IAMCEO_GEMINI_BIN: isolated.bins.geminiBin });
  const db = openDb(config.dbPath), store = new Store(db, new Bus()), runner = new MemoryRunner();
  store.patchSettings({ boardTidyHours: 0 });
  const project = store.createProject({ name: "시험", cwd: isolated.paths.work });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), notifier: () => {}, timings: { tickMs: 60_000, healthMs: 60_000 } });
  let sequence = 0;
  const member = (kind: Member["kind"], name: string) => {
    const n = ++sequence;
    return store.createMember({ projectId: project.id, handle: `m${n}`, name, kind, cwd: project.cwd, origin: "runner", backend: "core", status: "idle", sessionId: `session-${n}`, paneId: `pane-${n}` });
  };
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  const supplements = (who: Member) => store.listDeliveries(project.id).filter(d => d.memberId === who.id && d.text.startsWith("[시스템] 보고 보완:"));
  const missing = () => store.listMessages(project.id).filter(m => m.title === "결과 보고 누락");
  const conductorNotices = (lead: Member) => store.listDeliveries(project.id).filter(d => d.memberId === lead.id && d.text.includes("보완 요청 뒤에도 없습니다"));
  /** 턴을 끝내고 그 실행이 닫힐 때까지 기다린다(실행 ID 로 직접 기다린다: 뒤따르는 보완 턴이 마지막 실행을 차지할 수 있다). */
  const endRun = async (who: Member, reason: string | null = null) => {
    const run = store.listPendingExecutions().find(r => r.memberId === who.id);
    expect(run).toBeDefined();
    runner.end(store, store.requireMember(who.id), reason);
    await pollUntil(`실행 ${run!.runId} 닫힘`, () => store.getExecutionJournal(run!.runId)?.phase === "ended");
    return run!;
  };
  return { store, orch, runner, project, member, supplements, missing, conductorNotices, endRun };
}

describe("D3-1·D5-3 결과 보고: 진행·알림은 보완 턴과 총괄의 대표 글·결재 답 턴에서만 보고다", () => {
  test("총괄이 대표의 상태 질문에 '진행'·'알림'으로 답하고 턴을 끝내면 보고 보완도 '결과 보고 누락'도 없다", async () => {
    for (const kind of ["진행", "알림"] as const) {
      const f = fixture(), lead = f.member("conductor", "시험 총괄");
      await f.orch.sendUserMessage(f.project.id, { text: "조사는 어디까지 왔어?" });
      await pollUntil("총괄 턴", () => f.runner.busy.has(lead.id));
      await f.orch.recordPost(lead, { kind, title: "네, 첫 묶음은 끝났고 남은 칸을 채우는 중입니다" });
      // 보완·누락·총괄 알림은 실행을 닫는 같은 트랜잭션에서 쌓이므로 닫힌 뒤 바로 본다.
      await f.endRun(lead);
      expect(f.supplements(lead)).toEqual([]);
      expect(f.missing()).toEqual([]);
      expect(f.runner.sent).toHaveLength(1);
    }
  });

  test("직원 원 턴의 진행 글(일을 받자마자 쓴 확인 글)은 결과가 아니다: 결과 없이 끝나면 보완을 한 번, 보완 턴에도 없으면 누락과 총괄 알림", async () => {
    // 검토 재현 ①: 총괄 지시를 받은 직원이 첫 도구 호출로 '시작합니다'를 쓰고 완료 없이 끝낸다. core 는 턴 마지막 글을 올리지 않는다.
    const f = fixture(), lead = f.member("conductor", "시험 총괄"), worker = f.member("worker", "시험판 올리기");
    await f.orch.assign(f.project.id, worker.handle, { text: "시험판을 올려 주세요" });
    await f.orch.recordPost(worker, { kind: "진행", title: "시작합니다 — 먼저 바뀌는 곳부터 살핍니다" });
    await f.endRun(worker);
    expect(f.supplements(worker)).toHaveLength(1);
    await pollUntil("보고 보완 턴", () => f.runner.busy.has(worker.id));
    // 보완 턴도 글 없이 끝난다: 원 턴의 확인 글은 보완 턴의 보고가 아니다.
    await f.endRun(worker);
    expect(f.missing()).toHaveLength(1);
    expect(f.conductorNotices(lead)).toHaveLength(1);
  });

  test("대표 직접 지시·결재 답으로 시작한 직원 턴도 진행 글만으로는 보완을 한 번 받는다. 보완 턴의 진행('빌드 중')은 보고라 누락·총괄 알림이 없다", async () => {
    const f = fixture(), lead = f.member("conductor", "시험 총괄"), worker = f.member("worker", "앱 묶기");
    // 대표 직접 지시: 지침대로 첫 status 뒤 진행 글로 확인한다(worker.md).
    await f.orch.sendUserMessage(f.project.id, { text: "새 시험판 묶어 줘", targetMemberId: worker.id });
    await pollUntil("직원 턴", () => f.runner.busy.has(worker.id));
    await f.orch.recordPost(worker, { kind: "진행", title: "알겠습니다. 바뀐 화면부터 묶습니다" });
    await f.endRun(worker);
    expect(f.supplements(worker)).toHaveLength(1);
    await pollUntil("보고 보완 턴", () => f.runner.busy.has(worker.id));
    await f.orch.recordPost(worker, { kind: "진행", title: "바뀐 곳 확인 끝, 지금 묶는 중(아직 끝나지 않음)" });
    await f.endRun(worker);
    // 결재 답으로 시작한 턴: 카드를 올리고 끝낸 뒤(열린 카드가 보고) 답을 받아 '진행: 검토 대기'로 끝낸다.
    await f.orch.assign(f.project.id, worker.handle, { text: "새 배너를 걸어 주세요" });
    const { decision } = await f.orch.registerAsk(worker, { title: "새 배너를 오늘 걸까요?" });
    await f.endRun(worker);
    await f.orch.answerDecision(decision.id, { choice: null, note: "걸어 주세요" });
    await pollUntil("답 턴", () => f.runner.busy.has(worker.id));
    await f.orch.recordPost(worker, { kind: "진행", title: "답 받았습니다, 배너를 겁니다" });
    await f.endRun(worker);
    expect(f.supplements(worker)).toHaveLength(2);
    await pollUntil("두 번째 보완 턴", () => f.runner.busy.has(worker.id));
    await f.orch.recordPost(worker, { kind: "진행", title: "배너를 걸었고 바깥 검토 통과를 기다립니다" });
    await f.endRun(worker);
    expect(f.supplements(worker)).toHaveLength(2);
    expect(f.missing()).toEqual([]);
    expect(f.conductorNotices(lead)).toEqual([]);
  });

  test("글 없이 끝난 턴은 보완을 한 번 요청하고, 보완 턴의 '진행: 대표님 답 대기'를 보고로 받아 누락 경고·총괄 깨움이 없다", async () => {
    const f = fixture(), lead = f.member("conductor", "시험 총괄"), worker = f.member("worker", "기획서");
    await f.orch.assign(f.project.id, worker.handle, { text: "기획서 남은 부분을 써 주세요" });
    await f.endRun(worker);
    await pollUntil("보고 보완 턴", () => f.supplements(worker).length === 1 && f.runner.busy.has(worker.id));
    await f.orch.recordPost(worker, { kind: "진행", title: "정해진 부분은 다 썼고 대표님 생각을 기다리는 중" });
    await f.endRun(worker);
    expect(f.supplements(worker)).toHaveLength(1);
    expect(f.missing()).toEqual([]);
    expect(f.conductorNotices(lead)).toEqual([]);
  });

  test("보완 턴에도 글이 없으면 지금처럼 '결과 보고 누락' 한 번과 총괄 알림 한 번", async () => {
    const f = fixture(), lead = f.member("conductor", "시험 총괄"), worker = f.member("worker", "정리");
    await f.orch.assign(f.project.id, worker.handle, { text: "정리해 주세요" });
    await f.endRun(worker);
    await pollUntil("보고 보완 턴", () => f.supplements(worker).length === 1 && f.runner.busy.has(worker.id));
    await f.endRun(worker);
    await pollUntil("누락 글", () => f.missing().length === 1);
    expect(f.conductorNotices(lead)).toHaveLength(1);
  });

  test("서버가 그 팀장 이름으로 남긴 글(대표 전달 지연 막힘)은 그 팀장의 보고가 아니다", async () => {
    const f = fixture(); f.member("conductor", "시험 총괄"); const worker = f.member("worker", "조사");
    await f.orch.assign(f.project.id, worker.handle, { text: "조사해 주세요" });
    f.store.createMessage({ projectId: f.project.id, memberId: worker.id, who: "시스템", kind: "막힘", text: textRef("chat.owner_message_late", { name: worker.name, id: "dl_fake" }) });
    await f.endRun(worker);
    expect(f.supplements(worker)).toHaveLength(1);
  });

  test("미룬 확인(뒤 작업): 총괄의 대표 글 턴이라도 뒤로 돌리기 전에 쓴 진행 글은 결과가 아니고, 닫힌 뒤 스스로 연 턴의 진행 글은 결과다", async () => {
    for (const after of [false, true]) {
      const f = fixture(), lead = f.member("conductor", "시험 총괄");
      await f.orch.sendUserMessage(f.project.id, { text: "조사 묶음을 돌려 줘" });
      await pollUntil("총괄 턴", () => f.runner.busy.has(lead.id));
      await f.orch.recordPost(lead, { kind: "진행", title: "조사를 뒤로 돌렸습니다. 끝나면 결과를 올립니다" });
      // 뒤 작업을 남기고 Claude 자기 근거로 닫힌 턴: 결과 보고 확인은 그 작업이 끝난 뒤로 미룬다(핫픽스 C).
      const run = await f.endRun(lead, CLAUDE_BACKGROUND_REASON);
      expect(f.supplements(lead)).toEqual([]);
      await Bun.sleep(5); // 닫힌 때보다 뒤의 글이 되게 한다.
      if (after) await f.orch.recordPost(lead, { kind: "진행", title: "조사 끝, 표로 묶는 중이고 다음 판단은 대표님 몫입니다" });
      // 뒤 작업이 끝나 Claude 가 스스로 연 턴의 끝: 여기서 미룬 확인을 한다.
      f.runner.end(f.store, f.store.requireMember(lead.id));
      await pollUntil("미룬 확인", () => !!f.store.getExecutionJournal(run.runId)?.reportRequestedAt);
      expect(f.supplements(lead)).toHaveLength(after ? 0 : 1);
    }
  });
});

describe("D3-3·D5-4 결재 누락 감지: 지금 대표 승인·결정을 구하는 문장만", () => {
  const others = ["광고 담당 3", "시험 총괄", "앱 묶기", "모바일 담당"];
  // [문장, 걸려야 하나]. 0.2.6 뒤 실제로 걸린 문장들과 같은 모양이지만 낱말을 바꾼 가짜 글이다(라이브 사본과 글자까지 같은 줄이 없음을 확인).
  const table: [string, boolean][] = [
    // 지금 묻거나 기다리는 말: 건다.
    ["알림 문구·버튼 5건은 결재 대기", true],
    ["어느 화면까지 바꿀지는 결재함 카드로 여쭙니다.", true],
    ["공개 시점은 같은 턴에 결재 카드로 여쭙습니다.", true],
    ["남은 것은 2번 칸 사진 한 장입니다. 정해 주시면 곧바로 갈아 끼웁니다.", true],
    ["결재 전에는 예산 설정을 건드리지 않고, 크레딧도 쓰지 않습니다.", true],
    ["처리 끝난 문의를 닫는 일은 결재함에서 승인받은 뒤에 합니다.", true],
    ["세 안을 접고, 새 안을 또 만들기 전에 방향부터 여쭙니다", true],
    ["노출 중입니다 (화면 깨짐 3건은 카드로 여쭙니다)", true],
    ["표지는 고르신 시안으로 정했습니다. 가로형 끝 장면 하나만 카드로 여쭙니다", true],
    ["시험 묶음 준비 끝. 내부 배포로 확인할지 여쭙니다", true],
    // 검토 지적: 물음 내용 안의 때·다음·후·-면, 다른 팀장 이름과 겹치는 말이 있어도 지금 묻는 현재형이면 건다.
    ["정식 공개 후 요금을 올릴지 여쭙니다", true],
    ["다음 판에 넣을지 여쭙니다", true],
    ["다음 단계로 넘어갈지 카드로 여쭙니다", true],
    ["어떤 글꼴이면 좋을지 카드로 여쭙니다", true],
    ["회의 때 띄울 표를 어느 것으로 할지 여쭙니다", true],
    ["다음 교대 시각은 결재 카드로 여쭙니다", true],
    ["앱 묶기가 끝나서 내부 배포할지 여쭙니다", true],
    ["앱 묶기가 오늘 끝나서 배포를 여쭙니다", true],
    ["모바일 담당이 만든 시안을 쓸지 여쭙니다", true],
    ["알림을 다시 켤지는 결재 카드로 여쭙니다", true],
    ["배경음은 따로 말씀하신 적이 없어서 여쭙니다", true],
    ["그때 지난 영상으로 낼지 정해 주세요", true],
    ["메타 광고 대표 승인 대기", true],
    // 조건부 안내: 걸지 않는다(판 번호의 마침표에서 문장을 나누면 앞의 조건을 잃었다).
    ["전체 점검이 끝나면 커밋하고, 이어서 4.5.67 공개를 결재 카드로 여쭙겠습니다.", false],
    ["새로 가입하거나 앱을 새로 깔아야 하면 먼저 여쭙니다", false],
    ["새 가입이나 앱 깔기가 필요하면 먼저 여쭙겠습니다", false],
    ["고쳐야 하면, 심사를 또 낼지 결재함으로 여쭙습니다", false],
    ["비용이 300크레딧을 넘으면 만들기 전에 결재 카드로 여쭙습니다", false],
    ["빠진 게 원인이면 되돌리기 전에 결재함으로 여쭙니다", false],
    ["끝나면 판정·고칠 목록·일정표를 자료로 올리고 결재 카드로 여쭙겠습니다.", false],
    ["밖으로 보이는 변경이나 추가 비용이 드는 것은 바뀐 문구와 함께 여쭙니다", false],
    ["끝나면 배포할지 여쭙니다", false],
    ["끝난 뒤 어느 판에 넣을지 여쭙니다", false],
    ["넷 중 하나를 빼야 할 때만 멈추고 여쭙니다", false],
    // 나중의 예고: 걸지 않는다.
    ["올리는 날(다음 달 초) 다시 여쭙겠습니다", false],
    ["넣을지 말지는 따로 여쭙겠습니다", false],
    ["끝나는 대로 어느 묶음에 넣을지 결재함에 카드로 여쭙겠습니다", false],
    ["몇 번째 판에 넣을지는 다 만든 뒤 카드로 여쭙겠습니다.", false],
    ["가로형도 지금 바꿀지는 반영 보고와 함께 카드로 여쭙겠습니다.", false],
    ["바꾸기 전보다 눈에 띄게 나빠지면 그때 다시 여쭙겠습니다", false],
    ["검수가 끝난 뒤 설정 값은 말씀드린 대로 한 번 더 여쭙습니다", false],
    ["공개 전에 여쭙겠습니다", false],
    ["**올리는 날** (다음 차례) 셋을 승인 카드 한 장으로 여쭙니다", false],
    ["그날 결재 카드 하나로 여쭙니다", false],
    ["해외 광고 건은 내일 아침 점검 뒤 카드로 여쭙고", false],
    ["표 모양은 다음 카드에서 여쭙니다", false],
    ["그 다음 카드로 여쭙니다", false],
    // 부정: 걸지 않는다(줄임 꼴 '건'·'게' 포함).
    ["대표 승인이 필요한 남은 단계는 없습니다", false],
    ["정정: 방금 보고에 대표 승인이 필요한 일은 없습니다", false],
    ["지금 하는 일은 조사와 정리뿐이라 대표님 승인이 필요한 단계가 아닙니다", false],
    ["이 일에서 제가 따로 받을 결정은 없습니다", false],
    ["승인이 필요한 건 없습니다", false],
    ["대표님 결정이 필요한 건 없습니다", false],
    ["결재 올릴 것은 없습니다", false],
    ["승인 대기 중인 건은 없습니다", false],
    // 인용(정정 글 안): 걸지 않는다.
    ["정정: 앞 보고에서 '나중에 여쭙겠습니다'라고 쓴 줄을 지웠습니다", false],
    ["(앞 보고의 '결재 대기' 낱말을 고친 판입니다)", false],
    ["바뀐 문구를 담은 '승인 뒤 이대로 제출' 카드 두 장입니다", false],
    // 이미 물었거나 남에게 묻게 함, 다른 팀장이 묻거나 다른 팀장에게 하는 말: 걸지 않는다.
    ["남은 빈칸을 채울지 결재 카드로 여쭤 두었습니다", false],
    ["요금 손볼 때 이어 갈지 따로 여쭙게 했습니다", false],
    ["가로형 묶음도 바꿀지는 광고 담당 3이 카드로 여쭙습니다", false],
    ["상표 질문도 모바일 담당이 다른 결정과 묶어서 대표님께 여쭙니다", false],
    ["총괄에게: 둘 중 누가 맡을지 정해 주시면 따르겠습니다", false],
    // 바깥 심사의 승인: 걸지 않는다(심사 이름과 '승인' 사이에 낱말이 끼어도).
    ["관리형 게시라 승인 뒤 게시 대기 목록에 이 판만 있으면 제가 '게시'를 누릅니다", false],
    ["구글 플레이 승인 대기", false],
    ["Play Console 승인 대기 중", false],
    ["TestFlight 외부 테스트 승인 대기", false],
  ];
  for (const [text, expected] of table) test(`${expected ? "건다" : "걸지 않는다"}: ${text}`, () => {
    expect(needsApprovalCard(text, others)).toBe(expected);
  });
});

describe("D3-3 결재 누락 안내: 정정 사슬에 한 번, 이름을 든 팀장의 열린 카드", () => {
  test("안내를 받은 보고의 정정(그 정정의 정정도)에는 다시 안내하지 않는다", async () => {
    const f = fixture(), worker = f.member("worker", "광고");
    const first = await f.orch.recordPost(worker, { kind: "진행", title: "반영 중", body: "어느 화면까지 바꿀지는 결재함 카드로 여쭙니다" });
    expect(first.systemInstruction).toContain("열린 결재 카드가 없다");
    const second = await f.orch.recordPost(worker, { kind: "진행", title: "반영 중", body: "정정: 공개 시점은 결재 카드로 여쭙습니다", supersedes: first.id });
    expect(second.systemInstruction).toBeUndefined();
    const third = await f.orch.recordPost(worker, { kind: "진행", title: "반영 중", body: "정정: 결재 대기입니다", supersedes: second.id });
    expect(third.systemInstruction).toBeUndefined();
    expect(f.store.listActivity(worker.id).filter(a => a.text.includes("열린 결재 카드가 없다"))).toHaveLength(1);
    // 정정이 아닌 새 보고는 다시 본다.
    expect((await f.orch.recordPost(worker, { kind: "진행", title: "다른 일", body: "결재 대기입니다" })).systemInstruction).toContain("열린 결재 카드가 없다");
  });

  test("승인을 구하는 절이 다른 팀장을 그 승인의 임자로 들면 그 팀장의 열린 카드가 그 절이 말하는 카드다", async () => {
    const f = fixture(), worker = f.member("worker", "광고 시안"), other = f.member("worker", "광고 담당 3");
    f.store.createDecision({ projectId: f.project.id, memberId: other.id, who: other.name, title: "묶음을 바꿀까요" });
    const post = await f.orch.recordPost(worker, { kind: "알림", title: "반영 끝", body: "가로형 묶음은 광고 담당 3 쪽 결재 대기입니다" });
    expect(post.systemInstruction).toBeUndefined();
  });

  test("이름이 보고의 다른 절에 나오기만 한 팀장의 카드는 주제와 상관없는 카드다(검토 지적)", async () => {
    const f = fixture(), worker = f.member("worker", "화면 손질"), other = f.member("worker", "디자인 2");
    f.store.createDecision({ projectId: f.project.id, memberId: other.id, who: other.name, title: "아이콘 색을 바꿀까요" });
    const post = await f.orch.recordPost(worker, { kind: "진행", title: "반영 끝", body: "디자인 2 시안 반영 끝, 배포는 대표님 승인 후 하겠습니다" });
    expect(post.systemInstruction).toContain("열린 결재 카드가 없다");
  });
});

describe("D2-5 진전: MCP 도구 호출과 세션 기록 쓰기", () => {
  test("도구 호출은 시작한 업무의 마지막 진전을 지금으로 적고, 걸려 있던 '진전 없음'을 곧바로 지운다", async () => {
    const f = fixture(); f.member("conductor", "시험 총괄"); const worker = f.member("worker", "개발");
    await f.orch.assign(f.project.id, worker.handle, { text: "고쳐 주세요" });
    const run = f.store.listPendingExecutions().find(r => r.memberId === worker.id)!;
    const old = new Date(Date.now() - 120_000).toISOString();
    f.store.saveExecutionJournal({ ...run, phase: "running", startedAt: old, lastProgressAt: old, updatedAt: old });
    f.store.patchMember(worker.id, { status: "working", statusObservation: { source: "core", observedAt: old, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: { code: "progress_stalled", note: "가짜" } } });
    const before = Date.now();
    await f.orch.handleAgentTool(f.store.requireMember(worker.id), "status", { now: "고치는 중" });
    const after = f.store.getExecutionJournal(run.runId)!;
    expect(Date.parse(after.lastProgressAt!)).toBeGreaterThanOrEqual(before - 5);
    expect(after.startedAt).toBe(old);
    expect(f.store.requireMember(worker.id).statusObservation?.error ?? null).toBeNull();
  });

  test("시작 전(받기만 한) 업무와 다른 세대의 업무는 바꾸지 않는다", async () => {
    const f = fixture(); f.member("conductor", "시험 총괄"); const worker = f.member("worker", "개발");
    await f.orch.assign(f.project.id, worker.handle, { text: "고쳐 주세요" });
    const run = f.store.listPendingExecutions().find(r => r.memberId === worker.id)!;
    f.store.saveExecutionJournal({ ...run, phase: "received", startedAt: null, lastProgressAt: null });
    await f.orch.handleAgentTool(f.store.requireMember(worker.id), "status", { now: "읽는 중" });
    expect(f.store.getExecutionJournal(run.runId)).toMatchObject({ startedAt: null, lastProgressAt: null });
  });

  test("core: 세션 기록에 줄이 더해지면 마지막 진전이 그때로 오르고 '진전 없음'이 풀린다. 기록이 멈춰 있으면 그대로 걸린다", async () => {
    const t = await coreSetup({ directives: "@fake:hold", timings: { healthMs: 50 } });
    cleanups.push(() => t.close());
    const worker = (await t.orch.addMember(t.project.id, { name: "개발", handle: "dev", role: "개발" })).member;
    await t.orch.assign(t.project.id, worker.handle, { text: "오래 걸리는 일" });
    await t.waitFor("턴 시작", () => t.core.held(worker.id) && t.store.listPendingExecutions().find(r => r.memberId === worker.id && r.startedAt));
    const member = t.member(worker.id);
    const log = transcriptPath(member.cwd, member.sessionId!, join(t.home, "claude-home"));
    await t.waitFor("세션 기록", () => existsSync(log));
    await Bun.sleep(300); // 턴 시작의 기록 쓰기·상태 사건이 다 지나간 뒤에 손댄다.
    const run = t.store.listPendingExecutions().find(r => r.memberId === worker.id)!;
    // 기록이 2분 전에 멈췄고 마지막 진전도 1분 전이다: 건강 확인이 '진전 없음'을 건다.
    const minute = new Date(Date.now() - 60_000).toISOString(), stale = (Date.now() - 120_000) / 1000;
    utimesSync(log, stale, stale);
    t.store.saveExecutionJournal({ ...run, startedAt: minute, lastProgressAt: minute, updatedAt: minute });
    await t.waitFor("진전 없음", () => t.member(worker.id).statusObservation?.error?.code === "progress_stalled");
    expect(t.store.getExecutionJournal(run.runId)!.lastProgressAt).toBe(minute);
    // CLI 가 기록에 줄을 더한다: 다음 확인에서 진전이 그 시각으로 오르고 표시가 풀린다.
    const wrote = Date.now();
    appendFileSync(log, JSON.stringify({ type: "system", subtype: "informational", content: "가짜 진행", sessionId: member.sessionId }) + "\n");
    await t.waitFor("진전", () => Date.parse(t.store.getExecutionJournal(run.runId)!.lastProgressAt!) >= wrote - 1000);
    await t.waitFor("표시 풀림", () => t.member(worker.id).statusObservation?.error?.code !== "progress_stalled");
    expect(t.store.getExecutionJournal(run.runId)!.startedAt).toBe(minute);
    t.core.release(worker.id);
  }, 30_000);
});

describe("D4-10 APNs 연결: 여러 주소가 모두 실패해도 MaxListeners 경고 덤프가 없다", () => {
  const many: LookupFunction = (_host, options, callback) => {
    const all = Array.from({ length: 12 }, (_, i) => ({ address: i % 2 ? `::ffff:127.0.0.${i + 2}` : `127.0.0.${i + 2}`, family: i % 2 ? 6 : 4 }));
    if (options?.all) callback(null, all); else callback(null, all[0]!.address, all[0]!.family);
  };

  test("주소 묶음마다 앞 세 개만, 섞인 차례를 지킨다. 하나만 묻는 호출과 오류는 그대로 넘긴다", async () => {
    const got = await new Promise<unknown>(resolve => boundedLookup(many)("push.invalid", { all: true }, (_e, address) => resolve(address)));
    expect((got as { address: string; family: number }[]).map(a => a.family)).toEqual([4, 6, 4, 6, 4, 6]);
    const single = await new Promise<unknown[]>(resolve => boundedLookup(many)("push.invalid", {}, (...args) => resolve(args)));
    expect(single).toEqual([null, "127.0.0.2", 4]);
    const failing: LookupFunction = (_h, _o, callback) => callback(Object.assign(new Error("nope"), { code: "ENOTFOUND" }), []);
    const error = await new Promise<unknown>(resolve => boundedLookup(failing)("push.invalid", { all: true }, e => resolve(e)));
    expect(error).toMatchObject({ code: "ENOTFOUND" });
  });

  test("운영 연결(apnsConnector)로 열두 주소가 모두 실패해도 경고가 없다(시도를 다 마치고 닫힐 때까지 본다)", async () => {
    // 닿지 않는 주소(127.0.0.x, 시도마다 연결 대기)와 곧바로 거절되는 주소(::1)를 섞는다. 제한된 여섯 주소의 마지막(여섯째)이 거절이라
    // 시도를 모두 마치면 세션이 오류로 닫힌다. 주소 수를 줄이지 않으면(Bun 1.3.14) 아홉째 시도쯤에 경고가 나고 열한째에서 멈춰 닫히지 않는다.
    const mixed: LookupFunction = (_host, options, callback) => {
      const all = Array.from({ length: 12 }, (_, i) => ({ address: i === 5 || i === 11 ? "::1" : i % 2 ? `::ffff:127.0.0.${i + 2}` : `127.0.0.${i + 2}`, family: i % 2 ? 6 : 4 }));
      if (options?.all) callback(null, all); else callback(null, all[0]!.address, all[0]!.family);
    };
    const warnings: string[] = [];
    const listener = (warning: Error) => warnings.push(warning.name);
    process.on("warning", listener);
    try {
      const session = apnsConnector(mixed)("https://push-test.invalid:1", { servername: "push-test.invalid", rejectUnauthorized: true, ALPNProtocols: ["h2"] });
      let closed = false;
      session.on("error", () => {});
      session.on("close", () => { closed = true; });
      await pollUntil("시도를 다 마치고 닫힘(또는 경고)", () => closed || warnings.length > 0, 15_000);
      await new Promise(resolve => setImmediate(resolve));
      session.destroy();
      expect(warnings.filter(name => name === "MaxListenersExceededWarning")).toEqual([]);
      expect(closed).toBe(true);
    } finally { process.off("warning", listener); }
  }, 20_000);
});
