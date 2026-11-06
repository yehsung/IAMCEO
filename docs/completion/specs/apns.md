# iPhone 푸시 알림(APNs) 구현 설계서

작성일: 2026-11-07. **설계 산출물이며 아래 코드는 구현하지 않았다.** 이번 작업에서 만드는 파일은 이 문서 하나다. `docs/claude-handoff.md` 전체, 특히 §7·§8을 읽고 서버·웹·네이티브의 현행 코드를 확인했다. 라이브 7878, 사용자 데이터 폴더, 실제 실행기 소켓에는 접속하지 않았다.

범위는 개인 호스트 데몬이 등록된 iPhone으로 보내는 일반 APNs alert와 알림을 누른 뒤의 탐색이다. core를 목표로 하되 실행기를 선택하거나 전환하는 변경을 포함하지 않는다. 웹 Push, Mac APNs 수신, silent push, 네이티브 WebSocket, 알림에서 바로 승인하는 동작은 별도 범위다.

확인한 코드와 설계의 출발점:

| 현행 근거 | 설계에 반영할 사실 |
|---|---|
| `server/store.ts`: `createDecision`, `reopenDecision`, `createMessage`, `patchMember` | 영속 쓰기 직전에 기존 상태를 알 수 있다. 사건 저장은 이 경계에 붙인다. |
| `server/orchestrator.ts`: `registerAsk` | 결재 하나와 `kind="질문"` 메시지가 같이 생긴다. 두 번 알리면 안 된다. |
| `server/agent-tools.ts`: `ask`, `post`; `orchestrator.ts`: `fallbackReport` | 질문은 ask, 명시적 완료 보고는 post의 `kind="완료"`다. 자동 `답변`·`알림`이나 idle은 완료 근거가 아니다. |
| `server/runner/core.ts`: `observe`, `terminalControl`; `runner/types.ts` | core의 blocked는 승인·로그인·미보고 상태를 포함한다. 구조화된 승인 카드와 동일하지 않다. |
| `server/orchestrator.ts`: `notifyInbox`, `notifyBlocked` | 기존 Mac osascript 알림은 별도다. 여기의 자유 텍스트를 APNs payload로 재사용하지 않는다. |
| `server/bus.ts` | Bus는 메모리 방송이며 재시작 후 재생되지 않는다. Bus 구독만으로 신뢰할 수 있는 발신 큐를 만들지 않는다. |
| `server/db.ts`: `MIGRATIONS`, `openDb` | 순차 마이그레이션과 사전 백업을 유지한다. 현재 마지막 번호를 고정하지 않는다. |
| `native/Sources/IAMCEO/State/AppStore.swift` | 전경 3초 폴링, endpoint별 인증, 연결 세대 검사가 있다. 백그라운드 폴링을 추가하지 않는다. |
| `IAMCEOApp.swift`, `State/Router.swift`, `Views/AppShell.swift` | 상태는 앱 공용, Router는 창별이다. 기존 `iamceo://pair`와 프로젝트 전환 시 선택 초기화를 보존한다. |
| `native/project.yml` | iOS bundle ID는 `com.iamceo.native.ios`, Mac은 `com.iamceo.native.mac`. iOS APNs entitlement와 delegate는 없다. |

## 사용자 동작

### 알림 켜기와 설정

1. iPhone을 기존 연결/짝 맺기 절차로 호스트에 연결한다. 연결만으로 OS 권한 창을 띄우지 않는다.
2. 설정의 **“iPhone 알림”**에서 **“이 iPhone에서 알림 받기”**를 켠다. 사전 설명은 “결재·질문·실행 문제를 알려 드립니다. 알림 내용은 앱에서 확인합니다.”다.
3. `notDetermined`일 때만 명시적인 켜기 동작으로 `.alert`, `.sound` 권한을 요청한다. 이번 범위는 badge를 쓰지 않아 권한도 요청하지 않는다. 거절이면 “알림 권한이 꺼져 있습니다”와 **“iPhone 설정 열기”**를 제공한다. 앱 자체 토글로 시스템 권한이 켜진 것처럼 표시하지 않는다.
4. 허용 후 APNs 등록 → 호스트에 토큰 등록 → 해당 기기 enabled 저장까지 완료되어야 **“이 iPhone에서 알림 받는 중”**을 표시한다. 중간 실패는 “기기 등록을 완료하지 못했습니다 · 다시 시도”다. 서버 키 미설정은 “호스트에 푸시 키 설정이 필요합니다”다. OS 권한과 호스트 등록 상태를 따로 표시한다.
5. 앱이 다시 활성화되면 시스템 권한을 확인한다. 권한 철회는 연결 가능한 즉시 등록에 반영하고 발신을 중단한다. 권한을 되돌렸더라도 명시적으로 꺼 둔 기기 알림을 자동으로 켜지 않는다.
6. 기기별 종류 설정은 즉시 저장하며 “저장 중”/“저장하지 못했습니다”를 보인다. 기존 실행 설정의 저장 버튼과 별도다. Mac·웹에서도 등록된 iPhone의 같은 설정을 관리한다.

| 설정 키 | 한국어 UI | 최초 기본값 | 사건과 알림 본문(제목은 모두 `IAMCEO`) | 누르면 |
|---|---|---|---|---|
| `decision` | 새 결재 | 켬 | 선택지가 있는 새 ask: “새 결재가 도착했습니다.” | 결재 상세 |
| `question` | 답변이 필요한 질문 | 켬 | 선택지가 없는 새 ask: “답변이 필요한 질문이 있습니다.” | 결재 상세 |
| `approval_wait` | 승인·직접 확인 대기 | 켬 | blocked 진입: “진행을 위해 직접 확인이 필요합니다.” | 해당 팀원 상세 |
| `error` | 실행 오류 | 켬 | 오류 상태 진입 또는 새 오류 문제: “실행 문제를 확인해 주세요.” | 해당 팀원 상세 |
| `report_complete` | 완료 보고 | 끔 | 명시적 `post(kind="완료")`: “완료 보고가 도착했습니다.” | 해당 보고가 있는 대화 |

새 기기는 **전체 enabled=false**로 생성하고, 사용자가 켜기를 완료할 때만 true로 바꾼다. 위 종류 기본값은 enabled와 별개다. 기존 설치에는 OS 권한 요청이나 자동 등록이 없다. 한 호스트의 모든 활성 프로젝트에 적용하며 프로젝트별 필터는 이번 범위에 넣지 않는다. 완료 보고를 켜면 총괄·본사 AI·팀장의 명시적 완료 보고 모두 대상이다.

선택지 유무를 질문/결재의 기계적 분류로 사용한다. 제목의 물음표나 모델의 문장을 추측하지 않는다. 한 ask는 정확히 한 종류이며, 재열림도 같은 분류를 유지한다. UI 도움말: “선택지가 있는 요청은 새 결재, 자유 답변 요청은 질문으로 알립니다.”

토글 끄기는 해당 기기의 새 발신과 아직 보내지 않은 큐를 취소한다. **“기기 등록 해지”**는 토큰도 제거한다. “이미 전달된 알림은 iPhone 알림 센터에 남을 수 있습니다.”를 함께 안내한다. iPhone 자신의 해지에서는 해당 서버의 전달된 알림도 로컬에서 지운다.

기존 **“Mac 알림”**(`Settings.notifyMac`)은 유지하며 iPhone 설정과 연동하지 않는다. Mac 사용 중에도 iPhone으로 알린다. iPhone 전경에서는 알림 수신 시 최신 데이터를 다시 조회하되 OS 배너·소리를 표시하지 않는다. 폴링으로 같은 사건의 로컬 알림을 추가 생성하지 않는다.

### 탭·연결 해제·오프라인

- 잠금 화면 알림은 위 고정 문구만 표시한다. 프로젝트/사람 이름·보고 제목도 자유 입력이므로 넣지 않는다. 비밀, 접속 코드, 짝 맺기 코드, 명령, 오류 원문, 경로, 첨부 URL, APNs 토큰은 payload/로그에 싣지 않는다.
- 탭하면 연결된 호스트의 최신 상태를 조회하고 결재·팀원·대화로 이동한다. 승인·답변·터미널 조작권 획득·자동 입력은 수행하지 않는다. 결재 제출은 기존 expectedVersion과 명시적 제출을 그대로 거친다.
- Tailscale이 꺼져도 호스트가 인터넷에 연결되어 있으면 Apple 경유 알림을 받을 수 있다. 탭 후 데이터 조회에는 기존 호스트 연결이 필요하다. 실패 시 **“알림을 열려면 호스트에 연결해 주세요”**, **“Tailscale 연결을 확인하고 다시 시도”**를 표시하고 목적지를 보관한다. VPN을 자동으로 켜거나 공개 서버로 우회하지 않는다.
- 호스트의 인터넷 단절/잠자기 중에는 즉시 발신할 수 없다. 짧은 만료 시간 내 복구되면 아직 유효한 사건만 발신한다. 상태 원본은 서버이며, 푸시는 동기화 성공 또는 전송 보증 표시가 아니다.
- 명시적 연결 해제 시 먼저 해당 기기를 해지한다. 온라인 해지 실패와 오프라인이면 “호스트에 닿지 않아 알림 해지를 완료하지 못했습니다. 다른 연결된 기기의 설정에서 해지할 수 있습니다.”를 표시한다. 사용자 연결 해제 자체를 막지는 않는다. 인증은 기존처럼 제거하며 몰래 별도 자격증명을 보관하지 않는다. 로컬에 해지 미완료 표지(서버 ID·기기 ID만)를 남겨 같은 호스트 재연결 시 enabled를 켜기 전에 해지부터 완료한다. 삭제된 키체인 코드 없이 백그라운드 해지 재시도를 약속하지 않는다.

