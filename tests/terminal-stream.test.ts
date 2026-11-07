import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Bus } from "../server/bus.ts";
import { Store } from "../server/store.ts";
import { CoreRunner } from "../server/runner/core.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { startServer } from "../server/http.ts";
import { terminalSize, TerminalStreams, type SocketData } from "../server/terminal-stream.ts";

const VT = "\x1bc\x1b[31mhello 터미널\x1b[0m\r\n";
const NativeWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (predicate: () => boolean) => {
  for (let n = 0; n < 250 && !predicate(); n++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
};

async function fixture() {
  const dir = mkdtempSync("/private/tmp/iamceo-terminal-test-");
  const binary = join(dir, "fake-core");
  const script = join(dir, "fake-core.ts");
  writeFileSync(script, `import { writeFileSync } from 'node:fs';
const observe = process.argv.includes('--observe');
if (!observe && !process.stdin.isTTY) { console.error(JSON.stringify({error:{kind:'usage',message:'attach needs a terminal'}})); process.exit(2); }
const initialTermios = process.env.IAMCEO_TEST_INITIAL_TERMIOS ?? '';
writeFileSync(${JSON.stringify(dir)} + '/attach-' + process.pid + '.json', JSON.stringify({pid:process.pid,observe,initialTermios,socket:process.env.HC_SOCKET,session:process.env.HC_SESSION,state:process.env.XDG_STATE_HOME,config:process.env.XDG_CONFIG_HOME}));
if (observe) process.stdout.write(${JSON.stringify(VT)});
else {
 process.stdin.resume();
 setTimeout(() => { process.stdin.setRawMode(true); process.stdout.write('PTY_READY\\r\\n'); }, 150);
 // Bun caches stdout.rows after its first write; stty reads the actual PTY grid.
 process.on('SIGWINCH',()=>{ const [rows,cols]=Bun.spawnSync(['/bin/stty','size'],{stdin:0}).stdout.toString().trim().split(/\\s+/).map(Number); process.stdout.write('SIZE:'+cols+'x'+rows+'\\r\\n'); });
 process.stdin.on('data', bytes => { if (bytes.includes(28)) { process.stdout.write('DETACHED\\r\\n'); process.exit(0); } process.stdout.write('IN:'+Buffer.from(bytes).toString('hex')+'\\r\\n'); });
}
setInterval(()=>{},1000);
`);
  // Measure before Bun initializes stdin (Bun itself resets inherited termios).
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(binary, `#!/bin/sh
if [ "$2" != "--observe" ]; then
  IAMCEO_TEST_INITIAL_TERMIOS="$(/bin/stty -a)"
  export IAMCEO_TEST_INITIAL_TERMIOS
fi
exec ${quote(process.execPath)} ${quote(script)} "$@"
`);
  chmodSync(binary, 0o755);
  const socketPath = join(dir, "core.sock");
  const terminals = new Map<string, any>();
  const peers = new Set<Socket>();
  const rpc = createServer(socket => {
    peers.add(socket); socket.on("close", () => peers.delete(socket)); socket.setEncoding("utf8");
    let text = "";
    socket.on("data", chunk => {
      text += chunk;
      while (text.includes("\n")) {
        const index = text.indexOf("\n"); const request = JSON.parse(text.slice(0, index)); text = text.slice(index + 1);
        const p = request.params;
        let result: unknown;
        switch (request.method) {
          case "hello": result = { generation: 1, version: "fake", features: [], methods: ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill", "terminal.keys"] }; break;
          case "terminal.run": {
            result = { address: `t${terminals.size+1}`, argv: p.argv, cwd: p.cwd, labels: p.labels, state: "live", cols: 200, rows: 120, turn: 0, status: { state: "idle", app: "claude-code" }, reported: true };
            terminals.set((result as any).address, result); break;
          }
          case "terminal.list": result = { terminals: [...terminals.values()].filter(t => Object.entries(p.labels || {}).every(([k,v]) => t.labels[k] === v)) }; break;
          case "terminal.get": result = terminals.get(p.terminal); break;
          case "terminal.read": result = { text: "─".repeat(30)+"\n❯ \n"+"─".repeat(30) }; break;
          case "terminal.send": case "terminal.keys": result = { turn: 0, started: true, status: "idle" }; break;
        }
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(result ? { result } : { error: { message: "not owned", data: { kind: "not_found" } } }) })+"\n");
      }
    });
  });
  await new Promise<void>(resolve => rpc.listen(socketPath, resolve));
  const config = loadConfig({ IAMCEO_HOME: join(dir, "home"), IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: socketPath, IAMCEO_CORE_BIN: binary, IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false" });
  config.hosts = ["127.0.0.1"];
  const bus = new Bus(); const db = openDb(config.dbPath); const store = new Store(db, bus);
  const runner = new CoreRunner({ socketPath, claudeBin: "/usr/bin/false", codexBin: "/usr/bin/false", contextHome: dir, claudeHome: join(dir, "claude"), codexHome: join(dir, "codex") }, { recoveryStore: store, pollMs: 60_000 });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: { claudeHome: join(dir,"claude"), codexHome: join(dir,"codex") }, timings: { healthMs: 60_000, tickMs: 60_000 } });
  const project = store.createProject({ name: "터미널", cwd: dir });
  const member = await orch.createMember(project.id, { name: "직원" });
  const server = await startServer({ config, store, bus, orch, detectHosts: () => [] });
  const origin = `http://127.0.0.1:${server.port}`;
  const sockets: WebSocket[] = [];
  const pids = () => readdirSync(dir).filter(n => /^attach-\d+\.json$/.test(n)).map(n => JSON.parse(readFileSync(join(dir,n),"utf8")));
  cleanups.push(async () => {
    sockets.forEach(ws => ws.close()); await server.stop(); await orch.shutdown();
    peers.forEach(s => s.destroy()); await new Promise<void>(resolve => rpc.close(() => resolve()));
    db.close();
    for (const { pid } of pids()) expect(alive(pid)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
  const headers = { Authorization: `Bearer ${config.accessCode}` };
  async function status(query = "mode=observe", id = member.id, authorization = true) {
    return fetch(`${origin}/api/members/${id}/terminal/stream?${query}`, { headers: authorization ? headers : {} });
  }
  function connect(query = "mode=observe", id = member.id) {
    const ws = new NativeWebSocket(`${origin.replace("http", "ws")}/api/members/${id}/terminal/stream?${query}`, { headers });
    ws.binaryType = "arraybuffer"; sockets.push(ws);
    const events: any[] = []; const output: Buffer[] = []; let closed = false;
    ws.addEventListener("message", e => { if (typeof e.data === "string") events.push(JSON.parse(e.data)); else output.push(Buffer.from(e.data)); });
    ws.addEventListener("close", () => { closed = true; });
    return { ws, events, output, get text() { return Buffer.concat(output).toString(); }, get closed() { return closed; } };
  }
  return { dir, config, store, runner, orch, server, project, member, terminals, status, connect, pids, origin, headers };
}
function alive(pid: number) { try { process.kill(pid,0); return true; } catch { return false; } }

describe("terminal stream", () => {
  test("bearer only, strict query, missing member and legacy/manual/project refusals before upgrade", async () => {
    const f = await fixture();
    expect((await f.status("mode=observe", f.member.id, false)).status).toBe(401);
    expect((await f.status(`mode=observe&t=${f.config.accessCode}`, f.member.id, false)).status).toBe(401);
    expect((await f.status(`mode=observe&t=${f.config.accessCode}`)).status).toBe(400);
    expect((await f.status("mode=observe", "missing")).status).toBe(404);
    for (const patch of [{ backend: "herdr" }, { origin: "manual" }, { paneId: null }] as const) {
      f.store.patchMember(f.member.id, patch);
      const response = await f.status(); expect(response.status).toBe(409); expect((await response.json()).code).toBe("TERMINAL_REFUSED");
      f.store.patchMember(f.member.id, { backend: "core", origin: "runner", paneId: f.member.paneId });
    }
    for (const patch of [{ archived: true }, { runnerEnabled: false }]) {
      f.store.patchProject(f.project.id, patch); expect((await f.status()).status).toBe(409);
      f.store.patchProject(f.project.id, { archived: false, runnerEnabled: true });
    }
    expect(f.pids()).toHaveLength(0);
  });
  test("same ownership validation as screen, lifecycle/runtime refusal", async () => {
    const f = await fixture(); const terminal = f.terminals.get(f.member.paneId!);
    terminal.labels["iamceo.member"] = "foreign";
    expect((await f.status()).status).toBe(409);
    terminal.labels["iamceo.member"] = f.member.id;
    f.store.patchMember(f.member.id, { paneId: "foreign-terminal" });
    expect((await f.status()).status).toBe(409);
    f.store.patchMember(f.member.id, { paneId: f.member.paneId });
    for (const field of ["closing", "starting", "reopening"]) {
      const rt = (f.orch as any).runtime(f.member.id); rt[field] = true;
      expect((await f.status()).status).toBe(409); rt[field] = false;
    }
    const journal = { operationId: crypto.randomUUID(), memberId: f.member.id, projectId: f.project.id, intent: "sleep", phase: "started", identity: { sessionGeneration: f.store.memberRevisions(f.member.id).sessionGeneration, terminalId: f.member.paneId, sessionId: f.member.sessionId, process: null }, runId: null, deliveryIds: [], baseline: null, reason: null, exitCode: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    f.store.saveLifecycleJournal(journal as any);
    expect((await f.status()).status).toBe(409);
  });
  test("observe sends ready/current grid and exact binary VT; ignores input; socket close reaps attach", async () => {
    const f = await fixture(); const stream = f.connect();
    await until(() => stream.text.includes("hello"));
    expect(stream.events[0]).toEqual({ type: "ready", mode: "observe", cols: 200, rows: 120 });
    expect(Buffer.concat(stream.output).equals(Buffer.from(VT))).toBe(true);
    stream.ws.send(Buffer.from("ignored")); stream.ws.send(JSON.stringify({type:"resize",cols:80,rows:24}));
    stream.ws.send(JSON.stringify({type:"ping"})); await until(() => stream.events.some(e => e.type === "pong"));
    const proc = f.pids()[0]; expect(proc).toMatchObject({ observe:true, socket:f.config.coreSocket, session:"iamceo", state:join(f.config.home,"core-state"), config:join(f.config.home,"core-config") });
    stream.ws.close(); await until(() => !alive(proc.pid));
  });
  test("control requires current lease; PTY input filters detach, clamps resize and renews with throttle", async () => {
    const f = await fixture();
    expect((await f.status("mode=control")).status).toBe(409);
    const lease = await f.orch.terminalControl(f.member.id, { action: "claim" });
    expect((await f.status("mode=control&lease=other")).status).toBe(409);
    const stream = f.connect(`mode=control&lease=${lease.leaseId}&cols=999&rows=1`);
    await until(() => stream.text.includes("PTY_READY"));
    expect(stream.events[0]).toMatchObject({ type:"ready",mode:"control",cols:320,rows:10,expiresAt:lease.expiresAt });
    const renew = f.orch.renewTerminalStreamLease.bind(f.orch); let renewals = 0;
    f.orch.renewTerminalStreamLease = (id, leaseId) => { renewals++; return renew(id,leaseId); };
    let invalidations = 0; const input = f.orch.terminalStreamInput.bind(f.orch);
    f.orch.terminalStreamInput = (id, write) => { invalidations++; return input(id, write); };
    stream.ws.send(Buffer.from([65,28,66])); await until(() => stream.text.includes("IN:4142"));
    stream.ws.send(Buffer.from("C")); await until(() => stream.text.includes("IN:43"));
    expect(stream.text).not.toContain("DETACHED"); expect(renewals).toBe(1); expect(invalidations).toBe(2);
    expect(stream.events.filter(e=>e.type==="lease")).toHaveLength(1);
    expect(f.store.inputState(f.member.id).lease!.expiresAt).toBeGreaterThanOrEqual(lease.expiresAt!);
    const later = Date.now() + 10_001;
    const now = spyOn(Date, "now").mockReturnValue(later);
    try {
      stream.ws.send(Buffer.from("D")); await until(() => stream.text.includes("IN:44"));
      expect(renewals).toBe(2);
      expect(f.store.inputState(f.member.id).lease!.expiresAt).toBe(later + 5 * 60_000);
      expect(f.store.inputState(f.member.id).lease!.lastInputSequence).toBe(0);
    } finally { now.mockRestore(); }
    stream.ws.send(JSON.stringify({type:"resize",cols:999,rows:999})); await until(() => stream.text.includes("SIZE:320x200"));

    await f.orch.terminalControl(f.member.id, {action:"release",leaseId:lease.leaseId});
    await until(() => stream.events.some(e=>e.type==="closed"&&e.reason==="lease_ended"));
    await until(() => f.pids().every(p=>!alive(p.pid)));
    expect(f.store.listActivity(f.member.id).filter(a=>a.text.startsWith("대표가 터미널에서 직접 입력을"))).toHaveLength(2);
  });
  test("raw PTY is configured before spawn; delayed attach sends ready only after first paint; immediate Ctrl-C/CR survive", async () => {
    const f = await fixture(), lease = await f.orch.terminalControl(f.member.id, { action: "claim" });
    const stream = f.connect(`mode=control&lease=${lease.leaseId}`);
    stream.ws.addEventListener("message", event => {
      if (typeof event.data === "string" && JSON.parse(event.data).type === "ready") stream.ws.send(Buffer.from([3,13]));
    });
    await until(() => stream.text.includes("IN:030d"));
    expect(stream.text).not.toContain("^C"); expect(stream.closed).toBe(false);
    for (const flag of ["-icanon", "-isig", "-echo", "-icrnl"]) expect(f.pids()[0].initialTermios).toContain(flag);
  });
  test("raw mode survives repeated PTY fd reuse", async () => {
    const f=await fixture(), lease=await f.orch.terminalControl(f.member.id,{action:"claim"});
    for (let attempt=0;attempt<3;attempt++) {
      const stream=f.connect(`mode=control&lease=${lease.leaseId}`);
      await until(()=>stream.text.includes("PTY_READY"));
      const proc=f.pids().find(p=>alive(p.pid));
      for (const flag of ["-icanon","-isig","-echo","-icrnl"]) expect(proc.initialTermios).toContain(flag);
      stream.ws.send(Buffer.from([3,13])); await until(()=>stream.text.includes("IN:030d"));
      stream.ws.close(); await until(()=>!alive(proc.pid));
    }
  });
  test("pre-ready input is held until delayed attach paints and bounded to 4KB", async () => {
    const f = await fixture(), lease = await f.orch.terminalControl(f.member.id, { action: "claim" });
    const manager = new TerminalStreams(f.config,f.store,f.orch); cleanups.push(() => manager.close());
    const stream = await manager.prepare(f.member.id, new URL(`http://localhost/?mode=control&lease=${lease.leaseId}`));
    const events: any[] = [], output: Buffer[] = [];
    stream.open({send:(text:string)=>events.push(JSON.parse(text)),sendBinary:(bytes:Uint8Array)=>output.push(Buffer.from(bytes)),close:()=>{},getBufferedAmount:()=>0} as unknown as ServerWebSocket<SocketData>);
    stream.message(Buffer.from([3,13])); expect(events.some(e=>e.type==="ready")).toBe(false);
    await until(()=>Buffer.concat(output).toString().includes("IN:030d"));
    await stream.close();
    const overflow = await manager.prepare(f.member.id, new URL(`http://localhost/?mode=control&lease=${lease.leaseId}`));
    overflow.open({send:(text:string)=>events.push(JSON.parse(text)),sendBinary:()=>{},close:()=>{},getBufferedAmount:()=>0} as unknown as ServerWebSocket<SocketData>);
    overflow.message(Buffer.alloc(4097,65)); await overflow.close();
    expect(events.some(e=>e.reason==="error" && e.message.includes("버퍼"))).toBe(true);
  });
  test("same current lease replaces an orphan; wrong lease cannot evict it", async () => {
    const f = await fixture(), lease = await f.orch.terminalControl(f.member.id, { action: "claim" });
    const first = f.connect(`mode=control&lease=${lease.leaseId}`); await until(()=>first.text.includes("PTY_READY"));
    const pid = f.pids()[0].pid;
    expect((await f.status("mode=control&lease=foreign")).status).toBe(409); expect(alive(pid)).toBe(true);
    const next = f.connect(`mode=control&lease=${lease.leaseId}`); await until(()=>next.text.includes("PTY_READY"));
    expect(first.events.some(e=>e.reason==="replaced")).toBe(true); expect(alive(pid)).toBe(false);
    next.ws.send(Buffer.from("OK")); await until(()=>next.text.includes("IN:4f4b"));
  });
  test("a new current claim replaces the stale control with lease_ended", async () => {
    const f=await fixture(), lease=await f.orch.terminalControl(f.member.id,{action:"claim"});
    const old=f.connect(`mode=control&lease=${lease.leaseId}`); await until(()=>old.text.includes("PTY_READY"));
    const active=f.store.inputState(f.member.id).lease!;
    f.store.saveLease({...active,expiresAt:Date.now()-1});
    const replacement=await f.orch.terminalControl(f.member.id,{action:"claim",leaseId:"another-claim"});
    const next=f.connect(`mode=control&lease=${replacement.leaseId}`); await until(()=>next.text.includes("PTY_READY"));
    expect(old.events.find(e=>e.type==="closed")?.reason).toBe("lease_ended");
  });
  test.each(["observe", "control"])("%s heartbeat pings at 15s, pong extends liveness, 30s silence reaps attach", async mode => {
    const f = await fixture(), lease = await f.orch.terminalControl(f.member.id, {action:"claim"});
    const manager = new TerminalStreams(f.config,f.store,f.orch); cleanups.push(()=>manager.close());
    const stream = await manager.prepare(f.member.id,new URL(`http://localhost/?mode=${mode}&lease=${lease.leaseId}`));
    const events: any[] = []; let pings=0;
    stream.open({send:(text:string)=>events.push(JSON.parse(text)),sendBinary:()=>{},ping:()=>pings++,close:()=>{},getBufferedAmount:()=>0} as unknown as ServerWebSocket<SocketData>);
    await until(()=>events.some(e=>e.type==="ready"));
    const base=Date.now(), now=spyOn(Date,"now");
    try {
      now.mockReturnValue(base+15_000); stream.check(); expect(pings).toBe(1); stream.pong();
      now.mockReturnValue(base+30_000); stream.check(); expect(pings).toBe(2); expect(events.some(e=>e.type==="closed")).toBe(false);
      now.mockReturnValue(base+45_000); stream.check();
      expect(events.some(e=>e.reason==="timeout")).toBe(true);
    } finally { now.mockRestore(); }
    await stream.close(); expect(f.pids().every(p=>!alive(p.pid))).toBe(true);
  });
  test.each(["paused", "lifecycle", "renew", "input", "write"])("%s failure preserves the lease and closes with refused/error, never lease_ended", async failure => {
    const f=await fixture(), lease=await f.orch.terminalControl(f.member.id,{action:"claim"});
    const stream=f.connect(`mode=control&lease=${lease.leaseId}`); await until(()=>stream.text.includes("PTY_READY"));
    if (failure==="paused") f.store.patchProject(f.project.id,{runnerEnabled:false});
    else if (failure==="lifecycle") (f.orch as any).runtime(f.member.id).closing=true;
    else if (failure==="renew") f.orch.renewTerminalStreamLease=()=>{throw new Error("disk full");};
    else if (failure==="input") f.orch.terminalStreamInput=async()=>{throw new Error("input persistence");};
    else f.orch.terminalStreamInput=async(_id,write)=>{ throw new Error("PTY closed"); };
    stream.ws.send(Buffer.from("X")); await until(()=>stream.events.some(e=>e.type==="closed"));
    expect(stream.events.find(e=>e.type==="closed").reason).toBe(["paused","lifecycle"].includes(failure)?"refused":"error");
    expect(f.store.inputState(f.member.id).lease?.leaseId).toBe(lease.leaseId);
    f.store.patchProject(f.project.id,{runnerEnabled:true}); (f.orch as any).runtime(f.member.id).closing=false;
    await f.orch.terminalControl(f.member.id,{action:"release",leaseId:lease.leaseId});
    expect(f.store.inputState(f.member.id).lease).toBeNull();
  });
  test("observers track external core size changes, control resize immediately, and detach restoration", async () => {
    const f=await fixture(), observer=f.connect(); await until(()=>observer.text.includes("hello"));
    const terminal=f.terminals.get(f.member.paneId!); terminal.cols=80; terminal.rows=24;
    await until(()=>observer.events.some(e=>e.type==="resize"&&e.cols===80&&e.rows===24));
    const lease=await f.orch.terminalControl(f.member.id,{action:"claim"});
    const control=f.connect(`mode=control&lease=${lease.leaseId}`); await until(()=>control.text.includes("PTY_READY"));
    terminal.cols=100; terminal.rows=40;
    control.ws.send(JSON.stringify({type:"resize",cols:100,rows:40}));
    await until(()=>observer.events.some(e=>e.type==="resize"&&e.cols===100&&e.rows===40));
    terminal.cols=200; terminal.rows=120; control.ws.close();
    await until(()=>observer.events.some(e=>e.type==="resize"&&e.cols===200&&e.rows===120));
    const redraw=f.connect(); await until(()=>redraw.text.includes("hello"));
    expect(redraw.events[0]).toMatchObject({cols:200,rows:120}); expect(redraw.text).toBe(VT);
  });
  test.each(["missing", "exit"])("%s attach sends no premature ready", async failure => {
    const f=await fixture();
    if (failure==="missing") f.config.coreBin=join(f.dir,"does-not-exist");
    else writeFileSync(f.config.coreBin!, "#!/bin/sh\nexit 1\n");
    const stream=f.connect(); await until(()=>stream.closed);
    expect(stream.events.some(e=>e.type==="ready")).toBe(false);
    expect(stream.events.some(e=>e.reason==="error")).toBe(true);
  });
  test.each([false,true])("expired persisted lease sequence is removed before reclaiming the same claim ID (empty cache: %s)", async emptyCache => {
    const f=await fixture(), lease=await f.orch.terminalControl(f.member.id,{action:"claim",leaseId:"stable-claim"});
    await f.orch.terminalControl(f.member.id,{action:"key",key:"esc",leaseId:lease.leaseId});
    expect(f.store.inputState(f.member.id).lease!.lastInputSequence).toBe(1);
    if (emptyCache) (f.runner as any).leases.clear();
    const now=spyOn(Date,"now").mockReturnValue(Date.now()+5*60_000+1);
    try {
      const next=await f.orch.terminalControl(f.member.id,{action:"claim",leaseId:"stable-claim"});
      expect(next.leaseId).not.toBe(lease.leaseId); expect(f.store.inputState(f.member.id).lease!.lastInputSequence).toBe(0);
    } finally { now.mockRestore(); }
  });
  test("release immediately revokes a socket and queued input across the same claim's reacquisition", async () => {
    const f = await fixture(), claimId = "persistent-claim";
    const lease = await f.orch.terminalControl(f.member.id, { action: "claim", leaseId: claimId });
    const stream = f.connect(`mode=control&lease=${lease.leaseId}`);
    await until(() => stream.text.includes("PTY_READY"));
    let pendingWrite: (() => void) | undefined;
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    f.orch.terminalStreamInput = async (_id, write) => { pendingWrite = write; await gate; write(); };
    stream.ws.send(Buffer.from("queued-before-release"));
    await until(() => !!pendingWrite);
    const manager = (f.orch as any).terminalLeaseListeners as Set<(id: string, leaseId: string) => void>;
    expect(manager.size).toBeGreaterThan(0);
    await f.orch.terminalControl(f.member.id, { action: "release", leaseId: lease.leaseId });
    const next = await f.orch.terminalControl(f.member.id, { action: "claim", leaseId: claimId });
    expect(next.leaseId).not.toBe(lease.leaseId);
    expect(f.store.inputState(f.member.id).lease!.claimId).toBe(claimId);
    // No timer/check or replacement connection is needed to revoke pending input.
    expect(pendingWrite!).toThrow("Stream closed");
    if (stream.ws.readyState === 1) stream.ws.send(Buffer.from("late-after-reclaim"));
    resume();
    await until(() => stream.events.some(e => e.reason === "lease_ended"));
    await until(() => f.pids().every(p => !alive(p.pid)));
    expect(stream.text).not.toContain(Buffer.from("queued-before-release").toString("hex"));
    expect(stream.text).not.toContain(Buffer.from("late-after-reclaim").toString("hex"));
    expect((await f.status(`mode=control&lease=${lease.leaseId}`)).status).toBe(409);
  });
  test("lease expiration and replacement stop input and close control", async () => {
    const f = await fixture(); const lease = await f.orch.terminalControl(f.member.id,{action:"claim"});
    const stream = f.connect(`mode=control&lease=${lease.leaseId}`); await until(()=>stream.text.includes("PTY_READY"));
    const active = f.store.inputState(f.member.id).lease!;
    f.store.saveLease({...active,expiresAt:Date.now()-1});
    stream.ws.send(Buffer.from("do-not-send"));
    await until(()=>stream.events.some(e=>e.reason==="lease_ended"));
    expect(stream.text).not.toContain(Buffer.from("do-not-send").toString("hex"));
    const nextLease = await f.orch.terminalControl(f.member.id,{action:"claim"});
    await until(()=>f.pids().every(p=>!alive(p.pid)));
    const replacement = f.connect(`mode=control&lease=${nextLease.leaseId}`);
    await until(()=>replacement.text.includes("PTY_READY"));
    const activeAgain = f.store.inputState(f.member.id).lease!;
    f.store.removeLease(f.member.id,activeAgain.claimId);
    f.store.saveLease({...activeAgain,claimId:"new-claim",leaseId:"new-lease"});
    await until(()=>replacement.events.some(e=>e.reason==="lease_ended"));
  });
  test("process exit sends closed/error and a fresh observe attach redraws", async () => {
    const f = await fixture(); const stream = f.connect(); await until(()=>stream.text.includes("hello"));
    process.kill(f.pids()[0].pid,"SIGTERM");
    await until(()=>stream.events.some(e=>e.type==="closed"&&e.reason==="error"));
    const next = f.connect(); await until(()=>next.text.includes("hello"));
    expect(next.text).toBe(VT);
  });
  test("observe and global limits include pending handshakes; all processes reaped on HTTP stop", async () => {
    const f = await fixture();
    for (let memberIndex=0; memberIndex<4; memberIndex++) {
      const m = memberIndex===0 ? f.member : await f.orch.createMember(f.project.id,{name:`worker${memberIndex}`});
      const streams = Array.from({length:3},()=>f.connect("mode=observe",m.id));
      await until(()=>streams.every(s=>s.text.includes("hello")));
      expect((await f.status("mode=observe",m.id)).status).toBe(429);
    }
    const m = await f.orch.createMember(f.project.id,{name:"over-limit"});
    expect((await f.status("mode=observe",m.id)).status).toBe(429);
    expect(f.pids()).toHaveLength(12);
    await f.server.stop(); expect(f.pids().every(p=>!alive(p.pid))).toBe(true);
  });
  test("orchestrator shutdown reaps control and observe without stopping core sessions", async () => {
    const f = await fixture(); const lease = await f.orch.terminalControl(f.member.id,{action:"claim"});
    const observe = f.connect(); const control = f.connect(`mode=control&lease=${lease.leaseId}`);
    await until(()=>observe.text.includes("hello")&&control.text.includes("PTY_READY"));
    await f.orch.shutdown(); expect(f.pids().every(p=>!alive(p.pid))).toBe(true);
    expect(f.terminals.get(f.member.paneId!).state).toBe("live");
  });
  test("slow client closes at 4MB and reaps its process", async () => {
    const f = await fixture(); const manager = new TerminalStreams(f.config,f.store,f.orch);
    const stream = await manager.prepare(f.member.id,new URL("http://localhost/?mode=observe"));
    const events:any[]=[]; let amount=0;
    const ws = { send:(text:string)=>events.push(JSON.parse(text)), sendBinary:()=>{}, close:()=>{}, getBufferedAmount:()=>amount } as unknown as ServerWebSocket<SocketData>;
    stream.open(ws); await until(()=>f.pids().length===1);
    amount=4*1024*1024+1; stream.output(Buffer.from("slow"));
    await until(()=>events.some(e=>e.reason==="slow_client"));
    await stream.close(); expect(f.pids().every(p=>!alive(p.pid))).toBe(true); await manager.close();
  });
  test("auth rotation closes terminal and realtime sockets", async () => {
    const f = await fixture(); const stream = f.connect(); await until(()=>stream.text.includes("hello"));
    const realtime = new NativeWebSocket(`${f.origin.replace("http","ws")}/ws?v=2`,{headers:f.headers});
    let realtimeClosed=false; realtime.onclose=()=>{realtimeClosed=true;};
    await new Promise<void>(resolve=>realtime.onopen=()=>resolve());
    const response = await fetch(`${f.origin}/api/auth/rotate`,{method:"POST",headers:f.headers}); expect(response.status).toBe(200);
    await until(()=>stream.closed&&realtimeClosed); await until(()=>f.pids().every(p=>!alive(p.pid)));
  });
  test("integer size parsing", () => {
    expect(terminalSize(-5,999)).toEqual({cols:40,rows:200});
    for (const value of ["1.2","no",NaN,Infinity]) expect(()=>terminalSize(value,24)).toThrow();
  });
});
