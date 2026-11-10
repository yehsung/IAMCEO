import Foundation
import XCTest
@testable import IAMCEO

/// A monotonic clock shared by the transport watchdog and the AppStore coordinator.
actor CoordinatorClock: RealtimeClock {
    private var time: Duration = .zero
    private var sleepers: [UUID: (Duration, TestDeadlineContinuation<Void, Error>)] = [:]
    func now() -> Duration { time }
    func sleep(for duration: Duration) async throws {
        try Task.checkCancellation()
        guard duration > .zero else { return }
        let id = UUID(), deadline = time + duration
        try await withTaskCancellationHandler {
            try await withThrowingTestDeadline { continuation in
                sleepers[id] = (deadline, continuation)
            }
        } onCancel: { Task { await self.cancel(id) } }
    }
    private func cancel(_ id: UUID) { sleepers.removeValue(forKey: id)?.1.resume(throwing: CancellationError()) }
    func advance(_ duration: Duration) {
        time += duration
        for (id, sleeper) in sleepers where sleeper.0 <= time {
            sleepers.removeValue(forKey: id)?.1.resume()
        }
    }
    var deadlines: [Duration] { sleepers.values.map(\.0) }
}

actor CoordinatorSockets: RealtimeTransportFactory {
    private(set) var sockets: [IsolatedTestWebSocket] = []
    private(set) var requests: [URLRequest] = []
    func connect(request: URLRequest) throws -> any RealtimeTransport {
        let query = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems } ?? []
        guard request.url?.port != 7878, request.url?.path == "/ws",
              query.filter({ $0.name == "v" }) == [URLQueryItem(name: "v", value: "2")],
              request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture" else { throw URLError(.unsupportedURL) }
        requests.append(request)
        let socket = IsolatedTestWebSocket(); sockets.append(socket)
        return socket
    }
}

final class CoordinatorServer: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    var epoch = "E"
    var seq = 0
    var syncStatus = 200
    var syncBody: String?
    var syncError: URLError.Code?
    var missing = false
    var gate: DispatchSemaphore?
    var entered: XCTestExpectation?
    var syncs = 0
    var simultaneous = 0
    var maximumSimultaneous = 0
    var runtimeReads = 0
    var activityReads = 0
    var pageReads = 0
    var activeProjects = [ProjectSummary(id: "p"), ProjectSummary(id: "q")]
    func change(_ body: (CoordinatorServer) -> Void) { lock.withLock { body(self) } }
    func read<T>(_ body: (CoordinatorServer) -> T) -> T { lock.withLock { body(self) } }
    private func reply<T: Encodable>(_ value: T) throws -> IsolatedTestHTTPReply {
        IsolatedTestHTTPReply(data: try JSONEncoder().encode(value))
    }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        lock.lock(); defer { lock.unlock() }
        let path = request.url!.path
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let projectID = query.first { $0.name == "projectId" }?.value
        let bootstrap = Bootstrap(projects: activeProjects)
        func state(_ id: String) -> ProjectState {
            ProjectState(project: Project(id: id, name: "seq-\(seq)"), members: [Member(id: "m", projectId: id)])
        }
        switch path {
        case "/api/bootstrap": return try reply(bootstrap)
        case "/api/capabilities":
            return try reply(ServerCapabilities(contractVersion: 2, capabilities: CapabilityFlags(paging: true, realtime: true)))
        case "/api/runtime": runtimeReads += 1; return IsolatedTestHTTPReply()
        case "/api/decisions/d/answer":
            seq += 1
            return try reply(Decision(id: "d", projectId: "p", status: "answered"))
        case "/api/projects/p/state": return try reply(state("p"))
        case "/api/projects/q/state": return try reply(state("q"))
        case "/api/sync":
            syncs += 1
            if let syncError { throw URLError(syncError) }
            if let syncBody { return IsolatedTestHTTPReply(status: syncStatus, data: Data(syncBody.utf8)) }
            if syncStatus != 200 { return IsolatedTestHTTPReply(status: syncStatus) }
            simultaneous += 1; maximumSimultaneous = max(maximumSimultaneous, simultaneous)
            let snapshot = try reply(SyncSnapshot(protocolVersion: 2, cursor: SyncCursor(epoch: epoch, seq: seq),
                requestedProjectId: projectID, projectStatus: projectID == nil ? .none : missing ? .archived : .ok,
                bootstrap: bootstrap, state: projectID.flatMap { missing ? nil : state($0) }, revisions: nil))
            if let gate {
                self.gate = nil; let entered = self.entered
                lock.unlock(); entered?.fulfill(); XCTAssertEqual(gate.wait(timeout: .now() + 5), .success, "Fixture gate timed out"); lock.lock()
            }
            simultaneous -= 1
            return snapshot
        case "/api/members/m/activity":
            activityReads += 1
            return try reply([Activity(id: activityReads, memberId: "m", text: "observed")])
        case "/api/projects/p/messages/page":
            pageReads += 1
            return try reply(MessagePage(projectId: "p", scope: .project, items: [], nextCursor: nil, hasOlder: false))
        default: return IsolatedTestHTTPReply(status: 404)
        }
    }
}

