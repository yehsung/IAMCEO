import Foundation
import os
#if os(iOS)
import StoreKit
#endif
#if os(macOS)
import AppKit
#endif

/// 앱 화면 언어의 선택(0.2.5 W). 설정 → 일반 → 이 기기 → 언어: 자동 / 한국어 / English.
///
/// 앱의 문구는 묶음의 언어 표(Localizable.xcstrings)를 기기가 고른 언어로 읽는다. 그 언어는 앱 영역의 `AppleLanguages`
/// (UserDefaults)가 정하며, iPhone 설정 → IAMCEO → 언어와 Mac 시스템 설정 → 일반 → 언어 및 지역 → 응용 프로그램도 같은 값을 쓴다.
/// 그래서 이 앱의 선택과 시스템의 '앱별 언어'는 **같은 스위치**다. 어긋날 일이 없게 이렇게 정했다:
/// - 앱에서 고르면 그 값(`["ko"]`·`["en"]`)을 둔다. 시스템 설정의 앱별 언어에도 그대로 보인다.
/// - 시스템 설정에서 바꾸면(앱이 마지막으로 둔 값과 다르면) **시스템 쪽이 이긴다**: 다음 실행에서 그 언어를 앱의 선택으로 받아들인다.
///   시스템에서 '기본'으로 되돌렸으면 '자동'(기기 언어)이 된다. 가장 나중에 대표가 한 동작이 이기는 규칙이다.
/// - '자동'의 뜻: App Store 로 받은 iPhone 앱은 App Store 국가(StoreKit `Storefront.countryCode`)가 한국(KOR)이면 한국어, 그 밖이면 영어.
///   Mac 앱(App Store 밖 배포)과 스토어 정보를 얻지 못한 경우는 기기 언어(기기 언어 목록에서 처음 나오는 한국어·영어, 둘 다 없으면 영어).
///   자동은 처음 실행할 때와 대표가 '자동'을 고를 때 한 번 정한다. 무엇을 따르는지(기준: 국가·기기)를 함께 남기고 설정의 안내는 그 기준을 말한다.
///   국가 기준은 그 언어를 앱 영역에 분명히 둔다(기기 언어가 같아도): 국가를 옮기거나 기기 언어를 바꿔도 화면 언어가 저절로 바뀌지 않는다.
///   기기 기준은 아무것도 두지 않아 기기 언어를 계속 따른다(리뷰 lang-2).
///   이 기능 전 판(0.2.4 이하)을 쓰던 기기는 처음 실행이 아니다: 업데이트만으로 지금 보던 언어가 바뀌지 않게 기기 기준의 자동으로 둔다.
/// - 묶음은 실행 중에 언어 표를 바꾸지 못한다. 바꾼 언어는 앱을 다시 열 때 보인다(Mac 은 '지금 다시 열기', iPhone 은 앱을 닫았다가 다시 열기).
///   처음 실행의 '자동'은 문구를 읽기 전에(`AppLanguageLaunch.prepare`, 앱의 진입점) 정해 그 실행부터 보인다.
/// - 서버 설정의 '보고 언어'(총괄·팀장이 쓰는 글)와는 별개다. 이 값은 이 기기에만 있고 서버로 가지 않는다.
enum AppLanguageChoice: String, CaseIterable, Identifiable, Sendable {
    case auto, ko, en
    var id: String { rawValue }
}

/// '자동'이 무엇을 따르는가. 국가: App Store 국가의 언어를 앱 영역에 둔다. 기기: 아무것도 두지 않아 기기 언어를 따른다.
enum AppLanguageBasis: String, Sendable { case store, device }

