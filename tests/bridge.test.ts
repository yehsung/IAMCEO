// 실제 서버 + 실제 브리지 프로세스 + SDK 클라이언트. 세션은 시험용 core 틀(가짜 core 안의 가짜 CLI)로만 돈다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Member } from "../shared/types.ts";
import type { Orchestrator } from "../server/orchestrator.ts";
import { ApiError, type Store } from "../server/store.ts";
import type { AgentToolResult } from "../server/orchestrator-api.ts";
import type { AgentOperationService } from "../server/service-contracts.ts";
import { coreSetup, type CoreEnv } from "./fixtures/core-harness.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

// 브리지 프로세스의 환경과 가짜 HTTP 서버만 이 격리 틀에서 받는다. 서버·실행기는 시험용 core 틀이 만든다.
const runtime = createIsolatedRuntime();
const CLI = resolve(import.meta.dir, "..", "bin", "iamceo.ts");
const CODE = "code"; // 시험용 core 틀의 접속 코드

let t: CoreEnv;
let home: string;
let store: Store;
let orch: Orchestrator;
let url: string;
let projectId: string;
let lead: Member;
const clients: Client[] = [];
const operationRequests: { operationId: string; memberId: string; name: string; args: Record<string, unknown> }[] = [];

beforeAll(async () => {
  // 도구 구현은 넘기지 않는다: 총괄이 실제 도구(server/agent-tools.ts)를 쓴다.
  // core 는 턴의 마지막 글을 서버에 넘기지 않아, 대표의 결재 답으로 깬 총괄이 보고 없이 끝나면 '보고 보완' 턴이 붙는다.
  // 실제 총괄처럼 답을 받은 턴에 보고하게 해서 뒤 시험의 글 수 세기가 흔들리지 않게 한다.
  t = await coreSetup({ script: [{ when: "[대표 답(원문) '고르세요']", tools: [{ name: "post", args: { kind: "완료", title: "답을 받았습니다" } }], silent: true }] });
  home = t.home; store = t.store; orch = t.orch; url = t.base;
  // W1 AgentOperationService fake. The actual receipt engine is owned by the
  // orchestration integration; this fixture checks bridge identity, never invents success.
  const pending = new Map<string, { request: string; result: Promise<AgentToolResult> }>();
  const operations: AgentOperationService = {
    execute(member, name, args, context, signal) {
      operationRequests.push({ ...context, memberId: member.id, name, args });
      const request = JSON.stringify([member.id, name, args]);
      const previous = pending.get(context.operationId);
      if (previous) {
        if (previous.request !== request) throw new ApiError(409, "다른 요청에 사용된 operationId입니다", "OPERATION_CONFLICT");
        return previous.result;
      }
      const result = orch.handleAgentTool(member, name, args, signal);
      pending.set(context.operationId, { request, result });
      return result;
    },
  };
  Object.assign(orch, { handleAgentOperation: operations.execute.bind(operations) });
  projectId = t.project.id;
  lead = await orch.ensureConductor(projectId);
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await t.close();
  await runtime.stop();
});

