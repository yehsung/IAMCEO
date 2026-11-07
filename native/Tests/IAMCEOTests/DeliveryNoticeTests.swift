import Foundation
import XCTest
@testable import IAMCEO

private final class DeliveryNoticeServer: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private let base = WriteTestServer()
    var needsOwner = 0
    var checking = 1
    var unassigned = 0
    var noticeStatus: Int?
    var recoveryStatus: Int?
    var dropReply = false
    var resolved = false
    var mismatchResult = false
    var version = 1
    var recoveryBodies: [[String: Any]] = []
    var results: [String: DeliveryRecoveryResult] = [:]
    var gateRecovery = false
    var gate: DispatchSemaphore?
    var entered: XCTestExpectation?
    var summary: MemberDeliverySummary {
        MemberDeliverySummary(memberId: "m", undeliveredCount: 205, unknownCount: 1, deliveringCount: 0,
                              checkingCount: checking, needsOwnerCount: needsOwner, waitingBehindCount: 3, oldestAt: "old", reasons: [])
    }
    var item: DeliveryNoticeItem {
        DeliveryNoticeItem(id: "d", deliveryId: "d", messageId: "outside-recent-200", memberId: "m", projectId: "p",
                           kind: "instruction", status: "held", phase: .needsOwner, reason: "log_missing", version: version,
                           allowedActions: [.recheck, .retryWithRisk, .stopRetry])
    }
    func change(_ body: (DeliveryNoticeServer) -> Void) { lock.withLock { body(self) } }
    func read<T>(_ body: (DeliveryNoticeServer) -> T) -> T { lock.withLock { body(self) } }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        lock.lock(); defer { lock.unlock() }
        switch request.url!.path {
        case "/api/projects/p/state":
            var state = base.state
            state.deliveryNotices = DeliveryNotices(version: 2, members: [summary], unassigned: UnassignedDeliverySummary(undeliveredCount: 10, unknownCount: 2, needsOwnerCount: unassigned))
            return try base.reply(state)
        case "/api/members/m/delivery-notices":
            if let noticeStatus { return IsolatedTestHTTPReply(status: noticeStatus) }
            let older = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems?.contains { $0.name == "before" } == true
            let other = DeliveryNoticeItem(id: "older", deliveryId: "older", memberId: "m", projectId: "p", phase: .checking, version: 1)
            let page = DeliveryNoticePage(memberId: "m", summary: summary,
                                          items: resolved ? [] : older ? [item, other] : [item], nextBefore: older || resolved ? nil : "opaque+/cursor")
            let reply = try base.reply(page)
            if let gate, !gateRecovery {
                self.gate = nil
                let entered = self.entered
                lock.unlock(); entered?.fulfill(); _ = gate.wait(timeout: .now() + 5); lock.lock()
            }
            return reply
        case "/api/deliveries/d/recovery":
            let body = try WriteTestServer.body(request)
            recoveryBodies.append(body)
            if let recoveryStatus { return IsolatedTestHTTPReply(status: recoveryStatus) }
            let id = body["operationId"] as! String
            if let result = results[id] { return try base.reply(result) }
            guard body["expectedVersion"] as? Int == version else { return IsolatedTestHTTPReply(status: 409) }
            version += 1; needsOwner = 0; checking = 1
            let action = body["action"] as! String
            let result = DeliveryRecoveryResult(operationId: id, deliveryId: mismatchResult ? "wrong" : "d",
                                                outcome: action == "recheck" ? .checkScheduled : action == "stop_retry" ? .stopped : .retryScheduled, committedVersion: version)
            results[id] = result
            if dropReply { dropReply = false; throw URLError(.timedOut) }
            let reply = try base.reply(result)
            if let gate, gateRecovery {
                self.gate = nil
                let entered = self.entered
                lock.unlock(); entered?.fulfill(); _ = gate.wait(timeout: .now() + 5); lock.lock()
            }
            return IsolatedTestHTTPReply(status: action == "stop_retry" ? 200 : 202, data: reply.data)
        default: return try base.handle(request)
        }
    }
}

