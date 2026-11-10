import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
const original = fs.openSync;
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { Orchestrator, type OrchestratorTimings } from "../server/orchestrator.ts";
import type { Backend, Member, WsEvent } from "../shared/types.ts";
import type { Runner, RunnerEvent, RunnerMember, RunnerStartResult, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { createCrashGuard } from "../server/crash-guard.ts";
import { readVitals, vitalsLine } from "../server/vitals.ts";
import { CoreError } from "../server/runner/core-client.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(what: string, condition: () => boolean) {
  for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5);
  if (!condition()) throw new Error(`시간 초과: ${what}`);
}
function gate<T = void>() {
  let open!: (value: T) => void;
  const wait = new Promise<T>(resolve => { open = resolve; });
  return { wait, open };
}

/** 소켓 없이 core 실행기의 계약만 흉내 낸다. 시험이 결과와 시점을 정한다. */
class FakeCore implements Runner {
  readonly kind = "core" as const;
  callback: (e: RunnerEvent) => void = () => {};
  sent: { memberId: string; text: string; urgent: boolean }[] = [];
  starts: { memberId: string; resume: boolean; sessionId: string | null }[] = [];
  stops = 0;
  busy = new Set<string>();
  availableImpl: () => Promise<{ ok: boolean; detail?: string }> = async () => ({ ok: true });
  sendImpl: (m: RunnerMember, text: string) => Promise<SendResult> = async () => ({ ok: true, started: true, turn: 1 });
  startImpl: (m: RunnerMember, resume: boolean) => Promise<RunnerStartResult> = async m => ({ sessionId: m.sessionId ?? `s-${m.id}`, paneId: `t-${m.id}-${this.starts.length}` });
  available() { return this.availableImpl(); }
  async start(m: RunnerMember, opts: { resume: boolean }): Promise<RunnerStartResult> { this.starts.push({ memberId: m.id, resume: opts.resume, sessionId: m.sessionId }); return this.startImpl(m, opts.resume); }
  async send(m: RunnerMember, text: string, _opts: unknown, urgent = false): Promise<SendResult> {
    this.sent.push({ memberId: m.id, text, urgent });
    const result = await this.sendImpl(m, text);
    if (result.ok) this.busy.add(m.id);
    return result;
  }
  async compact(): Promise<SendResult> { return { ok: true, started: false }; }
  isBusy(id: string) { return this.busy.has(id); }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop() { this.stops++; }
  async screen() { return ""; }
  on(callback: (e: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
}

function fixture(timings: Partial<OrchestratorTimings> = {}, env: Record<string, string> = {}) {
  const runtime = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: runtime.socketPath, IAMCEO_CORE_BIN: runtime.bins.coreBin, IAMCEO_CLAUDE_BIN: runtime.bins.claudeBin, IAMCEO_CODEX_BIN: runtime.bins.codexBin, ...env });
  const bus = new Bus(), events: WsEvent[] = [];
  bus.subscribe(event => events.push(event));
  const db = openDb(config.dbPath), store = new Store(db, bus);
  store.patchSettings({ boardTidyHours: 0 });
  const fake = new FakeCore();
  const project = store.createProject({ name: "안정성", cwd: runtime.paths.work, runnerEnabled: true });
  let count = 0;
  const worker = (extra: Partial<Parameters<Store["createMember"]>[0]> = {}): Member => { count++; return store.createMember({ projectId: project.id, handle: `w${count}`, name: `직원${count}`, kind: "worker", origin: "runner", backend: "core", status: "idle", paneId: `pane${count}`, sessionId: `session${count}`, ...extra }); };
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", fake]]), providerHomes: runtime.providerHomes,
    timings: { tickMs: 60_000, healthMs: 60_000, retryMs: 5, inputBusyRetryMs: 5, ...timings } });
  const say = (member: Member, text = "[대표] 안녕하세요", extra: Partial<Parameters<Store["enqueue"]>[0]> = {}) => store.enqueue({ projectId: project.id, memberId: member.id, kind: "user_message", text, ...extra });
  const emit = async (e: RunnerEvent) => { fake.callback(e); await Bun.sleep(2); };
  const status = (member: Member, state: "idle" | "working" | "gone", extra: Partial<Extract<RunnerEvent, { type: "status" }>> = {}): RunnerEvent => ({ type: "status", memberId: member.id, status: state, terminalId: store.requireMember(member.id).paneId,
    observation: { source: "core", observedAt: new Date().toISOString(), freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null }, ...extra });
  let closed = false;
  const shutdown = async () => { if (!closed) { closed = true; await orch.shutdown(); } };
  cleanups.push(async () => { await shutdown(); db.close(); await runtime.stop(); });
  const internals = orch as unknown as { probeHealth(): Promise<void>; onTick(): void };
  return { runtime, config, db, bus, events, store, fake, orch, project, worker, say, emit, status, shutdown, probeHealth: () => internals.probeHealth(), tick: () => internals.onTick() };
}

