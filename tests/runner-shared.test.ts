// 실행기 종류와 무관한 공용 함수의 시험. 옛 실행기 시험 파일에 들어 있던 것을 그 파일들이 지워지기 전에 건져 두었다.
//   - Claude Code 화면 해석(server/runner/claude-screen.ts): tests/herdr.test.ts '화면 해석', tests/herdr-contract.test.ts 의 화면 해석 시험
//   - CLI 자식 환경(server/runner/env.ts): tests/headless.test.ts '도움 함수'
//   - "세션이 없다"는 오류 판정(server/runner/session-files.ts): tests/headless.test.ts 가 실행기를 거쳐 보던 것
//   - 세션 기록 해석(server/runner/transcript.ts)·역할 글(server/roles.ts): tests/headless.test.ts '도움 함수'. CoreRunner 의 문맥 측정이 쓴다.
// 함께 있던 backgroundWait·transcriptTurnEnded·exitHintShown 단정은 옛 herdr 실행기에만 있는 함수라 옮기지 않았다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRole } from "../server/roles.ts";
import { inputLooksEmpty, inputText, screenContextPct } from "../server/runner/claude-screen.ts";
import { childEnv } from "../server/runner/env.ts";
import { isMissingSessionError } from "../server/runner/session-files.ts";
import { contextPct, parseTranscriptTail, readTranscriptTail, transcriptPath } from "../server/runner/transcript.ts";

const SCREEN = (input: string, tail = "") => [
  "이전 출력", "> 인용된 줄", "─".repeat(40), `❯ ${input}`, "─".repeat(40),
  "  ◆ Opus │ ███░░░░░░░ │ 27% │ 268K/1.0M", "  ⏵⏵ bypass permissions on", tail,
].join("\n");

