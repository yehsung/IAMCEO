import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { service, waitForReadiness } from "../bin/iamceo.ts";
import { loadConfig } from "../server/config.ts";
import { hasNotarizationSignature, parseReleaseOptions, renderCask, signingTargets } from "../scripts/release-mac";
import pkg from "../package.json";

// Exercise the real installer and checksum tool. Fresh executable fixtures can
// take seconds to start on macOS; bound each scenario independently of that cost.
setDefaultTimeout(15_000);

const root = resolve(import.meta.dir, "..");
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = mkdtempSync("/private/tmp/iamceo-release-test-"); temporary.push(path); return path;
}
const template = readFileSync(join(root, "packaging/homebrew/Casks/iamceo.rb"), "utf8");
function fixture() {
  const path = temp();
  const home = join(path, "home");
  const bin = join(path, "bin");
  const dir = join(path, "Applications with spaces");
  const release = join(path, "release");
  const mountedApp = join(path, "fixture-app", "IAMCEO.app");
  for (const folder of [home, bin, dir, release, join(path, "tmp"), join(mountedApp, "Contents"), join(home, "Library/LaunchAgents")]) mkdirSync(folder, { recursive: true });
  const script = (name: string, source: string) => writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${source}\n`, { mode: 0o755 });
  const dmgName = `IAMCEO-${pkg.version}-arm64.dmg`;
  writeFileSync(join(release, dmgName), "fake dmg bytes, never mounted by real hdiutil");
  const digest = createHash("sha256").update(readFileSync(join(release, dmgName))).digest("hex");
  writeFileSync(join(release, "SHA256SUMS"), `${"b".repeat(64)}  iamceo-darwin-arm64\n${digest}  ${dmgName}\n`);
  writeFileSync(join(mountedApp, "Contents/Info.plist"), "fixture plist");
  script("curl", `output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; output=$1 ;;
    -fsSL|-fL|--progress-bar) ;;
    file://*) url=$1 ;;
    *) echo 'fixture download refused' >&2; exit 91 ;;
  esac
  shift
done
case "$url" in
  "file://$FIXTURE_ROOT/release/SHA256SUMS"|"file://$FIXTURE_ROOT/release/${dmgName}") ;;
  *) echo 'fixture download refused' >&2; exit 91 ;;