describe("perf-4: 화면 요청은 실행기 정리와 느린 조회를 기다리지 않는다", () => {
  test("실행기가 답하지 않아도 연결 확인과 진단은 상한 안에 마지막으로 아는 상태로 끝난다", async () => {
    const f = fixture({ screenWaitMs: 20 });
    await f.orch.refreshConnection();
    expect((await f.orch.runtimeInfo()).core.available).toBe(true);
    const held = gate<{ ok: boolean; detail?: string }>();
    let asked = 0;
    f.fake.availableImpl = () => { asked++; return held.wait; };
    const before = performance.now();
    await f.orch.refreshHealth();
    const info = await f.orch.runtimeInfo();
    expect(performance.now() - before).toBeLessThan(1000);
    // 답이 없으면 마지막으로 아는 상태다. 겹친 요청은 실행기에 한 번만 묻는다.
    expect(info.core.available).toBe(true);
    await Promise.all([f.orch.runtimeInfo(), f.orch.runtimeInfo()]);
    expect(asked).toBe(2); // 연결 점검 1번 + 진단 1번(겹친 진단은 합쳐진다)
    held.open({ ok: false, detail: "내려감" });
    await f.orch.refreshConnection();
    expect((await f.orch.runtimeInfo()).core).toMatchObject({ available: false, detail: "내려감" });
  });

  test("연결 상태가 정해지면 뒤따르는 정리가 끝나기 전에 돌아온다", async () => {
    const f = fixture({ screenWaitMs: 5_000 });
    const held = gate();
    const internals = f.orch as unknown as { recoverStops(): Promise<void> };
    const original = internals.recoverStops.bind(f.orch);
    internals.recoverStops = async () => { await held.wait; return original(); };
    f.fake.availableImpl = async () => ({ ok: false, detail: "core 꺼짐" });
    const before = performance.now();
    await f.orch.refreshHealth();
    expect(performance.now() - before).toBeLessThan(1000);
    expect(f.store.getProject(f.project.id)!.connection).toMatchObject({ ok: false, reason: "backend_down" });
    held.open();
    await f.orch.refreshConnection();
  });

  test("실행 파일이 그대로면 버전은 한 번만 묻는다", async () => {
    const runtime = createIsolatedRuntime();
    cleanups.push(() => runtime.stop());
    const log = join(runtime.dir, "version-calls"), bin = join(runtime.paths.bin, "versioned-core");
    writeFileSync(bin, `#!/bin/sh\nprintf 'x\\n' >> '${log}'\nprintf 'herdr-core 9.9.9\\n'\n`);
    chmodSync(bin, 0o700);
    const config = loadConfig({ IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: runtime.socketPath, IAMCEO_CORE_BIN: bin, IAMCEO_CLAUDE_BIN: runtime.bins.claudeBin, IAMCEO_CODEX_BIN: runtime.bins.codexBin });
    const db = openDb(config.dbPath), store = new Store(db, new Bus());
    const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", new FakeCore()]]), providerHomes: runtime.providerHomes, timings: { tickMs: 60_000, healthMs: 60_000 } });
    cleanups.push(async () => { await orch.shutdown(); db.close(); });
    const results = await Promise.all([orch.runtimeInfo(), orch.runtimeInfo(), orch.runtimeInfo()]);
    for (let i = 0; i < 5; i++) results.push(await orch.runtimeInfo());
    expect(results.every(r => r.core.version === "herdr-core 9.9.9")).toBe(true);
    expect(existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0).toBe(1);
  });
});

describe("orch-b-2: 띄우자마자 끝나는 세션을 끝없이 다시 띄우지 않는다", () => {
  test("세 번 이어지면 자동으로 깨우기를 멈추고 한 번 알린다. 대표가 직접 깨우면 다시 시도한다", async () => {
    const f = fixture({ quickExitMs: 60_000, quickExitRetryMs: 60_000 }), w = f.worker({ status: "asleep", paneId: null });
    f.fake.sendImpl = async () => ({ ok: false, reason: "gone", retryable: false, deliveryEffect: "not_written", detail: "terminal exited" });
    const d = f.say(w);
    const notices = () => f.store.listMessages(f.project.id).filter(m => m.body.includes("시작하자마자 끝나기를 되풀이"));
    for (let i = 1; i <= 3; i++) {
      await f.orch.pump(w.id);
      expect(f.fake.starts).toHaveLength(i);
      await f.emit(f.status(w, "gone", { exit: { reason: "exited", exitCode: 1 } }));
      expect(f.store.requireMember(w.id).status).toBe("offline");
    }
    expect(notices()).toHaveLength(0);
    for (let i = 0; i < 3; i++) await f.orch.pump(w.id);
    expect(f.fake.starts).toHaveLength(3);
    expect(notices()).toHaveLength(1);
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "held", holdReason: "offline" });
    f.fake.sendImpl = async () => ({ ok: true, started: true, turn: 1 });
    await f.orch.resumeMember(w.id);
    expect(f.fake.starts).toHaveLength(4);
    expect(f.store.requireDelivery(d.id).status).toBe("delivered");
  });

  test("정상으로 턴을 마친 세션의 종료는 세지 않는다", async () => {
    const f = fixture({ quickExitMs: 60_000, quickExitRetryMs: 60_000 }), w = f.worker({ status: "asleep", paneId: null });
    for (let i = 1; i <= 4; i++) {
      const d = f.say(w, `[대표] ${i}번째`);
      await f.orch.pump(w.id);
      expect(f.fake.starts).toHaveLength(i);
      expect(f.store.requireDelivery(d.id).status).toBe("delivered");
      f.fake.busy.delete(w.id);
      await f.emit({ type: "turn_end", memberId: w.id, finalText: "끝", isError: false, terminalId: f.store.requireMember(w.id).paneId });
      // 턴 끝 뒤 서버가 넣는 보고 보완 요청이 나갔을 수 있다. 그 턴 도중의 종료도 '시작 직후 종료'가 아니다.
      f.fake.busy.delete(w.id);
      await f.emit(f.status(w, "gone", { exit: { reason: "exited", exitCode: 0 } }));
    }
  });
});

