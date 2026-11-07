# 아키텍처

2026-11-07 W1~9 작업 트리는 `herdr-core`와 공식 대화형 Claude Code·Codex CLI를 조립한다. **라이브는 herdr 실행기를 유지**하며, 가짜 프로젝트와 별도 실제 CLI·실기기 인수 후 소유자가 전환을 승인해야 한다. 소스 상태를 라이브 배포 상태로 해석하지 않는다. Bun 서버가 도메인 상태와 전달을 맡고, SwiftUI macOS·iOS 앱과 React 웹은 같은 API를 쓴다. `herdr`·`headless` 호환 어댑터와 기존 데이터는 보존한다. 웹은 곧 폐기할 레거시로 기능 추가 없이 v1 REST/WS 호환만 유지한다. IAMCEO는 소스 공개형(Sustainable Use License 1.0 + IAMCEO 추가 허락)이다. [LICENSE](../LICENSE)·[라이선스 설명](LICENSING.ko.md)을 따른다. [과거 handoff](claude-handoff.md)의 날짜별 기록은 새 완료 사실로 덮지 않는다.

## 구성과 소유권

```text
SwiftUI macOS / iOS ── REST sync + WS v2 ─┐
React 레거시 웹 ────── REST + WS v1 ──────┼─ Bun 서버 ─ SQLite / 첨부
세션 안의 iamceo mcp ─ HTTP /agent/* ──┘      │
                                     Orchestrator
                                           │ CoreRunner / Unix JSON-RPC
                                     herdr-core daemon
                                           │ holder / PTY
                                  공식 Claude Code / Codex CLI
```

- 도메인 상태의 원본은 Bun 서버와 SQLite다. 네이티브 앱은 두 번째 조정자나 모델 프록시를 실행하지 않는다.
- core holder가 PTY와 CLI 수명을 소유한다. IAMCEO 서버·앱의 종료와 연결 해제는 CLI를 죽이지 않는다. 명시적인 잠재우기·종료·세션 교체만 해당 멤버의 터미널을 끝낸다.
- 일반 `serve` 시작은 IAMCEO 전용 core를 준비한다. 진단 API는 core를 설치·시작·업데이트하지 않는다. 앱의 로컬 서비스 등록도 사용자가 `이 Mac에서 시작`을 선택했을 때만 한다.
- macOS 앱의 로컬 호스트 기능은 번들에 든 daemon/core 또는 명시적 QA 경로를 사용한다. 다른 설치의 서비스·이미 쓰는 포트·인증 오류를 발견하면 교체하지 않고 오류를 보인다. 빌드는 서비스를 등록하거나 시작하지 않는다.

| 경로 | 역할 |
|---|---|
| `server/orchestrator.ts` | 전달 큐, 멤버 수명, 제공자·설정 교체, MCP 업무 흐름 |
| `server/runner/core-client.ts` | generation 1 NDJSON JSON-RPC, 제한 시간, 오류·전달 불확실성 |
| `server/runner/core.ts` | 소유권 라벨, 재결합, OSC 상태 폴링, 안전한 입력·수동 조작 |
| `server/runner/providers.ts` | 공식 CLI의 인자·환경과 호출별 MCP 설정 |
| `server/http.ts`, `orchestrator-api.ts`, `server/bus.ts` | v1/v2 REST·epoch/seq WS·일관된 sync snapshot·코드 회전 |
| `server/db.ts`, `store.ts` | 마이그레이션·도메인 transaction·revision·journal/lease/receipt·paging·보관 읽기 |
| `server/delivery-recovery.ts`, `server/runner/delivery-evidence.ts` | 영속 봉투·증거 수집·자동 정정/안전 복구·전체 DB 집계 |
| `server/push/` | 별도 APNs outbox·기기 revision/token 세대·120초 완료 보고 그룹·HTTP/2 worker |
| `server/home-owner.ts`, `backup.ts`, `restore.ts`, `storage-maintenance.ts`, `log-writer.ts` | 홈 OS 잠금·검증 백업/별도 복원·보수적 정리·FD 재오픈 로그 회전 |
| `bin/iamceo.ts`, `bin/mcp-bridge.ts` | 서비스·attach·MCP CLI와 stdio 브리지 |
| `native/` | SwiftUI 앱·단일 sync coordinator·history·영속 초안/attempt·iPhone APNs·Keychain |
| `web/` | 기존 React 클라이언트와 웹 WS 동기화 |
| `shared/types.ts` | 서버·웹 공통 계약, 네이티브 모델의 원본 |
| `vendor/herdr-core/` | upstream 버전 잠금과 라이선스·서드파티 고지 |

