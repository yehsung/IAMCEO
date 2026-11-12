import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import pkg from "../package.json";
import { rotateAccessCode } from "../bin/iamceo.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); });
const oldCode = "rotation-private-canary";

async function fixture() {
  const isolated = createIsolatedRuntime();
  const env = isolated.childEnv();
  updateConfigFile({ accessCode: oldCode, hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  let ready = true;
  let coreAvailable = false;
  const orch = { runtimeInfo: async () => ({ backend: "core", core: { installed: true, available: coreAvailable, version: "fixture", detail: null },
    providers: { claude: { installed: false }, codex: { installed: false } } }) } as OrchestratorApi;
  const context = { config, bus, store, orch, daemon: () => ({ ready, buildId: "a".repeat(64), version: pkg.version }) };
  let server = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  const base = server.urls[0]!;
  cleanups.push(async () => { await server.stop(); store.db.close(); await isolated.stop(); });
  const request = (path: string, code = config.accessCode, method = "GET", body?: string) => fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${code}`, "Content-Type": "application/json" }, body,
  });
  return { config, server, bus, base, request, childEnv: { ...env, IAMCEO_PORT: String(server.port) }, cwd: isolated.paths.work,
    setReady: (value: boolean) => { ready = value; }, setCore: (value: boolean) => { coreAvailable = value; } };
}

function socket(base: string, code: string, v2: boolean) {
  const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
  const ws = new Socket(`${base.replace("http:", "ws:")}/ws${v2 ? "?v=2" : ""}`, { headers: { Authorization: `Bearer ${code}` } });
  const messages: unknown[] = [];
  const hello = new Promise<void>((resolve, reject) => {
    ws.onmessage = event => { messages.push(JSON.parse(String(event.data))); resolve(); };
    ws.onerror = () => reject(new Error("WS handshake failed"));
  });
  const closed = new Promise<number>(resolve => { ws.onclose = event => resolve(event.code); });
  cleanups.push(async () => { ws.close(); await closed; });
  return { hello, closed, messages };
}

describe("global access code rotation", () => {
  test("durable 0600 save precedes new auth; both Bearer WS protocols and pending QR are revoked without secret logs", async () => {
    const f = await fixture();
    const logs = [spyOn(console, "info"), spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
    try {
      const qr = await (await f.request("/api/pair/start", oldCode, "POST")).json() as { code: string };
      const legacy = socket(f.base, oldCode, false);
      const native = socket(f.base, oldCode, true);
      await Promise.all([legacy.hello, native.hello]);
      const response = await f.request("/api/auth/rotate", oldCode, "POST", "{}");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { accessCode } = await response.json() as { accessCode: string };
      expect(accessCode).not.toBe(oldCode);
      expect(JSON.parse(readFileSync(f.config.configPath, "utf8")).accessCode).toBe(accessCode);
      expect(statSync(f.config.configPath).mode & 0o777).toBe(0o600);
      expect(f.config.accessCode).toBe(accessCode);
      expect((await f.request("/api/capabilities", oldCode)).status).toBe(401);
      expect((await f.request("/ws?v=2", oldCode)).status).toBe(401);
      expect((await f.request("/api/capabilities", accessCode)).status).toBe(200);
      expect((await fetch(`${f.base}/files/missing/file.txt`, { headers: { Authorization: `Bearer ${oldCode}` } })).status).toBe(401);
      expect(await Promise.all([legacy.closed, native.closed])).toEqual([4001, 4001]);
      f.bus.emit({ type: "projects", projects: [] });
      expect(legacy.messages).toHaveLength(1);
      expect(native.messages).toHaveLength(1);
      const refused = await f.request("/pair/claim", "", "POST", JSON.stringify({ code: qr.code }));
      expect(refused.status).toBe(401);
      const fresh = await (await f.request("/api/pair/start", accessCode, "POST")).json() as { code: string };
      const claim = await f.request("/pair/claim", "", "POST", JSON.stringify({ code: fresh.code }));
      expect(claim.headers.get("cache-control")).toBe("no-store");
      // G(C3): 새 QR 은 그 기기만의 열쇠를 준다(공용 코드가 아니다). 열쇠도 새 공용 코드도 통한다.
      const { accessCode: deviceKey } = await claim.json() as { accessCode: string };
      expect(deviceKey).not.toBe(accessCode);
      expect((await f.request("/api/capabilities", deviceKey)).status).toBe(200);
      const reconnected = socket(f.base, accessCode, true);
      await reconnected.hello;
      const output = JSON.stringify(logs.flatMap(log => log.mock.calls));
      for (const secret of [oldCode, accessCode, fresh.code, qr.code, deviceKey]) expect(output).not.toContain(secret);
    } finally { for (const log of logs) log.mockRestore(); }
  });

  test("failed save preserves old auth and QR; concurrent rotations accept the old credential once", async () => {
    const f = await fixture();
    const qr = await (await f.request("/api/pair/start", oldCode, "POST")).json() as { code: string };
    const savedPath = join(f.config.home, "saved-config.json");
    renameSync(f.config.configPath, savedPath);
    mkdirSync(f.config.configPath);
    try {
      const response = await f.request("/api/auth/rotate", oldCode, "POST", "{}");
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: "AUTH_ROTATION_SAVE_FAILED" });
      expect(f.config.accessCode).toBe(oldCode);
      expect((await f.request("/api/capabilities", oldCode)).status).toBe(200);
      expect((await f.request("/pair/claim", "", "POST", JSON.stringify({ code: qr.code }))).status).toBe(200);
    } finally { rmdirSync(f.config.configPath); renameSync(savedPath, f.config.configPath); }
    const results = await Promise.all([f.request("/api/auth/rotate", oldCode, "POST", "{}"), f.request("/api/auth/rotate", oldCode, "POST", "{}")]);
    expect(results.map(result => result.status).sort()).toEqual([200, 401]);
    expect(JSON.parse(readFileSync(f.config.configPath, "utf8")).accessCode).toBe(f.config.accessCode);
  });

  test("Bearer, strict empty body, query, method and Origin checks cannot rotate accidentally", async () => {
    const f = await fixture();
    expect((await fetch(`${f.base}/api/auth/rotate?t=${oldCode}`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await f.request("/api/auth/rotate", oldCode)).status).toBe(405);
    for (const body of ["bad", "[]", '{"accessCode":"chosen"}']) expect((await f.request("/api/auth/rotate", oldCode, "POST", body)).status).toBe(400);
    expect((await f.request("/api/auth/rotate?x=1", oldCode, "POST", "{}")).status).toBe(400);
    expect((await fetch(`${f.base}/api/auth/rotate`, { method: "POST", headers: { Authorization: `Bearer ${oldCode}`, Origin: "https://foreign.example" }, body: "{}" })).status).toBe(403);
    expect(f.config.accessCode).toBe(oldCode);
  });

  test("a directory fsync failure after atomic rename reports uncertainty and keeps running authentication aligned with disk", async () => {
    const f = await fixture();
    const original = fs.fsyncSync;
    const sync = spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("fixture directory fsync failure");
      original(fd);
    });
    let response: Response;
    try { response = await f.request("/api/auth/rotate", oldCode, "POST", "{}"); }
    finally { sync.mockRestore(); }
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "AUTH_ROTATION_OUTCOME_UNKNOWN" });
    const saved = JSON.parse(readFileSync(f.config.configPath, "utf8")).accessCode;
    expect(saved).not.toBe(oldCode);
    expect(f.config.accessCode).toBe(saved);
    expect((await f.request("/api/capabilities", oldCode)).status).toBe(401);
    expect((await f.request("/api/capabilities", saved)).status).toBe(200);
  });

  test("a tailnet peer cannot rotate even with Bearer and forged local proxy headers", async () => {
    let handle: ((req: Request, server: unknown) => Promise<Response>) | undefined;
    const original = Bun.serve;
    const spy = spyOn(Bun, "serve").mockImplementation(((options: Parameters<typeof Bun.serve>[0]) => {
      const routes = options.routes as Record<string, unknown> | undefined;
      if (routes?.["/api/*"]) handle = routes["/api/*"] as typeof handle;
      return original(options);
    }) as typeof Bun.serve);
    let f: Awaited<ReturnType<typeof fixture>>;
    try { f = await fixture(); } finally { spy.mockRestore(); }
    const response = await handle!(new Request(`${f.base}/api/auth/rotate`, { method: "POST", headers: {
      Authorization: `Bearer ${oldCode}`, Host: new URL(f.base).host, "X-Forwarded-For": "127.0.0.1",
    }, body: "{}" }), { requestIP: () => ({ address: "100.64.0.2" }) } as unknown as Server<undefined>);
    expect(response.status).toBe(403);
    expect(f.config.accessCode).toBe(oldCode);
  });

  test("liveness remains public while authenticated readiness distinguishes daemon, build, schema and core", async () => {
    const f = await fixture();
    expect(await (await fetch(`${f.base}/api/health`)).json()).toEqual({ ok: true, version: pkg.version });
    expect((await fetch(`${f.base}/api/readiness`)).status).toBe(401);
    let response = await f.request("/api/readiness");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, daemon: { ready: true, buildId: "a".repeat(64) },
      schema: { version: MIGRATIONS.length, supportedVersion: MIGRATIONS.length }, core: { available: false } });
    f.setReady(false); f.setCore(true);
    response = await f.request("/api/readiness");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "서버를 시작하는 중입니다", code: "STARTING" });
    expect((await fetch(`${f.base}/api/health`)).status).toBe(503);
  });

  test("CLI rotates over loopback without redirects or replay, and a lost response points to local open", async () => {
    const f = await fixture();
    const client = { ...f.config, port: f.server.port };
    const code = await rotateAccessCode(client);
    expect(code).toBe(f.config.accessCode);
    expect(client.accessCode).toBe(code);
    expect((await f.request("/api/capabilities", oldCode)).status).toBe(401);
    let calls = 0;
    const failing = (async (_url: RequestInfo | URL, init?: RequestInit) => { calls++; expect(init?.redirect).toBe("error"); throw new Error("lost response"); }) as unknown as typeof fetch;
    await expect(rotateAccessCode(client, failing)).rejects.toThrow("iamceo open");
    expect(calls).toBe(1);
    await expect(rotateAccessCode({ ...client, hosts: ["100.64.0.1"] }, failing)).rejects.toThrow("loopback");
    expect(calls).toBe(1);
  });

  test("the local action also accepts POST without a body", async () => {
    const f = await fixture();
    const response = await f.request("/api/auth/rotate", oldCode, "POST");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accessCode: f.config.accessCode });
    expect(f.config.accessCode).not.toBe(oldCode);
  });

  test("the real local CLI command explicitly displays the replacement and never prints it to stderr", async () => {
    const f = await fixture();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/iamceo.ts"), "auth", "rotate"], {
      cwd: f.cwd, env: f.childEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    cleanups.push(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
    const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status).toBe(0);
    expect(f.config.accessCode).not.toBe(oldCode);
    // 명령줄 문구는 실행 환경의 언어를 따른다(server/cli-text.ts).
    expect(output).toMatch(new RegExp(`(접속 코드|Access code): ${f.config.accessCode}`));
    expect(error).toBe("");
    expect(JSON.parse(readFileSync(f.config.configPath, "utf8")).accessCode).toBe(f.config.accessCode);
  });
});
