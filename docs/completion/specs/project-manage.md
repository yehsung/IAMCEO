# 프로젝트 이름 바꾸기·보관·보관 해제 구현 설계서

기준: 2026-11-07, `/Users/yesung/iamceo`의 현재 작업 트리. 이 파일은 구현 지시서이며 코드를 구현하거나 시험을 실행한 결과가 아니다. `docs/claude-handoff.md` 전체, 제품 계약 §8·남은 범위 §7을 먼저 읽고 아래 코드와 `docs/spec.md`의 계약을 대조했다. 실행기 기본값 전환은 이 작업의 범위가 아니다. 새 구현은 core를 목표로 하되 현재 라이브 herdr의 동작과 호환 시험을 유지한다.

현재 구현의 출발점:

- `shared/types.ts`: `Project.archived`, `PatchProjectReq.name/archived`, `ConnectionReason="archived"`가 이미 있다. 새 프로젝트 모델을 만들 필요가 없다.
- `server/db.ts`: 최초 스키마부터 `projects.archived INTEGER NOT NULL DEFAULT 0`가 있다. `server/store.ts`의 `listProjects()`·`projectSummaries()`는 보관 프로젝트를 제외한다. `patchProject()`는 이름과 자동 총괄 이름을 바꾸고 `project`·`projects` 이벤트를 보낸다.
- `server/http.ts`: PATCH, 보관 목록 GET, 보관된 state의 404, HQ 보관 거부가 이미 있다. `Orchestrator.checkArchivable()`는 working·blocked·실행기 busy·열린 결재·미완료 todo를 거부한다.
- `tests/archive-gate.test.ts`는 직접 세션의 늦은 보고, 보류 전달 재개, herdr 편입 칸 종료의 사전 검사·부분 실패를 이미 검증한다. 이 동작을 새 기능처럼 다시 만들거나 삭제하지 않는다.
- 웹 `Settings.tsx`와 네이티브 `SettingsView.swift`의 `SettingsProjectsPanel`에 이름/폴더 수정·보관·꺼내기가 이미 있다. 빠진 핵심은 사이드바/전환기 진입점, 일관된 확인·오류·동기화, 공용 네이티브 액션, core 종료 실패 시 성공으로 숨기는 경계 보강이다.

## 사용자 동작

### 이름 바꾸기

1. 프로젝트 행의 우클릭/더보기에서 **“이름 바꾸기…”**, 또는 설정 → 프로젝트 → **“이름 바꾸기”**를 연다. 대화상자 제목은 **“프로젝트 이름 바꾸기”**, 입력 라벨은 **“프로젝트 이름”**, 버튼은 **“취소” / “저장”**이다.
2. 현재 이름을 선택한 상태로 시작한다. Enter로 제출하고 Escape로 취소한다. 제출 중에는 **“저장하는 중…”**을 표시하고 같은 프로젝트의 관리 액션을 중복 실행하지 않는다.
3. 서버의 정규화 결과를 받은 뒤 제목·사이드바·전환기·설정 행을 갱신한다. ID, 폴더, 직원 핸들, 업무/대화/자료 ID, 세션·토큰·대화 초안 키는 바꾸지 않는다. 실행 중에도 이름 변경은 가능하며 CLI를 다시 띄우거나 대화형 CLI에 이름 변경 지시를 자동 전송하지 않는다.
4. 자동 총괄 이름만 기존 규칙에 따라 함께 바꾼다. 예: `결제 총괄` → `주문 총괄`. 사용자가 따로 바꾼 이름과 과거 메시지의 `who`·`targetName`은 역사적 기록으로 유지한다. 실행 중 CLI의 기존 시스템 프롬프트·터미널 제목이 즉시 바뀐다고 보장하지 않는다.
5. 정규화한 동일 이름은 성공한 무변경 처리다. 중복 프로젝트 이름은 허용한다(기존 DB에 유일 제약이 없음). 프로젝트 선택과 요청은 반드시 ID로 한다.

### 보관과 안전 확인

- 보관은 삭제나 업무 완료가 아니라 **프로젝트 운영을 쉬고 일반 탐색에서 숨기는 상태**다. 사이드바·프로젝트 전환기·일반 프로젝트 목록·프로젝트 수·합계·웹 문서 제목/앱 배지 집계에서 제외한다. 대화·업무·결재·자료·첨부·직원 명부·세션 이력은 지우거나 완료 처리하지 않는다.
- 보관 전에는 항상 **“‘{이름}’ 프로젝트를 보관할까요?”** 확인을 띄운다. 설명: **“프로젝트 목록에서 숨기고 IAMCEO가 관리하는 세션을 잠재웁니다. 기록은 남으며 설정의 보관함에서 다시 꺼낼 수 있습니다. 직접 실행한 CLI는 종료하지 않습니다.”** 버튼: **“취소” / “보관”**. 취소가 기본 포커스다.
- 확인을 열 때 최신 `GET /api/projects/:id/state`를 읽는다. 선택되지 않은 프로젝트도 반드시 해당 ID로 읽는다. 실패하면 **“프로젝트 상태를 확인하지 못했습니다” / “다시 확인”**을 표시하고 보관을 제출하지 않는다. 이 읽기는 서버의 최종 허가를 대신하지 않는다.
- 일하는 직원/승인 대기/열린 결재/미완료 할 일이 있으면 확인 화면에 수와 대상 이름을 보여 주고 보관 버튼을 비활성화한다. 문구: **“일하는 직원 {n}명이 있습니다. 현재 작업을 확인한 뒤 보관해 주세요.”**, **“승인을 기다리는 직원 {n}명이 있습니다.”**, **“열린 결재 {n}건과 미완료 할 일 {n}건을 먼저 처리해 주세요.”** 0인 항목은 표시하지 않는다. **“팀에서 확인” / “결재함에서 확인” / “홈에서 확인” / “다시 확인”**을 제공한다.
- **확인은 강제 종료의 동의가 아니다.** 기존 `checkArchivable`의 거부 정책을 유지한다. 이 화면에 “그래도 보관”, `force:true`, 자동 interrupt·결재 닫기·todo 완료 처리를 추가하지 않는다. 사용자가 팀의 기존 중단/재우기 흐름을 이용한 뒤 새로 보관한다. work의 `doing` 표시는 업무 기록이므로 그것만으로 작업 중 판정을 하지 않는다.
- 확인 후 작업이 시작되거나 CLI 입력 초안·직접 조작권·전달 불확실 상태가 발견되면 서버가 409로 거부한다. 설명과 확인 화면을 유지하고 **“상태가 바뀌었습니다. 다시 확인해 주세요.”**와 서버 오류 원문을 표시한다. 임의로 재전송하지 않는다.
- 실제 종료가 필요한 관리 세션을 확인할 수 없으면 503이다. **“세션을 확인하지 못해 보관하지 않았습니다. 연결을 확인해 주세요.”**를 표시한다. 실행기가 꺼져 있어도 종료할 살아 있는 관리 세션이 전혀 없으면 메타데이터 보관은 허용한다.
- 성공 후 **“프로젝트를 보관했습니다”**. 현재 보고 있던 프로젝트면 본사 홈으로 이동하고 상세·대상·터미널·지시 작성 시트를 닫는다. 설정에서 보관했다면 설정에 머물되 돌아갈 프로젝트만 본사로 바꾼다. 다른 프로젝트를 보관한 경우 현재 화면을 바꾸지 않는다. 초안은 원래 프로젝트/담당자 키에 보존한다.

