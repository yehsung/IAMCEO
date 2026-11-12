import { configuredSecretRoots } from "./secret-paths.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { detectTailscaleIp, generateAccessCode, isTailscaleV4, isTailscaleV6, updateConfigFile } from "./config.ts";
import { MIGRATIONS } from "./db.ts";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";
import { fileKindOf, memberRank, PERMISSION_MODES, type Bootstrap, type EngineStatus, type HerdrInfo, type TailnetStatus, type Member, type MessagePageOptions, type SyncSnapshot, type FileDoc, type WsEvent } from "../shared/types.ts";
import { REPORT_LANGUAGES } from "../shared/types.ts";
import type { OperationReceipt, ServerCapabilities } from "../shared/operations.ts";
import type { DeliveryRecoveryService } from "./service-contracts.ts";
import { ARTIFACT_CSP, buildArtifactSrcdoc } from "../shared/artifact-kit.ts";
import type { Bus } from "./bus.ts";
import { VERSION, type Config } from "./config.ts";
import { FilePublication, prepareImport, MAX_ARTIFACT_BYTES, MAX_UPLOAD_BYTES, resolveInside, saveUpload, type SavedFile } from "./files.ts";
import type { OrchestratorApi } from "./orchestrator-api.ts";
import { ApiError, type Store } from "./store.ts";
import { classifyStorageError } from "./storage-errors.ts";
import { SESSION_ID_RE } from "./text.ts";
import { Pairing, PAIR_CODE_TTL_MS, tailnetUrls, withMagicDnsNames } from "./pairing.ts";
import { createPushHandler, type PushRoutesContext } from "./push/routes.ts";
import { TerminalStreams, type SocketData as TerminalSocketData } from "./terminal-stream.ts";
type SocketData = TerminalSocketData & { lite?: boolean };
import { ModelCatalogReader } from "./models.ts";
import { Folders } from "./folders.ts";
import { checkLocalImportPath, readLocalFile } from "./local-files.ts";
import { createStorageReferences } from "./storage-maintenance.ts";
import { GitHub } from "./github.ts";
import { LoopMonitor } from "./loop-monitor.ts";
import { TailnetWatch } from "./tailnet.ts";
import { doctorReport, serverDoctorFacts, type DoctorLang, type DoctorProbes } from "./doctor.ts";
import { createDiagnostics, type DiagnoseInput } from "./diagnose.ts";
import { readVitals } from "./vitals.ts";
import type { DiagnoseResult } from "../shared/types.ts";
import { compatFields, readAppClient, SeenApps } from "./app-version.ts";
import { CliVersionMonitor, type CliVersionInfo, type CliVersionSource } from "./cli-version.ts";
import { exportProjectZip, removeDeletedProjectFiles } from "./lifecycle/project-data.ts";
import type { ProjectDeleteResult } from "../shared/types.ts";

export interface ServerContext {
  config: Config;
  store: Store;
  bus: Bus;
  orch: OrchestratorApi;
  /** 읽기 전용 notice와 복구 예약 포트. 호스트가 소유한 엔진만 주입한다. */
  delivery?: Pick<DeliveryRecoveryService, "notices" | "memberNotices" | "recover" | "recoverUnassignedMessage">;
  push?: PushRoutesContext;
  /** 시험용. 기본은 Tailscale 주소 감지. */
  detectHosts?: () => string[];
  /** 시험용. Tailscale 꺼짐 판정의 시계와 유예 시간. 기본은 Date.now 와 60초. */
  tailnetWatch?: { now?: () => number; graceMs?: number };
  /** Isolated folder/API tests use a fake user home; production uses homedir(). */
  folderHome?: string;
  /** Isolated fake-clone tests need not depend on host disk availability. */
  githubFreeBytes?: (path: string) => Promise<number>;
  daemon?: () => { ready: boolean; buildId: string; version: string };
  loopMonitor?: LoopMonitor;
  /** B3 점검(GET /api/doctor)의 사실 모으기. 시험이 launchctl·디스크·로그인 기록 대신 넣는다. */
  doctorProbes?: Partial<DoctorProbes>;
  /** D8 진단 파일(POST /api/diagnose). 시험이 서비스 요약·로그 폴더·충돌 보고 폴더·시계를 넣는다. */
  diagnose?: Partial<Pick<DiagnoseInput, "service" | "logDir" | "crashReportsDir" | "now" | "keep">>;
  /** D9: CLI 버전 캐시. 없으면 서버가 만든다. 시험(IAMCEO_TEST)에서는 넣은 것만 쓴다: 진짜 CLI 를 부르지 않는다. */
  cliVersions?: CliVersionSource;
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
  /**
   * Tailscale 대역(100.64.0.0/10, fd7a:115c:a1e0::/48)에서 온 상대를 받는가. 이 서버가 확인된(또는 대표가 hosts 에 직접 적은)
   * Tailscale 주소에서 듣고 있을 때만 참이다. 대역만 같은 다른 망(통신사·공유기)의 상대를 Tailscale 로 여기지 않는다.
   */
  tailnet: boolean;
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

/** 듣는 주소 가운데 Tailscale 대역이 있는가. 자동 감지는 확인된 주소만 돌려주고, 나머지는 대표가 hosts 에 직접 적은 주소다. */
export function listensOnTailnet(hosts: string[]): boolean {
  return hosts.some(host => isTailscaleV4(host) || isTailscaleV6(host));
}

/** `hosts` 에 넣은 LAN 주소의 대역을 허용 목록으로 바꾼다. 와일드카드 주소는 대역을 넓히지 않는다. */
export function buildIpRule(hosts: string[]): IpRule {
  const rule: IpRule = { subnets: [], exact: new Set(), tailnet: listensOnTailnet(hosts) };
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
    if (inSubnet(v4, LOOPBACK_V4.base, LOOPBACK_V4.mask) || (rule.tailnet && inSubnet(v4, TAILSCALE_V4.base, TAILSCALE_V4.mask))) return true;
    return rule.subnets.some((s) => inSubnet(v4, s.base, s.mask));
  }
  return ip === "::1" || (rule.tailnet && isTailscaleV6(ip)) || rule.exact.has(ip);
}

/** 프록시가 대신 전한 요청에 붙는 헤더. 하나라도 있으면 이 Mac 안에서 온 요청으로 보지 않는다(tailscale serve 같은 대리 연결). */
const FORWARDED_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "tailscale-user-login"];
let ownAddresses: { at: number; set: Set<string> } | null = null;
function isOwnAddress(ip: string): boolean {
  const now = Date.now();
  if (!ownAddresses || now - ownAddresses.at >= 5000) {
    ownAddresses = { at: now, set: new Set(Object.values(networkInterfaces()).flat().flatMap(a => a ? [a.address.toLowerCase().replace(/%.*$/, "")] : [])) };
  }
  return ownAddresses.set.has(ip);
}

/**
 * 이 Mac 안에서 온 요청인가. 실제 상대 주소만 본다: loopback 이거나 이 컴퓨터 자신의 주소에서 온 연결이다
 * (hosts 에 loopback 을 빼고 적은 설치는 자기 주소로 자기에게 붙는다). 대리 전달 헤더가 있으면 거부한다.
 */
