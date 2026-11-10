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
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertFalse(store.showsOffline)
        XCTAssertFalse(store.canWrite)
        XCTAssertNotNil(store.bootstrap)
        XCTAssertNotNil(store.state)
        XCTAssertNotNil(store.connectionIssue)
        XCTAssertNil(store.errorMessage)
        // Strip "다시 연결" while still down: snapshot survives.
        await store.connect()
        XCTAssertFalse(store.showsOffline)
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

    @MainActor func refresh(_ store: AppStore, _ clock: CoordinatorClock, _ helper: RealtimeNetworkTests) async {
        let task = Task { await store.refresh() }
        await helper.settle(); await clock.advance(.milliseconds(500)); await task.value
        await helper.settle()
    }

    @MainActor func testLiveSocketOverridesRESTTimeout() async throws {
        let helper = RealtimeNetworkTests(), server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await helper.connected(server, network, clock, factory), let socket = await factory.sockets.first else { return }
        defer { store.disconnect() }
        server.change { $0.syncError = .timedOut }
        await refresh(store, clock, helper)
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertEqual(store.realtimeStatus, .live)
        XCTAssertFalse(store.showsOffline)
        XCTAssertTrue(store.canWrite)
        let closes = await socket.closeCount
        XCTAssertEqual(closes, 0)
        let before = server.read { $0.syncs }
        server.change { $0.syncError = nil }
        await clock.advance(.seconds(1))
        await helper.eventually { server.read { $0.syncs } > before }
        await helper.eventually { store.restFailures == 0 }
    }

    @MainActor func testSyncErrorsRetryWithoutDisconnectingSocket() async throws {
        for failure in ["500", "decode", "invalidFrame", "identity", "403"] {
            let helper = RealtimeNetworkTests(), server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
            let network = try IsolatedTestNetwork(handler: server.handle)
            guard let store = try await helper.connected(server, network, clock, factory), let socket = await factory.sockets.first else { return }
            server.change {
                switch failure {
                case "500": $0.syncStatus = 500
                case "403": $0.syncStatus = 403
                case "decode": $0.syncBody = "not-json"
                case "invalidFrame": $0.epoch = "wrong"
                default: $0.syncBody = #"{"protocol":2,"cursor":{"epoch":"E","seq":0},"requestedProjectId":"wrong","projectStatus":"archived","bootstrap":{"projects":[]},"state":null}"#
                }
            }
            await refresh(store, clock, helper)
            XCTAssertEqual(store.connectionStatus, .connected, failure)
            XCTAssertFalse(store.showsOffline, failure)
            XCTAssertNotEqual(store.realtimeStatus, .blocked, failure)
            XCTAssertNil(store.errorMessage, failure)
            XCTAssertNotNil(store.state, failure)
            let closes = await socket.closeCount
            XCTAssertEqual(closes, 0, failure)
            let before = server.read { $0.syncs }
            server.change { $0.syncStatus = 200; $0.syncBody = nil; $0.epoch = "E" }
            await clock.advance(.seconds(1))
            await helper.eventually { server.read { $0.syncs } > before }
            await helper.eventually { store.restFailures == 0 }
            XCTAssertTrue(store.canWrite, failure)
            store.disconnect()
        }
    }

    @MainActor func testOfflineRequiresTwoFailuresThreeSecondsAndStaysForTwoSeconds() async throws {
        let helper = RealtimeNetworkTests(), server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await helper.connected(server, network, clock, factory), let socket = await factory.sockets.first else { return }
        defer { store.disconnect() }
        server.change { $0.syncError = .cannotConnectToHost }
        try await socket.enqueue(.failure(URLError(.networkConnectionLost)))
        await helper.eventually { store.restFailures == 1 }
        await helper.settle()
        XCTAssertFalse(store.showsOffline)
        await clock.advance(.seconds(1))
        await helper.eventually { store.restFailures >= 2 }
        XCTAssertFalse(store.showsOffline)
        XCTAssertEqual(store.writeBlockedReason, "잠시 연결을 확인하는 중")
        await helper.settle(); await clock.advance(.milliseconds(1999)); await helper.settle()
        XCTAssertFalse(store.showsOffline)
        await clock.advance(.milliseconds(1))
        await helper.eventually { store.showsOffline }
        XCTAssertEqual(store.connectionStatus, .disconnected)
        XCTAssertFalse(store.canWrite)
        server.change { $0.syncError = nil }
        await refresh(store, clock, helper)
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertTrue(store.showsOffline)
        XCTAssertFalse(store.canWrite)
        await clock.advance(.milliseconds(1499)); await helper.settle()
        XCTAssertTrue(store.showsOffline)
        await clock.advance(.milliseconds(1))
        await helper.eventually { !store.showsOffline }
        XCTAssertTrue(store.canWrite)
    }

    @MainActor func testRestartSignalsRetryQuicklyWithoutIncreasingFailuresAndExpire() async throws {
        XCTAssertEqual(RealtimeClientError.forCloseCode(1012), .restarting)
        XCTAssertNil(RealtimeClientError.forCloseCode(1006))
        for signal in ["1012", "message", "503"] {
            let helper = RealtimeNetworkTests(), server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
            let network = try IsolatedTestNetwork(handler: server.handle)
            guard let store = try await helper.connected(server, network, clock, factory), let socket = await factory.sockets.first else { return }
            server.change { $0.syncStatus = 503; $0.syncBody = #"{"code":"STARTING","message":"starting"}"# }
            if signal == "1012" { try await socket.enqueue(.failure(RealtimeClientError.restarting)) }
            else if signal == "message" { try await helper.frame(socket, #"{"type":"restarting"}"#) }
            else { await refresh(store, clock, helper) }
            await helper.eventually { store.isRestarting }
            XCTAssertEqual(store.connectionNotice, "서버를 다시 시작하는 중")
            XCTAssertFalse(store.showsOffline)
            XCTAssertEqual(store.socketFailures, 0)
            XCTAssertEqual(store.restFailures, 0)
            let reads = server.read { $0.syncs }
            await helper.settle(); await clock.advance(.milliseconds(500))
            await helper.eventually { server.read { $0.syncs } > reads }
            if signal != "503" { await helper.eventually { await factory.sockets.count == 2 } }
            XCTAssertEqual(store.socketFailures, 0)
            XCTAssertEqual(store.restFailures, 0)
            await helper.settle(); await clock.advance(.seconds(30))
            await helper.eventually { !store.isRestarting }
            await helper.settle(); await clock.advance(.seconds(1))
            await helper.eventually { store.restFailures > 0 }
            XCTAssertFalse(store.isRestarting)
            store.disconnect()
        }
    }

    @MainActor func testForegroundHasFiveSecondGraceAndFastTransportRetries() async throws {
        let helper = RealtimeNetworkTests(), server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await helper.connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        store.setForeground(false); await helper.settle()
        server.change { $0.syncError = .timedOut }
        store.setForeground(true)
        await helper.eventually { store.restFailures == 1 }
        await helper.settle()
        let before = server.read { $0.syncs }
        await clock.advance(.milliseconds(299)); await helper.settle()
        XCTAssertEqual(server.read { $0.syncs }, before)
        await clock.advance(.milliseconds(1))
        await helper.eventually { store.restFailures == 2 }
        await helper.settle(); await clock.advance(.seconds(1))
        await helper.eventually { store.restFailures >= 3 }
        await helper.settle(); await clock.advance(.seconds(2))
        await helper.eventually { store.restFailures >= 4 }
        XCTAssertFalse(store.showsOffline)
        await helper.settle(); await clock.advance(.milliseconds(1699)); await helper.settle()
        XCTAssertFalse(store.showsOffline)
        await clock.advance(.milliseconds(1))
        await helper.eventually { store.showsOffline }
    }

    @MainActor func testHelloJoinsInflightSnapshotAndOnlyOlderCursorNeedsAnotherRead() async throws {
        for helloSeq in [0, 1] {
            let helper = RealtimeNetworkTests(), server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
            let network = try IsolatedTestNetwork(handler: server.handle)
            let store = AppStore(session: network.session, persistCredentials: false,
                realtime: RealtimeClient(factory: factory, clock: clock), clock: clock, retryJitter: { $0 })
            store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
            await store.connect()
            await helper.eventually { await factory.sockets.count == 1 }
            guard let socket = await factory.sockets.first else { XCTFail("Missing socket"); return }
            let before = server.read { $0.syncs }
            let gate = DispatchSemaphore(value: 0), entered = expectation(description: "pre-hello snapshot")
            server.change { $0.gate = gate; $0.entered = entered }
            let read = Task { await store.refresh() }
            await helper.settle(); await clock.advance(.milliseconds(500))
            await fulfillment(of: [entered], timeout: 2)
            server.change { $0.seq = helloSeq }
            try await helper.hello(socket, seq: helloSeq)
            await helper.eventually { store.receivedCursor?.seq == helloSeq }
            gate.signal(); await read.value; await helper.settle()
            XCTAssertEqual(server.read { $0.syncs }, before + 1)
            XCTAssertEqual(store.appliedSnapshotCursor?.seq, 0)
            if helloSeq == 1 {
                await clock.advance(.milliseconds(500))
                await helper.eventually { store.appliedSnapshotCursor?.seq == 1 }
                XCTAssertEqual(server.read { $0.syncs }, before + 2)
            }
            await helper.eventually { store.realtimeStatus == .live }
            XCTAssertEqual(store.socketFailures, 0)
            XCTAssertEqual(store.restFailures, 0)
            XCTAssertEqual(server.read { $0.maximumSimultaneous }, 1)
            let closes = await socket.closeCount
            XCTAssertEqual(closes, 0)
            store.disconnect()
        }
    }

    @MainActor func testFreshHeartbeatDefersOfflineUntilTwentySecondsOfSilence() async throws {
        let helper = RealtimeNetworkTests(), server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await helper.connected(server, network, clock, factory), let socket = await factory.sockets.first else { return }
        defer { store.disconnect() }
        server.change { $0.syncError = .timedOut }
        await refresh(store, clock, helper)
        await helper.settle(); await clock.advance(.seconds(1))
        await helper.eventually { store.restFailures >= 2 }
        await clock.advance(.seconds(16))
        try await helper.frame(socket, #"{"type":"ping","epoch":"E","seq":0}"#)
        await helper.settle(); await clock.advance(.seconds(3)); await helper.settle()
        XCTAssertFalse(store.showsOffline)
        XCTAssertEqual(store.realtimeStatus, .live)
        await clock.advance(.seconds(17))
        await helper.eventually { store.showsOffline }
        let closes = await socket.closeCount
        XCTAssertEqual(closes, 0)
    }

    @MainActor func testNetworkPathRestorationReconnectsImmediately() async throws {
        let helper = RealtimeNetworkTests(), server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await helper.connected(server, network, clock, factory), let socket = await factory.sockets.first else { return }
        defer { store.disconnect() }
        try await socket.enqueue(.failure(URLError(.networkConnectionLost)))
        await helper.eventually { store.socketFailures == 1 }
        store.networkPathChanged(satisfied: false)
        store.networkPathChanged(satisfied: true)
        await helper.eventually { await factory.sockets.count == 2 }
        XCTAssertEqual(store.socketFailures, 0)
        XCTAssertEqual(store.restFailures, 0)
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
