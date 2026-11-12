import { lstat, mkdir, mkdtemp, opendir, realpath, rename, rm, rmdir, statfs } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Folders, folderName } from "./folders.ts";
import { ApiError } from "./store.ts";

export function githubRepo(input: string): string {
  const match = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/.exec(input);
  if (!match || match[0] !== input) throw new ApiError(400, "GitHub의 owner/name 또는 HTTPS 저장소 주소를 입력하세요", "github_repo_invalid");
  const name = match[2]!.replace(/\.git$/, "");
  if (!name || name === "." || name === "..") throw new ApiError(400, "저장소 이름이 잘못되었습니다", "github_repo_name_invalid");
  return `${match[1]}/${name}`;
}
interface Repo { nameWithOwner: string; description: string | null; visibility: string; updatedAt: string; url: string }
type Listing = { available: boolean; reason?: string; repos: Repo[] };
type Job = { status: "running" | "done" | "failed"; path?: string; error?: string };
type Stage = { path: string; identity: Stats; parent: string; local: boolean };
const LIMIT = 2 * 1024 ** 3, MIN_FREE = 5 * 1024 ** 3;
const TOO_LARGE = "저장소가 너무 큽니다(2GB 초과)";
const CROSS_DEVICE = "같은 파일시스템으로 옮길 수 없습니다. 대상 폴더의 볼륨을 확인하세요";
interface CloneOptions {
  stateHome?: string;
  freeBytes?: (path: string) => Promise<number>;
  sizeBytes?: (path: string) => Promise<number>;
  publishRename?: typeof rename;
  beforePublish?: (path: string) => Promise<void>;
  beforeCleanup?: (path: string) => Promise<void>;
  now?: () => number;
  monitorMs?: number;
}

