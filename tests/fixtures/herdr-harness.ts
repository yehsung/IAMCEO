// 격리 herdr 서버를 PTY 로 띄운다. 라이브 서버와 소켓·세션 이름이 겹치지 않는다(§9).
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { rpc } from "../../server/runner/herdr-client.ts";

export interface IsolatedHerdr {
  name: string;
  socketPath: string;
  /** 시험 임시 폴더. 지우지 않고 남긴다(§0). */
  dir: string;
  fakeDir: string;
  fakeClaudePath: string;
  stop(): Promise<void>;
}

const TEST_SOCKET = /\/\.config\/herdr\/sessions\/iamceo-test-[^/]+\/herdr\.sock$/;

export function assertIsolatedSocket(socketPath: string): void {
  if (!TEST_SOCKET.test(socketPath)) throw new Error(`격리 시험 소켓이 아님: ${socketPath}`);
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // 이 시험을 돌리는 Claude 세션의 값(MESSAGING_SOCKET·CLAUDE_PID·CLAUDE_EFFORT 등)이 칸 안 claude 로 새지 않게 통째로 지운다.
    if (k.startsWith("HERDR_") || (k.startsWith("CLAUDE") && k !== "CLAUDE_CONFIG_DIR")) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

// 컴파일 결과가 커서 소스가 그대로면 다시 쓴다.
async function buildFakeClaude(): Promise<{ binDir: string; path: string }> {
  const binDir = join(import.meta.dir, "..", ".tmp", "herdr-fake-bin");
  mkdirSync(binDir, { recursive: true });
  const out = join(binDir, "claude");
  const entry = join(import.meta.dir, "herdr-fake-tui.ts");
  if (existsSync(out) && statSync(out).mtimeMs > statSync(entry).mtimeMs) return { binDir: realpathSync(binDir), path: realpathSync(out) };
  const build = Bun.spawn(["bun", "build", entry, "--compile", "--outfile", out], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: cleanEnv({}) });
  const code = await build.exited;
  if (code !== 0) throw new Error(`가짜 claude 빌드 실패: ${await new Response(build.stderr).text()}`);
  return { binDir: realpathSync(binDir), path: realpathSync(out) };
}

export interface IsolatedOptions {
  /** 칸 안에서 실제 claude 를 쓴다. 가짜 PATH·ZDOTDIR 없이 사용자의 실제 zsh 설정(alias 포함)으로 뜬다. E2E 전용. */
  realClaude?: boolean;
  cols?: number;
  rows?: number;
}

export async function startIsolatedHerdr(opts: IsolatedOptions = {}): Promise<IsolatedHerdr> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-herdr-")));
  const fakeDir = join(dir, "fake");
  const zdot = join(dir, "zdot");
  for (const d of [fakeDir, zdot, join(dir, "work")]) mkdirSync(d, { recursive: true });
  const { binDir, path: fakeClaudePath } = await buildFakeClaude();
  // 사용자 zsh 설정의 claude alias 와 PATH 를 막는다. 칸의 claude 는 반드시 가짜여야 한다.
  writeFileSync(join(zdot, ".zshrc"), `export PATH=${binDir}:$PATH\nunalias claude 2>/dev/null\nPS1='fake-shell$ '\nPROMPT_EOL_MARK=''\n`);
  for (const f of [".zshenv", ".zprofile", ".zlogin"]) writeFileSync(join(zdot, f), "");

  const name = `iamceo-test-${Math.random().toString(36).slice(2, 10)}`;
  const socketPath = join(homedir(), ".config", "herdr", "sessions", name, "herdr.sock");
  assertIsolatedSocket(socketPath);
  const client = Bun.spawn(["herdr", "--session", name], {
    cwd: join(dir, "work"),
    env: opts.realClaude
      ? cleanEnv({ SHELL: "/bin/zsh", TERM: process.env.TERM ?? "xterm-256color" })
      : cleanEnv({ PATH: `${binDir}:${process.env.PATH}`, SHELL: "/bin/zsh", ZDOTDIR: zdot, IAMCEO_FAKE_DIR: fakeDir }),
    terminal: { cols: opts.cols ?? 160, rows: opts.rows ?? 50, data() {} },
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    try { await rpc(socketPath, "ping", {}, 1000); break; }
    catch (e) {
      if (Date.now() > deadline) { client.kill(); throw new Error(`격리 herdr 가 뜨지 않음: ${String(e)}`); }
      await Bun.sleep(150);
    }
  }

  return {
    name, socketPath, dir, fakeDir, fakeClaudePath,
    async stop() {
      assertIsolatedSocket(socketPath);
      const stop = Bun.spawn(["herdr", "--session", name, "server", "stop"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: cleanEnv({}) });
      await stop.exited;
      client.kill();
      await client.exited;
      const del = Bun.spawn(["herdr", "session", "delete", name], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: cleanEnv({}) });
      await del.exited;
    },
  };
}
