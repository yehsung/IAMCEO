// iamceo upgrade · rollback (D2). 임시 홈·가짜 launchctl·가짜 릴리스·가짜 준비 확인만 쓴다. 실제 launchd·앱·네트워크는 부르지 않는다.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { launchdPlist } from "../bin/iamceo.ts";
import { Bus } from "../server/bus.ts";
import { updateConfigFile } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { LifecycleError } from "../server/lifecycle/launchd.ts";
import type { ReleaseTools } from "../server/lifecycle/release.ts";
import type { RehearsalResult } from "../server/lifecycle/rehearse.ts";
import { listUpgradeRecords, latestRollbackTarget } from "../server/lifecycle/state.ts";
import { readinessBudget, rollback, upgrade, type CommandRunner, type LifecycleDeps } from "../server/lifecycle/upgrade.ts";
import { Store } from "../server/store.ts";

beforeAll(() => { process.env.IAMCEO_LANG = "ko"; });
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