/** Inherit authentication/PATH, but never inherit Git command, config or trace controls. */
export function githubEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !/^(GIT_|GCM_|SSH_ASKPASS|GITHUB_HOST|GH_HOST|GH_REPO|GH_BROWSER|BROWSER)/i.test(key))),
    GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" };
}
async function stageBytes(path: string): Promise<number> {
  let bytes = 0;
  async function visit(path: string): Promise<void> {
    let item;
    try { item = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    bytes += item.size;
    if (bytes > LIMIT || !item.isDirectory() || item.isSymbolicLink()) return;
    let dir;
    try { dir = await opendir(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    try {
      while (bytes <= LIMIT) {
        const entry = await dir.read();
        if (!entry) break;
        await visit(join(path, entry.name));
      }
    } finally { await dir.close(); }
  }
  await visit(path);
  return bytes;
}

export class GitHub {
  private readonly jobs = new Map<string, Job & { finishedAt?: number }>();
  private readonly targets = new Set<string>();
  private expiry?: ReturnType<typeof setTimeout>;
  private active = 0;
  private cache?: { until: number; value: Listing };
  private listing?: Promise<Listing>;
  constructor(private readonly folders: Folders, private readonly env = { ...process.env }, private readonly timeout = 600_000, private readonly options: CloneOptions = {}) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private prune(): void {
    clearTimeout(this.expiry);
    const terminal = [...this.jobs].filter(([, job]) => job.finishedAt !== undefined)
      .sort((a, b) => a[1].finishedAt! - b[1].finishedAt!);
    for (const [index, [id, job]] of terminal.entries()) {
      if (this.now() - job.finishedAt! >= 3_600_000 || index < terminal.length - 50) this.jobs.delete(id);
    }
    const oldest = terminal.find(([id]) => this.jobs.has(id))?.[1];
    if (oldest) {
      this.expiry = setTimeout(() => this.prune(), Math.max(1, oldest.finishedAt! + 3_600_000 - this.now()));
      this.expiry.unref();
    }
  }
  private async freeSpace(path: string): Promise<void> {
    const bytes = this.options.freeBytes ? await this.options.freeBytes(path) : await statfs(path).then(s => s.bavail * s.bsize);
    if (bytes < MIN_FREE) throw new ApiError(403, "디스크 여유 공간이 부족합니다(5GB 필요)", "disk_space_low");
  }
  private async absent(path: string): Promise<void> {
    try { await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    throw new ApiError(409, "같은 이름의 폴더가 있습니다", "folder_exists");
  }
  private async stagingRoot(): Promise<string> {
    const home = this.options.stateHome ?? this.env.IAMCEO_HOME ?? process.env.IAMCEO_HOME ?? join(homedir(), ".iamceo");
    const canonical = await realpath(home);
    const root = join(canonical, "clone-staging");
    await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const item = await lstat(root);
    if (!item.isDirectory() || item.isSymbolicLink() || (item.mode & 0o077) || await realpath(root) !== root) throw new ApiError(403, "스테이징 폴더를 사용할 수 없습니다", "clone_staging_unavailable");
    return root;
  }
  private async makeStage(parent: string, name: string, local: boolean): Promise<Stage> {
    const path = join(parent, name);
    await mkdir(path, { mode: 0o700 });
    const identity = await lstat(path);
    const stage = { path, identity, parent, local };
    if (!await this.owned(stage)) throw new ApiError(403, "스테이징 폴더가 변경되었습니다", "clone_staging_unavailable");
    return stage;
  }
  private async owned(stage: Stage): Promise<boolean> {
    try {
      const current = await lstat(stage.path);
      return current.isDirectory() && !current.isSymbolicLink() && !(current.mode & 0o077) &&
        current.dev === stage.identity.dev && current.ino === stage.identity.ino &&
        await realpath(stage.path) === stage.path && await realpath(stage.parent) === stage.parent &&
        (!stage.local || await this.folders.directory(stage.parent) === stage.parent);
    } catch { return false; }
  }
  private async cleanup(stage: Stage): Promise<void> {
    if (!await this.owned(stage)) return;
    // Quarantine first, then check the moved identity. A swap after the initial
    // check can never authorize deletion of the replacement directory.
    const quarantine = await mkdtemp(join(stage.parent, ".iamceo-cleanup-"));
    try {
      if (await realpath(quarantine) !== quarantine || (await lstat(quarantine)).isSymbolicLink()) return;
      await this.options.beforeCleanup?.(stage.path);
      const moved = join(quarantine, "stage");
      await rename(stage.path, moved);
      if (!await this.owned({ ...stage, path: moved, parent: quarantine })) return;
      await rm(moved, { recursive: true, force: true });
    } finally { await rmdir(quarantine).catch(() => {}); }
  }
  private executable(name: "gh" | "git"): string | null {
    const found = Bun.which(name, { PATH: this.env.PATH ?? "" });
    if (found) return found;
    // launchd's default PATH often omits Homebrew. Tests only see their fake PATH.
    if (!this.env.IAMCEO_TEST) return Bun.which(name === "gh" ? "/opt/homebrew/bin/gh" : "/usr/bin/git");
    return null;
  }
  private async run(args: string[], capture = false, timeout = 15_000, stage?: Stage): Promise<string> {
    if (stage && !await this.owned(stage)) throw new Error("stage changed");
    const child = Bun.spawn(args, { env: githubEnvironment(this.env), cwd: stage?.path, stdin: "ignore", stdout: capture ? "pipe" : "ignore", stderr: "ignore", detached: true });
    let timedOut = false, monitorError: Error | undefined;
    let checking: Promise<void> | undefined;
    const killGroup = () => {
      // gh spawns git. Stop the whole job before cleaning its reserved directory.
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeout);
    const check = async () => {
      if (!stage) return;
      if (!await this.owned(stage)) throw new Error("stage changed");
      if (await (this.options.sizeBytes ?? stageBytes)(stage.path) > LIMIT) throw new Error(TOO_LARGE);
    };
    const monitor = stage ? setInterval(() => {
      if (checking) return;
      checking = check().catch(error => { monitorError = error; killGroup(); }).finally(() => { checking = undefined; });
    }, this.options.monitorMs ?? 2000) : undefined;
    try {
      const read = async () => {
        if (!capture) return "";
        const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) {
          const item = await reader.read(); if (item.done) break;
          size += item.value.length;
          if (size > 2_000_000) { killGroup(); await child.exited; throw new Error("output limit"); }
          chunks.push(item.value);
        }
        return Buffer.concat(chunks).toString("utf8");
      };
      const [output, code] = await Promise.all([read(), child.exited]);
      await checking;
      if (monitorError) throw monitorError;
      if (timedOut || code !== 0) throw new Error("command failed");
      await check();
      if (timedOut) throw new Error("command failed");
      return output;
    } catch (error) {
      killGroup();
      await child.exited;
      throw error;
    } finally { clearTimeout(timer); clearInterval(monitor); await checking; }
  }
  private async load(): Promise<Listing> {
    const gh = this.executable("gh");
    if (!gh) return { available: false, reason: "GitHub CLI(gh)가 설치되지 않았습니다", repos: [] };
    try {
      await this.run([gh, "auth", "status"]);
    } catch { return { available: false, reason: "GitHub CLI(gh)로 로그인해 주세요", repos: [] }; }
    try {
      const raw: unknown = JSON.parse(await this.run([gh, "repo", "list", "--limit", "100", "--json", "nameWithOwner,description,visibility,updatedAt,url"], true));
      if (!Array.isArray(raw)) throw new Error("invalid list");
      const repos = raw.filter((r): r is Repo => r && typeof r.nameWithOwner === "string" && typeof r.updatedAt === "string" && typeof r.visibility === "string" && typeof r.url === "string" && (r.description === null || typeof r.description === "string"));
      repos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { available: true, repos };
    } catch { return { available: false, reason: "저장소 목록을 불러올 수 없습니다", repos: [] }; }
  }
  async repos(query = ""): Promise<Listing> {
    if (!this.cache || Date.now() >= this.cache.until) {
      this.listing ??= this.load().then(value => { this.cache = { until: Date.now() + 60_000, value }; return value; }).finally(() => { this.listing = undefined; });
      await this.listing;
    }
    const value = this.cache!.value;
    return { ...value, repos: value.repos.filter(r => r.nameWithOwner.toLocaleLowerCase().includes(query.toLocaleLowerCase())) };
  }
  async clone(input: { repo: string; parent: string; name?: string }): Promise<{ jobId: string }> {
    const repo = githubRepo(input.repo), name = folderName(input.name ?? repo.split("/")[1]!);
    const parent = await this.folders.directory(input.parent);
    if (this.active >= 3) throw new ApiError(429, "동시에 3개까지 가져올 수 있습니다. 잠시 뒤 다시 시도하세요", "clone_limit");
    const gh = this.executable("gh"), git = gh ? null : this.executable("git");
    if (!gh && !git) throw new ApiError(503, "서버에 GitHub CLI 또는 git이 필요합니다", "github_cli_missing");
    const path = join(parent, name);
    if (this.targets.has(path)) throw new ApiError(409, "같은 이름의 폴더가 있습니다", "folder_exists");
    this.prune();
    this.active++; this.targets.add(path);
    const jobId = crypto.randomUUID();
    let stage: Stage;
    try {
      await this.absent(path);
      const root = await this.stagingRoot();
      await this.freeSpace(root);
      stage = await this.makeStage(root, jobId, false);
    } catch (error) { this.active--; this.targets.delete(path); throw error; }
    const job: Job & { finishedAt?: number } = { status: "running" }; this.jobs.set(jobId, job);
    const flags = ["-c", "protocol.file.allow=never", "-c", "core.hooksPath=/dev/null"];
    const args = gh ? [gh, "repo", "clone", repo, ".", "--", ...flags] : [git!, ...flags, "clone", `https://github.com/${repo}.git`, "."];
    const publish = async () => {
      await this.options.beforePublish?.(stage.path);
      if (!await this.owned(stage) || await this.folders.directory(parent) !== parent) throw new Error("target changed");
      await this.absent(path);
      await (this.options.publishRename ?? rename)(stage.path, path);
    };
    void (async () => {
      try {
        await this.run(args, false, this.timeout, stage);
        try { await publish(); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await this.cleanup(stage);
          if (await this.folders.directory(parent) !== parent) throw new Error("parent changed");
          await this.absent(path);
          await this.freeSpace(parent);
          stage = await this.makeStage(parent, `.iamceo-clone-${jobId}`, true);
          await this.run(args, false, this.timeout, stage);
          try { await publish(); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "EXDEV") throw new Error(CROSS_DEVICE); throw error; }
        }
        job.path = path; job.status = "done";
      } catch (error) {
        await this.cleanup(stage).catch(() => {});
        // Only fixed messages are exposed, never command output or arbitrary errors.
        const message = error instanceof Error ? error.message : "";
        job.error = [TOO_LARGE, CROSS_DEVICE].includes(message) ? message : "저장소를 가져오지 못했습니다. 주소와 GitHub 접근 권한을 확인하세요";
        job.status = "failed";
      } finally {
        this.active--; this.targets.delete(path); job.finishedAt = this.now(); this.prune();
      }
    })();
    return { jobId };
  }
  job(id: string): Job {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) throw new ApiError(404, "가져오기 작업을 찾을 수 없습니다", "clone_job_not_found");
    const { finishedAt, ...result } = job;
    return result;
  }
}
