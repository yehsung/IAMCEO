import Foundation
import XCTest
@testable import IAMCEO

/// 0.2.5 W: 앱 화면 언어의 선택. 기본(자동) = iPhone 은 App Store 국가(한국이면 한국어, 그 밖은 영어), Mac 과 스토어 정보가 없을 때는
/// 기기 언어. 설정에서 고른 것과 시스템의 앱별 언어는 같은 스위치이고, 시스템에서 바꾸면 그것이 이긴다.
final class AppLanguagePolicyTests: XCTestCase {
    private typealias Policy = AppLanguagePolicy
    private let fresh = AppLanguageState(choice: nil, written: nil)

    func testLanguageTags() {
        XCTAssertEqual(Policy.language(of: "ko-KR"), .ko)
        XCTAssertEqual(Policy.language(of: "ko_KR"), .ko)
        XCTAssertEqual(Policy.language(of: "en-GB"), .en)
        XCTAssertEqual(Policy.language(of: "EN"), .en)
        XCTAssertNil(Policy.language(of: "zh-Hant-TW"))
        XCTAssertNil(Policy.language(of: nil))
        XCTAssertEqual(Policy.bundleLanguage(for: ["ja-JP", "ko-KR", "en-US"]), .ko, "처음 나오는 한국어·영어")
        XCTAssertEqual(Policy.bundleLanguage(for: ["ja-JP"]), .en, "둘 다 없으면 영어(묶음의 대체 언어)")
        XCTAssertEqual(Policy.storeLanguage("KOR"), .ko)
        XCTAssertEqual(Policy.storeLanguage("kor"), .ko)
        XCTAssertEqual(Policy.storeLanguage("USA"), .en)
        XCTAssertEqual(Policy.storeLanguage("JPN"), .en)
    }

    // MARK: 처음 실행의 '자동'

    func testFirstLaunchOnIPhoneFollowsTheStoreCountry() {
        // 한국 스토어 + 영어 기기 → 한국어를 앱 영역에 둔다.
        var decision = Policy.launch(state: fresh, appDomain: nil, device: ["en-US"], storefront: "KOR")
        XCTAssertEqual(decision.appleLanguages, ["ko"])
        XCTAssertEqual(decision.language, .ko)
        XCTAssertEqual(decision.state, AppLanguageState(choice: .auto, written: ["ko"], basis: .store))
        XCTAssertFalse(decision.adoptedFromSystem)
        // 미국 스토어 + 한국어 기기 → 영어.
        decision = Policy.launch(state: fresh, appDomain: nil, device: ["ko-KR"], storefront: "USA")
        XCTAssertEqual(decision.appleLanguages, ["en"])
        XCTAssertEqual(decision.language, .en)
        // 리뷰 lang-2: 기기 언어가 이미 같아도 국가의 언어를 분명히 둔다(뒤에 기기 언어를 바꿔도 화면이 따라 바뀌지 않고,
        // 설정의 'App Store 국가를 따릅니다'와 맞게).
        decision = Policy.launch(state: fresh, appDomain: nil, device: ["ko-KR", "en-US"], storefront: "KOR")
        XCTAssertEqual(decision.appleLanguages, ["ko"])
        XCTAssertEqual(decision.language, .ko)
        XCTAssertEqual(decision.state.basis, .store)
        decision = Policy.launch(state: fresh, appDomain: nil, device: ["ja-JP"], storefront: "JPN")
        XCTAssertEqual(decision.appleLanguages, ["en"])
        XCTAssertEqual(decision.language, .en)
        // 기기 언어 목록을 읽지 못하면 스토어 국가의 언어를 분명히 둔다.
        decision = Policy.launch(state: fresh, appDomain: nil, device: nil, storefront: "KOR")
        XCTAssertEqual(decision.appleLanguages, ["ko"])
    }

