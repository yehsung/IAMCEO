// 팀 화면(spec §10): 지금 상황 · 총괄 · 직원 · 잠든 직원 · 일 목록. 직원 상세는 주소의 <sub>(직원 id)로 열린다.
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { adoptRefusal, EFFORTS, memberRank, type Activity, type ActivityKind, type AdoptPreview, type Backend, type Effort, type LiveAgent, type Member, type MemberStatus, type Project, type ReleaseResult, type WorkItem, type WorkSec } from "@shared/types";
import ApprovalPanel from "../components/ApprovalPanel";
import { enterSends, isComposing } from "../components/Composer";
import ConnectGate, { isGateRejection, useGate } from "../components/ConnectGate";
import { Badge, MQ_DESKTOP, Modal, Sheet, StatusDot, Time, copyText, formatTime, useConfirmPress, useMediaQuery, Markdown } from "../components/ui";
import { Glass, GlassButton, cx } from "../glass";
import { ApiError, api, errorText } from "../lib/api";
import { applyLocal, findMember, loadActivity, navigate, newId, refresh, routeHash, sendMessage, useBootstrap, useProject, useRoute, useStore } from "../lib/store";
import "../styles/team.css";

const SCREEN_POLL_MS = 2000;
const CLOCK_TICK_MS = 30_000;
const ACTIVITY_SHOWN = 200;
const LONG_ACTIVITY = 180;

/** 눈이 먼저 가야 할 순서: 대표가 풀어 줘야 하는 상태가 위로 */
const STATUS_RANK: Record<MemberStatus, number> = { blocked: 0, waiting: 1, error: 2, working: 3, idle: 4, offline: 5, asleep: 6 };

const SEC_LABEL: Record<WorkSec, string> = { doing: "진행 중", next: "예정", hold: "보류", done: "완료" };
const SECS: readonly WorkSec[] = ["doing", "next", "hold", "done"];

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  text: "글",
  tool: "도구",
  tool_result: "결과",
  turn_start: "시작",
  turn_end: "끝",
  compact: "압축",
  error: "오류",
  system: "알림",
};

const DELIVERY_LABEL = { queued: "전달 대기", delivering: "전달 중", held: "보류", delivered: "받음", failed: "실패" } as const;

/** 작은따옴표 안에서는 작은따옴표만 끊어 넣으면 어떤 경로도 안전하다. 안전한 글자뿐이면 그대로 둔다. */
const shellQuote = (s: string) => (/^[A-Za-z0-9_\-./:=@]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
// sessionId 도 인용한다: 붙여 넣는 곳은 대표의 셸이다.
const resumeCommand = (m: Member) => `cd ${shellQuote(m.cwd)} && claude --resume ${shellQuote(m.sessionId ?? "")}`;
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run, setError };
}

function ErrorLine({ children }: { children: ReactNode }) {
  return children ? (
    <p className="tm-error" role="alert">
      {children}
    </p>
  ) : null;
}

// ---- 시작 안내 ----

/** 전체 실행 방식이 herdr 일 때만 넘겨받을 수 있다(서버와 같은 조건). */
function canAdoptInto(backend: Backend | null | undefined, herdrRunning: boolean): boolean {
  return herdrRunning && backend === "herdr";
}

/** 팀이 돌기 시작한 뒤에도 세션을 하나씩 더 옮겨 올 수 있다. */
function AdoptEntry({ project }: { project: Project }) {
  const [adopting, setAdopting] = useState(false);
  return (
    <div className="tm-adopt-entry">
      <GlassButton variant="ghost" size="m" onClick={() => setAdopting(true)}>
        기존 세션 편입
      </GlassButton>
      <AdoptDialog open={adopting} onClose={() => setAdopting(false)} project={project} />
    </div>
  );
}

function StartPanel({ project, hasMembers }: { project: Project; hasMembers: boolean }) {
  const { busy, error, run } = useAction();
  const [adopting, setAdopting] = useState(false);
  const gate = useGate();
  const canStart = gate.ok || gate.kind === "runner_off";
  const start = () =>
    run("start", async () => {
      applyLocal({ type: "member", member: await api.startConductor(project.id) });
      await refresh();
    });
  return (
    <Glass as="section" level="regular" tint className="tm-start">
      <h2 className="tm-start__title">{project.runnerEnabled ? "아직 팀이 없습니다" : "아직 연결되지 않았습니다"}</h2>
      <p className="tm-start__text">
        {!canStart
          ? "실행기가 돌아오면 총괄을 시작할 수 있습니다."
          : project.runnerEnabled
            ? "총괄을 시작하면 일을 받아 직원을 꾸립니다."
            : hasMembers
              ? "명부만 있고 세션은 깨어 있지 않습니다. 총괄을 시작하거나 쓰던 세션을 넘겨받으면 말과 결정을 쓸 수 있습니다."
              : "총괄을 시작하거나 쓰던 세션을 넘겨받으면 말과 결정을 쓸 수 있습니다."}
      </p>
      <div className="tm-start__actions">
        {canStart ? (
          <GlassButton variant="primary" size="m" disabled={busy !== null} onClick={start}>
            {busy === "start" ? "시작하는 중" : "총괄 시작"}
          </GlassButton>
        ) : null}
        {!project.isHq ? (
          <GlassButton variant="glass" size="m" onClick={() => setAdopting(true)}>
            기존 세션 편입
          </GlassButton>
        ) : null}
      </div>
      <ErrorLine>{error}</ErrorLine>
      {!project.isHq ? <AdoptDialog open={adopting} onClose={() => setAdopting(false)} project={project} /> : null}
    </Glass>
  );
}

