# IAMCEO

[English](README.md)

Claude Code 세션 여러 개를 팀처럼 부리는 창구다. 내 컴퓨터에 서버를 켜고, 브라우저에서 홈·결재함·팀·대화·자료 다섯 화면으로 일을 시키고 답한다. 터미널을 계속 보고 있지 않아도 되고, 폰에서도 된다.

- **홈**: 오늘 내가 뭘 하면 되나. 내가 할 일(한 줄씩, 화살표로 펼침), 결재 대기, 팀 상태, AI가 곧 할 일, 최근 보고·자료, 지금 판 정리 버튼
- **결재함**: 결재할 항목과 결재된 항목 두 쪽. 선택지를 고른 뒤 확인을 눌러야 나간다. 승인 창 앞에서 멈춘 세션은 맨 위 '승인 대기'에 창 내용과 함께 보이고, 같은 두 단계로 승인·거절한다(herdr. 폴더 신뢰 창 등은 터미널에서). AI 가 닫은 카드는 '닫힘 · 이유'로 보이고 다시 열 수 있다
- **팀**: 총괄·직원의 상태, 지금 일, 문맥 %, 진행판, 직원별 모델·effort
- **대화**: 보고와 내 말, 전달 상태
- **자료**: 세션이 올린 것. 문서·아티팩트(한 페이지 HTML)·이미지·PDF·표·코드·영상·오디오를 각자 모양으로 보여 준다

연결되지 않은 프로젝트(총괄이 없고 실행이 꺼져 있거나, 실행기가 죽었거나, 서버 연결이 끊긴 때)는 입력칸과 결재 버튼이 잠기고 이유와 할 일이 나온다. 서버도 409 로 거부한다. 쓰던 글은 지워지지 않는다. 내 할 일 체크는 연결과 상관없이 된다.

말은 총괄에게 하고, 일은 총괄이 직원에게 맡긴다. 자세한 규칙은 [운영 모델](docs/operating-model.md), 구조는 [아키텍처](docs/architecture.md)를 본다.

상태: 0.1.0 초기판. Claude Code 전용. macOS 전용(Apple Silicon·Intel). 화면은 한국어다.

## 준비물

| 항목 | 필요 여부 | 돌려 본 버전 |
|---|---|---|
| macOS | 필수(Apple Silicon·Intel) | Darwin 27 |
| Claude Code(`claude`, 로그인 완료) | 필수 | 2.1.316 |
| herdr | 선택 | 0.9.3(프로토콜 22) |
| Tailscale | 폰 접속 때 | |

