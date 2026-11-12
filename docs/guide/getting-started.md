# 시작하기

[English](getting-started.en.md) · [사용자 문서 목록](README.md)

IAMCEO는 내 Mac에서 도는 서버와 Mac·iPhone 앱으로 이루어집니다. 서버가 공식 Claude Code·Codex CLI를 총괄과 팀장으로 띄우고, 나는 앱에서 지시하고 결재합니다. IAMCEO가 운영하는 서버는 없습니다.

## 시작하기 전에 확인할 것

- [ ] **Apple Silicon Mac, macOS 14(Sonoma) 이상.** Intel Mac은 지원하지 않습니다.
- [ ] **Claude Code를 설치하고 로그인했습니다.** [claude.com/claude-code](https://claude.com/claude-code)에서 설치한 뒤, 터미널에서 `claude`를 한 번 실행해 로그인합니다. 로그인하지 않으면 팀장이 시작하자마자 멈춥니다.
- [ ] **(선택) Codex CLI.** 팀장을 Codex로 돌리려면 설치하고 터미널에서 `codex`를 한 번 실행해 로그인합니다.
- [ ] **(iPhone을 쓸 때) Tailscale.** Mac과 iPhone에 [Tailscale](https://tailscale.com)을 설치하고 같은 계정으로 켭니다. 자세한 것은 [iPhone 연결](iphone.md)에 있습니다.
- [ ] **권한 방식을 이해했습니다.** 기본으로 총괄과 팀장은 승인 창에서 멈추지 않고 명령을 실행합니다(묻지 않기). 처음 시작할 때 세 가지 중에서 고릅니다. 무엇을 막고 무엇을 막지 못하는지는 [보안 설명서](../security.md)에 있습니다.

AI 요금은 각 CLI의 내 계정과 사용 한도로 나갑니다. IAMCEO 때문에 드는 요금은 없습니다.

## 설치

```sh
brew install --cask yehsung/tap/iamceo
```

Homebrew가 없으면 설치 스크립트를 씁니다.

```sh
curl -fsSL https://raw.githubusercontent.com/yehsung/IAMCEO/main/install.sh | sh
```

[릴리스 화면](https://github.com/yehsung/IAMCEO/releases/latest)에서 DMG를 받아 응용 프로그램 폴더로 끌어도 됩니다.

설치 스크립트는 받은 파일의 SHA-256을 릴리스의 값과 대조하고, 앱이 IAMCEO 배포자의 서명과 Apple 공증을 받았는지 확인한 뒤에만 설치합니다. 확인에 실패하면 이미 깔린 앱은 그대로 둡니다. 안내 문구는 터미널의 언어(`LANG`)를 따라 한국어나 영어로 나옵니다. `IAMCEO_LANG=ko` 또는 `IAMCEO_LANG=en`으로 정할 수 있습니다.

## 처음 시작

1. **IAMCEO를 열고 이 Mac에서 시작을 누릅니다.** 서버가 로그인 항목으로 등록되고 앱이 바로 연결됩니다. Mac을 다시 켜도 서버는 스스로 뜹니다.
2. **팀장이 명령을 실행하는 방식을 고릅니다.** 묻지 않기(처음 선택), 위험할 때만 묻기, 매번 묻기 가운데 하나입니다. 나중에 설정 → 일반 → 권한에서 바꿉니다. 바꾼 값은 새로 여는 세션부터 적용됩니다.
3. **새 프로젝트를 만듭니다.** 새 프로젝트를 눌러 작업 폴더를 고릅니다. 새 폴더를 만들거나 GitHub 저장소를 가져올 수도 있습니다. '이 폴더를 신뢰하고 AI가 이 안에서 명령을 실행하게 합니다'를 켜 두면(처음 값 켜짐), CLI가 그 폴더에서 처음 묻는 폴더 신뢰 창에 서버가 대신 답합니다.
4. **대화에 원하는 일을 적습니다.** 총괄이 맞는 팀장을 정해 일을 넘기고 한두 줄로 알려 줍니다.
5. **결정할 일은 결재함, 결과물은 자료, 내가 직접 할 일은 홈에 모입니다.** 팀 화면에서는 팀장마다 일하는 중·대기·승인 대기·잠듦이 보이고, 실제 터미널을 열어 직접 입력할 수 있습니다.

Mac 없이 화면을 먼저 보고 싶으면 iPhone 앱 첫 화면의 **샘플로 둘러보기**를 누릅니다.

## 용어

| 이름 | 무엇인가 |
|---|---|
| 총괄 | 프로젝트마다 하나. 일을 나눠 팀장에게 맡기고 보고를 모읍니다. 직접 코드를 고치지 않습니다. |
| 팀장 | 실제로 일하는 세션. 일의 종류마다 하나씩 둡니다. |
| 서브에이전트 | 팀장이 자기 CLI 안에서 부리는 도우미. 팀장에게만 보고합니다. |
| 본사 | 어느 프로젝트에도 속하지 않는 칸. 본사 AI가 새 프로젝트를 만들고 한 번짜리 일을 처리합니다. 작업 폴더는 홈 폴더입니다. |
| 결재함 | 질문과 승인 요청이 대표(나)의 답을 기다리는 곳. |

## 보고 언어

총괄과 팀장이 나에게 쓰는 글(보고, 결재 카드, 할 일)의 언어를 고를 수 있습니다. **설정 → 일반 → 운영 → 보고 언어**에서 한국어나 English를 고릅니다.

- 고른 언어는 새로 여는 세션부터 적용됩니다. 이미 일하는 팀장은 잠재웠다 깨우면 새 언어로 씁니다.
- 앱의 버튼과 화면 글은 아직 한국어입니다.
- 서버가 에이전트에게 붙이는 출처 표시(`[대표]`, `[총괄]` 같은 것)는 언어와 상관없이 그대로입니다. 영어로 고르면 그 표시의 뜻을 설명하는 줄이 역할 지침에 함께 들어갑니다.
- 이 줄은 이 설정이 있는 서버에서만 보입니다. 옛 서버에 연결했을 때는 보이지 않습니다.

## 명령줄 도구

앱 안에 명령줄 도구가 들어 있습니다. 앱으로 설치했다면 경로는 다음과 같습니다.

```sh
/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo help
```

자주 쓰려면 셸 설정(`~/.zshrc`)에 줄여 쓰는 이름을 둡니다.

```sh
alias iamceo=/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo
```

아래 문서들의 `iamceo`는 이 도구를 가리킵니다. 안내와 오류는 `LANG`을 따라 한국어나 영어로 나오고, `IAMCEO_LANG=ko` 또는 `IAMCEO_LANG=en`으로 정할 수 있습니다. 자주 쓰는 명령은 다음과 같습니다.

| 명령 | 하는 일 |
|---|---|
| `iamceo doctor` | 실행 환경을 항목별로 점검하고 고치는 법을 한 줄씩 보여 줍니다 → [문제 해결](troubleshooting.md) |
| `iamceo diagnose` | 문의할 때 붙일 진단 파일을 만듭니다(대화 내용은 넣지 않습니다) |
| `iamceo status` | 서버와 프로젝트 상태 |
| `iamceo open` | 접속 주소와 접속 코드 |
| `iamceo backup` | 지금 바로 백업 → [업그레이드·백업·제거](upgrade-backup-uninstall.md) |
| `iamceo upgrade` · `iamceo rollback` | 새 버전으로 올리기, 직전 버전으로 되돌리기 |
| `iamceo uninstall` | 이 Mac에서 IAMCEO를 완전히 멈추기 |
| `iamceo auth rotate` | 접속 코드 바꾸기(`--all-devices`면 QR로 연결한 기기도 모두 끊기) → [보안 설명서](../security.md#기기를-잃어버렸을-때) |
| `iamceo auth revoke-devices` | QR로 연결한 기기를 모두 끊기(공용 접속 코드는 그대로) |

## 알아 둘 것: 터미널 환경은 넘어가지 않습니다

서버는 로그인 항목으로 뜨기 때문에 `~/.zshrc` 같은 셸 설정에서 정한 환경 변수와 PATH를 받지 않습니다. 터미널에서는 되던 MCP 서버나 훅이 여기서는 실패할 수 있습니다. 그런 값은 CLI 설정 파일의 `env`에 적고, 명령은 절대 경로로 적어 주세요. 자세한 설명은 [README의 무엇이 다른가](../../README.ko.md#무엇이-다른가)에 있습니다.

## 다음

- 막히면: [문제 해결](troubleshooting.md)
- iPhone에서 쓰려면: [iPhone 연결](iphone.md)
- 새 버전, 백업, 제거: [업그레이드·백업·제거](upgrade-backup-uninstall.md)
