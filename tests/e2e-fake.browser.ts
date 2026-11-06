// 실제 서버 프로세스 + 실제 화면(Playwright chromium) + 가짜 claude. 데스크톱·폰 두 창이 같은 서버를 함께 본다.
// 가짜 세션의 도구 호출은 브리지 없이 HTTP 로 간다. 브리지와 컴파일 실행 파일은 맨 아래 묶음에서 따로 본다.
// 라이브 herdr·실제 ~/.iamceo·실제 claude 는 쓰지 않는다. 캡처는 임시 폴더에 남긴다(IAMCEO_E2E_SHOTS 로 바꿀 수 있다).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startBrowserCore } from "./fixtures/core-browser-harness";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import type { Bootstrap, Member, ProjectState } from "../shared/types.ts";
import { updateConfigFile } from "../server/config.ts";

const core = await startBrowserCore();
afterAll(async () => { await core.stop(); });

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "bin", "iamceo.ts");
const FAKE = join(ROOT, "tests", "fixtures", "fake-claude.ts");
const STEP_MS = 45_000;

const WORK = mkdtempSync(join(tmpdir(), "iamceo-e2e-"));
const SHOTS = process.env.IAMCEO_E2E_SHOTS ?? mkdtempSync(join(tmpdir(), "iamceo-shots-"));
mkdirSync(SHOTS, { recursive: true });
const HOME = join(WORK, "home");
const PROJECT_DIR = join(WORK, "project");
mkdirSync(PROJECT_DIR);
const FAKE_LOG = join(WORK, "fake.log");

// 첫 규칙이 이긴다. 총괄에게는 결재 답 알림이 보고에 묶여 오므로 보고를 맨 앞에 둔다.
const SCRIPT = [
  { when: "[보고 민수]", text: "민수 보고를 확인했습니다. 시안 검토를 부탁드립니다." },
  {
    when: "[대표] \"랜딩 시안 만들어 줘\"",
    tools: [
      { name: "project_now", args: { text: "민수가 랜딩 시안을 만드는 중입니다" } },
      { name: "work_set", args: { sec: "doing", title: "랜딩 시안", detail: "색 방향을 정한 뒤 시안 작성", who: "민수" } },
      { name: "work_set", args: { sec: "next", title: "시안 검토", who: "총괄" } },
      {
        name: "team_add",
        args: { name: "민수", role: "화면 구현", handle: "minsu", first_instruction: "랜딩 시안을 만드세요. 색 방향은 대표에게 물으세요.", user_quote: "랜딩 시안 만들어 줘" },
      },
    ],
    text: "민수에게 랜딩 시안을 맡겼습니다.",
    usage: 40_000,
  },
  {
    when: "[총괄] 민수에게",
    tools: [
      { name: "status", args: { now: "색 방향을 대표에게 묻는 중", next: "시안 작성" } },
      {
        name: "ask",
        args: {
          title: "랜딩 색 방향을 정해 주세요",
          detail: "지금 브랜드 색은 **보라**입니다. 어느 쪽으로 시안을 만들까요?",
          options: [
            { k: "keep", label: "보라 유지", desc: "브랜드와 같게 갑니다" },
            { k: "blue", label: "파랑으로", desc: "새 느낌을 줍니다" },
          ],
          rec: "keep",
        },
      },
      { name: "todo", args: { title: "로고 원본 파일 보내기", detail: "시안에 넣을 로고가 필요합니다" } },
    ],
    silent: true,
    usage: 150_000,
  },
  {
    when: "[대표 답(원문)",
    tools: [
      { name: "status", args: { now: "시안 작성 중", next: "보고" } },
      {
        name: "file",
        args: {
          title: "랜딩 시안 1안",
          summary: "보라 유지로 만든 첫 시안입니다.",
          content: "# 랜딩 시안 1안\n\n- 머리말: 보라 그라데이션\n- 버튼: **유리**\n\n| 항목 | 값 |\n|---|---|\n| 색 | 보라 |\n\n<script>window.__xss = 1</script>",
        },
      },
      { name: "post", args: { kind: "완료", title: "랜딩 시안을 만들었습니다", body: "보라 유지로 1안을 올렸습니다. 검토해 주세요.", file_ids: ["$last"] } },
    ],
    delay: 1500,
    silent: true,
    usage: 60_000,
  },
  { when: "다시 열린 뒤 확인", text: "다시 열린 세션입니다." },
];

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };

let server: ReturnType<typeof Bun.spawn>;
let port = 0;
let base = "";
let code = "";
let projectId = "";
let browser: Browser;
let deskCtx: BrowserContext;
let phoneCtx: BrowserContext;
let desk: Page;
let phone: Page;
const browserErrors: string[] = [];
const layoutProblems: string[] = [];

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(HERDR_|CLAUDE|IAMCEO_)/.test(k)) env[k] = v;
  }
  return { ...env, ...core.env, IAMCEO_TEST: "1", ...extra };
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const found = probe.port!;
  await probe.stop(true);
  return found;
}

async function waitHealthy(url: string, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) return;
    if (proc.exitCode !== null) throw new Error(`서버가 끝났습니다(코드 ${proc.exitCode})`);
    await Bun.sleep(50);
  }
  throw new Error("서버가 뜨지 않았습니다");
}

function spawnServer(cmd: string[], home: string, listen: number, extra: Record<string, string> = {}) {
  return Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv({
      IAMCEO_HOME: home,
      IAMCEO_PORT: String(listen),
      IAMCEO_CLAUDE_BIN: FAKE,
      IAMCEO_HERDR_SOCKET: join(home, "no-herdr.sock"),
      FAKE_CLAUDE_LOG: FAKE_LOG,
      FAKE_CLAUDE_SCRIPT: join(WORK, "script.json"),
      ...extra,
    }),
  });
}

async function startServerProcess(): Promise<void> {
  server = spawnServer([process.execPath, CLI, "serve"], HOME, port);
  await waitHealthy(base, server);
}

const headers = () => ({ Authorization: `Bearer ${code}`, "Content-Type": "application/json" });
async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
const projectState = () => apiGet<ProjectState>(`/api/projects/${projectId}/state`);

async function memberNamed(name: string): Promise<Member> {
  const found = (await projectState()).members.find((m) => m.name === name);
  if (!found) throw new Error(`직원이 없습니다: ${name}`);
  return found;
}

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await Bun.sleep(50);
  }
  throw new Error(`기다리다 끝남: ${what} (마지막 값: ${JSON.stringify(last)})`);
}

