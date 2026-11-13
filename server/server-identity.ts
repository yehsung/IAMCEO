// V(0.2.5): 서버 신원. 앱의 '연결되면 보낼 글'을 쓴 서버에 묶는 데 쓴다(Bootstrap.server.id).
//
// 새 ID 를 따로 만들지 않고, 서버가 처음 뜰 때 PushStore 가 만들어 DB(push_meta.server_id)에 남기는 무작위 ID 를 그대로 쓴다.
// - 이 ID 는 서버의 DB 와 함께 산다. 대기열의 글이 가리키는 프로젝트·팀장 ID 도 그 DB 의 것이라, 'DB 가 같으면 같은 서버'가
//   글을 보낼 곳을 가리는 가장 정확한 기준이다(설정 파일만 옮기고 DB 를 새로 만든 서버를 같은 서버로 보지 않는다).
// - `iamceo restore --clone` 은 새 ID 를 받고, 같은 곳 복원(same-host)은 그대로 둔다(server/restore.ts 의 quarantine).
// - 알림(APNs)의 serverId 와 같은 값이라, 앱은 알림과 대기열이 한 서버를 같은 이름으로 가리킨다.
// 값은 비밀이 아니다(알림 내용에도 실린다). 버전 머리글을 보낸 앱에만 싣는다(server/app-version.ts 의 compatFields).
import type { Database } from "bun:sqlite";

const SERVER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const cache = new WeakMap<Database, string>();

/** 이 DB 의 서버 ID. 아직 없으면(알림 저장소를 만들기 전의 시험 서버 등) undefined. 서버가 도는 동안 바뀌지 않아 한 번 읽으면 둔다. */
export function readServerId(db: Database): string | undefined {
  const known = cache.get(db);
  if (known) return known;
  let value: unknown;
  try { value = db.query<{ server_id: unknown }, []>("SELECT server_id FROM push_meta WHERE id=1").get()?.server_id; }
  catch { return undefined; }
  if (typeof value !== "string" || !SERVER_ID.test(value)) return undefined;
  cache.set(db, value);
  return value;
}

/** http.ts 가 부른다. 서버는 도메인 저장소와 알림 저장소가 한 DB 를 쓴다. 그 DB 에서 읽고(한 번 읽으면 둔다),
 * 없으면 알림 저장소에 묻는다(시험이 따로 연 DB). */
export function serverIdentity(ctx: { push?: { store: { serverId: string } }; store: { db: Database } }): string | undefined {
  const stored = readServerId(ctx.store.db);
  if (stored) return stored;
  try {
    const fromPush = ctx.push?.store.serverId;
    return typeof fromPush === "string" && SERVER_ID.test(fromPush) ? fromPush : undefined;
  } catch { return undefined; }
}
