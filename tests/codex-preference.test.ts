// 0.2.9 Codex 입력 앞의 실행 선호 한 줄(server/runner/core.ts codexExecutionPreference).
// 병렬을 켜지 않은 Codex 팀장에게는 '순서대로, 서브에이전트 없이'를 그대로 알린다. 총괄·본사 AI 에게는 그 줄을 쓰지 않는다:
// 11-20 Codex 총괄 시험에서 그 줄을 읽은 총괄이 팀장에게 일을 나누는 것까지 순서대로 했다(서로 상관없는 일을 앞 일이 끝날 때까지 미룸).
import { describe, expect, test } from "bun:test";
import { codexExecutionPreference } from "../server/runner/core.ts";

describe("codexExecutionPreference", () => {
  test("팀장: 병렬이 꺼져 있으면 순서대로·서브에이전트 없이, 켜져 있으면 자기 서브에이전트로 나눈다", () => {
    expect(codexExecutionPreference("worker", false)).toBe("IAMCEO execution preference: Work sequentially for this task; do not spawn subagents.\n\n");
    expect(codexExecutionPreference("worker", true)).toContain("Use native subagents for independent work in parallel");
  });

  test("총괄·본사 AI: 자기 서브에이전트만 막는다. '순서대로'라고 하지 않고, 팀장에게 나누는 일은 막지 않는다고 적는다", () => {
    for (const kind of ["conductor", "root"] as const) {
      const line = codexExecutionPreference(kind, false);
      expect(line.startsWith("IAMCEO execution preference: ")).toBe(true);
      expect(line.endsWith("\n\n")).toBe(true);
      expect(line).toContain("Do not spawn native subagents yourself");
      expect(line).not.toContain("sequentially");
      expect(line).toContain("does not limit how you hand out work with the IAMCEO team tools");
      expect(line).toContain("right away");
      expect(codexExecutionPreference(kind, true)).toBe(codexExecutionPreference("worker", true));
    }
  });
});
