import Foundation

/// 0.2.6 Y: 서버가 만든 글(대화의 시스템 글·서버가 만드는 결재 카드·팀장 활동 줄)을 화면 언어로.
///
/// 서버는 글을 만들 때의 '보고 언어'로 문장을 저장하고, 함께 코드·값(`textCode`/`textParams`)과 그린 언어(`textLang`)를 보낸다
/// (shared/server-text.ts). 서버는 코드로 다시 그린 문장이 저장된 문장과 같을 때만 코드를 싣는다.
///
/// - 화면 언어가 textLang 과 같으면 받은 문장 그대로다. 그래서 보고 언어 한국어 + 한국어 화면은 바꾸기 전과 글자 하나 다르지 않다.
/// - 다르면 코드의 틀(ServerTextCatalog: 영어는 문구 표 server.text.*, 한국어는 기본값)로 다시 그린다.
/// - 모르는 코드·빠진 값·모르는 언어면 받은 문장 그대로다(뜻을 지어내지 않는다).
///
/// 틀 문법: `{이름}` 은 값, 한국어 틀의 `{이름:이}`·`{이름:을}`·`{이름:은}`·`{이름:으로}` 는 값 뒤 조사. 값은 글자, 다른 코드, 시각(`{"at": ISO}`),
/// 언어별 글자(`{"ko": …, "en": …}`: 서버가 두 언어로 따로 만든 값. 도구 승인 카드의 대상처럼 '…(N자 더 있음)' 같은 붙임말이 든 값).
indirect enum ServerTextParam: Codable, Sendable, Equatable {
    case text(String)
    case ref(ServerTextRef)
    case date(String)
    case langs(ko: String, en: String)

    private enum Keys: String, CodingKey { case code, params, at, ko, en }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let value = try? single.decode(String.self) { self = .text(value); return }
        let c = try decoder.container(keyedBy: Keys.self)
        if let at = try c.decodeIfPresent(String.self, forKey: .at) { self = .date(at); return }
        if !c.contains(.code), let ko = try c.decodeIfPresent(String.self, forKey: .ko), let en = try c.decodeIfPresent(String.self, forKey: .en) {
            self = .langs(ko: ko, en: en); return
        }
        self = .ref(try ServerTextRef(from: decoder))
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .text(let value): var c = encoder.singleValueContainer(); try c.encode(value)
        case .ref(let ref): try ref.encode(to: encoder)
        case .date(let at): var c = encoder.container(keyedBy: Keys.self); try c.encode(at, forKey: .at)
        case .langs(let ko, let en): var c = encoder.container(keyedBy: Keys.self); try c.encode(ko, forKey: .ko); try c.encode(en, forKey: .en)
        }
    }
}

struct ServerTextRef: Codable, Sendable, Equatable {
    var code: String
    var params: [String: ServerTextParam]? = nil
}

enum ServerText {
    /// 시험 전용: 언어별 틀을 문구 표 파일에서 읽어 넣는다(시험 앱에는 문구 표가 없어 String(localized:) 가 늘 한국어다).
    nonisolated(unsafe) static var templateOverride: ((String, AppLanguage) -> String?)? = nil

    static func template(_ code: String, language: AppLanguage) -> String? {
        if let templateOverride { return templateOverride(code, language) }
        return ServerTextCatalog.template(code)
    }

    /// 코드와 값을 그 언어의 문장으로. 모르는 코드나 빠진 값이 있으면 nil.
    static func render(_ ref: ServerTextRef, language: AppLanguage = AppLanguage.current) -> String? {
        render(ref, language: language, depth: 0)
    }

    private static func render(_ ref: ServerTextRef, language: AppLanguage, depth: Int) -> String? {
        guard depth < 5, let template = template(ref.code, language: language) else { return nil }
        var out = ""
        var rest = Substring(template)
        while let open = rest.firstIndex(of: "{") {
            out += rest[..<open]
            guard let close = rest[open...].firstIndex(of: "}") else { out += rest[open...]; return out }
            let inside = rest[rest.index(after: open)..<close]
            let parts = inside.split(separator: ":", maxSplits: 1).map(String.init)
            guard let name = parts.first, isParamName(name) else {
                out += rest[open...close]; rest = rest[rest.index(after: close)...]; continue
            }
            guard let value = paramText(ref.params?[name], language: language, depth: depth) else { return nil }
            if parts.count == 2, language == .ko {
                out += value + (parts[1] == "으로" ? particleRo(value) : josa(value, parts[1]))
            } else {
                out += value
            }
            rest = rest[rest.index(after: close)...]
        }
        return out + rest
    }

