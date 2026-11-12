// Native HTTP/WS contracts, inventoried before web removal. No live services or credentials.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Socket } from "node:net";
import type { CoreTerminal } from "../server/runner/core-client.ts";
import { PushEventRecorder } from "../server/push/events.ts";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";
import type { TerminalControlAction, TerminalControlResult } from "../server/runner/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile, VERSION } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { startServer, type RunningServer, type ServerContext } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { PushStore } from "../server/push/store.ts";
import type { Runner, RunnerMember, RunnerStopOptions, SendResult } from "../server/runner/types.ts";
import { ApiError, Store } from "../server/store.ts";
import type { OperationReceipt } from "../shared/operations.ts";
import type { ApprovalPrompt } from "../shared/types.ts";
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
  async screen() { return "fixture screen"; }
  async approval(): Promise<ApprovalPrompt> {
    return { title: "Bash command", body: "echo fixture", question: "Do you want to proceed?", fingerprint: "9e4fef861d54b7c7a9005d63",
      options: [{ n: 1, label: "Yes", reject: false }, { n: 2, label: "No", reject: true }] };
  }
  async answerApproval() {
    const prompt = (await this.approval())!;
    return { ok: true as const, prompt, chosen: prompt.options[0]! };
  }
  on() {}
  async shutdown() {}
  async terminalControl(_member: RunnerMember, action: TerminalControlAction): Promise<TerminalControlResult> {
    this.terminalCalls++;
    return action.action === "claim" ? { leaseId: "fixture-lease", expiresAt: Date.now() + 300_000 } : {};
  }
  async terminalInfo() { return { cols: 100, rows: 30 }; }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const isolated = createIsolatedRuntime();
  const env = { IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0",
    IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin };
  updateConfigFile({ accessCode: "api-compatibility", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const db = openDb(config.dbPath);
  const providers = [{ environment: "sandbox" as const, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready" as const, lastError: null }];
  const push = new PushStore(db, { providers: () => providers });
  const store = new Store(db, bus, new PushEventRecorder(push));
  store.patchSettings({ boardTidyHours: 0 });
  const runner = new FakeRunner();
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: isolated.providerHomes,
    timings: { tickMs: 60_000, healthMs: 60_000 } });
  const project = store.createProject({ name: "호환 시험", cwd: isolated.paths.work });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker",
    backend: "core", status: "idle", sessionId: randomUUID(), paneId: "fake:worker", cwd: isolated.paths.work });
  const manual = store.createMember({ projectId: project.id, handle: "manual", name: "직접 직원", kind: "worker", origin: "manual", status: "idle" });
  // Only explicit fixture executables may run, including GitHub and terminal attach.
  const gh = join(isolated.paths.bin, "gh");
  writeFileSync(gh, '#!/bin/sh\nif [ "$1" = auth ]; then exit 0; fi\nif [ "$2" = list ]; then printf "[]"; fi\n');
  chmodSync(gh, 0o755);
  writeFileSync(isolated.bins.coreBin, '#!/bin/sh\nif [ "$1" = --version ]; then printf "fixture\\n"; exit 0; fi\nprintf "fixture terminal\\n"\nexec /bin/sleep 20\n');
  const context: ServerContext = { config, store, bus, orch, delivery: orch.deliveryRecovery,
    push: { store: push, providers: () => providers }, folderHome: isolated.paths.work, githubFreeBytes: async () => 10 * 1024 ** 3,
    daemon: () => ({ ready: true, buildId: "fixture-build", version: VERSION }) };
  let server: RunningServer | undefined;
  cleanups.push(async () => { await server?.stop(); await orch.shutdown(); store.db.close(); await isolated.stop(); });
  const previousPath = process.env.PATH;
  process.env.PATH = isolated.paths.bin;
  try { do { await server?.stop(); server = await startServer(context); } while (server.port === 7878); }
  finally { process.env.PATH = previousPath; }
  const base = `http://127.0.0.1:${server!.port}`;
  orch.setServerUrl(base);
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { isolated, config, bus, store, runner, orch, context, project, member, manual, request, base, push, server: server! };
}

const v2 = { "X-IAMCEO-Contract": "2" };
async function json<T = any>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  expect({ status: response.status, ...(response.status === status ? {} : { body }) }).toEqual({ status });
  expect(response.headers.get("cache-control")).toBe("no-store");
  return body as T;
}

