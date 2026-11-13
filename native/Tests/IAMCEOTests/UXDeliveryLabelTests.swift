import Foundation
import XCTest
@testable import IAMCEO

private actor UXDeliveryLabelGate {
    let entered: XCTestExpectation
    private var waiter: TestDeadlineContinuation<Void, Never>?
    private var released = false
    init(_ entered: XCTestExpectation) { self.entered = entered }
    func wait() async {
        guard !released else { return }
        await withTestDeadline(fallback: ()) { waiter = $0; entered.fulfill() }
    }
    func release() { released = true; waiter?.resume(); waiter = nil }
}

/// URLProtocol and injected sockets only; no TCP, UserDefaults or real credentials.
private final class UXDeliveryLabelServer: @unchecked Sendable {
    private let lock = NSLock()
    private var row: Message?
    private var posts = 0
    let gate: UXDeliveryLabelGate?
    init(gate: UXDeliveryLabelGate? = nil) { self.gate = gate }
    func setRow(_ message: Message) { lock.withLock { row = message } }
    var current: Message? { lock.withLock { row } }
    var postCount: Int { lock.withLock { posts } }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        try lock.withLock {
            func reply<T: Encodable>(_ value: T) throws -> IsolatedTestHTTPReply {
                IsolatedTestHTTPReply(data: try JSONEncoder().encode(value))
            }
            switch request.url?.path {
            case "/api/bootstrap": return try reply(Bootstrap(projects: [ProjectSummary(id: "p")]))
            case "/api/runtime": return IsolatedTestHTTPReply()
            case "/api/capabilities":
                return try reply(ServerCapabilities(contractVersion: 2, capabilities: CapabilityFlags(paging: true, realtime: true)))
            case "/api/projects/p/state":
                return try reply(ProjectState(project: Project(id: "p", connection: ProjectConnection(ok: true)), messages: row.map { [$0] } ?? [],
                    deliveryNotices: DeliveryNotices(version: 2, members: [],
                        unassigned: UnassignedDeliverySummary(undeliveredCount: 1, unknownCount: 0, needsOwnerCount: 1))))
            case "/api/projects/p/messages/page":
                return try reply(MessagePage(projectId: "p", scope: .project, items: row.map { [$0] } ?? [], nextCursor: nil, hasOlder: false))
            case "/api/projects/p/messages":
                posts += 1
                let body = try WriteTestServer.body(request)
                let id = try XCTUnwrap(body["id"] as? String)
                row = Message(id: id, projectId: "p", at: "2026-11-09T07:17:33Z", mine: true,
                              body: body["text"] as? String ?? "", delivery: "queued",
                              deliveryRevision: row.map { ($0.deliveryRevision ?? 0) + 1 } ?? 0)
                var response = try reply(row!)
                if let gate { response.beforeDelivery = { await gate.wait() } }
                return response
            default: return IsolatedTestHTTPReply(status: 404)
            }
        }
    }
}

@MainActor final class UXDeliveryLabelTests: XCTestCase {
    private func message(_ status: String, revision: Int? = nil) -> Message {
        Message(id: "45A3D2AD-fixture", projectId: "p", at: "2026-11-09T07:17:33Z", mine: true,
                body: "대표 지시", delivery: status, deliveryRevision: revision)
    }
    private func page(_ rows: [Message], cursor: String? = nil) -> MessagePage {
        MessagePage(projectId: "p", scope: .project, items: rows, nextCursor: cursor, hasOlder: cursor != nil)
    }
    private func makeHistory(_ rows: [Message] = [], cursor: String? = nil) throws -> ChatHistory {
        var result = ChatHistory(key: ChatHistoryKey(namespace: "fixture", connectionGeneration: UUID(), projectID: "p", scope: .project))
        let request = try XCTUnwrap(result.begin(.initial))
        XCTAssertTrue(result.apply(page(rows, cursor: cursor), request: request))
        return result
    }

    func testDeliveredEventBeforeQueuedPOSTResponseStaysDelivered() throws {
        var history = try makeHistory()
        history.addOptimistic(message("queued"))
        history.receive(message("delivered", revision: 1)) // WS: 16:17:34
        history.receive(message("queued", revision: 0)) // Delayed POST snapshot: 16:17:33
        XCTAssertEqual(history.items.count, 1)
        XCTAssertEqual(history.items.first?.delivery, "delivered")
        XCTAssertEqual(DeliveryInfo(history.items.first?.delivery)?.label, "받음")
        XCTAssertTrue(history.optimisticIDs.isEmpty)
    }

    func testInitialOverlayAndJournalCannotRegressNewerPageOrEvent() throws {
        for pageIsNewer in [false, true] {
            var history = ChatHistory(key: ChatHistoryKey(namespace: "fixture", connectionGeneration: UUID(), projectID: "p", scope: .project))
            history.receive(message(pageIsNewer ? "queued" : "delivered", revision: pageIsNewer ? 0 : 1))
            let request = try XCTUnwrap(history.begin(.initial))
            history.receive(message("queued", revision: 0))
            XCTAssertTrue(history.apply(page([message(pageIsNewer ? "delivered" : "queued", revision: pageIsNewer ? 1 : 0)]), request: request))
            XCTAssertEqual(history.items.first?.delivery, "delivered")
            XCTAssertEqual(history.items.first?.deliveryRevision, 1)
        }
    }

