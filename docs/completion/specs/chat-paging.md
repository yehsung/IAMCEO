# design-chat-paging — 대화 이전 기록 불러오기 구현 설계서

작성일: 2026-11-07. **설계만 수행했으며 구현 코드는 수정하지 않았다.** 이 작업의 유일한 산출물은 `.pumasi/specs/chat-paging.md`다. 아래 파일 목록은 후속 구현자가 수정할 예정 파일 목록이다.

설계 근거는 `docs/claude-handoff.md` 전체, 특히 §7·§8과 실제 `server/http.ts`, `server/store.ts`, `server/db.ts`, `shared/types.ts`, 웹 `Thread.tsx`·API·store·Shell·Composer, 네이티브 ChatView·AppStore·APIClient·Models, 기존 시험이다. `docs/spec.md`·`docs/architecture.md`의 실행기 설명과 사용자 지시 사이에서는 사용자 지시를 우선한다. **현재 라이브 herdr를 유지하며, 완성 후 격리 시험을 거쳐 core로 전환한다.** 이 기능은 저장된 IAMCEO 메시지 조회이며 실행기 선택·CLI 세션·압축과 관계없다.

현재 코드에서 확인한 차이:

- `Store.projectState()`는 `listMessages(..., { limit: 200 })`를 싣는다. `listMessages()`는 `at DESC, rowid DESC`로 조회한 뒤 뒤집고, `before`는 `at < before`만 비교한다. 프로세스 내부 단조 증가 시각은 재시작·명시적 `input.at`·같은 시각의 기존 자료까지 해결하지 않는다.
- 웹에는 이미 `loadOlderMessages(100)`, 위쪽 480px 자동 로딩과 버튼이 있다. 그러나 시각 커서, 프로젝트 단위 `hasOlderMessages`, 바닥 거리 복원이어서 동일 시각 누락·동시 append 위치 이동·과거 응답의 최신 전달 상태 덮어쓰기 가능성이 있다.
- 네이티브 `ChatThread`는 “최근 200개까지 보입니다”만 표시한다. `AppStore.refresh()`는 전경에서 3초마다 `state` 전체를 교체하므로 단순 prepend만 구현하면 과거 글이 사라진다.
- 네이티브 `ChatScope`는 nil 또는 현재 root/conductor 선택을 전체 프로젝트 대화로 취급한다. 개별 범위는 `memberId == id || targetMemberId == id`다. 웹 Thread는 **항상 프로젝트 전체**이며 Composer의 대상 칩과 Team의 직접 전송은 보내기 대상이지 조회 필터가 아니다.

## 사용자 동작

1. 대화를 처음 열면 선택 범위의 최근 200개를 받아 맨 아래를 보여준다. 개별 담당자는 프로젝트 최근 200개를 필터링하는 대신 해당 담당자의 최근 200개를 직접 조회한다. 최초 조회가 끝나기 전에는 “대화를 불러오는 중…”이며 빈 대화로 확정하지 않는다.
2. 목록 위쪽 480px/pt 이내로 사용자가 올라오면 이전 100개를 불러온다. 한 범위에서 요청 하나만 진행한다. 짧은 목록이 화면에 다 들어와도 처음부터 전체 기록을 연쇄 다운로드하지 않는다. 초기 배치 후에는 실제 위쪽 스크롤 의도 또는 명시적 버튼 조작이 있어야 시작하고, 이후 sentinel이 계속 보여도 응답마다 무제한 연쇄하지 않는다.
3. 상단에는 접근 가능한 “이전 글 불러오기” 버튼을 유지한다. 요청 중 “이전 글을 불러오는 중…”, 실패 시 “이전 글을 불러오지 못했습니다”와 “다시 불러오기”, 끝이면 “대화의 처음입니다”를 표시한다. 자동 로딩 실패 후에는 버튼으로 재시도할 때까지 자동 반복을 멈춘다. 빈 범위는 “아직 대화가 없습니다”이고 더 불러오기 버튼은 없다.
4. 과거 글이 붙어도 **처리 직전 첫 번째로 보이던 메시지와 그 메시지 안의 읽던 위치**를 유지한다. 날짜 구분선, 이미지 지연 로딩, 전송 상태 줄 높이, 입력창·키보드 높이 변화도 포함한다. 과거 로딩 자체로 최신 위치로 이동하거나 새 글 수가 늘지 않는다.
5. 새 글은 바닥 80px/pt 이내에 있었으면 따라간다. 과거를 읽고 있으면 위치를 유지하고 “새 글 N개”를 표시한다. 전달 상태만 갱신된 같은 ID, 최초 조회, prepend는 새 글이 아니다. “맨 아래로” 또는 “새 글 N개”를 누르면 최신 위치로 이동한다. **내가 방금 전송한 글**은 기존처럼 최신 위치로 따라가되, 과거에서 발견한 `mine` 글이나 다른 기기에서 수정된 내 글이라는 이유로 이동하지 않는다.
6. 프로젝트·조회 대상마다 커서·오류·읽던 위치를 분리한다. 처음 방문한 범위는 최신부터, 같은 연결에서 돌아온 범위는 읽던 위치부터 표시한다. 전송 초안과 첨부·재전송 ID는 기존 저장 방식으로 유지한다. 조회 범위를 바꾸거나 과거 기록을 읽었다고 전송 대상을 변경하지 않는다.
7. 연결이 끊기면 읽은 기록은 남긴다. “연결이 끊겼습니다. 다시 연결한 뒤 이전 글을 불러올 수 있습니다”를 표시한다. 401은 기존 인증 해제 흐름을 따르고 캐시도 비운다. 샘플 모드는 기존 샘플만 보여주고 네트워크 페이지 요청을 보내지 않는다.
8. 재접속 중 최근 200개보다 많은 글이 쌓였으면 “새 대화를 동기화하는 중…”을 표시하고 아래에서 설명하는 연결 조회를 수행한다. 기존 기록과 새 기록 사이를 빈틈없이 연결한 뒤 함께 보여준다. 실패하면 읽던 기록을 유지하며 “새 대화를 이어 받지 못했습니다” / “다시 동기화”를 표시한다. 저장소가 교체되어 연결할 수 없으면 “서버의 대화 기록이 변경되었습니다” / “최신 대화부터 다시 보기”를 제공한다. 사용자 조작 전에는 읽던 화면을 버리지 않는다.
9. 과거에서 연 결재·자료·첨부는 기존 인증·상세 조회를 사용한다. 오래된 결재의 버튼은 최신 상세를 다시 읽고 기존 `expectedVersion`과 명시적 제출을 유지한다. 과거 메시지의 저장 당시 상태를 근거로 업무 완료나 전송 성공을 새로 선언하지 않는다.

## 서버 API·DB

### 1. 범위 계약

새 조회 경로는 **`GET /api/projects/:id/messages/page`**다. 기존 `/messages` GET/POST, `/state`, WsEvent 형식은 유지한다. 페이지 경로는 기존 사용자 API의 Bearer·Host·Origin·IP 검사를 그대로 통과해야 하며, 조회를 이유로 orchestrator/runner를 호출하거나 멤버를 깨우지 않는다.

공용 타입 제안:

```ts
export type MessageScope =
  | { kind: "project" }
  | { kind: "member"; memberId: string };

export interface MessagePage {
  projectId: string;
  scope: MessageScope;       // 서버가 정규화한 범위
  items: Message[];         // (at, id) 오름차순
  nextCursor: string | null;
  hasOlder: boolean;
}
```

| 요청 | 정규화·SQL 범위 |
| --- | --- |
| `scope` 생략 또는 `scope=project` | 해당 `project_id`의 모든 글. 대표의 개별 지시·모든 담당자의 보고·시스템 글 포함 |
| `scope=member&memberId=<현재 root/conductor ID>` | 프로젝트 전체로 정규화. 응답 `scope.kind = project` |
| `scope=member&memberId=<그 밖의 ID>` | 같은 `project_id` 안에서 `member_id = memberId OR target_member_id = memberId` |

root/conductor는 `store.listMembers(projectId)`에서 네이티브 `ChatScope.lead`와 같은 첫 일치 규칙으로 정한다. 이름·handle·`target_name`·`mine`·CLI 제공자·세션 세대로 범위를 추측하지 않는다. 같은 사람이 작성자와 대상으로 모두 기록된 메시지는 한 번만 반환한다. 대표의 target null 지시를 임의로 특정 worker 대화에 추가하지 않는다.

명부에서 사라진 대상도 ID가 남은 기록을 조회할 수 있도록 `requireMember()`를 필수로 호출하지 않는다. 알 수 없는 ID는 해당 프로젝트 내 일치하는 과거 기록 또는 빈 페이지를 반환한다. 다른 프로젝트의 ID를 넣어도 다른 프로젝트 글은 나오지 않는다. 보내기 허용 여부는 별도의 기존 계약이다. 조회 대상이 사라져도 네이티브 기존 “프로젝트 대화로” 안내를 유지한다.

### 2. 요청·검증·응답

```http
GET /api/projects/p_demo/messages/page?scope=project&limit=200
Authorization: Bearer <access-code>

GET /api/projects/p_demo/messages/page?scope=member&memberId=m_design&limit=100&cursor=<opaque-base64url>
```

- `limit`: 생략 시 200. 명시 값은 십진 정수 1…500만 허용한다. 빈 값·0·음수·소수·NaN·지수 표기·500 초과는 400이다. 기존 `parseLimit()`의 clamp 계약을 바꾸지 않고 새 경로에만 엄격한 parser를 둔다.
- `scope`: `project | member`. member에는 빈 값이 아닌 `memberId` 필수. project와 `memberId`를 함께 주면 400. 대상 선택 해제는 문자열 `"null"`을 보내지 않고 project로 요청한다.
- `cursor`: 생략하면 최신 페이지, 있으면 그 경계보다 **엄격하게 이전**인 페이지. `cursor=`는 400. `before`, `offset`, `order`, `after`는 새 경로에서 지원하지 않으며 전달하면 400이다. 같은 query key의 중복도 400으로 거부한다. 허용 query key는 `scope`, `memberId`, `limit`, `cursor`뿐이다.
- URL decoding 후 memberId는 UTF-8 256바이트 이하, cursor는 ASCII base64url 4096자 이하로 제한한다. 생성된 정상 ID는 이보다 작다. 미리 크기를 검사하고 decode/JSON/Zod 검증 실패를 모두 ApiError로 바꾼다. 외부 `unknown` 값은 경계에서 검증하며 타입이 정해진 내부 인자에 불필요한 typeof 검사를 반복하지 않는다.
- 없는 프로젝트 또는 보관된 프로젝트는 `/state`와 동일하게 404. **기존 `/messages` GET의 보관 프로젝트 조회 동작은 변경하지 않는다.**

응답 예시(메시지 객체는 기존 Message 전체 필드를 그대로 사용):

```json
{
  "projectId": "p_demo",
  "scope": { "kind": "member", "memberId": "m_design" },
  "items": [
    {
      "id": "msg_001", "projectId": "p_demo", "at": "2026-11-07T00:00:00.000Z",
      "mine": false, "memberId": "m_design", "who": "디자인 팀장", "kind": "진행",
      "title": "진행 보고", "body": "초안을 정리했습니다.",
      "targetMemberId": null, "targetName": null, "decisionId": null, "fileId": null,
      "attachments": [], "delivery": null, "deliveryNote": null
    }
  ],
  "nextCursor": "<서버가 발급한 불투명 문자열>",
  "hasOlder": true
}
```

`items`가 비었거나 더 이전 글이 없으면 `hasOlder=false`, `nextCursor=null`이다. `hasOlder=true`일 때만 다음 커서를 주며, 커서는 **실제 반환한 가장 오래된 글**에서 만든다. 새 글이 왔다는 이유로 이미 받은 `nextCursor`를 다시 만들지 않는다. 빈 페이지도 200이며 `hasOlder`와 페이지 길이를 클라이언트가 다시 추측하지 않는다. 사용자 데이터 응답에는 `Cache-Control: no-store`를 붙인다.

오류 형식은 기존 `{ error: string }`에 새 경로에서만 선택적 `code`를 더한다. 웹과 네이티브 APIError에도 선택적 code를 디코딩하되 기존 status/message 사용처와 code 없는 구형 오류를 유지한다. 문구를 정규식으로 파싱해 cursor 오류와 scope 변경을 구별하지 않는다.

| 상태 | code / 문구 | 클라이언트 처리 |
| --- | --- | --- |
| 400 | `INVALID_MESSAGE_PAGE_QUERY` / “대화 조회 조건이 잘못되었습니다” | 자동 재시도 중단 |
| 400 | `INVALID_MESSAGE_CURSOR` / “이전 기록의 위치 정보가 올바르지 않습니다” | 현재 기록 유지, 최신부터 다시 보기 제공 |
| 401 | 기존 인증 오류 | 기존 로그아웃·자격증명 처리, history 캐시 제거 |
| 404 | 기존 프로젝트 오류 | 없는/보관 프로젝트 처리. 구형 서버 판별은 아래 별도 규칙 |
| 409 | `MESSAGE_SCOPE_CHANGED` / “대화 대상이 변경되었습니다” | 대상 정규화 재평가, 범위 세대 갱신 후 최초 페이지 |
| 500·네트워크 | 기존 오류 | 커서·기존 글 보존, 명시적 재시도 |

### 3. 커서와 순서

v1 커서의 내부 JSON은 다음과 같다. 이 형식은 서버 내부 계약이며 클라이언트는 직접 만들거나 해석하지 않는다.

```ts
{
  v: 1,
  projectId: string,
  scope: MessageScope,
  before: { at: string, id: string }
}
```

UTF-8 JSON을 base64url로 인코딩한다. 문자열 `at`는 저장값 그대로 보존하며 Date 파싱·재포맷으로 경계를 바꾸지 않는다. `at`는 비어 있지 않은 UTF-8 128바이트 이하, 메시지 ID는 비어 있지 않은 UTF-8 256바이트 이하로 검사한다. 프로젝트 ID에도 256바이트 상한을 적용한다. 현행 ISO UTC·생성 ID 및 마이그레이션 시스템 ID를 수용한다. 기존 DB에 이를 넘는 값이 있으면 임의로 잘라 발급하지 말고 구현 전 fixture/데이터 계약 검토 대상으로 보고한다.

