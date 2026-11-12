# 변경 기록 · Changelog

사용자에게 의미 있는 변화만 버전별로 적습니다. 전체 기록은 `git log`에 있습니다.
Only changes that matter to users, by version. The full history is in `git log`.

[한국어](#한국어) · [English](#english)

## 한국어

### 아직 내지 않은 것

- **실행 환경을 스스로 점검합니다.** 설정 → AI 모델 → 실행 환경이 점검표가 됩니다. 서버, 실행 엔진, Claude Code·Codex의 설치와 로그인, CLI 버전, Tailscale, 자동 시작, 백업, 저장 공간을 항목마다 보여 주고 고치는 법을 한 줄씩 붙입니다. 안내는 일반 사용자가 할 수 있는 동작(앱 버튼, 설치 명령)만 가리킵니다. 같은 점검을 `iamceo doctor`로도 하며, 서버가 꺼져 있어도 됩니다.
- **진단 파일.** 설정의 '진단 파일 만들기'(서버가 도는 Mac에서)와 `iamceo diagnose`가 버전, 서비스 상태, 점검표, 로그 끝부분, 멈춤 기록, 백업 상태를 `~/.iamceo/diagnostics`의 폴더 하나와 zip으로 모읍니다. 대화·자료의 본문, 첨부, 접속 코드, 팀장 열쇠, 알림 토큰, 환경 변수의 값은 넣지 않습니다.
- **`iamceo upgrade`와 `iamceo rollback`.** 설치판에서 새 버전을 받아 체크섬·서명·공증을 확인하고, 지금 DB의 사본으로 미리 돌려 본 뒤 바꿉니다. 직전 버전을 기록해 두고, 새 버전이 정해진 시간 안에 뜨지 않으면 스스로 되돌립니다. `iamceo rollback`은 마지막 업그레이드 전의 버전으로 돌아갑니다.
- **이 Mac에서 완전히 멈추기.** 앱과 `iamceo uninstall`이 IAMCEO가 관리하는 팀장을 모두 재우고, 로그인 서비스를 해제하고, 실행 엔진을 끕니다. 앱을 지운 뒤에도 묻지 않기 권한의 AI 세션이 화면 없이 남던 일을 막습니다. 데이터는 기본으로 남기며, 지우려면(`--purge`) 한 번 더 확인합니다.
- **보관한 프로젝트를 지우고 내보냅니다.** 보관함의 프로젝트를 지우거나(보관한 프로젝트만), 대화·결재·할 일·업무·자료와 첨부 원본을 zip 하나로 내보냅니다. 내보내기는 서버가 도는 Mac에서만 됩니다.
- **앱을 올리면 서버도 새 버전으로.** Mac 앱을 새 버전으로 바꿨는데 서버가 옛 버전으로 돌고 있으면 서버를 새 버전으로 다시 시작할지 한 번 묻습니다. 팀장 세션은 이어집니다. 앱이 직접 관리하는 설치에서만 묻습니다.
- **앱과 서버가 맞지 않을 때만 안내합니다.** 이번 앱부터 자기 버전을 서버에 알리고, 실제로 맞지 않을 때만 '앱을 업데이트하세요'와 '서버가 옛 버전입니다'를 구분해 보여 줍니다. 출시된 iPhone 0.2.2·0.2.3 앱이 받는 응답은 그대로이며, 그 앱이 새 서버의 응답을 실제로 풀어 읽는지 출시 전 검사에서 확인합니다.
- **Mac 새 버전 알림.** Mac 앱이 하루에 한 번 GitHub의 최신 릴리스를 확인해, 새 버전이 있으면 설정 → 연결 → 앱에 '새 버전 있음'을 띄웁니다. 알리기만 하고 설치하지는 않습니다. 이 확인 요청을 개인정보 처리방침에 적었습니다.
- **CLI 버전을 기록하고 처음 보는 버전을 알립니다.** 서버가 시작할 때 Claude Code·Codex의 버전을 읽어 처음 본 시각과 함께 `~/.iamceo/cli-versions.json`에 남기고, IAMCEO가 시험해 보지 않은 버전이면 점검표와 서버 로그에 '확인되지 않은 CLI 버전'으로 알립니다. CLI 화면과 기록을 버전별 견본으로 저장해 시험에 씁니다.
- **안쪽 기록의 보존 기한.** AI 세션에 넣은 글의 사본은 전달이 끝나고 30일 뒤에 비우고, 실행 기록과 처리 영수증은 끝나고 90일 뒤에 지웁니다. 대화·결재·할 일·자료는 지우지 않습니다. 살아 있는 기록만 빨리 찾도록 색인을 더했습니다.
- **보고 언어.** 설정 → 일반 → 운영 → 보고 언어에서 English를 고르면 총괄·팀장이 보고, 결재 카드, 할 일을 영어로 씁니다. 서버가 붙이는 출처 표시(`[대표]`, `[총괄]` 등)는 그대로 두고 그 뜻을 역할 지침에 영어로 설명합니다. 새 세션부터 적용됩니다.
- **설치 스크립트와 명령줄이 영어로도 말합니다.** 터미널의 언어(`LANG`)가 한국어가 아니면 안내와 오류를 영어로 씁니다. `IAMCEO_LANG=ko` 또는 `IAMCEO_LANG=en`으로 정할 수 있습니다.
- **사용자 문서.** [시작하기, 문제 해결, iPhone 연결, 업그레이드·백업·제거](docs/guide/README.md)를 한국어와 영어로 더했습니다. 새 Mac에서 백업으로 시작하는 절차, 역할 지침을 고치는 실제 절차, 백업에 들어가는 것과 빠지는 것을 적었습니다. 개인정보 처리방침에 새 버전 확인, 진단 파일, 보존 기한, 프로젝트 내보내기·삭제를 적었습니다.
- **사용 한도로 멈춘 팀장은 모델만 바꾸면 같은 대화로 바로 이어 갑니다.** 한 모델에만 걸린 한도(그 모델의 크레딧 소진, Opus 한도 등)면 결재함의 사용 한도 카드에서 다른 모델을 고르거나, 팀장 설정에서 모델을 바꾸거나, 총괄에게 바꾸라고 하면(새 도구 `team_model`), 한도 창은 Esc로만 닫고 같은 세션을 새 모델로 이어 연 뒤 멈춘 곳부터 이어서 하게 합니다. 새 팀장을 띄우지 않으므로 오류 표시가 남은 팀장도 생기지 않습니다. 5시간·주간 한도처럼 모든 모델이 같이 쓰는 한도에는 모델 선택지를 내지 않고, 카드에서 한 번 걸린 모델은 다시 내지 않습니다. 카드는 계정이 하나인 사람도 기준으로 삼아, 기다리면 저절로 이어 간다는 것과 어느 모델의 크레딧이 떨어졌는지를 먼저 알려 줍니다. 한도로 멈춘 팀장도 이제 재우거나 닫을 수 있고, 재운 팀장은 한도가 풀려도 스스로 깨우지 않습니다(카드의 '이어가기'나 모델 변경으로 깨웁니다). CLI를 바꾸면 한도 보류도 풀립니다.
- **Mac을 다시 시작한 뒤 지시를 못 받던 팀장이 풀립니다.** 자동 압축의 결과를 확인하지 못한 채 Mac이 꺼지면, 그 팀장은 다시 열어도 지시를 받지 못했습니다(압축을 받은 터미널이 사라져 아무도 결과를 확정하지 못했습니다). 이제 그 터미널이 없으면 압축을 닫고 밀린 지시를 이어서 넣습니다.
- **재시작으로 꺼진 세션을 오류처럼 보이지 않게.** Mac이나 실행 엔진이 다시 시작되어 꺼진 팀장에게 내부 용어(`holder_lost`) 대신 무슨 일이고 어떻게 되는지를 적습니다.
- **Tailscale이 꺼져 있으면 알려 줍니다.** iPhone을 연결해 쓰던 Mac에서 Tailscale이 1분 넘게 꺼져 있으면 Mac 알림과 Mac 앱의 안내 한 줄로 알립니다. Tailscale을 켜면 다시 연결되고 안내는 사라집니다.
- **Mac을 다시 시작하면 꺼진 팀장을 스스로 다시 엽니다.** 깨어 있던 팀장이 Mac이나 실행 엔진의 재시작으로 꺼지면, 서버가 다시 뜬 뒤 총괄부터 한 명씩 같은 대화를 이어서 엽니다. 대표나 총괄이 재운 팀장은 그대로 자고, 스스로 죽은 세션은 다시 띄우지 않습니다. 사용 한도로 멈춘 팀장도 열지 않고 한도 표시와 카드를 그대로 둡니다(한도가 풀리거나 모델을 바꾸면 열립니다). 여는 데 실패하면 한 번만 해 보고 꺼진 채 둡니다.
- **재시작으로 끊긴 일을 팀장이 이어서 합니다.** 일하던 도중에 꺼진 팀장은 다시 열린 뒤 "끊긴 곳을 확인하고 끝나지 않은 부분만 이어서 하라"는 글을 한 번 받습니다. 총괄에게는 다시 지시하지 말라는 소식만 가므로 같은 일을 두 번 하지 않습니다. 다시 열지 못했을 때만 전처럼 총괄을 깨워 중단을 알립니다.
- **깨운 직후의 잘못된 '승인 대기' 알림이 없어집니다.** 팀장을 깨우면 준비를 알리기 전 몇 초가 막힘으로 스쳐, 승인 창이 없는데도 알림이 떴습니다. 갓 띄운 세션은 막힘으로 보지 않고, 막힘 알림은 막힘이 5초 이어진 뒤에만 보냅니다.
- **재시작 뒤 대기로만 남던 지시가 스스로 풀립니다.** 지시가 들어가는 순간 Mac이나 실행 엔진이 꺼지면, 그 팀장은 다시 열어도 그 지시와 뒤에 온 지시를 모두 받지 못했습니다. 이제 지시를 받던 터미널이 끝난 것이 확인되면 세션 기록을 읽어, 받았으면 전달됨으로 확정하고 못 받았으면 다시 열린 세션에 다시 넣습니다. 기록을 읽지 못했을 때만 대표에게 묻고, 그때의 '중복 위험 동의 재전송'은 이제 실제로 다시 넣습니다.
- **끊긴 세션 작업 때문에 깨워도 열리지 않던 팀장이 풀립니다.** 설정을 바꾸거나 새 세션을 여는 도중에 연결이 끊기면 그 팀장은 지시도, 깨우기도, 설정 변경도 받지 않았습니다. 터미널이 끝났는지 살아 있는지 확인해 그 작업을 닫고, 직접 조작하던 터미널이 사라졌을 때 조작권이 5분 동안 전달을 막던 것도 없앴습니다.

### 0.2.3 — 2026-11-12

2026-11-11 안정성 수정과 그 뒤의 완성도 손질입니다. iPhone 앱 0.2.2는 이 버전의 Mac 서버와 그대로 맞습니다.

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
- **예전 실행 방식을 지웠습니다.** 팀장은 모두 실행 엔진(herdr-core)에서 띄웁니다. 예전 방식 두 가지(herdr, headless)의 코드와, 그 방식에만 있던 '기존 터미널 세션 편입'을 없앴습니다. 서버는 이제 개인 herdr에 아무것도 묻지 않습니다. 앱 화면은 그대로이고, 예전 방식의 세션이 남은 팀장은 전처럼 보류됩니다.
- **말을 걸기 전의 팀장도 설정을 바꾸고 보관할 수 있습니다.** 총괄만 시작하고 아직 말을 걸지 않은 상태에서 모델을 바꾸면 그 세션이 오류와 함께 꺼지던 문제를 고쳤습니다(새 세션으로 엽니다). 그런 프로젝트와, 터미널이 꺼진 팀장이 섞인 프로젝트도 이제 보관됩니다. 입력칸에 쓰던 글이 있으면 전처럼 보관하지 않습니다.
- **팀장이 끝내 보고하지 않으면 총괄에게도 알립니다.** 팀장이 보고 없이 일을 끝내고 보고를 다시 요청해도 답이 없으면, 홈 화면 알림과 함께 그 프로젝트의 총괄을 깨워 한 번 알립니다. 전에는 대표가 알림을 보고 말을 걸 때까지 프로젝트가 멈춰 있었습니다.
- **가져온 팀원 자리를 깨울 수 있습니다.** `iamceo import`로 가져온 팀원 자리는 총괄을 시작한 뒤 일을 맡기거나 깨우면 새 세션으로 열립니다. 전에는 영어 오류와 함께 열리지 않았습니다.
- **꺼진 터미널의 화면 조회가 오류를 내지 않습니다.** 잠들었거나 터미널이 끝난 팀장의 화면을 조회하면 서버 오류 대신 빈 화면으로 답합니다. 예전 실행 방식의 세션이 남은 팀장도 명부에서 닫을 수 있습니다.
- **멈춘 까닭이 '확인 안 됨'으로 바뀌지 않습니다.** 승인 창 앞에서 멈춘 팀장에게 말을 보내면, 방금 읽은 까닭(승인 창)이 '확인 안 됨'으로 덮이던 문제를 고쳤습니다.
- **CLI에 Mac 사용자 이름을 꼭 넘깁니다.** 서버가 사용자 이름 없이 떠 있어도 Claude Code에는 채워서 넘깁니다. 이름 없이 뜬 Claude Code가 키체인에 빈 로그인 항목을 하나 더 만드는 일을 막습니다.
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
- **모델은 CLI가 알려 준 목록에서.** 직급별 모델을 CLI가 알려 준 목록에서 고르고, Codex 팀장의 직급별 모델과 effort를 따로 정합니다.
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

- **IAMCEO checks its own setup.** 설정 → AI 모델 → 실행 환경 (Settings → AI models → Runtime) becomes a checklist: the server, the engine, Claude Code and Codex installs and sign-ins, CLI versions, Tailscale, start at login, backups and disk space, each with a one-line fix that points to something a normal user can do (an app button, an install command). `iamceo doctor` runs the same checks, even while the server is down.
- **Diagnostic file.** "진단 파일 만들기" (make a diagnostic file) in Settings, on the Mac that runs the server, and `iamceo diagnose` collect versions, the service state, the checklist, the end of the logs, stall records and the backup state into one folder and a zip under `~/.iamceo/diagnostics`. The text of conversations and files, attachments, the access code, staff keys, push tokens and environment variable values are left out.
- **`iamceo upgrade` and `iamceo rollback`.** On an installed app, upgrade downloads the new version, checks its checksum, signature and notarization, rehearses it on a copy of the current database, then replaces the app. It records the previous version and rolls back by itself if the new one is not ready in time. `iamceo rollback` returns to the version before the last upgrade.
- **Stop completely on this Mac.** The app and `iamceo uninstall` put every managed staff session to sleep, remove the login service and stop the engine, so no "don't ask" AI session is left running without a screen after the app is deleted. Data is kept by default; deleting it (`--purge`) asks once more.
- **Archived projects can be deleted and exported.** Delete a project from the archive (archived projects only), or export its conversations, decisions, to-dos, work and files with the original attachments as one zip. Export works only on the Mac that runs the server.
- **Updating the app updates the server too.** When the Mac app is replaced with a new version while the server still runs the old one, the app asks once whether to restart the server on the new version. Staff sessions continue. It asks only on an installation the app manages itself.
- **A notice only when the app and the server really do not match.** From this app on, the app tells the server its version, and it shows "update the app" or "the server is an older version" only when they actually do not match. Responses to the released iPhone apps 0.2.2 and 0.2.3 are unchanged, and a pre-release check confirms that those apps still decode the new server's responses.
- **New version notice on the Mac.** Once a day the Mac app checks GitHub's latest release and, when there is a newer one, shows "새 버전 있음" (new version) under Settings → Connection → App. It only tells you; it does not install. This check is described in the privacy policy.
- **CLI versions are recorded, and an unfamiliar one is flagged.** When it starts, the server reads the Claude Code and Codex versions, records them with the time it first saw each in `~/.iamceo/cli-versions.json`, and flags a version IAMCEO has not been tested against as "unverified CLI version" in the checklist and the server log. CLI screens and records are kept as per-version samples for the tests.
- **Retention for internal records.** The copy of the text typed into an AI session is cleared 30 days after the delivery finished; run records and receipts are deleted 90 days after they finished. Conversations, decisions, to-dos and files are never deleted by this. New indexes find live records quickly.
- **Report language.** Choose English in 설정 → 일반 → 운영 → 보고 언어 (Settings → General → Operation → Report language) and the lead and staff write their reports, decision cards and to-dos in English. The source labels the server adds (`[대표]`, `[총괄]` and so on) stay as they are, and the role instructions explain them in English. It applies to new sessions.
- **The installer and the command line speak English too.** When the terminal's language (`LANG`) is not Korean, messages and errors are in English. Set `IAMCEO_LANG=en` or `IAMCEO_LANG=ko` to choose.
- **User guides.** Added [Getting started, Troubleshooting, Connecting an iPhone, and Upgrade, backup and uninstall](docs/guide/README.md) in English and Korean, including how to start a new Mac from a backup, the real procedure for changing the role rules, and what a backup does and does not contain. The privacy policy now covers the update check, diagnostic files, retention, and project export and deletion.
- **Staff stopped by a usage limit continue the same conversation once you change their model.** When the limit belongs to one model (its credits ran out, an Opus limit), pick another model on the usage-limit card in the inbox, change it in the staff member's settings, or ask the lead to (new tool `team_model`): the limit menu is closed with Esc only, the same session is reopened on the new model, and the work picks up where it stopped. No replacement staff member is started, so no one is left showing an error. A limit every model shares (5-hour, weekly) offers no model choices, and a model that hit a limit on the card is not offered again. The card no longer assumes you have a second account: it says waiting continues on its own and names the model whose credits ran out. Staff stopped by a usage limit can now also be put to sleep or closed; staff put to sleep are not woken by the server when the limit lifts (use the card's continue button or a model change). Switching the CLI also releases the hold.
- **Staff that stopped receiving work after a Mac restart recover.** If the Mac went down while an automatic compaction was still unconfirmed, that staff member received nothing after being reopened (the terminal that took the compaction was gone, so nobody could confirm it). The server now closes that compaction when its terminal no longer exists and delivers the queued work.
- **A session ended by a restart no longer looks like an error.** Staff switched off by a Mac or engine restart show what happened and what to do instead of an internal term (`holder_lost`).
- **You are told when Tailscale is off.** On a Mac that an iPhone has been connecting to, Tailscale being off for more than a minute raises a Mac notification and a line in the Mac app. Turn Tailscale back on and the iPhone connects again; the line goes away.
- **Staff switched off by a Mac restart are reopened automatically.** When staff who were awake are switched off by a Mac or engine restart, the server reopens the same conversations once it is back, the lead first, one at a time. Staff you or the lead put to sleep stay asleep, and a session that ended on its own is not relaunched. Staff stopped by a usage limit are not reopened either and keep their limit status and card (they open when the limit lifts or their model is changed). A reopen that fails is tried once and left off.
- **Work cut off by a restart is continued by the same staff member.** A staff member switched off mid-task gets one note after reopening: check where the work stopped and finish only what is left. The lead only gets a notice not to assign it again, so the work is not done twice. The lead is woken about the interruption, as before, only when the reopen fails.
- **No more false "waiting for approval" alert right after a wake.** A woken session showed as blocked for a few seconds before it reported ready, which raised an alert with no dialog on screen. A session that has just started is no longer treated as blocked, and a blocked alert is sent only after the block has lasted 5 seconds.
- **Instructions stuck after a restart now clear on their own.** If the Mac or the engine went down at the moment an instruction was going in, that staff member received neither it nor anything sent later, even after being reopened. Once the terminal that was taking the instruction is confirmed gone, the server reads the session record: received means it is marked delivered, not received means it is sent again to the reopened session. You are asked only when the record cannot be read, and "resend, accepting a possible duplicate" now really resends.
- **Staff that would not reopen after an interrupted session change recover.** If the connection dropped while changing settings or starting a fresh session, that staff member took no instructions, wake-ups or settings changes. The server now checks whether the terminal ended or is still alive and closes the interrupted operation. Terminal control held on a terminal that has disappeared no longer blocks delivery for five minutes.

