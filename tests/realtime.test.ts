import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type ServerContext } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Store } from "../server/store.ts";
import type { HerdrInfo, RealtimeEvent, SyncCursor, SyncSnapshot, WsEvent } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const CODE = "realtime-fixture-code";
const auth = { Authorization: `Bearer ${CODE}` };
const unavailable: HerdrInfo = { installed: false, running: false, version: null, protocol: null, compatible: false, warning: "fixture unavailable" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });

async function fixture(herdrInfo: () => Promise<HerdrInfo> = async () => unavailable, suppliedBus = new Bus(), context: Partial<ServerContext> = {}) {
  const home = mkdtempSync("/private/tmp/iamceo-realtime-");
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = suppliedBus;
  const store = new Store(openDb(config.dbPath), bus);
  const calls: string[] = [];
  // w1: 스냅샷이 실행 엔진 상태를 싣는다. 이미 아는 값을 읽기만 하고 실행기를 다시 보지 않으므로 허용 목록에 둔다.
  const orch = new Proxy({ herdrInfo: async () => { calls.push("herdrInfo"); return herdrInfo(); }, cliCommand: () => "fixture-cli", engineStatus: () => null }, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      return () => { calls.push(String(key)); throw new Error(`Unexpected orchestrator call: ${String(key)}`); };
    },
  }) as unknown as OrchestratorApi;
  let server = await startServer({ config, store, bus, orch, ...context });
  while (server.port === 7878) { await server.stop(); server = await startServer({ config, store, bus, orch }); }
  const base = `http://127.0.0.1:${server.port}`;
  cleanup.push(async () => { await Bun.sleep(0); await server.stop(); store.db.close(); rmSync(home, { recursive: true }); });
  const sync = async (query = ""): Promise<SyncSnapshot> => {
    const response = await fetch(`${base}/api/sync${query}`, { headers: auth });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response.json() as Promise<SyncSnapshot>;
  };
  return { store, bus, base, calls, sync, server, wsURL: `ws://127.0.0.1:${server.port}/ws` };
}

function connect(url: string, headers?: Record<string, string>) {
  // 이 프로젝트의 lib.dom 선언이 Bun의 헤더 생성자 overload를 가린다.
  const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const ws = new Socket(url, { headers });
  const events: (RealtimeEvent | WsEvent)[] = [];
  const listeners = new Set<() => void>();
  ws.onmessage = (message) => { events.push(JSON.parse(String(message.data))); for (const notify of listeners) notify(); };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WS refused"));
  });
  const closed = new Promise<number>((resolve) => { ws.onclose = (event) => resolve(event.code); });
  const next = (predicate: (event: RealtimeEvent | WsEvent) => boolean, timeout = 3000): Promise<RealtimeEvent | WsEvent> => new Promise((resolve, reject) => {
    const check = () => {
      const found = events.find(predicate);
      if (found) { clearTimeout(timer); listeners.delete(check); resolve(found); }
    };
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error("WS event timeout")); }, timeout);
    listeners.add(check);
    check();
  });
  cleanup.push(async () => { ws.close(); await closed; });
  return { ws, events, opened, closed, next };
}

describe("Bus emit cursor", () => {
  test("epoch·캡처 cursor는 중첩 emit 및 listener 객체 변경과 무관하다", () => {
    const bus = new Bus();
    expect(bus.cursor).toEqual({ epoch: expect.any(String), seq: 0 });
    expect(new Bus().epoch).not.toBe(bus.epoch);
    const got: { event: WsEvent; cursor: Readonly<SyncCursor> }[] = [];
    bus.subscribe((event, cursor) => {
      if (event.type === "herdr") bus.emit({ type: "projects", projects: [] });
      expect(Object.isFrozen(cursor)).toBe(true);
    });
    const off = bus.subscribe((event, cursor) => { got.push({ event, cursor }); });
    const event: WsEvent = { type: "herdr", herdr: unavailable };
    bus.emit(event);
    expect(got.map((value) => [value.event.type, value.cursor.seq])).toEqual([["projects", 2], ["herdr", 1]]);
    expect(event).toEqual({ type: "herdr", herdr: unavailable });
    off();
    bus.emit({ type: "projects", projects: [] });
    expect(got).toHaveLength(2);
  });

  test("안전 정수 한계 전에 epoch를 교체한다", () => {
    const bus = new Bus();
    const epoch = bus.epoch;
    bus.seq = Number.MAX_SAFE_INTEGER - 1;
    bus.emit({ type: "projects", projects: [] });
    expect(bus.epoch).not.toBe(epoch);
    expect(bus.seq).toBe(1);
  });
});