describe("orch-b-5: 직원 한 명의 읽을 수 없는 상태가 틱과 서버 시작을 막지 않는다", () => {
  function corruptCompaction(f: ReturnType<typeof fixture>, member: Member) {
    f.store.ensureContextState(member.id);
    f.store.db.query("UPDATE member_context_state SET compaction_json = ? WHERE member_id = ?").run(JSON.stringify({ id: "x", trigger: "manual", phase: "from_a_newer_server", reason: null, requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null }), member.id);
  }

  test("틱: 압축 상태를 읽을 수 없는 직원이 있어도 예외 없이 끝나고 다른 직원의 전달은 나간다", async () => {
    const f = fixture(), broken = f.worker(), healthy = f.worker();
    corruptCompaction(f, broken);
    f.say(broken); const d = f.say(healthy);
    const errors: unknown[][] = [], original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      expect(() => f.tick()).not.toThrow();
      await until("다른 직원 전달", () => f.store.requireDelivery(d.id).status === "delivered");
      // 같은 실패가 틱마다 로그를 채우지 않는다.
      const before = errors.filter(e => e[0] === "틱 단계 실패:").length;
      f.tick(); f.tick();
      expect(errors.filter(e => e[0] === "틱 단계 실패:").length).toBe(before);
    } finally { console.error = original; }
    expect(f.fake.sent.map(s => s.memberId)).toEqual([healthy.id]);
  });

  test("재시작 복구: 한 직원의 문맥 상태 오류가 나머지 복구와 대기열 재개를 막지 않는다", async () => {
    const f = fixture(), broken = f.worker(), healthy = f.worker();
    f.store.ensureContextState(broken.id);
    const d = f.say(healthy);
    const save = f.store.saveContextState.bind(f.store);
    f.store.saveContextState = ((state: Parameters<Store["saveContextState"]>[0], ...rest: unknown[]) => {
      if (state.memberId === broken.id) throw new Error("문맥 세대가 어긋났습니다");
      return (save as (...args: unknown[]) => unknown)(state, ...rest);
    }) as Store["saveContextState"];
    const original = console.error; console.error = () => {};
    try { await f.orch.recover(); } finally { console.error = original; }
    await until("복구 뒤 전달", () => f.store.requireDelivery(d.id).status === "delivered");
  });

  test("재시작 복구는 이미 전달된 이력을 다시 훑지 않는다", async () => {
    const f = fixture(), w = f.worker();
    const delivered = Array.from({ length: 30 }, (_, i) => f.say(w, `[대표] 지난 글 ${i}`));
    for (const d of delivered) f.store.markDelivered(d.id);
    const failed = f.say(w, "[대표] 실패한 글"); f.store.markFailed(failed.id, "시험");
    const queued = f.say(w, "[대표] 새 글", { wake: false });
    const seen: string[] = [];
    const requeue = f.orch.deliveryRecovery.requeueRejected.bind(f.orch.deliveryRecovery);
    f.orch.deliveryRecovery.requeueRejected = id => { seen.push(id); return requeue(id); };
    await f.orch.recover();
    expect(seen.filter(id => delivered.some(d => d.id === id))).toHaveLength(0);
    expect(seen).toContain(failed.id);
    expect(seen).toContain(queued.id);
  });
});

describe("orch-b-5 · store-7: 전역 안전망", () => {
  test("처리되지 않은 오류를 기록하고 계속 돈다. 같은 오류는 1분에 한 번만 적고, 계속 쏟아지면 한 번만 다시 시작한다", () => {
    let now = 1_000_000; const lines: string[] = [], restarts: string[] = [];
    const guard = createCrashGuard({ log: line => lines.push(line), now: () => now, restart: reason => restarts.push(reason), limit: 5, windowMs: 60_000 });
    guard.handle("uncaughtException", new Error("틱에서 난 오류"));
    guard.handle("uncaughtException", new Error("틱에서 난 오류"));
    guard.handle("unhandledRejection", "문자열 거부");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("uncaughtException"); expect(lines[0]).toContain("틱에서 난 오류"); expect(lines[0]).toContain("계속 돕니다");
    expect(restarts).toHaveLength(0);
    now += 61_000;
    guard.handle("uncaughtException", new Error("틱에서 난 오류"));
    expect(lines).toHaveLength(3); expect(lines[2]).toContain("repeated=1");
    // 창 밖의 것은 세지 않는다: 지금까지 창 안에는 1건뿐이다.
    for (let i = 0; i < 4; i++) guard.handle("unhandledRejection", new Error(`다른 오류 ${i}`));
    expect(restarts).toHaveLength(0);
    guard.handle("unhandledRejection", new Error("한도를 넘기는 오류"));
    expect(restarts).toHaveLength(1);
    for (let i = 0; i < 10; i++) guard.handle("unhandledRejection", new Error(`그 뒤 ${i}`));
    expect(restarts).toHaveLength(1);
  });

  test("디스크 가득·읽기 쓰기 오류는 분류해 적고 다시 시작 사유로 세지 않는다", () => {
    const lines: string[] = [], restarts: string[] = [];
    const guard = createCrashGuard({ log: line => lines.push(line), restart: reason => restarts.push(reason), limit: 2, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) guard.handle("uncaughtException", Object.assign(new Error(`database or disk is full ${i}`), { code: "SQLITE_FULL" }));
    expect(lines).toHaveLength(10); expect(lines.every(line => line.includes("storage=storage_full"))).toBe(true);
    expect(restarts).toHaveLength(0);
  });

  test("install 은 두 처리기를 걸고, 돌려준 함수로 푼다", () => {
    const handlers = new Map<string, (error: unknown) => void>();
    const target = { on: (event: string, handler: (error: unknown) => void) => { handlers.set(event, handler); return target; }, off: (event: string) => { handlers.delete(event); return target; } };
    const lines: string[] = [];
    const uninstall = createCrashGuard({ log: line => lines.push(line), restart: () => {} }).install(target as unknown as Pick<NodeJS.Process, "on" | "off">);
    expect([...handlers.keys()].sort()).toEqual(["uncaughtException", "unhandledRejection"]);
    handlers.get("unhandledRejection")!(new Error("놓친 거부"));
    expect(lines).toHaveLength(1);
    uninstall();
    expect(handlers.size).toBe(0);
  });

  test("처리기가 없으면 프로세스가 끝나고, 안전망을 걸면 계속 돈다(실제 프로세스)", async () => {
    const runtime = createIsolatedRuntime();
    cleanups.push(() => runtime.stop());
    const guardPath = join(import.meta.dir, "..", "server", "crash-guard.ts");
    const run = async (guarded: boolean) => {
      const entry = join(runtime.dir, guarded ? "guarded.ts" : "bare.ts");
      writeFileSync(entry, `${guarded ? `import { createCrashGuard } from ${JSON.stringify(guardPath)};\ncreateCrashGuard({ restart: () => {}, log: () => {} }).install();\n` : ""}
setTimeout(() => { throw new Error("타이머 예외"); }, 1);
void (async () => { throw new Error("놓친 거부"); })();
setTimeout(() => { console.log("still-alive"); process.exit(0); }, 150);
`);
      const child = Bun.spawn([process.execPath, entry], { env: runtime.childEnv(), cwd: runtime.paths.work, stdout: "pipe", stderr: "pipe" });
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return { out, code };
    };
    expect((await run(false)).code).not.toBe(0);
    expect(await run(true)).toMatchObject({ code: 0, out: "still-alive\n" });
  }, 30_000);
});

describe("orch-a-3: 설정 적용 보류가 조용한 영구 전달 차단이 되지 않는다", () => {
  const defer = (f: ReturnType<typeof fixture>, member: Member) => {
    const signature = JSON.stringify((f.orch as unknown as { desiredConfig(m: Member): unknown }).desiredConfig(member));
    f.store.deferMemberConfig(member.id, signature, true);
    return signature;
  };

  test("세션이 살아 있는 직원은 보류된 설정과 상관없이 전달을 받는다", async () => {
    const f = fixture(), w = f.worker();
    defer(f, w);
    const d = f.say(w);
    await f.orch.pump(w.id);
    expect(f.store.requireDelivery(d.id).status).toBe("delivered");
    // 설정 자체는 보류로 남아 다음 기동 때 맞춘다.
    expect(f.store.deferredMemberConfig(w.id)?.failed).toBe(true);
  });

  test("꺼진 직원은 간격을 두고 스스로 다시 열리고, 그동안 보류 사유가 보인다", async () => {
    const f = fixture({ configRetryMs: 40 }), w = f.worker({ status: "offline", paneId: null });
    defer(f, w);
    const message = f.store.createMessage({ projectId: f.project.id, memberId: null, who: "대표", kind: "지시", body: "보류 중에 보낸 말" });
    const d = f.say(w, "[대표] 보류 중에 보낸 말", { refType: "message", refId: message.id });
    await f.orch.pump(w.id);
    expect(f.fake.starts).toHaveLength(0);
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "held", holdReason: "offline" });
    expect(f.store.requireMessage(message.id).deliveryNote).toContain("새 설정으로 다시 여는 데 실패");
    await until("간격 뒤 자연 기동", () => f.store.requireDelivery(d.id).status === "delivered");
    expect(f.fake.starts).toHaveLength(1);
    expect(f.store.deferredMemberConfig(w.id)).toBeNull();
  });

  test("다시 여는 것이 또 실패하면 다음 시도는 더 멀리 두고, 대표의 다시 확인은 기다리지 않는다", async () => {
    const f = fixture({ configRetryMs: 60_000 }), w = f.worker({ status: "offline", paneId: null });
    const signature = defer(f, w);
    f.store.db.query("UPDATE members SET config_deferred_json = ? WHERE id = ?").run(JSON.stringify({ signature, failed: true, failedAt: new Date(Date.now() - 61_000).toISOString(), attempts: 1 }), w.id);
    f.fake.startImpl = async () => { throw new CoreError("session_unknown", "resume unavailable"); };
    const d = f.say(w);
    await f.orch.pump(w.id);
    expect(f.fake.starts).toHaveLength(1);
    expect(f.store.deferredMemberConfig(w.id)).toMatchObject({ failed: true, attempts: 2 });
    // 61초가 지나도 두 번째 실패부터는 5분 간격이다.
    f.store.db.query("UPDATE members SET config_deferred_json = ? WHERE id = ?").run(JSON.stringify({ signature, failed: true, failedAt: new Date(Date.now() - 61_000).toISOString(), attempts: 2 }), w.id);
    await f.orch.pump(w.id);
    expect(f.fake.starts).toHaveLength(1);
    f.fake.startImpl = async m => ({ sessionId: m.sessionId ?? "s", paneId: "t-again" });
    f.store.recheckPendingDelivery(w.id);
    await until("다시 확인 뒤 전달", () => f.store.requireDelivery(d.id).status === "delivered");
    expect(f.fake.starts).toHaveLength(2);
  });
});