## 서버 API·DB

### 계약과 경계

새 계약은 `shared/push.ts`에 모아 기존 `shared/types.ts`의 Settings/Bootstrap/WsEvent를 바꾸지 않는다. ISO UTC 문자열과 정수 revision을 사용한다. 다음 타입은 **구현 예정 계약**이다.

```ts
type PushKind = "decision" | "question" | "approval_wait" | "error" | "report_complete";
type PushPreferences = Record<PushKind, boolean>;
type PushEnvironment = "sandbox" | "production";
type PushAuthorization = "authorized" | "provisional" | "ephemeral" | "denied" | "notDetermined";
type PushDeviceState = "active" | "revoked" | "invalid" | "expired";

interface PushDevice {
  id: string;                     // 설치 UUID, 한 서버 안에서 유일
  label: string;                  // 사용자가 정한 이름, 기본 "내 iPhone"
  platform: "ios";
  bundleId: string;
  environment: PushEnvironment;
  enabled: boolean;
  authorization: PushAuthorization;
  preferences: PushPreferences;
  state: PushDeviceState;
  revision: number;
  registeredAt: string;
  lastSeenAt: string;
  expiresAt: string;              // IAMCEO 등록 임대 만료, Apple 토큰 만료가 아님
  lastAcceptedAt: string | null;  // APNs 접수 시각, 실기기 수신 시각이 아님
  lastFailure: "token_invalid" | "provider_error" | "temporary_error" | null;
}

type PushTarget =
  | { screen: "inbox"; projectId: string; decisionId: string }
  | { screen: "team"; projectId: string; memberId: string }
  | { screen: "chat"; projectId: string; memberId: string | null; messageId: string };
```

아래 `/api/push/*` 전부 기존 **사용자 Bearer 접속 코드**와 Host/Origin/IP 검사를 통과해야 한다. 멤버 MCP 토큰·첨부 쿠키·query 인증은 거부한다. 단일 소유자 모델이므로 인증된 다른 클라이언트는 모든 기기를 관리할 수 있다. 설치 UUID는 인증 수단이 아니다. JSON은 strict schema, 본문은 최대 8 KiB(초과 413, Content-Length뿐 아니라 실제 stream 바이트 수로 제한), 토큰·키가 포함된 예외를 기존 HTTP catch로 그대로 던지지 않는다. 응답은 `Cache-Control: no-store`, 오류 모양은 기존 `{ "error": "한국어 문구" }`를 유지한다.

### 라우트

**`GET /api/push/status` → 200**

```json
{
  "serverId": "277551bf-cf60-4ecd-a450-1fd3e695a8d8",
  "supported": true,
  "providers": [
    {"environment":"sandbox","bundleId":"com.iamceo.native.ios","state":"ready","lastError":null},
    {"environment":"production","bundleId":"com.iamceo.native.ios","state":"unconfigured","lastError":null}
  ]
}
```

provider state는 `ready|unconfigured|configuration_error|temporarily_unavailable`, lastError는 `key_unreadable|invalid_key|auth_failed|network_error|null`이다. ready는 로컬 설정·키 파싱 완료이며 수신 성공을 뜻하지 않는다. key ID·team ID·p8 경로·JWT·토큰은 응답하지 않는다. APNs 미설정이어도 기능 API는 존재하고 데몬은 정상 시작한다.

**`GET /api/push/devices` → 200 `{ "devices": PushDevice[] }`**. revoked/invalid/expired도 반환하여 해지 결과를 확인한다. 최대 100개 설치 기록, 최근 lastSeenAt 순. **`GET /api/push/devices/:installationId` → 200 `PushDevice`**, 없는 ID는 404다. 어느 조회에도 원본 deviceToken을 반환하지 않는다.

**`PUT /api/push/devices/:installationId`** — 토큰 등록·교체·임대 갱신. 신규 201, 기존 200, 응답 `PushDevice`.

```json
{
  "expectedRevision": null,
  "platform": "ios",
  "bundleId": "com.iamceo.native.ios",
  "environment": "sandbox",
  "deviceToken": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "authorization": "authorized",
  "label": "내 iPhone"
}
```

- 신규 expectedRevision은 null, 기존은 GET에서 받은 양의 정수다. 서버에서 BEGIN IMMEDIATE 트랜잭션으로 비교하며 불일치는 409 `기기 등록 상태가 바뀌었습니다. 다시 확인해 주세요`다. 없는데 정수를 보내면 404, 존재하는데 null이면 409다.
- ID는 표준 UUID, platform은 ios만, label은 제어문자 없는 1~40자다. bundle ID는 로컬 APNs 설정의 허용 topic과 정확히 일치해야 한다. 미설정 기본 topic은 현행 `com.iamceo.native.ios`다. 임의 topic으로 발송하는 API가 아니다.
- 토큰은 Data를 소문자 hex로 인코딩한다. 입력은 짝수 길이의 hex 2~1024자만 허용하고 소문자로 정규화한다. **64자/32바이트로 고정하지 않는다.** 1024자는 서비스 입력 상한이며 Apple 고정 길이라는 의미가 아니다.
- OS callback에서 받은 현재 토큰만 전송한다. authorization이 허용 계열이 아니면 PUT을 쓰지 않고 PATCH로 비활성화한다. provider 미설정 환경도 등록은 저장하되 enabled를 켜는 PATCH에서 409를 돌려준다.
- 새 행은 enabled=false와 종류 기본값으로 생성한다. 기존 enabled/preferences는 PUT으로 켜거나 초기화하지 않는다. revoked/invalid/expired의 정상 재등록은 active가 되지만 enabled=false다. 이후 **사용자가 켜기**를 해야 한다. 토큰만 바뀐 활성 행은 기존 enabled를 보존한다.
- 등록 때 `registration_generation`과 revision을 증가시키고 registeredAt/lastSeenAt을 서버 현재 시각으로 기록, expiresAt은 30일 후로 갱신한다. 최초 접속·토큰 callback·전경 복귀 시 확인하고, 같은 프로세스의 임대 갱신은 하루 한 번으로 제한한다. APNs 접수 성공은 임대를 연장하지 않는다.
- token/topic/environment UNIQUE 충돌이면 기존 행의 미발신 작업을 취소하고 토큰을 제거·revoked 처리한 뒤 새 설치로 원자적으로 이전한다. 이전 enabled를 상속하지 않는다. 같은 설치의 환경/topic 변경도 기존 토큰 작업을 취소하고 enabled=false로 만든다.
- 같은 설치·환경·topic의 활성 등록 갱신은 queued/retry delivery의 registration_generation을 새 값으로 원자적으로 바꿔 동일 event/delivery ID로 현재 토큰에 보낼 수 있게 한다. sending/accepted/unknown은 되돌리지 않는다. 요청 중인 stream은 시작 시 캡처한 이전 generation으로만 결과를 적용한다. 일일 임대 갱신 때문에 미발신 사건을 소실시키지 않는다.
- 타임아웃 후 같은 PUT을 재시도해 409를 받으면 GET으로 현재 등록 상태/revision을 다시 확인한다. 응답에 원본 토큰이 없으므로 이것만으로 직전 토큰이 저장됐다고 단정하지 않는다. active·수신 의도 유지·호스트 연결 세대 일치가 확인되면 OS가 현재 제공한 토큰으로 등록만 다시 시도할 수 있다(enabled PATCH 재생은 금지). revoked/invalid/expired이면 자동으로 재활성화하지 않고 사용자 켜기를 요구한다. stale 요청을 최신 revision으로 무조건 재전송하지 않는다.

**`PATCH /api/push/devices/:installationId` → 200 `PushDevice`**

```json
{
  "expectedRevision": 3,
  "enabled": true,
  "preferences": {"report_complete": true},
  "label": "업무용 iPhone",
  "authorization": "authorized"
}
```

expectedRevision 필수, 나머지는 하나 이상. preferences는 부분 merge하며 모르는 키/비 boolean/빈 patch를 거부한다. authorization의 진실은 iOS 시스템이며 다른 기기가 이를 위조하지 못한다는 보안 보장은 하지 않는다(현재 공용 소유자 인증의 한계). 허용 권한·active 토큰·환경 provider ready가 없으면 enabled=true는 409다. denied/notDetermined이면 enabled=false를 강제한다. 종류 또는 전체 끄기는 현재 queued/retry 작업도 같은 트랜잭션에서 cancelled로 만든다. 켜기는 과거 사건을 소급 발신하지 않는다. revision 불일치는 409, 없는 설치는 404다.

