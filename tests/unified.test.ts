// 설정 통일·연결 상태·직급별 모델·자료 종류(spec §3·§5·§6·§7). 실행기는 가짜, 저장소·전달 펌프·도구·HTTP 는 진짜다.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Backend, Member, ProjectSummary, WsEvent } from "../shared/types.ts";
import { DEFAULT_RANKS, fileKindOf, memberConfig, memberRank } from "../shared/types.ts";
import { handleAgentTool } from "../server/agent-tools.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { MAX_ARTIFACT_BYTES } from "../server/files.ts";
import { startServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { renderRole } from "../server/roles.ts";
import { buildClaudeArgs, childEnv, HeadlessRunner, StreamParser } from "../server/runner/headless.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { ApiError, Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const FAKE = resolve(import.meta.dir, "fixtures", "fake-claude.ts");

class FakeRunner implements Runner {
  kind: Backend;
  health: { ok: boolean; detail?: string } = { ok: true };
  sent: { memberId: string; text: string; m: RunnerMember }[] = [];
  starts: RunnerMember[] = [];
  stops: string[] = [];
  applied: RunnerMember[] = [];
  applyResults: SendResult[] = [];
  autoBusy = false;
  busy = new Set<string>();
  cb: (e: RunnerEvent) => void = () => {};
  applyConfig?: (m: RunnerMember, o: StartOpts) => Promise<SendResult>;
  constructor(kind: Backend, withApply = kind === "herdr") {
    this.kind = kind;
    if (withApply) {
      this.applyConfig = async (m) => {
        this.applied.push(m);
        return this.applyResults.shift() ?? { ok: true };
      };
    }
  }
  async available() {
    return this.health;
  }
  async start(m: RunnerMember) {
    this.starts.push(m);
    return { sessionId: m.sessionId ?? crypto.randomUUID(), paneId: this.kind === "herdr" ? `w1:p${this.starts.length}` : null, tabId: this.kind === "herdr" ? "w1:t1" : null };
  }
  async send(m: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ memberId: m.id, text, m });
    if (this.autoBusy) this.busy.add(m.id);
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
  async stop(m: RunnerMember) {
    this.stops.push(m.id);
    this.busy.delete(m.id);
  }
  async screen() {
    return "";
  }
  on(cb: (e: RunnerEvent) => void) {
    this.cb = cb;
  }
  async shutdown() {}
  async reattach(m: RunnerMember) {
    return { paneId: m.paneId ?? "w1:p9", tabId: "w1:t1" };
  }
  async adopt() {
    return { sessionId: "33333333-3333-4333-8333-333333333333", paneId: "w1:p7", tabId: "w1:t1" };
  }
  end(memberId: string) {
    this.busy.delete(memberId);
    this.cb({ type: "turn_end", memberId, finalText: "", isError: false });
  }
}

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
});

async function setup(opts: { backend?: Backend | null; runnerEnabled?: boolean } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-unified-")));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-unified-work-")));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0", CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex") };
  mkdirSync(env.CLAUDE_CONFIG_DIR); mkdirSync(env.CODEX_HOME);
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-fable-5-1[1m]", label: "Fable" }] }));
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"], claudeBin: "/bin/false" }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const events: WsEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const store = new Store(openDb(config.dbPath), bus);
  const herdr = new FakeRunner("herdr");
  const headless = new FakeRunner("headless");
  const backend = opts.backend === undefined ? "herdr" : opts.backend;
  if (backend) store.patchSettings({ backend });
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["herdr", herdr], ["headless", headless]]), timings: { tickMs: 60_000, retryMs: 10, inputBusyRetryMs: 10, healthMs: 60_000 } });
  closers.push(() => orch.shutdown());
  const server = await startServer({ config, store, bus, orch });
  closers.push(() => server.stop());
  if (server.port === 7878) { await server.stop(); throw new Error("Fixture allocated live port"); }
  orch.setServerUrl(server.urls[0]!);
  const base = server.urls[0]!;
  const project = store.createProject({ name: "시험", cwd: work, runnerEnabled: opts.runnerEnabled ?? true });
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Authorization: "Bearer code", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const call = (member: Member, name: string, args: Record<string, unknown>) => handleAgentTool(orch, store.requireMember(member.id), name, args);
  return { home, work, config, store, orch, herdr, headless, project, api, base, events, call };
}

