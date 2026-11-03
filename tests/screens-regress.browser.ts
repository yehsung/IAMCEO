// 화면 쪽 회귀 시험: 실제 서버 + Playwright chromium + 가짜 claude. 라이브 herdr·실제 ~/.iamceo·실제 claude 를 쓰지 않는다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Decision, Member, Message, Project, ProjectState } from "../shared/types.ts";
import { updateConfigFile } from "../server/config.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "bin", "iamceo.ts");
const FAKE = join(ROOT, "tests", "fixtures", "fake-claude.ts");
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-e2e-regress-")));
const HOME = join(WORK, "home");
const PROJECT_DIR = join(WORK, "project");
mkdirSync(PROJECT_DIR);
const CODE = "regress-code";

const STRIP = /^(HERDR_.*|CLAUDECODE|CLAUDE_CODE_.*)$/;
function env(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.test(k)) out[k] = v;
  return { ...out, IAMCEO_HOME: HOME, IAMCEO_TEST: "1", IAMCEO_CLAUDE_BIN: FAKE, IAMCEO_HERDR_SOCKET: join(WORK, "none.sock"), FAKE_CLAUDE_LOG: join(WORK, "fake.jsonl"), FAKE_CLAUDE_SESSIONS: join(WORK, "sessions"), ...extra };
}

let server: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let browser: Browser;
let desktop: BrowserContext;
let phone: BrowserContext;

async function startServer(port: number) {
  updateConfigFile({ accessCode: CODE, port, hosts: ["127.0.0.1"] }, { IAMCEO_HOME: HOME });
  const proc = Bun.spawn([process.execPath, CLI, "serve"], { cwd: ROOT, env: env({ IAMCEO_PORT: String(port) }), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) return { proc, url };
    await Bun.sleep(80);
  }
  throw new Error("서버가 뜨지 않음");
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port!;
  s.stop(true);
  return port;
}

const api = async <T,>(method: string, path: string, body?: unknown, token = CODE): Promise<T> => {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

let counter = 0;
async function newProject(name = `프로젝트 ${++counter}`): Promise<Project> {
  const dir = join(PROJECT_DIR, String(++counter));
  mkdirSync(dir, { recursive: true });
  return api<Project>("POST", "/api/projects", { name, cwd: dir });
}

async function joinWorker(projectId: string, name: string): Promise<{ member: Member; token: string }> {
  return api("POST", "/agent/join", { project: projectId, name, handle: `w${++counter}` });
}

const tool = (token: string, name: string, args: unknown) => api<{ text: string; wait?: { decisionId: string } }>("POST", "/agent/tool", { name, args }, token);

async function ask(token: string, title: string, options: { k: string; label: string }[], extra: Record<string, unknown> = {}): Promise<string> {
  const r = await tool(token, "ask", { title, detail: `${title} 설명`, options, ...extra });
  return r.wait!.decisionId;
}

const state = (id: string) => api<ProjectState>("GET", `/api/projects/${id}/state`);
const decision = async (projectId: string, id: string): Promise<Decision> => (await state(projectId)).decisions.find((d) => d.id === id)!;

async function open(ctx: BrowserContext, hash: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
  await page.goto(`${base}/${hash}`);
  return page;
}

/** 소켓이 hello 만 받고 멈춘 페이지. 응답을 잃어도 이벤트로 알 길이 없다. */
async function openDeadSocket(ctx: BrowserContext, hash: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
  await page.routeWebSocket(/\/ws/, (socket) => {
    const up = socket.connectToServer();
    up.onMessage((m) => {
      if (String(m).includes('"hello"')) socket.send(m);
    });
  });
  await page.goto(`${base}/${hash}`);
  await page.locator(".conn[data-state='online']").waitFor();
  await page.waitForTimeout(400);
  return page;
}

async function inbox(ctx: BrowserContext, projectId: string): Promise<Page> {
  const page = await open(ctx, `#/p/${projectId}/inbox`);
  await page.locator(".ibx").waitFor();
  return page;
}

const input = (page: Page) => page.getByRole("textbox", { name: "입력칸" });
/** 결재 2단계: 선택지를 고르고, 읽을 틈 뒤 확인 버튼을 누른다. */
const confirmCard = async (page: Page, title: string, option: string) => {
  const card = page.locator(".ibx-card", { hasText: title });
  await card.locator(".ibx-opt", { hasText: option }).click();
  await page.waitForTimeout(650);
  await card.locator(".ibx-confirm__go").click();
};
const until = async (label: string, cond: () => Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`${label} 시간 초과`);
    await Bun.sleep(40);
  }
};

beforeAll(async () => {
  mkdirSync(HOME, { recursive: true });
  const port = freePort();
  const started = await startServer(port);
  server = started.proc;
  base = started.url;
  await api("PUT", "/api/settings", { backend: "headless" });
  browser = await chromium.launch();
  desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  desktop.setDefaultTimeout(10_000);
  phone.setDefaultTimeout(10_000);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
  await server?.exited;
});

describe("마크다운", () => {
  test("style 로 화면을 덮을 수 없고, 꺾쇠 낱말은 글자로 남고, 외부 이미지는 요청이 나가지 않는다", async () => {
    const hits: string[] = [];
    const outside = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(new URL(req.url).pathname);
        return new Response("x");
      },
    });
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const cover = `<div style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:#fff"><h1>세션이 만료되었습니다</h1><a href="http://evil.example/login">접속 코드 다시 입력</a></div>`;
    await tool(w.token, "post", { kind: "알림", title: "덮개", body: `${cover}\n\n<Composer> 를 고쳤고 <div> 를 지웠고 Array<string> 을 쓴다\n\n<Button> 눌러서\n\n[앱 안 링크](#/p/${p.id}/files/f_x) [바깥 링크](https://example.com)` });
    await ask(w.token, "결재 위조", [{ k: "pay", label: "1억 결제" }, { k: "no", label: "거절" }], {
      detail: `<div style="position:absolute;inset:0;z-index:5;background:#17132b;pointer-events:none">안전한 문구 수정 승인</div>\n\n<img src="http://127.0.0.1:${outside.port}/raw.gif">\n\n![그림](http://127.0.0.1:${outside.port}/md.gif)`,
    });
    const page = await open(desktop, `#/p/${p.id}/thread`);
    await page.locator(".th-card", { hasText: "덮개" }).waitFor();
    const md = page.locator(".th-card", { hasText: "덮개" }).locator(".th-md");
    expect(await md.locator("[style], button, h1").count()).toBe(0);
    const shown = await md.innerText();
    for (const word of ["<Composer>", "<div>", "Array<string>", "<Button>"]) expect(shown).toContain(word);
    expect(await md.getByRole("link", { name: "앱 안 링크" }).getAttribute("target")).toBe(null);
    expect(await md.getByRole("link", { name: "바깥 링크" }).getAttribute("target")).toBe("_blank");
    const center = await page.evaluate(() => document.elementFromPoint(720, 450)?.closest("[style*='fixed']") === null);
    expect(center).toBe(true);

    const box = await inbox(desktop, p.id);
    const card = box.locator(".ibx-card", { hasText: "결재 위조" });
    await card.waitFor();
    expect(await box.title()).toMatch(/^\(\d+\) IAMCEO$/); // 다른 창에서도 탭 제목으로 안다
    expect(await card.locator(".ibx-detail [style]").count()).toBe(0);
    expect(await card.locator(".ibx-detail img").count()).toBe(0);
    expect(await card.getByRole("button", { name: "1억 결제" }).isVisible()).toBe(true);
    expect(await card.locator(".ibx-opt").first().innerText()).toContain("1억 결제");
    await Bun.sleep(300);
    expect(hits).toEqual([]);
    const headers = await fetch(`${base}/`);
    expect(headers.headers.get("content-security-policy")).toContain("img-src 'self' data: blob:");
    outside.stop(true);
    await page.close();
    await box.close();
  }, 40_000);
});

