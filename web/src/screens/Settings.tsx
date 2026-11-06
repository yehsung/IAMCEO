// 설정: 전체 설정 하나다(#/settings). 고친 칸만 초안에 두고 나머지는 서버 값을 그대로 보여 준다(다른 기기에서 바꿔도 맞게).
// 권한·직급·숫자·맥 알림은 아래 저장 띠 하나로 함께 저장한다. 프로젝트는 줄마다 따로 고친다.
import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { EFFORTS } from "@shared/types";
import type { Bootstrap, Effort, PermissionMode, Project, ProjectSummary, Rank, Settings as SettingsT, SettingsPatch } from "@shared/types";
import RuntimeStatus from "../components/RuntimeStatus";
import { Badge, Modal } from "../components/ui";
import { Glass, GlassButton } from "../glass";
import { api, errorText } from "../lib/api";
import { HQ_ID, applyLocal, logout, refresh, routeHash, savedDraftCount, useBootstrap, useRoute, useStore, useSummary } from "../lib/store";
import "../styles/setup.css";

const PERMISSIONS: { mode: PermissionMode; label: string; desc: string; badge?: string }[] = [
  { mode: "bypassPermissions", label: "바이패스", badge: "기본", desc: "직원이 승인 없이 명령을 실행합니다" },
  { mode: "auto", label: "오토", desc: "위험해 보이는 작업만 멈춥니다" },
  { mode: "default", label: "모두 승인", desc: "도구를 쓸 때마다 승인을 기다립니다" },
];

const RANKS: { rank: Rank; label: string; scope: string }[] = [
  { rank: "manager", label: "부장", scope: "총괄·본사 AI" },
  { rank: "lead", label: "팀장", scope: "직원 세션" },
  { rank: "staff", label: "직원", scope: "서브에이전트" },
];
const MODELS = ["fable", "opus", "sonnet", "haiku"];
const CUSTOM = "custom";

type NumberKey = "maxConcurrentTurns" | "compactAtPct" | "maxAwakeWorkers";
const NUMBERS: { key: NumberKey; label: string; unit: string; min: number; max: number; hint: string }[] = [
  { key: "maxConcurrentTurns", label: "동시 턴", unit: "개", min: 1, max: 64, hint: "넘치면 차례를 기다립니다" },
  { key: "compactAtPct", label: "압축 기준", unit: "%", min: 1, max: 100, hint: "문맥 표시 기준입니다. core 자동 압축은 지원하지 않으며 터미널에서 /compact를 사용합니다" },
  { key: "maxAwakeWorkers", label: "직원 상한", unit: "명", min: 1, max: 256, hint: "넘으면 총괄에게 잠재울 후보를 알립니다" },
];

/** 판 정리 주기(시간). 0 은 끔. */
const TIDY_CHOICES: { hours: number; label: string }[] = [
  { hours: 0, label: "끔" },
  { hours: 3, label: "3시간" },
  { hours: 6, label: "6시간" },
  { hours: 12, label: "12시간" },
  { hours: 24, label: "매일" },
];

/** custom: '직접 입력'을 골랐다. 아직 글을 넣지 않았어도 칸이 닫히지 않게 따로 기억한다. */
interface RankDraft {
  model?: string | null;
  custom?: boolean;
  effort?: Effort | null;
}
interface Draft {
  permissionMode?: PermissionMode;
  notifyMac?: boolean;
  boardTidyHours?: number;
  numbers: Partial<Record<NumberKey, string>>;
  ranks: Partial<Record<Rank, RankDraft>>;
}
const EMPTY_DRAFT: Draft = { numbers: {}, ranks: {} };

const shownModel = (s: SettingsT, d: Draft, r: Rank): string | null => {
  const m = d.ranks[r]?.model;
  return m !== undefined ? m : s.ranks[r].model;
};
const shownEffort = (s: SettingsT, d: Draft, r: Rank): Effort | null => {
  const e = d.ranks[r]?.effort;
  return e !== undefined ? e : s.ranks[r].effort;
};
const isCustom = (s: SettingsT, d: Draft, r: Rank): boolean => {
  const model = shownModel(s, d, r);
  return d.ranks[r]?.custom ?? (model !== null && !MODELS.includes(model));
};
const numberText = (s: SettingsT, d: Draft, k: NumberKey): string => d.numbers[k] ?? String(s[k]);

