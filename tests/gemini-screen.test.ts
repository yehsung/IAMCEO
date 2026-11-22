// Antigravity CLI(agy) 화면 판독(server/runner/gemini-screen.ts): 입력칸, 진행 줄(재시도), 승인 창·폴더 신뢰 창 모양, 로그인·첫 설정 막힘.
//
// 위쪽 describe 들의 화면은 손으로 만든 모양 시험이다(입력칸 위·아래 가로줄, `> ` 입력 줄, 그 아래 상태줄). 아래 '1.5.14 실측 화면' 은
// 대표가 첫 설정을 마친 실제 agy 의 대화형 화면 견본(tests/fixtures/cli/gemini/1.5.14, 견본 시험 tests/cli-fixtures.test.ts)을 그대로 읽는다.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_PLACEHOLDERS, GEMINI_SETUP_MESSAGES, geminiApprovalDialog, geminiDraft, geminiFolderTrust, geminiMcpPanel, geminiProgress, geminiRetry, geminiSetupBlocked, geminiTurnToStop } from "../server/runner/gemini-screen.ts";
import { composerDraft, trustDialogLike, codexDraft } from "../server/runner/core.ts";
import { inputText } from "../server/runner/claude-screen.ts";
import { looksLikeFolderTrust } from "../server/runner/core-approval.ts";

const RULE = "─".repeat(120);
const HISTORY = "● Explored 1 file (demo.py)\n\n  Updated greet in demo.py to return 'Welcome, ' + name + '!'.\n";
const OURS = "IAMCEO · Gemini 4 Argon (Medium) · ctx 14%";
const DEFAULT_STATUS = `? for shortcuts${" ".repeat(70)}auto · Gemini 4 Argon · high`;
const composer = (input: string[], status: string[] = [OURS], history = HISTORY) => [history, RULE, ...input, RULE, ...status, ""].join("\n");

describe("geminiDraft: 빈 입력칸", () => {
  test("빈 입력칸 + IAMCEO 상태줄", () => {
    expect(geminiDraft(composer(["> "]))).toBe("");
    expect(geminiDraft(composer([">"]))).toBe("");
    // 상태줄에 값이 없는 칸은 빠진다(래퍼가 그렇게 그린다).
    for (const status of ["IAMCEO", "IAMCEO · Gemini 4 Argon", "IAMCEO · ctx 3%"]) expect(geminiDraft(composer(["> "], [status]))).toBe("");
  });
  test("빈 입력칸 + agy 기본 상태줄", () => {
    expect(geminiDraft(composer(["> "], [DEFAULT_STATUS]))).toBe("");
    expect(geminiDraft(composer(["> "], ["? for shortcuts"]))).toBe("");
  });
  test("자리표시 글은 빈 칸이다(네 가지 모드)", () => {
    expect(GEMINI_PLACEHOLDERS[0]).toBe("Auto mode: edits & safe commands auto-approved (shift+tab to cycle)");
    for (const hint of GEMINI_PLACEHOLDERS) {
      expect(geminiDraft(composer([`> ${hint}`]))).toBe("");
      expect(geminiDraft(composer([`> ${hint}`], [DEFAULT_STATUS]))).toBe("");
    }
    // 좁은 칸에서 자리표시 글이 다음 줄로 접혀도 이어 붙인 글이 같으면 빈 칸이다.
    expect(geminiDraft(composer(["> Auto mode: edits & safe commands", "  auto-approved (shift+tab to cycle)"]))).toBe("");
    // 자리표시 글에 글이 더 붙었으면 사람이 쓴 글이다.
    expect(geminiDraft(composer([`> ${GEMINI_PLACEHOLDERS[0]} 그리고`]))).toBe(`${GEMINI_PLACEHOLDERS[0]} 그리고`);
  });
  test("화면 아래의 빈 줄과 색 코드는 무시한다", () => {
    expect(geminiDraft(`${composer(["> "])}\n\n   \n`)).toBe("");
    expect(geminiDraft(composer(["\x1b[1m>\x1b[0m \x1b[2mAuto mode: edits & safe commands auto-approved (shift+tab to cycle)\x1b[0m"], [`\x1b[32m${OURS}\x1b[0m`]))).toBe("");
  });
});

