import Foundation
import XCTest
@testable import IAMCEO

/// 0.2.6 Y: 서버가 만든 글(시스템 글·결재 카드·활동 줄)을 화면 언어로 다시 그린다.
/// 시험 앱에는 문구 표가 없어 String(localized:) 가 늘 한국어다. 그래서 영어 틀은 소스의 Localizable.xcstrings 에서 읽어 넣는다.
final class ServerTextTests: XCTestCase {
    private static let nativeRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    /// server.text.<코드> → 언어별 틀(문구 표 원본).
    private static let templates: [String: [String: String]] = {
        struct Unit: Decodable { let value: String }
        struct Localization: Decodable { let stringUnit: Unit? }
        struct Entry: Decodable { let localizations: [String: Localization]? }
        struct Catalog: Decodable { let strings: [String: Entry] }
        let url = nativeRoot.appendingPathComponent("Resources/Shared/Localizable.xcstrings")
        guard let data = try? Data(contentsOf: url), let catalog = try? JSONDecoder().decode(Catalog.self, from: data) else { return [:] }
        var out: [String: [String: String]] = [:]
        for (key, entry) in catalog.strings where key.hasPrefix("server.text.") {
            out[String(key.dropFirst("server.text.".count))] = (entry.localizations ?? [:]).compactMapValues { $0.stringUnit?.value }
        }
        return out
    }()

    override func setUp() {
        super.setUp()
        ServerText.templateOverride = { code, language in Self.templates[code]?[language.rawValue] }
    }

    override func tearDown() {
        ServerText.templateOverride = nil
        super.tearDown()
    }

    private func message(_ json: String, language: AppLanguage) throws -> Message {
        try AppLanguage.withOverride(language) { try JSONDecoder().decode(Message.self, from: Data(json.utf8)) }
    }