describe("결재함 오조작", () => {
  test("선택지를 눌러도 나가지 않고, 확인을 눌러야 간다. 폰 더블탭·겹 탭도 다음 카드를 승인하지 않는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const first = await ask(w.token, "첫 카드", [{ k: "a", label: "A 안" }, { k: "b", label: "B 안" }]);
    const second = await ask(w.token, "둘째 카드", [{ k: "del", label: "삭제 진행" }, { k: "keep", label: "보류" }]);
    const page = await inbox(phone, p.id);
    const card = page.locator(".ibx-card", { hasText: "첫 카드" });
    const opt = card.locator(".ibx-opt", { hasText: "B 안" });
    await opt.scrollIntoViewIfNeeded();
    const b = (await opt.boundingBox())!;
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(150);
    expect((await decision(p.id, first)).status).toBe("open");
    expect(await card.locator(".ibx-confirm__go").textContent()).toBe("'B 안'(으)로 결정");
    // 다른 선택지를 누르면 바뀌고, 취소하면 사라진다.
    await card.locator(".ibx-opt", { hasText: "A 안" }).tap();
    expect(await card.locator(".ibx-confirm__go").textContent()).toBe("'A 안'(으)로 결정");
    await card.getByRole("button", { name: "취소" }).tap();
    expect(await card.locator(".ibx-confirm").count()).toBe(0);
    expect((await decision(p.id, first)).status).toBe("open");
    // 나타난 직후의 누름(더블탭의 둘째)은 받지 않는다.
    await card.locator(".ibx-opt", { hasText: "B 안" }).tap();
    await card.locator(".ibx-confirm__go").tap();
    await page.waitForTimeout(150);
    expect((await decision(p.id, first)).status).toBe("open");
    await page.waitForTimeout(650);
    await card.locator(".ibx-confirm__go").tap();
    await until("첫 답", async () => (await decision(p.id, first)).status !== "open");
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(150);
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(800);
    expect((await decision(p.id, second)).status).toBe("open");
    expect((await decision(p.id, first)).choice).toBe("b");
    await page.close();
  }, 40_000);

  test("메모 포함·자유 답·메모만 답도 같은 2단계다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const withMemo = await ask(w.token, "메모와 함께", [{ k: "a", label: "가" }]);
    const free = await ask(w.token, "자유 답 카드", []);
    const memoOnly = await ask(w.token, "메모만 카드", [{ k: "a", label: "가" }]);
    const page = await inbox(desktop, p.id);
    await page.locator(".ibx-card", { hasText: "메모와 함께" }).getByRole("textbox", { name: "메모" }).fill("조건 있음");
    await confirmCard(page, "메모와 함께", "가");
    await until("메모 답", async () => (await decision(p.id, withMemo)).note === "조건 있음");
    const freeCard = page.locator(".ibx-card", { hasText: "자유 답 카드" });
    await freeCard.getByRole("textbox", { name: "답" }).fill("내일 합시다");
    await freeCard.getByRole("textbox", { name: "답" }).press("Enter");
    await page.waitForTimeout(650);
    expect((await decision(p.id, free)).status).toBe("open");
    expect(await freeCard.locator(".ibx-confirm__go").textContent()).toBe("'내일 합시다'(으)로 결정");
    await freeCard.locator(".ibx-confirm__go").click();
    await until("자유 답", async () => (await decision(p.id, free)).note === "내일 합시다");
    const memoCard = page.locator(".ibx-card", { hasText: "메모만 카드" });
    await memoCard.getByRole("textbox", { name: "메모" }).fill("다시 생각해 봐요");
    await memoCard.getByRole("button", { name: "메모만 보내기" }).dblclick();
    await page.waitForTimeout(650);
    expect((await decision(p.id, memoOnly)).status).toBe("open");
    await memoCard.getByRole("button", { name: "메모만 보내기로 결정" }).click();
    await until("메모만", async () => (await decision(p.id, memoOnly)).note === "다시 생각해 봐요");
    await page.close();
  }, 30_000);

  test("묶음 추천: 더블클릭은 확인이 아니고, 읽을 틈을 둔 둘째 누름만 보낸다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push(await ask(w.token, `묶음 ${n}`, [{ k: "a", label: "가" }], { rec: "a", group: "묶음" }));
    const page = await inbox(desktop, p.id);
    const button = page.getByRole("button", { name: "이 묶음 추천대로" });
    await button.dblclick();
    await page.waitForTimeout(300);
    for (const id of ids) expect((await decision(p.id, id)).status).toBe("open");
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "묶음 3건 결정" }).click();
    await until("묶음 전달", async () => (await decision(p.id, ids[0]!)).status !== "open");
    await page.close();
  }, 30_000);

  test("메모 쓰는 중 같은 묶음 카드가 와도 초점과 글이 남는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    await ask(w.token, "낱장", [{ k: "a", label: "가" }], { group: "새묶음" });
    const page = await inbox(desktop, p.id);
    const memo = page.locator(".ibx-card", { hasText: "낱장" }).getByRole("textbox", { name: "메모" });
    await memo.click();
    await memo.pressSequentially("메모 쓰는 중");
    await ask(w.token, "같은 묶음 둘째", [{ k: "a", label: "가" }], { group: "새묶음" });
    await page.locator(".ibx-card", { hasText: "같은 묶음 둘째" }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
    await page.keyboard.type("XYZ");
    expect(await memo.inputValue()).toBe("메모 쓰는 중XYZ");
    await page.close();
  }, 30_000);

  test("키보드로 답하면 초점이 문서 처음으로 날아가지 않는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    await ask(w.token, "키보드 카드", [{ k: "a", label: "가" }]);
    const page = await inbox(desktop, p.id);
    const keyCard = page.locator(".ibx-card", { hasText: "키보드 카드" });
    await keyCard.locator(".ibx-opt", { hasText: "가" }).focus();
    await page.keyboard.press("Enter");
    await keyCard.locator(".ibx-confirm__go").waitFor();
    await page.waitForTimeout(650);
    await keyCard.locator(".ibx-confirm__go").focus();
    await page.keyboard.press("Enter");
    await page.locator(".ibx-card--answered", { hasText: "키보드 카드" }).waitFor();
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-answered-card") ?? document.activeElement?.tagName)).not.toBe("BODY");
    await page.close();
  }, 30_000);

  test("이미 처리된 카드에 409 가 오면 실제 답으로 바뀐다(소켓이 죽어 있어도)", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const id = await ask(w.token, "두 곳에서 답", [{ k: "a", label: "A안" }, { k: "b", label: "B안" }]);
    const page = await openDeadSocket(desktop, `#/p/${p.id}/inbox`);
    const card = page.locator(".ibx-card", { hasText: "두 곳에서 답" });
    await card.waitFor();
    await api("POST", `/api/decisions/${id}/answer`, { choice: "a" });
    await confirmCard(page, "두 곳에서 답", "B안");
    await page.locator(".ibx-answered__text", { hasText: "답: A안" }).waitFor({ timeout: 5000 });
    await page.close();
  }, 30_000);

  test("대화의 결재 링크가 그 카드로 간다. 처리된 카드면 결재된 항목 쪽을 연다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const ids: string[] = [];
    for (let n = 1; n <= 12; n++) ids.push(await ask(w.token, `결재 ${n}번`, [{ k: "a", label: "가" }], { detail: "내용 ".repeat(120) }));
    await api("POST", `/api/decisions/${ids[0]}/answer`, { choice: "a" });
    await tool(w.token, "wait", { timeout_sec: 1 }); // 받아서 처리됨으로
    const page = await open(desktop, `#/p/${p.id}/thread`);
    const last = page.locator(".th-card", { hasText: "결재 12번" }).getByRole("link", { name: /결재함에서 답하기/ });
    await last.click();
    await page.waitForURL(/inbox/);
    await until("카드가 화면에", async () =>
      page.evaluate((id) => {
        const r = document.querySelector(`[data-decision="${id}"]`)?.getBoundingClientRect();
        return !!r && r.top >= 0 && r.top < innerHeight;
      }, ids[11]!),
    );
    await page.goto(`${base}/#/p/${p.id}/thread`);
    const done = page.locator(".th-card", { hasText: "결재 1번" }).getByRole("link", { name: /답함/ });
    await done.scrollIntoViewIfNeeded();
    await done.click();
    await until("결재된 항목 카드", async () => (await page.locator(`.ibx-done [data-decision="${ids[0]}"]`).count()) > 0);
    expect(await page.locator(".ibx-seg__item[aria-current]").innerText()).toContain("결재된 항목");
    await page.locator(`.ibx-done [data-decision="${ids[0]}"] .ibx-detail`).waitFor(); // 펼쳐 둔다
    await page.close();
  }, 40_000);
});

describe("입력칸", () => {
  test("'@이름 글'의 응답이 유실돼도 다시 보내면 한 번만 전달된다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "민수");
    const page = await openDeadSocket(desktop, `#/p/${p.id}/thread`);
    let dropped = false;
    await page.route(`**/api/projects/${p.id}/messages`, async (route) => {
      if (route.request().method() !== "POST" || dropped) return route.fallback();
      dropped = true;
      await route.fetch();
      await route.abort();
    });
    await input(page).fill(`@민수 배포 진행해`);
    await input(page).press("Enter");
    await page.locator(".cmp__error").waitFor();
    expect(await input(page).inputValue()).toBe("배포 진행해");
    const mine = async () => (await state(p.id)).messages.filter((m) => m.mine);
    await input(page).press("Enter");
    await until("재전송", async () => (await page.locator(".cmp__error").count()) === 0);
    await page.waitForTimeout(300);
    const sent = await mine();
    expect(sent.map((m: Message) => [m.body, m.targetMemberId])).toEqual([["배포 진행해", w.member.id]]);
    await page.close();
  }, 30_000);

  test("응답만 잃은 글: 서버에 있으면 입력칸과 실패 표시가 저절로 비워진다", async () => {
    const p = await newProject();
    const page = await openDeadSocket(desktop, `#/p/${p.id}/thread`);
    let dropped = false;
    await page.route(`**/api/projects/${p.id}/messages`, async (route) => {
      if (route.request().method() !== "POST" || dropped) return route.fallback();
      dropped = true;
      await route.fetch();
      await route.abort();
    });
    await input(page).fill("응답 유실 글");
    await input(page).press("Enter");
    await page.locator(".cmp__error").waitFor();
    expect(await input(page).inputValue()).toBe("응답 유실 글");
    await until("입력칸 비움", async () => (await input(page).inputValue()) === "" && (await page.locator(".cmp__error").count()) === 0, 10_000);
    await page.close();
  }, 30_000);

  test("초안·결재 메모·실패 글은 새로고침 뒤에도 남고, 보내면 지워진다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    await ask(w.token, "메모 카드", [{ k: "a", label: "가" }]);
    const page = await inbox(desktop, p.id);
    await input(page).fill("긴 지시를 쓰는 중");
    await page.locator(".ibx-card", { hasText: "메모 카드" }).getByRole("textbox", { name: "메모" }).fill("조건을 길게");
    await page.reload();
    await page.locator(".ibx-card", { hasText: "메모 카드" }).waitFor();
    expect(await input(page).inputValue()).toBe("긴 지시를 쓰는 중");
    expect(await page.locator(".ibx-card", { hasText: "메모 카드" }).getByRole("textbox", { name: "메모" }).inputValue()).toBe("조건을 길게");
    await input(page).press("Enter");
    await until("보냄", async () => (await input(page).inputValue()) === "");
    await page.reload();
    await input(page).waitFor();
    await page.waitForTimeout(200);
    expect(await input(page).inputValue()).toBe("");
    await page.close();
  }, 30_000);

  test("터치 기기: Enter 는 줄바꿈, 보내기 버튼으로 전송. 보낸 뒤 대상은 기본으로", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "민수");
    const page = await open(phone, `#/p/${p.id}/thread`);
    await input(page).waitFor();
    expect(await input(page).getAttribute("enterkeyhint")).toBe("enter");
    await input(page).fill("첫 줄");
    await input(page).press("Enter");
    await input(page).pressSequentially("둘째 줄");
    expect(await input(page).inputValue()).toBe("첫 줄\n둘째 줄");
    expect((await state(p.id)).messages.filter((m) => m.mine)).toHaveLength(0);
    await page.locator(".cmp-chip--target").click();
    await page.locator(".cmp-menu__item", { hasText: "민수" }).click();
    await page.getByRole("button", { name: "보내기" }).click();
    await until("전송", async () => (await state(p.id)).messages.some((m) => m.mine));
    expect((await state(p.id)).messages.find((m) => m.mine)).toMatchObject({ body: "첫 줄\n둘째 줄", targetMemberId: w.member.id });
    await page.locator(".cmp-chip--target:not([data-direct])").waitFor();
    await page.close();
  }, 30_000);

  test("데스크톱은 Enter 전송을 유지한다", async () => {
    const p = await newProject();
    const page = await open(desktop, `#/p/${p.id}/thread`);
    await input(page).fill("데스크톱 글");
    expect(await input(page).getAttribute("enterkeyhint")).toBe("send");
    await input(page).press("Enter");
    await until("전송", async () => (await state(p.id)).messages.some((m) => m.mine && m.body === "데스크톱 글"));
    await page.close();
  }, 30_000);

  test("첨부가 많아도 입력칸이 화면을 다 먹지 않고 대상 칩·빼기 버튼에 닿는다", async () => {
    const p = await newProject();
    const page = await open(phone, `#/p/${p.id}/thread`);
    await input(page).waitFor();
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `아주아주아주아주아주아주긴파일이름_${i}.txt`, mimeType: "text/plain", buffer: Buffer.from("x") }));
    await page.locator("input[type=file]").setInputFiles(files);
    await until("첨부 준비", async () => (await page.locator(".cmp-chip--file[data-state='ready']").count()) === 12);
    const h = await page.locator(".cmp__meta").evaluate((el) => el.getBoundingClientRect().height);
    expect(h).toBeLessThanOrEqual(112);
    const top = await page.locator(".shell__bottom").evaluate((el) => el.getBoundingClientRect().top);
    expect(top).toBeGreaterThan(0);
    await page.close();
  }, 30_000);

  test("직원 직접 지시칸도 Safari 조합 중 Enter(keyCode 229)로 보내지 않는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const page = await open(desktop, `#/p/${p.id}/team/${w.member.id}`);
    const direct = page.locator(".tm-send__input");
    await direct.fill("조합 중");
    await direct.evaluate((el) => {
      const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      Object.defineProperty(e, "keyCode", { get: () => 229 });
      el.dispatchEvent(e);
    });
    await page.waitForTimeout(150);
    expect(await direct.inputValue()).toBe("조합 중");
    expect((await state(p.id)).messages.filter((m) => m.mine)).toHaveLength(0);
    await page.close();
  }, 30_000);
});

