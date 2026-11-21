// Claude 세션 기록 파일의 위치와 "세션이 없다"는 오류 판정. 실행기 종류와 무관하다.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { transcriptPath } from "./transcript.ts";

/** 세션 기록 위치. 세션 안에서 cd 하면 다른 폴더 아래에 기록된다. */
export function findSessionFile(claudeHome: string, cwd: string, sessionId: string): string | null {
  const direct = transcriptPath(cwd, sessionId, claudeHome);
  if (existsSync(direct)) return direct;
  const projects = join(claudeHome, "projects");
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* projects 폴더 없음 */ }
  return null;
}

export const defaultClaudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/**
 * 어느 실행기든 "세션 파일이 없어 이어갈 수 없다"는 오류인지.
 * Antigravity CLI(agy 1.5.14)는 없는 id 로 이어 열어도 오류로 끝나지 않는다: `warning: conversation "<id>" not found` 를 찍고 새 대화를 연다.
 * 그 경고는 여기서 잡지 않는다(끝난 CLI 의 오류가 아니다). 새 대화가 된 것은 CoreRunner 가 상태줄 기록의 대화 id 로 알아낸다.
 */
export function isMissingSessionError(text: string | null | undefined): boolean {
  return !!text && /no conversation found|session .*(not found|does not exist)/i.test(text);
}
