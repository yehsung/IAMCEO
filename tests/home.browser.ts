// 홈 화면과 5칸 탭: 실제 서버 + Playwright chromium + 가짜 claude. 라이브 herdr·실제 ~/.iamceo 를 쓰지 않는다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Member, MemberStatus, Project, ProjectState } from "../shared/types.ts";
import { updateConfigFile } from "../server/config.ts";
import { auditContrast, auditLayout } from "./fixtures/layout-audit.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "bin", "iamceo.ts");
const FAKE = join(ROOT, "tests", "fixtures", "fake-claude.ts");
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-e2e-home-")));
const HOME = join(WORK, "home");
const PROJECT_DIR = join(WORK, "project");
const SHOTS = process.env.IAMCEO_SHOTS ?? join(WORK, "shots");
mkdirSync(PROJECT_DIR);
mkdirSync(SHOTS, { recursive: true });
const CODE = "home-code";

const STRIP = /^(HERDR_.*|CLAUDECODE|CLAUDE_CODE_.*)$/;
function env(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.test(k)) out[k] = v;
  return { ...out, IAMCEO_HOME: HOME, IAMCEO_TEST: "1", IAMCEO_CLAUDE_BIN: FAKE, IAMCEO_HERDR_SOCKET: join(WORK, "none.sock"), FAKE_CLAUDE_LOG: join(WORK, "fake.jsonl"), FAKE_CLAUDE_SESSIONS: join(WORK, "sessions"), ...extra };
}

let server: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let browser: Browser;
let desktop: BrowserContext;
let phone: BrowserContext;

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
const join_ = (projectId: string, name: string) => api<{ member: Member; token: string }>("POST", "/agent/join", { project: projectId, name, handle: `w${++counter}` });
const tool = (token: string, name: string, args: unknown) => api<{ text: string; wait?: { decisionId: string } }>("POST", "/agent/tool", { name, args }, token);
const state = (id: string) => api<ProjectState>("GET", `/api/projects/${id}/state`);