function socket(url: string, code: string) {
  const ws = new (WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket)(url, { headers: { Authorization: `Bearer ${code}` } });
  const received = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native WebSocket timeout")), 3000);
    ws.onmessage = event => { clearTimeout(timer); resolve(JSON.parse(String(event.data))); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("Native WebSocket refused")); };
  });
  const closed = new Promise<void>(resolve => { ws.onclose = () => resolve(); });
  return { received, async close() { ws.close(); await closed; } };
}

test("native reads, paging, file bodies/render, uploads, folders and GitHub retain Bearer contracts", async () => {
  const f = await fixture(), p = `/api/projects/${f.project.id}`, m = `/api/members/${f.member.id}`;
  const message = f.store.createMessage({ projectId: f.project.id, body: "보고", kind: "완료", memberId: f.member.id });
  const decision = f.store.createDecision({ projectId: f.project.id, who: "직원", title: "결재" });
  const file = f.store.createFile({ projectId: f.project.id, title: "네이티브 자료", kind: "artifact", html: "<h1>native</h1><script>1</script>" });
  const local = join(f.isolated.paths.work, "native.html");
  writeFileSync(local, "<h1>local native</h1>");
  for (const path of ["/api/health", "/api/readiness", "/api/bootstrap", "/api/runtime", "/api/models", "/api/capabilities",
    "/api/sync", `/api/sync?projectId=${f.project.id}&lite=1`, `${p}/state`, `${p}/state?lite=1`,
    `${p}/messages?limit=200`, `${p}/messages?around=${message.id}&limit=41`, `${p}/messages/page?scope=project&limit=1`,
    `${p}/messages/page?scope=member&memberId=${f.member.id}&limit=100`, `/api/messages/${message.id}`,
    `${p}/decisions?status=done&limit=50`, `/api/decisions/${decision.id}`, `${m}/activity?limit=100`, `${m}/screen`, `${m}/approval`,
    `${m}/delivery-notices?limit=20`, `${p}/delivery-notices`, `/api/files/${file.id}`, `/api/files/${file.id}/artifact`,
    `/api/folders?path=${encodeURIComponent(f.isolated.paths.work)}`, "/api/github/repos?query=native"]) {
    await json(await f.request(path));
  }
  const page = await json(await f.request(`${p}/messages/page?scope=project&limit=1`));
  if (page.nextCursor) await json(await f.request(`${p}/messages/page?scope=project&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`));
  expect(await json(await f.request(`${p}/files/search?q=네이티브&limit=200`, "GET", undefined, v2))).toHaveLength(1);
  for (const path of [`${p}/local-file?path=${encodeURIComponent(local)}`, `${p}/local-file?path=${encodeURIComponent(local)}&render=1`, `/api/files/${file.id}/artifact?render=1`]) {
    const res = await f.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(await res.text()).toContain("native");
  }
  const imported = await json(await f.request(`${p}/files/from-path`, "POST", { path: local }));
  expect(imported.kind).toBe("artifact");
  const form = new FormData(); form.append("file", new File(["attachment"], "native.txt", { type: "text/plain" }));
  const uploaded = await json(await fetch(`${f.base}/api/uploads?project=${f.project.id}&target=${f.member.id}`, {
    method: "POST", headers: { Authorization: `Bearer ${f.config.accessCode}` }, body: form,
  }));
  const bytes = await f.request(uploaded.url);
  expect(bytes.status).toBe(200); expect(await bytes.text()).toBe("attachment");
  const range = await f.request(uploaded.url, "GET", undefined, { Range: "bytes=0-3" });
  expect(range.status).toBe(206); expect(await range.text()).toBe("atta");
  const head = await f.request(uploaded.url, "HEAD"); expect(head.status).toBe(200); expect(await head.text()).toBe("");
  await json(await f.request("/api/folders", "POST", { parent: f.isolated.paths.work, name: "new-folder" }));
  const cloned = await json(await f.request("/api/github/clone", "POST", { parent: f.isolated.paths.work, repo: "owner/native" }), 202);
  await json(await f.request(`/api/github/clone/${cloned.jobId}`));
  // Browser upload security assertions remain meaningful to native downloads.
  expect(bytes.headers.get("content-disposition")).toStartWith("attachment");
  expect(bytes.headers.get("x-content-type-options")).toBe("nosniff");
  expect(bytes.headers.get("content-security-policy")).toContain("sandbox");
});

