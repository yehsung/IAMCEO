// PDF. 헤더로 받아 blob 으로 그린다(주소에 접속 코드를 싣지 않고, 첨부 주소의 CSP sandbox 는 PDF 보기를 막는다).
// 폰 브라우저는 칸 안에 PDF 를 제대로 못 그리므로 새 창으로 여는 버튼을 준다.
import { useEffect, useState } from "react";
import type { Attachment } from "@shared/types";
import { errorText, fetchAttachment } from "../../lib/api";
import { formatBytes } from "../Attachments";
import { DownloadLink, ViewerNote } from "./parts";

const canInline = (): boolean => navigator.pdfViewerEnabled === true && !window.matchMedia("(pointer: coarse)").matches;

export function PdfViewer({ att }: { att: Attachment }) {
  const [state, setState] = useState<{ url: string } | { error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let url: string | null = null;
    setState(null);
    fetchAttachment(att, abort.signal)
      .then((r) => r.arrayBuffer())
      .then(
        (buf) => {
          // 형식은 이쪽에서 정한다. 칸 안에서 HTML 로 해석될 수 없게.
          url = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
          setState({ url });
        },
        (e: unknown) => {
          if (!abort.signal.aborted) setState({ error: errorText(e) });
        },
      );
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [att.url, attempt]);

  const ready = state && "url" in state ? state.url : null;
  const inline = canInline();
  return (
    <section className="vw-pdf" aria-label="PDF">
      <div className="vw-bar">
        <p className="vw-bar__text">
          {att.name} <span className="t-tabular">{formatBytes(att.size)}</span>
        </p>
        <span className="vw-bar__actions">
          {ready ? (
            <a className="vw-btn" href={ready} target="_blank" rel="noopener noreferrer">
              새 창에서 열기
            </a>
          ) : null}
          <DownloadLink att={att} />
        </span>
      </div>
      {state === null ? <ViewerNote>PDF 를 불러오는 중입니다</ViewerNote> : null}
      {state && "error" in state ? (
        <div className="vw-fail">
          <ViewerNote tone="bad">{state.error}</ViewerNote>
          <button type="button" className="vw-btn" onClick={() => setAttempt((n) => n + 1)}>
            다시 시도
          </button>
        </div>
      ) : null}
      {ready && inline ? <iframe className="vw-pdf__frame" src={ready} title={att.name} /> : null}
      {ready && !inline ? <ViewerNote>이 기기에서는 화면 안에 보여 줄 수 없습니다. 새 창에서 열어 주세요.</ViewerNote> : null}
    </section>
  );
}
