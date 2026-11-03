// 홈: 대표가 오늘 뭘 하면 되나를 3초에 아는 화면. 내용이 없는 칸은 그리지 않는다.
// 데스크톱은 두 칸(내 일 / 팀·AI 일), 그보다 좁으면 한 줄로 쌓는다.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Decision, FileDoc, Member, MemberStatus, Message, MessageKind, Project, ProjectState, Todo, WorkItem } from "@shared/types";
import ConnectGate, { useGate } from "../components/ConnectGate";
import { Badge, MQ_DESKTOP, Markdown, StatusDot, Time, type BadgeTone, useMediaQuery } from "../components/ui";
import { Glass, GlassButton } from "../glass";
import { errorText, api } from "../lib/api";
import { applyLocal, routeHash, useProject } from "../lib/store";
import "../styles/home.css";

const TOP_DECISIONS = 3;
const TOP_WORKING = 3;
const TOP_WORK = 5;
const TOP_REPORTS = 5;
const TOP_FILES = 3;
/** 체크한 줄은 잠시 제자리에서 지웠다는 걸 보여 주고 '완료'로 들어간다. 바로 빠지면 다음 줄이 손가락 밑으로 올라온다. */
const SETTLE_MS = 1500;
/** 줄이 빠져 자리가 움직인 직후의 체크는 받지 않는다. */
const AFTER_SHIFT_MS = 400;
/** 대표에게 온 보고. 시스템 글·직원끼리의 지시는 뺀다. */
const REPORT_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(["완료", "진행", "질문", "막힘", "알림", "답변"]);
/** 답에 따라붙는 글. 답 하나마다 생겨 실제 보고를 밀어내므로 남는 칸에만 넣는다. */
const ECHO_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(["알림", "답변"]);
const KIND_TONE: Partial<Record<MessageKind, BadgeTone>> = { 완료: "ok", 질문: "accent", 막힘: "danger" };

const CHIPS: readonly { status: MemberStatus; label: string }[] = [
  { status: "working", label: "일함" },
  { status: "waiting", label: "내 답 기다림" },
  { status: "blocked", label: "승인 창 앞" },
  { status: "error", label: "오류" },
  { status: "idle", label: "대기" },
  { status: "asleep", label: "잠듦" },
  { status: "offline", label: "안 보임" },
];

