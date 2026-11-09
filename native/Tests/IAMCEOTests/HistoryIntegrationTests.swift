import Foundation
import XCTest
@testable import IAMCEO

final class HistoryIntegrationServer: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    var tail = 300
    var pageStatus: Int?
    var stateStatus: Int?
    var scopeChanged = false
    var leadIsWorker = false
    var failCursor: String?
    var gate: DispatchSemaphore?
    var entered: XCTestExpectation?
    var sentID: String?
    var pageRequests = 0
    var archive = ProjectState(project: Project(id: "a", name: "Archive", archived: true),
                               members: [Member(id: "am", projectId: "a")],
                               decisions: [Decision(id: "ad", projectId: "a")],
                               todos: [Todo(id: "at", projectId: "a")], files: [FileDoc(id: "af", projectId: "a")])
    func change(_ block: (HistoryIntegrationServer) -> Void) { lock.withLock { block(self) } }
    func read<T>(_ block: (HistoryIntegrationServer) -> T) -> T { lock.withLock { block(self) } }
    static func message(_ number: Int, project: String = "p") -> Message {
        Message(id: String(format: "%05d", number), projectId: project, at: "same-time", memberId: "m", body: "row", delivery: "queued")
    }
    func reply<T: Encodable>(_ value: T) throws -> IsolatedTestHTTPReply {
        IsolatedTestHTTPReply(data: try JSONEncoder().encode(value))
    }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        lock.lock(); defer { lock.unlock() }
        let path = request.url!.path
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems ?? []
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
        switch path {
        case "/api/bootstrap": return try reply(Bootstrap(projects: [ProjectSummary(id: "p"), ProjectSummary(id: "q")]))
        case "/api/runtime", "/api/capabilities": return IsolatedTestHTTPReply()
        case "/api/projects/p/state":
            if let stateStatus { return IsolatedTestHTTPReply(status: stateStatus) }
            return try reply(ProjectState(project: Project(id: "p"), members: leadIsWorker ? [Member(id: "m", projectId: "p", kind: "conductor")] : [Member(id: "lead", projectId: "p", kind: "conductor"), Member(id: "m", projectId: "p", kind: "worker")], messages: [Self.message(299)]))
        case "/api/projects/q/state": return try reply(ProjectState(project: Project(id: "q")))
        case "/api/projects/archived": return try reply([archive.project])
        case "/api/projects/a/archive/state": return try reply(archive)
        case "/api/projects/p/messages":
            let body = try WriteTestServer.body(request)
            let id = try XCTUnwrap(body["id"] as? String)
            sentID = id
            return try reply(Message(id: id, projectId: "p", at: "zz-tail", mine: true, body: body["text"] as? String ?? "", delivery: "delivered"))
        case "/api/projects/p/messages/page", "/api/projects/a/archive/messages/page":
            pageRequests += 1
            if let pageStatus { return IsolatedTestHTTPReply(status: pageStatus) }
            if scopeChanged { scopeChanged = false; return IsolatedTestHTTPReply(status: 409, data: Data(#"{"code":"MESSAGE_SCOPE_CHANGED"}"#.utf8)) }
            let project = path.contains("/archive/") ? "a" : "p"
            let scope: MessageScope = value("scope") == "member" ? .member(memberId: value("memberId")!) : .project
            let end = value("cursor").flatMap(Int.init) ?? tail
            if value("cursor") == failCursor, failCursor != nil { throw URLError(.timedOut) }
            let limit = Int(value("limit")!)!, start = max(0, end - limit)
            let page = MessagePage(projectId: project, scope: scope, items: (start..<end).map { Self.message($0, project: project) },
                                   nextCursor: start > 0 ? String(start) : nil, hasOlder: start > 0)
            let response = try reply(page)
            if let gate {
                self.gate = nil
                let entered = self.entered
                lock.unlock(); entered?.fulfill(); XCTAssertEqual(gate.wait(timeout: .now() + 5), .success, "Fixture gate timed out"); lock.lock()
            }
            return response
        default: return IsolatedTestHTTPReply(status: 404)
        }
    }
}

@MainActor final class HistoryIntegrationTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect()
        return store
    }
    func testSnapshotRefreshPreservesOlderPagesCursorAndReadingPosition() async throws {
        let server = HistoryIntegrationServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        await store.activateHistory()
        XCTAssertEqual(store.historyMessages.count, 200)
        await store.loadOlderMessages()
        let anchor = ChatHistoryAnchor(messageID: "00101", offset: -24)
        store.setHistoryReadingPosition(anchor, pinned: false)
        for _ in 0..<3 { await store.refresh() }
        XCTAssertEqual(store.messages.count, 1)
        XCTAssertEqual(store.historyMessages.count, 300)
        XCTAssertEqual(store.history?.anchor, anchor)
        XCTAssertFalse(store.history?.hasOlder ?? true)
        XCTAssertEqual(store.history?.unreadCount, 0)
        XCTAssertEqual(store.pagingSupport, .supported)
    }
    func testSameScopeSingleFlightAndLatePageCannotUndoMessageArrival() async throws {
        let server = HistoryIntegrationServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        await store.activateHistory()
        let gate = DispatchSemaphore(value: 0), entered = expectation(description: "latest requested")
        server.change { $0.gate = gate; $0.entered = entered }
        let first = Task { await store.refreshHistory() }
        await fulfillment(of: [entered], timeout: 3)
        let second = Task { await store.refreshHistory() }
        await Task.yield()
        var updated = HistoryIntegrationServer.message(299)
        updated.delivery = "delivered"
        store.receiveHistoryMessage(updated)
        gate.signal()
        await first.value; await second.value
        XCTAssertEqual(server.read { $0.pageRequests }, 2)
        XCTAssertEqual(store.historyMessages.last?.delivery, "delivered")
        XCTAssertEqual(store.historyMessages.count, 200)
    }
    func testPostOverlaySurvivesStaleLatestPage() async throws {
        let server = HistoryIntegrationServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        await store.activateHistory()
        let sent = await store.sendMessage(text: "new instruction")
        XCTAssertTrue(sent)
        let id = try XCTUnwrap(server.read { $0.sentID })
        XCTAssertEqual(store.historyMessages.last?.id, id)
        XCTAssertEqual(store.historyMessages.last?.delivery, "delivered")
        XCTAssertEqual(store.historyMessages.filter { $0.id == id }.count, 1)
    }
    func testBridgeStagesSevenHundredRowsAndPreservesIntervalOnFailure() async throws {
        let server = HistoryIntegrationServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        await store.activateHistory()
        store.setHistoryReadingPosition(ChatHistoryAnchor(messageID: "00150", offset: -13), pinned: false)
        server.change { $0.tail = 1000 }
        await store.refreshHistory()
        XCTAssertTrue(store.history?.isBridging == true)
        XCTAssertEqual(store.historyMessages.count, 200)
        server.change { $0.failCursor = "600" }
        await store.continueHistoryBridge()
        XCTAssertNotNil(store.history?.error)
        XCTAssertEqual(store.historyMessages.count, 200)
        server.change { $0.failCursor = nil }
        await store.continueHistoryBridge()
        XCTAssertTrue(store.history?.isBridging == true)
        await store.continueHistoryBridge()
        XCTAssertFalse(store.history?.isBridging ?? true)
        XCTAssertEqual(store.historyMessages.count, 900)
        XCTAssertEqual(store.history?.unreadCount, 700)
        XCTAssertEqual(store.history?.anchor?.offset, -13)
    }
    func testMemberScopeAndReentryRestoreIndependentRange() async throws {
        let server = HistoryIntegrationServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        await store.activateHistory(targetMemberID: "lead")
        let projectKey = try XCTUnwrap(store.histories.activeKey)
        XCTAssertEqual(projectKey.scope, .project)
        store.setHistoryReadingPosition(ChatHistoryAnchor(messageID: "00123", offset: -7), pinned: false)
        await store.activateHistory(targetMemberID: "m")
        XCTAssertEqual(store.histories.activeKey?.scope, .member(memberId: "m"))
        await store.loadOlderMessages()
        await store.activateHistory()
        XCTAssertEqual(store.histories.activeKey, projectKey)
        XCTAssertEqual(store.history?.anchor?.offset, -7)
        XCTAssertEqual(store.historyMessages.count, 200)
    }
    func testPaging404RequiresSuccessfulStateProbe() async throws {
        for stateStatus in [nil, 404, 500] as [Int?] {
            let server = HistoryIntegrationServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
            let store = await connect(network)
            server.change { $0.pageStatus = 404; $0.stateStatus = stateStatus }
            await store.activateHistory()
            XCTAssertEqual(store.pagingSupport, stateStatus == nil ? .unsupported : .unknown)
            if stateStatus == nil { XCTAssertEqual(store.historyMessages.count, 1) }
            store.disconnect()
        }
    }
    func testHistory401ClearsConnectionAndCacheWhile500RemainsRetryable() async throws {
        let server = HistoryIntegrationServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        server.change { $0.pageStatus = 500 }
        await store.activateHistory()
        XCTAssertEqual(store.pagingSupport, .unknown)
        XCTAssertNotNil(store.history?.error)
        server.change { $0.pageStatus = nil }
        await store.refreshHistory()
        XCTAssertEqual(store.historyMessages.count, 200)
        server.change { $0.pageStatus = 401 }
        await store.refreshHistory()
        XCTAssertEqual(store.connectionStatus, .failed)
        XCTAssertTrue(store.histories.histories.isEmpty)
        XCTAssertNil(store.api)
    }
    func testBackgroundAndClosedHistorySendNoPageRequests() async throws {
        let server = HistoryIntegrationServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        let ownerID = await store.activateHistory()
        let count = server.read { $0.pageRequests }
        store.setForeground(false)
        await store.refreshHistory(); await store.loadOlderMessages()
        XCTAssertEqual(server.read { $0.pageRequests }, count)
        store.setForeground(true)
        store.deactivateHistory(ownerID: ownerID)
        await store.refresh()
        XCTAssertEqual(server.read { $0.pageRequests }, count)
        let demo = AppStore(demo: true, session: network.session, persistCredentials: false)
        await demo.activateHistory(); await demo.loadOlderMessages()
        XCTAssertEqual(server.read { $0.pageRequests }, count)
    }
    func testScopeChangeRenormalizesBeforeReloadingAndLegacyDoesNotAffectArchivePaging() async throws {
        let server = HistoryIntegrationServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        await store.activateHistory(targetMemberID: "m")
        XCTAssertEqual(store.histories.activeKey?.scope, .member(memberId: "m"))
        server.change { $0.scopeChanged = true; $0.leadIsWorker = true }
        await store.loadOlderMessages()
        XCTAssertEqual(store.histories.activeKey?.scope, .project)
        XCTAssertEqual(store.historyMessages.count, 200)
        server.change { $0.pageStatus = 404 }
        await store.refreshHistory()
        XCTAssertEqual(store.pagingSupport, .unsupported)
        server.change { $0.pageStatus = nil }
        await store.selectArchivedProject(id: "a")
        await store.activateHistory(); await store.loadOlderMessages()
        XCTAssertEqual(store.historyMessages.count, 300)
        XCTAssertTrue(store.histories.activeKey?.archived == true)
    }
    func testScopeSwitchDiscardsLatePageAndPreservesCachedPosition() async throws {
        let server = HistoryIntegrationServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        await store.activateHistory()
        store.setHistoryReadingPosition(ChatHistoryAnchor(messageID: "00111", offset: -19), pinned: false)
        let gate = DispatchSemaphore(value: 0), entered = expectation(description: "older requested")
        server.change { $0.gate = gate; $0.entered = entered }
        let older = Task { await store.loadOlderMessages() }
        await fulfillment(of: [entered], timeout: 3)
        let switchScope = Task { await store.activateHistory(targetMemberID: "m") }
        await Task.yield()
        gate.signal()
        await older.value; await switchScope.value
        XCTAssertEqual(store.histories.activeKey?.scope, .member(memberId: "m"))
        XCTAssertEqual(store.historyMessages.count, 200)
        await store.activateHistory()
        XCTAssertEqual(store.historyMessages.count, 200, "Cancelled older page must not be committed on reentry")
        XCTAssertEqual(store.history?.anchor?.offset, -19)
    }

    func testArchiveLoadsFullReadStateAndBlocksEveryWriteCategory() async throws {
        let server = HistoryIntegrationServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        await store.loadArchivedProjects()
        await store.selectArchivedProject(id: "a")
        XCTAssertTrue(store.isArchive)
        XCTAssertFalse(store.canWrite)
        XCTAssertEqual(store.decisions.map(\.id), ["ad"])
        XCTAssertEqual(store.todos.map(\.id), ["at"])
        XCTAssertEqual(store.files.map(\.id), ["af"])
        await store.activateHistory(); await store.loadOlderMessages(); await store.refresh()
        XCTAssertEqual(store.historyMessages.count, 300)
        let before = network.requests.count
        _ = await store.sendMessage(text: "forbidden")
        _ = await store.answerDecision(store.decisions[0], choice: nil, note: "no")
        _ = await store.setTodoDone(store.todos[0], done: true)
        _ = await store.claimTerminal(store.members[0])
        _ = await store.memberAction(store.members[0], action: "resume")
        _ = await store.upload(data: Data(), filename: "x", mime: "text/plain")
        XCTAssertEqual(network.requests.count, before)
        await store.selectProject(id: "p")
        XCTAssertTrue(store.canWrite)
    }
}
