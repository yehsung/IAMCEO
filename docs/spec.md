# IAMCEO 구현 계약

현재 소스의 API와 실행 규칙을 설명한다. 서버·DB 변경을 배포할 때는 데이터를 먼저 백업한다.

IAMCEO는 **소스 공개형**이며 Sustainable Use License 1.0 + IAMCEO 추가 허락을 따른다. [LICENSE](../LICENSE)와 [라이선스 설명](LICENSING.ko.md)을 본다.

공통 타입은 `shared/types.ts`, 실행기 계약은 `server/runner/types.ts`, core protocol은 upstream generation 1이다. 아키텍처 개요는 [architecture.md](architecture.md), 고정 core 출처는 [vendor 문서](../vendor/herdr-core/README.md)를 본다. herdr/headless 어댑터는 과거 연동의 호환·회귀 자료이며 새 제품 실행의 기준이 아니다.

용어는 다음 뜻으로 쓴다. `lease`는 시간 제한이 있는 직접 조작권, `operation receipt`는 작업 ID별 처리 결과다. `CAS`는 읽었던 변경 버전과 현재 버전이 같을 때만 저장하는 방식이다. `unknown`은 결과를 확인할 수 없다는 뜻이며 실패나 재전송 허가가 아니다. `fresh exact`는 현재 세션에서 최근에 정확히 측정한 값, `wake`는 세션을 깨워 전달할 업무다.

사람을 부르는 말은 앱 화면을 따른다. 프로젝트를 이끄는 세션은 총괄(코드의 `conductor`), 일을 맡는 세션은 팀장(`worker`), 팀장이 부리는 서브에이전트는 직원이다. 서버가 세션에게 주는 역할 템플릿의 문구는 아직 팀장을 '직원'이라고 부른다.

## 0. 실행과 시험의 경계

- 사용자 실제 `~/.iamceo`, 기존 herdr/core 소켓·세션·서비스에 개발 쓰기 요청을 보내지 않는다. 시험은 임시 `IAMCEO_HOME`, 명시적 시험 소켓, 격리된 `HC_SESSION`·XDG 경로를 사용한다.
- 단위·통합 시험은 실제 유료 모델을 부르지 않는다. core는 fake JSON-RPC 서버(가짜 core 소켓과 그 안의 가짜 CLI)를 쓴다. 실제 모델 호출·전역 도구 설치·업데이트·배포·launchd 등록은 해당 작업이 명시적으로 요청된 경우만 한다.
- core shutdown은 detach다. 앱·서버 종료를 이유로 holder나 제공자 CLI를 끝내지 않는다. 명시적 멤버 종료·잠재우기·안전한 세션 교체와 구분한다.
- 공식 CLI의 사용자 설정·로그인·도구를 유지한다. 호출별 인자·MCP 설정을 쓰고 전역 Claude/Codex 설정 파일을 수정하지 않는다. 부모의 외부 `HC_*`·`HERDR_*`·Claude 중첩 세션 변수는 전달하지 않고, 사용자 HOME·XDG 설정 경로를 복원한다.
- 초안을 지우거나 불확실한 PTY 입력을 자동 재전송하지 않는다. 화면은 입력 안전 확인·사람의 조작을 위해 읽을 수 있지만 실행 상태나 최종 답변을 추측하는 근거로 쓰지 않는다.

## 1. 구조

```text
SwiftUI macOS/iOS ── REST sync·WS v2 ─┐
MCP stdio ── iamceo mcp /agent/* ───┴─ Bun / SQLite / Orchestrator
                                               │
                                           CoreRunner
                                               │ Unix NDJSON JSON-RPC
                                           herdr-core / holder
                                               │ PTY
                                      공식 Claude Code / Codex CLI
```

| 경로 | 내용 |
|---|---|
| `server/config.ts` | IAMCEO_HOME, 포트·주소, `IAMCEO_CLAUDE_BIN`, `IAMCEO_CODEX_BIN`, `IAMCEO_CORE_BIN`, `IAMCEO_CORE_SOCKET` |
| `server/db.ts`, `store.ts`, `bus.ts` | WAL DB·마이그레이션 전 백업·도메인 상태·실시간 이벤트 |
| `server/http.ts`, `orchestrator-api.ts` | 인증된 REST·WebSocket·접근 제어 |
| `server/orchestrator.ts`, `agent-tools.ts` | 전달·세션 교체·재결합과 MCP 업무 도구 |
| `server/runner/core-client.ts`, `core.ts`, `providers.ts` | core protocol, 멤버 소유권·입력·수동 제어, 공식 CLI 인자 |
| `server/runner/types.ts` | Runner·TerminalControl 계약 |
| `server/roles/`, `bin/mcp-bridge.ts` | 역할 프롬프트·stdio MCP 브리지 |
| `bin/iamceo.ts` | serve·service·status·attach·MCP·직접 CLI join |
| `native/` | SwiftUI macOS/iOS, REST·Keychain·로컬 호스트 기능 |
| `shared/types.ts`, `shared/artifact-kit.ts` | 도메인 타입·네이티브 아티팩트 문서 조립 |
| `vendor/herdr-core/`, `scripts/setup-core.ts` | 고정 release·라이선스·checksum·macOS 서명 검증 |

실행기는 core 하나다. 옛 실행기 둘(herdr 터미널 멀티플렉서를 쓰던 `herdr.ts`·`herdr-client.ts`, `claude -p`를 턴마다 띄우던 `headless.ts`)과 그 전용 코드(권한 승인 창 해석 `approval.ts`, 실행 방식 전환, herdr 칸 재결합, 기존 세션 편입·해제, herdr 상태 조회)는 지웠다. 서버는 herdr 소켓을 열지 않고, 설정의 `herdrSocket`·`IAMCEO_HERDR_SOCKET` 값은 있어도 읽지 않는다. 두 실행기가 함께 쓰던 화면 해석·자식 환경·세션 기록 찾기는 `runner/claude-screen.ts`·`env.ts`·`session-files.ts`에 남아 core가 쓴다.

배포된 네이티브 앱(0.2.2)의 v1 API 호환은 유지한다. `Backend` 타입의 값 목록(`core`·`herdr`·`headless`), 팀장·설정의 `backend` 칸, `bootstrap.herdr` 칸은 그대로 내려간다. `bootstrap.herdr`는 `{installed:false,running:false,version:null,protocol:null,compatible:false,warning:null}` 고정값이다. 옛 `backend` 값이 남은 팀장 행은 지우지 않는다. 세션이나 터미널 주소가 남아 있으면 `legacy_session`으로 보류하고, core 주소로 해석하거나 자동으로 새 CLI에 옮기지 않는다. 웹 버전은 제거했다.

## 2. DB
`shared/types.ts`의 타입과 1:1. 테이블 projects, members, decisions, todos, work, messages, files, attachments, deliveries, activity(팀장당 최근 500만 유지), settings(kv). JSON 필드(options, images, attachments)는 TEXT. `project_settings_v4` 는 프로젝트별 설정을 전체 설정으로 합칠 때 옛 값을 남겨 둔 표다(마이그레이션만 읽는다. 저장한 전역 권한과 프로젝트 값 중 가장 엄격한 것을 적고 바뀌면 대표에게 알린다. 프로젝트 모델이 하나로 모이면 직급 기본값의 빈 칸으로 올리고, 저장된 값과 다르면 팀장별 지정으로 남긴 뒤 알린다). `files.html` 은 아티팩트 원본(FileDoc 에 싣지 않는다), `members.applied_config` 는 세션에 실제로 들어간 설정이다. `members.adopted_info` 는 편입 표시(JSON, `turnedOnRunner`)다. 판 정리: `decisions.close_kind`(decided·obsolete, AI 가 닫았을 때만)·`close_reason`·`close_quote`·`closed_by`·`closed_at`, `todos.outcome`(done·dropped)·`close_reason`·`closed_by`·`updated_at`, `projects.board_tidied_at`(마지막 판 정리). 멤버 `token`(MCP 인증, 화면에 안 나감) 컬럼 포함. id는 접두어+짧은 난수(`p_`, `m_`, `d_`, `t_`, `w_`, `msg_`, `f_`, `a_`, `dl_`). 시각은 ISO UTC. 첫 실행 때 본사 프로젝트(`id='hq'`, name '본사', cwd=홈, runnerEnabled=true)를 만든다.

`projects.chief_cli`는 총괄 제공자 기본값, `members.cli`는 멤버 제공자다. `members.session_generation`과 `member_session_history`는 CLI/backend/native session/pane/적용 설정·교체 이유·시각을 보관한다. native sessionId와 core paneId는 별개이며 Codex sessionId는 모르면 null이다. 이 소스의 새 실행 backend는 core이고 기존 backend 값은 이력·명시적 전환 판단에 남긴다. 실행 중인 backend를 자동 변경하지 않는다. lifecycle/execution journal, terminal lease, operation receipt, domain revision, delivery recovery/dispatch, member context, push outbox·120초 보고 그룹도 DB에 영속화한다.

기존 DB의 버전을 올리기 전에 `VACUUM INTO`로 `<db>.pre-v<version>-<time>-<random>.bak`을 만들고 mode 600을 건다. committed WAL도 포함하는 독립 SQLite snapshot이며 백업 실패 시 마이그레이션을 중단한다. 원본의 대화·업무·토큰을 비우거나 새 DB로 바꾸지 않는다.

팀장 `Member.lastActiveAt`(`members.last_active_at`)은 CLI 활동 `turn_start`·`turn_end`·`tool`·`tool_result`의 최신 `at`(ISO UTC, 없으면 null)이며, 상태 패치의 `updatedAt`과 독립적으로 저장하고 활동마다 팀장 변경 알림을 추가하지 않는다.

## 3. REST (`/api`, 헤더 `Authorization: Bearer <접속 코드>`, API 쿠키 없음)

아래 기존 경로의 기본 응답은 v1이다. v2 쓰기의 별도 요청·응답은 §3.3을 따른다.

- `GET /api/health`(인증 없음) → `{ok,version}`: liveness만 의미한다. `GET /api/readiness`(사용자 Bearer) → `{ok,version,daemon,schema,core,engine?,tailnet?,hosts}`: 준비되면 200, 아니면 503. daemon에는 `ready,buildId,version`, schema에는 `version,supportedVersion`, hosts에는 bind 상태가 있다. core 정보는 진단이며 provider 로그인 성공을 보증하지 않는다
- `GET /api/runtime` → `{backend:"core",core:{installed,available,version,detail},providers:{claude:{installed},codex:{installed}}}`. 읽기 전용 진단이며 daemon을 설치·시작하지 않는다
- `GET /api/bootstrap` → Bootstrap(`runtime` 진단 포함, `urls`: 서버가 듣는 주소 목록, `cli`: 터미널에서 CLI 를 부르는 명령, `engine?`: 실행 엔진 상태, `tailnet?`: 이 Mac 의 Tailscale 상태). 답하기 전에 실행기를 다시 본다
- `GET /api/projects/:id/state` → ProjectState
- `GET /api/projects/:id/messages?before=<at>&limit=` → Message[]
- `POST /api/projects`(CreateProjectReq: `name,cwd,goal?,startConductor?,chiefCli?:"claude"|"codex",trustFolder?:boolean`) → Project · `PATCH /api/projects/:id`(PatchProjectReq). 실행 방식·권한·모델 필드는 없다. 보내면 400
- `POST /api/projects/:id/conductor/start` → Member (총괄 띄우기, runnerEnabled 를 true 로)
- `POST /api/projects/:id/messages`(SendMessageReq; id 는 클라이언트 UUID로 멱등) → Message. 원문·전달 의도 commit 직후 응답하며 기동·pump 완료를 기다리지 않는다. 접수 시 캐시된 연결 상태로 검사하며 알려진 연결 불가는 409(§3.1)
- `POST /api/uploads?project=<id>&target=<팀장 id>`(multipart, file, 50MB) → Attachment. `project` 를 주면 연결을 먼저 본다(409). 끝까지 올린 뒤에 보내기에서 거부당하지 않게 화면은 붙인다
- `POST /api/projects/:id/messages` 는 같은 id 면 그 글을 돌려주고, 그 글이 끝내 실패(failed)한 대표 글이면 같은 글을 다시 넣는다(대화 줄이 늘지 않는다).
- Message의 하위 호환 추가 필드 `deliveryRevision`은 DB의 메시지별 정수(`delivery_revision`, 기존·새 메시지 초기값 0)다. `setMessageDelivery`는 상태·사유 저장과 같은 트랜잭션에서 1 증가시키며 같은 상태 재기록과 명시적 재시도 `failed → queued`도 증가한다. POST·단건/목록/페이지/around·state/sync·WS는 저장된 같은 판을 싣는다. 앱은 같은 ID의 더 큰 판만 전달 상태·사유에 적용하고 같거나 작은 판과 판 없는 늦은 스냅샷은 이미 아는 상태를 덮지 않는다. 본문·자료 연결 등 다른 메타데이터는 이 판으로 막지 않는다. 구버전 서버처럼 양쪽 모두 판이 없으면 기존 도착 순서 호환을 유지한다. 불확실 전달의 자동 재전송 계약은 바뀌지 않는다.
- `GET /api/projects/archived` → Project[] · `PATCH archived:true`는 working·blocked·열린 결재·미완료 할 일·안전하게 종료할 수 없는 세션이 있으면 거부한다. 종료 전 상태·소유권·초안을 확인하고 확인할 수 없는 연결 오류도 성공으로 처리하지 않는다. 한 번도 턴을 돌지 않은 깨어 있는 Claude 세션(세션 기록 없음, 이 세대에 받아들여진 전달 0건, 관측된 턴 0)과 터미널이 이미 없는 것이 확인된 offline 팀장은 보관을 막지 않는다(초안 검사는 그대로이며, 꺼내서 깨우면 기록 없는 세션은 새 세션으로 열린다). 보관되면 세션을 잠재우고 전달은 `held(archived)`로 둔다. 보관 중에는 자동 깨움·새 세션·`runnerEnabled:true` 단독을 거부한다. 꺼내기는 archived 때문에 보류된 전달만 재검사하며 모든 팀장을 기동하지 않는다(§3.4).
- `GET /api/projects/:id/decisions?status=done|open&before=<at>&limit=` → Decision[]. 기본 done(최근 답한 순, `before` 는 그 answeredAt 앞). open 은 전부(오래된 순, before·limit 무시) · `GET /api/decisions/:id` → Decision
- `POST /api/decisions/:id/answer`(AnswerReq) 멱등 → Decision. 새 답인데 연결되어 있지 않으면 409(같은 답 재전송은 그대로 돌려준다). v1의 `expectedVersion?`는 읽은 `Decision.updatedAt` 문자열이고 다르면 409; v2에서는 필수(§3.3)다. 사용 한도 카드(`kind:"usage_limit"`)의 options 는 그 CLI 모델 목록에서 카드의 팀장들이 한도에 걸린 모델(쓰던 모델, 한도 글에 이름이 나온 모델, 이 카드에서 앞서 걸린 모델: 그 팀장이 빠져도 카드가 기억한다)을 뺀 `model:<값>`(글 `<표시 이름>로 바꿔 이어가기`)들 다음에 `resume`(글 `계정을 바꿨거나 한도를 늘렸어요 · 이어가기`, 키는 출시된 앱 때문에 그대로)이다. 모델 선택지는 모델에 한정된 한도(모델 크레딧 소진, `You've hit your Opus limit`처럼 목록의 모델 이름이 붙은 한도)가 카드에 하나라도 있을 때만 낸다. 5시간·주간·이름 없는 한도와 Codex 한도는 계정 전체의 한도라 `resume`만 낸다. 팀장이 빠지거나 모델 목록이 바뀌면 다시 계산한다(선택지·팀장만 바뀌어서는 `updatedAt`을 올리지 않는다. 카드 푸시 알림이 그 판에 묶여 있다. 앱은 선택지나 팀장이 바뀌면 카드를 새로 그린다). `model:<값>` 답은 카드에 남은 팀장 모두를 그 모델로 바꿔(팀장 설정 변경과 같은 길, §6) 같은 세션을 이어 열고, 목록에 없는 값·다른 CLI 의 값·한도에 걸린 모델은 400, 이미 바꿔 닫힌 카드에 같은 답이 다시 오면 그 카드를 그대로 돌려준다(한 명이라도 바꾼 뒤에만 그 답을 적어 둔다). 카드에 답한 것이 아직 도는 동안 같은 답은 그 결과를 함께 받고 다른 답은 409(`다른 선택을 처리하는 중입니다…`)다. 카드의 팀장이 모두 이어가기 결과를 기다리는 중이면 모델 답은 409다. 앱은 모델 답에 본 카드의 팀장 `memberIds`를 싣고(AnswerReq, 선택), 지금 카드의 팀장과 다르면 409(`카드의 팀장이 바뀌었습니다…`)다. 모델 답은 팀장마다 Esc·끝내기·다시 열기를 차례로 마친 뒤 답하므로 앱은 150초를 기다린다. 거절 글에는 '사용 한도'를 쓰지 않는다(앱이 그 낱말이 든 오류를 한도 안내로 바꿔 보여 준다). 기다리기는 버튼이 아니라 기본 동작이다(풀리면 자동으로 이어 간다). 카드 글은 계정 수를 가정하지 않는다(모델 크레딧 소진이면 그 모델 이름과 '다른 모델로 바꾸면 바로'를 먼저 적는다. 모델을 고르라는 글에는 출시된 iPhone처럼 모델 버튼이 없는 앱을 위해 '팀장 설정에서 바꾸거나 총괄에게 모델을 바꿔 이어 가라고 하라'를 붙인다). 자동 이어가기는 잠든 팀장을 깨우지 않는다(카드의 '이어가기'와 모델 변경만 깨운다)
- `POST /api/todos/:id/drop` `{reason?:string}` → Todo. 대표 인증, 연결과 상관없이 된다. 열린 할 일을 `done=true`, `outcome=dropped`, `closedBy="대표"`, `closeReason=사유 또는 "대표가 필요 없음으로 정리"`로 닫는다. 빈 사유는 기본값을 쓴다(최대 100,000자). 이미 dropped면 원래 결과를 반환하고 중복 알림은 넣지 않는다. 이미 done인 항목은 409. 부탁한 팀장과 총괄에 `"[대표] '<제목>' 필요 없음"`을 기존 완료와 같은 wake 정책으로 알리며, 총괄이 없으면 기존 완료처럼 영속 보류한다. 기존 done 경로와 체크 되돌리기는 유지한다.
- `POST /api/todos/:id/done` `{done:boolean}` → Todo. 연결과 상관없이 된다. 체크를 풀면 AI 의 정리 이유도 지운다
- `POST /api/decisions/:id/reopen` → Decision. AI 가 `ask_close` 로 닫은 카드만(아니면 409). 결재할 항목으로 돌아가고(`reopenNote` 에 닫은 이유), 물은 팀장·총괄에게 wake=false 로 알린다
- `POST /api/projects/:id/tidy` → TidyResult(`{already}`). 총괄(본사는 본사 AI)에게 판 정리 지시를 넣는다. 연결되어 있지 않으면 409, 총괄이 없거나 잠들었으면 띄운다. 이미 기다리거나 도는 정리가 있으면 `already:true`
- `GET /api/files/:id` → `FileDoc` 전체 본문(인증, 없는 ID는 404).
- `GET /api/files/:id/artifact` → `{html}`(인증. kind=artifact만, 아니면 404). 기존 html 원문 JSON을 유지한다. `?render=1`은 키트로 조립한 HTML 문서이며 `sandbox allow-scripts` CSP로 불투명 출처에 격리한다. 앱은 쿠키·API·외부 탐색을 차단한 WKWebView에서 연다.
- `POST /api/projects/:id/members` `{name,role?,cli?:"claude"|"codex",modelOverride?:string|null}` → Member. 새 core 팀장 세션을 만든다
- `PATCH /api/members/:id` `{cli?:"claude"|"codex",modelOverride?:string|null,effortOverride?:Effort|null}` → Member. null은 적용 가능한 기본값으로 되돌린다. 직접 띄운 세션은 400. CLI 변경 시 생략한 기존 override가 새 제공자의 모델·모델별 effort 목록에 없으면 null로 비우고 직급 기본값으로 돌아간다. 이때 활동 기록과 응답의 `resetOverrides` 배열에 비운 필드 이름을 남긴다(v2는 `member.resetOverrides`). 같은 요청에 명시한 모델·effort는 새 제공자 목록으로 검증한다. 제공자·살아 있는 세션 설정 변경은 §6의 이력·토큰 회전·안전한 교체 절차를 따른다
- `GET /api/members/:id/activity?limit=` → Activity[] · `GET /api/members/:id/screen` → `{text}` (core 현재 화면, `lines:0`; 터미널이 없거나 끝난 팀장(잠듦·offline)은 500이 아니라 200과 빈 글, 소유 불일치·연결 실패는 오류)
- `POST /api/members/:id/terminal/control` `{action:"claim"|"release"|"input"|"key",leaseId?,text?,key?}` → `{leaseId?,expiresAt?}`. 사용자 접속 코드로만 인증한다. lease는 5분, input은 128 KiB까지, key는 enter/up/down/esc/tab/ctrl+c/backspace. claim 외에는 같은 활성 token이 필요하고 직접 조작 중 자동 입력은 보류한다. CLI의 신뢰·인증·권한 선택은 이 명시적 사람 조작이나 `iamceo attach <memberId>`로 처리한다
- 옛 herdr 연동의 주소 `GET /api/herdr/agents`, `GET /api/projects/:id/adopt/preview`, `POST /api/projects/:id/adopt`, `POST /api/members/:id/release`, `POST /api/members/:id/reopen-with-tools`는 기능을 지웠다. 인증을 통과한 요청에 `410`과 한국어 안내(`{error}`)로 답하고 아무것도 읽거나 바꾸지 않는다. 출시된 앱(0.2.2)은 이 주소를 부르지 않는다.
- `/api/members/:id/approval`의 fingerprint 승인은 남아 있다. core는 권한 승인 창을 구조화해 읽거나 대신 고르지 않고, 기존 외부 터미널을 편입하지 않는다. 읽는 창은 실측한 폴더 신뢰 창(Claude `Accessing workspace:`, Codex `Folder access`)뿐이다. core는 이 창을 글자와 폴더 경로가 정확히 같을 때만 읽어 `blockedReason:"setup"`·`folder_trust`로 올리고 대표가 같은 승인 API로 답한다. `POST /api/projects`에 `trustFolder:true`를 실어 만든 프로젝트에서는 그 프로젝트 폴더의 이 창에 서버가 '신뢰'를 대신 고른다(조건은 아래 '추가 계약(1차 완성도)')
- `POST /api/members/:id/fresh-session`은 같은 제공자의 새 세션으로 명시적으로 인계한다. 작업 중·승인 대기·불확실한 전달·직접 관리하는 세션은 거부한다. 잃어버린 Codex 세션과 기존 실행기 멤버를 복구하는 경로이며, 기존 실행기 터미널은 건드리지 않는다. 멤버 기록을 유지하고 세션 이력·토큰을 회전한다.
- `POST /api/members/:id/sleep`(`{force?}` 는 대표가 '그래도 재우기'를 눌렀을 때만) · `POST /api/members/:id/resume|compact`(resume 은 실행이 꺼진 프로젝트면 409) · `POST /api/members/:id/interrupt` · `POST /api/members/:id/close`(직접 띄운 세션만)
- `PUT /api/settings`(SettingsPatch) → Settings. `ranks`·`codexRanks`는 고친 칸만 보내도 된다. `ranks`는 Claude, `codexRanks`는 Codex의 manager/lead/staff별 `{model,effort}` 기본값이다. 팀장별 지정이 먼저이며 null이면 해당 CLI 자체 기본값을 쓴다. Codex 기본값은 모두 null이고 effort는 선택한 모델의 `/api/models` efforts 목록으로 검증한다. 모델이 기본값이거나 efforts가 비어 있으면 제공자 기본 목록(Claude low/medium/high/xhigh/max, Codex minimal/low/medium/high/xhigh)을 쓴다. 캐시에 새 effort가 추가되면 같은 문자열을 저장할 수 있다. effort만 고치는 PATCH/PUT도 저장된 모델로 검증한다. 직급 model만 바꾸어 기존 effort가 새 목록에서 빠지면 null로 비우며 응답의 `resetEfforts`에 `codexRanks.lead.effort` 같은 필드 경로를 남긴다(v2는 `settings.resetEfforts`). 이 배열은 응답 전용이며 저장하지 않는다. Codex staff 노력은 저장만 하며 실행에 전달하지 않고, staff 모델은 `agents.default_subagent_model`로 전달한다. 필드 없는 레거시 저장은 기존 codexRanks를 유지한다. 실행 중인 턴을 중단하지 않고 기존 ranks와 같은 다음 설정 적용 경로를 따른다. 저장된 과거 backend 값과 무관하게 이 소스의 새 실행은 core다. 제공자 선택은 멤버의 cli로 한다
- `GET /files/<attachment id>/<name>` 첨부는 Bearer 헤더로만 인증한다. 래스터 이미지·영상·오디오만 inline, html·svg·xml 등은 attachment다. Range/HEAD, `no-store`, `no-referrer`, sandbox CSP를 유지한다. 파일 쿠키 세션은 제거했다. `WS /ws` v1도 Bearer 헤더를 쓴다. `/`는 짧은 네이티브 앱 안내를 내며 웹 HTML·정적 자산은 제공하지 않는다.
접근: 설정된 host 에만 listen(기본 127.0.0.1 + 확인된 Tailscale 주소. 100.64.0.0/10 대역이라는 것만으로는 Tailscale 로 보지 않고, Tailscale 터널 인터페이스에 붙은 주소이거나 `tailscale` 명령이 확인한 주소일 때만 연다. 확인하지 못하면 127.0.0.1 에만 연다. `hosts`를 안 적었으면 Tailscale 이 늦게 올라와도 30초 주기 점검이 그 주소를 연다. `hosts`에 직접 적은 주소는 확인 없이 연다). 요청 IP는 127.0.0.0/8·::1 을 늘 받고, Tailscale 대역(100.64.0.0/10·fd7a:115c:a1e0::/48)의 상대는 서버가 그런 주소(확인됐거나 `hosts`에 직접 적은 Tailscale 주소)에서 실제로 듣고 있을 때만 받는다. `0.0.0.0`·`::` 로 듣는 설치는 Tailscale 이 확인될 때만 그 대역을 받는다. 그 밖은 403(`hosts`에 LAN을 넣으면 그 대역 허용, `iamceo setup --hosts lan`). `iamceo setup --hosts`는 `0.0.0.0`·`::` 를 거부하지만 `config.json`에 직접 적은 값은 막지 않는다. 화면 파일(HTML·JS)도 같은 검사를 거친다. 비교는 상수 시간. `Origin`이 있으면 Host 와 같아야 한다. Host 는 IP·localhost·설정한 hosts·점 없는 이름·`.local`·`.ts.net` 만 받는다(DNS 리바인딩 차단). 페이지에는 CSP(`script-src 'self'`, `img-src 'self' data: blob:`, `frame-src 'self' blob:`)를 건다. WS 는 15초마다 `ping` 을 보내고, 화면은 45초 조용하면 소켓을 새로 잇는다.

