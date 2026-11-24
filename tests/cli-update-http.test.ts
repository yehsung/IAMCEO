// 0.2.11: CLI 새 판 알림·원클릭 업데이트의 HTTP 경로, 스냅샷 칸, 점검표 줄, 알림·적용 잇기(server/http.ts).
// 서비스는 가짜를 넣는다(진짜 CLI·네트워크를 쓰지 않는다). 시험 환경(IAMCEO_TEST)의 서버는 스스로 서비스를 만들지 않는다.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { CliUpdateError, type CliUpdateSource } from "../server/cli-update.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { announceCliUpdate, cliUpdateInstalled, startServer, type RunningServer, type ServerContext } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { PushStore } from "../server/push/store.ts";
import { Store } from "../server/store.ts";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push.ts";
import type { Bootstrap, CliProvider, CliUpdateInfo, CliUpdateRun, CliUpdatesResponse, DoctorReport, SyncSnapshot } from "../shared/types.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const CODEX: CliUpdateInfo = { cli: "codex", current: "0.166.0", latest: "0.172.0", available: true, latestVerified: false, method: "npm_global", oneClick: true,
  manualCommand: "npm install -g @openai/codex@latest", source: "npm @openai/codex", checkedAt: "2026-11-25T00:00:00.000Z", liveSessions: 2 };
const CLAUDE: CliUpdateInfo = { cli: "claude", current: "2.1.331", latest: "2.1.331", available: false, latestVerified: false, method: "brew_cask", oneClick: true,
  manualCommand: "brew upgrade --cask claude-code@latest", source: "Homebrew cask claude-code@latest", checkedAt: "2026-11-25T00:00:00.000Z" };

function fakeUpdates(list: CliUpdateInfo[]) {
  const calls: string[] = [];
  const source: CliUpdateSource = {
    list: () => list,
    info: cli => list.find(info => info.cli === cli) ?? { ...CLAUDE, cli, current: null, latest: null, available: false },
    check: async force => { calls.push(`check:${force}`); return list; },
    update: (cli, to) => {
      calls.push(`update:${cli}:${to ?? ""}`);
      if (cli === "claude") throw new CliUpdateError(409, "cli_update_none");
      if (!["claude", "codex", "gemini"].includes(cli)) throw new CliUpdateError(404, "cli_update_unknown_cli");
      const run: CliUpdateRun = { id: randomUUID(), cli, from: "0.166.0", to: "0.172.0", phase: "downloading", startedAt: "2026-11-25T00:00:00.000Z", endedAt: null, installed: null, error: null, manualCommand: CODEX.manualCommand };
      return run;
    },
  };
  return { source, calls };
}

async function boot(extra: Partial<ServerContext> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-cli-update-http-")));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  const config: Config = { ...loadConfig(env), hosts: ["127.0.0.1"] };
  const bus = new Bus(), store = new Store(openDb(config.dbPath), bus);
  const notes: [string, string][] = [];
  const orch = new Orchestrator({ config, store, runners: new Map(), notifier: (title, body) => { notes.push([title, body]); } });
  const context: ServerContext = { config, store, bus, orch, detectHosts: () => [], ...extra };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); store.db.close(); });
  const call = async <T>(path: string, init: RequestInit = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { Authorization: "Bearer code", "Content-Type": "application/json", ...(init.headers ?? {}) } });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  };
  return { call, store, orch, context, notes, config };
}

describe("GET·POST /api/cli-updates", () => {
  test("설치된 CLI 마다의 상태를 돌려준다. refresh=1 이면 최신 판을 다시 읽는다. 모르는 조회 조건은 400", async () => {
    const fake = fakeUpdates([CLAUDE, CODEX]);
    const { call } = await boot({ cliUpdates: fake.source });
    const listed = await call<CliUpdatesResponse>("/api/cli-updates");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ updates: [CLAUDE, CODEX] });
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(fake.calls).toEqual([]);
    await call("/api/cli-updates?refresh=1");
    expect(fake.calls).toEqual(["check:true"]);
    expect((await call<{ code: string }>("/api/cli-updates?x=1")).status).toBe(400);
    expect((await call<CliUpdateInfo>("/api/cli-updates/codex")).body).toEqual(CODEX);
  });
  test("업데이트 시작은 202 와 진행 값. 서비스의 거절은 같은 상태·코드로, 잘못된 본문은 400", async () => {
    const fake = fakeUpdates([CLAUDE, CODEX]);
    const { call } = await boot({ cliUpdates: fake.source });
    const started = await call<CliUpdateRun>("/api/cli-updates/codex", { method: "POST", body: JSON.stringify({ to: "0.172.0" }) });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ cli: "codex", phase: "downloading", to: "0.172.0" });
    expect(fake.calls).toEqual(["update:codex:0.172.0"]);
    const refused = await call<{ code: string; error: string }>("/api/cli-updates/claude", { method: "POST", body: "{}" });
    expect([refused.status, refused.body.code]).toEqual([409, "cli_update_none"]);
    const unknown = await call<{ code: string }>("/api/cli-updates/nope", { method: "POST", body: "{}" });
    expect([unknown.status, unknown.body.code]).toEqual([404, "cli_update_unknown_cli"]);
    expect((await call("/api/cli-updates/codex", { method: "POST", body: JSON.stringify({ to: "latest; rm -rf" }) })).status).toBe(400);
    expect((await call("/api/cli-updates/codex", { method: "POST", body: JSON.stringify({ extra: true }) })).status).toBe(400);
  });
  test("서비스가 없으면(옛 조립·시험 환경) 501 not_found. 스냅샷에도 칸이 없다", async () => {
    const { call } = await boot();
    const missing = await call<{ code: string }>("/api/cli-updates");
    expect([missing.status, missing.body.code]).toEqual([501, "not_found"]);
    expect("cliUpdates" in (await call<Bootstrap>("/api/bootstrap")).body).toBe(false);
    expect("cliUpdates" in (await call<SyncSnapshot>("/api/sync")).body.bootstrap).toBe(false);
  });
});