## core와 공식 CLI

기본 소켓은 `$IAMCEO_HOME/run/core.sock`, 세션은 `HC_SESSION=iamceo`다. core 자체의 XDG state/config는 `$IAMCEO_HOME/core-state`·`core-config`에 격리한다. `IAMCEO_CORE_BIN`·`IAMCEO_CORE_SOCKET`으로 명시적으로 바꿀 수 있다. core는 제공자 CLI의 일반 설정·인증·도구를 대체하지 않는다. 터미널 시작 환경은 원래 HOME과 사용자 XDG 경로를 되살리고 부모의 외부 `HC_*`·`HERDR_*` 및 Claude 중첩 세션 변수를 제거한다.

`terminal.run`은 셸 문자열 대신 argv를 받는다. `no_parent`, `outlive_parent`, `no_notify`를 사용하며 종료된 명령을 자동 재실행하는 keep는 켜지 않는다. 멤버·프로젝트·CLI 라벨과 고정 이름으로 재시작 시 같은 live 터미널을 찾는다. 중복 소유권, 다른 제공자, 다른 알려진 세션을 발견하면 오류다. 소켓 단절만으로 터미널 사망을 단정하거나 새 CLI를 띄우지 않는다.

Claude는 `--session-id` 또는 `--resume`, 시스템 프롬프트 파일·MCP 파일·선택한 모델·effort·권한을 받는다. Codex는 대화형 CLI와 호출별 `-c` 설정으로 지시·MCP·모델·effort·native subagent 설정을 받는다. MCP bearer는 argv에 넣지 않고 환경과 `env_vars`로 전달한다. 전역 CLI 설정 파일을 수정하지 않는다.

Claude의 native 세션 UUID와 core 터미널 주소는 다른 식별자다. 새 Codex의 native ID는 CLI에서 미리 지정할 수 없어 처음에는 `sessionId=null`이다. 실제 user 입력의 고유 binding 표식이 유일한 주 세션의 metadata/cwd와 맞으면 기존 session 이벤트로 연결한다. delivery와 문맥 수집은 같은 binding을 사용한다. 최신 파일/cwd만으로 고르지 않으며 충돌·부분 기록은 미확인이다. 살아 있는 core 터미널은 계속 재결합할 수 있다. 그 터미널을 잃었고 native ID도 모르면 자동으로 새 대화를 만들어 재개했다고 하지 않는다.

## 상태·전달·수동 조작

