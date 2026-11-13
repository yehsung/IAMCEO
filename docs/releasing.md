# 릴리스 절차

Mac 앱과 iPhone 앱을 내보내는 순서를 한 장에 적었습니다. 스크립트가 해 주는 단계와 사람이 직접 해야 하는 단계를 구분해 두었습니다. 비밀 값(키 파일, 키 ID, 발급자 ID, 연락처)은 이 문서와 저장소 어디에도 적지 않습니다. 필요한 환경 변수의 이름만 적습니다. 팀 ID는 비밀이 아닙니다. 서명한 앱에 드러나는 공개 값이라 설치 스크립트(`install.sh`)의 서명 확인과 `native/project.yml`에 들어 있습니다. 다만 릴리스 도구와 이 문서에는 적지 않고 환경 변수로 받습니다.

## 한눈에 보기

| 단계 | Mac | iPhone | 누가 |
|---|---|---|---|
| 버전 올리기 | 같은 커밋 | 같은 커밋 | 사람 |
| 태그 만들고 올리기 | `git tag`, `git push` | 필요 없음 | 사람 |
| CLI 자산과 초안 릴리스 | `release.yml` | 해당 없음 | 자동 |
| 빌드·서명·올리기 | `scripts/release-mac.ts` (공증한 DMG 안의 서버를 실제로 띄워 본 뒤에만 올림) | `scripts/release-ios.ts upload` | 스크립트 |
| 실제로 깔아서 확인 | DMG 설치 | TestFlight 설치 | 사람 |
| 공개 | `gh release edit` 또는 `--publish` | App Store Connect에서 버전 만들기 → `release-ios.ts submit` → 심사 → 출시 | 사람 + 스크립트 |
| 공개 뒤 | Homebrew tap: `--publish`가 git으로 함께 올림(실패하면 `--tap-only`) | README 링크 확인 | 스크립트 + 사람 |

두 스크립트 모두 **커밋된 내용만** 빌드합니다(`git archive`). 작업 폴더에만 있는 변경은 들어가지 않으니 먼저 커밋합니다.

## 1. 버전 올리기

버전의 기준은 `package.json` 하나입니다. 같은 숫자가 아래 세 곳에 더 적혀 있어서 함께 바꿉니다.

| 파일 | 위치 |
|---|---|
| `package.json` | `version` (기준) |
| `native/project.yml` | `MARKETING_VERSION` 두 곳 (공통 설정, iPhone 타깃) |
| `packaging/homebrew/Casks/iamceo.rb` | `version` |

한 곳이라도 다르면 `tests/w1-tooling-version.test.ts`가 실패합니다. 바꾼 뒤 바로 확인합니다.

실행 파일을 컴파일하는 Bun의 버전은 `.bun-version` 한 곳에 적습니다. CI(서버 시험, CLI 자산을 만드는 `release.yml`)는 이 파일로 Bun을 설치하고, `release-mac.ts`는 이 파일과 지금 Bun이 다르면 빌드하지 않습니다. 그래서 한 릴리스의 CLI 자산과 DMG 안 서버가 같은 Bun으로 만들어집니다. Bun을 올릴 때는 이 파일만 바꾸고, 감독자 Mac의 Bun도 같은 버전으로 맞춥니다.

```sh
bash scripts/check.sh server tests/w1-tooling-version.test.ts
```

실제 앱에 들어가는 버전은 빌드할 때 `package.json` 값으로 넣습니다. Mac은 `scripts/build-native.ts`가 빌드한 앱에 써넣고, iPhone은 `scripts/release-ios.ts`가 `xcodebuild`에 넘깁니다. 그래서 `native/Configuration`의 plist는 실제 버전을 담지 않습니다. iPhone plist는 빌드 설정(`$(MARKETING_VERSION)`, `$(CURRENT_PROJECT_VERSION)`)을 참조합니다. Mac plist의 버전 `1.0`은 자리만 채운 값이고, `build-native.ts`가 빌드한 앱에 실제 버전을 써넣습니다(빌드 번호 `1`은 그대로 둡니다). 저장소의 plist에서 이 숫자를 고칠 필요는 없습니다.

