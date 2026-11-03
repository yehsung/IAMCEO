import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { detectTailscaleIp } from "./config.ts";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Server } from "bun";
import { z } from "zod";
import { EFFORTS, fileKindOf, memberRank, PERMISSION_MODES, type Bootstrap, type Member } from "../shared/types.ts";
import { ARTIFACT_CSP } from "../shared/artifact-kit.ts";
import type { Bus } from "./bus.ts";
import { VERSION, type Config } from "./config.ts";
import { MAX_ARTIFACT_BYTES, MAX_UPLOAD_BYTES, resolveInside, saveUpload } from "./files.ts";
import type { OrchestratorApi } from "./orchestrator-api.ts";
import { ApiError, type Store } from "./store.ts";
import { SESSION_ID_RE } from "./text.ts";

export interface ServerContext {
  config: Config;
  store: Store;
  bus: Bus;
  orch: OrchestratorApi;
  /** 시험용. 기본은 Tailscale 주소 감지. */
  detectHosts?: () => string[];
}

export interface RunningServer {
  port: number;
  hosts: string[];
  urls: string[];
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
const backend = z.enum(["herdr", "headless"]);
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
const PatchMemberSchema = z.strictObject({ modelOverride: modelName.nullable().optional(), effortOverride: effort.nullable().optional() });
const SendMessageSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  text: z.string(),
  targetMemberId: z.string().nullable().optional(),
  attachmentIds: z.array(z.string()).max(50).optional(),
});
const AnswerSchema = z.object({
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
    maxAwakeWorkers: z.number().int().min(1).max(256),
    notifyMac: z.boolean(),
    // 0 이면 끈다. 화면은 끔·3·6·12·24 를 고르게 한다.
    boardTidyHours: z.number().int().min(0).max(168),
  })
  .partial()
  .strict();
const AgentToolSchema = z.object({ name: nonEmpty, args: z.record(z.string(), z.unknown()).optional() });
const AskWaitSchema = z.object({ decisionId: nonEmpty, timeoutMs: z.number().int().positive().optional() });
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

async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "JSON 본문이 필요합니다");
  }
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