describe("geminiDraft: 쓴 글", () => {
  test("한 줄", () => {
    expect(geminiDraft(composer(["> 배포 전에 로그를 한 번 더 봐 줘"]))).toBe("배포 전에 로그를 한 번 더 봐 줘");
    expect(geminiDraft(composer(["> keep my draft"], [DEFAULT_STATUS]))).toBe("keep my draft");
  });
  test("여러 줄", () => {
    expect(geminiDraft(composer(["> 첫 줄", "  둘째 줄", "  셋째 줄"]))).toBe("첫 줄\n둘째 줄\n셋째 줄");
    // 첫 줄이 비고 아래 줄에 글이 있어도 빈 칸이 아니다.
    expect(geminiDraft(composer(["> ", "  남은 글"]))).toBe("남은 글");
  });
});

describe("geminiDraft: 모르면 null", () => {
  test("승인 창(파일 고치기·만들기)", () => {
    const dialog = (question: string, status: string) => [
      RULE.slice(0, 60), "> Modify the greet function in demo.py to return 'Hi, ' + name + '!'", "", "● Edit(~/Develop/demo/demo.py) (ctrl+o to expand)", "", "Pending edit", RULE, "",
      "/home/developer/Develop/demo/demo.py  +1 -1", "  1 -      return 'Welcome, ' + name + '!'", "  1 +      return 'Hi, ' + name + '!'", "",
      "  shift+tab to auto-approve file edits", question, "> 1. Yes, accept this change", "  2. No, reject this change", "", "  ↑/↓ Navigate · tab Amend · f full diff", status, "",
    ].join("\n");
    // 기본 상태줄 자리는 승인 창에서 `esc to cancel` 로 바뀐다(문서 그림).
    expect(geminiDraft(dialog("Accept this file edit?", `esc to cancel${" ".repeat(60)}Gemini 4 Argon · medium`))).toBeNull();
    // IAMCEO 상태줄이 그대로 보여도, 그 위가 입력칸(가로줄·`>` 줄·가로줄)이 아니면 읽지 않는다.
    expect(geminiDraft(dialog("Accept this file edit?", OURS))).toBeNull();
    expect(geminiDraft(dialog("Allow creation of this file?", OURS))).toBeNull();
  });
  test("첫 설정 화면·로그인 안내", () => {
    expect(geminiDraft("Welcome to Antigravity CLI\n\nChoose a color theme\n> 1. Dark\n  2. Light\n\nenter to select\n")).toBeNull();
    expect(geminiDraft("Terms of Service\n\nDo you accept the terms and the data collection notice?\n> 1. Accept\n  2. Decline\n")).toBeNull();
    expect(geminiDraft("Sign in required\n\nOpen this URL in your browser to sign in:\nhttps://accounts.example/o/oauth2/auth\n")).toBeNull();
  });
  test("가로줄이 하나뿐인 화면", () => {
    expect(geminiDraft([HISTORY, "> ", RULE, OURS, ""].join("\n"))).toBeNull();
    expect(geminiDraft([RULE, OURS, ""].join("\n"))).toBeNull();
    expect(geminiDraft([HISTORY, RULE, "> ", OURS, ""].join("\n"))).toBeNull();
  });
  test("바닥줄이 없거나, 모르는 줄이 섞였거나, 너무 많다", () => {
    expect(geminiDraft([HISTORY, RULE, "> ", RULE, ""].join("\n"))).toBeNull();
    expect(geminiDraft(composer(["> "], ["esc to interrupt"]))).toBeNull();
    expect(geminiDraft(composer(["> "], [OURS, "1 message queued"]))).toBeNull();
    expect(geminiDraft(composer(["> "], ["⚠ Statusline disabled after 30 consecutive failures."]))).toBeNull();
    expect(geminiDraft(composer(["> "], [OURS, OURS, OURS, OURS]))).toBeNull();
    // 아래 가로줄과 바닥줄 사이에 빈 줄이 끼면 모르는 화면이다.
    expect(geminiDraft([HISTORY, RULE, "> ", RULE, "", OURS, ""].join("\n"))).toBeNull();
    // 접힌 상태줄(둘째 줄이 우리 모양이 아님).
    expect(geminiDraft(composer(["> "], ["IAMCEO · Gemini 4 Argon (Medium) ·", "ctx 14%"]))).toBeNull();
  });
  test("입력 줄이 `>` 로 시작하지 않거나 입력칸이 비정상으로 길다", () => {
    expect(geminiDraft(composer(["  1. Yes", "  2. No"]))).toBeNull();
    expect(geminiDraft(composer(["❯ "]))).toBeNull();
    expect(geminiDraft(composer(["› "]))).toBeNull();
    expect(geminiDraft(composer([">no space after the mark"]))).toBeNull();
    expect(geminiDraft(composer(["> 1", ...Array.from({ length: 60 }, (_, i) => `  줄 ${i}`)]))).toBeNull();
    expect(geminiDraft([HISTORY, RULE, RULE, OURS, ""].join("\n"))).toBeNull();
  });
  test("초안 안에 가로줄만 있는 줄이 있으면 어느 줄이 입력칸의 위쪽 줄인지 모른다: 빈 칸으로 읽지 않는다", () => {
    // 표·인용을 붙여 넣은 여러 줄 초안: `> abc` / 가로줄 / `>`. 가장 가까운 가로줄만 보면 빈 칸으로 읽힌다.
    expect(geminiDraft(composer(["> abc", RULE, ">"]))).toBeNull();
    expect(geminiDraft(composer(["> 표", "  머리", RULE, "> "]))).toBeNull();
    // 검사는 입력칸에 바로 이어 붙은 구간까지만이다. 빈 줄 위의 지난 글(지난 입력이 가로줄 상자로 남은 모양, 답 안의 인용)은 입력칸이 아니다:
    // 거기까지 걸러 내면 그런 글이 화면에 보이는 동안 전달이 멈춘다.
    expect(geminiDraft([RULE, "> 첫 지시", RULE, "답", "", RULE, "> ", RULE, OURS, ""].join("\n"))).toBe("");
    expect(geminiDraft([RULE, "> 첫 지시", RULE, "답", RULE, "> ", RULE, OURS, ""].join("\n"))).toBe("");
    expect(geminiDraft(["답", RULE, "> 인용", "계속", "", RULE, "> 쓰던 글", RULE, OURS, ""].join("\n"))).toBe("쓰던 글");
    // 지난 글에 `>` 로 시작하는 줄이 있어도 그 위가 가로줄이 아니면 그대로 읽는다.
    expect(geminiDraft(composer(["> "], [OURS], "> 지난 지시\n  답\n"))).toBe("");
    expect(geminiDraft(composer(["> 쓰던 글"], [OURS], "> 지난 지시\n  답\n"))).toBe("쓰던 글");
  });
  test("빈 화면·다른 CLI 의 화면", () => {
    expect(geminiDraft("")).toBeNull();
    expect(geminiDraft("\n\n\n")).toBeNull();
    // Codex 입력칸
    expect(geminiDraft("output\n› Ask Codex to do anything\n\n  GPT-6-Astra high Fast · /tmp\n  ← for agents · ? for shortcuts\n")).toBeNull();
    // Claude 입력칸(`❯`, 바닥줄 `? for shortcuts`)
    expect(geminiDraft(`prior output\n${RULE}\n❯ \n${RULE}\n  ? for shortcuts\n`)).toBeNull();
  });
});

