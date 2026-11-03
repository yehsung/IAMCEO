// 이미지 자료. 한 장이면 크게, 여러 장이면 격자. 누르면 확대하고 앞뒤로 넘긴다.
import { useState } from "react";
import type { Attachment } from "@shared/types";
import { fileUrl } from "../../lib/api";
import { ImageViewer } from "../Attachments";

function Thumb({ att, label, onOpen }: { att: Attachment; label: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <button type="button" className="vw-gallery__item" aria-label={label} onClick={onOpen}>
      {failed ? <span className="vw-gallery__broken">{att.name}</span> : <img src={fileUrl(att)} alt="" loading="lazy" onError={() => setFailed(true)} />}
    </button>
  );
}

export function ImageGallery({ images }: { images: Attachment[] }) {
  const [at, setAt] = useState<number | null>(null);
  const current = at === null ? null : (images[at] ?? null);
  return (
    <div className="vw-gallery" data-single={images.length === 1 ? "" : undefined}>
      {images.map((a, i) => (
        <Thumb key={a.id} att={a} label={`${a.name} 크게 보기`} onOpen={() => setAt(i)} />
      ))}
      <ImageViewer
        image={current ? { src: fileUrl(current), name: current.name, att: current } : null}
        onClose={() => setAt(null)}
        nav={images.length > 1 && at !== null ? { index: at, total: images.length, go: (i) => setAt((i + images.length) % images.length) } : undefined}
      />
    </div>
  );
}
