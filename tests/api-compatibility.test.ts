import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, VERSION } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { startServer, type RunningServer, type ServerContext } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { PushStore } from "../server/push/store.ts";
import type { Runner, RunnerMember, RunnerStopOptions, SendResult } from "../server/runner/types.ts";
import { ApiError, Store } from "../server/store.ts";
import type { ManualInboxBatch, OperationReceipt } from "../shared/operations.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

// HTTP/Store/Orchestrator는 실제 구현, 외부 실행 경계만 대역이다.
class FakeRunner implements Runner {
  readonly kind = "core";
  starts = 0;
  sends = 0;
  stops: string[] = [];
  checks: string[] = [];
  terminalCalls = 0;
  stopError: Error | null = null;
  checkError: Error | null = null;
  stopGate: Promise<void> | null = null;
  async available() { return { ok: true }; }
  async start(member: RunnerMember) {
    this.starts++;
    return { sessionId: member.sessionId ?? randomUUID(), paneId: `fake:${member.id}` };
  }
  async send(): Promise<SendResult> { this.sends++; return { ok: true, started: false }; }
  isBusy() { return false; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async checkStop(member: RunnerMember, options?: RunnerStopOptions) {
    expect(options?.whileWorking).toBe(false);
    this.checks.push(member.id);
    if (this.checkError) throw this.checkError;
  }
  async stop(member: RunnerMember) {
    this.stops.push(member.id);
    await this.stopGate;
    if (this.stopError) throw this.stopError;
  }
  async screen() { return ""; }
  on() {}
  async shutdown() {}
  async terminalControl(): Promise<never> {
    this.terminalCalls++;
    throw new Error("가짜 입력 ACK 유실");
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(push = false) {
  const isolated = createIsolatedRuntime();
  const env = { IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0",
    IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin };
  updateConfigFile({ accessCode: "api-compatibility", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  store.patchSettings({ boardTidyHours: 0 });
  const runner = new FakeRunner();
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: isolated.providerHomes,
    timings: { tickMs: 60_000, healthMs: 60_000 } });
  const project = store.createProject({ name: "호환 시험", cwd: isolated.paths.work });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker",
    backend: "core", status: "idle", sessionId: randomUUID(), paneId: "fake:worker", cwd: isolated.paths.work });
  const manual = store.createMember({ projectId: project.id, handle: "manual", name: "직접 직원", kind: "worker", origin: "manual", status: "idle" });
  const context: ServerContext = { config, store, bus, orch, delivery: orch.deliveryRecovery,
    ...(push ? { push: { store: new PushStore(store.db), providers: () => [] } } : {}),
    daemon: () => ({ ready: true, buildId: "fixture-build", version: VERSION }) };
  let server: RunningServer | undefined;
  cleanups.push(async () => { await server?.stop(); await orch.shutdown(); store.db.close(); await isolated.stop(); });
  do { if (server) await server.stop(); server = await startServer(context); } while (server.port === 7878);
  const base = `http://127.0.0.1:${server.port}`;
  orch.setServerUrl(base);
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { isolated, config, bus, store, runner, orch, context, project, member, manual, request };
}

async function json<T = unknown>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return await response.json() as T;
}
const v2 = { "X-IAMCEO-Contract": "2" };

test("PATCH는 단일 진입점으로 cwd를 확장해 한 번 위임하고 hook/저장을 중복하지 않는다", async () => {
  const f = await fixture();
  const patch = spyOn(f.orch, "patchProject");
  const before = spyOn(f.orch, "beforeProjectPatch");
  const after = spyOn(f.orch, "onProjectPatched");
  const write = spyOn(f.store, "patchProject");
  try {
    const result = await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { name: " 새 이름 ", cwd: "~" }));
    expect(patch.mock.calls).toEqual([[f.project.id, { name: "새 이름", cwd: homedir() }]]);
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(result).toEqual(JSON.parse(JSON.stringify(f.store.requireProject(f.project.id))));
    expect(result).toMatchObject({ id: f.project.id, name: "새 이름" });
    expect(f.store.requireMember(f.member.id).sessionId).toBe(f.member.sessionId);
    await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { name: "새 이름" }));
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.runner.starts).toBe(0);
    expect(f.runner.stops).toEqual([]);
  } finally { patch.mockRestore(); before.mockRestore(); after.mockRestore(); write.mockRestore(); }
});

