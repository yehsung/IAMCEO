import { HerdrRunner, inputLooksEmpty, screenContextPct } from "../server/runner/herdr.ts";
import { CoreRunner } from "../server/runner/core.ts";
import { transcriptPath } from "../server/runner/transcript.ts";
import { capturedContext, readContextRecord, STATUSLINE_MARKER, writeStatuslineWrapper } from "../server/runner/statusline.ts";
import { readCodexContext } from "../server/runner/codex-context.ts";
// 문맥 % 의 창 크기: 배우기·맞추기·고르는 순서·저장·초기화. 임시 IAMCEO_HOME 만 쓴다(라이브 홈·herdr 소켓을 건드리지 않는다).
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Backend, ContextWindowSource, Member } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { contextWindowFor, DEFAULT_CONTEXT_WINDOW, inferContextWindow, KNOWN_CONTEXT_WINDOWS, measureContext } from "../server/runner/context.ts";
import { StreamParser } from "../server/runner/headless.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function tempHome(prefix = "iamceo-ctx-"): { home: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"], coreBin: join(home, "missing-core") }, env);
  return { home, env };
}

async function waitFor<T>(what: string, read: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > until) throw new Error(`시간 초과: ${what}`);
    await Bun.sleep(10);
  }
}

describe("창 크기 배우기: 상태줄 % 와 토큰 수", () => {
  test("반올림 오차 안의 실측 후보로 맞춘다", () => {
    expect(KNOWN_CONTEXT_WINDOWS).toEqual([200_000, 258_400, 475_000, 1_000_000]);
    // 실측 상태줄 "27% │ 268K/1.0M"
    expect(inferContextWindow(268_000, 27)).toBe(1_000_000);
    // 보고된 세션: 55만 토큰이 55%
    expect(inferContextWindow(550_000, 55)).toBe(1_000_000);
    // 가짜 칸 "27% │ 54K/200K"
    expect(inferContextWindow(54_000, 27)).toBe(200_000);
    expect(inferContextWindow(190_000, 19)).toBe(1_000_000);
    expect(inferContextWindow(190_000, 95)).toBe(200_000);
  });

  test("반올림 오차 밖은 충분히 높은 % 에서만 추정하고 새 크기도 배운다", () => {
    expect(inferContextWindow(65_000, 10)).toBe(650_000);
    expect(inferContextWindow(129_200, 50)).toBe(258_400);
    expect(inferContextWindow(237_500, 50)).toBe(475_000);
    expect(inferContextWindow(136_000, 50)).toBe(272_000);
    expect(inferContextWindow(250_000, 50)).toBe(500_000);
    expect(inferContextWindow(20_000, 40)).toBeNull();
    expect(inferContextWindow(1_000, 50)).toBeNull();
    expect(inferContextWindow(54_000, 100)).toBeNull();
    expect(inferContextWindow(190_000, 100)).toBeNull();
    expect(inferContextWindow(5_000_000, 10)).toBeNull();
    expect(inferContextWindow(1_000_000, 10)).toBe(10_000_000);
    expect(inferContextWindow(24_000, 3)).toBeNull();
    expect(inferContextWindow(20_000, 2)).toBeNull();
    expect(inferContextWindow(30_000, 3)).toBe(1_000_000);
    for (const [tokens, pct] of [[null, 27], [54000, null], [0, 27], [54000, 101], [NaN, 27]]) {
      expect(inferContextWindow(tokens!, pct!)).toBeNull();
    }
  });
});

