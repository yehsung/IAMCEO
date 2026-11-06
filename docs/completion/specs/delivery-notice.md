# 전달 상태 안내·자동 판정·복구 구현 설계서

설계일: 2026-11-07. 구현 제안이며 기능 구현 완료를 뜻하지 않는다. 이번 작업에서 쓰는 파일은 본 설계서 하나다. 이전 수동 판정안을 시스템의 증거 수집·자동 정정·자동 복구 중심으로 대체한다.

`docs/claude-handoff.md` 전체와 관련 코드를 읽었다. §7의 남은 안정성 범위와 §8의 ‘저장/CLI 수신/턴 종료/업무 완료를 구분’ 계약을 지킨다. 목표는 core이며 현재 라이브 herdr에도 같은 판정 원칙을 적용한다. 실행기 기본값 변경, CLI 전역 설정 변경, 라이브 시험은 범위 밖이다.

현재 코드에서 확인한 출발점:

- `orchestrator.ts`: 대표 메시지는 `#<messageId>`, 결재·할 일은 `#<원본Id>`가 붙는다. 일반 묶음은 마지막 delivery ID를 `StartOpts.marker`로 넘기지만 `sendUrgent`에는 이 보완 표식이 없다. 같은 todo ID가 여러 알림에 재사용되므로 원본 ID만으로 전달 시도를 식별할 수 없다.
- herdr `withMarker`는 글 끝에 기존 ID가 있으면 보완 표식을 추가하지 않는다. `spillIfLong`은 마지막 표식만 남긴 축약문을 넣는다. `promptSeen`은 기록 원문/화면의 어느 표식이든 있으면 true이고 `settleInFlight`는 묶음 전체를 받음으로 만든다. `delivered`는 working·붙여넣기 표시·조회 실패를 수신으로 간주할 수 있고, timeout 뒤 `clearInput` 후 다시 넣는 경로도 있다. 새 판정에 그대로 재사용할 수 없다.
- core `send`는 빈 입력칸과 OSC 7501 상태를 검사하지만 `opts.marker`를 본문에 넣지 않는다. 응답 유실에는 `Track.uncertain`이 설정된다. orchestrator는 core 오류를 `held/delivery_unknown`으로 보류하고 후속 큐를 막는다. 현재 사람이 입력하면 runner의 uncertain이 해제될 수 있지만 DB 보류는 별개로 남는다.
- `recover/settleInFlight`, `safeSend/onSendFailed`, `sendUrgent`, `onTurnUnread`가 통합 대상이다. 특히 noOutput으로 수신된 지시를 다시 보내는 경로는 입력 수신과 작업 수행을 혼동할 수 있다.
- `store.projectState` 메시지는 최근 200개이고 `listPending/listUndelivered`는 failed를 제외한다. 전체 집계의 원본으로 쓰면 안 된다. `cancelPendingFor`는 held도 삭제하므로 확인 중인 전달을 보호해야 한다.
- 네이티브 `DeliveryInfo`는 held를 일반 보류로 표시하고 `isDeliveryUnknownHold`는 한국어 접두어를 검사한다. `HomeAttention`은 최근 메시지와 현재 총괄로 수신자를 추정한다. 새 서버에서는 구조화된 판정·실제 delivery 수신자가 원본이다.

## 사용자 동작

정상 흐름은 **시스템 확인 → 받은 지시의 오표시 정정 또는 미전달 지시 자동 복구**다. 대표가 세션을 읽고 ‘전달됨/다시 보내기’를 고르는 과정을 기본으로 삼지 않는다. ‘받음’은 CLI 사용자 입력 도착이며 모델의 처리·업무 완료를 뜻하지 않는다.

| 상황 | 표시 | 시스템 동작 |
| --- | --- | --- |
| 평상시 저장·전송·순번 대기 | `전달 대기`, `전달 중` | 기존 큐 처리 |
| 전송 오류·응답 유실·전송 중 재시작 | `확인 중` | 기록·화면·입력칸·세션 자동 확인 |
| 기록에 고유 표식 있음 | `받음` | 실패/미확인 오표시 정정, 이 전달 때문에 막힌 뒤 큐 해제 |
| 확실한 미전달·빈 입력칸·수신 가능 | `자동으로 다시 보내는 중` | 직전 재검사 후 같은 delivery ID·표식으로 재전송 |
| 해당 입력만 미제출로 남음 | `입력 제출을 확인 중` | 안전 조건을 확인하고 제출만 한 번 수행 |
| 승인 창·직접 조작·작업 중 | `승인 창이 닫히면 다시 확인합니다`, `직접 조작이 끝나면 다시 확인합니다`, `받을 수 있을 때 다시 확인합니다` | 입력·승인·사용자 초안에 손대지 않고 대기 |
| 끝내 증거 없음·복구 상한 도달 | `전달 확인에 도움이 필요합니다 · 1건` | 이때만 전달 문제로 홈 ‘내 차례’·팀원 상세·명패에 올림 |

자동 확인 중에는 팀원 상세/대화의 작은 상태 줄만 보인다. 자동 처리만으로 홈 개입 수나 사무실 주의 배지를 늘리지 않는다. 전달 문제로 `Member.status`·캐릭터 동작·업무 완료를 바꾸지 않는다. 승인 자체가 대표 행동을 필요로 하면 기존 승인 안내는 즉시 보이되 전달 확인 행을 중복 생성하지 않는다.

사람이 필요한 안내는 팀원당 한 행으로 묶는다. 상세는 `미확인 1 · 미전달 2 · 뒤에서 대기 3`으로 구별하고 명패는 `전달 확인 1`만 짧게 표시한다. 시각 숫자는 99+, 접근성 이름과 상세는 정확한 건수다. 결재 숫자와 합치지 않는다. 같은 팀원의 승인·오류 행이 있으면 그 안에 전달 안내를 붙인다.

상세에는 지시/관련 결재·할 일, 실제 대상, 시각, 시스템 확인 결과와 추천 행동을 표시한다. 원시 세션 기록을 읽도록 요구하지 않는다. 예: `세션 기록: 찾을 수 없음 · 터미널: 이전 세션 종료 · 자동 재전송: 하지 않음. 추천: 같은 세션을 다시 연결한 뒤 다시 확인하세요.` 기본 버튼은 `다시 확인`, 필요한 기존 `터미널 열기`/연결 진단이다. 다시 확인은 증거 수집 요청이지 수신 확정이 아니다.

증거를 얻을 수 없다고 시스템이 판정한 예외에서만 서버가 허용하는 다음 고급 행동을 제공한다.

- `위험을 확인하고 다시 보내기`: `과거에 이미 받은 지시일 수 있어 같은 일이 두 번 실행될 수 있습니다.`를 별도로 확인한다. 같은 세션·원래 요청 종료·빈 입력칸·수신 가능 상태를 요구하며 승인/직접 조작/초안/미종료 요청을 우회하지 못한다.
- `추가 전달 중지`: `이미 전달되었을 가능성은 남습니다. 이 지시를 더 보내지 않을까요? 뒤 지시는 입력 안전 확인 후 계속됩니다.`를 확인한다. 수신 여부를 판정하지 않고 소유자 포기로 기록한다. 세션 소실 때 이를 통해 미해결 지시를 정리한 뒤 기존의 명시적인 `새 세션으로 이어가기`를 사용할 수 있다. 새 세션에 옛 지시를 자동 복사하지 않는다.

`받음으로 기록` 버튼이나 `confirm_received` API는 만들지 않는다. 사람의 터미널 입력 자체도 수신 증거가 아니다. 조작권 해제 뒤 시스템이 다시 확인한다. 해결된 안내는 다음 폴링에서 사라지고 자동 정정·재전송·제출 복구는 모두 활동에 남는다.