디코딩 후 버전·키 모양·프로젝트·정규화 범위를 검증한다. 프로젝트/임의 대상이 다른 커서는 400이다. 현재 요청이 root/conductor ID의 별칭인데 커서 발급 이후 정규화 범위가 달라진 경우만 409다. 정규 클라이언트는 항상 응답의 정규화 범위를 다음 요청에 사용하므로 이 경우가 드물다. 인증 권한을 커서에 담지 않으며 서명·비밀키는 추가하지 않는다. 변조된 경계가 유효하더라도 조회는 반드시 URL 프로젝트와 정규화 범위로 제한된다. 커서는 재시작 후에도 유효하고, 경계 행이 없어져도 payload의 키로 계속 조회할 수 있다. rowid·OFFSET·메모리 위치·실행기 세션 ID를 사용하지 않는다.

새 API의 유일한 정렬 키는 **`(at COLLATE BINARY, id COLLATE BINARY)`**다. SQL은 내림차순으로 `limit + 1`개를 읽고 초과 한 개를 버린 뒤 결과를 뒤집는다. 같은 시각도 ID로 완전한 순서를 갖는다. 한 번의 읽기에서 items·hasOlder·cursor를 함께 산출하여 별도 COUNT와의 경쟁을 피한다.

클라이언트도 같은 키로 정렬한다. 일반적인 ASCII ID는 JS `<`/`>` 비교로 충분하지만 기존 임의 Unicode ID까지 지원하려면 같은 시각에서 UTF-8 바이트 사전순 비교를 사용한다. Swift도 locale 기반 `compare`가 아닌 UTF-8 사전순을 쓴다. 날짜 표시용 파싱 결과로 정렬하지 않는다. 기존 API의 같은 시각 `rowid` 순서는 호환을 위해 그대로 두고, 새 history 목록은 독립적으로 정렬한다.

### 4. Store 쿼리·인덱스·마이그레이션

추가할 메서드의 설계 시그니처:

```ts
Store.listMessagePage(
  projectId: string,
  opts?: { scope?: MessageScope; cursor?: string; limit?: number }
): MessagePage
```

범위 정규화·커서 확인은 이 조회 경로에서 공통 처리하고 HTTP가 SQL을 직접 작성하지 않는다. 기본 인자는 project/200이다. 내부 typed limit도 정수·유한값·1…500 조건을 만족해야 하며 HTTP 우회 호출에서 잘못된 값이 조용히 다른 페이지를 만들지 않도록 거부한다. 기존 `listMessages`, `nextMessageAt`, `createMessage`, `setMessageDelivery`와 이벤트 발행 의미는 유지한다.

프로젝트 쿼리(첫 페이지는 tuple 조건 자체를 생략한 별도 SQL):

```sql
SELECT * FROM messages
WHERE project_id = ?1 AND (at, id) < (?2, ?3)
ORDER BY at DESC, id DESC
LIMIT ?4; -- limit + 1
```

개별 쿼리는 전체 프로젝트를 가져온 뒤 필터링하지 않는다. 두 인덱스에서 각각 최대 limit+1개를 읽은 뒤 ID를 합쳐 제한한다. 같은 행이 양쪽에 들어갈 수 있으므로 `UNION`으로 중복 제거한다.

```sql
WITH authored AS (
  SELECT id, at FROM messages
  WHERE project_id = ?1 AND member_id = ?2 AND (at, id) < (?3, ?4)
  ORDER BY at DESC, id DESC LIMIT ?5
), targeted AS (
  SELECT id, at FROM messages
  WHERE project_id = ?1 AND target_member_id = ?2 AND (at, id) < (?3, ?4)
  ORDER BY at DESC, id DESC LIMIT ?5
), candidates AS (
  SELECT id, at FROM authored
  UNION
  SELECT id, at FROM targeted
), page_keys AS (
  SELECT id, at FROM candidates ORDER BY at DESC, id DESC LIMIT ?5
)
SELECT m.* FROM page_keys k JOIN messages m ON m.id = k.id
ORDER BY k.at DESC, k.id DESC;
```

여기도 첫 페이지는 양쪽 tuple 조건을 생략한 SQL을 사용한다. 모든 값은 binding하며 문자열 조립은 미리 정의한 첫/다음 페이지 SQL 선택에만 사용한다. 두 branch가 각각 상위 limit+1개를 포함하므로 합친 범위의 상위 limit+1개를 빠뜨리지 않는다. query plan에서 각 branch의 인덱스 seek와 제한을 확인한다. 최종 작은 후보 집합의 정렬은 허용하고 프로젝트 전체 스캔은 허용하지 않는다.

`server/db.ts`의 **구현 시점 MIGRATIONS 마지막에** 다음 한 항목을 추가한다. 현재 병렬 문맥 창 마이그레이션의 번호나 배열 위치를 하드코딩하지 않는다.

```sql
CREATE INDEX messages_project_page ON messages(project_id, at, id);
CREATE INDEX messages_member_page ON messages(project_id, member_id, at, id);
CREATE INDEX messages_target_page ON messages(project_id, target_member_id, at, id);
```

새 컬럼·테이블·메시지 재작성은 필요 없다. 기존 `messages_project(project_id, at)`는 이번에 지우지 않는다. 기존 openDb의 마이그레이션 전 `VACUUM INTO`·0600 백업, 실패 시 중단, 항목별 트랜잭션·user_version 갱신을 그대로 이용한다. 대규모 기록의 인덱스 생성은 시작 시간을 늘릴 수 있으므로 복사된 임시 DB에서 소요 시간·추가 디스크를 확인한다. 원본 데이터나 라이브 DB로 시험하지 않는다.

### 5. 하위 호환과 배포

- 구형 클라이언트 → 새 서버: `GET /messages?before=<at>&limit=`는 Message[]·기존 기본/상한·정렬을 유지한다. `/state.messages`는 최근 200개 배열 그대로다. POST 멱등 ID, 전달 상태, WsEvent.message도 변경하지 않는다. 구형 시각 커서의 한계는 남지만 새 커서와 혼용하지 않는다.
- 새 클라이언트 → 구형 서버: 새 경로가 404일 때 같은 프로젝트 `/state`가 정상 200이면 해당 endpoint/인증 세대에서 paging 미지원으로 기억한다. `/state`도 404면 프로젝트 오류이며, 401·5xx·timeout·JSON 오류를 구형 서버로 판정하지 않는다. 구형 모드에서는 기존 최근 200개와 기존 범위 필터만 표시하고 “이 서버는 이전 기록 불러오기를 지원하지 않습니다. 호스트를 업데이트해 주세요”를 보여준다. 안전하지 않은 timestamp 커서를 새 커서처럼 사용하지 않는다. 재연결 시 capability를 재확인한다.
- 서버를 먼저 배포한 뒤 웹/네이티브를 갱신한다. 실행기를 교체하거나 서비스/소켓을 재시작하는 작업은 이 기능에 포함하지 않는다. docs/spec.md에 신규 경로·정렬·호환을 추가하되 실행기 운영 설명을 이번 작업에서 일괄 변경하지 않는다.

## 웹 변경

### 조회 상태와 실시간 병합

`web/src/lib/message-history.ts`에 범위 필터·키 비교·페이지 병합·빈 구간 감지를 순수 함수로 분리한다. `web/src/lib/store.ts`는 endpoint/auth generation + projectId + 정규화 scope를 키로 다음 상태를 가진다.