describe("화면 해석", () => {
  test("입력칸", () => {
    expect(inputLooksEmpty(SCREEN(""))).toBe(true);
    expect(inputLooksEmpty(SCREEN("쓰다 만 글"))).toBe(false);
    expect(inputLooksEmpty(SCREEN('Try "edit foo.ts"'))).toBe(true);
    expect(inputLooksEmpty(`${"─".repeat(20)}\n❯ 첫 줄\n  둘째 줄\n${"─".repeat(20)}\n`)).toBe(false);
    expect(inputLooksEmpty(`${"─".repeat(20)}\n❯\n  둘째 줄\n${"─".repeat(20)}\n`)).toBe(false);
    expect(inputLooksEmpty("Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel")).toBe(null);
    expect(inputLooksEmpty("user@host % ")).toBe(null);
    expect(inputLooksEmpty(`\x1b[38m${"─".repeat(20)}\x1b[0m\n\x1b[0m❯ \x1b[7m \x1b[0m\n${"─".repeat(20)}\n`)).toBe(true);
  });

  test("흐린 글씨(다음 말 추천·안내 글)는 친 글이 아니다", () => {
    const rule = `\x1b[2m\x1b[38;5;244m${"─".repeat(40)}\x1b[0m`;
    const box = (line: string) => `이전 출력\n${rule}\n${line}\n${rule}\n  ⏵⏵ bypass permissions on`;
    // 실제 칸에서 읽은 줄(Claude Code 의 다음 말 추천)
    expect(inputLooksEmpty(box("❯\xa0\x1b[0m\x1b[2m포이 님 집계 확인 예약은 지워 줘\x1b[0m\r"))).toBe(true);
    expect(inputLooksEmpty(box("❯ \x1b[2;3mTry \"fix lint errors\"\x1b[22;23m"))).toBe(true);
    expect(inputLooksEmpty(box("❯ 쓰던 글"))).toBe(false);
    // 친 글 뒤에 흐린 이어쓰기 추천이 붙어도 친 글이 있다
    expect(inputLooksEmpty(box("❯ 포이\x1b[2m 님 집계 확인\x1b[0m"))).toBe(false);
    // 트루컬러·256색 숫자 안의 2 는 흐림이 아니다
    expect(inputLooksEmpty(box("❯ \x1b[38;2;200;2;2m빨간 글\x1b[0m"))).toBe(false);
    expect(inputLooksEmpty(box("❯ \x1b[38;5;2m초록 글\x1b[39m"))).toBe(false);
    // 22 로 흐림이 풀린 뒤의 글은 친 글
    expect(inputLooksEmpty(box("❯ \x1b[2m추천\x1b[22m친 글"))).toBe(false);
    // 윗줄에서 켠 흐림이 이어진다(리셋 없음)
    expect(inputLooksEmpty(`\x1b[2m${"─".repeat(30)}\n❯ 흐린 채 이어진 글\n${"─".repeat(30)}\x1b[0m`)).toBe(true);
    // 링크(OSC 8)가 섞여도 읽는다
    expect(inputLooksEmpty(box("❯ \x1b]8;;https://x.y\x07링크\x1b]8;;\x07"))).toBe(false);
  });

  // 옛 시험: "입력칸에 남은 글을 그대로 읽고, 종료 안내는 입력칸 아래에서만 본다". 종료 안내(exitHintShown)는 옛 herdr 실행기의 함수다.
  test("입력칸에 남은 글을 그대로 읽는다", () => {
    expect(inputText(SCREEN("쓰다 만 글"))).toBe("쓰다 만 글");
    expect(inputText(SCREEN(""))).toBe("");
    expect(inputText(`${"─".repeat(20)}\n❯ 첫 줄\n  둘째 줄\n${"─".repeat(20)}\n`)).toBe("첫 줄\n둘째 줄");
    expect(inputText(`${"─".repeat(20)}\n❯ 포이\x1b[2m 님 집계 확인\x1b[0m\n${"─".repeat(20)}\n`)).toBe("포이");
    expect(inputText("Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel")).toBe(null);
  });

  test("실제 화면 모양(라벨 달린 가로줄, 아래 상태줄·진행 줄)", () => {
    const real = [
      `${"─".repeat(190)} ops-board-v2-plan ─`, "❯", "─".repeat(200),
      "  ◆ Opus(X) │ ███░░░░░░░ │ 27% │ 268K/1.0M │ $38.35", "  📁 me (iamceo) (main)", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent", "",
      "  ◯ iamceo-build  ▰▰▰▱▱  2/4 · 19m27s", "",
    ].join("\n");
    expect(inputLooksEmpty(real)).toBe(true);
    expect(screenContextPct(real)).toBe(27);
    expect(screenContextPct("아무 글")).toBe(null);
    expect(screenContextPct("│ 50% │ 표 안의 숫자")).toBe(null);
  });

  test("잘린 상태줄은 %로 읽지 않는다: 위의 대화·아래의 다른 % 칸으로 넘어가지 않는다", () => {
    const rule = "─".repeat(40);
    // 대화에 그린 막대 표(상태줄과 같은 모양). 입력칸 위에 있다.
    const chart = ["⏺ 진행 상황입니다", "  │ ████████░░ │ 80% │ 결제", "  │ ██░░░░░░░░ │ 20% │ 배포"];
    const screen = (...status: string[]) => [...chart, rule, "❯ ", rule, ...status, "  ⏵⏵ bypass permissions on"].join("\n");
    expect(screenContextPct(screen("  ◆ Opus(X) │ ███░░░░░░░ │ 27% │ 268K/1.0M │ $38.35"))).toBe(27);
    // 실측 좁은 칸: 막대에서 잘렸다
    expect(screenContextPct(screen("  ◆ Opus(X) │ ██░░░░░░…"))).toBe(null);
    // 숫자 중간에서 잘렸다
    expect(screenContextPct(screen("  ◆ Opus(X) │ ███░░░░░░░ │ 2…"))).toBe(null);
    expect(screenContextPct(screen("  ◆ Opus(X) │ ███░░░░░░░ │ 27…"))).toBe(null);
    // 막대 앞에서 잘렸다. 둘째 줄의 다른 % 칸(사용량 한도)이나 위 대화의 표를 문맥으로 읽지 않는다
    expect(screenContextPct(screen("  ◆ Opus(X) │ …", "  5h: 45% │ 7d: 12%"))).toBe(null);
    expect(screenContextPct(screen("  ◆ Opus(X) │ ███░░░░░░░ │ 2…", "  5h: 45% │ 7d: 12%"))).toBe(null);
    // 막대 칸 바로 다음이 % 가 아니면(다른 칸) 읽지 않는다
    expect(screenContextPct(screen("  ◆ Opus(X) │ ███░░░░░░░ │ $3.20 │ 5h: 45%"))).toBe(null);
    // 상태줄이 없는 칸(설정 안 함)
    expect(screenContextPct(screen())).toBe(null);
    // 입력칸을 못 찾으면(승인 창 등) 아무 줄도 믿지 않는다
    expect(screenContextPct(["  │ ███░░░░░░░ │ 27%", "Do you want to proceed?", "❯ 1. Yes"].join("\n"))).toBe(null);
    // 색 코드가 섞인 화면
    expect(screenContextPct(screen("  \x1b[36m◆ Opus\x1b[0m │ \x1b[32m███\x1b[2m░░░░░░░\x1b[0m │ \x1b[32m27%\x1b[0m"))).toBe(27);
  });

  // 옛 시험(tests/herdr-contract.test.ts): "background and measured context parsing retain W0 screen semantics" 에서 화면 해석 두 단정.
  test("입력칸 위에 뒤 작업 기다림 줄, 아래에 상태줄이 있는 화면: 입력칸은 비었고 문맥 %를 읽는다", () => {
    const composer = (draft = "", history = "prior output") => `${history}\n${"─".repeat(40)}\n❯ ${draft}\n${"─".repeat(40)}\n`;
    const screen = composer("", "✻ Waiting for 1 dynamic workflow to finish") + " ◆ Opus │ ███░░░░░░░ │ 27% │\n";
    expect(inputText(screen)).toBe("");
    expect(screenContextPct(screen)).toBe(27);
  });
});

