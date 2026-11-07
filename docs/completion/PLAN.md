# IAMCEO 완성 구현 계획 초안

기준일: 2026-11-07. 이 문서는 구현 발주안이다. 이번 작업의 쓰기 산출물은 `.pumasi/PLAN.md` 하나이며 코드·설정·라이브 데이터·git 상태를 변경하지 않는다. 설계 6개, 감사 6개, 검증 6개 및 `docs/claude-handoff.md`를 전체 대조했다. 폐기된 `delivery-notice.v1-manual.md`는 사용하지 않았다. 아래 신규 파일·명령은 **후속 구현용**이다.

## 범위

우선순위는 **소유자 결정 → 제품 계약 → 최신 기능 설계 → verify 감사의 축소된 결론**이다. 감사 번호는 `lifecycle#1`, `limits#L2`, `client#C1`처럼 원 보고서 번호를 쓴다. `확인`은 코드 경로 확인이지 실제 장애 발생률이나 출시 시험 통과를 뜻하지 않는다.

### 기능 6개

| 항목 | 구현할 동작과 완료 조건 | 출처 |
| --- | --- | --- |
| 대화 이전 기록 | 최초 200개, 이전 100개. 프로젝트/직원 범위별 `(at BINARY,id BINARY)` keyset, 불투명 커서, ID 중복 제거, POST/실시간 상태 역전 방지, 200개 초과 재연결 gap 연결. prepend 적용 직전 읽던 메시지와 부분 offset을 유지한다. | specs/chat-paging.md |
| 프로젝트 이름·보관·꺼내기 | 이름만 변경해도 ID·초안·세션 유지. 사이드바 **보관함**에서 대화·결재·업무·자료를 읽는다. 보관 화면은 읽기 전용이며 꺼내기는 별도 관리 액션이다. 본사 보관 불가, 삭제 없음. 관리 직원은 실제 종료 확인 후 재우고 native 세션/이력을 보존한다. | specs/project-manage.md + 소유자 결정 4 |
| 전달 자동 판정·복구 | 영속 표식/봉투, 주 세션 user 입력 증거, 전체 DB 집계, 자동 오표시 정정, 확실한 쓰기 전 실패의 자동 재전송, 안전이 증명된 미제출의 Enter 1회. 끝내 판정 불가한 경우만 증거·추천·허용 행동을 올린다. 사람이 받음으로 확정하는 버튼은 없다. | specs/delivery-notice.md |
| 네이티브 실시간 동기화 | v2 epoch/seq WebSocket + 일관된 `/api/sync`; gap/재시작/전경 복귀 때 재조회, 단일 coordinator, REST fallback/backoff, 비활성 네트워크 중단. 정상 연결 중 3초 상태 폴링 제거. v1 서버·현재 웹은 호환한다. | specs/realtime.md |
| iPhone APNs | 명시적 opt-in 뒤 기본 **4종 모두 켬**: 새 결재(자유 답변 질문 포함), 증거로 확인된 승인 창 앞 멈춤, 오류 멈춤, 완료 보고. 완료 보고는 같은 프로젝트·직원별 고정 120초 창으로 묶는다. 영속 outbox, 기기 revision/해지, HTTP/2/JWT, 탭 후 최신 상태 확인. | specs/apns.md + 소유자 결정 4 |
| core 문맥 수집·압축 | 기존 공용 실측 창/statusline/Codex parser 재사용, 세대·모델·신선도 표시. fresh exact 측정 + 실제 wake 큐 + 다음 업무 전 조건에서만 자동 압축. 수동 예약, 완료 기록 검증, 결과 불명 재송신 금지. | specs/core-context.md |

### 확인된 감사 항목을 합친 작업 범위

| 주제 | 반영할 최소 범위 | 출처와 판정 |
| --- | --- | --- |
| core 재기동·재결합 | 확실히 부재한 **IAMCEO 소유 core만** 제한적으로 기동 재시도. 최초 bind 실패 멤버를 큐와 별도로 추적하고 읽기 재결합. 멤버별 마지막 관측·실패·소유 충돌을 표시한다. 살아 있는 holder에 새 CLI를 겹치지 않는다. | lifecycle#1 부분, #2 확인, #9 부분; status#2 확인, #6 부분; limits#L6 확인; ops#08 부분 |
| 영속 생성·종료·실행 의도 | start 전에 member/operation/세대 저장. run 응답 불명에서는 멤버 삭제 금지. sleep/close/archive는 종료 증거 뒤 최종 상태 저장, closing finally 해제. 미종결 실행·전달 ID·종료 사유를 재시작 후 대조하고 중단 통지는 한 번만 기록한다. 초기 resume 종료의 reason/exit_code를 보존한다. | lifecycle#3 부분, #6·#7 확인, #8 부분; status#1 확인; flow#5 확인; limits#L5 부분; client#C6 확인 |
| 실행 결과·관측 순서 | refresh 직렬화, terminal/세대/turn 식별, 이전 턴 이벤트 폐기, 같은 종료 한 번. error→idle이 같은 오류를 지우지 못하게 한다. 정상 ACK 뒤 시작/진전 부재를 읽기 재검사하고 증거가 있을 때만 latch 정정. 시간만으로 interrupt/send/Enter 금지. | status#3·#4·#5 부분; lifecycle#5 부분; flow#4 확인; limits#L1·#L4 부분 |
| 사실대로 상태 표시 | 확인된 승인과 setup/status_unknown 분리, 미수집 서브에이전트는 0과 구별. now는 마지막 보고와 전용 시각으로 표시하고 next 생략 시 보존. manual 활동 시각은 일반 updatedAt과 분리하고 추정 상태임을 표시한다. 정확한 자식 lifecycle 전면 수집은 요구하지 않는다. | status#7·#8·#9·#10 부분 |
| 공통 자동 실행 admission·재시도 | core 자동 턴도 await 전에 `maxConcurrentTurns` 슬롯 예약, 실패/종료에서 한 번 반환, 복구 시 기존 실행부터 재구성. 실제 재시도 큐의 nextAttemptAt을 영속화하고 증명 가능한 오류 범위만 공유 대기. quota/auth 원인과 처리 실패 연결을 보존하되 추정 reset/계정 범위나 자동 계정 전환은 만들지 않는다. | limits#L2 확인, #L8 부분, #L1 부분 |
| 원본 저장→전달 의도 누락 | 답·대표 메시지·보고 저장과 outbox 의도를 같은 transaction에 넣고 commit 뒤 pump. 전체 DB에서 전달 행 없는 원본을 수선한다. orphan 최근 500개 제한도 제거한다. | flow#1 부분; verify-flow.md 메모의 재현된 500건 밖 누락 |
| 도구·업무 후속 정합성 | 안정적인 operationId가 같은 도구 호출만 receipt로 합친다. 전송 중 todo 취소는 send 결과 확정 뒤 최신 판 정정 통지 1회. 실행 후속이 필요한 결재 닫기는 대상/원문 출처/후속 의도를 함께 저장. 보고 봉투에 원본·자료 전체·결재 참조와 작성 순서/정정 관계 보존. 판 정리의 요청/완료/검토 board revision 분리. | flow#2·#3·#7·#8·#9·#11 부분 |
| 필수 보고·manual 수신 | core 역할 지침의 자동 최종 게시 약속 제거, post/질문/위임대기/무변경 정리 예외 구분, 필요한 보고 누락만 1회 보완. manual batch 재조회/ack, askWait와 공유 소비 상태, 멤버별 미수신 answered 전체 조회. 새 엄격 계약에서는 답 검토 버전을 요구한다. | flow#6·#12·#13 확인, #14 부분 |
| 직접 조작·세션 작업 신원 | terminal·세대 결합 lease 영속화/복원, 클라이언트 claim ID 재사용. 직접 입력 applied/refused/unknown 구별, unknown 재생 금지. fresh-session operation receipt와 session generation, 멤버 설정 config revision 적용. | lifecycle#10 확인; client#C4·#C5 부분 |
| 네이티브 쓰기·초안 보존 | 최초 메시지 attempt/불변 ID/대상/본문/첨부/초안 revision 영속화, 재시작 후 접수 자동 조회. 호스트 namespace, 늦은 업로드 세대 차단, 완료 첨부 복원. dirty 설정만 CAS 저장, 터미널 후속 편집 보존, 카드별 묶음 답 수락 결과, todo 결과 확인 중/최신 revision 보호. | client#C1·#C3·#C7·#C8·#C9 확인, #C2·#C10 부분 |
| 데이터 홈·데이터 복구 | DB/recovery 전 홈 단위 프로세스 배타 소유권. 미래 user_version 거부. 정기 DB+참조 첨부+설정 백업, manifest·DB 검사·첨부 존재/크기/해시 검증, 별도 경로 복원 리허설. 자동으로 검증 가능한 개별 파일만 복구하고 DB 전체 덮어쓰기는 운영 전환으로 분리한다. | ops#01 확인, #02·#03·#04 부분 |
| 저장 실패·잔여물·로그 | ENOSPC/SQLITE_FULL 분류와 실패 응답, 게시 전 전체 입력 검증, 실패 작업의 미참조 첨부 추적/정리. uploads/inbox/백업 사용량·보존량, 명백한 미참조만 유예/격리 후 정리. config 0600 원자 교체와 권한 교정. 열린 FD를 고려한 로그 회전/총량 제한. | ops#05 부분, #06·#07·#11 확인, #12 부분 |
| 설치·연결·접근 회수 | CLI 등록/업데이트의 인증된 readiness·실행 버전 대조와 실패 표시. 명시적 보조 host bind 실패도 재시도. 전역 접속 코드 회전·기존 인증/열린 연결 거부를 제공하고 pairing 응답 유실에는 새 QR 안내. | ops#10·#15 부분, #13·#14 확인 |
| 호스트 사망의 한계 | KeepAlive와 전경 장애 복구 유지, liveness/readiness 구분. 외부 heartbeat 서비스는 필수 구현에 넣지 않는다. 앱 비활성 중 호스트 자체 사망 통보가 필요해질 때 관측자/채널을 별도 결정한다. | ops#09 부분의 조건부 결론 |

