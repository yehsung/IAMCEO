import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { HerdrRunner, backgroundWait, inputText, screenContextPct, transcriptTurnEnded, type HerdrDeps } from "../server/runner/herdr.ts";
import { rpc, subscribe } from "../server/runner/herdr-client.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import type { DeliveryDispatch, RunnerRecoveryState, RunnerRecoveryStore } from "../server/service-contracts.ts";
import type { DeliveryRepair, RunnerEvent, RunnerMember, StartOpts } from "../server/runner/types.ts";
import { createIsolatedRuntime, type IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const composer = (draft = "", history = "prior output") => `${history}\n${"─".repeat(40)}\n❯ ${draft}\n${"─".repeat(40)}\n`;
const marker = () => `#iamceo_${randomBytes(16).toString("base64url")}`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
interface Request { id: string; method: string; params: Record<string, any> }
interface Agent {
  pane_id: string; tab_id: string; workspace_id: string; name: string; cwd: string; agent: string;
  agent_status: "idle" | "working" | "done" | "blocked" | "unknown";
  agent_session: { value: string };
}
const fixtures: { runtime: IsolatedRuntime; server: Server; sockets: Set<Socket>; runners: HerdrRunner[] }[] = [];
async function fixture() {
  const runtime = createIsolatedRuntime();
  runtime.requireProviderHomes(runtime.providerHomes);
  const member: RunnerMember = { id: "worker", projectId: "project", handle: "worker", name: "Worker", cwd: runtime.paths.work,
    cli: "claude", sessionGeneration: 3, sessionId: "session-one", paneId: "pane-one", model: null, effort: null,
    subagentModel: null, permissionMode: "default", kind: "worker" };
  const agent: Agent = { pane_id: member.paneId!, tab_id: "tab-one", workspace_id: "workspace-one", name: member.handle,
    cwd: member.cwd, agent: "claude", agent_status: "idle", agent_session: { value: member.sessionId! } };
  const agents = [agent];
  const states = new Map<string, RunnerRecoveryState>([[member.id, { lease: null, unresolvedDispatches: [] }]]);
  const recoveryStore: RunnerRecoveryStore = {
    inputState(id) { return states.get(id) ?? { lease: null, unresolvedDispatches: [] }; },
    saveLease(lease) { states.get(lease.memberId)!.lease = lease; },
    removeLease(id) { states.get(id)!.lease = null; },
  };
  const calls: Request[] = [];
  const sockets = new Set<Socket>();
  const subscribers = new Set<Socket>();
  let screen = composer();
  let hook: ((request: Request, socket: Socket) => boolean) | null = null;
  const reply = (socket: Socket, request: Request, result: unknown) => socket.write(JSON.stringify({ id: request.id, result }) + "\n");
  const reject = (socket: Socket, request: Request, code = "timeout") => socket.write(JSON.stringify({ id: request.id, error: { code, message: "synthetic failure" } }) + "\n");
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); subscribers.delete(socket); });
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n");
        const request = JSON.parse(buffer.slice(0, at)) as Request;
        buffer = buffer.slice(at + 1);
        calls.push(request);
        if (hook?.(request, socket)) continue;
        const current = agents.find(a => a.pane_id === (request.params.target ?? request.params.pane_id)) ?? agent;
        switch (request.method) {
          case "session.snapshot": reply(socket, request, { snapshot: { protocol: 22, version: "fake", agents, panes: agents } }); break;
          case "events.subscribe": subscribers.add(socket); reply(socket, request, {}); break;
          case "agent.get": reply(socket, request, { agent: current }); break;
          case "pane.read": reply(socket, request, { read: { text: screen } }); break;
          case "pane.process_info": reply(socket, request, { process_info: { foreground_processes: [{ argv: ["fake-claude", "--mcp-config", "fake.json"] }] } }); break;
          case "agent.prompt":
            if (request.params.text.startsWith("/effort ultracode ")) screen = composer("", `${request.params.text}\nUltracode ${request.params.text.endsWith("on") ? "on" : "off"} (this session only)`);
            reply(socket, request, { type: "agent_prompted", agent: current }); break;
          case "agent.send_keys": reply(socket, request, {}); break;
          default: reply(socket, request, {});
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(runtime.herdrSocketPath, resolve));
  const runners: HerdrRunner[] = [];
  fixtures.push({ runtime, server, sockets, runners });
  const opts: StartOpts = { resume: true, projectName: "Test", systemPromptFile: join(runtime.dir, "rules.md"), mcpConfigFile: join(runtime.dir, "mcp.json") };
  const path = transcriptPath(member.cwd, member.sessionId!, runtime.paths.claudeHome);
  mkdirSync(dirname(path), { recursive: true });
  const row = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", sessionId: member.sessionId, cwd: member.cwd, uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(), message: { role: "user", content }, ...extra });
  writeFileSync(path, JSON.stringify(row("previous user input")) + "\n");
  const events: RunnerEvent[] = [];
  function runner(deps: Partial<HerdrDeps> = {}) {
    const result = new HerdrRunner({ socketPath: runtime.herdrSocketPath }, { inboxDir: join(runtime.paths.iamceoHome, "inbox"), ...runtime.providerHomes,
      resyncMs: 60_000, bgCheckMs: 60_000, settleMs: 5, promptTimeoutMs: 30, stallMs: 60_000, ...deps, recoveryStore });
    result.on(event => events.push(event));
    runners.push(result);
    return result;
  }
  function envelope(text = "new instruction", count = 1): DeliveryDispatch {
    const markers = Array.from({ length: count }, (_, i) => ({ deliveryId: `delivery-${i}`, marker: marker() }));
    const bundleMarker = `#iamceo_b_${randomBytes(16).toString("base64url")}`;
    const wireText = `${text}\n${markers.map(m => m.marker).join("\n")}\n${bundleMarker}`;
    const dispatch: DeliveryDispatch = { dispatchId: crypto.randomUUID(), memberId: member.id, projectId: member.projectId, cli: "claude", backend: "herdr", markers, bundleMarker,
      identity: { terminalId: member.paneId, sessionId: member.sessionId, sessionGeneration: member.sessionGeneration!, process: null },
      baseline: { serverEpoch: "test-epoch", inputEpoch: 0, turn: null, logs: [], capturedAt: new Date(Date.now() - 10_000).toISOString() },
      wireText, wireSha256: sha(wireText), items: markers.map((m, ordinal) => ({ deliveryId: m.deliveryId, ordinal, sourceRevision: "v1" })),
      transportState: "unknown", submitAttempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    states.get(member.id)!.unresolvedDispatches.push(dispatch);
    return dispatch;
  }
  function lease() {
    states.get(member.id)!.lease = { memberId: member.id, claimId: "claim", leaseId: "lease", expiresAt: Date.now() + 60_000, lastInputSequence: 0,
      identity: { terminalId: member.paneId, sessionId: member.sessionId, sessionGeneration: 3, process: null } };
  }
  return { runtime, member, agent, agents, opts, calls, states, recoveryStore, path, row, events, runner, envelope, lease, reply, reject, subscribers,
    status(value: Agent["agent_status"]) {
      agent.agent_status = value;
      for (const socket of subscribers) socket.write(JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: agent.pane_id, agent_status: value } }) + "\n");
    },
    append(content: unknown, extra: Record<string, unknown> = {}) { appendFileSync(path, JSON.stringify(row(content, extra)) + "\n"); },
    setScreen(value: string) { screen = value; }, setHook(value: typeof hook) { hook = value; },
    prompts() { return calls.filter(c => c.method === "agent.prompt"); }, keys() { return calls.filter(c => c.method === "agent.send_keys"); } };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await Promise.all(f.runners.map(runner => runner.shutdown()));
    for (const socket of f.sockets) socket.destroy();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    await f.runtime.stop();
  }
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe("herdr status observations", () => {
  const selection = "Choose one option\n❯ 1. First\n  2. Second\nEsc to cancel";
  const approval = "Bash command\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel";
  for (const [screen, reason] of [[approval, "permission"], [selection, "selection"], ["unrecognized dialog", "permission"], ["read_failure", "permission"]]) {
    test(`blocked ${screen} is an observed ${reason} wait`, async () => {
      const f = await fixture();
      f.agent.agent_status = "blocked";
      f.setScreen(screen!);
      if (screen === "read_failure") f.setHook((request, socket) => {
        if (request.method !== "pane.read") return false;
        f.reject(socket, request); return true;
      });
      const startedAt = Date.now();
      await f.runner().reattach(f.member);
      await waitFor(() => f.events.some(e => e.type === "status" && e.blockedReason === reason));
      const event = f.events.filter(e => e.type === "status").at(-1)!;
      expect(event).toMatchObject({ type: "status", memberId: f.member.id, status: "blocked", blockedReason: reason,
        observation: { source: "herdr", freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
      if (event.type === "status") expect(Date.parse(event.observation!.observedAt!)).toBeGreaterThanOrEqual(startedAt);
      expect(f.prompts()).toHaveLength(0); expect(f.keys()).toHaveLength(0);
    });
  }

  test("events retain unknown observations and recover the same blocked state after snapshot failure", async () => {
    const f = await fixture(); const runner = f.runner({ resyncMs: 25 });
    await runner.reattach(f.member);
    await waitFor(() => f.subscribers.size > 0);
    f.status("blocked");
    await waitFor(() => f.events.some(e => e.type === "status" && e.blockedReason === "permission"));
    const observedAt = f.events.filter(e => e.type === "status").at(-1)!;
    f.status("unknown");
    await waitFor(() => f.events.some(e => e.type === "status" && e.observation?.error?.code === "status_unknown"));
    const failed = f.events.filter(e => e.type === "status").at(-1)!;
    expect(failed).toMatchObject({ status: "blocked", blockedReason: "status_unknown", observation: { freshness: "stale", ownership: "unknown" } });
    if (observedAt.type === "status" && failed.type === "status") expect(failed.observation!.observedAt).toBe(observedAt.observation!.observedAt);
    f.setHook((request, socket) => {
      if (request.method !== "session.snapshot") return false;
      f.reject(socket, request); return true;
    });
    await waitFor(() => f.events.some(e => e.type === "status" && e.observation?.error?.code === "snapshot_failed"));
    f.agent.agent_status = "blocked";
    f.setHook(null);
    await waitFor(() => {
      const last = f.events.filter(e => e.type === "status").at(-1);
      return last?.type === "status" && last.blockedReason === "permission" && last.observation?.freshness === "fresh";
    });
    f.status("working");
    await waitFor(() => f.events.some(e => e.type === "status" && e.status === "working" && e.blockedReason === null));
    f.status("idle");
    await waitFor(() => {
      const last = f.events.filter(e => e.type === "status").at(-1);
      return last?.type === "status" && last.status === "idle" && last.observation?.freshness === "fresh";
    });
  });

  test("subscription loss invalidates blocked approval and fences delayed screen refinement", async () => {
    const f = await fixture();
    let pending: { request: Request; socket: Socket } | null = null;
    f.setHook((request, socket) => {
      if (request.method === "pane.read") { pending = { request, socket }; return true; }
      if (request.method === "session.snapshot" && pending) { f.reject(socket, request); return true; }
      return false;
    });
    const runner = f.runner();
    await runner.reattach(f.member);
    await waitFor(() => f.subscribers.size > 0);
    f.status("blocked");
    await waitFor(() => pending !== null);
    for (const socket of f.subscribers) socket.destroy();
    await waitFor(() => f.events.some(e => e.type === "status" && e.observation?.error?.code === "disconnected"));
    const last = f.events.filter(e => e.type === "status").at(-1)!;
    expect(last).toMatchObject({ status: "blocked", blockedReason: "status_unknown", observation: { freshness: "stale", ownership: "unknown" } });
    const held = pending! as { request: Request; socket: Socket };
    f.reply(held.socket, held.request, { read: { text: selection } });
    await Bun.sleep(20);
    expect(f.events.some(e => e.type === "status" && e.blockedReason === "selection")).toBe(false);
    expect(f.prompts()).toHaveLength(0); expect(f.keys()).toHaveLength(0);
  });

  test("a deferred idle report cannot clear an observation failure; a new idle signal can", async () => {
    const f = await fixture();
    await f.runner({ settleMs: 100 }).reattach(f.member);
    await waitFor(() => f.subscribers.size > 0);
    f.status("idle");
    f.status("unknown");
    await waitFor(() => f.events.some(e => e.type === "status" && e.observation?.error?.code === "status_unknown"));
    await Bun.sleep(150);
    expect(f.events.filter(e => e.type === "status").at(-1)).toMatchObject({ status: "idle", observation: { freshness: "stale" } });
    f.status("idle");
    await waitFor(() => {
      const last = f.events.filter(e => e.type === "status").at(-1);
      return last?.type === "status" && last.status === "idle" && last.observation?.freshness === "fresh";
    });
  });
});

function repairPorts(f: Fixture, dispatch: DeliveryDispatch) {
  let version = 7;
  let prepared = 0;
  return {
    deps: { quiescence: () => ({ originalWrite: "rejected" as const, externalInput: false }), submitKeyVerified: true,
      repair: {
        load: (_id: string, request: DeliveryRepair) => request.dispatchId === dispatch.dispatchId && request.expectedRecoveryVersion === version ? dispatch : null,
        prepare: (_id: string, request: DeliveryRepair) => {
          if (request.expectedRecoveryVersion !== version) return false;
          prepared++; version++; dispatch.transportState = "write_started";
          if (request.action === "submit_only") dispatch.submitAttempts++;
          return true;
        },
      } },
    request(epoch: number, action: DeliveryRepair["action"] = "resend"): DeliveryRepair { return { action, dispatchId: dispatch.dispatchId,
      expectedRecoveryVersion: 7, expectedSessionGeneration: 3, expectedSessionId: f.member.sessionId, expectedTerminalId: f.member.paneId!, expectedInputEpoch: epoch }; },
    prepared: () => prepared,
  };
}

describe("herdr RPC failure effects", () => {
  test("missing socket is not_written; post-write timeout, malformed response and close are unknown", async () => {
    const f = await fixture();
    await expect(rpc(join(f.runtime.dir, "missing.sock"), "agent.prompt", {}, 20)).rejects.toMatchObject({ deliveryEffect: "not_written" });
    for (const kind of ["timeout", "json", "closed"]) {
      f.setHook((_request, socket) => { if (kind === "json") socket.write("broken\n"); if (kind === "closed") socket.end(); return true; });
      await expect(rpc(f.runtime.herdrSocketPath, "agent.prompt", {}, 15)).rejects.toMatchObject({ deliveryEffect: "unknown" });
    }
  });
  test("only matching response IDs with result count; rejection remains explicit", async () => {
    const f = await fixture();
    f.setHook((request, socket) => { socket.write(JSON.stringify({ id: "other", result: { fake: true } }) + "\n"); f.reply(socket, request, { actual: true }); return true; });
    expect(await rpc(f.runtime.herdrSocketPath, "agent.prompt")).toEqual({ actual: true });
    f.setHook((request, socket) => { f.reject(socket, request, "agent_blocked"); return true; });
    await expect(rpc(f.runtime.herdrSocketPath, "agent.prompt")).rejects.toMatchObject({ code: "agent_blocked", deliveryEffect: "rejected" });
    f.setHook((request, socket) => { socket.write(JSON.stringify({ id: request.id }) + "\n"); return true; });
    await expect(rpc(f.runtime.herdrSocketPath, "agent.prompt")).rejects.toMatchObject({ code: "protocol", deliveryEffect: "unknown" });
  });
  test("test mode forbids all default-socket reads, writes and subscriptions before connect", async () => {
    // Deliberately non-listening: the client guard must reject before socket access.
    const { DEFAULT_SOCKET } = await import("../server/runner/herdr-client.ts");
    for (const method of ["ping", "pane.read", "agent.prompt"]) await expect(rpc(DEFAULT_SOCKET(), method)).rejects.toMatchObject({ code: "forbidden", deliveryEffect: "not_written" });
    expect(() => subscribe(DEFAULT_SOCKET(), [], { onOpen() {}, onClose() {}, onEvent() {} })).toThrow("차단");
  });
});

describe("receipt evidence and immutable envelopes", () => {
  for (const invalid of ["generic_ok", "accepted", "wrong_pane", "wrong_session"]) test(`a ${invalid} RPC result is not a verified prompt receipt`, async () => {
    const f = await fixture(); const runner = f.runner();
    f.setHook((request, socket) => {
      if (request.method !== "agent.prompt") return false;
      f.reply(socket, request, invalid === "generic_ok" ? { type: "ok" } : invalid === "accepted" ? { accepted: true } :
        { type: "agent_prompted", agent: { ...f.agent, ...(invalid === "wrong_pane" ? { pane_id: "other-pane" } : { agent_session: { value: "other-session" } }) } });
      return true;
    });
    expect(await runner.send(f.member, "new work", f.opts)).toMatchObject({ ok: false, retryable: false, deliveryEffect: "unknown" });
    expect(f.prompts()).toHaveLength(1); expect(f.keys()).toHaveLength(0);
  });
  for (const misleading of ["working", "composer", "history", "pasted", "read_failure", "assistant", "tool_result", "substring", "foreign", "sidechain", "meta"]) {
    test(`timeout: ${misleading} never proves user receipt, clears input or retries`, async () => {
      const f = await fixture(); const runner = f.runner(); await runner.reattach(f.member); const dispatch = f.envelope(); dispatch.transportState = "prepared";
      f.setHook((request, socket) => {
        if (request.method === "agent.prompt") {
          const token = dispatch.markers[0].marker;
          if (misleading === "working") f.agent.agent_status = "working";
          if (misleading === "composer") f.setScreen(composer(dispatch.wireText));
          if (misleading === "history") f.setScreen(composer("", dispatch.wireText));
          if (misleading === "pasted") f.setScreen(composer("[Pasted text #1 +20 lines]"));
          if (misleading === "assistant") f.append(token, { type: "assistant", message: { role: "assistant", content: token } });
          if (misleading === "tool_result") f.append([{ type: "tool_result", content: token }]);
          if (misleading === "substring") f.append(token + "suffix");
          if (misleading === "foreign") f.append(token, { sessionId: "other-session" });
          if (misleading === "sidechain") f.append(token, { isSidechain: true });
          if (misleading === "meta") f.append(token, { isMeta: true });
          return true; // Lost reply, never actually run a CLI.
        }
        if (misleading === "read_failure" && f.prompts().length && ["agent.get", "pane.read"].includes(request.method)) { f.reject(socket, request, "down"); return true; }
        return false;
      });
      expect(await runner.send(f.member, dispatch.wireText, f.opts)).toMatchObject({ ok: false, retryable: false, deliveryEffect: "unknown" });
      expect(await runner.send(f.member, "urgent follow-up", f.opts, true)).toMatchObject({ ok: false, reason: "busy", deliveryEffect: "not_written" });
      expect(f.prompts()).toHaveLength(1); expect(f.keys()).toHaveLength(0);
      expect(runner.isBusy(f.member.id)).toBe(true);
    });
  }
  test("late matching primary user evidence corrects receipt; partial bundles return only received IDs", async () => {
    const f = await fixture(); const runner = f.runner(); await runner.reattach(f.member); const dispatch = f.envelope("two tasks", 2); dispatch.transportState = "prepared";
    f.setHook(request => { if (request.method !== "agent.prompt") return false; f.append(dispatch.markers[0].marker); return true; });
    expect(await runner.send(f.member, dispatch.wireText, f.opts)).toMatchObject({ ok: false, deliveryEffect: "unknown" });
    let inspected = await runner.inspectDelivery(f.member, dispatch);
    expect(inspected.receivedDeliveryIds).toEqual([dispatch.markers[0].deliveryId]);
    f.append(dispatch.markers[1].marker);
    inspected = await runner.inspectDelivery(f.member, { ...dispatch, markers: dispatch.markers.slice(1) });
    expect(inspected.receivedDeliveryIds).toEqual([dispatch.markers[1].deliveryId]);
    f.append([{ type: "text", text: dispatch.bundleMarker }]);
    inspected = await runner.inspectDelivery(f.member, dispatch);
    expect(inspected.finding).toBe("received"); expect(inspected.receivedDeliveryIds).toHaveLength(2);
    expect(inspected.quiescence).toBe("unresolved"); expect(f.prompts()).toHaveLength(1);
  });
  test("timeout with full user evidence returns a log receipt without another prompt", async () => {
    const f = await fixture(); const runner = f.runner(); await runner.reattach(f.member); const dispatch = f.envelope(); dispatch.transportState = "prepared";
    f.setHook(request => { if (request.method !== "agent.prompt") return false; f.append(dispatch.bundleMarker); return true; });
    expect(await runner.send(f.member, dispatch.wireText, f.opts)).toMatchObject({ ok: true, receipt: { dispatchId: dispatch.dispatchId, source: "claude_log" } });
    expect(f.prompts()).toHaveLength(1); expect(f.keys()).toHaveLength(0);
  });
  test("same todo/source ID gets distinct 128-bit markers; legacy promptSeen rejects ambiguous IDs", async () => {
    const f = await fixture(); const runner = f.runner({ stallMs: 10 });
    expect((await runner.send(f.member, "todo notice\n#todo_same", f.opts)).ok).toBe(true);
    await Bun.sleep(25);
    expect((await runner.send(f.member, "todo notice\n#todo_same", f.opts)).ok).toBe(true);
    const markers = f.prompts().map(c => c.params.text.split("\n").at(-1));
    expect(markers[0]).toMatch(/^#iamceo_[A-Za-z0-9_-]{22}$/); expect(markers[0]).not.toBe(markers[1]);
    f.append("#todo_same"); expect(await runner.promptSeen(f.member, ["#todo_same"])).toBe(false);
    f.append(markers[0]); expect(await runner.promptSeen(f.member, [markers[0]])).toBe(true);
    expect(await runner.promptSeen(f.member, markers)).toBe(false);
  });
  test("long text retains every item and bundle marker, and content-addressed full text survives another envelope", async () => {
    const f = await fixture(); const runner = f.runner(); await runner.reattach(f.member); const first = f.envelope("long ".repeat(500), 3); first.transportState = "prepared";
    expect(await runner.send(f.member, first.wireText, f.opts)).toMatchObject({ ok: true, receipt: { dispatchId: first.dispatchId } });
    const stub = f.prompts()[0].params.text as string;
    for (const { marker } of first.markers) expect(stub).toContain(marker);
    expect(stub.endsWith(first.bundleMarker)).toBe(true);
    const inbox = join(f.runtime.paths.iamceoHome, "inbox", f.member.id);
    const files = readdirSync(inbox);
    expect(files).toEqual([`${first.wireSha256}.md`]); expect(readFileSync(join(inbox, files[0]), "utf8")).toBe(first.wireText);
    // A separate delivery with the same source ID cannot overwrite that file.
    await runner.shutdown(); f.states.get(f.member.id)!.unresolvedDispatches = [];
    const next = f.runner(); await next.reattach(f.member);
    const second = f.envelope("different ".repeat(300), 2); second.transportState = "prepared";
    expect((await next.send(f.member, second.wireText, f.opts)).ok).toBe(true);
    expect(readFileSync(join(inbox, files[0]), "utf8")).toBe(first.wireText); expect(readdirSync(inbox)).toHaveLength(2);
  });
});

describe("inspection barriers and repair", () => {
  test("only verified pre-write failure can recover before a provider log exists", async () => {
    const f = await fixture(); const dispatch = f.envelope(); unlinkSync(f.path);
    expect(await f.runner().inspectDelivery(f.member, dispatch)).toMatchObject({ finding: "unknown", quiescence: "unresolved" });
    const ports = repairPorts(f, dispatch); const runner = f.runner(ports.deps);
    const inspected = await runner.inspectDelivery(f.member, dispatch);
    expect(inspected).toMatchObject({ finding: "not_received", quiescence: "settled", evidence: [{ code: "verified_prewrite_failure" }] });
    expect((await runner.repairDelivery(f.member, ports.request(inspected.snapshot!.inputEpoch!))).ok).toBe(true);
    expect(f.prompts()).toHaveLength(1); expect(f.keys()).toHaveLength(0);
  });
  for (const transportState of ["prepared", "write_started", "unknown"] as const) test(`restart restores ${transportState} fence even for an identical urgent send`, async () => {
    const f = await fixture(); const dispatch = f.envelope(); dispatch.transportState = transportState;
    const runner = f.runner();
    expect((await runner.send(f.member, dispatch.wireText, f.opts, true)).ok).toBe(false);
    await runner.reattach(f.member);
    expect((await runner.send(f.member, dispatch.wireText, f.opts, true)).ok).toBe(false);
    expect(f.prompts()).toHaveLength(0); expect(f.keys()).toHaveLength(0); expect(runner.isBusy(f.member.id)).toBe(true);
  });
  test("lease defers before even reading the socket or provider log, survives a new runner", async () => {
    const f = await fixture(); const dispatch = f.envelope(); f.lease();
    const runner = f.runner();
    expect(await runner.inspectDelivery(f.member, dispatch)).toMatchObject({ finding: "wait", evidence: [{ code: "manual_control" }] });
    expect(await runner.send(f.member, "urgent", f.opts, true)).toMatchObject({ ok: false, deliveryEffect: "not_written" });
    expect(await runner.compact(f.member, "focus", f.opts)).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(0);
  });
  test("unknown write stays unresolved despite stable idle/empty screen; positive evidence is distinct from a drain", async () => {
    const f = await fixture(); const runner = f.runner(); const dispatch = f.envelope();
    for (let i = 0; i < 2; i++) expect(await runner.inspectDelivery(f.member, dispatch)).toMatchObject({ finding: "unknown", quiescence: "unresolved", snapshot: { composer: "empty", originalWrite: "unresolved" } });
    f.append(dispatch.bundleMarker); f.setScreen(composer(dispatch.wireText));
    expect(await runner.inspectDelivery(f.member, dispatch)).toMatchObject({ finding: "received", quiescence: "unresolved", snapshot: { composer: "matches" } });
    expect(f.keys()).toHaveLength(0);
  });
  test("resend revalidates stored hash, reviewed epoch and prepare; uses the identical envelope", async () => {
    const f = await fixture(); const dispatch = f.envelope(); const ports = repairPorts(f, dispatch); const runner = f.runner(ports.deps);
    const inspected = await runner.inspectDelivery(f.member, dispatch); expect(inspected.finding).toBe("not_received");
    const request = ports.request(inspected.snapshot!.inputEpoch!);
    expect(await runner.repairDelivery(f.member, { ...request, expectedInputEpoch: 999 })).toMatchObject({ ok: false, deliveryEffect: "not_written" });
    expect(await runner.repairDelivery(f.member, request)).toMatchObject({ ok: true, receipt: { dispatchId: dispatch.dispatchId } });
    expect(f.prompts()).toHaveLength(1); expect(f.prompts()[0].params.text).toBe(dispatch.wireText); expect(ports.prepared()).toBe(1);
    expect((await runner.repairDelivery(f.member, request)).ok).toBe(false); expect(f.prompts()).toHaveLength(1);
  });
  test("complete exact draft gets Enter once; lost key response never replays", async () => {
    const f = await fixture(); const dispatch = f.envelope(); f.setScreen(composer(dispatch.wireText));
    const ports = repairPorts(f, dispatch); const runner = f.runner({ ...ports.deps, quiescence: () => ({ originalWrite: "settled", externalInput: false }) });
    const inspected = await runner.inspectDelivery(f.member, dispatch); expect(inspected.finding).toBe("draft_only");
    const request = ports.request(inspected.snapshot!.inputEpoch!, "submit_only");
    f.setHook(request => request.method === "agent.send_keys");
    expect(await runner.repairDelivery(f.member, request)).toMatchObject({ ok: false, deliveryEffect: "unknown", retryable: false });
    expect((await runner.repairDelivery(f.member, request)).ok).toBe(false);
    expect(f.keys().map(c => c.params.keys)).toEqual([["Enter"]]); expect(f.prompts()).toHaveLength(0);
  });
  test("successful Enter still waits for primary user evidence; a second physical fence prevents repair", async () => {
    const f = await fixture(); const dispatch = f.envelope(); f.setScreen(composer(dispatch.wireText));
    const ports = repairPorts(f, dispatch); const runner = f.runner({ ...ports.deps, quiescence: () => ({ originalWrite: "settled", externalInput: false }) });
    const inspected = await runner.inspectDelivery(f.member, dispatch);
    expect(await runner.repairDelivery(f.member, ports.request(inspected.snapshot!.inputEpoch!, "submit_only"))).toMatchObject({ ok: false, deliveryEffect: "unknown" });
    expect(f.keys()).toHaveLength(1); expect(f.prompts()).toHaveLength(0);
    f.append(dispatch.bundleMarker); f.setScreen(composer());
    expect(await runner.inspectDelivery(f.member, dispatch)).toMatchObject({ finding: "received", quiescence: "settled" });
    const other = f.envelope("another unknown write");
    const secondPorts = repairPorts(f, other);
    const next = f.runner(secondPorts.deps); const nextInspection = await next.inspectDelivery(f.member, other);
    expect((await next.repairDelivery(f.member, secondPorts.request(nextInspection.snapshot!.inputEpoch!))).ok).toBe(false);
    expect(f.prompts()).toHaveLength(0);
  });
  test("a long-text stub is never a full matching composer for submit-only repair", async () => {
    const f = await fixture(); const dispatch = f.envelope("long ".repeat(600)); const ports = repairPorts(f, dispatch);
    const runner = f.runner({ ...ports.deps, quiescence: () => ({ originalWrite: "settled", externalInput: false }) });
    f.setScreen(composer(`short summary\n(full text in a file)\n${dispatch.markers[0].marker}\n${dispatch.bundleMarker}`));
    const inspected = await runner.inspectDelivery(f.member, dispatch); expect(inspected.snapshot?.composer).toBe("different");
    expect((await runner.repairDelivery(f.member, ports.request(inspected.snapshot!.inputEpoch!, "submit_only"))).ok).toBe(false);
    expect(f.keys()).toHaveLength(0);
  });
  for (const draft of ["partial", "whitespace", "placeholder", "edited", "unresolved", "external", "unsupported_key"]) {
    test(`submit repair refuses ${draft}`, async () => {
      const f = await fixture(); const dispatch = f.envelope(); const ports = repairPorts(f, dispatch);
      f.setScreen(composer(draft === "partial" ? dispatch.markers[0].marker : draft === "whitespace" ? ` ${dispatch.wireText} ` : draft === "placeholder" ? "[Pasted text #1 +8 lines]" : draft === "edited" ? dispatch.wireText.replace("instruction", "edited instruction") : dispatch.wireText));
      const runner = f.runner({ ...ports.deps, submitKeyVerified: draft !== "unsupported_key", quiescence: () => ({ originalWrite: draft === "unresolved" ? "unresolved" : "settled", externalInput: draft === "external" ? null : false }) });
      const inspected = await runner.inspectDelivery(f.member, dispatch);
      expect((await runner.repairDelivery(f.member, ports.request(inspected.snapshot!.inputEpoch!, "submit_only"))).ok).toBe(false);
      expect(f.keys()).toHaveLength(0); expect(f.prompts()).toHaveLength(0); expect(ports.prepared()).toBe(0);
    });
  }
  for (const race of ["receipt", "lease", "ownership", "version", "hash", "blocked"]) {
    test(`repair's final check refuses a concurrent ${race} change`, async () => {
      const f = await fixture(); const dispatch = f.envelope(); const ports = repairPorts(f, dispatch); const runner = f.runner(ports.deps);
      const inspected = await runner.inspectDelivery(f.member, dispatch);
      let reads = 0;
      f.setHook((request, socket) => {
        if (request.method !== "pane.read") return false;
        if (++reads !== 2) return false;
        if (race === "receipt") f.append(dispatch.bundleMarker);
        if (race === "lease") f.lease();
        if (race === "ownership") f.agent.agent_session.value = "someone-else";
        if (race === "hash") dispatch.wireSha256 = "changed";
        if (race === "blocked") f.agent.agent_status = "blocked";
        if (race === "version") ports.deps.repair.prepare = () => false;
        f.reply(socket, request, { read: { text: composer() } }); return true;
      });
      expect((await runner.repairDelivery(f.member, ports.request(inspected.snapshot!.inputEpoch!))).ok).toBe(false);
      expect(f.keys()).toHaveLength(0); expect(f.prompts()).toHaveLength(0);
    });
  }
});

describe("control and screen compatibility", () => {
  test("approval answers still verify the fingerprint and send exactly one selected key", async () => {
    const f = await fixture(); const runner = f.runner(); f.agent.agent_status = "blocked";
    f.setScreen(readFileSync(join(import.meta.dir, "fixtures/approval/bash1.ansi.txt"), "utf8"));
    const prompt = await runner.approval(f.member); expect(prompt).not.toBeNull();
    expect(await runner.answerApproval(f.member, "stale-fingerprint", 1)).toMatchObject({ ok: false, reason: "changed" });
    f.setHook((request, socket) => {
      if (request.method !== "agent.send_keys") return false;
      f.agent.agent_status = "idle"; f.setScreen(composer()); f.reply(socket, request, {}); return true;
    });
    expect(await runner.answerApproval(f.member, prompt!.fingerprint, 1)).toMatchObject({ ok: true });
    expect(f.keys().map(c => c.params.keys)).toEqual([["1"]]); expect(f.prompts()).toHaveLength(0);
  });
  test("drafts, unknown screens and blocked prompts preserve input, including urgent sends", async () => {
    const f = await fixture(); const runner = f.runner();
    for (const screen of [composer("person's draft"), "Do you want to proceed?\n❯ 1. Yes\n2. No", "shell % "]) {
      f.setScreen(screen); expect(await runner.send(f.member, "urgent", f.opts, true)).toMatchObject({ ok: false, reason: "input_busy" });
    }
    f.agent.agent_status = "blocked"; expect(await runner.send(f.member, "urgent", f.opts, true)).toMatchObject({ ok: false, reason: "blocked" });
    expect(f.prompts()).toHaveLength(0); expect(f.keys()).toHaveLength(0);
  });
  test("compact and parallel use bare control commands and preserve completion behavior", async () => {
    const f = await fixture(); const runner = f.runner();
    expect(await runner.setParallel(f.member, true, f.opts)).toEqual({ ok: true });
    expect(await runner.setParallel(f.member, false, f.opts)).toEqual({ ok: true });
    expect(await runner.compact(f.member, "keep\n tasks\t safe", f.opts)).toEqual({ ok: true });
    appendFileSync(f.path, JSON.stringify({ type: "system", subtype: "compact_boundary" }) + "\n");
    await Bun.sleep(550);
    expect(f.prompts().map(c => c.params.text)).toEqual(["/effort ultracode on", "/effort ultracode off", "/compact keep tasks safe"]);
    expect(f.events.filter(e => e.type === "compacted")).toHaveLength(1); expect(f.events.filter(e => e.type === "turn_end")).toHaveLength(0);
  });
  test("control timeout fences follow-up commands and never appends delivery markers or retries", async () => {
    const f = await fixture(); const runner = f.runner(); f.setHook(request => request.method === "agent.prompt");
    expect(await runner.compact(f.member, "focus", f.opts)).toMatchObject({ ok: false, deliveryEffect: "unknown" });
    expect((await runner.setParallel(f.member, true, f.opts)).ok).toBe(false);
    expect(f.prompts().map(c => c.params.text)).toEqual(["/compact focus"]); expect(f.keys()).toHaveLength(0);
  });
  test("a fenced worker does not stop another worker from receiving input", async () => {
    const f = await fixture(); const runner = f.runner(); f.envelope();
    const other = { ...f.member, id: "other", handle: "other", paneId: "pane-two", sessionId: "session-two" };
    f.agents.push({ ...f.agent, pane_id: other.paneId!, name: other.handle, agent_session: { value: other.sessionId! } });
    expect((await runner.send(f.member, "one", f.opts, true)).ok).toBe(false);
    expect((await runner.send(other, "two", f.opts)).ok).toBe(true);
    expect(f.prompts()).toHaveLength(1); expect(f.prompts()[0].params.target).toBe(other.paneId);
  });
  test("background and measured context parsing retain W0 screen semantics", () => {
    const screen = composer("", "✻ Waiting for 1 dynamic workflow to finish") + " ◆ Opus │ ███░░░░░░░ │ 27% │\n";
    expect(inputText(screen)).toBe(""); expect(backgroundWait(screen)).toBe("1 dynamic workflow"); expect(screenContextPct(screen)).toBe(27);
    expect(transcriptTurnEnded(JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "finished" }] } }))).toBe(true);
  });
});