describe("연결", () => {
  test("소켓이 조용히 멈춰도 온라인 복귀에 새로 잇는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const page = await desktop.newPage();
    await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    let sockets = 0;
    let freeze = true;
    await page.routeWebSocket(/\/ws/, (socket) => {
      sockets++;
      const n = sockets;
      const up = socket.connectToServer();
      up.onMessage((m) => {
        // 첫 소켓만 hello 뒤로 멈춘다.
        if (n > 1 || !freeze || String(m).includes('"hello"')) socket.send(m);
      });
    });
    await page.goto(`${base}/#/p/${p.id}/inbox`);
    await page.locator(".conn[data-state='online']").waitFor();
    await ask(w.token, "멈춘 동안 온 카드", [{ k: "a", label: "가" }]);
    await page.waitForTimeout(400);
    expect(await page.locator(".ibx-card", { hasText: "멈춘 동안 온 카드" }).count()).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.locator(".ibx-card", { hasText: "멈춘 동안 온 카드" }).waitFor({ timeout: 5000 });
    expect(sockets).toBe(2);
    await ask(w.token, "새 소켓으로 온 카드", [{ k: "a", label: "가" }]);
    await page.locator(".ibx-card", { hasText: "새 소켓으로 온 카드" }).waitFor({ timeout: 3000 });
    await page.close();
  }, 30_000);

  test("접속 코드가 바뀌면 코드 입력 화면으로 간다", async () => {
    const port = freePort();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-code-")));
    const homeEnv = { IAMCEO_HOME: home };
    updateConfigFile({ accessCode: CODE, port, hosts: ["127.0.0.1"] }, homeEnv);
    const spawn = () => Bun.spawn([process.execPath, CLI, "serve"], { cwd: ROOT, env: env({ ...homeEnv, IAMCEO_PORT: String(port) }), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const first = { proc: spawn(), url: `http://127.0.0.1:${port}` };
    await until("서버", () => fetch(`${first.url}/api/health`).then((r) => r.ok, () => false), 15000);
    await fetch(`${first.url}/api/settings`, { method: "PUT", headers: { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" }, body: JSON.stringify({ backend: "headless" }) });
    const page = await desktop.newPage();
    await page.addInitScript((code) => {
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem("iamceo.accessCode", code);
      }
    }, CODE);
    await page.goto(`${first.url}/`);
    await page.locator(".conn[data-state='online']").waitFor();
    first.proc.kill("SIGTERM");
    await first.proc.exited;
    updateConfigFile({ accessCode: "new-code-2" }, homeEnv);
    const proc = spawn();
    try {
      await page.getByText("접속 코드가 바뀌었습니다").waitFor({ timeout: 15000 });
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
      await page.close();
    }
  }, 40_000);

  test("다른 곳에서 보관하면 안내와 함께 본사로 돌아오고, 보관 프로젝트에 지시할 수 없다", async () => {
    const p = await newProject();
    const page = await open(desktop, `#/p/${p.id}/thread`);
    await input(page).waitFor();
    await api("PATCH", `/api/projects/${p.id}`, { archived: true });
    await page.getByText("보던 프로젝트가 보관되어").waitFor({ timeout: 5000 });
    await page.waitForURL(/#\/p\/hq\//);
    await page.goto(`${base}/#/p/${p.id}/thread`);
    await page.waitForURL(/#\/p\/hq\//);
    await page.close();
  }, 30_000);

  test("설정은 하나다: 프로젝트마다 들어가는 곳이 없고, 돌아갈 곳은 보던 프로젝트다. 옛 주소도 같은 화면으로 온다", async () => {
    const p = await newProject("설정 대상");
    const page = await open(desktop, `#/p/${p.id}/inbox`);
    await page.locator(".shell__title").waitFor();
    expect(await page.locator(".st-gear").count()).toBe(0);
    await page.locator(".rail__foot a", { hasText: "설정" }).click();
    await page.waitForURL(/#\/settings$/);
    await page.locator(".st-back", { hasText: "설정 대상" }).waitFor();
    await page.locator(`[data-project="${p.id}"]`).waitFor();
    await page.goto(`${base}/#/settings/${p.id}`);
    await page.waitForURL(/#\/settings$/);
    await page.locator(".st-back", { hasText: "설정 대상" }).click();
    await page.waitForURL(new RegExp(`#/p/${p.id}/`));
    await page.close();
  }, 30_000);

  test("설정에서 보던 프로젝트를 보관해도 설정에 머물고, 보관함에서 꺼낸다", async () => {
    const p = await newProject("보관 대상");
    const page = await open(desktop, `#/settings/${p.id}`);
    const row = page.locator(`[data-project="${p.id}"]`);
    await row.getByRole("button", { name: "보관 대상 보관하기" }).click();
    await page.locator("dialog[open]").getByRole("button", { name: "보관", exact: true }).click();
    const restore = page.getByRole("button", { name: "보관 대상 다시 꺼내기" });
    await restore.waitFor();
    expect(page.url().endsWith("#/settings")).toBe(true);
    await page.locator(".st-back", { hasText: "본사" }).waitFor();
    await restore.click();
    await row.getByRole("button", { name: "보관 대상 보관하기" }).waitFor();
    await page.close();
  }, 30_000);

  test("설정에서 프로젝트 이름·폴더를 고친다. 없는 폴더는 거부되고 그 말이 보인다", async () => {
    const p = await newProject("고칠 이름");
    const page = await open(desktop, "#/settings");
    const row = page.locator(`[data-project="${p.id}"]`);
    await row.getByRole("button", { name: "고칠 이름 고치기" }).click();
    await row.getByLabel("폴더").fill(join(PROJECT_DIR, "없는 폴더"));
    await row.getByRole("button", { name: "저장" }).click();
    await row.getByText("폴더가 없습니다").waitFor();
    await row.getByLabel("폴더").fill(p.cwd);
    await row.getByLabel("이름").fill("고친 이름");
    await row.getByRole("button", { name: "저장" }).click();
    await row.locator(".st-pj__name", { hasText: "고친 이름" }).waitFor();
    expect((await state(p.id)).project.name).toBe("고친 이름");
    await page.close();
  }, 30_000);

  test("다른 폴더에서 켜도 화면이 뜬다(소스 실행)", async () => {
    const port = freePort();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-cwd-")));
    updateConfigFile({ accessCode: CODE, port, hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home });
    const proc = Bun.spawn([process.execPath, CLI, "serve"], { cwd: WORK, env: env({ IAMCEO_HOME: home, IAMCEO_PORT: String(port) }), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const url = `http://127.0.0.1:${port}`;
      await until("서버", () => fetch(`${url}/api/health`).then((r) => r.ok, () => false), 15000);
      const page = await desktop.newPage();
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.goto(url);
      await until("화면 그려짐", async () => (await page.locator("#root").innerText()).length > 0, 10000);
      expect(errors.filter((e) => e.includes("MIME"))).toEqual([]);
      await page.close();
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  }, 40_000);

  test("허용 대역 밖·다른 출처는 화면 파일도 받지 못한다", async () => {
    const res = await fetch(`${base}/`, { headers: { Origin: "http://evil.example" } });
    expect(res.status).toBe(403);
    expect(await (await fetch(`${base}/anything`)).text()).toContain("<html");
    const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal && !a.address.startsWith("100."))?.address;
    if (!lan) return; // 망이 없으면 건너뛴다
    const port = freePort();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-hosts-")));
    updateConfigFile({ accessCode: CODE, port, hosts: ["0.0.0.0"] }, { IAMCEO_HOME: home });
    const open0 = Bun.spawn([process.execPath, CLI, "serve"], { cwd: ROOT, env: env({ IAMCEO_HOME: home, IAMCEO_PORT: String(port) }), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      await until("서버", () => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false), 15000);
      expect((await fetch(`http://${lan}:${port}/`)).status).toBe(403);
      expect((await fetch(`http://${lan}:${port}/anything`)).status).toBe(403);
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    } finally {
      open0.kill("SIGTERM");
      await open0.exited;
    }
  }, 40_000);
});

describe("팀 화면", () => {
  test("일하는 세션을 중단할 수 있다", async () => {
    const p = await newProject();
    await api("POST", `/api/projects/${p.id}/messages`, { text: "오래 걸리는 일 @fake:delay=20000" });
    const page = await open(desktop, `#/p/${p.id}/team`);
    const lead = (await state(p.id)).members.find((m) => m.kind !== "worker")!;
    await page.locator(".tm-card__link", { hasText: lead.name }).click();
    await page.getByRole("button", { name: "중단" }).click();
    await until("멈춤", async () => (await state(p.id)).members.find((m) => m.id === lead.id)!.status !== "working", 8000);
    await page.close();
  }, 30_000);

  test("직접 띄운 세션: 명부에서 뺄 수 있고 일하는 중 표시가 맞는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "내 세션");
    await tool(w.token, "status", { now: "빌드 돌리는 중" });
    const page = await open(desktop, `#/p/${p.id}/team/${w.member.id}`);
    await page.locator(".dialog .status[data-status='working']").first().waitFor();
    // 더블클릭으로는 안 빠진다. 문구를 읽을 틈을 둔 둘째 누름만 뺀다.
    await page.getByRole("button", { name: "명부에서 빼기" }).dblclick();
    await page.waitForTimeout(150);
    expect((await state(p.id)).members.length).toBe(1);
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "한 번 더 누르면 뺍니다" }).click();
    await until("빠짐", async () => (await state(p.id)).members.length === 0);
    await page.close();
  }, 30_000);

  test("상태 점 색이 화면마다 같다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "색 시험");
    const page = await open(desktop, `#/p/${p.id}/team`);
    await page.locator(".tm-card__link", { hasText: "색 시험" }).waitFor();
    const colors = await page.evaluate(() => {
      const out: Record<string, string[]> = {};
      for (const status of ["working", "waiting", "idle", "blocked", "asleep", "error"]) {
        const a = document.createElement("span");
        a.className = "status tm-status";
        a.dataset.status = status;
        a.innerHTML = '<i class="status__dot"></i>';
        const b = document.createElement("span");
        b.className = "status";
        b.dataset.status = status;
        b.innerHTML = '<i class="status__dot"></i>';
        const host = document.querySelector(".tm")!;
        host.append(a, b);
        out[status] = [a, b].map((el) => getComputedStyle(el.querySelector(".status__dot")!).backgroundColor);
        a.remove();
        b.remove();
      }
      return out;
    });
    const parse = (c: string) => c.match(/[\d.]+/g)!.map(Number);
    for (const [, [a, b]] of Object.entries(colors)) expect(a).toBe(b);
    const [wr, wg, wb] = parse(colors.working![0]!);
    expect(wb!).toBeGreaterThan(wg!); // 보라
    expect(wb!).toBeGreaterThan(wr! - 40);
    const [or, og, ob] = parse(colors.waiting![0]!);
    expect(or!).toBeGreaterThan(og!);
    expect(og!).toBeGreaterThan(ob!); // 주황
    const [ir, ig, ib] = parse(colors.idle![0]!);
    expect(Math.max(ir!, ig!, ib!) - Math.min(ir!, ig!, ib!)).toBeLessThan(40); // 회색
    expect(parse(colors.blocked![0]!)[0]!).toBeGreaterThan(200); // 빨강 계열
    expect(colors.blocked![0]).not.toBe(colors.error![0]);
    expect(parse(colors.asleep![0]!).at(-1)).toBe(0); // 투명(흐림)
    expect(w.member.status).toBe("idle");
    await page.close();
  }, 30_000);

  test("공용 Modal 은 내용이 길어도 화면 안에 있고 안쪽만 스크롤한다", async () => {
    const p = await newProject();
    const big = await desktop.newPage();
    await big.setViewportSize({ width: 1000, height: 400 });
    await big.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    await big.goto(`${base}/#/p/${p.id}/inbox`);
    await big.locator(".conn[data-state='online']").waitFor();
    // Modal 자체의 CSS 를 본다: 보관 확인창에 긴 내용을 넣는다.
    await big.goto(`${base}/#/settings/${p.id}`);
    await big.locator(`[data-project="${p.id}"]`).getByRole("button", { name: /보관하기/ }).click();
    const panel = big.locator(".dialog--modal .dialog__panel");
    await panel.waitFor();
    await big.locator(".dialog__body").evaluate((el) => {
      const filler = document.createElement("div");
      filler.style.height = "3000px";
      el.appendChild(filler);
    });
    const box = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const body = el.querySelector(".dialog__body")!;
      return { top: r.top, bottom: r.bottom, scrolls: body.scrollHeight > body.clientHeight };
    });
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(400);
    expect(box.scrolls).toBe(true);
    await big.close();
  }, 30_000);

  test("핀치 확대를 키보드로 오인하지 않는다", async () => {
    const p = await newProject();
    const page = await open(phone, `#/p/${p.id}/inbox`);
    await page.locator(".shell__bottom").waitFor();
    const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--app-h"));
    const cdp = await phone.newCDPSession(page);
    await cdp.send("Input.synthesizePinchGesture", { x: 195, y: 400, scaleFactor: 2.5, relativeSpeed: 800, gestureSourceType: "touch" });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      scale: visualViewport!.scale,
      appH: getComputedStyle(document.documentElement).getPropertyValue("--app-h"),
      keyboard: document.querySelector(".shell")!.hasAttribute("data-keyboard"),
      tabs: !!document.querySelector(".shell__bottom .shell-tabs"),
    }));
    expect(after.scale).toBeGreaterThan(1.5);
    expect(after.appH).toBe(before);
    expect(after.keyboard).toBe(false);
    expect(after.tabs).toBe(true);
    await page.close();
  }, 30_000);
});

