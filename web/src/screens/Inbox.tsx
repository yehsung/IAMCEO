// 결재함: 결재할 항목 · 결재된 항목 두 쪽. 선택지를 눌러도 바로 가지 않고, 카드 아래 확인 버튼을 눌러야 보낸다.
// 이번 방문에 답한 카드는 결재할 항목 쪽 제자리에 남아 '보냄 → 받음'을 보여 주고, 쪽을 옮기거나 다시 들어오면 결재된 항목으로 간다.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Attachment, Decision, Member } from "@shared/types";
import ApprovalPanel from "../components/ApprovalPanel";
import { enterSends, isComposing, useAutoGrow } from "../components/Composer";
import { useGate } from "../components/ConnectGate";
import { Badge, CONFIRM_MIN_MS, Empty, Markdown, Modal, StatusDot, Time } from "../components/ui";
import { Glass, GlassButton, glassClass } from "../glass";
import { ApiError, api, errorText, fileUrl, saveAttachment } from "../lib/api";
import { applyLocal, loadDecision, loadOlderDecisions, refresh, routeHash, useProject, useRoute } from "../lib/store";
import "../styles/inbox.css";

/** 처리된 결재는 서버가 이만큼씩 준다. */
const DONE_PAGE = 50;
/** 다른 곳의 변화로 자리가 움직인 직후의 누름은 확인으로 받지 않는다. */
const AFTER_SHIFT_MS = 500;
/** 결재된 항목 쪽 주소: #/p/<id>/inbox/done. 그 밖의 sub 는 결재 id 다. */
const DONE_SUB = "done";

let shiftedAt = 0;
const justShifted = () => Date.now() - shiftedAt < AFTER_SHIFT_MS;

// 탭을 오가도, 새로고침해도 쓰던 메모가 남고, 묶음 답에도 함께 실린다
const memoKey = (id: string) => `iamceo.memo.${id}`;
const memoDrafts = {
  get(id: string): string | undefined {
    try {
      return localStorage.getItem(memoKey(id)) ?? undefined;
    } catch {
      return undefined;
    }
  },
  /** keepEmpty: 직전 답을 돌려받은 칸을 일부러 비웠을 때. 빈 값을 남겨 직전 답이 다시 채워지거나 묶음 답에 실리지 않게 한다. */
  set(id: string, value: string, keepEmpty = false): void {
    try {
      if (value || keepEmpty) localStorage.setItem(memoKey(id), value);
      else localStorage.removeItem(memoKey(id));
    } catch {
      // 저장 공간이 없어도 입력은 계속된다.
    }
  },
  delete(id: string): void {
    memoDrafts.set(id, "");
  },
};

// 키보드로 답했을 때 초점을 잃지 않게 다음 그림에서 옮긴다.
let focusAfterAnswer: string | null = null;

const byCreated = <T extends { createdAt: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt);
const hasRec = (d: Decision) => d.rec !== null && d.options.some((o) => o.k === d.rec);

/** 고른 것. 선택지 k, 또는 글만 보내는 NOTE_ONLY. */
const NOTE_ONLY = "\0note";
type Picks = Readonly<Record<string, string>>;

/** 2단계의 둘째: 이 버튼을 눌러야 나간다. 나타난 직후(더블탭의 둘째)와 자리가 밀린 직후의 누름은 받지 않는다. */
function ConfirmBar({ quoted, label, hint, busy, disabled, pickKey, onConfirm, onCancel }: { quoted?: string; label: string; hint?: string; busy: boolean; disabled: boolean; pickKey?: string; onConfirm: () => void; onCancel: () => void }) {
  const shownAt = useRef(Date.now());
  const barRef = useRef<HTMLDivElement>(null);
  // 나타나거나 고른 것이 바뀌면 보이는 자리로 온다. 입력칸·탭 뒤에 가려지면 대표는 끝난 줄 알고 넘어간다.
  useEffect(() => {
    barRef.current?.scrollIntoView({ block: "nearest" });
  }, [pickKey]);
  return (
    <div ref={barRef} className="ibx-confirm">
      {hint ? <p className="ibx-confirm__hint">{hint}</p> : null}
      <div className="ibx-confirm__row">
        <GlassButton
          variant="primary"
          size="m"
          className="ibx-confirm__go"
          disabled={busy || disabled}
          onClick={() => {
            if (Date.now() - shownAt.current < CONFIRM_MIN_MS || justShifted()) return;
            onConfirm();
          }}
        >
          {busy ? (
            "보내는 중"
          ) : (
            // 고른 글이 길면 그 글만 줄이고 '(으)로 결정'은 늘 보인다.
            <span className="ibx-confirm__label">
              {quoted ? <span className="ibx-confirm__quoted">'{quoted}'</span> : null}
              <span className="ibx-confirm__verb">{label}</span>
            </span>
          )}
        </GlassButton>
        <GlassButton variant="ghost" size="m" disabled={busy} onClick={onCancel}>
          취소
        </GlassButton>
      </div>
    </div>
  );
}

