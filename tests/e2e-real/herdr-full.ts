// 실제 Claude(haiku) + 격리 herdr 서버 전 과정. 토큰을 쓰므로 직접 켤 때만 돈다.
//   IAMCEO_E2E_REAL=1 bun tests/e2e-real/herdr-full.ts
// 이름이 *.test.ts 가 아니라 기본 bun test 에는 잡히지 않는다.
// 라이브 herdr 는 session.snapshot 읽기만 한다. 임시 폴더는 지우지 않는다.
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Decision, Member, Message, ProjectState } from "../../shared/types.ts";
import { rpc } from "../../server/runner/herdr-client.ts";
import { inputLooksEmpty } from "../../server/runner/herdr.ts";
import { transcriptPath } from "../../server/runner/transcript.ts";
import { assertIsolatedSocket, startIsolatedHerdr, type IsolatedHerdr } from "../fixtures/herdr-harness.ts";

if (process.env.IAMCEO_E2E_REAL !== "1") {
  console.log("건너뜀: IAMCEO_E2E_REAL=1 일 때만 실제 Claude 로 돈다");
  process.exit(0);
}

const ROOT = resolve(import.meta.dir, "..", "..");
const LIVE_SOCKET = join(homedir(), ".config", "herdr", "herdr.sock");
const STEP_MS = 180_000;
const MODEL = "haiku";

const results: { name: string; ok: boolean; detail: string }[] = [];
const started = Date.now();
const stamp = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s`;
const log = (...a: unknown[]) => console.log(stamp(), ...a);

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  log(ok ? "PASS" : "FAIL", name, detail ? `| ${detail}` : "");
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = STEP_MS): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
      last = null;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(500);
  }
  throw new Error(`시간 초과: ${what}${last ? ` (${String(last)})` : ""}`);
}

async function liveIds(): Promise<{ panes: string[]; agents: string[] }> {
  const r = await rpc<{ snapshot: { panes: { pane_id: string }[]; agents: { pane_id: string }[] } }>(LIVE_SOCKET, "session.snapshot", {}, 8000);
  return { panes: r.snapshot.panes.map((p) => p.pane_id).sort(), agents: r.snapshot.agents.map((a) => a.pane_id).sort() };
}

// ---- 준비 ----
const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-real-home-")));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-real-proj-")));
const legacyCwd = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-real-legacy-")));
spawnSync("git", ["init", "-q"], { cwd });
log("IAMCEO_HOME", home);
log("project", cwd);

let herdr: IsolatedHerdr;
let server: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let base = "";
let code = "";
let projectId = "";

const call = <T = any>(m: string, p: Record<string, unknown> = {}, t = 8000) => rpc<T>(herdr.socketPath, m, p, t);

async function bootServer(): Promise<void> {
  // 서버는 일부러 이 세션의 오염된 환경(HERDR_*, CLAUDECODE)을 물려받는다. 어댑터가 무시해야 한다.
  server = Bun.spawn(["bun", join(ROOT, "bin", "iamceo.ts"), "serve"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, IAMCEO_TEST: "1", IAMCEO_HOME: home, IAMCEO_PORT: String(port), IAMCEO_HERDR_SOCKET: herdr.socketPath } as Record<string, string>,
  });
  void pipeLog(server.stdout as ReadableStream<Uint8Array>);
  void pipeLog(server.stderr as ReadableStream<Uint8Array>);
  await waitFor("서버 health", async () => (await fetch(`${base}/api/health`)).ok, 20_000);
}

async function pipeLog(stream: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    for (const line of decoder.decode(chunk).split("\n")) if (line.trim()) log("  [server]", line.slice(0, 300));
  }
}

async function stopServer(): Promise<void> {
  if (!server) return;
  server.kill("SIGTERM");
  await server.exited;
  server = null;
}

async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${code}`, "Content-Type": "application/json" },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const state = () => api<ProjectState>(`/api/projects/${projectId}/state`);
const memberOf = async (pick: (m: Member) => boolean) => (await state()).members.find(pick) ?? null;
const screenOf = async (m: Member) => (await api<{ text: string }>(`/api/members/${m.id}/screen`)).text;
const say = (text: string, target?: Member) => api<Message>(`/api/projects/${projectId}/messages`, { body: { id: crypto.randomUUID(), text, targetMemberId: target?.id ?? null } });

function tail(s: string, n = 12): string {
  return s.split("\n").filter((l) => l.trim()).slice(-n).join("\n");
}