describe("창 크기 고르는 순서", () => {
  const hints = (o: Partial<{ learned: number | null; source: ContextWindowSource | null; model: string | null; fallback: number }> = {}) => ({ learned: null, model: null, fallback: DEFAULT_CONTEXT_WINDOW, ...o });

  test("저장된 실측 > 명시된 [1m] > 저장된 추정 > 모델 표 > 설정 기본값", () => {
    // 1. 실측만 명시된 [1m] 보다 먼저다.
    expect(contextWindowFor(50_000, hints({ learned: 200_000, model: "opus[1m]" }))).toBe(1_000_000);
    expect(contextWindowFor(50_000, hints({ learned: 200_000, source: "screen", model: "opus[1m]" }))).toBe(1_000_000);
    for (const source of ["statusline", "codex", "headless"] as const) {
      expect(contextWindowFor(50_000, hints({ learned: 200_000, source, model: "opus[1m]" }))).toBe(200_000);
      expect(contextWindowFor(300_000, hints({ learned: 200_000, source, model: "opus[1m]" }))).toBe(1_000_000);
    }
    expect(contextWindowFor(50_000, hints({ learned: 1_000_000, fallback: 200_000 }))).toBe(1_000_000);
    // 2. [1m]
    expect(contextWindowFor(50_000, hints({ model: "claude-opus-4-6[1m]", fallback: 200_000 }))).toBe(1_000_000);
    expect(contextWindowFor(50_000, hints({ model: "Opus[1M]", fallback: 200_000 }))).toBe(1_000_000);
    expect(contextWindowFor(50_000, { ...hints({ model: "opus[1m]" }), windows: { "opus[1m]": 200_000 } })).toBe(1_000_000);
    expect(contextWindowFor(50_000, hints({ learned: 200_000, source: "screen", model: "gpt-6-astra" }))).toBe(200_000);
    // 3. 기본값을 넘으면 토큰을 담을 수 있는 알려진 창으로 올린다
    expect(contextWindowFor(200_001, hints({ fallback: 200_000 }))).toBe(258_400);
    expect(contextWindowFor(200_000, hints({ fallback: 200_000 }))).toBe(200_000);
    // 4. 설정 기본값
    expect(contextWindowFor(50_000, hints({ model: "claude-opus-5-5", fallback: 200_000 }))).toBe(200_000);
    expect(contextWindowFor(50_000, hints({ model: "claude-opus-5-5" }))).toBe(1_000_000);
    expect(contextWindowFor(50_000, hints({ fallback: 0 }))).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("토큰이 배운 값을 넘으면 그 값은 지난 모델의 것이라 쓰지 않는다", () => {
    expect(contextWindowFor(300_000, hints({ learned: 200_000 }))).toBe(1_000_000);
  });

  test("명시된 [1m] 은 저장된 화면 추정보다 먼저이고 보이는 % 는 바로 쓴다", () => {
    const hints = { learned: 200_000, source: "screen" as const, fallback: DEFAULT_CONTEXT_WINDOW };
    const reading = { tokens: 150_000, shownPct: null, model: "opus[1m]" };
    expect(measureContext(reading, hints)).toEqual({ pct: 15, learned: null });
    expect(measureContext({ ...reading, shownPct: 75 }, hints)).toEqual({ pct: 75, learned: 200_000, source: "screen" });
  });

  test("상태줄 % 가 있으면 그것이 답이고, 없으면 토큰을 창 크기로 나눈다", () => {
    expect(measureContext({ tokens: 54_000, shownPct: 27, model: null }, { learned: null, fallback: DEFAULT_CONTEXT_WINDOW })).toEqual({ pct: 27, learned: 200_000, source: "screen" });
    // 표에 없는 창도 높은 % 에서는 배운다
    expect(measureContext({ tokens: 250_000, shownPct: 50, model: null }, { learned: null, fallback: DEFAULT_CONTEXT_WINDOW })).toEqual({ pct: 50, learned: 500_000, source: "screen" });
    expect(measureContext({ tokens: null, shownPct: 40, model: null }, { learned: null, fallback: DEFAULT_CONTEXT_WINDOW })).toEqual({ pct: 40, learned: null });
    expect(measureContext({ tokens: 150_000, shownPct: null, model: null }, { learned: 200_000, fallback: DEFAULT_CONTEXT_WINDOW })).toEqual({ pct: 75, learned: null });
    expect(measureContext({ tokens: null, shownPct: null, model: null }, { learned: null, fallback: DEFAULT_CONTEXT_WINDOW })).toBeNull();
  });

  test("회귀: 190k 토큰, [1m] 없는 1M 모델, 상태줄 안 보임 → 약 19% (95% 가 아니다)", () => {
    const reading = { tokens: 190_000, shownPct: null, model: "claude-opus-5-5" };
    expect(measureContext(reading, { learned: null, fallback: DEFAULT_CONTEXT_WINDOW })).toEqual({ pct: 19, learned: null });
    // 1M 을 한 번 배운 직원도 같다
    expect(measureContext(reading, { learned: 1_000_000, fallback: 200_000 })!.pct).toBe(19);
    // 기본값을 200k 로 바꾼 설치에서만 예전처럼 잰다
    expect(measureContext(reading, { learned: null, fallback: 200_000 })!.pct).toBe(95);
  });
});

describe("저장과 초기화", () => {
  function store() {
    const { env } = tempHome();
    const config = loadConfig(env);
    const db = openDb(config.dbPath);
    const s = new Store(db, new Bus());
    const p = s.createProject({ name: "창 시험", cwd: config.home });
    const m = s.createMember({ projectId: p.id, handle: "w", name: "직원", kind: "worker", backend: "herdr", sessionId: "s1", paneId: "p1" });
    return { s, m, db, config };
  }

  test("배운 창 크기는 재시작 뒤에도 남는다", () => {
    const t = store();
    expect(t.m.contextWindow).toBeNull();
    t.s.patchMember(t.m.id, { contextWindow: 1_000_000, contextWindowSource: "statusline", contextPct: 19 });
    t.db.close();
    const again = new Store(openDb(t.config.dbPath), new Bus());
    expect(again.requireMember(t.m.id)).toMatchObject({ contextWindow: 1_000_000, contextWindowSource: "statusline", contextPct: 19 });
  });

  test("세션·CLI 가 바뀌면 지우고, 같은 세션의 다른 패치·압축으로는 지우지 않는다", () => {
    const t = store();
    const learn = () => t.s.patchMember(t.m.id, { contextWindow: 1_000_000, contextWindowSource: "statusline" });
    learn();
    t.s.patchMember(t.m.id, { sessionId: "s1", contextPct: null, status: "idle" });
    expect(t.s.requireMember(t.m.id).contextWindow).toBe(1_000_000);
    t.s.patchMember(t.m.id, { sessionId: "s2" });
    expect(t.s.requireMember(t.m.id)).toMatchObject({ contextWindow: null, contextWindowSource: null });
    learn();
    t.s.patchMember(t.m.id, { sessionId: null, contextPct: null });
    expect(t.s.requireMember(t.m.id)).toMatchObject({ contextWindow: null, contextWindowSource: null });
    learn();
    t.s.patchMember(t.m.id, { cli: "codex" });
    expect(t.s.requireMember(t.m.id)).toMatchObject({ contextWindow: null, contextWindowSource: null });
    // 새 세션과 함께 배운 값을 적으면 그 값이 남는다
    t.s.patchMember(t.m.id, { sessionId: "s3", contextWindow: 200_000 });
    expect(t.s.requireMember(t.m.id).contextWindow).toBe(200_000);
  });

  test("세션에 들어간 모델이 바뀌면 지우고, 같은 모델이면 둔다", () => {
    const t = store();
    const cfg = (model: string | null, effort: "high" | "low" = "high") => ({ model, effort, staffModel: null, staffEffort: null });
    t.s.setAppliedConfig(t.m.id, cfg("opus"));
    t.s.patchMember(t.m.id, { contextWindow: 1_000_000, contextWindowSource: "statusline" });
    t.s.setAppliedConfig(t.m.id, cfg("opus", "low"));
    expect(t.s.requireMember(t.m.id).contextWindow).toBe(1_000_000);
    t.s.setAppliedConfig(t.m.id, cfg("sonnet", "low"));
    expect(t.s.requireMember(t.m.id)).toMatchObject({ contextWindow: null, contextWindowSource: null });
  });

  test("CLI 교체(세션 보관·회전)도 지운다", () => {
    const t = store();
    t.s.patchMember(t.m.id, { contextWindow: 1_000_000, contextWindowSource: "statusline" });
    t.s.archiveAndRotateSession(t.m.id, "codex");
    expect(t.s.requireMember(t.m.id)).toMatchObject({ contextWindow: null, contextPct: null, sessionId: null });
  });

  for (const fromHead of [false, true]) test(`마이그레이션 ${fromHead ? "HEAD" : "N-1"}: 창 크기 칸을 더하고, herdr 가 부풀려 적은 % 는 비운다(headless 값은 둔다)`, () => {
    const path = join(mkdtempSync(join(tmpdir(), "iamceo-ctx-migrate-")), "old.db");
    const before = MIGRATIONS.findIndex((m) => m.includes(fromHead ? "chief_cli" : "context_window"));
    expect(before).toBe(fromHead ? 12 : MIGRATIONS.length - 1);
    const db = new Database(path, { create: true });
    db.exec("PRAGMA foreign_keys = ON");
    for (let v = 0; v < before; v++) db.exec(MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${before}`);
    const at = "2026-01-01T00:00:00.000Z";
    db.query("INSERT INTO projects (id, name, is_hq, cwd, runner_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run("p_a", "에이", 0, "/a", 1, at, at);
    const member = db.query("INSERT INTO members (id, project_id, handle, name, kind, origin, status, cwd, session_id, context_pct, backend, token, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    member.run("m_h", "p_a", "h", "칸 직원", "worker", "runner", "idle", "/a", "s1", 96, "herdr", "t1", at, at);
    member.run("m_l", "p_a", "l", "헤드리스", "worker", "runner", "idle", "/a", "s2", 42, "headless", "t2", at, at);
    member.run("m_n", "p_a", "n", "옛 직원", "worker", "runner", "idle", "/a", "s3", 73, null, "t3", at, at);
    db.close();

    const s = new Store(openDb(path), new Bus());
    expect(s.chiefCli("p_a")).toBe("claude");
    expect(s.requireMember("m_h")).toMatchObject({ contextPct: null, contextWindow: null, contextWindowSource: null });
    expect(s.requireMember("m_l")).toMatchObject({ contextPct: 42, contextWindow: null, contextWindowSource: null });
    expect(s.requireMember("m_n")).toMatchObject({ contextPct: null, contextWindow: null, contextWindowSource: null });
    expect(s.getSettings().contextWindowDefault).toBe(1_000_000);
    expect(s.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(MIGRATIONS.length);
    s.db.close();
  });
});

describe("headless: modelUsage 에 창 크기가 없을 때만 서버가 정한다", () => {
  const usage = (tokens: number) => JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "끝" }], usage: { input_tokens: tokens } } });

  test("창 크기를 알면 context, 모르면 context_usage", () => {
    const events: RunnerEvent[] = [];
    const known = new StreamParser("m", (e) => events.push(e), { reportContext: true, contextWindow: null });
    known.feed(usage(190_000));
    known.feed(JSON.stringify({ type: "result", subtype: "success", result: "끝", modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000 } } }));
    expect(events.filter((e) => e.type === "context" || e.type === "context_usage")).toEqual([{ type: "context", memberId: "m", pct: 19, window: 1_000_000 }]);

    events.length = 0;
    const unknown = new StreamParser("m", (e) => events.push(e), { reportContext: true, contextWindow: null });
    unknown.feed(usage(190_000));
    unknown.feed(JSON.stringify({ type: "result", subtype: "success", result: "끝" }));
    expect(events.filter((e) => e.type === "context" || e.type === "context_usage")).toEqual([{ type: "context_usage", memberId: "m", tokens: 190_000, shownPct: null, model: "claude-opus-5-5" }]);

    events.length = 0;
    const quiet = new StreamParser("m", (e) => events.push(e), { reportContext: false, contextWindow: null });
    quiet.feed(usage(190_000));
    quiet.feed(JSON.stringify({ type: "result", subtype: "success", result: "끝" }));
    expect(events.filter((e) => e.type === "context" || e.type === "context_usage")).toEqual([]);
  });
});

// 서버 처리: 칸 실행기 자리에 가짜를 끼워 턴 끝 사용량을 흘린다.
class UsageRunner implements Runner {
  readonly kind = "herdr" as const;
  sent: string[] = [];
  compacts: string[] = [];
  private cb: (e: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember, _o: StartOpts) { return { sessionId: m.sessionId ?? crypto.randomUUID(), paneId: "p1", tabId: "tab1" }; }
  async send(_m: RunnerMember, text: string): Promise<SendResult> { this.sent.push(text); return { ok: true }; }
  isBusy() { return false; }
  async compact(_m: RunnerMember, focus: string): Promise<SendResult> { this.compacts.push(focus); return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop() {}
  async screen() { return ""; }
  on(cb: (e: RunnerEvent) => void) { this.cb = cb; }
  async shutdown() {}
  emit(e: RunnerEvent) { this.cb(e); }
  async reattach() { return null; }
}

async function server(home?: { home: string; env: Record<string, string> }) {
  const h = home ?? tempHome();
  const config = loadConfig(h.env);
  const bus = new Bus();
  const db = openDb(config.dbPath);
  const store = new Store(db, bus);
  const runner = new UsageRunner();
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>([["herdr", runner]]), timings: { tickMs: 60_000, healthMs: 60_000 } });
  store.patchSettings({ backend: "herdr" });
  const http: RunningServer = await startServer({ config, store, bus, orch });
  orch.setServerUrl(http.urls[0]!);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await orch.shutdown();
    await http.stop();
    db.close();
  };
  cleanups.push(close);
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${http.urls[0]}${path}`, { method, headers: { Authorization: "Bearer code", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  return { home: h, store, runner, orch, api, close };
}

type Server = Awaited<ReturnType<typeof server>>;

async function worker(t: Server): Promise<Member> {
  const project = t.store.listProjects().find((p) => p.name === "창 시험") ?? t.store.createProject({ name: "창 시험", cwd: t.home.home });
  return (await t.orch.addMember(project.id, { name: "플레이스토어", handle: "store" })).member;
}

/** 턴을 하나 돌린다: 대표 지시를 보내고, 실행기가 사용량과 턴 끝을 알린다. */
async function turn(t: Server, m: Member, usage: { tokens: number | null; shownPct: number | null; model?: string | null }) {
  const sent = t.runner.sent.length;
  await t.orch.assign(m.projectId, m.handle, { text: "일" });
  await waitFor("전달", () => t.runner.sent.length > sent);
  t.runner.emit({ type: "context_usage", memberId: m.id, tokens: usage.tokens, shownPct: usage.shownPct, model: usage.model ?? null });
  t.runner.emit({ type: "turn_end", memberId: m.id, finalText: "", isError: false });
  await waitFor("쉼", () => t.store.requireMember(m.id).status === "idle");
}

describe("서버: 턴 끝 사용량으로 % 를 정하고 창 크기를 배운다", () => {
  test("회귀: 상태줄이 잘린 1M 세션(190k 토큰)은 19% 이고, 다음 일 전에 압축하지 않는다", async () => {
    const t = await server();
    const w = await worker(t);
    await turn(t, w, { tokens: 190_000, shownPct: null, model: "claude-opus-5-5" });
    expect(t.store.requireMember(w.id)).toMatchObject({ contextPct: 19, contextWindow: null });
    const sent = t.runner.sent.length;
    await t.orch.assign(w.projectId, w.handle, { text: "다음 일" });
    await waitFor("다음 일 전달", () => t.runner.sent.length > sent);
    expect(t.runner.compacts).toEqual([]);
  });

  test("상태줄이 보이면 그 직원의 창 크기를 배워 저장하고, 잘린 뒤에는 그 크기로 잰다(재시작 뒤에도)", async () => {
    const first = await server();
    const w = await worker(first);
    await turn(first, w, { tokens: 54_000, shownPct: 27 });
    expect(first.store.requireMember(w.id)).toMatchObject({ contextPct: 27, contextWindow: null });
    await turn(first, w, { tokens: 56_000, shownPct: 28 });
    expect(first.store.requireMember(w.id)).toMatchObject({ contextPct: 28, contextWindow: 200_000, contextWindowSource: "screen" });
    await first.close();

    const t = await server(first.home);
    expect(t.store.requireMember(w.id).contextWindow).toBe(200_000);
    t.runner.emit({ type: "context_usage", memberId: w.id, tokens: 150_000, shownPct: null, model: null });
    await waitFor("75%", () => t.store.requireMember(w.id).contextPct === 75);
    // 배운 200k 창에서 75% 는 압축 기준(70%)을 넘는다. 다음 일 전에 압축한다.
    await t.orch.assign(w.projectId, w.handle, { text: "다음 일" });
    await waitFor("압축", () => t.runner.compacts.length === 1);
  });

  test("새 세션이 열리면 배운 값을 지우고 다시 배운다", async () => {
    const t = await server();
    const w = await worker(t);
    await turn(t, w, { tokens: 268_000, shownPct: 27 });
    expect(t.store.requireMember(w.id).contextWindow).toBeNull();
    await turn(t, w, { tokens: 280_000, shownPct: 28 });
    expect(t.store.requireMember(w.id).contextWindow).toBe(1_000_000);
    t.runner.emit({ type: "session", memberId: w.id, sessionId: crypto.randomUUID() });
    await waitFor("지움", () => t.store.requireMember(w.id).contextWindow === null);
    await turn(t, w, { tokens: 54_000, shownPct: 27 });
    expect(t.store.requireMember(w.id).contextWindow).toBeNull();
    await turn(t, w, { tokens: 56_000, shownPct: 28 });
    expect(t.store.requireMember(w.id).contextWindow).toBe(200_000);
  });

  test("설정 contextWindowDefault: 기본 1M, API 로 바꾸고 범위를 검사한다", async () => {
    const t = await server();
    const w = await worker(t);
    expect((await t.api("GET", "/api/bootstrap")).body.settings.contextWindowDefault).toBe(1_000_000);
    expect((await t.api("PUT", "/api/settings", { contextWindowDefault: 200_000 })).body).toMatchObject({ contextWindowDefault: 200_000 });
    for (const bad of [0, 999, 1.5, 20_000_000, "1000000", null]) {
      expect((await t.api("PUT", "/api/settings", { contextWindowDefault: bad })).status).toBe(400);
    }
    expect(t.store.getSettings().contextWindowDefault).toBe(200_000);
    t.runner.emit({ type: "context_usage", memberId: w.id, tokens: 100_000, shownPct: null, model: "claude-opus-5-5" });
    await waitFor("50%", () => t.store.requireMember(w.id).contextPct === 50);
    // [1m] 은 기본값보다 먼저다
    t.runner.emit({ type: "context_usage", memberId: w.id, tokens: 100_000, shownPct: null, model: "opus[1m]" });
    await waitFor("10%", () => t.store.requireMember(w.id).contextPct === 10);
  });

  test("토큰이 줄고 남은 높은 % 는 다음 읽기와 다르면 배우지 않고 잘린 뒤에도 압축하지 않는다", async () => {
    const t = await server(); const w = await worker(t);
    await turn(t, w, { tokens: 40_000, shownPct: 20 });
    expect(t.store.requireMember(w.id)).toMatchObject({ contextPct: 20, contextWindow: null });
    await turn(t, w, { tokens: 45_000, shownPct: 5 });
    expect(t.store.requireMember(w.id)).toMatchObject({ contextPct: 5, contextWindow: null });
    await turn(t, w, { tokens: 150_000, shownPct: null });
    expect(t.store.requireMember(w.id)).toMatchObject({ contextPct: 15, contextWindow: null });
    const sent = t.runner.sent.length;
    await t.orch.assign(w.projectId, w.handle, { text: "다음 일" });
    await waitFor("다음 일 전달", () => t.runner.sent.length > sent);
    expect(t.runner.compacts).toEqual([]);
  });

  test("같은 토큰의 반복은 저장하지 않고 토큰이 달라진 일치 읽기만 저장한다", async () => {
    const t = await server(); const w = await worker(t);
    await turn(t, w, { tokens: 54_000, shownPct: 27 });
    await turn(t, w, { tokens: 54_000, shownPct: 27 });
    expect(t.store.requireMember(w.id)).toMatchObject({ contextPct: 27, contextWindow: null, contextWindowSource: null });
    await turn(t, w, { tokens: 56_000, shownPct: 28 });
    expect(t.store.requireMember(w.id)).toMatchObject({ contextWindow: 200_000, contextWindowSource: "screen" });
  });

  for (const window of [420_000, 424_000]) test(`화면 추정 5% 허용: 400k 다음 ${window} 은 최신 값을 쓴다`, async () => {
    const t = await server(); const w = await worker(t);
    await turn(t, w, { tokens: 200_000, shownPct: 50 });
    await turn(t, w, { tokens: window / 2, shownPct: 50 });
    expect(t.store.requireMember(w.id).contextWindow).toBe(window === 420_000 ? window : null);
    if (window === 424_000) {
      await turn(t, w, { tokens: 216_000, shownPct: 50 });
      expect(t.store.requireMember(w.id)).toMatchObject({ contextWindow: 432_000, contextWindowSource: "screen" });
    }
  });

  test("새 세션에서는 이전 후보와 같아도 다시 두 번 읽는다", async () => {
    const t = await server(); const w = await worker(t);
    await turn(t, w, { tokens: 54_000, shownPct: 27 });
    t.runner.emit({ type: "session", memberId: w.id, sessionId: crypto.randomUUID() });
    await turn(t, w, { tokens: 56_000, shownPct: 28 });
    expect(t.store.requireMember(w.id).contextWindow).toBeNull();
    await turn(t, w, { tokens: 58_000, shownPct: 29 });
    expect(t.store.requireMember(w.id)).toMatchObject({ contextWindow: 200_000, contextWindowSource: "screen" });
  });

  for (const source of ["statusline", "codex", "headless", "context"] as const) test(`실측 ${source} 읽기는 이전 화면 후보를 비운다`, async () => {
    const t = await server(); const w = await worker(t);
    const usage = { type: "context_usage" as const, memberId: w.id, tokens: 54_000, shownPct: 27, model: null };
    t.runner.emit(usage);
    if (source === "context") t.runner.emit({ type: "context", memberId: w.id, pct: 27, window: 200_000 });
    else t.runner.emit({ ...usage, exact: { window: 200_000, source } });
    expect(t.store.requireMember(w.id).contextWindowSource).toBe(source === "context" ? "headless" : source);
    // 모델 교체로 실측이 지워져도 옛 화면 후보는 되살아나지 않는다.
    t.store.setAppliedConfig(w.id, { model: "new-model", effort: null, staffModel: null, staffEffort: null });
    expect(t.store.requireMember(w.id).contextWindow).toBeNull();
    t.runner.emit({ ...usage, tokens: 56_000, shownPct: 28 });
    expect(t.store.requireMember(w.id)).toMatchObject({ contextPct: 28, contextWindow: null });
  });
});

describe("실측 우선순위", () => {
  const base = { tokens: 190_000, shownPct: 95, model: "gpt-6-astra" };
  const hints = { learned: 200_000, source: "screen" as const, fallback: 1_000_000 };
  test("새 실측 > 저장된 실측 > 화면 추정 > 저장된 추정 > 모델 표 > 기본값", () => {
    expect(measureContext({ ...base, exact: { window: 1_000_000, source: "statusline", pct: 19.3 } }, hints)).toEqual({ pct: 19.3, learned: 1_000_000, source: "statusline" });
    expect(measureContext({ ...base, tokens: 500_000, exact: { window: 475_000, source: "codex" } }, hints)).toMatchObject({ pct: 100, learned: 475_000, source: "codex" });
    expect(measureContext(base, { ...hints, learned: 1_000_000, source: "statusline" })).toEqual({ pct: 19, learned: null });
    expect(measureContext(base, hints)).toMatchObject({ learned: 200_000, source: "screen" });
    expect(measureContext({ ...base, shownPct: null }, { ...hints, learned: null })).toMatchObject({ pct: 40 });
    expect(measureContext({ ...base, shownPct: null }, { ...hints, learned: null, windows: { "gpt-6-astra": 1_000_000 } })).toMatchObject({ pct: 19 });
    expect(measureContext({ ...base, model: "unknown", shownPct: null }, { ...hints, learned: null })).toMatchObject({ pct: 19 });
    expect(measureContext({ ...base, tokens: 300_000, shownPct: null }, { ...hints, source: "codex" })).toMatchObject({ pct: 63 });
  });
  test("실측 출처는 추정으로 바뀌지 않고 새 실측으로는 바뀐다; 옛 세션 이벤트는 버린다", async () => {
    const t = await server(); const w = await worker(t);
    t.runner.emit({ type: "context_usage", memberId: w.id, ...base, exact: { window: 1_000_000, source: "statusline", pct: 19 } });
    await waitFor("실측 저장", () => t.store.requireMember(w.id).contextWindowSource === "statusline");
    t.store.patchMember(w.id, { contextWindow: 200_000, contextWindowSource: "screen" });
    expect(t.store.requireMember(w.id)).toMatchObject({ contextWindow: 1_000_000, contextWindowSource: "statusline" });
    t.runner.emit({ type: "context_usage", memberId: w.id, ...base });
    expect(t.store.requireMember(w.id)).toMatchObject({ contextPct: 19, contextWindow: 1_000_000 });
    t.runner.emit({ type: "context_usage", memberId: w.id, ...base, exact: { window: 475_000, source: "codex" } });
    await waitFor("새 실측", () => t.store.requireMember(w.id).contextWindowSource === "codex");
    expect(t.store.requireMember(w.id)).toMatchObject({ contextPct: 40, contextWindow: 475_000 });
    t.runner.emit({ type: "context_usage", memberId: w.id, ...base, sessionId: "old-session", exact: { window: 200_000, source: "statusline" } });
    expect(t.store.requireMember(w.id).contextWindow).toBe(475_000);
  });
  test("모델별 설정은 기본 표와 병합하고 API 가 값의 범위를 검사한다", async () => {
    const t = await server();
    expect((await t.api("PUT", "/api/settings", { contextWindows: { custom: 400_000 } })).body.contextWindows).toEqual({ "gpt-6-astra": 475_000, custom: 400_000 });
    expect((await t.api("PUT", "/api/settings", { contextWindows: { "gpt-6-astra": 272_000 } })).body.contextWindows["gpt-6-astra"]).toBe(272_000);
    for (const bad of [null, [], "bad", { bad: 999 }, { bad: 1.2 }, { bad: 10_000_001 }, { bad: "475000" }, { "": 400_000 }]) {
      expect((await t.api("PUT", "/api/settings", { contextWindows: bad })).status).toBe(400);
    }
    expect((await t.api("PUT", "/api/settings", { contextWindows: {} })).body.contextWindows).toEqual({ "gpt-6-astra": 475_000 });
  });
});

function wrapperFixture(safetyTimeoutMs?: number) {
  const home = mkdtempSync(join(tmpdir(), "iamceo wrapper's "));
  const project = join(home, "project"); const user = join(home, "claude");
  mkdirSync(join(project, ".claude"), { recursive: true }); mkdirSync(user);
  const managed = join(home, "managed.json");
  const wrapper = writeStatuslineWrapper(home, { managedSettingsPath: managed, safetyTimeoutMs });
  const settings = (path: string, command: string) => writeFileSync(path, JSON.stringify({ statusLine: { type: "command", command } }));
  const input = { session_id: "session-123", model: { id: "model-actual" }, workspace: { project_dir: project, current_dir: "/unused" }, context_window: { context_window_size: 475_000, used_percentage: 42.5, current_usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 187000, output_tokens: 999 } } };
  const run = async (bytes = JSON.stringify(input), command = wrapper.command) => {
    const proc = Bun.spawn(["/bin/sh", "-c", command], { env: { ...process.env, CLAUDE_CONFIG_DIR: user, IAMCEO_HOME: home }, cwd: project, stdin: new Blob([bytes]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0); expect(stderr).toBe(""); return stdout;
  };
  return { home, project, user, managed, wrapper, settings, input, run };
}

describe("Claude 상태줄 래퍼", () => {
  test("같은 stdin 바이트·stdout 유지, 원자적 기록·권한, 경로 따옴표", async () => {
    const f = wrapperFixture(); f.settings(join(f.user, "settings.json"), "/bin/cat");
    const bytes = "  " + JSON.stringify(f.input) + "\n\n";
    expect(await f.run(bytes)).toBe(bytes);
    expect(readContextRecord(f.home, "session-123")).toMatchObject({ session_id: "session-123", model: "model-actual", context_window_size: 475_000, used_percentage: 42.5, tokens: 190_000, at: expect.any(Number) });
    expect(readdirSync(join(f.home, "context"))).toEqual(["session-123.json"]);
    expect(statSync(join(f.home, "context")).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.home, "context/session-123.json")).mode & 0o777).toBe(0o600);
  });
  test("managed > project local > project > user, 런타임 재조회와 자기 재귀 방지", async () => {
    const f = wrapperFixture(); f.settings(join(f.user, "settings.json"), "printf user");
    expect(await f.run()).toBe("user");
    f.settings(join(f.project, ".claude/settings.json"), "printf project"); expect(await f.run()).toBe("project");
    f.settings(join(f.project, ".claude/settings.local.json"), "printf local"); expect(await f.run()).toBe("local");
    f.settings(f.managed, "printf managed"); expect(await f.run()).toBe("managed");
    f.settings(f.managed, f.wrapper.command); expect(await f.run()).toBe("local");
    f.settings(join(f.project, ".claude/settings.local.json"), f.wrapper.command); expect(await f.run()).toBe("project");
    f.settings(join(f.project, ".claude/settings.json"), f.wrapper.command); expect(await f.run()).toBe("user");
    f.settings(join(f.user, "settings.json"), f.wrapper.command); expect(await f.run()).toBe("");
  });
  test("나쁜 JSON·경로·기록 불가·없는 명령은 조용히 통과한다", async () => {
    const f = wrapperFixture(); f.settings(join(f.user, "settings.json"), "/bin/cat");
    expect(await f.run("{broken\n")).toBe("{broken\n");
    expect(existsSync(join(f.home, "context"))).toBe(false);
    f.input.session_id = "../escape"; const bytes = JSON.stringify(f.input);
    expect(await f.run(bytes)).toBe(bytes); expect(existsSync(join(f.home, "escape.json"))).toBe(false);
    f.input.session_id = "safe"; writeFileSync(join(f.home, "context"), "not a directory");
    expect(await f.run()).toBe(JSON.stringify(f.input));
    f.settings(join(f.user, "settings.json"), "/does-not-exist/iamceo-test"); expect(await f.run()).toBe("");
    unlinkSync(join(f.user, "settings.json")); expect(await f.run()).toBe("");
  });
  test("느린 사용자 명령은 제한 시간 뒤 끝내되 앞서 출력한 바이트는 유지한다", async () => {
    const f = wrapperFixture(200); f.settings(join(f.user, "settings.json"), "printf ready; exec sleep 30");
    const at = Date.now(); expect(await f.run()).toBe("ready"); expect(Date.now() - at).toBeLessThan(3000);
  });
  test("신선한 공식 %, 늦은 갱신 재읽기, 오래된 기록의 창 크기만 사용", async () => {
    const f = wrapperFixture(); await f.run();
    const base = { tokens: 190_000, shownPct: null, model: null };
    expect((await capturedContext(f.home, "session-123", base, Date.now())).exact).toMatchObject({ window: 475_000, pct: 42.5 });
    const path = join(f.home, "context/session-123.json");
    const record = readContextRecord(f.home, "session-123")!;
    writeFileSync(path, JSON.stringify({ ...record, at: Date.now() - 60_000 }));
    expect((await capturedContext(f.home, "session-123", base, Date.now())).exact).toMatchObject({ window: 475_000, pct: null });
    const timer = setTimeout(() => writeFileSync(path, JSON.stringify({ ...record, at: Date.now(), used_percentage: 43 })), 30);
    expect((await capturedContext(f.home, "session-123", base, Date.now())).exact?.pct).toBe(43); clearTimeout(timer);
    expect((await capturedContext(f.home, "session-123", { ...base, tokens: 200_000 }, Date.now())).exact?.pct).toBeNull();
    expect(readContextRecord(f.home, "../unsafe")).toBeNull();
    writeFileSync(path, JSON.stringify({ ...record, session_id: "wrong" })); expect(readContextRecord(f.home, "session-123")).toBeNull();
  });
  test("writeRunFiles: Claude 는 항상 statusLine, 바이패스 키 유지, Codex 는 settings 없음", async () => {
    const t = await server(); const w = await worker(t); const project = t.store.requireProject(w.projectId);
    // 파일 생성만 검사한다. 실제 CLI 나 서비스는 시작하지 않는다.
    const write = (m: Member) => (t.orch as unknown as { writeRunFiles(m: Member, p: typeof project): StartOpts }).writeRunFiles(m, project);
    t.store.patchSettings({ permissionMode: "default" });
    let settings = JSON.parse(readFileSync(write(w).settingsFile!, "utf8"));
    expect(settings.statusLine.command).toContain(STATUSLINE_MARKER); expect(settings.skipDangerousModePermissionPrompt).toBeUndefined();
    t.store.patchSettings({ permissionMode: "bypassPermissions" });
    settings = JSON.parse(readFileSync(write(w).settingsFile!, "utf8"));
    expect(settings.skipDangerousModePermissionPrompt).toBe(true); expect(settings.statusLine.type).toBe("command");
    expect(write({ ...w, cli: "codex" }).settingsFile).toBeUndefined();
  });
});

test("Codex rollout tail: 마지막 사용량, 부분 줄, 누적량 제외, 세션 확인", () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-codex-context-")); const dir = join(home, "sessions/2026/11/07"); mkdirSync(dir, { recursive: true });
  const id = "session-codex"; const path = join(dir, `rollout-2026-11-07-${id}.jsonl`);
  const event = (tokens: number, window: number) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { model_context_window: window, last_token_usage: { total_tokens: tokens }, total_token_usage: { total_tokens: 9_000_000 } } } });
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id, cwd: "/tmp", timestamp: "2026-11-07", base_instructions: "fixture".repeat(10000) } }) + "\n" + " ".repeat(150_000) + "\n" + event(100_000, 258_400) + "\n" + event(190_000, 475_000) + '\n{"partial":');
  expect(readCodexContext(home, id)).toMatchObject({ tokens: 190_000, exact: { window: 475_000, source: "codex" } });
  expect(readCodexContext(home, "unknown")).toBeNull(); expect(readCodexContext(home, "../bad")).toBeNull();
  const wrong = join(dir, "rollout-time-wrong.jsonl"); writeFileSync(wrong, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n" + event(10, 475_000));
  expect(readCodexContext(home, "wrong")).toBeNull();
  writeFileSync(path, "\n" + JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { model_context_window: 272_000, total_token_usage: { total_tokens: 9_000_000 } } } }) + "\n", { flag: "a" });
  expect(readCodexContext(home, id)).toMatchObject({ tokens: null, exact: { window: 272_000, source: "codex" } });
});