/** 서버 값과 달라진 칸만 모은다. 비었으면 고친 것이 없다. 값이 잘못되었으면 error. */
function buildPatch(s: SettingsT, d: Draft): { patch: SettingsPatch; error: string | null } {
  const patch: SettingsPatch = {};
  let error: string | null = null;
  if (d.permissionMode !== undefined && d.permissionMode !== s.permissionMode) patch.permissionMode = d.permissionMode;
  if (d.notifyMac !== undefined && d.notifyMac !== s.notifyMac) patch.notifyMac = d.notifyMac;
  if (d.boardTidyHours !== undefined && d.boardTidyHours !== s.boardTidyHours) patch.boardTidyHours = d.boardTidyHours;
  for (const n of NUMBERS) {
    const text = numberText(s, d, n.key).trim();
    const v = Number(text);
    if (text === "" || !Number.isInteger(v) || v < n.min || v > n.max) error ??= `${n.label}은 ${n.min}부터 ${n.max}까지의 정수입니다`;
    else if (v !== s[n.key]) patch[n.key] = v;
  }
  for (const { rank, label } of RANKS) {
    const model = shownModel(s, d, rank)?.trim() ?? null;
    const effort = shownEffort(s, d, rank);
    if (isCustom(s, d, rank) && !model) error ??= `${label} 모델 이름을 넣어 주세요`;
    const change: { model?: string | null; effort?: Effort | null } = {};
    if ((model || null) !== s.ranks[rank].model) change.model = model || null;
    if (effort !== s.ranks[rank].effort) change.effort = effort;
    if (Object.keys(change).length > 0) patch.ranks = { ...patch.ranks, [rank]: change };
  }
  return { patch, error };
}

function PermissionChoices({ value, onChange }: { value: PermissionMode; onChange: (mode: PermissionMode) => void }) {
  return (
    <div className="st-perms" role="radiogroup" aria-labelledby="st-permission">
      {PERMISSIONS.map((p) => (
        <label key={p.mode} className="choice st-perm" data-on={value === p.mode ? "" : undefined}>
          <input type="radio" name="st-default-permission" checked={value === p.mode} onChange={() => onChange(p.mode)} />
          <span className="st-perm__name">
            {p.label}
            {p.badge ? <Badge>{p.badge}</Badge> : null}
          </span>
          <small>{p.desc}</small>
        </label>
      ))}
    </div>
  );
}

