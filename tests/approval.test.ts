// 승인 창 화면과 한 줄 요약. 화면은 Claude Code 2.1.316 실측(haiku, default 모드)이고, 시험 폴더 경로만 /tmp/proj 로 바꿨다.
// 권한 승인 창을 선택지까지 읽던 해석기(parseApproval)는 옛 herdr 실행기 전용이라 실행기와 함께 지웠다.
// core 는 폴더 신뢰 창만 읽는다(tests/core-approval.test.ts). 여기에는 실행기와 무관한 두 가지만 남긴다.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalPrompt } from "../shared/types.ts";
import { approvalSummary } from "../server/runner/core-approval.ts";
import { inputLooksEmpty } from "../server/runner/claude-screen.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "approval", `${name}.ansi.txt`), "utf8");
const prompt = (title: string, body: string): ApprovalPrompt => ({
  title, body, question: "Do you want to proceed?", fingerprint: "0".repeat(24),
  options: [{ n: 1, label: "Yes", reject: false }, { n: 2, label: "No", reject: true }],
});

describe("승인 창", () => {
  test("승인 창 화면은 입력칸이 비었다고 보지 않는다(글을 넣지 않는다)", () => {
    for (const n of ["bash1", "bash2", "write1"]) expect(inputLooksEmpty(fixture(n))).toBe(null);
  });

  test("한 줄 요약: 안내(Tip) 줄은 빼고, 긴 본문은 마지막 줄, 짧은 본문은 다 붙인다", () => {
    const bash = prompt("Bash command", "Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below\nCreate out directory, touch a.txt, and echo done-a\nmkdir -p out && touch out/a.txt && echo done-a");
    expect(approvalSummary(bash)).toBe("Bash command: Create out directory, touch a.txt, and echo done-a · mkdir -p out && touch out/a.txt && echo done-a");
    expect(approvalSummary(prompt("Create file", "out/c.txt\n 1 hello"))).toBe("Create file: out/c.txt · 1 hello");
    expect(approvalSummary(prompt("긴 창", "첫 줄\n둘째 줄\n셋째 줄"))).toBe("긴 창: 셋째 줄");
    expect(approvalSummary(prompt("", "한 줄"))).toBe("한 줄");
    const cut = approvalSummary(prompt("Bash command", "x".repeat(300)), 40);
    expect(cut).toHaveLength(40);
    expect(cut.endsWith("…")).toBe(true);
  });
});
