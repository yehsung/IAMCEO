// 실제 claude(haiku) + 실제 서버 프로세스 + 실제 MCP 브리지. herdr 없음(headless). 돈이 든다.
// 실행: IAMCEO_E2E_REAL=1 bun tests/e2e-real/headless.ts
// 파일 이름이 *.test.ts 가 아니라 기본 bun test 에는 잡히지 않고, 변수 없이 부르면 바로 끝난다.
// 임시 폴더는 지우지 않는다. 끝나면 서버는 끈다. 호출별 인자·환경 이름·출력은 <out>/calls 에 남는다.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { $ } from "bun";
import type { Decision, Member, Message, Project, ProjectState } from "../../shared/types.ts";

if (process.env.IAMCEO_E2E_REAL !== "1") {
  console.log("건너뜀: IAMCEO_E2E_REAL=1 일 때만 실제 claude 로 돈다");
  process.exit(0);
}

const ROOT = resolve(import.meta.dir, "..", "..");
const REAL_CLAUDE = Bun.which("claude");
if (!REAL_CLAUDE) throw new Error("claude 를 찾지 못했습니다");
const MODEL = "haiku";
const BUDGET_USD = Number(process.env.IAMCEO_E2E_BUDGET ?? 1.5);
const TURN_MS = 240_000;

const out = mkdtempSync(join(tmpdir(), "iamceo-e2e-real-"));
const home = join(out, "home");
const calls = join(out, "calls");
const work = join(out, "work");
const hqCwd = join(out, "hq");
const newCwd = join(out, "새프로젝트");
for (const dir of [home, calls, work, hqCwd, newCwd]) mkdirSync(dir, { recursive: true });
for (const repo of [work, hqCwd]) await $`git init -q ${repo}`;

const CODE = "e2e-real-code";
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
writeFileSync(join(home, "config.json"), JSON.stringify({ accessCode: CODE, port: PORT, hosts: ["127.0.0.1"] }));

// 자식의 인자·환경 이름·stdout·stderr 를 남기고 진짜 claude 로 바꿔 탄다(exec 라 시그널이 그대로 간다).
const wrapper = join(out, "claude-wrap.sh");
writeFileSync(
  wrapper,
  `#!/bin/bash
base="$IAMCEO_E2E_CALLS/$(date +%s)-$$"
printf '%s\\0' "$@" > "$base.args"
compgen -e > "$base.envkeys"
pwd > "$base.cwd"
exec > >(tee "$base.jsonl") 2> >(tee "$base.err" >&2)
exec "$IAMCEO_E2E_REAL_CLAUDE" "$@"
`,
);
chmodSync(wrapper, 0o755);

// 서버 환경. HERDR_* 는 가짜 값으로 일부러 넣어 지워지는지 본다. 라이브 소켓 값은 어디에도 넘기지 않는다.
const serverEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: join(out, "fake-herdr.sock"),
  HERDR_PANE_ID: "fake-pane",
  HERDR_TAB_ID: "fake-tab",
  HERDR_WORKSPACE_ID: "fake-ws",
  HERDR_BIN_PATH: "/nonexistent/herdr",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_SSE_PORT: "1",
  IAMCEO_HOME: home,
  IAMCEO_CLAUDE_BIN: wrapper,
  IAMCEO_HERDR_SOCKET: join(out, "no-herdr.sock"),
  IAMCEO_TEST: "1",
  IAMCEO_E2E_CALLS: calls,
  IAMCEO_E2E_REAL_CLAUDE: REAL_CLAUDE,
};

let server: ReturnType<typeof Bun.spawn> | null = null;
const serverLog = join(out, "server.log");
async function startServer(): Promise<void> {
  server = Bun.spawn({ cmd: [process.execPath, join(ROOT, "bin", "iamceo.ts"), "serve"], cwd: ROOT, env: serverEnv, stdin: "ignore", stdout: Bun.file(`${serverLog}.${Date.now()}.out`), stderr: Bun.file(`${serverLog}.${Date.now()}.err`) });
  await until("서버 켜짐", async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok, 20_000);
}
async function stopServer(): Promise<void> {
  if (!server) return;
  server.kill("SIGTERM");
  await server.exited;
  server = null;
}