    func testOptimisticRowReceivesDeliveryWhileInitialPageIsPending() throws {
        var history = ChatHistory(key: ChatHistoryKey(namespace: "fixture", connectionGeneration: UUID(), projectID: "p", scope: .project))
        let request = try XCTUnwrap(history.begin(.initial))
        history.addOptimistic(message("queued"))
        history.receive(message("delivered", revision: 1))
        history.receive(message("queued", revision: 0))
        XCTAssertEqual(history.items.first?.delivery, "delivered")
        history.fail(URLError(.timedOut), request: request)
        XCTAssertEqual(history.items.first?.delivery, "delivered")
        history.addOptimistic(message("queued"))
        XCTAssertEqual(history.items.first?.delivery, "delivered")
    }

    func testStaleLatestAndOlderPagesCannotRegressVisibleDelivery() throws {
        for kind in [ChatHistoryLoad.latest, .older] {
            var history = try makeHistory([message("delivered", revision: 3)], cursor: "older")
            let request = try XCTUnwrap(history.begin(kind))
            XCTAssertTrue(history.apply(page([message("queued", revision: 2)]), request: request))
            XCTAssertEqual(history.items.first?.delivery, "delivered")
        }
    }

    func testBridgePreservesDeliveryAcrossDelayedPOSTAndPage() throws {
        let old = Message(id: "anchor", projectId: "p", at: "2026-11-08T00:00:00Z")
        var history = try makeHistory([old], cursor: "old-cursor")
        let latest = try XCTUnwrap(history.begin(.latest))
        XCTAssertTrue(history.apply(page([message("queued", revision: 0)], cursor: "gap"), request: latest))
        XCTAssertTrue(history.isBridging)
        history.receive(message("delivered", revision: 1))
        history.receive(message("queued", revision: 0))
        let bridge = try XCTUnwrap(history.begin(.bridge))
        XCTAssertTrue(history.apply(page([old, message("queued", revision: 0)]), request: bridge))
        XCTAssertFalse(history.isBridging)
        XCTAssertEqual(history.items.last?.delivery, "delivered")
    }

    func testExplicitRetryAndDelayedPriorAttemptEvents() throws {
        var history = try makeHistory([message("failed", revision: 1)])
        history.receive(message("queued", revision: 2))
        XCTAssertEqual(DeliveryInfo(history.items.first?.delivery)?.label, "전달 대기")
        history.receive(message("failed", revision: 1))
        XCTAssertEqual(history.items.first?.delivery, "queued")
        history.receive(message("delivered", revision: 3))
        history.receive(message("queued", revision: 2))
        XCTAssertEqual(history.items.first?.delivery, "delivered")
        XCTAssertEqual(history.items.count, 1)
    }

    func testAllArrivalOrdersConvergeToNewestRevision() throws {
        let rows = [message("failed", revision: 1), message("queued", revision: 2), message("delivered", revision: 3)]
        for order in [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] {
            var history = try makeHistory()
            for index in order { history.receive(rows[index]) }
            XCTAssertEqual(history.items.first?.delivery, "delivered", "\(order)")
        }
    }