```ts
{
  items: Message[];
  nextCursor: string | null;
  hasOlder: boolean;
  initialized: boolean;
  loading: "initial" | "older" | "latest" | "bridge" | null;
  error: string | null;
  generation: number;
  requestId: number;
  // 서버 확인 전 낙관적 메시지 ID 집합은 별도 관리
  // bridge 임시 페이지·커서와 재접속 상태는 visible items와 분리
}
```

1. `api.messagePage(projectId, { scope, cursor?, limit? })`를 추가한다. 기존 `api.messages`는 유지한다. 첫 페이지는 200, 더보기는 100이다. cursor를 query encoder로 인코딩하고 인증 코드를 URL에 싣지 않는다. history store의 `ensureMessageHistory(scope)`·`loadOlderMessages(scope)`·`syncLatestMessageHistory(scope)`가 이 API를 사용한다. 이 이름/타입은 후속 구현 계약이며 이 문서에서 함수를 구현한 것은 아니다.
2. history는 `ProjectState.messages`와 별도다. 홈 최근 보고·Composer 전송 확인·기존 도메인 이벤트는 현재 state 경로로 계속 동작한다. `refresh()`의 `mergeMessages`/`hasMessageGap`가 history 배열·커서를 덮어쓰지 않는다. 초기 history가 준비되기 전에 snapshot 일부를 완전한 페이지로 간주하지 않는다.
3. 동시 호출은 store 수준에서 막는다. 요청 시작 시 연결/프로젝트/범위 세대·requestId·요청 cursor를 캡처하고 응답과 finally 적용 전 모두 검사한다. A→B→A, 로그아웃→로그인, 최신부터 재시작, 같은 ID의 프로젝트 재선택에서 이전 응답·오류·로딩 해제가 새 상태에 섞이지 않는다. 가능하면 요청 취소도 지원하지만 세대 검사를 대체하지 않는다.
4. 오래된 페이지는 ID 기준으로 한 번만 추가한다. DOM index나 시각만으로 dedup하지 않는다. **표시 목록의 oldest가 아니라 응답 nextCursor만** 다음 경계로 사용한다. 로컬 failed/queued도 실제 서버에 저장될 수 있으므로 전달 상태로 저장 여부를 추측하지 않는다. 낙관적 ID는 POST 응답·페이지·WS에서 같은 ID가 확인되면 서버 확인으로 전환한다.
5. history 요청 중 받은 message 이벤트는 요청별 journal에 arrival sequence와 함께 기록한다. 페이지를 병합한 뒤 journal을 순서대로 재적용해 늦은 GET이 `delivered`를 `queued`로 되돌리지 않게 한다. `Message`에는 updatedAt이 없으므로 delivery를 단순 순위 비교하지 않는다. failed→queued 재시도, held 전환도 허용한다. journal은 해당 요청 종료/취소 후 정리한다.
6. 이미 로드한 ID의 이벤트는 제자리에서 갱신한다. 범위에 맞는 신규 tail 이벤트는 추가하고 새 글로 센다. 아직 로드하지 않은 훨씬 과거 ID에 대한 전달 상태 이벤트를 받았다고 그 한 행을 맨 위에 넣어 연속된 범위를 가장하지 않는다. 필요하면 entity overlay에 보관하고 실제 페이지로 확인될 때 반영한다. cursor·hasOlder는 이벤트로 바꾸지 않는다.
7. 최초 페이지 요청 전부터 그 범위에 들어온 이벤트도 버퍼링하고 응답 위에 적용한다. 응답을 받았다는 이유만으로 그 사이 도착한 글·같은 ID 전송 결과를 잃지 않는다. POST로 먼저 확인된 동일 ID와 WS 도착은 한 번만 센다.

### 재접속의 빈 구간 연결

웹 WS 재개 시와 네이티브 폴링에서 공통으로 적용할 알고리즘이다. 현재 표시 범위는 완전하게 이어진 server-confirmed 구간과 별도 낙관적 글로 구분한다.

1. 정규 범위의 최신 200개를 `/page`로 받는다. 기존 구간의 ID와 겹치거나, `hasOlder=false`라 전체를 받은 경우 안전하게 병합한다. 전체 응답인데 기존 확인 ID가 서버 결과에서 사라졌다면 삭제/저장소 교체로 판단하고 아래 재시작 안내를 사용한다.
2. 겹침이 없고 hasOlder=true면 최신 페이지를 **staging**에 두고 그 `nextCursor`부터 과거 방향으로 연결 페이지를 읽는다. 보이던 구간의 oldest cursor는 손대지 않는다. 프로젝트 snapshot의 최근 200개만으로 개별 범위의 빈 구간을 판정하지 않는다.
3. staging이 기존 구간 ID 하나와 겹치면 중간이 모두 연결된다. staging·기존 구간·요청 중 이벤트를 원자적으로 병합한다. 기존 구간이 이미 서버의 처음까지 로드된 상태면 hasOlder=false를 유지하고, 그렇지 않으면 기존 oldest cursor/hasOlder를 유지한다. 기존 구간이 없는 최초 요청이면 새 응답 메타데이터를 사용한다.
4. 연결 조회는 한 범위의 요청 큐에서 older와 직렬화한다. 한 번에 최대 3페이지를 진행하고 여전히 빈 구간이면 “동기화 계속” 버튼으로 다음 묶음을 진행한다. 요청 폭주·사용자의 위쪽 읽기 작업 굶김을 막고 staging은 그대로 보존한다. 정상 3초 폴링은 진행 중 bridge를 처음부터 다시 시작하지 않는다. 연결 중 신규 tail은 staging에, 이미 표시 중인 ID의 상태 변경은 visible 목록에도 반영한다.
5. 실패하면 staging 커서와 기존 화면을 보존한다. 끝까지 가도 겹치지 않으면 임의로 두 구간을 붙이지 않고 저장소 변경 안내와 명시적 “최신 대화부터 다시 보기”를 제공한다. 최신부터 다시 보기를 실행하면 범위 세대를 바꾸고 staging 기준 최신 구간으로 초기화하되 로컬 전송 초안·재시도 ID는 보존한다.

이 방식은 끊긴 동안 201개 이상 쌓였을 때 현재 웹처럼 과거 배열을 자동 삭제하거나, 네이티브에서 새 200개로 조용히 교체하지 않는다. 실제 신규 글 수는 연결 완료 후 기존 confirmed ID·이전 tail을 기준으로 계산하며 bridge/prepend 행을 새 글로 세지 않는다. bridge 중 개수가 불완전하면 숫자 대신 동기화 문구를 사용한다.

### 화면·스크롤