function sql(run: (db: Database) => void): void {
  const db = new Database(join(HOME, "iamceo.db"));
  run(db);
  db.close();
}
const setStatus = (id: string, status: MemberStatus) => sql((db) => db.run("UPDATE members SET status = ? WHERE id = ?", [status, id]));
function addWork(projectId: string, sec: string, titles: string[]): void {
  const at = new Date().toISOString();
  sql((db) => titles.forEach((title, i) => db.run("INSERT INTO work (id, project_id, sec, title, who, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [`w_${crypto.randomUUID()}`, projectId, sec, title, "민수", i, at, at])));
}

async function open(ctx: BrowserContext, hash: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
  await page.goto(`${base}/${hash}`);
  return page;
}
const home = async (ctx: BrowserContext, id: string): Promise<Page> => {
  const page = await open(ctx, `#/p/${id}/home`);
  await page.locator(".hm").waitFor();
  return page;
};
const until = async (label: string, cond: () => Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`${label} 시간 초과`);
    await Bun.sleep(40);
  }
};
const tabs = (page: Page) => page.locator(".gtabs__link");
const tabCount = (page: Page, label: string) => tabs(page).filter({ hasText: label }).locator(".gtabs__count");

/** 온갖 칸이 다 차 있는 프로젝트 */
async function fullProject() {
  const p = await newProject("랜딩 개편");
  const [a, b, c, d, e, f] = await Promise.all(["민수", "지영", "철수", "영희", "현우", "수아"].map((n) => join_(p.id, n)));
  await tool(a!.token, "status", { now: "결제 페이지 시안을 그리는 중" });
  await tool(b!.token, "status", { now: "로그 분석 스크립트 작성" });
  await tool(c!.token, "status", { now: "문구 다듬기" });
  await tool(f!.token, "status", { now: "넷째로 일하는 직원이라 안 보여야 함" });
  await api("PATCH", `/api/projects/${p.id}`, { now: "**결제 시안**을 만드는 중입니다. 오늘 안에 첫 안이 나옵니다." });
  const asks = [];
  for (const title of ["색 방향 정하기", "가격표 문구 고르기", "출시 날짜 정하기", "넷째 결재"]) {
    const r = await tool(e!.token, "ask", { title, detail: `${title} 설명`, options: [{ k: "a", label: "가" }, { k: "b", label: "나" }] });
    asks.push(r.wait?.decisionId);
  }
  await tool(a!.token, "todo", { title: "로고 원본 파일 보내기", detail: "시안에 넣을 **로고**가 필요합니다.\n\n- SVG 면 좋습니다\n- 없으면 PNG" });
  await tool(b!.token, "todo", { title: "결제 시험 계정 만들어 주기", detail: "카드사 시험 계정이 있어야 결제 흐름을 돌릴 수 있습니다." });
  await tool(c!.token, "todo", { title: "상세 없는 일" });
  for (let i = 1; i <= 6; i++) await tool(a!.token, "post", { kind: i === 6 ? "완료" : "진행", title: `보고 ${i}번`, body: `보고 ${i} 내용` });
  for (let i = 1; i <= 4; i++) {
    await tool(b!.token, "file", { title: `자료 ${i}번`, summary: "요약", content: `# 자료 ${i}` });
    await Bun.sleep(5);
  }
  addWork(p.id, "doing", ["결제 시안"]);
  addWork(p.id, "next", ["일1", "일2", "일3", "일4", "일5", "일6"]);
  for (const [m, s] of [[a, "working"], [b, "working"], [c, "working"], [f, "working"], [d, "blocked"], [e, "waiting"]] as const) setStatus(m!.member.id, s);
  return { p, a: a!, b: b!, c: c!, d: d!, e: e!, f: f! };
}
let full: Awaited<ReturnType<typeof fullProject>>;

beforeAll(async () => {
  mkdirSync(HOME, { recursive: true });
  const port = freePort();
  updateConfigFile({ accessCode: CODE, port, hosts: ["127.0.0.1"] }, { IAMCEO_HOME: HOME });
  server = Bun.spawn([process.execPath, CLI, "serve"], { cwd: ROOT, env: env({ IAMCEO_PORT: String(port) }), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  base = `http://127.0.0.1:${port}`;
  await until("서버", () => fetch(`${base}/api/health`).then((r) => r.ok, () => false), 15000);
  await api("PUT", "/api/settings", { backend: "headless" });
  browser = await chromium.launch();
  desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  desktop.setDefaultTimeout(10_000);
  phone.setDefaultTimeout(10_000);
  full = await fullProject();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
  await server?.exited;
});

describe("탭", () => {
  test("프로젝트는 5칸, 본사는 팀 없이 4칸이고 기본 진입·잘못된 주소는 홈이다", async () => {
    const page = await open(desktop, `#/p/${full.p.id}`);
    await page.locator(".hm").waitFor();
    expect(await tabs(page).allTextContents().then((t) => t.map((x) => x.replace(/\d+/g, "")))).toEqual(["홈", "결재함", "팀", "대화", "자료"]);
    expect(page.url()).toEndWith("/home");
    await page.evaluate((id) => (location.hash = `#/p/${id}/없는탭`), full.p.id);
    await until("잘못된 탭은 홈", async () => page.url().endsWith("/home"));
    await page.evaluate(() => (location.hash = "#/p/hq/team"));
    await until("본사 팀 탭은 없다", async () => page.url().endsWith("/p/hq/home"));
    expect(await tabs(page).allTextContents().then((t) => t.map((x) => x.replace(/\d+/g, "")))).toEqual(["홈", "결재함", "대화", "자료"]);
    await page.evaluate(() => (location.hash = ""));
    await until("빈 주소는 본사 홈", async () => page.url().endsWith("/p/hq/home"));
    await page.close();
  }, 20_000);

  test("배지: 홈은 내 할 일, 결재함은 결재+승인 창 앞, 왼쪽 목록은 합계", async () => {
    const page = await home(desktop, full.p.id);
    await expect(tabCount(page, "홈").textContent()).resolves.toBe("3");
    await expect(tabCount(page, "결재함").textContent()).resolves.toBe("5");
    await expect(page.locator(".pj", { hasText: "랜딩 개편" }).locator(".badge").textContent()).resolves.toBe("8");
    await page.close();
  }, 15_000);

  test("폰 다섯 칸이 390·320 에서 안 깨지고 건수가 글자를 밀지 않는다", async () => {
    for (const width of [390, 320]) {
      const ctx = await browser.newContext({ viewport: { width, height: 700 }, hasTouch: true, isMobile: true });
      const page = await home(ctx, full.p.id);
      const boxes = await tabs(page).evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        const label = el.querySelector(".gtabs__label")!;
        const count = el.querySelector(".gtabs__count")?.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(label.firstChild!);
        const t = text.getBoundingClientRect();
        return { w: r.width, h: r.height, right: r.right, textLeft: t.left - r.left, textRight: r.right - t.right, count: count ? { right: count.right, top: count.top } : null };
      }));
      expect(boxes.length).toBe(5);
      for (const b of boxes) {
        expect(b.right).toBeLessThanOrEqual(width);
        expect(b.textLeft).toBeGreaterThanOrEqual(0);
        expect(b.textRight).toBeGreaterThanOrEqual(0);
        if (b.count) expect(b.count.right).toBeLessThanOrEqual(width);
      }
      await page.screenshot({ path: join(SHOTS, `tabs-${width}.png`) });
      expect(await auditLayout(page)).toEqual([]);
      await ctx.close();
    }
  }, 30_000);
});

