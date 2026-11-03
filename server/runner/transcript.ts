import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TranscriptTail {
  /** 마지막 사용자 입력 뒤 주 세션의 마지막 글. 없으면 빈 글. */
  finalText: string;
  /** 입력+캐시 토큰. 현재 문맥 크기. */
  contextTokens: number | null;
  model: string | null;
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

/** 조각난 줄·모르는 종류를 건너뛴다. 한 API 응답이 블록마다 다른 줄로 나뉘어 있어 message.id 로 잇는다. */
export function parseTranscriptTail(text: string): TranscriptTail {
  const tail: TranscriptTail = { finalText: "", contextTokens: null, model: null };
  let turnTexts: { messageId: string | null; text: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (isRealPrompt(entry)) {
      turnTexts = [];
      continue;
    }
    if (entry.type !== "assistant" || entry.isSidechain) continue;
    const message = entry.message;
    if (!message) continue;
    if (typeof message.model === "string" && message.model !== "<synthetic>") tail.model = message.model;
    const usage = message.usage;
    if (usage) {
      tail.contextTokens = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
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
