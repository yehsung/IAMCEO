## 판정표

검증일: 2026-11-07. `.pumasi/audit/status.md`의 발견 1~10을 현재 코드, 호출 경로, 관련 시험과 대조했다. 판정은 항목 전체 기준이며 일부만 별도 설계와 겹치면 근거에 **중복** 범위를 명시했다. 설계에 적힌 예정 기능을 현재 구현된 방어 장치로 간주하지 않았다. 웹 전용 발견은 없었다.

| 원래 번호 | 판정(확인/부분/반박/중복/범위 밖) | 검증 근거(실제 파일:줄과 한두 문장) | 고친 심각도(높음/중간/낮음) | 최소 개선안 한 줄 |
| --- | --- | --- | --- | --- |
| 1 | 확인 | `server/orchestrator.ts:1915-1919,2887,593-599`는 일반 runner를 먼저 asleep으로 저장하며 stop 예외 뒤 관측·시작 복구도 차단하고, 실제 거절은 `server/runner/core.ts:319-330` 및 `tests/core-runner.test.ts:211-214`에서 확인된다. 메모리 검증에서도 실패 뒤 asleep·pane 참조가 남았으며, `tests/orchestrator.test.ts:1194-1208`의 상태 보존은 adopted 분기에만 해당한다; **보관 경로 개선은 중복**(`.pumasi/specs/project-manage.md:115-118`)이지만 일반 sleep까지 고친다는 계약은 없다. | 높음 | 보관 작업과 종료 확인 처리를 공유하되 일반 sleep도 stop 성공 뒤 asleep을 저장하고 실패 시 상태·큐를 보존한다. |
| 2 | 확인 | `server/orchestrator.ts:593-601,727-757`의 시작 실패는 lastError만 남기고, 미결합 재시도 집합에는 herdr만 들어간다(`:690-695`); core poll은 bind된 Track만 읽는다(`server/runner/core.ts:65-75,189-201`). 메모리 검증에서 큐 없는 시작 실패 후 health 회복·10회 tick에도 start 호출은 1회였으며, `tests/regress.test.ts:511-524`는 herdr 재시도, `tests/core-runner.test.ts:117-122`는 이미 bind된 Track의 복구라 이 경로를 막지 않는다. | 높음 | 큐 유무와 무관하게 미결합 core 멤버를 추적하여 소유 terminal 조회·재결합만 백오프로 재시도한다. |
| 3 | 부분 | `server/runner/core.ts:137-152` → `server/orchestrator.ts:2944,2978-2981,2899-2901,3090-3094`를 연결한 메모리 검증에서 일반 error 뒤 상태가 idle로 덮였고, 초기 error도 `initial` 조건 때문에 종료 오류로 기록되지 않는다. 그러나 lastError·error 활동·시스템 글·worker의 총괄 보고는 남으므로 오류 자체가 사라진다는 영향은 과장이고, 기존 오류 시험(`tests/orchestrator.test.ts:270-280`)은 HeadlessRunner 경로(`:78-80`)여서 core의 후속 idle을 검증하지 않는다. | 중간 | 같은 턴의 error는 후속 idle만으로 해제하지 않고 최초 bind의 error도 오류 결과로 보존한다. |
| 4 | 부분 | `server/runner/core.ts:183-201,218,245,358-361`은 poll 외 refresh와 직렬화되지 않으며 `:126-141`은 turn 감소도 수용한다; 요청별 별도 연결(`server/runner/core-client.ts:28-35`)의 응답을 메모리에서 역전시켜 9→8 퇴행·동일 9의 종료 2회·후속 rt.turn 해제를 재현했다(`server/orchestrator.ts:2916-2949`). 다만 실제 core 응답 역전 빈도·운영 사고는 미검증이고 finalText가 빈 값이라 중복 완료 보고까지 입증되지는 않으며, 기존 동시 send 시험(`tests/core-runner.test.ts:109-115`)은 역순 조회 시험이 아니다. | 중간 | 멤버별 refresh를 직렬화하고 마지막 완료 turn을 별도로 보존해 동일·이전 턴 종료를 재적용하지 않는다. |
| 5 | 부분 | `server/runner/core.ts:234-246,137-149,204-206`을 메모리에서 실행하면 started:false 정상 ACK 뒤 같은 idle/turn을 50회 조회해도 pending=true이고 다음 send가 막힌다; 서버도 성공 뒤 working을 저장하고 rt.turn으로 큐를 막는다(`server/orchestrator.ts:2503-2506,2743-2744,2409-2413`). 다만 재시작 bind는 pending을 초기화하므로 무조건적인 영구 고착은 아니고(`server/runner/core.ts:65-69`), `/effort`에는 완료 확인과 해제 시험도 있다(`tests/core-runner.test.ts:195-204`); **미확인 전달 복구는 중복**이지만 최신 설계도 정상 ACK를 received로 인정하고 uncertain을 다룰 뿐 ACK 뒤 pending 감시는 규정하지 않는다(`.pumasi/specs/delivery-notice.md:111,160-162`). | 높음 | 정상 ACK의 실행 확인 대기를 별도 추적하고 시작·종료 증거 부재는 확인 불가로 알리되 타임아웃으로 재전송하거나 pending을 임의 해제하지 않는다. |
| 6 | 부분 | `server/runner/core.ts:183-200`, `server/runner/herdr.ts:1788-1789,1874-1898`, `shared/types.ts:78-93`에서 멤버별 조회 실패·신선도 정보의 부재는 확인되며 일반 updatedAt은 patch·도구 호출로도 변한다(`server/store.ts:890-894,936-938`). 다만 core의 다음 poll 및 herdr의 snapshot 재조회와 core 복구 시험이 있으므로(`tests/core-runner.test.ts:117-122`) 개선 범위는 기존 복구 중 옛 상태를 구별하는 계약으로 한정한다; 클라이언트 동기화 설계(`.pumasi/specs/realtime.md:25-31`)는 멤버별 OSC 관측 시각을 보장하지 않는다. | 중간 | 기존 재조회를 유지하면서 멤버별 마지막 관측 시각·조회 실패 사유를 상태와 함께 표시한다. |
| 7 | 부분 | `server/runner/core.ts:128-153`의 미보고→blocked 투영은 메모리에서 재현됐고, `server/orchestrator.ts:2877-2883`, `server/store.ts:742`, `native/Sources/IAMCEO/Design/Presentation.swift:35-37,238`은 이를 승인 안내·수에 사용한다; 기존 시험은 미보고 입력 차단과 blocked 알림 중복 방지를 검증한다(`tests/core-runner.test.ts:101-107`, `tests/regress.test.ts:1276-1288`). 다만 입력 보류 자체는 올바른 보호이고 네이티브 설명에는 읽기 실패 가능성도 명시돼 있으며, **APNs의 승인 단정 문구 개선은 중복**(`.pumasi/specs/apns.md:370`)이지만 현재 Mac 알림·네이티브 라벨·집계의 분리는 그 설계 밖이다. | 중간 | unknown/setup과 확인된 승인의 표시·집계만 분리하고 신뢰할 수 없는 상태의 자동 입력 차단은 유지한다. |
| 8 | 부분 | `server/orchestrator.ts:584`, `shared/types.ts:88`, `server/runner/core.ts:19,124-181`에서 미수집을 0으로 나타내는 계약과 core 수집 부재가 확인되고, herdr 재결합은 EOF·빈 Set에서 시작한다(`server/runner/herdr.ts:789-800,1141-1145`); 기존 시험은 재결합 뒤 추가한 Agent/Task만 센다(`tests/herdr.test.ts:717-744`). 다만 네이티브는 0개를 명시적으로 표시하지 않고 양수만 노출하며(`native/Sources/IAMCEO/Views/TeamView.swift:486`), tool_result와 실제 자식 수명이 어긋나는 운영 사례는 제시되지 않아 정확한 lifecycle 수집 전체를 완성 필수로 삼는 것은 과하다. | 낮음 | 우선 수집 지원 여부·unknown을 0과 구분하고 실제 자식 lifecycle 재구성은 후속으로 둔다. |
| 9 | 부분 | `server/orchestrator.ts:1800-1822,2259-2260,2944-2972`와 `shared/types.ts:78-93`에는 now의 업무·턴 소속/전용 시각이 없어 새 업무에도 옛 설명이 남을 수 있고, 네이티브는 idle에도 ‘지금’을 쓴다(`native/Sources/IAMCEO/Views/TeamView.swift:1709-1712`). 그러나 next 생략 시 보존은 명시적으로 시험된 계약(`tests/tools.test.ts:129-134`)이고 idle은 업무 완료가 아니라는 설명도 있으며(`native/Sources/IAMCEO/Design/Presentation.swift:38-40`), 사무실은 idle에 이미 ‘마지막’이라고 표시한다(`native/Sources/IAMCEO/Views/OfficeView.swift:61-73`); 추가 status 요청·turn 연결 전체를 완성 필수로 삼기는 어렵다. | 낮음 | now를 ‘마지막 보고’와 보고 시각으로 표현하고 next 보존 계약은 유지한다. |
| 10 | 부분 | `server/orchestrator.ts:826-842`의 updatedAt 기반 추정과 일반 patch의 시각 갱신(`server/store.ts:890-894`)은 사실이나, 도구·ask/wait 요청이 실제로 시각을 갱신하고 답 수신 시 settle하는 경로도 있다(`server/http.ts:581-595`, `server/orchestrator.ts:1658-1673`). `tests/regress.test.ts:694-704`와 `tests/archive-gate.test.ts:332-350`은 활동 뒤 복귀·살아 있는 롱폴의 waiting 유지까지 검증하므로 의도된 타이머 추정 전체를 중간 결함으로 세는 것은 과하며, 남는 문제는 추정 상태의 표현과 범용 수정 시각 혼용이다. | 낮음 | manual은 마지막 도구 활동에 따른 추정임을 표시하고 활동 시각을 일반 수정 시각에서 분리한다. |

