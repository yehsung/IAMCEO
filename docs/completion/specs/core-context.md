# core-context — core 실행기 문맥 수집·자동 압축 구현 설계서

작성: 2026-11-07. **설계 전용 산출물이며 구현 완료 보고가 아니다.** 이번 작업에서 쓰는 파일은 `.pumasi/specs/core-context.md` 하나다.

`docs/claude-handoff.md` 전체(특히 §7·§8), 지정된 `CONTEXT-FIX.md`의 **OWNER UPDATE**를 먼저 읽었다. 이후 `core.ts`, `providers.ts`, `context.ts`, 새 `statusline.ts`, `transcript.ts`, Runner 타입, core RPC, orchestrator/API/DB/Store, 공용 타입, 웹·네이티브 팀/설정/상태 코드와 관련 시험을 확인했다. 읽는 중 공용 문맥 파일이 갱신됐으므로 아래 공용 계약은 담당자의 최종 변경을 받은 뒤 확정한다.

현행 core는 Claude 턴 종료 후 transcript 토큰과 화면 %만 읽는다. Codex 수집은 없고 `CoreRunner.compact()`는 미지원 결과를 반환한다. orchestrator에는 core 수동 압축 거절과 자동 압축 제외 조건이 있다. 웹은 core 압축 버튼을 막고, 네이티브에는 압축 버튼이 노출되지 않는다. `compactAtPct`는 이미 전역 설정이며 기본 70, API 범위 1…100이다.

제품 계약: 압축은 CLI 내부 문맥 정리다. 세션 교체·업무 완료·메시지 전달 완료와 구분한다. core를 목표로 구현하되 라이브 herdr의 실행/압축 계약을 바꾸지 않는다. 실행기 기본 전환은 IAMCEO 완성 후 가짜 프로젝트 검증을 거치는 별도 작업이다.

## 사용자 동작

1. 설정의 **자동 압축 기준**에서 1…100%를 저장한다. 설명: “문맥이 기준 이상이면 다음 지시를 보내기 전에 압축합니다. 진행 중인 턴과 직접 조작은 건드리지 않습니다.” Claude·Codex에 기존 `compactAtPct` 하나를 공유한다. 제공자별 기준이나 새 실행기 선택지는 추가하지 않는다. 100은 유효한 기준이고, 0을 끄기로 재해석하지 않는다.
2. 팀의 총괄·팀장 상세에서 문맥 %와 출처/신선도를 확인한다. 실측은 “문맥 73% · CLI 측정”, 추정은 “문맥 약 73% · 추정”, 수집 불가는 “문맥 확인 중”, 이전 표본은 “마지막 측정 73% · 갱신 대기”로 표시한다. 창 크기도 상세에서 볼 수 있다. `null`을 0%로 표시하지 않는다.
3. 자동 압축은 **깨우는 실제 전달 대기 항목이 있고 새 업무 턴을 시작하기 직전**에만 실행한다. 기준 초과만으로 쉬는 CLI를 깨우지 않는다. 긴 턴 도중 기준을 넘거나 설정을 낮춰도 그 턴을 끊지 않는다.
4. **문맥 압축**을 누르면 작업 중에는 “압축 예약됨 · 지금 턴이 끝난 뒤 진행합니다”, 실제 시작 후에는 “문맥 압축 중”, 완료 근거 확인 후에는 “문맥 압축 완료 · 사용량 갱신 중”을 표시한다. API 접수만으로 완료를 표시하지 않는다. 활성 요청의 중복 클릭은 같은 요청으로 합친다.
5. 직접 조작 lease·초안·승인 메뉴가 있으면 각각 “직접 조작 중 · 압축 대기”, “작성 중인 입력이 있어 압축을 기다립니다”, “CLI 승인 화면을 먼저 처리하세요”를 표시한다. 자동으로 초안을 지우거나 Enter·Esc·승인 선택을 보내지 않는다.
6. 전송 응답 손실이나 완료 근거 없는 제한시간 초과는 “압축 결과를 확인할 수 없습니다. 터미널을 확인하세요.”로 표시한다. 재전송하지 않는다. 사용자는 기존 터미널 직접 조작 또는 **중단**으로 상태를 정리한다. 사람이 해제한 경우 성공으로 꾸미지 않고 “사용자 확인으로 압축 대기를 해제했습니다”를 기록한다.
7. 잠든/사라진 세션을 압축 때문에 새로 실행하지 않는다. 샘플 모드·연결 끊김·직접 등록한 `origin=manual`에서는 액션을 막고 이유를 표시한다. Codex native ID가 미확인이면 “세션 기록 확인 중 · 자동 압축 대기”를 표시하되 첫 실제 업무 전달은 허용한다.

## 서버 API·DB

### 공개 API

인증은 기존 Bearer 계약을 유지한다. statusLine은 로컬 파일로 중계하므로 공개 수집 POST를 추가하지 않는다. 응답/활동에 접속 코드, MCP 토큰, rollout 경로, lease ID, 세션 식별용 nonce를 노출하지 않는다.