/// 언어를 정하는 데 쓰는 이 기기의 저장 값.
struct AppLanguageState: Equatable, Sendable {
    /// 고른 것. nil = 처음 실행(아직 정하지 않음).
    var choice: AppLanguageChoice?
    /// 이 앱이 마지막으로 앱 영역의 `AppleLanguages` 에 둔 값(nil = 두지 않음). 시스템 설정이 바꾼 것을 알아보는 기준이다.
    var written: [String]?
    /// '자동'의 기준(자동일 때만). 설정의 안내가 이 값을 말한다. nil 은 기기 기준으로 본다.
    var basis: AppLanguageBasis? = nil
}

/// 한 번의 결정: 저장할 값, 앱 영역의 `AppleLanguages` 에 둘 값(nil = 지운다), 다음 실행의 화면 언어.
struct AppLanguageDecision: Equatable, Sendable {
    var state: AppLanguageState
    var appleLanguages: [String]?
    /// 시스템 설정(앱별 언어)에서 바꾼 것을 받아들였다.
    var adoptedFromSystem: Bool
    var language: AppLanguage
}

/// 언어 결정 규칙(값만 다루는 순수 함수, 시험이 모든 경우를 확인한다).
enum AppLanguagePolicy {
    /// 언어 태그("ko-KR", "en_US", "en")의 언어. 이 앱이 가진 것(한국어·영어)만.
    static func language(of tag: String?) -> AppLanguage? {
        switch primary(tag) {
        case "ko": .ko
        case "en": .en
        default: nil
        }
    }

    /// 태그의 언어 부분(소문자). "zh-Hant-TW" → "zh".
    static func primary(_ tag: String?) -> String? {
        guard let tag, !tag.isEmpty else { return nil }
        return tag.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map { $0.lowercased() }
    }

    /// 언어 목록에서 묶음이 고를 언어: 처음 나오는 한국어·영어, 둘 다 없으면 영어(묶음의 대체 언어, project.yml `CFBundleDevelopmentRegion: en`).
    static func bundleLanguage(for languages: [String]) -> AppLanguage {
        languages.lazy.compactMap { language(of: $0) }.first ?? .en
    }

    /// App Store 국가(ISO 3166-1 alpha-3, StoreKit)의 기본 언어: 한국은 한국어, 그 밖은 영어.
    static func storeLanguage(_ countryCode: String) -> AppLanguage {
        countryCode.uppercased() == "KOR" ? .ko : .en
    }

    /// '자동'이 앱 영역에 둘 값과 그 기준. 스토어 국가를 알면 그 언어를 분명히 둔다(기기 언어가 같아도: 뒤에 기기 언어를 바꿔도
    /// 화면이 따라 바뀌지 않고, 설정의 'App Store 국가를 따릅니다'와 맞게. 리뷰 lang-2). 모르면 기기 언어를 따른다(아무것도 두지 않는다).
    static func automatic(storefront: String?) -> (languages: [String]?, basis: AppLanguageBasis) {
        guard let storefront, !storefront.isEmpty else { return (nil, .device) }
        return ([storeLanguage(storefront).rawValue], .store)
    }