test("상태줄: 쓸 수 없는 디렉터리도 사용자 출력은 유지하고 잘못된 입력 모양도 통과한다", async () => {
  const f = wrapperFixture(); f.settings(join(f.user, "settings.json"), "/bin/cat");
  const dir = join(f.home, "context"); chmodSync(f.home, 0o500);
  try { expect(await f.run()).toBe(JSON.stringify(f.input)); expect(existsSync(dir)).toBe(false); }
  finally { chmodSync(f.home, 0o700); }
  const bytes = JSON.stringify({ workspace: { project_dir: 123, current_dir: {} } });
  expect(await f.run(bytes)).toBe(bytes);
});

test("컴파일 바이너리도 BUN_BE_BUN=1 로 같은 상태줄 스크립트를 실행한다", async () => {
  const f = wrapperFixture(); f.settings(join(f.user, "settings.json"), "/bin/cat");
  const entry = join(f.home, "entry.ts"); const binary = join(f.home, "compiled bun's binary");
  writeFileSync(entry, 'throw new Error("compiled entry must not run");');
  const compile = Bun.spawn([process.execPath, "build", "--compile", entry, "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
  const [code] = await Promise.all([compile.exited, new Response(compile.stdout).text(), new Response(compile.stderr).text()]);
  expect(code).toBe(0);
  const wrapper = writeStatuslineWrapper(f.home, { managedSettingsPath: f.managed, execPath: binary });
  expect(await f.run(JSON.stringify(f.input), wrapper.command)).toBe(JSON.stringify(f.input));
  expect(readContextRecord(f.home, f.input.session_id)?.context_window_size).toBe(475_000);
});

test("토큰이 아직 없는 실측 창도 출처와 함께 저장한다", async () => {
  const t = await server(); const w = await worker(t);
  t.runner.emit({ type: "context_usage", memberId: w.id, tokens: null, model: null, shownPct: null, exact: { window: 475_000, source: "statusline" } });
  await waitFor("창만 저장", () => t.store.requireMember(w.id).contextWindowSource === "statusline");
  expect(t.store.requireMember(w.id)).toMatchObject({ contextWindow: 475_000, contextPct: null });
});

// 생성자는 소켓·타이머를 열므로 호출하지 않는다. 실제 finishTurn 만 가짜 칸/기록에 연결한다.
function herdrTurnFixture({ model = "opus[1m]", screen = "", tokens = 190_000 }: { model?: string | null; screen?: string; tokens?: number } = {}) {
  const events: RunnerEvent[] = [];
  const track = { m: { id: "fake-herdr", model }, sessionId: "session-1", paneId: "fake-pane", inTurn: true, bgTurn: null, turnGen: 0 };
  const runner = Object.assign(Object.create(HerdrRunner.prototype), {
    tracks: new Map([[track.m.id, track]]), stopped: false, contextHome: mkdtempSync(join(tmpdir(), "iamceo-finish-turn-")),
    stopTail() {}, lastTurn: () => ({ finalText: "done", isError: true, noOutput: true, contextTokens: tokens, model: "claude-opus-5-5" }),
    readPane: async () => screen, report: () => events.push({ type: "status", memberId: track.m.id, status: "idle" }),
    emit: (e: RunnerEvent) => events.push(e),
  });
  return { runner, track, events };
}

for (const stale of ["stopped", "replaced", "session"] as const) {
  test(`herdr finishTurn: ${stale} 중에도 turn_end 는 유지하고 오래된 context_usage 만 버린다`, async () => {
    const { runner, track, events } = herdrTurnFixture();
    const finished = runner.finishTurn(track);
    await waitFor("idle 먼저", () => events.some(e => e.type === "status"));
    if (stale === "stopped") runner.stopped = true;
    else if (stale === "replaced") runner.tracks.set(track.m.id, { ...track });
    else track.sessionId = "session-2";
    await finished;
    expect(events.map(e => e.type)).toEqual(["status", "turn_end"]);
    expect(events[1]).toEqual({ type: "turn_end", memberId: track.m.id, finalText: "done", isError: true, errorText: "done", noOutput: true });
  });
}

test("herdr configured [1m] 은 transcript 모델보다 먼저이고 context 는 turn_end 전에 나온다", async () => {
  const { runner, track, events } = herdrTurnFixture(); await runner.finishTurn(track);
  expect(events.map(e => e.type)).toEqual(["status", "context_usage", "turn_end"]);
  const reading = events.find((e): e is Extract<RunnerEvent, { type: "context_usage" }> => e.type === "context_usage")!;
  expect(reading.model).toBe("opus[1m]");
  expect(measureContext(reading, { learned: null, fallback: 200_000 })?.pct).toBe(19);
});

const TRUNCATED_SCREEN = ["⏺ 작업을 마쳤습니다", "─".repeat(30), "│ > │", "─".repeat(30), "  ◆ Opus │ ██░░░░░░…", "  ⏵⏵ bypass permissions on"].join("\n");

for (const model of ["claude-opus-5-5", null]) test(`herdr finishTurn: 모델 ${model}, 잘린 상태줄의 190k 는 19% 이고 다음 일에 압축하지 않는다`, async () => {
  expect(inputLooksEmpty(TRUNCATED_SCREEN)).toBe(true);
  expect(screenContextPct(TRUNCATED_SCREEN)).toBeNull();
  const { runner, track, events } = herdrTurnFixture({ model, screen: TRUNCATED_SCREEN, tokens: 190_000 });
  expect(readContextRecord(runner.contextHome, track.sessionId)).toBeNull();
  await runner.finishTurn(track);
  const reading = events.find((e): e is Extract<RunnerEvent, { type: "context_usage" }> => e.type === "context_usage")!;
  expect(reading).toMatchObject({ tokens: 190_000, model: "claude-opus-5-5", shownPct: null });
  expect(reading.exact).toBeUndefined();
  const t = await server(); const w = await worker(t);
  t.runner.emit({ ...reading, memberId: w.id, sessionId: w.sessionId ?? undefined });
  expect(t.store.requireMember(w.id)).toMatchObject({ contextPct: 19, contextWindow: null });
  const sent = t.runner.sent.length;
  await t.orch.assign(w.projectId, w.handle, { text: "다음 일" });
  await waitFor("다음 일 전달", () => t.runner.sent.length > sent);
  expect(t.runner.compacts).toEqual([]);
});

for (const model of ["claude-opus-5-5", null]) test(`core reportContext: 모델 ${model}, 잘린 상태줄과 임시 transcript 로 19% 를 보고한다`, async () => {
  const home = mkdtempSync(join(tmpdir(), "iamceo-core-context-"));
  const claudeHome = join(home, "claude"); const contextHome = join(home, "context-home");
  mkdirSync(contextHome);
  const events: RunnerEvent[] = [];
  const track = { member: { id: "fake-core", cli: "claude", cwd: home, sessionId: "session-core", model }, terminal: { address: "fake-terminal", turn: 1 }, sessionId: "session-core", pending: false, uncertain: false, status: "idle" };
  const path = transcriptPath(home, track.sessionId, claudeHome);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "assistant", message: { id: "a1", model: "claude-opus-5-5", content: [{ type: "text", text: "done" }], usage: { input_tokens: 10_000, cache_read_input_tokens: 170_000, cache_creation_input_tokens: 10_000, output_tokens: 5000 } } }) + "\n");
  // 생성자 없이 실제 보고 경로만 실행한다.
  const runner = Object.assign(Object.create(CoreRunner.prototype), {
    options: { claudeHome, contextHome }, tracks: new Map([[track.member.id, track]]), closed: false,
    call: async (method: string, params: unknown) => {
      expect(method).toBe("terminal.read");
      expect(params).toEqual({ terminal: track.terminal.address, lines: 0 });
      return { text: TRUNCATED_SCREEN };
    },
    emit: (e: RunnerEvent) => events.push(e),
  });
  expect(screenContextPct(TRUNCATED_SCREEN)).toBeNull();
  expect(readContextRecord(contextHome, track.sessionId)).toBeNull();
  await runner.reportContext(track);
  expect(events).toHaveLength(1);
  const reading = events[0] as Extract<RunnerEvent, { type: "context_usage" }>;
  expect(reading).toMatchObject({ type: "context_usage", tokens: 190_000, shownPct: null, model: "claude-opus-5-5", sessionId: track.sessionId });
  expect(reading.exact).toBeUndefined();
  expect(measureContext(reading, { learned: null, fallback: DEFAULT_CONTEXT_WINDOW })).toEqual({ pct: 19, learned: null });
});

