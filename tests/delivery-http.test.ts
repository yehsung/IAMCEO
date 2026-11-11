import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { DeliveryRecovery } from "../server/delivery-recovery.ts";
import { startServer, type RunningServer, type ServerContext } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Store } from "../server/store.ts";
import type { DeliveryNoticePage } from "../shared/types.ts";

const home = mkdtempSync("/private/tmp/iamceo-delivery-http-");
const code = "delivery-http-fixture";
const auth = { Authorization: `Bearer ${code}` };
let store: Store;
let bus: Bus;
let recovery: DeliveryRecovery;
let server: RunningServer;
let ctx: ServerContext;
let base: string;
let projectId: string;
let memberId: string;
let deliveryId: string;
const runnerCalls: string[] = [];
const get = (path: string, headers = auth) => fetch(base + path, { headers });
const post = (id: string, body: unknown, headers = auth) => fetch(`${base}/api/deliveries/${id}/recovery`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: code, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  bus = new Bus();
  store = new Store(openDb(config.dbPath), bus);
  projectId = store.createProject({ name: "전달 HTTP", cwd: home }).id;
  memberId = store.createMember({ projectId, handle: "worker", name: "직원", kind: "worker", sessionId: "fixture-session", paneId: "fixture-terminal" }).id;
  const other = store.createMember({ projectId, handle: "other", name: "다른 직원", kind: "worker" });
  for (let i = 0; i < 205; i++) {
    const d = store.enqueue({ projectId, memberId, kind: "instruction", text: `내부 봉투 secret-canary ${i}` });
    if (i === 0) deliveryId = d.id;
  }
  store.enqueue({ projectId, memberId: other.id, kind: "instruction", text: "다른 직원 봉투" });
  recovery = new DeliveryRecovery({ store, runner: () => { runnerCalls.push("runner"); throw new Error("HTTP read must not observe runner"); } });
  const orch = {} as unknown as OrchestratorApi;
  ctx = { config, store, bus, orch, delivery: recovery };
  server = await startServer(ctx);
  while (server.port === 7878) { await server.stop(); server = await startServer(ctx); }
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => { await recovery?.shutdown(); await server?.stop(); store?.db.close(); rmSync(home, { recursive: true }); });

test("notice/state/sync GET은 전체 DB 집계와 keyset을 반환하고 입력·이벤트·DB 쓰기는 0회다", async () => {
  const path = `/api/members/${memberId}/delivery-notices`;
  const seq = bus.seq;
  const changes = store.db.query("SELECT total_changes() AS n").get();
  const firstResponse = await get(`${path}?limit=100`);
  expect(firstResponse.status).toBe(200);
  expect(firstResponse.headers.get("cache-control")).toBe("no-store");
  const first = await firstResponse.json() as DeliveryNoticePage;
  expect(first.summary.undeliveredCount).toBe(205);
  expect(first.items).toHaveLength(100);
  const second = await (await get(`${path}?limit=100&before=${first.nextBefore}`)).json() as DeliveryNoticePage;
  const third = await (await get(`${path}?limit=100&before=${second.nextBefore}`)).json() as DeliveryNoticePage;
  expect(second.items).toHaveLength(100);
  expect(third.items).toHaveLength(5);
  expect(third.nextBefore).toBeNull();
  const items = [...first.items, ...second.items, ...third.items];
  expect(new Set(items.map(item => item.id)).size).toBe(205);
  expect(items.every(item => item.memberId === memberId)).toBe(true);
  expect(JSON.stringify(items)).not.toContain("secret-canary");
  const state = await (await get(`/api/projects/${projectId}/state`)).json();
  expect(state.deliveryNotices.version).toBe(2);
  expect(state.deliveryNotices.members[0]).toMatchObject({ memberId, undeliveredCount: 205 });
  expect(state.deliveryNotices.members).toHaveLength(2);
  const sync = await (await get(`/api/sync?projectId=${projectId}`)).json();
  expect(sync.state.deliveryNotices).toEqual(state.deliveryNotices);
  expect(bus.seq).toBe(seq);
  expect(store.db.query("SELECT total_changes() AS n").get()).toEqual(changes);
  expect(runnerCalls).toEqual([]);
});

