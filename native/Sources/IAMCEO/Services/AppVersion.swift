import Foundation

/// D5: 이 앱의 버전과 API 단계. 모든 요청에 머리글로 실어 서버가 어긋남을 알게 한다(묶음 사이 약속 4).
/// 머리글이 없는 출시 앱(0.2.2·0.2.3)에는 서버가 새 필드를 싣지 않는다.
enum AppVersion {
    /// 이 앱이 기대는 서버 계약 단계. 서버의 API_LEVEL(shared/types.ts)과 같은 수로 시작하고,
    /// 앱이 새 서버 동작에 **기대게 될 때만** 서버와 함께 올린다. 선택 필드처럼 옛 서버에서도 도는 변경은 올리지 않는다.
    static let apiLevel = 1

    static let versionHeader = "X-IAMCEO-App-Version"
    static let buildHeader = "X-IAMCEO-App-Build"
    static let platformHeader = "X-IAMCEO-App-Platform"
    static let apiLevelHeader = "X-IAMCEO-Api-Level"

    #if os(macOS)
    static let platform = "macos"
    #else
    static let platform = "ios"
    #endif

    /// 이 앱 번들의 버전(CFBundleShortVersionString). 앱 번들이 아닌 실행(SwiftPM 시험 등)은 "dev".
    static let version: String = info("CFBundleShortVersionString") ?? "dev"
    /// 빌드 번호(CFBundleVersion). 없으면 nil.
    static let build: String? = info("CFBundleVersion")

    private static let bundleIDs: Set<String> = ["com.iamceo.native.mac", "com.yehsung.iamceo"]
    private static func info(_ key: String) -> String? {
        // 시험 실행기(xctest)의 번들 버전을 이 앱의 버전으로 보내지 않는다.
        guard let id = Bundle.main.bundleIdentifier, bundleIDs.contains(id),
              let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...32).contains(trimmed.count), trimmed.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || ".+-".contains($0)) }) else { return nil }
        return trimmed
    }

    /// 요청에 붙일 머리글. 서버 주소·접속 코드와 무관한 값만 싣는다.
    static func headers(version: String = AppVersion.version, build: String? = AppVersion.build, platform: String = AppVersion.platform,
                        apiLevel: Int = AppVersion.apiLevel) -> [(String, String)] {
        var result = [(versionHeader, version), (platformHeader, platform), (apiLevelHeader, String(apiLevel))]
        if let build { result.append((buildHeader, build)) }
        return result
    }
    static func apply(to request: inout URLRequest) {
        for (name, value) in headers() { request.setValue(value, forHTTPHeaderField: name) }
    }
}

/// 서버가 버전 머리글을 받은 앱에만 싣는 자기 버전과 API 단계. 옛 서버는 싣지 않는다.
struct ServerVersionInfo: Codable, Sendable, Equatable {
    var version: String
    var apiLevel: Int
}

/// 서버가 '앱과 실제로 맞지 않을 때만' 싣는 안내. state 는 이 앱이 모르는 값이 와도 읽히게 글자로 둔다.
struct CompatState: Codable, Sendable, Equatable {
    var state: String
    var message: String = ""
}
extension CompatState {
    private enum CodingKeys: String, CodingKey { case state, message }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(String.self, forKey: .state)
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? ""
    }
}

/// 상태 띠의 어긋남 안내 한 줄. 앱과 서버가 실제로 안 맞을 때만 생긴다(업데이트 피로를 막는다).
struct CompatNotice: Sendable, Equatable {
    enum Kind: Sendable, Equatable { case appOutdated, serverOutdated, other }
    let kind: Kind
    let text: String

    /// - onThisMac: 서버가 이 Mac 에서 돈다(Mac 앱이 127.0.0.1 로 붙었다).
    /// - appLevel·platform: 시험에서만 바꾼다.
    init?(_ bootstrap: Bootstrap?, onThisMac: Bool, appLevel: Int = AppVersion.apiLevel, platform: String = AppVersion.platform) {
        guard let bootstrap else { return nil }
        let server = bootstrap.server?.version ?? (bootstrap.version.isEmpty ? nil : bootstrap.version)
        if let compat = bootstrap.compat {
            switch compat.state {
            case "app_outdated": kind = .appOutdated; text = Self.appOutdated(platform: platform)
            case "server_outdated": kind = .serverOutdated; text = Self.serverOutdated(server, onThisMac: onThisMac)
            default:
                // 이 앱이 모르는 새 종류: 서버가 쓴 문장을 그대로 보인다. 문장이 없으면 조용히 둔다.
                let message = compat.message.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !message.isEmpty else { return nil }
                kind = .other; text = message
            }
            return
        }
        // 버전 머리글을 모르는 옛 서버(server 칸이 없다)는 1단계다. 이 앱이 그보다 높은 단계를 기대할 때만 알린다.
        guard bootstrap.server == nil, appLevel > 1 else { return nil }
        kind = .serverOutdated; text = Self.serverOutdated(server, onThisMac: onThisMac)
    }

    static func appOutdated(platform: String) -> String {
        platform == "ios"
            ? String(localized: "이 앱이 서버보다 오래된 버전이라 맞지 않습니다. App Store에서 IAMCEO를 업데이트해 주세요.")
            : String(localized: "이 앱이 서버보다 오래된 버전이라 맞지 않습니다. IAMCEO를 최신 버전으로 업데이트해 주세요.")
    }
    static func serverOutdated(_ version: String?, onThisMac: Bool) -> String {
        // 영어 문장은 "server (0.2.3)" 처럼 띄어 쓴다. 한국어는 예전 그대로 붙여 쓴다("서버(0.2.3)가").
        let named = version.map { AppLanguage.current == .en ? " (\($0))" : "(\($0))" } ?? ""
        return onThisMac
            ? String(localized: "이 Mac의 서버\(named)가 앱보다 오래된 버전이라 맞지 않습니다. 서버를 새 버전으로 다시 시작하거나 업데이트해 주세요.")
            : String(localized: "Mac의 서버\(named)가 이 앱보다 오래된 버전이라 맞지 않습니다. 서버가 도는 Mac에서 IAMCEO를 업데이트해 주세요.")
    }
}

/// 출시 버전 번호(주.부.수). 이 모양이 아닌 버전(개발 빌드·미리보기)은 견주지 않는다.
struct ReleaseVersion: Comparable, Sendable, CustomStringConvertible {
    let parts: [Int]
    init?(_ text: String) {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("v") { value.removeFirst() }
        let pieces = value.split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count == 3 else { return nil }
        var parts: [Int] = []
        for piece in pieces {
            guard (1...6).contains(piece.count), piece.allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(piece) else { return nil }
            parts.append(number)
        }
        self.parts = parts
    }
    static func < (lhs: ReleaseVersion, rhs: ReleaseVersion) -> Bool { lhs.parts.lexicographicallyPrecedes(rhs.parts) }
    var description: String { parts.map(String.init).joined(separator: ".") }
}
