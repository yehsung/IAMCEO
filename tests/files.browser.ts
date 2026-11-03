// 자료 화면: 종류별 보기를 실제 서버(가짜 claude)와 브라우저로 본다. 악성 아티팩트는 진짜 화면 안에서 격리를 뚫지 못해야 한다.
// IAMCEO_SHOTS=<폴더> 를 주면 캡처를 남긴다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from "playwright";
import type { FileDoc, Member, Project, ProjectState } from "../shared/types.ts";
import { updateConfigFile } from "../server/config.ts";
import { cellNumber, isNumericColumn, parseDelimited, sniffDelimiter, sortRows } from "../web/src/components/viewers/delimited.ts";
import { decodeText } from "../web/src/components/viewers/source.ts";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "bin", "iamceo.ts");
const FAKE = join(ROOT, "tests", "fixtures", "fake-claude.ts");
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "iamceo-files-")));
const HOME = join(WORK, "home");
const DIR = join(WORK, "project");
mkdirSync(HOME);
mkdirSync(DIR);
const CODE = "files-secret-code";
const SHOTS = process.env.IAMCEO_SHOTS ?? null;

const STRIP = /^(HERDR_.*|CLAUDECODE|CLAUDE_CODE_.*)$/;
function env(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP.test(k)) out[k] = v;
  return { ...out, IAMCEO_HOME: HOME, IAMCEO_TEST: "1", IAMCEO_CLAUDE_BIN: FAKE, IAMCEO_HERDR_SOCKET: join(WORK, "none.sock"), FAKE_CLAUDE_LOG: join(WORK, "fake.jsonl"), FAKE_CLAUDE_SESSIONS: join(WORK, "sessions"), ...extra };
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port!;
  s.stop(true);
  return port;
}

let server: ReturnType<typeof Bun.spawn>;
let base = "";
let chrome: Browser;
let desk: BrowserContext;
let phone: BrowserContext;
let project: Project;
let token = "";
const files = new Map<string, FileDoc>();

const api = async <T,>(method: string, path: string, body?: unknown, auth = CODE): Promise<T> => {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

/** 직원이 file 도구로 올린다. 올린 자료를 돌려준다. */
async function upload(args: Record<string, unknown>): Promise<FileDoc> {
  const r = await api<{ text: string }>("POST", "/agent/tool", { name: "file", args }, token);
  const id = /#(f_[A-Za-z0-9_-]+)/.exec(r.text)![1]!;
  const state = await api<ProjectState>("GET", `/api/projects/${project.id}/state`);
  const file = state.files.find((f) => f.id === id)!;
  files.set(String(args.title), file);
  return file;
}

function write(name: string, data: string | Uint8Array): string {
  const path = join(DIR, name);
  writeFileSync(path, data);
  return path;
}

async function open(ctx: BrowserContext, hash: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
  await page.goto(`${base}/${hash}`);
  return page;
}

const fileHash = (id?: string) => `#/p/${project.id}/files${id ? `/${id}` : ""}`;
const runIt = (page: Page) => page.getByRole("button", { name: "실행", exact: true }).click();
/** 칸은 실행을 눌러야 생긴다. */
const openRun = async (ctx: BrowserContext, hash: string): Promise<Page> => {
  const page = await open(ctx, hash);
  await runIt(page);
  return page;
};

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** 소리 없는 짧은 wav */
function wav(): Uint8Array {
  const samples = 8000;
  const b = Buffer.alloc(44 + samples);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples, 40);
  b.fill(128, 44);
  return b;
}

