# 개인정보 처리방침 · Privacy Policy

시행일: 2026-11-10 · 고친 날: 2026-11-13 · Effective: 2026-11-10 · Revised: 2026-11-13

[한국어](#한국어) · [English](#english)

## 한국어

IAMCEO(이하 "앱")는 사용자가 자신의 Mac에서 실행하는 IAMCEO 서버에 연결해 쓰는 앱입니다. 대화·결재·파일은 사용자의 Mac에만 있습니다. 개발자가 운영하는 서버는 iPhone 알림을 Apple에 넘겨 주는 **알림 중계** 하나뿐이며, 중계는 대화 내용을 받지 않습니다.

**1. 개발자가 수집하는 정보**
없습니다. 앱에는 광고, 분석, 추적, 충돌 보고 도구가 들어 있지 않습니다.
다만 iPhone 알림을 켰고 사용자의 Mac에 그 앱의 Apple 알림 키가 없을 때(App Store에서 받은 앱은 보통 이렇습니다), 사용자의 Mac이 알림 한 건마다 다음 값을 개발자의 알림 중계로 보냅니다: iPhone의 푸시 토큰, 알림 종류, 무작위 식별자(서버·사건·발신 ID와 알림을 눌렀을 때 열 화면의 내부 ID), 유효 시각. 처음 한 번은 Mac마다 무작위 설치 ID와 비밀값을 받아 그 Mac에 둡니다(계정·메일·이름은 받지 않습니다). 중계는 받은 값으로 정해진 문구의 알림을 만들어 Apple 푸시 알림 서비스(APNs)에 넘긴 뒤 버리며, 푸시 토큰과 식별자를 저장하지 않습니다. 연결 과정에서 사용자 Mac의 IP 주소가 중계에 보이지만 중계는 그것을 기록하지 않습니다. 남용을 막으려고 설치·iPhone마다 보낸 건수와, 설치를 만들 때(Mac마다 처음 한 번) IP 주소마다 만든 건수를 중계의 메모리에서만 세며(iPhone과 IP 주소는 날마다 바뀌는 비밀값으로 바꾼 값으로만 셉니다) 하루 안에 사라집니다. 중계의 운영 기록(Google Cloud Logging, 기본 30일 보관)에는 시간마다의 처리 건수와, 오류가 났을 때의 설치 ID·오류 사유 코드·시각만 남고, 푸시 토큰·IP 주소·알림 식별자는 남지 않습니다. 중계는 알림이 언제 몇 건 오가는지는 알 수 있지만 그 내용은 알 수 없습니다.

**2. 앱이 다루는 정보와 저장 위치**
- 대화, 결재, 할 일, 자료, 첨부 파일은 사용자가 연결한 사용자 자신의 Mac(IAMCEO 서버)에 저장됩니다.
- iPhone에는 접속 코드가 키체인에, 연결 주소가 앱 안에 저장됩니다. 쓰던 글(초안)과, 보낸 뒤 접수를 아직 확인하지 못한 메시지·요청의 기록도 앱 안에 저장됩니다. 그 밖에는 아래의 마지막으로 본 상태와 화면 표시를 위한 임시 데이터만 남습니다.
- 앱(iPhone·Mac)은 서버에 닿지 않을 때도 보여 주려고, 서버가 마지막으로 확인해 준 상태 하나(프로젝트 목록과 보던 프로젝트의 팀원·결재·할 일·자료·최근 대화)를 앱 안의 파일로 남깁니다. 연결되지 않은 동안 '연결되면 보낼 글'로 둔 글도 앱 안의 파일에 남습니다(그 글을 쓸 때 보던 서버의 데이터 폴더 경로와 서버가 알려 준 주소를 함께 둡니다. 같은 서버를 다른 주소로 다시 연결했는지 가리는 데만 씁니다). 두 파일은 기기 밖으로 나가지 않고 기기 백업에서도 빠지며, iPhone에서는 기기가 잠겨 있는 동안 읽을 수 없는 완전 보호 파일입니다(Mac에서는 그 사용자만 읽는 파일). 마지막 상태는 한 서버 것만 두고 2MB를 넘지 않게 오래된 글부터 덜어 냅니다. 같은 Mac의 서버에 붙은 Mac 앱은 마지막 상태를 남기지 않습니다.
- iPhone 첫 화면의 '샘플로 둘러보기'(Mac에서는 `--demo`로 연 앱)는 앱 안에 든 예시 데이터로만 돌아갑니다. 샘플에서 보내거나 바꾼 내용은 앱의 메모리에만 있다가 샘플을 나가거나 앱을 끄면 사라집니다. 샘플은 어떤 서버나 인터넷에도 요청을 보내지 않고, 기기에 아무것도 저장하지 않습니다.
- 사진·파일 첨부는 사용자가 고른 항목만 사용자의 Mac으로 보내집니다. 사진 보관함에서 고르거나 카메라로 찍은 사진은 위치 정보(GPS)를 지우고 보냅니다. 영상과, 파일로 붙인 항목은 원본 그대로 보내므로 그 안에 든 위치 정보 같은 부가 정보도 함께 갑니다.
- 알림을 켜면 iPhone의 푸시 토큰이 사용자의 Mac에 저장되고, 알림은 Apple 푸시 알림 서비스(APNs)를 통해 전달됩니다. 사용자의 Mac에 그 앱의 Apple 알림 키가 있으면 알림은 Mac에서 APNs로 바로 가고, 없으면 개발자의 알림 중계를 거쳐 APNs로 갑니다(1절). 어느 길이든 알림에는 정해진 문구와 식별자만 실리고 대화 내용은 실리지 않습니다. 중계를 쓰는 Mac은 중계에서 받은 설치 ID와 비밀값을 같은 Mac의 `~/.iamceo/push-relay.json`(그 사용자만 읽는 파일)에 두며, 이 파일은 백업에 넣지 않습니다. `~/.iamceo/config.json`에 `"pushRelay": false`를 넣으면 중계를 쓰지 않으며, 그러면 App Store 앱은 iPhone 알림을 받지 못합니다.
- 사용자의 Mac에 있는 서버는 같은 Mac의 `~/.iamceo/backups`에 정기 백업을 만듭니다. 백업에는 대화·첨부와 함께 접속 코드가 들어 있습니다(QR로 연결한 기기의 열쇠는 해시만 들어갑니다). 백업을 다른 곳으로 옮기면 접속 코드도 함께 옮겨집니다.
- 서버는 같은 Mac에 접속 기록을 남깁니다. QR로 연결한 기기의 이름(앱이 보낸 기기 이름)과 마지막 접속 시각·주소, 틀린 코드나 끊은 기기로 들어오려 한 시도의 주소·시각, 기기를 끊은 일과 접속 코드를 바꾼 일입니다. 코드·열쇠 값은 남기지 않습니다. 이 기록은 설정의 '연결된 기기'에 보이고, 어디로도 보내지 않습니다.
- 서버는 같은 Mac에 설치된 Claude Code·Codex의 버전과 처음 본 시각을 `~/.iamceo/cli-versions.json`에 남깁니다.
- IAMCEO가 띄운 Claude Code 세션은 세션 시작·입력 접수·턴 끝·오류 종류·압축을 같은 Mac의 `~/.iamceo/run/events`에 한 줄씩 남깁니다. 시각, 세션 ID, IAMCEO 전달 표지, 오류 분류값, 입력 글자 수만 적고 글 본문은 적지 않습니다. 서버가 이 기록과 자기 판단이 맞는지 센 숫자는 같은 폴더와 진단 파일에 들어갑니다. 어디로도 보내지 않습니다.
- IAMCEO가 띄운 Claude Code 세션의 상태줄 기록(같은 Mac의 `~/.iamceo/context`)에는 문맥 사용량과 함께 CLI가 보고한 그 세션의 비용·토큰 수·계정 한도 사용률이 들어갑니다. 서버는 이 값과 Codex 세션 기록의 토큰 수·한도 사용률을 읽어, 팀원·프로젝트·날짜별 합계를 같은 Mac의 DB에 남기고 설정의 '사용량'에 보여 줍니다. 이 합계에는 숫자와 팀원 이름만 들어가고 대화 내용은 들어가지 않습니다. 어디로도 보내지 않습니다.
- `iamceo upgrade`로 새 버전으로 올리면, 되돌릴 때 쓰려고 올리기 전의 DB 사본(대화 포함)을 같은 Mac의 `~/.iamceo/upgrades`에 남깁니다. 가장 최근 두 번의 업그레이드 것만 남깁니다. `iamceo rollback`으로 DB까지 되돌리면 그때의 DB(업그레이드 뒤에 쌓인 대화 포함)를 같은 폴더 안에 옆 사본으로 남기며, 이 사본은 오래된 업그레이드 기록을 정리할 때도 지우지 않습니다(데이터 폴더를 지우면 함께 지워집니다).
- 앱은 서버에 요청할 때 자신의 버전과 기기 종류(Mac·iPhone)를 함께 보냅니다. 받는 곳은 사용자 자신의 Mac 서버이고, 서버는 이를 서버 로그와 진단 파일에 기록하고 앱과 맞지 않을 때 안내하는 데 씁니다.
- 사용자가 진단 파일을 만들면(앱의 '진단 파일 만들기' 또는 `iamceo diagnose`) 같은 Mac의 `~/.iamceo/diagnostics`에 저장됩니다. 버전(접속한 앱의 버전 포함), 서비스 상태, 서버 로그의 끝부분, 백업 상태, 데이터의 상태 요약(ID·상태·시각·개수), 설정 값, 접속 주소(Tailscale 주소 포함)와 포트, 데이터 폴더와 실행 파일의 경로(사용자 이름 포함), 충돌 보고 파일의 이름, iPhone 알림을 보내는 방법과 상태(중계를 쓰는지, 중계 설치를 만든 날. 설치 ID와 비밀값은 빼고)가 들어가고, 대화·보고·결재·할 일·자료의 본문, 첨부 파일, 접속 코드, 알림 토큰, 환경 변수의 값은 넣지 않습니다. 로그에는 파일 경로나 프로젝트 이름이 남을 수 있습니다. 진단 파일은 어디로도 저절로 보내지 않으며, 보낼지는 사용자가 정합니다.

**3. 제3자 서비스**
사용자의 Mac에서 돌아가는 AI 도구(예: Claude Code, Codex CLI)는 사용자 자신의 계정으로 각 서비스 제공자와 통신합니다. 이 통신은 해당 제공자의 개인정보 처리방침을 따르며, 개발자는 그 내용에 접근하지 않습니다.
서버가 AI 서비스에 장애가 났다고 판단한 동안에는, 복구됐는지 알아보려고 사용자의 Mac에서 AI 회사의 주소(`api.anthropic.com`, Codex를 쓰면 `api.openai.com`)로 내용이 없는 확인 요청을 보냅니다. 이 요청에 대화 내용이나 계정 정보는 싣지 않습니다.
Mac 앱은 새 버전이 나왔는지 알려 주려고, 실행 중일 때 하루에 한 번 GitHub(`api.github.com`)에 IAMCEO의 최신 릴리스를 묻습니다. 이 요청에는 요청 자체의 정보(IP 주소, 'IAMCEO-Mac'이라는 앱 표시)만 담기고 계정·프로젝트·대화·서버 주소·접속 코드는 담지 않습니다. 이 요청은 GitHub의 개인정보 처리방침을 따릅니다. 새 버전을 받거나 설치하지는 않습니다. iPhone 앱은 이 확인을 하지 않습니다.
사용자가 설치 스크립트나 `iamceo upgrade`로 새 버전을 받을 때도 GitHub의 릴리스 주소에서 받습니다.
iPhone 알림을 중계로 보낼 때(1절) 다음 두 회사가 개발자를 대신해 처리합니다(처리 위탁).
- Google LLC(미국): 알림 중계를 Google Cloud의 Firebase Cloud Functions에서 실행합니다. Google은 중계로 들어오는 요청을 처리하는 동안 IP 주소를 잠시 다룹니다. Google의 플랫폼은 요청마다 시각·IP 주소·경로·결과를 운영 기록(Cloud Logging)에 남길 수 있는데, 개발자는 중계의 요청 기록을 저장하지 않도록 설정합니다. Google은 Google과 그 대리인이 시설을 둔 곳에서 데이터를 처리할 수 있습니다.
- Apple Inc.(미국): APNs로 알림을 iPhone에 전달합니다.

**국외 이전.** 중계를 쓰면 다음과 같이 국외로 이전됩니다. 이전 항목: 푸시 토큰, 알림 종류와 무작위 식별자, 유효 시각, (연결 과정에서) 사용자 Mac의 IP 주소. 이전 국가: 미국(Google LLC, Apple Inc.)과 Google이 시설을 둔 나라. 시기와 방법: 알림이 생길 때마다 암호화된 연결(HTTPS)로. 받는 자: Google LLC(https://firebase.google.com/support/privacy), Apple Inc.(https://www.apple.com/legal/privacy/). 목적과 보유 기간: 알림 전달과 남용 방지를 위해서이며, 알림 값은 전달하면 곧바로 버리고 남용 방지를 위해 메모리에서 센 수(IP 주소는 바꾼 값으로만)는 하루 안에 사라집니다. 거부 방법과 효과: iPhone 알림을 끄거나 `config.json`에서 중계를 끄면 이전되지 않으며, 그 경우 App Store 앱은 iPhone 알림을 받지 못하지만 앱의 다른 기능은 그대로 쓸 수 있습니다.

**4. 보관과 삭제**
모든 데이터는 사용자의 Mac에 있으므로 사용자가 직접 지울 수 있습니다.
- 대화, 결재, 할 일, 자료는 사용자가 지우기 전까지 보관합니다. 보관함에 넣은 프로젝트는 앱에서 프로젝트 단위로 내보내거나 지울 수 있습니다. 지운 프로젝트는 이미 만든 백업에 남아 있다가, 오래된 백업이 차례로 지워지면서(길게는 약 4주) 사라집니다. `iamceo upgrade`가 남긴 DB 사본에도 남아 있다가, 그 뒤로 두 번 더 업그레이드하면 사라집니다. `iamceo rollback`이 옆에 남긴 DB 사본에 들어 있으면 그 사본을 지울 때까지 남습니다.
- 내보내기는 서버가 있는 그 Mac에서 연결한 앱에서만 됩니다. 내보낸 zip 파일에는 그 프로젝트의 대화와 첨부 원본이 그대로 들어 있습니다(접속 코드와 팀장 열쇠는 넣지 않습니다).
- 서버가 안에서만 쓰는 기록은 정해진 기한이 지나면 스스로 정리합니다. AI 세션에 넣은 글의 사본은 그 전달이 끝나고 30일 뒤에 비웁니다. 실행 기록과 처리 영수증은 끝나고 90일 뒤에 지웁니다. 아직 끝나지 않은 일의 기록은 지우지 않습니다.
- 사용량 합계는 90일이 지나면 지웁니다. 프로젝트를 지우면 그 프로젝트의 사용량도 함께 지웁니다.
- 정기 백업은 일별 7개와 주별 4개를 남기고 오래된 것부터 지웁니다. 진단 파일은 가장 최근 다섯 개만 남깁니다.
- 접속 기록은 90일이 지나면 지우고, 2,000줄을 넘으면 오래된 것부터 지웁니다. 끊은 기기의 열쇠 기록도 끊은 지 90일 뒤에 지웁니다.
- 'iamceo uninstall' 또는 앱의 '이 Mac에서 완전히 멈추기'는 기본으로 데이터를 남기며, 데이터까지 지우려면 한 번 더 확인합니다. 데이터까지 지우면 `~/.iamceo` 안의 백업·진단 파일·업그레이드 기록도 함께 지워지지만, `iamceo backup --directory`로 다른 곳에 만든 백업은 지우지 않습니다. Homebrew의 `brew uninstall --zap`도 데이터 폴더까지 지웁니다.
- iPhone에 저장된 접속 코드는 앱의 설정에서 '나가기'를 누르면 지워집니다. 초안과 접수 확인 기록은 '나가기'로는 지워지지 않으며, 앱을 지우면 함께 지워집니다.
- 알림 중계에는 푸시 토큰과 식별자가 남지 않으므로 따로 지울 것이 없습니다. iPhone 알림을 끄거나 Mac에서 기기를 해지하면 그 뒤로는 중계로 아무것도 보내지 않습니다. 중계가 남용을 막으려고 메모리에서 세는 건수는 하루 안에 사라집니다. Mac에 둔 설치 파일(`~/.iamceo/push-relay.json`)은 지우면 다음 알림 때 새 설치로 등록됩니다.
- 마지막으로 본 상태는 다른 서버로 바꾸거나, '나가기'를 누르거나, 접속 코드가 거절되면 지워집니다. 연결되면 보낼 글은 보내지거나 사용자가 지우면 없어지고, '나가기'를 누르거나 다른 서버에 연결하면 그전 서버에 보내려던 글도 함께 지워집니다(같은 Mac을 다른 주소로 다시 연결한 것이면 지우지 않고 그대로 보냅니다). 앱을 지우면 둘 다 지워집니다.

**5. 어린이**
앱은 어린이를 대상으로 하지 않으며, 어린이의 정보를 알면서 수집하지 않습니다.

**6. 문의**
https://github.com/yehsung/IAMCEO/issues

## English

IAMCEO (the "App") connects to an IAMCEO server that you run on your own Mac. Your conversations, decisions and files stay on your Mac. The only server the developer runs is a **notification relay** that hands iPhone notifications to Apple, and it never receives conversation content.

**1. Data the developer collects**
None. The App contains no advertising, analytics, tracking, or crash-reporting tools.
Only when you turn on iPhone notifications and your Mac has no Apple push key for the App of its own (usual for the App from the App Store), your Mac sends the developer's notification relay, for each notification: your iPhone's push token, the notification type, random identifiers (server, event and delivery IDs, and the internal IDs of the screen a tap opens) and an expiry time. Once per Mac it also receives a random installation ID and secret, kept on that Mac (no account, email or name). The relay builds the notification with a fixed sentence, passes it to Apple Push Notification service (APNs) and discards what it received; it does not store push tokens or identifiers. The relay sees your Mac's IP address while connecting but does not record it. To prevent abuse it counts, in memory only, notifications per installation and per iPhone, and installations created per IP address when an installation is made (once per Mac); an iPhone and an IP address are counted only by a value derived with a secret that changes daily, and the counts are gone within a day. The relay's operation log (Google Cloud Logging, kept 30 days by default) holds only hourly totals and, when something fails, the installation ID, an error reason code and the time — never push tokens, IP addresses or notification identifiers. The relay can tell when and how many notifications are sent, but not what they are about.

**2. Data the App handles and where it is stored**
- Conversations, decisions, to-dos, files, and attachments are stored on your own Mac (your IAMCEO server).
- On iPhone, the access code is stored in the Keychain and the server address inside the App. Text you are still writing (drafts) and a record of messages and requests whose receipt has not been confirmed yet are also stored inside the App. Otherwise only the last seen state below and temporary display data are kept.
- So that it can still show something when the server is out of reach, the App (iPhone and Mac) keeps one copy of the last state the server confirmed (the project list, and the members, decisions, to-dos, files and recent conversation of the project you were on) in a file inside the App. Messages you leave as "send when connected" while disconnected are also kept in a file inside the App (together with the data folder path and the addresses of the server you were looking at when you wrote them, used only to tell whether you later reconnect to the same server through another address). Neither file leaves the device or goes into device backups, and on iPhone both are complete-protection files that cannot be read while the device is locked (on Mac, files only your user can read). The last state is kept for one server only and trimmed, oldest messages first, to stay under 2 MB. The Mac App connected to the server on the same Mac does not keep a last state.
- 샘플로 둘러보기 (Look around with a sample) on the iPhone's first screen (and the Mac App opened with `--demo`) runs only on example data built into the App. Whatever you send or change in the sample stays in the App's memory and is gone when you leave the sample or quit the App. The sample sends no request to any server or the internet and saves nothing on the device.
- Photos and files you choose to attach are sent only to your Mac. Location (GPS) data is removed from photos you pick from the photo library or take with the camera. Videos, and anything you attach as a file, are sent as they are, so extra information inside them, such as location, goes with them.
- If you turn on notifications, your iPhone's push token is stored on your Mac, and notifications are delivered through Apple Push Notification service (APNs). If your Mac holds the App's Apple push key, notifications go from your Mac straight to APNs; otherwise they go through the developer's notification relay to APNs (section 1). Either way a notification carries only a fixed sentence and identifiers, never the content of a conversation. A Mac that uses the relay keeps the installation ID and secret it received in `~/.iamceo/push-relay.json` on the same Mac (a file only your user can read), which is not put into backups. Putting `"pushRelay": false` in `~/.iamceo/config.json` turns the relay off; the App from the App Store then receives no iPhone notifications.
- The server on your Mac makes regular backups in `~/.iamceo/backups` on the same Mac. A backup contains your access code along with conversations and attachments (keys of devices connected with a QR code are stored only as hashes). If you move a backup somewhere else, the access code moves with it.
- The server keeps an access record on the same Mac: the names of devices connected with a QR code (the device name the App sends) with when and from which address they last connected, the address and time of attempts with a wrong code or a disconnected device's key, and when a device was disconnected or the access code was changed. No code or key is recorded. The record is shown under 연결된 기기 (Connected devices) in Settings and is never sent anywhere.
- The server records the versions of Claude Code and Codex installed on the same Mac, with the time it first saw each, in `~/.iamceo/cli-versions.json`.
- Claude Code sessions started by IAMCEO write session start, prompt received, turn end, error type and compaction to `~/.iamceo/run/events` on the same Mac, one line each. Only the time, the session ID, IAMCEO delivery markers, the error category and the prompt's length in characters are written, never the text. The counts of how often these records agree with the server's own reading are kept in the same folder and in diagnostic files. Nothing is sent anywhere.
- The status line record of a Claude Code session started by IAMCEO (in `~/.iamceo/context` on the same Mac) holds, along with context usage, the cost, token counts and account limit usage the CLI reported for that session. The server reads these, and the token counts and limit usage in Codex session records, and keeps totals per member, project and day in the database on the same Mac, shown under 사용량 (Usage) in Settings. The totals contain only numbers and member names, never conversation content. Nothing is sent anywhere.
- When you move to a new version with `iamceo upgrade`, a copy of the database from before the upgrade (conversations included) is kept in `~/.iamceo/upgrades` on the same Mac, for rolling back. Only the two most recent upgrades are kept. When `iamceo rollback` also rolls the database back, the database as it was then (including conversations made after the upgrade) is kept aside in the same folder; that copy is not removed when old upgrade records are cleaned up (deleting the data folder deletes it).
- With each request, the App tells the server its own version and device type (Mac or iPhone). The recipient is your own Mac server, which records it in the server log and in diagnostic files and uses it to tell you when the App and the server do not match.
- When you make a diagnostic file (진단 파일 만들기 in the App, or `iamceo diagnose`), it is saved in `~/.iamceo/diagnostics` on the same Mac. It contains versions (including the versions of apps that connected), the service state, the end of the server logs, the backup state, a status summary of your data (IDs, states, times, counts), setting values, the connection addresses (including the Tailscale address) and port, the paths of the data folder and the executables (which include your user name), the names of crash reports, and how iPhone notifications are sent and their state (whether the relay is used and when its installation was made, without the installation ID or secret). It does not contain the text of conversations, reports, decisions, to-dos or files, attachments, the access code, push tokens or environment variable values. Logs can still contain file paths and project names. A diagnostic file is never sent anywhere on its own; you decide whether to share it.

**3. Third-party services**
AI tools running on your Mac (for example Claude Code or Codex CLI) talk to their providers with your own accounts, under those providers' privacy policies. The developer has no access to that traffic.
While the server believes an AI service is down, your Mac sends an empty check request to the provider's address (`api.anthropic.com`, and `api.openai.com` if you use Codex) to see whether it is back. That request carries no conversation content and no account information.
To tell you when a new version is out, the Mac App asks GitHub (`api.github.com`) for IAMCEO's latest release once a day while it is running. That request carries only what any request does (your IP address, and "IAMCEO-Mac" as the app's name), never your accounts, projects, conversations, server address or access code, and it falls under GitHub's privacy policy. Nothing is downloaded or installed by it. The iPhone App does not make this check.
When you get a new version with the install script or `iamceo upgrade`, it is also downloaded from GitHub's release addresses.
When iPhone notifications go through the relay (section 1), two companies process data on the developer's behalf:
- Google LLC (USA) runs the relay on Firebase Cloud Functions in Google Cloud. Google handles IP addresses briefly while serving the relay's requests. Google's platform can record each request's time, IP address, path and result in its operation logs (Cloud Logging); the developer configures the relay so that these request logs are not stored. Google may process data wherever Google or its agents maintain facilities.
- Apple Inc. (USA) delivers notifications to iPhones through APNs.

**Relay: legal basis, transfers and your rights.** The relay processes the data above to provide the notifications you turned on (GDPR Art. 6(1)(b)) and, for counting against abuse, on the basis of legitimate interests (Art. 6(1)(f)). Retention: notification data is discarded right after it is handed to Apple; abuse counts are gone within a day. Transfers: the data goes, over encrypted connections (HTTPS), to the USA (Google LLC, Apple Inc.) and other countries where Google has facilities; Google LLC takes part in the EU-U.S. Data Privacy Framework (with its UK and Swiss extensions). You may ask for access, erasure or objection through the contact below, and complain to your data protection authority. Turning off iPhone notifications, or the relay in `config.json`, stops all transfers; the App from the App Store then gets no iPhone notifications, and the rest of the App keeps working.

**4. Retention and deletion**
All data lives on your Mac, so you can delete it yourself.
- Conversations, decisions, to-dos and files are kept until you delete them. An archived project can be exported or deleted, one project at a time, in the App. A deleted project stays in backups already made until they are rotated out (up to about four weeks). It also stays in the database copies `iamceo upgrade` keeps, until two more upgrades have replaced them, and in a database copy `iamceo rollback` kept aside, until you delete that copy.
- Exporting works only in the App connected on the Mac that runs the server. The exported zip file contains that project's conversations and original attachments as they are (never the access code or staff keys).
- Records the server keeps only for itself are cleaned up after a fixed time. The copy of the text typed into an AI session is cleared 30 days after that delivery finished. Run records and receipts are deleted 90 days after they finished. Records of work that has not finished are never deleted.
- Usage totals are deleted after 90 days. Deleting a project also deletes its usage.
- Daily backups keep 7 daily and 4 weekly copies and delete older ones first. Only the five most recent diagnostic files are kept.
- Access record entries are deleted after 90 days, and the oldest go first beyond 2,000 entries. The record of a disconnected device's key is deleted 90 days after it was disconnected.
- `iamceo uninstall`, or 이 Mac에서 완전히 멈추기 (Stop completely on this Mac) in the App, keeps your data by default; deleting it as well asks for a second confirmation. Deleting the data also deletes the backups, diagnostic files and upgrade records inside `~/.iamceo`, but never a backup made elsewhere with `iamceo backup --directory`. Homebrew's `brew uninstall --zap` deletes the data folder as well.
- The access code stored on your iPhone is removed when you choose 나가기 (Sign out) in the App's settings. Drafts and the receipt-check record are not removed by 나가기; they are removed when you delete the App.
- The notification relay keeps no push tokens or identifiers, so there is nothing to delete there. After you turn off iPhone notifications or remove the device on your Mac, nothing more is sent to the relay. The counts the relay keeps in memory against abuse are gone within a day. If you delete the installation file on your Mac (`~/.iamceo/push-relay.json`), the next notification registers a new installation.
- The last seen state is deleted when you switch to another server, choose 나가기 (Sign out), or the access code is refused. A message waiting for the connection is gone once it is sent or you delete it, and choosing 나가기 (Sign out) or connecting to another server also deletes the messages that were waiting for the previous server (reconnecting to the same Mac through another address keeps and sends them). Deleting the App removes both.

**5. Children**
The App is not directed to children and does not knowingly collect children's information.

**6. Contact**
https://github.com/yehsung/IAMCEO/issues
