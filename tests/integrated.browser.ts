// 사용자 요청 10건을 한 흐름으로: 가져온(연결 안 된) 프로젝트 → 총괄 시작 → 결재 2단계 → 결재된 항목 → 홈 할 일 → 자료 아티팩트 → 편입 창 → 전체 설정 → 직원별 덮어쓰기.
// 실제 서버 프로세스 + Playwright chromium + 가짜 claude. 가짜가 받은 argv·환경을 로그에서 직접 본다. 라이브 herdr·실제 ~/.iamceo·실제 claude 는 쓰지 않는다.
// IAMCEO_SHOTS=<폴더> 를 주면 docs/shots 이름 그대로 캡처를 남긴다(가짜 데이터). 없으면 임시 폴더에 남긴다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Bootstrap, Decision, FileDoc, Member, ProjectState } from "../shared/types.ts";
import { updateConfigFile } from "../server/config.ts";
import { auditLayout } from "./fixtures/layout-audit.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "bin", "iamceo.ts");
const FAKE = join(ROOT, "tests", "fixtures", "fake-claude.ts");
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-integrated-")));
const HOME = join(WORK, "iamceo-home");
// 본사 폴더가 진짜 홈(사용자 이름)으로 화면에 나오지 않게 서버의 HOME 도 바꾼다.
const USER_HOME = join(WORK, "demo-home");
const PROJECT_DIR = join(WORK, "payment");
const FAKE_LOG = join(WORK, "fake.jsonl");
const SHOTS = process.env.IAMCEO_SHOTS ?? join(WORK, "shots");
for (const dir of [HOME, USER_HOME, PROJECT_DIR, SHOTS]) mkdirSync(dir, { recursive: true });
const CODE = "integrated-code";
const PROJECT_NAME = "결제 페이지 개편";
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const COMPARE_HTML = `<h1>결제 방식 두 안 비교</h1>
<p>대표가 고를 수 있게 비용과 일정만 추렸습니다.</p>
<div class="grid">
  <div class="kpi"><b>2주</b><small>A안 일정</small></div>
  <div class="kpi"><b>5주</b><small>B안 일정</small></div>
  <div class="kpi"><b>34%</b><small>간편결제 비중</small></div>
</div>
<h2>비교표</h2>
<table id="compare"><thead><tr><th>항목</th><th>A안 카드 먼저</th><th>B안 함께</th></tr></thead>
<tbody><tr><td>일정</td><td>2주</td><td>5주</td></tr><tr><td>초기 비용</td><td>낮음</td><td>높음</td></tr><tr><td>간편결제 고객</td><td>나중에 대응</td><td>바로 대응</td></tr></tbody></table>
<div class="callout"><strong>권장: A안.</strong> 먼저 내고 반응을 본 뒤 간편결제를 붙입니다.</div>
<h2>진행 순서</h2>
<ol class="steps"><li><strong>카드 결제 출시</strong><br>2주 안에 끝냅니다.</li><li><strong>반응 확인</strong><br>이탈률을 봅니다.</li><li><strong>간편결제 추가</strong><br>필요하면 붙입니다.</li></ol>
<button id="ping" onclick="this.textContent='스크립트 돎'">눌러 보기</button>`;

const SCRIPT = [
  { when: "[보고 ", text: "보고를 확인했습니다." },
  { when: "다시 봐 주세요", text: "다시 확인했습니다. 바뀐 점은 없습니다." },
  {
    when: "[총괄] 서윤에게",
    tools: [
      { name: "status", args: { now: "두 안 비교표 정리 중", next: "비교표를 자료로 올리기" } },
      { name: "file", args: { title: "결제 방식 두 안 비교", summary: "A안과 B안의 일정·비용·고객 영향", html: COMPARE_HTML } },
      { name: "post", args: { kind: "완료", title: "두 안 비교표를 올렸습니다", body: "자료에서 바로 볼 수 있습니다. 권장은 A안입니다.", file_ids: ["$last"] } },
      { name: "file", args: { title: "결제 수단별 수치", summary: "결제 수단별 이용 비중", path: join(PROJECT_DIR, "수치.csv") } },
      { name: "file", args: { title: "결제 화면 시안", summary: "첫 시안 캡처", path: join(PROJECT_DIR, "시안.png") } },
      { name: "file", args: { title: "결제 설정 파일", summary: "시험 환경 설정", path: join(PROJECT_DIR, "payment.json") } },
      { name: "todo", args: { title: "PG사 계약서 서명하기", detail: "카드 결제 출시에 **계약서 서명**이 필요합니다.\n\n- 담당자 메일을 확인해 주세요\n- 서명 후 사본을 올려 주세요" } },
    ],
    silent: true,
  },
  {
    when: "두 안 비교표",
    tools: [
      { name: "project_now", args: { text: "**서윤**이 결제 방식 비교표를 정리했습니다. 대표의 결정을 기다립니다." } },
      { name: "work_set", args: { sec: "doing", title: "결제 방식 비교", detail: "두 안의 일정·비용 정리", who: "서윤" } },
      { name: "work_set", args: { sec: "next", title: "카드 결제 화면 구현", who: "민수" } },
      { name: "work_set", args: { sec: "next", title: "이탈률 측정 넣기", who: "지영" } },
      { name: "team_add", args: { name: "서윤", role: "자료 정리", handle: "seoyun", first_instruction: "두 안 비교표를 자료로 올리세요.", user_quote: "두 안 비교표를 자료로 올려 줘" } },
    ],
    text: "서윤에게 두 안 비교표를 맡겼습니다.",
  },
  { when: "[대표 답(원문)", tools: [{ name: "status", args: { now: "받은 결정대로 화면을 고치는 중", next: "결과 보고" } }], text: "결정대로 진행합니다." },
  { when: "했음", text: "받았습니다." },
];