/** 가짜 세션이 받은 글(JSON 줄이라 따옴표는 이스케이프되어 있다). 실패해도 로그 전체를 쏟지 않는다. */
async function sessionGot(text: string): Promise<void> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if (readFileSync(FAKE_LOG, "utf8").includes(text)) return;
    await Bun.sleep(50);
  }
  throw new Error(`세션에 전달되지 않음: ${text}`);
}

function watchErrors(page: Page, label: string): void {
  page.on("pageerror", (e) => browserErrors.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // 일부러 끊은 연결·틀린 코드는 브라우저가 스스로 콘솔에 남긴다.
    if (/Failed to load resource|ERR_CONNECTION|WebSocket connection/.test(text)) return;
    browserErrors.push(`${label} console: ${text}`);
  });
}

/** 가로 넘침과 고정 틀에 가려 못 닿는 내용을 찾는다. */
async function auditLayout(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const vw = window.innerWidth;
    const root = document.scrollingElement!;
    if (root.scrollWidth > vw + 1) problems.push(`문서 가로 넘침 ${root.scrollWidth}>${vw}`);

    const scroller = document.querySelector<HTMLElement>("[data-scroll-root]");
    if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) problems.push(`본문 가로 넘침 ${scroller.scrollWidth}>${scroller.clientWidth}`);

    const clipped = (el: Element): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (p.hasAttribute("data-scroll-root")) return false;
        const { overflowX } = getComputedStyle(p);
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll("button, a, input, textarea, h1, h2, h3, p, li, code, pre")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      if ((r.right > vw + 1 || r.left < -1) && !clipped(el)) {
        problems.push(`화면 밖: <${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}"> ${Math.round(r.left)}~${Math.round(r.right)} "${(el.textContent ?? "").trim().slice(0, 24)}"`);
      }
    }

    const top = document.querySelector(".shell__top");
    const bottom = document.querySelector(".shell__bottom");
    const column = scroller?.querySelector(".shell__column");
    const hasOverlay = document.querySelector("dialog[open], [role='dialog']") !== null;
    if (scroller && column && top && bottom && !hasOverlay) {
      const saved = scroller.scrollTop;
      const kids = [...column.querySelectorAll(":scope > * > *, :scope > *")].filter((k) => k.getBoundingClientRect().height > 0);
      scroller.scrollTop = 0;
      const firstTop = Math.min(...kids.map((k) => k.getBoundingClientRect().top));
      const topEdge = [...top.children].reduce((edge, c) => (getComputedStyle(c).pointerEvents === "none" ? edge : Math.max(edge, c.getBoundingClientRect().bottom)), 0);
      if (kids.length > 0 && firstTop < topEdge - 1) problems.push(`맨 위 내용이 위 틀에 가림 ${Math.round(firstTop)}<${Math.round(topEdge)}`);
      scroller.scrollTop = scroller.scrollHeight;
      const lastBottom = Math.max(...kids.map((k) => k.getBoundingClientRect().bottom));
      const bottomEdge = bottom.getBoundingClientRect().top;
      if (kids.length > 0 && bottom.getBoundingClientRect().height > 0 && lastBottom > bottomEdge + 1) problems.push(`맨 아래 내용이 입력칸에 가림 ${Math.round(lastBottom)}>${Math.round(bottomEdge)}`);
      scroller.scrollTop = saved;
    }
    return problems;
  });
}

/** 글자색과 그 자리 실제 바탕(글자를 지우고 찍은 화면)의 대비. 유리·빛이 있어 계산으로는 알 수 없다. */
async function auditContrast(page: Page): Promise<string[]> {
  // 글자를 지우기 전에 읽는다. 지운 뒤에는 color 전환이 끝날 때까지 값이 흔들린다.
  const items = await page.evaluate(() => {
    const topEdge = document.querySelector(".shell__top")?.getBoundingClientRect().bottom ?? 0;
    const bottomEdge = document.querySelector(".shell__bottom")?.getBoundingClientRect().top ?? window.innerHeight;
    const found: { x: number; y: number; w: number; h: number; color: string; alpha: number; large: boolean; label: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (!text || !el || el.closest(".sr-only, [aria-hidden='true'], script, style")) continue;
      if (el.closest("[disabled], [aria-disabled='true'], [data-off]")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      // 말줄임으로 잘린 글의 범위는 상자 밖까지 뻗는다.
      const box = getComputedStyle(el).overflowX === "visible" ? r : el.getBoundingClientRect();
      const x = Math.max(0, r.left, box.left);
      const y = Math.max(0, r.top, box.top);
      const w = Math.min(window.innerWidth, r.right, box.right) - x;
      const h = Math.min(window.innerHeight, r.bottom, box.bottom) - y;
      if (w < 1 || h < 1) continue;
      // 위 틀·입력칸의 띠 밑으로 지나가는 중이거나 덮개에 가린 글은 일부러 안 보이게 한 글이다.
      if (el.closest("[data-scroll-root]") && (y < topEdge + 40 || y + h > bottomEdge - 30)) continue;
      const top = document.elementFromPoint(x + w / 2, y + h / 2);
      if (!top || !(el === top || el.contains(top) || top.contains(el))) continue;
      const style = getComputedStyle(el);
      let alpha = 1;
      for (let p: Element | null = el; p; p = p.parentElement) alpha *= Number(getComputedStyle(p).opacity);
      if (alpha < 0.05 || style.visibility !== "visible") continue;
      const size = Number.parseFloat(style.fontSize);
      found.push({ x, y, w, h, color: style.color, alpha, large: size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700), label: `<${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}"> "${text.slice(0, 20)}"` });
    }
    return found;
  });
  const style = await page.addStyleTag({ content: "* { color:transparent !important; -webkit-text-fill-color:transparent !important; text-shadow:none !important; transition:none !important; caret-color:transparent !important; } ::placeholder { color:transparent !important; } img, svg { visibility:hidden !important; }" });
  const bare = (await page.screenshot()).toString("base64");
  await style.evaluate((el) => (el as HTMLElement).remove());
  return page.evaluate(
    async ({ png, items }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const scale = image.width / window.innerWidth;
      const linear = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
      const luminance = ([r, g, b]: number[]) => 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);

      const problems = new Set<string>();
      for (const item of items) {
        const match = /rgba?\(([^)]+)\)/.exec(item.color);
        if (!match) continue;
        const parts = match[1]!.split(/[ ,/]+/).map(Number);
        const alpha = (parts[3] ?? 1) * item.alpha;
        const data = ctx.getImageData(Math.round(item.x * scale), Math.round(item.y * scale), Math.max(1, Math.round(item.w * scale)), Math.max(1, Math.round(item.h * scale))).data;
        let worst = 21;
        for (let i = 0; i < data.length; i += 4 * 9) {
          const bg = [data[i]!, data[i + 1]!, data[i + 2]!];
          const fg = [0, 1, 2].map((c) => parts[c]! * alpha + bg[c]! * (1 - alpha));
          const [a, b] = [luminance(fg), luminance(bg)];
          worst = Math.min(worst, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
        }
        if (worst < (item.large ? 3 : 4.5)) problems.add(`대비 ${worst.toFixed(2)} ${item.label}`);
      }
      return [...problems];
    },
    { png: bare, items },
  );
}