test("native v1/v2 writes, CAS revisions, receipts and recovery remain authenticated", async () => {
  const f = await fixture(), p = `/api/projects/${f.project.id}`, m = `/api/members/${f.member.id}`;
  await json(await f.request("/api/projects", "POST", { name: "새 프로젝트", cwd: f.isolated.paths.work }));
  await json(await f.request(p, "PATCH", { name: "이름 변경" }));
  await json(await f.request(`${p}/members`, "POST", { name: "추가 직원", cli: "claude", role: "확인" }));
  await json(await f.request(`${p}/conductor/start`, "POST"));
  const message = { id: randomUUID(), text: "지시", targetMemberId: f.member.id, attachmentIds: [] };
  const first = await json(await f.request(`${p}/messages`, "POST", message));
  expect(await json(await f.request(`${p}/messages`, "POST", message))).toMatchObject({ id: first.id, body: message.text });
  expect(f.store.listMessages(f.project.id).filter(value => value.id === message.id)).toHaveLength(1);
  await json(await f.request(`${p}/messages`, "POST", { ...message, id: randomUUID() }, v2));
  for (const headers of [{}, v2]) {
    const decision = f.store.createDecision({ projectId: f.project.id, who: "직원", title: "결재", options: [{ k: "a", label: "승인" }] });
    await json(await f.request(`/api/decisions/${decision.id}/answer`, "POST", { choice: "a", expectedVersion: decision.updatedAt }, headers));
  }
  const closed = f.store.createDecision({ projectId: f.project.id, who: "직원", title: "다시 열기" });
  f.store.closeDecision(closed.id, { kind: "obsolete", reason: "철회", by: f.member.id });
  await json(await f.request(`/api/decisions/${closed.id}/reopen`, "POST"));
  await json(await f.request("/api/settings", "PUT", { notifyMac: false }));
  await json(await f.request("/api/settings", "PATCH", { macScriptNotifications: false }));
  for (const method of ["PUT", "PATCH"]) await json(await f.request("/api/settings", method, { macScriptNotifications: true }, { ...v2, "If-Match": `"${f.store.settingsRevision()}"` }));
  await json(await f.request(m, "PATCH", {}));
  await json(await f.request(m, "PATCH", {}, { ...v2, "If-Match": `"${f.store.memberRevisions(f.member.id).configRevision}"` }));
  for (const action of ["done", "drop"]) for (const strict of [false, true]) {
    const todo = f.store.createTodo({ projectId: f.project.id, title: "할 일" });
    const body = action === "done" ? { done: true } : { reason: "정리" };
    await json(await f.request(`/api/todos/${todo.id}/${action}`, "POST", body, strict ? { ...v2, "If-Match": `"${f.store.todoRevision(todo.id)}"` } : {}));
  }
  const fresh = f.store.createMember({ projectId: f.project.id, handle: "fresh", name: "새 세션", kind: "worker", backend: "core", sessionId: randomUUID(), paneId: "fake:fresh" });
  const freshPath = `/api/members/${fresh.id}/fresh-session`;
  await json(await f.request(freshPath, "POST"));
  const receipt = await json<OperationReceipt>(await f.request(freshPath, "POST", { operationId: randomUUID(), expectedSessionGeneration: f.store.memberRevisions(fresh.id).sessionGeneration }, v2));
  expect(receipt.status).toBe("applied");
  expect(await json(await f.request(`/api/operations/${receipt.operationId}`, "GET", undefined, v2))).toEqual(receipt);
  const terminal = `/api/members/${fresh.id}/terminal/control`;
  await json(await f.request(terminal, "POST", { action: "claim" }));
  await json(await f.request(terminal, "POST", { action: "release", leaseId: "fixture-lease" }));
  await json(await f.request(terminal, "POST", { action: "claim", claimId: "native-contract", operationId: randomUUID(), expectedSessionGeneration: f.store.memberRevisions(fresh.id).sessionGeneration }, v2));
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: fresh.id, kind: "instruction", text: "확인" });
  const current = f.store.getDeliveryRecovery(delivery.id)!;
  const held = f.store.updateDeliveryRecovery(delivery.id, current.version, { phase: "needs_owner", reason: "log_missing" });
  await json(await f.request(`/api/deliveries/${delivery.id}/recovery`, "POST", { operationId: randomUUID(), expectedVersion: held.version, action: "stop_retry" }, v2));
  const failed = f.store.createMessage({ projectId: f.project.id, mine: true, kind: "나", body: "미지정", delivery: "failed" });
  await json(await f.request(`/api/messages/${failed.id}/recovery`, "POST", { operationId: randomUUID(), expectedVersion: 0, action: "dismiss" }, v2));
  await json(await f.request(`${p}/tidy`, "POST"));
});

