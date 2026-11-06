# 실시간 동기화 구현 설계서

작성일: 2026-11-07. 이 문서는 구현 계획이며 코드 변경·마이그레이션·서버 접속을 수행한 기록이 아니다. 이번 산출물은 `.pumasi/specs/realtime.md` 하나다.

범위: 네이티브 전경의 3초 bootstrap/state 폴링을 기존 WebSocket 기반 동기화로 대체하고, 웹과 인증·순번·재동기화 계약을 맞춘다. APNs, 백그라운드 상시 연결, 터미널 스트리밍, 실행기 전환은 별도 기능이다. 목표 실행기는 core지만 현재 라이브 herdr와 기존 클라이언트의 계약을 유지한다. 문서 속 production core 설명을 근거로 라이브 실행기를 바꾸지 않는다.

실제로 확인한 현재 구현:

| 근거 | 현재 동작과 설계상 의미 |
| --- | --- |
| `docs/claude-handoff.md` 전체, 특히 §7·§8 | 네이티브 WebSocket/APNs 미구현. 초안, 결재 버전, 전송 불확실성, 인증정보 보호 계약을 유지해야 한다. |
| `server/http.ts`의 `startServer` | `/ws`는 Bearer 또는 `?t=`로 인증하고 전 IP/Host/Origin 검사를 거친다. open에서 구독 후 `{type:"hello",seq:bus.seq}` 전송. 동일 Bus 이벤트를 모든 listen 서버에 방송하고 15초마다 JSON `{type:"ping"}` 전송. 수신 메시지는 무시한다. SSE 라우트는 없다. |
| `server/bus.ts`, `server/db.ts`, `shared/types.ts` | `Bus.seq`는 메모리 이벤트 개수이며 emit마다 증가한다. 일반 이벤트에는 순번이 없고 재시작하면 0이다. `change_seq`, 변경 이력 테이블, replay API는 없다. DB에는 별도의 `PRAGMA user_version` 마이그레이션 버전이 있다. 둘을 혼동하지 않는다. |
| `server/store.ts` | project/member/member_removed/decision/todo/work/message/file/activity/settings 등의 기존 이벤트와 프로젝트 요약을 발행한다. `projectState()`는 동기 SQLite 조회로 최근 메시지 200개·처리 결재 최근 50개와 전체 처리 건수를 반환한다. |
| `web/src/lib/api.ts`, `web/src/lib/store.ts` | 현재 웹도 `/ws`를 쓴다. 접속 코드를 URL에 싣는 `wsUrl()`은 §8과 어긋난다. 재접속마다 bootstrap/state를 받고 중간 이벤트를 버퍼링하여 다시 적용한다. 재접속 0.5~15초, 45초 무응답 감지, 전경/online 복귀 처리가 있다. `hello.seq`로 누락을 검사하지 않는다. |
| `native/.../State/AppStore.swift` | `connect` 후 `startPolling()`이 전경에서 3초마다 bootstrap/state를 조회한다. foreground 복귀 즉시 조회하지 않고 다음 tick을 기다린다. generation/projectGeneration/refreshGeneration이 늦은 응답을 막는다. 끊기면 마지막 데이터를 읽기 전용으로 유지한다. |
| `native/.../Services/APIClient.swift`, `Models/Models.swift`, `Services/Pairing.swift` | APIClient는 actor, Bearer·ephemeral URLSession·redirect 거부를 사용한다. endpoint별 Keychain을 사용한다. 현재 endpoint 검증은 HTTPS와 loopback HTTP뿐 아니라 Tailscale HTTP도 허용한다. 문서의 ‘원격 HTTPS만’ 설명보다 실제 코드가 넓다. |
| `IAMCEOApp.swift`, `Views/SettingsView.swift`, `Views/AppShell.swift` | App 수준 aggregate scenePhase로 active 여부를 전달한다. 설정에는 ‘3초마다 동기화’와 마지막 데이터 갱신 20초 기준 경고가 있다. 연결 상태와 실시간 구독 상태를 분리해야 한다. |
| `Views/TerminalView.swift`, `Views/TeamView.swift` | 터미널 screen은 별도 2초 조회, 활동 패널은 열기/수동 새로 고침/재연결 때 조회한다. 프로젝트 스냅샷에 활동 기록·터미널 화면은 없다. |
| `server/orchestrator.ts`, `server/runner/core.ts`, `herdr.ts`, `context.ts` | 실행기→orchestrator→Store/Bus 경로를 유지할 수 있다. 특히 `runtimeInfo()`는 core 확인 및 바이너리 `--version` 실행까지 한다. 이벤트마다 bootstrap 전체를 다시 요청하는 방식은 피한다. |

## 사용자 동작

1. Mac·iPhone에서 기존 서버 주소와 접속 코드로 연결한다. 별도 구독 버튼은 없다. 초기 상태 조회 성공 후 소켓 구독과 재동기화를 마치면 **“실시간으로 연결됨”**을 표시한다. 구독을 여는 동안 **“실시간 연결 중…”**, 스냅샷을 맞추는 동안 **“최신 상태를 불러오는 중…”**을 표시한다.
2. 다른 기기의 결재 답변·새 메시지·담당자 상태·자료·프로젝트 보관을 자동 반영한다. 네이티브는 관련 이벤트를 묶어 서버 스냅샷을 읽는다. 정상 연결 중 주기적인 bootstrap/state 조회는 없다. 수동 **“지금 동기화”**, Mac ⌘R, 기존 당겨서 새로 고침은 유지한다.
3. 소켓만 끊기고 REST는 성공하면 **“실시간 연결이 끊겨 주기적으로 확인하고 있습니다”**와 **“지금 다시 연결”**을 보여준다. 마지막 서버 조회가 성공한 상태라면 기존 REST 쓰기는 가능하다. 소켓 단절을 곧바로 서버 장애나 CLI 장애로 표현하지 않는다.
4. REST도 실패하면 **“서버와 연결이 끊겼습니다. 다시 잇는 중입니다.”**를 표시하고 마지막 스냅샷은 읽기 전용으로 남긴다. 원격 실패 안내는 **“Mac과 이 기기의 Tailscale 연결, Mac의 잠자기 상태를 확인해 주세요.”**다. 성공한 새 상태 조회 전에는 쓰기를 다시 열지 않는다.
5. 접속 코드 거절이 REST 401로 확인되면 **“접속 코드가 바뀌었거나 올바르지 않습니다. 다시 넣어 주세요.”**를 표시하고 자동 연결/폴링을 중지한다. 403은 **“서버 주소나 접근 허용 설정을 확인해 주세요.”**로 구분하며 코드를 임의 삭제하지 않는다.
6. iPhone 잠금·앱 배경 전환 및 Mac 비활성/잠자기에는 **“앱이 비활성 상태여서 동기화를 쉬고 있습니다”** 상태로 바뀐다. 복귀하면 즉시 구독을 새로 열고 전체 상태를 맞춘다. 배경에서 실시간 알림이 온다고 안내하지 않는다.
7. 서버 작업은 클라이언트 소켓과 독립적으로 계속된다. 재연결 때문에 메시지 전송·결재 답변·터미널 입력을 자동 재실행하지 않는다. 전송/큐 저장/CLI 전달/턴 종료/업무 완료를 합치지 않는다. 작성 중 대상별 초안·결재 메모를 유지하고, 결재 버전이 바뀌면 기존 재검토 흐름을 따른다.
8. 연결 표시에는 서버 도달 상태, 실시간/대체 조회/일시중지, 마지막 데이터 조회 시각을 구분한다. 변경이 없어 마지막 데이터 시각이 오래되어도 정상 heartbeat가 오면 지연 경고를 내지 않는다. 샘플 모드는 **“샘플 데이터 · 읽기 전용”**이며 네트워크 작업을 만들지 않는다.

