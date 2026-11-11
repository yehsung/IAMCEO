// 판 정리: 결재 닫기(ask_close)·할 일 정리(todo_close)·판 보기(board), 주기 정리, '지금 판 정리' API, 마이그레이션.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONDUCTOR_TOOLS, ROOT_TOOLS, WORKER_TOOLS, type Backend, type Member, type Todo } from "../shared/types.ts";
import { listAgentTools } from "../server/agent-tools.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import type { AgentToolResult, AskWaitResult } from "../server/orchestrator-api.ts";
import { formatTidy, Orchestrator, TIDY_HEAD } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { isReportNudge } from "./fixtures/core-harness.ts";

/** 서버가 스스로 붙인 '보고 보완'만 든 턴인가. 다른 전달과 묶여 나간 턴은 일하는 턴이다(전달마다 표식 줄이 하나씩 붙는다). */
const nudgeOnly = (text: string) => isReportNudge({ prompt: text }) && text.split("\n").filter((line) => /^#iamceo_[A-Za-z0-9_-]{22}$/.test(line)).length === 1;

/**
 * 세션을 띄우지 않고 받은 글만 기록한다. 턴은 end() 로 끝낸다. 실행기 종류는 운영과 같은 core 다.
 * core 에서는 깨우는 지시를 받고 보고 없이 끝난 턴 뒤에 서버가 '보고 보완' 턴을 한 번 넣는다. 이 시험들의 주제가 아니라
 * sent 가 아닌 nudges 에 따로 적고, 가짜 CLI 처럼 보고 없이 곧바로 끝낸다(서버는 '결과 보고 누락'을 남기고 더 묻지 않는다).
 */
class FakeRunner implements Runner {
  readonly kind: Backend = "core";
  /** 운영의 CoreRunner 와 같다: 돌고 있는 턴에 끼워 넣지 못한다. 급한 글도 턴이 끝난 뒤 나간다. */
  readonly interjects = false;
  sent: { memberId: string; text: string }[] = [];
  nudges: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  private cb: (e: RunnerEvent) => void = () => {};
  async available() {
    return { ok: true };
  }
  async start() {
    return { sessionId: crypto.randomUUID(), paneId: null };
  }
  async send(m: { id: string }, text: string): Promise<SendResult> {
    this.busy.add(m.id);
    if (nudgeOnly(text)) {
      this.nudges.push({ memberId: m.id, text });
      setTimeout(() => this.end(m.id), 0);
    } else this.sent.push({ memberId: m.id, text });
    return { ok: true };
  }
  isBusy(id: string) {
    return this.busy.has(id);
  }
  async compact(): Promise<SendResult> {
    return { ok: true };
  }
  async setParallel(): Promise<SendResult> {
    return { ok: true };
  }
  async interrupt() {}
  async stop(m: { id: string }) {
    this.busy.delete(m.id);
  }
  async screen() {
    return "";
  }
  on(cb: (e: RunnerEvent) => void) {
    this.cb = cb;
  }
  async shutdown() {}
  /** core 는 턴의 마지막 글을 서버에 넘기지 않는다(finalText 는 늘 빈 글). */
  end(memberId: string) {
    this.busy.delete(memberId);
    this.cb({ type: "turn_end", memberId, finalText: "", isError: false });
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

const until = async (cond: () => boolean, label = "조건", ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${label} 시간 초과`);
    await Bun.sleep(5);
  }
};

/**
 * runner.end() 가 낸 턴 끝을 총괄이 처리하고, 그 끝에 도는 전달 펌프까지 끝날 때까지 기다린다(그 직원의 활동에 '턴 끝'이 n 건 남는다).
 * 실행 종결·판 정리 완료·보고 보완 요청은 그 활동 줄보다 먼저 적히므로, 이 뒤에는 '있어야 하는 값'도 '없어야 하는 값'도 정해져 있다.
 * 펌프까지 기다리는 까닭: 펌프가 도는 동안의 팀장 닫기는 409 "세션을 처리하는 중입니다"이고 주기 판 정리도 그 총괄을 건너뛴다.
 * 고정 대기(Bun.sleep) 자리에 쓴다: 기계가 바빠 처리가 늦어도 떨어지지 않고, 처리 전에 보고 지나가지도 않는다.
 */
const ended = async (t: { store: Store; orch: Orchestrator }, memberId: string, n = 1) => {
  await until(() => t.store.listActivity(memberId).filter((a) => a.kind === "turn_end").length >= n, "턴 끝 처리");
  await t.orch.pump(memberId);
};


const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** 본문 계약과 실제 송신한 영속 봉투를 함께 검증한다. */
function deliveryBody(store: Store, sent: { memberId: string; text: string }): string {
  const dispatch = store.listDispatches(sent.memberId).find(d => d.wireText === sent.text)!;
  expect(dispatch).toBeDefined();
  expect(dispatch.items).toHaveLength(1);
  const delivery = store.requireDelivery(dispatch.items[0]!.deliveryId);
  expect(dispatch.markers).toEqual([{ deliveryId: delivery.id, marker: store.getDeliveryRecovery(delivery.id)!.marker! }]);
  expect(sent.text).toBe(`${delivery.text}\n${dispatch.markers[0]!.marker}\n${dispatch.bundleMarker}`);
  return delivery.text;
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "iamceo-board-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const runner = new FakeRunner();
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", runner]]) });
  const server: RunningServer = await startServer({ config, store, bus, orch });
  const url = server.urls[0]!;
  orch.setServerUrl(url);
  cleanups.push(async () => {
    await orch.shutdown();
    await server.stop();
  });
  const project = store.createProject({ name: "시험", cwd: home });
  const lead = await orch.ensureConductor(project.id);
  // core 직원의 전달 펌프는 터미널 조작 임대 정리를 기다리는 구간이 있어 한 박자 늦게 끝난다. 띄운 직후의 펌프가 끝난 뒤에 시험을 시작한다.
  await orch.pump(lead.id);
  const call = async (member: Member, name: string, args: Record<string, unknown> = {}): Promise<AgentToolResult> => {
    const res = await fetch(`${url}/agent/tool`, {
      method: "POST",
      headers: { Authorization: `Bearer ${store.getMemberToken(member.id)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as AgentToolResult;
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { Authorization: "Bearer code", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const worker = async (name = "철수", handle = "cs") => (await orch.addMember(project.id, { name, handle, role: "개발" })).member;
  /** 직원이 결재를 올리고 턴을 끝낸 상태(내 답 기다림). */
  const asked = async (w: Member, title = "어느 쪽으로 갈까요") => {
    await call(w, "ask", { title, detail: "배경", options: [{ k: "a", label: "가 안" }, { k: "b", label: "나 안" }], rec: "a" });
    return store.listOpenDecisionsByMember(w.id).at(-1)!;
  };
  const say = (body: string) => store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body });
  const pendingTexts = (m: Member) => store.listPending(m.id).map((d) => ({ text: d.text, wake: d.wake }));
  return { home, url, store, orch, runner, server, project, lead, call, api, worker, asked, say, pendingTexts };
}

describe("도구 목록", () => {
  test("직원은 자기 것만 닫는 ask_close·todo_close, 판 보기는 총괄·본사 AI 만", async () => {
    const { store, project, lead } = await setup();
    const names = (m: Member) => listAgentTools(m).map((t) => t.name);
    const w = store.createMember({ projectId: project.id, handle: "w", name: "직원", kind: "worker" });
    const root = store.createMember({ projectId: "hq", handle: "root", name: "본사 AI", kind: "root" });
    expect(WORKER_TOOLS).toContain("ask_close");
    expect(WORKER_TOOLS).toContain("todo_close");
    expect(names(w)).not.toContain("board");
    expect(names(lead)).toEqual([...WORKER_TOOLS, ...CONDUCTOR_TOOLS]);
    expect(names(lead)).toContain("board");
    expect(names(root)).toEqual([...WORKER_TOOLS, ...ROOT_TOOLS]);
    expect(names(root)).toContain("board");
    const close = listAgentTools(lead).find((t) => t.name === "ask_close")!;
    expect(close.description).toContain("대신 답하지 않는다");
    expect((close.inputSchema as { required: string[] }).required).toEqual(["id", "kind", "reason"]);
  });
});

describe("ask_close", () => {
  test("decided: 인용이 대표 글에 없으면 닫지 않는다", async () => {
    const t = await setup();
    const w = await t.worker();
    const d = await t.asked(w);
    const r = await t.call(t.lead, "ask_close", { id: d.id, kind: "decided", reason: "대표가 가 안으로 정함", user_quote: "가 안으로 해 주세요" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("찾지 못해 닫지 않았습니다");
    expect(t.store.requireDecision(d.id).status).toBe("open");
    // user_quote 가 없으면 안 된다.
    expect(await t.call(t.lead, "ask_close", { id: d.id, kind: "decided", reason: "정함" })).toMatchObject({ isError: true });
    // 총괄 자신의 글은 대표 글이 아니다.
    t.store.createMessage({ projectId: t.project.id, memberId: t.lead.id, who: t.lead.name, kind: "답변", body: "가 안으로 해 주세요" });
    expect(await t.call(t.lead, "ask_close", { id: d.id, kind: "decided", reason: "정함", user_quote: "가 안으로 해 주세요" })).toMatchObject({ isError: true });
    expect(t.store.requireDecision(d.id).status).toBe("open");
  });

  test("decided: 짧은 글·다른 결재의 버튼 글은 근거가 못 된다", async () => {
    const t = await setup();
    const w = await t.worker();
    const first = await t.asked(w, "먼저 물은 것");
    await t.orch.answerDecision(first.id, { choice: "a" });
    await until(() => t.runner.sent.some((s) => s.memberId === w.id), "답 전달");
    t.runner.end(w.id);
    // 답으로 깬 직원이 보고 없이 끝냈다: core 에서는 보고 보완 턴이 한 번 지나간다.
    await until(() => t.runner.nudges.some((n) => n.memberId === w.id) && !t.runner.busy.has(w.id), "보고 보완 지나감");
    const d = await t.asked(w, "다음 물음");
    t.say("네");
    expect((await t.call(t.lead, "ask_close", { id: d.id, kind: "decided", reason: "정함", user_quote: "네" })).text).toContain("근거가 못 되어");
    expect((await t.call(t.lead, "ask_close", { id: d.id, kind: "decided", reason: "정함", user_quote: "가 안" })).text).toContain("근거가 못 되어");
    expect(t.store.requireDecision(d.id).status).toBe("open");
  });

  test("decided: 맞으면 닫고 물은 직원에게 깨우지 않고 알린다", async () => {
    const t = await setup();
    const w = await t.worker();
    const d = await t.asked(w);
    t.runner.end(w.id);
    await ended(t, w.id);
    expect(t.store.requireMember(w.id).status).toBe("waiting");
    const said = t.say("그건 가 안으로 하기로 했어요. 나 안은 안 씁니다");
    const sentBefore = t.runner.sent.length;
    const r = await t.call(t.lead, "ask_close", { id: d.id, kind: "decided", reason: "대표가 대화에서 가 안으로 정함", user_quote: "가 안으로 하기로 했어요" });
    expect(r.isError).toBeUndefined();
    const closed = t.store.requireDecision(d.id);
    expect(closed).toMatchObject({ status: "closed", closeKind: "decided", closeReason: "대표가 대화에서 가 안으로 정함", closeQuote: "가 안으로 하기로 했어요", closedBy: t.lead.name });
    expect(closed.closedAt).not.toBeNull();
    // 깨우지 않는다: 직원에게 새 턴이 나가지 않고, 다음 깨움에 묶인다.
    expect(t.runner.sent.length).toBe(sentBefore);
    const note = t.pendingTexts(w).find((p) => p.text.includes(`결재 #${d.id} 가 닫혔습니다`))!;
    expect(note.wake).toBe(false);
    expect(note.text).toStartWith(`[시스템] 결재 #${d.id} 가 닫혔습니다: 대표가 대화에서 가 안으로 정함 (대표가 이미 정함, 대표 글 #${said.id})`);
    // 열린 결재가 없으니 더는 답을 기다리지 않는다.
    expect(t.store.requireMember(w.id).status).toBe("idle");
    expect(t.store.projectSummaries().find((p) => p.id === t.project.id)!.decisionCount).toBe(0);
    // 다시 닫거나 답할 수 없다.
    expect((await t.call(t.lead, "ask_close", { id: d.id, kind: "obsolete", reason: "또" })).text).toContain("이미 닫힌");
    await expect(t.orch.answerDecision(d.id, { choice: "a" })).rejects.toThrow();
  });

  test("obsolete: 이유만으로 닫는다. 이유가 없거나 이미 답한 카드는 거부", async () => {
    const t = await setup();
    const w = await t.worker();
    const d = await t.asked(w);
    expect(await t.call(t.lead, "ask_close", { id: d.id, kind: "obsolete" })).toMatchObject({ isError: true });
    expect(await t.call(t.lead, "ask_close", { id: d.id, kind: "obsolete", reason: "  " })).toMatchObject({ isError: true });
    expect(await t.call(t.lead, "ask_close", { id: d.id, kind: "obsolete", reason: "줄\n바꿈" })).toMatchObject({ isError: true });
    expect((await t.call(t.lead, "ask_close", { id: d.id, kind: "obsolete", reason: "기능을 빼기로 해 물을 필요가 없어짐" })).isError).toBeUndefined();
    expect(t.store.requireDecision(d.id)).toMatchObject({ status: "closed", closeKind: "obsolete", closeQuote: null });
    const e = await t.asked(w, "또 물음");
    await t.orch.answerDecision(e.id, { choice: "b" });
    expect((await t.call(t.lead, "ask_close", { id: e.id, kind: "obsolete", reason: "x" })).text).toContain("이미 답한");
    expect(t.store.requireDecision(e.id).status).not.toBe("closed");
    expect((await t.call(t.lead, "ask_close", { id: "d_없음", kind: "obsolete", reason: "x" })).text).toContain("찾을 수 없습니다");
  });

  test("직원은 자기가 올린 카드만 닫고, 그러면 총괄에게 알린다. 다른 프로젝트 카드는 못 닫는다", async () => {
    const t = await setup();
    const a = await t.worker("철수", "cs");
    const b = await t.worker("영희", "yh");
    const mine = await t.asked(a, "철수의 물음");
    const theirs = await t.asked(b, "영희의 물음");
    const denied = await t.call(a, "ask_close", { id: theirs.id, kind: "obsolete", reason: "x" });
    expect(denied).toMatchObject({ isError: true, text: "직원은 자기가 올린 결재만 닫을 수 있습니다" });
    expect(await t.call(a, "board")).toMatchObject({ isError: true });
    expect((await t.call(a, "ask_close", { id: mine.id, kind: "obsolete", reason: "스스로 풀었음" })).isError).toBeUndefined();
    expect(t.store.requireDecision(mine.id)).toMatchObject({ status: "closed", closedBy: "철수" });
    expect(t.pendingTexts(t.lead).some((p) => !p.wake && p.text.includes(`철수가 결재 #${mine.id} 를 닫았습니다: 스스로 풀었음`))).toBe(true);
    const other = t.store.createProject({ name: "다른", cwd: t.home });
    const stranger = await t.orch.ensureConductor(other.id);
    expect(await t.call(stranger, "ask_close", { id: theirs.id, kind: "obsolete", reason: "x" })).toMatchObject({ isError: true });
    expect(t.store.requireDecision(theirs.id).status).toBe("open");
  });

  test("ask 를 기다리던 직접 띄운 CLI 는 이유와 함께 풀린다", async () => {
    const t = await setup();
    const m = t.store.createMember({ projectId: t.project.id, handle: "m", name: "손", kind: "worker", origin: "manual" });
    const r = await t.call(m, "ask", { title: "물음", detail: "배경" });
    const decisionId = r.wait!.decisionId;
    const waiting = fetch(`${t.url}/agent/ask/wait`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t.store.getMemberToken(m.id)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ decisionId, timeoutMs: 20_000 }),
    }).then((res) => res.json() as Promise<AskWaitResult>);
    await Bun.sleep(50);
    await t.call(t.lead, "ask_close", { id: decisionId, kind: "obsolete", reason: "필요 없어짐" });
    const done = await waiting;
    expect(done.done).toBe(true);
    if (done.done) expect(done.text).toBe(`[시스템] 결재가 닫혔습니다: 필요 없어짐. 이 질문의 답은 오지 않습니다 #${decisionId}`);
  });

  test("대표가 다시 열면 결재할 항목으로 돌아가고 알린다. AI 가 닫지 않은 카드는 다시 열 수 없다", async () => {
    const t = await setup();
    const w = await t.worker();
    const d = await t.asked(w);
    t.runner.end(w.id);
    await ended(t, w.id);
    await t.call(t.lead, "ask_close", { id: d.id, kind: "obsolete", reason: "필요 없어 보임" });
    expect(t.store.requireMember(w.id).status).toBe("idle");
    const res = await t.api("POST", `/api/decisions/${d.id}/reopen`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "open", closeKind: null, closeReason: null, closedBy: null, closedAt: null });
    expect(String(res.body.reopenNote)).toContain("필요 없어 보임");
    expect(t.store.requireMember(w.id).status).toBe("waiting");
    expect(t.pendingTexts(w).some((p) => !p.wake && p.text.includes(`대표가 결재 #${d.id} 를 다시 열었습니다`))).toBe(true);
    // 다시 연 카드는 평소처럼 답할 수 있고 답은 물은 직원에게 간다.
    await t.orch.answerDecision(d.id, { choice: "b" });
    await until(() => t.runner.sent.at(-1)?.memberId === w.id, "답 전달");
    expect(t.runner.sent.at(-1)).toMatchObject({ memberId: w.id });
    expect(t.runner.sent.at(-1)!.text).toContain(`[대표 답(원문) '어느 쪽으로 갈까요'] "나 안"`);
    // 열린 카드, 답한 카드는 다시 열 수 없다.
    expect((await t.api("POST", `/api/decisions/${d.id}/reopen`)).status).toBe(409);
    // 직원이 명부에서 빠져 함께 닫힌 카드는 AI 가 닫은 것이 아니다.
    const v = await t.worker("영희", "yh");
    const e = await t.asked(v, "영희의 물음");
    t.runner.end(v.id);
    await ended(t, v.id);
    await t.orch.closeMember(v.id);
    expect(t.store.requireDecision(e.id)).toMatchObject({ status: "closed", closeKind: null, closedBy: "시스템" });
    expect(t.store.requireDecision(e.id).closeReason).toContain("명부에서 빠져");
    expect((await t.api("POST", `/api/decisions/${e.id}/reopen`)).status).toBe(409);
  });
});

describe("todo_close", () => {
  test("끝남·필요 없어짐으로 정리하고 부탁한 직원에게 깨우지 않고 알린다", async () => {
    const t = await setup();
    const w = await t.worker();
    await t.call(w, "todo", { title: "로그인 해 주세요" });
    await t.call(w, "todo", { title: "카드 등록" });
    const [login, card] = t.store.listTodos(t.project.id) as [Todo, Todo];
    expect(await t.call(t.lead, "todo_close", { id: login.id, outcome: "done" })).toMatchObject({ isError: true });
    const sentBefore = t.runner.sent.length;
    expect((await t.call(t.lead, "todo_close", { id: login.id, outcome: "done", reason: "대표가 대화에서 로그인했다고 함" })).isError).toBeUndefined();
    expect((await t.call(t.lead, "todo_close", { id: card.id, outcome: "dropped", reason: "결제 방식을 바꿔 필요 없어짐" })).isError).toBeUndefined();
    expect(t.store.requireTodo(login.id)).toMatchObject({ done: true, outcome: "done", closeReason: "대표가 대화에서 로그인했다고 함", closedBy: t.lead.name });
    expect(t.store.requireTodo(card.id)).toMatchObject({ done: true, outcome: "dropped", closedBy: t.lead.name });
    expect(t.store.requireTodo(card.id).doneAt).not.toBeNull();
    expect(t.store.projectSummaries().find((p) => p.id === t.project.id)!.todoCount).toBe(0);
    expect(t.runner.sent.length).toBe(sentBefore);
    const notes = t.pendingTexts(w).filter((p) => p.text.includes("대표의 할 일"));
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => !n.wake)).toBe(true);
    expect(notes[1]!.text).toContain(`(필요 없어짐): 결제 방식을 바꿔 필요 없어짐`);
    expect((await t.call(t.lead, "todo_close", { id: card.id, outcome: "done", reason: "또" })).text).toContain("이미 끝났거나 정리된");
  });

  test("직원은 자기가 부탁한 할 일만. 대표가 체크를 풀면 정리 이유도 지운다", async () => {
    const t = await setup();
    const a = await t.worker("철수", "cs");
    const b = await t.worker("영희", "yh");
    await t.call(a, "todo", { title: "철수 부탁" });
    await t.call(b, "todo", { title: "영희 부탁" });
    const [mine, theirs] = t.store.listTodos(t.project.id) as [Todo, Todo];
    expect(await t.call(a, "todo_close", { id: theirs.id, outcome: "dropped", reason: "x" })).toMatchObject({ isError: true, text: "직원은 자기가 부탁한 할 일만 정리할 수 있습니다" });
    expect((await t.call(a, "todo_close", { id: mine.id, outcome: "done", reason: "대표가 해 줬다고 말함" })).isError).toBeUndefined();
    expect(t.pendingTexts(t.lead).some((p) => !p.wake && p.text.includes("철수가 대표의 할 일"))).toBe(true);
    await t.orch.setTodoDone(mine.id, false);
    expect(t.store.requireTodo(mine.id)).toMatchObject({ done: false, outcome: null, closeReason: null, closedBy: null });
    await t.orch.setTodoDone(mine.id, true);
    expect(t.store.requireTodo(mine.id)).toMatchObject({ done: true, outcome: "done", closedBy: null });
  });
});