function useAnswer(decision: Decision, onKeep: (id: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (choice: string | null, note: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onKeep(decision.id);
    const active = document.activeElement;
    const card = document.querySelector<HTMLElement>(`[data-decision="${decision.id}"]`);
    const hadFocus = !!card && !!active && card.contains(active);
    try {
      const answered = await api.answer(decision.id, { choice, note: note.trim() || null });
      memoDrafts.delete(decision.id);
      if (hadFocus) focusAfterAnswer = decision.id;
      applyLocal({ type: "decision", decision: answered });
    } catch (e) {
      setError(errorText(e));
      // 다른 곳에서 이미 답했거나, 연결이 끊겼거나, 응답만 잃었을 수 있다. 서버에 물어 화면을 실제 상태로 바꾼다.
      if (e instanceof ApiError && (e.status === 409 || e.status === 0)) void refresh();
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function CardTop({ decision, children }: { decision: Decision; children?: ReactNode }) {
  return (
    <div className="ibx-top">
      <span className="ibx-top__who">{decision.who}</span>
      {children}
      <Time iso={decision.answeredAt ?? decision.closedAt ?? decision.createdAt} relative className="ibx-top__time" />
    </div>
  );
}

/** 결재의 배경: 글·그림·자료 링크. 결재 카드와 펼친 결재된 항목이 함께 쓴다. */
function Background({ decision, fileTitle, onZoom }: { decision: Decision; fileTitle: string | null; onZoom: (a: Attachment) => void }) {
  return (
    <>
      {decision.detail ? <Markdown text={decision.detail} className="ibx-detail" /> : null}
      {decision.images.length > 0 ? (
        <div className="ibx-images">
          {decision.images.map((a) => (
            <button key={a.id} type="button" className="ibx-thumb" aria-label={`${a.name} 크게 보기`} onClick={() => onZoom(a)}>
              <img src={fileUrl(a)} alt={a.name} loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
      {decision.fileId ? (
        <a className="ibx-file" href={routeHash({ projectId: decision.projectId, tab: "files", sub: decision.fileId })}>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M4 1.8h5l3.2 3.2v9.2H4zM9 1.8V5h3.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          <span>{fileTitle ?? "자료 보기"}</span>
        </a>
      ) : null}
    </>
  );
}

interface CardProps {
  decision: Decision;
  fileTitle: string | null;
  pick: string | null;
  locked: boolean;
  onPick: (id: string, pick: string | null) => void;
  onKeep: (id: string) => void;
  onZoom: (a: Attachment) => void;
}

function DecisionCard({ decision, fileTitle, pick, locked, onPick, onKeep, onZoom }: CardProps) {
  const { busy, error, submit } = useAnswer(decision, onKeep);
  const [note, setNote] = useState(() => memoDrafts.get(decision.id) ?? decision.lastNote ?? "");
  // 카드를 연 채로 다시 열린 경우에도 직전 답을 돌려준다. 그새 쓴 글은 덮지 않는다.
  useEffect(() => {
    if (decision.lastNote && memoDrafts.get(decision.id) === undefined) setNote(decision.lastNote);
  }, [decision.id, decision.lastNote, decision.updatedAt]);
  const memoRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(memoRef, note);
  const free = decision.options.length === 0;
  const typed = note.trim().length > 0;
  const option = decision.options.find((o) => o.k === pick);
  // 글만 보내려던 참인데 글을 다 지웠으면 고를 것이 없다.
  const noteOnly = pick === NOTE_ONLY && typed;
  const choosing = !!option || noteOnly;
  const armNote = () => {
    if (typed && !busy && !locked) onPick(decision.id, NOTE_ONLY);
  };
  const onMemoKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 자유 답은 입력칸과 같게 Enter 로 넘어간다. 선택지 카드의 메모는 줄바꿈만.
    if (!free || isComposing(e) || !enterSends(e)) return;
    e.preventDefault();
    armNote();
  };
  const quoted = option ? option.label : free ? note.trim() : undefined;
  const lastPick = decision.options.find((o) => o.k === decision.lastChoice)?.label ?? decision.lastChoice;
  return (
    <Glass as="article" level="regular" tint className="ibx-card" data-decision={decision.id}>
      <CardTop decision={decision} />
      {decision.reopenNote ? (
        <p className="ibx-reopened" role="status">
          {decision.reopenNote}
          {lastPick ? ` · 직전 답: ${lastPick}` : ""}
        </p>
      ) : null}
      <h3 className="ibx-title">{decision.title}</h3>
      <Background decision={decision} fileTitle={fileTitle} onZoom={onZoom} />
      {free ? null : (
        <div className="ibx-opts" data-few={decision.options.length <= 3 ? "" : undefined}>
          {decision.options.map((o) => (
            <button
              key={o.k}
              type="button"
              className="ibx-opt"
              data-rec={o.k === decision.rec ? "" : undefined}
              aria-pressed={pick === o.k}
              disabled={busy || locked}
              onClick={() => onPick(decision.id, o.k)}
            >
              <span className="ibx-opt__label">
                {o.label}
                {o.k === decision.rec ? <Badge tone="accent">권장</Badge> : null}
                {pick === o.k ? (
                  <svg className="ibx-opt__check" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                    <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </span>
              {o.desc ? <span className="ibx-opt__desc">{o.desc}</span> : null}
            </button>
          ))}
        </div>
      )}
      <div className="ibx-memo">
        <textarea
          ref={memoRef}
          className="input ibx-memo__input"
          rows={1}
          value={note}
          disabled={locked}
          aria-label={free ? "답" : "메모"}
          placeholder={free ? "답을 적어 주세요" : "메모 (선택) — 다른 생각이나 조건"}
          enterKeyHint={free && !window.matchMedia("(pointer: coarse)").matches ? "next" : "enter"}
          onChange={(e) => {
            setNote(e.target.value);
            memoDrafts.set(decision.id, e.target.value, decision.lastNote !== null);
          }}
          onKeyDown={onMemoKey}
        />
        {(free || typed) && !choosing ? (
          <GlassButton variant="glass" size="m" disabled={!typed || busy || locked} onClick={armNote}>
            {free ? "답 보내기" : "메모만 보내기"}
          </GlassButton>
        ) : null}
      </div>
      {choosing ? (
        <ConfirmBar
          quoted={quoted}
          label={quoted ? "(으)로 결정" : "메모만 보내기로 결정"}
          busy={busy}
          disabled={locked}
          pickKey={option?.k ?? NOTE_ONLY}
          onCancel={() => onPick(decision.id, null)}
          onConfirm={() => void submit(option?.k ?? null, note)}
        />
      ) : null}
      {error ? (
        <p className="ibx-error" role="alert">
          {error}
        </p>
      ) : null}
    </Glass>
  );
}

function AnswerFlow({ decision }: { decision: Decision }) {
  if (decision.status === "closed") return <Badge>닫힘</Badge>;
  const got = decision.status === "delivered";
  return (
    <span className="ibx-flow" role="status" aria-label={got ? `${decision.who}이(가) 받음` : "보냄, 아직 받기 전"}>
      <span data-on="">보냄</span>
      <svg viewBox="0 0 12 8" width="12" height="8" aria-hidden="true">
        <path d="M1 4h9M7.5 1.5L10 4 7.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span data-on={got ? "" : undefined}>받음</span>
    </span>
  );
}

function answerLabel(d: Decision): string {
  const chosen = d.options.find((o) => o.k === d.choice)?.label ?? d.choice;
  if (!chosen) return d.note ? "" : "답 없음";
  return d.batch ? `${chosen} (묶음 추천대로)` : chosen;
}

const CLOSE_KIND_LABEL: Record<NonNullable<Decision["closeKind"]>, string> = { decided: "대표가 이미 정함", obsolete: "필요 없어짐" };

/** 닫힌 카드: 답 대신 '닫힘 · 이유'와 누가 닫았는지, 대표가 정했다는 근거. */
function ClosedNote({ decision }: { decision: Decision }) {
  const meta = [decision.closeKind ? CLOSE_KIND_LABEL[decision.closeKind] : null, decision.closedBy ? `닫은 이: ${decision.closedBy}` : null].filter(Boolean).join(" · ");
  return (
    <>
      <p className="ibx-answered__text ibx-closed">닫힘{decision.closeReason ? ` · ${decision.closeReason}` : ""}</p>
      {meta ? <p className="ibx-closed__meta">{meta}</p> : null}
      {decision.closeQuote ? <p className="ibx-closed__meta">근거로 든 대표 말: '{decision.closeQuote}'</p> : null}
    </>
  );
}

function AnsweredBody({ decision }: { decision: Decision }) {
  const closed = decision.status === "closed";
  const label = closed ? "" : answerLabel(decision);
  return (
    <>
      <CardTop decision={decision}>
        <AnswerFlow decision={decision} />
      </CardTop>
      <p className="ibx-answered__title">{decision.title}</p>
      {closed ? <ClosedNote decision={decision} /> : null}
      {label ? <p className="ibx-answered__text">답: {label}</p> : null}
      {decision.note ? <p className="ibx-answered__text">메모: {decision.note}</p> : null}
    </>
  );
}

/** AI 가 닫은 카드를 결재할 항목으로 되돌린다. */
function ReopenButton({ decision }: { decision: Decision }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reopen = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      applyLocal({ type: "decision", decision: await api.reopenDecision(decision.id) });
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && (e.status === 409 || e.status === 0)) void refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ibx-reopen">
      <GlassButton variant="glass" size="m" disabled={busy} onClick={() => void reopen()}>
        {busy ? "여는 중" : "다시 열기"}
      </GlassButton>
      <span className="ibx-reopen__hint">결재할 항목으로 돌아갑니다</span>
      {error ? (
        <p className="ibx-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 막 답한 카드. 제자리에 남아 전달 상태를 보여 준다. */
function AnsweredCard({ decision }: { decision: Decision }) {
  return (
    <Glass as="article" level="regular" tint className="ibx-card ibx-card--answered" tabIndex={-1} data-answered-card={decision.id}>
      <div className="ibx-answered" data-decision={decision.id}>
        <AnsweredBody decision={decision} />
      </div>
    </Glass>
  );
}

/** 결재된 항목 한 줄. 누르면 펼쳐 배경을 본다. */
function DoneRow({ decision, fileTitle, expanded, onToggle, onZoom }: { decision: Decision; fileTitle: string | null; expanded: boolean; onToggle: () => void; onZoom: (a: Attachment) => void }) {
  const hasMore = !!decision.detail || decision.images.length > 0 || !!decision.fileId;
  return (
    <li className="ibx-answered ibx-done__row" data-decision={decision.id}>
      <AnsweredBody decision={decision} />
      {decision.status === "closed" && decision.closeKind ? <ReopenButton decision={decision} /> : null}
      {hasMore ? (
        <button type="button" className="ibx-more" aria-expanded={expanded} onClick={onToggle}>
          배경 {expanded ? "접기" : "보기"}
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      {expanded && hasMore ? (
        <div className="ibx-done__bg">
          <Background decision={decision} fileTitle={fileTitle} onZoom={onZoom} />
        </div>
      ) : null}
    </li>
  );
}

function DecisionGroup({ name, decisions, picks, locked, render, onKeep, single }: { single: boolean; name: string; decisions: Decision[]; picks: Picks; locked: boolean; render: (d: Decision) => ReactNode; onKeep: (id: string) => void }) {
  const open = decisions.filter((d) => d.status === "open");
  // 직접 다른 것을 고른 카드를 권장안으로 덮지 않는다.
  const targets = open.filter((d) => hasRec(d) && (picks[d.id] === undefined || picks[d.id] === d.rec));
  const skipped = open.length - targets.length;
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 묻기 시작할 때 대표가 본 카드. 확인은 이 카드들에만 간다. */
  const armedIds = useRef<ReadonlySet<string>>(new Set());
  const sectionRef = useRef<HTMLElement>(null);

  // 묻는 사이 새 카드가 왔거나 대상이 빠졌다. 안 읽은 카드까지 승인되거나 버튼의 건수가 실제와 어긋나면 안 되니 처음부터 다시 묻는다. 보내는 중에 줄어드는 것은 답이 나간 것이다.
  const changed = armed && !busy && (targets.length !== armedIds.current.size || targets.some((d) => !armedIds.current.has(d.id)));
  useEffect(() => {
    if (changed) setArmed(false);
  }, [changed]);

  const arm = () => {
    armedIds.current = new Set(targets.map((d) => d.id));
    setError(null);
    setArmed(true);
  };

  const confirm = async () => {
    const confirmed = targets.filter((d) => armedIds.current.has(d.id));
    setBusy(true);
    setError(null);
    confirmed.forEach((d) => onKeep(d.id));
    const results = await Promise.allSettled(
      confirmed.map(async (d) => {
        const answered = await api.answer(d.id, { choice: d.rec, note: (memoDrafts.get(d.id) ?? d.lastNote)?.trim() || null, batch: true });
        memoDrafts.delete(d.id);
        applyLocal({ type: "decision", decision: answered });
      }),
    );
    const failed = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    if (failed.length > 0) setError(`${failed.length}건을 보내지 못했습니다: ${errorText(failed[0])}`);
    if (failed.some((e) => e instanceof ApiError && (e.status === 409 || e.status === 0))) void refresh();
    setArmed(false);
    setBusy(false);
    // 눌렀던 버튼이 사라졌다. 키보드로 눌렀으면 초점이 문서 처음으로 가지 않게 묶음 안으로 옮긴다.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      sectionRef.current?.querySelector<HTMLElement>("[data-answered-card], .ibx-opt, .ibx-memo__input")?.focus({ preventScroll: true });
    });
  };

  const showConfirm = armed && !changed;
  return (
    <section ref={sectionRef} className="ibx-group" aria-label={`묶음: ${name}`}>
      <div className="ibx-group__head" hidden={single}>
        <div className="ibx-group__name">
          <span>{name}</span>
          {skipped > 0 && targets.length > 0 ? <small>권장이 없거나 직접 고른 {skipped}건은 따로 결정해 주세요</small> : null}
        </div>
        {targets.length > 0 ? (
          <GlassButton variant="glass" size="m" className="ibx-group__batch" ariaPressed={showConfirm} disabled={busy || locked} onClick={arm}>
            이 묶음 추천대로
          </GlassButton>
        ) : null}
      </div>
      {showConfirm && !single ? (
        <ConfirmBar label={`묶음 ${armedIds.current.size}건 결정`} hint="각 카드의 권장안으로 결정합니다" busy={busy} disabled={locked} onCancel={() => setArmed(false)} onConfirm={() => void confirm()} />
      ) : null}
      {error ? (
        <p className="ibx-error" role="alert">
          {error}
        </p>
      ) : null}
      {decisions.map(render)}
    </section>
  );
}

/** 승인 창 앞에서 멈춘 세션은 결재 카드가 없어도 대표가 풀어 줘야 한다. 결재함이 비었다고 말하면 할 일이 없는 줄 안다.
 *  승인 창을 읽을 수 있으면 여기서 고르고 확인해 승인·거절한다. 못 읽으면 터미널에서 풀라고 안내한다. */
function BlockedList({ members, projectName }: { members: Member[]; projectName: string }) {
  return (
    <section className="ibx-sec" aria-label="승인 대기">
      <h2 className="ibx-sec__head">
        승인 대기 <Count n={members.length} />
      </h2>
      {members.map((m) => (
        <Glass key={m.id} as="article" level="regular" tint className="ibx-card ibx-approval" aria-label={`${m.name} 승인 창`}>
          <a className="ibx-blocked__row" href={routeHash({ projectId: m.projectId, tab: "team", sub: m.id })}>
            <StatusDot status={m.status} />
            <span className="ibx-blocked__name">{m.name}</span>
            <span className="ibx-blocked__where">{[m.role && m.role !== m.name ? m.role : null, projectName].filter(Boolean).join(" · ")}</span>
            <span className="ibx-blocked__more">화면 보기</span>
          </a>
          <ApprovalPanel member={m} justShifted={justShifted} fallback={<p className="ibx-blocked__hint">여기서 답할 수 없는 창입니다. 화면을 보고 터미널에서 승인하거나 거절하세요.</p>} />
        </Glass>
      ))}
    </section>
  );
}

/** 본사에는 팀 탭이 없다. 본사 AI 의 상태와 상세(활동·화면·중단)로 가는 길을 여기 둔다. */
export function HqLeadStrip({ lead }: { lead: Member }) {
  return (
    <a className="ibx-lead" href={routeHash({ projectId: lead.projectId, tab: "team", sub: lead.id })}>
      <span className="ibx-lead__name">{lead.name}</span>
      <StatusDot status={lead.status} label />
      <span className="ibx-lead__more">상세 보기</span>
    </a>
  );
}

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="ibx-count t-tabular">{n}</span> : null;
}

/** 카드마다 스크롤 안의 위아래 위치. */
function measureCards(root: HTMLElement | null) {
  const scroller = root?.closest<HTMLElement>("[data-scroll-root]");
  if (!root || !scroller) return null;
  const box = scroller.getBoundingClientRect();
  const tops = new Map<string, number>();
  const bottoms = new Map<string, number>();
  for (const card of root.querySelectorAll<HTMLElement>("[data-decision]")) {
    const rect = card.getBoundingClientRect();
    tops.set(card.dataset.decision!, rect.top - box.top + scroller.scrollTop);
    bottoms.set(card.dataset.decision!, rect.bottom - box.top + scroller.scrollTop);
  }
  return { scroller, tops, bottoms, scrollTop: scroller.scrollTop };
}

export default function Inbox() {
  const state = useProject();
  const route = useRoute();
  const gate = useGate();
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const [picks, setPicks] = useState<Picks>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [zoom, setZoom] = useState<Attachment | null>(null);
  const [moreDone, setMoreDone] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const jumped = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 그리기 전에 잰다. 앞 그림 때 잰 값은 메모가 늘거나 답한 카드가 접히면 이미 낡았다.
  const beforePaint = measureCards(rootRef.current);

  const projectId = route.projectId;
  const sub = route.tab === "inbox" ? route.sub : null;
  const jumpTo = sub && sub !== DONE_SUB ? sub : null;
  const jumpDecision = jumpTo ? state?.decisions.find((d) => d.id === jumpTo) ?? null : null;
  // 결재 링크는 그 결재가 있는 쪽을 연다.
  const view = sub === DONE_SUB || (jumpDecision && jumpDecision.status !== "open" && !kept.has(jumpDecision.id)) ? "done" : "open";

  useEffect(() => {
    setMoreDone(true);
    setMoreError(null);
  }, [projectId]);

  // 쪽을 옮기면 맨 위부터, 이번 방문의 '받음' 카드는 결재된 항목으로 넘어간다.
  const lastView = useRef(view);
  useEffect(() => {
    if (lastView.current === view) return;
    lastView.current = view;
    setKept(new Set());
    if (!jumpTo) rootRef.current?.closest("[data-scroll-root]")?.scrollTo(0, 0);
  }, [view, jumpTo]);

  // 주소로 온 결재가 목록(처리된 최근 50건) 밖이면 하나만 받아 온다. 옛 대화의 링크가 갈 곳을 잃지 않게 한다.
  const missingJump = jumpTo && state && !jumpDecision ? jumpTo : null;
  useEffect(() => {
    if (!missingJump) return;
    void loadDecision(missingJump).catch(() => {});
  }, [missingJump]);

  // 새 카드가 끼거나 다른 기기의 답으로 카드가 빠지면 자리가 밀린다. 보던 카드를 제자리에 두고, 그래도 움직였으면 잠시 확인을 받지 않는다.
  useLayoutEffect(() => {
    const before = beforePaint;
    const now = measureCards(rootRef.current);
    if (!before || !now) return;
    const moved = [...now.tops].some(([id, top]) => before.tops.has(id) && Math.abs(before.tops.get(id)! - top) > 4);
    if (!moved) return;
    shiftedAt = Date.now();
    // 앞서 화면에 보이던 첫 카드를 기준으로 되돌린다.
    const anchor = [...before.bottoms].find(([id, bottom]) => now.tops.has(id) && bottom > before.scrollTop)?.[0];
    if (anchor) now.scroller.scrollTop += now.tops.get(anchor)! - before.tops.get(anchor)!;
  });

  // 대화의 '결재함에서 답하기' 링크: 그 카드로 간다. 결재된 항목이면 펼친다.
  useEffect(() => {
    if (!jumpTo) jumped.current = null;
    if (!jumpTo || !jumpDecision || jumped.current === jumpTo) return;
    jumped.current = jumpTo;
    if (jumpDecision.status !== "open") setExpanded((s) => new Set(s).add(jumpTo));
    // Shell 이 탭이 바뀔 때 맨 위로 올리는 효과가 이 뒤에 돈다. 그림이 끝난 뒤 움직인다.
    const frame = requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(`[data-decision="${jumpTo}"]`);
      if (!card) return;
      card.scrollIntoView({ block: "center" });
      card.setAttribute("data-flash", "");
      setTimeout(() => card.removeAttribute("data-flash"), 1800);
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpTo, jumpDecision]);

  useLayoutEffect(() => {
    const id = focusAfterAnswer;
    if (!id) return;
    focusAfterAnswer = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.querySelector<HTMLElement>(`[data-answered-card="${id}"]`)?.focus({ preventScroll: true });
  });

  // 답이 나간 카드의 고름은 지운다. 다시 열렸을 때 확인 띠가 저절로 뜨지 않고, 대표가 다시 고른다.
  const decisionList = state?.decisions;
  useEffect(() => {
    setPicks((all) => {
      const stale = decisionList?.filter((d) => d.status !== "open" && all[d.id] !== undefined) ?? [];
      if (stale.length === 0) return all;
      const next = { ...all };
      for (const d of stale) delete next[d.id];
      return next;
    });
  }, [decisionList]);

  if (!state) return null;

  const keep = (id: string) => setKept((s) => new Set(s).add(id));
  const pick = (id: string, value: string | null) =>
    setPicks((all) => {
      const next = { ...all };
      if (value === null) delete next[id];
      else next[id] = value;
      return next;
    });
  const fileTitleOf = (d: Decision) => state.files.find((f) => f.id === d.fileId)?.title ?? null;

  // 최신 결재가 맨 위. 미뤄 둔 옛 결재가 위를 차지하면 새로 온 것을 놓친다.
  // 목록은 올라온 차례(서버: 시각·등록 순)라 뒤집은 뒤 정렬한다. 같은 ms 에 올라온 것도 나중 것이 위다.
  const decisions = [...state.decisions].reverse().sort((a, b) => byCreated(b, a));
  const live = decisions.filter((d) => d.status === "open" || kept.has(d.id));
  const openCount = decisions.filter((d) => d.status === "open").length;
  const doneDecisions = state.decisions
    .filter((d) => d.status !== "open")
    .sort((a, b) => (b.answeredAt ?? b.createdAt).localeCompare(a.answeredAt ?? a.createdAt));
  const doneCount = Math.max(state.doneDecisionCount, doneDecisions.length);

  const renderCard = (d: Decision) =>
    d.status === "open" ? (
      <DecisionCard key={d.id} decision={d} fileTitle={fileTitleOf(d)} pick={picks[d.id] ?? null} locked={!gate.ok} onPick={pick} onKeep={keep} onZoom={setZoom} />
    ) : (
      <AnsweredCard key={d.id} decision={d} />
    );

  // 묶음은 가장 새 카드 자리에 모아 두고, 묶음 안은 물어본 차례(오래된 것부터)로 둔다. 카드가 하나뿐이어도 트리는 같게 둔다(머리줄만 숨긴다). 낱장으로 두면 둘째 카드가 올 때 다시 마운트되어 쓰던 메모의 초점을 잃는다.
  const groupCounts = new Map<string, number>();
  for (const d of live) if (d.group) groupCounts.set(d.group, (groupCounts.get(d.group) ?? 0) + 1);
  const seen = new Set<string>();
  const blocks = live.flatMap((d) => {
    if (!d.group) return [renderCard(d)];
    if (seen.has(d.group)) return [];
    seen.add(d.group);
    const group = d.group;
    return [<DecisionGroup key={`group:${group}`} name={group} decisions={live.filter((x) => x.group === group).reverse().sort(byCreated)} picks={picks} locked={!gate.ok} render={renderCard} onKeep={keep} single={(groupCounts.get(group) ?? 0) < 2} />];
  });

  const working = state.members.some((m) => m.status === "working");
  const blocked = state.members.filter((m) => m.status === "blocked");
  const hqLead = state.project.isHq ? state.members.find((m) => m.kind === "root") : null;
  const moreAvailable = moreDone && doneDecisions.length < doneCount;
  const loadMore = () => {
    setLoadingMore(true);
    setMoreError(null);
    void loadOlderDecisions(DONE_PAGE)
      .then(setMoreDone)
      .catch((e: unknown) => setMoreError(errorText(e)))
      .finally(() => setLoadingMore(false));
  };

  return (
    <div ref={rootRef} className="ibx">
      {hqLead ? <HqLeadStrip lead={hqLead} /> : null}
      <nav className={`${glassClass("thin")} ibx-seg`} aria-label="결재 분류">
        <a className="ibx-seg__item" href={routeHash({ projectId, tab: "inbox" })} aria-current={view === "open" ? "page" : undefined}>
          결재할 항목 <span className="t-tabular">{openCount}</span>
        </a>
        <a className="ibx-seg__item" href={routeHash({ projectId, tab: "inbox", sub: DONE_SUB })} aria-current={view === "done" ? "page" : undefined}>
          결재된 항목 <span className="t-tabular">{doneCount}</span>
        </a>
      </nav>

      {view === "open" ? (
        <>
          {blocked.length > 0 ? <BlockedList members={blocked} projectName={state.project.name} /> : null}
          {live.length === 0 && blocked.length === 0 ? (
            <Glass level="regular" tint className="ibx-empty">
              <Empty title="결재할 항목이 없습니다">{working ? (state.project.isHq ? "본사 AI 가 일하는 중입니다. 대화에서 상황을 볼 수 있습니다." : "직원들이 일하는 중입니다. 대화나 팀에서 상황을 볼 수 있습니다.") : "새 결재가 오면 여기에 나타납니다."}</Empty>
            </Glass>
          ) : null}
          {live.length > 0 ? (
            <section className="ibx-sec" aria-label="결재할 항목">
              {blocks}
            </section>
          ) : null}
        </>
      ) : doneDecisions.length === 0 ? (
        <Glass level="regular" tint className="ibx-empty">
          <Empty title="결재된 항목이 없습니다">결정한 결재가 여기에 쌓입니다.</Empty>
        </Glass>
      ) : (
        <section className="ibx-sec" aria-label="결재된 항목">
          <Glass as="ul" level="regular" tint className="ibx-done">
            {doneDecisions.map((d) => (
              <DoneRow
                key={d.id}
                decision={d}
                fileTitle={fileTitleOf(d)}
                expanded={expanded.has(d.id)}
                onZoom={setZoom}
                onToggle={() =>
                  setExpanded((s) => {
                    const next = new Set(s);
                    if (!next.delete(d.id)) next.add(d.id);
                    return next;
                  })
                }
              />
            ))}
          </Glass>
          {moreAvailable ? (
            <GlassButton variant="ghost" size="m" className="ibx-loadmore" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "불러오는 중" : "더 불러오기"}
            </GlassButton>
          ) : null}
          {moreError ? (
            <p className="ibx-error" role="alert">
              {moreError}
            </p>
          ) : null}
        </section>
      )}

      <Modal open={zoom !== null} onClose={() => setZoom(null)} title={zoom?.name}>
        {zoom ? (
          <figure className="ibx-zoom">
            <img src={fileUrl(zoom)} alt={zoom.name} />
            <figcaption>
              <a
                className="ibx-zoom__open"
                href={zoom.url}
                download={zoom.name}
                onClick={(e) => {
                  e.preventDefault();
                  void saveAttachment(zoom).catch(() => undefined);
                }}
              >
                받기
              </a>
            </figcaption>
          </figure>
        ) : null}
      </Modal>
    </div>
  );
}
