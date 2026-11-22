// Antigravity CLI(`agy`)의 대화 기록(transcript.jsonl) 읽기: 압축 경계, 마지막 모델 호출의 프롬프트 크기.
//
// 근거(조사 parity/compact, 실제 agy 1.5.14 헤드리스 14회):
// - 대화마다 <gemini 홈>/brain/<대화 id>/.system_generated/logs/transcript.jsonl 에 단계마다 한 줄씩 덧붙인다(같은 inode, 줄을 지우거나 바꾸지 않는다).
//   줄: { step_index, source: "USER_EXPLICIT"|"MODEL"|"SYSTEM", type: "USER_INPUT"|"PLANNER_RESPONSE"|"SYSTEM_MESSAGE"|"CHECKPOINT"|"ERROR_MESSAGE"|…,
//   status: "DONE", created_at, model?, input_tokens?, cache_read_tokens?, output_tokens?, content? }.
// - 맨 `/compact`(또는 agy 스스로의 압축)가 끝나면 `{ type: "CHECKPOINT", source: "SYSTEM", status: "DONE", content: "# Resuming from a compaction\n\n…" }` 줄이 생긴다.
// - 모델 호출(source MODEL)의 input_tokens + cache_read_tokens 가 그 호출의 프롬프트 크기다(실측: 압축 전 35,797 → 압축 뒤 12,984).
//   result.usage·상태줄의 total_* 는 대화 전체 누적이라 압축 뒤에도 줄지 않는다(그래서 문맥 크기는 이 줄로 잰다).
// 이 경로와 줄 모양은 공개 문서가 아니라 agy 자기 프롬프트·체크포인트 본문에 적힌 것이다. 판이 바뀌어 못 찾으면 '모름'으로 닫힌다(fail closed).
// 1.5.14 대화형 실측(agy-real, 견본 tests/fixtures/cli/gemini/1.5.14/transcript-compact.jsonl): 한 대화형 프로세스가 20분 넘게 도는 동안 같은 파일에 단계마다
// 이어 붙었고(step_index 가 압축 뒤에도 이어진다), 맨 /compact 는 USER_INPUT('<USER_REQUEST>\n/compact\n</USER_REQUEST>…') 뒤에 CHECKPOINT 줄을 남겼다.
// transcript_full.jsonl 도 내용이 같다. 상태줄의 transcript_path 는 없는 경로라 쓰지 않는다(gemini-status.ts).
// UNVERIFIED-INTERACTIVE: 그 줄이 OSC done 보고보다 먼저 쓰이는지(같은 inode 로 곧바로 덧붙는지)는 따로 재지 않았다(압축 끝은 쉬는 중 + CHECKPOINT 를 함께 본다).
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { providerLogPath } from "./delivery-evidence.ts";

export const GEMINI_CHECKPOINT_HEAD = "# Resuming from a compaction";
const CONVERSATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const TAIL_BYTES = 1024 * 1024;

/** 대화 기록들이 들어 있어야 하는 폴더(<gemini 홈>/brain). 경로 검사(providerLogPath)의 뿌리다. */
export function geminiTranscriptRoot(geminiHome: string): string { return join(geminiHome, "brain"); }

/** 그 대화의 기록 파일 경로. 대화 id 모양이 다르면 null. 파일이 있는지는 보지 않는다. */
export function geminiTranscriptPath(geminiHome: string, conversationId: string | null | undefined): string | null {
  if (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId)) return null;
  return join(geminiTranscriptRoot(geminiHome), conversationId, ".system_generated", "logs", "transcript.jsonl");
}

/** 압축이 끝났다는 줄인가(CHECKPOINT · SYSTEM · DONE · 머리말). */
export function isGeminiCheckpoint(entry: Record<string, unknown> | null): boolean {
  return !!entry && entry.type === "CHECKPOINT" && entry.source === "SYSTEM" && entry.status === "DONE" && typeof entry.content === "string" && entry.content.startsWith(GEMINI_CHECKPOINT_HEAD);
}

const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * 기록 파일 끝부분(최대 1 MiB)의 온전한 줄들(앞에서부터). 기록 뿌리 밖·링크·보통 파일이 아니면 null. 끝의 반쯤 쓴 줄은 버린다.
 */
function tailEntries(geminiHome: string, conversationId: string): Record<string, unknown>[] | null {
  const root = geminiTranscriptRoot(geminiHome), path = geminiTranscriptPath(geminiHome, conversationId);
  const target = path ? providerLogPath(root, path) : null;
  if (!target) return null;
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, TAIL_BYTES), start = stat.size - length;
    const bytes = Buffer.alloc(length);
    if (readSync(fd, bytes, 0, length, start) !== length) return null;
    const lines = bytes.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // 앞의 잘린 줄
    lines.pop(); // 끝(줄바꿈 뒤 빈 글 또는 반쯤 쓴 줄)
    const out: Record<string, unknown>[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
      } catch { /* 깨진 줄은 건너뛴다 */ }
    }
    return out;
  } catch { return null; } finally { try { closeSync(fd); } catch { /* 이미 닫혔다 */ } }
}

/**
 * 마지막 모델 호출(source MODEL, 토큰 칸이 있는 줄)의 프롬프트 크기(input_tokens + cache_read_tokens)와 모델 이름. 그 뒤에 압축(CHECKPOINT)이 있었으면
 * 압축 뒤 아직 모델을 부르지 않은 것이라 null 이다(압축 전 크기를 지금 크기로 적지 않는다). 기록이 없거나 그런 줄이 없으면 null.
 */
export function geminiPromptTokens(geminiHome: string, conversationId: string): { tokens: number; model: string | null; at: string | null } | null {
  const entries = tailEntries(geminiHome, conversationId);
  if (!entries) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (isGeminiCheckpoint(entry)) return null;
    if (entry.source !== "MODEL") continue;
    const input = count(entry.input_tokens), cached = count(entry.cache_read_tokens);
    if (input === null) continue;
    return { tokens: input + (cached ?? 0), model: typeof entry.model === "string" && entry.model.length <= 200 ? entry.model : null, at: typeof entry.created_at === "string" ? entry.created_at : null };
  }
  return null;
}

/** 이 대화에 모델의 답(source MODEL)이 하나라도 있는가(끝부분 1 MiB 안). 기록을 읽지 못하면 null. 답이 없는 대화에 맨 /compact 를 넣지 않는다. */
export function geminiHasModelResponse(geminiHome: string, conversationId: string): boolean | null {
  const entries = tailEntries(geminiHome, conversationId);
  if (!entries) return null;
  return entries.some(entry => entry.source === "MODEL" || isGeminiCheckpoint(entry));
}
