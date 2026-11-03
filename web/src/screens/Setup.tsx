// 첫 실행: 접속 코드 → 실행 방식 고르기. 어느 단계인지는 store 의 auth·bootstrap 이 정한다(App.tsx).
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Backend, HerdrInfo } from "@shared/types";
import { HERDR_INSTALL, herdrLine } from "../components/BackendChoice";
import { Badge, copyText } from "../components/ui";
import { Glass, GlassButton, LocalLight, glassClass } from "../glass";
import { api, errorText } from "../lib/api";
import { applyLocal, login, reconnectNow, refresh, useBootstrap, useStore } from "../lib/store";
import "../styles/setup.css";

function CodeStep() {
  const authError = useStore((s) => s.authError);
  const offline = useStore((s) => s.connection === "offline");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const ok = await login(code);
    setBusy(false);
    if (!ok) input.current?.select();
  };

  return (
    <Glass as="form" level="thick" tint className="su-panel su-code" onSubmit={submit}>
      <p className="su-brand">IAMCEO</p>
      <h1 className="su-title">접속 코드를 넣어 주세요</h1>
      <p className="su-lead">이 기기에 저장되어 다음부터는 묻지 않습니다.</p>
      <label className="field">
        <span className="sr-only">접속 코드</span>
        <input
          ref={input}
          className="input t-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="접속 코드"
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={authError ? true : undefined}
        />
      </label>
      {authError ? (
        <p className="form__error" role="alert">
          {authError}
          {offline ? ". 서버가 켜지면 자동으로 들어갑니다" : ""}
        </p>
      ) : null}
      <GlassButton variant="primary" size="l" type="submit" disabled={busy} className="su-submit">
        {busy ? "확인하는 중" : "들어가기"}
      </GlassButton>
      <p className="su-foot">
        코드는 서버 컴퓨터에서 <code className="t-code">iamceo open</code> 으로 확인합니다.
      </p>
    </Glass>
  );
}

function InstallGuide() {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const copy = async () => {
    setCopied(await copyText(HERDR_INSTALL));
    setTimeout(() => setCopied(false), 2000);
  };
  const recheck = async () => {
    setChecking(true);
    await refresh();
    setChecking(false);
  };
  return (
    <div className="su-install">
      <p>서버 컴퓨터에서 설치한 뒤 다시 확인하세요.</p>
      <code className="t-code su-install__cmd">{HERDR_INSTALL}</code>
      <div className="su-install__actions">
        <GlassButton variant="glass" size="m" onClick={copy}>
          {copied ? "복사했습니다" : "명령 복사"}
        </GlassButton>
        <GlassButton variant="ghost" size="m" onClick={recheck} disabled={checking}>
          {checking ? "확인하는 중" : "다시 확인"}
        </GlassButton>
      </div>
    </div>
  );
}

function BackendCard({
  value,
  chosen,
  onChoose,
  disabled,
  kicker,
  title,
  points,
  needs,
  badge,
  status,
  statusWarn,
  children,
}: {
  value: Backend;
  chosen: Backend;
  onChoose: (b: Backend) => void;
  disabled?: boolean;
  kicker: string;
  title: string;
  points: string[];
  needs: string;
  badge?: string;
  status?: string;
  statusWarn?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`${glassClass("regular", { tint: true })} su-card`} data-on={chosen === value ? "" : undefined} data-off={disabled ? "" : undefined}>
      <label className="su-card__pick">
        <input type="radio" name="su-backend" checked={chosen === value} disabled={disabled} onChange={() => onChoose(value)} />
        <span className="su-card__head">
          <i className="su-radio" aria-hidden="true" />
          <span className="su-card__kicker">{kicker}</span>
          {badge ? <Badge tone="accent">{badge}</Badge> : null}
        </span>
        <span className="su-card__title">{title}</span>
        {status ? <span className="su-card__status" data-tone={statusWarn ? "warn" : undefined}>{status}</span> : null}
        <ul className="su-card__points">
          {points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <span className="su-card__needs">필요한 것: {needs}</span>
      </label>
      {children}
    </div>
  );
}

