# IAMCEO 구현 계약

현재 구현의 계약이다. 공통 타입은 `shared/types.ts`, 실행기 계약은 `server/runner/types.ts`, core protocol은 upstream generation 1이다. 아키텍처 개요는 [architecture.md](architecture.md), 고정 core 출처는 [vendor 문서](../vendor/herdr-core/README.md)를 본다. `docs/herdr-schema.json`과 herdr/headless 어댑터는 과거 연동의 호환·회귀 자료이며 새 제품 실행의 기준이 아니다.

## 0. 작업·시험 경계

- 사용자 실제 `~/.iamceo`, 기존 herdr/core 소켓·세션·서비스에 개발 쓰기 요청을 보내지 않는다. 시험은 임시 `IAMCEO_HOME`, 명시적 시험 소켓, 격리된 `HC_SESSION`·XDG 경로를 사용한다.
- 단위·통합 시험은 실제 유료 모델을 부르지 않는다. core는 fake JSON-RPC 서버, 기존 headless 회귀 시험은 fake Claude를 쓴다. 실제 모델 호출·전역 도구 설치·업데이트·배포·launchd 등록은 해당 작업이 명시적으로 요청된 경우만 한다.
- core shutdown은 detach다. 앱·서버 종료를 이유로 holder나 제공자 CLI를 끝내지 않는다. 명시적 멤버 종료·잠재우기·안전한 세션 교체와 구분한다.
- 공식 CLI의 사용자 설정·로그인·도구를 유지한다. 호출별 인자·MCP 설정을 쓰고 전역 Claude/Codex 설정 파일을 수정하지 않는다. 부모의 외부 `HC_*`·`HERDR_*`·Claude 중첩 세션 변수는 전달하지 않고, 사용자 HOME·XDG 설정 경로를 복원한다.
- 초안을 지우거나 불확실한 PTY 입력을 자동 재전송하지 않는다. 화면은 입력 안전 확인·사람의 조작을 위해 읽을 수 있지만 실행 상태나 최종 답변을 추측하는 근거로 쓰지 않는다.
- 자기 담당 파일만 고치고 다른 작업자의 변경을 되돌리지 않는다. git push·외부 게시·라이선스 변경을 일반 구현 작업에 포함하지 않는다.

## 1. 구조

```text
SwiftUI macOS/iOS ── REST·전경 폴링 ─┐
React 웹 ─────────── REST·WS ───────┼─ Bun / SQLite / Orchestrator
MCP stdio ── iamceo mcp /agent/* ──┘             │
                                           CoreRunner
                                               │ Unix NDJSON JSON-RPC
                                           herdr-core / holder
                                               │ PTY
                                      공식 Claude Code / Codex CLI
```

| 경로 | 내용 |
|---|---|
| `server/config.ts` | IAMCEO_HOME, 포트·주소, `IAMCEO_CLAUDE_BIN`, `IAMCEO_CODEX_BIN`, `IAMCEO_CORE_BIN`, `IAMCEO_CORE_SOCKET` |
| `server/db.ts`, `store.ts`, `bus.ts` | WAL DB·마이그레이션 전 백업·도메인 상태·웹 이벤트 |
| `server/http.ts`, `orchestrator-api.ts` | 인증된 REST·웹 WS·접근 제어 |
| `server/orchestrator.ts`, `agent-tools.ts` | 전달·세션 교체·재결합과 MCP 업무 도구 |
| `server/runner/core-client.ts`, `core.ts`, `providers.ts` | core protocol, 멤버 소유권·입력·수동 제어, 공식 CLI 인자 |
| `server/runner/types.ts` | Runner·TerminalControl 계약 |
| `server/roles/`, `bin/mcp-bridge.ts` | 역할 프롬프트·stdio MCP 브리지 |
| `bin/iamceo.ts` | serve·service·status·attach·MCP·직접 CLI join |
| `native/` | SwiftUI macOS/iOS, REST·Keychain·로컬 호스트 기능 |
| `web/`, `shared/types.ts`, `shared/artifact-kit.ts` | React, 공통 도메인 타입·아티팩트 문서 조립 |
| `vendor/herdr-core/`, `scripts/setup-core.ts` | 고정 release·라이선스·checksum·macOS 서명 검증 |

`herdr.ts`, `herdr-client.ts`, `headless.ts`, `transcript.ts`는 기존 데이터·시험을 위한 과거 어댑터다. production의 새 실행기는 core로 고정된다. 기존 세션을 core 주소로 해석하거나 자동으로 새 CLI에 옮기지 않는다.

