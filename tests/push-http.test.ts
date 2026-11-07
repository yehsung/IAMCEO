import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { PushEventRecorder } from "../server/push/events.ts";
import { createPushHandler } from "../server/push/routes.ts";
import { PushStore } from "../server/push/store.ts";
import { Store } from "../server/store.ts";
import { DEFAULT_PUSH_BUNDLE_ID, DEFAULT_PUSH_PREFERENCES } from "../shared/push.ts";
import type { PushDevice, PushProviderStatus, PushTestResult } from "../shared/push.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const code = "push-http-fixture-code";
const auth = { Authorization: `Bearer ${code}` };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

async function fixture(options: { legacy?: boolean; unconfigured?: boolean } = {}) {
  const runtime = createIsolatedRuntime();
  const env = { IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: code, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const db = openDb(config.dbPath);
  const bus = new Bus();
  let now = Date.parse("2026-11-07T00:00:00.000Z");
  const providers: PushProviderStatus[] = (["sandbox", "production"] as const).map((environment) => ({ environment,
    bundleId: DEFAULT_PUSH_BUNDLE_ID, state: options.unconfigured ? "unconfigured" : "ready", lastError: null }));
  const push = new PushStore(db, { now: () => now, providers: () => providers });
  const store = new Store(db, bus, new PushEventRecorder(push));
  const calls: string[] = [];
  const orch = new Proxy({}, { get: (_target, key) => () => {
    calls.push(String(key)); throw new Error(`Unexpected orchestrator call: ${String(key)}`);
  } }) as OrchestratorApi;
  let wakes = 0;
  const context = { store: push, providers: () => providers, wake: () => { expect(db.inTransaction).toBe(false); wakes++; } };
  const ctx = { config, store, bus, orch, ...(options.legacy ? {} : { push: context }) };
  let server = await startServer(ctx);
  while (server.port === 7878) { await server.stop(); server = await startServer(ctx); }
  let base = `http://127.0.0.1:${server.port}`;
  cleanup.push(async () => { await server.stop(); db.close(); await runtime.stop(); });
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = auth) => fetch(base + path, {
    method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function device(token = randomUUID().replaceAll("-", ""), enabled = false): Promise<PushDevice> {
    const saved = await read<PushDevice>(request(`/api/push/devices/${randomUUID()}`, "PUT", registration(token)), 201);
    return enabled ? read<PushDevice>(request(`/api/push/devices/${saved.id}`, "PATCH", { expectedRevision: saved.revision, enabled: true })) : saved;
  }
  return { push, store, db, providers, calls, context, request, device, direct: createPushHandler(context),
    base: () => base, wakes: () => wakes, advance: (ms: number) => { now += ms; },
    restart: async () => { await server.stop(); server = await startServer(ctx); while (server.port === 7878) {
      await server.stop(); server = await startServer(ctx);
    } base = `http://127.0.0.1:${server.port}`; },
  };
}

function registration(token = "ABCD", expectedRevision: number | null = null) {
  return { expectedRevision, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: token, authorization: "authorized" };
}
async function read<T = Record<string, unknown>>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json() as Promise<T>;
}

describe("Push HTTP access and status", () => {
  test("all routes require owner Bearer; agent token, cookie and query never authenticate", async () => {
    const f = await fixture();
    const project = f.store.createProject({ name: "인증", cwd: "/fixture" });
    const member = f.store.createMember({ projectId: project.id, handle: "manual", name: "수동", kind: "worker", origin: "manual" });
    const token = f.store.getMemberToken(member.id);
    const id = randomUUID();
    const paths: [string, string, unknown?][] = [["/api/push/status", "GET"], ["/api/push/devices", "GET"],
      [`/api/push/devices/${id}`, "GET"], [`/api/push/devices/${id}`, "PUT", registration()],
      [`/api/push/devices/${id}`, "PATCH", { expectedRevision: 1, enabled: true }], [`/api/push/devices/${id}`, "DELETE"],
      [`/api/push/devices/${id}/test`, "POST", { requestId: randomUUID() }], [`/api/push/events/${id}/target`, "GET"]];
    const credentials: Record<string, string>[] = [{}, { Authorization: `Bearer ${token}` }, { Cookie: `iamceo_files=${code}` }];
    for (const [path, method, body] of paths) for (const headers of credentials) {
      await read(f.request(path, method, body, headers), 401);
    }
    await read(f.request(`/api/push/status?t=${code}`, "GET", undefined, {}), 401);
    await read(f.request(`/api/push/status?t=${code}`), 400);
    await read(f.request("/api/push/status", "GET", undefined, { ...auth, Origin: "https://evil.example" }), 403);
    await read(f.request("/api/push/status", "GET", undefined, { ...auth, Host: "evil.example" }), 403);
    expect(f.calls).toEqual([]);
    expect(f.push.listDevices()).toEqual([]);
  });

  test("unconfigured API remains supported; missing injection is 501 and capability false", async () => {
    const f = await fixture({ unconfigured: true });
    await read(f.request("/api/capabilities")).then((value) => expect(value).toMatchObject({ capabilities: { push: true, operations: false } }));
    const status = await read(f.request("/api/push/status"));
    expect(status).toEqual({ serverId: f.push.serverId, supported: true, providers: f.providers });
    const saved = await f.device();
    await read(f.request(`/api/push/devices/${saved.id}`, "PATCH", { expectedRevision: saved.revision, enabled: true }), 409);
    const old = await fixture({ legacy: true });
    await read(old.request("/api/push/status"), 501);
    expect(await read(old.request("/api/capabilities"))).toMatchObject({ capabilities: { push: false } });
  });

  test("status and devices project public fields and errors never expose credentials", async () => {
    const f = await fixture();
    const secret = "private-key-path-JWT-CANARY";
    Object.assign(f.providers[0], { keyId: secret, teamId: secret, privateKeyPath: secret, jwt: secret });
    const saved = await f.device("a1".repeat(40));
    for (const path of ["/api/push/status", "/api/push/devices", `/api/push/devices/${saved.id}`]) {
      const value = JSON.stringify(await read(f.request(path)));
      for (const forbidden of [secret, "a1".repeat(40), "deviceToken", "registrationGeneration", "keyId", "teamId", "privateKeyPath", "jwt"]) expect(value).not.toContain(forbidden);
    }
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const invalid = await read(f.request(`/api/push/devices/${randomUUID()}`, "PUT", registration(secret)), 400);
      expect(JSON.stringify(invalid)).not.toContain(secret);
      f.db.exec(`CREATE TEMP TRIGGER fail_push BEFORE INSERT ON push_devices BEGIN SELECT RAISE(ABORT,'${secret}'); END`);
      const response = await read(f.request(`/api/push/devices/${randomUUID()}`, "PUT", registration()), 500);
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(logged).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });
});

describe("Push HTTP strict boundary", () => {
  test("strict objects, types, revisions, labels, permissions and variable-length tokens", async () => {
    const f = await fixture();
    const id = randomUUID();
    for (const value of [null, [], {}, { ...registration(), extra: "canary" }, { ...registration(), expectedRevision: undefined },
      { ...registration(), expectedRevision: 0 }, { ...registration(), expectedRevision: 1.5 }, { ...registration(), expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...registration(), platform: "macos" }, { ...registration(), environment: "development" }, { ...registration(), authorization: "denied" },
      { ...registration(), deviceToken: "a" }, { ...registration(), deviceToken: "gg" }, { ...registration(), deviceToken: 1 },
      { ...registration(), deviceToken: "ab".repeat(513) }, { ...registration(), bundleId: "other.app" },
      ...["", "a".repeat(41), "line\nbreak", "a\u200bb"].map((label) => ({ ...registration(), label }))]) {
      await read(f.request(`/api/push/devices/${id}`, "PUT", value), 400);
    }
    expect(f.push.listDevices()).toHaveLength(0);
    for (const length of [2, 4, 64, 128, 1024]) {
      const token = "ab".repeat(length / 2);
      const device = await read<PushDevice>(f.request(`/api/push/devices/${randomUUID()}`, "PUT", { ...registration(token), label: "😀".repeat(40) }), 201);
      expect(device.label).toBe("😀".repeat(40));
      expect(device.enabled).toBe(false);
      expect(device.preferences).toEqual(DEFAULT_PUSH_PREFERENCES);
    }
    const saved = await f.device();
    for (const value of [{}, { expectedRevision: saved.revision }, { expectedRevision: null, enabled: false },
      { expectedRevision: saved.revision, enabled: "true" }, { expectedRevision: saved.revision, enabled: true, extra: 1 },
      { expectedRevision: saved.revision, authorization: "unknown" }, ...[{}, null, [], { unknown: true }, { question: true }, { error: 1 }]
        .map((preferences) => ({ expectedRevision: saved.revision, preferences }))]) {
      await read(f.request(`/api/push/devices/${saved.id}`, "PATCH", value), 400);
    }
    expect(f.push.requireDevice(saved.id).revision).toBe(saved.revision);
    await read(f.request(`/api/push/devices/${randomUUID()}`, "GET"), 404);
    await read(f.request(`/api/push/devices/${randomUUID()}`, "PUT", registration("ab", 1)), 404);
  });

  test("bad IDs, encoded paths, queries, methods, JSON and DELETE headers", async () => {
    const f = await fixture();
    const saved = await f.device();
    for (const id of ["bad", "%ZZ", "%2f", "abc%00", "..%2fescape"]) {
      await read(f.request(`/api/push/devices/${id}`), 400);
      await read(f.request(`/api/push/events/${id}/target`), 400);
    }
    for (const path of ["/api/push/status?extra=1", "/api/push/devices?limit=1", `/api/push/devices/${saved.id}?t=secret`,
      `/api/push/events/${randomUUID()}/target?projectId=other`]) await read(f.request(path), 400);
    await read(f.request("/api/push/unknown"), 404);
    await read(f.request("/api/push/status", "POST", {}), 405);
    await read(f.request(`/api/push/devices/${saved.id}/test`), 405);
    await read(fetch(`${f.base()}/api/push/devices/${saved.id}`, { method: "PATCH", headers: auth, body: "{bad" }), 400);
    for (const header of [undefined, "1", 'W/"1"', '"0"', '"-1"', '"1.5"', '"9007199254740992"', '"1", "2"', "*"]) {
      await read(f.request(`/api/push/devices/${saved.id}`, "DELETE", undefined, { ...auth, ...(header === undefined ? {} : { "If-Match": header }) }), 400);
    }
    await read(f.request(`/api/push/devices/${saved.id}`, "DELETE", {}, { ...auth, "If-Match": `"${saved.revision}"` }), 400);
  });

  test("8KiB includes actual chunked UTF-8 bytes; exact boundary succeeds and reading stops early", async () => {
    const f = await fixture();
    const id = randomUUID();
    const text = JSON.stringify(registration());
    const exact = text + " ".repeat(8192 - Buffer.byteLength(text));
    await read(fetch(`${f.base()}/api/push/devices/${id}`, { method: "PUT", headers: auth, body: exact }), 201);
    await read(fetch(`${f.base()}/api/push/devices/${randomUUID()}`, { method: "PUT", headers: auth, body: exact + " " }), 413);
    let pulls = 0;
    let cancelled = false;
    const chunked = new ReadableStream<Uint8Array>({ pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode("한".repeat(1000)));
      if (pulls === 10) controller.close();
    }, cancel() { cancelled = true; } });
    await read(fetch(`${f.base()}/api/push/devices/${randomUUID()}`, { method: "PUT", headers: auth, body: chunked }), 413);
    // Direct calls also cover dishonest Content-Length, which fetch normalizes on the wire.
    let directPulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { directPulls++; controller.enqueue(new Uint8Array(4096)); }, cancel() { cancelled = true; } });
    const url = new URL(`${f.base()}/api/push/devices/${randomUUID()}`);
    await read(f.direct(new Request(url, { method: "PUT", headers: { "Content-Length": "1" }, body: stream }), url), 413);
    expect(directPulls).toBeLessThanOrEqual(4);
    expect(cancelled).toBe(true);
    const statusURL = new URL(`${f.base()}/api/push/status`);
    await read(f.direct(new Request(statusURL, { headers: { "Content-Length": "8193" } }), statusURL), 413);
    await read(f.direct(new Request(statusURL, { headers: { "Content-Length": "wrong" } }), statusURL), 400);
    const badUTF8 = new Request(url, { method: "PUT", body: new Uint8Array([0xff]) });
    await read(f.direct(badUTF8, url), 400);
    expect(f.push.listDevices()).toHaveLength(1);
  });
});

