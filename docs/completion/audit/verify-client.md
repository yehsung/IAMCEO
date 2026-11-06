## 판정표

2026-11-07 작업 트리 기준. `client.md`의 C1–C10을 네이티브 호출부 → HTTP → Store/Orchestrator → runner와 기존 시험 코드로 역추적했다. **확인 6건, 부분 4건**이며, 원래 높음이던 C2·C4는 중간, C10은 낮음으로 내렸다. 여기서 확인은 코드상 실패 경로의 확인이며 장애 주입 실행 재현을 뜻하지 않는다. 코드·시험·빌드는 실행/수정하지 않았고, 라이브 서버·사용자 데이터·소켓·실제 CLI 세션에 접근하지 않았다.

| 원래 번호 | 판정(확인/부분/반박/중복/범위 밖) | 검증 근거(실제 파일:줄과 한두 문장) | 고친 심각도(높음/중간/낮음) | 최소 개선안 한 줄 |
| --- | --- | --- | --- | --- |
| C1 | 확인 | `native/Sources/IAMCEO/State/AppStore.swift:48`, `:293`은 요청 ID를 메모리·본문 키에만 묶고, `native/Sources/IAMCEO/State/DraftStore.swift:16`, `:68`은 글만 복원하므로 서버 저장 후 응답 유실 → 앱 재시작 → 같은 초안 전송에 새 ID가 붙는다. `server/http.ts:434`의 동일 ID 보호와 `server/orchestrator.ts:1263`의 저장·`:1291`의 전달은 다른 ID의 같은 글을 합치지 않으며, 같은 프로세스·같은 본문 재시도까지 취약하다는 주장은 성립하지 않는다. | 높음 | 최초 전송의 서버·대상·불변 ID·내용을 영속화하고, 재시작 후 동일 ID의 접수 결과를 확인한 다음 해당 초안만 소비한다. |
| C2 | 부분 | `native/Sources/IAMCEO/State/DraftStore.swift:20`과 `server/store.ts:512` 때문에 A의 `hq:chief` 글이 B에도 보이며, iOS 연결 링크는 나가기 없이 `native/Sources/IAMCEO/Views/AppShell.swift:65` → `State/AppStore.swift:389`로 호스트를 바꿀 수 있고 업로드 완료도 `Views/ComposerBar.swift:388`에서 세대 확인 없이 첨부를 넣는다. 다만 `Views/SettingsView.swift:1167`의 명시적 나가기는 초안을 지우고, 자동 발송은 없으며 B에 없는 첨부 ID는 `server/http.ts:451`에서 400으로 막으므로 다른 호스트로 파일이 곧바로 전송된다는 수준으로 확대할 수 없다. | 중간 | 초안 키에 서버 namespace를 추가하고 업로드 완료 때 연결·초안 삭제 세대가 같은지 검사한다. |
| C3 | 확인 | `native/Sources/IAMCEO/Views/SettingsView.swift:1117`은 편집 중 draft를 유지하고 base만 바꾸며, `:1131`·`:1140` → `State/AppStore.swift:428`은 backend를 제외한 Settings 전체를 보내므로 Mac의 모델 편집이 iPhone의 새 permissionMode를 옛 값으로 덮는 경로가 있다. `server/http.ts:194`에는 버전 조건이 없고 `server/orchestrator.ts:1018` → `server/store.ts:1615`·`:1622`는 전달된 값을 덮으므로 정상 폴링/이벤트 수신도 이를 막지 않는다. | 높음 | 편집 시작 base를 유지하고 dirty 필드만 보내며 서버 설정 revision으로 충돌을 거부한다. |
| C4 | 부분 | `native/Sources/IAMCEO/State/AppStore.swift:419` → `server/http.ts:540` → `server/orchestrator.ts:982`는 완료 후 재요청을 새 회전으로 처리하고, 오래된 멤버 PATCH도 `:1126`·`:1129`에서 차이가 있으면 재개방하므로 멱등 신원·버전의 빈틈은 있다. 그러나 `:954`·`:957`은 작업 중/처리 중/전달 불명에 거부하고 `:975`는 종료 확인 후 회전하며, 같은 Claude 설정 변경은 `:983`에서 원래 대화를 재개하므로 모든 재시도가 진행 중 작업을 닫거나 대화를 버린다는 해석은 과장이다. | 중간 | fresh-session에 재사용 operationId·검토한 세션 세대, 멤버 PATCH에 config revision을 넣어 늦은 재요청을 구분한다. |
| C5 | 부분 | `server/runner/core-client.ts:44`의 uncertain을 `server/orchestrator.ts:532`가 문자열 409로 바꾸고 `native/Sources/IAMCEO/State/AppStore.swift:484`는 false만 돌려주므로, 키 적용 뒤 응답 유실 → 사용자의 재클릭 → `server/runner/core.ts:371` 재실행 경로와 `:353`에서 만든 최초 claim ID 유실 경로는 남는다. 다만 `State/AppStore.swift:485`는 기존 lease를 유지하고 `Views/TerminalView.swift:315`는 진행 중 클릭을 막으며 `server/runner/core-client.ts:2`는 mutation을 자동 재생하지 않으므로 자동 중복이나 모든 timeout 뒤 조작권 상실로 볼 수 없다. | 높음 | 직접 입력의 결과 불명을 별도 표시하고 미확인 입력 재전송을 막으며, claim ID를 클라이언트에서 정해 같은 claim 결과를 회수한다. |
| C6 | 확인 | `server/orchestrator.ts:1742`의 **runner 시작 RPC**가 쓰기 후 실패하면 `:1745` → `:1767`에서 멤버를 삭제하지만, `server/runner/core.ts:114`·`:119`는 이미 생성된 holder 가능성을 인정하고 재결합은 `:90`의 같은 member ID에 의존한다. `server/store.ts:848`은 재생성에 새 ID를 주고 복구도 `server/orchestrator.ts:583`의 현 명부를 순회하므로 고아를 찾지 못하며, 단순 앱 HTTP 응답 유실만으로 삭제되는 것은 아니다(시작이 성공했다면 같은 이름 재생성은 `server/store.ts:845`의 409). | 높음 | 시작 전 확정 거부와 시작 결과 불명을 나누고, 불명일 때 멤버를 남겨 동일 ID의 core labels로 재결합한다. |
| C7 | 확인 | `native/Sources/IAMCEO/State/DraftStore.swift:10`은 첨부를 매번 빈 배열로 시작하고 `:28`·`:66`은 첨부를 영속화하지 않으므로 `Views/ComposerBar.swift:389`의 업로드 완료 칩은 재실행 후 사라지며 `DraftStore.swift:49`도 첨부만 있는 초안을 세지 않는다. `server/http.ts:470`은 서버 첨부를 생성할 뿐 클라이언트 초안과의 관계를 복원하지 않으므로 서버 원본 유실은 아니지만 지시에서 첨부가 빠지는 문제는 유효하다. | 중간 | 서버별 초안과 업로드 완료 attachment ID를 함께 저장하고 첨부만 있는 초안도 개수에 포함한다. |
| C8 | 확인 | `native/Sources/IAMCEO/Views/TerminalView.swift:229`의 입력창에는 pending 잠금이 없고 `:239`는 전송 전 문자열을 넘긴 뒤 성공하면 현재 input을 무조건 비우므로, A 전송 대기 중 B로 편집하면 B를 지운다. `State/AppStore.swift:481`의 요청 잠금은 재전송만 막으며 입력창 편집이나 로컬 문자열을 보호하지 않고, 일반 지시의 `Views/ComposerBar.swift:360` → `State/DraftStore.swift:37` 소비 경로도 터미널에는 적용되지 않는다. | 중간 | 전송한 입력 revision을 캡처하고 성공 시 그 revision이 그대로일 때만 비운다. |
| C9 | 확인 | `native/Sources/IAMCEO/State/AppStore.swift:317`·`:320`은 카드별 성공 ID를 버리고, `Views/InboxView.swift:626`은 최신 카드가 non-open이면 실패한 요청도 answeredHere에 넣어 `:628`에서 메모를 지운다. `server/store.ts:1048`의 다른 답 409와 `State/AppStore.swift:283`의 재조회는 서버 답 덮어쓰기는 막지만 바로 그 non-open 상태를 가져오므로 메모 삭제를 막지 못하며, `InboxView.swift:553`의 stale 보호도 inFlight 동안 건너뛴다. | 중간 | 카드별 수락 결과를 반환하여 해당 요청이 수락된 ID의 메모만 지우고 충돌·불명 카드의 메모는 유지한다. |
| C10 | 부분 | `native/Sources/IAMCEO/State/AppStore.swift:401` → `server/http.ts:498` → `server/store.ts:1179`에는 reviewed revision이 없어 늦은 반대 상태 요청이 마지막 도착값을 덮으며, `Views/HomeView.swift:727`은 응답 유실에도 낙관 표시를 해제한다. 그러나 같은 done은 `server/http.ts:499`·`server/store.ts:1181`에서 무변경이고 `State/AppStore.swift:215`의 폴링이 표시를 회복하며, AI 정리 사유 삭제는 `server/store.ts:1178`에 명시된 의도적 다시 열기 동작이므로 이를 독립적인 조용한 데이터 손상으로 세거나 모든 응답 유실을 필수 차단 사유로 삼는 것은 과장이다. | 낮음 | timeout은 실패 대신 결과 확인 중으로 표시하고 조회하며, 다중 기기의 오래된 반대 조작을 거부해야 한다면 todo revision 조건을 추가한다. |