### 0.2.3 — 2026-11-12

The stability pass of 2026-11-11 and the completeness pass that followed. The iPhone app 0.2.2 keeps working with this version of the Mac server.

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
- **The old ways of running sessions are gone.** All staff now run on the bundled engine (herdr-core). The code for the two earlier modes (herdr and headless) is removed, along with the one feature only they had: taking over a terminal session you had already opened. The server no longer queries your personal herdr. The app looks the same, and staff still holding a session from an earlier mode stay on hold as before.
- **Staff you have not written to yet can be reconfigured and archived.** Changing the model right after starting the lead, before writing to it, used to switch that session off with an error; it now opens as a new session. Such a project, and a project with a staff member whose terminal has gone, can now be archived. Text left in an input box still blocks archiving, as before.
- **The lead is told when a staff member never reports.** When a staff member ends a job without reporting and stays silent after being asked again, the server wakes that project's lead once to tell it, alongside the Home notice. Before, the project sat idle until you saw the notice and wrote something.
- **Imported staff slots can be woken.** A slot brought in with `iamceo import` opens as a new session when you start the lead and then assign it work or wake it. Before, it failed with an English error.
- **Reading the screen of a closed terminal no longer errors.** For a staff member who is asleep or whose terminal has ended, the screen request returns an empty screen instead of a server error. Staff still holding a session from an earlier mode can now be removed from the roster.
- **A blocked reason is no longer replaced by "unknown".** Writing to a staff member stopped at a confirmation dialog used to overwrite the reason just read from the terminal with "unknown".
- **The CLI always gets the Mac user name.** Even when the server runs without a user name in its environment, it passes one to Claude Code. This stops Claude Code from creating a second, empty login entry in the keychain.
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
- **Models from the CLI's own list.** Rank models are picked from the list the CLI reports, and Codex staff get their own model and effort per rank.
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