- 상태는 `terminal.get` 폴링의 OSC 7501 root record와 turn counter만 따른다. 화면에서 working·idle을 추측하지 않는다. 알 수 없는 상태는 자동 입력을 막고 설정·신뢰·인증 확인을 안내한다.
- 한 멤버에 한 번만 전달한다. idle은 core의 `if:idle` 조건을 쓰고, done은 upstream 조건 열거형이 idle·working만 받으므로 그 조건 없이 `force:false`로 보낸다. 모든 자동 입력은 blocked 창을 통과하지 않는다.
- `terminal.read`는 `lines:0`으로 현재 화면만 읽는다. 이 화면은 입력칸과 초안을 보호하는 데 쓰며 최종 답변이나 실행 상태로 바꾸지 않는다. 초안이 있거나 입력칸을 식별할 수 없으면 지우지 않고 보류한다. Codex plain text의 고정 placeholder와 같은 문장을 사용자가 직접 친 경우는 구별할 수 없다.
- 응답을 잃은 PTY 입력은 실제로 전달됐을 수 있다. 영속 dispatch·고유 표식·기준선에서 주 세션 user 증거를 수집하여 자동 정정한다. 확정 쓰기 전 실패만 안전 재검사 뒤 재전송하고, 전체 composer 일치와 원래 쓰기 settled가 증명될 때만 제출 키 1회를 허용한다. post-write timeout 뒤 부재만으로 재전송하지 않는다. 검증되지 않은 generation 1 drain 장벽은 가정하지 않는다. `turn_end`의 `finalText`는 빈 문자열이다. CLI 화면을 긁어 자동 완료 보고로 만들지 않으며 업무 결과는 `post`·`file` 등 MCP 도구로 남긴다.
- `POST /api/members/:id/terminal/control`은 명시적인 사람 조작이다. v2는 operationId·검토 세대·재사용 claimId·입력 순번으로 receipt를 남기고 unknown 입력을 재생하지 않는다. lease는 terminal·세대에 결합하여 재시작 뒤 pump 전에 복원한다. 5분 token lease를 claim하면 자동 전달이 멈춘다. 같은 token만 갱신·입력·키·release할 수 있다. input은 실행기에서 UTF-8 128KiB 이내로 제한하며 v2 HTTP text schema 상한은 131072 UTF-16 code unit이다. 키는 enter/up/down/esc/tab/ctrl+c/backspace다. 사람의 input만 `force:true`를 사용할 수 있다. 종료·교체는 lease를 무효화한다.
- `iamceo attach <memberId>`는 실제 PTY에 붙는 터미널 경로다. 네이티브·웹의 수동 조작과 달리 외부 attach의 모든 입력을 앱 lease와 원자적으로 묶을 수는 없다. 직접 조작할 때는 앱의 조작권을 먼저 잡아 자동 전달을 멈추는 것이 안전하다.

`deliveries`가 대표 메시지·결재 답·보고·지시의 대기열이다. 연결 게이트, 프로젝트 보관, 실행 중인 턴, 승인 창, 수동 lease를 거친 뒤 보내고 결과를 저장한다. 원본과 전달 의도는 같은 transaction에 저장하고 commit 뒤 pump한다. 전송 전 봉투/표식/hash·세션 기준선을 영속화한다. 전체 DB에서 누락 원본을 수선하며 최근 메시지 수로 집계를 제한하지 않는다. 서버 재시작 때 미완료 delivering은 보수적으로 보류하고 증거로 관측을 재개한다. OSC 턴 종료는 다음 전달을 진행시키는 신호이며 업무 완료의 증거가 아니다. 생성/종료/실행 journal은 최초 run 불명과 pane 저장 전 crash에도 같은 멤버·operation을 보존한다. stop 확인 전 asleep을 저장하지 않고 부분 종료/불명 참조를 유지한다. 큐 없는 core 재결합도 재시도하되 소유 core의 확실한 부재만 재기동한다. ACK 뒤 정체는 재관측하고 시간만으로 send/interrupt하지 않는다.

## 제공자·모델·병렬 설정

프로젝트 생성의 `chiefCli`, 멤버 생성·수정의 `cli`는 `claude|codex`다. 멤버별 제공자는 독립적이며 기본은 Claude다. 실행 backend는 core로 고정되어 있고 과거 저장 backend는 이력으로 읽는다.

제공자나 실행 중 세션의 모델·effort를 바꾸면 작업 중·blocked·전달 불확실 상태를 거부한다. 목표 CLI 인자를 먼저 검증하고 이전 터미널 종료가 확인된 뒤 세션 이력을 보관하고 MCP 토큰과 세대를 바꾼다. 멤버 id·역할·업무·대화는 유지한다. Claude의 같은 제공자 설정 변경은 native UUID를 이어 열고, 제공자가 달라지거나 native ID를 모르는 Codex 변경은 새 세션과 역할·현재·다음·프로젝트 상태 인계문을 만든다. 제공자 사이의 숨은 추론·대화 문맥 전송은 구현되어 있지 않다. 이전 종료 실패는 제공자·토큰을 바꾸지 않고, 새 시작 실패는 오류로 남긴다.