describe("편입·설정 화면", () => {
  async function stubHerdr(page: Page, backend: "herdr" | "headless" = "herdr") {
    await page.route("**/api/bootstrap", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, settings: { ...body.settings, backend }, herdr: { ...body.herdr, installed: true, running: true, compatible: true } } });
    });
    await page.route("**/api/herdr/agents", (route) =>
      route.fulfill({ json: [
        { paneId: "w9:p1", name: "옛 세션", agent: "claude", status: "idle", cwd: "/다른/폴더", sessionId: "s1", workspaceId: "w9", tabId: "w9:t1", adopted: false },
        { paneId: "w9:p2", name: "바쁜 세션", agent: "claude", status: "working", cwd: "/다른/폴더", sessionId: "s2", workspaceId: "w9", tabId: "w9:t1", adopted: false },
        { paneId: "w9:p3", name: "코덱스", agent: "codex", status: "idle", cwd: null, sessionId: null, workspaceId: "w9", tabId: "w9:t1", adopted: false },
      ] }),
    );
    await page.route("**/adopt/preview*", (route) => {
      const busy = new URL(route.request().url()).searchParams.get("pane") === "w9:p2";
      route.fulfill({ json: {
        paneId: busy ? "w9:p2" : "w9:p1", name: "옛 세션", cwd: "/다른/폴더", status: busy ? "working" : "idle", sessionId: "s1", screen: "화면 첫 줄\n화면 끝 줄",
        refuse: busy ? "일하는 중입니다. 지금 턴이 끝나면 다시 시도하세요" : null,
        warnings: busy ? [] : [{ kind: "conductor", text: "다른 지휘자가 있을 수 있습니다. 칸 이름이 'lead' 입니다" }, { kind: "folder", text: "이 프로젝트 폴더가 아닙니다." }],
      } });
    });
  }

  test("팀이 돌기 시작해도 편입 버튼이 있고, 무엇이 바뀌는지·화면·경고를 보여 주며 일하는 세션은 못 받는다", async () => {
    const dir = join(PROJECT_DIR, `adopt-${++counter}`);
    mkdirSync(dir);
    const p = await api<Project>("POST", "/api/projects", { name: "편입 시험", cwd: dir });
    await joinWorker(p.id, "이미 있는 직원");
    const page = await desktop.newPage();
    await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    await stubHerdr(page);
    await page.goto(`${base}/#/p/${p.id}/team`);
    await page.locator(".tm-adopt-entry").getByRole("button", { name: "기존 세션 편입" }).click();
    const form = page.locator(".tm-adopt");
    await form.waitFor();
    expect(await form.getByText("총괄", { exact: true }).count()).toBe(0);
    const what = await form.locator(".tm-adopt__what").innerText();
    expect(what).toContain("칸은 그대로입니다");
    expect(what).toContain("도구를 못 붙여");
    expect(await form.innerText()).toContain("다른 CLI 세션 1개는 받을 수 없습니다");
    await form.locator("label.choice", { hasText: "옛 세션" }).click();
    await form.getByText("화면 끝 줄").waitFor();
    expect(await form.getByText("다른 지휘자가 있을 수 있습니다").count()).toBe(1);
    expect(await form.getByText("이 프로젝트 폴더가 아닙니다").count()).toBe(1);
    expect(await form.getByRole("button", { name: "편입", exact: true }).isDisabled()).toBe(false);
    await form.locator("label.choice", { hasText: "바쁜 세션" }).click();
    await form.locator(".tm-hint", { hasText: "일하는 중입니다" }).waitFor();
    expect(await form.getByRole("button", { name: "편입", exact: true }).isDisabled()).toBe(true);
    await form.locator(".tm-adopt__other > summary").click();
    expect(await form.locator(".tm-copy__cmd").innerText()).toContain("join --project");
    await page.close();
  }, 30_000);

  test("전체 실행 방식이 headless 면 편입 대신 터미널에서 붙는 방법을 안내한다", async () => {
    const p = await newProject();
    await api("POST", `/api/projects/${p.id}/conductor/start`);
    const page = await desktop.newPage();
    await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    await stubHerdr(page, "headless");
    await page.goto(`${base}/#/p/${p.id}/team`);
    await page.locator(".tm-card").first().waitFor();
    await page.getByRole("button", { name: "기존 세션 편입" }).click();
    const guide = page.locator(".tm-join");
    await guide.waitFor();
    expect(await page.locator(".tm-adopt__list").count()).toBe(0);
    expect(await page.locator(".tm-adopt").innerText()).toContain("실행 방식이 herdr 일 때만");
    const command = await guide.locator(".tm-copy__cmd").innerText();
    expect(command).toContain("--project");
    expect(command).toContain("--name");
    await page.close();
  }, 30_000);

  test("직원 상세: 모델·effort 를 직급 기본값에서 바꾸고 되돌린다", async () => {
    const p = await newProject();
    await api("POST", `/api/projects/${p.id}/conductor/start`);
    const lead = (await api<ProjectState>("GET", `/api/projects/${p.id}/state`)).members[0]!;
    const page = await open(desktop, `#/p/${p.id}/team/${lead.id}`);
    const model = page.getByRole("combobox", { name: "모델" });
    await model.waitFor();
    expect(await model.inputValue()).toBe("");
    expect(await model.locator("option").first().innerText()).toContain("직급 기본값");
    const settled = (label: string) => page.waitForFunction((l) => !(document.querySelector(`select[aria-label="${l}"]`) as HTMLSelectElement).disabled, label);
    await model.selectOption("haiku");
    await settled("모델");
    await page.getByRole("combobox", { name: "effort" }).selectOption("low");
    await settled("effort");
    await page.waitForTimeout(100);
    expect((await api<ProjectState>("GET", `/api/projects/${p.id}/state`)).members[0]).toMatchObject({ modelOverride: "haiku", effortOverride: "low" });
    await model.selectOption("");
    await settled("모델");
    await page.waitForTimeout(100);
    expect((await api<ProjectState>("GET", `/api/projects/${p.id}/state`)).members[0]!.modelOverride).toBeNull();
    await page.close();
  }, 30_000);

  test("설정: 권한·맥 알림은 저장 띠로 저장된다. 들어올 주소가 보이고, 저장 띠는 화면 안에 있다", async () => {
    const page = await open(desktop, "#/settings");
    await page.locator("#st-permission").waitFor();
    expect(await page.locator(".st-urls").innerText()).toContain(base);
    expect(await page.locator(".st-bar").count()).toBe(0);
    await page.locator("label", { hasText: "맥 알림" }).locator("input").check();
    await page.locator("input[name='st-default-permission']").nth(1).check();
    const bar = page.locator(".st-bar");
    await bar.waitFor();
    expect(await bar.evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
    await bar.getByRole("button", { name: "저장" }).click();
    await bar.getByText("저장했습니다").waitFor();
    const boot = await api<{ settings: { notifyMac: boolean; permissionMode: string } }>("GET", "/api/bootstrap");
    expect(boot.settings.permissionMode).toBe("auto");
    expect(boot.settings.notifyMac).toBe(true);
    await api("PUT", "/api/settings", { permissionMode: "bypassPermissions", notifyMac: false });
    await page.close();
  }, 30_000);

  test("설정: 직급별 모델·effort 를 고른다. 직접 입력은 비면 거부, 고친 칸만 보낸다. 서브에이전트 effort 안내는 없다", async () => {
    const page = await open(desktop, "#/settings");
    await page.getByLabel("부장 모델", { exact: true }).selectOption("opus");
    await page.getByLabel("부장 effort").selectOption("max");
    await page.getByLabel("직원 모델", { exact: true }).selectOption("custom");
    const bar = page.locator(".st-bar");
    await bar.getByRole("button", { name: "저장" }).click();
    await bar.getByText("직원 모델 이름을 넣어 주세요").waitFor();
    await page.getByLabel("직원 모델 이름").fill("claude-haiku-5-5");
    await page.getByLabel("직원 effort").selectOption("low");
    const sent = page.waitForRequest((r) => r.url().endsWith("/api/settings") && r.method() === "PUT");
    await bar.getByRole("button", { name: "저장" }).click();
    expect((await sent).postDataJSON()).toEqual({ ranks: { manager: { model: "opus", effort: "max" }, staff: { model: "claude-haiku-5-5", effort: "low" } } });
    await bar.getByText("저장했습니다").waitFor();
    const boot = await api<{ settings: { ranks: unknown } }>("GET", "/api/bootstrap");
    expect(boot.settings.ranks).toEqual({ manager: { model: "opus", effort: "max" }, lead: { model: null, effort: expect.any(String) }, staff: { model: "claude-haiku-5-5", effort: "low" } });
    expect(await page.locator(".st").innerText()).not.toMatch(/강제|보장되지/);
    // 저장한 값을 다시 열어도 직접 입력으로 보인다.
    await page.reload();
    expect(await page.getByLabel("직원 모델 이름").inputValue()).toBe("claude-haiku-5-5");
    await api("PUT", "/api/settings", { ranks: { manager: { model: null, effort: null }, staff: { model: null, effort: null } } });
    await page.close();
  }, 30_000);

  test("설정(폰): 가로 넘침 없고, 직급 칸·프로젝트 버튼은 44px 이상이다", async () => {
    const dir = join(PROJECT_DIR, "폰-넘침-" + "아주-긴-폴더-이름-".repeat(6));
    mkdirSync(dir, { recursive: true });
    await api<Project>("POST", "/api/projects", { name: "긴 폴더", cwd: dir });
    const page = await open(phone, "#/settings");
    await page.locator("#st-projects").waitFor();
    const m = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("[data-scroll-root]")!;
      const small = [...document.querySelectorAll<HTMLElement>(".st select, .st .st-pj__actions .gbtn")].filter((el) => el.getBoundingClientRect().height < 44);
      return { over: root.scrollWidth - root.clientWidth, small: small.length };
    });
    expect(m).toEqual({ over: 0, small: 0 });
    await page.close();
  }, 30_000);
});

