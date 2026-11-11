# 개인정보 처리방침 · Privacy Policy

시행일: 2026-11-10 · 고친 날: 2026-11-11 · Effective: 2026-11-10 · Revised: 2026-11-11

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

**3. 제3자 서비스**
사용자의 Mac에서 돌아가는 AI 도구(예: Claude Code, Codex CLI)는 사용자 자신의 계정으로 각 서비스 제공자와 통신합니다. 이 통신은 해당 제공자의 개인정보 처리방침을 따르며, 개발자는 그 내용에 접근하지 않습니다.
서버가 AI 서비스에 장애가 났다고 판단한 동안에는, 복구됐는지 알아보려고 사용자의 Mac에서 AI 회사의 주소(`api.anthropic.com`, Codex를 쓰면 `api.openai.com`)로 내용이 없는 확인 요청을 보냅니다. 이 요청에 대화 내용이나 계정 정보는 싣지 않습니다.

**4. 보관과 삭제**
모든 데이터는 사용자의 Mac에 있으므로 사용자가 직접 지울 수 있습니다. iPhone에 저장된 접속 코드는 앱의 설정에서 '나가기'를 누르면 지워집니다. 초안과 접수 확인 기록은 '나가기'로는 지워지지 않으며, 앱을 지우면 함께 지워집니다.

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

**3. Third-party services**
AI tools running on your Mac (for example Claude Code or Codex CLI) talk to their providers with your own accounts, under those providers' privacy policies. The developer has no access to that traffic.
While the server believes an AI service is down, your Mac sends an empty check request to the provider's address (`api.anthropic.com`, and `api.openai.com` if you use Codex) to see whether it is back. That request carries no conversation content and no account information.

**4. Retention and deletion**
All data lives on your Mac, so you can delete it yourself. The access code stored on your iPhone is removed when you choose 나가기 (Leave) in the App's settings. Drafts and the receipt-check record are not removed by 나가기; they are removed when you delete the App.

**5. Children**
The App is not directed to children and does not knowingly collect children's information.

**6. Contact**
https://github.com/yehsung/IAMCEO/issues