모델은 멤버 덮어쓰기, 적용 가능한 직급 값, CLI 기본 순이다. Claude 직급 모델·staff 설정을 Codex에 그대로 물려주지 않는다. Claude 병렬은 `/effort ultracode on|off`의 실제 응답을 확인한다. Codex는 native subagent 기능과 각 다음 과제의 명시적 병렬·순차 선호를 사용한다. 이는 실제 subagent 실행 개수의 보장이나 Claude Ultracode 모드가 아니다. core 자동 compact는 fresh exact·같은 세션/세대/model/완료 턴·실제 wake 큐·다음 업무 전 조건에서만 실행한다. Claude statusline과 공통 측정기, Codex의 현재 usage/실측 창 parser를 재사용한다. 수동 요청은 예약할 수 있으며 slash에 marker/nonce를 붙이지 않는다. ACK는 완료가 아니고 baseline 뒤 compact 기록+같은 소유 CLI의 settled 복귀가 필요하다. sending/running 중 재시작·timeout은 uncertain으로 두어 재송신과 뒤 업무를 막는다. CLI 내장 압축도 중복 방지에 반영한다.

## 클라이언트

SwiftUI 앱은 홈·결재함·팀·대화·자료·설정을 제공한다. macOS 14+/iOS 17+와 Swift 6을 대상으로 하며 탭·도구 모음은 OS의 네이티브 스타일을 따르고, 업무 카드는 다크 바이올렛 반투명 material로 구성한다. AppStore의 단일 coordinator가 REST sync·history·delivery·활동을 갱신한다. WS v2 정상 연결의 정기 상태/history GET은 없고 이벤트를 250ms·최대 초당 2회/동시 1개로 묶는다. gap·epoch 변경·heartbeat 앞섬·재접속은 snapshot 재조회다. WS만 실패하면 3초 fallback, 전체 실패는 최대 30초 backoff다. 비활성·잠금·sleep에서는 읽기·소켓·재시도를 멈추고 복귀하면 새 세대로 sync한다. 터미널 화면은 열려 있고 active일 때만 2초마다 읽는다. iPhone alert APNs는 별도 알림 경로이고 백그라운드 상시 동기화는 없다. Mac osascript 알림은 독립 설정이다.

접속 코드는 endpoint별 Keychain, endpoint는 UserDefaults에 저장한다. 원격 서버는 HTTPS만, 같은 Mac loopback은 HTTP도 받는다. iPhone의 loopback은 Mac이 아니므로 Mac의 Tailscale Serve HTTPS origin을 사용한다. REST Bearer를 다른 origin이나 HTTP redirect에 넘기지 않는다. 최초 메시지 attempt와 완료 첨부는 호스트 namespace·불변 id·대상·본문·초안 revision으로 영속화하고 acknowledgement 유실/재시작 후 단건 조회로 접수를 확인한다. 결재는 읽었던 `updatedAt`을 `expectedVersion`으로 보내 바뀐 카드를 덮어쓰지 않는다. 설정/멤버/todo는 v2 If-Match CAS, fresh/terminal은 operation receipt를 사용한다. 결재 메모는 자기 수락 카드만 소비하고 늦은 업로드/입력 응답이 후속 편집을 지우지 않는다. 쓰기 실패를 로컬 성공으로 꾸미지 않는다. `--demo`는 명시적 읽기 전용 예시 모드다.

React 레거시 웹은 v1 REST와 기존 `/ws` 방송을 사용한다. 검토 버전 없는 쓰기와 URL WS 인증은 v2와 동등한 보호가 아니며 웹 폐기 뒤 제거할 호환 부채다. 새 실행기 선택 UI는 없고 core·제공자 진단과 멤버별 CLI 설정을 보여 준다. 두 클라이언트의 자료·첨부 렌더링 능력은 같지 않다. 네이티브 HTML 미리보기는 비영속 WKWebView, JavaScript 비활성화, CSP와 외부 연결 차단을 사용한다.

## 읽기 경계와 알림

paging은 `(at BINARY,id BINARY)` keyset과 불투명 cursor이며 최초 200/이전 100개를 별도 history에 유지한다. ID 중복 제거·요청 중 이벤트 overlay로 후착 GET의 상태 역전을 막는다. 200개 초과 reconnect gap은 staging을 기존 ID와 연결한 뒤 합치며, 실패 시 기존 화면/커서/초안을 보존한다. prepend 직전의 가시 메시지·부분 offset을 유지한다. 기존 Message[]·state 최근 200개와 v1 정렬은 호환한다.