**`DELETE /api/push/devices/:installationId`**, `If-Match: "<revision>"` 필수 → 200 `{ "ok": true }`. 누락/형식 오류 400, 기존 행의 revision 불일치 409. 해지 시 enabled=false, state=revoked, token=NULL, revision 증가, 미발신 큐 취소. 이미 revoked거나 존재하지 않는 ID는 멱등 200이다. 설치 행은 즉시 삭제하지 않고 90일 tombstone을 유지하여 늦은 PUT을 거부한다. 도착 순서가 바뀐 등록·해지가 이전 토큰을 살려 내면 안 된다.

**`POST /api/push/devices/:installationId/test`**, 요청 `{ "requestId": "UUID" }` → 202 `{ "notificationId": "UUID", "state": "queued" }`. 설정 UI의 **“시험 알림 보내기”**에만 사용한다. 고정 본문 “iPhone 알림 연결을 확인합니다.”, 홈 목적지이며 사용자 입력 본문/URL은 받지 않는다. `source_key=test:<installationId>:<requestId>`로 사건과 해당 기기 delivery 하나를 원자적으로 만든다. 같은 requestId는 90일 보존 기간 안에 동일 notificationId와 최초 queued 응답을 재현하며 재발신하지 않는다(현재 상태 조회라는 뜻이 아님). 멱등 조회를 먼저 처리하고 신규 요청은 한 기기당 분당 1회 초과 시 429다. enabled/권한/토큰/provider 조건 미충족은 409. 시험 알림은 종류 토글을 무시하되 전체 enabled는 지킨다. 202를 “수신 완료”로 표시하지 않는다.

**`GET /api/push/events/:eventId/target` → 200**

```json
{
  "serverId":"277551bf-cf60-4ecd-a450-1fd3e695a8d8",
  "eventId":"32c3c71b-2e9b-4f02-9edc-d23d372d418f",
  "target":{"screen":"inbox","projectId":"p_abc","decisionId":"d_abc"}
}
```

eventId UUID를 검사하고 그 서버 사건의 저장된 target만 반환한다. 임의 URL로 redirect하지 않는다. 없는/보존 만료 사건·삭제/보관 프로젝트는 404, 이미 처리한 결재는 현재 결재 상세로 연다. 시험 사건 target만 `{ "screen":"home" }`이다. report target은 과거 메시지 조회를 위해 **기존 `GET /api/projects/:id/messages`에 선택적 `around=<messageId>`를 추가**한다. around와 before는 함께 못 쓰며 400, limit은 최대 100(기본 41), 응답은 기존 `Message[]` 모양으로 전후 메시지를 시간순 반환한다. 다른 프로젝트 메시지/없는 anchor는 404다. around를 안 보내는 기존 페이지네이션 동작은 유지한다.

### DB 마이그레이션

`server/db.ts`의 마지막 MIGRATIONS 다음에 추가한다. 다른 작업자의 context_window 등 마이그레이션 뒤로 병합하고 기존 항목/번호/백업 절차를 고치지 않는다. 모든 새 시각은 서버 ISO UTC, SQLite boolean은 INTEGER CHECK(0,1), JSON은 검증 후 TEXT로 저장한다.

| 테이블 | 컬럼·키 |
|---|---|
| `push_meta` | `id INTEGER PRIMARY KEY CHECK(id=1)`, `server_id TEXT NOT NULL UNIQUE`, `created_at TEXT NOT NULL`. SQL migration은 테이블만 생성한다. 직후 PushStore 초기화 트랜잭션에서 난수 UUID를 INSERT OR IGNORE하고 저장된 값을 다시 읽는다. 이후 재시작에 유지. |
| `push_devices` | `id TEXT PRIMARY KEY`, `label TEXT NOT NULL`, `platform TEXT NOT NULL CHECK(platform='ios')`, `bundle_id TEXT NOT NULL`, `environment TEXT NOT NULL CHECK(environment IN ('sandbox','production'))`, `token TEXT NULL`, `authorization TEXT NOT NULL`, `enabled INTEGER NOT NULL DEFAULT 0`, `preferences TEXT NOT NULL`, `state TEXT NOT NULL`, `revision INTEGER NOT NULL DEFAULT 1`, `registration_generation INTEGER NOT NULL DEFAULT 1`, `registered_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`, `expires_at TEXT NOT NULL`, `revoked_at TEXT NULL`, `invalidated_at TEXT NULL`, `last_accepted_at TEXT NULL`, `last_failure TEXT NULL`. enum 값은 위 계약으로 CHECK. |
| `push_events` | `id TEXT PRIMARY KEY`(UUID), `source_key TEXT NOT NULL UNIQUE`, `kind TEXT NOT NULL`(PushKind 또는 test), `project_id TEXT NULL`, `member_id TEXT NULL`, `target TEXT NOT NULL`(검증된 JSON), `occurred_at TEXT NOT NULL`, `expires_at TEXT NOT NULL`. 자유 텍스트/토큰/payload 원문을 저장하지 않는다. |
| `push_episodes` | `member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE`, `blocked_generation INTEGER NOT NULL DEFAULT 0`, `error_generation INTEGER NOT NULL DEFAULT 0`, `error_active INTEGER NOT NULL DEFAULT 0`, `error_digest TEXT NULL`. 같은 문제를 updatedAt 변경만으로 새 사건으로 만들지 않기 위한 상태. |
| `push_deliveries` | `id TEXT PRIMARY KEY`(UUID, apns-id), `event_id TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE`, `device_id TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE`, `registration_generation INTEGER NOT NULL`, `state TEXT NOT NULL`, `attempts INTEGER NOT NULL DEFAULT 0`, `next_attempt_at TEXT NOT NULL`, `lease_until TEXT NULL`, `last_status INTEGER NULL`, `last_reason TEXT NULL`(정해진 APNs reason만), `accepted_at TEXT NULL`, `expires_at TEXT NOT NULL`, `finished_at TEXT NULL`, `UNIQUE(event_id,device_id)`. state는 queued/sending/retry/accepted/cancelled/invalid/expired/failed/unknown. |

인덱스: `push_devices(bundle_id,environment,token) UNIQUE WHERE token IS NOT NULL`, `push_devices(state,expires_at)`, `push_deliveries(state,next_attempt_at)`, `push_events(expires_at)`. 이벤트의 project/member ID는 삭제 후에도 고정 식별자를 보존하도록 FK cascade를 걸지 않는다. 발신/target 조회에서 실재·보관 상태를 확인한다.

DB와 WAL에는 원본 기기 토큰이 들어간다. 기존 IAMCEO_HOME 0700, DB/백업 0600을 유지하고 웹 상태/내보내기/일반 로그에 노출하지 않는다. 별도 DB 암호화는 도입하지 않는다. p8은 DB·settings·등록 API에 저장하지 않는다.

30일 무접속은 앱 등록 임대 만료다. 만료 sweep은 state=expired, enabled=false, token=NULL, 미발신 취소로 처리한다. Apple의 Unregistered 시점이나 고정 토큰 수명으로 설명하지 않는다. event/delivery는 사건 occurredAt부터 90일 보존하고, 해지/만료/invalid 설치의 tombstone은 해당 시각부터 90일 후 삭제한다. episode 상태는 멤버 수명 동안 유지한다. `expires_at`은 발신 TTL이고 90일 보존 기산점이 아니다. 청소 전에 TTL 경과 작업을 terminal로 만들고, 설치별 마지막 시험 시각/requestId는 보존된 test event와 delivery로 판정한다. 기기 삭제 cascade는 그 기기의 시험 멱등 기록도 종료한다.

### 사건 생성·트랜잭션·중복 억제

`server/push/events.ts`는 검증된 도메인 객체를 고정 종류/target으로 바꾸고, `server/push/store.ts`가 같은 SQLite 연결에서 사건/수신 기기별 delivery를 기록한다. `Store`에는 선택적 동기 recorder 의존성을 붙여 기존 `new Store(db,bus)` 호출을 유지한다. recorder가 있는 production에서는 아래 도메인 쓰기와 push outbox를 **하나의 동기 SQLite 트랜잭션**으로 묶는다. Bus 방송은 commit 뒤에 한다. 다른 Store 트랜잭션 안에서 호출되는 경우도 최외곽 commit까지 방송/wake를 버퍼링하고 rollback이면 폐기한다. APNs 네트워크 호출은 절대 트랜잭션 안에서 await하지 않는다. recorder 없는 기존 테스트/도구 경로의 동작은 바꾸지 않는다.