## 2. DB
`shared/types.ts`의 타입과 1:1. 테이블 projects, members, decisions, todos, work, messages, files, attachments, deliveries, activity(직원당 최근 500만 유지), settings(kv). JSON 필드(options, images, attachments)는 TEXT. `project_settings_v4` 는 프로젝트별 설정을 전체 설정으로 합칠 때 옛 값을 남겨 둔 표다(마이그레이션만 읽는다. 저장한 전역 권한과 프로젝트 값 중 가장 엄격한 것을 적고 바뀌면 대표에게 알린다. 프로젝트 모델이 하나로 모이면 직급 기본값의 빈 칸으로 올리고, 저장된 값과 다르면 직원별 지정으로 남긴 뒤 알린다). `files.html` 은 아티팩트 원본(FileDoc 에 싣지 않는다), `members.applied_config` 는 세션에 실제로 들어간 설정이다. `members.adopted_info` 는 편입 표시(JSON, `turnedOnRunner`)다. 판 정리: `decisions.close_kind`(decided·obsolete, AI 가 닫았을 때만)·`close_reason`·`close_quote`·`closed_by`·`closed_at`, `todos.outcome`(done·dropped)·`close_reason`·`closed_by`·`updated_at`, `projects.board_tidied_at`(마지막 판 정리). 멤버 `token`(MCP 인증, 화면에 안 나감) 컬럼 포함. id는 접두어+짧은 난수(`p_`, `m_`, `d_`, `t_`, `w_`, `msg_`, `f_`, `a_`, `dl_`). 시각은 ISO UTC. 첫 실행 때 본사 프로젝트(`id='hq'`, name '본사', cwd=홈, runnerEnabled=true)를 만든다.

`projects.chief_cli`는 총괄 제공자 기본값, `members.cli`는 멤버 제공자다. `members.session_generation`과 `member_session_history`는 CLI/backend/native session/pane/적용 설정·교체 이유·시각을 보관한다. native sessionId와 core paneId는 별개이며 Codex sessionId는 모르면 null이다. production backend는 core이고 과거 backend 값은 이력·명시적 전환 판단에 남긴다.

기존 DB의 버전을 올리기 전에 `VACUUM INTO`로 `<db>.pre-v<version>-<time>-<random>.bak`을 만들고 mode 600을 건다. committed WAL도 포함하는 독립 SQLite snapshot이며 백업 실패 시 마이그레이션을 중단한다. 원본의 대화·업무·토큰을 비우거나 새 DB로 바꾸지 않는다.

## 3. REST (`/api`, 헤더 `Authorization: Bearer <접속 코드>`, API 쿠키 없음)

