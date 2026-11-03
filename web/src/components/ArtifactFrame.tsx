// 아티팩트를 격리 칸에 그린다. 계약: docs/spec.md §3.2, 원본 조립: shared/artifact-kit.ts.
// 칸(sandbox allow-scripts + 헤더 sandbox)은 불투명 출처라 접속 코드·저장소·이 서버 API 에 닿지 못한다. 첨부 주소를 이 안으로 넘기지 않는다.
// 전체 화면은 칸을 옮기지 않는다. 옮기면 다시 읽혀 아티팩트의 탭 선택 등이 사라진다.
// <dialog> 를 평소엔 보통 상자로 두고 showModal 로 최상단 층에 올린다(유리 판의 backdrop-filter 도 빠져나간다, 폰도 된다).
import { useCallback, useEffect, useRef, useState } from "react";
import { ARTIFACT_FRAME_PATH, ARTIFACT_SANDBOX, buildArtifactSrcdoc } from "@shared/artifact-kit";
import { api, errorText } from "../lib/api";

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 20_000;
/** 칸이 뜨지 않으면 실패로 친다. */
const FRAME_TIMEOUT_MS = 12_000;
/**
 * 작성자 CSS 가 칸 높이를 따라 자라면(min-height:100vh + padding 등) 키울수록 또 커진다. 멈추고 칸 안 스크롤로 둔다.
 * 키운 만큼 똑같이 더 커지기를 거듭하거나, 3초에 너무 자주 커지면 그렇게 본다(글이 펼쳐지는 움직임은 폭이 일정하지 않고 금방 끝난다).
 */
const RUNAWAY_SAME_STEP = 8;
const RUNAWAY_GROWS = 40;
const RUNAWAY_WINDOW_MS = 3000;

/** 칸이 보낸 값은 믿지 않는다. 수이고 범위 안일 때만. */
export function readReportedHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) return null;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(value)));
}

/** 칸 안에서 누른 링크. 바깥 http(s) 만 받는다. */
export function readReportedLink(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== origin ? url.href : null;
  } catch {
    return null;
  }
}

type Load = { status: "loading" } | { status: "error"; text: string } | { status: "ready"; doc: string };

/** 이 창에서 대표가 이미 실행한 아티팩트. 탭을 오갈 때 다시 묻지 않는다. 새로고침하면 비어 다시 묻는다. */
const started = new Set<string>();

/**
 * 누르기 전에는 칸을 만들지 않는다. WebKit 은 칸과 부모가 같은 메인 스레드를 써서, AI 가 쓴 무한 루프 하나로 결재·입력칸까지 멈춘다.
 * 자료 탭의 자동 선택과 주소 복원으로 열려도 마찬가지다. 부르는 쪽은 자료마다 key 를 준다.
 */
export function ArtifactFrame({ fileId, title }: { fileId: string; title: string }) {
  const [run, setRun] = useState(() => started.has(fileId));
  if (run) return <ArtifactStage fileId={fileId} title={title} />;
  return (
    <div className="vw-fail">
      <p className="vw-note">직원이 만든 페이지입니다. 실행하면 안의 스크립트가 돕니다.</p>
      <button
        type="button"
        className="vw-btn"
        onClick={() => {
          started.add(fileId);
          setRun(true);
        }}
      >
        실행
      </button>
    </div>
  );
}