@MainActor final class RealtimeNetworkTests: XCTestCase {
    func eventually(_ predicate: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<1000 {
            if await predicate() { return }
            try? await Task.sleep(for: .milliseconds(1))
        }
        XCTFail("Coordinator did not settle", file: file, line: line)
    }
    func settle() async { for _ in 0..<30 { await Task.yield() }; try? await Task.sleep(for: .milliseconds(10)) }
    func frame(_ socket: IsolatedTestWebSocket, _ text: String) async throws { try await socket.enqueue(.success(Data(text.utf8))) }
    func hello(_ socket: IsolatedTestWebSocket, epoch: String = "E", seq: Int = 0) async throws {
        try await frame(socket, "{\"type\":\"hello\",\"protocol\":2,\"epoch\":\"\(epoch)\",\"seq\":\(seq),\"heartbeatMs\":15000,\"staleAfterMs\":45000}")
    }
    func connected(_ server: CoordinatorServer, _ network: IsolatedTestNetwork,
                   _ clock: CoordinatorClock, _ factory: CoordinatorSockets, lowPower: Bool = false) async throws -> AppStore? {
        let store = AppStore(session: network.session, persistCredentials: false,
            realtime: RealtimeClient(factory: factory, clock: clock), clock: clock, retryJitter: { $0 }, lowPowerMode: lowPower)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect()
        await eventually { await factory.sockets.count == 1 }
        guard let socket = await factory.sockets.first else {
            XCTFail("Expected the initial coordinator socket")
            store.disconnect()
            return nil
        }
        let url = await factory.requests.first?.url
        let query = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems }
        XCTAssertEqual(query?.filter { $0.name == "lite" }, [URLQueryItem(name: "lite", value: "1")])
        try await hello(socket)
        await eventually { store.realtimeStatus == .syncing || store.realtimeStatus == .live }
        await settle(); await clock.advance(lowPower ? .seconds(1) : .milliseconds(500))
        await eventually { store.realtimeStatus == .live }
        XCTAssertTrue(store.canWrite)
        return store
    }

    func testBurstUsesFixed250msWindowAndPreservesChangesDuringSingleFlight() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        guard let socket = await factory.sockets.first else { XCTFail("Expected the initial coordinator socket"); return }
        await clock.advance(.seconds(1))
        let before = server.read { $0.syncs }
        for n in 1...30 {
            server.change { $0.seq = n }
            try await frame(socket, "{\"type\":\"future\",\"epoch\":\"E\",\"seq\":\(n)}")
        }
        await eventually { store.receivedCursor?.seq == 30 }
        await settle(); await clock.advance(.milliseconds(249)); await settle()
        XCTAssertEqual(server.read { $0.syncs }, before)
        let gate = DispatchSemaphore(value: 0), entered = expectation(description: "snapshot in flight")
        server.change { $0.gate = gate; $0.entered = entered }
        await clock.advance(.milliseconds(1))
        await fulfillment(of: [entered], timeout: 2)
        for n in 31...50 {
            server.change { $0.seq = n }
            try await frame(socket, "{\"type\":\"future\",\"epoch\":\"E\",\"seq\":\(n)}")
        }
        await eventually { store.receivedCursor?.seq == 50 }
        gate.signal()
        await eventually { store.appliedSnapshotCursor?.seq == 30 }
        XCTAssertEqual(server.read { $0.syncs }, before + 1)
        await settle(); await clock.advance(.milliseconds(499)); await settle()
        XCTAssertEqual(server.read { $0.syncs }, before + 1)
        await clock.advance(.milliseconds(1))
        await eventually { store.appliedSnapshotCursor?.seq == 50 }
        XCTAssertEqual(server.read { $0.syncs }, before + 2)
        XCTAssertEqual(server.read { $0.maximumSimultaneous }, 1)
        XCTAssertEqual(store.state?.project.name, "seq-50")
    }

    func testHeartbeatFiveMinutesHasNoPeriodicSnapshotHistoryOrRuntimeReads() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        await store.activateHistory()
        let baseline = network.requests.count, updated = store.lastUpdated
        guard let socket = await factory.sockets.first else { XCTFail("Expected the initial coordinator socket"); return }
        for _ in 0..<20 {
            await clock.advance(.seconds(15))
            try await frame(socket, #"{"type":"ping","epoch":"E","seq":0}"#)
            await settle()
        }
        XCTAssertEqual(network.requests.count, baseline)
        XCTAssertEqual(store.lastUpdated, updated)
        XCTAssertNotNil(store.lastHeartbeatAt)
        XCTAssertEqual(store.realtimeStatus, .live)
        XCTAssertEqual(server.read { $0.runtimeReads }, 1)
    }

    func testSequenceFilteringGapAndHeartbeatHighWaterConverge() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        guard let socket = await factory.sockets.first else { XCTFail("Expected the initial coordinator socket"); return }
        let before = server.read { $0.syncs }
        try await frame(socket, #"{"type":"work","epoch":"E","seq":1,"projectId":"q","work":[]}"#)
        await eventually { store.receivedCursor?.seq == 1 }
        await clock.advance(.seconds(1)); await settle()
        XCTAssertEqual(server.read { $0.syncs }, before)
        server.change { $0.seq = 3 }
        try await frame(socket, #"{"type":"work","epoch":"E","seq":3,"projectId":"q","work":[]}"#)
        await eventually { store.receivedCursor?.seq == 3 }
        await settle(); await clock.advance(.milliseconds(250))
        await eventually { store.appliedSnapshotCursor?.seq == 3 }
        let afterGap = server.read { $0.syncs }
        try await frame(socket, #"{"type":"future","epoch":"E","seq":2}"#)
        await settle(); await clock.advance(.seconds(1)); await settle()
        XCTAssertEqual(server.read { $0.syncs }, afterGap)
        server.change { $0.seq = 7 }
        try await frame(socket, #"{"type":"ping","epoch":"E","seq":7}"#)
        await eventually { store.receivedCursor?.seq == 7 }
        await settle(); await clock.advance(.milliseconds(250))
        await eventually { store.appliedSnapshotCursor?.seq == 7 }
    }

    func testActivityOnlyRefreshesOpenMemberAndMessagesRefreshVisibleHistory() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        guard let socket = await factory.sockets.first else { XCTFail("Expected the initial coordinator socket"); return }
        await store.activateHistory(); await store.activateActivity(memberID: "m")
        let before = server.read { ($0.syncs, $0.activityReads, $0.pageReads) }
        try await frame(socket, #"{"type":"activity","epoch":"E","seq":1,"projectId":"p","activity":{"id":1,"memberId":"m"}}"#)
        await eventually { store.activityRevisions["m"] == 1 }
        await settle(); await clock.advance(.milliseconds(250))
        await eventually { server.read { $0.activityReads } == before.1 + 1 }
        XCTAssertEqual(server.read { $0.syncs }, before.0)
        store.deactivateActivity(memberID: "m")
        try await frame(socket, #"{"type":"activity","epoch":"E","seq":2,"projectId":"p","activity":{"id":2,"memberId":"m"}}"#)
        await settle(); await clock.advance(.seconds(1)); await settle()
        XCTAssertEqual(server.read { $0.activityReads }, before.1 + 1)
        server.change { $0.seq = 3 }
        try await frame(socket, #"{"type":"message","epoch":"E","seq":3,"message":{"id":"new","projectId":"p","body":"hello"}}"#)
        await eventually { store.receivedCursor?.seq == 3 }
        await settle(); await clock.advance(.milliseconds(250))
        await eventually { server.read { $0.pageReads } == before.2 + 1 }
        XCTAssertEqual(store.historyMessages.last?.id, "new")
    }

    func testForegroundResumeRevalidatesWithoutNewHostSocketOnProjectSwitch() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        let switchProject = Task { await store.selectProject(id: "q") }
        await settle(); await clock.advance(.milliseconds(500)); await switchProject.value
        XCTAssertEqual(store.state?.project.id, "q")
        let sockets = await factory.sockets.count; XCTAssertEqual(sockets, 1)
        store.setForeground(false); await settle()
        let before = network.requests.count
        await clock.advance(.seconds(600)); await settle()
        XCTAssertEqual(network.requests.count, before)
        XCTAssertEqual(store.realtimeStatus, .paused)
        store.setForeground(true)
        XCTAssertFalse(store.canWrite)
        await eventually { await factory.sockets.count == 2 }
        await eventually { !store.isRevalidating }
        XCTAssertTrue(store.canWrite)
        store.disconnect(); await settle()
        let stopped = network.requests.count
        await clock.advance(.seconds(600)); await settle()
        XCTAssertEqual(network.requests.count, stopped)
    }

    func testInitialBackgroundAndDemoNeverOpenSocket() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = AppStore(session: network.session, persistCredentials: false,
            realtime: RealtimeClient(factory: factory, clock: clock), clock: clock)
        store.setForeground(false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect(); await settle()
        XCTAssertTrue(network.requests.isEmpty)
        let sockets = await factory.sockets.count; XCTAssertEqual(sockets, 0)
        let count = network.requests.count
        await clock.advance(.seconds(600)); await settle()
        XCTAssertEqual(network.requests.count, count)
        store.disconnect()
        let demo = AppStore(demo: true, session: network.session, persistCredentials: false,
            realtime: RealtimeClient(factory: factory, clock: clock), clock: clock)
        await demo.connect(); await demo.refresh(); demo.setForeground(true)
        XCTAssertEqual(network.requests.count, count)
    }

    func testPostWriteRefreshAndEventJoinPendingSnapshotWithoutCancellingIt() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        guard let socket = await factory.sockets.first else { XCTFail("Expected the initial coordinator socket"); return }
        let before = server.read { $0.syncs }
        let gate = DispatchSemaphore(value: 0), entered = expectation(description: "pre-write read")
        server.change { $0.gate = gate; $0.entered = entered }
        let refresh = Task { await store.refresh() }
        await settle(); await clock.advance(.milliseconds(500))
        await fulfillment(of: [entered], timeout: 2)
        let write = Task { await store.answerDecision(Decision(id: "d", projectId: "p", updatedAt: "reviewed"), choice: nil, note: "answer") }
        // URLProtocol's synchronous handler serializes replies. Release the held read after
        // submitting the write; both its completion refresh and the event must still coalesce.
        gate.signal()
        await eventually { server.read { $0.seq } == 1 }
        try await frame(socket, #"{"type":"decision","epoch":"E","seq":1,"decision":{"id":"d","projectId":"p"}}"#)
        await eventually { store.receivedCursor?.seq == 1 }
        XCTAssertEqual(server.read { $0.syncs }, before + 1)
        await settle(); await clock.advance(.milliseconds(500))
        await refresh.value
        let accepted = await write.value
        XCTAssertTrue(accepted)
        XCTAssertEqual(server.read { $0.syncs }, before + 2)
        XCTAssertEqual(server.read { $0.maximumSimultaneous }, 1)
        XCTAssertEqual(store.appliedSnapshotCursor?.seq, 1)
    }

    func testProjectSwitchDiscardsOldSnapshotAndKeepsSocketGeneration() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        let gate = DispatchSemaphore(value: 0), entered = expectation(description: "old project read")
        server.change { $0.gate = gate; $0.entered = entered }
        let refresh = Task { await store.refresh() }
        await settle(); await clock.advance(.milliseconds(500))
        await fulfillment(of: [entered], timeout: 2)
        let selection = Task { await store.selectProject(id: "q") }
        await settle()
        XCTAssertEqual(store.selectedProjectID, "q")
        XCTAssertNil(store.state)
        gate.signal()
        await clock.advance(.milliseconds(500))
        await selection.value; await refresh.value; await settle()
        XCTAssertEqual(store.selectedProjectID, "q")
        XCTAssertEqual(store.state?.project.id, "q")
        let sockets = await factory.sockets.count
        XCTAssertEqual(sockets, 1)
    }

    func testLowPowerUses500msBatchAndOneSnapshotPerSecond() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await connected(server, network, clock, factory, lowPower: true) else { return }
        defer { store.disconnect() }
        guard let socket = await factory.sockets.first else { XCTFail("Expected the initial coordinator socket"); return }
        let before = server.read { $0.syncs }
        await clock.advance(.seconds(1))
        server.change { $0.seq = 1 }
        try await frame(socket, #"{"type":"future","epoch":"E","seq":1}"#)
        await eventually { store.receivedCursor?.seq == 1 }
        await settle(); await clock.advance(.milliseconds(499)); await settle()
        XCTAssertEqual(server.read { $0.syncs }, before)
        await clock.advance(.milliseconds(1))
        await eventually { store.appliedSnapshotCursor?.seq == 1 }
        server.change { $0.seq = 2 }
        try await frame(socket, #"{"type":"future","epoch":"E","seq":2}"#)
        await eventually { store.receivedCursor?.seq == 2 }
        await settle(); await clock.advance(.milliseconds(999)); await settle()
        XCTAssertEqual(server.read { $0.syncs }, before + 1)
        await clock.advance(.milliseconds(1))
        await eventually { store.appliedSnapshotCursor?.seq == 2 }
    }

    func testSocketBackoffResetsAfterHelloAndSuccessfulSync() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        guard let store = try await connected(server, network, clock, factory) else { return }
        defer { store.disconnect() }
        guard var socket = await factory.sockets.first else { XCTFail("Expected the initial coordinator socket"); return }
        try await socket.enqueue(.failure(URLError(.networkConnectionLost)))
        await eventually { store.realtimeStatus == .fallback }
        await settle(); await clock.advance(.milliseconds(500))
        await eventually { await factory.sockets.count == 2 }
        guard let nextSocket1 = await factory.sockets.dropFirst(1).first else { XCTFail("Expected coordinator socket 2"); return }
        socket = nextSocket1
        try await hello(socket)
        await settle(); await clock.advance(.milliseconds(500))
        await eventually { store.realtimeStatus == .live }
        XCTAssertEqual(store.socketFailures, 0)
        XCTAssertEqual(store.restFailures, 0)
        try await socket.enqueue(.failure(URLError(.networkConnectionLost)))
        await eventually { store.realtimeStatus == .fallback }
        await settle(); await clock.advance(.milliseconds(499)); await settle()
        let before = await factory.sockets.count; XCTAssertEqual(before, 2)
        await clock.advance(.milliseconds(1))
        await eventually { await factory.sockets.count == 3 }
        guard let nextSocket2 = await factory.sockets.dropFirst(2).first else { XCTFail("Expected coordinator socket 3"); return }
        socket = nextSocket2
        try await hello(socket)
        await settle(); await clock.advance(.milliseconds(500))
        await eventually { store.realtimeStatus == .live }
        for _ in 0..<2 {
            await clock.advance(.seconds(15))
            try await frame(socket, #"{"type":"ping","epoch":"E","seq":0}"#)
            await settle()
        }
        try await socket.enqueue(.failure(URLError(.networkConnectionLost)))
        await eventually { store.realtimeStatus == .fallback }
        await settle(); await clock.advance(.milliseconds(499)); await settle()
        let stillWaiting = await factory.sockets.count; XCTAssertEqual(stillWaiting, 3)
        await clock.advance(.milliseconds(1))
        await eventually { await factory.sockets.count == 4 }
    }
}