esac
case "$output" in "$FIXTURE_ROOT"/tmp/iamceo-install.*/*) ;; *) exit 91 ;; esac
printf '%s\\n' "$url" >> "$FIXTURE_ROOT/download.log"
exec /bin/cp "\${url#file://}" "$output"`);
  script("uname", 'case "$1" in -s) echo "${MOCK_PLATFORM:-Darwin}" ;; -m) echo "${MOCK_ARCH:-arm64}" ;; esac');
  script("sw_vers", 'echo "${MOCK_OS:-14.0}"');
  script("sysctl", 'echo "${MOCK_ROSETTA:-0}"');
  script("pgrep", 'test "${MOCK_RUNNING:-0}" = 1');
  script("plutil", `case "$2" in
CFBundleShortVersionString) echo "\${MOCK_VERSION:-${pkg.version}}" ;;
Label) echo com.iamceo.server ;;
Program) exit 1 ;;
ProgramArguments.0) echo "\${MOCK_PROGRAM:-/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo}" ;;
*) exit 1 ;;
esac`);
  script("hdiutil", `printf '%s\\n' "$*" >> "$FIXTURE_ROOT/hdiutil.log"
case "$1" in
attach)
  mountpoint=
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -mountpoint ]; then shift; mountpoint=$1; fi
    shift
  done
  [ -n "$mountpoint" ]
  /bin/cp -R "$FIXTURE_ROOT/fixture-app/IAMCEO.app" "$mountpoint/IAMCEO.app"
  ;;
detach) test "\${MOCK_DETACH_FAIL:-0}" != 1 ;;
*) exit 90 ;;
esac`);
  script("ditto", '[ "${MOCK_COPY_FAIL:-0}" != 1 ] || exit 1\n/bin/cp -R "$1" "$2"');
  script("open", 'printf "%s\\n" "$1" > "$FIXTURE_ROOT/open.log"');
  // install.sh verifies the mounted app's signature and notarization; the fixture app is not a signed bundle.
  // The checks themselves are covered in tests/w1-tooling-install.test.ts.
  script("codesign", 'printf "%s\\n" "$*" >> "$FIXTURE_ROOT/codesign.log"');
  script("spctl", 'printf "%s\\n" "$*" >> "$FIXTURE_ROOT/spctl.log"');
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: join(path, "tmp"),
    FIXTURE_ROOT: path, IAMCEO_INSTALL_DIR: dir, IAMCEO_DOWNLOAD_URL: `file://${release}`, IAMCEO_TEST: "1",
    IAMCEO_HOME: join(path, "iamceo"), IAMCEO_PORT: "0", IAMCEO_CORE_BIN: "/usr/bin/false",
    IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false",
    IAMCEO_CORE_SOCKET: join(path, "no-core.sock"), IAMCEO_HERDR_SOCKET: join(path, "no-herdr.sock"),
    // 문구는 이 값으로 고른다(없으면 LANG). 아래 단언은 한국어 문구를 본다. 영어는 'installer: English' 시험이 본다.
    IAMCEO_LANG: "ko",
  };
  const run = (extra: NodeJS.ProcessEnv = {}) => {
    const result = Bun.spawnSync(["/bin/sh", join(root, "install.sh")], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  return { path, home, bin, dir, release, script, env, run, dmgName, digest, plist: join(home, "Library/LaunchAgents/com.iamceo.server.plist") };
}

test("installer: latest checksummed DMG installs in a path with spaces, detaches, opens app", () => {
  const f = fixture(); const result = f.run();
  expect(result.code, result.output).toBe(0);
  expect(existsSync(join(f.dir, "IAMCEO.app/Contents/Info.plist"))).toBe(true);
  expect(readFileSync(join(f.path, "open.log"), "utf8").trim()).toBe(join(f.dir, "IAMCEO.app"));
  expect(readFileSync(join(f.path, "hdiutil.log"), "utf8")).toContain("detach");
  expect(result.output).toContain("이 Mac에서 시작");
  expect(readFileSync(join(f.path, "download.log"), "utf8").trim().split("\n")).toEqual([
    `file://${f.release}/SHA256SUMS`, `file://${f.release}/${f.dmgName}`,
  ]);
  expect(new Bun.Glob("*").scanSync({ cwd: f.env.TMPDIR }).next().done).toBe(true);
});

test("installer: English messages when IAMCEO_LANG or LANG is not Korean, Korean when LANG starts with ko", () => {
  const english = fixture().run({ IAMCEO_LANG: "en", LANG: "ko_KR.UTF-8" });
  expect(english.code, english.output).toBe(0);
  expect(english.output).toContain("Installed:");
  expect(english.output).toContain("Start on this Mac");
  expect(english.output).not.toMatch(/설치했습니다|받는 중/);
  const byLang = fixture().run({ IAMCEO_LANG: "", LANG: "ko_KR.UTF-8" });
  expect(byLang.code, byLang.output).toBe(0);
  expect(byLang.output).toContain("설치했습니다:");
  const plain = fixture().run({ IAMCEO_LANG: "", LANG: "C" });
  expect(plain.output).toContain("Installed:");
  const refused = fixture().run({ IAMCEO_LANG: "en", IAMCEO_INSTALL_DIR: "relative/path" });
  expect(refused.code).not.toBe(0);
  expect(refused.output).toContain("IAMCEO install failed: IAMCEO_INSTALL_DIR must be an absolute path.");
  expect(refused.output).not.toContain("설치 실패");
});

test("installer: pinned version replaces an existing stopped app", () => {
  const f = fixture(); mkdirSync(join(f.dir, "IAMCEO.app")); writeFileSync(join(f.dir, "IAMCEO.app/old"), "old");
  const result = f.run({ IAMCEO_VERSION: `v${pkg.version}` }); expect(result.code, result.output).toBe(0);
  expect(existsSync(join(f.dir, "IAMCEO.app/old"))).toBe(false);
});

test("installer: fake downloader refuses network URLs before mounting or replacing an app", () => {
  const f = fixture(); mkdirSync(join(f.dir, "IAMCEO.app")); writeFileSync(join(f.dir, "IAMCEO.app/old"), "keep");
  const result = f.run({ IAMCEO_DOWNLOAD_URL: "https://example.invalid/release" });
  expect(result.code).not.toBe(0); expect(result.output).toContain("fixture download refused");
  expect(existsSync(join(f.path, "hdiutil.log"))).toBe(false);
  expect(readFileSync(join(f.dir, "IAMCEO.app/old"), "utf8")).toBe("keep");
});

test("installer: app launch failure after replacement is reported without claiming success", () => {
  const f = fixture(); mkdirSync(join(f.dir, "IAMCEO.app")); writeFileSync(join(f.dir, "IAMCEO.app/old"), "old");
  f.script("open", 'echo mock-open-failed >&2; exit 7');
  const result = f.run();
  expect(result.code).not.toBe(0); expect(result.output).toContain("mock-open-failed");
  expect(result.output).toContain("직접 여세요"); expect(result.output).not.toContain("설치했습니다:");
  expect(existsSync(join(f.dir, "IAMCEO.app/Contents/Info.plist"))).toBe(true);
  expect(existsSync(join(f.dir, "IAMCEO.app/old"))).toBe(false);
  expect(readFileSync(join(f.path, "hdiutil.log"), "utf8")).toContain("detach");
});

// DMG installation hands service startup to the app; keep the former CLI update guarantee here.
test("service update: fake launchctl success cannot hide authenticated readiness failure", async () => {
  const f = fixture();
  const config = loadConfig(f.env);
  const expected = "a".repeat(64);
  const calls: string[] = [];
  let loaded = false, ready = true;
  const dependencies = { home: f.home, config, program: [join(f.dir, "IAMCEO.app/Contents/Resources/runtime/iamceo"), "service-run"],
    launchctl: (...args: string[]) => {
      calls.push(args[0]!);
      if (args[0] === "print") return { ok: loaded, output: "" };
      if (args[0] === "bootout") loaded = false;
      if (args[0] === "bootstrap") loaded = true;
      return { ok: true, output: "" };
    },
    readiness: async (settings: typeof config) => {
      calls.push("readiness");
      await waitForReadiness(settings, { expectedBuildId: expected, timeoutMs: 10, pollMs: 1,
        fetch: (async (url, init) => {
          expect(String(url)).toBe("http://127.0.0.1:0/api/bootstrap");
          expect(init?.headers).toEqual({ Authorization: `Bearer ${config.accessCode}` });
          return Response.json({ runtime: { daemon: { ready, buildId: expected, version: pkg.version } } });
        }) as typeof fetch,
      });
    },
  };
  await service(["install"], dependencies);
  calls.length = 0; ready = false;
  // 명령줄 문구는 실행 환경의 언어(LANG)를 따른다(server/cli-text.ts). 시험은 두 언어 모두 받는다.
  await expect(service(["install", "--restart"], dependencies)).rejects.toThrow(/복구 완료 대기|waiting for recovery to finish/);
  expect(calls).toEqual(["print", "bootout", "print", "bootstrap", "readiness"]);
});

test("installer: checksum mismatch never mounts or changes existing app", () => {
  const f = fixture(); writeFileSync(join(f.release, f.dmgName), "tampered");
  mkdirSync(join(f.dir, "IAMCEO.app")); writeFileSync(join(f.dir, "IAMCEO.app/old"), "keep");
  const result = f.run(); expect(result.code).not.toBe(0); expect(result.output).toContain("SHA-256");
  expect(existsSync(join(f.path, "hdiutil.log"))).toBe(false);
  expect(readFileSync(join(f.dir, "IAMCEO.app/old"), "utf8")).toBe("keep");
});

test.each([{ MOCK_PLATFORM: "Linux" }, { MOCK_ARCH: "x86_64" }, { MOCK_OS: "13.7" }, { IAMCEO_VERSION: "v0.2.0/../../evil" }])("installer: rejects unsupported version and platform %j", extra => {
  const f = fixture();
  const result = f.run(extra);
  expect(result.code, result.output).not.toBe(0);
  expect(existsSync(join(f.path, "hdiutil.log"))).toBe(false);
});

test.each([
  ["CLI-only latest", `${"a".repeat(64)}  iamceo-darwin-arm64\n`],
  ["duplicate digest", `${"a".repeat(64)}  IAMCEO-${pkg.version}-arm64.dmg\n`.repeat(2)],
])("installer: rejects %s", (_name, sums) => {
  const f = fixture(); writeFileSync(join(f.release, "SHA256SUMS"), sums);
  const result = f.run();
  expect(result.code, result.output).not.toBe(0);
  expect(existsSync(join(f.path, "hdiutil.log"))).toBe(false);
});

test("installer: Rosetta recognizes arm64 host", () => {
  const f = fixture(); const result = f.run({ MOCK_ARCH: "x86_64", MOCK_ROSETTA: "1" }); expect(result.code, result.output).toBe(0);
});

test("installer: refuses a running app without overwriting", () => {
  const f = fixture(); mkdirSync(join(f.dir, "IAMCEO.app"));
  const result = f.run({ MOCK_RUNNING: "1" }); expect(result.code).not.toBe(0); expect(result.output).toContain("종료한 뒤");
  expect(existsSync(join(f.path, "hdiutil.log"))).toBe(false);
});

test("installer: legacy CLI service produces uninstall guidance and is untouched", () => {
  const f = fixture(); writeFileSync(f.plist, "legacy service");
  const result = f.run({ MOCK_PROGRAM: join(f.home, ".local/bin/iamceo") });
  expect(result.code).not.toBe(0); expect(result.output).toContain("service uninstall");
  expect(readFileSync(f.plist, "utf8")).toBe("legacy service"); expect(existsSync(join(f.path, "open.log"))).toBe(false);
});

test("installer: app-owned service is never changed", () => {
  const f = fixture(); writeFileSync(f.plist, "app service");
  f.script("launchctl", 'echo forbidden >&2; exit 91');
  const result = f.run(); expect(result.code, result.output).toBe(0); expect(readFileSync(f.plist, "utf8")).toBe("app service");
});

test.each([{ MOCK_COPY_FAIL: "1" }, { MOCK_VERSION: `${pkg.version}-old` }])("installer: copy or bundle version failure %j preserves old app and unmounts", extra => {
  const f = fixture(); mkdirSync(join(f.dir, "IAMCEO.app")); writeFileSync(join(f.dir, "IAMCEO.app/old"), "keep");
  const result = f.run(extra); expect(result.code, result.output).not.toBe(0);
  expect(readFileSync(join(f.dir, "IAMCEO.app/old"), "utf8")).toBe("keep");
  expect(readFileSync(join(f.path, "hdiutil.log"), "utf8")).toContain("detach");
});

test("installer: replacement move failure rolls back the old app", () => {
  const f = fixture(); mkdirSync(join(f.dir, "IAMCEO.app")); writeFileSync(join(f.dir, "IAMCEO.app/old"), "keep");
  f.script("mv", 'case "$1" in */.iamceo-install.*/IAMCEO.app) exit 1 ;; esac\nexec /bin/mv "$@"');
  const result = f.run(); expect(result.code).not.toBe(0);
  expect(readFileSync(join(f.dir, "IAMCEO.app/old"), "utf8")).toBe("keep");
  expect(readFileSync(join(f.path, "hdiutil.log"), "utf8")).toContain("detach");
});