기존 시험의 보호 범위도 읽어서 대조했다. 아래는 **실행 결과가 아니라 시험 내용**이다.

- C1: `native/Tests/IAMCEOTests/NetworkTests.swift:74`·`:101`은 같은 AppStore에서 동일 본문 재시도의 ID 재사용만 검증한다. `tests/http.test.ts:315`는 같은 ID에서 본문이 달라도 기존 결과를 반환하는 보호를 검증하지만 앱 재생성·편집으로 새 ID가 생기는 경우는 막지 않는다.
- C2: `native/Tests/IAMCEOTests/ContractTests.swift:119`는 pairing 링크 형식·주소 검증이고 `:50`은 외부 origin 첨부 인증 차단이다. 프로젝트·대상이 같은 두 호스트 사이의 DraftStore namespace나 나가기 뒤 늦은 업로드 완료 검사는 없다.
- C3: `tests/core.test.ts:391`과 `tests/http.test.ts:459`는 부분 설정 저장·영속성·입력 검증이다. 전체 Settings를 들고 있는 두 편집자의 동시 저장이나 permissionMode 충돌을 검증하지 않는다.
- C4: `tests/server-runtime.test.ts:90`·`:102`는 busy/blocked 거부와 stop 실패 시 신원 보존, `:141`은 같은 Claude 세션 재개, `:219`는 명시적 fresh-session을 검증한다. 앞 요청 완료 후 같은 fresh 요청을 다시 보내는 시험은 없어 진행 중 guard를 영속 멱등성으로 볼 수 없다.
- C5: `native/Tests/IAMCEOTests/ConnectionLossTests.swift:72`는 입력/release 실패 때 lease를 유지하고 확정 만료에서만 지우는 보호다. `tests/core-runner.test.ts:136`은 lease 소유·자동 전달 중지, `:87`은 **자동 send** timeout 뒤 재생 금지를 검증하며 최초 claim 응답 유실이나 직접 key의 결과 복원은 검증하지 않는다.
- C6: `tests/core-runner.test.ts:73`은 안정된 같은 member ID로 runner를 다시 만들면 추가 launch 없이 재결합함을 검증한다. 반면 `tests/regress.test.ts:351`·`:364`는 가짜 실행기의 시작 실패 때 명부를 비우고 대표 메시지를 보류·재전달하는 시험으로, 살아 있는 core holder와 삭제된 member ID의 조합은 다루지 않는다. 메시지 복구 큐가 있다는 이유로 터미널 신원 삭제까지 해결된 것으로 볼 수 없다.
- C7·C8: 현재 `native/Tests/IAMCEOTests/`의 세 시험 파일에는 DraftStore 첨부의 재생성 복원이나 TerminalView의 지연 응답 중 추가 편집을 다루는 시험이 없다. 서버 첨부 왕복이나 lease 시험은 이 로컬 후처리를 실행하지 않는다.
- C9: `tests/http.test.ts:378`은 다른 답 409, `tests/board.test.ts:192`는 AI가 카드를 실제 closed로 만드는 경로, `native/Tests/IAMCEOTests/ContractTests.swift:75`는 stale review 보존을 검증한다. 묶음 후처리의 성공 ID 분류는 별도이며, 서버 충돌 보호가 있어도 `runBatch`의 clearMemo는 실행된다.
- C10: `tests/http.test.ts:394`·`tests/core.test.ts:287`은 동일 값 무변경을, `tests/regress.test.ts:589`는 체크 해제 시 이미 보낸 완료 통지를 정정하고 미발송 통지를 취소하는 경로를 검증한다. 따라서 완료 취소가 전혀 전달되지 않는다는 확대 해석은 반박하며, 남는 범위는 서로 다른 기기의 요청 순서와 일시적인 실패 표시다.

