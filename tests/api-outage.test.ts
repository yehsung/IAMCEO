import { afterEach, describe, expect, test } from "bun:test";
import { ApiRecovery, API_RESUME_TEXT, classifyTurnError, networkRetryScreen, parseUsageReset, usageLimitMenu, type ApiRecoveryOptions } from "../server/api-outage.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { Bus } from "../server/bus.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });
const menuText = (reset = "Nov 13 at 10am (Asia/Seoul)") => `You've hit your weekly limit · resets ${reset}\nWhat do you want to do?\n1. Stop and wait for limit to reset\n2. Wait here, then continue automatically at reset\n3. Add funds to continue with usage credits\nEnter to confirm · Esc to cancel`;
function fixture() {
  const db = openDb(":memory:"); close.push(() => db.close());
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "net-server", cwd: "/private/tmp/fake-api-work" });
  const makeMember = (handle: string, cli: "claude" | "codex" = "claude") => store.createMember({ projectId: project.id, handle, name: handle, cli, kind: "worker", backend: "core", paneId: `t-${handle}`, sessionId: `s-${handle}` });
  const member = makeMember("worker");
  let now = Date.parse("2026-11-10T06:00:00Z");
  let response = true;
  let inspect: ApiRecoveryOptions["inspect"] = async () => ({ menu: null, state: "error" });
  let dismiss: ApiRecoveryOptions["dismiss"] = async () => ({ ok: true });
  const notices: string[] = [], pumps: string[] = [], probes: string[] = [], dismissed: string[] = [];
  const options: ApiRecoveryOptions = { store, now: () => now, intervalMs: 30_000, urls: ["https://fake-anthropic.invalid", "https://fake-openai.invalid"],
    probe: async url => { probes.push(url); if (!response) throw new Error("offline"); return { status: 529 }; },
    notify: (_p, text) => notices.push(text), pump: id => { pumps.push(id); },
    inspect: m => inspect(m), dismiss: (m, fingerprint) => { dismissed.push(fingerprint); return dismiss(m, fingerprint); } };
  let service = new ApiRecovery(options);
  const enqueue = (m = member) => store.enqueue({ projectId: project.id, memberId: m.id, kind: "instruction", text: "기존 지시" });
  return { db, store, project, member, makeMember, enqueue, notices, pumps, probes, dismissed, options,
    get service() { return service; }, restart() { service = new ApiRecovery(options); },
    get now() { return now; }, set now(v: number) { now = v; },
    set response(v: boolean) { response = v; }, set inspect(v: typeof inspect) { inspect = v; }, set dismiss(v: typeof dismiss) { dismiss = v; },
    async recover() { await service.tick(); now += 30_000; await service.tick(); },
    card(cli = "claude") { return store.listDecisions(project.id).find(d => d.usageLimit?.cli === cli)!; } };
}

