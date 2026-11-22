// CLI 자식 프로세스에 넘기는 환경. 실행기 종류와 무관하다.
import { userInfo } from "node:os";

// 뒤쪽 변수들은 서버를 Claude Code 안에서 띄웠을 때 바깥 세션의 신원·설정이 새는 것을 막는다.
const STRIPPED_ENV = /^(HERDR_.*|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CODE_SESSION_.*|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_.*|CLAUDE_CODE_EXECPATH|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_EFFORT_LEVEL|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_SUBAGENT_MODEL_FORCE)$/;

/** 자식 환경. 지우지 않으면 자식 훅이 라이브 herdr 칸 상태를 오염시킨다(spec §0). */
export function childEnv(base: Record<string, string | undefined> = process.env, username: () => string = () => userInfo().username): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !STRIPPED_ENV.test(key)) env[key] = value;
  }
  // Claude Code 는 USER 로 키체인 계정을 정한다. USER 없이 뜨면 계정 "unknown" 으로 빈 로그인 항목을 새로 만들어
  // 같은 Mac 의 다른 도구가 그 빈 항목을 읽게 된다(2026-11-11 실측). 서버가 USER 없이 떴어도 CLI 에는 채워 준다.
  if (!env.USER) {
    try {
      const name = username();
      if (name) { env.USER = name; env.LOGNAME ||= name; }
    } catch { /* 사용자 이름을 알 수 없으면 그대로 둔다 */ }
  }
  return env;
}

/** 서브에이전트 모델을 강제하는 환경변수. 세션 모델과 따로 둔다. */
export function subagentEnv(model: string | null): Record<string, string> {
  return model ? { CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" } : {};
}

/**
 * Antigravity CLI(agy)가 원격(SSH) 세션으로 보는 환경 변수. 이 값이 있으면 agy 는 로그인 토큰을 키체인이 아닌 <geminiHome>/antigravity-oauth-token 파일에서
 * 읽고 쓴다(역분석: 실행 파일 글자 'Using file-based token storage because %s detected'). 서버를 SSH 세션에서 띄웠어도 agy 를 띄우는 곳마다 빼야
 * 폰 로그인(cli-login.ts)·팀장 터미널(core.ts)과 같은 키체인 계정을 읽는다. SSH_AUTH_SOCK(git 의 ssh 열쇠)은 여기 들지 않는다.
 */
export const GEMINI_REMOTE_ENV = ["SSH_CLIENT", "SSH_TTY", "SSH_CONNECTION"] as const;

/** base(기본은 서버 환경) 그대로에서 GEMINI_REMOTE_ENV 만 뺀 환경. 값이 없는 칸은 싣지 않는다. 나머지는 고치지 않는다(env -i 로 비우지 않는다). */
export function withoutGeminiRemote(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !(GEMINI_REMOTE_ENV as readonly string[]).includes(key)) env[key] = value;
  }
  return env;
}