## 서버 API·DB

### 1. 기존 라우트와 새 계약

기존 REST, agent 토큰, Store 쓰기 동작은 그대로 둔다. 새 API는 사용자 접속 코드 인증만 받고 멤버 MCP 토큰은 받지 않는다. 전체 데이터 권한은 기존과 같이 호스트 단위다.

| 라우트 | 요청 | 응답·오류 |
| --- | --- | --- |
| `GET /ws` | 기존 Bearer 또는 `?t=<code>` | 기존 101 및 v1 hello/domain/ping 모양 유지. 기존 클라이언트만을 위한 하위 호환 경로다. |
| `GET /ws?v=2` | 네이티브: `Authorization: Bearer <code>`. 웹: 아래 전용 쿠키. body 없음 | 101 뒤 v2 hello/domain/ping. v2에서는 `t`가 있으면 400 `{error:"실시간 연결 주소에 접속 코드를 넣지 마세요"}`. 미인증 401, IP/Host/Origin 거절 403, upgrade 아님 400. v가 없으면 v1, `2` 외 명시 값은 400. |
| `GET /api/sync` | Bearer. 선택적 `?projectId=<percent-encoded-id>` 한 개. body 없음 | 아래 `SyncSnapshot`, 200. 미지정은 프로젝트 상태를 포함하지 않는다. 빈 값·중복 projectId·알 수 없는 query는 400. 프로젝트 없음/보관은 404가 아니라 결과 필드로 반환한다. |
| `POST /api/ws-session` | 웹 전용, Bearer, `Content-Type: application/json`, `{}`. 기존 Host 검사와 일치하는 유효한 HTTP(S) `Origin` 필수 | 204, `Cache-Control: no-store`, `Set-Cookie` 하나. 인증 실패 401, Origin 없음/불일치 403, 잘못된 JSON 400. |
| `DELETE /api/ws-session` | 웹 전용, 동일 Origin 필수. 인증 없이 해당 쿠키만 지울 수 있음 | 204, 동일 scope의 쿠키 `Max-Age=0`. 로그아웃/401에서 사용. |
| `GET /api/bootstrap`, `GET /api/projects/:id/state`, `GET /api/runtime` | 기존 Bearer·요청 모양 유지 | 기존 응답 모양 유지. 구형 앱과 진단 화면이 계속 사용한다. |

`/api/sync` 예시(꺾쇠 부분은 기존 타입 전체 객체를 뜻하며 실제 JSON 문자열이 아니다):

```ts
interface SyncCursor { epoch: string; seq: number }
interface SyncSnapshot {
  protocol: 2;
  cursor: SyncCursor;
  requestedProjectId: string | null;
  projectStatus: "none" | "ok" | "not_found" | "archived";
  bootstrap: Omit<Bootstrap, "runtime">;
  state: ProjectState | null;
}
// GET /api/sync?projectId=p_123
// { protocol:2, cursor:{epoch:"<uuid>",seq:42}, requestedProjectId:"p_123",
//   projectStatus:"ok", bootstrap:<기존 bootstrap에서 runtime만 제외>, state:<ProjectState> }
```

`none`은 요청 ID와 state가 null, `ok`는 요청 ID와 state.project.id가 동일, `not_found/archived`는 요청 ID는 유지하고 state만 null이다. 프로젝트가 사라졌으면 클라이언트가 본사 `hq` 또는 남아 있는 첫 프로젝트를 명시적으로 선택하여 다시 요청한다. 빈 목록이면 선택 없음 상태로 남는다. 이 규칙으로 ‘서버에 sync 라우트가 없음’의 404와 프로젝트 부재를 구분한다.

### 2. 순번·wire 모양

`shared/types.ts`에는 기존 `WsEvent`, Bootstrap, ProjectState를 교체하지 않고 다음 별도 타입을 추가한다. 아래는 제안 계약이며 이번 작업에서 구현한 export가 아니다.

```ts
type WsChangeEvent = Exclude<WsEvent, { type: "hello" } | { type: "ping" }>;
type RealtimeEvent =
  | { type: "hello"; protocol: 2; epoch: string; seq: number;
      heartbeatMs: 15000; staleAfterMs: 45000 }
  | { type: "ping"; epoch: string; seq: number }
  | (WsChangeEvent & SyncCursor);
```

예: `{type:"member_removed",projectId:"p_123",memberId:"m_1",epoch:"<uuid>",seq:43}`. domain payload는 기존 `WsEvent` 그대로여서 `herdr` 이벤트도 유지한다. 모든 프로젝트/활동 이벤트를 같은 연결로 받는다. 서버에서 프로젝트별 필터링하지 않으며, 클라이언트는 화면에 무관한 이벤트도 순번 검사를 먼저 한다.

- `Bus` 인스턴스 생성 때 무작위 UUID epoch 하나를 만들고, 기존 emit의 증가 직후 해당 이벤트의 `{epoch,seq}`를 고정한다. HTTP listener에는 두 번째 인자로 cursor를 전달한다. 기존 `(event) => ...` listener는 계속 유효하다. 기존 원본 이벤트 객체에는 필드를 덧붙이거나 변경하지 않는다.
- listener 안에서 다른 emit이 발생해도 바깥 이벤트에 안쪽 이벤트의 현재 bus.seq를 붙이지 않게 **emit 시점의 cursor**를 캡처한다. 중첩 발행으로 전달 순서가 뒤집히면 클라이언트의 gap 규칙이 재동기화한다. 순서 검사를 위해 raw 이벤트를 DB 쓰기 성공으로 해석하지 않는다.
- v1 topic `events`를 유지하고 v2 topic `events-v2`를 추가한다. upgrade data에 protocol을 저장하고 open에서 해당 topic을 구독한 후 hello를 보낸다. 각 listen 서버에 같은 cursor를 사용하여 발행한다. `Server<undefined>` 관련 handler 타입은 `Server<SocketData>`로 일관되게 바꾼다.
- hello와 ping은 seq를 증가시키지 않는다. ping의 seq는 발송 시점의 Bus high-water다. domain seq는 1씩 증가하는 안전한 비음수 정수다. 안전 정수 상한에 닿기 전 epoch를 회전하고 기존 v2 연결을 닫아 전체 재동기화한다. cursor를 날짜·DB migration 번호로 대체하지 않는다.
- v2 수신 시 같은 epoch의 `seq == receivedSeq + 1`은 정상, `seq <= receivedSeq`는 중복/지연으로 무시, `seq > receivedSeq + 1`은 누락으로 전체 재동기화한다. ping이 receivedSeq보다 앞서면 마지막 이벤트 누락도 알아챈다. 다른 epoch, 같은 연결의 순번 역행 heartbeat, 잘못된 cursor는 소켓을 교체하고 전체 조회한다.
- 재접속은 순번이 같아도 항상 전체 조회한다. replay/ack/subscribe 메시지 및 `since` 파라미터는 제공하지 않는다. WebSocket은 변경 알림이며 REST 스냅샷이 최종 상태다.
- snapshot 적용 시 같은 epoch의 수신 기준은 `max(receivedSeq, snapshot.seq)`로 올린다. 이미 REST에 포함됐지만 소켓 큐에 남은 낮은 seq는 중복으로 버린다. 다른 epoch의 수를 서로 비교하지 않는다. snapshot보다 앞서 수신한 관련 변경의 최고 seq도 별도로 유지하여 후속 조회 필요성을 잃지 않는다.
- JSON heartbeat 15초/유효 메시지 없는 45초를 두 클라이언트에 공통 적용한다. 유효한 알려진 프레임만 생존 시각을 갱신한다. 알 수 없는 domain type이라도 유효한 cursor가 있으면 순번을 진행하고 전체 상태를 한 번 재조회한다. 파싱 실패·필수 필드 오류는 연결을 버린다. RFC ping/pong과 JSON ping은 다른 신호다.