### 3.1 연결 상태

`Project.connection`·`ProjectSummary.connection`은 `{ok,reason:'runner_off'|'backend_down'|'archived'|null,detail}`다. 보관 아님이고 실행 켜짐과 core availability가 충족되거나 살아 있는 직접 CLI가 있어야 한다. 서버는 주기적으로, 입력 직전에 다시 확인한다. 연결 게이트는 메시지·결재 답·재전송·프로젝트 첨부를 409로 막고 화면도 같은 사유를 보인다. `ask`·`todo`·`post` 같은 세션 도구와 대표의 할 일 체크는 별도다. 보관 중에는 세션을 자동으로 깨우지 않는다.

core가 응답해도 각 CLI의 trust/auth/권한 창이나 상태 미보고로 멤버 입력이 보류될 수 있다. 코어 설치·연결 진단과 모델 로그인 성공은 같은 뜻이 아니다. 서버 재시작의 delivering 또는 PTY 응답 손실은 `delivery_unknown`으로 보류하며 재시도 틱이 자동 재전송하지 않는다. 그 입력을 받은 터미널의 사라짐이 확정된 뒤의 판정은 "터미널의 사라짐이 확정되면"(§재시작 복구)을 따른다. 지워진 옛 실행기(herdr·headless)의 세션이 남은 팀장은 `legacy_session`으로 보류하고 명시적 전환 전에는 새 core를 열지 않는다.

### 3.2 네이티브 아티팩트

`FileDoc.kind`: document·artifact·image·pdf·table·code·video·audio·file. 저장값이 없는 옛 행은 첨부·본문으로 계산한다(`fileKindOf`). table·code는 1MB 이하면 `body`에 원문이 있고 첨부로도 받는다. 네이티브는 `/api/files/:id/artifact` 원본 또는 `?render=1`의 키트 포함 HTML을 Bearer로 읽는다. 프로젝트 로컬 HTML은 `/api/projects/:id/local-file?path=…&render=1`을 쓴다. render 응답은 `sandbox allow-scripts`와 ARTIFACT_CSP를 유지한다. 앱의 비영속 WKWebView에서 인라인 JavaScript를 허용하며 외부 네트워크·쿠키·직접 탐색을 차단하고 링크는 앱이 확인 후 연다. 민감한 데이터는 HTML에 싣지 않는다. 웹 iframe 부트스트랩 `/artifact-frame`과 웹 화면은 제거했다.

### 3.3 strict v2 쓰기와 v1 잔여 제약

`GET /api/capabilities` → `{contractVersion:2,capabilities:{paging,archive,delivery,realtime,push,operations}}`. 각 값은 boolean이며 실제 주입된 서비스에 따라 다르다. operations는 결과 조회와 모든 엄격 쓰기 포트가 있을 때만 true다. 조회 실패를 연결 실패나 쓰기 재생의 이유로 삼지 않는다. 네이티브는 지원을 확인한 새 쓰기에 `X-IAMCEO-Contract: 2`를 붙인다. 헤더 생략/`1`은 v1이다. 이 헤더를 검사하는 경로에서 다른 값은 400 `INVALID_CONTRACT`다.

| 경로 | v2 요청 | 200 응답 |
|---|---|---|
| `PUT /api/settings` | 기존 부분 SettingsPatch + `If-Match: "<revision>"`; ranks도 고친 하위 필드만 | `{settings,revision}` |
| `PATCH /api/members/:id` | 기존 PatchMemberReq + 같은 If-Match | `{member,configRevision,sessionGeneration}` |
| `POST /api/todos/:id/drop` | `{reason?:string}` + 같은 If-Match | `{todo,revision}` |
| `POST /api/todos/:id/done` | `{done:boolean}` + 같은 If-Match | `{todo,revision}` |
| `POST /api/decisions/:id/answer` | 기존 AnswerReq + **문자열** `expectedVersion=Decision.updatedAt` | Decision 자체 |
| `POST /api/members/:id/fresh-session` | `{operationId:"UUID",expectedSessionGeneration:0}` | OperationReceipt |
| `POST /api/members/:id/terminal/control` | 아래 공통 신원 + action별 필드 | OperationReceipt |

If-Match는 따옴표를 포함한 비음수 안전 정수이며 누락/문법 오류는 400 `INVALID_REVISION`, 오래된 검토 값은 409다. 실제 revision·세대는 `/api/sync.revisions`에서 읽으며 예시의 0을 고정값으로 재사용하지 않는다. 결재 버전 누락은 400, 바뀐 새 답은 409다. 동일 답의 재조회는 버전 재검사보다 앞선 멱등 경로를 유지한다. 결재의 문자열 버전과 recovery의 숫자 버전은 별개다.

terminal 공통 body는 `{operationId:"UUID",expectedSessionGeneration:<정수>,claimId:<클라이언트 생성 문자열>,action}`다. claim/release에는 추가 필드가 없고, input에는 `inputSequence:<비음수 안전 정수>,text`, key에는 `inputSequence,key`가 필수다. 허용 키는 기존과 같다. 입력 순번은 현재 lease의 마지막 순번+1이어야 하고 claim/release에는 순번을 보내지 않는다. v2 input text는 131072 UTF-16 code unit 상한의 strict schema다. claim ID는 응답 유실에도 재사용하고 lease는 terminal·세대에 결합하여 재시작 뒤 큐보다 먼저 복원한다.

`GET /api/operations/:operationId` → `{operationId,kind,projectId,memberId,createdAt,updatedAt,status,...}`. status는 `pending|applied|refused|unknown`; applied만 허용된 `result`, refused/unknown은 `code,error`를 가진다. fresh result는 `{member,sessionGeneration}`, terminal result는 `{memberId,action,claimId,sessionGeneration,inputSequence?,leaseId?,expiresAt?}`(expiresAt은 Unix ms)다. 없는 작업 404, 잘못된 UUID 400, 미지원 501. 인증·소속을 항상 검사하며 임의 요청 body나 MCP 토큰을 반환하지 않는다. 같은 operation ID/요청의 receipt를 세대 재검사보다 먼저 돌려주되 다른 body/대상 재사용은 409다. `unknown`은 실패로 추정해 재입력하지 않는다. fresh/terminal의 실행·세대/lease 거부는 HTTP 200 receipt의 `status:"refused"`로도 반환하므로 HTTP 성공만으로 적용됐다고 보지 않는다. CAS 경로의 오래된 revision은 HTTP 409다.

v1은 기존 Settings/Member/Todo 객체 자체, 무본문 fresh, terminal `{leaseId?,expiresAt?}`, 선택적 결재 버전과 `Message.delivery`의 `queued|held|delivering|delivered|failed`를 유지한다. 따라서 버전 없는 v1 설정·결재·fresh·terminal은 v2와 같은 충돌/재생 보호를 보장하지 않는다. 배포된 네이티브 앱이 사용하는 v1 경로는 유지하며 기기별 API 인증 철회는 제공하지 않는다. APNs 기기 해지는 API 접속 권한 회수가 아니다.

### 3.4 대화 페이지와 보관 읽기

- `GET /api/projects/:id/messages/page` → `{projectId,scope,items,nextCursor,hasOlder}`. 허용 query는 `scope,memberId,limit,cursor` 네 개뿐이고 중복도 400이다. limit 기본 200, 명시 십진 정수 1…500; 앱 최초 200/이전 100. cursor는 불투명 base64url이며 클라이언트가 만들거나 해석하지 않는다.
- scope 생략/project는 전체, member는 memberId 필수다. 현재 root/conductor ID는 project로 정규화하고 다른 팀장은 `memberId == id OR targetMemberId == id`를 해당 프로젝트 안에서 조회한다. project+memberId는 400. 삭제된 담당자도 과거 ID 범위로 조회할 수 있다.
- `(at COLLATE BINARY,id COLLATE BINARY)` keyset의 오름차순 items, exclusive 이전 커서다. 잘못된 query는 `INVALID_MESSAGE_PAGE_QUERY`, cursor는 `INVALID_MESSAGE_CURSOR`(400), 별칭 정규화 변경은 `MESSAGE_SCOPE_CHANGED`(409). 빈 페이지/마지막은 `hasOlder:false,nextCursor:null`이다. 없는/보관 프로젝트는 일반 page/state에서 404다.
- 기존 `/messages?before=<at>&limit=`의 Message[]·시각/rowid 정렬과 `/state.messages` 최근 200개는 유지한다. `/messages?around=<messageId>&limit=41`은 기존 Message[] 모양의 주변 조회(최대 100)다. around와 before 병용은 400, 다른 프로젝트/없는 anchor는 404다. `GET /api/messages/:id`는 저장된 Message 전체를 반환하며 없는 원본이나 보관 프로젝트의 메시지는 404다. 일반 `/messages` 목록·around도 보관 프로젝트에는 404를 반환한다.
- `GET /api/projects/archived` → Project[]. `GET /api/projects/:id/archive/state` → archived Project를 포함한 ProjectState, `GET /api/projects/:id/archive/messages/page` → 같은 MessagePage다. `GET /api/projects/:id/archive/messages`는 기존 Message[] 모양의 목록·before·around 조회이고, `GET /api/projects/:id/archive/messages/:message`는 해당 보관 프로젝트의 Message 단건 조회다. archive 경로는 없는/활성 프로젝트에서 404이며 다른 프로젝트의 단건·around 대상도 404다. page query·정렬은 위와 같고 GET은 CLI를 깨우지 않는다.
- 보관함에서는 대화·결재·업무·자료를 **읽기 전용 UI**로 연다. 보내기·답·체크·팀장 조작은 없고 이름 변경/꺼내기는 별도 관리 액션이다. 늦은 manual 보고·자료 및 v1 todo 호환 때문에 DB 불변 snapshot은 아니다.
- 이름만 변경하면 ID·초안·세션·이력은 유지한다. 보관은 Orchestrator의 단일 PATCH 진입점에서 전원 사전 검사→안전 stop→실제 종료 확인→저장 순서다. resume 가능한 native ID/기록을 확인하며 Codex ID 미확인은 기존 표식으로 탐색한 뒤에도 불명이면 409로 보류한다. HQ 보관은 400, 삭제 API는 없다. 일부 종료 실패면 프로젝트 PATCH는 미반영하고 이미 종료한 팀장은 asleep으로 남기며 나머지는 참조·journal을 보존한다. manual 프로세스는 종료하지 않는다.

history는 snapshot과 별도 캐시다. ID 중복 제거·진행 중 이벤트/POST overlay로 오래된 GET의 상태 역전을 막고, 200개 초과 재접속 gap은 staging 페이지가 기존 ID와 겹칠 때까지 연결한다. 실패/저장소 교체 시 기존 기록·커서·초안을 유지하고 계속/재시작 선택을 제공한다. prepend 적용 직전의 첫 가시 메시지와 부분 offset을 유지하며 prepend·동일 ID 상태 변경은 새 글 수에 넣지 않는다. page 404만으로 구형 서버라 하지 않고 같은 프로젝트 state 200을 확인한 뒤 지원하지 않는 최근 200개 모드로 안내한다.

### 3.5 전달 증거와 복구