describe("순수 오류·화면·시각 분류", () => {
  test.each(["response stopped arriving", "No response from API", "Connection error", "fetch failed", "ECONNRESET", "ETIMEDOUT", "socket hang up", "Request timed out", "overloaded", "529", "API Error: 500", "check your network", "stream disconnected", "error sending request", "Reconnecting"])("network: %s", text => expect(classifyTurnError(text)).toBe("network"));
  test.each(["You've hit your usage limit", "usage limit reached", "rate limit", "quota exceeded", "You've hit your weekly limit"])("usage: %s", text => expect(classifyTurnError(text)).toBe("usage_limit"));
  test("인증·기타 오류와 network retry 화면", () => {
    expect(classifyTurnError("authentication_error: unauthorized")).toBe("auth");
    expect(classifyTurnError("tool failed")).toBe("error");
    expect(networkRetryScreen("Waiting for API response · will retry in 1m 2s · check your network")).toBe(true);
    expect(networkRetryScreen("previous connection error")).toBe(false);
    expect(usageLimitMenu(menuText())).not.toBeNull();
    expect(usageLimitMenu("You've hit your weekly limit")).toBeNull();
    expect(usageLimitMenu(menuText().replace("Esc to cancel", "Enter to buy"))).toBeNull();
  });
  test("날짜·시각·서버 시간대·Codex 상대 시각·파싱 실패", () => {
    const now = Date.parse("2026-11-10T06:00:00Z");
    expect(parseUsageReset("resets Nov 13 at 10am (Asia/Seoul)", now)).toBe("2026-11-13T01:00:00.000Z");
    expect(parseUsageReset("resets Nov 13 at 10:30am (Asia/Seoul)", now)).toBe("2026-11-13T01:30:00.000Z");
    expect(parseUsageReset("resets 3pm (Asia/Seoul)", now)).toBe("2026-11-10T06:00:00.000Z");
    expect(parseUsageReset("resets 3pm (Asia/Seoul)", now + 1)).toBe("2026-11-11T06:00:00.000Z");
    expect(parseUsageReset("resets 3:30pm (Asia/Seoul)", now)).toBe("2026-11-10T06:30:00.000Z");
    expect(parseUsageReset("resets 3:30pm", now, "UTC")).toBe("2026-11-10T15:30:00.000Z");
    expect(parseUsageReset("try again in 2h 30m", now)).toBe("2026-11-10T08:30:00.000Z");
    expect(parseUsageReset("try again at 3:00 PM", now, "UTC")).toBe("2026-11-10T15:00:00.000Z");
    expect(parseUsageReset("resets Feb 30 at 10am (Asia/Seoul)", now)).toBeNull();
    expect(parseUsageReset("resets 13pm (Asia/Seoul)", now)).toBeNull();
    expect(parseUsageReset("resets 3pm (Bogus/Zone)", now)).toBeNull();
    expect(parseUsageReset("unknown reset", now)).toBeNull();
    expect(parseUsageReset("try again in " + "9".repeat(400) + "h", now)).toBeNull();
  });
});

describe("영속 API 사고와 이어가기", () => {
  test("시작 알림 1회·보류·재시작·HTTP 오류 코드도 성공·2회 연속 성공·멱등 순서", async () => {
    const f = fixture(), second = f.makeMember("conductor"); const d = f.enqueue();
    f.service.networkFailure(f.member); f.service.networkFailure(second); f.service.networkFailure(f.member);
    expect(f.notices).toHaveLength(1);
    expect(f.store.requireDelivery(d.id).holdReason).toBe("api_outage");
    expect(f.store.requireMember(f.member.id)).toMatchObject({ lastError: "인터넷 연결 문제로 멈춤", statusObservation: { error: { code: "network_outage" } } });
    f.restart(); expect(f.service.outage()?.affectedMemberIds).toEqual([f.member.id, second.id]);
    await f.service.tick(); expect(f.service.outage()).not.toBeNull();
    f.now += 30_000; f.response = false; await f.service.tick();
    f.now += 30_000; f.response = true; await f.service.tick(); expect(f.service.outage()).not.toBeNull();
    f.now += 30_000; await f.service.tick();
    expect(f.service.outage()).toBeNull(); expect(f.store.apiOutage()).toBeNull();
    expect(f.notices.filter(n => n.includes("돌아와"))).toHaveLength(1);
    const pending = f.store.listPending(f.member.id), first = f.service.prioritize(f.member.id, pending);
    expect(first).toHaveLength(1); expect(first[0]!.text).toBe(API_RESUME_TEXT);
    f.store.markDelivered(first[0]!.id);
    expect(f.service.prioritize(f.member.id, f.store.listPending(f.member.id)).map(d => d.id)).toEqual([d.id]);
    f.restart(); f.now += 30_000; await f.service.tick();
    expect(f.store.listDeliveries(f.project.id).filter(d => d.text === API_RESUME_TEXT)).toHaveLength(2);
    expect(f.probes).toHaveLength(8);
  });
  test("working 화면은 복구 때 새 턴을 넣지 않음", async () => {
    const f = fixture(); f.service.networkFailure(f.member, false); await f.recover();
    expect(f.store.listDeliveries(f.project.id)).toHaveLength(0);
  });
  test("이어가기 재실패는 같은 사고에서 최대 3회이고 알림도 1회", async () => {
    const f = fixture(); f.service.networkFailure(f.member);
    for (let i = 0; i < 3; i++) {
      await f.recover();
      const d = f.store.listPending(f.member.id).at(-1)!; f.store.markDelivered(d.id);
      f.service.networkFailure(f.member); f.restart(); f.now += 30_000;
    }
    await f.recover();
    expect(f.store.listDeliveries(f.project.id).filter(d => d.text === API_RESUME_TEXT)).toHaveLength(3);
    expect(f.notices.filter(n => n.includes("3회 실패"))).toHaveLength(1);
    expect(f.service.holdReason(f.member.id)).toBe("api_outage");
  });
});