const until = async (cond: () => boolean, label = "조건", ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${label} 시간 초과`);
    await Bun.sleep(5);
  }
};

describe("연결 상태", () => {
  test("Project·ProjectSummary 에 connection: 켜짐·꺼짐·보관·실행기 없음·직접 띄운 세션", async () => {
    const t = await setup();
    const summary = (id: string) => t.store.projectSummaries().find((s) => s.id === id) as ProjectSummary;
    expect(t.project.connection).toEqual({ ok: true, reason: null, detail: null });
    expect(summary(t.project.id).connection.ok).toBe(true);

    const off = t.store.createProject({ name: "꺼짐", cwd: t.work, runnerEnabled: false });
    expect(off.connection).toMatchObject({ ok: false, reason: "runner_off" });
    expect(off.connection.detail).toContain("총괄을 시작");
    expect(summary(off.id).connection.reason).toBe("runner_off");

    const manual = t.store.createMember({ projectId: off.id, handle: "m1", name: "직접", kind: "worker", origin: "manual", status: "idle" });
    expect(t.store.requireProject(off.id).connection.ok).toBe(true);
    t.store.patchMember(manual.id, { status: "offline" });
    expect(t.store.requireProject(off.id).connection.reason).toBe("runner_off");

    const archived = t.store.patchProject(off.id, { archived: true });
    expect(archived.connection).toMatchObject({ ok: false, reason: "archived" });

    t.herdr.health = { ok: false, detail: "herdr 서버에 연결할 수 없습니다" };
    await t.orch.refreshConnection();
    expect(t.store.requireProject(t.project.id).connection).toMatchObject({ ok: false, reason: "backend_down" });
    expect(t.store.requireProject("hq").connection.reason).toBe("backend_down");
    expect(t.store.requireProject(t.project.id).connection.detail).toContain("herdr 서버에 연결할 수 없습니다");
  });

  test("실행기가 꺼지거나 켜지면 projects·project 를 방송하고, 켜지면 보류된 것을 민다", async () => {
    const t = await setup();
    await t.orch.refreshConnection();
    t.events.length = 0;
    t.herdr.health = { ok: false, detail: "꺼짐" };
    await t.orch.refreshConnection();
    expect(t.events.some((e) => e.type === "project" && e.project.id === t.project.id && e.project.connection.reason === "backend_down")).toBe(true);
    expect(t.events.some((e) => e.type === "projects" && e.projects.every((p) => !p.connection.ok))).toBe(true);
    t.events.length = 0;
    await t.orch.refreshConnection();
    expect(t.events.filter((e) => e.type === "projects")).toHaveLength(0);
    t.herdr.health = { ok: true };
    await t.orch.refreshConnection();
    expect(t.events.some((e) => e.type === "project" && e.project.id === t.project.id && e.project.connection.ok)).toBe(true);
  });

  test("연결 전에는 메시지·결재 답·첨부를 409 로 거부한다. 내 할 일 체크와 에이전트 ask 는 된다", async () => {
    const t = await setup({ runnerEnabled: false });
    const pid = t.project.id;
    const message = await t.api("POST", `/api/projects/${pid}/messages`, { text: "안녕" });
    expect(message.status).toBe(409);
    expect(message.body.error).toContain("총괄을 시작");
    expect(t.store.listMessages(pid)).toHaveLength(0);

    const decision = t.store.createDecision({ projectId: pid, who: "x", title: "고르세요", options: [{ k: "a", label: "에이" }] });
    const answer = await t.api("POST", `/api/decisions/${decision.id}/answer`, { choice: "a" });
    expect(answer.status).toBe(409);
    expect(t.store.requireDecision(decision.id).status).toBe("open");

    const form = new FormData();
    form.set("file", new File(["x"], "a.txt", { type: "text/plain" }));
    const up = await fetch(`${t.base}/api/uploads?project=${pid}`, { method: "POST", headers: { Authorization: "Bearer code" }, body: form });
    expect(up.status).toBe(409);
    expect((await fetch(`${t.base}/api/uploads`, { method: "POST", headers: { Authorization: "Bearer code" }, body: form })).status).toBe(200);

    const todo = t.store.createTodo({ projectId: pid, title: "로그인" });
    expect((await t.api("POST", `/api/todos/${todo.id}/done`, { done: true })).status).toBe(200);

    const manual = t.store.createMember({ projectId: pid, handle: "m1", name: "직접", kind: "worker", origin: "manual", status: "idle" });
    expect((await t.call(manual, "ask", { title: "물음", detail: "배경" })).isError).toBeUndefined();

    // 직접 띄운 세션이 살아 있으면 그 세션에게만 보낼 수 있다. 실행기 없이 총괄에게 갈 말은 갈 곳이 없다.
    expect((await t.api("POST", `/api/projects/${pid}/messages`, { text: "총괄에게" })).status).toBe(409);
    expect((await t.api("POST", `/api/projects/${pid}/messages`, { text: "직접 세션에게", targetMemberId: manual.id })).status).toBe(200);
    const askCard = t.store.listOpenDecisionsByMember(manual.id)[0]!;
    expect((await t.api("POST", `/api/decisions/${askCard.id}/answer`, { note: "좋아요" })).status).toBe(200);
  });

  test("실행기가 꺼지면 켜진 프로젝트도 거부하고, 이미 답한 같은 답은 그대로 돌려준다", async () => {
    const t = await setup();
    const decision = t.store.createDecision({ projectId: t.project.id, who: "x", title: "고르세요", options: [{ k: "a", label: "에이" }] });
    expect((await t.api("POST", `/api/decisions/${decision.id}/answer`, { choice: "a" })).status).toBe(200);
    t.herdr.health = { ok: false, detail: "꺼짐" };
    await t.orch.refreshConnection(); // 접수 API는 마지막 health 관측을 읽고 probe를 기다리지 않는다.
    expect((await t.api("POST", `/api/decisions/${decision.id}/answer`, { choice: "a" })).status).toBe(200);
    expect((await t.api("POST", `/api/projects/${t.project.id}/messages`, { text: "안녕" })).status).toBe(409);
  });

  test("일회성 정리: 보류된 결재 답은 다시 열고 대표 글은 실패로 돌린다. 재전송도 연결을 본다. 두 번 돌려도 같다", async () => {
    const t = await setup({ runnerEnabled: false });
    const pid = t.project.id;
    const lead = t.store.createMember({ projectId: pid, handle: "lead", name: "총괄", kind: "conductor", origin: "adopted", status: "offline" });
    const worker = t.store.createMember({ projectId: pid, handle: "w", name: "철수", kind: "worker", origin: "adopted", status: "offline" });
    const d = t.store.createDecision({ projectId: pid, memberId: worker.id, who: "철수", title: "고르세요", options: [{ k: "a", label: "에이" }] });
    t.store.answerDecision(d.id, { choice: "a" });
    t.store.enqueue({ projectId: pid, memberId: worker.id, kind: "answer", text: "답", status: "held", holdReason: "runner_disabled", refType: "decision", refId: d.id });
    t.store.enqueue({ projectId: pid, memberId: lead.id, kind: "system", text: `대표가 답했습니다 #${d.id}`, wake: false, status: "held", holdReason: "runner_disabled" });
    const m1 = t.store.createMessage({ projectId: pid, mine: true, who: "나", kind: "나", body: "총괄에게", delivery: "held", deliveryNote: "실행이 꺼져 있음" });
    t.store.enqueue({ projectId: pid, memberId: lead.id, kind: "user_message", text: "글", status: "held", holdReason: "runner_disabled", refType: "message", refId: m1.id });
    // 총괄이 없을 때 전달 항목 없이 보류된 말, 받을 사람이 없는 답.
    const m2 = t.store.createMessage({ projectId: pid, mine: true, who: "나", kind: "나", body: "항목 없음", delivery: "held", deliveryNote: "실행이 꺼져 있음" });
    const orphan = t.store.createDecision({ projectId: pid, who: "가져옴", title: "가져온 카드", options: [{ k: "a", label: "에이" }] });
    t.store.answerDecision(orphan.id, { choice: "a" });
    // 건드리지 않아야 하는 것.
    const report = t.store.enqueue({ projectId: pid, memberId: lead.id, kind: "report", text: "보고", status: "held", holdReason: "runner_disabled" });
    const onOtherProject = t.store.createProject({ name: "켜짐", cwd: t.work });
    const keep = t.store.createMessage({ projectId: onOtherProject.id, mine: true, who: "나", kind: "나", body: "보내는 중", delivery: "queued" });

    await t.orch.recover();
    const check = () => {
      expect(t.store.requireDecision(d.id).status).toBe("open");
      expect(t.store.requireDecision(d.id).choice).toBeNull();
      expect(t.store.requireDecision(orphan.id).status).toBe("open");
      expect(t.store.requireMessage(m1.id)).toMatchObject({ delivery: "failed", deliveryNote: "연결 전이라 전달되지 않았습니다" });
      expect(t.store.requireMessage(m2.id)).toMatchObject({ delivery: "failed", deliveryNote: "연결 전이라 전달되지 않았습니다" });
      // 켜진 프로젝트의 말은 실패로 돌리지 않는다. 총괄을 띄워 그대로 전한다.
      expect(t.store.requireMessage(keep.id).delivery).not.toBe("failed");
      expect(t.store.listPending(worker.id)).toHaveLength(0);
      expect(t.store.listPending(lead.id).map((x) => x.id)).toEqual([report.id]);
    };
    check();
    expect(t.store.releaseHeldBeforeConnection()).toEqual({ messages: 0, decisions: 0 });
    check();

    // 재전송도 연결이 있어야 한다.
    const again = await t.api("POST", `/api/projects/${pid}/messages`, { id: m1.id, text: "총괄에게" });
    expect(again.status).toBe(409);
    await expect(t.orch.resendMessage(t.store.requireMessage(m1.id))).rejects.toThrow("연결");
    await t.api("PATCH", `/api/projects/${pid}`, { runnerEnabled: true });
    t.store.patchMember(lead.id, { origin: "runner", status: "asleep" });
    // 옛 전달 행이 사라진 메시지는 현재 총괄을 옛 수신자로 추정하지 않는다.
    const sentBefore = t.herdr.sent.length;
    const resent = await t.api("POST", `/api/projects/${pid}/messages`, { id: m1.id, text: "총괄에게" });
    expect(resent.status).toBe(409);
    expect(t.store.requireMessage(m1.id).delivery).toBe("failed");
    // 수신자가 저장된 옛 failed는 같은 ID의 확인 경로로 합치고 새 입력은 하지 않는다.
    const targeted = t.store.createMessage({ projectId: pid, mine: true, who: "나", kind: "나", body: "저장된 원문", targetMemberId: lead.id, delivery: "failed" });
    for (let i = 0; i < 2; i++) {
      const checked = await t.api("POST", `/api/projects/${pid}/messages`, { id: targeted.id, text: "덮어쓰면 안 됨" });
      expect(checked.status).toBe(200);
      expect(checked.body).toMatchObject({ id: targeted.id, body: "저장된 원문", delivery: "held" });
    }
    const deliveries = t.store.listDeliveries(pid).filter(d => d.refId === targeted.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.attempts).toBe(0);
    expect(t.orch.deliveryRecovery.fenced(lead.id)).toBe(true);
    expect(t.herdr.sent).toHaveLength(sentBefore);
    expect(t.store.listMessages(pid).filter((m) => m.id === m1.id)).toHaveLength(1);
  });

  test("/api/bootstrap 은 실행기를 다시 보고 답한다", async () => {
    const t = await setup();
    t.herdr.health = { ok: false, detail: "꺼짐" };
    const boot = await t.api("GET", "/api/bootstrap");
    expect(boot.body.projects.find((p: ProjectSummary) => p.id === t.project.id).connection.reason).toBe("backend_down");
  });
});

describe("건수", () => {
  test("decisionCount·todoCount·inboxCount, 처리된 결재 페이지", async () => {
    const t = await setup();
    const pid = t.project.id;
    const made = [];
    for (let i = 0; i < 5; i++) made.push(t.store.createDecision({ projectId: pid, who: "x", title: `결재 ${i}`, options: [{ k: "a", label: "에이" }] }));
    t.store.createTodo({ projectId: pid, title: "할 일" });
    for (const d of made.slice(0, 3)) {
      await Bun.sleep(2);
      t.store.answerDecision(d.id, { choice: "a" });
    }
    const s = t.store.projectSummaries().find((p) => p.id === pid)!;
    expect(s).toMatchObject({ decisionCount: 2, todoCount: 1, inboxCount: 3 });
    expect(t.store.projectState(pid).doneDecisionCount).toBe(3);

    const first = await t.api("GET", `/api/projects/${pid}/decisions?status=done&limit=2`);
    expect(first.body.map((d: { title: string }) => d.title)).toEqual(["결재 2", "결재 1"]);
    const next = await t.api("GET", `/api/projects/${pid}/decisions?status=done&limit=2&before=${encodeURIComponent(first.body[1].answeredAt)}`);
    expect(next.body.map((d: { title: string }) => d.title)).toEqual(["결재 0"]);
    expect((await t.api("GET", `/api/projects/${pid}/decisions?status=open`)).body.map((d: { title: string }) => d.title)).toEqual(["결재 3", "결재 4"]);
    expect((await t.api("GET", `/api/projects/${pid}/decisions?status=x`)).status).toBe(400);
  });
});

