import { afterEach, expect, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { CoreError, coreRpc, type CoreTerminal } from "../server/runner/core-client";
import { createIsolatedRuntime, type IsolatedRuntime, type ProviderHomes } from "./fixtures/isolated-runtime";
import { startBrowserCore } from "./fixtures/core-browser-harness";

const runtimes: IsolatedRuntime[] = [];
const cores: Awaited<ReturnType<typeof startBrowserCore>>[] = [];
function runtime() { const result = createIsolatedRuntime(); runtimes.push(result); return result; }
async function fixture(providerTurns = false) {
  const f = runtime(); const core = await startBrowserCore({ runtime: f, providerTurns }); cores.push(core);
  return { f, core };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Fixture observation timed out"); await Bun.sleep(2); }
}
async function launch(f: IsolatedRuntime, core: Awaited<ReturnType<typeof startBrowserCore>>, extra = {}) {
  return coreRpc<CoreTerminal>(core.socketPath, "terminal.run", { argv: [f.bins.claudeBin], cwd: f.paths.work, labels: { "iamceo.member": "one" }, env: f.childEnv(), ...extra }, 500);
}
afterEach(async () => {
  for (const core of cores.splice(0)) await core.stop();
  for (const f of runtimes.splice(0)) await f.stop();
});

test("explicit provider homes and fake executables are required without changing the parent environment", () => {
  const before = { ...process.env }; const f = runtime();
  expect(f.runnerOptions(f.providerHomes)).toMatchObject({ ...f.providerHomes, socketPath: f.socketPath, claudeBin: f.bins.claudeBin, codexBin: f.bins.codexBin });
  expect(() => f.runnerOptions(undefined as unknown as ProviderHomes)).toThrow("Explicit provider homes");
  expect(() => f.runnerOptions({ claudeHome: f.paths.claudeHome } as ProviderHomes)).toThrow("Explicit fixture-owned");
  expect(() => f.runnerOptions({ ...f.providerHomes, codexHome: "/outside-fixture" })).toThrow("outside");
  expect(() => f.assertFakeExecutable("claude")).toThrow("fake executables");
  expect(() => f.assertFakeExecutable(process.execPath)).toThrow("fake executables");
  expect(process.env).toEqual(before);
});

test("child environment uses an allowlist and refuses home, socket, executable, PATH, and port escapes", () => {
  const f = runtime(); const env = f.childEnv();
  expect(env.HOME).toBe(f.paths.home); expect(env.CODEX_HOME).toBe(f.paths.codexHome); expect(env.CLAUDE_CONFIG_DIR).toBe(f.paths.claudeHome);
  expect(env.HERDR_SOCKET_PATH).toBeUndefined(); expect(env.HC_SOCKET).toBeUndefined(); expect(env.ANTHROPIC_API_KEY).toBeUndefined(); expect(env.OPENAI_API_KEY).toBeUndefined();
  for (const key of ["HOME", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "IAMCEO_CORE_BIN", "IAMCEO_HERDR_SOCKET", "IAMCEO_CORE_SOCKET", "IAMCEO_PORT", "HERDR_SOCKET_PATH", "HC_SOCKET", "NODE_OPTIONS", "BUN_OPTIONS", "OPENAI_API_KEY"]) {
    expect(() => f.childEnv({ [key]: "outside" })).toThrow();
  }
  expect(() => f.childEnv({ FAKE_CLAUDE_SCRIPT: "/outside-script" })).toThrow();
});

test("path ownership rejects traversal, relative paths, cross-fixture sockets and symlinks", () => {
  const a = runtime(); const b = runtime();
  expect(() => a.assertOwnedPath(b.socketPath)).toThrow("outside");
  expect(() => a.assertOwnedPath(join(a.dir, "..", "other.sock"))).toThrow("outside");
  expect(() => a.assertOwnedPath("c.sock")).toThrow("absolute");
  symlinkSync(b.paths.work, join(a.dir, "alias"));
  expect(() => a.assertOwnedPath(join(a.dir, "alias", "new.sock"))).toThrow("symlinks");
  expect(() => a.assertOwnedPath(`${a.dir}/alias/../escape`)).toThrow("traversal");
});

test("port0 peers use distinct non-live ports and reject foreign origins before networking", async () => {
  const a = runtime(); const b = runtime();
  const first = a.serve(() => new Response("one")); const second = b.serve(() => new Response("two"));
  expect(first.port).not.toBe(7878); expect(first.port).not.toBe(0); expect(first.port).not.toBe(second.port);
  expect(await (await fetch(a.assertURL(first.url))).text()).toBe("one");
  for (const url of ["http://127.0.0.1:7878", "http://localhost:7878", second.url, "https://example.invalid", `http://secret@127.0.0.1:${first.port}`]) expect(() => a.assertURL(url)).toThrow("fixture");
  expect(() => a.childEnv({ IAMCEO_URL: "http://127.0.0.1:7878" })).toThrow();
});

test("fallback binaries fail closed and only fixture children are stopped", async () => {
  const f = runtime();
  for (const bin of [f.bins.coreBin, f.bins.codexBin, f.bins.herdrBin]) {
    const child = f.spawnFake([bin], { cwd: f.paths.work }); child.stdin.end();
    expect(await child.exited).toBe(97);
  }
  expect(() => f.spawnFake(["/bin/sh", "-c", "exit 0"], { cwd: f.paths.work })).toThrow("fake executables");
  expect(() => f.spawnFake([f.bins.claudeBin, "--session-id", "../../escape"], { cwd: f.paths.work })).toThrow("session id");
  expect(() => f.spawnFake([f.bins.claudeBin, "--mcp-config", "/outside-config"], { cwd: f.paths.work })).toThrow("outside");
  const child = f.spawnFake([f.bins.claudeBin, "--session-id", "owned", "-p"], { cwd: f.paths.work, env: { FAKE_CLAUDE_DIRECTIVES: "@fake:hang" } });
  child.stdin.write("fixture prompt"); child.stdin.end();
  await until(() => existsSync(join(f.paths.sessions, "owned.txt")));
  const first = f.stop(); expect(f.stop()).toBe(first); await first;
  expect(await child.exited).not.toBe(0); expect(existsSync(f.dir)).toBe(false);
  expect(() => f.childEnv()).toThrow("stopped");
});

test("core counts effects, filters labels, and observes kill only for its own terminal", async () => {
  const { f, core } = await fixture(); const terminal = await launch(f, core);
  expect((await coreRpc<{ terminals: CoreTerminal[] }>(core.socketPath, "terminal.list", { labels: { "iamceo.member": "other" } })).terminals).toEqual([]);
  await expect(coreRpc(core.socketPath, "terminal.kill", { terminal: "foreign" })).rejects.toMatchObject({ kind: "not_found" });
  expect(core.kills).toHaveLength(0);
  await coreRpc(core.socketPath, "terminal.kill", { terminal: terminal.address });
  expect(core.count("terminal.run")).toBe(1); expect(core.count("terminal.kill")).toBe(2);
  expect(core.kills.map((kill) => kill.terminal)).toEqual([terminal.address]);
  expect(core.holders.get(terminal.address)?.terminal).toMatchObject({ state: "finished", reason: "killed", exit_code: 137 });
});

test("core refuses arbitrary executables, cwd and inherited provider credentials", async () => {
  const { f, core } = await fixture();
  for (const extra of [{ argv: ["claude"] }, { cwd: "/outside" }, { env: { OPENAI_API_KEY: "canary" } }, { env: { HERDR_SOCKET_PATH: "/outside.sock" } }]) {
    await expect(launch(f, core, extra)).rejects.toMatchObject({ kind: "fixture_refused", uncertain: false });
  }
  expect(core.holders.size).toBe(0); expect(core.kills).toHaveLength(0);
});

test("lost launch response leaves exactly one reattachable holder", async () => {
  const { f, core } = await fixture(); core.faultNext("terminal.run", { dropResponse: true });
  await expect(coreRpc(core.socketPath, "terminal.run", { argv: [f.bins.claudeBin], cwd: f.paths.work, labels: { member: "stable" }, env: f.childEnv() }, 30)).rejects.toMatchObject({ kind: "timeout", uncertain: true });
  const result = await coreRpc<{ terminals: CoreTerminal[] }>(core.socketPath, "terminal.list", { labels: { member: "stable" } });
  expect(result.terminals).toHaveLength(1); expect(core.count("terminal.run")).toBe(1);
  expect(core.calls[0]).toMatchObject({ applied: true, replied: false });
});

test("lost send response applies once without implicit send or Enter replay", async () => {
  const { f, core } = await fixture(); const terminal = await launch(f, core);
  core.faultNext("terminal.send", { dropResponse: true });
  await expect(coreRpc(core.socketPath, "terminal.send", { terminal: terminal.address, text: "once", if: "idle" }, 30)).rejects.toBeInstanceOf(CoreError);
  expect(core.holders.get(terminal.address)?.terminal.status?.state).toBe("working");
  expect(core.count("terminal.send")).toBe(1); expect(core.count("terminal.keys")).toBe(0);
});

test("late original write can execute after its caller times out", async () => {
  const { f, core } = await fixture(); const terminal = await launch(f, core);
  core.faultNext("terminal.send", { applyDelayMs: 70 });
  await expect(coreRpc(core.socketPath, "terminal.send", { terminal: terminal.address, text: "late" }, 20)).rejects.toMatchObject({ uncertain: true });
  expect(core.holders.get(terminal.address)?.terminal.status?.state).toBe("idle");
  await until(() => core.calls.find((call) => call.method === "terminal.send")?.applied === true);
  expect(core.holders.get(terminal.address)?.terminal.status?.state).toBe("working");
  expect(core.count("terminal.send")).toBe(1);
});

test("held observations release in reverse order with immutable stale snapshots", async () => {
  const { f, core } = await fixture(); const terminal = await launch(f, core);
  const live = core.holders.get(terminal.address)!.terminal;
  live.turn = 8; live.status = { state: "working" };
  core.faultNext("terminal.get", { holdResponse: true });
  const order: number[] = [];
  const older = coreRpc<CoreTerminal>(core.socketPath, "terminal.get", { terminal: terminal.address }, 1500).then((value) => { order.push(value.turn!); return value; });
  await until(() => core.count("terminal.get") === 1);
  live.turn = 9; live.status = { state: "idle" };
  core.faultNext("terminal.get", { holdResponse: true });
  const newer = coreRpc<CoreTerminal>(core.socketPath, "terminal.get", { terminal: terminal.address }, 1500).then((value) => { order.push(value.turn!); return value; });
  await until(() => core.count("terminal.get") === 2);
  core.releaseReplies("reverse");
  expect((await newer).turn).toBe(9); expect((await older).turn).toBe(8); expect(order).toEqual([9, 8]);
});

test("delayed replies and explicit refusal differ from a lost applied mutation", async () => {
  const { f, core } = await fixture(); const terminal = await launch(f, core);
  core.faultNext("terminal.get", { delayMs: 25 });
  expect(await coreRpc(core.socketPath, "terminal.get", { terminal: terminal.address }, 500)).toMatchObject({ address: terminal.address });
  core.faultNext("terminal.kill", { error: { kind: "ownership", message: "changed holder" } });
  await expect(coreRpc(core.socketPath, "terminal.kill", { terminal: terminal.address })).rejects.toMatchObject({ kind: "ownership", uncertain: false });
  expect(core.kills).toHaveLength(0); expect(core.holders.get(terminal.address)?.terminal.state).toBe("live");
});

test("occupied fixture socket is refused and malformed RPC cannot crash the peer", async () => {
  const { core, f } = await fixture();
  await expect(startBrowserCore({ runtime: f, providerTurns: false })).rejects.toThrow("occupied");
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.once("close", resolve); socket.connect(core.socketPath, () => socket.end("bad json\n")); });
  expect(await coreRpc(core.socketPath, "hello")).toMatchObject({ generation: 1 });
});