| 라우트 | 요청 | 응답·변경 |
|---|---|---|
| `GET /api/bootstrap` | 본문 없음 | 기존 `Bootstrap`. `settings.compactAtPct`와 공용 담당의 창 크기 fallback 설정 포함. |
| `PUT /api/settings` | 예: `{"compactAtPct":75}` | `200 Settings` 전체. 정수 1…100, 누락 필드 보존. 0·101·소수·문자열·알 수 없는 키는 기존 Zod 계약대로 400 `{"error":"…"}`. 다음 실행 판단부터 반영. |
| `POST /api/members/:id/compact` | 기존처럼 본문 없음 | 기존 `200 Member` 유지. core 미지원 거절을 제거하고 요청 저장/예약. 아래 `contextState.compaction`으로 접수·실행 구분. 활성 요청이면 같은 operation 반환. |
| `GET /api/members/:id` | 본문 없음 | `200 Member`, 선택적 `contextState` 추가. |
| `GET /api/projects/:id/state` | 본문 없음 | 기존 `ProjectState.members[]`에도 동일 필드. 웹 WS `member` 이벤트도 같은 직렬화. |
| `GET /api/members/:id/activity?limit=50` | 본문 없음 | 기존 `Activity[]`. 기존 종류 `compact`·`error`·`system` 사용. |
| `POST /api/members/:id/terminal/control` | 기존 `{action:"claim"|"release"|"input"|"key",leaseId?,text?,key?}` | 기존 `{leaseId?,expiresAt?}`. claim과 압축 전송을 같은 멤버 락으로 중재. |
| `POST /api/members/:id/interrupt` | 본문 없음 | 기존 `200 Member`. 압축 예약/실행도 취소 대상으로 포함. 정지 확인 전 불확실 상태 유지. |

수동 압축 오류: 없는 멤버 404, manual 등록은 기존 400, asleep/offline·세션/terminal 없음·연결 불가·Codex native ID 미확인은 409 `{"error":"…"}`. core는 `paneId`와 **완료 관찰 가능한 native ID**가 있어야 압축을 받는다. working/blocked/lease/초안은 살아 있고 식별 가능한 세션이면 예약을 받아 200과 보류 이유를 반환한다. 실행 꺼짐/프로젝트 보관 중은 409이며 압축 때문에 깨우지 않는다. 기존 `memberCompact()`·MCP `team_compact`도 동일 예약 함수를 사용한다. `focus`는 기존 MCP 경로에서만 받는다.

추가 타입 제안 — 기존 `Member` 필드를 제거하거나 의미를 바꾸지 않는다.

```ts
type ContextMeasurement = {
  sessionId: string;
  model: string | null;
  tokens: number | null;
  window: number | null;
  source: "statusline" | "codex" | "stored" | "screen" | "model" | "default";
  quality: "exact" | "estimated";
  measuredAt: string; // ISO 8601 UTC
  fresh: boolean;    // 같은 세션/모델/완료 턴의 최신 표본인지
};
type ContextCompaction = {
  id: string;
  trigger: "auto" | "manual";
  phase: "queued" | "sending" | "running" | "succeeded" | "failed" | "uncertain";
  reason: null | "working" | "manual_control" | "draft" | "blocked" |
    "backend_down" | "measurement_pending" | "send_uncertain" |
    "completion_timeout" | "provider_error" | "interrupted" |
    "session_changed" | "user_resolved";
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};
type CoreContextState = {
  measurement: ContextMeasurement | null;
  compaction: ContextCompaction | null;
};
// Member에 contextState?: CoreContextState | null 추가.
```

예: 73%에서 작업 종료를 기다리면 기존 `contextPct:73`, `contextWindow:1000000`, `contextState.compaction.phase:"queued"`, `reason:"working"`. 성공 직후 새 사용량이 없으면 `contextPct:null`, `measurement:null`, `phase:"succeeded"`. 0%를 만들어 넣지 않는다. `fresh`는 단순 경과시간이 아니다. CLI가 바뀌지 않고 오래 idle이면 마지막 표본은 유효하다. 새 입력/모델 변경/압축/접속 단절·재결합으로 현재 값인지 확인할 수 없으면 false다.

새 클라이언트→옛 서버: `contextState` 누락이면 상태 미지원으로 처리하고 core 압축 버튼을 막는다. 옛 클라이언트→새 서버: 기존 %와 무본문 POST를 유지한다. core 대응 서버는 항상 `{measurement:null,compaction:null}` 이상의 오브젝트를 반환하며 필드 누락/null을 기능 지원의 증거로 쓰지 않는다. 비core에는 생략 가능하다. `contextWindow`·실측 출처·모델별 창 설정의 이름은 공용 수정의 최종 정의를 사용하고 별도 중복 필드를 만들지 않는다.

### DB·영속 상태

`compactAtPct`는 기존 settings를 사용하고 `members.context_window`를 재추가하지 않는다. 공용 담당의 출처 저장/reset migration 뒤에 `MIGRATIONS` **말미**로 다음을 추가한다. 고정 migration 번호를 예약하지 않는다. 기존 `openDb()`의 백업/트랜잭션을 사용한다.

```sql
CREATE TABLE member_context_state (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  binding_nonce TEXT NOT NULL,
  rollout_path TEXT,
  rollout_offset INTEGER NOT NULL DEFAULT 0,
  measurement_json TEXT,
  compaction_json TEXT,
  baseline_json TEXT,
  updated_at TEXT NOT NULL
);
```

