// 설치 자격: DB 없이 서버 비밀(RELAY_MASTER)로 서명한다.
// secret = base64url(HMAC-SHA256(master, "iamceo-relay/v1/installation:" + installationId)).
// 중계는 아무것도 저장하지 않고, 요청마다 다시 계산해 상수 시간으로 비교한다.
// master 를 바꾸면 모든 Mac 이 401 을 받고 한 번 다시 등록한다(Mac 쪽 RelayClient 가 이미 그렇게 한다).
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const LABEL = "iamceo-relay/v1/installation:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BEARER = /^Bearer ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

/** master 는 32자 이상이어야 한다(README: openssl rand -base64 48). 짧으면 쓰지 않는다. */
export function validMaster(master: string | undefined): master is string {
  return typeof master === "string" && master.trim().length >= 32 && master.length <= 4_096;
}

export function installationSecret(master: string, installationId: string): string {
  return createHmac("sha256", master.trim()).update(LABEL + installationId).digest("base64url");
}

export function createInstallation(master: string, uuid: () => string = randomUUID): { installationId: string; secret: string } {
  const installationId = uuid().toLowerCase();
  if (!UUID.test(installationId)) throw new Error("invalid_uuid");
  return { installationId, secret: installationSecret(master, installationId) };
}

/** Authorization 머리글을 검사한다. 맞으면 설치 ID, 아니면 null. 머리글 값은 어디에도 남기지 않는다. */
export function verifyAuthorization(master: string, header: string | undefined): string | null {
  if (typeof header !== "string" || header.length > 200) return null;
  const match = BEARER.exec(header);
  if (!match) return null;
  const [, installationId, presented] = match;
  const expected = Buffer.from(installationSecret(master, installationId!), "utf8");
  const given = Buffer.from(presented!, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given) ? installationId! : null;
}