- `GET /api/health`(인증 없음) → `{ok,version}`
- `GET /api/runtime` → `{backend:"core",core:{installed,available,version,detail},providers:{claude:{installed},codex:{installed}}}`. 읽기 전용 진단이며 daemon을 설치·시작하지 않는다
- `GET /api/bootstrap` → Bootstrap(`runtime` 진단 포함, `urls`: 서버가 듣는 주소 목록, `cli`: 터미널에서 CLI 를 부르는 명령). 답하기 전에 실행기를 다시 본다
- `GET /api/projects/:id/state` → ProjectState
- `GET /api/projects/:id/messages?before=<at>&limit=` → Message[]
- `POST /api/projects`(CreateProjectReq: `name,cwd,goal?,startConductor?,chiefCli?:"claude"|"codex"`) → Project · `PATCH /api/projects/:id`(PatchProjectReq). 실행 방식·권한·모델 필드는 없다. 보내면 400
- `POST /api/projects/:id/conductor/start` → Member (총괄 띄우기, runnerEnabled 를 true 로)
- `POST /api/projects/:id/messages`(SendMessageReq; id 는 클라이언트 UUID로 멱등) → Message. 연결되어 있지 않으면 409(§3.1)
- `POST /api/uploads?project=<id>&target=<직원 id>`(multipart, file, 50MB) → Attachment. `project` 를 주면 연결을 먼저 본다(409). 끝까지 올린 뒤에 보내기에서 거부당하지 않게 화면은 붙인다
- `POST /api/projects/:id/messages` 는 같은 id 면 그 글을 돌려주고, 그 글이 끝내 실패(failed)한 대표 글이면 같은 글을 다시 넣는다(대화 줄이 늘지 않는다).
- `GET /api/projects/archived` → Project[] · `PATCH archived:true`는 working·blocked·열린 결재·미완료 할 일·안전하게 종료할 수 없는 세션이 있으면 거부한다. 종료 전 상태·소유권·초안을 확인하고 확인할 수 없는 연결 오류도 성공으로 처리하지 않는다. 보관되면 세션을 잠재우고 전달은 `held(archived)`로 둔다. 보관 중에는 자동 깨움·새 세션·`runnerEnabled:true`를 거부하며 `archived:false`로 꺼내면 보류 전달을 다시 민다.
- `GET /api/projects/:id/decisions?status=done|open&before=<at>&limit=` → Decision[]. 기본 done(최근 답한 순, `before` 는 그 answeredAt 앞). open 은 전부(오래된 순, before·limit 무시) · `GET /api/decisions/:id` → Decision
- `POST /api/decisions/:id/answer`(AnswerReq) 멱등 → Decision. 새 답인데 연결되어 있지 않으면 409(같은 답 재전송은 그대로 돌려준다). `expectedVersion?`는 읽은 `Decision.updatedAt`과 같아야 하며 다르면 409; 네이티브 앱은 항상 보낸다
- `POST /api/todos/:id/done` `{done:boolean}` → Todo. 연결과 상관없이 된다. 체크를 풀면 AI 의 정리 이유도 지운다
- `POST /api/decisions/:id/reopen` → Decision. AI 가 `ask_close` 로 닫은 카드만(아니면 409). 결재할 항목으로 돌아가고(`reopenNote` 에 닫은 이유), 물은 직원·총괄에게 wake=false 로 알린다
- `POST /api/projects/:id/tidy` → TidyResult(`{already}`). 총괄(본사는 본사 AI)에게 판 정리 지시를 넣는다. 연결되어 있지 않으면 409, 총괄이 없거나 잠들었으면 띄운다. 이미 기다리거나 도는 정리가 있으면 `already:true`
- `GET /api/files/:id/artifact` → `{html}`(인증. kind=artifact 만, 아니면 404). 원본을 서버 출처의 문서로 내주지 않는다
- `GET /artifact-frame`(인증 없음, 빈 문서) 아티팩트를 그리는 격리 칸(§3.2)
- `POST /api/projects/:id/members` `{name,role?,cli?:"claude"|"codex",modelOverride?:string|null}` → Member. 새 core 직원 세션을 만든다
- `PATCH /api/members/:id` `{cli?:"claude"|"codex",modelOverride?:string|null,effortOverride?:Effort|null}` → Member. null은 적용 가능한 기본값으로 되돌린다. 직접 띄운 세션은 400. 제공자·살아 있는 세션 설정 변경은 §6의 이력·토큰 회전·안전한 교체 절차를 따른다
- `GET /api/members/:id/activity?limit=` → Activity[] · `GET /api/members/:id/screen` → `{text}` (core 현재 화면, `lines:0`; 터미널이 없으면 빈 글)
- `POST /api/members/:id/terminal/control` `{action:"claim"|"release"|"input"|"key",leaseId?,text?,key?}` → `{leaseId?,expiresAt?}`. 사용자 접속 코드로만 인증한다. lease는 5분, input은 128 KiB까지, key는 enter/up/down/esc/tab/ctrl+c/backspace. claim 외에는 같은 활성 token이 필요하고 직접 조작 중 자동 입력은 보류한다. CLI의 신뢰·인증·권한 선택은 이 명시적 사람 조작이나 `iamceo attach <memberId>`로 처리한다
- `/api/members/:id/approval`의 fingerprint 승인, `/api/herdr/*`, adopt/release/reopen-with-tools는 과거 herdr 연동의 호환 경로다. core는 구조화된 승인 창 파싱·자동 선택·기존 외부 칸 편입을 구현하지 않는다
- `POST /api/members/:id/fresh-session`은 같은 제공자의 새 세션으로 명시적으로 인계한다. 작업 중·승인 대기·불확실한 전달·직접 관리하는 세션은 거부한다. 잃어버린 Codex 세션과 기존 실행기 멤버를 복구하는 경로이며, 기존 실행기 터미널은 건드리지 않는다. 멤버 기록을 유지하고 세션 이력·토큰을 회전한다.
- `POST /api/members/:id/sleep`(`{force?}` 는 대표가 '그래도 재우기'를 눌렀을 때만) · `POST /api/members/:id/resume|compact`(resume 은 실행이 꺼진 프로젝트면 409) · `POST /api/members/:id/interrupt` · `POST /api/members/:id/close`(직접 띄운 세션만)
- `PUT /api/settings`(SettingsPatch) → Settings. `ranks`는 고친 칸만 보내도 된다. 저장된 과거 backend 값과 무관하게 production 새 실행은 core다. 제공자 선택은 멤버의 cli로 한다
- `GET /files/<attachment id>/<name>` 첨부(인증: 헤더 또는 첨부 쿠키. `<img>`·`<video>`·`<audio>` 는 헤더를 못 붙이므로 `POST /api/files-session` 이 주는 쿠키(`iamceo_files_<포트>`, `Path=/files`, HttpOnly, SameSite=Strict, 접속 코드에서 파생해 `/api` 에 통하지 않음)로 받는다. `?t=` 는 받지 않는다. `DELETE /api/files-session` 이 쿠키를 지운다. 래스터 이미지·영상·오디오만 inline, html·svg·xml 을 포함한 나머지는 attachment. `no-store`, `no-referrer`. 화면의 내려받기는 헤더로 받아 저장한다), `WS /ws?t=<접속 코드>`
접근: 설정된 host 에만 listen(기본 127.0.0.1 + Tailscale IP가 있으면 그 주소. `hosts`를 안 적었으면 Tailscale 이 늦게 올라와도 30초 안에 그 주소를 연다). 요청 IP가 127.0.0.1·::1·100.64.0.0/10·fd7a:115c:a1e0::/48 이외면 403(`hosts`에 LAN을 넣으면 그 대역 허용, `iamceo setup --hosts lan`). 화면 파일(HTML·JS)도 같은 검사를 거친다. 비교는 상수 시간. `Origin`이 있으면 Host 와 같아야 한다. Host 는 IP·localhost·설정한 hosts·점 없는 이름·`.local`·`.ts.net` 만 받는다(DNS 리바인딩 차단). 페이지에는 CSP(`script-src 'self'`, `img-src 'self' data: blob:`, `frame-src 'self' blob:`)를 건다. WS 는 15초마다 `ping` 을 보내고, 화면은 45초 조용하면 소켓을 새로 잇는다.

### 3.1 연결 상태

`Project.connection`·`ProjectSummary.connection`은 `{ok,reason:'runner_off'|'backend_down'|'archived'|null,detail}`다. 보관 아님이고 실행 켜짐과 core availability가 충족되거나 살아 있는 직접 CLI가 있어야 한다. 서버는 주기적으로, 입력 직전에 다시 확인한다. 연결 게이트는 메시지·결재 답·재전송·프로젝트 첨부를 409로 막고 화면도 같은 사유를 보인다. `ask`·`todo`·`post` 같은 세션 도구와 대표의 할 일 체크는 별도다. 보관 중에는 세션을 자동으로 깨우지 않는다.

