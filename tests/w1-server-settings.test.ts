// 1차 작업(서버): 권한 방식 확인(permissionAcknowledged), 프로젝트의 폴더 신뢰 기록, 팀장용 통로는 이 Mac 안에서만.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { isLocalRequest, startServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult, StartOpts } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import type { Bootstrap, Member, Project, Settings, SyncSnapshot } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

class QuietRunner implements Runner {
  readonly kind = "core" as const;
  started: StartOpts[] = [];
  async available() { return { ok: true }; }
  async start(member: RunnerMember, opts: StartOpts) { this.started.push(opts); return { sessionId: member.sessionId ?? `native-${member.id}`, paneId: `pane-${member.id}` }; }
  async send(): Promise<SendResult> { return { ok: true, started: true, turn: 0 }; }
  isBusy() { return false; }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async stop() {}
  async interrupt() {}
  async screen() { return ""; }
  async shutdown() {}
  on(_callback: (event: RunnerEvent) => void) {}
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function runtime() {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_HERDR_SOCKET: isolated.herdrSocketPath,
    IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  cleanups.push(() => isolated.stop());
  return { isolated, config };
}

async function fixture() {
  const { isolated, config } = runtime();
  const db = openDb(config.dbPath), bus = new Bus(), store = new Store(db, bus), runner = new QuietRunner();
  store.patchSettings({ boardTidyHours: 0 });
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), timings: { tickMs: 60_000, healthMs: 60_000 } });
  let server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery, folderHome: isolated.paths.home, detectHosts: () => [] });
  while (server.port === 7878) { await server.stop(); server = await startServer({ config, store, bus, orch, delivery: orch.deliveryRecovery, folderHome: isolated.paths.home, detectHosts: () => [] }); }
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); db.close(); });
  const url = `http://127.0.0.1:${server.port}`;
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}) => fetch(url + path, {
    method, headers: { Authorization: `Bearer ${config.accessCode}`, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { isolated, config, db, store, orch, runner, request, url };
}

describe("권한 방식 확인", () => {
  test("새로 만든 DB 는 확인 전이고, 다시 열어도 그대로다", () => {
    const { config } = runtime();
    let db = openDb(config.dbPath), store = new Store(db, new Bus());
    expect(store.getSettings().permissionAcknowledged).toBe(false);
    // 확인 전에 프로젝트를 만들어도 저절로 확인된 것으로 바뀌지 않는다.
    store.createProject({ name: "첫 프로젝트", cwd: "/tmp" });
    db.close();
    db = openDb(config.dbPath); store = new Store(db, new Bus());
    expect(store.getSettings().permissionAcknowledged).toBe(false);
    expect(db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'permissionAcknowledged'").get()).toEqual({ value: "false" });
    db.close();
  });

  test("이미 쓰던 DB(값이 저장된 적 없는 DB)는 확인된 것으로 시작한다", () => {
    for (const used of ["project", "member", "message", "none"] as const) {
      const { config } = runtime();
      let db = openDb(config.dbPath), store = new Store(db, new Bus());
      if (used === "project") store.createProject({ name: "쓰던 프로젝트", cwd: "/tmp" });
      if (used === "member") store.createMember({ projectId: "hq", handle: "lead", name: "총괄", kind: "conductor" });
      if (used === "message") store.createMessage({ projectId: "hq", mine: true, kind: "나", who: "대표", body: "안녕하세요" });
      // 이 필드가 없던 서버가 만든 DB 를 흉내 낸다.
      db.exec("DELETE FROM settings WHERE key = 'permissionAcknowledged'");
      db.close();
      db = openDb(config.dbPath); store = new Store(db, new Bus());
      expect([used, store.getSettings().permissionAcknowledged]).toEqual([used, used !== "none"]);
      db.close();
    }
  });

  test("조회로 내려가고, 설정 변경 경로는 true 만 받는다", async () => {
    const f = await fixture();
    const boot = await (await f.request("/api/bootstrap")).json() as Bootstrap;
    expect(boot.settings.permissionAcknowledged).toBe(false);
    // 엔진 상태를 모르는 조립(엔진이 없는 실행 방식)에서는 engine 을 싣지 않는다. 기존 응답 모양 그대로다.
    expect("engine" in boot).toBe(false);
    const snapshot = await (await f.request("/api/sync")).json() as SyncSnapshot;
    expect(snapshot.bootstrap.settings.permissionAcknowledged).toBe(false);

    for (const [method, body] of [["PATCH", { permissionAcknowledged: false }], ["PATCH", {}], ["PATCH", { permissionAcknowledged: "yes" }], ["PUT", { permissionAcknowledged: "yes" }]] as const) {
      expect([method, JSON.stringify(body), (await f.request("/api/settings", body, method)).status]).toEqual([method, JSON.stringify(body), 400]);
    }
    expect(f.store.getSettings().permissionAcknowledged).toBe(false);
    // 받은 설정을 통째로 돌려보내는 화면: 확인 전의 false 가 섞여 와도 저장은 되고 확인 여부는 그대로다.
    const { resetEfforts: _none, ...whole } = boot.settings;
    expect((await f.request("/api/settings", { ...whole, compactAtPct: 65 }, "PUT")).status).toBe(200);
    expect(f.store.getSettings()).toMatchObject({ compactAtPct: 65, permissionAcknowledged: false });

    const patched = await f.request("/api/settings", { permissionAcknowledged: true }, "PATCH");
    expect(patched.status).toBe(200);
    expect((await patched.json() as Settings).permissionAcknowledged).toBe(true);
    expect(f.store.getSettings().permissionAcknowledged).toBe(true);
    // 다른 설정을 바꿔도 확인은 그대로 남고, 기존 PATCH 본문도 그대로 받는다.
    expect(((await (await f.request("/api/settings", { macScriptNotifications: false }, "PATCH")).json()) as Settings)).toMatchObject({ macScriptNotifications: false, permissionAcknowledged: true });
    expect(((await (await f.request("/api/settings", { compactAtPct: 60, permissionAcknowledged: true }, "PUT")).json()) as Settings)).toMatchObject({ compactAtPct: 60, permissionAcknowledged: true });
    expect(((await (await f.request("/api/bootstrap")).json()) as Bootstrap).settings.permissionAcknowledged).toBe(true);
    // 확인은 되돌리지 않는다: 옛 값(false)을 든 화면이 통째로 저장해도 그대로다.
    expect((await f.request("/api/settings", { ...whole, compactAtPct: 55 }, "PUT")).status).toBe(200);
    expect(f.store.getSettings()).toMatchObject({ compactAtPct: 55, permissionAcknowledged: true });
    expect(f.store.patchSettings({ permissionAcknowledged: false }).permissionAcknowledged).toBe(true);
  });

  test("검토 버전이 있는 변경(v2)도 받고 결과에 싣는다", async () => {
    const f = await fixture();
    const v2 = { "X-IAMCEO-Contract": "2", "If-Match": `"${f.store.settingsRevision()}"` };
    const response = await f.request("/api/settings", { permissionAcknowledged: true }, "PATCH", v2);
    expect(response.status).toBe(200);
    const result = await response.json() as { settings: Settings; revision: number };
    expect(result.settings.permissionAcknowledged).toBe(true);
    expect(result.revision).toBe(f.store.settingsRevision());
  });

  test("확인 전에는 CLI 의 위험 모드 경고를 대신 꺼 주지 않는다", async () => {
    const f = await fixture();
    expect(f.store.getSettings().permissionMode).toBe("bypassPermissions");
    const project = f.store.createProject({ name: "경고 창", cwd: f.isolated.paths.work });
    await f.orch.addMember(project.id, { name: "먼저 온 팀장", handle: "first", role: "개발" });
    expect(JSON.parse(readFileSync(f.runner.started[0]!.settingsFile!, "utf8")).skipDangerousModePermissionPrompt).toBeUndefined();
    expect((await f.request("/api/settings", { permissionAcknowledged: true }, "PATCH")).status).toBe(200);
    await f.orch.addMember(project.id, { name: "나중 온 팀장", handle: "second", role: "개발" });
    expect(JSON.parse(readFileSync(f.runner.started[1]!.settingsFile!, "utf8")).skipDangerousModePermissionPrompt).toBe(true);
  });
});

describe("프로젝트의 폴더 신뢰 기록", () => {
  test("POST /api/projects 의 trustFolder 를 그 프로젝트의 그 폴더에만 남긴다", async () => {
    const f = await fixture();
    const cwd = f.isolated.paths.work;
    const trusted = await (await f.request("/api/projects", { name: "신뢰한 폴더", cwd, trustFolder: true })).json() as Project;
    const plain = await (await f.request("/api/projects", { name: "묻지 않은 폴더", cwd })).json() as Project;
    const declined = await (await f.request("/api/projects", { name: "거절한 폴더", cwd, trustFolder: false })).json() as Project;
    expect(f.store.projectFolderTrusted(trusted.id, trusted.cwd)).toBe(true);
    expect(f.store.projectFolderTrusted(trusted.id, `${trusted.cwd}/sub`)).toBe(false);
    expect(f.store.projectFolderTrusted(plain.id, plain.cwd)).toBe(false);
    expect(f.store.projectFolderTrusted(declined.id, declined.cwd)).toBe(false);
    expect(f.store.projectFolderTrusted("hq", f.store.requireProject("hq").cwd)).toBe(false);
    // 응답의 기존 모양은 그대로다.
    expect(Object.keys(trusted).sort()).toEqual(Object.keys(plain).sort());
    expect((await f.request("/api/projects", { name: "잘못된 값", cwd, trustFolder: "yes" })).status).toBe(400);
    // 다시 열어도 남는다.
    expect(new Store(f.db, new Bus()).projectFolderTrusted(trusted.id, trusted.cwd)).toBe(true);
  });
});

describe("팀장용 통로는 이 Mac 안에서만", () => {
  test("실제 상대 주소가 이 컴퓨터일 때만 받고, 대리 전달 헤더가 있으면 거부한다", () => {
    const none = new Headers();
    for (const ip of ["127.0.0.1", "127.8.9.1", "::1", "::ffff:127.0.0.1"]) expect([ip, isLocalRequest(ip, none)]).toEqual([ip, true]);
    for (const ip of ["100.64.0.7", "100.101.102.103", "192.0.2.10", "fd7a:115c:a1e0::9", "2001:db8::1", "", "garbage"]) expect([ip, isLocalRequest(ip, none)]).toEqual([ip, false]);
    expect(isLocalRequest(null, none)).toBe(false);
    expect(isLocalRequest(undefined, none)).toBe(false);
    for (const name of ["X-Forwarded-For", "Forwarded", "X-Real-IP", "Tailscale-User-Login", "X-Forwarded-Host", "X-Forwarded-Proto"]) {
      expect([name, isLocalRequest("127.0.0.1", new Headers({ [name]: "100.64.0.7" }))]).toEqual([name, false]);
    }
    // loopback 을 hosts 에서 뺀 설치는 자기 주소로 자기에게 붙는다. 그것도 이 Mac 안이다.
    const own = Object.values(networkInterfaces()).flat().find(a => a && !a.internal && a.family === "IPv4")?.address;
    if (own) {
      expect(isLocalRequest(own, none)).toBe(true);
      expect(isLocalRequest(own, new Headers({ "x-forwarded-for": "198.51.100.1" }))).toBe(false);
    }
  });

  test("/agent/* 와 /agent/join 은 같은 컴퓨터의 요청만 처리한다", async () => {
    const f = await fixture();
    const project = f.store.createProject({ name: "통로", cwd: f.isolated.paths.work });
    const member = f.store.createMember({ projectId: project.id, handle: "pay", name: "결제 연동", kind: "worker", cwd: project.cwd, origin: "manual", status: "idle" });
    const token = f.store.getMemberToken(member.id);
    const agent = (path: string, init: RequestInit = {}, extra: Record<string, string> = {}) => fetch(f.url + path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra } });

    // 팀장의 도구 연결(같은 컴퓨터, 대리 전달 없음)은 그대로 된다.
    expect((await agent("/agent/tools")).status).toBe(200);
    const joined = await agent("/agent/join", { method: "POST", body: "{}" });
    expect(joined.status).toBe(200);
    expect(((await joined.json()) as { member: Member; token: string }).token).toBe(token);

    // 다른 기기의 요청을 대신 전하는 연결(대리 전달 헤더)은 열쇠가 맞아도 받지 않는다.
    for (const [path, init] of [["/agent/tools", {}], ["/agent/tool", { method: "POST", body: JSON.stringify({ name: "status", args: {} }) }], ["/agent/join", { method: "POST", body: "{}" }]] as const) {
      const refused = await agent(path, init, { "X-Forwarded-For": "100.64.0.7" });
      expect([path, refused.status]).toEqual([path, 403]);
      expect((await refused.json() as { code?: string }).code).toBe("LOCAL_ONLY");
      expect(refused.headers.get("cache-control")).toBe("no-store");
    }
    // 대표 화면용 API 는 영향을 받지 않는다.
    expect((await f.request("/api/bootstrap", undefined, "GET", { "X-Forwarded-For": "100.64.0.7" })).status).toBe(200);
  });
});
