// MCP stdio 서버. 세션 안에서 돌며 도구 목록·호출을 IAMCEO 서버로 중계한다.
// stdout 은 MCP 프로토콜 전용이다. 로그는 stderr 로만.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../server/config.ts";
import type { AgentToolDef, AgentToolResult, AskWaitResult } from "../server/orchestrator-api.ts";

const ASK_POLL_MS = 50_000;
const ASK_RETRY_MS = 2000;
// 답을 기다리는 도중의 서버 재시작은 넘긴다. 2분 넘게 안 돌아오면 알린다.
const ASK_MAX_FAILURES = 60;
const DEFAULT_PROGRESS_MS = 60_000;
// 서버 재시작(종료 최대 15초 + 다시 뜨는 시간)을 넘긴다. CLI 의 도구 호출 한도(짧은 쪽 60초)보다 짧게 둔다.
const DEFAULT_CONNECT_RETRY_MS = 45_000;
// 도구 목록은 세션이 뜰 때 한 번 묻는다. CLI 의 MCP 시작 한도 안에 끝나야 한다.
const LIST_RETRY_MS = 20_000;

/** 전송/응답 유실. 재요청은 같은 operationId 또는 읽기 요청에서만 허용한다. */
class BridgeError extends Error {
  constructor(
    message: string,
    readonly connection = false,
  ) {
    super(message);
  }
}

/** 취소되면 바로 깬다. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export async function runBridge(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // 이 Mac 의 서버(127.0.0.1)로 가는 요청은 프록시를 거치지 않는다. Bun 은 HTTP_PROXY 가 있으면 127.0.0.1 로 가는 요청도 프록시로 보내
  // 팀장 열쇠가 실린 요청이 밖으로 나간다(runner/permission-hook.ts 와 같은 처리).
  for (const key of ["NO_PROXY", "no_proxy"]) process.env[key] = [process.env[key], "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",");
  const base = env.IAMCEO_URL?.replace(/\/+$/, "");
  const token = env.IAMCEO_TOKEN;
  if (!base || !token) {
    console.error("IAMCEO_URL 과 IAMCEO_TOKEN 이 필요합니다. iamceo join 이 알려 주는 명령으로 등록하세요.");
    process.exit(1);
  }
  const progressMs = Number(env.IAMCEO_PROGRESS_MS) || DEFAULT_PROGRESS_MS;
  const retryMs = env.IAMCEO_CONNECT_RETRY_MS === undefined ? DEFAULT_CONNECT_RETRY_MS : Math.max(0, Number(env.IAMCEO_CONNECT_RETRY_MS) || 0);

  async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, "X-IAMCEO-Contract": "2", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new BridgeError(`IAMCEO 서버(${base})에 연결할 수 없습니다: ${(e as Error).message}. iamceo status 로 서버가 켜져 있는지 확인하세요.`, true);
    }
    if (res.status === 401) throw new BridgeError("IAMCEO 서버가 토큰을 거부했습니다. 토큰이 틀렸거나 이 직원이 닫혔습니다. iamceo join 으로 다시 등록하세요.");
    let parsed: (T & { error?: string }) | null;
    try {
      parsed = await res.json() as (T & { error?: string }) | null;
    } catch {
      throw new BridgeError("IAMCEO 서버의 응답을 읽을 수 없습니다", res.ok);
    }
    // 종료 중인 서버는 요청을 처리하기 전에 돌려보낸다. 연결 실패와 같이 다시 보내도 된다.
    if (res.status === 503 && (parsed as { code?: string } | null)?.code === "STARTING") {
      throw new BridgeError(`IAMCEO 서버(${base})가 다시 시작하는 중입니다. 잠시 뒤 다시 시도하세요.`, true);
    }
    if (!res.ok) throw new BridgeError(parsed?.error ?? `IAMCEO 서버 오류(${res.status})`);
    if (parsed === null) throw new BridgeError("IAMCEO 서버의 응답을 읽을 수 없습니다");
    return parsed;
  }

  /** 서버가 잠깐 없는 동안 같은 요청을 다시 보낸다. 같은 operationId 이거나 읽기 요청일 때만 쓴다. */
  async function callWithRetry<T>(path: string, body: unknown, signal: AbortSignal | undefined, windowMs: number): Promise<T> {
    const deadline = Date.now() + windowMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return await call<T>(path, body, signal);
      } catch (e) {
        if (signal?.aborted || !(e instanceof BridgeError && e.connection)) throw e;
        // 첫 재요청은 바로 한다(응답 유실 회수). 그 뒤는 0.5초에서 3초까지 늘린다.
        const delay = attempt === 0 ? 0 : Math.min(3000, 500 * 2 ** (attempt - 1));
        if (attempt > 0 && Date.now() + delay > deadline) throw e;
        if (delay) await pause(delay, signal);
      }
    }
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

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const tools = await callWithRetry<AgentToolDef[]>("/agent/tools", undefined, extra.signal, Math.min(retryMs, LIST_RETRY_MS));
    return { tools: tools.map((t) => ({ ...t, inputSchema: {
      ...t.inputSchema, type: "object" as const,
      properties: { ...t.inputSchema.properties as Record<string, unknown>, operation_id: { type: "string", format: "uuid", description: "응답 유실 재요청 때만 이전 operation ID를 넣는다. 새 호출은 생략한다. 같은 ID의 다른 인자는 거부된다." } },
    } })) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { operation_id, ...args } = request.params.arguments ?? {};
    if (operation_id !== undefined && !z.uuid().safeParse(operation_id).success) return toolError("operation_id는 UUID여야 합니다");
    // MCP request ID/본문 해시는 새 호출의 신원이 아니다. 전송 전에 생성하고 재요청에만 재사용한다.
    const operationId = operation_id === undefined ? randomUUID() : operation_id as string;
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
      const body = { operationId, name: request.params.name, args: request.params.name === "wait" ? { ...args, batch: true } : args };
      const result = await callWithRetry<AgentToolResult>("/agent/tool", body, extra.signal, retryMs);
      const text = result.wait ? await waitForAnswer(result.wait.decisionId, extra.signal) : result.text;
      return { content: [{ type: "text" as const, text }], ...(result.isError ? { isError: true } : {}) };
    } catch (e) {
      if (extra.signal.aborted) return toolError(`호출이 취소되었습니다. 이미 접수되었을 수 있습니다. operation_id: ${operationId}`);
      if (e instanceof BridgeError) return toolError(`${e.message}\noperation_id: ${operationId}. 응답 유실을 확인하려면 같은 도구·인자와 이 ID로 재요청하세요. 새 ID로 반복하지 마세요.`);
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