    func testFirstLaunchWithoutStoreInformationFollowsTheDevice() {
        // Mac 앱과 스토어 국가를 못 얻은 iPhone: 기기 언어(한국어면 한국어, 아니면 영어). 아무것도 두지 않는다.
        for (device, language) in [(["ko-KR"], AppLanguage.ko), (["en-US"], .en), (["ja-JP"], .en), (["ja-JP", "ko-KR"], .ko)] {
            let decision = Policy.launch(state: fresh, appDomain: nil, device: device, storefront: nil)
            XCTAssertNil(decision.appleLanguages, "\(device)")
            XCTAssertEqual(decision.language, language, "\(device)")
            XCTAssertEqual(decision.state.choice, .auto)
            XCTAssertEqual(decision.state.basis, .device, "안내는 '기기 언어를 따릅니다'")
        }
    }

    func testUpdatingFromAnEarlierVersionKeepsTheLanguageOnScreen() {
        // 0.2.4 이하를 쓰던 한국어 iPhone(미국 스토어): 업데이트만으로 영어로 바뀌지 않는다.
        let decision = Policy.launch(state: fresh, appDomain: nil, device: ["ko-KR"], storefront: "USA", earlierUse: true)
        XCTAssertNil(decision.appleLanguages)
        XCTAssertEqual(decision.language, .ko)
        XCTAssertEqual(decision.state.choice, .auto)
        XCTAssertEqual(decision.state.basis, .device, "국가를 쓰지 않은 자동: 안내도 '기기 언어를 따릅니다'(리뷰 lang-2)")
    }

    func testALanguagePickedInSystemSettingsBeforeTheFirstLaunchIsKept() {
        let decision = Policy.launch(state: fresh, appDomain: ["en"], device: ["ko-KR"], storefront: "KOR")
        XCTAssertEqual(decision.appleLanguages, ["en"])
        XCTAssertEqual(decision.state.choice, .en)
        XCTAssertTrue(decision.adoptedFromSystem)
    }

    // MARK: 다음 실행들

    func testTheAutomaticDecisionStaysPut() {
        let first = Policy.launch(state: fresh, appDomain: nil, device: ["ko-KR"], storefront: "USA")
        // 다음 실행: 같은 값을 그대로 둔다(다시 정하지 않고, 시스템이 바꾼 것으로 보지도 않는다).
        let second = Policy.launch(state: first.state, appDomain: first.appleLanguages, device: ["ko-KR"], storefront: "KOR")
        XCTAssertEqual(second.appleLanguages, ["en"])
        XCTAssertEqual(second.state, first.state)
        XCTAssertFalse(second.adoptedFromSystem)
        XCTAssertEqual(second.language, .en)
        // 아무것도 두지 않은 자동은 기기 언어를 계속 따른다(기기 언어를 바꾸면 화면도 바뀐다).
        let mac = Policy.launch(state: AppLanguageState(choice: .auto, written: nil), appDomain: nil, device: ["en-US"], storefront: nil)
        XCTAssertNil(mac.appleLanguages)
        XCTAssertEqual(mac.language, .en)
    }

