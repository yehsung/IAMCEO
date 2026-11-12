import Foundation
import XCTest
@testable import IAMCEO

/// 완성도 2차 E 묶음(B1): 설정의 '보고 언어'. 옛 서버(필드 없음)에는 그 줄을 보이지 않고 그 값을 보내지도 않는다.
/// 새 서버에는 바꾼 때만 그 값 하나를 보낸다.
@MainActor final class Wave2LanguageTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testReportLanguageIsOptionalAndLenient() throws {
        XCTAssertNil(try decode(Settings.self, "{}").reportLanguage, "옛 서버는 이 값을 보내지 않는다")
        XCTAssertEqual(try decode(Settings.self, #"{"reportLanguage":"en"}"#).reportLanguage, "en")
        XCTAssertEqual(try decode(Settings.self, #"{"reportLanguage":"ko","compactAtPct":60}"#).compactAtPct, 60)
        XCTAssertNil(try decode(Settings.self, #"{"reportLanguage":7}"#).reportLanguage, "형이 어긋나도 설정 전체를 버리지 않는다")
        // 옛 서버에서 받은 설정을 그대로 되돌려 보낼 때 없는 필드를 만들어 내지 않는다.
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(Settings())) as? [String: Any])
        XCTAssertNil(encoded["reportLanguage"])
    }

    func testChoicesAreNamedInTheirOwnLanguage() {
        XCTAssertEqual(SettingsView.reportLanguages, ["ko", "en"])
        XCTAssertEqual(SettingsView.reportLanguages.map(SettingsView.reportLanguageLabel), ["한국어", "English"])
        XCTAssertEqual(SettingsView.reportLanguageLabel("ja"), "ja", "모르는 값은 바꾸지 않고 그대로 보인다")
        XCTAssertFalse(SettingsView.reportLanguageHint.contains("직원"))
    }

    /// 리뷰 app-1: 설정 서명에 보고 언어가 빠져 언어만 바꾸면 저장 단추가 켜지지 않았고, 다른 기기에서 바꾼 언어도 화면에 오지 않았다.
    func testChangingOnlyTheReportLanguageIsAnEditThatCanBeSaved() {
        var base = Settings(); base.reportLanguage = "ko"
        var draft = base; draft.reportLanguage = "en"
        XCTAssertNotEqual(SettingsView.signature(draft), SettingsView.signature(base), "언어만 바꿔도 고친 것이다(저장할 수 있다)")
        XCTAssertTrue(SettingsView.generalEdited(draft, base), "일반 묶음에 고친 표시가 붙는다")
        XCTAssertFalse(SettingsView.generalEdited(base, base))
        // 옛 서버(값 없음)끼리는 같다. 다른 기기가 바꾼 언어는 서버 서명이 달라져 화면이 다시 읽는다.
        XCTAssertEqual(SettingsView.signature(Settings()), SettingsView.signature(Settings()))
        var other = base; other.reportLanguage = "en"
        XCTAssertNotEqual(SettingsView.signature(other), SettingsView.signature(base))
    }

    func testChangedLanguageIsSentAloneToAServerThatReportsIt() async throws {
        let server = WriteTestServer()
        server.change { $0.bootstrap.settings.reportLanguage = "ko" }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        var draft = try XCTUnwrap(store.beginSettingsEditing()).draft
        XCTAssertEqual(draft.reportLanguage, "ko")
        draft.reportLanguage = "en"
        let saved = await store.updateSettings(draft)
        XCTAssertTrue(saved)
        let body = try XCTUnwrap(server.read { $0.settingsBodies.last })
        XCTAssertEqual(Set(body.keys), ["reportLanguage"])
        XCTAssertEqual(body["reportLanguage"] as? String, "en")
        store.disconnect(); await network.close()
    }

    func testOlderServerNeverReceivesTheKey() async throws {
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        var draft = try XCTUnwrap(store.beginSettingsEditing()).draft
        XCTAssertNil(draft.reportLanguage)
        draft.compactAtPct = 80
        draft.reportLanguage = "en"
        let saved = await store.updateSettings(draft)
        XCTAssertTrue(saved)
        XCTAssertEqual(Set(try XCTUnwrap(server.read { $0.settingsBodies.last }).keys), ["compactAtPct"],
                       "옛 서버의 엄격한 설정 검사는 모르는 키가 있으면 저장 전체를 거절한다")
        store.disconnect(); await network.close()
    }
}