접수·CLI 수신·턴 시작/종료·MCP 보고·업무 완료는 별개다. 원본과 전달 의도를 같은 DB transaction에 저장하고 commit 후 pump한다. 대표 메시지·결재 답 POST는 이 commit으로 접수를 완료해 기존 Message/Decision 모양을 반환한다. start·기동 중인 pump·연결 health probe를 기다리지 않으며 응답 당시 전달은 queued일 수 있다. 이후 기동·전달 실패는 해당 전달의 held/needs_owner 등 기존 상태로 드러난다. 접수 뒤 확정 기동 거절에도 수신자 명부와 outbox를 남긴다. 불확실 기동은 기존 lifecycle journal을 확인하며 새 시작을 추측하지 않는다. 전체 DB에서 누락 원본을 수선하며 최근 200/500건을 집계 한계로 쓰지 않는다. 봉투 구성·표식·wire hash·세션 세대·기록 기준선을 외부 쓰기 전에 저장한다.

정확한 주 세션 user-text 표식 또는 검증된 수신 ACK만 받음이다. assistant 인용·tool_result·sidechain·다른 세션·현재 composer·working·조회 실패는 받음이 아니다. 기록 없음/불완전/미지원/원래 쓰기 미종료는 unknown이다. `terminal.send`의 검증된 성공 ACK와 `started:false`는 수신 계약을 유지하되 턴 시작·완료를 뜻하지 않는다.

- 긍정 증거는 failed/held 오표시를 자동 정정한다. 확정 쓰기 전 실패/부작용 없는 거절만 안전 재검사 뒤 같은 delivery ID·표식으로 최대 3회(2/10/30초+jitter) 복구한다. post-write timeout 뒤 부재·시간 경과·빈 화면만으로 재전송하지 않는다.
- 저장 wire text와 **전체** composer가 일치하고 같은 세션·세대·소유권·원래 쓰기 settled를 증명할 때만 Enter 1회다. 부분/사용자 수정/축약 입력에는 무입력이며 clear/re-paste·승인 자동 선택은 없다. generation 1에서 검증되지 않은 drain 장벽은 있다고 가정하지 않는다.
- 확인은 즉시·1/3/10/30초, 이후 60초, 활성 확인 2분을 기본으로 하며 busy/승인/lease 대기는 예산에서 뺀다. 유효 lease 중 자동 입력·기록 스캔을 보류한다. 확인 일정·횟수는 영속화한다. 해결되지 않은 팀장의 후속/urgent는 막되 다른 팀장은 진행한다.
- recovery phase는 `none|checking|waiting|retry_wait|needs_owner|resolved|stopped`. user 기록과 같은 표식의 composer가 함께 있으면 delivered를 유지하면서 `duplicate_draft`로 입력 fence를 남긴다. 초안은 삭제하지 않는다. 홈 개입 수·명패는 needsOwner만 세고 자동 확인은 개입 수 0이다.

`ProjectState.deliveryNotices`는 version 2, members 집계와 unassigned 집계를 제공한다. undelivered/unknown/delivering은 배타적이고 checking/needsOwner/waitingBehind는 보조 집합이라 합산하지 않는다. 실제 대상이 불명이면 현재 총괄로 추측 배정하지 않는다.

`GET /api/members/:id/delivery-notices?limit=50&before=<cursor>` → `{memberId,summary,items,nextBefore}`. limit 1…100, 전체 DB summary는 페이지 크기와 독립이다. item은 숫자 `version`, phase/reason·마지막/다음 확인 시각·evidence·recommendation·allowedActions·원본 ref를 가진다. 원시 화면·wire text·기록 경로를 내보내지 않는다.

`POST /api/deliveries/:id/recovery` body는 `{operationId:"UUID",expectedVersion:<양의 정수>,action:"recheck"|"retry_with_risk"|"stop_retry"}`다. retry_with_risk만 `acceptDuplicateRisk:true`가 필수이고 다른 action에는 금지다. recheck/retry는 202와 `{operationId,deliveryId,outcome:"check_scheduled"|"retry_scheduled",committedVersion}`, stop은 200과 `outcome:"stopped"`다. 같은 요청은 저장 결과를 재현하고 다른 요청 ID 재사용/상태 변경은 409, 없는/보관 대상 404, 미지원 501이다. 202는 예약 접수이며 수신 성공이 아니다. 허용 행동은 서버 allowedActions를 따르고 위험 동의도 lease/초안/원래 RPC/세션 안전 조건을 우회하지 않는다. stop은 추가 전달 포기이며 과거 수신·업무 완료 판정이 아니다. `confirm_received` API/받음 확정 버튼은 없다.

#### 대기 사유와 정체 알림

수신자 없는 옛 실패 정리 (unassigned-fail):

- `ProjectState.deliveryNotices.unassignedItems` 및 `GET /api/projects/:id/delivery-notices`의 `unassignedItems`는 전체 DB의 수신자 없는 가상 실패 목록이다. 기존 version 2·members·unassigned 집계는 그대로이며 새 목록은 하위 호환 추가 필드다. 각 항목은 `id:"message:<messageId>",messageId,projectId,memberId:"",preview,createdAt,version:0,allowedActions:["send_to_conductor","dismiss"]`와 기존 notice 메타데이터를 갖는다. GET은 입력이나 자동 수신자 배정을 하지 않는다. 새 앱의 `unassignedDeliveries`/`loadUnassignedDeliveries()`가 이 목록을 읽으며 목록이 없는 구형 서버는 빈 목록으로 처리한다.
- 대표 Bearer 인증의 `POST /api/messages/:id/recovery` body는 `{operationId:"UUID",expectedVersion:0,action:"send_to_conductor"|"dismiss"}`다. 추가 키·음수/소수/비안전 정수는 400, 다른 검토 버전·이미 실제 전달이 있는 메시지·대표가 쓰지 않은 글·보관 프로젝트는 409다. 총괄 전송은 현재 수신자가 없는 옛 failed 메시지만 받으며 현재 총괄이 없으면 이유와 함께 409다. 존재하지 않는 글 404, 미지원 서비스 501, 잘못된 계약 헤더 400이다. 새 앱은 `X-IAMCEO-Contract: 2`를 붙이며 검토 버전/operationId는 기존 전달 복구와 같은 body 계약이다. 헤더 없는 구형 클라이언트에도 기존 경로는 유지한다.
- `send_to_conductor`는 원본 메시지의 ID·본문·생성 시각·기존 target을 보존하고 현재 총괄에 연결된 새 queued/wake 전달 한 건을 저장한 뒤 기존 pump를 예약한다. 실행기가 받았다는 판정은 하지 않는다. 202와 `{operationId,messageId,deliveryId,outcome:"send_scheduled",committedVersion:1}`을 반환하며 unassigned/needsOwner에서 빠지고 총괄의 undelivered로 이동한다. 생산용 전달에는 기존 대표 접두어·메시지 참조·첨부 경로·자료 맥락을 포함한다. 없는 총괄을 자동 생성하지 않는다.
- `dismiss`는 전달 없이 메시지의 DB delivery를 `dismissed`로 저장하고 200과 `{operationId,messageId,deliveryId:null,outcome:"dismissed",committedVersion:1}`을 반환한다. 메시지는 삭제하지 않으며 needsOwner·unassigned·undelivered 집계에서 제외된다. 수신자가 있는 가상 실패에도 dismiss를 허용한다. 구형 앱의 다섯 delivery 값 계약을 보존하기 위해 모든 읽기/WS 응답은 `delivery:"held",deliveryDisposition:"dismissed"`를 내보낸다. 새 네이티브 모델은 disposition을 `Message.delivery == "dismissed"`로 해석한다. 새 deliveryRevision이 늦은 failed 응답의 덮어쓰기를 막는다. held는 수신 성공 표시가 아니며 실제 전달 행도 생기지 않는다. 표시 문구는 View 담당이 정한다.
- DB v31의 `unassigned_message_recoveries`가 메시지 ID·operationId·정규화 요청·결과·action·주체 `owner`(대표)·지정 총괄 ID·UTC 시각을 같은 트랜잭션에 저장한다. 같은 operationId/요청은 검토 버전 검사보다 먼저 저장 결과를 재현한다. 다른 메시지/본문으로 ID를 재사용하면 409다. 새 operationId라도 같은 메시지/동작/검토 버전이면 동일 결과를 재현하고 새 전달·상태 변경은 하지 않는다. 다른 동작으로 뒤집기는 409다. 보관 프로젝트는 재요청도 409다.
- 모든 needs_owner 항목은 가상이면 dismiss, 실제면 stop_retry를 최소 하나 갖는다. duplicate_draft의 stop_retry는 이미 delivered인 원래 수신 표시를 보존하며 추가 전달만 중지한다. 물리 입력의 미종료 fence는 기존 안전 규칙대로 유지한다.
- 앱의 `@discardableResult func sendUnassignedToConductor(messageID: String) async -> Bool` 및 `@discardableResult func dismissUndelivered(messageID: String) async -> Bool`는 기존 canWrite·프로젝트/연결 세대 검사·항목별 잠금·디스크 journal을 따른다. 응답 유실 시 원래 operationId/검토 버전을 재사용하고 다른 동작은 막는다. 완료 후 notices/state와 원본 메시지 단건을 다시 읽어 최근 200건 밖 대화 기록에도 반영한다. 자동 재전송은 하지 않는다.

`Message.deliveryInfo`는 해당 메시지의 미종결 전달마다 `{deliveryId,memberId,waitReason,waitingSince,runLimit?}`를 추가한다. message 단건·페이지·state·WS에서 같은 계산을 쓴다. 기존 `delivery`·`deliveryNote`는 유지한다. `DeliveryNoticeItem`에도 같은 wait 필드가 있다. 멤버 요약(`deliveryNotices.members[]`, 상세의 `summary`)은 가장 오래 기다린 항목의 `waitReason,waitingSince,runLimit?`와 사유별 `waitReasons:[{waitReason,waitingSince,runLimit?,count}]`를 추가한다. 대기 항목이 없으면 요약 사유·시각은 null, 목록은 빈 배열이다.

| waitReason | 뜻 |
|---|---|
| next_turn | `wake=0` 입력이 다음 업무 턴에 합류하기를 기다림. 생성 당시 진행 중이던 턴은 대상이 아님 |
| run_limit | 전역 동시 실행 한도. `runLimit:{used,limit}`는 실제 점유 중인 팀장 수와 한도 |
| member_busy | 대상 팀장이 앞 일을 처리 중 |
| waking | 시작·재결합 또는 깨우기 진행 중 |
| receipt_check | 앞 입력의 미확정 수신·물리 입력 fence 확인 중 |
| approval | 팀장의 승인·선택 창 앞 |
| manual_control | 유효한 직접 조작권 때문에 자동 입력 보류 |
| runner_off | 실행 꺼짐 또는 실행기 연결 불가 |
| archived | 보관된 프로젝트 |
| unknown | 위 사유로 설명되지 않는 대기 |

`waitingSince`는 전달 생성 시각(ISO UTC)이다. 사유가 바뀌어도 이 전달이 연속 대기한 전체 시간을 보존하며 받음/종료된 항목은 메시지의 대기 목록에서 빠진다. GET은 저장된 정보와 메모리 상태만 읽고 실행기·pump를 호출하지 않는다.

명확한 사유 없이 마지막 전달 진행(최근 봉투 updatedAt, 봉투가 없으면 생성)부터 120초 이상 멈추면 delivery ID당 한 번 영속 정체 기록·error activity·대표가 읽는 시스템 메시지('전달 확인 필요')를 남긴다. 이 항목은 notice에서 `phase:needs_owner,reason:stalled,recommendation:{code:"recheck",text:"다시 확인"},allowedActions:["recheck","stop_retry"]`로 보인다. 정체 항목도 대표가 stop_retry로 정리할 수 있으며 과거 수신 여부를 판정하지 않는다. 원래 recovery phase/fence를 거짓 unknown으로 바꾸지 않는다. 기존 복구 API의 version/operationId로 recheck하면 안전 검사를 거친 같은 전달의 pump를 예약한다. 새 전달·원본 복제·위험 재전송 동의를 만들지 않는다. 이미 불확실한 입력은 기존 증거 확인·비재전송 규칙을 그대로 따른다.

`next_turn`은 아직 시도하지 않은 `wake=0` 전달에 적용하며 idle·수면·기존 업무 진행 중에도 정체로 판정하지 않는다. 전달 생성 시 execution journal의 순서를 `deliveries.next_turn_after_run`에 저장해 재시작·동일 밀리초에도 기존 턴과 이후 턴을 구별한다. 기존 데이터는 전달 생성 시각 이전의 실행으로 경계를 복원한다. 이후 실행이 실제 시작(`started_at`)했는데도 queued로 남으면 `next_turn` 예외를 끝내고, 업무 진행·실행 한도로 가리지 않고 기존 120초 정체 검사를 적용한다. 수신 불확실·결재·직접 조작 등 기존 안전 사유가 우선한다. `wake=1` 정체 판정은 유지한다. 정체 재평가에서 정상 사유가 확인되거나 전달이 종결되면 `delivery_stalls.resolved_at`을 기록해 활성 알림을 해제한다. 과거 시스템 메시지와 activity는 보존하고 같은 전달의 알림을 중복 생성하지 않는다. 앱 표시 문구는 `waitReasonLabel` 담당에서 정한다.

### 3.6 실시간 sync와 iPhone APNs

`GET /api/sync?projectId=<id>`는 사용자 Bearer 아래 `{protocol:2,cursor:{epoch,seq},requestedProjectId,projectStatus,bootstrap,state,revisions}`를 반환한다. projectStatus는 `none|ok|not_found|archived`; 부재/보관도 HTTP 200과 state=null이다. bootstrap은 runtime을 제외하고 revisions는 `{settings,members:{[id]:{configRevision,sessionGeneration}},todos:{[id]:revision}}`다. state와 cursor/revisions는 같은 동기 읽기 경계다. projectId 외 query·빈 값·중복은 400이다.

`WS /ws?v=2`와 v1 `/ws`는 **Bearer 헤더만** 받는다. `?t=`만으로 인증하면 401이며 유효한 Bearer가 있어도 v2의 `t` query는 400이다. WS 쿠키는 없다. hello는 `{type:"hello",protocol:2,epoch,seq,heartbeatMs:15000,staleAfterMs:45000}`, ping은 `{type:"ping",epoch,seq}`, domain event는 기존 payload에 epoch/seq를 더한다. 모든 이벤트의 순번을 먼저 확인하고 gap·heartbeat 앞섬·epoch 교체·재접속·전경 복귀에는 sync한다. 영속 replay/since API는 없다. snapshot 이전 순번과 오래된 연결/요청 세대는 폐기한다.

정상 연결에서는 이벤트를 250ms로 묶어 snapshot을 최대 초당 2회/동시 1개 읽고 진행 중 dirty를 보존한다. WS만 실패하면 REST 3초 fallback, REST도 실패하면 3→6→12→24→30초+jitter, WS는 0.5→30초 backoff다. 저전력은 500ms/초당 1회·fallback 10초다. 확인된 401만 인증을 종료하며 403/TLS 오류는 설정 확인을 안내한다. v1 WS의 URL 인증은 호환 부채로 남기고 로그에서 query를 제거한다.

푸시는 실행기 입력용 outbox와 별도인 영속 APNs outbox다. 명시적 opt-in과 OS alert/sound 허용·등록·enabled 저장 뒤 켜진다. 새 기기는 enabled=false이고 종류 기본값 **6종 모두 true**다. 기존 기기에 `todo_created`·`report_blocked` 키가 없으면 false로 해석하고, 저장된 설정과 전체 enabled를 유지한다. 옛 클라이언트의 4종 부분 PATCH·토큰 재등록도 새 종류의 설정을 지우지 않는다. 공용 종류·설정·payload·target 계약은 `shared/push.ts` 한 곳에서 정의한다.

| PushKind | 사건 | 고정 알림 본문 |
|---|---|---|
| `decision` | 새/재열린 ask; 선택지 없는 자유 답변 질문도 한 사건 | 새 결재가 도착했습니다. |
| `approval_wait` | `blocked`이면서 `permission`·`selection` 또는 core 관측의 `setup + folder_trust` 대기 진입; 같은 episode의 반복·selection→permission은 중복 억제 | 진행을 위해 직접 확인이 필요합니다. |
| `error` | 새 오류 episode; 같은 오류 반복은 억제 | 실행 문제를 확인해 주세요. |
| `report_complete` | 명시적 완료 post의 첫 보고 즉시·추가분 마감 요약 | 완료 보고가 도착했습니다. / 추가 완료 보고가 도착했습니다. |
| `todo_created` | 새 대표 할 일을 committed scan에서 최초 관측 | 대표 할 일이 생겼습니다. |
| `report_blocked` | 팀장의 명시적 막힘 post; 원본 message ID별 한 사건 | 막힘 보고를 확인해 주세요. |

완료 보고는 `(projectId,memberId)`별 첫 보고를 저장할 때 `report-leading:<groupId>` 사건/기기 delivery를 원본과 함께 즉시 저장하고 commit 뒤 worker가 발신한다. 이후 보고만 첫 시각부터 **고정 120초** 창에 추가하며 마감을 연장하지 않는다. 추가분이 있으면 마감에 `report-group:<groupId>` 요약 사건/기기 delivery를 한 번 만들고, 없으면 추가 알림 없이 닫는다. 즉시 알림 target은 첫 보고, 요약 target은 마지막 보고이며 둘 다 전체 원본 ID 순서의 reportGroup 참조를 제공한다. group ID·마감·마지막 message ID·보고 ID 목록·처음의 수신 가능 기기와 registration generation·취소 표식을 DB에 보존한다. 타 팀장/프로젝트는 분리하며 재시작도 같은 마감과 수신자다. opt-out으로 취소한 과거 그룹은 다시 켜도 복원하지 않고 새 기기에 소급하지 않는다. 이전 버전에서 열린 leading 사건 없는 그룹은 기존 마감 발신만 유지하며 첫 보고를 소급 발신하지 않는다.

`todo_created`는 `{screen:"home",projectId}`로, `report_blocked`는 `{screen:"chat",projectId,memberId,messageId}`로 이동한다. 프로젝트 없는 `{screen:"home"}`은 기존 테스트 알림 target으로 유지한다. 할 일은 기존 store/Bus wake와 worker 주기 tick에서 관측 ID·사건·outbox를 원자 저장한다. 최초 이주 전의 기존 할 일은 알리지 않고, scan 전에 완료·삭제·보관된 할 일도 알리지 않는다. 발신 전 완료·삭제·보관은 미발신 알림을 취소한다. 단순 진행·대표 메시지·팀장 없는 보고는 보고 알림에서 제외한다. 서로 다른 원본 사건을 같은 업무로 추정해 합치지 않는다.

| 사용자 Bearer 경로 | 요청/응답 |
|---|---|
| `GET /api/push/status` | `{serverId,supported,providers:[{environment,bundleId,state,lastError}]}`; ready는 키 파싱/설정 상태 |
| `GET /api/push/devices`, `GET /api/push/devices/:id` | `{devices:PushDevice[]}` / PushDevice; deviceToken은 반환하지 않음 |
| `PUT /api/push/devices/:id` | `{expectedRevision:null|정수,platform:"ios",bundleId:"com.yehsung.iamceo",environment:"sandbox"|"production",deviceToken:<hex>,authorization,label?}`; 신규 201/기존 200 PushDevice |
| `PATCH /api/push/devices/:id` | `{expectedRevision,enabled?,preferences?,label?,authorization?}` → PushDevice; partial preferences, 충돌 409 |
| `DELETE /api/push/devices/:id` | `If-Match: "<양의 revision>"` → `{ok:true}`; 해지/없는 ID는 멱등 |
| `POST /api/push/devices/:id/test` | `{requestId:"UUID"}` → 202 `{notificationId,state:"queued"}`; 같은 ID 멱등, 새 요청은 기기당 분당 1회 |
| `GET /api/push/events/:eventId/target` | `{serverId,eventId,target,reportGroup?}`; 없는/만료/보관 대상 404 |

