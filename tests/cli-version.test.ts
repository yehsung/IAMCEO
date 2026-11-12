// D9: 서버가 Claude Code·Codex 버전을 읽고, 처음 본 시각을 남기고, 견본이 없는 버전을 '확인되지 않은 CLI 버전'으로 드러낸다.
// 진짜 CLI 는 띄우지 않는다. 버전 한 줄만 찍는 가짜 실행 파일을 임시 폴더에 만든다.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import {
  CLI_VERSION_LEDGER, CliVersionMonitor, describeCliVersion, isVerifiedCliVersion, parseCliVersion, readCliVersionLedger,
  readCliVersions, recordCliVersions, VERIFIED_CLI_VERSIONS, type CliVersionChange, type CliVersionInfo,
} from "../server/cli-version.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import type { Bootstrap, SyncSnapshot } from "../shared/types.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function dir(prefix = "iamceo-cli-version-"): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }
/** 부를 때마다 count 파일에 한 줄을 더하고 output 을 찍는 가짜 CLI. */
function fakeCli(folder: string, name: string, output: string, options: { exit?: number; sleep?: number } = {}): { path: string; calls: () => number } {
  const path = join(folder, name), count = join(folder, `${name}.count`);
  writeFileSync(path, `#!/bin/sh\necho x >> '${count}'\n${options.sleep ? `sleep ${options.sleep}\n` : ""}[ "$1" = "--version" ] || exit 9\necho '${output}'\nexit ${options.exit ?? 0}\n`);
  chmodSync(path, 0o755);
  return { path, calls: () => existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0 };
}

describe("버전 글 해석", () => {
  test("Claude Code·Codex 의 --version 출력과 화면 머리글에서 버전 번호를 꺼낸다", () => {
    expect(parseCliVersion("2.1.322 (Claude Code)")).toBe("2.1.322");
    expect(parseCliVersion("codex-cli 0.166.0")).toBe("0.166.0");
    expect(parseCliVersion("│ >_ OpenAI Codex (v0.166.0)  │")).toBe("0.166.0");
    expect(parseCliVersion(" ▐▛███▜▌   Claude Code v2.1.322\n")).toBe("2.1.322");
    expect(parseCliVersion("codex-cli 0.170.0-alpha.2")).toBe("0.170.0-alpha.2");
    for (const text of ["", "claude", "1.2", "version 10.4", "127.0.0.1.5"]) expect([text, parseCliVersion(text)]).toEqual([text, null]);
  });
  test("견본으로 확인된 버전만 known 이다", () => {
    expect(isVerifiedCliVersion("claude", "2.1.322")).toBe(true);
    expect(isVerifiedCliVersion("codex", "0.166.0")).toBe(true);
    expect(isVerifiedCliVersion("claude", "0.166.0")).toBe(false);
    expect(isVerifiedCliVersion("claude", "2.1.999")).toBe(false);
    expect(isVerifiedCliVersion("codex", null)).toBe(false);
    for (const provider of ["claude", "codex"] as const) for (const v of VERIFIED_CLI_VERSIONS[provider]) expect(parseCliVersion(v)).toBe(v);
  });
  test("사람이 읽는 한 줄은 평이한 한국어다", () => {
    expect(describeCliVersion({ provider: "claude", installed: false, version: null, known: false })).toBe("Claude Code가 설치되어 있지 않습니다");
    expect(describeCliVersion({ provider: "codex", installed: true, version: null, known: false })).toBe("Codex 버전을 확인하지 못했습니다");
    expect(describeCliVersion({ provider: "claude", installed: true, version: "2.1.322", known: true })).toBe("Claude Code 2.1.322");
    expect(describeCliVersion({ provider: "claude", installed: true, version: "2.1.400", known: false })).toBe("Claude Code 2.1.400은 확인되지 않은 CLI 버전입니다");
  });
});