test("installer: a non-directory destination is preserved", () => {
  const f = fixture(); writeFileSync(join(f.dir, "IAMCEO.app"), "keep file");
  const result = f.run(); expect(result.code).not.toBe(0);
  expect(result.output).toContain("앱 폴더가 아닙니다");
  expect(readFileSync(join(f.dir, "IAMCEO.app"), "utf8")).toBe("keep file");
  expect(readFileSync(join(f.path, "hdiutil.log"), "utf8")).toContain("detach");
});

test("installer: detach failure preserves mounted contents and reports the mountpoint", () => {
  const f = fixture(); const result = f.run({ MOCK_DETACH_FAIL: "1" });
  expect(result.code).not.toBe(0); expect(result.output).toContain("마운트를 해제하지 못했습니다");
  expect([...new Bun.Glob("*/mount/IAMCEO.app/Contents/Info.plist").scanSync({ cwd: f.env.TMPDIR })]).toHaveLength(1);
  expect(existsSync(join(f.path, "open.log"))).toBe(false);
});

test("version: source CLI reports the package version and a build identity without starting services", () => {
  const f = fixture();
  const version = Bun.spawnSync([process.execPath, join(root, "bin/iamceo.ts"), "version"], { env: f.env, stdout: "pipe", stderr: "pipe" });
  expect(version.exitCode, version.stderr.toString()).toBe(0);
  expect(version.stdout.toString().trim()).toBe(pkg.version);
  const identity = Bun.spawnSync([process.execPath, join(root, "bin/iamceo.ts"), "build-id"], { env: f.env, stdout: "pipe", stderr: "pipe" });
  expect(identity.exitCode, identity.stderr.toString()).toBe(0);
  expect(identity.stdout.toString().trim()).toMatch(/^[a-f0-9]{64}$/);
});