describe("delivery-1: 보낼 수 없는 시도로 거절 횟수를 태우지 않는다", () => {
  test("끼워 넣지 못하는 실행기의 일하는 직원에게는 긴급도 봉투를 만들지 않고, 턴이 끝나면 묶어서 보낸다", async () => {
    const f = fixture(), w = f.worker();
    (f.fake as { interjects?: boolean }).interjects = false;
    await f.orch.pump(w.id);
    const first = f.say(w); await f.orch.pump(w.id);
    expect(f.store.requireDelivery(first.id).status).toBe("delivered");
    const urgent = f.store.enqueue({ projectId: f.project.id, memberId: w.id, kind: "instruction", text: "[지시] 급한 일", urgent: true });
    for (let i = 0; i < 8; i++) await f.orch.pump(w.id);
    expect(f.fake.sent).toHaveLength(1);
    expect(f.store.listDispatches(w.id)).toHaveLength(1);
    expect(f.store.requireDelivery(urgent.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.store.deliveryWait(f.store.requireDelivery(urgent.id)).waitReason).toBe("member_busy");
    f.fake.busy.delete(w.id);
    await f.emit({ type: "turn_end", memberId: w.id, finalText: "", isError: false, terminalId: w.paneId });
    await until("턴 끝 뒤 긴급 전달", () => f.store.requireDelivery(urgent.id).status === "delivered");
    expect(f.fake.sent.at(-1)).toMatchObject({ urgent: false });
  });

  test("끼워 넣을 수 있는 실행기는 예전처럼 일하는 중에도 긴급을 넣는다", async () => {
    const f = fixture(), w = f.worker();
    const first = f.say(w); await f.orch.pump(w.id);
    expect(f.store.requireDelivery(first.id).status).toBe("delivered");
    const urgent = f.store.enqueue({ projectId: f.project.id, memberId: w.id, kind: "instruction", text: "[지시] 급한 일", urgent: true });
    await f.orch.pump(w.id);
    expect(f.fake.sent.at(-1)).toMatchObject({ urgent: true });
    expect(f.store.requireDelivery(urgent.id).status).toBe("delivered");
  });

  test("거절이 쌓여 미뤄 둔 전달은 턴을 잘 마친 순간 풀린다", async () => {
    const f = fixture(), w = f.worker();
    const parked = f.say(w, "[대표] 미뤄진 말");
    // 입력칸이 막혀 다섯 번 거절되면 30초~5분 간격으로 미뤄진다.
    f.fake.sendImpl = async () => ({ ok: false, reason: "input_busy", retryable: false, deliveryEffect: "not_written" });
    for (let i = 0; i < 40 && f.store.getDeliveryRecovery(parked.id)?.phase !== "waiting"; i++) { await f.orch.pump(w.id); await Bun.sleep(8); }
    expect(f.store.getDeliveryRecovery(parked.id)).toMatchObject({ phase: "waiting", reason: "input_busy" });
    const due = Date.parse(f.store.getDeliveryRetry(parked.id).nextAttemptAt!);
    expect(due - Date.now()).toBeGreaterThan(20_000);
    const rejected = f.fake.sent.length;
    await f.orch.pump(w.id);
    expect(f.fake.sent).toHaveLength(rejected);
    f.fake.sendImpl = async () => ({ ok: true, started: true, turn: 1 });
    await f.emit({ type: "turn_end", memberId: w.id, finalText: "", isError: false, terminalId: w.paneId });
    await until("미뤄진 전달", () => f.store.requireDelivery(parked.id).status === "delivered");
  });

  test("다시 보낼 때를 기다리는 전달은 '수신 확인'이 아니라 재시도 대기로 보이고, 그동안 정체로 알리지 않는다", async () => {
    const f = fixture(), w = f.worker();
    const parked = f.say(w, "[대표] 미뤄진 말");
    const r = f.store.getDeliveryRecovery(parked.id)!;
    f.store.updateDeliveryRecovery(parked.id, r.version, { phase: "waiting", reason: "input_busy" });
    f.store.setDeliveryStatus(parked.id, "held", { holdReason: "input_busy" });
    f.store.patchDeliveryRetry(parked.id, { nextAttemptAt: new Date(Date.now() + 300_000).toISOString(), retryReason: "input_busy" });
    expect(f.store.deliveryWait(f.store.requireDelivery(parked.id)).waitReason).toBe("retry_wait");
    f.store.detectDeliveryStalls(Date.now() + 200_000, 120_000);
    expect(f.store.deliveryStalled(parked.id)).toBe(false);
    expect(f.fake.sent).toHaveLength(0);
    // 그 시각이 지나고도 안 나가면 이유 없는 대기다.
    f.store.patchDeliveryRetry(parked.id, { nextAttemptAt: new Date(Date.now() - 1).toISOString() });
    expect(f.store.deliveryWait(f.store.requireDelivery(parked.id)).waitReason).toBe("unknown");
  });

  test("이유 없이 멈춘 전달은 알리기 전에 스스로 다시 밀어 내보낸다", async () => {
    const f = fixture(), w = f.worker();
    const stuck = f.say(w);
    const created = Date.parse(stuck.createdAt);
    f.store.detectDeliveryStalls(created + 30_000);
    expect(f.fake.sent).toHaveLength(0);
    f.store.detectDeliveryStalls(created + 61_000);
    await until("스스로 다시 밀기", () => f.store.requireDelivery(stuck.id).status === "delivered");
    expect(f.store.listMessages(f.project.id).filter(m => m.title === "전달 확인 필요")).toHaveLength(0);
  });

  test("다시 밀기는 전달마다 한 번이고, 그래도 멈춰 있으면 알린다", () => {
    const f = fixture(), w = f.worker();
    const stuck = f.say(w), created = Date.parse(stuck.createdAt);
    const bare = new Store(f.db, new Bus());
    const nudged: string[] = [];
    bare.setDeliveryWaitContext(() => ({ busy: false, waking: false, used: 0 }), () => {}, id => { nudged.push(id); });
    bare.detectDeliveryStalls(created + 59_000);
    expect(nudged).toHaveLength(0);
    bare.detectDeliveryStalls(created + 61_000);
    bare.detectDeliveryStalls(created + 90_000);
    expect(nudged).toEqual([w.id]);
    expect(bare.deliveryStalled(stuck.id)).toBe(false);
    bare.detectDeliveryStalls(created + 121_000);
    expect(bare.deliveryStalled(stuck.id)).toBe(true);
    expect(nudged).toEqual([w.id]);
    expect(bare.listMessages(f.project.id).filter(m => m.title === "전달 확인 필요")).toHaveLength(1);
  });
});

describe("delivery-10 · delivery-7 · http-4: 대기 사유와 이벤트", () => {
  test("사고가 끝난 뒤에는 행에 남은 보류 사유를 대기 사유로 말하지 않는다", async () => {
    const f = fixture(), w = f.worker();
    const d = f.say(w);
    f.store.markHeld(d.id, "api_outage");
    // 지금 이 직원을 보류 중인 사고는 없다.
    expect(f.orch.apiRecovery.holdReason(w.id)).toBeNull();
    expect(f.store.deliveryWait(f.store.requireDelivery(d.id)).waitReason).not.toBe("api_outage");
    // 실행기 문맥이 없는 저장소(옛 동작)는 저장된 사유를 그대로 쓴다.
    const bare = new Store(f.db, new Bus());
    expect(bare.deliveryWait(bare.requireDelivery(d.id)).waitReason).toBe("api_outage");
  });

  test("같은 사유로 다시 보류해도 쓰지 않고 이벤트도 내지 않는다", async () => {
    const f = fixture(), w = f.worker();
    const d = f.say(w);
    f.store.markHeld(d.id, "blocked");
    const before = f.events.length, updatedAt = f.store.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
    for (let i = 0; i < 5; i++) f.store.markHeld(d.id, "blocked");
    expect(f.events.length).toBe(before);
    expect(f.store.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n).toBe(updatedAt);
    f.store.markHeld(d.id, "backend_down");
    expect(f.events.length).toBe(before + 1);
    f.store.setDeliveryStatus(d.id, "held", { attempt: true });
    expect(f.store.requireDelivery(d.id).attempts).toBe(1);
  });

  test("전달 복구 단계·사유가 바뀌면 이벤트가 나가 스냅샷 세대가 오른다. 확인 시각만 바뀌면 나가지 않는다", async () => {
    const f = fixture(), w = f.worker();
    const d = f.say(w);
    const seq = () => f.bus.seq;
    let r = f.store.getDeliveryRecovery(d.id)!;
    let before = seq();
    r = f.store.updateDeliveryRecovery(d.id, r.version, { phase: "checking", reason: "inflight_unsettled", nextCheckAt: new Date().toISOString() });
    expect(seq()).toBeGreaterThan(before);
    before = seq();
    r = f.store.updateDeliveryRecovery(d.id, r.version, { nextCheckAt: new Date(Date.now() + 1000).toISOString(), lastCheckedAt: new Date().toISOString(), checkCount: 1 });
    r = f.store.updateDeliveryRecovery(d.id, r.version, { phase: "checking", reason: "inflight_unsettled" });
    expect(seq()).toBe(before);
    r = f.store.updateDeliveryRecovery(d.id, r.version, { phase: "waiting", reason: "busy" });
    expect(seq()).toBeGreaterThan(before);
    before = seq();
    f.store.updateDeliveryRecovery(d.id, r.version, { phase: "resolved", reason: null });
    expect(seq()).toBeGreaterThan(before);
  });

  test("거절이 이어져 미룰 때 실제 까닭을 보류 문구에 적는다", async () => {
    const f = fixture(), w = f.worker();
    const message = f.store.createMessage({ projectId: f.project.id, memberId: null, who: "대표", kind: "지시", body: "말" });
    const d = f.say(w, "[대표] 말", { refType: "message", refId: message.id });
    f.fake.sendImpl = async () => ({ ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" });
    for (let i = 0; i < 40 && f.store.getDeliveryRecovery(d.id)?.phase !== "waiting"; i++) { await f.orch.pump(w.id); await Bun.sleep(8); }
    expect(f.store.getDeliveryRecovery(d.id)).toMatchObject({ phase: "waiting", reason: "input_busy" });
    expect(f.store.requireMessage(message.id).deliveryNote).toContain("일하는 중이라 넣지 못했습니다");
  });

  test("실행기와 무관한 내부 오류로 펌프가 실패하면 '실행기에 연결할 수 없음'으로 보류하지 않는다", async () => {
    const f = fixture(), w = f.worker();
    const d = f.say(w);
    f.fake.sendImpl = async () => { throw new Error("unused"); };
    const internals = f.orch as unknown as { sendEnvelope(): Promise<never> };
    const original = internals.sendEnvelope;
    internals.sendEnvelope = async () => { throw new Error("내부 오류"); };
    const log = console.error; console.error = () => {};
    try { await f.orch.pump(w.id); } finally { console.error = log; }
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "queued", holdReason: null });
    expect(f.store.requireMember(w.id).lastError).toBe("전달 처리 오류: 내부 오류");
    internals.sendEnvelope = async () => { throw new CoreError("down", "socket closed"); };
    console.error = () => {};
    try { await f.orch.pump(w.id); } finally { console.error = log; }
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "held", holdReason: "backend_down" });
    internals.sendEnvelope = original;
  });
});