export function isLocalRequest(rawIp: string | null | undefined, headers: Headers): boolean {
  if (!rawIp || FORWARDED_HEADERS.some(name => headers.has(name))) return false;
  const ip = rawIp.toLowerCase().replace(/^::ffff:/, "").replace(/%.*$/, "");
  const v4 = v4ToInt(ip);
  if (ip === "::1" || (v4 !== null && inSubnet(v4, LOOPBACK_V4.base, LOOPBACK_V4.mask))) return true;
  return isOwnAddress(ip);
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

/**
 * bootstrap.herdr 의 고정값. 옛 herdr 실행기는 없고 서버는 herdr 소켓을 열지 않는다.
 * 출시된 앱(0.2.2)이 이 칸을 풀어 읽으므로 같은 모양으로 계속 싣는다.
 */
const HERDR_UNUSED: HerdrInfo = Object.freeze({ installed: false, running: false, version: null, protocol: null, compatible: false, warning: null });

/** 옛 herdr 실행기 전용이던 주소와 그 자리에 답할 안내. */
const GONE_ROUTES: [method: string, path: string, message: string][] = [
  ["GET", "/api/herdr/agents", "herdr 세션 목록은 없어졌습니다. 서버는 herdr 를 보지 않고, 팀장은 모두 herdr-core 에서 띄웁니다"],
  ["GET", "/api/projects/:id/adopt/preview", "기존 터미널 세션 편입은 없어졌습니다. 팀 화면에서 팀장을 새로 만들거나, 직접 띄운 세션에서 iamceo join 으로 붙이세요"],
  ["POST", "/api/projects/:id/adopt", "기존 터미널 세션 편입은 없어졌습니다. 팀 화면에서 팀장을 새로 만들거나, 직접 띄운 세션에서 iamceo join 으로 붙이세요"],
  ["POST", "/api/members/:id/release", "편입 해제는 없어졌습니다. 이전 실행기의 세션이 남은 팀장은 팀 화면의 '새 세션으로 이어가기'로 옮겨 계속 쓸 수 있습니다. 명부에서 빼려면 총괄에게 그 팀장을 닫으라고 하세요"],
  ["POST", "/api/members/:id/reopen-with-tools", "'도구 붙여 다시 열기'는 없어졌습니다. 이전 실행기의 세션은 그 터미널에서 확인하고, 이어서 맡기려면 팀장을 새로 만드세요"],
];

// ---- 요청 검증 ----
const nonEmpty = z.string().trim().min(1);
const backend = z.enum(["core", "herdr", "headless"]);
const cliProvider = z.enum(["claude", "codex"]);
const permissionMode = z.enum(PERMISSION_MODES);
const effort = z.string().min(1); // Membership comes from the selected model's catalog, including new CLI names.
// 그대로 --model 뒤에 들어간다. '--플래그' 나 공백이 들어오면 안 된다. 별칭(haiku)·전체 이름·[1m] 을 받는다.
const modelName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,127}$/, "모델 이름이 잘못되었습니다");
const listedModel = z.string().trim(); // Membership validation supplies the same 400 reason for every unlisted string.
const codexEffort = effort;
const rankPatch = z.object({ model: listedModel.nullable(), effort: effort.nullable() }).partial().strict();
const codexRankPatch = rankPatch.extend({ effort: codexEffort.nullable().optional() });
const handle = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

