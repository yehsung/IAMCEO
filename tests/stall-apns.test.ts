import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import type { ClientHttp2Session } from "node:http2";
import { HTTP2APNsTransport, type APNsTransportRequest } from "../server/push/apns.ts";

class ConnectingSession extends EventEmitter {
  connecting = true;
  destroyed = false;
  closed = false;
  alpnProtocol = "h2";
  destroy() { if (!this.destroyed) { this.destroyed = true; this.closed = true; this.emit("close"); } }
}
function request(timeoutMs = 1000): APNsTransportRequest {
  return { credential: { environment: "sandbox", keyId: "fixture", teamId: "fixture", bundleId: "fixture", cacheKey: "isolated-credential", key: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey }, headers: {}, body: "{}", timeoutMs };
}

test("stall APNs: concurrent failed handshakes share listeners, destroy sessions and back off", async () => {
  let now = 0;
  const sessions: ConnectingSession[] = [];
  const transport = new HTTP2APNsTransport(() => {
    const session = new ConnectingSession(); sessions.push(session);
    return session as unknown as ClientHttp2Session;
  }, () => now);
  const input = request();
  try {
    const pending = Array.from({ length: 32 }, () => transport.send(input));
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.listenerCount("connect")).toBe(1);
    expect(session.listenerCount("error")).toBeLessThanOrEqual(2);
    expect(session.listenerCount("close")).toBeLessThanOrEqual(2);
    session.emit("error", new Error("isolated connect refusal"));
    expect((await Promise.all(pending)).every(result => result.type === "not_sent")).toBe(true);
    expect(session.destroyed).toBe(true);
    expect(session.listenerCount("connect")).toBe(0);
    expect(session.listenerCount("error")).toBe(1);
    for (let i = 0; i < 100; i++) expect((await transport.send(input)).type).toBe("not_sent");
    expect(sessions).toHaveLength(1);
    now = 999; await transport.send(input); expect(sessions).toHaveLength(1);
    now = 1000;
    const next = transport.send(input); expect(sessions).toHaveLength(2);
    sessions[1]!.emit("error", new Error("second refusal")); await next;
    now = 2999; await transport.send(input); expect(sessions).toHaveLength(2);
    now = 3000;
    const last = transport.send(input); expect(sessions).toHaveLength(3);
    transport.close(); expect((await last).type).toBe("not_sent");
    expect(sessions.every(value => value.destroyed)).toBe(true);
  } finally { transport.close(); }
});

test("stall APNs: stalled handshake times out once and releases connect listeners", async () => {
  const session = new ConnectingSession();
  const transport = new HTTP2APNsTransport(() => session as unknown as ClientHttp2Session);
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => transport.send(request(20))));
    expect(results.every(result => result.type === "not_sent")).toBe(true);
    expect(session.destroyed).toBe(true);
    expect(session.listenerCount("connect")).toBe(0);
    expect(session.listenerCount("close")).toBe(1);
  } finally { transport.close(); }
});