/** 세션 기록에서 쓴 도구 이름과 사용자 입력을 뽑는다. */
function sessionLog(sessionId: string, dir = cwd): { tools: string[]; prompts: string[]; boundaries: number } {
  const path = transcriptPath(dir, sessionId);
  if (!existsSync(path)) return { tools: [], prompts: [], boundaries: 0 };
  const tools: string[] = [];
  const seenTools = new Set<string>();
  const prompts: string[] = [];
  let boundaries = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.subtype === "compact_boundary") boundaries++;
    if (e.isSidechain) continue;
    const content = e.message?.content;
    if (e.type === "assistant" && Array.isArray(content)) for (const c of content) if (c.type === "tool_use" && !seenTools.has(c.id)) { seenTools.add(c.id); tools.push(c.name); }
    if (e.type === "user" && !e.isMeta) {
      if (typeof content === "string") prompts.push(content);
      else if (Array.isArray(content)) for (const c of content) if (c.type === "text") prompts.push(c.text);
    }
  }
  return { tools, prompts, boundaries };
}

// 앞쪽 프로세스 목록에는 claude 가 띄운 MCP 브리지도 섞여 나온다.
const claudeProc = (info: any) => (info.process_info.foreground_processes ?? []).find((p: any) => p.name === "claude" || p.argv0 === "claude");
const paneCommand = (info: any): string => claudeProc(info)?.cmdline ?? "";

function psEnv(pid: number): Record<string, string> {
  const out = spawnSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
  return Object.fromEntries([...out.matchAll(/\b((?:HERDR|CLAUDE|IAMCEO)[A-Z_]*)=(\S*)/g)].map((m) => [m[1]!, m[2]!]));
}

type Layout = { type: "pane"; pane_id: string } | { type: "split"; direction: string; ratio: number; first: Layout; second: Layout };
const layoutOf = async (tabId: string) => (await call<{ layout: { root: Layout } }>("layout.export", { tab_id: tabId })).layout.root;
const shape = (n: Layout): string => n.type === "pane" ? n.pane_id : `(${shape(n.first)} ${n.direction} ${shape(n.second)})`;
function herdrCli(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_"))) as Record<string, string>;
  const r = spawnSync("herdr", ["--session", herdr.name, ...args], { encoding: "utf8", env });
  return `${r.stdout}${r.stderr}`;
}

const failFast: string[] = [];
async function step(name: string, fn: () => Promise<void>, opts: { fatal?: boolean } = {}): Promise<void> {
  log(`--- ${name}`);
  try {
    await fn();
  } catch (e) {
    check(name, false, String(e));
    try {
      for (const m of (await state()).members) log(`  화면 ${m.name}(${m.status}):\n${tail(await screenOf(m), 15)}`);
    } catch { /* 서버가 내려간 단계 */ }
    if (opts.fatal) failFast.push(name);
  }
}

const liveBefore = await liveIds();
log("라이브 전", `칸 ${liveBefore.panes.length}, 에이전트 ${liveBefore.agents.length}`);

herdr = await startIsolatedHerdr({ realClaude: true });
assertIsolatedSocket(herdr.socketPath);
log("격리 서버", herdr.name);

const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
port = probe.port!;
await probe.stop(true);
base = `http://127.0.0.1:${port}`;

let conductor!: Member;
let worker!: Member;
let tabId = "";
let workerSession = "";
let conductorSession = "";

async function waitIdle(m: Member, ms = STEP_MS): Promise<Member> {
  // 턴 끝 처리로 대기열이 있으면 다시 일하므로 잠시 지나도 idle/waiting 인지 본다.
  // 총괄의 대기열에는 깨우지 않는 알림(wake=false)이 남아 있을 수 있어 직원만 대기열을 본다.
  const settled = (x: Member | null) => !!x && ["idle", "waiting"].includes(x.status) && (m.kind !== "worker" || x.queuedCount === 0);
  return waitFor(`${m.name} 쉼`, async () => {
    if (!settled(await memberOf((x) => x.id === m.id))) return null;
    await Bun.sleep(2500);
    const again = await memberOf((x) => x.id === m.id);
    return settled(again) ? again : null;
  }, ms);
}