function fail(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
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

function apiRoutes(ctx: ServerContext, urls: () => string[]): Route[] {
  const { config, store, orch } = ctx;
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

  return [
    route("GET", "/api/bootstrap", async () => {
      await orch.refreshConnection?.();
      const rankOverrides = { manager: 0, lead: 0 };
      for (const m of store.listAllMembers()) if (m.origin !== "manual" && (m.modelOverride || m.effortOverride)) rankOverrides[memberRank(m.kind)]++;
      const body: Bootstrap = {
        version: VERSION,
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
    route("GET", "/api/projects/:id/state", (_req, _url, [id]) => {
      // 보관한 프로젝트는 없는 것으로 친다. 화면이 본사로 돌아간다.
      if (store.requireProject(id!).archived) throw new ApiError(404, "보관된 프로젝트입니다");
      return Response.json(store.projectState(id!));
    }),
    route("GET", "/api/projects/:id/messages", (_req, url, [id]) => {
      store.requireProject(id!);
      const before = url.searchParams.get("before") ?? undefined;
      return Response.json(store.listMessages(id!, { before, limit: parseLimit(url) }));
    }),
    route("POST", "/api/projects", async (req) => {
      const body = await parseBody(req, CreateProjectSchema);
      return Response.json(await orch.createProject({ ...body, cwd: expandDir(body.cwd) }));
    }),
    route("GET", "/api/projects/archived", () => Response.json(store.listProjects({ includeArchived: true }).filter((p) => p.archived))),
    route("GET", "/api/projects/:id/decisions", (_req, url, [id]) => {
      store.requireProject(id!);
      const status = url.searchParams.get("status") ?? "done";
      if (status === "open") return Response.json(store.listOpenDecisions(id!));
      if (status !== "done") throw new ApiError(400, "status 는 open 또는 done 입니다");
      return Response.json(store.listDoneDecisions(id!, { before: url.searchParams.get("before") ?? undefined, limit: parseLimit(url) }));
    }),
    route("GET", "/api/decisions/:id", (_req, _url, [id]) => Response.json(store.requireDecision(id!))),
    route("PATCH", "/api/projects/:id", async (req, _url, [id]) => {
      const current = store.requireProject(id!);
      const body = await parseBody(req, PatchProjectSchema);
      if (current.isHq && body.archived) throw new ApiError(400, "본사는 보관할 수 없습니다");
      const patch = body.cwd === undefined ? body : { ...body, cwd: expandDir(body.cwd) };
      await orch.beforeProjectPatch?.(current, patch);
      const project = store.patchProject(id!, patch);
      await orch.onProjectPatched(project, patch);
      return Response.json(store.requireProject(id!));
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
      const body = await parseBody(req, AnswerSchema);
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
      const { done } = await parseBody(req, TodoDoneSchema);
      if (todo.done === done) return Response.json(todo);
      return Response.json(await orch.setTodoDone(id!, done));
    }),
    route("GET", "/api/files/:id/artifact", async (_req, _url, [id]) => {
      // JSON 으로만 준다. 이 출처의 문서로 열리면 스크립트가 접속 코드에 닿는다. 화면은 /artifact-frame 격리 칸에 넣는다.
      return Response.json({ html: await artifactHtml(ctx, id!) }, { headers: { "Cache-Control": "no-store" } });
    }),
    route("PATCH", "/api/members/:id", async (req, _url, [id]) => {
      store.requireMember(id!);
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
    route("PUT", "/api/settings", async (req) => Response.json(await orch.updateSettings(await parseBody(req, SettingsSchema)))),
  ];
}

function agentRoutes({ store, orch }: ServerContext, member: Member): Route[] {
  const route = (method: string, path: string, handler: Handler): Route => ({ method, pattern: new RegExp(`^${path}$`), handler });
  return [
    route("GET", "/agent/tools", async () => Response.json(await orch.listAgentTools(member))),
    route("POST", "/agent/tool", async (req) => {
      const { name, args } = await parseBody(req, AgentToolSchema);
      store.touchMember(member.id);
      orch.noteManualCall?.(member, name);
      return Response.json(await orch.handleAgentTool(member, name, args ?? {}, req.signal));
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

export async function startServer(ctx: ServerContext): Promise<RunningServer> {
  const { config, store, bus } = ctx;
  const ipRule = buildIpRule(config.hosts);
  const hosts: string[] = [];
  let boundPort = 0;
  const routes = apiRoutes(ctx, () => reachableUrls(hosts, boundPort));
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

  const route = (req: Request, url: URL, server: Server<undefined>): Response | Promise<Response> | undefined => {
    const path = url.pathname;
    if (path === "/api/health") return Response.json({ ok: true, version: VERSION });
    if (path === "/ws") {
      if (!hasAccessCode(req, url, true)) return fail(401, "인증이 필요합니다");
      return server.upgrade(req) ? undefined : fail(400, "WebSocket 요청이 아닙니다");
    }
    // 코드가 틀려 나가는 기기도 지울 수 있어야 하므로 인증 앞에 둔다. 지우기뿐이고 바깥 사이트는 Origin 검사에 걸린다.
    if (path === "/api/files-session" && req.method === "DELETE") {
      return new Response(null, { status: 204, headers: { "Set-Cookie": filesCookie(url, "", 0) } });
    }
    if (path.startsWith("/api/")) {
      if (!hasAccessCode(req, url, false)) return fail(401, "인증이 필요합니다");
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

  const handle = async (req: Request, server: Server<undefined>): Promise<Response | undefined> => {
    if (!isIpAllowed(server.requestIP(req)?.address, ipRule)) return fail(403, "허용되지 않은 주소입니다");
    if (!isHostAllowed(req.headers.get("host"), config.hosts)) return fail(403, "허용되지 않은 주소입니다");
    if (!originMatchesHost(req)) return fail(403, "허용되지 않은 출처입니다");
    try {
      const url = new URL(req.url);
      return await route(req, url, server);
    } catch (e) {
      if (e instanceof ApiError) return fail(e.status, e.message);
      console.error("요청 처리 오류:", req.method, req.url, e);
      return fail(500, e instanceof Error ? e.message : "서버 오류");
    }
  };

  const serve = (hostname: string, port: number): Server<undefined> =>
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
        "/ws": handle,
        ...(webIndex && !webOrigin ? { "/*": webIndex } : {}),
      } as Record<string, Bun.HTMLBundle | typeof handle>,
      fetch: handle as (req: Request, server: Server<undefined>) => Promise<Response>,
      websocket: {
        open(ws) {
          ws.subscribe(WS_TOPIC);
          ws.send(JSON.stringify({ type: "hello", seq: bus.seq }));
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
  const open = (host: string) => {
    try {
      servers.push(serve(host, port));
      hosts.push(host);
    } catch (e) {
      // Tailscale 이 꺼져 주소가 사라졌어도 로컬은 떠야 한다.
      console.warn(`${host}:${port} 에서 열지 못했습니다:`, (e as Error).message);
    }
  };
  for (const host of otherHosts) open(host);

  // 로그인 직후 launchd 로 뜨면 Tailscale 이 아직 안 올라왔을 수 있다. 다시 켜지 않아도 폰에서 닿아야 한다.
  const detect = ctx.detectHosts ?? (() => {
    const ip = detectTailscaleIp();
    return ip ? [ip] : [];
  });
  const syncHosts = () => {
    if (!config.hostsAuto) return;
    for (const host of detect()) if (!hosts.includes(host)) open(host);
  };
  const hostTimer = setInterval(syncHosts, HOST_SYNC_MS);
  hostTimer.unref?.();
  // 화면이 조용히 죽은 소켓을 알아채는 신호. 망이 바뀌면 소켓은 닫히지 않고 그냥 멈춘다.
  const pingTimer = setInterval(() => {
    const payload = JSON.stringify({ type: "ping" });
    for (const server of servers) server.publish(WS_TOPIC, payload);
  }, WS_PING_MS);
  pingTimer.unref?.();

  const unsubscribe = bus.subscribe((event) => {
    const payload = JSON.stringify(event);
    for (const server of servers) server.publish(WS_TOPIC, payload);
  });

  return {
    port,
    hosts,
    urls: hosts.map((h) => `http://${h.includes(":") ? `[${h}]` : h}:${port}`),
    syncHosts,
    async stop() {
      clearInterval(hostTimer);
      clearInterval(pingTimer);
      unsubscribe();
      await Promise.all(servers.map((s) => s.stop(true)));
      await webServer?.stop(true);
    },
  };
}
