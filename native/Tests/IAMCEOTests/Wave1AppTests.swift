import Foundation
import XCTest
@testable import IAMCEO

/// 완성도 1차(2026-11-11) 앱 묶음: 첫 실행의 권한 방식 선택, 연결 링크 확인, 폴더 신뢰, 실행 엔진 안내, 샘플 데이터.
/// 새 응답 필드는 모두 선택 필드다. 없거나 모르는 값이면 예전과 똑같이 보여야 한다.

private final class Wave1Server: @unchecked Sendable {
    let writes = WriteTestServer()
    private let lock = NSLock()
    private var projectBodyStore: [[String: Any]] = []
    private var serverIDStore: String?
    var projectBodies: [[String: Any]] { lock.withLock { projectBodyStore } }
    /// nil(기본): 서버 식별자를 알려 주지 않는 서버. 값을 주면 /api/push/status 가 그 식별자로 답한다.
    var serverID: String? {
        get { lock.withLock { serverIDStore } }
        set { lock.withLock { serverIDStore = newValue } }
    }

    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        let path = request.url!.path
        if path == "/api/push/status", let id = serverID {
            return try writes.reply(PushStatus(serverId: id, supported: true, providers: []))
        }
        if path == "/pair/claim" {
            return IsolatedTestHTTPReply(data: try JSONSerialization.data(withJSONObject: ["accessCode": "test"]))
        }
        if path == "/api/projects", request.httpMethod == "POST" {
            let body = try WriteTestServer.body(request)
            lock.withLock { projectBodyStore.append(body) }
            return try writes.reply(Project(id: "p", name: body["name"] as? String ?? ""))
        }
        return try writes.handle(request)
    }
}

