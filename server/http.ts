import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { detectTailscaleIp, generateAccessCode, updateConfigFile } from "./config.ts";
import { MIGRATIONS } from "./db.ts";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import { EFFORTS, fileKindOf, memberRank, PERMISSION_MODES, type Bootstrap, type HerdrInfo, type Member, type MessagePageOptions, type SyncCursor, type SyncSnapshot } from "../shared/types.ts";
import type { OperationReceipt, ServerCapabilities } from "../shared/operations.ts";
import type { DeliveryRecoveryService } from "./service-contracts.ts";
import { ARTIFACT_CSP } from "../shared/artifact-kit.ts";
import type { Bus } from "./bus.ts";
import { VERSION, type Config } from "./config.ts";
import { MAX_ARTIFACT_BYTES, MAX_UPLOAD_BYTES, resolveInside, saveUpload } from "./files.ts";
import type { OrchestratorApi } from "./orchestrator-api.ts";
import { ApiError, type Store } from "./store.ts";
import { SESSION_ID_RE } from "./text.ts";
import { Pairing, PAIR_CODE_TTL_MS, tailnetUrls, withMagicDnsNames } from "./pairing.ts";
import { createPushHandler, type PushRoutesContext } from "./push/routes.ts";

export interface ServerContext {
  config: Config;
  store: Store;
  bus: Bus;
  orch: OrchestratorApi;
  /** 읽기 전용 notice와 복구 예약 포트. 호스트가 소유한 엔진만 주입한다. */
  delivery?: Pick<DeliveryRecoveryService, "notices" | "memberNotices" | "recover">;
  push?: PushRoutesContext;
  /** 시험용. 기본은 Tailscale 주소 감지. */
  detectHosts?: () => string[];
  daemon?: () => { ready: boolean; buildId: string; version: string };
}

export interface HostBinding {
  host: string;
  state: "bound" | "failed";
  attempts: number;
  lastAttemptAt: string;
  error: string | null;
}

export interface RunningServer {
  port: number;
  hosts: string[];
  urls: string[];
  readonly hostBindings?: HostBinding[];
  /** 지금 잡히는 주소 중 아직 안 연 것을 연다(로그인 직후 Tailscale 이 늦게 올라오는 경우). */
  syncHosts(): void;
  stop(): Promise<void>;
}

const HOST_SYNC_MS = 30_000;
const WS_PING_MS = 15_000;

// ---- 접근 제어 ----
export interface IpRule {
  subnets: { base: number; mask: number }[];
  exact: Set<string>;
}

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
}

function inSubnet(ip: number, base: number, mask: number): boolean {
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

const LOOPBACK_V4 = { base: v4ToInt("127.0.0.0")!, mask: 0xff000000 };
const TAILSCALE_V4 = { base: v4ToInt("100.64.0.0")!, mask: 0xffc00000 };

/** `hosts` 에 넣은 LAN 주소의 대역을 허용 목록으로 바꾼다. 와일드카드 주소는 대역을 넓히지 않는다. */
export function buildIpRule(hosts: string[]): IpRule {
  const rule: IpRule = { subnets: [], exact: new Set() };
  const interfaces = Object.values(networkInterfaces()).flat();
  for (const host of hosts) {
    if (host === "0.0.0.0" || host === "::" || host === "localhost") continue;
    const ip = v4ToInt(host);
    if (ip === null) {
      rule.exact.add(host.toLowerCase());
      continue;
    }
    const netmask = interfaces.find((a) => a?.address === host)?.netmask;
    rule.subnets.push({ base: ip, mask: (netmask ? v4ToInt(netmask) : null) ?? 0xffffff00 });
  }
  return rule;
}

export function isIpAllowed(rawIp: string | null | undefined, rule: IpRule): boolean {
  if (!rawIp) return false;
  const ip = rawIp.toLowerCase().replace(/^::ffff:/, "");
  const v4 = v4ToInt(ip);
  if (v4 !== null) {
    if (inSubnet(v4, LOOPBACK_V4.base, LOOPBACK_V4.mask) || inSubnet(v4, TAILSCALE_V4.base, TAILSCALE_V4.mask)) return true;
    return rule.subnets.some((s) => inSubnet(v4, s.base, s.mask));
  }
  return ip === "::1" || ip.startsWith("fd7a:115c:a1e0:") || rule.exact.has(ip);
}

/** 길이가 달라도 시간이 새지 않게 해시를 비교한다. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** 저장 예외 뒤 rename 여부만 읽는다. loadConfig처럼 누락된 설정을 만들지는 않는다. */
function rotationWasSaved(config: Config, accessCode: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(config.configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()) return false;
    const saved = z.object({ accessCode: z.string() }).safeParse(JSON.parse(readFileSync(fd, "utf8")));
    return saved.success && safeEqual(saved.data.accessCode, accessCode);
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function originMatchesHost(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * DNS 리바인딩 막기. 바깥 도메인을 이 서버 주소로 돌려도 그 이름이 Host 로 오므로 여기서 끊는다.
 * 주소 그대로(IP)·localhost·설정한 hosts·바깥에서 다시 묶을 수 없는 이름(점 없는 이름, .local, Tailscale 의 .ts.net)만 받는다.
 */
export function isHostAllowed(rawHost: string | null, configured: string[]): boolean {
  if (!rawHost) return false;
  const host = rawHost.trim().toLowerCase();
  if (host.startsWith("[")) return /^\[[0-9a-f:.]+\](:\d+)?$/.test(host);
  const name = host.replace(/:\d+$/, "");
  if (!name || name.includes(":")) return false;
  if (v4ToInt(name) !== null || name === "localhost") return true;
  if (!name.includes(".") || name.endsWith(".local") || name.endsWith(".ts.net")) return true;
  return configured.some((h) => h.toLowerCase() === name);
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1]!.trim() : null;
}

// ---- 요청 검증 ----
const nonEmpty = z.string().trim().min(1);
const backend = z.enum(["core", "herdr", "headless"]);
const cliProvider = z.enum(["claude", "codex"]);
const permissionMode = z.enum(PERMISSION_MODES);
const effort = z.enum(EFFORTS);
// 그대로 --model 뒤에 들어간다. '--플래그' 나 공백이 들어오면 안 된다. 별칭(haiku)·전체 이름·[1m] 을 받는다.
const modelName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$/, "모델 이름이 잘못되었습니다");
const rankPatch = z.object({ model: modelName.nullable(), effort: effort.nullable() }).partial().strict();
const handle = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

// 실행 방식·권한·모델은 전체 설정 하나다. 옛 화면이 보낸 값을 조용히 버리지 않고 거부한다.
const CreateProjectSchema = z.strictObject({
  name: nonEmpty,
  cwd: nonEmpty,
  goal: z.string().optional(),
  startConductor: z.boolean().optional(),
  chiefCli: cliProvider.optional(),
});
const PatchProjectSchema = z.strictObject({
  name: nonEmpty.optional(),
  cwd: nonEmpty.optional(),
  runnerEnabled: z.boolean().optional(),
  now: z.string().optional(),
  archived: z.boolean().optional(),
});
const AnswerApprovalSchema = z.strictObject({
  fingerprint: z.string().regex(/^[0-9a-f]{8,64}$/),
  option: z.number().int().min(1).max(9),
  note: z.string().max(4000).optional(),
});
const CreateMemberSchema = z.strictObject({ name: nonEmpty, role: z.string().optional(), cli: cliProvider.optional(), modelOverride: modelName.nullable().optional() });
const PatchMemberSchema = z.strictObject({ cli: cliProvider.optional(), modelOverride: modelName.nullable().optional(), effortOverride: effort.nullable().optional() });
const TerminalControlSchema = z.strictObject({
  action: z.enum(["claim", "release", "input", "key"]),
  leaseId: nonEmpty.max(256).optional(),
  text: z.string().min(1).max(131072).optional(),
  key: z.enum(["enter", "up", "down", "esc", "tab", "ctrl+c", "backspace"]).optional(),
}).superRefine((value, ctx) => {
  if (value.action !== "claim" && !value.leaseId) ctx.addIssue({ code: "custom", message: "leaseId가 필요합니다" });
  if (value.action === "input" && !value.text) ctx.addIssue({ code: "custom", message: "text가 필요합니다" });
  if (value.action === "key" && !value.key) ctx.addIssue({ code: "custom", message: "key가 필요합니다" });
});
const SendMessageSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  text: z.string(),
  targetMemberId: z.string().nullable().optional(),
  attachmentIds: z.array(z.string()).max(50).optional(),
});
const AnswerSchema = z.object({
  expectedVersion: nonEmpty.optional(),
  choice: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  batch: z.boolean().optional(),
});
const TodoDoneSchema = z.object({ done: z.boolean() });
const SleepSchema = z.object({ force: z.boolean().optional() });
const AdoptSchema = z.object({
  paneId: nonEmpty,
  name: nonEmpty,
  role: z.string(),
  handle: handle.optional(),
  kind: z.enum(["conductor", "worker"]).optional(),
});
const SettingsSchema = z
  .object({
    backend,
    permissionMode,
    ranks: z.object({ manager: rankPatch, lead: rankPatch, staff: rankPatch }).partial().strict(),
    maxConcurrentTurns: z.number().int().min(1).max(64),
    compactAtPct: z.number().int().min(1).max(100),
    // 창 크기(토큰)를 모를 때의 값. 1k~10M.
    contextWindowDefault: z.number().int().min(1_000).max(10_000_000),
    contextWindows: z.record(z.string().min(1).max(200), z.number().int().min(1_000).max(10_000_000)),
    maxAwakeWorkers: z.number().int().min(1).max(256),
    notifyMac: z.boolean(),
    // 0 이면 끈다. 화면은 끔·3·6·12·24 를 고르게 한다.
    boardTidyHours: z.number().int().min(0).max(168),
  })
  .partial()
  .strict();
