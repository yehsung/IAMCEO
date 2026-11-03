# IAMCEO 구현 계약

타입: `shared/types.ts`. herdr 소켓 스키마: `docs/herdr-schema.json`.

## 0. 모든 작업자 공통 규칙 (어기면 라이브 작업이 깨진다)
- **실제로 쓰는 herdr 서버를 건드리지 않는다.** 개발·시험 중에 `$HERDR_SOCKET_PATH`·`~/.config/herdr/herdr.sock`(평소 쓰는 서버)으로 쓰기 요청(prompt·start·close·split·send_keys·rename 등)을 보내지 않는다. 시험은 `IAMCEO_HERDR_SOCKET`을 격리된 시험 서버로 지정해서만 한다(§9).
- 사용자의 실제 `~/.iamceo`를 시험에 쓰지 않는다. 시험은 `IAMCEO_HOME=<임시폴더>`.
- 단위·통합 시험은 실제 `claude`를 부르지 않는다(`tests/fixtures/fake-claude.ts`). 실제 호출은 E2E 단계에서 `--model haiku`로만.
- 임시 폴더는 지우지 않는다(`rm -rf` 금지 — 승인 창으로 멈춘다). `mktemp -d`로 새로 만들고 남겨 둔다.
- git push·외부 게시 금지. launchd 등록은 지시받은 작업자만.
- 자식 프로세스 환경에서 `HERDR_*`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`를 지운다(안 지우면 훅이 라이브 herdr 칸 상태를 오염시킨다). `IAMCEO_*`만 추가한다. stdin은 항상 닫는다(`claude -p`가 3초 기다린다).
- 화면 글은 한국어, 이모티콘 금지, 심플. 자기 담당 파일만 고친다. 다른 담당의 코드가 필요하면 이 문서의 계약대로 가정하고, 계약이 모자라면 최소로 넓혀 최종 보고에 적는다.

## 1. 구조
```
web(React) ──REST·WS──▶ server(Bun) ──▶ SQLite ~/.iamceo/iamceo.db, 첨부 ~/.iamceo/uploads
                          ▲    │
   MCP stdio ── iamceo mcp ┘    └─ Orchestrator ─▶ Runner: herdr 어댑터 | headless 어댑터
   (각 세션 안에서 실행, /agent/* 로 서버 호출)
```
파일 담당:
| 경로 | 내용 |
|---|---|
| `server/config.ts` | `~/.iamceo/config.json`(accessCode, port, hosts, claudeBin, herdrSocket), `IAMCEO_HOME`, `IAMCEO_HERDR_SOCKET`, `IAMCEO_CLAUDE_BIN`, `IAMCEO_PORT` |
| `server/db.ts` | 스키마·마이그레이션(bun:sqlite, WAL) |
| `server/bus.ts` | WsEvent 방송 |
| `server/store.ts` | 도메인 읽기·쓰기 전부(클래스 `Store`). 쓰고 나면 bus 로 방송. SQL 은 여기만 |
| `server/http.ts` | REST·WS·정적·접근 제어(`startServer(ctx)`) |
| `server/files.ts` | 업로드 저장, HEIC→JPEG(sips), 안전한 경로 |
| `server/orchestrator.ts` | 전달 펌프, 턴 종료 처리, 압축 판단, 띄우기·잠재우기·다시 열기, 승인 근거 확인 |
| `server/agent-tools.ts` | 도구 정의(JSON 스키마)와 처리기. `POST /agent/tool` |
| `server/roles/*.md` | conductor·worker·root 시스템 프롬프트 템플릿 |
| `server/runner/types.ts` | `Runner` 인터페이스 |
| `server/runner/headless.ts` | `claude -p` 어댑터 |
| `server/runner/herdr-client.ts`, `herdr.ts` | 소켓 클라이언트, herdr 어댑터 |
| `server/runner/transcript.ts` | 세션 jsonl 꼬리 읽기(마지막 글·usage) |
| `bin/iamceo.ts` | CLI: `serve`, `setup`, `mcp`, `join`, `status`, `open`, `import`, `service install|uninstall` |
| `bin/mcp-bridge.ts` | MCP stdio 서버(공식 SDK). 도구 목록·호출을 서버로 중계 |
| `shared/artifact-kit.ts` | 아티팩트 스타일 키트·문서 조립(`buildArtifactSrcdoc`) |
| `web/` | React 앱, `web/src/glass/`(유리), `web/src/screens/` |
| `scripts/import-artifact.ts` | 아티팩트 덤프 JSON → 프로젝트 |
| `tests/` | `bun test` |

## 2. DB
`shared/types.ts`의 타입과 1:1. 테이블 projects, members, decisions, todos, work, messages, files, attachments, deliveries, activity(직원당 최근 500만 유지), settings(kv). JSON 필드(options, images, attachments)는 TEXT. `project_settings_v4` 는 프로젝트별 설정을 전체 설정으로 합칠 때 옛 값을 남겨 둔 표다(마이그레이션만 읽는다. 저장한 전역 권한과 프로젝트 값 중 가장 엄격한 것을 적고 바뀌면 대표에게 알린다. 프로젝트 모델이 하나로 모이면 직급 기본값의 빈 칸으로 올리고, 저장된 값과 다르면 직원별 지정으로 남긴 뒤 알린다). `files.html` 은 아티팩트 원본(FileDoc 에 싣지 않는다), `members.applied_config` 는 세션에 실제로 들어간 설정이다. `members.adopted_info` 는 편입 표시(JSON, `turnedOnRunner`)다. 판 정리: `decisions.close_kind`(decided·obsolete, AI 가 닫았을 때만)·`close_reason`·`close_quote`·`closed_by`·`closed_at`, `todos.outcome`(done·dropped)·`close_reason`·`closed_by`·`updated_at`, `projects.board_tidied_at`(마지막 판 정리). 멤버 `token`(MCP 인증, 화면에 안 나감) 컬럼 포함. id는 접두어+짧은 난수(`p_`, `m_`, `d_`, `t_`, `w_`, `msg_`, `f_`, `a_`, `dl_`). 시각은 ISO UTC. 첫 실행 때 본사 프로젝트(`id='hq'`, name '본사', cwd=홈, runnerEnabled=true)를 만든다.

## 3. REST (`/api`, 헤더 `Authorization: Bearer <접속 코드>`, 쿠키 없음)
- `GET /api/health`(인증 없음) → `{ok,version}`
- `GET /api/bootstrap` → Bootstrap(`urls`: 서버가 듣는 주소 목록, `cli`: 터미널에서 CLI 를 부르는 명령). 답하기 전에 실행기를 다시 본다
- `GET /api/projects/:id/state` → ProjectState
- `GET /api/projects/:id/messages?before=<at>&limit=` → Message[]
- `POST /api/projects`(CreateProjectReq) → Project · `PATCH /api/projects/:id`(PatchProjectReq). 실행 방식·권한·모델 필드는 없다. 보내면 400
- `POST /api/projects/:id/conductor/start` → Member (총괄 띄우기, runnerEnabled 를 true 로)
- `POST /api/projects/:id/messages`(SendMessageReq; id 는 클라이언트 UUID로 멱등) → Message. 연결되어 있지 않으면 409(§3.1)
- `POST /api/uploads?project=<id>&target=<직원 id>`(multipart, file, 50MB) → Attachment. `project` 를 주면 연결을 먼저 본다(409). 끝까지 올린 뒤에 보내기에서 거부당하지 않게 화면은 붙인다
- `POST /api/projects/:id/messages` 는 같은 id 면 그 글을 돌려주고, 그 글이 끝내 실패(failed)한 대표 글이면 같은 글을 다시 넣는다(대화 줄이 늘지 않는다).
- `GET /api/projects/archived` → Project[] · 보관: `PATCH archived:true` 는 일하는 중·승인 창 앞·열린 결재·안 한 할 일이 있거나 넘겨받은 칸을 끝낼 수 없으면(쓰던 글) 409, 칸 상태를 확인할 수 없으면(소켓) 503 이다. 넘겨받은 칸을 모두 먼저 확인한 뒤에야 끝낸다(확인 뒤 칸이 달라져 거부되면 먼저 끝낸 칸은 잠든 채로 남고 저절로 깨지 않는다). 보관되면 세션을 잠재운다. 보관 중에는 어떤 세션도 깨우거나 띄우지 않는다: 전달은 `held(archived)` 로 멈추고, 다시 열기·총괄 시작·편입·`runnerEnabled:true` 는 409. `archived:false` 로 꺼내면 멈춘 전달을 다시 민다(설정의 보관함).
- `GET /api/projects/:id/decisions?status=done|open&before=<at>&limit=` → Decision[]. 기본 done(최근 답한 순, `before` 는 그 answeredAt 앞). open 은 전부(오래된 순, before·limit 무시) · `GET /api/decisions/:id` → Decision
- `POST /api/decisions/:id/answer`(AnswerReq) 멱등 → Decision. 새 답인데 연결되어 있지 않으면 409(같은 답 재전송은 그대로 돌려준다)
- `POST /api/todos/:id/done` `{done:boolean}` → Todo. 연결과 상관없이 된다. 체크를 풀면 AI 의 정리 이유도 지운다
- `POST /api/decisions/:id/reopen` → Decision. AI 가 `ask_close` 로 닫은 카드만(아니면 409). 결재할 항목으로 돌아가고(`reopenNote` 에 닫은 이유), 물은 직원·총괄에게 wake=false 로 알린다
- `POST /api/projects/:id/tidy` → TidyResult(`{already}`). 총괄(본사는 본사 AI)에게 판 정리 지시를 넣는다. 연결되어 있지 않으면 409, 총괄이 없거나 잠들었으면 띄운다. 이미 기다리거나 도는 정리가 있으면 `already:true`
- `GET /api/files/:id/artifact` → `{html}`(인증. kind=artifact 만, 아니면 404). 원본을 서버 출처의 문서로 내주지 않는다
- `GET /artifact-frame`(인증 없음, 빈 문서) 아티팩트를 그리는 격리 칸(§3.2)
- `PATCH /api/members/:id`(PatchMemberReq: `modelOverride`, `effortOverride`, null 이면 직급 기본) → Member. 직접 띄운 세션은 400
- `GET /api/members/:id/activity?limit=` → Activity[] · `GET /api/members/:id/screen` → `{text}` (herdr 칸 화면, 없으면 빈 글)
- `GET /api/members/:id/approval` → `{approval: ApprovalPrompt|null}`. herdr 칸의 권한 승인 창을 읽은 그대로(번역 없음). 승인 창 앞이 아니거나 승인 창으로 알아보지 못하면(폴더 신뢰 창·바이패스 경고 창·그 밖의 선택 창) null 이고 화면은 터미널 안내로 돌아간다 · `POST /api/members/:id/approval`(AnswerApprovalReq `{fingerprint, option, note?}`) → `{ok:true}`. 누르기 직전에 다시 읽어 fingerprint 가 다르면 409(창이 바뀜, 화면은 다시 읽어 보이고 저절로 누르지 않는다). 승인 창 앞이 아니거나 키가 먹지 않아도 409, 없는 선택지는 400, headless 는 501. `note` 는 거절 선택지일 때만 보내고, 창을 닫은 뒤 그 직원에게 `[대표 직접]` 으로 간다. 대표 화면 전용이다(에이전트 도구 없음)
- `POST /api/members/:id/sleep`(`{force?}` 는 대표가 '그래도 재우기'를 눌렀을 때만) · `POST /api/members/:id/resume|compact`(resume 은 실행이 꺼진 프로젝트면 409) · `POST /api/members/:id/interrupt` · `POST /api/members/:id/close`(직접 띄운 세션만)
- `GET /api/herdr/agents` → LiveAgent[] · `GET /api/projects/:id/adopt/preview?pane=<칸>` → AdoptPreview(읽기만) · `POST /api/projects/:id/adopt`(AdoptReq) → Member(일하는 중·승인 창 앞·세션 ID 없음·입력칸 못 찾음은 409) · `POST /api/members/:id/release` → ReleaseResult(편입 해제) · `POST /api/members/:id/reopen-with-tools` → Member
- `PUT /api/settings`(SettingsPatch) → Settings. `ranks` 는 고친 칸만 보내도 된다. 실행 방식은 일하는 직원이 있으면 409(§6)
- `GET /files/<attachment id>/<name>` 첨부(인증: 헤더 또는 첨부 쿠키. `<img>`·`<video>`·`<audio>` 는 헤더를 못 붙이므로 `POST /api/files-session` 이 주는 쿠키(`iamceo_files_<포트>`, `Path=/files`, HttpOnly, SameSite=Strict, 접속 코드에서 파생해 `/api` 에 통하지 않음)로 받는다. `?t=` 는 받지 않는다. `DELETE /api/files-session` 이 쿠키를 지운다. 래스터 이미지·영상·오디오만 inline, html·svg·xml 을 포함한 나머지는 attachment. `no-store`, `no-referrer`. 화면의 내려받기는 헤더로 받아 저장한다), `WS /ws?t=<접속 코드>`
접근: 설정된 host 에만 listen(기본 127.0.0.1 + Tailscale IP가 있으면 그 주소. `hosts`를 안 적었으면 Tailscale 이 늦게 올라와도 30초 안에 그 주소를 연다). 요청 IP가 127.0.0.1·::1·100.64.0.0/10·fd7a:115c:a1e0::/48 이외면 403(`hosts`에 LAN을 넣으면 그 대역 허용, `iamceo setup --hosts lan`). 화면 파일(HTML·JS)도 같은 검사를 거친다. 비교는 상수 시간. `Origin`이 있으면 Host 와 같아야 한다. Host 는 IP·localhost·설정한 hosts·점 없는 이름·`.local`·`.ts.net` 만 받는다(DNS 리바인딩 차단). 페이지에는 CSP(`script-src 'self'`, `img-src 'self' data: blob:`, `frame-src 'self' blob:`)를 건다. WS 는 15초마다 `ping` 을 보내고, 화면은 45초 조용하면 소켓을 새로 잇는다.

### 3.1 연결 상태
`Project.connection`·`ProjectSummary.connection` = `{ok, reason: 'runner_off'|'backend_down'|'archived'|null, detail}`. ok = 보관 아님 && ((runnerEnabled && 전역 실행기 쓸 수 있음) || 살아 있는(offline·asleep·error 아닌) 직접 띄운 세션 있음). 전역 실행기는 `Settings.backend`(선택 전이면 headless), 본사도 같다. `detail` 은 그대로 화면에 보여 줄 글이다. 서버는 5초마다, 그리고 입력을 받기 직전에 실행기를 다시 본다. 달라지면 `projects`와 해당 `project` 이벤트로 알린다(실행기가 돌아오면 보류된 것도 민다). 메시지·결재 답·재전송은 ok=false 면 409 + detail. ok=true 여도 실행기가 안 돌면(직접 띄운 세션 덕에 ok) 살아 있는 직접 세션을 받는 쪽으로 지정한 것만 받는다. 에이전트의 `ask`·`todo`·`post` 와 내 할 일 체크는 막지 않는다. 단 보관된 프로젝트의 `ask` 는 답할 사람이 없어 도구 오류로 돌려준다.
일회성 정리(시작할 때, 멱등 `store.releaseHeldBeforeConnection`): `runner_disabled` 로 보류된 결재 답은 결재를 open 으로 되돌리고 전달 항목을 지운다. 대표 글은 `delivery=failed`, `deliveryNote='연결 전이라 전달되지 않았습니다'`(같은 id 로 재전송 가능). 그 답을 가리키는 총괄 알림도 거둔다. 실행이 꺼진 프로젝트에서 전달 항목 없이 멈춘 말·받을 사람 없는 답도 같다. 가져온 못 읽은 말은 제외한다(총괄을 시작하면 전달). 다시 연 결재는 직전 답·메모·이유를 `lastChoice`·`lastNote`·`reopenNote` 로 남겨 카드에 보인다. 편입이 켠 실행(`runner_by_adopt`)에서는 멈춘 말·답·완료가 총괄을 저절로 띄우지 않는다. 대표가 총괄을 시작하거나 말을 보낼 때 나간다.
### 3.2 아티팩트
`FileDoc.kind`: document·artifact·image·pdf·table·code·video·audio·file. 저장값이 없는 옛 행은 첨부·본문으로 계산한다(`fileKindOf`). table·code 는 1MB 이하면 `body` 에 원문이 있고, 첨부로도 받는다(.txt 는 예전처럼 body 만). 아티팩트는 대표가 실행을 눌러야 칸을 만든다(자동 선택·주소 복원에서도 돌지 않는다, 이 창에서 한 번 실행한 자료는 다시 묻지 않는다). 그릴 때 `srcdoc` 을 쓰지 않는다: srcdoc 문서는 부모 페이지의 CSP(`script-src 'self'`)를 물려받아 인라인 스크립트가 안 돈다(Chromium·WebKit 실측). 대신 `<iframe sandbox="allow-scripts" src="/artifact-frame">` 을 만들고, 칸이 `{iamceoFrameReady:true}` 를 보내면(`e.source` 확인) `contentWindow.postMessage({iamceoSrcdoc: buildArtifactSrcdoc(html,{title})},'*')`. 문서는 칸마다 한 번만 넣는다. 칸은 `{iamceoHeight:n}`(범위 검사 뒤 높이에 쓴다, 칸 높이를 따라 자라면 멈추고 칸 안 스크롤)·`{iamceoLink:url}`(칸 안에서 누른 바깥 링크, 칸 아래 줄에 보여 주고 대표가 연다)·`{iamceoEscape:true}`(전체 화면 닫기)를 보낸다. 모두 `e.source` 확인 뒤에만 읽는다. 첨부 주소를 칸으로 넘기지 않는다. 전체 화면은 칸을 옮기면 다시 읽히므로 칸을 담은 `<dialog>` 를 `showModal` 로 올린다. 빈 칸은 응답 헤더 `sandbox allow-scripts` 로 불투명 출처에 갇혀 있어 접속 코드·저장소·서버 API 에 닿지 못하고 일반 바깥 요청도 막힌다(`tests/artifact.browser.ts`). WebRTC(STUN UDP, Chromium·WebKit)와 WebKit 의 preconnect 는 CSP 로 막지 못한다(실측). 앞머리에서 `RTCPeerConnection` 을 지우고 `iframe`·`frame`·`link` 를 글에서 이름을 바꾸고 나중에 들어오면 지우는 것은 보조책이다. 관찰자를 피할 그림자 DOM·`document.write` 도 지운다. 남은 길: WebKit 은 스크립트가 넣은 `link` 로 넣는 즉시 TCP 접속한다(실측, 요청 내용 없음, 페이지 쪽에서 막을 수 없음). 열어 본 시각·IP 가 알려질 수 있으므로 민감한 데이터는 아티팩트에 싣지 않는다. 칸이 바깥 주소로 넘어가는 것은 칸의 CSP 가 아니라 페이지의 `frame-src` 가 막는다(`tests/files.browser.ts`).

## 4. 전달 글 형식 (서버만 만든다)
입력 첫 줄의 접두어가 출처다. 사용자가 친 글은 항상 이 접두어 뒤 따옴표 안에 들어가므로 위장할 수 없다. 서버가 글을 넣기 전에 제어문자·제로폭·양방향 문자를 지우고(CR·U+2028 은 줄바꿈으로), 정규화(NFKC)한 줄 머리가 목록·강조·다른 괄호를 씌워도 접두어처럼 보이면 `> `를 붙인다. 직원·총괄이 쓴 여러 줄 본문은 목록으로 막는 대신 줄마다 `> `를 붙인다(직원 보고 본문, `할 일:` 둘째 줄부터). 직원이 쓴 제목·버튼 글·설명은 한 줄로 받고(`ask` 검증) 따옴표를 이스케이프한다. 직원 이름·역할도 한 줄이고 `[ ] " ' \` < >`를 쓸 수 없으며, 직원 이름은 `대표`로 시작하거나 `총괄`·`본사 AI`·`시스템`·`보고`·`서버`일 수 없고 핸들은 `lead`·`root`일 수 없다(store 검증). 첨부 이름은 저장할 때 제어문자·줄바꿈·`[ ] ' \``를 지운다. 칸·프로세스에 넣기 직전(herdr prompt, headless stdin)에 모든 글을 한 번 더 같은 규칙으로 지운다. 압축 focus·지금 일·다음은 한 줄이다.
- 대표가 총괄·본사 AI에게: `[대표] "<글>"` + 첨부마다 `첨부: <절대경로> (<mime>, <크기>)` + `#<message id>`
- 대표가 @직원에게 직접: `[대표 직접] "<글>"` + 첨부 + `#id`
- 결재 답: `[대표 답(원문) '<카드 제목>'] "<버튼 글>"(<desc>) 메모 "<메모>" #<decision id>`. 묶음이면 `(묶음 추천대로)`. 자유 답이면 `"<메모>"`만.
- 내 할 일 완료: `[대표] '<제목>' 했음 #<todo id>`
- 총괄 지시: `[총괄] <화면 이름>에게\n사용자 요청(원문, 서버 확인): "<인용>"\n[대표 글 전문 #<id>: "<전문>"]\n할 일: <글>` (할 일의 둘째 줄부터는 `> `). 인용이 그 프로젝트 대표 메시지·결재 메모에 낱말 경계까지 그대로(공백 정규화) 있으면 `서버 확인`, 아니면 `총괄 인용(미확인): "..."`. 인용이 글의 일부면 전문 줄이 함께 가고, 글 전체면 인용 줄 끝에 `#<id> <시각>`이 붙는다. 버튼 글과 4자 미만 인용은 맞아도 `사용자 요청(문맥 확인 필요): "<인용>"`이다: 무엇에 대한 답인지 글만으로 알 수 없으므로 버튼 글이면 `결재 #<id> '<카드 제목>'에서 고른 답 <시각>`을 함께 싣는다. 버튼의 설명은 직원이 쓴 글이라 근거가 아니다. 승인 대조는 처리된 결재 전부를 본다(화면의 최근 50건 제한을 받지 않는다).
- 직원 보고: `[보고 <이름>] <kind>: <제목>\n> <본문>` (총괄에게)
- 시스템: `[시스템] <글>`
- 긴 글(>1500자)은 herdr 어댑터에서 `~/.iamceo/inbox/<직원 id>/<id>.md`에 쓰고 경로를 넣는다. 첨부도 그 폴더로 이어(하드 링크) 경로를 알린다. herdr 칸은 이 폴더만 `--add-dir`로 연다.
- herdr 어댑터는 `#id` 로 끝나지 않는 글 끝에 `#dl_<난수>` 표지를 붙인다. 시간 초과 때 이번 글이 들어갔는지 가른다.

## 5. Runner 인터페이스 (`server/runner/types.ts`)
```ts
export interface RunnerMember { id:string; projectId:string; handle:string; name:string; cwd:string; sessionId:string|null; paneId:string|null; model:string|null; effort:Effort|null; subagentModel:string|null; permissionMode:PermissionMode; kind:MemberKind }
export interface StartOpts { systemPromptFile:string; mcpConfigFile:string; resume:boolean; firstPrompt?:string; herdrTabId?:string|null; projectName:string }
export type SendResult = { ok:true } | { ok:false; reason:"busy"|"blocked"|"input_busy"|"down"|"gone"|"error"; detail?:string; retryable:boolean };
export type RunnerEvent =
  | { type:"status"; memberId:string; status:"working"|"idle"|"blocked"|"gone" }
  | { type:"turn_end"; memberId:string; finalText:string; isError:boolean; errorText?:string; noOutput?:boolean } // noOutput: 입력을 읽기 전에 오류로 끝남
  | { type:"activity"; memberId:string; kind:ActivityKind; text:string }
  | { type:"context"; memberId:string; pct:number }
  | { type:"subagents"; memberId:string; count:number }
  | { type:"session"; memberId:string; sessionId:string }
  | { type:"compacted"; memberId:string }
  | { type:"pane"; memberId:string; paneId:string; tabId?:string };
export interface Runner {
  readonly kind: Backend;
  available(): Promise<{ok:boolean; detail?:string}>;
  /** 세션을 만들거나 이어서 연다. headless 는 sessionId 만 정한다. */
  start(m:RunnerMember, o:StartOpts): Promise<{sessionId:string|null; paneId:string|null; tabId?:string|null}>;
  /** 턴을 시작한다(글 넣기). 한 직원당 동시에 한 턴. */
  send(m:RunnerMember, text:string, o:StartOpts, urgent?:boolean): Promise<SendResult>;
  isBusy(memberId:string): boolean;
  compact(m:RunnerMember, focus:string, o:StartOpts): Promise<SendResult>;
  setParallel(m:RunnerMember, on:boolean, o:StartOpts): Promise<SendResult>; // /effort ultracode on|off
  interrupt(m:RunnerMember): Promise<void>;
  /** 잠재우기: headless 는 프로세스만 정리, herdr 는 칸 닫기(세션 파일은 남음) */
  stop(m:RunnerMember): Promise<void>;
  screen(m:RunnerMember): Promise<string>;
  on(cb:(e:RunnerEvent)=>void): void;
  shutdown(): Promise<void>;
}
```
### headless
`claude -p (--session-id <uuid> | --resume <uuid>) --mcp-config <f> --append-system-prompt-file <rules> --permission-mode <mode> --permission-prompts none --allowedTools mcp__iamceo --add-dir <직원 inbox> --output-format stream-json --verbose [--model m] [--effort e] -n <name>`, 환경 `CLAUDE_CODE_SUBAGENT_MODEL`·`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`(서브에이전트 값이 있을 때), cwd=m.cwd. 글은 stdin 으로 쓰고 닫는다(인자로 넘기면 `ps` 로 보이고 약 1MB 에서 E2BIG. `/compact`·`/effort` 도 같은 길로 동작, 2.1.316 실측). 실측: session-id/resume·MCP·`/compact`(stream 에 `system/compact_boundary`)·`/effort ultracode on`·`auto` 모드 모두 동작(Claude Code 2.1.316). stream-json: `system/init`(session_id), `assistant`(message.content[].type text|tool_use, message.usage: input_tokens+cache_read_input_tokens+cache_creation_input_tokens 가 현재 문맥), `user`(tool_result), `result`(subtype, is_error, result, modelUsage.<model>.contextWindow), `system/hook_*`는 무시. 문맥 % = 문맥 토큰/contextWindow. 턴 끝에 `turn_end`. `result.permission_denials` 가 있으면(승인할 사람이 없어 막힌 도구) 활동에 오류로 남긴다. Agent/Task 도구 시작·끝으로 subagents 수를 센다. 동시 턴 상한 `maxConcurrentTurns`는 Orchestrator 가 지킨다. 서버 재시작 시 돌던 자식은 고아가 되지 않게 `detached:false`, 종료 때 SIGINT→SIGTERM. SIGKILL·충돌은 자식에게 전해지지 않으므로 턴마다 `~/.iamceo/run/<직원>.turn.json`(pid·세션)을 남기고, 복구 때 명령줄이 그 세션의 것이면 프로세스 나무째 끝낸다(`reapOrphans`).
### herdr
소켓(NDJSON, **연결당 요청 1개**, 서버가 답하고 닫음; `events.subscribe`만 유지). 프로젝트마다 워크스페이스 하나(`workspace.create` cwd·label, 포커스 안 뺏음) + 그 안 탭에 칸을 만든다: 위 줄 직원, 아래 총괄. `agent.start`(name=handle, kind=claude, pane, args: `--session-id`/`--resume`, `-n`, `--append-system-prompt-file`, `--mcp-config`, `--permission-mode`, `--allowedTools mcp__iamceo`, `--add-dir <직원 inbox>`, `--model`, `--effort`, 바이패스 모드면 `--settings <파일>`). 서브에이전트 환경변수는 `agent.start` 에 넘길 곳이 없어 칸을 만들 때(`pane.split`·`workspace.create` 의 `env`) 준다. 바이패스 첫 경고 창은 대표가 전체 설정에서 고른 모드라 `skipDangerousModePermissionPrompt` 설정 파일로 건너뛴다. 그래도 뜨면 활동에 알린다. agent.start 는 셸에 글자를 치므로 있는 칸을 다시 쓰지 않고 항상 새로 나눈다. 칸 번호는 herdr 재시작 뒤 재사용되므로 세션 일치(보고가 없으면 어댑터가 준 이름까지)로만 결합한다. 세션이 맞아도 서버의 칸이어야 붙고 닫는다: 이름이 어댑터가 준 것(핸들 또는 핸들-프로젝트표지)이거나, 이름이 없으면 번호가 DB 와 같아야 한다(실측: 되살린 칸은 이름이 사라지고 번호는 유지된다. 붙을 때 이름을 다시 준다). 대표가 복사 명령으로 연 칸은 붙지도 닫지도 않고 오류로 알리며, 그 칸을 닫을 때까지 깨우지 않는다. 다른 직원이 쥔 칸에도 붙지 않는다. 추적 중인 칸도 넣기 전과 동기화 때 다시 확인해 남의 에이전트면 gone 이다. DB 의 탭 번호는 그 탭에 이 프로젝트의 세션이 있을 때만 믿는다(이름 없이 만든 워크스페이스의 이름은 폴더 이름이라 근거가 못 된다). herdr 가 되살린 칸은 인자가 없으므로(`claude --resume <id>`) 넣기 전에 `pane.process_info` 로 `--mcp-config` 를 확인해 없으면 전체 인자로 다시 연다(넘겨받은 세션 제외). 세션 기록을 이어 읽어 도구 활동과 서브에이전트 수를 낸다. 상태는 `events.subscribe`(`pane.agent_status_changed` 등) + 60초마다 `session.snapshot`. 글 넣기 `agent.prompt`: 일하는 중이면 urgent 아닐 때 `busy`, `agent_blocked`→`blocked`. IAMCEO 로 보낸 말은 넣는다. 넣기 전 `pane.read`(visible, `format: ansi`, `strip_ansi: false`)로 입력칸을 읽는다(`inputText`·`inputLooksEmpty`, 흐린 글씨 SGR 2 인 다음 말 추천·안내 글은 친 글이 아니다). 입력칸을 못 찾으면(셸 모드 `!`, 선택 창, 다른 프로그램) `input_busy`(글자가 명령이나 선택이 된다). 남은 글이 있으면 실수로 남은 것으로 보고 지운 뒤 넣는다: 쉬는(idle·done, 턴 밖) 세션에만 `agent.send_keys ['ctrl+c']` 를 한 번 누르고 다시 읽어 비었으면 넣는다. 일하는 중(urgent 포함)이면 Ctrl+C 가 턴을 끊으므로 누르지 않고 `input_busy`. 2.1.316 실측: Ctrl+C 는 글이 있으면 여러 줄도 한 번에 지우지만 약 0.8초 종료 창(`Press Ctrl-C again to exit`)을 열고, 그 안에 빈 칸에서 또 누르면 세션이 끝난다(400ms 간격은 끝남, 1000·1300ms 는 산다). 그래서 칸마다 마지막으로 누른 시각을 기억해 2초 안에는 다시 누르지 않고, 종료 안내가 떠 있으면 누르지 않으며, 눌렀는데 안 비면 곧바로 또 누르지 않고 `input_busy`(재시도)다. Ctrl+U 는 커서 줄만 지우고 Esc 한 번은 안 지워 쓰지 않는다. 흐린 추천만 있으면 키 없이 넣는다(글을 치면 추천이 사라진다). `timeout`은 안 들어갔다는 증거가 아니다 — 화면에서 `#id`를 찾아 판단, 없을 때만 같은 규칙(쉬면 남은 글을 지우고, 입력칸을 못 찾거나 일하는 중이면 넣지 않음)으로 한 번 재시도. 슬래시 명령의 무음은 일 글을 넣기 전에 푼다. 턴 끝 판단: working→idle/done 전이 때 `transcript.ts`로 마지막 글·usage 를 읽어 `turn_end`와 `context`를 낸다. `screen()`= `pane.read` visible. 프로토콜 번호가 22가 아니면 HerdrInfo.warning 을 채우되 계속 시도. 소켓 끊기면 재접속 + `down`.
어댑터는 소켓 경로를 설정에서만 받는다(`$HERDR_SOCKET_PATH` 무시). 시험 소켓이 아닌데 `IAMCEO_TEST=1` 이면 예외를 던진다(안전장치).

