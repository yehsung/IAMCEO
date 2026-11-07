import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rename } from "node:fs/promises";
import { Folders } from "../server/folders.ts";
import { GitHub, githubEnvironment } from "../server/github.ts";

function fixture(script = 'printf cloned > content') {
  const root = mkdtempSync("/private/tmp/iamceo-clone-security-");
  const home = join(root, "home"), stateHome = join(root, "state"), bin = join(root, "bin"), outside = join(root, "outside");
  for (const path of [home, stateHome, bin, outside]) mkdirSync(path);
  const git = join(bin, "git"); writeFileSync(git, "#!/bin/sh\n" + script); chmodSync(git, 0o755);
  const folders = new Folders(home);
  const env = { PATH: bin, IAMCEO_TEST: "1", IAMCEO_HOME: stateHome };
  return { root, home, stateHome, bin, outside, folders, env };
}
async function finish(service: GitHub, id: string) {
  for (let n = 0; n < 500; n++) {
    const result = service.job(id);
    if (result.status !== "running") return result;
    await Bun.sleep(5);
  }
  throw new Error("job did not finish");
}
async function waitFor(path: string) {
  for (let n = 0; n < 500; n++) { if (existsSync(path)) return; await Bun.sleep(5); }
  throw new Error("signal did not arrive");
}
const freeBytes = async () => 20 * 1024 ** 3;

// F1 + S2: deterministic swaps on both sides of mkdir, only empty rmdir on rejection.
test("folder mkdir rechecks parent after a pre-mkdir symlink swap and removes only its empty item", async () => {
  const f = fixture(), parent = join(f.home, "parent"); mkdirSync(parent);
  writeFileSync(join(f.outside, "keep"), "keep");
  const folders = new Folders(f.home, { beforeMkdir: async () => {
    renameSync(parent, join(f.home, "original")); symlinkSync(f.outside, parent);
  } });
  await expect(folders.create(parent, "new")).rejects.toMatchObject({ status: 403 });
  expect(existsSync(join(f.outside, "new"))).toBe(false);
  expect(readFileSync(join(f.outside, "keep"), "utf8")).toBe("keep");
});
test("folder mkdir rejects post-mkdir child symlinks and parent swaps without recursive cleanup", async () => {
  for (const childSwap of [true, false]) {
    const f = fixture(), parent = join(f.home, "parent"); mkdirSync(parent);
    const folders = new Folders(f.home, { afterMkdir: async () => {
      if (childSwap) {
        renameSync(join(parent, "new"), join(parent, "original"));
        symlinkSync(f.outside, join(parent, "new"));
      } else {
        renameSync(parent, join(f.home, "original")); symlinkSync(f.outside, parent);
        mkdirSync(join(f.outside, "new")); writeFileSync(join(f.outside, "new/keep"), "keep");
      }
    } });
    await expect(folders.create(parent, "new")).rejects.toMatchObject({ status: 403 });
    expect(childSwap ? lstatSync(join(parent, "new")).isSymbolicLink() : existsSync(join(f.outside, "new/keep"))).toBe(true);
  }
});
test("folder mkdir mode never exceeds 0755 even with umask zero", async () => {
  const f = fixture(), previous = process.umask(0);
  try {
    const { path } = await f.folders.create(f.home, "mode");
    expect(lstatSync(path).mode & 0o777).toBe(0o755);
  } finally { process.umask(previous); }
});

// S3: count all enumerated entries, including those that cannot be returned.
test("folder enumeration reads at most 2000 entries even when all entries are hidden files", async () => {
  const f = fixture();
  for (let n = 0; n < 2005; n++) writeFileSync(join(f.home, `.hidden-${n}`), "");
  let reads = 0;
  const folders = new Folders(f.home, { onEntry: () => { reads++; } });
  const listing = await folders.list();
  expect(reads).toBe(2000); expect(listing.entries).toEqual([]); expect(listing.truncated).toBe(true);
});