별도 설계 중복 대조:

- `.pumasi/specs/delivery-notice.md:1`·`:3`은 현재 **자동 판정·복구 개정안**이다. 원 보고서 `client.md:58`의 수동안이라는 설명은 현 문서와 다르다. 새 설계의 큐/dispatch 영속성(`delivery-notice.md:49`·`:51`)과 recovery operationId(`:312`·`:333`)는 서버에 접수된 전달의 복구이며, 최초 POST 전 클라이언트 ID 영속화(C1), 직접 키 조작 결과(C5), 시작 실패 멤버 삭제(C6)의 해결 계약은 아니다. `:336`도 기존 메시지 POST 계약을 유지한다.
- **중복인 개선 부분:** C5와 관련해 자동 send·repair·terminal/control·설정/세션 변경의 팀원별 mutex/epoch를 새 과제로 발주하는 부분은 `delivery-notice.md:121`과 중복이다. 해당 설계로 통합하고, 이번 C5의 잔여 문제인 직접 입력 결과 불명·잃은 claim 복원만 별도로 남긴다. C4도 이 직렬화를 재사용하되 완료 후 재요청의 멱등성과 혼동하지 않는다.
- `.pumasi/specs/realtime.md:146`·`:156`은 snapshot 순번·조회 조정·재연결을 다루고 쓰기/터미널 입력을 재생하지 않는다. C3의 편집 충돌·C9의 잘못된 메모 소비·C10의 todo 쓰기 선행조건은 조회가 최신이어도 남는다. C2 업로드 완료의 세대 검사는 `realtime.md:150`의 연결 세대 원칙을 재사용하면 되지만 영속 초안의 서버 분리는 별도다.
- `.pumasi/specs/apns.md:295`는 푸시 전용 기기 설정 revision이며 기존 실행 설정 draft는 건드리지 않는다고 명시한다. `:303`·`:308`의 serverId 연결·callback 세대는 C2가 공유할 부품이지 기존 DraftStore를 이미 분리한다는 계약은 아니다.
- `.pumasi/specs/core-context.md:16`·`:18`의 압축 요청 합치기/결과 불명 처리는 compact 대상이다. fresh-session·직접 키 입력 전체의 receipt나 직원 생성 신원 보존으로 확대 적용할 근거는 없다.
- `.pumasi/specs/chat-paging.md:21`·`:185`는 초안·첨부·재전송 ID의 기존 저장 방식과 POST를 유지한다. `.pumasi/specs/project-manage.md:19`는 이름 변경 시 ID·초안 키를 유지하고 `:29`는 보관 gate를 유지한다. C1–C10 중 과거 대화/프로젝트 관리 자체를 새로 요구한 항목은 없고, 웹 전용 발견도 없다. 따라서 전체를 중복/범위 밖으로 제거할 행은 없으며 위 개선 부분만 중복으로 제외했다.

## 확인된 핵심

- C1: 응답 유실 후 앱을 다시 열어도 최초 전송 ID를 복원하여 같은 지시가 새 메시지로 재접수되는 것을 막는다.
- C2·C3: 호스트별 초안을 분리하고, 다른 기기의 실행·권한 설정을 오래된 전체 draft로 조용히 덮지 않게 한다.
- C6: core를 제공하는 버전에서는 시작 결과 불명인 멤버를 삭제하지 않고 같은 ID로 살아 있는 터미널을 찾는다.
- C4·C5: 새 세션/직접 조작을 제공하는 버전에서는 완료 후 재요청과 결과 불명을 구분하고 같은 조작을 무심코 다시 실행하지 않게 한다.
- C7·C8·C9: 업로드 완료 첨부를 복원하고, 터미널의 후속 편집과 충돌한 결재 메모를 성공 후처리로 지우지 않는다.

## 메모

없음