core가 응답해도 각 CLI의 trust/auth/권한 창이나 상태 미보고로 멤버 입력이 보류될 수 있다. 코어 설치·연결 진단과 모델 로그인 성공은 같은 뜻이 아니다. 서버 재시작의 delivering 또는 PTY 응답 손실은 `delivery_unknown`으로 보류하며 재시도 틱이 자동 재전송하지 않는다. 오래된 herdr/headless 세션은 `legacy_session`으로 보류하고 명시적 전환 전에는 새 core를 열지 않는다.

### 3.2 웹 아티팩트
`FileDoc.kind`: document·artifact·image·pdf·table·code·video·audio·file. 저장값이 없는 옛 행은 첨부·본문으로 계산한다(`fileKindOf`). table·code 는 1MB 이하면 `body` 에 원문이 있고, 첨부로도 받는다(.txt 는 예전처럼 body 만). 아티팩트는 대표가 실행을 눌러야 칸을 만든다(자동 선택·주소 복원에서도 돌지 않는다, 이 창에서 한 번 실행한 자료는 다시 묻지 않는다). 그릴 때 `srcdoc` 을 쓰지 않는다: srcdoc 문서는 부모 페이지의 CSP(`script-src 'self'`)를 물려받아 인라인 스크립트가 안 돈다(Chromium·WebKit 실측). 대신 `<iframe sandbox="allow-scripts" src="/artifact-frame">` 을 만들고, 칸이 `{iamceoFrameReady:true}` 를 보내면(`e.source` 확인) `contentWindow.postMessage({iamceoSrcdoc: buildArtifactSrcdoc(html,{title})},'*')`. 문서는 칸마다 한 번만 넣는다. 칸은 `{iamceoHeight:n}`(범위 검사 뒤 높이에 쓴다, 칸 높이를 따라 자라면 멈추고 칸 안 스크롤)·`{iamceoLink:url}`(칸 안에서 누른 바깥 링크, 칸 아래 줄에 보여 주고 대표가 연다)·`{iamceoEscape:true}`(전체 화면 닫기)를 보낸다. 모두 `e.source` 확인 뒤에만 읽는다. 첨부 주소를 칸으로 넘기지 않는다. 전체 화면은 칸을 옮기면 다시 읽히므로 칸을 담은 `<dialog>` 를 `showModal` 로 올린다. 빈 칸은 응답 헤더 `sandbox allow-scripts` 로 불투명 출처에 갇혀 있어 접속 코드·저장소·서버 API 에 닿지 못하고 일반 바깥 요청도 막힌다(`tests/artifact.browser.ts`). WebRTC(STUN UDP, Chromium·WebKit)와 WebKit 의 preconnect 는 CSP 로 막지 못한다(실측). 앞머리에서 `RTCPeerConnection` 을 지우고 `iframe`·`frame`·`link` 를 글에서 이름을 바꾸고 나중에 들어오면 지우는 것은 보조책이다. 관찰자를 피할 그림자 DOM·`document.write` 도 지운다. 남은 길: WebKit 은 스크립트가 넣은 `link` 로 넣는 즉시 TCP 접속한다(실측, 요청 내용 없음, 페이지 쪽에서 막을 수 없음). 열어 본 시각·IP 가 알려질 수 있으므로 민감한 데이터는 아티팩트에 싣지 않는다. 칸이 바깥 주소로 넘어가는 것은 칸의 CSP 가 아니라 페이지의 `frame-src` 가 막는다(`tests/files.browser.ts`).