연결 끊김에는 마지막 결과·조회 시각과 `마지막 확인 상태 · 연결되면 다시 확인합니다`를 표시하고 쓰기를 막는다. 샘플은 명시적인 읽기 전용이다. 프로젝트·대상 전환 시 초안이나 예외 요청을 다른 팀원에게 보내지 않는다.

## 서버 API·DB

### 전달 표식과 전송 봉투

새 큐 항목마다 128비트 난수의 `#iamceo_<base64url 토큰>`을 생성하여 UNIQUE로 저장한다. delivery ID와 1:1이며 재시도·재시작 때 유지한다. 인증 토큰이 아니며 API 인증에 사용하지 않는다. 지시 끝 한 줄에만 넣고 기존 `#msg_…`·결재·todo ID는 원본 참조로 유지한다. 본문 속 유사 문자열을 서버 표식으로 채택하지 않는다.

한 번의 `runner.send`에 들어갈 항목 집합을 전송 봉투(dispatch)로 저장한다. 봉투에도 `#iamceo_b_<토큰>`을 붙인다. wire text는 각 본문+개별 표식, 마지막 봉투 표식 순서다. 봉투·구성 항목·wire text SHA-256·세션 식별·기록 기준선을 **외부 쓰기 전에** DB에 커밋한다. 소켓 I/O 동안 DB 트랜잭션을 열어 두지 않는다.

- 개별 표식만 확인되면 해당 항목만 받음이다. 올바른 사용자 입력 이벤트에서 봉투 표식을 확인하면 저장된 봉투 구성 모두를 받음 처리할 수 있다. assistant 인용이나 현재 입력칸의 표식은 수신 증거가 아니다.
- 재전송은 미해결 항목만 새 봉투에 넣고 같은 delivery ID·개별 표식을 유지한다. 이미 받은 항목은 다시 묶지 않는다. 원문/대상/첨부를 수정하거나 새 delivery 행을 만들지 않는다.
- herdr 긴 글 축약문에는 봉투 표식을 반드시 남기고 원본 파일과 봉투의 관계를 저장한다. `[Pasted text …]`만 보이면 unknown이다. 전체 composer를 복원할 수 없는 축약 입력은 제출만 복구하지 않는다.
- 대표 메시지·결재 답·todo·일반/urgent·첫 지시·시스템·인계 등 큐 지시의 모든 진입점을 통합한다. `compact/setParallel` 같은 CLI 제어 명령에는 표식으로 문법을 깨지 않는다. 제어 실패는 수신 증거가 아니다. manual 멤버의 wait 응답은 기존 HTTP 경로를 유지하고 CLI 기록 수집 대상과 구분한다.

### 로컬 기록 형식 확인 결과

이 Mac의 기록 파일을 읽기 전용으로 열어 키와 자료형만 확인했다. 본문·사용자 ID·세션 ID·경로 값·지침·도구 내용은 출력하거나 복사하지 않았다. 최초 최근 각 8개, 추가로 Claude 80개/Codex 57개의 제한된 앞·뒤 구간을 확인했다. 모든 버전/전체 파일을 검증한 것은 아니다. 라이브 서버·`~/.iamceo`·herdr 소켓에 접근하지 않았다.

| 제공자 | 직접 관측한 필드 구조 | 판정 계약 |
| --- | --- | --- |
| Claude | 루트 `type, sessionId, cwd, uuid, timestamp, isSidechain`; `message.role`, 문자열 `message.content` | `type=user`, `role=user`, 일치하는 세션/cwd, 주 세션의 텍스트에서만 표식 검사 |
| Claude 배열 | `message.content[]`에 `type, tool_use_id, content, is_error`인 도구 결과도 user 행에 있음 | tool_result 내용은 검사하지 않음. 기존 transcript.ts가 지원하는 `{type:"text",text:string}` 배열은 호환 지원하되 이번 표본에서 그 텍스트 배열을 관측했다고 주장하지 않음 |
| Codex 메타 | 루트 `type,timestamp`, 선택 `ordinal`; `session_meta.payload`의 `id,session_id,cwd,timestamp,cli_version,source,originator` 등 | 경로명이 아닌 metadata native ID/cwd 검증. id와 session_id가 함께 있으면 일치해야 함 |
| Codex 사용자 입력 | `type=response_item`, `payload.type=message`, `payload.role=user`, `payload.content[]`의 `type,text`; 선택 `payload.id` 및 메시지 metadata | 사용자 입력 텍스트 블록만 사용. 지침·assistant·도구 출력·재생된 옛 입력 제외 |
| Codex 호환 이벤트 | 이번 표본에서 `event_msg/payload.type=user_message`를 찾지 못함 | `{type:"event_msg",payload:{type:"user_message",message:string}}` 호환 어댑터는 합성 fixture로 별도 시험. 이 형식이 없다고 미수신으로 판단하지 않음 |

Claude 위치는 주입된 claudeHome 또는 `CLAUDE_CONFIG_DIR` 아래 `projects/<cwd 키>/<sessionId>.jsonl`이며 기본은 `~/.claude`다. 현재 transcriptPath의 cwd 인코딩을 재사용한다. 다른 cwd 디렉터리에서 같은 ID를 찾을 때도 내용의 session/cwd를 검증한다. Codex는 주입된 codexHome 또는 `CODEX_HOME`의 `sessions/**/rollout-*.jsonl`에서 metadata를 확인한다. 기록 파일은 수정하지 않는다.

현재 core의 Codex native ID 미탐색 제약도 해결한다. 시작 시 후보 파일/시각 기준선을 저장하고 같은 cwd 후보 중 **이번에 보낸 예측 불가능한 표식**이 실제 user 입력으로 나온 파일만 native ID에 연결한다. metadata ID를 저장하고 기존 session 이벤트를 낸다. 최신 파일/cwd/이름만으로 고르지 않는다. 후보 충돌이나 표식 부재는 session_unbound다. 재시작도 봉투의 기준선을 재사용한다. 문맥 수집용 `readCodexContext`의 꼬리 검색을 전달 부재 판정에 재사용하지 않는다.

### 증거 수집기와 판정 계약

신규 `server/runner/delivery-evidence.ts`가 제공자 기록 파서·경로 검증·증거 결합을 맡는다. core/herdr는 화면·composer·실행 상태를 공급한다. 제공자와 실행기를 분리하여 core+Claude, core+Codex, herdr+현재 지원 Claude를 구현한다. herdr의 Codex 실행 기능을 새로 만드는 작업은 아니다.

```ts
type EvidenceVerdict = "present" | "absent" | "unknown";
interface DeliveryEvidence {
  source: "claude_log" | "codex_log" | "core_screen" | "herdr_screen" | "transport";
  verdict: EvidenceVerdict;
  location: "received_input" | "composer" | "history" | "none";
  code: string;
  complete: boolean;
  checkedAt: string; // UTC ISO 8601
}
type DeliveryFinding = "received" | "not_received" | "draft_only" | "wait" | "unknown";
```

code 예: marker_in_user_input, complete_range_without_marker, draft_matches, partial_log, file_missing, unrecognized_layout. 내부 snapshot에는 native session/세대·terminal 소유권·process 식별·turn/input epoch·CLI 상태·lease·원래 쓰기 종료 여부·전체 composer 일치 여부가 추가된다. 원시 화면·프롬프트·호스트 경로는 API에 내리지 않는다.

기록 수집 규칙:

1. 전송 전 inode/파일 식별과 완성된 JSONL offset을 저장하고 이후를 증분 파싱한다. 재시작/옛 항목은 세션 기록을 스트리밍 탐색한다. 작업당 4MiB 후 offset부터 이어 간다. 아직 읽지 못한 구간이 있으면 unknown이며 전체 파일을 메모리에 올리지 않는다.
2. 파일 없음·권한 오류·중간 손상·inode 교체/truncate·미지원 형식은 unknown이다. 부분 마지막 줄은 다음 작업에 이어 읽는다. mtime/크기 안정·임의 대기 시간만으로 flush 완료를 주장하지 않는다.
3. user 이벤트 두 형식에 같은 표식이 나와도 `(세션 세대, delivery ID)` 하나로 합친다. resume의 옛 입력 재생은 전송 기준선/이벤트 ID로 제외한다. `isSidechain/isMeta`, tool_result, developer/system/assistant/tool의 표식은 수신 증거가 아니다. 원시 JSON 문자열 includes를 금지한다.
4. 정확한 토큰 경계를 확인하고 텍스트 블록을 읽는다. 임의 공백 제거/Unicode 정규화로 다른 표식을 같게 만들지 않는다. 다른 세션에서 발견하면 잘못 전달됐을 수 있는 충돌 증거로 올리고 현재 대상 수신/재전송을 확정하지 않는다.
5. core는 `terminal.read`로 화면과 composer를 분리하고 `terminal.get`/OSC 7501을 함께 본다. herdr는 `pane.read`의 visible/recent_unwrapped와 agent 상태를 함께 본다. 일반 history의 표식은 보조 증거다. 화면의 현재 입력칸·assistant 인용·Pasted text는 received가 아니다.

**부재 승격 조건:** 개별 증거의 absent는 수집 범위에서 없다는 뜻이다. 전체 not_received는 아래 전부가 참일 때만 나온다.

- 원래 세션/terminal·generation·소유권이 유지됨.
- 필요한 로그 범위가 완전하고 history/composer 어디에도 표식이 없음. 단, 이 delivery의 모든 이전 시도가 쓰기 전 실패/부작용 없는 거절로 확정되었다면 아직 생성되지 않은 로그의 부재 증명은 요구하지 않는다. 현재 시도 하나의 not_written으로 과거 unknown 시도까지 미전달로 만들지 않는다.
- 전체 입력칸이 확실히 비었고 승인/선택/로그인/셸/축약 붙여넣기 상태가 아님.
- 신뢰할 수 있는 idle/done이며 직접 조작·설정 변경·compact·다른 send가 없음. Member.status만으로 판정하지 않음.
- **원래 쓰기가 나중에 실행되지 않음:** not_written 또는 부작용 없는 명시적 거절이거나, 원래 작업 완료와 입력 큐 소진을 증명하는 검증된 실행기 장벽이 있음.

현재 core generation 1/herdr 읽기 RPC에는 요청별 영수증·멱등 키·명시적인 drain 보장이 없다. timeout/소켓 종료·unchanged turn·연속 두 번 빈 화면은 마지막 조건의 증명이 아니다. 이미 쓴 요청이 미종료이면 로그/화면에 없어도 unknown으로 계속 확인한다. post-write 부재 자동 재전송은 해당 고정 실행기 버전에서 장벽 의미를 확인한 조합에만 활성화한다. 없는 RPC를 구현된 것처럼 가정하지 않는다. 확인하지 못한 경우 자동 정정과 쓰기 전 실패 복구는 가능하지만 post-write 부재 재전송은 차단한다.

정상 전송 응답도 의미를 구별한다. 실행기가 실제 paste+submit 완료를 보증하는 기존 성공 응답은 received 영수증으로 사용할 수 있지만, 단순 RPC 접수/붙여넣기 시작/working 상태는 그렇지 않다. core의 검증된 terminal.send 성공과 started:false의 기존 계약은 유지한다. herdr의 조회 실패를 성공으로 바꾸는 휴리스틱은 영수증이 아니다. 성공 응답과 이후 로그 증거가 같은 봉투에 도착하면 중복 정정 활동을 만들지 않는다.

이 경계가 대표의 수동 판정을 기본으로 만든다는 뜻은 아니다. ‘받았는데 실패 표시’는 기록으로 저절로 정정되고, 쓰기 전 연결 실패/명시적 거절은 자동 복구된다. 로그도 화면도 잃고 원래 쓰기 결과도 모르는 예외에서만 증거와 추천을 사람에게 올린다.

### 미제출 입력 복구와 직렬화

올바른 세션의 전체 composer가 저장 wire text와 일치하고 user 수신 기록이 없으며 원래 쓰기가 settled이면 draft_only다. 검증된 렌더링 줄바꿈 복원 외에는 본문을 변형하지 않는다. 일부 표식만 있음·사람이 고친 초안·잘린 화면·Pasted text placeholder는 제출하지 않는다.

draft_only는 팀원 입력 mutex 안에서 로그→상태→composer→DB version/epoch를 다시 확인한 뒤 **Enter만 한 번** 보낸다. core `terminal.keys`, herdr `agent.send_keys`를 사용하되 메서드 지원과 해당 CLI의 제출 의미를 검증한다. 자동 복구 중 clearInput/Ctrl-U/Escape/Delete/본문 재붙여넣기/승인 메뉴 선택은 금지한다. 원래 RPC가 뒤늦게 Enter를 칠 수 있으면 제출도 금지한다. 키 응답 유실에는 반복 Enter 대신 checking으로 돌아간다. 제출 키 성공만으로 수신 확정하지 않고 user 기록/검증된 수신 영수증을 기다린다.

자동 send·repair·terminal/control·승인 응답·설정/세션 변경은 동일한 팀원별 입력 mutex/epoch를 사용한다. lease claim은 진행 중 mutation 후 성립하며 유효 lease 동안 자동 입력과 기록 스캔을 보류한다. release/만료 후 재검사한다. 외부 `iamceo attach`는 현재 이 mutex를 따르지 않아 완전한 원자성은 없다. 관측 가능한 외부 입력/attach는 epoch를 무효화한다. 일반 화면 두 번 확인만으로 외부 입력과 원자적이라고 주장하지 않는다.

### 판정·복구 상태기계

기존 DeliveryStatus의 5값은 유지하고 recovery phase를 추가한다.

| phase | 동작 | 기존 상태 투영 |
| --- | --- | --- |
| none | 평상시 큐 | 기존 값 |
| checking | 오류/유실/재시작 후 증거 확인 | held, hold_reason=delivery_unknown |
| waiting | 승인/lease/working/일시 단절 해제 대기 | held/unknown, 별도 reason에 실제 이유 |
| retry_wait | 확실한 미전달의 backoff, 직전 다시 검사 | 대기 중 held, 실제 쓰기 중 delivering |
| needs_owner | 증거 소실/미지원/복구 상한 | 불확실하면 held/unknown, 확실한 미전달 실패는 failed |
| resolved | 증거로 수신 확인·정정 | delivered |
| stopped | 소유자 추가 전달 포기 | failed + 미판정 포기 note |

판정 우선순위는 올바른 user 기록의 received → 안전 상태 대기 → draft_only → not_received → unknown이다. lease 중 수집은 보류한다. 다른 일/승인 중에도 이미 얻은 긍정 증거의 DB 정정은 가능하지만 후속 입력은 기존 상태 검사에서 막힌다.

기록과 composer 둘 다 같은 표식이면 이미 받은 지시가 중복 초안으로 남은 것일 수 있다. delivery는 delivered로 정정하되 phase=needs_owner, reason=duplicate_draft로 두고 해당 팀원의 입력 fence를 유지한다. 초안을 자동 삭제/제출하지 않는다. 사용자가 초안을 정리한 뒤 확인하면 resolved다. 수신 건수를 unknown으로 되돌리지 않는다.