async function shot(page: Page, name: string): Promise<void> {
  const label = page === desk ? "desk" : "phone";
  await page.waitForTimeout(350); // 유리 탭 물방울이 멈춘 뒤 찍는다.
  await page.screenshot({ path: join(SHOTS, `${label}-${name}.png`) });
  for (const problem of [...(await auditLayout(page)), ...(await auditContrast(page))]) layoutProblems.push(`${label}/${name}: ${problem}`);
}

async function shotBoth(name: string): Promise<void> {
  await Promise.all([shot(desk, name), shot(phone, name)]);
}

const go = (page: Page, tab: string, sub?: string) => page.evaluate((hash) => {
  location.hash = hash;
}, `#/p/${projectId}/${tab}${sub ? `/${sub}` : ""}`);

async function goBoth(tab: string, sub?: string): Promise<void> {
  await Promise.all([go(desk, tab, sub), go(phone, tab, sub)]);
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "입력칸" });
  await input.fill(text);
  // 터치 기기의 Enter 는 줄바꿈이다. 보내기 버튼으로 보낸다.
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) await page.getByRole("button", { name: "보내기" }).click();
  else await input.press("Enter");
}

const memberCard = (page: Page, name: string): Locator => page.locator(".tm-card", { has: page.locator(".tm-card__link", { hasText: name }) });

beforeAll(async () => {
  writeFileSync(join(WORK, "script.json"), JSON.stringify(SCRIPT));
  updateConfigFile({ hosts: ["127.0.0.1"] }, { IAMCEO_HOME: HOME });
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  code = (JSON.parse(readFileSync(join(HOME, "config.json"), "utf8")) as { accessCode?: string }).accessCode ?? "";
  if (!code) {
    code = "e2e-access-code";
    updateConfigFile({ accessCode: code }, { IAMCEO_HOME: HOME });
  }
  await startServerProcess();

  browser = await chromium.launch();
  deskCtx = await browser.newContext({ viewport: DESK, locale: "ko-KR" });
  phoneCtx = await browser.newContext({ viewport: PHONE, locale: "ko-KR", hasTouch: true, isMobile: true });
  desk = await deskCtx.newPage();
  phone = await phoneCtx.newPage();
  watchErrors(desk, "desk");
  watchErrors(phone, "phone");
  desk.setDefaultTimeout(15_000);
  phone.setDefaultTimeout(15_000);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
  await server?.exited;
  console.log(`캡처 폴더: ${SHOTS}\n시험 폴더: ${WORK}`);
}, 30_000);