`native/Configuration/iOS-Info.plist`와 `macOS-Info.plist`는 XcodeGen이 `native/project.yml`에서 만드는 파일입니다. `project.yml`의 앱 정보(권한 문구 등)를 바꿨다면 `native` 폴더에서 `xcodegen generate`를 돌리고 바뀐 plist를 함께 커밋합니다. 어긋나면 같은 시험이 실패합니다.

## 2. Mac 릴리스

### 준비물

- Apple Silicon Mac, Xcode, XcodeGen, `gh`(GitHub 로그인 상태), `.bun-version`과 같은 버전의 Bun
- `--publish`로 Homebrew tap까지 올릴 때: tap 저장소에 `git push`할 수 있는 상태(HTTPS면 `gh auth setup-git` 한 번)
- 환경 변수

| 이름 | 내용 |
|---|---|
| `SIGN_IDENTITY` | 키체인에 있는 Developer ID Application 인증서 이름 전체 |
| `NOTARY_KEY_PATH` | 공증용 App Store Connect API 키 파일(.p8) 경로 |
| `NOTARY_KEY_ID` | 그 키의 ID |
| `NOTARY_ISSUER` | 발급자 ID |
| `TAP_GIT_NAME`, `TAP_GIT_EMAIL` | (선택) tap 커밋의 작성자. 주지 않으면 릴리스 커밋의 작성자를 씁니다. 주소는 GitHub noreply 주소(`…@users.noreply.github.com`)만 받습니다 |
| `TAP_REMOTE` | (선택) tap 저장소 주소. 기본은 `https://github.com/yehsung/homebrew-tap.git` |

### 순서

1. **(사람)** 버전을 올린 커밋을 `main`에 올리고 CI가 통과했는지 확인합니다. CI는 서버 시험(`server`), 앱 시험(`native`), 앱 빌드(`apps`) 세 작업이고, 모두 통과해야 초록입니다(§6). 앱 시험과 앱 빌드는 릴리스를 빌드하는 것과 같은 Xcode 27.2로 돕니다(GitHub의 `xcode-27` 이미지). `native` 작업은 끝에 출시 앱 호환 검사(§5)도 돌립니다.
2. **(사람)** 태그를 만들어 올립니다.
   ```sh
   git tag v0.0.0 && git push origin v0.0.0
   ```
3. **(자동)** `.github/workflows/release.yml`이 먼저 출시 앱 호환 검사(`compat` 작업, §5)를 돌리고, 통과하면 태그와 `package.json` 버전이 같은지 보고, 타입 검사와 서버 시험을 돌린 뒤, CLI 실행 파일 두 개와 `SHA256SUMS`를 붙인 **초안(draft)** 릴리스를 만듭니다. 초안은 "최신 릴리스"를 바꾸지 않습니다.
   - 워크플로가 실패하면 원인을 고친 뒤 `gh workflow run release.yml --ref v0.0.0`으로 다시 돌립니다.
4. **(스크립트)** 먼저 무엇을 할지 봅니다. 아무것도 만들거나 올리지 않습니다.
   ```sh
   bun scripts/release-mac.ts --ref v0.0.0 --dry-run --upload
   ```
