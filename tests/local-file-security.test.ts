import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { readLocalFile, type LocalFileFS } from "../server/local-files.ts";
import { FilePublication, prepareImport } from "../server/files.ts";
import { configuredSecretRoots, isSecretPath } from "../server/secret-paths.ts";
import { type Store } from "../server/store.ts";
import { additionalSecretFiles, allowedProjectFiles, headSecretFiles, homeSecretPaths, nestedSecretFiles, projectArtifactFiles } from "./fixtures/secret-path-cases.ts";

const home = "/fixture/home", safe = home + "/project/config", secret = home + "/.aws/config";
const store = { requireProject: () => ({ cwd: home + "/project" }), listMembers: () => [] } as unknown as Store;
const stat = (ino: number) => ({ dev: 1, ino, nlink: 1, size: 4, mtimeMs: 1, ctimeMs: 1, mtime: new Date(1), isFile: () => true });

test("mixed realpath observations reject the secret FD before any read; identity mismatches also reject", () => {
  for (const observed of [secret, safe]) {
    let observations = 0, reads = 0, closed = 0;
    const injected = {
      realpathSync: (path: string) => path === home ? home : (++observations === 1 ? safe : observations === 2 ? observed : safe),
      statSync: (path: string) => stat(path === secret ? 22 : 11),
      openSync: () => 10, fstatSync: () => stat(22),
      readSync: () => { reads++; return 0; }, closeSync: () => { closed++; },
    } as unknown as LocalFileFS;
    expect(() => readLocalFile(store, "p", "config", home, [], injected)).toThrow();
    expect(observations).toBe(2); expect(reads).toBe(0); expect(closed).toBe(1);
  }
});

test("FIFO fixture is rejected before opening within a subprocess deadline", async () => {
  const root = fs.mkdtempSync("/private/tmp/iamceo-fifo-");
  const fifo = join(root, "pipe");
  expect(Bun.spawnSync(["/usr/bin/mkfifo", fifo]).exitCode).toBe(0);
  const child = Bun.spawn([process.execPath, "tests/fixtures/local-file-fifo.ts", root], { stdout: "pipe", stderr: "pipe" });
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill(); }, 1000);
  try {
    expect(await child.exited).toBe(0); expect(expired).toBe(false);
    expect(await new Response(child.stdout).text()).toContain("403 no opens");
  } finally { clearTimeout(timer); fs.unlinkSync(fifo); fs.rmdirSync(root); }
}, 5000);

test("growth, truncation and same-size mutation during reading reject with 409", () => {
  const root = fs.mkdtempSync("/private/tmp/iamceo-changing-");
  const path = join(root, "a.txt"), localStore = { requireProject: () => ({ cwd: root }), listMembers: () => [] } as unknown as Store;
  try {
    for (const mutate of [() => fs.appendFileSync(path, "growth"), () => fs.truncateSync(path, 1), () => { fs.writeFileSync(path, "xxxx"); fs.utimesSync(path, 1, 1); }]) {
      fs.writeFileSync(path, "text"); let changed = false;
      const injected = { ...fs, readSync: ((...args: Parameters<typeof fs.readSync>) => {
        if (!changed) { changed = true; mutate(); }
        return fs.readSync(...args);
      }) as typeof fs.readSync };
      try { readLocalFile(localStore, "p", path, root, [], injected); throw new Error("must reject"); }
      catch (error) { expect(error).toMatchObject({ status: 409 }); }
    }
  } finally { fs.unlinkSync(path); fs.rmdirSync(root); }
});