test("release: options require explicit upload before publishing and reject malformed args", () => {
  expect(parseReleaseOptions([])).toEqual({ ref: "HEAD", dryRun: false, upload: false, publish: false });
  expect(parseReleaseOptions(["--ref", `v${pkg.version}`, "--dry-run", "--upload", "--publish"]).publish).toBe(true);
  for (const args of [["--publish"], ["--ref"], ["--ref", "--upload"], ["--unknown"]]) expect(() => parseReleaseOptions(args)).toThrow();
});

test("release: vendor signature policy requires Developer ID, runtime, secure timestamp", () => {
  const valid = "Authority=Developer ID Application: vendor\nCodeDirectory v=20500 flags=0x10000(runtime) hashes=3\nTimestamp=Nov 10, 2026\n";
  expect(hasNotarizationSignature(valid)).toBe(true);
  for (const invalid of [valid.replace("Timestamp=", "Signed Time="), valid.replace("runtime", "adhoc"), valid.replace("Developer ID Application:", "Apple Development:"), valid.replace("Nov 10, 2026", "none")]) expect(hasNotarizationSignature(invalid)).toBe(false);
});

test("release: Mach-O signing targets are inside-out, resources and scripts are excluded", () => {
  const path = temp(); const app = join(path, "IAMCEO.app"); const nested = join(app, "Contents/Resources/Herdr Core.app");
  mkdirSync(join(nested, "Contents/MacOS"), { recursive: true });
  const bin = join(nested, "Contents/MacOS/herdr-core"); writeFileSync(bin, Buffer.from("cffaedfe00000000", "hex"));
  writeFileSync(join(app, "script"), "#!/bin/sh\nexit 0\n");
  expect(signingTargets(app)).toEqual([bin, nested, app]);
});

