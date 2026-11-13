import Foundation
import XCTest
@testable import IAMCEO

/// 0.2.5 W: 영어 샘플. 앱 화면이 영어면 샘플이 같은 회사·같은 흐름의 영어 자료로 답하고, 샘플 서버가 지어내는 글도 영어다.
/// 한국어 화면(과 언어 표가 없는 시험)은 예전 한국어 자료 그대로다.
@MainActor
final class SampleEnglishTests: XCTestCase {
    private static let hangul = try! NSRegularExpression(pattern: "[\u{AC00}-\u{D7A3}]")
    /// 서버가 정한 한국어 상수(대화 글 종류, 대표 글의 글쓴이). 앱이 보이는 이름으로 바꿔 그린다.
    private static let serverConstants: Set<String> = ["완료", "진행", "질문", "막힘", "알림", "답변", "지시", "직접", "나", "시스템"]

    private func hasHangul(_ text: String) -> Bool {
        Self.hangul.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// 사람이 읽는 글 가운데 서버 상수가 아닌 한글.
    private func hangulTexts(_ value: Any, key: String = "", path: String = "") -> [String] {
        switch value {
        case let object as [String: Any]:
            return object.flatMap { hangulTexts($0.value, key: $0.key, path: path + "." + $0.key) }
        case let array as [Any]:
            return array.flatMap { hangulTexts($0, key: key, path: path) }
        case let text as String where hasHangul(text):
            if (key == "kind" || key == "who") && Self.serverConstants.contains(text) { return [] }
            return ["\(path): \(text.prefix(60))"]
        default:
            return []
        }
    }

    func testEnglishSampleIsTheSameCompanyInEnglish() throws {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        let (koBootstrap, koState) = try SampleWorkspace.decoded(now: now, language: .ko)
        let (enBootstrap, enState) = try SampleWorkspace.decoded(now: now, language: .en)
        // 같은 회사·같은 흐름: id·종류·상태·시각이 같고 글만 다르다(화면 견본 인자 `--open d-pg` 가 두 언어에서 같다).
        XCTAssertEqual(enBootstrap.projects.map(\.id), koBootstrap.projects.map(\.id))
        XCTAssertEqual(enBootstrap.projects.map(\.name), ["HQ", "Checkout Revamp", "Investor Deck"])
        XCTAssertEqual(enState.members.map(\.id), koState.members.map(\.id))
        XCTAssertEqual(enState.members.map(\.status), koState.members.map(\.status))
        XCTAssertEqual(enState.decisions.map(\.id), koState.decisions.map(\.id))
        XCTAssertEqual(enState.decisions.map(\.status), koState.decisions.map(\.status))
        XCTAssertEqual(enState.todos.map(\.id), koState.todos.map(\.id))
        XCTAssertEqual(enState.files.map(\.id), koState.files.map(\.id))
        XCTAssertEqual(enState.messages.map(\.id), koState.messages.map(\.id))
        XCTAssertEqual(enState.messages.map(\.at), koState.messages.map(\.at))
        XCTAssertEqual(enState.members.first { $0.id == "m-copy" }?.name, "UX Copy")
        XCTAssertEqual(enState.decisions.first { $0.id == "d-pg" }?.title, "Which payment provider should we use?")
        XCTAssertEqual(koState.members.first { $0.id == "m-copy" }?.name, "화면 문구")
        // 영어 샘플의 팀은 영어로 보고한다(설정 → 일반 → 보고 언어).
        XCTAssertEqual(enBootstrap.settings.reportLanguage, "en")
        XCTAssertEqual(koBootstrap.settings.reportLanguage, "ko")
    }

    func testEnglishSampleHasNoKoreanBesidesServerConstants() {
        let data = SampleWorkspace.load(now: Date(timeIntervalSince1970: 1_900_000_000), language: .en)
        XCTAssertFalse(data.isEmpty)
        XCTAssertEqual(hangulTexts(data), [])
        // 시안 문서도 영어 문서다.
        let documents = data["artifactDocuments"] as? [String: String] ?? [:]
        XCTAssertTrue(documents["f-copy"]?.hasPrefix(#"<!doctype html><html lang="en">"#) == true)
        XCTAssertTrue(documents["f-copy"]?.contains("Success and failure screen mockups") == true)
    }

    func testSampleFollowsTheAppLanguage() {
        // 시험에는 언어 표가 없어 앱 화면이 한국어다: 샘플도 한국어(예전 그대로).
        XCTAssertEqual(SampleServer().language, .ko)
        XCTAssertEqual(AppLanguage.withOverride(.en) { SampleServer().language }, .en)
        XCTAssertEqual(DemoFixtures.workspace(now: Date(timeIntervalSince1970: 1_900_000_000)).0.projects.first { $0.isHq }?.name, "본사")
        let english = AppLanguage.withOverride(.en) { DemoFixtures.workspace(now: Date(timeIntervalSince1970: 1_900_000_000)) }
        XCTAssertEqual(english.0.projects.first { $0.isHq }?.name, "HQ")
    }

    func testEnglishSampleAnswersInEnglish() async throws {
        let store = AppLanguage.withOverride(.en) { AppStore(demo: true) }
        defer { store.prepareForReplacement() }
        let server = try XCTUnwrap(store.sampleServer)
        XCTAssertEqual(server.language, .en)
        server.deliveryDelay = .milliseconds(30); server.replyDelay = .milliseconds(60)
        try await waitWhile({ !(store.connectionStatus == .connected && store.state != nil && store.canWrite) }, timeout: .seconds(15))
        XCTAssertEqual(store.members.first { $0.id == "m-card" }?.name, "Card Checkout")
        let sent = await store.sendMessage(text: "Add the support number to the failure screen", targetMemberID: "m-copy")
        XCTAssertTrue(sent)
        try await waitWhile({ !store.messages.contains { $0.memberId == "m-copy" && $0.title == "Instruction received" } })
        let reply = try XCTUnwrap(store.messages.last { $0.memberId == "m-copy" && $0.title == "Instruction received" })
        XCTAssertEqual(reply.body, "Got it. I'll wrap up what I'm doing and start right away on “Add the support number to the failure screen”, then report back when it's done.")
        XCTAssertFalse(hasHangul(reply.body))
        XCTAssertTrue(store.members.first { $0.id == "m-copy" }?.now.hasPrefix("Your instruction: Add the support number") == true)
        // 지운 할 일의 '정리한 이'도 영어.
        try await waitWhile({ store.todos.first { $0.id == "t-logo" } == nil })
        let logo = try XCTUnwrap(store.todos.first { $0.id == "t-logo" })
        let dropped = await store.dropTodo(logo, reason: "We already have the logo")
        XCTAssertTrue(dropped)
        XCTAssertEqual(store.todos.first { $0.id == "t-logo" }?.closedBy, "you")
    }

    /// 리뷰 lang-3: 지시가 문장 부호로 끝나거나 길어서 줄여도 답글의 문장 부호가 겹치지 않는다.
    func testEnglishAcknowledgementPunctuation() {
        let ended = SampleServer.englishAcknowledgement("Please finish the refund copy this week.")
        XCTAssertTrue(ended.contains("on “Please finish the refund copy this week”, then"), ended)
        XCTAssertTrue(SampleServer.englishAcknowledgement("Can you check the refund flow?").contains("“Can you check the refund flow”,"))
        let long = SampleServer.englishAcknowledgement(String(repeating: "Move the pay button above the fold ", count: 3))
        XCTAssertTrue(long.contains("…”, then report back"), long)
        for reply in [ended, long] {
            XCTAssertFalse(reply.contains(".”."))
            XCTAssertFalse(reply.contains("…”."))
            XCTAssertFalse(reply.contains("?”."))
            XCTAssertTrue(reply.hasSuffix("when it's done."))
        }
    }

    func testSampleTerminalScreenFollowsTheAppLanguage() {
        XCTAssertTrue(sampleTerminalText(.en).contains("IAMCEO · Sample project"))
        XCTAssertFalse(hasHangul(sampleTerminalText(.en)))
        XCTAssertTrue(sampleTerminalText(.ko).contains("샘플 프로젝트"))
    }

    private func sampleTerminalText(_ language: AppLanguage) -> String {
        var bytes = Data()
        let client = TerminalStreamClient()
        client.onOutput = { bytes.append($0) }
        AppLanguage.withOverride(language) { client.showDemo() }
        return String(decoding: bytes, as: UTF8.self)
    }
}
