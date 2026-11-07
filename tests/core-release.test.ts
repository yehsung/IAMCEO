import { createServer, type Socket } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { transcriptPath } from "../server/runner/transcript";
import { randomUUID } from "node:crypto";
import { Bus } from "../server/bus";
import { loadConfig, updateConfigFile } from "../server/config";
import { openDb } from "../server/db";
import { startServer, type RunningServer } from "../server/http";
import { Orchestrator } from "../server/orchestrator";
import { CoreRunner } from "../server/runner/core";
import type { CoreTerminal } from "../server/runner/core-client";
import { Store } from "../server/store";
import type { Member, Message, MessagePage } from "../shared/types";
import type { OperationReceipt } from "../shared/operations";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime";

/** Real runner/orchestrator/SQLite/HTTP; only the generation-1 core peer is fake.
 * The peer NEVER executes argv or reads provider credentials. Used by Swift too. */
export async function createReleaseFixture() {
  const runtime = createIsolatedRuntime();
  const sockets = new Set<Socket>();
  const terminals = new Map<string, CoreTerminal>();
  const calls: { method: string; params: Record<string, any> }[] = [];
  const faults = new Map<string, ("drop" | "refuse" | "ack_idle")[]>();
  const methods = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.keys", "terminal.kill", "terminal.interrupt"];
  const peer = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { socket.destroy(); return; }
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let request;
        try { request = JSON.parse(line); } catch { socket.destroy(); return; }
        const { method, params: p = {} } = request;
        calls.push({ method, params: p });
        const fault = faults.get(method)?.shift();
        try {
          if (fault === "refuse") throw new Error("fixture ownership refusal");
          let result: unknown;
          const terminal = terminals.get(p.terminal);
          if (method === "hello") result = { generation: 1, version: "w10-fake", methods, features: [] };
          else if (method === "terminal.list") result = { terminals: [...terminals.values()] };
          else if (method === "terminal.run") {
            runtime.assertFakeExecutable(p.argv[0]); runtime.assertOwnedPath(p.cwd);
            // Validate paths without ever using the production child environment.
            if (p.env.CLAUDE_CONFIG_DIR !== runtime.paths.claudeHome || p.env.CODEX_HOME !== runtime.paths.codexHome) throw new Error("provider home escape");
            for (const flag of ["--mcp-config", "--append-system-prompt-file"]) {
              const at = p.argv.indexOf(flag); if (at >= 0) runtime.assertOwnedPath(p.argv[at + 1]);
            }
            const value: CoreTerminal = { address: `t${calls.filter(c => c.method === method).length}`, argv: p.argv, cwd: p.cwd,
              labels: p.labels, state: "live", turn: 0, status: { state: "idle" }, reported: true };
            terminals.set(value.address, value);
            if (p.labels["iamceo.cli"] === "claude") {
              const path = runtime.assertOwnedPath(transcriptPath(p.cwd, p.labels["iamceo.session"], runtime.paths.claudeHome));
              mkdirSync(dirname(path), { recursive: true });
              writeFileSync(path, JSON.stringify({ type: "system", sessionId: p.labels["iamceo.session"], cwd: p.cwd, isSidechain: false }) + "\n");
            }
            result = value;
          } else if (!terminal) throw new Error("fixture terminal absent");
          else if (method === "terminal.get") result = terminal;
          else if (method === "terminal.read") result = { text: `\n${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n`, complete: true };
          else if (method === "terminal.kill") { terminal.state = "finished"; terminal.exit_code = 137; terminal.reason = "killed"; result = terminal; }
          else if (method === "terminal.send") {
            if (terminal.status?.state !== "idle") throw new Error("fixture busy");
            result = { turn: terminal.turn, started: fault !== "ack_idle" };
            if (fault !== "ack_idle") terminal.status = { state: "working" };
          } else if (method === "terminal.keys") result = { turn: terminal.turn };
          else if (method === "terminal.interrupt") { terminal.status = { state: "idle" }; result = { outcome: "stopped" }; }
          else throw new Error("fixture method refused");
          if (fault !== "drop") socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
        } catch (error) {
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: String(error), data: { kind: "ownership" } } }) + "\n");
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(runtime.socketPath, resolve); });
  const env = { IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: runtime.socketPath,
    IAMCEO_HERDR_SOCKET: runtime.herdrSocketPath, IAMCEO_CORE_BIN: runtime.bins.coreBin,
    IAMCEO_CLAUDE_BIN: runtime.bins.claudeBin, IAMCEO_CODEX_BIN: runtime.bins.codexBin };
  updateConfigFile({ hosts: ["127.0.0.1"], accessCode: "w10-fixture-only" }, env);
  const config = loadConfig(env);
  let db = openDb(config.dbPath), bus = new Bus(), store = new Store(db, bus);
  store.patchSettings({ boardTidyHours: 0, maxConcurrentTurns: 2 });
  const project = store.createProject({ name: "W10 release", cwd: runtime.paths.work });
  let runner!: CoreRunner, orch!: Orchestrator, server: RunningServer | undefined;
  async function boot(recover: boolean) {
    runner = new CoreRunner(runtime.runnerOptions(runtime.providerHomes), { recoveryStore: store, pollMs: 20, rpcTimeoutMs: 250, sendTimeoutMs: 100 });
    orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: runtime.providerHomes,
      timings: { tickMs: 60_000, healthMs: 60_000 } });
    do { await server?.stop(); server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery }); } while (server.port === 7878);
    orch.setServerUrl(`http://127.0.0.1:${server.port}`);
    if (recover) await orch.recover();
  }
  let member!: Member;
  try { await boot(false); member = await orch.createMember(project.id, { name: "Claude", cli: "claude" }); }
  catch (error) {
    await server?.stop(); await orch?.shutdown(); db.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => peer.close(() => resolve())); await runtime.stop();
    throw error;
  }
  const info = () => ({ url: `http://127.0.0.1:${server!.port}`, token: config.accessCode, projectId: project.id, memberId: member.id,
    calls: Object.fromEntries(methods.map(method => [method, calls.filter(c => c.method === method).length])) });
  async function restart() {
    await server?.stop(); server = undefined; await orch.shutdown(); db.close();
    db = openDb(config.dbPath); bus = new Bus(); store = new Store(db, bus); await boot(true);
    return info();
  }
  let closed = false;
  async function close() {
    if (closed) return; closed = true;
    await server?.stop(); await orch.shutdown(); db.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => peer.close(() => resolve())); await runtime.stop();
  }
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(info().url + path, {
    method, redirect: "error", signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { runtime, config, project, member, calls, terminals, info, request, restart, close,
    get store() { return store; }, get orch() { return orch; }, get runner() { return runner; },
    fault(method: string, value: "drop" | "refuse" | "ack_idle") { const list = faults.get(method) ?? []; list.push(value); faults.set(method, list); } };
}

// Swift owns this subprocess and sends commands over stdin. No control route is
// mounted on the product API; all listening sockets are fixture-owned port0.
if (process.argv[2] === "--crash-write") {
  const path = process.argv[3]!, projectId = process.argv[4]!, memberId = process.argv[5]!, phase = process.argv[6]!;
  if (!path.startsWith("/private/tmp/iq-") || !["source", "intent", "committed"].includes(phase)) throw new Error("Unsafe crash fixture");
  const db = openDb(path), store = new Store(db, new Bus());
  const enqueue = store.enqueue.bind(store);
  store.enqueue = input => {
    const delivery = enqueue(input);
    if (phase === "intent") process.kill(process.pid, "SIGKILL");
    return delivery;
  };
  store.withDeliveryIntents(() => {
    const message = store.createMessage({ id: "crash-source", projectId, targetMemberId: memberId, kind: "나", mine: true, body: "atomic source", delivery: "queued" });
    if (phase === "source") process.kill(process.pid, "SIGKILL");
    return message;
  }, message => [{ projectId, memberId, kind: "user_message", text: "atomic source", refType: "message", refId: message.id }]);
  process.kill(process.pid, "SIGKILL");
} else if (process.argv[2] === "--swift-fixture") {
  const fixture = await createReleaseFixture();
  const emit = (value: unknown) => console.log("W10:" + JSON.stringify(value));
  emit(fixture.info());
  try {
    const { createInterface } = await import("node:readline");
    for await (const line of createInterface({ input: process.stdin })) {
      const command = JSON.parse(line);
      if (command.action === "restart") emit(await fixture.restart());
      else if (command.action === "drop-key") { fixture.fault("terminal.keys", "drop"); emit(fixture.info()); }
      else if (command.action === "stats") emit(fixture.info());
      else if (command.action === "stop") break;
      else throw new Error("Unknown fixture command");
    }
  } finally { await fixture.close(); }
} else {
  const { afterEach, expect, test } = await import("bun:test");
  const fixtures: Awaited<ReturnType<typeof createReleaseFixture>>[] = [];
  afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.close(); });
  async function fixture() { const result = await createReleaseFixture(); fixtures.push(result); return result; }
  const v2 = { "X-IAMCEO-Contract": "2" };
  async function json<T = any>(response: Response, status = 200): Promise<T> { expect(response.status, response.status === status ? undefined : await response.clone().text()).toBe(status); return response.json() as Promise<T>; }


  test("release: SIGKILL before/after intent commit leaves both source and outbox or neither", async () => {
    for (const phase of ["source", "intent", "committed"]) {
      const f = await fixture();
      const child = Bun.spawn([process.execPath, import.meta.path, "--crash-write", f.config.dbPath, f.project.id, f.member.id, phase], {
        env: f.runtime.childEnv(), cwd: f.runtime.paths.work, stdout: "pipe", stderr: "pipe",
      });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
      clearTimeout(deadline);
      expect({ code, stderr }).toEqual({ code: 137, stderr: "" });
      await f.restart();
      const message = f.store.getMessage("crash-source");
      const intents = f.store.listDeliveries().filter(d => d.refId === "crash-source");
      expect(Boolean(message)).toBe(phase === "committed"); expect(intents).toHaveLength(phase === "committed" ? 1 : 0);
      expect(f.info().calls["terminal.run"]).toBe(1);
    }
  });


  test("release: HTTP agent workflow keeps operation receipts, answer and all report references", async () => {
    const f = await fixture(); const lead = await f.orch.ensureConductor(f.project.id);
    const tool = (memberId: string, name: string, args: Record<string, unknown>, operationId = randomUUID()) => f.request("/agent/tool", "POST", { name, args, operationId },
      { ...v2, Authorization: `Bearer ${f.store.getMemberToken(memberId)}` });
    await json(await tool(f.member.id, "status", { now: "verifying release", next: "report" }));
    await json(await tool(f.member.id, "status", { now: "verified" }));
    expect(f.store.requireMember(f.member.id).next).toBe("report");
    for (const title of ["first source", "second source"]) await json(await tool(f.member.id, "file", { title, content: title }));
    const fileIds = f.store.listFiles(f.project.id).map(file => file.id); expect(fileIds).toHaveLength(2);
    const operationId = randomUUID(), args = { title: "release approval", detail: "review both sources", options: [{ k: "yes", label: "proceed" }] };
    const ask = await json(await tool(f.member.id, "ask", args, operationId));
    expect(await json(await tool(f.member.id, "ask", args, operationId))).toEqual(ask);
    expect(f.store.listOpenDecisions(f.project.id)).toHaveLength(1);
    const decision = f.store.listOpenDecisions(f.project.id)[0]!;
    await json(await f.request(`/api/decisions/${decision.id}/answer`, "POST", { choice: "yes", expectedVersion: decision.updatedAt }, v2));
    const answer = f.store.requireDecision(decision.id); expect(answer.choice).toBe("yes");
    await f.orch.pump(f.member.id);
    expect(f.store.requireDecision(decision.id).status).toBe("delivered");
    const reportId = randomUUID(); const reportArgs = { kind: "완료", title: "release verified", body: "both sources checked", file_ids: fileIds, decision_id: decision.id };
    const report = await json(await tool(f.member.id, "post", reportArgs, reportId));
    expect(await json(await tool(f.member.id, "post", reportArgs, reportId))).toEqual(report);
    const message = f.store.listMessages(f.project.id).find(m => m.title === "release verified")!;
    expect(message.fileId).toBe(fileIds[0]!);
    const refs = f.orch.reportReferences(f.project.id, message.id);
    expect(refs).toMatchObject({ sourceMessageId: message.id, fileIds, decisionIds: [decision.id] });
    const deliveries = f.store.listDeliveries().filter(d => d.kind === "report" && d.refId === message.id);
    expect(deliveries).toHaveLength(1); expect(deliveries[0]!.memberId).toBe(lead.id);
    for (const id of [message.id, ...fileIds]) expect(deliveries[0]!.text).toContain(id);
    await json(await tool(lead.id, "work_set", { sec: "done", title: "release acceptance", detail: "explicit completion" }));
    expect(f.store.listWork(f.project.id)[0]!.sec).toBe("done");
    await f.orch.pump(lead.id);
    expect(f.info().calls["terminal.send"]).toBe(2);
    await f.restart();
    expect(await json(await tool(f.member.id, "post", reportArgs, reportId))).toEqual(report);
    expect(f.store.listDeliveries().filter(d => d.kind === "report" && d.refId === message.id)).toHaveLength(1);
  });


  // Startup cleanup may return owner messages/answers, but must retain reports.
  // Their message references must not make them look like owner messages.
  test("release regression: a runner-disabled report intent survives restart with its source and references", async () => {
    const f = await fixture(); const lead = await f.orch.ensureConductor(f.project.id);
    f.store.patchProject(f.project.id, { runnerEnabled: false });
    const file = f.store.createFile({ projectId: f.project.id, who: f.member.name, title: "late report evidence", body: "retained" });
    const message = await f.orch.recordPost(f.member, { kind: "완료", title: "late completion", body: "completed while the runner was disabled", fileIds: [file.id] });
    const pending = f.store.listDeliveries().filter(d => d.kind === "report" && d.refId === message.id);
    expect(pending).toHaveLength(1); expect(pending[0]!.memberId).toBe(lead.id);
    expect(pending[0]!.holdReason).toBe("runner_disabled");
    const source = f.store.requireMessage(message.id);
    const references = f.orch.reportReferences(f.project.id, message.id);
    const before = f.info().calls;
    for (let i = 0; i < 2; i++) {
      await f.restart();
      expect(f.store.requireProject(f.project.id).runnerEnabled).toBe(false);
      expect(f.store.requireMessage(message.id)).toEqual(source);
      expect(f.orch.reportReferences(f.project.id, message.id)).toEqual(references);
      expect(f.store.getFile(file.id)).toEqual(file);
      expect(f.info().calls["terminal.send"]).toBe(0);
      expect(f.info().calls["terminal.run"]).toBe(before["terminal.run"]);
      expect(f.store.listDeliveries().filter(d => d.kind === "report" && d.refId === message.id)).toEqual(pending);
    }
  });

  test("release: source repair finds a message beyond the latest 500 and keeps one intent", async () => {
    const f = await fixture();
    f.store.createMessage({ id: "old-orphan", projectId: f.project.id, targetMemberId: f.member.id, kind: "나", mine: true, body: "old command", delivery: "queued" });
    f.store.transaction(() => { for (let i = 0; i < 501; i++) f.store.createMessage({ projectId: f.project.id, kind: "알림", body: `later ${i}` }); });
    const claim = { operationId: randomUUID(), expectedSessionGeneration: f.store.memberRevisions(f.member.id).sessionGeneration, claimId: randomUUID(), action: "claim" };
    await json(await f.request(`/api/members/${f.member.id}/terminal/control`, "POST", claim, v2));
    await f.restart(); await f.restart();
    expect(f.store.listDeliveries().filter(d => d.refId === "old-orphan")).toHaveLength(1);
    expect(f.info().calls["terminal.send"]).toBe(0);
  });

  test("release: lost launch ACK rejoins the same durable member after a real DB reopen", async () => {
    const f = await fixture(); f.fault("terminal.run", "drop");
    await expect(f.orch.createMember(f.project.id, { name: "Codex", cli: "codex" })).rejects.toThrow();
    const pending = f.store.listMembers(f.project.id).find(m => m.name === "Codex")!;
    expect(pending).toBeDefined(); expect(pending.paneId).toBeNull();
    const before = f.info().calls["terminal.run"];
    await f.restart();
    const recovered = f.store.requireMember(pending.id);
    expect(recovered.paneId).toBeTruthy(); expect(recovered.cli).toBe("codex");
    expect(f.info().calls["terminal.run"]).toBe(before);
    expect(f.info().calls["terminal.kill"]).toBe(0);
  });

  test("release: lease and unknown Enter survive HTTP and daemon restart without replay", async () => {
    const f = await fixture(), path = `/api/members/${f.member.id}/terminal/control`;
    const generation = f.store.memberRevisions(f.member.id).sessionGeneration;
    const claim = { operationId: randomUUID(), expectedSessionGeneration: generation, claimId: randomUUID(), action: "claim" };
    const claimed = await json<OperationReceipt>(await f.request(path, "POST", claim, v2)); expect(claimed.status).toBe("applied");
    f.fault("terminal.keys", "drop");
    const input = { ...claim, operationId: randomUUID(), action: "key", key: "enter", inputSequence: 1 };
    const unknown = await json<OperationReceipt>(await f.request(path, "POST", input, v2)); expect(unknown.status).toBe("unknown");
    await f.restart();
    expect(await json(await f.request(`/api/operations/${input.operationId}`))).toEqual(unknown);
    expect(await json(await f.request(path, "POST", input, v2))).toEqual(unknown);
    const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "held during lease" });
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(delivery.id).status).not.toBe("delivered");
    expect(f.info().calls["terminal.keys"]).toBe(1); expect(f.info().calls["terminal.send"]).toBe(0);
    expect(f.info().calls["terminal.run"]).toBe(1);
    expect(f.store.inputState(f.member.id).lease?.claimId).toBe(claim.claimId);
  });

  test("release: post-write timeout fences the next message across restart", async () => {
    const f = await fixture(); f.fault("terminal.send", "drop");
    const first = await json(await f.request(`/api/projects/${f.project.id}/messages`, "POST", { id: "release-lost", text: "first", targetMemberId: f.member.id }));
    await f.orch.pump(f.member.id);
    expect(first.id).toBe("release-lost");
    const original = f.store.listDispatches(f.member.id)[0]; expect(original).toBeDefined();
    expect(f.info().calls["terminal.send"]).toBe(1);
    await f.restart();
    await json(await f.request(`/api/projects/${f.project.id}/messages`, "POST", { id: "release-next", text: "second", targetMemberId: f.member.id }));
    await f.orch.pump(f.member.id);
    expect(f.info().calls["terminal.send"]).toBe(1); expect(f.info().calls["terminal.keys"]).toBe(0);
    expect(f.store.requireMessage("release-lost").delivery).not.toBe("delivered");
    expect(await json(await f.request("/api/messages/release-lost"))).toMatchObject({ id: first.id, body: "first" });
  });

  test("release: five real core members reserve at most two automatic turns", async () => {
    const f = await fixture(); const members = [f.member];
    for (let i = 1; i < 5; i++) members.push(await f.orch.createMember(f.project.id, { name: `worker-${i}`, cli: i % 2 ? "codex" : "claude" }));
    for (const member of members) f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "parallel work" });
    await Promise.all(members.map(m => f.orch.pump(m.id)));
    for (let i = 0; i < 100 && f.info().calls["terminal.send"]! < 2; i++) await Bun.sleep(5);
    expect(f.info().calls["terminal.send"]).toBe(2);
    for (let i = 0; i < 100 && f.store.listDeliveries().filter(d => d.status === "delivered").length < 2; i++) await Bun.sleep(5);
    expect(f.store.listDeliveries().filter(d => d.status === "delivered")).toHaveLength(2);
    expect([...f.terminals.values()].filter(t => t.status?.state === "working")).toHaveLength(2);
    await f.restart(); await Promise.all(members.map(m => f.orch.pump(m.id)));
    expect(f.info().calls["terminal.send"]).toBe(2);
    expect(f.info().calls["terminal.kill"]).toBe(0);
  });

  test("release: ACK started:false is received, never automatically replayed or treated as completion", async () => {
    const f = await fixture(); f.fault("terminal.send", "ack_idle");
    const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "accepted but not started" });
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(delivery.id).status).toBe("delivered");
    for (let i = 0; i < 3; i++) { await Bun.sleep(25); await f.orch.pump(f.member.id); }
    expect(f.info().calls["terminal.send"]).toBe(1); expect(f.info().calls["terminal.interrupt"]).toBe(0);
    expect(f.info().calls["terminal.keys"]).toBe(0);
  });

  test("release: 1,205 Unicode timestamp ties page via HTTP, cursor survives deleted boundary and restart", async () => {
    const f = await fixture(); const at = "2026-11-07T00:00:00.000Z";
    f.store.transaction(() => { for (let i = 0; i < 1205; i++) {
      const id = `${i % 2 ? "한" : "é"}-${String(i).padStart(4, "0")}`;
      f.store.createMessage({ id, projectId: f.project.id, at, kind: "진행", body: id });
    } });
    const expected = f.store.db.query<{ id: string }, [string]>("SELECT id FROM messages WHERE project_id=? ORDER BY at COLLATE BINARY, id COLLATE BINARY").all(f.project.id).map(m => m.id);
    const path = `/api/projects/${f.project.id}/messages/page`;
    let page = await json<MessagePage>(await f.request(path)); expect(page.items).toHaveLength(200);
    const pages = [page.items.map(m => m.id)];
    await f.restart();
    while (page.hasOlder) {
      page = await json<MessagePage>(await f.request(path + `?limit=100&cursor=${encodeURIComponent(page.nextCursor!)}`));
      pages.unshift(page.items.map(m => m.id));
    }
    expect(pages.flat()).toEqual(expected); expect(new Set(pages.flat()).size).toBe(1205);
    const first = await json<MessagePage>(await f.request(path));
    f.store.db.query("DELETE FROM messages WHERE id=?").run(first.items[0]!.id);
    expect((await json<MessagePage>(await f.request(path + `?cursor=${first.nextCursor}&limit=100`))).items).toHaveLength(100);
    await json(await f.request(path + "?cursor=bad"), 400);
    const legacy = await json<Message[]>(await f.request(`/api/projects/${f.project.id}/messages`)); expect(legacy).toHaveLength(200);
  });

  test("release: archive reads preserve session and never run/send; failed stop leaves project active", async () => {
    const f = await fixture(), path = `/api/projects/${f.project.id}`;
    f.fault("terminal.kill", "refuse");
    await json(await f.request(path, "PATCH", { archived: true }), 503);
    expect(f.store.requireProject(f.project.id).archived).toBe(false);
    expect(f.store.requireMember(f.member.id).sessionId).toBe(f.member.sessionId);
    // A separate healthy project demonstrates successful archive/restore.
    const p = f.store.createProject({ name: "archive readable", cwd: f.runtime.paths.work });
    const manual = f.store.createMember({ projectId: p.id, handle: "manual", name: "manual", kind: "worker", origin: "manual" });
    f.store.createMessage({ projectId: p.id, memberId: manual.id, body: "history", kind: "진행" });
    const before = f.info().calls;
    await json(await f.request(`/api/projects/${p.id}`, "PATCH", { archived: true }));
    await json(await f.request(`/api/projects/${p.id}/state`), 404);
    expect(await json(await f.request(`/api/projects/${p.id}/archive/state`))).toMatchObject({ project: { id: p.id, archived: true } });
    expect((await json<MessagePage>(await f.request(`/api/projects/${p.id}/archive/messages/page`))).items).toHaveLength(1);
    await json(await f.request(`/api/projects/${p.id}`, "PATCH", { name: "renamed", archived: false }));
    expect(f.info().calls["terminal.run"]).toBe(before["terminal.run"]); expect(f.info().calls["terminal.send"]).toBe(before["terminal.send"]);
    await json(await f.request("/api/projects/hq", "PATCH", { archived: true }), 400);
  });
}
