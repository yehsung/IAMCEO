/** Install the reviewed core release locally. Never touches an existing global Herdr installation. */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import lock from "../vendor/herdr-core/release-lock.json";

const root = resolve(import.meta.dir, "..");
const target = `${process.platform === "darwin" ? "macos" : process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}`;
if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("This setup supports macOS and Linux. Windows packaging is planned.");
const release = (lock.targets as Record<string, { url: string; sha256: string }>)[target];
if (!release) throw new Error(`No pinned core build for ${target}`);
const destination = join(root, ".runtime", "herdr-core", lock.version);
const executableAt = (base: string) => process.platform === "darwin" && existsSync(join(base, "Herdr Core.app", "Contents", "MacOS", "herdr-core"))
  ? join(base, "Herdr Core.app", "Contents", "MacOS", "herdr-core") : join(base, "herdr-core");
if (existsSync(join(destination, "verified.json")) && existsSync(executableAt(destination))) {
  const verified = JSON.parse(readFileSync(join(destination, "verified.json"), "utf8"));
  if (verified.sha256 !== release.sha256 || verified.target !== target) throw new Error("Existing core installation differs from the pinned release; refusing to overwrite it.");
  const currentHash = createHash("sha256").update(readFileSync(executableAt(destination))).digest("hex");
  if (verified.binarySha256 !== currentHash) throw new Error("Installed core binary changed; refusing to run it. Remove only this local runtime directory and run setup again.");
  console.log(`herdr-core ${lock.version} ready: ${executableAt(destination)}`);
  process.exit(0);
}
if (existsSync(destination)) throw new Error(`Incomplete local installation: ${destination}. Inspect and remove it before retrying.`);
const scratch = mkdtempSync(join(tmpdir(), "iamceo-core-download-"));
try {
  console.log(`Downloading pinned herdr-core ${lock.version} (${target})…`);
  const response = await fetch(release.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== release.sha256) throw new Error("herdr-core archive checksum mismatch");
  const archive = join(scratch, "core.tar.gz");
  writeFileSync(archive, bytes);
  const listed = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe", stderr: "pipe" });
  if (listed.exitCode !== 0) throw new Error("Cannot inspect core archive");
  const names = listed.stdout.toString().trim().split("\n");
  if (names.some(n => n.startsWith("/") || n.split("/").includes(".."))) throw new Error("Unsafe path in core archive");
  // The archive hash is pinned in the repository, not trusted from a mutable remote manifest.
  const stage = join(scratch, "stage"); mkdirSync(stage);
  const unpack = Bun.spawnSync(["tar", "-xzf", archive, "-C", stage], { stdout: "pipe", stderr: "pipe" });
  if (unpack.exitCode !== 0) throw new Error(unpack.stderr.toString());
  for (const file of ["LICENSE", "THIRD-PARTY-NOTICES", "herdr-core"]) if (!existsSync(join(stage, file))) throw new Error(`Archive missing ${file}`);
  const executable = executableAt(stage); chmodSync(executable, 0o755);
  if (process.platform === "darwin" && executable.includes("Herdr Core.app/")) {
    const signing = Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", "-R", '=identifier "dev.herdr.core" and anchor apple generic and certificate leaf[subject.OU] = "2W9652Q7QR"', join(stage, "Herdr Core.app")], { stdout: "pipe", stderr: "pipe" });
    if (signing.exitCode !== 0) throw new Error(`Core signature verification failed: ${signing.stderr}`);
  }
  const version = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  if (version.exitCode !== 0 || !version.stdout.toString().includes(lock.version)) throw new Error("Downloaded core version check failed");
  writeFileSync(join(stage, "verified.json"), JSON.stringify({ version: lock.version, target, sha256: release.sha256, binarySha256: createHash("sha256").update(readFileSync(executable)).digest("hex"), installedAt: new Date().toISOString() }, null, 2));
  mkdirSync(resolve(destination, ".."), { recursive: true });
  // Copy into same-filesystem staging, then publish atomically. Do not start a core here.
  const staging = `${destination}.install-${process.pid}`;
  const { cpSync } = await import("node:fs");
  try { cpSync(stage, staging, { recursive: true, dereference: false }); renameSync(staging, destination); }
  finally { rmSync(staging, { recursive: true, force: true }); }
  console.log(`Installed: ${executableAt(destination)}\nNo running sessions or global CLI settings were changed.`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
