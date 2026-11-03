// 실제 서버 + 실제 브리지 프로세스 + SDK 클라이언트. 세션은 fake-claude 로만 돈다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Backend, Member } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { type Config, loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { HeadlessRunner } from "../server/runner/headless.ts";
import type { Runner } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";

const FAKE = resolve(import.meta.dir, "fixtures", "fake-claude.ts");
const CLI = resolve(import.meta.dir, "..", "bin", "iamceo.ts");
const CODE = "bridge-code";

let home: string;
let config: Config;
let bus: Bus;
let store: Store;
let orch: Orchestrator;
let server: RunningServer;
let url: string;
let projectId: string;
let lead: Member;
let logPath: string;
const clients: Client[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "iamceo-bridge-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"], claudeBin: FAKE }, env);
  config = loadConfig(env);
  bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  logPath = join(home, "calls.jsonl");
  const runner = new HeadlessRunner(
    { claudeBin: FAKE },
    { env: { ...process.env, FAKE_CLAUDE_LOG: logPath, FAKE_CLAUDE_SESSIONS: join(home, "sessions"), FAKE_CLAUDE_DIRECTIVES: "" } },
  );
  orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["headless", runner]]) });
  server = await startServer({ config, store, bus, orch });
  url = server.urls[0]!;
  orch.setServerUrl(url);
  projectId = store.createProject({ name: "브리지 시험", cwd: home }).id;
  lead = await orch.ensureConductor(projectId);
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await orch.shutdown();
  await server.stop();
});

async function connect(token: string, opts: { url?: string; env?: Record<string, string> } = {}): Promise<Client> {
  const client = new Client({ name: "시험", version: "1" });
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", IAMCEO_URL: opts.url ?? url, IAMCEO_TOKEN: token, ...opts.env };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" }));
  clients.push(client);
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text: string }[];
  return { text: content.map((c) => c.text).join(""), isError: r.isError === true };
}

async function waitFor<T>(what: string, read: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`시간 초과: ${what}`);
    await Bun.sleep(15);
  }
}

async function join_(body: Record<string, unknown>): Promise<{ member: Member; token: string }> {
  const res = await fetch(`${url}/agent/join`, { method: "POST", headers: { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return (await res.json()) as { member: Member; token: string };
}

describe("브리지 왕복", () => {
  test("총괄: 목록과 도구 전 종류를 실제 프로세스로 왕복한다", async () => {
    const client = await connect(store.getMemberToken(lead.id));
    expect(client.getServerVersion()?.name).toBe("iamceo");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["status", "ask", "post", "file", "todo", "team_add", "team_assign", "roster", "project_now", "work_set"]));
    expect(tools.map((t) => t.name)).not.toContain("project_create");
    expect(tools.find((t) => t.name === "team_add")!.inputSchema.required).toEqual(["name", "role"]);

    expect(await callText(client, "status", { now: "일 나누는 중", next: "보고 받기" })).toMatchObject({ isError: false });
    expect(store.requireMember(lead.id)).toMatchObject({ now: "일 나누는 중", next: "보고 받기" });

    const file = await callText(client, "file", { title: "자료", content: "전문" });
    expect(file.isError).toBe(false);
    const fileId = /#(f_\S+?)\./.exec(file.text)![1]!;
    expect(store.getFile(fileId)).toMatchObject({ title: "자료", body: "전문" });

    expect(await callText(client, "post", { kind: "알림", title: "알립니다", file_ids: [fileId] })).toMatchObject({ isError: false });
    expect(store.listMessages(projectId).at(-1)).toMatchObject({ kind: "알림", title: "알립니다", fileId, who: expect.stringMatching(/총괄$/) });

    const asked = await callText(client, "ask", { title: "고르세요", detail: "배경", options: [{ k: "a", label: "가" }] });
    expect(asked.isError).toBe(false);
    expect(asked.text).toContain("턴을 끝내세요");
    const decision = store.listDecisions(projectId).find((d) => d.title === "고르세요")!;
    expect(decision.status).toBe("open");

    // 답은 다음 턴 입력으로 들어간다.
    await orch.answerDecision(decision.id, { choice: "a" });
    await waitFor("답 전달", () => existsSync(logPath) && readFileSync(logPath, "utf8").includes(`[대표 답(원문) '고르세요'] \\"가\\" #${decision.id}`));
    await waitFor("총괄 쉼", () => store.requireMember(lead.id).status === "idle");

    const added = await callText(client, "team_add", { name: "철수", role: "개발", handle: "chulsu", first_instruction: "로그인 고치기 @fake:delay=500" });
    expect(added).toMatchObject({ isError: false });
    expect(added.text).toContain("철수(chulsu)");
    const worker = store.findMember(projectId, "chulsu")!;
    expect(worker.sessionId).not.toBeNull();
    await waitFor("첫 지시 시작", () => store.requireMember(worker.id).status === "working");

    const queued = await callText(client, "team_assign", { member: "철수", text: "둘째 일 @fake:post=끝났습니다", user_quote: "대표가 안 한 말" });
    expect(queued.text).toContain("대기열 1번째");
    expect(queued.text).toContain("미확인");

    const roster = JSON.parse((await callText(client, "roster")).text) as { handle: string; queued: number }[];
    expect(roster.map((r) => r.handle)).toEqual(["lead", "chulsu"]);

    // 대기열의 지시가 실제로 흘러가고 fake-claude 의 post 가 대화까지 돌아온다.
    await waitFor("직원 보고", () => store.listMessages(projectId).find((m) => m.who === "철수" && m.title === "끝났습니다"));
    const prompts = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; prompt: string }).filter((l) => l.event === "start").map((l) => l.prompt);
    expect(prompts.some((p) => p.includes('총괄 인용(미확인): "대표가 안 한 말"') && p.includes("둘째 일"))).toBe(true);
    await waitFor("직원 쉼", () => store.requireMember(worker.id).status === "idle" && store.requireMember(lead.id).status === "idle");
  }, 30_000);

  test("본사 AI: project_create 와 project_list", async () => {
    const root = await orch.ensureConductor("hq");
    const client = await connect(store.getMemberToken(root.id));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["project_create", "project_list"]));
    expect(names).not.toContain("team_add");

    const dir = join(home, "new-project");
    mkdirSync(dir);
    const made = await callText(client, "project_create", { name: "새 프로젝트", cwd: dir, goal: "랜딩 만들기" });
    expect(made).toMatchObject({ isError: false });
    const project = store.listProjects().find((p) => p.name === "새 프로젝트")!;
    expect(project).toMatchObject({ cwd: dir, now: "랜딩 만들기" });

    const list = JSON.parse((await callText(client, "project_list")).text) as { id: string }[];
    expect(list.map((p) => p.id)).toContain(project.id);
  }, 15_000);
});

