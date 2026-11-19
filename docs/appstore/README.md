# App Store 등록 정보 · App Store listing

iPhone 앱(번들 `com.yehsung.iamceo`)의 App Store 등록 정보를 언어마다 한 파일로 둡니다. 올리는 일은 릴리스 담당이 App Store Connect(웹 또는 API)에서 합니다. 이 폴더는 글의 원본입니다.
The iPhone app's App Store listing, one file per language. The release owner uploads it in App Store Connect (web or API); this folder holds the source text.

| 파일 · File | App Store Connect 지역 · Locale |
|---|---|
| [ko.md](ko.md) | 한국어 `ko` (기본 지역 · primary locale) |
| [en.md](en.md) | English (U.S.) `en-US` |

## 칸과 자리 · Fields

각 파일의 `## <칸>` 아래 ```` ```text ```` 상자의 글을 그대로 옮깁니다. Copy the text block under each `## <field>` heading as is.

| 칸 · Field | App Store Connect | API | 한도 · Limit |
|---|---|---|---|
| `name` | 앱 정보 → 이름 · App Information → Name | `appInfoLocalizations.name` | 2–30자 · chars |
| `subtitle` | 앱 정보 → 부제 · Subtitle | `appInfoLocalizations.subtitle` | 30 |
| `promotionalText` | 버전 → 프로모션 텍스트 · Promotional Text | `appStoreVersionLocalizations.promotionalText` | 170 |
| `description` | 버전 → 설명 · Description | `appStoreVersionLocalizations.description` | 4,000 |
| `keywords` | 버전 → 키워드 · Keywords | `appStoreVersionLocalizations.keywords` | 100 |
| `whatsNew` | 버전 → 이 버전의 새로운 기능 · What's New | `appStoreVersionLocalizations.whatsNew` | 4,000 |

- 지원 URL·개인정보 처리방침 URL은 한국어 지역에 등록된 주소를 영어 지역에도 그대로 씁니다(처리방침 [PRIVACY.md](../../PRIVACY.md)는 한·영이 한 문서에 있습니다). Use the same Support URL and Privacy Policy URL as the Korean locale; PRIVACY.md has both languages in one document.
- `tests/appstore-listing.test.ts`가 두 파일의 칸이 모두 있는지, 한도를 넘지 않는지, 영어 파일에 한글이 없는지, 키워드에 상표·앱 이름이 없는지, 새로운 기능에서 iPhone 알림을 말하는 줄이 Mac 서버 판 조건(예: 0.2.6 이상)을 밝히는지, 설명이 알림 중계를 밝히는지를 확인합니다. The test checks that every field is present and within its limit, that the English file has no Korean, that keywords carry no trademarks, and that any mention of iPhone notifications states the Mac server version it needs (for example 0.2.6 or later), and that the description mentions the notification relay.
- 새 버전마다 `whatsNew`를 고칩니다. 0.2.8의 글은 폰에서 AI 계정 바꾸기·다시 로그인과 한도 카드의 다른 계정 로그인이고, 서버가 필요한 줄마다 Mac 서버 0.2.8 이상이라고 적습니다. Update `whatsNew` for every version.

## 영어 스크린샷 · English screenshots

한국어 스크린샷 다섯 장과 같은 화면을 영어 샘플로 찍습니다. 샘플은 앱 화면 언어를 따르므로 앱을 영어로 열면 영어 회사(Checkout Revamp)가 나옵니다. Take the same five screens as the Korean set with the English sample; the sample follows the app's language.

- 시뮬레이터: `xcrun simctl launch <기기> com.yehsung.iamceo -AppleLanguages "(en)" --demo --screen <화면> [--open <id>]` (DEBUG 빌드의 화면 견본 인자. 실행 인자의 언어는 저장된 언어 선택을 바꾸지 않습니다.)
- 화면과 id(두 언어가 같은 id): 홈 `--screen home`, 결재함 `--screen inbox --open d-pg`(Which payment provider should we use?), 대화 `--screen chat --open m-copy`, 자료 `--screen files --open f-copy`(Success and failure screen mockups), 팀 `--screen team --open m-card`.

## 심사 메모(영어) · App Review notes

```text
IAMCEO is a remote client for a developer tool: the user's own self-hosted IAMCEO server, which runs on the user's Mac (free, source-available: https://github.com/yehsung/IAMCEO). The server runs AI coding command-line tools (Claude Code / Codex CLI) that the user installed and signed in to on their Mac; the iPhone app lets the user give instructions, answer approval requests, and follow progress. There are no accounts, and all conversations, decisions and files stay on the user's Mac.

HOW TO REVIEW WITHOUT A MAC SERVER
On the first screen, below the "or" divider, tap "Explore the sample". The sample is a complete example company running inside the app (no account, no network requests), and you can visit every tab: Home, Inbox, Team, Chat, Files. You can send instructions in Chat (the lead replies), answer decisions in the Inbox, check off to-dos on Home, and open documents, tables, images and the HTML mockup in Files. Changes stay on the device. After you send an instruction in Chat, a "Checkout Lead is replying…" line with animated dots shows until the reply arrives. To leave the sample, tap "Connect to a Mac" in the bar at the top. The sample deliberately shows states this app exists to surface, such as a staff member waiting for the user's decision; these are example data, not app errors. The names, fees, dates and figures in the sample are fictional. The sample appears in English or Korean, following the app's language (Settings > General > Language, or the Language menu at the bottom of the first screen).

NOTIFICATIONS
Notifications are sent by the user's Mac server (version 0.2.5 or later), so they cannot be tried from the sample. If the user's Mac has its own Apple push key it sends to Apple directly. Otherwise it sends the request to a small relay run by the developer on Google Cloud Functions, which forwards it to the Apple Push Notification service. The relay receives only the device token, the kind of notification, an item ID and the language of the text (Korean or English), never message content; it uses fixed notification text for each kind and stores nothing it receives. The iPhone app itself never contacts the relay.

AI COMMAND-LINE TOOL SIGN-IN (new in 0.2.8)
With a Mac server 0.2.8 or later, Settings > AI models > AI accounts shows which account the Claude Code / Codex tools on the user's Mac use and lets the user sign them in to another of the user's own accounts. The app only opens the provider's own sign-in page (claude.com or auth.openai.com) in Safari and, for Claude Code, sends back the one-time code that page shows; the tool on the Mac completes the sign-in and keeps its own credentials. The app never sees passwords or tokens, and IAMCEO itself still has no accounts. Not available in the sample.

CONNECTING TO A REAL SERVER (optional for review)
Requirements: an Apple silicon Mac on macOS 14+ with IAMCEO installed (brew install --cask yehsung/tap/iamceo), Claude Code installed and signed in on that Mac, and Tailscale (a free private-network/VPN app) signed in to the same account on both the Mac and the iPhone, as with other self-hosted remote tools. Then open IAMCEO on the Mac, go to Settings > Connect iPhone, and scan the QR code with this app. On a device without Tailscale, the first screen shows "Turn on Tailscale" and the QR button stays off. This is expected and only concerns real pairing; the sample works without it. No login or account is required; pairing uses a one-time code.

THIRD-PARTY AI (Guideline 5.1.2(i))
This app does not send user data to any third-party AI service and contains no AI model. It connects only to the user's own Mac. The AI command-line tools on that Mac are installed, signed in to, and paid for by the user, under their providers' terms, outside this app.

The interface is in English and Korean. No accounts, in-app purchases, ads, or tracking. The camera is used only to scan the pairing QR code and to take photos the user chooses to attach.
```
