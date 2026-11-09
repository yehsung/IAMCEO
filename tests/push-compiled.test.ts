import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { TLSSocket } from "node:tls";
import { join } from "node:path";
import { connect, constants, createSecureServer, type IncomingHttpHeaders, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { APNsClient, APNS_ORIGINS, HTTP2APNsTransport, type APNsNotification, type APNsTransportRequest } from "../server/push/apns";
import { loadAPNsConfig } from "../server/push/config";
import { PushStore } from "../server/push/store";
import { PushWorker } from "../server/push/worker";
import { openDb } from "../server/db";
import { DEFAULT_PUSH_BUNDLE_ID } from "../shared/push";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime";

// The exact same probe runs as Bun source and a standalone compiled binary.
// The only origin override is the injected transport; production TLS stays on.
async function probe(root: string, port: number) {
  if (!root.startsWith("/private/tmp/iq-") || !Number.isInteger(port) || port <= 0 || port === 7878) throw new Error("Unsafe APNs fixture");
  const config = loadAPNsConfig(join(root, "iamceo"));
  const cert = readFileSync(join(root, "config", "tls.crt"));
  const clients: APNsClient[] = [];
  let now = Date.now();
  const makeClient = (trust = true, afterSend?: (request: APNsTransportRequest) => void) => {
    const transport = new HTTP2APNsTransport((origin, options) => {
      if (!Object.values(APNS_ORIGINS).some(value => value === origin) || options.rejectUnauthorized !== true || options.ALPNProtocols.join() !== "h2") throw new Error("TLS contract changed");
      return connect(`https://127.0.0.1:${port}`, { ...options, servername: "localhost", ...(trust ? { ca: cert } : {}) });
    });
    const client = new APNsClient(config, { transport: { async send(request) { const result = await transport.send(request); afterSend?.(request); return result; }, close() { transport.close(); } }, now: () => now, timeoutMs: 250 }); clients.push(client); return client;
  };
  const notification = (token: string, kind: APNsNotification["kind"] = "test"): APNsNotification => ({ environment: "sandbox", deviceToken: token,
    deliveryId: randomUUID(), eventId: randomUUID(), serverId: randomUUID(), kind, occurredAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
    target: kind === "decision" ? { screen: "inbox", projectId: "p", decisionId: "d" } : (kind === "report_complete" || kind === "report_blocked") ? { screen: "chat", projectId: "p", memberId: "m", messageId: "msg" }
      : kind === "todo_created" ? { screen: "home", projectId: "p" } : kind === "test" ? { screen: "home" } : { screen: "team", projectId: "p", memberId: "m" } });
  try {
    const outcomes: Record<string, unknown> = {};
    for (const token of ["aa", "bb", "cc", "dd", "ee", "ff", "ab", "ac"]) outcomes[token] = await makeClient().send(notification(token));
    outcomes.untrusted = await makeClient(false).send(notification("aa"));
    const sender = makeClient();
    outcomes.kinds = await Promise.all((["decision", "approval_wait", "error", "report_complete", "todo_created", "report_blocked"] as const).map(kind => sender.send(notification("aa", kind))));
    const expired = notification("aa"); expired.occurredAt = new Date(now - 300_001).toISOString(); expired.expiresAt = new Date(now - 1).toISOString();
    outcomes.expired = await sender.send(expired);
    // Persisted unknown must never turn into another POST after restart.
    const dbPath = join(root, "iamceo", "push-probe.db");
    let db = openDb(dbPath), client = makeClient();
    let push = new PushStore(db, { now: () => now, providers: () => client.status() });
    let worker = new PushWorker(push, client, { now: () => now, random: () => 0.5 });
    try {
      const device = push.registerDevice(randomUUID(), { expectedRevision: null, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: "ab", authorization: "authorized" });
      push.patchDevice(device.id, { expectedRevision: device.revision, enabled: true });
      const event = push.recordEvent({ sourceKey: "unknown-once", kind: "test", target: { screen: "home" }, projectId: null, memberId: null, occurredAt: push.timestamp() });
      await worker.tick(); outcomes.beforeRestart = push.listDeliveries(event.id);
      await worker.shutdown(); db.close(); now += 60_000;
      db = openDb(dbPath); client = makeClient(); push = new PushStore(db, { now: () => now, providers: () => client.status() });
      worker = new PushWorker(push, client, { now: () => now }); await worker.tick(); outcomes.afterRestart = push.listDeliveries(event.id);
      // A known rejection has a durable due time; no send before it, including reopen.
      const current = push.requireDevice(device.id);
      push.registerDevice(device.id, { expectedRevision: current.revision, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: "ee", authorization: "authorized" });
      const retry = push.recordEvent({ sourceKey: "retry-later", kind: "test", target: { screen: "home" }, projectId: null, memberId: null, occurredAt: push.timestamp() });
      await worker.tick(); outcomes.retry = push.listDeliveries(retry.id);
      await worker.shutdown(); db.close();
      db = openDb(dbPath); client = makeClient(); push = new PushStore(db, { now: () => now, providers: () => client.status() });
      worker = new PushWorker(push, client, { now: () => now }); await worker.tick(); outcomes.retryAfterRestart = push.listDeliveries(retry.id);
      outcomes.device = push.getDevice(device.id);
      await worker.shutdown();
      const old = push.requireDevice(device.id);
      push.registerDevice(device.id, { expectedRevision: old.revision, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: "dd", authorization: "authorized" });
      client = makeClient(true, request => {
        if (request.headers[":path"] !== "/3/device/dd") return;
        const registration = push.requireDevice(device.id);
        push.registerDevice(device.id, { expectedRevision: registration.revision, platform: "ios", bundleId: DEFAULT_PUSH_BUNDLE_ID, environment: "sandbox", deviceToken: "aa", authorization: "authorized" });
      });
      worker = new PushWorker(push, client, { now: () => now });
      const stale = push.recordEvent({ sourceKey: "stale-410", kind: "test", target: { screen: "home" }, projectId: null, memberId: null, occurredAt: push.timestamp() });
      await worker.tick(); outcomes.staleDelivery = push.listDeliveries(stale.id); outcomes.staleDevice = { state: push.getDevice(device.id)!.state, tokenPreserved: push.getRegistration(device.id)!.deviceToken === "aa" };
    } finally { await worker.shutdown(); db.close(); }
    return outcomes;
  } finally { for (const client of clients) client.close(); }
}

if (process.argv[2] === "--apns-probe") {
  console.log("W10:" + JSON.stringify(await probe(process.argv[3]!, Number(process.argv[4]))));
} else {
  const { expect, test } = await import("bun:test");
  test("release APNs: source and compiled TLS/HTTP2/JWT failures and durable outbox obey the same contract", async () => {
    const runtime = createIsolatedRuntime();
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyPath = join(runtime.paths.configDir, "test.p8"), certPath = join(runtime.paths.configDir, "tls.crt");
    writeFileSync(keyPath, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    writeFileSync(join(runtime.paths.iamceoHome, "apns.json"), JSON.stringify({ sandbox: { keyId: "TESTKEY123", teamId: "TESTTEAM12", bundleId: DEFAULT_PUSH_BUNDLE_ID, privateKeyPath: keyPath } }), { mode: 0o600 });
    const cnf = join(runtime.paths.configDir, "openssl.cnf");
    writeFileSync(cnf, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n");
    const cert = Bun.spawnSync(["/usr/bin/openssl", "req", "-new", "-x509", "-key", keyPath, "-days", "1", "-out", certPath, "-config", cnf], { env: runtime.childEnv(), cwd: runtime.paths.work, stdout: "pipe", stderr: "pipe" });
    expect(cert.exitCode).toBe(0);
    const received: { headers: IncomingHttpHeaders; body: string; alpn: string | false | null | undefined }[] = [];
    const sessions = new Set<ServerHttp2Session>();
    const server = createSecureServer({ key: readFileSync(keyPath), cert: readFileSync(certPath), allowHTTP1: false });
    server.on("tlsClientError", () => {});
    server.on("session", session => { sessions.add(session); session.on("error", () => {}); session.on("close", () => sessions.delete(session)); });
    server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
      stream.on("error", () => {}); let body = "";
      stream.on("data", chunk => { body += chunk; });
      stream.on("end", () => {
        received.push({ headers, body, alpn: (stream.session?.socket as TLSSocket | undefined)?.alpnProtocol });
        const token = String(headers[":path"]).split("/").at(-1);
        if (token === "ab") return; // Applied body, lost response, must stay unknown.
        if (token === "ac") { stream.session!.goaway(constants.NGHTTP2_NO_ERROR, stream.id); return; }
        const responses: Record<string, readonly [number, string]> = { bb: [400, "BadDeviceToken"], cc: [403, "InvalidProviderToken"], dd: [410, "Unregistered"], ee: [429, "TooManyRequests"], ff: [503, "ServiceUnavailable"] };
        const [status, reason] = responses[token ?? ""] ?? [200, ""];
        stream.respond({ ":status": status, ...(status === 429 ? { "retry-after": "10" } : {}) }); stream.end(JSON.stringify({ reason, canary: "PRIVATE-RESPONSE-CANARY" }));
      });
    });
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      do {
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
        if ((server.address() as { port: number }).port !== 7878) break;
        await new Promise<void>(resolve => server.close(() => resolve()));
      } while (true);
      const port = (server.address() as { port: number }).port;
      const binary = join(runtime.paths.bin, "push-compiled");
      const build = Bun.spawn([process.execPath, "build", import.meta.path, "--compile", "--outfile", binary], { env: runtime.childEnv(), cwd: runtime.paths.work, stdout: "pipe", stderr: "pipe" });
      const buildDeadline = setTimeout(() => build.kill("SIGKILL"), 15_000);
      const [, buildError, buildCode] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
      clearTimeout(buildDeadline);
      expect({ code: buildCode, error: buildError }).toEqual({ code: 0, error: "" });
      for (const mode of ["source", "compiled"]) {
        // Separate DB per run while retaining one test-only TLS peer.
        const root = mode === "source" ? runtime : createIsolatedRuntime();
        if (root !== runtime) {
          writeFileSync(join(root.paths.configDir, "test.p8"), readFileSync(keyPath), { mode: 0o600 });
          writeFileSync(join(root.paths.configDir, "tls.crt"), readFileSync(certPath));
          writeFileSync(join(root.paths.iamceoHome, "apns.json"), JSON.stringify({ sandbox: { keyId: "TESTKEY123", teamId: "TESTTEAM12", bundleId: DEFAULT_PUSH_BUNDLE_ID, privateKeyPath: join(root.paths.configDir, "test.p8") } }), { mode: 0o600 });
        }
        try {
          const before = received.length;
          child = Bun.spawn([...(mode === "source" ? [process.execPath, import.meta.path] : [binary]), "--apns-probe", root.dir, String(port)], { env: root.childEnv(), cwd: root.paths.work, stdout: "pipe", stderr: "pipe" });
          const timer = setTimeout(() => child?.kill("SIGKILL"), 15_000);
          const [stdout, stderr, code] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]); clearTimeout(timer); child = undefined;
          expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
          const result = JSON.parse(stdout.split("\n").find(line => line.startsWith("W10:"))!.slice(4));
          for (const [token, state] of Object.entries({ aa: "accepted", bb: "invalid", cc: "unavailable", dd: "invalid", ee: "retry", ff: "retry", ab: "unknown", ac: "unknown", untrusted: "retry", expired: "expired" })) expect(result[token].state).toBe(state);
          expect(result.kinds.map((r: { state: string }) => r.state)).toEqual(Array(6).fill("accepted"));
          expect(result.beforeRestart[0]).toMatchObject({ state: "unknown", attempts: 1 }); expect(result.afterRestart).toEqual(result.beforeRestart);
          expect(result.retry[0]).toMatchObject({ state: "retry", attempts: 1 }); expect(result.retryAfterRestart).toEqual(result.retry);
          expect(result.device.state).toBe("active");
          expect(result.staleDevice).toEqual({ state: "active", tokenPreserved: true });
          expect(result.staleDelivery[0].state).toBe("invalid");
          const requests = received.slice(before); expect(requests).toHaveLength(17);
          expect(requests.filter(r => r.headers[":path"] === "/3/device/ab")).toHaveLength(2);
          for (const request of requests) {
            expect(request.alpn).toBe("h2"); expect(request.headers["apns-topic"]).toBe("com.yehsung.iamceo");
            const jwt = String(request.headers.authorization).slice(7).split(".");
            expect(JSON.parse(Buffer.from(jwt[0]!, "base64url").toString())).toEqual({ alg: "ES256", kid: "TESTKEY123" });
            expect(verify("sha256", Buffer.from(jwt.slice(0, 2).join(".")), { key: keys.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(jwt[2]!, "base64url"))).toBe(true);
            expect(request.body).not.toContain("PRIVATE"); expect(request.body).not.toContain("TESTTEAM12");
          }
          expect(stdout).not.toContain("PRIVATE-RESPONSE-CANARY"); expect(stdout).not.toContain("PRIVATE KEY");
        } finally { if (root !== runtime) await root.stop(); }
      }
    } finally {
      if (child) { child.kill("SIGKILL"); await child.exited; }
      for (const session of sessions) session.destroy();
      await new Promise<void>(resolve => server.close(() => resolve())); await runtime.stop();
    }
  }, 40_000);
}
