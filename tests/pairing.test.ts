import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { type Config, loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { type RunningServer, startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { normalizePairCode, Pairing, PAIR_CODE_LENGTH, PAIR_CODE_TTL_MS, tailnetUrls, withMagicDnsNames } from "../server/pairing.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const CODE = "test-access-code";

describe("짝 맺기 코드", () => {
  test("8자리, 헷갈리는 글자 없음, 한 번만 쓴다", () => {
    const pairing = new Pairing();
    const { code } = pairing.start();
    expect(code).toHaveLength(PAIR_CODE_LENGTH);
    expect(code).not.toMatch(/[01OIL]/);
    expect(pairing.claim(code, "100.64.0.2")).toBe("ok");
    expect(pairing.claim(code, "100.64.0.2")).toBe("invalid");
  });

  test("5분이 지나면 쓸 수 없다", () => {
    let now = 1_000_000;
    const pairing = new Pairing(() => now);
    const { code, expiresAt } = pairing.start();
    expect(expiresAt).toBe(now + PAIR_CODE_TTL_MS);
    now += PAIR_CODE_TTL_MS;
    expect(pairing.claim(code, "100.64.0.2")).toBe("invalid");
  });

  test("소문자·하이픈·공백을 섞어 넣어도 받는다", () => {
    const pairing = new Pairing();
    const { code } = pairing.start();
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `;
    expect(normalizePairCode(typed)).toBe(code);
    expect(pairing.claim(typed, "100.64.0.2")).toBe("ok");
  });

  test("같은 주소에서 10번 틀리면 막고, 맞는 코드도 그동안은 받지 않는다", () => {
    const pairing = new Pairing();
    const { code } = pairing.start();
    for (let i = 0; i < 10; i++) expect(pairing.claim("WRONGCOD", "100.64.0.9")).toBe("invalid");
    expect(pairing.claim(code, "100.64.0.9")).toBe("limited");
    // 다른 기기는 영향을 받지 않는다
    expect(pairing.claim(code, "100.64.0.10")).toBe("ok");
  });

  test("열린 코드는 5개까지만 두고 가장 오래된 것부터 버린다", () => {
    const pairing = new Pairing();
    const first = pairing.start().code;
    for (let i = 0; i < 5; i++) pairing.start();
    expect(pairing.claim(first, "100.64.0.2")).toBe("invalid");
  });

  test("인증 회전은 미사용 QR을 모두 지우고 새 QR만 허용한다", () => {
    const pairing = new Pairing();
    const first = pairing.start().code;
    const second = pairing.start().code;
    pairing.invalidate();
    expect(pairing.claim(first, "fixture")).toBe("invalid");
    expect(pairing.claim(second, "fixture")).toBe("invalid");
    expect(pairing.claim(pairing.start().code, "fixture")).toBe("ok");
  });

  test("Tailscale IP 마다 MagicDNS 이름 주소를 앞에 붙이고, 못 찾으면 IP 만 남긴다", async () => {
    const reverse = async (ip: string) => (ip === "100.92.29.67" ? ["mac-mini.tail6b5aa2.ts.net."] : []);
    expect(await withMagicDnsNames(["http://100.92.29.67:7878"], reverse)).toEqual(["http://mac-mini.tail6b5aa2.ts.net:7878", "http://100.92.29.67:7878"]);
    expect(await withMagicDnsNames(["http://100.64.0.9:7878"], reverse)).toEqual(["http://100.64.0.9:7878"]);
    const failing = async () => { throw new Error("no resolver"); };
    expect(await withMagicDnsNames(["http://100.64.0.10:7878"], failing)).toEqual(["http://100.64.0.10:7878"]);
  });

  test("Tailscale 주소만 고른다", () => {
    expect(tailnetUrls(["http://127.0.0.1:7878", "http://100.92.29.67:7878", "http://192.168.0.4:7878", "http://[fd7a:115c:a1e0::1]:7878", "http://100.200.0.1:7878"]))
      .toEqual(["http://100.92.29.67:7878", "http://[fd7a:115c:a1e0::1]:7878"]);
  });
});

describe("짝 맺기 HTTP", () => {
  let server: RunningServer;
  let base: string;
  let isolated: ReturnType<typeof createIsolatedRuntime>;
  let store: Store;

  beforeAll(async () => {
    isolated = createIsolatedRuntime();
    const env = isolated.childEnv();
    updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
    const config: Config = loadConfig(env);
    const bus = new Bus();
    store = new Store(openDb(config.dbPath), bus);
    const orch = {} as OrchestratorApi;
    server = await startServer({ config, store, bus, orch, detectHosts: () => [] });
    while (server.port === 7878) { await server.stop(); server = await startServer({ config, store, bus, orch, detectHosts: () => [] }); }
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server.stop();
    store.db.close();
    await isolated.stop();
  });

  const start = (auth = true) =>
    fetch(`${base}/api/pair/start`, { method: "POST", headers: auth ? { Authorization: `Bearer ${CODE}` } : {} });
  const claim = (code: unknown) =>
    fetch(`${base}/pair/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, device: "iPhone" }) });

  test("코드 만들기는 접속 코드가 있어야 한다", async () => {
    expect((await start(false)).status).toBe(401);
    const res = await start();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expiresAt: string; ttlSeconds: number; urls: string[] };
    expect(body.code).toHaveLength(PAIR_CODE_LENGTH);
    expect(body.ttlSeconds).toBe(PAIR_CODE_TTL_MS / 1000);
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
    // 이 시험 서버는 127.0.0.1 에만 떠 있어 폰이 닿을 주소가 없다
    expect(body.urls).toEqual([]);
  });

  test("맞는 코드를 낸 기기만 접속 코드를 받고, 같은 코드는 다시 쓸 수 없다", async () => {
    const { code } = (await (await start()).json()) as { code: string };
    const ok = await claim(code);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(((await ok.json()) as { accessCode: string }).accessCode).toBe(CODE);
    const again = await claim(code);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: string }).error).toContain("새 QR");
  });

  test("성공 응답 유실은 코드 재사용 대신 새 QR로 복구한다", async () => {
    const { code } = await (await start()).json() as { code: string };
    const lost = await claim(code);
    await lost.body?.cancel();
    const retry = await claim(code);
    expect(retry.status).toBe(401);
    expect((await retry.json() as { error: string }).error).toContain("새 QR");
    const replacement = await (await start()).json() as { code: string };
    expect((await claim(replacement.code)).status).toBe(200);
  });

  test("코드가 없거나 형식이 틀리면 400, GET 은 405", async () => {
    expect((await claim(42)).status).toBe(400);
    expect((await fetch(`${base}/pair/claim`)).status).toBe(405);
  });
});
