/** A self-contained local macOS app. Building never installs or starts a launchd service. */
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lock from "../vendor/herdr-core/release-lock.json";
import pkg from "../package.json";

if (process.platform !== "darwin") throw new Error("The native macOS bundle must be built on macOS with Xcode and XcodeGen.");
if (process.arch !== "arm64" && process.arch !== "x64") throw new Error(`Unsupported Mac architecture: ${process.arch}`);
const root = resolve(import.meta.dir, "..");
const output = join(root, "dist", "native");
const signatureRequirement = '=identifier "dev.herdr.core" and anchor apple generic and certificate leaf[subject.OU] = "2W9652Q7QR"';
function run(command: string[]): void {
  const result = Bun.spawnSync(command, { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Command failed (${result.exitCode}): ${command[0]}`);
}
for (const tool of ["xcodegen", "xcodebuild", "codesign"]) if (!Bun.which(tool)) throw new Error(`Install ${tool} before building the macOS app.`);
// The release (scripts/release-mac.ts) refuses any Bun but .bun-version; a local build only says so.
const pinnedBun = readFileSync(join(root, ".bun-version"), "utf8").trim();
if (Bun.version !== pinnedBun) console.warn(`Note: this Bun is ${Bun.version}; releases are compiled with Bun ${pinnedBun} (.bun-version).`);
run([process.execPath, "run", "setup:core"]);
const coreSource = join(root, ".runtime", "herdr-core", lock.version);
const coreApp = join(coreSource, "Herdr Core.app");
if (!existsSync(coreApp)) throw new Error("The pinned signed Herdr Core.app is missing; run bun run setup:core.");
run(["/usr/bin/codesign", "--verify", "--strict", "-R", signatureRequirement, coreApp]);
const coreBinary = "Contents/MacOS/herdr-core";
const originalCoreHash = createHash("sha256").update(readFileSync(join(coreApp, coreBinary))).digest("hex");
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(output, ".build-"));
try {
  // Generate an isolated Xcode project so another native development build is not changed.
  const source = join(staging, "native");
  mkdirSync(source);
  for (const entry of ["Sources", "Configuration", "Resources", "project.yml"]) cpSync(join(root, "native", entry), join(source, entry), { recursive: true });
  run(["xcodegen", "generate", "--spec", join(source, "project.yml")]);
  const daemon = join(staging, "iamceo");
  // 팀장의 작업 폴더에서 뜨는 MCP 다리(iamceo mcp)가 그 폴더의 .env·bunfig.toml 을 읽지 않게 한다(리뷰 hooks-1).
  run([process.execPath, "build", "bin/iamceo.ts", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", `--target=bun-darwin-${process.arch}`, "--outfile", daemon]);
  chmodSync(daemon, 0o755);
  run(["/usr/bin/codesign", "--force", "--sign", "-", daemon]);
  const derived = join(staging, "DerivedData");
  // A Mac local host needs Process + LaunchAgents access. The iOS target remains sandboxed.
  run(["xcodebuild", "-project", join(source, "IAMCEO.xcodeproj"), "-scheme", "IAMCEO-macOS", "-configuration", "Release", "-derivedDataPath", derived,
    `ARCHS=${process.arch === "x64" ? "x86_64" : "arm64"}`, "ONLY_ACTIVE_ARCH=YES",
    "CODE_SIGNING_ALLOWED=NO", "CODE_SIGN_ENTITLEMENTS=", "ENABLE_APP_SANDBOX=NO", "build"]);
  const app = join(staging, "IAMCEO.app");
  run(["/usr/bin/ditto", join(derived, "Build", "Products", "Release", "IAMCEO.app"), app]);
  run(["/usr/libexec/PlistBuddy", "-c", `Set :CFBundleShortVersionString ${pkg.version}`, join(app, "Contents", "Info.plist")]);
  const runtime = join(app, "Contents", "Resources", "runtime");
  mkdirSync(runtime, { recursive: true });
  cpSync(daemon, join(runtime, "iamceo"));
  chmodSync(join(runtime, "iamceo"), 0o755);
  // Do not use codesign --deep: the upstream core keeps its vendor identity and signature.
  const bundledCore = join(runtime, "Herdr Core.app");
  run(["/usr/bin/ditto", coreApp, bundledCore]);
  for (const entry of ["LICENSE", "THIRD-PARTY-NOTICES", "verified.json"]) cpSync(join(coreSource, entry), join(runtime, entry));
  cpSync(join(root, "vendor", "herdr-core", "release-lock.json"), join(runtime, "release-lock.json"));
  cpSync(join(root, "LICENSE"), join(runtime, "IAMCEO-LICENSE"));
  cpSync(join(root, "THIRD-PARTY-NOTICES.md"), join(runtime, "IAMCEO-THIRD-PARTY-NOTICES.md"));
  writeFileSync(join(runtime, "README.txt"), `IAMCEO bundled local runtime\nherdr-core ${lock.version}\n\nThe app registers its local daemon only after you choose “이 Mac에서 시작”.\nProvider CLIs and their existing login/configuration remain user-managed.\nHerdr Core.app retains its upstream code signature. See LICENSE and THIRD-PARTY-NOTICES.\n`);
  run(["/usr/bin/codesign", "--force", "--sign", "-", app]);
  run(["/usr/bin/codesign", "--verify", "--strict", "-R", signatureRequirement, bundledCore]);
  if (createHash("sha256").update(readFileSync(join(bundledCore, coreBinary))).digest("hex") !== originalCoreHash) throw new Error("The vendor core changed during packaging.");
  run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
  const destination = join(output, "IAMCEO.app");
  rmSync(destination, { recursive: true, force: true });
  renameSync(app, destination);
  console.log(`Built ${destination}\nLocal ad-hoc signing only. No service was installed or started.`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
