import { afterEach, describe, expect, test } from "bun:test";
import { ApiRecovery, API_RESUME_TEXT, NoTerminalError, USAGE_RESUME_OPTION, USAGE_RESUME_TEXT, classifyTurnError, limitedModelName, modelCreditLimit, networkRetryScreen, parseUsageReset, usageLimitMenu, withRo, type ApiRecoveryOptions } from "../server/api-outage.ts";
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
  test("상태줄 숫자·화면 앞 기록·끝 공백은 창 지문과 초기화 시각에 영향을 주지 않는다", () => {
    const first = usageLimitMenu(`old record: resets Nov 12 at 9am (Asia/Seoul)\n${menuText()}\n◆ Opus │ ███░ │ 70% │ $716.43 │ 7일: 11% (412s)\n⏵⏵ bypass permissions on`)!;
    const second = usageLimitMenu(menuText().split("\n").map(line => line + "  ").join("\r\n") + "\r\n◆ Opus │ ███░ │ 71% │ $717.43 │ 7일: 12% (413s)\r\n⏵⏵ bypass permissions on")!;
    expect(first.raw).toBe(menuText());
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.resetsAt).toBe("2026-11-13T01:00:00.000Z");
    expect(usageLimitMenu(menuText().replace(" · resets Nov 13 at 10am (Asia/Seoul)", "") + "\nresets Nov 13 at 10am (Asia/Seoul)")?.resetsAt).toBeNull();
  });
  test.each(["weekly limit", "5-hour limit", "Opus limit", "Sonnet limit", "Fable limit", "usage credit limit", "monthly spend limit", "team's shared budget", "channel's monthly spend limit"])("실제 제목: %s", title => {
    expect(usageLimitMenu(menuText().replace("weekly limit", title))).not.toBeNull();
    expect(classifyTurnError(`You've hit your ${title}`)).toBe("usage_limit");
  });
  test.each(["You've reached your weekly limit", "You're out of usage credits", "Your org is out of usage credits"])("추가 제목: %s", title => {
    expect(usageLimitMenu(menuText().replace("You've hit your weekly limit", title))).not.toBeNull();
    expect(classifyTurnError(title)).toBe("usage_limit");
  });
  test.each(["Stop", "Switch to usage credits", "Don’t continue automatically", "Don't continue automatically", "Wait here, then continue automatically shortly", "Wait here, then continue automatically when the limit resets", "Add funds to continue with usage", "Ask your admin for more usage", "Upgrade your plan", "Continue with lower priority"])("번호 없는 선택지 한 개: %s", option => {
    expect(usageLimitMenu(`You've hit your 5-hour limit\nWhat do you want to do?\n❯ ${option}\nEsc to cancel`)).not.toBeNull();
  });
  test("Add funds 기본 선택과 순서 변경을 허용하고 인용 아래 살아 있는 입력칸을 거부한다", () => {
    const menu = "You've hit your 5-hour limit\nWhat do you want to do?\n❯ 1. Add funds to continue with usage credits\n2. Switch to usage credits\n3. Stop\nEnter to confirm · Esc to cancel";
    expect(usageLimitMenu(menu)).not.toBeNull();
    expect(usageLimitMenu(menu + `\n${"─".repeat(30)}\n❯ representative draft\n${"─".repeat(30)}\nstatus`)).toBeNull();
    expect(usageLimitMenu(menu.replace("Enter to confirm", `${"─".repeat(30)}\n❯\n${"─".repeat(30)}\nEnter to confirm`))).toBeNull();
    expect(usageLimitMenu(menu.replace("What do you want to do?", "another question"))).toBeNull();
    expect(usageLimitMenu("What do you want to do?\nStop\nYou've hit your 5-hour limit\nEsc to cancel")).toBeNull();
    expect(usageLimitMenu("You've hit your 5-hour limit\nWhat do you want to do?\nChoose a color\nEsc to cancel")).toBeNull();
    expect(usageLimitMenu(menu.replace("5-hour limit", "unverified restriction"))).toBeNull();
  });
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
  test("사고마다 프로젝트별 시작·복구 1회와 프로젝트 직원 수, 대표 알림은 각 1회", async () => {
    const f = fixture(), second = f.makeMember("second");
    const project = f.store.createProject({ name: "another", cwd: "/private/tmp/fake-other-work" });
    const other = f.store.createMember({ projectId: project.id, handle: "other", name: "다른 직원", kind: "worker" });
    const notices: { projectId: string; text: string; alertOwner: boolean }[] = [];
    f.options.notify = (projectId, text, alertOwner = true) => notices.push({ projectId, text, alertOwner });
    f.service.networkFailure(f.member); f.service.networkFailure(second, false); f.restart();
    f.service.networkFailure(other); f.service.networkFailure(other); f.service.networkFailure(second);
    expect(notices.map(n => [n.projectId, n.alertOwner])).toEqual([[f.project.id, true], [project.id, false]]);
    expect(notices.every(n => n.text.includes("팀원 1명"))).toBe(true);
    f.restart(); await f.recover();
    expect(notices.slice(2).map(n => [n.projectId, n.alertOwner])).toEqual([[f.project.id, true], [project.id, false]]);
    expect(notices[2]!.text).toContain("팀원 2명"); expect(notices[3]!.text).toContain("팀원 1명");
    f.now += 30_000; f.service.networkFailure(f.member); await f.recover();
    expect(notices).toHaveLength(4);
    f.service.completed(f.member.id); f.service.completed(second.id); f.service.completed(other.id);
    f.now += 30_000; f.service.networkFailure(f.member); await f.recover();
    expect(notices.slice(4).map(n => n.alertOwner)).toEqual([true, true]);
  });
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
  test.each(["10am", "10:30am"])("카드 시각 %s는 서버 시간대로 쓰고 계약 필드는 ISO로 보존한다", time => {
    const f = fixture(), previous = process.env.TZ;
    process.env.TZ = "Asia/Seoul";
    try {
      const menu = usageLimitMenu(menuText(`Nov 13 at ${time} (Asia/Seoul)`), f.now)!;
      f.service.usageFailure(f.member, menu.raw, menu);
      expect(f.card().detail).toContain(time === "10am" ? "11월 13일 오전 10시에" : "11월 13일 오전 10시 30분에");
      expect(f.card().detail).not.toContain("2026-11-13T");
      expect(f.card().usageLimit?.resetsAt).toBe(time === "10am" ? "2026-11-13T01:00:00.000Z" : "2026-11-13T01:30:00.000Z");
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  test.each(["received", "disappeared", "setDecisionStatus", "closeDecision"])("닫힌 카드의 stillLimited 초기화: %s", async closeBy => {
    const f = fixture(), menu = usageLimitMenu(menuText(), f.now)!;
    f.service.usageFailure(f.member, menu.raw, menu); f.inspect = async () => ({ menu, state: "blocked" });
    await f.service.resumeUsage(f.card().id); f.service.usageFailure(f.member, menu.raw, menu);
    expect(f.card().usageLimit?.stillLimited).toBe(true);
    if (closeBy === "received") {
      await f.service.resumeUsage(f.card().id);
      const d = f.service.prioritize(f.member.id, f.store.listPending(f.member.id))[0]!;
      f.store.markDelivered(d.id); f.service.received(d.id);
    } else if (closeBy === "disappeared") {
      f.inspect = async () => ({ menu: null, state: "idle" }); await f.service.tick();
    } else if (closeBy === "setDecisionStatus") f.store.setDecisionStatus(f.card().id, "closed");
    else f.store.closeDecision(f.card().id, { kind: null, reason: "정리", by: "대표" });
    expect(f.card()).toMatchObject({ status: "closed", usageLimit: { stillLimited: false } });
  });
  test("CLI별 한 카드·원문 보존·전달 보류·재시작", () => {
    const f = fixture(), second = f.makeMember("second"), codex = f.makeMember("codex", "codex");
    const menu = usageLimitMenu(menuText(), f.now)!; const d = f.enqueue();
    f.service.usageFailure(f.member, menu.raw, menu); f.service.usageFailure(second, menu.raw, menu);
    f.service.usageFailure(codex, "usage limit reached: unknown reset raw"); f.restart();
    expect(f.card().usageLimit?.memberIds).toEqual([f.member.id, second.id]);
    expect(f.card().options).toEqual([{ k: "resume", label: "계정을 바꿨거나 한도를 늘렸어요 · 이어가기" }]);
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
    expect(f.service.prioritize(f.member.id, f.store.listPending(f.member.id)).map(d => d.text)).toEqual([USAGE_RESUME_TEXT]);
    expect(f.service.holdReason(f.member.id)).toBeNull();
    f.service.usageFailure(f.member, menu.raw, menu);
    expect(f.card()).toMatchObject({ status: "open", usageLimit: { stillLimited: true } });
    expect(f.card().detail).toStartWith("아직 한도가 남아 있지 않습니다.");
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
    expect(f.store.listPending(m.id)[0]?.text).toBe(USAGE_RESUME_TEXT);
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
  expect(f.store.listPending(member.id)[0]?.text).toBe(USAGE_RESUME_TEXT);
});

test("Esc 뒤 재시작해도 저장된 이어가기 의도를 살리고 Esc를 다시 보내지 않는다", async () => {
  const f = fixture(), menu = usageLimitMenu(menuText(), f.now)!;
  f.service.usageFailure(f.member, menu.raw, menu);
  const saved = f.store.loadApiRecovery<{ limits: { members: { dismissStarted: boolean }[] }[] }>("api_recovery")!;
  saved.limits[0]!.members[0]!.dismissStarted = true;
  f.store.saveApiRecovery("api_recovery", saved); f.restart();
  await f.service.tick();
  expect(f.dismissed).toHaveLength(0); expect(f.store.listPending(f.member.id)[0]?.text).toBe(USAGE_RESUME_TEXT);
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


describe("포기·실패 뒤에도 영구 보류로 남지 않는다", () => {
  const MIN = 60_000;
  /** 같은 사고에서 이어가기 3회가 모두 실패해 포기한 상태. 장애 자체는 끝나 있다. */
  async function exhausted(f: ReturnType<typeof fixture>, settled = true) {
    f.service.networkFailure(f.member);
    for (let i = 0; i < 3; i++) {
      await f.recover();
      f.store.markDelivered(f.store.listPending(f.member.id).at(-1)!.id);
      f.service.networkFailure(f.member); f.now += 30_000;
    }
    if (settled) { await f.recover(); expect(f.service.outage()).toBeNull(); }
    expect(f.service.holdReason(f.member.id)).toBe("api_outage");
  }
  const resumes = (f: ReturnType<typeof fixture>, text = API_RESUME_TEXT) => f.store.listDeliveries(f.project.id).filter(d => d.text === text).length;

  test("이어가기 3회 실패 뒤 장애가 끝난 채 15분이 지나면 한 번 더 이어 보고, 또 실패하면 간격을 벌린다(알림은 한 번)", async () => {
    const f = fixture(); await exhausted(f);
    f.now += 13 * MIN; await f.service.tick();
    expect(resumes(f)).toBe(3); expect(f.service.holdReason(f.member.id)).toBe("api_outage");
    f.now += 2 * MIN; await f.service.tick();
    expect(resumes(f)).toBe(4); expect(f.service.holdReason(f.member.id)).toBeNull();
    expect(f.service.prioritize(f.member.id, f.store.listPending(f.member.id)).map(d => d.text)).toEqual([API_RESUME_TEXT]);
    expect(f.store.requireMember(f.member.id).statusObservation?.error ?? null).toBeNull();
    // 다시 이어 본 턴도 실패: 곧바로 포기 상태로 돌아가되 같은 알림을 되풀이하지 않고, 다음은 30분 뒤다.
    f.store.markDelivered(f.store.listPending(f.member.id).at(-1)!.id);
    f.service.networkFailure(f.member); f.restart(); f.now += 30_000; await f.recover();
    expect(f.service.holdReason(f.member.id)).toBe("api_outage");
    expect(f.notices.filter(n => n.includes("3회 실패"))).toHaveLength(1);
    f.now += 20 * MIN; await f.service.tick(); expect(resumes(f)).toBe(4);
    f.now += 11 * MIN; await f.service.tick(); expect(resumes(f)).toBe(5);
    // 성공한 턴이 오면 처음부터 다시 센다.
    f.store.markDelivered(f.store.listPending(f.member.id).at(-1)!.id);
    f.service.completed(f.member.id);
    expect(f.service.holdReason(f.member.id)).toBeNull();
    f.now += MIN; f.service.networkFailure(f.member); await f.recover();
    expect(resumes(f)).toBe(6); expect(f.service.holdReason(f.member.id)).toBeNull();
  });

  test("포기한 직원은 대표의 다시 확인이나 그 뒤에 보낸 말로 풀리고, 장애가 진행 중이면 풀지 않는다", async () => {
    // 전달의 생성 시각은 실제 시계다. 포기 시각이 그보다 앞서도록 가짜 시계를 과거에 둔다.
    const f = fixture(); f.now = Date.now() - 60 * MIN;
    const old = f.enqueue(); await exhausted(f);
    expect(f.service.releaseForOwnerInput(f.member.id, f.store.listPending(f.member.id))).toBe(false);
    const said = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "user_message", text: "[대표] 이어서 해 주세요" });
    expect(f.service.releaseForOwnerInput(f.member.id, f.store.listPending(f.member.id))).toBe(true);
    expect(f.service.holdReason(f.member.id)).toBeNull();
    expect(f.store.listPending(f.member.id).map(d => d.id)).toEqual(expect.arrayContaining([old.id, said.id]));
    f.restart(); expect(f.service.holdReason(f.member.id)).toBeNull();

    // 포기하기 전에 와 있던 말은 근거가 아니다(가짜 시계를 미래에 둔다). 다시 확인은 언제든 푼다.
    const g = fixture(); g.now = Date.now() + 60 * MIN;
    g.store.enqueue({ projectId: g.project.id, memberId: g.member.id, kind: "user_message", text: "[대표] 먼저 와 있던 말" });
    await exhausted(g, false);
    expect(g.service.outage()).not.toBeNull();
    expect(g.service.releaseExhausted(g.member.id)).toBe(false);
    await g.recover();
    expect(g.service.releaseForOwnerInput(g.member.id, g.store.listPending(g.member.id))).toBe(false);
    expect(g.service.holdReason(g.member.id)).toBe("api_outage");
    expect(g.service.releaseExhausted(g.member.id)).toBe(true);
    expect(g.service.holdReason(g.member.id)).toBeNull();
  });

  test("한도 자동 이어가기가 화면 읽기 실패로 못 나가면 간격을 두고 다시 시도한다", async () => {
    const f = fixture(), m = f.makeMember("codex", "codex");
    f.service.usageFailure(m, "You've hit your usage limit. try again in 1m");
    f.inspect = async () => { throw new Error("terminal.read: no reply"); };
    f.now += 2 * MIN + 1; await f.service.tick();
    expect(f.store.listPending(m.id)).toHaveLength(0);
    expect(f.card("codex").detail).toContain("창을 닫지 못했습니다");
    expect(f.service.holdReason(m.id)).toBe("usage_limit");
    f.inspect = async () => ({ menu: null, state: "error" });
    f.now += 30_000; await f.service.tick();
    expect(f.store.listPending(m.id)).toHaveLength(0);
    f.restart(); f.now += 31_000; await f.service.tick();
    expect(f.store.listPending(m.id).map(d => d.text)).toEqual([USAGE_RESUME_TEXT]);
    expect(f.service.holdReason(m.id)).toBeNull();
  });

  test("잠든 직원은 닫을 창이 없으므로 '이어가기'를 누르면 이어가기만 넣고 상태를 깨어 있는 것처럼 바꾸지 않는다", async () => {
    const f = fixture(), menu = usageLimitMenu(menuText(), f.now)!;
    f.service.usageFailure(f.member, menu.raw, menu);
    f.store.patchMember(f.member.id, { status: "asleep", paneId: null });
    f.inspect = async () => { throw new NoTerminalError(); };
    await f.service.resumeUsage(f.card().id);
    expect(f.dismissed).toHaveLength(0);
    expect(f.store.listPending(f.member.id).map(d => d.text)).toEqual([USAGE_RESUME_TEXT]);
    expect(f.store.requireMember(f.member.id)).toMatchObject({ status: "asleep", blockedReason: null, lastError: null });
    expect(f.service.holdReason(f.member.id)).toBeNull();
    expect(f.pumps).toContain(f.member.id);
  });

  // a176ecf 리뷰 F4: 한도로 멈춘 팀장을 재운 뒤(대표나 총괄이 일부러) 자동 이어가기가 그 팀장을 스스로 깨워 멈춘 일을 다시 시켰다.
  // 잠든 팀장은 그대로 잔다(재시작 깨우기와 같은 원칙). 카드의 '이어가기'와 모델 변경만 깨운다.
  test("잠든 직원은 자동 이어가기가 깨우지 않는다. 카드에 남고, 대표가 '이어가기'를 누르면 그때 깨운다", async () => {
    const f = fixture(), menu = usageLimitMenu(menuText(), f.now)!;
    f.service.usageFailure(f.member, menu.raw, menu);
    f.store.patchMember(f.member.id, { status: "asleep", paneId: null });
    f.inspect = async () => { throw new NoTerminalError(); };
    for (const at of [Date.parse(menu.resetsAt!) + 61_000, Date.parse(menu.resetsAt!) + 8 * 3_600_000]) {
      f.now = at; await f.service.tick();
      expect(f.store.listPending(f.member.id)).toHaveLength(0);
      expect(f.pumps).not.toContain(f.member.id);
      expect(f.service.holdReason(f.member.id)).toBe("usage_limit");
    }
    expect(f.card()).toMatchObject({ status: "open", usageLimit: { memberIds: [f.member.id] } });
    await f.service.resumeUsage(f.card().id);
    expect(f.store.listPending(f.member.id).map(d => d.text)).toEqual([USAGE_RESUME_TEXT]);
    expect(f.pumps).toContain(f.member.id);
  });

  // a176ecf 리뷰 F2: 재우기·모델 변경 전에 한도 메뉴를 Esc 로 닫는 동안 저장되는 dismissStarted 를 틱이 '대표가 누른 이어가기'로 읽어,
  // 같은 카드의 다른 팀장에게까지 Esc 와 이어가기 글을 넣었다(서버가 그 사이 죽으면 다시 뜬 뒤 첫 틱이 그랬다).
  test("한 팀장의 메뉴를 닫는 동안 틱은 그 카드를 이어 가지 않는다: 다른 팀장에게 Esc·이어가기가 가지 않고, 닫는 표시는 저장되지 않는다", async () => {
    const f = fixture(), other = f.makeMember("other"), menu = usageLimitMenu(menuText(), f.now)!;
    f.service.usageFailure(f.member, menu.raw, menu);
    f.service.usageFailure(other, menu.raw, menu);
    let escSent = false;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    // 닫는 팀장의 메뉴는 Esc 뒤에 사라졌고(닫혔는지 확인을 기다리는 중), 다른 팀장의 메뉴는 그대로다.
    f.inspect = async m => m.id === f.member.id && escSent ? { menu: null, state: "error" } : { menu, state: "blocked" };
    f.dismiss = async m => { if (m.id === f.member.id) { escSent = true; await gate; } return { ok: true }; };
    const closed = f.service.closeMenu(f.member);
    while (!escSent) await Bun.sleep(1);
    // 닫는 표시는 메모리에만 있다: 서버가 지금 죽어도 다시 뜬 서버는 수동 이어가기로 오인하지 않는다.
    expect(JSON.stringify(f.store.loadApiRecovery("api_recovery"))).not.toContain("dismissStarted\":true");
    f.now += 10_000; await f.service.tick();
    f.now += 10_000; await f.service.tick();
    expect(f.dismissed).toHaveLength(1);
    expect(f.store.listPending(f.member.id)).toHaveLength(0);
    expect(f.store.listPending(other.id)).toHaveLength(0);
    expect(f.service.holdReason(f.member.id)).toBe("usage_limit");
    expect(f.service.holdReason(other.id)).toBe("usage_limit");
    finish();
    expect(await closed).toMatchObject({ ok: true, closed: true });
    // 닫은 뒤에도 메뉴가 사라진 것을 '대표가 직접 풀었다'로 읽지 않는다.
    f.now += 10_000; await f.service.tick();
    expect(f.service.holdReason(f.member.id)).toBe("usage_limit");
    expect(f.store.listPending(other.id)).toHaveLength(0);
    expect(f.card().usageLimit?.memberIds.sort()).toEqual([f.member.id, other.id].sort());
  });

  test("서버가 이어가기를 넣지 않았어도 성공한 턴이면 한도 보류를 푼다", () => {
    const f = fixture(), m = f.makeMember("codex", "codex"); const d = f.enqueue(m);
    f.service.usageFailure(m, "usage limit reached: unknown reset raw");
    expect(f.store.requireDelivery(d.id).holdReason).toBe("usage_limit");
    f.service.completed(m.id);
    expect(f.service.holdReason(m.id)).toBeNull();
    expect(f.card("codex")).toMatchObject({ status: "closed", usageLimit: { memberIds: [] } });
    expect(f.store.requireMember(m.id)).toMatchObject({ blockedReason: null, lastError: null });
    expect(f.store.requireMember(m.id).statusObservation?.error ?? null).toBeNull();
    f.restart(); expect(f.service.holdReason(m.id)).toBeNull();
  });

  test("초기화 시각을 모르고 대표가 카드를 닫아도 한 시간 뒤부터 자동으로 이어 보고, 다시 걸리면 간격을 벌린다", async () => {
    const f = fixture(), m = f.makeMember("codex", "codex"), raw = "usage limit reached: unknown reset raw";
    f.service.usageFailure(m, raw);
    f.store.setDecisionStatus(f.card("codex").id, "closed");
    f.now += 59 * MIN; await f.service.tick();
    expect(resumes(f, USAGE_RESUME_TEXT)).toBe(0); expect(f.service.holdReason(m.id)).toBe("usage_limit");
    f.restart(); f.now += 2 * MIN; await f.service.tick();
    expect(resumes(f, USAGE_RESUME_TEXT)).toBe(1); expect(f.service.holdReason(m.id)).toBeNull();
    // 이어 봤지만 아직 한도다: 한 시간 뒤에 다시, 그다음은 두 시간 뒤.
    const first = f.store.listPending(m.id)[0]!; f.store.markDelivered(first.id); f.service.received(first.id);
    f.service.usageFailure(m, raw);
    expect(f.service.holdReason(m.id)).toBe("usage_limit");
    f.now += 59 * MIN; await f.service.tick(); expect(resumes(f, USAGE_RESUME_TEXT)).toBe(1);
    f.now += 2 * MIN; await f.service.tick(); expect(resumes(f, USAGE_RESUME_TEXT)).toBe(2);
    const second = f.store.listPending(m.id)[0]!; f.store.markDelivered(second.id); f.service.received(second.id);
    f.service.usageFailure(m, raw);
    f.now += 61 * MIN; await f.service.tick(); expect(resumes(f, USAGE_RESUME_TEXT)).toBe(2);
    f.now += 60 * MIN; await f.service.tick(); expect(resumes(f, USAGE_RESUME_TEXT)).toBe(3);
  });
});

// 2026-11-13 대표 지적: 사용 한도 카드가 계정을 여러 개 쓰는 사람에게만 맞춰져 있었다(버튼이 '계정을 바꿨어요 · 모두 이어가기' 하나).
// 계정이 하나인 사람은 기다리면 되고, 특정 모델의 크레딧만 떨어졌으면 다른 모델로 바꾸면 바로 된다.
describe("사용 한도 카드: 계정 수를 가정하지 않는 글과 모델 선택지", () => {
  const LIVE = "You're out of usage credits. Run /usage-credits to keep using Fable 5.2 or /model to switch models.";
  const OPUS = { k: "model:opus", label: "Opus로 바꿔 이어가기" }, SONNET = { k: "model:sonnet", label: "Sonnet으로 바꿔 이어가기" };
  // a176ecf 리뷰 F7: 출시된 iPhone(0.2.2·0.2.3)에는 모델 버튼이 없다. 앱 판과 상관없이 되는 길(팀장 설정, 총괄)도 함께 적는다.
  const HINT = "(고를 버튼이 없으면 팀장 설정에서 모델을 바꾸거나 총괄에게 모델을 바꿔 이어 가라고 하세요)";
  const COMMON = `바로 이어 가려면 다른 모델을 고르세요${HINT}. 다른 계정으로 로그인했거나 한도를 늘렸다면 '이어가기'를 누르세요.`;
  const lead = (f: ReturnType<typeof fixture>) => f.card().detail.split("\n\n")[0];

  test("로/으로, 모델 크레딧 소진 판별, 글에 이름이 나온 한도 모델", () => {
    expect(["Opus", "Sonnet", "Haiku", "Fable 5.2", "gpt-6.1-sol", "gpt-6-luna", "CLI 기본 모델", "오푸스", "별", "3", "Opus 4.7"].map(withRo))
      .toEqual(["Opus로", "Sonnet으로", "Haiku로", "Fable 5.2로", "gpt-6.1-sol로", "gpt-6-luna로", "CLI 기본 모델로", "오푸스로", "별로", "3으로", "Opus 4.7로"]);
    expect(modelCreditLimit(LIVE)).toEqual({ model: "Fable 5.2" });
    expect(modelCreditLimit("Run /usage-credits to keep using Opus 4.7.")).toEqual({ model: "Opus 4.7" });
    expect(modelCreditLimit("You're out of usage credits. Use /model to switch models.")).toEqual({ model: null });
    expect(modelCreditLimit("You've hit your weekly limit · resets Nov 13 at 10am (Asia/Seoul)")).toBeNull();
    expect(limitedModelName(LIVE)).toBe("Fable 5.2");
    expect(limitedModelName("You've hit your Opus limit · resets Nov 13 at 10am (Asia/Seoul)")).toBe("Opus");
    expect(limitedModelName("You've hit your weekly limit")).toBeNull();
    expect(classifyTurnError(LIVE)).toBe("usage_limit");
  });

  test("모델 크레딧 소진: 그 모델 이름과 '다른 모델로 바꾸면 바로'를 먼저 말하고, 선택지는 모델 먼저·이어가기(키 resume) 마지막", () => {
    const f = fixture();
    f.options.choices = () => [OPUS, SONNET];
    f.service.usageFailure(f.member, LIVE);
    expect(lead(f)).toBe(`Fable 5.2 사용 크레딧이 떨어졌습니다. 다른 모델로 바꾸면 바로 이어 갑니다. 기다리면 크레딧이 채워질 때 자동으로 이어 갑니다. ${COMMON}`);
    expect(f.card().options).toEqual([OPUS, SONNET, USAGE_RESUME_OPTION]);
    expect(USAGE_RESUME_OPTION).toEqual({ k: "resume", label: "계정을 바꿨거나 한도를 늘렸어요 · 이어가기" });
    expect(f.card().detail).not.toContain("같은 계정");
  });

  test("모델에 한정된 한도에서: 초기화 시각을 알 때·모를 때·선택할 모델이 없을 때·이어가기 뒤 또 걸렸을 때", async () => {
    // 'Opus limit' 은 그 모델만의 한도다(다른 모델로 바꾸면 바로 된다).
    const known = fixture(), menu = usageLimitMenu(menuText().replace("weekly limit", "Opus limit"), known.now)!;
    known.options.choices = () => [SONNET];
    known.service.usageFailure(known.member, menu.raw, menu);
    expect(lead(known)).toMatch(new RegExp(`^\\d+월 \\d+일 오[전후] \\d+시에 한도가 풀리면 자동으로 이어 갑니다\\. 기다리셔도 됩니다\\. ${COMMON.replace(/[.'?()]/g, "\\$&")}$`));
    const unknown = fixture();
    unknown.options.choices = () => [SONNET];
    unknown.service.usageFailure(unknown.member, "You've hit your Opus limit");
    expect(lead(unknown)).toBe(`한도가 풀렸는지 가끔 다시 확인해 자동으로 이어 갑니다. 기다리셔도 됩니다. ${COMMON}`);
    const none = fixture();
    none.service.usageFailure(none.member, "You've hit your Opus limit");
    expect(lead(none)).toBe("한도가 풀렸는지 가끔 다시 확인해 자동으로 이어 갑니다. 기다리셔도 됩니다. 다른 계정으로 로그인했거나 한도를 늘렸다면 '이어가기'를 누르세요.");
    expect(none.card().options).toEqual([USAGE_RESUME_OPTION]);
    // 이어가기를 눌렀는데 또 걸렸다.
    known.inspect = async () => ({ menu, state: "blocked" });
    await known.service.resumeUsage(known.card().id);
    known.service.usageFailure(known.member, menu.raw, menu);
    expect(known.card()).toMatchObject({ status: "open", usageLimit: { stillLimited: true } });
    expect(lead(known)).toBe(`아직 한도가 남아 있지 않습니다. 기다리거나 다른 모델을 고르세요${HINT}.`);
  });

  // a176ecf 리뷰 F1: 5시간·주간·이름 없는 한도와 Codex 한도는 계정 전체의 한도다. 다른 모델로 바꿔도 곧바로 다시 걸리고 모델 지정만 낮아진 채 남는다.
  test("계정 전체의 한도(5시간·주간·이름 없는 한도·Codex)에는 모델 선택지를 내지 않고 '다른 모델을 고르세요'라고 하지 않는다", async () => {
    for (const [raw, cli] of [["You've hit your 5-hour limit · resets 3pm (Asia/Seoul)", "claude"], ["You've hit your weekly limit", "claude"], ["usage limit reached", "claude"], ["You've hit your usage limit. try again in 1m", "codex"]] as const) {
      const f = fixture(), m = cli === "codex" ? f.makeMember("codex", "codex") : f.member;
      f.options.choices = () => [OPUS, SONNET];
      f.service.usageFailure(m, raw);
      expect({ raw, options: f.card(cli).options }).toEqual({ raw, options: [USAGE_RESUME_OPTION] });
      expect(f.card(cli).detail).not.toContain("다른 모델");
      // 이어가기 뒤 또 걸려도 모델을 고르라고 하지 않는다.
      f.inspect = async () => ({ menu: null, state: "error" });
      await f.service.resumeUsage(f.card(cli).id);
      f.service.usageFailure(m, raw);
      expect(f.card(cli).detail.split("\n\n")[0]).toBe("아직 한도가 남아 있지 않습니다. 한도가 풀리면 자동으로 이어 갑니다.");
    }
  });

  test("카드에서 한 번 걸린 모델은 그 팀장이 카드에서 빠져도 다시 내지 않는다(서버가 기억한다, 다시 띄워도)", () => {
    const f = fixture(), second = f.makeMember("second");
    const seen: string[][] = [];
    f.options.limitedModels = (m, raw) => [m.id === f.member.id ? "claude-fable-5-2" : "sonnet", ...(raw.includes("Opus") ? ["opus"] : [])];
    f.options.choices = (_cli, _limited, blocked) => { seen.push([...blocked].sort()); return []; };
    f.service.usageFailure(f.member, LIVE);
    f.service.usageFailure(second, "You've hit your Sonnet limit");
    expect(seen.at(-1)).toEqual(["claude-fable-5-2", "sonnet"]);
    f.service.releaseMember(f.member.id);
    expect(seen.at(-1)).toEqual(["claude-fable-5-2", "sonnet"]);
    f.restart();
    f.service.usageFailure(f.member, "You've hit your Opus limit");
    expect(seen.at(-1)).toEqual(["claude-fable-5-2", "opus", "sonnet"]);
  });

  test("팀장이 빠지거나 모델 목록이 바뀌면 선택지를 다시 계산한다. 판(updatedAt)은 그대로라 카드의 푸시 알림이 취소되지 않는다", () => {
    const f = fixture(), second = f.makeMember("second");
    let catalog = [OPUS, SONNET];
    // 카드의 팀장이 둘이면 둘째가 쓰던 sonnet 도 한도에 걸린 모델이다.
    f.options.choices = (_cli, limited) => catalog.filter(o => !(o === SONNET && limited.some(l => l.memberId === second.id)));
    f.service.usageFailure(f.member, LIVE); f.service.usageFailure(second, LIVE);
    const before = f.card();
    expect(before.options).toEqual([OPUS, USAGE_RESUME_OPTION]);
    f.service.releaseMember(second.id);
    const after = f.card();
    expect(after.options).toEqual([OPUS, SONNET, USAGE_RESUME_OPTION]);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.usageLimit?.memberIds).toEqual([f.member.id]);
    catalog = [SONNET];
    f.service.noteFailure(f.member.id, "모델을 바꾸지 못했습니다(시험)");
    expect(f.card().options).toEqual([SONNET, USAGE_RESUME_OPTION]);
    expect(f.card().detail).toContain("worker — 모델을 바꾸지 못했습니다(시험)");
  });
});