test("notice query는 strict limit/cursor/대상·인증을 검사한다", async () => {
  const path = `/api/members/${memberId}/delivery-notices`;
  for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=1e2", "limit=", "limit=1&limit=2", "extra=1", "before=", "before=%2F", "before=not_a_cursor", "before=" + "x".repeat(4097)]) {
    expect([query.slice(0, 50), (await get(`${path}?${query}`)).status]).toEqual([query.slice(0, 50), 400]);
  }
  const wrongMember = Buffer.from(JSON.stringify({ v: 1, memberId: "other", createdAt: "2026", id: "id" })).toString("base64url");
  expect((await get(`${path}?before=${wrongMember}`)).status).toBe(400);
  expect((await get("/api/members/missing/delivery-notices")).status).toBe(404);
  for (const headers of [{ Authorization: "Bearer wrong" }, { Authorization: `Bearer ${store.getMemberToken(memberId)}` }]) {
    const response = await get(path, headers);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await post(deliveryId, { operationId: randomUUID(), expectedVersion: 1, action: "recheck" }, headers)).status).toBe(401);
  }
  expect((await fetch(base + path + `?t=${code}`)).status).toBe(401);
});

test("recovery는 엄격 UUID/version/action/중복 위험 동의를 요구한다", async () => {
  const valid = { operationId: randomUUID(), expectedVersion: store.getDeliveryRecovery(deliveryId)!.version, action: "recheck" };
  const seq = bus.seq;
  for (const body of [
    {}, { ...valid, operationId: "bad" }, { ...valid, expectedVersion: 0 }, { ...valid, expectedVersion: -1 },
    { ...valid, expectedVersion: "1" }, { ...valid, expectedVersion: 1.1 }, { ...valid, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, action: "delivered" }, { ...valid, action: "retry_with_risk" }, { ...valid, action: "retry_with_risk", acceptDuplicateRisk: false },
    { ...valid, acceptDuplicateRisk: true }, { ...valid, action: "stop_retry", acceptDuplicateRisk: true }, { ...valid, extra: true },
  ]) expect((await post(deliveryId, body)).status).toBe(400);
  const invalidJson = await fetch(`${base}/api/deliveries/${deliveryId}/recovery`, { method: "POST", headers: auth, body: "{" });
  expect(invalidJson.status).toBe(400);
  expect(bus.seq).toBe(seq);
  expect((await post("missing", valid)).status).toBe(404);
  expect((await post(deliveryId, { ...valid, expectedVersion: valid.expectedVersion + 1 })).status).toBe(409);
  expect(runnerCalls).toEqual([]);
});

test("recheck는 202 예약이며 같은 operation 재조회는 CAS보다 먼저이고 충돌은 409다", async () => {
  store.updateDeliveryRecovery(deliveryId, store.getDeliveryRecovery(deliveryId)!.version, { phase: "needs_owner", reason: "log_missing" });
  const body = { operationId: randomUUID(), expectedVersion: store.getDeliveryRecovery(deliveryId)!.version, action: "recheck" };
  const firstResponse = await post(deliveryId, body);
  expect(firstResponse.status).toBe(202);
  const first = await firstResponse.json();
  expect(first).toMatchObject({ operationId: body.operationId, deliveryId, outcome: "check_scheduled", committedVersion: body.expectedVersion + 1 });
  const second = await post(deliveryId, body);
  expect(second.status).toBe(202);
  expect(await second.json()).toEqual(first);
  expect(store.getDeliveryRecovery(deliveryId)!.version).toBe(first.committedVersion);
  expect((await post(deliveryId, { ...body, expectedVersion: first.committedVersion })).status).toBe(409);
  expect((await post(deliveryId, { ...body, operationId: randomUUID() })).status).toBe(409);
  const another = store.enqueue({ projectId, memberId, kind: "instruction", text: "다른 작업" });
  expect((await post(another.id, { ...body, expectedVersion: store.getDeliveryRecovery(another.id)!.version })).status).toBe(409);
  expect(store.requireDelivery(deliveryId).status).not.toBe("delivered");
  expect(runnerCalls).toEqual([]);
});