describe("sync snapshot", () => {
  test("ready 전 상태 조회는 STARTING이고 준비 뒤 기존 계약으로 응답한다", async () => {
    let ready = false;
    const f = await fixture(undefined, undefined, { daemon: () => ({ ready, buildId: "fixture", version: "fixture" }) });
    for (const path of ["/api/sync?projectId=hq", "/api/health", "/api/readiness", "/api/runtime", "/api/bootstrap", "/api/projects/hq/state", "/api/push/status"]) {
      const response = await fetch(f.base + path, { headers: auth });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "서버를 시작하는 중입니다", code: "STARTING" });
    }
    expect(f.calls).toEqual([]);
    expect((await fetch(f.base + "/api/sync")).status).toBe(401);
    ready = true;
    expect((await f.sync("?projectId=hq")).projectStatus).toBe("ok");
  });

  test("sync bytes는 동시·반복 요청에 재사용하고 lite·project·seq·epoch마다 분리한다", async () => {
    const f = await fixture();
    const build = spyOn(f.store, "projectState");
    try {
      const snapshots = await Promise.all(Array.from({ length: 8 }, () => f.sync("?projectId=hq")));
      expect(build).toHaveBeenCalledTimes(1);
      for (const snapshot of snapshots) expect(snapshot).toEqual(snapshots[0]);
      await f.sync("?projectId=hq");
      expect(build).toHaveBeenCalledTimes(1);
      await f.sync("?projectId=hq&lite=1");
      expect(build).toHaveBeenCalledTimes(2);
      const project = f.store.createProject({ name: "other", cwd: "/fixture", runnerEnabled: false });
      await f.sync(`?projectId=${project.id}`);
      expect(build).toHaveBeenCalledTimes(3);
      const message = f.store.createMessage({ projectId: "hq", kind: "알림", body: "new seq" });
      expect((await f.sync("?projectId=hq")).state!.messages.some(m => m.id === message.id)).toBe(true);
      expect(build).toHaveBeenCalledTimes(4);
      const seq = f.bus.seq;
      f.bus.seq = Number.MAX_SAFE_INTEGER - 1;
      f.bus.emit({ type: "projects", projects: [] });
      f.bus.seq = seq;
      expect((await f.sync("?projectId=hq")).cursor.epoch).toBe(f.bus.epoch);
      expect(build).toHaveBeenCalledTimes(5);
    } finally { build.mockRestore(); }
  });
  test("선택 상태·revision·cursor는 같은 동기 경계이고 실행기를 갱신하지 않는다", async () => {
    const f = await fixture();
    const p = f.store.createProject({ name: "sync", cwd: "/fixture", runnerEnabled: false });
    const m = f.store.createMember({ projectId: p.id, handle: "w", name: "w", kind: "worker", modelOverride: "fixture-model" });
    f.store.patchMember(m.id, { effortOverride: "high" });
    const todo = f.store.createTodo({ projectId: p.id, title: "할 일" });
    f.store.setTodoDone(todo.id, true);
    f.store.patchSettings({ maxAwakeWorkers: 3 });
    const snapshot = await f.sync(`?projectId=${p.id}`);
    expect(snapshot).toMatchObject({ protocol: 2, requestedProjectId: p.id, projectStatus: "ok", state: { project: { id: p.id } } });
    expect(snapshot.cursor).toEqual(f.bus.cursor);
    expect(snapshot.revisions).toEqual(f.store.syncRevisions(p.id));
    expect(snapshot.bootstrap).not.toHaveProperty("runtime");
    expect(snapshot.bootstrap.herdr).toEqual(unavailable);
    expect(snapshot.bootstrap.rankOverrides).toEqual({ manager: 0, lead: 1 });
    expect(JSON.stringify(snapshot)).not.toContain(f.store.getMemberToken(m.id));
    expect(await f.sync()).toMatchObject({ requestedProjectId: null, projectStatus: "none", state: null, revisions: { members: {}, todos: {} } });
    expect(await f.sync("?projectId=missing")).toMatchObject({ requestedProjectId: "missing", projectStatus: "not_found", state: null });
    f.store.patchProject(p.id, { archived: true });
    expect(await f.sync(`?projectId=${p.id}`)).toMatchObject({ requestedProjectId: p.id, projectStatus: "archived", state: null, revisions: { members: {}, todos: {} } });
    expect(f.calls).toEqual(["herdrInfo"]);
    for (const query of ["?projectId=", "?projectId=%20", "?projectId=hq&projectId=hq", "?unknown=1", `?projectId=${"x".repeat(257)}`]) {
      const response = await fetch(`${f.base}/api/sync${query}`, { headers: auth });
      expect([query, response.status]).toEqual([query, 400]);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("초기 진단은 single flight이며 대기 중 herdr 이벤트가 오래된 결과보다 우선한다", async () => {
    let resolveInfo!: (value: HerdrInfo) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<HerdrInfo>((resolve) => { resolveInfo = resolve; });
    const f = await fixture(() => { entered(); return pending; });
    const a = f.sync("?projectId=hq");
    const b = f.sync("?projectId=hq");
    await started;
    const latest = { ...unavailable, running: true, warning: "newer observation" };
    f.bus.emit({ type: "herdr", herdr: latest });
    const message = f.store.createMessage({ projectId: "hq", kind: "알림", body: "during diagnostic await" });
    resolveInfo(unavailable);
    for (const snapshot of await Promise.all([a, b])) {
      expect(snapshot.bootstrap.herdr).toEqual(latest);
      expect(snapshot.state!.messages.some((m) => m.id === message.id)).toBe(true);
      expect(snapshot.cursor).toEqual(f.bus.cursor);
    }
    expect((await f.sync()).bootstrap.herdr).toEqual(latest);
    expect(f.calls).toEqual(["herdrInfo"]);
  });

  test("진단 실패는 500이며 다음 조회에서 재시도한다", async () => {
    let attempts = 0;
    const f = await fixture(async () => { if (++attempts === 1) throw new Error("fixture diagnostic failed"); return unavailable; });
    const response = await fetch(`${f.base}/api/sync`, { headers: auth });
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await f.sync()).bootstrap.herdr).toEqual(unavailable);
    expect(attempts).toBe(2);
  });

  test("중첩 herdr 발행은 늦게 관측한 바깥 이벤트로 캐시를 되돌리지 않는다", async () => {
    const bus = new Bus();
    const latest = { ...unavailable, warning: "inner newer" };
    bus.subscribe((event) => {
      if (event.type === "herdr" && event.herdr.warning === "outer older") bus.emit({ type: "herdr", herdr: latest });
    });
    const f = await fixture(undefined, bus);
    bus.emit({ type: "herdr", herdr: { ...unavailable, warning: "outer older" } });
    expect((await f.sync()).bootstrap.herdr).toEqual(latest);
    expect(f.calls).toEqual([]);
  });
});