- `Thread.tsx`는 project scope history를 렌더링한다. 현재 없는 웹 개별 대화 UI를 이번 기능에서 만들지 않는다. Composer 대상이나 `route.sub`를 암묵적인 필터로 바꾸지 않는다. 서버/순수 함수는 member scope도 지원해 네이티브와 규칙을 공유한다.
- 실제 scroll root는 Shell의 `[data-scroll-root]`다. 중첩 스크롤을 만들지 않는다. 행 wrapper에 `data-message-id`를 붙이고, 첫 교차 행 ID와 root 안의 top 좌표를 저장한다.
- prepend **요청 시작 때가 아닌 응답 적용 직전** 현재 anchor를 얻는다. 처리 중 사용자가 더 스크롤했으면 그 최신 위치가 기준이다. `useLayoutEffect`에서 같은 행의 새 top과 저장 top의 차이만큼 `scrollTop`을 보정한다. append+prepend가 동시에 와도 바닥 거리나 전체 scrollHeight 차이를 사용하지 않는다.
- 웹의 native scroll anchoring과 수동 보정이 두 번 적용되지 않게, 대화가 활성인 동안 해당 scroll root의 `overflow-anchor`를 비활성화하고 unmount 시 복원한다. React render와 DOM 반영 사이에 anchor가 없는 최초/빈 목록만 별도 초기 pin 규칙을 적용한다.
- 이미지·Markdown·입력창의 늦은 크기 변화는 기존 ResizeObserver 경로를 확장한다. 바닥에 있으면 pin, 과거를 보고 있으면 **직전 레이아웃의 anchor**를 유지한다. 스크롤 중에는 anchor를 갱신하고 programmatic 보정은 사용자 위쪽 이동과 구별한다. 이미지의 크기를 알면 공간을 미리 예약한다.
- pin·unread·복원 상태는 scope key 기준으로 초기화/복구한다. prepend transaction이 append follow보다 우선한다. 전송 직후 따라가기 여부는 send action의 ID로 판정하고 `last.mine`만으로 판정하지 않는다. “맨 아래로”를 누르면 pending anchor 복원을 취소한다.
- 상단 control의 높이 변화도 보정 대상이다. button focus를 유지하고 과거 prepend 전체를 `role=log`의 새 글로 다시 읽지 않도록 history 추가 동안 live announcement를 억제한다. 완료/오류는 별도 `role=status`로 짧게 알린다. 키보드·스크린리더 사용자는 버튼으로 동일하게 접근한다.

## 네이티브 변경

### Mac·iOS 공용 데이터

- `Models.swift`에 엄격한 `MessageScope`와 `MessagePage: Decodable, Sendable`를 추가한다. 페이지 메타데이터가 빠진 응답을 기본값으로 삼아 정상 페이지로 처리하지 않는다. 기존 ProjectState/Message 디코딩과 구형 응답 허용은 유지한다.
- `APIClient.swift`에 `messagePage(projectID:scope:cursor:limit:) async throws -> MessagePage`를 추가한다. path component와 query를 별도로 안전하게 인코딩한다. 기존 같은 origin 검사·Bearer header·redirect 거부·URLSession timeout은 유지한다. 취소 오류를 사용자 실패 문구로 표시하지 않는다.
- `State/ChatHistory.swift`에 `ChatHistoryKey`, 페이지 상태, 정렬·범위 필터·병합·bridge 판단을 분리한다. AppStore는 기존 connection/project generation에 범위 generation과 요청 번호를 더해 소유한다. 이 타입은 Mac/iOS 동일한 동작을 제공한다.
- `AppStore.state.messages`는 계속 최근 도메인 snapshot이다. `history(for:)`, `ensureHistory(for:)`, `loadOlderHistory(for:)`, `syncLatestHistory(for:)`를 별도로 제공한다. `refresh()`의 `state = snapshot.state`가 history 캐시를 교체하지 않는다. polling snapshot을 history 초기 페이지/커서로 변환하지 않는다.
- ChatView가 활성인 동안 선택 scope의 최신 `/page?limit=200`를 기존 전경 3초 polling 완료 흐름에 연결한다. bootstrap/state와 별도 조회하되 같은 scope의 history REST는 직렬화한다. 최신 sync가 밀리면 기존 작업 이후 한 번만 coalesce한다. member 대화가 최근 프로젝트 200개 밖에만 있어도 해당 scope를 직접 조회한다. ChatView가 보이지 않으면 추가 history polling은 멈추고 재진입 시 최신을 조회한다. WS/APNs를 새로 구현하지 않는다.
- POST/resend로 확인한 Message도 history overlay에 넣는다. page GET 시작 후 온 POST 응답은 웹의 journal과 같은 방식으로 우선 반영한다. GET끼리는 직렬화하여 오래된 latest 응답이 새 페이지 결과를 덮지 않게 한다. 페이지에 이미 있는 동일 ID는 합치고 낙관적 상태로 되돌리지 않는다.
- 연결 실패는 기존 markUnreachable/handle 흐름을 재사용한다. history 로딩/오류는 읽기 전용 상태이며 `pendingActions` 또는 `canWrite` 기반의 mutate 경로에 넣지 않는다. 401·disconnect·endpoint 변경 시 모든 history 작업과 민감한 캐시를 정리한다. 프로젝트 삭제/보관 시 해당 범위를 무효화한다.
- 최근 도메인 snapshot과 history를 단순 합쳐 `unresolvedDeliveries()`를 다시 계산하지 않는다. 그러면 오래된 failed 글을 현재의 최신 전송 실패로 되살릴 수 있다. 과거 bubble은 조회 당시 delivery를 표시하되, “이 대상의 최신 문제” CTA는 기존 최신 상태와 확인된 관계를 기준으로 유지한다. 과거 기록 로딩 때문에 대표에게 새 행동이 필요하다고 잘못 표시하지 않는다.

### ChatView와 스크롤 위치

`ChatScope`의 정규화 규칙·threadKey는 유지하고 `messages`를 해당 scope의 history로 교체한다. 최근 200개 제한 Label은 상단 로딩/끝/재시도 control로 교체한다. 기존 전체/담당자 선택, 사라진 대상 안내, Mac 하단 ComposerBar, iOS 작성창, 결재·자료 링크는 그대로 연결한다.

macOS 14 / iOS 17 최소 버전을 유지한다. 단순 `.onAppear`는 LazyVStack prefetch 때문에 화면 진입만으로 호출될 수 있으므로 실제 viewport 내 sentinel 위치와 사용자 스크롤 의도를 함께 검사한다. `ForEach`의 메시지 ID는 기존 `m:<message.id>`를 유지하고 날짜 구분선 ID를 anchor로 사용하지 않는다.

**픽셀/포인트 위치를 지키기 위해** `Views/ChatScrollAnchor.swift`에 플랫폼별 작은 adapter를 둔다. SwiftUI `ScrollView`·`LazyVStack`·`ScrollViewReader`를 유지하면서 다음 역할만 담당한다.