async function run(): Promise<void> {
  await step("서버 켜기", async () => {
    // 접속 코드를 먼저 알아야 하므로 config 를 만든 뒤 띄운다.
    const { loadConfig } = await import("../../server/config.ts");
    code = loadConfig({ ...process.env, IAMCEO_HOME: home } as NodeJS.ProcessEnv).accessCode;
    await bootServer();
    const boot = await api("/api/bootstrap");
    check("herdr 감지", boot.herdr.running && boot.herdr.protocol === 22, JSON.stringify(boot.herdr));
  }, { fatal: true });
  if (failFast.length) return;

  await step("프로젝트 + 첫 메시지 → 워크스페이스·칸", async () => {
    await api("/api/settings", { method: "PUT", body: { backend: "herdr", permissionMode: "default", ranks: { manager: { model: MODEL }, lead: { model: MODEL }, staff: { model: MODEL } } } });
    const p = await api("/api/projects", { body: { name: "실험", cwd } });
    projectId = p.id;
    const msg = await say("직원 민수(역할: 확인 담당)를 추가해서, 대표에게 빨강과 파랑 중 색을 고르게 물어보게 하세요. 답을 받으면 그 직원은 완료 보고만 하면 됩니다. 파일 작업은 없습니다.");
    conductor = await waitFor("총괄 칸", () => memberOf((m) => m.kind === "conductor" && !!m.paneId && !!m.sessionId));
    conductorSession = conductor.sessionId!;
    const s = await state();
    tabId = s.project.herdrTabId!;
    const snap = (await call("session.snapshot")).snapshot;
    check("워크스페이스 생성", snap.workspaces.some((w: any) => w.label === "실험") && !!tabId, `tab=${tabId} pane=${conductor.paneId}`);
    check("herdr CLI 로 보임", herdrCli("pane", "list").includes(conductor.paneId!), tail(herdrCli("pane", "list"), 3).slice(0, 300));
    const info = await call("pane.process_info", { pane_id: conductor.paneId });
    const cmd = paneCommand(info);
    log("  총괄 argv:", cmd);
    check("argv: 마지막 --permission-mode 가 지정값", /--permission-mode default(\s|$)/.test(cmd) && cmd.lastIndexOf("--permission-mode default") > cmd.lastIndexOf("--permission-mode bypassPermissions"), cmd.slice(0, 120));
    check("argv: 시작 옵션", ["--session-id", "--mcp-config", "--append-system-prompt-file", "--allowedTools mcp__iamceo", "--model haiku"].every((x) => cmd.includes(x)));

    const env = psEnv(claudeProc(info).pid);
    log("  총괄 환경 키:", Object.keys(env).join(" "));
    check("환경: 시험 세션 CLAUDE_* 안 샘", !["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION"].some((k) => k in env));
    check("환경: HERDR_SOCKET_PATH 가 격리 서버", env.HERDR_SOCKET_PATH === herdr.socketPath, env.HERDR_SOCKET_PATH);

    // git 저장소를 처음 열면 폴더 신뢰 창이 뜬다. 서버는 대신 고르지 않고 blocked 로 알린다. 여기서는 시험이 사용자 역할로 고른다.
    const c0 = await waitFor("총괄 blocked", () => memberOf((m) => m.id === conductor.id && m.status === "blocked"), 30_000);
    const trustScreen = await screenOf(c0);
    check("신뢰 창: blocked 로 표시", /Yes, I trust this folder/.test(trustScreen));
    check("신뢰 창: 입력칸으로 오인 안 함", inputLooksEmpty(trustScreen) !== true, String(inputLooksEmpty(trustScreen)));
    const held0 = await waitFor("첫 메시지 보류", async () => {
      const m = (await state()).messages.find((x) => x.id === msg.id);
      return m?.delivery === "held" ? m : null;
    }, 30_000);
    check("신뢰 창: 첫 메시지 보류", held0.delivery === "held", held0.deliveryNote ?? "");
    const act0 = await api<any[]>(`/api/members/${conductor.id}/activity?limit=20`);
    check("신뢰 창: 활동에 안내", act0.some((a) => a.text.includes("폴더 신뢰")), act0.map((a) => a.text).join(" / ").slice(0, 200));
    await call("agent.send_keys", { target: conductor.paneId, keys: ["Down", "Enter"] });
    const agent = await waitFor("훅 세션 보고", async () => {
      const a = (await call("agent.get", { target: conductor.paneId })).agent;
      return a.agent_session?.value ? a : null;
    }, 30_000);
    check("훅이 세션 ID 를 격리 서버에 보고", agent.agent_session.value === conductorSession && agent.agent_session.source === "herdr:claude", JSON.stringify(agent.agent_session));

    const seen = await waitFor("총괄에 전달", async () => {
      const m = (await state()).messages.find((x) => x.id === msg.id);
      return m?.delivery === "delivered" ? m : null;
    }).catch(() => null);
    log("  메시지 전달 상태:", seen?.delivery ?? (await state()).messages.find((x) => x.id === msg.id)?.delivery);
    const prompts = await waitFor("총괄 기록에 입력", () => {
      const l = sessionLog(conductorSession);
      return l.prompts.some((x) => x.includes("[대표]") && x.includes(`#${msg.id}`)) ? l : null;
    });
    check("입력이 §4 형식으로 들어감", true, prompts.prompts.at(-1)!.slice(0, 80));
  }, { fatal: true });
  if (failFast.length) return;

  await step("team_add → 직원 칸(위 줄 직원, 아래 총괄)", async () => {
    worker = await waitFor("직원 칸", () => memberOf((m) => m.kind === "worker" && !!m.paneId && !!m.sessionId));
    workerSession = worker.sessionId!;
    log("  직원:", worker.name, worker.handle, worker.paneId);
    const root = await layoutOf(tabId);
    log("  배치:", shape(root));
    check("배치: 위 직원 / 아래 총괄", root.type === "split" && root.direction === "down" && root.first.type === "pane" && root.first.pane_id === worker.paneId && root.second.type === "pane" && root.second.pane_id === conductor.paneId, shape(root));
    // 칸은 도구 결과가 기록되기 전에 뜬다.
    const tools = await waitFor("기록에 team_add", () => {
      const t = sessionLog(conductorSession).tools;
      return t.some((x) => x.endsWith("team_add")) ? t : null;
    }, 30_000);
    log("  총괄 도구:", tools.join(","));
    check("총괄: team_add 를 씀", true);
    check("총괄: 직접 일 안 함(Bash/Edit/Write 없음)", !tools.some((t) => ["Bash", "Edit", "Write"].includes(t)));
    check("총괄: AskUserQuestion 안 씀", !tools.includes("AskUserQuestion"));
  }, { fatal: true });
  if (failFast.length) return;

  let decision!: Decision;
  await step("ask → 결재 카드 + 대기", async () => {
    decision = await waitFor("결재 카드", async () => (await state()).decisions.find((d) => d.status === "open"));
    log("  카드:", decision.title, JSON.stringify(decision.options.map((o) => o.label)));
    check("카드: 물은 직원이 직원", decision.memberId === worker.id);
    check("카드: 선택지 있음", decision.options.length >= 2);
    const m = await waitFor("직원 waiting", () => memberOf((x) => x.id === worker.id && x.status === "waiting"));
    const tools = sessionLog(workerSession).tools;
    log("  직원 도구(기록 지연 가능):", tools.join(","));
    check("직원 상태 waiting", m.status === "waiting");
    check("직원: AskUserQuestion 안 씀", !tools.includes("AskUserQuestion"));
    const scr = await screenOf(m);
    check("입력칸 판별(실제 화면, 대기 중): 비어 있음", inputLooksEmpty(scr) === true, tail(scr, 6));
    const withPct = await waitFor("턴 끝 문맥 %", () => memberOf((x) => x.id === worker.id && x.contextPct !== null), 60_000);
    check("문맥 % 기록(직원, 턴 끝)", withPct.contextPct! > 0, `pct=${withPct.contextPct} 상태 ${withPct.status}`);
    const after = sessionLog(workerSession).tools;
    check("직원: ask 를 씀", after.some((t) => t.endsWith("__ask")), after.join(","));
  }, { fatal: true });
  if (failFast.length) return;

  let color = "";
  await step("답 전달 → post → 대화 표시", async () => {
    const opt = decision.options.find((o) => /파랑/.test(o.label)) ?? decision.options[0]!;
    color = opt.label;
    await api(`/api/decisions/${decision.id}/answer`, { body: { choice: opt.k, note: "시험" } });
    const fromWorker = await waitFor("직원 완료 보고", async () => (await state()).messages.find((x) => x.memberId === worker.id && x.kind === "완료"));
    log("  보고:", fromWorker.title, "|", fromWorker.body.slice(0, 120));
    const w = await waitIdle(worker);
    const l = sessionLog(workerSession);
    check("직원 입력에 대표 답 원문", l.prompts.some((p) => p.includes("[대표 답(원문)") && p.includes(decision.id)));
    check("직원: post 를 씀", l.tools.some((t) => t.endsWith("__post")), l.tools.join(","));
    check("턴 끝 감지: 직원 idle", w.status === "idle", `status=${w.status} pct=${w.contextPct}`);
    const act = await api<any[]>(`/api/members/${worker.id}/activity?limit=50`);
    check("활동에 턴 끝", act.some((a) => a.kind === "turn_end"));
    const c = await waitIdle(conductor);
    const s = await state();
    log("  대화:", s.messages.map((x) => `${x.who}/${x.kind}: ${(x.title || x.body).slice(0, 40)}`).join(" || "));
    check("총괄 턴 끝·문맥 %", c.status === "idle" && c.contextPct !== null, `status=${c.status} pct=${c.contextPct}`);
    const d = s.decisions.find((x) => x.id === decision.id)!;
    check("결재 상태 delivered", d.status === "delivered", d.status);
  }, { fatal: true });
  if (failFast.length) return;

  await step("/compact", async () => {
    const before = sessionLog(workerSession).boundaries;
    await api(`/api/members/${worker.id}/compact`, { body: {} });
    await waitFor("compact_boundary", () => sessionLog(workerSession).boundaries > before);
    const act = await waitFor("압축 완료 활동", async () => (await api<any[]>(`/api/members/${worker.id}/activity?limit=30`)).find((a) => a.kind === "compact" && a.text === "압축 완료"));
    const w = await waitIdle(worker);
    check("압축 완료·idle", !!act && w.status === "idle", `status=${w.status} pct=${w.contextPct}`);
    check("압축 뒤 세션 ID 유지", w.sessionId === workerSession, w.sessionId ?? "");
    const a = (await call("agent.get", { target: w.paneId })).agent;
    check("압축 뒤 훅 세션 값", a.agent_session?.value === workerSession, a.agent_session?.value);
    const s = await state();
    check("압축이 대화에 턴처럼 안 올라감", !s.messages.some((x) => x.memberId === worker.id && (x.title ?? "").includes("(자동)")), s.messages.filter((x) => x.memberId === worker.id).map((x) => x.title).join(","));
  });

  await step("여러 줄 붙여넣기", async () => {
    const before = sessionLog(workerSession).prompts.length;
    const lines = Array.from({ length: 25 }, (_, i) => `${i + 1}번 줄 자료입니다`);
    const text = `아래 자료는 읽기만 하고, post 를 kind 완료, 제목 '줄 확인' 으로 한 번만 부르세요.\n${lines.join("\n")}\n마지막 표지: 사과나무`;
    const msg = await say(text, worker);
    await waitFor("완료 보고", async () => (await state()).messages.find((x) => x.memberId === worker.id && x.kind === "완료" && (x.title ?? "").includes("줄 확인")));
    const l = sessionLog(workerSession);
    const fresh = l.prompts.slice(before);
    check("여러 줄: 한 입력으로 온전히 들어감", fresh.length === 1 && fresh[0]!.includes("25번 줄") && fresh[0]!.includes("사과나무") && fresh[0]!.includes(`#${msg.id}`), `입력 ${fresh.length}개, 길이 ${fresh[0]?.length}`);
    const w = await waitIdle(worker);
    check("압축 뒤 다음 턴에 문맥 % 다시 채움", w.contextPct !== null && w.contextPct > 0, `pct=${w.contextPct}`);
  });

  await step("긴 글(>1500자) → inbox 파일", async () => {
    const before = sessionLog(workerSession).prompts.length;
    const body = Array.from({ length: 80 }, (_, i) => `${i + 1}. 긴 자료 문단입니다 ${"가나다라".repeat(5)}`).join("\n");
    const text = `첨부된 전문의 맨 끝 표지 단어를 post 제목(kind 완료)에 그대로 적으세요.\n${body}\n끝 표지: 감나무`;
    const msg = await say(text, worker);
    const inbox = await waitFor("inbox 파일", () => readdirSync(join(home, "inbox"), { recursive: true }).map(String).find((f) => f.split("/").pop()!.startsWith(msg.id)));
    check("inbox 에 저장", !!inbox, inbox);
    const blockedOrDone = await waitFor("읽기 결과", async () => {
      const s = await state();
      const w = s.members.find((x) => x.id === worker.id)!;
      if (w.status === "blocked") return "blocked";
      return s.messages.find((x) => x.memberId === worker.id && x.kind === "완료" && (x.title ?? "").includes("감나무")) ? "done" : null;
    });
    const fresh = sessionLog(workerSession).prompts.slice(before);
    check("긴 글: 경로만 입력에 들어감", fresh.some((p) => p.includes(inbox!) && p.length < 1000), `길이 ${fresh[0]?.length}`);
    check("긴 글: inbox 파일을 승인 창 없이 읽음(default 모드)", blockedOrDone === "done", blockedOrDone);
    if (blockedOrDone === "blocked") {
      log("  승인 창:\n" + tail(await screenOf(worker), 16));
      await call("agent.send_keys", { target: worker.paneId, keys: ["Enter"] });
    }
    await waitIdle(worker);
  });

  await step("병렬 켜고 끄기(team_assign parallel, /effort ultracode)", async () => {
    const db = new Database(join(home, "iamceo.db"), { readonly: true });
    const token = (db.query("SELECT token FROM members WHERE id = ?").get(conductor.id) as { token: string }).token;
    db.close();
    const tool = async (name: string, args: unknown) => {
      const r = await fetch(`${base}/agent/tool`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, args }) });
      if (!r.ok) throw new Error(`${name} ${r.status}: ${await r.text()}`);
      return r.json();
    };
    await tool("team_assign", { member: worker.handle, text: "도구를 더 쓰지 말고 post 를 kind 완료, 제목 '병렬 켜짐 확인' 으로 한 번만 부르세요.", parallel: true });
    await waitFor("parallel=true", () => memberOf((m) => m.id === worker.id && m.parallel));
    const scr = tail(await screenOf(worker), 40);
    check("/effort 응답을 화면에서 판별", /Ultracode on/.test(scr), scr.split("\n").find((l) => /Ultracode/.test(l)) ?? "");
    await waitFor("병렬 완료 보고", async () => (await state()).messages.find((x) => x.memberId === worker.id && (x.title ?? "").includes("병렬 켜짐")));
    await waitIdle(worker);
    await tool("team_assign", { member: worker.handle, text: "도구를 더 쓰지 말고 post 를 kind 완료, 제목 '병렬 꺼짐 확인' 으로 한 번만 부르세요.", parallel: false });
    await waitFor("parallel=false", () => memberOf((m) => m.id === worker.id && !m.parallel));
    await waitFor("끔 보고", async () => (await state()).messages.find((x) => x.memberId === worker.id && (x.title ?? "").includes("병렬 꺼짐")));
    const act = await api<any[]>(`/api/members/${worker.id}/activity?limit=50`);
    check("병렬 활동 기록", act.some((a) => a.text === "병렬 켬") && act.some((a) => a.text === "병렬 끔"));
    check("병렬 설정 실패 없음", !act.some((a) => /병렬 설정 실패/.test(a.text)), act.filter((a) => /병렬 설정 실패/.test(a.text)).map((a) => a.text).join(";"));
    await waitIdle(worker);
    await waitIdle(conductor);
  });

  await step("승인 창 → blocked 표시·보류·해제 (alias 가 이기면 창이 안 뜬다)", async () => {
    const proof = join(cwd, "blocked-proof.txt");
    const first = await say(`Bash 도구로 touch ${proof} 를 실행하고, 끝나면 post 를 kind 완료, 제목 '승인 확인' 으로 부르세요.`, worker);
    const w = await waitFor("직원 blocked", () => memberOf((m) => m.id === worker.id && m.status === "blocked"), 120_000);
    check("상태 blocked (지정 권한 모드가 alias 를 이김)", w.status === "blocked" && !existsSync(proof));
    const scr = await screenOf(w);
    log("  승인 창:\n" + tail(scr, 14));
    check("승인 창 화면은 입력칸 비었다고 안 나옴", inputLooksEmpty(scr) !== true, String(inputLooksEmpty(scr)));
    log("  첫 메시지 전달:", (await state()).messages.find((x) => x.id === first.id)?.delivery);
    const second = await say("앞 일이 끝나면 post 를 kind 알림, 제목 '보류 뒤 전달' 로 한 번 부르세요.", worker);
    const held = await waitFor("두 번째 보류", async () => {
      const m = (await state()).messages.find((x) => x.id === second.id);
      return m && m.delivery === "held" ? m : null;
    }, 30_000).catch(() => null);
    log("  두 번째 전달:", (await state()).messages.find((x) => x.id === second.id)?.delivery, (await state()).messages.find((x) => x.id === second.id)?.deliveryNote);
    check("blocked 중 입력은 보류", !!held);
    await call("agent.send_keys", { target: w.paneId, keys: ["Enter"] });
    await waitFor("파일 생김", () => existsSync(proof), 60_000);
    check("창 해제 후 진행", true);
    await waitFor("보류 글 전달", async () => (await state()).messages.find((x) => x.memberId === worker.id && (x.title ?? "").includes("보류 뒤 전달")));
    check("보류 글이 이어서 전달됨", true);
    const after = await waitIdle(worker);
    check("해제 뒤 idle", after.status === "idle", after.status);
    await waitIdle(conductor);
  });

  await step("입력칸에 남은 글은 지우고 전달(글 안 섞임, 세션 유지)", async () => {
    await call("pane.send_text", { pane_id: worker.paneId, text: "abc" });
    await Bun.sleep(500);
    check("친 글을 입력칸에서 알아봄", inputLooksEmpty(await screenOf(worker)) === false);
    const msg = await say("도구는 post 만 쓰세요. post 를 kind 완료, 제목 '남은 글 지운 뒤' 로 한 번 부르세요.", worker);
    await waitFor("지운 뒤 전달", async () => (await state()).messages.find((x) => x.memberId === worker.id && (x.title ?? "").includes("남은 글 지운 뒤")), 120_000);
    check("남은 글 없이 전달됨(글 안 섞임)", !sessionLog(workerSession).prompts.some((p) => p.includes("abc")), String((await state()).messages.find((x) => x.id === msg.id)?.delivery));
    const live = (await call("agent.get", { target: worker.paneId })).agent;
    check("지우는 키 뒤에도 세션 유지", live.agent === "claude" && live.agent_session?.value === workerSession, JSON.stringify(live.agent_session));
    await waitIdle(worker);
    await waitIdle(conductor);
  });

  await step("잠재우기 → 칸 닫힘, 세션 유지", async () => {
    const pane = worker.paneId;
    const slept = await api<Member>(`/api/members/${worker.id}/sleep`, { body: {} });
    check("상태 asleep, 세션 유지", slept.status === "asleep" && slept.sessionId === workerSession, `${slept.status} ${slept.sessionId}`);
    const snap = (await call("session.snapshot")).snapshot;
    check("칸 닫힘", !snap.panes.some((p: any) => p.pane_id === pane));
    const root = await layoutOf(tabId);
    check("남은 배치: 총괄만", root.type === "pane" && root.pane_id === conductor.paneId, shape(root));
  });

  await step("다시 열기 → --resume, 문맥 이어짐", async () => {
    const reopened = await api<Member>(`/api/members/${worker.id}/resume`, { body: {} });
    check("세션 ID 그대로", reopened.sessionId === workerSession && !!reopened.paneId, `${reopened.sessionId} ${reopened.paneId}`);
    worker = reopened;
    const cmd = paneCommand(await call("pane.process_info", { pane_id: reopened.paneId }));
    check("argv 에 --resume <세션>", cmd.includes(`--resume ${workerSession}`), cmd.slice(0, 140));
    const root = await layoutOf(tabId);
    check("배치 복원: 위 직원 / 아래 총괄", root.type === "split" && root.direction === "down" && root.first.type === "pane" && root.first.pane_id === reopened.paneId, shape(root));
    await say("도구는 post 만 쓰세요. 아까 대표가 고른 색 이름을 post 제목(kind 완료)에 적으세요.", worker);
    const m = await waitFor("색 보고", async () => (await state()).messages.find((x) => x.memberId === worker.id && x.kind === "완료" && (x.title ?? "").includes(color.replace(/\s.*/, ""))));
    check("resume 뒤 문맥 유지(압축 요약 포함)", true, m.title);
    worker = await waitIdle(worker);
  });

  await step("서버 재시작 → 재결합(턴 도중 내렸다 올림)", async () => {
    const proof = `재시작 확인 ${Math.random().toString(36).slice(2, 7)}`;
    await say(`먼저 2초 뒤에 할 일이 있다고 치고, post 를 kind 완료, 제목 '${proof}' 로 한 번 부르세요.`, worker);
    await waitFor("직원 working", () => memberOf((m) => m.id === worker.id && m.status === "working"), 30_000).catch(() => null);
    await stopServer();
    log("  서버 내림. 칸은 남아야 함");
    const snap = (await call("session.snapshot")).snapshot;
    check("서버 내려도 칸 유지", snap.agents.some((a: any) => a.pane_id === worker.paneId) && snap.agents.some((a: any) => a.pane_id === conductor.paneId));
    await Bun.sleep(1500);
    await bootServer();
    const w = await waitIdle(worker);
    const s = await state();
    check("재결합: 같은 칸·세션", w.paneId === worker.paneId && w.sessionId === workerSession, `${w.paneId} ${w.status}`);
    check("재결합: 총괄도", s.members.find((m) => m.kind === "conductor")?.paneId === conductor.paneId);
    const posted = s.messages.some((x) => (x.title ?? "").includes(proof));
    log("  턴 도중 post 도달:", posted);
    await waitIdle(conductor);
    const before = (await state()).messages.length;
    await say("도구는 post 만 쓰세요. post 를 kind 완료, 제목 '재결합 뒤 동작' 으로 한 번 부르세요.", worker);
    const m = await waitFor("재결합 뒤 보고", async () => (await state()).messages.slice(before - 1).find((x) => x.memberId === worker.id && (x.title ?? "").includes("재결합 뒤")));
    check("재결합 뒤 전달·MCP·턴 감지", !!m);
    worker = await waitIdle(worker);
    check("재결합 뒤 턴 끝 idle", worker.status === "idle", worker.status);
    await waitIdle(conductor);
  });

  await step("기존 칸 편입(adopt)", async () => {
    const w = await call("workspace.create", { cwd: legacyCwd, label: "예전칸", focus: false });
    const pane = w.root_pane.pane_id as string;
    const sess = crypto.randomUUID();
    const started = await call("agent.start", { name: "legacy", kind: "claude", pane_id: pane, args: ["--session-id", sess, "-n", "예전", "--permission-mode", "default", "--model", MODEL], timeout_ms: 60_000 }, 70_000);
    log("  편입 대상 argv:", JSON.stringify(started.argv));
    await waitFor("대상 준비", async () => (await call("agent.get", { target: pane })).agent.agent_status === "idle", 60_000);
    const pid = claudeProc(await call("pane.process_info", { pane_id: pane })).pid;
    const agents = await api<any[]>("/api/herdr/agents");
    check("목록에 보임", agents.some((a) => a.paneId === pane && a.sessionId === sess), `${agents.length}개`);
    const adopted = await api<Member>(`/api/projects/${projectId}/adopt`, { body: { paneId: pane, name: "옛칸", role: "편입 확인" } });
    log("  편입:", adopted.paneId, adopted.sessionId, adopted.status);
    check("세션 유지·origin", adopted.sessionId === sess && adopted.origin === "adopted");
    check("칸을 옮기지 않음", adopted.paneId === pane && (await call("agent.get", { target: pane })).agent.tab_id === w.tab.tab_id);
    check("칸 이름을 바꾸지 않음", (await call("agent.get", { target: pane })).agent.name === "legacy");
    const pid2 = claudeProc(await call("pane.process_info", { pane_id: pane })).pid;
    check("프로세스 유지", pid === pid2, `${pid} -> ${pid2}`);
    const root = await layoutOf(tabId);
    log("  배치:", shape(root));
    check("배치: 프로젝트 탭 그대로", root.type === "split" && root.direction === "down" && root.second.type === "pane" && root.second.pane_id === conductor.paneId, shape(root));
    await waitFor("규칙 전달", () => sessionLog(sess, legacyCwd).prompts.some((p) => p.includes("[시스템]") || p.includes("inbox")), 60_000);
    const done = await waitIdle(adopted);
    const l = sessionLog(sess, legacyCwd);
    log("  편입 세션 도구:", l.tools.join(","));
    const s = await state();
    const said = s.messages.filter((x) => x.memberId === adopted.id);
    log("  편입 세션 말:", said.map((x) => `${x.kind}: ${(x.title || x.body).slice(0, 80)}`).join(" || "));
    check("편입 세션 턴 끝 처리", done.status === "idle" && said.length > 0, done.status);
    check("편입 세션: 승인 창 없이 규칙 파일을 읽음(/add-dir)", l.tools.includes("Read"), l.tools.join(","));
    check("편입 세션: 없는 도구를 찾아 헤매지 않음", !l.tools.includes("ToolSearch"), l.tools.join(","));
  });
}

