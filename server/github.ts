import { lstat, rm } from "node:fs/promises";
import { Folders, folderName } from "./folders.ts";
import { ApiError } from "./store.ts";

export function githubRepo(input: string): string {
  const match = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/.exec(input);
  if (!match || match[0] !== input) throw new ApiError(400, "GitHub의 owner/name 또는 HTTPS 저장소 주소를 입력하세요");
  const name = match[2]!.replace(/\.git$/, "");
  if (!name || name === "." || name === "..") throw new ApiError(400, "저장소 이름이 잘못되었습니다");
  return `${match[1]}/${name}`;
}
interface Repo { nameWithOwner: string; description: string | null; visibility: string; updatedAt: string; url: string }
type Listing = { available: boolean; reason?: string; repos: Repo[] };
type Job = { status: "running" | "done" | "failed"; path?: string; error?: string };

export class GitHub {
  private readonly jobs = new Map<string, Job>();
  private active = 0;
  private cache?: { until: number; value: Listing };
  private listing?: Promise<Listing>;
  constructor(private readonly folders: Folders, private readonly env = { ...process.env }, private readonly timeout = 600_000) {}
  private executable(name: "gh" | "git"): string | null {
    const found = Bun.which(name, { PATH: this.env.PATH ?? "" });
    if (found) return found;
    // launchd's default PATH often omits Homebrew. Tests only see their fake PATH.
    if (!this.env.IAMCEO_TEST) return Bun.which(name === "gh" ? "/opt/homebrew/bin/gh" : "/usr/bin/git");
    return null;
  }
  private async run(args: string[], capture = false, timeout = 15_000): Promise<string> {
    const child = Bun.spawn(args, { env: { ...this.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" }, stdin: "ignore", stdout: capture ? "pipe" : "ignore", stderr: "ignore", detached: true });
    let timedOut = false;
    const killGroup = () => {
      // gh spawns git. Stop the whole job before cleaning its reserved directory.
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeout);
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
      if (timedOut || code !== 0) throw new Error("command failed");
      return output;
    } finally { clearTimeout(timer); }
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
    if (this.active >= 3) throw new ApiError(429, "동시에 3개까지 가져올 수 있습니다. 잠시 뒤 다시 시도하세요");
    const gh = this.executable("gh"), git = gh ? null : this.executable("git");
    if (!gh && !git) throw new ApiError(503, "서버에 GitHub CLI 또는 git이 필요합니다");
    // Reserve before spawning. Neither a second request nor git can overwrite an existing folder.
    this.active++;
    let path: string;
    let identity;
    try { path = (await this.folders.create(parent, name)).path; identity = await lstat(path); }
    catch (error) { this.active--; throw error; }
    const jobId = crypto.randomUUID();
    const job: Job = { status: "running" }; this.jobs.set(jobId, job);
    const args = gh ? [gh, "repo", "clone", repo, path] : [git!, "clone", `https://github.com/${repo}.git`, path];
    void (async () => {
      try {
        await this.run(args, false, this.timeout);
        if (!(await this.folders.stillOwned(path, identity))) throw new Error("target changed");
        job.path = path; job.status = "done";
      } catch {
        if (await this.folders.stillOwned(path, identity)) await rm(path, { recursive: true, force: true }).catch(() => {});
        // Never return command output: it may contain credentials or private remote URLs.
        job.error = "저장소를 가져오지 못했습니다. 주소와 GitHub 접근 권한을 확인하세요";
        job.status = "failed";
      } finally { this.active--; }
    })();
    return { jobId };
  }
  job(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new ApiError(404, "가져오기 작업을 찾을 수 없습니다");
    return { ...job };
  }
}