    func testSystemSettingsWin() {
        // 앱이 English 를 두었는데 iPhone 설정 → IAMCEO → 언어에서 한국어로 바꿨다.
        var decision = Policy.launch(state: AppLanguageState(choice: .en, written: ["en"]), appDomain: ["ko-KR"], device: ["en-US"], storefront: "USA")
        XCTAssertTrue(decision.adoptedFromSystem)
        XCTAssertEqual(decision.state.choice, .ko)
        XCTAssertEqual(decision.appleLanguages, ["ko-KR"], "시스템이 둔 값을 그대로")
        XCTAssertEqual(decision.language, .ko)
        // 그다음 실행은 조용하다.
        let next = Policy.launch(state: decision.state, appDomain: decision.appleLanguages, device: ["en-US"], storefront: "USA")
        XCTAssertFalse(next.adoptedFromSystem)
        XCTAssertEqual(next.appleLanguages, ["ko-KR"])
        // 시스템에서 '기본'으로 되돌렸다 → 자동(기기 언어). 스토어 국가로 다시 덮지 않는다.
        decision = Policy.launch(state: AppLanguageState(choice: .ko, written: ["ko"]), appDomain: nil, device: ["en-US"], storefront: "KOR")
        XCTAssertTrue(decision.adoptedFromSystem)
        XCTAssertEqual(decision.state.choice, .auto)
        XCTAssertEqual(decision.state.basis, .device)
        XCTAssertNil(decision.appleLanguages)
        XCTAssertEqual(decision.language, .en)
        // 앱이 고른 것과 시스템 값의 지역만 다르면(ko vs ko-KR) 바뀐 것이 아니다.
        decision = Policy.launch(state: AppLanguageState(choice: .ko, written: ["ko"]), appDomain: ["ko-KR"], device: ["en-US"], storefront: nil)
        XCTAssertFalse(decision.adoptedFromSystem)
        XCTAssertEqual(decision.appleLanguages, ["ko-KR"])
    }

    // MARK: 설정에서 고르기

    func testChoosingInSettings() {
        let auto = AppLanguageState(choice: .auto, written: nil)
        var decision = Policy.choose(.en, state: auto, appDomain: nil, device: ["ko-KR"], storefront: "KOR")
        XCTAssertEqual(decision.appleLanguages, ["en"])
        XCTAssertEqual(decision.state, AppLanguageState(choice: .en, written: ["en"]))
        XCTAssertEqual(decision.language, .en)
        decision = Policy.choose(.ko, state: decision.state, appDomain: ["en"], device: ["ko-KR"], storefront: "KOR")
        XCTAssertEqual(decision.appleLanguages, ["ko"])
        XCTAssertEqual(decision.language, .ko)
        // '자동'을 고르면 지금 규칙으로 다시 정한다: iPhone 은 스토어 국가, Mac 은 기기 언어.
        decision = Policy.choose(.auto, state: decision.state, appDomain: ["ko"], device: ["ko-KR"], storefront: "USA")
        XCTAssertEqual(decision.appleLanguages, ["en"])
        XCTAssertEqual(decision.state.choice, .auto)
        XCTAssertEqual(decision.state.basis, .store)
        decision = Policy.choose(.auto, state: decision.state, appDomain: ["en"], device: ["ko-KR"], storefront: nil)
        XCTAssertNil(decision.appleLanguages)
        XCTAssertEqual(decision.language, .ko)
        XCTAssertEqual(decision.state.basis, .device)
        // 그다음 실행은 고른 것을 시스템이 바꾼 것으로 보지 않는다.
        let next = Policy.launch(state: decision.state, appDomain: decision.appleLanguages, device: ["ko-KR"], storefront: nil)
        XCTAssertFalse(next.adoptedFromSystem)
        XCTAssertEqual(next.state, decision.state)
    }
}

/// 저장소(UserDefaults)와 설정 화면의 상태. 시험은 따로 만든 묶음에만 쓴다(앱의 저장 값을 건드리지 않는다).
@MainActor
final class AppLanguageSettingsTests: XCTestCase {
    private func makeStore(device: [String]? = ["ko-KR"]) throws -> AppLanguageDefaults {
        let name = "iamceo.app-language.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
        return AppLanguageDefaults(defaults: defaults, domain: name, deviceLanguages: { device })
    }

