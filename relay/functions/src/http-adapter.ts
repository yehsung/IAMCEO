// Node 의 요청·응답(Express 도 같은 것을 물려받는다)을 중계 핵심에 잇는다.
// Firebase 함수는 본문을 미리 읽어 req.rawBody 에 둔다. 시험의 일반 http 서버는 직접 읽어 같은 자리에 둔다.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Relay, RelayResponse } from "./relay.ts";

export type NodeRequest = IncomingMessage & { rawBody?: Buffer; body?: unknown; originalUrl?: string };

function bodyOf(request: NodeRequest): Buffer | undefined {
  if (Buffer.isBuffer(request.rawBody)) return request.rawBody;
  if (Buffer.isBuffer(request.body)) return request.body;
  if (typeof request.body === "string") return Buffer.from(request.body, "utf8");
  // rawBody 가 없으면(일어나지 않아야 한다) 해석된 객체를 다시 JSON 으로 바꿔 같은 검사를 거친다.
  if (request.body !== null && typeof request.body === "object") return Buffer.from(JSON.stringify(request.body), "utf8");
  return undefined;
}

export function nodeHandler(relay: Pick<Relay, "handle">) {
  return async (request: NodeRequest, response: ServerResponse): Promise<void> => {
    let result: RelayResponse;
    try {
      result = await relay.handle({ method: request.method ?? "GET", path: request.originalUrl ?? request.url ?? "/",
        headers: request.headers, body: bodyOf(request) });
    } catch {
      result = { status: 500, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: '{"reason":"internal_error"}' };
    }
    if (response.headersSent) return;
    response.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
    response.end(request.method === "HEAD" ? undefined : result.body);
  };
}
