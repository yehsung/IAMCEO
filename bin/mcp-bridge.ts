// MCP stdio 서버. 세션 안에서 돌며 도구 목록·호출을 IAMCEO 서버로 중계한다.
// stdout 은 MCP 프로토콜 전용이다. 로그는 stderr 로만.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../server/config.ts";
import type { AgentToolDef, AgentToolResult, AskWaitResult } from "../server/orchestrator-api.ts";

const ASK_POLL_MS = 50_000;
const ASK_RETRY_MS = 2000;
// 답을 기다리는 도중의 서버 재시작은 넘긴다. 2분 넘게 안 돌아오면 알린다.
const ASK_MAX_FAILURES = 60;
const DEFAULT_PROGRESS_MS = 60_000;

/** 서버에 닿지 못했을 때만 connection=true. 이때만 다시 시도할 수 있다. */
class BridgeError extends Error {
  constructor(
    message: string,
    readonly connection = false,
  ) {
    super(message);
  }
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export async function runBridge(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const base = env.IAMCEO_URL?.replace(/\/+$/, "");
  const token = env.IAMCEO_TOKEN;
  if (!base || !token) {
    console.error("IAMCEO_URL 과 IAMCEO_TOKEN 이 필요합니다. iamceo join 이 알려 주는 명령으로 등록하세요.");
    process.exit(1);
  }
  const progressMs = Number(env.IAMCEO_PROGRESS_MS) || DEFAULT_PROGRESS_MS;

  async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new BridgeError(`IAMCEO 서버(${base})에 연결할 수 없습니다: ${(e as Error).message}. iamceo status 로 서버가 켜져 있는지 확인하세요.`, true);
    }
    if (res.status === 401) throw new BridgeError("IAMCEO 서버가 토큰을 거부했습니다. 토큰이 틀렸거나 이 직원이 닫혔습니다. iamceo join 으로 다시 등록하세요.");
    const parsed = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) throw new BridgeError(parsed?.error ?? `IAMCEO 서버 오류(${res.status})`);
    if (parsed === null) throw new BridgeError("IAMCEO 서버의 응답을 읽을 수 없습니다");
    return parsed;
  }

  async function waitForAnswer(decisionId: string, signal: AbortSignal): Promise<string> {
    let failures = 0;
    for (;;) {
      try {
        const result = await call<AskWaitResult>("/agent/ask/wait", { decisionId, timeoutMs: ASK_POLL_MS }, signal);
        failures = 0;
        if (result.done) return result.text;
      } catch (e) {
        if (!(e instanceof BridgeError && e.connection)) throw e;
        if (++failures >= ASK_MAX_FAILURES) throw new BridgeError(`질문 #${decisionId} 은 등록되어 있지만 답을 기다리다 서버 연결이 끊겼습니다. 서버가 돌아오면 wait 로 답을 받으세요. ${e.message}`, true);
        await Bun.sleep(ASK_RETRY_MS);
      }
    }
  }

  const server = new Server({ name: "iamceo", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await call<AgentToolDef[]>("/agent/tools");
    return { tools: tools.map((t) => ({ ...t, inputSchema: { ...t.inputSchema, type: "object" as const } })) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const progressToken = extra._meta?.progressToken;
    let progress = 0;
    const heartbeat =
      progressToken === undefined
        ? null
        : setInterval(() => {
            const notification: ServerNotification = { method: "notifications/progress", params: { progressToken, progress: ++progress, message: "기다리는 중" } };
            void extra.sendNotification(notification).catch((e) => console.error("progress 전송 실패:", e));
          }, progressMs);
    try {
      const result = await call<AgentToolResult>("/agent/tool", { name: request.params.name, args: request.params.arguments ?? {} }, extra.signal);
      const text = result.wait ? await waitForAnswer(result.wait.decisionId, extra.signal) : result.text;
      return { content: [{ type: "text" as const, text }], ...(result.isError ? { isError: true } : {}) };
    } catch (e) {
      if (extra.signal.aborted) return toolError("호출이 취소되었습니다");
      if (e instanceof BridgeError) return toolError(e.message);
      throw e;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  // 세션이 끝나면 stdin 이 닫힌다. 롱폴이 걸려 있어도 고아로 남지 않는다.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await runBridge();