- 확인 스케줄: 즉시, 1·3·10·30초, 이후 60초 간격. 활성 확인 2분 후에도 증거가 없으면 needs_owner. 파일 완전 소실/미지원은 필요한 탐색 후 조기 승격 가능. 작업 중/승인/유효 lease 대기 시간은 2분 예산에서 제외한다. 장기 backend 단절은 기존 연결 문제와 합친다.
- 자동 재전송은 최초 쓰기 외 최대 3회, backoff 2·10·30초 + 0~20% jitter. 제출만 복구는 봉투당 1회. 확인 횟수와 쓰기 횟수는 분리한다. 시계/타이머/난수를 주입한다.
- next_check_at·횟수·활성 시간은 DB에 보존한다. 중복 tick/recheck는 합치고 재시작이 상한을 초기화하지 않는다. needs_owner에서도 새 기록/연결/lease 해제로 읽기 확인은 재개하여 긍정 증거가 생기면 자동 해소한다. 상한 이후 새 쓰기는 예외 허용 없이는 하지 않는다.
- 미확인이 하나라도 있으면 같은 팀원의 뒤 큐와 urgent를 막는다. 다른 팀원은 진행한다. 묶음 일부를 정정해도 나머지가 미확인이면 차단을 유지한다. stopped는 명시적 포기이므로 차단에서 제외한다.
- 재전송 직전 같은 mutex에서 기록 offset·화면·session/epoch·DB version을 다시 검사한다. 그 사이 표식이 생기면 정정만 하고 send=0이다. 오래된 snapshot으로 타이머가 무조건 send하지 않는다.
- DB 준비 전에는 외부 쓰기가 없어야 한다. 준비 커밋 후 crash는 쓰기 여부를 추정하지 않고 checking. 성공 후 DB 반영 전 crash는 표식으로 복구한다. 늦은 send error가 이미 정정한 delivered를 held로 되돌리지 못하게 CAS한다.

stopped가 해제하는 것은 해당 지시의 논리적인 미확인 차단뿐이다. 원래 RPC가 미종료이면 runner의 물리 입력 fence는 유지한다. 뒤 지시도 쓰기 종료/기존 terminal 종료가 확인되어야 진행한다. 새 세션 전환은 옛 terminal이 확실히 사라졌거나 소유자의 기존 명시적 종료 절차를 마친 뒤에만 가능하며, 단순 연결 실패를 세션 종료로 간주하지 않는다.

실행기 확장 제안(현재 구현된 export가 아님):

```ts
// server/runner/types.ts, 비지원 실행기를 깨지 않도록 optional
inspectDelivery?(m: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection>;
repairDelivery?(m: RunnerMember, request: DeliveryRepair): Promise<SendResult>;
```

DeliveryProbe는 dispatch ID, 표식들, 저장 session/generation/기준선/해시를 가진다. DeliveryInspection은 evidence[], finding, snapshot, `quiescence:"settled"|"unresolved"`를 반환한다. DeliveryRepair는 `action:"resend"|"submit_only"`, dispatch ID, expected recovery version, expected session/input epoch를 받는다. 임의 본문을 받지 않고 저장 봉투를 재검증한다. hook 없음은 unsupported/unknown이다. SendResult 실패에 optional `deliveryEffect:"not_written"|"rejected"|"unknown"`를 추가하고 client가 쓰기 전/후 실패를 보존한다. 모르는 오류는 unknown이다.

core Track.uncertain은 claim/사람 입력 자체로 풀지 않고 증거 정정 또는 검증된 repair가 DB version/dispatch를 확인한 뒤 해제한다. 재시작에는 DB 미해결 봉투에서 fence를 복구한다. herdr promptSeen/delivered의 substring·working·조회 실패=true 처리와 timeout의 clear/retry를 새 경로로 대체한다. 기존 control command는 별도 회귀 시험을 유지한다.

onTurnUnread/세션 오류 재시도도 통합한다. 수신 표식이 있으면 delivered를 유지하고 처리 오류를 기존 오류 활동/팀원 오류로 따로 알린다. noOutput/사용량 한도/결과 부재만으로 지시를 다시 넣거나 결재를 다시 열지 않는다. 기존 작업 재시도와 전달 복구가 같은 글을 동시에 실행하지 않게 단일 경로를 사용한다.

### DB 마이그레이션·원본 버전·활동

server/db.ts의 MIGRATIONS 끝에 추가한다. 동시 작업의 마지막 context_window 마이그레이션을 수정하거나 버전 번호를 선점하지 않는다. 기존 openDb의 VACUUM INTO 백업과 단계별 transaction을 유지한다. 기존 열/상태값을 삭제하지 않는다. 시각 TEXT는 UTC ISO 8601이다.

```sql
CREATE TABLE delivery_recovery (
  delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
  marker TEXT UNIQUE,
  phase TEXT NOT NULL DEFAULT 'none'
    CHECK (phase IN ('none','checking','waiting','retry_wait','needs_owner','resolved','stopped')),
  reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  auto_attempts INTEGER NOT NULL DEFAULT 0 CHECK (auto_attempts >= 0),
  check_count INTEGER NOT NULL DEFAULT 0,
  active_check_ms INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT,
  last_checked_at TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE INDEX delivery_recovery_due ON delivery_recovery(phase,next_check_at);
CREATE TABLE delivery_dispatches (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  bundle_marker TEXT NOT NULL UNIQUE,
  cli TEXT NOT NULL,
  backend TEXT NOT NULL,
  generation INTEGER NOT NULL,
  native_session_id TEXT,
  terminal_identity_json TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  wire_text TEXT NOT NULL,
  wire_sha256 TEXT NOT NULL,
  transport_state TEXT NOT NULL
    CHECK (transport_state IN ('prepared','write_started','accepted','rejected','unknown')),
  submit_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX delivery_dispatches_member ON delivery_dispatches(member_id,created_at);
CREATE TABLE delivery_dispatch_items (
  dispatch_id TEXT NOT NULL REFERENCES delivery_dispatches(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  source_revision TEXT,
  PRIMARY KEY (dispatch_id,delivery_id),
  UNIQUE (dispatch_id,ordinal)
);
CREATE INDEX delivery_dispatch_items_delivery ON delivery_dispatch_items(delivery_id);
CREATE TABLE delivery_recovery_operations (
  operation_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE activity ADD COLUMN delivery_event_key TEXT;
CREATE UNIQUE INDEX activity_delivery_event ON activity(delivery_event_key)
  WHERE delivery_event_key IS NOT NULL;
```

세대는 기존 members.session_generation을 쓴다. source_revision은 메시지의 불변 본문/첨부/대상 해시, 결재의 answeredAt·choice·note·업데이트판, todo의 done상태/시각/알림본문 판을 저장한다. ref없는 지시도 wire text를 불변 원본으로 취급한다. 재전송 전 현재 원본 유효성을 확인하여 취소/변경된 답이나 체크를 복원하지 않는다.

기존 행은 marker=null, phase=none으로 backfill한다. 과거에 안 보낸 새 표식으로 과거 수신을 확인하지 않는다. delivering/unknown/애매한 failed는 legacy 확인으로 전환한다. 옛 `#원본ID`는 주 세션 user 입력·대상·시점·본문·시도의 유일성까지 증명할 때만 정정에 사용한다. 같은 todo ID 반복/묶음 구성 불명은 unknown이다. 전송 이력이 없는 queued에는 첫 쓰기 전에 새 표식을 부여할 수 있다.