@MainActor final class DeliveryNoticeTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork, journal: URL? = nil) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, writeStorageURL: journal)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect(); store.setForeground(false)
        return store
    }
    func testOnlyNeedsOwnerCountsAsInterventionAndUnassignedStaysSeparate() async throws {
        let server = DeliveryNoticeServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        XCTAssertEqual(store.deliverySummary(memberID: "m")?.undeliveredCount, 205)
        XCTAssertEqual(store.deliverySummary(memberID: "m")?.checkingCount, 1)
        XCTAssertTrue(store.deliveryAttentionMembers.isEmpty)
        server.change { $0.needsOwner = 2; $0.checking = 9; $0.unassigned = 3 }
        await store.refresh()
        XCTAssertEqual(store.deliveryAttentionMembers.map(\.memberId), ["m"])
        XCTAssertEqual(store.deliveryAttentionMembers.first?.needsOwnerCount, 2)
        XCTAssertEqual(store.unassignedDeliveryAttentionCount, 3)
        XCTAssertTrue(store.messages.isEmpty, "Whole-DB notices must not depend on recent chat rows")
    }
    func testDetailPagingDeduplicatesAndFirstPageRemovesResolvedItems() async throws {
        let server = DeliveryNoticeServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        await store.loadDeliveryNotices(memberID: "m")
        await store.loadDeliveryNotices(memberID: "m", older: true)
        XCTAssertEqual(store.deliveryPages["m"]?.items.map(\.id), ["d", "older"])
        XCTAssertEqual(store.deliveryPages["m"]?.summary.undeliveredCount, 205)
        let older = try XCTUnwrap(network.requests.last { $0.url?.path.hasSuffix("delivery-notices") == true })
        XCTAssertEqual(URLComponents(url: older.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "before" }?.value, "opaque+/cursor")
        server.change { $0.noticeStatus = 500 }
        await store.loadDeliveryNotices(memberID: "m")
        XCTAssertNotNil(store.deliveryErrors["m"])
        XCTAssertEqual(store.deliveryPages["m"]?.items.count, 2)
        server.change { $0.noticeStatus = nil; $0.resolved = true }
        await store.loadDeliveryNotices(memberID: "m")
        XCTAssertTrue(store.deliveryPages["m"]?.items.isEmpty == true)
    }
    func test202SchedulesAndReloadsSummaryAndDetailWithoutMarkingReceived() async throws {
        let server = DeliveryNoticeServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        server.change { $0.needsOwner = 1 }
        let store = await connect(network)
        defer { store.disconnect() }
        let result = await store.recoverDelivery(server.read { $0.item }, action: .recheck)
        XCTAssertTrue(result)
        XCTAssertEqual(store.deliveryResults.values.first?.outcome, .checkScheduled)
        XCTAssertEqual(store.deliveryPages["m"]?.items.first?.status, "held")
        XCTAssertEqual(store.deliverySummary(memberID: "m")?.checkingCount, 1)
        XCTAssertTrue(store.deliveryAttentionMembers.isEmpty)
        XCTAssertFalse(store.deliveryChecking.contains("d"))
        let post = try XCTUnwrap(network.requests.first { $0.url?.path == "/api/deliveries/d/recovery" })
        XCTAssertEqual(post.value(forHTTPHeaderField: "X-IAMCEO-Contract"), "2")
        let postIndex = network.requests.firstIndex { $0.url?.path == post.url?.path }!
        XCTAssertTrue(network.requests.dropFirst(postIndex + 1).contains { $0.url?.path == "/api/projects/p/state" })
        XCTAssertTrue(network.requests.dropFirst(postIndex + 1).contains { $0.url?.path.hasSuffix("delivery-notices") == true })
    }
    func testLostRecoveryReplyReusesDurableOperationAndOriginalVersionAfterRestart() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = DeliveryNoticeServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let journal = root.appendingPathComponent("writes")
        let first = await connect(network, journal: journal)
        server.change { $0.dropReply = true }
        let accepted = await first.recoverDelivery(server.read { $0.item }, action: .recheck)
        XCTAssertFalse(accepted)
        XCTAssertTrue(first.deliveryChecking.contains("d"))
        first.disconnect()
        let restored = await connect(network, journal: journal)
        defer { restored.disconnect() }
        XCTAssertEqual(server.read { $0.recoveryBodies.count }, 1, "Reconnect must only read, never replay recovery input")
        let result = await restored.recoverDelivery(server.read { $0.item }, action: .recheck)
        XCTAssertTrue(result)
        let bodies = server.read { $0.recoveryBodies }
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(bodies[0]["operationId"] as? String, bodies[1]["operationId"] as? String)
        XCTAssertEqual(bodies[1]["expectedVersion"] as? Int, 1)
        XCTAssertEqual(server.read { $0.version }, 2)
    }
    func testRefusalRefreshesAndUnknownReasonsAndRiskRequireExplicitConsent() async throws {
        let server = DeliveryNoticeServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        var item = server.read { $0.item }
        item.reason = "future_unknown"
        let unsafe = await store.recoverDelivery(item, action: .retryWithRisk, acceptDuplicateRisk: true)
        XCTAssertFalse(unsafe)
        let withoutConsent = await store.recoverDelivery(server.read { $0.item }, action: .retryWithRisk)
        XCTAssertFalse(withoutConsent)
        item = server.read { $0.item }; item.deliveryId = nil; item.version = 0
        let virtual = await store.recoverDelivery(item, action: .recheck)
        XCTAssertFalse(virtual)
        XCTAssertEqual(server.read { $0.recoveryBodies.count }, 0)
        server.change { $0.recoveryStatus = 409 }
        let refused = await store.recoverDelivery(server.read { $0.item }, action: .recheck)
        XCTAssertFalse(refused)
        XCTAssertEqual(store.deliveryPages["m"]?.items.count, 1)
        XCTAssertFalse(store.deliveryChecking.contains("d"))
    }
    func testUnresolvedRecoveryCannotBeReplacedByDifferentAction() async throws {
        let server = DeliveryNoticeServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        server.change { $0.dropReply = true }
        _ = await store.recoverDelivery(server.read { $0.item }, action: .recheck)
        let result = await store.recoverDelivery(server.read { $0.item }, action: .retryWithRisk, acceptDuplicateRisk: true)
        XCTAssertFalse(result)
        XCTAssertEqual(server.read { $0.recoveryBodies.count }, 1)
    }
    func testDetailSingleFlightAndLateProjectResponseAreIsolated() async throws {
        let server = DeliveryNoticeServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        let gate = DispatchSemaphore(value: 0), entered = expectation(description: "notice requested")
        server.change { $0.gate = gate; $0.entered = entered }
        let first = Task { await store.loadDeliveryNotices(memberID: "m") }
        await fulfillment(of: [entered], timeout: 3)
        await store.loadDeliveryNotices(memberID: "m")
        // Project transition invalidates the page token before the delayed response is delivered.
        let switchTask = Task { await store.selectProject(id: "missing") }
        await Task.yield()
        gate.signal()
        await first.value; await switchTask.value
        XCTAssertNil(store.deliveryPages["m"])
        XCTAssertEqual(network.requests.filter { $0.url?.path.hasSuffix("delivery-notices") == true }.count, 1)
    }
    func testDetail401ClearsAllReadState() async throws {
        let server = DeliveryNoticeServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        server.change { $0.noticeStatus = 401 }
        await store.loadDeliveryNotices(memberID: "m")
        XCTAssertEqual(store.connectionStatus, .failed)
        XCTAssertNil(store.deliveryNotices)
        XCTAssertTrue(store.deliveryPages.isEmpty)
    }
    func testExplicitRiskAndStopKeepTheirDistinctOutcomes() async throws {
        let server = DeliveryNoticeServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        let risk = await store.recoverDelivery(server.read { $0.item }, action: .retryWithRisk, acceptDuplicateRisk: true)
        XCTAssertTrue(risk)
        XCTAssertEqual(store.deliveryResults.values.first?.outcome, .retryScheduled)
        XCTAssertEqual(server.read { $0.recoveryBodies.first?["acceptDuplicateRisk"] as? Bool }, true)
        let stopped = await store.recoverDelivery(server.read { $0.item }, action: .stopRetry)
        XCTAssertTrue(stopped)
        XCTAssertTrue(store.deliveryResults.values.contains { $0.outcome == .stopped })
        XCTAssertNil(server.read { $0.recoveryBodies.last?["acceptDuplicateRisk"] })
        XCTAssertNotEqual(server.read { $0.recoveryBodies.first?["operationId"] as? String },
                          server.read { $0.recoveryBodies.last?["operationId"] as? String })
    }
    func testLateRecoveryResponseIsJournaledWithoutChangingAnotherProject() async throws {
        let server = DeliveryNoticeServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        let gate = DispatchSemaphore(value: 0), entered = expectation(description: "recovery requested")
        server.change { $0.gate = gate; $0.entered = entered; $0.gateRecovery = true }
        let recovery = Task { await store.recoverDelivery(server.read { $0.item }, action: .recheck) }
        await fulfillment(of: [entered], timeout: 3)
        let switchProject = Task { await store.selectProject(id: "missing") }
        await Task.yield()
        gate.signal()
        let result = await recovery.value
        await switchProject.value
        XCTAssertFalse(result)
        XCTAssertTrue(store.deliveryResults.isEmpty)
        XCTAssertTrue(store.deliveryPages.isEmpty)
        XCTAssertFalse(store.pendingActions.contains("delivery:d"))
    }

    func testMismatchedRecoveryResultCannotBecomeSuccess() async throws {
        let server = DeliveryNoticeServer(), network = try IsolatedTestNetwork(handler: { try server.handle($0) })
        let store = await connect(network)
        defer { store.disconnect() }
        server.change { $0.mismatchResult = true }
        let result = await store.recoverDelivery(server.read { $0.item }, action: .recheck)
        XCTAssertFalse(result)
        XCTAssertTrue(store.deliveryResults.isEmpty)
        XCTAssertTrue(store.deliveryChecking.contains("d"))
    }
}