function AdoptDialog({ open, onClose, project }: { open: boolean; onClose: () => void; project: Project }) {
  const desktop = useMediaQuery(MQ_DESKTOP);
  const boot = useBootstrap();
  const canAdopt = canAdoptInto(boot?.settings.backend, boot?.herdr.running ?? false);
  const Overlay = desktop ? Modal : Sheet;
  const why = boot?.settings.backend !== "herdr" ? "실행 방식이 herdr 일 때만 편입할 수 있습니다." : "herdr 가 켜져 있지 않아 편입할 수 없습니다.";
  return (
    <Overlay open={open} onClose={onClose} title={canAdopt ? "기존 세션 편입" : "기존 세션 붙이기"}>
      {!open ? null : canAdopt ? (
        <AdoptForm onClose={onClose} project={project} />
      ) : (
        <div className="form tm-adopt">
          <p className="tm-note tm-note--left">{why} 대신 터미널에서 붙일 수 있습니다.</p>
          <JoinGuide project={project} />
        </div>
      )}
    </Overlay>
  );
}

const ADOPT_POLL_MS = 3000;

/** herdr 칸이 아닌 세션(tmux·일반 터미널·IDE)은 그 세션 쪽에서 붙는다. */
function JoinGuide({ project }: { project: Project }) {
  const cli = useBootstrap()?.cli ?? "iamceo";
  const [name, setName] = useState("내 세션");
  const command = `${cli} join --project ${shellQuote(project.name)} --name ${shellQuote(name.trim() || "내 세션")}`;
  return (
    <div className="tm-join">
      <p className="tm-label">터미널에서 붙이기 (tmux·일반 터미널·IDE)</p>
      <ol className="tm-join__steps">
        <li>서버 컴퓨터에서, 그 세션을 쓰는 폴더의 터미널에 아래 명령을 넣습니다.</li>
        <li>출력되는 MCP 연결 명령을 실행합니다.</li>
        <li>세션에서 /mcp 로 다시 연결하고, 출력된 규칙 파일을 읽고 따르라고 입력합니다.</li>
      </ol>
      <label className="field">
        <span className="field__label">이름</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <CopyBox command={command} label="연결 명령 복사" />
      <p className="tm-note tm-note--left">칸을 옮기거나 세션을 끝내지 않습니다. Claude Code 세션만 됩니다. 다른 CLI 는 아직 지원하지 않습니다.</p>
    </div>
  );
}

function AdoptForm({ onClose, project }: { onClose: () => void; project: Project }) {
  const [rows, setRows] = useState<LiveAgent[] | null>(null);
  const [paneId, setPaneId] = useState<string | null>(null);
  const [preview, setPreview] = useState<AdoptPreview | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const { busy, error, run, setError } = useAction();

  // 대기 뒤 다시 시도할 수 있게 열어 둔 동안 상태를 따라간다. 고른 칸의 화면도 함께 새로 본다.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const list = await api.herdrAgents();
        if (live) setRows(list);
        if (live && paneId && list.some((a) => a.paneId === paneId)) {
          const seen = await api.adoptPreview(project.id, paneId);
          if (live) setPreview(seen);
        }
      } catch (e) {
        if (!live) return;
        setRows((old) => old ?? []);
        setError(errorText(e));
      }
      if (live) timer = setTimeout(tick, ADOPT_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [project.id, paneId, setError]);

  // 다른 CLI 는 세션 기록을 못 읽고, 깨우면 Claude 로 뜬다. 이 프로젝트 폴더에서 도는 세션이 고를 확률이 가장 높다.
  const agents = useMemo(() => (rows ?? []).filter((a) => !a.adopted && a.agent === "claude").sort((a, b) => Number(b.cwd === project.cwd) - Number(a.cwd === project.cwd)), [rows, project.cwd]);
  const others = (rows ?? []).filter((a) => a.agent && a.agent !== "claude").length;
  const chosen = agents.find((a) => a.paneId === paneId) ?? null;
  const shown = preview?.paneId === paneId ? preview : null;
  const refuse = chosen ? (shown?.refuse ?? adoptRefusal(chosen)) : null;

  const pick = (a: LiveAgent) => {
    setPaneId(a.paneId);
    setPreview(null);
    setError(null);
    if (!name.trim() && a.name) setName(a.name);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!paneId) return setError("편입할 세션을 고르세요");
    if (!name.trim() || !role.trim()) return setError("이름과 역할을 넣어 주세요");
    void run("adopt", async () => {
      // 떠 있는 세션에는 도구를 붙일 수 없다. team_* 없는 총괄은 지휘할 수단이 없어 직원 자리로만 받는다.
      applyLocal({ type: "member", member: await api.adopt(project.id, { paneId, name: name.trim(), role: role.trim(), kind: "worker" }) });
      await refresh();
      onClose();
    });
  };

  if (rows === null) return <p className="tm-note">세션을 찾는 중입니다</p>;
  const summary = (
    <div className="tm-adopt__what">
      <p className="tm-label">무엇이 바뀌나</p>
      <ul>
        <li>칸은 그대로입니다. 탭·배치·칸 이름을 옮기거나 바꾸지 않습니다.</li>
        <li>운영 규칙을 첫 지시로 보내고 프로젝트 실행을 켭니다. 이후 턴 마지막 글은 터미널에 직접 친 일까지 대화와 총괄에게 보고됩니다.</li>
        <li>떠 있는 세션에는 도구를 못 붙여 결재 카드·자료를 못 올립니다. '도구 붙여 다시 열기'로 붙이고, '편입 해제'로 되돌립니다.</li>
      </ul>
    </div>
  );
  if (agents.length === 0) {
    return (
      <div className="form tm-adopt">
        <p className="tm-note tm-note--left">{others > 0 ? `편입할 수 있는 Claude 세션이 없습니다. 다른 CLI 세션 ${others}개는 받을 수 없습니다.` : "편입할 수 있는 세션이 없습니다. herdr 에서 세션을 띄우면 여기에 나타납니다."}</p>
        <ErrorLine>{error}</ErrorLine>
        <JoinGuide project={project} />
      </div>
    );
  }
  return (
    <form className="form tm-adopt" onSubmit={submit}>
      {summary}
      <fieldset className="field">
        <legend className="field__label">세션</legend>
        <div className="tm-adopt__list">
          {agents.map((a) => {
            const why = adoptRefusal(a);
            return (
              <label key={a.paneId} className="choice" data-on={paneId === a.paneId ? "" : undefined}>
                <input type="radio" name="tm-adopt-pane" checked={paneId === a.paneId} onChange={() => pick(a)} />
                <span>{a.name ?? a.paneId}</span>
                <small>
                  {why ?? (a.cwd === project.cwd ? "이 프로젝트 폴더" : "대기 중")}
                  {a.cwd ? <span className="tm-adopt__cwd t-code">{a.cwd}</span> : null}
                </small>
              </label>
            );
          })}
        </div>
        {others > 0 ? <p className="tm-note tm-note--left">다른 CLI 세션 {others}개는 받을 수 없습니다. Claude 세션만 됩니다.</p> : null}
      </fieldset>
      {chosen ? (
        <div className="tm-adopt__preview">
          {refuse ? (
            <p className="tm-hint" role="status">
              {refuse}
            </p>
          ) : null}
          {shown?.warnings.map((w) => (
            <p key={w.kind} className="tm-adopt__warn" data-kind={w.kind}>
              {w.text}
            </p>
          ))}
          <p className="tm-label">세션 화면</p>
          {shown ? (
            <pre className="tm-screen tm-adopt__screen t-code" tabIndex={0} aria-label="세션 화면">
              {shown.screen.split("\n").filter((l) => l.trim()).slice(-12).join("\n") || "화면을 읽지 못했습니다"}
            </pre>
          ) : (
            <p className="tm-note tm-note--left">화면을 읽는 중입니다</p>
          )}
        </div>
      ) : null}
      <label className="field">
        <span className="field__label">이름</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="개발 담당" />
      </label>
      <label className="field">
        <span className="field__label">역할</span>
        <input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="결제 화면 구현" />
      </label>
      <ErrorLine>{error}</ErrorLine>
      <div className="form__actions">
        <GlassButton variant="ghost" size="m" onClick={onClose}>
          취소
        </GlassButton>
        <GlassButton variant="primary" size="m" type="submit" disabled={busy !== null || !!refuse}>
          {busy ? "편입하는 중" : "편입"}
        </GlassButton>
      </div>
      <details className="tm-adopt__other">
        <summary>herdr 칸이 아닌 세션이면</summary>
        <JoinGuide project={project} />
      </details>
    </form>
  );
}