describe("Push HTTP revision and revocation", () => {
  test("partial merge, OFF preservation, CAS races and token generations", async () => {
    const f = await fixture();
    let saved = await f.device();
    saved = await read<PushDevice>(f.request(`/api/push/devices/${saved.id}`, "PATCH", { expectedRevision: saved.revision, preferences: { error: false } }));
    expect(saved.preferences).toEqual({ ...DEFAULT_PUSH_PREFERENCES, error: false });
    saved = await read<PushDevice>(f.request(`/api/push/devices/${saved.id}`, "PUT", registration("AB", saved.revision)));
    expect(saved.enabled).toBe(false);
    expect(saved.preferences.error).toBe(false);
    expect(f.push.getRegistration(saved.id)?.registrationGeneration).toBe(2);
    const attempts = await Promise.all([true, false].map((enabled) => f.request(`/api/push/devices/${saved.id}`, "PATCH", { expectedRevision: saved.revision, enabled })));
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
    saved = await read<PushDevice>(f.request(`/api/push/devices/${saved.id}`));
    saved = await read<PushDevice>(f.request(`/api/push/devices/${saved.id}`, "PATCH", { expectedRevision: saved.revision, enabled: true }));
    const event = await read<PushTestResult>(f.request(`/api/push/devices/${saved.id}/test`, "POST", { requestId: randomUUID() }), 202);
    saved = await read<PushDevice>(f.request(`/api/push/devices/${saved.id.toUpperCase()}`, "PUT", registration("CD", saved.revision)));
    expect(saved.enabled).toBe(true);
    expect(f.push.listDeliveries(event.notificationId)[0].registrationGeneration).toBe(3);
    expect(f.push.invalidateDevice(saved.id, 2)).toBe(false);
    expect(f.push.getRegistration(saved.id)?.deviceToken).toBe("cd");
    saved = await read<PushDevice>(f.request(`/api/push/devices/${saved.id}`, "PATCH", { expectedRevision: saved.revision, authorization: "denied" }));
    expect(saved.enabled).toBe(false);
    expect(f.push.listDeliveries(event.notificationId)[0].state).toBe("cancelled");
    await read(f.request(`/api/push/devices/${saved.id}`, "PATCH", { expectedRevision: saved.revision, enabled: true }), 409);
  });

  test("token transfer revokes old installation; DELETE fences late PUT and is idempotent", async () => {
    const f = await fixture();
    const old = await f.device("abcd", true);
    const result = await read<PushTestResult>(f.request(`/api/push/devices/${old.id}/test`, "POST", { requestId: randomUUID() }), 202);
    const moved = await f.device("ABCD");
    expect(moved.enabled).toBe(false);
    expect(await read(f.request(`/api/push/devices/${old.id}`))).toMatchObject({ state: "revoked", enabled: false });
    expect(f.push.getRegistration(old.id)?.deviceToken).toBeNull();
    expect(f.push.listDeliveries(result.notificationId)[0].state).toBe("cancelled");
    await read(f.request(`/api/push/devices/${moved.id}`, "DELETE", undefined, { ...auth, "If-Match": '"999"' }), 409);
    expect(await read(f.request(`/api/push/devices/${moved.id}`, "DELETE", undefined, { ...auth, "If-Match": `"${moved.revision}"` }))).toEqual({ ok: true });
    await read(f.request(`/api/push/devices/${moved.id}`, "DELETE", undefined, { ...auth, "If-Match": `"${moved.revision}"` }));
    await read(f.request(`/api/push/devices/${moved.id}`, "PUT", registration("ef", moved.revision)), 409);
    const missing = randomUUID();
    await read(f.request(`/api/push/devices/${missing}`, "DELETE", undefined, { ...auth, "If-Match": '"1"' }));
    await read(f.request(`/api/push/devices/${missing}`, "PUT", registration()), 409);
    const tombstone = await read<PushDevice>(f.request(`/api/push/devices/${missing}`));
    const restored = await read<PushDevice>(f.request(`/api/push/devices/${missing}`, "PUT", registration("ef", tombstone.revision)));
    expect(restored).toMatchObject({ state: "active", enabled: false });
    const list = await read<{ devices: PushDevice[] }>(f.request("/api/push/devices"));
    expect(list.devices.some((d) => d.state === "revoked")).toBe(true);
  });
});