## 6. Orchestrator 규칙
- 모든 입력은 `deliveries`를 거친다. `enqueue → pump(member)`. wake=false 는 다음 깨움에 앞쪽에 묶는다.
- pump: runnerEnabled=false 또는 멤버 없음 → `held(runner_disabled)`. asleep → 먼저 resume. 일하는 중(urgent 아님) → queued. idle·waiting → 쌓인 것을 한 글로 묶어 send. blocked→`held(blocked)`, 상태 바뀌면 재시도. input_busy(입력칸을 못 찾음, 일하는 중이라 남은 글을 못 지움 등) → 60초 안에서 재시도 뒤 held. 성공하면 delivered, 관련 Message.delivery·Decision.status 갱신.
- 보내기 직전 contextPct ≥ compactAtPct 면 먼저 `compact`(focus = `이어갈 일: now · next · 대기 질문 · 대기열 앞부분`), compacted 뒤 전달. 일하는 중인 세션은 끊지 않는다.
- 병렬 설정(`/effort`)이 일시적으로 실패하면 지시를 되살리고 일도 미룬다. 끝내 안 되면 총괄에게 알리고 일을 내보낸다.
- turn_end: 직원에 열린 결재가 있으면 status=waiting, 아니면 idle → 큐 pump.
  - 이번 턴에 post 를 안 부른 **직원**: finalText 를 `(자동)` 표시로 대화에 남기고 총괄에게 보고 전달.
  - 이번 턴에 post 를 안 부른 **총괄·본사 AI**: finalText 를 그대로 대화에 올린다(대표에게 하는 말).
  - isError: Member.lastError, status=error, 대화에 시스템 글. 입력을 읽기 전에 끝났으면(noOutput) 그 묶음을 대기로 되돌려 시간을 두고 다시 보낸다. 횟수는 전달마다 따로 세고, 3번을 넘으면 메시지는 failed, 결재는 다시 연다(대표에게 돌아간다). 돌려줄 대표 글이 없는 전달(보고·지시·알림·할 일 완료)은 실패시키지 않고 보류해 간격을 넓혀 다시 보낸다. 전달 자체가 재시도 불가로 실패할 때도 같다.
