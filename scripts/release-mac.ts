/** Developer ID release, run by the supervisor outside the sandbox.
 * bun scripts/release-mac.ts --dry-run [--ref COMMIT] [--upload [--publish]] [--skip-tests] [--allow-untested]
 * Native tests run before the build (--skip-tests omits them, and says so). --upload also requires a
 * successful CI run of the commit (--allow-untested overrides, and says so).
 * Credentials ONLY: SIGN_IDENTITY, NOTARY_KEY_PATH, NOTARY_KEY_ID, NOTARY_ISSUER.
 * Commit changes first: only git archive inputs are built, never the working tree.
 */
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface ReleaseOptions { ref: string; dryRun: boolean; upload: boolean; publish: boolean; skipTests?: boolean; allowUntested?: boolean }
export function parseReleaseOptions(args: string[]): ReleaseOptions {
  const options: ReleaseOptions = { ref: "HEAD", dryRun: false, upload: false, publish: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--ref":
        if (!args[i + 1] || args[i + 1].startsWith("-")) throw new Error("--ref requires a commit or tag");
        options.ref = args[++i]; break;
      case "--dry-run": options.dryRun = true; break;
      case "--upload": options.upload = true; break;
      case "--publish": options.publish = true; break;
      case "--skip-tests": options.skipTests = true; break;
      case "--allow-untested": options.allowUntested = true; break;
      default: throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  if (options.publish && !options.upload) throw new Error("--publish requires --upload (upload to an existing draft first)");
  return options;
}

export function renderCask(template: string, version: string, sha256: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("A stable semver version is required");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("A SHA-256 digest is required");
  if (!template.includes('sha256 "@SHA256@"') || !/version "\d+\.\d+\.\d+"/.test(template)) throw new Error("Invalid cask template");
  return template.replace(/version "\d+\.\d+\.\d+"/, `version "${version}"`).replace('sha256 "@SHA256@"', `sha256 "${sha256}"`);
}

/** `gh run list --commit SHA --json workflowName,conclusion` output. A failed, cancelled or running check is not a pass. */
export function hasPassingCheckRun(runsJson: string): boolean {
  let runs: unknown;
  try { runs = JSON.parse(runsJson); } catch { return false; }
  return Array.isArray(runs) && runs.some(run => !!run && typeof run === "object" &&
    ["release", "ci"].includes((run as { workflowName?: unknown }).workflowName as string) && (run as { conclusion?: unknown }).conclusion === "success");
}

/** codesign -d --verbose=4 output; signed time alone is not a secure timestamp. */
export function hasNotarizationSignature(details: string): boolean {
  return /Authority=Developer ID Application:/.test(details) && /flags=.*\bruntime\b/.test(details) &&
    /^Timestamp=.+$/m.test(details) && !/^Timestamp=(?:none|not set)$/im.test(details);
}

/** Real Mach-O files only; do not follow framework symlinks or sign scripts/resources. */
export function signingTargets(app: string): string[] {
  const targets = new Set<string>();
  function visit(path: string): boolean {
    let containsCode = false;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) containsCode = visit(child) || containsCode;
      else if (entry.isFile()) {
        const fd = openSync(child, "r");
        const magic = Buffer.alloc(4);
        try { readSync(fd, magic, 0, 4, 0); } finally { closeSync(fd); }
        if (["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic.toString("hex"))) {
          targets.add(child); containsCode = true;
        }
      }
    }
    if (containsCode && /\.(app|framework|xpc|appex|bundle)$/.test(path)) targets.add(path);
    return containsCode;
  }
  visit(app);
  return [...targets].sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
}

