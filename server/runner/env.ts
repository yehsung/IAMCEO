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