const AgentToolSchema = z.object({ name: nonEmpty, args: z.record(z.string(), z.unknown()).optional() });
const AskWaitSchema = z.object({ decisionId: nonEmpty, timeoutMs: z.number().int().positive().optional() });
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const operationIdSchema = z.uuid();
const FreshSessionSchema = z.strictObject({ operationId: operationIdSchema, expectedSessionGeneration: revision });
const terminalIdentity = { operationId: operationIdSchema, expectedSessionGeneration: revision, claimId: z.string().min(1).max(256) };
const terminalKey = z.enum(["enter", "up", "down", "esc", "tab", "ctrl+c", "backspace"]);
const TerminalControlV2Schema = z.discriminatedUnion("action", [
  z.strictObject({ ...terminalIdentity, action: z.literal("claim") }),
  z.strictObject({ ...terminalIdentity, action: z.literal("release") }),
  z.strictObject({ ...terminalIdentity, action: z.literal("input"), inputSequence: revision, text: z.string().min(1).max(131072) }),
  z.strictObject({ ...terminalIdentity, action: z.literal("key"), inputSequence: revision, key: terminalKey }),
]);
const RecoverySchema = z.discriminatedUnion("action", [
  z.strictObject({ operationId: operationIdSchema, expectedVersion: revision.min(1), action: z.literal("recheck") }),
  z.strictObject({ operationId: operationIdSchema, expectedVersion: revision.min(1), action: z.literal("stop_retry") }),
  z.strictObject({ operationId: operationIdSchema, expectedVersion: revision.min(1), action: z.literal("retry_with_risk"), acceptDuplicateRisk: z.literal(true) }),
]);
const AgentOperationSchema = AgentToolSchema.extend({ operationId: operationIdSchema }).strict();
const ManualInboxSchema = z.strictObject({ timeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });
const ManualAckSchema = z.strictObject({ batchId: z.string().min(1).max(256) });
const AnswerV2Schema = AnswerSchema.extend({ expectedVersion: nonEmpty }).strict();
const JoinSchema = z.object({
  project: z.string().optional(),
  cwd: z.string().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  handle: handle.optional(),
  // --resume 뒤에 그대로 들어가고 복사 명령·기록 경로에도 쓰인다. '--플래그' 나 셸 글자가 들어오면 안 된다.
  sessionId: z.string().regex(SESSION_ID_RE, "세션 ID 는 UUID 여야 합니다").optional(),
});

const ASK_WAIT_MAX_MS = 50_000;

function contractV2(req: Request): boolean {
  const contract = req.headers.get("X-IAMCEO-Contract");
  if (contract !== null && contract !== "1" && contract !== "2") throw new ApiError(400, "쓰기 계약 버전이 잘못되었습니다", "INVALID_CONTRACT");
  return contract === "2";
}

function precondition(req: Request): { expectedRevision: number } {
  const value = req.headers.get("If-Match");
  if (!value || !/^"[0-9]+"$/.test(value) || !Number.isSafeInteger(Number(value.slice(1, -1)))) {
    throw new ApiError(400, "If-Match에 검토한 정수 revision이 필요합니다", "INVALID_REVISION");
  }
  return { expectedRevision: Number(value.slice(1, -1)) };
}

function publicFields<T extends object>(value: T, keys: readonly (keyof T)[]): object {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

function receiptMember(member: Member): object {
  return publicFields(member, ["id", "projectId", "handle", "name", "role", "kind", "origin", "wasAdopted", "cli", "backend",
    "modelOverride", "effortOverride", "appliedModel", "appliedEffort", "status", "now", "next", "cwd", "sessionId", "paneId",
    "contextPct", "contextWindow", "contextWindowSource", "subagents", "parallel", "queuedCount", "lastError", "updatedAt", "createdAt",
    "statusObservation", "blockedReason", "subagentState", "nowAt", "manualActivityAt", "executionState", "lifecycleState", "contextState"]);
}

/** receipt의 내부 request/token 등 임의 필드를 직렬화하지 않는다. */
function operationResponse(receipt: OperationReceipt): Response {
  const { operationId, kind, projectId, memberId, createdAt, updatedAt, status } = receipt;
  const base = { operationId, kind, projectId, memberId, createdAt, updatedAt, status };
  if (receipt.status === "pending") return Response.json(base);
  if (receipt.status !== "applied") return Response.json({ ...base, code: receipt.code, error: receipt.error });
  let result;
  switch (receipt.kind) {
    case "fresh_session": result = { member: receiptMember(receipt.result.member), sessionGeneration: receipt.result.sessionGeneration }; break;
    case "terminal_control": {
      const { memberId, action, claimId, sessionGeneration, inputSequence, leaseId, expiresAt } = receipt.result;
      result = { memberId, action, claimId, sessionGeneration, inputSequence, leaseId, expiresAt }; break;
    }
    case "settings": result = { settings: publicFields(receipt.result.settings, ["backend", "permissionMode", "ranks", "maxConcurrentTurns", "compactAtPct", "contextWindowDefault", "contextWindows", "maxAwakeWorkers", "notifyMac", "boardTidyHours"]), revision: receipt.result.revision }; break;
    case "member_config": result = { member: receiptMember(receipt.result.member), configRevision: receipt.result.configRevision, sessionGeneration: receipt.result.sessionGeneration }; break;
    case "todo_done": result = { todo: publicFields(receipt.result.todo, ["id", "projectId", "memberId", "who", "title", "detail", "done", "doneAt", "createdAt", "outcome", "closeReason", "closedBy"]), revision: receipt.result.revision }; break;
  }
  return Response.json({ ...base, result });
}

async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "JSON 본문이 필요합니다");
  }
  return validateBody(raw, schema);
}

function validateBody<S extends z.ZodType>(raw: unknown, schema: S): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new ApiError(400, `요청이 잘못되었습니다: ${issue?.path.join(".") || "본문"} ${issue?.message ?? ""}`.trim());
}

function parseLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(400, "limit 값이 잘못되었습니다");
  return n;
}

function strictQuery(url: URL, allowed: string[], code?: string): void {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key)) throw new ApiError(400, "조회 조건이 잘못되었습니다", code);
    seen.add(key);
  }
}

function strictLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new ApiError(400, "대화 조회 조건이 잘못되었습니다", "INVALID_MESSAGE_PAGE_QUERY");
  return Number(raw);
}

function messagePageQuery(url: URL): MessagePageOptions {
  strictQuery(url, ["scope", "memberId", "limit", "cursor"], "INVALID_MESSAGE_PAGE_QUERY");
  const scope = url.searchParams.get("scope") ?? "project";
  const memberId = url.searchParams.get("memberId");
  if ((scope !== "project" && scope !== "member") || (scope === "project" && memberId !== null) ||
      (scope === "member" && (!memberId || Buffer.byteLength(memberId) > 256))) {
    throw new ApiError(400, "대화 조회 조건이 잘못되었습니다", "INVALID_MESSAGE_PAGE_QUERY");
  }
  return { scope: scope === "project" ? { kind: "project" } : { kind: "member", memberId: memberId! },
    limit: strictLimit(url.searchParams.get("limit"), 200, 500), cursor: url.searchParams.get("cursor") ?? undefined };
}

function expandDir(raw: string): string {
  const path = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(path)) throw new ApiError(400, "폴더는 절대 경로여야 합니다");
  const full = resolve(path);
  let isDir = false;
  try {
    isDir = statSync(full).isDirectory();
  } catch {
    // 없는 경로는 아래에서 같은 오류로 처리한다.
  }
  if (!isDir) throw new ApiError(400, `폴더가 없습니다: ${full}`);
  return full;
}

/** cwd 를 품는 프로젝트 중 가장 깊은 것. 본사(cwd=홈)는 거의 모든 경로를 품으므로 뺀다. */
function projectForCwd(store: Store, cwd: string): string | null {
  let best: { id: string; depth: number } | null = null;
  for (const p of store.listProjects()) {
    if (p.isHq) continue;
    const rel = relative(p.cwd, cwd);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
    if (!best || p.cwd.length > best.depth) best = { id: p.id, depth: p.cwd.length };
  }
  return best?.id ?? null;
}

