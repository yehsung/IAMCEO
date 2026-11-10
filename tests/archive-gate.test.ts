// 보관·전달·편입·연결의 경계(spec §3.1·§6). 실행기는 가짜, 저장소·전달 펌프·도구·HTTP 는 진짜다.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, Member } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer } from "../server/http.ts";
import { Orchestrator, type OrchestratorTimings } from "../server/orchestrator.ts";
import { HerdrError } from "../server/runner/herdr-client.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../server/runner/types.ts";
import { IMPORT_HOLD_NOTE, Store } from "../server/store.ts";

class Fake {
  readonly kind = "herdr" as const;
  starts: RunnerMember[] = [];
  sent: { id: string; text: string }[] = [];
  sendResult: SendResult = { ok: true };
  stopError: Error | null = null;
  busy = new Set<string>();
  cb: (e: RunnerEvent) => void = () => {};
  async available() {
    return { ok: true };
  }
  async start(m: RunnerMember) {
    this.starts.push(m);
    return { sessionId: m.sessionId ?? crypto.randomUUID(), paneId: `w:p${this.starts.length}`, tabId: "w:t" };
  }
  async send(m: RunnerMember, text: string): Promise<SendResult> {
    if (!this.sendResult.ok) return this.sendResult;
    this.sent.push({ id: m.id, text });
    return { ok: true };
  }
  isBusy(id: string) {
    return this.busy.has(id);
  }
  async compact(): Promise<SendResult> {
    return { ok: true };
  }
  async setParallel(): Promise<SendResult> {
    return { ok: true };
  }
  async interrupt() {}
  stopErrors = new Map<string, Error>();
  checkErrors = new Map<string, Error>();
  stopped: string[] = [];
  stopDelayMs = 0;
  async stop(m: RunnerMember) {
    if (this.stopError) throw this.stopError;
    if (this.stopDelayMs) await Bun.sleep(this.stopDelayMs);
    const e = this.stopErrors.get(m.id);
    if (e) throw e;
    this.stopped.push(m.id);
  }
  checks: { id: string; whileWorking?: boolean }[] = [];
  async checkStop(m: RunnerMember, opts?: { whileWorking?: boolean }) {
    this.checks.push({ id: m.id, whileWorking: opts?.whileWorking });
    const e = this.checkErrors.get(m.id);
    if (e) throw e;
  }
  async screen() {
    return "";
  }
  on(cb: (e: RunnerEvent) => void) {
    this.cb = cb;
  }
  async shutdown() {}
  async reattach(m: RunnerMember) {
    return { paneId: m.paneId ?? "w:p9", tabId: "w:t" };
  }
  async adopt() {
    return { sessionId: "sess-live", paneId: "live1", tabId: "w:t" };
  }
}

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
});

async function setup(opts: { timings?: Partial<OrchestratorTimings>; runnerEnabled?: boolean } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-gate-")));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"], claudeBin: "/bin/false" }, env);
  const config = loadConfig(env);
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const runner = new Fake();
  const runners = new Map<Backend, Runner>([["herdr", runner as unknown as Runner]]);
  const herdr = {
    info: async () => ({ installed: true, running: true, version: "1", protocol: 22, compatible: true, warning: null }),
    agents: async () => [{ paneId: "live1", name: "기존", agent: "claude", status: "idle", cwd: home, sessionId: "sess-live", workspaceId: "w", tabId: "t", adopted: false }],
  };
  store.patchSettings({ backend: "herdr" });
  const orch = new Orchestrator({ config, store, runners, herdr: herdr as never, timings: { tickMs: 15, retryMs: 5, inputBusyRetryMs: 5, ...opts.timings } });
  closers.push(() => orch.shutdown());
  const project = store.createProject({ name: "시험", cwd: home, runnerEnabled: opts.runnerEnabled ?? true });
  const server = await startServer({ config, store, bus, orch });
  orch.setServerUrl(server.urls[0]!);
  await orch.recover(); // 틱을 돌린다. 아직 정리할 것이 없다.
  closers.push(() => server.stop());
  const base = server.urls[0]!;
  const api = (method: string, path: string, body?: unknown, token = "code") =>
    fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const manual = async (name = "직접") => (await (await api("POST", "/agent/join", { project: project.id, name })).json()) as { member: Member; token: string };
  const tool = async (token: string, name: string, args: unknown) => (await (await api("POST", "/agent/tool", { name, args }, token)).json()) as { text: string; isError?: boolean };
  return { store, orch, runner, project, api, manual, tool, config, runners, herdr };
}