    private static func isParamName(_ name: String) -> Bool {
        guard let first = name.unicodeScalars.first, CharacterSet.letters.contains(first), first.isASCII else { return false }
        return name.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_") }
    }

    private static func paramText(_ param: ServerTextParam?, language: AppLanguage, depth: Int) -> String? {
        switch param {
        case .text(let value)?: value
        case .ref(let ref)?: render(ref, language: language, depth: depth + 1)
        case .date(let at)?: dateText(at, language: language)
        case .langs(let ko, let en)?: language == .en ? en : ko
        case nil: nil
        }
    }

    /// 사용 한도가 풀리는 때. 한국어는 서버와 같은 '11월 14일 오후 3시 30분', 영어는 'Nov 14, 3:30 PM'(기기 지역 관례).
    static func dateText(_ at: String, language: AppLanguage, timeZone: TimeZone = .current) -> String? {
        guard let date = parseISODate(at) else { return nil }
        let formatter = DateFormatter()
        let onTheHour = Calendar(identifier: .gregorian).dateComponents(in: timeZone, from: date).minute == 0
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.locale = language.dateLocale
        if language == .en {
            formatter.setLocalizedDateFormatFromTemplate(onTheHour ? "MMMdj" : "MMMdjmm")
        } else {
            formatter.dateFormat = "M월 d일 a h시" + (onTheHour ? "" : " m분")
        }
        return formatter.string(from: date)
    }

    /// 이름 뒤 조사(이·을·은). 받침이 없거나 한글이 아니면 가·를·는(서버 josaKo 와 같다).
    static func josa(_ word: String, _ withFinal: String) -> String {
        guard let last = word.unicodeScalars.last else { return withFinal == "이" ? "가" : withFinal == "을" ? "를" : "는" }
        let code = Int(last.value) - 0xAC00
        let hasFinal = code >= 0 && code <= 11171 && code % 28 != 0
        if hasFinal { return withFinal }
        switch withFinal { case "이": return "가"; case "을": return "를"; case "은": return "는"; default: return withFinal }
    }

    /// '로'/'으로'(서버 particleRoKo 와 같다).
    static func particleRo(_ word: String) -> String {
        let text = word.trimmingCharacters(in: .whitespaces)
        guard let last = text.unicodeScalars.last else { return "(으)로" }
        let code = Int(last.value) - 0xAC00
        if code >= 0 && code <= 11171 { return code % 28 == 0 || code % 28 == 8 ? "로" : "으로" }
        if (48...57).contains(last.value) { return "036".unicodeScalars.contains(last) ? "으로" : "로" }
        let lower = text.lowercased()
        guard let end = lower.unicodeScalars.last, (97...122).contains(end.value) else { return "(으)로" }
        if lower.hasSuffix("ng") { return "으로" }
        return "mnbckpt".unicodeScalars.contains(end) ? "으로" : "로"
    }

    /// 화면 언어로 다시 그려야 하는가: 서버가 그린 언어(textLang)를 알고 화면 언어와 다를 때만.
    static func needsLocalizing(_ textLang: String?, language: AppLanguage) -> Bool {
        guard let textLang, ["ko", "en"].contains(textLang) else { return false }
        return textLang != language.rawValue
    }

    /// 대화 글·카드의 제목 코드(`<코드>.title`). 그 앱이 모르는 코드면 nil.
    static func titleRef(_ ref: ServerTextRef) -> ServerTextRef? {
        let code = ref.code + ".title"
        let known = templateOverride.map { $0(code, .ko) != nil } ?? (ServerTextCatalog.template(code) != nil)
        return known ? ServerTextRef(code: code, params: ref.params) : nil
    }

