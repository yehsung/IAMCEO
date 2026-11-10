import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Bootstrap, Decision, Member, Message, MessagePage, Project, ProjectState, Settings, Todo, WsEvent } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { type Config, isTailscaleV4, loadConfig, updateConfigFile, VERSION } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { buildIpRule, isHostAllowed, isIpAllowed, type RunningServer, safeEqual, startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { ApiError, Store } from "../server/store.ts";

const SESSION_1 = "11111111-1111-4111-8111-111111111111";
const SESSION_2 = "22222222-2222-4222-8222-222222222222";
const SESSION_3 = "33333333-3333-4333-8333-333333333333";

const CODE = "test-access-code";

function makeConfig(hosts: string[] = ["127.0.0.1"]): Config {
  const home = mkdtempSync(join(tmpdir(), "iamceo-http-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: CODE, hosts }, env);
  return loadConfig(env);
}

/** 호출을 기록하는 가짜 Orchestrator. 실제 세션은 전혀 없다. */
function fakeOrch(store: Store) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const log = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
  const orch: OrchestratorApi = {
    async createProject(req) {
      log("createProject", req);
      return store.createProject({ name: req.name, cwd: req.cwd });
    },
    async updateSettings(patch) {
      log("updateSettings", patch);
      return store.patchSettings(patch);
    },
    async patchMemberConfig(id, patch) {
      log("patchMemberConfig", id, patch);
      return store.patchMember(id, patch);
    },
    onProjectPatched(project, patch) {
      log("onProjectPatched", project.id, patch);
    },
    async startConductor(projectId) {
      log("startConductor", projectId);
      return store.createMember({ projectId, handle: "lead", name: "총괄", kind: "conductor" });
    },
    async sendUserMessage(projectId, req) {
      log("sendUserMessage", projectId, req);
      return store.createMessage({ id: req.id, projectId, kind: "나", mine: true, who: "나", body: req.text, delivery: "queued" });
    },
    async answerDecision(id, req) {
      log("answerDecision", id, req);
      return store.answerDecision(id, req).decision;
    },
    async setTodoDone(id, done) {
      log("setTodoDone", id, done);
      return store.setTodoDone(id, done).todo;
    },
    async memberSleep(id) {
      log("memberSleep", id);
      return store.patchMember(id, { status: "asleep" });
    },
    async memberResume(id) {
      log("memberResume", id);
    },
    async memberCompact(id) {
      log("memberCompact", id);
    },
    async memberInterrupt(id) {
      log("memberInterrupt", id);
    },
    async memberScreen(id) {
      log("memberScreen", id);
      return "화면 글";
    },
    async memberApproval(id) {
      log("memberApproval", id);
      return { title: "Bash command", body: "rm -rf out", question: "Do you want to proceed?", options: [{ n: 1, label: "Yes", reject: false }, { n: 2, label: "No", reject: true }], fingerprint: "abcdef0123456789abcdef01" };
    },
    async answerApproval(id, req) {
      log("answerApproval", id, req);
      if (req.fingerprint !== "abcdef0123456789abcdef01") throw new ApiError(409, "창이 바뀌었습니다. 새 창을 보고 다시 고르세요");
    },
    async herdrInfo() {
      return { installed: false, running: false, version: null, protocol: null, compatible: false, warning: null };
    },
    async herdrAgents() {
      return [{ paneId: "p1", name: "a", agent: "claude", status: "idle", cwd: "/x", sessionId: null, workspaceId: null, tabId: null, adopted: false }];
    },
    async adoptPreview(_projectId, paneId) {
      return { paneId, name: "a", cwd: "/x", status: "idle", sessionId: "s", screen: "화면", refuse: null, warnings: [] };
    },
    async releaseMember(id) {
      log("release", id);
      store.removeMember(id);
      return { notified: true, paneKept: true, resumeCommand: null };
    },
    async reopenWithTools(id) {
      log("reopenWithTools", id);
      return store.requireMember(id);
    },
    cliCommand() {
      return "iamceo-시험";
    },
    async adopt(projectId, req) {
      log("adopt", projectId, req);
      return store.createMember({ projectId, handle: req.handle ?? "adopted", name: req.name, role: req.role, kind: req.kind ?? "worker", origin: "adopted", paneId: req.paneId });
    },
    listAgentTools(member) {
      return [{ name: "status", description: `${member.handle} 전용`, inputSchema: { type: "object" } }];
    },
    async handleAgentTool(member, name, args) {
      log("handleAgentTool", member.id, name, args);
      if (name === "boom") throw new Error("도구 터짐");
      if (name === "denied") throw new ApiError(403, "거부");
      return { text: `ok:${name}` };
    },
    async askWait(member, decisionId, timeoutMs) {
      log("askWait", member.id, decisionId, timeoutMs);
      const decision = store.requireDecision(decisionId);
      return decision.status === "open" ? { done: false } : { done: true, text: decision.choice ?? "", decision };
    },
  };
  return { orch, calls };
}

let config: Config;
let store: Store;
let bus: Bus;
let calls: { fn: string; args: unknown[] }[];
let server: RunningServer;
let base: string;
let projectId: string;
let cwd: string;

beforeAll(async () => {
  config = makeConfig();
  bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  const fake = fakeOrch(store);
  calls = fake.calls;
  server = await startServer({ config, store, bus, orch: fake.orch });
  while (server.port === 7878) {
    await server.stop();
    server = await startServer({ config, store, bus, orch: fake.orch });
  }
  base = `http://127.0.0.1:${server.port}`;
  cwd = mkdtempSync(join(tmpdir(), "iamceo-cwd-"));
  projectId = store.createProject({ name: "시험", cwd }).id;
});

afterAll(async () => {
  await server.stop();
  store.db.close();
});

const auth = { Authorization: `Bearer ${CODE}` };

function api(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...auth, ...init.headers };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(base + path, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  if (r.status !== status) throw new Error(`${r.status} != ${status}: ${text}`);
  return JSON.parse(text) as T;
}

const callsOf = (fn: string) => calls.filter((c) => c.fn === fn);

describe("접근 제어", () => {
  test("isIpAllowed: 루프백·Tailscale 통과, 나머지 거부", () => {
    const rule = buildIpRule(["127.0.0.1"]);
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.0.1", "100.127.255.254", "100.92.10.20", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::9"]) {
      expect([ip, isIpAllowed(ip, rule)]).toEqual([ip, true]);
    }
    for (const ip of ["8.8.8.8", "192.168.0.5", "100.63.255.255", "100.128.0.1", "10.0.0.1", "fd7a:115c:a1e1::1", "2001:db8::1", "", "garbage"]) {
      expect([ip, isIpAllowed(ip, rule)]).toEqual([ip, false]);
    }
    expect(isIpAllowed(null, rule)).toBe(false);
    expect(isIpAllowed(undefined, rule)).toBe(false);
  });

  test("hosts 에 LAN 을 넣으면 그 대역만 허용, 와일드카드는 넓히지 않는다", () => {
    const lan = buildIpRule(["127.0.0.1", "192.168.7.10"]);
    expect(isIpAllowed("192.168.7.200", lan)).toBe(true);
    expect(isIpAllowed("192.168.8.1", lan)).toBe(false);
    expect(isIpAllowed("8.8.8.8", buildIpRule(["0.0.0.0", "::"]))).toBe(false);
    expect(isIpAllowed("2001:db8::5", buildIpRule(["2001:db8::5"]))).toBe(true);
  });

  test("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "abc")).toBe(false);
  });

  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal && !isTailscaleV4(a.address))?.address;

  test.skipIf(!lanIp)("실제 요청: 허용 밖 주소에서 온 요청은 인증을 맞춰도 403", async () => {
    const c = makeConfig(["0.0.0.0"]);
    const b = new Bus();
    const s = new Store(openDb(c.dbPath), b);
    const running = await startServer({ config: c, store: s, bus: b, orch: fakeOrch(s).orch });
    try {
      const outside = await fetch(`http://${lanIp}:${running.port}/api/bootstrap`, { headers: auth });
      expect(outside.status).toBe(403);
      expect((await fetch(`http://${lanIp}:${running.port}/api/health`)).status).toBe(403);
      expect((await fetch(`http://127.0.0.1:${running.port}/api/bootstrap`, { headers: auth })).status).toBe(200);
    } finally {
      await running.stop();
    }
  });

  test("health 는 인증 없이, 나머지 /api 는 401", async () => {
    expect(await json(fetch(`${base}/api/health`))).toEqual({ ok: true, version: VERSION });
    for (const path of ["/api/bootstrap", `/api/projects/${projectId}/state`, "/api/herdr/agents"]) {
      expect((await fetch(base + path)).status).toBe(401);
      expect((await fetch(base + path, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await fetch(`${base}${path}?t=${CODE}`)).status).toBe(401);
    }
    expect((await fetch(`${base}/api/settings`, { method: "PUT", body: "{}" })).status).toBe(401);
  });

  test("Host: 다시 묶을 수 있는 바깥 이름은 코드가 맞아도 막는다", async () => {
    const res = await api("/api/bootstrap", { headers: { Host: "evil.example" } });
    expect(res.status).toBe(403);
    expect(isHostAllowed("evil.example:8080", [])).toBe(false);
    expect(isHostAllowed("evil.127.0.0.1.nip.io", [])).toBe(false);
    expect(isHostAllowed("127.0.0.1.evil.example", [])).toBe(false);
    expect(isHostAllowed(null, [])).toBe(false);
    for (const ok of ["127.0.0.1:4000", "100.70.1.2", "[::1]:4000", "localhost:4000", "mac-mini:4000", "mac-mini.local", "mac-mini.tail1234.ts.net"]) expect(isHostAllowed(ok, [])).toBe(true);
    expect(isHostAllowed("board.example:4000", ["board.example"])).toBe(true);
  });

  test("Origin 이 있으면 Host 와 같아야 한다", async () => {
    expect((await api("/api/bootstrap", { headers: { Origin: "http://evil.example" } })).status).toBe(403);
    expect((await api("/api/bootstrap", { headers: { Origin: "null" } })).status).toBe(403);
    expect((await api("/api/bootstrap", { headers: { Origin: `http://127.0.0.1:${server.port + 1}` } })).status).toBe(403);
    expect((await api("/api/bootstrap", { headers: { Origin: base } })).status).toBe(200);
  });

  test("없는 경로 404, 잘못된 메서드 405", async () => {
    expect((await api("/api/nope")).status).toBe(404);
    expect((await api("/api/bootstrap", { method: "DELETE" })).status).toBe(405);
  });

  test("루트는 네이티브 앱 안내이며 웹 파일은 제공하지 않는다", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toContain("Mac·iPhone 앱");
    expect((await fetch(`${base}/index.html`)).status).toBe(404);
    expect((await fetch(`${base}/artifact-frame`)).status).toBe(404);
  });

  test("한 주소라도 열리면 뜬다", async () => {
    const c = makeConfig(["127.0.0.1", "203.0.113.1"]);
    const b = new Bus();
    const s = new Store(openDb(c.dbPath), b);
    const warn = console.warn;
    console.warn = () => {};
    const running = await startServer({ config: c, store: s, bus: b, orch: fakeOrch(s).orch });
    console.warn = warn;
    expect(running.hosts).toEqual(["127.0.0.1"]);
    await running.stop();
  });
});