`baseline_json`에는 제공자 파일 식별/완성된 offset/scan cursor, 전송 전 terminal turn·input epoch, 시도 소유 서버 epoch를 저장한다. 프로세스 재시작 뒤 prepared/write_started만으로 not_written을 추정하지 않는다. `terminal_identity_json`에는 소유 label·pane 주소·가능한 process 식별을 넣는다. JSON의 필수 필드가 손상/부재이면 unknown으로 처리하며 임의 기본값으로 안전성을 복원하지 않는다.

recovery version 조건 CAS와 member mutex를 사용한다. 수신 사실·메시지 delivery·해당 판의 결재 전달 상태·recovery·활동을 한 transaction으로 갱신한다. 원본이 다른 판이면 옛 delivery 수신 사실만 남기고 새 원본 상태를 덮지 않는다. todo 업무 완료는 바꾸지 않는다. cancelPendingFor는 unknown을 삭제하지 않고 source_changed로 재송신만 금지하며 증거 수집은 계속한다. 보관/close/세션 교체도 같은 mutex와 기존 미해결409 보호를 유지한다. 자동 새 세션/제공자 변경은 하지 않는다.

활동은 기존 ActivityKind=system을 쓴다. 예: `전달 기록에서 수신을 확인해 표시를 바로잡았습니다`, `미전달을 확인해 같은 지시를 자동 재전송했습니다(1/3)`, `입력칸의 지시를 다시 넣지 않고 제출했습니다`. delivery ID·시도·근거 code를 기록하고 프롬프트/파일 경로/토큰은 넣지 않는다. event key는 dispatchId:deliveryId:action:sequence로 유일화한다. DB 상태와 함께 커밋하고 commit 후 기존 bus를 emit한다. 예약·실제 시도·결과를 구분하여 기록하며 확인 tick마다 활동을 쌓지 않는다.

기존 활동은 건수 제한으로 삭제되므로 무기한 감사 보관을 약속하지 않는다. 미해결 recovery/dispatch/operation은 지우지 않는다. 해결/중지 후 상세 봉투는 30일 뒤 청소 가능하다. 마지막 사용 시각 기준이며 작업 중/미해결 봉투는 제외한다. wire text는 기존 지시와 같은 기밀로 0600 DB에만 저장한다.

정정의 중복 방지는 activity의 존재만 믿지 않는다. 활동이 정리되어도 recovery의 종결 상태/version과 dispatch의 시도 번호로 같은 자동 효과를 다시 적용하지 않는다. operation 결과는 delivery가 남아 있는 동안 유지하여 응답 유실 재요청을 보존한다. 30일 청소는 상세 봉투 본문/해결된 기준선에만 적용하며 stable marker·최종 판정·멱등 결과를 지우지 않는다.

### 팀원 집계와 조회 API

모두 기존 사용자 Bearer 인증을 적용하고 MCP token의 agentRoutes에 추가하지 않는다. GET은 DB만 읽고 runner를 시작/조작하지 않는다. 없는 대상·보관 프로젝트는404다. 임의 기록 경로를 지정하는 API는 없다.

기존 `GET /api/projects/:id/state`에 optional deliveryNotices를 추가한다. 새 서버는 항상 반환하고 클라이언트는 부재를 미지원으로 구별한다.

```ts
interface DeliveryNotices {
  version: 2;
  members: MemberDeliverySummary[]; // state.members와 동일 순서, 0건도 포함
  unassigned: { undeliveredCount: number; unknownCount: number; needsOwnerCount: number };
}
interface MemberDeliverySummary {
  memberId: string;
  undeliveredCount: number; // queued + 일반held + 확실한 미전달failed
  unknownCount: number; // 수신 불확실, 미제출 포함
  deliveringCount: number;
  checkingCount: number; // checking/waiting/retry_wait, 위 집합과 중복 가능
  needsOwnerCount: number;
  waitingBehindCount: number; // 미확인 fence 뒤의 다른 미송신 항목
  oldestAt: string | null;
  reasons: { code: string; count: number; note: string }[];
}
```

undelivered/unknown/delivering은 배타적이다. checking/needsOwner/waitingBehind는 보조 집합이므로 총건수로 더하지 않는다. duplicate_draft는 delivered여도 needsOwner에만 포함한다. resolved/stopped는 미해결에서 제외한다. Member.queuedCount는 기존 queued/held의 유효 건수 의미를 유지한다.

최근 메시지가 아닌 전체 DB의 현행 delivery를 집계하며 결재·todo·시스템 지시도 포함한다. 과거 failed 중복은 같은 member/ref/source_revision의 최신 유효 시도만 표시하되 unknown은 뒤의 성공만으로 제거하지 않는다. delivery가 없는 옛 failed 메시지는 `message:<id>` 가상 항목으로 세고 확정 대상만 연결한다. 대상null이고 연결delivery도 없으면 unassigned로 두며 현재 총괄에게 추측 배정하지 않는다.

`GET /api/members/:id/delivery-notices?limit=50&before=<cursor>` →200:

```ts
interface DeliveryNoticePage {
  memberId: string;
  summary: MemberDeliverySummary;
  items: DeliveryNoticeItem[];
  nextBefore: string | null;
}
interface DeliveryNoticeItem {
  id: string; // delivery ID 또는 message:<id>
  deliveryId: string | null;
  messageId: string | null;
  memberId: string;
  projectId: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  phase: "none" | "checking" | "waiting" | "retry_wait" | "needs_owner";
  holdReason: string | null;
  reason: string | null;
  note: string;
  version: number; // 실제 recovery는 양의 정수, 가상 항목은0
  createdAt: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  autoAttempts: number;
  evidence: DeliveryEvidence[];
  recommendation: { code: string; text: string } | null;
  allowedActions: ("recheck" | "retry_with_risk" | "stop_retry")[];
  ref: { type: "message" | "decision" | "todo"; id: string } | null;
  preview: string; // 최대160문자, 내부 지시는 종류/관련 제목만
}
```

기본은 미해결 목록이며 delivered+duplicate_draft도 포함한다. limit=1~100 정수, 기본50. 부정확한 값/cursor는400. cursor는 base64url JSON `{v:1,memberId,createdAt,id}`, 대상 일치 검증 후 `(createdAt DESC,id DESC)` exclusive keyset이다. summary는 limit와 독립이고 state/상세는 같은 선택 조건을 공유한다. 행이 해결되어 페이지에서 사라져도 정상이며 클라이언트는ID 중복 제거 후 첫 페이지를 재조회한다. 기존 메시지/결재/todo를 ref로 열되 내부 wire text 전체를 공개하지 않는다.

preview는 일반 텍스트이며 HTML/Markdown으로 실행하지 않는다. 절삭 길이가 가변인 공용 함수는 `const safe = Math.max(0, maxLength); if (safe <= 3) return text.slice(0, safe)` 후 나머지 경우에만 말줄임표를 붙인다. 시각 표시에는 명시적인 날짜/시간 포맷 옵션을 전달하고 플랫폼 기본 날짜 형식에 의존하지 않는다. 각 조회는 한 DB 읽기 snapshot에서 summary와 items를 계산한다.

최근 200건 밖의 원래 대표 지시도 열 수 있도록 `GET /api/messages/:id`를 추가한다. 기존 사용자 Bearer 아래 store.requireMessage의 Message 전체(본문·대상·첨부 포함)를 200으로 반환한다. 없는 메시지/보관 프로젝트는 404이며 GET의 부작용은 없다. 내부 delivery.text를 이 경로로 공개하지 않는다. 결재는 기존 `GET /api/decisions/:id`로 열고, 이미 사라진 원본은 `원본을 찾을 수 없습니다`로 표시한다. 이 신규 조회도 HTTP 시험의 exact JSON·인증·보관 검증 대상이다.