const until = async (cond: () => boolean, label: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`시간 초과: ${label}`);
    await Bun.sleep(5);
  }
};

describe("보관", () => {
  test("직접 세션의 보고가 보관된 총괄을 깨우지 않고, 꺼내면 그때 전달된다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    const m = await t.manual();
    await until(() => t.store.requireMember(lead.id).status === "idle" || t.store.requireMember(lead.id).status === "working", "총괄");
    t.runner.cb({ type: "turn_end", memberId: lead.id, finalText: "", isError: false });
    await until(() => t.store.requireMember(lead.id).status === "idle", "총괄 대기");
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true })).status).toBe(200);
    expect(t.store.requireMember(lead.id).status).toBe("asleep");
    const starts = t.runner.starts.length;
    const sends = t.runner.sent.length;
    expect((await t.tool(m.token, "post", { kind: "완료", title: "끝" })).isError).toBeFalsy();
    await Bun.sleep(80);
    expect(t.store.requireMember(lead.id).status).toBe("asleep");
    expect(t.runner.starts.length).toBe(starts);
    expect(t.runner.sent.length).toBe(sends);
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: false })).status).toBe(200);
    await until(() => t.runner.sent.length > sends, "꺼낸 뒤 전달");
    expect(t.runner.starts.length).toBe(starts + 1);
  });

  test("보관 중에는 다시 열기·총괄 시작·실행 켜기·편입이 409 다", async () => {
    const t = await setup({ runnerEnabled: false });
    const lead = t.store.createMember({ projectId: t.project.id, handle: "cs", name: "철수", role: "개발", kind: "worker", origin: "runner", status: "asleep", sessionId: "s1" });
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true })).status).toBe(200);
    expect((await t.api("POST", `/api/members/${lead.id}/resume`)).status).toBe(409);
    expect((await t.api("POST", `/api/projects/${t.project.id}/conductor/start`)).status).toBe(409);
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { runnerEnabled: true })).status).toBe(409);
    expect((await t.api("POST", `/api/projects/${t.project.id}/adopt`, { paneId: "live1", name: "기존", role: "개발" })).status).toBe(409);
    expect(t.runner.starts.length).toBe(0);
    expect(t.store.requireProject(t.project.id).runnerEnabled).toBe(false);
    // 꺼내면서 켜는 것은 된다.
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: false, runnerEnabled: true })).status).toBe(200);
  });

  test("아직 전송을 시도하지 않은 대표 글은 보관했다 꺼내면 한 번 전달된다", async () => {
    const t = await setup({ timings: { tickMs: 60_000 } });
    const lead = await t.orch.ensureConductor(t.project.id);
    t.runner.cb({ type: "turn_end", memberId: lead.id, finalText: "", isError: false });
    await until(() => t.store.requireMember(lead.id).status === "idle", "총괄 대기");
    t.runner.busy.add(lead.id);
    const res = await t.api("POST", `/api/projects/${t.project.id}/messages`, { text: "대기 중 지시" });
    expect(res.status).toBe(200);
    const message = (await res.json()) as { id: string };
    const delivery = t.store.listPending(lead.id).find(d => d.refId === message.id)!;
    expect(delivery.attempts).toBe(0);
    expect(t.store.listDispatches(lead.id)).toHaveLength(0);
    // 다음 틱 전에 쉬게 된 뒤 보관한다. 일하는 직원은 보관할 수 없다.
    t.runner.busy.delete(lead.id);
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true })).status).toBe(200);
    expect(t.store.requireDelivery(delivery.id)).toMatchObject({ status: "held", holdReason: "archived" });
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: false })).status).toBe(200);
    await until(() => t.store.requireMessage(message.id).delivery === "delivered", "꺼낸 뒤 전달");
    expect(t.runner.sent.filter(s => s.text.includes("대기 중 지시"))).toHaveLength(1);
    expect(t.store.requireDelivery(delivery.id).attempts).toBe(1);
  });

  test("input_busy만으로 미수신을 확정하지 않고 보관했다 꺼내도 재전송을 막는다", async () => {
    const t = await setup();
    const lead = await t.orch.ensureConductor(t.project.id);
    t.runner.cb({ type: "turn_end", memberId: lead.id, finalText: "", isError: false });
    await until(() => t.store.requireMember(lead.id).status === "idle", "총괄 대기");
    t.runner.sendResult = { ok: false, reason: "input_busy", retryable: true };
    const res = await t.api("POST", `/api/projects/${t.project.id}/messages`, { text: "옛 지시" });
    expect(res.status).toBe(200);
    const message = (await res.json()) as { id: string };
    const dispatches = t.store.listDispatches(lead.id);
    const delivery = t.store.listPending(lead.id).find(d => d.refId === message.id)!;
    expect(delivery.attempts).toBe(1);
    expect(t.orch.deliveryRecovery.fenced(lead.id)).toBe(true);
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true })).status).toBe(200);
    expect(t.store.listPending(lead.id).find((d) => d.refId === message.id)).toMatchObject({ status: "held", holdReason: "delivery_unknown" });
    t.runner.sendResult = { ok: true };
    await Bun.sleep(50);
    expect(t.runner.sent.some((s) => s.text.includes("옛 지시"))).toBe(false);
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: false })).status).toBe(200);
    await t.orch.deliveryRecovery.tick();
    await t.orch.pump(lead.id);
    expect(t.runner.sent.some(s => s.text.includes("옛 지시"))).toBe(false);
    expect(t.store.requireDelivery(delivery.id).attempts).toBe(1);
    expect(t.store.listDispatches(lead.id)).toEqual(dispatches);
    expect(t.store.requireMessage(message.id).delivery).toBe("held");
    expect(t.orch.deliveryRecovery.fenced(lead.id)).toBe(true);
  });

  test("보관된 프로젝트의 ask 는 카드를 만들지 않고 도구 오류로 끝난다", async () => {
    const t = await setup({ runnerEnabled: false });
    const m = await t.manual();
    await t.tool(m.token, "wait", { timeoutMs: 1 }).catch(() => null);
    t.store.patchMember(m.member.id, { status: "idle" });
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true })).status).toBe(200);
    const r = await t.tool(m.token, "ask", { title: "물음", detail: "내용" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("보관");
    expect(t.store.listDecisions(t.project.id).length).toBe(0);
  });

  test("넘겨받은 칸을 끝낼 수 없으면 보관을 거부하고 아무것도 바꾸지 않는다", async () => {
    const t = await setup();
    const a = await t.orch.adopt(t.project.id, { paneId: "live1", name: "기존이", role: "개발", handle: "old" });
    t.runner.cb({ type: "turn_end", memberId: a.id, finalText: "", isError: false });
    await until(() => t.store.requireMember(a.id).status === "idle", "대기");
    t.runner.stopError = new HerdrError("cannot_exit", "칸의 입력칸에 쓰던 글이 있습니다");
    const res = await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("쓰던 글");
    expect(t.store.requireProject(t.project.id).archived).toBe(false);
    expect(t.store.requireMember(a.id)).toMatchObject({ status: "idle", paneId: "live1" });
    t.runner.stopError = null;
    expect((await t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true })).status).toBe(200);
    expect(t.store.requireMember(a.id).status).toBe("asleep");
  });

  describe("넘겨받은 칸이 둘일 때", () => {
    const CANNOT = () => new HerdrError("cannot_exit", "칸의 입력칸에 쓰던 글이 있습니다");
    const pair = async () => {
      const t = await setup();
      const mk = (handle: string, name: string, paneId: string) =>
        t.store.createMember({ projectId: t.project.id, handle, name, role: "개발", kind: "worker", origin: "adopted", status: "idle", sessionId: `s-${handle}`, paneId });
      const a = mk("aa", "가", "pa");
      const b = mk("bb", "나", "pb");
      // 입력칸이 차 있어 전달이 줄에 남아 있다.
      t.runner.sendResult = { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written" };
      const d = t.store.enqueue({ projectId: t.project.id, memberId: a.id, kind: "system", text: "줄 선 말" });
      const archive = () => t.api("PATCH", `/api/projects/${t.project.id}`, { archived: true });
      return { t, a, b, d, archive };
    };

    test("하나라도 쓰던 글이 있으면 어느 칸도 끝내지 않고 409, 그 뒤에도 그대로다", async () => {
      const { t, a, b, archive } = await pair();
      t.runner.checkErrors.set(b.id, CANNOT());
      expect((await archive()).status).toBe(409);
      await Bun.sleep(80);
      expect(t.runner.stopped).toEqual([]);
      expect(t.runner.starts.length).toBe(0);
      expect(t.store.requireProject(t.project.id).archived).toBe(false);
      expect(t.store.requireMember(a.id)).toMatchObject({ origin: "adopted", paneId: "pa" });
      expect(t.store.requireMember(a.id).status).not.toBe("asleep");
      expect(t.store.requireMember(b.id)).toMatchObject({ status: "idle", paneId: "pb" });
    });

    test("보고 난 뒤 칸이 달라져 거부돼도 먼저 끝낸 칸을 서버 세션으로 다시 열지 않는다", async () => {
      const { t, a, b, d, archive } = await pair();
      t.runner.stopErrors.set(b.id, CANNOT());
      const res = await archive();
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("가의 칸은 이미 끝나");
      expect(t.store.requireProject(t.project.id).archived).toBe(false);
      await Bun.sleep(80);
      expect(t.runner.starts.length).toBe(0);
      expect(t.store.requireMember(a.id)).toMatchObject({ status: "asleep", origin: "adopted", paneId: null });
      expect(t.store.listPending(a.id).find((x) => x.id === d.id)).toMatchObject({ status: "held", holdReason: "asleep" });
      expect(t.store.requireMember(b.id)).toMatchObject({ status: "idle", paneId: "pb" });
    });

    test("칸을 끝내는 동안 틱이 먼저 끝낸 칸을 다시 열지 않고, 다 끝나면 보관된다", async () => {
      const { t, a, b, d, archive } = await pair();
      t.runner.stopDelayMs = 60;
      expect((await archive()).status).toBe(200);
      expect(t.runner.starts.length).toBe(0);
      expect(t.store.requireMember(a.id).status).toBe("asleep");
      expect(t.store.requireMember(b.id).status).toBe("asleep");
      expect(t.store.listPending(a.id).find((x) => x.id === d.id)).toMatchObject({ status: "held", holdReason: "archived" });
    });

    test("소켓 문제로 칸을 볼 수 없으면 503 이고 깬 칸을 남긴 채 보관하지 않는다", async () => {
      const { t, a, b, archive } = await pair();
      t.runner.checkErrors.set(b.id, new HerdrError("down", "소켓이 닫혔습니다"));
      expect((await archive()).status).toBe(503);
      t.runner.checkErrors.clear();
      t.runner.stopErrors.set(b.id, new HerdrError("down", "소켓이 닫혔습니다"));
      expect((await archive()).status).toBe(503);
      expect(t.store.requireProject(t.project.id).archived).toBe(false);
      expect(t.store.requireMember(b.id)).toMatchObject({ status: "idle", paneId: "pb" });
      expect(t.store.requireMember(a.id).status).toBe("asleep");
    });

    test("이미 안 보이는 직원은 소켓이 안 닿아도 보관을 막지 않지만, 쓰던 글은 막는다", async () => {
      const { t, a, b, archive } = await pair();
      t.store.patchMember(b.id, { status: "offline", paneId: null });
      t.runner.checkErrors.set(b.id, CANNOT());
      expect((await archive()).status).toBe(409);
      t.runner.checkErrors.set(b.id, new HerdrError("down", "소켓이 닫혔습니다"));
      t.runner.stopErrors.set(b.id, new HerdrError("down", "소켓이 닫혔습니다"));
      expect((await archive()).status).toBe(200);
      expect(t.store.requireProject(t.project.id).archived).toBe(true);
      expect(t.store.requireMember(a.id).status).toBe("asleep");
    });
  });
});

