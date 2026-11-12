import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { DELIVERY_WAIT_REASONS, PUMP_VERDICTS, verdictPatience } from "../server/pump-verdict.ts";
import type { Runner, RunnerEvent, RunnerMember, RunnerStartResult, SendResult } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import type { Backend, Member, WsEvent } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

// E3: 보낼지 말지는 전달 펌프 한 곳이 정하고, 화면의 대기 사유는 펌프가 남긴 판정만 읽는다.
// 진짜 CLI·실행 엔진은 띄우지 않는다. 실행기는 core 의 계약(관측 포함)만 흉내 낸다.

const root = join(import.meta.dir, "..");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class ObservedCore implements Runner {
  readonly kind = "core" as const;
  callback: (e: RunnerEvent) => void = () => {};
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  /** core 실행기의 관측(쉬는 중·일하는 중). 사건 없이 바뀌는 것을 흉내 낸다. */
  observed = new Map<string, string>();
  sendImpl: () => Promise<SendResult> = async () => ({ ok: true, started: true, turn: 1 });
  async available() { return { ok: true }; }
  async start(m: RunnerMember): Promise<RunnerStartResult> { return { sessionId: m.sessionId ?? `s-${m.id}`, paneId: `t-${m.id}` }; }
  async send(m: RunnerMember, text: string): Promise<SendResult> {
    this.sent.push({ memberId: m.id, text });
    const result = await this.sendImpl();
    if (result.ok) { this.busy.add(m.id); this.observed.set(m.id, "working"); }
    return result;
  }
  observationState(memberId: string) {
    const state = this.observed.get(memberId);
    return state === undefined ? null : { observedAt: new Date().toISOString(), failures: 0, failure: null, lastError: null, identity: { terminalId: null, sessionId: null, sessionGeneration: 0, process: null }, inputEpoch: 0, setupError: null, turn: 1, state } as never;
  }
  async compact(): Promise<SendResult> { return { ok: true, started: false }; }
  isBusy(id: string) { return this.busy.has(id); }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop() {}
  async screen() { return ""; }
  on(callback: (e: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
}

function fixture() {
  const runtime = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: runtime.socketPath, IAMCEO_CORE_BIN: runtime.bins.coreBin, IAMCEO_CLAUDE_BIN: runtime.bins.claudeBin, IAMCEO_CODEX_BIN: runtime.bins.codexBin });
  const bus = new Bus(), events: WsEvent[] = [];
  bus.subscribe(event => events.push(event));
  const db = openDb(config.dbPath), store = new Store(db, bus);
  store.patchSettings({ boardTidyHours: 0 });
  const core = new ObservedCore();
  const project = store.createProject({ name: "판정", cwd: runtime.paths.work, runnerEnabled: true });
  let count = 0;
  const worker = (): Member => { count++; return store.createMember({ projectId: project.id, handle: `w${count}`, name: `팀장${count}`, kind: "worker", origin: "runner", backend: "core", status: "idle", paneId: `pane${count}`, sessionId: `session${count}` }); };
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["core", core]]), providerHomes: runtime.providerHomes, timings: { tickMs: 60_000, healthMs: 60_000, retryMs: 5, inputBusyRetryMs: 5 } });
  const say = (member: Member, text = "[대표] 확인해 주세요") => store.enqueue({ projectId: project.id, memberId: member.id, kind: "user_message", text });
  const verdictRow = (memberId: string) => db.query<Record<string, string | null>, [string]>("SELECT * FROM member_delivery_verdicts WHERE member_id = ?").get(memberId);
  const changes = () => db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  const stallCheck = () => (orch as unknown as { lastStallCheck: number; detectStallsSoon(): void }).detectStallsSoon();
  cleanups.push(async () => { await orch.shutdown(); db.close(); await runtime.stop(); });
  return { runtime, config, db, bus, events, store, core, orch, project, worker, say, verdictRow, changes, stallCheck };
}