test("native archive, pairing and both Bearer WebSocket protocols survive web removal", async () => {
  const f = await fixture();
  const archive = f.store.createProject({ name: "보관", cwd: f.isolated.paths.work });
  const message = f.store.createMessage({ projectId: archive.id, body: "옛 보고", kind: "완료" });
  f.store.createFile({ projectId: archive.id, title: "검색 자료", body: "보관 검색" });
  f.store.patchProject(archive.id, { archived: true });
  for (const path of ["/api/projects/archived", `/api/projects/${archive.id}/archive/state`,
    `/api/projects/${archive.id}/archive/messages/page?scope=project&limit=200`,
    `/api/projects/${archive.id}/archive/messages/page?scope=member&memberId=${f.manual.id}&limit=100`,
    `/api/projects/${archive.id}/archive/messages?around=${message.id}&limit=41`,
    `/api/projects/${archive.id}/archive/messages/${message.id}`]) await json(await f.request(path));
  await json(await f.request(`/api/projects/${archive.id}/archive/files/search?q=검색&limit=200`, "GET", undefined, v2));
  const pair = await json(await f.request("/api/pair/start", "POST"));
  await json(await f.request(`/api/pair/status?code=${pair.code}`));
  const claim = await json(await fetch(f.base + "/pair/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pair.code, device: "iPhone fixture" }) }));
  // G(C3): QR 은 그 기기만의 열쇠를 같은 칸에 준다. 출시된 앱처럼 그 값을 그대로 쓰면 REST·실시간·터미널 스트림이 모두 열린다.
  expect(claim.accessCode).not.toBe(f.config.accessCode);
  expect(String(claim.accessCode).startsWith("dk1.")).toBe(true);
  await json(await f.request("/api/pair/ack", "POST", { code: pair.code, confirmationToken: claim.confirmationToken }));
  for (const code of [f.config.accessCode, String(claim.accessCode)]) {
    for (const query of ["", "?v=2", "?v=2&lite=1"]) {
      const ws = socket(f.base.replace("http:", "ws:") + "/ws" + query, code);
      try { expect(await ws.received).toMatchObject({ type: "hello", ...(query ? { protocol: 2 } : {}) }); }
      finally { await ws.close(); }
    }
    const terminal = socket(f.base.replace("http:", "ws:") + `/api/members/${f.member.id}/terminal/stream?mode=observe&cols=100&rows=30&size=core`, code);
    try { expect(await terminal.received).toMatchObject({ type: "ready" }); }
    finally { await terminal.close(); }
  }
  for (const path of ["/ws", "/ws?v=2", "/api/bootstrap", `/api/members/${f.member.id}/terminal/stream?mode=observe`, "/files/missing/native.txt"]) {
    expect((await fetch(f.base + path + (path.includes("?") ? "&" : "?") + `t=${f.config.accessCode}`)).status).toBe(401);
  }
});

test("native push registration, preferences, test, target and revocation remain Bearer APIs", async () => {
  const f = await fixture(), id = randomUUID(), path = `/api/push/devices/${id}`;
  await json(await f.request("/api/push/status"));
  const device = await json(await f.request(path, "PUT", { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: "abcd", authorization: "authorized" }), 201);
  await json(await f.request("/api/push/devices"));
  await json(await f.request(path));
  const enabled = await json(await f.request(path, "PATCH", { expectedRevision: device.revision, enabled: true }));
  await json(await f.request(path + "/test", "POST", { requestId: randomUUID() }), 202);
  f.store.patchMember(f.member.id, { status: "error", lastError: "시험 오류" });
  const event = f.push.listEvents().find(value => value.kind === "error")!;
  expect(await json(await f.request(`/api/push/events/${event.id}/target`))).toMatchObject({ target: { screen: "team", memberId: f.member.id } });
  await json(await f.request(path, "DELETE", undefined, { "If-Match": `"${enabled.revision}"` }));
});

test("native member actions and CLI approvals keep their normal response shapes", async () => {
  const f = await fixture(), m = `/api/members/${f.member.id}`;
  const approval = await json(await f.request(m + "/approval"));
  expect(approval.approval).not.toBeNull();
  await json(await f.request(m + "/approval", "POST", { fingerprint: approval.approval.fingerprint, option: 1 }));
  for (const action of ["interrupt", "compact", "sleep", "resume"]) {
    const member = f.store.createMember({ projectId: f.project.id, handle: action, name: action, kind: "worker", backend: "core", status: action === "resume" ? "asleep" : "idle", sessionId: randomUUID(), paneId: `fake:${action}` });
    await json(await f.request(`/api/members/${member.id}/${action}`, "POST"));
  }
  await json(await f.request(`/api/members/${f.manual.id}/close`, "POST"));
});

test("moved browser server guarantees: compiled MCP, artifact kit and daemon-only restart preserve core sessions", async () => {
  const runtime = createIsolatedRuntime();
  // Read/write fake core protocol only; provider programs are never launched.
  const holders = new Map<string, { terminal: CoreTerminal }>();
  const calls: string[] = [], kills: string[] = [];
  const peers = new Set<Socket>();
  const peer = createServer(socket => {
    peers.add(socket); socket.on("close", () => peers.delete(socket)); socket.on("error", () => {}); socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk;
      while (buffered.includes("\n")) {
        const at = buffered.indexOf("\n"), request = JSON.parse(buffered.slice(0, at)); buffered = buffered.slice(at + 1);
        const params = request.params, holder = holders.get(params?.terminal);
        calls.push(request.method);
        let result: unknown;
        switch (request.method) {
          case "hello": result = { generation: 1, version: "fixture", features: [], methods: ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.keys", "terminal.kill", "terminal.interrupt"] }; break;
          case "terminal.list": result = { terminals: [...holders.values()].map(value => value.terminal).filter(value => Object.entries(params.labels ?? {}).every(([key, label]) => value.labels[key] === label)) }; break;
          case "terminal.run": {
            runtime.assertFakeExecutable(params.argv[0]); runtime.assertOwnedPath(params.cwd);
            const terminal: CoreTerminal = { address: `t${holders.size + 1}`, argv: params.argv, cwd: params.cwd, labels: params.labels, state: "live", turn: 0, status: { state: "idle" }, reported: true };
            holders.set(terminal.address, { terminal }); result = terminal; break;
          }
          case "terminal.get": result = holder?.terminal; break;
          case "terminal.read": result = { text: "› \n? for shortcuts", complete: true }; break;
          case "terminal.send": if (holder) { holder.terminal.status = { state: "working" }; result = { turn: holder.terminal.turn, started: true }; } break;
          case "terminal.keys": result = { turn: holder?.terminal.turn }; break;
          case "terminal.interrupt": if (holder) { holder.terminal.status = { state: "idle" }; result = { outcome: "stopped" }; } break;
          case "terminal.kill": if (holder) { kills.push(holder.terminal.address); holder.terminal.state = "finished"; result = holder.terminal; } break;
        }
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(result ? { result } : { error: { code: -32000, message: "Fixture terminal missing", data: { kind: "not_found" } } }) }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(runtime.socketPath, resolve); });
  const core = { holders, kills, count: (method: string) => calls.filter(value => value === method).length,
    async stop() { for (const socket of peers) socket.destroy(); await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve())); } };
  const binary = join(runtime.paths.bin, "iamceo");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const clients: Client[] = [];
  const innocent = Bun.spawn(["/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const build = Bun.spawn([process.execPath, "build", resolve(import.meta.dir, "../bin/iamceo.ts"), "--compile", "--outfile", binary], { stdout: "ignore", stderr: "pipe" });
    const diagnostic = new Response(build.stderr).text();
    expect(await build.exited, await diagnostic).toBe(0);
    updateConfigFile({ accessCode: "compiled-native-contract", hosts: ["127.0.0.1"] }, runtime.childEnv());
    const config = loadConfig(runtime.childEnv());
    let base = "";
    async function boot() {
      let output = "", errors = "";
      child = Bun.spawn([binary, "serve"], { cwd: runtime.paths.work, env: runtime.childEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const current = child;
      const drain = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
        const reader = stream.getReader(), decoder = new TextDecoder();
        try { for (;;) { const next = await reader.read(); if (next.done) break; append(decoder.decode(next.value, { stream: true })); } append(decoder.decode()); }
        finally { reader.releaseLock(); }
      };
      const stdout = drain(current.stdout as ReadableStream<Uint8Array>, text => { output += text; });
      const stderr = drain(current.stderr as ReadableStream<Uint8Array>, text => { errors += text; });
      // Drain output throughout the process lifetime, and join it after each explicit shutdown.
      const deadline = Date.now() + 10_000;
      while (!/http:\/\/127\.0\.0\.1:\d+/.test(output) && current.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
      base = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0] ?? "";
      expect(base, errors).not.toBe("");
      expect(new URL(base).port).not.toBe("7878");
      return async () => { await current.exited; await Promise.all([stdout, stderr]); };
    }
    const request = (path: string, method = "GET", body?: unknown) => fetch(base + path, { method,
      headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let drained = await boot();
    const project = await json(await request("/api/projects", "POST", { name: "컴파일 계약", cwd: runtime.paths.home, startConductor: true, chiefCli: "codex" }));
    const state = await json(await request(`/api/projects/${project.id}/state`));
    const member = state.members.find((value: { kind: string }) => value.kind === "conductor");
    expect(member).toBeDefined();
    const command = JSON.parse(readFileSync(join(runtime.paths.iamceoHome, "run", `${member.id}.mcp.json`), "utf8")).mcpServers.iamceo;
    expect(command.command).toBe(binary);
    expect(command.args).toEqual(["mcp"]);
    expect(command.env.IAMCEO_URL).toBe(base);
    expect(command.env.IAMCEO_TOKEN).toBeString();
    const client = new Client({ name: "native-contract", version: "1" }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: command.command, args: command.args,
      env: { ...runtime.childEnv(), ...command.env }, cwd: runtime.paths.work, stderr: "pipe" }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["status", "ask", "post", "file", "todo", "team_add", "roster", "work_set"]));
    expect((await client.callTool({ name: "status", arguments: { now: "컴파일 MCP 확인" } })).isError).toBeFalsy();
    await client.close();
    const joined = await json(await request("/agent/join", "POST", { project: project.id, name: "직접 브리지", role: "검증" }));
    const manualClient = new Client({ name: "manual-native-contract", version: "1" }); clients.push(manualClient);
    await manualClient.connect(new StdioClientTransport({ command: binary, args: ["mcp"],
      env: { ...runtime.childEnv(), IAMCEO_URL: base, IAMCEO_TOKEN: joined.token }, cwd: runtime.paths.work, stderr: "pipe" }));
    expect((await manualClient.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["status", "ask", "post", "file", "todo", "wait"]));
    expect((await manualClient.callTool({ name: "status", arguments: { now: "직접 MCP 확인" } })).isError).toBeFalsy();
    await manualClient.close();
    const bridged = await json(await request(`/api/projects/${project.id}/state`));
    expect(bridged.members.find((value: { id: string }) => value.id === member.id)).toMatchObject({ now: "컴파일 MCP 확인" });
    expect(bridged.members.find((value: { id: string }) => value.id === joined.member.id)).toMatchObject({ now: "직접 MCP 확인" });
    const body = '<div class="kpi">native kit</div><script>window.nativeKit=true</script>';
    const published = await request(`/api/projects/${project.id}/files/from-path`, "POST", { path: join(runtime.paths.home, "kit.html") });
    // A missing file is a server-side validation error, not a web fallback.
    expect(published.status).toBe(404);
    writeFileSync(join(runtime.paths.home, "kit.html"), body);
    const file = await json(await request(`/api/projects/${project.id}/files/from-path`, "POST", { path: join(runtime.paths.home, "kit.html") }));
    const render = await request(`/api/files/${file.id}/artifact?render=1`);
    expect(render.status).toBe(200);
    expect(render.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    const html = await render.text();
    expect(html).toContain("native kit"); expect(html).toContain(".kpi"); expect(html).toContain("window.nativeKit=true");
    const runs = core.count("terminal.run");
    const address = member.paneId;
    child!.kill("SIGHUP"); await drained();
    expect(child!.exitCode).toBe(0);
    expect(core.holders.get(address)?.terminal.state).toBe("live");
    expect(core.kills).toHaveLength(0);
    expect(innocent.exitCode).toBeNull();
    drained = await boot();
    child!.kill("SIGKILL"); await drained();
    drained = await boot();
    const recovered = await json(await request(`/api/projects/${project.id}/state`));
    expect(recovered.members.find((value: { id: string }) => value.id === member.id)).toMatchObject({ paneId: address, sessionId: member.sessionId });
    expect(core.count("terminal.run")).toBe(runs);
    expect(core.kills).toHaveLength(0);
    expect(innocent.exitCode).toBeNull();
    child!.kill("SIGTERM"); await drained();
  } finally {
    await Promise.all(clients.map(client => client.close().catch(() => {})));
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    innocent.kill("SIGTERM"); await innocent.exited;
    await core.stop(); await runtime.stop();
  }
}, 30_000);