5. **(스크립트)** 빌드, 서명, 공증, DMG 만들기, 초안에 올리기까지 한 번에 합니다.
   ```sh
   bun scripts/release-mac.ts --ref v0.0.0 --upload
   ```
   - 그 커밋의 CI(`ci` 또는 `release`)가 성공해 있어야 올립니다. `--allow-untested`로 건너뛸 수 있지만, 실패 원인이 코드가 아니라는 것을 확인했을 때만 쓰고 릴리스 기록에 남깁니다.
   - 앱 시험(`check.sh swift`)을 빌드 전에 돌립니다. `--skip-tests`는 같은 조건에서만 씁니다.
   - 지금 Bun이 그 커밋의 `.bun-version`과 다르면 빌드하지 않습니다.
   - 공증·스테이플을 마친 DMG를 읽기 전용으로 마운트하고, 그 안의 서버(`IAMCEO.app/Contents/Resources/runtime/iamceo`)를 launchd가 띄우는 방식 그대로(감독 프로세스와 로그) 띄워 봅니다. 임시 홈, 포트 0, 가짜 CLI를 쓰고 실행 엔진은 없습니다. `/api/readiness`가 그 파일의 SHA-256을 build ID로, 릴리스 버전을 버전으로 알리고, 인증된 읽기가 되고, SIGTERM에 깨끗이 멈춰야 합니다. 하나라도 어긋나면 아무것도 올리지 않고 멈춥니다. 결과는 단계마다 한 줄씩 찍힙니다.
   - 결과물은 `dist/release/`에 남습니다: `IAMCEO-버전-arm64.dmg`, `SHA256SUMS`, `iamceo.rb`.
6. **(사람)** 초안에 올라간 DMG를 받아 직접 깔아 봅니다. 기존 데이터 위에 올리기 전에는 DB 사본으로 먼저 띄워 봅니다.
   ```sh
   bun run smoke:db <iamceo.db 경로>
   ```
7. **(사람)** 공개합니다.
   ```sh
   gh release edit v0.0.0 --repo yehsung/IAMCEO --draft=false --latest
   ```
   확인을 이미 마쳤다면 5번에서 `--upload --publish`를 함께 줘도 됩니다. 한번 공개한 릴리스의 파일은 스크립트가 덮어쓰지 않습니다.
8. **(스크립트)** Homebrew tap에 cask를 올립니다. `--publish`는 공개한 뒤 이어서 tap 저장소를 받아 `Casks/iamceo.rb`를 `dist/release/iamceo.rb`(버전과 SHA-256이 채워진 파일)로 바꾸고, GitHub noreply 주소로 커밋해 `git push`합니다. 이미 같은 cask가 있으면 아무것도 올리지 않습니다.
   - GitHub contents API(`gh api … /contents/…`)로 올리지 않습니다. 작성자를 주지 않으면 계정의 실제 메일 주소가 공개 커밋에 찍힙니다.
   - 7번처럼 `gh release edit`로 직접 공개했거나 tap 단계만 실패했다면 그 단계만 다시 합니다. 릴리스가 공개 상태이고 `dist/release/iamceo.rb`의 SHA-256이 릴리스의 `SHA256SUMS`와 같아야 올립니다.
     ```sh
     bun scripts/release-mac.ts --ref v0.0.0 --tap-only --dry-run
     bun scripts/release-mac.ts --ref v0.0.0 --tap-only
     ```
   - 저장소 안의 `packaging/homebrew/Casks/iamceo.rb`는 틀이라서 그대로 올리면 안 됩니다. 스크립트가 만든 cask에는 틀의 머리 주석이 없습니다.
9. **(사람)** 공개 뒤 두 경로를 각각 확인합니다.
   ```sh
   brew upgrade --cask yehsung/tap/iamceo
   curl -fsSL https://raw.githubusercontent.com/yehsung/IAMCEO/main/install.sh | sh
   ```

### install.sh가 확인하는 것

`install.sh`는 `main` 브랜치의 파일을 그대로 받아 실행하므로, 고친 내용은 `main`에 올라간 순간부터 적용됩니다. 받은 DMG에 대해 다음을 차례로 확인하고, 하나라도 실패하면 설치를 멈추고 이전 앱을 그대로 둡니다.