describe("CLI 자식 환경", () => {
  test("childEnv 는 HERDR_*·CLAUDE 진입 변수만 지운다", () => {
    expect(childEnv({ HERDR_X: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "a", CLAUDE_CODE_SSE_PORT: "2", PATH: "/bin", IAMCEO_HOME: "/h", CLAUDE_CONFIG_DIR: "/c", USER: "ceo" })).toEqual({ PATH: "/bin", IAMCEO_HOME: "/h", CLAUDE_CONFIG_DIR: "/c", USER: "ceo" });
  });

  // Claude Code 는 USER 없이 뜨면 키체인에 계정 "unknown" 의 빈 로그인 항목을 만든다(2026-11-11 실측).
  test("childEnv 는 USER 가 없으면 이 Mac 의 사용자 이름으로 채우고, 있는 값은 건드리지 않는다", () => {
    expect(childEnv({ PATH: "/bin" }, () => "ceo")).toEqual({ PATH: "/bin", USER: "ceo", LOGNAME: "ceo" });
    expect(childEnv({ PATH: "/bin", USER: "", LOGNAME: "kept" }, () => "ceo")).toEqual({ PATH: "/bin", USER: "ceo", LOGNAME: "kept" });
    expect(childEnv({ USER: "me" }, () => "other")).toEqual({ USER: "me" });
    // 사용자 이름을 알 수 없으면 지어내지 않는다.
    expect(childEnv({ PATH: "/bin" }, () => { throw new Error("no passwd entry"); })).toEqual({ PATH: "/bin" });
    expect(childEnv({ PATH: "/bin" }, () => "")).toEqual({ PATH: "/bin" });
    expect(childEnv({ PATH: "/bin" }).USER).toBeTruthy();
  });
});