**제외·중복 처리:** `limits#L3` 반박은 제외한다. `maxAwakeWorkers`를 강제 전역 상한으로 바꾸지 않는다. `lifecycle#4`·`flow#10` 중복은 delivery/core-context의 native ID 연결 및 `gone→paneId=null→wake` 회귀로, `limits#L7`은 delivery의 noOutput 통합·답 이력 보존으로, `limits#L9`는 APNs 오류 episode로 합친다. 각 부분 판정의 과장된 원 제안(무조건 자동 interrupt, 전체 자식 수 재구성, 계정별 quota를 추측한 대규모 차단기, 기기별 인증 전면 교체)은 발주하지 않는다. ops#13은 검증 권고대로 전역 회전부터 수행하고 기기별 credential은 후속 인증 설계로 남긴다. 반박/범위 밖 항목을 다른 이름으로 되살리지 않는다.

### 설계 충돌을 해소한 구현 계약

1. **web/ 변경 0개.** 설계서의 웹 UI/상태/신규 브라우저 기능 작업은 모두 삭제한다. v1 REST·WS·Message.delivery 5값·기존 body/응답은 유지하고, 현재 웹이 보내지 않는 새 필드를 필수화하지 않는다. 새 ws-session 쿠키와 웹 v2 전환은 발주하지 않는다. v2 네이티브는 Bearer 헤더만 사용한다. 기존 v1 URL 인증은 호환 부채로 남기되 로그에서 query를 제거한다.
2. **보관함은 읽기 화면까지 포함.** project-manage의 ‘설정 안 보관 목록만/기록 뷰어 없음’을 덮어쓴다. `GET /api/projects/:id/archive/state`, `GET /api/projects/:id/archive/messages/page`를 사용자 인증 아래 추가한다. 전자는 archived인 프로젝트만 읽기 snapshot을 반환하고, 후자는 일반 page와 같은 strict query 4개와 정렬을 사용한다. 없는/활성 프로젝트는 404. 기존 `/state`와 일반 `/messages/page`의 보관 404는 유지한다. 기록 뷰어에는 보내기·답·체크·직원 조작을 노출하지 않는다. 꺼내기/이름 변경은 별도 관리 UI다. 늦은 manual 보고/자료와 기존 API의 todo 호환은 유지하므로 DB 불변 스냅샷이라고 부르지 않는다.
3. **세션 보존은 검증한다.** 보관 전에 managed CLI의 resume 가능한 native ID/기록을 확인한다. Codex ID가 끝내 없으면 시스템이 먼저 기존 표식으로 탐색하고 보관은 409로 보류한다. 알 수 없는 세션을 죽여 놓고 복원 가능하다고 표시하지 않는다. 재시작 안전성은 project-manage 단독 설계의 메모리 격리 한계 대신 lifecycle의 영속 종료 journal로 보완한다. manual은 소유 프로세스가 아니므로 종료하지 않는다.
4. **푸시 4종·120초 묶음.** `PushKind`는 `decision|approval_wait|error|report_complete`. options 없는 ask도 decision 사건 하나로 묶고 고정 문구를 쓴다. report_complete 기본 OFF를 ON으로 바꾼다. 전체 기기 enabled=false/명시적 opt-in은 유지한다. `(projectId,memberId)`별 첫 보고 시각부터 120초 고정 창, 창 연장 없음, 다른 직원/프로젝트 분리. group ID·마감·마지막 메시지 ID·보고 ID 목록·처음의 수신 가능 기기 집합을 DB에 저장한다. 닫을 때 사건/기기 delivery를 한 번 만들고 탭은 마지막 보고와 묶음 참조로 이동한다. 껐다 켜도 취소된 과거 그룹을 살리지 않으며 새 등록 기기에 소급하지 않는다. 재시작도 마감/중복 억제를 유지한다.
5. **쓰기 엄격 계약과 v1 호환을 분리한다.** 새 네이티브 쓰기는 `X-IAMCEO-Contract: 2`로 capability를 선언한다. 설정/멤버/todo에 reviewed revision, fresh-session에 operationId+session generation, terminal에 operationId+claim ID+입력 순번을 요구하고 결과 조회를 제공한다. 기존 무본문 fresh/기존 PATCH/terminal 응답은 v1에서 유지한다. 새 엄격 결재 답은 기존 문자열 `expectedVersion=Decision.updatedAt` 필수이며 누락 400, 변경 409. 숫자 recovery version과 혼동하지 않는다. 동일 receipt 조회는 버전 재검사보다 먼저 하되 인증/소속은 항상 검사한다. v1의 검토 버전 없는 쓰기를 완전히 차단하는 일은 웹 폐기 뒤 버전 폐지 작업이다.
6. **증거의 의미를 구분한다.** 접수, CLI 수신, 턴 시작/종료, 보고, 업무 완료는 각각 기록한다. terminal send의 검증된 수신 ACK와 `started:false` 계약은 유지한다. post-write timeout 뒤 부재만으로 재전송하지 않는다. 영속 재시도/시작 정체 진단은 안전한 자동 재관측부터 구현하며, 사람에게는 확인 불가 사유·마지막 증거·추천과 허용 행동을 함께 준다.
7. **native 동기화는 하나다.** 개별 설계의 ‘3초 폴링 유지’는 이행 단계에만 적용한다. 최종 AppStore coordinator가 REST snapshot/history/delivery/활동 갱신을 합친다. history는 프로젝트 snapshot과 별도이며 관련 message 이벤트·재접속·화면 재진입에 최신 페이지를 읽는다. 정상 WS에서 history의 별도 3초 폴링도 남기지 않는다.

### 계약을 먼저 고정할 공개 경계

W1에서 다음 시그니처를 확정하고 기능이 연결되는 웨이브에서 구현한다. 기존 메서드의 매개변수나 응답을 임의로 바꾸지 않는다.

```ts
Store.listMessagePage(
  projectId: string,
  opts?: { scope?: MessageScope; cursor?: string; limit?: number }
): MessagePage;
Store.validateProjectPatch(id: string, patch: ProjectPatch): ProjectPatch;
Orchestrator.patchProject(projectId: string, patch: PatchProjectReq): Promise<Project>;
// Runner의 기존 실행기 구현이 선택 인자를 생략할 수 있도록 유지한다.
Runner.stop(m: RunnerMember, opts?: { whileWorking?: boolean }): Promise<void>;
Runner.inspectDelivery?(m: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection>;
Runner.repairDelivery?(m: RunnerMember, request: DeliveryRepair): Promise<SendResult>;
// 기존 compact(m, focus, opts) -> Promise<SendResult> 시그니처 유지.
```

```swift
// APIClient
func messagePage(projectID: String, scope: MessageScope, cursor: String?, limit: Int) async throws -> MessagePage
func archivedProjects() async throws -> [Project]
func patchProject(id: String, request: PatchProjectRequest) async throws -> Project
// AppStore
func loadArchivedProjects() async
@discardableResult func patchProject(id: String, request: PatchProjectRequest) async -> Bool
```

`GET /api/capabilities`는 사용자 Bearer 아래 `contractVersion:2` 및 실제 활성화된 paging/archive/delivery/realtime/push/operations capability를 반환한다. 아직 구현되지 않은 기능을 true로 광고하지 않는다. 추가된 `/api/sync` v2 snapshot에는 `revisions`를 두어 settings revision, 선택 프로젝트의 member config revision/session generation과 todo revision을 같은 읽기 경계로 제공한다. 기존 Settings/Member 쓰기 body를 강제로 확장하지 않는다. v2 설정·멤버·todo 쓰기는 `If-Match: "<정수 revision>"`를 사용하고, 설정의 ranks는 고친 하위 필드만 보낸다. fresh-session/terminal body의 operationId·검토 세대·claim/입력 순번은 W1 타입에 고정한다. `GET /api/operations/:operationId`는 해당 사용자의 작업에 대해 `pending|applied|refused|unknown`과 허용된 결과만 반환하며 임의 요청 본문·토큰은 노출하지 않는다. 없는 operation은 404다. 메시지 접수 확인은 기존 ID의 새 단건 GET을 사용한다.

이 확장은 별도 설계의 빈 경계를 메우는 **본 계획의 결정**이다. 각 기능의 기존 경로·커서·본문·상태 코드는 해당 설계를 그대로 따른다. 새 capability 조회 실패가 전체 앱 연결을 실패로 만들거나 쓰기 재생을 유발해서는 안 된다.

## 웨이브

**착수 전제 W0:** Claude의 문맥 창 수정 `server/runner/herdr.ts`, `server/runner/context.ts`, `server/db.ts`, `server/store.ts`, `shared/types.ts`, `tests/context.test.ts` 및 `native/Sources/IAMCEO/Design/*.swift`가 끝난 뒤 웨이브 1을 시작한다. `statusline.ts`·`codex-context.ts` 등 실제 추가 부품과 최종 export도 다시 읽는다. 아래에서 해당 파일을 고치는 작업은 **그 결과 위에 누적**하며 되돌리거나 이전 문서의 ‘Codex 수집 없음’을 그대로 구현하지 않는다. context.ts·statusline.ts·tests/context.test.ts는 원칙적으로 재사용/회귀만 한다. 추가 변경이 필요하면 별도 웨이브로 소유권을 다시 정한다.

**품앗이 발주 규칙:** 각 행은 Codex 워커 한 명의 배타 수정 목록이다. 같은 웨이브는 병렬 실행 가능하되 최대 5명으로 묶고 다음 웨이브는 앞 웨이브 게이트 완료 뒤 시작한다. 파일 내 구간 분할도 공유 소유로 인정하지 않는다. 목록 밖 파일이 필요하면 멈추고 다음 웨이브로 이동하거나 PLAN의 소유권을 먼저 수정한다. 다른 작업자의 변경을 되돌리지 않는다. 추가 시험 파일도 소유 파일이다. 크기는 S=국소 경계, M=한 계층과 장애 시험, L=여러 경계 상태기계이며 L은 내용에 적힌 순서대로 내부 단계 게이트를 통과한다. 게이트 약어는 다음 절의 실제 명령 정의다.

### 웨이브 1 — 계약과 시험 격리

