// 영상·오디오 플레이어. 재생할 수 없는 형식이면 받기로 안내한다.
import { useState } from "react";
import type { Attachment } from "@shared/types";
import { fileUrl } from "../../lib/api";
import { formatBytes } from "../Attachments";
import { DownloadLink, ViewerNote } from "./parts";

export function MediaViewer({ att, kind }: { att: Attachment; kind: "video" | "audio" }) {
  const [failed, setFailed] = useState(false);
  const src = fileUrl(att);
  return (
    <section className="vw-media" data-kind={kind} aria-label={att.name}>
      {failed ? (
        <ViewerNote tone="bad">이 브라우저에서 재생할 수 없는 형식입니다. 받아서 열어 주세요.</ViewerNote>
      ) : kind === "video" ? (
        <video src={src} controls playsInline preload="metadata" onError={() => setFailed(true)} />
      ) : (
        <audio src={src} controls preload="metadata" onError={() => setFailed(true)} />
      )}
      <div className="vw-bar">
        <p className="vw-bar__text">
          {att.name} <span className="t-tabular">{formatBytes(att.size)}</span>
        </p>
        <DownloadLink att={att} />
      </div>
    </section>
  );
}