### 보관 중 접근과 직원

| 대상 | 보관 중 계약 |
|---|---|
| 일반 화면 | `state`는 기존처럼 404. 링크/다른 기기의 열린 화면은 본사로 이동하고 **“보던 프로젝트가 보관되어 본사로 돌아왔습니다”**를 알린다. 보관 자료 전용 뷰어는 이번 범위에 없다. |
| 사용자 실행 명령 | 새 지시·첨부 전송·총괄 시작·직원 생성/재개·편입·세션 교체·CLI 입력/claim은 409. 기존 프로젝트 활성 검사 누락 경로를 보완한다. 이미 처리한 동일 메시지/결재 답 재조회는 기존 멱등 응답을 유지한다. terminal lease release는 정리에 필요하므로 허용한다. |
| 기록 읽기 | 인증된 개별 messages/decisions/files/artifact/attachment/activity 조회는 기존처럼 허용한다. 보관은 접근 권한 회수 기능이 아니다. |
| 메타데이터 | 이름 변경과 보관 해제 허용. 기존 PATCH의 cwd/now/runnerEnabled:false도 유지하되 새 UI는 보관함에서 이름 변경·꺼내기만 노출한다. `runnerEnabled:true` 단독은 409, `archived:false`와 함께 보내는 기존 요청은 허용한다. |
| 관리 직원 `runner` | 종료를 확인한 세션만 asleep·subagents=0·paneId=null로 정리한다. 세션 ID가 null인 core Codex도 paneId로 처리한다. 직원/업무·세션 이력을 삭제하거나 제공자를 바꾸지 않는다. 이미 잠든 직원은 그대로 둔다. |
| 편입 직원 `adopted` | herdr의 전원 사전 `checkStop`과 종료 불가/부분 실패 정책을 보존한다. core가 편입 종료를 지원하지 않는다고 해서 core로 전환해 죽이지 않는다. 원래 backend의 소유권과 오류를 존중한다. |
| 직접 직원 `manual` | IAMCEO 소유 프로세스가 아니므로 종료·강제 asleep·토큰 폐기하지 않는다. working/blocked이면 다른 직원처럼 보관을 막는다. 보관 후 늦게 들어온 보고/자료는 저장하되 관리 세션을 깨우거나 배지를 올리지 않는다. |
| 전달 | 미전달 큐를 지우지 않는다. 보관으로 막힌 큐는 held/archived. 이미 delivered는 되돌리지 않는다. `delivery_unknown`을 archived로 덮거나 delivered로 추정하지 않는다. 직접 CLI의 wait도 보관 중에는 큐를 소비/전달 완료 처리하지 않는다. |

따라서 **엄격한 불변 스냅샷/완전한 읽기 전용 DB는 아니다.** 사용자 운영은 멈추지만 늦은 MCP 보고·자료·상태 관측과 기존 할 일 체크 계약은 보존한다. `ask`는 기존처럼 오류로 끝나 새 결재를 만들지 않는다. 기존 `todo` 도구/대표의 todo 체크가 기록을 바꿀 수 있다는 호환 계약도 유지한다. UI에서는 보관된 프로젝트의 업무 편집 화면을 열지 않는다. 외부 CLI가 자체 파일·네트워크 작업을 계속하는 것까지 보관이 통제하지 않는다.

### 보관 해제와 본사

- 설정 → 프로젝트 → **“보관함”**에서 이름·폴더, **“이름 바꾸기” / “꺼내기”**를 제공한다. 빈 상태는 **“보관한 프로젝트가 없습니다”**. 조회 실패는 빈 목록으로 숨기지 않고 **“보관함을 불러오지 못했습니다” / “다시 시도”**를 표시한다.
- 꺼내기 전 안내: **“프로젝트 목록에 다시 표시합니다. 보관 때문에 멈춘 전달이 있으면 기존 지시가 이어질 수 있습니다.”** 버튼 **“취소” / “꺼내기”**. 처리 중 **“꺼내는 중…”**, 성공 **“프로젝트를 보관함에서 꺼냈습니다”**와 별도 **“프로젝트 열기”**. 다른 프로젝트를 보고 있었다면 자동으로 선택하지 않는다.
- `runnerEnabled`는 보관 전 값을 유지한다. 해제 자체가 전원 기동/CLI 로그인/새 총괄 생성을 뜻하지 않는다. 기존 held/archived 큐만 펌프를 다시 검사한다. wake=false만 있거나 원래 asleep 때문에 멈췄던 직원은 자동으로 깨우지 않는다. core의 전달 불확실·잃은 Codex 세션·이전 실행기 세션은 기존 명시적 복구 정책을 적용하며 새 세션을 몰래 만들지 않는다.
- 본사는 ID `hq`/`isHq`로 판정하며 표시명이 “본사”인지로 판정하지 않는다. **이름 변경은 기존처럼 허용**, 본사 역할·탭 규칙·root 이름은 유지한다. 보관 메뉴는 숨기고 직접 `archived:true` 요청은 HTTP와 Store 모두 400으로 거부한다. root를 프로젝트 총괄처럼 이름 변경하지 않는다. `archived:false`는 무변경 성공이다.