describe("서버 강제 종료", () => {
  test("SIGHUP 은 자식까지 정리하고 끝난다", async () => {
    const port = freePort();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-hup-")));
    const log = join(home, "fake.jsonl");
    updateConfigFile({ accessCode: CODE, port, hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home });
    const proc = Bun.spawn([process.execPath, CLI, "serve"], { cwd: ROOT, env: env({ IAMCEO_HOME: home, IAMCEO_PORT: String(port), FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SESSIONS: join(home, "s") }), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const url = `http://127.0.0.1:${port}`;
    const h = { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" };
    await until("서버", () => fetch(`${url}/api/health`).then((r) => r.ok, () => false), 15000);
    await fetch(`${url}/api/settings`, { method: "PUT", headers: h, body: JSON.stringify({ backend: "headless" }) });
    await fetch(`${url}/api/projects/hq/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "오래 걸림 @fake:delay=40000" }) });
    let pid = 0;
    await until("자식", async () => {
      try {
        pid = (JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1)!) as { pid: number }).pid;
        return pid > 0;
      } catch {
        return false;
      }
    }, 10000);
    proc.kill("SIGHUP");
    expect(await proc.exited).toBe(0);
    await Bun.sleep(100);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 40_000);

  test("SIGKILL 뒤 남은 claude -p 자식을 재시작이 끝내고, 같은 세션을 함께 쓰지 않는다", async () => {
    const port = freePort();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-orphan-")));
    const log = join(home, "fake.jsonl");
    updateConfigFile({ accessCode: CODE, port, hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home });
    const childEnv = env({ IAMCEO_HOME: home, IAMCEO_PORT: String(port), FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SESSIONS: join(home, "sessions") });
    const spawn = () => Bun.spawn([process.execPath, CLI, "serve"], { cwd: ROOT, env: childEnv, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const url = `http://127.0.0.1:${port}`;
    const h = { Authorization: `Bearer ${CODE}`, "Content-Type": "application/json" };
    const proc = spawn();
    await until("서버", () => fetch(`${url}/api/health`).then((r) => r.ok, () => false), 15000);
    await fetch(`${url}/api/settings`, { method: "PUT", headers: h, body: JSON.stringify({ backend: "headless" }) });
    await fetch(`${url}/api/projects/hq/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "오래 걸림 @fake:delay=40000" }) });
    const child = async () => {
      const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { pid: number });
      return lines.at(-1)!.pid;
    };
    await until("자식", async () => {
      try {
        return (await child()) > 0;
      } catch {
        return false;
      }
    }, 10000);
    const pid = await child();
    const alive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(pid)).toBe(true);
    proc.kill("SIGKILL");
    await proc.exited;
    expect(alive(pid)).toBe(true); // 전해지지 않는다
    const again = spawn();
    try {
      await until("서버 재시작", () => fetch(`${url}/api/health`).then((r) => r.ok, () => false), 15000);
      await until("고아 정리", async () => !alive(pid), 8000);
    } finally {
      again.kill("SIGTERM");
      await again.exited;
    }
  }, 60_000);

  test("남의 pid 는 건드리지 않는다(명령줄이 세션과 다르면 그대로)", async () => {
    const port = freePort();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-orphan2-")));
    mkdirSync(join(home, "run"), { recursive: true });
    const innocent = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    writeFileSync(join(home, "run", "m_x.turn.json"), JSON.stringify({ pid: innocent.pid, sessionId: "11111111-1111-4111-8111-111111111111" }));
    updateConfigFile({ accessCode: CODE, port, hosts: ["127.0.0.1"] }, { IAMCEO_HOME: home });
    const proc = Bun.spawn([process.execPath, CLI, "serve"], { cwd: ROOT, env: env({ IAMCEO_HOME: home, IAMCEO_PORT: String(port) }), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      await until("서버", () => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false), 15000);
      await Bun.sleep(300);
      expect(innocent.killed).toBe(false);
      expect(innocent.exitCode).toBe(null);
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
      innocent.kill();
    }
  }, 30_000);
});

describe("2차 검수 회귀", () => {
  test("묶음 확인 대기 중 새 카드가 오면 안 읽은 카드까지 승인되지 않고 다시 묻는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const ids = [await ask(w.token, "카드1", [{ k: "a", label: "가" }], { rec: "a", group: "G" }), await ask(w.token, "카드2", [{ k: "a", label: "가" }], { rec: "a", group: "G" })];
    const page = await inbox(desktop, p.id);
    await page.getByRole("button", { name: "이 묶음 추천대로" }).click();
    await page.getByRole("button", { name: "묶음 2건 결정" }).waitFor();
    const fresh = await ask(w.token, "새로 온 위험한 카드", [{ k: "a", label: "가" }], { rec: "a", group: "G" });
    await page.locator(".ibx-card", { hasText: "새로 온 위험한 카드" }).waitFor();
    await page.getByRole("button", { name: "묶음 2건 결정" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "이 묶음 추천대로" }).click();
    await page.waitForTimeout(650);
    await page.getByRole("button", { name: "묶음 3건 결정" }).click();
    await until("셋 다 답함", async () => (await decision(p.id, fresh)).status !== "open");
    for (const id of ids) expect((await decision(p.id, id)).batch).toBe(true);
    await page.close();
  }, 30_000);

  test("묶음 추천을 키보드로 끝내도 초점이 문서 처음으로 가지 않는다. 할 일 체크는 처리 중에도 초점을 지킨다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    await ask(w.token, "카드1", [{ k: "a", label: "가" }], { rec: "a", group: "G" });
    await ask(w.token, "카드2", [{ k: "a", label: "가" }], { rec: "a", group: "G" });
    await tool(w.token, "todo", { title: "서류 내기" });
    const home = await open(desktop, `#/p/${p.id}/home`);
    const check = home.getByRole("checkbox", { name: "서류 내기 했음" });
    await check.focus();
    await home.keyboard.press("Space");
    await home.waitForTimeout(30);
    expect(await home.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("서류 내기 했음");
    await home.close();
    const page = await inbox(desktop, p.id);
    const button = page.getByRole("button", { name: "이 묶음 추천대로" });
    await button.focus();
    await page.keyboard.press("Enter");
    const go = page.getByRole("button", { name: "묶음 2건 결정" });
    await go.waitFor();
    await page.waitForTimeout(650);
    await go.focus();
    await page.keyboard.press("Enter");
    await page.locator("[data-answered-card]").first().waitFor();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    await page.close();
  }, 30_000);

  test("다른 기기의 답으로 자리가 밀린 직후의 누름은 다른 결재를 승인하지 않는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const top = await ask(w.token, "위", [{ k: "a", label: "승인" }]);
    const mid = await ask(w.token, "가운데", [{ k: "a", label: "승인" }]);
    const low = await ask(w.token, "아래", [{ k: "a", label: "승인" }]);
    const page = await inbox(desktop, p.id);
    const box = (await page.locator(".ibx-card", { hasText: "가운데" }).getByRole("button", { name: "승인" }).boundingBox())!;
    await api("POST", `/api/decisions/${top}/answer`, { choice: "a" });
    await tool(w.token, "status", { now: "다음 일" });
    await until("다른 기기 답 반영", async () => (await decision(p.id, top)).status !== "open");
    // 위 카드가 답해져 작아지거나 빠진다. 자리가 움직인 바로 그 순간 같은 좌표를 누른다.
    await page.locator(".ibx-card--answered, .ibx-card").first().waitFor();
    await page.waitForFunction(([y]) => {
      const el = document.elementFromPoint(800, y as number);
      return !!el;
    }, [box.y]);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(100);
    // 그 좌표에 무엇이 와 있든 한 번 누름은 고르기일 뿐이다. 결재는 나가지 않는다.
    expect((await decision(p.id, mid)).status).toBe("open");
    expect((await decision(p.id, low)).status).toBe("open");
    await page.close();
  }, 30_000);

  test("한국어 범위 표기의 물결표는 취소선이 아니다. ~~ 는 취소선이다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    await tool(w.token, "post", { kind: "알림", title: "견적", body: "가격 3~5만원, 배송 7~9일로 진행합니다.\n\n~/a,~/b 수정\n\n~~지움~~" });
    const page = await open(desktop, `#/p/${p.id}/thread`);
    const md = page.locator(".th-md").last();
    await md.waitFor();
    const text = await md.innerText();
    expect(text).toContain("3~5만원");
    expect(text).toContain("7~9일");
    expect(text).toContain("~/a,~/b");
    expect(await md.locator("del").allInnerTexts()).toEqual(["지움"]);
    await page.close();
  }, 20_000);

  test("실패 글의 다시 보내기는 그 줄을 바꾸고, 지시가 늘지 않는다", async () => {
    const p = await newProject();
    const page = await open(desktop, `#/p/${p.id}/thread`);
    await page.locator(".th").waitFor();
    await input(page).fill("배포 진행해");
    await page.route("**/api/projects/*/messages", (route) => route.abort());
    await input(page).press("Enter");
    const retry = page.locator(".th-retry");
    await retry.waitFor();
    await page.unroute("**/api/projects/*/messages");
    await retry.click();
    await until("서버에 한 건", async () => (await state(p.id)).messages.filter((m) => m.mine).length === 1);
    await page.waitForTimeout(500);
    expect(await page.locator(".th-retry").count()).toBe(0);
    expect(await page.locator(".th-row--mine").count()).toBe(1);
    await page.close();
  }, 20_000);

  test("직접 지시칸: 응답을 잃은 뒤 다시 보내도 한 건이고, 창을 닫아도 쓰던 글이 남는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const page = await openDeadSocket(desktop, `#/p/${p.id}/team/${w.member.id}`);
    const field = page.getByRole("textbox", { name: /철수에게 직접 지시/ });
    await field.fill("한 번만 전달");
    await page.route("**/api/projects/*/messages", async (route) => {
      await route.fetch();
      await route.abort();
    });
    await field.press("Enter");
    await until("글 복원", async () => (await field.inputValue()) === "한 번만 전달");
    await page.unroute("**/api/projects/*/messages");
    if ((await field.inputValue()) === "한 번만 전달") await field.press("Enter");
    await page.waitForTimeout(400);
    expect((await state(p.id)).messages.filter((m) => m.mine && m.body === "한 번만 전달")).toHaveLength(1);
    await page.close();

    const again = await open(desktop, `#/p/${p.id}/team/${w.member.id}`);
    const box = again.getByRole("textbox", { name: /철수에게 직접 지시/ });
    await box.fill("길게 쓰던 지시");
    await again.keyboard.press("Escape");
    await again.getByRole("dialog").waitFor({ state: "detached" }).catch(() => {});
    await again.locator(".tm-card__link", { hasText: "철수" }).click();
    expect(await again.getByRole("textbox", { name: /철수에게 직접 지시/ }).inputValue()).toBe("길게 쓰던 지시");
    await again.close();
  }, 30_000);

  test("글자를 끌어 선택하다 판 밖에서 놓아도 창이 닫히지 않는다. 판 밖 클릭은 닫는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const page = await open(desktop, `#/p/${p.id}/team/${w.member.id}`);
    const field = page.getByRole("textbox", { name: /철수에게 직접 지시/ });
    await field.fill("길게 쓰던 지시 길게 쓰던 지시");
    const box = (await field.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(8, 400, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    expect(await page.locator("dialog[open]").count()).toBe(1);
    await page.mouse.click(8, 400);
    await page.waitForTimeout(100);
    expect(await page.locator("dialog[open]").count()).toBe(0);
    await page.close();
  }, 20_000);

  test("이 기기에서 나가기: 건수를 알리는 확인을 거치고, 다시 들어와도 초안이 나타나지 않는다", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await newProject();
    const page = await ctx.newPage();
    await page.addInitScript((code) => {
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem("iamceo.accessCode", code);
      }
    }, CODE);
    await page.goto(`${base}/#/p/${p.id}/inbox`);
    await input(page).fill("공용 기기 비밀 초안");
    await page.goto(`${base}/#/settings/${p.id}`);
    await page.getByRole("button", { name: "이 기기에서 나가기" }).click();
    const dialog = page.locator("dialog[open]");
    await dialog.getByText("초안·메모 1건").waitFor();
    expect(await page.evaluate(() => localStorage.getItem("iamceo.accessCode"))).not.toBeNull();
    await dialog.getByRole("button", { name: "나가기" }).click();
    await page.getByLabel("접속 코드").waitFor();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("iamceo.")))).toEqual([]);
    await page.getByLabel("접속 코드").fill(CODE);
    await page.getByLabel("접속 코드").press("Enter");
    await page.evaluate((id) => (location.hash = `#/p/${id}/inbox`), p.id);
    await input(page).waitFor();
    expect(await input(page).inputValue()).toBe("");
    await page.close();
    await ctx.close();
  }, 30_000);

  test("글과 그림이 함께 든 클립보드는 글을 막지 않고, 파일 이름뿐인 글은 막는다", async () => {
    const p = await newProject();
    const page = await open(desktop, `#/p/${p.id}/inbox`);
    await input(page).waitFor();
    const paste = (text: string, name: string) =>
      page.evaluate(([text, name]) => {
        const data = new DataTransfer();
        if (text) data.setData("text/plain", text);
        data.items.add(new File(["x"], name, { type: "image/png" }));
        const e = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
        document.querySelector("textarea.cmp__input")!.dispatchEvent(e);
        return e.defaultPrevented;
      }, [text, name]);
    expect(await paste("엑셀에서 복사한 표 내용", "image.png")).toBe(false);
    expect(await paste("", "b.png")).toBe(true);
    expect(await paste("c.png", "c.png")).toBe(true);
    await page.locator(".cmp-chip--file").nth(2).waitFor();
    await page.close();
  }, 20_000);

  test("설정·접속 코드 화면에서도 파일을 놓으면 브라우저가 열지 않는다", async () => {
    const p = await newProject();
    const drop = (page: Page) =>
      page.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File(["x"], "note.txt", { type: "text/plain" }));
        const over = new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true });
        document.body.dispatchEvent(over);
        const drop = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
        document.body.dispatchEvent(drop);
        return [over.defaultPrevented, drop.defaultPrevented];
      });
    const settings = await open(desktop, `#/settings/${p.id}`);
    await settings.locator(".st").waitFor();
    expect(await drop(settings)).toEqual([true, true]);
    await settings.close();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const setup = await ctx.newPage();
    await setup.goto(`${base}/`);
    await setup.getByLabel("접속 코드").waitFor();
    expect(await drop(setup)).toEqual([true, true]);
    await ctx.close();
  }, 20_000);

  test("창 높이까지 줄어드는 키보드(resizes-content)에서도 아래 탭이 접힌다", async () => {
    const p = await newProject();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    await page.goto(`${base}/#/p/${p.id}/inbox`);
    await input(page).click();
    await page.setViewportSize({ width: 390, height: 480 });
    await page.locator(".shell--phone[data-keyboard]").waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.querySelector(".shell--phone[data-keyboard]"));
    await ctx.close();
  }, 20_000);

  test("터치 기기는 Enter 가 줄바꿈이고 보내기 버튼으로 보낸다. 데스크톱은 Enter 전송", async () => {
    const p = await newProject();
    const ph = await open(phone, `#/p/${p.id}/inbox`);
    await input(ph).waitFor();
    await input(ph).click();
    await input(ph).pressSequentially("첫 줄");
    await ph.keyboard.press("Enter");
    await input(ph).pressSequentially("둘째 줄");
    expect(await input(ph).inputValue()).toBe("첫 줄\n둘째 줄");
    expect((await state(p.id)).messages.filter((m) => m.mine)).toHaveLength(0);
    await ph.getByRole("button", { name: "보내기" }).click();
    await until("폰 전송", async () => (await state(p.id)).messages.filter((m) => m.mine).length === 1);
    await ph.close();
    const desk = await open(desktop, `#/p/${p.id}/inbox`);
    await input(desk).fill("데스크톱 글");
    await input(desk).press("Enter");
    await until("데스크톱 전송", async () => (await state(p.id)).messages.filter((m) => m.mine).length === 2);
    await desk.close();
  }, 20_000);

  test("승인 창 앞 세션이 목록·배지·결재함에 보이고, 눌러서 직원 화면으로 간다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "승인멈춤");
    const dbPath = join(HOME, "iamceo.db");
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath);
    db.run("UPDATE members SET status = 'blocked' WHERE id = ?", [w.member.id]);
    db.close();
    const page = await inbox(desktop, p.id);
    await page.locator(".pj", { hasText: "승인 창 앞 1명" }).waitFor();
    await page.locator(".ibx-blocked__name", { hasText: "승인멈춤" }).waitFor();
    expect(await page.getByText("결재할 것이 없습니다").count()).toBe(0);
    expect(await page.title()).toMatch(/\(\d+\) IAMCEO/);
    await page.locator(".ibx-blocked__row").click();
    await page.locator("dialog[open]").getByText("승인 창 앞에서 멈췄습니다").waitFor();
    await page.close();
  }, 20_000);

  test("본사 AI 상세로 갈 수 있고 탭은 넷이다", async () => {
    await api("POST", "/api/projects/hq/messages", { id: crypto.randomUUID(), text: "@fake:delay=800 안녕" });
    const page = await open(desktop, "#/p/hq/thread");
    const strip = page.locator(".ibx-lead");
    await strip.waitFor();
    expect(await page.locator(".gtabs a, .gtabs [role='tab']").count()).toBeLessThanOrEqual(4);
    await strip.click();
    await page.locator("dialog[open]").getByText("활동").first().waitFor();
    expect(page.url()).toContain("/team/");
    await page.getByRole("button", { name: "닫기" }).click();
    await until("본사 홈으로", async () => page.url().endsWith("/home"));
    await page.getByRole("region", { name: "본사 AI" }).waitFor();
    await page.close();
  }, 25_000);

  test("쉬는 직원의 지금 줄은 '마지막 일'이다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    await tool(w.token, "status", { now: "결제 버그 고치는 중" });
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(HOME, "iamceo.db"));
    db.run("UPDATE members SET status = 'idle' WHERE id = ?", [w.member.id]);
    db.close();
    const page = await open(desktop, `#/p/${p.id}/team`);
    const card = page.locator(".tm-card", { hasText: "결제 버그 고치는 중" });
    await card.waitFor();
    expect(await card.locator("dt").first().innerText()).toBe("마지막 일");
    await page.close();
  }, 20_000);

  test("망이 멈춰도 결재 버튼이 영영 잠기지 않는다(쓰기 20초 제한)", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const id = await ask(w.token, "멈춤 시험", [{ k: "a", label: "가" }]);
    const page = await inbox(phone, p.id);
    await page.route(`**/api/decisions/${id}/answer`, () => {}); // 응답도 끊김도 없다
    await confirmCard(page, "멈춤 시험", "가");
    await page.getByRole("alert").waitFor({ timeout: 25_000 });
    expect(await page.locator(".ibx-confirm__go").isEnabled()).toBe(true);
    await page.close();
  }, 40_000);

  test("공용 Modal: 내용이 길어도 판이 화면 안에 있고 닫기 버튼이 보인다. 상태 색은 승인 창과 오류가 구분된다", async () => {
    const p = await newProject();
    const page = await open(desktop, `#/settings/${p.id}`);
    const archive = page.locator(`[data-project="${p.id}"]`).getByRole("button", { name: /보관하기/ });
    await archive.waitFor();
    await page.setViewportSize({ width: 1440, height: 300 });
    await archive.click();
    const panel = page.locator("dialog[open] .dialog__panel");
    await panel.waitFor();
    await page.evaluate(() => {
      document.querySelector("dialog[open] .dialog__body")!.insertAdjacentHTML("beforeend", '<div style="height:3000px"></div>');
    });
    const rect = (await panel.boundingBox())!;
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height).toBeLessThanOrEqual(300);
    expect(await page.getByRole("button", { name: "닫기" }).isVisible()).toBe(true);
    const colors = await page.evaluate(() =>
      Object.fromEntries(
        ["working", "waiting", "idle", "blocked", "asleep", "error"].map((status) => {
          const a = document.createElement("span");
          a.className = "status";
          a.dataset.status = status;
          a.innerHTML = '<i class="status__dot"></i>';
          document.body.append(a);
          const out = [getComputedStyle(a).color, getComputedStyle(a.querySelector(".status__dot")!).backgroundColor];
          a.remove();
          return [status, out];
        }),
      ),
    );
    expect(colors.blocked![0]).not.toBe(colors.error![0]);
    expect(colors.idle![0]).toBe(colors.idle![1]);
    const [ir, ig, ib] = colors.idle![0]!.match(/\d+/g)!.map(Number);
    expect(Math.max(ir!, ig!, ib!) - Math.min(ir!, ig!, ib!)).toBeLessThan(16); // 회색
    await page.close();
  }, 20_000);

  test("처리됨이 50건을 넘으면 더 불러오고, 옛 대화의 결재 링크가 그 카드로 간다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const ids: string[] = [];
    for (let i = 0; i < 53; i++) {
      const id = await ask(w.token, `옛 결재 ${i}`, [{ k: "a", label: "가" }]);
      ids.push(id);
      await api("POST", `/api/decisions/${id}/answer`, { choice: "a" });
      await tool(w.token, "wait", { timeout_sec: 1 });
    }
    const page = await open(desktop, `#/p/${p.id}/inbox/${ids[0]}`);
    await page.locator(`[data-decision="${ids[0]}"]`).waitFor();
    await page.getByRole("button", { name: "더 불러오기" }).click();
    await page.getByText("옛 결재 1", { exact: true }).waitFor();
    await page.close();
  }, 60_000);
});

