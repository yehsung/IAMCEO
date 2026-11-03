// 첨부 미리보기와 이미지 확대. 대화·자료가 함께 쓴다.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { Attachment } from "@shared/types";
import { GlassButton } from "../glass";
import { errorText, fileUrl, saveAttachment } from "../lib/api";
import "../styles/attachments.css";
import { Modal } from "./ui";

export interface ViewedImage {
  src: string;
  name: string;
  /** 첨부 이미지면 받을 수 있다. 문서 안 그림은 없다. */
  att?: Pick<Attachment, "url" | "name">;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 맞춤 ↔ 크게. 크게 볼 때는 누른 자리가 가운데 오게 한다. */
function ZoomableImage({ image }: { image: ViewedImage }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState<{ width: number; rx: number; ry: number } | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const img = imgRef.current;
    if (!box || !img || !zoom) return;
    box.scrollTo(zoom.rx * img.offsetWidth - box.clientWidth / 2, zoom.ry * img.offsetHeight - box.clientHeight / 2);
  }, [zoom]);

  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    const img = imgRef.current;
    const box = boxRef.current;
    if (!img || !box) return;
    if (zoom) {
      setZoom(null);
      return;
    }
    const rect = img.getBoundingClientRect();
    // 키보드로 누르면 좌표가 0 이다
    const rx = e.detail > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    const ry = e.detail > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    setZoom({ width: Math.max(img.naturalWidth, box.clientWidth * 2), rx, ry });
  };

  return (
    <div ref={boxRef} className="atv-box">
      <button type="button" className="atv-zoom" data-zoomed={zoom ? "" : undefined} aria-label={zoom ? "맞춰 보기" : "크게 보기"} onClick={toggle}>
        <img ref={imgRef} src={image.src} alt={image.name} style={zoom ? { width: zoom.width } : undefined} />
      </button>
    </div>
  );
}

/** 여러 장을 앞뒤로 넘길 때. go 는 넘겨받은 번호로 옮긴다(부르는 쪽이 범위를 돈다). */
export interface ImageNav {
  index: number;
  total: number;
  go: (index: number) => void;
}

export function ImageViewer({ image, onClose, nav }: { image: ViewedImage | null; onClose: () => void; nav?: ImageNav }) {
  useEffect(() => {
    if (!image || !nav) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") nav.go(nav.index - 1);
      if (e.key === "ArrowRight") nav.go(nav.index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [image, nav]);
  return (
    <Modal
      open={image !== null}
      onClose={onClose}
      title={image?.name || "이미지"}
      footer={
        image ? (
          <>
            {nav ? (
              <span className="atv-nav">
                <GlassButton variant="glass" size="m" onClick={() => nav.go(nav.index - 1)}>
                  이전
                </GlassButton>
                <span className="atv-nav__at t-tabular">
                  {nav.index + 1} / {nav.total}
                </span>
                <GlassButton variant="glass" size="m" onClick={() => nav.go(nav.index + 1)}>
                  다음
                </GlassButton>
              </span>
            ) : null}
            {image.att ? (
              <GlassButton variant="glass" size="m" onClick={() => void saveAttachment(image.att!).catch(() => undefined)}>
                받기
              </GlassButton>
            ) : null}
          </>
        ) : undefined
      }
    >
      {image ? <ZoomableImage key={image.src} image={image} /> : null}
    </Modal>
  );
}

/** 이미지는 높이를 고정한 썸네일(불러오며 글이 밀리지 않는다), 그 밖은 내려받기 칩. */
export function Attachments({ items, large = false }: { items: Attachment[]; large?: boolean }) {
  const [viewed, setViewed] = useState<ViewedImage | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const save = (e: MouseEvent, a: Attachment) => {
    e.preventDefault();
    setFailed(null);
    saveAttachment(a).catch((err: unknown) => setFailed(`${a.name} 를 받지 못했습니다. ${errorText(err)}`));
  };
  if (items.length === 0) return null;
  return (
    <div className="atv" data-large={large ? "" : undefined}>
      {items.map((a) =>
        a.isImage ? (
          <button
            key={a.id}
            type="button"
            className="atv-thumb"
            aria-label={`${a.name} 크게 보기`}
            onClick={() => setViewed({ src: fileUrl(a), name: a.name, att: a })}
          >
            <img src={fileUrl(a)} alt="" loading="lazy" />
          </button>
        ) : (
          <a key={a.id} className="atv-file" href={a.url} download={a.name} onClick={(e) => save(e, a)}>
            <span className="atv-file__name">{a.name}</span>
            <span className="atv-file__size t-tabular">{formatBytes(a.size)}</span>
          </a>
        ),
      )}
      {failed ? (
        <p className="vw-note" data-tone="bad" role="alert">
          {failed}
        </p>
      ) : null}
      <ImageViewer image={viewed} onClose={() => setViewed(null)} />
    </div>
  );
}
