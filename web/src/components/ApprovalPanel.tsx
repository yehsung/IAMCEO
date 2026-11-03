// 승인 창 답하기: herdr 칸에 뜬 Claude Code 권한 승인 창을 읽어 보여 주고, 대표가 고른 뒤 확인을 눌러야 칸에서 그 선택지를 누른다.
// 글은 화면에서 읽은 그대로다(번역하지 않는다). 서버는 누르기 직전에 창을 다시 읽어 같을 때만 누른다.
// 승인 창으로 알아보지 못하면(폴더 신뢰 창·다른 선택 창) fallback(터미널에서 풀라는 안내)을 그린다. 결재함과 팀 화면이 함께 쓴다.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ApprovalOption, ApprovalPrompt, Member } from "@shared/types";
import { GlassButton, cx } from "../glass";
import { ApiError, api, errorText } from "../lib/api";
import { useAutoGrow } from "./Composer";
import { Badge, CONFIRM_MIN_MS } from "./ui";
import "../styles/approval.css";

/** 누른 뒤 다음 창이 바로 뜨면 상태가 그대로 승인 창 앞일 수 있다. 이만큼 뒤에 한 번 다시 읽는다. */
const REREAD_AFTER_SEND_MS = 1500;
/** 서버가 받는 전할 말 길이 상한 */
const NOTE_MAX = 4000;

/** 이번 한 번이 아니라 세션의 권한 설정을 바꾸는 선택지. 대표가 모르고 넘기지 않게 따로 적는다. */
const PERSISTS = /don'?t ask again|do not ask again|always allow|allow all|during this session|for this session|auto-accept|accept edits|bypass|switch to .*mode/i;

const persists = (o: ApprovalOption) => !o.reject && PERSISTS.test(o.label);

/** 승인 창은 herdr 칸에만 뜬다. 다른 칸은 읽지 않고 바로 안내를 그린다. */
const readable = (m: Member) => m.backend === "herdr" && !!m.paneId;

function OptionTags({ o }: { o: ApprovalOption }) {
  return (
    <>
      {o.reject ? <Badge tone="danger">거절</Badge> : /^yes\b/i.test(o.label.trim()) ? <Badge tone="ok">승인</Badge> : null}
      {persists(o) ? <span className="apv-opt__persist">이후에도 적용</span> : null}
    </>
  );
}

export interface ApprovalPanelProps {
  member: Member;
  /** 승인 창으로 알아보지 못했을 때 그릴 안내(터미널에서 풀라는 글) */
  fallback: ReactNode;
  /** 승인 창을 그릴 때 판 테두리를 두른다(팀 화면처럼 카드 밖에 놓일 때). */
  boxed?: boolean;
  /** 화면 자리가 막 밀렸으면 true. 그 순간의 누름은 확인으로 받지 않는다(결재함). */
  justShifted?: () => boolean;
}

