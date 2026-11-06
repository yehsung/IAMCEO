## 판정표

검증 기준: 2026-11-07 작업 트리의 `.pumasi/audit/limits.md` 발견 L1–L9. **확인 2 · 부분 4 · 반박 1 · 중복 2 · 범위 밖 0**. 심각도는 중복 항목도 현재 코드의 영향을 기준으로 적었으며, 중복을 신규 필수 작업으로 다시 계산하지 않았다.

호출부·실행기·저장소·관련 시험 소스를 대조했다. 추가로 Bun 1.3.14에서 실제 클래스 메서드를 불러 메모리 모의 실행 5건을 검증했다. RPC와 저장소를 메모리 대역으로 대체하고 실행 파일 생성·문맥 파일 조회·외부 방송 등은 차단했다. 기존 시험 전체와 TypeScript 빌드는 실행하지 않았다. 라이브 7878·사용자 데이터/설정·herdr 소켓·실제 Claude/Codex 세션에 접근하지 않았고, 이 보고서 외 파일 및 git 상태를 변경하지 않았다.

| 원래 번호 | 판정(확인/부분/반박/중복/범위 밖) | 검증 근거(실제 파일:줄과 한두 문장) | 고친 심각도(높음/중간/낮음) | 최소 개선안 한 줄 |
| --- | --- | --- | --- | --- |
| L1 | 부분 | `server/runner/core.ts:137–146`은 오류 턴에 `noOutput`을 주지 않고, `server/orchestrator.ts:2503`, `:2958–2982`를 거치면 전달은 delivered인 채 일반 오류 기록만 남는다; working→error 모의 실행에서도 `turn_end` 뒤 idle 이벤트(`core.ts:150–152`)가 `orchestrator.ts:2901`, `:3090–3094`를 통해 status를 idle로 덮고 lastError만 보존했다. 다만 세션 없음 오류에는 별도 재시도(`orchestrator.ts:2939–2941`)가 있고, 처리 도중 오류의 원문을 재전송하지 않는 것은 중복 방지 계약(`tests/regress.test.ts:441–448`)이므로 ‘모든 오류에 복구가 없다’거나 ‘재전송 부재 자체가 결함’이라는 일반화는 깎는다. | 높음 | 처리 실패와 원래 전달의 연결·오류 증거를 보존하고, 새 정상 관측 전에는 오류 표시를 idle 이벤트로 지우지 않는다. |
| L2 | 확인 | `server/orchestrator.ts:2455–2458`의 admission과 `:2747–2750`의 집계가 모두 headless 전용이고, core의 멤버별 `sending/starts`(`server/runner/core.ts:34–35`, `:208–217`)는 전역 상한을 대신하지 않는다; 실제 pump에 가짜 core를 연결하자 상한 2에도 5개 전달·5개 활성 runtime 턴이 생겼다. `tests/orchestrator.test.ts:78–82`, `:330–346`은 headless 시험이며, 네이티브 설정도 ‘넘치면 차례를 기다립니다’(`native/Sources/IAMCEO/Views/SettingsView.swift:908`)라고 안내하므로 현행 core 동작과 불일치한다. | 높음 | core 자동 턴에도 await 전에 공통 슬롯을 예약하고 모든 종료·실패 경로에서 반환하도록 한다. |
| L3 | 반박 | 사후·프로젝트별 권고라는 관측은 `server/orchestrator.ts:1729`, `:1945`, `:3135–3155`와 일치하지만, 이는 `docs/operating-model.md:43`, 네이티브 안내(`native/Sources/IAMCEO/Views/SettingsView.swift:909`), 계약 시험(`tests/orchestrator.test.ts:621–635`)이 명시한 의도된 동작이다. `worker`만 세는 `maxAwakeWorkers`를 총괄/root 포함 전역 프로세스·비용 상한으로 해석할 근거가 없으며, 이를 높음 버그 및 필수 강제 제한으로 올린 판단은 반박한다. | 낮음 | 현재 항목의 프로젝트별 후보 안내 의미를 명시하고, 강제 세션 상한이 필요하면 별도 정책으로 결정한다. |
| L4 | 부분 | `server/runner/core.ts:234–246`은 started:false도 수신 성공으로 처리하고, 같은 turn/idle 관측은 `:137–149`의 pending 해제 조건을 충족하지 않아 `:204–206` 및 `server/orchestrator.ts:2409–2413`에서 후속 일반 지시를 막는다; 모의 성공 응답 뒤 동일 idle 관측 100회에서도 busy가 유지됐고 turn_end는 0건이었다. 그러나 started:false 자체는 오류가 아니라 기존 수신 계약(`.pumasi/specs/delivery-notice.md:111`)이며, `tests/core-runner.test.ts:109–121`은 정상 종료·일시 통신 복구를 검증할 뿐 이 입력의 실제 CLI 발생이나 지속 시간을 증명하지 않아 ‘영구 정체가 실제 발생했다’는 단정은 낮춘다. | 중간 | 수신 이후 시작 대기 시각을 추적해 정체를 노출하되 시간 초과만으로 pending 해제·재전송하지 않는다. |
| L5 | 부분 | 같은 turn 번호로 finished/exit_code=1을 주면 `server/runner/core.ts:130`, `:137–152`에서 turn_end 없이 gone만 나고, `server/orchestrator.ts:2906–2911`에서 runtime 턴이 지워지는 것을 모의 실행으로 확인했다; herdr는 이 경우 오류 turn_end를 따로 낸다(`server/runner/herdr.ts:1857–1862`). 다만 전달 원문은 DB에 남고(`server/store.ts:1523–1542`), native session ID를 유지한 명시적 resume 경로(`orchestrator.ts:1937–1951`, `:1964–2002`) 및 재결합 시험(`tests/core-runner.test.ts:73–80`)도 있으므로 ‘일 자체 유실·복구 수단 전무’는 과장이고, 네트워크·인증 오류가 반드시 프로세스 종료를 만든다는 증거도 없다. | 중간 | 확인된 프로세스 종료에 한해 중단 턴·전달 ID·종료 이유를 남기고 기존 세션 재개와 연결한다. |
| L6 | 확인 | `server/orchestrator.ts:593–599`의 core 최초 start 실패는 `:690–693`의 herdr 재결합 집합에 들어가지 않으며, 건강 회복(`:727–735`)과 tick(`:738–757`)은 빈 큐·설정 변경 없음인 직원을 다시 start하지 않고 core poll도 bind된 tracks만 조회한다(`server/runner/core.ts:189–201`); 실제 recover→건강 회복→tick/poll 모의 실행에서 tracks=0과 terminal.list 호출 0회가 유지됐다. `tests/regress.test.ts:511–524`는 herdr 재결합, `tests/core-runner.test.ts:117–121`은 이미 bind된 core의 통신 복구 시험이라 이 공백을 막지 않으며, hello(`core.ts:49–56`)가 제공자 인증까지 검사하지 않는 것은 통신 건강 확인의 범위이지 별도 오류로 세지 않는다. | 높음 | 전송 큐와 독립된 core 재결합 대상을 두고 소유권을 검증하는 재조회부터 제한적으로 재시도한다. |
| L7 | 중복 | herdr의 API 오류/noOutput 판정(`server/runner/herdr.ts:1126–1137`, `:1854`)은 `server/orchestrator.ts:2996–3016`의 message/decision 3회 포기·결재 재열림으로 이어지며 `tests/regress.test.ts:420–438`이 이를 명시하지만, `server/store.ts:1116`은 직전 choice/note를 last_choice/last_note에 보존하므로 답 이력이 완전히 사라지는 것은 아니다. 이 문제는 `.pumasi/specs/delivery-notice.md:162`, `:404`가 noOutput·사용량 한도만으로 재전송하거나 결재를 다시 열지 않도록 직접 변경하는 범위이고, 내부 보고 보존·회복 시험(`tests/regress.test.ts:1009–1030`)도 있으므로 별도 신규 발견으로 중복 계산하지 않는다. | 중간 | delivery-notice의 onTurnUnread 통합에서 답 이력·선택 보존과 자동 재전송 중단을 함께 검증한다. |
| L8 | 부분 | `server/orchestrator.ts:2711–2722`, `:3016–3030`, `:3166`의 대기는 멤버별 메모리이고 전달 스키마(`server/db.ts:144–160`, `shared/types.ts:212–228`)에 재시도 예정 시각이 없어, 재시작 후 미전달 pump(`orchestrator.ts:624–626`)에 이전 대기를 적용할 근거가 없다; 내부 전달의 반복 재시도는 보존 시험(`tests/regress.test.ts:1009–1030`, `:1049–1059`)과도 일치한다. 다만 300초는 noOutput 턴 오류의 상한 이후 경로이고 일반 send_error는 `:2700`, `:2710` 및 기본 retryMs(`:282`)에 따라 25초이며, core의 delivered 처리 실패(L1)는 이 반복 큐에 들어가지 않으므로 제공자 전체 호출 폭주·계정 공유·금전 손실까지 확인한 주장은 아니다. | 중간 | 기존 전달 보존을 유지하며 다음 재시도 시각을 영속화하고 확인 가능한 오류 범위에만 공유 대기를 적용한다. |
| L9 | 중복 | `server/orchestrator.ts:2978–2982`에 notifyInbox 호출이 없고 기존 Mac 알림은 `:2254–2256`의 opt-in인 것은 맞지만, 오류 자체는 status/lastError·시스템 글로 남아 ‘대표에게 보이는 오류 기록도 없다’는 뜻은 아니다. `.pumasi/specs/apns.md:38`, `:189–205`가 Store.patchMember에서 오류 사건·영속 episode/outbox를 직접 만들고 error→idle 중 lastError 유지도 같은 문제로 묶도록 설계했으므로 총괄 의존 없는 오류 감지·중복 억제까지 중복이며, quota 원인 분류는 별도 L1의 잔여 범위다. | 중간 | APNs 설계의 도메인 오류 사건을 재사용하고 L1에서 확보한 원인·다음 행동만 연결한다. |

