import Foundation
import XCTest
@testable import IAMCEO

/// Per-session URLProtocol, two-second HTTP deadline and a bounded deadline around every async scenario.
private final class UnassignedFailHTTP: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private let base = WriteTestServer()
    var dropReply = false
    var status: Int?
    var mismatch = false
    var omitItems = false
    var gate: DispatchSemaphore?
    var entered: XCTestExpectation?
    private var resolved = false
    private var receipts: [String: UnassignedRecoveryResult] = [:]
    private var bodies: [[String: Any]] = []
    private var delivery = "failed"
    var item: UnassignedDeliveryItem {
        UnassignedDeliveryItem(id: "message:legacy", messageId: "legacy", projectId: "p", memberId: "", version: 0,
                               preview: "이거 개발자 이름 원할때 변경 가능한건가?", createdAt: "2026-11-02T06:12:00.000Z",
                               allowedActions: [.sendToConductor, .dismiss])
    }
    private var notices: DeliveryNotices {
        var notices = DeliveryNotices(version: 2, members: [], unassigned: UnassignedDeliverySummary(
            undeliveredCount: 0, unknownCount: resolved ? 0 : 1, needsOwnerCount: resolved ? 0 : 1))
        notices.unassignedItems = omitItems ? nil : resolved ? [] : [item]
        return notices
    }
    func change(_ body: (UnassignedFailHTTP) -> Void) { lock.withLock { body(self) } }
    func read<T>(_ body: (UnassignedFailHTTP) -> T) -> T { lock.withLock { body(self) } }
    var recoveryBodies: [[String: Any]] { lock.withLock { bodies } }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        lock.lock(); defer { lock.unlock() }
        switch request.url!.path {
        case "/api/projects/p/state":
            var state = base.state
            state.deliveryNotices = notices
            state.messages = [Message(id: "legacy", projectId: "p", mine: true, body: item.preview, delivery: delivery, deliveryRevision: resolved ? 1 : 0)]
            return try base.reply(state)
        case "/api/projects/p/delivery-notices": return try base.reply(notices)
        case "/api/messages/legacy":
            // Real server keeps the old delivery vocabulary and adds a disposition for new clients.
            return IsolatedTestHTTPReply(data: Data("{\"id\":\"legacy\",\"projectId\":\"p\",\"mine\":true,\"delivery\":\"\(delivery == "dismissed" ? "held" : delivery)\",\"deliveryRevision\":\(resolved ? 2 : 0)\(delivery == "dismissed" ? ",\"deliveryDisposition\":\"dismissed\"" : "")}".utf8))
        case "/api/messages/legacy/recovery":
            let body = try WriteTestServer.body(request)
            bodies.append(body)
            if let status { return IsolatedTestHTTPReply(status: status) }
            let id = try XCTUnwrap(body["operationId"] as? String)
            if let result = receipts[id] { return try base.reply(result) }
            guard body["expectedVersion"] as? Int == 0 else { return IsolatedTestHTTPReply(status: 409) }
            let dismiss = body["action"] as? String == "dismiss"
            resolved = true; delivery = dismiss ? "dismissed" : "queued"
            let result = UnassignedRecoveryResult(operationId: id, messageId: mismatch ? "wrong" : "legacy",
                deliveryId: dismiss ? nil : "dl_conductor", outcome: dismiss ? "dismissed" : "send_scheduled", committedVersion: 1)
            receipts[id] = result
            if dropReply { dropReply = false; throw URLError(.timedOut) }
            if let gate {
                self.gate = nil
                let entered = self.entered
                lock.unlock(); entered?.fulfill()
                XCTAssertEqual(gate.wait(timeout: .now() + 3), .success, "Fixture gate deadline")
                lock.lock()
            }
            let reply = try base.reply(result)
            return IsolatedTestHTTPReply(status: dismiss ? 200 : 202, data: reply.data)
        default: return try base.handle(request)
        }
    }
}

