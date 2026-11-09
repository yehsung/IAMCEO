import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Pairing, PAIR_CODE_TTL_MS } from "../server/pairing.ts";
import { Store } from "../server/store.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

describe("UX-T10 pairing lifecycle", () => {
  test("claim is not connection; only the matching exchange proof can ACK", () => {
    const pairing = new Pairing();
    const { code } = pairing.start();
    expect(pairing.status(code)).toEqual({ code, status: "pending" });
    expect(pairing.acknowledge(code, "x".repeat(64))).toBe(false);
    expect(pairing.claim(code, "fixture")).toBe("ok");
    expect(pairing.status(code).status).toBe("claimed");
    const token = pairing.confirmationToken(code)!;
    const other = pairing.start().code;
    pairing.claim(other, "fixture");
    expect(pairing.acknowledge(other, token)).toBe(false);
    expect(pairing.acknowledge(code, "x".repeat(64))).toBe(false);
    expect(pairing.status(code).status).toBe("claimed");
    expect(pairing.acknowledge(code.toLowerCase(), token)).toBe(true);
    expect(pairing.acknowledge(code, token)).toBe(true);
    expect(pairing.status(code)).toEqual({ code, status: "connected" });
    expect(pairing.claim(code, "fixture")).toBe("invalid");
  });

  test("expiry, eviction, restart and credential rotation never mean connected", () => {
    let now = 1000;
    const pairing = new Pairing(() => now);
    const expired = pairing.start().code;
    pairing.claim(expired, "fixture");
    const token = pairing.confirmationToken(expired)!;
    now += PAIR_CODE_TTL_MS;
    expect(pairing.status(expired).status).toBe("expired");
    expect(pairing.acknowledge(expired, token)).toBe(false);
    const evicted = pairing.start().code;
    for (let i = 0; i < 5; i++) pairing.start();
    expect(pairing.status(evicted).status).toBe("expired");
    const rotated = pairing.start().code;
    pairing.claim(rotated, "fixture");
    const rotatedToken = pairing.confirmationToken(rotated)!;
    pairing.acknowledge(rotated, rotatedToken);
    pairing.invalidate();
    expect(pairing.status(rotated).status).toBe("expired");
    expect(pairing.acknowledge(rotated, rotatedToken)).toBe(false);
    expect(new Pairing().status(rotated).status).toBe("expired");
  });

  test("claimed status survives issuing five other QR codes, but expires on its original deadline", () => {
    let now = 1000;
    const pairing = new Pairing(() => now);
    const code = pairing.start().code;
    pairing.claim(code, "fixture");
    for (let i = 0; i < 6; i++) pairing.start();
    expect(pairing.status(code).status).toBe("claimed");
    pairing.acknowledge(code, pairing.confirmationToken(code)!);
    now += PAIR_CODE_TTL_MS;
    expect(pairing.status(code).status).toBe("expired");
  });
});

describe("UX-T10 authenticated pairing status and ACK", () => {
  let server: RunningServer;
  let store: Store;
  let isolated: ReturnType<typeof createIsolatedRuntime>;
  let base: string;
  const credential = "ux-t10-fixture";
  const headers = { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" };

  beforeAll(async () => {
    isolated = createIsolatedRuntime();
    const env = isolated.childEnv();
    updateConfigFile({ accessCode: credential, hosts: ["127.0.0.1"], port: 0 }, env);
    const config = loadConfig(env), bus = new Bus();
    store = new Store(openDb(config.dbPath), bus);
    server = await startServer({ config, store, bus, orch: {} as OrchestratorApi, detectHosts: () => [] });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server?.stop();
    store?.db.close();
    await isolated?.stop();
  });
  const start = async () => (await (await fetch(`${base}/api/pair/start`, { method: "POST", headers })).json()) as { code: string };
  const status = (code: string) => fetch(`${base}/api/pair/status?code=${encodeURIComponent(code)}`, { headers });
  const ack = (code: string, confirmationToken: string, authenticated = true) => fetch(`${base}/api/pair/ack`, {
    method: "POST", headers: authenticated ? headers : { "Content-Type": "application/json" }, body: JSON.stringify({ code, confirmationToken }),
  });

  test("status requires Bearer, rejects malformed query, and does not expose exchange proof", async () => {
    const { code } = await start();
    expect((await fetch(`${base}/api/pair/status?code=${code}`)).status).toBe(401);
    expect((await fetch(`${base}/api/pair/status?code=${code}&t=${credential}`)).status).toBe(401);
    for (const query of ["", "?code=", `?code=${code}&code=${code}`, `?code=${code}&extra=1`]) {
      expect((await fetch(`${base}/api/pair/status${query}`, { headers })).status).toBe(400);
    }
    const response = await status(code);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code, status: "pending" });
    expect(await (await status("UNKNOWN")).json()).toEqual({ code: "UNKNOWN", status: "expired" });
  });

  test("phone exchange plus authenticated ACK is required, and repeated ACK is idempotent", async () => {
    const { code } = await start();
    expect((await ack(code, "x".repeat(64))).status).toBe(409);
    const exchange = await fetch(`${base}/pair/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    const body = await exchange.json() as { accessCode: string; confirmationToken: string };
    expect(body.accessCode).toBe(credential);
    expect(body.confirmationToken).toHaveLength(64);
    expect(await (await status(code)).json()).toEqual({ code, status: "claimed" });
    expect((await ack(code, body.confirmationToken, false)).status).toBe(401);
    expect((await ack(code, "x".repeat(64))).status).toBe(409);
    expect((await ack(code, "bad")).status).toBe(400);
    expect(await (await ack(code, body.confirmationToken)).json()).toEqual({ code, status: "connected" });
    const repeated = await ack(code, body.confirmationToken);
    expect(repeated.headers.get("cache-control")).toBe("no-store");
    expect(await repeated.json()).toEqual({ code, status: "connected" });
    expect(await (await status(code)).json()).toEqual({ code, status: "connected" });
  });
});