// ---- 카드 ----

function ContextMeter({ pct, compactAt }: { pct: number; compactAt: number }) {
  const value = Math.round(pct);
  const due = value >= compactAt;
  return (
    <span className="tm-ctx" data-due={due ? "" : undefined}>
      <i className="tm-ctx__bar" aria-hidden="true">
        <b style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </i>
      <span className="t-tabular">{value}%</span>
      {due ? <Badge tone="warn">압축 예정</Badge> : null}
    </span>
  );
}

function memberHref(m: Member) {
  return routeHash({ projectId: m.projectId, tab: "team", sub: m.id });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** 지금 · 다음 · 대기열 · 문맥. 카드와 상세가 같은 줄을 쓴다 */
function MemberFacts({ m, compactAt, openAsks, extra }: { m: Member; compactAt: number; openAsks: number; extra?: ReactNode }) {
  return (
    <dl className="tm-facts">
      {extra}
      {/* 턴이 끝나도 now 는 남는다. 쉬는 직원의 글은 지금 하는 일이 아니다. */}
      {m.status === "idle" || m.status === "asleep" || m.status === "offline" ? (
        m.now ? <Row label="마지막 일">{m.now}</Row> : <Row label="지금"><span className="ink-3">맡은 일 없음</span></Row>
      ) : (
        <Row label="지금">{m.now || <span className="ink-3">맡은 일 없음</span>}</Row>
      )}
      {m.next ? <Row label="다음">{m.next}</Row> : null}
      {m.queuedCount > 0 ? <Row label="대기열"><span className="t-tabular">{m.queuedCount}건</span></Row> : null}
      {m.contextPct !== null ? (
        <Row label="문맥">
          <ContextMeter pct={m.contextPct} compactAt={compactAt} />
        </Row>
      ) : null}
      {openAsks > 0 ? (
        <Row label="결재">
          <a className="tm-inlink" href={routeHash({ projectId: m.projectId, tab: "inbox" })}>
            {openAsks}건 대기 · 결재함으로
          </a>
        </Row>
      ) : null}
    </dl>
  );
}

function Subagents({ n }: { n: number }) {
  return n > 0 ? <span className="tm-sub t-tabular">서브에이전트 {n}개</span> : null;
}

function MemberCard({ m, compactAt, openAsks, extra, lead }: { m: Member; compactAt: number; openAsks: number; extra?: ReactNode; lead?: boolean }) {
  return (
    <Glass as="article" level="regular" tint className={cx("tm-card", lead && "tm-card--lead")} data-status={m.status}>
      <header className="tm-card__head">
        <h3 className="tm-card__name">
          <a className="tm-card__link" href={memberHref(m)}>
            {m.name}
          </a>
          {lead && m.kind === "conductor" && m.name !== "총괄" ? <span className="tm-card__tag">총괄</span> : null}
        </h3>
        <span className="tm-card__status">
          <Subagents n={m.subagents} />
          <StatusDot status={m.status} label className="tm-status" />
        </span>
      </header>
      <p className="tm-card__role">
        {m.role && m.role !== m.name ? <span>{m.role}</span> : null}
        <Time iso={m.updatedAt} relative />
      </p>
      <MemberFacts m={m} compactAt={compactAt} openAsks={openAsks} extra={extra} />
      {m.lastError ? <p className="tm-error tm-card__err">{m.lastError}</p> : null}
      <NoTools m={m} />
    </Glass>
  );
}

/** 넘겨받은 세션에는 도구가 없다. 칸에서 세션을 끝내고 프로젝트 탭에 도구를 붙여 다시 연다. */
function NoTools({ m }: { m: Member }) {
  const { busy, error, run } = useAction();
  const confirm = useConfirmPress();
  if (m.origin !== "adopted" || !m.sessionId || m.status === "asleep") return null;
  const working = m.status === "working" || m.status === "blocked";
  return (
    <div className="tm-notools">
      <div className="tm-notools__row">
        <Badge tone="warn">도구 없음</Badge>
        <GlassButton
          variant="glass"
          size="m"
          className="tm-notools__btn"
          disabled={busy !== null || working}
          onClick={() =>
            confirm.press(() => {
              void run("reopen", async () => applyLocal({ type: "member", member: await api.reopenWithTools(m.id) }));
            })
          }
        >
          {busy ? "여는 중" : confirm.armed ? "한 번 더 누르면 다시 엽니다" : "도구 붙여 다시 열기"}
        </GlassButton>
      </div>
      <p className="tm-notools__text">{confirm.armed ? "지금 칸의 세션을 끝내고 프로젝트 탭에 다시 엽니다. 기록은 이어지고 쓰던 칸은 셸로 남습니다." : working ? "턴이 끝나면 다시 열 수 있습니다." : "턴 마지막 글로만 보고합니다. 결재 카드·자료를 못 올립니다."}</p>
      <ErrorLine>{error}</ErrorLine>
    </div>
  );
}

function AsleepGroup({ members, runnerEnabled }: { members: Member[]; runnerEnabled: boolean }) {
  return (
    <Glass as="details" level="regular" tint className="tm-fold">
      <summary className="tm-fold__sum">
        잠든 직원 <span className="t-tabular ink-2">{members.length}</span>
        <span className="tm-fold__hint">세션은 그대로 있습니다</span>
      </summary>
      <ul className="tm-asleep">
        {members.map((m) => (
          <AsleepRow key={m.id} m={m} runnerEnabled={runnerEnabled} />
        ))}
      </ul>
    </Glass>
  );
}

function AsleepRow({ m, runnerEnabled }: { m: Member; runnerEnabled: boolean }) {
  const { busy, error, run } = useAction();
  const manual = m.origin === "manual";
  return (
    <li className="tm-asleep__row">
      <a className="tm-asleep__main" href={memberHref(m)}>
        <span className="tm-asleep__name">
          <StatusDot status={m.status} className="tm-status" />
          {m.name}
          {m.role ? <span className="tm-asleep__role">{m.role}</span> : null}
        </span>
        {m.now ? <span className="tm-asleep__last">마지막 일: {m.now}</span> : null}
      </a>
      {manual || !runnerEnabled ? null : (
        <GlassButton
          variant="glass"
          size="m"
          className="tm-asleep__btn"
          disabled={busy !== null}
          onClick={() => run("resume", async () => applyLocal({ type: "member", member: await api.resume(m.id) }))}
        >
          {busy ? "여는 중" : "다시 열기"}
        </GlassButton>
      )}
      {error ? (
        <p className="tm-error tm-asleep__err" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

// ---- 일 목록 ----

function WorkList({ work }: { work: WorkItem[] }) {
  const [sec, setSec] = useState<WorkSec | "all">("all");
  const count = (s: WorkSec) => work.filter((w) => w.sec === s).length;
  const shown = useMemo(() => {
    const rank = (w: WorkItem) => SECS.indexOf(w.sec);
    const list = work.filter((w) => (sec === "all" ? w.sec !== "done" : w.sec === sec));
    if (sec === "done") return list.sort((a, b) => (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt));
    return list.sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  }, [work, sec]);
  const chip = (key: WorkSec | "all", label: string, n?: number) => (
    <button key={key} type="button" className="tm-chip" aria-pressed={sec === key} onClick={() => setSec(key)}>
      {label}
      {n === undefined ? null : <span className="t-tabular tm-chip__n">{n}</span>}
    </button>
  );
  return (
    <section className="tm-work" aria-label="일 목록">
      <div className="tm-chips">
        {chip("all", "전체")}
        {SECS.map((s) => chip(s, SEC_LABEL[s], count(s)))}
      </div>
      <Glass as="ul" level="regular" tint className="tm-work__list">
        {shown.map((w) => (
          <li key={w.id} className="tm-wi" data-sec={w.sec}>
            <i className="tm-wi__dot" aria-hidden="true" />
            <div className="tm-wi__main">
              <p className="tm-wi__title">{w.title}</p>
              <p className="tm-wi__sub">{[w.who, w.detail].filter(Boolean).join(" · ")}</p>
            </div>
            <span className="tm-wi__sec">{w.sec === "done" && w.doneAt ? <Time iso={w.doneAt} relative /> : SEC_LABEL[w.sec]}</span>
          </li>
        ))}
        {shown.length === 0 ? <li className="tm-note">없음</li> : null}
      </Glass>
    </section>
  );
}

// ---- 직원 상세 ----

function ActivityRow({ a }: { a: Activity }) {
  const long = a.text.length > LONG_ACTIVITY || a.text.includes("\n");
  const [open, setOpen] = useState(false);
  const body = <span className={cx("tm-act__text", (a.kind === "tool" || a.kind === "tool_result") && "t-code", long && !open && "tm-act__text--cut")}>{a.text}</span>;
  return (
    <li className="tm-act" data-kind={a.kind}>
      <span className="tm-act__meta">
        <span className="t-tabular">{formatTime(a.at)}</span>
        <span className="tm-act__kind">{ACTIVITY_LABEL[a.kind]}</span>
      </span>
      {long ? (
        <button type="button" className="tm-act__more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
}

function ActivityList({ memberId }: { memberId: string }) {
  const rows = useStore((s) => s.activity[memberId]);
  const online = useStore((s) => s.connection === "online");
  const [error, setError] = useState<string | null>(null);

  // 끊긴 동안 놓친 활동은 이벤트로 다시 오지 않는다: 다시 이어지면 새로 받는다
  useEffect(() => {
    let live = true;
    setError(null);
    loadActivity(memberId).catch((e) => {
      if (live) setError(errorText(e));
    });
    return () => {
      live = false;
    };
  }, [memberId, online]);

  const shown = useMemo(() => (rows ?? []).slice(-ACTIVITY_SHOWN).reverse(), [rows]);
  if (!rows) return error ? <ErrorLine>{error}</ErrorLine> : <p className="tm-note">불러오는 중입니다</p>;
  if (shown.length === 0) return <p className="tm-note">아직 활동이 없습니다</p>;
  return (
    <ol className="tm-acts" aria-live="polite" aria-relevant="additions">
      {shown.map((a) => (
        <ActivityRow key={a.id} a={a} />
      ))}
    </ol>
  );
}

function ScreenPane({ memberId }: { memberId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const r = await api.screen(memberId);
          if (!live) return;
          setText(stripAnsi(r.text));
          setError(null);
        } catch (e) {
          if (!live) return;
          setError(errorText(e));
        }
      }
      if (live) timer = setTimeout(tick, SCREEN_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [memberId]);

  // 터미널처럼 맨 아래를 따라가되, 위로 올려 읽는 중이면 건드리지 않는다
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="tm-screen-wrap">
      {error ? <ErrorLine>화면을 읽지 못했습니다: {error}</ErrorLine> : null}
      {text === null && !error ? <p className="tm-note">화면을 읽는 중입니다</p> : null}
      {text !== null ? (
        <pre
          ref={ref}
          className="tm-screen t-code"
          tabIndex={0}
          aria-label="터미널 화면"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {text || "화면이 비어 있습니다"}
        </pre>
      ) : null}
    </div>
  );
}

/** 명령 한 줄과 복사 버튼. */
function CopyBox({ command, label, onCopied }: { command: string; label: string; onCopied?: () => void }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  const copy = async () => {
    const ok = await copyText(command);
    setState(ok ? "ok" : "fail");
    if (ok) onCopied?.();
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <div className="tm-copy__row">
      <code className="tm-copy__cmd t-code" title={command}>
        {command}
      </code>
      <GlassButton variant="glass" size="m" ariaLabel={label} onClick={copy}>
        {state === "ok" ? "복사함" : state === "fail" ? "실패" : "복사"}
      </GlassButton>
    </div>
  );
}

function CopyCommand({ m }: { m: Member }) {
  const [copied, setCopied] = useState(false);
  const running = m.status !== "asleep" && m.status !== "offline";
  return (
    <div className="tm-copy">
      <p className="tm-label">터미널로 열기</p>
      <CopyBox command={resumeCommand(m)} label="터미널로 열기 명령 복사" onCopied={() => setCopied(true)} />
      {copied && running ? <p className="tm-note tm-note--left">지금 도는 세션입니다. 두 곳에서 함께 쓰면 꼬이니 먼저 잠재우고 여세요.</p> : null}
    </div>
  );
}

const MODELS = ["fable", "opus", "sonnet", "haiku"];

/** 직원별 모델·effort. 기본은 직급 값이고, 고르는 대로 저장한다. 세션에는 쉴 때 들어간다. */
function MemberConfig({ m }: { m: Member }) {
  const rank = useBootstrap()?.settings.ranks[memberRank(m.kind)];
  const { busy, error, run } = useAction();
  const save = (patch: { modelOverride?: string | null; effortOverride?: Effort | null }) =>
    run("config", async () => applyLocal({ type: "member", member: await api.patchMember(m.id, patch) }));
  const models = m.modelOverride && !MODELS.includes(m.modelOverride) ? [...MODELS, m.modelOverride] : MODELS;
  const base = (v: string | null | undefined) => `직급 기본값${v ? ` (${v})` : ""}`;
  return (
    <div className="tm-config">
      <p className="tm-label">모델 · effort</p>
      <div className="tm-config__row">
        <select className="input tm-select" aria-label="모델" disabled={busy !== null} value={m.modelOverride ?? ""} onChange={(e) => save({ modelOverride: e.target.value || null })}>
          <option value="">{base(rank?.model)}</option>
          {models.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <select className="input tm-select" aria-label="effort" disabled={busy !== null} value={m.effortOverride ?? ""} onChange={(e) => save({ effortOverride: (e.target.value || null) as Effort | null })}>
          <option value="">{base(rank?.effort)}</option>
          {EFFORTS.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </div>
      {m.origin === "adopted" ? <p className="tm-note tm-note--left">넘겨받은 세션은 다시 열 때 적용됩니다.</p> : null}
      <ErrorLine>{error}</ErrorLine>
    </div>
  );
}

/** 편입 해제: 대화와 세션은 그대로 두고 관리에서 뺀다. */
function ReleaseButton({ m, onReleased }: { m: Member; onReleased: (name: string, r: ReleaseResult) => void }) {
  const { busy, error, run } = useAction();
  const confirm = useConfirmPress();
  return (
    <>
      <GlassButton
        variant="glass"
        size="m"
        disabled={busy !== null}
        onClick={() =>
          confirm.press(() => {
            void run("release", async () => {
              const result = await api.release(m.id);
              onReleased(m.name, result);
              applyLocal({ type: "member_removed", projectId: m.projectId, memberId: m.id });
            });
          })
        }
      >
        {busy ? "해제하는 중" : confirm.armed ? "한 번 더 누르면 해제합니다" : "편입 해제"}
      </GlassButton>
      <ErrorLine>{error}</ErrorLine>
    </>
  );
}

function ReleasedNotice({ name, result, onClose }: { name: string; result: ReleaseResult; onClose: () => void }) {
  return (
    <Glass as="section" level="regular" tint className="tm-start tm-released" role="status">
      <p className="tm-start__text">
        {name} 편입을 해제했습니다.{" "}
        {!result.paneKept
          ? "IAMCEO 칸을 닫았고 세션 기록은 그대로입니다. 이어 쓰려면 아래 명령으로 여세요."
          : result.notified
            ? "칸과 세션은 그대로이고, 규칙이 풀렸다고 세션에 알렸습니다."
            : "칸과 세션은 그대로입니다. 세션이 쉬고 있지 않아 알리지 못했습니다. 운영 규칙을 따르지 않아도 된다고 세션에 직접 말해 주세요."}
      </p>
      {result.resumeCommand ? <CopyBox command={result.resumeCommand} label="이어 열기 명령 복사" /> : null}
      <div className="tm-start__actions">
        <GlassButton variant="ghost" size="m" onClick={onClose}>
          닫기
        </GlassButton>
      </div>
    </Glass>
  );
}

function MemberDetailBody({ m, project, compactAt, openAsks, onReleased }: { m: Member; project: Project; compactAt: number; openAsks: number; onReleased: (name: string, r: ReleaseResult) => void }) {
  const hasScreen = m.backend === "herdr" && !!m.paneId && m.status !== "asleep" && m.status !== "offline";
  const [pane, setPane] = useState<"activity" | "screen" | null>(null);
  const shownPane = hasScreen ? (pane ?? (m.status === "blocked" ? "screen" : "activity")) : "activity";
  const { busy, error, run } = useAction();
  const [notice, setNotice] = useState<string | null>(null);
  const closeConfirm = useConfirmPress();
  const forceConfirm = useConfirmPress();
  // 대기열·열린 결재로 거부되면 대표만 무릅쓸 수 있다.
  const [sleepRefused, setSleepRefused] = useState<string | null>(null);
  const manual = m.origin === "manual";
  const asleep = m.status === "asleep" || m.status === "offline";
  const canRelease = m.wasAdopted && m.kind === "worker";

  const memberAct = (key: string, call: (id: string) => Promise<Member>, done?: string) =>
    run(key, async () => {
      setNotice(null);
      applyLocal({ type: "member", member: await call(m.id) });
      if (done) setNotice(done);
    });

  return (
    <div className="tm tm-detail">
      <div className="tm-detail__top">
        <StatusDot status={m.status} label className="tm-status" />
        {m.role ? <span className="tm-detail__role">{m.role}</span> : null}
        <Subagents n={m.subagents} />
        <Time iso={m.updatedAt} relative className="tm-detail__time" />
      </div>
      {/* 승인 창을 읽을 수 있으면 여기서 승인·거절한다. 못 읽으면(폴더 신뢰 창 등) 화면을 보고 터미널에서 푼다. */}
      {m.status === "blocked" ? <ApprovalPanel member={m} boxed fallback={<p className="tm-hint">승인 창 앞에서 멈췄습니다. 화면을 보고 터미널에서 승인하거나 거절하세요.</p>} /> : null}
      <MemberFacts m={m} compactAt={compactAt} openAsks={openAsks} />
      {m.lastError ? <p className="tm-error">{m.lastError}</p> : null}
      <NoTools m={m} />
      {m.origin === "adopted" && !asleep ? <p className="tm-note tm-note--left">쓰던 칸 그대로입니다. 잠재우면 세션만 끝나고 칸은 셸로 남습니다.</p> : null}

      {manual ? (
        <>
          <p className="tm-note tm-note--left">직접 띄운 세션입니다. 압축하거나 재울 수 없고, 보낸 말은 그 세션이 wait 를 부를 때 전달됩니다. 도구 호출이 오래 없으면 안 보임으로 표시합니다.</p>
          <div className="tm-actions">
            <GlassButton
              variant="glass"
              size="m"
              disabled={busy !== null}
              onClick={() =>
                closeConfirm.press(() => {
                  void run("close", async () => {
                    await api.closeMember(m.id);
                    applyLocal({ type: "member_removed", projectId: m.projectId, memberId: m.id });
                  });
                })
              }
            >
              {busy === "close" ? "빼는 중" : closeConfirm.armed ? "한 번 더 누르면 뺍니다" : "명부에서 빼기"}
            </GlassButton>
          </div>
        </>
      ) : (
        <div className="tm-actions">
          {asleep ? (
            project.runnerEnabled ? (
              <GlassButton variant="glass" size="m" disabled={busy !== null} onClick={() => memberAct("resume", api.resume)}>
                {busy === "resume" ? "깨우는 중" : "깨우기"}
              </GlassButton>
            ) : (
              <p className="tm-note tm-note--left">실행이 꺼져 있어 깨울 수 없습니다. 팀 화면에서 총괄을 시작하거나 기존 세션을 편입하세요.</p>
            )
          ) : (
            <>
              {m.status === "working" || m.status === "blocked" ? (
                <GlassButton variant="glass" size="m" disabled={busy !== null} onClick={() => memberAct("interrupt", api.interrupt, "멈추라고 보냈습니다. 지금 턴이 끊기면 쉼으로 바뀝니다.")}>
                  {busy === "interrupt" ? "멈추는 중" : "중단"}
                </GlassButton>
              ) : null}
              <GlassButton
                variant="glass"
                size="m"
                disabled={busy !== null || !m.sessionId}
                onClick={() => memberAct("compact", api.compact, m.status === "working" ? "압축을 예약했습니다. 지금 턴이 끝나면 실행합니다." : "압축을 요청했습니다.")}
              >
                {busy === "compact" ? "요청하는 중" : "압축"}
              </GlassButton>
              <GlassButton
                variant="glass"
                size="m"
                disabled={busy !== null}
                onClick={() =>
                  run("sleep", async () => {
                    setNotice(null);
                    setSleepRefused(null);
                    try {
                      applyLocal({ type: "member", member: await api.sleep(m.id) });
                    } catch (e) {
                      // 칸에 선택 창(입력칸을 못 찾음)이나 승인 창이 떠 있으면 무릅쓸 수 없다. 대표가 풀어야 한다. 입력칸에 남은 글은 서버가 지운다.
                      if (e instanceof ApiError && e.status === 409 && !/입력칸|승인 창/.test(e.message)) setSleepRefused(e.message);
                      else throw e;
                    }
                  })
                }
              >
                {busy === "sleep" ? "재우는 중" : "잠재우기"}
              </GlassButton>
              {sleepRefused ? (
                <GlassButton
                  variant="glass"
                  size="m"
                  disabled={busy !== null}
                  onClick={() =>
                    forceConfirm.press(() => {
                      void run("sleep", async () => {
                        applyLocal({ type: "member", member: await api.sleep(m.id, true) });
                        setSleepRefused(null);
                      });
                    })
                  }
                >
                  {forceConfirm.armed ? "한 번 더 누르면 재웁니다" : "그래도 재우기"}
                </GlassButton>
              ) : null}
            </>
          )}
          {canRelease ? <ReleaseButton m={m} onReleased={onReleased} /> : null}
        </div>
      )}
      <ErrorLine>{error ?? (sleepRefused && !asleep ? `${sleepRefused}. 그래도 재우면 돌던 턴이 끊기고 대기열은 깨울 때까지 멈춥니다.` : null)}</ErrorLine>
      {notice ? (
        <p className="tm-note tm-note--left" role="status">
          {notice}
        </p>
      ) : null}

      {manual ? null : <MemberConfig m={m} />}
      {m.sessionId ? <CopyCommand m={m} /> : null}

      <div className="tm-panes">
        {hasScreen ? (
          <div className="tm-chips">
            <button type="button" className="tm-chip" aria-pressed={shownPane === "activity"} onClick={() => setPane("activity")}>
              활동
            </button>
            <button type="button" className="tm-chip" aria-pressed={shownPane === "screen"} onClick={() => setPane("screen")}>
              화면
            </button>
          </div>
        ) : (
          <p className="tm-label">활동</p>
        )}
        {shownPane === "screen" ? <ScreenPane memberId={m.id} /> : <ActivityList memberId={m.id} />}
      </div>
    </div>
  );
}

const directKey = (memberId: string) => `iamceo.draft.direct.${memberId}`;

/** 창을 닫아도(바깥 누름·Esc) 쓰던 지시가 남는다. '이 기기에서 나가기'가 함께 지운다. */
function loadDirect(memberId: string): { text: string; retry: { id: string; text: string } | null } {
  try {
    const raw = localStorage.getItem(directKey(memberId));
    if (raw) return { text: "", retry: null, ...(JSON.parse(raw) as object) };
  } catch {
    // 깨진 값이면 빈 칸으로 시작한다.
  }
  return { text: "", retry: null };
}

function saveDirect(memberId: string, text: string, retry: { id: string; text: string } | null): void {
  try {
    if (!text && !retry) localStorage.removeItem(directKey(memberId));
    else localStorage.setItem(directKey(memberId), JSON.stringify({ text, retry }));
  } catch {
    // 저장 공간이 없어도 입력은 계속된다.
  }
}

function DirectInput({ m }: { m: Member }) {
  const gate = useGate();
  const [saved] = useState(() => loadDirect(m.id));
  const [text, setTextState] = useState(saved.text);
  // 실패한 글과 내용이 같으면 같은 id 로 다시 보낸다. 응답만 잃었을 때 지시가 둘이 되지 않는다.
  const [retry, setRetryState] = useState(saved.retry);
  const [sentId, setSentId] = useState<string | null>(saved.retry?.id ?? null);
  const [busy, setBusy] = useState(false);
  // 연결 때문에 서버가 받지 않았다. 없는 글이 실패 줄로 남지 않게 줄을 걷고 이유만 칸 위에 보인다.
  const [rejected, setRejected] = useState<string | null>(null);
  const sent = useProject()?.messages.find((x) => x.id === sentId) ?? null;
  const asleep = m.status === "asleep" || m.status === "offline";
  const latest = useRef({ text, retry });
  const update = (nextText: string, nextRetry: { id: string; text: string } | null) => {
    latest.current = { text: nextText, retry: nextRetry };
    setTextState(nextText);
    setRetryState(nextRetry);
    saveDirect(m.id, nextText, nextRetry);
  };

  // 응답만 잃었고 서버는 받았다(재동기화로 알았다). 칸에 남은 글을 또 보내면 지시가 둘이 된다.
  const delivery = sent?.delivery;
  useEffect(() => {
    if (!retry || sent?.id !== retry.id || !delivery || delivery === "failed") return;
    update(latest.current.text === retry.text ? "" : latest.current.text, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry, sent?.id, delivery]);

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    const id = retry?.text === body ? retry.id : newId();
    setSentId(id);
    setRejected(null);
    update("", null);
    // 총괄은 대상을 비워야 '대표 말' 경로로 간다. @총괄 로 보내면 같은 사실을 자기에게 또 알린다
    const worker = m.kind === "worker";
    let gateRefused = false;
    const result = await sendMessage(
      { id, text: body, targetMemberId: worker ? m.id : null },
      {
        targetName: worker ? m.name : null,
        onRejected: (e) => {
          if (!isGateRejection(e)) return false;
          gateRefused = true;
          setRejected(e.message);
          return true;
        },
      },
    );
    // 저장되지 않았으니 같은 id 를 이어 쓸 이유가 없다.
    if (gateRefused) update(latest.current.text || body, null);
    else if (!result) update(latest.current.text || body, latest.current.text ? null : { id, text: body });
    setBusy(false);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중 Enter 는 글자를 확정할 뿐이다. 터치 기기는 입력칸과 같게 Enter 가 줄바꿈이다.
    if (!isComposing(e) && enterSends(e)) {
      e.preventDefault();
      void submit();
    }
  };

  const placeholder = asleep ? `${m.name}에게 직접 지시 (보내면 깨워서 전달합니다)` : `${m.name}에게 직접 지시`;

  // 연결되기 전에는 칸을 열어 두지 않는다. 쓰던 글은 기기에 남아 있다.
  if (!gate.ok) return <ConnectGate className="tm-send" />;

  return (
    <form
      className="tm tm-send"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {rejected ? (
        <p className="tm-send__state" data-state="failed" role="alert">
          {rejected}
        </p>
      ) : sent?.delivery ? (
        <p className="tm-send__state" data-state={sent.delivery} role="status">
          보낸 지시: {DELIVERY_LABEL[sent.delivery]}
          {sent.deliveryNote ? ` (${sent.deliveryNote})` : ""}
        </p>
      ) : null}
      <div className="tm-send__row">
        <textarea className="input tm-send__input" rows={1} value={text} placeholder={placeholder} aria-label={placeholder} onChange={(e) => update(e.target.value, latest.current.retry)} onKeyDown={onKey} />
        <GlassButton variant="primary" size="m" type="submit" disabled={!text.trim() || busy}>
          보내기
        </GlassButton>
      </div>
    </form>
  );
}

function MemberDetail({ memberId, compactAt, onReleased }: { memberId: string | null; compactAt: number; onReleased: (name: string, r: ReleaseResult) => void }) {
  const desktop = useMediaQuery(MQ_DESKTOP);
  const project = useProject();
  const member = findMember(project, memberId);
  const Overlay = desktop ? Modal : Sheet;
  const close = () => navigate({ sub: null });

  // 주소로 들어왔는데 없거나, 보는 중에 명부에서 빠진 직원
  useEffect(() => {
    if (memberId && project && !member) navigate({ sub: null }, { replace: true });
  }, [memberId, project, member]);

  const openAsks = member && project ? project.decisions.filter((d) => d.status === "open" && d.memberId === member.id).length : 0;
  return (
    <Overlay
      open={!!member}
      onClose={close}
      title={member ? `${member.name}${member.kind === "conductor" ? " · 총괄" : ""}` : undefined}
      footer={member && project ? <DirectInput key={member.id} m={member} /> : undefined}
    >
      {member && project ? <MemberDetailBody key={member.id} m={member} project={project.project} compactAt={compactAt} openAsks={openAsks} onReleased={onReleased} /> : null}
    </Overlay>
  );
}

// ---- 화면 ----

/** '3분 전'이 멈춰 보이지 않게 이벤트가 없어도 가끔 다시 그린다 */
function useClockTick() {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, []);
}

export default function Team() {
  const state = useProject();
  const route = useRoute();
  const bootstrap = useBootstrap();
  const compactAt = bootstrap?.settings.compactAtPct ?? 70;
  const [released, setReleased] = useState<{ name: string; result: ReleaseResult } | null>(null);
  useClockTick();
  if (!state) return null;
  const { project, members, work, decisions } = state;

  const openAsks = (id: string) => decisions.filter((d) => d.status === "open" && d.memberId === id).length;
  const lead = members.find((m) => m.kind !== "worker") ?? null;
  const workers = members.filter((m) => m.kind === "worker");
  const asleep = workers.filter((m) => m.status === "asleep");
  const awake = workers.filter((m) => m.status !== "asleep").sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  const working = workers.filter((m) => m.status === "working").length;
  const waiting = workers.filter((m) => m.status === "waiting").length;

  return (
    <div className="tm">
      {released ? <ReleasedNotice name={released.name} result={released.result} onClose={() => setReleased(null)} /> : null}
      {!project.runnerEnabled || members.length === 0 ? <StartPanel project={project} hasMembers={members.length > 0} /> : null}

      {project.now ? (
        <Glass as="section" level="regular" tint className="tm-now" aria-label="지금 상황">
          <p className="tm-label">
            지금 상황
            <Time iso={project.nowAt} relative className="tm-now__at" />
          </p>
          <Markdown text={project.now} className="tm-now__text" />
        </Glass>
      ) : null}

      {lead ? (
        <MemberCard
          lead
          m={lead}
          compactAt={compactAt}
          openAsks={openAsks(lead.id)}
          extra={
            <Row label="직원">
              <span className="t-tabular">
                {[`${workers.length}명`, working ? `일하는 중 ${working}` : "", waiting ? `내 답 기다림 ${waiting}` : "", `잠듦 ${asleep.length}`].filter(Boolean).join(" · ")}
              </span>
            </Row>
          }
        />
      ) : null}

      {awake.length > 0 ? (
        <div className="tm-grid">
          {awake.map((m) => (
            <MemberCard key={m.id} m={m} compactAt={compactAt} openAsks={openAsks(m.id)} />
          ))}
        </div>
      ) : null}

      {asleep.length > 0 ? <AsleepGroup members={asleep} runnerEnabled={project.runnerEnabled} /> : null}
      {work.length > 0 ? <WorkList work={work} /> : null}
      {members.length > 0 && project.runnerEnabled && !project.isHq ? <AdoptEntry project={project} /> : null}
      <MemberDetail memberId={route.sub} compactAt={compactAt} onReleased={(name, result) => setReleased({ name, result })} />
    </div>
  );
}

