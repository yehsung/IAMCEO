// H(E8·D4·D3): 릴리스 도구와 iPhone 시험 단계.
// - release-mac.ts: 공증된 DMG 안의 데몬을 실제로 띄워 확인하는 단계(smokeDaemon), .bun-version 대조, Homebrew tap 을 git push 로 갱신.
// - scripts/check.sh ios: 이 Mac 의 iPhone 시뮬레이터를 고르고, 띄운 것만 끄고, 실패한 시험만 다시 돌린다.
// - CI: PR 트리거, 앱 빌드 작업, .bun-version.
// 실제 공증·업로드·push·시뮬레이터는 쓰지 않는다. tap 은 임시 폴더의 bare 저장소, 시뮬레이터·xcodebuild 는 가짜 실행 파일이다.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import {
  checkRenderedCask, isNoreplyEmail, parseBunVersion, parseReleaseOptions, renderCask, smokeDaemon, tapAuthor, updateTap,
} from "../scripts/release-mac.ts";

const root = resolve(import.meta.dir, "..");
const text = (path: string) => readFileSync(join(root, path), "utf8");
const template = text("packaging/homebrew/Casks/iamceo.rb");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => { Bun.spawnSync(["/bin/chmod", "-R", "u+rwx", dir]); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const NOREPLY = "1+fixture@users.noreply.github.com";

// ---- cask, Bun 버전, tap 작성자 ----

test("cask: 릴리스 틀의 머리 주석(틀이니 올리지 말라)은 tap 에 가는 cask 에 남지 않는다", () => {
  const cask = renderCask(template, "0.3.1", "a".repeat(64));
  expect(template.startsWith("# Release template")).toBe(true);
  expect(cask.startsWith('cask "iamceo" do')).toBe(true);
  expect(cask).not.toContain("Do not publish this template");
  expect(checkRenderedCask(cask, "0.3.1")).toBe("a".repeat(64));
  for (const bad of [template, cask.replace('version "0.3.1"', 'version "0.3.0"'), cask.replace('cask "iamceo" do', 'cask "other" do')]) {
    expect(() => checkRenderedCask(bad, "0.3.1")).toThrow();
  }
});

test(".bun-version: 한 줄의 X.Y.Z 이고, 워크플로는 그 파일에서 Bun 을 고르며 숫자를 따로 적지 않는다", () => {
  const pinned = parseBunVersion(text(".bun-version"));
  expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  for (const bad of ["", "1.3", "latest", "1.3.14\n1.3.15"]) expect(() => parseBunVersion(bad)).toThrow();
  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    const yml = text(workflow);
    // 어느 setup-bun 도 숫자를 직접 적지 않는다: 바꿀 곳은 .bun-version 하나다.
    expect(yml, workflow).not.toMatch(/bun-version:\s*\d/);
    const setups = yml.match(/oven-sh\/setup-bun@v\d+\n\s+with:\n\s+bun-version-file: \.bun-version/g) ?? [];
    expect(setups.length, workflow).toBe((yml.match(/oven-sh\/setup-bun@/g) ?? []).length);
  }
  // CLI 자산을 만드는 스크립트와 DMG 를 만드는 스크립트가 같은 파일을 본다.
  expect(text("scripts/build-release.ts")).toContain('".bun-version"');
  expect(text("scripts/release-mac.ts")).toContain(":.bun-version`");
});

