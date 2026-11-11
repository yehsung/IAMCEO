import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONDUCTOR_TOOLS, MANUAL_TOOLS, ROOT_TOOLS, WORKER_TOOLS, type Backend, type Member } from "../shared/types.ts";
import { handleAgentTool, listAgentTools } from "../server/agent-tools.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import type { AgentToolResult } from "../server/orchestrator-api.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { FilePublication } from "../server/files.ts";
import { StorageError } from "../server/storage-errors.ts";
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
  parallel: { memberId: string; on: boolean }[] = [];
  private cb: (e: RunnerEvent) => void = () => {};
  private terminals = 0;
  constructor(private readonly store: Store) {}
  async available() {
    return { ok: true };
  }
  // core 직원은 터미널 주소(paneId)를 받는다.
  async start() {
    return { sessionId: crypto.randomUUID(), paneId: `t${++this.terminals}` };
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
  // core 의 압축: 실행기가 저장소에 진행 상태를 적는다. 끝은 compacted() 다.
  async compact(m: { id: string }): Promise<SendResult> {
    const state = this.store.ensureContextState(m.id);
    this.store.saveContextState({ ...state, measurement: null, compaction: { ...state.compaction!, phase: "running" } }, { contextPct: null });
    return { ok: true, started: false };
  }
  async setParallel(m: { id: string }, on: boolean): Promise<SendResult> {
    this.parallel.push({ memberId: m.id, on });
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
  /** core 의 압축 완료: 실행기가 저장소에 결과(succeeded)를 적고 compacted 를 낸다. turn_end 는 완료 근거가 아니다. */
  compacted(memberId: string) {
    const state = this.store.ensureContextState(memberId);
    this.store.saveContextState({ ...state, compaction: { ...state.compaction!, phase: "succeeded", finishedAt: new Date().toISOString() } });
    this.cb({ type: "compacted", memberId, runId: state.compaction!.id });
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

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "iamceo-tools-"));
  const home = join(root, "work"); mkdirSync(home);
  const env = { IAMCEO_HOME: join(root, "state"), IAMCEO_PORT: "0", CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") };
  mkdirSync(env.CLAUDE_CONFIG_DIR); mkdirSync(env.CODEX_HOME);
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const runner = new FakeRunner(store);
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", runner]]) });
  const server: RunningServer = await startServer({ config, store, bus, orch });
  orch.setServerUrl(server.urls[0]!);
  cleanups.push(async () => {
    await orch.shutdown();
    await server.stop();
  });
  const project = store.createProject({ name: "시험", cwd: home });
  const lead = await orch.ensureConductor(project.id);
  // core 직원의 전달 펌프는 터미널 조작 임대 정리를 기다리는 구간이 있어 한 박자 늦게 끝난다. 띄운 직후의 펌프가 끝난 뒤에 시험을 시작한다.
  await orch.pump(lead.id);
  const call = async (member: Member, name: string, args: Record<string, unknown> = {}): Promise<AgentToolResult> => {
    const res = await fetch(`${server.urls[0]}/agent/tool`, {
      method: "POST",
      headers: { Authorization: `Bearer ${store.getMemberToken(member.id)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as AgentToolResult;
  };
  /**
   * 보고 없이 끝낸 턴의 뒤처리를 기다린다. core 에서는 그런 턴 뒤에 '보고 보완' 턴이 한 번 지나가고, 그것도 보고 없이 끝나면
   * '결과 보고 누락' 글이 남는다. 이 프로젝트에 그 글이 n 건이 되고 뒤따르는 전달 펌프가 끝나면 그 직원은 다시 쉰다.
   * 그때 서버는 일을 맡긴 총괄도 깨워 한 번 알린다. 그 글이 총괄에게 나간 것까지 확인하고 총괄의 그 턴을 끝낸 뒤에 돌아온다
   * (기다리지 않으면 뒤늦게 나간 알림이 시험이 보는 '마지막으로 보낸 글' 자리에 끼어든다).
   */
  const quiet = async (member: Member, n = 1) => {
    await until(() => store.listMessages(project.id, { limit: 500 }).filter((m) => m.title === "결과 보고 누락").length >= n, "보고 보완 지나감");
    await orch.pump(member.id);
    await until(() => missingReportNotices(runner, lead, member).length >= n, "총괄에게 누락 알림");
    runner.end(lead.id);
    await orch.pump(lead.id);
  };
  return { home, store, bus, orch, runner, server, project, lead, call, quiet };
}

/** 보고 보완 뒤에도 보고가 없을 때 서버가 총괄에게 보낸 알림(깨우는 시스템 글). */
const missingReportNotices = (runner: FakeRunner, lead: Member, member: Member) =>
  runner.sent.filter((s) => s.memberId === lead.id && s.text.includes(`[시스템] ${member.name}의 결과 보고가 보완 요청 뒤에도 없습니다(실행 `));

/** 표식을 제거해 비교하는 대신, 저장 봉투와 송신 문자열도 일치해야 한다. */
function deliveryBody(store: Store, sent: { memberId: string; text: string }): string {
  const dispatch = store.listDispatches(sent.memberId).find(d => d.wireText === sent.text)!;
  expect(dispatch).toBeDefined();
  expect(dispatch.items).toHaveLength(1);
  const delivery = store.requireDelivery(dispatch.items[0]!.deliveryId);
  expect(dispatch.markers).toEqual([{ deliveryId: delivery.id, marker: store.getDeliveryRecovery(delivery.id)!.marker! }]);
  expect(sent.text).toBe(`${delivery.text}\n${dispatch.markers[0]!.marker}\n${dispatch.bundleMarker}`);
  return delivery.text;
}

test("team_add and config writes accept catalog models/null and reject unlisted values", async () => {
  const f = await setup();
  for (const cli of ["claude", "codex"] as const) {
    const valid = cli === "claude" ? "opus" : "gpt-6.1-sol";
    const before = f.store.listMembers(f.project.id).length;
    const bad = await f.call(f.lead, "team_add", { name: "거절", role: "시험", cli, model: "unlisted" });
    expect(bad.isError).toBe(true); expect(bad.text).toContain("목록에 없는 모델입니다");
    expect(f.store.listMembers(f.project.id)).toHaveLength(before);
    for (const value of [valid, null]) {
      const name = `${cli}-${value ?? "default"}`;
      expect((await f.call(f.lead, "team_add", { name, role: "시험", cli, model: value })).isError).toBeUndefined();
      const member = f.store.listMembers(f.project.id).find(m => m.name === name)!;
      expect(member.modelOverride).toBe(value);
      // core 는 살아 있는 세션의 모델 지정을 바꾸면 세션을 새 설정으로 다시 연다. 전달 펌프가 도는 순간에는 409 로 거절하므로
      // (설정 쓰기가 끝날 때마다 펌프를 한 번 민다) 펌프가 끝난 뒤에 바꾼다.
      await f.orch.pump(member.id);
      await expect(f.orch.patchMemberConfig(member.id, { modelOverride: "unlisted" })).rejects.toMatchObject({ status: 400, message: "목록에 없는 모델입니다" });
      await f.orch.pump(member.id);
      await f.orch.patchMemberConfig(member.id, { modelOverride: valid });
      await f.orch.pump(member.id);
      await f.orch.patchMemberConfig(member.id, { modelOverride: null });
    }
    const key = cli === "claude" ? "ranks" : "codexRanks";
    await expect(f.orch.updateSettings({ [key]: { lead: { model: "unlisted" } } })).rejects.toMatchObject({ status: 400, message: "목록에 없는 모델입니다" });
    expect((await f.orch.updateSettings({ [key]: { lead: { model: valid } } }))[key].lead.model).toBe(valid);
    expect((await f.orch.updateSettings({ [key]: { lead: { model: null } } }))[key].lead.model).toBeNull();
  }
  // Updates to the same fake CLI cache immediately affect both tool/config writes.
  writeFileSync(join(f.home, "claude", ".claude.json"), JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-fable-5-1[1m]", label: "Fable" }] }));
  for (const model of ["fable", "claude-fable-5-1[1m]"]) {
    const added = await f.call(f.lead, "team_add", { name: model === "fable" ? "추가 별칭" : "추가 전체 이름", handle: model === "fable" ? "fable-short" : "fable-full", role: "시험", model });
    expect(added.isError, added.text).toBeUndefined();
    expect((await f.orch.updateSettings({ ranks: { lead: { model } } })).ranks.lead.model).toBe(model);
  }
});

describe("도구 목록", () => {
  test("역할마다 다르고 MCP 입력 스키마 모양이다", async () => {
    const { store, project, lead } = await setup();
    const names = (m: Member) => listAgentTools(m).map((t) => t.name);
    const worker = store.createMember({ projectId: project.id, handle: "w", name: "직원", kind: "worker" });
    const manual = store.createMember({ projectId: project.id, handle: "m", name: "손", kind: "worker", origin: "manual" });
    const root = store.createMember({ projectId: "hq", handle: "root", name: "본사 AI", kind: "root" });
    expect(names(worker)).toEqual([...WORKER_TOOLS]);
    expect(names(lead)).toEqual([...WORKER_TOOLS, ...CONDUCTOR_TOOLS]);
    expect(names(root)).toEqual([...WORKER_TOOLS, ...ROOT_TOOLS]);
    expect(names(manual)).toEqual([...WORKER_TOOLS, ...MANUAL_TOOLS]);
    for (const t of listAgentTools(lead)) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.$schema).toBeUndefined();
      expect(t.description.length).toBeGreaterThan(5);
    }
    const ask = listAgentTools(lead).find((t) => t.name === "ask")!.inputSchema as { required: string[] };
    expect(ask.required).toEqual(["title", "detail"]);
  });

  test("역할에 없는 도구, 모르는 도구, 모르는 인자, 빠진 인자는 거부", async () => {
    const { store, project, lead, call } = await setup();
    const worker = store.createMember({ projectId: project.id, handle: "w", name: "직원", kind: "worker" });
    expect(await call(worker, "team_add", { name: "x", role: "y" })).toMatchObject({ isError: true });
    expect(await call(lead, "project_create", { name: "x", cwd: "/" })).toMatchObject({ isError: true });
    expect(await call(lead, "wait")).toMatchObject({ isError: true });
    expect(await call(lead, "없는도구")).toMatchObject({ isError: true });
    expect(await call(worker, "status", { now: "일", 다음: "모름" })).toMatchObject({ isError: true });
    expect((await call(worker, "post", { kind: "질문", title: "물음" })).isError).toBe(true);
    expect((await call(worker, "ask", { title: "제목만" })).text).toContain("detail");
  });
});

describe("공통 도구", () => {
  test("status: 팀 카드에 지금·다음이 남는다", async () => {
    const { store, lead, call } = await setup();
    expect((await call(lead, "status", { now: "조사 중", next: "정리" })).isError).toBeUndefined();
    expect(store.requireMember(lead.id)).toMatchObject({ now: "조사 중", next: "정리" });
    await call(lead, "status", { now: "다른 일" });
    expect(store.requireMember(lead.id)).toMatchObject({ now: "다른 일", next: "정리" });
  });

  test("ask: 실행기 직원은 카드 등록 후 즉시 반환, 대기 상태", async () => {
    const { store, project, orch, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "철수", handle: "cs", role: "개발" });
    const r = await call(w, "ask", { title: "어느 쪽", detail: "배경", options: [{ k: "a", label: "가" }, { k: "b", label: "나", desc: "느림" }], rec: "a", group: "묶음" });
    expect(r.wait).toBeUndefined();
    expect(r.text).toContain("턴을 끝내세요");
    const d = store.listDecisions(project.id)[0]!;
    expect(d).toMatchObject({ title: "어느 쪽", rec: "a", group: "묶음", who: "철수", status: "open", memberId: w.id });
    expect(store.requireMember(w.id).status).toBe("waiting");
  });

  test("ask: 직접 띄운 CLI 는 기다리라고 돌려준다", async () => {
    const { store, project, call } = await setup();
    const m = store.createMember({ projectId: project.id, handle: "m", name: "손", kind: "worker", origin: "manual" });
    const r = await call(m, "ask", { title: "물음", detail: "배경" });
    expect(r.wait?.decisionId).toBe(store.listDecisions(project.id)[0]!.id);
  });

  test("ask: 권장이 선택지에 없거나 k 가 겹치거나 자료가 다른 프로젝트면 거부", async () => {
    const { store, project, lead, call } = await setup();
    const opt = [{ k: "a", label: "가" }];
    expect(await call(lead, "ask", { title: "t", detail: "d", options: opt, rec: "z" })).toMatchObject({ isError: true });
    expect(await call(lead, "ask", { title: "t", detail: "d", options: [...opt, ...opt] })).toMatchObject({ isError: true });
    const other = store.createProject({ name: "다른", cwd: "/tmp" });
    const foreign = store.createFile({ projectId: other.id, title: "남의 자료" });
    expect(await call(lead, "ask", { title: "t", detail: "d", file_id: foreign.id })).toMatchObject({ isError: true });
    expect(store.listDecisions(project.id)).toHaveLength(0);
  });

  test("post: 대화에 남고 직원 보고는 총괄을 깨우거나 쌓는다", async () => {
    const { store, project, orch, lead, runner, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "철수", handle: "cs", role: "개발" });
    const file = store.createFile({ projectId: project.id, title: "보고서" });
    await call(w, "post", { kind: "진행", title: "반쯤" });
    expect(runner.sent).toHaveLength(0);
    expect(store.listPending(lead.id)).toHaveLength(1);
    const r = await call(w, "post", { kind: "완료", title: "다 했다", body: "핵심", file_ids: [file.id] });
    expect(r.isError).toBeUndefined();
    const messages = store.listMessages(project.id);
    expect(messages.at(-1)).toMatchObject({ kind: "완료", who: "철수", title: "다 했다", fileId: file.id });
    expect(runner.sent).toHaveLength(1);
    expect(runner.sent[0]!.text).toContain("[보고 철수] 완료: 다 했다");
    expect(runner.sent[0]!.text).toContain("[보고 철수] 진행: 반쯤");
    expect(await call(w, "post", { kind: "완료", title: "t", file_ids: ["f_없음"] })).toMatchObject({ isError: true });
  });

  // 옛 시험: "거부된 post 는 보고로 치지 않아 턴 마지막 글이 자동 보고된다"
  test("거부된 post 는 보고로 치지 않아 보고 보완을 요청받는다", async () => {
    const { store, project, orch, runner, lead, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "철수", handle: "cs", role: "개발", firstInstruction: "일" });
    await until(() => runner.sent.some((s) => s.memberId === w.id), "첫 지시 전달");
    expect(await call(w, "post", { kind: "완료", title: "t", file_ids: ["f_없음"] })).toMatchObject({ isError: true });
    runner.end(w.id);
    // 달라진 점: 옛 실행기는 턴의 마지막 글을 '(자동) …' 알림으로 올렸다. core 는 마지막 글을 받지 못한다.
    // 대신 보고 없이 끝난 실행으로 보고(거부된 post 는 보고가 아니다) 보고 보완을 한 번 요청한다.
    await until(() => runner.nudges.length === 1, "보고 보완");
    expect(runner.nudges[0]).toMatchObject({ memberId: w.id });
    expect(store.listMessages(project.id).some((m) => m.memberId === w.id)).toBe(false);
    // 보완 턴도 보고 없이 끝났다(가짜 실행기는 곧바로 끝낸다). 대화에 누락 글이 남고, 일을 맡긴 총괄이 깨어나 한 번 알림을 받는다.
    await until(() => missingReportNotices(runner, lead, w).length === 1, "총괄에게 누락 알림");
    expect(store.listMessages(project.id).filter((m) => m.title === "결과 보고 누락")).toHaveLength(1);
    const notice = store.listDeliveries(project.id).find((d) => d.memberId === lead.id && d.text.includes("결과 보고가 보완 요청 뒤에도 없습니다"))!;
    expect(notice).toMatchObject({ kind: "system", wake: true });
    expect(notice.text).toContain(`(실행 ${/실행 (\S+)의 결과만/.exec(runner.nudges[0]!.text)![1]})`);
    // 알림으로 깬 총괄이 보고 없이 턴을 끝내도 총괄에게 보고 보완을 묻지 않고, 알림도 되풀이하지 않는다.
    runner.end(lead.id);
    await orch.pump(lead.id);
    await Bun.sleep(40); // '없음'을 보는 대기: 이 사이에 보완·알림이 더 오지 않았음을 아래에서 본다.
    expect(runner.nudges).toHaveLength(1);
    expect(missingReportNotices(runner, lead, w)).toHaveLength(1);
    expect(runner.sent.filter((s) => s.memberId === lead.id)).toHaveLength(1);
    expect(store.listMessages(project.id).filter((m) => m.title === "결과 보고 누락")).toHaveLength(1);
  });

  test("file: 글·md 경로·첨부·이미지", async () => {
    const { home, store, project, lead, call } = await setup();
    const docs = join(home, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "r.md"), "# 보고서 본문");
    writeFileSync(join(docs, "d.csv"), "a,b\n");
    writeFileSync(join(docs, "p.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const id = (r: AgentToolResult) => /#(f_\S+?)\./.exec(r.text)![1]!;

    const a = store.getFile(id(await call(lead, "file", { title: "글", summary: "요약", content: "전문" })))!;
    expect(a).toMatchObject({ title: "글", summary: "요약", body: "전문", who: lead.name, path: null, memberId: lead.id });

    const b = store.getFile(id(await call(lead, "file", { title: "md", path: join(docs, "r.md") })))!;
    expect(b).toMatchObject({ body: "# 보고서 본문", path: join(docs, "r.md"), attachments: [] });

    const c = store.getFile(id(await call(lead, "file", { title: "표", path: "docs/d.csv", images: [join(docs, "p.png")] })))!;
    expect(c.kind).toBe("table");
    expect(c.body).toBe("a,b\n");
    expect(c.attachments.map((x) => [x.name, x.isImage])).toEqual([["d.csv", false], ["p.png", true]]);
    expect(existsSync(c.attachments[0]!.path)).toBe(true);
    expect(c.attachments[0]!.path).toStartWith(join(home, "..", "state", "uploads"));

    expect(await call(lead, "file", { title: "둘 다", path: "docs/r.md", content: "x" })).toMatchObject({ isError: true });
    expect(await call(lead, "file", { title: "없음" })).toMatchObject({ isError: true });
    expect(await call(lead, "file", { title: "없는 파일", path: "없다.png" })).toMatchObject({ isError: true });
    expect(await call(lead, "file", { title: "그림 아님", images: [join(docs, "d.csv")] })).toMatchObject({ isError: true });
    expect(store.listFiles(project.id)).toHaveLength(3);
  });

  test("file: 후반의 잘못된 이미지·없는 경로는 첨부와 staging을 전혀 만들지 않는다", async () => {
    const { home, store, lead, call } = await setup();
    const image = join(home, "ok.png");
    const csv = join(home, "data.csv");
    writeFileSync(image, "image");
    writeFileSync(csv, "a,b");
    const before = existsSync(join(home, "..", "state", "uploads")) ? readdirSync(join(home, "..", "state", "uploads")) : [];
    for (const images of [[image, csv], [image, join(home, "missing.png")]]) {
      expect(await call(lead, "file", { title: "거부", path: csv, images })).toMatchObject({ isError: true });
    }
    expect(store.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    expect(readdirSync(join(home, "..", "state", "uploads"))).toEqual(before);
  });

  test("file: 두 번째 복사 실패는 게시하지 않고 실패 staging만 남긴다", async () => {
    const { home, store, lead, orch, project } = await setup();
    const images = [join(home, "first.png"), join(home, "second.png")];
    for (const path of images) writeFileSync(path, "image");
    const original = FilePublication.prototype.stagePath;
    let count = 0;
    const stage = spyOn(FilePublication.prototype, "stagePath").mockImplementation(async function (this: FilePublication, input) {
      const saved = await original.call(this, input);
      if (++count === 1) unlinkSync(images[1]!);
      return saved;
    });
    try { await expect(handleAgentTool(orch, lead, "file", { title: "실패", images })).rejects.toThrow(); }
    finally { stage.mockRestore(); }
    expect(store.listFiles(project.id)).toHaveLength(0);
    expect(store.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    expect(readdirSync(join(home, "..", "state", "uploads")).filter((name) => !name.startsWith("."))).toEqual([]);
    const staging = join(home, "..", "state", "uploads", ".staging");
    const manifest = JSON.parse(readFileSync(join(staging, readdirSync(staging)[0]!, "manifest.json"), "utf8"));
    expect(manifest.state).toBe("failed");
    expect(manifest.files).toHaveLength(2);
  });

  test("file: 자료 INSERT 실패는 첨부 INSERT도 rollback하고 기존 초안을 보존한다", async () => {
    const { home, store, bus, lead, orch, project } = await setup();
    const priorPath = join(home, "prior.png");
    writeFileSync(priorPath, "draft");
    const prior = store.createAttachment({ id: "a_draft", name: "prior.png", path: priorPath, size: 5, mime: "image/png" });
    const images = [join(home, "first.png"), join(home, "second.png")];
    for (const path of images) writeFileSync(path, "image");
    const events: unknown[] = [];
    const emit = spyOn(bus, "emit").mockImplementation((event) => { events.push(event); });
    store.db.exec("CREATE TRIGGER fail_file BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'publication failure'); END");
    try { await expect(handleAgentTool(orch, lead, "file", { title: "실패", images })).rejects.toThrow("publication failure"); }
    finally { emit.mockRestore(); }
    expect(events).toEqual([]);
    expect(store.listFiles(project.id)).toHaveLength(0);
    expect(store.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 1 });
    expect(store.getAttachment(prior.id)).toEqual(prior);
    expect(readFileSync(priorPath, "utf8")).toBe("draft");
    expect(readdirSync(join(home, "..", "state", "uploads")).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  test("file: 두 번째 첨부 INSERT 실패도 앞 첨부와 자료를 모두 rollback한다", async () => {
    const { home, store, lead, orch } = await setup();
    const images = [join(home, "one.png"), join(home, "two.png")];
    for (const path of images) writeFileSync(path, "image");
    store.db.exec("CREATE TRIGGER fail_second_attachment BEFORE INSERT ON attachments WHEN (SELECT COUNT(*) FROM attachments) > 0 BEGIN SELECT RAISE(ABORT, 'second attachment failure'); END");
    await expect(handleAgentTool(orch, lead, "file", { title: "실패", images })).rejects.toThrow("second attachment failure");
    expect(store.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    expect(readdirSync(join(home, "..", "state", "uploads")).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  test("file: SQLITE_FULL은 성공이 아닌 storage_full로 남고 새 파일은 staging으로 복귀한다", async () => {
    const { home, store, lead, orch } = await setup();
    const path = join(home, "full.png");
    writeFileSync(path, "image");
    const insert = spyOn(store, "createFile").mockImplementation(() => { throw Object.assign(new Error("full"), { code: "SQLITE_FULL" }); });
    try {
      await expect(handleAgentTool(orch, lead, "file", { title: "실패", path })).rejects.toBeInstanceOf(StorageError);
    } finally { insert.mockRestore(); }
    expect(store.db.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
    expect(readdirSync(join(home, "..", "state", "uploads")).filter((name) => !name.startsWith("."))).toEqual([]);
  });

  test("todo: 내 할 일에 오르고 끝내면 요청자에게 전달", async () => {
    const { store, project, orch, runner, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "철수", handle: "cs", role: "개발" });
    await call(w, "todo", { title: "로그인", detail: "폰으로" });
    const todo = store.listTodos(project.id)[0]!;
    expect(todo).toMatchObject({ title: "로그인", detail: "폰으로", who: "철수", memberId: w.id, done: false });
    await orch.setTodoDone(todo.id, true);
    expect(deliveryBody(store, runner.sent.at(-1)!)).toBe(`[대표] '로그인' 했음 #${todo.id}`);
  });
});

describe("총괄 도구", () => {
  test("team_add: 띄우고 첫 지시·역할을 넣는다, 이름·핸들 겹치면 거부", async () => {
    const { store, project, runner, lead, call } = await setup();
    const r = await call(lead, "team_add", { name: "철수", role: "개발", handle: "cs", first_instruction: "로그인 고치기" });
    expect(r.text).toContain("철수(cs)");
    const w = store.findMember(project.id, "cs")!;
    expect(w).toMatchObject({ role: "개발", kind: "worker", origin: "runner", status: "working" });
    expect(runner.sent[0]!.memberId).toBe(w.id);
    expect(deliveryBody(store, runner.sent[0]!)).toBe("[총괄] 철수에게\n할 일: 로그인 고치기");
    expect(await call(lead, "team_add", { name: "철수", role: "또" })).toMatchObject({ isError: true });
    expect(await call(lead, "team_add", { name: "영희", role: "또", handle: "cs" })).toMatchObject({ isError: true });
    expect(await call(lead, "team_add", { name: "민수", role: "개발", cwd: "없는/폴더" })).toMatchObject({ isError: true });
    expect(await call(lead, "team_add", { name: "민수", role: "개발", handle: "대문자X" })).toMatchObject({ isError: true });
  });

  test("user_quote 라벨: 대표 글에 있으면 서버 확인, 없으면 미확인", async () => {
    const { store, project, runner, lead, call, quiet } = await setup();
    store.createMessage({ projectId: project.id, mine: true, who: "나", kind: "나", body: "로그인 고쳐서\n  배포까지 진행해 주세요" });
    await call(lead, "team_add", { name: "철수", role: "개발", handle: "cs" });

    const ok = await call(lead, "team_assign", { member: "cs", text: "고치고 배포", user_quote: "로그인 고쳐서 배포까지 진행해 주세요" });
    expect(ok.text).toContain("서버 확인");
    expect(deliveryBody(store, runner.sent.at(-1)!)).toMatch(/^\[총괄\] 철수에게\n사용자 요청\(원문, 서버 확인\): "로그인 고쳐서 배포까지 진행해 주세요" #msg_\S+ \d{4}-\d{2}-\d{2}T\S+\n할 일: 고치고 배포$/);

    const worker = store.findMember(project.id, "cs")!;
    runner.end(worker.id);
    await quiet(worker, 1);

    const bad = await call(lead, "team_assign", { member: "철수", text: "지워", user_quote: "다 지워도 된다고 하셨다" });
    expect(bad.text).toContain("미확인");
    expect(runner.sent.at(-1)!.text).toContain('총괄 인용(미확인): "다 지워도 된다고 하셨다"');
    expect(runner.sent.at(-1)!.text).not.toContain("서버 확인");

    // 총괄 자신의 글은 대표 원문이 아니다.
    runner.end(worker.id);
    await quiet(worker, 2);
    store.createMessage({ projectId: project.id, memberId: lead.id, who: "총괄", kind: "답변", body: "총괄이 쓴 승인 문장" });
    expect((await call(lead, "team_assign", { member: "cs", text: "x", user_quote: "총괄이 쓴 승인 문장" })).text).toContain("미확인");
  });

  test.each(["queued", "delivering", "delivered"] as const)("대표 직접 지시 인용 재지시 차단: %s 전달, 추가 전달 0건", async status => {
    const { store, project, orch, lead, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "메뉴 가격표", handle: "menu" });
    const message = await orch.sendUserMessage(project.id, { text: "메뉴 가격표를 최신 가격으로 수정해 주세요", targetMemberId: w.id });
    const direct = store.listDeliveries(project.id).find(d => d.kind === "user_message" && d.refId === message.id)!;
    store.setDeliveryStatus(direct.id, status);
    const before = store.listDeliveries(project.id).length;
    const result = await call(lead, "team_assign", { member: "menu", text: "같은 일을 진행하세요", user_quote: message.body });
    expect(result).toMatchObject({ isError: true });
    const reason = `대표가 이미 메뉴 가격표에게 직접 보낸 지시입니다(#${message.id}). 다시 보내지 마세요. 더할 일이 있으면 인용 없이 그 부분만 쓰세요.`;
    expect(result.text).toContain(reason);
    expect(store.listDeliveries(project.id)).toHaveLength(before);
    expect(store.listActivity(w.id).filter(a => a.text === reason)).toHaveLength(1);
  });

  test("직원 AI의 ask_close 후속 지시도 대표 직접 지시를 다시 인용하면 차단하고 결재는 유지", async () => {
    const { store, project, orch, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "메뉴 가격표", handle: "menu" });
    const { decision } = await orch.registerAsk(w, { title: "메뉴 가격을 바꿀까요?" });
    const message = await orch.sendUserMessage(project.id, { text: "대표가 가격을 정했으니 메뉴 가격표를 최신 가격으로 수정해 주세요", targetMemberId: w.id });
    const before = store.listDeliveries(project.id).length;
    const result = await call(w, "ask_close", { id: decision.id, kind: "decided", reason: "대표가 직접 결정", user_quote: message.body,
      follow_up: { kind: "instruction", member_id: w.id, text: "가격표를 수정하세요", source_message_id: message.id } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`대표가 이미 메뉴 가격표에게 직접 보낸 지시입니다(#${message.id})`);
    expect(store.listDeliveries(project.id)).toHaveLength(before);
    expect(store.getDecision(decision.id)!.status).toBe("open");
    expect(store.listActivity(w.id).filter(a => a.text.includes(`직접 보낸 지시입니다(#${message.id})`))).toHaveLength(1);
  });

  test("대표 직접 지시 인용을 다른 직원에게 전달하는 것은 허용", async () => {
    const { store, project, orch, lead, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "메뉴 가격표", handle: "menu" });
    const { member: other } = await orch.addMember(project.id, { name: "검토", handle: "review" });
    const message = await orch.sendUserMessage(project.id, { text: "메뉴 가격표를 최신 가격으로 수정해 주세요", targetMemberId: w.id });
    const result = await call(lead, "team_assign", { member: "review", text: "수정 결과를 검토하세요", user_quote: message.body });
    expect(result.isError).not.toBe(true);
    expect(store.listDeliveries(project.id).filter(d => d.memberId === other.id && d.kind === "instruction")).toHaveLength(1);
  });

  test("총괄에게 온 대표 글 인용과 인용 없는 별개 지시는 허용", async () => {
    const { store, project, orch, lead, call } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "메뉴 가격표", handle: "menu" });
    await orch.sendUserMessage(project.id, { text: "메뉴 가격표를 수정해 주세요", targetMemberId: w.id });
    const message = await orch.sendUserMessage(project.id, { text: "직원에게 다음 달 메뉴도 준비하도록 맡겨 주세요", targetMemberId: lead.id });
    expect((await call(lead, "team_assign", { member: "menu", text: "다음 달 메뉴 준비", user_quote: message.body })).isError).not.toBe(true);
    expect((await call(lead, "team_assign", { member: "menu", text: "추가로 가격 변경 이력만 기록하세요" })).isError).not.toBe(true);
    expect(store.listDeliveries(project.id).filter(d => d.memberId === w.id && d.kind === "instruction")).toHaveLength(2);
  });

  test("대표 직접 지시와 결재 답 알림은 이미 전달했으며 결과를 기다리라고 안내", async () => {
    const { store, project, orch, lead } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "메뉴 가격표", handle: "menu" });
    const message = await orch.sendUserMessage(project.id, { text: "가격을 수정해 주세요", targetMemberId: w.id });
    const notices = () => store.listDeliveries(project.id).filter(d => d.memberId === lead.id && d.kind === "system");
    expect(notices().find(d => d.text.includes(`#${message.id}`))).toMatchObject({ wake: false,
      text: `[시스템] 대표가 메뉴 가격표에게 직접 지시했습니다 #${message.id}. 이미 메뉴 가격표에게 전달했습니다. 같은 일을 다시 시키지 말고, 결과 보고를 기다려 판만 맞추세요.` });
    const { decision } = await orch.registerAsk(w, { title: "가격을 적용할까요?", options: [{ k: "y", label: "적용하세요" }] });
    await orch.answerDecision(decision.id, { choice: "y" });
    expect(notices().find(d => d.text.includes("결재에 답했습니다"))).toMatchObject({ wake: false });
    expect(notices().find(d => d.text.includes("결재에 답했습니다"))!.text).toContain("이미 메뉴 가격표에게 전달했습니다. 같은 일을 다시 시키지 말고, 결과 보고를 기다려 판만 맞추세요.");
  });

  test("user_quote: 결재 답의 버튼 글은 맞아도 '문맥 확인 필요'이고 카드 제목·id 가 함께 간다", async () => {
    const { store, project, orch, runner, lead, call, quiet } = await setup();
    const { member: w } = await orch.addMember(project.id, { name: "철수", handle: "cs", role: "개발" });
    await call(w, "ask", { title: "배포?", detail: "d", options: [{ k: "y", label: "지금 배포하세요" }] });
    await orch.answerDecision(store.listDecisions(project.id)[0]!.id, { choice: "y" });
    await until(() => runner.sent.some((s) => s.memberId === w.id), "답 전달");
    runner.end(w.id);
    await quiet(w, 1);
    const d = store.listDecisions(project.id)[0]!;
    expect((await call(lead, "team_assign", { member: "cs", text: "배포", user_quote: "지금 배포하세요" })).text).toContain("문맥 확인 필요");
    const sent = runner.sent.at(-1)!.text;
    expect(sent).toContain(`사용자 요청(문맥 확인 필요): "지금 배포하세요" 결재 #${d.id} '배포?'에서 고른 답`);
    expect(sent).not.toContain("서버 확인");
  });

  test("team_assign: 일하는 중이면 대기열 위치를 알려 주고 끝나면 전달", async () => {
    const { store, project, runner, lead, call } = await setup();
    await call(lead, "team_add", { name: "철수", role: "개발", handle: "cs", first_instruction: "첫 일" });
    const w = store.findMember(project.id, "cs")!;
    const r = await call(lead, "team_assign", { member: "cs", text: "둘째 일" });
    expect(r.text).toContain("대기열 1번째");
    expect((await call(lead, "team_assign", { member: "cs", text: "셋째 일" })).text).toContain("대기열 2번째");
    expect(store.requireMember(w.id).queuedCount).toBe(2);
    expect(JSON.parse((await call(lead, "roster")).text).find((m: { handle: string }) => m.handle === "cs")).toMatchObject({ status: "working", queued: 2 });
    expect(runner.sent).toHaveLength(1);
    runner.end(w.id);
    await until(() => runner.sent.length >= 2, "기다리던 지시 전달");
    expect(runner.sent[1]!.text).toContain("둘째 일");
    expect(runner.sent[1]!.text).toContain("셋째 일");
  });

  test("team_assign: parallel 이 다를 때만 먼저 바꾼다", async () => {
    const { store, project, runner, lead, call, quiet } = await setup();
    await call(lead, "team_add", { name: "철수", role: "개발", handle: "cs" });
    const w = store.findMember(project.id, "cs")!;
    await call(lead, "team_assign", { member: "cs", text: "큰 일", parallel: true });
    expect(runner.parallel).toEqual([{ memberId: w.id, on: true }]);
    expect(store.requireMember(w.id).parallel).toBe(true);
    runner.end(w.id);
    await quiet(w, 1);
    await call(lead, "team_assign", { member: "cs", text: "또 큰 일", parallel: true });
    expect(runner.parallel).toHaveLength(1);
  });

  test("다른 프로젝트 멤버 지정은 거부", async () => {
    const { store, orch, lead, runner, call } = await setup();
    const other = store.createProject({ name: "다른", cwd: "/tmp" });
    const { member: stranger } = await orch.addMember(other.id, { name: "남", handle: "stranger", role: "개발" });
    for (const [name, args] of [
      ["team_assign", { member: "stranger", text: "일" }],
      ["team_assign", { member: "남", text: "일" }],
      ["team_compact", { member: "stranger" }],
      ["team_sleep", { member: "stranger" }],
      ["team_resume", { member: "stranger" }],
      ["team_close", { member: "stranger" }],
    ] as const) {
      const r = await call(lead, name, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("이 프로젝트에 없는 직원");
    }
    expect(runner.sent).toHaveLength(0);
    expect(store.getMember(stranger.id)).not.toBeNull();
  });

  test("자기 자신에게 시키거나 재우거나 닫을 수 없다", async () => {
    const { store, lead, call } = await setup();
    for (const name of ["team_sleep", "team_close", "team_resume"]) {
      expect(await call(lead, name, { member: "lead" })).toMatchObject({ isError: true, text: "자기 자신은 지정할 수 없습니다" });
    }
    expect(await call(lead, "team_assign", { member: "lead", text: "일" })).toMatchObject({ isError: true, text: "자기 자신은 지정할 수 없습니다" });
    expect(store.getMember(lead.id)).not.toBeNull();
  });

  test("team_sleep·resume·close·compact", async () => {
    const { store, project, runner, lead, call, quiet } = await setup();
    await call(lead, "team_add", { name: "철수", role: "개발", handle: "cs", first_instruction: "일" });
    const w = store.findMember(project.id, "cs")!;
    expect(await call(lead, "team_sleep", { member: "cs" })).toMatchObject({ isError: true });
    runner.end(w.id);
    await quiet(w, 1);
    expect((await call(lead, "team_compact", { member: "cs", focus: "요약" })).isError).toBeUndefined();
    // 달라진 점: 옛 실행기는 압축 턴도 turn_end 로 끝났다. core 는 실행기가 남긴 압축 결과(compacted)로 끝난다.
    await until(() => store.getContextState(w.id)?.compaction?.phase === "running", "압축 시작");
    runner.compacted(w.id);
    await until(() => store.requireMember(w.id).status === "idle", "압축 끝");
    expect((await call(lead, "team_sleep", { member: "cs" })).isError).toBeUndefined();
    expect(store.requireMember(w.id).status).toBe("asleep");
    expect((await call(lead, "team_resume", { member: "철수", first_instruction: "다시" })).isError).toBeUndefined();
    expect(store.requireMember(w.id).status).not.toBe("asleep");
    await until(() => runner.sent.at(-1)!.text.includes("할 일: 다시"), "다시 지시 전달");
    expect(runner.sent.at(-1)!.text).toContain("할 일: 다시");
    runner.end(w.id);
    await quiet(w, 2);
    expect((await call(lead, "team_close", { member: "cs" })).isError).toBeUndefined();
    expect(store.getMember(w.id)).toBeNull();
  });

  test("project_now·work_set·roster", async () => {
    const { store, project, lead, call } = await setup();
    await call(lead, "project_now", { text: "지금 상황 글" });
    expect(store.requireProject(project.id).now).toBe("지금 상황 글");
    const id = /#(w_\S+)/.exec((await call(lead, "work_set", { sec: "doing", title: "일", who: "철수" })).text)![1]!;
    await call(lead, "work_set", { id, sec: "done", title: "일" });
    expect(store.getWork(id)).toMatchObject({ sec: "done", who: "철수" });
    expect(store.getWork(id)!.doneAt).not.toBeNull();
    expect(await call(lead, "work_set", { id: "w_없음", sec: "done", title: "일" })).toMatchObject({ isError: true });
    expect(await call(lead, "work_set", { sec: "모름", title: "일" })).toMatchObject({ isError: true });
    expect(JSON.parse((await call(lead, "roster")).text)[0]).toMatchObject({ handle: "lead", kind: "conductor" });
  });
});

