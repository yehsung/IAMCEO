// 0.2.9 큰 JSON 답을 gzip 으로 보내기(server/compress.ts). 폰이 멀리서 붙을 때 대화창이 뜨는 시간을 줄인다.
// 이 Mac 안에서 온 요청은 줄이지 않는다. 시험은 HTTPS 주소(tailscale serve)가 넘겨준 요청처럼 대리 전달 머리글을 붙여 '다른 기기'를 흉내 낸다.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { acceptsGzip, COMPRESS_MIN_BYTES, JsonCompressor } from "../server/compress.ts";
import { loadConfig, updateConfigFile, VERSION, type Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { Store } from "../server/store.ts";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const request = (encoding: string | null) => new Request("http://x/api/sync", { headers: encoding === null ? {} : { "Accept-Encoding": encoding } });
const big = { rows: Array.from({ length: 400 }, (_, i) => ({ id: `row_${i}`, text: "대표에게 보일 글입니다. 같은 낱말이 되풀이되면 잘 줄어듭니다." })) };

describe("acceptsGzip", () => {
  test("gzip 을 받는다고 한 요청만", () => {
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("br;q=1.0, gzip;q=0.8, *;q=0.1")).toBe(true);
    expect(acceptsGzip("GZIP")).toBe(true);
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("gzip;q=0, *")).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip("*;q=0")).toBe(false);
    expect(acceptsGzip("")).toBe(false);
    expect(acceptsGzip(null)).toBe(false);
  });
});

describe("JsonCompressor", () => {
  test("큰 JSON 답을 gzip 으로 바꾼다. 풀면 같은 본문이고 다른 머리글은 그대로다", async () => {
    const compressor = new JsonCompressor();
    const raw = JSON.stringify(big);
    const out = await compressor.apply(request("gzip"), Response.json(big, { headers: { "Cache-Control": "no-store", "X-Extra": "1" } }));
    expect(out.status).toBe(200);
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
    expect(out.headers.get("Vary")).toBe("Accept-Encoding");
    expect(out.headers.get("Cache-Control")).toBe("no-store");
    expect(out.headers.get("X-Extra")).toBe("1");
    expect(out.headers.get("Content-Type")).toContain("application/json");
    const packed = new Uint8Array(await out.arrayBuffer());
    expect(packed.byteLength).toBeLessThan(Buffer.byteLength(raw) / 3);
    expect(new TextDecoder().decode(Bun.gunzipSync(packed))).toBe(raw);
  });

  test("같은 본문은 한 번만 줄인다(같은 바이트를 돌려준다)", async () => {
    const compressor = new JsonCompressor();
    const first = new Uint8Array(await (await compressor.apply(request("gzip"), Response.json(big))).arrayBuffer());
    const second = new Uint8Array(await (await compressor.apply(request("gzip"), Response.json(big))).arrayBuffer());
    expect(Buffer.compare(first, second)).toBe(0);
    const other = new Uint8Array(await (await compressor.apply(request("gzip"), Response.json({ ...big, more: 1 }))).arrayBuffer());
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(other))).more).toBe(1);
  });

  test("줄이지 않는 답: gzip 을 받지 않는 요청, 작은 답, JSON 이 아닌 답, 200 이 아닌 답, 이미 줄인 답, 본문 없는 답", async () => {
    const compressor = new JsonCompressor();
    const plain = await compressor.apply(request(null), Response.json(big));
    expect(plain.headers.get("Content-Encoding")).toBeNull();
    expect(await plain.json()).toEqual(big);
    const refused = await compressor.apply(request("gzip;q=0"), Response.json(big));
    expect(refused.headers.get("Content-Encoding")).toBeNull();

    const small = await compressor.apply(request("gzip"), Response.json({ ok: true }));
    expect(small.headers.get("Content-Encoding")).toBeNull();
    expect(small.headers.get("Vary")).toBe("Accept-Encoding");
    expect(await small.json()).toEqual({ ok: true });
    expect(JSON.stringify({ ok: true }).length).toBeLessThan(COMPRESS_MIN_BYTES);

    const text = await compressor.apply(request("gzip"), new Response("가".repeat(5000), { headers: { "Content-Type": "text/plain; charset=utf-8" } }));
    expect(text.headers.get("Content-Encoding")).toBeNull();
    expect(await text.text()).toBe("가".repeat(5000));

    const failed = await compressor.apply(request("gzip"), Response.json(big, { status: 404 }));
    expect(failed.headers.get("Content-Encoding")).toBeNull();
    expect(failed.status).toBe(404);

    const already = await compressor.apply(request("gzip"), new Response(Bun.gzipSync(JSON.stringify(big)), { headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" } }));
    expect(already.headers.get("Content-Encoding")).toBe("gzip");
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await already.arrayBuffer()))))).toEqual(big);

    const empty = await compressor.apply(request("gzip"), new Response(null, { status: 200, headers: { "Content-Type": "application/json" } }));
    expect(empty.headers.get("Content-Encoding")).toBeNull();
  });
});