describe("스냅샷과 점검표", () => {
  test("bootstrap·sync 에 cliUpdates 를 싣는다(기존 칸은 그대로)", async () => {
    const { call } = await boot({ cliUpdates: fakeUpdates([CLAUDE, CODEX]).source });
    const bootstrap = (await call<Bootstrap>("/api/bootstrap")).body;
    expect(bootstrap.cliUpdates).toEqual([CLAUDE, CODEX]);
    expect(typeof bootstrap.cli).toBe("string");
    expect((await call<SyncSnapshot>("/api/sync")).body.bootstrap.cliUpdates).toEqual([CLAUDE, CODEX]);
  });
  test("점검표의 그 CLI 줄에 '새 판 X'를 덧붙인다(영어 화면은 new version)", async () => {
    const { call } = await boot({ cliUpdates: fakeUpdates([CLAUDE, CODEX]).source,
      doctorProbes: { cliVersions: async () => [{ provider: "claude", installed: true, version: "2.1.331", known: true }, { provider: "codex", installed: true, version: "0.166.0", known: true },
        { provider: "gemini", installed: false, version: null, known: false }], installed: () => true, login: () => "yes" } });
    const ko = (await call<DoctorReport>("/api/doctor")).body;
    expect(ko.checks.find(c => c.id === "codex")?.detail).toBe("설치됨 · 0.166.0 · 새 판 0.172.0 · 로그인됨");
    expect(ko.checks.find(c => c.id === "claude")?.detail).toBe("설치됨 · 2.1.331 · 로그인됨");
    const en = (await call<DoctorReport>("/api/doctor?lang=en")).body;
    expect(en.checks.find(c => c.id === "codex")?.detail).toBe("Installed · 0.166.0 · new version 0.172.0 · signed in");
  });
});

describe("알림과 적용 잇기", () => {
  test("새 판 알림: iPhone 푸시 사건(판마다 한 번)과 Mac 알림 한 줄", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-cli-update-notice-")));
    const store = new Store(openDb(join(home, "db.sqlite")), new Bus());
    cleanups.push(() => store.db.close());
    const providers = () => [{ environment: "sandbox" as const, bundleId: DEFAULT_PUSH_BUNDLE_ID, state: "ready" as const, lastError: null }];
    const push = new PushStore(store.db, { providers });
    const device = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: "ab", authorization: "authorized" });
    push.patchDevice(device.id, { expectedRevision: device.revision, enabled: true });
    const notes: [string, string][] = [];
    let wakes = 0;
    const ctx = { store, push: { store: push, providers, wake: () => { wakes++; } }, orch: { notifyOperations: (title: string, body: string) => { notes.push([title, body]); return true; } } };
    announceCliUpdate(ctx as unknown as ServerContext, CODEX);
    announceCliUpdate(ctx as unknown as ServerContext, CODEX);
    const events = push.listEvents().filter(e => e.kind === "cli_update");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sourceKey: "cli-update:codex:0.172.0", projectId: null, memberId: null, target: { screen: "home", cli: "codex", version: "0.172.0" } });
    expect(push.listDeliveries(events[0]!.id).map(d => d.state)).toEqual(["queued"]);
    expect(wakes).toBeGreaterThan(0);
    expect(notes[0]).toEqual(["IAMCEO · Codex 새 판", "Codex 0.172.0 업데이트가 있습니다. 설정 › AI 모델 › 실행 환경에서 업데이트할 수 있습니다."]);

    // 깔리면: 떠 있는 팀장에게 적용을 부르고, 아직 나가지 않은 그 판의 알림을 거둔다.
    const applied: CliProvider[] = [];
    const installedCtx = { ...ctx, orch: { ...ctx.orch, cliUpdated: async (cli: CliProvider) => { applied.push(cli); return { atNextTurn: 1 }; } } };
    await cliUpdateInstalled(installedCtx as unknown as ServerContext, "codex", "0.172.0");
    expect(applied).toEqual(["codex"]);
    expect(push.listDeliveries(events[0]!.id).map(d => d.state)).toEqual(["cancelled"]);
  });
});
