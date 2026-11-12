import Foundation
import Observation

/// D6: Mac 앱의 새 버전 알림(알리기만 한다. 받거나 설치하지 않는다).
/// 하루 한 번 GitHub 의 최신 릴리스(초안·미리보기 제외)를 묻고, 이 앱보다 새 버전이면 설정에 '새 버전' 한 줄을 띄운다.
/// 보내는 것은 요청 자체(IP 주소, 'IAMCEO-Mac' 사용자 에이전트)뿐이다. 계정·프로젝트·대화는 보내지 않는다(PRIVACY.md).
@MainActor @Observable
final class UpdateChecker {
    static let shared = UpdateChecker()

    nonisolated static let repository = "yehsung/IAMCEO"
    nonisolated static let latestURL = URL(string: "https://api.github.com/repos/\(repository)/releases/latest")!
    /// 한 번 확인하면 이만큼 다시 묻지 않는다.
    static let interval: TimeInterval = 24 * 60 * 60
    /// 확인이 실패하면 이만큼 뒤에 다시 해 본다.
    static let retryAfterFailure: TimeInterval = 60 * 60

    enum State: Equatable, Sendable {
        /// 아직 확인하지 않았거나, 이 앱의 버전을 견줄 수 없다(개발 빌드).
        case unknown
        /// 이 앱이 최신이다.
        case current
        /// 새 버전이 있다. page 는 그 릴리스의 GitHub 페이지.
        case available(version: String, page: URL)
    }

    typealias Fetch = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private(set) var state: State = .unknown
    /// 마지막으로 확인에 성공한 때.
    private(set) var checkedAt: Date?
    private(set) var isChecking = false

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let appVersion: String
    @ObservationIgnored private let fetch: Fetch
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var lastFailureAt: Date?
    @ObservationIgnored private var loop: Task<Void, Never>?

    private static let checkedAtKey = "IAMCEO.updateCheck.checkedAt"
    private static let latestTagKey = "IAMCEO.updateCheck.latestTag"

    init(defaults: UserDefaults = .standard, appVersion: String = AppVersion.version, fetch: Fetch? = nil,
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.defaults = defaults
        self.appVersion = appVersion
        self.fetch = fetch ?? Self.liveFetch
        self.now = now
        let stamp = defaults.double(forKey: Self.checkedAtKey)
        checkedAt = stamp > 0 ? Date(timeIntervalSince1970: stamp) : nil
        // 한 번도 확인하지 않았으면 모른다. 앱을 올린 뒤에는 저장해 둔 '새 버전'이 지금 앱보다 새것이 아니므로 저절로 사라진다.
        state = checkedAt == nil ? .unknown : Self.state(latestTag: defaults.string(forKey: Self.latestTagKey), appVersion: appVersion)
    }

    /// Mac 앱이 떠 있는 동안 한 시간마다 '확인할 때가 됐는지'만 본다. 여러 창이 불러도 한 번만 돈다.
    func start() {
        #if os(macOS)
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.checkIfDue()
                do { try await Task.sleep(for: .seconds(60 * 60)) } catch { return }
            }
        }
        #endif
    }

    var isDue: Bool {
        let current = now()
        if let lastFailureAt, current.timeIntervalSince(lastFailureAt) < Self.retryAfterFailure { return false }
        guard let checkedAt else { return true }
        // 시계를 되돌린 경우도 다시 확인한다.
        return current.timeIntervalSince(checkedAt) >= Self.interval || current < checkedAt
    }

    func checkIfDue() async {
        guard isDue else { return }
        await check()
    }

    /// 지금 확인한다. 실패하면 알던 상태를 그대로 두고 한 시간 뒤에 다시 해 본다.
    func check() async {
        guard !isChecking else { return }
        // 개발 빌드는 견줄 버전이 없어 묻지 않는다.
        guard ReleaseVersion(appVersion) != nil else { state = .unknown; return }
        isChecking = true
        defer { isChecking = false }
        var request = URLRequest(url: Self.latestURL)
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        request.setValue("IAMCEO-Mac", forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await fetch(request)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            let tag: String?
            switch http.statusCode {
            case 200:
                guard let found = Self.latestTag(from: data) else { throw URLError(.cannotParseResponse) }
                tag = found
            case 404: tag = nil // 공개한 릴리스가 아직 없다.
            default: throw URLError(.badServerResponse)
            }
            let at = now()
            checkedAt = at; lastFailureAt = nil
            defaults.set(at.timeIntervalSince1970, forKey: Self.checkedAtKey)
            if let tag { defaults.set(tag, forKey: Self.latestTagKey) } else { defaults.removeObject(forKey: Self.latestTagKey) }
            state = Self.state(latestTag: tag, appVersion: appVersion)
        } catch {
            lastFailureAt = now()
        }
    }

    /// GitHub 응답에서 공개된 정식 릴리스의 태그만 꺼낸다(초안·미리보기·모양이 다른 태그는 버린다).
    nonisolated static func latestTag(from data: Data) -> String? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let tag = object["tag_name"] as? String, ReleaseVersion(tag) != nil,
              object["draft"] as? Bool != true, object["prerelease"] as? Bool != true else { return nil }
        return tag
    }

    nonisolated static func state(latestTag: String?, appVersion: String) -> State {
        guard let app = ReleaseVersion(appVersion) else { return .unknown }
        guard let latestTag, let latest = ReleaseVersion(latestTag) else { return .current }
        guard app < latest else { return .current }
        return .available(version: latest.description, page: releasePage(tag: latestTag))
    }

    /// 릴리스 페이지 주소는 응답의 주소를 믿지 않고, 확인한 태그로 직접 만든다.
    nonisolated static func releasePage(tag: String) -> URL {
        URL(string: "https://github.com/\(repository)/releases/tag/\(tag)")!
    }

    private static let liveFetch: Fetch = { request in
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForResource = 30
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        return try await session.data(for: request)
    }
}