describe("v1/v2 WebSocket", () => {
  test("실제 listener에 16MiB backpressure 상한과 자동 종료를 설정한다", async () => {
    const serve = spyOn(Bun, "serve");
    try {
      await fixture();
      const listener = serve.mock.calls.map(([options]) => options).find((options) => options?.websocket);
      expect(listener?.websocket).toMatchObject({ backpressureLimit: 16 * 1024 * 1024, closeOnBackpressureLimit: true });
    } finally { serve.mockRestore(); }
  });

  test("버전·query·Bearer·Origin·Host 검증", async () => {
    const f = await fixture();
    for (const [query, headers, status] of [
      ["?v=2&t=secret", auth, 400], ["?v=2&t=", auth, 400], ["?v=3", auth, 400], ["?v=", auth, 400],
      ["?v=2&v=2", auth, 400], ["?v=2&since=0", auth, 400], ["?v=2", {}, 401], ["?t=" + CODE, {}, 401], ["?v=2&t=" + CODE, {}, 401],
      ["?v=2", { Authorization: "Bearer wrong" }, 401], ["?v=2", auth, 400],
      ["?v=2", { ...auth, Origin: "http://evil.example" }, 403], ["?v=2", { ...auth, Host: "evil.example" }, 403],
    ] as const) {
      const res = await fetch(`${f.base}/ws${query}`, { headers });
      expect([query, res.status]).toEqual([query, status]);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const member = f.store.createMember({ projectId: "hq", handle: "auth", name: "auth", kind: "worker" });
    expect((await fetch(`${f.base}/ws?v=2`, { headers: { Authorization: `Bearer ${f.store.getMemberToken(member.id)}` } })).status).toBe(401);
    const refused = connect(`${f.wsURL}?t=${CODE}`, { Authorization: "Bearer wrong" });
    await expect(refused.opened).rejects.toThrow("WS refused");
  });

  test("각 topic은 v1 모양과 emit cursor를 유지하며 snapshot 이후 이벤트로 이어진다", async () => {
    const bus = new Bus();
    bus.subscribe((event) => { if (event.type === "herdr") bus.emit({ type: "projects", projects: [] }); });
    const f = await fixture(undefined, bus);
    const v1 = connect(f.wsURL, auth);
    const v2 = connect(`${f.wsURL}?v=2`, auth);
    await Promise.all([v1.opened, v2.opened]);
    expect(await v1.next((e) => e.type === "hello")).toEqual({ type: "hello", seq: bus.seq });
    expect(await v2.next((e) => e.type === "hello")).toEqual({ type: "hello", protocol: 2, ...bus.cursor, heartbeatMs: 15000, staleAfterMs: 45000 });
    const snapshot = await f.sync("?projectId=hq");
    const message = f.store.createMessage({ projectId: "hq", kind: "알림", body: "wire" });
    expect(await v1.next((e) => e.type === "message")).toEqual({ type: "message", message });
    expect(await v2.next((e) => e.type === "message")).toEqual({ type: "message", message, epoch: snapshot.cursor.epoch, seq: snapshot.cursor.seq + 1 });
    bus.emit({ type: "herdr", herdr: unavailable });
    const nested = await v2.next((e) => e.type === "herdr") as RealtimeEvent;
    expect(nested.seq).toBe(bus.seq - 1);
    expect(v2.events.filter((e) => e.type === "projects").at(-1)).toMatchObject({ seq: bus.seq });
    expect(v1.events.every((e) => !("epoch" in e))).toBe(true);
    const beforeInput = bus.seq;
    v2.ws.send(JSON.stringify({ type: "subscribe", projectId: "hq" }));
    const second = f.store.createMessage({ projectId: "hq", kind: "알림", body: "after ignored input" });
    await v2.next((e) => e.type === "message" && e.message.id === second.id);
    expect(bus.seq).toBe(beforeInput + 1);
  });

  test("heartbeat는 high-water를 보내고 seq를 증가시키지 않는다", async () => {
    const f = await fixture();
    const a = connect(f.wsURL, auth);
    const b = connect(`${f.wsURL}?v=2`, auth);
    await Promise.all([a.opened, b.opened]);
    const cursor = f.bus.cursor;
    expect(await a.next((e) => e.type === "ping", 17000)).toEqual({ type: "ping" });
    expect(await b.next((e) => e.type === "ping", 1000)).toEqual({ type: "ping", ...cursor });
    expect(f.bus.cursor).toEqual(cursor);
  }, 20000);

  test("epoch 회전은 열린 v2만 닫고 다음 연결에 새 cursor를 준다", async () => {
    if (process.env.IAMCEO_EPOCH_CHILD !== "1") {
      // Bun 1.3.14는 서버 선종료 WS 뒤 다른 서버를 만들면 native panic이
      // 발생한다. 경계 시험의 모든 검증을 자식에서 실행해 다른 시험과 격리한다.
      const runtime = createIsolatedRuntime();
      const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "epoch 회전은"], {
        cwd: runtime.paths.work,
        env: { ...runtime.childEnv(), IAMCEO_EPOCH_CHILD: "1" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" });
        expect(stderr).toContain("1 pass");
        expect(stderr).toContain("0 fail");
      } finally { clearTimeout(timeout); await runtime.stop(); }
      return;
    }
    const f = await fixture();
    const a = connect(f.wsURL, auth);
    const b = connect(`${f.wsURL}?v=2`, auth);
    await Promise.all([a.opened, b.opened]);
    const epoch = f.bus.epoch;
    f.bus.seq = Number.MAX_SAFE_INTEGER - 1;
    f.bus.emit({ type: "projects", projects: [] });
    expect(await b.closed).toBe(1012);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(f.bus.epoch).not.toBe(epoch);
    const c = connect(`${f.wsURL}?v=2`, auth);
    await c.opened;
    expect(await c.next((e) => e.type === "hello")).toMatchObject({ epoch: f.bus.epoch, seq: 1 });
    await f.server.stop();
    expect(await a.closed).toBe(1012);
    expect(await c.closed).toBe(1012);
    expect(a.events as unknown[]).toContainEqual({ type: "restarting" });
    expect(c.events as unknown[]).toContainEqual({ type: "restarting" });
    await expect(fetch(`${f.base}/api/health`)).rejects.toThrow();
  });
});
