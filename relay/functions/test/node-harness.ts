// Node(배포 런타임과 같은 엔진)에서 중계를 돌려 보는 실행 파일. node-runtime.test.ts 가 묶어서 `node` 로 실행한다.
// 가짜 APNs 는 시험 쪽(Bun)이 띄우고 주소·인증서 경로를 환경 변수로 넘긴다. 결과는 JSON 한 줄로 낸다.
import { readFileSync } from "node:fs";
import { connect } from "node:http2";
import { RelayAPNs, apnsCredential } from "../src/apns-sender.ts";
import { createRelay } from "../src/relay.ts";
import type { RelayRequest } from "../src/relay.ts";

const port = Number(process.env.FAKE_APNS_PORT);
const ca = readFileSync(String(process.env.FAKE_APNS_CA));
const keyPem = String(process.env.FAKE_APNS_KEY);
const master = "node-harness-master-0123456789abcdefghij";
const warnings: string[] = [];
process.on("warning", (warning) => warnings.push(warning.name));

const apns = new RelayAPNs({
  credential: () => apnsCredential({ keyId: "TESTKEY123", teamId: "TEAMID1234", privateKey: keyPem }),
  connector: (_origin, options) => connect(`https://127.0.0.1:${port}`, { ...options, servername: "localhost", ca }),
  timeoutMs: 1_500,
});
const relay = createRelay({ apns, settings: () => ({ master, mode: "open" }) });
const call = (method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
  relay.handle({ method, path, headers: { "content-type": "application/json", ...headers }, body: Buffer.from(JSON.stringify(body)) } satisfies RelayRequest);
const pushBody = (token: string) => ({ token, kind: "decision", id: crypto.randomUUID(), eventId: crypto.randomUUID(), serverId: "6f1f8a9e-2b7c-4d1e-9a3b-1c2d3e4f5a6b",
  target: { screen: "inbox", projectId: "p_1", decisionId: "d_1" }, expiresAt: new Date(Date.now() + 600_000).toISOString() });

const created = await call("POST", "/v1/installations", {});
const { installationId, secret } = JSON.parse(created.body) as { installationId: string; secret: string };
const authorization = `Bearer ${installationId}.${secret}`;
const push = (token: string) => call("POST", "/v1/push", pushBody(token), { authorization });

const accepted = await push("a1".repeat(32));
const started = Date.now();
const stalled = push("ee".repeat(32));
await new Promise((resolve) => setTimeout(resolve, 100));
const quick = await push("a2".repeat(32));
const quickMs = Date.now() - started;
const late = await stalled;
const gone = await push("dd".repeat(32));
const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => push(`${(i % 9) + 1}b`.repeat(32))));
await new Promise((resolve) => setTimeout(resolve, 20));
apns.close();

process.stdout.write(`${JSON.stringify({
  node: process.versions.node, created: created.status, accepted: accepted.status, quick: quick.status, quickMs,
  stalled: late.status, gone: { status: gone.status, body: JSON.parse(gone.body) }, burst: burst.map((item) => item.status), warnings,
})}\n`);