describe("단일 프로젝트 변경 장벽", () => {
  const managed = (t: Awaited<ReturnType<typeof setup>>, handle: string) => t.store.createMember({
    projectId: t.project.id, handle, name: handle, role: "개발", kind: "worker", origin: "runner", status: "idle", sessionId: `session-${handle}`, paneId: `pane-${handle}`,
  });

  test("전체 patch/HQ 검증이 종료보다 먼저이며 같은 값은 부작용이 없다", async () => {
    const t = await setup(); managed(t, "worker");
    for (const patch of [{ name: "  ", archived: true }, { archived: true, runnerEnabled: true }]) {
      await expect(t.orch.patchProject(t.project.id, patch)).rejects.toMatchObject({ status: 400 });
    }
    await t.orch.patchProject(t.project.id, { name: t.project.name });
    await expect(t.orch.patchProject("hq", { archived: true })).rejects.toMatchObject({ status: 400 });
    expect(t.runner.stopped).toHaveLength(0); expect(t.runner.checks).toHaveLength(0);
  });

  test("runner 직원도 전원 사전 검사하고, 마지막 검사에서 거부하면 한 명도 종료하지 않는다", async () => {
    const t = await setup(); const a = managed(t, "first"), b = managed(t, "second");
    t.runner.checkErrors.set(b.id, new HerdrError("cannot_exit", "초안 보존"));
    await expect(t.orch.patchProject(t.project.id, { archived: true, name: "새 이름" })).rejects.toMatchObject({ status: 409 });
    await until(() => t.runner.checks.length === 2, "전원 검사");
    expect(t.runner.stopped).toHaveLength(0);
    expect(t.store.requireProject(t.project.id)).toMatchObject({ archived: false, name: "시험" });
    t.runner.checkErrors.clear(); t.runner.checks = [];
    const check = t.runner.checkStop.bind(t.runner);
    t.runner.checkStop = async (member, opts) => {
      await check(member, opts);
      if (member.id === a.id && t.runner.checks.filter(c => c.id === a.id).length === 2) throw new HerdrError("cannot_exit", "검사 뒤 초안 변경");
    };
    await expect(t.orch.patchProject(t.project.id, { archived: true })).rejects.toMatchObject({ status: 409 });
    await until(() => t.runner.checks.length === 3, "종료 직전 검사");
    expect(t.runner.checks.every(c => c.whileWorking === false)).toBe(true);
    expect(t.runner.stopped).toHaveLength(0);
  });

  test("장벽 중 중복 patch/새 업무/생성/재개/설정/수신은 효과 없이 거부하고 manual은 종료하지 않는다", async () => {
    const t = await setup(); const a = managed(t, "worker");
    const manual = await t.manual();
    t.store.patchMember(manual.member.id, { status: "idle" });
    const delivery = t.store.enqueue({ projectId: t.project.id, memberId: manual.member.id, kind: "instruction", text: "manual 대기" });
    t.runner.stopDelayMs = 80;
    const changing = t.orch.patchProject(t.project.id, { archived: true });
    await until(() => t.runner.checks.length >= 2, "장벽");
    await expect(t.orch.patchProject(t.project.id, { name: "경합" })).rejects.toMatchObject({ status: 409 });
    await expect(t.orch.sendUserMessage(t.project.id, { text: "경합", targetMemberId: a.id })).rejects.toMatchObject({ status: 409 });
    await expect(t.orch.resumeMember(a.id)).rejects.toMatchObject({ status: 409 });
    await expect(t.orch.addMember(t.project.id, { name: "추가" })).rejects.toMatchObject({ status: 409 });
    await expect(t.orch.patchMemberConfig(a.id, { modelOverride: "other" })).rejects.toMatchObject({ status: 409 });
    expect(await t.orch.manualInbox(manual.member.id, 0)).toBeNull();
    await t.orch.pump(a.id);
    const archived = await changing;
    expect(archived.archived).toBe(true); expect(t.runner.starts).toHaveLength(0);
    expect(t.runner.stopped).toEqual([a.id]);
    expect(t.store.requireDelivery(delivery.id).status).toBe("held");
  });

  test("진행 중 start는 pane 저장 전에도 보관을 거절한다", async () => {
    const t = await setup(); const original = t.runner.start.bind(t.runner);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    t.runner.start = async member => { await gate; return original(member); };
    const spawning = t.orch.ensureConductor(t.project.id);
    await until(() => t.store.getConductor(t.project.id) !== null, "생성 의도");
    await expect(t.orch.patchProject(t.project.id, { archived: true })).rejects.toMatchObject({ status: 409 });
    expect(t.store.requireProject(t.project.id).archived).toBe(false);
    finish(); await spawning;
  });

  test("종료 뒤 DB commit이 실패해도 장벽을 풀고 종료한 큐를 asleep으로 남긴다", async () => {
    const t = await setup(); const member = managed(t, "worker");
    const delivery = t.store.enqueue({ projectId: t.project.id, memberId: member.id, kind: "instruction", text: "보존" });
    const patch = t.store.patchProject.bind(t.store);
    t.store.patchProject = () => { throw new Error("injected DB write failure"); };
    await expect(t.orch.patchProject(t.project.id, { archived: true })).rejects.toThrow("DB write failure");
    t.store.patchProject = patch;
    expect(t.store.requireProject(t.project.id).archived).toBe(false);
    expect(t.store.requireDelivery(delivery.id)).toMatchObject({ status: "held", holdReason: "asleep" });
    await t.orch.patchProject(t.project.id, { name: "복구" });
    expect(t.store.requireProject(t.project.id).name).toBe("복구");
    expect(t.runner.starts).toHaveLength(0);
  });

  test("부분 종료 불명은 journal로 복구하고 PATCH 필드/세션과 기존 asleep 보류를 보존한다", async () => {
    const t = await setup({ timings: { tickMs: 60_000, healthMs: 60_000 } });
    const a = managed(t, "first"), b = managed(t, "second");
    const first = t.store.enqueue({ projectId: t.project.id, memberId: a.id, kind: "instruction", text: "대기" });
    t.runner.stopErrors.set(b.id, new Error("종료 ACK 유실"));
    await expect(t.orch.patchProject(t.project.id, { archived: true, name: "반영 금지" })).rejects.toMatchObject({ status: 503 });
    expect(t.store.requireProject(t.project.id)).toMatchObject({ archived: false, name: "시험" });
    expect(t.store.requireMember(a.id)).toMatchObject({ status: "asleep", paneId: null, sessionId: a.sessionId });
    expect(t.store.requireDelivery(first.id)).toMatchObject({ status: "held", holdReason: "asleep" });
    expect(t.store.requireMember(b.id)).toMatchObject({ paneId: b.paneId, sessionId: b.sessionId });
    expect(t.store.listPendingLifecycleJournals()).toEqual([expect.objectContaining({ memberId: b.id, intent: "archive", phase: "unknown" })]);
    await t.orch.shutdown(); t.runner.stopErrors.clear();
    const restarted = new Orchestrator({ config: t.config, store: t.store, runners: t.runners, herdr: t.herdr as never, timings: { tickMs: 60_000, healthMs: 60_000 } });
    closers.push(() => restarted.shutdown()); await restarted.recover();
    expect(t.store.requireMember(b.id)).toMatchObject({ status: "asleep", paneId: null, sessionId: b.sessionId });
    expect(t.store.listPendingLifecycleJournals()).toHaveLength(0);
    expect(t.store.requireProject(t.project.id).archived).toBe(false);
    expect(t.runner.starts).toHaveLength(0);
    await restarted.patchProject(t.project.id, { archived: true });
    await restarted.patchProject(t.project.id, { archived: false });
    expect(t.runner.starts).toHaveLength(0);
    expect(t.store.requireDelivery(first.id)).toMatchObject({ status: "held", holdReason: "asleep" });
  });
});