// 실행 방식·권한·모델은 전체 설정 하나다. 옛 화면이 보낸 값을 조용히 버리지 않고 거부한다.
const CreateProjectSchema = z.strictObject({
  name: nonEmpty,
  cwd: nonEmpty,
  goal: z.string().optional(),
  startConductor: z.boolean().optional(),
  chiefCli: cliProvider.optional(),
  trustFolder: z.boolean().optional(),
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
const PatchMemberSchema = z.strictObject({ cli: cliProvider.optional(), modelOverride: listedModel.nullable().optional(), effortOverride: z.union([effort, codexEffort]).nullable().optional() });
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
  contextFileId: z.string().nullable().optional(),
});
const AnswerSchema = z.object({
  expectedVersion: nonEmpty.optional(),
  choice: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  batch: z.boolean().optional(),
  // 사용 한도 카드의 모델 답에 앱이 본 카드의 팀장을 싣는다(AnswerReq.memberIds).
  memberIds: z.array(z.string().min(1).max(200)).max(500).optional(),
});
const TodoDropSchema = z.object({ reason: z.string().max(100_000).optional() });
const TodoDoneSchema = z.object({ done: z.boolean(), note: z.string().max(100_000).optional(), fileIds: z.array(z.string().min(1)).max(50).optional() });
const SleepSchema = z.object({ force: z.boolean().optional() });
const SettingsSchema = z
  .object({
    backend,
    permissionMode,
    ranks: z.object({ manager: rankPatch, lead: rankPatch, staff: rankPatch }).partial().strict(),
    codexRanks: z.object({ manager: codexRankPatch, lead: codexRankPatch, staff: codexRankPatch }).partial().strict(),
    maxConcurrentTurns: z.number().int().min(1).max(64),
    compactAtPct: z.number().int().min(1).max(100),
    // 창 크기(토큰)를 모를 때의 값. 1k~10M.
    contextWindowDefault: z.number().int().min(1_000).max(10_000_000),
    contextWindows: z.record(z.string().min(1).max(200), z.number().int().min(1_000).max(10_000_000)),
    maxAwakeWorkers: z.number().int().min(1).max(256),
    notifyMac: z.boolean(),
    macScriptNotifications: z.boolean(),
    // 0 이면 끈다. 화면은 끔·3·6·12·24 를 고르게 한다.
    boardTidyHours: z.number().int().min(0).max(168),
    // 확인은 되돌리지 않는다. 받은 설정을 통째로 돌려보내는 화면이 있어 false 도 받되, 바꾸지는 않는다(acknowledged).
    permissionAcknowledged: z.boolean(),
    // B1: 대표에게 쓰는 글의 언어. 서버 머리말([대표]·[총괄])은 언어와 상관없이 그대로다.
    reportLanguage: z.enum(REPORT_LANGUAGES),
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
  return publicFields({ ...member, lastActiveAt: member.lastActiveAt ?? null }, ["id", "projectId", "handle", "name", "role", "kind", "origin", "wasAdopted", "cli", "backend",
    "modelOverride", "effortOverride", "appliedModel", "appliedEffort", "status", "now", "next", "cwd", "sessionId", "paneId",
    "contextPct", "contextWindow", "contextWindowSource", "subagents", "parallel", "queuedCount", "lastError", "lastActiveAt", "updatedAt", "createdAt",
    "statusObservation", "blockedReason", "blockedCode", "subagentState", "nowAt", "manualActivityAt", "executionState", "lifecycleState", "contextState"]);
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
    case "settings": result = { settings: publicFields(receipt.result.settings, ["backend", "permissionMode", "ranks", "codexRanks", "maxConcurrentTurns", "compactAtPct", "contextWindowDefault", "contextWindows", "maxAwakeWorkers", "notifyMac", "macScriptNotifications", "boardTidyHours", "permissionAcknowledged", "reportLanguage"]), revision: receipt.result.revision }; break;
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

/** Wire-only projection: never mutate the cached/persisted full document. */
export function liteFile(file: FileDoc): Omit<FileDoc, "body"> {
  const { body: _body, ...metadata } = file;
  return metadata;
}
export function liteEvent(event: WsEvent): unknown {
  return event.type === "file" ? { ...event, file: liteFile(event.file) } : event;
}
function wantsLite(url: URL): boolean {
  const value = url.searchParams.get("lite");
  if (value !== null && value !== "1" && value !== "0") throw new ApiError(400, "lite 값이 잘못되었습니다");
  return value === "1";
}

/** 권한 방식 확인은 true 로만 바뀐다. 통째로 돌아온 설정의 false 는 '바꾸지 않음'으로 읽는다. */
function acknowledged<T extends { permissionAcknowledged?: boolean }>(body: T): T {
  if (body.permissionAcknowledged === true) return body;
  const { permissionAcknowledged: _unchanged, ...rest } = body;
  return rest as T;
}

/** 실행 엔진 상태. 엔진이 없는 실행 방식이나 구형 조립에서는 싣지 않는다. */
function engineField(orch: OrchestratorApi): { engine?: EngineStatus } {
  const engine = orch.engineStatus?.() ?? null;
  return engine ? { engine } : {};
}

/** D9: 마지막으로 읽은 CLI 버전. 아직 못 읽었으면 싣지 않는다. 기다리지 않는다(낡았으면 뒤에서 다시 읽는다). */
function cliVersionsField(ctx: ServerContext): { cliVersions?: CliVersionInfo[] } {
  try {
    const infos = ctx.cliVersions?.snapshot();
    return infos ? { cliVersions: infos } : {};
  } catch { return {}; }
}

/** Tailscale 상태. 그 주소를 연 적이 없거나 주소를 직접 정한 설치에서는 싣지 않는다. */
type TailnetField = () => { tailnet?: TailnetStatus };

function apiRoutes(ctx: ServerContext, urls: () => string[], pairing: Pairing, monitor: LoopMonitor, tailnetField: TailnetField): Route[] {
  const { config, store, orch, bus } = ctx;
  const models = new ModelCatalogReader(config);
  const folders = new Folders(ctx.folderHome);
  const github = new GitHub(folders, { ...process.env }, 600_000, { stateHome: config.home, freeBytes: ctx.githubFreeBytes });
  const legacyProjectPatches = new Set<string>();
  let syncGeneration = "";
  const syncCache = new Map<string, string>();
  const notices = (id: string) => monitor.run("delivery:notices", () => ctx.delivery!.notices(id));
  // 스냅샷의 전달 알림은 선택 장식이다. 전달 행 하나가 어긋났다고 대화·결재까지 못 읽게 두지 않는다.
  // 전용 조회(/delivery-notices)는 오류를 그대로 돌려줘 문제를 숨기지 않는다.
  const noticeFailureLoggedAt = new Map<string, number>();
  const snapshotNotices = (id: string): { deliveryNotices?: ReturnType<typeof notices> } => {
    if (!ctx.delivery) return {};
    try { return { deliveryNotices: notices(id) }; }
    catch (error) {
      // 스냅샷은 이벤트마다 다시 만든다. 같은 원인을 프로젝트당 1분에 한 줄만 남긴다.
      const at = Date.now();
      if (at - (noticeFailureLoggedAt.get(id) ?? -Infinity) >= 60_000) {
        noticeFailureLoggedAt.set(id, at);
        console.error(`전달 알림 계산 실패(${id}): ${error instanceof ApiError ? `${error.status} ${error.message}` : error instanceof Error ? error.name : "unknown"}`);
      }
      return {};
    }
  };
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
    handler: (req, url, params) => monitor.runAsync(`${method} ${path}`, async () => handler(req, url, params)),
  });

  /** 연결되어 있지 않으면 409. 화면도 입력을 막지만 다른 기기·늦게 온 요청이 있다. */
  const requireReachable = async (projectId: string, targetId: string | null): Promise<void> => {
    await (orch.refreshHealth ?? orch.refreshConnection)?.call(orch);
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
  const fileSearch = (archived: boolean): Handler => (req, url, [id]) => {
    contractV2(req);
    strictQuery(url, ["q", "limit"], "INVALID_FILE_SEARCH_QUERY");
    const query = url.searchParams.get("q"), limit = url.searchParams.get("limit");
    if (query === null || (limit !== null && (!/^[0-9]+$/.test(limit) || Number(limit) < 1 || Number(limit) > 200))) {
      throw new ApiError(400, "자료 검색 조건이 잘못되었습니다", "INVALID_FILE_SEARCH_QUERY");
    }
    return Response.json(store.searchFiles(id!, query, limit === null ? 50 : Number(limit), archived), { headers: { "Cache-Control": "no-store" } });
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
    route("GET", "/api/projects/:id/files/search", fileSearch(false)),
    route("GET", "/api/projects/:id/archive/files/search", fileSearch(true)),
    route("GET", "/api/projects/:id/local-file", (_req, url, [id]) => {
      const file = readLocalFile(store, id!, url.searchParams.get("path") ?? "", ctx.folderHome, configuredSecretRoots(config, process.env, ctx.folderHome));
      const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `sandbox allow-scripts; ${ARTIFACT_CSP}`, "Referrer-Policy": "no-referrer" };
      if (file.info.kind === "html" && url.searchParams.get("render") === "1") return new Response(buildArtifactSrcdoc(file.info.content ?? "", { title: file.info.name }), { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
      if (file.bytes) return new Response(new Uint8Array(file.bytes), { headers: { ...headers, "Content-Type": file.info.mime,
        "X-Local-File-Metadata": Buffer.from(JSON.stringify(file.info)).toString("base64") } });
      return Response.json(file.info, { headers });
    }),
    route("POST", "/api/projects/:id/files/from-path", async (req, _url, [id]) => {
      activeProject(id!);
      const body = await parseBody(req, z.strictObject({ path: z.string().min(1), title: z.string().trim().min(1).max(500).optional() }));
      const local = readLocalFile(store, id!, body.path, ctx.folderHome, configuredSecretRoots(config, process.env, ctx.folderHome));
      return Response.json(await once(`local-file:${id}:${local.info.path}`, async () => {
        activeProject(id!);
        const existing = store.listFiles(id!).find(file => file.path === local.info.path);
        let publication: FilePublication | undefined;
        try {
          const attachments: SavedFile[] = [];
          const detectedKind = fileKindOf(local.info.name, local.info.mime);
          if (!["text", "html", "csv"].includes(local.info.kind) || detectedKind === "image") {
            if (local.info.size > MAX_UPLOAD_BYTES) throw new ApiError(413, "파일은 50MB 까지 올릴 수 있습니다");
            const input = prepareImport(local.info.path);
            checkLocalImportPath(input.source, ctx.folderHome, configuredSecretRoots(config, process.env, ctx.folderHome));
            // stagePath must copy the inode/contents that passed our security and size checks.
            Object.assign(input, local.identity, { size: local.info.size });
            publication = new FilePublication(config.uploadsDir);
            attachments.push(await publication.stagePath(input));
            publication.publish();
          }
          const kind = local.info.kind === "text" && detectedKind === "file" ? "code" : detectedKind;
          const bodyText = kind === "artifact" || attachments.length ? "" : local.info.content ?? "";
          const html = kind === "artifact" ? local.info.content ?? null : null;
          const sameBytes = async () => {
            if (!existing || existing.kind !== kind || existing.body !== bodyText || store.getFileHtml(existing.id) !== html || existing.attachments.length !== attachments.length) return false;
            for (let i = 0; i < attachments.length; i++) {
              const oldPath = resolveInside(config.uploadsDir, existing.attachments[i]!.path);
              const newPath = resolveInside(config.uploadsDir, attachments[i]!.path);
              if (!oldPath || !newPath || !await Bun.file(oldPath).exists()) return false;
              const oldHash = createHash("sha256").update(new Uint8Array(await Bun.file(oldPath).arrayBuffer())).digest("hex");
              if (oldHash !== createHash("sha256").update(new Uint8Array(await Bun.file(newPath).arrayBuffer())).digest("hex")) return false;
            }
            return true;
          };
          if (await sameBytes()) {
            publication?.fail(createStorageReferences(store, join(config.home, "inbox")));
            return { ...existing!, reused: true };
          }
          const file = store.transaction(() => {
            activeProject(id!);
            return store.createFile({ projectId: id!, title: body.title ?? local.info.name, who: "대표", path: local.info.path,
              body: bodyText, kind, html,
              attachments: attachments.map(saved => store.createAttachment(saved)) });
          });
          publication?.complete();
          return { ...file, reused: false };
        } catch (error) {
          try { publication?.fail(createStorageReferences(store, join(config.home, "inbox"))); } catch { /* Retain uncertain publication. */ }
          throw error;
        }
      }));
    }),
    route("GET", "/api/folders", async (_req, url) => Response.json(await folders.list(url.searchParams.get("path") ?? undefined))),
    route("POST", "/api/folders", async req => {
      const { parent, name } = await parseBody(req, z.strictObject({ parent: z.string(), name: z.string() }));
      return Response.json(await folders.create(parent, name));
    }),
    route("GET", "/api/github/repos", async (_req, url) => Response.json(await github.repos(url.searchParams.get("query") ?? ""))),
    route("POST", "/api/github/clone", async req => Response.json(await github.clone(await parseBody(req, z.strictObject({ repo: z.string(), parent: z.string(), name: z.string().optional() }))), { status: 202 })),
    route("GET", "/api/github/clone/:id", (_req, _url, [id]) => Response.json(github.job(id!))),
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
      return Response.json(monitor.run("delivery:memberNotices", () => ctx.delivery!.memberNotices(id!, { limit: rawLimit === null ? 50 : Number(rawLimit), before: before ?? undefined })));
    }),
    route("GET", "/api/projects/:id/delivery-notices", (_req, url, [id]) => {
      strictQuery(url, []);
      if (!ctx.delivery) throw new ApiError(501, "전달 조회를 지원하지 않습니다");
      return Response.json(notices(id!));
    }),
    route("POST", "/api/messages/:id/recovery", async (req, url, [id]) => {
      contractV2(req);
      strictQuery(url, []);
      const body = await parseBody(req, z.strictObject({ operationId: operationIdSchema, expectedVersion: revision,
        action: z.enum(["send_to_conductor", "dismiss"]) }));
      if (!ctx.delivery) throw new ApiError(501, "메시지 정리를 지원하지 않습니다");
      const result = ctx.delivery.recoverUnassignedMessage(id!, body);
      return Response.json(result, { status: result.outcome === "dismissed" ? 200 : 202 });
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
    route("GET", "/api/models", (_req, url) => {
      strictQuery(url, []);
      return Response.json(models.read());
    }),
    route("GET", "/api/sync", async (req, url) => {
      strictQuery(url, ["projectId", "lite"]);
      const lite = wantsLite(url);
      const requestedProjectId = url.searchParams.get("projectId");
      if (requestedProjectId !== null && (!requestedProjectId.trim() || Buffer.byteLength(requestedProjectId) > 256)) throw new ApiError(400, "프로젝트 ID가 잘못되었습니다");
      // D5: 버전 머리글을 보낸 앱에만 server·compat 을 싣는다. 앱마다 답이 다르니 캐시 열쇠에도 넣는다.
      const versionFields = compatFields(readAppClient(req.headers), VERSION);
      return monitor.run("GET /api/sync build", () => {
        // No await from the generation check through serialization. Concurrent readers share these bytes.
        const generation = JSON.stringify([bus.epoch, bus.seq, urls(), tailnetField()]);
        if (syncGeneration !== generation) { syncCache.clear(); syncGeneration = generation; }
        const key = JSON.stringify([requestedProjectId, lite, versionFields]);
        const cached = syncCache.get(key);
        if (cached !== undefined) return new Response(cached, { headers: { "Content-Type": "application/json" } });
        // 이 뒤 직렬화까지 await가 없다. 도메인 쓰기는 이 데몬의 Store가 소유한다.
        const project = requestedProjectId === null ? null : store.getProject(requestedProjectId);
        const projectStatus = requestedProjectId === null ? "none" : !project ? "not_found" : project.archived ? "archived" : "ok";
        const rankOverrides = { manager: 0, lead: 0 };
        for (const m of store.listAllMembers()) if (m.origin !== "manual" && (m.modelOverride || m.effortOverride)) rankOverrides[memberRank(m.kind)]++;
        const body: SyncSnapshot = {
          apiOutage: store.apiOutage(),
          protocol: 2, requestedProjectId, projectStatus,
          bootstrap: { apiOutage: store.apiOutage(), version: VERSION, settings: store.getSettings(), projects: store.projectSummaries(), herdr: HERDR_UNUSED,
            home: config.home, urls: urls(), cli: orch.cliCommand?.() ?? "iamceo", rankOverrides, ...engineField(orch), ...tailnetField(), ...versionFields,
            ...cliVersionsField(ctx) },
          state: projectStatus === "ok" ? { ...store.projectState(requestedProjectId!), ...snapshotNotices(requestedProjectId!) } : null,
          revisions: projectStatus === "ok" ? store.syncRevisions(requestedProjectId!) : { settings: store.settingsRevision(), members: {}, todos: {} },
          cursor: bus.cursor,
        };
        const serialized = JSON.stringify(lite && body.state ? { ...body, state: { ...body.state, files: body.state.files.map(liteFile) } } : body);
        // Bound arbitrary not-found project IDs and old project selections within this generation.
        if (syncCache.size >= 32) syncCache.delete(syncCache.keys().next().value!);
        syncCache.set(key, serialized);
        return new Response(serialized, { headers: { "Content-Type": "application/json" } });
      });
    }),
    route("GET", "/api/bootstrap", async (req) => {
      // 앱의 첫 연결 확인(제한 3초)이다. 실행기 정리나 느린 조회를 기다리지 않고 마지막으로 아는 값으로 답한다.
      const runtime = await Promise.resolve((orch.refreshHealth ?? orch.refreshConnection)?.call(orch)).then(() => orch.runtimeInfo?.());
      const rankOverrides = { manager: 0, lead: 0 };
      for (const m of store.listAllMembers()) if (m.origin !== "manual" && (m.modelOverride || m.effortOverride)) rankOverrides[memberRank(m.kind)]++;
      const body: Bootstrap = {
        apiOutage: store.apiOutage(),
        version: VERSION,
        runtime,
        settings: store.getSettings(),
        projects: store.projectSummaries(),
        herdr: HERDR_UNUSED,
        home: config.home,
        urls: urls(),
        cli: orch.cliCommand?.() ?? "iamceo",
        rankOverrides,
        ...engineField(orch),
        ...tailnetField(),
        // D5: 버전 머리글을 보낸 앱에만. 머리글 없는 출시 앱의 응답은 그대로다.
        ...compatFields(readAppClient(req.headers), VERSION),
        // D9: 선택 필드. 출시된 앱은 모르는 칸을 건너뛴다.
        ...cliVersionsField(ctx),
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
    route("GET", "/api/pair/status", (_req, url) => {
      strictQuery(url, ["code"]);
      const code = url.searchParams.get("code");
      if (!code || code.length > 64) throw new ApiError(400, "짝 맺기 코드가 필요합니다");
      return Response.json(pairing.status(code));
    }),
    route("POST", "/api/pair/ack", async (req, url) => {
      strictQuery(url, []);
      const body = await parseBody(req, z.object({ code: z.string().min(1).max(64), confirmationToken: z.string().length(64) }).strict());
      if (!pairing.acknowledge(body.code, body.confirmationToken)) throw new ApiError(409, "연결 확인 시간이 지났습니다. Mac에서 새 QR을 만들어 주세요");
      return Response.json(pairing.status(body.code));
    }),
    route("GET", "/api/runtime", async () => {
      if (!orch.runtimeInfo) throw new ApiError(501, "실행기 진단을 지원하지 않습니다");
      return Response.json(await orch.runtimeInfo());
    }),
    route("POST", "/api/projects/:id/members", async (req, _url, [id]) => {
      store.requireProject(id!);
      if (!orch.createMember) throw new ApiError(501, "팀장 만들기를 지원하지 않습니다");
      return Response.json(await orch.createMember(id!, await parseBody(req, CreateMemberSchema)));
    }),
    route("GET", "/api/projects/:id/state", (_req, url, [id]) => {
      // 보관한 프로젝트는 없는 것으로 친다. 화면이 본사로 돌아간다.
      if (store.requireProject(id!).archived) throw new ApiError(404, "보관된 프로젝트입니다");
      const state = store.projectState(id!);
      const snapshot = { ...state, ...snapshotNotices(id!) };
      return Response.json(wantsLite(url) ? { ...snapshot, files: state.files.map(liteFile) } : snapshot);
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
    // B 묶음(설치 수명): 보관한 프로젝트 지우기와 프로젝트 내보내기. 내보내기의 '이 Mac 에서만' 판정은 startServer 의 경로 앞에서 한다.
    route("DELETE", "/api/projects/:id", (_req, url, [id]) => {
      strictQuery(url, []);
      const deleted = store.deleteArchivedProject(id!);
      const removed = removeDeletedProjectFiles(config, deleted);
      const body: ProjectDeleteResult = { id: deleted.project.id, deleted: true, removedAttachments: removed.attachments };
      return Response.json(body);
    }),
    route("GET", "/api/projects/:id/export", async (_req, url, [id]) => {
      strictQuery(url, []);
      const exported = await exportProjectZip(store, config, id!);
      return new Response(exported.stream, { headers: {
        "Content-Type": "application/zip", "Content-Length": String(exported.size), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `attachment; filename="iamceo-export.zip"; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
      } });
    }),
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
        throw new ApiError(400, "이 프로젝트의 팀원이 아닙니다");
      }
      store.requireReachable(id!, body.targetMemberId ? store.getMember(body.targetMemberId) : null);
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
      if (store.requireDecision(id!).kind === "usage_limit") {
        // 같은 답의 재전송만 앞 요청의 결과를 함께 받는다. 다른 답은 총괄이 판정한다(도는 답이 있으면 409): 결재 id 하나로만 묶으면
        // 모델을 바꾸는 동안 온 다른 선택이 앞 답의 결과를 200 으로 받아 갔다.
        return Response.json(await once(`decision:${id}:${body.choice ?? ""}`, () => orch.answerDecision(id!, body)));
      }
      const duplicate = store.checkAnswer(id!, body);
      if (duplicate) return Response.json(duplicate);
      const decision = store.requireDecision(id!);
      store.requireReachable(decision.projectId, decision.memberId ? store.getMember(decision.memberId) : null);
      const answered = await once(`decision:${id}`, () => orch.answerDecision(id!, body));
      // 동시에 온 다른 답이 앞 요청의 결과를 받아 가면 안 된다.
      store.checkAnswer(id!, body);
      return Response.json(answered);
    }),
    route("POST", "/api/decisions/:id/close", (_req, _url, [id]) => {
      const decision = store.requireDecision(id!);
      if (decision.kind !== "usage_limit") throw new ApiError(400, "사용 한도 알림만 닫을 수 있습니다");
      return Response.json(decision.status === "closed" ? decision : store.setDecisionStatus(decision.id, "closed"));
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
    route("POST", "/api/todos/:id/drop", async (req, _url, [id]) => {
      store.requireTodo(id!);
      if (contractV2(req)) {
        const expected = precondition(req);
        const body = await parseBody(req, TodoDropSchema.strict());
        if (!orch.dropTodoV2) throw new ApiError(501, "검토 버전이 있는 업무 변경을 지원하지 않습니다");
        return Response.json(await orch.dropTodoV2(id!, body, expected));
      }
      const body = await parseBody(req, TodoDropSchema);
      if (!orch.dropTodo) throw new ApiError(501, "지원하지 않습니다");
      return Response.json(await orch.dropTodo(id!, body.reason));
    }),
    route("POST", "/api/todos/:id/done", async (req, _url, [id]) => {
      const todo = store.requireTodo(id!);
      if (contractV2(req)) {
        const expected = precondition(req);
        const body = await parseBody(req, TodoDoneSchema.strict());
        if (!orch.setTodoDoneV2) throw new ApiError(501, "검토 버전이 있는 업무 변경을 지원하지 않습니다");
        return Response.json(await orch.setTodoDoneV2(id!, body, expected));
      }
      const body = await parseBody(req, TodoDoneSchema);
      if (!body.done && (body.note !== undefined || body.fileIds?.length)) throw new ApiError(400, "완료할 때만 답과 첨부를 붙일 수 있습니다");
      for (const fileId of body.fileIds ?? []) if (!store.getAttachment(fileId)) throw new ApiError(400, "업로드된 첨부를 찾을 수 없습니다");
      if (todo.done === body.done) return Response.json(todo);
      return Response.json(await orch.setTodoDone(id!, body.done, body));
    }),
    route("GET", "/api/files/:id", (_req, url, [id]) => {
      strictQuery(url, []);
      const file = store.getFile(id!);
      if (!file) throw new ApiError(404, "자료를 찾을 수 없습니다");
      return Response.json(file, { headers: { "Cache-Control": "no-store" } });
    }),
    route("GET", "/api/files/:id/artifact", async (_req, url, [id]) => {
      // 원본은 JSON, 네이티브 render는 sandbox CSP를 보존한 격리 WKWebView에서 연다.
      const html = await artifactHtml(ctx, id!);
      if (url.searchParams.get("render") === "1") return new Response(buildArtifactSrcdoc(html, { title: store.getFile(id!)!.title }), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `sandbox allow-scripts; ${ARTIFACT_CSP}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
      return Response.json({ html }, { headers: { "Cache-Control": "no-store", "Content-Security-Policy": `sandbox allow-scripts; ${ARTIFACT_CSP}`, "X-Content-Type-Options": "nosniff" } });
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
        models.memberPatch(store.requireMember(id!), body, store.getSettings());
        if (!orch.patchMemberConfigV2) throw new ApiError(501, "검토 버전이 있는 팀원 설정을 지원하지 않습니다");
        return Response.json(await orch.patchMemberConfigV2(id!, body, expected));
      }
      const body = await parseBody(req, PatchMemberSchema);
      models.memberPatch(store.requireMember(id!), body, store.getSettings());
      return Response.json(await orch.patchMemberConfig(id!, body));
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
    // 옛 herdr 실행기와 함께 없앤 기능의 주소. 출시된 앱(0.2.2)은 부르지 않지만, 옛 화면·스크립트가 불러도 404(없는 주소)가 아니라
    // 410(없어진 기능)과 다음에 할 일을 받게 한다. 무엇도 읽거나 바꾸지 않는다.
    ...GONE_ROUTES.map(([method, path, message]) => route(method, path, async () => { throw new ApiError(410, message); })),
    route("PATCH", "/api/settings", async req => {
      const expected = contractV2(req) ? precondition(req) : null;
      const body = await parseBody(req, z.strictObject({ macScriptNotifications: z.boolean().optional(), permissionAcknowledged: z.literal(true).optional() })
        .refine(value => value.macScriptNotifications !== undefined || value.permissionAcknowledged !== undefined, "바꿀 설정이 필요합니다"));
      if (expected) {
        if (!orch.updateSettingsV2) throw new ApiError(501, "검토 버전이 있는 설정 변경을 지원하지 않습니다");
        return Response.json(await orch.updateSettingsV2(body, expected));
      }
      return Response.json(await orch.updateSettings(body));
    }),
    route("PUT", "/api/settings", async (req) => {
      if (contractV2(req)) {
        const expected = precondition(req);
        const body = acknowledged(await parseBody(req, SettingsSchema));
        const normalized = models.settingsPatch(body, store.getSettings());
        if (!orch.updateSettingsV2) throw new ApiError(501, "검토 버전이 있는 설정 변경을 지원하지 않습니다");
        const result = await orch.updateSettingsV2(normalized.patch, expected);
        if (normalized.resetEfforts.length) result.settings = { ...result.settings, resetEfforts: normalized.resetEfforts };
        return Response.json(result);
      }
      const body = acknowledged(await parseBody(req, SettingsSchema));
      const normalized = models.settingsPatch(body, store.getSettings());
      const settings = await orch.updateSettings(normalized.patch);
      return Response.json(normalized.resetEfforts.length ? { ...settings, resetEfforts: normalized.resetEfforts } : settings);
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
    if (existing.origin !== "manual") throw new ApiError(409, `이미 실행기가 관리하는 팀원입니다: ${existing.name}`);
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

const WS_TOPIC = "events";
const WS_V2_TOPIC = "events-v2";
const WS_LITE_TOPIC = "events-lite";
const WS_V2_LITE_TOPIC = "events-v2-lite";
export async function startServer(ctx: ServerContext): Promise<RunningServer> {
  const monitor = ctx.loopMonitor ?? new LoopMonitor();
  const { config, store, bus } = ctx;
  const ipRule = buildIpRule(config.hosts);
  const hosts: string[] = [];
  const bindings = new Map<string, HostBinding>();
  let authGeneration = 0;
  let boundPort = 0;
  const pairing = new Pairing();
  const terminalStreams = new TerminalStreams(config, store, ctx.orch);
  // 꺼짐 판정이 바뀌는 것은 따로 이벤트가 없는 변화다. 엔진 상태와 같이 기존 신호로 화면이 스냅샷을 다시 읽게 한다.
  const tailnet = new TailnetWatch({
    auto: config.hostsAuto === true,
    seen: () => store.tailnetSeen(),
    remember: seen => store.rememberTailnetSeen(seen),
    notify: (title, body) => ctx.orch.notifyOperations?.(title, body) ?? false,
    changed: () => store.touchSnapshot(),
    ...ctx.tailnetWatch,
  });
  const tailnetField: TailnetField = () => { const status = tailnet.status(); return status ? { tailnet: status } : {}; };
  // D9: 시작할 때 CLI 버전을 한 번 읽어 기록하고(처음 본 버전은 로그 한 줄), 실행 파일이 바뀌면 다시 읽는다. 바뀌면 앱이 스냅샷을 다시 읽게 한다.
  // 문맥은 복사하지 않고 그 자리에 붙인다: 경로들은 같은 문맥 객체를 읽는다(시험이 뒤에 포트를 바꾼다).
  if (!ctx.cliVersions && process.env.IAMCEO_TEST !== "1") {
    const watcher = new CliVersionMonitor({ home: config.home, claudeBin: config.claudeBin, codexBin: config.codexBin, onUpdate: () => store.touchSnapshot() });
    ctx.cliVersions = watcher;
    void watcher.refresh().catch(() => undefined);
  }
  /** 점검(A, cli_version)도 이 캐시를 쓴다: 실행 파일이 그대로면 --version 을 다시 부르지 않는다. 시험에서 넣지 않았으면 없다. */
  const cliVersions = ctx.cliVersions;
  const routes = apiRoutes(ctx, () => reachableUrls(hosts, boundPort), pairing, monitor, tailnetField);
  const pushHandler = ctx.push ? createPushHandler(ctx.push) : null;
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const v2Sockets = new Set<ServerWebSocket<SocketData>>();
  const requests = new Set<Promise<Response | undefined>>();
  let socketsDrained: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopping = false;
  let closedEpochSockets = false;
  const hasAccessCode = (req: Request): boolean => {
    const given = bearer(req);
    return given !== null && safeEqual(given, config.accessCode);
  };
  /** D5: 버전 머리글을 보낸 앱들(인증된 요청만). /api/readiness 의 apps 로 보인다. */
  const seenApps = new SeenApps();
  const seenAppsField = () => { const apps = seenApps.list(); return apps.length ? { apps } : {}; };

  const route = (req: Request, url: URL, server: Server<SocketData>): Response | Promise<Response | undefined> | undefined => {
    const path = url.pathname;
    const starting = () => fail(503, "서버를 시작하는 중입니다", "STARTING");
    if (stopping) return starting();
    if (ctx.daemon?.().ready === false && path === "/api/health") return starting();
    if (path === "/api/health") return Response.json({ ok: true, version: VERSION });
    // 짝 맺기 코드를 낸 폰에만 접속 코드를 준다. 코드 자체가 인증이라 접속 코드 검사 앞에 둔다.
    if (path === "/pair/claim") return handlePairClaim(req, server);
    if (path === "/ws") {
      strictQuery(url, ["v", "t", "lite"]);
      const version = url.searchParams.get("v");
      if (version !== null && version !== "2") return fail(400, "실시간 연결 버전이 잘못되었습니다");
      if (!hasAccessCode(req)) return fail(401, "인증이 필요합니다");
      if (version === "2" && url.searchParams.has("t")) return fail(400, "실시간 연결 주소에 접속 코드를 넣지 마세요");
      return server.upgrade(req, { data: { kind: "realtime", protocol: version === "2" ? 2 : 1, authGeneration, lite: wantsLite(url) } }) ? undefined : fail(400, "WebSocket 요청이 아닙니다");
    }
    if (path.startsWith("/api/")) {
      if (!hasAccessCode(req)) return fail(401, "인증이 필요합니다");
      seenApps.note(readAppClient(req.headers));
      if (ctx.daemon?.().ready === false && (path === "/api/sync" || path === "/api/readiness" || path === "/api/runtime" || path === "/api/bootstrap" || /^\/api\/projects\/[^/]+\/state$/.test(path) || path === "/api/push/status")) return starting();
      const terminal = /^\/api\/members\/([^/]+)\/terminal\/stream$/.exec(path);
      if (terminal) {
        if (req.method !== "GET") return fail(405, "허용되지 않는 메서드입니다");
        strictQuery(url, ["mode", "cols", "rows", "lease", "size"]);
        const generation = authGeneration;
        return terminalStreams.prepare(decodeURIComponent(terminal[1]!), url).then(async stream => {
          if (generation !== authGeneration || stopPromise) {
            await stream.close();
            return fail(401, "접속 코드가 바뀌었거나 서버가 종료됐습니다");
          }
          if (server.upgrade(req, { data: { kind: "terminal", authGeneration, stream } })) return undefined;
          await stream.close();
          return fail(400, "WebSocket 요청이 아닙니다");
        });
      }
      if (path === "/api/auth/rotate") return rotate(req, url, server);
      if (path === "/api/readiness") return readiness(req, url);
      if (path === "/api/doctor") return doctor(req, url);
      if (path === "/api/diagnose") return diagnose(req, url, server);
      // B 묶음: 프로젝트 내보내기는 이 Mac 에서 온 요청만(대화 전체와 첨부 원본이 한 파일로 나간다).
      if (/^\/api\/projects\/[^/]+\/export$/.test(path) && !isLocalRequest(server.requestIP(req)?.address, req.headers)) return fail(403, "프로젝트 내보내기는 이 Mac 에서만 할 수 있습니다", "LOCAL_ONLY");
      if (path === "/api/push" || path.startsWith("/api/push/")) {
        return pushHandler ? pushHandler(req, url) : fail(501, "푸시를 지원하지 않습니다");
      }
      return dispatch(routes, req, url);
    }
    if (path.startsWith("/files/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "허용되지 않는 메서드입니다");
      if (!hasAccessCode(req)) return fail(401, "인증이 필요합니다");
      return filesResponse(url, ctx);
    }
    // 팀장용 통로는 이 Mac 안에서만 쓴다. 팀장의 도구 연결과 `iamceo join` 은 같은 컴퓨터에서 부른다.
    if (path.startsWith("/agent/") && !isLocalRequest(server.requestIP(req)?.address, req.headers)) return fail(403, "이 Mac 안에서만 쓸 수 있는 경로입니다", "LOCAL_ONLY");
    if (path === "/agent/join") return handleJoin(req, ctx);
    if (path.startsWith("/agent/")) {
      const token = bearer(req);
      const member = token ? store.getMemberByToken(token) : null;
      if (!member) return fail(401, "인증이 필요합니다");
      return dispatch(agentRoutes(ctx, member), req, url);
    }
    if (path === "/") return new Response("IAMCEO: Mac·iPhone 앱으로 연결하세요.\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
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
      core: runtime?.core ?? null, ...engineField(ctx.orch), ...tailnetField(), hosts: [...bindings.values()].map(binding => ({ ...binding })),
      ...seenAppsField() }, { status: ok ? 200 : 503 });
  };

  // ---- A(B3·D8): 점검표와 진단 파일 ----
  /** 서버가 이미 아는 값(실행 엔진·Tailscale 꺼짐·백업)에 이 Mac 에서 읽은 사실(자동 시작·로그인 기록·저장 공간)을 더한다. */
  const doctorFacts = async () => {
    const runtime = await Promise.resolve(ctx.orch.runtimeInfo?.()).catch(() => null) ?? null;
    const activeProjects = new Set(store.listProjects().map(project => project.id));
    const facts = await serverDoctorFacts({
      config, ready: ctx.daemon?.().ready ?? true,
      runtime: runtime as Parameters<typeof serverDoctorFacts>[0]["runtime"],
      engine: ctx.orch.engineStatus?.() ?? null,
      tailnet: tailnet.status() ?? null,
      tailnetSeen: store.tailnetSeen() !== null,
      detectedTailnet: (() => { try { return detect(); } catch { return []; } })(),
      codexInUse: store.listAllMembers().some(member => activeProjects.has(member.projectId) && member.cli === "codex"),
      // D9 의 CLI 버전 캐시를 쓴다(실행 파일이 그대로면 --version 을 다시 부르지 않는다). 없으면(시험) 모른다.
      probes: { cliVersions: async () => (cliVersions ? await cliVersions.refresh() : null), ...ctx.doctorProbes },
    });
    return { facts, runtime };
  };

  const doctor = async (req: Request, url: URL): Promise<Response> => {
    if (req.method !== "GET") return fail(405, "허용되지 않는 메서드입니다");
    strictQuery(url, ["lang"]);
    if (ctx.daemon?.().ready === false) return fail(503, "서버를 시작하는 중입니다", "STARTING");
    const lang: DoctorLang = url.searchParams.get("lang") === "en" ? "en" : "ko";
    return Response.json(doctorReport((await doctorFacts()).facts, lang));
  };

  // 겹친 요청은 하나로 합친다. 같은 순간에 두 번 눌러도 묶음은 하나다.
  let diagnosing: Promise<DiagnoseResult> | null = null;
  const diagnose = async (req: Request, url: URL, server: Server<SocketData>): Promise<Response> => {
    if (req.method !== "POST") return fail(405, "허용되지 않는 메서드입니다");
    strictQuery(url, []);
    // 진단 파일은 이 Mac 의 폴더에 남는다. 팀장용 통로와 같은 판정으로 이 Mac 안에서 온 요청만 받는다.
    if (!isLocalRequest(server.requestIP(req)?.address, req.headers)) return fail(403, "이 Mac 안에서만 쓸 수 있는 경로입니다", "LOCAL_ONLY");
    if (req.body !== null) await parseBody(req, z.strictObject({}));
    if (ctx.daemon?.().ready === false) return fail(503, "서버를 시작하는 중입니다", "STARTING");
    diagnosing ??= (async () => {
      const { facts, runtime } = await doctorFacts();
      const daemon = ctx.daemon?.() ?? null;
      const extra = runtime as { backup?: unknown } | null;
      return createDiagnostics({
        home: config.home, dbPath: config.dbPath, config, db: store.db, source: "server",
        versions: { server: VERSION, buildId: daemon?.buildId ?? null },
        doctor: doctorReport(facts, "ko"),
        server: {
          ready: daemon?.ready ?? null, pid: process.pid, uptimeSec: Math.round(process.uptime()),
          // 진단을 부른 앱의 버전(버전 머리글을 보내는 앱만). 명령줄이 부르면 null.
          requestedBy: readAppClient(req.headers),
          schema: { version: store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? null, supportedVersion: MIGRATIONS.length },
          core: runtime?.core ?? null, engine: ctx.orch.engineStatus?.() ?? null, tailnet: tailnet.status() ?? null,
          hosts: [...bindings.values()].map(binding => ({ host: binding.host, state: binding.state, attempts: binding.attempts, error: binding.error })),
          backup: extra?.backup ?? null, apiOutage: store.apiOutage(),
          vitals: (() => { try { return readVitals(store.db, config.dbPath); } catch { return null; } })(),
        },
        ...ctx.diagnose,
      });
    })().finally(() => { diagnosing = null; });
    return Response.json(await diagnosing);
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
    if (!hasAccessCode(req)) return fail(401, "인증이 필요합니다");
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
      if (ws.data.kind === "terminal") { void ws.data.stream.close("error", "접속 코드가 바뀌었습니다. 다시 연결하세요"); continue; }
      ws.unsubscribe(WS_TOPIC);
      ws.unsubscribe(WS_LITE_TOPIC);
      ws.unsubscribe(WS_V2_TOPIC);
      ws.unsubscribe(WS_V2_LITE_TOPIC);
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
    return Response.json({ accessCode: config.accessCode, confirmationToken: pairing.confirmationToken(body.code), version: VERSION }, { headers: { "Cache-Control": "no-store" } });
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
      // 디스크 가득·읽기 쓰기 오류는 앱이 알아볼 수 있게 분류해 답한다. SQLite 원문은 로그에만 남긴다.
      const storage = classifyStorageError(e);
      // 오류 객체도 요청 URL/헤더를 품을 수 있다. 경로와 오류 종류만 남긴다.
      console.error("요청 처리 오류:", req.method, url.pathname, e instanceof Error ? e.name : "unknown", ...(storage ? [storage] : []));
      if (storage === "storage_full") return noStore(fail(507, "저장 공간이 부족해 처리하지 못했습니다. Mac 의 디스크 공간을 확보한 뒤 다시 시도해 주세요", storage));
      if (storage === "storage_io") return noStore(fail(500, "저장소를 읽거나 쓰는 중 오류가 나 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요", storage));
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
      development: false,
      // 롱폴(/agent/ask/wait, wait 도구)이 끊기지 않게 최대로 둔다. 기본 10초.
      idleTimeout: 255,
      maxRequestBodySize: MAX_UPLOAD_BYTES + 1024 * 1024,
      routes: {
        "/api/*": handle,
        "/agent/*": handle,
        "/files/*": handle,
        "/pair/*": handle,
        "/ws": handle,
      },
      fetch: handle as (req: Request, server: Server<SocketData>) => Promise<Response>,
      websocket: {
        backpressureLimit: 16 * 1024 * 1024,
        closeOnBackpressureLimit: true,
        open(ws) {
          sockets.add(ws);
          if (stopping) {
            closedEpochSockets = true;
            if (ws.data.kind === "realtime") ws.send(JSON.stringify({ type: "restarting" }));
            ws.close(1012, "restarting");
            return;
          }
          if (ws.data.authGeneration !== authGeneration) {
            closedEpochSockets = true;
            ws.close(4001, "접속 코드가 바뀌었습니다. 다시 연결하세요");
            return;
          }
          if (ws.data.kind === "terminal") { closedEpochSockets = true; ws.data.stream.open(ws); return; }
          ws.subscribe(ws.data.lite ? (ws.data.protocol === 2 ? WS_V2_LITE_TOPIC : WS_LITE_TOPIC) : (ws.data.protocol === 2 ? WS_V2_TOPIC : WS_TOPIC));
          if (ws.data.protocol === 2) {
            v2Sockets.add(ws);
            ws.send(JSON.stringify({ type: "hello", protocol: 2, ...bus.cursor, heartbeatMs: WS_PING_MS, staleAfterMs: 45_000 }));
          } else {
            ws.send(JSON.stringify({ type: "hello", seq: bus.seq }));
          }
        },
        close(ws) {
          if (ws.data.kind === "terminal") void ws.data.stream.close();
          sockets.delete(ws);
          v2Sockets.delete(ws);
          if (sockets.size === 0) socketsDrained?.();
        },
        pong(ws) { if (ws.data.kind === "terminal") ws.data.stream.pong(); },
        // Realtime은 단방향이고 터미널 소켓만 입력을 받는다.
        message(ws, message) { if (ws.data.kind === "terminal") ws.data.stream.message(message); },
      },
    });

  const [firstHost, ...otherHosts] = config.hosts;
  const servers: Server<SocketData>[] = [];
  try {
    if (!firstHost) throw new Error("listen 할 주소가 없습니다");
    servers.push(serve(firstHost, config.port));
  } catch (error) {
    if (!ctx.loopMonitor) monitor.stop();
    await Promise.allSettled([terminalStreams.close()]);
    throw error;
  }
  const port = servers[0]!.port!;
  boundPort = port;
  hosts.push(firstHost);
  bindings.set(firstHost, { host: firstHost, state: "bound", attempts: 1, lastAttemptAt: new Date().toISOString(), error: null });
  // 실제로 듣고 있는 주소로 다시 정한다. 묶지 못한 주소 때문에 그 대역의 상대를 받지 않는다.
  // 모든 주소(0.0.0.0 등)로 듣는 설치는 Tailscale 이 확인될 때만 그 대역을 받는다.
  const refreshTailnet = () => {
    ipRule.tailnet = listensOnTailnet(hosts) || (hosts.some(host => host === "0.0.0.0" || host === "::") && (ctx.detectHosts ? listensOnTailnet(ctx.detectHosts()) : detectTailscaleIp() !== null));
  };
  refreshTailnet();
  const open = (host: string) => {
    const attempts = (bindings.get(host)?.attempts ?? 0) + 1;
    const lastAttemptAt = new Date().toISOString();
    try {
      servers.push(serve(host, port));
      hosts.push(host);
      bindings.set(host, { host, state: "bound", attempts, lastAttemptAt, error: null });
      refreshTailnet();
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
    const detected = config.hostsAuto ? detect() : [];
    const desired = [...new Set([...otherHosts, ...detected])];
    for (const host of desired) if (!hosts.includes(host)) open(host);
    if (hosts.some(host => host === "0.0.0.0" || host === "::")) refreshTailnet();
    tailnet.observe(detected, hosts);
  };
  // 켜진 채로 뜬 서버는 여기서 '연 적 있음'을 남긴다. 꺼진 채로 뜬 서버는 이때부터 유예 시간을 센다.
  if (config.hostsAuto) tailnet.observe(detect(), hosts);
  const hostTimer = setInterval(() => monitor.run("timer:syncHosts", syncHosts), HOST_SYNC_MS);
  hostTimer.unref?.();
  // 화면이 조용히 죽은 소켓을 알아채는 신호. 망이 바뀌면 소켓은 닫히지 않고 그냥 멈춘다.
  const pingTimer = setInterval(() => monitor.run("timer:wsPing", () => {
    const payload = JSON.stringify({ type: "ping" });
    const v2Payload = JSON.stringify({ type: "ping", ...bus.cursor });
    for (const server of servers) {
      server.publish(WS_TOPIC, payload);
      server.publish(WS_V2_TOPIC, v2Payload);
      server.publish(WS_LITE_TOPIC, payload);
      server.publish(WS_V2_LITE_TOPIC, v2Payload);
    }
  }), WS_PING_MS);
  pingTimer.unref?.();

  let publishedEpoch = bus.epoch;
  const unsubscribe = bus.subscribe((event, cursor) => {
    const epochChanged = publishedEpoch !== bus.epoch;
    if (epochChanged) {
      publishedEpoch = bus.epoch;
      closedEpochSockets ||= v2Sockets.size > 0;
      for (const ws of v2Sockets) {
        ws.unsubscribe(WS_V2_TOPIC);
        ws.unsubscribe(WS_V2_LITE_TOPIC);
        ws.close(1012, "실시간 동기화를 다시 시작하세요");
      }
    }
    const payload = JSON.stringify(event);
    const v2Payload = epochChanged || event.type === "hello" || event.type === "ping" ? null : JSON.stringify({ ...event, ...cursor });
    for (const server of servers) {
      server.publish(WS_TOPIC, payload);
      if (v2Payload) server.publish(WS_V2_TOPIC, v2Payload);
      server.publish(WS_LITE_TOPIC, JSON.stringify(liteEvent(event)));
      if (v2Payload) server.publish(WS_V2_LITE_TOPIC, JSON.stringify({ ...(liteEvent(event) as object), ...cursor }));
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
        stopping = true;
        clearInterval(hostTimer);
        clearInterval(pingTimer);
        unsubscribe();
        // Queue notice before the close frame, including legacy and lite realtime sockets.
        closedEpochSockets ||= sockets.size > 0;
        for (const ws of sockets) {
          if (ws.data.kind === "realtime") ws.send(JSON.stringify({ type: "restarting" }));
          ws.close(1012, "restarting");
        }
        const drained = sockets.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => { socketsDrained = resolve; });
        let closeDeadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.all([terminalStreams.close(), Promise.race([drained, new Promise<void>(resolve => { closeDeadline = setTimeout(resolve, 1_000); })])]);
        } finally { clearTimeout(closeDeadline); }
        const stopped = servers.map((s) => s.stop(true));
        // Bun 1.3.14는 서버가 먼저 닫은 WS를 pendingWebSockets에 남긴다.
        // force stop은 한 번만 호출하고 실제 요청/소켓의 종료를 직접 기다린다.
        await (closedEpochSockets ? Promise.all([...requests]) : Promise.all(stopped));
        if (!ctx.loopMonitor) monitor.stop();
      })();
    },
  };
}
