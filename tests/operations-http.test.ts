import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { ApiError, Store } from "../server/store.ts";
import type { OperationReceipt } from "../shared/operations.ts";

const code = "operations-http-fixture";
const home = mkdtempSync("/private/tmp/iamceo-operations-http-");
let store: Store;
let server: RunningServer;
let base: string;
let memberId: string;
let manualId: string;
let todoId: string;
let projectId: string;
let orch: OrchestratorApi;
const calls: { name: string; args: unknown[] }[] = [];
const receipts = new Map<string, OperationReceipt>();
const auth = { Authorization: `Bearer ${code}` };
const v2 = { ...auth, "X-IAMCEO-Contract": "2" };
const request = (path: string, body?: unknown, headers: Record<string, string> = v2, method = "POST") => fetch(base + path, {
  method, headers: { ...headers, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeAll(async () => {
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: code, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  projectId = store.createProject({ name: "쓰기 경계", cwd: home }).id;
  memberId = store.createMember({ projectId, handle: "worker", name: "직원", kind: "worker" }).id;
  manualId = store.createMember({ projectId, handle: "manual", name: "직접 직원", kind: "worker", origin: "manual" }).id;
  todoId = store.createTodo({ projectId, title: "업무" }).id;
  // 명시한 포트 외의 호출은 실패한다. 실제 실행기는 생성하지 않는다.
  const legacy = (name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    if (name === "updateSettings") return store.patchSettings(args[0] as Parameters<Store["patchSettings"]>[0]);
    if (name === "setTodoDone") return store.setTodoDone(args[0] as string, args[1] as boolean).todo;
    if (name === "handleAgentTool") return { text: "legacy" };
    if (name === "terminalControl") return { memberId, action: "claim", leaseId: "legacy", expiresAt: 1 };
    return store.requireMember(memberId);
  };
  orch = Object.fromEntries(["updateSettings", "patchMemberConfig", "setTodoDone", "freshMemberSession", "terminalControl", "handleAgentTool"].map(name => [name, legacy(name)])) as unknown as OrchestratorApi;
  server = await startServer({ config, store, bus, orch });
  while (server.port === 7878) { await server.stop(); server = await startServer({ config, store, bus, orch }); }
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => { await server?.stop(); store?.db.close(); rmSync(home, { recursive: true }); });

test("미지원 v2는 501이며 v1 포트로 쓰지 않는다; capability는 false", async () => {
  const before = calls.length;
  const matching = { ...v2, "If-Match": '"0"' };
  const entries: [string, unknown, Record<string, string>, string?][] = [
    ["/api/settings", { notifyMac: false }, matching, "PUT"],
    [`/api/members/${memberId}`, { modelOverride: "opus" }, matching, "PATCH"],
    [`/api/todos/${todoId}/done`, { done: false }, matching],
    [`/api/members/${memberId}/fresh-session`, { operationId: randomUUID(), expectedSessionGeneration: 0 }, v2],
    [`/api/members/${memberId}/terminal/control`, { operationId: randomUUID(), expectedSessionGeneration: 0, claimId: "claim", action: "claim" }, v2],
  ];
  for (const [path, body, headers, method] of entries) expect((await request(path, body, headers, method)).status).toBe(501);
  expect((await request(`/api/operations/${randomUUID()}`, undefined, v2, "GET")).status).toBe(501);
  const token = { Authorization: `Bearer ${store.getMemberToken(manualId)}`, "X-IAMCEO-Contract": "2" };
  expect((await request("/agent/tool", { name: "post", operationId: randomUUID() }, token)).status).toBe(501);
  expect((await request("/agent/inbox/wait", {}, token)).status).toBe(501);
  expect((await request("/agent/inbox/ack", { batchId: "batch" }, token)).status).toBe(501);
  expect(calls).toHaveLength(before);
  const capabilities = await (await request("/api/capabilities", undefined, auth, "GET")).json();
  expect(capabilities).toMatchObject({ capabilities: { operations: false, delivery: false, push: false } });
});

test("revision header와 엄격 body를 검사한다", async () => {
  for (const value of [undefined, "0", 'W/"0"', '"-1"', '"1.1"', '"1e2"', '"9007199254740992"', '"1", "2"', "*"]) {
    const headers = { ...v2, ...(value === undefined ? {} : { "If-Match": value }) };
    expect((await request("/api/settings", { notifyMac: true }, headers, "PUT")).status).toBe(400);
    expect((await request(`/api/members/${memberId}`, {}, headers, "PATCH")).status).toBe(400);
    expect((await request(`/api/todos/${todoId}/done`, { done: false }, headers)).status).toBe(400);
  }
  for (const body of [{}, { operationId: "bad", expectedSessionGeneration: 0 }, { operationId: randomUUID(), expectedSessionGeneration: -1 }, { operationId: randomUUID(), expectedSessionGeneration: 1.2 }, { operationId: randomUUID(), expectedSessionGeneration: 0, extra: true }]) {
    expect((await request(`/api/members/${memberId}/fresh-session`, body)).status).toBe(400);
  }
  const identity = { operationId: randomUUID(), claimId: "claim", expectedSessionGeneration: 0 };
  for (const body of [
    { ...identity, action: "claim", inputSequence: 0 }, { ...identity, action: "release", leaseId: "bad" },
    { ...identity, action: "input", text: "text" }, { ...identity, action: "key", key: "enter" },
    { ...identity, action: "input", text: "", inputSequence: 0 }, { ...identity, action: "key", key: "enter", inputSequence: -1 },
    { ...identity, action: "key", key: "enter", inputSequence: 0, text: "extra" },
  ]) expect((await request(`/api/members/${memberId}/terminal/control`, body)).status).toBe(400);
  const matching = { ...v2, "If-Match": '"0"' };
  expect((await request("/api/settings", { ranks: { manager: { token: "bad" } } }, matching, "PUT")).status).toBe(400);
  expect((await request(`/api/todos/${todoId}/done`, { done: true, expectedRevision: 0 }, matching)).status).toBe(400);
  expect((await request("/api/settings", {}, { ...matching, "X-IAMCEO-Contract": "3" }, "PUT")).status).toBe(400);
});

test("v2 CAS 포트는 검토 revision을 그대로 받고 같은 done도 우회하지 않는다", async () => {
  orch.updateSettingsV2 = async (patch, precondition) => store.patchSettingsCas(patch, precondition.expectedRevision);
  orch.patchMemberConfigV2 = async (id, patch, precondition) => store.patchMemberCas(id, patch, precondition.expectedRevision);
  orch.setTodoDoneV2 = async (id, body, precondition) => store.setTodoDoneCas(id, body.done, precondition.expectedRevision);
  const revision = store.settingsRevision();
  const response = await request("/api/settings", { ranks: { manager: { model: "opus" } } }, { ...v2, "If-Match": `"${revision}"` }, "PUT");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ settings: { ranks: { manager: { model: "opus" } } }, revision: revision + 1 });
  const stale = await request("/api/settings", { notifyMac: false }, { ...v2, "If-Match": `"${revision}"` }, "PUT");
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "REVISION_CONFLICT" });
  const memberRevision = store.memberRevisions(memberId).configRevision;
  expect((await request(`/api/members/${memberId}`, { effortOverride: "high" }, { ...v2, "If-Match": `"${memberRevision}"` }, "PATCH")).status).toBe(200);
  const todoRevision = store.todoRevision(todoId);
  expect((await request(`/api/todos/${todoId}/done`, { done: true }, { ...v2, "If-Match": `"${todoRevision}"` })).status).toBe(200);
  expect((await request(`/api/todos/${todoId}/done`, { done: true }, { ...v2, "If-Match": `"${todoRevision}"` })).status).toBe(409);
});