let thrown: unknown = null;
try {
  await run();
} catch (e) {
  thrown = e;
}

// ---- 정리 ----
try { if (projectId) log("최종 대화:\n" + (await state()).messages.map((m) => `  ${m.who}/${m.kind}[${m.delivery ?? ""}]: ${(m.title || m.body).slice(0, 70)}`).join("\n")); } catch { /* 서버 내려감 */ }
await stopServer();
await herdr.stop();
const sessions = spawnSync("herdr", ["session", "list"], { encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_"))) as Record<string, string> }).stdout ?? "";
check("격리 세션 지워짐", !sessions.includes(herdr.name));

const liveAfter = await liveIds();
log("라이브 후", `칸 ${liveAfter.panes.length}, 에이전트 ${liveAfter.agents.length}`);
check("라이브 칸 ID 동일", JSON.stringify(liveBefore.panes) === JSON.stringify(liveAfter.panes), `전 ${liveBefore.panes.length} 후 ${liveAfter.panes.length}`);
check("라이브 에이전트 칸 동일", JSON.stringify(liveBefore.agents) === JSON.stringify(liveAfter.agents), `전 ${liveBefore.agents.length} 후 ${liveAfter.agents.length}`);

if (thrown) log("예외:", thrown);
const failed = results.filter((r) => !r.ok);
console.log(`\n결과: 통과 ${results.length - failed.length}, 실패 ${failed.length}`);
for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail.slice(0, 400)}`);
process.exit(failed.length || thrown ? 1 : 0);