export default function ApprovalPanel({ member, fallback, boxed, justShifted }: ApprovalPanelProps) {
  const canRead = readable(member);
  /** undefined: 아직 읽는 중 */
  const [approval, setApproval] = useState<ApprovalPrompt | null | undefined>(canRead ? undefined : null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 누르고 난 뒤의 한 줄. 직원 상태가 바뀌면 판이 닫힌다. */
  const [sent, setSent] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const shownFp = useRef<string | null>(null);
  const sentRef = useRef(false);
  const busyRef = useRef(false);
  const pickedAt = useRef(0);
  const seq = useRef(0);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useAutoGrow(noteRef, note);

  // 고르면 확인 버튼이 보이는 자리로 온다. 입력칸·판 끝에 가려지면 대표는 끝난 줄 알고 넘어간다.
  useEffect(() => {
    if (pick !== null) confirmRef.current?.scrollIntoView({ block: "nearest" });
  }, [pick]);

  const read = useCallback(async () => {
    if (!canRead) return;
    const token = ++seq.current;
    setReading(true);
    try {
      const next = (await api.approval(member.id)).approval;
      if (token !== seq.current) return;
      // 누른 뒤 창이 닫혔는데 상태가 아직 안 왔다. 안내로 바꾸지 않고 누른 줄을 둔다.
      if (!next && sentRef.current) return;
      // 누른 뒤에 또 창이 있으면 다음 창이다. 같은 명령을 다시 물으면 내용까지 같을 수 있어 fingerprint 로 가르지 않는다.
      if (next && sentRef.current) {
        sentRef.current = false;
        setSent(null);
        setNotice("누른 뒤 승인 창이 또 떴습니다. 내용을 보고 다시 고르세요.");
      }
      // 창이 바뀌었으면 고른 것을 지운다. 번호가 같아도 뜻이 다를 수 있다.
      if ((next?.fingerprint ?? null) !== shownFp.current) setPick(null);
      shownFp.current = next?.fingerprint ?? null;
      setApproval(next);
      setReadError(null);
    } catch (e) {
      if (token !== seq.current) return;
      if (e instanceof ApiError && e.status === 501) {
        // 실행기가 지원하지 않는다(headless). 읽을 창이 없는 것과 같다.
        shownFp.current = null;
        setApproval(null);
        setReadError(null);
      } else {
        setReadError(errorText(e));
        setApproval((a) => (a === undefined ? null : a));
      }
    } finally {
      if (token === seq.current) setReading(false);
    }
  }, [member.id, canRead]);

  // 처음과, 직원 정보가 바뀔 때(같은 승인 창 앞이어도 다음 창일 수 있다) 다시 읽는다. 누르는 중에는 읽지 않는다.
  useEffect(() => {
    if (!busyRef.current) void read();
  }, [read, member.updatedAt]);

  // 판이 닫히면 늦게 온 답을 버린다.
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );

  // 누른 뒤에도 승인 창 앞이면 다음 창일 수 있다. 한 번 다시 읽는다.
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => void read(), REREAD_AFTER_SEND_MS);
    return () => clearTimeout(t);
  }, [sent, read]);

  const choose = (n: number | null) => {
    pickedAt.current = Date.now();
    setError(null);
    setNotice(null);
    setPick(n);
  };

  const option = approval?.options.find((o) => o.n === pick) ?? null;

  const confirm = async () => {
    if (!approval || !option || busyRef.current) return;
    // 고른 직후(더블탭의 둘째)와 자리가 밀린 직후의 누름은 받지 않는다.
    if (Date.now() - pickedAt.current < CONFIRM_MIN_MS || justShifted?.()) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const text = option.reject ? note.trim() : "";
    let reload = false;
    try {
      await api.answerApproval(member.id, { fingerprint: approval.fingerprint, option: option.n, ...(text ? { note: text } : {}) });
      sentRef.current = true;
      setSent(`눌렀습니다: ${option.n}. ${option.label}${text ? " · 적은 말은 대표 직접 지시로 보냅니다" : ""}`);
      setPick(null);
      if (text) setNote("");
    } catch (e) {
      setError(errorText(e));
      // 창이 바뀌었거나, 이미 풀렸거나, 응답만 잃었을 수 있다. 지금 창을 다시 읽어 보이고 대표가 다시 고른다. 저절로 누르지 않는다.
      if (e instanceof ApiError && (e.status === 409 || e.status === 400 || e.status === 0)) {
        setPick(null);
        reload = true;
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    if (reload) void read();
  };

  const reread = (
    <GlassButton variant="ghost" size="s" className="apv-reread" disabled={reading || busy} onClick={() => void read()}>
      {reading ? "읽는 중" : "다시 읽기"}
    </GlassButton>
  );

  if (approval === undefined) {
    return (
      <div className="apv" aria-busy="true">
        <p className="apv-wait">승인 창을 읽는 중입니다</p>
      </div>
    );
  }

  if (approval === null) {
    return (
      <div className="apv apv--fallback">
        {fallback}
        {error || readError ? (
          <p className="apv-error" role="alert">
            {error ?? `승인 창을 읽지 못했습니다: ${readError}`}
          </p>
        ) : null}
        {canRead ? <div className="apv-foot">{reread}</div> : null}
      </div>
    );
  }

  return (
    <div className={cx("apv", boxed && "apv--boxed")}>
      <div className="apv-head">
        <p className="apv-kicker">승인 창</p>
        {reread}
      </div>
      {approval.title ? <h3 className="apv-title">{approval.title}</h3> : null}
      {approval.body ? (
        <pre className="apv-body t-code" tabIndex={0} aria-label="승인 창 내용">
          {approval.body}
        </pre>
      ) : null}
      {approval.question ? <p className="apv-question">{approval.question}</p> : null}

      {sent ? (
        <p className="apv-sent" role="status">
          {sent}
        </p>
      ) : (
        <>
          {notice ? (
            <p className="apv-wait" role="status">
              {notice}
            </p>
          ) : null}
          <div className="apv-opts" role="group" aria-label="선택지">
            {approval.options.map((o) => (
              <button key={o.n} type="button" className="apv-opt" data-reject={o.reject ? "" : undefined} aria-pressed={pick === o.n} disabled={busy} onClick={() => choose(o.n)}>
                <span className="apv-opt__n t-tabular">{o.n}.</span>
                <span className="apv-opt__main">
                  <span className="apv-opt__label">{o.label}</span>
                  <span className="apv-opt__tags">
                    <OptionTags o={o} />
                  </span>
                </span>
                {pick === o.n ? (
                  <svg className="apv-opt__check" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                    <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </button>
            ))}
          </div>

          {option?.reject ? (
            <label className="apv-note">
              <span className="apv-note__label">직원에게 전할 말(선택)</span>
              <textarea
                ref={noteRef}
                className="input apv-note__input"
                rows={1}
                maxLength={NOTE_MAX}
                value={note}
                disabled={busy}
                placeholder="적으면 창을 닫은 뒤 대표 직접 지시로 보냅니다"
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          ) : null}

          {option ? (
            <div ref={confirmRef} className="apv-confirm">
              <p className="apv-confirm__hint">{option.reject ? "칸에서 이 거절을 누릅니다." : persists(option) ? "칸에서 이 선택지를 누릅니다. 이번 한 번이 아니라 이후에도 적용됩니다." : "칸에서 이 선택지를 누릅니다."}</p>
              <div className="apv-confirm__row">
                <GlassButton variant="primary" size="m" className="apv-confirm__go" disabled={busy} onClick={() => void confirm()}>
                  {busy ? "누르는 중" : option.reject ? "거절 확인" : "확인"}
                </GlassButton>
                <GlassButton variant="ghost" size="m" disabled={busy} onClick={() => choose(null)}>
                  취소
                </GlassButton>
              </div>
            </div>
          ) : null}
        </>
      )}

      {error ? (
        <p className="apv-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