푸시 라우트는 strict JSON 8KiB, query 불허, 토큰 hex 2…1024자(짝수)이며 32바이트로 고정하지 않는다. 등록 lease는 30일, 해지 tombstone은 90일이다. revision·token generation으로 늦은 410이 새 토큰을 무효화하지 않게 한다. 끄기/해지는 미발신을 취소하며 이미 Apple로 나간 알림은 회수할 수 없다.

HTTP/2 TLS·ES256 JWT(20분 최소 갱신 간격/50분 갱신/60분 만료)를 사용하며 HTTP/1 fallback이나 환경 자동 전환은 없다. APNs 200은 Apple 접수다. 배너·읽음·exactly-once를 보장하지 않고, write 뒤 timeout/수락 불명은 unknown으로 두어 자동 재발신하지 않는다. payload는 고정 문구·불투명 ID만 포함하며 본문·프로젝트명·경로·접속 코드·키·토큰을 싣지 않는다. foreground 수신은 갱신만 하고 배너/소리/강제 탐색은 없다. 탭은 최신 target·호스트 serverId·소속을 확인한 뒤 이동하며 자동 답·승인·claim/input을 하지 않는다. 호스트가 꺼지면 스스로 푸시를 보낼 수 없으며 외부에서 호스트 장애를 감시하는 기능은 제공하지 않는다.

### 3.7 core 문맥과 압축

Claude statusline·공통 measureContext와 Codex rollout parser를 재사용한다. 세션/세대/model/turn·출처·신선도·exact/estimated를 구분하고 null과 유효 0%를 구별한다. Codex는 현재 `last_token_usage`와 실측 창을 쓰며 cached input/누적 usage를 재합산하지 않는다. 예: 190k/1M=19%. native ID는 실제 user 입력의 고유 binding 표식이 유일한 주 세션과 일치할 때만 연결한다. cwd/최신 파일만으로 고르지 않는다.

자동 압축은 **fresh exact + 기준 이상 + 실제 wake 큐 + 다음 업무 전**에만 한 번 판단한다. lease·초안·승인·working·미확인 입력을 우회하지 않고 압축을 위해 CLI를 새로 띄우지 않는다. manual POST compact는 기존 200 Member를 유지하며 식별 가능한 세션에서 예약할 수 있다. `contextState.compaction.phase`의 queued/sending/running/succeeded/failed/uncertain으로 접수와 완료를 구별한다.

Claude는 `/compact <focus>`, Codex는 인자 없는 `/compact`이며 nonce·delivery marker·병렬 prefix를 붙이지 않는다. sending/baseline을 DB에 먼저 저장하고 idle 조건에서 한 번 보낸다. generation 1에서 done 조건을 안전하게 지정할 수 없으면 압축 전송을 보류한다. ACK만으로 성공이 아니며 baseline 뒤 Claude compact_boundary/Codex compacted 기록과 같은 소유 CLI의 settled 복귀·오류 부재가 있어야 완료다. CLI 자체 압축도 중복 방지에 반영한다. timeout/재시작 중 sending/running은 uncertain으로 관측을 재개하고 재송신·후속 자동 입력을 막는다. claim/release만으로 해소하지 않는다. 단, 미확정 압축은 그 명령을 받은 터미널에 묶인다: 그 터미널이 명부에서 사라졌거나 다른 터미널로 바뀌었으면(Mac·엔진 재시작, 종료 뒤 다시 열림) 그 압축을 `failed/interrupted`로 닫고 대기열을 이어 간다. 띄우기·끝내기 결과를 모르는 동안은 닫지 않되, 그 터미널의 사라짐이 확정됐으면 닫는다. 실행기는 명령을 넣기 전에 기준선(받을 터미널)부터 저장하므로, 기준선 저장 전에 전달 단계 제한이나 끊긴 응답으로 끝난 시도는 넣지 않은 것이다: uncertain이 아니라 `queued/backend_down`으로 되돌려 다시 시도하고(단계 제한이 걸린 시도는 실행기도 더 진행하지 않는다), 입력칸 대기와 같은 상한(60초)을 넘기면 `failed`로 닫고 기다리던 전달을 먼저 보낸다. 예전 서버가 남긴 기준선 없는 미확정 압축은 터미널과 무관하게 닫는다. 실행기가 터미널에 붙을 때 저장된 압축·전달 상태를 읽지 못해도 그 터미널은 추적에 넣고 입력만 보류한다(읽히면 보류를 푼다). 압축 기록과 완료 판정은 사용하는 실제 CLI 버전에서도 별도 인수 시험으로 확인한다.

### 3.8 서버 로컬 파일 보기와 자료 등록

대표가 IAMCEO에서 읽거나 복사하거나 확인할 산출물은 `file`로 자료에 올리고 `post.file_ids`로 연결한다. 로컬 경로만 보고하지 않는다. 변경된 결과는 도구가 허용하는 갱신 또는 새 판으로 게시하고 최신 자료 id를 연결한다. 이 규칙은 `server/roles/{conductor,worker,root}.md`에서 시스템 프롬프트로 렌더링된다. 아래 API는 과거 보고의 로컬 경로도 앱 안에서 열고 자료로 옮길 수 있게 한다.

- `GET /api/projects/:id/local-file?path=<경로>`: 대표 Bearer 인증의 읽기 전용 API. 절대 경로는 그대로, `~/`는 서버 사용자 홈, 상대 경로는 프로젝트 cwd → 같은 프로젝트 팀장들의 cwd 순으로 찾는다. 처음 찾은 파일을 쓴다. 보관된 프로젝트도 읽을 수 있다.
- 입력의 정규화된 경로와 `realpath`로 심볼릭 링크를 푼 실제 경로가 모두 서버 사용자 홈 안에 있어야 한다. 홈 밖은 403, 디렉터리·특수 파일·읽기 권한 없음은 403, 찾지 못한 파일은 404(`code: LOCAL_FILE_NOT_FOUND`), 잘못된 경로는 400이다. 오류는 기존 `{error, code?}` JSON과 한국어 이유를 반환한다.
- 팀장 도구와 공유하는 기본 민감 폴더는 홈 바로 아래의 `.ssh`, `.aws`, `.gnupg`, `.claude`, `.config`, `.kube`, `.docker`, `.codex`, `.gemini`, `.iamceo`, `.appstoreconnect`, `Library`다. 이 홈 직속 위치와 하위를 금지한다(대소문자 무시). 경로 중간의 같은 폴더 이름은 금지하지 않으므로 `<프로젝트>/.claude/<작업이름>/…`, `<프로젝트>/.claude/worktrees/…`, 프로젝트 안 `Library`·`.config`·`.docker`·`.aws`의 일반 산출물은 허용한다. 홈 아래 각 기본 민감 폴더와 기본 비밀 파일(`.netrc`, `.npmrc`, `.pgpass`, `.git-credentials`, `.claude.json`, 셸 기록 파일들)은 lexical 경로와 존재할 때의 realpath를 모두 보호한다. 따라서 `~/.docker -> ~/docker-state`나 `~/.netrc -> ~/secrets/netrc-real`처럼 기본 위치 자체가 링크여도 실제 위치를 직접 지정하거나 무해한 별칭으로 지정하면 거절한다. 실제 설정의 `config.home`·`IAMCEO_HOME`·`claudeHome`/`CLAUDE_CONFIG_DIR`·`codexHome`/`CODEX_HOME` 전체도 lexical·canonical 금지 루트다.
- 팀장 도구는 본사처럼 작업 범위가 홈 전체이면 홈 직속 점 파일·점 폴더도 `homeDot` 규칙으로 금지한다. 이때도 `~/check/.claude/mocks/a.png`처럼 홈 아래 다른 프로젝트의 일반 산출물은 허용한다. 비밀 basename이나 별도 보호 루트에 해당하면 계속 거절한다.
- 비밀 파일 이름 규칙은 마지막 요소(basename)에만 적용한다: `.env`·`.env.*`, `.netrc`, `.npmrc`, `.pgpass`, `.git-credentials`, `.claude.json`, `.[a-z]*_history`, `.history`, `.node_repl_history`, `fish_history`, `id_(rsa|dsa|ecdsa|ed25519)`와 그 `.pub`, `id_ecdsa_sk`·`id_ed25519_sk`와 그 `.pub`, `iamceo.db*`, `credentials`·`.credentials`·`credentials.json`·`.credentials.json`, `*.pem`·`*.p8`·`*.key`·`*.p12`·`*.pfx`·`*.keychain`·`*.keychain-db`는 403이다(대소문자 무시). 민감 이름으로 무해한 파일을 가리키는 링크도 거절한다. 일반 이름인 `history`, `id_generator`, `credentials-ui`는 상위 폴더나 프로젝트 폴더 이름으로 허용하며, `credentials`가 포함됐다는 이유만으로 이름을 막지 않는다.
- IAMCEO 상태 폴더·Claude/Codex 홈이 작업 폴더를 포함하면 그 작업 폴더의 파일은 열람·게시가 막힌다. 상태 폴더는 작업 폴더 밖에 둔다.
- md·txt·csv·tsv·json·yaml·html·코드 등 UTF-8 텍스트는 2MiB까지 `{kind:"text", name, path, size, modifiedAt, mime, content}` JSON을 반환한다. 알려진 텍스트의 상한 초과는 413. 알려진 바이너리 형식을 제외한 작은 파일도 UTF-8로 확인하며, 잘못된 UTF-8·NUL이 있으면 본문 없이 메타데이터를 반환한다.
- png·jpg/jpeg·gif·webp·heic 이미지는 20MiB까지 해당 이미지 MIME의 바이트 응답이다(초과 413). `X-Local-File-Metadata` 헤더에 `{kind:"image", name, path, size, modifiedAt, mime}` JSON의 UTF-8 base64가 들어 있다. 그 밖의 동영상·바이너리·큰 미지 형식은 `{kind:"other", name, path, size, modifiedAt, mime}` 메타데이터만 반환한다. `size`는 바이트, `modifiedAt`은 ISO 8601, `path`는 실제 절대 경로다. 응답은 `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`이며 HTML을 실행 가능한 서버 문서로 제공하지 않는다.
- `POST /api/projects/:id/files/from-path` `{path, title?}` → `FileDoc`: 같은 경로 해석·민감정보·미리 보기 상한 검사를 거친다. 대표 쓰기 인증이 필요하고 보관 프로젝트는 기존 쓰기 경계에 따라 404로 거절한다. 텍스트는 자료 본문(HTML은 기존 아티팩트 원본, csv·tsv는 table 본문), 이미지·기타는 기존 `FilePublication`과 첨부 저장/DB transaction을 이용한다(첨부 상한 50MiB). 같은 실제 경로의 최신 스냅샷과 내용이 같으면 기존 자료와 `reused:true`를 돌려준다. 내용이 달라지면 기존 자료를 보존하고 새 ID의 판과 `reused:false`를 돌려준다. 텍스트·HTML은 원문, 바이너리는 안전한 FilePublication으로 복사한 바이트의 SHA-256을 비교한다. 동시 요청은 경로별로 합친다.

Mac·iPhone의 공통 MarkdownText(인라인 code·일반 글·표 포함)는 경로를 기존 강조색 밑줄 링크로 만든다. 절대/홈/명시적 상대 경로, 알려진 확장자의 파일명, 경로 형태의 슬래시 토큰을 인식한다. URL·이메일·숫자 날짜·`and/or`, `입력/출력` 같은 문장 슬래시는 제외한다. 공백 있는 경로는 인라인 code에 넣는다. 파일명/경로를 제목/부제로 쓰는 CESheet에서 md는 MarkdownText, 기타 텍스트는 선택 가능한 고정폭 글꼴, 이미지는 이미지, 나머지는 크기·수정 시각과 “미리 볼 수 없는 형식입니다”를 보인다. 자료 등록 뒤 해당 자료로 이동하고 텍스트는 “내용 복사”를 제공한다. 거절 이유는 서버 문구를 표시한다. 옛 서버가 엔드포인트 404를 반환하면 “이 서버는 파일 보기를 지원하지 않습니다”를 보인다. `LOCAL_FILE_NOT_FOUND`의 404는 실제 파일 없음 문구를 유지한다.

## 4. 전달 글 형식 (서버만 만든다)
입력 첫 줄의 접두어가 출처다. 사용자가 친 글은 항상 이 접두어 뒤 따옴표 안에 들어가므로 위장할 수 없다. 서버가 글을 넣기 전에 제어문자·제로폭·양방향 문자를 지우고(CR·U+2028 은 줄바꿈으로), 정규화(NFKC)한 줄 머리가 목록·강조·다른 괄호를 씌워도 접두어처럼 보이면 `> `를 붙인다. 팀장·총괄이 쓴 여러 줄 본문은 목록으로 막는 대신 줄마다 `> `를 붙인다(팀장 보고 본문, `할 일:` 둘째 줄부터). 팀장이 쓴 제목·버튼 글·설명은 한 줄로 받고(`ask` 검증) 따옴표를 이스케이프한다. 팀장 이름·역할도 한 줄이고 `[ ] " ' \` < >`를 쓸 수 없으며, 팀장 이름은 `대표`로 시작하거나 `총괄`·`본사 AI`·`시스템`·`보고`·`서버`일 수 없고 핸들은 `lead`·`root`일 수 없다(store 검증). 첨부 이름은 저장할 때 제어문자·줄바꿈·`[ ] ' \``를 지운다. CLI에 넣기 직전(core terminal.send)에 모든 글을 한 번 더 같은 규칙으로 지운다. 압축 focus·지금 일·다음은 한 줄이다.
- 대표가 총괄·본사 AI에게: `[대표] "<글>"` + 첨부마다 `첨부: <절대경로> (<mime>, <크기>)` + `#<message id>`
- 대표가 @팀장에게 직접: `[대표 직접] "<글>"` + 첨부 + `#id`
- 결재 답: `[대표 답(원문) '<카드 제목>'] "<버튼 글>"(<desc>) 메모 "<메모>" #<decision id>`. 묶음이면 `(묶음 추천대로)`. 자유 답이면 `"<메모>"`만.
- 내 할 일 완료: `[대표] '<제목>' 했음 #<todo id>`
- 총괄 지시: `[총괄] <화면 이름>에게\n사용자 요청(원문, 서버 확인): "<인용>"\n[대표 글 전문 #<id>: "<전문>"]\n할 일: <글>` (할 일의 둘째 줄부터는 `> `). 인용이 그 프로젝트 대표 메시지·결재 메모에 낱말 경계까지 그대로(공백 정규화) 있으면 `서버 확인`, 아니면 `총괄 인용(미확인): "..."`. 인용이 글의 일부면 전문 줄이 함께 가고, 글 전체면 인용 줄 끝에 `#<id> <시각>`이 붙는다. 버튼 글과 4자 미만 인용은 맞아도 `사용자 요청(문맥 확인 필요): "<인용>"`이다: 무엇에 대한 답인지 글만으로 알 수 없으므로 버튼 글이면 `결재 #<id> '<카드 제목>'에서 고른 답 <시각>`을 함께 싣는다. 버튼의 설명은 팀장이 쓴 글이라 근거가 아니다. 승인 대조는 처리된 결재 전부를 본다(화면의 최근 50건 제한을 받지 않는다).
- 팀장 보고: `[보고 <이름>] <kind>: <제목>\n> <본문>` (총괄에게)
- 시스템: `[시스템] <글>`
- 첨부는 `~/.iamceo/inbox/<팀장 id>/`로 이어(하드 링크, 안 되면 복사) 그 경로를 글에 알린다. 긴 글(>1500자)을 같은 폴더의 파일로 빼던 것은 옛 herdr 실행기의 동작이었고 실행기와 함께 지웠다. core는 글을 그대로 넣는다.
- 큐 전달마다 영속 `#iamceo_<토큰>`, 묶음마다 `#iamceo_b_<토큰>`을 사용한다. 기존 원본 `#id`는 참조로 남기며, 긴 글 파일과 봉투 표식의 관계도 보존한다(§3.5). 표식은 인증 수단이 아니다.

## 5. Runner와 core protocol

정확한 TypeScript 정의는 `server/runner/types.ts`가 원본이다. `RunnerMember`는 멤버·프로젝트·cwd·native sessionId·paneId·모델·effort·권한 외에 `cli?:"claude"|"codex"`와 `parallel?:boolean`을 받는다. StartOpts는 생성한 시스템 프롬프트·MCP 파일, resume, 프로젝트 정보를 전달한다.

| 계약 | core 동작 |
|---|---|
| `available` | hello generation 1과 필요한 RPC method 확인, 제한 시간 내 진단 |
| `start` | live 멤버 라벨·고정 이름으로 재결합; 없으면 공식 대화형 CLI argv 실행 |
| `send` | 한 멤버 한 번, root OSC 상태·빈 composer·수동 lease 확인 후 paste+Enter |
| `screen` | `terminal.read {terminal,lines:0}`. 최종 출력·상태 추론에 쓰지 않음 |
| `interrupt` | `terminal.interrupt`, stopped/exited 확인. 키 후 강제 kill로 승격하지 않음 |
| `checkStop`·`stop` | 소유권·idle 초안 보호; 명시적 종료는 terminal.kill 완료 확인 |
| `shutdown` | 폴링·메모리 연결 정리. core·holder·CLI를 끝내지 않음 |
| `setParallel` | Claude slash 응답 확인 / Codex native subagent 선호를 다음 과제에 명시 |
| `applyConfig` | 알려진 native ID와 빈 composer가 있을 때 검증 후 stop/resume; 모르는 ID는 오류 |
| `compact` | fresh exact·실제 wake·입력 안전 조건 아래 자동 압축, 수동 예약·완료 증거 관찰(§3.7) |
| `terminalControl` | token lease 아래 명시적 사람 input·whitelist key 전달 |

Unix socket plain NDJSON JSON-RPC를 사용하고 요청마다 연결을 새로 연다. timeout·연결 종료·잘못된 응답 뒤 mutating 요청을 재생하지 않는다. transport write를 시도한 send의 실패는 uncertain이며 재전송 불가다. JSON-RPC 오류는 upstream `data.kind`·hint를 보존한다. 폴링은 단절 후 다시 읽지만 run/send를 재생하지 않는다.

`terminal.run`은 argv/cwd/env/멤버 라벨과 `no_parent:true,outlive_parent:true,no_notify:true,keep:false,rm:false,wait:false`를 쓴다. core 자체는 IAMCEO 전용 HC_SESSION·소켓·XDG 폴더를 쓰고, 제공자에게는 원래 HOME·XDG 설정을 넘긴다. Claude는 시스템 프롬프트·MCP 파일을 추가하고 Codex는 호출별 TOML override를 쓴다. MCP bearer는 Codex argv 대신 환경·env_vars로 보낸다. 사용자 CLI 도구·스킬·프로젝트 설정을 비활성화하지 않는다.