## 4. 전달 글 형식 (서버만 만든다)
입력 첫 줄의 접두어가 출처다. 사용자가 친 글은 항상 이 접두어 뒤 따옴표 안에 들어가므로 위장할 수 없다. 서버가 글을 넣기 전에 제어문자·제로폭·양방향 문자를 지우고(CR·U+2028 은 줄바꿈으로), 정규화(NFKC)한 줄 머리가 목록·강조·다른 괄호를 씌워도 접두어처럼 보이면 `> `를 붙인다. 직원·총괄이 쓴 여러 줄 본문은 목록으로 막는 대신 줄마다 `> `를 붙인다(직원 보고 본문, `할 일:` 둘째 줄부터). 직원이 쓴 제목·버튼 글·설명은 한 줄로 받고(`ask` 검증) 따옴표를 이스케이프한다. 직원 이름·역할도 한 줄이고 `[ ] " ' \` < >`를 쓸 수 없으며, 직원 이름은 `대표`로 시작하거나 `총괄`·`본사 AI`·`시스템`·`보고`·`서버`일 수 없고 핸들은 `lead`·`root`일 수 없다(store 검증). 첨부 이름은 저장할 때 제어문자·줄바꿈·`[ ] ' \``를 지운다. CLI에 넣기 직전(core terminal.send)에 모든 글을 한 번 더 같은 규칙으로 지운다. 압축 focus·지금 일·다음은 한 줄이다.
- 대표가 총괄·본사 AI에게: `[대표] "<글>"` + 첨부마다 `첨부: <절대경로> (<mime>, <크기>)` + `#<message id>`
- 대표가 @직원에게 직접: `[대표 직접] "<글>"` + 첨부 + `#id`
- 결재 답: `[대표 답(원문) '<카드 제목>'] "<버튼 글>"(<desc>) 메모 "<메모>" #<decision id>`. 묶음이면 `(묶음 추천대로)`. 자유 답이면 `"<메모>"`만.
- 내 할 일 완료: `[대표] '<제목>' 했음 #<todo id>`
- 총괄 지시: `[총괄] <화면 이름>에게\n사용자 요청(원문, 서버 확인): "<인용>"\n[대표 글 전문 #<id>: "<전문>"]\n할 일: <글>` (할 일의 둘째 줄부터는 `> `). 인용이 그 프로젝트 대표 메시지·결재 메모에 낱말 경계까지 그대로(공백 정규화) 있으면 `서버 확인`, 아니면 `총괄 인용(미확인): "..."`. 인용이 글의 일부면 전문 줄이 함께 가고, 글 전체면 인용 줄 끝에 `#<id> <시각>`이 붙는다. 버튼 글과 4자 미만 인용은 맞아도 `사용자 요청(문맥 확인 필요): "<인용>"`이다: 무엇에 대한 답인지 글만으로 알 수 없으므로 버튼 글이면 `결재 #<id> '<카드 제목>'에서 고른 답 <시각>`을 함께 싣는다. 버튼의 설명은 직원이 쓴 글이라 근거가 아니다. 승인 대조는 처리된 결재 전부를 본다(화면의 최근 50건 제한을 받지 않는다).
- 직원 보고: `[보고 <이름>] <kind>: <제목>\n> <본문>` (총괄에게)
- 시스템: `[시스템] <글>`
- 과거 herdr 어댑터의 긴 글(>1500자)은 `~/.iamceo/inbox/<직원 id>/<id>.md`에 쓰고 경로를 넣는다. 첨부도 그 폴더로 이어(하드 링크) 경로를 알린다. herdr 칸은 이 폴더만 `--add-dir`로 연다.
- 과거 herdr 어댑터는 `#id` 로 끝나지 않는 글 끝에 `#dl_<난수>` 표지를 붙인다. 시간 초과 때 이번 글이 들어갔는지 가른다.

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
| `compact` | core 자동 압축 미지원. 터미널의 CLI 명령 사용 안내 |
| `terminalControl` | token lease 아래 명시적 사람 input·whitelist key 전달 |

Unix socket plain NDJSON JSON-RPC를 사용하고 요청마다 연결을 새로 연다. timeout·연결 종료·잘못된 응답 뒤 mutating 요청을 재생하지 않는다. transport write를 시도한 send의 실패는 uncertain이며 재전송 불가다. JSON-RPC 오류는 upstream `data.kind`·hint를 보존한다. 폴링은 단절 후 다시 읽지만 run/send를 재생하지 않는다.

`terminal.run`은 argv/cwd/env/멤버 라벨과 `no_parent:true,outlive_parent:true,no_notify:true,keep:false,rm:false,wait:false`를 쓴다. core 자체는 IAMCEO 전용 HC_SESSION·소켓·XDG 폴더를 쓰고, 제공자에게는 원래 HOME·XDG 설정을 넘긴다. Claude는 시스템 프롬프트·MCP 파일을 추가하고 Codex는 호출별 TOML override를 쓴다. MCP bearer는 Codex argv 대신 환경·env_vars로 보낸다. 사용자 CLI 도구·스킬·프로젝트 설정을 비활성화하지 않는다.

자동 입력은 항상 `force:false`다. idle은 `if:idle`을 사용한다. upstream generation 1의 if 열거형은 idle/working뿐이라 done은 해당 조건 없이 보낸다. 읽은 상태·초안과 외부 raw attach 사이의 경쟁을 원자적으로 제거할 수는 없으며, 앱의 직접 조작 lease는 알려진 앱 입력과 자동 전달을 분리한다. Codex plain screen의 고정 placeholder와 같은 문장을 직접 친 경우도 구별할 수 없다.

상태는 OSC 7501 root record와 turn counter만 읽는다. 미보고/알 수 없음은 입력을 막는 상태다. working→blocked counter 증가만으로 턴을 완료하지 않는다. 완료된 root idle/done/error 전환은 빈 finalText의 turn_end를 낸다. 업무 완료·최종 답변은 MCP post/file 등으로 기록하며 화면을 복원한 가짜 보고를 만들지 않는다.

새 Codex native ID는 모르면 null이다. 살아 있는 core pane은 재결합하되 pane을 잃었고 native ID도 모르면 자동 새 대화 실행을 거부한다. 멤버 소유권 라벨이 다른 터미널에는 입력·종료하지 않는다. 이전 track의 늦은 폴링은 새 세션 상태를 덮어쓰지 않는다.

수동 조작은 5분 token lease다. claim과 동일 token 갱신, input·key, release를 제공한다. input만 명시적 사람 요청 아래 `force:true`를 쓸 수 있다. 앱·서버의 일반 자동 전달이나 MCP 에이전트 도구에서 승인 bypass로 쓰지 않는다. lease 종료·만료 시 자동 펌프가 다시 진행할 수 있고 멤버 종료·제공자 교체 시 token은 무효다.

과거 headless의 `claude -p`, herdr의 `agent.prompt`·화면 지우기·transcript 복원·background 화면 탐지는 회귀 코드에만 남아 있다. core 계약에 적용하지 않는다.