| 작업 이름 | 내용 | 고칠 파일(절대경로) | 의존 | 게이트 명령 | 크기 |
| --- | --- | --- | --- | --- | --- |
| W1-S 서버 계약 | MessagePage/DeliveryNotices/SyncCursor, 추가 상태 메타데이터와 v2 쓰기 receipt/revision, push 4종/그룹, archive 읽기 DTO를 확정. Runner optional inspect/repair/관측 식별·safe stop 및 Orchestrator 서비스 포트 계약만 추가. 현재 구현을 깨는 required 메서드나 가짜 성공 stub은 넣지 않고 실제 라우트 전환 때 required로 바꾼다. | /Users/yesung/iamceo/shared/types.ts<br>/Users/yesung/iamceo/shared/push.ts<br>/Users/yesung/iamceo/shared/operations.ts<br>/Users/yesung/iamceo/server/runner/types.ts<br>/Users/yesung/iamceo/server/orchestrator-api.ts<br>/Users/yesung/iamceo/server/service-contracts.ts | W0 | G-TS | M |
| W1-N Swift 계약 | 기존 Models/APIClient 호출을 보존한 optional DTO·별도 realtime/push 모델·서비스 protocol, ProjectPatch 이동, APIError.code·v2 결과 enum. unknown enum/누락은 안전한 표시. 네트워크 실구현은 W2. | /Users/yesung/iamceo/native/Sources/IAMCEO/Models/Models.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Models/RealtimeModels.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Models/PushModels.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Services/ServiceContracts.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/ContractTests.swift | W0 | G-SWIFT | M |
| W1-Q 격리 fixture | fail-closed 공통 fixture: 명시적 provider homes·가짜 실행파일·동적 비7878 포트·자기 소켓만. 가짜 core에 지연/응답 유실/역순/kill 관측과 호출 횟수 제공. Swift REST/WS factory가 실제 네트워크로 빠지지 않게 주입. 기존 실 herdr harness를 실행하지 않는 mock 회귀 토대. | /Users/yesung/iamceo/tests/fixtures/isolated-runtime.ts<br>/Users/yesung/iamceo/tests/fixtures/core-browser-harness.ts<br>/Users/yesung/iamceo/tests/isolation.test.ts<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/TestSupport.swift | W0 | G-TS; BT tests/isolation.test.ts | M |

### 웨이브 2 — 영속 스키마·증거 부품·전송 구현

| 작업 이름 | 내용 | 고칠 파일(절대경로) | 의존 | 게이트 명령 | 크기 |
| --- | --- | --- | --- | --- | --- |
| W2-D DB 단일 소유자 | 현재 MIGRATIONS 말미에 paging 인덱스, delivery recovery/dispatch/operation, member_context_state, 실행/생성/종료 journal·lease·receipt·도메인 revision/board 검토 revision·nextAttemptAt, push 표/120초 그룹을 순차 추가. 기존 window 열 재추가 금지. 미래 스키마를 WAL 설정/쓰기 전에 거부. 백업 실패 무변경·단계별 transaction 유지. | /Users/yesung/iamceo/server/db.ts<br>/Users/yesung/iamceo/tests/migrations.test.ts | W1-S,Q | G-TS; BT tests/migrations.test.ts | L |
| W2-E 증거·문맥 parser | delivery user-text 파서/정확한 표식·경로/세대·증분/부분행/4MiB 재개. 기존 Codex context parser를 재사용해 현재 usage/실측 창과 nonce 연결, compact boundary 관찰을 별도 모듈화. delivery 완전 탐색과 context tail 추정을 혼용하지 않는다. | /Users/yesung/iamceo/server/runner/delivery-evidence.ts<br>/Users/yesung/iamceo/server/runner/core-context.ts<br>/Users/yesung/iamceo/server/runner/codex-context.ts<br>/Users/yesung/iamceo/tests/delivery-evidence.test.ts<br>/Users/yesung/iamceo/tests/core-context-parser.test.ts | W1-S,Q; W0 parser 결과 | G-TS; BT tests/delivery-evidence.test.ts tests/core-context-parser.test.ts | L |
| W2-O 홈 소유권·config | 프로세스 수명과 결합한 홈 단위 OS 배타 잠금을 구현한다. macOS의 libc flock을 Bun 내장 FFI로 호출해 열린 FD 수명에 묶고, 프로세스 2개와 컴파일 산출물에서 배타성/자동 해제를 먼저 검증한다. 다른 포트/경로 별칭에서도 정규화한 같은 홈을 인식하며 PID 파일 삭제를 대체품으로 쓰지 않는다. config 임시0600→검증→fsync→rename→디렉터리 sync, 권한 교정·ENOSPC 분류. | /Users/yesung/iamceo/server/home-owner.ts<br>/Users/yesung/iamceo/server/config.ts<br>/Users/yesung/iamceo/server/storage-errors.ts<br>/Users/yesung/iamceo/tests/home-owner.test.ts<br>/Users/yesung/iamceo/tests/config-atomic.test.ts | W1-S,Q | G-TS; BT tests/home-owner.test.ts tests/config-atomic.test.ts | M |
| W2-N APIClient 구현 | message page/around/메시지 단건/archive snapshot/sync/push/v2 receipt 조회를 구현한다. Bearer·origin·redirect·timeout을 유지하고 optional If-Match와 코드 없는 WS URLRequest를 추가한다. 구형 서버 capability는 지정된 404만 판별한다. AppStore는 수정하지 않는다. | /Users/yesung/iamceo/native/Sources/IAMCEO/Services/APIClient.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/APIContractTests.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/NetworkTests.swift | W1-N,Q | G-SWIFT | M |
| W2-P APNs transport | 전용 config 권한/키 검사, ES256 P1363/JWT 20·50·60분 경계, 환경별 HTTP/2 연결, 고정 origin/headers/payload/TTL와 오류 분류. 외부 APNs 대신 주입 transport와 TLS HTTP/2 peer로 시험. | /Users/yesung/iamceo/server/push/config.ts<br>/Users/yesung/iamceo/server/push/apns.ts<br>/Users/yesung/iamceo/tests/apns.test.ts | W1-S,Q | G-TS; BT tests/apns.test.ts; G-COMPILE | L |

### 웨이브 3 — Store 기반·core 입력 장벽·독립 클라이언트 상태

| 작업 이름 | 내용 | 고칠 파일(절대경로) | 의존 | 게이트 명령 | 크기 |
| --- | --- | --- | --- | --- | --- |
| W3-S Store 영속 포트 | 원본+outbox intent transaction, operation receipt/CAS·revision·lease·journal·문맥 상태 저장 포트, commit 후 이벤트 큐를 구현. 중첩 transaction rollback은 bus/pump 0회. 전체 누락/미수신 조회, 메시지 단건/around/paging SQL, archive 읽기·rename validation/transaction. 서비스가 SQL/스키마를 중복 소유하지 않게 Store 포트를 사용한다. | /Users/yesung/iamceo/server/store.ts<br>/Users/yesung/iamceo/tests/core.test.ts<br>/Users/yesung/iamceo/tests/unified.test.ts<br>/Users/yesung/iamceo/tests/chat-paging.test.ts | W2-D | G-TS; BT tests/core.test.ts tests/unified.test.ts tests/chat-paging.test.ts | L |
| W3-R core 어댑터 | refresh 단일화/세대·turn 식별, 입력 mutex/epoch, inspect/repair/safe stop/read-only reattach, 쓰기 전후 실패 구분. 영속 lease/미해결 fence는 주입 포트로 복원. Claude wrapper 연결·Codex 단일 native binding·compact 제어 경로를 연결하고 일반 turn_end와 compact 결과 분리. 런타임 supervisor는 분리 모듈. | /Users/yesung/iamceo/server/runner/core.ts<br>/Users/yesung/iamceo/server/runner/core-client.ts<br>/Users/yesung/iamceo/server/runner/providers.ts<br>/Users/yesung/iamceo/server/core-supervisor.ts<br>/Users/yesung/iamceo/tests/core-runner.test.ts<br>/Users/yesung/iamceo/tests/core-supervisor.test.ts | W2-E; W1-S 포트(동일 웨이브 Store 구현 없이 fake로 검증) | G-TS; BT tests/core-runner.test.ts tests/core-supervisor.test.ts | L |
| W3-P PushStore·사건 | 전용 PushStore, 사건/episode recorder, report group 영속 마감·수신자 snapshot, token generation·기기 revision/해지/tombstone. recorder는 네트워크 없이 도메인 transaction 안에서 동기 실행. 아직 production 주입은 하지 않는다. | /Users/yesung/iamceo/server/push/store.ts<br>/Users/yesung/iamceo/server/push/events.ts<br>/Users/yesung/iamceo/tests/push-store.test.ts<br>/Users/yesung/iamceo/tests/push-events.test.ts | W2-D,P | G-TS; BT tests/push-store.test.ts tests/push-events.test.ts | L |
| W3-N history·초안 순수 상태 | ChatHistory tuple/overlay/journal/bridge·LRU, 호스트 namespace DraftStore, 영속 최초 attempt/완료 첨부/초안 revision·터미널 입력 revision. AppStore 통합 전 mock API로 상태 전이를 검증한다. | /Users/yesung/iamceo/native/Sources/IAMCEO/State/ChatHistory.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/State/DraftStore.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/State/SubmissionStore.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/ChatHistoryTests.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/DraftPersistenceTests.swift | W2-N | G-SWIFT | M |
| W3-O 백업·복원 부품 | 주기/보존 설정 기본: 하루 1회 성공 snapshot, 일간 7+주간4 보존, 겹친 작업 1개. SQLite 일관 사본+그 사본 참조 첨부+보호된 config manifest, 별도 경로 DB 검사·경로 재배치·해시 대조·복원 검증. p8은 패키지에 복사하지 않고 별도 보관 필요만 기록. 복원된 큐/푸시는 발신 금지 상태에서 먼저 조정한다. | /Users/yesung/iamceo/server/backup.ts<br>/Users/yesung/iamceo/server/restore.ts<br>/Users/yesung/iamceo/tests/backup-restore.test.ts | W2-D,O | G-TS; BT tests/backup-restore.test.ts | L |

### 웨이브 4 — 전달 엔진·실시간 서버·파일 실패 경계