describe("CLI 마다 자기 판독기로만 읽는다", () => {
  const gemini = composer(["> "]), claude = `prior output\n${RULE}\n❯ \n${RULE}\n`, codex = "prior output\n› \n  ? for shortcuts\n";
  test("composerDraft 는 CLI 값으로 판독기를 고른다", () => {
    expect(composerDraft("gemini", gemini)).toBe("");
    expect(composerDraft("claude", claude)).toBe(inputText(claude));
    expect(composerDraft("codex", codex)).toBe(codexDraft(codex));
    expect(composerDraft("claude", claude)).toBe("");
    expect(composerDraft("codex", codex)).toBe("");
    // agy 화면을 Codex 판독기로 읽지 않는다(예전에는 gemini 값이 Codex 가지로 떨어졌다).
    expect(codexDraft(gemini)).toBeNull();
    expect(composerDraft("gemini", codex)).toBeNull();
    expect(composerDraft("gemini", composer(["> 쓰던 글"]))).toBe("쓰던 글");
  });
  test("trustDialogLike: 입력칸이 보이면 아니고, agy 의 `> 1.` 선택 줄과 신뢰 문구가 있으면 안내한다", () => {
    const dialog = "Do you trust the contents of this project?\n\n  /Users/dev/work/app\n\n> 1. Yes, I trust this folder\n  2. No, exit\n\nenter to confirm\n";
    expect(trustDialogLike(dialog, "gemini")).toBe(true);
    // Claude·Codex 의 기준(❯·›)은 그대로다: `>` 표시는 그쪽 창이 아니다.
    expect(looksLikeFolderTrust(dialog)).toBe(false);
    expect(trustDialogLike(dialog, "claude")).toBe(false);
    expect(trustDialogLike(dialog, "codex")).toBe(false);
    // 입력칸이 보이는 화면은 대화에 신뢰 문구가 있어도 창이 아니다.
    expect(trustDialogLike(composer(["> "], [OURS], `${dialog}\n`), "gemini")).toBe(false);
    expect(trustDialogLike("Accept this file edit?\n> 1. Yes, accept this change\n  2. No, reject this change\n", "gemini")).toBe(false);
  });
});

