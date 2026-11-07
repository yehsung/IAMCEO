import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Folders } from "../server/folders.ts";
import { GitHub, githubRepo } from "../server/github.ts";
import { folderFixture } from "./folder-fixture.ts";

const bin = mkdtempSync("/private/tmp/iamceo-fake-github-");
function executable(name: string, script: string, directory = bin) {
  const path = join(directory, name); writeFileSync(path, "#!/bin/sh\n" + script); chmodSync(path, 0o755);
}
executable("gh", `if [ "$1" = auth ]; then exit 0; fi
if [ "$2" = list ]; then
printf '%s' '[{"nameWithOwner":"owner/old","description":"old","visibility":"PRIVATE","updatedAt":"2025-01-01","url":"https://github.com/owner/old"},{"nameWithOwner":"owner/new","description":"new","visibility":"PUBLIC","updatedAt":"2026-01-01","url":"https://github.com/owner/new"}]'
exit 0
fi
printf '%s\\n' "$@" > "$4/arguments"
printf '%s' "$GIT_TERMINAL_PROMPT" > "$4/prompt"
if [ "$3" = owner/fail ]; then printf secret > "$4/partial"; printf 'ghp_SECRET https://user:password@github.com' >&2; exit 1; fi
/bin/sleep 0.15
printf full > "$4/content"
`);
let f: Awaited<ReturnType<typeof folderFixture>>;
beforeAll(async () => { f = await folderFixture(bin); });
afterAll(async () => { await f.close(); });
async function finish(jobId: string) {
  for (let n = 0; n < 100; n++) {
    const response = await f.request("/api/github/clone/" + jobId);
    const job = await response.json(); if (job.status !== "running") return job;
    await Bun.sleep(20);
  }
  throw new Error("job did not finish");
}
test("repository formats are strictly validated", () => {
  for (const input of ["owner/name", "https://github.com/owner/name", "https://github.com/owner/name.git"]) expect(githubRepo(input)).toBe("owner/name");
  for (const input of ["https://evil.com/owner/name", "http://github.com/owner/name", "-option/repo", "owner/has space", "../repo", "owner/../repo", "owner/name?x=y", "https://u:p@github.com/a/b", "owner/name\n"]) expect(() => githubRepo(input)).toThrow();
});
test("list sorts newest first, filters and caches for 60 seconds", async () => {
  const list = await (await f.request("/api/github/repos")).json();
  expect(list.available).toBe(true); expect(list.repos.map((r: { nameWithOwner: string }) => r.nameWithOwner)).toEqual(["owner/new", "owner/old"]);
  const filtered = await (await f.request("/api/github/repos?query=NEW")).json(); expect(filtered.repos.length).toBe(1);
  const gh = new GitHub(new Folders(f.home), { PATH: bin, IAMCEO_TEST: "1" });
  await gh.repos();
  const script = readFileSync(join(bin, "gh"), "utf8"); executable("gh", "exit 1");
  try { expect((await gh.repos()).available).toBe(true); } finally { writeFileSync(join(bin, "gh"), script); }
});
test("missing gh and logged out gh return availability without credentials", async () => {
  const empty = mkdtempSync("/private/tmp/iamceo-no-gh-");
  expect((await new GitHub(new Folders(f.home), { PATH: empty, IAMCEO_TEST: "1" }).repos()).available).toBe(false);
  executable("gh", "printf ghp_SECRET >&2; exit 1", empty);
  const result = await new GitHub(new Folders(f.home), { PATH: empty, IAMCEO_TEST: "1" }).repos();
  expect(result.available).toBe(false); expect(result.reason).not.toContain("SECRET");
});
test("clone is async, full clone arguments, no interactive credentials", async () => {
  const response = await f.request("/api/github/clone", { repo: "https://github.com/owner/new.git", parent: f.home });
  expect(response.status).toBe(202); const { jobId } = await response.json();
  expect((await (await f.request("/api/github/clone/" + jobId)).json()).status).toBe("running");
  const job = await finish(jobId); expect(job.status).toBe("done"); expect(job.path).toBe(join(f.home, "new"));
  expect(readFileSync(join(job.path, "arguments"), "utf8").trim().split("\n")).toEqual(["repo", "clone", "owner/new", ".", "--", "-c", "protocol.file.allow=never", "-c", "core.hooksPath=/dev/null"]);
  expect(readFileSync(join(job.path, "prompt"), "utf8")).toBe("0");
});
test("failure removes only reserved target and hides credentials", async () => {
  mkdirSync(join(f.home, "keep"));
  const { jobId } = await (await f.request("/api/github/clone", { repo: "owner/fail", parent: f.home })).json();
  const job = await finish(jobId); expect(job.status).toBe("failed"); expect(job.error).not.toContain("SECRET"); expect(job.error).not.toContain("password");
  expect(existsSync(join(f.home, "fail"))).toBe(false); expect(existsSync(join(f.home, "keep"))).toBe(true);
});
test("duplicate, invalid repo/name and outside parent are refused", async () => {
  mkdirSync(join(f.home, "existing"));
  expect((await f.request("/api/github/clone", { repo: "owner/existing", parent: f.home })).status).toBe(409);
  expect((await f.request("/api/github/clone", { repo: "owner/valid", parent: f.root })).status).toBe(403);
  for (const repo of ["-x/y", "https://evil.com/o/r", "o/a b", "../repo"]) expect((await f.request("/api/github/clone", { repo, parent: f.home })).status).toBe(400);
  expect((await f.request("/api/github/clone", { repo: "o/r", parent: f.home, name: "../x" })).status).toBe(400);
  expect((await f.request("/api/github/repos", undefined, false)).status).toBe(401);
  expect((await f.request("/api/github/clone", { repo: "o/r", parent: f.home }, false)).status).toBe(401);
  expect((await f.request("/api/github/clone/unknown")).status).toBe(404);
});
test("git fallback uses argument array and timed out jobs clean up", async () => {
  const onlyGit = mkdtempSync("/private/tmp/iamceo-only-git-");
  executable("git", 'printf "%s\\n" "$@" > "./args"', onlyGit);
  const service = new GitHub(new Folders(f.home), { PATH: onlyGit, IAMCEO_TEST: "1" });
  const { jobId } = await service.clone({ repo: "owner/fallback", parent: f.home });
  for (let n = 0; n < 100 && service.job(jobId).status === "running"; n++) await Bun.sleep(10);
  expect(service.job(jobId).status).toBe("done");
  expect(readFileSync(join(f.home, "fallback/args"), "utf8").trim().split("\n")).toEqual(["-c", "protocol.file.allow=never", "-c", "core.hooksPath=/dev/null", "clone", "https://github.com/owner/fallback.git", "."]);
  executable("git", 'exec /bin/sleep 10', onlyGit);
  const slow = new GitHub(new Folders(f.home), { PATH: onlyGit, IAMCEO_TEST: "1" }, 25);
  const job = await slow.clone({ repo: "owner/timeout", parent: f.home });
  for (let n = 0; n < 100 && slow.job(job.jobId).status === "running"; n++) await Bun.sleep(10);
  expect(slow.job(job.jobId).status).toBe("failed"); expect(existsSync(join(f.home, "timeout"))).toBe(false);
});
test("only three concurrent clones may run", async () => {
  const jobs = await Promise.all(["one", "two", "three"].map(name => f.request("/api/github/clone", { repo: "owner/" + name, parent: f.home }).then(r => r.json())));
  expect((await f.request("/api/github/clone", { repo: "owner/four", parent: f.home })).status).toBe(429);
  for (const job of jobs) expect((await finish(job.jobId)).status).toBe("done");
});
test("timeout kills git descendants before cleaning the target", async () => {
  const tools = mkdtempSync("/private/tmp/iamceo-forked-git-");
  executable("git", '(/bin/sleep 0.2; printf leaked > "./late") &\nwait', tools);
  const service = new GitHub(new Folders(f.home), { PATH: tools, IAMCEO_TEST: "1" }, 25);
  const { jobId } = await service.clone({ repo: "owner/descendant", parent: f.home });
  for (let n = 0; n < 100 && service.job(jobId).status === "running"; n++) await Bun.sleep(10);
  expect(service.job(jobId).status).toBe("failed");
  await Bun.sleep(300);
  expect(existsSync(join(f.home, "descendant"))).toBe(false);
});