// ---- 라우팅 ----
type Handler = (req: Request, url: URL, params: string[]) => Response | Promise<Response>;
interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

function fail(status: number, message: string, code?: string): Response {
  return Response.json({ error: message, ...(code ? { code } : {}) }, { status });
}

function decodeParams(match: RegExpExecArray): string[] {
  try {
    return match.slice(1).map(decodeURIComponent);
  } catch {
    throw new ApiError(400, "경로가 잘못되었습니다");
  }
}

function dispatch(routes: Route[], req: Request, url: URL): Response | Promise<Response> {
  let pathMatched = false;
  for (const route of routes) {
    const match = route.pattern.exec(url.pathname);
    if (!match) continue;
    pathMatched = true;
    if (route.method === req.method) return route.handler(req, url, decodeParams(match));
  }
  return pathMatched ? fail(405, "허용되지 않는 메서드입니다") : fail(404, "없는 경로입니다");
}

/** 다른 기기에서 들어올 주소. 와일드카드로 들으면 실제 인터페이스 주소를 보여 준다. */
function reachableUrls(hosts: string[], port: number): string[] {
  const expanded = hosts.flatMap((h) => {
    if (h !== "0.0.0.0" && h !== "::") return [h];
    return Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && a.family === "IPv4")
      .map((a) => a!.address);
  });
  return [...new Set(expanded)].map((h) => `http://${h.includes(":") ? `[${h}]` : h}:${port}`);
}

/** 아티팩트 원본. 새 자료는 표에 있고, 예전 자료는 첨부로 올라간 .html 이다. */
async function artifactHtml({ config, store }: ServerContext, id: string): Promise<string> {
  const file = store.getFile(id);
  if (!file) throw new ApiError(404, "자료를 찾을 수 없습니다");
  if (file.kind !== "artifact") throw new ApiError(404, "아티팩트 자료가 아닙니다");
  const html = store.getFileHtml(id);
  if (html !== null) return html;
  const attachment = file.attachments.find((a) => fileKindOf(a.name, a.mime) === "artifact");
  const path = attachment ? resolveInside(config.uploadsDir, attachment.path) : null;
  if (!path) throw new ApiError(404, "원본을 찾을 수 없습니다");
  const source = Bun.file(path);
  if (source.size > MAX_ARTIFACT_BYTES) throw new ApiError(413, "아티팩트가 2MB 를 넘습니다. 첨부로 내려받아 보세요");
  return source.text();
}

