import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { acquireHomeOwner } from "../server/home-owner.ts";
import { classifyStorageError, isStorageFull, StorageError, toStorageError } from "../server/storage-errors.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

function setup() {
  const runtime = createIsolatedRuntime();
  const env = runtime.childEnv();
  return { runtime, env, path: join(runtime.paths.iamceoHome, "config.json") };
}

function temporaryFiles(home: string) {
  return fs.readdirSync(home).filter((name) => name.startsWith(".config-") && name.endsWith(".tmp"));
}

describe("atomic config", () => {
  test("first load, caller paths, persisted defaults and permission repair", async () => {
    const { runtime, env, path } = setup();
    try {
      fs.chmodSync(runtime.paths.iamceoHome, 0o777);
      const first = loadConfig(env);
      expect(first.home).toBe(runtime.paths.iamceoHome);
      expect(first.port).toBe(0);
      expect(first.accessCode.length).toBe(16);
      for (const dir of [first.home, first.uploadsDir, first.inboxDir, first.rolesDir]) {
        fs.chmodSync(dir, 0o755);
      }
      fs.chmodSync(path, 0o666);
      const before = fs.statSync(path).ino;
      expect(loadConfig(env).accessCode).toBe(first.accessCode);
      expect(fs.statSync(path).ino).toBe(before);
      for (const dir of [first.home, first.uploadsDir, first.inboxDir, first.rolesDir]) expect(fs.statSync(dir).mode & 0o7777).toBe(0o700);
      expect(fs.statSync(path).mode & 0o7777).toBe(0o600);
      updateConfigFile({ port: 12345, hosts: ["127.0.0.1"], accessCode: undefined }, env);
      expect(JSON.parse(fs.readFileSync(path, "utf8"))).toMatchObject({ accessCode: first.accessCode, port: 12345, hosts: ["127.0.0.1"] });
      expect(fs.statSync(path).ino).not.toBe(before);
      const alias = join(runtime.dir, "alias");
      fs.symlinkSync(runtime.paths.iamceoHome, alias);
      const aliased = loadConfig({ ...env, IAMCEO_HOME: alias });
      expect(aliased.home).toBe(alias);
      expect(aliased.dbPath).toBe(join(alias, "iamceo.db"));
      expect(aliased.uploadsDir).toBe(join(alias, "uploads"));
      expect(aliased.accessCode).toBe(first.accessCode);
      expect(temporaryFiles(first.home)).toEqual([]);
    } finally { await runtime.stop(); }
  });

  test("undefined removes optional overrides, preserves credentials and omitted fields", async () => {
    const { runtime, env, path } = setup();
    try {
      const first = loadConfig(env);
      updateConfigFile({ hosts: ["127.0.0.1", "192.168.0.9"], port: 12345, coreBin: "/fixture/core" }, env);
      updateConfigFile({ hosts: undefined, coreBin: undefined, accessCode: undefined }, env);
      const saved = JSON.parse(fs.readFileSync(path, "utf8"));
      expect(saved).toEqual({ accessCode: first.accessCode, port: 12345 });
      expect(loadConfig(env)).toMatchObject({ accessCode: first.accessCode, hostsAuto: true });
      expect(fs.statSync(path).mode & 0o7777).toBe(0o600);
      expect(temporaryFiles(first.home)).toEqual([]);
    } finally { await runtime.stop(); }
  });

  test("0600 temporary file is verified, file-synced, renamed, then directory-synced", async () => {
    const { runtime, env, path } = setup();
    const events: string[] = [];
    const write = fs.writeFileSync;
    const sync = fs.fsyncSync;
    const rename = fs.renameSync;
    const spies: { mockRestore(): void }[] = [];
    try {
      loadConfig(env);
      spies.push(spyOn(fs, "writeFileSync").mockImplementation((fd, data, options) => {
        expect(fs.fstatSync(fd as number).mode & 0o7777).toBe(0o600);
        events.push("write");
        return write(fd, data, options);
      }));
      spies.push(spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        events.push(fs.fstatSync(fd).isDirectory() ? "directory-sync" : "file-sync");
        sync(fd);
      }));
      spies.push(spyOn(fs, "renameSync").mockImplementation((from, to) => {
        expect(JSON.parse(fs.readFileSync(from, "utf8")).accessCode).toBe("replacement");
        expect(fs.statSync(from).mode & 0o7777).toBe(0o600);
        events.push("rename");
        rename(from, to);
      }));
      updateConfigFile({ accessCode: "replacement" }, env);
      expect(events).toEqual(["write", "file-sync", "rename", "directory-sync"]);
      expect(JSON.parse(fs.readFileSync(path, "utf8")).accessCode).toBe("replacement");
    } finally { for (const spy of spies.reverse()) spy.mockRestore(); await runtime.stop(); }
  });

  for (const stage of ["create", "chmod", "write", "file-sync", "rename", "directory-sync"] as const) {
    test(`ENOSPC at ${stage} fails explicitly and leaves a complete protected config`, async () => {
      const { runtime, env, path } = setup();
      let spy: { mockRestore(): void } | undefined;
      try {
        loadConfig(env);
        const before = fs.readFileSync(path, "utf8");
        const full = () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); };
        if (stage === "create") {
          const open = fs.openSync;
          spy = spyOn(fs, "openSync").mockImplementation((target, ...args) => {
            if (String(target).endsWith(".tmp")) return full();
            return open(target, ...args);
          });
        } else if (stage === "chmod") {
          const chmod = fs.fchmodSync;
          spy = spyOn(fs, "fchmodSync").mockImplementation((fd, mode) => {
            if (temporaryFiles(runtime.paths.iamceoHome).some((name) => fs.statSync(join(runtime.paths.iamceoHome, name)).ino === fs.fstatSync(fd).ino)) return full();
            chmod(fd, mode);
          });
        } else if (stage === "write") spy = spyOn(fs, "writeFileSync").mockImplementation(full);
        else if (stage === "rename") spy = spyOn(fs, "renameSync").mockImplementation(full);
        else {
          const sync = fs.fsyncSync;
          spy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
            if (fs.fstatSync(fd).isDirectory() === (stage === "directory-sync")) return full();
            sync(fd);
          });
        }
        let failure: unknown;
        try { updateConfigFile({ accessCode: "next" }, env); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(StorageError);
        expect(failure).toMatchObject({ code: "storage_full", status: 507 });
        expect(isStorageFull(failure)).toBe(true);
        expect(fs.statSync(path).mode & 0o7777).toBe(0o600);
        if (stage === "directory-sync") expect(JSON.parse(fs.readFileSync(path, "utf8")).accessCode).toBe("next");
        else expect(fs.readFileSync(path, "utf8")).toBe(before);
        expect(temporaryFiles(runtime.paths.iamceoHome)).toEqual([]);
        spy.mockRestore(); spy = undefined;
        // Failure paths must release their home lock too.
        updateConfigFile({ port: 23456 }, env);
        expect(JSON.parse(fs.readFileSync(path, "utf8")).port).toBe(23456);
      } finally { spy?.mockRestore(); await runtime.stop(); }
    });
  }

  test("partial writes and invalid patches preserve the old config without leaking credentials", async () => {
    const { runtime, env, path } = setup();
    let spy: { mockRestore(): void } | undefined;
    try {
      loadConfig(env);
      const before = fs.readFileSync(path, "utf8");
      const write = fs.writeFileSync;
      spy = spyOn(fs, "writeFileSync").mockImplementation((fd) => write(fd, "{\"accessCode\":\"truncated-secret"));
      expect(() => updateConfigFile({ accessCode: "next" }, env)).toThrow("검증 실패");
      spy.mockRestore(); spy = undefined;
      expect(fs.readFileSync(path, "utf8")).toBe(before);
      for (const patch of [{ port: -1 }, { port: 65536 }, { port: 1.5 }, { accessCode: "" }]) {
        expect(() => updateConfigFile(patch, env)).toThrow("설정 파일");
        expect(fs.readFileSync(path, "utf8")).toBe(before);
      }
      fs.writeFileSync(path, '{"accessCode":"secret-canary",');
      let message = "";
      try { updateConfigFile({ port: 0 }, env); } catch (error) { message = (error as Error).message; }
      expect(message).toContain("설정 파일");
      expect(message).not.toContain("secret-canary");
      expect(temporaryFiles(runtime.paths.iamceoHome)).toEqual([]);
    } finally { spy?.mockRestore(); await runtime.stop(); }
  });

  test("symlink/hardlink config targets and directory aliases are refused without touching targets", async () => {
    const { runtime, env, path } = setup();
    try {
      const target = join(runtime.paths.work, "protected.json");
      fs.writeFileSync(target, '{"accessCode":"keep"}', { mode: 0o640 });
      fs.symlinkSync(target, path);
      expect(() => loadConfig(env)).toThrow();
      expect(() => updateConfigFile({ port: 0 }, env)).toThrow();
      expect(fs.statSync(target).mode & 0o777).toBe(0o640);
      fs.unlinkSync(path);
      fs.linkSync(target, path);
      expect(() => loadConfig(env)).toThrow("안전하지 않은 설정 파일");
      fs.unlinkSync(path);
      fs.symlinkSync(runtime.paths.work, join(runtime.paths.iamceoHome, "uploads"));
      expect(() => loadConfig(env)).toThrow();
      expect(fs.readFileSync(target, "utf8")).toBe('{"accessCode":"keep"}');
    } finally { await runtime.stop(); }
  });

  test("permission repair failures are explicit and cleanup cannot hide the original full-disk error", async () => {
    const { runtime, env, path } = setup();
    const spies: { mockRestore(): void }[] = [];
    try {
      loadConfig(env);
      const before = fs.readFileSync(path, "utf8");
      fs.chmodSync(path, 0o644);
      const permission = Object.assign(new Error("denied"), { code: "EACCES" });
      spies.push(spyOn(fs, "fchmodSync").mockImplementation(() => { throw permission; }));
      expect(() => loadConfig(env)).toThrow(StorageError);
      expect(classifyStorageError(permission)).toBe("storage_permission");
      spies.pop()!.mockRestore();
      fs.chmodSync(path, 0o600);
      spies.push(spyOn(fs, "writeFileSync").mockImplementation(() => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); }));
      spies.push(spyOn(fs, "unlinkSync").mockImplementation(() => { throw permission; }));
      let failure: unknown;
      try { updateConfigFile({ accessCode: "next" }, env); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "storage_full", status: 507 });
      expect((failure as Error).cause).toBeInstanceOf(AggregateError);
      expect(fs.readFileSync(path, "utf8")).toBe(before);
      for (const name of temporaryFiles(runtime.paths.iamceoHome)) expect(fs.statSync(join(runtime.paths.iamceoHome, name)).mode & 0o7777).toBe(0o600);
    } finally { for (const spy of spies.reverse()) spy.mockRestore(); await runtime.stop(); }
  });

  test("established DB never silently replaces a missing credential; pre-install setup stays compatible", async () => {
    const { runtime, env, path } = setup();
    try {
      updateConfigFile({ hosts: ["127.0.0.1"] }, env);
      expect(loadConfig(env).accessCode.length).toBe(16);
      fs.writeFileSync(path, '{"hosts":["127.0.0.1"]}');
      fs.writeFileSync(join(runtime.paths.iamceoHome, "iamceo.db"), "fixture only");
      expect(() => loadConfig(env)).toThrow("명시적으로 재발급");
      expect(JSON.parse(fs.readFileSync(path, "utf8")).accessCode).toBeUndefined();
      fs.unlinkSync(path);
      expect(() => loadConfig(env)).toThrow("명시적으로 재발급");
      expect(fs.existsSync(path)).toBe(false);
      updateConfigFile({ accessCode: "explicit-replacement" }, env);
      expect(loadConfig(env).accessCode).toBe("explicit-replacement");
    } finally { await runtime.stop(); }
  });

  test("foreign owner blocks config mutations, allows protected reads; local owner survives writes", async () => {
    const { runtime, env, path } = setup();
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      loadConfig(env);
      const owner = acquireHomeOwner(runtime.paths.iamceoHome);
      try {
        updateConfigFile({ accessCode: "owned" }, env);
        const alias = join(runtime.dir, "alias");
        fs.symlinkSync(runtime.paths.iamceoHome, alias);
        const entry = join(runtime.dir, "config-child.ts");
        fs.writeFileSync(entry, `import { loadConfig, updateConfigFile } from ${JSON.stringify(resolve(import.meta.dir, "../server/config.ts"))};
try { if(process.argv.at(-1)==='read') { loadConfig(); } else { updateConfigFile({accessCode:'foreign'}); }
process.exit(0); } catch(error) { console.error(error.code ?? error.message); process.exit(23); }`);
        for (const home of [runtime.paths.iamceoHome, alias]) for (const mode of ["read", "write"]) {
          const child = Bun.spawn([process.execPath, entry, mode], { env: { ...env, IAMCEO_HOME: home }, cwd: runtime.paths.work, stdout: "pipe", stderr: "pipe" });
          children.push(child);
          expect(await child.exited).toBe(mode === "read" ? 0 : 23);
          if (mode === "write") expect(await new Response(child.stderr).text()).toContain("home_in_use");
        }
        expect(JSON.parse(fs.readFileSync(path, "utf8")).accessCode).toBe("owned");
      } finally { owner.release(); }
      updateConfigFile({ port: 34567 }, env);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.all(children.map((child) => child.exited));
      await runtime.stop();
    }
  });

  for (const stage of ["before-rename", "after-rename"] as const) {
    test(`process crash ${stage} leaves a whole config and automatically releases ownership`, async () => {
      const { runtime, env, path } = setup();
      let child: ReturnType<typeof Bun.spawn> | undefined;
      try {
        updateConfigFile({ accessCode: "previous" }, env);
        const entry = join(runtime.dir, "crash.ts");
        fs.writeFileSync(entry, `import * as fs from 'node:fs';
import { spyOn } from 'bun:test';
import { updateConfigFile } from ${JSON.stringify(resolve(import.meta.dir, "../server/config.ts"))};
const rename = fs.renameSync;
spyOn(fs,'renameSync').mockImplementation((from,to)=> {
  if (${JSON.stringify(stage)} === 'after-rename') rename(from,to);
  process.kill(process.pid,'SIGKILL');
});
updateConfigFile({accessCode:'replacement'});
process.exit(99);
`);
        child = Bun.spawn([process.execPath, entry], { env, cwd: runtime.paths.work, stdout: "pipe", stderr: "pipe" });
        await child.exited;
        expect(child.signalCode).toBe("SIGKILL");
        expect(JSON.parse(fs.readFileSync(path, "utf8")).accessCode).toBe(stage === "before-rename" ? "previous" : "replacement");
        expect(fs.statSync(path).mode & 0o7777).toBe(0o600);
        for (const name of temporaryFiles(runtime.paths.iamceoHome)) expect(fs.statSync(join(runtime.paths.iamceoHome, name)).mode & 0o7777).toBe(0o600);
        updateConfigFile({ port: 45678 }, env);
        expect(JSON.parse(fs.readFileSync(path, "utf8")).port).toBe(45678);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (child) await child.exited;
        await runtime.stop();
      }
    });
  }
});

