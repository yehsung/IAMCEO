// 자료: 데스크톱은 목록+읽기 두 칸, 그보다 좁으면 목록→상세. 고른 자료는 주소(#/p/<id>/files/<fileId>)가 정한다.
// 종류별 보기는 components/viewers, 아티팩트는 components/ArtifactFrame.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileDoc, FileKind } from "@shared/types";
import { Glass } from "../glass";
import { fileUrl } from "../lib/api";
import { routeHash, useProject, useRoute } from "../lib/store";
import { Empty, MQ_DESKTOP, Time, copyText, useMediaQuery } from "../components/ui";
import { FileViewer, KIND_LABEL, KIND_ORDER } from "../components/viewers";
import "../styles/files.css";

const COPIED_MS = 2000;

function PathLine({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(path))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <div className="fl-path">
      <code className="fl-path__text t-code">{path}</code>
      <button type="button" className="fl-path__copy" aria-label="원본 경로 복사" onClick={() => void copy()}>
        {copied ? "복사됨" : "복사"}
      </button>
    </div>
  );
}

function Reader({ file }: { file: FileDoc }) {
  return (
    <article className="fl-doc" data-kind={file.kind}>
      <p className="fl-doc__meta">
        <span className="fl-kind" data-kind={file.kind}>
          {KIND_LABEL[file.kind]}
        </span>
        {file.who ? <span className="fl-doc__who">{file.who}</span> : null}
        <Time iso={file.createdAt} />
      </p>
      <h2 className="fl-doc__title">{file.title}</h2>
      {file.summary ? <p className="fl-doc__summary">{file.summary}</p> : null}
      {/* 아티팩트는 그림이 주인공이다. 원본 경로는 다른 종류에서만 보여 준다. */}
      {file.path && file.kind !== "artifact" ? <PathLine path={file.path} /> : null}
      <FileViewer file={file} />
    </article>
  );
}

function FileRow({ file, projectId, current }: { file: FileDoc; projectId: string; current: boolean }) {
  const thumb = file.attachments.find((a) => a.isImage);
  return (
    <li>
      <a className="fl-row" href={routeHash({ projectId, tab: "files", sub: file.id })} aria-current={current ? "page" : undefined}>
        <span className="fl-row__main">
          <span className="fl-row__title">{file.title}</span>
          {file.summary ? <span className="fl-row__summary">{file.summary}</span> : null}
          <span className="fl-row__meta">
            <span className="fl-kind" data-kind={file.kind}>
              {KIND_LABEL[file.kind]}
            </span>
            <span>
              {file.who ? `${file.who} · ` : ""}
              <Time iso={file.createdAt} />
            </span>
          </span>
        </span>
        {thumb ? <img className="fl-row__thumb" src={fileUrl(thumb)} alt="" loading="lazy" /> : null}
      </a>
    </li>
  );
}

function KindChips({ files, kind, onPick }: { files: FileDoc[]; kind: FileKind | null; onPick: (k: FileKind | null) => void }) {
  const counts = new Map<FileKind, number>();
  for (const f of files) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const present = KIND_ORDER.filter((k) => counts.has(k));
  // 한 종류뿐이면 거를 것이 없다
  if (present.length < 2) return null;
  const chip = (k: FileKind | null, label: string, n: number) => (
    <button key={k ?? "all"} type="button" className="fl-chip" aria-pressed={kind === k} onClick={() => onPick(k)}>
      {label} <span className="t-tabular">{n}</span>
    </button>
  );
  return (
    <div className="fl-chips" role="group" aria-label="종류로 거르기">
      {chip(null, "전체", files.length)}
      {present.map((k) => chip(k, KIND_LABEL[k], counts.get(k)!))}
    </div>
  );
}

function Missing() {
  return <Empty title="찾을 수 없는 자료입니다">목록에서 다시 골라 주세요.</Empty>;
}

export default function Files() {
  const project = useProject();
  const route = useRoute();
  const desktop = useMediaQuery(MQ_DESKTOP);
  const rootRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const [kind, setKind] = useState<FileKind | null>(null);
  const projectId = route.projectId;
  const sub = route.sub;

  // 새 자료는 이벤트로 목록 끝에 붙으므로 서버와 같은 순서(최신 먼저)로 다시 맞춘다
  const files = useMemo(() => [...(project?.files ?? [])].sort((a, b) => b.order - a.order), [project?.files]);
  // 거르던 종류의 자료가 사라지면(다른 프로젝트로 옮김) 전체로 본다
  const activeKind = kind && files.some((f) => f.kind === kind) ? kind : null;
  const shown = useMemo(() => (activeKind ? files.filter((f) => f.kind === activeKind) : files), [files, activeKind]);
  // 링크로 온 자료는 거르기와 상관없이 연다
  const selected = sub ? (files.find((f) => f.id === sub) ?? null) : desktop ? (shown[0] ?? null) : null;

  // 다른 자료를 열면 처음부터 읽는다. 폰에서 목록으로 돌아오면 보던 자리로.
  const prevSub = useRef(sub);
  useLayoutEffect(() => {
    const root = rootRef.current?.closest<HTMLElement>("[data-scroll-root]");
    if (root && !desktop && sub !== prevSub.current) {
      if (prevSub.current === null) listScroll.current = root.scrollTop;
      root.scrollTop = sub === null ? listScroll.current : 0;
    }
    readerRef.current?.scrollTo(0, 0);
    prevSub.current = sub;
  }, [sub, desktop]);

  if (files.length === 0) {
    return (
      <div ref={rootRef}>
        <Empty title="아직 올린 자료가 없습니다">직원이 자료를 올리면 여기에 모입니다.</Empty>
      </div>
    );
  }

  const list = (
    <Glass level="regular" tint className="fl-panel fl-panel--list">
      <div className="fl-listbox">
        <KindChips files={files} kind={activeKind} onPick={setKind} />
        <ul className="fl-list" aria-label="자료 목록">
          {shown.map((f) => (
            <FileRow key={f.id} file={f} projectId={projectId} current={f.id === selected?.id} />
          ))}
        </ul>
      </div>
    </Glass>
  );

  if (desktop) {
    return (
      <div ref={rootRef} className="fl fl--desk" data-wide={selected?.kind === "artifact" ? "" : undefined}>
        {list}
        <Glass level="regular" tint className="fl-panel fl-panel--reader">
          <div ref={readerRef} className="fl-reader">
            {selected ? <Reader key={selected.id} file={selected} /> : <Missing />}
          </div>
        </Glass>
      </div>
    );
  }

  if (sub === null) {
    return (
      <div ref={rootRef} className="fl">
        {list}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="fl">
      <a className="fl-back" href={routeHash({ projectId, tab: "files" })}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        자료
      </a>
      <Glass level="regular" tint className="fl-panel fl-panel--phone">
        {selected ? <Reader key={selected.id} file={selected} /> : <Missing />}
      </Glass>
    </div>
  );
}