    private let stalled = #"""
    {"id":"m1","projectId":"p","who":"시스템","kind":"시스템","title":"전달 확인 필요",
     "body":"개발팀에게 전달이 진행되지 않고 있습니다. 전달 정보에서 '다시 확인'을 눌러 주세요. 원래 입력을 중복해서 보내지 않습니다.",
     "textCode":"chat.delivery_stalled","textParams":{"name":"개발팀"},"textLang":"ko"}
    """#

    func testCatalogHasEveryAppCodeInBothLanguages() {
        XCTAssertGreaterThan(Self.templates.count, 100)
        for (code, langs) in Self.templates {
            XCTAssertNotNil(langs["ko"], code)
            XCTAssertNotNil(langs["en"], code)
            XCTAssertNil(langs["en"]?.range(of: #"\p{Hangul}"#, options: .regularExpression), code)
            // 앱 사본(생성 파일)의 한국어 기본값이 문구 표와 같다.
            ServerText.templateOverride = nil
            XCTAssertEqual(ServerTextCatalog.template(code), langs["ko"], code)
            ServerText.templateOverride = { code, language in Self.templates[code]?[language.rawValue] }
        }
        XCTAssertNil(ServerTextCatalog.template("notice.api_usage.title"), "서버의 Mac 스크립트 알림 전용 글은 앱 표에 없다")
    }

    /// 보고 언어 한국어 + 한국어 화면: 받은 그대로(글자 하나 바뀌지 않는다).
    func testKoreanScreenKeepsTheKoreanText() throws {
        let m = try message(stalled, language: .ko)
        XCTAssertEqual(m.title, "전달 확인 필요")
        XCTAssertEqual(m.body, "개발팀에게 전달이 진행되지 않고 있습니다. 전달 정보에서 '다시 확인'을 눌러 주세요. 원래 입력을 중복해서 보내지 않습니다.")
        XCTAssertEqual(m.who, "시스템")
        XCTAssertEqual(m.textLang, "ko")
    }

    func testEnglishScreenRedrawsFromTheCode() throws {
        let m = try message(stalled, language: .en)
        XCTAssertEqual(m.title, "Delivery needs checking")
        XCTAssertEqual(m.body, "Delivery to 개발팀 is not moving. Press 'Check again' in the delivery details. The original input won't be sent twice.")
        XCTAssertEqual(m.textLang, "en", "다시 그렸으면 그 언어로 고쳐 둔다(다시 읽어도 두 번 그리지 않는다)")
        // 저장했다 다시 읽어도 같다.
        let again = try AppLanguage.withOverride(.en) { try JSONDecoder().decode(Message.self, from: JSONEncoder().encode(m)) }
        XCTAssertEqual(again.body, m.body)
        XCTAssertEqual(again.title, m.title)
        // 화면 언어를 한국어로 바꾸면 코드로 다시 한국어가 된다.
        let back = try AppLanguage.withOverride(.ko) { try JSONDecoder().decode(Message.self, from: JSONEncoder().encode(m)) }
        XCTAssertEqual(back.body, "개발팀에게 전달이 진행되지 않고 있습니다. 전달 정보에서 '다시 확인'을 눌러 주세요. 원래 입력을 중복해서 보내지 않습니다.")
        XCTAssertEqual(back.title, "전달 확인 필요")
    }

    /// 보고 언어 영어(서버가 영어로 그림) + 한국어 화면: 한국어 틀과 조사로 다시 그린다.
    func testKoreanScreenRedrawsEnglishServerTextWithParticles() throws {
        let m = try message(#"""
        {"id":"m2","projectId":"p","who":"시스템","kind":"시스템","title":"","body":"dev: run r1 — stopped at the usage limit; switched to Sonnet and told to continue",
         "textCode":"chat.usage_model_resumed","textParams":{"name":"dev","run":"r1","model":"Sonnet"},"textLang":"en"}
        """#, language: .ko)
        XCTAssertEqual(m.body, "dev: 실행 r1 — 사용 한도로 멈춰 모델을 Sonnet으로 바꿔 이어서 하게 했습니다")
        // josa 는 붙일 조사만 돌려준다(값 뒤에 붙인다).
        XCTAssertEqual(ServerText.josa("개발팀", "이"), "이")
        XCTAssertEqual(ServerText.josa("dev", "이"), "가")
        XCTAssertEqual(ServerText.josa("서버", "을"), "를")
        XCTAssertEqual(ServerText.josa("결제 연동", "은"), "은")
        let removed = try message(#"""
        {"id":"m2b","projectId":"p","kind":"시스템","body":"x","textCode":"chat.missing_report","textParams":{"name":"dev"},"textLang":"en","title":"Missing result report"}
        """#, language: .ko)
        XCTAssertEqual(removed.title, "결과 보고 누락")
        XCTAssertEqual(removed.body, "dev의 결과 보고가 보완 요청 뒤에도 남지 않았습니다. 기존 업무를 다시 실행하지 않고 결과를 확인해 주세요.")
        XCTAssertEqual(ServerText.particleRo("Opus"), "로")
        XCTAssertEqual(ServerText.particleRo("Fable 5.3"), "으로")
        XCTAssertEqual(ServerText.particleRo("모델"), "로")
        XCTAssertEqual(ServerText.particleRo("팀"), "으로")
    }

    /// 0.2.7 배포 전 확인(문제 10): 홈 '결과 보고 누락' 줄 제목. 서버는 코드 없이 한국어 '결과 보고 누락'만 싣는다.
    func testMissingReportRowTitleFollowsTheScreenLanguage() throws {
        let notice = try JSONDecoder().decode(MissingReportNotice.self, from: Data(#"""
        {"kind":"missing_report","runId":"r1","memberId":"m1","messageId":"msg_missing_report_r1","createdAt":"2026-11-16T06:00:00.000Z","title":"결과 보고 누락"}
        """#.utf8))
        XCTAssertEqual(notice.displayTitle(language: .ko), "결과 보고 누락", "한국어 화면은 받은 그대로")
        XCTAssertEqual(notice.displayTitle(language: .en), "Missing result report")
        // 모르는 종류·다른 제목(뒤의 서버가 바꾼 글)은 지어내지 않고 받은 그대로.
        let other = MissingReportNotice(kind: "missing_report", runId: "r2", memberId: "m1", messageId: "x", createdAt: "", title: "보고 없음(새 글)")
        XCTAssertEqual(other.displayTitle(language: .en), "보고 없음(새 글)")
        let future = MissingReportNotice(kind: "late_report", runId: "r3", memberId: "m1", messageId: "x", createdAt: "", title: "결과 보고 누락")
        XCTAssertEqual(future.displayTitle(language: .en), "결과 보고 누락")
    }

    func testUnknownCodeMissingParamOrUnknownLanguageKeepTheText() throws {
        let unknown = try message(#"{"id":"m3","projectId":"p","kind":"시스템","body":"새 판의 글","textCode":"chat.from_the_future","textLang":"ko"}"#, language: .en)
        XCTAssertEqual(unknown.body, "새 판의 글")
        let missing = try message(#"{"id":"m4","projectId":"p","kind":"시스템","body":"x 오류: y","textCode":"chat.member_error","textParams":{"name":"x"},"textLang":"ko"}"#, language: .en)
        XCTAssertEqual(missing.body, "x 오류: y")
        let language = try message(#"{"id":"m5","projectId":"p","kind":"시스템","body":"x 오류: y","textCode":"chat.member_error","textParams":{"name":"x","error":"y"},"textLang":"ja"}"#, language: .en)
        XCTAssertEqual(language.body, "x 오류: y")
        // 옛 서버(코드 없음)는 그대로.
        let old = try message(#"{"id":"m6","projectId":"p","kind":"시스템","body":"x 오류: y"}"#, language: .en)
        XCTAssertEqual(old.body, "x 오류: y")
        // 제목 코드가 없는데 제목이 있으면(문장과 코드가 어긋남) 바꾸지 않는다.
        let titled = try message(#"{"id":"m7","projectId":"p","kind":"시스템","title":"엉뚱한 제목","body":"x 오류: y","textCode":"chat.member_error","textParams":{"name":"x","error":"y"},"textLang":"ko"}"#, language: .en)
        XCTAssertEqual(titled.body, "x 오류: y")
    }

    func testNestedCodesAndDates() throws {
        let m = try message(#"""
        {"id":"m8","projectId":"p","kind":"시스템","body":"dev: 실행 r2 중단 — Mac이나 실행 엔진이 다시 시작되어 세션이 꺼졌습니다",
         "textCode":"chat.run_interrupted","textParams":{"name":"dev","run":"r2","why":{"code":"why.restart_session_off"}},"textLang":"ko"}
        """#, language: .en)
        XCTAssertEqual(m.body, "dev: run r2 stopped — the Mac or the engine restarted and the session closed")
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertEqual(ServerText.dateText("2026-11-14T06:00:00.000Z", language: .ko, timeZone: utc), "11월 14일 오전 6시")
        XCTAssertEqual(ServerText.dateText("2026-11-14T15:30:00.000Z", language: .ko, timeZone: utc), "11월 14일 오후 3시 30분")
        XCTAssertNotNil(ServerText.dateText("2026-11-14T15:30:00.000Z", language: .en, timeZone: utc)?.range(of: "Nov"))
    }

    func testToolPermissionCardOptionsAndCloseReason() throws {
        let json = #"""
        {"id":"d1","kind":"tool_permission","who":"결제 연동","title":"명령 실행: bun test","detail":"…","status":"closed",
         "options":[{"k":"allow","label":"허용","desc":"이번 한 번만 실행합니다"},{"k":"deny","label":"거절","desc":"실행하지 않고 팀장에게 알립니다"}],
         "closeReason":"팀장의 터미널이 끝나 닫았습니다","closedBy":"시스템",
         "textLang":"ko","optionTexts":{"allow":{"label":{"code":"card.tool_permission.allow"},"desc":{"code":"card.tool_permission.allow_desc"}},
           "deny":{"label":{"code":"card.tool_permission.deny"},"desc":{"code":"card.tool_permission.deny_desc"}}},
         "closeReasonText":{"code":"card.tool_permission.closed_terminal_ended"}}
        """#
        let english = try AppLanguage.withOverride(.en) { try JSONDecoder().decode(Decision.self, from: Data(json.utf8)) }
        XCTAssertEqual(english.options.map(\.label), ["Allow", "Deny"])
        XCTAssertEqual(english.options.map(\.desc), ["Runs it this one time only", "Doesn't run it and tells the staff member"])
        XCTAssertEqual(english.closeReason, "Closed because the staff member's terminal ended")
        XCTAssertEqual(english.title, "명령 실행: bun test", "코드가 없는 칸은 그대로")
        XCTAssertEqual(english.options.map(\.k), ["allow", "deny"], "답의 키는 그대로")
        let korean = try AppLanguage.withOverride(.ko) { try JSONDecoder().decode(Decision.self, from: Data(json.utf8)) }
        XCTAssertEqual(korean.options.map(\.label), ["허용", "거절"])
        XCTAssertEqual(korean.closeReason, "팀장의 터미널이 끝나 닫았습니다")
        XCTAssertEqual(korean.closedBy, "시스템")
    }

    /// 0.2.6 Y 리뷰: 서버가 두 언어로 따로 만든 값({"ko","en"})은 화면 언어 쪽을 쓴다(도구 승인 카드의 대상처럼 '(5자)' 같은 붙임말이 든 값).
    func testLanguageSpecificParamsOnToolPermissionCard() throws {
        let json = #"""
        {"id":"d2","kind":"tool_permission","who":"dev","title":"파일 쓰기: /tmp/x.txt (5자)","detail":"(한국어 본문)","status":"open",
         "options":[{"k":"allow","label":"허용","desc":"이번 한 번만 실행합니다"},{"k":"deny","label":"거절","desc":"실행하지 않고 팀장에게 알립니다"}],
         "textLang":"ko","textCode":"card.tool_permission",
         "textParams":{"name":"dev","action":{"code":"tool.action.write"},"bar":"```","target":{"ko":"/tmp/x.txt (5자)","en":"/tmp/x.txt (5 characters)"},
           "titleTarget":{"ko":"/tmp/x.txt (5자)","en":"/tmp/x.txt (5 characters)"},"folderLine":"","minutes":"10"}}
        """#
        let english = try AppLanguage.withOverride(.en) { try JSONDecoder().decode(Decision.self, from: Data(json.utf8)) }
        XCTAssertEqual(english.title, "Write a file: /tmp/x.txt (5 characters)")
        XCTAssertTrue(english.detail.contains("```\n/tmp/x.txt (5 characters)\n```"), english.detail)
        XCTAssertNil(english.detail.range(of: #"\p{Hangul}"#, options: .regularExpression), english.detail)
        // 저장(오프라인 사본)했다 한국어 화면으로 다시 읽으면 한국어 쪽 값으로 돌아온다.
        let back = try AppLanguage.withOverride(.ko) { try JSONDecoder().decode(Decision.self, from: JSONEncoder().encode(english)) }
        XCTAssertEqual(back.title, "파일 쓰기: /tmp/x.txt (5자)")
        XCTAssertTrue(back.detail.contains("```\n/tmp/x.txt (5자)\n```"), back.detail)
        let korean = try AppLanguage.withOverride(.ko) { try JSONDecoder().decode(Decision.self, from: Data(json.utf8)) }
        XCTAssertEqual(korean.title, "파일 쓰기: /tmp/x.txt (5자)")
        XCTAssertEqual(korean.detail, "(한국어 본문)", "같은 언어면 받은 그대로")
        // 60자가 넘어 잘린 '무엇을'(tool.action.mcp_clipped).
        XCTAssertEqual(ServerText.render(ServerTextRef(code: "tool.action.mcp_clipped", params: ["server": .text("plugin_acme"), "count": .text("16")]), language: .en),
                       "Use a connected tool (plugin_acme… 16 more characters)")
        XCTAssertEqual(ServerText.render(ServerTextRef(code: "tool.action.mcp_clipped", params: ["server": .text("plugin_acme"), "count": .text("16")]), language: .ko),
                       "연결 도구 쓰기(plugin_acme…(16자 더 있음)")
    }

    /// 0.2.6 Y 리뷰: 실행 중단의 까닭(잠재우기 등)이 코드로 오면 영어 화면에 한국어가 섞이지 않는다.
    func testInterruptedRunReasonCode() throws {
        let m = try message(#"""
        {"id":"m9","projectId":"p","who":"시스템","kind":"시스템","title":"","body":"dev: 실행 r3 중단 — 팀원을 잠재워 실행을 종료했습니다",
         "textCode":"chat.run_interrupted","textParams":{"name":"dev","run":"r3","why":{"code":"why.slept"}},"textLang":"ko"}
        """#, language: .en)
        XCTAssertEqual(m.body, "dev: run r3 stopped — the staff member was put to sleep, which ended the run")
        let exit = #"{"id":8,"memberId":"m","at":"2026-11-14T00:00:00Z","kind":"error","text":"Session ended: exited (exit code 3)","textCode":"activity.exit","textParams":{"reason":"exited","code":"3"},"textLang":"en"}"#
        XCTAssertEqual(try AppLanguage.withOverride(.ko) { try JSONDecoder().decode(Activity.self, from: Data(exit.utf8)) }.text, "초기/실행 종료: exited (exit_code=3)")
    }

    func testActivityLine() throws {
        let json = #"{"id":7,"memberId":"m","at":"2026-11-14T00:00:00Z","kind":"turn_end","text":"턴 끝","textCode":"activity.turn_end","textLang":"ko"}"#
        XCTAssertEqual(try AppLanguage.withOverride(.en) { try JSONDecoder().decode(Activity.self, from: Data(json.utf8)) }.text, "Turn ended")
        XCTAssertEqual(try AppLanguage.withOverride(.ko) { try JSONDecoder().decode(Activity.self, from: Data(json.utf8)) }.text, "턴 끝")
    }

    func testMemberErrorAndDeliveryNoticeSentences() throws {
        let member = try JSONDecoder().decode(Member.self, from: Data(#"{"id":"m","lastError":"인터넷 연결 문제로 멈춤","lastErrorCode":"last_error_api_outage"}"#.utf8))
        XCTAssertEqual(member.errorTextCode, "last_error_api_outage")
        XCTAssertEqual(AppLanguage.withOverride(.en) { friendlyError(member.lastError!, code: member.errorTextCode) }, "Stopped by an internet connection problem")
        XCTAssertEqual(AppLanguage.withOverride(.ko) { friendlyError(member.lastError!, code: member.errorTextCode) }, "인터넷 연결 문제로 멈춤")
        // 보류 코드가 있으면 그것이 먼저다.
        let fenced = try JSONDecoder().decode(Member.self, from: Data(#"{"id":"m","lastError":"x","fenceCode":"starting_unknown","lastErrorCode":"last_error_api_outage"}"#.utf8))
        XCTAssertEqual(fenced.errorTextCode, "starting_unknown")
        XCTAssertEqual(AppLanguage.withOverride(.en) { ServerErrorText.displayNote("전달 여부를 시스템이 확인하고 있습니다") }, "The system is checking whether it was delivered")
        XCTAssertEqual(AppLanguage.withOverride(.en) { ServerErrorText.displayNote("다시 확인") }, "Check again")
        XCTAssertEqual(AppLanguage.withOverride(.ko) { ServerErrorText.displayNote("다시 확인") }, "다시 확인")
        XCTAssertEqual(AppLanguage.withOverride(.en) { ServerErrorText.displayNote("모르는 안내") }, "모르는 안내")
        XCTAssertEqual(AppLanguage.withOverride(.en) { plainDeliveryNote("세션 기록을 찾지 못했습니다. 연결과 기록 경로를 확인한 뒤 다시 확인해 주세요", code: "note_log_missing") },
                       "Couldn't find the conversation record. Check the connection and the record path, then check again")
    }

    func testFolderTrustPromptAndObservationNotes() throws {
        let json = #"{"title":"폴더 신뢰 확인","body":"/tmp/w\n이 폴더에서 AI가 파일을 읽고 고치고 실행할 수 있게 됩니다","question":"Is this a project you created or one you trust?","options":[{"n":1,"label":"No, exit","reject":true},{"n":2,"label":"Yes, I trust this folder","reject":false}],"fingerprint":"f"}"#
        let english = try AppLanguage.withOverride(.en) { try JSONDecoder().decode(CLIApprovalPrompt.self, from: Data(json.utf8)) }
        XCTAssertEqual(english.title, "Trust this folder?")
        XCTAssertEqual(english.body, "/tmp/w\nThe AI will be able to read, edit and run files in this folder")
        XCTAssertEqual(english.options.map(\.label), ["No, exit", "Yes, I trust this folder"])
        let korean = try AppLanguage.withOverride(.ko) { try JSONDecoder().decode(CLIApprovalPrompt.self, from: Data(json.utf8)) }
        XCTAssertEqual(korean.title, "폴더 신뢰 확인")
        XCTAssertEqual(korean.body, "/tmp/w\n이 폴더에서 AI가 파일을 읽고 고치고 실행할 수 있게 됩니다")

        let note = #"{"code":"folder_trust","note":"폴더 신뢰 확인 창에서 멈췄습니다: /tmp/w"}"#
        XCTAssertEqual(try AppLanguage.withOverride(.en) { try JSONDecoder().decode(ObservationError.self, from: Data(note.utf8)) }.note, "Stopped at the folder trust prompt: /tmp/w")
        XCTAssertEqual(try AppLanguage.withOverride(.ko) { try JSONDecoder().decode(ObservationError.self, from: Data(note.utf8)) }.note, "폴더 신뢰 확인 창에서 멈췄습니다: /tmp/w")
        let raw = #"{"code":"usage_limit","note":"You've hit your limit"}"#
        XCTAssertEqual(try AppLanguage.withOverride(.en) { try JSONDecoder().decode(ObservationError.self, from: Data(raw.utf8)) }.note, "You've hit your limit")
    }
}