function apiRoutes(ctx: ServerContext, urls: () => string[], pairing: Pairing, readHerdr: () => Promise<HerdrInfo>, currentHerdr: () => HerdrInfo): Route[] {
  const { config, store, orch, bus } = ctx;
  const legacyProjectPatches = new Set<string>();
  // 재전송이 앞 요청의 orch 처리가 끝나기 전에 와도 두 번 전달되지 않게 한다.
  const inFlight = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const running = inFlight.get(key);
    if (running) return running as Promise<T>;
    const started = run().finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  };

  const route = (method: string, path: string, handler: Handler): Route => ({
    method,
    pattern: new RegExp(`^${path.replace(/:[a-z]+/g, "([^/]+)")}$`),
    handler,
  });

  /** 연결되어 있지 않으면 409. 화면도 입력을 막지만 다른 기기·늦게 온 요청이 있다. */
  const requireReachable = async (projectId: string, targetId: string | null): Promise<void> => {
    await orch.refreshConnection?.();
    store.requireReachable(projectId, targetId ? store.getMember(targetId) : null);
  };

  const memberAction = (run: (id: string) => Promise<Member | void>): Handler => {
    return async (_req, _url, [id]) => {
      store.requireMember(id!);
      await run(id!);
      return Response.json(store.getMember(id!) ?? { ok: true });
    };
  };
  const activeProject = (id: string): void => {
    if (store.requireProject(id).archived) throw new ApiError(404, "프로젝트를 찾을 수 없습니다");
  };
  const archivedProject = (id: string): void => {
    if (!store.requireProject(id).archived) throw new ApiError(404, "프로젝트를 찾을 수 없습니다");
  };
  const messages: Handler = (_req, url, [id]) => {
    if (url.searchParams.has("around")) {
      strictQuery(url, ["around", "limit"], "INVALID_MESSAGE_PAGE_QUERY");
      const around = url.searchParams.get("around")!;
      if (!around || Buffer.byteLength(around) > 256) throw new ApiError(400, "대화 조회 조건이 잘못되었습니다", "INVALID_MESSAGE_PAGE_QUERY");
      return Response.json(store.listMessagesAround(id!, around, strictLimit(url.searchParams.get("limit"), 41, 100)));
    }
    return Response.json(store.listMessages(id!, { before: url.searchParams.get("before") ?? undefined, limit: parseLimit(url) }));
  };

  return [
    route("GET", "/api/operations/:id", async (_req, url, [id]) => {
      strictQuery(url, []);
      if (!operationIdSchema.safeParse(id).success) throw new ApiError(400, "operationId가 잘못되었습니다");
      if (!orch.operation) throw new ApiError(501, "작업 결과 조회를 지원하지 않습니다");
      const receipt = await orch.operation(id!);
      if (receipt.projectId !== null) store.requireProject(receipt.projectId);
      if (receipt.memberId !== null && store.requireMember(receipt.memberId).projectId !== receipt.projectId) throw new ApiError(404, "작업을 찾을 수 없습니다");
      return operationResponse(receipt);
    }),
    route("GET", "/api/members/:id/delivery-notices", (_req, url, [id]) => {
      activeProject(store.requireMember(id!).projectId);
      strictQuery(url, ["limit", "before"]);
      const rawLimit = url.searchParams.get("limit");
      if (rawLimit !== null && (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100)) throw new ApiError(400, "조회 개수가 올바르지 않습니다");
      const before = url.searchParams.get("before");
      if (before !== null && (!before || before.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(before))) throw new ApiError(400, "전달 조회 위치가 올바르지 않습니다");
      if (!ctx.delivery) throw new ApiError(501, "전달 조회를 지원하지 않습니다");
      return Response.json(ctx.delivery.memberNotices(id!, { limit: rawLimit === null ? 50 : Number(rawLimit), before: before ?? undefined }));
    }),
    route("POST", "/api/deliveries/:id/recovery", async (req, url, [id]) => {
      activeProject(store.requireDelivery(id!).projectId);
      strictQuery(url, []);
      const body = await parseBody(req, RecoverySchema);
      const result = orch.recoverDelivery ? await orch.recoverDelivery(id!, body) : ctx.delivery ? await ctx.delivery.recover(id!, body) : null;
      if (!result) throw new ApiError(501, "전달 복구를 지원하지 않습니다");
      return Response.json(result, { status: result.outcome === "stopped" ? 200 : 202 });
    }),
    route("GET", "/api/capabilities", (_req, url) => {
      strictQuery(url, []);
      const body: ServerCapabilities = { contractVersion: 2, capabilities: {
        paging: true, archive: true, realtime: true, delivery: !!ctx.delivery, push: !!ctx.push,
        // 네이티브는 이 값으로 엄격 쓰기를 켠다. 결과 조회와 모든 쓰기 포트가 있어야 한다.
        operations: (["operation", "updateSettingsV2", "patchMemberConfigV2", "setTodoDoneV2", "freshMemberSessionV2", "terminalControlV2"] as const)
          .every(port => port in orch && !!orch[port]),
      } };
      return Response.json(body);
    }),
    route("GET", "/api/sync", async (_req, url) => {
      strictQuery(url, ["projectId"]);
      const requestedProjectId = url.searchParams.get("projectId");
      if (requestedProjectId !== null && (!requestedProjectId.trim() || Buffer.byteLength(requestedProjectId) > 256)) throw new ApiError(400, "프로젝트 ID가 잘못되었습니다");
      await readHerdr();
      // 이 뒤 직렬화까지 await가 없다. 도메인 쓰기는 이 데몬의 Store가 소유한다.
      const herdr = currentHerdr();
      const project = requestedProjectId === null ? null : store.getProject(requestedProjectId);
      const projectStatus = requestedProjectId === null ? "none" : !project ? "not_found" : project.archived ? "archived" : "ok";
      const rankOverrides = { manager: 0, lead: 0 };
      for (const m of store.listAllMembers()) if (m.origin !== "manual" && (m.modelOverride || m.effortOverride)) rankOverrides[memberRank(m.kind)]++;
      const body: SyncSnapshot = {
        protocol: 2, requestedProjectId, projectStatus,
        bootstrap: { version: VERSION, settings: store.getSettings(), projects: store.projectSummaries(), herdr,
          home: config.home, urls: urls(), cli: orch.cliCommand?.() ?? "iamceo", rankOverrides },
        state: projectStatus === "ok" ? { ...store.projectState(requestedProjectId!), ...(ctx.delivery ? { deliveryNotices: ctx.delivery.notices(requestedProjectId!) } : {}) } : null,
        revisions: projectStatus === "ok" ? store.syncRevisions(requestedProjectId!) : { settings: store.settingsRevision(), members: {}, todos: {} },
        cursor: bus.cursor,
      };
      return Response.json(body);
    }),
    route("GET", "/api/bootstrap", async () => {
      await orch.refreshConnection?.();
      const rankOverrides = { manager: 0, lead: 0 };
      for (const m of store.listAllMembers()) if (m.origin !== "manual" && (m.modelOverride || m.effortOverride)) rankOverrides[memberRank(m.kind)]++;
      const body: Bootstrap = {
        version: VERSION,
        runtime: await orch.runtimeInfo?.(),
        settings: store.getSettings(),
        projects: store.projectSummaries(),
        herdr: await orch.herdrInfo(),
        home: config.home,
        urls: urls(),
        cli: orch.cliCommand?.() ?? "iamceo",
        rankOverrides,
      };
      return Response.json(body);
    }),
    // 폰 짝 맺기: Mac 화면이 QR 로 보여 줄 일회용 코드와 폰이 닿을 Tailscale 주소.
    route("POST", "/api/pair/start", async () => {
      const credential = config.accessCode;
      const availableUrls = await withMagicDnsNames(tailnetUrls(urls()));
      if (!safeEqual(credential, config.accessCode)) throw new ApiError(401, "접속 코드가 바뀌었습니다. 다시 연결하세요");
      const { code, expiresAt } = pairing.start();
      return Response.json({ code, expiresAt: new Date(expiresAt).toISOString(), ttlSeconds: PAIR_CODE_TTL_MS / 1000, urls: availableUrls, version: VERSION });
    }),
    route("GET", "/api/runtime", async () => {
      if (!orch.runtimeInfo) throw new ApiError(501, "실행기 진단을 지원하지 않습니다");
      return Response.json(await orch.runtimeInfo());
    }),
    route("POST", "/api/projects/:id/members", async (req, _url, [id]) => {
      store.requireProject(id!);
      if (!orch.createMember) throw new ApiError(501, "직원 만들기를 지원하지 않습니다");
      return Response.json(await orch.createMember(id!, await parseBody(req, CreateMemberSchema)));
    }),
    route("GET", "/api/projects/:id/state", (_req, _url, [id]) => {
      // 보관한 프로젝트는 없는 것으로 친다. 화면이 본사로 돌아간다.
      if (store.requireProject(id!).archived) throw new ApiError(404, "보관된 프로젝트입니다");
      const state = store.projectState(id!);
      return Response.json(ctx.delivery ? { ...state, deliveryNotices: ctx.delivery.notices(id!) } : state);
    }),
    route("GET", "/api/projects/:id/messages", (req, url, params) => {
      // Legacy read-only lookups also serve archived history; state/page use the archive boundary.
      store.requireProject(params[0]!);
      return messages(req, url, params);
    }),
    route("GET", "/api/projects/:id/messages/page", (_req, url, [id]) => Response.json(store.listMessagePage(id!, messagePageQuery(url)))),
    route("GET", "/api/projects/:id/archive/state", (_req, url, [id]) => {
      strictQuery(url, []);
      return Response.json(store.archiveState(id!));
    }),
    route("GET", "/api/projects/:id/archive/messages/page", (_req, url, [id]) => Response.json(store.listArchiveMessagePage(id!, messagePageQuery(url)))),
    route("GET", "/api/projects/:id/archive/messages", (req, url, params) => {
      archivedProject(params[0]!);
      return messages(req, url, params);
    }),
    route("GET", "/api/projects/:id/archive/messages/:message", (_req, url, [id, messageId]) => {
      strictQuery(url, []);
      archivedProject(id!);
      const message = store.requireMessage(messageId!);
      if (message.projectId !== id) throw new ApiError(404, "메시지를 찾을 수 없습니다");
      return Response.json(message);
    }),
    route("GET", "/api/messages/:id", (_req, url, [id]) => {
      strictQuery(url, []);
      return Response.json(store.requireMessage(id!));
    }),
    route("POST", "/api/projects", async (req) => {
      const body = await parseBody(req, CreateProjectSchema);
      return Response.json(await orch.createProject({ ...body, cwd: expandDir(body.cwd) }));
    }),
    route("GET", "/api/projects/archived", () => Response.json(store.listArchivedProjects())),
    route("GET", "/api/projects/:id/decisions", (_req, url, [id]) => {
      store.requireProject(id!);
      const status = url.searchParams.get("status") ?? "done";
      if (status === "open") return Response.json(store.listOpenDecisions(id!));
      if (status !== "done") throw new ApiError(400, "status 는 open 또는 done 입니다");
      return Response.json(store.listDoneDecisions(id!, { before: url.searchParams.get("before") ?? undefined, limit: parseLimit(url) }));
    }),
    route("GET", "/api/decisions/:id", (_req, _url, [id]) => Response.json(store.requireDecision(id!))),
    route("PATCH", "/api/projects/:id", async (req, _url, [id]) => {
      store.requireProject(id!);
      const v2 = contractV2(req);
      const body = await parseBody(req, PatchProjectSchema);
      const patch = body.cwd === undefined ? body : { ...body, cwd: expandDir(body.cwd) };
      // 연결된 구현은 종료·commit·후속 hook까지 단일 진입점이 소유한다.
      if (orch.patchProject) return Response.json(await orch.patchProject(id!, patch));
      // 구형 v1 포트의 활성 프로젝트 메타데이터만 호환한다.
      // 보관 전환/보관된 세션과 v2는 새 진입점의 장벽 없이 처리하지 않는다.
      const project = store.requireProject(id!);
      const validated = store.validateProjectPatch(id!, patch);
      if (v2 || patch.archived !== undefined || project.archived) throw new ApiError(501, "프로젝트 변경을 지원하지 않습니다");
      if (legacyProjectPatches.has(id!)) throw new ApiError(409, "프로젝트 변경을 처리하는 중입니다. 잠시 뒤 다시 하세요");
      legacyProjectPatches.add(id!);
      try {
        if (Object.entries(validated).every(([key, value]) => project[key as keyof typeof project] === value)) return Response.json(project);
        await orch.beforeProjectPatch?.(project, validated);
        const saved = store.patchProject(id!, validated);
        await orch.onProjectPatched(saved, validated);
        return Response.json(store.requireProject(id!));
      } finally { legacyProjectPatches.delete(id!); }
    }),
    route("POST", "/api/projects/:id/conductor/start", async (_req, _url, [id]) => {
      store.requireProject(id!);
      return Response.json(await orch.startConductor(id!));
    }),
    route("POST", "/api/projects/:id/messages", async (req, _url, [id]) => {
      store.requireProject(id!);
      const body = await parseBody(req, SendMessageSchema);
      if (body.id) {
        const existing = store.getMessage(body.id);
        if (existing) {
          if (existing.projectId !== id) throw new ApiError(409, "다른 프로젝트에서 쓴 메시지 id 입니다");
          // 끝내 실패한 글을 같은 id 로 다시 보내면 그 글을 다시 넣는다. 새 글을 만들면 대화에 실패 줄이 남아 지시가 늘어난다.
          if (existing.delivery === "failed" && existing.mine && orch.resendMessage) {
            await requireReachable(id!, existing.targetMemberId);
            return Response.json(await once(`msg:${body.id}`, () => orch.resendMessage!(existing)));
          }
          return Response.json(existing);
        }
      }
      if (!body.text.trim() && !body.attachmentIds?.length) throw new ApiError(400, "글이나 첨부가 필요합니다");
      if (body.targetMemberId && store.getMember(body.targetMemberId)?.projectId !== id) {
        throw new ApiError(400, "이 프로젝트의 직원이 아닙니다");
      }
      await requireReachable(id!, body.targetMemberId ?? null);
      for (const attachmentId of body.attachmentIds ?? []) {
        if (!store.getAttachment(attachmentId)) throw new ApiError(400, `없는 첨부입니다: ${attachmentId}`);
      }
      const send = () => orch.sendUserMessage(id!, body);
      return Response.json(await (body.id ? once(`message:${body.id}`, send) : send()));
    }),
    route("POST", "/api/uploads", async (req, url) => {
      // 첨부를 끝까지 올린 뒤 보내기에서 거부당하지 않게, 화면은 ?project= 를 붙여 먼저 묻는다.
      const projectId = url.searchParams.get("project");
      if (projectId) await requireReachable(projectId, url.searchParams.get("target"));
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        throw new ApiError(400, "multipart 본문이 필요합니다");
      }
      const file = form.get("file");
      if (!(file instanceof File)) throw new ApiError(400, "file 필드가 필요합니다");
      if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, "파일은 50MB 까지 올릴 수 있습니다");
      return Response.json(store.createAttachment(await saveUpload(config.uploadsDir, file)));
    }),
    route("POST", "/api/decisions/:id/answer", async (req, _url, [id]) => {
      store.requireDecision(id!);
      const body = await parseBody(req, contractV2(req) ? AnswerV2Schema : AnswerSchema);
      const duplicate = store.checkAnswer(id!, body);
      if (duplicate) return Response.json(duplicate);
      const decision = store.requireDecision(id!);
      await requireReachable(decision.projectId, decision.memberId);
      const answered = await once(`decision:${id}`, () => orch.answerDecision(id!, body));
      // 동시에 온 다른 답이 앞 요청의 결과를 받아 가면 안 된다.
      store.checkAnswer(id!, body);
      return Response.json(answered);
    }),
    route("POST", "/api/decisions/:id/reopen", async (_req, _url, [id]) => {
      store.requireDecision(id!);
      if (!orch.reopenDecision) throw new ApiError(501, "지원하지 않습니다");
      return Response.json(await once(`reopen:${id}`, () => orch.reopenDecision!(id!)));
    }),
    route("POST", "/api/projects/:id/tidy", async (_req, _url, [id]) => {
      store.requireProject(id!);
      if (!orch.tidyBoard) throw new ApiError(501, "지원하지 않습니다");
      // 대표의 말처럼 총괄에게 가는 입력이다. 연결이 없으면 409.
      await requireReachable(id!, null);
      return Response.json(await once(`tidy:${id}`, () => orch.tidyBoard!(id!)));
    }),
    route("POST", "/api/todos/:id/done", async (req, _url, [id]) => {
      const todo = store.requireTodo(id!);
      if (contractV2(req)) {
        const expected = precondition(req);
        const body = await parseBody(req, TodoDoneSchema.strict());
        if (!orch.setTodoDoneV2) throw new ApiError(501, "검토 버전이 있는 업무 변경을 지원하지 않습니다");
        return Response.json(await orch.setTodoDoneV2(id!, body, expected));
      }
      const { done } = await parseBody(req, TodoDoneSchema);
      if (todo.done === done) return Response.json(todo);
      return Response.json(await orch.setTodoDone(id!, done));
    }),
    route("GET", "/api/files/:id/artifact", async (_req, _url, [id]) => {
      // JSON 으로만 준다. 이 출처의 문서로 열리면 스크립트가 접속 코드에 닿는다. 화면은 /artifact-frame 격리 칸에 넣는다.
      return Response.json({ html: await artifactHtml(ctx, id!) }, { headers: { "Cache-Control": "no-store" } });
    }),
    route("POST", "/api/members/:id/terminal/control", async (req, _url, [id]) => {
      store.requireMember(id!);
      if (contractV2(req)) {
        const body = await parseBody(req, TerminalControlV2Schema);
        if (!orch.terminalControlV2) throw new ApiError(501, "작업 ID가 있는 터미널 조작을 지원하지 않습니다");
        return operationResponse(await orch.terminalControlV2(id!, body));
      }
      if (!orch.terminalControl) throw new ApiError(501, "터미널 조작을 지원하지 않습니다");
      return Response.json(await orch.terminalControl(id!, await parseBody(req, TerminalControlSchema)));
    }),
    route("GET", "/api/members/:id", (_req, _url, [id]) => Response.json(store.requireMember(id!))),
    route("PATCH", "/api/members/:id", async (req, _url, [id]) => {
      store.requireMember(id!);
      if (contractV2(req)) {
        const expected = precondition(req);
        const body = await parseBody(req, PatchMemberSchema);
        if (!orch.patchMemberConfigV2) throw new ApiError(501, "검토 버전이 있는 직원 설정을 지원하지 않습니다");
        return Response.json(await orch.patchMemberConfigV2(id!, body, expected));
      }
      return Response.json(await orch.patchMemberConfig(id!, await parseBody(req, PatchMemberSchema)));
    }),
    route("GET", "/api/members/:id/activity", (_req, url, [id]) => {
      store.requireMember(id!);
      return Response.json(store.listActivity(id!, parseLimit(url)));
    }),
    route("GET", "/api/members/:id/screen", async (_req, _url, [id]) => {
      store.requireMember(id!);
      return Response.json({ text: await orch.memberScreen(id!) });
    }),
    route("GET", "/api/members/:id/approval", async (_req, _url, [id]) => {
      store.requireMember(id!);
      return Response.json({ approval: orch.memberApproval ? await orch.memberApproval(id!) : null });
    }),
    // 대표만 누른다. agentRoutes 에는 없다(AI 가 자기 일을 스스로 승인하지 못하게).
    route("POST", "/api/members/:id/approval", async (req, _url, [id]) => {
      store.requireMember(id!);
      if (!orch.answerApproval) throw new ApiError(501, "이 실행 방식에는 승인 창이 없습니다");
      await orch.answerApproval(id!, await parseBody(req, AnswerApprovalSchema));
      return Response.json({ ok: true });
    }),
    route("POST", "/api/members/:id/sleep", async (req, url, params) => {
      // 본문은 '그래도 재우기'를 눌렀을 때만 온다. 빈 본문은 force 없음이다.
      const body = (await req.clone().text()).trim() ? await parseBody(req, SleepSchema) : {};
      return memberAction((id) => orch.memberSleep(id, { force: body.force }))(req, url, params);
    }),
    route("POST", "/api/members/:id/fresh-session", async (req, url, params) => {
      const id = params[0]!;
      store.requireMember(id);
      if (contractV2(req)) {
        const body = await parseBody(req, FreshSessionSchema);
        if (!orch.freshMemberSessionV2) throw new ApiError(501, "작업 ID가 있는 새 세션을 지원하지 않습니다");
        return operationResponse(await orch.freshMemberSessionV2(id, body));
      }
      return memberAction(async (id) => {
        if (!orch.freshMemberSession) throw new ApiError(501, "새 세션 시작을 지원하지 않습니다");
        return orch.freshMemberSession(id);
      })(req, url, params);
    }),
    route("POST", "/api/members/:id/resume", memberAction((id) => orch.memberResume(id))),
    route("POST", "/api/members/:id/compact", memberAction((id) => orch.memberCompact(id))),
    route("POST", "/api/members/:id/interrupt", memberAction((id) => orch.memberInterrupt(id))),
    route("POST", "/api/members/:id/close", memberAction(async (id) => {
      if (!orch.memberClose) throw new ApiError(501, "지원하지 않습니다");
      await orch.memberClose(id);
    })),
    route("GET", "/api/herdr/agents", async () => Response.json(await orch.herdrAgents())),
    route("GET", "/api/projects/:id/adopt/preview", async (_req, url, [id]) => {
      store.requireProject(id!);
      const pane = url.searchParams.get("pane");
      if (!pane) throw new ApiError(400, "칸을 지정하세요");
      if (!orch.adoptPreview) throw new ApiError(501, "지원하지 않습니다");
      return Response.json(await orch.adoptPreview(id!, pane));
    }),
    route("POST", "/api/members/:id/release", async (_req, _url, [id]) => {
      store.requireMember(id!);
      if (!orch.releaseMember) throw new ApiError(501, "지원하지 않습니다");
      return Response.json(await orch.releaseMember(id!));
    }),
    route("POST", "/api/members/:id/reopen-with-tools", async (_req, _url, [id]) => {
      store.requireMember(id!);
      if (!orch.reopenWithTools) throw new ApiError(501, "지원하지 않습니다");
      return Response.json(await orch.reopenWithTools(id!));
    }),
    route("POST", "/api/projects/:id/adopt", async (req, _url, [id]) => {
      store.requireProject(id!);
      return Response.json(await orch.adopt(id!, await parseBody(req, AdoptSchema)));
    }),
    route("PUT", "/api/settings", async (req) => {
      if (contractV2(req)) {
        const expected = precondition(req);
        const body = await parseBody(req, SettingsSchema);
        if (!orch.updateSettingsV2) throw new ApiError(501, "검토 버전이 있는 설정 변경을 지원하지 않습니다");
        return Response.json(await orch.updateSettingsV2(body, expected));
      }
      return Response.json(await orch.updateSettings(await parseBody(req, SettingsSchema)));
    }),
  ];
}