describe("결재 카드 되돌림과 확인 띠", () => {
  const reopen = (id: string, choice: string | null, note: string | null) => {
    const db = new Database(join(HOME, "iamceo.db"));
    db.run("UPDATE decisions SET status = 'open', last_choice = ?, last_note = ?, reopen_note = ? WHERE id = ?", [choice, note, "전달하지 못했습니다. 다시 결정해 주세요", id]);
    db.close();
  };

  test("다시 열린 카드는 이유와 직전 답을 보이고 메모를 돌려준다. 비운 메모는 묶음에 실리지 않는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const options = [{ k: "a", label: "가" }, { k: "b", label: "나" }];
    const free = await ask(w.token, "자유 답 카드", []);
    const picked = await ask(w.token, "선택지 카드", options, { rec: "a", group: "G" });
    const cleared = await ask(w.token, "비울 카드", options, { rec: "a", group: "G" });
    reopen(free, null, "오래 쓴 답입니다");
    reopen(picked, "b", "조건부 승인");
    reopen(cleared, "a", "지울 메모");
    const page = await inbox(desktop, p.id);
    const freeCard = page.locator(".ibx-card", { hasText: "자유 답 카드" });
    expect(await freeCard.getByRole("textbox", { name: "답" }).inputValue()).toBe("오래 쓴 답입니다");
    await freeCard.getByText("전달하지 못했습니다. 다시 결정해 주세요").waitFor();
    const pickedCard = page.locator(".ibx-card", { hasText: "선택지 카드" });
    await pickedCard.getByText("직전 답: 나").waitFor();
    expect(await pickedCard.getByRole("textbox", { name: "메모" }).inputValue()).toBe("조건부 승인");
    // 확인 띠가 저절로 뜨지 않는다. 다시 고르고 확인해야 나간다.
    expect(await pickedCard.locator(".ibx-confirm").count()).toBe(0);
    await page.locator(".ibx-card", { hasText: "비울 카드" }).getByRole("textbox", { name: "메모" }).fill("");
    await page.getByRole("button", { name: "이 묶음 추천대로" }).click();
    await page.waitForTimeout(650);
    await page.getByRole("button", { name: "묶음 2건 결정" }).click();
    await until("둘 다 답함", async () => (await decision(p.id, cleared)).status !== "open" && (await decision(p.id, picked)).status !== "open");
    expect((await decision(p.id, picked)).note).toBe("조건부 승인");
    expect((await decision(p.id, cleared)).note).toBe(null);
    await page.close();
  }, 30_000);

  test("폰: 선택지를 누르면 확인 버튼이 입력칸에 가려지지 않는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const options = [1, 2, 3, 4].map((n) => ({ k: `o${n}`, label: `선택지 ${n}` }));
    await tool(w.token, "ask", { title: "긴 카드", detail: "배경 설명입니다. ".repeat(120), options });
    const page = await inbox(phone, p.id);
    const last = page.locator(".ibx-opt").last();
    await last.waitFor();
    // 마지막 선택지가 입력칸 바로 위에 오게 스크롤한다.
    await last.evaluate((el) => {
      const scroller = el.closest<HTMLElement>("[data-scroll-root]")!;
      const bottom = document.querySelector(".shell__bottom")!.getBoundingClientRect().top;
      scroller.scrollTop += el.getBoundingClientRect().bottom - bottom + 4;
    });
    await last.click();
    const go = page.locator(".ibx-confirm__go");
    await go.waitFor();
    await until("확인 버튼이 보임", () =>
      go.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && el.contains(hit);
      }),
    );
    await page.close();
  }, 30_000);

  test("묶음 확인 중 카드 하나에서 다른 것을 고르면 다시 묻고 건수를 바로 보인다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const options = [{ k: "a", label: "가" }, { k: "b", label: "나" }];
    for (const title of ["셋 중 1", "셋 중 2", "셋 중 3"]) await ask(w.token, title, options, { rec: "a", group: "G" });
    const page = await inbox(desktop, p.id);
    await page.getByRole("button", { name: "이 묶음 추천대로" }).click();
    await page.getByRole("button", { name: "묶음 3건 결정" }).waitFor();
    await page.locator(".ibx-card", { hasText: "셋 중 2" }).locator(".ibx-opt", { hasText: "나" }).click();
    await page.getByRole("button", { name: "묶음 3건 결정" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "이 묶음 추천대로" }).click();
    await page.getByRole("button", { name: "묶음 2건 결정" }).waitFor();
    await page.close();
  }, 30_000);
});