describe("본사 AI 도구", () => {
  async function root(t: Awaited<ReturnType<typeof setup>>) {
    return t.orch.ensureConductor("hq");
  }

  test("project_create·project_list: 총괄까지 띄우고 목표를 넘긴다", async () => {
    const t = await setup();
    const hq = await root(t);
    const dir = join(t.home, "새일");
    mkdirSync(dir);
    expect(await t.call(hq, "project_create", { name: "새 일", cwd: join(t.home, "없다") })).toMatchObject({ isError: true });
    const r = await t.call(hq, "project_create", { name: "새 일", cwd: dir, goal: "목표 글", start_conductor: true });
    expect(r.isError).toBeUndefined();
    const created = t.store.listProjects().find((p) => p.name === "새 일")!;
    expect(created).toMatchObject({ cwd: dir, now: "목표 글", runnerEnabled: true });
    const lead = t.store.getConductor(created.id)!;
    expect(lead.kind).toBe("conductor");
    expect(t.runner.sent.at(-1)).toMatchObject({ memberId: lead.id });
    expect(t.runner.sent.at(-1)!.text).toContain("프로젝트 목표: 목표 글");
    expect(await t.call(hq, "project_create", { name: "새 일", cwd: dir })).toMatchObject({ isError: true });
    const list = JSON.parse((await t.call(hq, "project_list")).text) as { id: string; cwd: string }[];
    expect(list.find((p) => p.id === created.id)!.cwd).toBe(dir);
    expect(list.some((p) => p.id === "hq")).toBe(true);
  });
});