describe("재시작 정리", () => {
  test("다시 연 결재는 직전 답과 메모를 남긴다", async () => {
    const t = await setup({ timings: { tickMs: 60_000 } });
    const w = t.store.createMember({ projectId: t.project.id, handle: "cs", name: "철수", role: "개발", kind: "worker", origin: "runner", status: "idle" });
    const d = t.store.createDecision({ projectId: t.project.id, memberId: w.id, who: "철수", title: "t", options: [{ k: "a", label: "가" }] });
    t.store.answerDecision(d.id, { choice: "a", note: "길게 쓴 메모" });
    const delivery = t.store.enqueue({ projectId: t.project.id, memberId: w.id, kind: "answer", text: "답", refType: "decision", refId: d.id });
    t.store.markHeld(delivery.id, "runner_disabled");
    expect(t.store.releaseHeldBeforeConnection().decisions).toBe(1);
    expect(t.store.requireDecision(d.id)).toMatchObject({ status: "open", choice: null, note: null, lastChoice: "a", lastNote: "길게 쓴 메모", reopenNote: expect.stringContaining("연결 전") });
    t.store.answerDecision(d.id, { choice: "a" });
    expect(t.store.requireDecision(d.id)).toMatchObject({ lastChoice: null, lastNote: null, reopenNote: null });
  });

  test("가져온 못 읽은 말은 재시작을 지나도 보류로 남고, 총괄을 시작하면 전달된다", async () => {
    const t = await setup({ runnerEnabled: false });
    const message = t.store.createMessage({ projectId: t.project.id, mine: true, who: "나", kind: "나", body: "가져온 말", delivery: "held", deliveryNote: IMPORT_HOLD_NOTE });
    t.store.releaseHeldBeforeConnection();
    expect(t.store.requireMessage(message.id).delivery).toBe("held");
    expect((await t.api("POST", `/api/projects/${t.project.id}/conductor/start`)).status).toBe(200);
    await until(() => t.runner.sent.some((s) => s.text.includes("가져온 말")), "총괄에게 전달");
  });
});