- 대표 메시지: 대상 없으면 총괄(본사는 root). 총괄이 없고 runnerEnabled 면 자동으로 띄운다. 띄우는 동안 온 전달은 줄만 서고 한 번만 띄운다. 띄우기가 실패하면 말은 `held(backend_down)`로 남고 틱이 다시 시도한다. 받을 사람이 없는 결재 답·할 일 완료도 같다. @직원이면 `[대표 직접]`, 총괄에게 wake=false 로 사실만 알림. 보관된 프로젝트에는 보낼 수 없다(409).
- 결재 답: 물은 직원에게 wake=true, 총괄에게는 wake=false 알림. 직원 status 는 전달되면 working. 답한 카드를 다시 고르면 거부(409).
- post(kind): 완료·막힘·질문 → 총괄 wake=true, 진행·알림 → wake=false. (직접) 일이면 kind 앞과 대화 제목에 표시만. 서버가 넣지 않았는데 herdr 칸이 일을 시작하면 대표가 터미널에 직접 친 일로 친다.
- 내 할 일 체크 해제: 아직 안 나간 글은 거두고, 마지막으로 실제 나간 글이 '했음'이면 `[대표] '<제목>' 아직 안 했음`을 보낸다.
- 판 정리: 틱마다 프로젝트를 본다. `Settings.boardTidyHours`(기본 6, 0 끔)가 지났고(`board_tidied_at`, 없으면 총괄이 뜬 때부터), 그 뒤 결재·할 일·진행판·대화가 바뀌었고, 보관 아님·실행 켜짐·연결됨·총괄이 이미 떠 있고(origin=runner) 쉬는 중(idle·waiting, 턴 없음)·기다리는 판 정리 지시 없음이면 총괄에게 `[시스템] 판 정리: ...` 를 wake=true 로 넣는다. 정리하려고 총괄을 띄우지 않는다. 넣을 때와 그 턴이 끝날 때 `board_tidied_at` 을 적는다. 판 정리(와 시스템 알림)만 받은 턴에 post 가 없으면 마지막 글은 대화에 올리지 않고 활동에 남긴다.
- ask_close: 열린 결재만. 직원은 자기 카드만. decided 는 user_quote 를 §4 의 인용 대조로 확인하고 버튼 글·4자 미만은 거부한다. 닫으면 물은 직원에게 `[시스템] 결재 #id 가 닫혔습니다: 이유` 를 wake=false 로, 직접 띄운 CLI 는 askWaiters 를 깨워 `ask` 대기를 푼다(결과 글에 이유). 직원이 닫았으면 총괄에게 wake=false 알림. 물은 직원이 waiting 이고 쉬면 idle 로.
- todo_close: 안 끝난 할 일만. 직원은 자기가 부탁한 것만. done·dropped 모두 done=1 이라 안 한 할 일 수에서 빠지고, dropped 는 홈에서 빠진다. 부탁한 직원에게 wake=false 알림(할 일에 이어져 대표가 체크를 풀면 '아직 안 했음'이 간다).
- team_close: 대기 중인 '했음'은 총괄에게 넘기고, 나가지 않은 지시는 응답으로 돌려준다. 닫는 동안 전달 펌프는 그 직원을 건너뛰고, 띄우는 중에 닫혔으면 띄운 칸을 닫는다.
- team_add: 핸들·이름 유일, 시스템 프롬프트 파일 생성 후 runner.start, firstInstruction 있으면 전달. 깨어 있는 직원(asleep·offline 제외)이 maxAwakeWorkers 를 넘으면 총괄에게 `[시스템]`으로 잠재울 후보(대기·큐 없음·열린 결재 없음, 오래된 순)를 알린다. 잠재우기는 총괄 판단.
- team_sleep: 일하는 중·열린 결재·큐 있으면 거부(`force`로만). 상태 asleep, sessionId 유지, 끊긴 턴은 비운다. team_resume: `--resume`. 세션이 정말 없을 때만(세션 없음 오류, 기록 파일 없음) 같은 핸들로 새 세션 + 마지막 일을 첫 지시에. 시간 초과·소켓 끊김은 세션을 그대로 두고 틱이 다시 시도한다. 실행이 꺼진 프로젝트에서는 깨우지 않는다.
- team_assign: 일하는 중이면 대기열(응답에 위치 표시). 대기열에 있는 동안 팀 카드에 보임. parallel 인자가 현재와 다르면 setParallel 먼저.
- 서버 재시작: 남은 headless 자식을 끝낸다. working 이던 headless 멤버는 idle 로(턴은 끊김, 대화에 시스템 글), 큐 재개. herdr 멤버는 snapshot 으로 재결합(sessionId→pane), 소켓이 안 닿으면 틱이 다시 시도한다. 칸이 승인 창 앞이면 그 상태를 지키고, 꺼진 사이 턴이 끝났으면 입력 뒤에 쓰인 마지막 글을 보고로 살린다(이미 post 했으면 안 함, 도구를 부르다 끊긴 글은 보고가 아니다). 일하던 칸이 사라졌거나 끝난 글이 없으면 시스템 글을 남기고 총괄을 깨운다. 턴이 이어지는 중이면 이번 턴의 post 여부를 되살려 (자동) 보고가 겹치지 않게 한다. 넣다가 죽은 전달은 세션 기록·화면에서 표지를 찾아 있으면 받은 것으로 친다(같은 입력이 두 번 들어가지 않게).
- 설정은 전체 하나다(`Settings`). 프로젝트에는 이름·폴더·보관·실행 켜짐·지금 상황만 남는다.
- 실행 방식 변경(`PUT /api/settings`): 어느 프로젝트든 일하는 세션이 있으면 거부(409). 넘겨받은 칸을 끝낼 수 없어도(선택 창 등으로 입력칸을 못 찾음, 승인 창) 아무것도 바꾸지 않고 거부(409). 없으면 이전 실행기의 칸을 닫고(실행기가 정말 죽어 있을 때만 활동에 남기고 넘어간다. 살아 있는데 시간 초과 등으로 못 닫으면 거부한다) 다음 전달 때 새 방식으로 세션을 잇는다. 바꾸는 동안 전달은 서고 새 세션은 거부되며, 끝나면 줄 선 것이 나간다. 끝낸 넘겨받은 칸은 잠든 상태가 되어 깨울 때 서버 세션이 된다. 병렬은 다음 일 전에 되살린다. 멤버는 `Member.backend` 로 시작한 실행기를 기억해 살아 있는 세션은 그 실행기로 계속 다루고, 새로 띄우거나 다시 열 때 전역 방식을 따른다.
- 권한: bypassPermissions(기본)·auto·default 3종. headless 는 다음 턴부터, herdr 칸은 다음에 칸을 열 때부터. headless 는 늘 `--permission-prompts none` 이라 default 면 승인이 필요한 도구가 막히고 활동에 남는다. herdr 는 승인 창(blocked).
- 직급별 모델·effort: `Settings.ranks`(manager 부장=총괄·본사 AI, lead 팀장=직원 세션, staff 직원=서브에이전트, null=CLI 기본). `Member.modelOverride·effortOverride` 가 이긴다. team_add 에 모델 인자는 없다(대표가 정한다). staff 모델은 환경변수로 강제, staff effort 는 역할 템플릿의 `{{SUBAGENT_EFFORT}}` 규칙으로 넣는다(`CLAUDE_CODE_EFFORT_LEVEL` 은 세션까지 덮어 쓰지 않는다).
- 설정이 바뀌면: headless 는 다음 턴부터 자동. herdr 는 서버가 띄운 세션이 쉴 때(입력칸 규칙 그대로: 일하는 중·승인 창·입력칸을 못 찾으면 미루고, 남은 글은 지운다) 칸을 닫고 `--resume` 으로 새 인자·환경으로 다시 연다. 기록은 이어지고, 병렬은 세션에만 있는 값이라 다음 일 전에 되살린다. 명령줄로 확인하고 `applied_config` 에 적는다. `/model`·`/effort` 를 칸에 넣지 않는다: 2.1.316 실측으로 사용자 전체 기본값(`~/.claude/settings.json`)까지 바뀐다("saved as your default for new sessions"). 3번 실패하면 활동에 남기고 그 값은 포기한다(일은 막지 않는다. 값이 또 바뀌면 다시 시도). 넘겨받은 세션은 대표가 쓰던 칸이라 닫지 않고, 잠든 세션과 함께 깨울 때 전체 인자로 들어간다.
- 직접 띄운 CLI: 도구 호출이면 일하는 중, `wait` 면 대기, 5분 조용하면 대기, 30분 조용하면 안 보임. 화면에서 명부에서 뺄 수 있다.
- adopt: 기존 칸을 멤버로 등록(origin=adopted), 규칙 전문을 첫 지시로 보낸다. 규칙은 시스템 프롬프트에 없으므로 compact 뒤 다시 보낸다. **사용자가 화면에서 명시적으로 눌렀을 때만.** 칸은 대표의 것이다: 옮기지도(`pane.move` 는 번호를 바꾸고 대표가 쓰는 다른 도구의 탭 구조를 깬다) 이름을 바꾸지도 않고 세션 ID 로 알아본다(재시작·herdr 재시작·대표가 칸을 옮겨도 따라간다. 칸에서 `/clear` 등으로 세션이 바뀌면 그 칸을 놓는다). 프로젝트 탭 번호에도 쓰지 않고, 이 세션을 프로젝트 탭의 근거로 삼지 않는다. 떠 있는 세션에는 MCP 를 붙일 수 없어 화면은 직원 자리로만 받는다. claude 세션만 받고, 일하는 중·승인 창 앞·세션 ID 없음·입력칸을 못 찾는 화면, 이미 직원 자리인 세션(잠든 직원 포함, 전 프로젝트)은 거부(409, `adoptRefusal`). 전체 실행 방식이 herdr 가 아니면 거부(409). 넘겨받은 세션의 모델·effort·권한은 대표가 쓰던 그대로 둔다. 입력칸에 쓰던 글이 있으면 지우고 `/add-dir` 와 규칙을 넣는다(입력칸을 못 찾으면 미룬다). 미리보기는 칸 화면과 함께 다른 지휘자 흔적(명령줄의 worker-rules, 칸 이름, 기록의 SendMessage·오케스트라 스킬)·다른 폴더·입력칸 글을 경고한다(막지는 않는다).
- 잠재우기(넘겨받은 칸): 칸을 닫으면 대표의 배치가 무너지므로 쉬고 있을 때만 입력칸에 남은 글을 지우고 `/exit` 를 넣어 Claude 만 끝내고 칸은 셸로 남긴다. 미리 보기(`checkStop`)는 읽기만 하고 남은 글은 막지 않는다. 입력칸을 못 찾거나(선택 창 등) 승인 창이면 force 여도 아무것도 바꾸지 않고 409(칸이 프로젝트 탭에 있어도 같다). 깨우면 프로젝트 탭의 새 칸에 전체 인자로 떠 origin=runner 가 되고, 도구가 생겼다고 알린다(대표가 칸에서 그 세션을 다시 열어 거기 붙었으면 그대로 adopted). `reopen-with-tools` 는 이 둘을 잇는다.
- 편입 해제(`release`): `wasAdopted` 직원만. 대화·세션은 그대로 두고 명부에서 뺀다. 대표의 칸이면 칸을 두고, 쉴 때 입력칸에 남은 글을 지우고 규칙이 풀렸다고 한 번 알린다(입력칸을 못 찾으면 알리지 않는다). 이미 서버 칸으로 옮겼으면 그 칸을 닫고 이어 열 명령을 돌려준다. 이 편입이 켠 실행은 남은 세션이 없으면 끈다. 총괄의 team_close 도 넘겨받은 칸은 끝내지 않고 손만 뗀다. 해제한 세션은 다시 편입할 수 있다.

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
`{{PROJECT}} {{NAME}} {{ROLE}} {{CONDUCTOR}} {{SUBAGENT_EFFORT}}` 치환(서브에이전트 effort 규칙이 비면 그 줄을 지우고, 자리표시 없는 고친 템플릿에는 끝에 붙인다), `~/.iamceo/roles/<kind>.md`가 있으면 그것을 쓴다(기본 규칙 전체를 대체한다. 승인 규칙이 빠지면 로그에 경고). `iamceo roles export` 가 기본 템플릿을 `<kind>.example.md` 로 꺼낸다. 내용: 입력 구분(§4 접두어), 보고(post), 질문(ask, AskUserQuestion 금지), 승인(사용자 원문·서버 확인만, 총괄의 말은 승인 아님), 병렬은 총괄이 켜 둘 때만, 이름 안 바꿈, 임시 폴더 안 지움, 산출물은 file. 총괄: 일 받기·맡길 곳 판단·대기열·직접 일하지 않음·사용자에게 할 말은 post 또는 턴 마지막 글·질문 대신 답하지 않음·압축은 서버가 자동·세션 수 판단. 본사 AI: 프로젝트 만들기와 잡다한 일. 대표가 읽고 판단할 비교표·요약 표는 csv·마크다운 표가 아니라 `file` 의 `html` 이다(실제 haiku 가 '표'라는 말에 csv 를 고른 것을 고쳤다. `tests/e2e-real/artifact.ts`). csv 는 내려받아 쓸 원본 데이터일 때만.

