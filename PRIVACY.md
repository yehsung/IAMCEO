# 개인정보 처리방침 · Privacy Policy

시행일: 2026-11-10 · 고친 날: 2026-11-13 · Effective: 2026-11-10 · Revised: 2026-11-13

[한국어](#한국어) · [English](#english)

## 한국어

IAMCEO(이하 "앱")는 사용자가 자신의 Mac에서 실행하는 IAMCEO 서버에 연결해 쓰는 앱입니다. 개발자는 별도의 서버를 운영하지 않으며, 사용자의 데이터를 수집하거나 받지 않습니다.

**1. 개발자가 수집하는 정보**
없습니다. 앱에는 광고, 분석, 추적, 충돌 보고 도구가 들어 있지 않습니다.

**2. 앱이 다루는 정보와 저장 위치**
- 대화, 결재, 할 일, 자료, 첨부 파일은 사용자가 연결한 사용자 자신의 Mac(IAMCEO 서버)에 저장됩니다.
- iPhone에는 접속 코드가 키체인에, 연결 주소가 앱 안에 저장됩니다. 쓰던 글(초안)과, 보낸 뒤 접수를 아직 확인하지 못한 메시지·요청의 기록도 앱 안에 저장됩니다. 그 밖에는 화면 표시를 위한 임시 데이터만 남습니다.
- 사진·파일 첨부는 사용자가 고른 항목만 사용자의 Mac으로 보내집니다. 사진 보관함에서 고르거나 카메라로 찍은 사진은 위치 정보(GPS)를 지우고 보냅니다. 영상과, 파일로 붙인 항목은 원본 그대로 보내므로 그 안에 든 위치 정보 같은 부가 정보도 함께 갑니다.
- 알림을 켜면 iPhone의 푸시 토큰이 사용자의 Mac에 저장되고, 알림은 Apple 푸시 알림 서비스(APNs)를 통해 전달됩니다. 알림에는 정해진 문구와 식별자만 실리고 대화 내용은 실리지 않습니다. 알림은 사용자의 Mac에 그 앱의 Apple 알림 키가 설정돼 있을 때만 보내집니다. App Store에서 받은 앱은 지금 이 조건을 갖출 수 없어 iPhone 알림을 받지 못합니다.
- 사용자의 Mac에 있는 서버는 같은 Mac의 `~/.iamceo/backups`에 정기 백업을 만듭니다. 백업에는 대화·첨부와 함께 접속 코드가 들어 있습니다. 백업을 다른 곳으로 옮기면 접속 코드도 함께 옮겨집니다.
- 서버는 같은 Mac에 설치된 Claude Code·Codex의 버전과 처음 본 시각을 `~/.iamceo/cli-versions.json`에 남깁니다.
- 앱은 서버에 요청할 때 자신의 버전과 기기 종류(Mac·iPhone)를 함께 보냅니다. 받는 곳은 사용자 자신의 Mac 서버이고, 서버는 앱과 맞지 않을 때 안내하는 데에만 씁니다.
- 사용자가 진단 파일을 만들면(앱의 '진단 파일 만들기' 또는 `iamceo diagnose`) 같은 Mac의 `~/.iamceo/diagnostics`에 저장됩니다. 버전, 서비스 상태, 서버 로그의 끝부분, 백업 상태, 데이터의 상태 요약(ID·상태·시각·개수)이 들어가고, 대화·보고·결재·할 일·자료의 본문, 첨부 파일, 접속 코드, 알림 토큰, 환경 변수의 값은 넣지 않습니다. 로그에는 파일 경로나 프로젝트 이름이 남을 수 있습니다. 진단 파일은 어디로도 저절로 보내지 않으며, 보낼지는 사용자가 정합니다.

**3. 제3자 서비스**
사용자의 Mac에서 돌아가는 AI 도구(예: Claude Code, Codex CLI)는 사용자 자신의 계정으로 각 서비스 제공자와 통신합니다. 이 통신은 해당 제공자의 개인정보 처리방침을 따르며, 개발자는 그 내용에 접근하지 않습니다.
서버가 AI 서비스에 장애가 났다고 판단한 동안에는, 복구됐는지 알아보려고 사용자의 Mac에서 AI 회사의 주소(`api.anthropic.com`, Codex를 쓰면 `api.openai.com`)로 내용이 없는 확인 요청을 보냅니다. 이 요청에 대화 내용이나 계정 정보는 싣지 않습니다.
Mac 앱은 새 버전이 나왔는지 알려 주려고, 실행 중일 때 하루에 한 번 GitHub(`api.github.com`)에 IAMCEO의 최신 릴리스를 묻습니다. 이 요청에는 요청 자체의 정보(IP 주소, 'IAMCEO-Mac'이라는 앱 표시)만 담기고 계정·프로젝트·대화·서버 주소·접속 코드는 담지 않습니다. 이 요청은 GitHub의 개인정보 처리방침을 따릅니다. 새 버전을 받거나 설치하지는 않습니다. iPhone 앱은 이 확인을 하지 않습니다.
사용자가 설치 스크립트나 `iamceo upgrade`로 새 버전을 받을 때도 GitHub의 릴리스 주소에서 받습니다.

**4. 보관과 삭제**
모든 데이터는 사용자의 Mac에 있으므로 사용자가 직접 지울 수 있습니다.
- 대화, 결재, 할 일, 자료는 사용자가 지우기 전까지 보관합니다. 보관함에 넣은 프로젝트는 앱에서 프로젝트 단위로 내보내거나 지울 수 있습니다. 지운 프로젝트는 이미 만든 백업에 남아 있다가, 오래된 백업이 차례로 지워지면서(길게는 약 4주) 사라집니다. 내보낸 파일에는 대화 내용이 그대로 들어 있습니다.
- 서버가 안에서만 쓰는 기록은 정해진 기한이 지나면 스스로 정리합니다. AI 세션에 넣은 글의 사본은 그 전달이 끝나고 30일 뒤에 비웁니다. 실행 기록과 처리 영수증은 끝나고 90일 뒤에 지웁니다. 아직 끝나지 않은 일의 기록은 지우지 않습니다.
- 정기 백업은 일별 7개와 주별 4개를 남기고 오래된 것부터 지웁니다. 진단 파일은 가장 최근 다섯 개만 남깁니다.
- 'iamceo uninstall' 또는 앱의 '이 Mac에서 완전히 멈추기'는 기본으로 데이터를 남기며, 데이터까지 지우려면 한 번 더 확인합니다.
- iPhone에 저장된 접속 코드는 앱의 설정에서 '나가기'를 누르면 지워집니다. 초안과 접수 확인 기록은 '나가기'로는 지워지지 않으며, 앱을 지우면 함께 지워집니다.

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
- On iPhone, the access code is stored in the Keychain and the server address inside the App. Text you are still writing (drafts) and a record of messages and requests whose receipt has not been confirmed yet are also stored inside the App. Otherwise only temporary display data is kept.
- Photos and files you choose to attach are sent only to your Mac. Location (GPS) data is removed from photos you pick from the photo library or take with the camera. Videos, and anything you attach as a file, are sent as they are, so extra information inside them, such as location, goes with them.
- If you turn on notifications, your iPhone's push token is stored on your Mac, and notifications are delivered through Apple Push Notification service (APNs). A notification carries only a fixed sentence and identifiers, never the content of a conversation. Notifications are sent only when your Mac holds the Apple push key that belongs to the App. The App from the App Store cannot meet that condition today, so it does not receive iPhone notifications.
- The server on your Mac makes regular backups in `~/.iamceo/backups` on the same Mac. A backup contains your access code along with conversations and attachments. If you move a backup somewhere else, the access code moves with it.
- The server records the versions of Claude Code and Codex installed on the same Mac, with the time it first saw each, in `~/.iamceo/cli-versions.json`.
- With each request, the App tells the server its own version and device type (Mac or iPhone). The recipient is your own Mac server, which uses it only to tell you when the App and the server do not match.
- When you make a diagnostic file (진단 파일 만들기 in the App, or `iamceo diagnose`), it is saved in `~/.iamceo/diagnostics` on the same Mac. It contains versions, the service state, the end of the server logs, the backup state and a status summary of your data (IDs, states, times, counts). It does not contain the text of conversations, reports, decisions, to-dos or files, attachments, the access code, push tokens or environment variable values. Logs can still contain file paths and project names. A diagnostic file is never sent anywhere on its own; you decide whether to share it.

**3. Third-party services**
AI tools running on your Mac (for example Claude Code or Codex CLI) talk to their providers with your own accounts, under those providers' privacy policies. The developer has no access to that traffic.
While the server believes an AI service is down, your Mac sends an empty check request to the provider's address (`api.anthropic.com`, and `api.openai.com` if you use Codex) to see whether it is back. That request carries no conversation content and no account information.
To tell you when a new version is out, the Mac App asks GitHub (`api.github.com`) for IAMCEO's latest release once a day while it is running. That request carries only what any request does (your IP address, and "IAMCEO-Mac" as the app's name), never your accounts, projects, conversations, server address or access code, and it falls under GitHub's privacy policy. Nothing is downloaded or installed by it. The iPhone App does not make this check.
When you get a new version with the install script or `iamceo upgrade`, it is also downloaded from GitHub's release addresses.

**4. Retention and deletion**
All data lives on your Mac, so you can delete it yourself.
- Conversations, decisions, to-dos and files are kept until you delete them. An archived project can be exported or deleted, one project at a time, in the App. A deleted project stays in backups already made until they are rotated out (up to about four weeks). An exported file contains the conversations as they are.
- Records the server keeps only for itself are cleaned up after a fixed time. The copy of the text typed into an AI session is cleared 30 days after that delivery finished. Run records and receipts are deleted 90 days after they finished. Records of work that has not finished are never deleted.
- Daily backups keep 7 daily and 4 weekly copies and delete older ones first. Only the five most recent diagnostic files are kept.
- `iamceo uninstall`, or 이 Mac에서 완전히 멈추기 (Stop completely on this Mac) in the App, keeps your data by default; deleting it as well asks for a second confirmation.
- The access code stored on your iPhone is removed when you choose 나가기 (Leave) in the App's settings. Drafts and the receipt-check record are not removed by 나가기; they are removed when you delete the App.

**5. Children**
The App is not directed to children and does not knowingly collect children's information.

**6. Contact**
https://github.com/yehsung/IAMCEO/issues