describe("내가 할 일", () => {
  test("한 줄로만 보이고, 줄을 누르면 부드럽게 펼쳐지며 체크와 분리된다", async () => {
    const page = await home(desktop, full.p.id);
    const row = page.locator(".hm-todo", { hasText: "로고 원본" });
    const fold = row.locator(".hm-fold");
    // 접힘: 제목만 보인다
    expect(await row.getByText("SVG 면 좋습니다").isVisible()).toBe(false);
    const closed = await row.boundingBox();
    expect(closed!.height).toBeLessThanOrEqual(46);
    const toggle = row.locator(".hm-todo__toggle");
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");

    // 눌러 펼치는 동안 높이가 중간값을 지난다(한 번에 뛰지 않는다)
    const heights = await toggle.evaluate(async (el) => {
      const foldEl = el.closest(".hm-todo")!.querySelector(".hm-fold")!;
      (el as HTMLElement).click();
      const seen: number[] = [];
      for (let i = 0; i < 40; i++) {
        await new Promise(requestAnimationFrame);
        seen.push(foldEl.getBoundingClientRect().height);
      }
      return seen;
    });
    const final = heights.at(-1)!;
    expect(final).toBeGreaterThan(40);
    expect(heights.some((h) => h > 1 && h < final - 1)).toBe(true);
    expect(await row.getByText("SVG 면 좋습니다").isVisible()).toBe(true);
    await row.getByText("민수의 요청").waitFor();
    expect(await row.locator("time").count()).toBe(1);
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await row.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
    expect((await state(full.p.id)).todos.filter((t) => t.done).length).toBe(0);

    // 체크는 펼침을 건드리지 않는다
    const other = page.locator(".hm-todo", { hasText: "결제 시험 계정" });
    const before = await other.locator(".hm-todo__toggle").getAttribute("aria-expanded");
    await toggle.click();
    await until("접힘", async () => (await fold.boundingBox())?.height === 0);
    await row.getByText("SVG 면 좋습니다").waitFor({ state: "hidden" });
    expect(before).toBe("false");
    await page.close();
  }, 20_000);

  test("체크하면 잠시 뒤 '완료 N' 접기로 들어가고, 해제하면 위로 돌아온다", async () => {
    const p = await newProject();
    const w = await join_(p.id, "민수");
    await tool(w.token, "todo", { title: "먼저 할 일", detail: "자세한 내용" });
    await tool(w.token, "todo", { title: "둘째 할 일" });
    const page = await home(desktop, p.id);
    const first = page.locator(".hm-todo", { hasText: "먼저 할 일" });
    await first.getByRole("checkbox").click();
    expect(await first.locator(".hm-todo__toggle").getAttribute("aria-expanded")).toBe("false");
    await until("서버 반영", async () => (await state(p.id)).todos.find((t) => t.title === "먼저 할 일")!.done);
    await tabCount(page, "홈").filter({ hasText: "1" }).waitFor();
    const fold = page.getByRole("button", { name: "완료 1" });
    await fold.waitFor();
    expect(await page.locator(".hm-todo", { hasText: "먼저 할 일" }).count()).toBe(0);
    // 안 한 일이 위, 접기 안에 한 일
    await fold.click();
    await first.waitFor();
    const order = await page.locator(".hm-todo__title").allTextContents();
    expect(order).toEqual(["둘째 할 일", "먼저 할 일"]);
    await first.locator(".hm-todo__toggle").click();
    await first.getByText("민수에게 알림").waitFor();
    await page.waitForTimeout(450);
    await first.getByRole("checkbox").click();
    await until("해제 반영", async () => !(await state(p.id)).todos.find((t) => t.title === "먼저 할 일")!.done);
    await tabCount(page, "홈").filter({ hasText: "2" }).waitFor();
    expect(await page.getByRole("button", { name: /^완료/ }).count()).toBe(0);
    await page.close();
  }, 25_000);

  test("키보드로 체크해도 초점을 잃지 않는다", async () => {
    const p = await newProject();
    const w = await join_(p.id, "민수");
    await tool(w.token, "todo", { title: "하나" });
    const page = await home(desktop, p.id);
    await page.getByRole("checkbox", { name: "하나 했음" }).focus();
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "완료 1" }).waitFor();
    await until("초점이 접기로", () => page.evaluate(() => document.activeElement?.textContent?.startsWith("완료") ?? false), 3000);
    await page.close();
  }, 15_000);
});