| 삽입 지점 | source_key / 조건 |
|---|---|
| `Store.createDecision` | `ask:<decisionId>:<updatedAt>`; options.length>0이면 decision, 아니면 question. 원본 카드 저장과 함께 사건 하나. |
| `Store.reopenDecision` | 위와 같은 키 형식으로 새 updatedAt의 사건 하나. 이미 open인 같은 상태 재적용은 새 사건으로 취급하지 않는다. 기존 도메인 메서드의 의미는 보존하고 알림의 전이만 검사한다. |
| `Store.createMessage` | mine=false, 실제 memberId가 있고 kind가 **정확히 완료**일 때 `report:<messageId>`. 기존 message ID 반환 경로에서는 재삽입하지 않는다. |
| `Store.patchMember` blocked 진입 | before.status!=blocked && after.status==blocked일 때 DB blocked_generation 증가; `blocked:<memberId>:<generation>`. current/next/context 변경이나 매 tick 재확인은 무시. |
| `Store.patchMember` 오류 문제 | after.status==error 또는 비어 있던 lastError가 생기는 경우 error episode 시작. `error:<memberId>:<error_generation>`. |

오류 episode는 status가 error이거나 lastError가 남아 있으면 유지한다. status!=error **그리고** lastError가 비었을 때 종료한다. 원문은 전송하지 않고 비어 있지 않은 lastError의 정규화 SHA-256을 episode 비교용으로만 보관한다. 같은 active 문제에서 동일 digest 재관측은 무시한다. 다른 비어 있지 않은 digest는 generation을 올려 새 오류로 알린다. status error→idle이면서 lastError가 계속 남은 일시 전이는 같은 오류다. 시스템 메시지/활동 로그를 다시 오류 알림으로 분류하지 않는다. lastError가 없는 최초 error에도 한 번 알린다. `gone/offline`만으로 오류를 추측하지 않는다.

기존 멤버를 처음 이주할 때 현재 blocked/error/lastError를 episode baseline으로 채우되 사건은 만들지 않는다. 과거 결재/보고도 backfill하지 않는다. 이후 실질적인 새 상태 전이만 알린다. 서버 재시작은 generation을 초기화하지 않으며, Bus 재방송이나 core 재결합에서 같은 상태가 반복되어도 중복 생성하지 않는다.

`registerAsk`가 뒤이어 만드는 `kind="질문"` 메시지, waiting 변화는 알리지 않는다. 채팅에 별도로 들어온 질문처럼 보이는 자유 텍스트도 추측하여 알리지 않는다. `post(kind="막힘")`은 오류나 승인 창의 증거가 아니므로 이번 다섯 종류로 자동 매핑하지 않는다. core의 blocked는 정확한 승인 메뉴가 아닐 수 있어 위 고정 문구와 팀원 상세를 사용한다. 승인 원문을 얻으려고 화면을 추가 수집하지 않는다.

사건 생성 시점에 enabled·권한·종류·임대가 유효한 기기에만 delivery를 snapshot 삽입한다. 이벤트는 수신 기기가 없어도 보존하지만 나중에 등록한 기기에는 소급하지 않는다. 미설정 환경에는 delivery를 만들지 않는다. 오류가 났다고 도메인 쓰기를 catch 후 성공 처리하여 outbox를 유실하지 않는다. 같은 DB 트랜잭션의 저장 실패는 기존 쓰기도 실패해야 하며, 네트워크 발신 실패는 이미 저장한 도메인 동작에 영향을 주지 않는다.

### APNs HTTP/2 발신과 설정