describe("orch-b-6: 원본이 바뀐 전달 하나가 대기열 전체를 막지 않는다", () => {
  test("체크를 푼 할 일의 완료 알림은 거두고, 같은 직원의 다른 전달은 나간다", async () => {
    const f = fixture(), w = f.worker();
    const todo = f.store.createTodo({ projectId: f.project.id, title: "확인할 일", memberId: w.id });
    f.store.setTodoDone(todo.id, true);
    const done = f.store.enqueue({ projectId: f.project.id, memberId: w.id, kind: "todo_done", text: "[할 일 완료] 확인할 일", refType: "todo", refId: todo.id });
    // 입력칸이 막혀 거절이 쌓인 채 주차된 뒤, 대표가 체크를 풀었다.
    const r = f.store.getDeliveryRecovery(done.id)!;
    f.store.updateDeliveryRecovery(done.id, r.version, { phase: "waiting", reason: "input_busy" });
    f.store.setDeliveryStatus(done.id, "held", { holdReason: "input_busy" });
    f.store.setTodoDone(todo.id, false);
    const message = f.say(w, "[대표] 그 뒤에 보낸 말");
    const log = console.error; const errors: unknown[][] = []; console.error = (...args: unknown[]) => { errors.push(args); };
    try { await f.orch.pump(w.id); } finally { console.error = log; }
    expect(errors.filter(e => e[0] === "전달 펌프 오류:")).toHaveLength(0);
    expect(f.store.requireDelivery(message.id).status).toBe("delivered");
    expect(f.fake.sent).toHaveLength(1);
    expect(f.fake.sent[0]!.text).not.toContain("할 일 완료");
    expect(f.store.requireDelivery(done.id)).toMatchObject({ status: "failed", lastError: "원본이 바뀌어 보내지 않았습니다" });
    expect(f.store.getDeliveryRecovery(done.id)).toMatchObject({ phase: "stopped", reason: "source_changed" });
    expect(f.orch.deliveryRecovery.fenced(w.id)).toBe(false);
  });

  test("거절만 쌓여 주차된 미전달은 원본을 거둘 때 함께 거둔다", () => {
    const f = fixture(), w = f.worker();
    const todo = f.store.createTodo({ projectId: f.project.id, title: "확인할 일", memberId: w.id });
    const done = f.store.enqueue({ projectId: f.project.id, memberId: w.id, kind: "todo_done", text: "[할 일 완료] 확인할 일", refType: "todo", refId: todo.id });
    const r = f.store.getDeliveryRecovery(done.id)!;
    f.store.updateDeliveryRecovery(done.id, r.version, { phase: "waiting", reason: "input_busy" });
    f.store.setDeliveryStatus(done.id, "held", { holdReason: "input_busy" });
    expect(f.store.cancelPendingFor("todo", todo.id)).toBe(1);
    expect(f.store.getDelivery(done.id)).toBeNull();
    // 확인 중인 전달은 거두지 않는다.
    const checking = f.store.enqueue({ projectId: f.project.id, memberId: w.id, kind: "todo_done", text: "[할 일 완료] 확인할 일", refType: "todo", refId: todo.id });
    const c = f.store.getDeliveryRecovery(checking.id)!;
    f.store.updateDeliveryRecovery(checking.id, c.version, { phase: "checking", reason: "inflight_unsettled" });
    expect(f.store.cancelPendingFor("todo", todo.id)).toBe(0);
  });
});