describe("결재함 분류", () => {
  test("결재할·결재된 항목이 한 번에 한 쪽만 보이고, 주소로 유지되고, 펼치면 배경이 보인다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    const done = await ask(w.token, "끝난 결재", [{ k: "a", label: "A안" }], { detail: "끝난 결재의 **배경**" });
    await ask(w.token, "남은 결재", [{ k: "a", label: "가" }]);
    await api("POST", `/api/decisions/${done}/answer`, { choice: "a", note: "조건 메모" });
    const page = await inbox(desktop, p.id);
    const seg = page.locator(".ibx-seg__item");
    expect((await seg.nth(0).innerText()).replace(/\s+/g, " ")).toBe("결재할 항목 1");
    expect((await seg.nth(1).innerText()).replace(/\s+/g, " ")).toBe("결재된 항목 1");
    await page.locator(".ibx-card", { hasText: "남은 결재" }).waitFor();
    expect(await page.locator(".ibx-done").count()).toBe(0);
    await seg.nth(1).click();
    await page.waitForURL(new RegExp(`/p/${p.id}/inbox/done$`));
    const row = page.locator(".ibx-done__row", { hasText: "끝난 결재" });
    await row.getByText("답: A안").waitFor();
    await row.getByText("메모: 조건 메모").waitFor();
    await row.locator(".ibx-flow").waitFor();
    expect(await page.locator(".ibx-card").count()).toBe(0);
    expect(await row.locator(".ibx-detail").count()).toBe(0);
    await row.getByRole("button", { name: /배경 보기/ }).click();
    expect(await row.locator(".ibx-detail strong").innerText()).toBe("배경");
    await page.reload();
    await page.locator(".ibx-done__row", { hasText: "끝난 결재" }).waitFor();
    expect(await page.locator(".ibx-seg__item[aria-current]").innerText()).toContain("결재된 항목");
    // 답하면 건수가 함께 움직이고, 쪽을 옮기면 결재된 항목으로 넘어간다.
    await seg.nth(0).click();
    await confirmCard(page, "남은 결재", "가");
    await page.locator(".ibx-card--answered", { hasText: "남은 결재" }).waitFor();
    expect((await seg.nth(1).innerText()).replace(/\s+/g, " ")).toBe("결재된 항목 2");
    await seg.nth(1).click();
    await page.locator(".ibx-done__row", { hasText: "남은 결재" }).waitFor();
    await seg.nth(0).click();
    await page.getByText("결재할 항목이 없습니다").waitFor();
    await page.close();
  }, 30_000);
});