## 6. Orchestrator 규칙

- 메시지·결재 답·총괄 지시·직원 보고·시스템 알림은 `deliveries`를 거쳐 `enqueue → pump(member) → Runner.send`로 간다. wake=false는 다음 깨움에 함께 보내고 작업 중이면 줄을 선다. 보관·실행 꺼짐·연결 끊김·blocked·수동 lease는 보류 사유다.
- `send` 성공은 PTY paste+Enter 수락을 뜻한다. 모델이 작업을 끝냈거나 결과가 저장됐다는 뜻이 아니다. started:false도 이미 전달된 입력일 수 있어 자동으로 다시 보내지 않는다. 불확실한 전달은 `delivery_unknown`으로 계속 보류한다.
- core turn_end는 대기열 진행 신호다. 열린 업무 결재가 남으면 waiting, 아니면 idle로 정리한다. working/idle만으로 업무 완료를 보고하지 않는다. core는 자동 compact나 transcript 기반 최종 답변 복원을 제공하지 않는다.
- 대표 메시지는 지정 직원 또는 총괄·본사 AI에 전달한다. 총괄 시작은 중복 요청을 합치고 시작 실패도 메시지를 잃지 않게 보류한다. `@직원` 직접 지시는 총괄에게 사실만 알린다. 보관 프로젝트에는 세션 시작·깨움·입력을 거부한다.
- 결재 답은 물은 직원에게 wake=true, 총괄에게 wake=false다. `expectedVersion`이 다르면 409다. 같은 답 재전송은 멱등이고 다른 답으로 덮어쓰기는 거부한다. 연결 실패를 답변 성공으로 꾸미지 않는다.
- post의 완료·막힘·질문은 총괄을 깨우고 진행·알림은 다음 깨움에 간다. `ask_close`·`todo_close`의 소유권·사용자 원문 대조는 §7과 같다. 할 일 체크를 되돌리면 나가지 않은 알림은 거두고 이미 전달된 완료는 정정한다.
- team_add는 유일한 핸들·이름과 역할·규칙·선택한 CLI로 독립 core 세션을 만든다. team_assign은 대기열과 병렬 선호를 다룬다. Claude는 Ultracode 명령 응답을 확인하고 Codex는 native subagent 기능과 다음 과제의 선호 지시를 쓴다. 실제 병렬 실행 수를 보장하지 않는다.
- 잠재우기·종료는 명시적 액션이다. 일하는 턴·열린 결재·큐를 무시하는 force는 대표가 선택했을 때만 쓴다. core는 소유권이 확인된 terminal만 종료하고 idle 초안·알 수 없는 composer를 지우지 않는다.
- 서버 재시작은 기존 core holder를 보존하고 멤버·프로젝트·CLI 라벨로 재결합한다. 단절이나 start timeout만으로 동일 CLI를 다시 띄우지 않는다. 기존 herdr/headless 세션은 원본을 보존하고 `legacy_session`으로 보류한다. 자동 backend 전환이나 이전 프로세스 일괄 종료를 하지 않는다.
- production backend는 core로 고정된다. 제공자 기본은 Claude, 프로젝트의 chiefCli와 각 Member.cli는 독립적으로 저장된다. 같은 멤버의 제공자를 바꾸어도 멤버 id·역할·업무·대화·결재·파일은 유지한다.
- 제공자·살아 있는 세션의 모델/effort 변경은 working·blocked·처리 중·불확실한 전달이 있으면 409다. 새 CLI 인자를 먼저 검증하고, 이전 종료 확인 뒤 `member_session_history`를 남기고 MCP 토큰·session_generation을 회전한다. 이전 종료 실패면 제공자와 토큰을 유지하고, 이후 새 시작 실패면 오류로 남긴다.
- 같은 Claude 설정 변경은 native UUID를 `--resume`한다. 제공자 변경이나 native ID를 모르는 Codex 설정 변경은 새 세션이다. 역할·현재 일·다음 일·프로젝트 상황과 board 확인 안내를 넣는다. 같은 대화 문맥·숨은 추론을 다른 제공자에게 옮기는 기능은 없다.
- 모델은 멤버별 덮어쓰기, 적용 가능한 직급 값, CLI 기본 순이다. Claude용 직급 모델·staff 설정을 Codex에 자동 상속하지 않는다. 설정은 실행 인자로 적용하고 사용자 전역 CLI 기본값을 수정하지 않는다. null 모델·effort는 기본으로 돌아간다.
- 판 정리는 기존 주기·변경 여부·연결·총괄 idle·중복 지시 조건을 따르며 정리만 하려고 새 총괄을 띄우지 않는다. 명시적 tidy는 총괄에게 지시를 넣는다. 업무 완료 보고는 MCP에 남긴다.
- 직접 `iamceo join`한 CLI는 실행기 밖이다. 서버가 그 프로세스를 띄우거나 입력하지 않고 wait/ask 롱폴로 지시·답을 받는다. 과거 herdr adopt·release는 새 core 편입 수단이 아니다.