### 3. 스냅샷 경계와 비용

`/api/bootstrap`을 그대로 조합하면 `await runtimeInfo/herdrInfo` 전후의 데이터가 섞인다. 새 `/api/sync`는 다음 경계를 지킨다.

1. HTTP 계층에 herdr 진단 캐시 하나를 두고 첫 요청에서만 `orch.herdrInfo()`를 single-flight로 읽는다. 이후 기존 Bus의 `herdr` 이벤트로 교체한다. 초기 조회 중 이벤트가 왔다면 더 새 이벤트를 캐시의 우선 값으로 삼는다. 실패를 정상 상태로 꾸미지 않고 실제 반환된 warning/오류 경로를 보존한다.
2. 모든 필요한 await는 스냅샷 작성 전에 끝낸다. 그 뒤 settings, projectSummaries, rankOverrides, 선택 프로젝트 상태, home/urls/cli와 cursor를 **한 이벤트루프의 동기 구간**에서 구성하고 JSON으로 직렬화한다. 조회와 cursor 캡처 사이에는 await·새 Bus.emit을 넣지 않는다. 운영상 도메인 DB 쓰기는 이 데몬의 Store로만 이뤄진다는 전제를 명시한다. 외부 프로세스의 DB 직접 수정은 지원하지 않는다.
3. `runtime`은 새 스냅샷에서 의도적으로 제외한다. 클라이언트는 이전 runtime 값을 유지하고, 최초 연결·epoch 변경·설정 저장 뒤 및 진단 화면의 명시적 새로 고침에서 `/api/runtime`을 한 번 요청한다. 진단 실패가 도메인 동기화를 막지 않으며 401만 공통 인증 종료 경로로 보낸다. 실행기 준비 여부를 근거 없이 정상 처리하지 않는다.
4. 새 `/api/sync`는 `orch.refreshConnection()`이나 바이너리 `--version`을 이벤트마다 호출하지 않는다. 기존 데몬 health timer와 Store의 연결 이벤트를 이용한다. `/api/bootstrap`의 기존 진단/갱신 의미는 바꾸지 않는다.
5. 응답은 `Cache-Control: no-store`다. sync GET은 프로젝트 생성, 전달 큐 pump, CLI 입력 등 새 쓰기 동작을 추가하지 않는다. 삭제·보관 후 선택 복구도 클라이언트 조회에만 해당한다.

연결 순서는 **소켓 hello 수신 → 수신 루프 유지 → `/api/sync` → cursor 이후 변경 처리**다. 스냅샷 `(E,S)`가 이미 포함한 `seq <= S` 이벤트를 다시 적용하지 않는다. 요청을 내기 전 서버를 보던 오래된 상태로 현재 상태를 되돌리지 않는다.

### 4. 웹 전용 쿠키 인증

브라우저 WebSocket은 임의 Authorization 헤더를 넣을 수 없으므로 현재 `?t=접속코드`를 제거한다. `/files` 쿠키를 `/ws` 인증에 재사용하지 않는다.

- 새 쿠키는 `iamceo_ws_<외부 origin의 유효 포트>`이며 host-only, `Path=/ws`, `HttpOnly`, `SameSite=Strict`, `Max-Age=600`. HTTPS 외부 Origin이면 `Secure`를 붙인다. Tailscale Serve 내부 요청이 HTTP여도 브라우저가 보낸 검증된 HTTPS Origin을 기준으로 한다. HTTP loopback/기존 tailnet HTTP는 non-Secure 쿠키를 사용한다. `Domain`은 쓰지 않는다.
- 값은 `base64url(JSON({v:1,exp:<unix-seconds>,origin:<정규화한-origin>})) + "." + HMAC-SHA256`이다. HMAC 입력에 `iamceo-ws-session:` 용도 접두어와 payload를 포함하고 key는 accessCode다. raw accessCode를 쿠키/응답 본문에 넣지 않는다. 만료는 서버에서 검사하고 서명은 상수 시간으로 대조한다. 만료 시각이 현재보다 600초를 넘는 값·잘못된 필드·복수의 같은 이름 쿠키는 거절한다.
- POST/DELETE와 쿠키만으로 하는 WS handshake에는 HTTP(S) Origin이 반드시 있어야 한다. 기존 Origin/Host 일치 검사를 거치고 서명된 origin과도 일치해야 한다. 리버스 프록시의 임의 X-Forwarded-*를 신뢰하여 범위를 넓히지 않는다. 여러 포트는 이름과 origin 서명으로 분리한다.
- Bearer가 존재하면 그것으로만 판정하고 틀린 헤더를 쿠키로 구제하지 않는다. v2에서 헤더가 없을 때만 전용 쿠키를 사용한다. v1의 기존 헤더/쿼리 의미는 유지한다. 쿠키는 `/api`, `/files`, `/agent`의 인증 수단이 아니다.
- 새 웹은 매 연결 시도 전에 POST로 쿠키를 발급/갱신하고 `/ws?v=2`를 연다. 열린 소켓은 10분마다 끊지 않는다. 쿠키는 handshake 인증 수단이며 재접속 때 새로 발급한다. 로그아웃 시 소켓부터 닫고 DELETE한다. 이미 탈취된 쿠키의 개별 강제 폐기는 이번 범위가 아니며 TTL까지 유효하다. 접속 코드 변경/데몬 재시작은 기존 소켓도 종료하는 현행 운용을 유지한다.
- 에러 로그는 WS 요청의 pathname과 오류 종류만 기록하고 query, Authorization, Cookie, 접속 코드, 전체 URLRequest를 남기지 않는다. 현재 최상위 catch의 `req.url` 출력도 WS 경로에 대해서는 query를 제거한다. 새 웹/네이티브에서 URL query로 인증하는 fallback을 만들지 않는다.