test("patchProject 미지원의 보관/v2는 501이며 옛 hook/Store로 쓰기를 우회하지 않는다", async () => {
  const f = await fixture();
  const api: OrchestratorApi = f.orch;
  api.patchProject = undefined;
  const before = spyOn(f.orch, "beforeProjectPatch");
  const after = spyOn(f.orch, "onProjectPatched");
  try {
    expect(await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { archived: true, name: "저장 금지" }), 501))
      .toEqual({ error: "프로젝트 변경을 지원하지 않습니다" });
    await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { archived: false }), 501);
    await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { name: "v2 저장 금지" }, v2), 501);
    await json(await f.request("/api/projects/hq", "PATCH", { archived: true }), 400);
    await json(await f.request("/api/projects/missing", "PATCH", { now: "없음" }), 404);
    await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { name: "" }), 400);
    await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { name: "계약 오류" }, { "X-IAMCEO-Contract": "3" }), 400);
    expect(f.store.requireProject(f.project.id)).toEqual(f.project);
    expect(before).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(f.runner.stops).toEqual([]);
  } finally { before.mockRestore(); after.mockRestore(); }
});

test("구형 v1 메타데이터 PATCH는 검증 뒤 한 번 저장·알림하고 무변경/보관은 부작용이 없다", async () => {
  const f = await fixture();
  const api: OrchestratorApi = f.orch;
  api.patchProject = undefined;
  // 구형 포트도 실제 CLI를 띄우지 않도록 후속 실행 경계만 대역으로 둔다.
  const before = spyOn(f.orch, "beforeProjectPatch").mockImplementation(async () => {});
  const after = spyOn(f.orch, "onProjectPatched").mockImplementation(async () => {});
  const write = spyOn(f.store, "patchProject");
  const path = `/api/projects/${f.project.id}`;
  try {
    for (const headers of [{}, { "X-IAMCEO-Contract": "1" }] as Record<string, string>[]) {
      const patch = { now: "지금", runnerEnabled: false, cwd: f.isolated.paths.work };
      expect(await json(await f.request(path, "PATCH", { ...patch, name: " 새 이름 " }, headers)))
        .toEqual(JSON.parse(JSON.stringify(f.store.requireProject(f.project.id))));
      expect(write).toHaveBeenCalledTimes(1);
      expect(before.mock.calls).toEqual([[f.project, { ...patch, name: "새 이름" }]]);
      expect(after.mock.calls).toEqual([[f.store.requireProject(f.project.id), { ...patch, name: "새 이름" }]]);
    }
    await json(await f.request(path, "PATCH", { runnerEnabled: true }));
    expect(write).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(2);
    f.store.patchProject(f.project.id, { archived: true });
    const archived = f.store.requireProject(f.project.id);
    const writes = write.mock.calls.length;
    for (const patch of [{ name: "보관 이름" }, { runnerEnabled: true }, { archived: false }]) {
      await json(await f.request(path, "PATCH", patch), 501);
    }
    expect(f.store.requireProject(f.project.id)).toEqual(archived);
    expect(write).toHaveBeenCalledTimes(writes);
    expect(before).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(2);
    expect(f.runner.starts).toBe(0);
    expect(f.runner.stops).toEqual([]);
  } finally { before.mockRestore(); after.mockRestore(); write.mockRestore(); }
});