| 작업 이름 | 내용 | 고칠 파일(절대경로) | 의존 | 게이트 명령 | 크기 |
| --- | --- | --- | --- | --- | --- |
| W4-D 전달 서비스 | recovery phase/CAS와 확인 예산을 구현한다. 확인 간격 1/3/10/30/60초, 재전송 backoff 2/10/30초와 최대 3회, 제출 복구 1회, unknown/stopped의 물리 입력 fence를 지킨다. source 변경/취소 보호, 전체 집계, 가상 옛 failed와 operation 멱등을 구현한다. Store 포트만 사용한다. | /Users/yesung/iamceo/server/delivery-recovery.ts<br>/Users/yesung/iamceo/tests/delivery-recovery.test.ts | W3-S,R | G-TS; BT tests/delivery-recovery.test.ts | L |
| W4-H HTTP 읽기·WS | Bus epoch/emit cursor, v1/v2 topic, `/api/sync` 동기 snapshot과 `/api/capabilities`, 일반/보관 page·archive state·message 단건·around 라우트. v2 t query 거부, v1 모양 유지, no-store·인증·query 검증·backpressure·비밀 query 로그 제거. archive GET은 runner/pump 0회. | /Users/yesung/iamceo/server/bus.ts<br>/Users/yesung/iamceo/server/http.ts<br>/Users/yesung/iamceo/tests/http.test.ts<br>/Users/yesung/iamceo/tests/realtime.test.ts<br>/Users/yesung/iamceo/tests/archive-read.test.ts | W3-S; W1-S | G-TS; BT tests/http.test.ts tests/realtime.test.ts tests/archive-read.test.ts | L |
| W4-F 파일 게시·정리 | 모든 file 입력 먼저 검증→작업별 staging→게시. 실패가 만든 미참조만 정리. 업로드/inbox/백업 사용량을 집계하고, 실패가 확정된 미게시 staging만 유예 7일·quarantine 24시간 뒤 참조를 재검사해 정리한다. 완료 attachment 행은 미전송 초안의 소유를 서버가 알 수 없으므로 전부 보호한다. 보관·미해결 delivery·살아 있는 inbox도 제외한다. 도구 receipt는 다음 웨이브에서 공유한다. | /Users/yesung/iamceo/server/files.ts<br>/Users/yesung/iamceo/server/storage-maintenance.ts<br>/Users/yesung/iamceo/server/agent-tools.ts<br>/Users/yesung/iamceo/tests/tools.test.ts<br>/Users/yesung/iamceo/tests/storage-maintenance.test.ts | W3-S,O | G-TS; BT tests/tools.test.ts tests/storage-maintenance.test.ts | M |
| W4-N WS·푸시 독립 서비스 | RealtimeClient actor의 단일 receive·취소·45초 watchdog과 transport 주입을 구현한다. PushSettingsStore/NotificationLink 및 iOS OS 등록·명시적 권한 요청·콜백 generation을 구현한다. AppStore 없이 주입 host context로 시험한다. | /Users/yesung/iamceo/native/Sources/IAMCEO/Services/RealtimeClient.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Services/PushNotificationService.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Services/NotificationAppDelegate.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Services/NotificationLink.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/State/PushSettingsStore.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/RealtimeTests.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/PushTests.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/NotificationLinkTests.swift | W2-N; W1-N | G-SWIFT | L |
| W4-P 발신 worker | 그룹 마감부터 outbox claim/30초 lease, 상태 재검사, HTTP2 결과·TTL·410 generation 경합을 구현한다. 쓰기 후 불명과 재시작 sending은 unknown으로 처리하고 재발신하지 않는다. shutdown은 10초 이내다. | /Users/yesung/iamceo/server/push/worker.ts<br>/Users/yesung/iamceo/tests/push-worker.test.ts | W3-P; W2-P | G-TS; BT tests/push-worker.test.ts | M |

### 웨이브 5 — 전달 통합·도메인 recorder·클라이언트 쓰기

| 작업 이름 | 내용 | 고칠 파일(절대경로) | 의존 | 게이트 명령 | 크기 |
| --- | --- | --- | --- | --- | --- |
| W5-O Orchestrator 전달 | send/urgent/첫지시/recover/settleInFlight/resend/onTurnUnread를 한 봉투·회복 경로로 통합. 받은 입력의 noOutput 재전송/결재 재열기 중단. 한 직원 fence, 다른 직원 진행. 생성한 원본과 outbox를 Store 원자 진입점으로 변경. | /Users/yesung/iamceo/server/orchestrator.ts<br>/Users/yesung/iamceo/tests/orchestrator.test.ts<br>/Users/yesung/iamceo/tests/regress.test.ts | W4-D; W3-S,R | G-TS; BT tests/orchestrator.test.ts tests/regress.test.ts tests/delivery-recovery.test.ts | L |
| W5-S Store recorder | production optional recorder 의존성과 도메인 쓰기를 최외곽 transaction으로 결합. ask/완료/확인된 승인/오류 전이·baseline·묶음 그룹 1회. lastError 남은 error→idle 중복 억제, 상태 메타와 blocked 집계 분리. | /Users/yesung/iamceo/server/store.ts<br>/Users/yesung/iamceo/tests/store-events.test.ts | W3-P,S | G-TS; BT tests/store-events.test.ts tests/push-events.test.ts | M |
| W5-H HTTP 새 쓰기 | recovery GET/POST·v2 operation 결과 조회·agent tool operationId/manual ACK와 terminal/설정/세션/todo 엄격 body·header schema, 기존 v1 호환. 실제 미지원 port는 501, 상태 불명은 code와 unknown을 보존. 다음 웨이브 서비스 연결 전 capability는 false. | /Users/yesung/iamceo/server/http.ts<br>/Users/yesung/iamceo/tests/operations-http.test.ts<br>/Users/yesung/iamceo/tests/delivery-http.test.ts | W4-H,D; W1-S | G-TS; BT tests/operations-http.test.ts tests/delivery-http.test.ts tests/http.test.ts | M |
| W5-N AppStore 쓰기 | 최초 attempt 접수 자동 조회/동일 ID 복원, host/업로드 generation, dirty settings CAS/충돌 보존, fresh/terminal operation 결과와 claim 회수를 연결한다. 카드별 batch accepted/conflict/unknown과 todo 결과 확인 중을 구분한다. canWrite·샘플·401·lease 보호를 유지한다. | /Users/yesung/iamceo/native/Sources/IAMCEO/State/AppStore.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/SubmissionTests.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/WriteConflictTests.swift | W3-N; W2-N | G-SWIFT | L |
| W5-R herdr 호환 어댑터 | W0 결과 위에서 inspect/repair·고유 표식·긴 글 봉투 보존을 연결한다. substring/working/조회 실패를 성공으로 간주하는 판정과 timeout 뒤 clear/retry를 제거한다. 제어 명령과 기존 compact·병렬 동작은 유지한다. 실제 herdr를 띄우지 않는 fake RPC/화면 회귀를 작성한다. | /Users/yesung/iamceo/server/runner/herdr.ts<br>/Users/yesung/iamceo/server/runner/herdr-client.ts<br>/Users/yesung/iamceo/tests/herdr-contract.test.ts | W4-D; W2-E; W0 | G-TS; BT tests/herdr-contract.test.ts tests/context.test.ts tests/headless.test.ts | L |

### 웨이브 6 — 생명주기·조작·설정·알림 API

| 작업 이름 | 내용 | 고칠 파일(절대경로) | 의존 | 게이트 명령 | 크기 |
| --- | --- | --- | --- | --- | --- |
| W6-O Orchestrator 생명주기 | 생성 의도/starting_unknown·라벨 재결합, 종료 journal/실제 stop 확인, error 결과와 중단 사건/초기 종료 진단, 큐 없는 재결합/소유 core supervisor를 연결한다. lease 복원 후 pump한다. fresh/config/terminal receipt와 unknown 재생 금지, 업무에 연결된 정체 재관측을 구현한다. | /Users/yesung/iamceo/server/orchestrator.ts<br>/Users/yesung/iamceo/server/orchestrator-api.ts<br>/Users/yesung/iamceo/tests/lifecycle-recovery.test.ts<br>/Users/yesung/iamceo/tests/server-runtime.test.ts | W5-O,S,R; W3-R | G-TS; BT tests/lifecycle-recovery.test.ts tests/server-runtime.test.ts tests/core-runner.test.ts | L |
| W6-P Push API | 전용 route handler의 strict 8KiB body, status/devices/PUT/PATCH/DELETE/test/target, revision/token 세대/해지·멱등/분당 제한을 구현한다. HTTP 주입부 한 곳에서 mount한다. | /Users/yesung/iamceo/server/push/routes.ts<br>/Users/yesung/iamceo/server/http.ts<br>/Users/yesung/iamceo/tests/push-http.test.ts | W5-S,H; W4-P | G-TS; BT tests/push-http.test.ts tests/http.test.ts | M |
| W6-N AppStore history·전달 | 별도 history 캐시와 동일 범위 single flight, prepend/POST overlay·bridge를 연결한다. delivery 집계/상세/operation/202 후 재조회를 제공하고 확인 중은 홈 개입에서 제외한다. paging 404 판별, archive 읽기 상태와 쓰기 금지를 연결한다. | /Users/yesung/iamceo/native/Sources/IAMCEO/State/AppStore.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/HistoryIntegrationTests.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/DeliveryNoticeTests.swift | W5-N; W4-H; W5-O | G-SWIFT | L |
| W6-Ops 운영·CLI 연결 | DB 전 홈 lock, PushStore→Store→HTTP→worker 주입과 실패 시 lock 해제를 연결한다. backup/restore 명령·주기·storage sweep, lease/receipt 조정 후 큐 재개, 총 15초 shutdown을 구현한다. CLI 등록/업데이트의 인증 readiness/build ID 대조·실패 표시를 추가한다. 로그는 전용 bounded writer로 전달하고 열린 FD 회전을 검증한다. launchctl은 mock만 사용한다. | /Users/yesung/iamceo/bin/iamceo.ts<br>/Users/yesung/iamceo/server/log-writer.ts<br>/Users/yesung/iamceo/install.sh<br>/Users/yesung/iamceo/tests/cli.test.ts<br>/Users/yesung/iamceo/tests/ops-runtime.test.ts<br>/Users/yesung/iamceo/tests/log-writer.test.ts | W5-S,H; W4-P,F; W3-O; W2-O | G-TS; BT tests/cli.test.ts tests/ops-runtime.test.ts tests/log-writer.test.ts; G-COMPILE | L |

### 웨이브 7 — 업무 흐름·실시간 coordinator·원격 접근 복구

