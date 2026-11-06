import { describe, expect, test } from "bun:test";
import { CoreSupervisor, ensureCoreServer, type CoreSupervisorDeps } from "../server/core-supervisor.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError } from "../server/runner/core-client.ts";
import type { RunnerMember, RunnerReattachResult } from "../server/runner/types.ts";

const member = (id = "worker"): RunnerMember => ({ id, projectId: "project", sessionGeneration: 1, handle: id, name: id, cwd: "/private/tmp", sessionId: null, paneId: "existing", model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker" });
function fixture(overrides: Partial<CoreSupervisorDeps> = {}) {
  let now = 0, starts = 0, reads = 0;
  let presence: Awaited<ReturnType<CoreSupervisorDeps["presence"]>> = "owned";
  let result: RunnerReattachResult = { outcome: "unknown", code: "down" };
  const supervisor = new CoreSupervisor({ now: () => now, retryMs: 10, pollMs: 10, presence: async () => presence,
    startOwned: async () => { starts++; }, reattachOwned: async () => { reads++; return result; }, ...overrides });
  return { supervisor, starts: () => starts, reads: () => reads, advance(ms = 100) { now += ms; }, presence(value: typeof presence) { presence = value; }, result(value: RunnerReattachResult) { result = value; } };
}

describe("core runtime supervisor", () => {
  test("initial bind failure recovers with no delivery queue and no CLI start", async () => {
    const f = fixture(); f.supervisor.watch(member()); await f.supervisor.tick();
    expect(f.supervisor.observations()[0]).toMatchObject({ outcome: "unknown", failures: 1, lastObservedAt: null });
    f.advance(); f.result({ outcome: "rejoined", started: { sessionId: "native", paneId: "existing", rejoined: true } }); await f.supervisor.tick();
    expect(f.reads()).toBe(2); expect(f.starts()).toBe(0);
    expect(f.supervisor.observations()[0]).toMatchObject({ outcome: "rejoined", failures: 0, lastObservedAt: 100 });
    await f.supervisor.shutdown();
  });
  test("only verified owned absence permits limited startup with backoff", async () => {
    const f = fixture(); f.supervisor.watch(member()); f.presence("unknown"); await f.supervisor.tick(); expect(f.starts()).toBe(0);
    f.presence("absent"); await f.supervisor.tick(); expect(f.starts()).toBe(1);
    await f.supervisor.tick(); expect(f.starts()).toBe(1);
    for (let i = 0; i < 8; i++) { f.advance(); await f.supervisor.tick(); }
    expect(f.starts()).toBe(3); await f.supervisor.shutdown();
  });
  test("owner conflict is observable and triggers neither start nor terminal lookup", async () => {
    const f = fixture(); f.presence("conflict"); f.supervisor.watch(member()); await f.supervisor.tick();
    expect(f.starts()).toBe(0); expect(f.reads()).toBe(0);
    expect(f.supervisor.observations()[0]).toMatchObject({ outcome: "conflict", code: "core_owner_conflict" }); await f.supervisor.shutdown();
  });
  test("concurrent ticks share one reattachment; unwatch discards its late result", async () => {
    let resolve!: (result: RunnerReattachResult) => void;
    let reads = 0;
    const f = fixture({ reattachOwned: () => { reads++; return new Promise(r => { resolve = r; }); } });
    f.supervisor.watch(member()); const a = f.supervisor.tick(), b = f.supervisor.tick(); await Bun.sleep(1);
    expect(a).toBe(b); expect(reads).toBe(1); f.supervisor.unwatch("worker");
    resolve({ outcome: "not_found", code: "missing" }); await a; expect(f.supervisor.observations()).toEqual([]); await f.supervisor.shutdown();
  });
  test("uncertain server startup is not replayed even if absence is reported again", async () => {
    let starts = 0; const f = fixture({ startOwned: async () => { starts++; throw new CoreError("timeout", "late daemon", true); } });
    f.presence("absent"); await f.supervisor.tick(); f.advance(); await f.supervisor.tick(); expect(starts).toBe(1); await f.supervisor.shutdown();
  });
  test("a new member generation rejects a late old reattachment", async () => {
    let resolve!: (result: RunnerReattachResult) => void;
    const f = fixture({ reattachOwned: () => new Promise(r => { resolve = r; }) }); f.supervisor.watch(member());
    const pending = f.supervisor.tick(); await Bun.sleep(1); f.supervisor.watch({ ...member(), sessionGeneration: 2 });
    resolve({ outcome: "rejoined", started: { sessionId: "old", paneId: "old" } }); await pending;
    expect(f.supervisor.observations()[0]).toMatchObject({ lastObservedAt: null, outcome: "unknown" }); await f.supervisor.shutdown();
  });
  test("startup rejects implicit and nonabsolute configuration before touching any endpoint", async () => {
    await expect(ensureCoreServer({})).rejects.toThrow("explicit");
    await expect(ensureCoreServer({ socketPath: "relative.sock", session: "iamceo", configDir: "/private/tmp/config", stateDir: "/private/tmp/state" })).rejects.toThrow("absolute");
  });
});

test("concurrent owned startup invokes only its fake executable once with isolated paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-supervisor-"));
  try {
    const bin = join(dir, "fake-core"), marker = join(dir, "started");
    writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$HC_SOCKET" "$HC_SESSION" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" >> "' + marker + '"\nexit 1\n'); chmodSync(bin, 0o700);
    const options = { coreBin: bin, socketPath: join(dir, "c.sock"), session: "iamceo-test", stateDir: join(dir, "state"), configDir: join(dir, "config") };
    const one = ensureCoreServer(options), two = ensureCoreServer(options); expect(one).toBe(two);
    expect((await Promise.allSettled([one, two])).every(result => result.status === "rejected")).toBe(true);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual([options.socketPath, options.session, options.stateDir, options.configDir]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a connected hello timeout never invokes the startup executable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-supervisor-")), sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("data", () => {}); });
  const path = join(dir, "c.sock"), marker = join(dir, "must-not-start"), bin = join(dir, "fake-core");
  writeFileSync(bin, '#!/bin/sh\nprintf started > "' + marker + '"\n'); chmodSync(bin, 0o700);
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    await expect(ensureCoreServer({ coreBin: bin, socketPath: path, session: "iamceo-test", stateDir: join(dir, "state"), configDir: join(dir, "config") })).rejects.toMatchObject({ kind: "timeout" });
    expect(existsSync(marker)).toBe(false);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
