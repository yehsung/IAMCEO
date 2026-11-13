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
- `tests/appstore-listing.test.ts`가 두 파일의 칸이 모두 있는지, 한도를 넘지 않는지, 영어 파일에 한글이 없는지, 키워드에 상표·앱 이름이 없는지, iPhone 알림을 약속하지 않는지(App Store 판은 알림을 받지 못합니다)를 확인합니다. The test checks that every field is present and within its limit, that the English file has no Korean, that keywords carry no trademarks, and that neither file promises iPhone notifications (the App Store build can't receive them).
- 새 버전마다 `whatsNew`를 고칩니다. 0.2.5의 글은 V(대기열)·X(기기 끊기)·W(언어) 세 묶음을 합친 것으로, 마무리에서 실제 동작(새 설치와 업데이트의 첫 언어, 연결 전 언어 메뉴, 연결된 기기 목록)에 맞췄습니다. Update `whatsNew` for every version.

## 영어 스크린샷 · English screenshots

한국어 스크린샷 다섯 장과 같은 화면을 영어 샘플로 찍습니다. 샘플은 앱 화면 언어를 따르므로 앱을 영어로 열면 영어 회사(Checkout Revamp)가 나옵니다. Take the same five screens as the Korean set with the English sample; the sample follows the app's language.

- 시뮬레이터: `xcrun simctl launch <기기> com.yehsung.iamceo -AppleLanguages "(en)" --demo --screen <화면> [--open <id>]` (DEBUG 빌드의 화면 견본 인자. 실행 인자의 언어는 저장된 언어 선택을 바꾸지 않습니다.)
- 화면과 id(두 언어가 같은 id): 홈 `--screen home`, 결재함 `--screen inbox --open d-pg`(Which payment provider should we use?), 대화 `--screen chat --open m-copy`, 자료 `--screen files --open f-copy`(Success and failure screen mockups), 팀 `--screen team --open m-card`.

## 심사 메모(영어) · App Review notes

```text
IAMCEO is a remote for an IAMCEO server that the user runs on their own Mac, so a reviewer without that Mac can use the built-in sample: tap "Explore the sample" on the first screen. The sample is a complete example company running inside the app (no account, no network requests). You can send instructions in Chat (the lead replies), answer decisions in the Inbox, check off to-dos on Home, and open documents, tables, images and the HTML mockup in Files. The sample appears in English or Korean, following the app's language (Settings → General → Language).
```