| 작업 이름 | 내용 | 고칠 파일(절대경로) | 의존 | 게이트 명령 | 크기 |
| --- | --- | --- | --- | --- | --- |
| W7-O Orchestrator 업무 | core 자동 턴 슬롯을 await 전에 예약하고 종료별 반환/재시작 재구성을 구현한다. 영속 nextAttemptAt과 증명 가능한 범위의 공유 대기를 지킨다. todo 전송 중 취소 보상, 결재 닫기와 명시 후속, 보고 참조/정정 관계, 검토한 board revision, 필수 보고 누락 검출을 연결한다. manual batch 재조회/ack·50건 밖 답·전체 orphan을 수선한다. | /Users/yesung/iamceo/server/orchestrator.ts<br>/Users/yesung/iamceo/tests/flow-recovery.test.ts<br>/Users/yesung/iamceo/tests/board.test.ts<br>/Users/yesung/iamceo/tests/admission.test.ts<br>/Users/yesung/iamceo/tests/manual-inbox.test.ts | W6-O; W5-S | G-TS; BT tests/flow-recovery.test.ts tests/board.test.ts tests/admission.test.ts tests/manual-inbox.test.ts | L |
| W7-M MCP 계약 | bridge가 전송 전에 operationId를 만들고 같은 ID의 재요청만 receipt로 합친다. 새 호출의 같은 본문을 합치지 않는다. manual wait batch ACK, 결재 후속 명시 도구, 보고 참조 조회를 연결한다. root/conductor/worker의 core post 계약과 미보고 예외를 갱신한다. | /Users/yesung/iamceo/bin/mcp-bridge.ts<br>/Users/yesung/iamceo/server/agent-tools.ts<br>/Users/yesung/iamceo/server/roles/root.md<br>/Users/yesung/iamceo/server/roles/conductor.md<br>/Users/yesung/iamceo/server/roles/worker.md<br>/Users/yesung/iamceo/tests/bridge.test.ts<br>/Users/yesung/iamceo/tests/agent-operation.test.ts | W6-O; W1-S의 고정 업무 포트를 fake로 사용 | G-TS; BT tests/bridge.test.ts tests/agent-operation.test.ts tests/tools.test.ts | M |
| W7-N AppStore 실시간 | 단일 coordinator의 foreground/socket/project/request 세대, 250ms 묶음·최대 초당 2회·dirty 보존, snapshot cursor/gap/epoch와 fallback/backoff를 연결한다. history/활동/진단별 갱신과 쓰기 뒤 refresh를 합치고 live의 주기 폴링을 제거한다. | /Users/yesung/iamceo/native/Sources/IAMCEO/State/AppStore.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/RealtimeNetworkTests.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/ConnectionLossTests.swift | W6-N; W4-N,H | G-SWIFT | L |
| W7-H 접속·진단 | 명시적 보조 host 재bind/실패 표시, 기존 liveness와 인증 readiness/build/schema/core 관측을 분리한다. 로컬 CLI와 loopback+Bearer 전용 POST /api/auth/rotate로 config 원자 저장 뒤 실행 중 인증을 교체하고 기존 WS/pairing을 무효화한다. 새 코드는 응답/명시적 로컬 표시 외에 로그로 남기지 않는다. pairing 응답 유실은 새 QR 안내로 처리한다. | /Users/yesung/iamceo/server/http.ts<br>/Users/yesung/iamceo/server/pairing.ts<br>/Users/yesung/iamceo/bin/iamceo.ts<br>/Users/yesung/iamceo/tests/auth-rotation.test.ts<br>/Users/yesung/iamceo/tests/pairing.test.ts<br>/Users/yesung/iamceo/tests/host-bind.test.ts<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Services/Pairing.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Services/LocalHostService.swift | W6-Ops,P; W2-O | G-TS; BT tests/auth-rotation.test.ts tests/pairing.test.ts tests/host-bind.test.ts; G-SWIFT | M |

### 웨이브 8 — 보관·압축 최종 통합·앱 탐색 기반

| 작업 이름 | 내용 | 고칠 파일(절대경로) | 의존 | 게이트 명령 | 크기 |
| --- | --- | --- | --- | --- | --- |
| W8-O Orchestrator 보관·압축 | 단일 patchProject/프로젝트 장벽, 전원 safe stop 사전/최종 검사, 부분 종료 실패 보존/journal 재시작 복구를 연결한다. 보관 중 start는 0회, 꺼내기는 archived-held만 재검사한다. core fresh exact+실제 wake+다음 업무 전 자동 compact, 수동 예약/완료 barrier/uncertain fence/CLI 내장 압축 중복 방지를 연결한다. | /Users/yesung/iamceo/server/orchestrator.ts<br>/Users/yesung/iamceo/server/orchestrator-api.ts<br>/Users/yesung/iamceo/tests/archive-gate.test.ts<br>/Users/yesung/iamceo/tests/core-context.test.ts | W7-O; W3-R; W6-O | G-TS; BT tests/archive-gate.test.ts tests/core-context.test.ts tests/server-runtime.test.ts | L |
| W8-N AppStore 관리·탐색 | 보관함/프로젝트 관리 공통 pending과 결과 불명 재조회, context 조작, push 연결/전경/로그아웃 훅, serverId 매핑/해지 미완료를 연결한다. Router project reset 뒤 pending route를 한 번 적용한다. cold start/다중 창/around anchor와 archive 읽기 권한을 연결한다. | /Users/yesung/iamceo/native/Sources/IAMCEO/State/AppStore.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/State/Router.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/ProjectManageTests.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/NotificationNavigationTests.swift | W7-N,H; W6-P; W4-N | G-SWIFT | L |
| W8-V 공통 표시·스크롤 | W0 glass 결과를 유지하면서 Presentation에 lastObserved/error/unknown/subagents/마지막 보고/delivery summary만 확장한다. DeliveryNotice 공통 패널과 public NS/UIScrollView probe prototype을 구현하고 부분 anchor 2pt를 검증한다. AppStore는 직접 수정하지 않는다. | /Users/yesung/iamceo/native/Sources/IAMCEO/Design/Presentation.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Views/DeliveryNoticeView.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Views/ChatScrollAnchor.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/PresentationTests.swift<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/ChatAnchorTests.swift | W7-N; W0; W1-N | G-SWIFT; G-XCODE; 수동 anchor prototype | M |

### 웨이브 9 — HTTP 최종 연결·네이티브 화면(공유 상태 파일 편집 금지)

| 작업 이름 | 내용 | 고칠 파일(절대경로) | 의존 | 게이트 명령 | 크기 |
| --- | --- | --- | --- | --- | --- |
| W9-R 최종 HTTP 연결 | 기존 프로젝트 PATCH를 필수 orch.patchProject로 위임하고 옛 직접 hook 중복을 막는다. v2 쓰기/manual ACK/recovery/진단의 실제 capability를 활성화하고 v1 exact JSON·인증·보관 gate를 회귀 검증한다. | /Users/yesung/iamceo/server/http.ts<br>/Users/yesung/iamceo/tests/api-compatibility.test.ts | W8-O; W7-M,H | G-TS; BT tests/api-compatibility.test.ts tests/http.test.ts tests/operations-http.test.ts | M |
| W9-S shell·설정·iOS등록 | Mac 사이드바/iOS 전환기에 보관함·이름·보관·꺼내기, 공통 관리 sheet와 archive 읽기 탐색을 연결한다. 설정 dirty 충돌/push 4종 UI/연결 상태, aggregate lifecycle·sleep/wake·delegate를 연결한다. iOS entitlement/Info 환경/서명 capability와 Mac URL scheme을 선언한다. | /Users/yesung/iamceo/native/Sources/IAMCEO/Views/AppShell.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Views/SettingsView.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Views/ProjectManageView.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Views/ArchiveView.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Views/PushSettingsView.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/IAMCEOApp.swift<br>/Users/yesung/iamceo/native/project.yml<br>/Users/yesung/iamceo/native/Configuration/iOS.entitlements | W8-N,V; W8-O | G-SWIFT; G-XCODE; Mac/iOS 관리 QA | L |
| W9-C 대화·첨부 | ChatHistory를 렌더하고 100개 paging/버튼/사용자 의도 sentinel/anchor/새 글 수/bridge 계속/보관 읽기/알림 anchor를 연결한다. Composer의 늦은 업로드 namespace·삭제 generation을 검사하고 불명 attempt, revision별 초안 소비, 첨부 누락 방지를 표시한다. | /Users/yesung/iamceo/native/Sources/IAMCEO/Views/ChatView.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Views/ComposerBar.swift | W8-N,V | G-SWIFT; G-XCODE; Mac/iOS scroll·편집 QA | M |
| W9-T 팀·터미널·명패 | 상태 근거/문맥 출처·압축 예약, 전달 상세/receipt/fresh/config 충돌, 직접 입력 unknown과 후속 편집 보존을 연결한다. Office는 명패/help/VoiceOver에서 needsOwner만 표시하며 Office 하위 자산은 수정하지 않는다. | /Users/yesung/iamceo/native/Sources/IAMCEO/Views/TeamView.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Views/TerminalView.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Views/OfficeView.swift | W8-N,V | G-SWIFT; G-XCODE; Mac/iOS 팀·lease QA | M |
| W9-H 홈·결재 | 자동 확인 중 개입 수는 0으로 두고 needsOwner만 담당자별로 합치며 미배정을 분리한다. 오류·확인된 승인·상태 unknown을 구분한다. 자기 요청이 수락된 카드 메모만 소비하고 타 기기 충돌 메모를 보존한다. todo 확인 중과 오래된 revision 거부를 표시한다. | /Users/yesung/iamceo/native/Sources/IAMCEO/Views/HomeView.swift<br>/Users/yesung/iamceo/native/Sources/IAMCEO/Views/InboxView.swift | W8-N,V | G-SWIFT; G-XCODE; Mac/iOS 동시 결재 QA | M |

### 웨이브 10 — 통합 회귀·운영 문서·격리 core 인수

| 작업 이름 | 내용 | 고칠 파일(절대경로) | 의존 | 게이트 명령 | 크기 |
| --- | --- | --- | --- | --- | --- |
| W10-Q 통합 장애시험 | 아래 출시 전 시나리오를 가짜 core+HTTP+Swift 통합으로 재현한다. 웹 코드를 수정하지 않고 옛 API fixture와 기존 web-lib/runtime 회귀를 실행한다. Bun source/compile HTTP2를 모두 시험한다. 기능 파일 결함은 소유자를 정한 별도 후속 웨이브로 재발주한다. | /Users/yesung/iamceo/tests/core-release.test.ts<br>/Users/yesung/iamceo/tests/push-compiled.test.ts<br>/Users/yesung/iamceo/native/Tests/IAMCEOTests/ReleaseScenarioTests.swift | W9 전체 | G-TS; G-REGRESSION; G-SWIFT; G-XCODE; G-COMPILE | L |
| W10-D 문서 | 최종 API/strict v2·v1 잔여 제약/보관 읽기/증거 복구/푸시 4종 120초/실시간/백업 복원/코드 회전/라이브 herdr 유지 절차를 문서화한다. 과거 handoff의 날짜 기록을 새 완료 사실로 덮지 않는다. | /Users/yesung/iamceo/docs/spec.md<br>/Users/yesung/iamceo/docs/architecture.md<br>/Users/yesung/iamceo/docs/operating-model.md<br>/Users/yesung/iamceo/native/README.md | W9 전체 | 문서의 명령/응답을 W10-Q 결과와 대조 | M |