describe("잘못된 호출", () => {
  test("잘못된 토큰: 목록은 프로토콜 오류, 호출은 도구 오류, 둘 다 원인을 말한다", async () => {
    const client = await connect("tk_wrong_token");
    await expect(client.listTools()).rejects.toThrow("토큰");
    const r = await callText(client, "status", { now: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("토큰을 거부");
  }, 15_000);

  test("접속 코드는 멤버 토큰이 아니다", async () => {
    const r = await callText(await connect(CODE), "roster");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("토큰");
  }, 15_000);

  test("서버 연결 실패는 도구 오류로 알려 준다", async () => {
    const dead = "http://127.0.0.1:9";
    const client = await connect(store.getMemberToken(lead.id), { url: dead });
    await expect(client.listTools()).rejects.toThrow("연결할 수 없습니다");
    const r = await callText(client, "status", { now: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`IAMCEO 서버(${dead})에 연결할 수 없습니다`);
  }, 15_000);

  test("다른 프로젝트 멤버 지정, 인자 오류, 권한 없는 도구는 도구 오류", async () => {
    const other = store.createProject({ name: "다른 프로젝트", cwd: home });
    const { member: stranger } = await orch.addMember(other.id, { name: "남", handle: "stranger", role: "개발" });
    const client = await connect(store.getMemberToken(lead.id));
    const r = await callText(client, "team_assign", { member: stranger.handle, text: "일" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain("이 프로젝트에 없는 직원");
    expect((await callText(client, "team_assign", { text: "대상 없음" })).isError).toBe(true);
    expect((await callText(client, "project_create", { name: "x", cwd: home })).isError).toBe(true);
    expect((await callText(client, "없는도구")).isError).toBe(true);
  }, 15_000);

  test("환경변수가 없으면 stdout 을 더럽히지 않고 stderr 로 알린 뒤 끝난다", async () => {
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const p = Bun.spawn([process.execPath, CLI, "mcp"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stdout).text()).toBe("");
    expect(await new Response(p.stderr).text()).toContain("IAMCEO_TOKEN");
  });
});

describe("직접 띄운 CLI 의 ask", () => {
  test("wait 가 도구 목록에 있고, ask 는 답이 올 때까지 잡고 그대로 돌려준다, 그동안 progress", async () => {
    const { member, token } = await join_({ project: projectId, name: "손님", role: "조사", cwd: home });
    expect(member.origin).toBe("manual");
    const client = await connect(token, { env: { IAMCEO_PROGRESS_MS: "40" } });
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("wait");

    const progress: number[] = [];
    const pending = client.callTool(
      { name: "ask", arguments: { title: "손님 질문", detail: "배경", options: [{ k: "y", label: "좋아요", desc: "진행" }] } },
      CallToolResultSchema,
      { onprogress: (p) => progress.push(p.progress), resetTimeoutOnProgress: true },
    );
    const decision = await waitFor("카드", () => store.listDecisions(projectId).find((d) => d.title === "손님 질문"));
    await waitFor("progress 두 번", () => progress.length >= 2);
    expect(progress[1]!).toBeGreaterThan(progress[0]!);

    await orch.answerDecision(decision.id, { choice: "y", note: "메모요" });
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect((result.content as { text: string }[])[0]!.text).toBe(`[대표 답(원문) '손님 질문'] "좋아요"(진행) 메모 "메모요" #${decision.id}`);
    expect(store.requireDecision(decision.id).status).toBe("delivered");

    const count = progress.length;
    await Bun.sleep(120);
    expect(progress.length).toBe(count);
  }, 15_000);

  test("progressToken 이 없어도 ask 는 기다려 답을 돌려준다", async () => {
    const { token } = await join_({ project: projectId, name: "손님2", cwd: home });
    const client = await connect(token);
    const pending = callText(client, "ask", { title: "자유 답 질문", detail: "배경" });
    const decision = await waitFor("카드", () => store.listDecisions(projectId).find((d) => d.title === "자유 답 질문"));
    await orch.answerDecision(decision.id, { note: "알아서 하세요" });
    expect((await pending).text).toContain('"알아서 하세요"');
  }, 15_000);

  test("wait 왕복: 지시를 받는다", async () => {
    const { token } = await join_({ project: projectId, name: "손님3", handle: "guest3", cwd: home });
    const client = await connect(token);
    await orch.assign(projectId, "guest3", { text: "밀린 일" });
    expect((await callText(client, "wait", { timeout_sec: 1 })).text).toContain("할 일: 밀린 일");
  }, 15_000);

  test("답을 기다리는 도중 서버 프로세스가 죽었다 살아나도 이어서 받는다", async () => {
    const serverHome = mkdtempSync(join(tmpdir(), "iamceo-bridge-restart-"));
    updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, { IAMCEO_HOME: serverHome });
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port!;
    await probe.stop(true);
    const base = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" };
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(HERDR_|CLAUDE)/.test(k))) as Record<string, string>;
    const start = async () => {
      const p = Bun.spawn([process.execPath, CLI, "serve"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...childEnv, IAMCEO_TEST: "1", IAMCEO_HOME: serverHome, IAMCEO_PORT: String(port), IAMCEO_HERDR_SOCKET: join(serverHome, "no.sock"), IAMCEO_CLAUDE_BIN: FAKE },
      });
      const end = Date.now() + 15_000;
      while (!(await fetch(`${base}/api/health`).then((r) => r.ok, () => false))) {
        if (Date.now() > end) throw new Error("서버가 뜨지 않았습니다");
        await Bun.sleep(30);
      }
      return p;
    };

    const first = await start();
    let current = first;
    try {
      const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "재시작", cwd: serverHome }) })).json()) as { id: string };
      const joined = (await (await fetch(`${base}/agent/join`, { method: "POST", headers, body: JSON.stringify({ project: project.id, name: "손님", cwd: serverHome }) })).json()) as { token: string };
      const client = await connect(joined.token, { url: base });
      const pending = callText(client, "ask", { title: "재시작 질문", detail: "배경" });
      const decisionId = await (async () => {
        for (;;) {
          const state = (await (await fetch(`${base}/api/projects/${project.id}/state`, { headers })).json()) as { decisions: { id: string }[] };
          if (state.decisions[0]) return state.decisions[0].id;
          await Bun.sleep(20);
        }
      })();

      first.kill("SIGKILL");
      await first.exited;
      await Bun.sleep(300);
      current = await start();
      const answered = await fetch(`${base}/api/decisions/${decisionId}/answer`, { method: "POST", headers, body: JSON.stringify({ note: "재시작 뒤 답" }) });
      expect(answered.status).toBe(200);
      const r = await pending;
      expect(r.isError).toBe(false);
      expect(r.text).toContain("재시작 뒤 답");
    } finally {
      current.kill("SIGTERM");
    }
  }, 40_000);
});