test("fake provider turns post only to the fixture-owned HTTP peer", async () => {
  const { f, core } = await fixture(true); const posts: unknown[] = [];
  const peer = f.serve(async (request) => { posts.push(await request.json()); return Response.json({ text: "ok" }); });
  const config = join(f.dir, "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { iamceo: { env: { IAMCEO_URL: peer.url, IAMCEO_TOKEN: "fixture-token" } } } }));
  const terminal = await launch(f, core, { argv: [f.bins.claudeBin, "--session-id", "fixture-session", "--mcp-config", config] });
  await coreRpc(core.socketPath, "terminal.send", { terminal: terminal.address, text: "hello" });
  await until(() => core.holders.get(terminal.address)?.terminal.turn === 1);
  expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ name: "post" });
  expect(core.holders.get(terminal.address)?.terminal.status?.state).toBe("idle");
});

test("fake provider fetch refuses redirects to another fixture", async () => {
  const f = runtime(); const other = runtime(); let foreignCalls = 0;
  const destination = other.serve(() => { foreignCalls++; return Response.json({ text: "escaped" }); });
  const redirect = f.serve(() => Response.redirect(`${destination.url}/agent/tool`, 307));
  const config = join(f.dir, "redirect.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { iamceo: { env: { IAMCEO_URL: redirect.url, IAMCEO_TOKEN: "fixture-only" } } } }));
  const child = f.spawnFake([f.bins.claudeBin, "--session-id", "redirect-test", "--mcp-config", config, "-p"], { cwd: f.paths.work, env: { FAKE_CLAUDE_DIRECTIVES: "@fake:post=hello" } });
  child.stdin.write("redirect fixture"); child.stdin.end();
  const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0); expect(foreignCalls).toBe(0);
});

test("stopping a peer cancels delayed effects and leaves the other fixture usable", async () => {
  const first = await fixture(); const second = await fixture();
  const terminal = await launch(first.f, first.core);
  first.core.faultNext("terminal.kill", { applyDelayMs: 80 });
  const request = coreRpc(first.core.socketPath, "terminal.kill", { terminal: terminal.address }, 500).catch((error) => error);
  await until(() => first.core.count("terminal.kill") === 1);
  const stopping = first.core.stop(); expect(first.core.stop()).toBe(stopping); await stopping;
  expect(await request).toBeInstanceOf(CoreError);
  await Bun.sleep(90); expect(first.core.kills).toHaveLength(0);
  expect(await coreRpc(second.core.socketPath, "hello")).toMatchObject({ generation: 1 });
});