    /// 앱을 열 때. `appDomain` = 지금 앱 영역의 `AppleLanguages`, `device` = 기기(전역)의 언어 목록(nil = 읽지 못함),
    /// `earlierUse` = 이 기능 전 판을 이 기기에서 쓴 흔적이 있다(앱 영역에 IAMCEO 의 다른 저장 값이 있다).
    static func launch(state: AppLanguageState, appDomain: [String]?, device: [String]?, storefront: String?, earlierUse: Bool = false) -> AppLanguageDecision {
        var state = state
        var adopted = false
        // 앱이 둔 값과 다르면 시스템 설정에서 바꾼 것이다. 가장 나중의 동작이 이긴다.
        if state.choice != nil, primary(appDomain?.first) != primary(state.written?.first) {
            adopted = true
            state.choice = switch language(of: appDomain?.first) { case .ko?: .ko; case .en?: .en; case nil: .auto }
            // 시스템에서 '기본'으로 되돌린 자동은 기기 언어를 따른다.
            state.basis = state.choice == .auto ? .device : nil
            state.written = appDomain
        }
        let target: [String]?
        switch state.choice {
        case nil:
            if let chosen = language(of: appDomain?.first) {
                // 이 판을 처음 열기 전에 시스템 설정에서 앱 언어를 골라 두었다: 그것을 앱의 선택으로.
                adopted = true
                state.choice = chosen == .ko ? .ko : .en
                state.basis = nil
                target = appDomain
            } else if earlierUse {
                // 전 판을 쓰던 기기: 보던 언어(기기 언어)를 그대로 둔다. 국가를 보지 않는다.
                state.choice = .auto
                state.basis = .device
                target = appDomain
            } else {
                // 처음 실행: '자동'을 정한다.
                state.choice = .auto
                let auto = automatic(storefront: storefront)
                target = auto.languages
                state.basis = auto.basis
            }
        case .auto?:
            // 정해 둔 자동(또는 시스템이 둔 값)을 그대로 둔다. 다시 정하지 않는다.
            target = appDomain
        case let fixed?:
            target = primary(appDomain?.first) == fixed.rawValue ? appDomain : [fixed.rawValue]
        }
        state.written = target
        return AppLanguageDecision(state: state, appleLanguages: target, adoptedFromSystem: adopted,
                                   language: bundleLanguage(for: target ?? device ?? []))
    }

    /// 대표가 설정에서 고를 때. '자동'은 이때 다시 정한다(스토어 국가는 앞서 읽어 둔 값).
    static func choose(_ choice: AppLanguageChoice, state: AppLanguageState, appDomain: [String]?, device: [String]?, storefront: String?) -> AppLanguageDecision {
        var state = state
        state.choice = choice
        let target: [String]?
        switch choice {
        case .auto:
            let auto = automatic(storefront: storefront)
            target = auto.languages
            state.basis = auto.basis
        case .ko, .en:
            target = primary(appDomain?.first) == choice.rawValue ? appDomain : [choice.rawValue]
            state.basis = nil
        }
        state.written = target
        return AppLanguageDecision(state: state, appleLanguages: target, adoptedFromSystem: false,
                                   language: bundleLanguage(for: target ?? device ?? []))
    }
}

/// 언어 설정의 저장소. 앱은 UserDefaults.standard(앱 영역)를, 시험은 따로 만든 묶음을 쓴다.
struct AppLanguageDefaults: @unchecked Sendable {
    static let choiceKey = "iamceo.appLanguage.choice"
    static let writtenKey = "iamceo.appLanguage.written"
    static let storefrontKey = "iamceo.appLanguage.storefront"
    static let basisKey = "iamceo.appLanguage.basis"
    static let appleLanguagesKey = "AppleLanguages"

    let defaults: UserDefaults
    /// 앱 영역의 이름(앱은 번들 ID, 시험은 묶음 이름). 이 영역에 저장된 `AppleLanguages` 만 읽는다(실행 인자·전역 값은 빼고).
    let domain: String?
    /// 기기(전역)의 언어 목록. 읽지 못하면 nil.
    let deviceLanguages: @Sendable () -> [String]?