describe("x-restart-7: 이유가 붙은 채 어긋난 대기를 스스로 알아챈다", () => {
  test("끝나지 않는 '깨우는 중'은 다시 밀어 본 뒤 정체로 알린다", async () => {
    const f = fixture(), w = f.worker();
    const d = f.say(w);
    // 미확정 기동 저널이 남은 상태를 만든다: 대기 사유는 '깨우는 중'이고 펌프는 저널 때문에 멈춘다.
    const at = new Date().toISOString();
    f.store.saveLifecycleJournal({ operationId: crypto.randomUUID(), memberId: w.id, projectId: f.project.id, intent: "start", phase: "unknown", identity: { terminalId: w.paneId, sessionId: w.sessionId, sessionGeneration: f.store.memberRevisions(w.id).sessionGeneration, process: null }, runId: null, deliveryIds: [], baseline: null, reason: "시험", exitCode: null, createdAt: at, updatedAt: at });
    const t0 = Date.parse(d.createdAt);
    expect(f.store.deliveryWait(f.store.requireDelivery(d.id)).waitReason).toBe("waking");
    f.store.detectDeliveryStalls(t0 + 1_000);
    f.store.detectDeliveryStalls(t0 + 200_000);
    expect(f.store.deliveryWait(f.store.requireDelivery(d.id)).waitReason).toBe("waking");
    expect(f.store.deliveryStalled(d.id)).toBe(false);
    // 5분 넘게 이어지면 이유 없는 대기로 본다: 한 번 다시 밀고, 다음 점검에서 알린다.
    f.store.detectDeliveryStalls(t0 + 302_000);
    expect(f.store.deliveryWait(f.store.requireDelivery(d.id)).waitReason).toBe("unknown");
    expect(f.store.deliveryStalled(d.id)).toBe(false);
    f.store.detectDeliveryStalls(t0 + 307_000);
    expect(f.store.deliveryStalled(d.id)).toBe(true);
    expect(f.store.listMessages(f.project.id).filter(m => m.title === "전달 확인 필요")).toHaveLength(1);
    expect(f.fake.sent).toHaveLength(0);
  });
});

