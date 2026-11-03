// 실제 claude(haiku) 왕복 한 번: 직원에게 "두 안 비교표를 자료로 올려" 를 시켜 모델이 file 의 html 로 아티팩트를 올리는지 본다. 돈이 든다.
// 실행: IAMCEO_E2E_REAL=1 bun tests/e2e-real/artifact.ts
// 격리: IAMCEO_HOME 은 임시 폴더, 라이브 herdr 소켓은 쓰지 않는다(headless). 임시 폴더는 지우지 않는다. 끝나면 이 시험이 띄운 서버만 끈다.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { chromium } from "playwright";
import type { FileDoc, Member, Message, Project, ProjectState } from "../../shared/types.ts";

if (process.env.IAMCEO_E2E_REAL !== "1") {
  console.log("건너뜀: IAMCEO_E2E_REAL=1 일 때만 실제 claude 로 돈다");
  process.exit(0);
}

const ROOT = resolve(import.meta.dir, "..", "..");
const REAL_CLAUDE = Bun.which("claude");
if (!REAL_CLAUDE) throw new Error("claude 를 찾지 못했습니다");
const MODEL = "haiku";
const TURN_MS = 240_000;

const out = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-e2e-artifact-")));
const home = join(out, "home");
const calls = join(out, "calls");
const cwd = join(out, "결제개편");
for (const dir of [home, calls, cwd]) mkdirSync(dir, { recursive: true });
await $`git init -q ${cwd}`;

const CODE = "e2e-artifact-code";
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
writeFileSync(join(home, "config.json"), JSON.stringify({ accessCode: CODE, port: PORT, hosts: ["127.0.0.1"] }));

// 자식의 인자와 stream-json 출력을 남기고 진짜 claude 로 바꿔 탄다.
const wrapper = join(out, "claude-wrap.sh");
writeFileSync(
  wrapper,
  `#!/bin/bash
base="$IAMCEO_E2E_CALLS/$(date +%s)-$$"
printf '%s\\0' "$@" > "$base.args"
exec > >(tee "$base.jsonl")
exec "$IAMCEO_E2E_REAL_CLAUDE" "$@"
`,
);
chmodSync(wrapper, 0o755);

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(HERDR_|CLAUDECODE|CLAUDE_CODE_)/.test(k)) env[k] = v;
const server = Bun.spawn({
  cmd: [process.execPath, join(ROOT, "bin", "iamceo.ts"), "serve"],
  cwd: ROOT,
  env: { ...env, IAMCEO_HOME: home, IAMCEO_CLAUDE_BIN: wrapper, IAMCEO_HERDR_SOCKET: join(out, "no-herdr.sock"), IAMCEO_TEST: "1", IAMCEO_E2E_CALLS: calls, IAMCEO_E2E_REAL_CLAUDE: REAL_CLAUDE },
  stdin: "ignore",
  stdout: Bun.file(join(out, "server.out")),
  stderr: Bun.file(join(out, "server.err")),
});

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}
async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, ms = TURN_MS): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`시간 초과: ${what}`);
    await Bun.sleep(1000);
  }
}

interface Event { type?: string; parent_tool_use_id?: string | null; total_cost_usd?: number; message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] } }
const readEvents = (): Event[] =>
  readdirSync(calls)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(calls, f), "utf8").split("\n").filter(Boolean))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Event];
      } catch {
        return [];
      }
    });