1. `SHA256SUMS`와 체크섬이 같은지
2. 앱의 서명이 배포자의 Developer ID 인증서인지 (`codesign`, 스크립트 안의 `SIGN_REQUIREMENT`)
3. Apple 공증을 통과한 앱인지 (`spctl`)

**서명 인증서의 팀이나 Mac 앱의 번들 ID를 바꾸면 `install.sh`의 `SIGN_REQUIREMENT`도 같은 릴리스에서 함께 바꿔야 합니다.** 그렇지 않으면 새 버전 설치가 모두 거절됩니다. 번들 ID가 어긋나면 `tests/w1-tooling-install.test.ts`가 실패합니다.

## 3. iPhone 릴리스

### 준비물

- Mac, Xcode, XcodeGen, Bun
- Apple Developer Program의 최신 약관에 동의한 상태(동의가 밀려 있으면 올리기가 거절됩니다)
- App Store Connect API 키. 서명 프로파일을 자동으로 만들 수 있는 권한이 있어야 합니다.
- 환경 변수

| 이름 | 내용 | 쓰는 명령 |
|---|---|---|
| `ASC_KEY_PATH` | App Store Connect API 키 파일(.p8) 경로 | 전부 |
| `ASC_KEY_ID` | 그 키의 ID | 전부 |
| `ASC_ISSUER_ID` | 발급자 ID | 전부 |
| `APPLE_TEAM_ID` | Apple 개발자 팀 ID | `upload` |

스크립트는 이 값들을 화면에 찍지 않습니다. `--dry-run`은 키 파일을 읽지 않고 네트워크에도 연결하지 않습니다.

### 빌드 번호 규칙

빌드 번호는 올리는 시각의 **연월일시 10자리**입니다(예: 2026년 11월 10일 17시 → `2026111017`). 항상 커지므로 App Store Connect가 새 빌드로 받습니다. 같은 시간 안에 한 번 더 올려야 하면 `--build`로 더 큰 숫자를 직접 줍니다.

### 순서

1. **(사람)** 버전을 올린 커밋이 있는지 확인합니다. 올릴 커밋을 `--ref`로 고를 수 있고, 생략하면 `HEAD`입니다.
2. **(스크립트)** 먼저 무엇을 할지 봅니다.
   ```sh
   bun scripts/release-ios.ts upload --dry-run
   ```
3. **(스크립트)** 아카이브하고 올립니다. 끝나면 빌드 번호를 알려 줍니다.
   ```sh
   bun scripts/release-ios.ts upload
   ```
   - 아카이브에 들어간 버전과 빌드 번호가 기대와 다르면 올리지 않고 멈춥니다.
4. **(사람)** Apple이 빌드를 처리할 때까지 기다립니다(보통 5~30분). TestFlight 앱으로 iPhone에 깔아 연결, 대화, 알림, 보내기를 직접 확인합니다. 출시된 이전 버전 앱이 새 서버와 계속 맞는지도 이때 봅니다.
5. **(사람)** App Store Connect에서 새 버전을 만듭니다. 스크립트는 이 단계를 대신하지 않습니다.
   - 버전 번호(`package.json`과 같게)
   - "이 버전의 새로운 기능" 문구
   - 화면이 바뀌었다면 스크린샷. 올리기는 스크립트로 할 수 있습니다.
     ```sh
     bun scripts/release-ios.ts screenshots --localization <현지화 ID> --display-type <종류> 1.png 2.png
     ```
     기존 스크린샷을 지우지 않고 뒤에 덧붙이므로, 바꿀 때는 App Store Connect에서 옛것을 먼저 지웁니다.
   - 심사 정보(연락처와 심사 메모). App Store Connect에 직접 적고 저장소에는 두지 않습니다.
   - 출시 방식(심사 통과 뒤 수동 출시 또는 자동 출시)
