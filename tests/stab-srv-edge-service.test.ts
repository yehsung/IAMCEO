// launchd 서비스 등록·재시작, 잠자기 방지, 로그 시각. 실제 launchctl·caffeinate 는 부르지 않는다.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keepAwake, launchdPlist, service } from "../bin/iamceo.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { lineStamper } from "../server/log-writer.ts";

const newHome = () => mkdtempSync(join(process.env.TMPDIR ?? "/private/tmp/", "iamceo-stab-service-"));

function fixture() {
  const home = newHome();
  const config = loadConfig({ IAMCEO_HOME: home, IAMCEO_PORT: "0" });
  const calls: string[] = [];
  const sleeps: number[] = [];
  const state = { loaded: false, bootout: () => ({ ok: true, output: "" }), bootstrap: () => ({ ok: true, output: "" }), downAfterPrints: 0 };
  const logs: string[] = [];
  const dependencies = { home, config, program: ["/fixture/iamceo", "service-run"],
    launchctl: (...args: string[]) => {
      calls.push(args[0]!);
      if (args[0] === "print") {
        if (state.loaded && state.downAfterPrints > 0 && --state.downAfterPrints === 0) state.loaded = false;
        return { ok: state.loaded, output: "" };
      }
      if (args[0] === "bootout") return state.bootout();
      const result = state.bootstrap();
      if (result.ok) state.loaded = true;
      return result;
    },
    readiness: async () => { calls.push("readiness"); },
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
  const plistPath = join(home, "Library/LaunchAgents/com.iamceo.server.plist");
  async function run(args: string[]) {
    const original = console.log;
    console.log = (...values: unknown[]) => { logs.push(values.join(" ")); };
    try { await service(args, dependencies); } finally { console.log = original; }
  }
  return { home, config, calls, sleeps, state, logs, dependencies, plistPath, run };
}

test("perf-1: 서비스는 Interactive 등급으로 등록되고, 옛 설정으로 떠 있으면 갱신 방법을 알린다", async () => {
  const f = fixture();
  await f.run(["install"]);
  expect(readFileSync(f.plistPath, "utf8")).toContain("<key>ProcessType</key>\n  <string>Interactive</string>");
  f.logs.length = 0; f.calls.length = 0;
  await f.run(["install"]);
  // 같은 설정이면 조용히 확인만 한다.
  expect(f.logs.join("\n")).not.toContain("--restart");
  expect(f.calls).toEqual(["print", "readiness"]);
  // 등급이 없는 옛 설정으로 떠 있는 서비스: 멈추지 않고 알리기만 한다.
  const old = readFileSync(f.plistPath, "utf8").replace("  <key>ProcessType</key>\n  <string>Interactive</string>\n", "");
  expect(old).not.toContain("ProcessType");
  writeFileSync(f.plistPath, old);
  f.logs.length = 0; f.calls.length = 0;
  await f.run(["install"]);
  expect(f.logs.join("\n")).toContain("iamceo service install --restart");
  expect(f.calls).toEqual(["print", "readiness"]);
  expect(readFileSync(f.plistPath, "utf8")).toBe(old);
  // --restart 가 새 설정으로 바꾼다.
  await f.run(["install", "--restart"]);
  expect(readFileSync(f.plistPath, "utf8")).toContain("<key>ProcessType</key>");
});

test("ops-4: 재시작은 서비스가 다 내려갈 때까지 기다리고, 일시적인 등록 거절은 다시 건다", async () => {
  const f = fixture();
  await f.run(["install"]);
  f.calls.length = 0;
  // 서버가 아직 내려가는 중: bootout 이 36 을 주고 세 번째 확인에서야 사라진다.
  f.state.bootout = () => ({ ok: false, output: "Boot-out failed: 36: Operation now in progress" });
  f.state.downAfterPrints = 4; // 첫 print(등록 확인) + 대기 중 3회
  let attempts = 0;
  f.state.bootstrap = () => ++attempts < 3 ? { ok: false, output: "Bootstrap failed: 5: Input/output error" } : { ok: true, output: "" };
  await f.run(["install", "--restart"]);
  expect(f.calls).toEqual(["print", "bootout", "print", "print", "print", "bootstrap", "bootstrap", "bootstrap", "readiness"]);
  expect(f.sleeps).toEqual([500, 500, 1000, 1000]);
  expect(f.state.loaded).toBe(true);
});

test("ops-4: 진짜 bootout 실패는 바로 알리고, 끝내 못 올리면 서비스가 내려가 있다고 알린다", async () => {
  const f = fixture();
  await f.run(["install"]);
  f.state.bootout = () => ({ ok: false, output: "Boot-out failed: 1: Operation not permitted" });
  f.calls.length = 0;
  // 명령줄 문구는 실행 환경의 언어(LANG)를 따른다(server/cli-text.ts). 시험은 두 언어 모두 받는다.
  await expect(f.run(["install", "--restart"])).rejects.toThrow(/서비스 재시작 실패|Restarting the service failed/);
  expect(f.calls).toEqual(["print", "bootout"]);
  expect(f.sleeps).toEqual([]);

  f.state.bootout = () => { f.state.loaded = false; return { ok: true, output: "" }; };
  f.state.bootstrap = () => ({ ok: false, output: "Bootstrap failed: 5: Input/output error" });
  f.calls.length = 0;
  const failure = await f.run(["install", "--restart"]).then(() => null, (error: Error) => error);
  expect(failure?.message).toMatch(/launchd 등록 실패|Registering with launchd failed/);
  expect(failure?.message).toMatch(/서비스가 내려가 있습니다|The service is down now/);
  expect(failure?.message).toContain("iamceo service install");
  // 처음 한 번 + 다시 걸기 5회, 그 뒤에는 멈춘다.
  expect(f.calls.filter(call => call === "bootstrap")).toHaveLength(6);
  expect(f.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
});

test("ops-10: 서버가 떠 있는 동안 유휴 잠자기만 막고, 설정·시험·다른 OS 에서는 띄우지 않는다", () => {
  const spawned: string[][] = [];
  let killed = 0;
  const spawn = (command: string[]) => { spawned.push(command); return { kill: () => { killed++; } }; };
  const stop = keepAwake({}, { platform: "darwin", test: false, pid: 4242, spawn });
  expect(spawned).toEqual([["/usr/bin/caffeinate", "-i", "-w", "4242"]]);
  stop!(); expect(killed).toBe(1);
  expect(keepAwake({ keepAwake: false }, { platform: "darwin", test: false, spawn })).toBeUndefined();
  expect(keepAwake({}, { platform: "darwin", test: true, spawn })).toBeUndefined();
  expect(keepAwake({}, { platform: "linux", test: false, spawn })).toBeUndefined();
  expect(spawned).toHaveLength(1);
  // 띄우지 못해도 서버 시작을 막지 않는다.
  const original = console.error; console.error = () => {};
  try { expect(keepAwake({}, { platform: "darwin", test: false, spawn: () => { throw new Error("ENOENT"); } })).toBeUndefined(); }
  finally { console.error = original; }
});

test("ops-10: config.json 의 keepAwake 는 false 만 끄고, 다른 값은 거부한다", () => {
  const home = newHome();
  expect(loadConfig({ IAMCEO_HOME: home }).keepAwake).toBeUndefined();
  updateConfigFile({ keepAwake: false }, { IAMCEO_HOME: home });
  expect(loadConfig({ IAMCEO_HOME: home }).keepAwake).toBe(false);
  // 다른 필드를 고쳐도 남는다.
  updateConfigFile({ port: 7003 }, { IAMCEO_HOME: home });
  expect(loadConfig({ IAMCEO_HOME: home }).keepAwake).toBe(false);
  expect(() => updateConfigFile({ keepAwake: "no" as unknown as boolean }, { IAMCEO_HOME: home })).toThrow();
});

test("ops-8: 감독 프로세스가 로그 줄마다 받은 시각을 붙인다(청크 경계·빈 줄 포함)", () => {
  let at = Date.parse("2026-11-10T03:03:00.000Z");
  const stamp = lineStamper(() => new Date(at));
  const text = (chunk: Uint8Array) => Buffer.from(chunk).toString("utf8");
  expect(text(stamp(Buffer.from("[startup] ready\n한 줄")))).toBe("2026-11-10T03:03:00.000Z [startup] ready\n2026-11-10T03:03:00.000Z 한 줄");
  at += 1500;
  // 앞 청크에서 이어지는 줄에는 다시 붙이지 않는다.
  expect(text(stamp(Buffer.from(" 끝\n\n  at stack\n")))).toBe(" 끝\n\n2026-11-10T03:03:01.500Z   at stack\n");
  expect(text(stamp(Buffer.from("다음\n")))).toBe("2026-11-10T03:03:01.500Z 다음\n");
  expect(stamp(new Uint8Array(0)).byteLength).toBe(0);
  expect(text(stamp(Buffer.from("\n\n")))).toBe("\n\n");
});

test("plist 는 plutil 검사를 통과한다", () => {
  const plist = launchdPlist({ program: ["/bin/bun", "/a/iamceo.ts", "serve"], home: "/Users/u", logDir: "/Users/u/.iamceo/logs", workingDir: "/Users/u" });
  const file = join(newHome(), "t.plist");
  writeFileSync(file, plist);
  expect(Bun.spawnSync(["plutil", "-lint", file]).exitCode).toBe(0);
  expect(Bun.spawnSync(["plutil", "-extract", "ProcessType", "raw", "-o", "-", file]).stdout.toString().trim()).toBe("Interactive");
});