describe("geminiSetupBlocked: 로그인·첫 설정 막힘", () => {
  test("1.5.14 실측 보고 두 가지(글은 base64 로 오든 풀려서 오든 같다)", () => {
    expect(GEMINI_SETUP_MESSAGES).toEqual(["Finish setup", "Sign in required"]);
    expect(geminiSetupBlocked({ state: "blocked", kind: "auth", msg: "U2lnbiBpbiByZXF1aXJlZA==" })).toBe(true);
    expect(geminiSetupBlocked({ state: "blocked", kind: "question", msg: "RmluaXNoIHNldHVw" })).toBe(true);
    expect(geminiSetupBlocked({ state: "blocked", kind: "question", msg: "Finish setup" })).toBe(true);
    expect(geminiSetupBlocked({ state: "blocked", kind: "question", msg: " Sign in required " })).toBe(true);
    // 종류가 auth 면 글이 없어도 로그인이 필요한 것이다.
    expect(geminiSetupBlocked({ state: "blocked", kind: "auth" })).toBe(true);
  });
  test("다른 막힘·다른 상태는 아니다", () => {
    expect(geminiSetupBlocked({ state: "blocked", kind: "question", msg: "Accept this file edit?" })).toBe(false);
    expect(geminiSetupBlocked({ state: "blocked", kind: "permission", msg: "Finish setup later" })).toBe(false);
    expect(geminiSetupBlocked({ state: "blocked", kind: "question" })).toBe(false);
    expect(geminiSetupBlocked({ state: "idle", kind: "auth", msg: "Sign in required" })).toBe(false);
    expect(geminiSetupBlocked({ state: "working", msg: "Finish setup" })).toBe(false);
    expect(geminiSetupBlocked(null)).toBe(false);
    expect(geminiSetupBlocked(undefined)).toBe(false);
    // base64 처럼 보이지만 풀면 다른 글
    expect(geminiSetupBlocked({ state: "blocked", kind: "question", msg: "SGVsbG8gd29ybGQ=" })).toBe(false);
  });
});