1. 메시지 row geometry preference로 첫 부분 노출 메시지 ID·viewport 안의 top 좌표를 추적한다. 콘텐츠 안에 삽입한 `NSViewRepresentable`/`UIViewRepresentable` probe에서 public 상위 뷰 관계로 해당 대화의 `NSScrollView`/`UIScrollView`를 확인한다. 전역 window 검색, private class 이름·KVC, 기존 SwiftUI scroll delegate 교체는 사용하지 않는다.
2. 페이지가 돌아오면 즉시 배열을 바꾸지 않고 현재 사용자 위치를 캡처한 뒤 MainActor에서 하나의 prepend transaction으로 반영한다. 레이아웃 후 같은 메시지의 top 차이만큼 offset을 보정한다. pending transaction과 scope token이 일치할 때만 보정한다. `.scrollTo(id, anchor: .top)`만으로 부분 노출량을 잃는 구현은 합격 처리하지 않는다.
3. Mac은 문서 좌표를 위에서 아래로 정규화한 후 clipView의 bounds origin을 조정하고 `reflectScrolledClipView`를 호출한다. flipped 좌표·padding을 실제 좌표 변환에 포함하고 범위를 유효한 content bounds로 제한한다. 입력 포커스와 텍스트 선택을 빼앗지 않는다.
4. iOS는 adjustedContentInset을 반영한 contentOffset을 같은 delta로 보정한다. 드래그/감속 중 응답은 보관하고 스크롤이 안정된 뒤 적용하며, 그때의 anchor를 캡처한다. 시스템 delegate를 교체하지 않고 public gesture/offset 관찰과 필요한 동안의 프레임 관찰로 종료를 확인한다. 키보드 interactive dismiss·safe area·회전이 offset 계산에 포함된다.
5. 리스트 높이 변화 관찰은 바닥 pin과 과거 anchor 보정 중 하나만 실행한다. 날짜 구분선 추가, 이미지 늦은 로딩, Dynamic Type, Mac 창 크기 변화에서 중복 보정 루프를 막는다. 화면 전체가 재생성되는 `.id(key)`의 범위와 ScrollViewReader 소유권을 조정하여 다른 범위의 복원이 실행되지 않게 한다.

probe가 scroll host를 찾지 못하면 잘못된 스크롤 뷰를 조작하지 않는다. 이 상황은 구현 검증 실패로 간주하여 지원 OS에서 해결한 뒤 배포한다. “버튼은 되니 위치 점프는 허용”하는 식으로 완료 처리하지 않는다. 네이티브 scroll 구조 의존성은 아래 위험에 기록한다.

`ChatThread.follow`는 tail ID 변화만 보지 않고 `initial / prepend / append / update / restore` 변경 원인을 구분한다. 첫 진입과 바닥 상태의 신규 append만 자동 추적한다. 자신의 명시적 전송 ID는 기존 정책대로 따라가고, prepend 안의 내 메시지·동일 ID 상태 갱신·scope 복원은 추적하지 않는다. Reduce Motion에서는 애니메이션 없이 같은 결과를 보장한다.

VoiceOver에 로딩/추가 완료/오류를 알리고 과거 전체를 새 대화로 재낭독하지 않는다. iPhone 세로·가로·키보드 열린 상태, Mac 휠/트랙패드·키보드 탐색 모두 동일한 paging 계약을 따른다. 새 카드를 디자인하거나 `Design/*.swift`를 수정할 필요는 없다.

### 캐시 수명

연결 세대별로 현재 범위와 최근 사용한 비활성 범위 최대 2개를 메모리에 보관한다. 범위별 읽던 ID·부분 offset도 함께 저장한다. 비활성 LRU eviction 이후 재방문은 최신부터 시작한다. 활성 범위의 이미 읽은 페이지를 임의의 200/500개 상한으로 잘라내지 않는다. 모든 과거 기록은 계속 읽을 수 있어야 한다. 이번 범위에는 디스크 캐시·SQLite 복제·백그라운드 동기화가 없다. 웹도 같은 캐시 수명 원칙을 적용한다.

## 시험

### 격리 원칙과 이번 설계 작업의 검증

이번 작업에서는 소스 읽기와 설계 파일 형식 확인만 수행한다. 구현·타입 변경이 없으므로 컴파일·서버 기동·브라우저 접속·Swift 빌드는 수행하지 않는다. 아래는 **후속 구현에서 추가/실행할 시험**이며 통과한 결과가 아니다.

각 fixture는 `mkdtempSync(join(tmpdir(), "iamceo-chat-paging-"))`로 임시 루트를 만들고 명시적 `IAMCEO_HOME`을 전달한다. HTTP 서버는 `127.0.0.1`의 port 0을 사용하고 **실제 할당 포트가 7878이면 중단 후 다른 포트를 할당**한다. 인증 코드는 fixture 전용 값이다. DB·config·uploads·백업은 모두 해당 임시 루트 안에 둔다. 종료 시 server.stop, DB close, observer/브라우저 정리 후 자신이 만든 임시 폴더만 삭제한다.

API/store paging 시험은 fake Orchestrator를 사용하며 어떤 runner도 실행하지 않는다. UI 시험도 runnerEnabled=false인 가짜 프로젝트를 기본으로 사용한다. 기존 core 흐름과의 회귀를 추가 확인할 때만 `tests/fixtures/core-browser-harness.ts`의 가짜 JSON-RPC core를 사용한다. `IAMCEO_HERDR_SOCKET`은 임시 존재하지 않는 경로로, 필요한 `IAMCEO_CORE_SOCKET`은 fixture 소켓으로 명시한다. 상속된 HC/HERDR/중첩 CLI 변수를 제거하고 XDG·세션·fake CLI 데이터도 임시 루트로 지정한다. 실제 7878, `~/.iamceo`, 사용자 config.json, live herdr/core socket에는 읽기·연결도 하지 않는다.

### 추가할 서버·DB 시험 — `tests/chat-paging.test.ts`

- 0, 1, 199, 200, 201, 500, 501, 1,205개 기록에서 첫/중간/마지막 페이지, hasOlder/nextCursor의 정확성. 마지막 페이지가 정확히 limit개일 때도 false인지 확인한다.
- **명시적으로 같은 `at`를 넣은 1,205개**를 작은 페이지로 모두 순회하여 SQL `(at,id)` 전체 정렬 결과와 일치하고 중복·누락이 없는지 확인한다. 단조 증가 시각만 시험하는 기존 core.test를 대체하지 않는다.
- 임의 Unicode ID, 동일 시각의 서로 다른 ID, 시스템 마이그레이션 메시지, 재시작으로 시각이 되돌아간 데이터에서도 tuple 비교·커서 round trip이 맞는지 확인한다.
- 프로젝트/HQ 전체, worker 작성자만·대상만·양쪽 같은 ID·타 직원·null target·시스템 글. 대상 글이 프로젝트 최근 200개 밖에만 있어도 member 최초 페이지에 나온다.
- root/conductor 별칭, 총괄 없음, 명부에서 제거된 ID, 외부 프로젝트 ID, 세션 세대/CLI 변경 후 동일 member ID의 과거 기록. 정상화된 scope와 cursor 범위 분리를 확인한다.
- limit/query 중복/알 수 없는 key/빈 cursor/잘못된 base64url·JSON·버전·구조/과대 payload/다른 프로젝트·범위 커서/정규화 변경. 400·409와 정해진 code, 인증 누락 401, 없는/보관 프로젝트 404를 확인한다.
- 페이지 사이 tail 추가·delivery 수정·경계 행 삭제 후 재사용·같은 cursor 재시도. 기존 페이지 경계가 바뀌지 않고 중복·누락 없이 진행하는지 확인한다. delivery 갱신이 at/id를 바꾸지 않는지 확인한다.
- 기존 Message[] GET과 `/state.messages` 200개·같은 시각 rowid 순서·POST 동일 ID 멱등 동작이 그대로인지 회귀 확인한다. fake Orchestrator 호출 횟수가 paging 전후 0인지 확인한다.
- MIGRATIONS의 paging 추가 직전 버전으로 만든 **임시 파일 DB**에서 upgrade, 세 인덱스 존재, 기존 Message 내용 보존, user_version 증가·재오픈 무중복·0600 백업·백업 원본 스키마를 확인한다. 번호는 해당 migration 위치에서 동적으로 계산한다. 문맥 창 migration과 함께 올라가는 경로도 확인한다.
- 다수 프로젝트와 한 프로젝트 100,000개/희소 member 데이터에서 `EXPLAIN QUERY PLAN` 확인. 각 branch의 인덱스 선택과 limit 이전 대규모 scan/sort가 없는지 확인하고 첫/깊은 페이지 시간을 기록한다. 절대 실행시간만으로 불안정한 단위 시험을 만들지 말고 query plan·반환 정확성·fixture 크기를 근거로 남긴다.