/// 127.0.0.1 이 아닌 주소(Tailscale 주소)로 붙은 연결을 흉내 낸다. 어떤 요청도 실제 망으로 나가지 않는다.
private final class Wave1RemoteProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> IsolatedTestHTTPReply
    private final class Registry: @unchecked Sendable {
        private let lock = NSLock()
        private var handlers: [String: Handler] = [:]
        func set(_ id: String, _ handler: Handler?) { lock.withLock { handlers[id] = handler } }
        func get(_ id: String) -> Handler? { lock.withLock { handlers[id] } }
    }
    private static let registry = Registry()

    static func session(handler: @escaping Handler) -> (session: URLSession, close: @Sendable () -> Void) {
        let id = UUID().uuidString
        registry.set(id, handler)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Wave1RemoteProtocol.self]
        config.httpAdditionalHeaders = ["X-IAMCEO-Wave1-Fixture": id]
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 2; config.timeoutIntervalForResource = 2
        let session = URLSession(configuration: config)
        return (session, { session.invalidateAndCancel(); registry.set(id, nil) })
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canInit(with task: URLSessionTask) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let id = request.value(forHTTPHeaderField: "X-IAMCEO-Wave1-Fixture"), let handler = Self.registry.get(id),
                  let url = request.url, url.port != 7878 else { throw URLError(.unsupportedURL) }
            let reply = try handler(request)
            guard let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers) else {
                throw URLError(.badServerResponse)
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private final class Wave1Bodies: @unchecked Sendable {
    private let lock = NSLock()
    private var store: [[String: Any]] = []
    func append(_ body: [String: Any]) { lock.withLock { store.append(body) } }
    var all: [[String: Any]] { lock.withLock { store } }
}

@MainActor final class Wave1AppTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
    /// 스토어가 띄운 작업이 조건에 닿을 때까지 잠깐 기다린다.
    /// 공용 pollUntil(TestSupport)을 부르는 얇은 껍데기. 기한은 느린 CI 러너에 맞춘 공용 기본값(10초)을 쓴다.
    private func settle(_ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        await pollUntil("조건에 닿지 않았다", file: file, line: line, condition)
    }
    /// 일어나면 안 되는 일이 일어날 틈을 준다(부정 단정이라 넉넉히).
    private func pause() async { try? await Task.sleep(for: .milliseconds(150)) }

    // MARK: 1. 첫 실행의 권한 방식 선택

    func testPermissionAcknowledgedIsOptionalAndOnlyFalseAsks() throws {
        XCTAssertNil(try decode(Settings.self, "{}").permissionAcknowledged, "옛 서버(필드 없음)는 '이미 고름'으로 읽는다")
        XCTAssertEqual(try decode(Settings.self, #"{"permissionAcknowledged":false}"#).permissionAcknowledged, false)
        XCTAssertEqual(try decode(Settings.self, #"{"permissionAcknowledged":true}"#).permissionAcknowledged, true)
        XCTAssertNil(try decode(Settings.self, #"{"permissionAcknowledged":"yes"}"#).permissionAcknowledged, "형이 어긋나도 설정 전체를 버리지 않는다")
        // 옛 서버에서 받은 설정을 그대로 되돌려 보낼 때 없는 필드를 만들어 내지 않는다.
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(Settings())) as? [String: Any])
        XCTAssertNil(encoded["permissionAcknowledged"])
    }

    func testFirstRunChoiceUsesSettingsNamesAndStartsOnBypass() {
        XCTAssertEqual(PermissionModeChoice.firstRun.map(\.id), ["bypassPermissions", "auto", "default"])
        XCTAssertEqual(PermissionModeChoice.firstRun.map(\.title), PermissionModeChoice.settings.map(\.title))
        XCTAssertEqual(PermissionModeChoice.firstRun.map(\.title), ["묻지 않기", "위험할 때만 묻기", "매번 묻기"])
        XCTAssertEqual(PermissionModeChoice.bypass, "bypassPermissions")
        XCTAssertEqual(PermissionModeChoice.firstRun[0].detail, "승인 창에서 멈추지 않고 맡긴 일을 끝까지 합니다. 잘못된 명령도 묻지 않고 실행됩니다.")
        XCTAssertEqual(PermissionModeChoice.firstRunTitle, "팀장이 명령을 실행하는 방식")
        XCTAssertEqual(PermissionModeChoice.firstRunConfirm, "이대로 시작")
        // 서버가 도는 Mac의 앱에서는 '이 Mac', iPhone과 다른 Mac에서 붙은 연결에서는 '연결된 Mac'이라고 한다.
        let here = PermissionModeChoice.firstRunLead(onThisMac: true), remote = PermissionModeChoice.firstRunLead(onThisMac: false)
        XCTAssertTrue(here.hasPrefix("팀장은 이 Mac에서 Claude Code·Codex로 명령을 실행합니다."))
        XCTAssertTrue(remote.hasPrefix("팀장은 연결된 Mac에서 Claude Code·Codex로 명령을 실행합니다."))
        XCTAssertFalse(remote.contains("이 Mac"))
        XCTAssertEqual(here.replacingOccurrences(of: "이 Mac", with: "연결된 Mac"), remote, "주어 말고는 같은 안내다")
        XCTAssertTrue(here.hasSuffix("설정에서 언제든 바꿀 수 있습니다."))
        XCTAssertTrue(AppStore.serverIsThisMac(endpoint: "http://127.0.0.1:7878", onMac: true))
        XCTAssertTrue(AppStore.serverIsThisMac(endpoint: "http://localhost:7878", onMac: true))
        XCTAssertFalse(AppStore.serverIsThisMac(endpoint: "http://100.64.0.7:7878", onMac: true), "Tailscale 주소로 붙은 Mac")
        XCTAssertFalse(AppStore.serverIsThisMac(endpoint: "https://mac.tail0000.ts.net", onMac: true))
        XCTAssertFalse(AppStore.serverIsThisMac(endpoint: "http://127.0.0.1:7878", onMac: false), "iPhone(시뮬레이터 포함)")
        XCTAssertEqual(PermissionModeChoice.settings[0].detail, "팀장이 승인 창 없이 명령을 실행합니다")
    }

    func testOldServerAndSampleNeverAskForPermissionChoice() async throws {
        let server = Wave1Server(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        XCTAssertNil(store.bootstrap?.settings.permissionAcknowledged)
        XCTAssertFalse(store.needsPermissionChoice)
        XCTAssertFalse(store.takePermissionChoiceOffer())
        let unsent = await store.acknowledgePermission(mode: "auto")
        XCTAssertFalse(unsent)
        XCTAssertTrue(server.writes.read { $0.settingsBodies.isEmpty })
        store.disconnect(); await network.close()

        let demo = AppStore(demo: true, persistCredentials: false)
        XCTAssertFalse(demo.needsPermissionChoice)
        XCTAssertFalse(demo.takePermissionChoiceOffer())
    }

    func testFreshServerOffersChoiceOnceAndSendsModeWithAcknowledgement() async throws {
        let server = Wave1Server(), network = try IsolatedTestNetwork(handler: server.handle)
        server.writes.change { $0.bootstrap.settings.permissionAcknowledged = false; $0.bootstrap.settings.permissionMode = "bypassPermissions" }
        let store = await connect(network)
        XCTAssertTrue(store.needsPermissionChoice)
        // 연결한 직후 한 번만 띄운다.
        XCTAssertTrue(store.takePermissionChoiceOffer())
        XCTAssertFalse(store.takePermissionChoiceOffer())

        let saved = await store.acknowledgePermission(mode: "bypassPermissions")
        XCTAssertTrue(saved)
        let body = try XCTUnwrap(server.writes.read { $0.settingsBodies.last })
        // 고른 방식이 서버 값과 같아도 방식과 확인을 함께 보낸다.
        XCTAssertEqual(Set(body.keys), ["permissionMode", "permissionAcknowledged"])
        XCTAssertEqual(body["permissionMode"] as? String, "bypassPermissions")
        XCTAssertEqual(body["permissionAcknowledged"] as? Bool, true)
        XCTAssertEqual(network.requests.last { $0.url?.path == "/api/settings" }?.httpMethod, "PUT")
        XCTAssertFalse(store.needsPermissionChoice)
        XCTAssertEqual(store.bootstrap?.settings.permissionAcknowledged, true)
        XCTAssertFalse(store.takePermissionChoiceOffer())
        store.disconnect(); await network.close()
    }

    func testChosenModeIsSavedAndAskedOnlyOnceEvenIfServerKeepsSayingFalse() async throws {
        let server = Wave1Server(), network = try IsolatedTestNetwork(handler: server.handle)
        server.writes.change { $0.bootstrap.settings.permissionAcknowledged = false; $0.acceptsPermissionChoice = false }
        let store = await connect(network)
        XCTAssertTrue(store.needsPermissionChoice)
        let saved = await store.acknowledgePermission(mode: "auto")
        XCTAssertTrue(saved)
        XCTAssertEqual(server.writes.read { $0.bootstrap.settings.permissionMode }, "auto")
        XCTAssertEqual(store.bootstrap?.settings.permissionMode, "auto")
        await store.refresh()
        XCTAssertEqual(store.bootstrap?.settings.permissionAcknowledged, false)
        XCTAssertFalse(store.needsPermissionChoice, "저장에 성공한 선택을 같은 실행에서 다시 묻지 않는다")
        store.disconnect(); await network.close()
    }

    func testChangingModeInSettingsCountsAsTheChoice() async throws {
        let server = Wave1Server(), network = try IsolatedTestNetwork(handler: server.handle)
        server.writes.change { $0.bootstrap.settings.permissionAcknowledged = false }
        let store = await connect(network)
        var draft = try XCTUnwrap(store.beginSettingsEditing()).draft
        draft.compactAtPct = 80
        let first = await store.updateSettings(draft)
        XCTAssertTrue(first)
        XCTAssertEqual(Set(try XCTUnwrap(server.writes.read { $0.settingsBodies.last }).keys), ["compactAtPct"], "다른 설정만 바꾼 것은 선택이 아니다")
        XCTAssertTrue(store.needsPermissionChoice)
        draft = try XCTUnwrap(store.beginSettingsEditing()).draft
        draft.permissionMode = "auto"
        let second = await store.updateSettings(draft)
        XCTAssertTrue(second)
        let body = try XCTUnwrap(server.writes.read { $0.settingsBodies.last })
        XCTAssertEqual(Set(body.keys), ["permissionMode", "permissionAcknowledged"])
        XCTAssertEqual(body["permissionAcknowledged"] as? Bool, true)
        XCTAssertFalse(store.needsPermissionChoice)
        store.disconnect(); await network.close()
    }

    /// 판 번호 없이 설정 전체를 받는 서버: '아직 안 고름'(false)은 앱이 보내는 값이 아니다. 고르면 방식과 확인을 함께 싣는다.
    func testWholeObjectSettingsWriteNeverSendsFalseAndCarriesTheChoice() async throws {
        let server = WriteTestServer(), bodies = Wave1Bodies()
        server.change { $0.bootstrap.settings.permissionAcknowledged = false }
        let network = try IsolatedTestNetwork { request in
            switch request.url?.path {
            case "/api/capabilities":
                return IsolatedTestHTTPReply(data: Data(#"{"contractVersion":2,"capabilities":{"operations":false}}"#.utf8))
            case "/api/settings":
                bodies.append(try WriteTestServer.body(request))
                return try server.reply(Settings())
            default: return try server.handle(request)
            }
        }
        let store = await connect(network)
        XCTAssertTrue(store.needsPermissionChoice)
        var edited = try XCTUnwrap(store.bootstrap?.settings)
        XCTAssertEqual(edited.permissionAcknowledged, false)
        edited.compactAtPct = 80
        let saved = await store.updateSettings(edited)
        XCTAssertTrue(saved)
        XCTAssertEqual(bodies.all.last?["compactAtPct"] as? Int, 80)
        XCTAssertNil(bodies.all.last?["permissionAcknowledged"])

        let chosen = await store.acknowledgePermission(mode: "default")
        XCTAssertTrue(chosen)
        XCTAssertEqual(bodies.all.count, 2)
        XCTAssertEqual(bodies.all.last?["permissionMode"] as? String, "default")
        XCTAssertEqual(bodies.all.last?["permissionAcknowledged"] as? Bool, true)
        XCTAssertNil(network.requests.last { $0.url?.path == "/api/settings" }?.value(forHTTPHeaderField: "If-Match"))
        XCTAssertFalse(store.needsPermissionChoice)
        store.disconnect(); await network.close()
    }

    /// 리뷰: 연결 직후의 제안이 이 Mac의 127.0.0.1 연결에만 있어 iPhone·원격 Mac이 첫 화면이면 물을 기회가 없었다.
    func testFreshServerOffersChoiceOnARemoteConnectionToo() async throws {
        let server = Wave1Server()
        server.writes.change { $0.bootstrap.settings.permissionAcknowledged = false }
        let remote = Wave1RemoteProtocol.session { try server.handle($0) }
        defer { remote.close() }
        let store = AppStore(session: remote.session, persistCredentials: false)
        // C8: Tailscale 주소로 가는 평문 요청은 Tailscale 이 켜져 있을 때만 나간다. 시험 기기의 Tailscale 상태에 기대지 않는다.
        store.tailnetConnected = { true }
        store.endpoint = "http://100.64.0.7:45123"; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertFalse(store.serverIsThisMac)
        XCTAssertTrue(store.needsPermissionChoice)
        XCTAssertTrue(store.takePermissionChoiceOffer(), "127.0.0.1이 아닌 연결에서도 연결 직후 한 번 묻는다")
        XCTAssertFalse(store.takePermissionChoiceOffer())
        // 대표가 답하기 전에 앱이 스스로 닫은 경우(연결 확인 창에 자리를 내줄 때)에는 다시 물을 수 있다.
        store.returnPermissionChoiceOffer()
        XCTAssertTrue(store.takePermissionChoiceOffer())
        let saved = await store.acknowledgePermission(mode: "auto")
        XCTAssertTrue(saved)
        store.returnPermissionChoiceOffer()
        XCTAssertFalse(store.takePermissionChoiceOffer(), "고른 뒤에는 되돌려도 묻지 않는다")
        store.disconnect()

        // 옛 서버(필드 없음)는 원격 연결에서도 묻지 않는다.
        let old = Wave1Server(), oldRemote = Wave1RemoteProtocol.session { try old.handle($0) }
        defer { oldRemote.close() }
        let oldStore = AppStore(session: oldRemote.session, persistCredentials: false)
        oldStore.tailnetConnected = { true }
        oldStore.endpoint = "http://100.64.0.7:45123"; oldStore.accessCode = "test"
        await oldStore.connect(); oldStore.setForeground(false)
        XCTAssertEqual(oldStore.connectionStatus, .connected)
        XCTAssertFalse(oldStore.takePermissionChoiceOffer())
        oldStore.disconnect()
    }

    /// 리뷰: '이번 실행에서 이미 골랐다'는 기록이 주소 기준이라 연결을 끊거나 같은 주소에 새 서버가 떠도 남았다.
    func testChosenRecordEndsWithTheConnectionAndWithTheServerIdentity() async throws {
        let first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222"
        let server = Wave1Server(), network = try IsolatedTestNetwork(handler: server.handle)
        server.serverID = first
        // 서버가 계속 '아직 안 고름'으로 답해도 같은 서버에는 다시 묻지 않는다(기록이 하는 일).
        server.writes.change { $0.bootstrap.settings.permissionAcknowledged = false; $0.acceptsPermissionChoice = false }
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect()
        XCTAssertEqual(store.serverID, first)
        XCTAssertTrue(store.takePermissionChoiceOffer())
        let chosen = await store.acknowledgePermission(mode: "auto")
        XCTAssertTrue(chosen)
        await store.refresh(); await store.refreshPushConnection()
        XCTAssertEqual(store.bootstrap?.settings.permissionAcknowledged, false)
        XCTAssertFalse(store.needsPermissionChoice)

        // 같은 주소에서 다른 서버가 답한다(서버를 새로 설치함): 새 서버에는 다시 묻는다.
        server.serverID = second
        await store.refreshPushConnection()
        XCTAssertEqual(store.serverID, second)
        XCTAssertTrue(store.needsPermissionChoice)
        XCTAssertTrue(store.takePermissionChoiceOffer())
        let again = await store.acknowledgePermission(mode: "default")
        XCTAssertTrue(again)
        XCTAssertFalse(store.needsPermissionChoice)

        // 연결을 끊으면 기록도 끝난다. 다시 붙었을 때 서버가 여전히 '아직'이라면 다시 묻는다.
        store.disconnect()
        XCTAssertNil(store.permissionChosenNamespace)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertTrue(store.needsPermissionChoice)
        XCTAssertTrue(store.takePermissionChoiceOffer())
        store.disconnect(); await network.close()
    }

    // MARK: 3. 연결 링크 확인

    func testPairingLinkAcceptsOnlyTailscaleAndThisDevice() throws {
        func link(_ address: String) -> PairingLink? {
            var parts = URLComponents(); parts.scheme = "iamceo"; parts.host = "pair"
            parts.queryItems = [URLQueryItem(name: "c", value: "AB23CD45"), URLQueryItem(name: "u", value: address)]
            return PairingLink(url: parts.url!)
        }
        for accepted in ["http://100.64.0.7:7878", "http://100.127.255.254:7878", "http://mac.tail0000.ts.net:7878",
                         "https://mac.tail0000.ts.net", "http://127.0.0.1:7878", "http://localhost:7878"] {
            XCTAssertNotNil(link(accepted), accepted)
        }
        // HTTPS라도 Tailscale 주소가 아니면 링크로는 받지 않는다. 손으로 입력하는 길(ServerEndpoint)은 그대로다.
        for rejected in ["https://evil.example.com", "https://ts.net", "https://evil.ts.net", "https://100.63.0.1", "https://100.128.0.1",
                         "https://192.168.0.10", "https://mac.tail0000.ts.net.evil.example.com", "http://evil.example.com"] {
            XCTAssertNil(link(rejected), rejected)
        }
        XCTAssertNoThrow(try ServerEndpoint("https://my-server.example.com"))
        // 받을 수 있는 주소와 섞여 오면 받을 수 없는 주소만 버린다.
        var mixed = URLComponents(); mixed.scheme = "iamceo"; mixed.host = "pair"
        mixed.queryItems = [URLQueryItem(name: "c", value: "AB23CD45"), URLQueryItem(name: "u", value: "https://evil.example.com"),
                            URLQueryItem(name: "u", value: "http://100.64.0.7:7878")]
        XCTAssertEqual(PairingLink(url: mixed.url!)?.urls.map(\.host), ["100.64.0.7"])
        XCTAssertTrue(PairingLink.isPairingURL(URL(string: "iamceo://pair?c=x&u=https%3A%2F%2Fevil.example.com")!))
        XCTAssertFalse(PairingLink.isPairingURL(URL(string: "iamceo://notify?x=1")!))
    }

    func testPairingRequestNamesTheAddressAndSaysWhenItReplacesTheCurrentMac() {
        let link = PairingLink(code: "AB23CD45", urls: [URL(string: "http://mac.tail0000.ts.net:7878")!, URL(string: "http://100.64.0.7:7878")!])
        XCTAssertFalse(PairingRequest.replaces(currentEndpoint: nil, link: link))
        // 같은 Mac을 다시 잇는 것은 바꾸기가 아니다: 링크의 모든 주소가 지금 Mac의 주소(쓰는 주소 + 그 Mac이 알려 준 주소)일 때.
        let reported = ["http://127.0.0.1:7878", "http://100.64.0.7:7878"]
        XCTAssertFalse(PairingRequest.replaces(currentEndpoint: "https://MAC.tail0000.ts.net", serverAddresses: reported, link: link))
        XCTAssertFalse(PairingRequest.replaces(currentEndpoint: "http://100.64.0.7:7878", serverAddresses: ["http://mac.tail0000.ts.net:7878"], link: link))
        XCTAssertFalse(PairingRequest.replaces(currentEndpoint: "http://100.64.0.7:7878",
                                               link: PairingLink(code: "AB23CD45", urls: [URL(string: "http://100.64.0.7:7878")!])))
        XCTAssertTrue(PairingRequest.replaces(currentEndpoint: "http://100.64.0.9:7878", serverAddresses: ["http://100.64.0.9:7878"], link: link))
        // 주소 하나라도 지금 Mac의 주소 밖이면 바꾸기다. 지금 Mac의 주소를 끼워 넣은 링크가 경고를 피하지 못한다.
        XCTAssertTrue(PairingRequest.replaces(currentEndpoint: "http://100.64.0.7:7878", link: link), "알려지지 않은 이름이 섞여 있다")
        let smuggled = PairingLink(code: "AB23CD45", urls: [URL(string: "https://other.tail9999.ts.net")!, URL(string: "http://100.64.0.5:7878")!])
        XCTAssertTrue(PairingRequest.replaces(currentEndpoint: "http://100.64.0.5:7878", serverAddresses: ["http://127.0.0.1:7878", "http://100.64.0.5:7878"], link: smuggled))
        // 서버가 알려 준 주소 중 Tailscale 주소만 그 Mac의 주소로 친다(127.0.0.1은 다른 기기에서는 그 Mac이 아니다).
        let loopback = PairingLink(code: "AB23CD45", urls: [URL(string: "http://127.0.0.1:7878")!])
        XCTAssertTrue(PairingRequest.replaces(currentEndpoint: "https://mac.tail0000.ts.net", serverAddresses: reported, link: loopback))
        XCTAssertEqual(PairingRequest.knownHosts(endpoint: "https://mac.tail0000.ts.net", serverAddresses: reported + ["http://192.168.0.4:7878", "nonsense"]),
                       ["mac.tail0000.ts.net", "100.64.0.7"])
        let first = PairingRequest(link: link, device: "iPhone", replacesCurrent: false)
        XCTAssertEqual(first.title, "이 Mac에 연결할까요?")
        XCTAssertEqual(first.message, "주소: mac.tail0000.ts.net, 100.64.0.7")
        XCTAssertEqual(first.confirmTitle, "연결")
        let swap = PairingRequest(link: link, device: "iPhone", replacesCurrent: true)
        XCTAssertEqual(swap.title, "연결할 Mac을 바꿀까요?")
        XCTAssertTrue(swap.message.contains("주소: mac.tail0000.ts.net, 100.64.0.7"))
        XCTAssertTrue(swap.message.contains("지금 연결된 Mac을 끊고 이 서버로 바꿉니다"))
    }

    func testLinkOpenedOutsideTheAppWaitsForConfirmationBeforeAnyRequest() async throws {
        let server = Wave1Server(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = AppStore(session: network.session, persistCredentials: false)
        let link = PairingLink(code: "ABCDEFGH", urls: [network.endpoint.url])
        await store.receivePairingLink(link, device: "iPhone", external: true)
        let request = try XCTUnwrap(store.pairingRequest)
        XCTAssertFalse(request.replacesCurrent)
        XCTAssertTrue(network.requests.isEmpty, "확인 전에는 일회용 코드를 어디에도 보내지 않는다")
        XCTAssertNil(store.bootstrap)

        store.cancelPairing()
        XCTAssertNil(store.pairingRequest)
        XCTAssertTrue(network.requests.isEmpty)

        await store.receivePairingLink(link, device: "iPhone", external: true)
        let confirmed = try XCTUnwrap(store.pairingRequest)
        // 확인 창은 닫히면서 대기 중인 요청을 먼저 지운다. 화면에 보였던 요청으로 그대로 진행돼야 한다.
        store.cancelPairing()
        let linked = await store.confirmPairing(confirmed)
        XCTAssertTrue(linked)
        XCTAssertNil(store.pairingRequest)
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/pair/claim" }.count, 1)
        XCTAssertEqual(store.connectionStatus, .connected)
        store.disconnect(); await network.close()
    }

    func testScannedQRConnectsAtOnceWhenNothingIsConnected() async throws {
        let server = Wave1Server(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = AppStore(session: network.session, persistCredentials: false)
        await store.receivePairingLink(PairingLink(code: "ABCDEFGH", urls: [network.endpoint.url]), device: "iPhone", external: false)
        XCTAssertNil(store.pairingRequest)
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/pair/claim" }.count, 1)
        XCTAssertEqual(store.connectionStatus, .connected)
        store.disconnect(); await network.close()
    }

    func testLinkToAnotherMacWhileConnectedSaysItReplacesAndKeepsTheConnectionUntilConfirmed() async throws {
        let server = Wave1Server(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        XCTAssertEqual(store.connectionStatus, .connected)
        let before = network.requests.count
        let other = PairingLink(code: "ZZZZ9999", urls: [URL(string: "http://100.64.0.99:7878")!])
        for external in [true, false] {
            await store.receivePairingLink(other, device: "iPhone", external: external)
            let request = try XCTUnwrap(store.pairingRequest)
            XCTAssertTrue(request.replacesCurrent, "external=\(external)")
            XCTAssertTrue(request.message.contains("지금 연결된 Mac을 끊고 이 서버로 바꿉니다"))
            XCTAssertEqual(request.message.components(separatedBy: "\n").first, "주소: 100.64.0.99")
            store.cancelPairing()
        }
        XCTAssertEqual(store.connectionStatus, .connected, "확인 전에는 지금 연결이 그대로다")
        XCTAssertEqual(store.endpoint, network.endpoint.url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        XCTAssertFalse(network.requests.dropFirst(before).contains { $0.url?.path == "/pair/claim" })
        // 같은 Mac을 가리키는 QR을 앱 안에서 찍은 것은 바꾸기가 아니다. 앱 밖에서 온 링크는 그래도 확인한다.
        let same = PairingLink(code: "ABCDEFGH", urls: [network.endpoint.url])
        await store.receivePairingLink(same, device: "iPhone", external: true)
        XCTAssertEqual(store.pairingRequest?.replacesCurrent, false)
        store.disconnect()
        XCTAssertNil(store.pairingRequest, "연결을 끊으면 기다리던 확인도 사라진다")
        await network.close()
    }

    /// 리뷰: 링크의 주소 하나만 지금 Mac과 같아도 '같은 Mac'으로 봐서, 앱 안 스캔이면 확인 없이 첫 주소로 연결이 바뀌었다.
    func testLinkWithAnAddressOutsideTheCurrentMacAsksEvenWhenScannedInTheApp() async throws {
        let server = Wave1Server(), network = try IsolatedTestNetwork(handler: server.handle)
        server.writes.change { $0.bootstrap.urls = ["http://127.0.0.1:7878", "http://100.64.0.5:7878"] }
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "iamceo.wave1.\(UUID().uuidString)"))
        let store = AppStore(session: network.session, persistCredentials: false, navigationDefaults: defaults)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        XCTAssertEqual(store.connectionStatus, .connected)
        let key = DraftStore.key(project: store.selectedProjectID, target: nil)
        store.drafts.setText("쓰던 글", for: key)

        let smuggled = PairingLink(code: "ZZZZ9999", urls: [URL(string: "https://other.tail9999.ts.net")!, network.endpoint.url])
        await store.receivePairingLink(smuggled, device: "iPhone", external: false)
        let request = try XCTUnwrap(store.pairingRequest)
        XCTAssertTrue(request.replacesCurrent)
        XCTAssertEqual(request.title, "연결할 Mac을 바꿀까요?")
        XCTAssertEqual(request.message.components(separatedBy: "\n").first, "주소: other.tail9999.ts.net, 127.0.0.1")
        XCTAssertFalse(network.requests.contains { $0.url?.path == "/pair/claim" }, "확인 전에는 코드를 보내지 않는다")
        store.cancelPairing(request)
        XCTAssertNil(store.pairingRequest)
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertEqual(store.drafts.text(for: key), "쓰던 글", "확인 창이 뜨고 닫혀도 쓰던 글은 그대로다")

        // 그 Mac이 알려 준 Tailscale 주소까지 든 QR은 같은 Mac이다: 앱 안 스캔이면 묻지 않고 바로 잇는다.
        let same = PairingLink(code: "ABCDEFGH", urls: [network.endpoint.url, URL(string: "http://100.64.0.5:7878")!])
        await store.receivePairingLink(same, device: "iPhone", external: false)
        XCTAssertNil(store.pairingRequest)
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/pair/claim" }.count, 1)
        XCTAssertEqual(store.connectionStatus, .connected)

        // 알려 준 주소는 저장된 연결과 함께 남고(Mac에 닿지 않을 때의 재연결용), 연결을 끊으면 지운다.
        let saved = defaults.dictionaryRepresentation().filter { $0.key.hasPrefix("iamceo.serverAddresses.v1.") }
        XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(saved.values.first as? [String], ["http://127.0.0.1:7878", "http://100.64.0.5:7878"])
        store.disconnect()
        XCTAssertTrue(defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix("iamceo.serverAddresses.v1.") }.isEmpty)
        await network.close()
    }

    /// 리뷰: 대답 없는 확인 요청이 연결/취소/끊기 전까지 계속 남았다. 일회용 코드 수명(5분)이 지나면 스스로 사라진다.
    func testUnansweredPairingRequestExpiresWithTheCodeAndNewerLinksReplaceIt() async throws {
        let server = Wave1Server(), network = try IsolatedTestNetwork(handler: server.handle)
        let clock = CoordinatorClock()
        let store = AppStore(session: network.session, persistCredentials: false, clock: clock)
        let link = PairingLink(code: "ABCDEFGH", urls: [network.endpoint.url])
        XCTAssertEqual(PairingRequest.lifetime, .seconds(300))

        await store.receivePairingLink(link, device: "iPhone", external: true)
        let first = try XCTUnwrap(store.pairingRequest)
        await settle { await clock.deadlines == [.seconds(300)] }
        await clock.advance(.seconds(299))
        await pause()
        XCTAssertEqual(store.pairingRequest?.id, first.id, "수명 안에서는 기다린다")
        XCTAssertNil(store.errorMessage)

        // 새 링크가 오면 그 링크의 요청으로 바뀌고 수명도 새로 센다. 늦게 닫힌 옛 확인 창은 새 요청을 지우지 못한다.
        await store.receivePairingLink(link, device: "iPhone", external: true)
        let second = try XCTUnwrap(store.pairingRequest)
        XCTAssertNotEqual(second.id, first.id)
        store.cancelPairing(first)
        XCTAssertEqual(store.pairingRequest?.id, second.id)
        await settle { await clock.deadlines == [.seconds(599)] }
        await clock.advance(.seconds(2))
        await pause()
        XCTAssertEqual(store.pairingRequest?.id, second.id, "앞 요청의 만료 시각에 사라지지 않는다")

        await clock.advance(.seconds(298))
        await settle { store.pairingRequest == nil }
        XCTAssertNil(store.pairingRequest)
        XCTAssertEqual(store.errorMessage, PairingRequest.expiredMessage)
        XCTAssertEqual(PairingRequest.expiredMessage, "연결 QR의 유효 시간이 지났습니다. Mac에서 새 QR을 만들어 다시 찍어 주세요.")
        XCTAssertTrue(network.requests.isEmpty)

        // 취소한 요청은 나중에 만료 안내를 내지 않는다.
        store.errorMessage = nil
        await store.receivePairingLink(link, device: "iPhone", external: true)
        await settle { await clock.deadlines == [.seconds(899)] }
        store.cancelPairing()
        await settle { await clock.deadlines.isEmpty }
        await clock.advance(.seconds(600))
        await pause()
        XCTAssertNil(store.pairingRequest); XCTAssertNil(store.errorMessage)

        // 화면에 남아 있던 낡은 확인 창에서 '연결'을 눌러도 만료된 코드는 보내지 않는다.
        var stale = PairingRequest(link: link, device: "iPhone", replacesCurrent: false)
        XCTAssertFalse(stale.isExpired())
        stale.receivedAt = Date(timeIntervalSinceNow: -301)
        XCTAssertTrue(stale.isExpired())
        let linked = await store.confirmPairing(stale)
        XCTAssertFalse(linked)
        XCTAssertEqual(store.errorMessage, PairingRequest.expiredMessage)
        XCTAssertTrue(network.requests.isEmpty)
        await network.close()
    }

    /// 리뷰: iPhone에서 시트가 열려 있으면 확인 창이 뜨지 못했다. 링크를 받으면 셸이 띄운 시트를 먼저 닫는다.
    func testClosingShellSheetsForAConfirmationKeepsTheScreenUnderneath() {
        let router = Router(destination: .chat, usesPhoneNavigation: true)
        router.chatTarget = "m"; router.chatMessageID = "x1"; router.phonePaths[.team] = [.member("m")]
        router.showSettings = true; router.showNewProject = true; router.showNewMember = true; router.showPairing = true
        router.terminalMemberID = "m"; router.manageProject(id: "p", mode: .rename)
        XCTAssertFalse(router.closeSheets(), "권한 선택 창은 열려 있지 않았다")
        XCTAssertFalse(router.showSettings); XCTAssertFalse(router.showNewProject); XCTAssertFalse(router.showNewMember)
        XCTAssertFalse(router.showPairing); XCTAssertFalse(router.showPermissionChoice)
        XCTAssertNil(router.terminalMemberID); XCTAssertNil(router.projectManagement)
        // 보던 화면·고른 상대·쌓인 화면은 그대로다.
        XCTAssertEqual(router.destination, .chat); XCTAssertEqual(router.chatTarget, "m"); XCTAssertEqual(router.chatMessageID, "x1")
        XCTAssertEqual(router.phonePaths[.team], [.member("m")])
        // 답하지 않은 권한 선택 창을 닫았다면 알려 준다(다시 물을 수 있게).
        router.showPermissionChoice = true
        XCTAssertTrue(router.closeSheets())
        XCTAssertFalse(router.showPermissionChoice)
    }

    func testSampleNeverTakesAPairingLink() async throws {
        let network = try IsolatedTestNetwork()
        let demo = AppStore(demo: true, session: network.session, persistCredentials: false)
        await demo.receivePairingLink(PairingLink(code: "ABCDEFGH", urls: [network.endpoint.url]), device: "iPhone", external: true)
        XCTAssertNil(demo.pairingRequest)
        XCTAssertTrue(network.requests.isEmpty)
        await network.close()
    }

    // MARK: 4. 폴더 신뢰

    func testTrustFolderIsSentOnlyWhenOn() async throws {
        let server = Wave1Server(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        let trusted = await store.createProject(name: "새 일", cwd: "~/work/a", provider: "claude", trustFolder: true)
        XCTAssertTrue(trusted)
        let plain = await store.createProject(name: "다른 일", cwd: "~/work/b", provider: "codex")
        XCTAssertTrue(plain)
        let bodies = server.projectBodies
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(bodies[0]["trustFolder"] as? Bool, true)
        XCTAssertEqual(bodies[0]["chiefCli"] as? String, "claude")
        XCTAssertNil(bodies[1]["trustFolder"], "끄면 키를 싣지 않는다(옛 서버와 같은 요청)")
        XCTAssertEqual(Set(bodies[1].keys), ["name", "cwd", "goal", "startConductor", "chiefCli"])
        XCTAssertEqual(NewProjectView.trustFolderLabel, "이 폴더를 신뢰하고 AI가 이 안에서 명령을 실행하게 합니다")
        store.disconnect(); await network.close()
    }

    func testBlockedCodeGuidesToTheTerminalAndUnknownCodesChangeNothing() throws {
        let observed = StatusObservation(source: "core", freshness: "fresh", ownership: "verified")
        let plain = Member(id: "m", backend: "core", status: "blocked", blockedReason: "status_unknown", statusObservation: observed)
        XCTAssertNil(BlockedGuide(plain))
        let before = MemberStatusInfo(plain)

        var trust = plain; trust.blockedCode = "trust_dialog_unrecognized"
        let guide = try XCTUnwrap(BlockedGuide(trust))
        XCTAssertEqual(guide.actionTitle, "터미널 열어 직접 답하기")
        XCTAssertEqual(guide.explanation, "Claude Code가 이 폴더를 신뢰할지 묻고 있습니다. 터미널에서 직접 답해 주세요.")
        XCTAssertEqual(MemberStatusInfo(trust).explanation, guide.explanation)
        XCTAssertTrue(MemberStatusInfo(trust).needsMe, "대표가 풀어야 하는 막힘이라 홈의 내 차례에 뜬다")
        XCTAssertNotEqual(MemberStatusInfo(trust).label, "상태 확인 불가")

        var slow = plain; slow.blockedCode = "start_not_ready"
        XCTAssertEqual(BlockedGuide(slow)?.explanation, "시작이 늦어지고 있습니다. 터미널을 열어 상태를 확인해 주세요.")
        XCTAssertEqual(BlockedGuide(slow)?.actionTitle, "터미널 열기")

        // 리뷰: 안내문이 CLI 종류와 무관하게 'Claude Code가…'로 고정돼 있었다. 팀장의 CLI 이름을 쓰고, 모르는 종류면 이름을 뺀다.
        var codex = trust; codex.cli = "codex"
        XCTAssertEqual(BlockedGuide(codex)?.explanation, "Codex가 이 폴더를 신뢰할지 묻고 있습니다. 터미널에서 직접 답해 주세요.")
        XCTAssertEqual(MemberStatusInfo(codex).explanation, BlockedGuide(codex)?.explanation)
        var other = trust; other.cli = "something_new"
        XCTAssertEqual(BlockedGuide(other)?.explanation, "이 폴더를 신뢰할지 묻는 창이 떠 있습니다. 터미널에서 직접 답해 주세요.")
        XCTAssertEqual(BlockedGuide(other)?.actionTitle, guide.actionTitle)
        XCTAssertFalse(BlockedGuide(codex)?.explanation.contains("Claude") ?? true)

        // 관측이 낡았다고 알려 온 경우에도 서버가 알려 준 이유가 먼저다.
        var stale = trust
        stale.statusObservation = StatusObservation(source: "core", freshness: "stale", ownership: "verified", error: ObservationError(code: "timeout", note: "재관측 중"))
        XCTAssertEqual(MemberStatusInfo(stale).explanation, guide.explanation)

        // 모르는 코드, 코드 없음, 막힘이 아닌 상태는 지금과 같다.
        var unknown = plain; unknown.blockedCode = "something_new"
        XCTAssertNil(BlockedGuide(unknown))
        XCTAssertEqual(MemberStatusInfo(unknown).label, before.label)
        XCTAssertEqual(MemberStatusInfo(unknown).explanation, before.explanation)
        XCTAssertEqual(MemberStatusInfo(unknown).needsMe, before.needsMe)
        var working = trust; working.status = "working"
        XCTAssertNil(BlockedGuide(working))
        XCTAssertEqual(MemberStatusInfo(working).label, "일하는 중")

        // 서버가 정확히 알아본 폴더 신뢰 창은 앱 안에서 답하는 기존 카드 그대로다.
        var readable = Member(id: "m", backend: "core", status: "blocked", blockedReason: "setup",
                              statusObservation: StatusObservation(source: "core", freshness: "fresh", ownership: "verified", error: ObservationError(code: "folder_trust", note: "폴더 신뢰")))
        readable.blockedCode = "trust_dialog_unrecognized"
        XCTAssertEqual(MemberStatusInfo(readable).label, "승인 창 앞")

        XCTAssertNil(try decode(Member.self, #"{"id":"m"}"#).blockedCode)
        XCTAssertEqual(try decode(Member.self, #"{"id":"m","blockedCode":"start_not_ready"}"#).blockedCode, "start_not_ready")
        XCTAssertNil(try decode(Member.self, #"{"id":"m","blockedCode":7}"#).blockedCode, "형이 어긋나도 팀원을 버리지 않는다")
    }

    /// 구현 보고의 인계: 결재함의 '상태 확인 불가 N명'은 막힘 코드가 붙은 팀장도 센다. 이번에는 그대로 둔다(길은 이어진다).
    func testBlockedCodeMemberStillCountsAsUncertainInSummaries() {
        var trust = Member(id: "m", backend: "core", status: "blocked", blockedReason: "status_unknown",
                           statusObservation: StatusObservation(source: "core", freshness: "fresh", ownership: "verified"))
        trust.blockedCode = "trust_dialog_unrecognized"
        XCTAssertTrue(MemberStatusInfo.isUncertain(trust))
        XCTAssertEqual(MemberStatusInfo.summaryCounts([trust])["unknown"], 1)
    }

    // MARK: 5. 실행 엔진 안내

    func testEngineNoticeOnlyForTheTwoNamedStates() throws {
        XCTAssertNil(EngineNotice(nil))
        XCTAssertNil(EngineNotice(EngineState(state: "ok")))
        XCTAssertNil(EngineNotice(EngineState(state: "something_new")))
        XCTAssertEqual(EngineNotice(EngineState(state: "unresponsive"))?.text, "실행 엔진이 응답하지 않습니다. Mac에서 IAMCEO를 다시 시작해 주세요.")
        XCTAssertEqual(EngineNotice(EngineState(state: "version_mismatch", version: "0.9", expectedVersion: "1.0"))?.text,
                       "실행 엔진 버전이 맞지 않습니다. IAMCEO를 최신 버전으로 다시 설치해 주세요.")

        XCTAssertNil(try decode(Bootstrap.self, #"{"projects":[]}"#).engine, "옛 서버")
        let mismatch = try decode(Bootstrap.self, #"{"projects":[],"engine":{"state":"version_mismatch","version":"0.9.1","expectedVersion":"1.0.0"}}"#)
        XCTAssertEqual(mismatch.engine, EngineState(state: "version_mismatch", version: "0.9.1", expectedVersion: "1.0.0"))
        // 엔진 정보가 어긋나도 시작 응답 전체를 버리지 않는다.
        for broken in [#"{"projects":[],"engine":"down"}"#, #"{"projects":[],"engine":{"version":"1.0"}}"#, #"{"projects":[],"engine":{"state":3}}"#] {
            XCTAssertNil(try decode(Bootstrap.self, broken).engine, broken)
        }
        XCTAssertEqual(try decode(Bootstrap.self, #"{"projects":[],"engine":{"state":"unresponsive","version":7}}"#).engine?.state, "unresponsive")
    }

    // MARK: 6. 설정 문구

    /// 서버는 기준을 넘은 팀장을 다음 업무 전에 스스로 압축한다(server/orchestrator.ts autoCompact). 안내가 그 사실을 말한다.
    func testContextThresholdHintSaysTheServerCompactsByItself() {
        let hint = SettingsView.compactAtHint
        XCTAssertEqual(hint, "이 비율을 넘으면 팀 화면에 표시하고, 다음 업무 전에 자동으로 압축합니다.")
        XCTAssertFalse(hint.contains("팀원 상세"))
        XCTAssertEqual(hint.filter { $0 == "." }.count, 1, "한 문장")
    }

    // MARK: 7. 샘플 모드

    func testSampleWorkspaceLooksLikeAHealthyTeam() throws {
        let (bootstrap, state) = DemoFixtures.workspace(now: Date(timeIntervalSince1970: 1_800_000_000))
        // 오류·막힘·상태 확인 불가가 없다.
        for member in state.members {
            XCTAssertFalse(["blocked", "error", "unknown", "offline", "gone"].contains(member.status), member.id)
            XCTAssertNil(member.lastError, member.id)
            XCTAssertNil(member.blockedReason, member.id)
            XCTAssertFalse(MemberStatusInfo.isUncertain(member), member.id)
            XCTAssertNotEqual(MemberStatusInfo(member).tone, .danger, member.id)
        }
        // 일하는 중·내 답 기다림·쉬는 중·잠듦이 섞여 있다.
        let counts = MemberStatusInfo.summaryCounts(state.members)
        XCTAssertGreaterThanOrEqual(counts["working"] ?? 0, 2)
        XCTAssertEqual(counts["waiting"], 1)
        XCTAssertGreaterThanOrEqual(counts["idle"] ?? 0, 2)
        XCTAssertGreaterThanOrEqual(counts["asleep"] ?? 0, 1)
        // 전달 실패·보류·확인 필요가 없다.
        for message in state.messages where message.mine {
            XCTAssertEqual(message.delivery, "delivered", message.id)
            XCTAssertNil(message.deliveryNote, message.id)
        }
        XCTAssertEqual(state.deliveryNotices?.version, 2)
        // 서버는 팀장마다 줄을 싣는다. 모두 0이다.
        XCTAssertTrue(state.deliveryNotices?.members.allSatisfy { $0.needsOwnerCount == 0 && $0.undeliveredCount == 0 && $0.unknownCount == 0 } == true)
        XCTAssertEqual(state.deliveryNotices?.unassigned.needsOwnerCount, 0)
        let attention = HomeAttention(members: state.members, notices: state.deliveryNotices, messages: state.messages)
        XCTAssertTrue(attention.members.isEmpty)
        XCTAssertTrue(attention.failedMessages.isEmpty)
        // 결재 대기는 제품의 핵심이라 한두 건 남긴다. 완료 보고도 있다.
        let open = state.decisions.filter { $0.status == "open" }
        XCTAssertTrue((1...2).contains(open.count))
        XCTAssertEqual(state.doneDecisionCount, state.decisions.count - open.count)
        XCTAssertTrue(state.messages.contains { $0.kind == "완료" })
        XCTAssertFalse(state.messages.contains { $0.kind == "알림" })
        // 프로젝트 목록의 숫자도 같은 그림이다.
        let summary = try XCTUnwrap(bootstrap.projects.first { $0.id == state.project.id })
        XCTAssertEqual(summary.blockedCount, 0)
        XCTAssertEqual(summary.errorCount, 0)
        XCTAssertEqual(summary.decisionCount, open.count)
        XCTAssertEqual(summary.todoCount, state.todos.filter { !$0.done }.count)
        XCTAssertEqual(summary.workingCount, counts["working"])
        for project in bootstrap.projects {
            XCTAssertEqual(project.blockedCount + project.errorCount, 0, project.id)
            XCTAssertFalse(projectRailLine(project).contains("오류"), project.id)
        }
        XCTAssertNil(EngineNotice(bootstrap.engine))
        // 샘플은 권한 방식 첫 질문을 띄우지 않는다(이미 정해 둔 팀).
        XCTAssertNotEqual(bootstrap.settings.permissionAcknowledged, false)
        // 글이 가리키는 자료·결재·팀원이 모두 있다.
        for message in state.messages {
            if let id = message.fileId { XCTAssertTrue(state.files.contains { $0.id == id }, message.id) }
            if let id = message.decisionId { XCTAssertTrue(state.decisions.contains { $0.id == id }, message.id) }
            if let id = message.memberId { XCTAssertTrue(state.members.contains { $0.id == id }, message.id) }
            if let id = message.targetMemberId { XCTAssertTrue(state.members.contains { $0.id == id }, message.id) }
        }
        XCTAssertEqual(Set(state.messages.map(\.id)).count, state.messages.count)
        XCTAssertEqual(state.messages.map(\.at), state.messages.map(\.at).sorted(), "대화는 시간 순서다")
    }
}