// ---- 도우미 ----
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}
const state = (id: string) => api<ProjectState>("GET", `/api/projects/${id}/state`);
const sleep = (ms: number) => Bun.sleep(ms);
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
const log = (s: string) => console.log(`${stamp()} ${s}`);

async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, ms = TURN_MS): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`시간 초과: ${what}`);
    await sleep(1000);
  }
}

/** 멤버 모두 working 이 아닌 상태가 quietMs 이어지면 끝. */
async function quiet(id: string, quietMs = 6000, ms = TURN_MS): Promise<ProjectState> {
  const end = Date.now() + ms;
  let since = Date.now();
  for (;;) {
    const s = await state(id);
    if (s.members.some((m) => m.status === "working")) since = Date.now();
    else if (Date.now() - since >= quietMs) return s;
    if (Date.now() > end) throw new Error(`시간 초과: 조용해지기 ${id}`);
    budgetGuard();
    await sleep(1000);
  }
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? "통과" : "실패"} ${name}${detail ? ` — ${detail}` : ""}`);
}

interface Call { base: string; startedAt: number; endedAt: number; args: string[]; envKeys: string[]; cwd: string; err: string; events: any[] }
function readCalls(): Call[] {
  return readdirSync(calls)
    .filter((f) => f.endsWith(".args"))
    .map((f) => {
      const base = f.slice(0, -5);
      const p = (ext: string) => join(calls, `${base}.${ext}`);
      const events = (existsSync(p("jsonl")) ? readFileSync(p("jsonl"), "utf8") : "").split("\n").filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
      return {
        base,
        startedAt: statSync(p("args")).mtimeMs,
        endedAt: existsSync(p("jsonl")) ? statSync(p("jsonl")).mtimeMs : statSync(p("args")).mtimeMs,
        args: readFileSync(p("args"), "utf8").split("\0").slice(0, -1),
        envKeys: readFileSync(p("envkeys"), "utf8").split("\n").filter(Boolean),
        cwd: readFileSync(p("cwd"), "utf8").trim(),
        err: existsSync(p("err")) ? readFileSync(p("err"), "utf8") : "",
        events,
      };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}
const argOf = (c: Call, flag: string) => {
  const i = c.args.indexOf(flag);
  return i >= 0 ? c.args[i + 1] : undefined;
};
const prompt = (c: Call) => argOf(c, "-p") ?? "";
const nameOf = (c: Call) => argOf(c, "-n") ?? "";
const toolUses = (c: Call): any[] => c.events.filter((e) => e.type === "assistant" && !e.parent_tool_use_id).flatMap((e) => (e.message?.content ?? []).filter((b: any) => b.type === "tool_use"));
const resultOf = (c: Call) => c.events.find((e) => e.type === "result");
const totalCost = () => readCalls().reduce((sum, c) => sum + (resultOf(c)?.total_cost_usd ?? 0), 0);
function budgetGuard(): void {
  const cost = totalCost();
  if (cost > BUDGET_USD) throw new Error(`예산 초과: $${cost.toFixed(3)} > $${BUDGET_USD}`);
}
const callsFor = (name: string) => readCalls().filter((c) => nameOf(c) === name);
const send = (projectId: string, text: string, targetMemberId?: string) => api<Message>("POST", `/api/projects/${projectId}/messages`, { text, targetMemberId: targetMemberId ?? null });
const memberNamed = (s: ProjectState, name: string): Member | undefined => s.members.find((m) => m.name === name);

function dumpMessages(s: ProjectState): void {
  for (const m of s.messages) console.log(`    [${m.at.slice(11, 19)}] ${m.who}/${m.kind}${m.delivery ? `/${m.delivery}` : ""} ${m.title ? `<${m.title}> ` : ""}${m.body.replace(/\s+/g, " ").slice(0, 160)}`);
}

/** 이 시험의 서버가 낳은 프로세스(환경에 호출 폴더가 있다). 서버를 끈 뒤에는 없어야 한다. */
async function ourProcesses(): Promise<string[]> {
  const text = await $`ps -Aww -E -o pid=,command=`.nothrow().quiet().text();
  return text.split("\n").filter((l) => l.includes(`IAMCEO_E2E_CALLS=${calls}`) && !l.includes("ps -Aww")).map((l) => l.trim().slice(0, 90));
}

// ---- 실제 CLI 문구 확인(모델 호출 없음) ----
async function probeCli(): Promise<void> {
  const { isMissingSessionError, childEnv } = await import("../../server/runner/headless.ts");
  const run = async (args: string[]) => {
    const p = Bun.spawn({ cmd: [REAL_CLAUDE!, "-p", "x", ...args, "--output-format", "stream-json", "--verbose", "--model", MODEL], cwd: work, env: childEnv(process.env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, o, e };
  };
  const missing = await run(["--resume", crypto.randomUUID()]);
  log(`CLI 없는 세션 resume: code=${missing.code} stderr=${JSON.stringify(missing.e.trim().slice(0, 200))} stdout=${missing.o.slice(-300).replace(/\n/g, " ")}`);
  check("판별: 없는 세션 --resume 문구", isMissingSessionError(missing.e) || isMissingSessionError(missing.o), missing.e.trim().slice(0, 120));
}

// ---- 시나리오 ----
async function main(): Promise<void> {
  console.log(`출력 폴더: ${out}`);
  await probeCli();
  await startServer();
  await api("PATCH", "/api/projects/hq", { cwd: hqCwd });
  await api("PUT", "/api/settings", { backend: "headless", permissionMode: "auto", ranks: { manager: { model: MODEL }, lead: { model: MODEL }, staff: { model: MODEL } } });

  // 1) 프로젝트 생성
  const project = await api<Project>("POST", "/api/projects", { name: "실제시험", cwd: work });
  const pid = project.id;
  check("1 프로젝트 생성", project.connection.ok, `${pid}`);
  await api("POST", `/api/projects/${pid}/conductor/start`);

  // 2) 요청
  await send(pid, "민수라는 직원을 띄워서 hello.txt 에 안녕을 쓰게 하고, 그 전에 파일 내용을 안녕으로 할지 hello로 할지 나에게 물어보게 해");
  log("2 요청 보냄");

  // 3) 총괄이 맡기는지
  const withWorker = await until("민수 등장", async () => {
    budgetGuard();
    const s = await state(pid);
    return memberNamed(s, "민수") ? s : null;
  });
  const minsu = memberNamed(withWorker, "민수")!;
  log(`3 민수 등장: ${minsu.id} handle=${minsu.handle}`);

  // 4) 직원이 ask 후 턴을 끝내는지
  const decision = await until("결재 카드", async () => {
    budgetGuard();
    const s = await state(pid);
    return s.decisions.find((d) => d.status === "open") ?? null;
  });
  log(`4 카드: ${decision.who} '${decision.title}' 선택지=${JSON.stringify(decision.options.map((o) => o.label))} rec=${decision.rec}`);
  const afterAsk = await quiet(pid);
  const leadCalls = callsFor("총괄");
  const leadTools = leadCalls.flatMap(toolUses).map((t) => t.name);
  log(`총괄 도구: ${JSON.stringify(leadTools)}`);
  check("3 총괄 team_add/assign 사용", leadTools.some((t) => t === "mcp__iamceo__team_add"), leadTools.join(","));
  check("3 총괄이 직접 일 안 함", !leadTools.some((t) => /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(t)) && !leadCalls.flatMap(toolUses).some((t) => t.name === "Bash" && /hello\.txt/.test(JSON.stringify(t.input))));
  check("4 민수가 status 를 씀", memberNamed(afterAsk, "민수")!.now.trim() !== "", JSON.stringify(memberNamed(afterAsk, "민수")!.now));
  check("3 총괄이 work_set 으로 판을 맞춤", afterAsk.work.length > 0, JSON.stringify(afterAsk.work.map((w) => `${w.sec}:${w.title}`)));
  check("4 ask 를 민수가 함", decision.memberId === minsu.id && decision.options.length >= 2, decision.who);
  check("4 ask 뒤 턴 끝(status=waiting, 파일 아직 없음)", memberNamed(afterAsk, "민수")!.status === "waiting" && !existsSync(join(work, "hello.txt")), memberNamed(afterAsk, "민수")!.status);
  const minsuFirst = callsFor("민수")[0];
  check("4 민수 인자에 지시 형식", /^\[총괄\] 민수에게\n/.test(prompt(minsuFirst!)), JSON.stringify(prompt(minsuFirst!)).slice(0, 200));
  const quoteLine = prompt(minsuFirst!).split("\n").find((l) => /사용자 요청|총괄 인용/.test(l));
  log(`민수 첫 지시 인용 줄: ${quoteLine ?? "(없음)"}`);

  // 5) 답 → 전달 → 파일 → post → 총괄 보고 → 총괄 대화
  const option = decision.options.find((o) => o.label.includes("안녕")) ?? decision.options[0]!;
  const answered = await api<Decision>("POST", `/api/decisions/${decision.id}/answer`, { choice: option.k, note: "참고로 암호는 파랑새야" });
  log(`5 답함: ${option.label} → ${answered.status}`);
  const again = await fetch(`${BASE}/api/decisions/${decision.id}/answer`, { method: "POST", headers: { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" }, body: JSON.stringify({ choice: option.k }) });
  log(`  같은 답 다시 = ${again.status}`);
  await until("hello.txt", async () => {
    budgetGuard();
    return existsSync(join(work, "hello.txt"));
  });
  const afterDone = await quiet(pid, 12_000);
  const content = readFileSync(join(work, "hello.txt"), "utf8");
  check("5 파일 내용", content.includes("안녕"), JSON.stringify(content));
  const answerCall = callsFor("민수").find((c) => prompt(c).includes("[대표 답(원문)"));
  check("5 답이 원문 그대로 민수에게", !!answerCall && prompt(answerCall).includes(`"${option.label}"`) && prompt(answerCall).includes("암호는 파랑새"), JSON.stringify(answerCall ? prompt(answerCall) : "").slice(0, 200));
  check("5 민수 post 완료", afterDone.messages.some((m) => m.who === "민수" && m.kind === "완료"));
  const reportCall = callsFor("총괄").find((c) => prompt(c).includes("[보고 민수]"));
  check("5 총괄이 보고 받음", !!reportCall, JSON.stringify(reportCall ? prompt(reportCall) : "").slice(0, 200));
  const leadToBoss = afterDone.messages.filter((m) => m.who === "총괄" && !m.mine);
  check("5 총괄이 대표에게 말함", leadToBoss.length > 0, leadToBoss.map((m) => `${m.kind}:${m.title}${m.body}`.replace(/\s+/g, " ").slice(0, 100)).join(" | "));
  check("5 일 항목이 완료로", afterDone.work.some((w) => w.sec === "done"), JSON.stringify(afterDone.work.map((w) => `${w.sec}:${w.title}`)));
  check("5 결재 delivered", afterDone.decisions.find((d) => d.id === decision.id)?.status === "delivered");
  dumpMessages(afterDone);

  // 6) file 도구
  await send(pid, "hello.txt 를 file 도구로 자료에 등록하고, post 완료의 file_ids 에 그 id 를 넣어 알려 줘", minsu.id);
  const afterFile = await until("자료", async () => {
    budgetGuard();
    const s = await state(pid);
    return s.files.length > 0 ? s : null;
  });
  const fileState = await quiet(pid, 8000);
  const doc = fileState.files[0]!;
  check("6 file 등록", afterFile.files.length > 0, `${doc.title} who=${doc.who} path=${doc.path} body=${JSON.stringify(doc.body).slice(0, 60)} 첨부=${doc.attachments.length}`);
  check("6 post 에 자료 연결", fileState.messages.some((m) => m.who === "민수" && m.fileId === doc.id));
  const direct = callsFor("민수").at(-1)!;
  check("6 [대표 직접] 접두어", /^\[대표 직접\] "/.test(prompt(direct)) || callsFor("민수").some((c) => /\[대표 직접\] "/.test(prompt(c))));

  // 7) 문맥 %
  const m7 = memberNamed(fileState, "민수")!;
  const lastAssistant = [...direct.events].reverse().find((e) => e.type === "assistant" && e.message?.usage && !e.parent_tool_use_id);
  const usage = lastAssistant?.message?.usage ?? {};
  const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const modelKey = lastAssistant?.message?.model;
  const window = resultOf(direct)?.modelUsage?.[modelKey]?.contextWindow;
  const expectPct = window ? Math.min(100, Math.round((tokens / window) * 100)) : null;
  check("7 문맥 % 값", m7.contextPct !== null && m7.contextPct === expectPct, `서버=${m7.contextPct} 계산=${expectPct} (토큰 ${tokens}/창 ${window}, 모델 ${modelKey})`);

  // 8) /compact 경로 — 총괄의 team_compact
  const beforeCompact = callsFor("민수").length;
  await send(pid, "민수 세션을 지금 team_compact 도구로 압축해 줘. 다른 일은 하지 마");
  await until("압축 호출", async () => {
    budgetGuard();
    return callsFor("민수").slice(beforeCompact).find((c) => prompt(c).startsWith("/compact")) ?? null;
  });
  const afterCompact = await quiet(pid, 8000);
  const compactCall = callsFor("민수").find((c) => prompt(c).startsWith("/compact"))!;
  const boundary = compactCall.events.find((e) => e.type === "system" && e.subtype === "compact_boundary");
  check("8 총괄이 team_compact", callsFor("총괄").flatMap(toolUses).some((t) => t.name === "mcp__iamceo__team_compact"));
  check("8 compact_boundary 나옴", !!boundary, JSON.stringify(boundary?.compact_metadata ?? null));
  check("8 인자는 --resume", !!argOf(compactCall, "--resume"), prompt(compactCall).slice(0, 80));
  const act = await api<any[]>("GET", `/api/members/${minsu.id}/activity?limit=100`);
  check("8 압축 완료 기록·문맥 초기화", act.some((a) => a.kind === "compact" && a.text === "압축 완료") && memberNamed(afterCompact, "민수")!.contextPct === null, `pct=${memberNamed(afterCompact, "민수")!.contextPct}, status=${memberNamed(afterCompact, "민수")!.status}, result=${resultOf(compactCall)?.subtype}`);

  // 9) 잠재우기·다시 열기·기억
  const slept = await api<Member>("POST", `/api/members/${minsu.id}/sleep`);
  check("9 잠듦", slept.status === "asleep" && !!slept.sessionId, slept.status);
  const woke = await api<Member>("POST", `/api/members/${minsu.id}/resume`);
  check("9 다시 열림·세션 유지", woke.status !== "asleep" && woke.sessionId === slept.sessionId, `${woke.status} ${woke.sessionId}`);
  await send(pid, "앞서 결재 답의 메모에 내가 적은 암호가 뭐였지? 파일을 뒤지지 말고 기억으로만 post 로 알려 줘", minsu.id);
  const afterMemory = await quiet(pid, 8000);
  const memCall = callsFor("민수").at(-1)!;
  const memMsg = afterMemory.messages.filter((m) => m.who === "민수").at(-1);
  check("9 기억 유지(파랑새)", /파랑새/.test(`${memMsg?.title} ${memMsg?.body}`), `${memMsg?.title} / ${memMsg?.body}`.slice(0, 120));
  check("9 --resume 같은 세션", argOf(memCall, "--resume") === slept.sessionId && resultOf(memCall)?.session_id === slept.sessionId);
  const compactedPct = memberNamed(afterMemory, "민수")!.contextPct;
  log(`압축 뒤 문맥: ${compactedPct}% (압축 전 ${m7.contextPct}%)`);

  // 동시 실행 + 제어문자·한글 인자
  const nasty = `제어문자 시험: 탭\t줄\n바꿈 "따옴표" '작은' $HOME \`date\` \\ 백슬래시 \x01\x07\x1b[31m빨강\x1b[0m 널[\u0000] 끝. 위 글을 해석하지 말고 "받음" 한 단어로만 답해`;
  const before = readCalls().length;
  await Promise.all([send(pid, nasty), send(pid, "지금 몇 번째 일을 했는지 숫자 하나로만 post 로 알려 줘", minsu.id)]);
  const afterNasty = await quiet(pid, 8000);
  const newCalls = readCalls().slice(before);
  const nastyCall = newCalls.find((c) => nameOf(c) === "총괄" && prompt(c).includes("제어문자"));
  const nastyMsg = afterNasty.messages.find((m) => m.mine && m.body.includes("제어문자"));
  log(`제어문자 전달 상태: ${nastyMsg?.delivery} ${nastyMsg?.deliveryNote ?? ""}`);
  check("제어문자 메시지 전달됨", nastyMsg?.delivery === "delivered" && !!nastyCall && resultOf(nastyCall)?.is_error === false, JSON.stringify(nastyCall ? prompt(nastyCall) : "").slice(0, 240));
  check("제어문자 뒤 대기열 안 막힘", !afterNasty.messages.some((m) => m.mine && m.delivery === "held") && memberNamed(afterNasty, "총괄")!.lastError === null, `총괄 대기 ${memberNamed(afterNasty, "총괄")!.queuedCount}`);
  const leadNew = newCalls.filter((c) => nameOf(c) === "총괄");
  const minsuNew = newCalls.filter((c) => nameOf(c) === "민수");
  const overlap = leadNew.some((a) => minsuNew.some((b) => a.startedAt < b.endedAt && b.startedAt < a.endedAt));
  check("동시 실행(총괄·민수 겹침, 결과 정상)", overlap && [...leadNew, ...minsuNew].every((c) => resultOf(c)?.is_error === false), `총괄 ${leadNew.length}회, 민수 ${minsuNew.length}회`);

  // 10) 서버 재시작 뒤 이어가기
  const sessionBefore = memberNamed(afterNasty, "민수")!.sessionId;
  await stopServer();
  await startServer();
  const r0 = await state(pid);
  check("10 재시작 뒤 명부 유지", memberNamed(r0, "민수")?.sessionId === sessionBefore, memberNamed(r0, "민수")?.status);
  await send(pid, "메모의 암호를 한 번 더 post 로 알려 줘. 기억으로만", minsu.id);
  const r1 = await quiet(pid, 8000);
  const afterRestart = callsFor("민수").at(-1)!;
  const r1msg = r1.messages.filter((m) => m.who === "민수").at(-1);
  check("10 재시작 뒤 --resume 으로 이어감", argOf(afterRestart, "--resume") === sessionBefore && resultOf(afterRestart)?.is_error === false);
  check("10 재시작 뒤 기억", /파랑새/.test(`${r1msg?.title} ${r1msg?.body}`), `${r1msg?.title} / ${r1msg?.body}`.slice(0, 120));

  // 10b) 턴 도중 재시작: 자식이 고아로 남지 않고, 시스템 글이 남고, 다음 턴이 이어진다
  const cBefore = callsFor("민수").length;
  await send(pid, "bash 로 sleep 40 을 돌린 뒤 post 로 끝났다고 알려 줘", minsu.id);
  await until("sleep 시작", async () => callsFor("민수").length > cBefore && toolUses(callsFor("민수").at(-1)!).some((t) => t.name === "Bash" && /sleep/.test(JSON.stringify(t.input))), 90_000);
  await sleep(1000);
  const sid = memberNamed(await state(pid), "민수")!.sessionId!;
  await stopServer();
  await sleep(1500);
  const orphan = await $`pgrep -f ${sid}`.nothrow().text();
  check("10b 턴 도중 종료 뒤 claude 자식 없음", orphan.trim() === "", orphan.trim().replace(/\n/g, ","));
  const left = await ourProcesses();
  check("10b 손자(브리지·셸) 고아 없음", left.length === 0, left.join(" | ").slice(0, 300));
  await startServer();
  const r2 = await state(pid);
  check("10b 끊김 시스템 글·idle", memberNamed(r2, "민수")!.status === "idle" && r2.messages.some((m) => m.kind === "시스템" && m.body.includes("끊겼")), memberNamed(r2, "민수")!.status);
  await send(pid, "지금 깨어 있으면 '네' 한 글자만 답해", minsu.id);
  const r3 = await quiet(pid, 8000);
  const afterKill = callsFor("민수").at(-1)!;
  check("10b 끊긴 뒤 다음 턴 정상", resultOf(afterKill)?.is_error === false, `인자 ${argOf(afterKill, "--resume") ? "--resume" : "--session-id"}, 민수 ${memberNamed(r3, "민수")!.status}`);

  // 10c) 세션 파일이 없는 --resume(첫 턴이 시작하자마자 죽은 경우와 같다): 실제 CLI 문구로 새 세션 복구
  await stopServer();
  const gone = crypto.randomUUID();
  const db = new Database(join(home, "iamceo.db"));
  db.query("UPDATE members SET session_id = ? WHERE id = ?").run(gone, minsu.id);
  db.close();
  await startServer();
  const c10c = readCalls().length;
  await send(pid, "새 세션이어도 괜찮아. '네' 한 글자만 답해", minsu.id);
  await until("복구 호출", async () => readCalls().slice(c10c).filter((c) => nameOf(c) === "민수").length >= 2 && resultOf(callsFor("민수").at(-1)!), 90_000);
  const r4 = await quiet(pid, 6000);
  const recover = readCalls().slice(c10c).filter((c) => nameOf(c) === "민수");
  check("10c 없는 세션 → 실패 뒤 새 세션", argOf(recover[0]!, "--resume") === gone && !!argOf(recover[1]!, "--session-id") && resultOf(recover[1]!)?.is_error === false, `첫 stderr: ${recover[0]!.err.trim().slice(0, 80)}`);
  check("10c 새 세션 id 저장·안내 글", memberNamed(r4, "민수")!.sessionId === argOf(recover[1]!, "--session-id") && r4.messages.some((m) => m.kind === "시스템" && m.body.includes("새 세션")), memberNamed(r4, "민수")!.status);

  // 11) 본사 AI
  const newName = "본사가만든프로젝트";
  await send("hq", `프로젝트 하나 만들어 줘. 이름은 ${newName}, 폴더는 ${newCwd} (이미 있음). 총괄은 아직 띄우지 마. start_conductor 를 넘기지 말 것.`);
  const hq = await quiet("hq", 8000);
  const boot = await api<any>("GET", "/api/bootstrap");
  const made = boot.projects.find((p: any) => p.name === newName);
  const rootCall = callsFor("본사 AI");
  const rootTools = rootCall.flatMap(toolUses).map((t) => t.name);
  check("11 project_create 호출·프로젝트 생김", !!made && rootTools.includes("mcp__iamceo__project_create"), rootTools.join(","));
  if (made) {
    const ps = await state(made.id);
    log(`  새 프로젝트: cwd=${ps.project.cwd} 멤버=${ps.members.length}`);
    check("11 폴더 맞음", ps.project.cwd === newCwd, ps.project.cwd);
  }
  dumpMessages(hq);
  const final = await state(pid);
  dumpMessages(final);
}