`measurement_json`·`compaction_json`은 위 타입을 JSON으로 저장한다. `baseline_json`은 내부 타입 `{sessionId:string,generation:number,terminal:string,turn:number,fileIdentity:string|null,offset:number,requestedAt:string,focus:string}`. fileIdentity로 같은 경로의 파일 교체를 감지하고 offset은 완전히 읽은 줄의 다음 위치다. rollout 경로는 지정한 Codex 기록 루트 내부의 검증된 경로만 저장한다. nonce는 세션 세대마다 생성하고 재결합 때 유지한다. 기존 멤버는 lazy 생성하고 실측/압축 성공을 backfill하지 않는다.

Store는 멤버 세대가 같은 경우에만 갱신한다. 측정 본체·기존 `contextPct/contextWindow`·추가 상태·활동은 한 트랜잭션에 저장하고 커밋 후 기존 Bus로 알린다. 공개 PATCH에서 내부 표를 직접 수정하지 못하게 한다. DB 실패 시 압축 입력을 보내지 않는다. JSON 손상은 측정 불명으로 처리하고 sending/running 가능성이 있으면 자동 전송을 멈춘다.

세션/CLI 변경 시 측정·cursor·nonce를 초기화하고 이전 요청을 취소한다. 모델만 변경되면 측정과 창의 유효성을 무효화하되 같은 CLI 세션의 nonce는 유지한다. 설정/제공자 교체는 압축 실행 중 기존 busy 계약으로 거절한다. generation은 기존 `members.session_generation`을 Store 내부에서 읽으며 같은 세대의 알려지지 않았던 Codex ID를 발견한 것만으로 nonce/요청을 초기화하지 않는다.

재시작 시 queued는 같은 세대이면 안전 조건을 재검사한다. sending/running은 먼저 uncertain으로 바꾸고 baseline 이후 증거를 다시 읽는다. 성공 증거가 있으면 succeeded, 없으면 uncertain을 유지한다. 기존 높은 `contextPct`만으로 압축을 시작하지 않는다. 기록이 없으면 실측을 기다리면서 표시/일반 전달의 기존 동작을 유지한다.

### 공용 수집 부품 재사용

**OWNER UPDATE를 우선한다.** 확인한 최신 `context.ts`에는 `ContextReading {tokens,shownPct,model,exact?,sessionId?}`, `ExactContext {window,source,pct?}`, `measureContext()`, `validWindow()`, `exactSource()`가 있다. 새 `statusline.ts`에는 `writeStatuslineWrapper(home)`, `capturedContext(home,sessionId,reading,endedAt)`가 있고 `<IAMCEO_HOME>/context/<sessionId>.json`으로 중계한다. 최종 export/출처명은 공용 담당과 맞춘다. core의 세대/turn/cursor는 내부 포장 또는 선택 필드로 전달하고 herdr 이벤트에 필수 필드를 추가하지 않는다.

**Claude 수집**

- `createOrchestrator()`에서 CoreRunner에 IAMCEO home을 명시적으로 전달한다. `writeRunFiles()`가 만드는 실행별 Claude settings에 공용 wrapper의 statusLine을 merge하고 `providerLaunch()`의 기존 `--settings`를 이용한다. bypass 이외 권한에서도 수집한다. `skipDangerousModePermissionPrompt` 등 기존 옵션을 보존한다. 사용자 설정 파일을 수정하지 않는다.
- 사용자/프로젝트/local/managed 설정 우선순위, 같은 stdin 중계, 원래 출력 통과, 재귀 방지, timeout/fail-open, 원자적 파일 갱신은 공용 wrapper 소유다. core에 두 번째 wrapper를 만들지 않는다. 기존 실행 세션을 wrapper 도입 목적으로 자동 재시작하지 않는다.
- 알려진 sessionId로 `readTranscriptTail()`과 `capturedContext()`를 사용한다. 신선한 공식 `used_percentage`와 `context_window_size`를 우선한다. 실측 model ID를 우선하여 `track.member.model`로 `/model` 변경을 가리지 않는다. current_usage의 input+cache_read+cache_creation은 각각 한 번만 더하고 누적 과금 토큰을 쓰지 않는다.
- 시작/재결합, 실행 중 최대 2초에 한 번의 작은 기록 읽기, 턴 종료, 압축 후에 수집한다. 실패해도 CLI는 계속 실행하며 표시값은 과거 값으로 남긴다. 신선한 공식%는 공용 reader의 종료시각/토큰 일치 검사를 사용한다. 오래된 record에서 창만 재사용할 때도 같은 세션/model인지 검사한다.

**Codex 수집과 native ID 연결**

