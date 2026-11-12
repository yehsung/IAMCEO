import Foundation
import XCTest
@testable import IAMCEO

/// C 묶음(버전): D5 앱 버전 머리글과 어긋남 안내, D6 Mac 새 버전 확인, D1 옛 버전 서버를 새 버전으로 다시 시작.
/// 바깥 네트워크·launchd·실제 서버는 쓰지 않는다. GitHub 응답과 서버 확인은 주입한 가짜다.

private final class FetchLog: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [URLRequest] = []
    var replies: [(Int, String)] = []
    func next(_ request: URLRequest) -> (Int, String) {
        lock.withLock {
            stored.append(request)
            return replies.isEmpty ? (500, "{}") : replies.removeFirst()
        }
    }
    var requests: [URLRequest] { lock.withLock { stored } }
}

private final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
}

@MainActor final class VersionTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
    private func freshDefaults() -> UserDefaults {
        let name = "IAMCEO.VersionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
        return defaults
    }

    // MARK: D5 머리글

    func testEveryRestAndRealtimeRequestCarriesTheAppVersionHeaders() async throws {
        let network = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(data: Data(#"{"projects":[]}"#.utf8)) }
        let api = network.makeAPIClient()
        let _: Bootstrap = try await api.request("/api/bootstrap")
        let rest = try XCTUnwrap(network.requests.last)
        XCTAssertEqual(rest.value(forHTTPHeaderField: "X-IAMCEO-App-Version"), AppVersion.version)
        XCTAssertEqual(rest.value(forHTTPHeaderField: "X-IAMCEO-App-Platform"), AppVersion.platform)
        XCTAssertEqual(rest.value(forHTTPHeaderField: "X-IAMCEO-Api-Level"), String(AppVersion.apiLevel))
        XCTAssertEqual(rest.value(forHTTPHeaderField: "X-IAMCEO-App-Build"), AppVersion.build)
        // 실시간 연결과, 그 요청을 바탕으로 만드는 첨부 올리기·받기도 같은 머리글을 싣는다.
        let socket = try await api.webSocketRequest()
        XCTAssertEqual(socket.value(forHTTPHeaderField: "X-IAMCEO-Api-Level"), String(AppVersion.apiLevel))
        XCTAssertEqual(socket.value(forHTTPHeaderField: "X-IAMCEO-App-Version"), AppVersion.version)
        await network.close()
    }

    func testHeaderValuesStayInsideTheServersAcceptedShape() {
        #if os(macOS)
        XCTAssertEqual(AppVersion.platform, "macos")
        #else
        XCTAssertEqual(AppVersion.platform, "ios")
        #endif
        // 서버(server/app-version.ts)는 1~32자의 영숫자·.+- 만 받는다. 시험 실행기의 번들 버전을 보내지 않는다.
        let allowed = CharacterSet(charactersIn: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.+-")
        for value in [AppVersion.version] + (AppVersion.build.map { [$0] } ?? []) {
            XCTAssertTrue((1...32).contains(value.count) && value.unicodeScalars.allSatisfy(allowed.contains), value)
        }
        XCTAssertGreaterThanOrEqual(AppVersion.apiLevel, 1)
        let headers = Dictionary(uniqueKeysWithValues: AppVersion.headers(version: "0.2.4", build: nil, platform: "ios", apiLevel: 2))
        XCTAssertEqual(headers, ["X-IAMCEO-App-Version": "0.2.4", "X-IAMCEO-App-Platform": "ios", "X-IAMCEO-Api-Level": "2"])
    }

    // MARK: D5 해석과 안내

    func testBootstrapReadsServerAndCompatLeniently() throws {
        let old = try decode(Bootstrap.self, #"{"projects":[],"version":"0.2.3"}"#)
        XCTAssertNil(old.server, "머리글을 모르는 옛 서버")
        XCTAssertNil(old.compat)
        let new = try decode(Bootstrap.self,
            #"{"projects":[],"version":"0.3.0","server":{"version":"0.3.0","apiLevel":2},"compat":{"state":"app_outdated","message":"앱을 업데이트"}}"#)
        XCTAssertEqual(new.server, ServerVersionInfo(version: "0.3.0", apiLevel: 2))
        XCTAssertEqual(new.compat, CompatState(state: "app_outdated", message: "앱을 업데이트"))
        XCTAssertEqual(try decode(Bootstrap.self, #"{"projects":[],"compat":{"state":"server_outdated"}}"#).compat?.state, "server_outdated")
        // 이 칸이 어긋나도 시작 응답 전체를 버리지 않는다.
        for broken in [#"{"projects":[],"server":"0.3.0","compat":7}"#, #"{"projects":[],"server":{"version":1},"compat":{"message":"x"}}"#] {
            let decoded = try decode(Bootstrap.self, broken)
            XCTAssertNil(decoded.server, broken)
            XCTAssertNil(decoded.compat, broken)
        }
        // 실시간 동기화의 bootstrap 도 같은 해석을 쓴다.
        let snapshot = try decode(SyncSnapshot.self, #"""
        {"protocol":2,"cursor":{"epoch":"e","seq":1},"requestedProjectId":null,"projectStatus":"none","state":null,
         "bootstrap":{"projects":[],"version":"0.2.3","server":{"version":"0.2.3","apiLevel":1},"compat":{"state":"server_outdated","message":"m"}}}
        """#)
        XCTAssertEqual(snapshot.bootstrap.compat?.state, "server_outdated")
    }

    func testCompatNoticeSpeaksOnlyWhenTheyReallyDoNotFit() {
        var bootstrap = Bootstrap()
        bootstrap.version = "0.2.3"
        XCTAssertNil(CompatNotice(nil, onThisMac: true))
        XCTAssertNil(CompatNotice(bootstrap, onThisMac: true), "옛 서버라도 이 앱이 1단계면 맞는다")
        bootstrap.server = ServerVersionInfo(version: "0.2.3", apiLevel: 1)
        XCTAssertNil(CompatNotice(bootstrap, onThisMac: false), "서버가 맞다고 했다")

        bootstrap.compat = CompatState(state: "app_outdated", message: "서버 문장")
        let iphone = CompatNotice(bootstrap, onThisMac: false, platform: "ios")
        XCTAssertEqual(iphone?.kind, .appOutdated)
        XCTAssertTrue(iphone?.text.contains("App Store") == true)
        let mac = CompatNotice(bootstrap, onThisMac: true, platform: "macos")
        XCTAssertEqual(mac?.kind, .appOutdated)
        XCTAssertFalse(mac?.text.contains("App Store") == true)

        bootstrap.compat = CompatState(state: "server_outdated", message: "서버 문장")
        let remote = CompatNotice(bootstrap, onThisMac: false)
        XCTAssertEqual(remote?.kind, .serverOutdated)
        XCTAssertEqual(remote?.text, "Mac의 서버(0.2.3)가 이 앱보다 오래된 버전이라 맞지 않습니다. 서버가 도는 Mac에서 IAMCEO를 업데이트해 주세요.")
        XCTAssertTrue(CompatNotice(bootstrap, onThisMac: true)?.text.hasPrefix("이 Mac의 서버(0.2.3)") == true)

        // 이 앱이 모르는 새 종류는 서버 문장을 그대로, 문장이 없으면 조용히.
        bootstrap.compat = CompatState(state: "something_new", message: " 서버가 쓴 안내 ")
        XCTAssertEqual(CompatNotice(bootstrap, onThisMac: false)?.text, "서버가 쓴 안내")
        bootstrap.compat = CompatState(state: "something_new", message: "")
        XCTAssertNil(CompatNotice(bootstrap, onThisMac: false))

        // 머리글을 모르는 옛 서버(server 칸 없음)와 이 앱이 더 높은 단계를 기대하면, 앱이 스스로 '서버가 옛 버전'을 말한다.
        var legacy = Bootstrap()
        legacy.version = "0.2.3"
        XCTAssertEqual(CompatNotice(legacy, onThisMac: false, appLevel: 2)?.kind, .serverOutdated)
        legacy.server = ServerVersionInfo(version: "0.2.4", apiLevel: 1)
        XCTAssertNil(CompatNotice(legacy, onThisMac: false, appLevel: 2), "머리글을 아는 서버의 판단(compat 없음)을 따른다")
        // 사용자 문구에 영어 약어·내부 용어가 없다.
        for text in [CompatNotice.appOutdated(platform: "ios"), CompatNotice.appOutdated(platform: "macos"),
                     CompatNotice.serverOutdated("0.2.3", onThisMac: true), CompatNotice.serverOutdated(nil, onThisMac: false)] {
            XCTAssertNil(text.range(of: "API|compat|header|level", options: [.regularExpression, .caseInsensitive]), text)
        }
    }

    func testReleaseVersionComparesOnlyReleaseNumbers() {
        XCTAssertLessThan(ReleaseVersion("0.2.3")!, ReleaseVersion("0.2.4")!)
        XCTAssertLessThan(ReleaseVersion("0.2.9")!, ReleaseVersion("v0.10.0")!)
        XCTAssertLessThan(ReleaseVersion("0.9.9")!, ReleaseVersion("1.0.0")!)
        XCTAssertEqual(ReleaseVersion("v0.2.3"), ReleaseVersion("0.2.3"))
        XCTAssertEqual(ReleaseVersion("0.10.0")?.description, "0.10.0")
        for bad in ["dev", "0.2", "0.2.3.4", "0.2.3-beta", "v", "", "0.2.x", "１.0.0"] {
            XCTAssertNil(ReleaseVersion(bad), bad)
        }
        XCTAssertNotNil(ReleaseVersion(" 0.2.3 "), "앞뒤 공백은 다듬는다")
    }

    // MARK: D6 새 버전 확인

    private func checker(_ log: FetchLog, defaults: UserDefaults, app: String = "0.2.4", clock: TestClock) -> UpdateChecker {
        UpdateChecker(defaults: defaults, appVersion: app, fetch: { request in
            let (status, body) = log.next(request)
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }, now: { clock.now })
    }

    func testUpdateCheckAsksGitHubOnceADayAndOffersTheReleasePage() async throws {
        let log = FetchLog(), clock = TestClock(), defaults = freshDefaults()
        log.replies = [(200, #"{"tag_name":"v0.2.5","draft":false,"prerelease":false,"html_url":"https://evil.example/x"}"#)]
        let update = checker(log, defaults: defaults, clock: clock)
        XCTAssertEqual(update.state, .unknown)
        XCTAssertTrue(update.isDue)
        await update.checkIfDue()
        XCTAssertEqual(update.state, .available(version: "0.2.5", page: URL(string: "https://github.com/yehsung/IAMCEO/releases/tag/v0.2.5")!),
                       "응답의 주소가 아니라 확인한 태그로 페이지를 만든다")
        XCTAssertEqual(update.checkedAt, clock.now)
        // 요청은 공개 릴리스 주소 하나. 서버 주소·접속 코드·앱 머리글을 싣지 않는다.
        let request = try XCTUnwrap(log.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://api.github.com/repos/yehsung/IAMCEO/releases/latest")
        XCTAssertEqual(request.value(forHTTPHeaderField: "User-Agent"), "IAMCEO-Mac")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "X-IAMCEO-App-Version"))

        // 하루 안에는 다시 묻지 않는다.
        clock.advance(23 * 60 * 60)
        await update.checkIfDue()
        XCTAssertEqual(log.requests.count, 1)
        clock.advance(60 * 60 + 1)
        log.replies = [(200, #"{"tag_name":"v0.2.4","draft":false,"prerelease":false}"#)]
        await update.checkIfDue()
        XCTAssertEqual(log.requests.count, 2)
        XCTAssertEqual(update.state, .current, "릴리스가 이 앱과 같으면 최신")

        // 다시 띄운 앱은 저장한 결과를 읽고, 하루가 지나기 전에는 묻지 않는다.
        let restarted = checker(log, defaults: defaults, clock: clock)
        XCTAssertEqual(restarted.state, .current)
        XCTAssertFalse(restarted.isDue)
    }

    func testUpdateCheckIgnoresDraftsPreviewsAndFailuresAndClearsAfterTheAppIsUpdated() async {
        let log = FetchLog(), clock = TestClock(), defaults = freshDefaults()
        let update = checker(log, defaults: defaults, clock: clock)
        for body in [#"{"tag_name":"v0.3.0","draft":true}"#, #"{"tag_name":"v0.3.0","prerelease":true}"#, #"{"tag_name":"nightly"}"#, "not json"] {
            log.replies = [(200, body)]
            await update.check()
            XCTAssertEqual(update.state, .unknown, body)
            XCTAssertNil(update.checkedAt, body)
        }
        // 실패하면 한 시간 동안은 다시 묻지 않는다.
        log.replies = [(503, "{}")]
        await update.check()
        XCTAssertFalse(update.isDue)
        clock.advance(60 * 60)
        XCTAssertTrue(update.isDue)
        // 공개한 릴리스가 없으면(404) 최신으로 본다.
        log.replies = [(404, #"{"message":"Not Found"}"#)]
        await update.check()
        XCTAssertEqual(update.state, .current)

        // 새 버전을 저장한 뒤 앱을 그 버전으로 올리면 안내가 저절로 사라진다.
        log.replies = [(200, #"{"tag_name":"v0.2.6"}"#)]
        await update.check()
        XCTAssertEqual(update.state, .available(version: "0.2.6", page: UpdateChecker.releasePage(tag: "v0.2.6")))
        XCTAssertEqual(checker(log, defaults: defaults, app: "0.2.6", clock: clock).state, .current)
        XCTAssertEqual(checker(log, defaults: defaults, app: "0.2.5", clock: clock).state,
                       .available(version: "0.2.6", page: UpdateChecker.releasePage(tag: "v0.2.6")))

        // 개발 빌드는 견줄 버전이 없어 묻지 않는다.
        let before = log.requests.count
        let dev = checker(log, defaults: freshDefaults(), app: "dev", clock: clock)
        await dev.check()
        XCTAssertEqual(log.requests.count, before)
        XCTAssertEqual(dev.state, .unknown)
    }

    // MARK: D1 옛 버전 서버 다시 시작

    private let home = URL(fileURLWithPath: "/Users/someone/.iamceo")
    private let daemon = "/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo"
    private func plist(program: [String]? = nil, home: String? = nil) -> [String: Any] {
        var value: [String: Any] = ["Label": "com.iamceo.server", "ProgramArguments": program ?? [daemon, "serve"]]
        if let home { value["EnvironmentVariables"] = ["IAMCEO_HOME": home] }
        return value
    }
    private func offer(endpoint: String = "http://127.0.0.1:7878", port: Int = 7878, plist: [String: Any]?, running: (String, String)? = ("old", "0.2.3"),
                       bundled: (String, String) = ("new", "0.2.4")) -> ServerUpgradeOffer? {
        LocalHostService.upgradeOffer(endpoint: endpoint, configuredPort: port, plist: plist, daemonPath: daemon, dataHome: home, defaultHome: home,
                                      running: running.map { (buildID: $0.0, version: $0.1) }, bundled: (buildID: bundled.0, version: bundled.1))
    }

    func testUpgradeIsOfferedOnlyForTheOlderServerThisAppManages() {
        XCTAssertEqual(offer(plist: plist()), ServerUpgradeOffer(runningVersion: "0.2.3", bundledVersion: "0.2.4", bundledBuildID: "new"))
        XCTAssertNotNil(offer(plist: plist(home: home.path)), "데이터 홈을 적어 둔 서비스")
        XCTAssertNotNil(offer(endpoint: "http://localhost:7878", plist: plist()))
        // git 체크아웃에서 도는 서버(대표 라이브처럼 bun 과 소스 경로로 등록된 서비스)에는 절대 묻지 않는다.
        XCTAssertNil(offer(plist: plist(program: ["/Users/someone/.bun/bin/bun", "/Users/someone/iamceo/bin/iamceo.ts", "serve"])))
        XCTAssertNil(offer(plist: plist(program: [daemon, "service-run"])))
        XCTAssertNil(offer(plist: plist(program: ["/Applications/Other.app/Contents/Resources/runtime/iamceo", "serve"])), "다른 설치의 앱")
        XCTAssertNil(offer(plist: nil), "서비스가 등록되지 않았다")
        XCTAssertNil(offer(plist: ["Label": "com.other", "ProgramArguments": [daemon, "serve"]]))
        XCTAssertNil(offer(plist: plist(home: "/Users/someone/other-home")), "다른 데이터 홈")
        // 이 Mac 의 그 서버에 붙었을 때만.
        XCTAssertNil(offer(endpoint: "http://100.64.0.7:7878", plist: plist()), "Tailscale 주소로 붙은 연결")
        XCTAssertNil(offer(endpoint: "http://127.0.0.1:7979", plist: plist()), "다른 포트의 서버")
        // 실제로 더 낮은 정식 버전일 때만(같거나 높으면 되돌림이 될 수 있다).
        XCTAssertNil(offer(plist: plist(), running: ("new", "0.2.3")), "같은 build")
        XCTAssertNil(offer(plist: plist(), running: ("other", "0.2.4")), "같은 버전의 다른 build")
        XCTAssertNil(offer(plist: plist(), running: ("other", "0.2.5")), "서버가 더 새것")
        XCTAssertNil(offer(plist: plist(), running: ("other", "dev")))
        XCTAssertNil(offer(plist: plist(), running: nil), "서버 상태를 읽지 못했다")
        XCTAssertNil(offer(plist: plist(), bundled: ("new", "dev")))
    }

    func testUpgradeIsAskedOncePerAppBuildAndRestartUsesTheConfirmedOffer() async {
        let defaults = freshDefaults()
        let found = ServerUpgradeOffer(runningVersion: "0.2.3", bundledVersion: "0.2.4", bundledBuildID: "build-a")
        let checks = Box(0)
        let restarts = Box<[(String, ServerUpgradeOffer)]>([])
        let window = UUID(), other = UUID()
        let watch = ServerUpgradeWatch(defaults: defaults, check: { _ in checks.value += 1; return found },
                                       restart: { endpoint, offer in restarts.value.append((endpoint, offer)) })
        // iPhone·다른 Mac 의 서버·연결 전·샘플에는 보지도 않는다.
        await watch.evaluate(endpoint: "http://100.64.0.7:7878", onThisMac: false, connected: true, demo: false, serverVersion: "0.2.3", window: window)
        await watch.evaluate(endpoint: "http://127.0.0.1:7878", onThisMac: true, connected: false, demo: false, serverVersion: "0.2.3", window: window)
        await watch.evaluate(endpoint: "http://127.0.0.1:7878", onThisMac: true, connected: true, demo: true, serverVersion: "0.2.3", window: window)
        XCTAssertEqual(checks.value, 0)

        await watch.evaluate(endpoint: "http://127.0.0.1:7878", onThisMac: true, connected: true, demo: false, serverVersion: "0.2.3", window: window)
        XCTAssertEqual(watch.offer, found)
        XCTAssertEqual(watch.prompt?.offer, found)
        XCTAssertEqual(watch.prompt?.window, window, "먼저 본 창이 묻는다")
        // 같은 연결은 다시 보지 않고, 다른 창이 불러도 두 번 묻지 않는다.
        await watch.evaluate(endpoint: "http://127.0.0.1:7878", onThisMac: true, connected: true, demo: false, serverVersion: "0.2.3", window: other)
        XCTAssertEqual(checks.value, 1)
        XCTAssertEqual(watch.prompt?.window, window)
        watch.dismissPrompt()
        XCTAssertNil(watch.prompt)
        XCTAssertEqual(watch.offer, found, "'나중에' 뒤에도 설정 줄은 남는다")

        // 앱을 다시 띄워도 같은 앱 빌드에는 묻지 않는다. 새 앱 빌드에는 다시 한 번 묻는다.
        let again = ServerUpgradeWatch(defaults: defaults, check: { _ in found }, restart: { _, _ in })
        await again.evaluate(endpoint: "http://127.0.0.1:7878", onThisMac: true, connected: true, demo: false, serverVersion: "0.2.3", window: window)
        XCTAssertEqual(again.offer, found)
        XCTAssertNil(again.prompt)
        let newer = ServerUpgradeOffer(runningVersion: "0.2.3", bundledVersion: "0.2.5", bundledBuildID: "build-b")
        let later = ServerUpgradeWatch(defaults: defaults, check: { _ in newer }, restart: { _, _ in })
        await later.evaluate(endpoint: "http://127.0.0.1:7878", onThisMac: true, connected: true, demo: false, serverVersion: "0.2.3", window: window)
        XCTAssertEqual(later.prompt?.offer, newer)

        // 다시 시작은 확인한 제안과 그 주소로 한 번만.
        await watch.restart(store: nil)
        XCTAssertEqual(restarts.value.count, 1)
        XCTAssertEqual(restarts.value.first?.0, "http://127.0.0.1:7878")
        XCTAssertEqual(restarts.value.first?.1, found)
        XCTAssertNil(watch.offer)
        XCTAssertFalse(watch.isRestarting)
        await watch.restart(store: nil)
        XCTAssertEqual(restarts.value.count, 1, "제안이 없으면 하지 않는다")
        // 새 서버로 바뀌면(버전이 달라지면) 다시 보고, 이제는 제안이 없다.
        checks.value = 0
        let fresh = ServerUpgradeWatch(defaults: defaults, check: { _ in checks.value += 1; return nil }, restart: { _, _ in })
        await fresh.evaluate(endpoint: "http://127.0.0.1:7878", onThisMac: true, connected: true, demo: false, serverVersion: "0.2.4", window: window)
        XCTAssertEqual(checks.value, 1)
        XCTAssertNil(fresh.offer)
    }

    func testFailedRestartKeepsTheOfferAndSaysWhy() async {
        struct Refused: LocalizedError { var errorDescription: String? { "서버를 다시 시작하지 못했습니다(종료 코드 1)." } }
        let found = ServerUpgradeOffer(runningVersion: "0.2.3", bundledVersion: "0.2.4", bundledBuildID: "build-a")
        let watch = ServerUpgradeWatch(defaults: freshDefaults(), check: { _ in found }, restart: { _, _ in throw Refused() })
        await watch.evaluate(endpoint: "http://127.0.0.1:7878", onThisMac: true, connected: true, demo: false, serverVersion: "0.2.3", window: UUID())
        await watch.restart(store: nil)
        XCTAssertEqual(watch.offer, found)
        XCTAssertEqual(watch.error, "서버를 다시 시작하지 못했습니다(종료 코드 1).")
        XCTAssertFalse(watch.isRestarting)
        XCTAssertTrue(ServerUpgradeText.question(found).contains("팀장 세션은 그대로 이어집니다"))
    }
}