function agentRoutes({ store, orch }: ServerContext, member: Member): Route[] {
  const route = (method: string, path: string, handler: Handler): Route => ({ method, pattern: new RegExp(`^${path}$`), handler });
  const requireManualInbox = (): void => {
    if (member.origin !== "manual") throw new ApiError(403, "직접 실행한 직원만 수신함을 사용할 수 있습니다");
    if (store.requireProject(member.projectId).archived) throw new ApiError(404, "프로젝트를 찾을 수 없습니다");
  };
  return [
    route("GET", "/agent/tools", async () => Response.json(await orch.listAgentTools(member))),
    route("POST", "/agent/tool", async (req) => {
      const body = await parseBody(req, contractV2(req) ? AgentOperationSchema : AgentToolSchema.extend({ operationId: operationIdSchema.optional() }).passthrough());
      const { name, args, operationId } = body.operationId ? validateBody(body, AgentOperationSchema) : body;
      if (operationId) {
        if (!orch.handleAgentOperation) throw new ApiError(501, "작업 ID가 있는 도구 호출을 지원하지 않습니다");
        store.touchMember(member.id);
        orch.noteManualCall?.(member, name);
        return Response.json(await orch.handleAgentOperation(member, name, args ?? {}, { operationId }, req.signal));
      }
      store.touchMember(member.id);
      orch.noteManualCall?.(member, name);
      return Response.json(await orch.handleAgentTool(member, name, args ?? {}, req.signal));
    }),
    route("POST", "/agent/inbox/wait", async (req, url) => {
      requireManualInbox();
      strictQuery(url, []);
      const { timeoutMs } = await parseBody(req, ManualInboxSchema);
      if (!orch.manualInbox) throw new ApiError(501, "수신함 batch 조회를 지원하지 않습니다");
      store.touchMember(member.id);
      orch.noteManualCall?.(member, "inbox_wait");
      return Response.json(await orch.manualInbox(member.id, Math.min(timeoutMs ?? ASK_WAIT_MAX_MS, ASK_WAIT_MAX_MS), req.signal));
    }),
    route("POST", "/agent/inbox/ack", async (req, url) => {
      requireManualInbox();
      strictQuery(url, []);
      const body = await parseBody(req, ManualAckSchema);
      if (!orch.acknowledgeManualInbox) throw new ApiError(501, "수신함 ACK를 지원하지 않습니다");
      return Response.json(await orch.acknowledgeManualInbox(member.id, body));
    }),
    route("POST", "/agent/ask/wait", async (req) => {
      const { decisionId, timeoutMs } = await parseBody(req, AskWaitSchema);
      const decision = store.getDecision(decisionId);
      if (!decision || decision.projectId !== member.projectId) throw new ApiError(404, "결재를 찾을 수 없습니다");
      if (decision.memberId !== member.id) throw new ApiError(403, "다른 직원의 결재입니다");
      // 롱폴을 다시 거는 것이 답을 기다리는 세션의 유일한 생존 신호다.
      store.touchMember(member.id);
      orch.noteManualCall?.(member, "ask_wait");
      return Response.json(await orch.askWait(member, decisionId, Math.min(timeoutMs ?? ASK_WAIT_MAX_MS, ASK_WAIT_MAX_MS), req.signal));
    }),
  ];
}

