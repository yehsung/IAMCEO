// N(C8): iPhone 연결을 Tailscale 의 HTTPS 주소로. tailscale 명령은 모두 가짜다(진짜 tailscale 을 부르지 않는다).
// - 켜기는 대표가 고를 때만(POST, 이 Mac 에서만). 조회는 켠 기록이 없으면 명령을 부르지 않는다.
// - 켜면 연결 QR 주소의 맨 앞에 https 주소를 싣고, 끄면 이 서버가 만든 설정만 지운다. 443 의 다른 설정은 건드리지 않는다.
// - HTTPS 주소를 거쳐 온 요청(대리 전달 머리글)은 '이 Mac' 으로 보지 않는다(코드 교체·모두 끊기·HTTPS 켜고 끄기).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { type Config, loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { type RunningServer, startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { Store } from "../server/store.ts";
import { classifyServe, runTailscale, TAILNET_ADMIN_DNS_URL, TailnetHttps, type SavedTailnetHttps, type TailscaleResult, type TailscaleRunner } from "../server/tailnet-https.ts";
import type { TailnetHttpsStatus } from "../shared/types.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const DNS = "sample-mac.tail0000.ts.net";
const RUNNING = { BackendState: "Running", Self: { DNSName: `${DNS}.` }, CertDomains: [DNS] };
const ok = (stdout = ""): TailscaleResult => ({ code: 0, stdout, stderr: "" });
const ours = (port: number) => ({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } });

interface FakeOptions {
  missing?: boolean;
  status?: unknown;
  statusResult?: TailscaleResult;
  serve?: unknown;
  cert?: TailscaleResult;
  serveOn?: TailscaleResult;
  serveOff?: TailscaleResult;
}

/** 가짜 tailscale. 부른 명령을 모두 적고, serve 를 켜고 끄면 serve status 의 답을 바꾼다. */
function fakeTailscale(options: FakeOptions = {}) {
  const calls: string[][] = [];
  let serve: unknown = options.serve ?? {};
  const run: TailscaleRunner = async (args) => {
    calls.push(args);
    if (options.missing) return { code: null, stdout: "", stderr: "", missing: true };
    const key = args.join(" ");
    if (key === "status --json") return options.statusResult ?? ok(JSON.stringify(options.status ?? RUNNING));
    if (key === "serve status --json") return ok(JSON.stringify(serve));
    if (args[0] === "cert") return options.cert ?? ok("-----BEGIN CERTIFICATE-----\nMIIfake\n-----END CERTIFICATE-----\n");
    if (args[0] === "serve" && args[1] === "--bg") {
      if (options.serveOn) return options.serveOn;
      const port = Number(/:(\d+)$/.exec(args[3] ?? "")?.[1]);
      serve = ours(port);
      return ok(`Available within your tailnet:\n\nhttps://${DNS}/\n|-- proxy ${args[3]}\n`);
    }
    if (key === "serve --https=443 off") {
      if (options.serveOff) return options.serveOff;
      serve = {};
      return ok();
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${key}` };
  };
  return { run, calls, setServe: (value: unknown) => { serve = value; } };
}

/** 바꾸는 명령(serve 켜기·끄기, cert)만 고른다. 읽기(status, serve status)는 아무것도 바꾸지 않는다. */
const mutations = (calls: string[][]) => calls.filter(args => args[0] === "cert" || (args[0] === "serve" && args[1] !== "status"));

function memory(initial: SavedTailnetHttps | null = null) {
  let saved = initial;
  return { load: () => saved, save: (value: SavedTailnetHttps | null) => { saved = value; }, get value() { return saved; } };
}

function subject(fake: ReturnType<typeof fakeTailscale>, saved = memory(), extra: { port?: number; loopback?: boolean; now?: () => number } = {}) {
  return new TailnetHttps({ port: () => extra.port ?? 7878, loopbackListening: () => extra.loopback ?? true, load: saved.load, save: saved.save,
    run: fake.run, now: extra.now, log: () => {} });
}

describe("443 의 serve 설정 읽기", () => {
  test("이 서버를 가리키는 모양만 ours, 전에 켠 기록의 포트면 ours_other_port, 나머지는 건드리지 않을 다른 설정", () => {
    expect(classifyServe({}, DNS, 7878)).toBe("none");
    expect(classifyServe(null, DNS, 7878)).toBe("none");
    expect(classifyServe(ours(7878), DNS, 7878)).toBe("ours");
    expect(classifyServe({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "127.0.0.1:7878" } } } } }, DNS, 7878)).toBe("ours");
    expect(classifyServe({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://localhost:7878/" } } } } }, DNS, 7878)).toBe("ours");
    expect(classifyServe(ours(7000), DNS, 7878, 7000)).toBe("ours_other_port");
    // 127.0.0.1 의 다른 포트라도 이 서버가 켠 기록이 없으면 남의 서비스로 본다(지우지 않는다).
    expect(classifyServe(ours(3000), DNS, 7878)).toBe("other");
    expect(classifyServe(ours(3000), DNS, 7878, 7000)).toBe("other");
    // 다른 서비스, 여러 경로, 인터넷 공개(funnel), TCP 넘기기, 다른 이름은 이 서버의 것이 아니다.
    expect(classifyServe({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://192.168.0.4:7878" } } } } }, DNS, 7878)).toBe("other");
    expect(classifyServe({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7878" }, "/grafana": { Proxy: "http://127.0.0.1:3000" } } } } }, DNS, 7878)).toBe("other");
    expect(classifyServe({ ...ours(7878), AllowFunnel: { [`${DNS}:443`]: true } }, DNS, 7878)).toBe("other");
    expect(classifyServe({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } }, DNS, 7878)).toBe("other");
    expect(classifyServe({ TCP: { "443": { HTTPS: true } }, Web: { "other-mac.tail0000.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7878" } } } } }, DNS, 7878)).toBe("other");
    expect(classifyServe({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Text: "hello" } } } } }, DNS, 7878)).toBe("other");
    // 다른 포트(8443)만 쓰는 설정은 443 과 겹치지 않는다.
    expect(classifyServe({ TCP: { "8443": { HTTPS: true } }, Web: { [`${DNS}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } }, DNS, 7878)).toBe("none");
  });
});

