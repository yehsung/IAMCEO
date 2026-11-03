// 자료 종류별 보기. FileDoc.kind 하나로 고른다.
import type { MouseEvent } from "react";
import { useState } from "react";
import { fileKindOf, type Attachment, type FileDoc, type FileKind } from "@shared/types";
import { ArtifactFrame } from "../ArtifactFrame";
import { Attachments, ImageViewer, formatBytes, type ViewedImage } from "../Attachments";
import { Markdown } from "../ui";
import { CodeViewer } from "./CodeViewer";
import { ImageGallery } from "./ImageGallery";
import { MediaViewer } from "./MediaViewer";
import { DownloadLink, ViewerNote } from "./parts";
import { PdfViewer } from "./PdfViewer";
import { TableViewer } from "./TableViewer";

export const KIND_LABEL: Record<FileKind, string> = {
  document: "문서",
  artifact: "아티팩트",
  image: "이미지",
  pdf: "PDF",
  table: "표",
  code: "코드",
  video: "영상",
  audio: "오디오",
  file: "파일",
};

/** 거르기 칩의 순서 */
export const KIND_ORDER: FileKind[] = ["document", "artifact", "image", "table", "pdf", "code", "video", "audio", "file"];

function FileCard({ att }: { att: Attachment }) {
  return (
    <div className="vw-card">
      <span className="vw-card__main">
        <span className="vw-card__name">{att.name}</span>
        <span className="vw-card__meta t-tabular">
          {formatBytes(att.size)}
          {att.mime && att.mime !== "application/octet-stream" ? ` · ${att.mime}` : ""}
        </span>
      </span>
      <DownloadLink att={att} />
    </div>
  );
}

/** 마크다운 본문. 안의 그림은 위임으로 잡아 확대한다. */
function DocumentBody({ body }: { body: string }) {
  const [viewed, setViewed] = useState<ViewedImage | null>(null);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLImageElement && !target.closest("a")) setViewed({ src: target.currentSrc || target.src, name: target.alt });
  };
  return (
    <div className="fl-doc__body" onClick={onClick}>
      <Markdown text={body} />
      <ImageViewer image={viewed} onClose={() => setViewed(null)} />
    </div>
  );
}

function matches(att: Attachment, kind: FileKind): boolean {
  return kind === "image" ? att.isImage : fileKindOf(att.name, att.mime) === kind;
}

/** 이 자료의 주인공인 첨부와 곁들인 첨부. file 은 전부 주인공이다. */
function split(file: FileDoc): { main: Attachment[]; rest: Attachment[] } {
  if (file.kind === "file") return { main: file.attachments, rest: [] };
  return {
    main: file.attachments.filter((a) => matches(a, file.kind)),
    rest: file.attachments.filter((a) => !matches(a, file.kind)),
  };
}

export function FileViewer({ file }: { file: FileDoc }) {
  const { main, rest } = split(file);
  const first = main[0] ?? null;
  // 표·코드의 body 는 원문이다. 나머지 종류의 body 는 설명 글이다.
  const rawBody = file.kind === "table" || file.kind === "code";
  const missing = <ViewerNote tone="bad">원본을 찾을 수 없습니다</ViewerNote>;
  let view = null;
  switch (file.kind) {
    case "artifact":
      view = <ArtifactFrame key={file.id} fileId={file.id} title={file.title} />;
      break;
    case "table":
      view = <TableViewer key={file.id} file={file} att={first} />;
      break;
    case "code":
      view = <CodeViewer key={file.id} file={file} att={first} />;
      break;
    case "image":
      view = first ? <ImageGallery images={main} /> : file.body ? null : missing;
      break;
    case "pdf":
      view = first ? main.map((a) => <PdfViewer key={a.id} att={a} />) : file.body ? null : missing;
      break;
    case "video":
    case "audio":
      view = first ? main.map((a) => <MediaViewer key={a.id} att={a} kind={file.kind as "video" | "audio"} />) : file.body ? null : missing;
      break;
    case "file":
      view = first ? main.map((a) => <FileCard key={a.id} att={a} />) : file.body ? null : missing;
      break;
    case "document":
      view = null;
      break;
  }
  // 문서의 첨부는 지금까지처럼 글 위에, 다른 종류의 곁들인 첨부는 보기 아래에 둔다. 아티팩트의 원본 .html 은 칸이 이미 그렸다.
  const extras = file.kind === "document" ? file.attachments : file.kind === "artifact" ? rest.filter((a) => fileKindOf(a.name, a.mime) !== "artifact") : rest;
  return (
    <>
      {file.kind === "document" ? <Attachments items={extras} large /> : view}
      {file.kind !== "document" && extras.length > 0 ? <Attachments items={extras} large /> : null}
      {file.body && !rawBody ? <DocumentBody body={file.body} /> : null}
    </>
  );
}