[Bun](https://bun.sh) 은 소스에서 빌드할 때만 필요하다.

## 설치

```sh
curl -fsSL https://raw.githubusercontent.com/yehsung/IAMCEO/main/install.sh | sh
```

GitHub 최신 릴리스에서 내 맥에 맞는 빌드본을 받아 SHA-256 을 확인하고 `~/.local/bin/iamceo` 에 둔다. `~/.local/bin` 이 PATH 에 없으면 추가할 줄을 알려 준다.

선택은 환경변수로 `sh` 에 준다.

| 변수 | 하는 일 |
|---|---|
| `IAMCEO_INSTALL_DIR` | 다른 폴더에 설치 |
| `IAMCEO_VERSION=v0.1.0` | 최신 대신 그 버전으로 고정 |

```sh
curl -fsSL https://raw.githubusercontent.com/yehsung/IAMCEO/main/install.sh | IAMCEO_VERSION=v0.1.0 sh
```

같은 명령을 다시 돌리면 업데이트된다. launchd 서비스(`iamceo service install`)가 그 실행 파일을 가리키고 있으면 다시 켠다. 설치 결과는 `iamceo version` 으로 본다.

### 소스에서

Bun 1.3 이상이 필요하다.

```sh
git clone https://github.com/yehsung/IAMCEO
cd IAMCEO
bun install
bun link          # ~/.bun/bin/iamceo 가 생긴다. 소스로 바로 돈다
```

`bun link` 대신 `bun run build` 를 하면 `dist/iamceo` 하나로 묶인다(화면 포함). PATH 에는 직접 둔다. 빌드본은 코드를 받은 뒤 `bun run build` 를 다시 해야 바뀐다.

### 지우기

```sh
iamceo service uninstall   # 서비스를 등록했다면
rm ~/.local/bin/iamceo     # IAMCEO_INSTALL_DIR 를 썼으면 그 폴더의 파일
```

데이터는 `~/.iamceo` 에 남는다. 모두 지우려면 그 폴더를 지운다(프로젝트, 접속 코드, 로그).

## 첫 실행

```sh
iamceo setup              # 실행 방식·포트·접근 범위를 묻는다. 엔터를 치면 기본값
iamceo service install    # 서버를 지금 켜고, 로그인할 때마다 켜고, 죽으면 다시 켠다. 기본 포트 7878
iamceo open               # 주소와 접속 코드를 본다
```

보통은 서비스로 켜 둔다([서비스로 두기](#서비스로-두기)). 터미널에서 직접 돌리려면 `iamceo serve` 를 쓰고, `iamceo open` 은 다른 터미널에서 한다. Ctrl+C 로 끈다.

1. `iamceo open` 이 알려 준 주소를 브라우저로 연다.
2. 접속 코드를 넣는다. 그 기기에 저장되어 다음부터는 묻지 않는다.
3. `setup` 을 건너뛰었으면 화면이 실행 방식을 묻는다.
4. 새 프로젝트를 만든다(이름·폴더).
5. 입력칸에 말한다. 총괄이 없으면 서버가 띄우고 그 말을 전달한다.

왼쪽의 **본사**는 어느 프로젝트에도 속하지 않는 칸이다. 본사 AI 가 잡다한 일을 하고 프로젝트를 만들어 준다.

`setup` 은 물음 없이도 된다.

```sh
iamceo setup --backend headless --port 7878 --hosts local
```

상태 확인은 `iamceo status`. 서버가 꺼져 있으면 그렇게 알려 준다.

## herdr 함께 / herdr 없이

서버 전체에서 하나를 고른다. 역할·규칙·도구·화면은 같고, 세션이 도는 곳이 다르다.

| | herdr 함께 (`herdr`) | herdr 없이 (`headless`) |
|---|---|---|
| 직원은 | herdr 칸 하나 | 입력이 올 때마다 `claude -p --resume` 한 턴 |
| 터미널에서 보고 치기 | 된다 | 안 된다 |
| 팀 화면의 터미널 내용 | 보인다 | 없다 |
| 승인 창 | 칸에 뜨고, 화면에 "승인 창 앞"으로 표시. 결재함·팀 화면에서 승인·거절하거나 칸에서 풀어 준다 | 띄우지 않는다(`--permission-prompts none`) |
| 떠 있는 세션을 직원으로 받기(기존 세션 편입) | 된다 | 안 된다 |
| 준비 | herdr 설치(`brew install herdr`)와 실행 | 없음 |

**터미널에 직접 손댈 일이 있으면 herdr, 화면만 쓸 거면 headless** 로 고른다. 일하는 세션이 없을 때만 설정에서 바꿀 수 있다.

herdr 쪽 주의:

- 프로젝트마다 워크스페이스가 하나 생기고, 그 안에 칸이 늘어난다. 지금 쓰는 herdr 서버(`~/.config/herdr/herdr.sock`)에 만든다. 다른 서버를 쓰려면 `IAMCEO_HERDR_SOCKET`.
- git 저장소를 처음 열면 Claude Code 의 폴더 신뢰 창이 뜬다. 서버는 대신 고르지 않는다. 그 칸에서 직접 `Yes, I trust this folder` 를 고른다. 그때까지 말은 보류된다.
- 프로토콜이 22 가 아니면 경고를 띄우고 계속 시도한다.

## 폰에서 쓰기 (Tailscale)

1. 서버 컴퓨터와 폰에 Tailscale 을 깔고 같은 계정으로 로그인한다.
2. 서버를 켠다. Tailscale 주소를 자동으로 함께 연다. 서버보다 Tailscale 이 늦게 올라와도 30초 안에 연다.
3. `iamceo open` 에 나오는 `http://100.x.y.z:7878` 을 폰 브라우저로 연다.
4. 접속 코드를 넣는다.

폰 화면은 아래쪽 탭, 제목을 눌러 프로젝트 전환이다. 터치 기기에서 Enter 는 줄바꿈이고 보내기 버튼으로 전송한다.

같은 망의 다른 기기까지 열려면 `iamceo setup --hosts lan` 뒤 서버를 다시 켠다. 주소를 직접 적을 수도 있다(`--hosts 127.0.0.1,192.168.0.10`). `0.0.0.0` 은 거부한다.

## 내가 띄운 CLI 붙이기 (`iamceo join`)

이미 쓰는 Claude Code 를 직원으로 올린다. 서버가 켜져 있어야 하고, 서버와 같은 컴퓨터에서 한다.

```sh
cd <프로젝트 폴더 또는 그 아래>
iamceo join --name 문서담당 --role "문서 작성"
```

폴더로 프로젝트를 찾는다. 폴더가 다르면 `--project 이름`. 다음 두 가지를 출력한다.

1. `claude mcp add iamceo ...` 명령. 그 폴더에서 한 번 실행한다. 토큰이 들어 있으니 남에게 보이지 않는다.
2. 규칙 파일 경로.
   - 새로 띄울 때: `claude --append-system-prompt-file <규칙 파일>`
   - 떠 있는 세션: `/mcp` 로 다시 연결하고, 그 파일을 읽고 따르라고 입력한다.

이렇게 붙은 세션은 서버가 관리하지 않는다.

- 지시를 스스로 받으러 온다: `wait` 도구. `ask` 는 답이 올 때까지 기다렸다 돌아온다.
- 압축·잠재우기·다시 열기는 안 된다.
- 도구를 부르면 일하는 중, 5분 조용하면 대기, 30분 조용하면 안 보임으로 표시된다. 화면에서 명부에서 뺄 수 있다.

서버 포트를 바꾸면 `join` 부터 다시 한다. 같은 이름으로 다시 부르면 같은 직원으로 이어진다.

**herdr 칸에 이미 떠 있는 세션**은 `join` 대신 팀 화면의 **기존 세션 편입**으로 받을 수도 있다. 서버가 관리하는 직원이 되고, 눌렀을 때만 일어난다.

### 기존 세션 편입은 어떻게 동작하나

전체 실행 방식이 herdr 일 때 쓴다. 그 외에는 같은 창에 위의 `join` 명령이 나온다. 고른 세션의 화면과 경고를 먼저 보여 주고, 누르면 다음이 일어난다.

- 칸은 그대로다. 옮기지도, 이름을 바꾸지도, 닫지도 않는다. 세션 ID 로 알아본다.
- 모델·effort·권한은 쓰던 그대로 둔다. 전체 설정의 직급 값을 덮어쓰지 않는다.
- 직원 자리로만 받는다. 운영 규칙 전문을 첫 지시로 보내고(입력칸에 남은 글이 있으면 지우고 넣는다) 프로젝트 실행을 켠다. 이후 턴 마지막 글은 대화와 총괄에게 보고된다.
- 떠 있는 세션에는 MCP 를 붙일 수 없어 결재 카드·자료를 못 올린다. **도구 붙여 다시 열기**로 프로젝트 탭의 새 칸에 전체 인자로 다시 연다.
- **편입 해제**로 되돌린다. 대화·세션은 남고, 쉴 때 규칙이 풀렸다고 한 번 알린다. 이 편입이 켠 실행은 남은 세션이 없으면 끈다.

사람마다 쓰던 구조가 달라서 생기는 충돌은 이렇게 다룬다.

| 상황 | 처리 |
|---|---|
| 일하는 중·승인 창 앞·세션 ID 없음·입력칸을 못 찾음 | 거부. 끝난 뒤 다시 시도 |
| 다른 프로젝트까지 포함해 이미 직원 자리인 세션(잠든 직원 포함), Claude 가 아닌 CLI | 거부 |
| 다른 지휘자의 흔적(명령줄의 규칙 파일, 칸 이름, 기록의 SendMessage·오케스트라 스킬) | 경고만. 막지 않는다 |
| 프로젝트 폴더가 아닌 곳에서 도는 세션 | 경고만 |
| 입력칸에 쓰던 글 | 경고하고, 넘겨받을 때 그 글을 지운 뒤 규칙을 넣는다 |

남는 위험: 원래 쓰던 CLAUDE.md·스킬은 그대로 살아 있어 새 규칙과 겹칠 수 있다. 규칙은 글로 넣는 것이지 차단 장치가 아니다. 다른 지휘자가 그 칸에 계속 말을 넣으면 지휘자가 둘이 된다. 경고가 나오면 그 지휘자를 먼저 멈추거나 세션을 새로 띄워 맡기는 편이 안전하다.

## 서비스로 두기

로그인하면 켜지고, 죽으면 다시 켜지게 launchd 에 올린다(macOS).

```sh
iamceo service install --dry-run   # 쓸 파일과 명령을 미리 본다
iamceo service install             # ~/Library/LaunchAgents/com.iamceo.server.plist
iamceo service uninstall           # 해제. 데이터는 남는다
```

로그는 `~/.iamceo/logs/`. 등록할 때의 실행 파일 경로와 `IAMCEO_*` 환경변수가 plist 에 들어간다. 빌드본을 옮기면 다시 등록한다.

## 설정

`~/.iamceo/config.json`:

| 키 | 환경변수 | 기본값 |
|---|---|---|
| `accessCode` | | 첫 실행 때 생성 |
| `port` | `IAMCEO_PORT` | 7878 |
| `hosts` | | 127.0.0.1 + Tailscale 주소 |
| `claudeBin` | `IAMCEO_CLAUDE_BIN` | `claude` |
| `herdrSocket` | `IAMCEO_HERDR_SOCKET` | `~/.config/herdr/herdr.sock` |

데이터 폴더 자체는 `IAMCEO_HOME` 으로 옮긴다. 환경변수가 파일보다 앞선다. 고치면 서버를 다시 켜야 한다.

화면의 설정은 하나뿐이고 모든 프로젝트에 함께 적용된다. 프로젝트마다 따로 두지 않는다(프로젝트 이름·폴더 고치기와 보관도 여기서 한다).

- 실행 방식
- 권한 모드 3종: 바이패스(`bypassPermissions`, 기본), 오토(`auto`), 모두 승인(`default`). headless 는 다음 턴부터, herdr 는 칸을 새로 열 때부터 적용된다
- 직급별 모델·effort: 부장(총괄·본사 AI), 팀장(직원 세션), 직원(서브에이전트). 안 고르면 CLI 기본값이다. 팀 화면의 직원 상세에서 그 직원만 덮어쓸 수 있다
- 동시 턴 수(4), 깨어 있는 직원 상한(8), 자동 압축 기준(문맥 70%), 맥 알림
- 판 정리 주기(끔·3시간·6시간·12시간·매일, 기본 6시간)

## 판 정리

결재함·내 할 일·진행판·지금 상황이 낡지 않게 총괄(본사는 본사 AI)이 맞춘다. 보고·결재 답·대표의 말을 받을 때마다 맞추고, 서버도 주기마다 한 번 시킨다.

| 도구 | 누가 | 하는 일 |
|---|---|---|
| `board` | 총괄·본사 AI | 열린 결재, 안 끝난 할 일, 진행판, 지금 상황, 지난 정리 시각을 한 번에 본다 |
| `ask_close` | 총괄·본사 AI, 직원은 자기 카드만 | 결재 카드를 이유와 함께 닫는다. `decided`(대표가 이미 정함)는 대표 원문을 실어야 하고 서버가 대표 글과 맞춰 본다. `obsolete` 는 필요 없어진 경우. 물은 직원에게 깨우지 않고 알린다 |
| `todo_close` | 총괄·본사 AI, 직원은 자기 부탁만 | 내 할 일을 `done`(끝남, 대표가 끝냈다는 근거가 있을 때만) 또는 `dropped`(필요 없어짐)로 정리한다. 필요 없어진 할 일은 홈에서 빠진다 |

- 대신 답하지 않는다. 대표가 아직 정하지 않은 카드를 추측으로 닫지 않고, 애매하면 그대로 둔다.
- 주기 정리는 총괄이 이미 떠 있고 쉬고 있으며, 간격이 지났고, 지난 정리 뒤 결재·할 일·진행판·대화에 바뀐 게 있을 때만 들어간다. 정리하려고 총괄을 새로 띄우거나 직원을 깨우지 않는다. 바뀐 게 없으면 대화에 아무것도 올리지 않는다.
- 홈의 **지금 판 정리**는 바로 시킨다(총괄이 없거나 잠들었으면 띄운다). 연결되지 않은 프로젝트에서는 잠긴다.
- AI 가 닫은 카드는 결재된 항목에서 **다시 열기**로 결재할 항목에 돌려놓는다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `iamceo serve` | 서버 켜기 |
| `iamceo setup` | 실행 방식·포트·접근 범위 |
| `iamceo open` | 주소와 접속 코드 |
| `iamceo status` | 서버와 프로젝트 상태 |
| `iamceo join` | 내가 띄운 CLI 등록 |
| `iamceo service install\|uninstall` | launchd 등록·해제 |
| `iamceo roles export` | 역할 템플릿 꺼내기 |
| `iamceo import <덤프.json>` | 예전 운영판 덤프 가져오기. 처음 쓰는 사람에게는 필요 없다 |
| `iamceo mcp` | MCP 브리지. 세션이 부른다 |
| `iamceo version` | 버전 보기 |

## 접근과 보안

- 기본으로 127.0.0.1 과 Tailscale 주소에서만 듣는다. 그 밖의 IP 는 403 이다.
- 화면과 API 는 접속 코드로 들어온다. 코드는 `iamceo open` 으로 본다. `config.json` 은 본인만 읽을 수 있다.
- HTTPS 는 없다. 암호화는 Tailscale 에 맡긴다. `--hosts lan` 으로 열면 같은 망에서 평문이다.

## 알려진 한계

- **격리가 아니다.** 세션은 내 OS 사용자로 돈다. 서버의 파일 도구는 비밀 폴더·`.env`·개인 키를 거부하지만, 세션의 Bash 까지 막지는 못한다. 권한 모드를 `bypassPermissions` 로 두면 이 위험이 그대로 드러난다.
- Claude Code 만 된다. Codex·Gemini CLI 는 안 된다.
- macOS 전용이다. 릴리스 빌드본이 macOS 용이고, launchd 등록, HEIC 변환(`sips`), 맥 알림도 macOS 기능이다.
- Intel 용(`darwin-x64`) 실행 파일은 만들기만 했고 Intel 맥에서 돌려 본 적은 아직 없다.
- 다크 모드만 있다. iOS 앱은 없다. 웹 화면뿐이다.
- 굴절 효과는 Chromium 계열에서만 보인다.
- `join` 은 서버와 같은 컴퓨터에서만 된다(연결 주소가 로컬이다).
- 첨부는 한 파일 50MB 까지.
- 화면에서 보낸 말은 어느 방식이든 그 세션의 턴이 끝난 뒤 전달된다. 팀 화면의 중단 버튼으로 턴을 끊을 수는 있다. headless 는 터미널 화면을 볼 수 없다.

## 개발

```sh
bun run dev         # 고치면 서버 재시작
bun test tests      # 실제 claude 를 부르지 않는다. herdr 시험은 격리 서버를 띄운다
bun run typecheck
```

시험은 항상 `IAMCEO_HOME` 을 임시 폴더로 준다. `tests/integrated.browser.ts` 는 가져온 프로젝트에서 시작해 게이트·결재·홈·자료·편입·설정까지 한 흐름으로 돈다. `IAMCEO_SHOTS=docs/shots bun test ./tests/integrated.browser.ts` 로 캡처를 다시 만든다. 실제 Claude 로 도는 시험은 `IAMCEO_E2E_REAL=1 bun tests/e2e-real/headless.ts`, `herdr-full.ts`, `artifact.ts`(직원이 비교표를 아티팩트로 올리는지) 이고 비용이 든다.

### 릴리스

`package.json` 의 `version` 을 올리고 커밋한 뒤 `vX.Y.Z` 태그를 달아 태그를 푸시한다. GitHub Actions 의 `.github/workflows/release.yml` 이 `iamceo-darwin-arm64`, `iamceo-darwin-x64`, `SHA256SUMS` 를 만들어 릴리스로 올린다. 같은 파일을 로컬에서 만들려면 `bun run build:release`(`dist/release/` 에 생긴다). `install.sh` 는 늘 최신 릴리스를 받는다.

## 라이선스

[AGPL-3.0](LICENSE). Copyright (C) 2026 yehsung.

자유롭게 쓰고 고치고 나눌 수 있다. 고친 판을 다른 사람에게 서비스로 내놓으면 그 소스를 같은 라이선스로 공개해야 한다. 자기 컴퓨터에서 쓰는 것은 고쳤든 아니든 아무 의무가 없다.