describe("칸", () => {
  test("결재 대기: 건수·맨 위 3건·승인 창 앞, 눌러서 해당 카드로", async () => {
    const page = await home(desktop, full.p.id);
    const card = page.getByRole("region", { name: "결재 대기" });
    await expect(card.locator(".hm-count").textContent()).resolves.toBe("5");
    expect(await card.locator(".hm-row__title").allTextContents()).toEqual(["영희", "색 방향 정하기", "가격표 문구 고르기", "출시 날짜 정하기"]);
    await card.getByText("승인 창 앞").waitFor();
    await card.getByText("외 1건").waitFor();
    await card.getByRole("link", { name: /가격표 문구/ }).click();
    await until("결재함으로", async () => /\/inbox\/d_/.test(page.url()));
    await page.locator("[data-decision]", { hasText: "가격표 문구" }).waitFor();
    await page.goBack();
    await page.locator(".hm").waitFor();
    await card.getByRole("link", { name: /영희/ }).click();
    await until("직원 상세로", async () => page.url().endsWith(`/team/${full.d.member.id}`));
    await page.close();
  }, 20_000);

  test("팀: 0 인 칩은 숨고 일하는 직원은 3명까지, 눌러서 상세로", async () => {
    const page = await home(desktop, full.p.id);
    const card = page.getByRole("region", { name: "팀", exact: true });
    const chips = (await card.locator(".hm-chip").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
    expect(chips.map((c) => c.replace(/^(일하는 중|내 답 기다림|승인 창 앞)/, "").trim())).toEqual(["일함 4", "내 답 기다림 1", "승인 창 앞 1"]);
    expect(await card.locator(".hm-row__title").allTextContents()).toEqual(["민수", "지영", "철수"]);
    await card.getByText("결제 페이지 시안을 그리는 중").waitFor();
    await card.getByRole("link", { name: /지영/ }).click();
    await until("직원 상세로", async () => page.url().endsWith(`/team/${full.b.member.id}`));
    await page.close();
  }, 15_000);

  test("AI가 곧 할 일·최근 보고·최근 자료: 개수 제한과 이어짐", async () => {
    const page = await home(desktop, full.p.id);
    const work = page.getByRole("region", { name: "AI가 곧 할 일" });
    await work.getByText("결제 시안").waitFor();
    expect(await work.locator(".hm-work__list").nth(1).locator("li").count()).toBe(5);
    await work.getByText("외 1건").waitFor();

    const reports = page.getByRole("region", { name: "최근 보고" });
    expect(await reports.locator(".hm-row__title").allTextContents()).toEqual(["보고 6번", "보고 5번", "보고 4번", "보고 3번", "보고 2번"]);
    await reports.getByRole("link", { name: /보고 5번/ }).click();
    await until("대화로", async () => page.url().endsWith("/thread"));
    await page.goBack();
    await page.locator(".hm").waitFor();

    const files = page.getByRole("region", { name: "최근 자료" });
    expect(await files.locator(".hm-row__title").allTextContents()).toEqual(["자료 4번", "자료 3번", "자료 2번"]);
    await files.getByRole("link", { name: /자료 3번/ }).click();
    await until("자료로", async () => /\/files\/f_/.test(page.url()));
    await page.locator(".fl-doc__title", { hasText: "자료 3번" }).waitFor();
    await page.close();
  }, 20_000);

  test("최근 보고: 완료·질문 같은 실제 보고가 먼저고, 답에 따라붙는 글은 남는 칸에만 들어간다", async () => {
    const p = await newProject();
    const { member } = await join_(p.id, "민수");
    const at = (i: number) => new Date(Date.now() + i * 1000).toISOString();
    sql((db) => {
      const add = (i: number, kind: string, title: string) => db.run("INSERT INTO messages (id, project_id, at, member_id, who, kind, title) VALUES (?,?,?,?,?,?,?)", [`m_${crypto.randomUUID()}`, p.id, at(i), member.id, "민수", kind, title]);
      add(0, "완료", "비교표 완료");
      add(1, "알림", "(자동) 받음 1");
      for (let i = 2; i < 8; i++) add(i, i % 2 ? "답변" : "알림", `메아리 ${i}`);
    });
    const page = await home(desktop, p.id);
    const titles = await page.getByRole("region", { name: "최근 보고" }).locator(".hm-row__title").allTextContents();
    expect(titles).toEqual(["메아리 7", "메아리 6", "메아리 5", "메아리 4", "비교표 완료"]);
    await page.close();
  }, 20_000);

  test("빈 프로젝트: 빈 칸은 그리지 않고, 연결 안 됨이면 맨 위에 안내", async () => {
    const p = await newProject("빈 프로젝트");
    await api("PATCH", `/api/projects/${p.id}`, { runnerEnabled: false });
    const page = await home(desktop, p.id);
    expect(await page.locator(".hm-card").count()).toBe(0);
    await page.locator(".hm-clear").waitFor();
    const gate = page.locator(".hm > .gate");
    await gate.getByText(/AI가 아직 연결되지 않았습니다. 총괄을 시작하거나/).waitFor();
    expect(await page.locator(".hm > *").first().evaluate((el) => el.classList.contains("gate"))).toBe(true);
    expect(await page.locator(".shell__bottom .gate").isVisible()).toBe(false);
    expect(await page.getByRole("textbox", { name: "입력칸" }).count()).toBe(0);
    await page.screenshot({ path: join(SHOTS, "empty-desk.png") });
    await gate.getByRole("link").click();
    await until("팀으로", async () => page.url().endsWith("/team"));
    await page.close();
  }, 15_000);

  test("본사: 팀 칸 대신 본사 AI 상세 줄", async () => {
    await api("POST", "/api/projects/hq/messages", { id: crypto.randomUUID(), text: "@fake:delay=300 안녕" });
    await until("본사 AI", async () => (await state("hq")).members.length > 0);
    const page = await home(desktop, "hq");
    const card = page.getByRole("region", { name: "본사 AI" });
    await card.getByRole("link").click();
    await page.locator("dialog[open]").getByText("활동").first().waitFor();
    expect(page.url()).toContain("/team/");
    await page.getByRole("button", { name: "닫기" }).click();
    await until("본사 홈으로", async () => page.url().endsWith("/p/hq/home"));
    await page.close();
  }, 20_000);
});

describe("겉모습", () => {
  test("넘침·가림·누를 자리·대비, 캡처", async () => {
    for (const [ctx, label, widths] of [[desktop, "desk", [1440, 1024]], [phone, "phone", [390]]] as const) {
      for (const width of widths) {
        const page = await open(ctx, `#/p/${full.p.id}/home`);
        await page.setViewportSize({ width, height: ctx === desktop ? 900 : 844 });
        await page.locator(".hm").waitFor();
        await page.locator(".hm-todo", { hasText: "로고 원본" }).locator(".hm-todo__toggle").click();
        await page.waitForTimeout(450);
        await page.screenshot({ path: join(SHOTS, `home-${label}-${width}.png`) });
        expect(await auditLayout(page)).toEqual([]);
        const small = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of document.querySelectorAll(".hm a, .hm button")) {
            const r = el.getBoundingClientRect();
            if (r.height > 0 && r.height < 44) out.push(`${el.className} ${r.height}`);
            if (r.height > 0 && r.width < 44) out.push(`${el.className} w${r.width}`);
          }
          return out;
        });
        expect(small).toEqual([]);
        expect(await auditContrast(page)).toEqual([]);
        const scroller = page.locator("[data-scroll-root]");
        await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(SHOTS, `home-${label}-${width}-end.png`) });
        expect(await auditContrast(page)).toEqual([]);
        await page.close();
      }
    }
  }, 60_000);

  test("폰 320 도 넘치지 않는다", async () => {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });
    const page = await home(ctx, full.p.id);
    await page.screenshot({ path: join(SHOTS, "home-phone-320.png") });
    expect(await auditLayout(page)).toEqual([]);
    await ctx.close();
  }, 15_000);
});