function RankTable({ settings, overrides, draft, edit, onEnter }: { settings: SettingsT; overrides: Bootstrap["rankOverrides"]; draft: Draft; edit: (rank: Rank, patch: RankDraft) => void; onEnter: (e: KeyboardEvent) => void }) {
  return (
    <table className="st-ranks">
      <thead>
        <tr>
          <th scope="col">직급</th>
          <th scope="col">모델</th>
          <th scope="col">effort</th>
        </tr>
      </thead>
      <tbody>
        {RANKS.map(({ rank, label, scope }) => {
          const model = shownModel(settings, draft, rank);
          const custom = isCustom(settings, draft, rank);
          return (
            <tr key={rank} data-rank={rank}>
              <th scope="row">
                <span className="st-rank__who">
                  {label}
                  <small>{scope}</small>
                  {rank !== "staff" && overrides?.[rank] ? <small>직원별 지정 {overrides[rank]}명</small> : null}
                </span>
              </th>
              <td data-custom={custom ? "" : undefined}>
                <div className="st-rank__cell">
                  <span className="st-rank__cap" aria-hidden="true">모델</span>
                  <select
                    className="input st-select"
                    aria-label={`${label} 모델`}
                    value={custom ? CUSTOM : (model ?? "")}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === CUSTOM) edit(rank, { model: "", custom: true });
                      else edit(rank, { model: v || null, custom: false });
                    }}
                  >
                    <option value="">CLI 기본</option>
                    {MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    <option value={CUSTOM}>직접 입력</option>
                  </select>
                  {custom ? (
                    <input
                      className="input t-code"
                      aria-label={`${label} 모델 이름`}
                      value={model ?? ""}
                      placeholder="모델 이름"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => edit(rank, { model: e.target.value, custom: true })}
                      onKeyDown={onEnter}
                    />
                  ) : null}
                </div>
              </td>
              <td>
                <div className="st-rank__cell">
                  <span className="st-rank__cap" aria-hidden="true">effort</span>
                  <select
                    className="input st-select"
                    aria-label={`${label} effort`}
                    value={shownEffort(settings, draft, rank) ?? "high"}
                    onChange={(e) => edit(rank, { effort: e.target.value as Effort })}
                  >
                    {EFFORTS.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ProjectEdit({ project, onDone }: { project: ProjectSummary; onDone: () => void }) {
  const [name, setName] = useState(project.name);
  const [cwd, setCwd] = useState(project.cwd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim() || !cwd.trim()) {
      setError("이름과 폴더를 넣어 주세요");
      return;
    }
    const patch = { ...(name.trim() !== project.name ? { name: name.trim() } : {}), ...(cwd.trim() !== project.cwd ? { cwd: cwd.trim() } : {}) };
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      applyLocal({ type: "project", project: await api.patchProject(project.id, patch) });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form className="st-pj__form" onSubmit={submit}>
      <label className="field">
        <span className="field__label">이름</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">폴더</span>
        <input className="input t-code" value={cwd} onChange={(e) => setCwd(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <span className="su-hint">새로 뜨는 직원부터 적용됩니다</span>
      </label>
      {error ? (
        <p className="form__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form__actions">
        <GlassButton variant="ghost" size="m" onClick={onDone}>
          취소
        </GlassButton>
        <GlassButton variant="glass" size="m" type="submit" disabled={busy}>
          {busy ? "저장하는 중" : "저장"}
        </GlassButton>
      </div>
    </form>
  );
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archive = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patchProject(project.id, { archived: true });
      setAsking(false);
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (editing) {
    return (
      <li className="st-pj" data-project={project.id}>
        <ProjectEdit project={project} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="st-pj" data-project={project.id}>
      <div className="st-pj__main">
        <span className="st-pj__name">{project.name}</span>
        <span className="st-pj__cwd t-code">{project.cwd}</span>
      </div>
      <div className="st-pj__actions">
        <GlassButton variant="glass" size="m" ariaLabel={`${project.name} 고치기`} onClick={() => setEditing(true)}>
          고치기
        </GlassButton>
        {project.isHq ? null : (
          <GlassButton variant="glass" size="m" ariaLabel={`${project.name} 보관하기`} onClick={() => setAsking(true)}>
            보관
          </GlassButton>
        )}
      </div>
      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title={`${project.name} 보관`}
        footer={
          <>
            <GlassButton variant="ghost" size="m" onClick={() => setAsking(false)}>
              취소
            </GlassButton>
            <GlassButton variant="primary" size="m" onClick={archive} disabled={busy}>
              {busy ? "보관하는 중" : "보관"}
            </GlassButton>
          </>
        }
      >
        <p className="st-confirm">목록에서 사라지고 깨어 있는 세션은 잠듭니다. 데이터는 남고, 설정의 보관함에서 다시 꺼낼 수 있습니다.</p>
        {error ? (
          <p className="form__error" role="alert">
            {error}
          </p>
        ) : null}
      </Modal>
    </li>
  );
}

function ProjectsPanel({ projects }: { projects: ProjectSummary[] }) {
  const [archived, setArchived] = useState<Project[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 보관하거나 다른 기기에서 꺼내면 목록이 바뀐다.
  const ids = projects.map((p) => p.id).join();
  useEffect(() => {
    let live = true;
    api
      .archivedProjects()
      .then((rows) => {
        if (live) setArchived(rows);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ids]);
  const restore = async (p: Project) => {
    setBusy(p.id);
    setError(null);
    try {
      await api.patchProject(p.id, { archived: false });
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Glass as="section" level="regular" tint className="st-panel" aria-labelledby="st-projects">
      <h2 id="st-projects" className="st-panel__title">
        프로젝트
      </h2>
      <ul className="st-pjs">
        {projects.map((p) => (
          <ProjectRow key={p.id} project={p} />
        ))}
      </ul>
      {archived.length > 0 ? (
        <>
          <p className="st-sub">보관함</p>
          <ul className="st-pjs">
            {archived.map((p) => (
              <li key={p.id} className="st-pj" data-project={p.id}>
                <div className="st-pj__main">
                  <span className="st-pj__name">{p.name}</span>
                  <span className="st-pj__cwd t-code">{p.cwd}</span>
                </div>
                <div className="st-pj__actions">
                  <GlassButton variant="glass" size="m" ariaLabel={`${p.name} 다시 꺼내기`} disabled={busy !== null} onClick={() => void restore(p)}>
                    {busy === p.id ? "꺼내는 중" : "꺼내기"}
                  </GlassButton>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {error ? (
        <p className="form__error" role="alert">
          {error}
        </p>
      ) : null}
    </Glass>
  );
}

function ConnectionPanel({ version, urls }: { version: string; urls: string[] }) {
  const connection = useStore((s) => s.connection);
  const [leaving, setLeaving] = useState(false);
  const drafts = leaving ? savedDraftCount() : 0;
  const state = connection === "online" ? "연결됨" : connection === "connecting" ? "연결 중" : "끊김";
  return (
    <Glass as="section" level="regular" tint className="st-panel" aria-labelledby="st-connection">
      <h2 id="st-connection" className="st-panel__title">
        접속
      </h2>
      <dl className="st-facts">
        <div>
          <dt>상태</dt>
          <dd>{state}</dd>
        </div>
        <div>
          <dt>들어올 주소</dt>
          <dd className="t-code st-urls">
            {urls.map((u) => (
              <span key={u}>{u}</span>
            ))}
          </dd>
        </div>
        <div>
          <dt>버전</dt>
          <dd className="t-tabular">{version}</dd>
        </div>
      </dl>
      <p className="su-hint">
        폰에서는 Tailscale 주소(100.으로 시작)로 들어옵니다. 같은 망의 기기까지 열려면 서버 컴퓨터에서 <code className="t-code">iamceo setup --hosts lan</code> 뒤 서버를 다시 켭니다.
      </p>
      <div className="st-leave">
        <GlassButton variant="glass" size="m" onClick={() => setLeaving(true)}>
          이 기기에서 나가기
        </GlassButton>
      </div>
      <Modal
        open={leaving}
        onClose={() => setLeaving(false)}
        title="이 기기에서 나가기"
        footer={
          <>
            <GlassButton variant="ghost" size="m" onClick={() => setLeaving(false)}>
              취소
            </GlassButton>
            <GlassButton variant="primary" size="m" onClick={logout}>
              나가기
            </GlassButton>
          </>
        }
      >
        <p className="st-confirm">
          이 기기의 접속 코드{drafts > 0 ? `와 쓰던 초안·메모 ${drafts}건` : ""}을 지웁니다. 다시 들어오려면 서버 컴퓨터에서 <code className="t-code">iamceo open</code> 으로 코드를 확인해야 합니다.
        </p>
      </Modal>
    </Glass>
  );
}

function SettingsForm({ settings, overrides, projects, version, urls }: { settings: SettingsT; overrides: Bootstrap["rankOverrides"]; projects: ProjectSummary[]; version: string; urls: string[] }) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // 직원별 지정 수는 이벤트로 오지 않는다. 설정을 열 때 새로 받는다.
  useEffect(() => {
    void refresh();
  }, []);

  // 저장 알림은 잠깐만 띠로 남는다.
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 6000);
    return () => clearTimeout(t);
  }, [saved]);

  const touch = (next: (d: Draft) => Draft) => {
    setDraft(next);
    setSaved(null);
    setError(null);
  };
  const editRank = (rank: Rank, patch: RankDraft) => touch((d) => ({ ...d, ranks: { ...d.ranks, [rank]: { ...d.ranks[rank], ...patch } } }));

  const permission = draft.permissionMode ?? settings.permissionMode;
  const notify = draft.notifyMac ?? settings.notifyMac;
  const tidyHours = draft.boardTidyHours ?? settings.boardTidyHours;
  // API 로 다른 값을 넣었으면 그 값도 고를 수 있게 둔다.
  const tidyChoices = TIDY_CHOICES.some((c) => c.hours === tidyHours) ? TIDY_CHOICES : [...TIDY_CHOICES, { hours: tidyHours, label: `${tidyHours}시간` }].sort((a, b) => a.hours - b.hours);
  const { patch, error: invalid } = buildPatch(settings, draft);
  const dirty = Object.keys(patch).length > 0 || invalid !== null;

  const save = async () => {
    if (!dirty || busy) return;
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.putSettings(patch);
      applyLocal({ type: "settings", settings: next });
      setDraft(EMPTY_DRAFT);
      setSaved("저장했습니다. 모델·effort는 다음 실행에 적용됩니다.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) void save();
  };

  return (
    <>
      <RuntimeStatus />

      <Glass as="section" level="regular" tint className="st-panel" aria-labelledby="st-permission">
        <h2 id="st-permission" className="st-panel__title">
          권한
        </h2>
        <PermissionChoices value={permission} onChange={(mode) => touch((d) => ({ ...d, permissionMode: mode }))} />
      </Glass>

      <Glass as="section" level="regular" tint className="st-panel" aria-labelledby="st-ranks">
        <h2 id="st-ranks" className="st-panel__title">
          직급별 모델·effort
        </h2>
        <RankTable settings={settings} overrides={overrides} draft={draft} edit={editRank} onEnter={onEnter} />
      </Glass>

      <ProjectsPanel projects={projects} />

      <Glass as="section" level="regular" tint className="st-panel" aria-labelledby="st-limits">
        <h2 id="st-limits" className="st-panel__title">
          운영
        </h2>
        <div className="st-numbers">
          {NUMBERS.map((n) => (
            <label key={n.key} className="field">
              <span className="field__label">{n.label}</span>
              <span className="st-number">
                <input
                  className="input t-tabular"
                  inputMode="numeric"
                  value={numberText(settings, draft, n.key)}
                  onChange={(e) => touch((d) => ({ ...d, numbers: { ...d.numbers, [n.key]: e.target.value } }))}
                  onKeyDown={onEnter}
                />
                <span aria-hidden="true">{n.unit}</span>
              </span>
              <span className="su-hint">{n.hint}</span>
            </label>
          ))}
          <label className="field">
            <span className="field__label">판 정리 주기</span>
            <select className="input st-select" value={tidyHours} onChange={(e) => touch((d) => ({ ...d, boardTidyHours: Number(e.target.value) }))}>
              {tidyChoices.map((c) => (
                <option key={c.hours} value={c.hours}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="su-hint">총괄이 쉬는 중이고 바뀐 게 있을 때만 판을 지금 상태로 맞춥니다</span>
          </label>
        </div>
        <label className="su-check">
          <input type="checkbox" checked={notify} onChange={(e) => touch((d) => ({ ...d, notifyMac: e.target.checked }))} />
          <span>
            맥 알림
            <small>결재나 내 할 일이 올라오면 서버 컴퓨터(맥)에 알림을 띄웁니다</small>
          </span>
        </label>
      </Glass>

      <ConnectionPanel version={version} urls={urls} />

      {dirty || error || saved ? (
        <Glass level="regular" tint className="st-bar">
          <p className={error ? "form__error" : saved && !dirty ? "st-bar__ok" : "st-bar__note"} role={error ? "alert" : "status"}>
            {error ?? (dirty ? "저장하지 않은 변경이 있습니다" : saved)}
          </p>
          {dirty ? (
            <>
              <GlassButton
                variant="ghost"
                size="m"
                disabled={busy}
                onClick={() => {
                  setDraft(EMPTY_DRAFT);
                  setError(null);
                }}
              >
                되돌리기
              </GlassButton>
              <GlassButton variant="primary" size="m" disabled={busy} onClick={() => void save()}>
                {busy ? "저장하는 중" : "저장"}
              </GlassButton>
            </>
          ) : null}
        </Glass>
      ) : null}
    </>
  );
}

export default function Settings() {
  const route = useRoute();
  const bootstrap = useBootstrap();
  const summary = useSummary();
  // 보던 프로젝트를 여기서 보관했으면 돌아갈 곳이 본사다.
  const back = summary ? routeHash({ projectId: summary.id, tab: route.tab }) : routeHash({ projectId: HQ_ID, tab: "home" });
  return (
    <div className="st">
      <a className="st-back" href={back}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {summary?.name ?? "본사"}
      </a>
      {bootstrap ? <SettingsForm settings={bootstrap.settings} overrides={bootstrap.rankOverrides} projects={bootstrap.projects} version={bootstrap.version} urls={bootstrap.urls} /> : null}
    </div>
  );
}
