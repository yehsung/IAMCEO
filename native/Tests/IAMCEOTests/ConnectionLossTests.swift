import Foundation
import XCTest
@testable import IAMCEO

private final class Mode: @unchecked Sendable {
    private let lock = NSLock()
    private var _down = false
    private var _terminal: (Int, String)? = nil
    private var _terminalURLError: URLError.Code? = nil
    var down: Bool { get { lock.lock(); defer { lock.unlock() }; return _down } set { lock.lock(); _down = newValue; lock.unlock() } }
    var terminal: (Int, String)? { get { lock.lock(); defer { lock.unlock() }; return _terminal } set { lock.lock(); _terminal = newValue; lock.unlock() } }
    var terminalURLError: URLError.Code? { get { lock.lock(); defer { lock.unlock() }; return _terminalURLError } set { lock.lock(); _terminalURLError = newValue; lock.unlock() } }
}
private let mode = Mode()

private final class OfflineStub: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        if mode.down && !path.hasSuffix("/terminal/control") { client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return }
        var status = 200
        var text = "{}"
        if path == "/api/bootstrap" { text = #"{"projects":[{"id":"p","name":"Project"}],"settings":{}}"# }
        else if path == "/api/projects/p/state" { text = #"{"project":{"id":"p","connection":{"ok":true}},"messages":[]}"# }
        else if path.hasSuffix("/terminal/control") {
            if let code = mode.terminalURLError { client?.urlProtocol(self, didFailWithError: URLError(code)); return }
            if let (s, m) = mode.terminal { status = s; text = "{\"error\":\"\(m)\"}" }
            else { text = #"{"leaseId":"L1","expiresAt":9999999999999}"# }
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class ConnectionLossTests: XCTestCase {
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [OfflineStub.self]
        return URLSession(configuration: config)
    }
    @MainActor func testLostConnectionKeepsSnapshotAndRecovers() async throws {
        mode.down = false; mode.terminal = nil; mode.terminalURLError = nil
        let store = AppStore(session: session(), persistCredentials: false)
        store.endpoint = "http://localhost:7878"; store.accessCode = "x"
        await store.connect(); store.setForeground(false)
        XCTAssertEqual(store.connectionStatus, .connected)
        mode.down = true
        await store.refresh()
        XCTAssertEqual(store.connectionStatus, .disconnected)
        XCTAssertTrue(store.connectionLost)
        XCTAssertFalse(store.canWrite)
        XCTAssertNotNil(store.bootstrap)
        XCTAssertNotNil(store.state)
        XCTAssertNotNil(store.connectionIssue)
        XCTAssertNil(store.errorMessage)
        // Strip "다시 연결" while still down: snapshot survives.
        await store.connect()
        XCTAssertTrue(store.connectionLost)
        XCTAssertNotNil(store.state)
        mode.down = false
        await store.connect()
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertNil(store.connectionIssue)
        XCTAssertTrue(store.canWrite)
        store.disconnect()
        XCTAssertFalse(store.connectionLost)
    }
    @MainActor func testTerminalLeaseKeptOnTransportFailure() async throws {
        mode.down = false; mode.terminal = nil; mode.terminalURLError = nil
        let store = AppStore(session: session(), persistCredentials: false)
        store.endpoint = "http://localhost:7878"; store.accessCode = "x"
        await store.connect(); store.setForeground(false)
        let member = try JSONDecoder().decode(Member.self, from: Data(#"{"id":"m","name":"카드 결제 구현"}"#.utf8))
        do { let r = await store.claimTerminal(member); XCTAssertTrue(r) }
        mode.terminalURLError = .timedOut
        do { let r = await store.terminalInput(member, text: "y"); XCTAssertFalse(r) }
        XCTAssertEqual(store.terminalLeases["m"]?.leaseId, "L1")
        do { let r = await store.releaseTerminal(member); XCTAssertFalse(r) }
        XCTAssertEqual(store.terminalLeases["m"]?.leaseId, "L1")
        XCTAssertTrue(store.errorMessage?.contains("조작권을 놓지 못했습니다") == true)
        mode.terminalURLError = nil
        mode.terminal = (409, "세션을 처리하는 중입니다. 잠시 뒤 다시 여세요")
        do { let r = await store.terminalKey(member, key: "enter"); XCTAssertFalse(r) }
        XCTAssertEqual(store.terminalLeases["m"]?.leaseId, "L1")
        mode.terminal = (409, "A matching active terminal control lease is required")
        do { let r = await store.terminalKey(member, key: "enter"); XCTAssertFalse(r) }
        XCTAssertNil(store.terminalLeases["m"])
        mode.terminal = nil
        do { let r = await store.claimTerminal(member); XCTAssertTrue(r) }
        mode.terminal = (409, "A matching active terminal control lease is required")
        do { let r = await store.releaseTerminal(member); XCTAssertTrue(r) }
        XCTAssertNil(store.terminalLeases["m"])
        XCTAssertNil(store.errorMessage)
        store.disconnect()
    }
}