describe("x-restart-2: 결과를 모르는 전송이 직원을 영영 막지 않는다", () => {
  test("단계 제한이 먼저 끝난 전송이 뒤늦게 '쓰지 않음'으로 끝나면 대표 손 없이 다시 보낸다", async () => {
    const f = fixture({ pumpStageTimeoutMs: 30 }), w = f.worker();
    const held = gate<SendResult>();
    f.fake.sendImpl = () => held.wait;
    const d = f.say(w);
    await f.orch.pump(w.id);
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "held", holdReason: "delivery_unknown" });
    expect(f.store.inputState(w.id).unresolvedDispatches).toHaveLength(1);
    expect(f.orch.deliveryRecovery.fenced(w.id)).toBe(true);
    // 호출이 아직 돌고 있으면 시간이 지나도 끝난 쓰기로 보지 않는다.
    expect(f.orch.writerDone({ ...f.store.inputState(w.id).unresolvedDispatches[0]!, updatedAt: new Date(0).toISOString() })).toBe(false);
    f.fake.sendImpl = async () => ({ ok: true, started: true, turn: 1 });
    held.open({ ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: "pump deadline expired before RPC" });
    await until("늦은 결과 뒤 재전송", () => f.store.requireDelivery(d.id).status === "delivered");
    expect(f.fake.sent).toHaveLength(2);
    expect(f.store.inputState(w.id).unresolvedDispatches).toHaveLength(0);
    expect(f.store.listPendingExecutions().filter(run => run.memberId === w.id)).toHaveLength(1);
  });

  test("뒤늦게 온 수신 확인은 다시 보내지 않고 전달로 확정한다", async () => {
    const f = fixture({ pumpStageTimeoutMs: 30 }), w = f.worker();
    const held = gate<SendResult>();
    f.fake.sendImpl = () => held.wait;
    const d = f.say(w);
    await f.orch.pump(w.id);
    expect(f.store.requireDelivery(d.id).status).toBe("held");
    held.open({ ok: true, started: true, turn: 4 });
    await until("늦은 수신 확인", () => f.store.requireDelivery(d.id).status === "delivered");
    expect(f.fake.sent).toHaveLength(1);
    expect(f.store.getExecutionJournal(f.store.listDispatches(w.id)[0]!.dispatchId)).toMatchObject({ phase: "running", turn: 4 });
    expect(f.orch.deliveryRecovery.fenced(w.id)).toBe(false);
  });

  test("이전 프로세스가 쓰기 전에 남긴 봉투(prepared)는 재시작 때 거절로 닫히고 다시 나간다", async () => {
    const f = fixture(), w = f.worker();
    const d = f.say(w);
    f.orch.deliveryRecovery.prepareDispatch([d.id], { terminalId: w.paneId, sessionId: w.sessionId, sessionGeneration: f.store.memberRevisions(w.id).sessionGeneration, process: null },
      { serverEpoch: "죽은-프로세스", turn: null, inputEpoch: null, logs: [], capturedAt: new Date().toISOString() });
    expect(f.orch.deliveryRecovery.fenced(w.id)).toBe(true);
    await f.orch.recover();
    await until("재시작 뒤 전달", () => f.store.requireDelivery(d.id).status === "delivered");
    expect(f.fake.sent).toHaveLength(1);
    expect(f.store.listDispatches(w.id).map(x => x.transportState)).toEqual(["rejected", "accepted"]);
  });

  test("끝난 쓰기의 봉투는 항목이 모두 정리되면 닫히고, 남은 실행 기록도 함께 끝난다", async () => {
    const f = fixture({ writeSettleMs: 0 }), w = f.worker();
    f.fake.sendImpl = async () => ({ ok: false, reason: "error", retryable: false, deliveryEffect: "unknown", detail: "reply lost" });
    const d = f.say(w);
    await f.orch.pump(w.id);
    expect(f.orch.deliveryRecovery.fenced(w.id)).toBe(true);
    expect(f.store.listPendingExecutions().filter(run => run.memberId === w.id)).toHaveLength(1);
    f.fake.sendImpl = async () => ({ ok: true, started: true, turn: 1 });
    await f.orch.recoverDelivery(d.id, { operationId: crypto.randomUUID(), expectedVersion: f.store.getDeliveryRecovery(d.id)!.version, action: "stop_retry" });
    expect(f.orch.deliveryRecovery.fenced(w.id)).toBe(false);
    const next = f.say(w, "[대표] 그 뒤의 말");
    await until("그만 보낸 뒤의 전달", () => f.store.requireDelivery(next.id).status === "delivered");
    expect(f.store.requireDelivery(d.id).status).toBe("failed");
    expect(f.store.getExecutionJournal(f.store.listDispatches(w.id)[0]!.dispatchId)).toMatchObject({ phase: "ended", result: "error", reason: "unconfirmed_closed" });
  });

  test("쓰기가 끝난 지 얼마 안 됐으면 '그만 보내기' 뒤에도 물리 펜스는 잠깐 남는다", async () => {
    const f = fixture({ writeSettleMs: 60_000 }), w = f.worker();
    f.fake.sendImpl = async () => ({ ok: false, reason: "error", retryable: false, deliveryEffect: "unknown", detail: "reply lost" });
    const d = f.say(w);
    await f.orch.pump(w.id);
    await f.orch.recoverDelivery(d.id, { operationId: crypto.randomUUID(), expectedVersion: f.store.getDeliveryRecovery(d.id)!.version, action: "stop_retry" });
    expect(f.orch.deliveryRecovery.fenced(w.id)).toBe(true);
    expect(f.store.inputState(w.id).unresolvedDispatches).toHaveLength(1);
  });
});