/** 직접 띄운 CLI 의 합류. 멤버 토큰이면 이어 붙이고, 접속 코드면 origin=manual 직원으로 등록한다. */
async function handleJoin(req: Request, { config, store }: ServerContext): Promise<Response> {
  if (req.method !== "POST") return fail(405, "허용되지 않는 메서드입니다");
  const token = bearer(req);
  const byToken = token ? store.getMemberByToken(token) : null;
  if (!byToken && !(token && safeEqual(token, config.accessCode))) return fail(401, "인증이 필요합니다");

  const body = await parseBody(req, JoinSchema);
  if (byToken) {
    // 실행기가 띄운 세션의 id 를 바꾸면 다른 세션을 이어받게 된다.
    if (body.sessionId && byToken.origin !== "manual" && body.sessionId !== byToken.sessionId) throw new ApiError(409, "실행기가 관리하는 세션은 합류로 바꿀 수 없습니다");
    const revive = byToken.origin === "manual" && (byToken.status === "offline" || byToken.status === "asleep" || byToken.status === "error");
    const member = store.patchMember(byToken.id, {
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      ...(revive ? { status: "idle" as const, lastError: null } : {}),
    });
    store.touchMember(member.id);
    return Response.json({ member, token, project: store.requireProject(member.projectId) });
  }

  const cwd = body.cwd ? resolve(body.cwd) : null;
  const projectId = body.project
    ? (store.listProjects().find((p) => p.id === body.project || p.name === body.project)?.id ?? null)
    : cwd
      ? projectForCwd(store, cwd)
      : null;
  if (!projectId) throw new ApiError(404, "합류할 프로젝트를 찾지 못했습니다");

  const existing = store.findMember(projectId, body.handle ?? body.name ?? "");
  if (existing) {
    if (existing.origin !== "manual") throw new ApiError(409, `이미 실행기가 관리하는 직원입니다: ${existing.name}`);
    const member = store.patchMember(existing.id, {
      status: "idle",
      lastError: null,
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      ...(cwd ? { cwd } : {}),
    });
    return Response.json({ member, token: store.getMemberToken(member.id), project: store.requireProject(projectId) });
  }

  const name = body.name?.trim() || body.handle;
  if (!name) throw new ApiError(400, "이름이 필요합니다");
  const member = store.createMember({
    projectId,
    handle: body.handle ?? deriveHandle(store, projectId, name),
    name,
    role: body.role ?? "",
    kind: "worker",
    origin: "manual",
    status: "idle",
    cwd: cwd ?? undefined,
    sessionId: body.sessionId ?? null,
  });
  return Response.json({ member, token: store.getMemberToken(member.id), project: store.requireProject(projectId) });
}

function deriveHandle(store: Store, projectId: string, name: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32);
  if (ascii && !store.getMemberByHandle(projectId, ascii)) return ascii;
  return `m${randomBytes(4).toString("hex")}`;
}

// <img>·<video> 는 헤더를 못 붙인다. 주소에 접속 코드를 실으면 '이미지 주소 복사'로 새므로 /files 에만 통하는 쿠키를 쓴다.
// 값은 접속 코드에서 파생해 /api 에 통하지 않고, 코드를 바꾸면 함께 무효가 된다. Strict 라 바깥 사이트의 링크·불투명 출처인 격리 칸에는 실리지 않는다.
const FILES_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const filesCookieName = (url: URL) => `iamceo_files_${url.port || (url.protocol === "https:" ? "443" : "80")}`; // 쿠키는 포트를 가리지 않는다
const filesCookieValue = (accessCode: string) => createHmac("sha256", accessCode).update("iamceo-files").digest("hex");
function filesCookie(url: URL, value: string, maxAge: number): string {
  return `${filesCookieName(url)}=${value}; Path=/files; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${url.protocol === "https:" ? "; Secure" : ""}`;
}
function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** <img>·<video>·<audio> 로 그리는 형식만 inline. 나머지(html·svg·xml 포함)는 어떻게 와도 문서로 열리지 않는다. 태그와 fetch 는 이 값을 보지 않는다. */
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+)$/i;

