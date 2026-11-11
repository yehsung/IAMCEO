import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";

// install.sh must prove who signed the app and that Apple notarized it before anything is installed.
// The flow runs against fake tools (no real DMG, no real /Applications); the requirement itself is
// checked with the real codesign against a locally made, ad-hoc signed bundle.
setDefaultTimeout(20_000);

const root = resolve(import.meta.dir, "..");
const installer = readFileSync(join(root, "install.sh"), "utf8");
const requirement = installer.match(/^SIGN_REQUIREMENT='(.+)'$/m)?.[1] ?? "";
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "iamceo-w1-tooling-")); temporary.push(path); return path;
}

function fixture() {
  const path = temp();
  const home = join(path, "home"), bin = join(path, "bin"), dir = join(path, "Applications"), release = join(path, "release");
  const source = join(path, "fixture-app", "IAMCEO.app");
  for (const folder of [home, bin, dir, release, join(path, "tmp"), join(source, "Contents")]) mkdirSync(folder, { recursive: true });
  const script = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  const dmgName = `IAMCEO-${pkg.version}-arm64.dmg`;
  writeFileSync(join(release, dmgName), "fake dmg bytes");
  writeFileSync(join(release, "SHA256SUMS"), `${createHash("sha256").update("fake dmg bytes").digest("hex")}  ${dmgName}\n`);
  writeFileSync(join(source, "Contents/Info.plist"), "new app");
  // Every fake appends its name and arguments to one log, so the order of the steps is visible.
  const logged = (name: string, body: string) => script(name, `printf '%s %s\\n' ${name} "$*" >> "$FIXTURE_ROOT/calls.log"\n${body}`);
  script("curl", `output=; url=
while [ "$#" -gt 0 ]; do
  case "$1" in -o) shift; output=$1 ;; file://*) url=$1 ;; -*) ;; *) exit 91 ;; esac
  shift
done
case "$url" in "file://$FIXTURE_ROOT/release/"*) ;; *) echo 'fixture download refused' >&2; exit 91 ;; esac
exec /bin/cp "\${url#file://}" "$output"`);
  script("uname", 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac');
  script("sw_vers", "echo 14.0");
  script("pgrep", "exit 1");
  logged("plutil", `echo ${pkg.version}`);
  logged("hdiutil", `case "$1" in
attach)
  mountpoint=
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -mountpoint ]; then shift; mountpoint=$1; fi
    shift
  done
  /bin/cp -R "$FIXTURE_ROOT/fixture-app/IAMCEO.app" "$mountpoint/IAMCEO.app" ;;
detach) ;;
*) exit 90 ;;
esac`);
  logged("ditto", '/bin/cp -R "$1" "$2"');
  logged("open", "");
  logged("codesign", 'if [ "${MOCK_CODESIGN_FAIL:-0}" = 1 ]; then echo "mock: code failed to satisfy specified code requirement(s)" >&2; exit 3; fi');
  logged("spctl", 'if [ "${MOCK_SPCTL_FAIL:-0}" = 1 ]; then echo "mock: rejected" >&2; exit 3; fi');
  const env = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: join(path, "tmp"), FIXTURE_ROOT: path,
    IAMCEO_INSTALL_DIR: dir, IAMCEO_DOWNLOAD_URL: `file://${release}` };
  const run = (extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync(["/bin/sh", join(root, "install.sh")], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  const calls = () => existsSync(join(path, "calls.log")) ? readFileSync(join(path, "calls.log"), "utf8").trim().split("\n") : [];
  const installOld = () => { mkdirSync(join(dir, "IAMCEO.app")); writeFileSync(join(dir, "IAMCEO.app/old"), "keep"); };
  return { path, dir, run, calls, installOld };
}

test("installer: the pinned requirement names the publisher's Developer ID team and the Mac app's bundle identifier", () => {
  expect(requirement).toContain('certificate leaf[subject.OU] = "MQ2KQK37WD"');
  // Developer ID intermediate + Developer ID Application leaf: another certificate type of the same team is refused.
  expect(requirement).toContain("certificate 1[field.1.2.840.113635.100.6.2.6] exists");
  expect(requirement).toContain("certificate leaf[field.1.2.840.113635.100.6.1.13] exists");
  expect(requirement).toContain("anchor apple generic");
  // The identifier in the requirement must follow the Mac target; a renamed bundle would otherwise fail every install.
  const mac = readFileSync(join(root, "native/project.yml"), "utf8").split(/^  (?=\S)/m).find(block => block.startsWith("IAMCEO-macOS:"))!;
  const bundleId = mac.match(/PRODUCT_BUNDLE_IDENTIFIER:\s*(\S+)/)![1];
  expect(requirement).toContain(`identifier "${bundleId}"`);
});

test("installer: signature, then Gatekeeper, are checked on the mounted app before it is read, copied or opened", () => {
  const f = fixture(); const result = f.run();
  expect(result.code, result.output).toBe(0);
  const calls = f.calls(), index = (prefix: string) => calls.findIndex(line => line.startsWith(prefix));
  const signature = calls[index("codesign ")];
  expect(signature).toContain(`--verify --deep --strict -R ${requirement}`);
  expect(signature).toMatch(/\/mount\/IAMCEO\.app$/);
  expect(calls[index("spctl ")]).toMatch(/^spctl -a -t execute .*\/mount\/IAMCEO\.app$/);
  expect(index("hdiutil attach")).toBeLessThan(index("codesign "));
  expect(index("codesign ")).toBeLessThan(index("spctl "));
  for (const later of ["plutil -extract CFBundleShortVersionString", "ditto ", "open "]) expect(index("spctl ")).toBeLessThan(index(later));
  expect(existsSync(join(f.dir, "IAMCEO.app/Contents/Info.plist"))).toBe(true);
});

test.each([
  ["a signature that is not the publisher's", { MOCK_CODESIGN_FAIL: "1" }, "서명이 IAMCEO 배포자의 것이 아니거나", "not signed by the IAMCEO publisher"],
  ["an app Gatekeeper rejects", { MOCK_SPCTL_FAIL: "1" }, "Apple 공증 확인 실패", "Gatekeeper rejected"],
])("installer: %s stops the install, in both languages, and leaves the previous app untouched", (_name, extra, korean, english) => {
  const f = fixture(); f.installOld();
  const result = f.run(extra);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain(korean); expect(result.output).toContain(english);
  expect(result.output).toContain("IAMCEO 설치 실패:"); expect(result.output).toContain("IAMCEO install failed:");
  expect(result.output).toContain("아무것도 설치하거나 바꾸지 않았습니다"); expect(result.output).toContain("Nothing was installed or changed");
  expect(result.output).not.toContain("설치했습니다:");
  // Nothing was copied, swapped or opened; the previous app and the install folder are exactly as before.
  expect(readFileSync(join(f.dir, "IAMCEO.app/old"), "utf8")).toBe("keep");
  expect(readdirSync(f.dir)).toEqual(["IAMCEO.app"]);
  const calls = f.calls();
  expect(calls.some(line => line.startsWith("ditto ") || line.startsWith("open "))).toBe(false);
  if ("MOCK_CODESIGN_FAIL" in extra) expect(calls.some(line => line.startsWith("spctl "))).toBe(false);
  expect(calls.some(line => line.startsWith("hdiutil detach"))).toBe(true);
});

test("installer: a first install with a bad signature leaves no app behind", () => {
  const f = fixture(); const result = f.run({ MOCK_CODESIGN_FAIL: "1" });
  expect(result.code).not.toBe(0);
  expect(readdirSync(f.dir)).toEqual([]);
});

test("installer: codesign and spctl are required tools, checked before any download", () => {
  expect(installer).toMatch(/for tool in [^;]*\bcodesign\b[^;]*\bspctl\b[^;]*; do/);
});

test.skipIf(process.platform !== "darwin")("installer: the real codesign compiles the requirement and refuses a bundle the publisher did not sign", () => {
  const compiled = Bun.spawnSync(["/usr/bin/csreq", "-r", requirement, "-t"], { stdout: "pipe", stderr: "pipe" });
  expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
  // A minimal app with the right bundle identifier, signed ad hoc (as anyone can).
  const app = join(temp(), "IAMCEO.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  copyFileSync("/usr/bin/true", join(app, "Contents/MacOS/IAMCEO"));
  writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>IAMCEO</string>
<key>CFBundleIdentifier</key><string>com.iamceo.native.mac</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
  const signed = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", app], { stdout: "pipe", stderr: "pipe" });
  expect(signed.exitCode, signed.stderr.toString()).toBe(0);
  const verify = (extra: string[]) => Bun.spawnSync(["/usr/bin/codesign", "--verify", "--deep", "--strict", ...extra, app], { stdout: "pipe", stderr: "pipe" });
  // The bundle itself is intact, so only the requirement can be what refuses it.
  expect(verify([]).exitCode).toBe(0);
  const refused = verify(["-R", requirement]);
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr.toString()).toContain("failed to satisfy specified code requirement");
  // A change after signing is caught even without the requirement.
  writeFileSync(join(app, "Contents/Info.plist"), readFileSync(join(app, "Contents/Info.plist"), "utf8").replace("APPL", "BNDL"));
  expect(verify([]).exitCode).not.toBe(0);
});