describe("편입", () => {
  test("편입이 켠 실행에서는 멈춘 말이 총괄을 띄우지 않고, 해제하면 실행이 꺼진다", async () => {
    const t = await setup({ runnerEnabled: false });
    t.store.createMessage({ projectId: t.project.id, mine: true, who: "나", kind: "나", body: "옛 지시", delivery: "held", deliveryNote: IMPORT_HOLD_NOTE });
    const a = await t.orch.adopt(t.project.id, { paneId: "live1", name: "철수", role: "개발", handle: "cs" });
    await Bun.sleep(80);
    expect(t.store.getConductor(t.project.id)).toBeNull();
    expect(t.runner.starts.length).toBe(0);
    expect(t.runner.sent.some((s) => s.text.includes("옛 지시"))).toBe(false);
    t.runner.cb({ type: "turn_end", memberId: a.id, finalText: "", isError: false });
    await until(() => t.store.requireMember(a.id).status === "idle", "대기");
    await t.orch.releaseMember(a.id);
    expect(t.store.requireProject(t.project.id).runnerEnabled).toBe(false);
    expect(t.store.runnerByAdopt(t.project.id)).toBe(false);
  });

  test("할 일 체크도 편입이 켠 실행에서 총괄을 띄우지 않고, 총괄을 시작하면 표시가 풀린다", async () => {
    const t = await setup({ runnerEnabled: false });
    await t.orch.adopt(t.project.id, { paneId: "live1", name: "철수", role: "개발", handle: "cs" });
    const todo = t.store.createTodo({ projectId: t.project.id, who: "x", title: "할 일" });
    await t.orch.setTodoDone(todo.id, true);
    await Bun.sleep(60);
    expect(t.store.getConductor(t.project.id)).toBeNull();
    expect((await t.api("POST", `/api/projects/${t.project.id}/conductor/start`)).status).toBe(200);
    expect(t.store.getConductor(t.project.id)).not.toBeNull();
    expect(t.store.runnerByAdopt(t.project.id)).toBe(false);
  });
});