describe("orch-b-8: 턴이 끝날 때마다 세션 기록을 통째로 훑지 않는다", () => {
  test("codex 기록은 세션 ID 가 붙은 이름부터 찾고, 찾은 경로를 기억한다", () => {
    const f = fixture(), w = f.worker({ cli: "codex", sessionId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001" });
    const dir = join(f.runtime.providerHomes.codexHome, "sessions", "2026", "11", "10");
    mkdirSync(dir, { recursive: true });
    const meta = (id: string, cwd: string) => JSON.stringify({ type: "session_meta", payload: { id, cwd, timestamp: "2026-11-10T00:00:00.000Z" } }) + "\n";
    for (let i = 0; i < 25; i++) writeFileSync(join(dir, `rollout-2026-11-10T00-00-${String(i).padStart(2, "0")}-decoy-${i}.jsonl`), meta(`decoy-${i}`, w.cwd));
    const real = join(dir, `rollout-2026-11-10T01-00-00-${w.sessionId}.jsonl`);
    writeFileSync(real, meta(w.sessionId!, w.cwd));
    const internals = f.orch as unknown as { contextLog(m: Member): { path: string } | null };
    const opened: string[] = [];
    const open = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => { opened.push(String(args[0])); return original(...args); }) as typeof fs.openSync);
    try {
      expect(internals.contextLog(f.store.requireMember(w.id))?.path).toBe(realpathSync(real));
      expect(opened.filter(path => path.includes("decoy"))).toHaveLength(0);
      const first = opened.length;
      expect(first).toBeGreaterThan(0);
      expect(internals.contextLog(f.store.requireMember(w.id))?.path).toBe(realpathSync(real));
      expect(opened.length).toBe(first);
    } finally { open.mockRestore(); }
  });

  test("이름에 세션 ID 가 없는 기록도 예전처럼 내용으로 찾는다", () => {
    const f = fixture(), w = f.worker({ cli: "codex", sessionId: "native-session" });
    const dir = join(f.runtime.providerHomes.codexHome, "sessions", "day");
    mkdirSync(dir, { recursive: true });
    const odd = join(dir, "rollout-time-other-name.jsonl");
    writeFileSync(odd, JSON.stringify({ type: "session_meta", payload: { id: "native-session", cwd: w.cwd, timestamp: "2026-11-10T00:00:00.000Z" } }) + "\n");
    const internals = f.orch as unknown as { contextLog(m: Member): { path: string } | null };
    expect(internals.contextLog(f.store.requireMember(w.id))?.path).toBe(realpathSync(odd));
  });
});

describe("mem-growth-10: 서버가 스스로 커지는지 볼 수 있다", () => {
  test("메모리·DB·WAL 크기와 쌓이는 표의 행 수를 한 줄로 낸다. 내용은 담지 않는다", () => {
    const f = fixture(), w = f.worker();
    f.say(w, "[대표] 비밀스러운 내용"); f.say(w, "[대표] 또 하나");
    const vitals = readVitals(f.db, f.config.dbPath, () => ({ rss: 300 * 1024 * 1024, heapUsed: 120 * 1024 * 1024 }));
    expect(vitals).toMatchObject({ rssMb: 300, heapMb: 120, rows: { deliveries: 2, delivery_dispatches: 0 } });
    expect(vitals.dbMb + vitals.walMb).toBeGreaterThan(0);
    const { line, warn } = vitalsLine(vitals);
    expect(warn).toBe(false);
    expect(line).toStartWith("[vitals] rssMb=300 heapMb=120 dbMb=");
    expect(line).toContain("deliveries=2"); expect(line).not.toContain("비밀");
    expect(vitalsLine({ ...vitals, walMb: 300 }).warn).toBe(true);
    expect(vitalsLine({ ...vitals, rssMb: 2000 }).line).toContain("평소보다 큽니다");
  });
});

describe("n-lists-3 · n-lists-6: 관측 시각만 새로워진 것을 매번 적지 않는다", () => {
  test("30초 안의 관측 시각 갱신은 쓰지 않고, 내용이 바뀌거나 승인 창 앞이면 그대로 적는다", () => {
    const f = fixture(), w = f.worker();
    const at = (ms: number) => new Date(Date.parse("2026-11-10T00:00:00.000Z") + ms).toISOString();
    const observation = (ms: number, extra: Record<string, unknown> = {}) => ({ source: "core" as const, observedAt: at(ms), freshness: "fresh" as const, ownership: "verified" as const, consecutiveFailures: 0, error: null, ...extra });
    f.store.patchMember(w.id, { statusObservation: observation(0) });
    const events = f.events.length, updatedAt = f.store.requireMember(w.id).updatedAt;
    for (const ms of [5_000, 10_000, 29_000]) f.store.patchMember(w.id, { statusObservation: observation(ms) });
    expect(f.store.requireMember(w.id)).toMatchObject({ updatedAt, statusObservation: { observedAt: at(0) } });
    f.store.patchMember(w.id, { statusObservation: observation(31_000) });
    expect(f.store.requireMember(w.id).statusObservation?.observedAt).toBe(at(31_000));
    // 시각만 바뀐 것은 예전처럼 이벤트를 내지 않는다.
    expect(f.events.length).toBe(events);
    f.store.patchMember(w.id, { statusObservation: observation(32_000, { freshness: "stale", consecutiveFailures: 1 }) });
    expect(f.store.requireMember(w.id).statusObservation).toMatchObject({ observedAt: at(32_000), freshness: "stale" });
    expect(f.events.length).toBe(events + 1);
    f.store.patchMember(w.id, { status: "blocked", statusObservation: observation(40_000) });
    f.store.patchMember(w.id, { statusObservation: observation(41_000) });
    expect(f.store.requireMember(w.id).statusObservation?.observedAt).toBe(at(41_000));
  });
});