describe("연결 게이트", () => {
  const OFF = { ok: false, reason: "runner_off", detail: "AI가 아직 연결되지 않았습니다. 총괄을 시작하거나 기존 세션을 편입하세요" };

  /** 프로젝트가 연결되지 않은 것으로 보이는 페이지. 직접 띄운 세션의 결재 카드를 그대로 두려고 응답만 고친다. */
  async function openDisconnected(ctx: BrowserContext, projectId: string): Promise<Page> {
    const page = await ctx.newPage();
    await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    await page.route("**/api/bootstrap", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { projects: { id: string; connection: unknown }[] };
      for (const x of body.projects) if (x.id === projectId) x.connection = OFF;
      await route.fulfill({ response: res, json: body });
    });
    await page.route(`**/api/projects/${projectId}/state`, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { project: { connection: unknown } };
      body.project.connection = OFF;
      await route.fulfill({ response: res, json: body });
    });
    // 진짜 소켓 이벤트가 고친 값을 되돌리지 않게 이어 주지 않는다.
    await page.routeWebSocket(/\/ws/, () => {});
    await page.goto(`${base}/#/p/${projectId}/inbox`);
    return page;
  }

  test("직원 상세: 연결되기 전에는 직접 지시칸 대신 연결 안내가 나오고, 팀 시작 안내에 저장만 된다는 말이 없다", async () => {
    const p = await newProject();
    await api("PATCH", `/api/projects/${p.id}`, { runnerEnabled: false });
    const { member } = await joinWorker(p.id, "철수");
    const page = await openDisconnected(desktop, p.id);
    await page.goto(`${base}/#/p/${p.id}/team/${member.id}`);
    await page.locator(".dialog__foot .gate").getByText("AI가 아직 연결되지 않았습니다").waitFor();
    expect(await page.getByRole("textbox", { name: /철수에게 직접 지시/ }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await page.locator(".tm-start").waitFor();
    // 시작 카드가 같은 안내를 하므로 입력칸 자리의 게이트는 숨긴다.
    expect(await page.locator(".shell__bottom .gate").isVisible()).toBe(false);
    const text = await page.locator(".tm-start").innerText();
    expect(text).toContain("넘겨받으면");
    expect(text).not.toContain("저장만");
    await page.close();
  }, 30_000);

  test("연결이 없으면 카드와 입력칸이 잠기고 팀으로 가는 길을 보인다. 초안은 남는다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    await ask(w.token, "잠긴 카드", [{ k: "a", label: "가" }, { k: "b", label: "나" }]);
    const first = await inbox(desktop, p.id);
    await input(first).fill("쓰던 초안");
    await first.locator(".ibx-card", { hasText: "잠긴 카드" }).getByRole("textbox", { name: "메모" }).fill("쓰던 메모");
    await first.close();
    const page = await openDisconnected(desktop, p.id);
    const card = page.locator(".ibx-card", { hasText: "잠긴 카드" });
    await card.waitFor();
    const gate = page.locator(".gate[data-gate='runner_off']");
    await gate.waitFor();
    expect(await gate.innerText()).toContain(OFF.detail);
    expect(await input(page).count()).toBe(0);
    expect(await page.getByRole("button", { name: "첨부" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "보내기", exact: true }).count()).toBe(0);
    expect(await card.locator(".ibx-opt").first().isDisabled()).toBe(true);
    const memo = card.getByRole("textbox", { name: "메모" });
    expect(await memo.isDisabled()).toBe(true);
    expect(await memo.inputValue()).toBe("쓰던 메모");
    await page.getByText("쓰던 글은 보관했습니다").waitFor();
    await gate.getByRole("link", { name: "팀 화면으로" }).click();
    await page.waitForURL(new RegExp(`/p/${p.id}/team$`));
    await page.close();
    // 연결되면 초안이 그대로 있다.
    const again = await inbox(desktop, p.id);
    expect(await input(again).inputValue()).toBe("쓰던 초안");
    await again.close();
  }, 30_000);

  test("서버가 409 로 거부하면 같은 문구를 보이고 글을 되돌리며 대화에 줄을 남기지 않는다. 첨부도 먼저 묻는다", async () => {
    const p = await newProject();
    const page = await inbox(desktop, p.id);
    await page.route(`**/api/projects/${p.id}/messages`, (route) =>
      route.request().method() === "POST" ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: OFF.detail }) }) : route.fallback(),
    );
    await input(page).fill("거부될 말");
    await input(page).press("Enter");
    const error = page.locator(".cmp__error");
    await error.waitFor();
    expect(await error.innerText()).toContain(OFF.detail);
    expect(await input(page).inputValue()).toBe("거부될 말");
    await page.evaluate((id) => (location.hash = `#/p/${id}/thread`), p.id);
    await page.waitForTimeout(300);
    expect(await page.locator(".th-mine", { hasText: "거부될 말" }).count()).toBe(0);
    await page.unroute(`**/api/projects/${p.id}/messages`);

    let uploadUrl = "";
    await page.route("**/api/uploads*", (route) => {
      uploadUrl = route.request().url();
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: OFF.detail }) });
    });
    await page.locator(".cmp input[type=file]").setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await until("첨부 거부", async () => (await error.innerText()).includes(OFF.detail));
    expect(uploadUrl).toContain(`project=${p.id}`);
    expect(await page.locator(".cmp-chip--file").count()).toBe(0);
    await page.close();
  }, 30_000);

  test("결재 답이 연결 때문에 거부되면 같은 문구를 보이고 고른 것을 지킨다", async () => {
    const p = await newProject();
    const w = await joinWorker(p.id, "철수");
    await ask(w.token, "거부될 결재", [{ k: "a", label: "가" }]);
    const page = await inbox(desktop, p.id);
    await page.route("**/api/decisions/*/answer", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: OFF.detail }) }));
    await confirmCard(page, "거부될 결재", "가");
    const card = page.locator(".ibx-card", { hasText: "거부될 결재" });
    await card.locator(".ibx-error", { hasText: OFF.detail }).waitFor();
    expect(await card.locator(".ibx-opt[aria-pressed='true']").count()).toBe(1);
    await page.close();
  }, 30_000);

  test("서버가 끊긴 동안 입력이 잠기고, 돌아오면 쓰던 글과 함께 풀린다", async () => {
    const p = await newProject();
    const page = await inbox(desktop, p.id);
    await input(page).fill("끊겨도 남을 글");
    let down = true;
    await page.routeWebSocket(/\/ws/, (socket) => {
      if (down) void socket.close();
      else socket.connectToServer();
    });
    await page.reload();
    await page.locator(".gate[data-gate='server']").waitFor({ timeout: 8000 });
    expect(await page.locator(".gate").innerText()).toContain("서버 연결이 끊겼습니다");
    expect(await input(page).count()).toBe(0);
    down = false;
    await page.getByRole("button", { name: "지금 다시 연결" }).click();
    await input(page).waitFor({ timeout: 20_000 });
    expect(await input(page).inputValue()).toBe("끊겨도 남을 글");
    await page.close();
  }, 40_000);
});