## 서버 API·DB

### 외부 라우트와 JSON 계약

신규 공개 라우트·패키지·요청 키를 만들지 않는다. 아래는 전부 기존 Bearer 인증 API다. 멤버 MCP 토큰에 프로젝트 관리 권한을 추가하지 않는다.

| 라우트 | 요청 | 성공 응답 |
|---|---|---|
| `PATCH /api/projects/:id` | 이름만: `{"name":"주문 관리"}` | 200, 갱신된 **Project 객체 자체** |
| 동일 | 보관: `{"archived":true}` | 200, 종료 확인·DB 반영이 끝난 `Project`, `archived:true` |
| 동일 | 해제: `{"archived":false}` | 200, `Project`, `archived:false`. 전달 완료 응답이 아님 |
| 동일 | 기존 복합 PATCH: `{"name":"주문 관리","cwd":"/tmp/sample","now":"검토 중","runnerEnabled":false,"archived":true}` | 전체 필드 검증 후 처리. 금지 조합이면 세션 종료 이전에 거부 |
| `GET /api/projects/archived` | 본문 없음 | 200, `Project[]` 자체, 없으면 `[]`. 기존 생성 순 정렬 유지 |
| `GET /api/bootstrap` | 본문 없음 | 기존 `Bootstrap`, `projects:ProjectSummary[]`에는 활성만 포함 |
| `GET /api/projects/:id/state` | 본문 없음 | 활성은 기존 `ProjectState`; 보관은 404 `{"error":"보관된 프로젝트입니다"}` |

`Project`의 정확한 응답 필드(축약형 DTO를 도입하지 않는다):

```ts
{
  id: string; name: string; isHq: boolean; cwd: string;
  runnerEnabled: boolean; now: string; nowAt: string | null;
  herdrTabId: string | null; archived: boolean;
  createdAt: string; updatedAt: string;
  connection: { ok: boolean; reason: "runner_off" | "backend_down" | "archived" | null; detail: string | null };
  tidiedAt: string | null;
}
```

보관 응답의 connection은 `{ok:false,reason:"archived",detail:"보관된 프로젝트입니다. 보관함에서 꺼내면 쓸 수 있습니다"}`. 해제 응답은 실제 연결 상태를 다시 계산하며 `ok:true`로 고정하지 않는다. 기존 서버 오류 모양 `{error:string}`을 유지한다. 상태 코드: 스키마/이름/금지 조합/HQ=400, 인증 실패=401, 없는 프로젝트=404, 현재 상태·중복 처리·종료 거부=409, 실제 세션 확인/종료 연결 장애=503. 오류 본문에 세션 토큰·접속 코드·원시 터미널 화면을 넣지 않는다.

`PatchProjectReq`는 현재의 `{name?:string;cwd?:string;runnerEnabled?:boolean;now?:string;archived?:boolean}` 그대로다. unknown key/null/잘못된 JSON은 현재 Zod strict 스키마로 거부한다. 타입가드 중복을 추가하지 않는다.

### Store API와 이름 변경 원자성

유지할 시그니처:

```ts
Store.getProject(id: string): Project | null
Store.requireProject(id: string): Project
Store.listProjects(opts?: { includeArchived?: boolean }): Project[]
Store.projectSummaries(): ProjectSummary[]
Store.patchProject(id: string, patch: ProjectPatch): Project
```

추가할 내부 검증 시그니처: `Store.validateProjectPatch(id: string, patch: ProjectPatch): ProjectPatch`. 현재 객체를 읽고 정규화한 패치를 반환하며 쓰기/이벤트를 일으키지 않는다. Orchestrator는 외부 종료 전에 호출하고 `patchProject`도 직접 호출자를 위해 재검증한다.

- 이름은 HTTP와 Store에서 trim 후 비어 있지 않은 한 줄, 기존 `MAX_PROJECT_NAME=100`·`oneLineProblem` 검사. 길이는 기존 JS UTF-16 code unit 기준이다. 한글/이모지를 화면에서 임의로 잘라 저장하지 않는다. Swift `String.count`만으로 서버의 길이 기준을 대체하지 않는다.
- 자동 총괄 이름 판정은 kind가 conductor이고 기존 표시명이 `conductorName(before.name)` 또는 `cleanName(conductorName(before.name), "총괄")`와 같을 때만 한다. 두 형태를 인정해 과거 값과 이번 정리 규칙으로 만든 값 모두 다음 rename에서도 자동 이름으로 판정한다. 새 총괄 표시명은 `cleanName(conductorName(newName), "총괄")`로 기존 직원 이름 규칙을 만족시키며, 프로젝트 이름 자체를 직원 이름으로 제한하지 않는다. 일반적인 이름은 기존과 동일하다. 별도 이름의 직원과 파생 이름이 충돌하면 변경 전체를 409로 거부한다.
- 프로젝트 UPDATE와 필요한 자동 총괄 UPDATE는 같은 SQLite transaction으로 수행한다. 기존 `patchMember`가 트랜잭션 중 이벤트를 내보내지 않도록 이 경로는 SQL 갱신 후 commit 뒤 `member` → `project` → `projects`를 보낸다. 다른 `patchMember` 경로·문맥 창 필드를 수정하지 않는다. DB 실패에 이름만 바뀐 프로젝트나 먼저 방송된 실패 이벤트가 없어야 한다.
- 변경할 실제 값이 없으면 updatedAt 갱신·이벤트·잠재우기/펌프 없이 기존 객체를 반환한다. 다만 이미 보관된 프로젝트에 기존에 깨진 관리 세션 상태가 보이면 정상 성공으로 간주하지 말고 아래의 실패/복구 기준으로 처리한다.
- Store는 SQL/불변식 담당이다. Store만 호출해서 살아 있는 프로젝트를 운영상 보관 완료시켰다고 보지 않는다. 사용자 경로는 반드시 아래 Orchestrator 단일 진입점을 거친다. HQ 금지는 Store에도 둔다.

