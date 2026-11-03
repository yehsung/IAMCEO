// 표·코드 보기의 글을 가져온다. body 에 원문이 있으면 그것을, 없으면(1MB 초과) 첨부의 앞부분만 받는다.
import { useEffect, useState } from "react";
import type { Attachment, FileDoc } from "@shared/types";
import { errorText, fetchAttachment } from "../../lib/api";

/** 큰 파일도 이만큼만 받아 그린다. 나머지는 '전체 받기'. */
export const PREVIEW_BYTES = 512 * 1024;

/** UTF-8 이 아니면 엑셀이 쓰는 인코딩을 차례로 본다. 잘린 끝 글자는 stream 으로 넘겨 오류로 치지 않는다. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

/** 앞에서 maxBytes 까지만 받고 끊는다. 접속 코드는 헤더로만 간다. */
export async function readAttachmentHead(att: Pick<Attachment, "url">, maxBytes: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const res = await fetchAttachment(att, signal);
  const reader = res.body?.getReader();
  if (!reader) return { text: decodeText(new Uint8Array(await res.arrayBuffer())), truncated: false };
  const parts: Uint8Array[] = [];
  let got = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (got > maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const all = new Uint8Array(Math.min(got, maxBytes));
  let at = 0;
  for (const p of parts) {
    const take = p.subarray(0, all.length - at);
    all.set(take, at);
    at += take.length;
  }
  return { text: decodeText(all), truncated };
}

export type TextSource = { status: "loading" } | { status: "error"; text: string } | { status: "ready"; text: string; truncated: boolean };

export function useTextSource(file: FileDoc, att: Attachment | null): TextSource {
  // 서버는 본문을 UTF-8 로 읽는다. 대체 문자가 있으면 엑셀의 EUC-KR 이므로 원본에서 다시 읽는다.
  const direct = !!file.body && (!att || !file.body.includes("�"));
  const [source, setSource] = useState<TextSource>(direct ? { status: "ready", text: file.body, truncated: false } : { status: "loading" });
  const [url, body] = [att?.url ?? null, file.body];
  useEffect(() => {
    if (direct) {
      setSource({ status: "ready", text: body, truncated: false });
      return;
    }
    if (!url) {
      setSource({ status: "error", text: "원본을 찾을 수 없습니다" });
      return;
    }
    const abort = new AbortController();
    setSource({ status: "loading" });
    readAttachmentHead({ url }, PREVIEW_BYTES, abort.signal).then(
      (r) => setSource({ status: "ready", ...r }),
      (e: unknown) => {
        if (!abort.signal.aborted) setSource({ status: "error", text: errorText(e) });
      },
    );
    return () => abort.abort();
  }, [direct, url, body]);
  return source;
}