메모리 검증의 한계: L1·L4·L5는 합성 terminal snapshot으로 어댑터 분기를 확인했고, L2는 실제 pump와 가짜 core send로 슬롯 누락을 확인했다. L6는 실제 recover/건강 확인/tick/poll에 가짜 RPC와 빈 큐를 주입했다. 파일을 쓰는 writeRunFiles, 문맥 조회, 외부 진단·복구 등은 대체했으며, 이 결과는 실제 제공자 CLI의 OSC 순서·내부 재시도·실제 사용량이나 청구를 재현한 것이 아니다. 기존 시험의 존재와 내용만 대조했으므로 전체 시험 통과를 주장하지 않는다.

중복 경계: delivery-notice의 수신 판정·미확인 복구는 L4의 ‘수신 이후 시작 정체’나 L5의 ‘처리 중단 기록’을 해결했다고 보지 않았다. 반대로 L5의 Codex native ID 탐색을 새로 제안하는 부분은 delivery-notice 및 core-context의 기존 설계로 넘긴다. realtime은 클라이언트 동기화이며 `.pumasi/specs/realtime.md:30`도 재연결로 업무 입력을 재실행하지 않는다고 명시하므로 L6의 실행기 재결합을 대신하지 않는다. chat-paging·project-manage는 각각 이력 조회·프로젝트 수명 관리로, 이 표의 잔여 한도/실행 복구 결함과 직접 중복되지 않는다. 웹 전용 결함은 이 발견 목록에 없고, L2·L3의 안내 계약은 네이티브 코드로 확인했다.

## 확인된 핵심

- L2: 사용자가 설정한 동시 턴 수가 core 자동 실행에서도 실제 admission을 제한하도록 한다.
- L1: 처리 실패의 작업 연결과 오류 증거를 보존하고, idle 이벤트가 새 오류를 정상 상태처럼 덮지 못하게 한다.
- L4·L5: 수신 이후 미시작·프로세스 종료를 추적해 정체/중단을 드러내고, 원문 자동 재전송 없이 기존 작업을 확인·재개할 경로를 남긴다.
- L6: 최초 core 재결합 실패도 새 전달 없이 관측이 복원되도록 큐와 독립된 재시도를 둔다.
- L8: 실제 재시도 큐의 다음 실행 시각을 영속화해 서버 재시작이 대기 시간을 없애지 않도록 한다.

## 메모

없음