/** 한 쪽짜리 진짜 PDF */
function pdf(): string {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 18 Tf 40 100 Td (Sample PDF) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const at: number[] = [];
  objs.forEach((o, i) => {
    at.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return out;
}

/** 단색 svg. 갤러리 시험용. */
const svg = (color: string, w = 800, h = 500) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/><circle cx="${w / 2}" cy="${h / 2}" r="${h / 4}" fill="#fff" fill-opacity=".35"/></svg>`;

beforeAll(async () => {
  const port = freePort();
  updateConfigFile({ accessCode: CODE, port, hosts: ["127.0.0.1"] }, { IAMCEO_HOME: HOME });
  server = Bun.spawn([process.execPath, CLI, "serve"], { cwd: ROOT, env: env({ IAMCEO_PORT: String(port) }), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 15000;
  while (!(await fetch(`${base}/api/health`).then((r) => r.ok, () => false))) {
    if (Date.now() > end) throw new Error("서버가 뜨지 않음");
    await Bun.sleep(80);
  }
  await api("PUT", "/api/settings", { backend: "headless" });
  project = await api<Project>("POST", "/api/projects", { name: "자료 시험", cwd: DIR });
  const joined = await api<{ member: Member; token: string }>("POST", "/agent/join", { project: project.id, name: "자료담당", handle: "writer", cwd: DIR });
  token = joined.token;

  const large = ["번호,이름,금액"];
  for (let i = 1; i <= 30000; i++) large.push(`${i},항목 ${i} 설명을 조금 길게 적어 파일을 키운다,${i * 7}`);

  await upload({ title: "회의록", summary: "결제 방식 논의 정리", content: "# 회의록\n\n- 대행사로 시작한다\n- **다음 주**까지 계약\n\n| 항목 | 값 |\n|---|---|\n| 수수료 | 2.9% |\n" });
  await upload({ title: "결제 방식 비교", summary: "세 가지 방식을 비용·일정으로 비교", html: readFileSync(join(ROOT, "tests/fixtures/sample-artifact.html"), "utf8") });
  await upload({ title: "시안 모음", summary: "랜딩 시안 세 장", images: [write("a.svg", svg("#5B3DF2")), write("b.svg", svg("#B35CFF")), write("c.svg", svg("#2D8CFF"))] });
  await upload({ title: "시안 한 장", images: [write("one.svg", svg("#2FA37A", 1000, 700))] });
  await upload({ title: "월별 매출", summary: "지난 6개월", path: write("sales.csv", '월,매출,비고\n2026-05,"1,200",평범\n2026-06,900,"쉼표, 있는 칸"\n2026-07,3400,\n2026-08,150,"여러 줄\n칸"\n2026-09,2200,끝\n') });
  await upload({ title: "넓은 표", path: write("wide.tsv", `${Array.from({ length: 24 }, (_, i) => `열이름${i + 1}`).join("\t")}\n${Array.from({ length: 24 }, (_, i) => `값${i}`).join("\t")}\n`) });
  await upload({ title: "큰 표", summary: "3만 줄", path: write("large.csv", large.join("\n")) });
  await upload({ title: "엑셀 표", path: write("excel.csv", new Uint8Array([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xb1, 0xdd, 0xbe, 0xd7, 0x0a, 0xc3, 0xb6, 0xbc, 0xf6, 0x2c, 0x31, 0x30, 0x0a])) });
  await upload({ title: "설정 파일", summary: "json", path: write("config.json", '{"name":"iamceo","limits":{"turns":4,"longtext":"아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 아주 긴 값 "},"on":true}') });
  await upload({ title: "실행 기록", path: write("run.log", Array.from({ length: 40 }, (_, i) => `2026-11-02 10:${String(i).padStart(2, "0")} 작업 ${i} 끝`).join("\n")) });
  await upload({ title: "계약서 PDF", summary: "서명본", path: write("contract.pdf", pdf()) });
  await upload({ title: "녹음", path: write("note.wav", wav()) });
  await upload({ title: "재생 안 되는 영상", path: write("clip.mov", "not a real video") });
  await upload({ title: "압축 파일", summary: "소스 전체", path: write("source.zip", "PK fake zip content") });

  chrome = await chromium.launch();
  desk = await chrome.newContext({ viewport: { width: 1440, height: 900 } });
  phone = await chrome.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  desk.setDefaultTimeout(10_000);
  phone.setDefaultTimeout(10_000);
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.kill("SIGTERM");
  await server?.exited;
});

const id = (title: string) => files.get(title)!.id;

/** 누를 자리·가로 넘침·글 대비 */
async function audit(page: Page, label: string): Promise<void> {
  const issues = await page.evaluate(() => {
    const out: string[] = [];
    const root = document.querySelector<HTMLElement>("[data-scroll-root]")!;
    if (document.documentElement.scrollWidth > innerWidth) out.push(`문서 가로 넘침 ${document.documentElement.scrollWidth}`);
    if (root.scrollWidth > root.clientWidth) out.push(`본문 가로 넘침 ${root.scrollWidth}>${root.clientWidth}`);
    const scope = document.querySelector("dialog[open]") ?? root;
    for (const el of scope.querySelectorAll<HTMLElement>(".fl-chip, .fl-row, .vw-btn, .vw-gallery__item, .vw-table th button, .fl-path__copy, .fl-back")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.height < 44 || r.width < 44) out.push(`작은 자리 ${el.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    const lum = (rgb: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
    };
    const parse = (c: string) => {
      const m = c.match(/[\d.]+/g)!.map(Number);
      return { rgb: m.slice(0, 3), a: m[3] ?? 1 };
    };
    for (const el of scope.querySelectorAll<HTMLElement>(".fl-chip, .fl-kind, .fl-row__summary, .fl-row__meta, .vw-bar__text, .vw-btn, .vw-note, .vw-code li, .vw-table td, .vw-table th button, .vw-card__meta, .afr-bar__title")) {
      const style = getComputedStyle(el);
      if (!el.getBoundingClientRect().width) continue;
      const fg = parse(style.color);
      // 뒤판을 위로 쌓는다. 맨 아래는 가장 밝은 경우를 가정한 어두운 바탕이다.
      let bg = [18, 14, 40];
      const layers: { rgb: number[]; a: number }[] = [];
      for (let n: HTMLElement | null = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c.a > 0) layers.push(c);
        if (c.a === 1) break;
      }
      for (const l of layers.reverse()) bg = bg.map((v, i) => v * (1 - l.a) + l.rgb[i]! * l.a);
      const [a, b] = [lum(fg.rgb), lum(bg)];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 4.5) out.push(`대비 ${ratio.toFixed(2)} ${el.className || el.tagName} "${el.textContent?.slice(0, 16)}"`);
    }
    return out;
  });
  expect({ label, issues: [...new Set(issues)] }).toEqual({ label, issues: [] });
}