프로젝트 PATCH는 단일 Orchestrator 장벽에서 검증·전원 safe stop·종료 증거·최종 저장을 소유한다. 관리 CLI의 native ID/기록을 확인하며 Codex가 끝내 불명이면 보관 409다. manual 프로세스는 종료하지 않는다. archive state/page는 인증 아래 archived 프로젝트만 읽으며 일반 state/page의 보관 404를 유지한다. 보관 UI는 대화·결재·업무·자료 읽기 전용, 이름/꺼내기는 관리 액션이다. 늦은 manual 기록·v1 todo 호환 때문에 DB 불변 snapshot은 아니다. 꺼내기는 archived-held만 재검사한다.

PushEventRecorder는 도메인 쓰기와 같은 transaction으로 APNs 의도를 남긴다. 새/재열린 ask(자유 답변 포함)는 decision 한 사건, 승인 대기는 permission 증거, 오류는 영속 episode로 분류한다. 완료 post는 프로젝트·직원별 첫 보고부터 120초 고정 창으로 묶는다. 수신 기기 집합·마감·마지막 보고/전체 보고 ID를 저장하고 창을 연장하거나 새 기기에 소급하지 않는다. opt-out 취소 그룹은 재활성화하지 않는다.

새 기기 enabled=false, 명시 opt-in 후 4종 기본 true다. worker는 발신 직전 현재 기기 revision/token 세대·종류·TTL·원본 유효성을 재검사한다. HTTP/2·ES256 JWT를 사용하며 APNs 200은 Apple 접수, write 후 결과 불명은 unknown/재발신 금지다. payload에는 고정 문구·불투명 ID만 둔다. foreground 수신은 갱신만 하고 tap은 현재 serverId/target 재검증 후 한 창에서 한 번 탐색한다. API 인증 철회·호스트 외부 사망 감시는 이 outbox가 제공하지 않는다.

## 웹 아티팩트

`file` 의 `html`(2MB 이하) 또는 `.html` 경로로 올린 자료다. 원본은 `files.html` 에 두고 `GET /api/files/:id/artifact` 로 받는다. 서버 출처의 문서로 내주지 않는다.

그릴 때 `<iframe sandbox="allow-scripts" src="/artifact-frame">` 을 만들고 칸이 준비되면 `buildArtifactSrcdoc` 으로 조립한 문서를 postMessage 로 넣는다. srcdoc 은 부모의 CSP 를 물려받아 인라인 스크립트가 안 돌아서 쓰지 않는다. 칸은 대표가 실행을 눌러야 만들어진다(WebKit 은 칸과 부모가 메인 스레드를 함께 써서 루프 하나로 앱이 멈춘다). 칸은 불투명 출처라 접속 코드·저장소·서버 API 에 닿지 못하고 일반 바깥 요청도 막힌다. WebRTC(STUN UDP)와 WebKit 의 preconnect 는 CSP 로 막지 못해 앞머리에서 생성자를 지우고 중첩 칸·link 를 없애지만, WebKit 에서 스크립트가 넣은 link 의 접속은 남으므로 민감한 데이터는 싣지 않는다. 칸이 보내는 높이·링크·닫기 신호는 `e.source` 와 값을 확인한 뒤에만 쓴다.

## 인증·파일 안전

사용자 API는 접속 코드, `/agent/*`는 멤버별 MCP 토큰으로 구분한다. 토큰은 멤버 JSON에 내보내지 않는다. 기본 서버는 loopback과 사용 가능한 Tailscale 주소를 듣고 Host·Origin·요청 IP를 검증한다. 웹 첨부 쿠키는 `/files`에만 통하고 API 인증을 대신하지 않는다. 자세한 경계와 아티팩트 제한은 [구현 계약](spec.md)에 있다.

`file`·`ask` 도구 경로는 symlink를 따라간 실제 작업 폴더 경계를 확인하고 비밀 폴더·환경 파일·개인 키·IAMCEO 데이터·다중 hard link를 거부한다. 이 검사로 동일 OS 사용자의 CLI Bash나 사용자가 선택한 bypass 권한까지 sandbox하는 것은 아니다. 제공자 CLI의 실제 도구 권한과 승인은 그 CLI가 처리한다.

## 데이터와 마이그레이션

기본 데이터 폴더는 `~/.iamceo`, `IAMCEO_HOME`으로 격리할 수 있다.

