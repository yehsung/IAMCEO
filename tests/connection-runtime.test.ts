import { expect, test } from "bun:test";
import { join } from "node:path";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

test("CLI SIGTERM announces restarting to v1/v2/lite sockets then closes 1012", async () => {
  const fixture = createIsolatedRuntime();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/iamceo.ts"), "serve"], {
    cwd: fixture.paths.work, env: fixture.childEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const stderr = new Response(child.stderr).text();
  let output = "";
  let ready!: (url: string) => void;
  let failed!: (error: Error) => void;
  const listening = new Promise<string>((resolve, reject) => { ready = resolve; failed = reject; });
  const drain = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      // 명령줄 문구는 실행 환경의 언어(LANG)를 따른다(server/cli-text.ts). 두 언어를 모두 받는다.
      const match = /IAMCEO (?:서버|server): (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) ready(match[1]);
    }
    failed(new Error(`CLI exited before listening: ${output}`));
  })();
  const sockets: WebSocket[] = [];
  try {
    const base = await listening;
    expect(new URL(base).port).not.toBe("7878");
    const config = await Bun.file(join(fixture.paths.iamceoHome, "config.json")).json();
    const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const connections = ["", "?lite=1", "?v=2", "?v=2&lite=1"].map(query => {
      const events: unknown[] = [];
      const ws = new Socket(base.replace("http", "ws") + "/ws" + query, { headers: { Authorization: `Bearer ${config.accessCode}` } });
      sockets.push(ws);
      const hello = new Promise<void>((resolve, reject) => {
        ws.onmessage = event => { const message = JSON.parse(String(event.data)); events.push(message); if (message.type === "hello") resolve(); };
        ws.onerror = () => reject(new Error("fixture WS failed"));
      });
      const closed = new Promise<CloseEvent>(resolve => { ws.onclose = resolve; });
      return { hello, closed, events };
    });
    await Promise.all(connections.map(connection => connection.hello));
    child.kill("SIGTERM");
    for (const connection of connections) {
      const close = await connection.closed;
      expect(connection.events).toContainEqual({ type: "restarting" });
      expect(close.code).toBe(1012);
      expect(close.reason).toBe("restarting");
    }
    expect(await child.exited).toBe(0);
    await drain;
    expect(output).toMatch(/\[startup\] ready durationMs=\d+\.\d/);
    console.info(`[conn-test] CLI ${/\[startup\] ready durationMs=\d+\.\d/.exec(output)![0]}`);
  } finally {
    for (const ws of sockets) ws.close();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await drain;
    clearTimeout(deadline);
    const errors = await stderr;
    await fixture.stop();
    expect(errors).not.toContain("error:");
  }
}, 12_000);