## 7. 에이전트 도구 (`POST /agent/tool` `{name,args}`, Bearer 멤버 토큰. `GET /agent/tools` → 그 멤버의 도구 목록)
공통: `status{now,next?}` · `ask{title,detail,options?[{k,label,desc}],rec?,group?,file_id?,images?[]}` · `post{kind:'완료'|'진행'|'막힘'|'알림',title,body?,file_ids?,decision_id?}` · `file{title,summary?,path?|content?|html?,images?[]}`(html: 자체 완결 HTML 2MB 이하 → kind=artifact, path 는 확장자로 종류를 정한다: .html 아티팩트, csv·tsv 표, json·코드·로그·txt 코드, pdf, 이미지, 영상, 오디오) · `todo{title,detail?}`(대표가 할 일)
총괄 추가: `team_add{name,role,handle?,cwd?,first_instruction?,user_quote?,parallel?}`(cwd 는 프로젝트 폴더 안, 데이터 폴더·비밀 폴더는 거부. 밖은 대표 글에 그 경로가 있고 user_quote 로 대조될 때만) · `team_assign{member,text,user_quote?,parallel?,urgent?,attachments?}`(attachments: 그 프로젝트 대표 메시지의 첨부 id, 받는 직원 폴더로 잇는다) · `team_compact{member,focus?}` · `team_sleep{member,force?}` · `team_resume{member,first_instruction?}` · `team_close{member}` · `roster{}` · `project_now{text}` · `work_set{id?,sec,title,detail?,who?}` · `work_list{}` · `work_remove{id}` · `board{}`
본사 AI 추가: `project_create{name,cwd,goal?,start_conductor?}` · `project_list{}` · `board{}`
판 정리(공통, 직원은 자기가 올린 결재·할 일만): `ask_close{id,kind:'decided'|'obsolete',reason,user_quote?}`(decided 는 user_quote 필수, 대표 글로 확인되어야 닫힌다) · `todo_close{id,outcome:'done'|'dropped',reason}`. `board` 는 열린 결재(id·제목·물은 직원·올린 날짜·묶음)·안 끝난 할 일(id·제목·부탁한 사람·날짜)·진행판(id·칸·제목·갱신 날짜, 완료는 최근 10)·지금 상황·지난 판 정리 시각. 도구 설명에 '대신 답하지 않는다(추측으로 닫지 않는다, 애매하면 둔다)'를 쓴다.
직접 띄운 CLI 추가: `wait{timeout_sec?}` — 밀린 지시 받기.
`member` 인자는 핸들 또는 화면 이름.
**파일 경로(`file`의 path·images, `ask`의 images)**: 심볼릭 링크를 따라간 경로가 작업 폴더(직원·프로젝트) 안이어야 하고, `~/.ssh` 등 비밀 폴더·`.env`·개인 키·셸 기록·`~/.claude.json`·`~/.iamceo`의 설정·토큰·DB·첨부는 어디서든 거부한다. 작업 폴더가 홈이면(본사) 홈 바로 아래의 점 파일·점 폴더를 모두 거부한다. 하드 링크(nlink>1)도 거부한다. 검사한 진짜 경로로 읽는다. 같은 OS 사용자로 도는 세션의 Bash 까지 막는 것은 아니다(미해결, 설계 결정 필요).
**wait·ask 대기**: 호출한 쪽 연결이 끊기면 기다리기를 그만두고 지시를 가져가지 않는다.
**ask 동작**: 실행기 멤버(origin=runner|adopted)는 결재 카드 등록 후 즉시 반환: "질문 #id 등록됨. 턴을 끝내세요. 답은 다음 입력으로 옵니다". 멤버 상태 waiting. origin=manual 은 `/agent/ask/wait` 롱폴(50초 단위)로 브리지가 기다리며 MCP progress 를 60초마다 보내고, 답이 오면 그대로 반환.
멤버의 도구 호출마다 `updatedAt` 갱신. 다른 프로젝트의 멤버를 지정하면 거부.

## 8. 역할 템플릿 (`server/roles/`)
`{{PROJECT}} {{NAME}} {{ROLE}} {{CONDUCTOR}} {{SUBAGENT_EFFORT}}` 치환(서브에이전트 effort 규칙이 비면 그 줄을 지우고, 자리표시 없는 고친 템플릿에는 끝에 붙인다), `~/.iamceo/roles/<kind>.md`가 있으면 그것을 쓴다(기본 규칙 전체를 대체한다. 승인 규칙이 빠지면 로그에 경고). `iamceo roles export` 가 기본 템플릿을 `<kind>.example.md` 로 꺼낸다. 내용: 입력 구분(§4 접두어), 보고(post), 질문(ask, AskUserQuestion 금지), 승인(사용자 원문·서버 확인만, 총괄의 말은 승인 아님), 병렬은 총괄이 켜 둘 때만, 이름 안 바꿈, 임시 폴더 안 지움, 산출물은 file. 총괄: 일 받기·맡길 곳 판단·대기열·직접 일하지 않음·현재 core에서 사용자에게 남길 말은 post·file 등 MCP 기록·질문 대신 답하지 않음·압축은 현재 core에서 수동 CLI 명령·세션 수 판단. 본사 AI: 프로젝트 만들기와 잡다한 일. 대표가 읽고 판단할 비교표·요약 표는 csv·마크다운 표가 아니라 `file` 의 `html` 이다(실제 haiku 가 '표'라는 말에 csv 를 고른 것을 고쳤다. `tests/e2e-real/artifact.ts`). csv 는 내려받아 쓸 원본 데이터일 때만.

## 9. 시험