### 프로젝트 변경 수명 주기

`OrchestratorApi`에 `patchProject(projectId: string, patch: PatchProjectReq): Promise<Project>`를 필수로 추가한다. HTTP는 파싱·cwd 확장 후 이 메서드 하나를 호출한다. 기존 `beforeProjectPatch → store.patchProject → onProjectPatched`의 HTTP 분산 호출을 대체한다. 클래스의 기존 hook은 기존 직접 호출 시험과 runnerEnabled 처리의 호환을 위해 남기되, 보관의 부작용은 새 진입점에서 한 번만 수행한다. HTTP fake도 새 메서드를 구현한다.

1. 프로젝트별 변경 잠금을 먼저 획득한다. 같은 프로젝트의 중복 PATCH는 기다렸다 자동 재실행하지 않고 409 **“프로젝트 변경을 처리하는 중입니다. 잠시 뒤 다시 하세요”**. 다른 프로젝트와 읽기·늦은 보고는 계속 가능하다. 잠금 안에서 current를 새로 읽고 전 필드/금지 조합/HQ/이름 파생 충돌을 검증한다. `archived:true + runnerEnabled:true`는 이미 상태가 어떻든 종료 이전에 400으로 거부한다.
2. 활성→보관이면 기존 `archiving` 장벽을 종료 전체와 commit까지 유지한다. 펌프·주기 정리·직원 생성/재개/재열기·설정 적용·직접 CLI wait 소비·terminal claim/input/key에서 같은 장벽을 확인한다. 이미 진행 중인 send/start/config/reopen/terminal 입력이 있으면 기다려 뒤에서 종료하지 않고 409로 거부한다. accepted 큐는 잃지 않고 보류하며, 서버가 거부한 새 지시를 성공한 저장으로 표현하지 않는다.
3. `checkArchivable`의 기존 상태/결재/todo 검사를 유지한다. 관리 세션 전부에 `checkStop` 사전 검사를 한다(현재 adopted에만 있는 검사를 core runner 세션까지 확장). core는 소유 labels·live 상태·OSC 상태·빈 composer·lease·pending/uncertain/send/config 진행을 검사한다. 화면 문구로 업무 완료를 추론하지 않는다. 정상적인 finished/not_found의 소유 터미널은 이미 종료된 것으로 처리하고, 주소/소유권 불일치는 종료 권한으로 해석하지 않는다.
4. 사전 검사 후 상태를 다시 검사하고 관리 세션을 순서대로 종료한다. **보관 중 stop은 강제 작업 중단을 허용하지 않는 모드**로 호출한다. `Runner.stop(m: RunnerMember, opts?: { whileWorking?: boolean }): Promise<void>`로 선택 인자를 추가하고, core는 옵션 생략 시 현재 기본 동작을 보존하되 보관에서는 `{whileWorking:false}`로 최종 checkStop을 다시 한다. herdr는 기존 checkStop/stop 절차를 보존하며 새 선택 인자가 기존 단일 인자 구현을 깨지 않아야 한다. core의 adopted 미지원도 그대로다.
5. `sleepMember`의 보관 경로는 stop 성공 확인 전에 asleep/paneId=null을 먼저 저장하지 않는다. 확정 종료된 직원과 그 큐만 잠재움 상태로 기록한다. 한 직원이라도 실패하면 프로젝트의 archived/name/cwd 등 PATCH 필드는 commit하지 않는다. 이미 종료한 직원은 되살리지 않고 asleep, 해당 보류 큐는 asleep으로 두어 자동 재개를 막는다. 응답에 **“{이름}의 세션은 이미 종료되어 잠든 상태로 남았습니다”**를 덧붙인다. herdr의 기존 부분 실패 시험이 요구하는 동작이다.
6. 종료 결과가 불확실한 경우에는 성공으로 숨기거나 즉시 stop/start를 재시도하지 않는다. 프로젝트는 활성으로 남기고 해당 직원의 pane/session 참조와 오류를 남겨 실제 터미널 확인을 요구한다. 그 직원의 자동 펌프·재열기는 런타임 격리 상태로 막고, 화면의 명시적 복구 이후에만 푼다. 전달 결과도 불확실했다면 기존 delivery_unknown을 유지한다. 이 격리의 재시작 한계는 위험 절에 명시한다.
7. 모두 성공하면 `Store.patchProject`로 archived를 commit하고 나머지 미전달 큐를 held/archived로 정리한다. 보관 장벽 중 잠재움에 사용한 큐 보류 이유와 이미 asleep였던 큐를 구분해 기존 asleep/legacy_session/delivery_unknown을 덮지 않는다. archived=true의 최종 목록 이벤트는 종료 확인 뒤에만 보낸다. finally에서 변경 잠금/일시 장벽을 해제하되 불확실 멤버 격리는 유지한다. 경고만 찍고 200을 반환하는 기존 catch는 제거한다.
8. 해제는 잠금 아래 DB를 먼저 반영한 뒤 기존 held/archived 대상의 펌프를 비동기로 검사한다. PATCH 200은 “보관 해제 저장됨”이며 “CLI에 전달/업무 완료”가 아니다. `archived:false,runnerEnabled:true` 복합 요청의 enable 실패는 기존 오류 응답과 실제 저장 상태를 재조회하게 한다. 실패했다고 보관이 유지됐다고 추정하지 않는다.

core의 `terminal.get/read` 검사와 `terminal.kill`은 upstream generation 1에서 하나의 원자 명령이 아니다. IAMCEO 내부 경합은 장벽으로 막되 외부 `attach`와의 경합까지 해결했다고 주장하지 않는다. 이를 이유로 보관에 `force:true` 입력이나 무조건 kill을 추가하지 않는다.

### DB·마이그레이션·하위 호환