const DUMP = {
  meta: { board: { asof: "2026-11-01T00:00:00Z", by: "총괄", now: "결제 페이지를 새로 만드는 중입니다." } },
  sessions: {
    minsu: { order: 1, name: "민수", role: "결제 화면 구현", now: "카드 입력 화면", queue: "—" },
    jiyoung: { order: 2, name: "지영", role: "결제 연동", now: "PG 시험 연동", queue: "—" },
  },
  docs: { brief: { order: 1, title: "개편 배경", who: "민수", summary: "왜 결제 페이지를 고치는가", body: "# 개편 배경\n\n이탈이 **결제 단계**에서 가장 많습니다." } },
  items: {
    q1: { sec: "decide", order: 1, title: "결제 수단 범위를 정해 주세요", detail: "간편결제 고객은 **34%** 입니다. 모두 넣으면 일정이 3주 늘어납니다.", who: "민수", options: [{ k: "card", label: "카드만 먼저", desc: "2주 안에 냅니다" }, { k: "all", label: "간편결제까지", desc: "5주 걸립니다" }], rec: "card", docId: "brief" },
    q2: { sec: "decide", order: 2, title: "결제 완료 문구를 골라 주세요", detail: "완료 화면 첫 줄입니다.", who: "지영", group: "문구", options: [{ k: "a", label: "결제가 끝났습니다" }, { k: "b", label: "감사합니다" }], rec: "a" },
    q3: { sec: "decide", order: 3, title: "실패 문구를 골라 주세요", detail: "실패 화면 첫 줄입니다.", who: "지영", group: "문구", options: [{ k: "a", label: "다시 시도해 주세요" }, { k: "b", label: "카드를 확인해 주세요" }], rec: "b" },
    q0: { sec: "decide", order: 0, title: "결제 페이지 주소를 정해 주세요", detail: "지금 주소를 **유지**할지 정합니다.", who: "민수", options: [{ k: "keep", label: "그대로" }, { k: "new", label: "새 주소" }] },
    t1: { sec: "todo", order: 4, title: "로고 원본 파일 보내기", detail: "완료 화면에 넣을 **로고**가 필요합니다.\n\n- SVG 면 좋습니다\n- 없으면 PNG", group: "직접 하실 일", who: "민수" },
    t2: { sec: "todo", order: 5, title: "카드사 시험 계정 만들어 주기", detail: "시험 계정이 있어야 결제 흐름을 돌릴 수 있습니다.", group: "직접 하실 일", who: "지영" },
    t3: { sec: "todo", order: 6, title: "개인정보 처리방침 확인", group: "직접 하실 일", who: "지영" },
    d1: { sec: "done", order: 8, title: "결제 단계 이탈률 측정", who: "지영" },
  },
  answers: { q0: { choice: "keep", note: "주소는 바꾸지 맙시다", at: "2026-10-30T01:00:00Z" } },
  feed: { n1: { at: "2026-10-30T02:00:00Z", who: "민수", kind: "진행", title: "카드 입력 화면 초안을 올렸습니다", body: "내일 시안을 보여 드립니다." } },
};

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(HERDR_|CLAUDE|IAMCEO_)/.test(k)) env[k] = v;
  return { ...env, HOME: USER_HOME, IAMCEO_TEST: "1", IAMCEO_HOME: HOME, IAMCEO_CLAUDE_BIN: FAKE, IAMCEO_HERDR_SOCKET: join(WORK, "none.sock"), FAKE_CLAUDE_LOG: FAKE_LOG, FAKE_CLAUDE_SCRIPT: join(WORK, "script.json"), ...extra };
}

let server: ReturnType<typeof Bun.spawn>;
let base = "";
let projectId = "";
let browser: Browser;
let deskCtx: BrowserContext;
let phoneCtx: BrowserContext;
const browserErrors: string[] = [];

const api = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};
const rawApi = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const projectState = () => api<ProjectState>("GET", `/api/projects/${projectId}/state`);
const decisionNamed = async (title: string): Promise<Decision> => (await projectState()).decisions.find((d) => d.title === title)!;
const memberNamed = async (name: string): Promise<Member> => (await projectState()).members.find((m) => m.name === name)!;

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await Bun.sleep(50);
  }
  throw new Error(`기다리다 끝남: ${what} (마지막 값: ${JSON.stringify(last)?.slice(0, 400)})`);
}

/** 모든 세션이 일을 끝냈고 전달 대기도 없다. */
const settled = () => until("모두 쉼", projectState, (s) => s.members.every((m) => m.status !== "working" && m.queuedCount === 0));