const root = resolve(import.meta.dir, "..");
const vendorRequirement = '=identifier "dev.herdr.core" and anchor apple generic and certificate leaf[subject.OU] = "2W9652Q7QR"';
const daemonEntitlements = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>\n`;

export function releaseMac(options: ReleaseOptions): void {
  function read(command: string[], cwd = root): string {
    const result = Bun.spawnSync(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString().trim()}`);
    return result.stdout.toString().trim();
  }
  const commit = read(["git", "rev-parse", "--verify", "--end-of-options", `${options.ref}^{commit}`]);
  const pkg = JSON.parse(read(["git", "show", `${commit}:package.json`])) as { version: string };
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.version === "0.1.0") throw new Error("Commit the 0.2.0+ Mac release sources first; CLI-only v0.1.0 cannot be released as a Mac app");
  const tag = `v${pkg.version}`;
  if (options.upload && read(["git", "rev-parse", "--verify", `refs/tags/${tag}^{commit}`]) !== commit) throw new Error(`${tag} must point at the archived commit`);
  const dry = options.dryRun;
  const env = process.env;
  if (!dry) {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Build on an arm64 Mac with Xcode and XcodeGen");
    for (const key of ["SIGN_IDENTITY", "NOTARY_KEY_PATH", "NOTARY_KEY_ID", "NOTARY_ISSUER"])
      if (!env[key]) throw new Error(`Missing environment variable: ${key}`);
    if (!env.SIGN_IDENTITY!.startsWith("Developer ID Application:")) throw new Error("SIGN_IDENTITY must be a Developer ID Application identity");
    if (!existsSync(env.NOTARY_KEY_PATH!)) throw new Error("NOTARY_KEY_PATH does not exist");
    for (const tool of ["bun", "git", "tar", "xcodegen", "xcodebuild", "codesign", "xcrun", "hdiutil", "ditto", "spctl", ...(options.upload ? ["gh"] : [])])
      if (!Bun.which(tool)) throw new Error(`Required release tool missing: ${tool}`);
  }
  const work = dry ? "$BUILD" : mkdtempSync(join(tmpdir(), "iamceo-release-"));
  const source = join(work, "source");
  const out = join(root, "dist", "release");
  const app = join(source, "dist", "native", "IAMCEO.app");
  const core = join(app, "Contents", "Resources", "runtime", "Herdr Core.app");
  const daemon = join(app, "Contents", "Resources", "runtime", "iamceo");
  const dmgName = `IAMCEO-${pkg.version}-arm64.dmg`;
  const dmg = join(work, dmgName);
  const entitlements = join(work, "bun-entitlements.plist");
  const identity = dry ? "$SIGN_IDENTITY" : env.SIGN_IDENTITY!;
  function run(command: string[], cwd = source, allowFailure = false, childEnv?: Record<string, string | undefined>): void {
    // Redact API credentials even in the printed command, and never read the keychain in dry-run.
    const display = command.map((part, i) => ["--key", "--key-id", "--issuer"].includes(command[i - 1]) ? `<${command[i - 1].slice(2)} from env>` : part);
    console.log(`${dry ? "[dry-run] " : ""}${display.map(p => `'${p.replaceAll("'", "'\\''")}'`).join(" ")}`);
    if (dry) return;
    const result = Bun.spawnSync(command, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit", ...(childEnv ? { env: childEnv } : {}) });
    if (result.exitCode !== 0 && !allowFailure) throw new Error(`Command failed (${result.exitCode}): ${command[0]}`);
  }
  function sign(path: string, extra: string[] = []): void {
    run(["codesign", "--force", "--sign", identity, "--options", "runtime", "--timestamp", ...extra, path]);
  }
  function notarize(path: string): void {
    if (dry) {
      run(["xcrun", "notarytool", "submit", path, "--key", "$NOTARY_KEY_PATH", "--key-id", "$NOTARY_KEY_ID", "--issuer", "$NOTARY_ISSUER", "--wait", "--output-format", "json"]);
      console.log("[dry-run] Require notarytool status Accepted; abort on Invalid/In Progress or missing status");
      return;
    }
    // Parse status: notarytool can exit successfully after a rejected submission.
    const result = JSON.parse(read(["xcrun", "notarytool", "submit", path, "--key", env.NOTARY_KEY_PATH!, "--key-id", env.NOTARY_KEY_ID!, "--issuer", env.NOTARY_ISSUER!, "--wait", "--output-format", "json"], source)) as { status?: string; id?: string };
    if (result.status !== "Accepted") throw new Error(`Notarization rejected: ${result.status ?? "missing status"}; submission ${result.id ?? "unknown"}. Retrieve its notarytool log before retrying.`);
    console.log(`Notarization Accepted: ${result.id}`);
  }
  try {
    console.log(`Release ${tag} from clean git archive ${commit} (arm64). Working tree changes are excluded.`);
    if (options.upload) {
      const view = ["gh", "release", "view", tag, "--repo", "yehsung/IAMCEO", "--json", "isDraft"];
      const remoteCommit = ["gh", "api", `repos/yehsung/IAMCEO/commits/${tag}`, "--jq", ".sha"];
      if (dry) {
        run(view, root); run(remoteCommit, root);
      } else {
        const release = JSON.parse(read(view)) as { isDraft: boolean };
        if (!release.isDraft) throw new Error("Upload requires an existing draft release; refuse to replace assets in a public release");
        if (read(remoteCommit) !== commit) throw new Error("The remote release tag differs from the archived commit");
      }
      // A hand-made draft must not carry an untested commit to users: the commit's own checks must have passed.
      const checks = ["gh", "run", "list", "--repo", "yehsung/IAMCEO", "--commit", commit, "--json", "workflowName,conclusion", "--limit", "50"];
      if (options.allowUntested) console.log(`WARNING: --allow-untested: uploading ${tag} without a successful CI run of ${commit}.`);
      else if (dry) { run(checks, root); console.log("[dry-run] Require a successful release or ci workflow run of this commit; abort otherwise"); }
      else if (!hasPassingCheckRun(read(checks))) throw new Error(`No successful CI run (release or ci workflow) of ${commit}. Fix or re-run the checks first; --allow-untested overrides and is logged`);
    }
    if (!dry) mkdirSync(source);
    run(["git", "archive", "--format=tar", "--output", join(work, "source.tar"), commit], root);
    run(["tar", "-xf", join(work, "source.tar"), "-C", source], root);
    run([process.execPath, "install", "--frozen-lockfile"]);
    // Native tests run nowhere else on the release path. They test the archived sources, without the signing credentials.
    if (options.skipTests) console.log("WARNING: --skip-tests: native tests were NOT run for this build.");
    else run(["bash", "scripts/check.sh", "swift"], source, false, { ...env, SIGN_IDENTITY: undefined, NOTARY_KEY_PATH: undefined, NOTARY_KEY_ID: undefined, NOTARY_ISSUER: undefined });
    run([process.execPath, "run", "build:native"]);
    if (!dry) {
      if (read(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleShortVersionString", join(app, "Contents", "Info.plist")], source) !== pkg.version) throw new Error("Built app version differs from release version");
      run(["lipo", "-verify_arch", "arm64", join(app, "Contents", "MacOS", "IAMCEO")]);
      run(["lipo", "-verify_arch", "arm64", daemon]);
      run(["lipo", "-verify_arch", "arm64", join(core, "Contents", "MacOS", "herdr-core")]);
    }
    // Before signing: ad-hoc builds can fail Gatekeeper until notarized; report that result.
    run(["codesign", "--verify", "--deep", "--strict", app]);
    run(["spctl", "-a", "-vv", "--type", "execute", app], source, true);
    console.log("Pre-sign spctl is diagnostic for the ad-hoc input; final post-staple assessment is mandatory.");
    run(["codesign", "--verify", "--deep", "--strict", "-R", vendorRequirement, core]);
    if (!dry) writeFileSync(entitlements, daemonEntitlements);
    console.log("Bun daemon only: allow-jit + allow-unsigned-executable-memory; no DYLD, library-validation or page-protection exceptions. Smoke-test the signed daemon before publishing.");
    const targets = dry ? [daemon, join(core, "Contents", "MacOS", "herdr-core"), core, join(app, "Contents", "MacOS", "IAMCEO"), app] : signingTargets(app);
    const coreTargets = targets.filter(path => path === core || path.startsWith(`${core}/`));
    if (coreTargets.length === 0) throw new Error("No signed vendor code was found in the bundle");
    const preserveCore = !dry && coreTargets.every(path => {
      const result = Bun.spawnSync(["codesign", "--display", "--verbose=4", path], { stdout: "pipe", stderr: "pipe" });
      return result.exitCode === 0 && hasNotarizationSignature(result.stderr.toString());
    });
    console.log(dry
      ? "[dry-run] Inspect every vendor code signature: preserve official Herdr signature ONLY if Developer ID + hardened runtime + secure timestamp are present everywhere; otherwise re-sign inside-out, retaining vendor entitlements."
      : preserveCore ? "Preserve official Herdr signatures: all nested code has Developer ID, hardened runtime and secure timestamps."
        : "Re-sign Herdr inside-out: at least one vendor code signature lacks notarization prerequisites; vendor integrity was verified before modification. Keep upstream entitlements and license notices.");
    if (!preserveCore && !dry) {
      // The local build's explanatory note must match the actual distributed identity.
      const note = join(app, "Contents", "Resources", "runtime", "README.txt");
      writeFileSync(note, readFileSync(note, "utf8").replace("Herdr Core.app retains its upstream code signature.", "Herdr Core.app was verified against its upstream signature, then re-signed by the IAMCEO distributor for notarization."));
    }
    for (const path of targets) {
      const isCore = path === core || path.startsWith(`${core}/`);
      if (isCore && preserveCore) continue;
      if (isCore && !dry) {
        const ent = read(["codesign", "--display", "--entitlements", ":-", path], source);
        if (/<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\s*\/>/.test(ent)) throw new Error(`Debug entitlement in vendor code: ${path}`);
      }
      sign(path, path === daemon ? ["--entitlements", entitlements] : isCore ? ["--preserve-metadata=identifier,entitlements"] : []);
    }
    run(["codesign", "--verify", "--deep", "--strict", app]);
    if (!dry) {
      const version = read([daemon, "version"], source);
      if (version !== pkg.version) throw new Error("Signed Bun daemon failed version smoke check");
    }
    run(["ditto", "-c", "-k", "--keepParent", app, join(work, "IAMCEO.zip")]);
    notarize(join(work, "IAMCEO.zip"));
    run(["xcrun", "stapler", "staple", app]);
    run(["xcrun", "stapler", "validate", app]);
    run(["codesign", "--verify", "--deep", "--strict", app]);
    run(["spctl", "-a", "-vv", "--type", "execute", app]);
    const image = join(work, "image");
    if (!dry) mkdirSync(image);
    run(["ditto", app, join(image, "IAMCEO.app")]);
    run(["ln", "-s", "/Applications", join(image, "Applications")]);
    run(["hdiutil", "create", "-volname", "IAMCEO", "-srcfolder", image, "-format", "UDZO", "-ov", dmg]);
    sign(dmg);
    run(["codesign", "--verify", "--strict", dmg]);
    notarize(dmg);
    run(["xcrun", "stapler", "staple", dmg]);
    run(["xcrun", "stapler", "validate", dmg]);
    run(["spctl", "-a", "-vv", "--type", "open", "--context", "context:primary-signature", dmg]);
    const digest = dry ? "<SHA256 of stapled DMG>" : createHash("sha256").update(readFileSync(dmg)).digest("hex");
    let sums = `${digest}  ${dmgName}\n`;
    if (options.upload) {
      if (!dry) {
        mkdirSync(join(work, "cli-sums"));
      }
      run(["gh", "release", "download", tag, "--repo", "yehsung/IAMCEO", "--pattern", "SHA256SUMS", "--dir", join(work, "cli-sums")]);
      if (!dry) {
        const lines = readFileSync(join(work, "cli-sums", "SHA256SUMS"), "utf8").trim().split("\n");
        const cli = lines.filter(line => /^[a-f0-9]{64}  iamceo-darwin-(arm64|x64)$/.test(line));
        if (cli.length !== 2 || new Set(cli.map(line => line.split("  ")[1])).size !== 2) throw new Error("Draft must contain checksums for both CLI assets");
        sums = `${cli.join("\n")}\n${sums}`;
      }
    }
    if (!dry) {
      mkdirSync(out, { recursive: true });
      cpSync(dmg, join(out, dmgName));
      writeFileSync(join(out, "SHA256SUMS"), sums);
      writeFileSync(join(out, "iamceo.rb"), renderCask(readFileSync(join(source, "packaging", "homebrew", "Casks", "iamceo.rb"), "utf8"), pkg.version, digest));
    }
    console.log(`${dry ? "[dry-run] Write " : "Wrote "}${out}/{${dmgName},SHA256SUMS,iamceo.rb}; checksum is taken AFTER stapling.`);
    console.log("Before installing over existing data: bun run smoke:db <path to iamceo.db> (opens a copy in an isolated server, never the original).");
    if (options.upload) run(["gh", "release", "upload", tag, "--repo", "yehsung/IAMCEO", join(out, dmgName), join(out, "SHA256SUMS"), "--clobber"]);
    if (options.publish) run(["gh", "release", "edit", tag, "--repo", "yehsung/IAMCEO", "--draft=false", "--latest"]);
  } finally {
    if (!dry) rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { releaseMac(parseReleaseOptions(process.argv.slice(2))); }
  catch (error) { console.error(`Mac release failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