test("기본 창을 넘은 토큰은 더 큰 알려진 창, 표까지 넘으면 여유 있는 창으로 잰다", () => {
  const hints = { learned: null, model: null, fallback: 200_000 };
  expect(contextWindowFor(300_000, hints)).toBe(475_000);
  expect(measureContext({ tokens: 300_000, model: null, shownPct: null }, hints)?.pct).toBe(63);
  expect(contextWindowFor(1_200_000, hints)).toBeGreaterThan(1_200_000);
  expect(measureContext({ tokens: 1_200_000, model: null, shownPct: null }, hints)?.pct).toBeLessThan(100);
});

test("headless 는 주 모델의 실측 창만 저장하고 폴백·압축 % 는 출처를 덮지 않는다", async () => {
  const t = await server(); const w = await worker(t);
  const feed = (modelUsage?: object, cachedWindow: number | null = null) => {
    const parser = new StreamParser(w.id, e => t.runner.emit(e), { reportContext: true, contextWindow: cachedWindow });
    parser.feed(JSON.stringify({ type: "assistant", message: { model: "main", usage: { input_tokens: 190_000 }, content: [] } }));
    parser.feed(JSON.stringify({ type: "result", subtype: "success", modelUsage }));
  };
  feed({ subagent: { contextWindow: 1_000_000 } });
  await waitFor("폴백 %", () => t.store.requireMember(w.id).contextPct === 19);
  expect(t.store.requireMember(w.id)).toMatchObject({ contextWindow: null, contextWindowSource: null });
  feed(undefined, 200_000);
  await waitFor("이전 창의 %", () => t.store.requireMember(w.id).contextPct === 95);
  expect(t.store.requireMember(w.id)).toMatchObject({ contextWindow: null, contextWindowSource: null });
  feed({ main: { contextWindow: 475_000 }, subagent: { contextWindow: 1_000_000 } });
  await waitFor("주 모델 실측", () => t.store.requireMember(w.id).contextWindowSource === "headless");
  expect(t.store.requireMember(w.id)).toMatchObject({ contextPct: 40, contextWindow: 475_000, contextWindowSource: "headless" });
  t.runner.emit({ type: "context", memberId: w.id, pct: 0 });
  await waitFor("압축 뒤 %", () => t.store.requireMember(w.id).contextPct === 0);
  expect(t.store.requireMember(w.id)).toMatchObject({ contextWindow: 475_000, contextWindowSource: "headless" });
});