test("release: dry-run previews archive, signing, both notaries, stapling and cask without mutations", () => {
  const f = fixture();
  f.script("git", `case "$1" in
rev-parse) printf '%040d\\n' 1 ;;
show) printf '{"version":"${pkg.version}"}\\n' ;;
*) echo forbidden >&2; exit 91 ;;
esac`);
  for (const tool of ["codesign", "xcrun", "gh", "hdiutil", "xcodebuild", "tar"]) f.script(tool, 'echo "must not execute" >&2; exit 91');
  const result = Bun.spawnSync([process.execPath, join(root, "scripts/release-mac.ts"), "--dry-run", "--upload", "--publish"], {
    env: { ...f.env, SIGN_IDENTITY: "SECRET-ID", NOTARY_KEY_PATH: "SECRET-KEY", NOTARY_KEY_ID: "SECRET-KEY-ID", NOTARY_ISSUER: "SECRET-ISSUER" }, stdout: "pipe", stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(result.exitCode, output).toBe(0);
  for (const text of ["archive", "build:native", "--options' 'runtime", "--timestamp", "--entitlements", "--deep' '--strict", "spctl", "notarytool", "stapler", "/Applications", "SHA256SUMS", "iamceo.rb", "--draft=false", "--latest"]) expect(output).toContain(text);
  expect(output.match(/'notarytool' 'submit'/g)).toHaveLength(2);
  expect(output.indexOf("'gh' 'api'")).toBeLessThan(output.indexOf("'git' 'archive'"));
  expect(output).toContain("'isDraft'");
  expect(output).not.toContain("SECRET-");
  expect(existsSync(join(f.path, "hdiutil.log"))).toBe(false);
});

test("release: uncommitted v0.2.0 working tree cannot turn a CLI-only HEAD into a Mac release", () => {
  const f = fixture();
  f.script("git", 'case "$1" in rev-parse) printf "%040d\\n" 1 ;; show) echo \'{"version":"0.1.0"}\' ;; *) exit 91 ;; esac');
  const result = Bun.spawnSync([process.execPath, join(root, "scripts/release-mac.ts"), "--dry-run"], { env: f.env, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1); expect(result.stderr.toString()).toContain("Commit the 0.2.0+");
});

test("cask: generation replaces version/digest, preserves safe cleanup and zap-only data removal", () => {
  const output = renderCask(template, "0.3.1", "a".repeat(64));
  expect(output).toContain('version "0.3.1"'); expect(output).toContain(`sha256 "${"a".repeat(64)}"`);
  expect(output).not.toContain("@SHA256@");
  expect(output).toContain('depends_on arch: :arm64'); expect(output).toContain('depends_on macos: ">= :sonoma"');
  expect(output).toContain('app "IAMCEO.app"');
  expect(output).toContain('"$program" = "$1/IAMCEO.app/Contents/Resources/runtime/iamceo"');
  expect(output).toContain('"$live" = "$program"');
  expect(output.indexOf('trash:  "~/.iamceo"')).toBeGreaterThan(output.indexOf("zap script:"));
  for (const [version, hash] of [["x\"; evil", "a".repeat(64)], ["0.2.0", "bad"]]) expect(() => renderCask(template, version, hash)).toThrow();
});

test("cask: cleanup only unloads a matching app-owned service, never legacy/foreign jobs", () => {
  const body = template.match(/      set -eu\n([\s\S]+?)    SH\n/)![1];
  for (const kind of ["app", "legacy", "foreign-loaded"]) {
    const f = fixture(); writeFileSync(f.plist, "keep");
    const program = kind === "legacy" ? join(f.home, ".local/bin/iamceo") : join(f.dir, "IAMCEO.app/Contents/Resources/runtime/iamceo");
    f.script("launchctl", `case "$1" in print) printf '  program = %s\\n' "$MOCK_LOADED" ;; bootout) echo bootout > "$FIXTURE_ROOT/bootout" ;; *) exit 91 ;; esac`);
    const shell = join(f.path, "cleanup.sh");
    writeFileSync(shell, "set -eu\n" + body.replaceAll("/usr/bin/plutil", "plutil").replaceAll("/bin/launchctl", "launchctl"));
    const result = Bun.spawnSync(["/bin/sh", shell, f.dir], { env: { ...f.env, MOCK_PROGRAM: program, MOCK_LOADED: kind === "foreign-loaded" ? "/foreign/iamceo" : program }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(join(f.path, "bootout"))).toBe(kind === "app");
    expect(existsSync(f.plist)).toBe(kind !== "app");
  }
});
