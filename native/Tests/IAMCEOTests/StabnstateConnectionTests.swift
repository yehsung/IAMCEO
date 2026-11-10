import Foundation
import SwiftUI
import XCTest
@testable import IAMCEO

/// Holds a reply until the test opens it. `entered` counts the requests that reached the hold.
actor StabGate {
    private var opened = false
    private var waiting: [TestDeadlineContinuation<Void, Never>] = []
    private(set) var entered = 0
    func wait() async {
        entered += 1
        guard !opened else { return }
        await withTestDeadline(fallback: ()) { waiting.append($0) }
    }
    func open() { opened = true; waiting.forEach { $0.resume() }; waiting = [] }
}

/// One-shot holds and failure modes for a wrapped fixture server.
final class StabSwitch: @unchecked Sendable {
    private let lock = NSLock()
    private var holds: [String: (gate: StabGate, status: Int?)] = [:]
    private var failing: [String: Int] = [:]
    private var _down = false
    var down: Bool { get { lock.withLock { _down } } set { lock.withLock { _down = newValue } } }
    func hold(_ path: String, _ gate: StabGate, status: Int? = nil) { lock.withLock { holds[path] = (gate, status) } }
    func take(_ path: String) -> (gate: StabGate, status: Int?)? { lock.withLock { holds.removeValue(forKey: path) } }
    /// The next `count` requests to `path` answer 503.
    func fail(_ path: String, count: Int) { lock.withLock { failing[path] = count } }
    func takeFailure(_ path: String) -> Bool {
        lock.withLock {
            guard let left = failing[path], left > 0 else { return false }
            failing[path] = left - 1
            return true
        }
    }
    func apply(_ request: URLRequest, to reply: IsolatedTestHTTPReply) -> IsolatedTestHTTPReply {
        var reply = reply
        if let hold = take(request.url!.path) {
            if let status = hold.status { reply.status = status; reply.data = Data("{}".utf8) }
            let gate = hold.gate
            reply.beforeDelivery = { await gate.wait() }
        }
        return reply
    }
}

