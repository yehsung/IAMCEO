import XCTest
@testable import IAMCEO

// N(C8): 이 기기의 Tailscale 이 꺼져 있으면 Tailscale 주소로 평문(http·ws) 요청을 보내지 않는다.
// https 주소(Tailscale 의 HTTPS 주소 포함)와 같은 기기(127.0.0.1)는 그대로 보낸다. 연결 QR 은 https 주소부터 시도하고,
// 인증서를 맺지 못한 https 는 다음 주소로 넘어간다. Mac 설정의 'HTTPS 주소' 줄은 GET·POST /api/tailnet/https 를 쓴다.

/// 요청을 세는 가짜 망. 바깥 네트워크로 나가지 않는다. 처리기가 URLError 를 던지면 그 실패로 끝난다.
private final class TailnetStubProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> IsolatedTestHTTPReply
    final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [URLRequest] = []
        func add(_ request: URLRequest) { lock.withLock { seen.append(request) } }
        var requests: [URLRequest] { lock.withLock { seen } }
    }
    private final class Registry: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [String: (Handler, Recorder)] = [:]
        func set(_ id: String, _ entry: (Handler, Recorder)?) { lock.withLock { entries[id] = entry } }
        func get(_ id: String) -> (Handler, Recorder)? { lock.withLock { entries[id] } }
    }
    private static let registry = Registry()
    private static let header = "X-IAMCEO-Tailnet-Fixture"

    static func session(handler: @escaping Handler) -> (session: URLSession, recorder: Recorder, close: @Sendable () -> Void) {
        let id = UUID().uuidString
        let recorder = Recorder()
        registry.set(id, (handler, recorder))
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [TailnetStubProtocol.self]
        config.httpAdditionalHeaders = [header: id]
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 2; config.timeoutIntervalForResource = 2
        let session = URLSession(configuration: config)
        return (session, recorder, { session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }; registry.set(id, nil) })
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canInit(with task: URLSessionTask) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let id = request.value(forHTTPHeaderField: Self.header), let (handler, recorder) = Self.registry.get(id),
                  let url = request.url, url.port != 7878 || url.host != "127.0.0.1" else { throw URLError(.unsupportedURL) }
            recorder.add(request)
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

