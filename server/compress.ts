// 0.2.9: 큰 JSON 답을 gzip 으로 보낸다.
//
// 앱은 프로젝트를 열 때와 팀이 움직일 때마다 프로젝트 상태 묶음(/api/sync)을 통째로 받는다. 오래 쓴 프로젝트는 그 묶음이 1MB 를 넘고,
// 대화 한 쪽(/api/projects/:id/messages/page)도 0.2MB 를 넘는다. 폰이 Tailscale 로 멀리서 붙으면 이 크기가 곧 대화창이 뜨는 시간이다.
// 한국어 JSON 은 gzip 으로 1/3.6 이 된다(1.22MB → 0.34MB, 8ms). 앱(URLSession)은 Accept-Encoding 을 스스로 보내고 스스로 풀기 때문에
// 이미 나간 앱도 그대로 빨라진다.
//
// - 200 인 JSON 답만, 요청이 gzip 을 받는다고 했을 때만 줄인다. 그 밖의 답(파일·내보내기·오류·이미 줄인 답)은 건드리지 않는다.
// - 같은 본문은 한 번만 줄인다(같은 상태를 여러 기기가 읽거나, 바뀐 것 없이 다시 읽을 때). 열쇠는 본문의 sha256 이다.
// - 이 Mac 안에서 온 요청은 부르는 쪽(server/http.ts)이 걸러 낸다. 줄여도 얻는 것이 없다.
import { createHash } from "node:crypto";

/** 이보다 작은 답은 줄이지 않는다(머리글과 압축 틀이 더 크다). */
export const COMPRESS_MIN_BYTES = 2048;
const CACHE_MAX_ENTRIES = 24;
const CACHE_MAX_BYTES = 24 * 1024 * 1024;

/** Accept-Encoding 이 gzip 을 받는가. `gzip;q=0` 은 거절이고, `*` 는 따로 거절하지 않은 gzip 을 받는다. */
export function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  let star: boolean | null = null;
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map(p => p.trim()).find(p => p.startsWith("q="));
    const allowed = q === undefined || Number(q.slice(2)) > 0;
    if (name === "gzip" || name === "x-gzip") return allowed;
    if (name === "*") star = allowed;
  }
  return star === true;
}

export class JsonCompressor {
  private readonly cache = new Map<string, Uint8Array<ArrayBuffer>>();
  private bytes = 0;

  /** 줄일 답이면 gzip 으로 바꾼 새 답을, 아니면 받은 답을 그대로 돌려준다. 본문을 읽은 뒤에는 같은 본문으로 다시 만든다. */
  async apply(req: Request, response: Response): Promise<Response> {
    if (response.status !== 200 || response.body === null || response.headers.has("Content-Encoding")) return response;
    if (!(response.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return response;
    if (!acceptsGzip(req.headers.get("Accept-Encoding"))) return response;
    const raw: Uint8Array<ArrayBuffer> = new Uint8Array(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    headers.delete("Content-Length");
    // 줄이든 말든 답은 Accept-Encoding 에 따라 달라진다.
    headers.append("Vary", "Accept-Encoding");
    if (raw.byteLength < COMPRESS_MIN_BYTES) return new Response(raw, { status: response.status, statusText: response.statusText, headers });
    headers.set("Content-Encoding", "gzip");
    return new Response(this.gzip(raw), { status: response.status, statusText: response.statusText, headers });
  }

  private gzip(raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    const key = `${raw.byteLength}:${createHash("sha256").update(raw).digest("hex")}`;
    const hit = this.cache.get(key);
    if (hit) {
      // 최근에 쓴 것을 뒤로 보낸다(오래 안 쓴 것부터 버린다).
      this.cache.delete(key); this.cache.set(key, hit);
      return hit;
    }
    const packed = new Uint8Array(Bun.gzipSync(raw, { level: 6 }));
    if (packed.byteLength <= CACHE_MAX_BYTES / 4) {
      this.cache.set(key, packed); this.bytes += packed.byteLength;
      while (this.cache.size > CACHE_MAX_ENTRIES || this.bytes > CACHE_MAX_BYTES) {
        const [oldest, value] = this.cache.entries().next().value!;
        this.cache.delete(oldest); this.bytes -= value.byteLength;
      }
    }
    return packed;
  }
}