describe("readCliVersions (약속 5)", () => {
  test("설치된 CLI 의 버전과 확인 여부, 없는 CLI 는 installed=false", async () => {
    const bin = dir();
    const claude = fakeCli(bin, "claude", "2.1.322 (Claude Code)");
    const infos = await readCliVersions({ claudeBin: claude.path, codexBin: join(bin, "no-such-codex") });
    expect(infos).toEqual([
      { provider: "claude", installed: true, version: "2.1.322", known: true },
      { provider: "codex", installed: false, version: null, known: false },
    ]);
    expect(claude.calls()).toBe(1);
  });
  test("확인되지 않은 버전, 실패하는 CLI, 답이 늦은 CLI", async () => {
    const bin = dir();
    const codex = fakeCli(bin, "codex", "codex-cli 0.199.0");
    const failing = fakeCli(bin, "claude", "2.1.322 (Claude Code)", { exit: 1 });
    expect(await readCliVersions({ claudeBin: failing.path, codexBin: codex.path })).toEqual([
      { provider: "claude", installed: true, version: null, known: false },
      { provider: "codex", installed: true, version: "0.199.0", known: false },
    ]);
    const slow = fakeCli(dir(), "claude", "2.1.322 (Claude Code)", { sleep: 5 });
    const started = performance.now();
    const [claude] = await readCliVersions({ claudeBin: slow.path, codexBin: codex.path, timeoutMs: 200 });
    expect(claude).toEqual({ provider: "claude", installed: true, version: null, known: false });
    expect(performance.now() - started).toBeLessThan(3_000);
  });
  test("home 을 주면 처음 본 시각을 기록하고 붙인다", async () => {
    const bin = dir(), home = dir("iamceo-cli-home-");
    const claude = fakeCli(bin, "claude", "2.1.322 (Claude Code)"), codex = fakeCli(bin, "codex", "codex-cli 0.166.0");
    const first = await readCliVersions({ claudeBin: claude.path, codexBin: codex.path, home, now: () => new Date("2026-11-13T01:00:00.000Z") });
    expect(first.map(i => i.firstSeenAt)).toEqual(["2026-11-13T01:00:00.000Z", "2026-11-13T01:00:00.000Z"]);
    const later = await readCliVersions({ claudeBin: claude.path, codexBin: codex.path, home, now: () => new Date("2026-11-20T01:00:00.000Z") });
    expect(later.map(i => i.firstSeenAt)).toEqual(["2026-11-13T01:00:00.000Z", "2026-11-13T01:00:00.000Z"]);
    expect(statSync(join(home, CLI_VERSION_LEDGER)).mode & 0o777).toBe(0o600);
    expect(readCliVersionLedger(home).seen.claude["2.1.322"]).toEqual({ firstSeenAt: "2026-11-13T01:00:00.000Z", lastSeenAt: "2026-11-20T01:00:00.000Z" });
  });
});

describe("처음 본 시각 기록", () => {
  const info = (version: string | null, known = false): CliVersionInfo => ({ provider: "claude", installed: true, version, known });
  test("새 버전만 changes 로 알리고, 모르는 버전(null)은 기록하지 않는다", () => {
    const home = dir("iamceo-cli-home-");
    const a = recordCliVersions(home, [info("2.1.322", true)], new Date("2026-11-13T00:00:00.000Z"));
    expect(a.changes).toEqual([{ provider: "claude", version: "2.1.322", known: true, firstSeenAt: "2026-11-13T00:00:00.000Z" }]);
    const b = recordCliVersions(home, [info("2.1.322", true)], new Date("2026-11-13T05:00:00.000Z"));
    expect(b.changes).toEqual([]);
    expect(b.infos[0]!.firstSeenAt).toBe("2026-11-13T00:00:00.000Z");
    const c = recordCliVersions(home, [info("2.1.400"), info(null)], new Date("2026-11-14T00:00:00.000Z"));
    expect(c.changes.map(change => change.version)).toEqual(["2.1.400"]);
    expect(c.infos[1]).toEqual(info(null));
    expect(Object.keys(readCliVersionLedger(home).seen.claude).sort()).toEqual(["2.1.322", "2.1.400"]);
  });
  test("깨진 기록 파일은 빈 기록으로 보고 새로 쓴다(서버를 멈추지 않는다)", () => {
    const home = dir("iamceo-cli-home-");
    for (const broken of ["{", "[]", JSON.stringify({ version: 2, seen: {} }), JSON.stringify({ version: 1, seen: { claude: { "not-a-version": { firstSeenAt: "x", lastSeenAt: "x" } } } })]) {
      writeFileSync(join(home, CLI_VERSION_LEDGER), broken);
      const result = recordCliVersions(home, [info("2.1.322", true)], new Date("2026-11-13T00:00:00.000Z"));
      expect(result.changes).toHaveLength(1);
      expect(Object.keys(readCliVersionLedger(home).seen.claude)).toEqual(["2.1.322"]);
    }
  });
});