test("receipt 조회와 쓰기는 pending/applied/refused/unknown 및 code를 보존한다", async () => {
  orch.operation = async id => { const receipt = receipts.get(id); if (!receipt) throw new ApiError(404, "없는 작업"); return receipt; };
  const at = new Date().toISOString();
  for (const status of ["pending", "applied", "refused", "unknown"] as const) {
    const id = randomUUID();
    const common = { operationId: id, projectId, memberId, kind: "terminal_control" as const, createdAt: at, updatedAt: at };
    const receipt: OperationReceipt<"terminal_control"> = status === "pending" ? { ...common, status } : status === "applied" ? { ...common, status, result: { memberId, action: "key", claimId: "claim", sessionGeneration: 0, inputSequence: 0 } } : { ...common, status, code: "WRITE_UNCERTAIN", error: "입력 결과 불명" };
    Object.assign(receipt, { request: { token: "secret-canary" } });
    receipts.set(id, receipt);
    orch.terminalControlV2 = async () => receipt;
    for (const response of [await request(`/api/operations/${id}`, undefined, v2, "GET"), await request(`/api/members/${memberId}/terminal/control`, { operationId: id, expectedSessionGeneration: 0, action: "key", claimId: "claim", inputSequence: 0, key: "enter" })]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const result = await response.json();
      expect(result).toMatchObject({ status, operationId: id });
      expect(JSON.stringify(result)).not.toContain("secret-canary");
      if (status === "refused" || status === "unknown") expect(result).toMatchObject({ code: "WRITE_UNCERTAIN", error: "입력 결과 불명" });
    }
  }
  expect((await request(`/api/operations/${randomUUID()}`, undefined, auth, "GET")).status).toBe(404);
  expect((await request(`/api/operations/${randomUUID()}`, undefined, { Authorization: `Bearer ${store.getMemberToken(memberId)}` }, "GET")).status).toBe(401);
  orch.freshMemberSessionV2 = async (id, body) => {
    const prior = receipts.get(body.operationId);
    if (prior) return prior as OperationReceipt<"fresh_session">;
    const receipt: OperationReceipt<"fresh_session"> = { operationId: body.operationId, projectId, memberId: id, kind: "fresh_session", createdAt: at, updatedAt: at, status: "applied", result: { member: store.requireMember(id), sessionGeneration: body.expectedSessionGeneration + 1 } };
    receipts.set(body.operationId, receipt);
    return receipt;
  };
  const body = { operationId: randomUUID(), expectedSessionGeneration: 0 };
  const first = await (await request(`/api/members/${memberId}/fresh-session`, body)).json();
  expect(await (await request(`/api/members/${memberId}/fresh-session`, body)).json()).toEqual(first);
  const receipt = receipts.get(body.operationId)! as OperationReceipt<"fresh_session">;
  if (receipt.status === "applied") Object.assign(receipt.result.member, { token: "member-token-canary", request: { secret: "request-canary" } });
  const safe = await (await request(`/api/operations/${body.operationId}`, undefined, v2, "GET")).text();
  expect(safe).not.toContain("member-token-canary");
  expect(safe).not.toContain("request-canary");
});

