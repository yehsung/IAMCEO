// 화면 시험(Playwright)은 각자 새 프로세스의 bun test 로 돌린다.
// bun 1.3.14 는 앞선 시험의 자식 프로세스 fd 를 GC 때 한 번 더 닫는 일이 있다(맥에서 EXC_GUARD 로 시험 프로세스가 통째로 SIGKILL,
// 또는 재사용된 번호의 Chromium 파이프가 닫혀 "browser has been closed"). 같은 프로세스에 두면 결과가 시험과 상관없이 무작위로 깨진다.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

async function runFile(file: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, "test", `./tests/${file}`], { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  // A failed UI wait must not leave a child browser suite running after the wrapper times out.
  const timer = setTimeout(() => proc.kill("SIGKILL"), 270_000);
  let out: string, err: string, code: number;
  try { [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); }
  finally { clearTimeout(timer); }
  // bun test 는 결과를 stderr 로 낸다. 실패 때만 전부 보여 주고, 평소에는 요약만 남긴다.
  const text = `${out}${err}`;
  const summary = text.split("\n").filter((l) => /^\s*\d+ (pass|fail)$|^Ran \d+ tests/.test(l)).join(" · ");
  console.log(`${file}: ${summary}`);
  if (code !== 0) console.log(text);
  expect(code).toBe(0);
  expect(summary).toMatch(/[1-9]\d* pass/);
  expect(summary).toMatch(/ 0 fail/);
}

describe("화면 시험", () => {
  test("전 과정(가짜 claude, 데스크톱+폰)", () => runFile("e2e-fake.browser.ts"), 300_000);
  test("전체 통합(요청 10건을 한 흐름으로)", () => runFile("integrated.browser.ts"), 300_000);
  test("회귀(결함별)", () => runFile("screens-regress.browser.ts"), 300_000);
  test("아티팩트 격리", () => runFile("artifact.browser.ts"), 180_000);
  test("홈과 5칸 탭", () => runFile("home.browser.ts"), 180_000);
  test("자료 화면(종류별 보기·악성 아티팩트)", () => runFile("files.browser.ts"), 240_000);
});
