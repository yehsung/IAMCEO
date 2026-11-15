import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TranscriptTail {
  /** 마지막 사용자 입력 뒤 주 세션의 마지막 글. 없으면 빈 글. */
  finalText: string;
  /**
   * 입력+캐시 토큰. 현재 문맥 크기. 마지막 응답 뒤에 압축 경계가 있으면 그 압축 뒤 크기(compactMetadata.postTokens, 없으면 null)다:
   * 마지막 응답의 사용량은 압축 전 크기라 그대로 쓰면 문맥 % 가 부풀었다(2026-11-16 라이브: Claude 팀장 41명 중 15명).
   */
  contextTokens: number | null;
  model: string | null;
  /** 마지막 응답 뒤에 압축 경계가 있다(CLI 가 압축했다). 그 뒤 상태줄·화면의 % 는 압축 전 값일 수 있다. */
  compactedAfterUsage?: boolean;
  /**
   * 꼬리의 마지막 일이 CLI 스스로의 쉬는 동안 압축이다: 턴 끝(stop_hook_summary·turn_duration) 뒤에 새 입력·응답 없이 자동 압축 경계
   * (trigger auto)가 왔다('Compacted while idle'). 꼬리가 그 앞 턴 끝까지 닿지 않으면 false 다.
   */
  idleCompaction?: boolean;
}

const DEFAULT_TAIL_BYTES = 1024 * 1024;

export function transcriptPath(cwd: string, sessionId: string, claudeHome = join(homedir(), ".claude")): string {
  return join(claudeHome, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/** jsonl 에는 창 크기가 없어 호출자가 안다면 넘긴다. */
export function contextPct(tokens: number, contextWindow = 200_000): number {
  return Math.min(100, Math.round((tokens / contextWindow) * 100));
}

function isRealPrompt(entry: Record<string, any>): boolean {
  if (entry.type !== "user" || entry.isSidechain || entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some((c) => c?.type === "text");
}

/** 모델 턴을 여는 받은 글(로컬 명령·압축 요약·메타 줄이 아님). 쉬는 동안 압축을 가를 때만 쓴다. */
function opensTurn(entry: Record<string, any>): boolean {
  if (entry.type !== "user" || entry.isSidechain || entry.isMeta || entry.isCompactSummary) return false;
  const content = entry.message?.content;
  const local = (text: string) => /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/.test(text);
  if (typeof content === "string") return !local(content);
  return Array.isArray(content) && content.some((c) => c?.type === "tool_result" || (c?.type === "text" && typeof c.text === "string" && !local(c.text)));
}

/** 조각난 줄·모르는 종류를 건너뛴다. 한 API 응답이 블록마다 다른 줄로 나뉘어 있어 message.id 로 잇는다. */
export function parseTranscriptTail(text: string): TranscriptTail {
  const tail: TranscriptTail = { finalText: "", contextTokens: null, model: null };
  let turnTexts: { messageId: string | null; text: string }[] = [];
  // 마지막 응답 뒤의 압축 경계. 응답이 다시 오면 지난 일이다.
  let compaction: { postTokens: number | null } | null = null;
  // 쉬는 동안 압축 가르기: 턴 끝 → (턴이 아닌 줄) → 자동 압축 경계 → (턴이 아닌 줄) 로 끝나면 idle 이다. 꼬리 첫머리는 모른다.
  let phase: "unknown" | "turn" | "ended" | "idle" | "other" = "unknown";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (!entry.isSidechain) {
      if (entry.type === "system" && (entry.subtype === "stop_hook_summary" || entry.subtype === "turn_duration")) phase = phase === "idle" ? "idle" : "ended";
      else if (entry.type === "system" && entry.subtype === "compact_boundary") {
        const meta = entry.compactMetadata;
        const post = Number(meta?.postTokens);
        compaction = { postTokens: Number.isSafeInteger(post) && post >= 0 ? post : null };
        phase = phase === "ended" && meta?.trigger === "auto" ? "idle" : "other";
      } else if (entry.type === "assistant" || (entry.type === "queue-operation" && entry.operation === "dequeue") || opensTurn(entry)) phase = "turn";
    }
    if (isRealPrompt(entry)) {
      turnTexts = [];
      continue;
    }
    if (entry.type !== "assistant" || entry.isSidechain) continue;
    const message = entry.message;
    if (!message) continue;
    if (typeof message.model === "string" && message.model !== "<synthetic>") tail.model = message.model;
    const usage = message.usage;
    // API 오류·한도 안내 같은 가짜 응답(<synthetic>)의 usage 는 전부 0 이다. 직전 실제 응답의 값을 지킨다.
    if (usage && message.model !== "<synthetic>" && entry.isApiErrorMessage !== true) {
      tail.contextTokens = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
      compaction = null;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "text" && block.text) turnTexts.push({ messageId: message.id ?? null, text: block.text });
    }
  }
  const last = turnTexts.at(-1);
  if (last) {
    tail.finalText = last.messageId === null ? last.text : turnTexts.filter((t) => t.messageId === last.messageId).map((t) => t.text).join("\n");
  }
  if (compaction) { tail.compactedAfterUsage = true; tail.contextTokens = compaction.postTokens; }
  if (phase === "idle") tail.idleCompaction = true;
  return tail;
}

/** 파일이 없거나 못 읽으면 null. 세션 파일은 수백 MB 일 수 있어 꼬리만 읽는다. */
export function readTranscriptTail(path: string, maxBytes = DEFAULT_TAIL_BYTES): TranscriptTail | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return parseTranscriptTail(buffer.toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