test("agent operationId와 manual batch ACK는 인증한 직원에 결합된다", async () => {
  const headers = { Authorization: `Bearer ${store.getMemberToken(manualId)}`, "X-IAMCEO-Contract": "2" };
  const id = randomUUID();
  orch.handleAgentOperation = async (member, name, args, context, signal) => {
    expect(member.id).toBe(manualId); expect(name).toBe("post"); expect(args).toEqual({ text: "보고" }); expect(context).toEqual({ operationId: id }); expect(signal).toBeDefined();
    return { text: "접수" };
  };
  expect((await request("/agent/tool", { name: "post" }, headers)).status).toBe(400);
  expect(await (await request("/agent/tool", { name: "post", args: { text: "보고" }, operationId: id }, headers)).json()).toEqual({ text: "접수" });
  const legacyHeaders = { Authorization: headers.Authorization };
  expect(await (await request("/agent/tool", { name: "post", args: { text: "보고" }, operationId: id }, legacyHeaders)).json()).toEqual({ text: "접수" });
  expect((await request("/agent/tool", { name: "post", operationId: id, extra: true }, legacyHeaders)).status).toBe(400);
  const batch = { id: "batch", memberId: manualId, createdAt: "2026", items: [{ deliveryId: "d", text: "답", ref: null }] };
  let acknowledged = false;
  orch.manualInbox = async (id, timeout, signal) => { expect(id).toBe(manualId); expect(timeout).toBe(50000); expect(signal).toBeDefined(); return acknowledged ? null : batch; };
  orch.acknowledgeManualInbox = async (id, body) => { expect(id).toBe(manualId); expect(body).toEqual({ batchId: batch.id }); acknowledged = true; return { batchId: batch.id, acknowledged: true }; };
  for (let i = 0; i < 2; i++) expect(await (await request("/agent/inbox/wait", { timeoutMs: 60000 }, headers)).json()).toEqual(batch);
  for (let i = 0; i < 2; i++) expect(await (await request("/agent/inbox/ack", { batchId: batch.id }, headers)).json()).toEqual({ batchId: batch.id, acknowledged: true });
  expect(await (await request("/agent/inbox/wait", {}, headers)).json()).toBeNull();
  expect((await request("/agent/inbox/ack", { batchId: "batch", memberId }, headers)).status).toBe(400);
  expect((await request("/agent/inbox/ack", { batchId: "batch" }, { Authorization: `Bearer ${store.getMemberToken(memberId)}` })).status).toBe(403);
  expect((await request("/agent/inbox/ack", { batchId: "batch" }, auth)).status).toBe(401);
  store.patchProject(projectId, { archived: true });
  expect((await request("/agent/inbox/wait", {}, headers)).status).toBe(404);
  expect((await request("/agent/inbox/ack", { batchId: "batch" }, headers)).status).toBe(404);
  store.patchProject(projectId, { archived: false });
});

