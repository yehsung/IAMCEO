// 접속 코드는 이 기기에만 저장한다. 실행 상태는 설정·팀 화면에서 확인한다.
import { useRef, useState, type FormEvent } from "react";
import { Glass, GlassButton, LocalLight } from "../glass";
import { login, useStore } from "../lib/store";
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

export default function Setup() {
  return (
    <main className="su">
      <LocalLight tone="violet" x="50%" y="24%" size="min(1000px, 150%)" aspect={0.6} strength={0.42} />
      <LocalLight tone="orchid" x="72%" y="88%" size="min(800px, 120%)" aspect={0.6} strength={0.28} />
      <div className="su__scroll"><CodeStep /></div>
    </main>
  );
}