describe("전 과정(가짜 claude, 데스크톱+폰)", () => {
  test("접속 코드: 틀린 코드는 거부되고 맞는 코드는 저장된다", async () => {
    await Promise.all([desk.goto(base), phone.goto(base)]);
    for (const page of [desk, phone]) await page.getByPlaceholder("접속 코드").waitFor();
    await shotBoth("01-code");

    await phone.getByPlaceholder("접속 코드").fill("한글코드");
    await phone.getByRole("button", { name: "들어가기" }).click();
    await phone.getByRole("alert").filter({ hasText: "맞지 않습니다" }).waitFor();
    await phone.getByPlaceholder("접속 코드").fill("wrong-code");
    await phone.getByRole("button", { name: "들어가기" }).click();
    await phone.getByRole("alert").filter({ hasText: "맞지 않습니다" }).waitFor();
    expect(await phone.evaluate(() => localStorage.getItem("iamceo.accessCode"))).toBeNull();
    await shot(phone, "02-code-error");

    await phone.getByPlaceholder("접속 코드").fill(code);
    await phone.getByRole("button", { name: "들어가기" }).click();
    await desk.getByPlaceholder("접속 코드").fill(code);
    await desk.getByRole("button", { name: "들어가기" }).click();
    for (const page of [desk, phone]) await page.getByRole("textbox", { name: "입력칸" }).waitFor();
    expect(await desk.evaluate(() => localStorage.getItem("iamceo.accessCode"))).toBe(code);
  }, STEP_MS);

  test("실행기는 core로 고정되고 두 기기가 바로 홈으로 들어간다", async () => {
    for (const page of [desk, phone]) await page.getByRole("textbox", { name: "입력칸" }).waitFor();
    expect((await apiGet<Bootstrap>("/api/bootstrap")).settings.backend).toBe("core");
    expect(await desk.locator(".su-card__pick").count()).toBe(0);
    await desk.getByText("지금 하실 일이 없습니다").waitFor();
    await phone.getByText("지금 하실 일이 없습니다").waitFor();
    await shotBoth("04-hq-home-empty");
  }, STEP_MS);

  test("새 프로젝트: 없는 폴더는 거부, 있는 폴더로 만든다", async () => {
    await phone.locator(".ph-switch").click();
    await phone.getByRole("button", { name: "새 프로젝트" }).waitFor();
    await shot(phone, "05-project-sheet");
    await phone.keyboard.press("Escape");

    await phone.locator(".ph-switch").click();
    await phone.getByRole("button", { name: "새 프로젝트" }).click();
    await phone.getByRole("heading", { name: "새 프로젝트" }).waitFor();
    await shot(phone, "06-new-project");
    await phone.keyboard.press("Escape");

    await desk.getByRole("button", { name: "새 프로젝트" }).click();
    const form = desk.locator("form.form");
    await form.getByPlaceholder("랜딩 리뉴얼").fill("랜딩 시안");
    await form.getByPlaceholder("~/code/landing").fill(join(WORK, "없는폴더"));
    await form.locator(".su-check input").uncheck();
    await shot(desk, "06-new-project");
    await form.getByRole("button", { name: "만들기" }).click();
    await form.getByRole("alert").filter({ hasText: "폴더가 없습니다" }).waitFor();

    await form.getByPlaceholder("~/code/landing").fill(PROJECT_DIR);
    await form.getByRole("button", { name: "만들기" }).click();
    await desk.getByRole("tab", { name: "팀" }).or(desk.getByRole("link", { name: "팀" })).first().waitFor();
    await until("주소에 프로젝트", () => desk.evaluate(() => location.hash), (h) => h.includes("/team"));
    projectId = /#\/p\/([^/]+)/.exec(await desk.evaluate(() => location.hash))![1]!;

    const state = await projectState();
    expect(state.project).toMatchObject({ name: "랜딩 시안", cwd: PROJECT_DIR, runnerEnabled: true });
    expect(state.members).toHaveLength(0);
    await phone.locator(".ph-switch").waitFor();
    await goBoth("team");
    await desk.getByText("아직 팀이 없습니다").waitFor();
    await phone.getByText("아직 팀이 없습니다").waitFor();
    await shotBoth("07-team-empty");
  }, STEP_MS);

  test("입력칸 지시: 총괄이 저절로 뜨고 직원을 꾸린다", async () => {
    await goBoth("thread");
    await desk.getByText("아직 대화가 없습니다").waitFor();
    await shotBoth("08-thread-empty");
    await send(desk, "랜딩 시안 만들어 줘");
    await desk.locator(".th-mine", { hasText: "랜딩 시안 만들어 줘" }).waitFor();

    const added = await until("민수 등록", projectState, (s) => s.members.some((m) => m.name === "민수"));
    const conductor = added.members.find((m) => m.kind === "conductor")!;
    expect(conductor).toBeTruthy();
    expect(conductor.origin).toBe("runner");
    await phone.locator(".th-mine", { hasText: "랜딩 시안 만들어 줘" }).waitFor();
    await desk.locator(".th-delivery", { hasText: "받음" }).first().waitFor();

    const log = readFileSync(FAKE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; prompt: string; env: string[]; args: string[]; stdinClosed: boolean });
    const first = log.find((l) => l.prompt.includes("[대표]"))!;
    expect(first.prompt).toContain('[대표] "랜딩 시안 만들어 줘"');
    expect(first.env).toEqual([]);
    expect(first.stdinClosed).toBe(true);
    expect(first.args).toContain("--session-id");
    // 직원의 첫 턴은 총괄 도구 호출 뒤에 뜬다. 기록이 남을 때까지 기다린다.
    const readLog = () => Promise.resolve(readFileSync(FAKE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { prompt: string }));
    const worker = (await until("직원 첫 지시", readLog, (l) => l.some((x) => x.prompt.includes("[총괄] 민수에게")))).find((l) => l.prompt.includes("[총괄] 민수에게"))!;
    expect(worker.prompt).toContain('사용자 요청(원문, 서버 확인): "랜딩 시안 만들어 줘"');

    await desk.locator(".th-card", { hasText: "민수에게 랜딩 시안을 맡겼습니다" }).waitFor();
    await shotBoth("09-thread-assigned");
  }, STEP_MS);

  test("직원 질문: 결재함에 카드가 오고 팀 화면은 내 답 기다림이 된다", async () => {
    await until("민수 결재", projectState, (s) => s.decisions.some((d) => d.status === "open"));
    await until("민수 기다림", () => memberNamed("민수"), (m) => m.status === "waiting");

    await goBoth("team");
    for (const page of [desk, phone]) {
      await memberCard(page, "민수").locator(".status", { hasText: "내 답 기다림" }).waitFor();
      await memberCard(page, "민수").getByText("색 방향을 대표에게 묻는 중").waitFor();
      await memberCard(page, "민수").getByText("1건 대기").waitFor();
      await page.getByText("민수가 랜딩 시안을 만드는 중입니다").first().waitFor();
      await page.locator(".tm-wi", { hasText: "랜딩 시안" }).first().waitFor();
    }
    // 문맥 75%(150000/200000)면 압축 예정 표시가 나온다.
    expect(await memberCard(desk, "민수").locator(".tm-ctx").count()).toBe(0); // core는 토큰 사용량을 추측하지 않는다.
    await shotBoth("10-team-waiting");

    await goBoth("inbox");
    for (const page of [desk, phone]) {
      const card = page.locator(".ibx-card", { hasText: "랜딩 색 방향을 정해 주세요" });
      await card.waitFor();
      await card.getByRole("button", { name: /보라 유지/ }).waitFor();
      await card.locator(".ibx-opt[data-rec]").getByText("권장").waitFor();
    }
    expect(await desk.locator(".ibx-detail strong").textContent()).toBe("보라");
    await desk.locator(".gtabs__link", { hasText: "결재함" }).locator(".gtabs__count").filter({ hasText: "1" }).waitFor();
    await desk.locator(".gtabs__link", { hasText: "홈" }).locator(".gtabs__count").filter({ hasText: "1" }).waitFor();
    await shotBoth("11-inbox-card");
  }, STEP_MS);

  test("결재 답: 메모와 함께 답하면 직원이 받아 일하고 자료·보고를 올린다", async () => {
    const card = phone.locator(".ibx-card", { hasText: "랜딩 색 방향을 정해 주세요" });
    await card.getByRole("textbox", { name: "메모" }).fill("로고는 나중에 보낼게요");
    await card.locator(".ibx-opt", { hasText: "보라 유지" }).tap();
    await phone.waitForTimeout(650); // 결정은 확인 버튼을 눌러야 나간다
    expect((await projectState()).decisions.find((d) => d.title.startsWith("랜딩 색"))!.status).toBe("open");
    await card.locator(".ibx-confirm__go").tap();

    // 답한 쪽 카드는 제자리에 남아 받음을 보여 주고, 다른 기기 카드도 답 단추가 사라진다.
    await phone.locator(".ibx-card--answered .ibx-flow[aria-label*='받음']").waitFor();
    await desk.locator(".ibx-opt").first().waitFor({ state: "detached" });
    await until("직원 작업 시작", () => memberNamed("민수"), (m) => m.status === "working");
    await shotBoth("12-inbox-answered");

    await sessionGot("[대표 답(원문) '랜딩 색 방향을 정해 주세요']");
    await sessionGot('메모 \\"로고는 나중에 보낼게요\\"');

    await goBoth("team");
    await memberCard(desk, "민수").locator(".status", { hasText: "일하는 중" }).waitFor();
    await shot(desk, "13-team-working");
    await memberCard(desk, "민수").locator(".status", { hasText: "대기" }).waitFor();
    await memberCard(phone, "민수").locator(".status", { hasText: "대기" }).waitFor();
    await memberCard(desk, "민수").getByText("시안 작성 중").waitFor();

    // 다시 답하면 거부된다(멱등이 아닌 다른 답).
    const decided = (await projectState()).decisions.find((d) => d.title.startsWith("랜딩 색"))!;
    expect(decided).toMatchObject({ status: "delivered", choice: "keep", note: "로고는 나중에 보낼게요" });
    const again = await fetch(`${base}/api/decisions/${decided.id}/answer`, { method: "POST", headers: headers(), body: JSON.stringify({ choice: "blue" }) });
    expect(again.status).toBe(409);
  }, STEP_MS);

  test("내 할 일: 체크하면 직원에게 알린다", async () => {
    await goBoth("home");
    const todo = desk.locator(".hm-todo", { hasText: "로고 원본 파일 보내기" });
    await todo.getByRole("checkbox").click();
    await until("할 일 완료", projectState, (s) => s.todos.every((t) => t.done));
    await sessionGot("'로고 원본 파일 보내기' 했음");
  }, STEP_MS);

  test("보고: 대화에 나타나고 자료로 이어진다", async () => {
    await goBoth("thread");
    for (const page of [desk, phone]) {
      const report = page.locator(".th-card", { hasText: "랜딩 시안을 만들었습니다" });
      await report.waitFor();
      await report.getByText("완료", { exact: true }).waitFor();
      await report.locator(".th-link", { hasText: "랜딩 시안 1안" }).waitFor();
      await page.locator(".th-card", { hasText: "민수 보고를 확인했습니다" }).waitFor();
    }
    // 내 말은 받음, 결재 질문은 답한 내용으로 잇는다.
    await desk.locator(".th-link", { hasText: "답함: 보라 유지" }).waitFor();
    await shotBoth("14-thread-report");
  }, STEP_MS);

  test("자료: 목록과 읽기, 스크립트는 지워지고 폰은 목록에서 상세로 간다", async () => {
    const report = desk.locator(".th-card", { hasText: "랜딩 시안을 만들었습니다" });
    await report.locator(".th-link", { hasText: "랜딩 시안 1안" }).click();
    await desk.getByRole("heading", { name: "랜딩 시안 1안", level: 1 }).waitFor();
    await desk.locator(".fl-doc__body table").waitFor();
    expect(await desk.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await desk.locator(".fl-doc__body script").count()).toBe(0);

    await go(phone, "files");
    await phone.locator(".fl-row", { hasText: "랜딩 시안 1안" }).waitFor();
    await shotBoth("15-files-list");
    await phone.locator(".fl-row", { hasText: "랜딩 시안 1안" }).click();
    await phone.locator(".fl-doc__body table").waitFor();
    await phone.locator(".fl-back").waitFor();
    await shotBoth("16-files-reader");
    await phone.locator(".fl-back").click();
    await phone.locator(".fl-row").first().waitFor();
  }, STEP_MS);

  test("직원 상세: 활동을 보고 직접 지시하면 전달 상태가 바뀐다", async () => {
    const minsu = await memberNamed("민수");
    await goBoth("team", minsu.id);
    for (const page of [desk, phone]) {
      await page.locator(".tm-acts .tm-act").first().waitFor();
      await page.locator(".tm-copy__cmd").waitFor();
    }
    await shotBoth("17-member-detail");
    expect(await desk.locator(".tm-copy__cmd").textContent()).toContain(`attach ${minsu.id}`);

    const input = desk.locator(".tm-send__input");
    await input.fill("머리말을 두 줄로 줄여 주세요");
    await input.press("Enter");
    await desk.locator(".tm-send__state", { hasText: "받음" }).waitFor();
    await sessionGot('[대표 직접] \\"머리말을 두 줄로 줄여 주세요\\"');
    await until("다시 대기", () => memberNamed("민수"), (m) => m.status === "idle");
  }, STEP_MS);

  test("잠재우기·다시 열기: 세션이 이어지고 새로고침해도 남는다", async () => {
    const before = await memberNamed("민수");
    await desk.getByRole("button", { name: "잠재우기" }).click();
    await until("잠듦", () => memberNamed("민수"), (m) => m.status === "asleep");
    await desk.getByRole("button", { name: "깨우기" }).waitFor();
    await goBoth("team");

    for (const page of [desk, phone]) {
      const fold = page.locator("details.tm-fold");
      await fold.waitFor();
      await fold.locator("summary").click();
      await fold.getByRole("button", { name: "다시 열기" }).waitFor();
    }
    await shotBoth("18-team-asleep");

    // 새로고침: 코드를 다시 묻지 않고 주소·잠든 상태가 그대로다.
    await desk.reload();
    await desk.locator("details.tm-fold").waitFor();
    expect(await desk.evaluate(() => location.hash)).toContain(`${projectId}/team`);
    await desk.locator("details.tm-fold summary").click();
    await desk.getByRole("button", { name: "다시 열기" }).click();
    const reopened = await until("다시 열림", () => memberNamed("민수"), (m) => m.status !== "asleep");
    expect(reopened.sessionId).toBe(before.sessionId);
    await memberCard(desk, "민수").waitFor();
    await memberCard(phone, "민수").waitFor();

    await goBoth("thread");
    // 메뉴에서 안 고르고 끝까지 쳐도 첫머리 @이름 이면 그 직원에게 간다. 세션은 --resume 으로 이어진다.
    await send(desk, "@민수 다시 열린 뒤 확인");
    await until(
      "이어서 실행",
      () => Promise.resolve(readFileSync(FAKE_LOG, "utf8")),
      (l) => l.split("\n").some((row) => row.includes('[대표 직접] \\"다시 열린 뒤 확인') && row.includes(`"--resume","${before.sessionId}"`)),
    );
    await desk.locator(".th-mine__to", { hasText: "민수에게" }).first().waitFor();
  }, STEP_MS);

  test("새로고침 뒤 유지: 대화·결재·자료·설정이 그대로다", async () => {
    await goBoth("thread");
    await Promise.all([desk.reload(), phone.reload()]);
    for (const page of [desk, phone]) {
      await page.locator(".th-card", { hasText: "랜딩 시안을 만들었습니다" }).waitFor();
      await page.locator(".th-mine", { hasText: "랜딩 시안 만들어 줘" }).waitFor();
    }
    await go(phone, "inbox");
    await phone.locator(".ibx-seg__item", { hasText: "결재된 항목" }).click();
    await phone.locator(".ibx-answered", { hasText: "랜딩 색 방향을 정해 주세요" }).waitFor();
    await shot(phone, "19-inbox-done");
    await desk.evaluate(() => {
      location.hash = "#/settings";
    });
    await phone.evaluate(() => {
      location.hash = "#/settings";
    });
    await desk.getByRole("heading", { name: "설정", exact: true }).waitFor();
    await shotBoth("20-settings");
  }, STEP_MS);

  test("WS 끊김: 띠가 뜨고, 다시 이어지면 끊긴 동안의 변화까지 받는다", async () => {
    const ctx = await browser.newContext({ viewport: PHONE, locale: "ko-KR", hasTouch: true, isMobile: true });
    let block = false;
    const open = new Set<{ close(): Promise<void> }>();
    await ctx.addInitScript((c) => localStorage.setItem("iamceo.accessCode", c), code);
    await ctx.routeWebSocket(/\/ws/, (ws) => {
      if (block) {
        void ws.close();
        return;
      }
      ws.connectToServer();
      open.add(ws);
    });
    const page = await ctx.newPage();
    watchErrors(page, "ws");
    await page.goto(`${base}/#/p/${projectId}/team`);
    await page.locator(".conn[data-state='online']").waitFor();

    block = true;
    await Promise.all([...open].map((ws) => ws.close()));
    await page.locator(".conn[data-state='offline']").waitFor();
    await page.locator(".offline-band").waitFor();
    await page.screenshot({ path: join(SHOTS, "phone-21-offline.png") });
    for (const problem of await auditLayout(page)) layoutProblems.push(`phone/21-offline: ${problem}`);

    const res = await fetch(`${base}/api/projects/${projectId}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ now: "끊긴 동안 바뀐 상황" }) });
    expect(res.ok).toBe(true);
    expect(await page.getByText("끊긴 동안 바뀐 상황").count()).toBe(0);

    block = false;
    await page.getByRole("button", { name: "지금 다시 연결" }).click();
    await page.locator(".conn[data-state='online']").waitFor();
    await page.locator(".offline-band").waitFor({ state: "detached" });
    await page.getByText("끊긴 동안 바뀐 상황").first().waitFor();
    await ctx.close();
  }, STEP_MS);

  test("서버 재시작: 화면이 스스로 다시 잇고 데이터는 남는다", async () => {
    await goBoth("team");
    await desk.locator(".conn[data-state='online']").waitFor();
    server.kill("SIGTERM");
    expect(await server.exited).toBe(0);
    await desk.locator(".offline-band").waitFor();
    await shot(desk, "21-offline");

    await startServerProcess();
    await desk.locator(".conn[data-state='online']").waitFor({ timeout: 25_000 });
    await phone.locator(".conn[data-state='online']").waitFor({ timeout: 25_000 });
    await desk.locator(".offline-band").waitFor({ state: "detached" });
    await memberCard(desk, "민수").waitFor();

    // 재시작 뒤에도 입력이 돈다.
    await goBoth("thread");
    await send(phone, "재시작 뒤 지시");
    await phone.locator(".th-mine", { hasText: "재시작 뒤 지시" }).locator("xpath=..").locator(".th-delivery", { hasText: "받음" }).waitFor();
    await desk.locator(".th-mine", { hasText: "재시작 뒤 지시" }).waitFor();
    await shotBoth("22-after-restart");
  }, STEP_MS);

  test("입력칸: Shift+Enter 줄바꿈, @ 메뉴, 첨부", async () => {
    await goBoth("thread");
    const input = desk.getByRole("textbox", { name: "입력칸" });
    await input.fill("첫 줄");
    await input.press("Shift+Enter");
    await input.pressSequentially("둘째 줄");
    expect(await input.inputValue()).toBe("첫 줄\n둘째 줄");
    await input.fill("");

    await input.pressSequentially("@민");
    await desk.locator(".cmp-menu__item", { hasText: "민수" }).waitFor();
    await shot(desk, "23-mention");
    await input.press("Enter");
    await desk.locator(".cmp-chip--target", { hasText: "@민수" }).waitFor();
    expect(await input.inputValue()).toBe("");

    await phone.getByRole("textbox", { name: "입력칸" }).fill("@");
    await phone.getByRole("textbox", { name: "입력칸" }).press("End");
    await phone.locator(".cmp-menu__item").first().waitFor();
    await shot(phone, "23-mention");
    await phone.getByRole("textbox", { name: "입력칸" }).fill("");

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await desk.locator("input[type=file]").setInputFiles({ name: "시안.png", mimeType: "image/png", buffer: png });
    await desk.locator(".cmp-chip--file[data-state='ready']").waitFor();
    await input.fill("첨부 확인해 주세요");
    await input.press("Enter");
    await desk.locator(".th-mine", { hasText: "첨부 확인해 주세요" }).waitFor();
    await until(
      "첨부 경로 전달",
      () => Promise.resolve(readFileSync(FAKE_LOG, "utf8")),
      (l) => l.includes("[대표 직접]") && /첨부: \S+시안\.png \(image\/png, \d+B\)/.test(l),
    );
    await shotBoth("24-attachment");
  }, STEP_MS);

  test("긴 내용: 긴 주소·코드·표·이름도 폰에서 가로로 넘치지 않는다", async () => {
    const minsu = await memberNamed("민수");
    const { mcpServers } = JSON.parse(readFileSync(join(HOME, "run", `${minsu.id}.mcp.json`), "utf8")) as { mcpServers: { iamceo: { env: { IAMCEO_TOKEN: string } } } };
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${base}/agent/tool`, { method: "POST", headers: { Authorization: `Bearer ${mcpServers.iamceo.env.IAMCEO_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ name, args }) });
      const result = (await res.json()) as { text: string; isError?: boolean };
      expect(result.isError).toBeFalsy();
      return result.text;
    };
    const url = `https://example.com/${"아주/긴/경로/".repeat(12)}${"x".repeat(120)}`;
    const wide = `| ${Array.from({ length: 14 }, (_, i) => `열이름${i}`).join(" | ")} |\n|${"---|".repeat(14)}\n| ${Array.from({ length: 14 }, (_, i) => `값값값값값값${i}`).join(" | ")} |`;
    const body = `${url}\n\n\`\`\`\n${"const 아주긴줄 = ".repeat(20)}\n\`\`\`\n\n${wide}\n\n\`${"인라인코드".repeat(30)}\`\n\n${"띄어쓰기없는긴글자".repeat(30)}`;
    await tool("status", { now: "지금 하는 일을 아주 길게 적습니다 ".repeat(8), next: "y".repeat(200) });
    const fileId = /#(f_\w+)/.exec(await tool("file", { title: `긴 자료 ${"제목".repeat(40)}`, summary: "요약 ".repeat(60), content: body }))![1]!;
    await tool("post", { kind: "막힘", title: `긴 보고 ${"제목".repeat(40)}`, body, file_ids: [fileId] });
    await tool("ask", {
      title: `긴 결재 ${"제목".repeat(40)}`,
      detail: body,
      options: Array.from({ length: 5 }, (_, i) => ({ k: `o${i}`, label: `선택지 ${i} ${"길게".repeat(25)}`, desc: "설명 ".repeat(40) })),
      rec: "o1",
      group: `긴 묶음 ${"이름".repeat(30)}`,
    });
    await tool("ask", { title: "같은 묶음 둘째", detail: url, options: [{ k: "a", label: "예" }], rec: "a", group: `긴 묶음 ${"이름".repeat(30)}` });
    await tool("todo", { title: `긴 할 일 ${"제목".repeat(40)}`, detail: url });
    const patched = await fetch(`${base}/api/projects/${projectId}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ name: `아주 긴 프로젝트 이름 ${"이름".repeat(30)}`, now: "상황 ".repeat(80) }) });
    expect(patched.ok).toBe(true);

    await goBoth("inbox");
    await phone.locator(".ibx-group").waitFor();
    await shotBoth("25-long-inbox");
    await goBoth("thread");
    await phone.locator(".th-card", { hasText: "긴 보고" }).last().waitFor();
    await shotBoth("26-long-thread");
    await goBoth("team");
    await phone.locator(".tm-card").first().waitFor();
    await shotBoth("27-long-team");
    await goBoth("files", fileId);
    await phone.locator(".fl-doc__body table").waitFor();
    await shotBoth("28-long-file");
    // 넓은 표는 찌그러지지 않고 표 안에서 가로로 스크롤한다.
    expect(await phone.locator(".fl-doc__body table").evaluate((t) => t.scrollWidth > t.clientWidth)).toBe(true);
    expect(await phone.locator(".fl-doc__body th").first().evaluate((c) => c.scrollHeight <= 2 * Number.parseFloat(getComputedStyle(c).fontSize) + 16)).toBe(true);
    await goBoth("team", minsu.id);
    await phone.locator(".tm-acts").waitFor();
    await shotBoth("29-long-member");
    for (const page of [desk, phone]) {
      for (const problem of await auditLayout(page)) layoutProblems.push(`long-member: ${problem}`);
    }
    await goBoth("files");

    // 묶음 추천대로: 확인 버튼을 눌러야 나가고, 묶음 표시로 전달된다.
    await go(desk, "inbox");
    await desk.getByRole("button", { name: "이 묶음 추천대로" }).click();
    await desk.waitForTimeout(700); // 더블클릭은 확인으로 치지 않는다
    await desk.getByRole("button", { name: "묶음 2건 결정" }).click();
    const answered = await until("묶음 답", projectState, (s) => s.decisions.every((d) => d.status !== "open"));
    expect(answered.decisions.filter((d) => d.batch).map((d) => d.choice).sort()).toEqual(["a", "o1"]);
    await sessionGot("(묶음 추천대로)");

    // 데스크톱과 폰 사이 폭에서도 넘치지 않는다.
    for (const width of [1024, 800, 600]) {
      await desk.setViewportSize({ width, height: 800 });
      for (const tab of ["home", "inbox", "team", "thread", "files"]) {
        await go(desk, tab);
        await desk.waitForTimeout(150);
        for (const problem of await auditLayout(desk)) layoutProblems.push(`폭 ${width}/${tab}: ${problem}`);
      }
    }
    await desk.setViewportSize(DESK);
  }, 90_000);

  test("본사: 말을 걸면 본사 AI가 뜬다", async () => {
    for (const page of [desk, phone]) {
      await page.evaluate(() => {
        location.hash = "#/p/hq/thread";
      });
    }
    await desk.getByText("아직 대화가 없습니다").waitFor();
    await desk.locator(".cmp-chip--target", { hasText: "본사 AI" }).waitFor();
    await send(desk, "본사에게 하는 첫 말");
    await sessionGot('[대표] \\"본사에게 하는 첫 말\\"');
    for (const page of [desk, phone]) await page.locator(".th-card", { hasText: "가짜 응답" }).waitFor();
    await shotBoth("30-hq-thread");
    const hq = await apiGet<ProjectState>("/api/projects/hq/state");
    expect(hq.members.find((m) => m.kind === "root")).toBeTruthy();
    for (const page of [desk, phone]) {
      await page.evaluate(() => {
        location.hash = "#/p/hq/files";
      });
    }
    await desk.getByText("아직 올린 자료가 없습니다").waitFor();
    await phone.getByText("아직 올린 자료가 없습니다").waitFor();
    await shotBoth("31-hq-files");
  }, STEP_MS);

  test("전체 점검: 브라우저 오류와 배치 문제가 없다", () => {
    expect(browserErrors).toEqual([]);
    expect(layoutProblems).toEqual([]);
  });
});

describe("컴파일 실행 파일", () => {
  const BIN = join(WORK, "dist", "iamceo");
  const home = join(WORK, "bin-home");
  let proc: ReturnType<typeof Bun.spawn>;
  let url = "";
  let binCode = "";

  beforeAll(async () => {
    const build = Bun.spawnSync(["bun", "build", join(ROOT, "bin", "iamceo.ts"), "--compile", "--outfile", BIN], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`컴파일 실패: ${build.stderr.toString()}`);
    expect(existsSync(BIN)).toBe(true);
    updateConfigFile({ hosts: ["127.0.0.1"], accessCode: "bin-code" }, { IAMCEO_HOME: home });
    binCode = "bin-code";
    const listen = await freePort();
    url = `http://127.0.0.1:${listen}`;
    // 저장소 밖 폴더에서 띄워 소스 파일에 기대지 않는지 본다.
    proc = Bun.spawn([BIN, "serve"], {
      cwd: WORK,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: childEnv({ IAMCEO_HOME: home, IAMCEO_PORT: String(listen), IAMCEO_CLAUDE_BIN: FAKE, IAMCEO_HERDR_SOCKET: join(home, "no-herdr.sock"), FAKE_CLAUDE_LOG: join(WORK, "fake-bin.log"), FAKE_CLAUDE_SCRIPT: join(WORK, "script.json") }),
    });
    await waitHealthy(url, proc);
  }, 120_000);

  afterAll(async () => {
    proc?.kill("SIGTERM");
    await proc?.exited;
  });

  const binHeaders = () => ({ Authorization: `Bearer ${binCode}`, "Content-Type": "application/json" });
  const binPost = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(`${url}${path}`, { method: "POST", headers: binHeaders(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  test("웹 화면이 임베드되어 뜨고 CSS·스크립트가 적용된다", async () => {
    await fetch(`${url}/api/settings`, { method: "PUT", headers: binHeaders(), body: JSON.stringify({ backend: "core" }) });
    const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, locale: "ko-KR" });
    const page = await ctx.newPage();
    const errors: string[] = [];
    const failed: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(url);
    await page.getByPlaceholder("접속 코드").fill(binCode);
    await page.getByRole("button", { name: "들어가기" }).click();
    await page.getByRole("textbox", { name: "입력칸" }).waitFor();
    await page.locator(".conn[data-state='online']").waitFor();
    // 스타일이 빠지면 본문 스크롤 요소가 고정 높이를 갖지 못한다.
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("");
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".shell__body")!).overflowY)).toBe("auto");
    await page.screenshot({ path: join(SHOTS, "compiled-phone-hq.png") });
    const manifestHref = await page.locator("link[rel=manifest]").getAttribute("href");
    const iconHref = await page.locator("link[rel=apple-touch-icon]").getAttribute("href");
    await ctx.close();
    expect(errors).toEqual([]);
    expect(failed).toEqual([]);
    const manifest = await fetch(`${url}${manifestHref}`);
    expect(manifest.headers.get("content-type")).toContain("application/json");
    expect(((await manifest.json()) as { name: string }).name).toBe("IAMCEO");
    expect((await fetch(`${url}${iconHref}`)).headers.get("content-type")).toBe("image/png");
  }, 60_000);

  test("아티팩트 키트가 번들에 들어 있다: 빈 칸·칸 안 문서·키트 스타일이 소스 없이 돈다", async () => {
    const frameRes = await fetch(`${url}/artifact-frame`);
    expect(frameRes.status).toBe(200);
    expect(frameRes.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    const project = await binPost<{ id: string }>("/api/projects", { name: "아티팩트 확인", cwd: WORK });
    const joined = await binPost<{ token: string }>("/agent/join", { project: project.id, name: "아티팩트 직원", role: "확인" });
    const upload = await fetch(`${url}/agent/tool`, {
      method: "POST",
      headers: { Authorization: `Bearer ${joined.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "file", args: { title: "키트 확인", html: readFileSync(join(ROOT, "tests", "fixtures", "sample-artifact.html"), "utf8") } }),
    });
    expect(upload.status).toBe(200);
    const state = (await (await fetch(`${url}/api/projects/${project.id}/state`, { headers: binHeaders() })).json()) as ProjectState;
    const file = state.files.find((f) => f.title === "키트 확인")!;
    expect(file.kind).toBe("artifact");
    const ctx = await browser.newContext({ viewport: DESK, locale: "ko-KR" });
    const page = await ctx.newPage();
    await page.addInitScript((code) => {
      if (window.top === window) localStorage.setItem("iamceo.accessCode", code);
    }, binCode);
    await page.goto(`${url}/#/p/${project.id}/files/${file.id}`);
    await page.getByRole("button", { name: "실행", exact: true }).click();
    const frame = page.frameLocator("iframe.afr-frame");
    await frame.locator("h1").waitFor();
    // 키트 없이는 .kpi 가 카드 모양이 되지 않는다. 인라인 스크립트도 돈다(탭 전환).
    expect(await frame.locator(".kpi").first().evaluate((el) => getComputedStyle(el).display)).toBe("flex");
    await frame.locator("#tabs button").nth(1).click();
    await frame.locator("#panel-b").waitFor();
    await ctx.close();
  }, 45_000);

  test("mcp 명령이 MCP 브리지로 돌아 도구 목록·호출을 중계한다", async () => {
    const project = await binPost<{ id: string }>("/api/projects", { name: "브리지 확인", cwd: WORK });
    const joined = await binPost<{ token: string; member: Member }>("/agent/join", { project: project.id, name: "브리지 직원", role: "확인" });
    const transport = new StdioClientTransport({ command: BIN, args: ["mcp"], env: childEnv({ IAMCEO_URL: url, IAMCEO_TOKEN: joined.token }), cwd: WORK });
    const client = new Client({ name: "e2e", version: "1" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["status", "ask", "post", "file", "todo", "wait"]));
    const result = await client.callTool({ name: "status", arguments: { now: "브리지로 적음" } });
    expect(result.isError).toBeFalsy();
    await client.close();
    const state = (await (await fetch(`${url}/api/projects/${project.id}/state`, { headers: binHeaders() })).json()) as ProjectState;
    expect(state.members.find((m) => m.id === joined.member.id)?.now).toBe("브리지로 적음");
  }, 45_000);

  test("컴파일 서버가 실행 설정을 자기 mcp 명령으로 쓴다(세션이 소스 없이 브리지를 띄운다)", async () => {
    const project = await binPost<{ id: string }>("/api/projects", { name: "기동 확인", cwd: WORK, startConductor: true });
    const state = await until(
      "총괄 기동",
      async () => (await (await fetch(`${url}/api/projects/${project.id}/state`, { headers: binHeaders() })).json()) as ProjectState,
      (s) => s.members.some((m) => m.kind === "conductor"),
    );
    const conductor = state.members.find((m) => m.kind === "conductor")!;
    const config = JSON.parse(readFileSync(join(home, "run", `${conductor.id}.mcp.json`), "utf8")) as { mcpServers: { iamceo: { command: string; args: string[]; env: Record<string, string> } } };
    const { command, args, env } = config.mcpServers.iamceo;
    expect(command).toBe(realpathSync(BIN));
    expect(args).toEqual(["mcp"]);

    const client = new Client({ name: "e2e", version: "1" });
    await client.connect(new StdioClientTransport({ command, args, env: childEnv(env), cwd: WORK }));
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["team_add", "roster", "work_set"]));
  }, 30_000);
});