- 이번 범위는 **스키마 마이그레이션 없음**. 기존 archived/name/updated_at, 멤버 상태·pane/session, deliveries를 사용한다. archivedAt·휴지통·삭제·새 상태 enum·재개할 직원 snapshot은 추가하지 않는다. SQLite user_version을 올리거나 기존 migration 번호를 수정하지 않는다.
- `server/db.ts`에서 다른 작업자가 추가한 문맥 창 migration과 백업 정책은 그대로 사용한다. 새 버전 번호를 임의로 선점하지 않는다. 기존 데이터 테스트는 현재 migration 배열의 마지막 버전 기준으로 만든다.
- 기존 보관된 행은 그대로 보관함에 나타난다. GET/복원 조회 자체가 CLI를 열거나 자동 청소/종료를 하지 않는다. 종료에 실패했던 과거 행에 실제 관리 세션이 남아 있으면 일반 지시/자동 재기동을 계속 막고 사용자에게 해제 후 팀에서 확인하도록 한다.
- `recover()`는 archived 프로젝트에 대해 세션 start/reopen을 수행하지 않아야 한다. DB에 남은 paneId만 보고 새 CLI를 만들면 안 된다. core와 herdr 모두 보관 행·asleep 큐·불확실 전달을 먼저 검사한다.
- GET/PATCH 응답, ProjectSummary 필드, `WsEvent.project/projects`, 기본 정렬, HQ ID, 기존 멱등 메시지/결재 계약은 유지한다. 기존 클라이언트도 같은 PATCH로 동작한다. 새 클라이언트는 서버가 반환한 최종 상태로 재동기화한다.
- 기존 `todo` 체크는 실행기 연결과 무관하다는 계약을 유지한다. 보관을 엄격한 읽기 전용으로 바꾸려면 별도 제품/호환 변경이 필요하다. 이번 설계의 기능 보완을 단순 스타일 변경으로 묶어 배포하지 않는다.

## 웹 변경

- `Shell.tsx`의 `ProjectList` 행에 우클릭 메뉴와 키보드/터치용 **“{이름} 프로젝트 메뉴”** 더보기 버튼을 추가한다. 이름 링크 안에 버튼을 중첩하지 않는다. Shift+F10/Menu 키, 화살표·Enter·Escape, 닫힌 뒤 원래 행 포커스를 지원한다. 좁은 화면의 기존 프로젝트 선택 시트에서도 같은 메뉴를 제공한다. HQ에는 이름 변경만 보인다.
- 새 `components/ProjectManage.tsx`에 이름 입력과 보관/해제 확인 UI를 모은다. 항상 `{projectId, mode}`를 고정해 연다. 현재 선택 프로젝트의 값으로 대상을 뒤바꾸지 않는다. 설정과 사이드바가 동일 UI·오류 문구·중복 잠금을 사용한다.
- `Settings.tsx`의 기존 ProjectsPanel/ProjectRow/ProjectEdit를 활용한다. 기존 폴더 편집은 없애지 않고 **“프로젝트 설정”** 경로로 유지한다. 이름만 바꿀 때 cwd를 함께 보내지 않는다. 보관함은 이름 수정/꺼내기·로딩/실패/빈 상태를 제공하고 오류를 `.catch(() => {})`로 숨기지 않는다.
- `lib/api.ts`의 기존 projectState/archivedProjects/patchProject를 사용한다. 변경 요청의 기존 150초 시간 제한을 유지한다. `lib/store.ts`에 프로젝트별 관리 액션 pending과 보관함 refresh 무효화 신호를 둔다. 성공 REST를 `applyLocal`로 반영한 뒤 bootstrap/보관 목록을 다시 읽어 WS 누락도 복구한다. 실패/시간 초과에는 자동 PATCH 재시도 없이 먼저 조회하고 **“처리 결과를 확인해 주세요”**를 표시한다.
- `leaveIfArchived()`/refresh의 기존 본사 복귀 규칙을 재사용한다. 보관 project 이벤트 수신 즉시 작성/제출을 막고 projects 이벤트나 REST 재조회로 확정 후 이동한다. 설정에서 돌아갈 프로젝트만 본사로 바꾸는 기존 동작을 보존한다. 오래된 프로젝트 state/관리 요청이 새 경로를 되돌리지 않게 기존 request generation을 적용한다.
- 보관함 갱신은 활성 ID 배열 변화만 의존하지 않는다. 보관된 이름 변경도 기존 project 이벤트 또는 로컬 성공으로 무효화한다. 설정을 열거나 다시 전경이 되었을 때도 갱신한다. 보관함 행은 bootstrap.projects에 합치지 않아 `useInboxTitle()`의 기존 활성 합계가 유지된다.
- 기존 Composer의 프로젝트별 초안/대상 ID를 보존하고 다른 프로젝트로 이관하지 않는다. 별도 초안 삭제나 형식 변경은 필요 없다. 전환 중의 오래된 관리 대화상자는 제출을 중단하거나 원래 ID에만 적용한다.
- 스타일은 기존 Glass/Modal/Sheet·setup.css/shell.css 토큰을 재사용한다. 오류 role=alert, 결과 role=status, 라벨·포커스·클릭 영역을 명시한다. 디자인 시스템을 새로 만들지 않는다.

## 네이티브 변경

### 공용 상태/API