    static var standard: AppLanguageDefaults {
        AppLanguageDefaults(defaults: .standard, domain: Bundle.main.bundleIdentifier, deviceLanguages: {
            UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)?[appleLanguagesKey] as? [String]
        })
    }

    var state: AppLanguageState {
        AppLanguageState(choice: defaults.string(forKey: Self.choiceKey).flatMap(AppLanguageChoice.init(rawValue:)),
                         written: defaults.array(forKey: Self.writtenKey) as? [String],
                         basis: defaults.string(forKey: Self.basisKey).flatMap(AppLanguageBasis.init(rawValue:)))
    }
    var appDomain: [String]? { domain.flatMap { defaults.persistentDomain(forName: $0)?[Self.appleLanguagesKey] as? [String] } }
    var device: [String]? { deviceLanguages() }
    /// 이 기능 전 판의 저장 값(연결 주소, 초안, 화면 위치 등 `iamceo`로 시작하는 열쇠)이 앱 영역에 있다.
    var earlierUse: Bool {
        guard let domain, let values = defaults.persistentDomain(forName: domain) else { return false }
        return values.keys.contains { $0.lowercased().hasPrefix("iamceo") && !$0.hasPrefix("iamceo.appLanguage.") }
    }
    var storefront: String? {
        get { defaults.string(forKey: Self.storefrontKey) }
        nonmutating set { if let newValue, !newValue.isEmpty { defaults.set(newValue, forKey: Self.storefrontKey) } }
    }

    func apply(_ decision: AppLanguageDecision) {
        defaults.set(decision.state.choice?.rawValue, forKey: Self.choiceKey)
        if let written = decision.state.written { defaults.set(written, forKey: Self.writtenKey) } else { defaults.removeObject(forKey: Self.writtenKey) }
        if let basis = decision.state.basis { defaults.set(basis.rawValue, forKey: Self.basisKey) } else { defaults.removeObject(forKey: Self.basisKey) }
        guard decision.appleLanguages != appDomain else { return }
        if let languages = decision.appleLanguages { defaults.set(languages, forKey: Self.appleLanguagesKey) }
        else { defaults.removeObject(forKey: Self.appleLanguagesKey) }
    }
}

/// 앱의 진입점에서 문구를 읽기 전에 부른다(IAMCEOApp.swift 의 `IAMCEOLauncher`).
enum AppLanguageLaunch {
    /// 처음 실행에서 App Store 국가를 기다리는 가장 긴 시간(iPhone). 넘으면 기기 언어로 정한다.
    static let storefrontWait: TimeInterval = 0.8

    static func prepare(store: AppLanguageDefaults = .standard) {
        guard shouldManage else { return }
        var storefront = store.storefront
        #if os(iOS)
        if store.state.choice == nil, storefront == nil, !store.earlierUse {
            storefront = StorefrontCountry.now(timeout: storefrontWait)
            store.storefront = storefront
        }
        #else
        // Mac 앱은 App Store 밖에서 배포한다: 자동은 기기 언어다.
        storefront = nil
        #endif
        let decision = AppLanguagePolicy.launch(state: store.state, appDomain: store.appDomain, device: store.device, storefront: storefront,
                                                earlierUse: store.earlierUse)
        store.apply(decision)
        #if os(iOS)
        // 다음에 '자동'을 고를 때 쓸 국가를 새로 받아 둔다(화면 언어는 바꾸지 않는다).
        StorefrontCountry.refresh(into: store)
        #endif
    }

    /// 시험(시험 앱)과, 실행 인자로 언어를 정한 실행(`-AppleLanguages (en)`, 화면 견본)은 저장된 선택을 건드리지 않는다.
    static var shouldManage: Bool {
        let environment = ProcessInfo.processInfo.environment
        if environment["XCTestConfigurationFilePath"] != nil || environment["XCTestBundlePath"] != nil || NSClassFromString("XCTestCase") != nil { return false }
        return !argumentOverride
    }

    /// 이 실행만의 언어(실행 인자). 그때는 '다시 열면 바뀝니다'를 띄우지 않는다.
    static var argumentOverride: Bool {
        UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)[AppLanguageDefaults.appleLanguagesKey] != nil
    }
}

#if os(iOS)
/// App Store 국가(StoreKit). 기기 안에서만 읽고 어디에도 보내지 않는다.
enum StorefrontCountry {
    /// 처음 실행에서만: 화면을 그리기 전에 잠깐(최대 `timeout`) 기다린다. 못 얻으면 nil.
    static func now(timeout: TimeInterval) -> String? {
        let result = OSAllocatedUnfairLock<String?>(initialState: nil)
        let done = DispatchSemaphore(value: 0)
        Task.detached(priority: .userInitiated) {
            let code = await Storefront.current?.countryCode
            result.withLock { $0 = code }
            done.signal()
        }
        _ = done.wait(timeout: .now() + timeout)
        return result.withLock { $0 }
    }