    func testDecisionsAreStoredInTheAppDomain() throws {
        let store = try makeStore()
        XCTAssertNil(store.state.choice)
        XCTAssertFalse(store.earlierUse)
        let decision = AppLanguagePolicy.launch(state: store.state, appDomain: store.appDomain, device: store.device, storefront: "USA")
        store.apply(decision)
        XCTAssertEqual(store.state, AppLanguageState(choice: .auto, written: ["en"], basis: .store))
        XCTAssertEqual(store.appDomain, ["en"])
        store.apply(AppLanguagePolicy.choose(.auto, state: store.state, appDomain: store.appDomain, device: store.device, storefront: nil))
        XCTAssertNil(store.appDomain, "자동(기기 언어)은 앱 영역의 값을 지운다")
        XCTAssertEqual(store.state, AppLanguageState(choice: .auto, written: nil, basis: .device))
        store.storefront = "KOR"
        XCTAssertEqual(store.storefront, "KOR")
        store.storefront = nil
        XCTAssertEqual(store.storefront, "KOR", "못 얻은 국가로 앞서 읽은 값을 지우지 않는다")
    }

    func testEarlierVersionsAreRecognizedByTheirSavedValues() throws {
        let store = try makeStore()
        store.defaults.set("x", forKey: "iamceo.appLanguage.choice")
        XCTAssertFalse(store.earlierUse, "이 기능의 값은 전 판의 흔적이 아니다")
        store.defaults.set("https://mac.example.ts.net", forKey: "iamceo.endpoint")
        XCTAssertTrue(store.earlierUse)
    }

    func testSettingsShowWhenAReopenIsNeeded() throws {
        let store = try makeStore()
        store.apply(AppLanguagePolicy.launch(state: store.state, appDomain: store.appDomain, device: store.device, storefront: nil))
        let settings = AppLanguageSettings(store: store, current: .ko, argumentOverride: false)
        XCTAssertEqual(settings.choice, .auto)
        XCTAssertEqual(settings.next, .ko)
        XCTAssertFalse(settings.needsRelaunch)
        settings.select(.en)
        XCTAssertEqual(settings.choice, .en)
        XCTAssertEqual(settings.next, .en)
        XCTAssertTrue(settings.needsRelaunch)
        XCTAssertEqual(store.appDomain, ["en"])
        settings.select(.ko)
        XCTAssertFalse(settings.needsRelaunch)
        // 실행 인자로 언어를 정한 실행(화면 견본)은 '다시 열면 바뀝니다'를 띄우지 않는다.
        let preview = AppLanguageSettings(store: store, current: .en, argumentOverride: true)
        XCTAssertFalse(preview.needsRelaunch)
    }

    /// 리뷰 lang-2: '자동'의 안내는 실제로 정한 기준을 말한다. 국가를 읽어 두기만 한 기기(전 판에서 올림)는 '기기 언어를 따릅니다'.
    func testAutomaticHintFollowsTheBasisThatWasUsed() throws {
        let store = try makeStore()
        store.defaults.set("https://mac.example.ts.net", forKey: "iamceo.endpoint")
        store.apply(AppLanguagePolicy.launch(state: store.state, appDomain: store.appDomain, device: store.device, storefront: "USA",
                                             earlierUse: store.earlierUse))
        store.storefront = "USA" // 다음에 '자동'을 고를 때 쓰려고 읽어 둔 국가
        let upgraded = AppLanguageSettings(store: store, current: .ko, argumentOverride: false)
        XCTAssertEqual(upgraded.choice, .auto)
        XCTAssertFalse(upgraded.automaticFollowsStore, "국가를 쓰지 않은 자동")
        XCTAssertFalse(upgraded.needsRelaunch)

        let fresh = try makeStore()
        fresh.apply(AppLanguagePolicy.launch(state: fresh.state, appDomain: fresh.appDomain, device: fresh.device, storefront: "KOR"))
        let settings = AppLanguageSettings(store: fresh, current: .ko, argumentOverride: false)
        XCTAssertTrue(settings.automaticFollowsStore)
        settings.select(.en)
        XCTAssertFalse(settings.automaticFollowsStore)
    }

    func testLanguageNamesInSentences() {
        XCTAssertEqual(AppLanguage.ko.displayName, "한국어")
        XCTAssertEqual(AppLanguage.en.displayName, "English")
    }