test("tap 작성자: GitHub noreply 주소만 받는다. 환경 변수가 먼저, 없으면 릴리스 커밋의 작성자", () => {
  for (const ok of [NOREPLY, "fixture@users.noreply.github.com", "170092699+some-login@users.noreply.github.com"]) expect(isNoreplyEmail(ok)).toBe(true);
  for (const bad of ["fixture@gmail.com", "1+fixture@users.noreply.github.com.evil.example", "users.noreply.github.com", "a b@users.noreply.github.com", ""]) {
    expect(isNoreplyEmail(bad)).toBe(false);
  }
  expect(tapAuthor({}, `Fixture\0${NOREPLY}\n`)).toEqual({ name: "Fixture", email: NOREPLY });
  expect(tapAuthor({ TAP_GIT_NAME: "Bot", TAP_GIT_EMAIL: "2+bot@users.noreply.github.com" }, `Fixture\0${NOREPLY}`)).toEqual({ name: "Bot", email: "2+bot@users.noreply.github.com" });
  // 커밋 작성자가 실제 메일이면 거절한다. 환경 변수로 실제 메일을 줘도 거절한다.
  expect(() => tapAuthor({}, "Fixture\0someone@school.example")).toThrow(/noreply/);
  expect(() => tapAuthor({ TAP_GIT_EMAIL: "someone@school.example" }, `Fixture\0${NOREPLY}`)).toThrow(/noreply/);
  expect(() => tapAuthor({}, `\0${NOREPLY}`)).toThrow(/TAP_GIT_NAME/);
});

// ---- tap 갱신: 임시 bare 저장소에 실제 git 으로 ----