    /// 코드 하나로 제목·본문을 함께 그린다. 제목 코드가 없으면 제목은 비어 있어야 한다(아니면 nil: 받은 글 그대로 둔다).
    static func titleAndBody(_ ref: ServerTextRef, title: String, language: AppLanguage) -> (title: String, body: String)? {
        guard let body = render(ref, language: language) else { return nil }
        if let titleRef = titleRef(ref) {
            guard let rendered = render(titleRef, language: language) else { return nil }
            return (rendered, body)
        }
        return title.isEmpty ? ("", body) : nil
    }

    /// 서버가 만든 글의 '보낸 이' 이름(시스템)을 화면 언어로.
    static func systemName(_ who: String) -> String { who == "시스템" ? String(localized: "message.kind.system", defaultValue: "시스템") : who }
}

extension Message {
    /// 서버가 만든 글이면 제목·본문을 화면 언어로 바꿔 둔다(디코딩 때 한 번). 바꿨으면 textLang 도 그 언어로 고친다:
    /// 저장했다 다시 읽어도 두 번 바꾸지 않고, 화면 언어를 바꾸면 코드로 다시 그린다.
    mutating func localizeServerText(language: AppLanguage = AppLanguage.current) {
        who = ServerText.systemName(who)
        guard let textCode, ServerText.needsLocalizing(textLang, language: language),
              let shown = ServerText.titleAndBody(ServerTextRef(code: textCode, params: textParams), title: title, language: language) else { return }
        title = shown.title
        body = shown.body
        textLang = language.rawValue
    }
}

extension Activity {
    mutating func localizeServerText(language: AppLanguage = AppLanguage.current) {
        guard let textCode, ServerText.needsLocalizing(textLang, language: language),
              let shown = ServerText.render(ServerTextRef(code: textCode, params: textParams), language: language) else { return }
        text = shown
        textLang = language.rawValue
    }
}

extension Decision {
    /// 서버가 만든 카드(도구 승인·사용 한도 등)의 제목·본문·선택지 이름·닫힌 이유·다시 연 까닭을 화면 언어로.
    mutating func localizeServerText(language: AppLanguage = AppLanguage.current) {
        who = ServerText.systemName(who)
        closedBy = closedBy.map(ServerText.systemName)
        guard ServerText.needsLocalizing(textLang, language: language) else { return }
        var changed = false
        if let textCode, let shown = ServerText.titleAndBody(ServerTextRef(code: textCode, params: textParams), title: title, language: language) {
            title = shown.title; detail = shown.body; changed = true
        }
        if let optionTexts {
            options = options.map { option in
                guard let refs = optionTexts[option.k], let label = ServerText.render(refs.label, language: language) else { return option }
                var next = option
                next.label = label
                if let desc = refs.desc.flatMap({ ServerText.render($0, language: language) }) { next.desc = desc }
                changed = true
                return next
            }
        }
        if let closeReasonText, let shown = ServerText.render(closeReasonText, language: language) { closeReason = shown; changed = true }
        if let reopenNoteText, let shown = ServerText.render(reopenNoteText, language: language) { reopenNote = shown; changed = true }
        if changed { textLang = language.rawValue }
    }
}

extension MissingReportNotice {
    /// 홈 '결과 보고 누락' 줄의 제목. 서버(0.2.6~)는 이 제목을 코드 없이 한국어 '결과 보고 누락' 한 가지로만 싣는다
    /// (server/store.ts listMissingReportNotices). 그 글이면 서버 글 틀(chat.missing_report.title)로 화면 언어에 맞춰 그린다.
    /// 한국어 화면, 다른 종류, 다른 제목은 받은 그대로다(뜻을 지어내지 않는다).
    func displayTitle(language: AppLanguage = AppLanguage.current) -> String {
        guard language != .ko, kind == "missing_report", title == "결과 보고 누락",
              let shown = ServerText.render(ServerTextRef(code: "chat.missing_report.title"), language: language) else { return title }
        return shown
    }
}

/// 결재 카드 선택지 하나의 이름·설명 코드.
struct ServerOptionTexts: Codable, Sendable, Equatable {
    var label: ServerTextRef
    var desc: ServerTextRef? = nil
}