describe("storage error classification", () => {
  test("structured OS errors, real SQLite FULL, nested causes and cycles", async () => {
    const { runtime } = setup();
    const db = new Database(join(runtime.paths.iamceoHome, "full.db"));
    try {
      db.exec("PRAGMA max_page_count=2; CREATE TABLE test (value BLOB)");
      let failure: unknown;
      try { db.exec("INSERT INTO test VALUES (zeroblob(100000))"); } catch (error) { failure = error; }
      expect(isStorageFull(failure)).toBe(true);
      for (const code of ["ENOSPC", "EDQUOT", "SQLITE_FULL"]) expect(isStorageFull({ code })).toBe(true);
      expect(classifyStorageError({ code: "EACCES" })).toBe("storage_permission");
      expect(classifyStorageError({ code: "EIO" })).toBe("storage_io");
      const cause = { code: "ENOSPC" };
      expect(isStorageFull(new Error("wrapper", { cause }))).toBe(true);
      expect(toStorageError(cause, "write").cause).toBe(cause);
      expect(isStorageFull(new Error("ENOSPC mentioned in arbitrary text"))).toBe(false);
      const cyclic: { cause?: unknown } = {};
      cyclic.cause = cyclic;
      expect(classifyStorageError(cyclic)).toBeNull();
    } finally { db.close(); await runtime.stop(); }
  });
});
