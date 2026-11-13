// 배포 설정: 함수 선언(지역·인스턴스·비밀·공개 호출), firebase.json 다시 쓰기, 실제 Firebase 감싸개를 거친 배선과 로그.
// 진짜 APNs 에 닿지 않게 키를 일부러 틀리게 넣는다(키 오류 → 503, 연결 없음).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import express from "express";
import { RELAY_FUNCTION_NAME, RELAY_REGION, RELAY_RUNTIME } from "../src/settings.ts";

const root = join(import.meta.dir, "..", "..");
const firebase = JSON.parse(readFileSync(join(root, "firebase.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "functions", "package.json"), "utf8"));

describe("firebase.json·package.json", () => {
  test("함수 폴더·런타임·배포 전 빌드", () => {
    expect(firebase.functions.source).toBe("functions");
    expect(firebase.functions.runtime).toBe("nodejs22");
    expect(pkg.engines.node).toBe("22");
    expect(pkg.main).toBe("lib/index.js");
    expect(firebase.functions.predeploy.join(" ")).toContain("run build");
    expect(firebase.functions.ignore).toEqual(expect.arrayContaining(["node_modules", "src", "test"]));
    expect(firebase.functions.ignore).not.toContain("lib");
    // Cloud Functions 의 빌드는 build 스크립트가 있으면 npm run build 를 돌린다. src·scripts 는 올리지 않으므로
    // 빈 gcp-build 로 그 단계를 건너뛴다(배포 전 묶음 lib/ 를 그대로 쓴다).
    expect(pkg.scripts["gcp-build"]).toBe("");
  });
  test("Firebase Hosting 을 앞에 두지 않는다(Hosting 은 요청 IP 를 몇 달 보관한다). Mac 은 함수 주소로 바로 부른다", () => {
    expect(Object.keys(firebase)).toEqual(["functions"]);
    expect(existsSync(join(root, "public"))).toBe(false);
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).not.toMatch(/web\.app|--only functions,hosting|pbcopy/);
    // 주소에 지역이 들어가므로 README 의 지역 안내가 코드와 같아야 한다.
    expect(readme).toContain(`\`${RELAY_REGION}\``);
  });
  test("의존성은 정확한 판으로 고정, Node 22 에서 도는 판", () => {
    for (const version of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) expect(String(version)).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(readFileSync(join(root, "functions", "package-lock.json"), "utf8"));
    for (const [name, entry] of Object.entries(lock.packages as Record<string, { engines?: { node?: string }; dev?: boolean }>)) {
      const engine = entry.engines?.node;
      if (!engine || entry.dev) continue;
      // Node 22 를 막는 판(예: >=24)이 실행 의존성에 들어오면 배포한 함수가 뜨지 않을 수 있다(2026-11 에 실제로 생겼다).
      expect({ name, ok: Bun.semver.satisfies("22.20.0", engine) }).toEqual({ name, ok: true });
    }
  });
});

const env = { RELAY_MASTER: "deploy-test-master-0123456789abcdefghij", APNS_KEY_P8: "not a key", APNS_KEY_ID: "TESTKEY123",
  APNS_TEAM_ID: "TEAMID1234", RELAY_MODE: "open", RELAY_ALLOWED_INSTALLATIONS: "", RELAY_BLOCKED_INSTALLATIONS: "" };
const saved: Record<string, string | undefined> = {};
let server: Server;
let base = "";
const output: string[] = [];
const originalOut = process.stdout.write.bind(process.stdout);
const originalErr = process.stderr.write.bind(process.stderr);

beforeAll(async () => {
  for (const [name, value] of Object.entries(env)) { saved[name] = process.env[name]; process.env[name] = value; }
  const { relay } = await import("../src/index.ts");
  const app = express();
  // Firebase 함수 틀처럼 본문을 그대로 넘긴다.
  app.use(express.raw({ type: "*/*", limit: "1mb" }));
  app.all(/.*/, (req, res) => { void relay(req as never, res); });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  process.stdout.write = originalOut; process.stderr.write = originalErr;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

describe("index.ts(실제 firebase-functions 감싸개)", () => {
  test("함수 선언: 이름·지역·인스턴스 1·동시성·메모리·시간·비밀 두 개·누구나 호출", async () => {
    const module = await import("../src/index.ts");
    expect(Object.keys(module)).toEqual([RELAY_FUNCTION_NAME]);
    const endpoint = (module.relay as unknown as { __endpoint: Record<string, unknown> }).__endpoint;
    expect(endpoint).toMatchObject({
      platform: "gcfv2", region: [RELAY_REGION], maxInstances: RELAY_RUNTIME.maxInstances, minInstances: RELAY_RUNTIME.minInstances,
      concurrency: RELAY_RUNTIME.concurrency, cpu: RELAY_RUNTIME.cpu, availableMemoryMb: 256, timeoutSeconds: RELAY_RUNTIME.timeoutSeconds,
      httpsTrigger: { invoker: ["public"] },
    });
    expect(endpoint.maxInstances).toBe(1);
    expect((endpoint.secretEnvironmentVariables as { key: string }[]).map((item) => item.key).sort()).toEqual(["APNS_KEY_P8", "RELAY_MASTER"]);
  });
  test("등록 → 보내기(키 오류라 503, APNs 연결 없음) → healthz, 로그는 구조화 한 줄이고 비밀·토큰·IP 가 없다", async () => {
    output.length = 0;
    const capture = (chunk: string | Uint8Array) => { output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()); return true; };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    try {
      const created = await fetch(`${base}/v1/installations`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77" }, body: '{"protocol":1}' });
      expect(created.status).toBe(201);
      const { installationId, secret } = await created.json() as { installationId: string; secret: string };
      const token = "c0ffee".repeat(10) + "abcd";
      const push = await fetch(`${base}/relay/v1/push`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${installationId}.${secret}`, "x-forwarded-for": "198.51.100.77" },
        body: JSON.stringify({ token, kind: "test", id: crypto.randomUUID(), eventId: crypto.randomUUID(), serverId: crypto.randomUUID(), target: { screen: "home" } }) });
      expect(push.status).toBe(503);
      expect(await push.json()).toEqual({ reason: "relay_unavailable" });
      expect(push.headers.get("retry-after")).toBe("600");
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(503);
      expect(await health.json()).toMatchObject({ ok: false, mode: "open", apns: { suspended: true, reason: "key_error" } });
      const text = output.join("");
      for (const secretValue of [env.RELAY_MASTER, secret, token, "198.51.100.77", installationId + "." + secret, "not a key"]) expect(text).not.toContain(secretValue);
      const lines = text.split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        expect(["severity", "message", "reason", "until", "installationId", "name", "hour", "counts"]).toEqual(expect.arrayContaining(Object.keys(entry)));
      }
      expect(lines.map((line) => JSON.parse(line).message)).toContain("apns_suspended");
    } finally {
      process.stdout.write = originalOut; process.stderr.write = originalErr;
    }
  });
});