### 추가할 웹 상태 시험 — `tests/chat-paging-web.test.ts`, 기존 `tests/web-lib.test.ts`

- UTF-8 tie 정렬·범위 predicate·ID dedup·서버 확인 전 로컬 글의 경계 제외. 기존 upsert/merge/hasMessageGap 시험은 구형 도메인 경로 회귀로 유지한다.
- 최초·older·latest 응답보다 뒤에 온 WS/POST가 먼저 처리된 경우 journal 재적용. delivered→늦은 queued 방지와 failed→queued 명시적 재시도 모두 확인한다.
- 같은 범위 이중 호출 차단, A→B→A, logout/login, reset, 늦은 실패/finally, cursor 재사용 재시도, 빈 응답 종료. hasOlder를 배열 길이로 재추측하지 않는지 확인한다.
- snapshot refresh 뒤 이미 로드한 history·cursor가 남고, 새 글 append/동일 ID update/prepend가 각각 올바른 unread 변경을 발생시키는지 확인한다.
- 250개/700개/여러 페이지 재접속 gap에서 staging→겹침→원자적 연결, 3페이지 제한·계속 버튼, bridge 실패 재시도, 저장소 교체·처음까지 불일치, 낙관적 ID만 겹치는 경우를 시험한다. 낙관적 ID는 연속 구간 증거가 아니다.
- page 404 + state 200만 구형 모드로 전환. 401·5xx·오프라인·state 404는 전환하지 않는다.

### 추가할 웹 화면 시험 — `tests/chat-paging.browser.ts`

`tests/browser.test.ts`의 별도 Bun 자식 프로세스 실행 목록에 등록한다. 기존 브라우저 suite의 격리 방식을 유지한다. fixture는 앱 서버와 fake 데이터를 전용 임시 HOME/임의 포트로 제공하며 실제 프로젝트/모델을 사용하지 않는다.

- 1,205개를 준비하고 위로 2회 이상 읽어 DOM ID와 API cursor를 확인한다. 자동/버튼/키보드 로딩·초기 화면 자동 폭주 없음·끝 상태·오류 후 자동 재시도 중단을 검증한다.
- **prepend 요청을 지연시킨 사이** 새 tail과 delivery 이벤트를 보내고 사용자가 추가 스크롤한다. 응답 적용 직전 anchor ID의 viewport y와 적용 후 y 차이가 안정 레이아웃에서 **2 CSS px 이내**인지 확인한다. scrollHeight 차이만 검사하지 않는다.
- 이미지 지연 로딩, 긴 Markdown, 상단 오류줄 표시/해제, Composer 높이 변화, 모바일 키보드에 준하는 viewport resize에서도 같은 메시지를 유지한다. pinned 상태는 최신을 유지한다.
- 상태 갱신/prepend는 unread를 늘리지 않고 신규 tail만 증가, 버튼 이동 후 초기화. 다른 범위/프로젝트의 지연 응답이 현재 화면에 나타나지 않는다.
- Chromium과 WebKit, 데스크톱과 iPhone 크기에서 실행한다. 브라우저 WebKit 시험을 iPhone 실기기 네이티브 시험으로 보고하지 않는다. 기존 `screens-regress.browser.ts` 대화·전송 회귀도 유지한다.

### 추가할 Swift 시험 — `native/Tests/IAMCEOTests/ChatHistoryTests.swift`

- MessagePage 엄격한 decoding·scope·query escaping·Bearer 유지·cursor opaque 처리, 구형 서버와 401 구분. 네트워크는 URLProtocol fixture로 전부 가로채며 `persistCredentials: false`를 사용한다. fixture URL은 7878을 사용하지 않는다.
- `AppStore.refresh()` 3회 후 과거 history·cursor 보존, member scoped polling, background/화면 이탈 시 추가 요청 중지, foreground 복귀 최신 연결, demo 네트워크 0건.
- MainActor 상태에서 same-scope single flight·A→B→A·connection/project generation·취소·늦은 finally·연결 실패 재시도·POST와 GET 역전·중복 ID 처리.
- 웹과 같은 scope·Unicode tie 정렬·bridge fixture·hasOlder/unread 원인 분리. 임시 최신 200개로 이전 페이지가 사라지지 않는지 확인한다.
- anchor 상태 기계의 prepend/append/update/사용자 jump 우선순위와 범위별 복원 상태·LRU eviction을 순수/모의 좌표로 시험한다. 좌표 모의 시험만으로 실제 SwiftUI 레이아웃 검증을 대체하지 않는다.

Mac 앱과 iOS 시뮬레이터에서 격리 데몬을 연결해 별도 수동 QA를 수행한다. 부분 노출된 긴 메시지, prepend+append, 3초 polling, 이미지·날짜 경계, Mac 창 크기, iPhone 회전·키보드·관성 스크롤·Dynamic Type·VoiceOver·Reduce Motion을 포함한다. 안정 레이아웃에서 같은 anchor의 위치 차이 **2pt 이내**, 스크롤 중에는 현재 제스처를 방해하지 않는 것을 합격 기준으로 한다. 실제 iPhone 원격 장기 운용은 별도 남은 검증으로 기록한다.

후속 구현 검증 명령은 `bun run typecheck`, 신규 서버/웹 단위 시험, 기존 `tests/core.test.ts`·`tests/http.test.ts`·`tests/web-lib.test.ts`·마이그레이션 회귀, 개별 브라우저 suite, `swift test --package-path native`다. Swift scratch/build cache는 임시 폴더로 지정하고 Mac/iOS 빌드 산출물도 분리한다. 기존 전체 suite는 실행 전 fixture의 live socket·HOME 접근 여부를 점검한 뒤 격리된 환경에서 수행한다. 이 설계 작업에서는 실행하지 않았다.

## 위험·미정