test("구형 v1 PATCH는 같은 프로젝트 경합과 사전 hook 거부를 저장 전에 처리하고 잠금을 해제한다", async () => {
  const f = await fixture();
  const api: OrchestratorApi = f.orch;
  api.patchProject = undefined;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const before = spyOn(f.orch, "beforeProjectPatch").mockImplementation(async () => { entered(); await gate; throw new ApiError(409, "변경 거부"); });
  const after = spyOn(f.orch, "onProjectPatched").mockImplementation(async () => {});
  const write = spyOn(f.store, "patchProject");
  const path = `/api/projects/${f.project.id}`;
  const changing = f.request(path, "PATCH", { now: "저장 금지" });
  try {
    await started;
    await json(await f.request(path, "PATCH", { name: "경합" }), 409);
    release();
    await json(await changing, 409);
    expect(f.store.requireProject(f.project.id)).toEqual(f.project);
    expect(write).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    before.mockImplementation(async () => {});
    await json(await f.request(path, "PATCH", { now: "재시도 성공" }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  } finally { release(); await changing; before.mockRestore(); after.mockRestore(); write.mockRestore(); }
});

test("엄격 PATCH/HQ 검증과 보관 종료 실패는 전 필드를 미반영한다", async () => {
  const f = await fixture();
  const path = `/api/projects/${f.project.id}`;
  for (const body of [{ name: "" }, { name: null }, { name: "줄\n바꿈" }, { extra: true }, { archived: true, runnerEnabled: true }]) {
    await json(await f.request(path, "PATCH", body), 400);
  }
  await json(await f.request("/api/projects/hq", "PATCH", { archived: true }), 400);
  await json(await f.request("/api/projects/missing", "PATCH", {}), 404);
  expect(f.runner.stops).toEqual([]);
  f.runner.checkError = new ApiError(409, "초안 보존");
  await json(await f.request(path, "PATCH", { archived: true, name: "반영 금지" }), 409);
  expect(f.runner.stops).toEqual([]);
  f.runner.checkError = null;
  f.runner.stopError = new Error("가짜 종료 ACK 유실");
  await json(await f.request(path, "PATCH", { archived: true, name: "반영 금지" }), 503);
  expect(f.store.requireProject(f.project.id)).toEqual(f.project);
  expect(f.store.requireMember(f.member.id)).toMatchObject({ sessionId: f.member.sessionId, paneId: f.member.paneId, status: "idle" });
  expect(f.store.listPendingLifecycleJournals()).toEqual([expect.objectContaining({ memberId: f.member.id, phase: "unknown", intent: "archive" })]);
});

test("보관 장벽은 HTTP 경합을 거부하고 보관 읽기/꺼내기는 세션을 새로 띄우지 않는다", async () => {
  const f = await fixture();
  let release!: () => void;
  f.runner.stopGate = new Promise<void>(resolve => { release = resolve; });
  const changing = f.request(`/api/projects/${f.project.id}`, "PATCH", { archived: true, runnerEnabled: false });
  try {
    for (let i = 0; i < 100 && f.runner.stops.length === 0; i++) await Bun.sleep(5);
    expect(f.runner.stops).toEqual([f.member.id]);
    await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { name: "경합" }), 409);
    await json(await f.request(`/api/projects/${f.project.id}/messages`, "POST", { text: "경합 입력", targetMemberId: f.member.id }), 409);
  } finally { release(); }
  await json(await changing);
  expect(f.store.requireMember(f.member.id)).toMatchObject({ status: "asleep", paneId: null, sessionId: f.member.sessionId });
  expect(f.store.requireMember(f.manual.id).status).toBe("idle");
  const message = f.store.createMessage({ projectId: f.project.id, body: "보관 기록", kind: "알림" });
  const seq = f.bus.seq;
  for (const path of ["state", "messages/page"]) await json(await f.request(`/api/projects/${f.project.id}/${path}`), 404);
  const archived = await json(await f.request(`/api/projects/${f.project.id}/archive/state`));
  expect(archived).toEqual(JSON.parse(JSON.stringify(f.store.archiveState(f.project.id))));
  expect(await json(await f.request(`/api/projects/${f.project.id}/archive/messages/page`)))
    .toEqual(JSON.parse(JSON.stringify(f.store.listArchiveMessagePage(f.project.id))));
  expect(await json(await f.request(`/api/projects/${f.project.id}/messages`))).toEqual([message]);
  await json(await f.request(`/api/projects/${f.project.id}/conductor/start`, "POST"), 409);
  expect(f.bus.seq).toBe(seq);
  await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { runnerEnabled: true }), 409);
  await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { archived: true }));
  expect(f.runner.stops).toEqual([f.member.id]);
  await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { archived: false }));
  await json(await f.request(`/api/projects/${f.project.id}/archive/state`), 404);
  expect(f.runner.starts).toBe(0);
});

