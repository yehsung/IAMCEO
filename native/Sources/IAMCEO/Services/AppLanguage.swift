import Foundation
import os

/// 앱 화면의 언어(완성도 4차 R, B2).
///
/// 문구는 `Resources/Shared/Localizable.xcstrings` 에 있다. **한국어 원문이 그대로 열쇠**이고 영어는 번역이다.
/// 한국어 기기는 영어 표를 읽지 않으므로 열쇠(원문)가 그대로 나온다. 시험(Swift 패키지·iPhone 시험 앱)에는 문구 표가 없어 역시 원문이다.
/// 그래서 한국어 화면은 바꾸기 전과 글자 하나 다르지 않다(KoreanTextFreezeTests 가 지킨다).
///
/// 화면 문구 말고 언어에 따라 갈라야 하는 것(조사, 날짜 형식, 서버 오류 코드의 영어 문장)은 이 값을 본다.
/// 이 값은 문구 표가 실제로 고른 언어를 따른다: 표지 열쇠 `app.language` 는 영어 표에만 "en" 으로 있다.
enum AppLanguage: String, Sendable {
    case ko, en

    static var current: AppLanguage { overrideLock.withLock { $0 } ?? resolved }

    private static let resolved: AppLanguage =
        Bundle.main.localizedString(forKey: "app.language", value: "ko", table: nil) == "en" ? .en : .ko

    private static let overrideLock = OSAllocatedUnfairLock<AppLanguage?>(initialState: nil)

    /// 시험 전용: 영어 화면의 조사·날짜·오류 문장을 확인할 때만 쓴다. 화면 문구(String(localized:))는 바꾸지 않는다.
    static func withOverride<T>(_ language: AppLanguage, _ body: () throws -> T) rethrows -> T {
        let previous = overrideLock.withLock { state -> AppLanguage? in
            let old = state; state = language; return old
        }
        defer { overrideLock.withLock { $0 = previous } }
        return try body()
    }

    /// 시험 전용: 위와 같되 기다리는 일(서버 응답을 받아 문장을 만드는 흐름)을 영어 화면으로 돌린다.
    @MainActor static func withOverrideAsync<T>(_ language: AppLanguage, _ body: @MainActor () async throws -> T) async rethrows -> T {
        let previous = overrideLock.withLock { state -> AppLanguage? in
            let old = state; state = language; return old
        }
        defer { overrideLock.withLock { $0 = previous } }
        return try await body()
    }

    /// 영어 날짜·시각의 로케일: 영어 달 이름에 기기의 지역 관례(12/24시간 등)를 붙인다.
    var dateLocale: Locale {
        switch self {
        case .ko: Locale(identifier: "ko_KR")
        case .en: Locale(identifier: "en_" + (Locale.autoupdatingCurrent.region?.identifier ?? "US"))
        }
    }
}

// MARK: - 날짜

/// 날짜 글자. 한국어는 예전의 고정 형식(ko_KR, 예: "11월 4일")을 그대로 쓰고, 영어는 템플릿을 기기 지역에 맞춰 푼다(예: "Nov 4").
func appFormatted(_ date: Date, ko format: String, en template: String) -> String {
    switch AppLanguage.current {
    case .ko: koFormatted(date, format)
    case .en: ISODateCache.shared.english(date, template: template)
    }
}

// MARK: - 조사

/// 영어에는 조사가 없다. 한국어 조사 함수는 영어 화면에서 빈 글자를 돌려준다(번역문은 그 자리를 빈 채로 둔다).
var appUsesParticles: Bool { AppLanguage.current == .ko }

/// `friendlyLoadError(what:verb:)` 의 동사 조각("받지", "읽지" …)을 영어 화면의 동사로. 모르는 한국어 조각은 "load".
func loadErrorVerb(_ verb: String) -> String {
    guard AppLanguage.current == .en else { return verb }
    switch verb {
    case "받지": return "download"
    case "읽지": return "read"
    case "올리지": return "upload"
    case "확인하지": return "check"
    case "저장하지": return "save"
    case "정리하지": return "clear"
    case "띄우지": return "show"
    case "준비하지": return "prepare"
    case "검색하지": return "search"
    case "되돌리지": return "restore"
    case "불러오지": return "load"
    case "바꾸지": return "change"
    case "열지": return "open"
    default: return verb.range(of: #"\p{Hangul}"#, options: .regularExpression) == nil ? verb : "load"
    }
}

/// `friendlyLoadError(what:)` 의 명사 조각("첨부", "자료" …)을 영어 화면의 명사로(문장 가운데에 들어가 소문자로 시작한다).
/// 같은 한국어 낱말이 단추 이름으로도 쓰여 문구 표에 넣지 않고 여기서 고른다. 모르는 한국어 조각은 "item".
func loadErrorNoun(_ what: String) -> String {
    guard AppLanguage.current == .en else { return what }
    switch what {
    case "첨부": return "attachment"
    case "파일", "자료": return "file"
    case "저장소": return "repository"
    case "폴더": return "folder"
    case "대화": return "conversation"
    case "Mac 연결": return "Mac connection"
    case "이 Mac의 연결": return "connection to this Mac"
    case "원본": return "original"
    case "글": return "message"
    case "Mac 알림": return "Mac notification"
    case "Mac 알림 설정": return "Mac notification settings"
    case "이전 서버 알림 설정": return "notification settings on the previous server"
    case "알림의 프로젝트": return "project for this notification"
    case "활동": return "activity"
    case "프로젝트 상태": return "project status"
    case "페이지": return "page"
    case "팀장 만들기 결과": return "result of adding the staff member"
    case "승인 창": return "approval prompt"
    case "초안": return "draft"
    case "이전 전송": return "earlier send"
    case "지난 결재": return "past decisions"
    case "입력": return "input"
    case "화면": return "screen"
    default: return what.range(of: #"\p{Hangul}"#, options: .regularExpression) == nil ? what : "item"
    }
}

// MARK: - 서버가 정한 값의 표시 이름

/// 대화 글의 종류(shared/types.ts MessageKind)는 서버와 앱이 판정에 쓰는 한국어 상수다. 값은 그대로 두고 보이는 이름만 고른다.
/// 모르는 종류는 받은 그대로 보인다. 같은 한국어가 다른 뜻으로도 쓰여(알림 = 설정의 '알림' 탭 등) 열쇠를 따로 둔다.
func messageKindLabel(_ kind: String) -> String {
    switch kind {
    case "완료": String(localized: "message.kind.done", defaultValue: "완료")
    case "진행": String(localized: "message.kind.progress", defaultValue: "진행")
    case "질문": String(localized: "message.kind.question", defaultValue: "질문")
    case "막힘": String(localized: "message.kind.blocked", defaultValue: "막힘")
    case "알림": String(localized: "message.kind.notice", defaultValue: "알림")
    case "답변": String(localized: "message.kind.answer", defaultValue: "답변")
    case "지시": String(localized: "message.kind.instruction", defaultValue: "지시")
    case "직접": String(localized: "message.kind.direct", defaultValue: "직접")
    case "나": String(localized: "message.kind.me", defaultValue: "나")
    case "시스템": String(localized: "message.kind.system", defaultValue: "시스템")
    default: kind
    }
}
