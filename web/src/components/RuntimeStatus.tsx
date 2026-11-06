import { useCallback, useEffect, useState } from "react";
import type { CliProvider, RuntimeInfo } from "@shared/types";
import { Glass, GlassButton } from "../glass";
import { api, errorText } from "../lib/api";
import { useBootstrap } from "../lib/store";

import { PROVIDERS, providerName } from "../lib/runtime";
export { providerName, runtimeBlock } from "../lib/runtime";

/** 초기 진단이 없어도 성공으로 가정하지 않는다. 재확인은 실제 실행기 진단을 다시 읽는다. */
export function useRuntime() {
  const bootstrap = useBootstrap();
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(bootstrap?.runtime ?? null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setRuntime(await api.runtime());
    } catch (e) {
      setRuntime(null);
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => { void recheck(); }, [recheck]);
  useEffect(() => {
    if (bootstrap?.runtime) setRuntime(bootstrap.runtime);
  }, [bootstrap?.runtime]);
  return { runtime, checking, error, recheck };
}

export function ProviderSelect({ value, onChange, runtime, disabled, label = "AI CLI" }: { value: CliProvider; onChange: (cli: CliProvider) => void; runtime: RuntimeInfo | null; disabled?: boolean; label?: string }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <select className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as CliProvider)}>
        {PROVIDERS.map((cli) => <option key={cli} value={cli}>{providerName(cli)}{runtime && !runtime.providers[cli]?.installed ? " · 설치 필요" : ""}</option>)}
      </select>
    </label>
  );
}

export function RuntimeDetails({ diagnostics }: { diagnostics: ReturnType<typeof useRuntime> }) {
  const { runtime, error, checking, recheck } = diagnostics;
  return (
    <Glass as="section" level="regular" tint className="st-panel" aria-label="실행 환경">
      <h2 className="st-panel__title">실행 환경</h2>
      <p className="su-hint">모든 AI 직원은 herdr-core에서 실행됩니다. 직원마다 Claude Code 또는 Codex를 고릅니다.</p>
      <dl className="st-facts">
        <div><dt>herdr-core</dt><dd>{runtime ? runtime.core.available ? `사용 가능${runtime.core.version ? ` · ${runtime.core.version}` : ""}` : runtime.core.installed ? "설치됨 · 사용할 수 없음" : "설치 필요" : "상태 확인 필요"}</dd></div>
        {PROVIDERS.map((cli) => <div key={cli}><dt>{providerName(cli)}</dt><dd>{runtime ? runtime.providers[cli]?.installed ? "CLI 설치됨 · 로그인은 실행 시 확인" : "CLI 설치 필요" : "확인 전"}</dd></div>)}
      </dl>
      {runtime?.core.detail ? <p className="su-hint" role="status">{runtime.core.detail}</p> : null}
      {!runtime?.core.available ? <p className="su-hint">서버 컴퓨터의 IAMCEO 저장소에서 <code className="t-code">bun run setup:core</code>로 실행 환경을 준비한 뒤 다시 확인하세요.</p> : null}
      {error ? <p className="form__error" role="alert">진단을 읽지 못했습니다. {error}</p> : null}
      <GlassButton variant="ghost" size="m" disabled={checking} onClick={() => void recheck()}>{checking ? "확인하는 중" : "다시 확인"}</GlassButton>
    </Glass>
  );
}

export default function RuntimeStatus() {
  const diagnostics = useRuntime();
  return <RuntimeDetails diagnostics={diagnostics} />;
}