test("실제 v2 포트가 모두 연결될 때만 operations/delivery/push를 광고한다", async () => {
  const f = await fixture();
  const expected = { contractVersion: 2, capabilities: { paging: true, archive: true, realtime: true, delivery: true, push: false, operations: true } };
  const seq = f.bus.seq;
  const diagnostics = spyOn(f.orch, "runtimeInfo");
  try {
    expect(await json(await f.request("/api/capabilities"))).toEqual(expected);
    const api: OrchestratorApi = f.orch;
    for (const port of ["operation", "updateSettingsV2", "patchMemberConfigV2", "setTodoDoneV2", "freshMemberSessionV2", "terminalControlV2"] as const) {
      Object.defineProperty(api, port, { value: undefined, configurable: true });
      try { expect(await json(await f.request("/api/capabilities"))).toEqual({ ...expected, capabilities: { ...expected.capabilities, operations: false } }); }
      finally { delete api[port]; }
    }
    f.context.delivery = undefined;
    expect(await json(await f.request("/api/capabilities"))).toMatchObject({ capabilities: { delivery: false, operations: true } });
    await json(await f.request(`/api/members/${f.member.id}/delivery-notices`), 501);
    expect(diagnostics).not.toHaveBeenCalled();
    expect(f.bus.seq).toBe(seq);
    expect(f.runner.starts).toBe(0);
  } finally { diagnostics.mockRestore(); }
  const mounted = await fixture(true);
  expect(await json(await mounted.request("/api/capabilities"))).toMatchObject({ capabilities: { push: true } });
  await json(await mounted.request("/api/push/status"));
});

test("v1 설정/직원/업무/무본문 fresh는 봉투 없는 exact JSON을 유지하고 v2는 CAS를 적용한다", async () => {
  const f = await fixture();
  const settingsRevision = f.store.settingsRevision();
  expect(await json(await f.request("/api/settings", "PUT", { notifyMac: false }))).toEqual(f.store.getSettings());
  expect(await json(await f.request("/api/settings", "PUT", { notifyMac: true }, { ...v2, "If-Match": `"${settingsRevision}"` }), 409))
    .toMatchObject({ code: "REVISION_CONFLICT" });
  expect(await json(await f.request("/api/settings", "PUT", { compactAtPct: 75 }, { ...v2, "If-Match": `"${f.store.settingsRevision()}"` })))
    .toEqual({ settings: f.store.getSettings(), revision: f.store.settingsRevision() });
  const memberPath = `/api/members/${f.member.id}`;
  expect(await json(await f.request(memberPath, "PATCH", {}))).toEqual(f.store.requireMember(f.member.id));
  expect(await json(await f.request(memberPath, "PATCH", {}, { ...v2, "If-Match": `"${f.store.memberRevisions(f.member.id).configRevision}"` })))
    .toEqual({ member: f.store.requireMember(f.member.id), ...f.store.memberRevisions(f.member.id) });
  const todo = f.store.createTodo({ projectId: f.project.id, title: "확인" });
  const todoPath = `/api/todos/${todo.id}/done`;
  const todoRevision = f.store.todoRevision(todo.id);
  expect(await json(await f.request(todoPath, "POST", { done: false }))).toEqual(todo);
  expect(await json(await f.request(todoPath, "POST", { done: true }, { ...v2, "If-Match": `"${todoRevision}"` })))
    .toEqual({ todo: f.store.requireTodo(todo.id), revision: f.store.todoRevision(todo.id) });
  await json(await f.request(todoPath, "POST", { done: true }, { ...v2, "If-Match": `"${todoRevision}"` }), 409);
  const fresh = await json(await f.request(memberPath + "/fresh-session", "POST"));
  expect(fresh).toEqual(f.store.requireMember(f.member.id));
  expect(f.store.requireMember(f.member.id).sessionId).not.toBe(f.member.sessionId);
});