6. **(스크립트)** 심사에 제출합니다. 빌드 처리가 끝나기를 기다렸다가(30초 간격, 최대 45분) 그 버전에 붙이고 제출합니다.
   ```sh
   bun scripts/release-ios.ts submit --build 2026111017 --dry-run
   bun scripts/release-ios.ts submit --build 2026111017
   ```
   - 버전이 App Store Connect에 없으면 아무것도 바꾸지 않고 멈춥니다.
   - 빌드 처리가 실패했거나 같은 번호의 빌드가 둘이면 붙이지 않고 멈춥니다.
   - 이전에 제출하다 만 심사 건이 열려 있으면 Apple이 거절합니다. App Store Connect에서 그 건을 정리한 뒤 다시 돌립니다.
7. **(사람)** 심사 결과를 기다립니다. 반려되면 App Store Connect의 사유를 읽고 고친 뒤 3번부터 다시 합니다(빌드 번호는 새로 받습니다). 제출을 거두는 것도 App Store Connect에서 합니다.
8. **(사람)** 통과하면 출시합니다(수동 출시로 뒀다면 버튼을 누릅니다). 스토어에 새 버전이 보이는지, README의 App Store 링크가 맞는지 확인합니다.

### 그 밖의 App Store Connect 작업

스크립트에 없는 조회나 수정은 API를 직접 부를 수 있습니다. 응답을 그대로 보여 줍니다.

```sh
bun scripts/release-ios.ts api GET '/v1/apps?fields[apps]=bundleId'
```

앱을 처음 등록할 때만 하는 일(앱 정보, 개인정보 처리방침 주소, 연령 등급, 개인정보 수집 항목 답변, 은행·세금 정보)은 App Store Connect에서 사람이 합니다.

## 4. 두 플랫폼을 함께 낼 때

- iPhone 심사는 며칠 걸릴 수 있고, 사용자는 앱을 제때 올리지 않습니다. 서버(=Mac 앱에 들어 있는 것)는 출시된 이전 iPhone 앱과도 맞아야 합니다. 서버 응답에는 선택 항목을 더하기만 하고 기존 항목의 이름과 형식은 바꾸지 않습니다.
- 새 iPhone 앱이 새 서버 기능에 기대면, Mac 릴리스를 먼저 공개하고 iPhone 출시를 그 뒤에 합니다(수동 출시로 두면 순서를 맞추기 쉽습니다).

## 5. 출시된 앱과의 호환 확인

- `bash scripts/check.sh compat`(`bun run test:compat`)은 새 서버의 실제 응답을 출시된 앱(태그마다)의 해석 코드로 풀어 봅니다. `bash scripts/check.sh`(전체)에도 들어 있습니다. 출시 태그를 git에서 읽으므로 태그가 있는 저장소에서 돌립니다(태그가 없으면 건너뛰지 않고 실패합니다).
- CI는 `ci.yml`의 `native` 작업과 `release.yml`의 `compat` 작업에서 이 검사를 돌립니다. 둘 다 Xcode 27.2(`xcode-27` 이미지)를 쓰고, 태그를 받으려고 `actions/checkout`에 `fetch-depth: 0`을 줍니다. `release.yml`은 이 검사가 실패하면 초안을 만들지 않습니다.
- 새 앱을 출시하면 그 태그를 `scripts/compat-decoders/releases.json`에 더합니다(그 태그에서 따로 빌드할 해석 코드 파일 목록과 함께).
- 앱은 모든 요청에 `X-IAMCEO-App-Version`, `X-IAMCEO-App-Build`, `X-IAMCEO-App-Platform`(macos|ios), `X-IAMCEO-Api-Level`을 붙입니다. 서버는 머리글을 보낸 앱에만 Bootstrap의 `server`(버전·API 단계)를 싣고, 실제로 맞지 않을 때만 `compat`을 싣습니다. 붙은 앱 목록은 `/api/readiness`의 `apps`에 보입니다.
- 서버와 앱이 서로 알아야 하는 것이 바뀌어 API 단계를 올릴 때는 `shared/types.ts`의 `API_LEVEL`(필요하면 `MIN_APP_API_LEVEL`)과 앱의 `AppVersion.apiLevel`을 함께 올립니다. `MIN_APP_API_LEVEL`을 올리면 그보다 낮은 앱에 '앱을 업데이트하세요'가 뜨므로, 출시된 앱이 실제로 깨질 때만 올립니다.