describe("geminiTurnToStop: 멈춤 키를 보내도 되는 때", () => {
  test("도는 턴, 턴 중의 승인 창, 방금 넣은 글이 턴을 열기 전에만 보낸다", () => {
    expect(geminiTurnToStop({ state: "working" }, false)).toBe(true);
    expect(geminiTurnToStop({ state: "blocked", kind: "permission" }, false)).toBe(true);
    expect(geminiTurnToStop({ state: "idle" }, true)).toBe(true);
  });
  test("상태 보고가 없거나, 무엇을 묻는지 모르는 막힘이거나, 로그인·첫 설정이면 보내지 않는다(문구가 달라도)", () => {
    for (const pending of [false, true]) {
      expect(geminiTurnToStop(undefined, pending)).toBe(false);
      expect(geminiTurnToStop(null, pending)).toBe(false);
      expect(geminiTurnToStop({ state: "blocked", kind: "auth", msg: "U2lnbiBpbiByZXF1aXJlZA==" }, pending)).toBe(false);
      expect(geminiTurnToStop({ state: "blocked", kind: "question", msg: "RmluaXNoIHNldHVw" }, pending)).toBe(false);
      // agy 가 문구를 바꾸거나 현지화한 경우: 알아보지 못해도 키는 가지 않는다.
      expect(geminiTurnToStop({ state: "blocked", kind: "question", msg: "설정을 마쳐 주세요" }, pending)).toBe(false);
      expect(geminiTurnToStop({ state: "blocked" }, pending)).toBe(false);
    }
    expect(geminiTurnToStop({ state: "idle" }, false)).toBe(false);
    expect(geminiTurnToStop({ state: "done" }, false)).toBe(false);
  });
});

const REAL = join(import.meta.dir, "fixtures", "cli", "gemini", "1.5.14");
const real = (name: string) => readFileSync(join(REAL, `${name}.txt`), "utf8");
const FULL = "─".repeat(160);
const BOX = "─".repeat(60);
const BAR = "IAMCEO · Gemini 3.8 Flash (Low) · ctx 0%";

describe("1.5.14 실측 화면: 입력칸", () => {
  test("일하는 중·압축 중·재시도 중에도 지난 입력 상자(60칸 가로줄 + `> 글`)와 그 밑의 진행 줄을 입력칸으로 읽지 않는다: 입력칸은 빈 칸이다", () => {
    // 예전 판독(문서 그림 기준)은 이 다섯 화면에서 null 이었다(입력칸 위 가로줄 위로 이어 붙은 지난 입력 상자를 초안 속 가로줄로 읽음).
    for (const name of ["working-first", "working-tool", "compacting", "network-retry", "srv-delivered-working"]) expect([name, geminiDraft(real(name))]).toEqual([name, ""]);
  });
  test("서브에이전트 줄이 입력칸 아래 가로줄과 또 하나의 가로줄 사이에 끼어도 진짜 입력칸을 찾는다(도는 중·부모 턴이 끝난 뒤 남은 줄)", () => {
    expect(geminiDraft(real("subagent-running"))).toBe("");
    expect(geminiDraft(real("subagent-done-panel"))).toBe("");
  });
  test("모드별 빈 입력칸: 매번 묻기는 자리표시 글 없이 `>`, 나머지는 자리표시 글. 기본 바닥줄(`? for shortcuts`)도 같다", () => {
    for (const name of ["idle-default", "idle-accept-edits", "idle-auto", "idle-plan", "idle-announcement", "idle-default-statusline", "idle-auto-default-statusline", "srv-idle"]) expect([name, geminiDraft(real(name))]).toEqual([name, ""]);
  });
  test("초안: 한 줄, 두 칸 들여 이어진 여러 줄, 지운 뒤, 메뉴를 닫은 `/comp`", () => {
    expect(geminiDraft(real("draft-oneline"))).toBe("hello draft one line");
    expect(geminiDraft(real("draft-multiline"))).toBe("hello draft one linefirst pasted line\nsecond pasted line\nthird pasted line");
    expect(geminiDraft(real("draft-cleared"))).toBe("");
    expect(geminiDraft(real("slash-draft"))).toBe("/comp");
  });
  test("턴이 끝난 화면(답·중단·거절·압축 끝·장애)은 빈 칸, 승인·신뢰 창·메뉴·끝난 화면은 null", () => {
    for (const name of ["done-reply", "interrupted", "declined", "compacted", "network-error", "offline-start-error"]) expect([name, geminiDraft(real(name))]).toEqual([name, ""]);
    for (const name of ["approval-command", "approval-create", "approval-edit", "approval-edit-reject-selected", "srv-approval", "folder-trust", "slash-menu", "exit-resume"]) expect([name, geminiDraft(real(name))]).toEqual([name, null]);
  });
  test("진행 줄과 재시도: 입력칸 바로 위의 줄만 본다", () => {
    expect(geminiProgress(real("working-first"))).toBe("Generating...");
    expect(geminiProgress(real("compacting"))).toBe("Compacting conversation… (0s · esc to cancel)");
    expect(geminiProgress(real("subagent-running"))).toBe("Delegating...");
    expect(geminiRetry(real("network-retry"))).toEqual({ attempt: 3, max: 9, seconds: 9 });
    for (const name of ["working-first", "compacting", "idle-default", "network-error", "approval-command"]) expect([name, geminiRetry(real(name))]).toEqual([name, null]);
    expect(geminiProgress(real("idle-default"))).toBeNull();
    // 재시도 줄이 대화 위쪽(지난 글)에만 있으면 지금 재시도 중이 아니다.
    expect(geminiRetry([BOX, "> hi", "⣽  Model unavailable (attempt 1/9), retrying in 2s...", "", "  hello", "", FULL, ">", FULL, BAR, ""].join("\n"))).toBeNull();
  });
});

