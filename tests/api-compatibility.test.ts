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
      .toEqual({ error: "프로젝트 변경을 지원하지 않습니다", code: "project_update_unsupported" });
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
  const before = spyOn(f.orch, "beforeProjectPatch").mockImplementation(async () => { entered(); await gate; throw new ApiError(409, "변경 거부", "project_busy"); });
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
  f.runner.checkError = new ApiError(409, "초안 보존", "close_draft_present");
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
    // G: 상태 코드와 문장은 그대로 두고 코드만 더했다(묶음 사이 약속 2).
    expect(await json(await f.request(path + `?t=${f.config.accessCode}`, "GET", undefined, { Authorization: authorization }), 401))
      .toEqual({ error: "인증이 필요합니다", code: "unauthorized" });
  }
  await json(await f.request("/agent/inbox/ack", "POST", { batchId: "batch" }), 401);
  await json(await f.request(`/api/projects/${f.project.id}`, "PATCH", { name: "거부" }, { Origin: "http://evil.example" }), 403);
  await json(await f.request("/ws?v=2&t=legacy"), 400);
  await json(await f.request("/ws?v=2", "GET", undefined, { Authorization: "" }), 401);
});

// n-models-1: 이미 나간 0.2.x 네이티브 앱은 고칠 수 없다. 그 앱의 디코더가 꼭 필요로 하는 필드를 실제 응답과 이벤트에서 고정한다.
// 필드를 빼거나 타입을 바꾸면(정수 → 실수·null·문자열) 옛 앱은 스냅샷 전체를 버리고 '연결 중'에 머문다. 새 필드를 더하는 것은 괜찮다.
test("native 0.2.x 필수 필드: /api/sync, /api/bootstrap 과 member·message·decision 이벤트", async () => {
  const f = await fixture();
  const events: unknown[] = [];
  f.bus.subscribe(event => events.push(JSON.parse(JSON.stringify(event))));
  // 화면에 보이는 상태를 고루 만든다: 실행 중인 턴, 수명주기 기록, 압축 기록, 관측 오류, 보류된 전달, 결재, 할 일.
  await json(await f.request(`/api/projects/${f.project.id}/messages`, "POST", { text: "지시", targetMemberId: f.member.id }));
  const at = new Date().toISOString(), generation = f.store.memberRevisions(f.member.id).sessionGeneration;
  f.store.saveLifecycleJournal({ operationId: randomUUID(), memberId: f.member.id, projectId: f.project.id, intent: "start", phase: "confirmed",
    identity: { terminalId: "fake:worker", sessionId: f.member.sessionId, sessionGeneration: generation, process: null }, runId: null, deliveryIds: [], baseline: null, reason: null, exitCode: null, createdAt: at, updatedAt: at });
  const context = f.store.ensureContextState(f.member.id);
  f.store.saveContextState({ ...context, compaction: { id: randomUUID(), trigger: "manual", phase: "failed", reason: "draft", requestedAt: at, startedAt: null, finishedAt: at },
    measurement: { quality: "exact", tokens: 1200, window: 200000, pct: 1, turn: 1, model: "claude-sonnet", sessionId: f.member.sessionId!, sessionGeneration: generation, terminalId: "fake:worker", fresh: true, measuredAt: at } as never });
  f.store.patchMember(f.member.id, { statusObservation: { source: "core", observedAt: at, freshness: "stale", ownership: "unknown", consecutiveFailures: 2, error: { code: "timeout", note: "다시 관측 중" } } });
  const held = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "[지시] 보류될 일" });
  f.store.markHeld(held.id, "blocked");
  f.store.createDecision({ projectId: f.project.id, memberId: f.member.id, who: "직원", title: "고를 것", options: [{ k: "a", label: "가" }, { k: "b", label: "나", desc: "설명" }] });
  f.store.createTodo({ projectId: f.project.id, memberId: f.member.id, title: "할 일" });

  const int = (value: unknown) => typeof value === "number" && Number.isInteger(value);
  const str = (value: unknown) => typeof value === "string";
  const problems: string[] = [];
  const need = (path: string, ok: boolean) => { if (!ok) problems.push(path); };
  type Any = Record<string, any>;
  const checkMember = (m: Any, where: string) => {
    need(`${where}.id`, str(m.id) && str(m.projectId) && str(m.handle) && str(m.name) && str(m.status));
    need(`${where}.subagents`, int(m.subagents)); need(`${where}.queuedCount`, int(m.queuedCount));
    need(`${where}.contextWindow`, m.contextWindow === null || int(m.contextWindow));
    need(`${where}.contextPct`, m.contextPct === null || typeof m.contextPct === "number");
    if (m.statusObservation) { need(`${where}.statusObservation.consecutiveFailures`, m.statusObservation.consecutiveFailures == null || int(m.statusObservation.consecutiveFailures)); if (m.statusObservation.error) need(`${where}.statusObservation.error.code`, str(m.statusObservation.error.code)); }
    if (m.subagentState) need(`${where}.subagentState`, (m.subagentState.count == null || int(m.subagentState.count)) && (m.subagentState.sessionGeneration == null || int(m.subagentState.sessionGeneration)));
    if (m.executionState) need(`${where}.executionState`, str(m.executionState.runId) && (m.executionState.turn == null || int(m.executionState.turn)) && (m.executionState.exitCode == null || int(m.executionState.exitCode)) && Array.isArray(m.executionState.deliveryIds) && m.executionState.deliveryIds.every(str));
    if (m.lifecycleState) need(`${where}.lifecycleState`, str(m.lifecycleState.operationId) && int(m.lifecycleState.sessionGeneration) && (m.lifecycleState.exitCode == null || int(m.lifecycleState.exitCode)));
    if (m.contextState?.measurement) { const me = m.contextState.measurement; need(`${where}.contextState.measurement`, (me.tokens == null || int(me.tokens)) && (me.window == null || int(me.window)) && (me.turn == null || int(me.turn)) && int(me.sessionGeneration)); }
    if (m.contextState?.compaction) need(`${where}.contextState.compaction.id`, str(m.contextState.compaction.id) && str(m.contextState.compaction.phase));
  };
  const checkMessage = (m: Any, where: string) => {
    need(`${where}.id`, str(m.id) && str(m.projectId) && str(m.kind) && str(m.body) && str(m.at));
    need(`${where}.deliveryRevision`, m.deliveryRevision == null || int(m.deliveryRevision));
    need(`${where}.attachments`, Array.isArray(m.attachments) && m.attachments.every((a: Any) => str(a.id) && int(a.size)));
    need(`${where}.fileIds`, (m.fileIds ?? []).every(str));
    for (const info of m.deliveryInfo ?? []) need(`${where}.deliveryInfo`, str(info.deliveryId) && str(info.memberId) && str(info.waitReason) && str(info.waitingSince));
  };
  const checkDecision = (d: Any, where: string) => {
    need(`${where}.id`, str(d.id) && str(d.projectId) && str(d.title) && str(d.status));
    need(`${where}.options`, Array.isArray(d.options) && d.options.every((o: Any) => str(o.k) && str(o.label) && (o.desc == null || str(o.desc))));
    need(`${where}.images`, d.images == null || Array.isArray(d.images));
  };

  const sync = await json<Any>(await f.request(`/api/sync?projectId=${f.project.id}`));
  need("sync.protocol", sync.protocol === 2 && sync.projectStatus === "ok" && int(sync.cursor.seq) && str(sync.cursor.epoch));
  need("sync.bootstrap.projects", Array.isArray(sync.bootstrap.projects) && sync.bootstrap.projects.length > 0);
  for (const p of sync.bootstrap.projects) for (const key of ["decisionCount", "todoCount", "inboxCount", "workingCount", "blockedCount", "errorCount", "memberCount", "needsCount"]) need(`summary.${key}`, int(p[key]));
  const settings = sync.bootstrap.settings;
  need("settings", int(settings.maxConcurrentTurns) && int(settings.compactAtPct) && int(settings.maxAwakeWorkers) && int(settings.contextWindowDefault) && Object.values(settings.contextWindows).every(int) && typeof settings.boardTidyHours === "number");
  need("apiOutage", sync.apiOutage == null || (str(sync.apiOutage.since) && Array.isArray(sync.apiOutage.affectedMemberIds)));
  need("revisions", int(sync.revisions.settings) && Object.values<Any>(sync.revisions.members).every(m => int(m.configRevision) && int(m.sessionGeneration)) && Object.values(sync.revisions.todos).every(int));
  const state = sync.state as Any, notices = state.deliveryNotices as Any;
  need("notices.version", int(notices?.version) && Array.isArray(notices?.members));
  need("notices.unassigned", notices && typeof notices.unassigned === "object" && int(notices.unassigned.needsOwnerCount));
  for (const m of notices.members) {
    need("notices.members.memberId", str(m.memberId));
    for (const key of ["undeliveredCount", "unknownCount", "deliveringCount", "checkingCount", "needsOwnerCount", "waitingBehindCount"]) need(`notices.members.${key}`, int(m[key]));
    need("notices.members.oldestAt", m.oldestAt === null || str(m.oldestAt));
    need("notices.members.reasons", Array.isArray(m.reasons) && m.reasons.every((r: Any) => str(r.code) && int(r.count) && str(r.note)));
    for (const w of m.waitReasons ?? []) need("notices.members.waitReasons", str(w.waitReason) && str(w.waitingSince) && int(w.count));
    if (m.runLimit) need("notices.members.runLimit", int(m.runLimit.used) && int(m.runLimit.limit));
  }
  for (const u of notices.unassignedItems ?? []) need("notices.unassignedItems", str(u.id) && str(u.messageId) && str(u.projectId) && str(u.memberId) && int(u.version) && str(u.preview) && str(u.createdAt) && Array.isArray(u.allowedActions));
  for (const r of notices.reportNotices ?? []) need("notices.reportNotices", str(r.kind) && str(r.runId) && str(r.memberId) && str(r.messageId) && str(r.createdAt) && str(r.title));
  for (const [index, m] of state.members.entries()) checkMember(m, `state.members[${index}]`);
  for (const [index, m] of state.messages.entries()) checkMessage(m, `state.messages[${index}]`);
  for (const [index, d] of state.decisions.entries()) checkDecision(d, `state.decisions[${index}]`);
  for (const t of state.todos) need("state.todos", str(t.id) && Array.isArray(t.completionFileIds) && t.completionFileIds.every(str));
  for (const w of state.work) need("state.work", str(w.id) && int(w.order));
  for (const file of state.files) need("state.files", str(file.id) && int(file.order) && file.attachments.every((a: Any) => str(a.id) && int(a.size)));

  // 만든 상태가 실제로 응답에 실렸는지: 비어 있어서 통과한 것이 아니어야 한다.
  const worker = state.members.find((m: Any) => m.id === f.member.id);
  expect(worker).toMatchObject({ executionState: { runId: expect.any(String) }, lifecycleState: { operationId: expect.any(String) },
    contextState: { compaction: { id: expect.any(String) }, measurement: { tokens: 1200, window: 200000 } }, statusObservation: { consecutiveFailures: 2, error: { code: "timeout" } } });
  expect(notices.members.find((m: Any) => m.memberId === f.member.id)).toMatchObject({ undeliveredCount: 1, waitReason: "approval", waitReasons: [{ waitReason: "approval", count: 1 }] });
  expect(state.decisions).toHaveLength(1); expect(state.todos).toHaveLength(1);
  expect(state.messages.some((m: Any) => (m.deliveryInfo ?? []).length === 0 || m.deliveryInfo.every((info: Any) => str(info.deliveryId)))).toBe(true);

  const bootstrap = await json<Any>(await f.request("/api/bootstrap"));
  need("bootstrap.projects", Array.isArray(bootstrap.projects) && str(bootstrap.version) && typeof bootstrap.settings === "object" && typeof bootstrap.herdr === "object" && Array.isArray(bootstrap.urls));
  need("bootstrap.runtime", bootstrap.runtime == null || (typeof bootstrap.runtime.core.installed === "boolean" && typeof bootstrap.runtime.core.available === "boolean"));

  const typed = (type: string) => (events as Any[]).filter(event => event.type === type);
  expect(typed("member").length).toBeGreaterThan(0); expect(typed("message").length).toBeGreaterThan(0); expect(typed("decision").length).toBeGreaterThan(0);
  for (const event of typed("member")) checkMember(event.member, "event.member");
  for (const event of typed("message")) checkMessage(event.message, "event.message");
  for (const event of typed("decision")) checkDecision(event.decision, "event.decision");
  expect([...new Set(problems)]).toEqual([]);
});
