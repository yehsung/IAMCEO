# 아키텍처

## 구조

```
브라우저(React) ──REST·WS──▶ 서버(Bun) ──▶ SQLite, 첨부 파일
                              ▲   │
 세션 안의 iamceo mcp ──HTTP──┘   └─ Orchestrator ─▶ 실행기: herdr | headless
                                                       │
                                                  Claude Code 세션
```

- 서버 한 개가 프로젝트 전부를 맡는다. 외부 서비스 없이 내 컴퓨터에서 돈다.
- 세션은 MCP 도구로 서버에 말한다. `iamceo mcp` 는 stdio MCP 서버이고, 도구 목록과 호출을 `/agent/*` 로 중계한다. 멤버마다 토큰이 따로다.
- 화면은 `/api/*` 와 `/ws` 를 쓴다. 쓰기가 끝나면 서버가 WS 로 방송한다.

| 경로 | 내용 |
|---|---|
| `bin/iamceo.ts` | CLI |
| `bin/mcp-bridge.ts` | MCP 브리지 |
| `server/http.ts` | REST·WS·정적 파일·접근 제어 |
| `server/orchestrator.ts` | 전달, 턴 종료, 압축, 띄우기·잠재우기, 승인 근거 확인 |
| `server/agent-tools.ts` | 에이전트 도구 정의와 처리 |
| `server/store.ts`, `db.ts` | 데이터 읽기·쓰기(SQL 은 여기만), 스키마 |
| `server/roles/*.md` | 역할 템플릿 |
| `server/runner/` | 실행기 두 종과 세션 기록 읽기 |
| `web/` | React 화면 |
| `shared/types.ts` | 서버·화면 공통 타입 |
| `shared/artifact-kit.ts` | 아티팩트 스타일 키트와 문서 조립. 서버·화면이 함께 쓰고 빌드본에 함께 묶인다 |

## 화면

탭은 홈·결재함·팀·대화·자료 다섯 개다(본사는 팀 없이 넷). 기본 진입과 잘못된 주소는 홈이다. 데스크톱은 왼쪽 프로젝트 목록과 위 탭, 폰은 아래 탭이다.

- `web/src/screens/Home.tsx`: 내가 할 일(한 줄, 펼침, 체크. AI 가 '필요 없어짐'으로 정리한 할 일은 빠진다), 결재 대기, 팀, AI가 곧 할 일, 최근 보고·자료, 지금 판 정리 버튼(연결 게이트를 따른다). 빈 칸은 그리지 않는다.
- `web/src/screens/Inbox.tsx`: 결재할 항목(`#/p/<id>/inbox`)과 결재된 항목(`#/p/<id>/inbox/done`). 선택지를 눌러도 나가지 않고 확인 버튼을 눌러야 보낸다. 닫힌 카드는 '닫힘 · 이유'를 보이고, AI 가 닫은 카드에는 다시 열기 버튼이 있다.
- `web/src/components/ConnectGate.tsx`: 연결 상태 판단(`useGate`)과 안내 판. 입력을 가진 화면이 읽는다.
- `web/src/components/viewers/`, `ArtifactFrame.tsx`: 자료 종류별 보기.
- `web/src/screens/Settings.tsx`: 전체 설정 하나(`#/settings`). 옛 `#/settings/<id>` 도 이 화면으로 온다.

## 연결 상태

프로젝트의 `connection` 은 `{ok, reason, detail}` 이다. ok 는 보관 아님이고, 실행이 켜져 있으면서 전역 실행기가 살아 있거나 살아 있는 직접 띄운 세션이 있을 때다. 서버가 5초마다, 그리고 입력을 받기 직전에 실행기를 다시 본다. 메시지·결재 답·재전송·첨부는 ok 가 아니면 409 다. 화면은 같은 값으로 잠근다. 세션 쪽 도구와 내 할 일 체크는 막지 않는다.

## 설정

