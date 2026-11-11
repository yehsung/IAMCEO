// 검사·릴리스 게이트 자체: scripts/check.sh 의 파일별 실행·재실행·정리·건너뜀 보고, release-mac 의 CI 통과 확인.
// 실제 bun/swift/git/gh 는 부르지 않는다. 임시 폴더의 가짜 실행 파일만 쓴다.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { hasPassingCheckRun, parseReleaseOptions } from "../scripts/release-mac.ts";

const root = resolve(import.meta.dir, "..");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(tests: string[] = []) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-gate-test-")));
  cleanups.push(() => {
    // 정리가 실패한 경우에도 시험이 일부러 만든 읽기 전용 폴더가 남지 않게 한다.
    Bun.spawnSync(["/bin/chmod", "-R", "u+rwx", dir]);
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = join(dir, "repo"), bin = join(dir, "bin"), scratch = join(dir, "tmp"), summary = join(dir, "summary.md");
  for (const path of [join(repo, "scripts"), join(repo, "tests"), bin, scratch]) mkdirSync(path, { recursive: true });
  copyFileSync(join(root, "scripts/check.sh"), join(repo, "scripts/check.sh"));
  for (const name of tests) writeFileSync(join(repo, "tests", name), "");
  const script = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o700); };
  // 마지막 인자(파일 이름)에 따라 결과를 정한다: broken 은 늘 실패, flaky 는 처음만 실패, locked 는 읽기 전용 폴더를 남긴다.
  script("bun", `printf '%s\\n' "$*" >> "$FIXTURE/calls.log"
for arg in "$@"; do file=$arg; done
case "$file" in
  *broken*) exit 1 ;;
  *flaky*) if [ -e "$FIXTURE/flaky.seen" ]; then exit 0; fi; : > "$FIXTURE/flaky.seen"; exit 1 ;;
  *locked*) mkdir -p "$TMPDIR/ro/inner"; : > "$TMPDIR/ro/inner/file"; chmod 500 "$TMPDIR/ro/inner" "$TMPDIR/ro" ;;
esac
exit 0`);
  script("swift", `printf 'swift %s\\n' "$1" >> "$FIXTURE/calls.log"
if [ "$1" = test ]; then cat "$FIXTURE/swift-test.out"; exit "$(cat "$FIXTURE/swift-test.code")"; fi
exit 0`);
  const env = { PATH: `${bin}:${process.env.PATH}`, TMPDIR: scratch, HOME: dir, FIXTURE: dir, GITHUB_STEP_SUMMARY: summary };
  const check = (args: string[], extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync(["/bin/bash", join(repo, "scripts/check.sh"), ...args], { env: { ...env, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  const calls = () => existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : [];
  return { dir, bin, scratch, summary, env, script, check, calls };
}

// 옛 실행기를 지우며 herdr.test.ts 를 빼던 줄도 없앴다. 이제 빼는 파일이 없다: *.test.ts 는 모두 돌고, 시험이 아닌 파일만 건너뛴다.
test("check.sh server: *.test.ts 를 빠짐없이 파일마다 따로 30초 제한으로 돌린다. 임시 폴더는 남지 않는다", () => {
  const f = fixture(["a.test.ts", "b.test.ts", "herdr.test.ts", "helper.ts"]);
  const result = f.check(["server"]);
  expect(result.code, result.output).toBe(0);
  expect(f.calls()).toEqual(["test --timeout=30000 ./tests/a.test.ts", "test --timeout=30000 ./tests/b.test.ts", "test --timeout=30000 ./tests/herdr.test.ts"]);
  expect(result.output).toContain("server tests: 3 files, 0 failed, 0 flaky");
  expect(readdirSync(f.scratch)).toEqual([]);
});

test("check.sh server: 한 번 실패하고 다시 돌려 통과한 파일은 숨기지 않고 FLAKY 로 남긴다", () => {
  const f = fixture(["a.test.ts", "flaky.test.ts", "z.test.ts"]);
  const result = f.check(["server"]);
  expect(result.code, result.output).toBe(0);
  expect(f.calls()).toEqual(["test --timeout=30000 ./tests/a.test.ts", "test --timeout=30000 ./tests/flaky.test.ts", "test --timeout=30000 ./tests/z.test.ts", "test --timeout=30000 ./tests/flaky.test.ts"]);
  expect(result.output).toContain("server tests: 3 files, 0 failed, 1 flaky");
  expect(result.output).toContain("FLAKY: tests/flaky.test.ts");
  expect(readFileSync(f.summary, "utf8")).toContain("FLAKY: tests/flaky.test.ts");
});

test("check.sh server: 두 번 다 실패하면 막고, 나머지 파일은 끝까지 돌린다. 재실행을 끄면 한 번 실패로 막는다", () => {
  const f = fixture(["a.test.ts", "broken.test.ts", "z.test.ts"]);
  const result = f.check(["server"]);
  expect(result.code).toBe(1);
  expect(f.calls()).toEqual(["test --timeout=30000 ./tests/a.test.ts", "test --timeout=30000 ./tests/broken.test.ts", "test --timeout=30000 ./tests/z.test.ts", "test --timeout=30000 ./tests/broken.test.ts"]);
  expect(result.output).toContain("server tests: 3 files, 1 failed, 0 flaky");
  expect(result.output).toContain("FAILED: tests/broken.test.ts");
  expect(readFileSync(f.summary, "utf8")).toContain("FAILED: tests/broken.test.ts");
  expect(readdirSync(f.scratch)).toEqual([]);

  const strict = fixture(["flaky.test.ts"]);
  const once = strict.check(["server"], { IAMCEO_TEST_RETRY: "0", IAMCEO_TEST_TIMEOUT_MS: "1234" });
  expect(once.code).toBe(1);
  expect(strict.calls()).toEqual(["test --timeout=1234 ./tests/flaky.test.ts"]);
  expect(once.output).toContain("FAILED: tests/flaky.test.ts");
});

test("check.sh server: 인자를 주면 그대로 넘기고 실패도 그대로 돌려준다", () => {
  const f = fixture(["a.test.ts"]);
  expect(f.check(["server", "tests/a.test.ts", "-t", "이름"]).code).toBe(0);
  expect(f.check(["server", "tests/broken.test.ts"]).code).toBe(1);
  expect(f.calls()).toEqual(["test tests/a.test.ts -t 이름", "test tests/broken.test.ts"]);
});

test("check.sh: 시험이 남긴 읽기 전용 폴더도 치우고, 정리 때문에 통과가 실패로 바뀌지 않는다", () => {
  const f = fixture(["locked.test.ts"]);
  const result = f.check(["server"]);
  expect(result.code, result.output).toBe(0);
  expect(result.output).not.toContain("could not remove");
  expect(readdirSync(f.scratch)).toEqual([]);
});

test("check.sh swift: 건너뛴 시험을 이름으로 알리고, 요구하면 끌어다 놓기 시험 건너뜀을 실패로 친다", () => {
  const f = fixture();
  const skipped = (name: string) => `Test Case '-[IAMCEOTests.${name}]' started.\nTest Case '-[IAMCEOTests.${name}]' skipped (0.147 seconds).\n`;
  const passed = "Test Case '-[IAMCEOTests.StoreTests testOne]' passed (0.001 seconds).\n";
  const out = (text: string, code = 0) => { writeFileSync(join(f.dir, "swift-test.out"), text); writeFileSync(join(f.dir, "swift-test.code"), String(code)); };

  out(passed);
  const clean = f.check(["swift"], { IAMCEO_REQUIRE_APPKIT_TESTS: "1" });
  expect(clean.code, clean.output).toBe(0);
  expect(clean.output).not.toContain("SKIPPED");
  expect(f.calls()).toEqual(["swift build", "swift test"]);

  out(passed + skipped("MacAttachmentUploadTests testFinderDrop") + skipped("VideoPlaybackTests testCommandLine"));
  const listed = f.check(["swift"]);
  expect(listed.code, listed.output).toBe(0);
  expect(listed.output).toContain("SKIPPED native tests (2):");
  expect(listed.output).toContain("IAMCEOTests.MacAttachmentUploadTests testFinderDrop");
  expect(readFileSync(f.summary, "utf8")).toContain("IAMCEOTests.VideoPlaybackTests testCommandLine");
  const required = f.check(["swift"], { IAMCEO_REQUIRE_APPKIT_TESTS: "1" });
  expect(required.code).toBe(1);
  expect(required.output).toContain("FAILED: drag-and-drop upload tests were skipped");

  // 환경과 무관하게 늘 건너뛰는 시험만 있으면 요구해도 막지 않는다.
  out(passed + skipped("VideoPlaybackTests testCommandLine"));
  expect(f.check(["swift"], { IAMCEO_REQUIRE_APPKIT_TESTS: "1" }).code).toBe(0);

  // swift test 의 실패는 건너뜀 보고와 상관없이 그대로 실패다.
  out(passed + skipped("VideoPlaybackTests testCommandLine"), 1);
  const failed = f.check(["swift"]);
  expect(failed.code).toBe(1);
  expect(failed.output).toContain("SKIPPED native tests (1):");
  expect(readdirSync(f.scratch)).toEqual([]);
});

test("check.sh swift: 실패한 시험만 새 프로세스에서 한 번 더 돌린다. 통과하면 FLAKY 로 남기고, 또 실패하면 막는다", () => {
  const f = fixture();
  const line = (name: string, result: string) => `Test Case '-[IAMCEOTests.${name}]' started.\nTest Case '-[IAMCEOTests.${name}]' ${result} (0.100 seconds).\n`;
  // 첫 실행은 swift-test.out, --filter 가 붙은 재실행은 swift-retry.out 을 낸다.
  f.script("swift", `printf 'swift %s\\n' "$*" >> "$FIXTURE/calls.log"
if [ "$1" != test ]; then exit 0; fi
case "$*" in
  *--filter*) cat "$FIXTURE/swift-retry.out"; exit "$(cat "$FIXTURE/swift-retry.code")" ;;
esac
cat "$FIXTURE/swift-test.out"; exit "$(cat "$FIXTURE/swift-test.code")"`);
  const put = (name: string, text: string, code: number) => { writeFileSync(join(f.dir, `${name}.out`), text); writeFileSync(join(f.dir, `${name}.code`), String(code)); };
  const first = line("StoreTests testOne", "passed") + line("TerminalStreamTests testSlow", "failed") + line("TerminalSessionTests testWidth", "failed")
    + "\t Executed 3 tests, with 2 failures (0 unexpected) in 0.3 (0.3) seconds\n";

  put("swift-test", first, 1);
  put("swift-retry", line("TerminalSessionTests testWidth", "passed") + line("TerminalStreamTests testSlow", "passed") + "\t Executed 2 tests, with 0 failures (0 unexpected) in 0.2 (0.2) seconds\n", 0);
  const flaky = f.check(["swift"]);
  expect(flaky.code, flaky.output).toBe(0);
  expect(flaky.output).toContain("native tests: 2 flaky");
  expect(flaky.output).toContain("FLAKY: IAMCEOTests.TerminalStreamTests/testSlow (failed once, passed on re-run)");
  expect(readFileSync(f.summary, "utf8")).toContain("FLAKY: IAMCEOTests.TerminalSessionTests/testWidth");
  const retry = f.calls().filter((call) => call.includes("--filter"));
  expect(retry).toHaveLength(1);
  // 실패한 둘만 고른다. 통과한 시험은 다시 돌리지 않는다.
  expect(retry[0]).toContain("--filter ^IAMCEOTests.TerminalSessionTests/testWidth$ --filter ^IAMCEOTests.TerminalStreamTests/testSlow$");
  expect(retry[0]).not.toContain("StoreTests");

  // 다시 돌려도 실패하면 막고, 어느 시험인지 알린다.
  put("swift-retry", line("TerminalSessionTests testWidth", "passed") + line("TerminalStreamTests testSlow", "failed") + "\t Executed 2 tests, with 1 failure (0 unexpected) in 0.2 (0.2) seconds\n", 1);
  const broken = f.check(["swift"]);
  expect(broken.code).toBe(1);
  expect(broken.output).toContain("FAILED native tests (failed twice):");
  expect(broken.output).toContain("IAMCEOTests.TerminalStreamTests/testSlow");
  expect(broken.output).not.toContain("FLAKY");

  // 고른 시험이 하나도 돌지 않았으면(이름이 맞지 않음) 통과로 치지 않는다.
  put("swift-retry", "\t Executed 0 tests, with 0 failures (0 unexpected) in 0.0 (0.0) seconds\n", 0);
  expect(f.check(["swift"]).code).toBe(1);

  // 재실행을 끄면 한 번 실패로 막는다.
  writeFileSync(join(f.dir, "calls.log"), "");
  const off = f.check(["swift"], { IAMCEO_TEST_RETRY: "0" });
  expect(off.code).toBe(1);
  expect(off.output).toContain("FAILED native tests:");
  expect(f.calls().some((call) => call.includes("--filter"))).toBe(false);

  // 시험 이름 없이 실패하면(컴파일 오류·충돌) 다시 돌리지 않는다.
  put("swift-test", "error: fatal error encountered during compilation\n", 1);
  writeFileSync(join(f.dir, "calls.log"), "");
  expect(f.check(["swift"]).code).toBe(1);
  expect(f.calls().some((call) => call.includes("--filter"))).toBe(false);
  expect(readdirSync(f.scratch)).toEqual([]);
});

test("release: CI 판정은 release·ci 워크플로의 성공만 통과로 본다", () => {
  expect(hasPassingCheckRun(JSON.stringify([{ workflowName: "release", conclusion: "failure" }, { workflowName: "ci", conclusion: "success" }]))).toBe(true);
  expect(hasPassingCheckRun(JSON.stringify([{ workflowName: "release", conclusion: "success" }]))).toBe(true);
  for (const runs of [[], [{ workflowName: "release", conclusion: "failure" }], [{ workflowName: "release", conclusion: "cancelled" }],
    [{ workflowName: "ci", conclusion: "" }], [{ workflowName: "other", conclusion: "success" }], [null], { workflowName: "ci", conclusion: "success" }]) {
    expect(hasPassingCheckRun(JSON.stringify(runs))).toBe(false);
  }
  expect(hasPassingCheckRun("")).toBe(false);
  expect(parseReleaseOptions([])).toEqual({ ref: "HEAD", dryRun: false, upload: false, publish: false });
  expect(parseReleaseOptions(["--upload", "--skip-tests", "--allow-untested"])).toMatchObject({ upload: true, skipTests: true, allowUntested: true });
});

function releaseFixture() {
  const f = fixture();
  const sha = "0".repeat(39) + "1";
  f.script("git", `printf 'git %s\\n' "$1" >> "$FIXTURE/calls.log"
case "$1" in
  rev-parse) printf '%s\\n' ${sha} ;;
  show) printf '{"version":"${pkg.version}"}\\n' ;;
  *) echo forbidden >&2; exit 91 ;;
esac`);
  f.script("gh", `printf 'gh %s %s\\n' "$1" "$2" >> "$FIXTURE/calls.log"
case "$1 $2" in
  "release view") printf '{"isDraft":true}\\n' ;;
  "api "*) printf '%s\\n' ${sha} ;;
  "run list") cat "$FIXTURE/runs.json" ;;
  *) echo forbidden >&2; exit 91 ;;
esac`);
  for (const tool of ["tar", "xcodegen", "xcodebuild", "codesign", "xcrun", "hdiutil", "ditto", "spctl", "bash"]) f.script(tool, `printf '${tool} %s\\n' "$1" >> "$FIXTURE/calls.log"; exit 91`);
  const key = join(f.dir, "key.p8"); writeFileSync(key, "fixture");
  const release = (args: string[], runs?: unknown) => {
    if (runs !== undefined) writeFileSync(join(f.dir, "runs.json"), JSON.stringify(runs));
    const result = Bun.spawnSync([process.execPath, join(root, "scripts/release-mac.ts"), ...args], {
      env: { ...f.env, SIGN_IDENTITY: "Developer ID Application: Fixture", NOTARY_KEY_PATH: key, NOTARY_KEY_ID: "FIXTURE-ID", NOTARY_ISSUER: "FIXTURE-ISSUER" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  return { ...f, sha, release };
}

test("release: dry-run 은 CI 확인과 네이티브 시험 단계를 미리 보여 주고, 생략은 경고로 남긴다", () => {
  const f = releaseFixture();
  const plain = f.release(["--dry-run", "--upload"]);
  expect(plain.code, plain.output).toBe(0);
  expect(plain.output).toContain(`'gh' 'run' 'list' '--repo' 'yehsung/IAMCEO' '--commit' '${f.sha}'`);
  expect(plain.output.indexOf("'gh' 'run' 'list'")).toBeLessThan(plain.output.indexOf("'git' 'archive'"));
  expect(plain.output.indexOf("'bash' 'scripts/check.sh' 'swift'")).toBeGreaterThan(plain.output.indexOf("'install' '--frozen-lockfile'"));
  expect(plain.output.indexOf("'bash' 'scripts/check.sh' 'swift'")).toBeLessThan(plain.output.indexOf("'build:native'"));
  expect(plain.output).not.toContain("WARNING");

  const skipped = f.release(["--dry-run", "--upload", "--skip-tests", "--allow-untested"]);
  expect(skipped.code, skipped.output).toBe(0);
  expect(skipped.output).toContain("WARNING: --allow-untested");
  expect(skipped.output).toContain("WARNING: --skip-tests");
  expect(skipped.output).not.toContain("'gh' 'run' 'list'");
  expect(skipped.output).not.toContain("scripts/check.sh");
  // dry-run 은 git 의 읽기 두 가지 말고는 아무것도 실행하지 않는다.
  expect(f.calls().every(call => call === "git rev-parse" || call === "git show")).toBe(true);
});

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("release: --upload 은 그 커밋의 CI 성공이 없으면 빌드 전에 멈춘다", () => {
  const f = releaseFixture();
  const refused = f.release(["--upload"], [{ workflowName: "release", conclusion: "failure" }, { workflowName: "ci", conclusion: "cancelled" }]);
  expect(refused.code).toBe(1);
  expect(refused.output).toContain("No successful CI run");
  expect(f.calls()).toContain("gh run list");
  expect(f.calls()).not.toContain("git archive");

  // 성공한 실행이 있으면 다음 단계(git archive)로 넘어간다. 가짜 git 이 거기서 멈춘다.
  const passed = f.release(["--upload"], [{ workflowName: "release", conclusion: "failure" }, { workflowName: "ci", conclusion: "success" }]);
  expect(passed.output).not.toContain("No successful CI run");
  expect(f.calls()).toContain("git archive");

  // 명시적 우회는 확인을 건너뛰되 기록을 남긴다.
  const before = f.calls().filter(call => call === "gh run list").length;
  const forced = f.release(["--upload", "--allow-untested"], [{ workflowName: "release", conclusion: "failure" }]);
  expect(forced.output).toContain("WARNING: --allow-untested");
  expect(forced.output).not.toContain("No successful CI run");
  expect(f.calls().filter(call => call === "gh run list")).toHaveLength(before);
  expect(f.calls().filter(call => call === "git archive")).toHaveLength(2);
});