// ---- HTTP ----
function temp(prefix: string): string { return realpathSync(mkdtempSync(join(tmpdir(), prefix))); }
function freshConfig(): Config {
  const env = { IAMCEO_HOME: temp("iamceo-compress-"), IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code" }, env);
  return { ...loadConfig(env), hosts: ["127.0.0.1"], hostsAuto: true };
}
async function boot() {
  const config = freshConfig();
  const bus = new Bus();
  const store = new Store(openDb(config.dbPath), bus);
  const orch = new Orchestrator({ config, store, runners: new Map(), notifier: () => {} });
  const context = { config, store, bus, orch, detectHosts: () => [], daemon: () => ({ ready: true, buildId: "build", version: VERSION }) };
  let server: RunningServer = await startServer(context);
  while (server.port === 7878) { await server.stop(); server = await startServer(context); }
  cleanups.push(async () => { await server.stop(); await orch.shutdown(); store.db.close(); });
  // decompress:false 로 서버가 보낸 바이트를 그대로 받는다.
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: "Bearer code", ...headers }, decompress: false } as RequestInit);
  return { store, get };
}
/** tailscale serve 가 넘겨준 다른 기기의 요청. */
const REMOTE = { "X-Forwarded-For": "100.64.0.2", "Accept-Encoding": "gzip, deflate, br" };

describe("서버의 JSON 답", () => {
  test("다른 기기가 gzip 을 받는다고 하면 큰 답을 줄여 보내고, 풀면 줄이지 않은 답과 같다", async () => {
    const h = await boot();
    const project = h.store.createProject({ name: "큰 프로젝트", cwd: temp("iamceo-compress-proj-") });
    for (let i = 0; i < 80; i++) h.store.createMessage({ projectId: project.id, mine: true, kind: "나", body: `대표가 쓴 글 ${i}. 같은 낱말이 되풀이되면 잘 줄어듭니다.` });
    const path = `/api/projects/${project.id}/state`;
    const plain = await h.get(path);
    expect(plain.headers.get("Content-Encoding")).toBeNull();
    const body = await plain.text();
    expect(Buffer.byteLength(body)).toBeGreaterThan(COMPRESS_MIN_BYTES);

    const packed = await h.get(path, REMOTE);
    expect(packed.status).toBe(200);
    expect(packed.headers.get("Content-Encoding")).toBe("gzip");
    expect(packed.headers.get("Vary")).toContain("Accept-Encoding");
    expect(packed.headers.get("Cache-Control")).toBe("no-store");
    const bytes = new Uint8Array(await packed.arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(Buffer.byteLength(body) / 2);
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes)))).toEqual(JSON.parse(body));

    // 묶음(/api/sync)과 대화 한 쪽도 같다.
    for (const other of [`/api/sync?projectId=${project.id}&lite=1`, `/api/projects/${project.id}/messages/page?limit=100`]) {
      const res = await h.get(other, REMOTE);
      expect({ other, encoding: res.headers.get("Content-Encoding") }).toEqual({ other, encoding: "gzip" });
      expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()))))).toBeTruthy();
    }
  });

  test("이 Mac 안에서 온 요청, gzip 을 받지 않는 요청, 작은 답, 오류 답은 줄이지 않는다", async () => {
    const h = await boot();
    const project = h.store.createProject({ name: "큰 프로젝트", cwd: temp("iamceo-compress-proj-") });
    for (let i = 0; i < 80; i++) h.store.createMessage({ projectId: project.id, mine: true, kind: "나", body: `대표가 쓴 글 ${i}. 같은 낱말이 되풀이되면 잘 줄어듭니다.` });
    const path = `/api/projects/${project.id}/state`;
    // 이 Mac 의 앱: 대리 전달 머리글이 없다.
    const local = await h.get(path, { "Accept-Encoding": "gzip" });
    expect(local.headers.get("Content-Encoding")).toBeNull();
    expect((await local.json() as { project: { id: string } }).project.id).toBe(project.id);
    // gzip 을 받지 않는 다른 기기.
    const identity = await h.get(path, { "X-Forwarded-For": "100.64.0.2", "Accept-Encoding": "identity" });
    expect(identity.headers.get("Content-Encoding")).toBeNull();
    expect((await identity.json() as { project: { id: string } }).project.id).toBe(project.id);
    // 작은 답과 오류 답.
    const health = await h.get("/api/health", REMOTE);
    expect(health.headers.get("Content-Encoding")).toBeNull();
    expect(await health.json()).toMatchObject({ ok: true });
    const missing = await h.get("/api/projects/p_none/state", REMOTE);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Encoding")).toBeNull();
    expect((await missing.json() as { code: string }).code).toBeTruthy();
    const unauthorized = await fetch(`http://127.0.0.1:${new URL(missing.url).port}${path}`, { headers: REMOTE, decompress: false } as RequestInit);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Content-Encoding")).toBeNull();
  });
});
