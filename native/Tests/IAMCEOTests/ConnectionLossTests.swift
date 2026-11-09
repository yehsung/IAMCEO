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

final class ConnectionLossTests: XCTestCase {
    private func fixture(_ mode: Mode) throws -> IsolatedTestNetwork {
        try IsolatedTestNetwork { request in
            let path = request.url!.path
            if mode.down && !path.hasSuffix("/terminal/control") { throw URLError(.cannotConnectToHost) }
            var status = 200
            var text = "{}"
            if path == "/api/bootstrap" { text = #"{"projects":[{"id":"p","name":"Project"}],"settings":{}}"# }
            else if path == "/api/projects/p/state" { text = #"{"project":{"id":"p","connection":{"ok":true}},"messages":[]}"# }
            else if path.hasSuffix("/terminal/control") {
                if let code = mode.terminalURLError { throw URLError(code) }
                if let (s, m) = mode.terminal { status = s; text = "{\"error\":\"\(m)\"}" }
                else { text = #"{"leaseId":"L1","expiresAt":9999999999999}"# }
            }
            return IsolatedTestHTTPReply(status: status, data: Data(text.utf8))
        }
    }
    @MainActor func testLostConnectionKeepsSnapshotAndRecovers() async throws {
        let mode = Mode(), network = try fixture(mode)
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "x"
        await store.connect()
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
        XCTAssertEqual(store.realtimeStatus, .fallback)
        store.disconnect()
        XCTAssertFalse(store.connectionLost)
    }
    @MainActor func testTerminalLeaseKeptOnTransportFailure() async throws {
        let mode = Mode(), network = try fixture(mode)
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "x"
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
        XCTAssertFalse(network.requests.contains { $0.url?.path == "/api/sync" })
        XCTAssertTrue(network.requests.filter { $0.url?.path.hasSuffix("/terminal/control") == true }
            .allSatisfy { $0.value(forHTTPHeaderField: "X-IAMCEO-Contract") == nil })
        store.disconnect()
    }

    @MainActor func testSocketFailureKeepsRESTWritableAndConfirmed401AloneEndsAuthentication() async throws {
        let helper = RealtimeNetworkTests(), server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await helper.connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        guard let socket = await factory.sockets.first else { XCTFail("Expected the initial coordinator socket"); return }
        try await socket.enqueue(.failure(URLError(.badServerResponse)))
        await helper.eventually { store.realtimeStatus == .fallback }
        XCTAssertTrue(store.canWrite)
        XCTAssertEqual(store.accessCode, "fixture")
        await helper.settle(); await clock.advance(.milliseconds(500))
        await helper.eventually { await factory.sockets.count == 2 }
        XCTAssertTrue(store.canWrite)
        server.change { $0.syncStatus = 401 }
        let refresh = Task { await store.refresh() }
        await helper.settle(); await clock.advance(.milliseconds(500)); await refresh.value
        XCTAssertNil(store.api)
        XCTAssertEqual(store.connectionStatus, .failed)
        XCTAssertEqual(store.accessCode, "")
        let count = network.requests.count
        await clock.advance(.seconds(600)); await helper.settle()
        XCTAssertEqual(network.requests.count, count)
    }

    @MainActor func testRESTFailureBackoffAnd403PreserveSnapshotAndCredentials() async throws {
        let helper = RealtimeNetworkTests(), server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await helper.connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        server.change { $0.syncError = .cannotConnectToHost }
        let failed = Task { await store.refresh() }
        await helper.settle(); await clock.advance(.milliseconds(500)); await failed.value
        XCTAssertTrue(store.connectionLost)
        XCTAssertFalse(store.canWrite)
        XCTAssertNotNil(store.state)
        // A retrying socket never resets REST backoff, or a flapping WS would cause a fast poll loop.
        let count = server.read { $0.syncs }
        await helper.settle(); await clock.advance(.seconds(3))
        await helper.eventually { server.read { $0.syncs } == count + 1 }
        await helper.settle()
        await clock.advance(.seconds(5)); await helper.settle()
        XCTAssertEqual(server.read { $0.syncs }, count + 1)
        await clock.advance(.seconds(1))
        await helper.eventually { server.read { $0.syncs } == count + 2 }
        server.change { $0.syncError = nil; $0.syncStatus = 403 }
        let forbidden = Task { await store.refresh() }
        await helper.settle(); await clock.advance(.milliseconds(500)); await forbidden.value
        XCTAssertEqual(store.realtimeStatus, .blocked)
        XCTAssertEqual(store.accessCode, "fixture")
        XCTAssertNotNil(store.state)
        XCTAssertFalse(store.canWrite)
        let blockedCount = network.requests.count
        await clock.advance(.seconds(600)); await helper.settle()
        XCTAssertEqual(network.requests.count, blockedCount)
        server.change { $0.syncStatus = 200 }
        await store.refresh()
        XCTAssertTrue(store.canWrite)
    }

    @MainActor func testEpochReplacementRejectsLateOldSnapshotAndFetchesNewDiagnostics() async throws {
        let helper = RealtimeNetworkTests(), server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await helper.connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        guard let old = await factory.sockets.first else { XCTFail("Expected the initial coordinator socket"); return }
        let gate = DispatchSemaphore(value: 0), entered = expectation(description: "old epoch read")
        server.change { $0.seq = 1; $0.gate = gate; $0.entered = entered }
        let refresh = Task { await store.refresh() }
        await helper.settle(); await clock.advance(.milliseconds(500))
        await fulfillment(of: [entered], timeout: 2)
        server.change { $0.epoch = "F"; $0.seq = 0 }
        try await helper.frame(old, #"{"type":"ping","epoch":"F","seq":0}"#)
        await helper.eventually { store.realtimeStatus == .fallback }
        await helper.settle(); await clock.advance(.milliseconds(500))
        await helper.eventually { await factory.sockets.count == 2 }
        guard let current = await factory.sockets.dropFirst().first else {
            XCTFail("Expected the replacement coordinator socket")
            gate.signal()
            return
        }
        try await helper.hello(current, epoch: "F")
        gate.signal(); await refresh.value
        await helper.settle(); await clock.advance(.milliseconds(500))
        await helper.eventually { store.appliedSnapshotCursor?.epoch == "F" && store.realtimeStatus == .live }
        XCTAssertEqual(store.state?.project.name, "seq-0")
        XCTAssertEqual(server.read { $0.runtimeReads }, 2)
    }
}
