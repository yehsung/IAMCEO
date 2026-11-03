// 승인 창 읽기. 화면은 Claude Code 2.1.316 실측(격리 herdr 에서 haiku, default 모드)이고, 시험 폴더 경로만 /tmp/proj 로 바꿨다.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvalSummary, parseApproval } from "../server/runner/approval.ts";
import { inputLooksEmpty } from "../server/runner/herdr.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "approval", `${name}.ansi.txt`), "utf8");

describe("승인 창 읽기", () => {
  test("Bash 명령 창: 제목·명령·선택지 4개, 접힌 선택지는 한 줄로", () => {
    const a = parseApproval(fixture("bash1"))!;
    expect(a.title).toBe("Bash command");
    expect(a.question).toBe("Do you want to proceed?");
    expect(a.body.split("\n")).toContain("mkdir -p out && touch out/a.txt && echo done-a");
    expect(a.options.map((o) => o.n)).toEqual([1, 2, 3, 4]);
    expect(a.options[1]!.label).toBe("Yes, and don't ask again for mkdir -p out and touch out/a.txt commands in /tmp/proj");
    expect(a.options.map((o) => o.reject)).toEqual([false, false, false, true]);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(approvalSummary(a)).toBe("Bash command: Create out directory, touch a.txt, and echo done-a · mkdir -p out && touch out/a.txt && echo done-a");
  });

  test("파일 만들기 창: 미리보기의 줄 번호를 선택지로 읽지 않는다", () => {
    const a = parseApproval(fixture("write1"))!;
    expect(a.title).toBe("Create file");
    expect(a.question).toBe("Do you want to create c.txt?");
    expect(a.body).toBe("out/c.txt\n 1 hello");
    expect(a.options.map((o) => [o.n, o.reject])).toEqual([[1, false], [2, false], [3, true]]);
  });

  test("창 내용이 다르면 fingerprint 가 다르고, 같은 창은 다시 읽어도 같다", () => {
    const a = parseApproval(fixture("bash1"))!;
    const b = parseApproval(fixture("bash2"))!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(parseApproval(fixture("bash1"))!.fingerprint).toBe(a.fingerprint);
    // 커서(❯)가 다른 선택지로 옮겨도 같은 창이다.
    const cursor = "\x1b[38;2;177;185;249m❯ \x1b[0m\x1b[38;2;153;153;153m1. ";
    expect(fixture("bash1")).toContain(cursor);
    const moved = fixture("bash1").replace(cursor, "\x1b[38;2;177;185;249m  \x1b[0m\x1b[38;2;153;153;153m1. ").replace("   \x1b[0m\x1b[38;2;153;153;153m4. ", " ❯ \x1b[0m\x1b[38;2;153;153;153m4. ");
    expect(parseApproval(moved)!.fingerprint).toBe(a.fingerprint);
  });

  test("승인 창 화면은 입력칸이 비었다고 보지 않는다(글을 넣지 않는다)", () => {
    for (const n of ["bash1", "bash2", "write1"]) expect(inputLooksEmpty(fixture(n))).toBe(null);
  });

  test("승인 창이 아닌 것은 null", () => {
    // 폴더 신뢰 창: 서버가 대신 고르지 않는다.
    expect(parseApproval("────────────\n Do you want to work in this folder?\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Esc to cancel")).toBe(null);
    // 바이패스 경고 창
    expect(parseApproval("────────────\n Bypass Permissions mode\n Do you want to continue?\n ❯ 1. No, exit\n   2. Yes, I accept\n\n Esc to cancel")).toBe(null);
    // 대화 글 속 질문과 번호 목록(끝에 Esc 줄이 없다)
    expect(parseApproval("⏺ Do you want me to proceed?\n  1. Yes\n  2. No\n\n────────────\n❯ \n────────────")).toBe(null);
    // 거절이 없는 선택 창
    expect(parseApproval("────────────\n Pick one\n Do you want to use A or B?\n ❯ 1. A\n   2. B\n\n Esc to cancel")).toBe(null);
    // 번호가 차례가 아니다
    expect(parseApproval("────────────\n Bash command\n Do you want to proceed?\n ❯ 1. Yes\n   3. No\n\n Esc to cancel")).toBe(null);
    // 평범한 입력칸
    expect(parseApproval("────────────\n❯ \n────────────\n  ⏵⏵ bypass permissions on")).toBe(null);
  });

  test("창 윗부분이 화면 밖이면 제목 없이 보이는 본문만", () => {
    const a = parseApproval(" +  새 줄\n -  옛 줄\n Do you want to make this edit to a.ts?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel")!;
    expect(a.title).toBe("");
    expect(a.body).toBe("+  새 줄\n-  옛 줄");
    expect(a.options.map((o) => o.label)).toEqual(["Yes", "No"]);
  });
});