// F2: git works in server staging while the user parent is replaced.
test("clone parent swap during download never writes outside or cleans the user target", async () => {
  const f = fixture(); const parent = join(f.home, "parent"), saved = join(f.home, "saved"); mkdirSync(parent);
  const signal = join(f.root, "started"), proceed = join(f.root, "proceed");
  const git = join(f.bin, "git");
  writeFileSync(git, `#!/bin/sh\nprintf started > '${signal}'\nwhile [ ! -f '${proceed}' ]; do /bin/sleep 0.01; done\nprintf probe > probe\n`);
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes });
  const { jobId } = await service.clone({ repo: "owner/swap", parent });
  await waitFor(signal);
  expect(lstatSync(join(f.stateHome, "clone-staging", jobId)).mode & 0o777).toBe(0o700);
  expect(existsSync(join(parent, "swap"))).toBe(false);
  renameSync(parent, saved); symlinkSync(f.outside, parent);
  writeFileSync(join(f.outside, "keep"), "keep"); writeFileSync(proceed, "go");
  expect((await finish(service, jobId)).status).toBe("failed");
  expect(readdirSync(f.outside)).toEqual(["keep"]);
  expect(existsSync(join(f.stateHome, "clone-staging", jobId))).toBe(false);
});
test("a target created while cloning is never overwritten or deleted", async () => {
  const f = fixture(); const target = join(f.home, "repo");
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes, beforePublish: async () => {
    mkdirSync(target); writeFileSync(join(target, "keep"), "keep");
  } });
  const { jobId } = await service.clone({ repo: "owner/repo", parent: f.home });
  expect((await finish(service, jobId)).status).toBe("failed");
  expect(readdirSync(target)).toEqual(["keep"]);
  expect(readdirSync(join(f.stateHome, "clone-staging"))).toEqual([]);
});

// F3: swap after the ownership check, before cleanup's atomic quarantine move.
test("cleanup verifies quarantined inode and preserves a replacement user directory", async () => {
  const f = fixture("printf partial > partial; exit 1");
  const victim = join(f.home, "victim"); mkdirSync(victim); writeFileSync(join(victim, "keep"), "keep");
  let movedVictim = "";
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes, beforeCleanup: async path => {
    renameSync(path, path + "-original"); renameSync(victim, path); movedVictim = path;
  } });
  const { jobId } = await service.clone({ repo: "owner/fail", parent: f.home });
  expect((await finish(service, jobId)).status).toBe("failed");
  const root = join(f.stateHome, "clone-staging");
  const quarantine = readdirSync(root).find(name => name.startsWith(".iamceo-cleanup-"))!;
  expect(readFileSync(join(root, quarantine, "stage/keep"), "utf8")).toBe("keep");
  expect(readFileSync(movedVictim + "-original/partial", "utf8")).toBe("partial");
});
test("cleanup refuses a staging symlink replacement", async () => {
  const f = fixture(); let original = "";
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes, beforePublish: async path => {
    original = path + "-original"; renameSync(path, original); symlinkSync(f.outside, path);
    writeFileSync(join(f.outside, "keep"), "keep");
  } });
  const { jobId } = await service.clone({ repo: "owner/symlink", parent: f.home });
  expect((await finish(service, jobId)).status).toBe("failed");
  expect(readFileSync(join(f.outside, "keep"), "utf8")).toBe("keep");
  expect(readFileSync(join(original, "content"), "utf8")).toBe("cloned");
});

// F2/F3 + S2: fake EXDEV exercises the local-volume fallback without extra volumes.
test("EXDEV reclones into private local staging and publishes only by rename", async () => {
  const f = fixture('printf "%s" "$PWD" > cwd; printf cloned > content');
  const stages: string[] = [];
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes, publishRename: async (source, target) => {
    stages.push(String(source));
    expect(lstatSync(source).mode & 0o777).toBe(0o700);
    if (stages.length === 1) throw Object.assign(new Error("volume"), { code: "EXDEV" });
    await rename(source, target);
  } });
  const { jobId } = await service.clone({ repo: "owner/local", parent: f.home });
  const result = await finish(service, jobId); expect(result.status).toBe("done");
  expect(stages).toEqual([join(f.stateHome, "clone-staging", jobId), join(f.home, `.iamceo-clone-${jobId}`)]);
  expect(readFileSync(join(result.path!, "cwd"), "utf8")).toBe(stages[1]!);
  expect(lstatSync(result.path!).mode & 0o777).toBe(0o700);
  expect(readdirSync(join(f.stateHome, "clone-staging"))).toEqual([]);
});
test("local fallback failure cleans only its verified temp directory, with an EXDEV explanation", async () => {
  const f = fixture();
  mkdirSync(join(f.home, "keep")); writeFileSync(join(f.home, "keep/data"), "keep");
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes, publishRename: async () => {
    throw Object.assign(new Error("private command output"), { code: "EXDEV" });
  } });
  const { jobId } = await service.clone({ repo: "owner/local-fail", parent: f.home });
  expect(await finish(service, jobId)).toEqual({ status: "failed", error: "같은 파일시스템으로 옮길 수 없습니다. 대상 폴더의 볼륨을 확인하세요" });
  expect(readdirSync(f.home)).toEqual(["keep"]);
  expect(readFileSync(join(f.home, "keep/data"), "utf8")).toBe("keep");
});
test("local cleanup also preserves a directory swapped in after ownership check", async () => {
  const f = fixture(), victim = join(f.home, "victim"); mkdirSync(victim); writeFileSync(join(victim, "keep"), "keep");
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes,
    publishRename: async () => { throw Object.assign(new Error("volume"), { code: "EXDEV" }); },
    beforeCleanup: async path => {
      if (!path.includes(".iamceo-clone-")) return;
      renameSync(path, path + "-original"); renameSync(victim, path);
    },
  });
  const { jobId } = await service.clone({ repo: "owner/local-swap", parent: f.home });
  expect((await finish(service, jobId)).status).toBe("failed");
  const quarantine = readdirSync(f.home).find(name => name.startsWith(".iamceo-cleanup-"))!;
  expect(readFileSync(join(f.home, quarantine, "stage/keep"), "utf8")).toBe("keep");
});

