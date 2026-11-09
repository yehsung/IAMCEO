import Foundation
import XCTest
@testable import IAMCEO

private actor HandoffGate {
    private var open = false
    private var waiter: TestDeadlineContinuation<Void, Never>?
    func wait() async { if !open { await withTestDeadline(fallback: ()) { waiter = $0 } } }
    func release() { open = true; waiter?.resume(); waiter = nil }
}

private final class HandoffServer: @unchecked Sendable {
    let writes = WriteTestServer()
    let gate = HandoffGate()
    private let lock = NSLock()
    var delayCreation = false
    var loseCreation = false
    var rejectCreation = false
    var loseTodoBeforeAcceptance = false
    var rejectBootstrap = false
    var failACK = false
    var legacyPairing = false

    init() { writes.change { $0.state.project.runnerEnabled = true; $0.state.members[0].name = "기존 직원" } }
    func change(_ body: (HandoffServer) -> Void) { lock.withLock { body(self) } }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        try lock.withLock {
            let path = request.url!.path
            func json(_ object: [String: Any]) throws -> IsolatedTestHTTPReply {
                IsolatedTestHTTPReply(data: try JSONSerialization.data(withJSONObject: object))
            }
            if path == "/pair/claim" {
                if legacyPairing { return try json(["accessCode": "test"]) }
                return try json(["accessCode": "test", "confirmationToken": String(repeating: "a", count: 64)])
            }
            if path == "/api/bootstrap", rejectBootstrap { return IsolatedTestHTTPReply(status: 401) }
            if path == "/api/pair/ack" {
                if failACK { throw URLError(.timedOut) }
                return try json(["code": "ABCDEFGH", "status": "connected"])
            }
            if path == "/api/projects/p/members", request.httpMethod == "POST" {
                if rejectCreation { return IsolatedTestHTTPReply(status: 409, data: Data(#"{"error":"raw internal exit 1"}"#.utf8)) }
                let body = try WriteTestServer.body(request)
                let member = Member(id: "new-member", projectId: "p", name: body["name"] as? String ?? "", cli: body["cli"] as? String ?? "claude")
                writes.change { $0.state.members.append(member) }
                if loseCreation { throw URLError(.timedOut) }
                var reply = try writes.reply(member)
                if delayCreation { reply.beforeDelivery = { await self.gate.wait() } }
                return reply
            }
            if path == "/api/todos/t/done", request.httpMethod == "POST" {
                if loseTodoBeforeAcceptance { throw URLError(.timedOut) }
                let body = try WriteTestServer.body(request)
                writes.change {
                    $0.state.todos[0].completionNote = body["note"] as? String
                    $0.state.todos[0].completionFileIds = body["fileIds"] as? [String] ?? []
                }
            }
            return try writes.handle(request)
        }
    }
}

@MainActor final class UXHandoffTests: XCTestCase {
    private func connected(_ network: IsolatedTestNetwork, drafts: DraftStore? = nil, submissions: SubmissionStore? = nil, journal: URL? = nil) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, drafts: drafts, submissions: submissions, writeStorageURL: journal)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }
    private func eventually(_ predicate: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let clock = ContinuousClock(), deadline = clock.now + .seconds(4)
        while !predicate(), clock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(predicate(), file: file, line: line)
    }
    private func temporaryDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    func testContextSnapshotRestoresAndRetryRetainsOriginalReference() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("submissions"), drafts = DraftStore(persist: false)
        drafts.selectNamespace("fixture")
        let key = DraftStore.key(project: "p", target: "m")
        drafts.setText("이 자료를 확인해 주세요", for: key)
        let original = try SubmissionStore(storageURL: url)
        let attempt = try original.prepareMessage(projectID: "p", targetMemberID: "m", draft: drafts.snapshot(for: key), contextFileID: "file-original")
        _ = try original.beginMessage(id: attempt.id)
        let restored = try SubmissionStore(storageURL: url)
        XCTAssertEqual(restored.messageAttempt(id: attempt.id)?.contextFileId, "file-original")
        XCTAssertThrowsError(try restored.beginMessage(id: attempt.id)) // Uncertain cannot automatically replay.
        let retry = try restored.beginMessage(id: attempt.id, allowUnconfirmedRetry: true)
        XCTAssertEqual(retry.id, attempt.id)
        XCTAssertEqual(retry.contextFileId, "file-original")
        XCTAssertEqual(retry.text, attempt.draft.text)
    }

    func testOldMessageSnapshotWithoutContextDecodesAsNil() throws {
        let drafts = DraftStore(persist: false)
        drafts.selectNamespace("fixture")
        let submission = try SubmissionStore(persist: false).prepareMessage(projectID: "p", targetMemberID: nil,
            draft: drafts.snapshot(for: DraftStore.key(project: "p", target: nil)), contextFileID: "file")
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(submission)) as? [String: Any])
        json.removeValue(forKey: "contextFileId")
        let decoded = try JSONDecoder().decode(MessageSubmission.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(decoded.contextFileId)
        XCTAssertNil(decoded.request.contextFileId)
    }

    func testAppMessageRetryAfterRestartUsesSavedContextEvenWhenReaderChanged() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let url = root.appendingPathComponent("submissions"), draftURL = root.appendingPathComponent("drafts")
        server.change { $0.dropMessage = true; $0.storeMessage = false }
        let store = await connected(network, drafts: DraftStore(storageURL: draftURL), submissions: try SubmissionStore(storageURL: url))
        let first = await store.sendMessage(text: "이 자료", contextFileID: "original-file")
        XCTAssertFalse(first)
        store.disconnect()
        server.change { $0.dropMessage = false; $0.storeMessage = true }
        let restarted = await connected(network, drafts: DraftStore(storageURL: draftURL), submissions: try SubmissionStore(storageURL: url))
        XCTAssertEqual(network.requests.filter { $0.httpMethod == "POST" && $0.url?.path == "/api/projects/p/messages" }.count, 1)
        let retry = await restarted.sendMessage(text: "이 자료", contextFileID: "newly-opened-file")
        XCTAssertTrue(retry)
        let posts = network.requests.filter { $0.httpMethod == "POST" && $0.url?.path == "/api/projects/p/messages" }
        XCTAssertEqual(posts.count, 2)
        let bodies = try posts.map(WriteTestServer.body)
        XCTAssertEqual(bodies[0]["id"] as? String, bodies[1]["id"] as? String)
        XCTAssertEqual(bodies[1]["contextFileId"] as? String, "original-file")
        restarted.disconnect(); await network.close()
    }

    func testAcceptedContextualMessageIsNotDuplicatedWhenReaderChangedDuringConfirmation() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        server.change { $0.dropMessage = true }
        let store = await connected(network)
        let first = await store.sendMessage(text: "이 자료", contextFileID: "original-file")
        XCTAssertFalse(first)
        let confirmed = await store.sendMessage(text: "이 자료", contextFileID: "newly-opened-file")
        XCTAssertTrue(confirmed)
        XCTAssertEqual(network.requests.filter { $0.httpMethod == "POST" && $0.url?.path == "/api/projects/p/messages" }.count, 1)
        store.disconnect(); await network.close()
    }

    func testTodoAnswerRestoresWithoutAutomaticWriteAndExplicitRetryUsesSameBody() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let server = HandoffServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let url = root.appendingPathComponent("journal")
        server.change { $0.loseTodoBeforeAcceptance = true }
        let store = await connected(network, journal: url)
        let first = await store.setTodoDone(store.todos[0], done: true, note: "결과 답", fileIDs: ["f1", "f2"])
        XCTAssertFalse(first)
        store.disconnect()
        let restarted = await connected(network, journal: url)
        XCTAssertEqual(restarted.todoWrites["t"], .checking)
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/api/todos/t/done" }.count, 1)
        server.change { $0.loseTodoBeforeAcceptance = false }
        let retry = await restarted.retryTodoCompletion(restarted.todos[0])
        XCTAssertTrue(retry)
        let posts = network.requests.filter { $0.url?.path == "/api/todos/t/done" }
        XCTAssertEqual(posts.count, 2)
        XCTAssertEqual(posts[0].value(forHTTPHeaderField: "If-Match"), posts[1].value(forHTTPHeaderField: "If-Match"))
        XCTAssertEqual(try WriteTestServer.body(posts[0]) as NSDictionary, try WriteTestServer.body(posts[1]) as NSDictionary)
        restarted.disconnect(); await network.close()
    }

    func testOldTodoRecordWithoutAnswerRestoresAndRetriesWithNoAddedAnswer() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("journal"), server = HandoffServer()
        let network = try IsolatedTestNetwork(handler: server.handle)
        server.change { $0.loseTodoBeforeAcceptance = true }
        let store = await connected(network, journal: url)
        _ = await store.setTodoDone(store.todos[0], done: true)
        store.disconnect()
        var journal = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var todos = try XCTUnwrap(journal["todos"] as? [String: [String: Any]])
        for key in todos.keys { todos[key]?.removeValue(forKey: "note"); todos[key]?.removeValue(forKey: "fileIds") }
        journal["todos"] = todos
        try JSONSerialization.data(withJSONObject: journal).write(to: url)
        server.change { $0.loseTodoBeforeAcceptance = false }
        let restarted = await connected(network, journal: url)
        let retried = await restarted.retryTodoCompletion(restarted.todos[0])
        XCTAssertTrue(retried)
        let body = try WriteTestServer.body(XCTUnwrap(network.requests.last { $0.url?.path == "/api/todos/t/done" }))
        XCTAssertNil(body["note"]); XCTAssertNil(body["fileIds"])
        restarted.disconnect(); await network.close()
    }

    func testQRConnectionACKFollowsAuthenticatedBootstrapAndACKLossDoesNotReconnect() async throws {
        for failACK in [false, true] {
            let server = HandoffServer(), network = try IsolatedTestNetwork(handler: server.handle)
            server.change { $0.failACK = failACK }
            let store = AppStore(session: network.session, persistCredentials: false)
            let linked = await store.pair(with: PairingLink(code: "ABCDEFGH", urls: [network.endpoint.url]), device: "iPhone")
            XCTAssertTrue(linked)
            let requests = network.requests
            let bootstrap = try XCTUnwrap(requests.firstIndex { $0.url?.path == "/api/bootstrap" })
            let ack = try XCTUnwrap(requests.firstIndex { $0.url?.path == "/api/pair/ack" })
            XCTAssertGreaterThan(ack, bootstrap)
            XCTAssertEqual(requests[ack].value(forHTTPHeaderField: "Authorization"), "Bearer test")
            XCTAssertEqual(try WriteTestServer.body(requests[ack])["code"] as? String, "ABCDEFGH")
            XCTAssertEqual(requests.filter { $0.url?.path == "/pair/claim" }.count, 1)
            XCTAssertEqual(requests.filter { $0.url?.path == "/api/pair/ack" }.count, 1)
            store.disconnect(); await network.close()
        }
    }

    func testQRClaimWithoutAuthenticatedConnectionNeverACKs() async throws {
        let server = HandoffServer(), network = try IsolatedTestNetwork(handler: server.handle)
        server.change { $0.rejectBootstrap = true }
        let store = AppStore(session: network.session, persistCredentials: false)
        let linked = await store.pair(with: PairingLink(code: "ABCDEFGH", urls: [network.endpoint.url]), device: "iPhone")
        XCTAssertFalse(linked)
        XCTAssertFalse(network.requests.contains { $0.url?.path == "/api/pair/ack" })
        store.disconnect(); await network.close()
    }

    func testLegacyServerWithoutACKTokenStillConnectsWithoutExtraWrite() async throws {
        let server = HandoffServer(), network = try IsolatedTestNetwork(handler: server.handle)
        server.change { $0.legacyPairing = true }
        let store = AppStore(session: network.session, persistCredentials: false)
        let linked = await store.pair(with: PairingLink(code: "ABCDEFGH", urls: [network.endpoint.url]), device: "iPhone")
        XCTAssertTrue(linked)
        XCTAssertFalse(network.requests.contains { $0.url?.path == "/api/pair/ack" })
        store.disconnect(); await network.close()
    }

    func testMemberCreationContinuesAfterNoticeDismissalAndOpensExactEmployeeComposer() async throws {
        let server = HandoffServer(), network = try IsolatedTestNetwork(handler: server.handle)
        server.change { $0.delayCreation = true }
        let store = await connected(network), notice = MemberCreationNotice(), router = Router(destination: .files)
        let task = Task { await notice.create(store: store, name: "새 직원", role: "", provider: "claude", model: nil) }
        try await eventually { network.requests.contains { $0.url?.path == "/api/projects/p/members" } }
        XCTAssertTrue(notice.running)
        notice.clear()
        await server.gate.release()
        let outcome = await task.value
        XCTAssertEqual(outcome, .created("new-member"))
        XCTAssertNotNil(notice.message)
        router.chatTarget = "m"
        let opened = await notice.openMember(store: store, router: router)
        XCTAssertTrue(opened)
        XCTAssertEqual(router.destination, .chat); XCTAssertEqual(router.chatTarget, "new-member")
        XCTAssertEqual(router.focusComposer, 1)
        XCTAssertNil(notice.message)
        store.disconnect(); await network.close()
    }

    func testMemberPartialSuccessAndDefiniteFailureNeverAutomaticallyRecreate() async throws {
        for partial in [true, false] {
            let server = HandoffServer(), network = try IsolatedTestNetwork(handler: server.handle)
            server.change { $0.loseCreation = partial; $0.rejectCreation = !partial }
            let store = await connected(network), notice = MemberCreationNotice()
            let outcome = await notice.create(store: store, name: "새 직원", role: "", provider: "claude", model: nil)
            if partial {
                guard case .partial(let id, _) = outcome else { XCTFail("Expected partial success"); store.disconnect(); await network.close(); continue }
                XCTAssertEqual(id, "new-member")
            } else {
                guard case .failed = outcome else { XCTFail("Expected failure"); store.disconnect(); await network.close(); continue }
                XCTAssertNil(notice.memberID)
            }
            XCTAssertTrue(notice.failed)
            XCTAssertFalse(notice.message?.contains("raw internal") == true)
            XCTAssertEqual(network.requests.filter { $0.url?.path == "/api/projects/p/members" }.count, 1)
            store.disconnect(); await network.close()
        }
    }

    func testLateMemberCreationCannotOpenConversationOnChangedHost() async throws {
        let server = HandoffServer(), network = try IsolatedTestNetwork(handler: server.handle)
        server.change { $0.delayCreation = true }
        let store = await connected(network), notice = MemberCreationNotice()
        let task = Task { await notice.create(store: store, name: "새 직원", role: "", provider: "claude", model: nil) }
        try await eventually { network.requests.contains { $0.url?.path == "/api/projects/p/members" } }
        store.disconnect()
        await server.gate.release()
        let outcome = await task.value
        XCTAssertEqual(outcome, .hostChanged)
        XCTAssertNil(notice.memberID)
        let router = Router(destination: .home)
        let opened = await notice.openMember(store: store, router: router)
        XCTAssertFalse(opened)
        XCTAssertEqual(router.destination, .home)
        await network.close()
    }
}