describe("자료 종류", () => {
  test("fileKindOf: 확장자와 형식", () => {
    const cases: [string, string, string][] = [
      ["a.html", "", "artifact"], ["a.HTM", "", "artifact"], ["a.md", "", "document"], ["a.csv", "", "table"], ["a.tsv", "", "table"],
      ["a.json", "", "code"], ["a.ts", "", "code"], ["a.log", "", "code"], ["a.txt", "", "code"], ["a.pdf", "", "pdf"], ["a.png", "", "image"],
      ["a.mp4", "", "video"], ["a.mp3", "", "audio"], ["a.zip", "", "file"], ["없음", "image/png", "image"], ["없음", "application/pdf", "pdf"], ["없음", "text/plain", "code"], ["없음", "application/octet-stream", "file"],
    ];
    for (const [name, mime, kind] of cases) expect([name, fileKindOf(name, mime)]).toEqual([name, kind as never]);
  });

  test("file 도구: html·경로별 종류, 표·코드는 본문에도 싣고 원본 html 은 상태에 싣지 않는다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const dir = join(t.work, "o");
    mkdirSync(dir);
    const write = (name: string, body: string | Buffer) => writeFileSync(join(dir, name), body);
    write("page.html", "<h1>경로</h1>");
    write("d.csv", "a,b\n1,2\n");
    write("d.tsv", "a\tb\n");
    write("c.json", '{"a":1}');
    write("r.log", "줄\n");
    write("n.txt", "글\n");
    write("r.md", "# 제목");
    write("p.pdf", "%PDF-1.4");
    write("i.png", Buffer.from("89504e470d0a1a0a", "hex"));
    write("v.mp4", "v");
    write("s.mp3", "s");
    write("z.zip", "z");
    const id = (r: { text: string }) => /#(f_\S+?)\./.exec(r.text)![1]!;
    const up = async (args: Record<string, unknown>) => t.store.getFile(id(await t.call(lead, "file", { title: "자료", ...args })))!;

    const art = await up({ html: "<h1>글</h1><script>1</script>" });
    expect(art).toMatchObject({ kind: "artifact", body: "", attachments: [] });
    expect(JSON.stringify(art)).not.toContain("<script>");
    expect(JSON.stringify(t.store.projectState(t.project.id).files)).not.toContain("<script>");
    expect((await t.api("GET", `/api/files/${art.id}/artifact`)).body).toEqual({ html: "<h1>글</h1><script>1</script>" });

    const viaPath = await up({ path: "o/page.html" });
    expect(viaPath).toMatchObject({ kind: "artifact", attachments: [] });
    expect((await t.api("GET", `/api/files/${viaPath.id}/artifact`)).body.html).toBe("<h1>경로</h1>");

    expect((await up({ path: "o/d.csv" }))).toMatchObject({ kind: "table", body: "a,b\n1,2\n" });
    expect((await up({ path: "o/d.tsv" })).kind).toBe("table");
    expect((await up({ path: "o/c.json" }))).toMatchObject({ kind: "code", body: '{"a":1}' });
    expect((await up({ path: "o/r.log" })).kind).toBe("code");
    expect((await up({ path: "o/n.txt" }))).toMatchObject({ kind: "code", body: "글\n" });
    expect((await up({ path: "o/r.md" }))).toMatchObject({ kind: "document", body: "# 제목" });
    expect((await up({ path: "o/p.pdf" })).kind).toBe("pdf");
    expect((await up({ path: "o/i.png" })).kind).toBe("image");
    expect((await up({ path: "o/v.mp4" })).kind).toBe("video");
    expect((await up({ path: "o/s.mp3" })).kind).toBe("audio");
    expect((await up({ path: "o/z.zip" })).kind).toBe("file");
    expect((await up({ content: "전문", images: [join(dir, "i.png")] })).kind).toBe("document");
    expect((await up({ images: [join(dir, "i.png")] })).kind).toBe("image");

    expect((await t.api("GET", `/api/files/${(await up({ content: "글" })).id}/artifact`)).status).toBe(404);
    expect((await t.api("GET", "/api/files/없음/artifact")).status).toBe(404);
    expect((await fetch(`${t.base}/api/files/${art.id}/artifact`)).status).toBe(401);
  });

  test("file 도구: 크기·개수·비밀 파일 검사는 html 경로에도 그대로다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const big = "가".repeat(Math.ceil(MAX_ARTIFACT_BYTES / 3) + 1);
    expect(await t.call(lead, "file", { title: "큼", html: big })).toMatchObject({ isError: true });
    writeFileSync(join(t.work, "big.html"), big);
    expect(await t.call(lead, "file", { title: "큼", path: "big.html" })).toMatchObject({ isError: true });
    expect((await t.call(lead, "file", { title: "딱 맞음", html: "x".repeat(MAX_ARTIFACT_BYTES) })).isError).toBeUndefined();
    expect(await t.call(lead, "file", { title: "둘", html: "<p>", content: "x" })).toMatchObject({ isError: true });
    expect(await t.call(lead, "file", { title: "둘", html: "<p>", path: "big.html" })).toMatchObject({ isError: true });
    expect(await t.call(lead, "file", { title: "빔", html: "  " })).toMatchObject({ isError: true });

    // 작업 폴더 밖, 비밀 이름, 하드 링크는 html 로도 못 읽는다.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-out-")));
    writeFileSync(join(outside, "x.html"), "비밀");
    expect(await t.call(lead, "file", { title: "밖", path: join(outside, "x.html") })).toMatchObject({ isError: true });
    expect(await t.call(lead, "file", { title: "데이터", path: join(t.home, "config.json") })).toMatchObject({ isError: true });
    linkSync(join(outside, "x.html"), join(t.work, "link.html"));
    expect(await t.call(lead, "file", { title: "링크", path: "link.html" })).toMatchObject({ isError: true });
  });

  test("예전 자료: kind 없는 행은 첨부·본문으로 정하고, .html 첨부는 아티팩트로 읽는다. 올린 html 은 sandbox 로만 나간다", async () => {
    const t = await setup();
    const form = new FormData();
    form.set("file", new File(["<script>alert(1)</script>"], "옛날.html", { type: "text/html" }));
    const att = (await (await fetch(`${t.base}/api/uploads`, { method: "POST", headers: { Authorization: "Bearer code" }, body: form })).json()) as { id: string; name: string; url: string; path: string; mime: string; size: number; isImage: boolean };
    const old = t.store.createFile({ projectId: t.project.id, title: "옛날", attachments: [att] });
    const plain = t.store.createFile({ projectId: t.project.id, title: "글", body: "본문" });
    const empty = t.store.createFile({ projectId: t.project.id, title: "빈" });
    expect(old.kind).toBe("artifact");
    expect(plain.kind).toBe("document");
    expect(empty.kind).toBe("file");
    expect((await t.api("GET", `/api/files/${old.id}/artifact`)).body.html).toContain("alert(1)");
    const raw = await fetch(`${t.base}${att.url}`, { headers: { Authorization: "Bearer code" } });
    expect(raw.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("빈 칸(/artifact-frame)은 불투명 출처로 격리되고 원본을 담지 않는다", async () => {
    const t = await setup();
    const res = await fetch(`${t.base}/artifact-frame`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toStartWith("sandbox allow-scripts;");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(await res.text()).toContain("e.source!==parent");
  });

  test("역할 템플릿: 아티팩트 안내가 들어 있고 금지는 외부 게시로 좁혔다", () => {
    for (const kind of ["worker", "conductor", "root"] as const) {
      const text = renderRole(kind, { PROJECT: "P", NAME: "N", ROLE: "R", CONDUCTOR: "C" });
      expect(text).toContain("글만으로 보기 힘든");
      expect(text).toContain("card, grid, callout, kpi, steps, flow, tabs, tag, compare");
      expect(text).toContain("외부 사이트에 따로 게시하지 않는다");
      expect(text).not.toContain("아티팩트를 만들지 않는다");
      expect(text).not.toContain("다른 아티팩트");
      expect(text).not.toContain("{{");
    }
  });
});

describe("설정 통일", () => {
  test("프로젝트 API 에 실행 방식·권한·모델이 없다. 보내면 400", async () => {
    const t = await setup();
    const state = (await t.api("GET", `/api/projects/${t.project.id}/state`)).body;
    for (const key of ["backend", "permissionMode", "model"]) expect(state.project).not.toHaveProperty(key);
    for (const key of ["backend", "model"]) expect((t.store.projectSummaries()[0] as unknown as Record<string, unknown>)[key]).toBeUndefined();
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { backend: "headless" })).status).toBe(400);
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { model: "haiku" })).status).toBe(400);
    expect((await t.api("POST", "/api/projects", { name: "x", cwd: t.work, permissionMode: "auto" })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings", { defaultBackend: "herdr" })).status).toBe(400);
    expect((await t.api("PUT", "/api/settings", { permissionMode: "acceptEdits" })).status).toBe(400);
  });

  test("멤버는 시작한 실행기를 기억하고, 잠들었다 깨면 새 전역 방식을 따른다", async () => {
    const t = await setup();
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    expect(w.backend).toBe("herdr");
    expect(t.store.requireMember(w.id).paneId).toBeTruthy();
    // 실행 방식이 달라도 이미 쉬는 멤버를 기억에 맞춰 옮기는 일은 PUT 이 한다.
    expect((await t.api("PUT", "/api/settings", { backend: "headless" })).status).toBe(200);
    expect(t.herdr.stops).toContain(w.id);
    expect(t.store.requireMember(w.id)).toMatchObject({ backend: "headless", paneId: null });
    await t.orch.assign(t.project.id, "cs", { text: "일" });
    expect(t.headless.sent.at(-1)!.memberId).toBe(w.id);
    expect(t.herdr.sent.some((s) => s.memberId === w.id)).toBe(false);
  });

  test("옮기기 전에 일하는 직원이 있으면 프로젝트를 가리지 않고 409, 쉬게 되면 된다", async () => {
    const t = await setup();
    t.herdr.autoBusy = true;
    const other = t.store.createProject({ name: "딴 곳", cwd: t.work });
    const w = (await t.orch.addMember(other.id, { name: "영희", handle: "yh", role: "개발" })).member;
    await t.orch.assign(other.id, "yh", { text: "일" });
    const refused = await t.api("PUT", "/api/settings", { backend: "headless" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("딴 곳");
    expect(t.store.getSettings().backend).toBe("herdr");
    t.herdr.end(w.id);
    await until(() => t.store.requireMember(w.id).status === "idle", "쉼");
    expect((await t.api("PUT", "/api/settings", { backend: "headless" })).status).toBe(200);
    expect(t.store.requireMember(w.id).backend).toBe("headless");
  });

  test("이전 실행기가 죽어 있어도 옮길 수 있다. 전역 실행기 기준으로 연결이 바뀐다", async () => {
    const t = await setup();
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    t.herdr.stop = async () => {
      throw new Error("소켓 없음");
    };
    t.herdr.health = { ok: false, detail: "꺼짐" };
    await t.orch.refreshConnection();
    expect(t.store.requireProject(t.project.id).connection.ok).toBe(false);
    expect((await t.api("PUT", "/api/settings", { backend: "headless" })).status).toBe(200);
    expect(t.store.requireProject(t.project.id).connection.ok).toBe(true);
    expect(t.store.listActivity(w.id).some((a) => a.text.includes("닫지 못했습니다"))).toBe(true);
  });

  test("옛 멤버: 다른 실행기로 시작한 세션은 그 실행기로 계속 다룬다. 다시 열면 전역을 따른다", async () => {
    const t = await setup();
    const lead = (await t.orch.addMember(t.project.id, { name: "옛직원", handle: "old", role: "개발" })).member;
    t.store.patchMember(lead.id, { backend: "headless", sessionId: "22222222-2222-4222-8222-222222222222", paneId: null });
    await t.orch.assign(t.project.id, "old", { text: "일" });
    expect(t.headless.sent.at(-1)!.memberId).toBe(lead.id);
    t.headless.end(lead.id);
    await until(() => t.store.requireMember(lead.id).status === "idle", "쉼");
    await t.orch.sleepMember(lead.id);
    await t.orch.resumeMember(lead.id);
    expect(t.store.requireMember(lead.id).backend).toBe("herdr");
    expect(t.herdr.starts.at(-1)!.id).toBe(lead.id);
  });

  test("편입은 전역이 herdr 일 때만", async () => {
    const t = await setup({ backend: "headless" });
    (t.orch as unknown as { herdr: unknown }).herdr = { info: async () => ({}), agents: async () => [{ paneId: "w9:p1", name: "x", agent: "claude", status: "idle", cwd: t.work, sessionId: "44444444-4444-4444-8444-444444444444", workspaceId: "w9", tabId: "w9:t1", adopted: false }] };
    await expect(t.orch.adopt(t.project.id, { paneId: "w9:p1", name: "편입", role: "r" })).rejects.toThrow("herdr 일 때만");
    t.store.patchSettings({ backend: "herdr" });
    const adopted = await t.orch.adopt(t.project.id, { paneId: "w9:p1", name: "편입", role: "r" });
    expect(adopted).toMatchObject({ origin: "adopted", backend: "herdr", appliedModel: null });
  });
});