새 외부 패키지는 필요 없다. Bun 내장 `node:http2`의 `connect`, `node:crypto`의 `createPrivateKey`, `sign`을 사용한다. Bun 공식 자료에 outgoing HTTP/2 client 지원이 명시되어 있다. 이 환경은 **Bun 1.3.14**이며 실제 read-only eval로 `connect/createPrivateKey/sign`이 함수인 것까지 확인했다. 릴리스 workflow도 1.3.14를 사용한다. TLS/ALPN·APNs 실전송은 아직 시험하지 않았다. 최신 문서의 호환성 표를 이 바이너리의 모든 동작 보증으로 해석하지 말고 아래 격리 HTTP/2 계약 시험을 릴리스 조건으로 둔다. [Bun HTTP/2 지원 발표](https://bun.sh/blog/bun-v1.1), [Bun API](https://bun.sh/reference/node/http2), [현행 호환성 표](https://bun.com/docs/runtime/nodejs-compat).

`server/push/config.ts`에서 `$IAMCEO_HOME/apns.json`을 별도로 읽는다. 파일이 없으면 disabled, malformed/읽기 실패는 push configuration_error로만 처리하고 CLI·기존 서버 시작은 유지한다. Config/ConfigFile에 필수 필드를 추가하지 않는다. production 코드에서 APNs host를 외부 요청이나 이 JSON으로 바꿀 수 없게 고정한다.

```json
{
  "sandbox": {
    "keyId": "ABC123DEFG",
    "teamId": "DEF123GHIJ",
    "bundleId": "com.iamceo.native.ios",
    "privateKeyPath": "/ABSOLUTE/PRIVATE/PATH/AuthKey_ABC123DEFG.p8"
  },
  "production": {
    "keyId": "KLM123NOPQ",
    "teamId": "DEF123GHIJ",
    "bundleId": "com.iamceo.native.ios",
    "privateKeyPath": "/ABSOLUTE/PRIVATE/PATH/AuthKey_KLM123NOPQ.p8"
  }
}
```

한 환경만 설정해도 된다. keyId/teamId는 10자리 영문 대문자·숫자, bundleId는 유효한 explicit bundle ID, privateKeyPath는 절대 경로로 검증한다. p8은 PEM PKCS#8의 P-256 개인키인지 시작 때 검증한다. POSIX에서 설정/p8이 일반 파일이며 소유자만 읽을 수 있는지 검사하고, 그룹/다른 사용자 권한이 있으면 해당 provider를 비활성화한다. 원문 대신 오류 코드만 남긴다. owner 계정의 launchd 프로세스가 읽을 수 있는 절대 경로를 사용한다. 파일 변경은 자동 감시하지 않고 명시적 데몬 재시작 때 적용한다. 이번 설계/시험에서 실제 사용자 설정을 열거나 서버를 재시작하지 않는다.

- sandbox: `https://api.sandbox.push.apple.com:443`, production: `https://api.push.apple.com:443`. 토큰 등록 환경에 맞는 자격증명만 사용한다. BadDeviceToken을 이유로 반대 환경에 재전송하지 않는다.
- 환경·team·key fingerprint·topic별 connection/JWT cache를 분리한다. HTTP/2 TLS ALPN h2, 인증서 검증과 SNI를 켜고 장기 연결을 재사용한다. fetch/HTTP1 fallback을 쓰지 않는다. 처음에는 환경별 한 stream씩 보내 복잡한 multiplex 경쟁을 줄인다.
- JWT header는 `{alg:"ES256",kid:keyId}`, claims는 `{iss:teamId,iat:Math.floor(nowMs/1000)}`다. header/claims/signature 모두 unpadded base64url이며 `sign("sha256", signingInput, {key,dsaEncoding:"ieee-p1363"})`로 64-byte JOSE 서명을 만든다(DER 서명 그대로 사용 금지).
- JWT는 메모리에만 두고 **50분에 갱신**, 60분 이상 된 것을 보내지 않는다. 매 요청 재생성하지 않는다. 동시 갱신은 하나로 합치고 최소 20분 간격을 지킨다. 시계가 크게 역행하면 provider를 일시 중단하고 호스트 시각 확인을 안내한다. Apple은 JWT 20~60분 갱신과 환경/키별 연결 제약을 문서화한다. [토큰 인증 공식 문서](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
- `POST /3/device/<hexToken>`, `authorization: bearer <jwt>`, `apns-topic: <bundleId>`, `apns-push-type: alert`, `apns-priority: 10`, `apns-id: <delivery UUID>`, `apns-collapse-id: <event UUID>`를 보낸다. event UUID는 36 ASCII bytes로 collapse-id 상한 64 bytes 안이다. 재시도에 같은 ID를 쓰되 APNs가 exactly-once를 보장한다고 가정하지 않는다. [요청 공식 문서](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).
- `apns-expiration`은 event expiresAt의 Unix **초**다. decision/question은 1시간, approval_wait/error는 15분, report_complete는 1시간, test는 5분. 서버 큐도 같은 TTL이다. 0을 무심코 기본 사용하여 오프라인 재전달을 막지 않는다.
- alert에 sound="default"를 넣는다. badge, content-available, mutable-content, critical/time-sensitive interruption을 추가하지 않는다. UTF-8 직렬화 결과가 **4096 bytes 이하**인지 확인하고 초과는 발신 전 실패 처리한다. 본문 고정 문구이므로 원문 절삭은 필요 없다. [Apple payload 한도](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CreatingtheNotificationPayload.html).

payload 예시:

```json
{
  "aps": {
    "alert": {"title":"IAMCEO","body":"새 결재가 도착했습니다."},
    "sound":"default",
    "thread-id":"iamceo:277551bf-cf60-4ecd-a450-1fd3e695a8d8"
  },
  "iamceo": {
    "v":1,
    "serverId":"277551bf-cf60-4ecd-a450-1fd3e695a8d8",
    "eventId":"32c3c71b-2e9b-4f02-9edc-d23d372d418f",
    "kind":"decision",
    "target":{"screen":"inbox","projectId":"p_abc","decisionId":"d_abc"}
  }
}
```

target은 빠른 탐색 힌트일 뿐이다. 앱은 연결 후 target API/최신 도메인 조회로 검증한다. hostname·port·접속 URL을 payload에 넣지 않는다. Apple에 전달되는 정보는 고정 종류, 불투명 서버/사건/항목 ID뿐이며, 완전한 무메타데이터 전송이라고 설명하지 않는다.

### 큐 소비와 응답 처리

production `serve()`에서 DB → PushStore/recorder → Store → HTTP routes → outbox worker 순서로 연결한다. 실행기 초기화/복구 전에 recorder가 준비되어 새 상태 전이를 기록할 수 있어야 한다. 기존 Store 호출자는 선택적 인자를 생략할 수 있다. `ServerContext.push`도 optional로 추가하되 production은 항상 주입한다. 기존 테스트 context가 주입하지 않으면 새 라우트만 503을 반환한다.

worker는 단일 프로세스에서 1초 tick와 commit 뒤 wake로 실행하고, DB 조건부 UPDATE/30초 lease로 claim한다. network timeout은 stream당 10초다. worker가 겹치거나 재시작해도 하나의 delivery를 동시에 claim하지 못해야 한다. 전송 직전에 토큰 generation, 기기 enabled/권한/종류/임대, provider 설정, 사건 TTL과 원본 유효성을 다시 읽는다. 이미 답한 결재/해결된 blocked·오류/보관·삭제 프로젝트면 cancelled다. 결재는 source의 updatedAt이 현재 열린 판과 같아야 하고, blocked/error는 source generation이 현재 active episode와 같아야 한다. 새 문제가 이전 문제를 대체했으면 이전 미발신 건을 취소한다. 완료 보고는 메시지 존재만 확인한다. 시험 사건은 프로젝트 검사 없이 기기/전체 enabled/권한/provider/TTL만 검사한다.

| 결과 | 처리 |
|---|---|
| HTTP 200 | accepted 저장, 기기의 lastAcceptedAt 갱신. “APNs 접수”이며 사용자 수신/읽음 표시가 아님. |
| 410 Unregistered/ExpiredToken | 요청의 registration_generation과 현재 값이 같고, 새 등록이 Apple invalidation timestamp보다 뒤가 아닐 때만 invalid·enabled=false·token=NULL. 같은 토큰의 다른 큐 취소. timestamp는 공식 응답의 epoch milliseconds로 비교하고 유효 숫자가 없으면 generation 일치 기준으로 보수적 무효화. |
| 400 BadDeviceToken/DeviceTokenNotForTopic | 해당 generation만 invalid로 처리. 다른 환경으로 토큰을 시험하지 않음. |
| 403 ExpiredProviderToken | 캐시가 실제로 낡았고 마지막 생성 후 20분 이상이면 한 번 갱신 후 확실한 거부 건을 재시도. 갓 만든 토큰도 실패하면 중단/진단. |
| 403 InvalidProviderToken/Forbidden, 인증 관련 오류 | 해당 provider 중단, 모든 기기를 invalid로 만들지 않음. 설정 오류 코드 기록, 미발신은 TTL 내 보류. 키 변경·재시작 전 반복 인증 폭주 금지. |
| 429 TooManyRequests, 500/503, 전송 전 연결 실패 | retry; 지수 지연 5s→15s→60s→300s와 ±20% jitter, 최대 5회, TTL 우선. 유효한 Retry-After가 있으면 최소 대기시간으로 적용. |
| TooManyProviderTokenUpdates | JWT 재생성 금지, 최소 갱신 간격이 지날 때까지 provider 보류. |
| 413/그 밖의 확정 영구 4xx | failed. 고정된 허용 reason 코드만 저장, 원본 응답/요청 전체 로그 금지. |
| GOAWAY/연결 종료 | 새 claim 중단, 처리되지 않았음이 lastStreamID 등으로 확실한 stream만 재연결 재시도. 이미 POST를 썼고 수락 여부가 불명확하면 unknown. |
| request write 뒤 timeout/프로세스 종료 | unknown으로 종료, **자동 재전송하지 않음**. sending lease가 만료된 재시작 잔여분도 unknown으로 처리. |

이 설계는 앱 서버의 확정 중복을 막고, 외부 수락이 불명확하면 재발신보다 유실 가능성을 택한다. 같은 source_key/event-device UNIQUE, 영속 episode, ID 재사용/collapse를 함께 쓰지만 사용자가 배너를 절대 두 번 보지 않는다는 보장은 없다. APNs는 exactly-once 저장소가 아니며 OS 지연·집중 모드·요약도 통제할 수 없다. [APNs 응답 처리](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns).

해지와 전송이 겹치면 claim 직전 검사를 통과한 in-flight 한 건은 이미 Apple로 갔을 수 있다. 서버는 해지 완료 후 새 stream을 만들지 않고 성공 응답이 늦게 와도 해지 상태를 덮어쓰지 않는다. worker shutdown은 새 claim을 멈추고 최대 10초 내 stream 정리/unknown 저장/세션 닫기를 수행한다. CLI/core/herdr 수명과 관계없으며 기존 종료 15초 예산 안에 들어간다.

### 하위 호환

- 새 테이블·전용 API만 추가한다. 기존 Settings.notifyMac·Bootstrap·WsEvent·결재 응답 버전·멤버 status 의미와 사용자 동작은 유지한다. 기존 웹/앱은 새 API를 호출하지 않으면 계속 동작한다.
- 새 앱이 구 서버의 `/api/push/status` 404/501을 만나면 “이 호스트는 iPhone 알림을 지원하지 않습니다”로 표시하고 기존 연결·폴링은 유지한다. 401은 기존 인증 실패 처리를 따른다. APNs 일시 장애 때문에 모든 화면을 오프라인으로 바꾸지 않는다.
- DB backup 후 이주한다. 새 테이블을 모르는 이전 바이너리로의 롤백은 기존 user_version 정책을 확인하고 백업 복원 절차를 따른다. 앱/데몬 버전 혼용이 DB downgrade를 자동으로 허용한다는 뜻이 아니다.
- 라이브 herdr의 실행기·알림 호출 경로를 바꾸지 않는다. Store의 사건 전이는 core/herdr 모두 같은 도메인 상태로 기록된다. 신규 core 기본 전환은 IAMCEO 완성 뒤 가짜 프로젝트에서 별도 검증한다.

## 웹 변경

설정에 별도 **“iPhone 알림”** 섹션을 추가한다. provider 상태, 기기 이름·등록 상태·최근 접속·종류 토글·전체 켜기/끄기·해지·시험 알림을 제공한다. 토큰/p8 입력·업로드·접속 코드 복사 버튼은 만들지 않는다. “푸시 키는 호스트에서 설정합니다”와 설정 문서 링크만 둔다.

기기별 draft/revision을 사용하고 409면 “다른 기기에서 설정이 바뀌었습니다. 새 설정을 확인해 주세요”로 재조회한다. 저장 중 다른 기기 행을 잠그지 않는다. 오프라인/샘플 모드에는 쓰기를 막으며 실패를 성공으로 표시하지 않는다. 성공 후 목록을 다시 읽는다. 별도 WsEvent를 추가하지 않고 설정 패널 열기·window focus·10초 간격(패널 표시 중에만) 조회로 다른 기기의 변경을 반영한다. 기존 실행 설정 draft/저장 띠는 건드리지 않는다.

`web/src/lib/push.ts`에 기존 인증 요청 유틸을 이용하는 전용 client, `components/PushSettings.tsx`에 독립 UI를 둔다. 기존 `lib/api.ts`의 비공개 request helper를 export하고 선택적 If-Match 인자를 추가한다. 임의 Authorization/Host를 덮어쓰는 headers 전달은 허용하지 않는다. Web Push·Service Worker·브라우저 권한 요청은 없다.

## 네이티브 변경

### iOS

- `Services/PushNotificationService.swift`에 OS 권한·현재 토큰 메모리·등록 재시도 상태를 관리한다. 앱이 실행될 때마다 허용/명시적 opt-in 상태를 확인한 뒤 `UIApplication.registerForRemoteNotifications()`를 호출한다. 토큰은 저장소에서 재사용하지 않고 callback의 Data를 사용한다. 연결 불가 시 메모리에만 보관하고 전경/재연결 때 재전송, 앱 종료 후에는 재등록한다. 설치 UUID·serverId→사용자가 확인한 endpoint 연결·수신 의도는 UserDefaults, 접속 코드는 기존 Keychain에 둔다. [Apple 등록 지침](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns).
- `Services/NotificationAppDelegate.swift`를 `#if os(iOS)`로 추가하고 `@UIApplicationDelegateAdaptor`로 연결한다. didFinishLaunching에서 UNUserNotificationCenter delegate를 먼저 설치한다. didRegister/didFail callback과 willPresent/didReceive를 처리하고 completion handler는 네트워크 복구를 무한히 기다리지 않고 항상 한 번 끝낸다. Swift 6의 Sendable 경계에는 필요한 식별자 값만 복사하여 MainActor로 넘긴다.
- 권한 요청은 사용자 켜기 시에만 `requestAuthorization(options:[.alert,.sound])`. denied는 `UIApplication.openSettingsURLString`으로 안내한다. getNotificationSettings에서 sound 허용/배너 허용이 별개임을 UI에 반영한다. provisional은 이미 그 상태이면 저장하되 이번 구현이 조용한 권한을 자동 요청하지 않는다. [권한 요청 API](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/requestauthorization(options:completionhandler:)).
- iOS `Configuration/iOS.entitlements`를 새로 만들고 `aps-environment=$(APNS_ENVIRONMENT)`를 둔다. `native/project.yml`에서 iOS target의 CODE_SIGN_ENTITLEMENTS와 Push Notifications capability(`com.apple.Push`), Debug `APNS_ENVIRONMENT=development`, Release `production`을 선언한다. Info에는 `IAMCEOPushEnvironment=$(APNS_ENVIRONMENT)`를 넣어 앱이 server API의 sandbox/production으로 명시 매핑한다. Debug/Release라는 이름만으로 runtime 환경을 추측하지 않는다. 최종 서명된 앱 entitlement와 Info 값이 일치해야 하며 ad-hoc/TestFlight export에서 변환된 값도 검사한다.
- 일반 alert는 Background Modes의 remote-notification capability나 UIBackgroundModes를 요구하지 않는다. 이번 범위에 추가하지 않는다. APNs를 이용한 상시 작업/주기 백그라운드 실행도 만들지 않는다. 서명/실기기 없이 OS 배달 성공을 주장하지 않는다.
- `Models/PushModels.swift`에 전용 Codable/Sendable DTO, `State/PushSettingsStore.swift`에 전용 API 상태를 둬 기존 Settings 디코딩과 저장 의미를 유지한다. AppStore는 연결 성공/전경 복귀/인증 변경/연결 해제 훅만 제공한다. 연결 generation이 바뀌면 이전 서버의 늦은 callback을 새 서버로 보내지 않는다.
- `Services/APIClient.swift`의 기존 request/send에는 기본값 nil인 선택적 If-Match 인자를 추가해 DELETE revision을 헤더로 전달한다. Bearer/같은 origin/redirect 차단 정책과 기존 호출 시그니처의 기본 동작은 보존한다. 푸시 전용 API 장애는 기존 AppStore의 전체 연결 실패로 전파하지 않는다.
- `Views/PushSettingsView.swift`를 Mac/iOS 공용으로 만들고 iOS에는 시스템 권한/이 기기 등록 동작을 추가한다. demo는 OS 등록/API 쓰기를 하지 않는다. “등록 중”, “허용됨 · 호스트 등록 대기”, “호스트 연결 필요”, “수신 설정 켜짐”, “해지 미완료”를 구별한다.

### 알림에서 앱 안으로 이동

`Services/NotificationLink.swift`는 외부 입력을 검증하는 순수 parser다. payload `iamceo.v=1`과 종류/UUID/ID·target 모양을 검사한다. 잘못된 값은 무시하고 인증 요청을 만들지 않는다. 같은 문법의 링크도 지원한다:

```text
iamceo://open/<serverId>/projects/<projectId>/decisions/<decisionId>
iamceo://open/<serverId>/projects/<projectId>/members/<memberId>
iamceo://open/<serverId>/projects/<projectId>/chat/<messageId>
```

scheme/host/path segment를 고정하고 query·fragment·사용자정보·중복 decoding·슬래시가 들어간 ID·초과 길이를 거부한다. `iamceo://pair?...`는 기존 PairingLink가 처리하고 parser를 섞지 않는다. 링크에는 인증 정보나 목적지 host URL이 없다. 서버가 임의 URL을 보내고 Keychain 코드를 다른 곳으로 보내도록 해서는 안 된다.

알림 payload에서는 eventId를 포함한 pending route를 보관한다. 위 수동 링크는 eventId 없이 도메인 ID를 조회하되 똑같이 현재 연결/소속을 검증한다. AppStore에 있는 현재 서버 ID와 다르면 자동으로 endpoint/접속 코드를 바꾸지 않고 **“이 알림의 호스트에 연결해 주세요”**로 안내한다. 로컬 매핑으로 호스트 이름을 제시할 수 있지만 사용자의 기존 연결 절차로 연결해야 한다. 알 수 없는 serverId를 URL로 해석하지 않는다.

탐색 순서: 연결 확보 → target 재검증 → 해당 프로젝트 select 완료 → 프로젝트 선택 초기화 완료 → Router의 상세 ID/대화 대상 적용. 현재 AppShell의 `onChange(selectedProjectID){resetForProjectChange()}`가 뒤늦게 알림 목적지를 지우지 않도록 pending navigation coordinator가 reset 뒤에 단 한 번 적용한다. 비동기 사이 사용자가 다른 화면/호스트를 고르면 이전 pending 적용을 취소한다. 임시 연결 실패만 pending을 유지하고 로그인 실패/삭제/보관/알림 버전 미지원은 명확히 종료한다.

팀원 알림은 팀원 상세로 열고 **“터미널 열기”**를 제공한다. blocked가 해제되어도 현 상태를 보여 준다. 자동 claim/input/승인 선택은 없다. 결재가 처리되었으면 “이미 처리된 결재입니다”와 실제 처리 내용을 보여 주며 새 답을 제출할 수 있는 것으로 표시하지 않는다.

완료 보고는 Router에 `chatMessageID`를 추가하고 message 주변 조회 결과에서 실제 thread를 결정한다(팀장은 해당 대상, 총괄/본사 AI는 프로젝트 대화). ChatView가 anchor를 로드·스크롤·짧게 강조한다. 메인 state의 최근 목록 전체를 과거 페이지로 덮어쓰지 않고 thread 전용 추가 페이지로 합친다. 삭제된 보고는 “보고를 찾을 수 없습니다” 후 해당 대화로 이동한다. DraftStore의 프로젝트·대상별 초안을 전송/삭제/재지정하지 않는다.

앱이 꺼진 상태의 tap도 delegate → 앱 공용 pending queue로 먼저 받고 첫 창/연결 준비 후 처리한다. iPad 여러 창에는 route 소비 token을 사용해 활성 창 하나만 소비한다. Router를 전역 단일 객체로 바꾸지 않는다. 포그라운드 수신은 refresh만 수행하고 사용자 화면을 강제로 바꾸지 않는다. 최근 처리 eventId를 제한된 100개 메모리 목록에 두어 callback 반복으로 같은 탐색을 중복 실행하지 않는다.

### macOS

Mac은 같은 호스트의 등록 iPhone·종류·provider 상태·시험 알림·해지를 관리한다. 공용 notification link parser/대화 anchor 탐색도 지원한다. 이를 위해 project.yml의 Mac Info에 `iamceo` open scheme도 선언한다. Mac에서 pair 링크를 열었을 때의 기존 안내는 유지한다.

Mac APNs 수신·NSApplicationDelegate 알림 등록·macOS aps entitlement는 추가하지 않는다. 현재 로컬 osascript Mac 알림은 보존한다. 앱의 LocalHostService/launchd 설치와 core vendor 서명 경로도 바꾸지 않는다. 공용 파일의 UIKit/UserNotifications 구현 의존성은 조건부 컴파일/프로토콜로 격리하여 `swift test --package-path native`가 macOS에서 계속 컴파일되어야 한다. UI는 기존 토큰/컴포넌트를 사용하되 현재 다른 작업자의 Design/*.swift를 수정하지 않는다.

## 시험

이번 작업에서는 설계 파일만 작성했다. TypeScript/Swift 구현·실기기/APNs 전송 시험은 수행하지 않았다. 아래는 후속 구현의 수용 기준이다.

모든 서버 시험은 `mkdtempSync(join(tmpdir(),"iamceo-apns-"))`로 임시 IAMCEO_HOME을 만들고 `loadConfig({IAMCEO_HOME:home,IAMCEO_PORT:"0",…})`처럼 **호출 전에** 격리한다. 실제 ~/.iamceo/config.json 또는 기본 APNs 키를 읽지 않는다. 가짜 p8은 시험용 EC 키를 임시 폴더에서 생성한다. 환경 변수는 테스트별 주입하고 전역 process.env 경쟁을 피한다. 끝나면 worker/server/stream/DB를 닫고 임시 폴더를 지운다. 실제 CLI·herdr/core socket·launchd·7878은 사용하지 않는다.

| 시험 파일 | 반드시 추가할 시나리오 |
|---|---|
| `tests/push-store.test.ts` | 이전 DB fixture→migration 백업/유지/재실행; 다른 작업자 이주와 순차 적용; serverId 유지; 신규 기기 disabled/기본값; 두 iPhone fanout; variable token 길이/잘못된 hex; token 이전/환경 분리; revision 경쟁·늦은 PUT 뒤 해지; tombstone; 임대 만료·보존 청소. |
| `tests/push-events.test.ts` | 옵션 있는 ask/없는 ask 각각 한 번; 연관 질문 메시지/Bus 재방송으로 중복 없음; 재열림 한 번; 완료 post만 대상; worker/총괄 구별 없이 명시 완료 기록; idle/turn_end/fallback/막힘은 완료 아님; 같은 message ID 재시도; blocked tick/context 갱신/재시작 중복 없음; 해결 후 재발 generation; lastError만 생긴 실패; 같은/다른 오류 digest; 이주 baseline 무알림; 도메인+outbox rollback 원자성; 보관/삭제/답변/해결 후 미발신 취소. |
| `tests/push-http.test.ts` | 모든 라우트 응답/strict 입력·8KiB·400/401/403/404/409/429; 멤버 token/쿠키/query 거부; Host/Origin 검사; GET에 토큰·키 유출 없음; 부분 preferences merge; 새 등록이 기존 OFF를 켜지 않음; 설정 충돌; 해지 멱등; 시험 requestId 중복/분당 제한; around 조회·잘못된 프로젝트·before 충돌·기존 pagination 유지; 구 context와 미설정 provider의 차이. |
| `tests/apns.test.ts` | 생성 JWT를 public key로 ES256 검증, P1363 64-byte/base64url/iat 초 확인; 20/50/60분 경계·단일 갱신·시계 역행; 환경/키/연결 cache 분리; private key 권한/PEM 오류; 고정 HTTP2 headers·payload byte 한도·비밀 canary 배제; 무작위 포트의 시험용 TLS HTTP/2 peer와 h2 ALPN/인증서 검증. |
| `tests/push-worker.test.ts` | 주입 clock/transport로 200/400/403/410/413/429/500/503·잘못된 응답·write 전후 timeout·GOAWAY lastStreamID; 지수 재시도/TTL; 410 timestamp 밀리초·새 등록 generation 경합; 해지 in-flight 경합; 두 worker claim; stale sending→unknown·자동 재발신 없음; 키 미설정/인증 장애 격리; 재시작 accepted 중복 없음; shutdown 10초 이내. |
| `tests/push-web.test.ts` | 기기별 저장과 revision 409, error/오프라인/구 서버 상태, 시험 알림 queued와 수신 완료 혼동 없음, 기존 실행 설정 draft 보존. 기존 browser harness 사용 시 반드시 임시 home/포트 0 fake 서버. |
| `native/Tests/IAMCEOTests/PushTests.swift` | mock permission/token provider·URLProtocol로 허용/거부/재등록/토큰 실패·오프라인/reconnect; 토큰 미영속·설치 UUID 유지; 구 서버 404에서 기존 연결 정상; generation 바뀐 callback 폐기; offline 해지 미완료; demo 무등록; enabled 의도와 server revocation 보존; DTO/epoch 시각/설정 상태. |
| `native/Tests/IAMCEOTests/NotificationLinkTests.swift` | payload/link parser 잘못된 scheme/unknown version/query/인증정보/이중 인코딩/다른 serverId·프로젝트 멤버 불일치; cold start pending; 전경 수신은 탐색 안 함; 프로젝트 reset 이후 목적지 유지; 2개 창 중 하나만 소비; 처리한 결재·삭제/보관 항목; 오래된 완료 보고 around anchor; 초안 불변·자동 제출 없음. |

HTTP/2 실제 peer 시험은 시험 코드 내 self-signed 인증서/키를 임시 폴더에서 생성하고 **해당 client에만** CA를 신뢰시킨다. `NODE_TLS_REJECT_UNAUTHORIZED=0` 같은 전역 우회는 금지한다. production APNs origin override를 열지 않고 transport 의존성 주입으로 격리한다. Bun 1.3.14 원본 실행과 `bun build --compile` 산출물 양쪽에서 이 계약 시험을 통과시킨다. 현재 API symbol 존재 확인만으로 이 시험을 대체하지 않는다.

후속 기본 확인: `bun run typecheck`, 새 push 시험 묶음, 관련 기존 Store/HTTP/approval/core-runner/herdr 회귀 시험, `swift test --package-path native`(scratch path는 임시 폴더), macOS/iOS simulator 무서명 빌드. 전체 시험이 실제 모델/소켓을 여는지 확인하고 paid E2E는 실행하지 않는다. 클린 전체 suite가 필요하면 기존 fixture의 IAMCEO_HOME 격리를 먼저 검토한다.

실기기 수용 시험은 소유자가 준비한 **별도 개발 호스트·임시 IAMCEO_HOME·가짜 프로젝트**에서 수행한다. Debug sandbox와 배포/TestFlight production 각각 실제 entitlement/topic/키환경을 대조하고, 포그라운드/백그라운드/앱 종료 후 tap, 허용/거부/철회, Tailscale 켬/끔, 인터넷 단절, 호스트 재시작, 두 iPhone, 기기 해지, 같은 사건 반복 관측을 확인한다. 가짜 ask/post와 fake runner만 사용하고 라이브 herdr/7878에 시험 사건을 넣지 않는다. 성공 증거는 APNs 200과 실기기 표시/목적지 진입을 따로 기록한다.

## 위험·미정

- **병렬 수정 충돌:** 이번 후속 구현에서 `server/db.ts`, `server/store.ts`를 고쳐야 한다. 현재 문맥 창 작업자와 파일 소유권을 조정한 뒤 이 두 파일은 한 사람이 병합한다. append migration 번호를 미리 예약하지 않는다. `shared/types.ts`, `server/runner/herdr.ts`, `server/runner/context.ts`, `tests/context.test.ts`, `native/Sources/IAMCEO/Design/*.swift`는 읽기 참고이며 이 설계의 수정 대상이 아니다. 새로운 타입은 shared/push.ts에 둔다.
- 문서 일부는 core를 현재 기본이라고 표현하지만 작업 지시의 **라이브는 herdr, core 기본 전환은 나중**을 우선한다. APNs 때문에 runner 선택·live service를 바꾸지 않는다.
- 도메인 Store recorder가 붙지 않은 독립 import/fixture 경로는 푸시가 없다. production 주입 누락을 통합 시험에서 반드시 검출한다. 외부 코드가 DB를 직접 바꾼 경우까지 사건 알림을 보장하지 않는다.
- exactly-once 배달과 전체 알림 보존은 불가능하다. 이 설계는 확정 전송 실패만 재시도하고, 수락 여부 불명은 unknown으로 종료하므로 가끔 푸시가 빠질 수 있다. 결재함·상태 조회가 최종 원본이다. 필요시 나중에 사용자 개입 알림을 묶는 별도 정책을 설계한다.
- APNs에 접수된 알림은 상태 해결/기기 해지 뒤에도 도착할 수 있다. 탭 후 최신 상태를 검증한다. 오프라인 해지의 즉시 서버 효력도 보장하지 않으며 다른 기기 해지/30일 임대가 최종 경계다.
- core의 blocked는 신뢰·로그인·status 미설정까지 포함한다. 알림에 “승인 필요”를 단정하지 않는다. 정확한 메뉴 분류는 추후 runner 상태 기능이며 본 설계에서 herdr 화면 parser를 이식하지 않는다.
- 질문/결재의 의미를 options 유무 이상으로 분리하려면 ask의 명시적 종류 필드와 데이터 이주가 필요하다. 이번 결정은 기존 계약을 유지하는 분류이며 다른 추측은 하지 않는다.
- Apple 문서에 기존 양환경 team key와 새 환경 제한 키 설명이 함께 있다. **새 키는 환경별 자격증명으로 취급**하고 Portal의 실제 scope/environment가 우선이다. 토픽별 키/관련 키 선택과 프로비저닝은 소유자가 확인해야 한다.
- 환경 변수/Info 값과 최종 서명 entitlement의 불일치는 BadDeviceToken을 만든다. 환경별 실기기 시험 전에는 출시 완료로 표시할 수 없다. simulator 배너 주입은 APNs 네트워크 성공 증거가 아니다.
- DB를 복제해 두 호스트를 동시에 실행하면 serverId·토큰·미발신 작업도 복제된다. 복구 문서에 **복제 호스트는 APNs disabled로 시작하고 기존 미발신 취소·새 serverId·기기 재등록 후 켜기**를 명시한다. 정상 단일 호스트 복원은 기존 serverId를 유지하되 unknown/accepted를 재발신하지 않는다.
- p8은 호스트 사용자 권한의 비밀이다. CLI가 같은 OS 사용자로 실행되는 기존 구조는 p8을 강한 sandbox로 격리하지 않는다. 키 권한·topic/environment 제한·서버 API 비노출로 범위를 줄이지만 OS 사용자 탈취까지 막는다고 약속하지 않는다.
- 확정 외부 실전송은 미검증이다. Bun 1.3.14 HTTP/2+TLS/컴파일 산출물 호환과 유료 Apple 계정의 실제 App ID 소유/서명 완료 여부는 구현 수용 시험에서 확인해야 한다. 문제가 있으면 일반 서버는 유지하고 push만 unavailable로 표시한다. 별도 Node daemon/FCM을 조용히 추가하지 않는다.

## 소유자 할 일

아래는 구현 이후 수행할 설정 절차다. 이 설계 작성 중에는 계정/키/호스트를 변경하지 않았다. 유료 Apple Developer Program 가입을 다시 요구하지 않는다.

1. [Apple Developer 계정](https://developer.apple.com/account/)에 **Account Holder 또는 Admin**으로 로그인한다. Membership에서 10자리 **Team ID**를 확인한다. Xcode → Settings → Accounts에도 같은 계정을 추가하고 사용 팀을 선택한다.
2. Certificates, Identifiers & Profiles → **Identifiers → + → App IDs → App**으로 explicit App ID를 만든다. Bundle ID는 현재 iOS target의 **`com.iamceo.native.ios`**와 일치시킨다. 이미 본인 팀에 있으면 그 ID를 연다. **Push Notifications**를 켜고 저장한다. 다른 팀에 이미 점유되어 있으면 자신이 소유한 새 ID를 먼저 확정한 뒤 project.yml·허용 topic·키 scope를 모두 함께 바꾼다. 앱별 인증서 생성은 p8 인증에 필요하지 않다.
3. **Keys → +**에서 이름(예: `IAMCEO sandbox push`)을 넣고 **Apple Push Notification service (APNs)**를 체크 → 옆의 **Configure**를 연다. 환경은 **Sandbox**, 유형은 가능하면 **Topic Specific**, topic은 위 App ID를 고른다. 저장/계속 후 설정을 검토하고 Confirm/Register한다. Portal 표시 문구는 계정 UI에 따라 다를 수 있으나 마지막 요약의 환경/topic이 정확해야 한다.
4. Download를 눌러 **`AuthKey_<KEY_ID>.p8`**를 받고 10자리 **Key ID**를 기록한다. 다운로드는 한 번뿐이므로 안전한 별도 백업을 보관한다. production도 같은 절차로 **Production 전용 키**를 만들거나 Portal에서 제공하는 관련 키 생성 절차를 따른다. 예전 양환경 키를 쓰려면 실제 scope를 확인하며 새 키도 무조건 양환경이라고 가정하지 않는다. [Apple 키 생성·환경/topic 설정 절차](https://developer.apple.com/help/account/keys/create-a-private-key/).
5. p8을 레포·웹 UI·채팅·앱 번들·공개 동기화 폴더에 넣지 않는다. 호스트 전용 비밀 폴더 0700에 두고 파일은 0600으로 만든다. `$IAMCEO_HOME/apns.json`도 0600으로 만들고 환경별 keyId/teamId/bundleId/privateKeyPath를 위 형식으로 기록한다. 일반 앱에는 private key를 배포하지 않는다. 변경을 적용할 실제 데몬 재시작은 별도 운영 작업으로 수행한다.
6. 후속 구현의 `native/project.yml`을 기준으로 Xcode 프로젝트를 재생성한다. iOS target Signing & Capabilities에서 본인 Team, explicit Bundle Identifier, Automatically manage signing, **Push Notifications** capability를 확인하고 프로파일을 갱신한다. USB 연결 iPhone의 Developer Mode와 신뢰를 확인하고 **개발 서명**으로 설치한다. 현재 계정 로그인/서명 완료를 가정하지 않는다.
7. 서명된 Debug 앱의 `aps-environment=development`와 Info `development`를 검사하고 sandbox로 등록한다. 배포 archive/export는 최종 `aps-environment=production`과 Info `production`을 검사한다. TestFlight도 production 키/provider를 사용한다. 개발 토큰을 production에 복사하지 않는다.
8. 개발 호스트는 Apple APNs로 TLS TCP 443 outbound가 가능해야 한다. iPhone도 Apple push에 인터넷으로 연결되어야 한다. 서버 inbound 공개 포트/공유기 포트포워딩/Apple에서 Tailscale로 들어오는 콜백은 필요 없다. 데이터 조회용 기존 Tailscale Serve 연결은 유지한다.
9. iPhone 연결 후 **“이 iPhone에서 알림 받기”**를 켜고 OS 허용 → **“시험 알림 보내기”**로 실제 배너와 탭 후 홈 진입을 확인한다. 다섯 사건/오프라인/기기 해지 수용 시험을 별도 가짜 프로젝트에서 마친 뒤 운영 환경에 적용한다.
10. 키 유출·폐기 시 새 키 생성/설정 → 새 연결로 시험 → 기존 키 revoke 순서로 교체한다. 의심되는 키는 사용을 중단한다. p8 자체에 JWT 같은 1시간 수명이 있는 것은 아니며 revoke와 환경/topic 범위가 중요하다. 기존 연결도 닫고 새 키로 재생성한다. [Apple 키 교체 안내](https://developer.apple.com/help/account/capabilities/communicate-with-apns-using-authentication-tokens).

## 파일 목록

아래는 **후속 구현에서 생성/수정할 파일 전체**다. 현재 작성한 파일과 혼동하지 않는다. 각 행은 병렬 구현 배정을 위한 절대경로 하나다. 실제 수정 대상 중 충돌 지정 파일은 server/db.ts와 server/store.ts 두 개이며 단일 병합 담당자가 맡는다. 나머지는 서버/웹/네이티브/문서 단위로 분할할 수 있다. generated Xcode project·lockfile·기존 Design 파일·herdr/context는 수정 목록에 넣지 않는다.

```text
/Users/yesung/iamceo/shared/push.ts
/Users/yesung/iamceo/server/push/config.ts
/Users/yesung/iamceo/server/push/store.ts
/Users/yesung/iamceo/server/push/events.ts
/Users/yesung/iamceo/server/push/apns.ts
/Users/yesung/iamceo/server/push/worker.ts
/Users/yesung/iamceo/server/db.ts
/Users/yesung/iamceo/server/store.ts
/Users/yesung/iamceo/server/http.ts
/Users/yesung/iamceo/bin/iamceo.ts
/Users/yesung/iamceo/web/src/lib/api.ts
/Users/yesung/iamceo/web/src/lib/push.ts
/Users/yesung/iamceo/web/src/components/PushSettings.tsx
/Users/yesung/iamceo/web/src/screens/Settings.tsx
/Users/yesung/iamceo/native/project.yml
/Users/yesung/iamceo/native/Configuration/iOS.entitlements
/Users/yesung/iamceo/native/Sources/IAMCEO/IAMCEOApp.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Models/PushModels.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Services/APIClient.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Services/PushNotificationService.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Services/NotificationAppDelegate.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Services/NotificationLink.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/State/PushSettingsStore.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/State/AppStore.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/State/Router.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/PushSettingsView.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/SettingsView.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/AppShell.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/ChatView.swift
/Users/yesung/iamceo/tests/push-store.test.ts
/Users/yesung/iamceo/tests/push-events.test.ts
/Users/yesung/iamceo/tests/push-http.test.ts
/Users/yesung/iamceo/tests/apns.test.ts
/Users/yesung/iamceo/tests/push-worker.test.ts
/Users/yesung/iamceo/tests/push-web.test.ts
/Users/yesung/iamceo/native/Tests/IAMCEOTests/PushTests.swift
/Users/yesung/iamceo/native/Tests/IAMCEOTests/NotificationLinkTests.swift
/Users/yesung/iamceo/docs/spec.md
/Users/yesung/iamceo/docs/architecture.md
/Users/yesung/iamceo/native/README.md
```

`server/store.ts`의 recorder 선택 인자와 트랜잭션 경계, `server/http.ts`의 ServerContext 주입/라우트·around 조회, `bin/iamceo.ts`의 수명 연결을 먼저 합의한 뒤 각 구현을 붙인다. shared/types.ts에는 손대지 않는다. project.yml이 생성하는 Info.plist 변경은 재생성 산출물로 취급하고 수동 구현 소유권에서 제외한다.

## 크기

**L.** 토큰 한 번 저장하고 APNs를 호출하는 수준을 넘어, 영속 사건/outbox와 도메인 트랜잭션, 토큰 교체·해지·410 경합, 불확실 수락의 중복 정책, 두 APNs 환경·JWT/HTTP2, SwiftUI cold start/여러 창/기존 초안 보호, 실제 서명·실기기 수용 시험까지 묶여 있다. 구현은 서버 계약/큐 → 웹·네이티브 설정 → 링크/대화 anchor → 격리 통합 시험 → 소유자 실기기 검증 순서로 진행한다. 실기기·키 준비는 소유자 단계이며, 이 문서 작성 완료와 푸시 기능 구현 완료는 구별한다.
