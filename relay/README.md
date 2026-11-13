# IAMCEO 알림 중계 · IAMCEO notification relay

[한국어](#한국어) · [English](#english)

---

## 한국어

### 무엇인가

App Store 에서 받은 IAMCEO iPhone 앱으로 알림을 보내려면 IAMCEO 앱의 Apple 알림 키(APNs 키)가 있어야 합니다. 그 키는 개발자만 가집니다.
그래서 자기 키가 없는 Mac 의 IAMCEO 서버는 알림 한 건마다 이 중계에 아래 값만 넘기고, 중계가 정해진 문구로 알림을 만들어 Apple(APNs)에 보냅니다.

- 넘기는 값: iPhone 푸시 토큰, 알림 종류, 무작위 식별자(전달·사건·서버 ID와 이동할 화면의 ID), 유효 시각
- 넘기지 않는 값: 대화, 결재·보고 내용, 프로젝트·팀장 이름, 접속 코드, 계정·메일

중계는 Firebase Cloud Functions(2세대, Node 22) 함수 하나(`relay`)입니다. 디스크·DB 에 아무것도 저장하지 않습니다.
알림 문구와 앱 번들 ID(`com.yehsung.iamceo`)는 중계 코드에 고정되어 있어, 이 중계로 다른 문구나 다른 앱에 보낼 수 없습니다.
알림 모양은 Mac 서버가 자기 키로 직접 보낼 때와 같은 함수(`server/push/apns.ts`)로 만들어 바이트까지 같습니다.

### 받는 것과 남기지 않는 것

| 무엇 | 어떻게 |
|---|---|
| 푸시 토큰·식별자·유효 시각 | 요청을 처리하는 동안만 메모리에 있고, APNs 로 보낸 뒤 버립니다. 저장·기록하지 않습니다 |
| 설치 자격(설치 ID·비밀) | 저장하지 않습니다. 비밀은 서버 비밀(`RELAY_MASTER`)로 설치 ID 를 서명한 값이라 요청마다 다시 계산해 비교합니다 |
| 남용을 막는 수(설치별·iPhone별·IP별) | 메모리에서만 셉니다. iPhone 토큰과 IP 는 날마다 새로 만드는 무작위 메모리 비밀로 HMAC 한 값으로만 셉니다. IP 는 설치를 만들 때(Mac 마다 처음 한 번)만 셉니다. 함수가 쉬어 내려가거나, 다시 배포하거나, 날이 바뀌면 사라집니다 |
| 함수가 남기는 로그 | 한 시간마다 건수 합계 한 줄, 그리고 오류 한 줄(설치 ID·APNs 사유 코드·시각). 토큰·IP·Authorization·본문은 남기지 않습니다(시험 `test/no-leak.test.ts`) |
| Google 이 자동으로 남기는 요청 로그 | Cloud Run 은 요청마다 로그(접속 IP, 경로, User-Agent, 상태, 걸린 시간)를 자동으로 만들고 Cloud Run 에서 끌 수 없습니다. 아래 배포 5단계의 **제외 필터**로 저장하지 않게 합니다(Logging 이 받은 뒤 버립니다). 필터를 넣지 않으면 30일 보관됩니다 |
| Firebase Hosting | 쓰지 않습니다. Hosting 은 남용 탐지·사용 분석을 위해 요청한 쪽의 IP 를 몇 달 보관합니다(https://firebase.google.com/support/privacy). Mac 은 함수 주소로 바로 부릅니다 |
| 대표의 관리 기록 | 배포·비밀 변경 같은 관리 작업은 Google Cloud 감사 로그(`_Required`, 400일, 끌 수 없음)에 남습니다. 사용자 데이터는 아닙니다 |

처리하는 곳: 함수는 `us-central1`(미국 아이오와)에서 돕니다. 알림은 Apple(미국)로 갑니다. 처리하는 회사: Google LLC(Firebase·Google Cloud), Apple Inc.

한도는 최선 노력입니다. 모든 수와 정지는 함수 인스턴스의 메모리에만 있어 인스턴스가 쉬어 내려가거나 다시 배포하면 처음부터 셉니다. 인스턴스 상한(1개)도 Cloud Run 이 요청이 몰릴 때 잠깐 넘길 수 있습니다(https://docs.cloud.google.com/run/docs/configuring/max-instances).

### 주소와 경로(프로토콜 1)

주소는 함수의 Cloud Run 주소입니다. 배포하면 `Function URL (relay(us-central1)): https://relay-…-uc.a.run.app` 처럼 나옵니다(아래 배포 9단계). 그 주소는 이 프로젝트에 묶여 있어 남이 가져갈 수 없습니다.
주소에 지역이 들어가므로 출시한 뒤에는 지역을 바꾸지 않습니다(바꾸는 법은 '운영'). `https://us-central1-<ID>.cloudfunctions.net/relay` 주소도 같은 함수로 가지만, 그 앞단이 손님 IP 를 어떻게 넘기는지 확인하지 못해 쓰지 않습니다.
Mac 서버는 이 주소를 상수 하나(`server/push/relay-url.ts`)로 갖고, `config.json` 의 `pushRelayUrl` 로 덮어쓸 수 있습니다.

| 요청 | 응답 |
|---|---|
| `POST /v1/installations` | `201 {installationId, secret}` (계정·메일 없음, 본문은 보지 않음) · 그 IP 의 하루 몫을 넘으면 `429` · 전체 시간 한도면 `503 relay_busy` |
| `POST /v1/push` `Authorization: Bearer <installationId>.<secret>` 본문 `{token, kind, id, eventId, serverId, target, expiresAt?, summary?}` | `200` 보냄 · `400` 틀린 요청(`expired` 포함) · `401` 자격 없음 · `403` 막힘/허용 목록 밖 · `410` 토큰이 더는 유효하지 않음(Mac 이 지움) · `413` 너무 큼 · `429` 한도(`scope: installation`=이 Mac, `token`=그 iPhone) · `503` 보내지 않음/잠시 못 받음(다시 시도) · `504` 보냈는지 모름(다시 보내지 않음) |
| `GET /healthz` | `200`/`503` `{ok, mode, apns:{suspended, reason, last, lastAt}}` — 사용자 정보 없음 |

설치 만들기의 IP 한도는 Google 앞단이 `X-Forwarded-For` 맨 끝에 붙인 값만 씁니다. 보낸 쪽이 넣은 앞쪽 값은 꾸밀 수 있어 보지 않습니다(`functions/src/settings.ts` 의 `RELAY_CLIENT_IP`). 이 자리는 공식 문서에 없어 배포 9단계에서 확인합니다.
자세한 규칙은 `functions/src/relay.ts` 첫머리에 있습니다. 한도·시간 값은 `functions/src/settings.ts` 한 곳에 있습니다.

### 폴더

```
relay/
  firebase.json            함수(functions/) 설정. Hosting 은 쓰지 않습니다
  .firebaserc.example      프로젝트 ID 를 비운 예시(.firebaserc 는 저장소에 올리지 않음)
  functions/
    src/settings.ts        지역·인스턴스·한도·시간·손님 IP 자리(한 곳)
    src/index.ts           Firebase 함수 선언, 비밀·설정 읽기
    src/relay.ts           경로·인증·한도·응답
    src/apns-sender.ts     APNs 보내기(동시 스트림, 대기 상한, 키 거절 10분 쉼)
    src/limits.ts          메모리 한도
    src/credentials.ts     설치 자격(HMAC)
    src/push-request.ts    요청 검사·페이로드(Mac 과 같은 함수)
    scripts/build.mjs      배포 묶음(lib/index.js) 만들기
    test/                  시험(가짜 APNs HTTP/2 서버)
    .env.example           설정 예시(.env 는 저장소에 올리지 않음)
```

### 시험

Bun 과 Node 22 가 있어야 합니다. 진짜 Apple 서버에는 닿지 않습니다(이 Mac 의 가짜 APNs 로 보냅니다).

```sh
cd relay/functions
bun install --frozen-lockfile
bun test                 # 시험 전체(가짜 APNs·Mac 클라이언트 약속·Node 런타임·기록 누출·배포 설정)
bun run typecheck        # 타입 검사
```

저장소 루트에서 `bash scripts/check.sh relay` 도 같은 것을 돌립니다(CI 도 돌립니다).

### 배포 — 대표가 할 일

순서대로 합니다. 키 내용과 `RELAY_MASTER` 는 화면·대화·저장소·클립보드 어디에도 두지 않습니다.

1. **준비물**: 이 Mac 에 Node 22 와 npm, Firebase CLI(`npm install -g firebase-tools`), Bun.
2. **Firebase 프로젝트 만들기**: https://console.firebase.google.com → 프로젝트 추가. Google 애널리틱스는 끕니다. 프로젝트 ID 는 바꿀 수 없고 지워도 다시 쓸 수 없습니다(예: `iamceo-relay` 처럼 쓸 수 있는 이름).
3. **Blaze 요금제**: 프로젝트 설정 → 사용량 및 결제 → Blaze 로 올립니다(카드 등록). Cloud Functions 는 Blaze 에서만 됩니다.
4. **예산 경보**: Google Cloud 콘솔 → 결제 → 예산 및 알림 → 예산 만들기. 범위는 이 프로젝트, 금액 월 $5, 알림 50%·90%·100%. 예산은 알림만 하고 돈을 막지는 않습니다(아래 '비용').
5. **요청 로그 제외 필터(배포 전에)**: Google Cloud 콘솔 → Logging → 로그 라우터 → `_Default` 싱크 → 수정 → '싱크에서 필터링할 로그 선택' → 제외 추가. 이름 `iamceo-relay-requests`, 필터:
   ```
   resource.type="cloud_run_revision"
   resource.labels.service_name="relay"
   log_id("run.googleapis.com/requests")
   ```
   저장합니다.
6. **APNs 키 만들기**: https://developer.apple.com/account → Certificates, IDs & Profiles → Keys → +. Apple Push Notifications service(APNs)를 켜고 설정에서 환경은 **Production**, 제한은 **Topic Specific**, 토픽은 **com.yehsung.iamceo** 로 고릅니다(화면 이름은 조금 다를 수 있습니다).
   `.p8` 파일은 한 번만 내려받을 수 있습니다. Key ID(10자)를 적어 둡니다. 원본은 비밀번호 관리자나 암호화한 디스크에만 두고, 저장소·`~/.iamceo`·백업·대화에는 두지 않습니다. 팀의 모든 앱에 쓰이는 키(Team Scoped)는 중계에 넣지 않습니다. 새는 일이 생겨도 이 앱의 production 알림에만 쓰이는 키여야 합니다.
   되면 같은 방식으로 '관련 키'를 하나 더 만들어 예비로 둡니다(키 바꾸기용).
7. **이 Mac 에서 준비**:
   ```sh
   cd relay
   cp .firebaserc.example .firebaserc          # "default" 에 프로젝트 ID 를 적습니다
   cp functions/.env.example functions/.env    # APNS_KEY_ID, APNS_TEAM_ID 를 채우고 RELAY_MODE=allowlist 로 둡니다
   firebase login
   ```
8. **비밀 넣기**(값이 화면·클립보드에 나오지 않게, 만들자마자 바로 넘깁니다):
   ```sh
   openssl rand -base64 48 | tr -d '\n' | firebase functions:secrets:set RELAY_MASTER
   firebase functions:secrets:set APNS_KEY_P8 --data-file /경로/AuthKey_<KeyID>.p8
   ```
   첫 줄이 값을 묻는 화면에서 멈추면 Ctrl-C 로 끝내고 지휘자에게 알립니다(값을 손으로 붙여 넣지 않습니다).
9. **배포와 확인**:
   ```sh
   firebase deploy --only functions
   ```
   처음에는 필요한 Google Cloud API 를 켜도록 묻습니다(예). 컨테이너 이미지 보관 기간을 물으면 가장 짧게(1일) 고릅니다.
   끝나면 `Function URL (relay(us-central1)): https://relay-…run.app` 이 나옵니다. 이것이 중계 주소입니다(나중에 `firebase functions:list` 로도 봅니다). 아래 첫 줄에 넣습니다.
   ```sh
   RELAY='https://relay-….run.app'
   curl -s "$RELAY/healthz"
   curl -s -o /dev/null -D - -X POST "$RELAY/v1/installations" | grep -i x-relay-forwarded-count
   ```
   첫 줄이 `"ok":true,"mode":"allowlist"` 이고, 둘째 줄이 `x-relay-forwarded-count: 1` 이면 됩니다(Google 앞단이 손님 IP 를 하나 붙인다는 뜻. 그대로 둡니다).
   `2` 면 `functions/src/settings.ts` 의 `RELAY_CLIENT_IP` 를 `{ forwardedForFromEnd: 2 }` 로 바꿔 다시 배포하고, `0` 이면 지휘자에게 알립니다(그 동안은 IP 한도 없이 전체 시간 한도만 걸립니다). 이 확인은 이 Mac 의 IP 로 설치를 하나 만들어 그날 몫(5)에서 하나를 씁니다.
10. **실제 iPhone 시험(승인 뒤)**: 시험용 Mac 서버(자기 키 `apns.json` 없음, `config.json` 의 `pushRelayUrl` 을 위 주소로)에서 iPhone 알림을 켜고 시험 알림을 한 번 보냅니다.
    처음에는 '허용 설치만' 상태라 받지 않습니다. 그 서버의 IAMCEO 홈에 생긴 `push-relay.json` 에서 **설치 ID 만** 꺼내(`installationId`, 비밀 `secret` 은 꺼내지 않습니다)
    `functions/.env` 의 `RELAY_ALLOWED_INSTALLATIONS` 에 적고 `firebase deploy --only functions` 를 합니다. 시험 서버를 다시 시작한 뒤 확인합니다:
    알림 켜기, 시험 알림이 오고 누르면 홈, 결재 알림이 오고 누르면 결재함, 완료 보고 묶음, 알림 끄기.
    중계를 `off` 로 바꿔 배포하면 앱의 알림 설정에 '알림 서버를 잠시 쓸 수 없습니다'가 보입니다. 다시 `allowlist` 로 바꿔 배포한 뒤에는 **시험 서버를 다시 시작합니다**(다시 시작하지 않으면 Mac 은 중계가 알려 준 대로 최대 1시간 쉬었다가 이어 보냅니다).
    Google Cloud 콘솔 → Logging → 로그 탐색기에서 `resource.labels.service_name="relay"` 로 보아 요청 로그(접속 IP)가 없고, 함수 로그에 토큰·IP 가 없는지 봅니다.
11. **열기**: `functions/.env` 의 `RELAY_MODE=open` → `firebase deploy --only functions`. `/healthz` 가 `"mode":"open"` 이면 끝입니다.
    며칠 뒤 로그 탐색기에서 `jsonPayload.message="relay_hourly"` 줄을 봅니다. `create_xff_1` 이 아닌 `create_xff_…` 가 대부분이거나, `created`(새 설치 수)가 2 이상인데 `create_ip_groups`(서로 다른 IP 묶음 수)가 늘 1이면 손님 IP 자리가 틀린 것이니 지휘자에게 알립니다.
12. **(선택) 살아 있는지 감시**: Google Cloud Monitoring 의 가동 시간 확인으로 중계 주소의 `/healthz` 를 확인하고 실패하면 메일을 받게 합니다(요금은 콘솔에서 확인). `/healthz` 는 키가 거절돼 쉬는 중이거나 `off` 면 503 입니다.

### 운영

모든 변경은 `firebase deploy --only functions` 로 반영합니다. 다시 배포하면 새 인스턴스가 뜨므로 메모리에 있던 한도 수와 정지(오류 예산으로 하루 막은 설치 포함)가 모두 풀립니다.

| 하고 싶은 것 | 방법 | 결과 |
|---|---|---|
| 전체 정지 | `.env` 의 `RELAY_MODE=off` → 배포 | 모든 요청이 503(1시간 뒤 다시). Mac 은 production 보내기를 최대 1시간 쉬고 '알림 서버를 잠시 쓸 수 없습니다'로 보입니다. 다시 켜면 그 Mac 서버를 다시 시작하거나 1시간 안에 이어 보냅니다 |
| 한 설치 막기 | `RELAY_BLOCKED_INSTALLATIONS` 에 설치 ID(쉼표) → 배포 | 그 설치는 403(하루 뒤 다시). 오류 예산으로 하루 정지된 설치는 로그에 `installation_suspended` 로 남습니다. 그 정지는 다음 배포 때 풀리므로, 계속 막아야 하면 그 설치 ID 를 이 목록으로 옮깁니다 |
| APNs 키 바꾸기 | 예비 키로 `firebase functions:secrets:set APNS_KEY_P8 --data-file …`, `.env` 의 `APNS_KEY_ID` 수정 → 배포 → Apple 포털에서 옛 키 폐기 | 사용자는 할 일이 없습니다(토큰은 키와 무관) |
| `RELAY_MASTER` 바꾸기 | 새어 나갔을 때만. `openssl rand -base64 48 \| tr -d '\n' \| firebase functions:secrets:set RELAY_MASTER` → 배포 | 모든 Mac 이 다음 알림 때 401 을 받고 새 설치로 한 번 다시 등록합니다(설치 ID 가 바뀌므로 허용·차단 목록도 새 ID 로). 등록은 시간당 `createPerHour`(1,000)까지라, 활성 Mac 이 그보다 많으면 같은 배포에서 `settings.ts` 의 값을 잠시 올립니다. 그 한도에 걸린 Mac 은 그 시간의 알림을 놓칠 수 있지만 자기 IP 몫은 쓰지 않아 다음 시간에 이어집니다 |
| 지역 바꾸기 | 하지 않는 것이 좋습니다. 꼭 바꾸면: `settings.ts` 의 `RELAY_REGION` → 배포 → 나온 새 주소를 `server/push/relay-url.ts` 에 넣은 Mac 서버 판을 냄 → 옛 서버가 다 올라갈 때까지 옛 지역 함수를 그대로 둠 → 그 뒤 `firebase functions:delete relay --region <옛 지역>` | 주소가 바뀝니다 |
| 한도·시간 바꾸기 | `functions/src/settings.ts` → 배포 | |
| 되돌리기 | 이전 커밋으로 돌아가 다시 배포 | |

키가 거절되면(APNs 403) 중계는 10분 동안 APNs 로 보내지 않고 503 으로 답한 뒤 다시 시도합니다. 영영 멈추지 않습니다. 로그에 `apns_suspended` 한 줄이 남습니다.
프로젝트를 지우지 마십시오. 옛 Mac 서버가 남아 있는 동안 그 주소로 계속 보냅니다.

### 비용(추정)

Blaze 의 무료 사용량(달마다): 호출 200만 번, 400,000 GB-초, 200,000 CPU-초, 인터넷 송신 5GB. Secret Manager 는 비밀 버전 6개·접근 1만 번, Cloud Logging 은 50GiB 까지 무료입니다.
요청 기반 과금이라 요청을 처리하는 동안만 CPU 값을 냅니다. 한 건을 0.3초로 잡은 추정입니다(실측으로 고칩니다).

| 규모 | 달마다 알림 | 예상 |
|---|---|---|
| 사용자 50명 × 하루 30건 | 약 4.5만 | $0 |
| 1,000명 × 30건 | 약 90만 | $0~2 (CPU 가 무료 사용량을 조금 넘을 수 있음) |
| 10,000명 × 50건 | 약 1,500만 | 약 $70 (호출 $5 + 인스턴스가 늘 바쁜 CPU·메모리) |

인스턴스가 최대 1개라 계산(CPU·메모리) 비용은 대체로 한 대 값(늘 바쁘면 월 약 $65)에 묶입니다. 보장은 아닙니다: Cloud Run 은 요청이 몰릴 때 상한을 잠깐 넘길 수 있습니다. 호출 수 요금(100만 번당 $0.40)과 송신은 이 상한 밖이라, 누가 주소에 요청을 퍼부으면 늘 수 있습니다(예산 경보로 압니다). 단가는 Google Cloud 가격표 기준(Tier 1, CPU $0.000024/vCPU-초, 메모리 $0.0000025/GiB-초, 호출 100만 번당 $0.40)이며 배포 전에 콘솔에서 다시 확인합니다.

---

## English

### What it is

Sending a notification to the App Store build of the IAMCEO iPhone app needs the app's Apple push key, which only the developer has.
A Mac running IAMCEO without its own key hands each notification to this relay, which builds the fixed-text notification and sends it to Apple (APNs).

- Sent per notification: the iPhone push token, the notification kind, random identifiers (delivery, event and server IDs, and the IDs of the screen to open), an expiry time.
- Never sent: conversations, decision or report text, project or team names, access codes, accounts or email.

The relay is one Cloud Functions for Firebase function (2nd gen, Node 22) named `relay`. It stores nothing on disk or in a database.
The notification text and the bundle ID (`com.yehsung.iamceo`) are fixed in the relay's code, so it cannot be used to send other text or to other apps.
The payload is built by the same function the Mac uses when sending with its own key (`server/push/apns.ts`), byte for byte.

### What it receives and what it keeps

| Item | Handling |
|---|---|
| Push token, identifiers, expiry | In memory while the request is handled, then discarded after APNs answers. Never stored or logged |
| Installation credential | Not stored. The secret is the installation ID signed with a server secret (`RELAY_MASTER`) and is recomputed on every request |
| Abuse counters (per installation, iPhone, IP) | Memory only. Tokens and IPs are counted only as an HMAC under a random in-memory key that changes daily; IPs are counted only when an installation is created (once per Mac). Gone when the instance idles out, on every deploy, and when the day changes |
| Function logs | One hourly line of totals, and error lines with the installation ID, the APNs reason code and the time. No tokens, IPs, Authorization or bodies (`test/no-leak.test.ts`) |
| Google's automatic request logs | Cloud Run writes a request log (client IP, path, user agent, status, latency) for every request and it cannot be turned off in Cloud Run. Step 5 below adds an **exclusion filter** so they are not stored (Logging receives and drops them). Without it they are kept for 30 days |
| Firebase Hosting | Not used. Hosting keeps the IP addresses of incoming requests for a few months for abuse detection and usage analysis (https://firebase.google.com/support/privacy). Macs call the function's own address |
| Administrator activity | Deploys and secret changes go to Google Cloud audit logs (`_Required`, 400 days, cannot be disabled). No user data |

Location: the function runs in `us-central1` (Iowa, USA); notifications go to Apple (USA). Processors: Google LLC (Firebase, Google Cloud) and Apple Inc.

Limits are best effort. Every counter and suspension lives in the instance's memory and starts over when the instance idles out or is redeployed, and Cloud Run can briefly exceed the one-instance cap during traffic spikes (https://docs.cloud.google.com/run/docs/configuring/max-instances).

### Address and endpoints (protocol 1)

The address is the function's Cloud Run URL, printed by the deploy as `Function URL (relay(us-central1)): https://relay-…-uc.a.run.app` (step 9). It is bound to this project, so nobody else can take it.
The region is part of the address, so do not change the region after release (see Operations). The `https://us-central1-<id>.cloudfunctions.net/relay` address reaches the same function, but how its front end passes the client IP is not documented, so it is not used.
The Mac server keeps the address as one constant (`server/push/relay-url.ts`), overridable with `pushRelayUrl` in `config.json`.
Endpoints and status codes are listed in the Korean table above and in the header of `functions/src/relay.ts`. Limits and timeouts live in `functions/src/settings.ts`.
The per-IP limit on creating installations uses only the value Google's front end appends at the end of `X-Forwarded-For`; earlier values can be forged by the sender and are ignored (`RELAY_CLIENT_IP` in `functions/src/settings.ts`). That position is not in the official documentation, so step 9 checks it.

### Tests

Needs Bun and Node 22. Nothing reaches Apple; tests use a fake APNs HTTP/2 server on this Mac.

```sh
cd relay/functions
bun install --frozen-lockfile
bun test
bun run typecheck
```

`bash scripts/check.sh relay` at the repository root runs the same (CI runs it too).

### Deploy — owner steps

Never put key content or `RELAY_MASTER` on screen, in a chat, in the repository or on the clipboard.

1. Install Node 22 and npm, the Firebase CLI (`npm install -g firebase-tools`) and Bun.
2. Create a Firebase project (Analytics off). Its ID cannot change and is never reused after deletion.
3. Upgrade to the Blaze plan (card required; Cloud Functions needs Blaze).
4. Create a budget alert in Google Cloud Billing (this project, $5/month, 50/90/100%). Budgets only alert; they do not stop spending.
5. Before deploying, add an exclusion to the `_Default` log sink (Logging → Log Router) named `iamceo-relay-requests` with the filter shown in the Korean section.
6. Create the APNs key in the Apple developer portal: APNs, environment **Production**, restriction **Topic Specific**, topic **com.yehsung.iamceo**. Download the `.p8` once, note the Key ID, keep the original offline. Never upload a team-scoped key: if this key leaks it must only reach this app's production notifications. Optionally create a related backup key.
7. `cd relay && cp .firebaserc.example .firebaserc` (set the project ID), `cp functions/.env.example functions/.env` (Key ID, Team ID, `RELAY_MODE=allowlist`), `firebase login`.
8. Secrets, generated and handed over in one pipe: `openssl rand -base64 48 | tr -d '\n' | firebase functions:secrets:set RELAY_MASTER`, then `firebase functions:secrets:set APNS_KEY_P8 --data-file /path/AuthKey_<KeyID>.p8`. If the first command stops at a prompt for the value, press Ctrl-C and ask; never paste the value by hand.
9. `firebase deploy --only functions`. Accept enabling the APIs; choose the shortest image retention if asked. The output's `Function URL (relay(us-central1))` is the relay address (`firebase functions:list` shows it later). Check `curl -s <address>/healthz` (`"ok":true,"mode":"allowlist"`) and `curl -s -o /dev/null -D - -X POST <address>/v1/installations | grep -i x-relay-forwarded-count`: `1` means Google appends one client IP (keep the setting); `2` means set `RELAY_CLIENT_IP` to `{ forwardedForFromEnd: 2 }` and redeploy; `0` means ask (until then only the hourly limit applies). This check creates one installation from this Mac's IP (one of the day's five).
10. Real iPhone test (after approval): a test Mac server without `apns.json`, with `pushRelayUrl` in `config.json` set to the address. Copy only the `installationId` from its `push-relay.json` into `RELAY_ALLOWED_INSTALLATIONS`, redeploy functions, restart the test server, then check enabling, the test notification, a decision notification and its tap target, report grouping and turning notifications off. Switch the relay to `off` and redeploy: the app's notification settings show "The notification service is temporarily unavailable". After switching back and redeploying, **restart the test server** (otherwise the Mac waits up to an hour, as the relay told it, before sending again). Check that Logs Explorer shows no request logs and no tokens or IPs.
11. Open it: `RELAY_MODE=open`, `firebase deploy --only functions`. A few days later check the `relay_hourly` lines: if most creations are counted under a `create_xff_…` other than `create_xff_1`, or `created` is above 1 while `create_ip_groups` stays 1, the client IP position is wrong; ask before changing anything.
12. Optional: a Cloud Monitoring uptime check on `<address>/healthz` (503 while the key is rejected or the relay is off).

### Operations

Every change is applied with `firebase deploy --only functions`. A deploy starts a new instance, which clears every in-memory counter and suspension (including installations suspended for a day by the error budget).

- Stop everything: `RELAY_MODE=off`. Requests get 503 (retry in an hour); Macs pause production sending for up to an hour. After turning it back on, a Mac resumes within the hour or at once when its server restarts.
- Block an installation: add its ID to `RELAY_BLOCKED_INSTALLATIONS`. An error-budget suspension is logged as `installation_suspended` and is lifted by the next deploy; to keep that installation blocked, move its ID to this list.
- Rotate the APNs key: set the backup key with `firebase functions:secrets:set APNS_KEY_P8 --data-file …`, update `APNS_KEY_ID`, deploy, then revoke the old key. Users do nothing.
- Rotate `RELAY_MASTER` only if it leaked: `openssl rand -base64 48 | tr -d '\n' | firebase functions:secrets:set RELAY_MASTER`, deploy. Every Mac gets 401 on its next notification and registers once as a new installation (allow and block lists need the new IDs). Registrations are capped at `createPerHour` (1,000) an hour; with more active Macs, raise it temporarily in the same deploy. A Mac caught by that cap can miss that hour's notifications but keeps its per-IP allowance and continues the next hour.
- Region: better not to change it. If you must: change `RELAY_REGION`, deploy, ship a Mac server release with the new address in `server/push/relay-url.ts`, keep the old function until old servers are upgraded, then `firebase functions:delete relay --region <old region>`. The address changes.
- On an APNs 403 the relay stops sending for 10 minutes, answers 503, then tries again; it never stops for good. Do not delete the project while old Mac servers may still call it.

### Cost (estimate)

Blaze no-cost usage per month: 2M invocations, 400,000 GB-seconds, 200,000 CPU-seconds, 5 GB egress. About $0 for 50 users, $0–2 for 1,000 users, about $70 for 10,000 users at 50 notifications a day. One instance keeps compute at roughly one always-busy instance (about $65 a month), though Cloud Run can briefly exceed the cap; per-invocation fees ($0.40 per million) and egress are outside that cap, which is why the budget alert matters. Unit prices: Tier 1 request-based billing; confirm in the console before deploying.

### Official documents checked (2026-11-13)

- Cloud Functions for Firebase: locations, runtime options (max instances queue 30 s then 429, concurrency needs a full CPU), secrets (`defineSecret`, stdin pipe and `--data-file`, redeploy after change, 10,000 free accesses), quotas, FAQ (Blaze required, no-cost tier).
  https://firebase.google.com/docs/functions/locations · /manage-functions · /config-env · /quotas · /faq-and-troubleshooting
- Firebase pricing: https://firebase.google.com/pricing
- Firebase privacy and security (Hosting keeps request IPs for a few months; Cloud Functions only temporarily): https://firebase.google.com/support/privacy
- Cloud Run: container contract (outbound idle timeout 20 min, connections may be reset), billing settings (request-based: CPU only during requests), logging (request logs automatic, use exclusions), max instances (can be exceeded briefly).
  https://docs.cloud.google.com/run/docs/container-contract · /run/docs/configuring/billing-settings · /run/docs/logging · /run/docs/configuring/max-instances
- Cloud Logging: routing and exclusions, `_Required` 400 days, `_Default` 30 days. https://docs.cloud.google.com/logging/docs/routing/overview · /logging/docs/store-log-entries
- Cloud Run functions build: `npm run build` runs on deploy unless `gcp-build` is empty. https://docs.cloud.google.com/run/docs/runtimes/nodejs
- Project IDs are permanent and never reused: https://docs.cloud.google.com/resource-manager/docs/delete-restore-projects
- Client IP in `X-Forwarded-For` on Cloud Run: not in the official documentation. A Google developer forum thread reports the front end appending one value at the end (https://discuss.google.dev/t/cloud-run-which-client-ip-can-i-safely-use-for-rate-limiting/409611); step 9 checks it on the real deployment.