describe("판정 코드와 앱의 대기 사유 13개", () => {
  test("판정은 모두 앱이 아는 13개 값 중 하나로만 내려간다", () => {
    // 0.2.2 가 아는 값 그대로(shared/types.ts DeliveryWaitReason). 이름을 바꾸거나 더하지 않는다.
    expect([...DELIVERY_WAIT_REASONS].sort()).toEqual(["api_outage", "approval", "archived", "manual_control", "member_busy", "next_turn", "receipt_check", "retry_wait", "run_limit", "runner_off", "unknown", "usage_limit", "waking"]);
    for (const [code, verdict] of Object.entries(PUMP_VERDICTS)) expect(DELIVERY_WAIT_REASONS as readonly string[]).toContain(verdict.wait);
    // 기한을 재는 판정은 일하는 중(확인되지 않음)과 깨우는 중뿐이다.
    expect(Object.keys(PUMP_VERDICTS).filter(code => verdictPatience(code, 120_000) !== null).sort()).toEqual(["busy_unconfirmed", "session_busy", "waking"]);
    expect(verdictPatience("busy", 120_000)).toBeNull();
    expect(verdictPatience("busy_unconfirmed", 120_000)).toBe(120_000);
    expect(verdictPatience("waking", 120_000)).toBe(300_000);
  });

  test("pumpOnce 의 return 은 모두 판정을 남긴다(팀장이 지워진 경우만 빼고)", () => {
    const source = readFileSync(join(root, "server/orchestrator.ts"), "utf8");
    const start = source.indexOf("  private async pumpOnce(memberId: string)");
    const end = source.indexOf("\n  /** 이 직원의 세션에 들어가 있어야 할 설정. */", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const lines = source.slice(start, end).split("\n");
    const bare: string[] = [];
    lines.forEach((line, i) => {
      for (const match of line.matchAll(/\breturn\b(.*)/g)) {
        const rest = match[1]!.trim();
        if (rest.startsWith("this.judged(")) continue;
        if (line.includes("if (!member) return;")) continue;
        // 판정을 남긴 뒤 비동기 단계를 마치고 끝나는 return(일하는 중의 긴급, 압축)은 바로 앞에서 판정을 남겼다.
        const before = lines.slice(Math.max(0, i - 6), i).join("\n");
        if (rest === ";" && before.includes("this.judged(")) continue;
        bare.push(line.trim());
      }
    });
    expect(bare).toEqual([]);
  });

  test("저장소는 펌프의 메모리 상태를 콜백으로 읽지 않는다", () => {
    const store = readFileSync(join(root, "server/store.ts"), "utf8"), orch = readFileSync(join(root, "server/orchestrator.ts"), "utf8");
    for (const gone of ["setDeliveryWaitContext", "DeliveryWaitContext", "suspectWaits", "waitWatch", "contradiction"]) {
      expect(store.includes(gone)).toBe(false);
      expect(orch.includes(gone)).toBe(false);
    }
  });
});

describe("판정 기록", () => {
  test("같은 판정은 다시 쓰지 않고, 바뀌면 한 번 쓰고 앱에 알린다", async () => {
    const f = fixture(), w = f.worker();
    f.say(w);
    f.core.busy.add(w.id);
    await f.orch.pump(w.id);
    expect(f.verdictRow(w.id)).toMatchObject({ code: "busy", wait_reason: "member_busy", overdue_at: null });
    const since = f.verdictRow(w.id)!.since;
    const before = f.changes(), events = f.events.length;
    for (let i = 0; i < 5; i++) await f.orch.pump(w.id);
    expect(f.changes()).toBe(before);
    expect(f.events.length).toBe(events);
    // 사유가 바뀌면(승인 창) 한 줄을 고치고 member 이벤트를 낸다.
    f.store.patchMember(w.id, { status: "blocked" });
    const afterPatch = f.events.length;
    await f.orch.pump(w.id);
    expect(f.verdictRow(w.id)).toMatchObject({ code: "approval", wait_reason: "approval" });
    // 판정이 바뀌면 since 도 새로 센다.
    expect(Date.parse(f.verdictRow(w.id)!.since ?? "") >= Date.parse(since ?? "")).toBe(true);
    expect(f.events.slice(afterPatch).some(e => e.type === "member" && (e as { member: Member }).member.id === w.id)).toBe(true);
    expect(f.core.sent).toHaveLength(0);
  });

  test("기다리는 전달이 없으면 판정이 바뀌어도 알리지 않는다", async () => {
    const f = fixture(), w = f.worker();
    const events = f.events.length;
    await f.orch.pump(w.id);
    expect(f.verdictRow(w.id)).toMatchObject({ code: "no_wake" });
    expect(f.events.slice(events).filter(e => e.type === "member")).toHaveLength(0);
  });

  test("보낸 뒤에는 '보냈음'을, 동시 상한에서는 쓴 수와 상한을 남긴다", async () => {
    const f = fixture(), a = f.worker(), b = f.worker();
    f.store.patchSettings({ maxConcurrentTurns: 1 });
    const first = f.say(a);
    await f.orch.pump(a.id);
    expect(f.store.requireDelivery(first.id).status).toBe("delivered");
    expect(f.verdictRow(a.id)).toMatchObject({ code: "sent" });
    const waiting = f.say(b);
    await f.orch.pump(b.id);
    expect(f.store.deliveryWait(f.store.requireDelivery(waiting.id))).toMatchObject({ waitReason: "run_limit", runLimit: { used: 1, limit: 1 } });
  });

  test("판정 줄은 팀장을 지우면 함께 지워지고, DB 판 번호를 올리지 않는다", async () => {
    const f = fixture(), w = f.worker();
    f.say(w);
    f.core.busy.add(w.id);
    await f.orch.pump(w.id);
    expect(f.verdictRow(w.id)).not.toBeNull();
    expect(f.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(MIGRATIONS.length);
    f.db.query("DELETE FROM members WHERE id = ?").run(w.id);
    expect(f.verdictRow(w.id)).toBeNull();
  });
});

describe("기한을 넘긴 판정과 정체 알림", () => {
  test("턴 끝 사건이 빠져 일하는 중으로 남으면, 정체 점검의 다시 판정이 어긋남을 찾고 기한 뒤 다시 밀어 본 다음 알린다", async () => {
    const f = fixture(), w = f.worker();
    f.say(w);
    await f.orch.pump(w.id);
    expect(f.core.sent).toHaveLength(1);
    const next = f.say(w, "[대표] 다음 일");
    await f.orch.pump(w.id);
    // CLI 가 일하는 중으로 관측된다: 확인된 일하는 중이고 기한이 없다.
    expect(f.verdictRow(w.id)).toMatchObject({ code: "busy" });
    // 턴이 끝났는데 사건이 오지 않았다: 실행기는 쉬는 중으로 관측하지만 서버의 턴 표시는 남았다.
    f.core.busy.delete(w.id); f.core.observed.set(w.id, "idle");
    f.stallCheck();
    await Bun.sleep(5);
    expect(f.verdictRow(w.id)).toMatchObject({ code: "busy_unconfirmed", wait_reason: "member_busy" });
    const since = Date.parse(f.verdictRow(w.id)!.since!);
    expect(f.store.deliveryWait(f.store.requireDelivery(next.id)).waitReason).toBe("member_busy");
    f.store.detectDeliveryStalls(since + 60_000);
    expect(f.store.deliveryWait(f.store.requireDelivery(next.id)).waitReason).toBe("member_busy");
    // 기한(2분)을 넘기면 이유 없는 대기로 읽고, 한 번 다시 밀어 본다(알림은 아직).
    f.store.detectDeliveryStalls(since + 121_000);
    expect(f.verdictRow(w.id)!.overdue_at).not.toBeNull();
    expect(f.store.deliveryWait(f.store.requireDelivery(next.id)).waitReason).toBe("unknown");
    expect(f.store.deliveryStalled(next.id)).toBe(false);
    await Bun.sleep(5);
    // 다시 밀어도 같은 판정이면 기한 표시는 그대로이고, 다음 점검에서 알린다.
    expect(f.verdictRow(w.id)).toMatchObject({ code: "busy_unconfirmed" });
    expect(f.verdictRow(w.id)!.overdue_at).not.toBeNull();
    f.store.detectDeliveryStalls(since + 126_000);
    expect(f.store.deliveryStalled(next.id)).toBe(true);
    expect(f.store.listMessages(f.project.id).filter(m => m.title === "전달 확인 필요")).toHaveLength(1);
    expect(f.core.sent).toHaveLength(1);
    // 턴 끝이 늦게 오면 판정이 바뀌어 기한 표시가 풀리고, 다음 일이 나간다.
    f.core.callback({ type: "turn_end", memberId: w.id, finalText: "", isError: false, terminalId: w.paneId });
    for (let i = 0; i < 100 && f.store.requireDelivery(next.id).status !== "delivered"; i++) await Bun.sleep(5);
    expect(f.store.requireDelivery(next.id).status).toBe("delivered");
    expect(f.verdictRow(w.id)!.overdue_at).toBeNull();
  });

  test("CLI 가 정말 일하는 중이면 몇 시간이 지나도 정체로 알리지 않는다", async () => {
    const f = fixture(), w = f.worker();
    f.say(w);
    await f.orch.pump(w.id);
    const next = f.say(w, "[대표] 다음 일");
    await f.orch.pump(w.id);
    expect(f.verdictRow(w.id)).toMatchObject({ code: "busy" });
    f.store.detectDeliveryStalls(Date.now() + 6 * 3_600_000);
    f.store.detectDeliveryStalls(Date.now() + 6 * 3_600_000 + 10_000);
    expect(f.store.deliveryWait(f.store.requireDelivery(next.id)).waitReason).toBe("member_busy");
    expect(f.store.deliveryStalled(next.id)).toBe(false);
    expect(f.store.listMessages(f.project.id).filter(m => m.title === "전달 확인 필요")).toHaveLength(0);
  });

  test("판정이 없는 팀장의 미전달은 이유 없는 대기다: 스스로 다시 밀어 판정을 남긴다", async () => {
    const f = fixture(), w = f.worker();
    f.core.busy.add(w.id);
    const d = f.say(w);
    expect(f.verdictRow(w.id)).toBeNull();
    expect(f.store.deliveryWait(d).waitReason).toBe("unknown");
    f.store.detectDeliveryStalls(Date.parse(d.createdAt) + 61_000);
    for (let i = 0; i < 100 && !f.verdictRow(w.id); i++) await Bun.sleep(5);
    expect(f.verdictRow(w.id)).toMatchObject({ code: "busy" });
    expect(f.store.deliveryWait(f.store.requireDelivery(d.id)).waitReason).toBe("member_busy");
    f.store.detectDeliveryStalls(Date.parse(d.createdAt) + 300_000);
    expect(f.store.deliveryStalled(d.id)).toBe(false);
  });
});

describe("펌프 밖에서 보류하는 곳도 판정을 남긴다", () => {
  test("재우며 보류한 전달은 '다음에 깨울 때 함께'로 읽는다", async () => {
    const f = fixture(), w = f.worker();
    f.say(w); await f.orch.pump(w.id);
    const next = f.say(w, "[대표] 다음 일");
    await f.orch.pump(w.id);
    expect(f.verdictRow(w.id)).toMatchObject({ code: "busy" });
    await f.orch.sleepMember(w.id, { force: true });
    expect(f.verdictRow(w.id)).toMatchObject({ code: "asleep_hold", wait_reason: "next_turn" });
    expect(f.store.deliveryWait(f.store.requireDelivery(next.id)).waitReason).toBe("next_turn");
  });

  test("보관하면 펌프가 다시 판정해 '보관됨'으로 읽는다", async () => {
    const f = fixture(), w = f.worker();
    f.say(w); await f.orch.pump(w.id);
    f.core.callback({ type: "turn_end", memberId: w.id, finalText: "", isError: false, terminalId: w.paneId });
    f.core.busy.delete(w.id); f.core.observed.set(w.id, "idle");
    await Bun.sleep(10);
    const waiting = f.store.enqueue({ projectId: f.project.id, memberId: w.id, kind: "system", text: "[시스템] 다음 턴에", wake: false });
    await f.orch.patchProject(f.project.id, { archived: true });
    for (let i = 0; i < 100 && f.verdictRow(w.id)?.code !== "archived"; i++) await Bun.sleep(5);
    expect(f.verdictRow(w.id)).toMatchObject({ code: "archived", wait_reason: "archived" });
    expect(f.store.deliveryWait(f.store.requireDelivery(waiting.id)).waitReason).toBe("archived");
  });
});

describe("서버 재시작", () => {
  test("지난 프로세스의 '깨우는 중'은 다시 뜨자마자 기한을 넘긴 것으로 읽히지 않는다", () => {
    const f = fixture(), w = f.worker();
    const d = f.say(w);
    f.store.recordPumpVerdict(w.id, { code: "waking" }, Date.now() - 3_600_000);
    f.db.query("UPDATE member_delivery_verdicts SET overdue_at = ? WHERE member_id = ?").run(new Date().toISOString(), w.id);
    const restart = new Store(f.db, new Bus());
    restart.restartPumpVerdictClocks();
    expect(restart.pumpVerdict(w.id)).toMatchObject({ code: "waking", waitReason: "waking", overdueAt: null });
    expect(Date.now() - Date.parse(restart.pumpVerdict(w.id)!.since)).toBeLessThan(5_000);
    restart.detectDeliveryStalls(Date.now() + 10_000);
    expect(restart.deliveryWait(restart.requireDelivery(d.id)).waitReason).toBe("waking");
    expect(restart.deliveryStalled(d.id)).toBe(false);
    // 재시작 복구가 이 정리를 맨 먼저 한다.
    const source = readFileSync(join(root, "server/orchestrator.ts"), "utf8");
    const recover = source.slice(source.indexOf("  async recover(): Promise<void> {"));
    expect(recover.slice(0, 400)).toContain("restartPumpVerdictClocks()");
  });
});

describe("다른 프로세스도 같은 판정을 읽는다", () => {
  test("재시작한 저장소는 판정 줄을 그대로 읽는다(메모리 상태 없이)", async () => {
    const f = fixture(), w = f.worker();
    const d = f.say(w);
    f.store.patchMember(w.id, { status: "blocked" });
    await f.orch.pump(w.id);
    const restart = new Store(f.db, new Bus());
    expect(restart.deliveryWait(restart.requireDelivery(d.id)).waitReason).toBe("approval");
    expect(restart.pumpVerdict(w.id)).toMatchObject({ code: "approval", waitReason: "approval", overdueAt: null });
  });
});