검증 방식과 한계: 관련 `tests/`·네이티브 시험은 읽어서 보호 범위를 확인했으며 기존 시험 전체를 실행하지 않았다. Bun 1.3.14의 메모리 변환으로 실제 `CoreRunner` 클래스와 Orchestrator의 해당 메서드를 읽어 실행하고, 저장소·RPC·화면 가드·후속 보고를 가짜 객체로 대체한 검증 6건(1·2·3·4·5·7)이 모두 예상 실패 경로를 재현했다. 4는 미리 시작한 두 refresh 중 새 idle/9를 먼저 반환한 뒤 옛 working/8과 다음 idle/9를 반환했다. 5는 빈 composer 조건에서 started:false/turn=8 ACK 뒤 같은 idle/8을 50회 반환했으며 후속 입력은 추가 전송되지 않았다. 이 검증은 실제 프로토콜 발생 빈도나 전체 DB·실세션 통합 시험을 대신하지 않는다.

별도 설계 6개를 대조했다. 문맥 수집·압축의 세대/신선도는 `.pumasi/specs/core-context.md:76-90`, 이전 대화의 응답 병합은 `.pumasi/specs/chat-paging.md:212-225`의 범위로 두었으며 새 발견으로 재등록하지 않았다. 읽기·메모리 검증과 이 보고서 작성만 했고 소스·설정·git 상태를 변경하지 않았다. 라이브 서버 7878, `~/.iamceo` 및 config.json, herdr/core 소켓, 실제 Claude/Codex 세션에는 접근하지 않았다. 문서 산출물이므로 빌드·프로젝트 TypeScript 전체 컴파일은 실행하지 않았으며 통과를 주장하지 않는다.

## 확인된 핵심

- 1: 일반 잠재우기에서도 실제 종료 확인 전 asleep을 확정하지 않아야 한다; 보관 종료 설계와 공통 처리하되 일반 경로 회귀를 검증한다.
- 2: 시작 시 core 재결합 실패는 큐가 없어도 기존 소유 terminal을 읽어서 다시 붙어야 한다.
- 3: core의 error 결과를 같은 관측에서 이어지는 idle이 덮지 않게 하고 초기 error도 보존해야 한다.
- 4: 겹친 core 조회를 직렬화하고 동일 턴 종료가 새 rt.turn을 해제하지 못하게 해야 한다.
- 5: 정상 ACK 뒤 실행 신호가 없으면 실행 확인 불가를 드러내는 감시가 필요하다; 자동 재전송·시간만으로 완료 처리는 금지한다.
- 6·7: 옛 관측과 확인 불가를 구별하고 상태 미수집을 승인 확정으로 안내·집계하지 않는 최소 표시가 필요하다.

## 메모

없음