describe("모양 시험: 전체 너비 가로줄 짝", () => {
  test("가로줄 너비는 바닥줄 바로 위 가로줄로 정한다(80칸 화면)", () => {
    const rule = "─".repeat(80);
    expect(geminiDraft([BOX, "> 지난 지시", "⣻  Generating...", rule, ">", rule, BAR, ""].join("\n"))).toBe("");
    expect(geminiDraft([BOX, "> 지난 지시", rule, "> 쓰던 글", rule, BAR, ""].join("\n"))).toBe("쓰던 글");
    // 위·아래 가로줄 너비가 다르면 입력칸이 아니다.
    expect(geminiDraft([rule, ">", "─".repeat(79), BAR, ""].join("\n"))).toBeNull();
    // 가로줄이 들여 쓰였으면(초안 속 줄) 입력칸 가로줄이 아니다.
    expect(geminiDraft([FULL, ">", `  ${FULL.slice(2)}`, BAR, ""].join("\n"))).toBeNull();
  });
  test("초안에 붙여 넣은 가로줄은 두 칸 들여 쓰여 입력칸 가로줄로 읽히지 않는다", () => {
    expect(geminiDraft([FULL, "> 표", `  ${"─".repeat(158)}`, "  > 인용", FULL, BAR, ""].join("\n"))).toBe(`표\n${"─".repeat(158)}\n> 인용`);
  });
  test("60칸 화면: 지난 입력 상자와 입력칸 가로줄 너비가 같으면, 진행 줄이 사이에 있을 때만 지난 글로 본다", () => {
    expect(geminiDraft([BOX, "> 지난 지시", "⣻  Generating...", BOX, ">", BOX, BAR, ""].join("\n"))).toBe("");
    // 진행 줄도 빈 줄도 없이 같은 너비 가로줄 + `>` 줄이 이어 붙으면 어느 쪽이 입력칸인지 모른다.
    expect(geminiDraft([BOX, "> 지난 지시", BOX, ">", BOX, BAR, ""].join("\n"))).toBeNull();
  });
  test("서브에이전트 줄: 위가 같은 너비 가로줄이어야 하고, 그 꼴이 아닌 줄이 끼면 모른다", () => {
    const agent = "  ● Agent(self: Number Responder) · Gemini 3.8 Flash  Working · 1s";
    expect(geminiDraft([FULL, "> 쓰던 글", FULL, agent, "  ● Agent(research: Finder) · Gemini 3.8 Flash  Working · 3s", FULL, BAR, ""].join("\n"))).toBe("쓰던 글");
    expect(geminiDraft([FULL, ">", FULL, agent, BAR, ""].join("\n"))).toBeNull();
    expect(geminiDraft([FULL, ">", FULL, agent, "  1 more agent", FULL, BAR, ""].join("\n"))).toBeNull();
    // 초안의 마지막 줄이 서브에이전트 줄처럼 보여도 그 위가 가로줄이 아니면 초안이다.
    expect(geminiDraft([FULL, "> 메모", agent, FULL, BAR, ""].join("\n"))).toBeNull();
  });
});