describe("CLI별 한도 알림과 안전한 이어가기", () => {
  test("CLI별 한 카드·원문 보존·전달 보류·재시작", () => {
    const f = fixture(), second = f.makeMember("second"), codex = f.makeMember("codex", "codex");
    const menu = usageLimitMenu(menuText(), f.now)!; const d = f.enqueue();
    f.service.usageFailure(f.member, menu.raw, menu); f.service.usageFailure(second, menu.raw, menu);
    f.service.usageFailure(codex, "usage limit reached: unknown reset raw"); f.restart();
    expect(f.card().usageLimit?.memberIds).toEqual([f.member.id, second.id]);
    expect(f.card().options).toEqual([{ k: "resume", label: "계정을 바꿨어요 · 모두 이어가기" }]);
    expect(f.card("codex").detail).toContain("unknown reset raw");
    expect(f.store.listDecisions(f.project.id).filter(d => d.kind === "usage_limit")).toHaveLength(2);
    expect(f.store.requireDelivery(d.id).holdReason).toBe("usage_limit");
    expect(f.service.holdReason(f.member.id)).toBe("usage_limit");
  });
  test("지문 확인·Esc 후 이어가기를 먼저 보내며 같은 계정 재발은 열린 카드", async () => {
    const f = fixture(), menu = usageLimitMenu(menuText(), f.now)!; const old = f.enqueue();
    f.service.usageFailure(f.member, menu.raw, menu); f.inspect = async () => ({ menu, state: "blocked" });
    await f.service.resumeUsage(f.card().id);
    expect(f.dismissed).toEqual([menu.fingerprint]);
    expect(f.service.prioritize(f.member.id, f.store.listPending(f.member.id)).map(d => d.text)).toEqual([API_RESUME_TEXT]);
    expect(f.service.holdReason(f.member.id)).toBeNull();
    f.service.usageFailure(f.member, menu.raw, menu);
    expect(f.card()).toMatchObject({ status: "open", usageLimit: { stillLimited: true } });
    expect(f.card().detail).toStartWith("아직 같은 계정");
    expect(f.store.requireDelivery(old.id).holdReason).toBe("usage_limit");
  });
  test("지문 변경·닫기 실패는 이어가기를 보내지 않음", async () => {
    const f = fixture(), menu = usageLimitMenu(menuText(), f.now)!;
    f.service.usageFailure(f.member, menu.raw, menu);
    f.inspect = async () => ({ menu: { ...menu, fingerprint: "changed" }, state: "blocked" });
    await f.service.resumeUsage(f.card().id); expect(f.dismissed).toHaveLength(0);
    f.dismiss = async () => ({ ok: false, note: "창을 닫지 못했습니다" });
    await f.service.resumeUsage(f.card().id);
    expect(f.card().detail).toContain("창을 닫지 못했습니다");
    expect(f.store.listDeliveries(f.project.id)).toHaveLength(0);
  });
  test("초기화 시각 +1분 자동 이어가기와 카드 닫힘·Codex에는 Esc 없음", async () => {
    const f = fixture(), m = f.makeMember("codex", "codex");
    f.service.usageFailure(m, "You've hit your usage limit. try again in 2h 30m");
    f.now += 150 * 60_000 + 59_999; await f.service.tick();
    expect(f.store.listDeliveries(f.project.id)).toHaveLength(0);
    f.now += 5001; await f.service.tick();
    expect(f.dismissed).toHaveLength(0);
    expect(f.store.listPending(m.id)[0]?.text).toBe(API_RESUME_TEXT);
    f.service.completed(m.id);
    expect(f.card("codex").status).toBe("closed");
  });
  test("메뉴가 사라진 직원 제외·마지막이면 닫기", async () => {
    const f = fixture(), menu = usageLimitMenu(menuText(), f.now)!;
    f.service.usageFailure(f.member, menu.raw, menu); await f.service.tick();
    expect(f.card().usageLimit?.memberIds).toEqual([]); expect(f.card().status).toBe("closed");
    expect(f.dismissed).toHaveLength(0);
  });
});


