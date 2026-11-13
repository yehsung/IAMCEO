// 알림 중계 주소. 가벼운 모듈로 둔다(server/config.ts 가 읽는다. 네트워크·키 코드를 끌어오지 않는다).

/**
 * 알림 중계의 기본 주소(한 곳). 대표가 Firebase 프로젝트를 만들고 relay/ 를 배포한 뒤, 배포가 알려 주는 함수 주소
 * (Cloud Run 주소 "https://relay-….run.app", 끝의 /v1/… 은 빼고)로 채운다. Firebase Hosting 주소(*.web.app)는 쓰지 않는다:
 * Hosting 은 요청한 Mac 의 IP 를 몇 달 보관한다(relay/README.md).
 * 비어 있는(null) 동안에는 config.json 의 pushRelayUrl 이 없으면 중계를 쓰지 않는다(지금처럼 '푸시 키 없음').
 * 아직 만들지 않은 프로젝트 이름을 미리 적어 두면 남이 그 이름을 먼저 차지해 토큰을 받을 수 있어 비워 둔다.
 */
export const DEFAULT_PUSH_RELAY_URL: string | null = null;

/** 중계 주소 검사. https 만, 시험용으로 이 Mac(127.0.0.1·localhost·::1)의 http 만 받는다. 끝의 / 는 뗀다. */
export function normalizePushRelayUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\0\s]/.test(value)) throw new Error("push_relay_url_invalid");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("push_relay_url_invalid"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error("push_relay_url_invalid");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