describe("board", () => {
  test("열린 결재·안 끝난 할 일·진행판·지난 정리 시각을 한 번에", async () => {
    const t = await setup();
    const w = await t.worker();
    const d = await t.asked(w);
    await t.call(w, "todo", { title: "서류 내기" });
    await t.call(w, "todo", { title: "끝난 일" });
    const done = t.store.listTodos(t.project.id)[1]!;
    await t.orch.setTodoDone(done.id, true);
    const item = t.orch.setWork(t.project.id, { sec: "doing", title: "로그인 고치기", who: "철수" });
    await t.call(t.lead, "project_now", { text: "로그인 고치는 중" });
    const board = JSON.parse((await t.call(t.lead, "board")).text) as Record<string, unknown>;
    expect(board).toMatchObject({ lastTidyAt: null, now: "로그인 고치는 중" });
    expect(board.decisions).toEqual([{ id: d.id, title: d.title, who: "철수", createdAt: d.createdAt, group: null }]);
    expect(board.todos).toEqual([expect.objectContaining({ title: "서류 내기", who: "철수" })]);
    expect(board.work).toEqual([{ id: item.id, sec: "doing", title: "로그인 고치기", updatedAt: item.updatedAt }]);
    const root = await t.orch.ensureConductor("hq");
    expect(JSON.parse((await t.call(root, "board")).text)).toMatchObject({ decisions: [], todos: [], work: [] });
  });
});