자동 입력은 항상 `force:false`다. idle은 `if:idle`을 사용한다. upstream generation 1의 if 열거형은 idle/working뿐이라 done은 해당 조건 없이 보낸다. 읽은 상태·초안과 외부 raw attach 사이의 경쟁을 원자적으로 제거할 수는 없으며, 앱의 직접 조작 lease는 알려진 앱 입력과 자동 전달을 분리한다. Codex plain screen의 고정 placeholder와 같은 문장을 직접 친 경우도 구별할 수 없다.

상태는 OSC 7501 root record와 turn counter만 읽는다. 미보고/알 수 없음은 입력을 막는 상태다. 다만 갓 띄운 CLI(turn 0)가 아직 아무것도 알리지 않았고 알아본 창(폴더 신뢰·사용 한도)도 없으면, 띄운 뒤 20초(`startQuietMs`, 운영 조립에서만 켠다) 동안은 막힘으로 알리지 않는다(뜨는 중이다. 입력은 그동안에도 넣지 않는다). 그 뒤에도 조용하면 예전처럼 막힘이고 60초를 넘기면 `start_not_ready`다. 예외는 하나다(2026-11-11 대표 승인): 턴을 한 번 이상 돈(turn > 0) 살아 있는 CLI의 root 상태 기록이 비어 있고 화면에 평소 입력칸이 식별되면 끝난 턴(done과 같음)으로 읽는다. 끝을 보지 못한 턴은 그 상태가 0.75초 이상 이어질 때만 끝낸다. 한 번도 보고하지 않은 CLI, 입력칸이 안 보이는 화면, reported:false, 모르는 상태 단어는 계속 막는다. 이 예외가 없으면 API 오류로 끝난 턴 뒤에 상태 기록이 비어 전달이 재시작 전까지 막힌다. working→blocked counter 증가만으로 턴을 완료하지 않는다. 완료된 root idle/done/error 전환은 빈 finalText의 turn_end를 낸다. 업무 완료·최종 답변은 MCP post/file 등으로 기록하며 화면을 복원한 가짜 보고를 만들지 않는다.

새 Codex native ID는 모르면 null이다. 살아 있는 core pane은 재결합하되 pane을 잃었고 native ID도 모르면 자동 새 대화 실행을 거부한다. 멤버 소유권 라벨이 다른 터미널에는 입력·종료하지 않는다. 이전 track의 늦은 폴링은 새 세션 상태를 덮어쓰지 않는다.

수동 조작은 5분 token lease다. claim과 동일 token 갱신, input·key, release를 제공한다. input만 명시적 사람 요청 아래 `force:true`를 쓸 수 있다. 앱·서버의 일반 자동 전달이나 MCP 에이전트 도구에서 승인 bypass로 쓰지 않는다. lease 종료·만료 시 자동 펌프가 다시 진행할 수 있고 멤버 종료·제공자 교체 시 token은 무효다.

과거 headless의 `claude -p`, herdr의 `agent.prompt`·화면 지우기·transcript 복원·background 화면 탐지는 실행기와 함께 지웠다. 코드에도 시험에도 남아 있지 않다.

## 6. Orchestrator 규칙

- 메시지·결재 답·총괄 지시·팀장 보고·시스템 알림은 `deliveries`를 거쳐 `enqueue → pump(member) → Runner.send`로 간다. wake=false는 다음 깨움에 함께 보내고 작업 중이면 줄을 선다. 보관·실행 꺼짐·연결 끊김·blocked·수동 lease는 보류 사유다.
- `send` 성공은 PTY paste+Enter 수락을 뜻한다. 모델이 작업을 끝냈거나 결과가 저장됐다는 뜻이 아니다. started:false도 이미 전달된 입력일 수 있어 자동으로 다시 보내지 않는다. 불확실한 전달은 `delivery_unknown`으로 계속 보류한다.
- core turn_end는 대기열 진행 신호다. 열린 업무 결재가 남으면 waiting, 아니면 idle로 정리한다. working/idle만으로 업무 완료를 보고하지 않는다. core의 압축은 §3.7의 증거 계약을 따른다. transcript 기반 최종 답변 복원은 하지 않는다.
- 대표 지시·결재 답으로 일을 맡기면 총괄은 `post`(진행)로 확인·대상·맡긴 일을 한두 줄로 알린다(예고 없음). 직접 지시받은 팀장도 바로 확인한다. 총괄·본사 AI가 대표 지시 턴에 배정(team_assign/team_add/team_resume·결재 follow_up)하면 그 턴의 실제 post 제목·본문에 이름이 없는 배정 대상만 시스템 안내 한 줄로 보완한다. 팀장별 대기열 여부를 표시하고 `(배정자,대표 원문 ID,대상 팀장)`별 영속 확인 기록으로 재시작과 묶음 `[A,B]→[A]` 재전달 중복을 막는다.
- 대표 메시지는 지정 팀장 또는 총괄·본사 AI에 전달한다. 총괄 시작은 중복 요청을 합치고 시작 실패도 메시지를 잃지 않게 보류한다. `@팀장` 직접 지시는 총괄에게 사실만 알린다. 보관 프로젝트에는 세션 시작·깨움·입력을 거부한다.
- 결재 답은 물은 팀장에게 wake=true, 총괄에게 wake=false다. `expectedVersion`이 다르면 409다. 같은 답 재전송은 멱등이고 다른 답으로 덮어쓰기는 거부한다. 연결 실패를 답변 성공으로 꾸미지 않는다.
- post의 완료·막힘·질문은 총괄을 깨우고 진행·알림은 다음 깨움에 간다. `ask_close`·`todo_close`의 소유권·사용자 원문 대조는 §7과 같다. 할 일 체크를 되돌리면 나가지 않은 알림은 거두고 이미 전달된 완료는 정정한다.
- team_add는 유일한 핸들·이름과 역할·규칙·선택한 CLI로 독립 core 세션을 만든다. team_assign은 대기열과 병렬 선호를 다룬다. Claude는 Ultracode 명령 응답을 확인하고 Codex는 native subagent 기능과 다음 과제의 선호 지시를 쓴다. 실제 병렬 실행 수를 보장하지 않는다.
- 잠재우기·종료는 명시적 액션이다. 일하는 턴·열린 결재·큐를 무시하는 force는 대표가 선택했을 때만 쓴다. core는 소유권이 확인된 terminal만 종료하고 idle 초안·알 수 없는 composer를 지우지 않는다. 오류 보고(OSC `error`)로 끝난 턴은 그 끝을 본 뒤라면 쉬는 CLI와 같이 끝낼 수 있다(초안 확인은 같다. 예전에는 '처리 중'으로 읽어 사용 한도로 멈춘 팀장을 재우거나 설정을 바꿀 수 없었다). 사용 한도로 보류된 팀장을 force 없이 재울 때 한도 메뉴가 떠 있으면 먼저 Esc로만 닫는다(Enter·숫자·화살표는 보내지 않는다). 닫은 뒤 끝내기가 거절되면 명부의 막힘(blocked)을 지금 관측으로 고쳐 적는다(한도 오류와 같은 error). 재워도 한도 보류는 그대로이고, 자동 이어가기는 잠든 팀장을 깨우지 않는다. 닫기·force 재우기는 오류(OSC `error`)로 끝난 CLI의 입력칸을 알아보지 못해도(오류 배너 등) 끝낸다. 쓰던 글이 보이면 지금처럼 거절한다.
- 서버 재시작은 기존 core holder를 보존하고 멤버·프로젝트·CLI 라벨로 재결합한다. 단절이나 start timeout만으로 동일 CLI를 다시 띄우지 않는다. 옛 실행기(herdr·headless)의 세션이 남은 팀장 행은 원본을 보존하고 `legacy_session`으로 보류한다. 그 세션을 이어 열거나 넘겨받는 코드는 없고, 자동 backend 전환이나 이전 프로세스 일괄 종료도 하지 않는다. `PUT /api/settings`의 `backend`는 `core`만 받는다(다른 값은 400).
- 재시작(Mac 또는 실행 엔진)으로 터미널을 잃은 팀장은 서버가 스스로 같은 세션을 이어 연다(`server/restart-wake.ts`). 대상은 서버가 띄운 core 세션(origin=runner, 세션 ID 있음)이고 프로젝트가 보관되지 않았으며 실행이 켜진 팀장 가운데, 엔진이 알린 종료 사유가 `holder_lost`·`stopped_by_restart`이거나 엔진이 그 터미널을 모른다고(`not_found`) 확정한 경우다. 잠든 팀장, 사용 한도로 보류 중인 팀장(다시 열어도 전달은 한도로 붙잡히고 연 CLI의 상태가 한도 표시를 지웠다. 한도가 풀리거나 모델을 바꾸면 그 길이 연다. 터미널이 사라져도 막힘 사유 `usage_limit`·오류 글·관측의 `usage_limit` 오류·카드·보류는 그대로다), 직접 붙인 세션, 옛 실행기의 세션, CLI가 스스로 끝난 세션(종료 코드가 있는 `exited` 등), 띄우기·끝내기 결과를 모르는 팀장, 시작하자마자 끝나기를 되풀이한 팀장은 대상이 아니다. "재시작으로 꺼졌고 아직 다시 열지 않았다"는 표식은 settings 표의 `restartWake` 키에 팀장 ID별로 적는다(스키마 변경 없음: `{generation,reason,lostAt,state,attempts,runIds,resumeId}`). 서버가 또 재시작해도 남고, 이 기능 전에 꺼져 `lastError`의 글(`holder_lost`·`stopped_by_restart`가 든 옛 글)만 남은 팀장은 서버가 뜰 때 표식으로 옮긴다. recover가 끝난 뒤, 엔진이 답해 그 팀장의 터미널이 없다는 것이 확인되면 총괄부터 한 번에 한 명씩(`restartWakeParallel`) '깨우기'와 같은 길(`--resume`)로 연다. 입력은 넣지 않고 전달 펌프도 거치지 않으므로 전달 보류가 남은 팀장도 열린다. 방금 연 CLI가 상태를 알리거나 `restartWakeSettleMs`(30초)가 지난 뒤에 다음으로 넘어간다. 대표의 말·지시·깨우기는 이 줄을 기다리지 않고, 함께 열어도 세션은 하나다. 여는 데 실패하면 꺼진 채 기존 오류 안내를 남기고 같은 꺼짐에는 다시 스스로 열지 않는다(여는 도중 서버가 내려가 결과를 남기지 못한 시도만 한 번 더 한다). 다시 연 팀장의 활동에는 `Mac이나 실행 엔진이 다시 시작되어 꺼졌던 세션을 이어서 열었습니다`(kind `system`)를 남긴다. 끄는 설정은 없다.
- 그 재시작으로 턴 도중에 끊긴 실행(입력을 받았거나 턴이 시작된 실행)은 원래 지시를 다시 넣지 않는다. 다시 연 뒤 그 팀장에게 `[시스템] Mac이나 실행 엔진이 다시 시작되어 하던 일이 중간에 끊겼습니다…` 이어가기 글(wake=true)을 실행마다 한 번 넣고, 기다리던 다른 전달보다 먼저 혼자 보낸다. 이 글로 시작한 턴에도 보고 의무와 보고 보완이 그대로 적용된다. 총괄에게는 '실행 중단' 대신 깨우지 않는 소식(wake=false, 다시 지시하지 말라는 안내)이 가고, 대화의 시스템 글은 `실행 <id> — 재시작으로 끊겨 이어서 하게 했습니다`다. 다시 여는 데 실패했거나 대상에서 빠지면(대표가 재우거나 닫음, 새 세션) 예전처럼 총괄을 깨워 '실행 중단'을 알린다. 어느 쪽이든 execution journal의 중단 통지 칸(`interruption_notified_at`)으로 한 번만 만든다. CLI가 스스로 끝나 끊긴 실행은 예전 그대로다. 수신이 확인되지 않은 입력(`delivery_unknown`)은 아래 판정을 먼저 거친다: 세션 기록으로 받은 것이 확인되면 끊긴 일로 다뤄 이어가기 글이 가고, 받지 못한 것이 확인되면 그 실행은 '넣지 못함'으로 닫혀 중단 알림도 이어가기 글도 만들지 않는다(지시 자체를 다시 넣는다).
- **터미널의 사라짐이 확정되면 그 터미널에 묶인 미확정 상태를 한곳에서 정리한다**(`Orchestrator.releaseGoneTerminal`). 확정의 기준은 엔진의 답이다: 터미널이 끝났다고 알렸거나(`state≠live`), 그 터미널을 모른다고 불확실하지 않게 답했다(`not_found`). 엔진이 답하지 않는 것은 확정이 아니며 그동안은 아래 상태가 모두 그대로 남는다. 부르는 자리는 둘이다: 재결합 조회에서 부재를 확인했을 때와 실행기가 종료를 알렸을 때(실행을 끝내기 전에 정리한다). 예전에는 상태마다 푸는 자리가 '터미널에 붙어야' 돌아서, 보류라 못 열고 못 열어 보류를 못 푸는 팀장이 남았다. 상태별 결과:
  - 받았는지 모르는 전달(봉투 `prepared`·`write_started`·`unknown`, 또는 확인 중인 항목): 터미널 없이 세션 기록만 읽는다(`inspectGoneDelivery`, 봉투의 기록 기준선 뒤). 수신 표지가 있으면 `delivered`로 확정한다. 판정 범위를 끝까지 읽었고 표지가 없으면 그 봉투를 `rejected`로 닫고 전달을 `queued`로 돌려, 다음 전달이 지금 터미널에 새 봉투로 넣는다(사라진 터미널의 입력칸에 반쯤 들어간 글은 되살아날 수 없으므로 중복이 생기지 않는다). 기록을 읽지 못했으면(`log_missing`·`log_incomplete`) `needs_owner`로 두고 '중복 위험 동의 재전송'을 연다. 이미 대표에게 묻고 있던 전달과 이 길로 세 번 다시 넣은 전달은 스스로 다시 넣지 않고 같은 동의를 기다린다. 대표가 동의하면 기록을 읽지 못했어도 지금 터미널에 다시 넣는다(예전에는 터미널이 바뀌면 동의해도 넣지 못했다). 잠든 팀장과 보관된 프로젝트는 건드리지 않는다.
  - 지금 터미널이 아닌 터미널에 묶인 미해결 봉투는 전달 확인(tick) 때마다 엔진에 그 터미널을 물어(`terminalGone`) 사라진 것만 위와 같이 판정한다. 살아 있거나 답이 없으면 기존 판정 그대로다: 터미널이 다르면 자동으로도 수동으로도 다시 넣지 않는다(`session_lost`·`identity_changed`).
  - 미확정 압축: 그 터미널이 받은 것이면 `failed/interrupted`로 닫는다.
  - 조작 결과 모름(병렬 설정 명령의 `control_unknown`·`parallel_unknown`): 지운다.
  - 조작권: 그 터미널의 조작권을 지운다. 그와 별개로 조작권은 묶인 터미널이 명부의 지금 터미널과 같을 때만 유효하다(예전에는 사라진 터미널의 조작권이 만료까지 최대 5분 전달을 막았다).
  - 끝내기 결과 모름: 세션을 다시 열려던 끝내기(`fresh_session`)는 `confirmed`로 닫고 팀장을 꺼짐으로 둔다(세션 ID 유지, 같은 대화로 다시 열린다). 재우기·닫기·보관은 기존 복구(`recoverStops`)가 마저 한다.
- 결과를 모르는 `fresh_session` 끝내기는 점검(`recoverStops`)마다 터미널을 물어 닫는다. 사라졌으면 위와 같고, 살아 있고 끝내기 요청에서 더 올 것이 없으면(`writeSettleMs`) `refused`로 닫아 세션이 그대로 일한다. 엔진이 답하지 않으면 정하지 않는다. 하려던 변경(설정·CLI·새 세션)은 어느 쪽이든 적용되지 않았으므로 활동에 그 사실을 남긴다.
- 엔진이 답했고 그 팀장의 터미널이 없으며 결과를 모르는 띄우기·끝내기도 없으면, 서버가 띄운 세션(origin=runner)은 명부의 상태가 무엇이든(새 세션 띄우기가 확정 실패해 `error`로 남은 경우 포함) `offline`으로 돌린다. 잠든 팀장은 그대로 두고, 넘겨받은 명부는 예전 조건(터미널이 적혀 있거나 이미 `offline`) 그대로다. 깨우기(`resumeMember`)는 결과를 모르는 끝내기가 남아 있으면 그 자리에서 터미널을 확인해 닫고, 터미널이 없는 팀장(서버가 띄운 core 세션)을 실제로 다시 연다. 엔진 무응답으로 그 끝내기가 남으면 성공 대신 409로 그 사실을 답한다.
- 이 소스의 backend 조립은 core다. 운영 절차는 [운영 모델](operating-model.md)을 따른다. 제공자 기본은 Claude, 프로젝트의 chiefCli와 각 Member.cli는 독립적으로 저장된다. 같은 멤버의 제공자를 바꾸어도 멤버 id·역할·업무·대화·결재·파일은 유지한다.
- 제공자·살아 있는 세션의 모델/effort 변경은 working·blocked·처리 중·불확실한 전달이 있으면 409다(턴이 끝난 뒤 다시 해야 한다. 자동으로 미뤄 적용하지 않는다). 예외는 사용 한도로 보류된 팀장의 같은 제공자 모델/effort 변경(`PATCH /api/members/:id`, 총괄의 `team_model`)이다: 한도 메뉴를 Esc로만 닫고 옛 터미널을 끝낸 뒤 그 팀장의 한도 보류만 풀어(같은 계정의 다른 팀장은 그대로) 같은 native session ID를 새 `--model`로 `--resume`한다(잠들었거나 꺼진 팀장은 설정을 저장하고 보류만 푼다). 멈출 때 하던 실행이 한도 오류로 끝났으면 `[시스템] 사용 한도로 하던 일이 중간에 멈췄습니다. 모델을 <표시 이름>(으)로 바꿔…` 이어가기 글을 재시작 이어가기와 같은 장치(`interruption_notified_at`로 실행마다 한 번, 다른 전달보다 먼저 혼자, 총괄에게는 깨우지 않는 소식)로 넣고, 새 모델도 한도에 걸리면 평소처럼 다시 보류한다. 같은 CLI로 같은 대화를 이어 열었으면 설정 변경 인계 글은 넣지 않는다(이어가기 글이 이미 알린다). 일반 설정 변경의 인계 글은 같은 CLI면 `모델 변경: <옛 표시 이름> → <새 표시 이름>`(effort면 `effort 변경: …`)으로 시작한다. 보류를 푼 뒤 새 터미널 기동만 실패하면 설정을 미뤄 두고 성공으로 답한다(펌프가 곧 새 설정으로 다시 연다). 사용 한도로 보류된 팀장의 CLI 교체도 그 보류를 풀고 카드에서 뺀다(새 CLI라 이어가기 글 대신 총괄에게 중단을 알린다). 새 CLI 인자를 먼저 검증하고, 이전 종료 확인 뒤 `member_session_history`를 남기고 MCP 토큰·session_generation을 회전한다. 이전 종료 실패면 제공자와 토큰을 유지하고, 이후 새 시작 실패면 오류로 남긴다.
- 같은 제공자의 설정 변경은 Claude와 Codex 모두 native session ID를 보존해 resume한다. 다만 세션 기록이 없는 세션(한 번도 턴을 돌지 않은 세션)은 이어 열 것이 없으므로 `--resume` 없이 새 세션으로 연다(잠든 팀장을 깨울 때와 같은 판정). native ID를 모르거나 resume이 실패하면 즉시 새 세션을 만들지 않고 설정 적용을 다음 자연 기동으로 보류한다. 보류 설정과 실패 여부는 DB에 남아 서버 재시작으로 재기동을 반복하지 않는다. 실패 시 미확정 입력·종료 검증을 우회해 옛 설정으로 무조건 전달하지 않는다. 명시적 새 세션/제공자 변경은 별도의 새 세션 경로다. 역할·현재 일·다음 일·프로젝트 상황과 board 확인 안내를 넣는다. 같은 대화 문맥·숨은 추론을 다른 제공자에게 옮기는 기능은 없다.
- 모델은 멤버별 덮어쓰기, 적용 가능한 직급 값, CLI 기본 순이다. Claude용 직급 모델·staff 설정을 Codex에 자동 상속하지 않는다. 설정은 실행 인자로 적용하고 사용자 전역 CLI 기본값을 수정하지 않는다. null 모델·effort는 기본으로 돌아간다.
- 판 정리는 기존 주기·변경 여부·연결·총괄 idle·중복 지시 조건을 따르며 정리만 하려고 새 총괄을 띄우지 않는다. 명시적 tidy는 총괄에게 지시를 넣는다. 업무 완료 보고는 MCP에 남긴다.
- 직접 `iamceo join`한 CLI는 실행기 밖이다. 서버가 그 프로세스를 띄우거나 입력하지 않고 wait/ask 롱폴로 지시·답을 받는다. 기존 터미널 세션을 넘겨받던 herdr 편입(adopt)·해제(release)는 지웠다. 이미 떠 있는 CLI를 붙이는 길은 `iamceo join`뿐이다. `iamceo import`가 만든 넘겨받은 명부(origin `adopted`)의 팀장은 세션도 터미널도 없으면 깨울 때(깨우기·지시·대표 글) 서버가 띄운 새 세션(origin `runner`)이 된다. 세션 ID가 남은 `adopted` 행은 그대로 두며 실행기는 `adopted` 터미널을 띄우거나 닫지 않는다.