const byCreated = <T extends { createdAt: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt);
const byNewest = <T extends { createdAt: string }>(a: T, b: T) => b.createdAt.localeCompare(a.createdAt);
const plainLine = (text: string) => text.split("\n").map((l) => l.replace(/[*_`#>~]+/g, "").trim()).find(Boolean) ?? "";

function Chevron() {
  return (
    <svg className="hm-chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Card({ title, count, more, children }: { title: string; count?: number; more?: { href: string; label: string }; children: ReactNode }) {
  return (
    <Glass as="section" level="regular" tint className="hm-card" aria-label={title}>
      <header className="hm-head">
        <h2 className="hm-head__title">{title}</h2>
        {count ? <span className="hm-count t-tabular">{count}</span> : null}
        {more ? (
          <a className="hm-head__more" href={more.href}>
            {more.label}
          </a>
        ) : null}
      </header>
      {children}
    </Glass>
  );
}

// ---- 지금 상황 ----

function NowCard({ now, at }: { now: string; at: string | null }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [now, open]);
  return (
    <Glass as="section" level="regular" tint className="hm-card hm-now" aria-label="지금 상황">
      <header className="hm-head">
        <h2 className="hm-head__title">지금 상황</h2>
        <Time iso={at} relative className="hm-head__time" />
      </header>
      <div ref={bodyRef} className="hm-now__body" data-open={open ? "" : undefined}>
        <Markdown text={now} />
      </div>
      {long ? (
        <button type="button" className="hm-more-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "접기" : "더 보기"}
          <Chevron />
        </button>
      ) : null}
    </Glass>
  );
}

// ---- 내가 할 일 ----

let shiftedAt = 0;

function TodoRow({ todo, onToggled, onError }: { todo: Todo; onToggled: (todo: Todo, done: boolean) => void; onError: (text: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const foldId = useId();
  const toggle = async () => {
    if (busy || Date.now() - shiftedAt < AFTER_SHIFT_MS) return;
    const next = !todo.done;
    setBusy(true);
    onError(null);
    onToggled(todo, next);
    applyLocal({ type: "todo", todo: { ...todo, done: next } });
    try {
      applyLocal({ type: "todo", todo: await api.todoDone(todo.id, next) });
    } catch (e) {
      applyLocal({ type: "todo", todo });
      onToggled(todo, todo.done);
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="hm-todo" data-todo={todo.id} data-done={todo.done ? "" : undefined} data-open={open ? "" : undefined}>
      <div className="hm-todo__line">
        {/* disabled 로 두면 처리 중에 초점이 문서 처음으로 날아가 키보드로 되돌릴 수 없다. */}
        <button type="button" className="hm-check" role="checkbox" aria-checked={todo.done} aria-label={`${todo.title} 했음`} aria-disabled={busy} onClick={() => void toggle()}>
          <i aria-hidden="true" />
        </button>
        <button type="button" className="hm-todo__toggle" aria-expanded={open} aria-controls={foldId} onClick={() => setOpen((v) => !v)}>
          <span className="hm-todo__title">{todo.title}</span>
          <Chevron />
        </button>
      </div>
      <div id={foldId} className="hm-fold">
        <div className="hm-fold__in">
          {todo.detail ? <Markdown text={todo.detail} className="hm-todo__detail" /> : null}
          {todo.done && todo.closedBy ? (
            <p className="hm-todo__meta">
              <span>
                {todo.closedBy} 정리{todo.closeReason ? `: ${todo.closeReason}` : ""}
              </span>
            </p>
          ) : null}
          <p className="hm-todo__meta">
            {todo.who ? <span>{todo.done && !todo.closedBy ? `${todo.who}에게 알림` : `${todo.who}의 요청`}</span> : null}
            <Time iso={todo.done ? (todo.doneAt ?? todo.createdAt) : todo.createdAt} />
          </p>
        </div>
      </div>
    </li>
  );
}

function TodoCard({ todos }: { todos: Todo[] }) {
  // 방금 체크해 아직 제자리에 있는 줄
  const [settling, setSettling] = useState<ReadonlySet<string>>(() => new Set());
  const [showDone, setShowDone] = useState(false);
  // 줄은 체크하는 사이 목록을 옮겨 다시 그려질 수 있어 오류는 판에 둔다.
  const [error, setError] = useState<string | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const focusAfter = useRef<string | null>(null);
  const foldRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const t of live.values()) clearTimeout(t);
    };
  }, []);

  // 눌렀던 체크 칸이 다른 목록으로 옮겨 갔다. 키보드로 눌렀으면 초점이 문서 처음으로 가지 않게 잇는다.
  useLayoutEffect(() => {
    const id = focusAfter.current;
    focusAfter.current = null;
    const active = document.activeElement;
    if (!id || (active && active !== document.body)) return;
    const target = document.querySelector<HTMLElement>(`[data-todo="${id}"] .hm-check`) ?? foldRef.current;
    target?.focus({ preventScroll: true });
  });

  const stopSettling = (id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setSettling((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  };

  const onToggled = (todo: Todo, done: boolean) => {
    stopSettling(todo.id);
    // 해제는 바로 위 목록으로 돌아간다.
    if (!done) {
      focusAfter.current = todo.id;
      return;
    }
    setSettling((s) => new Set(s).add(todo.id));
    timers.current.set(
      todo.id,
      setTimeout(() => {
        const row = document.querySelector(`[data-todo="${todo.id}"]`);
        if (row?.contains(document.activeElement)) focusAfter.current = todo.id;
        shiftedAt = Date.now();
        stopSettling(todo.id);
      }, SETTLE_MS),
    );
  };

  // AI 가 '필요 없어짐'으로 정리한 할 일은 대표가 할 일도, 한 일도 아니다.
  const sorted = todos.filter((t) => t.outcome !== "dropped").sort(byCreated);
  const live = sorted.filter((t) => !t.done || settling.has(t.id));
  const done = sorted.filter((t) => t.done && !settling.has(t.id)).reverse();
  const openCount = sorted.filter((t) => !t.done).length;
  if (sorted.length === 0) return null;

  return (
    <Card title="내가 할 일" count={openCount}>
      {live.length > 0 ? (
        <ul className="hm-todos">
          {live.map((t) => (
            <TodoRow key={t.id} todo={t} onToggled={onToggled} onError={setError} />
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="hm-error" role="alert">
          {error}
        </p>
      ) : null}
      {done.length > 0 ? (
        <div className="hm-done">
          <button ref={foldRef} type="button" className="hm-more-btn" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
            완료 {done.length}
            <Chevron />
          </button>
          {showDone ? (
            <ul className="hm-todos">
              {done.map((t) => (
                <TodoRow key={t.id} todo={t} onToggled={onToggled} onError={setError} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

// ---- 결재 대기 ----

function DecisionsCard({ projectId, decisions, blocked }: { projectId: string; decisions: Decision[]; blocked: Member[] }) {
  if (decisions.length + blocked.length === 0) return null;
  const rest = decisions.length - TOP_DECISIONS;
  return (
    <Card title="결재 대기" count={decisions.length + blocked.length} more={{ href: routeHash({ projectId, tab: "inbox" }), label: "결재함" }}>
      <ul className="hm-rows">
        {blocked.map((m) => (
          <li key={m.id}>
            <a className="hm-row" href={routeHash({ projectId, tab: "team", sub: m.id })}>
              <span className="hm-row__main">
                <span className="hm-row__title">{m.name}</span>
                <StatusDot status={m.status} label className="hm-row__status" />
              </span>
            </a>
          </li>
        ))}
        {decisions.slice(0, TOP_DECISIONS).map((d) => (
          <li key={d.id}>
            <a className="hm-row" href={routeHash({ projectId, tab: "inbox", sub: d.id })}>
              <span className="hm-row__main hm-row__main--stack">
                <span className="hm-row__title">{d.title}</span>
                {d.who ? <span className="hm-row__sub">{d.who}</span> : null}
              </span>
            </a>
          </li>
        ))}
      </ul>
      {rest > 0 ? <p className="hm-rest">외 {rest}건은 결재함에 있습니다</p> : null}
    </Card>
  );
}

// ---- 팀 ----

function TeamCard({ state }: { state: ProjectState }) {
  const { members, project } = state;
  const projectId = project.id;
  if (members.length === 0) return null;
  // 본사에는 팀 탭이 없다. 본사 AI 상세로 가는 줄만 둔다.
  if (project.isHq) {
    const lead = members.find((m) => m.kind === "root") ?? members[0]!;
    return (
      <Card title="본사 AI">
        <a className="hm-row" href={routeHash({ projectId, tab: "team", sub: lead.id })}>
          <span className="hm-row__main hm-row__main--stack">
            <span className="hm-row__title">
              {lead.name} <StatusDot status={lead.status} label className="hm-row__status" />
            </span>
            {lead.now ? <span className="hm-row__sub">{lead.now}</span> : null}
          </span>
        </a>
      </Card>
    );
  }
  const working = members.filter((m) => m.status === "working");
  return (
    <Card title="팀" more={{ href: routeHash({ projectId, tab: "team" }), label: "팀 보기" }}>
      <ul className="hm-chips">
        {CHIPS.map(({ status, label }) => {
          const n = members.filter((m) => m.status === status).length;
          return n > 0 ? (
            <li key={status} className="hm-chip" data-status={status}>
              <StatusDot status={status} />
              <span aria-hidden="true">{label}</span> <b className="t-tabular">{n}</b>
            </li>
          ) : null;
        })}
      </ul>
      {working.length > 0 ? (
        <ul className="hm-rows">
          {working.slice(0, TOP_WORKING).map((m) => (
            <li key={m.id}>
              <a className="hm-row" href={routeHash({ projectId, tab: "team", sub: m.id })}>
                <span className="hm-row__main hm-row__main--stack">
                  <span className="hm-row__title">{m.name}</span>
                  {m.now ? <span className="hm-row__sub">{m.now}</span> : null}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// ---- AI 일 ----

function WorkList({ label, items, total }: { label: string; items: WorkItem[]; total: number }) {
  if (items.length === 0) return null;
  return (
    <div className="hm-work">
      <h3 className="hm-work__label">{label}</h3>
      <ul className="hm-work__list">
        {items.map((w) => (
          <li key={w.id} className="hm-work__item">
            <span className="hm-work__title">{w.title}</span>
            {w.who ? <span className="hm-work__who">{w.who}</span> : null}
          </li>
        ))}
      </ul>
      {total > items.length ? <p className="hm-rest">외 {total - items.length}건</p> : null}
    </div>
  );
}

function WorkCard({ state }: { state: ProjectState }) {
  const sec = (s: WorkItem["sec"]) => state.work.filter((w) => w.sec === s).sort((a, b) => a.order - b.order);
  const doing = sec("doing");
  const next = sec("next");
  if (doing.length + next.length === 0) return null;
  const more = state.project.isHq ? undefined : { href: routeHash({ projectId: state.project.id, tab: "team" }), label: "일 목록" };
  return (
    <Card title="AI가 곧 할 일" more={more}>
      <WorkList label="진행 중" items={doing.slice(0, TOP_WORK)} total={doing.length} />
      <WorkList label="다음" items={next.slice(0, TOP_WORK)} total={next.length} />
    </Card>
  );
}

// ---- 최근 보고·자료 ----

function ReportsCard({ projectId, messages }: { projectId: string; messages: Message[] }) {
  const candidates = messages.filter((m) => !m.mine && REPORT_KINDS.has(m.kind));
  const main = candidates.filter((m) => !ECHO_KINDS.has(m.kind)).slice(-TOP_REPORTS);
  const room = TOP_REPORTS - main.length;
  const shown = new Set([...main, ...(room > 0 ? candidates.filter((m) => ECHO_KINDS.has(m.kind)).slice(-room) : [])]);
  const reports = candidates.filter((m) => shown.has(m)).reverse();
  if (reports.length === 0) return null;
  const href = routeHash({ projectId, tab: "thread" });
  return (
    <Card title="최근 보고" more={{ href, label: "대화" }}>
      <ul className="hm-rows">
        {reports.map((m) => (
          <li key={m.id}>
            <a className="hm-row" href={href}>
              <span className="hm-row__main hm-row__main--stack">
                <span className="hm-row__title">{m.title || plainLine(m.body)}</span>
                <span className="hm-row__sub hm-row__sub--meta">
                  <Badge tone={KIND_TONE[m.kind] ?? "neutral"}>{m.kind}</Badge>
                  <span className="hm-row__who">{m.who}</span>
                  <Time iso={m.at} relative />
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function FilesCard({ projectId, files }: { projectId: string; files: FileDoc[] }) {
  if (files.length === 0) return null;
  const recent = [...files].sort(byNewest).slice(0, TOP_FILES);
  return (
    <Card title="최근 자료" more={{ href: routeHash({ projectId, tab: "files" }), label: "자료" }}>
      <ul className="hm-rows">
        {recent.map((f) => (
          <li key={f.id}>
            <a className="hm-row" href={routeHash({ projectId, tab: "files", sub: f.id })}>
              <span className="hm-row__main hm-row__main--stack">
                <span className="hm-row__title">{f.title}</span>
                <span className="hm-row__sub hm-row__sub--meta">
                  {f.who ? <span className="hm-row__who">{f.who}</span> : null}
                  <Time iso={f.createdAt} relative />
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---- 판 정리 ----

/** 맡겼다는 알림은 잠깐만 둔다. */
const TIDY_NOTE_MS = 6000;

/** 총괄(본사는 본사 AI)에게 결재·할 일·진행판·지금 상황을 지금 상태로 맞추게 한다. 연결이 없으면 입력처럼 잠긴다. */
function TidyBar({ project }: { project: Project }) {
  const gate = useGate();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!note || note.error) return;
    const t = setTimeout(() => setNote(null), TIDY_NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);
  const tidy = async () => {
    if (busy || !gate.ok) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.tidy(project.id);
      const who = project.isHq ? "본사 AI" : "총괄";
      setNote({ text: r.already ? "판 정리 지시가 이미 기다리고 있습니다" : `${who}에게 판 정리를 맡겼습니다. 바뀐 게 있으면 대화에 알립니다`, error: false });
    } catch (e) {
      setNote({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="hm-tidy">
      <span className="hm-tidy__last">
        {project.tidiedAt ? (
          <>
            마지막 판 정리 <Time iso={project.tidiedAt} relative />
          </>
        ) : (
          "결재·할 일·진행판을 지금 상태로 맞춥니다"
        )}
      </span>
      <GlassButton variant="glass" size="m" className="hm-tidy__btn" disabled={busy || !gate.ok} onClick={() => void tidy()}>
        {busy ? "맡기는 중" : "지금 판 정리"}
      </GlassButton>
      {note ? (
        <p className={note.error ? "hm-error hm-tidy__note" : "hm-tidy__note"} role={note.error ? "alert" : "status"}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

// ---- 화면 ----

function HomeBody({ state }: { state: ProjectState }) {
  const wide = useMediaQuery(MQ_DESKTOP);
  const projectId = state.project.id;
  // 결재함과 같이 최신이 위(같은 ms 면 나중에 올라온 것이 위).
  const decisions = state.decisions.filter((d) => d.status === "open").reverse().sort((a, b) => byCreated(b, a));
  const blocked = state.members.filter((m) => m.status === "blocked");
  const nothingToDo = !state.todos.some((t) => !t.done) && decisions.length === 0 && blocked.length === 0;
  const working = state.members.some((m) => m.status === "working");

  const todoCard = <TodoCard todos={state.todos} />;
  const decisionsCard = <DecisionsCard projectId={projectId} decisions={decisions} blocked={blocked} />;
  const teamCard = <TeamCard state={state} />;
  const workCard = <WorkCard state={state} />;
  const reportsCard = <ReportsCard projectId={projectId} messages={state.messages} />;
  const filesCard = <FilesCard projectId={projectId} files={state.files} />;

  return (
    <div className="hm">
      <ConnectGate />
      <TidyBar project={state.project} />
      {state.project.now ? <NowCard now={state.project.now} at={state.project.nowAt} /> : null}
      {nothingToDo ? (
        <p className="hm-clear">
          <b>지금 하실 일이 없습니다.</b> {working ? "AI가 일하는 중입니다." : "새 일이 생기면 여기에 나타납니다."}
        </p>
      ) : null}
      {wide ? (
        <div className="hm-cols">
          <div className="hm-col">
            {todoCard}
            {decisionsCard}
            {reportsCard}
          </div>
          <div className="hm-col">
            {teamCard}
            {workCard}
            {filesCard}
          </div>
        </div>
      ) : (
        <div className="hm-col">
          {todoCard}
          {decisionsCard}
          {teamCard}
          {workCard}
          {reportsCard}
          {filesCard}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const state = useProject();
  if (!state) return null;
  // 프로젝트를 옮기면 펼침·제자리 줄을 잇지 않는다.
  return <HomeBody key={state.project.id} state={state} />;
}