// F5: fake size/space hooks never fill the disk; final-check uses a sparse file.
test("less than 5 GiB free is refused before starting a clone", async () => {
  const f = fixture("exit 97");
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes: async () => 5 * 1024 ** 3 - 1 });
  await expect(service.clone({ repo: "owner/no-space", parent: f.home })).rejects.toMatchObject({ status: 403, message: "디스크 여유 공간이 부족합니다(5GB 필요)" });
  expect(readdirSync(join(f.stateHome, "clone-staging"))).toEqual([]);
  expect(readdirSync(f.home)).toEqual([]);
});
test("periodic 2 GiB limit kills the clone process group and removes staging only", async () => {
  const f = fixture('(/bin/sleep 0.3; printf leaked > late) &\nwait');
  let measurements = 0;
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes, monitorMs: 10,
    sizeBytes: async () => { measurements++; return 2 * 1024 ** 3 + 1; },
  });
  const { jobId } = await service.clone({ repo: "owner/large", parent: f.home });
  expect(await finish(service, jobId)).toEqual({ status: "failed", error: "저장소가 너무 큽니다(2GB 초과)" });
  expect(measurements).toBeGreaterThan(0);
  await Bun.sleep(350);
  expect(readdirSync(join(f.stateHome, "clone-staging"))).toEqual([]);
  expect(readdirSync(f.home)).toEqual([]);
});
test("final size check catches a fast large clone using sparse logical bytes", async () => {
  const f = fixture();
  // Bun writes a sparse file in the fake git process, no network or allocated GiB.
  const script = join(f.root, "sparse.ts");
  writeFileSync(script, 'import {openSync, ftruncateSync, closeSync} from "node:fs"; const fd=openSync("huge", "w"); ftruncateSync(fd, 2*1024**3+1); closeSync(fd);');
  writeFileSync(join(f.bin, "git"), `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`);
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes });
  const { jobId } = await service.clone({ repo: "owner/fast-large", parent: f.home });
  expect((await finish(service, jobId)).error).toBe("저장소가 너무 큽니다(2GB 초과)");
  expect(readdirSync(join(f.stateHome, "clone-staging"))).toEqual([]);
});

// S1: check the actual fake child's environment and argv for both gh and git.
test("clone sanitizes Git control env while preserving auth and passes hardening flags without recursive submodules", async () => {
  for (const tool of ["gh", "git"]) {
    const f = fixture();
    const script = `#!/bin/sh\nprintf '%s\\n' "$@" > args\n/usr/bin/env > environment\n`;
    writeFileSync(join(f.bin, tool), script); chmodSync(join(f.bin, tool), 0o755);
    const env = { ...f.env, HOME: f.home, GH_TOKEN: "fake-auth", KEEP_ME: "inherited", GIT_SSH_COMMAND: "evil", GIT_PROXY_COMMAND: "evil", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "x", GIT_CONFIG_VALUE_0: "evil", GIT_EXEC_PATH: "evil", GIT_ASKPASS: "evil", GIT_TRACE: "evil", GIT_TEMPLATE_DIR: "evil" };
    const service = new GitHub(f.folders, env, 2000, { freeBytes });
    const { jobId } = await service.clone({ repo: "owner/hardened", parent: f.home });
    const result = await finish(service, jobId); expect(result.status).toBe("done");
    const environment = readFileSync(join(result.path!, "environment"), "utf8");
    expect(environment).not.toContain("evil"); expect(environment).toContain("GH_TOKEN=fake-auth"); expect(environment).toContain("KEEP_ME=inherited");
    expect(environment).toContain("GIT_TERMINAL_PROMPT=0");
    expect(readFileSync(join(result.path!, "args"), "utf8").trim().split("\n")).toEqual(tool === "gh"
      ? ["repo", "clone", "owner/hardened", ".", "--", "-c", "protocol.file.allow=never", "-c", "core.hooksPath=/dev/null"]
      : ["-c", "protocol.file.allow=never", "-c", "core.hooksPath=/dev/null", "clone", "https://github.com/owner/hardened.git", "."]);
  }
  expect(githubEnvironment({ GIT_CONFIG_SYSTEM: "evil", GIT_TRACE2_EVENT: "evil", SSH_AUTH_SOCK: "/fake/agent" })).toMatchObject({ SSH_AUTH_SOCK: "/fake/agent", GH_HOST: "github.com" });
});