describe("HTTPS 주소 켜기·끄기(가짜 tailscale)", () => {
  test("켠 기록이 없으면 조회도 QR 주소도 tailscale 명령을 부르지 않는다", async () => {
    const fake = fakeTailscale();
    const https = subject(fake);
    expect((await https.status()).state).toBe("off");
    expect(await https.pairingUrl()).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  test("켜기: 인증서를 먼저 받고, 443 을 127.0.0.1:<포트> 로 넘기고, 켠 뒤 다시 읽어 확인한다", async () => {
    const fake = fakeTailscale();
    const saved = memory();
    const https = subject(fake, saved, { port: 45123 });
    const status = await https.enable();
    expect(status).toMatchObject({ state: "on", url: `https://${DNS}` });
    expect(status.problem).toBeUndefined();
    expect(mutations(fake.calls)).toEqual([["cert", "--cert-file", "-", DNS], ["serve", "--bg", "--https=443", "http://127.0.0.1:45123"]]);
    // 다른 설정을 모두 지우는 명령, 인터넷 공개는 쓰지 않는다. 개인 키는 받지 않는다.
    expect(fake.calls.flat()).not.toContain("reset");
    expect(fake.calls.some(args => args[0] === "funnel")).toBe(false);
    expect(fake.calls.flat()).not.toContain("--key-file");
    expect(saved.value).toMatchObject({ url: `https://${DNS}`, port: 45123 });
    expect(await https.pairingUrl()).toBe(`https://${DNS}`);
  });

  test("이미 이 서버를 가리키면 serve 를 다시 부르지 않고 기록만 남긴다", async () => {
    const fake = fakeTailscale({ serve: ours(7878) });
    const saved = memory();
    expect((await subject(fake, saved).enable()).state).toBe("on");
    expect(mutations(fake.calls)).toEqual([["cert", "--cert-file", "-", DNS]]);
    expect(saved.value?.url).toBe(`https://${DNS}`);
  });

  test("옛 포트를 가리키는 이 서버의 설정(켠 기록의 포트)은 지우고 새 포트로 다시 켠다", async () => {
    const fake = fakeTailscale({ serve: ours(7000) });
    const saved = memory({ url: `https://${DNS}`, port: 7000, at: "2026-11-13T00:00:00.000Z" });
    const https = subject(fake, saved);
    expect((await https.status()).problem?.code).toBe("tailnet_https_port_changed");
    expect(await https.pairingUrl()).toBeNull();
    expect((await https.enable()).state).toBe("on");
    expect(mutations(fake.calls).slice(1)).toEqual([["serve", "--https=443", "off"], ["serve", "--bg", "--https=443", "http://127.0.0.1:7878"]]);
    expect(saved.value?.port).toBe(7878);
    // 기록이 없으면 같은 모양이라도 남의 설정이다.
    const foreign = fakeTailscale({ serve: ours(7000) });
    expect((await subject(foreign).enable()).problem?.code).toBe("tailnet_https_port_taken");
    expect(mutations(foreign.calls)).toEqual([]);
  });

  test("tailnet 의 HTTPS 인증서가 꺼져 있으면 아무것도 바꾸지 않고 무엇을 켜야 하는지 알린다", async () => {
    const fake = fakeTailscale({ status: { ...RUNNING, CertDomains: null } });
    const saved = memory();
    const status = await subject(fake, saved).enable();
    expect(status.state).toBe("off");
    expect(status.problem?.code).toBe("tailnet_https_disabled");
    expect(status.problem?.message).toContain("HTTPS Certificates");
    expect(status.problem?.link).toBe(TAILNET_ADMIN_DNS_URL);
    expect(mutations(fake.calls)).toEqual([]);
    expect(saved.value).toBeNull();
  });

  test("443 을 다른 설정이 쓰고 있으면 켜지 않고 그 설정을 건드리지 않는다", async () => {
    const other = { TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://192.168.0.9:80" } } } } };
    const fake = fakeTailscale({ serve: other });
    const status = await subject(fake).enable();
    expect(status.problem?.code).toBe("tailnet_https_port_taken");
    expect(mutations(fake.calls)).toEqual([]);
  });

  test("Tailscale 이 없거나 꺼져 있거나 오래됐으면 까닭을 나눠 말한다", async () => {
    expect((await subject(fakeTailscale({ missing: true })).enable()).problem?.code).toBe("tailscale_cli_missing");
    expect((await subject(fakeTailscale({ status: { BackendState: "Stopped", Self: { DNSName: `${DNS}.` } } })).enable()).problem?.code).toBe("tailscale_not_running");
    expect((await subject(fakeTailscale({ statusResult: { code: 1, stdout: "", stderr: "failed to connect to local Tailscale service; is Tailscale running?" } })).enable()).problem?.code)
      .toBe("tailscale_not_running");
    const old = fakeTailscale({ serveOn: { code: 2, stdout: "", stderr: "flag provided but not defined: -bg" } });
    expect((await subject(old).enable()).problem?.code).toBe("tailscale_too_old");
    const failing = fakeTailscale({ serveOn: { code: 1, stdout: "", stderr: "boom", timedOut: false } });
    expect((await subject(failing).enable()).problem?.code).toBe("tailnet_https_failed");
  });

  test("인증서를 받지 못하면 serve 를 켜지 않는다", async () => {
    const fake = fakeTailscale({ cert: { code: null, stdout: "", stderr: "", timedOut: true } });
    const saved = memory();
    const status = await subject(fake, saved).enable();
    expect(status.problem?.code).toBe("tailnet_https_cert_failed");
    expect(mutations(fake.calls)).toEqual([["cert", "--cert-file", "-", DNS]]);
    expect(saved.value).toBeNull();
  });

  test("서버가 127.0.0.1 에서 듣지 않으면 켜지 않는다", async () => {
    const fake = fakeTailscale();
    expect((await subject(fake, memory(), { loopback: false }).enable()).problem?.code).toBe("tailnet_https_no_loopback");
    expect(mutations(fake.calls)).toEqual([]);
  });

  test("끄기: 이 서버의 설정만 지우고 기록을 지운다. 다른 설정이면 건드리지 않는다", async () => {
    const fake = fakeTailscale({ serve: ours(7878) });
    const saved = memory({ url: `https://${DNS}`, port: 7878, at: "2026-11-13T00:00:00.000Z" });
    expect(await subject(fake, saved).disable()).toMatchObject({ state: "off" });
    expect(mutations(fake.calls)).toEqual([["serve", "--https=443", "off"]]);
    expect(saved.value).toBeNull();

    const foreign = fakeTailscale({ serve: { TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" }, "/x": { Proxy: "http://127.0.0.1:3001" } } } } } });
    const kept = memory({ url: `https://${DNS}`, port: 7878, at: "2026-11-13T00:00:00.000Z" });
    expect((await subject(foreign, kept).disable()).state).toBe("off");
    expect(mutations(foreign.calls)).toEqual([]);
    expect(kept.value).toBeNull();
  });

  test("끄지 못하면 켠 기록을 남기고 그렇다고 말한다", async () => {
    const fake = fakeTailscale({ serve: ours(7878), serveOff: { code: 1, stdout: "", stderr: "denied" } });
    const saved = memory({ url: `https://${DNS}`, port: 7878, at: "2026-11-13T00:00:00.000Z" });
    const status = await subject(fake, saved).disable();
    expect(status.state).toBe("pending");
    expect(status.problem?.code).toBe("tailnet_https_off_failed");
    expect(saved.value).not.toBeNull();
  });

  test("켠 뒤 누가 Tailscale 쪽 설정을 지웠으면 꺼진 것으로 바꾸고 QR 에 싣지 않는다", async () => {
    const fake = fakeTailscale({ serve: {} });
    const saved = memory({ url: `https://${DNS}`, port: 7878, at: "2026-11-13T00:00:00.000Z" });
    const https = subject(fake, saved);
    expect(await https.pairingUrl()).toBeNull();
    expect(saved.value).toBeNull();
    // 기록을 지운 뒤에도 대표가 다시 켜거나 끌 때까지 그 까닭을 보인다. 기록이 없으니 tailscale 은 다시 부르지 않는다.
    const calls = fake.calls.length;
    expect(await https.status(0)).toMatchObject({ state: "off", problem: { code: "tailnet_https_removed" } });
    expect(fake.calls.length).toBe(calls);
    expect(mutations(fake.calls)).toEqual([]);
    expect((await https.disable()).problem).toBeUndefined();
    expect((await https.status(0)).problem).toBeUndefined();
  });

  test("이 Mac 의 Tailscale 이 꺼진 동안은 켠 기록을 두되 QR 에는 싣지 않는다", async () => {
    const fake = fakeTailscale({ status: { BackendState: "Stopped" } });
    const saved = memory({ url: `https://${DNS}`, port: 7878, at: "2026-11-13T00:00:00.000Z" });
    const https = subject(fake, saved);
    const status = await https.status();
    expect(status).toMatchObject({ state: "pending", url: `https://${DNS}` });
    expect(status.problem?.code).toBe("tailscale_not_running");
    expect(await https.pairingUrl()).toBeNull();
    expect(saved.value).not.toBeNull();
  });

  test("조회는 잠깐 기억하고, 켜는 동안의 조회는 pending 으로 답한다", async () => {
    let now = 1_000_000;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const base = fakeTailscale();
    const slow: TailscaleRunner = async (args, timeout) => { if (args[0] === "cert") await gate; return base.run(args, timeout); };
    const saved = memory();
    const https = new TailnetHttps({ port: () => 7878, loopbackListening: () => true, load: saved.load, save: saved.save, run: slow, now: () => now, log: () => {} });
    const enabling = https.enable();
    await Bun.sleep(5);
    expect((await https.status()).state).toBe("pending");
    release();
    expect((await enabling).state).toBe("on");
    const before = base.calls.length;
    expect((await https.status()).state).toBe("on");
    expect(base.calls.length).toBe(before);
    now += 60_000;
    expect((await https.status()).state).toBe("on");
    expect(base.calls.length).toBeGreaterThan(before);
  });

  test("시험 환경에서는 기본 실행기도 진짜 tailscale 을 부르지 않는다", async () => {
    expect(process.env.IAMCEO_TEST).toBe("1");
    expect(await runTailscale(["status", "--json"], 1000)).toMatchObject({ missing: true });
  });
});

describe("HTTPS 주소 HTTP 경로", () => {
  const CODE = "tailnet-https-fixture-code";
  let server: RunningServer;
  let base: string;
  let isolated: ReturnType<typeof createIsolatedRuntime>;
  let store: Store;
  let config: Config;
  const fake = fakeTailscale();

  beforeAll(async () => {
    isolated = createIsolatedRuntime();
    const env = isolated.childEnv();
    updateConfigFile({ accessCode: CODE, hosts: ["127.0.0.1"] }, env);
    config = loadConfig(env);
    const bus = new Bus();
    store = new Store(openDb(config.dbPath), bus);
    const orch = {} as OrchestratorApi;
    const start = () => startServer({ config, store, bus, orch, detectHosts: () => [], tailnetHttps: { run: fake.run, log: () => {} } });
    server = await start();
    while (server.port === 7878) { await server.stop(); server = await start(); }
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server.stop();
    store.db.close();
    await isolated.stop();
  });

  const auth = { Authorization: `Bearer ${CODE}` };
  const call = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/tailnet/https`, { method, headers: { ...auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const pairUrls = async () => ((await (await fetch(`${base}/api/pair/start`, { method: "POST", headers: auth })).json()) as { urls: string[] }).urls;
  /** tailscale serve 가 tailnet 의 다른 기기 요청을 넘길 때 붙이는 머리글(127.0.0.1 에서 온다). */
  const viaServe = { "X-Forwarded-Host": DNS, "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.2", "Tailscale-User-Login": "someone@example.com" };

  test("인증이 있어야 하고, 켠 적이 없으면 off 이며 tailscale 을 부르지 않는다", async () => {
    expect((await fetch(`${base}/api/tailnet/https`)).status).toBe(401);
    const response = await call("GET");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as TailnetHttpsStatus;
    expect(body.state).toBe("off");
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    expect(fake.calls).toEqual([]);
    expect((await fetch(`${base}/api/tailnet/https?x=1`, { headers: auth })).status).toBe(400);
    expect((await call("DELETE")).status).toBe(405);
  });

  test("HTTPS 주소를 거쳐 온 요청은 켜고 끌 수 없다(이 Mac 의 앱만)", async () => {
    const response = await call("POST", { enabled: true }, viaServe);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("tailnet_https_local_only");
    expect(mutations(fake.calls)).toEqual([]);
    for (const body of [{}, { enabled: "yes" }, { enabled: true, port: 1 }]) expect((await call("POST", body)).status).toBe(400);
    expect(mutations(fake.calls)).toEqual([]);
  });

  test("켜면 QR 주소 맨 앞에 https 주소가 서고, 끄면 빠진다", async () => {
    expect(await pairUrls()).toEqual([]);
    const on = await call("POST", { enabled: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ state: "on", url: `https://${DNS}` });
    expect(fake.calls.some(args => args.join(" ") === `serve --bg --https=443 http://127.0.0.1:${server.port}`)).toBe(true);
    expect(store.tailnetHttps()).toMatchObject({ url: `https://${DNS}`, port: server.port });
    // 출시된 Mac 앱은 urls 를 차례대로 QR 에 싣는다. 모양(문자열 배열)은 그대로다.
    expect(await pairUrls()).toEqual([`https://${DNS}`]);
    expect(((await (await call("GET")).json()) as TailnetHttpsStatus).state).toBe("on");

    const off = await call("POST", { enabled: false });
    expect(await off.json()).toMatchObject({ state: "off" });
    expect(store.tailnetHttps()).toBeNull();
    expect(await pairUrls()).toEqual([]);
  });

  test("HTTPS 주소를 거쳐 온 QR 교환은 넘겨준 기기 주소마다 따로 센다(모두 127.0.0.1 에서 오더라도)", async () => {
    const claim = (code: string, from: string) => fetch(`${base}/pair/claim`, { method: "POST",
      headers: { "Content-Type": "application/json", ...viaServe, "X-Forwarded-For": from }, body: JSON.stringify({ code, device: "iPhone" }) });
    for (let i = 0; i < 10; i++) expect((await claim("WRONGCOD", "100.64.0.9")).status).toBe(401);
    const { code } = (await (await fetch(`${base}/api/pair/start`, { method: "POST", headers: auth })).json()) as { code: string };
    expect((await claim(code, "100.64.0.9")).status).toBe(429);
    // 같은 HTTPS 주소를 거친 다른 기기는 막히지 않는다.
    const ok = await claim(code, "100.64.0.10");
    expect(ok.status).toBe(200);
    const devices = (await (await fetch(`${base}/api/devices`, { headers: auth })).json()) as { events: { kind: string; address: string | null }[] };
    expect(devices.events.find(event => event.kind === "paired")?.address).toBe("100.64.0.10");
    expect(devices.events.some(event => event.kind === "pair_failed" && event.address === "100.64.0.9")).toBe(true);
  });

  test("HTTPS 주소를 거쳐 온 요청은 접속 코드 교체·모두 끊기도 할 수 없다", async () => {
    const rotate = await fetch(`${base}/api/auth/rotate`, { method: "POST", headers: { ...auth, ...viaServe }, body: "{}" });
    expect(rotate.status).toBe(403);
    expect(((await rotate.json()) as { code: string }).code).toBe("rotate_local_only");
    expect(config.accessCode).toBe(CODE);
    const revokeAll = await fetch(`${base}/api/devices`, { method: "DELETE", headers: { ...auth, ...viaServe } });
    expect(revokeAll.status).toBe(403);
    expect(((await revokeAll.json()) as { code: string }).code).toBe("LOCAL_ONLY");
    // 같은 요청을 이 Mac 에서 머리글 없이 보내면 된다(바뀐 것은 대리 전달 머리글뿐이다).
    expect((await fetch(`${base}/api/devices`, { method: "DELETE", headers: auth })).status).toBe(200);
    // 보통 조회는 HTTPS 주소를 거쳐도 그대로 된다(iPhone 이 쓰는 길).
    expect((await fetch(`${base}/api/capabilities`, { headers: { ...auth, ...viaServe } })).status).toBe(200);
  });
});
