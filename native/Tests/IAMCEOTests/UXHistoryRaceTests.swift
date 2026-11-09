import Foundation
import XCTest
@testable import IAMCEO

private actor UXHistoryRaceGate {
    let entered: XCTestExpectation
    private var waiter: TestDeadlineContinuation<Void, Never>?
    private var released = false

    init(_ entered: XCTestExpectation) { self.entered = entered }
    func wait() async {
        guard !released else { return }
        await withTestDeadline(fallback: ()) {
            waiter = $0
            entered.fulfill()
        }
    }
    func release() { released = true; waiter?.resume(); waiter = nil }
}

/// HTTP is intercepted by IsolatedTestNetwork; no socket, persisted credentials or app defaults.
private final class UXHistoryRaceServer: @unchecked Sendable {
    private let lock = NSLock()
    private var pages = 0
    private var gates: [Int: UXHistoryRaceGate] = [:]
    private var cancellations = 0

    var pageCount: Int { lock.withLock { pages } }
    func holdPage(_ index: Int, at gate: UXHistoryRaceGate) { lock.withLock { gates[index] = gate } }
    func cancelNextPage() { lock.withLock { cancellations += 1 } }
    private func reply<T: Encodable>(_ value: T) throws -> IsolatedTestHTTPReply {
        IsolatedTestHTTPReply(data: try JSONEncoder().encode(value))
    }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        let path = request.url!.path
        switch path {
        case "/api/bootstrap":
            return try reply(Bootstrap(projects: [ProjectSummary(id: "p"), ProjectSummary(id: "q")]))
        case "/api/runtime", "/api/capabilities": return IsolatedTestHTTPReply()
        case "/api/projects/p/state", "/api/projects/q/state":
            return try reply(ProjectState(project: Project(id: path.contains("/p/") ? "p" : "q")))
        case "/api/projects/p/messages/page", "/api/projects/q/messages/page":
            let (gate, cancelled) = lock.withLock {
                let index = pages
                pages += 1
                let cancelled = cancellations > 0
                if cancelled { cancellations -= 1 }
                return (gates.removeValue(forKey: index), cancelled)
            }
            if cancelled { throw URLError(.cancelled) }
            let project = path.contains("/p/") ? "p" : "q"
            var response = try reply(MessagePage(projectId: project, scope: .project,
                items: [Message(id: "\(project)-history", projectId: project, at: "1")], nextCursor: nil, hasOlder: false))
            if let gate { response.beforeDelivery = { await gate.wait() } }
            return response
        default: return IsolatedTestHTTPReply(status: 404)
        }
    }
}