test("구형 무본문 fresh·terminal·설정·업무·도구 응답을 유지한다", async () => {
  expect((await request(`/api/members/${memberId}/fresh-session`, undefined, auth)).status).toBe(200);
  expect(await (await request(`/api/members/${memberId}/terminal/control`, { action: "claim" }, auth)).json()).toEqual({ memberId, action: "claim", leaseId: "legacy", expiresAt: 1 });
  expect((await request("/api/settings", { notifyMac: false }, auth, "PUT")).status).toBe(200);
  expect((await request(`/api/todos/${todoId}/done`, { done: false }, auth)).status).toBe(200);
  expect(await (await request("/agent/tool", { name: "post" }, { Authorization: `Bearer ${store.getMemberToken(manualId)}` })).json()).toEqual({ text: "legacy" });
});

test("엄격 결재 답은 문자열 expectedVersion을 요구하고 같은 답의 재요청을 보존한다", async () => {
  const decision = store.createDecision({ projectId, memberId: manualId, who: "직접 직원", title: "질문" });
  const path = `/api/decisions/${decision.id}/answer`;
  for (const body of [{ note: "답" }, { note: "답", expectedVersion: 1 }, { note: "답", expectedVersion: decision.updatedAt, extra: true }]) {
    expect((await request(path, body)).status).toBe(400);
  }
  expect((await request(path, { note: "답", expectedVersion: "stale" })).status).toBe(409);
  const answered = store.answerDecision(decision.id, { note: "답", expectedVersion: decision.updatedAt }).decision;
  // 이미 접수된 동일 답은 연결/버전을 재검사하기 전에 반환한다.
  expect(await (await request(path, { note: "답", expectedVersion: decision.updatedAt })).json()).toEqual(answered);
  expect((await request(path, { note: "다른 답", expectedVersion: answered.updatedAt })).status).toBe(409);
});