describe("직접 띄운 CLI", () => {
  test("wait: 밀린 지시를 받고, 없으면 시간 뒤 없다고 돌아오고, 도착하면 깨어난다", async () => {
    const { store, project, orch, lead, call } = await setup();
    const m = store.createMember({ projectId: project.id, handle: "m", name: "손", kind: "worker", origin: "manual" });
    await call(lead, "team_assign", { member: "m", text: "밀린 일" });
    expect((await call(m, "wait")).text).toContain("할 일: 밀린 일");
    expect((await call(m, "wait", { timeout_sec: 1 })).text).toContain("새 지시가 없습니다");
    const waiting = call(m, "wait", { timeout_sec: 10 });
    await Bun.sleep(30); // 기다림(롱폴)이 서버에 걸릴 틈을 준다. 값을 기다리는 자리가 아니다: 먼저 도착해도 wait 는 그 지시를 받는다.
    await orch.assign(project.id, "m", { text: "새 일" });
    expect((await waiting).text).toContain("할 일: 새 일");
    expect(await call(m, "wait", { timeout_sec: 999 })).toMatchObject({ isError: true });
  });
});

describe("handleAgentTool", () => {
  test("ApiError 가 아닌 오류는 숨기지 않는다", async () => {
    const { lead, store } = await setup();
    const broken = { store, recordPost: async () => { throw new Error("버그"); } } as unknown as Orchestrator;
    await expect(handleAgentTool(broken, lead, "post", { kind: "완료", title: "t" })).rejects.toThrow("버그");
  });
});