describe("실행 방식 전환의 안전", () => {
  const gate = () => {
    let open!: () => void;
    const wait = new Promise<void>((r) => {
      open = r;
    });
    return { wait, open };
  };

  test("시간 초과로 칸을 못 닫았는데 실행기가 살아 있으면 409, 아무것도 안 바뀐다", async () => {
    const t = await setup();
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    const pane = t.store.requireMember(w.id).paneId;
    t.herdr.stop = async () => {
      throw new Error("시간 초과");
    };
    const r = await t.api("PUT", "/api/settings", { backend: "headless" });
    expect(r.status).toBe(409);
    expect(t.store.getSettings().backend).toBe("herdr");
    expect(t.store.requireMember(w.id)).toMatchObject({ backend: "herdr", paneId: pane });
  });

  test("넘겨받은 칸을 끝내면 잠들고, 깨우면 새 방식의 서버 세션이 된다", async () => {
    const t = await setup();
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    t.store.patchMember(w.id, { origin: "adopted" });
    expect((await t.api("PUT", "/api/settings", { backend: "headless" })).status).toBe(200);
    expect(t.store.requireMember(w.id)).toMatchObject({ status: "asleep", backend: "headless", paneId: null, origin: "adopted" });
    await t.orch.resumeMember(w.id);
    expect(t.store.requireMember(w.id)).toMatchObject({ origin: "runner", backend: "headless" });
    expect(t.herdr.sent.some((s) => s.memberId === w.id)).toBe(false);
  });

  test("칸을 닫는 동안 온 지시는 기다렸다가 새 방식으로 나간다", async () => {
    const t = await setup();
    const a = (await t.orch.addMember(t.project.id, { name: "갑수", handle: "ga", role: "개발" })).member;
    const b = (await t.orch.addMember(t.project.id, { name: "을수", handle: "eul", role: "개발" })).member;
    const hold = gate();
    const stopped = gate();
    const stop = t.herdr.stop.bind(t.herdr);
    t.herdr.stop = async (m) => {
      stopped.open();
      await hold.wait;
      await stop(m);
    };
    const put = t.api("PUT", "/api/settings", { backend: "headless" });
    await stopped.wait;
    await t.orch.assign(t.project.id, "eul", { text: "전환 중 지시" });
    expect(t.herdr.sent).toHaveLength(0);
    await expect(t.orch.addMember(t.project.id, { name: "병수", handle: "byeong", role: "개발" })).rejects.toThrow("바꾸는 중");
    hold.open();
    expect((await put).status).toBe(200);
    await until(() => t.headless.sent.some((s) => s.memberId === b.id), "새 방식 전달");
    expect(t.herdr.sent).toHaveLength(0);
    t.headless.end(b.id);
    await until(() => t.store.requireMember(b.id).status === "idle", "쉼");
    expect(t.store.requireMember(a.id).status).toBe("idle");
  });

  test("병렬은 전환 뒤 풀렸다가 다음 일 전에 새 실행기에 되살린다", async () => {
    const t = await setup();
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    t.store.patchMember(w.id, { parallel: true });
    expect((await t.api("PUT", "/api/settings", { backend: "headless" })).status).toBe(200);
    expect(t.store.requireMember(w.id).parallel).toBe(false);
    let calls = 0;
    t.headless.setParallel = async () => {
      calls++;
      return { ok: true };
    };
    await t.orch.assign(t.project.id, "cs", { text: "일" });
    expect(calls).toBe(1);
    expect(t.store.requireMember(w.id).parallel).toBe(true);
  });

  test("띄우는 동안 바뀐 설정은 적용된 것으로 적지 않고, 다 뜨면 새 값으로 다시 연다", async () => {
    const t = await setup();
    const hold = gate();
    const entered = gate();
    const start = t.herdr.start.bind(t.herdr);
    t.herdr.start = async (m) => {
      entered.open();
      await hold.wait;
      return start(m);
    };
    const adding = t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" });
    await entered.wait;
    expect((await t.api("PUT", "/api/settings", { ranks: { lead: { model: "sonnet" } } })).status).toBe(200);
    hold.open();
    const { member } = await adding;
    expect(t.herdr.starts.at(-1)!.model).toBeNull();
    await until(() => t.herdr.applied.length === 1, "새 설정으로 다시 열기");
    expect(t.herdr.applied[0]!.model).toBe("sonnet");
    await until(() => t.store.requireMember(member.id).appliedModel === "sonnet", "적용 기록");
  });
});