private struct Pong: Decodable, Sendable { let ok: Bool }
private let pong = IsolatedTestHTTPReply(data: Data(#"{"ok":true}"#.utf8))
private let claimed = IsolatedTestHTTPReply(data: Data(#"{"accessCode":"dk1.fixture.secret","confirmationToken":"token"}"#.utf8))

final class TailnetGuardTests: XCTestCase {
    /// 리뷰 https-1: 100.64/10 주소 하나로는 켜진 것으로 보지 않는다(통신사 CGNAT·Cloudflare WARP). utun 의 tailnet IPv6 가 근거다.
    func testTailscaleCountsAsOnOnlyWithTailnetIPv6OnATunnel() {
        func list(_ pairs: [(String, String)]) -> [Tailnet.InterfaceAddress] { pairs.map { Tailnet.InterfaceAddress(name: $0.0, address: $0.1) } }
        XCTAssertFalse(Tailnet.isConnected(interfaces: []))
        XCTAssertFalse(Tailnet.isConnected(interfaces: list([("pdp_ip0", "100.70.1.2")])), "셀룰러 CGNAT 주소")
        XCTAssertFalse(Tailnet.isConnected(interfaces: list([("en0", "100.64.12.7"), ("en0", "192.168.0.4")])), "Wi-Fi 의 CGNAT 주소")
        XCTAssertFalse(Tailnet.isConnected(interfaces: list([("utun4", "100.96.0.5")])), "Cloudflare WARP 의 100.96/12")
        XCTAssertFalse(Tailnet.isConnected(interfaces: list([("utun4", "100.96.0.5"), ("utun4", "2606:4700:110:8a3c::1")])), "WARP 의 IPv6")
        XCTAssertFalse(Tailnet.isConnected(interfaces: list([("en0", "fd7a:115c:a1e0::1")])), "터널이 아닌 인터페이스")
        XCTAssertTrue(Tailnet.isConnected(interfaces: list([("pdp_ip0", "100.70.1.2"), ("utun3", "100.101.2.3"), ("utun3", "fd7a:115c:a1e0:ab12:4843:cd96:6258:b240")])))
        XCTAssertTrue(Tailnet.isConnected(interfaces: list([("utun7", "FD7A:115C:A1E0::5")])), "IPv4 를 끈 tailnet")
    }

    func testOnlyPlainRequestsToTailscaleAddressesNeedTailscale() throws {
        for raw in ["http://100.64.0.7:7878", "http://sample-mac.tail0000.ts.net:7878", "ws://100.64.0.7:7878/ws", "http://[fd7a:115c:a1e0::1]:7878"] {
            XCTAssertTrue(Tailnet.needsTailnet(URL(string: raw)!), raw)
        }
        for raw in ["https://sample-mac.tail0000.ts.net", "wss://sample-mac.tail0000.ts.net/ws", "http://127.0.0.1:7878", "http://localhost:7878",
                    "http://192.168.0.4:7878", "http://100.128.0.1:7878", "https://100.64.0.7:7878"] {
            XCTAssertFalse(Tailnet.needsTailnet(URL(string: raw)!), raw)
        }
        let plain = URL(string: "http://100.64.0.7:7878/api/bootstrap")!
        XCTAssertNoThrow(try Tailnet.checkBeforeSending(plain, connected: { true }))
        XCTAssertThrowsError(try Tailnet.checkBeforeSending(plain, connected: { false })) { error in
            XCTAssertTrue(Tailnet.isOffError(error))
            XCTAssertEqual((error as? URLError)?.code, .notConnectedToInternet, "연결이 끊긴 것과 같이 다룬다(다시 시도·끊김 표시)")
            XCTAssertEqual(error.localizedDescription, Tailnet.offMessage)
        }
        XCTAssertNoThrow(try Tailnet.checkBeforeSending(URL(string: "https://sample-mac.tail0000.ts.net/api/bootstrap")!, connected: { false }))
        XCTAssertFalse(Tailnet.isOffError(URLError(.notConnectedToInternet)), "다른 끊김은 이 표지가 없다")
        // 화면은 무엇을 켜야 하는지 그대로 말한다(끊김 띠의 자세히, 연결 실패 문장).
        XCTAssertEqual(friendlyLoadError(Tailnet.offError(), what: "Mac 연결", verb: "확인하지"), Tailnet.offMessage)
        XCTAssertEqual(ConnectionRecovery.reason(Tailnet.offError().localizedDescription), Tailnet.offMessage)
        XCTAssertTrue(Tailnet.offMessage.contains("Tailscale"))
    }

    func testAPIClientSendsNothingPlainWhileTailscaleIsOff() async throws {
        let stub = TailnetStubProtocol.session { _ in pong }
        defer { stub.close() }
        let plain = try ServerEndpoint("http://100.64.0.7:45123")
        let off = APIClient(endpoint: plain, accessCode: "fixture", session: stub.session, tailnetConnected: { false })
        do { let _: Pong = try await off.request("/api/capabilities"); XCTFail("Tailscale 이 꺼졌는데 보냈다") }
        catch { XCTAssertTrue(Tailnet.isOffError(error), "\(error)") }
        do { _ = try await off.webSocketRequest(); XCTFail("실시간 연결 요청을 만들었다") } catch { XCTAssertTrue(Tailnet.isOffError(error)) }
        do { _ = try await off.terminalStreamRequest(memberID: "m", mode: .observe, cols: 80, rows: 24, leaseID: nil); XCTFail("터미널 스트림 요청을 만들었다") }
        catch { XCTAssertTrue(Tailnet.isOffError(error)) }
        do { _ = try await off.authorizedURL("/files/a/b.png"); XCTFail("첨부 주소를 내줬다") } catch { XCTAssertTrue(Tailnet.isOffError(error)) }
        off.releaseTerminalLeaseNow(memberID: "m", leaseId: "lease")
        // '나가지 않는지' 보는 쪽이라 넉넉히 기다린다.
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(stub.recorder.requests.count, 0, "아무것도 나가지 않는다")

        let on = APIClient(endpoint: plain, accessCode: "fixture", session: stub.session, tailnetConnected: { true })
        let answer: Pong = try await on.request("/api/capabilities")
        XCTAssertTrue(answer.ok)
        XCTAssertEqual(stub.recorder.requests.count, 1)

        // https(Tailscale 의 HTTPS 주소)와 같은 기기는 Tailscale 상태와 상관없이 보낸다.
        let secure = APIClient(endpoint: try ServerEndpoint("https://sample-mac.tail0000.ts.net"), accessCode: "fixture", session: stub.session, tailnetConnected: { false })
        let _: Pong = try await secure.request("/api/capabilities")
        let socket = try await secure.webSocketRequest()
        XCTAssertEqual(socket.url?.scheme, "wss")
        let loopback = APIClient(endpoint: try ServerEndpoint("http://127.0.0.1:45123"), accessCode: "fixture", session: stub.session, tailnetConnected: { false })
        let _: Pong = try await loopback.request("/api/capabilities")
        XCTAssertEqual(stub.recorder.requests.map { $0.url?.host }, ["100.64.0.7", "sample-mac.tail0000.ts.net", "127.0.0.1"])
    }

    func testPairingTriesHTTPSFirstAndSkipsPlainAddressesWhileTailscaleIsOff() async throws {
        let plainOnly = PairingLink(code: "AB23CD45", urls: [URL(string: "http://100.64.0.7:45123")!])
        let quiet = TailnetStubProtocol.session { _ in claimed }
        defer { quiet.close() }
        do { _ = try await PairingClient.claim(plainOnly, device: "iPhone", session: quiet.session, tailnetConnected: { false }); XCTFail("평문으로 보냈다") }
        catch { XCTAssertEqual((error as? APIError)?.message, PairingClient.tailnetOffMessage) }
        XCTAssertEqual(quiet.recorder.requests.count, 0, "코드를 보내지 않았으니 같은 QR 을 다시 찍을 수 있다")

        // 인증서를 맺지 못한 https 는 서버에 닿기 전이라 다음 주소로 넘어간다. 그 주소가 평문이면 Tailscale 이 켜져 있어야 한다.
        let mixed = PairingLink(code: "AB23CD45", urls: [URL(string: "https://sample-mac.tail0000.ts.net")!, URL(string: "http://100.64.0.7:45123")!])
        let tls = TailnetStubProtocol.session { request in
            if request.url?.scheme == "https" { throw URLError(.serverCertificateUntrusted) }
            return claimed
        }
        defer { tls.close() }
        do { _ = try await PairingClient.claim(mixed, device: "iPhone", session: tls.session, tailnetConnected: { false }); XCTFail("평문으로 넘어갔다") }
        catch { XCTAssertEqual((error as? APIError)?.message, PairingClient.tailnetOffMessage) }
        XCTAssertEqual(tls.recorder.requests.map { $0.url?.scheme }, ["https"])
        let fallback = try await PairingClient.claim(mixed, device: "iPhone", session: tls.session, tailnetConnected: { true })
        XCTAssertEqual(fallback.endpoint, "http://100.64.0.7:45123")
        XCTAssertEqual(fallback.accessCode, "dk1.fixture.secret")

        // https 가 답하면 그 주소로 저장한다(Tailscale 상태와 상관없이 TLS 가 지킨다).
        let secure = TailnetStubProtocol.session { _ in claimed }
        defer { secure.close() }
        let first = try await PairingClient.claim(mixed, device: "iPhone", session: secure.session, tailnetConnected: { false })
        XCTAssertEqual(first.endpoint, "https://sample-mac.tail0000.ts.net")
        XCTAssertEqual(secure.recorder.requests.count, 1)

        // 응답을 기다리다 끊긴 것은 지금처럼 다음 주소로 넘어가지 않는다(코드가 이미 쓰였을 수 있다).
        let slow = TailnetStubProtocol.session { request in
            if request.url?.scheme == "https" { throw URLError(.timedOut) }
            return claimed
        }
        defer { slow.close() }
        do { _ = try await PairingClient.claim(mixed, device: "iPhone", session: slow.session, tailnetConnected: { true }); XCTFail("시간 초과 뒤 다른 주소로 다시 보냈다") }
        catch { XCTAssertTrue((error as? APIError)?.message.contains("이미 사용됐을 수 있습니다") == true) }
        XCTAssertEqual(slow.recorder.requests.count, 1)
    }

    @MainActor func testConnectingWhileTailscaleIsOffSaysSoAndSendsNothing() async throws {
        let stub = TailnetStubProtocol.session { _ in pong }
        defer { stub.close() }
        let store = AppStore(session: stub.session, persistCredentials: false)
        store.tailnetConnected = { false }
        store.endpoint = "http://100.64.0.7:45123"; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        XCTAssertEqual(store.connectionStatus, .failed)
        XCTAssertEqual(store.errorMessage, Tailnet.offMessage)
        XCTAssertEqual(stub.recorder.requests.count, 0)
        store.disconnect()
    }

    func testHTTPSStatusDecodesLenientlyAndReadsPlainly() throws {
        let decode = { (json: String) in try JSONDecoder().decode(TailnetHttpsInfo.self, from: Data(json.utf8)) }
        let on = try decode(#"{"state":"on","url":"https://sample-mac.tail0000.ts.net","checkedAt":"2026-11-13T00:00:00.000Z"}"#)
        XCTAssertEqual(on.state, .on)
        XCTAssertTrue(on.isEnabled)
        XCTAssertTrue(TailnetHttpsText.hint(on).hasPrefix("https://sample-mac.tail0000.ts.net"))
        let disabled = try decode(#"{"state":"off","checkedAt":"x","problem":{"code":"tailnet_https_disabled","message":"이 Tailscale 망은 HTTPS 인증서가 꺼져 있습니다.","link":"https://login.tailscale.com/admin/dns"}}"#)
        XCTAssertFalse(disabled.isEnabled)
        XCTAssertEqual(TailnetHttpsText.hint(disabled), "이 Tailscale 망은 HTTPS 인증서가 꺼져 있습니다.")
        XCTAssertEqual(disabled.problem?.link, "https://login.tailscale.com/admin/dns")
        // 켠 기록은 있지만 지금 확인되지 않으면(이 Mac 의 Tailscale 이 꺼짐) 단추는 '끄기'다.
        XCTAssertTrue(try decode(#"{"state":"pending","url":"https://sample-mac.tail0000.ts.net","problem":{"code":"tailscale_not_running","message":"꺼짐"}}"#).isEnabled)
        XCTAssertEqual(try decode(#"{"state":"later-state"}"#).state, .off, "모르는 값은 꺼진 것으로")
        XCTAssertNil(try decode(#"{"state":"off","problem":{"code":3}}"#).problem, "문장 없는 까닭은 보이지 않는다")
        XCTAssertThrowsError(try decode("{}"), "state 가 없으면 이 경로의 답이 아니다")
        XCTAssertEqual(TailnetHttpsText.hint(nil), TailnetHttpsText.loadingHint)
        XCTAssertEqual(TailnetHttpsText.hint(TailnetHttpsInfo(state: .off)), TailnetHttpsText.offHint)
    }

    @MainActor func testHTTPSPanelHidesOnOldServersAndTurnsOnWithAnExplicitChoice() async throws {
        let bodies = TailnetStubProtocol.Recorder()
        let stub = TailnetStubProtocol.session { request in
            if request.httpMethod == "POST" {
                bodies.add(request)
                return IsolatedTestHTTPReply(data: Data(#"{"state":"on","url":"https://sample-mac.tail0000.ts.net","checkedAt":"x"}"#.utf8))
            }
            return IsolatedTestHTTPReply(data: Data(#"{"state":"off","checkedAt":"x"}"#.utf8))
        }
        defer { stub.close() }
        let api = APIClient(endpoint: try ServerEndpoint("http://127.0.0.1:45124"), accessCode: "fixture", session: stub.session)
        let panel = TailnetHttpsPanel()
        await panel.attach(api)
        XCTAssertEqual(panel.info?.state, .off)
        XCTAssertFalse(panel.unsupported)
        XCTAssertEqual(stub.recorder.requests.map(\.httpMethod), ["GET"], "읽기만 한다. 켜지 않는다")
        let turnedOn = await panel.set(true, api: api)
        XCTAssertTrue(turnedOn)
        XCTAssertEqual(panel.info?.state, .on)
        XCTAssertEqual(bodies.requests.count, 1)
        XCTAssertEqual(bodies.requests.first?.url?.path, "/api/tailnet/https")
        XCTAssertEqual(bodies.requests.first?.timeoutInterval, TailnetHttpsPanel.changeTimeout)

        let old = TailnetStubProtocol.session { _ in IsolatedTestHTTPReply(status: 404, data: Data(#"{"error":"없는 경로입니다","code":"route_not_found"}"#.utf8)) }
        defer { old.close() }
        let oldAPI = APIClient(endpoint: try ServerEndpoint("http://127.0.0.1:45125"), accessCode: "fixture", session: old.session)
        await panel.attach(oldAPI)
        XCTAssertTrue(panel.unsupported, "옛 서버면 줄을 그리지 않는다")
        XCTAssertNil(panel.info)
    }

    #if os(macOS)
    func testPairingSheetShowsEachHostOnce() {
        let urls = ["https://sample-mac.tail0000.ts.net", "http://sample-mac.tail0000.ts.net:7878", "http://100.64.0.7:7878"].compactMap(URL.init(string:))
        XCTAssertEqual(MacPairingSheet.hostLine(urls), "sample-mac.tail0000.ts.net · 100.64.0.7")
    }
    #endif
}