    func testTestsNeverManageTheAppLanguage() {
        XCTAssertFalse(AppLanguageLaunch.shouldManage, "시험 중에는 앱의 언어 저장 값을 건드리지 않는다")
    }
}

/// 화면·진입점의 배치(소스로 확인).
final class AppLanguageWiringTests: XCTestCase {
    private let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Sources/IAMCEO")

    func testLanguageIsSettledBeforeTheAppStarts() throws {
        let source = try String(contentsOf: sources.appendingPathComponent("IAMCEOApp.swift"), encoding: .utf8)
        let launcher = try XCTUnwrap(source.range(of: "@main\nenum IAMCEOLauncher {"))
        let prepare = try XCTUnwrap(source.range(of: "AppLanguageLaunch.prepare()", range: launcher.upperBound..<source.endIndex))
        let start = try XCTUnwrap(source.range(of: "IAMCEOApp.main()", range: launcher.upperBound..<source.endIndex))
        XCTAssertLessThan(prepare.lowerBound, start.lowerBound)
        XCTAssertEqual(source.components(separatedBy: "@main").count - 1, 1)
    }

    func testLanguageRowIsFirstInGeneralAndWorksWithoutAConnection() throws {
        let source = try String(contentsOf: sources.appendingPathComponent("Views/SettingsView.swift"), encoding: .utf8)
        let general = try XCTUnwrap(source.range(of: "private var generalSection: some View {"))
        let body = source[general.upperBound...]
        let language = try XCTUnwrap(body.range(of: "appLanguageGroup"))
        let operation = try XCTUnwrap(body.range(of: "SettingsGroup(String(localized: \"운영\")"))
        XCTAssertLessThan(language.lowerBound, operation.lowerBound, "언어 줄은 서버 설정(운영) 묶음 밖, 위에 있다")
        // 서버 설정 묶음에 걸린 '연결됐을 때만' 잠금이 언어 줄에 걸리지 않는다.
        XCTAssertFalse(body[language.lowerBound..<operation.lowerBound].contains(".disabled("))
    }

    /// 리뷰 lang-1: 연결 전(설정의 다른 곳이 '서버에 연결하면 볼 수 있습니다'만 보일 때)에도 일반에 언어 줄이 그려지고,
    /// iPhone 연결 화면에도 언어 메뉴가 있다. 이미 고른 항목을 다시 누르면 아무것도 하지 않는다(lang-2).
    func testLanguageCanBeChangedBeforeConnecting() throws {
        let source = try String(contentsOf: sources.appendingPathComponent("Views/SettingsView.swift"), encoding: .utf8)
        let content = try XCTUnwrap(source.range(of: "@ViewBuilder private func sectionContent(_ item: SettingsSection) -> some View {"))
        let empty = try XCTUnwrap(source.range(of: "EmptyTile(", range: content.upperBound..<source.endIndex))
        let locked = try XCTUnwrap(source.range(of: "if store.bootstrap == nil && item != .connection {", range: content.upperBound..<empty.lowerBound))
        XCTAssertTrue(source[locked.upperBound..<empty.lowerBound].contains("if item == .general { appLanguageGroup }"),
                      "연결 전 빈 화면 위에 언어 줄")
        let connection = try XCTUnwrap(source.range(of: "struct ConnectionView: View {"))
        let card = try XCTUnwrap(source.range(of: "private var card: some View {", range: connection.upperBound..<source.endIndex))
        let cardEnd = try XCTUnwrap(source.range(of: ".modifier(ThickCardSurface())", range: card.upperBound..<source.endIndex))
        XCTAssertTrue(source[card.upperBound..<cardEnd.lowerBound].contains("AppLanguageQuickMenu(settings: AppLanguageSettings.shared)"),
                      "iPhone 연결 화면의 언어 메뉴")
        XCTAssertTrue(source.contains("if settings.choice != choice { settings.select(choice) }"), "고른 항목을 다시 눌러도 바뀌지 않는다")
    }
}
