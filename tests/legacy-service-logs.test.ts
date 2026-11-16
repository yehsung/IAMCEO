// 0.2.7 D4-6: 라이브 서비스 설정(plist)이 옛 형식이라 launchd 가 stdout·stderr 를 로그 파일로 바로 열었고(IAMCEO_LOG_WRITER 없음)
// 서버 로그에 시각이 없고 돌려쓰기도 없었다. plist 를 바꾸지 않아도, 그렇게 뜬 serve 가 스스로 로그 감독자가 되어 줄마다 시각을 붙이고 크기를 묶는다.
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { legacyServiceLogs } from "../bin/iamceo.ts";
import { updateConfigFile } from "../server/config.ts";

const CLI = resolve(import.meta.dir, "..", "bin", "iamceo.ts");
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });

describe("옛 서비스 설정 알아보기 (D4-6)", () => {
  const file = (dev: number, ino: number) => ({ isFile: () => true, dev, ino });
  const stats = (fds: Record<number, ReturnType<typeof file>>, paths: Record<string, { dev: number; ino: number }>) => ({
    fd: (fd: number) => { const s = fds[fd]; if (!s) throw new Error("EBADF"); return s; },
    path: (path: string) => { const s = paths[path]; if (!s) throw new Error("ENOENT"); return s; },
  });
  const home = "/fixture/home/.iamceo";
  const logs = { [`${home}/logs/server.log`]: { dev: 1, ino: 10 }, [`${home}/logs/server.err.log`]: { dev: 1, ino: 11 } };

  test("launchd 의 그 서비스이고 표준 출력·오류가 바로 그 로그 파일이면 참", () => {
    const s = stats({ 1: file(1, 10), 2: file(1, 11) }, logs);
    expect(legacyServiceLogs({ XPC_SERVICE_NAME: "com.iamceo.server" }, home, s.fd, s.path)).toBe(true);
    const errOnly = stats({ 2: file(1, 11) }, logs);
    expect(legacyServiceLogs({ XPC_SERVICE_NAME: "com.iamceo.server" }, home, errOnly.fd, errOnly.path)).toBe(true);
  });

  test("새 형식(감독자·그 자식), 다른 프로그램, 손으로 띄운 serve, 다른 파일로 돌린 출력이면 거짓", () => {
    const s = stats({ 1: file(1, 10), 2: file(1, 11) }, logs);
    expect(legacyServiceLogs({ XPC_SERVICE_NAME: "com.iamceo.server", IAMCEO_LOG_WRITER: "1" }, home, s.fd, s.path)).toBe(false);
    expect(legacyServiceLogs({ XPC_SERVICE_NAME: "com.iamceo.server", IAMCEO_LOG_WRITER: "0" }, home, s.fd, s.path)).toBe(false);
    expect(legacyServiceLogs({ XPC_SERVICE_NAME: "application.com.apple.Terminal.123" }, home, s.fd, s.path)).toBe(false);
    expect(legacyServiceLogs({}, home, s.fd, s.path)).toBe(false);
    const elsewhere = stats({ 1: file(1, 99), 2: file(1, 98) }, logs);
    expect(legacyServiceLogs({ XPC_SERVICE_NAME: "com.iamceo.server" }, home, elsewhere.fd, elsewhere.path)).toBe(false);
    const pipe = stats({ 1: { ...file(1, 10), isFile: () => false }, 2: { ...file(1, 11), isFile: () => false } }, logs);
    expect(legacyServiceLogs({ XPC_SERVICE_NAME: "com.iamceo.server" }, home, pipe.fd, pipe.path)).toBe(false);
  });

  test("옛 설정처럼 로그 파일로 바로 출력을 연 serve 는 감독자가 되어 줄마다 시각을 붙이고, SIGTERM 에 서버까지 정리한다", async () => {
    const home = mkdtempSync(join(tmpdir(), "iamceo-legacy-"));
    for (const dir of ["claude", "codex", "logs"]) mkdirSync(join(home, dir), { recursive: true, mode: 0o700 });
    updateConfigFile({ hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home });
    const out = openSync(join(home, "logs", "server.log"), "a"), err = openSync(join(home, "logs", "server.err.log"), "a");
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", IAMCEO_LANG: "ko", IAMCEO_HOME: home, IAMCEO_PORT: "0", IAMCEO_TEST: "1",
      IAMCEO_HERDR_SOCKET: join(home, "no-herdr.sock"), IAMCEO_CORE_SOCKET: join(home, "no-core.sock"), IAMCEO_CORE_BIN: "/usr/bin/false",
      IAMCEO_CLAUDE_BIN: "/usr/bin/false", IAMCEO_CODEX_BIN: "/usr/bin/false", CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"),
      XPC_SERVICE_NAME: "com.iamceo.server" };
    const p = Bun.spawn([process.execPath, CLI, "serve"], { stdin: "ignore", stdout: out, stderr: err, env });
    closeSync(out); closeSync(err);
    stops.push(async () => { if (p.exitCode === null) { p.kill("SIGTERM"); await p.exited; } });
    const log = join(home, "logs", "server.log"), errLog = join(home, "logs", "server.err.log");
    const end = Date.now() + 15_000;
    let text = "";
    while (Date.now() < end && p.exitCode === null) {
      text = existsSync(log) ? readFileSync(log, "utf8") : "";
      if (/http:\/\/127\.0\.0\.1:\d+/.test(text)) break;
      await Bun.sleep(30);
    }
    expect(text).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    // 서버가 쓴 줄마다 받은 시각이 붙는다(감독자의 lineStamper).
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    expect(readFileSync(errLog, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[service\] 옛 서비스 설정/m);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    // 감독자와 서버가 모두 내려가 홈을 다시 쓸 수 있다.
    const { acquireHomeOwner } = await import("../server/home-owner.ts");
    using owner = acquireHomeOwner(home);
    expect(owner).toBeTruthy();
  }, 30_000);
});
