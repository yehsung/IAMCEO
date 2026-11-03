// 보기들이 함께 쓰는 작은 조각. 내려받기는 헤더 인증으로 받아 저장하므로 주소에 접속 코드가 실리지 않고 원본 문서가 어떤 창으로도 열리지 않는다.
import { useState, type MouseEvent, type ReactNode } from "react";
import type { Attachment } from "@shared/types";
import { errorText, saveAttachment } from "../../lib/api";

export function DownloadLink({ att, label = "받기" }: { att: Attachment; label?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    setFailed(null);
    saveAttachment(att).catch((err: unknown) => setFailed(errorText(err)));
  };
  return (
    <>
      <a className="vw-btn" href={att.url} download={att.name} aria-label={`${att.name} ${label}`} onClick={onClick}>
        {label}
      </a>
      {failed ? <ViewerNote tone="bad">받지 못했습니다. {failed}</ViewerNote> : null}
    </>
  );
}

export function ViewerNote({ tone = "info", children }: { tone?: "info" | "bad"; children: ReactNode }) {
  return (
    <p className="vw-note" data-tone={tone} role={tone === "bad" ? "alert" : undefined}>
      {children}
    </p>
  );
}