- `SettingsView.swift`의 private `ProjectPatch`를 `APIClient.swift`의 공용 `PatchProjectRequest: Encodable, Sendable`로 옮긴다. `name/cwd/archived`는 optional이고 nil은 JSON에서 생략한다. absent와 false를 혼동하지 않는다. Project/ProjectSummary의 기존 Codable은 그대로 쓴다.
- APIClient 추가: `func archivedProjects() async throws -> [Project]`, `func patchProject(id: String, request: PatchProjectRequest) async throws -> Project`(PATCH, timeout 150초). 프로젝트 ID는 기존 `segment`로 인코딩한다. 주소/토큰/redirect 정책은 그대로다.
- AppStore 추가: `func loadArchivedProjects() async`, `@discardableResult func patchProject(id: String, request: PatchProjectRequest) async -> Bool`. 보관함 목록·로딩·오류를 관리하고 `pendingActions` 키 `project:<id>`로 프로젝트별 중복을 막는다. UI의 직접 api.send와 별도 busyID 로직은 제거한다.
- 메타데이터 관리 권한은 `canWrite` 기준이다. `uiCanWrite`는 프로젝트 runner connection.ok까지 요구하므로 이름 수정/해제에 사용하면 안 된다. 샘플·오프라인에서는 서버로 쓰기 요청을 보내지 않고 명확한 기존 안내를 보여 준다.
- perform/mutate의 endpoint generation·401 처리·409 재조회·150초 취소/응답 규칙을 재사용한다. 보관함 조회도 endpoint generation을 검사해 서버를 바꾸거나 연결을 끊은 뒤 도착한 옛 목록을 버린다. 타임아웃/연결 단절은 결과 미확정으로 표시하고 재조회한다. 편집 문자열은 유지한다.
- 기존 refresh는 목록에서 현재 ID가 사라지면 첫 프로젝트로 이동한다. 이를 명시적 HQ 우선/없으면 첫 활성 프로젝트로 유지하고 이동 안내를 남긴다. bootstrap 읽기와 state 읽기 사이 보관되어 state가 404가 된 경합도 한 번 bootstrap을 재조회하여 처리한다. 그 외 네트워크 실패는 보관으로 단정하지 않는다.
- 선택된 프로젝트의 보관 성공은 refresh 성공을 기다려야만 입력이 막히는 구조로 두지 않는다. 응답을 즉시 반영해 구 프로젝트 state를 비우고 대상/상세를 초기화한다. 그 뒤 authoritative bootstrap을 받는다. 다른 프로젝트 보관/해제는 현재 선택을 바꾸지 않는다.
- Router는 관리 대화상자의 ID/모드를 보관한다. 실제 프로젝트 변경 때 `resetForProjectChange`가 기존 member/decision/file/terminal/chatTarget 외에 showCompose도 닫도록 한다. DraftStore의 프로젝트/대상 키와 첨부는 보존한다. 관리 sheet는 endpoint 변경·로그아웃에 닫고, 같은 프로젝트 이름만 바뀌면 닫지 않는다.

### Mac

- `AppShell.swift`의 `ProjectSidebar.row`에 `.contextMenu`로 **“이름 바꾸기…” / “프로젝트 보관…”**을 추가한다. 우클릭 대상과 선택 프로젝트가 달라도 정확한 행 ID를 전달한다. 키보드/VoiceOver용 더보기 Menu도 제공한다.
- 새 `Views/ProjectManageView.swift`에서 공용 이름 입력/확인 내용을 렌더링한다. AppShell과 별도 macOS 설정 창 양쪽에 host를 둔다. 확인 UI의 실패 설명이 잘리지 않게 하고 destructive 동작의 기본 선택은 취소로 둔다.
- 설정의 기존 SettingsProjectsPanel을 공용 store/API로 연결하고 행 이름 수정·보관·보관함·폴더 편집 기능을 보존한다. 다른 창에서 관리 중인 동일 프로젝트는 pending으로 표시한다. 전역 설정 저장 버튼과 프로젝트별 저장을 합치지 않는다.

### iOS / iPad

- AppShell의 기존 projectMenuItems에 **“현재 프로젝트 관리”** 진입점을 추가한다. 이름 변경/보관은 시트에서 수행해 작은 메뉴 안에 경고 설명을 축약하지 않는다. 설정의 프로젝트 목록에서는 현재 선택과 무관하게 모든 프로젝트를 관리한다. iPad에서 사이드바/포인터 컨텍스트 메뉴를 제공하더라도 같은 액션을 사용한다.
- compact 환경은 NavigationStack sheet와 최소 44pt 터치 영역을 사용한다. 키보드 제출, 취소, 요청 중 표시, inline 오류, VoiceOver 문구를 Mac과 일치시킨다. 보관함은 설정 안에서 접근하며 활성 프로젝트 전환 목록에 섞지 않는다.
- 전경 3초 폴링을 유지한다. APNs·WebSocket·백그라운드 폴링을 추가하지 않는다. 설정/보관함이 열린 동안 같은 polling 결과에 맞춰 보관 목록을 갱신하고 이전 요청이 새 결과를 덮지 않게 한다.
- `native/Sources/IAMCEO/Design/*.swift`는 수정하지 않는다. 현재 디자인은 승인된 최종 시안이 아니며, 공용 스타일 컴포넌트의 공개 사용법만 이용한다.

## 시험

이 설계 작성 단계에서는 빌드·서버·브라우저 시험을 실행하지 않는다. 아래는 구현자가 추가/수행할 검증 목록이다.

### 격리 원칙

- 각 서버 시험은 `mkdtemp` 아래 고유 `IAMCEO_HOME`, 프로젝트 cwd, DB/uploads/run, 가짜 provider 저장소를 사용한다. config는 임시 home에 시험 코드로 생성한다. `~/.iamceo/config.json`을 읽거나 기존 파일을 복사하지 않는다.
- HTTP는 `IAMCEO_PORT=0`, hosts=`["127.0.0.1"]`로 시험이 직접 연 서버의 실제 할당 포트만 쓴다. 7878·라이브 PID·launchd·herdr 소켓에 접속하지 않는다. core RPC는 시험이 만든 임시 소켓/mock runner만 사용한다. `initializeRuntime`의 실제 core 시작을 호출하지 않는다.
- `tests/archive-gate.test.ts`의 Fake와 `tests/core-runner.test.ts`의 JSON-RPC fixture, browser 시험의 `startBrowserCore()` 패턴을 재사용한다. 승인/출력은 가짜이며 실제 Claude/Codex 로그인·네트워크 모델을 호출하지 않는다. 임시 리소스만 finally에서 종료/정리한다.
- Swift는 URLProtocol mock·`persistCredentials:false`, 임시 저장 경로로 검증한다. 기존 시험의 URL 문자열에 7878이 있더라도 새 시험은 mock origin의 별도 포트를 쓰며 실네트워크로 fall through하지 않는지 검증한다. 샘플 UI 확인은 `--demo`이며 쓰기 시험은 별도 격리 mock 호스트다.

### 추가할 자동 시험