## 7. 에이전트 도구 (`POST /agent/tool` `{name,args}`, Bearer 멤버 토큰. `GET /agent/tools` → 그 멤버의 도구 목록)
`/agent/*`(`/agent/join`·`/agent/tool`·`/agent/tools`·`/agent/inbox/*`·`/agent/ask/wait`)는 이 Mac 안에서 온 요청만 받는다. 실제 상대 주소가 loopback(127.0.0.0/8·::1)이거나 이 컴퓨터 자신의 주소여야 하고, 대리 전달 헤더(`Forwarded`·`X-Forwarded-For`·`X-Forwarded-Host`·`X-Forwarded-Proto`·`X-Real-IP`·`Tailscale-User-Login`)가 하나라도 있으면 거부한다. 아니면 토큰을 보기 전에 403 `{error,code:"LOCAL_ONLY"}`. tailnet 의 다른 기기와 `tailscale serve` 를 거친 요청은 이 통로를 쓸 수 없다. MCP 브리지와 `iamceo join` 은 같은 Mac 에서 127.0.0.1 로 부른다.

공통: `status{now,next?}` · `ask{title,detail,options?[{k,label,desc}],rec?,group?,file_id?,images?[]}` · `post{kind:'완료'|'진행'|'막힘'|'알림',title,body?,file_ids?,decision_id?,supersedes?,corrects_message_id?}` · `file{title,summary?,path?|content?|html?,images?[]}`(html: 자체 완결 HTML 2MB 이하 → kind=artifact, path 는 확장자로 종류를 정한다: .html 아티팩트, csv·tsv 표, json·코드·로그·txt 코드, pdf, 이미지, 영상, 오디오) · `todo{title,detail?}`(대표가 할 일)
총괄 추가: `team_add{name,role,handle?,cwd?,first_instruction?,user_quote?,parallel?}`(cwd 는 프로젝트 폴더 안, 데이터 폴더·비밀 폴더는 거부. 밖은 대표 글에 그 경로가 있고 user_quote 로 대조될 때만) · `team_assign{member,text,user_quote?,parallel?,urgent?,attachments?}`(attachments: 그 프로젝트 대표 메시지의 첨부 id, 받는 팀장 폴더로 잇는다) · `team_compact{member,focus?}` · `team_sleep{member,force?}` · `team_resume{member,first_instruction?}` · `team_close{member}` · `team_model{member,model,effort?}`(대표가 모델을 바꾸라고 했을 때만 쓴다. 있는 팀장의 모델·effort를 바꿔 같은 세션을 이어 연다. 앱의 팀장 설정 변경과 같은 길이고 대표 인용은 받지 않는다. 사용 한도로 멈춘 팀장은 대표가 정할 때까지 기다리고, 새로 띄우지 않는다. 같은 설정이면 400, 일하는 중이면 409, 한도로 보류 중인데 세션 ID를 모르면 409. 답은 서버가 실제로 한 일로 정한다: 이어가기 글을 넣었을 때만 '이어서 한다', 지금 열지 못했으면 '다음에 열 때·곧 다시 연다') · `roster{}` · `project_now{text}` · `work_set{id?,sec,title,detail?,who?}` · `work_list{}` · `work_remove{id}` · `board{}`
본사 AI 추가: `project_create{name,cwd,goal?,start_conductor?}` · `project_list{}` · `board{}`
판 정리(공통, 팀장은 자기가 올린 결재·할 일만): `ask_close{id,kind:'decided'|'obsolete',reason,user_quote?,answered_decision_id?,same_issue?,follow_up?}` (`follow_up:{kind:"none"}|{kind:"instruction",member_id,text,source_message_id?}`로 닫기와 명시 후속을 함께 저장). decided는 대표 글의 `user_quote` 또는 같은 프로젝트의 실제 answered/delivered 결재 `answered_decision_id`를 근거로 쓴다. 후자는 nonempty group 일치 또는 총괄·본사 AI의 `same_issue` 설명이 필수이며 팀장은 다른 그룹을 연결할 수 없다. 서버가 고른 버튼 글·메모 전체를 직접 인용하고 `decision_close_audit`에 닫은 결재·답한 결재·작성자·동일 안건 설명·인용·시각을 기록한다. answered_decision_id 근거의 후속 instruction은 source_message_id를 생략하며 검증된 답을 `sourceDecisionId`로 저장한다. 닫기·감사·원문 알림·후속 outbox는 원자 저장한다. 대표 글 근거는 기존 source_message_id 검증을 유지하며 버튼 글만의 인용은 계속 거부한다 · `todo_close{id,outcome:'done'|'dropped',reason}`. `board` 는 열린 결재(id·제목·물은 팀장·올린 날짜·묶음)·안 끝난 할 일(id·제목·부탁한 사람·날짜)·진행판(id·칸·제목·갱신 날짜, 완료는 최근 10)·지금 상황·지난 판 정리 시각. 도구 설명에 '대신 답하지 않는다(추측으로 닫지 않는다, 애매하면 둔다)'를 쓴다.
직접 띄운 CLI 추가: `wait{timeout_sec?,batch?:true,ack_batch_id?}` — 밀린 지시 받기. 엄격 경로는 `POST /agent/inbox/wait` `{timeoutMs?}`로 `{id,memberId,items,createdAt}`를 재조회하고 `POST /agent/inbox/ack` `{batchId}` → `{batchId,acknowledged:true}`로 소비한다. 응답만 반환했다고 delivered로 확정하지 않는다. 브리지가 호출 전에 만든 `operationId`를 `/agent/tool`의 `{name,args,operationId}`에 보내며 같은 ID의 재요청만 합친다. 같은 본문의 새 ID는 독립 호출이다. manual 답 수신은 화면의 최근 50건 제한을 사용하지 않고 askWait와 소비 상태를 공유한다. 브리지는 wait에 batch=true를 붙이고 `ack_batch_id`로 명시 ACK한다. 보고 `post{report_id}`는 새 게시 없이 원본·전체 자료·결재·작성 순서·정정 관계를 조회한다.
`member` 인자는 핸들 또는 화면 이름.
**파일 경로(`file`의 path·images, `ask`의 images)**: 심볼릭 링크를 따라간 경로가 작업 폴더(팀장·프로젝트) 안이어야 하고, `~/.ssh` 등 비밀 폴더·`.env`·개인 키·셸 기록·`~/.claude.json`·`~/.iamceo`의 설정·토큰·DB·첨부는 어디서든 거부한다. 작업 폴더가 홈이면(본사) 홈 바로 아래의 점 파일·점 폴더를 모두 거부한다. 하드 링크(nlink>1)도 거부한다. 검사한 진짜 경로로 읽는다. 같은 OS 사용자로 도는 세션의 Bash 까지 막지는 않는다.
**wait·ask 대기**: 호출한 쪽 연결이 끊기면 기다리기를 그만두고 지시를 가져가지 않는다.
**ask 동작**: 실행기 멤버(origin=runner|adopted)는 결재 카드 등록 후 즉시 반환: "질문 #id 등록됨. 턴을 끝내세요. 답은 다음 입력으로 옵니다". 멤버 상태 waiting. origin=manual 은 `/agent/ask/wait` 롱폴(50초 단위)로 브리지가 기다리며 MCP progress 를 60초마다 보내고, 답이 오면 그대로 반환.
멤버의 도구 호출마다 `updatedAt` 갱신. 다른 프로젝트의 멤버를 지정하면 거부.

## 8. 역할 템플릿 (`server/roles/`)
`{{PROJECT}} {{NAME}} {{ROLE}} {{CONDUCTOR}} {{SUBAGENT_EFFORT}}` 치환(서브에이전트 effort 규칙이 비면 그 줄을 지우고, 자리표시 없는 고친 템플릿에는 끝에 붙인다), `~/.iamceo/roles/<kind>.md`가 있으면 그것을 쓴다(기본 규칙 전체를 대체한다. 승인 규칙이 빠지면 로그에 경고). `iamceo roles export` 가 기본 템플릿을 `<kind>.example.md` 로 꺼낸다. 내용: 입력 구분(§4 접두어), 보고(post), 질문(ask, AskUserQuestion 금지), 승인(사용자 원문·서버 확인만, 총괄의 말은 승인 아님), 병렬은 총괄이 켜 둘 때만, 이름 안 바꿈, 임시 폴더 안 지움, 산출물은 file. 총괄: 일 받기·맡길 곳 판단·대기열·직접 일하지 않음·현재 core에서 사용자에게 남길 말은 post·file 등 MCP 기록·질문 대신 답하지 않음·압축은 core 안전 조건 아래 자동·수동 예약·세션 수 판단. 본사 AI: 프로젝트 만들기와 잡다한 일. 대표가 읽고 판단할 비교표·요약 표는 csv·마크다운 표가 아니라 `file` 의 `html` 이다. csv 는 내려받아 쓸 원본 데이터일 때만.

## 9. 시험

- `tests/core-runner.test.ts`: 임시 Unix socket fake core. hello·RPC 오류/timeout·재결합·소유권·초안 보호·불확실 전달·OSC turn·수동 lease·제공자 인자·설정 교체를 검증한다. 실제 유료 모델을 호출하지 않는다.
- `tests/server-runtime.test.ts`: 현재 소스의 core 기본값, 독립 제공자, 안전한 세션 교체·토큰 회전·이력·재시작 보류·DB 백업·REST 계약을 검증한다.
- `tests/cli.test.ts`, `tests/native-api-contract.test.ts`, `tests/server-runtime.test.ts`: 격리 CLI 서버·네이티브 HTTP/WS·runtime 계약. unavailable socket의 동시 진단도 서버를 죽이지 않아야 한다.
- `native/Tests/IAMCEOTests`: Swift 계약 디코딩·요청 인증·origin 제한·네트워크 오류·stable message id·expectedVersion을 URLSession mock으로 검증한다. SwiftPM 시험·macOS 빌드·iOS simulator 빌드는 별도 검증이며 실기기 설치·서명·공증은 별도로 확인한다.
- 실제 PTY 시작·daemon 재시작 검증은 임시 IAMCEO_HOME·HC_SESSION·HC_SOCKET·XDG 경로에서만 한다. 사용자 원래 daemon·터미널을 끄거나 전역 CLI를 업데이트하지 않는다. CLI 시작만 검증하는 시험에 자동 유료 prompt를 넣지 않는다.
- 옛 실행기 전용 시험(`tests/herdr.test.ts`, `herdr-contract.test.ts`, `headless.test.ts`)과 herdr fixture, 실제 모델을 부르던 `tests/e2e-real/*`는 실행기와 함께 지웠다. 총괄 시험은 운영과 같은 실행기 종류로 돈다: `tests/fixtures/core-harness.ts`가 가짜 core 소켓에 실제 `CoreRunner`·실제 총괄·실제 HTTP 서버를 붙인다. `scripts/check.sh server`는 `tests/*.test.ts`를 빠짐없이 돌린다.
- `tests/fixtures/fake-claude.ts`는 격리 실행 틀(`isolated-runtime.ts`)의 CLI 자리에만 남아 있다. core UX·수명·상태 계약의 근거가 아니다.
- 실제 CLI와 실제 herdr-core를 붙여 보는 자동 시험은 없다. 유료 모델 호출이 필요한 확인은 명시적으로 승인된 경우에만 손으로 한다.

## 10. 클라이언트와 검증 경계

네이티브는 홈·결재함·팀·대화·자료·설정, 보관함·프로젝트 관리·푸시 설정을 제공한다. macOS 14+/iOS 17+, Swift 6을 대상으로 한다. `--demo`만 명시적 읽기 전용 예시이며 접속 실패를 예시나 로컬 성공으로 숨기지 않는다. 웹 화면은 제공하지 않으며 배포된 네이티브 앱의 API 하위 호환을 유지한다.

- AppStore의 단일 coordinator가 REST snapshot/history/delivery/활동 갱신을 합친다. 정상 WS에서는 3초 상태·history 폴링이 없다. 비활성/잠금·Mac sleep에서는 소켓·fallback·재시도·읽기를 멈추고 복귀 시 새 연결 세대로 sync한다. 열린 터미널의 active-only 2초 screen 조회는 별도다.
- endpoint별 Keychain·Bearer, 외부 첨부 origin/redirect 차단을 유지한다. 원격은 HTTPS/WSS를 권장하며 기존 tailnet HTTP 호환 허용과 iOS ATS의 실제 전송 가능성은 별개다. iPhone loopback은 Mac 주소가 아니다.
- 최초 메시지 attempt는 호스트 namespace·불변 ID·대상·본문·첨부·초안 revision과 함께 영속화한다. 응답 유실·재시작 뒤 `GET /api/messages/:id`로 접수를 확인한다. 늦은 업로드/POST가 다른 호스트·새 초안을 덮거나 되살리지 않는다. 업로드 완료 attachment ID도 복원한다.
- 설정은 편집 base와 dirty 필드를 보존하고 CAS 충돌에서 재검토한다. 묶음 결재는 자기 요청이 수락된 카드의 메모만 소비한다. todo는 불명 결과를 조회하며 최신 revision을 보호한다. terminal `unknown`은 재생하지 않고 제출 뒤 추가 편집도 보존한다.
- terminal은 plain screen·lease 아래 직접 input/key다. 전체 VT 스트림 렌더러는 아니다. 확인된 승인, setup/status_unknown, 마지막 관측·오류, 마지막 보고 시각, 미수집 subagent를 구분한다. 미수집을 0명으로 단정하지 않는다.
- macOS 로컬 시작은 명시적 선택에만 실행하며 다른 서비스·포트·인증 오류를 덮어쓰지 않는다. 빌드는 서비스 등록·실행이 아니다. macOS는 로컬 서비스용 App Sandbox 비활성, iOS는 플랫폼 sandbox다.
- 네이티브 아티팩트(§3.2)의 서버 계약은 인라인 JavaScript를 허용하는 비영속 WKWebView다. 서버 render 응답의 sandbox CSP를 유지하고 외부 요청·쿠키·서버 API·직접 탐색을 차단한다. 링크는 앱이 목적지를 확인한 뒤 연다. Liquid Glass는 지원 OS에서 쓰고 이전 OS는 material fallback이다.

격리 자동 시험의 통과, 실제 CLI 의미 검증, Mac/iPhone 화면·스크롤 위치·접근성, APNs 실기기 sandbox/production, Tailscale·잠금·24시간 병렬 인수는 각각 다른 증거다. 격리 시험 명령과 운영 절차는 [운영 모델](operating-model.md), 서명·앱 빌드는 [native README](../native/README.md)를 본다.

## 11. 백업·복원과 접속 코드

- `iamceo backup --directory <경로>`는 지정한 `IAMCEO_HOME`의 DB·참조 첨부·설정을 검증해 백업한다. 홈 잠금이 필요하므로 수동 백업과 해당 홈의 데몬 실행은 동시에 할 수 없다. 실행 중 데몬은 자체 정기 백업을 쓴다.
- `iamceo restore <snapshot> --destination <별도 빈 홈> [--clone]`은 원본을 덮지 않고 새 홈에 복원한다. 결과는 `reconciliationRequired:true,outboundEnabled:false`이며 서버 기동을 실행기·HTTP·APNs 준비 전에 차단한다. 미종결 작업과 직접 조작권·전달 증거는 보존하고 프로젝트 실행·기기 알림은 끈다.
- 서버가 꺼진 복원 홈을 `IAMCEO_HOME`으로 지정해 `iamceo restore reconcile`을 실행하면 기존 전달·푸시를 격리한 채 조정 완료를 기록한다. 실제 외부 효과를 확인한 뒤 `iamceo restore resume`으로 발신을 허용한다. 이 명령은 서버를 시작하거나 기존 보류 전달·푸시를 일괄 재전송하지 않는다. 복원 전 실행이 켜져 있던 활성 프로젝트를 다시 허용하므로 실제 기동은 별도 운영 전환 절차를 따른다.
- `POST /api/auth/rotate`는 사용자 Bearer와 실제 loopback 연결을 요구하며 빈 본문 또는 `{}`만 받는다(다른 주소는 403 `rotate_local_only`). 저장 성공 뒤 `{accessCode,version}`을 반환하고 이전 공용 코드의 인증·첨부 인증·그 코드로 연 WS와 터미널 스트림·사용하지 않은 연결 QR을 무효화한다. 기기 열쇠(아래 '기기 열쇠')로 붙은 기기와 그 연결은 그대로다. 교체는 접속 기록에 `code_rotated`(주소·시각)로 남는다. 저장 전 실패는 `AUTH_ROTATION_SAVE_FAILED`, 파일 교체 뒤 디스크 동기화 확인 실패는 `AUTH_ROTATION_OUTCOME_UNKNOWN`이다. 응답 유실 때 반복 교체하지 않고 같은 Mac·같은 홈에서 `iamceo open`으로 확인한다.
- 복원(same-host)은 공용 접속 코드와 기기 열쇠를 그대로 둔다. 복제(`--clone`)는 원본 기기의 열쇠를 모두 끊고(`revoked_reason='clone'`, 그 열쇠로 오면 401 `device_revoked`) 복제본의 `config.json`에 새 공용 접속 코드를 만든다. 원본 Mac에 붙어 있던 기기는 복제본에 붙지 않는다. 백업 DB에는 열쇠의 SHA-256만 들어간다(공용 코드는 지금처럼 `config.json`에 평문).
- `GET /api/health`는 생존 확인이다. 인증된 `GET /api/readiness`는 `{ok,version,daemon,schema,core,hosts}`를 반환하며 데몬 준비와 지원 DB 버전이 맞으면 200, 아니면 503이다. core 연결·제공자 로그인·실제 업무 가능 여부까지 `ok`로 보장하지는 않는다.

