// 새 프로젝트: 데스크톱은 가운데 판, 폰은 아래 시트. 안쪽 양식은 열릴 때마다 새로 그려져 값이 남지 않는다.
import { useState, type FormEvent } from "react";
import type { Project } from "@shared/types";
import { GlassButton } from "../glass";
import { api, errorText } from "../lib/api";
import { navigate, useBootstrap } from "../lib/store";
import { MQ_DESKTOP, Modal, Sheet, useMediaQuery } from "./ui";

function NewProjectForm({ onClose }: { onClose: () => void }) {
  const bootstrap = useBootstrap();
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 총괄만 못 띄운 경우: 다시 눌러도 프로젝트가 또 생기면 안 된다
  const [created, setCreated] = useState<Project | null>(null);
  if (!bootstrap) return null;

  const finish = (p: Project) => {
    onClose();
    navigate({ projectId: p.id, tab: "team" });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim() || !cwd.trim()) {
      setError("이름과 폴더를 넣어 주세요");
      return;
    }
    setBusy(true);
    setError(null);
    let project = created;
    try {
      project ??= await api.createProject({ name: name.trim(), cwd: cwd.trim() });
      setCreated(project);
      if (startNow) await api.startConductor(project.id);
      finish(project);
    } catch (err) {
      setError(project ? `프로젝트는 만들었지만 총괄을 띄우지 못했습니다. ${errorText(err)}` : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const idleLabel = created ? "다시 시도" : "만들기";
  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        <span className="field__label">이름</span>
        <input className="input" value={name} disabled={!!created} onChange={(e) => setName(e.target.value)} placeholder="랜딩 리뉴얼" data-autofocus="" />
      </label>
      <label className="field">
        <span className="field__label">폴더</span>
        <input
          className="input t-code"
          value={cwd}
          disabled={!!created}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="~/code/landing"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <span className="su-hint">서버 컴퓨터에 이미 있는 폴더</span>
      </label>
      <label className="su-check">
        <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
        <span>
          총괄 바로 시작
          <small>{startNow ? "만들자마자 총괄이 일할 준비를 합니다" : "첫 말을 보내면 그때 총괄이 뜹니다"}</small>
        </span>
      </label>
      {error ? (
        <p className="form__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form__actions">
        <GlassButton variant="ghost" size="m" onClick={created ? () => finish(created) : onClose}>
          {created ? "프로젝트로 가기" : "취소"}
        </GlassButton>
        <GlassButton variant="primary" size="m" type="submit" disabled={busy}>
          {busy ? "만드는 중" : idleLabel}
        </GlassButton>
      </div>
    </form>
  );
}

export default function NewProject({ open, onClose }: { open: boolean; onClose: () => void }) {
  const Panel = useMediaQuery(MQ_DESKTOP) ? Modal : Sheet;
  return (
    <Panel open={open} onClose={onClose} title="새 프로젝트">
      <NewProjectForm onClose={onClose} />
    </Panel>
  );
}