@MainActor final class UXHistoryRaceTests: XCTestCase {
    /// The watchdog bounds even a broken AppStore task; no test awaits Task.value directly.
    private func finish<Value: Sendable>(_ task: Task<Value, Never>,
                                        file: StaticString = #filePath, line: UInt = #line) async {
        await withTestDeadline(fallback: (), file: file, line: line) { done in
            Task { _ = await task.value; done.resume() }
        }
        task.cancel()
    }
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await finish(Task { await store.connect() })
        XCTAssertEqual(store.connectionStatus, .connected)
        await finish(Task { await store.selectProject(id: "p") })
        return store
    }
    private func activate(_ store: AppStore, owner: UUID, started: XCTestExpectation? = nil) -> Task<UUID, Never> {
        Task {
            started?.fulfill()
            return await store.activateHistory(ownerID: owner)
        }
    }

    func testProjectReplacementAndDuplicateActivationIgnoreOldDisappearance() async throws {
        let server = UXHistoryRaceServer()
        let network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        let oldOwner = UUID(), newOwner = UUID()
        await finish(activate(store, owner: oldOwner))
        await finish(Task { await store.selectProject(id: "q") })
        let entered = expectation(description: "new project's initial page")
        let gate = UXHistoryRaceGate(entered)
        server.holdPage(1, at: gate)
        let fresh = activate(store, owner: newOwner)
        await fulfillment(of: [entered], timeout: 3)
        let joined = expectation(description: "same owner joins initial flight")
        let duplicate = activate(store, owner: newOwner, started: joined)
        await fulfillment(of: [joined], timeout: 3)
        store.deactivateHistory(ownerID: oldOwner)
        XCTAssertNotNil(store.history?.loading)
        await gate.release()
        await finish(fresh); await finish(duplicate)
        XCTAssertEqual(store.history?.initialized, true)
        XCTAssertEqual(store.historyMessages.map(\.id), ["q-history"])
        XCTAssertEqual(store.pagingSupport, .supported)
        XCTAssertNil(store.history?.loading); XCTAssertNil(store.history?.error)
        XCTAssertEqual(server.pageCount, 2)
    }

    func testNewOwnerOfSameScopeKeepsSharedFlightAlive() async throws {
        let server = UXHistoryRaceServer()
        let network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        let entered = expectation(description: "initial page")
        let gate = UXHistoryRaceGate(entered)
        server.holdPage(0, at: gate)
        let oldOwner = UUID(), newOwner = UUID()
        let old = activate(store, owner: oldOwner)
        await fulfillment(of: [entered], timeout: 3)
        let joined = expectation(description: "new owner joins")
        let fresh = activate(store, owner: newOwner, started: joined)
        await fulfillment(of: [joined], timeout: 3)
        store.deactivateHistory(ownerID: oldOwner)
        XCTAssertNotNil(store.history?.loading)
        await gate.release()
        await finish(old); await finish(fresh)
        XCTAssertEqual(store.history?.initialized, true)
        XCTAssertEqual(store.historyMessages.map(\.id), ["p-history"])
        XCTAssertEqual(server.pageCount, 1)
    }

    func testOnlyOwnerDisappearanceCancelsAndReentryRetries() async throws {
        let server = UXHistoryRaceServer()
        let network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        let entered = expectation(description: "initial page")
        let gate = UXHistoryRaceGate(entered)
        server.holdPage(0, at: gate)
        let owner = UUID()
        let initial = activate(store, owner: owner)
        await fulfillment(of: [entered], timeout: 3)
        let generation = store.history?.generation
        store.deactivateHistory(ownerID: owner)
        // Cancellation clears the spinner synchronously, even before the service returns.
        XCTAssertNil(store.history?.loading)
        XCTAssertNotEqual(store.history?.generation, generation)
        XCTAssertNotNil(store.history?.error)
        await finish(initial)
        XCTAssertEqual(store.history?.initialized, false)
        await finish(Task { await store.refreshHistory() })
        XCTAssertEqual(server.pageCount, 1, "A closed screen must not restart history")
        await gate.release()
        await finish(activate(store, owner: UUID()))
        XCTAssertEqual(store.history?.initialized, true)
        XCTAssertNil(store.history?.loading); XCTAssertNil(store.history?.error)
        XCTAssertEqual(server.pageCount, 2)
    }

    func testTransportCancellationExposesRetryWithoutAutomaticLoop() async throws {
        let server = UXHistoryRaceServer()
        let network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        server.cancelNextPage()
        await finish(activate(store, owner: UUID()))
        XCTAssertEqual(store.history?.initialized, false)
        XCTAssertNil(store.history?.loading)
        XCTAssertNotNil(store.history?.error)
        XCTAssertEqual(server.pageCount, 1)
        await finish(Task { await store.refreshHistory() })
        XCTAssertEqual(store.history?.initialized, true)
        XCTAssertNil(store.history?.error)
        XCTAssertEqual(server.pageCount, 2)
    }

    func testSilentInitialLoadGetsOneRecoveryAttempt() async throws {
        try await exerciseSilentInitialLoad(interruptRecovery: false)
    }
    func testRepeatedSilentInterruptionStopsWithRetryControl() async throws {
        try await exerciseSilentInitialLoad(interruptRecovery: true)
    }
    private func exerciseSilentInitialLoad(interruptRecovery: Bool) async throws {
        let server = UXHistoryRaceServer()
        let network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        let firstEntered = expectation(description: "initial page")
        let firstGate = UXHistoryRaceGate(firstEntered)
        let retryEntered = expectation(description: "one recovery page")
        let retryGate = UXHistoryRaceGate(retryEntered)
        server.holdPage(0, at: firstGate); server.holdPage(1, at: retryGate)
        let initial = activate(store, owner: UUID())
        await fulfillment(of: [firstEntered], timeout: 3)
        let key = try XCTUnwrap(store.histories.activeKey)
        // Simulate an invalidated range token leaving no request and no error.
        store.histories.invalidate(projectID: key.projectID); store.histories.activate(key)
        await firstGate.release()
        await fulfillment(of: [retryEntered], timeout: 3)
        if interruptRecovery {
            store.histories.invalidate(projectID: key.projectID); store.histories.activate(key)
        }
        await retryGate.release()
        await finish(initial)
        XCTAssertEqual(server.pageCount, 2, "Recovery must have a fixed one-attempt budget")
        XCTAssertNil(store.history?.loading)
        XCTAssertEqual(store.history?.initialized, !interruptRecovery)
        if interruptRecovery { XCTAssertNotNil(store.history?.error) }
        else { XCTAssertNil(store.history?.error); XCTAssertEqual(store.pagingSupport, .supported) }
    }

    func testCancellationErrorsAndLateCompletionCannotLeaveInitialSpinner() throws {
        let key = ChatHistoryKey(namespace: "fixture", connectionGeneration: UUID(), projectID: "p", scope: .project)
        for cancellation in [CancellationError() as Error, URLError(.cancelled) as Error] {
            var history = ChatHistory(key: key)
            let stale = try XCTUnwrap(history.begin(.initial))
            history.fail(cancellation, request: stale)
            XCTAssertNil(history.loading); XCTAssertNotNil(history.error)
            let retry = try XCTUnwrap(history.begin(.initial))
            history.fail(cancellation, request: stale)
            XCTAssertEqual(history.loading, retry); XCTAssertNil(history.error)
            history.cancel()
            XCTAssertNil(history.loading); XCTAssertNotNil(history.error)
            XCTAssertFalse(history.initialized)
        }
    }
}
