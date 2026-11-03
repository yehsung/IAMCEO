// 코드·로그·json. json 은 들여쓰고, 줄 번호는 CSS 카운터라 글을 긁어 복사해도 따라오지 않는다.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, FileDoc } from "@shared/types";
import { formatBytes } from "../Attachments";
import { MQ_DESKTOP, copyText, useMediaQuery } from "../ui";
import { DownloadLink, ViewerNote } from "./parts";
import { useTextSource } from "./source";

export const CODE_LINE_LIMIT = 5000;
const COPIED_MS = 2000;

/** 온전한 json 이면 두 칸 들여쓰기로 편다. 아니면 그대로 둔다(jsonl·잘린 파일). */
export function prettyJson(text: string, name: string): string {
  if (!/\.json$/i.test(name) && !/^\s*[[{]/.test(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 첨부 없이 본문만 있는 자료(.txt)도 받을 수 있게 그 자리에서 파일을 만든다. */
function saveText(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function CodeViewer({ file, att }: { file: FileDoc; att: Attachment | null }) {
  const source = useTextSource(file, att);
  const desktop = useMediaQuery(MQ_DESKTOP);
  const [wrap, setWrap] = useState(!desktop); // 폰은 옆으로 밀기보다 접어서 읽는다
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const ready = source.status === "ready" ? source : null;
  const name = att?.name ?? file.path ?? "";
  const text = useMemo(() => (ready ? (ready.truncated ? ready.text : prettyJson(ready.text, name)) : ""), [ready?.text, ready?.truncated, name]);
  const lines = useMemo(() => text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"), [text]);

  if (source.status === "loading") return <ViewerNote>내용을 불러오는 중입니다</ViewerNote>;
  if (source.status === "error") return <ViewerNote tone="bad">{source.text}</ViewerNote>;

  const copy = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  const shown = lines.slice(0, CODE_LINE_LIMIT);
  const cut = ready?.truncated || lines.length > shown.length;

  return (
    <section className="vw-code" aria-label="코드">
      <div className="vw-bar">
        <p className="vw-bar__text t-tabular">
          {ready?.truncated ? "앞부분 " : ""}
          {lines.length.toLocaleString()}줄{lines.length > shown.length ? ` · 앞 ${shown.length.toLocaleString()}줄만 표시` : ""}
        </p>
        <span className="vw-bar__actions">
          <button type="button" className="vw-btn" aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>
            줄바꿈
          </button>
          <button type="button" className="vw-btn" onClick={() => void copy()}>
            {copied ? "복사됨" : ready?.truncated ? "보이는 만큼 복사" : "복사"}
          </button>
          {att ? (
            <DownloadLink att={att} label={cut ? `전체 받기 (${formatBytes(att.size)})` : "받기"} />
          ) : (
            <button type="button" className="vw-btn" onClick={() => saveText(text, `${file.title.replace(/[\\/:*?"<>|]/g, " ")}.txt`)}>
              받기
            </button>
          )}
        </span>
      </div>
      <div className="vw-code__scroll" tabIndex={0} role="region" aria-label={`${file.title} 내용`} data-wrap={wrap ? "" : undefined}>
        <ol className="t-code">
          {shown.map((l, i) => (
            <li key={i}>
              <code>{l || " "}</code>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