1. Store: trim/빈 이름/100·101 code units/한글·이모지/줄바꿈·제어문자/동일 이름/중복 이름 허용. 직접 Store 호출의 HQ 거부. 자동 총괄 변경·별도 총괄/root 유지·특수문자 파생 이름 정리·직원 이름 충돌·transaction 실패 시 프로젝트/총괄/이벤트 모두 원상태.
2. DB: 새 migration 없이 같은 DB를 닫고 다시 열어 이름·보관·명부·자료·세션 이력·큐 보존. 활성/전체/보관 목록의 필터·정렬과 summary 집계. 현재 migration 버전을 고정 숫자로 가정하지 않는다.
3. HTTP: 실제 인증/strict JSON·wrong key/null/없는 ID/본사 예외, 위 요청/응답 모양, archived state=404, 불가능한 복합 PATCH가 stop 호출 전에 400. 같은 archived 값/이름 재시도는 side effect가 반복되지 않는다. http fake의 새 Orchestrator 진입점 위임도 검사한다.
4. 보관 gate: managed/manual working, blocked, runner busy, 열린 ask, 미완료 todo 각각 409이고 stop/DB mutation 없음. 단순 work doing이나 runner 꺼짐만으로 거부하지 않음. stale UI에서 상태가 변하면 최종 서버 검사가 거부.
5. core: idle Claude/Codex(pane만 있고 sessionId=null 포함) 종료 성공·finished/not_found 처리·ownership mismatch·unknown OSC·사용자 초안·lease·send/config/uncertain 중 거부. 사전 검사 뒤 상태가 바뀌면 archive stop의 마지막 검사도 거부. 오류·RPC timeout에서 archive가 true/목록 제외/200이 되지 않음. 기존 force sleep의 동작은 회귀 없이 유지.
6. 부분 실패: 여러 managed/adopted 직원 중 두 번째 종료 실패/응답 유실. 모든 칸 사전 검사를 통과해야 첫 stop이 시작됨. 확정 종료 직원은 asleep으로 남고 자동 재열기 없음, 실패 직원은 참조/오류 보존, PATCH 이름/cwd도 미반영. 종료 불확실 멤버의 런타임 격리 확인.
7. 동시성: 보관/해제/rename 중복 PATCH, 보관 중 tick/pump/resume/create/terminal input/manual wait 경합. 보관 직후 재시작에서도 start 호출 없음. 기존 delivery_unknown/legacy_session/asleep 이유가 archived로 덮이지 않음.
8. 해제: runnerEnabled 유지, held/archived + wake=true만 기존 gate를 거쳐 이어짐, wake=false/asleep/unknown 큐는 자동 시작하지 않음. 직접 세션 보고는 보관 중 저장되지만 총괄을 깨우지 않고 해제 후 기존 큐 규칙대로 처리. 기존 `tests/archive-gate.test.ts` 전체 통과.
9. 읽기/호환: 보관 중 개별 기록/첨부 읽기 허용, 새 ask 거부, todo 체크·늦은 보고/자료 허용, 새 운영 명령 거부. 이때 보관 프로젝트의 새 todo/상태가 일반 배지·프로젝트 합계에 들어가지 않음. 토큰·세션 history가 rename/archive로 회전하지 않음.
10. 웹 상태/브라우저: desktop 우클릭·더보기·키보드·mobile 전환 시트, 비선택 행 관리, 취소/검증 오류/503/401/응답 유실, 보관함 빈 상태와 조회 실패 구별, 보관된 이름의 다른 탭 변경 반영, HQ 예외. 실제 route 이동·문서 제목·배지·관리 중 초안·원래 담당자 보존을 검증한다. restore가 현재 프로젝트를 강제 선택하지 않는지 확인한다.
11. Swift: PATCH의 nil 생략/archived=false 인코딩, URL·Bearer·150초 timeout, demo/offline 쓰기 0회, 프로젝트별 중복 잠금, endpoint 변경 후 늦은 응답 폐기, 401/409/503/네트워크 오류, bootstrap→state 사이 404 경합, 보관된 현재 프로젝트/다른 프로젝트/다중 창/보관함 갱신, Router showCompose 닫힘과 DraftStore 원래 키 보존.

구현 후 순서: 대상 Bun 단위/HTTP/runner 시험 → 새 browser 시나리오 → `bun run typecheck` → 관련 기존 회귀 시험 → Swift 단위 시험·macOS/iOS simulator 빌드. 전체 시험은 격리 환경을 확인한 뒤 실행한다. Swift 빌드 scratch/DerivedData·XcodeGen 산출물은 임시 디렉터리에 두고 서명/배포/로컬 호스트 시작은 하지 않는다. Mac·iOS 수동 QA는 확인 대화상자·키보드·읽기/쓰기 실패·초안 보존을 각각 수행한다. 문서 작성만 완료한 상태에서 위 시험이 통과했다고 보고하지 않는다.

## 위험·미정

