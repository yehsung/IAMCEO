/** Developer ID release, run by the supervisor outside the sandbox.
 * bun scripts/release-mac.ts --dry-run [--ref COMMIT] [--upload [--publish]] [--skip-tests] [--allow-untested]
 * bun scripts/release-mac.ts --ref vX.Y.Z --tap-only [--dry-run]   (retry only the Homebrew tap step of a published release)
 * Native tests run before the build (--skip-tests omits them, and says so). --upload also requires a
 * successful CI run of the commit (--allow-untested overrides, and says so).
 * Before anything is uploaded, the notarized DMG is mounted and the daemon inside it is served the way launchd runs it
 * (isolated home, port 0, fake CLIs); it must report readiness with its own build ID and the release version.
 * --publish also pushes the cask to the Homebrew tap with plain git, as a GitHub noreply author (TAP_GIT_NAME and
 * TAP_GIT_EMAIL, or the release commit's own noreply author). Never the GitHub contents API: it stamps the account e-mail.
 * The Bun that compiles the daemon must be the one in the commit's .bun-version (CI builds the CLI assets with it too).
 * Credentials ONLY: SIGN_IDENTITY, NOTARY_KEY_PATH, NOTARY_KEY_ID, NOTARY_ISSUER.
 * Commit changes first: only git archive inputs are built, never the working tree.
 */
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rehearsalEnvironment } from "../server/lifecycle/rehearse.ts";

export interface ReleaseOptions { ref: string; dryRun: boolean; upload: boolean; publish: boolean; skipTests?: boolean; allowUntested?: boolean; tapOnly?: boolean }
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
      case "--tap-only": options.tapOnly = true; break;
      default: throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  if (options.tapOnly && (options.upload || options.publish || options.skipTests || options.allowUntested)) throw new Error("--tap-only takes only --ref and --dry-run");
  if (options.publish && !options.upload) throw new Error("--publish requires --upload (upload to an existing draft first)");
  return options;
}

export function renderCask(template: string, version: string, sha256: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("A stable semver version is required");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("A SHA-256 digest is required");
  if (!template.includes('sha256 "@SHA256@"') || !/version "\d+\.\d+\.\d+"/.test(template)) throw new Error("Invalid cask template");
  // The leading "Release template ... do not publish" comment is for the repository copy only, never for the tap.
  return template.replace(/^(?:#[^\n]*\n)+(?=cask )/, "")
    .replace(/version "\d+\.\d+\.\d+"/, `version "${version}"`).replace('sha256 "@SHA256@"', `sha256 "${sha256}"`);
}

/** The cask about to go to the tap: this version, a real digest, no template marker. Returns the digest. */
export function checkRenderedCask(cask: string, version: string): string {
  const digest = cask.match(/^\s*sha256 "([a-f0-9]{64})"$/m)?.[1];
  if (!digest || cask.includes("@SHA256@") || cask.match(/^\s*version "([^"]+)"$/m)?.[1] !== version || !/^cask "iamceo" do$/m.test(cask)) {
    throw new Error(`The cask is not a rendered iamceo ${version} cask`);
  }
  return digest;
}

/** .bun-version: one X.Y.Z line, the Bun that compiles every release executable (this script locally, CI for the CLI assets). */
export function parseBunVersion(text: string): string {
  const version = text.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(".bun-version must hold one X.Y.Z Bun version");
  return version;
}

/** A GitHub noreply address at users.noreply.github.com (the ID+login form, or the older login-only form). Tap commits use nothing else. */
export function isNoreplyEmail(email: string): boolean {
  return /^(?:\d+\+)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})@users\.noreply\.github\.com$/.test(email);
}

/** The tap commit's author and committer: TAP_GIT_NAME and TAP_GIT_EMAIL, else the release commit's author
 * (`git show -s --format=%an%x00%ae`). Anything but a noreply address is refused before a commit is made. */
export function tapAuthor(env: Record<string, string | undefined>, commitAuthor: string): { name: string; email: string } {
  const [commitName = "", commitEmail = ""] = commitAuthor.trim().split("\0");
  const name = (env.TAP_GIT_NAME ?? commitName).trim(), email = (env.TAP_GIT_EMAIL ?? commitEmail).trim();
  if (!name || /[\0\n<>]/.test(name)) throw new Error("The tap commit needs an author name: set TAP_GIT_NAME");
  if (!isNoreplyEmail(email)) throw new Error("The tap commit must use a GitHub noreply address (…@users.noreply.github.com): set TAP_GIT_EMAIL");
  return { name, email };
}

