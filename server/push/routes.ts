import { z } from "zod";
import { DEFAULT_PUSH_BUNDLE_ID } from "../../shared/push.ts";
import type { PushProviderStatus, PushTestResult } from "../../shared/push.ts";
import { ApiError } from "../store.ts";
import type { PushStore } from "./store.ts";

export interface PushRoutesContext {
  store: PushStore;
  providers: () => readonly PushProviderStatus[];
  /** Called after commit. The host owns the worker and its lifetime. */
  wake?: () => void | Promise<void>;
}

const MAX_BODY_BYTES = 8 * 1024;
const uuid = z.string().refine((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)).transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const authorization = z.enum(["authorized", "provisional", "ephemeral", "denied", "notDetermined"]);
const label = z.string().refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(value));
const preferences = z.strictObject({ decision: z.boolean().optional(), approval_wait: z.boolean().optional(),
  error: z.boolean().optional(), report_complete: z.boolean().optional(), todo_created: z.boolean().optional(), report_blocked: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0);
const register = z.strictObject({ expectedRevision: revision.nullable(), platform: z.literal("ios"),
  bundleId: z.string().min(1).max(255), environment: z.enum(["sandbox", "production"]),
  deviceToken: z.string().max(1024).refine((value) => /^(?:[0-9a-f]{2})+$/i.test(value)).transform((value) => value.toLowerCase()),
  authorization: z.enum(["authorized", "provisional", "ephemeral"]), label: label.optional() });
const patch = z.strictObject({ expectedRevision: revision, enabled: z.boolean().optional(), preferences: preferences.optional(),
  label: label.optional(), authorization: authorization.optional() }).refine((value) => Object.keys(value).length > 1);
const testRequest = z.strictObject({ requestId: uuid });

function parse<T>(value: unknown, schema: z.ZodType<T>): T {
  const result = schema.safeParse(value);
  // Zod diagnostics may include a device token. Never pass them to the HTTP catch/log.
  if (!result.success) throw new ApiError(400, "푸시 요청 값이 올바르지 않습니다");
  return result.data;
}

/** Bound actual UTF-8 bytes, including chunked bodies and bodies on read/delete routes. */
async function body(req: Request): Promise<string> {
  const length = req.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw new ApiError(400, "본문 길이가 올바르지 않습니다");
    if (Number(length) > MAX_BODY_BYTES) throw new ApiError(413, "푸시 요청 본문은 8KiB 이하여야 합니다");
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ApiError(413, "푸시 요청 본문은 8KiB 이하여야 합니다");
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "푸시 요청 본문을 읽을 수 없습니다");
  } finally { reader.releaseLock(); }
}

function json<T>(text: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ApiError(400, "JSON 본문이 올바르지 않습니다"); }
  return parse(value, schema);
}

function deleteRevision(req: Request): number {
  const match = /^"([1-9]\d*)"$/.exec(req.headers.get("if-match") ?? "");
  if (!match) throw new ApiError(400, "If-Match revision이 필요합니다");
  return parse(Number(match[1]), revision);
}