    static func refresh(into store: AppLanguageDefaults) {
        Task.detached(priority: .utility) {
            if let code = await Storefront.current?.countryCode { store.storefront = code }
        }
    }
}
#endif

/// 설정 화면의 '언어' 줄이 읽는 상태.
@MainActor @Observable
final class AppLanguageSettings {
    static let shared = AppLanguageSettings()

    private(set) var choice: AppLanguageChoice
    /// '자동'의 기준(설정의 안내가 말한다).
    private(set) var basis: AppLanguageBasis?
    /// 다음에 앱을 열 때 보일 언어.
    private(set) var next: AppLanguage
    /// 지금 화면의 언어(묶음이 이번 실행에 고른 표).
    let current: AppLanguage
    @ObservationIgnored private let store: AppLanguageDefaults
    @ObservationIgnored private let argumentOverride: Bool

    init(store: AppLanguageDefaults = .standard, current: AppLanguage = .current, argumentOverride: Bool = AppLanguageLaunch.argumentOverride) {
        self.store = store
        self.current = current
        self.argumentOverride = argumentOverride
        choice = store.state.choice ?? .auto
        basis = store.state.basis
        let appDomain = store.appDomain
        next = argumentOverride ? current : AppLanguagePolicy.bundleLanguage(for: appDomain ?? store.device ?? Locale.preferredLanguages)
    }

    /// '자동'이 App Store 국가를 따르는가(그 기준으로 정한 자동일 때만). 아니면 기기 언어를 따른다(리뷰 lang-2: 국가를 읽어 두기만
    /// 하고 쓰지 않은 자동 — 전 판에서 올린 기기, 처음 실행에서 국가를 제때 못 읽음, 시스템에서 '기본'으로 되돌림 — 에 국가 안내를 하지 않는다).
    var automaticFollowsStore: Bool { basis == .store }

    /// 바꾼 언어가 아직 화면에 보이지 않는다(다시 열어야 한다).
    var needsRelaunch: Bool { !argumentOverride && next != current }

    func select(_ choice: AppLanguageChoice) {
        // '자동'을 고르면 iPhone 은 앞서 읽어 둔 App Store 국가로, Mac 은 기기 언어로 정한다.
        #if os(iOS)
        let storefront = store.storefront
        #else
        let storefront: String? = nil
        #endif
        let decision = AppLanguagePolicy.choose(choice, state: store.state, appDomain: store.appDomain, device: store.device,
                                                storefront: storefront)
        store.apply(decision)
        self.choice = choice
        basis = decision.state.basis
        if !argumentOverride { next = decision.language }
    }
}

extension AppLanguage {
    /// 문장 안에 넣는 언어 이름(그 화면의 언어로: 한국어 화면 "한국어"·"English", 영어 화면 "Korean"·"English").
    var displayName: String {
        switch self {
        case .ko: String(localized: "language.name.ko", defaultValue: "한국어")
        case .en: "English"
        }
    }
}

#if os(macOS)
/// 언어를 바꾼 뒤 Mac 앱을 다시 연다. 이 앱이 끝나기를(최대 30초) 기다렸다가 같은 앱을 연다. 종료가 취소되면 열지 않는다.
/// 서버는 로그인 서비스라 앱을 닫아도 그대로 돈다.
enum AppRelaunch {
    @MainActor static func relaunch() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", script, "iamceo-relaunch", String(ProcessInfo.processInfo.processIdentifier), Bundle.main.bundleURL.path]
        do { try process.run() } catch { return }
        NSApp.terminate(nil)
    }

    /// $1 = 이 앱의 pid, $2 = 앱 경로. 0.2초마다 150번(30초)까지 기다린다.
    static let script = #"i=0; while /bin/kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ "$i" -gt 150 ] && exit 0; /bin/sleep 0.2; done; /usr/bin/open "$2""#
}
#endif