### 웨이브 11 — 제품 소유자 격리 인수

| 작업 이름 | 내용 | 고칠 파일(절대경로) | 의존 | 게이트 명령 | 크기 |
| --- | --- | --- | --- | --- | --- |
| W11-A 제품소유자 인수 | 전체 구현 뒤 쓰고 버릴 프로젝트에서 전용 core/state/socket, 실제 Claude/Codex 증거 형식·압축·복구와 실기기 APNs/Tailscale를 검증한다. 가짜 RPC와 실제 바이너리 결과를 분리한다. 기존 업무 이전은 포함하지 않는다. | 없음(격리 환경 인수; 레포 파일 소유 없음) | W10-Q,D; 키·서명·기기 준비 | 출시 전 검증 전 항목·소유자 실기기 인수 | L |

각 웨이브에서 `shared/types.ts`, `server/db.ts`, `server/store.ts`, `server/http.ts`, `server/orchestrator.ts`, `AppStore.swift`, `APIClient.swift`, `Models.swift`의 소유자는 위 표에 있는 **한 행뿐**이다. 같은 파일은 다음 웨이브에서만 다른 작업으로 넘긴다. 신규 독립 서비스가 큰 파일을 직접 고치지 않게 W1 포트를 사용하고, 마지막 연결은 해당 공유 파일 소유자가 수행한다.

## 게이트

### 실제 레포에서 확인한 설정

- `package.json`: `typecheck=tsc --noEmit`, `test=bun test tests`, `build=bun build bin/iamceo.ts --compile --outfile dist/iamceo`, `native:build/native:test=swift ... --package-path native`. `tsconfig.json`은 루트 `.`이며 shared/server/bin/web/src/tests/scripts 포함, strict/noEmit다. 별도 서버 tsconfig를 가정하지 않는다.
- 확인된 실행 도구: Bun 1.3.14, TypeScript 5.9.3. lockfile은 Zod 4.6.7, MCP SDK 1.32.2, React 19.3.1. Swift tools 6.0, macOS14/iOS17, XcodeGen schemes `IAMCEO-macOS`, `IAMCEO-iOS`. core pin은 0.1.18이다. 새 패키지/버전 업그레이드를 이번 기능과 섞지 않는다.
- `tests/herdr.test.ts`의 뒤쪽 beforeAll은 실제 `herdr --session`과 사용자 홈 `.config/herdr/sessions/...`를 사용한다. **공통 게이트에서 실행 금지.** `bun test tests`/무인 전체시험도 금지한다. `tests/browser.test.ts`는 별도 자식 Bun을 쓰지만 fixture 검토 없이 안전을 보장하지 않으므로 기본 게이트에서 제외한다. 이번 계획의 herdr 회귀는 `tests/herdr-contract.test.ts` fake RPC다. 실제 herdr 보호는 기존 동작을 읽고 mock으로 검증하며 라이브에 접속하지 않는다.

### 명령 정의

다음은 후속 구현자가 한 셸에서 사용할 명령이다. 이번 계획 작성에서 테스트/빌드 산출물을 만들기 위해 실행하는 명령이 아니다. fixture는 이 환경과 별개로 자신이 연 포트·소켓·프로세스임을 검증해야 한다.

```sh
cd /Users/yesung/iamceo
QA_ROOT=$(mktemp -d /private/tmp/iamceo-qa.XXXXXX)
mkdir -p "$QA_ROOT/iamceo" "$QA_ROOT/claude" "$QA_ROOT/codex" "$QA_ROOT/core-state" "$QA_ROOT/core-config" "$QA_ROOT/work"

# G-TS: 로컬 고정 tsc 사용, 패키지 다운로드/증분 파일 생성 없음
./node_modules/.bin/tsc --noEmit --incremental false -p .

# BT <명시적인 시험 파일...>: 표의 BT를 이 함수로 실행
BT() {
  env -u HC_SOCKET -u HC_SESSION -u HERDR_SOCKET_PATH \
    -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CODEX_HOME -u CLAUDE_CONFIG_DIR \
    IAMCEO_TEST=1 IAMCEO_PORT=0 IAMCEO_HOME="$QA_ROOT/iamceo" \
    IAMCEO_HERDR_SOCKET="$QA_ROOT/no-herdr.sock" \
    IAMCEO_CORE_SOCKET="$QA_ROOT/no-core.sock" \
    IAMCEO_CORE_BIN=/usr/bin/false IAMCEO_CLAUDE_BIN=/usr/bin/false IAMCEO_CODEX_BIN=/usr/bin/false \
    bun test "$@"
}

# G-SWIFT: 같은 게이트 안에서는 순차 실행. cache/scratch는 레포 밖
env CLANG_MODULE_CACHE_PATH="$QA_ROOT/clang" SWIFTPM_MODULECACHE_OVERRIDE="$QA_ROOT/swift-module" \
  swift build --package-path /Users/yesung/iamceo/native \
    --scratch-path "$QA_ROOT/swift-build" --cache-path "$QA_ROOT/swift-cache" \
    --config-path "$QA_ROOT/swift-config" --security-path "$QA_ROOT/swift-security"
env CLANG_MODULE_CACHE_PATH="$QA_ROOT/clang" SWIFTPM_MODULECACHE_OVERRIDE="$QA_ROOT/swift-module" \
  swift test --package-path /Users/yesung/iamceo/native \
    --scratch-path "$QA_ROOT/swift-build" --cache-path "$QA_ROOT/swift-cache" \
    --config-path "$QA_ROOT/swift-config" --security-path "$QA_ROOT/swift-security"

# G-XCODE: 복사본에서 XcodeGen/Info 생성. 원래 Configuration/생성 project는 변경하지 않음
mkdir -p "$QA_ROOT/native"
cp -R native/Sources native/Configuration native/project.yml "$QA_ROOT/native/"
xcodegen generate --spec "$QA_ROOT/native/project.yml" --project "$QA_ROOT/native"
xcodebuild -project "$QA_ROOT/native/IAMCEO.xcodeproj" -scheme IAMCEO-macOS \
  -configuration Debug -derivedDataPath "$QA_ROOT/DerivedData-mac" CODE_SIGNING_ALLOWED=NO build
xcodebuild -project "$QA_ROOT/native/IAMCEO.xcodeproj" -scheme IAMCEO-iOS \
  -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$QA_ROOT/DerivedData-ios" CODE_SIGNING_ALLOWED=NO build

# G-COMPILE: serve를 실행하지 않음. 기동 시험은 fixture 소유 port0/소켓만 사용
bun build bin/iamceo.ts --compile --outfile "$QA_ROOT/iamceo-bin"
```

G-XCODE 반복 실행은 새 QA_ROOT 또는 `native` 복사본이 없는 워커별 임시 루트를 쓴다. G-COMPILE의 W2 시점은 컴파일만 확인하고 HTTP2 compiled 인수는 W10의 `push-compiled.test.ts`가 수행한다. 모든 게이트는 자기 자식만 종료하고 증거를 확인한 후 자기 임시 루트만 정리한다. 실패 시 원인을 숨기는 `|| true`, 통째로 재시도해서 초록 만들기는 사용하지 않는다.

**G-REGRESSION**은 W10에서 다음을 순서대로 실행한다. 새 파일이 아직 없는 앞 웨이브에 이 명령을 사용하지 않는다.

```sh
BT tests/isolation.test.ts tests/migrations.test.ts tests/core.test.ts tests/unified.test.ts tests/chat-paging.test.ts tests/archive-read.test.ts
BT tests/delivery-evidence.test.ts tests/delivery-recovery.test.ts tests/delivery-http.test.ts tests/herdr-contract.test.ts
BT tests/core-runner.test.ts tests/core-supervisor.test.ts tests/core-context-parser.test.ts tests/core-context.test.ts tests/lifecycle-recovery.test.ts
BT tests/orchestrator.test.ts tests/regress.test.ts tests/server-runtime.test.ts tests/archive-gate.test.ts tests/flow-recovery.test.ts tests/board.test.ts tests/admission.test.ts tests/manual-inbox.test.ts
BT tests/http.test.ts tests/api-compatibility.test.ts tests/operations-http.test.ts tests/realtime.test.ts tests/auth-rotation.test.ts tests/pairing.test.ts tests/host-bind.test.ts
BT tests/context.test.ts tests/headless.test.ts tests/tools.test.ts tests/bridge.test.ts tests/agent-operation.test.ts tests/web-lib.test.ts tests/web-runtime.test.ts
BT tests/push-store.test.ts tests/push-events.test.ts tests/push-http.test.ts tests/apns.test.ts tests/push-worker.test.ts tests/push-compiled.test.ts
BT tests/home-owner.test.ts tests/config-atomic.test.ts tests/backup-restore.test.ts tests/storage-maintenance.test.ts tests/cli.test.ts tests/ops-runtime.test.ts tests/log-writer.test.ts tests/core-release.test.ts
```

W1-Q와 각 시험 소유자는 위의 **기존 시험도** import/자식 환경/파일 접근을 점검한다. fixture 밖 provider home이 읽힐 수 있으면 가짜 홈을 options로 명시하는 수정부터 해당 시험 소유 웨이브에 넣고 실행한다. `IAMCEO_TEST=1` 하나가 격리 보증은 아니다. 부모 `HOME`/`CODEX_HOME`을 임시 디렉터리로 바꾸지 않고 collector의 claudeHome/codexHome/contextHome 및 자식 allowlist를 주입한다. 인수가 빠지면 테스트가 실패해야 한다. `localhost:7878`인 기존 Swift URLProtocol fixture는 W2-N에서 비라이브 포트/전부가로채기로 바꾼다. `.tmp`·사용자 Keychain/UserDefaults를 기본 시험 저장소로 사용하지 않는다.