기존 holdReason은 blocked/input_busy/asleep/offline/backend_down/runner_disabled/archived/legacy_session/send_error/turn_error를 유지한다. recovery reason은 manual_control/busy/draft_pending/duplicate_draft/log_missing/log_incomplete/session_unbound/session_lost/inflight_unsettled/unsupported_schema/source_changed/retry_exhausted 등이다. 알 수 없는 code는 `상세 내용을 확인해 주세요`로 표시하고 재전송을 허용하지 않는다. 승인/일하는 중 대기를 전달 기능의 추가 needsOwner로 중복 승격하지 않는다.

### 작업 API와 하위 호환

`POST /api/deliveries/:id/recovery`:

```ts
interface DeliveryRecoveryRequest {
  operationId: string; // UUID, 응답 유실 재요청에 재사용
  expectedVersion: number; // 양의 안전 정수
  action: "recheck" | "retry_with_risk" | "stop_retry";
  acceptDuplicateRisk?: true; // retry_with_risk 필수, 나머지는 금지
}
interface DeliveryRecoveryResult {
  operationId: string;
  deliveryId: string;
  outcome: "check_scheduled" | "retry_scheduled" | "stopped";
  committedVersion: number;
}
```

- recheck/retry는 202, stop은 200이다. 202는 예약 성공이며 수신 성공이 아니다. Zod strict schema로 JSON/추가 필드/UUID/version/action을 검증하고 잘못되면 400이다. OrchestratorApi에 optional 메서드를 추가하며 미지원이면 501이다. shared에 요청/응답 타입을 추가한다.
- recheck는 미해결 실제 항목에 확인을 예약한다. lease/승인/상한을 초기화하거나 우회하지 않는다. duplicate_draft 재검사도 가능하다.
- retry_with_risk는 needs_owner 중 증거 취득 불가/재전송 상한에서만 허용한다. mutex 안에서 원본 유효성·동일 세션·원래 쓰기 settled·빈 입력칸·수신 가능 상태를 다시 검사한다. 세션 소실/원본 변경/다른 초안/미종료 RPC/duplicate_draft에는 금지한다. 허용은 새 쓰기 한 번만 소비하며 자동 재전송 상한을 초기화하지 않는다.
- stop_retry는 needs_owner이고 입력 mutation이 없을 때만 허용한다. phase=stopped, delivery/message=failed와 `추가 전달을 중지했습니다. 과거 수신 여부는 알 수 없습니다` note를 기록한다. 수신/업무 완료/결재를 대신 확정하지 않는다. duplicate_draft에는 허용하지 않으며 초안 정리가 필요하다.
- 상태/version/허용 조건 변경은 409 `{error:"전달 상태가 바뀌었습니다. 다시 확인해 주세요"}`, 없는 대상은 404다. 같은 operationId/대상/요청은 저장 결과를 반환하여 두 번 예약하지 않는다. 다른 body/대상으로 재사용하면 409다. 성공 재응답은 version 검사보다 먼저지만 인증/소속 검사는 항상 한다.
- 가상 옛 메시지는 version=0이므로 이 POST 대신 기존 동일 메시지 ID 재시도 진입점으로 실제 회복 항목을 만든다. 원문·확정 수신자를 보존하고 새 전송 없이 legacy 확인으로 시작한다. 대상이 확정되지 않으면 409로 거절하고 담당 불명 안내를 유지한다.

기존 `POST /api/projects/:id/messages` 요청 `{id?,text,targetMemberId?,attachmentIds?}`와 200 Message 응답, Message.delivery의 5값, 기존 WsEvent 종류를 유지한다. 새 서버 필드를 이전 웹이 보내도록 요구하지 않는다.

failed의 동일 message ID 재요청은 resendMessage 안에서 최신 DB를 읽고 같은 mutex로 회복 경로에 합친다. 최신 delivery가 있으면 같은 행을 사용한다. 애매한 failed에 새 delivery를 만들어 즉시 보내지 않는다. 200으로 현재 Message를 반환하며 확인 중이면 held와 `전달 여부를 시스템이 확인하고 있습니다` note로 설명한다. 저장 본문/대상/첨부는 덮지 않는다. stopped는 기존 failed/note를 200으로 반환하여 되살리지 않는다. 확실히 쓰기 전 실패일 때는 기존 재시도 결과를 유지할 수 있다. 반복 요청과 자동 복구 경합의 이중 send는 서버에서 방지한다.

state는 추가 필드만 넣고 기존 필드를 삭제하지 않는다. 새 WsEvent를 만들지 않고 commit 후 기존 message/member/activity 이벤트를 보낸다. 네이티브는 기존 3초 폴링을 쓴다. APNs/WebSocket 개선은 불필요하다. docs/spec.md의 ‘미확인은 자동 재전송 금지’를 ‘증거로 미전달과 안전을 확인한 경우에만 자동 복구’로 갱신하고 무조건 재전송 금지는 유지한다.

## 웹 변경

없음(하위 호환만). 읽은 `web/src/screens/Thread.tsx`는 delivery의 5값과 deliveryNote를 표시하고 failed에서 같은 message ID로 다시 보낸다. Team.tsx도 마지막 지시의 상태/note를 표시한다. 이 계약을 서버에서 유지한다. 소유자가 네이티브 안정화 후 기존 웹을 버릴 예정이므로 새 집계·배지·조작·상태 관리 기능을 추가하지 않는다. web/ 수정 파일은 없다.

## 네이티브 변경

(Mac·iOS)

- Models.swift: state 집계/상세/증거/요청·응답 Codable·Sendable을 추가한다. decodeIfPresent로 필드 부재와 0건을 구별한다. 미지 phase/reason/action은 문자열로 수용하여 안전한 표시·무조작으로 처리한다.
- AppStore.swift: memberId 기반 summary 참조, 상세 조회/작업 요청을 기존 APIClient request/send로 구현한다. operationId 재사용·pendingActions·canWrite·projectGeneration을 지켜 대상 전환 후 늦은 응답을 버린다. 202 후 재조회하며 낙관적인 ‘받음’을 만들지 않는다. APIClient 변경은 필요 없다.
- Design/Presentation.swift: 기존 DeliveryInfo(_:)를 보존하고 summary/item을 받는 확장으로 확인 중/자동 재전송/요확인 표시를 계산한다. 새 서버에는 한국어 접두어/최근 메시지/본문 일치 기반 판정을 쓰지 않는다. 옛 서버에만 기존 fallback을 남긴다. 카드 유리·색·공통 토큰은 변경하지 않는다.
- 신규 Views/DeliveryNoticeView.swift: 원문/관련 항목 링크, 증거별 확인됨/해당 없음/취득 불가, 시각, 추천, allowedActions와 예외 확인을 공통 구현한다. 내부 지시 전문/세션 파일/원시 화면은 패널에 넣지 않는다.
- TeamView.swift: MemberDetailView.content의 summary 다음 한 곳에 공통 패널을 삽입한다. 자동 처리는 작은 상태 줄, needsOwner는 근거와 행동을 표시한다. 최근 대화 상태도 summary를 참조한다. 기존 approval/config/terminal/activity와 초안은 보존한다.
- HomeView.swift: HomeAttention/HomeTurn이 새 집계의 needsOwnerCount>0만 전달 개입으로 올린다. 승인·팀원 오류와 memberId로 합치고 여러 메시지는 상세에 모은다. unassigned는 담당 불명으로 표시한다. 확인 중을 ‘내 차례’에 넣지 않는다.
- ChatView.swift: 새 서버의 회복 중 항목은 확인 중으로 표시하고 failed 재전송은 회복 상세 진입으로 대체한다. 옛 서버만 기존 재시도를 유지한다. 뒤에서 옛 POST로 복구 조건을 우회하지 않는다.