describe("세션 기록", () => {
  // 옛 시험(tests/headless.test.ts): "없는 세션 resume 은 오류 턴으로 끝나고 판별할 수 있다" 가 실행기를 거쳐 보던 판정.
  test("없는 세션을 이어 열라고 했을 때의 CLI 오류 글을 판별한다", () => {
    expect(isMissingSessionError("No conversation found with session ID: 11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isMissingSessionError("session 1234 not found")).toBe(true);
    expect(isMissingSessionError("session.snapshot: 8000ms 안에 답 없음")).toBe(false);
    expect(isMissingSessionError("")).toBe(false);
    expect(isMissingSessionError(null)).toBe(false);
  });

  // 아래 둘은 옛 시험(tests/headless.test.ts '도움 함수')을 단정 그대로 옮긴 것이다.
  // 시험 틀(core-harness)의 가짜 CLI 와 CoreRunner 는 같은 transcriptPath 를 불러 쓰므로, 폴더 이름 규칙은 여기서 값으로 고정해야 틀려도 드러난다.
  test("transcript: 마지막 입력 뒤 같은 응답의 글을 잇고, usage·사이드체인을 가른다", () => {
    const lines = [
      '{"type":"assistant","message":{"id":"old","content":[{"type":"text","text":"지난 턴"}],"usage":{"input_tokens":1}}}',
      '{"type":"user","message":{"content":"새 입력"}}',
      '{"type":"assistant","isSidechain":true,"message":{"id":"s","content":[{"type":"text","text":"곁가지"}],"usage":{"input_tokens":999}}}',
      '{"type":"assistant","message":{"id":"a","model":"m1","content":[{"type":"text","text":"첫 응답"}],"usage":{"input_tokens":5}}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}',
      '{"type":"assistant","message":{"id":"b","model":"m2","content":[{"type":"text","text":"가"}],"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30}}}',
      '{"type":"assistant","message":{"id":"b","model":"m2","content":[{"type":"text","text":"나"},{"type":"tool_use","name":"x"}],"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30}}}',
      "잘린 줄",
      '{"type":"system","subtype":"turn_duration"}',
    ];
    // 서브에이전트(사이드체인)의 usage 999 는 문맥에 섞이지 않고, 같은 message.id 의 조각은 한 번만 센다.
    expect(parseTranscriptTail(lines.join("\n"))).toEqual({ finalText: "가\n나", contextTokens: 60, model: "m2" });
    expect(parseTranscriptTail(lines.slice(0, 2).join("\n")).finalText).toBe("");
  });

  test("transcript 파일: 없으면 null, 꼬리만 읽어 잘린 첫 줄을 버린다", () => {
    const dir = mkdtempSync(join(tmpdir(), "iamceo-transcript-"));
    expect(transcriptPath("/Users/a.b/c_d", "sid", dir)).toBe(join(dir, "projects", "-Users-a-b-c-d", "sid.jsonl"));
    expect(readTranscriptTail(join(dir, "없음.jsonl"))).toBeNull();
    const file = join(dir, "s.jsonl");
    const last = '{"type":"assistant","message":{"id":"z","content":[{"type":"text","text":"끝"}],"usage":{"input_tokens":7}}}';
    writeFileSync(file, `${"x".repeat(5000)}\n${last}\n`);
    expect(readTranscriptTail(file, last.length + 500)).toEqual({ finalText: "끝", contextTokens: 7, model: null });
    expect(contextPct(50_000)).toBe(25);
    expect(contextPct(500_000)).toBe(100);
  });
});

describe("역할 글", () => {
  // 옛 시험(tests/headless.test.ts '도움 함수')을 단정 그대로 옮긴 것이다.
  test("renderRole: 치환, 사용자 템플릿 우선, 값 안의 자리표시는 그대로", () => {
    const vars = { PROJECT: "{{NAME}}", NAME: "철수", ROLE: "개발", CONDUCTOR: "총괄" };
    const text = renderRole("worker", vars);
    expect(text).toContain("철수");
    expect(text).toContain("{{NAME}}");
    expect(text).not.toContain("{{ROLE}}");
    const dir = mkdtempSync(join(tmpdir(), "iamceo-roles-"));
    writeFileSync(join(dir, "worker.md"), "맞춤 {{NAME}}/{{ROLE}}");
    expect(renderRole("worker", vars, dir)).toBe("맞춤 철수/개발");
    expect(renderRole("root", vars, dir)).not.toContain("맞춤");
  });
});