@MainActor final class StabnstateConnectionTests: XCTestCase {
    private func count(_ network: IsolatedTestNetwork, _ path: String) -> Int {
        network.requests.filter { $0.url?.path == path }.count
    }
    private func plainStore(_ network: IsolatedTestNetwork, _ clock: CoordinatorClock, saved: Bool = false) -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, clock: clock, retryJitter: { $0 })
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        store.retriesSavedConnection = saved
        return store
    }
    private func downNetwork(_ server: CoordinatorServer, _ mode: StabSwitch) throws -> IsolatedTestNetwork {
        try IsolatedTestNetwork { request in
            if mode.down { throw URLError(.cannotConnectToHost) }
            return mode.apply(request, to: try server.handle(request))
        }
    }

    // MARK: n-net-3 — the first connect retries by itself

    func testSavedConnectionRetriesTransientFirstConnectFailureWithBackoff() async throws {
        let helper = RealtimeNetworkTests()
        let server = CoordinatorServer(), clock = CoordinatorClock(), mode = StabSwitch()
        mode.down = true
        let network = try downNetwork(server, mode), store = plainStore(network, clock, saved: true)
        defer { store.disconnect() }
        await store.connect()
        XCTAssertEqual(store.connectionStatus, .failed)
        XCTAssertNotNil(store.errorMessage)
        await helper.eventually { await clock.deadlines == [.seconds(1)] }
        await clock.advance(.seconds(1))
        await helper.eventually { network.requests.count == 2 }
        await helper.eventually { await clock.deadlines == [.seconds(3)] }
        XCTAssertEqual(store.connectionStatus, .failed)
        mode.down = false
        await clock.advance(.seconds(2))
        await helper.eventually { store.connectionStatus == .connected && store.state?.project.id == "p" }
        XCTAssertNil(store.errorMessage)
    }

    func testRejectedCodeUnsavedConnectionAndEditedFieldsNeverRetry() async throws {
        let helper = RealtimeNetworkTests()
        // A wrong access code is not a transient failure.
        let clock = CoordinatorClock()
        let rejected = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 401) }
        let refused = plainStore(rejected, clock, saved: true)
        await refused.connect()
        XCTAssertEqual(refused.connectionStatus, .failed)
        await helper.settle()
        var deadlines = await clock.deadlines
        XCTAssertTrue(deadlines.isEmpty)
        refused.disconnect()

        // A connection typed by hand is left to its "다시 시도" button.
        let server = CoordinatorServer(), mode = StabSwitch()
        mode.down = true
        let network = try downNetwork(server, mode), manual = plainStore(network, clock)
        await manual.connect()
        XCTAssertEqual(manual.connectionStatus, .failed)
        await helper.settle()
        deadlines = await clock.deadlines
        XCTAssertTrue(deadlines.isEmpty)
        manual.disconnect()

        // Editing the fields while a retry waits never reconnects with the old values.
        let edited = plainStore(network, clock, saved: true)
        defer { edited.disconnect() }
        await edited.connect()
        await helper.eventually { await clock.deadlines.count == 1 }
        let before = network.requests.count
        edited.accessCode = "changed"
        await clock.advance(.seconds(1)); await helper.settle()
        XCTAssertEqual(network.requests.count, before)
        XCTAssertEqual(edited.connectionStatus, .failed)
    }

    func testReturningToTheAppOrRestoredNetworkRetriesAtOnce() async throws {
        let helper = RealtimeNetworkTests()
        for trigger in ["foreground", "path"] {
            let server = CoordinatorServer(), clock = CoordinatorClock(), mode = StabSwitch()
            mode.down = true
            let network = try downNetwork(server, mode), store = plainStore(network, clock, saved: true)
            await store.connect()
            XCTAssertEqual(store.connectionStatus, .failed, trigger)
            await helper.eventually { await clock.deadlines.count == 1 }
            mode.down = false
            if trigger == "foreground" {
                store.setForeground(false)
                await helper.eventually { await clock.deadlines.isEmpty }
                store.setForeground(true)
            } else {
                store.networkPathChanged(satisfied: false)
                store.networkPathChanged(satisfied: true)
            }
            // No clock advance: the retry does not wait for the backoff.
            await helper.eventually { store.connectionStatus == .connected }
            store.disconnect()
        }
    }

    // MARK: n-net-2 — one heavy read per connect

    func testConnectReadsTheWorkspaceWithOneSyncAndNoSecondBootstrap() async throws {
        let helper = RealtimeNetworkTests()
        let server = CoordinatorServer(), clock = CoordinatorClock()
        let network = try IsolatedTestNetwork(handler: server.handle), store = plainStore(network, clock)
        defer { store.disconnect() }
        await store.connect()
        XCTAssertEqual(store.state?.project.id, "p")
        XCTAssertTrue(store.canWrite)
        XCTAssertEqual(count(network, "/api/bootstrap"), 1)
        XCTAssertEqual(count(network, "/api/projects/p/state"), 0)
        XCTAssertEqual(server.read { $0.syncs }, 1)
    }

    func testSlowCapabilityProbeDelaysTheWorkspaceByOneSecondAtMostAndReusesBootstrap() async throws {
        let helper = RealtimeNetworkTests()
        let server = CoordinatorServer(), clock = CoordinatorClock(), mode = StabSwitch(), probe = StabGate()
        mode.hold("/api/capabilities", probe)
        let network = try downNetwork(server, mode), store = plainStore(network, clock)
        defer { store.disconnect() }
        let connect = Task { await store.connect() }
        await helper.eventually { await clock.deadlines.contains(.seconds(1)) }
        XCTAssertNil(store.state)
        await clock.advance(.seconds(1))
        await helper.eventually { store.state?.project.id == "p" }
        XCTAssertFalse(store.canWrite)
        XCTAssertEqual(count(network, "/api/bootstrap"), 1, "The bootstrap that authenticated the connection is reused")
        XCTAssertEqual(count(network, "/api/projects/p/state"), 1)
        await probe.open(); await connect.value
        XCTAssertTrue(store.canWrite)
        XCTAssertEqual(server.read { $0.syncs }, 1)
    }

    func testHelloAtTheCursorJustReadDoesNotReadAgainButANewerOneDoes() async throws {
        let helper = RealtimeNetworkTests()
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = AppStore(session: network.session, persistCredentials: false,
            realtime: RealtimeClient(factory: factory, clock: clock), clock: clock, retryJitter: { $0 })
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        defer { store.disconnect() }
        await store.connect()
        await helper.eventually { await factory.sockets.count == 1 }
        guard let first = await factory.sockets.first else { XCTFail("Missing socket"); return }
        XCTAssertEqual(server.read { $0.syncs }, 1)
        try await helper.hello(first)
        // No clock advance: nothing is read, so nothing waits for the minimum interval.
        await helper.eventually { store.realtimeStatus == .live }
        await helper.settle()
        XCTAssertEqual(server.read { $0.syncs }, 1)
        XCTAssertTrue(store.canWrite)

        // The socket drops, the fallback reads, and the server moves on before the next hello.
        try await first.enqueue(.failure(URLError(.networkConnectionLost)))
        await helper.eventually { server.read { $0.syncs } == 2 }
        await helper.settle(); await clock.advance(.milliseconds(500))
        await helper.eventually { await factory.sockets.count == 2 }
        guard let second = await factory.sockets.dropFirst().first else { XCTFail("Missing socket 2"); return }
        server.change { $0.seq = 3 }
        try await helper.hello(second, seq: 3)
        await helper.eventually { store.appliedSnapshotCursor?.seq == 3 && store.realtimeStatus == .live }
        XCTAssertEqual(server.read { $0.syncs }, 3)
        XCTAssertEqual(store.state?.project.name, "seq-3")
    }

    // MARK: x-conn-2 / n-net-5 — a socket restart during a read

    func testSyncFailureThatOverlapsASocketRestartStillCountsTowardOffline() async throws {
        let helper = RealtimeNetworkTests()
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets(), mode = StabSwitch()
        let network = try downNetwork(server, mode)
        guard let store = try await helper.connected(server, network, clock, factory), let socket = await factory.sockets.first else { return }
        defer { store.disconnect() }
        // The server stops answering: the read in flight is held, every later one fails at once.
        let held = StabGate()
        server.change { $0.syncStatus = 504 }
        mode.hold("/api/sync", held)
        let read = Task { await store.refresh() }
        await helper.settle(); await clock.advance(.milliseconds(500))
        await helper.eventually { await held.entered == 1 }
        try await socket.enqueue(.failure(URLError(.networkConnectionLost)))
        await helper.eventually { store.socketFailures == 1 }
        XCTAssertEqual(store.restFailures, 0)
        await held.open()
        // No clock advance: the held read and the one the socket failure queued behind it are the only reads.
        // Discarding the held read's failure would leave the count at one.
        await helper.eventually { store.restFailures == 2 }
        await helper.settle()
        XCTAssertEqual(store.restFailures, 2)
        XCTAssertNotNil(store.connectionIssue)
        XCTAssertFalse(store.canWrite)
        await read.value
    }

    func testSnapshotThatOverlapsASocketRestartIsAppliedInsteadOfDiscarded() async throws {
        let helper = RealtimeNetworkTests()
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets(), mode = StabSwitch()
        let network = try downNetwork(server, mode)
        guard let store = try await helper.connected(server, network, clock, factory), let socket = await factory.sockets.first else { return }
        defer { store.disconnect() }
        server.change { $0.seq = 1 }
        let held = StabGate()
        mode.hold("/api/sync", held)
        let read = Task { await store.refresh() }
        await helper.settle(); await clock.advance(.milliseconds(500))
        await helper.eventually { await held.entered == 1 }
        try await socket.enqueue(.failure(URLError(.networkConnectionLost)))
        await helper.eventually { store.socketFailures == 1 }
        await held.open()
        // No clock advance: the state can only come from the read that was already in flight.
        await helper.eventually { store.state?.project.name == "seq-1" }
        XCTAssertEqual(store.appliedSnapshotCursor?.seq, 1)
        XCTAssertEqual(store.restFailures, 0)
        await read.value
    }

    // MARK: x-conn-4 — the "checking" notice waits two seconds after a return

    func testReturningToTheAppLocksWritesButShowsTheCheckingNoticeOnlyAfterTwoSeconds() async throws {
        let helper = RealtimeNetworkTests()
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets(), mode = StabSwitch()
        let network = try downNetwork(server, mode)
        guard let store = try await helper.connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        store.setForeground(false); await helper.settle()
        let held = StabGate()
        mode.hold("/api/sync", held)
        let returned = await clock.now()
        store.setForeground(true)
        XCTAssertFalse(store.canWrite)
        XCTAssertNil(store.connectionNotice)
        XCTAssertEqual(store.writeBlockedReason, "최신 상태를 다시 확인하는 중입니다")
        await helper.eventually { await held.entered == 1 }
        await helper.eventually { await clock.deadlines.contains(returned + .seconds(2)) }
        await clock.advance(.milliseconds(1999)); await helper.settle()
        XCTAssertNil(store.connectionNotice)
        await clock.advance(.milliseconds(1))
        await helper.eventually { store.connectionNotice == "잠시 연결을 확인하는 중" }
        await held.open()
        await helper.eventually { store.connectionNotice == nil && !store.isRevalidating }
        XCTAssertTrue(store.canWrite)
    }

    // MARK: x-conn-8 — the route changed without a loss

    func testChangedInterfacesReopenTheSocketOnceAfterTheBurstSettles() async throws {
        let helper = RealtimeNetworkTests()
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await helper.connected(server, network, clock, factory), let socket = await factory.sockets.first else { return }
        defer { store.disconnect() }
        let before = server.read { $0.syncs }
        store.networkPathChanged(satisfied: true, interfaces: "en0:wifi")
        store.networkPathChanged(satisfied: true, interfaces: "en0:wifi")
        await helper.settle()
        var sockets = await factory.sockets.count
        XCTAssertEqual(sockets, 1, "The first report and an unchanged one are not a route change")
        let changed = await clock.now()
        store.networkPathChanged(satisfied: true, interfaces: "en0:wifi,utun4:other")
        store.networkPathChanged(satisfied: true, interfaces: "utun4:other,pdp_ip0:cellular")
        await helper.eventually { await clock.deadlines.contains(changed + .milliseconds(300)) }
        await helper.settle()
        sockets = await factory.sockets.count
        XCTAssertEqual(sockets, 1)
        await clock.advance(.milliseconds(300))
        await helper.eventually { await factory.sockets.count == 2 }
        await helper.eventually { server.read { $0.syncs } == before + 1 }
        let closes = await socket.closeCount
        XCTAssertEqual(closes, 1)
        await helper.settle()
        sockets = await factory.sockets.count
        XCTAssertEqual(sockets, 2, "A burst of reports reconnects once")
    }

    // MARK: n-appstore-9 / n-net-9 — one failed probe is asked again

    func testHelloFromAV2ServerRepeatsACapabilityProbeThatFailedOnce() async throws {
        let helper = RealtimeNetworkTests()
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets(), mode = StabSwitch()
        mode.fail("/api/capabilities", count: 1)
        let network = try IsolatedTestNetwork { request in
            if mode.takeFailure(request.url!.path) { return IsolatedTestHTTPReply(status: 503) }
            return try server.handle(request)
        }
        let store = AppStore(session: network.session, persistCredentials: false,
            realtime: RealtimeClient(factory: factory, clock: clock), clock: clock, retryJitter: { $0 })
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        defer { store.disconnect() }
        await store.connect()
        XCTAssertTrue(store.canWrite)
        XCTAssertEqual(count(network, "/api/capabilities"), 1)
        XCTAssertEqual(server.read { $0.syncs }, 0)
        await helper.eventually { await factory.sockets.count == 1 }
        guard let socket = await factory.sockets.first else { XCTFail("Missing socket"); return }
        try await helper.hello(socket)
        await helper.eventually { self.count(network, "/api/capabilities") == 2 }
    }

    func testPushStatusThatFailedOnceIsAskedAgainSoNotificationsGetTheirServer() async throws {
        let helper = RealtimeNetworkTests()
        let server = CoordinatorServer(), clock = CoordinatorClock(), mode = StabSwitch()
        mode.fail("/api/push/status", count: 1)
        let serverID = "277551bf-cf60-4ecd-a450-1fd3e695a8d8"
        let network = try IsolatedTestNetwork { request in
            let path = request.url!.path
            if mode.takeFailure(path) { return IsolatedTestHTTPReply(status: 503) }
            if path == "/api/push/status" {
                return IsolatedTestHTTPReply(data: try JSONEncoder().encode(PushStatus(serverId: serverID, supported: true, providers: [])))
            }
            return try server.handle(request)
        }
        let store = plainStore(network, clock)
        defer { store.disconnect() }
        await store.connect()
        XCTAssertNil(store.serverID)
        XCTAssertEqual(store.pushConnectionError, .requestFailed(503))
        await helper.eventually { await clock.deadlines.contains(.seconds(5)) }
        await clock.advance(.seconds(5))
        await helper.eventually { store.serverID == serverID }
        XCTAssertNil(store.pushConnectionError)
    }

    // MARK: x-conn-3 — the Mac keeps syncing behind another app

    func testMacKeepsSyncingWhileInactiveAndRestsOnlyInBackground() {
        XCTAssertTrue(ApplicationLifecycle.syncs(in: .active))
        XCTAssertFalse(ApplicationLifecycle.syncs(in: .background))
        #if os(macOS)
        XCTAssertTrue(ApplicationLifecycle.syncs(in: .inactive))
        #else
        XCTAssertFalse(ApplicationLifecycle.syncs(in: .inactive))
        #endif
    }
}