describe("1.5.14 실측 화면: 승인 창(안내용 판독, 키를 보내지 않는다)", () => {
  test("명령·새 파일·고치기 창의 제목·물음·선택지·고른 줄·안내 줄", () => {
    expect(geminiApprovalDialog(real("approval-command"))).toEqual({ title: "Command", question: "Run this command?", options: ["Yes, run command", "Yes, and always allow in this conversation for commands that start with 'ls'", "Yes, and always allow for commands that start with 'ls' (Persist to settings.json)", "No, cancel"], selected: 0, hint: "↑/↓ Navigate · tab Amend · ctrl+g edit/expand command" });
    expect(geminiApprovalDialog(real("approval-create"))).toEqual({ title: "Create file", question: "Allow creation of this file?", options: ["Yes, allow creation", "No, deny creation"], selected: 0, hint: "↑/↓ Navigate · f full diff" });
    expect(geminiApprovalDialog(real("approval-edit-reject-selected"))).toEqual({ title: "Pending edit", question: "Accept this file edit?", options: ["Yes, accept this change", "No, reject this change"], selected: 1, hint: "↑/↓ Navigate · tab Amend · f full diff" });
  });
  test("입력칸·메뉴·신뢰 창은 승인 창이 아니다", () => {
    for (const name of ["idle-default", "working-first", "slash-menu", "folder-trust", "declined"]) expect([name, geminiApprovalDialog(real(name))]).toEqual([name, null]);
  });
});

describe("1.5.14 실측: 폴더 신뢰 창은 대표가 볼 창이다(멈춤 키를 보내지 않는다)", () => {
  const trust = { state: "blocked", kind: "permission", msg: "Trust this folder?" };
  test("OSC 는 도구 승인과 같은 blocked·permission 이지만 글로 가린다(풀린 글·base64 둘 다)", () => {
    expect(geminiFolderTrust(trust)).toBe(true);
    expect(geminiFolderTrust({ ...trust, msg: Buffer.from("Trust this folder?").toString("base64") })).toBe(true);
    // 예전 판정은 permission 이면 멈춤 키를 보냈다: 그 Esc 가 이 창의 답(No, exit)이 될 수 있었다.
    expect(geminiTurnToStop(trust, false)).toBe(false);
    expect(geminiTurnToStop(trust, true)).toBe(false);
    expect(geminiTurnToStop({ ...trust, msg: Buffer.from("Trust this folder?").toString("base64") }, false)).toBe(false);
    // 도구 승인 창은 그대로 멈출 수 있다(Esc = 거절하고 턴을 끝낸다, 1.5.14 실측).
    expect(geminiTurnToStop({ state: "blocked", kind: "permission", msg: "Approve Bash: ls -la ." }, false)).toBe(true);
    expect(geminiFolderTrust({ state: "blocked", kind: "permission", msg: "Approve Bash: ls -la ." })).toBe(false);
    expect(geminiFolderTrust({ state: "idle", msg: "Trust this folder?" })).toBe(false);
  });
  test("보고 글이 다르거나 없어도 화면으로 알아본다(입력칸이 보이면 아니다)", () => {
    const screen = real("folder-trust");
    expect(geminiFolderTrust({ state: "blocked", kind: "permission", msg: "Confirm" }, screen)).toBe(true);
    expect(geminiFolderTrust(null, screen)).toBe(true);
    expect(geminiTurnToStop({ state: "blocked", kind: "permission" }, false, screen)).toBe(false);
    expect(geminiTurnToStop({ state: "blocked", kind: "permission" }, false, real("approval-command"))).toBe(true);
    expect(geminiFolderTrust({ state: "working" }, screen)).toBe(false);
    expect(geminiFolderTrust({ state: "blocked", kind: "permission" }, real("approval-command"))).toBe(false);
    // 대화에 신뢰 물음 글이 남아 있어도 입력칸이 보이면 창이 아니다.
    expect(geminiFolderTrust({ state: "blocked", kind: "permission" }, [BOX, "> Do you trust the contents of this project?", "", "Do you trust the contents of this project?", "> Yes, I trust this folder", "", FULL, ">", FULL, BAR, ""].join("\n"))).toBe(false);
    expect(trustDialogLike(screen, "gemini")).toBe(true);
  });
});