describe("마이그레이션", () => {
  function oldDb(): string {
    const path = join(mkdtempSync(join(tmpdir(), "iamceo-migrate-")), "old.db");
    const db = new Database(path, { create: true });
    db.exec("PRAGMA foreign_keys = ON");
    for (let v = 0; v < 4; v++) db.exec(MIGRATIONS[v]!);
    db.exec("PRAGMA user_version = 4");
    const at = "2026-01-01T00:00:00.000Z";
    const project = db.query("INSERT INTO projects (id, name, is_hq, cwd, backend, permission_mode, model, runner_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
    project.run("hq", "본사", 1, "/h", "herdr", "auto", null, 1, at, at);
    project.run("p_a", "에이", 0, "/a", "headless", "acceptEdits", "haiku", 1, at, at);
    const member = db.query("INSERT INTO members (id, project_id, handle, name, kind, origin, status, cwd, session_id, pane_id, token, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    member.run("m_1", "p_a", "w", "돌던 직원", "worker", "runner", "idle", "/a", "s1", null, "t1", at, at);
    member.run("m_2", "p_a", "n", "세션 없음", "worker", "adopted", "offline", "/a", null, null, "t2", at, at);
    member.run("m_3", "hq", "root", "본사 AI", "root", "runner", "idle", "/h", "s3", "w1:p1", "t3", at, at);
    member.run("m_4", "p_a", "c", "직접", "worker", "manual", "idle", "/a", null, null, "t4", at, at);
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("defaultBackend", '"herdr"');
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("defaultPermissionMode", '"acceptEdits"');
    db.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("compactAtPct", "55");
    db.query("INSERT INTO files (id, project_id, title, body, attachments, created_at, sort_order) VALUES (?,?,?,?,?,?,?)").run("f_1", "p_a", "옛 글", "본문", "[]", at, 1);
    db.close();
    return path;
  }

  test("프로젝트 값을 잃지 않고 옮긴다. 다시 열어도 그대로다", () => {
    const path = oldDb();
    const open = () => new Store(openDb(path), new Bus());
    let store = open();
    const check = () => {
      const settings = store.getSettings();
      expect(settings).toMatchObject({ backend: "herdr", permissionMode: "auto", compactAtPct: 55 });
      // 프로젝트 모델이 하나로 모이면 직급 기본값이 된다. 직원별 지정은 남기지 않고, 새 직원도 그 값을 받는다.
      expect(settings.ranks).toEqual({ manager: { model: "haiku", effort: null }, lead: { model: "haiku", effort: null }, staff: { model: null, effort: null } });
      expect(store.requireProject("p_a")).not.toHaveProperty("backend");
      expect(store.requireMember("m_1")).toMatchObject({ backend: "headless", modelOverride: null, appliedModel: "haiku", appliedEffort: null, sessionId: "s1" });
      expect(store.requireMember("m_2")).toMatchObject({ backend: null, modelOverride: null, appliedModel: null });
      expect(store.requireMember("m_3")).toMatchObject({ backend: "herdr", modelOverride: null, appliedModel: null });
      expect(store.requireMember("m_4")).toMatchObject({ backend: null, modelOverride: null });
      expect(store.getFile("f_1")).toMatchObject({ kind: "document", body: "본문" });
      const kept = store.db.query("SELECT * FROM project_settings_v4 ORDER BY project_id").all();
      expect(kept).toEqual([
        { project_id: "hq", backend: "herdr", permission_mode: "auto", model: null },
        { project_id: "p_a", backend: "headless", permission_mode: "acceptEdits", model: "haiku" },
      ]);
    };
    check();
    store.db.close();
    store = open();
    check();
  });

  test("저장한 권한이 있으면 그대로, 새 DB 만 바이패스 기본", () => {
    const path = oldDb();
    const raw = new Database(path);
    raw.query("UPDATE settings SET value = ? WHERE key = 'defaultPermissionMode'").run('"auto"');
    raw.close();
    expect(new Store(openDb(path), new Bus()).getSettings().permissionMode).toBe("auto");
    const fresh = new Store(openDb(":memory:"), new Bus());
    expect(fresh.getSettings().permissionMode).toBe("bypassPermissions");
  });

  test("저장한 권한이 없으면 프로젝트 값 중 가장 엄격한 것을 저장한다. 바이패스로 올리지 않는다", () => {
    const cases: [string[], string][] = [
      [["default", "auto"], "default"],
      [["auto", "bypassPermissions"], "auto"],
      [["acceptEdits", "bypassPermissions"], "auto"],
      [["bypassPermissions", "bypassPermissions"], "bypassPermissions"],
    ];
    for (const [modes, want] of cases) {
      const path = oldDb();
      const raw = new Database(path);
      raw.exec("DELETE FROM settings WHERE key = 'defaultPermissionMode'");
      raw.query("UPDATE projects SET permission_mode = ? WHERE id = 'hq'").run(modes[0]!);
      raw.query("UPDATE projects SET permission_mode = ? WHERE id = 'p_a'").run(modes[1]!);
      raw.close();
      const store = new Store(openDb(path), new Bus());
      expect(store.getSettings().permissionMode).toBe(want as never);
      expect(store.db.query("SELECT value FROM settings WHERE key = 'permissionMode'").get()).toEqual({ value: JSON.stringify(want) });
      store.db.close();
    }
  });

  test("저장한 전역 값보다 프로젝트가 엄격하면 엄격한 값을 지키고 알린다", () => {
    const cases: [string, string, string, string, boolean][] = [
      ["acceptEdits", "default", "default", "default", true],
      ["bypassPermissions", "auto", "default", "default", true],
      ["bypassPermissions", "default", "default", "default", true],
      ["bypassPermissions", "auto", "auto", "auto", true],
      ["default", "auto", "auto", "default", true],
      ["acceptEdits", "bypassPermissions", "bypassPermissions", "auto", true],
      ["bypassPermissions", "bypassPermissions", "bypassPermissions", "bypassPermissions", false],
      ["auto", "auto", "auto", "auto", false],
    ];
    for (const [saved, hq, pA, want, notified] of cases) {
      const path = oldDb();
      const raw = new Database(path);
      raw.query("UPDATE settings SET value = ? WHERE key = 'defaultPermissionMode'").run(JSON.stringify(saved));
      raw.query("UPDATE projects SET permission_mode = ? WHERE id = 'hq'").run(hq);
      raw.query("UPDATE projects SET permission_mode = ? WHERE id = 'p_a'").run(pA);
      raw.close();
      const store = new Store(openDb(path), new Bus());
      expect(store.getSettings().permissionMode).toBe(want as never);
      const notice = store.getMessage("msg_permkept");
      expect(Boolean(notice)).toBe(notified);
      if (notice) expect(notice.body).toContain(want === "default" ? "모두 승인" : "오토");
      store.db.close();
    }
  });

  test("직급 값이 이미 저장돼 있어도 빈 칸은 채우고, 고른 값은 덮지 않으며 사실대로 알린다", () => {
    // 옮기기 직전까지 이주한 DB 에 직급 값을 저장해 둔다.
    const lift = MIGRATIONS.findIndex((m) => m.includes("msg_modellift"));
    const prepared = (ranks: unknown) => {
      const path = oldDb();
      const raw = new Database(path);
      raw.exec("PRAGMA foreign_keys = ON");
      for (let v = 4; v < lift; v++) raw.exec(MIGRATIONS[v]!);
      raw.exec(`PRAGMA user_version = ${lift}`);
      raw.query("INSERT INTO settings (key, value) VALUES ('ranks', ?)").run(JSON.stringify(ranks));
      raw.close();
      return path;
    };

    const empty = new Store(openDb(prepared({ manager: { model: null, effort: "high" }, lead: { model: null, effort: null }, staff: { model: "sonnet", effort: null } })), new Bus());
    expect(empty.getSettings().ranks).toEqual({ manager: { model: "haiku", effort: "high" }, lead: { model: "haiku", effort: null }, staff: { model: "sonnet", effort: null } });
    expect(empty.requireMember("m_1").modelOverride).toBeNull();
    expect(empty.getMessage("msg_modellift")?.body).toContain("haiku");
    expect(empty.getMessage("msg_modelkept")).toBeFalsy();
    empty.db.close();

    const chosen = new Store(openDb(prepared({ manager: { model: "opus", effort: null }, lead: { model: "opus", effort: null }, staff: { model: null, effort: null } })), new Bus());
    expect(chosen.getSettings().ranks.lead.model).toBe("opus");
    expect(chosen.requireMember("m_1").modelOverride).toBe("haiku");
    expect(chosen.getMessage("msg_modellift")).toBeFalsy();
    expect(chosen.getMessage("msg_modelkept")?.body).toContain("직원별 지정");
    chosen.db.close();

    const partial = new Store(openDb(prepared({ manager: { model: "opus", effort: null }, lead: { model: null, effort: null }, staff: { model: null, effort: null } })), new Bus());
    expect(partial.getSettings().ranks).toMatchObject({ manager: { model: "opus" }, lead: { model: "haiku" } });
    expect(partial.requireMember("m_1").modelOverride).toBeNull();
    expect(partial.getMessage("msg_modellift")).toBeFalsy();
    expect(partial.getMessage("msg_modelkept")?.body).toContain("haiku");
    partial.db.close();
  });

  test("프로젝트 모델이 갈리면 직원별 지정을 두고 대표에게 알린다. 하나로 모이면 옮겼다고 알린다", () => {
    const split = oldDb();
    const raw = new Database(split);
    raw.query("UPDATE projects SET model = 'opus' WHERE id = 'hq'").run();
    raw.close();
    const a = new Store(openDb(split), new Bus());
    expect(a.getSettings().ranks).toEqual(DEFAULT_RANKS);
    expect(a.requireMember("m_1").modelOverride).toBe("haiku");
    expect(a.requireMember("m_3").modelOverride).toBe("opus");
    expect(a.getMessage("msg_modelsplit")?.body).toContain("직원별 지정");
    expect(a.getMessage("msg_modellift")).toBeFalsy();
    a.db.close();

    const b = new Store(openDb(oldDb()), new Bus());
    expect(b.getMessage("msg_modellift")?.body).toContain("haiku");
    expect(b.getMessage("msg_modelsplit")).toBeFalsy();
    b.db.close();
  });

  test("이주한 세션은 설정이 같으면 다시 열리지 않는다", async () => {
    const t = await setup();
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    // 마이그레이션이 쓴 값과 같은 모양(키 순서가 달라도 같다).
    t.store.db.query("UPDATE members SET applied_config = ? WHERE id = ?").run('{"effort":null,"model":null,"staffEffort":null,"staffModel":null}', w.id);
    await t.orch.pump(w.id);
    expect(t.herdr.applied).toHaveLength(0);
  });
});

describe("직급별 모델·effort", () => {
  test("memberRank·memberConfig: 총괄·본사는 부장, 직원 세션은 팀장, 개인 지정이 이긴다", () => {
    expect(memberRank("root")).toBe("manager");
    expect(memberRank("conductor")).toBe("manager");
    expect(memberRank("worker")).toBe("lead");
    const ranks = { manager: { model: "opus", effort: "high" as const }, lead: { model: "sonnet", effort: null }, staff: { model: "haiku", effort: "low" as const } };
    expect(memberConfig({ kind: "conductor", modelOverride: null, effortOverride: null }, ranks)).toEqual({ model: "opus", effort: "high" });
    expect(memberConfig({ kind: "worker", modelOverride: null, effortOverride: null }, ranks)).toEqual({ model: "sonnet", effort: null });
    expect(memberConfig({ kind: "worker", modelOverride: "fable", effortOverride: "max" }, ranks)).toEqual({ model: "fable", effort: "max" });
  });

  test("설정 패치는 고친 칸만 바꾸고, 값을 검증한다", async () => {
    const t = await setup();
    const a = await t.api("PUT", "/api/settings", { ranks: { manager: { model: "opus", effort: "high" }, staff: { effort: "low" } } });
    expect(a.body.ranks).toEqual({ manager: { model: "opus", effort: "high" }, lead: { model: null, effort: null }, staff: { model: null, effort: "low" } });
    const b = await t.api("PUT", "/api/settings", { ranks: { manager: { effort: null } } });
    expect(b.body.ranks.manager).toEqual({ model: "opus", effort: null });
    for (const body of [{ ranks: { manager: { model: "--dangerously-skip-permissions" } } }, { ranks: { lead: { model: "a b" } } }, { ranks: { lead: { effort: "ultra" } } }, { ranks: { boss: {} } }]) {
      expect((await t.api("PUT", "/api/settings", body)).status).toBe(400);
    }
    expect((await t.api("PUT", "/api/settings", { ranks: { lead: { model: "claude-fable-5-1[1m]" } } })).status).toBe(200);
  });

  test("세션 인자: 부장·팀장 값과 개인 지정이 실행기로 간다", async () => {
    const t = await setup();
    await t.api("PUT", "/api/settings", { permissionMode: "auto", ranks: { manager: { model: "opus", effort: "high" }, lead: { model: "sonnet", effort: "medium" }, staff: { model: "haiku", effort: "low" } } });
    const lead = await t.orch.ensureConductor(t.project.id);
    expect(t.herdr.starts.at(-1)).toMatchObject({ id: lead.id, model: "opus", effort: "high", subagentModel: "haiku", permissionMode: "auto" });
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    expect(t.herdr.starts.at(-1)).toMatchObject({ id: w.id, model: "sonnet", effort: "medium", subagentModel: "haiku" });
    expect(t.store.requireMember(w.id)).toMatchObject({ appliedModel: "sonnet", appliedEffort: "medium" });
    const roster = t.orch.roster(t.project.id).find((r) => r.handle === "cs")!;
    expect(roster).toMatchObject({ model: "sonnet", effort: "medium", subagentModel: "haiku", subagentEffort: "low" });

    const patched = await t.api("PATCH", `/api/members/${w.id}`, { modelOverride: "fable", effortOverride: "max" });
    expect(patched.body).toMatchObject({ modelOverride: "fable", effortOverride: "max" });
    expect(t.orch.roster(t.project.id).find((r) => r.handle === "cs")).toMatchObject({ model: "fable", effort: "max" });
    expect((await t.api("PATCH", `/api/members/${w.id}`, { modelOverride: "--x" })).status).toBe(400);
    expect((await t.api("PATCH", `/api/members/${w.id}`, { name: "바꿈" })).status).toBe(400);
    expect((await t.api("PATCH", "/api/members/없음", { modelOverride: null })).status).toBe(404);
    const manual = t.store.createMember({ projectId: t.project.id, handle: "m1", name: "직접", kind: "worker", origin: "manual", status: "idle" });
    expect((await t.api("PATCH", `/api/members/${manual.id}`, { modelOverride: "haiku" })).status).toBe(400);
    expect((await t.api("PATCH", `/api/members/${w.id}`, { modelOverride: null, effortOverride: null })).body.modelOverride).toBeNull();
    expect(t.orch.roster(t.project.id).find((r) => r.handle === "cs")).toMatchObject({ model: "sonnet", effort: "medium" });
  });

  test("설정 화면에 쓸 직원별 지정 수를 직급별로 준다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    expect((await t.api("GET", "/api/bootstrap")).body.rankOverrides).toEqual({ manager: 0, lead: 0 });
    await t.api("PATCH", `/api/members/${w.id}`, { effortOverride: "max" });
    await t.api("PATCH", `/api/members/${lead.id}`, { modelOverride: "haiku" });
    expect((await t.api("GET", "/api/bootstrap")).body.rankOverrides).toEqual({ manager: 1, lead: 1 });
  });

  test("team_add 는 목록 모델만 받고 effort 인자는 받지 않는다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    expect((await t.call(lead, "team_add", { name: "철수", role: "개발", model: "opus" })).isError).toBeUndefined();
    expect(await t.call(lead, "team_add", { name: "거절", role: "개발", model: "unlisted" })).toMatchObject({ isError: true });
    expect(await t.call(lead, "team_add", { name: "철수", role: "개발", effort: "max" })).toMatchObject({ isError: true });
  });

  test("서브에이전트 effort 규칙은 템플릿으로 들어가고, 없으면 흔적이 없으며, 고친 템플릿에도 빠지지 않는다", async () => {
    const vars = { PROJECT: "P", NAME: "N", ROLE: "R", CONDUCTOR: "C" };
    const rule = "- 서브에이전트·워크플로를 부를 때 effort=low 을 넘긴다.";
    expect(renderRole("worker", { ...vars, SUBAGENT_EFFORT: rule })).toContain(rule);
    for (const kind of ["worker", "conductor", "root"] as const) {
      expect(renderRole(kind, { ...vars, SUBAGENT_EFFORT: "" })).not.toContain("SUBAGENT_EFFORT");
      expect(renderRole(kind, { ...vars, SUBAGENT_EFFORT: rule })).toContain(rule);
    }
    const dir = mkdtempSync(join(tmpdir(), "iamceo-roles-"));
    writeFileSync(join(dir, "worker.md"), "승인 규칙만 있는 고친 템플릿");
    expect(renderRole("worker", { ...vars, SUBAGENT_EFFORT: rule }, dir)).toContain(rule);
    expect(renderRole("worker", { ...vars, SUBAGENT_EFFORT: "" }, dir)).toBe("승인 규칙만 있는 고친 템플릿");

    const t = await setup();
    await t.api("PUT", "/api/settings", { ranks: { staff: { effort: "xhigh" } } });
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    expect(readFileSync(join(t.home, "run", `${w.id}.rules.md`), "utf8")).toContain("effort=xhigh");
  });

  test("herdr: 쉬는 세션은 설정이 바뀌면 다시 열고 적용을 적는다. 일하는 세션은 끝난 뒤에", async () => {
    const t = await setup();
    t.herdr.autoBusy = true;
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    await t.orch.assign(t.project.id, "cs", { text: "일" });
    await t.api("PUT", "/api/settings", { ranks: { lead: { model: "sonnet", effort: "low" } } });
    await Bun.sleep(30);
    expect(t.herdr.applied).toHaveLength(0);
    expect(t.store.requireMember(w.id).appliedModel).toBeNull();
    t.herdr.end(w.id);
    await until(() => t.herdr.applied.length === 1, "일 끝난 뒤 적용");
    expect(t.herdr.applied[0]).toMatchObject({ id: w.id, model: "sonnet", effort: "low" });
    await until(() => t.store.requireMember(w.id).appliedModel === "sonnet", "적용 기록");
    expect(t.store.requireMember(w.id).appliedEffort).toBe("low");
    expect(t.store.listActivity(w.id).some((a) => a.text.includes("새 설정으로 다시 열었습니다"))).toBe(true);
    // 값이 같으면 다시 열지 않는다.
    await t.orch.pump(w.id);
    expect(t.herdr.applied).toHaveLength(1);
    // 서브에이전트 값이 바뀌어도 칸 환경·규칙이 달라지므로 다시 연다.
    await t.api("PUT", "/api/settings", { ranks: { staff: { model: "haiku" } } });
    await until(() => t.herdr.applied.length === 2, "서브에이전트 값 적용");
    expect(t.herdr.applied[1]!.subagentModel).toBe("haiku");
    // 개인 지정도 같다.
    await t.api("PATCH", `/api/members/${w.id}`, { modelOverride: "fable" });
    await until(() => t.herdr.applied.length === 3, "개인 지정 적용");
    expect(t.herdr.applied[2]!.model).toBe("fable");
  });

  test("herdr: 입력칸에 글이 있으면 기다리고, 병렬은 되살리고, 끝내 안 되면 알리고 일을 막지 않는다", async () => {
    const t = await setup();
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    t.store.patchMember(w.id, { parallel: true });
    t.herdr.applyResults = [{ ok: false, reason: "input_busy", retryable: true }, { ok: true }];
    await t.api("PUT", "/api/settings", { ranks: { lead: { model: "sonnet" } } });
    await until(() => t.store.requireMember(w.id).appliedModel === "sonnet", "입력칸이 빈 뒤 적용");
    expect(t.herdr.applied).toHaveLength(2);
    expect(t.store.requireMember(w.id).parallel).toBe(false);

    t.herdr.applyResults = [1, 2, 3].map(() => ({ ok: false as const, reason: "error" as const, detail: "확인 실패", retryable: true }));
    await t.api("PUT", "/api/settings", { ranks: { lead: { model: "opus" } } });
    await until(() => t.store.listActivity(w.id).some((a) => a.text.includes("새 설정을 적용하지 못했습니다")), "포기 기록");
    expect(t.store.requireMember(w.id).appliedModel).toBe("sonnet");
    await t.orch.assign(t.project.id, "cs", { text: "그래도 일" });
    expect(t.herdr.sent.at(-1)!.text).toContain("그래도 일");
    const applyCount = t.herdr.applied.length;
    t.herdr.end(w.id);
    await until(() => t.store.requireMember(w.id).status === "idle", "쉼");
    await t.orch.pump(w.id);
    expect(t.herdr.applied).toHaveLength(applyCount);
    // 설정이 또 바뀌면 다시 시도한다.
    await t.api("PUT", "/api/settings", { ranks: { lead: { model: "haiku" } } });
    await until(() => t.store.requireMember(w.id).appliedModel === "haiku", "다시 시도");
  });

  test("herdr: 넘겨받은 세션·잠든 세션은 스스로 다시 열지 않고, 깨울 때 들어간다", async () => {
    const t = await setup();
    (t.orch as unknown as { herdr: unknown }).herdr = { info: async () => ({}), agents: async () => [{ paneId: "w9:p1", name: "x", agent: "claude", status: "idle", cwd: t.work, sessionId: "44444444-4444-4444-8444-444444444444", workspaceId: "w9", tabId: "w9:t1", adopted: false }] };
    const adopted = await t.orch.adopt(t.project.id, { paneId: "w9:p1", name: "편입", role: "r" });
    const asleep = (await t.orch.addMember(t.project.id, { name: "잠듦", handle: "zz", role: "개발" })).member;
    await t.orch.sleepMember(asleep.id);
    await t.api("PUT", "/api/settings", { ranks: { lead: { model: "sonnet" } } });
    await Bun.sleep(30);
    expect(t.herdr.applied).toHaveLength(0);
    await t.orch.resumeMember(asleep.id);
    expect(t.herdr.starts.at(-1)).toMatchObject({ id: asleep.id, model: "sonnet" });
    expect(t.store.requireMember(asleep.id).appliedModel).toBe("sonnet");
    expect(t.store.requireMember(adopted.id).appliedModel).toBeNull();
  });

  test("headless: 다음 턴부터 인자가 자동으로 바뀌고 다시 열기는 없다", async () => {
    const t = await setup({ backend: "headless" });
    const w = (await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" })).member;
    await t.orch.assign(t.project.id, "cs", { text: "하나" });
    t.headless.end(w.id);
    await until(() => t.store.requireMember(w.id).status === "idle", "쉼");
    await t.api("PUT", "/api/settings", { permissionMode: "default", ranks: { lead: { model: "sonnet", effort: "low" }, staff: { model: "haiku" } } });
    await t.orch.assign(t.project.id, "cs", { text: "둘" });
    expect(t.headless.sent.at(-1)!.m).toMatchObject({ model: "sonnet", effort: "low", subagentModel: "haiku", permissionMode: "default" });
    expect(t.store.requireMember(w.id)).toMatchObject({ appliedModel: "sonnet", appliedEffort: "low" });
    expect(t.headless.applied).toHaveLength(0);
  });
});

describe("실행기 인자", () => {
  const member = (over: Partial<RunnerMember> = {}): RunnerMember => ({ id: "m", projectId: "p", handle: "h", name: "n", cwd: "/", sessionId: "s", paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "bypassPermissions", kind: "worker", ...over });
  const opts: StartOpts = { systemPromptFile: "r", mcpConfigFile: "c", resume: true, projectName: "p" };

  test("--effort·--model 은 값이 있을 때만, --permission-prompts none 은 언제나", () => {
    const plain = buildClaudeArgs(member(), opts, true);
    expect(plain).not.toContain("--model");
    expect(plain).not.toContain("--effort");
    expect(plain.slice(plain.indexOf("--permission-mode"), plain.indexOf("--permission-mode") + 4)).toEqual(["--permission-mode", "bypassPermissions", "--permission-prompts", "none"]);
    const full = buildClaudeArgs(member({ model: "haiku", effort: "max", permissionMode: "default" }), opts, false);
    expect(full[full.indexOf("--model") + 1]).toBe("haiku");
    expect(full[full.indexOf("--effort") + 1]).toBe("max");
    expect(full[full.indexOf("--permission-mode") + 1]).toBe("default");
    expect(full[full.indexOf("--permission-prompts") + 1]).toBe("none");
  });

  test("childEnv: 바깥 세션의 서브에이전트·effort 값이 새지 않는다", () => {
    const env = childEnv({ PATH: "/bin", CLAUDE_CODE_SUBAGENT_MODEL: "x", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_EFFORT_LEVEL: "max", CLAUDE_EFFORT: "max" });
    expect(env).toEqual({ PATH: "/bin" });
  });

  test("headless 자식에게 서브에이전트 모델 환경을 주고, 값이 없으면 안 준다. 막힌 도구는 활동에 남는다", async () => {
    const runtime = createIsolatedRuntime();
    const dir = runtime.paths.work;
    const log = join(runtime.dir, "fake.jsonl");
    const runner = new HeadlessRunner({ claudeBin: runtime.bins.claudeBin }, { env: { ...runtime.childEnv(), CLAUDE_CODE_SUBAGENT_MODEL: "바깥값", CLAUDE_CODE_EFFORT_LEVEL: "max" } });
    closers.push(async () => { await runner.shutdown(); await runtime.stop(); });
    const events: RunnerEvent[] = [];
    runner.on((e) => events.push(e));
    const m = member({ id: `m_${Date.now()}`, cwd: dir, sessionId: null, subagentModel: "haiku", effort: "low" });
    const started = await runner.start(m, opts);
    expect(await runner.send({ ...m, ...started }, "일 @fake:denied", opts)).toEqual({ ok: true });
    await until(() => events.some((e) => e.type === "turn_end"), "턴 끝", 8000);
    expect(events.some((e) => e.type === "activity" && e.kind === "error" && e.text.includes("승인 창이 없어 막혔습니다") && e.text.includes("Bash"))).toBe(true);
    events.length = 0;
    expect(await runner.send({ ...m, ...started, subagentModel: null }, "둘", opts)).toEqual({ ok: true });
    await until(() => events.some((e) => e.type === "turn_end"), "턴 끝", 8000);
    const starts = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.prompt?.length && c.event === "start");
    expect(starts[0]).toMatchObject({ subagentModel: "haiku", subagentForce: "1" });
    expect(starts[0].args[starts[0].args.indexOf("--effort") + 1]).toBe("low");
    expect(starts[0].env).not.toContain("CLAUDE_CODE_EFFORT_LEVEL");
    expect(starts[1]).toMatchObject({ subagentModel: null, subagentForce: null });
  });

  test("StreamParser: 막힌 도구가 없으면 활동을 만들지 않는다", () => {
    const events: RunnerEvent[] = [];
    const p = new StreamParser("m", (e) => events.push(e), { reportContext: false, contextWindow: null });
    p.feed(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "끝", permission_denials: [] }));
    expect(events).toHaveLength(0);
  });

  test("Claude 설정은 항상 상태줄을 수집하고, 바이패스 모드만 경고 창을 건너뛴다", async () => {
    const t = await setup();
    const opened: StartOpts[] = [];
    const start = t.herdr.start.bind(t.herdr);
    t.herdr.start = async (m: RunnerMember, o?: StartOpts) => {
      opened.push(o!);
      return start(m);
    };
    await t.orch.addMember(t.project.id, { name: "철수", handle: "cs", role: "개발" });
    expect(JSON.parse(readFileSync(opened[0]!.settingsFile!, "utf8"))).toMatchObject({ skipDangerousModePermissionPrompt: true, statusLine: { type: "command", command: expect.stringContaining("iamceo-context-statusline") } });
    await t.api("PUT", "/api/settings", { permissionMode: "auto" });
    await t.orch.addMember(t.project.id, { name: "영희", handle: "yh", role: "개발" });
    const settings = JSON.parse(readFileSync(opened[1]!.settingsFile!, "utf8"));
    expect(settings.statusLine.type).toBe("command");
    expect(settings.skipDangerousModePermissionPrompt).toBeUndefined();
    expect(existsSync(join(t.home, "run"))).toBe(true);
  });
});