function report(): void {
  const all = readCalls();
  const stripped = /^(HERDR_.*|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT)$/;
  const leaked = [...new Set(all.flatMap((c) => c.envKeys.filter((k) => stripped.test(k))))];
  check("환경 정리(HERDR_*·CLAUDECODE 등)", all.length > 0 && leaked.length === 0, `호출 ${all.length}회, 샌 변수 ${JSON.stringify(leaked)}, 남은 CLAUDE*: ${JSON.stringify([...new Set(all.flatMap((c) => c.envKeys.filter((k) => /^CLAUDE/.test(k))))])}`);
  check("cwd 는 임시 폴더", all.every((c) => c.cwd.startsWith("/private" + out) || c.cwd.startsWith(out)));
  check("모델은 전부 haiku", all.every((c) => argOf(c, "--model") === MODEL));
  const denials = all.flatMap((c) => resultOf(c)?.permission_denials ?? []);
  check("권한 거부 없음", denials.length === 0, JSON.stringify(denials).slice(0, 300));
  const servers = all.flatMap((c) => c.events.filter((e) => e.type === "system" && e.subtype === "init").map((e) => e.mcp_servers?.find((s: any) => s.name === "iamceo")?.status));
  check("MCP 연결", servers.length > 0 && servers.every((s) => s === "connected"), JSON.stringify([...new Set(servers)]));
  const inits = all.flatMap((c) => c.events.filter((e) => e.type === "system" && e.subtype === "init"));
  console.log(`init 도구 수·iamceo 도구 노출: ${inits.slice(0, 3).map((e) => `${e.tools?.length}/${(e.tools ?? []).filter((t: string) => t.startsWith("mcp__iamceo")).length}`).join(" ")}, permissionMode=${inits[0]?.permissionMode}`);
  console.log(`ToolSearch 호출: ${all.flatMap(toolUses).filter((t) => t.name === "ToolSearch").length}회 ${JSON.stringify(all.flatMap(toolUses).filter((t) => t.name === "ToolSearch").map((t) => t.input?.query)).slice(0, 400)}`);
  console.log("\n호출별:");
  for (const c of all) {
    const r = resultOf(c);
    console.log(`  ${nameOf(c)} ${argOf(c, "--resume") ? "resume" : "new"} turns=${r?.num_turns} $${(r?.total_cost_usd ?? 0).toFixed(4)} ${r?.subtype ?? "결과없음"} err=${r?.is_error} tools=${toolUses(c).map((t) => t.name.replace("mcp__iamceo__", "")).join(",")} p=${JSON.stringify(prompt(c)).slice(0, 70)}`);
    if (c.err.trim()) console.log(`     stderr: ${c.err.trim().slice(0, 200)}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n호출 ${all.length}회, 모델 턴 합 ${all.reduce((n, c) => n + (resultOf(c)?.num_turns ?? 0), 0)}, 총 비용 $${totalCost().toFixed(4)}`);
  console.log(`검사 ${results.length}건 중 통과 ${results.length - failed.length}, 실패 ${failed.length}`);
  for (const f of failed) console.log(`  실패: ${f.name} — ${f.detail}`);
  console.log(`출력 폴더: ${out}`);
}

let crashed: unknown = null;
try {
  await main();
} catch (e) {
  crashed = e;
  console.error("시나리오 중단:", e);
} finally {
  await stopServer();
}
await sleep(1500);
const leftovers = await ourProcesses();
check("끝: 남은 프로세스 없음", leftovers.length === 0, leftovers.join(" | ").slice(0, 300));
report();
process.exit(crashed || results.some((r) => !r.ok) ? 1 : 0);
