import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireHomeOwner, HomeOwnershipError, normalizeHome, withHomeOwner } from "../server/home-owner.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const modulePath = resolve(import.meta.dir, "../server/home-owner.ts");
const source = `import { acquireHomeOwner } from ${JSON.stringify(modulePath)};
try {
  const owner = acquireHomeOwner(process.argv.at(-2));
  if (process.argv.at(-1) === 'probe') { owner.release(); process.exit(0); }
  let server;
  do { server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('fixture')});
    if(server.port === 7878) server.stop(true);
  } while(server.port === 7878);
  console.log(JSON.stringify({home:owner.home,port:server.port}));
  for await (const chunk of Bun.stdin.stream()) {
    if (new TextDecoder().decode(chunk).trim() === 'release') {
      owner.release(); server.stop(true); process.exit(0);
    }
  }
} catch(error) { console.error(error.code ?? error.message); process.exit(23); }
`;

describe("home ownership: real macOS flock", () => {
  test("canonical aliases and same-process contention; disposal keeps the inode", async () => {
    const runtime = createIsolatedRuntime();
    try {
      const alias = join(runtime.dir, "alias");
      symlinkSync(runtime.paths.iamceoHome, alias);
      expect(normalizeHome(join(alias, "new", "nested"))).toBe(join(runtime.paths.iamceoHome, "new", "nested"));
      const owner = acquireHomeOwner(alias);
      try {
        expect(owner.home).toBe(realpathSync(runtime.paths.iamceoHome));
        expect(() => acquireHomeOwner(runtime.paths.iamceoHome)).toThrow(HomeOwnershipError);
        withHomeOwner(alias, (home) => expect(home).toBe(owner.home));
        expect(() => acquireHomeOwner(alias)).toThrow(HomeOwnershipError);
        expect(statSync(owner.lockPath).mode & 0o777).toBe(0o600);
      } finally { owner.release(); owner.release(); }
      const inode = statSync(owner.lockPath).ino;
      writeFileSync(owner.lockPath, JSON.stringify({ pid: process.pid, stale: false }));
      const next = acquireHomeOwner(runtime.paths.iamceoHome);
      next[Symbol.dispose]();
      expect(statSync(owner.lockPath).ino).toBe(inode);
      expect(readFileSync(owner.lockPath, "utf8")).toContain(String(process.pid));
    } finally { await runtime.stop(); }
  });

  test("unsafe lock targets and a replaced held inode fail closed", async () => {
    const runtime = createIsolatedRuntime();
    try {
      const lock = join(runtime.paths.iamceoHome, ".owner.lock");
      const target = join(runtime.paths.work, "target");
      writeFileSync(target, "unchanged", { mode: 0o644 });
      symlinkSync(target, lock);
      expect(() => acquireHomeOwner(runtime.paths.iamceoHome)).toThrow();
      expect(statSync(target).mode & 0o7777).toBe(0o644);
      unlinkSync(lock);
      linkSync(target, lock);
      expect(() => acquireHomeOwner(runtime.paths.iamceoHome)).toThrow("안전하지 않은 홈 잠금 파일");
      unlinkSync(lock);
      mkdirSync(lock);
      expect(() => acquireHomeOwner(runtime.paths.iamceoHome)).toThrow();
      renameSync(lock, join(runtime.paths.work, "old-lock-directory"));
      writeFileSync(lock, "stale metadata", { mode: 0o666 });
      chmodSync(lock, 0o666);
      const owner = acquireHomeOwner(runtime.paths.iamceoHome);
      try {
        expect(statSync(lock).mode & 0o7777).toBe(0o600);
        renameSync(lock, join(runtime.paths.work, "held-lock"));
        writeFileSync(lock, "replacement");
        expect(() => withHomeOwner(runtime.paths.iamceoHome, () => {})).toThrow("inode changed");
      } finally { owner.release(); }
      expect(readFileSync(target, "utf8")).toBe("unchanged");
    } finally { await runtime.stop(); }
  });

  async function exercise(compiled: boolean) {
    const runtime = createIsolatedRuntime();
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      const entry = join(runtime.dir, "owner.ts");
      writeFileSync(entry, source, { mode: 0o600 });
      const executable = join(runtime.paths.bin, "owner");
      if (compiled) {
        const build = Bun.spawn([process.execPath, "build", entry, "--compile", "--outfile", executable], {
          env: runtime.childEnv(), cwd: runtime.paths.work, stdout: "pipe", stderr: "pipe",
        });
        children.push(build);
        const output = await new Response(build.stderr).text();
        expect(await build.exited, output).toBe(0);
      }
      const alias = join(runtime.dir, "alias");
      symlinkSync(runtime.paths.iamceoHome, alias);
      const spawn = (home: string, mode: string) => {
        const child = Bun.spawn([...(compiled ? [executable] : [process.execPath, entry]), home, mode], {
          env: runtime.childEnv(), cwd: runtime.paths.work, stdin: "pipe", stdout: "pipe", stderr: "pipe",
        });
        children.push(child);
        return child;
      };
      const ready = async (child: ReturnType<typeof spawn>) => {
        const reader = child.stdout.getReader();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("owner readiness timeout")), 10_000); }),
          ]);
          if (!chunk.value) throw new Error(`owner exited: ${await new Response(child.stderr).text()}`);
          return JSON.parse(new TextDecoder().decode(chunk.value)) as { home: string; port: number };
        } finally { clearTimeout(timer); reader.releaseLock(); }
      };
      const first = spawn(runtime.paths.iamceoHome, "hold");
      const firstReady = await ready(first);
      const denied = spawn(alias, "probe");
      expect(await denied.exited).toBe(23);
      expect(await new Response(denied.stderr).text()).toContain("home_in_use");
      // A different home really can own a different port at the same time.
      const secondHome = join(runtime.dir, "second-home");
      mkdirSync(secondHome);
      const independent = spawn(secondHome, "hold");
      const independentReady = await ready(independent);
      expect(firstReady.port).not.toBe(independentReady.port);
      expect(firstReady.port).not.toBe(7878);
      expect(independentReady.port).not.toBe(7878);
      independent.stdin.write("release\n"); independent.stdin.flush();
      expect(await independent.exited).toBe(0);
      // SIGKILL skips every user-space cleanup handler.
      first.kill("SIGKILL");
      await first.exited;
      expect(existsSync(join(runtime.paths.iamceoHome, ".owner.lock"))).toBe(true);
      const afterCrash = spawn(alias, "hold");
      expect((await ready(afterCrash)).home).toBe(firstReady.home);
      afterCrash.stdin.write("release\n"); afterCrash.stdin.flush();
      expect(await afterCrash.exited).toBe(0);
      const afterRelease = spawn(runtime.paths.iamceoHome, "probe");
      expect(await afterRelease.exited).toBe(0);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.all(children.map((child) => child.exited));
      await runtime.stop();
    }
  }

  test("two source processes: aliases contend, SIGKILL and close release", () => exercise(false), 30_000);
  test("compiled executable: aliases contend, SIGKILL and close release", () => exercise(true), 60_000);
});
