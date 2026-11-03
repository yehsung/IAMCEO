// 실행 방식 두 칸(설정 화면). herdr 가 없으면 '함께' 칸을 막는다.
import type { Backend, HerdrInfo } from "@shared/types";
import "../styles/setup.css";

export const HERDR_INSTALL = "brew install herdr";

/** herdr 감지 결과 한 줄. */
export function herdrLine(h: HerdrInfo): string {
  if (!h.installed) return "설치되어 있지 않습니다";
  const version = h.version ? `herdr ${h.version}` : "herdr";
  return h.running ? `${version} 실행 중` : `${version} 설치됨 · 꺼져 있음`;
}

/** 저장된 기본값이 herdr 여도 지금 없으면 고를 수 없다. */
export function usableBackend(wanted: Backend | null, h: HerdrInfo): Backend {
  return wanted === "herdr" && h.installed ? "herdr" : "headless";
}

export function BackendChoice({ name, value, herdr, onChange }: { name: string; value: Backend; herdr: HerdrInfo; onChange: (b: Backend) => void }) {
  return (
    <>
      <div className="choice-row">
        <label className="choice" data-on={value === "herdr" ? "" : undefined} data-off={herdr.installed ? undefined : ""}>
          <input type="radio" name={name} checked={value === "herdr"} disabled={!herdr.installed} onChange={() => onChange("herdr")} />
          <span>herdr와 함께</span>
          <small>{herdrLine(herdr)}</small>
        </label>
        <label className="choice" data-on={value === "headless" ? "" : undefined}>
          <input type="radio" name={name} checked={value === "headless"} onChange={() => onChange("headless")} />
          <span>herdr 없이</span>
          <small>서버가 세션을 이어 가며 돌립니다</small>
        </label>
      </div>
      {!herdr.installed ? (
        <p className="su-hint">
          herdr를 쓰려면 서버 컴퓨터에서 <code className="t-code">{HERDR_INSTALL}</code> 을 실행하세요.
        </p>
      ) : value === "herdr" && !herdr.running ? (
        <p className="su-hint" data-tone="warn">
          herdr가 꺼져 있습니다. 직원을 띄우기 전에 켜 두세요.
        </p>
      ) : null}
      {value === "herdr" && herdr.warning ? (
        <p className="su-hint" data-tone="warn">
          {herdr.warning}
        </p>
      ) : null}
    </>
  );
}