const recommended = (h: HerdrInfo): boolean => h.installed && (!h.running || h.compatible);

function ChoiceStep({ herdr }: { herdr: HerdrInfo }) {
  const offline = useStore((s) => s.connection === "offline");
  const [picked, setPicked] = useState<Backend | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // herdr 를 설치하고 '다시 확인'하면 고른 적 없는 기본값도 따라 바뀐다
  const fallback: Backend = recommended(herdr) ? "herdr" : "headless";
  const chosen: Backend = picked === "herdr" && !herdr.installed ? "headless" : (picked ?? fallback);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const settings = await api.putSettings({ backend: chosen });
      applyLocal({ type: "settings", settings }); // 이 순간 App 이 Shell 로 넘어가므로 busy 를 되돌릴 필요가 없다
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="su-choice">
      <header className="su-choice__head">
        <p className="su-brand">IAMCEO</p>
        <h1 className="su-title">직원을 어떻게 돌릴까요?</h1>
        <p className="su-lead">화면·규칙·도구는 어느 쪽이든 같고, 나중에 설정에서 바꿀 수 있습니다.</p>
      </header>
      {offline ? (
        <div className="offline-band" role="status">
          <span>서버와 연결이 끊겼습니다. 다시 잇는 중입니다.</span>
          <button type="button" className="offline-band__retry" onClick={reconnectNow}>
            지금 다시 연결
          </button>
        </div>
      ) : null}
      <div className="su-cards" role="radiogroup" aria-label="실행 방식">
        <BackendCard
          value="herdr"
          chosen={chosen}
          onChoose={setPicked}
          disabled={!herdr.installed}
          kicker="herdr와 함께"
          title="직원 = herdr 칸"
          badge={recommended(herdr) ? "권장" : undefined}
          status={herdrLine(herdr)}
          statusWarn={!herdr.running || !herdr.compatible}
          points={["터미널을 보고 바로 칠 수 있다", "herdr가 일함·대기·승인 대기를 직접 감지", "일하는 중에도 칸에 바로 입력", "이미 돌고 있는 세션을 팀에 편입", "herdr의 폰 앱·세션 유지를 그대로 쓴다"]}
          needs="herdr 설치"
        >
          {!herdr.installed ? <InstallGuide /> : null}
          {herdr.installed && !herdr.running ? (
            <p className="su-hint su-card__note" data-tone="warn">
              herdr가 꺼져 있습니다. 직원을 띄우기 전에 켜 두세요.
            </p>
          ) : null}
          {herdr.warning ? (
            <p className="su-hint su-card__note" data-tone="warn">
              {herdr.warning}
            </p>
          ) : null}
        </BackendCard>
        <BackendCard
          value="headless"
          chosen={chosen}
          onChoose={setPicked}
          kicker="herdr 없이"
          title="직원 = 이어지는 세션"
          points={["입력이 오면 세션을 이어 턴 시작, 끝나면 대기", "턴의 시작·끝으로 상태 판단", "일하는 중에 보낸 말은 대기했다가 전달", "직원 화면에서 실시간 활동을 본다", "터미널로 만지려면 쉴 때 claude --resume"]}
          needs="AI CLI만"
        />
      </div>
      {error ? (
        <p className="form__error su-choice__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="su-choice__go">
        <GlassButton variant="primary" size="l" onClick={start} disabled={busy} className="su-submit">
          {busy ? "시작하는 중" : chosen === "herdr" ? "herdr와 함께 시작" : "herdr 없이 시작"}
        </GlassButton>
      </div>
    </div>
  );
}

export default function Setup() {
  const needCode = useStore((s) => s.auth === "need_code");
  const bootstrap = useBootstrap();
  return (
    <main className="su">
      <LocalLight tone="violet" x="50%" y="24%" size="min(1000px, 150%)" aspect={0.6} strength={0.42} />
      <LocalLight tone="orchid" x="72%" y="88%" size="min(800px, 120%)" aspect={0.6} strength={0.28} />
      <div className="su__scroll">{needCode || !bootstrap ? <CodeStep /> : <ChoiceStep herdr={bootstrap.herdr} />}</div>
    </main>
  );
}
