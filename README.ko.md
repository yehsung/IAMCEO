# IAMCEO

여러 Claude Code·Codex 에이전트에게 병렬로 일을 맡기고, 홈·결재함·팀·대화·자료에서 확인하는 네이티브 업무 창구입니다. Mac과 iPhone은 각각 Mac의 IAMCEO 데몬에 직접 연결합니다.

이번 작업 트리는 **SwiftUI 앱 + 단일 herdr-core 실행기**로 전환합니다. 기존 공개 릴리스와는 다를 수 있습니다. Herdr/headless 코드는 기존 데이터와 회귀 검증을 위해 남아 있지만 실행 방식 선택은 제공하지 않습니다.

## Mac에서 시작

macOS 14 이상, Swift 6을 제공하는 Xcode, XcodeGen, Bun 1.3 이상과 사용할 공식 Claude/Codex CLI의 설치·로그인이 필요합니다. 최신 Liquid Glass 시스템 효과는 macOS/iOS 26 이상에서 사용하고 이전 OS에서는 material로 표시합니다.

```sh
bun install
bun run build:native
open dist/native/IAMCEO.app
```

앱에서 **이 Mac에서 시작**을 누르면 내장한 데몬을 launchd 서비스로 등록합니다. 앱을 안정적인 위치에 둔 다음 시작하세요. 이미 정상 동작하는 IAMCEO에는 연결하고, 다른 설치와 충돌하면 자동으로 덮어쓰지 않습니다. 빌드만으로 서비스를 설치하거나 실행하지 않습니다. 현재 결과물은 로컬 임시 서명이며 공증된 배포본이 아닙니다.

Herdr Core.app은 고정 버전·체크섬·서명을 확인해 앱 안에 포함합니다. 사용자가 Herdr를 별도로 설치할 필요는 없습니다. Claude/Codex CLI와 계정 로그인은 사용자가 준비합니다.

```sh
# 연결 없이 화면만 확인하는 읽기 전용 샘플
open -n dist/native/IAMCEO.app --args --demo

# 앱 없이 소스에서 서버 실행
bun run setup:core
bun run start
# 별도 터미널: 주소와 접속 코드 확인
bun bin/iamceo.ts open
```

데이터는 `~/.iamceo`에 둡니다. 기존 DB를 바꾸기 전 일관된 SQLite 백업을 만들고, 백업에 실패하면 마이그레이션도 중단합니다. 기존 Herdr 세션을 강제로 닫거나 편입하지 않습니다.

## iPhone에서 연결

`xcodegen generate --spec native/project.yml`로 프로젝트를 만들고 IAMCEO-iOS 스킴을 선택합니다. 실기기 설치에는 Apple 개발 팀·서명 설정이 필요합니다. 자세한 명령은 [네이티브 안내](native/README.md)에 있습니다.

Mac과 iPhone에 Tailscale을 연결하고, **Tailscale Serve HTTPS**로 Mac의 `http://127.0.0.1:7878`을 프록시합니다. iPhone 앱에 HTTPS 주소와 IAMCEO 접속 코드를 입력합니다. 원격 네이티브 연결에는 HTTPS가 필요하며 `http://100.x.y.z`와 폰의 localhost는 사용할 수 없습니다. 접속 코드는 기기 Keychain에 보관합니다.

앱을 닫아도 호스트에서 작업은 이어집니다. 단, Mac이 깨어 있어야 하며 잠자기·전원 종료·재부팅 중 실행은 보장하지 않습니다. 현재 앱은 전경에서 3초마다 갱신합니다. APNs 백그라운드 푸시는 아직 구현하지 않았습니다.

## 사용 방식