사무실 변경은 **OfficeView.swift만** 대상으로 한다. OfficeNameplate에 optional summary 하나를 전달하고 needsOwner만 작은 `전달 확인 N`으로 표시한다. deskControl의 help/VoiceOver에 정확한 건수와 기존 상세 안내를 추가한다. 클릭은 기존 MemberDetailView를 열며 명패에서 직접 재전송하지 않는다. 폭이 부족하면 help/접근성 표현을 우선한다. 전체 맵/좌표/hit test/캐릭터/결재 배지의 의미를 바꾸지 않는다.

Views/Office/OfficeMap·OfficeArt·OfficeSprites·OfficeRender·OfficePixels·OfficeCast는 수정 불필요하다. 다른 담당에게 데이터 전달·명패·접근성의 세 접점만 넘기고 OfficeView 전체를 덮어쓰지 않는다.

Mac은 기존 팀원 drawer, iOS는 기존 상세 push 안에 같은 패널을 쓴다. iOS도 hover 없이 근거를 열 수 있게 한다. 큰 글자·VoiceOver·긴 한국어·99건 초과·연결 단절·샘플 읽기 전용을 공통 검증한다. 상시 팝업이나 새 푸시 체계를 추가하지 않는다.

## 시험

이번 설계 작업에서는 코드 빌드/런타임 시험을 실행하지 않는다. 설계서 필수 절·구현 경로와 제안 DDL 문법만 인메모리로 검증했다. 아래는 구현 시 추가할 시험이며 실행 완료 기록이 아니다.

격리 조건: fixture별 mkdtemp 아래 IAMCEO_HOME·claudeHome·codexHome·core state/config·프로젝트 cwd·DB·socket을 둔다. `IAMCEO_TEST=1`, `IAMCEO_PORT=0`, HTTP는 127.0.0.1 동적 포트만 사용한다. env는 인자/자식 프로세스로 주입하고 공통 HOME/CODEX_HOME을 바꾸지 않는다. 제공자 home 미주입 시 fixture 실패로 처리한다. 실제 기록/7878/기본 herdr socket/~/.iamceo fallback을 금지한다. 합성 JSONL·가짜 RPC·가짜 화면만 쓰고 실제 CLI를 띄우지 않는다. finally에서 자기 임시 루트만 청소한다.

| 경우 | 가짜 증거 | 반드시 확인할 결과 |
| --- | --- | --- |
| 들어갔는데 실패 표시 | 주 세션 user에 표식, DB held/unknown 또는 failed | 자동 delivered, send 0회, 활동 한 번, 해당 팀원 뒤 큐 해제 |
| 진짜 안 들어감 | 완전 로그·화면에 없음, 빈 composer, idle, not_written/검증된 settled | backoff 후 같은 delivery/표식으로 한 번, 메시지 행 증가 없음 |
| 입력칸에 남음 | 온전한 wire text, 미수신, 원래 RPC settled | Enter 1회, 본문 send 0회, clear/삭제/승인 키 0회, 수신 기록 후만 delivered |
| 일부 입력/수정 초안 | 표식만/잘림/placeholder/다른 글 | Enter 0회, send 0회, unknown 유지 |
| 승인 창 앞 | blocked/승인 화면 | 자동 입력 0회, 대기 시간 상한 제외, 해제 후 다시 확인 |
| 직접 조작 중 | lease, repair 직전 claim | 자동 입력/파일 scan 0회, mutation 직렬, 해제 후 확인 |
| 증거 없음 | 파일 없음/권한 오류/세션 소실 | 미수신 단정 금지, needs_owner에 근거·추천, 새 세션 자동 생성 0회 |
| 늦은 원래 쓰기 | timeout 뒤 늦게 paste/Enter | 빈 화면/소켓 종료만으로 재전송 0회, 기록 출현 후 자동 정정 |
| 재전송 직전 수신 | backoff 중 기록에 표식 추가 | 마지막 재검사로 send 0회 |
| 이미 수신+중복 초안 | 로그와 composer에 동시에 표식 | delivered+duplicate_draft, Enter/삭제 0회, 입력 fence 유지 |

추가 시험 목록:

1. tests/delivery-evidence.test.ts: Claude 문자열/텍스트 배열/sidechain/meta/tool_result, Codex 관측 형식/호환 event/중복 형식/옛 입력 재생, assistant 인용/토큰 부분 일치/다른 session·cwd를 시험한다. 기록 이동/회전/truncate/부분 행/손상/거대 행/4MiB 분할·재개에서 불완전 탐색이 absent가 되지 않아야 한다. 같은 cwd의 동시 Codex를 최신 시각만으로 연결하지 않아야 한다.
2. tests/delivery-recovery.test.ts: 표의 각 상태, 3회 backoff/제출 1회/재시작 상한, 시계 역행/큰 진행, 대기 예산 제외, 같은 팀원 직렬/다른 팀원 진행, 복수 unknown을 검증한다. 부분 묶음/봉투 표식/긴 글 stub, urgent fence, 늦은 실패도 가짜 시계로 재현한다.
3. tests/core-runner.test.ts: 기존 가짜 socket을 확장한다. 불완전 terminal.read/빈칸 오인/ownership 변경/Codex ID 미지/응답 유실/keys 미지원/uncertain 증거 해제/if:idle와 force:false 유지/attach epoch 변화/Enter 응답 유실 시 비반복을 확인한다.
4. tests/herdr.test.ts: 가짜 RPC/화면으로 composer·assistant·tool 표식 오판 금지, read 실패를 성공으로 처리하지 않음, timeout 뒤 clearInput 0회, 긴 글 봉투 보존, 같은 todo ID 반복을 시험한다. 기존 compact/setParallel/approval 회귀도 확인한다. 라이브 herdr harness는 사용하지 않는다.
5. tests/orchestrator.test.ts: recover의 실행기별 판정, 일반/urgent/첫 지시/결재/todo/시스템 표식, 기존 retry와 중복 없음, noOutput의 수신 재전송 금지를 검증한다. 원본 판 변경/cancelPendingFor/보관/교체/close/stopped 후 명시적 새 세션/manual wait도 시험한다.
6. tests/core.test.ts·tests/unified.test.ts: 옛 DB append migration/백업 실패 무변경/context 열 보존/CAS 경합/활동 key 중복/rollback 시 bus 0회/operation 멱등을 시험한다. 200건 밖 전달 집계/옛 failed 중복·가상 행·미배정/30일 청소의 미해결 보존도 확인한다.
7. tests/http.test.ts: exact JSON, 401·MCP token 금지, 400·404·409·501, limit·cursor, 응답 유실 operation 재사용, GET 무부작용, 예외 재전송 게이트를 검증한다. stopped의 구 POST 재생 금지/옛 200 응답·5값/shared 추가 필드 호환도 포함한다. web 코드 변경 없이 기존 web-runtime/web-lib 회귀도 확인한다.
8. native ContractTests.swift: 새/옛 state·미지 phase/reason decode, 기존 DeliveryInfo 초기화, 팀원 단위 집계, 확인 중의 홈 제외, 미배정을 총괄에게 전가하지 않음, 99+와 정확한 접근성 숫자를 검증한다.
9. native NetworkTests.swift·ConnectionLossTests.swift: 가짜 URLProtocol/격리 HTTP로 operation 재사용/202 재조회/프로젝트 전환 경합/offline·sample의 POST 0회/자동 정정 후 안내 소멸/승인과 중복 없음을 확인한다.
10. Mac/iOS 수동 QA: 가짜 자료로 홈·팀원 상세·명패·대화의 동일 상태, drawer/push, Dynamic Type/VoiceOver/긴 문구, 기존 approval/terminal 진입을 확인한다. 화면 검증을 위해 라이브에 접속하지 않는다.