interface FakeCall { event: string; prompt: string; args: string[]; subagentModel: string | null; subagentForce: string | null; env: string[] }
function fakeCalls(name?: string): FakeCall[] {
  if (!existsSync(FAKE_LOG)) return [];
  const all = readFileSync(FAKE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeCall).filter((c) => c.event === "start");
  // 총괄 세션 이름에는 프로젝트 이름이 붙는다.
  return name ? all.filter((c) => (name === "총괄" ? argOf(c, "-n")?.endsWith(" 총괄") : argOf(c, "-n") === name)) : all;
}
function argOf(c: FakeCall, flag: string): string | null {
  const i = c.args.indexOf(flag);
  return i >= 0 ? (c.args[i + 1] ?? null) : null;
}
/** 글을 보내고 그 턴의 argv 를 돌려준다. */
async function turnArgs(name: string, text: string, targetMemberId: string | null): Promise<FakeCall> {
  const before = fakeCalls(name).length;
  await api("POST", `/api/projects/${projectId}/messages`, { id: crypto.randomUUID(), text, targetMemberId });
  return (await until(`${name} 턴`, async () => fakeCalls(name), (c) => c.slice(before).some((x) => x.prompt.includes(text)))).slice(before).find((x) => x.prompt.includes(text))!;
}

function watch(page: Page, label: string): void {
  page.on("pageerror", (e) => browserErrors.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // 일부러 받은 409 같은 응답은 브라우저가 스스로 콘솔에 남긴다.
    if (/Failed to load resource|ERR_CONNECTION|WebSocket connection/.test(text)) return;
    browserErrors.push(`${label} console: ${text}`);
  });
}

async function open(ctx: BrowserContext, hash: string): Promise<Page> {
  const page = await ctx.newPage();
  watch(page, ctx === phoneCtx ? "폰" : "데스크톱");
  await page.addInitScript((code) => {
    // 아티팩트 칸(불투명 출처)에서도 돌므로 맨 위 문서에서만 적는다.
    if (window.top === window) localStorage.setItem("iamceo.accessCode", code);
  }, CODE);
  await page.goto(`${base}/${hash}`);
  return page;
}

/** 넘침·가림을 보고 캡처한다. */
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350);
  expect(await auditLayout(page)).toEqual([]);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const composer = (page: Page) => page.getByRole("textbox", { name: "입력칸" });
const hash = (tab: string, sub?: string) => `#/p/${projectId}/${tab}${sub ? `/${sub}` : ""}`;

beforeAll(async () => {
  writeFileSync(join(WORK, "script.json"), JSON.stringify(SCRIPT));
  writeFileSync(join(WORK, "dump.json"), JSON.stringify(DUMP));
  writeFileSync(join(PROJECT_DIR, "수치.csv"), "결제 수단,비중,전월 대비\n신용카드,52%,-2%\n간편결제,34%,+4%\n계좌이체,11%,-1%\n휴대폰,3%,-1%\n");
  writeFileSync(join(PROJECT_DIR, "payment.json"), JSON.stringify({ gateway: "test", retry: 2, methods: ["card", "easy"] }, null, 2));

  const port = (() => {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const found = probe.port!;
    probe.stop(true);
    return found;
  })();
  base = `http://127.0.0.1:${port}`;
  updateConfigFile({ accessCode: CODE, port, hosts: ["127.0.0.1"] }, { IAMCEO_HOME: HOME });
  // 연결 안 된 프로젝트는 실제 사용자와 같은 길로 만든다: 옛 운영판 가져오기.
  const imported = Bun.spawnSync([process.execPath, CLI, "import", join(WORK, "dump.json"), "--name", PROJECT_NAME, "--cwd", PROJECT_DIR], { cwd: ROOT, env: childEnv({}), stdout: "pipe", stderr: "pipe" });
  if (imported.exitCode !== 0) throw new Error(`가져오기 실패: ${imported.stderr.toString()}`);

  server = Bun.spawn([process.execPath, CLI, "serve"], { cwd: ROOT, env: childEnv({ IAMCEO_PORT: String(port) }), stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  await until("서버", () => fetch(`${base}/api/health`).then((r) => r.ok, () => false), (ok) => ok, 20_000);
  projectId = (await api<Bootstrap>("GET", "/api/bootstrap")).projects.find((p) => p.name === PROJECT_NAME)!.id;

  browser = await chromium.launch();
  deskCtx = await browser.newContext({ viewport: DESK, locale: "ko-KR" });
  phoneCtx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, locale: "ko-KR" });
  deskCtx.setDefaultTimeout(10_000);
  phoneCtx.setDefaultTimeout(10_000);

  // 시안 캡처로 쓸 가짜 그림.
  const art = await deskCtx.newPage();
  await art.setViewportSize({ width: 640, height: 400 });
  await art.setContent(`<body style="margin:0;background:linear-gradient(135deg,#2a1f5c,#7c5cff);color:#fff;font:600 28px sans-serif;display:grid;place-items:center;height:100vh">카드 결제 시안</body>`);
  writeFileSync(join(PROJECT_DIR, "시안.png"), await art.screenshot());
  await art.close();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
  await server?.exited;
  console.log(`시험 폴더: ${WORK}\n캡처 폴더: ${SHOTS}`);
});