프로젝트별 설정은 없다. `Settings` 한 벌이 전부다(실행 방식, 권한 3종, 직급별 모델·effort, 동시 턴, 압축 기준, 직원 상한, 맥 알림, 판 정리 주기). 옛 프로젝트별 값은 `project_settings_v4` 표에 남겨 둔다. 마이그레이션만 읽고 실행 중에는 읽지 않는다.

세션의 값은 `직원별 덮어쓰기 > 직급 값 > CLI 기본` 순이다(`memberConfig`). headless 는 턴마다 새 프로세스라 다음 턴부터 자동으로 들어간다. herdr 는 서버가 띄운 세션이 쉴 때 칸을 닫고 `--resume` 으로 새 인자·환경으로 다시 열고, 실제 들어간 값을 `members.applied_config` 에 적는다. 칸에 `/model`·`/effort` 를 치지 않는다. 사용자 전체 기본값까지 바뀌기 때문이다. 넘겨받은 세션은 건드리지 않는다.

## 아티팩트

`file` 의 `html`(2MB 이하) 또는 `.html` 경로로 올린 자료다. 원본은 `files.html` 에 두고 `GET /api/files/:id/artifact` 로 받는다. 서버 출처의 문서로 내주지 않는다.

그릴 때 `<iframe sandbox="allow-scripts" src="/artifact-frame">` 을 만들고 칸이 준비되면 `buildArtifactSrcdoc` 으로 조립한 문서를 postMessage 로 넣는다. srcdoc 은 부모의 CSP 를 물려받아 인라인 스크립트가 안 돌아서 쓰지 않는다. 칸은 대표가 실행을 눌러야 만들어진다(WebKit 은 칸과 부모가 메인 스레드를 함께 써서 루프 하나로 앱이 멈춘다). 칸은 불투명 출처라 접속 코드·저장소·서버 API 에 닿지 못하고 일반 바깥 요청도 막힌다. WebRTC(STUN UDP)와 WebKit 의 preconnect 는 CSP 로 막지 못해 앞머리에서 생성자를 지우고 중첩 칸·link 를 없애지만, WebKit 에서 스크립트가 넣은 link 의 접속은 남으므로 민감한 데이터는 싣지 않는다. 칸이 보내는 높이·링크·닫기 신호는 `e.source` 와 값을 확인한 뒤에만 쓴다.

## 전달 흐름

세션에 들어가는 모든 글은 `deliveries` 표를 거친다.

```
대표의 말 · 결재 답 · 할 일 완료 · 총괄 지시 · 직원 보고 · 시스템 알림
  │ enqueue
  ▼
deliveries ─ pump(직원) ─▶ 실행기.send ─▶ 세션
                                           │ 턴 끝
                                           ▼
                             turn_end: 상태 갱신, 다음 전달
```

- **대기**: 일하는 중이면 줄을 선다. 쉬고 있으면 쌓인 것을 한 글로 묶어 보낸다. 잠들어 있으면 먼저 깨운다.
- **보류**: 실행이 꺼졌거나, 실행기가 안 닿거나, 승인 창 앞이거나, 입력칸을 못 찾으면(선택 창 등) 보류하고 나중에 다시 시도한다. 입력칸에 남은 글은 보류 사유가 아니다. 지우고 넣는다.
- **자동 압축**: 보내기 직전 문맥이 기준(기본 70%)을 넘으면 먼저 압축한다. 일하는 중인 세션은 끊지 않는다.
- **깨움**: 완료·막힘·질문 보고는 총괄을 깨운다. 진행·알림은 다음에 깨어날 때 함께 간다.
- **실패**: 입력을 읽기 전에 오류로 끝나면 간격을 두고 다시 보낸다. 3번을 넘으면 대표의 글은 실패로 표시하고, 결재는 다시 연다. 돌려줄 글이 없는 전달은 보류해서 계속 시도한다.
- **턴 끝 보고**: `post` 를 안 부른 턴의 마지막 글을 쓴다. 직원 글은 `(자동)` 표시로 대화에 올리고 총괄에게 보고한다. 총괄·본사 AI 글은 그대로 대화에 올린다. 판 정리 지시(와 시스템 알림)만 받은 턴의 마지막 글은 올리지 않고 활동에만 남긴다.
- **판 정리**: 틱마다 `checkBoardTidy` 가 프로젝트를 본다. 주기(`boardTidyHours`, 기본 6, 0 이면 끔)가 지났고, `projects.board_tidied_at`(없으면 총괄이 뜬 때) 뒤로 결재·할 일·진행판·대화가 바뀌었고, 총괄이 이미 떠 있고 쉬는 중이며 기다리는 정리 지시가 없으면 `[시스템] 판 정리` 를 깨움으로 넣는다. 넣을 때와 그 턴이 끝날 때 시각을 적어, 정리하며 바꾼 것이 다음 정리를 부르지 않는다. `POST /api/projects/:id/tidy` 는 조건 없이 넣는다(연결 없으면 409, 총괄이 없거나 잠들었으면 띄운다).