describe("Push test outbox and targets", () => {
  test("test requires opt-in, ignores kind preferences, deduplicates before limits/eligibility and survives restart", async () => {
    const f = await fixture();
    let saved = await f.device();
    const path = `/api/push/devices/${saved.id}/test`;
    const requestId = randomUUID();
    await read(f.request(path, "POST", { requestId }), 409);
    expect(f.push.listEvents()).toEqual([]);
    for (const value of [{}, { requestId: "bad" }, { requestId, body: "canary" }]) await read(f.request(path, "POST", value), 400);
    saved = await read<PushDevice>(f.request(`/api/push/devices/${saved.id}`, "PATCH", { expectedRevision: saved.revision, enabled: true,
      preferences: { decision: false, approval_wait: false, error: false, report_complete: false } }));
    const [first, duplicate] = await Promise.all([read<PushTestResult>(f.request(path, "POST", { requestId }), 202),
      read<PushTestResult>(f.request(path, "POST", { requestId: requestId.toUpperCase() }), 202)]);
    expect(duplicate).toEqual(first);
    expect(f.push.listEvents()).toHaveLength(1);
    expect(f.push.listDeliveries(first.notificationId)).toHaveLength(1);
    expect(f.wakes()).toBe(1);
    await read(f.request(path, "POST", { requestId: randomUUID() }), 429);
    f.advance(59_999);
    await read(f.request(path, "POST", { requestId: randomUUID() }), 429);
    await f.restart();
    await read(f.request(path, "POST", { requestId: randomUUID() }), 429);
    f.advance(1);
    await read(f.request(path, "POST", { requestId: randomUUID() }), 202);
    await read(f.request(`/api/push/devices/${saved.id}`, "DELETE", undefined, { ...auth, "If-Match": `"${saved.revision}"` }));
    expect(await read<PushTestResult>(f.request(path, "POST", { requestId }), 202)).toEqual(first);
    expect(f.push.listEvents()).toHaveLength(2);
    expect(await read(f.request(`/api/push/events/${first.notificationId}/target`))).toEqual({ serverId: f.push.serverId, eventId: first.notificationId, target: { screen: "home" } });
    expect(f.calls).toEqual([]);
  });

  test("rate limits are per device; outbox failure rolls back event and consumes no rate budget", async () => {
    const f = await fixture();
    const a = await f.device(undefined, true);
    const b = await f.device(undefined, true);
    f.db.exec("CREATE TEMP TRIGGER refuse_delivery BEFORE INSERT ON push_deliveries BEGIN SELECT RAISE(ABORT,'token-canary'); END");
    const requestId = randomUUID();
    await read(f.request(`/api/push/devices/${a.id}/test`, "POST", { requestId }), 500);
    expect(f.push.listEvents()).toHaveLength(0);
    expect(f.wakes()).toBe(0);
    f.db.exec("DROP TRIGGER refuse_delivery");
    await read(f.request(`/api/push/devices/${a.id}/test`, "POST", { requestId }), 202);
    await read(f.request(`/api/push/devices/${b.id}/test`, "POST", { requestId }), 202);
    expect(f.push.listDeliveries().map((delivery) => delivery.deviceId).sort()).toEqual([a.id, b.id].sort());
    await read(f.request(`/api/push/devices/${randomUUID()}/test`, "POST", { requestId }), 404);
  });

  test("concurrent new test requests queue once; a retained receipt stays queued after acceptance and provider failure", async () => {
    const f = await fixture();
    const saved = await f.device(undefined, true);
    const path = `/api/push/devices/${saved.id}/test`;
    const ids = [randomUUID(), randomUUID()];
    const attempts = await Promise.all(ids.map((requestId) => f.request(path, "POST", { requestId })));
    expect(attempts.map((response) => response.status).sort()).toEqual([202, 429]);
    const accepted = attempts.findIndex((response) => response.status === 202);
    const result = await attempts[accepted].json() as PushTestResult;
    f.db.query("UPDATE push_deliveries SET state='accepted' WHERE event_id=?").run(result.notificationId);
    f.providers[0].state = "configuration_error";
    f.providers[0].lastError = "auth_failed";
    expect(await read<PushTestResult>(f.request(path, "POST", { requestId: ids[accepted] }), 202)).toEqual(result);
    f.advance(60_000);
    await read(f.request(path, "POST", { requestId: randomUUID() }), 409);
    expect(f.push.listDeliveries()).toHaveLength(1);
    expect(f.wakes()).toBe(1);
  });

  test("team targets read current state without runner calls and missing members are 404", async () => {
    const f = await fixture();
    const project = f.store.createProject({ name: "오류", cwd: "/fixture" });
    const member = f.store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker" });
    f.store.patchMember(member.id, { status: "error", lastError: "비밀 오류" });
    const event = f.push.listEvents().find((value) => value.kind === "error")!;
    f.store.patchMember(member.id, { status: "idle", lastError: null });
    expect(await read(f.request(`/api/push/events/${event.id}/target`))).toEqual({ serverId: f.push.serverId,
      eventId: event.id, target: { screen: "team", projectId: project.id, memberId: member.id } });
    f.store.removeMember(member.id);
    await read(f.request(`/api/push/events/${event.id}/target`), 404);
    expect(f.calls).toEqual([]);
  });

  test("targets preserve answered decisions, report group and old around anchors; archive/deletion/retention is 404", async () => {
    const f = await fixture();
    const project = f.store.createProject({ name: "알림", cwd: "/fixture" });
    const other = f.store.createProject({ name: "다른 곳", cwd: "/other" });
    const member = f.store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker" });
    const decision = f.store.createDecision({ projectId: project.id, memberId: member.id, who: "직원", title: "비밀 질문", options: [] });
    const event = f.push.listEvents().find((e) => e.kind === "decision")!;
    f.store.answerDecision(decision.id, { expectedVersion: decision.updatedAt, note: "확인" });
    expect(await read(f.request(`/api/push/events/${event.id}/target`))).toMatchObject({ target: { screen: "inbox", decisionId: decision.id } });
    const report = f.store.createMessage({ projectId: project.id, memberId: member.id, kind: "완료", body: "비밀 보고", mine: false });
    const second = f.store.createMessage({ projectId: project.id, memberId: member.id, kind: "완료", body: "비밀 보고 2", mine: false });
    f.advance(120_000);
    f.push.closeDueGroups(f.push.timestamp());
    const reportEvent = f.push.listEvents().find((e) => e.kind === "report_complete")!;
    const target = await read(f.request(`/api/push/events/${reportEvent.id}/target`));
    expect(target).toMatchObject({ target: { screen: "chat", messageId: second.id }, reportGroup: { reportIds: [report.id, second.id] } });
    for (let n = 0; n < 205; n++) f.store.createMessage({ projectId: project.id, kind: "나", body: `새 메시지 ${n}`, mine: true });
    const around = await read<{ id: string }[]>(f.request(`/api/projects/${project.id}/messages?around=${second.id}`));
    expect(Array.isArray(around)).toBe(true);
    expect(around.some((message) => message.id === second.id)).toBe(true);
    await read(f.request(`/api/projects/${other.id}/messages?around=${second.id}`), 404);
    await read(f.request(`/api/projects/${project.id}/messages?around=${second.id}&before=older`), 400);
    expect(Array.isArray(await read(f.request(`/api/projects/${project.id}/messages?limit=2`)))).toBe(true);
    f.store.patchProject(project.id, { archived: true });
    await read(f.request(`/api/push/events/${event.id}/target`), 404);
    f.store.patchProject(project.id, { archived: false });
    f.db.query("DELETE FROM decisions WHERE id=?").run(decision.id);
    await read(f.request(`/api/push/events/${event.id}/target`), 404);
    await read(f.request(`/api/push/events/${randomUUID()}/target`), 404);
    f.advance(90 * 86_400_000);
    await read(f.request(`/api/push/events/${reportEvent.id}/target`), 404);
    expect(f.calls).toEqual([]);
  });
});
