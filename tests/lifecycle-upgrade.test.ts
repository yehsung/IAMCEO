// iamceo upgrade · rollback (D2). 임시 홈·가짜 launchctl·가짜 릴리스·가짜 준비 확인만 쓴다. 실제 launchd·앱·네트워크는 부르지 않는다.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { launchdPlist } from "../bin/iamceo.ts";
import { Bus } from "../server/bus.ts";
import { updateConfigFile } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { LifecycleError } from "../server/lifecycle/launchd.ts";
import { releaseSource, type ReleaseTools } from "../server/lifecycle/release.ts";
import type { RehearsalResult } from "../server/lifecycle/rehearse.ts";
import { listUpgradeRecords, latestRollbackTarget } from "../server/lifecycle/state.ts";
import { readinessBudget, rollback, upgrade, type CommandRunner, type LifecycleDeps } from "../server/lifecycle/upgrade.ts";
import { Store } from "../server/store.ts";

// 이 파일의 단언은 한국어 문구를 본다. bun 은 여러 시험 파일을 한 프로세스에서 돌리므로 끝나면 원래 값으로 돌려 놓는다.
const savedLang = process.env.IAMCEO_LANG;
beforeAll(() => { process.env.IAMCEO_LANG = "ko"; });
afterAll(() => { if (savedLang === undefined) delete process.env.IAMCEO_LANG; else process.env.IAMCEO_LANG = savedLang; });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const buildIdFor = (version: string) => createHash("sha256").update(`build ${version}`).digest("hex");
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function makeApp(path: string, version: string): void {
  mkdirSync(join(path, "Contents", "Resources", "runtime"), { recursive: true });
  writeFileSync(join(path, "Contents", "Info.plist"), `${version}\n`);
  writeFileSync(join(path, "Contents", "Resources", "runtime", "iamceo"),
    `#!/bin/sh\ncase "$1" in\n  version) echo ${version} ;;\n  build-id) echo ${buildIdFor(version)} ;;\n  *) exit 2 ;;\nesac\n`, { mode: 0o755 });
}
const versionAt = (app: string) => readFileSync(join(app, "Contents", "Info.plist"), "utf8").trim();
const schemaOf = (path: string) => { const db = new Database(path, { readonly: true }); try { return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version; } finally { db.close(); } };
const bumpSchema = (path: string) => { const db = new Database(path); try { db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`); } finally { db.close(); } };

/** 가짜 launchd 와 그 위에서 도는 '서버': 올릴 때 그 자리에 놓인 판을 실행 중인 판으로 삼는다. */
function fakeService(running: () => string, options: { onStart?: (version: string) => void } = {}) {
  let loaded = true, current: string | null = running();
  const calls: string[] = [];
  const launchctl = (...args: string[]) => {
    calls.push(args[0]!);
    if (args[0] === "print") return { ok: loaded, output: loaded ? "state = running" : "Could not find service" };
    if (args[0] === "bootout") { loaded = false; current = null; return { ok: true, output: "" }; }
    if (args[0] === "bootstrap") { loaded = true; current = running(); options.onStart?.(current); return { ok: true, output: "" }; }
    return { ok: false, output: "unexpected" };
  };
  return { launchctl, calls, get loaded() { return loaded; }, get current() { return current; } };
}

function baseFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-upgrade-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const userHome = join(root, "user"), home = join(userHome, ".iamceo");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_TEST: "1" };
  updateConfigFile({ accessCode: "upgrade-fixture-code", hosts: ["127.0.0.1"] }, env);
  const db = openDb(join(home, "iamceo.db"));
  new Store(db, new Bus()).createProject({ name: "업그레이드 시험", cwd: root });
  db.close();
  const plistPath = join(userHome, "Library", "LaunchAgents", "com.iamceo.server.plist");
  mkdirSync(dirname(plistPath), { recursive: true });
  const writePlist = (program: string[]) => writeFileSync(plistPath, launchdPlist({ program, home: userHome, logDir: join(home, "logs"), workingDir: userHome, env: { IAMCEO_HOME: home } }));
  const logs: string[] = [];
  const rehearsals: { command: string[]; cwd?: string; source: string; timeoutMs?: number }[] = [];
  let rehearsalOk = true;
  const rehearse = async (input: { command: string[]; cwd?: string; source: string; timeoutMs?: number }): Promise<RehearsalResult> => {
    rehearsals.push(input);
    return rehearsalOk
      ? { ok: true, exitCode: 0, startupMs: 12, rows: [{ step: "startup (migrate, recover, listen)", ok: true, ms: 12, detail: "" }, { step: "shutdown", ok: true, ms: 1, detail: "" }] }
      : { ok: false, exitCode: 0, startupMs: null, rows: [{ step: "startup (migrate, recover, listen)", ok: false, ms: 3, detail: "Error: migration failed" }] };
  };
  return { root, userHome, home, env, plistPath, writePlist, logs, rehearsals, rehearse, failRehearsal() { rehearsalOk = false; } };
}

function releaseFixture() {
  const base = baseFixture();
  const apps = join(base.root, "Applications"), app = join(apps, "IAMCEO.app");
  makeApp(app, "0.2.3");
  const daemon = join(app, "Contents", "Resources", "runtime", "iamceo");
  base.writePlist([daemon, "serve"]);
  const failing = new Set<string>();
  let onStart: ((version: string) => void) | undefined;
  const service = fakeService(() => versionAt(app), { onStart: version => onStart?.(version) });
  const attached: string[] = [];
  let badSignature = false;
  const releases = new Map<string, string>();
  /** 릴리스 자산 폴더: SHA256SUMS 와 가짜 DMG. '붙이기'는 미리 만든 앱을 붙인 자리에 복사한다. */
  const release = (version: string, options: { wrongDigest?: boolean } = {}) => {
    const dir = join(base.root, `release-${version}`), dmgName = `IAMCEO-${version}-arm64.dmg`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, dmgName), `fake dmg ${version}`);
    writeFileSync(join(dir, "SHA256SUMS"), `${options.wrongDigest ? "0".repeat(64) : sha256(`fake dmg ${version}`)}  ${dmgName}\n`);
    const mounted = join(base.root, `mounted-${version}`);
    rmSync(mounted, { recursive: true, force: true });
    makeApp(join(mounted, "IAMCEO.app"), version);
    releases.set(dmgName, mounted);
    return dir;
  };
  const tools: ReleaseTools = {
    attach: (dmg, mountPoint) => { attached.push(dmg); cpSync(releases.get(basename(dmg))!, mountPoint, { recursive: true }); },
    detach: (mountPoint) => { rmSync(join(mountPoint, "IAMCEO.app"), { recursive: true, force: true }); },
    verify: () => { if (badSignature) throw new LifecycleError("받은 앱의 서명이 IAMCEO 배포자의 것이 아닙니다"); },
    appVersion: (path) => versionAt(path),
    copy: (source, target) => cpSync(source, target, { recursive: true }),
  };
  const readiness = async (_config: unknown, expected: { buildId: string | null; version: string }) => {
    const running = service.current;
    if (!running || failing.has(running)) throw new LifecycleError(`준비되지 않음(${running})`);
    if (expected.version !== running || (expected.buildId !== null && expected.buildId !== buildIdFor(running))) throw new LifecycleError(`다른 판(${running})`);
  };
  const deps = (extra: Partial<LifecycleDeps> = {}): LifecycleDeps => ({
    launchctl: service.launchctl, userHome: base.userHome, uid: 501, env: base.env, sleep: async () => {}, log: line => base.logs.push(line),
    readiness, rehearse: base.rehearse, releaseTools: tools, appRunning: () => false, brewCaskrooms: [], scratch: base.root, ...extra,
  });
  return { ...base, apps, app, daemon, service, failing, release, attached, tools, deps,
    onStart(handler: (version: string) => void) { onStart = handler; }, breakSignature() { badSignature = true; } };
}

describe("설치판 업그레이드", () => {
  test("받기·확인 → 미리 돌려 보기 → 기록 → 내림 → 교체 → 올림 → 준비 확인", async () => {
    const f = releaseFixture();
    const outcome = await upgrade({ from: f.release("0.2.4") }, f.deps());
    expect(outcome).toMatchObject({ status: "upgraded", mode: "release", from: "0.2.3", to: "0.2.4" });
    expect(versionAt(f.app)).toBe("0.2.4");
    expect(f.service.current).toBe("0.2.4");
    // 바꾸기 전에 예행하고, 내린 뒤에 올렸다.
    expect(f.rehearsals).toHaveLength(1);
    expect(f.rehearsals[0]!.command[0]).toMatch(/\.iamceo-upgrade-u-.*\/IAMCEO\.app\/Contents\/Resources\/runtime\/iamceo$/);
    expect(f.rehearsals[0]!.source).toBe(join(f.home, "iamceo.db"));
    expect(f.service.calls.indexOf("bootout")).toBeLessThan(f.service.calls.indexOf("bootstrap"));
    const [record] = listUpgradeRecords(f.home);
    expect(record).toMatchObject({ mode: "release", phase: "done", installedApp: f.app,
      from: { version: "0.2.3", buildId: buildIdFor("0.2.3"), schemaVersion: MIGRATIONS.length }, to: { version: "0.2.4", buildId: buildIdFor("0.2.4") } });
    // 직전 판의 앱·plist·DB 사본을 남긴다.
    expect(versionAt(record!.previousApp!)).toBe("0.2.3");
    expect(readFileSync(record!.plist, "utf8")).toBe(readFileSync(f.plistPath, "utf8"));
    expect(schemaOf(record!.database!)).toBe(MIGRATIONS.length);
    // 설치 폴더에는 임시 자리가 남지 않는다.
    expect(readdirSync(f.apps)).toEqual(["IAMCEO.app"]);
    expect(f.logs.join("\n")).toContain("업그레이드했습니다: 0.2.3 → 0.2.4");
  });

  test("미리 돌려 보기가 실패하면 서비스·앱·기록을 하나도 바꾸지 않는다", async () => {
    const f = releaseFixture();
    f.failRehearsal();
    await expect(upgrade({ from: f.release("0.2.4") }, f.deps())).rejects.toThrow("미리 돌려 보기가 실패해 아무것도 바꾸지 않았습니다");
    expect(versionAt(f.app)).toBe("0.2.3");
    expect(f.service.calls).not.toContain("bootout");
    expect(listUpgradeRecords(f.home)).toEqual([]);
    expect(readdirSync(f.apps)).toEqual(["IAMCEO.app"]);
  });

  test("새 판이 준비되지 않으면 스스로 되돌린다. 스키마가 올라갔으면 DB 도 사본으로 되돌리고 지금 DB 는 옆에 둔다", async () => {
    const f = releaseFixture();
    f.failing.add("0.2.4");
    f.onStart(version => { if (version === "0.2.4") bumpSchema(join(f.home, "iamceo.db")); });
    await expect(upgrade({ from: f.release("0.2.4") }, f.deps())).rejects.toThrow("직전 판 0.2.3 으로 되돌렸습니다(DB 도 업그레이드 전 사본으로 되돌렸습니다)");
    expect(versionAt(f.app)).toBe("0.2.3");
    expect(f.service.current).toBe("0.2.3");
    expect(schemaOf(join(f.home, "iamceo.db"))).toBe(MIGRATIONS.length);
    const [record] = listUpgradeRecords(f.home);
    expect(record!.phase).toBe("rolled_back");
    const dir = dirname(record!.plist);
    const aside = readdirSync(dir).find(name => name.startsWith("after-upgrade-"))!;
    expect(schemaOf(join(dir, aside, "iamceo.db"))).toBe(MIGRATIONS.length + 1);
    expect(readdirSync(dir).some(name => /^rolled-back-.*\.app$/.test(name))).toBe(true);
    expect(latestRollbackTarget(f.home)).toBeNull();
  });

  test("rollback: 스키마가 올라갔으면 --yes 를 받고서야 DB 까지 되돌린다. 두 번은 되돌리지 않는다", async () => {
    const f = releaseFixture();
    f.onStart(version => { if (version === "0.2.4") bumpSchema(join(f.home, "iamceo.db")); });
    await upgrade({ from: f.release("0.2.4") }, f.deps());
    expect(schemaOf(join(f.home, "iamceo.db"))).toBe(MIGRATIONS.length + 1);
    const preview = await rollback({ dryRun: true }, f.deps());
    expect(preview).toMatchObject({ status: "dry_run", from: "0.2.4", to: "0.2.3", databaseRestored: true });
    await expect(rollback({}, f.deps())).rejects.toThrow("--yes");
    expect(versionAt(f.app)).toBe("0.2.4");
    const done = await rollback({ yes: true }, f.deps());
    expect(done).toMatchObject({ status: "rolled_back", from: "0.2.4", to: "0.2.3", databaseRestored: true });
    expect(versionAt(f.app)).toBe("0.2.3");
    expect(f.service.current).toBe("0.2.3");
    expect(schemaOf(join(f.home, "iamceo.db"))).toBe(MIGRATIONS.length);
    expect(listUpgradeRecords(f.home)[0]!.phase).toBe("rolled_back");
    await expect(rollback({ yes: true }, f.deps())).rejects.toThrow("되돌릴 업그레이드 기록이 없습니다");
  });

  // 리뷰 safety-2: 되돌리기로 옆에 빼 둔 '업그레이드 뒤 대화' DB 는 오래된 기록을 정리할 때도 지우지 않는다.
  test("rollback 이 옆에 빼 둔 DB 는 그 뒤 업그레이드를 두 번 더 해도 남는다(큰 사본만 정리한다)", async () => {
    const f = releaseFixture();
    let tick = 0;
    const now = () => new Date(Date.parse("2026-11-13T00:00:00Z") + (tick++) * 60_000);
    f.onStart(version => { if (version === "0.2.4") bumpSchema(join(f.home, "iamceo.db")); });
    await upgrade({ from: f.release("0.2.4") }, f.deps({ now }));
    await rollback({ yes: true }, f.deps({ now }));
    const first = listUpgradeRecords(f.home)[0]!;
    const dir = dirname(first.plist);
    const aside = readdirSync(dir).find(name => name.startsWith("after-upgrade-"))!;
    expect(f.logs.join("\n")).toContain(join(dir, aside));
    await upgrade({ from: f.release("0.2.4") }, f.deps({ now }));
    await upgrade({ from: f.release("0.2.5") }, f.deps({ now }));
    expect(versionAt(f.app)).toBe("0.2.5");
    const records = listUpgradeRecords(f.home);
    expect(records.map(record => record.phase)).toEqual(["done", "done", "rolled_back"]);
    // 첫 기록 폴더는 옆 사본과 기록만 남기고(업그레이드 뒤에 쌓인 그때의 DB), 앱·업그레이드 전 DB 사본은 지웠다.
    expect(readdirSync(dir).sort()).toEqual([aside, "upgrade.json"]);
    expect(schemaOf(join(dir, aside, "iamceo.db"))).toBe(MIGRATIONS.length + 1);
  });

  // 리뷰 safety-3: 기록 뒤에 다른 방법(DMG 등)으로 판을 바꿨으면 그 기록으로 되돌리지 않는다(여러 판 뒤 + 오래된 DB 사본).
  test("rollback 은 지금 도는 판이 그 기록이 올린 판일 때만 한다", async () => {
    const f = releaseFixture();
    await upgrade({ from: f.release("0.2.4") }, f.deps());
    makeApp(f.app, "0.2.5"); // 업그레이드 뒤 DMG 로 0.2.5 를 덮어 깔았다
    const calls = f.service.calls.length;
    await expect(rollback({ dryRun: true }, f.deps())).rejects.toThrow("다른 방법으로 판이 바뀌었습니다");
    await expect(rollback({ yes: true }, f.deps())).rejects.toThrow("지금 판: 0.2.5");
    expect(versionAt(f.app)).toBe("0.2.5");
    expect(f.service.calls.slice(calls)).not.toContain("bootout");
    expect(listUpgradeRecords(f.home)[0]!.phase).toBe("done");
    // 그 판으로 돌아오면 다시 되돌릴 수 있고, 안내에는 지금 판과 기록 시각이 보인다.
    makeApp(f.app, "0.2.4");
    expect(await rollback({ yes: true }, f.deps())).toMatchObject({ status: "rolled_back", to: "0.2.3" });
    expect(f.logs.join("\n")).toMatch(/직전 판으로 되돌립니다: 지금 0\.2\.4 → 0\.2\.3 \(업그레이드 기록 \d{4}-\d\d-\d\d /);
  });

  // 리뷰 safety-4: 코드를 먼저 되돌리고 DB 를 바꾼다. 도중에 실패하면 바꾼 것을 모두 원래대로 돌리고 다시 되돌릴 수 있게 둔다.
  test("직전 판이 준비되지 않으면 앱·DB 를 원래대로 돌리고 서비스를 다시 올린다. 기록은 그대로라 다시 되돌릴 수 있다", async () => {
    const f = releaseFixture();
    f.onStart(version => { if (version === "0.2.4") bumpSchema(join(f.home, "iamceo.db")); });
    await upgrade({ from: f.release("0.2.4") }, f.deps());
    f.failing.add("0.2.3");
    await expect(rollback({ yes: true }, f.deps())).rejects.toThrow("바꾼 것을 모두 원래대로 돌렸습니다(서비스도 다시 올렸습니다)");
    expect(versionAt(f.app)).toBe("0.2.4");
    expect(f.service.current).toBe("0.2.4");
    expect(schemaOf(join(f.home, "iamceo.db"))).toBe(MIGRATIONS.length + 1);
    const record = listUpgradeRecords(f.home)[0]!;
    expect(record.phase).toBe("done");
    const dir = dirname(record.plist);
    // 되돌린 판이 잠깐 쓴 DB 도 지우지 않고 옆에 둔다.
    expect(readdirSync(dir).some(name => name.startsWith("rollback-attempt-"))).toBe(true);
    expect(readdirSync(dir).some(name => name.startsWith("after-upgrade-"))).toBe(false);
    expect(versionAt(record.previousApp!)).toBe("0.2.3");
    f.failing.delete("0.2.3");
    expect(await rollback({ yes: true }, f.deps())).toMatchObject({ status: "rolled_back", databaseRestored: true });
    expect(versionAt(f.app)).toBe("0.2.3");
    expect(schemaOf(join(f.home, "iamceo.db"))).toBe(MIGRATIONS.length);
  });

  test("같은 판이면 바꾸지 않고, 낮은 판은 rollback 으로 안내한다", async () => {
    const f = releaseFixture();
    expect(await upgrade({ from: f.release("0.2.3") }, f.deps())).toMatchObject({ status: "current" });
    await expect(upgrade({ from: f.release("0.2.2") }, f.deps())).rejects.toThrow("iamceo rollback");
    expect(versionAt(f.app)).toBe("0.2.3");
    expect(f.service.calls).not.toContain("bootout");
    expect(listUpgradeRecords(f.home)).toEqual([]);
    expect(readdirSync(f.apps)).toEqual(["IAMCEO.app"]);
  });

  test("체크섬이 다르거나 서명이 맞지 않으면 아무것도 바꾸지 않는다", async () => {
    const f = releaseFixture();
    await expect(upgrade({ from: f.release("0.2.4", { wrongDigest: true }) }, f.deps())).rejects.toThrow("SHA-256");
    expect(f.attached).toEqual([]);
    f.breakSignature();
    await expect(upgrade({ from: f.release("0.2.4") }, f.deps())).rejects.toThrow("서명");
    expect(versionAt(f.app)).toBe("0.2.3");
    expect(f.service.calls).not.toContain("bootout");
    expect(readdirSync(f.apps)).toEqual(["IAMCEO.app"]);
    expect(existsSync(join(f.home, "upgrades")) ? readdirSync(join(f.home, "upgrades")) : []).toEqual([]);
  });

  test("안전장치: 시험 환경의 실제 launchd, 다른 데이터 폴더의 서비스, Homebrew 설치, 실행 중인 앱", async () => {
    const f = releaseFixture();
    const from = f.release("0.2.4");
    await expect(upgrade({ from }, { ...f.deps(), launchctl: undefined })).rejects.toThrow("IAMCEO_TEST=1");
    await expect(upgrade({ from }, f.deps({ env: { ...f.env, IAMCEO_HOME: join(f.root, "other") } }))).rejects.toThrow("다른 데이터 폴더");
    await expect(upgrade({ from }, f.deps({ brewCaskrooms: [f.root] }))).rejects.toThrow("brew upgrade --cask iamceo");
    await expect(upgrade({ from }, f.deps({ appRunning: () => true }))).rejects.toThrow("앱을 종료한 뒤");
    await expect(upgrade({ target: "abc123" }, f.deps())).rejects.toThrow("--version");
    expect(versionAt(f.app)).toBe("0.2.3");
    expect(f.service.calls).not.toContain("bootout");
  });

  // 리뷰 docs-11: 문서는 --from 이 '폴더 경로'를 받는다고 쓴다. 상대 경로가 'https 여야 합니다'로 거절됐다.
  test("--from 의 상대 폴더 경로는 지금 폴더 기준 절대 경로로 받는다(주소는 그대로)", async () => {
    expect(releaseSource({ from: "rel/dir/" }).base).toBe(resolve("rel/dir"));
    expect(releaseSource({ from: "/abs/dir" }).base).toBe("/abs/dir");
    expect(releaseSource({ from: "https://example.invalid/r/" }).base).toBe("https://example.invalid/r");
    expect(releaseSource({ from: "file:///abs/dir" }).base).toBe("file:///abs/dir");
    expect(releaseSource({ env: { IAMCEO_DOWNLOAD_URL: "rel" } }).base).toBe(resolve("rel"));
    const f = releaseFixture();
    const outcome = await upgrade({ from: relative(process.cwd(), f.release("0.2.4")) }, f.deps());
    expect(outcome).toMatchObject({ status: "upgraded", to: "0.2.4" });
  });

  test("준비 대기 시간은 예행의 기동 시간에 맞춰 늘어난다(큰 DB 의 첫 이주를 '안 뜸'으로 오인하지 않게)", () => {
    expect(readinessBudget(120_000, null)).toBe(120_000);
    expect(readinessBudget(120_000, 12)).toBe(120_000);
    expect(readinessBudget(120_000, 60_000)).toBe(210_000);
  });

  test("--dry-run 은 계획만 보여 주고 받지도 바꾸지도 않는다(시험 환경에서도 된다)", async () => {
    const f = releaseFixture();
    const outcome = await upgrade({ from: f.release("0.2.4"), dryRun: true }, { ...f.deps(), launchctl: undefined });
    expect(outcome).toMatchObject({ status: "dry_run", from: "0.2.3" });
    expect(f.logs.join("\n")).toContain("미리 돌려 보기");
    expect(f.attached).toEqual([]);
    expect(versionAt(f.app)).toBe("0.2.3");
  });
});

describe("git 체크아웃 업그레이드", () => {
  function gitFixture() {
    const base = baseFixture();
    const checkout = join(base.root, "live");
    mkdirSync(join(checkout, "bin"), { recursive: true });
    const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
    const sh = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", checkout, ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    sh("init", "-q", "-b", "main");
    const commit = (version: string) => {
      writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "iamceo", version }) + "\n");
      writeFileSync(join(checkout, "bin", "iamceo.ts"), `// ${version}\n`);
      sh("add", "-A"); sh("commit", "-q", "-m", version);
      return sh("rev-parse", "HEAD");
    };
    const c1 = commit("0.2.3");
    sh("switch", "-q", "-c", "next");
    const c2 = commit("0.2.4");
    sh("switch", "-q", "main");
    const bun = join(base.root, "bun"), entry = join(checkout, "bin", "iamceo.ts");
    base.writePlist([bun, entry, "serve"]);
    const versionNow = () => JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).version as string;
    const installs: string[] = [];
    // git 은 진짜로 돌리고, bun 쪽(설치·build ID)만 흉내 낸다.
    const run: CommandRunner = (command, options = {}) => {
      if (command[0] === "git") {
        const result = Bun.spawnSync(command, { cwd: options.cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
        return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
      }
      if (command[0] === bun && command[1] === "install") { installs.push(versionNow()); return { code: 0, stdout: "", stderr: "" }; }
      if (command[0] === bun && command[1] === entry && command[2] === "build-id") return { code: 0, stdout: `${buildIdFor(versionNow())}\n`, stderr: "" };
      return { code: 2, stdout: "", stderr: "unexpected command" };
    };
    const service = fakeService(versionNow);
    const readiness = async (_config: unknown, expected: { buildId: string | null; version: string }) => {
      if (expected.version !== service.current || (expected.buildId !== null && expected.buildId !== buildIdFor(service.current!))) throw new LifecycleError(`다른 판(${service.current})`);
    };
    const deps = (extra: Partial<LifecycleDeps> = {}): LifecycleDeps => ({
      launchctl: service.launchctl, userHome: base.userHome, uid: 501, env: base.env, sleep: async () => {}, log: line => base.logs.push(line),
      readiness, rehearse: base.rehearse, run, appRunning: () => false, brewCaskrooms: [], scratch: base.root, ...extra,
    });
    return { ...base, checkout, sh, c1, c2, bun, entry, service, installs, deps };
  }

  test("커밋으로 옮기고(reset --keep) 새 코드로 DB 사본을 돌려 본 뒤 올린다. rollback 은 직전 커밋으로", async () => {
    const f = gitFixture();
    const outcome = await upgrade({ target: "next" }, f.deps());
    expect(outcome).toMatchObject({ status: "upgraded", mode: "git", from: f.c1, to: f.c2 });
    expect(f.sh("rev-parse", "HEAD")).toBe(f.c2);
    expect(f.sh("branch", "--show-current")).toBe("main");
    expect(f.service.current).toBe("0.2.4");
    expect(f.installs).toEqual(["0.2.4"]);
    const [record] = listUpgradeRecords(f.home);
    expect(record).toMatchObject({ mode: "git", phase: "done", checkout: f.checkout, from: { rev: f.c1, version: "0.2.3", buildId: buildIdFor("0.2.3") }, to: { rev: f.c2, version: "0.2.4", buildId: buildIdFor("0.2.4") } });
    // 예행은 새 코드로, 서버를 내린 뒤 만든 DB 사본에 한다.
    expect(f.rehearsals).toEqual([{ command: [f.bun, f.entry], cwd: f.checkout, source: record!.database!, timeoutMs: 600_000 }]);
    const back = await rollback({}, f.deps());
    expect(back).toMatchObject({ status: "rolled_back", mode: "git", databaseRestored: false });
    expect(f.sh("rev-parse", "HEAD")).toBe(f.c1);
    expect(f.service.current).toBe("0.2.3");
  });

  test("앞으로 가지 않는 커밋, 커밋하지 않은 변경, 같은 커밋은 바꾸지 않는다", async () => {
    const f = gitFixture();
    expect(await upgrade({ target: "main" }, f.deps())).toMatchObject({ status: "current" });
    writeFileSync(join(f.checkout, "bin", "iamceo.ts"), "// local edit\n");
    await expect(upgrade({ target: "next" }, f.deps())).rejects.toThrow("커밋하지 않은 변경");
    f.sh("checkout", "--", "bin/iamceo.ts");
    await upgrade({ target: "next" }, f.deps());
    await expect(upgrade({ target: f.c1 }, f.deps())).rejects.toThrow("앞으로 가는 커밋이 아닙니다");
    await expect(upgrade({ version: "0.2.5" }, f.deps())).rejects.toThrow("커밋으로 올립니다");
    expect(f.sh("rev-parse", "HEAD")).toBe(f.c2);
  });

  test("rollback: 커밋하지 않은 변경이 있으면 서비스를 내리기 전에 멈추고, 기록 뒤에 커밋을 옮겼으면 되돌리지 않는다", async () => {
    const f = gitFixture();
    await upgrade({ target: "next" }, f.deps());
    writeFileSync(join(f.checkout, "bin", "iamceo.ts"), "// local edit\n");
    const calls = f.service.calls.length;
    await expect(rollback({}, f.deps())).rejects.toThrow("커밋하지 않은 변경이 있어 되돌리지 않았습니다");
    expect(f.service.calls.slice(calls)).not.toContain("bootout");
    expect(f.service.current).toBe("0.2.4");
    expect(listUpgradeRecords(f.home)[0]!.phase).toBe("done");
    f.sh("checkout", "--", "bin/iamceo.ts");
    // 기록 뒤에 직접 다른 커밋으로 옮겼다.
    writeFileSync(join(f.checkout, "package.json"), JSON.stringify({ name: "iamceo", version: "0.2.5" }) + "\n");
    f.sh("commit", "-q", "-am", "0.2.5");
    await expect(rollback({}, f.deps())).rejects.toThrow("다른 방법으로 판이 바뀌었습니다");
    expect(f.sh("rev-parse", "HEAD")).not.toBe(f.c1);
    f.sh("reset", "-q", "--hard", f.c2);
    expect(await rollback({}, f.deps())).toMatchObject({ status: "rolled_back", mode: "git" });
    expect(f.sh("rev-parse", "HEAD")).toBe(f.c1);
  });

  test("새 코드의 예행이 실패하면 직전 커밋으로 되돌려 다시 올린다", async () => {
    const f = gitFixture();
    f.failRehearsal();
    await expect(upgrade({ target: "next" }, f.deps())).rejects.toThrow("직전 판 0.2.3 으로 되돌렸습니다");
    expect(f.sh("rev-parse", "HEAD")).toBe(f.c1);
    expect(f.service.loaded).toBe(true);
    expect(f.service.current).toBe("0.2.3");
    expect(listUpgradeRecords(f.home)[0]!.phase).toBe("rolled_back");
  });
});