## 9. 시험
- `tests/fixtures/fake-claude.ts`: `claude -p` 인자·stdin·stream-json 흉내. 환경변수로 시나리오(도구 호출은 실제 브리지를 안 거치고 HTTP 로 직접).
- herdr 통합 시험: `Bun.spawn(["herdr","--session","iamceo-test-<난수>"],{terminal:{cols:160,rows:50,data(){}}})`로 격리 서버를 띄운다(실측: 소켓 `~/.config/herdr/sessions/<name>/herdr.sock`, 클라이언트를 죽여도 서버 유지, `herdr --session <name> server stop`으로 정리). 띄울 때 env 에서 `HERDR_*`를 지운다. 칸 안의 에이전트는 가짜 스크립트나 셸로 시험한다.
- 전체 통합: `tests/integrated.browser.ts`. `iamceo import` 로 만든 연결 안 된 프로젝트에서 시작해 게이트 → 총괄 시작 → 결재 2단계 → 결재된 항목 → 홈 할 일 → 자료 아티팩트 → 편입 창 → 설정·직급·직원별 값이 가짜 claude 의 argv·환경변수로 들어가는지까지 한 흐름으로 본다. `IAMCEO_SHOTS=docs/shots` 면 문서용 캡처를 만든다(서버 HOME 도 임시 폴더라 사용자 이름이 안 나온다).
- 실제 모델: `tests/e2e-real/*.ts`(`IAMCEO_E2E_REAL=1`, `--model haiku`). `artifact.ts` 는 직원에게 "두 안 비교표를 자료로 올려"를 시켜 모델이 `file` 의 `html` 로 올리는지 본다.
- 화면 시험: `tests/*.browser.ts`, playwright chromium(DPR 1, 1440×900 / 390×844). `tests/browser.test.ts` 가 파일마다 새 프로세스의 `bun test` 로 돌린다(bun 1.3.14 의 fd 이중 닫기로 같은 프로세스에서는 무작위로 죽는다). 굴절은 Chromium 에서만 보이고, WebKit 헤드리스는 backdrop 을 안 그린다.