test("v2 fresh/terminal receipt는 재요청 전에 조회하고 unknown 입력은 재생하지 않는다", async () => {
  const f = await fixture();
  const path = `/api/members/${f.member.id}`;
  const body = { operationId: randomUUID(), expectedSessionGeneration: f.store.memberRevisions(f.member.id).sessionGeneration };
  const first = await json<OperationReceipt>(await f.request(path + "/fresh-session", "POST", body, v2));
  expect(first.status).toBe("applied");
  const starts = f.runner.starts;
  expect(await json(await f.request(path + "/fresh-session", "POST", body, v2))).toEqual(first);
  expect(await json(await f.request(`/api/operations/${body.operationId}`))).toEqual(first);
  expect(f.runner.starts).toBe(starts);
  const claim = { operationId: randomUUID(), expectedSessionGeneration: f.store.memberRevisions(f.member.id).sessionGeneration, claimId: "fixture-claim", action: "claim" };
  const unknown = await json<OperationReceipt>(await f.request(path + "/terminal/control", "POST", claim, v2));
  expect(unknown).toMatchObject({ status: "unknown", code: "TERMINAL_UNKNOWN" });
  expect(await json(await f.request(path + "/terminal/control", "POST", claim, v2))).toEqual(unknown);
  expect(await json(await f.request(`/api/operations/${claim.operationId}`))).toEqual(unknown);
  expect(f.runner.terminalCalls).toBe(1);
  await json(await f.request(`/api/operations/${randomUUID()}`), 404);
});

test("manual batch는 HTTP 재조회·같은 ACK를 보존하고 다른 직원/보관 중 소비를 거부한다", async () => {
  const f = await fixture();
  const headers = { ...v2, Authorization: `Bearer ${f.store.getMemberToken(f.manual.id)}` };
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.manual.id, kind: "instruction", text: "직접 수신" });
  const batch = await json<ManualInboxBatch>(await f.request("/agent/inbox/wait", "POST", { timeoutMs: 1 }, headers));
  expect(await json(await f.request("/agent/inbox/wait", "POST", { timeoutMs: 1 }, headers))).toEqual(batch);
  expect(f.store.requireDelivery(delivery.id).status).toBe("queued");
  const other = f.store.createMember({ projectId: f.project.id, handle: "other", name: "다른 직원", kind: "worker", origin: "manual" });
  await json(await f.request("/agent/inbox/ack", "POST", { batchId: batch.id }, { ...v2, Authorization: `Bearer ${f.store.getMemberToken(other.id)}` }), 404);
  for (let i = 0; i < 2; i++) expect(await json(await f.request("/agent/inbox/ack", "POST", { batchId: batch.id }, headers)))
    .toEqual({ batchId: batch.id, acknowledged: true });
  expect(f.store.requireDelivery(delivery.id).status).toBe("delivered");
  const pending = f.store.enqueue({ projectId: f.project.id, memberId: f.manual.id, kind: "instruction", text: "보관 중 수신 금지" });
  f.store.patchMember(f.manual.id, { status: "idle" });
  await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { archived: true }));
  await json(await f.request("/agent/inbox/wait", "POST", { timeoutMs: 1 }, headers), 404);
  await json(await f.request("/agent/inbox/ack", "POST", { batchId: batch.id }, headers), 404);
  expect(f.store.requireDelivery(pending.id).status).not.toBe("delivered");
  expect(f.runner.starts).toBe(0);
  expect(f.runner.sends).toBe(0);
});