### 출처 표시

글 첫 줄의 접두어가 출처이고, 서버만 붙인다.

| 접두어 | 뜻 |
|---|---|
| `[대표] "..."` | 대표가 총괄·본사 AI 에게 |
| `[대표 직접] "..."` | 대표가 직원에게 바로 |
| `[대표 답(원문) '<제목>'] "..."` | 결재 답 |
| `[총괄] <이름>에게` | 총괄 지시 |
| `[보고 <이름>] <종류>: <제목>` | 직원 보고 |
| `[시스템]` | 서버 알림 |

서버는 글을 넣기 전에 제어문자·제로폭·양방향 문자를 지운다. 줄 머리가 접두어처럼 보이면 `> ` 를 붙인다. 총괄 지시에 실린 대표 말은 서버가 원문과 대조해 `서버 확인` 또는 `미확인` 으로 표시한다.

## 두 실행 방식

둘 다 같은 `Runner` 인터페이스(`server/runner/types.ts`)를 구현한다.

**headless** (`server/runner/headless.ts`)

- 턴마다 `claude -p` 를 새로 띄운다. `--session-id` 로 시작하고 `--resume` 으로 잇는다.
- 글은 stdin 으로 넣고, `stream-json` 출력을 읽어 상태·활동·문맥 %를 낸다.
- 동시 턴 수는 Orchestrator 가 제한한다(기본 4).
- 서버가 꺼질 때 자식을 끝낸다. 비정상 종료에 대비해 턴마다 pid 를 `run/` 에 남겨 다음 시작 때 치운다.

**herdr** (`server/runner/herdr.ts`, `herdr-client.ts`)

- 소켓으로 herdr 에 말한다. 프로젝트마다 워크스페이스 하나, 직원마다 칸 하나다.
- 글은 `agent.prompt` 로 넣는다. IAMCEO 로 보낸 말은 넣는다. 먼저 화면을 글자 모양까지(`format: ansi`) 읽어 지금 떠 있는 것이 Claude 입력칸인지 본다. 못 찾으면(선택 창·승인 창·셸 모드 `!`) 넣지 않고 보류한다. 흐린 글씨(다음 말 추천·안내 글)는 친 글이 아니다. 입력칸에 남은 글은 실수로 남은 것으로 보고, 쉬는 세션(idle·done)이면 Ctrl+C 를 한 번 눌러 지운 뒤 넣는다. 누른 뒤 0.3~0.5초에 다시 읽어 비었으면 넣고, 아니면 다시 누르지 않고 보류한다. 일하는 중이면 Ctrl+C 가 턴을 끊으므로 누르지 않는다. Ctrl+C 는 약 0.8초 종료 창을 열고 그 안에 빈 칸에서 또 누르면 세션이 끝나므로, 칸마다 1.5초 안에 두 번 누르지 않고 종료 안내가 떠 있으면 누르지 않는다(Claude Code 2.1.316 실측). 시간 초과 뒤 다시 넣을 때도 같은 규칙이고, 일하는 중이면 다시 넣지 않는다. Ctrl+U 는 여러 줄을 못 지우고 Esc 한 번은 안 지워 쓰지 않는다.
- 상태는 `events.subscribe` 와 60초마다 `session.snapshot` 으로 안다.
- 턴이 끝나면 세션 기록 파일(`transcript.ts`)에서 마지막 글과 사용량을 읽는다.
- 서버를 다시 켜면 세션 id 로 칸에 다시 붙는다. 대표가 직접 연 칸이나 남의 칸에는 붙지 않는다.
- 긴 글(1500자 초과)과 첨부는 `inbox/<직원 id>/` 에 두고 경로를 넣는다.