## 6. 시험과 CI

- CI(`.github/workflows/ci.yml`)는 `main`·`native-redesign`에 올릴 때와 그 두 가지로 가는 PR마다 돕니다. 작업은 서버 시험(`server`), 알림 중계 시험(`relay`, `check.sh relay`: `relay/functions`의 타입 검사와 시험, Node 22), 앱 시험(`native`, `check.sh swift`), 앱 빌드(`apps`, `check.sh build`: Mac·iPhone 앱을 서명 없이 컴파일) 넷이고, 모두 통과해야 초록입니다.
- **iPhone 시험은 로컬에서만 돕니다.** `bash scripts/check.sh ios`가 같은 앱 시험(`native/Tests`)을 iPhone 시뮬레이터에서 돌립니다(`native/project.yml`의 `IAMCEO-iOS-Tests`). Mac에서만 되는 시험은 `#if os(macOS)` 안에 두고, iPhone 전용 경로(입력칸, 배경 복귀, 알림 탭)는 `IPhoneOnlyTests.swift`가 봅니다. `bash scripts/check.sh`(전체)에도 들어 있고, iPhone 시뮬레이터가 없는 Mac에서는 건너뛰었다고 알립니다.
  - 시뮬레이터는 이 Mac에 있는 것에서 고릅니다. `IAMCEO_IOS_SIMULATOR`(이름이나 UDID)를 주면 그것을, 아니면 이름이 `iPhone `으로 시작하는 기기 중 꺼져 있는 것(쓰는 중일 수 있는 켜진 기기는 뒤로)을 가장 새 iOS부터 고릅니다.
  - 부팅은 `xcodebuild`가 합니다. 이미 켜져 있던 시뮬레이터는 끄거나 지우지 않고, 이 단계가 켠 기기만 끝나면 끕니다. 도중에 Ctrl-C나 종료 신호로 끊겨도 `xcodebuild`를 멈추고 켠 기기를 끕니다.
  - 이 Mac에서 두 실행이 겹치면 뒤의 것이 기다립니다(고르기부터 끄기까지 이 Mac 전체의 잠금 `/tmp/iamceo-check-ios.lock`, `IAMCEO_IOS_LOCK`으로 바꿈, 기다리는 시간 `IAMCEO_IOS_LOCK_WAIT_S` 기본 3600초). 같은 기기를 고른 두 실행 중 먼저 끝난 쪽이 다른 쪽의 기기를 끄는 일을 막습니다. 강제로 끝난 실행이 남긴 잠금은 그 프로세스가 없으면 치웁니다.
  - 실패하면 실패한 시험의 이름과 함께 오류 줄(assert 문구와 `파일:줄`)을 보이고, 전체 기록 파일의 경로를 알립니다.
  - 시험을 품는 앱은 출시 앱과 소스가 같고 번들 ID만 다른 시험 전용 앱입니다. 시뮬레이터에 깔린 출시 앱의 저장된 연결이나 키체인을 건드리지 않습니다.
  - 실패한 시험만 한 번 더 돌려 통과하면 FLAKY로 남깁니다(`IAMCEO_TEST_RETRY=0`이면 다시 돌리지 않습니다).
  - CI에 넣지 않은 이유: CI의 `xcode-27` 이미지에 어떤 iPhone 시뮬레이터가 있는지 확인하지 못했습니다. 넣으려면 그 이미지에서 `xcrun simctl list devices available`을 먼저 확인하고, 로컬에서 세 번 연속 통과하는지 본 뒤 막는 작업으로 더합니다.