test("연결된 recovery는 202/멱등 결과와 200 중지를 보존하고 진단은 readiness와 구분한다", async () => {
  const f = await fixture();
  // Recheck now immediately schedules never-written input; keep the receiver busy to exercise cancellation.
  f.runner.isBusy = () => true;
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "복구 대상" });
  const recovery = f.store.getDeliveryRecovery(delivery.id)!;
  f.store.updateDeliveryRecovery(delivery.id, recovery.version, { phase: "needs_owner", reason: "log_missing" });
  const path = `/api/deliveries/${delivery.id}/recovery`;
  const body = { operationId: randomUUID(), expectedVersion: f.store.getDeliveryRecovery(delivery.id)!.version, action: "recheck" };
  const scheduled = await json(await f.request(path, "POST", body), 202);
  expect(await json(await f.request(path, "POST", body), 202)).toEqual(scheduled);
  const current = f.store.getDeliveryRecovery(delivery.id)!;
  const needsOwner = f.store.updateDeliveryRecovery(delivery.id, current.version, { phase: "needs_owner", reason: "log_missing" });
  expect(await json(await f.request(path, "POST", { operationId: randomUUID(), expectedVersion: needsOwner.version, action: "stop_retry" })))
    .toMatchObject({ outcome: "stopped", deliveryId: delivery.id });
  expect(f.store.requireDelivery(delivery.id).status).toBe("failed");
  const runtime = await json(await f.request("/api/runtime"));
  expect(runtime).toMatchObject({ backend: "core", core: { available: true } });
  expect(await json(await f.request("/api/readiness"))).toEqual({ ok: true, version: VERSION,
    daemon: { ready: true, buildId: "fixture-build", version: VERSION }, schema: { version: MIGRATIONS.length, supportedVersion: MIGRATIONS.length },
    core: (runtime as { core: unknown }).core, hosts: [expect.objectContaining({ host: "127.0.0.1", state: "bound" })] });
  expect(await json(await f.request("/api/health"))).toEqual({ ok: true, version: VERSION });
  expect(f.runner.starts).toBe(0);
  expect(f.runner.sends).toBe(0);
});

test("v1 Message.delivery 5값·이전 목록/state의 exact JSON과 사용자/agent 인증 경계를 유지한다", async () => {
  const f = await fixture();
  for (const delivery of ["queued", "delivering", "delivered", "failed", "held"] as const) {
    const message = f.store.createMessage({ projectId: f.project.id, kind: "나", body: delivery, mine: true, delivery });
    expect(await json(await f.request(`/api/messages/${message.id}`))).toEqual(message);
    if (delivery !== "failed") expect(await json(await f.request(`/api/projects/${f.project.id}/messages`, "POST", { id: message.id, text: "본문 덮기 금지" })))
      .toEqual(message);
  }
  expect(await json(await f.request(`/api/projects/${f.project.id}/messages`))).toEqual(f.store.listMessages(f.project.id));
  expect(await json(await f.request(`/api/projects/${f.project.id}/state`)))
    .toEqual({ ...f.store.projectState(f.project.id), deliveryNotices: f.orch.deliveryRecovery.notices(f.project.id) });
  const paths = ["/api/capabilities", "/api/runtime", "/api/readiness", "/api/sync", `/api/projects/${f.project.id}/archive/state`, `/api/operations/${randomUUID()}`];
  for (const path of paths) for (const authorization of ["", "Bearer wrong", `Bearer ${f.store.getMemberToken(f.manual.id)}`]) {
    expect(await json(await f.request(path + `?t=${f.config.accessCode}`, "GET", undefined, { Authorization: authorization }), 401))
      .toEqual({ error: "인증이 필요합니다" });
  }
  await json(await f.request("/agent/inbox/ack", "POST", { batchId: "batch" }), 401);
  await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { name: "거부" }, { Origin: "http://evil.example" }), 403);
  await json(await f.request("/ws?v=2&t=legacy"), 400);
  await json(await f.request("/ws?v=2", "GET", undefined, { Authorization: "" }), 401);
});