describe("REST", () => {
  test("bootstrap", async () => {
    const b = await json<Bootstrap>(api("/api/bootstrap"));
    expect(b.version).toBe(VERSION);
    expect(b.home).toBe(config.home);
    expect(b.settings.compactAtPct).toBe(70);
    expect(b.projects.map((p) => p.id)).toContain("hq");
    expect(b.herdr.installed).toBe(false);
  });

  test("member lastActiveAt is additive in state/sync and bootstrap keeps its existing shape", async () => {
    const p = store.createProject({ name: "활동 응답", cwd });
    const active = store.createMember({ projectId: p.id, handle: "active", name: "활동 직원", kind: "worker" });
    const empty = store.createMember({ projectId: p.id, handle: "empty", name: "새 직원", kind: "worker" });
    const activity = store.appendActivity(active.id, "tool", "실제 작업");
    const state = await json<ProjectState>(api(`/api/projects/${p.id}/state`));
    expect(state.members.find(m => m.id === active.id)?.lastActiveAt).toBe(activity.at);
    expect(state.members.find(m => m.id === empty.id)).toHaveProperty("lastActiveAt", null);
    const sync = await json<{ state: ProjectState; bootstrap: Bootstrap }>(api(`/api/sync?projectId=${p.id}`));
    expect(sync.state.members).toEqual(state.members);
    const bootstrap = await json<Bootstrap>(api("/api/bootstrap"));
    // Bootstrap에는 원래 Member 객체가 없으므로 새 members 봉투를 만들지 않는다.
    expect(bootstrap).not.toHaveProperty("members");
    expect(sync.bootstrap).not.toHaveProperty("members");
    expect(bootstrap.projects.map(project => project.id)).toContain(p.id);
    const patched = await json<Member>(api(`/api/members/${active.id}`, { method: "PATCH", body: { modelOverride: null } }));
    expect(patched.lastActiveAt).toBe(activity.at);
  });

  test("프로젝트 만들기: 검증·~ 펼치기 안 된 경로 거부·orch 호출", async () => {
    await json(api("/api/projects", { method: "POST", body: { name: "", cwd } }), 400);
    await json(api("/api/projects", { method: "POST", body: { name: "a", cwd: "상대/경로" } }), 400);
    await json(api("/api/projects", { method: "POST", body: { name: "a", cwd: join(cwd, "없음") } }), 400);
    await json(api("/api/projects", { method: "POST", body: { name: "a", cwd, backend: "headless" } }), 400);
    const res = await fetch(`${base}/api/projects`, { method: "POST", headers: auth, body: "not json" });
    expect(res.status).toBe(400);

    const p = await json<Project>(api("/api/projects", { method: "POST", body: { name: "새 프로젝트", cwd, goal: "목표", startConductor: true } }));
    expect(p.name).toBe("새 프로젝트");
    expect(callsOf("createProject").at(-1)!.args[0]).toMatchObject({ goal: "목표", startConductor: true });
  });

  test("프로젝트 패치: store 에 쓰고 orch 에 알림, 본사 보관 거부", async () => {
    const p = await json<Project>(api(`/api/projects/${projectId}`, { method: "PATCH", body: { now: "지금", runnerEnabled: false } }));
    expect(p).toMatchObject({ now: "지금", runnerEnabled: false });
    expect(callsOf("onProjectPatched").at(-1)!.args).toEqual([projectId, { now: "지금", runnerEnabled: false }]);
    // 이 뒤의 시험은 연결된 프로젝트로 보낸다.
    await json<Project>(api(`/api/projects/${projectId}`, { method: "PATCH", body: { runnerEnabled: true } }));
    await json(api("/api/projects/hq", { method: "PATCH", body: { archived: true } }), 400);
    await json(api("/api/projects/nope", { method: "PATCH", body: { now: "x" } }), 404);
  });

  test("state·messages 페이징", async () => {
    const p = store.createProject({ name: "페이징", cwd });
    const made = [1, 2, 3, 4, 5].map((i) => store.createMessage({ projectId: p.id, kind: "알림", body: String(i) }));
    const state = await json<ProjectState>(api(`/api/projects/${p.id}/state`));
    expect(state.project.id).toBe(p.id);
    expect(state.messages.map((m) => m.body)).toEqual(["1", "2", "3", "4", "5"]);
    const page = await json<Message[]>(api(`/api/projects/${p.id}/messages?before=${encodeURIComponent(made[3]!.at)}&limit=2`));
    expect(page.map((m) => m.body)).toEqual(["2", "3"]);
    await json(api(`/api/projects/${p.id}/messages?limit=abc`), 400);
    await json(api("/api/projects/nope/state"), 404);
  });

  test("멱등 메시지: 같은 id 재전송은 orch 를 다시 부르지 않고 같은 글을 돌려준다", async () => {
    const before = callsOf("sendUserMessage").length;
    const body = { id: "c7d0f3a2-1111-4222-8333-444455556666", text: "안녕" };
    const a = await json<Message>(api(`/api/projects/${projectId}/messages`, { method: "POST", body }));
    const b = await json<Message>(api(`/api/projects/${projectId}/messages`, { method: "POST", body: { ...body, text: "다른 글" } }));
    expect(b).toEqual(a);
    expect(b.body).toBe("안녕");
    expect(callsOf("sendUserMessage").length).toBe(before + 1);
    expect(store.listMessages(projectId).filter((m) => m.id === body.id).length).toBe(1);
    const other = store.createProject({ name: "다른", cwd });
    await json(api(`/api/projects/${other.id}/messages`, { method: "POST", body }), 409);
  });

  test("동시 재전송: orch 처리 중에 온 같은 메시지·답은 한 번만 처리하고, 다른 답은 409", async () => {
    const c = makeConfig();
    const b = new Bus();
    const s = new Store(openDb(c.dbPath), b);
    const { orch } = fakeOrch(s);
    let sends = 0;
    let answers = 0;
    orch.sendUserMessage = async (pid, req) => {
      sends++;
      await Bun.sleep(30);
      return s.createMessage({ id: req.id, projectId: pid, kind: "나", mine: true, body: req.text });
    };
    orch.answerDecision = async (id, req) => {
      answers++;
      await Bun.sleep(30);
      return s.answerDecision(id, req).decision;
    };
    const running = await startServer({ config: c, store: s, bus: b, orch });
    try {
      const url = `http://127.0.0.1:${running.port}`;
      const post = (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const p = s.createProject({ name: "동시", cwd });
      const sent = { id: "same-id", text: "한 번" };
      const [m1, m2] = await Promise.all([post(`/api/projects/${p.id}/messages`, sent), post(`/api/projects/${p.id}/messages`, sent)]);
      expect([m1.status, m2.status]).toEqual([200, 200]);
      expect(sends).toBe(1);

      const d = s.createDecision({ projectId: p.id, who: "김", title: "q", options: [{ k: "a", label: "A" }, { k: "b", label: "B" }] });
      const path = `/api/decisions/${d.id}/answer`;
      const results = await Promise.all([post(path, { choice: "a" }), post(path, { choice: "a" }), post(path, { choice: "b" })]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 409]);
      expect(answers).toBe(1);
      expect(s.requireDecision(d.id).choice).toBe("a");
    } finally {
      await running.stop();
    }
  });

  test("메시지 검증: 빈 글, 다른 프로젝트 직원, 없는 첨부, 위험한 id", async () => {
    const path = `/api/projects/${projectId}/messages`;
    await json(api(path, { method: "POST", body: { text: "   " } }), 400);
    await json(api(path, { method: "POST", body: { text: "x", id: "../../x" } }), 400);
    await json(api(path, { method: "POST", body: { text: "x", attachmentIds: ["a_none"] } }), 400);
    const other = store.createProject({ name: "남", cwd });
    const stranger = store.createMember({ projectId: other.id, handle: "s", name: "남직원", kind: "worker" });
    await json(api(path, { method: "POST", body: { text: "x", targetMemberId: stranger.id } }), 400);
    await json(api(path, { method: "POST", body: { text: "x", targetMemberId: "m_none" } }), 400);
    await json(api("/api/projects/nope/messages", { method: "POST", body: { text: "x" } }), 404);
  });

  test("멱등 답: 같은 답은 그대로, 다른 답은 409, orch 는 한 번만", async () => {
    const d = store.createDecision({ projectId, who: "김", title: "고르기", options: [{ k: "a", label: "A" }, { k: "b", label: "B" }] });
    const path = `/api/decisions/${d.id}/answer`;
    const before = callsOf("answerDecision").length;
    await json(api(path, { method: "POST", body: { choice: "z" } }), 400);
    await json(api(path, { method: "POST", body: {} }), 400);
    const first = await json<Decision>(api(path, { method: "POST", body: { choice: "a", note: "메모" } }));
    expect(first).toMatchObject({ status: "answered", choice: "a", note: "메모" });
    const second = await json<Decision>(api(path, { method: "POST", body: { choice: "a", note: "메모" } }));
    expect(second).toEqual(first);
    await json(api(path, { method: "POST", body: { choice: "b" } }), 409);
    await json(api(path, { method: "POST", body: { choice: "a" } }), 409);
    expect(callsOf("answerDecision").length).toBe(before + 1);
    await json(api("/api/decisions/nope/answer", { method: "POST", body: { choice: "a" } }), 404);
  });

  test("할 일: 값이 바뀔 때만 orch 호출", async () => {
    const t = store.createTodo({ projectId, title: "서명" });
    const path = `/api/todos/${t.id}/done`;
    const before = callsOf("setTodoDone").length;
    await json(api(path, { method: "POST", body: {} }), 400);
    expect((await json<Todo>(api(path, { method: "POST", body: { done: true } }))).done).toBe(true);
    expect((await json<Todo>(api(path, { method: "POST", body: { done: true } }))).done).toBe(true);
    expect(callsOf("setTodoDone").length).toBe(before + 1);
    expect((await json<Todo>(api(path, { method: "POST", body: { done: false } }))).done).toBe(false);
  });

  test("직원 조작: 활동·화면·잠재우기·다시 열기·압축·끊기·없는 직원 404", async () => {
    const m = store.createMember({ projectId, handle: "ops", name: "운영", kind: "worker" });
    store.appendActivity(m.id, "text", "하나");
    store.appendActivity(m.id, "text", "둘");
    const list = await json<{ text: string }[]>(api(`/api/members/${m.id}/activity?limit=1`));
    expect(list.map((a) => a.text)).toEqual(["둘"]);
    expect(await json(api(`/api/members/${m.id}/screen`))).toEqual({ text: "화면 글" });
    expect((await json<Member>(api(`/api/members/${m.id}/sleep`, { method: "POST" }))).status).toBe("asleep");
    for (const action of ["resume", "compact", "interrupt"]) {
      const res = await json<Member & { token?: string }>(api(`/api/members/${m.id}/${action}`, { method: "POST" }));
      expect(res.id).toBe(m.id);
      expect(res.token).toBeUndefined();
    }
    expect(callsOf("memberCompact").at(-1)!.args).toEqual([m.id]);
    await json(api("/api/members/nope/sleep", { method: "POST" }), 404);
    await json(api("/api/members/nope/screen"), 404);
  });

  test("승인 창: 대표만 읽고 고른다, 본문 검사, 직원 토큰으로는 못 한다", async () => {
    const m = store.createMember({ projectId, handle: "apv", name: "승인", kind: "worker" });
    const got = await json<{ approval: { fingerprint: string } }>(api(`/api/members/${m.id}/approval`));
    expect(got.approval.fingerprint).toBe("abcdef0123456789abcdef01");
    expect(await json(api(`/api/members/${m.id}/approval`, { method: "POST", body: { fingerprint: "abcdef0123456789abcdef01", option: 2, note: "다른 폴더로" } }))).toEqual({ ok: true });
    expect(callsOf("answerApproval").at(-1)!.args).toEqual([m.id, { fingerprint: "abcdef0123456789abcdef01", option: 2, note: "다른 폴더로" }]);
    await json(api(`/api/members/${m.id}/approval`, { method: "POST", body: { fingerprint: "0".repeat(24), option: 1 } }), 409);
    for (const bad of [{ fingerprint: "xyz", option: 1 }, { fingerprint: "abcdef0123456789abcdef01", option: 0 }, { fingerprint: "abcdef0123456789abcdef01", option: 1, extra: 1 }, { option: 1 }]) {
      await json(api(`/api/members/${m.id}/approval`, { method: "POST", body: bad }), 400);
    }
    await json(api("/api/members/nope/approval"), 404);
    // 직원 토큰은 대표 API 를 쓰지 못한다.
    const token = store.getMemberToken(m.id);
    const res = await fetch(`${base}/api/members/${m.id}/approval`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ fingerprint: "abcdef0123456789abcdef01", option: 1 }) });
    expect(res.status).toBe(401);
    expect(callsOf("answerApproval").length).toBe(2);
  });

  test("총괄 띄우기·herdr 목록·편입", async () => {
    const p = store.createProject({ name: "편입", cwd });
    const lead = await json<Member>(api(`/api/projects/${p.id}/conductor/start`, { method: "POST" }));
    expect(lead.kind).toBe("conductor");
    const agents = await json<{ paneId: string }[]>(api("/api/herdr/agents"));
    expect(agents[0]!.paneId).toBe("p1");
    await json(api(`/api/projects/${p.id}/adopt`, { method: "POST", body: { paneId: "", name: "x", role: "r" } }), 400);
    await json(api(`/api/projects/${p.id}/adopt`, { method: "POST", body: { paneId: "p1", name: "x", role: "r", handle: "BAD" } }), 400);
    const adopted = await json<Member>(api(`/api/projects/${p.id}/adopt`, { method: "POST", body: { paneId: "p1", name: "편입 직원", role: "일", handle: "adopt1" } }));
    expect(adopted).toMatchObject({ origin: "adopted", paneId: "p1", handle: "adopt1" });
    await json(api(`/api/projects/${p.id}/adopt/preview`), 400);
    expect(await json(api(`/api/projects/${p.id}/adopt/preview?pane=p1`))).toMatchObject({ paneId: "p1", screen: "화면" });
    expect(await json(api(`/api/members/${adopted.id}/reopen-with-tools`, { method: "POST" }))).toMatchObject({ id: adopted.id });
    expect(await json(api(`/api/members/${adopted.id}/release`, { method: "POST" }))).toEqual({ notified: true, paneKept: true, resumeCommand: null });
    await json(api(`/api/members/${adopted.id}/release`, { method: "POST" }), 404);
    expect((await json<{ cli: string }>(api("/api/bootstrap"))).cli).toBe("iamceo-시험");
  });

  test("설정: 범위 검사·모르는 키 거부·저장", async () => {
    await json(api("/api/settings", { method: "PUT", body: { compactAtPct: 0 } }), 400);
    await json(api("/api/settings", { method: "PUT", body: { maxConcurrentTurns: 1.5 } }), 400);
    await json(api("/api/settings", { method: "PUT", body: { hack: 1 } }), 400);
    const s = await json<Settings>(api("/api/settings", { method: "PUT", body: { compactAtPct: 65, backend: "headless" } }));
    expect(s).toMatchObject({ compactAtPct: 65, backend: "headless" });
    expect(store.getSettings().compactAtPct).toBe(65);
  });

  test("orch 의 ApiError 는 그 코드로, 다른 오류는 500 으로", async () => {
    const m = store.createMember({ projectId, handle: "err", name: "오류", kind: "worker" });
    const token = store.getMemberToken(m.id);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const denied = await fetch(`${base}/agent/tool`, { method: "POST", headers, body: JSON.stringify({ name: "denied" }) });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "거부" });
    const original = console.error;
    console.error = () => {};
    const boom = await fetch(`${base}/agent/tool`, { method: "POST", headers, body: JSON.stringify({ name: "boom" }) });
    console.error = original;
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ error: "도구 터짐" });
  });
});