function gitEnv(home: string): Record<string, string> {
  // 이 Mac 의 전역 git 설정(서명, 훅, 메일)이 시험에 섞이지 않게 한다.
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LANG: "C" };
}
function git(env: Record<string, string>, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
function tapFixture() {
  const dir = temp("iamceo-tap-test-");
  const env = gitEnv(join(dir, "home"));
  mkdirSync(join(dir, "home"));
  const remote = join(dir, "homebrew-tap.git"), seed = join(dir, "seed");
  git(env, ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  git(env, ["init", "--quiet", "--initial-branch=main", seed]);
  mkdirSync(join(seed, "Casks"));
  writeFileSync(join(seed, "Casks", "iamceo.rb"), renderCask(template, "0.2.2", "b".repeat(64)));
  writeFileSync(join(seed, "README.md"), "tap\n");
  const seedEnv = { ...env, GIT_AUTHOR_NAME: "Seed", GIT_AUTHOR_EMAIL: NOREPLY, GIT_COMMITTER_NAME: "Seed", GIT_COMMITTER_EMAIL: NOREPLY };
  git(seedEnv, ["-C", seed, "add", "."]);
  git(seedEnv, ["-C", seed, "commit", "--quiet", "-m", "seed"]);
  git(seedEnv, ["-C", seed, "push", "--quiet", remote, "main"]);
  return { dir, env, remote };
}

test("tap: 클론해 Casks/iamceo.rb 만 바꾸고 noreply 작성자·커미터로 커밋해 git push 한다. 같은 cask 는 다시 올리지 않는다", () => {
  const f = tapFixture();
  const cask = renderCask(template, pkg.version, "c".repeat(64));
  const work = temp("iamceo-tap-work-");
  expect(updateTap({ cask, version: pkg.version, remote: f.remote, author: { name: "Fixture", email: NOREPLY }, work, env: f.env })).toBe("updated");
  expect(git(f.env, ["--git-dir", f.remote, "log", "-1", "--format=%an|%ae|%cn|%ce|%s", "main"])).toBe(`Fixture|${NOREPLY}|Fixture|${NOREPLY}|iamceo ${pkg.version}`);
  expect(git(f.env, ["--git-dir", f.remote, "show", "main:Casks/iamceo.rb"])).toBe(cask.trim());
  expect(git(f.env, ["--git-dir", f.remote, "diff", "--name-only", "main~1", "main"])).toBe("Casks/iamceo.rb");
  // 이미 올라간 cask 를 다시 주면 커밋도 push 도 없다.
  expect(updateTap({ cask, version: pkg.version, remote: f.remote, author: { name: "Fixture", email: NOREPLY }, work: temp("iamceo-tap-work-"), env: f.env })).toBe("unchanged");
  expect(git(f.env, ["--git-dir", f.remote, "rev-list", "--count", "main"])).toBe("2");
});

test("tap: 실제 메일 작성자, 렌더하지 않은 틀, 다른 버전의 cask 는 커밋 전에 거절하고 tap 은 그대로다", () => {
  const f = tapFixture();
  const before = git(f.env, ["--git-dir", f.remote, "rev-parse", "main"]);
  const cask = renderCask(template, pkg.version, "c".repeat(64));
  const attempts: [string, () => unknown][] = [
    ["noreply", () => updateTap({ cask, version: pkg.version, remote: f.remote, author: { name: "Fixture", email: "someone@school.example" }, work: temp("iamceo-tap-work-"), env: f.env })],
    ["rendered", () => updateTap({ cask: template, version: pkg.version, remote: f.remote, author: { name: "Fixture", email: NOREPLY }, work: temp("iamceo-tap-work-"), env: f.env })],
    ["rendered", () => updateTap({ cask, version: "9.9.9", remote: f.remote, author: { name: "Fixture", email: NOREPLY }, work: temp("iamceo-tap-work-"), env: f.env })],
  ];
  for (const [reason, attempt] of attempts) expect(attempt).toThrow(new RegExp(reason));
  expect(git(f.env, ["--git-dir", f.remote, "rev-parse", "main"])).toBe(before);
});

test("tap: GitHub contents API 를 쓰지 않는다(계정 메일이 작성자로 찍힌다). 저장소 파일에 메일 주소를 두지 않는다", () => {
  const source = text("scripts/release-mac.ts");
  expect(source).not.toMatch(/\/contents\//);
  expect(source).not.toMatch(/["']-X["'],\s*["']PUT["']/);
  expect(source).toContain('"push", "--quiet", "origin"');
  // 주소는 환경 변수나 릴리스 커밋에서 온다. 이 파일과 문서에는 적지 않는다(w1-tooling-version 의 검사와 같은 규칙).
  for (const path of ["scripts/release-mac.ts", "docs/releasing.md", ".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    expect(text(path), path).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  }
});

// ---- release-mac.ts dry-run ----

function releaseFixture(email = NOREPLY) {
  const dir = temp("iamceo-release-test-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o700); };
  script("git", `printf 'git %s\\n' "$*" >> "$FIXTURE/calls.log"
case "$1" in
  rev-parse) printf '%040d\\n' 1 ;;
  show) case "$*" in
    *:.bun-version*) printf '%s\\n' ${Bun.version} ;;
    *--format*) printf '%s\\000%s\\n' Fixture '${email}' ;;
    *) printf '{"version":"${pkg.version}"}\\n' ;;
  esac ;;
  *) echo forbidden >&2; exit 91 ;;
esac`);
  for (const tool of ["codesign", "xcrun", "gh", "hdiutil", "xcodebuild", "tar", "ditto", "spctl", "bash"]) script(tool, `echo "${tool} must not execute" >&2; exit 91`);
  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = Bun.spawnSync([process.execPath, join(root, "scripts/release-mac.ts"), ...args], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, FIXTURE: dir, ...env }, stdout: "pipe", stderr: "pipe",
    });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  const calls = () => existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : [];
  return { run, calls };
}

test("release dry-run: 공증한 DMG 를 마운트해 안의 데몬을 띄워 보는 단계가 체크섬·올리기 전에 있고, 공개 뒤에 tap 을 git 으로 올린다", () => {
  const f = releaseFixture();
  const result = f.run(["--dry-run", "--upload", "--publish"]);
  expect(result.code, result.output).toBe(0);
  const at = (needle: string) => {
    const index = result.output.indexOf(needle);
    expect(index, needle).toBeGreaterThanOrEqual(0);
    return index;
  };
  expect(result.output).toContain(`Require Bun ${Bun.version} for every compile`);
  // DMG 공증·스테이플 → 마운트 → 데몬 기동 확인 → 떼기 → 체크섬 → 올리기 → 공개 → tap.
  at("'stapler' 'validate'");
  // 앱 다음에 DMG 를 스테이플한다: 마지막 validate 가 DMG 의 것이다.
  const dmgStapled = result.output.lastIndexOf("'stapler' 'validate'");
  const attach = at("'hdiutil' 'attach' '-nobrowse' '-readonly'"), serve = at("as launchd does (IAMCEO_LOG_WRITER=1)");
  const detach = at("'hdiutil' 'detach'"), sums = at("checksum is taken AFTER stapling"), upload = at("'gh' 'release' 'upload'");
  const publish = at("'--draft=false'"), clone = at("'git' 'clone' '--quiet' '--depth' '1' '--' 'https://github.com/yehsung/homebrew-tap.git'");
  const push = at("'push' '--quiet' 'origin'");
  const order = [dmgStapled, attach, serve, detach, sums, upload, publish, clone, push];
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(result.output).toContain("/IAMCEO.app/Contents/Resources/runtime/iamceo");
  expect(result.output).toContain("Fixture <GitHub noreply address>");
  expect(result.output).toContain("never the GitHub contents API");
  expect(result.output).not.toContain(NOREPLY);
  // dry-run 은 git 읽기 말고 아무것도 실행하지 않는다.
  expect(f.calls().every(call => call.startsWith("git rev-parse") || call.startsWith("git show"))).toBe(true);
});

test("release dry-run: 커밋 작성자가 noreply 가 아니면 알리고, 실제 실행이면 빌드 전에 멈춘다", () => {
  const f = releaseFixture("someone@school.example");
  const dry = f.run(["--dry-run", "--upload", "--publish"]);
  expect(dry.code, dry.output).toBe(0);
  expect(dry.output).toContain("NOTE: The tap commit must use a GitHub noreply address");
  expect(dry.output).not.toContain("someone@school.example");
  // 환경 변수로 noreply 를 주면 그것을 쓴다.
  const fixed = f.run(["--dry-run", "--upload", "--publish"], { TAP_GIT_NAME: "Bot", TAP_GIT_EMAIL: "2+bot@users.noreply.github.com" });
  expect(fixed.output).toContain("Bot <GitHub noreply address>");
  expect(fixed.output).not.toContain("NOTE:");
});

test("release: --tap-only 는 공개된 릴리스의 tap 단계만 다시 한다(dry-run 미리보기)", () => {
  expect(parseReleaseOptions(["--ref", "v1.2.3", "--tap-only"])).toMatchObject({ ref: "v1.2.3", tapOnly: true, upload: false });
  for (const args of [["--tap-only", "--upload"], ["--tap-only", "--publish", "--upload"], ["--tap-only", "--skip-tests"]]) expect(() => parseReleaseOptions(args)).toThrow();
  const f = releaseFixture();
  const result = f.run(["--dry-run", "--tap-only"]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("'gh' 'release' 'view'");
  expect(result.output).toContain("SHA256SUMS");
  expect(result.output).toContain("'git' 'clone'");
  for (const step of ["notarytool", "hdiutil", "build:native", "'git' 'archive'"]) expect(result.output).not.toContain(step);
});

// ---- 설치 파일 안 데몬 기동 확인(smokeDaemon): 실제로 컴파일한 실행 파일로 ----

test("smoke: 컴파일한 데몬을 launchd 처럼 띄워 자기 build ID·버전으로 준비를 알리고 SIGTERM 에 깨끗이 멈추는지 본다", async () => {
  const dir = temp("iamceo-smoke-test-");
  const daemon = join(dir, "iamceo");
  const compile = Bun.spawnSync([process.execPath, "build", join(root, "bin/iamceo.ts"), "--compile", "--outfile", daemon], { stdout: "ignore", stderr: "pipe" });
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
  const result = await smokeDaemon({ daemon, version: pkg.version, scratch: dir, timeoutMs: 60_000 });
  expect(result.rows.filter(row => !row.ok)).toEqual([]);
  expect(result.rows.map(row => row.step)).toEqual(["version", "build-id is the SHA-256 of the file", "serve (supervisor, log, port 0)",
    "readiness (build ID, version, schema)", "authenticated read (/api/bootstrap)", "SIGTERM stops it cleanly"]);
  expect(result.ok).toBe(true);
  // 임시 홈은 남지 않는다.
  expect(readdirSync(dir).filter(name => name.startsWith("iamceo-release-smoke-"))).toEqual([]);

  // 다른 버전을 기대하면 띄우기 전에 멈춘다.
  const wrong = await smokeDaemon({ daemon, version: "9.9.9", scratch: dir });
  expect(wrong.ok).toBe(false);
  expect(wrong.rows.map(row => row.step)).toEqual(["version"]);
}, 120_000);

test("smoke: 자기 파일의 해시가 아닌 build ID 를 말하는 실행 파일은 띄우지 않고 실패로 본다", async () => {
  const dir = temp("iamceo-smoke-test-");
  const daemon = join(dir, "iamceo");
  writeFileSync(daemon, `#!/bin/sh\ncase "$1" in version) echo ${pkg.version} ;; build-id) echo ${"0".repeat(64)} ;; *) touch "${dir}/served" ;; esac\n`, { mode: 0o700 });
  const result = await smokeDaemon({ daemon, version: pkg.version, scratch: dir });
  expect(result.ok).toBe(false);
  expect(result.rows.at(-1)).toMatchObject({ step: "build-id is the SHA-256 of the file", ok: false });
  expect(existsSync(join(dir, "served"))).toBe(false);
});

// ---- check.sh ios: 가짜 simctl·xcodebuild 로 ----

function simulators(rows: [runtime: string, name: string, udid: string, state: string][]): string {
  const devices: Record<string, unknown[]> = {};
  for (const [runtime, name, udid, state] of rows) (devices[`com.apple.CoreSimulator.SimRuntime.${runtime}`] ??= []).push({ name, udid, state, isAvailable: true });
  return JSON.stringify({ devices });
}
const MANY = simulators([
  ["iOS-27-2", "iPhone 18 Pro", "BOOTED-27", "Booted"],
  ["iOS-27-2", "IAMCEO Shots iPhone 17 Pro", "SHOTS-27", "Shutdown"],
  ["iOS-27-2", "iPhone 17", "IPHONE-27", "Shutdown"],
  ["iOS-27-2", "iPad mini (A20 Pro)", "IPAD-27", "Shutdown"],
  ["iOS-26-4", "iPhone 17 Pro", "IPHONE-26", "Shutdown"],
  ["watchOS-12-0", "Apple Watch", "WATCH", "Shutdown"],
]);
const line = (name: string, result: string) => `Test Case '-[IAMCEOTests.${name}]' ${result} (0.010 seconds).\n`;

function iosFixture(devices: string) {
  const dir = temp("iamceo-ios-check-");
  const repo = join(dir, "repo"), bin = join(dir, "bin"), scratch = join(dir, "tmp");
  for (const path of ["scripts", "native/Sources", "native/Configuration", "native/Resources", "native/Tests", "shared"]) mkdirSync(join(repo, path), { recursive: true });
  for (const path of ["native/Sources/a.swift", "native/Tests/b.swift", "native/project.yml", "shared/artifact-kit.ts"]) writeFileSync(join(repo, path), "");
  mkdirSync(bin); mkdirSync(scratch);
  copyFileSync(join(root, "scripts/check.sh"), join(repo, "scripts/check.sh"));
  writeFileSync(join(dir, "devices.json"), devices);
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o700); };
  script("xcrun", `printf 'xcrun %s\\n' "$*" >> "$FIXTURE/calls.log"
case "$*" in
  "simctl list devices available -j") cat "$FIXTURE/devices.json" ;;
  "simctl shutdown "*) exit 0 ;;
  *) exit 91 ;;
esac`);
  script("xcodegen", `printf 'xcodegen %s\\n' "$*" >> "$FIXTURE/calls.log"`);
  script("xcodebuild", `printf 'xcodebuild %s\\n' "$*" >> "$FIXTURE/calls.log"
case "$*" in
  *test-without-building*) cat "$FIXTURE/retry.out"; exit "$(cat "$FIXTURE/retry.code")" ;;
  *) cat "$FIXTURE/test.out"; exit "$(cat "$FIXTURE/test.code")" ;;
esac`);
  const put = (name: "test" | "retry", output: string, code: number) => { writeFileSync(join(dir, `${name}.out`), output); writeFileSync(join(dir, `${name}.code`), String(code)); };
  put("test", line("StoreTests testOne", "passed") + "\t Executed 1 test, with 0 failures (0 unexpected) in 0.01 (0.01) seconds\n", 0);
  put("retry", "", 1);
  const check = (extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync(["/bin/bash", join(repo, "scripts/check.sh"), "ios"], {
      env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch, HOME: dir, FIXTURE: dir, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  const calls = () => existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : [];
  return { check, calls, put, scratch };
}

test("check.sh ios: 꺼져 있는 가장 새 iOS 의 iPhone 을 고르고(이름 붙인 기기·켜진 기기·iPad 는 피한다), 끝나면 자기가 띄운 것만 끈다", () => {
  const f = iosFixture(MANY);
  const result = f.check();
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("iPhone simulator: iPhone 17 (iOS 27.2), Shutdown");
  expect(result.output).toContain("iPhone tests: Executed 1 test, with 0 failures on iPhone 17 (iOS 27.2)");
  const build = f.calls().find(call => call.startsWith("xcodebuild"))!;
  expect(build).toContain("-scheme IAMCEO-iOS-Tests");
  expect(build).toContain("-destination platform=iOS Simulator,id=IPHONE-27");
  expect(build.endsWith(" test")).toBe(true);
  expect(f.calls()).toContain("xcrun simctl shutdown IPHONE-27");
  // 켜져 있던 기기와 다른 기기는 건드리지 않는다. 지우기(erase)·부팅(boot)은 부르지 않는다.
  expect(f.calls().filter(call => /simctl (shutdown|erase|boot|delete)/.test(call))).toEqual(["xcrun simctl shutdown IPHONE-27"]);
  expect(readdirSync(f.scratch)).toEqual([]);
});

test("check.sh ios: IAMCEO_IOS_SIMULATOR 로 고른 켜진 기기는 쓰기만 하고 끄지 않는다", () => {
  const f = iosFixture(MANY);
  const result = f.check({ IAMCEO_IOS_SIMULATOR: "BOOTED-27" });
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain("iPhone simulator: iPhone 18 Pro (iOS 27.2), Booted");
  expect(f.calls().some(call => call.includes("id=BOOTED-27"))).toBe(true);
  expect(f.calls().some(call => call.includes("simctl shutdown"))).toBe(false);
  // 이름으로도 고른다(같은 이름이면 가장 새 iOS).
  const named = iosFixture(MANY).check({ IAMCEO_IOS_SIMULATOR: "iPhone 17 Pro" });
  expect(named.output).toContain("iPhone 17 Pro (iOS 26.4)");
});

test("check.sh ios: iPhone 시뮬레이터가 없으면 실패하고, check.sh all 에서는 건너뜀으로 알린다", () => {
  const ipadOnly = simulators([["iOS-27-2", "iPad mini (A20 Pro)", "IPAD-27", "Shutdown"]]);
  const f = iosFixture(ipadOnly);
  const missing = f.check();
  expect(missing.code).toBe(1);
  expect(missing.output).toContain("FAILED: no iPhone simulator on this Mac");
  const optional = f.check({ IAMCEO_IOS_OPTIONAL: "1" });
  expect(optional.code, optional.output).toBe(0);
  expect(optional.output).toContain("SKIPPED iPhone tests: no iPhone simulator");
  // 이름을 지정했는데 없으면 건너뛰지 않고 실패한다.
  expect(f.check({ IAMCEO_IOS_OPTIONAL: "1", IAMCEO_IOS_SIMULATOR: "iPhone 99" }).code).toBe(1);
  expect(f.calls().some(call => call.startsWith("xcodebuild"))).toBe(false);
  expect(text("scripts/check.sh")).toMatch(/all\) ts; server; compat; swift_check; IAMCEO_IOS_OPTIONAL=1 ios_check; build ;;/);
});

test("check.sh ios: 실패한 시험만 같은 기기에서 다시 돌려 통과하면 FLAKY, 또 실패하면 막는다. 어느 쪽이든 띄운 기기는 끈다", () => {
  const f = iosFixture(MANY);
  const first = line("StoreTests testOne", "passed") + line("WriteConflictTests testSlow", "failed") + "\t Executed 2 tests, with 1 failure (0 unexpected) in 0.1 (0.1) seconds\n";
  f.put("test", first, 65);
  f.put("retry", line("WriteConflictTests testSlow", "passed") + "\t Executed 1 test, with 0 failures (0 unexpected) in 0.1 (0.1) seconds\n", 0);
  const flaky = f.check();
  expect(flaky.code, flaky.output).toBe(0);
  expect(flaky.output).toContain("iPhone tests: 1 flaky");
  expect(flaky.output).toContain("FLAKY: IAMCEOTests.WriteConflictTests/testSlow");
  const retry = f.calls().find(call => call.includes("test-without-building"))!;
  expect(retry).toContain("-only-testing:IAMCEOTests-iOS/WriteConflictTests/testSlow");
  expect(retry).toContain("id=IPHONE-27");

  const g = iosFixture(MANY);
  g.put("test", first, 65);
  g.put("retry", line("WriteConflictTests testSlow", "failed") + "\t Executed 1 test, with 1 failure (0 unexpected) in 0.1 (0.1) seconds\n", 65);
  const broken = g.check();
  expect(broken.code).not.toBe(0);
  expect(broken.output).toContain("FAILED iPhone tests:");
  expect(broken.output).toContain("IAMCEOTests.WriteConflictTests/testSlow");
  expect(g.calls()).toContain("xcrun simctl shutdown IPHONE-27");

  // 이름 없는 실패(빌드 오류, 충돌로 끝까지 못 감)는 다시 돌리지 않고 로그 끝을 보여 준다.
  const h = iosFixture(MANY);
  h.put("test", "error: cannot find 'Process' in scope\n** TEST FAILED **\n", 65);
  const compile = h.check();
  expect(compile.code).not.toBe(0);
  expect(compile.output).toContain("did not finish");
  expect(compile.output).toContain("cannot find 'Process' in scope");
  expect(h.calls().some(call => call.includes("test-without-building"))).toBe(false);
});

// ---- project.yml 과 시험 파일 ----

test("project: iPhone 시험 타깃은 같은 시험 폴더를 쓰고, 시험을 품는 앱은 출시 앱과 번들 ID 가 다르다. 출시 계획은 시험 타깃을 만들지 않는다", () => {
  type Target = { type: string; platform: string; sources: (string | { path: string; optional?: boolean })[]; dependencies?: { target?: string }[]; settings?: { base?: Record<string, string> } };
  const project = Bun.YAML.parse(text("native/project.yml")) as { targets: Record<string, Target>; schemes: Record<string, { build: { targets: Record<string, unknown> }; test?: { targets: string[] } }> };
  const tests = project.targets["IAMCEOTests-iOS"], host = project.targets["IAMCEO-iOS-TestHost"], app = project.targets["IAMCEO-iOS"];
  expect(tests.type).toBe("bundle.unit-test");
  expect(tests.platform).toBe("iOS");
  expect(tests.sources).toEqual([{ path: "Tests/IAMCEOTests", optional: true }]);
  expect(text("native/Package.swift")).toContain('path: "Tests/IAMCEOTests"');
  expect(tests.dependencies?.map(dependency => dependency.target)).toContain("IAMCEO-iOS-TestHost");
  expect(tests.settings?.base?.PRODUCT_MODULE_NAME).toBe("IAMCEOTests");
  // 시험 앱은 출시 앱과 같은 소스, 같은 모듈 이름(@testable import IAMCEO), 다른 번들 ID.
  expect(host.sources).toEqual(app.sources);
  expect(host.settings?.base?.PRODUCT_MODULE_NAME).toBe("IAMCEO");
  expect(host.settings?.base?.PRODUCT_BUNDLE_IDENTIFIER).not.toBe(app.settings?.base?.PRODUCT_BUNDLE_IDENTIFIER);
  expect(host.settings?.base?.PRODUCT_BUNDLE_IDENTIFIER).not.toMatch(/^com\.yehsung\.iamceo$/);
  expect(project.schemes["IAMCEO-iOS-Tests"].test?.targets).toEqual(["IAMCEOTests-iOS"]);
  expect(Object.keys(project.schemes["IAMCEO-iOS"].build.targets)).toEqual(["IAMCEO-iOS"]);
  expect(Object.keys(project.schemes["IAMCEO-macOS"].build.targets)).toEqual(["IAMCEO-macOS"]);
  // 앱만 빌드하는 곳은 Tests 를 복사하지 않는다(그래서 시험 소스는 optional). iPhone 시험 단계는 복사한다.
  expect(text("scripts/build-native.ts")).not.toContain('"Tests"');
  expect(text("scripts/check.sh")).toContain("cp -R native/Sources native/Configuration native/Resources native/Tests native/project.yml \"$CHECK_ROOT/ios/native/\"");
});

test("시험 파일: Mac 에만 있는 API 는 #if os(macOS) 안에서만 쓴다(iPhone 시험 타깃이 같은 폴더를 컴파일한다)", () => {
  const dir = join(root, "native/Tests/IAMCEOTests");
  const macOnly = /^\s*import AppKit\b|\bProcess\(\)|\bNS(Pasteboard|Workspace|Application|View|Window|TextView|Image|Event)\b/;
  const isMac = (directive: string) => /os\(macOS\)|canImport\(AppKit\)/.test(directive) && !/!\s*(os\(macOS\)|canImport\(AppKit\))/.test(directive);
  const isPhone = (directive: string) => (/os\(iOS\)|canImport\(UIKit\)/.test(directive) && !directive.includes("!")) || /!\s*os\(macOS\)/.test(directive);
  const offenders: string[] = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith(".swift"))) {
    // #if 의 겹을 따라간다: #if os(macOS) 의 본문과 #if os(iOS) 의 #else 는 Mac 에서만 컴파일된다.
    const frames: { mac: boolean; phone: boolean }[] = [];
    readFileSync(join(dir, file), "utf8").split("\n").forEach((source, index) => {
      const directive = source.trim();
      if (directive.startsWith("#if ")) { frames.push({ mac: isMac(directive), phone: isPhone(directive) }); return; }
      const top = frames.at(-1);
      if (directive.startsWith("#elseif ") && top) { top.mac = isMac(directive); top.phone = false; return; }
      if (directive === "#else" && top) { top.mac = top.phone; top.phone = false; return; }
      if (directive === "#endif") { frames.pop(); return; }
      if (directive.startsWith("//") || frames.some(frame => frame.mac)) return;
      if (macOnly.test(source)) offenders.push(`${file}:${index + 1}: ${directive}`);
    });
  }
  expect(offenders).toEqual([]);
});
