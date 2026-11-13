// 배포 런타임은 Node 22 다(시험은 Bun). Mac 의 HTTP/2 전송은 Bun 에 맞춰 다듬어졌으므로, 같은 코드를 Node 로 묶어
// 가짜 APNs(TLS·HTTP/2)에 보내 본다: 받기·동시 스트림·멈춘 건 504·410·동시 20건·듣개 경고 없음.
// 배포 묶음(lib/index.js)도 Node 로 불러 Firebase 가 읽는 함수 선언이 나오는지 본다.
import { afterEach, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { fakeApns, reply, tempDir, testKey } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const node = Bun.which("node");
const functions = join(import.meta.dir, "..");

async function runNode(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn([node!, ...args], { cwd: functions, env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 30_000);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  return { status: await child.exited, stdout, stderr };
}

describe("Node 런타임", () => {
  test("node 가 있어야 한다(배포 런타임 확인용)", () => {
    expect(node).toBeTruthy();
  });
  test("가짜 APNs 로 받기·동시 스트림·멈춤 504·410·동시 20건, 듣개 경고 없음", async () => {
    const server = await fakeApns(cleanups, (stream, received) => {
      const token = String(received.headers[":path"]).split("/").pop();
      if (token === "ee".repeat(32)) return; // 멈춘 건: 답하지 않는다
      if (token === "dd".repeat(32)) { reply(stream, 410, { reason: "Unregistered", timestamp: 1_790_000_000_000 }); return; }
      setTimeout(() => reply(stream, 200), 30);
    });
    const dir = tempDir(cleanups);
    const outfile = join(dir, "harness.mjs");
    await build({ entryPoints: [join(import.meta.dir, "node-harness.ts")], outfile, bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "silent" });
    const key = testKey();
    const run = await runNode([outfile], { FAKE_APNS_PORT: String(server.port), FAKE_APNS_CA: server.certPath, FAKE_APNS_KEY: key.pem });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout.trim().split("\n").pop()!);
    expect(result.node).toMatch(/^\d+\./);
    expect(result).toMatchObject({ created: 201, accepted: 200, quick: 200, stalled: 504,
      gone: { status: 410, body: { state: "invalid", reason: "Unregistered", timestamp: 1_790_000_000_000 } } });
    expect(result.quickMs).toBeLessThan(1_000);
    expect(result.burst).toEqual(Array(20).fill(200));
    expect(result.warnings).toEqual([]);
  }, 40_000);
  test("배포 묶음(lib/index.js)을 Node 로 불러 함수 선언을 읽는다(Firebase CLI 가 하는 일)", async () => {
    const dir = tempDir(cleanups);
    const outfile = join(dir, "index.mjs");
    // scripts/build.mjs 와 같은 설정으로 묶는다(저장소의 lib/ 를 건드리지 않게 임시 폴더로).
    const made = spawnSync(node!, [join(functions, "scripts", "build.mjs"), join(functions, "src", "index.ts"), outfile], { cwd: functions, encoding: "utf8" });
    expect(made.stderr).toBe("");
    expect(made.status).toBe(0);
    // 묶음 밖의 firebase-functions 는 functions/node_modules 에서 찾게 한다(ESM 은 NODE_PATH 를 보지 않는다).
    symlinkSync(join(functions, "node_modules"), join(dir, "node_modules"), "dir");
    const probe = `const m = await import(${JSON.stringify(outfile)}); process.stdout.write(JSON.stringify({ keys: Object.keys(m), endpoint: m.relay.__endpoint }));`;
    const run = await runNode(["--input-type=module", "-e", probe], {});
    if (run.status !== 0) throw new Error(run.stderr.slice(0, 500));
    const { keys, endpoint } = JSON.parse(run.stdout);
    expect(keys).toEqual(["relay"]);
    expect(endpoint).toMatchObject({ region: ["us-central1"], maxInstances: 1, minInstances: 0, httpsTrigger: { invoker: ["public"] } });
  }, 40_000);
});