describe("전체 통합", () => {
  test("첫 실행: 실행 방식을 고른다. 기본 권한은 바이패스다", async () => {
    const boot = await api<Bootstrap>("GET", "/api/bootstrap");
    expect(boot.settings.backend).toBeNull();
    expect(boot.settings.permissionMode).toBe("bypassPermissions");
    const page = await open(deskCtx, "");
    await page.locator(".su-card__pick", { hasText: "herdr 없이" }).waitFor();
    await shot(page, "desk-setup");
    await page.locator(".su-card__pick", { hasText: "herdr 없이" }).click();
    await page.getByRole("button", { name: "herdr 없이 시작" }).click();
    await composer(page).waitFor();
    expect((await api<Bootstrap>("GET", "/api/bootstrap")).settings.backend).toBe("headless");
    await page.close();
  }, 30_000);

  test("연결 안 된 프로젝트: 입력·결재가 다 막히고 안내가 나온다. 서버도 거부한다", async () => {
    const before = await projectState();
    expect(before.project.connection).toMatchObject({ ok: false, reason: "runner_off" });
    const page = await open(deskCtx, hash("inbox"));
    const card = page.locator(".ibx-card", { hasText: "결제 수단 범위" });
    await card.waitFor();
    const gate = page.locator(".gate[data-gate='runner_off']");
    await gate.waitFor();
    expect(await gate.innerText()).toContain("AI가 아직 연결되지 않았습니다");
    expect(await composer(page).count()).toBe(0);
    expect(await page.getByRole("button", { name: "첨부" }).count()).toBe(0);
    expect(await card.locator(".ibx-opt").first().isDisabled()).toBe(true);
    expect(await card.getByRole("textbox", { name: "메모" }).isDisabled()).toBe(true);
    await shot(page, "desk-gate");

    // 다른 화면에도 같은 안내가 있고 입력칸은 없다.
    for (const tab of ["home", "thread", "files", "team"]) {
      await page.goto(`${base}/${hash(tab)}`);
      // 팀 화면은 시작 카드가 같은 안내를 한다.
      await page.locator(tab === "team" ? ".tm-start" : ".gate[data-gate='runner_off']").first().waitFor();
      expect(await composer(page).count()).toBe(0);
    }
    const phone = await open(phoneCtx, hash("inbox"));
    await phone.locator(".gate[data-gate='runner_off']").waitFor();
    expect(await composer(phone).count()).toBe(0);
    await phone.close();

    // 화면을 우회해도 안 된다.
    const said = await rawApi("POST", `/api/projects/${projectId}/messages`, { id: crypto.randomUUID(), text: "우회" });
    expect(said.status).toBe(409);
    expect(((await said.json()) as { error: string }).error).toContain("연결되지 않았습니다");
    const q = before.decisions.find((d) => d.title.startsWith("결제 수단"))!;
    expect((await rawApi("POST", `/api/decisions/${q.id}/answer`, { choice: "card" })).status).toBe(409);
    expect((await decisionNamed(q.title)).status).toBe("open");
    expect(fakeCalls()).toHaveLength(0);
    await page.close();
  }, 40_000);

  test("총괄을 시작하면 잠금이 풀린다. 다른 기기도 함께 풀린다", async () => {
    const phone = await open(phoneCtx, hash("inbox"));
    await phone.locator(".gate[data-gate='runner_off']").waitFor();
    const page = await open(deskCtx, hash("inbox"));
    await page.locator(".gate").getByRole("link", { name: "팀 화면으로" }).click();
    await page.waitForURL(new RegExp(`/p/${projectId}/team$`));
    await page.locator(".tm-start").getByRole("button", { name: "총괄 시작" }).click();
    await composer(page).waitFor();
    expect(await page.locator(".gate").count()).toBe(0);
    await composer(phone).waitFor();
    expect(await phone.locator(".gate").count()).toBe(0);
    expect((await projectState()).project.connection).toEqual({ ok: true, reason: null, detail: null });
    expect((await projectState()).members.some((m) => m.kind === "conductor")).toBe(true);
    await phone.close();
    await page.close();
  }, 30_000);

  test("결재 2단계: 고르기만 해서는 안 나가고, 확인을 눌러야 간다", async () => {
    const page = await open(deskCtx, hash("inbox"));
    const card = page.locator(".ibx-card", { hasText: "결제 수단 범위" });
    await card.waitFor();
    const answers: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/answer")) answers.push(r.url());
    });
    await card.locator(".ibx-opt", { hasText: "카드만 먼저" }).click();
    const go = card.locator(".ibx-confirm__go");
    await go.waitFor();
    expect((await go.innerText()).replace(/\s+/g, "")).toBe("'카드만먼저'(으)로결정");
    await page.waitForTimeout(300);
    expect(answers).toEqual([]);
    expect((await decisionNamed("결제 수단 범위를 정해 주세요")).status).toBe("open");
    // 취소하면 아무 일도 없고 고른 것만 풀린다.
    await card.getByRole("button", { name: "취소" }).click();
    expect(await go.count()).toBe(0);
    expect(await card.locator(".ibx-opt[aria-pressed='true']").count()).toBe(0);

    await card.locator(".ibx-opt", { hasText: "카드만 먼저" }).click();
    await card.getByRole("textbox", { name: "메모" }).fill("간편결제는 다음 분기에");
    await page.waitForTimeout(650);
    await card.locator(".ibx-confirm__go").click();
    await page.locator(".ibx-card--answered", { hasText: "결제 수단 범위" }).waitFor();
    expect(answers).toHaveLength(1);
    const answered = await until("결재 전달", () => decisionNamed("결제 수단 범위를 정해 주세요"), (d) => d.status === "delivered");
    expect(answered).toMatchObject({ choice: "card", note: "간편결제는 다음 분기에" });
    const got = await until("물은 직원에게 전달", async () => fakeCalls("민수"), (c) => c.length > 0);
    expect(got[0]!.prompt).toContain("[대표 답(원문) '결제 수단 범위를 정해 주세요'] \"카드만 먼저\"");
    expect(got[0]!.prompt).toContain("간편결제는 다음 분기에");
    await settled();
    await page.close();
  }, 40_000);

  test("결재된 항목: 세그먼트로 갈라 보고, 주소로 남고, 펼치면 배경이 보인다", async () => {
    const page = await open(deskCtx, hash("inbox"));
    const seg = page.locator(".ibx-seg__item");
    await seg.first().waitFor();
    expect((await seg.nth(0).innerText()).replace(/\s+/g, " ")).toBe("결재할 항목 2");
    expect((await seg.nth(1).innerText()).replace(/\s+/g, " ")).toBe("결재된 항목 2");
    expect(await page.locator(".ibx-done").count()).toBe(0);
    await seg.nth(1).click();
    await page.waitForURL(new RegExp(`/p/${projectId}/inbox/done$`));
    const row = page.locator(".ibx-done__row", { hasText: "결제 수단 범위" });
    await row.getByText("답: 카드만 먼저").waitFor();
    await row.getByText("메모: 간편결제는 다음 분기에").waitFor();
    await page.locator(".ibx-done__row", { hasText: "결제 페이지 주소" }).getByText("메모: 주소는 바꾸지 맙시다").waitFor();
    expect(await page.locator(".ibx-card").count()).toBe(0);
    await row.getByRole("button", { name: /배경 보기/ }).click();
    expect(await row.locator(".ibx-detail strong").innerText()).toBe("34%");
    await shot(page, "desk-inbox-done");
    await page.reload();
    await page.locator(".ibx-done__row").first().waitFor();
    expect(await page.locator(".ibx-seg__item[aria-current]").innerText()).toContain("결재된 항목");
    await page.close();
  }, 30_000);

  test("홈: 내 할 일은 한 줄이고 화살표로 펼친다. 체크하면 직원에게 가고 해제하면 돌아온다", async () => {
    const page = await open(deskCtx, hash("home"));
    const row = page.locator(".hm-todo", { hasText: "로고 원본" });
    await row.waitFor();
    expect(await row.getByText("SVG 면 좋습니다").isVisible()).toBe(false);
    expect((await row.boundingBox())!.height).toBeLessThanOrEqual(46);
    await row.locator(".hm-todo__toggle").click();
    await row.getByText("SVG 면 좋습니다").waitFor();
    await row.getByText("민수의 요청").waitFor();
    expect((await projectState()).todos.every((t) => !t.done)).toBe(true);

    const other = page.locator(".hm-todo", { hasText: "카드사 시험 계정" });
    const before = fakeCalls("지영").length;
    await other.getByRole("checkbox").click();
    await until("할 일 완료", projectState, (s) => s.todos.find((t) => t.title.startsWith("카드사"))!.done);
    const fold = page.getByRole("button", { name: "완료 1" });
    await fold.waitFor();
    expect(await other.count()).toBe(0);
    const told = await until("직원에게 알림", async () => fakeCalls("지영"), (c) => c.length > before);
    expect(told.at(-1)!.prompt).toContain("[대표] '카드사 시험 계정 만들어 주기' 했음");
    await settled();
    await fold.click();
    await other.waitFor();
    await other.getByRole("checkbox").click();
    await until("해제", projectState, (s) => !s.todos.find((t) => t.title.startsWith("카드사"))!.done);
    await other.waitFor();
    expect(await page.getByRole("button", { name: /^완료/ }).count()).toBe(0);
    await settled();
    await page.close();
  }, 40_000);

  test("자료: 직원이 올린 html 이 아티팩트로 그려지고, 표·그림·코드·문서도 각자 모양으로 보인다", async () => {
    const page = await open(deskCtx, hash("thread"));
    await composer(page).fill("두 안 비교표를 자료로 올려 줘");
    await composer(page).press("Enter");
    const report = page.locator(".th-card", { hasText: "두 안 비교표를 올렸습니다" });
    await report.waitFor({ timeout: 25_000 });
    await settled();

    const worker = fakeCalls("서윤")[0]!;
    expect(worker.prompt).toContain("[총괄] 서윤에게");
    const { files } = await projectState();
    const kinds = Object.fromEntries(files.map((f: FileDoc) => [f.title, f.kind]));
    expect(kinds).toMatchObject({ "결제 방식 두 안 비교": "artifact", "결제 수단별 수치": "table", "결제 화면 시안": "image", "결제 설정 파일": "code", "개편 배경": "document" });

    await report.locator(".th-link", { hasText: "결제 방식 두 안 비교" }).click();
    await page.getByRole("button", { name: "실행", exact: true }).click();
    const frame = page.frameLocator("iframe.afr-frame");
    await frame.locator("h1").waitFor();
    expect(await frame.locator("#compare tbody tr").count()).toBe(3);
    expect(await page.locator("iframe.afr-frame").getAttribute("sandbox")).toBe("allow-scripts");
    // 키트가 깔렸고 작성자 스크립트가 돈다.
    expect(await frame.locator(".kpi b").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(18);
    await frame.locator("#ping").click();
    await frame.getByText("스크립트 돎").waitFor();
    await page.locator(".fl-chip").first().waitFor();
    // 머리말의 지금 상황은 마크다운 기호 없이 보인다.
    expect(await page.locator(".shell__now").innerText()).toBe("서윤이 결제 방식 비교표를 정리했습니다. 대표의 결정을 기다립니다.");

    // 종류별 보기
    const id = (title: string) => files.find((f) => f.title === title)!.id;
    await page.goto(`${base}/${hash("files", id("결제 수단별 수치"))}`);
    await page.getByRole("cell", { name: "간편결제" }).waitFor();
    await page.goto(`${base}/${hash("files", id("결제 설정 파일"))}`);
    await page.getByText('"gateway"').waitFor();
    await page.goto(`${base}/${hash("files", id("결제 화면 시안"))}`);
    await page.getByRole("button", { name: /시안\.png 크게 보기/ }).locator("img").waitFor();
    await page.close();
  }, 60_000);

  test("편입 창: headless 면 터미널 안내만, herdr 면 세션 목록·바뀌는 것·경고가 나온다", async () => {
    const guide = await open(deskCtx, hash("team"));
    await guide.locator(".tm-adopt-entry").getByRole("button", { name: "기존 세션 편입" }).click();
    await guide.locator(".tm-join").waitFor();
    expect(await guide.locator(".tm-adopt").innerText()).toContain("실행 방식이 herdr 일 때만");
    await guide.close();

    const page = await deskCtx.newPage();
    watch(page, "데스크톱");
    await page.addInitScript((code) => {
    // 아티팩트 칸(불투명 출처)에서도 돌므로 맨 위 문서에서만 적는다.
    if (window.top === window) localStorage.setItem("iamceo.accessCode", code);
  }, CODE);
    await page.route("**/api/bootstrap", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Bootstrap;
      await route.fulfill({ response: res, json: { ...body, cli: "iamceo", settings: { ...body.settings, backend: "herdr" }, herdr: { ...body.herdr, installed: true, running: true, compatible: true, version: "0.5.0", protocol: 22, warning: null } } });
    });
    await page.route("**/api/herdr/agents", (route) =>
      route.fulfill({ json: [
        { paneId: "w2:p1", name: "결제 조사", agent: "claude", status: "idle", cwd: "~/work/payment", sessionId: "11111111", workspaceId: "w2", tabId: "w2:t1", adopted: false },
        { paneId: "w2:p2", name: "로그 분석", agent: "claude", status: "working", cwd: "~/work/logs", sessionId: "22222222", workspaceId: "w2", tabId: "w2:t1", adopted: false },
        { paneId: "w2:p3", name: "코덱스", agent: "codex", status: "idle", cwd: "~/work", sessionId: null, workspaceId: "w2", tabId: "w2:t1", adopted: false },
      ] }),
    );
    await page.route("**/adopt/preview*", (route) => {
      const busy = new URL(route.request().url()).searchParams.get("pane") === "w2:p2";
      route.fulfill({ json: {
        paneId: busy ? "w2:p2" : "w2:p1", name: busy ? "로그 분석" : "결제 조사", cwd: "~/work/payment", status: busy ? "working" : "idle", sessionId: "11111111",
        screen: "> PG사 문서 요약해 줘\n\n요약을 끝냈습니다. 수수료는 카드 2.5% 입니다.\n\n> ",
        refuse: busy ? "일하는 중입니다. 지금 턴이 끝나면 다시 시도하세요" : null,
        warnings: busy ? [] : [{ kind: "conductor", text: "다른 지휘자의 흔적이 있습니다. 이 세션의 규칙이 다른 지휘자와 겹칠 수 있습니다." }, { kind: "folder", text: "이 프로젝트 폴더가 아닙니다." }],
      } });
    });
    await page.goto(`${base}/${hash("team")}`);
    await page.locator(".tm-adopt-entry").getByRole("button", { name: "기존 세션 편입" }).click();
    const form = page.locator(".tm-adopt");
    await form.waitFor();
    const what = await form.locator(".tm-adopt__what").innerText();
    expect(what).toContain("칸은 그대로입니다");
    expect(what).toContain("편입 해제");
    expect(await form.innerText()).toContain("다른 CLI 세션 1개는 받을 수 없습니다");
    await form.locator("label.choice", { hasText: "로그 분석" }).click();
    await form.locator(".tm-hint", { hasText: "일하는 중입니다" }).waitFor();
    expect(await form.getByRole("button", { name: "편입", exact: true }).isDisabled()).toBe(true);
    await form.locator("label.choice", { hasText: "결제 조사" }).click();
    await form.getByText("요약을 끝냈습니다").waitFor();
    expect(await form.getByText("다른 지휘자의 흔적").count()).toBe(1);
    expect(await form.getByRole("button", { name: "편입", exact: true }).isDisabled()).toBe(false);
    await form.getByRole("textbox", { name: "이름" }).fill("결제 조사");
    await form.getByRole("textbox", { name: "역할" }).fill("PG사 문서 조사");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, "desk-adopt.png") });
    await page.close();
  }, 40_000);

  test("설정 하나: 권한 3종·직급 모델을 바꾸면 다음 턴 인자와 서브에이전트 환경변수에 바로 들어간다", async () => {
    // 바꾸기 전: 바이패스, 모델 인자 없음, 서브에이전트 변수 없음.
    await settled();
    const plain = fakeCalls("총괄").at(-1)!;
    expect(argOf(plain, "--permission-mode")).toBe("bypassPermissions");
    expect(argOf(plain, "--model")).toBeNull();
    // effort 는 비워 두지 않는다. 비면 세션을 다시 열 때 CLI 기본값으로 돌아간다.
    expect(argOf(plain, "--effort")).not.toBeNull();
    expect(plain.subagentModel).toBeNull();

    const page = await open(deskCtx, hash("team"));
    await page.getByRole("link", { name: "설정" }).first().click();
    await page.waitForURL(/#\/settings$/);
    const panels = page.locator(".st");
    await page.locator("#st-permission").waitFor();
    // 옛 프로젝트 설정 주소도 같은 화면이다.
    await page.goto(`${base}/#/settings/${projectId}`);
    await page.waitForURL(/#\/settings$/);
    await page.locator("#st-permission").waitFor();
    const radios = page.locator("input[name='st-default-permission']");
    expect(await radios.count()).toBe(3);
    expect(await radios.nth(0).isChecked()).toBe(true);
    const permText = (await page.locator(".st-perms").innerText()).replace(/\s+/g, " ");
    for (const word of ["바이패스", "오토", "모두 승인", "기본"]) expect(permText).toContain(word);
    // 부장·팀장·직원 세 줄과 각 칸.
    for (const rank of ["부장", "팀장", "직원"]) {
      expect(await page.getByLabel(`${rank} 모델`, { exact: true }).count()).toBe(1);
      expect(await page.getByLabel(`${rank} effort`).count()).toBe(1);
    }
    // 서브에이전트 effort 안내를 띄우지 않는다.
    expect(await panels.innerText()).not.toMatch(/강제|보장되지|보장하지|권고|참고용/);

    await radios.nth(1).check();
    await page.getByLabel("부장 모델", { exact: true }).selectOption("opus");
    await page.getByLabel("부장 effort").selectOption("high");
    await page.getByLabel("팀장 모델", { exact: true }).selectOption("sonnet");
    await page.getByLabel("팀장 effort").selectOption("medium");
    await page.getByLabel("직원 모델", { exact: true }).selectOption("haiku");
    await page.getByLabel("직원 effort").selectOption("low");
    const bar = page.locator(".st-bar");
    await bar.getByRole("button", { name: "저장" }).click();
    await bar.getByText("저장했습니다").waitFor();
    await bar.waitFor({ state: "detached", timeout: 8000 });
    await page.close();

    const conductor = await turnArgs("총괄", "오늘 진행 상황을 다시 봐 주세요", null);
    expect(argOf(conductor, "--permission-mode")).toBe("auto");
    expect(argOf(conductor, "--model")).toBe("opus");
    expect(argOf(conductor, "--effort")).toBe("high");
    expect(conductor.subagentModel).toBe("haiku");
    expect(conductor.subagentForce).toBe("1");
    // 세션은 끊기지 않는다.
    expect(argOf(conductor, "--resume")).not.toBeNull();
    await settled();

    const seoyun = await memberNamed("서윤");
    const worker = await turnArgs("서윤", "비교표 수치를 다시 봐 주세요", seoyun.id);
    expect(argOf(worker, "--permission-mode")).toBe("auto");
    expect(argOf(worker, "--model")).toBe("sonnet");
    expect(argOf(worker, "--effort")).toBe("medium");
    expect(worker.subagentModel).toBe("haiku");
    expect(worker.subagentForce).toBe("1");
    // 서브에이전트 effort 는 규칙 파일로 들어간다.
    expect(readFileSync(argOf(worker, "--append-system-prompt-file")!, "utf8")).toContain("effort=low");
    await settled();
    const fresh = await memberNamed("서윤");
    expect(fresh).toMatchObject({ appliedModel: "sonnet", appliedEffort: "medium", modelOverride: null, effortOverride: null });

    // 세 번째 모드도 그대로 넘어간다.
    await api("PUT", "/api/settings", { permissionMode: "default" });
    const strict = await turnArgs("서윤", "표 제목을 다시 봐 주세요", seoyun.id);
    expect(argOf(strict, "--permission-mode")).toBe("default");
    await settled();
    await api("PUT", "/api/settings", { permissionMode: "bypassPermissions" });
  }, 60_000);

  test("직원별 덮어쓰기: 그 직원만 바뀌고, 지우면 직급 값으로 돌아간다", async () => {
    const seoyun = await memberNamed("서윤");
    const page = await open(deskCtx, hash("team", seoyun.id));
    const model = page.getByRole("combobox", { name: "모델" });
    await model.waitFor();
    expect(await model.locator("option").first().innerText()).toContain("sonnet");
    const settledSelect = (label: string) => page.waitForFunction((l) => !(document.querySelector(`select[aria-label="${l}"]`) as HTMLSelectElement).disabled, label);
    await model.selectOption("haiku");
    await settledSelect("모델");
    await page.getByRole("combobox", { name: "effort" }).selectOption("xhigh");
    await settledSelect("effort");
    await until("덮어쓰기 저장", () => memberNamed("서윤"), (m) => m.modelOverride === "haiku" && m.effortOverride === "xhigh");

    const overridden = await turnArgs("서윤", "일정 칸을 다시 봐 주세요", seoyun.id);
    expect(argOf(overridden, "--model")).toBe("haiku");
    expect(argOf(overridden, "--effort")).toBe("xhigh");
    expect(argOf(overridden, "--resume")).toBe(seoyun.sessionId);
    await settled();

    // 다른 세션은 그대로.
    const conductor = await turnArgs("총괄", "남은 일을 다시 봐 주세요", null);
    expect(argOf(conductor, "--model")).toBe("opus");
    expect(argOf(conductor, "--effort")).toBe("high");
    await settled();

    await model.selectOption("");
    await settledSelect("모델");
    await page.getByRole("combobox", { name: "effort" }).selectOption("");
    await settledSelect("effort");
    await until("덮어쓰기 해제", () => memberNamed("서윤"), (m) => m.modelOverride === null && m.effortOverride === null);
    await page.close();
    const back = await turnArgs("서윤", "권장안 문구를 다시 봐 주세요", seoyun.id);
    expect(argOf(back, "--model")).toBe("sonnet");
    expect(argOf(back, "--effort")).toBe("medium");
    await settled();
  }, 60_000);

  test("최종 화면 캡처: 넘침·가림이 없다", async () => {
    // 팀 화면에 일하는 모습과 카드가 보이게 직접 붙은 세션으로 조금 더 채운다.
    const joined = await api<{ member: Member; token: string }>("POST", "/agent/join", { project: projectId, name: "하늘", role: "문구 다듬기", handle: "haneul" });
    const agent = (name: string, args: unknown) =>
      fetch(`${base}/agent/tool`, { method: "POST", headers: { Authorization: `Bearer ${joined.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, args }) });
    await agent("status", { now: "완료 화면 문구를 다듬는 중", next: "실패 화면 문구" });
    await agent("post", { kind: "진행", title: "완료 화면 문구 초안을 정리했습니다", body: "- 짧게 한 줄\n- 다음 행동 안내 한 줄" });

    const seoyun = await memberNamed("서윤");
    const artifactId = (await projectState()).files.find((f) => f.kind === "artifact")!.id;
    const shots: [string, string, BrowserContext, (page: Page) => Promise<unknown>][] = [
      ["desk-home", hash("home"), deskCtx, (p) => p.locator(".hm-todo").first().waitFor()],
      ["phone-home", hash("home"), phoneCtx, (p) => p.locator(".hm-todo").first().waitFor()],
      ["desk-inbox", hash("inbox"), deskCtx, (p) => p.locator(".ibx-card").first().waitFor()],
      ["phone-inbox", hash("inbox"), phoneCtx, (p) => p.locator(".ibx-card").first().waitFor()],
      ["desk-team", hash("team"), deskCtx, (p) => p.locator(".tm-card").first().waitFor()],
      ["phone-team", hash("team"), phoneCtx, (p) => p.locator(".tm-card").first().waitFor()],
      ["desk-member", hash("team", seoyun.id), deskCtx, (p) => p.getByRole("combobox", { name: "모델" }).waitFor()],
      ["desk-thread", hash("thread"), deskCtx, (p) => p.locator(".th-card").first().waitFor()],
      ["phone-thread", hash("thread"), phoneCtx, (p) => p.locator(".th-card").first().waitFor()],
      ["desk-files", hash("files"), deskCtx, (p) => p.locator(".fl-row").first().waitFor()],
      ["phone-files", hash("files"), phoneCtx, (p) => p.locator(".fl-row").first().waitFor()],
      ["desk-artifact", hash("files", artifactId), deskCtx, async (p) => { await p.getByRole("button", { name: "실행", exact: true }).click(); await p.frameLocator("iframe.afr-frame").locator("h1").waitFor(); }],
      ["phone-artifact", hash("files", artifactId), phoneCtx, async (p) => { await p.getByRole("button", { name: "실행", exact: true }).click(); await p.frameLocator("iframe.afr-frame").locator("h1").waitFor(); }],
      ["desk-settings", "#/settings", deskCtx, (p) => p.locator("#st-permission").waitFor()],
      ["phone-settings", "#/settings", phoneCtx, (p) => p.locator("#st-permission").waitFor()],
    ];
    for (const [name, where, ctx, ready] of shots) {
      const page = await open(ctx, where);
      await ready(page);
      // 첫 할 일을 펼친 모습까지 보여 준다.
      if (name.endsWith("-home")) await page.locator(".hm-todo__toggle").first().click();
      await page.waitForTimeout(450);
      await shot(page, name);
      await page.close();
    }
    for (const name of ["desk-gate", "desk-inbox-done", "desk-adopt", "desk-setup"]) expect(existsSync(join(SHOTS, `${name}.png`))).toBe(true);
  }, 90_000);

  test("전체 점검: 브라우저 오류가 없다", () => {
    expect(browserErrors).toEqual([]);
  });
});