어느 쪽이든 자식 환경에서 `HERDR_*`·`CLAUDECODE` 등을 지우고 `IAMCEO_*` 만 더한다.

`iamceo join` 으로 붙은 CLI 는 실행기 밖이다. 서버는 프로세스를 띄우지도 입력을 넣지도 않고, 세션이 `wait` 로 지시를 가져간다.

## 도구

`POST /agent/tool`. 받는 도구는 멤버 종류로 정해진다.

| 대상 | 도구 |
|---|---|
| 모두 | `status` `ask` `post` `file` `todo` `ask_close` `todo_close`(직원은 자기가 올린 결재·할 일만) |
| 총괄 | `team_add` `team_assign` `team_compact` `team_sleep` `team_resume` `team_close` `roster` `project_now` `work_set` `work_list` `work_remove` `board` |
| 본사 AI | `project_create` `project_list` `board` |
| 직접 띄운 CLI | `wait` |

- `ask`: 실행기 세션은 카드를 올린 뒤 바로 돌아오고, 턴을 끝낸다. 답은 다음 입력으로 온다. 직접 띄운 CLI 는 답이 올 때까지 도구 호출이 이어진다.
- `ask_close`: 결재를 이유와 함께 닫는다(`decisions.close_kind·close_reason·close_quote·closed_by·closed_at`). `decided` 는 `user_quote` 가 대표 글과 맞아야 하고(버튼 글·짧은 글은 거부), `obsolete` 는 이유만. 물은 직원에게 wake=false 로 알리고, 직접 띄운 CLI 의 `ask` 대기는 풀린다. 대표는 `POST /api/decisions/:id/reopen` 으로 되돌린다.
- `todo_close`: 할 일을 `done`·`dropped` 로 정리한다(`todos.outcome·close_reason·closed_by`). 부탁한 직원에게 wake=false 로 알린다.
- `file`·`ask` 의 경로: 심볼릭 링크를 따라간 실제 경로가 작업 폴더 안이어야 한다. 비밀 폴더·`.env`·개인 키·IAMCEO 데이터는 어디서든 거부한다. 세션의 Bash 까지 막지는 않는다.

## 데이터

`~/.iamceo/` (`IAMCEO_HOME` 으로 변경):

| 경로 | 내용 |
|---|---|
| `config.json` | 접속 코드·포트·주소(권한 600) |
| `iamceo.db` | SQLite(WAL). projects, members, decisions, todos, work, messages, files(아티팩트 원본 포함), attachments, deliveries, activity, settings |
| `uploads/` | 첨부 원본 |
| `inbox/<직원 id>/` | 직원이 읽을 긴 글과 첨부. 세션에 `--add-dir` 로 열어 준다 |
| `roles/` | 고쳐 쓴 역할 템플릿 |
| `run/` | 세션별 규칙 파일·MCP 설정·진행 중인 턴 표시 |
| `logs/` | 서비스 로그 |

대화 기록의 원본은 Claude Code 의 세션 파일에 있다. IAMCEO 는 세션 id 만 들고 있다가 이어서 연다. 직원 활동 기록은 직원당 최근 500건만 남긴다.
