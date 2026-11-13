# 개인정보 처리방침 · Privacy Policy

시행일: 2026-11-10 · 고친 날: 2026-11-13 · Effective: 2026-11-10 · Revised: 2026-11-13

[한국어](#한국어) · [English](#english)

## 한국어

IAMCEO(이하 "앱")는 사용자가 자신의 Mac에서 실행하는 IAMCEO 서버에 연결해 쓰는 앱입니다. 개발자는 별도의 서버를 운영하지 않으며, 사용자의 데이터를 수집하거나 받지 않습니다.

**1. 개발자가 수집하는 정보**
없습니다. 앱에는 광고, 분석, 추적, 충돌 보고 도구가 들어 있지 않습니다.

**2. 앱이 다루는 정보와 저장 위치**
- 대화, 결재, 할 일, 자료, 첨부 파일은 사용자가 연결한 사용자 자신의 Mac(IAMCEO 서버)에 저장됩니다.
- iPhone에는 접속 코드가 키체인에, 연결 주소가 앱 안에 저장됩니다. 쓰던 글(초안)과, 보낸 뒤 접수를 아직 확인하지 못한 메시지·요청의 기록도 앱 안에 저장됩니다. 그 밖에는 아래의 마지막으로 본 상태와 화면 표시를 위한 임시 데이터만 남습니다.
- 앱(iPhone·Mac)은 서버에 닿지 않을 때도 보여 주려고, 서버가 마지막으로 확인해 준 상태 하나(프로젝트 목록과 보던 프로젝트의 팀원·결재·할 일·자료·최근 대화)를 앱 안의 파일로 남깁니다. 연결되지 않은 동안 '연결되면 보낼 글'로 둔 글도 앱 안의 파일에 남습니다. 두 파일은 기기 밖으로 나가지 않고 기기 백업에서도 빠지며, iPhone에서는 기기가 잠겨 있는 동안 읽을 수 없는 완전 보호 파일입니다(Mac에서는 그 사용자만 읽는 파일). 마지막 상태는 한 서버 것만 두고 2MB를 넘지 않게 오래된 글부터 덜어 냅니다. 같은 Mac의 서버에 붙은 Mac 앱은 마지막 상태를 남기지 않습니다.
- iPhone 첫 화면의 '샘플로 둘러보기'(Mac에서는 `--demo`로 연 앱)는 앱 안에 든 예시 데이터로만 돌아갑니다. 샘플에서 보내거나 바꾼 내용은 앱의 메모리에만 있다가 샘플을 나가거나 앱을 끄면 사라집니다. 샘플은 어떤 서버나 인터넷에도 요청을 보내지 않고, 기기에 아무것도 저장하지 않습니다.
- 사진·파일 첨부는 사용자가 고른 항목만 사용자의 Mac으로 보내집니다. 사진 보관함에서 고르거나 카메라로 찍은 사진은 위치 정보(GPS)를 지우고 보냅니다. 영상과, 파일로 붙인 항목은 원본 그대로 보내므로 그 안에 든 위치 정보 같은 부가 정보도 함께 갑니다.
- 알림을 켜면 iPhone의 푸시 토큰이 사용자의 Mac에 저장되고, 알림은 Apple 푸시 알림 서비스(APNs)를 통해 전달됩니다. 알림에는 정해진 문구와 식별자만 실리고 대화 내용은 실리지 않습니다. 알림은 사용자의 Mac에 그 앱의 Apple 알림 키가 설정돼 있을 때만 보내집니다. App Store에서 받은 앱은 지금 이 조건을 갖출 수 없어 iPhone 알림을 받지 못합니다.
- 사용자의 Mac에 있는 서버는 같은 Mac의 `~/.iamceo/backups`에 정기 백업을 만듭니다. 백업에는 대화·첨부와 함께 접속 코드가 들어 있습니다(QR로 연결한 기기의 열쇠는 해시만 들어갑니다). 백업을 다른 곳으로 옮기면 접속 코드도 함께 옮겨집니다.
- 서버는 같은 Mac에 접속 기록을 남깁니다. QR로 연결한 기기의 이름(앱이 보낸 기기 이름)과 마지막 접속 시각·주소, 틀린 코드나 끊은 기기로 들어오려 한 시도의 주소·시각, 기기를 끊은 일과 접속 코드를 바꾼 일입니다. 코드·열쇠 값은 남기지 않습니다. 이 기록은 설정의 '연결된 기기'에 보이고, 어디로도 보내지 않습니다.
- 서버는 같은 Mac에 설치된 Claude Code·Codex의 버전과 처음 본 시각을 `~/.iamceo/cli-versions.json`에 남깁니다.
- IAMCEO가 띄운 Claude Code 세션은 세션 시작·입력 접수·턴 끝·오류 종류·압축을 같은 Mac의 `~/.iamceo/run/events`에 한 줄씩 남깁니다. 시각, 세션 ID, IAMCEO 전달 표지, 오류 분류값, 입력 글자 수만 적고 글 본문은 적지 않습니다. 서버가 이 기록과 자기 판단이 맞는지 센 숫자는 같은 폴더와 진단 파일에 들어갑니다. 어디로도 보내지 않습니다.
- IAMCEO가 띄운 Claude Code 세션의 상태줄 기록(같은 Mac의 `~/.iamceo/context`)에는 문맥 사용량과 함께 CLI가 보고한 그 세션의 비용·토큰 수·계정 한도 사용률이 들어갑니다. 서버는 이 값과 Codex 세션 기록의 토큰 수·한도 사용률을 읽어, 팀원·프로젝트·날짜별 합계를 같은 Mac의 DB에 남기고 설정의 '사용량'에 보여 줍니다. 이 합계에는 숫자와 팀원 이름만 들어가고 대화 내용은 들어가지 않습니다. 어디로도 보내지 않습니다.
- `iamceo upgrade`로 새 버전으로 올리면, 되돌릴 때 쓰려고 올리기 전의 DB 사본(대화 포함)을 같은 Mac의 `~/.iamceo/upgrades`에 남깁니다. 가장 최근 두 번의 업그레이드 것만 남깁니다. `iamceo rollback`으로 DB까지 되돌리면 그때의 DB(업그레이드 뒤에 쌓인 대화 포함)를 같은 폴더 안에 옆 사본으로 남기며, 이 사본은 오래된 업그레이드 기록을 정리할 때도 지우지 않습니다(데이터 폴더를 지우면 함께 지워집니다).
- 앱은 서버에 요청할 때 자신의 버전과 기기 종류(Mac·iPhone)를 함께 보냅니다. 받는 곳은 사용자 자신의 Mac 서버이고, 서버는 이를 서버 로그와 진단 파일에 기록하고 앱과 맞지 않을 때 안내하는 데 씁니다.
- 사용자가 진단 파일을 만들면(앱의 '진단 파일 만들기' 또는 `iamceo diagnose`) 같은 Mac의 `~/.iamceo/diagnostics`에 저장됩니다. 버전(접속한 앱의 버전 포함), 서비스 상태, 서버 로그의 끝부분, 백업 상태, 데이터의 상태 요약(ID·상태·시각·개수), 설정 값, 접속 주소(Tailscale 주소 포함)와 포트, 데이터 폴더와 실행 파일의 경로(사용자 이름 포함), 충돌 보고 파일의 이름이 들어가고, 대화·보고·결재·할 일·자료의 본문, 첨부 파일, 접속 코드, 알림 토큰, 환경 변수의 값은 넣지 않습니다. 로그에는 파일 경로나 프로젝트 이름이 남을 수 있습니다. 진단 파일은 어디로도 저절로 보내지 않으며, 보낼지는 사용자가 정합니다.

**3. 제3자 서비스**
사용자의 Mac에서 돌아가는 AI 도구(예: Claude Code, Codex CLI)는 사용자 자신의 계정으로 각 서비스 제공자와 통신합니다. 이 통신은 해당 제공자의 개인정보 처리방침을 따르며, 개발자는 그 내용에 접근하지 않습니다.
서버가 AI 서비스에 장애가 났다고 판단한 동안에는, 복구됐는지 알아보려고 사용자의 Mac에서 AI 회사의 주소(`api.anthropic.com`, Codex를 쓰면 `api.openai.com`)로 내용이 없는 확인 요청을 보냅니다. 이 요청에 대화 내용이나 계정 정보는 싣지 않습니다.
Mac 앱은 새 버전이 나왔는지 알려 주려고, 실행 중일 때 하루에 한 번 GitHub(`api.github.com`)에 IAMCEO의 최신 릴리스를 묻습니다. 이 요청에는 요청 자체의 정보(IP 주소, 'IAMCEO-Mac'이라는 앱 표시)만 담기고 계정·프로젝트·대화·서버 주소·접속 코드는 담지 않습니다. 이 요청은 GitHub의 개인정보 처리방침을 따릅니다. 새 버전을 받거나 설치하지는 않습니다. iPhone 앱은 이 확인을 하지 않습니다.
사용자가 설치 스크립트나 `iamceo upgrade`로 새 버전을 받을 때도 GitHub의 릴리스 주소에서 받습니다.

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
- 마지막으로 본 상태는 다른 서버로 바꾸거나, '나가기'를 누르거나, 접속 코드가 거절되면 지워집니다. 연결되면 보낼 글은 보내지거나 사용자가 지우면 없어지고, '나가기'를 누르거나 다른 서버에 연결하면 그전 서버에 보내려던 글도 함께 지워집니다. 앱을 지우면 둘 다 지워집니다.

**5. 어린이**
앱은 어린이를 대상으로 하지 않으며, 어린이의 정보를 알면서 수집하지 않습니다.

**6. 문의**
https://github.com/yehsung/IAMCEO/issues

## English

IAMCEO (the "App") connects to an IAMCEO server that you run on your own Mac. The developer runs no servers for the App and does not collect or receive your data.

**1. Data the developer collects**
None. The App contains no advertising, analytics, tracking, or crash-reporting tools.

**2. Data the App handles and where it is stored**
- Conversations, decisions, to-dos, files, and attachments are stored on your own Mac (your IAMCEO server).
- On iPhone, the access code is stored in the Keychain and the server address inside the App. Text you are still writing (drafts) and a record of messages and requests whose receipt has not been confirmed yet are also stored inside the App. Otherwise only the last seen state below and temporary display data are kept.
- So that it can still show something when the server is out of reach, the App (iPhone and Mac) keeps one copy of the last state the server confirmed (the project list, and the members, decisions, to-dos, files and recent conversation of the project you were on) in a file inside the App. Messages you leave as "send when connected" while disconnected are also kept in a file inside the App. Neither file leaves the device or goes into device backups, and on iPhone both are complete-protection files that cannot be read while the device is locked (on Mac, files only your user can read). The last state is kept for one server only and trimmed, oldest messages first, to stay under 2 MB. The Mac App connected to the server on the same Mac does not keep a last state.
- 샘플로 둘러보기 (Look around with a sample) on the iPhone's first screen (and the Mac App opened with `--demo`) runs only on example data built into the App. Whatever you send or change in the sample stays in the App's memory and is gone when you leave the sample or quit the App. The sample sends no request to any server or the internet and saves nothing on the device.
- Photos and files you choose to attach are sent only to your Mac. Location (GPS) data is removed from photos you pick from the photo library or take with the camera. Videos, and anything you attach as a file, are sent as they are, so extra information inside them, such as location, goes with them.
- If you turn on notifications, your iPhone's push token is stored on your Mac, and notifications are delivered through Apple Push Notification service (APNs). A notification carries only a fixed sentence and identifiers, never the content of a conversation. Notifications are sent only when your Mac holds the Apple push key that belongs to the App. The App from the App Store cannot meet that condition today, so it does not receive iPhone notifications.
- The server on your Mac makes regular backups in `~/.iamceo/backups` on the same Mac. A backup contains your access code along with conversations and attachments (keys of devices connected with a QR code are stored only as hashes). If you move a backup somewhere else, the access code moves with it.
- The server keeps an access record on the same Mac: the names of devices connected with a QR code (the device name the App sends) with when and from which address they last connected, the address and time of attempts with a wrong code or a disconnected device's key, and when a device was disconnected or the access code was changed. No code or key is recorded. The record is shown under 연결된 기기 (Connected devices) in Settings and is never sent anywhere.
- The server records the versions of Claude Code and Codex installed on the same Mac, with the time it first saw each, in `~/.iamceo/cli-versions.json`.
- Claude Code sessions started by IAMCEO write session start, prompt received, turn end, error type and compaction to `~/.iamceo/run/events` on the same Mac, one line each. Only the time, the session ID, IAMCEO delivery markers, the error category and the prompt's length in characters are written, never the text. The counts of how often these records agree with the server's own reading are kept in the same folder and in diagnostic files. Nothing is sent anywhere.
- The status line record of a Claude Code session started by IAMCEO (in `~/.iamceo/context` on the same Mac) holds, along with context usage, the cost, token counts and account limit usage the CLI reported for that session. The server reads these, and the token counts and limit usage in Codex session records, and keeps totals per member, project and day in the database on the same Mac, shown under 사용량 (Usage) in Settings. The totals contain only numbers and member names, never conversation content. Nothing is sent anywhere.
- When you move to a new version with `iamceo upgrade`, a copy of the database from before the upgrade (conversations included) is kept in `~/.iamceo/upgrades` on the same Mac, for rolling back. Only the two most recent upgrades are kept. When `iamceo rollback` also rolls the database back, the database as it was then (including conversations made after the upgrade) is kept aside in the same folder; that copy is not removed when old upgrade records are cleaned up (deleting the data folder deletes it).
- With each request, the App tells the server its own version and device type (Mac or iPhone). The recipient is your own Mac server, which records it in the server log and in diagnostic files and uses it to tell you when the App and the server do not match.
- When you make a diagnostic file (진단 파일 만들기 in the App, or `iamceo diagnose`), it is saved in `~/.iamceo/diagnostics` on the same Mac. It contains versions (including the versions of apps that connected), the service state, the end of the server logs, the backup state, a status summary of your data (IDs, states, times, counts), setting values, the connection addresses (including the Tailscale address) and port, the paths of the data folder and the executables (which include your user name), and the names of crash reports. It does not contain the text of conversations, reports, decisions, to-dos or files, attachments, the access code, push tokens or environment variable values. Logs can still contain file paths and project names. A diagnostic file is never sent anywhere on its own; you decide whether to share it.

**3. Third-party services**
AI tools running on your Mac (for example Claude Code or Codex CLI) talk to their providers with your own accounts, under those providers' privacy policies. The developer has no access to that traffic.
While the server believes an AI service is down, your Mac sends an empty check request to the provider's address (`api.anthropic.com`, and `api.openai.com` if you use Codex) to see whether it is back. That request carries no conversation content and no account information.
To tell you when a new version is out, the Mac App asks GitHub (`api.github.com`) for IAMCEO's latest release once a day while it is running. That request carries only what any request does (your IP address, and "IAMCEO-Mac" as the app's name), never your accounts, projects, conversations, server address or access code, and it falls under GitHub's privacy policy. Nothing is downloaded or installed by it. The iPhone App does not make this check.
When you get a new version with the install script or `iamceo upgrade`, it is also downloaded from GitHub's release addresses.

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
- The last seen state is deleted when you switch to another server, choose 나가기 (Sign out), or the access code is refused. A message waiting for the connection is gone once it is sent or you delete it, and choosing 나가기 (Sign out) or connecting to another server also deletes the messages that were waiting for the previous server. Deleting the App removes both.

**5. Children**
The App is not directed to children and does not knowingly collect children's information.

**6. Contact**
https://github.com/yehsung/IAMCEO/issues
