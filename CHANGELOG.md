# 변경 기록 · Changelog

사용자에게 의미 있는 변화만 버전별로 적습니다. 전체 기록은 `git log`에 있습니다.
Only changes that matter to users, by version. The full history is in `git log`.

[한국어](#한국어) · [English](#english)

## 한국어

### 아직 내지 않은 것

2026-11-11 안정성 수정과 그 뒤의 완성도 손질입니다. 아직 버전을 붙여 내지 않았습니다.

- **멈춘 팀장이 스스로 풀립니다.** 뜨지 않은 세션은 90초 뒤 닫고 다시 깨웁니다. 사용 한도나 인터넷 장애로 멈춘 팀장은 간격을 두고 다시 이어 가고, 대표가 새로 말을 걸면 바로 풉니다.
- **확인되지 않은 전달을 안전할 때만 다시 보냅니다.** 세션 기록에 그 글이 없고, 입력칸이 비었고, 턴이 그대로일 때만 자동으로 다시 보냅니다(최대 3회). 그 밖에는 전과 같이 다시 보내지 않습니다.
- **일하는 중인 팀장에게 급한 지시를 끼워 넣지 않습니다.** 턴이 끝난 뒤에 보냅니다.
- **기록 파일이 사라진 세션은 새 세션으로 엽니다.** 켜자마자 끝나기를 세 번 이어가면 10분 동안 자동으로 깨우지 않습니다.
- **서버가 오류 하나로 내려가지 않습니다.** 처리하지 못한 오류는 기록하고 계속 돕니다. 10분에 20번을 넘으면 정상 절차로 내려갔다가 다시 뜹니다.
- **앱이 느린 서버를 재촉하지 않습니다.** 서버가 느리면 자동 새로고침 간격을 벌립니다. 대표가 누른 새로고침은 기다리지 않습니다. 이어서 온 메시지는 다시 읽지 않고 바로 보여 줍니다.
- **처음 시작할 때 권한 방식을 고릅니다.** 새로 설치한 Mac에서는 팀장이 명령을 실행하는 방식을 먼저 묻습니다. 묻지 않기(처음 선택), 위험할 때만 묻기, 매번 묻기 중에서 고르고, 나중에 설정에서 바꿀 수 있습니다. 이미 쓰던 설치에는 묻지 않습니다.
- **새 프로젝트의 폴더 신뢰를 만들 때 한 번에 답합니다.** 새 프로젝트 창에서 '이 폴더를 신뢰'를 켜 두면(처음 값 켜짐), 그 폴더에서 CLI가 띄우는 폴더 신뢰 창에 서버가 대신 답합니다. 창을 정확히 읽지 못하면 누르지 않고 '터미널 열어 직접 답하기'로 안내합니다. 시작이 60초 넘게 늦어지는 팀장은 '승인 대기'가 아니라 '시작 지연'으로 알립니다.
- **연결 링크는 확인한 뒤에 엽니다.** iPhone에서 앱 밖의 연결 링크나 QR을 열면 어느 주소로 가는지 먼저 보여 주고, 확인한 뒤에만 연결합니다. 이미 연결된 Mac을 바꾸는 경우에는 그렇다고 알립니다. Tailscale 주소가 아닌 링크는 열지 않습니다.
- **실행 엔진에 문제가 있으면 알립니다.** 터미널을 붙잡는 실행 엔진이 응답하지 않거나 버전이 맞지 않으면 앱에 안내 한 줄이 뜹니다.
- **설치 스크립트가 서명과 공증을 확인합니다.** 받은 앱에 IAMCEO 배포자의 서명과 Apple 공증이 있는지 확인한 뒤에만 설치합니다. 확인에 실패하면 이미 깔린 앱은 그대로 둡니다.
- **팀장용 통로는 이 Mac 안에서만.** AI 세션이 서버의 도구를 부르는 통로는 이 Mac 안에서 온 요청만 받습니다. 같은 Tailscale 망의 다른 기기에서는 쓸 수 없습니다.
- **Tailscale 주소는 확인한 뒤에 엽니다.** 주소가 Tailscale 대역이라는 이유만으로 열지 않고, 실제 Tailscale 연결의 주소로 확인됐을 때만 엽니다. 확인하지 못하면 이 Mac 안에서만 엽니다. 그럴 때는 `~/.iamceo/config.json`의 `hosts`에 주소를 직접 적으면 열립니다.
- **샘플 화면을 정리했습니다.** '샘플로 둘러보기'가 오류나 막힘 없이 잘 돌아가는 회사의 모습을 보여 줍니다.
- **문서.** [보안 설명서](docs/security.md)와 [취약점 신고 안내](SECURITY.md)를 더했습니다. README의 iPhone 알림과 권한 방식 서술을 실제 동작에 맞췄고, 개인정보 처리방침에 빠져 있던 네 가지를 적었습니다. 일을 맡는 세션의 이름을 앱 화면과 같은 '팀장'으로 맞췄습니다.

### 0.2.2 — 2026-11-10

iPhone 앱은 2026-11-11에 App Store에 나왔습니다.

- **웹 버전을 없앴습니다.** Mac·iPhone 앱만 씁니다. 쿠키와 주소 줄의 접속 코드로 하던 인증도 함께 없앴습니다.
- **인터넷이 끊기거나 사용 한도에 걸려도 일이 사라지지 않습니다.** 풀리면 이어서 보내고, 앱에 대기 띠와 한도 카드로 알립니다. 전달이 영구히 멈추던 상태를 없앴습니다.
- **자료 검색을 서버에서 합니다.** 한국어 부분 일치로, 자료가 많아도 바로 찾습니다.
- **iPhone 첫 화면에 '샘플로 둘러보기'.** Mac 없이 읽기 전용 예시로 앱을 둘러봅니다.
- **고친 것.** 자료에서 영상을 열면 앱이 꺼지던 문제, Mac에서 이미지를 끌어다 놓으면 몇 초 뒤 꺼지던 문제, 앱 안 터미널에서 클릭이 먹지 않던 문제, '상태 확인 불가'가 사라지지 않던 문제, 연결 끊김 표시가 자주 깜빡이던 문제.
- **개인정보 처리방침**을 더했습니다.
- 태그 뒤 같은 날 더한 것(iPhone 심사 준비): 앱 안의 개인정보 처리방침 링크, 주소를 직접 입력할 때 '연결 중'으로 잘못 보이던 문제, 권한 안내 문구.

### 0.2.1 — 2026-11-10

- 글 링크로 들어간 뒤 팀원을 바꾸면 모든 대화에 오류가 뜨던 문제를 고쳤습니다.

### 0.2.0 — 2026-11-10

- **Mac·iPhone 네이티브 앱.** 브라우저 대신 SwiftUI 앱으로 홈·결재함·팀·대화·자료를 씁니다.
- **한 줄 설치.** 서명하고 Apple 공증을 받은 Mac 앱을 Homebrew, 설치 스크립트, DMG로 받습니다. 앱에서 **이 Mac에서 시작**을 누르면 서버가 등록됩니다.
- **Codex CLI 지원.** 팀장을 Claude Code나 Codex로 고릅니다.
- **세션이 앱과 서버보다 오래 삽니다.** herdr-core가 터미널을 붙잡고 있어, 앱을 닫거나 서버를 다시 켜도 일이 이어집니다.
- **전달 확인.** 보낸 말이 CLI에 들어갔는지 CLI의 세션 기록으로 확인하고, 확실하지 않으면 다시 넣지 않습니다.
- **앱 안의 실시간 터미널.** 팀장의 실제 터미널을 보고 직접 입력합니다.
- **새 프로젝트를 폴더 고르기, 새 폴더, GitHub 가져오기로.** 새 폴더의 '폴더 신뢰' 창은 대표의 승인 카드로 옵니다.
- **첨부.** iPhone은 사진 보관함과 카메라, Mac은 끌어 놓기와 이미지 붙여넣기. 대화 속 파일 경로를 앱에서 바로 엽니다.
- **보관, 백업·복원, 접속 코드 교체**를 더했습니다.
- **iPhone 알림**(직접 빌드한 앱과 자신의 Apple 알림 키가 있을 때).
- **총괄이 일을 받으면 바로 답합니다.** 누구에게 맡겼는지 한두 줄로 알립니다.
- **대표의 할 일이 쌓이지 않게.** 묵은 할 일 안내와 '필요 없음' 정리.
- **라이선스 변경(2026-11-07).** AGPL-3.0-only에서 Sustainable Use License 1.0 + IAMCEO 추가 허락으로 바꿨습니다. 그 전에 받은 판의 권리는 그대로입니다.

### 0.1.0 — 2026-11-03

- 첫 공개. 내 Mac에서 서버를 켜고 브라우저로 Claude Code 세션 여럿을 총괄과 팀으로 부립니다. 홈·결재함·팀·대화·자료 다섯 화면. Claude Code 전용, AGPL-3.0-only.

## English

### Unreleased

The stability pass of 2026-11-11 and the completeness pass that followed. Not released under a version number yet.

- **Stuck staff recover on their own.** A session that never appeared is closed after 90 seconds and woken again. Staff stopped by a usage limit or a network outage are retried at intervals, and released at once when you write to them.
- **An unconfirmed delivery is resent only when that is safe.** Only when the session record does not contain the text, the input box is empty and the turn has not moved (at most 3 times). Otherwise, as before, nothing is resent.
- **Urgent instructions no longer cut into a working turn.** They are sent when the turn ends.
- **A session whose record file is gone opens as a new session.** After three starts in a row that end at once, automatic waking pauses for 10 minutes.
- **One error no longer takes the server down.** Unhandled errors are logged and the server keeps running; past 20 in 10 minutes it shuts down cleanly and is started again.
- **The app stops pushing a slow server.** Automatic refreshes back off when the server is slow; a refresh you ask for does not wait. Messages that arrive in order are shown without re-reading.
- **You choose the permission mode on first start.** A fresh install first asks how staff run commands: don't ask (preselected), ask only when risky, or ask every time. You can change it later in Settings. Existing installs are not asked.
- **Folder trust is answered once, when you create the project.** With "trust this folder" on in the new-project sheet (on by default), the server answers the folder-trust prompt the CLI shows in that folder. If it cannot read the prompt exactly, it presses nothing and points you to the terminal. A staff member whose start takes more than 60 seconds is reported as a slow start, not as waiting for approval.
- **A connection link is confirmed before it is opened.** When a connection link or QR is opened from outside the iPhone app, the app shows the address it leads to and connects only after you confirm. If a Mac is already connected, it says that this would replace it. A link whose address is not a Tailscale address is not opened.
- **The app tells you when the engine has a problem.** If the engine that holds the terminals stops answering or has the wrong version, the app shows a one-line notice.
- **The install script verifies the signature and notarization.** It installs the downloaded app only after confirming the IAMCEO publisher's signature and Apple's notarization. If the check fails, the app you already have is left untouched.
- **The agents' channel works on this Mac only.** The channel AI sessions use to call the server's tools accepts requests from this Mac only. Other devices on the same Tailscale network cannot use it.
- **A Tailscale address is confirmed before the server listens on it.** An address is not opened just because it is in Tailscale's range, only when it is confirmed to belong to a real Tailscale connection. If it cannot be confirmed, the server opens on this Mac only; writing the address into `hosts` in `~/.iamceo/config.json` opens it.
- **The sample tour is tidied up.** "샘플로 둘러보기" (Look around with a sample) now shows a company that is running well, without errors or stuck members.
- **Docs.** Added a [security overview](docs/security.en.md) and a [vulnerability reporting policy](SECURITY.md). The README now states how iPhone notifications and the permission mode really work, and the privacy policy lists four things it had left out.

### 0.2.2 — 2026-11-10

The iPhone app reached the App Store on 2026-11-11.

- **The web client is gone.** Mac and iPhone apps only. Cookie and URL access-code authentication went with it.
- **A network outage or a usage limit no longer loses work.** Delivery continues when it clears, and the app shows a waiting banner and a limit card. The state where delivery stopped for good was removed.
- **Files search runs on the server.** Partial matches in Korean, instant even with many files.
- **"샘플로 둘러보기" (Look around with a sample) on the iPhone's first screen.** A read-only tour without a Mac.
- **Fixed.** A crash when opening a video in Files, a crash a few seconds after dropping an image on the Mac app, clicks not registering in the in-app terminal, a member stuck at "상태 확인 불가" (status unknown), a connection indicator that flickered.
- Added the **privacy policy**.
- Added after the tag on the same day (preparing the iPhone review): a privacy policy link inside the app, a wrong "connecting" state when typing an address by hand, permission wording.

### 0.2.1 — 2026-11-10

- Fixed an error shown on every conversation after following a message link and then switching member.

### 0.2.0 — 2026-11-10

- **Native Mac and iPhone apps.** Home, Inbox, Team, Conversation and Files in a SwiftUI app instead of a browser.
- **One-line install.** A signed and notarized Mac app through Homebrew, the install script or a DMG. Choosing **이 Mac에서 시작** in the app registers the server.
- **Codex CLI support.** Staff can run on Claude Code or Codex.
- **Sessions outlive the app and the server.** herdr-core holds the terminals, so closing the app or restarting the server does not stop the work.
- **Delivery checking.** Whether your words reached the CLI is confirmed from the CLI's own session record; when unsure, nothing is typed twice.
- **A live terminal inside the app.** Watch a staff member's real terminal and type into it.
- **New projects from a folder, a new folder or a GitHub repository.** The CLI's folder-trust prompt for a new folder arrives as an approval card.
- **Attachments.** Photo library and camera on iPhone, drag and drop and image paste on Mac. File paths in a conversation open in the app.
- Added **archiving, backup and restore, and access-code rotation.**
- **iPhone notifications** (with an app you build yourself and your own Apple push key).
- **The lead answers at once** when it takes a job, saying who got it.
- **Your own to-dos no longer pile up.** Reminders for stale ones and a "not needed" action.
- **License change (2026-11-07).** From AGPL-3.0-only to the Sustainable Use License 1.0 plus IAMCEO Additional Permissions. Rights in copies received earlier are unchanged.

### 0.1.0 — 2026-11-03

- First public release. A server on your Mac and a browser to run several Claude Code sessions as a lead and a team, on five screens: Home, Inbox, Team, Conversation and Files. Claude Code only, AGPL-3.0-only.