async function connect(token: string, opts: { url?: string; env?: Record<string, string> } = {}): Promise<Client> {
  const client = new Client({ name: "시험", version: "1" });
  const env: Record<string, string> = { ...runtime.childEnv(), IAMCEO_URL: opts.url ?? url, IAMCEO_TOKEN: token, ...opts.env };
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
    await waitFor("답 전달", () => t.turns(lead.id).some((c) => c.prompt.includes(`[대표 답(원문) '고르세요'] "가" #${decision.id}`)));
    await t.idle(lead.id);
    // 답은 띄워 둔 총괄의 터미널에 다음 턴으로 들어갔다(새로 띄우지 않는다).
    expect(t.runs(lead.id)).toHaveLength(1);

    const added = await callText(client, "team_add", { name: "철수", role: "개발", handle: "chulsu", first_instruction: "로그인 고치기 @fake:delay=500 @fake:post=로그인고침" });
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

    // 대기열의 지시가 실제로 흘러가고 가짜 CLI 의 post 가 대화까지 돌아온다.
    await waitFor("직원 보고", () => store.listMessages(projectId).find((m) => m.who === "철수" && m.title === "끝났습니다"));
    const prompts = t.turns(worker.id).map((c) => c.prompt);
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

  test("CLI 환경에 HTTP_PROXY 가 있어도 이 Mac 의 서버로 바로 간다(팀장 열쇠가 프록시로 나가지 않는다, 리뷰 hooks-1)", async () => {
    const proxied: string[] = [];
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { proxied.push(req.url); return new Response("{}", { status: 502 }); } });
    try {
      const proxyUrl = `http://127.0.0.1:${proxy.port}`;
      const client = await connect(store.getMemberToken(lead.id), { env: { HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "example.internal" } });
      expect(await callText(client, "status", { now: "프록시 확인" })).toMatchObject({ isError: false });
      expect(store.requireMember(lead.id).now).toBe("프록시 확인");
      expect(proxied).toEqual([]);
    } finally { proxy.stop(true); }
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
    // 재시도 창을 짧게 둔다. 기본값은 서버 재시작을 넘기려고 수십 초를 버틴다.
    const client = await connect(store.getMemberToken(lead.id), { url: dead, env: { IAMCEO_CONNECT_RETRY_MS: "50" } });
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
    const env = runtime.childEnv();
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
    const received = await callText(client, "wait", { timeout_sec: 1 });
    expect(received.text).toContain("할 일: 밀린 일");
    const batch = JSON.parse(received.text) as { id: string; items: { deliveryId: string }[] };
    expect(store.requireDelivery(batch.items[0]!.deliveryId).status).not.toBe("delivered");
    expect((await callText(client, "wait", { timeout_sec: 1 })).text).toBe(received.text);
    expect(await callText(client, "wait", { ack_batch_id: batch.id })).toMatchObject({ isError: false });
    expect(store.requireDelivery(batch.items[0]!.deliveryId).status).toBe("delivered");
  }, 15_000);

  test("ask 답 조회의 응답 유실 후 같은 decisionId로 이어 받는다", async () => {
    let polls = 0;
    let registered = 0;
    const fake = runtime.serve(async req => {
      const path = new URL(req.url).pathname;
      if (path === "/agent/tool") {
        registered++;
        return Response.json({ text: "질문 등록", wait: { decisionId: "d_restart" } });
      }
      if (path === "/agent/ask/wait") {
        expect(await req.json()).toMatchObject({ decisionId: "d_restart" });
        if (++polls === 1) return new Response("{", { status: 200 });
        return Response.json({ done: true, text: "재시작 뒤 답", decision: {} });
      }
      return new Response("missing", { status: 404 });
    });
    const r = await callText(await connect("tk_fixture", { url: fake.url }), "ask", { title: "재시작 질문", detail: "배경" });
    expect(r).toMatchObject({ isError: false, text: "재시작 뒤 답" });
    expect(registered).toBe(1);
    expect(polls).toBe(2);
  }, 15_000);
});