test("재시작 때 같은 OSC 오류 턴은 새 사고나 새 이어가기를 만들지 않는다", async () => {
  const f = fixture(); f.service.networkFailure(f.member, true, "generation:terminal:turn-1");
  await f.recover(); f.restart();
  f.service.networkFailure(f.member, true, "generation:terminal:turn-1");
  expect(f.service.outage()).toBeNull();
  f.now += 30000; await f.service.tick();
  expect(f.store.listDeliveries(f.project.id)).toHaveLength(1);
});

test("주입 탐지가 시간 초과하면 취소 신호를 보내고 복구로 오인하지 않는다", async () => {
  const f = fixture(), signals: AbortSignal[] = [];
  f.options.probeTimeoutMs = 5;
  f.options.probe = async (_url, signal) => { signals.push(signal); return new Promise(() => {}); };
  f.service.networkFailure(f.member); await f.service.tick();
  expect(signals).toHaveLength(2); expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(f.service.outage()).not.toBeNull();
});

test("환경 변수의 대상 목록과 간격을 사용하며 탐지는 여전히 가짜다", async () => {
  const f = fixture(), urls = process.env.IAMCEO_API_PROBE_URLS, interval = process.env.IAMCEO_API_PROBE_INTERVAL_MS;
  f.options.urls = undefined; f.options.intervalMs = undefined;
  process.env.IAMCEO_API_PROBE_URLS = "https://fake-a.invalid, https://fake-b.invalid";
  process.env.IAMCEO_API_PROBE_INTERVAL_MS = "5";
  try {
    f.service.networkFailure(f.member); await f.service.tick();
    f.now += 4; await f.service.tick(); expect(f.probes).toHaveLength(2);
    f.now += 1; await f.service.tick(); expect(f.probes).toEqual(["https://fake-a.invalid", "https://fake-b.invalid", "https://fake-a.invalid", "https://fake-b.invalid"]);
    expect(f.service.outage()).toBeNull();
  } finally {
    if (urls === undefined) delete process.env.IAMCEO_API_PROBE_URLS; else process.env.IAMCEO_API_PROBE_URLS = urls;
    if (interval === undefined) delete process.env.IAMCEO_API_PROBE_INTERVAL_MS; else process.env.IAMCEO_API_PROBE_INTERVAL_MS = interval;
  }
});

test("탐지 중 새 직원에게 연결 오류가 나면 그 전 탐지의 성공을 버린다", async () => {
  const f = fixture(), second = f.makeMember("new-failure");
  const resolve: (() => void)[] = [];
  f.options.probe = async () => new Promise<void>(done => resolve.push(done));
  f.service.networkFailure(f.member); const checking = f.service.tick();
  f.service.networkFailure(second); for (const done of resolve) done(); await checking;
  f.options.probe = async () => ({}); f.now += 30000; await f.service.tick(); expect(f.service.outage()).not.toBeNull();
  f.now += 30000; await f.service.tick(); expect(f.service.outage()).toBeNull();
});

test("대표가 알림을 닫아도 초기화 +1분에는 자동으로 이어간다", async () => {
  const f = fixture(), member = f.makeMember("closed-codex", "codex");
  f.service.usageFailure(member, "usage limit reached: try again in 1m");
  f.store.setDecisionStatus(f.card("codex").id, "closed");
  f.now += 120000; await f.service.tick();
  expect(f.store.listPending(member.id)[0]?.text).toBe(API_RESUME_TEXT);
});

test("Esc 뒤 재시작해도 저장된 이어가기 의도를 살리고 Esc를 다시 보내지 않는다", async () => {
  const f = fixture(), menu = usageLimitMenu(menuText(), f.now)!;
  f.service.usageFailure(f.member, menu.raw, menu);
  const saved = f.store.loadApiRecovery<{ limits: { members: { dismissStarted: boolean }[] }[] }>("api_recovery")!;
  saved.limits[0]!.members[0]!.dismissStarted = true;
  f.store.saveApiRecovery("api_recovery", saved); f.restart();
  await f.service.tick();
  expect(f.dismissed).toHaveLength(0); expect(f.store.listPending(f.member.id)[0]?.text).toBe(API_RESUME_TEXT);
});