- **병렬 소유권 충돌:** `server/db.ts`, `server/store.ts`, `shared/types.ts`는 현재 문맥 창 수정자와 겹친다. migration은 그 변경 뒤에 추가하며 Member/context 관련 블록을 재작성하지 않는다. `server/runner/herdr.ts`, `context.ts`, `tests/context.test.ts`는 읽기만 했고 이 기능의 수정 대상이 아니다. `native/Sources/IAMCEO/Design/*.swift` 역시 수정 대상이 아니다. 카드 유리 작업과는 ChatView가 사용하는 기존 스타일 API를 유지하는 방식으로 조정한다.
- 문서에는 이미 core 기본이라는 설명이 있지만 사용자가 알려준 실제 라이브는 herdr다. paging을 근거로 실행기를 전환하거나 소켓을 조회하지 않는다. 저장된 메시지를 조회하므로 양쪽 runner의 작성 경로를 유지하면 동일하게 동작한다.
- 동일 시각에서 신규 history API의 id 순서는 구형 rowid 순서와 다를 수 있다. 새 화면은 결정적인 순서를 사용하고 구형 API는 보존한다. 신구 목록의 순서를 섞어 cursor를 추론하지 않는다.
- `Message`에는 수정 버전이 없다. journal은 **요청 중 역전**을 해결하지만 모든 과거 글의 무기한 실시간 최신성을 보장하지 않는다. 특히 네이티브의 최근 200개 밖 전달 상태는 마지막 조회 시점 값이다. 과거 CTA는 최신 도메인 확인을 거치며, 전체 과거 delivery의 실시간 동기화/영속 revision은 별도 과제로 남긴다. delivery 순위로 이를 감추지 않는다.
- 순회는 현재 DB의 keyset 조회이며 전체 기간의 고정 snapshot은 아니다. 일반 tail append·동일 시각·상태 변경에는 안전하다. 이미 지나간 경계 뒤로 과거 시각의 행을 삽입하는 별도 import나 DB 복원은 새 조회까지 반영되지 않을 수 있다. 현재 공개 메시지 API는 사용자 지정 at를 받지 않는다. 향후 import 기능은 invalidate/reset 계약이 필요하다.
- 네이티브 public scroll-host probe는 SwiftUI 내부 계층 변화의 영향을 받는다. 최소 지원 OS·현재 OS에서 검증하고 범위를 해당 대화로 엄격히 제한한다. 구현 첫 단계에서 부분 offset 유지 prototype을 확인한다. 지원 OS에서 해결할 수 없다면 native scroll container를 직접 소유하는 대안의 비용을 재산정해야 하며, 임의 top snapping으로 요구를 낮추지 않는다.
- 활성 대화의 메모리/웹 DOM은 읽은 분량에 비례한다. 비활성 캐시는 LRU로 제한하되 현재 기록을 잘라 paging 기능을 제한하지 않는다. 긴 Markdown·첨부가 많은 10,000개 기록에서 메모리와 스크롤을 측정한다. 성능이 부족하면 별도 windowing/가상화 작업이 필요하며 이번 설계에 새 가상화 라이브러리를 가정하지 않는다.
- 인덱스 세 개와 migration backup은 디스크와 시작 시간이 추가된다. 100,000개 fixture의 계획/시간과 backup 공간을 기록한다. 기존 인덱스 제거는 별도 검토다.
- 재접속 gap이 매우 크면 여러 번 “동기화 계속”이 필요하다. 이는 대량 자동 다운로드를 막는 정해진 정책이다. 중간을 연결하기 전에는 새 tail을 기존 목록에 붙이지 않는다.
- 새 패키지나 버전 업그레이드는 필요 없다. 레포 package.json의 기존 범위와 lockfile을 유지한다. 최신 도구 설치·TS/React 버전 교체는 이 기능과 묶지 않는다. 이 문서 작성에서는 외부 패키지를 사용하지 않았다.

## 소유자 할 일

1. **서버/API 담당:** 공용 MessageScope/MessagePage와 신규 route·검증·Store 쿼리를 구현한다. 문맥 창 담당자와 `db.ts`·`store.ts`·`types.ts` 소유 구간을 먼저 합의하고, 최신 migration 끝에 인덱스를 추가한다. legacy route/runner writer는 유지한다. 새 HTTP/DB 시험과 docs/spec.md 갱신을 소유한다.
2. **웹 담당:** history 순수 로직·별도 store·WS/POST journal·bridge·Thread anchor를 구현한다. 기존 Composer의 보내기 범위와 전체 대화 조회를 분리한다. 신구 서버 fallback과 browser/순수 함수 시험을 소유한다.
3. **네이티브 담당:** API/model·ChatHistory 상태·AppStore polling 통합·ChatScope binding·플랫폼 anchor adapter를 구현한다. 시작 시 Mac/iOS 부분 노출 위치 보존을 먼저 검증한다. Design 파일은 카드 유리 담당자에게 맡기며 최소 OS를 올리지 않는다. Swift 시험과 양쪽 플랫폼 QA를 소유한다.
4. **통합 소유자:** 아래 API/순서 계약을 먼저 확정해 세 담당자가 fixture로 병렬 구현할 수 있게 한다. 스크롤 QA에서 prepend와 실시간 append를 반드시 함께 재현한다. 구현 단계에서 이 역할 분할은 가능하지만 **이번 문서 작성에서 다른 에이전트를 실행한 것은 아니다.**
5. 완료 판정 전 신규·legacy 시험 결과, migration/query plan, Chromium/WebKit anchor 오차, Mac/iOS anchor 오차·접근성 결과를 모은다. 실행기 전환·라이브 DB migration·배포는 이 설계서 작성 완료와 별개의 사용자 운영 작업이다. 라이브/실기기 검증을 수행하지 않았다면 그대로 남긴다.

## 파일 목록

아래는 **후속 구현 때 고칠 파일 전부**다. 생성 대상 포함, 절대경로 한 줄에 하나이며 이번 작업에서 실제 수정한 코드 목록이 아니다. `server/db.ts`, `server/store.ts`, `shared/types.ts`는 위에서 표시한 병렬 작업 중첩 파일이다. 테스트용 런타임 임시 DB/포트/캐시는 레포 산출물 목록에 포함하지 않는다.

```text
/Users/yesung/iamceo/shared/types.ts
/Users/yesung/iamceo/server/db.ts
/Users/yesung/iamceo/server/store.ts
/Users/yesung/iamceo/server/http.ts
/Users/yesung/iamceo/web/src/lib/api.ts
/Users/yesung/iamceo/web/src/lib/message-history.ts
/Users/yesung/iamceo/web/src/lib/store.ts
/Users/yesung/iamceo/web/src/screens/Thread.tsx
/Users/yesung/iamceo/web/src/styles/thread.css
/Users/yesung/iamceo/native/Sources/IAMCEO/Models/Models.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Services/APIClient.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/State/ChatHistory.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/State/AppStore.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/ChatView.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/ChatScrollAnchor.swift
/Users/yesung/iamceo/tests/chat-paging.test.ts
/Users/yesung/iamceo/tests/chat-paging-web.test.ts
/Users/yesung/iamceo/tests/web-lib.test.ts
/Users/yesung/iamceo/tests/chat-paging.browser.ts
/Users/yesung/iamceo/tests/browser.test.ts
/Users/yesung/iamceo/native/Tests/IAMCEOTests/ChatHistoryTests.swift
/Users/yesung/iamceo/docs/spec.md
```

## 크기

**L.** SQL/커서 자체는 M이지만, 웹의 기존 paging 전환과 WS 역전 보호, 네이티브 3초 snapshot과 분리된 대상별 history, 재접속 gap 연결, macOS 14/iOS 17의 부분 스크롤 위치 유지, 신구 클라이언트 호환을 함께 보장해야 한다. 서버 → 계약 fixture → 웹/네이티브 병렬 구현 → 동시 prepend/append 통합 QA 순으로 진행한다. 실행기 변경·새 UI 디자인·APNs·네이티브 WS·전역 과거 상태 revision은 크기에 포함하지 않는다.