- 알려진 native ID는 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`에서 찾되 파일명 외에 session_meta ID까지 확인한다. CODEX_HOME 미지정 시 일반 Codex home을 읽는다. 기록 루트는 CoreRunner options로 주입 가능하게 하여 시험에서 실 홈을 읽지 않는다. cwd·최신 mtime만으로 다른 세션을 연결하지 않는다.
- 현재 core 신규 Codex는 native ID가 null이다. 세대별 nonce를 DB에 먼저 저장하고 **첫 실제 업무 입력**에 `[IAMCEO session binding: <binding_nonce>]` 한 줄을 넣는다. rollout의 `response_item` 중 user text에서 해당 표식을 찾아 session_meta와 연결한다. 시작 전 디렉터리 snapshot·시작 시각·cwd·source는 후보 축소에만 사용한다. 날짜 경계도 검색한다. 시작 옵션의 firstPrompt뿐 아니라 일반 첫 send도 같은 경로를 사용한다.
- 완전한 nonce가 일치하는 한 세션만 선택하고 기존 `RunnerEvent.session`으로 `members.sessionId`를 저장한다. 같은 cwd 동시 실행도 nonce로 분리한다. 여러 후보/부분 기록/미지원 형식이면 미확인 유지. 기존 ID 미확인 core 단말도 다음 실제 입력에 표식을 넣어 연결한다. 식별만을 위한 가짜 업무/CLI 세션을 띄우지 않는다. ID를 지어내 resume하지 않는다. `/compact`에는 nonce·업무 marker·병렬 선호 문구를 붙이지 않는다.
- `event_msg`의 `token_count`에서 `payload.info.model_context_window`를 실측 창으로 읽는다. 분자는 **현재 문맥의 `last_token_usage.total_tokens`**다. 대응 형식에서 이 값이 없으면 같은 이벤트의 input+output 합을 사용한다. cached_input은 input에 포함되므로 재합산하지 않는다. `total_token_usage`는 세션 누적이어서 사용하지 않는다. 예: 49,096/258,400은 19%; 475,000 같은 임의 실측 창도 고정 후보로 반올림하지 않는다. 부모 세션만 읽고 서브에이전트 사용량을 합산하지 않는다.
- 분자 의미가 다른 CLI 버전이면 미지원으로 처리하고 창만 저장한다. JSONL은 처음 최대 1MiB tail, 이후 offset부터 차분 읽기. 완성되지 않은 줄과 UTF-8 부분 바이트는 보관해 다음 읽기에 이어 붙인다. session_meta/nonce가 tail에 없으면 후보 파일을 단계적으로 찾는다. 한 번에 최대 8파일/각 1MiB, 다음 tick에 cursor부터 이어서 전체 기록을 매초 다시 훑지 않는다. 파일 교체/축소는 identity를 바꾸고 재탐색한다. 누락/null usage/알 수 없는 이벤트는 0이 아니다.
- user text의 nonce 저장 형태, compact 완료 이벤트, 모델/토큰 필드 의미는 익명화 fixture와 대응 CLI 버전에서 확인해야 한다. 이 설계 작업에서는 실세션을 띄우지 않아 실제 기록 형식 검증을 완료했다고 주장하지 않는다. 향후 JSONL이 없는 버전은 미지원으로 표시하고 다른 세션에서 값을 빌리지 않는다.

**우선순위와 정확도**

공통 순서는 ‘신선한 공식% → 같은 세션/model의 이번 또는 마지막 실측 창＋현재 토큰 → 화면%의 반올림 오차를 고려한 추정 → 모델ID별 창 표(설정으로 덮어쓰기) → 설정 default’다. 공용 `measureContext()`에 두고 core에 200k/1M 분기를 복제하지 않는다. 추정값은 저장된 실측 창을 덮어쓰지 않는다.

표시는 fallback을 사용해도 되지만 **core 자동 압축은 같은 세션/세대/model 및 마지막 완료 턴의 fresh exact 측정만**으로 판단한다. 이전 Claude 세션에 wrapper가 없으면 추정 표시를 유지하고 성급한 압축을 피한다. 수동 압축은%를 몰라도 native ID/완료 관찰이 가능하면 받는다. 시각 표시와 압축 허용 판단을 분리한다.

창0·비finite·음수 토큰·범위 밖 공식%는 무효다. 분자가 창을 넘으면 화면은 최대100으로 clamp하되 불일치 진단을 남기고 exact 자동 실행 근거로 쓰지 않는다. 유효한0%는 유지한다. 공용 측정기가 불일치 exact를 버리고 fallback을 선택하면 quality는 estimated다. 모델 변경 후 실측 창을 다시 받는다. 190k/1M은 19%이며 95%가 아니다.

### 압축 명령·실행 상태·안전

Claude는 `/compact ${normalizeSpace(focus)}`를 사용한다. 기존 `compactFocus()`의 역할·현재/다음 일·미답변 질문·대기열/보드 요약을 유지하고 제어문자/줄바꿈을 제거한다. Codex는 **인자 없는 `/compact`**를 보낸다. Claude focus 인자가 Codex에서도 지원된다고 가정하지 않는다. 일반 send의 Codex 병렬 선호 prefix가 slash 명령 앞에 붙지 않게 입력 안전 검사만 공유하는 control 경로를 만든다.

Codex `/compact`는 [OpenAI 공식 Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)의 해당 절에서 확인했다. 공식 설명상 확인 화면이 나올 수 있어 그 경우 blocked로 두고 직접 조작에 맡긴다. 자동으로 확인을 선택하지 않는다. 설치된 `codex --version`은0.166.0이며 `--help`에는 최상위 compact 하위 명령이 없다. `codex exec compact`나 Responses 압축 API로 바꾸지 않는다. 조사에서는 help/version만 실행했고 실제 세션은 시작하지 않았다.

1. **core 전용 판단**: orchestrator의 `runner.kind !== "core"`를 단순 삭제하지 않는다. 기존 project/busy/blocked gate 뒤에서 core의 fresh exact 값으로 auto를 판단한다. 새 완료 측정을 최대2초 기다린 뒤에도 없으면 unknown/estimated로 일반 업무를 보내고 이번 auto를 건너뛴다. 수집 장애 때문에 일반 업무를 영구 정지하지 않는다.
2. **턴 종료 순서**: 현재 `observe()`는 turn_end 뒤 비동기 reportContext를 시작해서 오래된%로 다음 pump가 실행될 수 있다. Track에 완료 turn별 수집 barrier를 두고 측정 확정/불명화 후 일반 turn_end를 한 번 emit한다. 읽는 동안 isBusy는 true다. 이전 Track/terminal/세대의 후착 읽기를 버리고 Store 세대 조건으로도 방어한다. 이 barrier 전에 idle status를 먼저 emit해서 pump를 열지 않는다.
3. **요청 단일화**: 멤버별 활성 operation 한 개만 둔다. `CoreRunner.compact(m,focus,opts): Promise<SendResult>`는 기존 시그니처를 유지한다. 일반send·compact·applyConfig·claim이 같은 멤버 락을 사용한다. 모든 await 후와 전송 직전에 live/소유 라벨/신뢰할 OSC idle/pending 없음/uncertain 없음/설정 변경 없음/lease 없음/알아볼 수 있는 빈 composer를 다시 검사한다. working/blocked/draft/unknown에서는 입력하지 않고 예약을 유지한다.
4. **쓰기 전 영속화**: session/세대/turn/파일 위치의 baseline과 sending 상태를 DB에 커밋한 뒤 `terminal.send {text:command,if:"idle",force:false,wait:false}`를 딱 한 번 보낸다. 상태가 working으로 바뀌면 core의 조건으로 거절된다. generation1은 done을 정확히 조건으로 지정할 수 없으므로 **done만 보고된 경우 자동 전송을 보류**한다. 일반send의 done 무조건 전송 경로를 복제하지 않는다. 수동 API 예약 역시 안전 조건을 우회하지 않는다.
5. **ACK와 완료 분리**: ACK는 running으로 전환할 뿐 성공이 아니다. `started:false`도 입력은 전달됐으므로 재송신하지 않는다. 확정 busy/status_mismatch는 queued로 돌리고 재검사한다. blocked/input_busy도 입력 없는 검사만 재예약한다. 전송 timeout/응답 손실은 uncertain이며 `retryable:false`다. 기존 beginCompact의 다른 오류 후 업무를 계속 보내는 경로를 core 불확실 상태에 적용하지 않는다.
6. **실행 중 보호**: sending/running/uncertain을 isBusy에 포함하고 일반send·urgent·설정 교체·다음 압축을 막는다. 전송 락 중 claim은409, 전송 후에는 관찰/해결용 claim을 허용한다. 5분lease와 입력 시 연장은 그대로다. lease 만료 자체는 완료 근거가 아니다. 직접 조작 중에도 읽기는 계속하지만 자동 확인키를 보내지 않는다.
7. **완료 증거**: Claude는 baseline 뒤의 transcript `type:"system",subtype:"compact_boundary"`, Codex는 대응 버전 rollout의 `type:"compacted"`를 성공 후보로 관찰한다. Codex event_msg의 context_compacted 계열을 지원하려면 별도 버전 adapter/fixture로 검증한다. 새 기록＋동일 소유 CLI의 idle/done 복귀＋provider 오류 없음으로 한 번만 확정한다. 과거 기록·다른 세션·화면 문구·단순 토큰 감소는 성공 증거가 아니다.
8. **이벤트 혼동 방지**: compact 중의 OSC turn 증가는 일반 turn_end로 emit하지 않는다. 현재 onTurnEnd가 compact 턴을 즉시 완료하는 분기를 core 전용 결과 대기로 바꾼다. 성공은 `compacted`, 실패/불확실은 선택적으로 추가하는 `compact_result` 이벤트로 전달한다. 이벤트에 operationId와 세대/세션 식별을 붙여 다른 요청에 적용하지 않는다. herdr/headless의 기존 turn_end/compacted 계약은 유지한다.
9. **압축 후 갱신**: 이전 사용량 무효화→새 사용량 읽기→새 값 저장 순서다. 성공은 한 번 기록하고 같은 model의 창/출처는 유지한다. 새 사용량이 아직 없으면 contextPct/measurement는 null이어도 성공은 유지한다. 현행 afterCompacted의 일괄null 갱신이 새 core 표본을 지우지 않게 core 분기를 둔다. 뒤늦은 측정이 완료activity를 늘리지 않는다.
10. **반복 방지**: auto는 업무 완료 turn마다 최대 한 번. 기존 skipCompact를 core 세대/완료turn과 연결한다. 성공/확정 실패 후에는 새 업무 턴이 끝나고 fresh exact 측정이 올 때까지 auto를 재예약하지 않는다. CLI 자체 압축 경계도 관찰해 이전 값을 무효화하고 직후 IAMCEO 중복 압축을 막는다.

시간 제한은 기존 `compactTimeoutMs` 기본10분을 쓰고 시험에서는 짧게 주입한다. core 제한시간 초과는 uncertain으로 유지해 후속 자동 입력을 막는다. provider가 명확히 실패하고 idle로 돌아왔으면 failed 처리 후 auto 한 회를 건너뛰고 기존 업무를 진행한다. blocked는 자동 해제하지 않는다. 중복 실패/보류 기록은 상태가 바뀔 때 한 번만 쓴다.

예약 재검사는 기존 tick·턴 종료·직접조작 release·설정 변경에서 수행한다. **중단**이 core에서 stopped/exited로 확인되면 failed/interrupted로 정리한다. 직접조작 input/key로 사용자가 책임지고 상태를 정리한 뒤 실제 settled 상태를 확인하면 failed/user_resolved로 해제하고 성공으로 기록하지 않는다. claim/release만으로는 uncertain을 해제하지 않는다. 이미 succeeded인 요청을 뒤늦은 timeout이 덮지 못하게 operation ID/phase 조건으로 갱신한다. shutdown은 관찰/타이머를 닫되 holder를 kill하지 않는다.

활동 예: `compact` “자동 압축 시작 (Claude · 문맥73% / 기준70%)” → “압축 완료 (73%→24%)”. 새 값 없으면 “압축 완료 · 사용량 확인 중”. `system` “직접 조작 중이어서 압축을 기다립니다”, `error` “압축 응답을 확인할 수 없어 자동 재전송을 중지했습니다”. 시작/완료 활동은 orchestrator 한 곳에서 기록하고 Runner가 중복 기록하지 않는다. focus·대화 내용·CLI 인증정보는 로그에 복제하지 않는다.

## 웹 변경

- `web/src/screens/Settings.tsx`: 기존 compactAtPct 입력·검증·차이만 저장하는 방식을 유지하고 이름/설명만 “자동 압축 기준”으로 바꾼다.
- `web/src/screens/Team.tsx`: core 고정disabled/미지원 안내를 대체한다. 기존 `api.compact()` 무본문POST와 Member 반영을 이용한다. working은 예약 가능, 활성 operation은 중복 클릭 금지, unknown session/manual/asleep/offline/읽기전용/구서버는 이유와 함께 금지한다. %불명과 세션불명을 구분한다.
- ContextMeter에 실측/추정/오래된 값/미수집을 텍스트로 표시한다. 숫자·색만으로 압축 가능 여부를 표현하지 않는다. queued/sending/running/uncertain과 보류 사유를 보여주고 uncertain에서는 기존 터미널/중단 동선을 제공한다. 자동 재시도 버튼은 만들지 않는다.
- API 경로/WS 형태가 같고 Member를 그대로 보관하므로 `web/src/lib/api.ts`·store 수정은 불필요하다. 새 공용 타입을 사용한다. 구현 시 수동 필드 복사 코드가 발견되면 새 필드를 버리지 않는지 확인한다.

## 네이티브 변경

Mac·iOS는 같은 서버 기능을 제공한다. Mac의 멤버 상세 drawer와 iOS의 상세 push 화면에 문맥 상태와 **문맥 압축**을 제공한다. iPhone에서도 동일 조작을 허용하며 호스트Mac 전용으로 제한하지 않는다.

- `Models.swift`: 선택적 contextState와 내부 Codable 구조체 추가. 구서버에서는 nil, 알 수 없는 phase/source/reason은 전체decode 실패 대신 ‘상태 불명’으로 읽고 위험한 액션을 허용하지 않는다. 공용 창/출처 계약도 optional로 읽는다.
- `AppStore.swift`: 기존 `memberAction(...,action:"compact")`를 이용한다. HTTP200을 완료로 표시하지 않고 반환Member/기존 전경3초poll로 상태를 반영한다. 늦은 응답은 member ID·operation ID로 구분하여 다른 상세에 혼입하지 않는다. WS/APNs/백그라운드poll은 추가하지 않는다.
- `TeamView.swift`: 서버와 동일한 enabled 조건·보류/진행/불확실 문구를 적용한다. 현행 ‘자동 압축 미지원’ 안내를 제거한다. TeamContextBar에 추정/과거값/미수집 접근성 문구를 추가한다.
- `OfficeView.swift`: 기존 ‘터미널에서 /compact’ tooltip/접근성/메시지를 실제 상태에 맞춘다. 기준초과를 업무 실패/완료로 표현하지 않는다.
- `SettingsView.swift`: 기존1…100과 저장 계약을 유지하고 Web과 명칭/설명을 맞춘다. iOS Dynamic Type·Mac 키보드 동작을 유지한다. **Design/*.swift는 이 구현에서 수정하지 않으며** 병렬 카드 유리 작업 결과를 사용한다.

## 시험

설계 작성 단계에서는 빌드/서버/실CLI 시험을 실행하지 않는다. 아래는 구현 후 추가/수정할 시험이며 통과했다고 보고하지 않는다.

모든 시험은 `mkdtempSync(tmpdir()+"/iamceo-core-context-")`의 임시 IAMCEO_HOME을 지정한 뒤 config/db를 연다. 서버는127.0.0.1/port0, core RPC는fixture 소유의 짧은 Unix socket이다. Claude home/Codex home도 같은 임시루트로 주입하고 실행파일은 fake를 쓴다. **IAMCEO_HOME만 바꿔서는 CLI 기록/인증 홈이 격리되지 않는다.** 실제 홈·7878·herdr socket으로 fallback하는 시험을 금지한다. 전역 환경 변경은 저장 후 finally복구하며 options주입을 우선한다.

| 시험 | 추가/수정할 항목 |
|---|---|
| `tests/context.test.ts` — 공용 담당 | wrapper의 stdin/출력 보존, fail-open, 실제 창/출처, fallback 순서, 임의 창, 190k/1M→19%, headless 유지. core는 계약으로 참조한다. |
| 새 `tests/core-context.test.ts` — Claude | fresh/오래된 record/model 변경, 세대별 실측 유지, 0%·누락·음수·NaN·창 초과, 측정 barrier 중 busy, 2초 후 unknown, 구 Track의 후착 결과 폐기. |
| 같은 파일 — Codex parser | session_meta ID/부모 확인, last와 누적 usage 차이, cache 이중 합산 방지, 258400/475000, null info, 미완성 줄/UTF-8, 교체/축소, 여러 token_count, 미지원 버전. |
| 같은 파일 — Codex ID 연결 | 동일 cwd 동시 실행·날짜 경계·복수 후보·nonce 완전 일치, 첫 입력 전 unknown, 일반 업무 재전송 없음, slash 앞 prefix 없음, 재결합 후 nonce 유지·발견 ID 저장. |
| `tests/core-runner.test.ts` | 양 CLI 명령, if:idle/force:false, working/blocked/lease/draft/unknown에서 입력 0회, done 보류, send/compact/claim/config 경합, ACK/started:false와 완료 구분, timeout 후 send 1회. |
| 같은 파일 — 완료 | 새 boundary/compacted＋settled만 성공, 과거/타 세션/토큰 감소/화면 문구만으로 성공 불가, blocked에서 키 0회, 성공/timeout 경합, shutdown이 holder를 kill하지 않음. |
| `tests/core-context.test.ts` — orchestrator | fresh exact＋wake＋기준과 같은 값에서 1회, 수동 예약이 턴을 끊지 않음, 추정/과거 값/no-wake는 auto 없음, 성공 후 null/새 표본, CLI 내장 압축과 중복 없음, 확정 실패 skip·uncertain 후 업무 보류. |
| 같은 파일 — DB | 구 schema→공용 migration→새 표, 백업/재open, queued 복구, sending/running 재시작 후 재송신 0회, baseline 이후 증거로만 복구, 세대 reset·JSON 손상·CAS·후착 결과 폐기. |
| `tests/server-runtime.test.ts` | core 409 기대 수정, Member/ProjectState 응답, settings 70→75·1/100·잘못된 값 400, 무본문 호환·중복 active POST, manual/asleep/unknown ID·인증/404. |
| `tests/screens-regress.browser.ts` | fake core로 PC/모바일 폭 설정 저장, 추정/미수집, working 예약, queued→running→succeeded, lease 보류, uncertain 동선, 구 서버 필드 누락. |
| `native/Tests/IAMCEOTests/ContractTests.swift` | 구/신 Member, 알 수 없는 enum/누락, 0과 nil 구분, compactAtPct 범위/보존. |
| `native/Tests/IAMCEOTests/NetworkTests.swift` | URLSession 모의로 무본문 POST→Member, 200 예약 표시·409, 다른 대상에 늦은 응답 혼입 없음, 샘플 쓰기 금지. |

구현 후 `bun run typecheck`, 위 Bun 단위/계약 시험, `tests/herdr.test.ts`·`tests/core.test.ts`·`tests/orchestrator.test.ts`·`tests/regress.test.ts`·`tests/headless.test.ts`의 관련 회귀 시험, 대상 browser 시험, `swift test --package-path native`를 실행한다. Bun 명령에도 임시 IAMCEO_HOME을 지정한다. Swift scratch/cache도 임시 경로로 지정한다. macOS/iOS Simulator를 빌드하고 샘플/격리 host에서 문구를 확인한다. 실 CLI 검증은 별도 허가된 쓰고 버릴 프로젝트·전용 core/state/socket에서 소유자가 진행하며, 완료 전 core 기본 전환 검증 완료로 보고하지 않는다.

## 위험·미정

- **외부 attach 원자성**: generation 1은 앱 lease를 알지 못한다. 별도 터미널 입력과 화면 검사/송신을 원자적으로 막을 수 없다. 앱 lease·빈 composer·직전 재검사·if:idle까지 보장하며 외부 attach 때도 먼저 앱에서 조작권을 얻도록 안내한다. 완전한 보장에는 upstream 입력 owner/revision 조건이 필요하다.
- **done 조건부 송신 부재**: done만 보고하는 CLI에서는 자동 압축이 보류될 수 있다. 해결은 제공자의 idle 보고나 upstream 조건 확장이다. 무조건 send로 우회하지 않는다. 실 버전 검증의 출시 차단 조건이다.
- **Codex 기록 버전 차이**: help는 JSONL/완료 기록까지 보장하지 않는다. 0.166.0을 조사했으나 nonce 저장/compacted/last usage의 의미는 익명 fixture와 실 버전 검증이 필요하다. 미지원 형식은 미확인으로 보이고 다른 session 값을 쓰지 않는다.
- **DB와 PTY 사이의 간격**: 하나의 트랜잭션이 아니다. sending 선저장과 재시작 uncertain으로 이중 압축을 막는다. 실제 미전송일 가능성이 있어도 자동 재송신하지 않는다.
- **진행 중인 공용 수정**: context/statusline/types/Store/migration이 읽는 중에도 변했다. 최종 export/열/설정을 받고 시작한다. 공용 코드를 되돌리거나 병렬로 덮어쓰지 않는다.
- **토큰 의미/예약 영역**: Codex 창이 UI 예약 영역과 다르더라도 공급값을 보존한다. 고정 계수를 임의로 곱하지 않고 누적 과금 토큰과 혼합하지 않는다. 미확인은 미확인으로 남긴다.
- **herdr 회귀**: core의 exact 제한·uncertain 보류·done 보류를 전체 실행기에 적용하면 라이브 동작이 달라진다. core 분기에 한정하고 공통 측정 변경은 소유자와 조정한다.

## 소유자 할 일

1. 공용 문맥 수정 담당: 실제 창/출처의 최종 Member 이름, 모델 표 설정 이름, Codex parser 위치, wrapper/reader exports, reset 조건을 공유한다. 재사용 가능한 parser가 있으면 새 parser와 통합하여 중복 구현을 피한다.
2. core 담당: core/providers와 새 core-context 모듈의 수집·nonce·완료 관찰을 소유한다. RunnerEvent 추가는 선택적으로 하고 herdr에 필수 변경을 떠넘기지 않는다.
3. orchestrator/API/DB 담당: core 전용 pump/예약/영속화를 소유한다. 공용 담당과 db/store/shared/context를 동시에 편집하지 않고 공용 변경을 먼저 받아 차례로 적용한다. migration 말미를 재확인한다.
4. Web/Native 담당: 서버형 확정 후 연결한다. Native는 View/Models/State만 수정하고 별도 담당의 Design 파일을 건드리지 않는다.
5. 제품 소유자/검증 담당: IAMCEO 완성 후 격리한 가짜 프로젝트에서 실 Claude/Codex의 기록·실제 창·OSC idle/done·압축 확인 화면을 검증한다. 기존 세션의 wrapper 도입 재시작은 그때 별도 판단한다. 이번 설계 작업에 라이브 접속/재시작 권한은 없다.

## 파일 목록

아래는 **후속 구현에서 변경할 파일**이다. 이번에 작성한 것은 이 설계서 하나뿐이다. 한 줄에 한 절대경로로 나열한다.

공용 중복: context.ts, statusline.ts(추가 중), server/db.ts, server/store.ts, shared/types.ts, tests/context.test.ts. 이 파일들은 공용 담당 변경을 먼저 받고 조정한다. herdr.ts는 읽기/회귀 대상이며 core 담당은 수정하지 않는다. Design/*.swift는 대상 밖이다. 새 파일 예정은 core-context.ts와 core-context.test.ts다. 목록의 공용 context/statusline은 독립 구현 소유권이 아니라 계약 확정·필요시 공용 담당이 변경할 경로다.

```text
/Users/yesung/iamceo/server/runner/core.ts
/Users/yesung/iamceo/server/runner/core-context.ts
/Users/yesung/iamceo/server/runner/providers.ts
/Users/yesung/iamceo/server/runner/types.ts
/Users/yesung/iamceo/server/runner/context.ts
/Users/yesung/iamceo/server/runner/statusline.ts
/Users/yesung/iamceo/server/orchestrator.ts
/Users/yesung/iamceo/server/store.ts
/Users/yesung/iamceo/server/db.ts
/Users/yesung/iamceo/shared/types.ts
/Users/yesung/iamceo/web/src/screens/Settings.tsx
/Users/yesung/iamceo/web/src/screens/Team.tsx
/Users/yesung/iamceo/native/Sources/IAMCEO/Models/Models.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/State/AppStore.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/TeamView.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/OfficeView.swift
/Users/yesung/iamceo/native/Sources/IAMCEO/Views/SettingsView.swift
/Users/yesung/iamceo/tests/core-context.test.ts
/Users/yesung/iamceo/tests/core-runner.test.ts
/Users/yesung/iamceo/tests/context.test.ts
/Users/yesung/iamceo/tests/server-runtime.test.ts
/Users/yesung/iamceo/tests/screens-regress.browser.ts
/Users/yesung/iamceo/native/Tests/IAMCEOTests/ContractTests.swift
/Users/yesung/iamceo/native/Tests/IAMCEOTests/NetworkTests.swift
```

server/http.ts는 기존 무본문 POST와 설정 schema를 유지하므로 변경이 불필요하다. 새 공개 route/라이브러리는 추가하지 않는다. 기존 CoreRunner/Runner.compact와 Orchestrator.compactMember 시그니처는 유지한다. 내부 Store 보조 함수명은 실제 코드 관례에 맞춘다.

## 크기

**L**. 두 제공자의 실측·Codex 세션 연결·완료 이벤트 순서·직접 입력과의 경합·재시작 불확실성 처리가 필요하다. 공용 수집 부품을 재사용해 UI/설정 변경은 작지만 core/Store/오케스트레이션 검증이 중심이다.