describe("표·코드 해석", () => {
  test("따옴표·여러 줄·빈 줄·잘린 끝", () => {
    expect(parseDelimited('a,b\n"1,2","x\ny"\n\n3,\n')).toEqual({ header: ["a", "b"], rows: [["1,2", "x\ny"], ["3", ""]] });
    expect(parseDelimited('﻿a,b\r\n1,2\r\n').header).toEqual(["a", "b"]);
    expect(parseDelimited('a,b\n1,"그 ""말"""').rows).toEqual([["1", '그 "말"']]);
    expect(parseDelimited("a,b\n1,2\n3,끊", ",", true).rows).toEqual([["1", "2"]]);
    expect(parseDelimited("a\n1,2,3").header).toEqual(["a", "", ""]);
    expect(sniffDelimiter("a\tb\tc,d\n")).toBe("\t");
    expect(sniffDelimiter("a;b;c\n")).toBe(";");
    expect(sniffDelimiter('"a,b,c";d\n')).toBe(";");
  });
  test("수 판단과 정렬", () => {
    expect(cellNumber("1,234")).toBe(1234);
    expect(cellNumber("-3.5")).toBe(-3.5);
    expect(cellNumber("12%")).toBe(12);
    expect(cellNumber("010-1234")).toBeNull();
    expect(cellNumber("01012345678")).toBeNull();
    expect(cellNumber("")).toBeNull();
    const rows = [["10"], ["9"], [""], ["1,000"]];
    expect(isNumericColumn(rows, 0)).toBe(true);
    expect(sortRows(rows, 0, "asc").map((r) => r[0])).toEqual(["9", "10", "1,000", ""]);
    expect(sortRows(rows, 0, "desc").map((r) => r[0])).toEqual(["1,000", "10", "9", ""]);
    expect(sortRows([["나"], ["가"], ["다"]], 0, "asc").map((r) => r[0])).toEqual(["가", "나", "다"]);
  });
  test("EUC-KR·UTF-16 을 읽고 잘린 UTF-8 끝 글자에 넘어지지 않는다", () => {
    expect(decodeText(new Uint8Array([0xc0, 0xcc, 0xb8, 0xa7]))).toBe("이름");
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x74, 0xc7]))).toBe("이");
    expect(decodeText(new Uint8Array([0xea, 0xb0, 0x80, 0xeb, 0x82]))).toBe("가");
  });
});

describe("목록", () => {
  test("데스크톱: 칩으로 거르고 종류·요약·작성자가 보인다", async () => {
    const page = await open(desk, fileHash());
    await page.locator(".fl-chips").waitFor();
    await page.locator(".fl-doc").first().waitFor();
    const row = page.locator(".fl-row", { hasText: "결제 방식 비교" });
    await expect(row.locator(".fl-kind").innerText()).resolves.toBe("아티팩트");
    await expect(row.locator(".fl-row__summary").innerText()).resolves.toContain("비용·일정");
    await expect(row.locator(".fl-row__meta").innerText()).resolves.toContain("자료담당");
    expect(await page.locator(".fl-row", { hasText: "시안 모음" }).locator("img.fl-row__thumb").count()).toBe(1);
    const all = await page.locator(".fl-row").count();
    expect(all).toBe(files.size);
    await shot(page, "desk-list");
    await page.locator(".fl-chip", { hasText: "표" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".fl-row").length === 4);
    expect(await page.locator(".fl-row .fl-kind").allInnerTexts()).toEqual(["표", "표", "표", "표"]);
    // 거르면 고른 자료도 그 안의 첫 항목이다
    await page.locator(".vw-table").waitFor();
    await page.locator(".fl-chip", { hasText: "전체" }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".fl-row").length === n, all);
    await audit(page, "데스크톱 목록");
    await page.close();
  });

  test("폰: 목록 → 상세 → 뒤로, 칩이 유지된다", async () => {
    const page = await open(phone, fileHash());
    await page.locator(".fl-row").first().waitFor();
    await audit(page, "폰 목록");
    await shot(page, "phone-list");
    await page.locator(".fl-chip", { hasText: "코드" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".fl-row").length === 2);
    await page.locator(".fl-row", { hasText: "설정 파일" }).click();
    await page.locator(".vw-code").waitFor();
    await page.locator(".fl-back").click();
    await page.waitForFunction(() => document.querySelectorAll(".fl-row").length === 2);
    await page.close();
  });

  test("결재·대화에서 오는 링크: 거르는 중이어도 그 자료를 연다", async () => {
    const page = await open(desk, fileHash(id("압축 파일")));
    await page.locator(".vw-card").waitFor();
    await page.locator(".fl-chip", { hasText: "표" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".fl-row").length === 4);
    expect(await page.locator(".vw-card__name").innerText()).toBe("source.zip");
    await page.close();
  });
});