    func testRevisionDecodingLegacyRetryAndMetadataUpdates() throws {
        let decoded = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"m","delivery":"delivered","deliveryRevision":42}"#.utf8))
        XCTAssertEqual(decoded.deliveryRevision, 42)
        XCTAssertNil(try JSONDecoder().decode(Message.self, from: Data(#"{"id":"m"}"#.utf8)).deliveryRevision)
        var history = try makeHistory([message("failed")])
        history.receive(message("queued"))
        XCTAssertEqual(history.items.first?.delivery, "queued") // Pre-revision server compatibility.
        history.receive(message("delivered", revision: 3))
        for revision in [nil, 2, 3] as [Int?] {
            var stale = message("queued", revision: revision)
            stale.deliveryNote = "오래된 사유"; stale.fileIds = ["new-file"]; stale.supersededBy = "correction"
            history.receive(stale)
            XCTAssertEqual(history.items.first?.delivery, "delivered")
            XCTAssertNil(history.items.first?.deliveryNote)
            XCTAssertEqual(history.items.first?.fileIds, ["new-file"])
            XCTAssertEqual(history.items.first?.supersededBy, "correction")
        }
    }

    func testSubmissionAcceptancePreservesRevisionAndAllowsRetry() throws {
        let submissions = try SubmissionStore(persist: false), drafts = DraftStore(persist: false, namespace: "fixture")
        let draft = drafts.snapshot(for: DraftStore.key(project: "p", target: nil))
        let attempt = try submissions.prepareMessage(projectID: "p", targetMemberID: nil, draft: draft)
        for (status, revision, expected) in [("delivered", 3, "delivered"), ("queued", 0, "delivered"),
                                             ("failed", 4, "failed"), ("queued", 5, "queued"), ("delivered", 6, "delivered")] {
            var row = message(status, revision: revision); row.id = attempt.id
            try submissions.acceptMessage(id: attempt.id, message: row)
            XCTAssertEqual(submissions.messageAttempt(id: attempt.id)?.message?.delivery, expected)
        }
    }

    private func finish<Value: Sendable>(_ task: Task<Value, Never>, fallback: Value) async -> Value {
        let value = await withTestDeadline(fallback: fallback) { done in
            Task { done.resume(returning: await task.value) }
        }
        task.cancel()
        return value
    }
    // 공용 pollUntil(TestSupport)을 부르는 얇은 껍데기. 기한은 느린 CI 러너에 맞춘 공용 기본값(10초)을 쓴다.
    private func eventually(_ predicate: () async -> Bool) async throws {
        await pollUntil { await predicate() }
    }

    func testSocketEventBeforePOSTResponseAndStaleStateKeepsChatHomeAndSubmissionDelivered() async throws {
        let entered = expectation(description: "queued POST response held")
        let gate = UXDeliveryLabelGate(entered), server = UXDeliveryLabelServer(gate: gate)
        let network = try IsolatedTestNetwork(handler: server.handle), sockets = CoordinatorSockets()
        let store = AppStore(session: network.session, persistCredentials: false, realtime: RealtimeClient(factory: sockets))
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        defer { store.disconnect() }
        await finish(Task { await store.connect() }, fallback: ())
        try await eventually { await sockets.sockets.count == 1 }
        let createdSockets = await sockets.sockets
        let socket = try XCTUnwrap(createdSockets.first)
        try await socket.enqueue(.success(Data(#"{"type":"hello","seq":0}"#.utf8)))
        try await eventually { store.realtimeStatus == .legacy && store.canWrite }
        await finish(Task { _ = await store.activateHistory() }, fallback: ())
        let send = Task { await store.sendMessage(text: "대표 지시") }
        await fulfillment(of: [entered], timeout: 3)
        var delivered = try XCTUnwrap(server.current); delivered.delivery = "delivered"; delivered.deliveryRevision = 1
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(delivered))
        let frame = try JSONSerialization.data(withJSONObject: ["type": "message", "message": object])
        try await socket.enqueue(.success(frame))
        try await eventually { store.historyMessages.first?.delivery == "delivered" }
        await gate.release()
        let sent = await finish(send, fallback: false)
        XCTAssertTrue(sent)
        await finish(Task { await store.refresh() }, fallback: ()) // /state and page still return queued revision 0.
        XCTAssertEqual(store.historyMessages.first?.delivery, "delivered")
        XCTAssertEqual(store.messages.first?.delivery, "delivered")
        XCTAssertEqual(store.submissions?.messageAttempt(id: delivered.id)?.message?.delivery, "delivered")
        XCTAssertEqual(store.submissions?.messageAttempt(id: delivered.id)?.draftConsumed, true)
        XCTAssertTrue(unresolvedDeliveries(store.messages, status: "failed").isEmpty)
        XCTAssertTrue(HomeAttention(members: store.members, notices: store.deliveryNotices, messages: store.messages).failedMessages.isEmpty)
        XCTAssertEqual(server.postCount, 1)
    }

    func testHomeAndChatShowExplicitSameIDRetryThenDelivery() async throws {
        let server = UXDeliveryLabelServer(); server.setRow(message("failed", revision: 1))
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        defer { store.disconnect() }
        await finish(Task { await store.connect() }, fallback: ())
        await finish(Task { _ = await store.activateHistory() }, fallback: ())
        XCTAssertEqual(unresolvedDeliveries(store.messages, status: "failed").count, 1)
        XCTAssertEqual(HomeAttention(members: store.members, notices: store.deliveryNotices, messages: store.messages).failedMessages.count, 1)
        let resent = await finish(Task { await store.resend(self.message("failed", revision: 1)) }, fallback: false)
        XCTAssertTrue(resent)
        XCTAssertEqual(store.messages.first?.delivery, "queued")
        XCTAssertEqual(store.historyMessages.first?.delivery, "queued")
        XCTAssertEqual(DeliveryInfo(store.messages.first?.delivery)?.label, "전달 대기")
        XCTAssertTrue(unresolvedDeliveries(store.messages, status: "failed").isEmpty)
        XCTAssertTrue(HomeAttention(members: store.members, notices: store.deliveryNotices, messages: store.messages).failedMessages.isEmpty)
        store.receiveHistoryMessage(message("delivered", revision: 3))
        await finish(Task { await store.refresh() }, fallback: ())
        XCTAssertEqual(store.messages.first?.delivery, "delivered")
        XCTAssertEqual(store.historyMessages.first?.delivery, "delivered")
        XCTAssertEqual(server.postCount, 1)
        // A newly opened history has no WS overlay of its own; merge against connection knowledge.
        await finish(Task { await store.restartHistoryFromLatest() }, fallback: ())
        XCTAssertEqual(store.historyMessages.first?.delivery, "delivered")
    }
}