describe("주기 판 정리", () => {
  /** 간격이 지났고 그 뒤 바뀐 게 있는 상태. */
  const stale = (t: Awaited<ReturnType<typeof setup>>) => {
    t.store.setBoardTidiedAt(t.project.id, ago(7 * HOUR));
    t.say("새 말");
  };
  const tidies = (t: Awaited<ReturnType<typeof setup>>) => t.runner.sent.filter((s) => s.text.includes(TIDY_HEAD));

  test("간격이 지나고 바뀐 게 있으면 쉬는 총괄에게 깨움으로 넣는다", async () => {
    const t = await setup();
    expect(t.store.getSettings().boardTidyHours).toBe(6);
    stale(t);
    expect(t.orch.checkBoardTidy()).toEqual([t.project.id]);
    await until(() => tidies(t).length > 0, "판 정리 전달");
    expect(tidies(t)).toHaveLength(1);
    expect(tidies(t)[0]).toMatchObject({ memberId: t.lead.id });
    expect(deliveryBody(t.store, tidies(t)[0]!)).toBe(formatTidy("conductor", false));
    expect(tidies(t)[0]!.text).toContain("`ask_close`");
    expect(tidies(t)[0]!.text).toContain("직원은 깨우지 않는다");
    expect(Date.now() - Date.parse(t.store.getBoardReview(t.project.id)!.requestedAt)).toBeLessThan(5000);
    expect(t.store.getBoardReview(t.project.id)!.completedAt).toBeNull();
    expect(Date.now() - Date.parse(t.store.requireProject(t.project.id).tidiedAt!)).toBeGreaterThan(6 * HOUR);
    // 일하는 중(판 정리 턴)이면 또 넣지 않는다.
    t.store.setBoardTidiedAt(t.project.id, ago(7 * HOUR));
    t.say("또 새 말");
    expect(t.orch.checkBoardTidy()).toEqual([]);
  });

  test("끔·간격 전·바뀐 것 없음이면 넣지 않는다", async () => {
    const t = await setup();
    stale(t);
    t.store.patchSettings({ boardTidyHours: 0 });
    expect(t.orch.checkBoardTidy()).toEqual([]);
    t.store.patchSettings({ boardTidyHours: 6 });
    t.store.setBoardTidiedAt(t.project.id, ago(5 * HOUR));
    expect(t.orch.checkBoardTidy()).toEqual([]);
    // 지난 정리 뒤에 바뀐 게 없다.
    t.store.setBoardTidiedAt(t.project.id, new Date(Date.now() + 1000).toISOString());
    expect(t.orch.checkBoardTidy(Date.now() + 7 * HOUR)).toEqual([]);
    // 한 번도 안 했으면 총괄이 뜬 때부터 센다. 갓 뜬 총괄은 간격 전이다.
    const fresh = t.store.createProject({ name: "새것", cwd: t.home });
    await t.orch.ensureConductor(fresh.id);
    t.store.createMessage({ projectId: fresh.id, mine: true, who: "나", kind: "나", body: "말" });
    expect(t.orch.checkBoardTidy()).toEqual([]);
    expect(t.runner.sent.filter((s) => s.text.includes(TIDY_HEAD))).toHaveLength(0);
  });

  test("일하는 중·잠듦·총괄 없음·실행 꺼짐·기다리는 정리 지시가 있으면 넣지 않는다. 정리하려고 띄우지 않는다", async () => {
    const t = await setup();
    stale(t);
    // 일하는 중
    t.runner.busy.add(t.lead.id);
    expect(t.orch.checkBoardTidy()).toEqual([]);
    t.runner.busy.delete(t.lead.id);
    // 기다리는 판 정리 지시
    const queued = t.store.enqueue({ projectId: t.project.id, memberId: t.lead.id, kind: "system", text: formatTidy("conductor", true), status: "held", holdReason: "input_busy" });
    expect(t.orch.checkBoardTidy()).toEqual([]);
    t.store.markDelivered(queued.id);
    // 잠듦
    await t.orch.sleepMember(t.lead.id, { force: true });
    expect(t.orch.checkBoardTidy()).toEqual([]);
    expect(t.store.requireMember(t.lead.id).status).toBe("asleep");
    // 총괄이 없는 프로젝트: 띄우지 않는다.
    const empty = t.store.createProject({ name: "빈 곳", cwd: t.home });
    t.store.setBoardTidiedAt(empty.id, ago(7 * HOUR));
    t.store.createMessage({ projectId: empty.id, mine: true, who: "나", kind: "나", body: "말" });
    expect(t.orch.checkBoardTidy()).toEqual([]);
    expect(t.store.getConductor(empty.id)).toBeNull();
    // 실행이 꺼진 프로젝트
    await t.orch.resumeMember(t.lead.id);
    t.store.patchProject(t.project.id, { runnerEnabled: false });
    expect(t.orch.checkBoardTidy()).toEqual([]);
    t.store.patchProject(t.project.id, { runnerEnabled: true });
    expect(t.orch.checkBoardTidy()).toEqual([t.project.id]);
    await until(() => t.runner.sent.some((s) => s.text.includes(TIDY_HEAD)), "판 정리 전달");
    expect(t.runner.sent.filter((s) => s.text.includes(TIDY_HEAD))).toHaveLength(1);
  });

  // 옛 시험: "판 정리 턴이 끝나면 그 시각으로 적고, 할 말이 없던 마지막 글은 대화에 올리지 않는다"
  test("판 정리 턴이 끝나면 그 시각으로 적고, 판 정리만 받은 턴은 대화에 아무것도 올리지 않으며 보고 보완도 받지 않는다", async () => {
    const t = await setup();
    stale(t);
    t.orch.checkBoardTidy();
    await until(() => tidies(t).length === 1, "판 정리 전달");
    const before = t.store.listMessages(t.project.id).length;
    // 검토한 요청 revision 뒤의 변경은 다음 정리 대상으로 보존한다.
    await t.call(t.lead, "board");
    t.store.upsertWork({ projectId: t.project.id, sec: "done", title: "정리하며 옮김" });
    await Bun.sleep(5); // 시각 차이를 두는 대기(판 변경 시각 < 정리 시각). 조건을 기다리는 자리가 아니다.
    t.runner.end(t.lead.id);
    // 턴 끝 처리가 끝난 뒤에 본다. 보고 보완은 그 처리 안에서 전달로 적히므로, 여기서 전달이 없으면 뒤늦게 올 것도 없다
    // (고정 대기 뒤 nudges 0건만 보면, 늦게 온 보완을 아래의 '보고 보완' 기다림이 정상 보완으로 받아 준다).
    await ended(t, t.lead.id);
    expect(t.store.listMessages(t.project.id)).toHaveLength(before);
    // 달라진 점: 옛 실행기는 턴의 마지막 글("정리할 것이 없습니다")을 받아 활동에 '판 정리: …' 로 남겼다.
    // core 는 마지막 글을 서버에 넘기지 않아 그 활동 줄이 없다. 대신 판 정리만 받은 턴은 보고가 없어도 보고 보완을 받지 않는다.
    expect(t.store.listDeliveries(t.project.id).some((d) => d.text.includes("보고 보완"))).toBe(false);
    expect(t.runner.nudges).toHaveLength(0);
    const tidiedAt = t.store.requireProject(t.project.id).tidiedAt!;
    expect(tidiedAt >= t.store.lastBoardChangeAt(t.project.id)!).toBe(true);
    expect(t.store.boardRevision(t.project.id)).toBeGreaterThan(t.store.getBoardReview(t.project.id)!.reviewedRevision!);
    // 달라진 점: 대표의 말과 함께 묶여 간 턴. 옛 실행기에서는 마지막 글이 '답변'으로 올라갔다.
    // core 에서는 마지막 글이 오지 않고, 대표 말로 깬 총괄이 보고 없이 끝냈으니 보고 보완을 한 번 받는다.
    t.store.setBoardTidiedAt(t.project.id, ago(7 * HOUR));
    t.store.enqueue({ projectId: t.project.id, memberId: t.lead.id, kind: "system", text: formatTidy("conductor", false) });
    await t.orch.sendUserMessage(t.project.id, { text: "요즘 어때요" });
    await until(() => t.runner.sent.at(-1)!.text.includes("요즘 어때요"), "대표 말 전달");
    expect(t.runner.sent.at(-1)!.text).toContain(TIDY_HEAD);
    t.runner.end(t.lead.id);
    await until(() => t.runner.nudges.length === 1, "보고 보완");
    expect(t.runner.nudges[0]).toMatchObject({ memberId: t.lead.id });
    expect(t.store.listMessages(t.project.id).some((m) => m.memberId === t.lead.id)).toBe(false);
  });
});