- `tests/core-runner.test.ts`: 임시 Unix socket fake core. hello·RPC 오류/timeout·재결합·소유권·초안 보호·불확실 전달·OSC turn·수동 lease·제공자 인자·설정 교체를 검증한다. 실제 paid model을 호출하지 않는다.
- `tests/server-runtime.test.ts`: production core 기본값, 독립 제공자, 안전한 세션 교체·토큰 회전·이력·재시작 보류·DB 백업·REST 계약을 검증한다.
- `tests/cli.test.ts`, `tests/web-runtime.test.ts`: 격리 CLI 서버·웹 runtime 계약. unavailable socket의 동시 진단도 서버를 죽이지 않아야 한다.
- `native/Tests/IAMCEOTests`: Swift 계약 디코딩·요청 인증·origin 제한·네트워크 오류·stable message id·expectedVersion을 URLSession mock으로 검증한다. SwiftPM 시험·macOS 빌드·iOS simulator 빌드는 별도 검증이며 physical device 설치·서명·공증은 별도 작업이다.
- 실제 PTY 시작·daemon 재시작 검증은 임시 IAMCEO_HOME·HC_SESSION·HC_SOCKET·XDG 경로에서만 한다. 사용자 원래 daemon·터미널을 끄거나 전역 CLI를 업데이트하지 않는다. CLI 시작만 검증하는 시험에 자동 유료 prompt를 넣지 않는다.
- 기존 `tests/fixtures/fake-claude.ts`, herdr fixture, headless·adopt 브라우저 시험은 과거 어댑터의 회귀 시험이다. 현재 core UX·수명·상태 계약의 근거로 사용하지 않는다.
- 기존 `tests/e2e-real/*`는 명시적으로 승인된 paid-model 작업에서만 실행한다. 일반 unit/integration/typecheck에 포함해 유료 작업을 유발하지 않는다.

## 10. 클라이언트와 미구현 경계

SwiftUI macOS·iOS와 React 웹은 같은 REST 도메인을 사용한다. 네이티브 앱은 홈·결재함·팀·대화·자료·설정에서 실제 서버 데이터를 읽고 메시지·결재·할 일·프로젝트·멤버·제공자·모델 변경을 보낸다. 명시적 `--demo`만 읽기 전용 예시 데이터이며 일반 접속 실패에 demo나 로컬 성공을 보여 주지 않는다.

- 네이티브는 전경에서 3초 간격 bootstrap/project 폴링, 열린 터미널에서 2초 screen 폴링을 사용한다. 백그라운드에서는 상태 폴링을 멈춘다. 네이티브 WebSocket·APNs·백그라운드 푸시 알림은 구현하지 않았다. 웹의 기존 `/ws`와 서버의 선택적 macOS osascript 알림은 별개다.
- 네이티브 인증은 origin별 Keychain과 요청 Bearer다. 원격 origin은 HTTPS, loopback은 HTTP도 허용한다. iPhone loopback을 Mac 주소로 취급하지 않는다. foreign-origin 첨부 URL과 HTTP redirect에는 접속 코드를 보내지 않는다.
- 네트워크 acknowledgement를 잃은 채팅은 동일 message id로 명시적 재시도한다. 결재 expectedVersion과 서버 409로 오래된 결정을 덮어쓰지 않는다. 프로젝트 전환은 이전 요청을 취소하고 늦은 응답을 세대로 구분한다.
- 터미널은 현재 plain screen과 수동 input·키를 제공한다. 직접 조작은 서버 lease를 먼저 잡고 자동 전달을 멈춘다. 실패를 숨기거나 승인 선택을 자동으로 결정하지 않는다. 전체 VT attach 렌더러나 네이티브 streamed terminal 구현은 아니다.
- macOS의 `이 Mac에서 시작`은 사용자가 선택할 때 번들 daemon/core 또는 명시적 QA 경로로 로컬 launchd 준비를 시도한다. 기존 다른 서비스·포트·인증 문제를 덮어쓰지 않는다. iOS는 실행 중인 Mac의 HTTPS origin에 접속한다. 앱 시작·빌드만으로 daemon을 설치하지 않는다.
- macOS 대상은 로컬 서비스 실행을 위해 App Sandbox를 끄고, iOS는 플랫폼 sandbox를 쓴다. `scripts/build-native.ts`는 local ad-hoc macOS 번들을 만들며 developer signing·공증·App Store 배포 완료를 뜻하지 않는다. core vendor signature는 보존한다.
- 웹은 홈·결재함·팀·대화·자료, 멤버 제공자 설정·runtime 진단을 제공한다. 이전 herdr/headless 선택·adopt 중심 화면은 현재 경로가 아니다. 초안·메모는 실패나 연결 끊김 때문에 지우지 않는다.
- 웹 아티팩트는 §3.2의 수동 실행 sandbox다. 네이티브 아티팩트는 비영속 WKWebView에서 JavaScript·외부 요청을 막은 제한된 미리보기다. 두 렌더러의 기능을 동일하다고 약속하지 않는다.

시스템 Liquid Glass는 지원 OS에서 쓰고 이전 OS에는 material fallback이 있다. 네이티브 플랫폼·실행·빌드 조건은 [native/README.md](../native/README.md)에 적는다. 최종 배포·서명·알림·백그라운드 동기화는 구현과 검증을 마친 경우에만 기능으로 문서화한다.
