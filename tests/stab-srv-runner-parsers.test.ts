import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseTranscriptTail } from "../server/runner/transcript.ts";
import { codexBindingMarker, discoverCodexSession } from "../server/runner/core-context.ts";
import { inputLooksEmpty, inputText } from "../server/runner/herdr.ts";

const line = (value: unknown) => JSON.stringify(value);

describe("오류로 끝난 턴의 문맥 사용량", () => {
  const real = { type: "assistant", message: { id: "a1", model: "claude-opus", usage: { input_tokens: 10, cache_read_input_tokens: 800_000, cache_creation_input_tokens: 2_000 }, content: [{ type: "text", text: "작업 중" }] } };
  const prompt = { type: "user", message: { role: "user", content: "이어서" } };
  const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  test("API 오류 안내(<synthetic>)의 0 토큰은 직전 실제 응답의 사용량을 덮지 않는다", () => {
    const synthetic = { type: "assistant", isApiErrorMessage: true, message: { id: "s1", model: "<synthetic>", usage: zero, content: [{ type: "text", text: "API Error: The response stopped arriving" }] } };
    const tail = parseTranscriptTail([real, prompt, synthetic].map(line).join("\n"));
    expect(tail.contextTokens).toBe(802_010);
    expect(tail.model).toBe("claude-opus");
    expect(tail.finalText).toBe("API Error: The response stopped arriving");
  });
  test("모델 이름이 남아 있어도 오류 표시가 있으면 건너뛴다", () => {
    const flagged = { type: "assistant", isApiErrorMessage: true, message: { id: "s2", model: "claude-opus", usage: zero, content: [] } };
    expect(parseTranscriptTail([real, flagged].map(line).join("\n")).contextTokens).toBe(802_010);
  });
  test("실제 응답의 0 과 오류 안내만 있는 기록은 그대로 읽는다", () => {
    const fresh = { type: "assistant", message: { id: "a2", model: "claude-opus", usage: zero, content: [] } };
    expect(parseTranscriptTail([real, fresh].map(line).join("\n")).contextTokens).toBe(0);
    const synthetic = { type: "assistant", isApiErrorMessage: true, message: { id: "s1", model: "<synthetic>", usage: zero, content: [] } };
    expect(parseTranscriptTail(line(synthetic)).contextTokens).toBeNull();
  });
});

describe("Codex 세션 묶기와 시간대", () => {
  const nonce = "abcdefghijklmnopqrstuv";
  const dirs: string[] = [];
  const previous = process.env.TZ;
  afterEach(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function home() { const dir = mkdtempSync(join(tmpdir(), "iamceo-stab-codex-")); dirs.push(dir); return dir; }
  function rollout(root: string, name: string, rows: unknown[] | string) {
    const path = join(root, "sessions", "2026", "11", "07", name);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof rows === "string" ? rows : rows.map(line).join("\n") + "\n");
  }
  const user = { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: codexBindingMarker(nonce) }] } };
  // 세션은 09:00:05Z 에 시작했다. Codex 는 파일 이름에 그 기기의 현지 시각을 쓴다.
  const since = "2026-11-07T09:00:00Z", startedAt = "2026-11-07T09:00:05Z";
  test.each([
    ["America/Los_Angeles", "rollout-2026-11-07T01-00-05-native.jsonl"],
    ["America/New_York", "rollout-2026-11-07T04-00-05-native.jsonl"],
    ["Asia/Seoul", "rollout-2026-11-07T18-00-05-native.jsonl"],
    ["UTC", "rollout-2026-11-07T09-00-05-native.jsonl"],
  ])("%s: 현지 시각 이름의 진짜 파일을 걸러내지 않는다", (zone, name) => {
    process.env.TZ = zone;
    const root = home(), cwd = join(root, "work");
    rollout(root, name, [{ type: "session_meta", payload: { id: "native", cwd, timestamp: startedAt } }, user]);
    // 한참 전 형식의 파일은 여전히 이름만으로 제외해 읽지 않는다.
    rollout(root, "rollout-2025-01-01T00-00-00-old.jsonl", "{broken old format}\n");
    expect(discoverCodexSession({ home: root, cwd, generation: 1, nonce, since })).toMatchObject({ outcome: "bound", sessionId: "native" });
  });
  test("이름으로는 통과해도 시작 시각이 이른 세션은 메타데이터로 제외한다", () => {
    process.env.TZ = "America/Los_Angeles";
    const root = home(), cwd = join(root, "work");
    rollout(root, "rollout-2026-11-06T20-00-00-earlier.jsonl", [{ type: "session_meta", payload: { id: "earlier", cwd, timestamp: "2026-11-07T04:00:00Z" } }, user]);
    expect(discoverCodexSession({ home: root, cwd, generation: 1, nonce, since })).toMatchObject({ outcome: "pending", code: "session_unbound" });
  });
});

describe("Claude Code 빈 입력칸 안내 문구(글자만 있는 화면)", () => {
  const box = (...rows: string[]) => `${"─".repeat(40)}\n❯ ${rows[0]}\n${rows.slice(1).map(row => `  ${row}\n`).join("")}${"─".repeat(40)}\n`;
  test.each([
    "Press up to edit queued messages",
    "Press up to edit queued messages, Enter to send them immediately",
    "Press up to select a queued message to edit, or Enter to send them now",
    "Press up to select a queued message, then Enter to edit it",
    'Try "fix lint errors"',
  ])("안내 문구 '%s' 는 쓰던 글이 아니다", (hint) => {
    expect(inputText(box(hint))).toBe("");
  });
  test("좁은 칸에서 두 줄로 접힌 안내 문구도 빈 칸이다", () => {
    expect(inputText(box("Press up to select a queued message to edit,", "or Enter to send them now"))).toBe("");
    expect(inputText(box('Try "refactor the delivery', 'recovery module"'))).toBe("");
  });
  test("안내 문구에 글이 붙었거나, 사람이 대기열을 고르는 중이면 비지 않았다", () => {
    expect(inputLooksEmpty(box("Press up to edit queued messages, Enter to send them immediately 그리고 이것도"))).toBe(false);
    expect(inputLooksEmpty(box("Press up to edit queued messages", "이어서 쓴 글"))).toBe(false);
    expect(inputLooksEmpty(box("Press Enter to edit the selected message, or up again for an older one"))).toBe(false);
    expect(inputLooksEmpty(box('Try "edit foo" 해줘'))).toBe(false);
    expect(inputText(box("Press up to edit queued messages", "이어서 쓴 글"))).toBe("이어서 쓴 글");
  });
});