- **동시 작업 충돌:** `server/store.ts`는 문맥 창 필드 작업과 겹친다. 프로젝트 구간/이벤트 transaction만 변경하고 member contextWindow 처리와 import를 덮지 않는다. `server/db.ts`, `shared/types.ts`, `server/runner/herdr.ts`, `server/runner/context.ts`, `tests/context.test.ts`와 `native/.../Design/*.swift`는 읽었거나 참조 대상이지만 이 기능에서 수정할 필요가 없다. 변경이 추가로 필요해지면 먼저 해당 담당자와 범위를 합친다.
- **이식 위험:** 기존 docs/spec.md 일부는 core가 production 기본이라고 적지만 사용자 지시상 라이브는 herdr다. 설계·시험의 목표와 라이브 전환은 별개다. 이 기능을 이유로 backend 기본값·socket 설정·core 설치/시작을 바꾸지 않는다.
- **프로세스 중단 원자성:** SQLite transaction과 외부 CLI 종료는 한 transaction이 아니다. 종료 후 DB commit 실패 또는 서버 강제 종료가 있으면 활성 프로젝트에 잠든/참조가 남은 직원이 있을 수 있다. 성공 응답은 내지 않고 이미 종료한 세션을 되살려 롤백하지 않는다. archive 처리 도중의 강제 종료를 재시작까지 완전히 복구하는 영속 작업 journal은 이번 범위에 없다.
- **종료 불확실 격리의 한계:** 런타임 격리는 데몬 재시작 시 사라진다. 보관 실패 후 강제 재시작을 넘어 자동 재열기까지 확실히 막으려면 영속 종료 의도/확인 상태 migration이 별도로 필요하다. 새 lifecycle은 정상 요청과 동일 프로세스의 실패를 보장하며, 이 한계를 장시간 운용 검증의 통과로 간주하지 않는다. 구현 중 재시작 안전 보장이 필수로 확장되면 db/types 담당자와 journal 범위를 먼저 합의한다.
- **외부 attach 경합:** core protocol의 검사/kill 사이 외부 입력을 원자적으로 잠글 수 없다. UI에서 “항상 안전한 동결”이라고 표현하지 않는다. core API 확장이 필요하면 별도 upstream 작업이다.
- **보관=완전한 읽기 전용으로 보이는 오해:** 늦은 manual 보고/자료/상태와 기존 todo 쓰기는 허용된다. 현재 동작 보존을 위한 의도적 결정이다. 불변 스냅샷·보관 자료 탐색·보관 날짜/정렬·일괄 보관·영구 삭제·프로젝트 병합은 범위 밖이다.
- **이름 충돌/과거 기록:** 새 이름과 파생 총괄 표시명은 달라질 수 있고 과거 메시지의 작성자 표시는 유지된다. 이름으로 프로젝트를 찾는 기존 외부 자동화는 rename 뒤 이름을 갱신해야 한다. 서버/클라이언트 내부 참조는 ID를 유지한다.
- **복구 제한:** 보관으로 종료한 core Codex의 native session ID를 모르면 해제 뒤 즉시 이어지지 않을 수 있다. 기존 “새 세션으로 이어가기”를 사용하며 해제가 컨텍스트 완전 복원을 보장하지 않는다.
- **제품 결정:** 작업 중 “확인 후 강제 보관”은 채택하지 않는다. 기존 거부 계약을 유지하는 보관 확인을 제공한다. 강제 보관을 원하면 결재/직접 조작/불확실 전달의 처리까지 포함하는 별도 기능 설계가 필요하다. 이 문서를 구현하기 위한 미결 제품 질문은 없다.

## 소유자 할 일

아래는 후속 구현을 나누기 위한 책임 목록이며 이번 문서 작성에서 병렬 작업자나 외부 메시지를 실행한 것은 아니다.

1. 서버 담당: 기존 store 문맥 작업자가 끝낸 프로젝트 외 구간을 보존하며 Store 검증/transaction, Orchestrator 단일 PATCH 수명 주기/장벽/오류, core safe stop과 archived recover gate를 구현한다. 현재 HTTP hook 호출과 직접 호출 시험 호환을 함께 정리한다. herdr 편입/부분 실패 동작은 기존 fake 회귀 시험으로 확인한다.
2. 웹 담당: 공용 ProjectManage UI·Shell 메뉴·Settings 재사용·store pending/보관함 갱신·초안/route/배지를 구현한다. 새 공개 API 없이 기존 JSON으로 먼저 작업할 수 있다.
3. 네이티브 담당: 기존 SettingsProjectsPanel의 중복 네트워크 로직을 APIClient/AppStore로 옮기고 Mac/iOS 관리 진입점·sheet·Router reset을 구현한다. Design 파일 소유자의 스타일 변경을 되돌리지 않는다.
4. 검증 담당/구현자: 임시 IAMCEO_HOME과 mock socket/URLProtocol을 사용하는 시험을 추가하고 양 플랫폼 시나리오를 검증한다. 성공/거부/부분 종료/결과 불확실을 구분해 기록한다.
5. 최종 통합 담당: docs/spec.md의 Store/REST·보관 상태·safe stop 의미를 최종 구현과 맞춘다. 기능 완료 후 가짜 프로젝트 core 검증을 별도로 수행하며 실제 라이브 기본값 전환은 이 작업에 포함하지 않는다.

## 파일 목록

아래는 **후속 구현에서 생성/수정할 파일 전체**다. 이번 설계 작업의 유일한 생성 파일은 이 설계서다. 목록의 각 경로는 한 줄이며, 신규 파일은 웹/네이티브 공용 관리 UI와 해당 시험이다. `db.ts`·`shared/types.ts`·herdr/context·Design 파일은 수정 목록에서 의도적으로 제외한다.

/Users/yesung/iamceo/server/store.ts
/Users/yesung/iamceo/server/http.ts
/Users/yesung/iamceo/server/orchestrator-api.ts
/Users/yesung/iamceo/server/orchestrator.ts
/Users/yesung/iamceo/server/runner/types.ts
/Users/yesung/iamceo/server/runner/core.ts
/Users/yesung/iamceo/web/src/components/ProjectManage.tsx
/Users/yesung/iamceo/web/src/components/Shell.tsx
/Users/yesung/iamceo/web/src/screens/Settings.tsx
/Users/yesung/iamceo/web/src/lib/store.ts
/Users/yesung/iamceo/web/src/styles/shell.css
/Users/yesung/iamceo/web/src/styles/setup.css
/Users/yesung/iamceo/native/Sources/IAMCEO/Services/APIClient.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/State/AppStore.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/State/Router.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/AppShell.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/ProjectManageView.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/SettingsView.swift
/Users/yesung/iamceo/tests/core.test.ts
/Users/yesung/iamceo/tests/http.test.ts
/Users/yesung/iamceo/tests/archive-gate.test.ts
/Users/yesung/iamceo/tests/core-runner.test.ts
/Users/yesung/iamceo/tests/web-lib.test.ts
/Users/yesung/iamceo/tests/project-manage.browser.ts
/Users/yesung/iamceo/native/Tests/IAMCEOTests/ProjectManageTests.swift
/Users/yesung/iamceo/docs/spec.md

## 크기

**L.** UI와 기존 CRUD만 보면 작은 보완이지만, core의 종료 확인·부분 실패·실행 중 경합, 웹/Swift 공용 액션과 다중 기기 동기화, herdr 회귀까지 함께 마쳐야 한다. DB migration과 공개 API 확장은 피했지만 서버 실행 수명 주기를 건드리는 변경이므로 S/M으로 축소하지 않는다. 영속 archive journal·라이브 실행기 전환·새 디자인 시스템은 이 크기에 포함하지 않는다.