describe("지금 판 정리 API·설정", () => {
  test("POST /tidy: 맡기고, 이미 있으면 다시 넣지 않는다. 총괄이 없으면 띄운다", async () => {
    const t = await setup();
    const res = await t.api("POST", `/api/projects/${t.project.id}/tidy`);
    expect(res).toEqual({ status: 200, body: { already: false } });
    await until(() => t.runner.sent.length > 0, "판 정리 전달");
    expect(t.runner.sent.at(-1)!.memberId).toBe(t.lead.id);
    expect(deliveryBody(t.store, t.runner.sent.at(-1)!)).toBe(formatTidy("conductor", true));
    expect((await t.api("POST", `/api/projects/${t.project.id}/tidy`)).body).toEqual({ already: true });
    expect(t.runner.sent.filter((s) => s.text.includes(TIDY_HEAD))).toHaveLength(1);
    // 총괄이 없는 프로젝트는 띄워서 맡긴다. 본사는 본사 AI.
    expect((await t.api("POST", "/api/projects/hq/tidy")).body).toEqual({ already: false });
    const root = t.store.getConductor("hq")!;
    expect(root.kind).toBe("root");
    await until(() => t.runner.sent.some((s) => s.memberId === root.id), "본사 AI 에게 판 정리 전달");
    const sent = t.runner.sent.find((s) => s.memberId === root.id)!;
    expect(deliveryBody(t.store, sent)).toBe(formatTidy("root", true));
    expect(sent.text).not.toContain("work_set");
  });

  test("POST /tidy: 연결이 없으면 다른 입력처럼 409", async () => {
    const t = await setup();
    const off = t.store.createProject({ name: "가져온 것", cwd: t.home, runnerEnabled: false });
    const res = await t.api("POST", `/api/projects/${off.id}/tidy`);
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain("연결");
    expect(t.store.getConductor(off.id)).toBeNull();
    t.store.patchProject(t.project.id, { archived: true });
    expect((await t.api("POST", `/api/projects/${t.project.id}/tidy`)).status).toBe(409);
    expect((await t.api("POST", "/api/projects/p_없음/tidy")).status).toBe(404);
  });

  test("판 정리 주기 설정: 0~168 시간, 기본 6", async () => {
    const t = await setup();
    expect(((await t.api("GET", "/api/bootstrap")).body.settings as { boardTidyHours: number }).boardTidyHours).toBe(6);
    expect((await t.api("PUT", "/api/settings", { boardTidyHours: 0 })).body).toMatchObject({ boardTidyHours: 0 });
    expect((await t.api("PUT", "/api/settings", { boardTidyHours: 24 })).body).toMatchObject({ boardTidyHours: 24 });
    expect((await t.api("PUT", "/api/settings", { boardTidyHours: -1 })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings", { boardTidyHours: 1.5 })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings", { boardTidyHours: 169 })).status).toBe(400);
    expect(t.store.getSettings().boardTidyHours).toBe(24);
  });
});