test("opened FD hard links are rejected before read and links created during read are rejected afterwards", () => {
  for (const linkedBefore of [true, false]) {
    let stats = 0, reads = 0;
    const injected = {
      realpathSync: (path: string) => path, statSync: () => stat(11), openSync: () => 10,
      fstatSync: () => ({ ...stat(11), nlink: ++stats === 1 && !linkedBefore ? 1 : 2 }),
      readSync: (_fd: number, bytes: Buffer) => { reads++; bytes.write("text"); return reads === 1 ? 4 : 0; }, closeSync: () => {},
    } as unknown as LocalFileFS;
    expect(() => readLocalFile(store, "p", safe, home, [], injected)).toThrow("다른 이름으로 연결된 파일(하드 링크)은 열지 않습니다");
    expect(reads).toBe(linkedBefore ? 0 : 2);
  }
});

test("attachment copy refuses a hard link created after prepareImport and during copying", async () => {
  const root = fs.mkdtempSync("/private/tmp/iamceo-copy-");
  const path = join(root, "movie.mp4"), alias = join(root, "alias.mp4"); fs.writeFileSync(path, "fixture video");
  const input = prepareImport(path); fs.linkSync(path, alias);
  const publication = new FilePublication(join(root, "uploads"));
  await expect(publication.stagePath(input)).rejects.toMatchObject({ status: 403 });
  fs.unlinkSync(alias);
  // stagePath's post-read fstat is exercised by a scoped read hook below.
  const second = prepareImport(path), original = fs.readSync;
  const { spyOn } = await import("bun:test");
  const read = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    if (!fs.existsSync(alias)) fs.linkSync(path, alias);
    return original(...args);
  }) as typeof fs.readSync);
  try { await expect(new FilePublication(join(root, "uploads")).stagePath(second)).rejects.toMatchObject({ status: 403 }); }
  finally { read.mockRestore(); fs.unlinkSync(alias); }
});


test("employee file tool shares secret-name and relocated state/provider-home protection in an isolated HOME", async () => {
  const home = fs.realpathSync(fs.mkdtempSync("/private/tmp/iamceo-fakehome-"));
  const child = Bun.spawn([process.execPath, "tests/fixtures/home-secrets.ts", "--extended"], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, errors).toBe(0);
  const result = JSON.parse(output) as Record<string, boolean>;
  expect(Object.keys(result)).toHaveLength(15);
  for (const [path, rejected] of Object.entries(result)) expect(rejected, path).toBe(path !== "project/plan.md");
});


test("configuration and environment credential roots canonicalize aliases independently, including a missing descendant", () => {
  const root = fs.mkdtempSync("/private/tmp/iamceo-roots-");
  const actual = join(root, "actual"); fs.mkdirSync(actual);
  const alias = join(root, "alias"); fs.symlinkSync(actual, alias);
  const roots = configuredSecretRoots({ home: join(alias, "state"), claudeHome: join(alias, "claude"), codexHome: join(alias, "codex") },
    { IAMCEO_HOME: join(alias, "env-state"), CLAUDE_CONFIG_DIR: join(alias, "env-claude"), CODEX_HOME: join(alias, "env-codex") }, root);
  for (const name of ["state", "claude", "codex", "env-state", "env-claude", "env-codex"]) {
    expect(roots).toContain(join(actual, name));
    expect(isSecretPath(join(actual, name, "fixture.txt"), root, roots)).toBe(true);
    expect(isSecretPath(join(actual, name + "-safe", "fixture.txt"), root, roots)).toBe(false);
  }
});

test("project artifacts, home workspaces, narrow basenames and relocated defaults share employee and local-file policy in an isolated HOME", async () => {
  const home = fs.mkdtempSync("/private/tmp/iamceo-fakehome-");
  const child = Bun.spawn([process.execPath, "tests/fixtures/file-path-policy.ts"], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, errors).toBe(0);
  const result = JSON.parse(output);
  expect(result.allowed).toBe(allowedProjectFiles.length + projectArtifactFiles.length + 2);
  expect(result.head).toBe(headSecretFiles.length);
  expect(result.relocated).toBe(72);
  expect(result.homeDotBlocked).toBe(1);
  expect(result.blocked).toBe(headSecretFiles.length + additionalSecretFiles.length + nestedSecretFiles.length + homeSecretPaths.length + result.relocated + 1);
});