/** Mount ONLY after user Bearer, Host/Origin/IP checks; never on the agent router. */
export function createPushHandler(ctx: PushRoutesContext): (req: Request, url: URL) => Promise<Response> {
  const response = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  return async (req, url) => {
    try {
      if (url.search) throw new ApiError(400, "푸시 요청에는 query를 사용할 수 없습니다");
      const devicePath = /^\/api\/push\/devices\/([^/]+)(\/test)?$/.exec(url.pathname);
      const targetPath = /^\/api\/push\/events\/([^/]+)\/target$/.exec(url.pathname);
      const statusPath = url.pathname === "/api/push/status";
      const listPath = url.pathname === "/api/push/devices";
      if (!devicePath && !targetPath && !statusPath && !listPath) throw new ApiError(404, "없는 푸시 경로입니다");
      const methods = devicePath ? devicePath[2] ? ["POST"] : ["GET", "PUT", "PATCH", "DELETE"] : ["GET"];
      if (!methods.includes(req.method)) throw new ApiError(405, "허용되지 않는 메서드입니다");
      let id = "";
      if (devicePath || targetPath) {
        let decoded: string;
        try { decoded = decodeURIComponent((devicePath ?? targetPath)![1]); } catch { throw new ApiError(400, "경로가 올바르지 않습니다"); }
        id = parse(decoded, uuid);
      }
      const text = await body(req);
      if (["GET", "DELETE"].includes(req.method) && text.length) throw new ApiError(400, "본문이 없는 요청이어야 합니다");
      const push = ctx.store;
      if (statusPath) {
        // Project only public fields, even when a provider object also holds credentials.
        const configured = ctx.providers();
        const providers = (["sandbox", "production"] as const).map((environment) => {
          const provider = configured.find((entry) => entry.environment === environment);
          return { environment, bundleId: provider?.bundleId ?? DEFAULT_PUSH_BUNDLE_ID,
            state: provider?.state ?? "unconfigured", lastError: provider?.lastError ?? null };
        });
        return response({ serverId: push.serverId, supported: true, providers });
      }
      if (listPath) return response({ devices: push.listDevices() });
      if (targetPath) return response(push.eventTarget(id));
      if (req.method === "GET") return response(push.requireDevice(id));
      if (req.method === "PUT") {
        const request = json(text, register);
        const saved = push.registerDevice(id, request);
        return response(saved, request.expectedRevision === null ? 201 : 200);
      }
      if (req.method === "PATCH") return response(push.patchDevice(id, json(text, patch)));
      if (req.method === "DELETE") {
        push.revokeDevice(id, deleteRevision(req));
        return response({ ok: true });
      }
      const request = json(text, testRequest);
      let created = false;
      const result = push.transaction<PushTestResult>(() => {
        push.sweep();
        const sourceKey = `test:${id}:${request.requestId}`;
        const existing = push.eventBySource(sourceKey);
        if (existing) return { notificationId: existing.id, state: "queued" };
        const registration = push.getRegistration(id);
        if (!registration) throw new ApiError(404, "기기를 찾을 수 없습니다");
        const { device, deviceToken } = registration;
        const at = push.timestamp();
        if (!device.enabled || device.state !== "active" || !deviceToken ||
            !["authorized", "provisional", "ephemeral"].includes(device.authorization) || device.expiresAt <= at ||
            !ctx.providers().some((provider) => provider.environment === device.environment && provider.bundleId === device.bundleId && provider.state === "ready")) {
          throw new ApiError(409, "이 기기에서 시험 알림을 보낼 수 없습니다");
        }
        const cutoff = new Date(Date.parse(at) - 60_000).toISOString();
        if (push.db.query("SELECT 1 FROM push_events WHERE kind='test' AND source_key LIKE ? AND occurred_at>? LIMIT 1")
          .get(`test:${id}:%`, cutoff)) throw new ApiError(429, "시험 알림은 기기당 분당 한 번 보낼 수 있습니다");
        const event = push.recordEvent({ sourceKey, kind: "test", projectId: null, memberId: null,
          target: { screen: "home" }, occurredAt: at }, [{ deviceId: id, registrationGeneration: registration.registrationGeneration }]);
        if (push.listDeliveries(event.id).length !== 1) throw new ApiError(409, "이 기기에서 시험 알림을 보낼 수 없습니다");
        created = true;
        return { notificationId: event.id, state: "queued" };
      });
      if (created && ctx.wake) {
        void Promise.resolve().then(() => ctx.wake!()).catch(() => { console.error("푸시 큐 처리 실패"); });
      }
      return response(result, 202);
    } catch (error) {
      if (error instanceof ApiError) return response({ error: error.message }, error.status);
      // SQLite/provider exceptions can contain tokens, paths or credential objects.
      return response({ error: "푸시 요청을 처리하지 못했습니다" }, 500);
    }
  };
}