function ArtifactStage({ fileId, title }: { fileId: string; title: string }) {
  const hostRef = useRef<HTMLDialogElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [painted, setPainted] = useState(false);
  const [height, setHeight] = useState(480);
  const [full, setFull] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  // 칸이 준비됐다는 알림과 원본 도착은 순서가 정해져 있지 않다. 문서는 칸마다 한 번만 넣는다(그 뒤의 준비 알림은 작성자 글이 보낸 것이다).
  const pipe = useRef({ doc: null as string | null, ready: false, sent: false, grows: [] as number[], step: 0, sameStep: 0, frozen: false, stable: 480 });

  const deliver = useCallback(() => {
    const p = pipe.current;
    const win = frameRef.current?.contentWindow;
    if (!win || !p.ready || p.sent || p.doc === null) return;
    p.sent = true;
    win.postMessage({ iamceoSrcdoc: p.doc }, "*"); // 불투명 출처라 대상을 '*' 로만 쓸 수 있다. 받는 쪽은 parent 인지 확인한다.
  }, []);

  useEffect(() => {
    const abort = { done: false };
    pipe.current = { doc: null, ready: false, sent: false, grows: [], step: 0, sameStep: 0, frozen: false, stable: 480 };
    setLoad({ status: "loading" });
    setPainted(false);
    setLink(null);
    api.artifact(fileId).then(
      ({ html }) => {
        if (abort.done) return;
        const doc = buildArtifactSrcdoc(html, { title });
        pipe.current.doc = doc;
        setLoad({ status: "ready", doc });
        deliver();
      },
      (e: unknown) => {
        if (!abort.done) setLoad({ status: "error", text: errorText(e) });
      },
    );
    return () => {
      abort.done = true;
    };
  }, [fileId, title, attempt, deliver]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      // 칸이 보낸 것만. 칸은 opaque 출처라 origin 으로는 가를 수 없다.
      if (!frame || e.source !== frame.contentWindow || typeof e.data !== "object" || e.data === null) return;
      const data = e.data as Record<string, unknown>;
      const p = pipe.current;
      if (data.iamceoFrameReady === true) {
        if (!p.sent) {
          p.ready = true;
          deliver();
        }
        return;
      }
      if (!p.sent) return;
      if ("iamceoHeight" in data) {
        const next = readReportedHeight(data.iamceoHeight);
        if (next === null || p.frozen) return;
        setPainted(true);
        const now = Date.now();
        p.grows = p.grows.filter((t) => now - t < RUNAWAY_WINDOW_MS);
        const step = next - p.stable;
        p.sameStep = step > 0 && step === p.step ? p.sameStep + 1 : 0;
        p.step = step;
        if (step > 0) p.grows.push(now);
        if (p.sameStep >= RUNAWAY_SAME_STEP || p.grows.length > RUNAWAY_GROWS) {
          p.frozen = true;
          setHeight(Math.max(MIN_HEIGHT, window.innerHeight));
          return;
        }
        p.stable = next;
        setHeight(next);
      } else if ("iamceoLink" in data) {
        const url = readReportedLink(data.iamceoLink, location.origin);
        if (url) setLink(url);
      } else if (data.iamceoEscape === true) {
        // 초점이 칸 안에 있으면 Esc 가 이쪽으로 오지 않는다
        if (hostRef.current?.open) hostRef.current.close();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [deliver]);

  useEffect(() => {
    if (load.status !== "ready" || painted) return;
    const t = setTimeout(() => {
      setLoad({ status: "error", text: "칸을 열지 못했습니다" });
    }, FRAME_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [load.status, painted, attempt]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClose = () => setFull(false);
    host.addEventListener("close", onClose);
    return () => host.removeEventListener("close", onClose);
  }, []);

  const failed = load.status === "error";
  const toggleFull = () => {
    const host = hostRef.current;
    if (!host) return;
    if (host.open) host.close();
    else {
      host.showModal();
      setFull(true);
    }
  };

  return (
    <dialog ref={hostRef} className="afr" role={full ? undefined : "group"} aria-label={full ? title : undefined}>
      {failed ? null : (
        <div className="afr-bar">
          <span className="afr-bar__title">{full ? title : ""}</span>
          <button type="button" className="vw-btn" onClick={toggleFull}>
            {full ? "닫기" : "전체 화면"}
          </button>
        </div>
      )}
      <div className="afr-stage" style={full ? undefined : { height: failed ? undefined : height }}>
        {failed ? (
          <div className="vw-fail" role="alert">
            <p className="vw-note" data-tone="bad">
              아티팩트를 불러오지 못했습니다. {load.text}
            </p>
            <button type="button" className="vw-btn" onClick={() => setAttempt((n) => n + 1)}>
              다시 시도
            </button>
          </div>
        ) : (
          <iframe
            key={attempt}
            ref={frameRef}
            className="afr-frame"
            sandbox={ARTIFACT_SANDBOX}
            src={ARTIFACT_FRAME_PATH}
            title={title}
            referrerPolicy="no-referrer"
          />
        )}
        {!failed && !painted ? <p className="afr-loading">불러오는 중입니다</p> : null}
      </div>
      {link ? (
        <div className="afr-link">
          <span className="afr-link__url t-code">{link}</span>
          <span className="vw-bar__actions">
            <a className="vw-btn" href={link} target="_blank" rel="noopener noreferrer">
              열기
            </a>
            <button type="button" className="vw-btn" onClick={() => setLink(null)}>
              닫기
            </button>
          </span>
        </div>
      ) : null}
    </dialog>
  );
}