test("stop은 수신 판정 없이 200; 부적절한 위험 재전송은 409다", async () => {
  const d = store.enqueue({ projectId, memberId, kind: "instruction", text: "결과 불명" });
  const r = store.getDeliveryRecovery(d.id)!;
  const needsOwner = store.updateDeliveryRecovery(d.id, r.version, { phase: "needs_owner", reason: "log_missing" });
  expect((await post(d.id, { operationId: randomUUID(), expectedVersion: needsOwner.version, action: "retry_with_risk", acceptDuplicateRisk: true })).status).toBe(409);
  const body = { operationId: randomUUID(), expectedVersion: needsOwner.version, action: "stop_retry" };
  const response = await post(d.id, body);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({ outcome: "stopped", deliveryId: d.id });
  expect(await (await post(d.id, body)).json()).toEqual(result);
  expect(store.requireDelivery(d.id).status).toBe("failed");
  expect(store.getDeliveryRecovery(d.id)!.phase).toBe("stopped");
});

test("미지원 포트는 501, 보관·없는 대상은 404이며 GET/POST가 실행기를 깨우지 않는다", async () => {
  ctx.delivery = undefined;
  expect((await get(`/api/members/${memberId}/delivery-notices`)).status).toBe(501);
  expect((await post(deliveryId, { operationId: randomUUID(), expectedVersion: store.getDeliveryRecovery(deliveryId)!.version, action: "recheck" })).status).toBe(501);
  expect(await (await get("/api/capabilities")).json()).toMatchObject({ capabilities: { delivery: false, operations: false } });
  ctx.delivery = recovery;
  store.patchProject(projectId, { archived: true });
  expect((await get(`/api/members/${memberId}/delivery-notices`)).status).toBe(404);
  expect((await post(deliveryId, { operationId: randomUUID(), expectedVersion: store.getDeliveryRecovery(deliveryId)!.version, action: "recheck" })).status).toBe(404);
  expect(runnerCalls).toEqual([]);
});

test("unassigned recovery and additive notices preserve v1 message shape and enforce reviewed operations", async () => {
  const project = store.createProject({ name: "미배정 HTTP", cwd: home });
  const message = store.createMessage({ projectId: project.id, mine: true, kind: "나", body: "옛 실패", delivery: "failed" });
  const path = `/api/messages/${message.id}/recovery`;
  const request = (body: unknown, headers = auth) => fetch(base + path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const body = { operationId: randomUUID(), expectedVersion: 0, action: "send_to_conductor" };
  const notices = await (await get(`/api/projects/${project.id}/delivery-notices`)).json();
  expect(notices).toMatchObject({ version: 2, unassigned: { needsOwnerCount: 1 }, unassignedItems: [{ messageId: message.id, allowedActions: ["send_to_conductor", "dismiss"] }] });
  expect((await request(body)).status).toBe(409);
  expect((await request({ ...body, expectedVersion: "0" })).status).toBe(400);
  expect((await request({ ...body, expectedVersion: -1 })).status).toBe(400);
  expect((await request({ ...body, extra: true })).status).toBe(400);
  expect((await request(body, { Authorization: "Bearer wrong" })).status).toBe(401);
  expect((await request(body, { ...auth, "X-IAMCEO-Contract": "3" } as typeof auth)).status).toBe(400);
  const dismiss = { ...body, action: "dismiss" };
  const response = await request(dismiss, { ...auth, "X-IAMCEO-Contract": "2" } as typeof auth);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(await (await request(dismiss)).json()).toEqual(result);
  const legacy = await (await get(`/api/messages/${message.id}`)).json();
  expect(legacy).toMatchObject({ id: message.id, body: "옛 실패", delivery: "held", deliveryDisposition: "dismissed" });
  expect(["queued", "held", "delivering", "delivered", "failed"]).toContain(legacy.delivery);
  expect(await (await get(`/api/projects/${project.id}/delivery-notices`)).json()).toMatchObject({ unassigned: { needsOwnerCount: 0 }, unassignedItems: [] });
  store.patchProject(project.id, { archived: true });
  expect((await request(dismiss)).status).toBe(409);
  expect(runnerCalls).toEqual([]);
});