서버 integration은 loopback port0, 실제 할당 7878이면 중단 후 재할당, core RPC는 짧은 임시 Unix socket·가짜 CLI만 사용한다. Swift integration에는 그 fixture 주소만 넘긴다. APNs는 테스트 EC 키와 해당 연결에만 신뢰하는 CA를 사용하고 TLS 전역 우회는 없다. `build:native`/`setup:core`/install/service kickstart는 테스트 게이트에서 호출하지 않는다. 테스트 불통과·장치 미검증·실제로 실행하지 않은 항목은 분리해서 보고한다.

## 소유자 할 일과 시점

| 시점 | 소유자가 할 일 | 구현을 기다릴 필요/완료 증거 |
| --- | --- | --- |
| W1 직전 | Claude 문맥 창/유리 작업 완료와 최종 변경 파일·export를 전달한다. | 워커가 그 결과 위에서 시작한다. 별도 재승인보다 선행 결과 수령이 조건이다. |
| W2~W4 병행 준비 | Apple Developer/Xcode 계정 로그인, Team ID/App ID `com.iamceo.native.ios` 소유/Push capability, 환경/topic에 맞는 APNs `.p8`·Key ID 준비. 이미 가입했다고 가정하고 재가입을 요구하지 않는다. | 키는 레포/채팅/앱 번들에 넣지 않는다. 모의 HTTP2/서버/Swift 구현은 키 없이 진행 가능하다. |
| W9 이후 | iPhone Developer Mode·신뢰·개발 서명, 최종 entitlement/Info의 development→sandbox, production→production 일치 확인. TestFlight도 production 시험. | Xcode 로그인/서명 성공을 가정하지 않는다. simulator 성공으로 실기기를 대체하지 않는다. |
| W11-A 준비 | 별도 개발 호스트와 쓰고 버릴 프로젝트/cwd/core state·config·socket, 테스트 tailnet·Wi-Fi/셀룰러를 준비한다. 원래 CLI 로그인 환경을 써야 하는 시험은 전용 테스트 계정/환경으로 제한한다. | 실제 모델 실행은 이 단계에서만 한다. 라이브 업무·라이브 herdr와 경로/프로세스가 다름을 먼저 확인한다. |
| 격리 APNs 인수 | 개발 호스트의 비밀 폴더0700/p80600/apns.json0600 설정, 별도 테스트 데몬에만 적용, OS opt-in/시험 알림/4종·120초 그룹 확인. | APNs200, 기기 배너, 탭 목적지를 각각 확인한다. production 키까지 없으면 sandbox만 통과로 기록한다. |
| 전체 인수·안정화 뒤 | 기존 작업을 core로 옮길 시점과 라이브 데몬 재시작/마이그레이션/설정 적용을 승인한다. | 검증된 DB+첨부 백업/복원 리허설, 현재 작업·세션/미해결 전달 목록, 실제 버전·롤백 조건을 제시한 뒤 승인받는다. 계획 작성이나 품앗이 구현만으로 라이브 재시작 권한은 생기지 않는다. |
| core 이전 실행 시 | 새 작업부터 점진적으로 옮기고 기존 herdr 작업은 자연 종료/명시 인계를 사용한다. | 세션을 자동 일괄변환하지 않는다. 라이브 실행기는 안정화 전까지 herdr 그대로다. |

호스트 자체 사망을 백그라운드에서도 통보받는 외부 서비스와 기기별 API 인증 철회는 이번 완료의 소유자 준비 사항이 아니다. 필요하면 관측자/인증 이행을 별도 제품 과제로 정한다.

## 출시 전 검증

아래 전체 구현 뒤 가짜 테스트 프로젝트로 **core의 전체 제품 흐름**을 검증한다. 1차는 가짜 RPC/가짜 CLI로 결정적으로 재현하고, 2차 W11-A는 별도 실제 core+공식 Claude/Codex에서 프로토콜 의미를 검증한다. 실제 장애 주입 대상은 테스트 데몬·테스트 core·그 테스트 세션뿐이다. 증거가 없는 지원 조합은 완료로 표시하지 않는다.

| 시나리오/장애 주입 | 합격 조건 |
| --- | --- |
| 프로젝트 생성→Claude/Codex 총괄→팀장 병렬 배정→status/ask→대표 답→post/file→업무판→명시 완료 | 원본·자료·수신자 연결을 유지한다. 접수/전달/턴 종료/업무 완료를 구분하며 총괄과 질문자에게 중복 지시가 없다. |
| 원본 저장 직후/intent commit 직후/외부 쓰기 전후/수신 뒤 DB 갱신 전 테스트 데몬 강제 종료 | 원본과 intent가 함께 있거나 둘 다 없다. 전체 DB 수선으로 500건 밖 원본도 검출한다. 표식 발견은 send 0회로 정정하고 불명은 fence를 유지한다. |
| 로그에는 수신했으나 DB failed/held, 묶음 일부 수신, assistant/tool_result·다른 session의 표식 | 올바른 주 세션 user 증거만 해당 delivery를 정정한다. 미해결 항목의 fence는 유지한다. 거짓 긍정·중복 활동은 0건이다. |
| 쓰기 전 연결 실패, 완전 일치 미제출 composer, 일부/사용자 수정/축약 입력, 늦은 원래 쓰기 | 확정 쓰기 전 거절은 같은 ID·표식으로 일반 안전검사를 다시 받고, 연속 5회면 입력 상태 확인을 위한 보류로 남긴다. 불확실 쓰기는 기존 증거·settled 장벽과 최대 3회 복구 상한을 유지한다. settled+전체 일치에서만 Enter 1회, 본문 재입력 0회다. 원래 RPC가 미종료이면 입력하지 않는다. 재전송 직전 수신 발견은 send 0회다. |
| lease/승인/working/외부 attach 경합과 같은 직원 urgent | 자동 입력 0회, lease 중 기록 scan 0회다. 대기 시간은 활성 확인 2분 예산에서 제외한다. 다른 직원은 진행하며 duplicate_draft는 delivered 정정과 별도 fence를 유지한다. |
| start 응답 유실·pane 저장 전 crash·동일 label 복수 후보 | 같은 member/operation을 보존하고 추가 terminal.run 없이 재결합한다. 유효 후보가 여럿이면 증거·추천과 함께 격리하고 임의 kill/선택을 하지 않는다. |
| 최초 core bind 실패→큐 0→지연 복귀, 소유 core 부재·hello timeout·소유권 변경 | 큐 없이 관측이 복원된다. 확실한 소유 core 부재만 단일 기동 재시도를 한다. timeout/충돌만으로 kill/new CLI를 호출하지 않는다. |
| 정상 ACK started:false와 같은 turn idle 유지, working 장기 무출력, error→idle, 역순 조회 | 시작 정체는 자동 재관측·표시하되 시간만으로 send/Enter/interrupt하지 않는다. 정상 긴 작업과 오류 결과를 보존한다. turn 9→8 퇴행과 turn 9 종료 중복이 없다. |
| 확정 terminal 종료/초기 resume 실패·서버 부재 중 완료 | 실행/전달 ID·exit_code·원인과 중단 사건을 한 번 남긴다. 종료·보고 근거가 있으면 중단으로 오판하지 않는다. native ID 미상 Codex의 gone→wake에서 새 세션을 자동 생성하지 않는다. |
| sleep/close/archive stop 거부·응답 유실·두 번째 직원 종료 실패·단계 사이 crash | 종료 확인 전에 asleep을 확정하지 않고 closing은 해제한다. 재시작 후 종료 의도를 복구한다. 확정 종료 직원은 세션을 보존하며 실패 직원 참조/격리와 프로젝트 미반영 상태를 유지한다. |
| 5분 lease 중 테스트 데몬 재시작/최초 claim 응답 유실/직접 Enter 응답 유실 | 남은 lease를 복원한 뒤 자동 send는 0회다. 같은 claim ID로 회수한다. 결과 불명 입력은 영속 unknown이며 재생하지 않고 후속 편집도 보존한다. |
| core 직원 5명·상한 2, 슬롯 경합·재시작·상한 낮추기·due 전 재시도 | 자동 활성 턴은 2개 이하이며 기존 실행부터 집계한다. 슬롯 이중 반환과 due 전 send는 없다. 상한 감소로 진행 CLI를 죽이지 않고 내부 서브에이전트까지 통제한다고 표시하지 않는다. |
| 도구 응답 유실과 동일 operation 재조회/새 operation 같은 본문, todo 전송 중 취소 | 같은 operation의 효과는 1회, 새 operation은 독립이다. 전송 결과 확정 뒤 최신 todo 정정은 1회다. 후속 불필요 종료는 가능하고 필요한 후속은 outbox로 보존한다. |
| 보고 자료 여러 개/보고 없는 정상 턴/질문·위임 대기·무변경 정리/정리 중 board 변경 | 모든 자료 ID·원본·정정 관계가 전달된다. 필요한 보고만 1회 보완하고 업무를 재실행하지 않는다. 정상 예외를 누락으로 세지 않으며 새 revision을 다음 정리 대상으로 남긴다. |
| manual wait 응답/ACK 유실, askWait와 wait 동시 소비, 다른 카드 51개 뒤 옛 답 | 동일 batch를 재조회하고 한 번 ACK한다. 중복 소비 없이 옛 미수신 답을 회수하며 보관 중 wait는 소비하지 않는다. |
| 같은 시각 1,205개·Unicode ID·경계 행 삭제·최근 200개 밖 대상 기록·잘못된 cursor | 최초 200+이전 100 단위 순회가 SQL 전체 순서와 일치하며 누락·중복·프로젝트 이탈이 없다. 인덱스 seek와 구형 Message[]/state 200·rowid 순서를 확인한다. |
| prepend 대기 중 추가 스크롤+새 tail+delivery 수정+이미지/키보드/회전 | 적용 직전 첫 가시 메시지의 부분 위치 차이는 안정 레이아웃에서 2pt 이내다. prepend/update는 unread를 늘리지 않는다. Mac/iOS 실제 화면·VoiceOver·큰 글자·Reduce Motion을 확인한다. |
| 700개 재연결 gap·3페이지 뒤 오류·저장소 교체 | 연결 완료 전 기존 화면을 유지하고 계속/재시도를 제공한다. 불연속 구간을 임의로 합치지 않으며 기존 페이지·커서·초안을 보존한다. |
| 두 기기 설정·묶음 결재·todo 경합, 호스트 A/B 같은 hq, 업로드 중 이탈, 앱 재시작 | dirty 필드만 저장하고 오래된 revision은 409다. 자기 수락 카드의 메모만 소비한다. todo 불명은 조회하며 namespace 혼합·늦은 콜백의 초안 부활·같은 최초 ID의 추가 메시지는 없다. |
| WS gap/중복/heartbeat 앞섬·epoch 교체·옛 snapshot 후착·flapping·403/401 | 최신 snapshot으로 수렴하고 다른 세대는 적용하지 않는다. WS만 실패하면 REST 쓰기는 가능하며 확인된 401만 인증을 종료한다. 정상 5분에 heartbeat 외 정기 상태/history GET은 0개다. |
| iPhone 10분 잠금·Mac sleep/wake·여러 창 활성/비활성·Wi-Fi↔셀룰러·Tailscale 전환 | 배경 10분 클라이언트 요청은 0개이며 호스트 작업은 계속된다. 복귀하면 새 세대로 즉시 sync하고 coordinator/소켓은 하나다. 불통을 정상으로 표시하지 않는다. |
| Claude/Codex 문맥 0/null/190k÷1M·누적/현재 usage·모델 변경·늦은 세대 표본 | 실측/추정/갱신 대기를 구분하고 19%가 정확하다. cache 이중 계산과 타 세대 오염은 없다. nonce는 유일한 주 세션에만 연결한다. |
| threshold 이상+idle+wake, working 중 수동 압축 예약, lease/draft/approval/done, timeout/crash | fresh exact만 auto 1회이며 wake가 없으면 0회다. slash에 nonce/marker/prefix가 없다. boundary+settled만 성공이다. done(턴 직후 core가 유지하는 상태)은 일반 전달과 같은 클라이언트 측 확인(입력칸 비어 있음·epoch·lease·기록 기준점) 뒤 보낸다(2026-11-07 실측: idle 전용이면 첫 턴 이후 압축이 영영 실행되지 않고 대기열이 막힘). uncertain은 재송신하지 않고 뒤 업무를 차단한다. |
| 이름 변경·본사 예외·보관/꺼내기·다른 기기 열린 프로젝트·보관 중 늦은 manual 자료 | ID·초안·이력을 유지하고 HQ 보관은 400, 삭제 경로는 없다. 보관함에서 대화/결재/업무/자료를 읽되 쓰기 UI는 없다. 보관 후 자동 start는 없고 꺼내기는 archived-held만 검사한다. 실제 같은 세션 이어가기를 확인한다. |
| APNs 4종·질문 ask·같은 직원 120초 마감/재시작·다른 직원·opt-out/re-enable | ask는 1사건이며 질문 메시지 중복은 없다. 전체 opt-in 뒤 기본 4종이 켜진다. 같은 창은 1개/고정 마감, 타 직원은 분리하며 새 기기에 소급하지 않는다. unknown을 승인으로 단정하지 않는다. |
| APNs TLS/JWT/400/403/410/429/5xx/GOAWAY/쓰기 뒤 timeout·해지·token 교체 | source/compile 모두 HTTP2 계약을 통과한다. 옛 generation의 410이 새 토큰을 무효화하지 않는다. 확정 실패만 TTL 내 재시도하고 unknown은 재발신하지 않는다. API/로그/payload에 비밀 canary가 없다. |
| iPhone foreground/background/종료 tap·다른 serverId·처리된 결재·보관·과거 보고 anchor | 전경 수신은 강제 탐색/배너 없이 갱신한다. tap만 최신 검증 뒤 이동한다. 알 수 없는 host로 자동 전환/답/claim/input하지 않는다. 여러 창 중 한 번 소비하며 sandbox/production 실기기 결과를 따로 남긴다. |
| 같은 홈 다른 포트의 두 데몬·symlink 별칭·lock holder crash·PID 재사용 | 두 번째 데몬은 DB/recovery 전에 거절된다. 살아 있는 프로세스를 임의로 죽이지 않는다. 종료 후 OS 잠금이 해제되며 config/복원도 같은 소유권 경계를 지킨다. |
| 미래 schema/이주 백업 실패/중간 migration 실패·손상 DB·첨부 누락·ENOSPC | 미래 DB는 쓰기 전에 거부하고 실패에 성공 응답을 주지 않는다. 단계별 commit은 재개 가능함을 확인한다. 백업 DB/첨부 검사와 별도 경로 복원을 통과하고 복원 큐를 무조건 replay하지 않는다. |
| 파일 두 개 중 후반 오류·파일 쓰기 뒤 DB 실패·GC/초안/보관/전달 경합·로그 폭주·config 실패 | 실패 작업의 미참조 staging만 정리하며 완료 attachment/보관/미해결 참조를 삭제하지 않는다. config 정상본·권한을 유지한다. 로그 회전 후 writer가 새 세대에 계속 쓰고 총량 상한을 지킨다. |
| CLI 등록/업데이트 mock 실패·구버전 데몬·보조 host 최초 bind 실패·전역 코드 회전 | 인증 readiness/build 불일치는 성공이 아니다. bind는 자동 재시도하되 공개 주소로 확장하지 않는다. 옛 코드/열린 WS를 즉시 거부하고 새 코드로 연결하며 코드 원문 로그는 없다. |