describe("종류별 보기", () => {
  test("문서: 마크다운", async () => {
    const page = await open(desk, fileHash(id("회의록")));
    await page.locator(".fl-doc__body table").waitFor();
    expect(await page.locator(".fl-doc__body h1").innerText()).toBe("회의록");
    await shot(page, "desk-document");
    await page.close();
  });

  test("표: 정렬·수 정렬·여러 줄 칸·가로 스크롤", async () => {
    const page = await open(desk, fileHash(id("월별 매출")));
    await page.locator(".vw-table table").waitFor();
    expect(await page.locator(".vw-bar__text").first().innerText()).toContain("5행");
    const col = () => page.locator(".vw-table tbody tr td:nth-child(2)").allInnerTexts();
    expect(await col()).toEqual(["1,200", "900", "3400", "150", "2200"]);
    const head = page.locator(".vw-table th", { hasText: "매출" });
    await head.locator("button").click();
    expect(await col()).toEqual(["150", "900", "1,200", "2200", "3400"]);
    expect(await head.getAttribute("aria-sort")).toBe("ascending");
    await head.locator("button").click();
    expect(await col()).toEqual(["3400", "2200", "1,200", "900", "150"]);
    await head.locator("button").click();
    expect(await col()).toEqual(["1,200", "900", "3400", "150", "2200"]);
    expect(await head.getAttribute("aria-sort")).toBe("none");
    expect(await page.locator(".vw-table tbody td", { hasText: "쉼표, 있는 칸" }).count()).toBe(1);
    await audit(page, "표");
    await shot(page, "desk-table");
    await page.close();

    const small = await open(phone, fileHash(id("넓은 표")));
    await small.locator(".vw-table table").waitFor();
    const box = small.locator(".vw-table__scroll");
    expect(await box.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    await audit(small, "폰 넓은 표");
    await shot(small, "phone-table");
    await small.close();
  });

  test("큰 표: 앞부분만 받아 그리고 전체 받기를 준다", async () => {
    const page = await open(desk, fileHash(id("큰 표")));
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.locator(".vw-table table").waitFor();
    expect(await page.locator(".vw-table tbody tr").count()).toBe(500);
    const text = await page.locator(".vw-bar__text").first().innerText();
    expect(text).toContain("앞 500행만 표시");
    const dl = page.locator(".vw-table a.vw-btn");
    expect(await dl.innerText()).toContain("전체 받기");
    expect(await dl.getAttribute("download")).toBe("large.csv");
    const download = page.waitForEvent("download");
    await dl.click();
    expect((await download).suggestedFilename()).toBe("large.csv");
    await page.close();
  });

  test("1MB 넘는 표: body 가 없어도 첨부 앞부분을 헤더 인증으로 받는다", async () => {
    const big = ["번호,내용"];
    for (let i = 1; i <= 40000; i++) big.push(`${i},${"가나다라마바사".repeat(6)}`);
    const f = await upload({ title: "아주 큰 표", path: write("huge.csv", big.join("\n")) });
    expect(f.kind).toBe("table");
    expect(f.body).toBe("");
    const page = await desk.newPage();
    await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    const seen: { url: string; auth: string | undefined }[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/files/") && r.url().includes("huge.csv")) seen.push({ url: r.url(), auth: r.headers().authorization });
    });
    await page.goto(`${base}/${fileHash(f.id)}`);
    await page.locator(".vw-table table").waitFor();
    const text = await page.locator(".vw-bar__text").first().innerText();
    expect(text).toContain("앞부분");
    expect(await page.locator(".vw-table a.vw-btn").innerText()).toContain("전체 받기");
    expect(seen[0]!.url).not.toContain("t=");
    expect(seen[0]!.auth).toBe(`Bearer ${CODE}`);
    await page.close();
  });

  test("표: 엑셀이 쓴 EUC-KR 도 읽는다", async () => {
    const page = await open(desk, fileHash(id("엑셀 표")));
    await page.locator(".vw-table th", { hasText: "이름" }).waitFor();
    expect(await page.locator(".vw-table tbody td").first().innerText()).toBe("철수");
    await page.close();
  });

  test("코드: json 들여쓰기·줄 번호·줄바꿈·복사", async () => {
    const page = await desk.newPage();
    await desk.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    await page.goto(`${base}/${fileHash(id("설정 파일"))}`);
    await page.locator(".vw-code ol").waitFor();
    const lines = await page.locator(".vw-code li").allInnerTexts();
    expect(lines[1]).toBe('  "name": "iamceo",');
    expect(await page.locator(".vw-code li").first().evaluate((e) => getComputedStyle(e, "::before").content)).toBe("counter(ln)");
    const scroll = page.locator(".vw-code__scroll");
    expect(await scroll.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    await shot(page, "desk-code");
    await page.getByRole("button", { name: "줄바꿈" }).click();
    expect(await scroll.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
    await page.getByRole("button", { name: "복사", exact: true }).click();
    await page.getByRole("button", { name: "복사됨" }).waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"turns": 4');
    await audit(page, "코드");
    await page.close();

    const small = await open(phone, fileHash(id("실행 기록")));
    await small.locator(".vw-code ol").waitFor();
    expect(await small.getByRole("button", { name: "줄바꿈" }).getAttribute("aria-pressed")).toBe("true");
    await audit(small, "폰 코드");
    await shot(small, "phone-code");
    await small.close();
  });

  test("이미지: 갤러리에서 확대하고 앞뒤로 넘긴다", async () => {
    const page = await open(desk, fileHash(id("시안 모음")));
    await page.locator(".vw-gallery__item").first().waitFor();
    expect(await page.locator(".vw-gallery__item").count()).toBe(3);
    await audit(page, "갤러리");
    await shot(page, "desk-gallery");
    await page.locator(".vw-gallery__item").nth(1).click();
    const dlg = page.locator("dialog[open]");
    await dlg.getByText("2 / 3").waitFor();
    expect(await dlg.locator(".dialog__title").innerText()).toBe("b.svg");
    await dlg.getByRole("button", { name: "다음" }).click();
    expect(await dlg.locator(".dialog__title").innerText()).toBe("c.svg");
    await page.keyboard.press("ArrowRight");
    await dlg.getByText("1 / 3").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("dialog[open]").waitFor({ state: "detached" });
    await page.close();

    const one = await open(phone, fileHash(id("시안 한 장")));
    await one.locator(".vw-gallery[data-single] img").waitFor();
    await audit(one, "폰 이미지");
    await one.locator(".vw-gallery__item").click();
    expect(await one.locator("dialog[open] .atv-nav").count()).toBe(0);
    await one.close();
  });

  test("PDF: 헤더로 받아 blob 칸에 그린다(주소에 접속 코드 없음, CSP 위반 없음)", async () => {
    const page = await desk.newPage();
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|Refused/i.test(m.text())) violations.push(m.text());
    });
    await page.addInitScript((code) => {
      localStorage.setItem("iamceo.accessCode", code);
      Object.defineProperty(navigator, "pdfViewerEnabled", { get: () => true }); // 헤드리스 셸에는 보기 기능이 없다
    }, CODE);
    await page.goto(`${base}/${fileHash(id("계약서 PDF"))}`);
    const frame = page.locator("iframe.vw-pdf__frame");
    await frame.waitFor();
    expect(await frame.getAttribute("src")).toMatch(/^blob:/);
    await page.waitForTimeout(400);
    expect(violations).toEqual([]);
    await shot(page, "desk-pdf");
    await page.close();
  });

  test("PDF: 칸에 못 그리는 폰은 새 창 버튼", async () => {
    const page = await open(phone, fileHash(id("계약서 PDF")));
    await page.getByRole("link", { name: "새 창에서 열기" }).waitFor();
    expect(await page.locator("iframe.vw-pdf__frame").count()).toBe(0);
    expect(await page.getByRole("link", { name: "새 창에서 열기" }).getAttribute("href")).toMatch(/^blob:/);
    await audit(page, "폰 PDF");
    await shot(page, "phone-pdf");
    await page.close();
  });

  test("오디오는 재생되고, 못 트는 영상은 받기를 안내한다", async () => {
    const page = await open(desk, fileHash(id("녹음")));
    const audio = page.locator("audio");
    await audio.waitFor({ state: "attached" });
    await page.waitForFunction(() => (document.querySelector("audio") as HTMLAudioElement).duration > 0);
    await page.close();

    const bad = await open(desk, fileHash(id("재생 안 되는 영상")));
    await bad.getByText("재생할 수 없는 형식").waitFor();
    expect(await bad.locator(".vw-media a.vw-btn").getAttribute("download")).toBe("clip.mov");
    await bad.close();
  });

  test("영상: 진짜 webm 이 플레이어에서 재생된다", async () => {
    const maker = await open(desk, "#/");
    const b64 = await maker.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const g = canvas.getContext("2d")!;
      const rec = new MediaRecorder(canvas.captureStream(15), { mimeType: "video/webm" });
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => parts.push(e.data);
      const done = new Promise((r) => (rec.onstop = r));
      rec.start();
      for (let i = 0; i < 12; i++) {
        g.fillStyle = `hsl(${i * 30} 70% 50%)`;
        g.fillRect(0, 0, 320, 180);
        await new Promise((r) => setTimeout(r, 60));
      }
      rec.stop();
      await done;
      const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
      return btoa(String.fromCharCode(...bytes));
    });
    await maker.close();
    const f = await upload({ title: "시연 영상", path: write("demo.webm", Buffer.from(b64, "base64")) });
    expect(f.kind).toBe("video");
    const page = await open(desk, fileHash(f.id));
    await page.locator("video").waitFor();
    await page.waitForFunction(() => {
      const v = document.querySelector("video")!;
      return v.readyState >= 1 && v.videoWidth === 320;
    });
    await page.evaluate(async () => {
      const v = document.querySelector("video")!;
      v.muted = true;
      await v.play();
    });
    await page.waitForFunction(() => document.querySelector("video")!.currentTime > 0);
    await shot(page, "desk-video");
    await page.close();
  });

  test("PDF: 보기 기능이 있는 크롬에서 실제로 뜬다", async () => {
    let full: Browser;
    try {
      full = await chromium.launch({ channel: "chromium" });
    } catch {
      console.log("전체 크로미움이 없어 건너뜀");
      return;
    }
    const ctx = await full.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("console", (m) => {
      if (/Content Security Policy|Refused/i.test(m.text())) errors.push(m.text());
    });
    await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    await page.goto(`${base}/${fileHash(id("계약서 PDF"))}`);
    await page.locator(".vw-pdf").waitFor();
    expect(await page.evaluate(() => navigator.pdfViewerEnabled)).toBe(true);
    await page.locator("iframe.vw-pdf__frame").waitFor();
    await page.waitForTimeout(800);
    expect(errors).toEqual([]);
    await shot(page, "desk-pdf-real");
    await full.close();
  }, 30_000);

  test("첨부는 Range 요청에 부분 응답한다(사파리 영상 재생 조건)", async () => {
    const att = files.get("녹음")!.attachments[0]!;
    const res = await fetch(`${base}${att.url}`, { headers: { Authorization: `Bearer ${CODE}`, Range: "bytes=0-1" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-1\//);
    expect((await res.arrayBuffer()).byteLength).toBe(2);
  });

  test("파일: 이름·크기·받기", async () => {
    const page = await open(phone, fileHash(id("압축 파일")));
    await page.locator(".vw-card").waitFor();
    expect(await page.locator(".vw-card__name").innerText()).toBe("source.zip");
    expect(await page.locator(".vw-card__meta").innerText()).toContain("B");
    await audit(page, "폰 파일");
    await shot(page, "phone-file");
    await page.close();
  });
});

describe("아티팩트", () => {
  const inner = (page: Page) => page.frameLocator("iframe.afr-frame");

  test("실행을 누르기 전에는 칸을 만들지 않고 원본도 받지 않는다", async () => {
    const f = await upload({ title: "루프 있는 글", html: `<h1>글</h1><script>setTimeout(function(){while(1){}},300)</script>` });
    const page = await open(desk, fileHash(f.id));
    await page.getByRole("button", { name: "실행", exact: true }).waitFor();
    await page.waitForTimeout(600);
    expect(await page.locator("iframe.afr-frame").count()).toBe(0);
    await page.close();
  });

  test("이미지 첨부는 주소에 접속 코드 없이 쿠키로 그려지고, 주소를 직접 열어도 코드가 통하지 않는다", async () => {
    const form = new FormData();
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    form.set("file", new File([png], "cookie.png", { type: "image/png" }));
    const uploaded = (await (await fetch(`${base}/api/uploads`, { method: "POST", headers: { Authorization: `Bearer ${CODE}` }, body: form })).json()) as { id: string; url: string };
    await api("POST", `/api/projects/${project.id}/messages`, { text: "이미지", attachmentIds: [uploaded.id] });
    const page = await open(desk, `#/p/${project.id}/thread`);
    const img = page.locator(`img[src*="${uploaded.id}"]`).first();
    await img.waitFor();
    expect(await img.getAttribute("src")).not.toContain("t=");
    await page.waitForFunction((el) => (el as HTMLImageElement).naturalWidth > 0, await img.elementHandle());
    const stranger = await chrome.newContext();
    const other = await stranger.newPage();
    expect((await other.goto(`${base}${uploaded.url}?t=${CODE}`))!.status()).toBe(401);
    expect((await other.goto(`${base}${uploaded.url}`))!.status()).toBe(401);
    await stranger.close();
    await page.close();
  });

  test("첨부 칩은 주소에 접속 코드 없이 내려받고 새 창을 열지 않는다", async () => {
    const form = new FormData();
    form.set("file", new File([`<meta name="referrer" content="unsafe-url"><a href="https://example.com/">x</a>`], "chip.html", { type: "text/html" }));
    const uploaded = (await (await fetch(`${base}/api/uploads`, { method: "POST", headers: { Authorization: `Bearer ${CODE}` }, body: form })).json()) as { id: string };
    await api("POST", `/api/projects/${project.id}/messages`, { text: "첨부", attachmentIds: [uploaded.id] });
    const page = await open(desk, `#/p/${project.id}/thread`);
    const chip = page.locator(".atv-file", { hasText: "chip.html" });
    await chip.waitFor();
    expect(await chip.getAttribute("href")).not.toContain("t=");
    expect(await chip.getAttribute("target")).toBeNull();
    const pages = desk.pages().length;
    const download = page.waitForEvent("download");
    await chip.click();
    expect((await download).suggestedFilename()).toBe("chip.html");
    expect(desk.pages().length).toBe(pages);
    await page.close();
  });

  test("데스크톱: 예시가 깔끔히 그려지고 넓은 칸을 쓰며, 탭이 돌고 칸이 내용에 맞춰 줄어든다", async () => {
    const page = await openRun(desk, fileHash(id("결제 방식 비교")));
    await inner(page).locator("h1").waitFor();
    expect(await page.locator(".fl--desk[data-wide]").count()).toBe(1);
    expect(await inner(page).locator(".kit-table table").count()).toBe(1);
    const iframe = page.locator("iframe.afr-frame");
    expect(await iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(await iframe.getAttribute("src")).toBe("/artifact-frame");
    expect(await iframe.getAttribute("srcdoc")).toBeNull();
    const height = () => iframe.evaluate((e) => e.getBoundingClientRect().height);
    await page.waitForFunction(() => document.querySelector("iframe.afr-frame")!.getBoundingClientRect().height > 600);
    const tall = await height();
    // 표가 칸을 채운다
    const widths = await inner(page).locator("table").evaluate((t) => [t.getBoundingClientRect().width, document.body.clientWidth - 48]);
    expect(widths[0]).toBeGreaterThanOrEqual(widths[1]! - 1);
    await shot(page, "desk-artifact");
    await inner(page).getByRole("tab", { name: "2주차" }).click();
    await inner(page).getByText("빌링 키").waitFor();
    await page.waitForFunction((t) => document.querySelector("iframe.afr-frame")!.getBoundingClientRect().height < t, tall);
    await page.close();
  });

  test("전체 화면: 칸을 다시 읽지 않아 탭 선택이 남고, 닫기·Esc 로 돌아온다", async () => {
    for (const [ctx, name] of [[desk, "desk"], [phone, "phone"]] as const) {
      const page = await openRun(ctx, fileHash(id("결제 방식 비교")));
      await inner(page).locator("h1").waitFor();
      await inner(page).getByRole("tab", { name: "3주차" }).click();
      await page.getByRole("button", { name: "전체 화면" }).click();
      const box = await page.locator("iframe.afr-frame").boundingBox();
      const view = page.viewportSize()!;
      expect(box!.width).toBe(view.width);
      expect(box!.height).toBeGreaterThan(view.height - 90);
      expect(await inner(page).getByText("실결제 확인").isVisible()).toBe(true);
      expect(await page.locator("dialog.afr .afr-bar__title").innerText()).toBe("결제 방식 비교");
      await audit(page, `${name} 전체 화면`);
      await shot(page, `${name}-artifact-full`);
      await page.getByRole("button", { name: "닫기" }).click();
      await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("dialog.afr")!.open);
      expect(await inner(page).getByText("실결제 확인").isVisible()).toBe(true);
      // 초점이 칸 안에 있어도 Esc 가 먹는다
      await page.getByRole("button", { name: "전체 화면" }).click();
      await inner(page).getByRole("tab", { name: "1주차" }).click();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("dialog.afr")!.open);
      await page.close();
    }
  });

  test("폰: 넘침 없고 칸이 폭을 채운다", async () => {
    const page = await openRun(phone, fileHash(id("결제 방식 비교")));
    await inner(page).locator("h1").waitFor();
    await page.waitForTimeout(200);
    const over = await inner(page).locator("html").evaluate((d) => d.scrollWidth > window.innerWidth);
    expect(over).toBe(false);
    const box = await page.locator("iframe.afr-frame").boundingBox();
    expect(box!.width).toBeGreaterThan(330);
    await audit(page, "폰 아티팩트");
    await shot(page, "phone-artifact");
    await page.close();
  });

  test("불러오기 실패를 보여 주고 다시 시도한다", async () => {
    const page = await desk.newPage();
    await page.addInitScript((code) => localStorage.setItem("iamceo.accessCode", code), CODE);
    let fail = true;
    await page.route(/\/api\/files\/[^/]+\/artifact$/, (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"서버 오류"}' }) : route.continue()));
    await page.goto(`${base}/${fileHash(id("결제 방식 비교"))}`);
    await runIt(page);
    await page.getByText("아티팩트를 불러오지 못했습니다. 서버 오류").waitFor();
    expect(await page.getByRole("button", { name: "전체 화면" }).count()).toBe(0);
    await shot(page, "desk-artifact-fail");
    fail = false;
    await page.getByRole("button", { name: "다시 시도" }).click();
    await inner(page).locator("h1").waitFor();
    await page.close();
  });

  test("자기 높이를 따라 자라는 CSS 에 끌려가지 않는다", async () => {
    const f = await upload({ title: "자라는 글", html: `<style>html,body{height:auto}body{min-height:100vh;box-sizing:content-box;padding:40px}</style><p>글</p>` });
    const page = await openRun(desk, fileHash(f.id));
    await inner(page).locator("p").waitFor();
    await page.waitForTimeout(2500);
    const box = await page.locator("iframe.afr-frame").boundingBox();
    expect(box!.height).toBeLessThanOrEqual(900);
    await page.close();
  });

  test("칸 안 링크: 칸이 넘어가지 않고 대표가 열지 고른다", async () => {
    const f = await upload({ title: "링크 있는 글", html: `<p id="p"><a id="out" href="https://example.com/a?b=1">바깥</a> <a id="here" href="#p">안</a> <a id="self" href="/api/bootstrap">서버</a></p>` });
    const page = await openRun(desk, fileHash(f.id));
    await inner(page).locator("#out").waitFor();
    await inner(page).locator("#here").click();
    await inner(page).locator("#self").click();
    await page.waitForTimeout(150);
    expect(await page.locator(".afr-link").count()).toBe(0);
    await inner(page).locator("#out").click();
    await page.locator(".afr-link").waitFor();
    expect(await inner(page).locator("#out").isVisible()).toBe(true);
    const a = page.locator(".afr-link a");
    expect(await a.getAttribute("href")).toBe("https://example.com/a?b=1");
    expect(await a.getAttribute("rel")).toContain("noopener");
    await page.close();
  });
});

// 악성 아티팩트: 진짜 화면에서 돌린다. 결과는 칸이 parent.postMessage 로 알리고, 바깥 서버는 받은 요청을 센다.
for (const [label, type] of [["chromium", chromium], ["webkit", webkit]] as [string, BrowserType][]) {
  describe(`악성 아티팩트: ${label}`, () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let outside: ReturnType<typeof Bun.serve>;
    const hits: string[] = [];

    beforeAll(async () => {
      outside = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          hits.push(new URL(req.url).pathname);
          return new Response("<!doctype html><script>parent.postMessage({outsideLoaded:true},'*')</script>", { headers: { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" } });
        },
      });
      browser = await type.launch();
      ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      ctx.setDefaultTimeout(10_000);
    });

    afterAll(async () => {
      await browser.close();
      outside.stop(true);
    });

    async function run(html: string, title: string, waitMs = 1200): Promise<{ page: Page; messages: Record<string, unknown>[] }> {
      const f = await upload({ title, html });
      const page = await ctx.newPage();
      await page.addInitScript((code) => {
        localStorage.setItem("iamceo.accessCode", code);
        (window as unknown as { __msgs: unknown[] }).__msgs = [];
        addEventListener("message", (e) => (window as unknown as { __msgs: unknown[] }).__msgs.push(e.data));
      }, CODE);
      await page.goto(`${base}/${fileHash(f.id)}`);
      await runIt(page);
      await page.locator("iframe.afr-frame").waitFor();
      await page.waitForFunction(() => (window as unknown as { __msgs: { iamceoHeight?: number }[] }).__msgs.some((m) => typeof m?.iamceoHeight === "number"));
      await page.waitForTimeout(waitMs);
      return { page, messages: (await page.evaluate(() => (window as unknown as { __msgs: unknown[] }).__msgs)) as Record<string, unknown>[] };
    }

    test("fetch·top.location·부모 DOM·저장소·외부 이미지·form·창 열기가 모두 막힌다", async () => {
      hits.length = 0;
      const out = `http://127.0.0.1:${outside.port}`;
      const html = `<h1 id="t">악성</h1><img src="${out}/img-tag"><form id="f" action="${out}/form" method="post"><input name="a" value="1"></form>
<script>(async function(){
  var p={};
  p.origin=String(self.origin);
  p.href=location.href;
  p.referrer=document.referrer;
  p.hasCode=document.documentElement.outerHTML.indexOf("files-"+"secret-code")>=0;
  try{p.storage=localStorage.getItem("iamceo.accessCode")}catch(e){p.storage="차단"}
  try{p.cookie=document.cookie}catch(e){p.cookie="차단"}
  try{p.parentDoc=parent.document.title}catch(e){p.parentDoc="차단"}
  try{p.parentBody=(parent.document.body.innerHTML="가로챔","뚫림")}catch(e){p.parentBody="차단"}
  try{var r=await fetch("/api/bootstrap",{headers:{Authorization:"Bearer x"}});p.fetchSelf=r.status}catch(e){p.fetchSelf="차단"}
  try{var r2=await fetch("${out}/fetch");p.fetchOut=r2.status}catch(e){p.fetchOut="차단"}
  try{var x=new XMLHttpRequest();x.open("GET","${out}/xhr",false);x.send();p.xhr=x.status}catch(e){p.xhr="차단"}
  try{p.beacon=navigator.sendBeacon("${out}/beacon","x")}catch(e){p.beacon="차단"}
  try{var ws=new WebSocket("ws://127.0.0.1:${outside.port}/ws");p.ws="시도"}catch(e){p.ws="차단"}
  var img=new Image();img.src="${out}/img-js";
  try{top.location="${out}/top";p.top="시도"}catch(e){p.top="차단"}
  try{parent.location="${out}/parent";p.parentLoc="시도"}catch(e){p.parentLoc="차단"}
  try{var w=open("${out}/popup");p.popup=w?"열림":"차단"}catch(e){p.popup="차단"}
  try{document.getElementById("f").submit();p.form="시도"}catch(e){p.form="차단"}
  try{var s=document.createElement("script");s.src="${out}/script.js";document.head.append(s)}catch(e){}
  try{var l=document.createElement("link");l.rel="stylesheet";l.href="${out}/style.css";document.head.append(l)}catch(e){}
  try{var fr=document.createElement("iframe");fr.src="${out}/inner-frame";document.body.append(fr)}catch(e){}
  parent.postMessage({probe:p},"*");
})();</script>`;
      const { page, messages } = await run(html, `악성 시험 ${label}`, 1500);
      const p = messages.find((m) => "probe" in m)?.probe as Record<string, unknown>;
      expect(p).toBeDefined();
      expect(p.origin).toBe("null");
      expect(p.hasCode).toBe(false);
      expect(String(p.href)).not.toContain(CODE);
      expect(String(p.referrer)).toBe("");
      expect(p.storage).toBe("차단");
      expect(p.cookie).toBe("차단");
      expect(p.parentDoc).toBe("차단");
      expect(p.parentBody).toBe("차단");
      expect(p.fetchSelf).toBe("차단");
      expect(p.fetchOut).toBe("차단");
      expect(p.xhr).toBe("차단");
      // sendBeacon·WebSocket·새 이미지는 조용히 실패한다. 아래 hits 가 증거다.
      expect(p.popup).toBe("차단");
      // 바깥으로 나간 요청이 하나도 없다
      expect(hits).toEqual([]);
      // 화면은 그대로다
      expect(page.url()).toContain(fileHash(files.get(`악성 시험 ${label}`)!.id));
      expect(await page.locator(".fl-doc__title").innerText()).toBe(`악성 시험 ${label}`);
      expect(await page.evaluate(() => document.body.innerHTML.includes("가로챔"))).toBe(false);
      expect(ctx.pages().length).toBe(1);
      await page.close();
    }, 30_000);

    test("칸이 스스로 바깥 주소로 넘어가지 못하고, 바깥 페이지가 원본을 받지 못한다", async () => {
      hits.length = 0;
      const out = `http://127.0.0.1:${outside.port}`;
      const { page, messages } = await run(`<p>비밀 원본</p><script>setTimeout(function(){location.href="${out}/self-nav"},50)</script>`, `자기 이동 ${label}`, 1200);
      expect(hits).toEqual([]);
      expect(messages.some((m) => "outsideLoaded" in m)).toBe(false);
      await page.close();
    }, 30_000);

    test("무한 루프 아티팩트: 열기만 해서는 돌지 않아 앱이 멈추지 않는다", async () => {
      const f = await upload({ title: `루프 ${label}`, html: `<script>setTimeout(function(){while(1){}},100)</script>` });
      const page = await open(ctx, fileHash(f.id));
      await page.getByRole("button", { name: "실행", exact: true }).waitFor();
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => 1 + 1)).toBe(2);
      expect(await page.locator("iframe.afr-frame").count()).toBe(0);
      await page.close();
    }, 30_000);

    test("전체 화면으로 올려도 칸이 다시 읽히지 않고 탭 선택이 남는다", async () => {
      const page = await openRun(ctx, fileHash(id("결제 방식 비교")));
      const frame = page.frameLocator("iframe.afr-frame");
      await frame.locator("h1").waitFor();
      await frame.getByRole("tab", { name: "2주차" }).click();
      await page.getByRole("button", { name: "전체 화면" }).click();
      expect(await page.locator("dialog.afr").evaluate((d: HTMLDialogElement) => d.open && d.matches(":modal"))).toBe(true);
      expect(await frame.getByText("빌링 키").isVisible()).toBe(true);
      const box = await page.locator("iframe.afr-frame").boundingBox();
      expect(box!.width).toBe(1440);
      await page.getByRole("button", { name: "닫기" }).click();
      await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("dialog.afr")!.open);
      expect(await frame.getByText("빌링 키").isVisible()).toBe(true);
      expect((await page.locator("iframe.afr-frame").boundingBox())!.width).toBeLessThan(1200);
      await page.close();
    }, 30_000);

    test("높이 값 위조: 범위 밖·수가 아닌 값·다른 창의 메시지는 무시한다", async () => {
      const html = `<div style="height:300px">글</div><button id="go">시작</button><script>
document.getElementById("go").addEventListener("click",function(){
  [1e12,-5,"9999",NaN,Infinity,null,{a:1}].forEach(function(v){parent.postMessage({iamceoHeight:v},"*")});
  parent.postMessage({iamceoFrameReady:true},"*");
  parent.postMessage({iamceoLink:"javascript:alert(1)"},"*");
  parent.postMessage({iamceoLink:location.origin+"/x"},"*");
  parent.postMessage({done:true},"*");
});</script>`;
      const { page } = await run(html, `높이 위조 ${label}`, 300);
      const iframe = page.locator("iframe.afr-frame");
      const before = (await iframe.boundingBox())!.height;
      expect(before).toBeGreaterThan(300);
      await page.frameLocator("iframe.afr-frame").locator("#go").click();
      await page.waitForFunction(() => (window as unknown as { __msgs: { done?: boolean }[] }).__msgs.some((m) => m?.done));
      await page.waitForTimeout(100);
      expect((await iframe.boundingBox())!.height).toBe(before);
      expect(await page.locator(".afr-link").count()).toBe(0);
      // 준비 알림을 다시 보내도 원본을 또 보내지 않는다(칸이 다른 문서로 바뀌어도 받지 못한다)
      // 다른 창(페이지 자신)이 보낸 값은 소스가 달라 버린다
      await page.evaluate(() => postMessage({ iamceoHeight: 5000 }, "*"));
      await page.waitForTimeout(100);
      expect((await iframe.boundingBox())!.height).toBe(before);
      await page.close();
    }, 30_000);
  });
}