## 10. 화면
설치·릴리스는 README 에 적는다. 예시 플레이북은 아직 없다.
**데스크톱**: 왼쪽 프로젝트 목록(본사 + 프로젝트, 배지) + 위쪽 유리 탭(홈·결재함·팀·대화·자료, 기본 진입은 홈, 잘못된 탭도 홈, 물방울 모양 유리 탭) + 모든 화면 아래 고정 입력칸. **폰**: 제목을 눌러 프로젝트 전환, 아래 유리 탭, 입력칸. 본사는 홈·결재함·대화·자료(본사 AI 줄에서 `#/p/hq/team/<id>` 상세로 간다). 탭 배지는 홈=안 한 내 할 일, 결재함=열린 결재+승인 창 앞. 프로젝트 목록·창 제목은 그 합계다. 결재함은 승인 창 앞 세션을 맨 위에 보여 준다.
- 홈: 대표가 오늘 뭘 하면 되나를 3초에 아는 화면. 비어 있는 칸은 그리지 않는다. 연결 안내 · 지금 판 정리(마지막 정리 시각 + 버튼, 연결 게이트대로 잠김) · 지금 상황 · 내가 할 일(한 줄: 체크 + 제목 + 아래 화살표. 줄을 누르면 그 아래로 자세한 내용·요청한 직원·시각이 펼쳐지고 체크와 분리된다. 체크한 줄은 잠시 제자리에 있다가 '완료 N' 접기로 들어가고, 해제하면 위로 돌아온다. AI 가 '필요 없어짐'으로 정리한 할 일은 빠지고, '끝남'으로 정리한 할 일은 완료에 정리 이유와 함께 들어간다) · 결재 대기(건수, 승인 창 앞 직원, 맨 위 3건 → 결재함의 해당 카드) · 팀(상태별 건수, 일하는 직원 3명 → 직원 상세. 본사는 본사 AI 줄) · AI가 곧 할 일(진행 중 + 다음, 각 5건) · 최근 보고 5건(→ 대화) · 최근 자료 3건(→ 자료). 데스크톱은 두 칸, 폰은 한 줄.
- 결재함: 위 세그먼트 '결재할 항목 N' / '결재된 항목 N'. 한 번에 한 쪽만 보이고 주소로 유지된다(`#/p/<id>/inbox`, `#/p/<id>/inbox/done`). 결재 링크(`inbox/<결재 id>`)는 그 결재가 있는 쪽을 연다. 결재할 항목: 승인 대기 + 결정 카드(배경·선택지·설명·권장 표시, 메모, 묶음 추천). 승인 대기는 승인 창 앞 직원마다 이름(→ 직원 상세)과 승인 창(`components/ApprovalPanel.tsx`: 제목·내용(고정폭, 길면 판 안 스크롤)·질문·선택지 원문에 '승인'·'거절'·'이후에도 적용' 표시, 고른 뒤 확인, 거절이면 '직원에게 전할 말(선택)', 다시 읽기)이다. 못 읽으면 터미널에서 풀라는 안내. 선택지를 눌러도 나가지 않는다. 카드 아래 "'<고른 글>'(으)로 결정"과 취소가 나타나고 확인을 눌러야 보낸다. 자유 답·메모만 답도 같고, 묶음은 "묶음 N건 결정"이다. 묶음 확인은 물을 때의 카드에만 가고, 그 사이 카드가 늘면 다시 묻고, 직접 다른 것을 고른 카드는 빠진다. 확인 버튼은 나타난 직후·자리가 밀린 직후의 누름을 받지 않는다. 이번 방문에 답한 카드는 제자리에 남아 보냄 → 받음을 보여 주고 쪽을 옮기면 결재된 항목으로 간다. 결재된 항목: 제목·답·메모·누가·언제·전달 상태, 펼치면 배경, 더 불러오기. 닫힌 카드는 '닫힘 · 이유'와 닫은 이·근거로 든 대표 말을 보이고, AI 가 닫은 카드(`closeKind`)에는 '다시 열기'(결재할 항목으로 돌아감)가 있다. 비면 "결재할 항목이 없습니다" / "결재된 항목이 없습니다".
- 연결 게이트(`components/ConnectGate.tsx`): `connection.ok=false` 또는 소켓이 1.5초 넘게 끊기면 결재 카드의 선택지·메모·확인과 '다시 보내기'를 잠그고, 입력칸 자리에 <detail>(끊김은 "서버 연결이 끊겼습니다")을 보인다. 팀 화면에 총괄 시작 카드가 있으면 runner_off 게이트는 숨긴다. 왼쪽 아래·폰 머리줄의 표시는 "서버 연결됨"으로 AI 연결과 구분한다. runner_off 면 팀 화면으로 가는 버튼이 함께 나온다. 초안·메모·고른 것은 지우지 않는다. 서버의 연결 409 도 같은 문구로 보이고 낙관적으로 그린 줄을 걷고 글을 되돌린다. 첨부는 `?project=&target=`로 올려 먼저 묻는다.
- 팀: 지금 상황, 총괄 카드(직원 수·잠든 직원·문맥), 직원 카드(역할·상태·지금 일·다음·대기열·문맥 %·서브에이전트 수·압축 예정), 접힌 잠든 직원+다시 열기, 직원 상세(실시간 활동, herdr 면 화면, 승인 창 앞이면 결재함과 같은 승인 창, 직접 지시, 압축·잠재우기, `claude --resume <id>` 복사), 진행 중·예정·보류·완료. 직원 상세에 모델·effort 덮어쓰기(기본: 직급 기본값). 넘겨받은 세션은 카드에 '도구 없음'과 '도구 붙여 다시 열기', 상세에 '편입 해제'. runnerEnabled=false 면 "총괄 시작" / "기존 세션 편입" 안내. 편입 창: 무엇이 바뀌나 3줄, 세션 목록·화면·경고, herdr 칸이 아닌 세션은 같은 창에서 `iamceo join` 명령(복사). herdr 로 못 받는 환경이면 그 안내만 나온다. 연결 전에는 직접 지시칸 자리에 연결 안내(ConnectGate)가 나온다. 실행 방식·권한·모델은 전체 설정 하나다.
- 설정(`#/settings`, 하나뿐이다. 옛 `#/settings/<id>` 는 이 주소로 바뀌고 돌아갈 곳만 그 프로젝트로 잇는다): 실행 방식 / 권한 3종 / 직급별 모델·effort 표 / 프로젝트(이름·폴더 고치기, 보관·꺼내기) / 동시 턴·압축 기준·직원 상한·판 정리 주기(끔·3·6·12시간·매일)·맥 알림 / 접속·나가기. 프로젝트 말고는 아래 저장 띠 하나로 함께 저장한다. 새 프로젝트는 이름·폴더·총괄 바로 시작만 묻는다.
- 대화: 시간순 보고+내 말, 전달 상태(보냄·대기·보류 사유·받음), 결재·자료로 이어짐, 마크다운(DOMPurify).
- 자료: 목록+읽기(폰은 목록→상세). 목록은 종류 칩으로 거르고 항목에 종류·요약·작성자·시각·이미지 썸네일을 보인다. 보기는 `FileDoc.kind` 로 고른다(`web/src/components/viewers`): document 마크다운, artifact 격리 칸(§3.2)·전체 화면, image 갤러리·확대, pdf 헤더로 받아 blob 칸(폰은 새 창 버튼), table 정렬·가로 스크롤·앞 500행(body 가 없으면 첨부 앞 512KB 만 받는다, EUC-KR 읽음)·전체 받기, code json 들여쓰기·줄 번호·줄바꿈·복사·앞 5000줄, video·audio 플레이어, file 이름·크기·받기.
- 입력칸: Enter 전송, Shift+Enter 줄바꿈. 터치 기기(`pointer:coarse`)는 Enter 가 줄바꿈이고 보내기 버튼으로 전송한다. 첨부(버튼·붙여넣기·드래그), `@`로 직원 지정(보낸 뒤 대상은 기본으로 돌아간다). 초안·결재 메모는 기기에 저장한다.
- 마크다운: 글 속 HTML 은 글자로 보이고, 이미지는 같은 출처·data: 만 그린다(바깥 주소는 링크). style·class·id 속성은 지운다.
- 상태 색(전 화면 공통, `.status` 한 곳에서 정함): 일함 보라, 내 답 기다림 주황, 대기 회색, 승인 창 앞 빨강 계열, 잠듦 흐림, 오류 빨강.
- 요청 시간 제한: 쓰기 20초, 읽기 30초, 세션을 띄우는 요청 150초, 첨부는 없음. 넘으면 실패로 보이고 재동기화한다.
- 쉬는 직원의 카드는 `지금` 대신 `마지막 일`로 보여 준다. 실행이 꺼진 프로젝트에는 깨우기 버튼이 없다. 실행 끄기·`지금 상황` 고치기는 화면에 두지 않는다(API 는 있다. 지금 상황은 총괄의 `project_now`).
- 화이트 모드: 아직 없다(다크 전용).
- 첫 실행: 접속 코드 입력(기기에 저장) → 실행 방식 고르기(herdr와 함께 / herdr 없이, herdr 감지 표시).
- 새 프로젝트: 이름·폴더. 상단 연결 끊김 띠, 재접속·재동기화.
- 유리 규칙(`web/src/glass/`): 글 많은 판은 `tint`, 굴절은 화면당 판 3개까지, 유리 뒤에 빛(`AuroraField`, `LocalLight`), `.glass`의 ::before/::after 재사용 금지, 조상에 opacity/filter 금지. Tailwind 없이 평범한 CSS. 글꼴은 시스템(Apple SD Gothic Neo 포함), 글꼴 파일을 넣지 않는다.