test("실제 SQLite 연결을 닫았다 열어도 사고와 1회 성공·이어가기 멱등성을 보존한다", async () => {
  const isolated = createIsolatedRuntime();
  const path = isolated.assertOwnedPath(isolated.paths.temp + "/net-restart.sqlite");
  let db = openDb(path), store = new Store(db, new Bus());
  const project = store.createProject({ name: "restart", cwd: isolated.paths.work });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker" });
  let now = Date.now();
  const options = { now: () => now, urls: ["https://fake.invalid"], probe: async () => ({}), notify: () => {}, pump: () => {}, inspect: async () => ({ menu: null, state: "idle" }), dismiss: async () => ({ ok: true }) };
  let service = new ApiRecovery({ ...options, store });
  try {
    service.networkFailure(member); await service.tick(); await service.shutdown(); db.close();
    db = openDb(path); store = new Store(db, new Bus()); service = new ApiRecovery({ ...options, store });
    expect(service.outage()?.affectedMemberIds).toEqual([member.id]);
    now += 30000; await service.tick(); expect(service.outage()).toBeNull();
    expect(store.listPending(member.id)).toHaveLength(1);
    await service.shutdown(); db.close();
    db = openDb(path); store = new Store(db, new Bus()); service = new ApiRecovery({ ...options, store });
    now += 30000; await service.tick(); expect(store.listPending(member.id)).toHaveLength(1);
  } finally { await service.shutdown(); db.close(); await isolated.stop(); }
});


test("복구 전달 저장이 실패하면 DB와 메모리를 함께 되돌리고 재시도는 한 번만 만든다", async () => {
  const f = fixture(); f.service.networkFailure(f.member); await f.service.tick();
  const enqueue = f.store.enqueue.bind(f.store);
  f.store.enqueue = input => { const result = enqueue(input); if (input.text === API_RESUME_TEXT) throw new Error("simulated commit failure"); return result; };
  f.now += 30000; await expect(f.service.tick()).rejects.toThrow("simulated commit failure");
  expect(f.store.listDeliveries(f.project.id)).toHaveLength(0); expect(f.service.outage()).not.toBeNull();
  f.store.enqueue = enqueue; f.now += 30000; await f.service.tick();
  expect(f.store.listDeliveries(f.project.id)).toHaveLength(1); expect(f.service.outage()).toBeNull();
});


test("연도를 생략한 초기화 날짜는 연말·연초에도 가까운 연도를 쓴다", () => {
  expect(parseUsageReset("resets Jan 1 at 10am (Asia/Seoul)", Date.parse("2026-12-31T06:00:00Z"))).toBe("2027-01-01T01:00:00.000Z");
  expect(parseUsageReset("resets Dec 31 at 10am (Asia/Seoul)", Date.parse("2027-01-01T06:00:00Z"))).toBe("2026-12-31T01:00:00.000Z");
});

test("빈 대상 환경 변수는 기본 대상으로 돌아가며 Codex가 있으면 OpenAI도 탐지한다", async () => {
  const f = fixture(), previous = process.env.IAMCEO_API_PROBE_URLS;
  f.makeMember("default-codex", "codex"); f.options.urls = undefined;
  process.env.IAMCEO_API_PROBE_URLS = " , ";
  try {
    f.service.networkFailure(f.member); await f.service.tick();
    expect(f.probes).toEqual(["https://api.anthropic.com", "https://api.openai.com"]);
  } finally { if (previous === undefined) delete process.env.IAMCEO_API_PROBE_URLS; else process.env.IAMCEO_API_PROBE_URLS = previous; }
});


test("파싱 못한 한도 원문은 직원이 풀리고 카드가 닫힌 뒤에도 카드와 활동에 남는다", async () => {
  const f = fixture(), m = f.makeMember("raw-codex", "codex"), raw = "usage limit reached: unknown provider reset raw";
  f.service.usageFailure(m, raw); const id = f.card("codex").id;
  await f.service.resumeUsage(id);
  const delivery = f.store.listPending(m.id)[0]!; f.store.markDelivered(delivery.id); f.service.received(delivery.id); f.service.completed(m.id);
  expect(f.store.requireDecision(id).status).toBe("closed");
  expect(f.store.requireDecision(id).detail).toContain(raw);
  expect(f.store.listActivity(m.id).some(activity => activity.text === raw)).toBe(true);
});