@MainActor final class UnassignedFailTests: XCTestCase {
    private func bounded<T: Sendable>(_ body: @escaping @MainActor () async throws -> T) async throws -> T {
        try await withThrowingTestDeadline { deadline in
            Task { @MainActor in
                do { deadline.resume(returning: try await body()) }
                catch { deadline.resume(throwing: error) }
            }
        }
    }
    private func connect(_ network: IsolatedTestNetwork, journal: URL? = nil) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, writeStorageURL: journal)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect(); store.setForeground(false)
        return store
    }
    func testUnknownNeedsOwnerReasonStillAllowsSafeCleanup() throws {
        let item = try JSONDecoder().decode(DeliveryNoticeItem.self, from: Data(#"{"id":"d","phase":"needs_owner","reason":"future","allowedActions":["recheck","stop_retry","retry_with_risk"]}"#.utf8))
        XCTAssertEqual(item.safeAllowedActions, [.recheck, .stopRetry])
        let direct = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"legacy","delivery":"dismissed"}"#.utf8))
        XCTAssertEqual(direct.delivery, "dismissed")
    }
    func testListAndDismissRefreshNoticesAndOldConversationMessage() async throws {
        try await bounded {
            let fixture = UnassignedFailHTTP(), network = try IsolatedTestNetwork(handler: fixture.handle)
            let store = await self.connect(network); defer { store.disconnect() }
            await store.loadUnassignedDeliveries()
            XCTAssertEqual(store.unassignedDeliveries.map(\.messageId), ["legacy"])
            XCTAssertEqual(store.unassignedDeliveries[0].allowedActions, [.sendToConductor, .dismiss])
            let accepted = await store.dismissUndelivered(messageID: "legacy")
            XCTAssertTrue(accepted)
            XCTAssertEqual(store.unassignedDeliveryAttentionCount, 0)
            XCTAssertTrue(store.unassignedDeliveries.isEmpty)
            XCTAssertEqual(store.messages.first?.delivery, "dismissed")
            XCTAssertTrue(store.pendingActions.isEmpty)
            let post = try XCTUnwrap(network.requests.first { $0.url?.path.hasSuffix("/recovery") == true })
            XCTAssertEqual(post.value(forHTTPHeaderField: "X-IAMCEO-Contract"), "2")
            XCTAssertEqual(try WriteTestServer.body(post)["expectedVersion"] as? Int, 0)
            XCTAssertTrue(network.requests.contains { $0.url?.path == "/api/messages/legacy" })
        }
    }
    func testSendToConductorUsesExplicitActionAndDoesNotMarkReceived() async throws {
        try await bounded {
            let fixture = UnassignedFailHTTP(), network = try IsolatedTestNetwork(handler: fixture.handle)
            let store = await self.connect(network); defer { store.disconnect() }
            let accepted = await store.sendUnassignedToConductor(messageID: "legacy")
            XCTAssertTrue(accepted)
            XCTAssertEqual(fixture.recoveryBodies.first?["action"] as? String, "send_to_conductor")
            XCTAssertEqual(store.messages.first?.delivery, "queued")
            XCTAssertEqual(store.unassignedDeliveryAttentionCount, 0)
        }
    }
    func testLostReplySurvivesRestartAndReusesOperationAndVersionAfterItemDisappears() async throws {
        try await bounded {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let fixture = UnassignedFailHTTP(), network = try IsolatedTestNetwork(handler: fixture.handle)
            let journal = root.appendingPathComponent("writes")
            let first = await self.connect(network, journal: journal)
            fixture.change { $0.dropReply = true }
            let lost = await first.dismissUndelivered(messageID: "legacy")
            XCTAssertFalse(lost)
            XCTAssertTrue(first.deliveryChecking.contains("message:legacy"))
            let opposite = await first.sendUnassignedToConductor(messageID: "legacy")
            XCTAssertFalse(opposite)
            first.disconnect()
            let restored = await self.connect(network, journal: journal); defer { restored.disconnect() }
            XCTAssertEqual(fixture.recoveryBodies.count, 1, "Connecting only reads")
            let replayed = await restored.dismissUndelivered(messageID: "legacy")
            XCTAssertTrue(replayed)
            XCTAssertEqual(fixture.recoveryBodies.count, 2)
            XCTAssertEqual(fixture.recoveryBodies[0]["operationId"] as? String, fixture.recoveryBodies[1]["operationId"] as? String)
            XCTAssertEqual(fixture.recoveryBodies[1]["expectedVersion"] as? Int, 0)
        }
    }
    func testWriteLockBlocksConcurrentOppositeActionAndLateProjectResultIsIsolated() async throws {
        try await bounded {
            let fixture = UnassignedFailHTTP(), network = try IsolatedTestNetwork(handler: fixture.handle)
            let store = await self.connect(network); defer { store.disconnect() }
            let entered = self.expectation(description: "recovery entered"), gate = DispatchSemaphore(value: 0)
            fixture.change { $0.entered = entered; $0.gate = gate }
            let first = Task { await store.dismissUndelivered(messageID: "legacy") }
            await self.fulfillment(of: [entered], timeout: 2)
            let duplicate = await store.sendUnassignedToConductor(messageID: "legacy")
            XCTAssertFalse(duplicate)
            let transition = Task { await store.selectProject(id: "missing") }
            await Task.yield(); gate.signal()
            let applied = await first.value; await transition.value
            XCTAssertFalse(applied)
            XCTAssertEqual(fixture.recoveryBodies.count, 1)
            XCTAssertTrue(store.unassignedDeliveries.isEmpty)
            XCTAssertFalse(store.pendingActions.contains("unassigned:legacy"))
        }
    }
    func testRefusalAndOldServerAndMismatchedReplyFailSafely() async throws {
        try await bounded {
            let fixture = UnassignedFailHTTP(), network = try IsolatedTestNetwork(handler: fixture.handle)
            let store = await self.connect(network); defer { store.disconnect() }
            fixture.change { $0.status = 409 }
            let refused = await store.sendUnassignedToConductor(messageID: "legacy")
            XCTAssertFalse(refused)
            XCTAssertNotNil(store.errorMessage)
            XCTAssertFalse(store.deliveryChecking.contains("message:legacy"))
            XCTAssertEqual(store.unassignedDeliveryAttentionCount, 1)
            fixture.change { $0.status = nil; $0.mismatch = true }
            let mismatched = await store.dismissUndelivered(messageID: "legacy")
            XCTAssertFalse(mismatched)
            XCTAssertTrue(store.deliveryChecking.contains("message:legacy"))
            fixture.change { $0.omitItems = true }
            await store.loadUnassignedDeliveries()
            XCTAssertTrue(store.unassignedDeliveries.isEmpty)
        }
    }
}