**안정화 종료 기준:** 미해결 재현 결함 0건, 실패/누락을 숨긴 게이트 0건, 양 제공자 정상 경로와 위 장애 경로 통과, 격리 호스트 24시간 병렬 운용에서 원본 유실/중복 외부 입력/고아 생성 0건. intentional unknown은 근거·추천·재관측/예외 동선이 있는 상태로 별도 집계한다. 실기기·실제 CLI 증거 의미가 미검증이면 해당 기능/core 이전 승인 조건은 미충족이다. 승인 후에도 라이브 기존 작업 이관은 별도 단계다.

## 위험

- **generation1의 외부 쓰기 원자성:** DB와 PTY는 한 transaction이 아니다. timeout 뒤 늦은 원래 입력·외부 attach·검사/kill 경합을 exactly-once로 만들 수 없다. 검증된 settled 장벽이 없는 post-write 부재 재전송은 비활성으로 두고, 긍정증거 정정/확정 쓰기 전 실패 복구는 자동화한다. 미확인을 ‘사람이 수신 판정’으로 떠넘기지 않는다.
- **설계의 오래된 현황:** core-context의 Codex 미구현 설명, 감사의 수동 delivery안 언급은 현재 파일과 다르다. W0 최종 실측 창/statusline/parser exports를 기준으로 재사용하며 두 nonce 수집기가 따로 세션을 연결하지 않게 하나의 binding 포트를 사용한다.
- **공유 파일 크기:** Store/Orchestrator/AppStore를 한 번에 여러 기능 워커가 편집하면 웨이브 원칙이 무너진다. 순차 소유 구간을 지키고 서비스 부품은 고정 포트로 병렬화한다. L 작업을 다시 나눌 때도 같은 파일 구현은 다음 웨이브로 옮긴다.
- **보관과 호환:** UI 읽기 전용과 DB 불변은 다르다. 늦은 manual 보고·자료와 v1 todo 동작을 보존한다. native ID가 없는 Codex 보관은 안전하게 거부될 수 있다. 이를 해결하려 거짓 session ID나 자동 새 세션을 만들지 않는다.
- **v1 쓰기의 잔여 한계:** 웹을 깨지 않게 유지하므로 버전 없는 v1 답/설정/fresh/terminal을 새 네이티브의 엄격 보호와 동등하다고 보장할 수 없다. v2 capability/receipt로 새 앱을 보호하고 웹 폐기 시 v1 제거를 별도 발주한다. legacy WS URL 인증도 같은 호환 부채다.
- **시험 격리의 구멍:** IAMCEO_HOME만 바꿔서는 provider 기록·Keychain·herdr 세션이 격리되지 않는다. 기존 full suite/실 herdr harness를 무심코 돌리지 않는다. 공통 fake fixture/주입경로가 준비되지 않은 시험은 실행하지 말고 해당 소유 작업에서 먼저 고친다.
- **APNs 배달의 한계:** 200은 Apple 접수다. OS배너/읽음/exactly-once는 보장하지 않는다. unknown을 재발신하지 않아 일부 알림이 빠질 수 있으나 앱의 결재/상태가 원본이다. 호스트 사망은 호스트가 푸시로 알릴 수 없다.
- **백업의 경계:** 같은 볼륨 사본은 디스크 고장을 견디지 못한다. 별도 소유자 지정 백업 위치/외부 보관이 필요하며 OS권한은 암호화가 아니다. 다른 호스트에 복제한 DB는 APNs disabled로 검증하고 기존 미발신 취소·새serverId·재등록 뒤 켠다. 정상 단일호스트 복원은 serverId를 유지한다.
- **OS/프로토콜 실측:** SwiftUI public scroll-host probe는 macOS14/iOS17과 현재OS에서 2pt를 검증해야 한다. Bun1.3.14 HTTP2 compiled 동작, 실제 Codex compact 기록/idle 조건, iPhone ATS/잠금/Tailscale 전환은 모의 성공으로 대체할 수 없다. 지원조합에서 해결 못 하면 기능 완료/core 이전을 막는 구체적 게이트다.
- **잠금 primitive와 로그 회전:** 홈 lock은 지원되는 OS배타성의 Bun FFI/libc flock의 실제 subprocess·컴파일 산출물 시험을 선행한다. 추가 의존성이 필요하면 W2-O가 버전/라이선스/빌드 영향을 확정하고 별도 계약 웨이브를 만든다. 로그는 launchd의 열린FD를 단순rename만으로 회전했다고 하지 않는다. 기본 logger보존값은 10MiB×5세대/stream으로 두고 writer 재오픈·실제디스크상한을 시험한다.
- **현재 계획 작업의 검증 범위:** 코드 구현·라이브/실기기·Swift 빌드·회귀시험은 이 문서 작성의 완료 증거가 아니다. 이번 읽기 전용 `./node_modules/.bin/tsc --noEmit --incremental false -p .`는 종료 코드 0으로 통과했다. 문서 이후 구현의 통과를 뜻하지 않는다. 모든 미래 시험은 위 게이트가 실제 실행된 뒤에만 통과로 기록한다.

초안 자체의 정적 검증: 필수 제목 6개, 웨이브 11개·작업 42개, 같은 웨이브의 수정 파일 중복 0건, 존재하지 않거나 같은/미래 웨이브를 가리키는 작업 의존 0건, web/ 수정 배정 0건을 확인했다. 게이트 셸 블록 2개는 `zsh -n` 구문 검사를 통과했다. 이는 미래 구현·기능 시험의 통과를 대신하지 않는다.