| 경로 | 내용 |
|---|---|
| `config.json` | 접속 코드·포트·주소·실행 파일 경로, mode 600 |
| `iamceo.db` | WAL SQLite: projects/members/decisions/todos/work/messages/files/attachments/deliveries/activity/settings |
| `member_session_history` | DB 테이블: 이전 CLI·backend·native session·pane·세대·설정·교체 이유 |
| `iamceo.db.pre-v*.bak` | 기존 DB 마이그레이션 전 `VACUUM INTO` 백업, mode 600; 실패하면 마이그레이션 중단 |
| `uploads/`, `inbox/<member>/` | 첨부 원본과 멤버에게 전달하는 파일 |
| `roles/`, `run/`, `logs/` | 역할 템플릿, 호출별 규칙·MCP 설정·core 소켓, 서비스 로그 |
| `core-state/`, `core-config/` | IAMCEO 전용 core state/config 홈 |

native 제공자의 세션 원본과 로그인·일반 설정은 각 CLI가 관리한다. IAMCEO는 알려진 native ID와 core 주소를 별도로 보관한다. 기존 herdr/headless 세션·토큰·업무 자료를 새 core 세션으로 해석하지 않는다. 복구는 과거 세션을 이력으로 남기고 명시적 전환 전까지 전달을 보류한다. 활동은 멤버당 최근 500건을 유지한다.

데몬은 DB/recovery 전 홈 단위 OS flock을 잡고 config를 0600 임시 파일→fsync→rename→디렉터리 sync로 저장한다. 미래 user_version은 쓰기 전에 거부한다. 정기 백업은 기본 24시간·일 7/주 4개로, DB+참조 첨부+설정과 manifest hash·integrity/FK를 검증한다. p8·제공자 세션 원본·외부 작업 폴더는 별도 보관 대상이다.

restore는 별도 빈 홈만 허용한다. 첨부 참조를 재배치하고 runnerEnabled/기기 enabled를 끄며 미종결 실행/operation을 unknown, 미발신 push/그룹을 취소한다. 발신 재개는 복원 검증과 별도 운영 전환이다. same-host는 serverId 유지, clone은 새 serverId·token 해지 뒤 재등록한다. 자동 라이브 덮어쓰기/큐 전량 replay는 없다. `outboundEnabled:false` 기록을 런타임의 모든 조작을 차단하는 전역 스위치로 해석하지 않는다. 절차와 현재 전용 재개 명령의 한계는 [운영 모델](operating-model.md)에 있다.

로그는 전용 writer가 열린 FD를 재오픈하여 stream당 10MiB×5세대로 제한한다. storage sweep은 명백한 미참조 실패 staging만 유예·격리하며 완료 첨부·보관·초안·미해결 전달을 보존한다. ENOSPC/SQLITE_FULL은 실패로 분류한다.

인증된 readiness는 daemon ready·buildId/실행 버전·schema와 core/bind 진단을 liveness에서 분리한다. loopback+Bearer 전용 코드 회전은 저장 뒤 실행 중 인증·WS·pairing을 무효화한다. 응답 유실은 반복 회전 대신 로컬 확인/새 QR로 복구한다. 공용 코드의 기기별 철회는 별도 인증 확장이다.

## 시험과 배포 경계

core 단위·서버 계약 시험은 가짜 Unix 소켓을 사용하고 실제 유료 모델을 부르지 않는다. 일반 게이트는 임시 홈·명시 provider homes·동적 비7878 port0·가짜 실행파일·자기 소켓만 쓴다. 실제 PTY/제공자 의미 검증은 W11-A 별도 인수다. 라이브 7878·사용자 데이터 홈/config·herdr 소켓·dist/native를 시험하지 않는다. 네이티브 계약·네트워크 시험은 URLSession mock으로 인증·오래된 결재·멱등 메시지·origin 제한을 검사한다. 앱 빌드 성공은 개발자 서명·공증·App Store 배포 완료를 뜻하지 않는다.

herdr-core의 잠금 버전·출처·서명 보존·업데이트 절차는 [vendor 문서](../vendor/herdr-core/README.md), 네이티브 실행·빌드는 [native 문서](../native/README.md)를 따른다.