명령 예시와 복원 후 확인 절차는 [운영 모델](operating-model.md#백업복원)을 따른다.

모델 캐시에서 유효한 Codex 표시 모델이 0개면 `source:"default"` 기본 모델 목록으로 대체한다. 터미널 control attach 종료를 기다린 뒤 크기 복원을 확인하되 `terminal_gone` 또는 확정된 finished/not_found면 복원 대상을 정리하고 pump·재열기를 진행한다. 복원 확인은 최대 2초이며 초과하면 경고 활동을 남기고 전달을 계속한다. control attach가 없으면 크기 복원을 기다리지 않는다.

### iPhone 페어링

- 인증된 `POST /api/pair/start`는 `{code,expiresAt,ttlSeconds,urls,version}`을 반환한다. QR은 접속 코드 대신 5분 유효한 일회용 코드와 Tailscale 주소만 담는다. 미사용 코드는 최대 5개, 전체 상태 기록은 최대 128개이며 오래된 기록부터 폐기한다.
- `POST /pair/claim`의 `{code,device?}`는 인증 없이 한 번만 교환한다. 성공 응답은 기존 `{accessCode,version}`에 `confirmationToken`을 추가한다. `accessCode` 칸에는 공용 접속 코드가 아니라 **그 기기만의 열쇠**(`dk1.<기기 ID>.<비밀>`)를 담는다. 출시된 앱(0.2.2·0.2.3)은 이 값을 접속 코드로 알고 그대로 Bearer에 실으므로 고치지 않고 따라온다. 열쇠를 저장하지 못하면(표 없음·디스크 가득) 예전처럼 공용 접속 코드를 준다. 교환만으로 연결 완료로 간주하지 않는다. 응답 유실 시 교환을 반복하지 않고 새 QR을 만든다(받지 못한 열쇠는 한 번도 쓰이지 않은 채 하루가 지나면 `unused`로 끊긴다). 실패는 401 `pair_expired`, 시도 초과는 429 `pair_limited`, 본문 없음은 400 `pair_code_missing`이다.
- 인증된 `GET /api/pair/status?code=<일회용 코드>`는 `{code,status}`를 반환한다. 정규화된 code와 `pending`(미교환), `claimed`(교환됨), `connected`(아래 ACK 성공), `expired`(만료·폐기·알 수 없는 코드)를 구분한다. 코드 소진·만료 자체는 연결 완료의 증거가 아니다.
- iPhone의 모든 QR 진입은 `AppStore.pair`를 사용한다. 교환 응답의 접속 코드로 실제 인증 연결에 성공한 뒤 해당 API client로 `POST /api/pair/ack`에 `{code,confirmationToken}`을 보낸다. 인증과 해당 교환 응답의 토큰이 모두 맞는 claimed 코드만 connected로 바꾼다. 같은 ACK는 멱등이며 미교환·만료·잘못된 토큰은 409다. 공유 접속 코드만으로 특정 QR의 연결을 추정하지 않는다.
- 상태와 ACK도 Bearer 인증·`Cache-Control: no-store`를 따른다. 인증 회전·서버 재시작·원래 5분 만료는 교환 및 완료 기록을 모두 무효화한다. 이전 서버가 토큰을 생략하면 iPhone 연결은 유지하며 ACK를 생략한다. ACK 유실은 이미 성공한 연결을 실패로 바꾸거나 QR을 자동 재교환하지 않는다.

### 기기 열쇠와 접속 기록(C3)

- 사용자 자격은 두 가지다. `config.json`의 **공용 접속 코드**(이 Mac의 앱, 손으로 넣은 연결, 이 판 이전에 QR로 붙은 iPhone)와 QR로 받은 **기기 열쇠**. 둘 다 같은 자리(HTTP `/api/*`, `/ws`, 터미널 스트림, `/files/*`, `/agent/join`)에서 `server/devices.ts`의 `authenticate()` 하나로 판정한다. 공용 코드는 SHA-256 뒤 상수 시간 비교, 기기 열쇠는 기기 ID로 행을 찾아 저장한 SHA-256과 상수 시간으로 비교한다. DB(`auth_devices`)에는 비밀의 해시만 둔다.
- 인증 실패 응답은 상태 코드와 문장을 그대로 두고 코드만 더한다: 401 `{error:"인증이 필요합니다",code:"unauthorized"}`. 끊은 기기의 열쇠는 401 `device_revoked`이며 문장도 '인증이 필요합니다.'로 시작해 출시된 앱이 같은 안내(새 QR로 다시 연결)를 고른다. 요청을 처리하는 사이 코드가 바뀌었거나 그 기기를 끊었으면 401 `auth_changed`(짝 맺기 시작·터미널 스트림 준비).
- `GET /api/devices`(사용자 Bearer, 쿼리 없음) → `DeviceAccessList {shared:{lastSeenAt,platforms:[{platform,lastSeenAt}],current,rotatedAt}, devices:[{id,name,platform,pairedAt,lastSeenAt,current}], failures:{count,days,lastAt}, events:[…최근 50줄]}`. `current`는 이 목록을 부른 요청의 자격이다. 공용 코드 접속의 `platform`은 앱 머리글(`X-IAMCEO-App-Platform`)의 `ios`·`macos`, 머리글 없이 이 Mac 안에서 온 요청은 `local`, 그 밖은 `other`. 마지막 접속 시각은 메모리에 바로, DB에는 1분에 한 번 쓴다.
- `DELETE /api/devices/:id` → `{ok:true, device}`. 그 기기의 실시간 연결과 터미널 스트림을 바로 닫고(4001) 다음 HTTP부터 401 `device_revoked`. 없거나 이미 끊은 기기는 404 `device_not_found`. 범위 구분은 없다(어느 자격으로도 목록을 보고 끊을 수 있다. 공용 코드 교체만 이 Mac에서).
- 접속 기록(`auth_events`): `auth_failed`(틀린 코드·열쇠 `wrong`, 끊은 기기의 열쇠 `revoked`: 주소·시각, 끊은 기기면 그 이름), `pair_failed`(맞지 않는 QR: 주소·시각), `paired`(기기 이름·주소), `device_revoked`(`owner`·`clone`·`unused`), `code_rotated`. 자격 없이 두드린 요청은 세지 않는다. 같은 주소·까닭의 실패는 10분씩 한 줄로 묶어 `count`로 센다. 코드·열쇠 값은 어느 표에도 넣지 않는다. 90일 지난 기록과 2,000줄을 넘는 기록, 끊은 지 90일 지난 열쇠를 정리한다.
- 표(`auth_devices`, `auth_events`, `auth_shared_seen`)는 `MIGRATIONS`가 아니라 열 때마다 `CREATE TABLE IF NOT EXISTS`로 만든다(`db.ts` `AUTH_TABLES`). DB 판 번호가 오르지 않아 이전 판 서버도 이 DB를 연다. 다만 이전 판 서버는 기기 열쇠를 모르므로 그 사이 기기 열쇠로 붙은 기기는 401을 받고 새 QR이 필요하다(공용 코드로 붙은 기기는 그대로).

### 폴더·GitHub 가져오기 보안 한도

폴더 생성은 mode 0755로 만들고 lstat·부모/자식 realpath를 재검사한다. 실패 시 새 항목만 rmdir하며 재귀 정리하지 않는다. 폴더 열거는 숨긴 항목·파일까지 최대 2000개를 읽어 정렬하고 응답은 500개까지만 반환한다. 열거/응답 한도에 도달하면 truncated=true다. 앱 행 ID는 이름과 목록 순번으로 만든다.

clone은 `<IAMCEO_HOME>/clone-staging/<jobId>`(0700)에서 수행한다. 대상 부모를 다시 검사하고 이름이 없을 때만 rename한다. EXDEV면 대상 부모 아래 `.iamceo-clone-<jobId>`(0700)에서 다시 받은 후 rename하며 다시 EXDEV면 안내하고 실패한다. 사용자 대상 경로는 실패 정리하지 않는다. 정리는 소유 identity·lstat·realpath를 확인한 임시 폴더에만 적용하며 quarantine 이동 뒤 identity를 재확인한다. 시작 여유 공간은 5 GiB 이상이어야 하며, 실행 중 2초마다 및 게시 전에 크기를 확인해 2 GiB 초과 시 프로세스 그룹을 중단한다. 오류는 `저장소가 너무 큽니다(2GB 초과)`다. 전체 이력을 받으며 서브모듈 재귀는 하지 않는다. 상속 환경의 Git 제어·추적 변수를 제거하고 `-c protocol.file.allow=never -c core.hooksPath=/dev/null`을 사용한다. 완료/실패 기록만 최대 50개·1시간 보관하며 만료 ID는 404다.

### 알려진 한계: 폴더·GitHub 가져오기의 경로 경쟁 (2026-11-07 결정)
폴더 만들기와 clone 게시는 경로를 realpath·lstat 로 앞뒤 검사한다. 하지만 검사와 mkdir/rename/정리 사이의 짧은 경쟁(TOCTOU)은 Bun/Node 파일 API 로 완전히 닫을 수 없다(openat·RENAME_NOREPLACE 류가 없음). 이 경쟁을 이용하려면 서버 사용자의 홈 폴더를 이미 바꿀 수 있어야 하고, 그 권한이면 이 기능 없이도 같은 일을 할 수 있다. 그래서 위험을 받아들인다. 접속 코드만 가진 원격 요청(홈 밖 경로, `..`, 심볼릭 링크, 옵션·명령 주입, 다른 호스트)은 막는다.

### 알려진 한계: 로컬 파일 열람·자료 등록의 경로 경쟁 (2026-11-08 결정)
로컬 파일 API는 한 번 얻은 canonical 경로에 정책 검사와 stat을 함께 적용하고, 열린 FD의 fstat과 dev/ino가 같을 때만 읽는다. 일반 파일의 nlink>1은 읽기와 첨부 복사 전후에 403("다른 이름으로 연결된 파일(하드 링크)은 열지 않습니다")으로 거부한다. 팀장 도구와 공통 비밀 파일·위치 정책을 쓰며 실제 config.home/IAMCEO_HOME 및 Claude/Codex 홈 설정의 canonical 경로 전체도 금지한다. SVG 자료는 이미지 원본을 첨부한다.
상위 디렉터리를 검사와 open 사이뿐 아니라 realpath·정책 검사와 stat 사이에 바꾸는 경쟁도 남는다. Node/Bun에 디렉터리 FD 기준 openat이 없어 상위 경로를 고정할 수 없다. 필요한 권한은 경로의 교체 가능한 상위 디렉터리에 대한 로컬 쓰기 권한이며, 공유 작업 폴더나 ACL을 통해 이 권한을 가진 다른 사용자도 포함한다. 서버와 같은 UID나 비밀 파일의 직접 읽기 권한이 필수인 것은 아니다. 이 한계는 받아들이되, 서로 다른 realpath 관측의 inode와 정책 판단을 섞는 경우는 거절한다.

### 보고 보완 범위

core 업무 턴의 최종 결과가 없으면 기존 업무를 다시 실행하지 않는 보고 보완을 한 번 요청한다. 보완을 포함한 턴도 완료·답변·막힘·질문·열린 결재 등 유효 결과 없이 끝나면 execution journal의 report notice claim으로 '결과 보고 누락' 시스템 메시지와 error activity를 한 번 남긴다. 추가 보완/업무 재실행은 자동으로 만들지 않는다. 누락을 남길 때 그 팀장이 worker이고 프로젝트 총괄이 따로 있으면 총괄에게도 wake=true 시스템 글("○○의 결과 보고가 보완 요청 뒤에도 없습니다…")을 같은 claim 안에서 한 번 넣는다(서버 가동 중·재시작 복구 공통, 누락된 쪽이 총괄 자신이면 생략). 이 글로 깬 총괄의 턴은 보완 대상이 아니다. 보완의 오류·중단 종료도 같은 누락 확인을 한다. 기존 notice 응답의 하위 호환 추가 필드 `deliveryNotices.reportNotices`는 `{kind:"missing_report",runId,memberId,messageId,createdAt,title:"결과 보고 누락"}` 목록이다. 이후 해당 팀장이 유효한 결과·막힘·질문을 남기거나 열린 결재로 기다리면 활성 목록에서 빠지고 시스템 메시지는 이력으로 남는다. 총괄·본사 AI의 팀장 보고 확인 턴은 보완 대상에서 제외하고, wake=true 대표 메시지·결재 답으로 시작한 턴은 계속 검사한다. 팀장의 실제 배정 업무는 기존 최종 보고 의무를 유지한다.

누락 생성과 활성 목록은 `Store.hasExecutionReport`의 같은 판정을 사용한다. 해당 팀장에게 열린 결재가 있으면 생성 시각과 관계없이 대표 답 대기로 인정한다(보완 턴의 `알림` 보고가 기존 열린 결재를 가리킬 때도 포함). 완료·답변·막힘·질문은 해당 실행뿐 아니라 보완 입력이 가리키는 같은 팀장·프로젝트의 원 실행 및 같은 전달을 재사용한 실행의 시작부터 확인한다. 원 업무 이전 보고나 다른 팀장의 보고·결재는 근거가 아니다. `진행`·`알림`만 있고 유효 보고·열린 결재가 없으면 기존 누락 검사를 유지한다. 기존 `missing_report`도 조회할 때 재평가해 활성 목록에서 해제하며 과거 원문은 수정·삭제하지 않는다. 새 대표용 누락 메시지·보완 activity에는 실행 UUID를 표시하지 않고 journal·notice 식별자·activity event ID 및 팀장에게 전달하는 원 실행 참조에만 유지한다.

### 추가 계약 (서버 API 2차·앱 모델)

- `ProjectSummary.needsCount`: 열린 결재 + 안 끝난 대표 할 일 + status=blocked이고 blockedReason=permission/selection인 팀장 수 + status=error 팀장 수 + 전달 notice의 phase=needs_owner 건수. 항목별 합이며 한 팀장에게 결재와 전달 확인이 함께 있으면 각각 센다. `needsDanger`는 오류 팀장 수가 1 이상인지를 뜻한다. 기존 inboxCount(결재+할 일), blockedCount(permission만), errorCount는 유지한다. needs_owner는 복구 엔진의 동일 projection을 사용하므로 가상 옛 실패·정체 notice도 포함한다.
- `GET /api/projects/:id/state?lite=1`, `GET /api/sync?projectId=:id&lite=1`: files에서 body를 생략하며 HTML 원본은 원래 목록에 없다. 나머지 메타데이터·첨부 목록은 보존한다. lite 생략/0은 기존 전체 응답이다. `/ws?v=2&lite=1`(또는 v1 `/ws?lite=1`)은 같은 원칙으로 file 사건에서 body를 생략하며 epoch/seq·heartbeat·인증 경계는 같다. WebSocket 주소에는 접속 코드를 넣지 않고 헤더를 사용한다.
- 앱의 `APIClient(liteStateEnabled:false)`가 기본이다. T8이 모든 자료 리더를 `fileBody(id:forceRefresh:)`로 전환한 뒤 켠다. 켜면 상태·sync·WS 모두 lite를 요청한다. 본문 캐시는 API actor별(호스트·인증 경계별), 최대 32개다. 자료 ID는 새 판마다 달라지며 legacy 제자리 수정 시 forceRefresh를 쓴다.
- Message에 `fileIds`, `supersedes`, `supersededBy`, `contextFileId`를 추가한다. 첫 자료용 fileId와 과거 본문의 자료 링크는 유지한다. fileIds는 저장된 전체 report_references를 읽고, 옛 보고는 첫 자료 및 프로젝트 소속을 확인한 과거 자료 링크를 복원한다. `post/report` 정정은 명시적인 `supersedes` 또는 기존 `corrects_message_id`를 받는다. 같은 팀장·같은 프로젝트의 최신 보고만 정정하고, 둘을 다 주면 같아야 한다. 자동 추정은 서로 다른 업무의 보고를 잘못 숨길 수 있으므로 하지 않는다. 앞 보고는 삭제하지 않으며 양쪽 ID를 읽기 응답·WS에 싣는다.
- `POST /api/todos/:id/done`의 선택 필드: `note`(최대 100,000자), `fileIds`(업로드된 첨부 ID, 최대 50개). v1/v2 모두 지원하며 v2의 If-Match는 유지한다. 완료 답·첨부는 Todo.completionNote/completionFileIds에 원문 그대로 저장하고 요청 팀장과 총괄의 완료 알림에 싣는다. 받을 총괄이 없으면 영속 보류하며 이후 전달 때도 같은 원문을 쓴다. 재완료는 기존 완료를 덮어쓰지 않는다. 체크를 풀면 답·첨부를 지우고 기존 정정 절차를 따른다. 완료 답은 해당 할 일 ID·제목·완료 시각을 붙인 대표 원문 대조 근거다. 첨부 안의 글은 승인 근거가 아니다. 비밀번호 등 비밀을 대화에 남기지 말라는 안내는 앱 담당이다.
- `POST /api/projects/:id/messages`의 선택 필드 `contextFileId`는 같은 프로젝트의 자료 ID만 허용한다. 저장된 대표 body는 그대로 유지하고 전달문 끝에 `[시스템 자료 맥락 · 대표 원문 아님]`과 `대표가 보던 자료: <제목> (<파일 ID>)`를 별도 줄로 붙인다. 팀장 직접 지시라면 총괄의 판 맞춤 알림에도 같은 맥락을 붙인다. 이 시스템 줄은 대표 원문 대조 근거가 아니다.
- 로컬 미리보기 `GET /api/projects/:id/local-file?path=...`: `kind=html`은 content와 `?render=1` 안전 HTML 응답, `kind=csv`는 원문 content와 인용/줄바꿈을 보존한 rows 배열, `kind=pdf`는 application/pdf 원본 바이트 응답과 X-Local-File-Metadata(base64 JSON), `kind=xlsx`는 previewAvailable=false·previewNote·원본 path를 반환한다. xlsx는 별도 변환 의존성 없이 '미리보기 불가 + 열기' 계약을 택했다. PDF는 50MiB 상한이며 안전 검사한 같은 FD에서 읽은 바이트만 응답한다. 기존 text/image/other와 server/secret-paths.ts의 비밀·링크·TOCTOU 정책은 유지한다.
- 아티팩트 및 HTML render 응답 CSP: `sandbox allow-scripts`와 ARTIFACT_CSP(`default-src 'none'`, `connect-src 'none'`, 인라인 script/style 및 data/blob 자원만). allow-same-origin을 넣지 않는다. 외부 CDN 금지, 스크립트는 파일 안에, 링크는 앱이 확인 후 연다는 역할 규칙과 같다. CSP가 못 막는 WebRTC/preconnect 한계는 §3.2와 같으며 앱의 네트워크·탐색 차단도 유지해야 한다.
- `Settings.macScriptNotifications` 기본 true. 기존 notifyMac(기본 false)의 알림 동의가 켜져 있고 이 경로 스위치도 true일 때만 osascript를 호출한다. `PATCH /api/settings {macScriptNotifications:false}`로 서버 스크립트 알림만 끈다. v1은 Settings, `X-IAMCEO-Contract:2` + `If-Match:"<settings revision>"`는 `{settings,revision}`를 반환하고 이전 revision이면 409다. 기존 PUT 설정 API도 이 필드를 받는다. T9는 Mac 앱 자체 알림을 사용자가 켠 뒤 PATCH로 이 경로를 끈다. 이 PATCH가 앱 알림 권한을 자동으로 켜지는 않는다.
- 앱은 T1 Message.deliveryInfo[], DeliveryNoticeItem.waitReason/waitingSince/runLimit, MemberDeliverySummary.waitReason/waitingSince/runLimit/waitReasons, deliveryNotices.reportNotices를 읽는다. 누락은 구형 서버로 처리하고 알 수 없는 waitReason 문자열도 디코딩한다. 표시할 때 waitReasonLabel/waitReasonTone을 사용한다.


### 추가 계약 (1차 완성도: 권한 확인·폴더 신뢰·막힘의 까닭·실행 엔진)

모두 선택 필드의 추가다. 기존 필드의 이름·타입·상수는 그대로이고, 모르는 키를 무시하는 출시된 앱(iPhone 0.2.2)과 맞는다. 필드가 없으면 구형 서버다.

- `Settings.permissionAcknowledged?: boolean`: 대표가 권한 방식(묻지 않고 실행 등)을 확인했는가. `GET /api/bootstrap`·`/api/sync`의 settings 와 설정 변경 응답에 싣는다. DB 를 처음 열 때 한 번만 정한다. 새로 만든 DB 와 아무것도 하지 않은 DB(본사 말고 프로젝트가 없고 팀원·대화도 없는 DB)는 false, 이미 쓰던 DB 는 true 다. true 로만 바뀐다. `PATCH /api/settings`는 `{permissionAcknowledged:true}`만 받고(false 는 400. `macScriptNotifications`와 함께 또는 따로), `PUT /api/settings`는 불리언을 받되 false 는 '바꾸지 않음'으로 읽는다(받은 설정을 통째로 돌려보내는 화면 때문이다). false 인 동안 서버는 `permissionMode:"bypassPermissions"`여도 Claude 실행 설정에 `skipDangerousModePermissionPrompt`를 넣지 않는다. 그래서 CLI 가 자기 경고 창을 띄운다. 앱은 false 일 때만 첫 실행의 권한 방식 선택 화면을 보이고, 고르면 `PUT /api/settings`로 `permissionMode`와 `permissionAcknowledged:true`를 함께 보낸다. 필드가 없으면 앱은 true 로 읽는다.
- `POST /api/projects`의 `trustFolder?: boolean`: true 면 서버는 프로젝트 id → 만들 때의 폴더를 settings 표의 `folderTrust` 키에 적는다(스키마 변경 없음). 그 뒤 팀원이 `blockedReason:"setup"`·관측 오류 `folder_trust`로 멈추면, 다음이 모두 참일 때만 기존 승인 답 경로로 `Yes, I trust this folder`(Codex 는 `Trust and continue`)를 고른다. 서버가 띄운(origin=runner) core 세션이고, 프로젝트가 보관되지 않았고 실행이 켜져 있으며, 팀원의 cwd 와 프로젝트의 cwd 와 기록된 폴더가 글자 그대로 같고, 창의 선택지가 정확히 둘(신뢰 하나와 거절 하나)이다. 실행기는 누르기 직전에 창을 다시 읽어 지문이 같을 때만 누른다. 같은 지문에는 한 번, 한 세션(sessionGeneration)에서 많아야 2번만 시도하고, 고르면 활동 기록에 남긴다. 스스로 답한 창은 대표에게 승인 대기로 알리지 않는다. 답하지 못하면 평소처럼 승인 카드와 알림으로 간다. false·생략은 기존 동작이다. 프로젝트 폴더를 바꾸면 기록과 달라져 더 누르지 않는다.
- `Member.blockedCode?: "trust_dialog_unrecognized" | "start_not_ready"`: `status:"blocked"`일 때만 싣는다. 값은 `statusObservation.error.code`에서 읽으며 따로 저장하지 않는다. `blockedReason`은 그대로 `status_unknown`이다(승인 창으로 단정하지 않는다). `trust_dialog_unrecognized`는 CLI 가 상태를 알리지 않았고, 정확 해석기는 읽지 못했으며, 화면에 입력 칸이 없고, 화면 끝 쪽에 선택 표시(`❯`·`›`)가 붙은 줄과 그 위에 폴더 신뢰를 묻는 글이 있을 때다. 입력 칸이 보이는 화면(시작 배너, 다시 그려진 대화)은 글에 trust 가 있어도 해당하지 않는다. 안내 전용이며 서버는 이 창에 어떤 키도 보내지 않는다. `start_not_ready`는 한 번도 턴을 돌지 않은 CLI 가 띄운 뒤 60초 넘게 준비를 알리지 않았거나, 보낼 말이 준비 신호를 기다리다 한도를 넘긴 경우다. 준비 신호가 오면 막힘과 함께 사라진다. 알림은 `<이름> 확인 필요`·`<이름> 시작 지연`으로 나가며, 한 번의 막힘에서 같은 까닭은 한 번만 알린다. 서버를 다시 띄워도 저장돼 있던 까닭과 같으면 다시 알리지 않는다. 앱은 이 코드가 있으면 설명과 '터미널 열어 직접 답하기' 버튼을 보이고, 모르는 값은 기존 화면 그대로다.
- `Bootstrap.engine?: {state:"ok"|"unresponsive"|"version_mismatch", version?, expectedVersion?}`: 실행 엔진(herdr-core) 상태다. `GET /api/bootstrap`, `/api/sync`의 bootstrap, `GET /api/readiness`의 `engine`에 같은 값을 싣는다. 엔진이 처음 답하기 전과 엔진이 없는 실행 방식에서는 싣지 않는다. 엔진의 hello 가 generation 1 이고 버전이 고정 버전(`vendor/herdr-core/release-lock.json`)과 같으면 `ok`, 다르면 `version_mismatch`다. 60초 넘게 이어서 답이 없으면 `unresponsive`이고(잠깐의 끊김은 바꾸지 않는다) 이때 `version`은 없다. `expectedVersion`은 늘 고정 버전이다. 상태가 바뀌면 기존 `projects` 사건으로 알려 화면이 스냅샷을 다시 읽는다. 앱은 `ok`가 아니면 안내 한 줄을 보인다.
- `Bootstrap.tailnet?: {state:"ok"|"off", lastAddress?, since?, macNotified?}`: 이 Mac 의 Tailscale 상태다. `GET /api/bootstrap`, `/api/sync`의 bootstrap, `GET /api/readiness`의 `tailnet`에 같은 값을 싣는다. 서버가 Tailscale 주소를 스스로 찾는 설치(config.json 에 `hosts`를 적지 않은 설치)이고, 이 설치가 전에 Tailscale 주소를 연 적이 있을 때만 싣는다(연 주소와 시각은 settings 표의 `tailnetSeen` 키에 남는다. 연 적이 없으면 Tailscale 을 쓰지 않는 사람이라 싣지 않고 알리지도 않는다). 확인된 Tailscale 주소가 60초 넘게 잡히지 않으면 `off`다(부팅 직후 Tailscale 이 늦게 올라오는 동안은 `ok`). 전에 연 소켓이 남아 있어도 인터페이스가 사라졌으면 꺼진 것으로 본다. 다시 잡히면 바로 `ok`다. `since`는 주소가 잡히지 않기 시작한 시각으로 `off`일 때만 있다. `off`가 되면 Mac 알림을 꺼짐마다 한 번 띄운다(결재 알림 설정 `notifyMac`과 무관하다): `macScriptNotifications`가 false 가 아니면 서버가 띄우고 `macNotified:true`를 싣는다. false 면 서버는 띄우지 않고, Mac 알림을 켠 Mac 앱이 `macNotified`가 없는 `off`를 보고 같은 글을 한 번 띄운다. 상태가 바뀌면 기존 `projects` 사건으로 알려 화면이 스냅샷을 다시 읽는다. 서버와 같은 Mac 의 Mac 앱만 `off`일 때 안내 한 줄을 보이고, iPhone 앱은 보이지 않는다.

### 묵은 대표 할 일 정리
- 서버 틱은 보관하지 않은 프로젝트에서 생성 후 **3일 초과** 열린 할 일을 찾는다. 부탁한 팀장(memberId)이 명부에 있는 worker면 그 팀장에게, 없거나 대표·총괄이 만든 일이면 프로젝트 총괄(본사는 본사 AI)에게 시스템 소식을 넣는다. 잠든 팀장은 여전히 명부에 있으므로 안내를 보관한다. 받을 사람이 없으면 다음 틱에 다시 찾는다.
- 소식과 `todos.stale_notified_at`을 원자 저장해 같은 할 일은 **72시간에 한 번 이하** 안내한다. `wake=false`, 기존 next_turn 계약을 그대로 사용하며 안내만으로 pump·세션 시작을 하지 않는다. 다음에 일을 할 때 로그인·파일·설정 등을 직접 확인하고 결과를 이유로 todo_close(done), 필요 없어졌으면 dropped. 추측으로 닫지 않는다.
- 주기 판 정리는 기존 활성·연결·총괄 idle·중복 방지 조건과 boardTidyHours=0 비활성화를 유지한다. 일반 변경 검토 조건에 더해 3일 초과 열린 할 일이 있고 `projects.stale_review_at` 이후 24시간 이상 지났으면 변경이 없어도 지시를 넣는다(간격 설정과 독립). 열린 묵은 할 일이 있는 판 정리 요청 시 이 시각을 원자 기록하므로 자동 묵은 할 일 검토는 하루 한 번 이하이다. 일반 변경에 따른 정리는 원래 주기를 따른다.
- 총괄은 직접 확인할 수 있는 일만 근거를 적어 닫으며 대표 브라우저(Aside 등)는 열지 않는다. 확인할 수 없으면 남기고 부탁한 팀장의 자동 안내를 기다린다.
- 대기열이 wake=false 소식뿐이면 잠재우기를 허용한다. 소식은 보류로 보존하고 resume 뒤에도 그 소식만으로 턴을 시작하지 않는다. wake=true 입력이나 미수신 결재 답, 열린 결재가 있으면 기존처럼 거절한다.
- 스키마 v30→v31은 MIGRATIONS 끝에 `todos.stale_notified_at`, `projects.stale_review_at` nullable TEXT를 추가한다. PRAGMA user_version은 기존 마이그레이션 개수 기반으로 1 증가한다. 다운그레이드는 새 DB를 옛 바이너리로 열 수 없으므로 이주 전 백업으로 복원해야 한다.

### 오류·보류 코드(E9)
- 오류 응답 몸은 `{error, code, reason?}`이다. `error`는 표시용 한국어 문장으로 예전 그대로 싣고, `code`는 `shared/error-codes.ts`의 `ERROR_CODES` 키다. 서버의 모든 `ApiError`는 코드가 필수다(`tests/error-codes.test.ts`가 소스를 훑어 확인한다). 이미 내보낸 코드(`STARTING`·`LOCAL_ONLY`·`TERMINAL_REFUSED`·`MESSAGE_SCOPE_CHANGED`·`project_not_archived` 등)는 이름을 바꾸지 않는다. `reason`은 그런 넓은 코드 아래의 좁은 사유로, 지금은 실행 엔진의 터미널 거절(`core_terminal_missing`·`core_lease_required`·`core_lease_other`·`core_terminal_finished`)에 싣는다. 작업 영수증(`/api/operations/:id` 등)의 거절·불명에도 같은 `reason?`이 있고(옛 영수증에는 없다), 터미널 스트림의 `closed` 프레임은 거절 때 `code?`를 싣는다. 푸시 경로의 오류 몸도 `{error, code}`다.
- `ERROR_CODES`의 값은 `{ko, en?}`이다. `ko`는 그 코드의 대표 문장(실제 응답은 이름·숫자가 들어간 문장일 수 있다), `en`은 앱 화면 영어화(4차) 때 채운다. 묶음별 덩어리로 나뉘어 있고 남의 덩어리는 고치지 않는다.
- `Member.fenceCode?`: `lastError`가 자동 입력을 멈춘 보류일 때 그 코드(`control_unknown`·`starting_unknown`·`core_reconnect_held`·`stop_check_held`·`usage_wait`). 서버는 이 값(`members.fence_code`)으로만 가르고 `lastError` 문장은 예전 그대로 쓴다(이전 판 서버는 그 앞머리로 판정한다). `lastError`를 바꾸면서 코드를 주지 않으면 코드를 지운다.
- `Message.deliveryCode?`: `deliveryNote`가 정해진 보류 문장일 때 그 코드(`held_delivery_unknown`·`held_import`·`held_api_outage`·`held_usage_limit`·`held_<보류 사유>` 등, `server/hold-codes.ts`의 표). 앱의 '전달 여부를 확인할 수 없는 보류' 판정과 재시작 정리의 '가져온 말' 판정은 이 코드로 한다.
- 세 열(`members.fence_code`·`messages.delivery_code`·`operation_receipts.reason`)은 DB 판 번호를 올리지 않고 더한다(`server/db.ts`의 `ERROR_CODE_COLUMNS`). 이전 판 서버는 열을 모른 채 문장만 고치므로, DB를 열 때마다 문장에서 코드를 다시 맞춘다(`reconcileHoldCodes`). 문장에서 코드를 읽는 곳은 이 이주뿐이다.
- 앱은 코드가 있으면 코드로, 없으면(옛 서버) 예전처럼 문장으로 가른다(`native/.../Services/ServerCode.swift`).
- 대표가 이 팀장을 골라 보낸 글이 있는 턴(보고 제목의 `(직접)`)은 전달 글의 `[대표 직접]` 표지가 아니라 원본 메시지의 받는 사람(`targetMemberId`)으로 가른다.

### 추가 계약 (2차 완성도: 보고 언어·명령줄 언어·점검·진단·프로젝트 삭제와 내보내기)
- `Settings.reportLanguage?: "ko"|"en"`: 총괄·팀장이 대표에게 쓰는 글(보고·결재 카드·할 일)의 언어. 새 서버는 기본 `"ko"`를 늘 싣는다(settings 표의 키 하나라 옛 판으로 되돌려도 무시된다). `PUT /api/settings`(v1·v2)가 받으며 그 밖의 값은 400이다. 앱은 서버가 이 값을 실었을 때만 설정 줄을 보이고, 바꿨을 때만 이 키를 보낸다(옛 서버의 strict 스키마는 모르는 키가 있으면 저장 전체를 거절한다).
- `"en"`이면 `renderRole`이 기본·사용자 템플릿 모두의 끝에 `ENGLISH_REPORT_RULE`(`server/roles.ts`)을 붙인다. 대표에게 쓰는 글을 영어로 쓰라는 줄과, 서버 머리말(`[대표]`·`[대표 직접]`·`[대표 답(원문) …]`·`[총괄] <이름>에게`·`[보고 <이름>]`·`[시스템]`·`사용자 요청(원문, 서버 확인)`·`총괄 인용(미확인)`)의 뜻을 영어로 설명하는 줄이다. 머리말 자체는 언어와 상관없이 그대로다. 규칙 파일은 세션을 띄울 때마다(재개 포함) 다시 쓰므로 새로 연 세션부터 적용된다.
- 명령줄 문구: `server/cli-text.ts`의 `say(ko, en)`. `IAMCEO_LANG` → `LC_ALL` → `LANG` 순으로 처음 있는 값이 `ko`로 시작하면 한국어, 그 밖에는 영어다. 부를 때마다 환경을 다시 읽고, 두 인자를 모두 만들기 때문에 인자에 부수 효과를 넣지 않는다. `install.sh`도 같은 규칙이고, 서명·공증 실패만 두 언어를 함께 찍는다. 새 명령은 `USAGE`와 `USAGE_EN`에 한 줄씩 더한다(시험이 두 도움말의 명령 목록을 대조한다).
- `GET /api/doctor[?lang=ko|en]`(사용자 Bearer) → `DoctorReport {checkedAt, serverVersion, checks: DoctorCheck[]}`. 점검 id는 `server`·`engine`·`claude`·`codex`·`cli_version`·`tailscale`·`service`·`backup`·`disk` 고정이고, `state`는 `ok|warn|fail|unknown`, `fix`는 일반 사용자가 할 수 있는 동작만 가리킨다. 서버가 시작 중이면 503 `STARTING`. `iamceo doctor [--json]`은 서버가 꺼져 있어도 돌고(그때 `server`=fail), fail 이 하나라도 있으면 종료 코드 1이다.
- `POST /api/diagnose`(사용자 Bearer, 이 Mac에서 온 요청만: 아니면 403 `LOCAL_ONLY`, 본문 없음 또는 `{}`, 시작 중이면 503 `STARTING`) → `{path, sizeBytes, createdAt}`. `~/.iamceo/diagnostics/<시각>/`와 같은 이름의 `.zip`을 만들고 최근 5개만 남긴다. 대화·보고·결재·할 일·자료의 본문, 첨부, 접속 코드, 팀장 열쇠, 알림 토큰, 환경 변수 값은 넣지 않는다. 앱 버전은 버전 머리글을 보낸 앱이 불렀을 때만 들어간다. `iamceo diagnose`도 같은 묶음을 만든다.
- `DELETE /api/projects/:id`: 보관한 프로젝트만(아니면, 본사도 409 `project_not_archived`) → `{id, deleted:true, removedAttachments}`. 그 프로젝트의 첨부·팀장 받은 편지함·실행 파일을 지우고 작업 폴더는 건드리지 않는다. `GET /api/projects/:id/export`: 이 Mac에서 온 요청만(아니면 403 `LOCAL_ONLY`) → zip 한 개(대화·결재·할 일·업무·자료와 첨부 원본; 접속 코드·팀장 열쇠·전달 내부 기록은 빼고).
- 앱 버전 머리글(D5): `X-IAMCEO-App-Version`, `X-IAMCEO-App-Build`, `X-IAMCEO-App-Platform`(`macos`|`ios`), `X-IAMCEO-Api-Level`. 모양이 어긋나면 머리글이 없는 옛 앱처럼 다룬다. 머리글을 보낸 앱 목록은 `GET /api/readiness`의 `apps`(최근 8개)에 보인다. 출시 앱 해석기 게이트는 `bash scripts/check.sh compat`([릴리스 절차 §5](releasing.md#5-출시된-앱과의-호환-확인)).
- `Bootstrap.cliVersions?: CliVersionInfo[]`(D9), `Bootstrap.server?`·`Bootstrap.compat?`(D5)는 선택 필드다. `server`·`compat`은 앱이 버전 머리글을 보냈을 때만 싣고, `compat`은 그중에서도 실제로 맞지 않을 때만 싣는다. 머리글이 없는 출시된 앱(0.2.2·0.2.3)의 응답에는 둘 다 없다. 출시된 앱은 모르는 선택 필드(`cliVersions`, `Settings.reportLanguage`)를 건너뛴다.