describe("마이그레이션", () => {
  test("닫힌 결재에 이유를, 끝낸 할 일에 끝남을 채우고 나머지는 그대로 둔다", () => {
    const path = join(mkdtempSync(join(tmpdir(), "iamceo-board-migrate-")), "old.db");
    const before = MIGRATIONS.findIndex((m) => m.includes("board_tidied_at"));
    expect(before).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThan(MIGRATIONS.length);
    const db = new Database(path, { create: true });
    for (let v = 0; v < before; v++) db.exec(MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${before}`);
    const at = "2026-01-01T00:00:00.000Z";
    db.query("INSERT INTO projects (id, name, is_hq, cwd, runner_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run("p_a", "에이", 0, "/a", 1, at, at);
    const decision = db.query("INSERT INTO decisions (id, project_id, member_id, who, title, status, choice, created_at, answered_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
    decision.run("d_closed", "p_a", "m_x", "철수", "닫힌 것", "closed", null, at, null, "2026-01-02T00:00:00.000Z");
    decision.run("d_open", "p_a", "m_x", "철수", "열린 것", "open", null, at, null, at);
    decision.run("d_done", "p_a", "m_x", "철수", "답한 것", "delivered", "a", at, at, at);
    const todo = db.query("INSERT INTO todos (id, project_id, who, title, done, done_at, created_at) VALUES (?,?,?,?,?,?,?)");
    todo.run("t_done", "p_a", "철수", "한 일", 1, "2026-01-03T00:00:00.000Z", at);
    todo.run("t_open", "p_a", "철수", "안 한 일", 0, null, at);
    db.close();

    const store = new Store(openDb(path), new Bus());
    expect(store.requireDecision("d_closed")).toMatchObject({ status: "closed", closeKind: null, closedBy: "시스템", closedAt: "2026-01-02T00:00:00.000Z" });
    expect(store.requireDecision("d_closed").closeReason).toContain("명부에서 빠져");
    expect(store.requireDecision("d_open")).toMatchObject({ status: "open", closeKind: null, closeReason: null, closedBy: null, closedAt: null });
    expect(store.requireDecision("d_done")).toMatchObject({ status: "delivered", choice: "a", closeReason: null });
    expect(store.requireTodo("t_done")).toMatchObject({ done: true, outcome: "done", closeReason: null, closedBy: null });
    expect(store.requireTodo("t_open")).toMatchObject({ done: false, outcome: null });
    expect(store.requireProject("p_a").tidiedAt).toBeNull();
    expect(store.lastBoardChangeAt("p_a")).toBe("2026-01-03T00:00:00.000Z");
    expect(store.getSettings().boardTidyHours).toBe(6);
    expect(store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(MIGRATIONS.length);
  });
});



test("board completion covers the read revision and leaves changes during tidy for the next review", async () => {
  const t = await setup();
  t.store.setBoardTidiedAt(t.project.id, ago(7 * HOUR));
  t.say("새 변경");
  expect(t.orch.checkBoardTidy()).toEqual([t.project.id]);
  await until(() => t.runner.sent.some((s) => s.memberId === t.lead.id && s.text.includes(TIDY_HEAD)), "판 정리 전달");
  await t.call(t.lead, "board");
  const requested = t.store.getBoardReview(t.project.id)!;
  t.store.createTodo({ projectId: t.project.id, title: "정리 중 추가한 할 일" });
  t.runner.end(t.lead.id);
  await ended(t, t.lead.id);
  const completed = t.store.getBoardReview(t.project.id)!;
  expect(completed.completedAt).toEqual(expect.any(String));
  expect(completed.reviewedRevision).toBe(requested.requestedRevision);
  expect(t.store.boardRevision(t.project.id)).toBeGreaterThan(completed.reviewedRevision!);
  expect(t.orch.checkBoardTidy(Date.now() + 7 * HOUR)).toEqual([t.project.id]);
});

test("ending tidy without reading board does not claim a successful review", async () => {
  const t = await setup();
  await t.orch.tidyBoard(t.project.id);
  await until(() => t.runner.sent.some((s) => s.memberId === t.lead.id && s.text.includes(TIDY_HEAD)), "판 정리 전달");
  t.runner.end(t.lead.id);
  // '없음'을 보는 자리다. 턴 끝 처리가 끝난 것을 확인한 뒤에 본다(처리 전에 보면 늘 비어 있다).
  await ended(t, t.lead.id);
  expect(t.store.getBoardReview(t.project.id)!.completedAt).toBeNull();
  expect(t.store.requireProject(t.project.id).tidiedAt).toBeNull();
});