const totalCost = () => readEvents().filter((e) => e.type === "result").reduce((sum, e) => sum + (e.total_cost_usd ?? 0), 0);

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "통과" : "실패"} ${name}${detail ? ` — ${detail}` : ""}`);
}

let crashed: unknown = null;
try {
  await until("서버", async () => (await fetch(`${BASE}/api/health`)).ok, 20_000);
  await api("PUT", "/api/settings", { backend: "headless", ranks: { manager: { model: MODEL }, lead: { model: MODEL }, staff: { model: MODEL } } });
  const project = await api<Project>("POST", "/api/projects", { name: "결제 개편", cwd });
  const state = () => api<ProjectState>("GET", `/api/projects/${project.id}/state`);
  const send = (text: string, target: string | null = null) => api<Message>("POST", `/api/projects/${project.id}/messages`, { id: crypto.randomUUID(), text, targetMemberId: target });
  const quiet = async () => {
    let since = Date.now();
    return until("조용해지기", async () => {
      const s = await state();
      if (s.members.some((m) => m.status === "working" || m.queuedCount > 0)) since = Date.now();
      return Date.now() - since >= 5000 ? s : null;
    });
  };

  await send("직원 서윤(역할: 자료 정리, handle: seoyun)을 team_add 로 만들어 줘. 첫 지시는 주지 말고 만들기만 해. 만든 뒤 한 줄로 알려 줘.");
  const worker = await until<Member>("서윤 생김", async () => (await state()).members.find((m) => m.name === "서윤") ?? null);
  await quiet();
  console.log(`서윤 만듦(${worker.id}), 지금까지 비용 $${totalCost().toFixed(4)}`);

  // 사용자가 할 법한 말 그대로. html 을 쓰라고 시키지 않는다. 역할 규칙만으로 골라야 한다.
  await send("두 안 비교표를 자료로 올려. A안: 카드 결제만 먼저(2주, 초기 비용 낮음, 간편결제 고객 34%는 나중에 대응). B안: 카드와 간편결제 함께(5주, 초기 비용 높음, 전 고객 바로 대응).", worker.id);
  const after = await until("자료 올라옴", async () => {
    const s = await state();
    return s.files.length > 0 && !s.members.some((m) => m.status === "working") ? s : null;
  });
  const final = await quiet();

  const events = readEvents();
  const fileCalls = events.filter((e) => e.type === "assistant").flatMap((e) => e.message?.content ?? []).filter((b) => b.type === "tool_use" && b.name === "mcp__iamceo__file");
  console.log(`file 호출: ${JSON.stringify(fileCalls.map((c) => Object.keys(c.input ?? {})))}`);
  check("file 을 불렀다", fileCalls.length > 0);
  check("file 의 html 인자로 올렸다", fileCalls.some((c) => typeof c.input?.html === "string"), fileCalls.map((c) => Object.keys(c.input ?? {}).join("+")).join(" / "));
  const artifact = final.files.find((f: FileDoc) => f.kind === "artifact");
  check("자료의 모양이 artifact", !!artifact, after.files.map((f) => f.kind).join(","));
  if (artifact) {
    const { html } = await api<{ html: string }>("GET", `/api/files/${artifact.id}/artifact`);
    writeFileSync(join(out, "artifact.html"), html);
    console.log(`아티팩트 제목: ${artifact.title}, 길이 ${html.length}자`);
    check("표가 있다", /<table[\s>]/i.test(html) || /class=["'][^"']*compare/i.test(html));
    check("두 안이 다 있다", /A안/.test(html) && /B안/.test(html));
    check("바깥 자원을 부르지 않는다", !/<(script|link|img)[^>]+(src|href)=["']https?:/i.test(html));
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript((code) => {
      if (window.top === window) localStorage.setItem("iamceo.accessCode", code);
    }, CODE);
    await page.goto(`${BASE}/#/p/${project.id}/files/${artifact.id}`);
    await page.getByRole("button", { name: "실행", exact: true }).click();
    const frame = page.frameLocator("iframe.afr-frame");
    await frame.locator("table, .compare").first().waitFor({ timeout: 20_000 });
    const over = await frame.locator("html").evaluate((d) => d.scrollWidth > window.innerWidth + 1);
    check("격리 칸에 그려지고 가로로 넘치지 않는다", !over);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, "artifact.png") });
    await browser.close();
  }
  const report = final.messages.find((m) => m.who === "서윤" && !!m.fileId);
  check("보고에 자료가 이어졌다", !!report, report?.title ?? "");
  console.log(`비용 합 $${totalCost().toFixed(4)}`);
} catch (e) {
  crashed = e;
  console.error("시나리오 중단:", e);
} finally {
  server.kill("SIGTERM");
  await server.exited;
}
if (existsSync(join(out, "artifact.png"))) console.log(`캡처: ${join(out, "artifact.png")}`);
const failed = results.filter((r) => !r.ok);
console.log(`검사 ${results.length}건 중 통과 ${results.length - failed.length}, 실패 ${failed.length}`);
console.log(`출력 폴더: ${out}`);
process.exit(crashed || failed.length > 0 ? 1 : 0);
