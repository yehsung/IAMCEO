import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreRpc } from "../server/runner/core-client.ts";
import { rpc } from "../server/runner/herdr-client.ts";

/** 서버의 동기 작업(큰 DB 조회 등)이 이벤트 루프를 붙잡는 상황. */
const stall = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* 루프를 붙잡는다 */ } };
const servers: { dir: string; server: Server; sockets: Set<Socket> }[] = [];
/** 답을 쓴 바로 그 순간부터 루프가 멈추게 할 수 있는 가짜 소켓 서버. 두 클라이언트의 응답 형식을 함께 만족한다. */
async function fake(options: { silent?: boolean; stallAfterReply?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "iamceo-stab-rpc-")), path = join(dir, "s.sock"), sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0 || options.silent) return;
      const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }) + "\n");
      if (options.stallAfterReply) stall(options.stallAfterReply);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  servers.push({ dir, server, sockets });
  return path;
}
afterEach(async () => { for (const s of servers.splice(0)) { for (const socket of s.sockets) socket.destroy(); await new Promise<void>((resolve) => s.server.close(() => resolve())); rmSync(s.dir, { recursive: true, force: true }); } });

const clients = [
  ["coreRpc", (path: string, timeoutMs: number) => coreRpc<{ ok: boolean }>(path, "terminal.get", {}, timeoutMs)],
  ["herdr rpc", (path: string, timeoutMs: number) => rpc<{ ok: boolean }>(path, "agent.get", {}, timeoutMs)],
] as const;

describe.each(clients)("%s: 루프가 멈췄던 시간은 답을 기다린 시간이 아니다", (_name, call) => {
  test("요청을 내자마자 루프가 기한보다 오래 멈춰도 가짜 timeout 이 나지 않는다", async () => {
    const path = await fake();
    const pending = call(path, 800);
    stall(1000); // 연결도 하기 전에 기한이 지났다.
    expect(await pending).toEqual({ ok: true });
  });
  test("답이 도착한 뒤 루프가 기한 너머까지 멈춰도 그 답을 읽는다", async () => {
    const path = await fake({ stallAfterReply: 450 });
    expect(await call(path, 200)).toEqual({ ok: true });
  });
  test("루프가 멈췄더라도 정말 답이 없으면 끝내 timeout 이다", async () => {
    const path = await fake({ silent: true });
    const pending = call(path, 300).then(() => null, (error: Error & { deliveryEffect?: string }) => error);
    stall(500);
    const error = await pending;
    expect(error?.message).toMatch(/300ms/); expect(error?.deliveryEffect).toBe("unknown");
  });
});

test("답이 없는 요청은 전과 같은 분류로 실패한다: 쓴 뒤 timeout 은 unknown", async () => {
  const path = await fake({ silent: true });
  await expect(coreRpc(path, "terminal.send", {}, 120)).rejects.toMatchObject({ kind: "timeout", uncertain: true, deliveryEffect: "unknown" });
  await expect(rpc(path, "agent.prompt", {}, 120)).rejects.toMatchObject({ code: "timeout", deliveryEffect: "unknown" });
});