- 총괄 기본값은 Claude이며 프로젝트 생성 시 Codex를 고를 수 있습니다. 팀장도 각자 다른 제공자를 사용할 수 있습니다.
- 공식 CLI의 인증·기능·설정을 활용합니다. IAMCEO는 실행마다 역할 지침과 MCP 연결을 더합니다. 별도 모델 API를 구현하거나 제공자의 캐시를 옮기지 않습니다.
- 모델 제공자 교체는 **새 세션 + 업무 인계**입니다. 업무·대화·결재 기록은 남지만 모델 내부 문맥 전체를 이전하지 않습니다. 작업 중이거나 전달 여부가 불확실하면 교체를 보류합니다.
- 팀장은 CLI의 병렬 서브에이전트를 활용할 수 있습니다. Claude의 병렬 모드와 Codex의 서브에이전트 지침·설정은 서로 다른 기능입니다.
- 질문·정보 요청·선택·승인은 결재함으로 모읍니다. 별도의 대화 화면에서 지시하고 결과를 확인할 수 있습니다.
- CLI 권한·초기 설정 메뉴는 팀원의 터미널 화면에서 직접 조작합니다. 직접 조작권을 얻으면 자동 입력이 최대 5분 동안 멈추며, 끝나면 해제합니다.
- 상태는 OSC 7501 규약으로 판단합니다. 상태를 모르거나 입력 중인 글이 있으면 자동 입력을 보류합니다. 전송 성공 여부가 불명확한 메시지는 자동으로 중복 전송하지 않습니다.
- `iamceo attach <직원-id>`로 터미널에 직접 붙을 수도 있습니다. 앱 밖에서의 직접 입력은 앱의 입력권 보호를 받지 않으므로 자동 지시와 동시에 사용하지 마세요.

## 현재 범위

실행 권한의 기존 기본값인 `bypassPermissions`는 유지합니다. 설정에서 변경할 수 있습니다. 각 CLI는 호스트 계정 권한으로 실행되며, 구독 사용 가능 여부와 한도는 각 제공자의 정책을 따릅니다.

core 자동 압축은 비활성화했습니다. 새 Codex 세션의 고유 ID를 아직 자동 탐색하지 않으므로 터미널이 사라지면 팀원 관리의 **새 세션으로 이어가기**로 명시적인 인계가 필요합니다. 네이티브 HTML 자료는 스크립트·외부 요청을 끈 미리보기입니다. Windows·Android·APNs·배포 서명과 Intel Mac 실기기 검증은 후속 범위입니다.

```sh
bun run typecheck
bun test tests
bun run native:test
```

[전체 구조](docs/architecture.md) · [운영 모델](docs/operating-model.md) · [빌드·연결 상세](native/README.md) · [herdr-core 출처](vendor/herdr-core/README.md)

## 라이선스

IAMCEO는 오픈소스가 아니라 **소스 공개형(source-available)** 소프트웨어입니다. [IAMCEO 라이선스](LICENSE)는 Sustainable Use License 1.0에 IAMCEO 추가 허락을 더한 것입니다.

- **허용:** 코드를 보고 배우고, 쓰고, 고치고, 무료로 비상업적으로 나눌 수 있습니다. 회사 안에서 업무에 써도 됩니다.
- **도구로 쓰는 일도 허용:** 고객 일을 처리하는 도구로 쓰고, 그 결과물을 팔고, 설치·지원 대행 요금을 받을 수 있습니다.
- **별도 허락 필요:** IAMCEO나 고친 판을 판매하는 것, 유료 호스팅·SaaS로 제공하는 것, 상업 제품에 넣어 배포하는 것입니다.

쉬운 설명은 [docs/LICENSING.ko.md](docs/LICENSING.ko.md)에, 기여 안내는 [CONTRIBUTING.md](CONTRIBUTING.md)에 있습니다.

2026년 11월 7일 이전에 공개된 버전(v0.1.0 포함)은 AGPL-3.0-only로 배포됐고, 받은 사람에게는 그대로 남습니다. 포함된 외부 구성요소는 각자의 라이선스를 따릅니다. herdr-core는 Apache-2.0이며, 그 라이선스·고지·공식 서명을 보존합니다. 자세한 목록은 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)에 있습니다.