describe("Store 프로젝트 관리·manual 영속 경계", () => {
  test("rename은 trim/길이/HQ/자동 총괄 규칙을 검증하고 세션·ID·토큰을 유지한다", () => {
    const db = openDb(":memory:");
    const bus = new Bus();
    const events: WsEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const store = new Store(db, bus);
    try {
      const project = store.createProject({ name: "기존", cwd: "/fixture" });
      const lead = store.createMember({ projectId: project.id, handle: "lead", name: "기존 총괄", kind: "conductor", sessionId: "native-session", paneId: "terminal" });
      const token = store.getMemberToken(lead.id);
      const generation = store.memberRevisions(lead.id).sessionGeneration;
      events.length = 0;
      expect(store.validateProjectPatch(project.id, { name: "  새 이름  " })).toEqual({ name: "새 이름" });
      expect(events).toEqual([]);
      const changed = store.patchProject(project.id, { name: "  새 이름  " });
      expect(changed.id).toBe(project.id);
      expect(changed.name).toBe("새 이름");
      expect(store.requireMember(lead.id)).toMatchObject({ name: "새 이름 총괄", sessionId: "native-session", paneId: "terminal" });
      expect(store.getMemberToken(lead.id)).toBe(token);
      expect(store.memberRevisions(lead.id).sessionGeneration).toBe(generation);
      expect(events.map((e) => e.type)).toEqual(["member", "project", "projects"]);
      events.length = 0;
      expect(store.patchProject(project.id, { name: "새 이름" }).updatedAt).toBe(changed.updatedAt);
      expect(events).toEqual([]);
      store.patchProject(project.id, { name: "[자료] <검토>" });
      expect(store.requireMember(lead.id).name).toBe("자료 검토 총괄");
      store.patchProject(project.id, { name: "한".repeat(100) });
      store.patchProject(project.id, { name: "😀".repeat(50) });
      for (const name of ["", "  ", "한".repeat(101), "😀".repeat(51), "개행\n", "제어\u0000문자", "탭\t"]) expect(() => store.validateProjectPatch(project.id, { name })).toThrow(ApiError);
      const root = store.createMember({ projectId: "hq", handle: "root", name: "본사 AI", kind: "root" });
      store.patchProject("hq", { name: "본사 이름" });
      expect(store.requireMember(root.id).name).toBe("본사 AI");
      expect(() => store.patchProject("hq", { archived: true })).toThrow(ApiError);
      expect(store.patchProject("hq", { archived: false }).archived).toBe(false);
      expect(() => store.validateProjectPatch(project.id, { archived: true, runnerEnabled: true })).toThrow(ApiError);
    } finally { db.close(); }
  });

  test("총괄 UPDATE 실패·이름 충돌은 프로젝트와 이벤트를 함께 rollback하고 별도 이름은 유지", () => {
    const db = openDb(":memory:");
    const bus = new Bus();
    const events: WsEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const store = new Store(db, bus);
    try {
      const project = store.createProject({ name: "기존", cwd: "/fixture" });
      const lead = store.createMember({ projectId: project.id, handle: "lead", name: "기존 총괄", kind: "conductor" });
      const worker = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker" });
      // 과거 DB에 허용되었던 이름도 파생 이름과 충돌할 수 있다.
      db.query("UPDATE members SET name = '겹침 총괄' WHERE id = ?").run(worker.id);
      events.length = 0;
      expect(() => store.patchProject(project.id, { name: "겹침" })).toThrow(ApiError);
      expect(store.requireProject(project.id)).toEqual(project);
      expect(events).toEqual([]);
      db.exec("CREATE TRIGGER reject_rename BEFORE UPDATE OF name ON members BEGIN SELECT RAISE(ABORT, 'rename failed'); END");
      expect(() => store.patchProject(project.id, { name: "새 이름" })).toThrow("rename failed");
      expect(store.requireProject(project.id)).toEqual(project);
      expect(store.requireMember(lead.id).name).toBe("기존 총괄");
      expect(events).toEqual([]);
      db.exec("DROP TRIGGER reject_rename");
      store.patchMember(lead.id, { name: "전담 총괄" });
      store.patchProject(project.id, { name: "별도" });
      expect(store.requireMember(lead.id).name).toBe("전담 총괄");
    } finally { db.close(); }
  });

  test("manual batch는 ACK 전 재조회되고 보관 중 소비하지 않으며 ACK rollback도 원자적", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-manual-store-"));
    const path = join(dir, "store.db");
    let db = openDb(path);
    try {
      let store = new Store(db, new Bus());
      const p = store.createProject({ name: "직접 세션", cwd: dir });
      const m = store.createMember({ projectId: p.id, handle: "manual", name: "직원", kind: "worker", origin: "manual" });
      const decision = store.createDecision({ projectId: p.id, memberId: m.id, who: m.name, title: "질문" });
      store.answerDecision(decision.id, { note: "답" });
      const delivery = store.enqueue({ projectId: p.id, memberId: m.id, kind: "answer", text: "답", refType: "decision", refId: decision.id });
      const batch = store.manualInbox(m.id)!;
      expect(store.requireDelivery(delivery.id).status).toBe("queued");
      expect(store.manualInbox(m.id)).toEqual(batch);
      db.close();
      db = openDb(path);
      store = new Store(db, new Bus());
      expect(store.manualInbox(m.id)).toEqual(batch);
      store.patchProject(p.id, { archived: true });
      expect(store.manualInbox(m.id)).toBeNull();
      expect(() => store.acknowledgeManualInbox(m.id, batch.id)).toThrow(ApiError);
      expect(store.requireDelivery(delivery.id).status).toBe("queued");
      store.patchProject(p.id, { archived: false });
      db.exec("CREATE TRIGGER reject_ack BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'ACK failed'); END");
      expect(() => store.acknowledgeManualInbox(m.id, batch.id)).toThrow("ACK failed");
      expect(store.requireDelivery(delivery.id).status).toBe("queued");
      expect(store.manualInbox(m.id)).toEqual(batch);
      db.exec("DROP TRIGGER reject_ack");
      expect(store.acknowledgeManualInbox(m.id, batch.id)).toEqual({ batchId: batch.id, acknowledged: true });
      expect(store.acknowledgeManualInbox(m.id, batch.id)).toEqual({ batchId: batch.id, acknowledged: true });
      expect(store.requireDecision(decision.id).status).toBe("delivered");
      expect(store.listUnreceivedAnswers(m.id)).toEqual([]);
      expect(store.manualInbox(m.id)).toBeNull();
    } finally { db.close(); }
  });
});
