import type { CliProvider, RuntimeInfo } from "@shared/types";

export const PROVIDERS: readonly CliProvider[] = ["claude", "codex"];
export const providerName = (cli: CliProvider) => cli === "codex" ? "Codex" : "Claude Code";

/** 설치 여부만으로 실행 성공을 가정하지 않는다. 인증·세션 시작은 서버 응답으로 확인한다. */
export function runtimeBlock(runtime: RuntimeInfo | null, cli?: CliProvider): string | null {
  if (!runtime) return "실행 상태를 확인해야 시작할 수 있습니다.";
  if (!runtime.core.available) return runtime.core.detail || "herdr-core를 사용할 수 없습니다. 서버 컴퓨터에서 실행 환경을 준비하세요.";
  if (cli && !runtime.providers[cli]?.installed) return `${providerName(cli)} CLI가 설치되어 있지 않습니다. 서버 컴퓨터에서 설치하고 로그인한 뒤 다시 확인하세요.`;
  return null;
}
