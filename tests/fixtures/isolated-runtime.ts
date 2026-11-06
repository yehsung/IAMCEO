// No import-time config reads, listeners, environment mutations, or provider discovery.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CoreRunnerOptions } from "../../server/runner/core";

export interface ProviderHomes { claudeHome: string; codexHome: string; contextHome: string }
export type IsolatedRuntime = ReturnType<typeof createIsolatedRuntime>;

export function createIsolatedRuntime() {
  // Short, canonical Unix socket paths also work on Darwin (104-byte sockaddr_un).
  const dir = realpathSync(mkdtempSync("/private/tmp/iq-"));
  const paths = Object.freeze({
    home: join(dir, "home"), iamceoHome: join(dir, "iamceo"), work: join(dir, "work"),
    claudeHome: join(dir, "claude"), codexHome: join(dir, "codex"), contextHome: join(dir, "context"),
    stateDir: join(dir, "state"), configDir: join(dir, "config"), bin: join(dir, "bin"),
    sessions: join(dir, "sessions"), temp: join(dir, "tmp"),
  });
  for (const path of Object.values(paths)) mkdirSync(path, { mode: 0o700 });
  const providerHomes: ProviderHomes = Object.freeze({ claudeHome: paths.claudeHome, codexHome: paths.codexHome, contextHome: paths.contextHome });
  const socketPath = join(dir, "c.sock");
  const herdrSocketPath = join(dir, "no-herdr.sock");
  const bins = Object.freeze({ coreBin: join(paths.bin, "core"), claudeBin: join(paths.bin, "claude"), codexBin: join(paths.bin, "codex"), herdrBin: join(paths.bin, "herdr") });
  const fakeClaude = realpathSync(join(import.meta.dir, "fake-claude.ts"));
  const fakeEntry = join(dir, "fake-entry.ts");
  // The existing fake model calls fetch itself. Keep redirects and late config
  // edits from sending it to a different origin after the parent validates it.
  writeFileSync(fakeEntry, `const originalFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const origin = process.env.IAMCEO_URL;
  if (!origin || url.origin !== new URL(origin).origin || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "7878" || url.username || url.password) throw new Error("Fake provider network escape refused");
  return originalFetch(input, { ...init, redirect: "error" });
});
await import(${JSON.stringify(fakeClaude)});
`, { mode: 0o600 });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const [name, path] of Object.entries(bins)) {
    writeFileSync(path, name === "claudeBin"
      ? `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeEntry)} "$@"\n`
      : "#!/bin/sh\nprintf 'Isolated fixture: no real provider/core allowed\\n' >&2\nexit 97\n", { mode: 0o700 });
  }
  // A shebang using /usr/bin/env bun must resolve only to this known runtime.
  writeFileSync(join(paths.bin, "bun"), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
  const servers = new Set<Bun.Server<undefined>>();
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  let stopped = false;
  let stopping: Promise<void> | undefined;
  function assertOpen() { if (stopped) throw new Error("Isolated runtime is stopped"); }
  function assertOwnedPath(path: string): string {
    assertOpen();
    if (!path || !isAbsolute(path)) throw new Error("Explicit fixture-owned absolute path required");
    if (path.split("/").includes("..")) throw new Error("Fixture path traversal is not allowed");
    const target = resolve(path);
    if (target !== dir && (relative(dir, target).startsWith("..") || isAbsolute(relative(dir, target)))) throw new Error("Path is outside this fixture");
    // Check every existing ancestor without following a symlink outside the fixture.
    let current = target;
    while (current !== dirname(dir)) {
      try { if (lstatSync(current).isSymbolicLink()) throw new Error("Fixture paths cannot contain symlinks"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (current === dir) break;
      current = dirname(current);
    }
    return target;
  }
  function requireProviderHomes(homes: ProviderHomes): ProviderHomes {
    if (!homes) throw new Error("Explicit provider homes required");
    for (const key of ["claudeHome", "codexHome", "contextHome"] as const) {
      assertOwnedPath(homes[key]);
      if (!lstatSync(homes[key]).isDirectory()) throw new Error(`${key} must be a directory`);
    }
    return { ...homes };
  }
  function runnerOptions(homes: ProviderHomes): CoreRunnerOptions {
    return { ...requireProviderHomes(homes), ...bins, socketPath, stateDir: paths.stateDir, configDir: paths.configDir };
  }
  function assertURL(input: string | URL): URL {
    assertOpen();
    const url = new URL(input);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.port === "7878" ||
        ![...servers].some((server) => server.port === Number(url.port))) throw new Error("URL must use this fixture's listening loopback port");
    return url;
  }
  function childEnv(extra: Record<string, string> = {}): Record<string, string> {
    assertOpen();
    const env: Record<string, string> = {
      PATH: paths.bin, HOME: paths.home, TMPDIR: paths.temp, LANG: "en_US.UTF-8", TERM: "xterm-256color",
      XDG_CONFIG_HOME: paths.configDir, XDG_STATE_HOME: paths.stateDir, XDG_CACHE_HOME: paths.temp,
      CLAUDE_CONFIG_DIR: paths.claudeHome, CODEX_HOME: paths.codexHome,
      IAMCEO_HOME: paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_TEST: "1",
      IAMCEO_CORE_SOCKET: socketPath, IAMCEO_HERDR_SOCKET: herdrSocketPath,
      IAMCEO_CORE_BIN: bins.coreBin, IAMCEO_CLAUDE_BIN: bins.claudeBin, IAMCEO_CODEX_BIN: bins.codexBin,
      FAKE_CLAUDE_SESSIONS: paths.sessions, FAKE_CLAUDE_LOG: join(dir, "fake.jsonl"),
    };
    for (const [key, value] of Object.entries(extra)) {
      if (key in env) { if (value !== env[key]) throw new Error(`Cannot override isolated environment: ${key}`); }
      else if (["FAKE_CLAUDE_SCRIPT"].includes(key)) assertOwnedPath(value);
      else if (key === "IAMCEO_URL") assertURL(value);
      else if (!["FAKE_CLAUDE_DIRECTIVES", "IAMCEO_TOKEN", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE"].includes(key)) throw new Error(`Environment key is not allowlisted: ${key}`);
      env[key] = value;
    }
    return env;
  }
  function assertFakeExecutable(path: string) {
    assertOpen();
    if (![...Object.values(bins), fakeClaude].includes(path)) throw new Error("Only fixture fake executables are allowed");
    if (path !== fakeClaude) assertOwnedPath(path);
  }
  function spawnFake(argv: string[], options: { cwd: string; env?: Record<string, string> }) {
    assertFakeExecutable(argv[0]);
    assertOwnedPath(options.cwd);
    const env = childEnv(options.env);
    if ([bins.claudeBin, fakeClaude].includes(argv[0])) {
      for (const flag of ["--session-id", "--resume"]) {
        const at = argv.indexOf(flag);
        if (at >= 0 && !/^[a-zA-Z0-9_-]+$/.test(argv[at + 1] ?? "")) throw new Error("Invalid fake session id");
      }
      for (const flag of ["--mcp-config", "--append-system-prompt-file", "--settings"]) {
        const at = argv.indexOf(flag);
        if (at >= 0) assertOwnedPath(argv[at + 1]);
      }
      const at = argv.indexOf("--mcp-config");
      if (at >= 0) {
        const config = JSON.parse(readFileSync(argv[at + 1], "utf8"));
        env.IAMCEO_URL = assertURL(config.mcpServers?.iamceo?.env?.IAMCEO_URL ?? "http://invalid.invalid").origin;
      }
      argv = [bins.claudeBin, ...argv.slice(1)];
    }
    const child = Bun.spawn(argv, { cwd: options.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    children.add(child);
    void child.exited.finally(() => children.delete(child));
    return child;
  }
  function serve(fetch: (request: Request) => Response | Promise<Response>) {
    assertOpen();
    for (let attempt = 0; attempt < 16; attempt++) {
      const server = Bun.serve<undefined>({ hostname: "127.0.0.1", port: 0, fetch });
      if (server.port === 7878) { void server.stop(true); continue; }
      servers.add(server);
      return { server, port: server.port!, url: `http://127.0.0.1:${server.port}` };
    }
    throw new Error("Could not allocate a non-live fixture port");
  }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    stopping = (async () => {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all([...children].map((child) => child.exited));
      await Promise.all([...servers].map((server) => server.stop(true)));
      // Never follow a replaced root when cleaning up.
      if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) throw new Error("Fixture root ownership changed");
      rmSync(dir, { recursive: true });
    })();
    return stopping;
  }
  return { dir, paths, bins, providerHomes, socketPath, herdrSocketPath, runnerOptions, requireProviderHomes, childEnv, assertOwnedPath, assertFakeExecutable, assertURL, spawnFake, serve, stop };
}