describe("operation ID 계약", () => {
  test("같은 본문 새 호출은 별개이고 명시한 같은 ID만 결과를 회수한다", async () => {
    const client = await connect(store.getMemberToken(lead.id));
    const before = store.listMessages(projectId).length;
    const args = { kind: "알림", title: "같은 본문의 새 호출" };
    const first = await callText(client, "post", args);
    const second = await callText(client, "post", args);
    expect(first.text).not.toBe(second.text);
    expect(store.listMessages(projectId)).toHaveLength(before + 2);
    const requests = operationRequests.filter(r => r.args.title === args.title);
    expect(requests).toHaveLength(2);
    expect(z.uuid().safeParse(requests[0]!.operationId).success).toBe(true);
    expect(requests[0]!.operationId).not.toBe(requests[1]!.operationId);
    expect(await callText(client, "post", { ...args, operation_id: requests[0]!.operationId })).toEqual(first);
    expect(store.listMessages(projectId)).toHaveLength(before + 2);
    expect((await callText(client, "post", { ...args, title: "다른 요청", operation_id: requests[0]!.operationId })).isError).toBe(true);
    expect((await callText(client, "post", { ...args, operation_id: "잘못된 ID" })).isError).toBe(true);
    const { tools } = await client.listTools();
    expect((tools.find(t => t.name === "post")!.inputSchema.properties as Record<string, unknown>).operation_id).toMatchObject({ format: "uuid" });
  });

  test("성공 응답 유실은 같은 ID로 한 번 재요청하며 재연결에도 ID를 재사용한다", async () => {
    const received: { operationId: string; args: Record<string, unknown> }[] = [];
    const receipts = new Map<string, AgentToolResult>();
    let effects = 0;
    const fake = runtime.serve(async req => {
      expect(req.headers.get("X-IAMCEO-Contract")).toBe("2");
      const body = await req.json() as { operationId: string; args: Record<string, unknown> };
      received.push(body);
      let result = receipts.get(body.operationId);
      if (!result) { result = { text: `보고 #${++effects}` }; receipts.set(body.operationId, result); }
      if (received.length === 1) return new Response("{", { status: 200 });
      return Response.json(result);
    });
    const client = await connect("tk_fixture", { url: fake.url });
    const result = await callText(client, "post", { kind: "완료", title: "응답 유실" });
    expect(result).toMatchObject({ text: "보고 #1", isError: false });
    expect(received).toHaveLength(2);
    expect(received[0]!.operationId).toBe(received[1]!.operationId);
    expect(effects).toBe(1);
    const again = await connect("tk_fixture", { url: fake.url });
    expect(await callText(again, "post", { kind: "완료", title: "응답 유실", operation_id: received[0]!.operationId })).toEqual(result);
    expect(received.at(-1)!.args).not.toHaveProperty("operation_id");
    expect(effects).toBe(1);
  });

  test("서버 재시작 구간(503 STARTING)은 같은 ID로 다시 보내 넘기고, 도구 목록도 기다린다", async () => {
    const received: string[] = [];
    let lists = 0, polls = 0;
    const starting = () => Response.json({ error: "서버를 시작하는 중입니다", code: "STARTING" }, { status: 503 });
    const fake = runtime.serve(async req => {
      const path = new URL(req.url).pathname;
      if (path === "/agent/tools") return ++lists <= 2 ? starting() : Response.json([{ name: "post", description: "보고", inputSchema: { type: "object", properties: {} } }]);
      if (path === "/agent/ask/wait") return ++polls === 1 ? starting() : Response.json({ done: true, text: "재시작 뒤 답", decision: {} });
      const body = await req.json() as { operationId: string; name: string };
      received.push(body.operationId);
      // 종료 중인 서버는 처리 전에 돌려보낸다: 세 번째에야 받는다.
      if (received.length <= 2) return starting();
      return body.name === "ask" ? Response.json({ text: "질문 등록", wait: { decisionId: "d_restart" } }) : Response.json({ text: "보고 접수" });
    });
    const client = await connect("tk_fixture", { url: fake.url });
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(["post"]);
    expect(lists).toBe(3);
    expect(await callText(client, "post", { kind: "완료", title: "재시작 중 보고" })).toEqual({ text: "보고 접수", isError: false });
    expect(received).toHaveLength(3);
    expect(new Set(received).size).toBe(1);
    // 답을 기다리는 롱폴도 503 에 포기하지 않는다.
    expect(await callText(client, "ask", { title: "재시작 질문", detail: "배경" })).toEqual({ text: "재시작 뒤 답", isError: false });
    expect(polls).toBe(2);
  }, 15_000);

  test("재시도 창이 지나도 서버가 없으면 ID를 담은 도구 오류로 끝난다", async () => {
    let requests = 0;
    const fake = runtime.serve(async () => { requests++; return Response.json({ error: "서버를 시작하는 중입니다", code: "STARTING" }, { status: 503 }); });
    const client = await connect("tk_fixture", { url: fake.url, env: { IAMCEO_CONNECT_RETRY_MS: "0" } });
    const operationId = randomUUID();
    const result = await callText(client, "post", { kind: "완료", title: "서버 없음", operation_id: operationId });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("다시 시작하는 중");
    expect(result.text).toContain(operationId);
    // 창이 0 이어도 예전처럼 바로 한 번은 다시 보낸다.
    expect(requests).toBe(2);
    // 503 이라도 STARTING 이 아니면 서버가 판단한 거절이다. 다시 보내지 않는다.
    let refusals = 0;
    const refusing = runtime.serve(async () => { refusals++; return Response.json({ error: "실행기가 없습니다: core" }, { status: 503 }); });
    const refused = await callText(await connect("tk_fixture", { url: refusing.url }), "post", { kind: "완료", title: "거절" });
    expect(refused.isError).toBe(true); expect(refused.text).toContain("실행기가 없습니다");
    expect(refusals).toBe(1);
  }, 15_000);

  test("미지원 서비스는 ID를 보존한 오류이며 v1 재실행을 하지 않는다", async () => {
    const requests: unknown[] = [];
    const fake = runtime.serve(async req => {
      requests.push(await req.json());
      return Response.json({ error: "작업 ID 호출 미지원" }, { status: 501 });
    });
    const operationId = randomUUID();
    const result = await callText(await connect("tk_fixture", { url: fake.url }), "post", { kind: "완료", title: "거부", operation_id: operationId });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(operationId);
    expect(requests).toHaveLength(1);
  });
});