describe("1.5.14 실측: MCP 관리 창(/mcp) 판독(첫 전달 앞에 MCP 를 띄울 때 core.ts primeGeminiMcp 가 쓴다)", () => {
  const panel = (rows: string[], keys = "Keyboard: ↑/↓ Navigate  enter Actions  esc Exit") => [HISTORY, RULE, ">", RULE, "MCP Servers", "", "Plugins (~/.gemini/config/plugins)", ...rows, "", keys, "", OURS, ""].join("\n");
  test("실측 두 화면(목록·동작 줄 펼침): 열려 있고 ✓ iamceo 가 보인다. 그동안 입력칸으로는 읽지 않는다", () => {
    for (const name of ["mcp-panel-list", "mcp-panel-actions"]) {
      expect([name, geminiMcpPanel(real(name))]).toEqual([name, { open: true, ready: true }]);
      expect([name, geminiDraft(real(name))]).toEqual([name, null]);
    }
  });
  test("빈 입력칸·명령 메뉴·승인 창·일하는 중은 관리 창이 아니다", () => {
    for (const name of ["idle-default", "slash-menu", "approval-command", "srv-hook-wait", "working-first"]) expect([name, geminiMcpPanel(real(name))]).toEqual([name, { open: false, ready: false }]);
  });
  test("붙지 않은 서버(✓ 가 아님)·다른 서버만 붙음은 열렸지만 준비 안 됨. 지난 대화에 'MCP Servers' 글이 있어도 바닥 위 안내 줄이 없으면 닫힘", () => {
    expect(geminiMcpPanel(panel([">  ✗ iamceo  Failed to connect"]))).toEqual({ open: true, ready: false });
    expect(geminiMcpPanel(panel([">  ✓ github  Tools: create_issue", "   ○ iamceo  Connecting…"]))).toEqual({ open: true, ready: false });
    expect(geminiMcpPanel(panel(["   ✓ iamceo-other  Tools: x"]))).toEqual({ open: true, ready: false });
    expect(geminiMcpPanel(panel([">  ✓ iamceo  Tools: status, ask"], "Keyboard: ↑/↓ Navigate  ←/→ Action  enter Select  esc Cancel"))).toEqual({ open: true, ready: true });
    expect(geminiMcpPanel(composer([">"], [OURS], "MCP Servers\n✓ iamceo\nKeyboard: esc\n"))).toEqual({ open: false, ready: false });
    // 안내 줄이 있어도 그 위(가로줄까지)에 머리 줄이 없으면 아니다.
    expect(geminiMcpPanel([HISTORY, RULE, ">", RULE, "✓ iamceo", "Keyboard: esc Exit", OURS, ""].join("\n"))).toEqual({ open: false, ready: false });
  });
});