export const TAP_REMOTE = "https://github.com/yehsung/homebrew-tap.git";
export interface TapUpdate {
  cask: string; version: string; remote: string; author: { name: string; email: string }; work: string;
  env?: Record<string, string | undefined>;
}
/** Clone the tap, write Casks/iamceo.rb, commit as the noreply author and git push. Pushing the same cask again is a no-op. */
export function updateTap(input: TapUpdate): "updated" | "unchanged" {
  checkRenderedCask(input.cask, input.version);
  const { name, email } = input.author;
  if (!isNoreplyEmail(email)) throw new Error("The tap commit must use a GitHub noreply address");
  const dir = join(input.work, "tap");
  // Author AND committer: a global user.email must not leak into the public tap either.
  const env = { ...(input.env ?? process.env), GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_TERMINAL_PROMPT: "0" };
  const git = (step: string, args: string[], allowFailure = false): { code: number; out: string } => {
    const result = Bun.spawnSync(["git", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0 && !allowFailure) throw new Error(`Tap ${step} failed: ${result.stderr.toString().trim()}`);
    return { code: result.exitCode, out: result.stdout.toString().trim() };
  };
  git("clone", ["clone", "--quiet", "--depth", "1", "--", input.remote, dir]);
  const branch = git("branch", ["-C", dir, "symbolic-ref", "--short", "HEAD"]).out;
  mkdirSync(join(dir, "Casks"), { recursive: true });
  writeFileSync(join(dir, "Casks", "iamceo.rb"), input.cask);
  git("add", ["-C", dir, "add", "--", "Casks/iamceo.rb"]);
  if (git("diff", ["-C", dir, "diff", "--cached", "--quiet"], true).code === 0) return "unchanged";
  git("commit", ["-C", dir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", `iamceo ${input.version}`]);
  const [author, committer] = git("author check", ["-C", dir, "log", "-1", "--format=%ae%n%ce"]).out.split("\n");
  if (author !== email || committer !== email) throw new Error("The tap commit did not take the noreply author; nothing was pushed");
  git("push", ["-C", dir, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
  return "updated";
}

export interface SmokeRow { step: string; ok: boolean; detail: string }
/** Serve a release daemon the way launchd runs it (supervisor and rotated log: `serve` with IAMCEO_LOG_WRITER=1), but in a
 * throw-away home, on port 0, with fake CLIs and no engine. It passes when the daemon reports readiness with ITS OWN build
 * ID (the SHA-256 of the file), the release version and a current schema, answers an authenticated read, and stops with
 * exit 0 on SIGTERM. Nothing outside the scratch folder is touched; the generated access code never leaves it. */
export async function smokeDaemon(input: { daemon: string; version: string; scratch?: string; timeoutMs?: number }): Promise<{ ok: boolean; rows: SmokeRow[] }> {
  const rows: SmokeRow[] = [];
  const step = (name: string, ok: boolean, detail = ""): boolean => { rows.push({ step: name, ok, detail: ok ? "" : detail }); return ok; };
  const root = realpathSync(mkdtempSync(join(input.scratch ?? tmpdir(), "iamceo-release-smoke-")));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    for (const dir of ["home", "iamceo", "claude", "codex", "state", "config", "cache", "tmp", "bin"]) mkdirSync(join(root, dir), { mode: 0o700 });
    for (const name of ["core", "claude", "codex", "herdr"]) writeFileSync(join(root, "bin", name), "#!/bin/sh\nprintf 'Release smoke: real runtime disabled\\n' >&2\nexit 97\n", { mode: 0o700 });
    // Loopback only: a smoke server must not appear on the tailnet or the LAN of the release Mac.
    writeFileSync(join(root, "iamceo", "config.json"), `${JSON.stringify({ hosts: ["127.0.0.1"], keepAwake: false })}\n`, { mode: 0o600 });
    const env = { ...rehearsalEnvironment(root), IAMCEO_LOG_WRITER: "1" };
    const expected = createHash("sha256").update(readFileSync(input.daemon)).digest("hex");
    const once = (args: string[]) => {
      const result = Bun.spawnSync([input.daemon, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      return { code: result.exitCode, out: result.stdout.toString().trim() };
    };
    const version = once(["version"]);
    if (!step("version", version.code === 0 && version.out === input.version, version.code === 0 ? `reported ${version.out.slice(0, 40)}` : `exit ${version.code}`)) return { ok: false, rows };
    const identity = once(["build-id"]);
    if (!step("build-id is the SHA-256 of the file", identity.code === 0 && identity.out === expected, identity.code === 0 ? "a different build ID" : `exit ${identity.code}`)) return { ok: false, rows };
    child = Bun.spawn([input.daemon, "serve"], { cwd: root, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const deadline = Date.now() + Math.max(1_000, input.timeoutMs ?? 90_000);
    const log = join(root, "iamceo", "logs", "server.log");
    let origin = "";
    while (!origin && Date.now() < deadline && child.exitCode === null) {
      origin = existsSync(log) ? /http:\/\/127\.0\.0\.1:\d+/.exec(readFileSync(log, "utf8"))?.[0] ?? "" : "";
      if (!origin) await Bun.sleep(100);
    }
    // The last error line, when there is one, names what went wrong (paths in it are inside the scratch folder).
    const lastError = () => { try { return readFileSync(join(root, "iamceo", "logs", "server.err.log"), "utf8").trim().split("\n").at(-1)?.slice(0, 200) ?? ""; } catch { return ""; } };
    if (!step("serve (supervisor, log, port 0)", !!origin && new URL(origin).port !== "7878",
      origin ? "listened on the live port" : `${child.exitCode === null ? "no address in the log in time" : `exited ${child.exitCode}`} ${lastError()}`.trim())) return { ok: false, rows };
    const accessCode = (JSON.parse(readFileSync(join(root, "iamceo", "config.json"), "utf8")) as { accessCode?: string }).accessCode ?? "";
    const get = (path: string) => fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${accessCode}` }, redirect: "error", signal: AbortSignal.timeout(5_000) });
    let reason = "no answer";
    let ready = false;
    while (!ready && Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await get("/api/readiness");
        const body = await response.json() as { ok?: boolean; version?: string; daemon?: { ready?: boolean; buildId?: string; version?: string } | null };
        ready = response.status === 200 && body.ok === true && body.version === input.version && body.daemon?.buildId === expected && body.daemon?.version === input.version;
        reason = response.status === 401 ? "HTTP 401" : body.daemon?.buildId && body.daemon.buildId !== expected ? "a different build ID is running"
          : body.version !== input.version ? "a different version is running" : `not ready (HTTP ${response.status})`;
      } catch (error) { reason = (error as Error).name; }
      if (!ready) await Bun.sleep(250);
    }
    if (!step("readiness (build ID, version, schema)", ready, child.exitCode === null ? reason : `exited ${child.exitCode} ${lastError()}`.trim())) return { ok: false, rows };
    try {
      const response = await get("/api/bootstrap");
      const body = await response.json() as { runtime?: { daemon?: { ready?: boolean; buildId?: string } } };
      step("authenticated read (/api/bootstrap)", response.status === 200 && body.runtime?.daemon?.ready === true && body.runtime.daemon.buildId === expected, `HTTP ${response.status}`);
    } catch (error) { step("authenticated read (/api/bootstrap)", false, (error as Error).name); }
    child.kill("SIGTERM");
    const code = await Promise.race([child.exited, Bun.sleep(30_000).then(() => null)]);
    step("SIGTERM stops it cleanly", code === 0, code === null ? "still running 30 s after SIGTERM" : `exit ${code}`);
    return { ok: rows.every(row => row.ok), rows };
  } finally {
    if (child && child.exitCode === null) {
      // The supervisor forwards SIGTERM to its server and kills it after 15 s; only then is it killed itself.
      child.kill("SIGTERM");
      if (await Promise.race([child.exited, Bun.sleep(30_000).then(() => null)]) === null) { child.kill("SIGKILL"); await child.exited; }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/** One line per smoke step, for the release log. */
export function describeSmoke(rows: SmokeRow[]): string {
  return rows.map(row => `  ${row.ok ? "ok  " : "FAIL"} ${row.step}${row.detail ? ` — ${row.detail}` : ""}`).join("\n");
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

export async function releaseMac(options: ReleaseOptions): Promise<void> {
  function read(command: string[], cwd = root): string {
    const result = Bun.spawnSync(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString().trim()}`);
    return result.stdout.toString().trim();
  }
  const commit = read(["git", "rev-parse", "--verify", "--end-of-options", `${options.ref}^{commit}`]);
  const pkg = JSON.parse(read(["git", "show", `${commit}:package.json`])) as { version: string };
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.version === "0.1.0") throw new Error("Commit the 0.2.0+ Mac release sources first; CLI-only v0.1.0 cannot be released as a Mac app");
  const tag = `v${pkg.version}`;
  if ((options.upload || options.tapOnly) && read(["git", "rev-parse", "--verify", `refs/tags/${tag}^{commit}`]) !== commit) throw new Error(`${tag} must point at the archived commit`);
  const dry = options.dryRun;
  const env = process.env;
  const out = join(root, "dist", "release");
  const dmgName = `IAMCEO-${pkg.version}-arm64.dmg`;
  const quote = (command: string[]) => command.map(p => `'${p.replaceAll("'", "'\\''")}'`).join(" ");
  // The tap author is settled before anything is built, so a missing noreply author never stops a release halfway.
  let author: { name: string; email: string } | undefined;
  if (options.publish || options.tapOnly) {
    try { author = tapAuthor(env, read(["git", "show", "-s", "--format=%an%x00%ae", commit])); }
    catch (error) { if (!dry) throw error; console.log(`[dry-run] NOTE: ${(error as Error).message}`); }
  }
  const tapRemote = env.TAP_REMOTE || TAP_REMOTE;
  /** brew users follow the tap: it moves only after the release is public, with plain git as a noreply author. */
  function pushTap(cask: string | null): void {
    if (dry || cask === null) {
      console.log(`[dry-run] ${quote(["git", "clone", "--quiet", "--depth", "1", "--", tapRemote, "$TAP/tap"])}`);
      console.log(`[dry-run] Write Casks/iamceo.rb (dist/release/iamceo.rb) and commit "iamceo ${pkg.version}" as ${author ? `${author.name} <GitHub noreply address>` : "TAP_GIT_NAME <TAP_GIT_EMAIL> or the release commit's noreply author"}; refuse any other address`);
      console.log(`[dry-run] ${quote(["git", "-C", "$TAP/tap", "push", "--quiet", "origin", "HEAD:refs/heads/<default branch>"])}  (never the GitHub contents API)`);
      return;
    }
    const scratch = mkdtempSync(join(tmpdir(), "iamceo-tap-"));
    try {
      const outcome = updateTap({ cask, version: pkg.version, remote: tapRemote, author: author!, work: scratch });
      console.log(outcome === "unchanged" ? `The tap already has iamceo ${pkg.version}; nothing to push.` : `Pushed iamceo ${pkg.version} to the Homebrew tap.`);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  if (options.tapOnly) {
    // Retry of the last --publish step only: the release must be public and the cask must be the one its DMG produced.
    const view = ["gh", "release", "view", tag, "--repo", "yehsung/IAMCEO", "--json", "isDraft"];
    const caskPath = join(out, "iamceo.rb");
    if (dry) {
      console.log(`[dry-run] ${quote(view)}`);
      console.log(`[dry-run] Require ${tag} to be public and ${caskPath} to be the rendered ${pkg.version} cask whose sha256 is the ${dmgName} line of the release's SHA256SUMS`);
      return pushTap(null);
    }
    if ((JSON.parse(read(view)) as { isDraft?: boolean }).isDraft !== false) throw new Error(`${tag} is not public: publish it before the tap points brew users at it`);
    if (!existsSync(caskPath)) throw new Error(`${caskPath} is missing: it is written by the release run that built the DMG`);
    const cask = readFileSync(caskPath, "utf8");
    const digest = checkRenderedCask(cask, pkg.version);
    const sums = mkdtempSync(join(tmpdir(), "iamceo-tap-sums-"));
    try {
      read(["gh", "release", "download", tag, "--repo", "yehsung/IAMCEO", "--pattern", "SHA256SUMS", "--dir", sums]);
      const line = readFileSync(join(sums, "SHA256SUMS"), "utf8").split("\n").find(entry => entry.endsWith(`  ${dmgName}`));
      if (line?.split("  ")[0] !== digest) throw new Error(`${caskPath} does not match the published ${dmgName} checksum`);
    } finally { rmSync(sums, { recursive: true, force: true }); }
    return pushTap(cask);
  }
  if (!dry) {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Build on an arm64 Mac with Xcode and XcodeGen");
    for (const key of ["SIGN_IDENTITY", "NOTARY_KEY_PATH", "NOTARY_KEY_ID", "NOTARY_ISSUER"])
      if (!env[key]) throw new Error(`Missing environment variable: ${key}`);
    if (!env.SIGN_IDENTITY!.startsWith("Developer ID Application:")) throw new Error("SIGN_IDENTITY must be a Developer ID Application identity");
    if (!existsSync(env.NOTARY_KEY_PATH!)) throw new Error("NOTARY_KEY_PATH does not exist");
    for (const tool of ["bun", "git", "tar", "xcodegen", "xcodebuild", "codesign", "xcrun", "hdiutil", "ditto", "spctl", ...(options.upload ? ["gh"] : [])])
      if (!Bun.which(tool)) throw new Error(`Required release tool missing: ${tool}`);
  }
  // One Bun for every release executable: this process compiles the daemon in the DMG, CI compiles the CLI assets, both from .bun-version.
  let bunVersion: string | undefined;
  try { bunVersion = parseBunVersion(read(["git", "show", `${commit}:.bun-version`])); }
  catch (error) { if (!dry) throw new Error(`${tag} has no valid .bun-version: ${(error as Error).message}`); }
  if (dry) console.log(`[dry-run] Require Bun ${bunVersion ?? "<the commit's .bun-version>"} for every compile (this Bun: ${Bun.version})${bunVersion && bunVersion !== Bun.version ? "; NOTE: they differ, a real run stops here" : ""}`);
  else if (Bun.version !== bunVersion) throw new Error(`This Bun is ${Bun.version} but ${tag} pins Bun ${bunVersion} in .bun-version; run the release with that Bun`);
  const work = dry ? "$BUILD" : mkdtempSync(join(tmpdir(), "iamceo-release-"));
  const source = join(work, "source");
  const app = join(source, "dist", "native", "IAMCEO.app");
  const core = join(app, "Contents", "Resources", "runtime", "Herdr Core.app");
  const daemon = join(app, "Contents", "Resources", "runtime", "iamceo");
  const dmg = join(work, dmgName);
  const entitlements = join(work, "bun-entitlements.plist");
  const identity = dry ? "$SIGN_IDENTITY" : env.SIGN_IDENTITY!;
  function run(command: string[], cwd = source, allowFailure = false, childEnv?: Record<string, string | undefined>): void {
    // Redact API credentials even in the printed command, and never read the keychain in dry-run.
    const display = command.map((part, i) => ["--key", "--key-id", "--issuer"].includes(command[i - 1]) ? `<${command[i - 1].slice(2)} from env>` : part);
    console.log(`${dry ? "[dry-run] " : ""}${quote(display)}`);
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
    console.log("Bun daemon only: allow-jit + allow-unsigned-executable-memory; no DYLD, library-validation or page-protection exceptions. The daemon inside the notarized DMG is served before anything is uploaded.");
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
    // The user's path: the daemon inside the notarized DMG must start, serve and report its own build ID before any upload.
    const mount = join(work, "mount");
    if (!dry) mkdirSync(mount);
    run(["hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, dmg]);
    try {
      const inside = join(mount, "IAMCEO.app", "Contents", "Resources", "runtime", "iamceo");
      if (dry) {
        console.log(`[dry-run] Serve ${inside} as launchd does (IAMCEO_LOG_WRITER=1) in an isolated home, port 0, fake CLIs; require /api/readiness ok with the file's SHA-256 as build ID and version ${pkg.version}, an authenticated /api/bootstrap, and exit 0 on SIGTERM`);
      } else {
        const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
        if (sha(inside) !== sha(daemon)) throw new Error("The DMG does not carry the signed daemon");
        const smoke = await smokeDaemon({ daemon: inside, version: pkg.version, scratch: work });
        console.log(`Daemon inside the DMG:\n${describeSmoke(smoke.rows)}`);
        if (!smoke.ok) throw new Error("The daemon inside the notarized DMG did not start and report ready; nothing was uploaded");
      }
    } finally {
      if (dry) run(["hdiutil", "detach", mount]);
      else if (Bun.spawnSync(["hdiutil", "detach", mount], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode !== 0) run(["hdiutil", "detach", "-force", mount], root, true);
    }
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
    if (options.publish) {
      run(["gh", "release", "edit", tag, "--repo", "yehsung/IAMCEO", "--draft=false", "--latest"]);
      try { pushTap(dry ? null : readFileSync(join(out, "iamceo.rb"), "utf8")); }
      catch (error) { throw new Error(`${tag} is public, but the Homebrew tap was not updated (${(error as Error).message}). Retry only that step: bun scripts/release-mac.ts --ref ${tag} --tap-only`); }
    }
  } finally {
    if (!dry) rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { await releaseMac(parseReleaseOptions(process.argv.slice(2))); }
  catch (error) { console.error(`Mac release failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