const quoteCommandPath = (path: string) => "'" + path.replaceAll("'", "'\\''") + "'";

test("상태줄: 기본 제한은 30초이고 1.5초를 넘는 캐시 갱신도 완료한다", async () => {
  const f = wrapperFixture();
  expect(readFileSync(join(f.home, "run", `${STATUSLINE_MARKER}.mjs`), "utf8")).toContain("SAFETY_TIMEOUT_MS = 30000");
  const done = join(f.home, "cache-ready");
  f.settings(join(f.user, "settings.json"), `sleep 2; printf cached > ${quoteCommandPath(done)}; printf 'usage ready\\n'`);
  const output = f.run();
  await waitFor("명령 완료 전 실측 기록", () => readContextRecord(f.home, f.input.session_id));
  expect(existsSync(done)).toBe(false);
  expect(await output).toBe("usage ready\n");
  expect(readFileSync(done, "utf8")).toBe("cached");
});

test("상태줄: 정상 종료 뒤 사용자가 남긴 백그라운드 자식을 죽이지 않는다", async () => {
  const f = wrapperFixture(); const done = join(f.home, "background-done");
  const background = join(f.home, "background.mjs"); const command = join(f.home, "command.mjs");
  writeFileSync(background, `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(done)}, 'done'), 250);`);
  writeFileSync(command, `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, [${JSON.stringify(background)}], { stdio: 'ignore' }); child.unref(); process.stdout.write('foreground');`);
  f.settings(join(f.user, "settings.json"), `exec ${quoteCommandPath(process.execPath)} ${quoteCommandPath(command)}`);
  expect(await f.run()).toBe("foreground");
  await waitFor("백그라운드 자식 완료", () => existsSync(done));
  expect(readFileSync(done, "utf8")).toBe("done");
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`상태줄: ${signal} 을 분리되지 않은 자식에게 전달하고 0 으로 끝난다`, async () => {
    const f = wrapperFixture(); const ready = join(f.home, "child-ready"); const signaled = join(f.home, "child-signaled");
    const command = join(f.home, "signal-child.mjs");
    writeFileSync(command, `import { writeFileSync } from 'node:fs'; process.on(${JSON.stringify(signal)}, () => { writeFileSync(${JSON.stringify(signaled)}, ${JSON.stringify(signal)}); process.exit(0); }); writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => process.exit(0), 3000);`);
    f.settings(join(f.user, "settings.json"), `exec ${quoteCommandPath(process.execPath)} ${quoteCommandPath(command)}`);
    const proc = Bun.spawn([process.execPath, join(f.home, "run", `${STATUSLINE_MARKER}.mjs`), f.home], { env: { ...process.env, CLAUDE_CONFIG_DIR: f.user }, stdin: new Blob([JSON.stringify(f.input)]), stdout: "pipe", stderr: "pipe" });
    try {
      await waitFor("자식 시작", () => existsSync(ready));
      proc.kill(signal);
      expect(await proc.exited).toBe(0);
      await waitFor("자식 신호 수신", () => existsSync(signaled));
      expect(readFileSync(signaled, "utf8")).toBe(signal);
      expect(await new Response(proc.stdout).text()).toBe(""); expect(await new Response(proc.stderr).text()).toBe("");
    } finally { if (proc.exitCode === null) proc.kill(); }
  });
}