구현 후 격리 환경에서 변경 시험부터 bun test, bun run typecheck, swift test/build를 실행한다. Swift scratch/DerivedData도 임시 루트로 지정한다. macOS와 iOS simulator 빌드를 확인한다. tests/e2e-real 및 실제 herdr를 요구하는 browser 시험은 제외한다. 기존 실패는 이번 회귀와 구분하고 통과로 보고하지 않는다.

## 위험·미정

- CLI는 delivery ID에 의한 exactly-once API가 없다. 같은 표식은 조회용이며 중복 실행 방지가 아니다. 현행 RPC의 post-write timeout에서 부재만으로 정확한 자동 재전송을 보장할 수 없다. 긍정 증거 정정과 쓰기 전 실패 복구는 자동화하되 원래 쓰기 미종료는 unknown이다.
- 원래 요청 종료/입력 큐 소진의 증명과 외부 attach 원자성은 generation 1의 제약이다. 가짜 RPC 시험은 구현 분기를 검증할 뿐 실제 장벽 의미를 증명하지 않는다. 고정 버전 소스/계약으로 확인하지 못하면 quiescence=unresolved로 둔다. core 최종 시험은 IAMCEO 완성 후 가짜 프로젝트에서 하며 이번에 core를 바꾸지 않는다.
- Codex 관측 표본은 response_item 중심이었다. 로그 비활성/다른 저장 형식/제공자 home 변경은 unknown으로 처리한다. 새 버전 지원은 합성 fixture를 추가한다. 실제 사용자 기록을 fixture/오류 로그에 복사하지 않는다.
- 제공자 파일은 호스트 데몬만 읽고 iPhone에 본문을 보내지 않는다. 큰 파일은 여러 tick이 필요할 수 있다. 프롬프트를 장기 중복 보관하지 않도록 해결 후 청소를 시험한다.
- 기존 noOutput 재전송을 멈추면 사용량 한도 후 자동 재실행 행동이 달라진다. 입력 수신과 처리 실패를 분리하기 위한 의도적 변경이다. 처리 오류는 남기며 수신 정정으로 업무 성공을 표시하지 않는다.
- stopped는 추가 전달 포기이며 수신 판정이 아니다. 결재 answered/할 일 완료를 대신 바꾸지 않고 원본 도메인 재작업은 명시적인 기존 행동으로 한다.
- 동시 작업과 겹치는 파일은 herdr.ts·db.ts·store.ts·shared/types.ts·Design/Presentation.swift다. runner/context.ts·tests/context.test.ts는 읽기만 하고 변경하지 않는다. 문맥 수집/카드 유리 차이를 되돌리지 않는다.
- OfficeView.swift는 계속 변경될 수 있다. 명패 표시 위치는 담당자와 맞추되 needsOwner만 표시·결재 건수 분리·기존 상세 진입 계약을 유지한다. Office/* 자산은 범위에 넣지 않는다.
- 미정은 실행기별 settled 증명 조건과 외부 attach 관측 가능성이다. 안전한 초기값 unknown/무입력을 명시했으므로 긍정 정정·쓰기 전 복구·근거 표시 구현은 이를 기다리지 않고 시작할 수 있다.

## 소유자 할 일

방향의 재승인은 필요 없다. 아래는 구현 분담용이며 대표가 매번 세션을 읽는 운영 절차가 아니다.

1. 서버 담당: shared/DB append migration/store/회복 서비스를 한 계약으로 구현한다. 모든 입력에 같은 mutex와 단일 retry 경로를 적용하고 이전 웹 POST도 통합한다.
2. 실행기 담당: core/herdr·Claude/Codex collector·전체 표식·Codex 세션 연결을 구현한다. herdr 문맥 수정자와 precheck/prompt/spill 경계를 먼저 맞춘다. settled 조건은 고정 버전 근거로 문서화한다.
3. 네이티브 담당: models/store/공통 패널 후 Home/Team/Chat을 연결한다. Presentation의 재질 작업을 덮지 않고 Office 담당에게 세 접점만 전달한다.
4. QA 담당: 합성 기록·가짜 RPC·화면으로 두 실행기 각 경우와 send/Enter/clear 횟수를 증명한다. IAMCEO 완성 후 core 가짜 프로젝트 검증을 거쳐 별도 기본 실행기 전환을 판단한다. 라이브 herdr나 실제 지시로 재전송 시험하지 않는다.
5. 대표: 자동 판정 불가능한 예외에서만 근거와 추천을 보고 연결 복구/다시 확인, 필요하면 위험 동의 재전송 또는 추가 전달 중지를 선택한다. 통상적인 수신 판정을 사람에게 맡기지 않는다.

## 파일 목록

다음은 향후 구현 시 수정/신규 생성할 전체 파일이다. 이번에 작성한 파일은 본 설계서뿐이다. 새 모듈/시험은 미래 구현 제안이며 이번 작업에서는 만들지 않는다. web/·runner/context.ts·tests/context.test.ts·Views/Office/*는 제외한다.

/Users/yesung/iamceo/server/orchestrator.ts
/Users/yesung/iamceo/server/orchestrator-api.ts
/Users/yesung/iamceo/server/delivery-recovery.ts
/Users/yesung/iamceo/server/http.ts
/Users/yesung/iamceo/server/db.ts
/Users/yesung/iamceo/server/store.ts
/Users/yesung/iamceo/server/runner/types.ts
/Users/yesung/iamceo/server/runner/delivery-evidence.ts
/Users/yesung/iamceo/server/runner/core.ts
/Users/yesung/iamceo/server/runner/core-client.ts
/Users/yesung/iamceo/server/runner/herdr.ts
/Users/yesung/iamceo/server/runner/herdr-client.ts
/Users/yesung/iamceo/shared/types.ts
/Users/yesung/iamceo/native/Sources/IAMCEO/Models/Models.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/State/AppStore.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Design/Presentation.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/DeliveryNoticeView.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/HomeView.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/TeamView.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/ChatView.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/OfficeView.swift
/Users/yesung/iamceo/tests/delivery-evidence.test.ts
/Users/yesung/iamceo/tests/delivery-recovery.test.ts
/Users/yesung/iamceo/tests/core-runner.test.ts
/Users/yesung/iamceo/tests/herdr.test.ts
/Users/yesung/iamceo/tests/orchestrator.test.ts
/Users/yesung/iamceo/tests/core.test.ts
/Users/yesung/iamceo/tests/unified.test.ts
/Users/yesung/iamceo/tests/http.test.ts
/Users/yesung/iamceo/native/Tests/IAMCEOTests/ContractTests.swift
/Users/yesung/iamceo/native/Tests/IAMCEOTests/NetworkTests.swift
/Users/yesung/iamceo/native/Tests/IAMCEOTests/ConnectionLossTests.swift
/Users/yesung/iamceo/docs/spec.md

## 크기

**L.** 표식/영속 봉투·제공자별 기록 수집·두 실행기 입력 직렬화·재시작 복구 상태기계·옛 재시도 정합성·네이티브 표시/예외 조작·격리 안전 시험이 필요하다. 잘못된 받음 표시와 중복 전송을 함께 막는 경계 검증이 주된 크기다. 구현 순서는 계약/DB → 증거 수집 → 회복 서비스/실행기 → 호환 API → 네이티브 → 격리 시험이다. 외부 패키지 추가 없이 기존 Bun/SQLite·node:fs/crypto/path·Zod·SwiftUI/URLSession을 사용하고 의존성 버전 업데이트는 섞지 않는다.