// F7: injected wall clock, running jobs never count against terminal history cap/TTL.
test("terminal jobs are limited to 50, expire at one hour, and retain running jobs", async () => {
  const f = fixture('case "$6" in *fail.git) exit 1;; esac; printf cloned > content'); let now = 0;
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes, now: () => now });
  const ids: string[] = [];
  for (let n = 0; n < 53; n++) {
    const { jobId } = await service.clone({ repo: n % 2 ? "owner/fail" : "owner/repo", parent: f.home, name: `repo-${n}` });
    ids.push(jobId); expect((await finish(service, jobId)).status).toBe(n % 2 ? "failed" : "done"); now++;
  }
  for (const id of ids.slice(0, 3)) expect(() => service.job(id)).toThrow("가져오기 작업을 찾을 수 없습니다");
  for (const id of ids.slice(3)) expect(service.job(id).status).not.toBe("running");
  const proceed = join(f.root, "proceed");
  writeFileSync(join(f.bin, "git"), `#!/bin/sh\nwhile [ ! -f '${proceed}' ]; do /bin/sleep 0.01; done\nexit 1\n`);
  const running = await service.clone({ repo: "owner/running", parent: f.home });
  now = 3 + 3_600_000 - 1; expect(service.job(ids[3]!).status).toBe("failed");
  now++; expect(() => service.job(ids[3]!)).toThrow("가져오기 작업을 찾을 수 없습니다");
  now += 3_600_000;
  for (const id of ids) expect(() => service.job(id)).toThrow("가져오기 작업을 찾을 수 없습니다");
  expect(service.job(running.jobId).status).toBe("running");
  writeFileSync(proceed, "go"); expect((await finish(service, running.jobId)).status).toBe("failed");
  now += 3_600_000; expect(() => service.job(running.jobId)).toThrow("가져오기 작업을 찾을 수 없습니다");
});

test("exactly 5 GiB free and exactly 2 GiB measured size are accepted", async () => {
  const f = fixture();
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes: async () => 5 * 1024 ** 3, sizeBytes: async () => 2 * 1024 ** 3 });
  const { jobId } = await service.clone({ repo: "owner/boundary", parent: f.home });
  expect((await finish(service, jobId)).status).toBe("done");
});
test("same target is reserved in memory during staging without creating a user directory", async () => {
  const f = fixture("/bin/sleep 0.1; printf cloned > content");
  const service = new GitHub(f.folders, f.env, 2000, { freeBytes });
  const { jobId } = await service.clone({ repo: "owner/reserved", parent: f.home });
  expect(existsSync(join(f.home, "reserved"))).toBe(false);
  await expect(service.clone({ repo: "owner/reserved", parent: f.home })).rejects.toMatchObject({ status: 409 });
  expect((await finish(service, jobId)).status).toBe("done");
});
test("server staging root refuses symlinks and nonprivate permissions", async () => {
  for (const link of [true, false]) {
    const f = fixture(), root = join(f.stateHome, "clone-staging");
    if (link) symlinkSync(f.outside, root); else mkdirSync(root, { mode: 0o755 });
    const service = new GitHub(f.folders, f.env, 2000, { freeBytes });
    await expect(service.clone({ repo: "owner/refused", parent: f.home })).rejects.toMatchObject({ status: 403 });
    expect(readdirSync(f.outside)).toEqual([]); expect(readdirSync(f.home)).toEqual([]);
  }
});

test("folder mkdir also rejects a different ordinary directory swapped in after creation", async () => {
  const f = fixture();
  const folders = new Folders(f.home, { afterMkdir: async () => {
    renameSync(join(f.home, "new"), join(f.home, "original")); mkdirSync(join(f.home, "new"));
  } });
  await expect(folders.create(f.home, "new")).rejects.toMatchObject({ status: 403 });
  expect(existsSync(join(f.home, "new"))).toBe(true);
  expect(existsSync(join(f.home, "original"))).toBe(true);
});