describe("죽은 직접 세션", () => {
  test("답을 기다리다 조용해지면 offline 으로 내려 게이트가 닫히고, 롱폴이 살아 있으면 내려가지 않는다", async () => {
    const t = await setup({ runnerEnabled: false, timings: { manualOfflineMs: 150, manualIdleMs: 50 } });
    const m = await t.manual();
    const ask = await t.api("POST", "/agent/tool", { name: "ask", args: { title: "물음", detail: "내용" } }, m.token);
    const { wait } = (await ask.json()) as { wait: { decisionId: string } };
    await until(() => t.store.requireMember(m.member.id).status === "waiting", "대기");
    // 살아 있는 동안
    for (let i = 0; i < 6; i++) {
      await t.api("POST", "/agent/ask/wait", { decisionId: wait.decisionId, timeoutMs: 1 }, m.token);
      await Bun.sleep(50);
      expect(t.store.requireMember(m.member.id).status).toBe("waiting");
    }
    expect(t.store.requireProject(t.project.id).connection.ok).toBe(true);
    // 죽은 뒤
    await until(() => t.store.requireMember(m.member.id).status === "offline", "offline");
    expect(t.store.requireProject(t.project.id).connection).toMatchObject({ ok: false, reason: "runner_off" });
    // 맥이 잠들었다 깬 것처럼 브리지가 다시 부르면 되살아난다.
    await t.api("POST", "/agent/ask/wait", { decisionId: wait.decisionId, timeoutMs: 1 }, m.token);
    expect(t.store.requireMember(m.member.id).status).toBe("waiting");
  });
});
