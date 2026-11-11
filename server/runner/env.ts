// CLI 자식 프로세스에 넘기는 환경. 실행기 종류와 무관하다.

// 뒤쪽 변수들은 서버를 Claude Code 안에서 띄웠을 때 바깥 세션의 신원·설정이 새는 것을 막는다.
const STRIPPED_ENV = /^(HERDR_.*|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CODE_SESSION_.*|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_.*|CLAUDE_CODE_EXECPATH|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_EFFORT_LEVEL|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_SUBAGENT_MODEL_FORCE)$/;

/** 자식 환경. 지우지 않으면 자식 훅이 라이브 herdr 칸 상태를 오염시킨다(spec §0). */
export function childEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !STRIPPED_ENV.test(key)) env[key] = value;
  }
  return env;
}

/** 서브에이전트 모델을 강제하는 환경변수. 세션 모델과 따로 둔다. */
export function subagentEnv(model: string | null): Record<string, string> {
  return model ? { CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" } : {};
}