브라우저 cookie 전송과 Bun pub/sub·backpressure는 [Bun WebSockets 문서](https://bun.sh/docs/runtime/http/websockets)의 계약을 따른다. subscriber별 큐를 무제한으로 쌓지 않도록 `backpressureLimit: 16 * 1024 * 1024`, `closeOnBackpressureLimit: true`를 설정한다. 발행 반환값만으로 특정 클라이언트의 동기화 성공을 판정하지 않는다.

### 5. DB·마이그레이션·하위 호환

- **DB 마이그레이션 없음.** `change_seq` 열/테이블을 새로 만들지 않고 `server/db.ts`와 `server/store.ts`를 고치지 않는다. 순번은 영속 replay 포인터가 아니라 같은 epoch 안의 알림 누락 감지 수단이다. 프로세스 재시작은 새 epoch와 전체 snapshot으로 해결한다.
- 서버는 v1/v2를 동시에 지원한다. 구형 웹의 `/ws?t=`는 이 작업에서 제거하지 않는다. 새 클라이언트의 URL 인증만 즉시 없애고 레거시 제거는 별도 버전 정책으로 남긴다. 구형 앱의 3초 REST 조회도 계속 동작한다.
- 새 네이티브가 v1 hello를 받으면 헤더 인증 `/ws`를 계속 사용하고 이벤트를 조회 무효화 신호로 처리한다. 순번을 보장한다고 표시하지 않으며 접속/전경 복귀 때 전체 조회한다. `/api/sync` 404에서만 기존 bootstrap/state 조합으로 내려간다. v1에서도 변경 이벤트가 오면 조회하므로 상시 3초 폴링으로 되돌리지 않는다.
- 새 웹이 `/api/ws-session` 404를 받으면 구형 서버로 판단하여 Bearer REST 대체 조회로 동작하고 **“서버를 업데이트하면 실시간 연결을 사용할 수 있습니다”**를 표시한다. 코드가 담긴 옛 wsUrl은 다시 쓰지 않는다. 다음 명시적 재연결/전경 복귀 때 capability를 다시 확인한다. 다른 HTTP 오류는 구형 서버 판정 근거가 아니다.
- `/api/sync` 없는 서버에서의 조합 조회는 요청 시작의 로컬 이벤트 revision을 기록하고, 완료 사이 관련 이벤트가 오면 후속 조회를 한 번 예약한다. 중간 이벤트 payload를 오래된 응답 위에 무조건 replay하지 않는다. 늦은 응답은 세대로 차단하고 같은 프로젝트의 최신 성공 조회만 게시한다. v1에서는 전역 누락 검출을 보장할 수 없다는 한계를 UI/문서에 남긴다.

## 웹 변경

1. `lib/api.ts`에 ws-session 생성/삭제, `/api/sync`, 코드 없는 `wsUrl()`을 추가한다. 기존 파일 인증과 REST 요청 타임아웃을 보존한다. 서버/쿠키 실패를 인증 실패·접근 거절·일시 장애·구형 서버로 구분한다.
2. `lib/realtime.ts`에 cursor 판정·백오프·단일 연결/재조회 일정 관리를 추출한다. `lib/store.ts`는 실제 도메인 reducer와 라우팅을 유지한다. 네트워크 이벤트와 `applyLocal()`의 REST 결과는 분리한다. REST 결과에 가짜 seq를 붙이지 않는다.
3. v2 hello부터 연결별 receivedSeq를 추적한다. 정상 domain 이벤트는 기존 reducer로 즉시 적용한다. 재동기화 동안은 bounded buffer(최대 1,000건 또는 JSON UTF-8 8MiB)를 유지하고 snapshot `(E,S)` 뒤의 이벤트만 순서대로 재적용한다. 넘치면 buffer를 버리고 소켓 세대를 교체하여 새 snapshot을 받는다. `work`/`projects`처럼 updatedAt이 없는 payload를 옛 값으로 되돌리는 문제를 특히 시험한다.
4. snapshot 응답보다 최신 이벤트를 이미 화면에 적용한 경우에도 snapshot을 기준으로 다시 조립하고 `seq > S`만 replay한다. 메시지의 기존 `mergeMessages/hasMessageGap`, 작성 중·실패 메시지, 더 오래된 메시지 페이지를 보존한다. 오래된 처리 결재·열린 개별 결재도 기존 상세 로딩 정책을 유지한다. activity는 snapshot에 없으므로 현재 열린 member의 활동은 별도 ID 기반 dedupe를 유지하고 재접속 때 그 member만 REST로 다시 읽는다.
5. 정상 v2 연결에서 bootstrap/state 정기 조회는 없다. 소켓 단절/수신 정지/재동기화 실패 동안에만 REST fallback을 쓴다. REST가 정상인 상태의 반복 조회는 3초, 실패하면 아래 공통 백오프를 사용한다. 소켓 open만으로 fallback을 끄지 않고 hello와 snapshot 정합성 확인 후 전환한다.
6. 문서가 hidden이면 소켓/조회/백오프 타이머를 중지하고 visible 시 즉시 새 연결과 전체 조회를 시작한다. `online`은 즉시 한 번 재시도하는 신호일 뿐 인증/서버 도달 성공으로 간주하지 않는다. 중복 visible/online 이벤트는 하나로 합친다. 브라우저에 맞춰 UI 문구/상태를 `components/Shell.tsx`에서 반영한다.
7. `connection`은 REST 도달 상태로, 별도 `realtimeStatus`는 connecting/syncing/live/fallback/paused/authRequired로 관리한다. WS만 막혀도 서버 쓰기까지 일괄 비활성화하지 않는다. 반대로 cached 화면이나 stale socket만 보고 온라인으로 바꾸지 않는다.

## 네이티브 변경

### Mac·iOS 공용 전송과 소유권

- 새 `Services/RealtimeClient.swift`는 actor로 한 서버당 한 `URLSessionWebSocketTask`와 receive task를 소유한다. 재접속/생명주기 정책은 AppStore의 단일 coordinator가 소유하고 RealtimeClient와 pollTask가 각각 재시도 루프를 돌지 않게 한다. `@MainActor AppStore`만 observable 화면 상태를 변경한다.
- `APIClient`가 검증된 endpoint로부터 `/ws?v=2` URLRequest를 만든다. `http→ws`, `https→wss`로 scheme만 바꾸고 host/명시 포트는 그대로 둔다. origin 비교는 변환 전 HTTP origin 기준이다. 외부에서 임의 WS URL을 주입하는 공개 메서드는 만들지 않는다. `Authorization: Bearer <trimmed-code>`를 헤더로만 설정한다.
- 소켓은 REST와 별도의 ephemeral URLSession을 사용하여 REST의 resource timeout 160초 때문에 장시간 연결이 주기적으로 끊기지 않게 한다. cookie storage는 nil, URL credential storage는 nil로 두고 redirect delegate는 WS handshake의 모든 redirect도 거절한다. TLS 인증서의 기본 검증을 우회하지 않는다. handshake/hello 제한 10초, receive 최대 메시지 16MiB, 무응답 제한은 별도 monotonic clock 45초로 적용한다.
- `resume()` 또는 delegate open만으로 동기화 완료 처리하지 않는다. hello 후 receive를 계속 await하는 루프를 유지하고, 별도 단일 snapshot task를 시작한다. 한 `receive()`는 한 메시지이므로 루프가 필요하다. 취소 시 task cancel과 `webSocketTask.cancel(with:.goingAway,reason:nil)`을 함께 수행하고 로그아웃에서는 전용 session도 invalidate한다. 동일 클라이언트의 종료된 세션은 재사용하지 않는다.
- 테스트를 위해 `RealtimeTransport: Sendable`와 transport factory, clock/sleeper/jitter 공급자를 주입한다. URLProtocol만으로 WS upgrade가 검증된다고 가정하지 않는다. 실제 URLSession WS 계약은 격리 서버 integration으로 따로 검증한다.

[Apple URLSessionWebSocketTask 문서](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask)는 URLRequest로 생성하는 소켓, async receive, redirect delegate 및 최대 메시지 크기를 제공한다. 이 설계의 10초·45초·16MiB는 제품 정책이며 API 기본값으로 가정하지 않는다.

### AppStore의 조회와 순번

- `connectionStatus`/`canWrite`의 기존 서버 도달 의미를 유지하면서 `realtimeStatus`, `lastHeartbeatAt`, `lastSyncAttemptAt`, `lastSuccessfulSyncAt`, `(epoch, receivedSeq)`, `appliedSnapshotCursor`, `dirtyRevision`을 분리한다. `lastUpdated`는 데이터 snapshot 적용 시각으로 유지한다. 아무 변경 없는 heartbeat가 이를 갱신하지 않는다.
- 최초 접속·전경 복귀·서버 단절 복구 중에는 별도 `isRevalidating`으로 쓰기를 잠그고 현재 foreground 세대의 성공 snapshot 뒤 해제한다. `canWrite`는 기존 connected/비샘플 조건에 이 검증 조건을 더한다. 정상 live 상태에서 매 변경을 반영하는 짧은 조회마다 입력을 잠그지는 않는다. WS만 실패한 fallback에서는 최신 REST 조회가 성공했다면 쓰기를 허용한다.
- 모든 관련 동작은 connection generation + socket generation + project generation + snapshot request ID를 캡처한다. endpoint/접속 코드 변경·로그아웃은 전부 무효화하고, 프로젝트 전환은 프로젝트 요청/활동만 무효화한다. 프로젝트를 바꿀 때 호스트 소켓을 새로 만들지 않는다. APIClient를 먼저 확보해도 foreground가 아니면 소켓을 열지 않는다.
- 네이티브는 전체 domain reducer를 새로 복제하지 않는다. 기존 domain 이벤트를 최소 범위만 decode하고 관련 변경에 `/api/sync`를 요청한다. 서버 snapshot을 원자적으로 교체하여 결재 건수·프로젝트 요약·삭제를 함께 맞춘다. 이벤트에서 새 runtime/model 값을 추측하지 않는다.
- 관련 이벤트 최초 수신 후 250ms에 조회한다. 이 지연은 trailing debounce가 아니므로 연속 이벤트가 타이머를 계속 뒤로 밀지 않는다. 최대 초당 2회, 동시에 snapshot 요청 1개다. 요청 중에는 최고 relevant seq와 dirty flag만 저장하고 전체 payload를 쌓지 않는다. 완료 후 새 변경이 남으면 다음 허용 시각에 한 번 더 읽는다.
- `(E,S)` 응답은 해당 endpoint/프로젝트/요청 세대와 현재 연결 epoch가 맞고 기존 적용 snapshot보다 뒤처지지 않을 때만 적용한다. 같은 E에서 `highestRelevantSeq > S`이면 최신 상태가 덜 반영됐음을 표시하고 후속 조회한다. 새 데이터는 게시할 수 있지만 모든 변경 반영 완료로 표시하지 않는다. 반복 이벤트 중에도 snapshot을 계속 취소하지 않아 수렴/화면 갱신이 굶지 않게 한다.
- gap이 발견되면 domain 적용을 멈추고 한 번 전체 조회한다. 동일 연결이 계속 정상 수신 중이면 그 snapshot으로 cursor 기준을 다시 설정할 수 있다. epoch 불일치/프레임 오류/45초 무응답은 소켓부터 교체한다. 서버 재시작 전 REST 응답이 새 epoch 소켓 뒤늦게 도착하면 버린다.
- 최초 연결의 REST 확인은 임시 초기 snapshot일 수 있다. 소켓 hello 뒤 다시 취득한 snapshot으로 구독 경계를 확정한다. 프로젝트 선택과 refresh는 이 같은 coordinator를 통하고 기존 `isLoading` guard 때문에 변경 알림이 유실되지 않게 pending dirty를 남긴다.
- `perform/mutate` 성공 후 현재의 `refresh()` 호출과 409 후 조회도 같은 single-flight coordinator로 합친다. 서버 쓰기 성공을 소켓 지연 때문에 실패로 바꾸지 않는다. 401은 원래 인증 종료를 실행한다. 재연결은 `sendRetries`, expectedVersion, 터미널 입력을 재생하지 않는다.

이벤트별 조회 범위:

| 이벤트 | 동작 |
| --- | --- |
| `projects`, `settings`, `herdr` | bootstrap 포함 sync 한 번. 다른 기기의 보관/설정 변경을 반영한다. |
| `project`, `member`, `member_removed`, `decision`, `todo`, `work`, `message`, `file` | 선택 프로젝트 관련이면 sync. 다른 프로젝트는 순번만 진행하며 기존 projects 요약 이벤트로 목록을 갱신한다. |
| `activity` | 순번은 항상 진행한다. 현재 열린 활동 member에 대해서만 활동 조회 revision을 증가시키고 250ms/단일 요청으로 `/api/members/:id/activity?limit=100`을 갱신한다. 닫힌 패널이나 activity만으로 전체 state를 다시 읽지 않는다. |
| hello, ping | 연결/cursor 검증만. 정상 ping마다 snapshot을 조회하지 않는다. |
| 알 수 없는 type + 유효 cursor | 전체 sync를 합쳐 한 번 예약한다. |

`Views/TeamView.swift`의 활동 패널은 member별 revision과 재동기화 완료 revision을 관찰한다. 멤버 변경·닫기 때 요청을 취소하고 늦은 결과를 무시한다. 활동 페이지 이력은 별도 REST 결과이며 domain snapshot cursor에 포함된 것처럼 표시하지 않는다.

### 재접속·대체 조회 공통 정책

| 조건 | 정책 |
| --- | --- |
| WS 실패, REST 성공 | foreground에서 3초마다 대체 조회. WS 재접속은 별도 일정으로 계속 시도하되 공통 coordinator가 중복 REST를 합친다. |
| REST/호스트도 실패 | 실패 후 조회 간격 3→6→12→24→30초, 각 간격에 0.8~1.2 jitter. 실제 네트워크 단절이면 NWPathMonitor의 경로 복귀를 기다리며 주기 요청을 쉬어도 된다. 경로 satisfied는 성공 증거가 아니다. |
| WS 재접속 | 실패 n회 후 `min(30s, 0.5s * 2^n)`에 0.8~1.2 jitter, 최종 30초 상한. handshake/hello 제한 10초. 정상 hello+snapshot 뒤 30초 안정 연결을 유지해야 n=0으로 초기화한다. open/즉시 close 반복이 0.5초 루프가 되지 않는다. |
| 전경·네트워크 복귀·사용자 재연결 | 백오프를 우회하여 즉시 한 번 연결/조회. 연속 신호는 합치며 이전 실패 task callback은 socket generation으로 폐기한다. |
| 소켓 건강하지만 snapshot 조회 실패 | 동기화 오류를 숨기지 않고 WS를 닫아 fallback 상태로 전환한다. ‘live 상태에서 상시 실패 폴링’이라는 이중 상태를 만들지 않는다. |
| WS 인증/upgrade 오류 | delegate에서 확인 가능한 상태와 함께 Bearer REST 한 번으로 원인을 판정한다. 확인된 401에서만 Keychain 삭제·자동 재시도 종료. URLSession의 일반 badServerResponse만으로 코드 오류라고 단정하지 않는다. |
| 403·잘못된 endpoint·TLS 영구 오류 | 설정 확인 상태로 두고 자동 고속 재시도를 멈춘다. 수동 재연결/endpoint 수정으로 재개한다. TLS 검증을 끄거나 HTTP로 자동 강등하지 않는다. |
| 복구 | hello와 snapshot이 일치한 뒤 fallback 타이머를 먼저 취소하고 live로 전환한다. 정상 5분 동안 정기 sync GET이 0개인지 시험한다. |

실패 간격과 WS 재시도는 서로 독립적인 deadline이지만 실제 요청/상태 변경 소유자는 하나다. REST 성공으로 WS 백오프를 매번 초기화하지 않는다. 앱 시작부터 연결을 한 번도 못 했을 때에는 마지막 실제 데이터를 꾸미지 않고 기존 연결 화면/재시도 UI를 사용한다.

### 생명주기·잠금·배터리·Tailscale

- App 수준 aggregate `scenePhase`를 유지하고 `.onChange(..., initial: true)`로 최초 phase도 전달한다. `.active`만 실행하며 `.inactive/.background`에서는 소켓·receive·watchdog·재접속·fallback·미완료 읽기를 취소한다. 다중 창 중 하나라도 active이면 단일 연결을 유지한다. 잠깐의 Control Center/권한 팝업으로 inactive가 되어도 같은 정지/재개 규칙을 적용한다. [Apple ScenePhase 문서](https://developer.apple.com/documentation/swiftui/scenephase)의 App 집계 의미를 따른다.
- iOS 화면 잠금은 scene 비활성 전환으로 처리한다. protected data unavailable 알림도 보조 정지 신호로 사용하되 최초 잠금 해제 전에도 Keychain이 읽힌다고 가정하지 않는다. 잠금 해제 후에는 foreground 여부를 다시 확인한다. BGTask·오디오/위치 background mode·keepalive 우회는 추가하지 않는다.
- macOS는 App aggregate 외에 system sleep/wake를 관찰한다. sleep에서 정지하고 wake 뒤 active일 때만 새 연결한다. 다른 앱으로 전환되어 모든 창이 inactive이면 동기화를 쉬는 현재 정책을 유지한다. 앱 비활성화가 데몬/CLI 중단으로 이어지지 않는다.
- foreground 복귀는 기존 소켓이 OPEN처럼 보여도 새 세대로 연결하고 전체 sync를 한다. 조작권 lease는 disconnect/생명주기와 별개다. 배경 전환으로 자동 release하거나 자동 갱신하지 않고 서버 만료와 기존 명시적 release 규칙을 유지한다. 재조회 때 만료 표시를 갱신하며 입력을 재전송하지 않는다.
- 클라이언트 주기 sendPing은 추가하지 않는다. 기존 서버 JSON heartbeat를 사용하고 45초 deadline watchdog 하나만 둔다. 저전력 모드에서 대체 조회 성공 간격은 10초, 이벤트 묶음은 500ms·최대 초당 1회로 완화하고 UI에서 **“절전 중 · 변경 확인 간격을 늘렸습니다”**를 설명한다. 저전력 정책은 테스트 가능한 환경 값으로 주입한다.
- 여기서 중단하는 주기 폴링은 bootstrap/project 상태 조회다. 열린 `TerminalView`의 2초 screen 조회는 별도 스트리밍 계약이 없으므로 현행 active-only 동작을 유지한다. 소켓 heartbeat나 project 이벤트를 터미널 화면 변경 신호로 대용하지 않는다.
- Tailscale Serve HTTPS endpoint는 같은 origin의 WSS로만 변환하며 프록시 경유/DERP 지연·Wi-Fi↔셀룰러 전환에도 같은 재접속 규칙을 쓴다. iPhone `127.0.0.1`을 호스트 Mac으로 해석하지 않는다. MagicDNS/IP/포트 정규화는 기존 ServerEndpoint와 endpoint별 Keychain 범위를 유지한다.
- 기존 코드가 허용한 tailnet HTTP→WS도 하위 호환으로 유지한다. raw 100.x HTTP의 iOS ATS 허용 여부는 `ServerEndpoint` 검증 성공과 별개이므로 WSS를 권장하고, 실패 시 명확한 주소 안내를 한다. ATS 전역 예외를 넓히지 않는다. `.ts.net` HTTP 호환 예외는 이 작업에서 삭제하지 않는다.
- [Tailscale Serve 문서](https://tailscale.com/docs/features/tailscale-serve)의 tailnet 서비스 노출을 전제로 한다. 실제 Serve 버전에서 Upgrade 전달·장시간 무응답·TLS/Host 처리는 격리 QA로 검증할 항목이다. 이 설계서 작성 중 실제 tailnet이나 라이브 포트에 접속하지 않았다.

## 시험

이번 산출물은 문서이므로 시험·컴파일을 실행하지 않았다. 아래는 구현 담당자가 추가하고 실행할 수용 시험이다. 기존 시험 통과 수를 이번 변경의 검증 결과로 인용하지 않는다.

### 격리 원칙

- 모든 integration fixture는 `mkdtempSync(join(tmpdir(), "iamceo-realtime-"))`로 홈을 만들고 config 읽기/쓰기에 `{IAMCEO_HOME: home, IAMCEO_PORT:"0"}`를 명시한다. `startServer`는 hosts `127.0.0.1`, port 0, `detectHosts: () => []`, fake orchestrator/runner로 시작하고 반환 port만 사용한다.
- child가 필요한 시나리오는 IAMCEO_TEST=1 및 임시 core/herdr socket·HC_SESSION/XDG 디렉토리를 명시하고 기존 `core-browser-harness.ts`의 가짜 core를 사용한다. 실제 CLI/paid model/launchd/사용자 CLI 설정은 사용하지 않는다. 새 HTTP 시험은 가능한 한 fake orchestrator로 소켓 자체를 열 필요도 없게 한다.
- `~/.iamceo`, 그 config, 라이브 7878, 실제 herdr 소켓에 접근하지 않는다. Swift REST mock fixture의 URL도 임의 비라이브 포트로 바꾸고 WS fake factory를 주입하여 URLProtocol을 빠져나간 실제 접속 가능성을 없앤다. Swift integration만 port 0 격리 서버 주소를 받는다.
- 종료 시 자신의 소켓/서버/DB/타이머/child와 임시 디렉토리만 정리한다. 원래 HOME·CODEX_HOME을 덮어써 격리한 척하지 않는다. 이 작업의 검증을 위해 라이브 서버를 재시작하지 않는다.

### 서버 (`tests/realtime.test.ts`, `tests/http.test.ts`)

1. v1 쿼리/헤더 인증과 기존 hello/events 모양 유지. v2 Bearer handshake 성공, 잘못된 코드 401, 다른 Origin/Host/IP 403, 코드 query가 든 v2 400, 일반 GET의 upgrade 오류를 구분한다.
2. v1/v2 두 연결과 복수 listen 서버에서 한 Store 변경이 각각 정확한 채널·동일 epoch/seq로 전달된다. 실제 멤버 토큰/접속 코드가 이벤트에 포함되지 않는다. 구독 전후 hello 경계의 변경을 놓치지 않는다.
3. 모든 Bus 변경 이벤트에 정확히 하나의 seq, hello/ping에서 증가 없음. listener 예외가 쓰기 실패로 번지지 않음, listener 중첩 emit의 cursor가 바뀌지 않음. 새 Bus/데몬은 새로운 epoch다.
4. sync 응답 cursor와 state/summary가 같은 동기 경계에 속한다. 초기 herdr await 중 변경, snapshot 직전/직후 변경, 보관/없는 ID/빈 프로젝트 목록, 잘못된 query와 메서드, 기존 API 응답 보존을 확인한다. sync 반복이 runtimeInfo/refreshConnection/CLI spawn을 호출하지 않는지 fake 호출 횟수로 확인한다.
5. ws-session 쿠키 발급/만료/변조/Origin mismatch/포트 구분/목적 분리/삭제, HTTPS 외부 Origin + HTTP 내부 프록시에서 Secure 속성, HTTP loopback 호환. cookie-only API/agent 인증 거부, 틀린 Bearer와 정상 cookie 동시 제공 거부, v1 query 호환, 로그에 비밀 없음.
6. 15초 ping과 gap high-water, 서버 stop 후 timer/listener 종료, slow consumer의 backpressure 종료. 16MiB를 넘는 프레임/클라이언트 buffer 초과에서 무한 메모리 증가 대신 재동기화·fallback으로 이동한다.

### 웹 (`tests/web-realtime.test.ts`, `tests/realtime.browser.ts`)

1. fake clock/transport로 순번 연속·중복·gap·다른 epoch·heartbeat만 앞선 경우·구독 후 snapshot race·오래된 refresh 결과를 검증한다. snapshot seq 이전 work/projects 이벤트가 최신 snapshot을 되돌리지 않아야 한다.
2. 응답을 늦추는 동안 새 메시지/직원 삭제/결재 변경·보관을 주입한다. 메시지 중복 없음, 전체 처리 건수 정확, 메모/초안/기존 메시지 페이지 보존, 최신 프로젝트로 복구를 확인한다.
3. ws-session POST 후 코드 없는 `/ws?v=2`를 연다. 네트워크 기록·로그·주소에 raw code 없음, 로그아웃 중 늦은 cookie/WS 응답 폐기, 401 종료, 403 안내, 구형 endpoint 404에서 Bearer polling만 사용함을 확인한다.
4. stale 45초·0.5~30초 jitter 상한·flapping 안정시간·REST 실패 백오프·hidden 정지·visible/online 즉시 복귀·중복 타이머 없음. 정상 연결에 대체 polling 없음, WS만 막히면 REST 쓰기는 가능함을 검증한다.
5. 실제 격리 Bun 서버 + Playwright에서 두 웹 화면 간 변경, 웹↔네이티브 HTTP/WS fixture 간 변경, 끊김/서버 재시작을 확인한다. 새 브라우저 시험은 기존 fixture의 임시 홈과 가짜 실행기만 사용한다.

### Swift (`RealtimeTests.swift`, `RealtimeNetworkTests.swift` 및 기존 계약 시험)

1. 주입 transport/clock으로 receive 연속 호출·단일 소켓·정지 취소·종료된 callback 폐기·가짜 handshake 제한·45초 watchdog·안정 연결 뒤 backoff 초기화를 검증한다. 큰 프레임·malformed·unknown type도 포함한다.
2. endpoint의 HTTPS→WSS/HTTP→WS, IPv6 bracket/명시 포트, Bearer 헤더, query 비밀 없음, foreign origin·userinfo·redirect 거부. 실 URLSessionWebSocketTask로 port 0 Bun 서버에 붙어 인증/hello/수신/종료를 검증하며 mock 성공을 실제 네트워크 성공으로 보고하지 않는다.
3. 사건 폭주를 250ms로 묶고 동시 snapshot 1개/초당 최대 2개를 확인한다. 요청 중 새 변경은 dirty로 남고 후속 조회한다. 선택 전환·계정 전환·동일 서버 수동 재연결에서 늦은 snapshot이 다른 화면에 적용되지 않는다.
4. seq gap, 중복, 다른 프로젝트 이벤트 사이의 연속 seq, epoch 변경, snapshot 응답보다 늦게 도착한 낮은 seq, archive/not_found를 검증한다. 갱신 시 결재 version 검증·메모·sendRetries의 동일 메시지 ID를 유지한다.
5. REST 정상/WS 단절, 전체 단절, 502~504, 일반 badServerResponse, 확인된 401, 403, TLS 오류를 구분한다. 기존 `ConnectionLossTests`의 ‘마지막 snapshot 유지·read-only·복구’와 터미널 lease 보존 시험을 유지한다.
6. aggregate active/inactive/background, 최초 background 실행, 다중 Mac/iPad 창, iOS 잠금/protected data, Mac sleep/wake를 가짜 lifecycle 이벤트로 검증한다. 배경/샘플/로그아웃에는 socket·fallback·재시도 요청 0개여야 한다. foreground 즉시 재동기화한다.
7. heartbeat만 5분 받은 경우 데이터 GET 0개와 정상 연결 문구, 기존 20초 stale 경고 없음. opened activity member만 갱신, 저전력 간격, REST 진단 호출 횟수도 검증한다.

### 구현 후 확인 명령·수동 QA

- TypeScript: `bun run typecheck`. 새 `tests/realtime.test.ts`, `tests/web-realtime.test.ts` 및 기존 http/web-lib 회귀 시험을 격리 fixture로 실행한다. 관련 계약이 통과한 뒤 프로젝트의 기존 필수 check를 실행하되 paid e2e는 제외한다.
- Swift: `swift test --package-path native`, `swift build --package-path native`. 새 파일은 현재 SwiftPM/XcodeGen의 폴더 기반 source 포함에 들어간다. iOS Simulator 빌드는 `native/README.md`의 xcodebuild 명령과 별도 임시 derivedDataPath를 따른다. 개발자 서명·실기기 완료를 simulator 성공으로 대신 보고하지 않는다.
- 별도 테스트 호스트/테스트 tailnet에서 Mac localhost, Tailscale Serve WSS, iPhone Wi-Fi↔셀룰러, VPN off/on, 1분·10분 잠금, Mac 잠자기/깨우기, 서버만 재시작, 두 클라이언트 동시 결재/프로젝트 보관을 확인한다. 사용자 라이브 호스트에는 연결하지 않는다.
- 수용 기준: 유휴 5분 연결에서 heartbeat 외 정기 상태 GET 0개(사용자 조작/명시 진단 제외), 화면에 관련 변경은 안정 망에서 이벤트 수신 후 통상 1초 안에 조회 시작, WS 단절 시 지정된 fallback·복구, 배경 10분 네트워크 요청 0개. 실제 tailnet 지연에는 고정 1초 완료 보장을 하지 않는다. 배터리/요청 수는 동일 시나리오의 3초 폴링 기준과 비교 기록한다.

## 위험·미정

- **서버 이벤트 누락 전제:** Bus를 거치지 않는 외부 DB 쓰기나 신규 Store 경로는 seq만으로 감지할 수 없다. 현재 제품 변경 경로가 기존 이벤트를 내는지 구현 때 점검해야 한다. 영속 replay/매 트랜잭션 change_seq가 필요해지면 DB·Store 소유자와 별도 설계한다. 이 범위에 숨겨 넣지 않는다.
- **v1의 한계:** 구형 서버는 이벤트별 순번이 없으므로 조용한 누락을 완전히 검출하지 못한다. 새 서버+새 클라이언트가 v2 보장을 제공한다. 구형 웹의 URL 접속 코드 경로는 호환 때문에 잔존하며 제거 시점은 별도 릴리스 결정이다.
- **성능:** 네이티브는 이벤트 기반 snapshot 재조회라 delta reducer보다 응답 바이트가 많다. 활동을 분리하고 single-flight/coalescing으로 제어한다. 큰 프로젝트에서 REST 응답 크기·초당 2회가 과하면 후속 증분 API/선택 필드 최적화가 필요하다. 연속 이벤트 때문에 최종 완료 표시가 늦더라도 데이터 갱신이 굶지 않게 한다.
- **대형 메시지:** native maximumMessageSize를 넘는 단일 기존 payload는 수신 실패·fallback으로 처리한다. 복구할 수 없는 크기가 반복되면 명확히 대체 조회를 유지하며 원인을 표시해야 한다. 임의로 payload를 잘라 성공 처리하지 않는다. 향후 작은 invalidation 전용 v3는 별도 최적화다.
- **진단 최신성:** runtime은 모든 상태 이벤트에 포함되지 않는다. 실제 런타임 가능 여부를 최신이라고 꾸미지 말고 마지막 진단 시각/수동 확인을 유지한다. herdr 캐시도 기존 event 발행 범위를 넘는 정확성을 약속하지 않는다.
- **네트워크/OS:** iOS ATS의 raw tailnet HTTP, Tailscale Serve의 외부 Origin/내부 Host 처리, VPN 경로 복귀, 실기기 suspension과 Keychain 보호는 실제 장치 QA가 필요하다. 이 문서 작성 중 검증하지 않았다. 도메인 검증을 성공했다고 URLSession 전송 성공으로 간주하지 않는다.
- **인증:** 쿠키는 발급 뒤 10분 개별 폐기 기능이 없고 기존 소켓도 handshake 이후 요청마다 재인증하지 않는다. 새로운 기기별 권한/접속 폐기 UI는 범위 밖이다. 쿠키 사용과 별개로 기존 IP/Host/Origin 방어를 약화하지 않는다.
- **공유 작업 충돌:** `shared/types.ts`는 문맥 창 작업자와 실제 편집이 겹친다. 별도 sync 타입 추가 구간만 예약하고 Member/Settings/ContextWindowSource를 덮어쓰지 않는다. `server/store.ts`, `server/db.ts`, `server/runner/herdr.ts`, `server/runner/context.ts`, `tests/context.test.ts`와 `native/Sources/IAMCEO/Design/*.swift`는 읽기 전용 참조이며 이 기능의 예정 수정 파일에서 제외한다. 새 필드가 늘어도 클라이언트가 잘못 축약하여 유실하지 않도록 기존 decoder 정책을 유지한다.
- **미정으로 남기는 제품 범위:** APNs/배경 알림, 실제 배포·서명, 영속 replay, 레거시 v1 제거 일정, 터미널 스트리밍은 각각 다른 작업이다. 위 수치(heartbeat 15초, stale 45초, WS 상한 30초, cookie 600초)는 이번 구현의 기본 결정값이며 실측 없이 임의 변경하지 않는다.

## 소유자 할 일

1. **계약/통합 담당:** `shared/types.ts` 추가를 문맥 창 작업자와 조정하고 v2 wire·sync·인증 계약을 먼저 고정한다. 이 설계서만으로 라이브 기본 실행기를 변경하지 않는다.
2. **서버 담당:** Bus cursor/epoch, v1/v2 topic, sync 스냅샷, ws-session과 테스트를 맡는다. 기존 Store와 실행기에 새 이벤트 형식을 요구하지 않는다. DB 마이그레이션을 추가할 필요가 생기면 해당 소유자와 합의 후 설계를 수정한다.
3. **네이티브 담당:** APIClient/RealtimeClient/AppStore와 lifecycle를 함께 소유하여 중복 task·경쟁을 막는다. AppShell/SettingsView는 연결 문구와 상태 표시만 수정하고 유리 디자인 파일은 건드리지 않는다. TeamView는 활동 갱신 hook만 맡는다. 기존 Swift 시험에 WS fake를 주입한다.
4. **웹 담당:** 쿠키 인증·cursor/buffer·snapshot·fallback과 Shell 문구, 격리 browser 시험을 맡는다. 기존 reducer·초안·페이지 보존 계약을 회귀 확인한다.
5. **검증 담당:** 임시 홈/port 0/fake runner로 자동 시험을 실행하고 실제 URLSession WS·Tailscale WSS·iPhone 잠금·다중 창·절전 결과와 요청 수를 기록한다. 장치/테스트 tailnet이 없으면 해당 결과는 ‘미검증’으로 보고한다.
6. **문서 담당:** 구현 완료 후 `docs/architecture.md`, `docs/spec.md`, `native/README.md`의 폴링·인증·원격 주소 설명을 실제 동작에 맞춘다. 날짜가 고정된 handoff의 과거 구현 상태는 임의로 완료 기록으로 바꾸지 않는다.

병렬 분할은 위 소유권을 기준으로 한다. `shared/types.ts`는 계약 담당 한 명만 편집하고, 기존 문맥 창 변경을 먼저 보존한 뒤 추가한다. 예정 파일 목록은 아래가 전부이며 추가 필요 시 구현 전에 목록과 소유권을 갱신한다.

## 파일 목록

아래는 **향후 구현 때 수정/신규 생성할 파일**이다. 이번 설계 작업에서 실제로 만든 파일은 이 설계서 하나뿐이다. 한 줄에 절대경로 하나이며 기존 디자인/DB/실행기 파일은 포함하지 않는다.

```text
/Users/yesung/iamceo/shared/types.ts
/Users/yesung/iamceo/server/bus.ts
/Users/yesung/iamceo/server/http.ts
/Users/yesung/iamceo/web/src/lib/api.ts
/Users/yesung/iamceo/web/src/lib/realtime.ts
/Users/yesung/iamceo/web/src/lib/store.ts
/Users/yesung/iamceo/web/src/components/Shell.tsx
/Users/yesung/iamceo/native/Sources/IAMCEO/Services/APIClient.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Services/RealtimeClient.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/State/AppStore.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Models/RealtimeModels.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/IAMCEOApp.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/AppShell.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/SettingsView.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/TeamView.swift
/Users/yesung/iamceo/tests/http.test.ts
/Users/yesung/iamceo/tests/realtime.test.ts
/Users/yesung/iamceo/tests/web-realtime.test.ts
/Users/yesung/iamceo/tests/realtime.browser.ts
/Users/yesung/iamceo/native/Tests/IAMCEOTests/ContractTests.swift
/Users/yesung/iamceo/native/Tests/IAMCEOTests/NetworkTests.swift
/Users/yesung/iamceo/native/Tests/IAMCEOTests/ConnectionLossTests.swift
/Users/yesung/iamceo/native/Tests/IAMCEOTests/RealtimeTests.swift
/Users/yesung/iamceo/native/Tests/IAMCEOTests/RealtimeNetworkTests.swift
/Users/yesung/iamceo/docs/architecture.md
/Users/yesung/iamceo/docs/spec.md
/Users/yesung/iamceo/native/README.md
```

`lib/realtime.ts`, `RealtimeClient.swift`, `RealtimeModels.swift` 및 realtime 이름의 새 시험 5개는 신규 파일이다. 기존 Models.swift는 기존 도메인 모양을 유지하고 새 wire 모델을 별도 파일로 분리하므로 편집하지 않는다. `project.yml`/Package.swift는 이미 폴더 전체를 source로 포함하므로 변경하지 않는다. 생성된 Xcode 프로젝트가 필요한 검증은 구현 담당자가 XcodeGen으로 재생성한다.

## 크기

**L.** 단순 소켓 연결 외에 v1 하위 호환, URL 접속 코드 제거를 위한 웹 인증, snapshot/cursor의 경쟁 해소, 두 클라이언트의 fallback/백오프, Swift actor 취소·다중 창·잠금·절전, 격리 네트워크/실기기 QA가 필요하다. DB·실행기 수정과 APNs를 제외해 범위를 제한한다. 계약/서버 → 웹·네이티브 병렬 구현 → 교차 클라이언트/장치 검증 순서로 완료한다. 신규 외부 라이브러리는 없으며 기존 Bun·React와 Apple Foundation/Network/SwiftUI를 사용한다.