function filesResponse(url: URL, { config, store }: ServerContext): Response {
  const m = /^\/files\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!m) return fail(404, "없는 파일입니다");
  const [id, name] = decodeParams(m);
  const attachment = store.getAttachment(id!);
  // 이름까지 맞아야 한다: `..%2f` 같은 탈출 시도는 여기서 끝난다.
  if (!attachment || attachment.name !== name) return fail(404, "없는 파일입니다");
  const path = resolveInside(config.uploadsDir, attachment.path);
  if (!path) return fail(404, "없는 파일입니다");
  return new Response(Bun.file(path), {
    headers: {
      "Content-Type": attachment.mime,
      "Content-Disposition": `${INLINE_MIME.test(attachment.mime) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      // 올린 html·svg 가 같은 출처에서 스크립트로 돌지 못하게 한다.
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    },
  });
}

/**
 * 아티팩트를 그리는 빈 칸. srcdoc 은 부모 페이지의 CSP(script-src 'self')를 물려받아 인라인 스크립트가 돌지 않는다(Chromium·WebKit 실측).
 * 그래서 이 빈 문서를 응답 헤더 sandbox 로 불투명 출처에 가두고, 부모가 postMessage 로 buildArtifactSrcdoc 결과를 넣어 준다.
 * 원본은 서버 출처로 나가지 않으며, 이 문서는 접속 코드·저장소·이 서버 API 어디에도 닿지 못한다.
 */
const ARTIFACT_FRAME_HTML = `<!doctype html><meta charset="utf-8"><script>addEventListener("message",function(e){if(e.source!==parent||!e.data||typeof e.data.iamceoSrcdoc!=="string")return;document.open();document.write(e.data.iamceoSrcdoc);document.close()},{once:false});parent.postMessage({iamceoFrameReady:true},"*")</script>`;

function artifactFrameResponse(): Response {
  return new Response(ARTIFACT_FRAME_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `sandbox allow-scripts; ${ARTIFACT_CSP}; frame-ancestors 'self'`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

/** 직원 글에 뭐가 들어와도 외부로 요청이 나가거나 스크립트가 돌지 못하게 하는 마지막 줄. */
function pageHeaders(host: string): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ws://${host} wss://${host}`,
    "frame-src 'self' blob:", // 아티팩트 빈 칸과 PDF(blob, 형식은 화면이 application/pdf 로 정한다)
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return { "Content-Security-Policy": csp, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
}

/** HTML 번들은 Bun 이 routes 에서만 내준다. 안쪽 주소에 띄워 두고, IP·Origin 검사를 지난 요청만 넘겨준다. */
async function proxyWeb(origin: string, req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "허용되지 않는 메서드입니다");
  const res = await fetch(`${origin}${url.pathname}${url.search}`, { method: req.method });
  const headers = new Headers(res.headers);
  for (const name of ["content-encoding", "content-length", "transfer-encoding"]) headers.delete(name);
  for (const [k, v] of Object.entries(pageHeaders(req.headers.get("host") ?? url.host))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

async function loadWebIndex(): Promise<Bun.HTMLBundle | null> {
  try {
    return (await import("./web-index.ts")).default;
  } catch {
    return null;
  }
}

const WS_TOPIC = "events";
const WS_V2_TOPIC = "events-v2";
interface SocketData { protocol: 1 | 2; authGeneration: number }

export async function startServer(ctx: ServerContext): Promise<RunningServer> {
  const { config, store, bus } = ctx;
  const ipRule = buildIpRule(config.hosts);
  const hosts: string[] = [];
  const bindings = new Map<string, HostBinding>();
  let authGeneration = 0;
  let boundPort = 0;
  const pairing = new Pairing();
  let herdrCache: HerdrInfo | undefined;
  let herdrPending: Promise<HerdrInfo> | undefined;
  let herdrCursor: Readonly<SyncCursor> | undefined;
  const readHerdr = (): Promise<HerdrInfo> => {
    if (herdrCache) return Promise.resolve(herdrCache);
    return herdrPending ??= ctx.orch.herdrInfo().then((info) => herdrCache ??= info).finally(() => { herdrPending = undefined; });
  };
  const routes = apiRoutes(ctx, () => reachableUrls(hosts, boundPort), pairing, readHerdr, () => herdrCache!);
  const pushHandler = ctx.push ? createPushHandler(ctx.push) : null;
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const v2Sockets = new Set<ServerWebSocket<SocketData>>();
  const requests = new Set<Promise<Response | undefined>>();
  let socketsDrained: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  let closedEpochSockets = false;
  const webIndex = await loadWebIndex();
  const development = process.env.IAMCEO_DEV === "1";
  // 개발 모드는 HMR 소켓까지 Bun 이 직접 맡아야 해서 그대로 둔다.
  const webServer =
    webIndex && !development
      ? Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, routes: { "/*": webIndex }, fetch: () => new Response("없는 경로입니다", { status: 404 }) })
      : null;
  const webOrigin = webServer ? `http://127.0.0.1:${webServer.port}` : null;

  const hasAccessCode = (req: Request, url: URL, allowQuery: boolean): boolean => {
    const given = bearer(req) ?? (allowQuery ? url.searchParams.get("t") : null);
    return given !== null && safeEqual(given, config.accessCode);
  };

  const route = (req: Request, url: URL, server: Server<SocketData>): Response | Promise<Response> | undefined => {
    const path = url.pathname;
    if (path === "/api/health") return Response.json({ ok: true, version: VERSION });
    // 짝 맺기 코드를 낸 폰에만 접속 코드를 준다. 코드 자체가 인증이라 접속 코드 검사 앞에 둔다.
    if (path === "/pair/claim") return handlePairClaim(req, server);
    if (path === "/ws") {
      strictQuery(url, ["v", "t"]);
      const version = url.searchParams.get("v");
      if (version !== null && version !== "2") return fail(400, "실시간 연결 버전이 잘못되었습니다");
      if (version === "2" && url.searchParams.has("t")) return fail(400, "실시간 연결 주소에 접속 코드를 넣지 마세요");
      if (!hasAccessCode(req, url, version === null)) return fail(401, "인증이 필요합니다");
      return server.upgrade(req, { data: { protocol: version === "2" ? 2 : 1, authGeneration } }) ? undefined : fail(400, "WebSocket 요청이 아닙니다");
    }
    // 코드가 틀려 나가는 기기도 지울 수 있어야 하므로 인증 앞에 둔다. 지우기뿐이고 바깥 사이트는 Origin 검사에 걸린다.
    if (path === "/api/files-session" && req.method === "DELETE") {
      return new Response(null, { status: 204, headers: { "Set-Cookie": filesCookie(url, "", 0) } });
    }
    if (path.startsWith("/api/")) {
      if (!hasAccessCode(req, url, false)) return fail(401, "인증이 필요합니다");
      if (path === "/api/auth/rotate") return rotate(req, url, server);
      if (path === "/api/readiness") return readiness(req, url);
      if (path === "/api/push" || path.startsWith("/api/push/")) {
        return pushHandler ? pushHandler(req, url) : fail(501, "푸시를 지원하지 않습니다");
      }
      if (path === "/api/files-session" && req.method === "POST") {
        return new Response(null, { status: 204, headers: { "Set-Cookie": filesCookie(url, filesCookieValue(config.accessCode), FILES_COOKIE_MAX_AGE) } });
      }
      return dispatch(routes, req, url);
    }
    if (path.startsWith("/files/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "허용되지 않는 메서드입니다");
      // 헤더 또는 첨부 쿠키만 받는다. ?t= 는 받지 않는다: Sec-Fetch-Dest 는 평문 HTTP(폰의 100.x 주소)에서 오지 않아 문서 이동을 가려낼 수 없다.
      const cookie = readCookie(req, filesCookieName(url));
      const byCookie = cookie !== null && safeEqual(cookie, filesCookieValue(config.accessCode));
      if (!byCookie && !hasAccessCode(req, url, false)) return fail(401, "인증이 필요합니다");
      return filesResponse(url, ctx);
    }
    if (path === "/artifact-frame") return artifactFrameResponse();
    if (path === "/agent/join") return handleJoin(req, ctx);
    if (path.startsWith("/agent/")) {
      const token = bearer(req);
      const member = token ? store.getMemberByToken(token) : null;
      if (!member) return fail(401, "인증이 필요합니다");
      return dispatch(agentRoutes(ctx, member), req, url);
    }
    if (webOrigin) return proxyWeb(webOrigin, req, url);
    if (path === "/" && !webIndex) return fail(503, "화면이 아직 빌드되지 않았습니다");
    return fail(404, "없는 경로입니다");
  };

  const readiness = async (req: Request, url: URL): Promise<Response> => {
    if (req.method !== "GET") return fail(405, "허용되지 않는 메서드입니다");
    strictQuery(url, []);
    const runtime = await ctx.orch.runtimeInfo?.();
    const daemon = ctx.daemon?.() ?? null;
    const schemaVersion = store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    const ok = daemon?.ready === true && schemaVersion === MIGRATIONS.length;
    return Response.json({ ok, version: VERSION, daemon, schema: { version: schemaVersion, supportedVersion: MIGRATIONS.length },
      core: runtime?.core ?? null, hosts: [...bindings.values()].map(binding => ({ ...binding })) }, { status: ok ? 200 : 503 });
  };

  const rotate = async (req: Request, url: URL, server: Server<SocketData>): Promise<Response> => {
    if (req.method !== "POST") return fail(405, "허용되지 않는 메서드입니다");
    strictQuery(url, []);
    // 요청의 실제 peer만 사용한다. 프록시 헤더나 Host는 로컬 접근의 증거가 아니다.
    const peer = server.requestIP(req)?.address.toLowerCase().replace(/^::ffff:/, "");
    const v4 = peer ? v4ToInt(peer) : null;
    if (peer !== "::1" && (v4 === null || !inSubnet(v4, LOOPBACK_V4.base, LOOPBACK_V4.mask))) return fail(403, "접속 코드 회전은 이 Mac에서만 할 수 있습니다");
    if (req.body !== null) await parseBody(req, z.strictObject({}));
    // body를 읽는 동안 다른 회전이 완료됐을 수 있다.
    if (!hasAccessCode(req, url, false)) return fail(401, "인증이 필요합니다");
    const accessCode = generateAccessCode();
    let durabilityUnknown = false;
    try { updateConfigFile({ accessCode }, { IAMCEO_HOME: config.home }); }
    catch {
      // rename 뒤 디렉터리 fsync만 실패했을 수 있다. 디스크와 메모리의 인증을 다르게 두지 않는다.
      durabilityUnknown = rotationWasSaved(config, accessCode);
      if (!durabilityUnknown) return fail(500, "접속 코드를 저장하지 못했습니다. 로컬 설정을 확인하세요", "AUTH_ROTATION_SAVE_FAILED");
    }
    // 저장부터 인증 교체·QR 폐기·구독 해제까지 await 없이 한 번에 적용한다.
    config.accessCode = accessCode;
    authGeneration++;
    pairing.invalidate();
    closedEpochSockets ||= sockets.size > 0;
    for (const ws of sockets) {
      ws.unsubscribe(WS_TOPIC);
      ws.unsubscribe(WS_V2_TOPIC);
      ws.close(4001, "접속 코드가 바뀌었습니다. 다시 연결하세요");
    }
    return durabilityUnknown ? fail(500, "교체된 설정의 디스크 동기화를 확인하지 못했습니다. 이 Mac에서 iamceo open으로 현재 코드를 확인하세요", "AUTH_ROTATION_OUTCOME_UNKNOWN") : Response.json({ accessCode, version: VERSION });
  };

  const handlePairClaim = async (req: Request, server: Server<SocketData>): Promise<Response> => {
    if (req.method !== "POST") return fail(405, "허용되지 않는 메서드입니다");
    const generation = authGeneration;
    const body = (await req.json().catch(() => null)) as { code?: unknown; device?: unknown } | null;
    if (generation !== authGeneration) return fail(401, "접속 코드가 바뀌었습니다. Mac에서 새 QR을 만들어 주세요");
    if (!body || typeof body.code !== "string") return fail(400, "짝 맺기 코드가 필요합니다");
    const from = server.requestIP(req)?.address ?? "unknown";
    const result = pairing.claim(body.code, from);
    if (result === "limited") return fail(429, "너무 많이 시도했습니다. 잠시 뒤 Mac에서 새 QR을 만들어 다시 찍어 주세요");
    if (result === "invalid") return fail(401, "QR이 맞지 않거나 시간이 지났습니다. Mac에서 새 QR을 만들어 주세요");
    return Response.json({ accessCode: config.accessCode, version: VERSION }, { headers: { "Cache-Control": "no-store" } });
  };

  const handleRequest = async (req: Request, server: Server<SocketData>): Promise<Response | undefined> => {
    const url = new URL(req.url);
    // 인증 실패와 검증 오류도 사용자 데이터처럼 캐시에 남기지 않는다.
    const noStore = (response: Response | undefined): Response | undefined => {
      if (response && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/agent/") || url.pathname.startsWith("/pair/") || url.pathname === "/ws")) response.headers.set("Cache-Control", "no-store");
      return response;
    };
    if (!isIpAllowed(server.requestIP(req)?.address, ipRule)) return noStore(fail(403, "허용되지 않은 주소입니다"));
    if (!isHostAllowed(req.headers.get("host"), config.hosts)) return noStore(fail(403, "허용되지 않은 주소입니다"));
    if (!originMatchesHost(req)) return noStore(fail(403, "허용되지 않은 출처입니다"));
    try {
      return noStore(await route(req, url, server));
    } catch (e) {
      if (e instanceof ApiError) return noStore(fail(e.status, e.message, e.code));
      // 오류 객체도 요청 URL/헤더를 품을 수 있다. 경로와 오류 종류만 남긴다.
      console.error("요청 처리 오류:", req.method, url.pathname, e instanceof Error ? e.name : "unknown");
      return noStore(fail(500, e instanceof Error ? e.message : "서버 오류"));
    }
  };

  const handle = (req: Request, server: Server<SocketData>): Promise<Response | undefined> => {
    const pending = handleRequest(req, server);
    requests.add(pending);
    void pending.then(() => requests.delete(pending), () => requests.delete(pending));
    return pending;
  };

  const serve = (hostname: string, port: number): Server<SocketData> =>
    Bun.serve({
      hostname,
      port,
      development,
      // 롱폴(/agent/ask/wait, wait 도구)이 끊기지 않게 최대로 둔다. 기본 10초.
      idleTimeout: 255,
      maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024,
      routes: {
        "/api/*": handle,
        "/agent/*": handle,
        "/files/*": handle,
        "/artifact-frame": handle,
        "/pair/*": handle,
        "/ws": handle,
        ...(webIndex && !webOrigin ? { "/*": webIndex } : {}),
      } as Record<string, Bun.HTMLBundle | typeof handle>,
      fetch: handle as (req: Request, server: Server<SocketData>) => Promise<Response>,
      websocket: {
        backpressureLimit: 16 * 1024 * 1024,
        closeOnBackpressureLimit: true,
        open(ws) {
          sockets.add(ws);
          if (ws.data.authGeneration !== authGeneration) {
            closedEpochSockets = true;
            ws.close(4001, "접속 코드가 바뀌었습니다. 다시 연결하세요");
            return;
          }
          ws.subscribe(ws.data.protocol === 2 ? WS_V2_TOPIC : WS_TOPIC);
          if (ws.data.protocol === 2) {
            v2Sockets.add(ws);
            ws.send(JSON.stringify({ type: "hello", protocol: 2, ...bus.cursor, heartbeatMs: WS_PING_MS, staleAfterMs: 45_000 }));
          } else {
            ws.send(JSON.stringify({ type: "hello", seq: bus.seq }));
          }
        },
        close(ws) {
          sockets.delete(ws);
          v2Sockets.delete(ws);
          if (sockets.size === 0) socketsDrained?.();
        },
        // 서버→화면 단방향이다.
        message() {},
      },
    });

  const [firstHost, ...otherHosts] = config.hosts;
  if (!firstHost) throw new Error("listen 할 주소가 없습니다");
  const servers = [serve(firstHost, config.port)];
  const port = servers[0]!.port!;
  boundPort = port;
  hosts.push(firstHost);
  bindings.set(firstHost, { host: firstHost, state: "bound", attempts: 1, lastAttemptAt: new Date().toISOString(), error: null });
  const open = (host: string) => {
    const attempts = (bindings.get(host)?.attempts ?? 0) + 1;
    const lastAttemptAt = new Date().toISOString();
    try {
      servers.push(serve(host, port));
      hosts.push(host);
      bindings.set(host, { host, state: "bound", attempts, lastAttemptAt, error: null });
    } catch {
      // Tailscale 이 꺼져 주소가 사라졌어도 로컬은 떠야 한다.
      bindings.set(host, { host, state: "failed", attempts, lastAttemptAt, error: "HOST_BIND_FAILED" });
    }
  };
  for (const host of otherHosts) if (!hosts.includes(host)) open(host);

  // 로그인 직후 launchd 로 뜨면 Tailscale 이 아직 안 올라왔을 수 있다. 다시 켜지 않아도 폰에서 닿아야 한다.
  const detect = ctx.detectHosts ?? (() => {
    const ip = detectTailscaleIp();
    return ip ? [ip] : [];
  });
  const syncHosts = () => {
    if (stopPromise) return;
    const desired = [...new Set([...otherHosts, ...(config.hostsAuto ? detect() : [])])];
    for (const host of desired) if (!hosts.includes(host)) open(host);
  };
  const hostTimer = setInterval(syncHosts, HOST_SYNC_MS);
  hostTimer.unref?.();
  // 화면이 조용히 죽은 소켓을 알아채는 신호. 망이 바뀌면 소켓은 닫히지 않고 그냥 멈춘다.
  const pingTimer = setInterval(() => {
    const payload = JSON.stringify({ type: "ping" });
    const v2Payload = JSON.stringify({ type: "ping", ...bus.cursor });
    for (const server of servers) {
      server.publish(WS_TOPIC, payload);
      server.publish(WS_V2_TOPIC, v2Payload);
    }
  }, WS_PING_MS);
  pingTimer.unref?.();

  let publishedEpoch = bus.epoch;
  const unsubscribe = bus.subscribe((event, cursor) => {
    if (event.type === "herdr" && cursor.epoch === bus.epoch && (!herdrCursor || herdrCursor.epoch !== cursor.epoch || herdrCursor.seq < cursor.seq)) {
      herdrCache = event.herdr;
      herdrCursor = cursor;
    }
    const epochChanged = publishedEpoch !== bus.epoch;
    if (epochChanged) {
      publishedEpoch = bus.epoch;
      closedEpochSockets ||= v2Sockets.size > 0;
      for (const ws of v2Sockets) {
        ws.unsubscribe(WS_V2_TOPIC);
        ws.close(1012, "실시간 동기화를 다시 시작하세요");
      }
    }
    const payload = JSON.stringify(event);
    const v2Payload = epochChanged || event.type === "hello" || event.type === "ping" ? null : JSON.stringify({ ...event, ...cursor });
    for (const server of servers) {
      server.publish(WS_TOPIC, payload);
      if (v2Payload) server.publish(WS_V2_TOPIC, v2Payload);
    }
  });

  return {
    port,
    hosts,
    get urls() { return reachableUrls(hosts, port); },
    get hostBindings() { return [...bindings.values()].map(binding => ({ ...binding })); },
    syncHosts,
    stop() {
      return stopPromise ??= (async () => {
        clearInterval(hostTimer);
        clearInterval(pingTimer);
        unsubscribe();
        const drained = sockets.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => { socketsDrained = resolve; });
        const stopped = servers.map((s) => s.stop(true));
        // Bun 1.3.14는 서버가 먼저 닫은 WS를 pendingWebSockets에 남긴다.
        // force stop은 한 번만 호출하고 실제 요청/소켓의 종료를 직접 기다린다.
        await (closedEpochSockets ? Promise.all([drained, ...requests]) : Promise.all(stopped));
        await webServer?.stop(true);
      })();
    },
  };
}
