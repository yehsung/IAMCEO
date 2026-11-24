// D9: 서버가 Claude Code·Codex·Antigravity CLI(Gemini) 버전을 읽고, 처음 본 시각을 남기고, 견본이 없는 버전을 '확인되지 않은 CLI 버전'으로 드러낸다.
// 진짜 CLI 는 띄우지 않는다. 버전 한 줄만 찍는 가짜 실행 파일을 임시 폴더에 만든다.
// Antigravity CLI 자리는 부를 때마다 정해 준다(가짜이거나 없는 경로). 비워 두면 이름(agy)으로 찾아 이 Mac 에 깔린 진짜 agy 가 실행된다.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Bus } from "../server/bus.ts";
import {
  CLI_PROVIDERS, CLI_VERSION_LEDGER, CLI_VERSION_TIMEOUT_MS, CLI_VERSION_TIMEOUTS_MS, CliVersionMonitor, GEMINI_VERSION_RETRY_MS, describeCliVersion, isVerifiedCliVersion, logCliVersionChange,
  parseCliVersion, readCliVersionLedger, readCliVersions, recordCliVersions, resolveCliBinary, VERIFIED_CLI_VERSIONS, type CliVersionChange, type CliVersionInfo,
} from "../server/cli-version.ts";
import { loadConfig, updateConfigFile, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";
import { CLI_INFO, CLI_PROVIDERS as SHARED_CLI_PROVIDERS, type Bootstrap, type SyncSnapshot } from "../shared/types.ts";

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
/** Antigravity CLI 가 깔려 있지 않은 Mac: 없는 경로를 정해 준다(이름으로 찾지 않게). */
const noAgy = (folder: string) => join(folder, "no-such-agy");
const GEMINI_MISSING: CliVersionInfo = { provider: "gemini", installed: false, version: null, known: false };

describe("버전 글 해석", () => {
  test("Claude Code·Codex 의 --version 출력과 화면 머리글에서 버전 번호를 꺼낸다", () => {
    expect(parseCliVersion("2.1.322 (Claude Code)")).toBe("2.1.322");
    expect(parseCliVersion("codex-cli 0.166.0")).toBe("0.166.0");
    expect(parseCliVersion("│ >_ OpenAI Codex (v0.166.0)  │")).toBe("0.166.0");
    expect(parseCliVersion(" ▐▛███▜▌   Claude Code v2.1.322\n")).toBe("2.1.322");
    expect(parseCliVersion("codex-cli 0.170.0-alpha.2")).toBe("0.170.0-alpha.2");
    // agy --version 은 버전 번호 한 줄만 찍는다.
    expect(parseCliVersion("1.5.14")).toBe("1.5.14");
    expect(parseCliVersion("1.5.14\n")).toBe("1.5.14");
    for (const text of ["", "claude", "1.2", "version 10.4", "127.0.0.1.5"]) expect([text, parseCliVersion(text)]).toEqual([text, null]);
  });
  test("견본으로 확인된 버전만 known 이다", () => {
    expect(isVerifiedCliVersion("claude", "2.1.322")).toBe(true);
    expect(isVerifiedCliVersion("codex", "0.166.0")).toBe(true);
    expect(isVerifiedCliVersion("claude", "0.166.0")).toBe(false);
    expect(isVerifiedCliVersion("claude", "2.1.999")).toBe(false);
    expect(isVerifiedCliVersion("codex", null)).toBe(false);
    for (const provider of CLI_PROVIDERS) for (const v of VERIFIED_CLI_VERSIONS[provider]) expect(parseCliVersion(v)).toBe(v);
    // Antigravity CLI 는 gemini 줄로 본다. 다른 CLI 의 버전 표와 섞이지 않는다.
    expect(Object.keys(VERIFIED_CLI_VERSIONS).sort()).toEqual([...SHARED_CLI_PROVIDERS].sort());
    expect(VERIFIED_CLI_VERSIONS.gemini).toEqual(["1.5.14", "1.5.16"]);
    expect(isVerifiedCliVersion("gemini", "1.5.14")).toBe(true);
    // 0.2.11 출시 전 실측으로 더한 판(tests/fixtures/cli/<cli>/<판>).
    expect(isVerifiedCliVersion("gemini", "1.5.16")).toBe(true);
    expect(isVerifiedCliVersion("claude", "2.1.331")).toBe(true);
    expect(isVerifiedCliVersion("codex", "0.172.0")).toBe(true);
    expect(parseCliVersion("codex-cli 0.172.0")).toBe("0.172.0");
    expect(parseCliVersion("2.1.331 (Claude Code)")).toBe("2.1.331");
    expect(isVerifiedCliVersion("gemini", "0.166.0")).toBe(false);
    expect(isVerifiedCliVersion("codex", "1.5.14")).toBe(false);
  });
  test("사람이 읽는 한 줄은 평이한 한국어다", () => {
    expect(describeCliVersion({ provider: "claude", installed: false, version: null, known: false })).toBe("Claude Code가 설치되어 있지 않습니다");
    expect(describeCliVersion({ provider: "codex", installed: true, version: null, known: false })).toBe("Codex 버전을 확인하지 못했습니다");
    expect(describeCliVersion({ provider: "claude", installed: true, version: "2.1.322", known: true })).toBe("Claude Code 2.1.322");
    expect(describeCliVersion({ provider: "claude", installed: true, version: "2.1.400", known: false })).toBe("Claude Code 2.1.400은 확인되지 않은 CLI 버전입니다");
    // gemini 는 Codex 로 적히지 않는다(이름은 CLI_INFO 의 것).
    expect(describeCliVersion({ provider: "gemini", installed: false, version: null, known: false })).toBe("Antigravity CLI가 설치되어 있지 않습니다");
    expect(describeCliVersion({ provider: "gemini", installed: true, version: "1.5.14", known: true })).toBe("Antigravity CLI 1.5.14");
    expect(describeCliVersion({ provider: "gemini", installed: true, version: "1.6.0", known: false })).toBe("Antigravity CLI 1.6.0은 확인되지 않은 CLI 버전입니다");
    expect(describeCliVersion({ provider: "codex", installed: true, version: "0.166.0", known: true })).toBe("Codex 0.166.0");
  });
  test("처음 본 버전의 로그 한 줄도 CLI 이름을 표에서 읽는다", () => {
    const lines: string[] = [];
    const info = console.info, warn = console.warn;
    console.info = (line: string) => { lines.push(line); };
    console.warn = (line: string) => { lines.push(line); };
    try {
      logCliVersionChange({ provider: "gemini", version: "1.5.14", known: true, firstSeenAt: "2026-11-21T00:00:00.000Z" });
      logCliVersionChange({ provider: "gemini", version: "1.6.0", known: false, firstSeenAt: "2026-11-21T00:00:00.000Z" });
      logCliVersionChange({ provider: "codex", version: "0.166.0", known: true, firstSeenAt: "2026-11-21T00:00:00.000Z" });
    } finally { console.info = info; console.warn = warn; }
    expect(lines[0]).toStartWith("[cli] Antigravity CLI 1.5.14 처음 확인");
    expect(lines[1]).toStartWith("[cli] Antigravity CLI 1.6.0 처음 확인 — 확인되지 않은 CLI 버전입니다");
    expect(lines[2]).toStartWith("[cli] Codex 0.166.0 처음 확인");
  });
});

describe("readCliVersions (약속 5)", () => {
  test("설치된 CLI 의 버전과 확인 여부, 없는 CLI 는 installed=false", async () => {
    const bin = dir();
    const claude = fakeCli(bin, "claude", "2.1.322 (Claude Code)");
    const infos = await readCliVersions({ claudeBin: claude.path, codexBin: join(bin, "no-such-codex"), geminiBin: noAgy(bin) });
    expect(infos).toEqual([
      { provider: "claude", installed: true, version: "2.1.322", known: true },
      { provider: "codex", installed: false, version: null, known: false },
      GEMINI_MISSING,
    ]);
    expect(claude.calls()).toBe(1);
  });
  test("확인되지 않은 버전, 실패하는 CLI, 답이 늦은 CLI", async () => {
    const bin = dir();
    const codex = fakeCli(bin, "codex", "codex-cli 0.199.0");
    const failing = fakeCli(bin, "claude", "2.1.322 (Claude Code)", { exit: 1 });
    expect(await readCliVersions({ claudeBin: failing.path, codexBin: codex.path, geminiBin: noAgy(bin) })).toEqual([
      { provider: "claude", installed: true, version: null, known: false },
      { provider: "codex", installed: true, version: "0.199.0", known: false },
      GEMINI_MISSING,
    ]);
    const slow = fakeCli(dir(), "claude", "2.1.322 (Claude Code)", { sleep: 5 });
    const started = performance.now();
    const [claude] = await readCliVersions({ claudeBin: slow.path, codexBin: codex.path, geminiBin: noAgy(bin), timeoutMs: 200 });
    expect(claude).toEqual({ provider: "claude", installed: true, version: null, known: false });
    expect(performance.now() - started).toBeLessThan(3_000);
  });
  test("home 을 주면 처음 본 시각을 기록하고 붙인다", async () => {
    const bin = dir(), home = dir("iamceo-cli-home-");
    const claude = fakeCli(bin, "claude", "2.1.322 (Claude Code)"), codex = fakeCli(bin, "codex", "codex-cli 0.166.0");
    const first = await readCliVersions({ claudeBin: claude.path, codexBin: codex.path, geminiBin: noAgy(bin), home, now: () => new Date("2026-11-13T01:00:00.000Z") });
    // 설치되지 않은 CLI(gemini)는 기록하지 않는다.
    expect(first.map(i => i.firstSeenAt)).toEqual(["2026-11-13T01:00:00.000Z", "2026-11-13T01:00:00.000Z", undefined]);
    const later = await readCliVersions({ claudeBin: claude.path, codexBin: codex.path, geminiBin: noAgy(bin), home, now: () => new Date("2026-11-20T01:00:00.000Z") });
    expect(later.map(i => i.firstSeenAt)).toEqual(["2026-11-13T01:00:00.000Z", "2026-11-13T01:00:00.000Z", undefined]);
    expect(statSync(join(home, CLI_VERSION_LEDGER)).mode & 0o777).toBe(0o600);
    expect(readCliVersionLedger(home).seen.claude["2.1.322"]).toEqual({ firstSeenAt: "2026-11-13T01:00:00.000Z", lastSeenAt: "2026-11-20T01:00:00.000Z" });
    expect(readCliVersionLedger(home).seen.gemini).toEqual({});
  });
  test("Gemini: Antigravity CLI(agy)의 버전을 gemini 줄로 읽는다. 다른 CLI 의 실행 파일로 읽지 않는다", async () => {
    const bin = dir(), home = dir("iamceo-cli-home-");
    const claude = fakeCli(bin, "claude", "2.1.322 (Claude Code)"), codex = fakeCli(bin, "codex", "codex-cli 0.166.0"), agy = fakeCli(bin, "agy", "1.5.14");
    const infos = await readCliVersions({ claudeBin: claude.path, codexBin: codex.path, geminiBin: agy.path, home, now: () => new Date("2026-11-21T01:00:00.000Z") });
    expect(infos).toEqual([
      { provider: "claude", installed: true, version: "2.1.322", known: true, firstSeenAt: "2026-11-21T01:00:00.000Z" },
      { provider: "codex", installed: true, version: "0.166.0", known: true, firstSeenAt: "2026-11-21T01:00:00.000Z" },
      { provider: "gemini", installed: true, version: "1.5.14", known: true, firstSeenAt: "2026-11-21T01:00:00.000Z" },
    ]);
    // 실행 파일마다 한 번씩만 불렀다(gemini 버전을 읽으려고 codex 를 한 번 더 부르지 않는다).
    expect([claude.calls(), codex.calls(), agy.calls()]).toEqual([1, 1, 1]);
    expect(readCliVersionLedger(home).seen.gemini["1.5.14"]).toEqual({ firstSeenAt: "2026-11-21T01:00:00.000Z", lastSeenAt: "2026-11-21T01:00:00.000Z" });
    // 견본이 없는 새 버전은 확인되지 않은 버전이다.
    const newer = fakeCli(dir(), "agy", "1.6.0");
    expect((await readCliVersions({ claudeBin: claude.path, codexBin: codex.path, geminiBin: newer.path }))[2]).toEqual({ provider: "gemini", installed: true, version: "1.6.0", known: false });
  });
  test("Gemini: 깔려 있지 않으면 installed=false, 살펴보지 않기로 하면(null) 찾지도 실행하지도 않는다", async () => {
    const bin = dir();
    const claude = fakeCli(bin, "claude", "2.1.322 (Claude Code)"), codex = fakeCli(bin, "codex", "codex-cli 0.166.0");
    expect((await readCliVersions({ claudeBin: claude.path, codexBin: codex.path, geminiBin: noAgy(bin) }))[2]).toEqual(GEMINI_MISSING);
    expect((await readCliVersions({ claudeBin: claude.path, codexBin: codex.path, geminiBin: null }))[2]).toEqual(GEMINI_MISSING);
    const monitor = new CliVersionMonitor({ claudeBin: claude.path, codexBin: codex.path, geminiBin: null, onChange: () => undefined });
    expect((await monitor.refresh())[2]).toEqual(GEMINI_MISSING);
  });
  test("Gemini: 기본 명령 이름은 provider 값(gemini)이 아니라 agy 다. 제한 시간은 agy 에만 넉넉히 준다", () => {
    expect(CLI_INFO.gemini.program).toBe("agy");
    // 찾기만 한다(실행하지 않는다). agy 가 깔린 Mac 에서는 그 경로, 없으면 null 이다. 옛 Gemini CLI(`gemini`)를 가리키지 않는다.
    const found = resolveCliBinary("gemini");
    if (found !== null) expect(basename(found)).toBe("agy");
    const bin = dir(), agy = fakeCli(bin, "agy", "1.5.14");
    expect(resolveCliBinary("gemini", agy.path)).toBe(agy.path);
    expect(resolveCliBinary("gemini", noAgy(bin))).toBeNull();
    expect(agy.calls()).toBe(0);
    expect(CLI_VERSION_TIMEOUTS_MS).toEqual({ claude: CLI_VERSION_TIMEOUT_MS, codex: CLI_VERSION_TIMEOUT_MS, gemini: 8_000 });
    expect(CLI_VERSION_TIMEOUT_MS).toBe(3_000);
  });
  test("Gemini: 답이 늦은 agy 는 제한 시간에 끊고 버전을 모르는 것으로 둔다(다른 CLI 는 그대로 읽는다)", async () => {
    const bin = dir();
    const claude = fakeCli(bin, "claude", "2.1.322 (Claude Code)"), codex = fakeCli(bin, "codex", "codex-cli 0.166.0");
    const slow = fakeCli(dir(), "agy", "1.5.14", { sleep: 20 });
    const started = performance.now();
    // 빠른 두 CLI 는 바쁜 Mac 에서도 넉넉히 끝나고, 20초 자는 agy 만 제한 시간(2초)에 끊긴다.
    const infos = await readCliVersions({ claudeBin: claude.path, codexBin: codex.path, geminiBin: slow.path, timeoutMs: 2_000 });
    expect(infos.map(i => [i.provider, i.installed, i.version])).toEqual([["claude", true, "2.1.322"], ["codex", true, "0.166.0"], ["gemini", true, null]]);
    expect(performance.now() - started).toBeLessThan(10_000);
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
  test("gemini 칸이 없는 예전 기록 파일도 그대로 읽고, gemini 를 처음 보면 그 칸을 더한다", () => {
    const home = dir("iamceo-cli-home-");
    const seen = { firstSeenAt: "2026-11-01T00:00:00.000Z", lastSeenAt: "2026-11-02T00:00:00.000Z" };
    writeFileSync(join(home, CLI_VERSION_LEDGER), JSON.stringify({ version: 1, seen: { claude: { "2.1.322": seen }, codex: { "0.166.0": seen } } }));
    expect(readCliVersionLedger(home)).toEqual({ version: 1, seen: { claude: { "2.1.322": seen }, codex: { "0.166.0": seen }, gemini: {} } });
    const result = recordCliVersions(home, [{ provider: "gemini", installed: true, version: "1.5.14", known: true }], new Date("2026-11-21T00:00:00.000Z"));
    expect(result.changes).toEqual([{ provider: "gemini", version: "1.5.14", known: true, firstSeenAt: "2026-11-21T00:00:00.000Z" }]);
    const ledger = readCliVersionLedger(home);
    expect(ledger.seen.claude["2.1.322"]).toEqual(seen);
    expect(Object.keys(ledger.seen.gemini)).toEqual(["1.5.14"]);
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
    const monitor = new CliVersionMonitor({ home, claudeBin: claude.path, codexBin: codex.path, geminiBin: noAgy(bin), recheckMs: 1_000, clock: () => now,
      onChange: change => changes.push(change), onUpdate: infos => updates.push(infos) });
    expect(monitor.snapshot()).toBeUndefined();
    const first = await monitor.refresh();
    expect(first.map(i => [i.provider, i.version, i.known])).toEqual([["claude", "2.1.322", true], ["codex", "0.166.0", true], ["gemini", null, false]]);
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
    const monitor = new CliVersionMonitor({ claudeBin: claude.path, codexBin: codex.path, geminiBin: noAgy(bin), onChange: () => undefined });
    const [a, b] = await Promise.all([monitor.refresh(), monitor.refresh()]);
    expect(a).toBe(b);
    expect(claude.calls()).toBe(1);
    await monitor.refresh();
    expect(claude.calls()).toBe(2);
  });
  test("Gemini: agy 가 바뀌면(업데이트) 다시 읽어 처음 본 버전을 알리고, 그대로면 다시 부르지 않는다", async () => {
    const bin = dir(), home = dir("iamceo-cli-home-");
    const claude = fakeCli(bin, "claude", "2.1.322 (Claude Code)"), codex = fakeCli(bin, "codex", "codex-cli 0.166.0"), agy = fakeCli(bin, "agy", "1.5.14");
    let now = 0;
    const changes: CliVersionChange[] = [];
    const monitor = new CliVersionMonitor({ home, claudeBin: claude.path, codexBin: codex.path, geminiBin: agy.path, recheckMs: 1_000, clock: () => now, onChange: change => changes.push(change) });
    expect((await monitor.refresh())[2]).toMatchObject({ provider: "gemini", installed: true, version: "1.5.14", known: true });
    now = 2_000; await monitor.refresh();
    expect(agy.calls()).toBe(1);
    const updated = fakeCli(bin, "agy", "1.6.0");
    utimesSync(updated.path, new Date(), new Date(Date.now() + 5_000));
    now = 4_000;
    expect((await monitor.refresh())[2]).toMatchObject({ provider: "gemini", version: "1.6.0", known: false });
    expect(changes.map(c => `${c.provider} ${c.version} ${c.known}`)).toEqual(["claude 2.1.322 true", "codex 0.166.0 true", "gemini 1.5.14 true", "gemini 1.6.0 false"]);
  });
  test("Gemini: agy 의 버전만 못 읽으면 Claude·Codex 를 30초마다 다시 띄우지 않고 10분 뒤에 다시 읽는다", async () => {
    const bin = dir();
    const claude = fakeCli(bin, "claude", "2.1.322 (Claude Code)"), codex = fakeCli(bin, "codex", "codex-cli 0.166.0"), agy = fakeCli(bin, "agy", "1.5.14", { exit: 1 });
    let now = 0;
    const monitor = new CliVersionMonitor({ claudeBin: claude.path, codexBin: codex.path, geminiBin: agy.path, recheckMs: 1_000, clock: () => now, onChange: () => undefined });
    expect((await monitor.refresh())[2]).toMatchObject({ provider: "gemini", installed: true, version: null });
    expect([claude.calls(), codex.calls(), agy.calls()]).toEqual([1, 1, 1]);
    // 다음 확인들(30초 간격의 동기화)은 앞 값을 그대로 쓴다.
    now = 60_000; await monitor.refresh();
    now = GEMINI_VERSION_RETRY_MS - 1; await monitor.refresh();
    expect([claude.calls(), codex.calls(), agy.calls()]).toEqual([1, 1, 1]);
    // 10분이 지나면 한 번 다시 읽는다. 점검이 부르는 강제 읽기는 언제든 읽는다.
    now = GEMINI_VERSION_RETRY_MS; await monitor.refresh();
    expect(agy.calls()).toBe(2);
    await monitor.refresh(true);
    expect(agy.calls()).toBe(3);
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