describe("CliVersionMonitor", () => {
  test("실행 파일이 그대로면 다시 부르지 않고, 바뀌면(업데이트) 다시 읽어 처음 본 버전을 알린다", async () => {
    const bin = dir(), home = dir("iamceo-cli-home-");
    const claude = fakeCli(bin, "claude", "2.1.322 (Claude Code)"), codex = fakeCli(bin, "codex", "codex-cli 0.166.0");
    let now = 0;
    const changes: CliVersionChange[] = [], updates: CliVersionInfo[][] = [];
    const monitor = new CliVersionMonitor({ home, claudeBin: claude.path, codexBin: codex.path, recheckMs: 1_000, clock: () => now,
      onChange: change => changes.push(change), onUpdate: infos => updates.push(infos) });
    expect(monitor.snapshot()).toBeUndefined();
    const first = await monitor.refresh();
    expect(first.map(i => [i.provider, i.version, i.known])).toEqual([["claude", "2.1.322", true], ["codex", "0.166.0", true]]);
    expect(changes.map(c => `${c.provider} ${c.version} ${c.known}`)).toEqual(["claude 2.1.322 true", "codex 0.166.0 true"]);
    expect(updates).toHaveLength(1);
    expect(monitor.snapshot()).toEqual(first);
    // 간격 안에서는 실행 파일도 보지 않는다. 간격이 지나도 실행 파일이 그대로면 --version 을 부르지 않는다.
    now = 500; monitor.snapshot(); now = 2_000; await monitor.refresh();
    expect([claude.calls(), codex.calls()]).toEqual([1, 1]);
    expect(updates).toHaveLength(1);
    // brew 업데이트처럼 실행 파일이 바뀌었다.
    const updated = fakeCli(bin, "claude", "2.1.401 (Claude Code)");
    utimesSync(updated.path, new Date(), new Date(Date.now() + 5_000));
    now = 4_000;
    const after = await monitor.refresh();
    expect(after[0]).toMatchObject({ provider: "claude", version: "2.1.401", known: false });
    expect(after[0]!.firstSeenAt).toBeDefined();
    expect(changes.at(-1)).toMatchObject({ provider: "claude", version: "2.1.401", known: false });
    expect(updates).toHaveLength(2);
    expect(codex.calls()).toBe(2);
  });
  test("겹친 refresh 는 한 번만 부르고, 버전을 못 읽었으면 다음에 다시 묻는다", async () => {
    const bin = dir();
    const claude = fakeCli(bin, "claude", "2.1.322 (Claude Code)", { exit: 1 }), codex = fakeCli(bin, "codex", "codex-cli 0.166.0");
    const monitor = new CliVersionMonitor({ claudeBin: claude.path, codexBin: codex.path, onChange: () => undefined });
    const [a, b] = await Promise.all([monitor.refresh(), monitor.refresh()]);
    expect(a).toBe(b);
    expect(claude.calls()).toBe(1);
    await monitor.refresh();
    expect(claude.calls()).toBe(2);
  });
});

describe("Bootstrap 의 cliVersions 선택 필드", () => {
  function freshConfig(): Config {
    const home = dir("iamceo-cli-server-");
    const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
    updateConfigFile({ accessCode: "code" }, env);
    return { ...loadConfig(env), hosts: ["127.0.0.1"] };
  }
  async function boot(cliVersions?: { snapshot(): CliVersionInfo[] | undefined; refresh(): Promise<CliVersionInfo[]> }) {
    const config = freshConfig(), bus = new Bus(), store = new Store(openDb(config.dbPath), bus);
    const orch = new Orchestrator({ config, store, runners: new Map() });
    const context = { config, store, bus, orch, detectHosts: () => [], ...(cliVersions ? { cliVersions } : {}) };
    let server: RunningServer = await startServer(context);
    while (server.port === 7878) { await server.stop(); server = await startServer(context); }
    cleanups.push(async () => { await server.stop(); await orch.shutdown(); store.db.close(); });
    const get = async <T>(path: string) => (await (await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: "Bearer code" } })).json()) as T;
    return { get };
  }
  test("읽은 버전이 있으면 bootstrap·sync 에 싣고, 기존 cli(문자열)는 그대로다", async () => {
    const infos: CliVersionInfo[] = [{ provider: "claude", installed: true, version: "2.1.400", known: false, firstSeenAt: "2026-11-13T00:00:00.000Z" },
      { provider: "codex", installed: false, version: null, known: false }];
    const { get } = await boot({ snapshot: () => infos, refresh: async () => infos });
    const bootstrap = await get<Bootstrap>("/api/bootstrap");
    expect(bootstrap.cliVersions).toEqual(infos);
    expect(typeof bootstrap.cli).toBe("string");
    const sync = await get<SyncSnapshot>("/api/sync");
    expect(sync.bootstrap.cliVersions).toEqual(infos);
    expect(typeof sync.bootstrap.cli).toBe("string");
  });
  test("아직 못 읽었거나 시험 환경에서 주입하지 않으면 싣지 않는다(진짜 CLI 를 부르지 않는다)", async () => {
    const { get } = await boot();
    expect("cliVersions" in await get<Bootstrap>("/api/bootstrap")).toBe(false);
    const pending = await boot({ snapshot: () => undefined, refresh: async () => [] });
    expect("cliVersions" in (await pending.get<SyncSnapshot>("/api/sync")).bootstrap).toBe(false);
  });
});