describe("새 읽기 계약", () => {
  test("strict page·커서 오류 code·총괄 정규화·v1 배열 호환", async () => {
    const p = store.createProject({ name: "paging HTTP", cwd, runnerEnabled: false });
    const worker = store.createMember({ projectId: p.id, handle: "worker", name: "worker", kind: "worker" });
    const lead = store.createMember({ projectId: p.id, handle: "lead", name: "lead", kind: "conductor" });
    for (let i = 0; i < 205; i++) store.createMessage({ id: `http_page_${String(i).padStart(3, "0")}`, projectId: p.id, at: "same", kind: "알림", memberId: worker.id });
    const beforeCalls = calls.length;
    const path = `/api/projects/${p.id}/messages/page`;
    const response = await api(path);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = await response.json() as MessagePage;
    expect(first.items).toHaveLength(200);
    expect(first.hasOlder).toBe(true);
    const older = await json<MessagePage>(api(`${path}?cursor=${first.nextCursor}&limit=100`));
    expect(older.items.map((m) => m.id)).toEqual(Array.from({ length: 5 }, (_, i) => `http_page_00${i}`));
    expect(older).toMatchObject({ hasOlder: false, nextCursor: null });
    expect(await json<MessagePage>(api(`${path}?scope=member&memberId=${lead.id}&limit=1`))).toMatchObject({ scope: { kind: "project" } });
    expect((await json<MessagePage>(api(`${path}?scope=member&memberId=${worker.id}`))).items).toHaveLength(200);
    expect((await json<MessagePage>(api(`${path}?scope=member&memberId=removed`))).items).toEqual([]);
    for (const query of ["limit=", "limit=0", "limit=-1", "limit=1.5", "limit=1e2", "limit=Infinity", "limit=501", "limit=1&limit=2", "scope=", "scope=other", "scope=member", "scope=member&memberId=", "memberId=x", "scope=project&memberId=x", "before=x", "offset=0", "after=x", "order=asc", "scope=project&scope=member", `scope=member&memberId=${encodeURIComponent("가".repeat(86))}`]) {
      const r = await api(`${path}?${query}`);
      expect([query, r.status]).toEqual([query, 400]);
      expect(await r.json()).toMatchObject({ code: "INVALID_MESSAGE_PAGE_QUERY" });
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    for (const cursor of ["", "%", "a".repeat(4097), "eyJ", first.nextCursor + "x"]) {
      expect(await json(api(`${path}?cursor=${encodeURIComponent(cursor!)}`), 400)).toMatchObject({ code: "INVALID_MESSAGE_CURSOR" });
    }
    expect((await json<Message[]>(api(`/api/projects/${p.id}/messages`))).length).toBe(200);
    expect((await json<ProjectState>(api(`/api/projects/${p.id}/state`))).messages).toHaveLength(200);
    expect(calls.length).toBe(beforeCalls);
    await json(api("/api/projects/no-such/messages/page"), 404);
    const foreign = store.createProject({ name: "다른", cwd });
    expect(await json(api(`/api/projects/${foreign.id}/messages/page?cursor=${first.nextCursor}`), 400)).toMatchObject({ code: "INVALID_MESSAGE_CURSOR" });
  });

  test("메시지 단건 접수 확인과 과거 around·다른 프로젝트 경계", async () => {
    const p = store.createProject({ name: "around", cwd, runnerEnabled: false });
    const made = Array.from({ length: 250 }, (_, i) => store.createMessage({ id: `around_${String(i).padStart(3, "0")}`, projectId: p.id, at: "same", kind: "완료" }));
    expect(await json<Message>(api(`/api/messages/${made[20]!.id}`))).toEqual(made[20]);
    const path = `/api/projects/${p.id}/messages`;
    expect((await json<Message[]>(api(`${path}?around=${made[20]!.id}`))).map((m) => m.id)).toEqual(made.slice(0, 41).map((m) => m.id));
    expect(await json<Message[]>(api(`${path}?around=${made[0]!.id}&limit=1`))).toEqual([made[0]!]);
    for (const query of ["around=", "around=x&before=a", "around=x&limit=101", "around=x&limit=0", "around=x&limit=1e2", "around=x&around=x", "around=x&offset=0", "around=x&limit=2&limit=3"]) await json(api(`${path}?${query}`), 400);
    await json(api(`${path}?around=missing`), 404);
    await json(api(`/api/projects/hq/messages?around=${made[20]!.id}`), 404);
    await json(api("/api/messages/missing"), 404);
    await json(api(`/api/messages/${made[20]!.id}?x=1`), 400);
  });

  test("새 조회는 Bearer만 허용하고 인증 오류도 no-store", async () => {
    const m = store.createMember({ projectId, handle: "read_auth", name: "읽기 인증", kind: "worker" });
    const attempts: RequestInit[] = [{}, { headers: { Authorization: `Bearer ${store.getMemberToken(m.id)}` } }, { headers: { Cookie: `iamceo_files_${server.port}=x` } }];
    for (const path of ["/api/capabilities", "/api/sync", `/api/projects/${projectId}/messages/page`, `/api/projects/${projectId}/archive/state`, "/api/messages/missing"]) {
      for (const init of attempts) {
        const res = await fetch(base + path + `?t=${CODE}`, init);
        expect(res.status).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
    }
    const capabilities = await json(api("/api/capabilities"));
    expect(capabilities).toEqual({ contractVersion: 2, capabilities: { paging: true, archive: true, realtime: true, delivery: false, push: false, operations: false } });
  });

  test("예외 로그에 비밀 query·헤더·오류 본문이 남지 않는다", async () => {
    const m = store.createMember({ projectId, handle: "log_auth", name: "로그", kind: "worker" });
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await fetch(`${base}/agent/tool?t=query-secret-canary`, { method: "POST", headers: { Authorization: `Bearer ${store.getMemberToken(m.id)}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "boom" }) });
      expect(response.status).toBe(500);
      expect(log.mock.calls).toEqual([["요청 처리 오류:", "POST", "/agent/tool", "Error"]]);
    } finally { log.mockRestore(); }
  });
});

describe("업로드·다운로드", () => {
  async function upload(file: File, headers: Record<string, string> = auth): Promise<Response> {
    const form = new FormData();
    form.set("file", file);
    return fetch(`${base}/api/uploads`, { method: "POST", headers, body: form });
  }

  test("왕복: 이름 정리, 헤더, 헤더 인증, ?t= 는 401", async () => {
    const att = await json<Attachment>(upload(new File(["hello 한글"], "../../보고서 최종.txt", { type: "text/plain" })));
    expect(att.name).toBe("보고서 최종.txt");
    expect(att.id).toMatch(/^a_/);
    expect(att.path.startsWith(config.uploadsDir)).toBe(true);
    expect(att.isImage).toBe(false);

    const byHeader = await fetch(base + att.url, { headers: auth });
    expect(byHeader.status).toBe(200);
    expect(await byHeader.text()).toBe("hello 한글");
    expect(byHeader.headers.get("x-content-type-options")).toBe("nosniff");
    expect(byHeader.headers.get("content-security-policy")).toContain("sandbox");
    expect(byHeader.headers.get("content-type")).toStartWith("text/plain");

    expect((await fetch(`${base}${att.url}?t=${CODE}`)).status).toBe(401);
    expect((await fetch(base + att.url)).status).toBe(401);
    expect((await fetch(`${base}${att.url}?t=wrong`)).status).toBe(401);
  });

  test("첨부: html·svg 는 문서로 열리지 않고, 주소의 접속 코드로 문서 이동을 못 한다", async () => {
    const svg = await json<Attachment>(upload(new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "a.svg", { type: "image/svg+xml" })));
    const html = await json<Attachment>(upload(new File(["<meta name='referrer' content='unsafe-url'>"], "a.html", { type: "text/html" })));
    const png = await json<Attachment>(upload(new File(["x"], "b.png", { type: "image/png" })));
    for (const att of [svg, html]) {
      const res = await fetch(base + att.url, { headers: auth });
      expect(res.headers.get("content-disposition")).toStartWith("attachment");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect((await fetch(base + png.url, { headers: auth })).headers.get("content-disposition")).toStartWith("inline");
    const viaQuery = (att: Attachment, dest: string) => fetch(`${base}${att.url}?t=${CODE}`, { headers: { "Sec-Fetch-Dest": dest } });
    // 평문 HTTP 브라우저는 Sec-Fetch-Dest 를 안 보낸다. 어떤 값이든 주소의 코드로는 못 받는다.
    for (const dest of ["document", "iframe", "image", ""]) {
      expect((await viaQuery(png, dest)).status).toBe(401);
      expect((await viaQuery(html, dest)).status).toBe(401);
    }
    expect((await fetch(base + html.url, { headers: { ...auth, "Sec-Fetch-Dest": "empty" } })).status).toBe(200);
  });

  test("웹 파일 세션과 기존 파일 쿠키를 더 이상 받지 않는다", async () => {
    const png = await json<Attachment>(upload(new File(["x"], "c.png", { type: "image/png" })));
    for (const method of ["POST", "DELETE"]) {
      const response = await api("/api/files-session", { method });
      expect(response.status).toBe(404);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect((await fetch(`${base}/api/files-session`, { method })).status).toBe(401);
    }
    expect((await fetch(base + png.url, { headers: { Cookie: `iamceo_files_${server.port}=${createHmac("sha256", CODE).update("iamceo-files").digest("hex")}` } })).status).toBe(401);
    expect((await fetch(base + png.url, { headers: auth })).status).toBe(200);
  });

  test("이미지·첨부를 메시지에 붙일 수 있다", async () => {
    const att = await json<Attachment>(upload(new File(["x"], "a.png", { type: "image/png" })));
    expect(att.isImage).toBe(true);
    await json(api(`/api/projects/${projectId}/messages`, { method: "POST", body: { text: "", attachmentIds: [att.id] } }));
  });

  test("경로 탈출은 모두 막힌다", async () => {
    const att = await json<Attachment>(upload(new File(["x"], "ok.txt", { type: "text/plain" })));
    for (const path of [
      `/files/${att.id}/..%2f..%2f..%2fetc%2fpasswd`,
      `/files/${att.id}/%2e%2e%2fconfig.json`,
      `/files/..%2f..%2fconfig.json/x`,
      `/files/${att.id}/다른이름.txt`,
      `/files/${att.id}`,
      `/files/a_none/ok.txt`,
      `/files/%ZZ/ok.txt`,
    ]) {
      const res = await fetch(base + path, { headers: auth });
      expect([path, res.status === 404 || res.status === 400]).toEqual([path, true]);
      expect(await res.text()).not.toContain(CODE);
    }
    // fetch 가 정규화한 경로도 uploads 밖을 주지 않는다.
    const normalized = await fetch(`${base}/files/${att.id}/../../config.json`, { headers: auth });
    expect(await normalized.text()).not.toContain(CODE);
  });

  test("DB 의 경로가 uploads 밖을 가리켜도 내주지 않는다", async () => {
    const outside = join(config.home, "config.json");
    store.createAttachment({ id: "a_escape", name: "config.json", mime: "text/plain", size: 1, path: outside });
    expect((await fetch(`${base}/files/a_escape/config.json`, { headers: auth })).status).toBe(404);
    const link = join(config.uploadsDir, "linked");
    symlinkSync(outside, link);
    store.createAttachment({ id: "a_link", name: "linked", mime: "text/plain", size: 1, path: link });
    expect((await fetch(`${base}/files/a_link/linked`, { headers: auth })).status).toBe(404);
  });

  test("잘못된 요청과 크기 제한", async () => {
    const noFile = await fetch(`${base}/api/uploads`, { method: "POST", headers: auth, body: new FormData() });
    expect(noFile.status).toBe(400);
    const notForm = await fetch(`${base}/api/uploads`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" });
    expect(notForm.status).toBe(400);
    const big = await upload(new File([new Uint8Array(50 * 1024 * 1024 + 1)], "big.bin"));
    expect(big.status).toBe(413);
    expect((await fetch(`${base}/api/uploads`, { method: "POST" })).status).toBe(401);
  });
});

describe("WebSocket", () => {
  function connect(url: string, headers: Record<string, string> = auth): Promise<{ ws: WebSocket; events: WsEvent[]; next: (pred: (e: WsEvent) => boolean) => Promise<WsEvent> }> {
    return new Promise((resolve, reject) => {
      const ws = new (WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket)(url, { headers });
      const events: WsEvent[] = [];
      const waiters: { pred: (e: WsEvent) => boolean; done: (e: WsEvent) => void }[] = [];
      ws.onmessage = (m) => {
        const e = JSON.parse(String(m.data)) as WsEvent;
        events.push(e);
        for (const w of [...waiters]) {
          if (w.pred(e)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.done(e);
          }
        }
      };
      const next = (pred: (e: WsEvent) => boolean) =>
        new Promise<WsEvent>((done, failNext) => {
          const found = events.find(pred);
          if (found) return done(found);
          waiters.push({ pred, done });
          setTimeout(() => failNext(new Error("WS 이벤트를 기다리다 시간 초과")), 3000);
        });
      ws.onopen = () => resolve({ ws, events, next });
      ws.onerror = () => reject(new Error("WS 연결 실패"));
    });
  }

  const wsUrl = () => `ws://127.0.0.1:${server.port}/ws`;

  test("tool activity sends no extra member broadcasts and turn notifications carry lastActiveAt", async () => {
    const connection = await connect(wsUrl());
    try {
      await connection.next(event => event.type === "hello");
      const member = store.createMember({ projectId, handle: "wsactivity", name: "활동방송직원", kind: "worker" });
      const start = store.appendActivity(member.id, "turn_start", "시작");
      store.patchMember(member.id, { status: "working" });
      for (let i = 0; i < 100; i++) store.appendActivity(member.id, i % 2 ? "tool" : "tool_result", `도구 ${i}`);
      const end = store.appendActivity(member.id, "turn_end", "종료");
      store.patchMember(member.id, { status: "idle" });
      await connection.next(event => event.type === "member" && event.member.id === member.id && event.member.status === "idle" && event.member.lastActiveAt === end.at);
      const members = connection.events.filter((event): event is Extract<WsEvent, { type: "member" }> => event.type === "member" && event.member.id === member.id);
      expect(members.map(event => [event.member.status, event.member.lastActiveAt])).toEqual([
        ["idle", null], ["working", start.at], ["idle", end.at],
      ]);
      expect(connection.events.filter(event => event.type === "activity" && event.activity.memberId === member.id)).toHaveLength(102);
    } finally { connection.ws.close(); }
  });

  test("코드 틀리면 연결 안 됨", async () => {
    await expect(connect(wsUrl(), { Authorization: "Bearer wrong" })).rejects.toThrow("WS 연결 실패");
    const res = await fetch(`${base}/ws`);
    expect(res.status).toBe(401);
  });

  test("다른 출처에서는 코드가 맞아도 거부", async () => {
    const res = await fetch(`${base}/ws?t=${CODE}`, {
      headers: { Origin: "http://evil.example", Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    expect(res.status).toBe(403);
  });

  test("hello 뒤 store 쓰기와 REST 쓰기를 모든 연결에 방송한다", async () => {
    const a = await connect(wsUrl());
    const b = await connect(wsUrl());
    const hello = await a.next((e) => e.type === "hello");
    expect(hello).toEqual({ type: "hello", seq: expect.any(Number) });

    const msg = store.createMessage({ projectId, kind: "알림", body: "방송 시험" });
    const pred = (e: WsEvent) => e.type === "message" && e.message.id === msg.id;
    expect(await a.next(pred)).toMatchObject({ type: "message", message: { body: "방송 시험" } });
    await b.next(pred);

    const m = store.createMember({ projectId, handle: "wsman", name: "방송직원", kind: "worker" });
    const token = store.getMemberToken(m.id);
    await a.next((e) => e.type === "member" && e.member.id === m.id);
    store.appendActivity(m.id, "text", "활동");
    await a.next((e) => e.type === "activity" && e.projectId === projectId);

    await json(api("/api/settings", { method: "PUT", body: { maxAwakeWorkers: 9 } }));
    await b.next((e) => e.type === "settings" && e.settings.maxAwakeWorkers === 9);
    await a.next((e) => e.type === "projects");

    expect(JSON.stringify(a.events)).not.toContain(token);
    a.ws.close();
    b.ws.close();
  });
});

describe("/agent", () => {
  let member: Member;
  let headers: Record<string, string>;

  beforeAll(() => {
    member = store.createMember({ projectId, handle: "agent1", name: "에이전트", kind: "worker", origin: "manual" });
    headers = { Authorization: `Bearer ${store.getMemberToken(member.id)}`, "Content-Type": "application/json" };
  });

  test("멤버 토큰만 통과한다. 접속 코드로는 안 된다", async () => {
    expect((await fetch(`${base}/agent/tools`)).status).toBe(401);
    expect((await fetch(`${base}/agent/tools`, { headers: auth })).status).toBe(401);
    expect((await fetch(`${base}/agent/tools`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/agent/tool`, { method: "POST", headers: auth, body: JSON.stringify({ name: "status" }) })).status).toBe(401);
    expect((await fetch(`${base}/api/bootstrap`, { headers })).status).toBe(401);
  });

  test("도구 목록과 호출: 호출한 멤버를 넘기고 updatedAt 을 갱신한다", async () => {
    const tools = await json<{ name: string; description: string }[]>(fetch(`${base}/agent/tools`, { headers }));
    expect(tools).toEqual([{ name: "status", description: "agent1 전용", inputSchema: { type: "object" } } as never]);

    store.db.query("UPDATE members SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(member.id);
    const res = await json(fetch(`${base}/agent/tool`, { method: "POST", headers, body: JSON.stringify({ name: "status", args: { now: "일" } }) }));
    expect(res).toEqual({ text: "ok:status" });
    expect(callsOf("handleAgentTool").at(-1)!.args).toEqual([member.id, "status", { now: "일" }]);
    expect(store.getMember(member.id)!.updatedAt).not.toBe("2000-01-01T00:00:00.000Z");

    await json(fetch(`${base}/agent/tool`, { method: "POST", headers, body: JSON.stringify({ args: {} }) }), 400);
    await json(fetch(`${base}/agent/tool`, { method: "POST", headers, body: "x" }), 400);
    expect((await fetch(`${base}/agent/tool`, { headers })).status).toBe(405);
  });

  test("ask/wait: 답 전후, 제한 시간 상한, 다른 멤버·프로젝트의 결재 거부", async () => {
    const d = store.createDecision({ projectId, memberId: member.id, who: "에이전트", title: "물음", options: [{ k: "a", label: "A" }] });
    const wait = (body: unknown) => fetch(`${base}/agent/ask/wait`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(await json(wait({ decisionId: d.id, timeoutMs: 999_999 }))).toEqual({ done: false });
    expect(callsOf("askWait").at(-1)!.args).toEqual([member.id, d.id, 50_000]);

    store.answerDecision(d.id, { choice: "a" });
    expect(await json<{ done: boolean; text: string }>(wait({ decisionId: d.id, timeoutMs: 100 }))).toMatchObject({ done: true, text: "a" });
    expect(callsOf("askWait").at(-1)!.args[2]).toBe(100);

    const others = store.createDecision({ projectId, memberId: null, who: "남", title: "남의 물음" });
    expect((await wait({ decisionId: others.id })).status).toBe(403);
    const elsewhere = store.createDecision({ projectId: "hq", memberId: member.id, who: "남", title: "다른 프로젝트" });
    expect((await wait({ decisionId: elsewhere.id })).status).toBe(404);
    expect((await wait({ decisionId: "d_none" })).status).toBe(404);
    expect((await wait({})).status).toBe(400);
  });

  test("ask/wait 롱폴은 Bun 기본 유휴 제한(10초)보다 오래 버틴다", async () => {
    const c = makeConfig();
    const b = new Bus();
    const s = new Store(openDb(c.dbPath), b);
    const { orch } = fakeOrch(s);
    orch.askWait = async () => {
      await Bun.sleep(11_000);
      return { done: false };
    };
    const running = await startServer({ config: c, store: s, bus: b, orch });
    try {
      const p = s.createProject({ name: "롱폴", cwd });
      const m = s.createMember({ projectId: p.id, handle: "w", name: "대기", kind: "worker", origin: "manual" });
      const d = s.createDecision({ projectId: p.id, memberId: m.id, who: "대기", title: "q" });
      const res = await fetch(`http://127.0.0.1:${running.port}/agent/ask/wait`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.getMemberToken(m.id)}`, "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: d.id }),
      });
      expect(await res.json()).toEqual({ done: false });
    } finally {
      await running.stop();
    }
  }, 15_000);

  test("join: 세션 id 는 UUID 만 받고, 실행기 세션의 id 는 토큰으로 바꾸지 못한다", async () => {
    const join_ = (body: unknown, h: Record<string, string> = auth) =>
      fetch(`${base}/agent/join`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    for (const bad of ["--dangerously-skip-permissions", "x; touch /tmp/pwn #", "$(id)", "--settings={}"]) {
      expect((await join_({ project: projectId, name: "위조", sessionId: bad })).status).toBe(400);
    }
    const runner = store.createMember({ projectId, handle: "managed2", name: "실행기 직원2", kind: "worker", sessionId: SESSION_1 });
    const token = store.getMemberToken(runner.id);
    expect((await join_({ sessionId: SESSION_2 }, { Authorization: `Bearer ${token}` })).status).toBe(409);
    expect((await join_({ sessionId: "--dangerously-skip-permissions" }, { Authorization: `Bearer ${token}` })).status).toBe(400);
    expect(store.requireMember(runner.id).sessionId).toBe(SESSION_1);
    expect((await join_({ sessionId: SESSION_1 }, { Authorization: `Bearer ${token}` })).status).toBe(200);
  });

  test("join: 접속 코드로 등록, 같은 핸들은 재합류, 토큰으로 이어 붙이기", async () => {
    const join_ = (body: unknown, h: Record<string, string> = auth) =>
      fetch(`${base}/agent/join`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body) });

    expect((await join_({ project: projectId, name: "x" }, {})).status).toBe(401);
    expect((await join_({ project: projectId, name: "x" }, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await fetch(`${base}/agent/join`, { headers: auth })).status).toBe(405);
    expect((await join_({ project: "없는 프로젝트", name: "x" })).status).toBe(404);
    expect((await join_({ cwd: "/nowhere/at/all", name: "x" })).status).toBe(404);
    expect((await join_({ project: projectId })).status).toBe(400);

    const created = await json<{ member: Member; token: string; project: Project }>(join_({ project: projectId, name: "직접 세션", handle: "manual1", role: "조사", sessionId: SESSION_1 }));
    expect(created.member).toMatchObject({ origin: "manual", kind: "worker", handle: "manual1", sessionId: SESSION_1, status: "idle", role: "조사" });
    expect(created.project.id).toBe(projectId);
    expect(store.getMemberByToken(created.token)!.id).toBe(created.member.id);

    const again = await json<{ member: Member; token: string }>(join_({ project: projectId, handle: "manual1", sessionId: SESSION_2 }));
    expect(again.member.id).toBe(created.member.id);
    expect(again.member.sessionId).toBe(SESSION_2);
    expect(again.token).toBe(created.token);

    store.patchMember(created.member.id, { status: "offline" });
    const byToken = await json<{ member: Member }>(join_({ sessionId: SESSION_3 }, { Authorization: `Bearer ${created.token}` }));
    expect(byToken.member).toMatchObject({ id: created.member.id, status: "idle", sessionId: SESSION_3 });

    const runner = store.createMember({ projectId, handle: "managed", name: "실행기 직원", kind: "worker" });
    expect((await join_({ project: projectId, handle: runner.handle })).status).toBe(409);

    const byCwd = await json<{ project: Project; member: Member }>(join_({ cwd: join(cwd, "하위"), name: "cwd 세션" }));
    expect(byCwd.project.cwd).toBe(cwd);
    expect(byCwd.member.handle).toMatch(/^[a-z]/);
  });
});
