import Foundation
import XCTest
@testable import IAMCEO

/// A fully intercepted server, shared by the two W5 suites. It records effects separately from responses.
final class WriteTestServer: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    var bootstrap = Bootstrap(projects: [ProjectSummary(id: "p")])
    var state = ProjectState(project: Project(id: "p"), members: [Member(id: "m", projectId: "p")], todos: [Todo(id: "t", projectId: "p")])
    var revisions = SyncRevisions(settings: 1, members: ["m": MemberRevisions(configRevision: 1, sessionGeneration: 1)], todos: ["t": 1])
    var messages: [String: Message] = [:]
    var receipts: [String: OperationReceipt] = [:]
    var sentIDs: [String] = []
    var terminalBodies: [[String: Any]] = []
    var settingsBodies: [[String: Any]] = []
    /// false: a server that takes the settings write but keeps reporting the permission choice as unmade.
    var acceptsPermissionChoice = true
    var todoSends = 0
    var freshSends = 0
    var dropMessage = false
    var storeMessage = true
    var messageLookupStatus: Int?
    var dropTerminal = false
    var terminalUnknown = false
    var uniqueTerminalLeases = false
    var storeTerminalReceipt = true
    var freshUnknown = false
    var dropFresh = false
    var dropTodo = false
    var rejectAll = false
    var syncFailure = false
    var decisionStatuses: [String: Int] = [:]
    var gate: DispatchSemaphore?
    var entered: XCTestExpectation?

    func change(_ body: (WriteTestServer) -> Void) { lock.withLock { body(self) } }
    func read<T>(_ body: (WriteTestServer) -> T) -> T { lock.withLock { body(self) } }

    static func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
        }
        return data.isEmpty ? [:] : try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    func reply<T: Encodable>(_ value: T) throws -> IsolatedTestHTTPReply {
        IsolatedTestHTTPReply(data: try JSONEncoder().encode(value))
    }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        lock.lock(); defer { lock.unlock() }
        if rejectAll { return IsolatedTestHTTPReply(status: 401) }
        let path = request.url!.path
        switch path {
        case "/api/capabilities":
            return try reply(ServerCapabilities(contractVersion: 2, capabilities: CapabilityFlags(operations: true)))
        case "/api/bootstrap": return try reply(bootstrap)
        case "/api/runtime": return IsolatedTestHTTPReply()
        case "/api/projects/p/state": return try reply(state)
        case "/api/sync":
            if syncFailure { throw URLError(.timedOut) }
            return try reply(SyncSnapshot(protocolVersion: 2, cursor: SyncCursor(epoch: "test", seq: 1), requestedProjectId: "p", projectStatus: .ok, bootstrap: bootstrap, state: state, revisions: revisions))
        case "/api/projects/p/messages":
            let body = try Self.body(request), id = try XCTUnwrap(body["id"] as? String)
            sentIDs.append(id)
            let message = Message(id: id, projectId: "p", mine: true, body: body["text"] as? String ?? "", targetMemberId: body["targetMemberId"] as? String)
            if storeMessage { messages[id] = message }
            if dropMessage { throw URLError(.timedOut) }
            return try reply(message)
        case "/api/settings":
            let body = try Self.body(request)
            settingsBodies.append(body)
            guard request.value(forHTTPHeaderField: "If-Match") == "\"\(revisions.settings!)\"" else { return IsolatedTestHTTPReply(status: 409) }
            if let value = body["permissionMode"] as? String { bootstrap.settings.permissionMode = value }
            if body["permissionAcknowledged"] as? Bool == true, bootstrap.settings.permissionAcknowledged != nil, acceptsPermissionChoice {
                bootstrap.settings.permissionAcknowledged = true
            }
            if let value = body["compactAtPct"] as? Int { bootstrap.settings.compactAtPct = value }
            revisions.settings! += 1
            return try reply(SettingsWriteResult(settings: bootstrap.settings, revision: revisions.settings!))
        case "/api/todos/t/done":
            todoSends += 1
            let body = try Self.body(request)
            guard request.value(forHTTPHeaderField: "If-Match") == "\"\(revisions.todos!["t"]!)\"" else { return IsolatedTestHTTPReply(status: 409) }
            state.todos[0].done = body["done"] as? Bool ?? false
            revisions.todos!["t"]! += 1
            if dropTodo { syncFailure = true; throw URLError(.timedOut) }
            return try reply(TodoWriteResult(todo: state.todos[0], revision: revisions.todos!["t"]!))
        case "/api/members/m/fresh-session":
            freshSends += 1
            let body = try Self.body(request), id = try XCTUnwrap(body["operationId"] as? String)
            let receipt = OperationReceipt(operationId: id, kind: .freshSession, memberId: "m", status: freshUnknown ? .unknown : .applied,
                                           result: freshUnknown ? nil : .freshSession(FreshSessionResult(member: state.members[0], sessionGeneration: 2)))
            receipts[id] = receipt
            if dropFresh { throw URLError(.timedOut) }
            return try reply(receipt)
        case "/api/members/m/terminal/control":
            let body = try Self.body(request), id = try XCTUnwrap(body["operationId"] as? String)
            terminalBodies.append(body)
            let action = try XCTUnwrap(body["action"] as? String)
            let result = TerminalControlResultV2(memberId: "m", action: action, claimId: body["claimId"] as! String,
                                                 sessionGeneration: body["expectedSessionGeneration"] as! Int,
                                                 inputSequence: body["inputSequence"] as? Int, leaseId: action == "release" ? nil : (uniqueTerminalLeases ? body["claimId"] as? String : "lease"),
                                                 expiresAt: 9_999_999_999_999)
            let receipt = OperationReceipt(operationId: id, kind: .terminalControl, memberId: "m", status: terminalUnknown ? .unknown : .applied,
                                           result: terminalUnknown ? nil : .terminalControl(result))
            if storeTerminalReceipt { receipts[id] = receipt }
            if let gate {
                let entered = self.entered
                lock.unlock(); entered?.fulfill(); XCTAssertEqual(gate.wait(timeout: .now() + 5), .success, "Fixture gate timed out"); lock.lock()
            }
            if dropTerminal { throw URLError(.timedOut) }
            return try reply(receipt)
        case "/api/uploads":
            if let gate {
                let entered = self.entered
                lock.unlock(); entered?.fulfill(); XCTAssertEqual(gate.wait(timeout: .now() + 5), .success, "Fixture gate timed out"); lock.lock()
            }
            return try reply(Attachment(id: "file", url: "/uploads/file"))
        default:
            if path.hasPrefix("/api/messages/") {
                if let status = messageLookupStatus { return IsolatedTestHTTPReply(status: status) }
                guard let message = messages[String(path.dropFirst("/api/messages/".count))] else { return IsolatedTestHTTPReply(status: 404) }
                return try reply(message)
            }
            if path.hasPrefix("/api/operations/") {
                guard let receipt = receipts[String(path.dropFirst("/api/operations/".count))] else { return IsolatedTestHTTPReply(status: 404) }
                return try reply(receipt)
            }
            if path.hasPrefix("/api/decisions/") {
                let id = String(path.split(separator: "/")[2])
                if let status = decisionStatuses[id] {
                    if status == 0 { throw URLError(.timedOut) }
                    return IsolatedTestHTTPReply(status: status)
                }
                let body = try Self.body(request)
                return try reply(Decision(id: id, projectId: "p", status: "answered", choice: body["choice"] as? String, note: body["note"] as? String))
            }
            return IsolatedTestHTTPReply(status: 404)
        }
    }
}

@MainActor final class SubmissionTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork, drafts: DraftStore? = nil, submissions: SubmissionStore? = nil, journal: URL? = nil) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, drafts: drafts, submissions: submissions, writeStorageURL: journal)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }

    func testRestartAutomaticallyFindsAcceptedAttemptAndPreservesEditedDraft() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer()
        server.change { $0.dropMessage = true }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let draftURL = root.appendingPathComponent("draft"), submissionURL = root.appendingPathComponent("submission")
        let drafts = DraftStore(storageURL: draftURL)
        let store = await connect(network, drafts: drafts, submissions: try SubmissionStore(storageURL: submissionURL))
        let sent = await store.sendMessage(text: "original")
        XCTAssertFalse(sent)
        let id = try XCTUnwrap(server.read { $0.sentIDs.first })
        drafts.setText("new edit", for: DraftStore.key(project: "p", target: nil))
        store.disconnect()
        let restoredDrafts = DraftStore(storageURL: draftURL)
        let restored = try SubmissionStore(storageURL: submissionURL)
        let restarted = await connect(network, drafts: restoredDrafts, submissions: restored)
        XCTAssertEqual(restored.messageAttempt(id: id)?.status, .accepted)
        XCTAssertEqual(restoredDrafts.text(for: DraftStore.key(project: "p", target: nil)), "new edit")
        XCTAssertEqual(server.read { $0.sentIDs.count }, 1)
        restarted.disconnect()
    }

    func testConfirmedAbsenceRetriesSameIDAndUnknownLookupNeverPosts() async throws {
        let server = WriteTestServer()
        server.change { $0.dropMessage = true; $0.storeMessage = false }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        let first = await store.sendMessage(text: "same")
        XCTAssertFalse(first)
        server.change { $0.messageLookupStatus = 503 }
        let unknown = await store.sendMessage(text: "edited")
        XCTAssertFalse(unknown)
        XCTAssertEqual(server.read { $0.sentIDs.count }, 1)
        server.change { $0.messageLookupStatus = nil; $0.dropMessage = false; $0.storeMessage = true }
        let retry = await store.sendMessage(text: "same")
        XCTAssertTrue(retry)
        XCTAssertEqual(server.read { Set($0.sentIDs).count }, 1)
        store.disconnect()
    }

    func testIntentionalIdenticalMessageAfterAcceptanceHasNewID() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        let first = await store.sendMessage(text: "repeat")
        let second = await store.sendMessage(text: "repeat")
        XCTAssertTrue(first); XCTAssertTrue(second)
        XCTAssertEqual(server.read { Set($0.sentIDs).count }, 2)
        store.disconnect()
    }

    func testUnavailableLookupKeepsOriginalIDCheckingUntilReceiptReturns() async throws {
        let server = WriteTestServer()
        server.change { $0.dropMessage = true }
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasPrefix("/api/messages/") == true,
               server.read({ $0.dropMessage }) { throw URLError(.resourceUnavailable) }
            return try server.handle(request)
        }
        let store = await connect(network)
        defer { store.disconnect() }
        let first = await store.sendMessage(text: "Hello")
        XCTAssertFalse(first)
        let id = try XCTUnwrap(server.read { $0.sentIDs.first })
        let retry = await store.sendMessage(text: "Hello")
        XCTAssertFalse(retry)
        XCTAssertEqual(server.read { $0.sentIDs }, [id])
        XCTAssertEqual(store.submissions?.messageAttempt(id: id)?.status, .checking)
        XCTAssertTrue(store.errorMessage?.contains("접수 확인 중") == true)
        XCTAssertEqual(store.drafts.text(for: DraftStore.key(project: "p", target: nil)), "", "The unresolved body lives in SubmissionStore, separately from the next draft")

        server.change { $0.dropMessage = false }
        await store.recoverWrites()
        XCTAssertEqual(store.submissions?.messageAttempt(id: id)?.status, .accepted)
        XCTAssertEqual(server.read { $0.sentIDs }, [id])
        XCTAssertEqual(store.drafts.text(for: DraftStore.key(project: "p", target: nil)), "")
    }

    func testMismatchedAcknowledgementRequiresMatchingReceiptWithoutAnotherPost() async throws {
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork { request in
            let reply = try server.handle(request)
            if request.url?.path == "/api/projects/p/messages" {
                return IsolatedTestHTTPReply(data: Data(#"{"id":"sent","projectId":"p","mine":true,"body":"Hello"}"#.utf8))
            }
            return reply
        }
        let store = await connect(network)
        defer { store.disconnect() }
        let first = await store.sendMessage(text: "Hello")
        XCTAssertFalse(first)
        let id = try XCTUnwrap(server.read { $0.sentIDs.first })
        XCTAssertEqual(store.submissions?.messageAttempt(id: id)?.status, .checking)

        let recovered = await store.sendMessage(text: "Hello")
        XCTAssertTrue(recovered)
        XCTAssertEqual(store.submissions?.messageAttempt(id: id)?.status, .accepted)
        XCTAssertEqual(server.read { $0.sentIDs }, [id])
    }

    func testMessageLookup401EndsAuthenticationAndKeepsUnresolvedAttempt() async throws {
        let server = WriteTestServer()
        server.change { $0.dropMessage = true }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let first = await store.sendMessage(text: "Hello")
        XCTAssertFalse(first)
        let id = try XCTUnwrap(server.read { $0.sentIDs.first })
        server.change { $0.messageLookupStatus = 401 }
        let retry = await store.sendMessage(text: "Hello")
        XCTAssertFalse(retry)
        XCTAssertFalse(store.canWrite)
        XCTAssertNil(store.api)
        XCTAssertEqual(store.connectionStatus, .failed)
        XCTAssertEqual(store.submissions?.messageAttempt(id: id)?.status, .checking)
        XCTAssertEqual(server.read { $0.sentIDs }, [id])
        XCTAssertFalse(store.errorMessage?.contains("접수 확인 중") == true)
    }

    func testHostSwitchAndDraftDeletionRejectLateUpload() async throws {
        for switchHost in [false, true] {
            let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
            let otherServer = WriteTestServer(), other = try IsolatedTestNetwork(handler: otherServer.handle)
            let store = await connect(network)
            let entered = expectation(description: "upload entered"), gate = DispatchSemaphore(value: 0)
            server.change { $0.entered = entered; $0.gate = gate }
            let upload = Task { await store.upload(data: Data("a".utf8), filename: "a", mime: "text/plain") }
            await fulfillment(of: [entered], timeout: 3)
            if switchHost {
                store.endpoint = other.endpoint.url.absoluteString
                await store.connect(); store.setForeground(false)
            } else { store.drafts.clear(DraftStore.key(project: "p", target: nil)) }
            gate.signal()
            let file = await upload.value
            XCTAssertNil(file)
            XCTAssertTrue(store.drafts.files(for: DraftStore.key(project: "p", target: nil)).isEmpty)
            store.disconnect()
        }
    }

    func testLostClaimRestoresLeaseAndUnknownInputCannotReplay() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        server.change { $0.dropTerminal = true }
        let claim = await store.claimTerminal(store.members[0])
        XCTAssertTrue(claim)
        XCTAssertEqual(store.terminalLeases["m"]?.leaseId, "lease")
        server.change { $0.terminalUnknown = true }
        let input = await store.terminalInput(store.members[0], text: "yes")
        let retry = await store.terminalInput(store.members[0], text: "yes")
        let key = await store.terminalKey(store.members[0], key: "enter")
        XCTAssertFalse(input); XCTAssertFalse(retry); XCTAssertFalse(key)
        XCTAssertEqual(server.read { $0.terminalBodies.count }, 2)
        XCTAssertEqual(store.terminalLeases["m"]?.leaseId, "lease")
        XCTAssertEqual(store.submissions?.terminalInput(namespace: store.writeNamespace, memberID: "m").text, "yes")
        store.disconnect()
    }

    func testAppliedInputConsumesOnlyCapturedRevision() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        let claim = await store.claimTerminal(store.members[0]); XCTAssertTrue(claim)
        let entered = expectation(description: "input entered"), gate = DispatchSemaphore(value: 0)
        server.change { $0.entered = entered; $0.gate = gate }
        let send = Task { await store.terminalInput(store.members[0], text: "first") }
        await fulfillment(of: [entered], timeout: 3)
        try store.submissions?.setTerminalInput("later", namespace: store.writeNamespace, memberID: "m")
        gate.signal()
        let applied = await send.value
        XCTAssertTrue(applied)
        XCTAssertEqual(store.submissions?.terminalInput(namespace: store.writeNamespace, memberID: "m").text, "later")
        store.disconnect()
    }

    func testFreshLostReplyQueriesReceiptInsteadOfRotatingAgain() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        server.change { $0.dropFresh = true }
        let applied = await store.memberAction(store.members[0], action: "fresh-session")
        XCTAssertTrue(applied)
        XCTAssertEqual(server.read { $0.freshSends }, 1)
        XCTAssertTrue(network.requests.contains { $0.url?.path.hasPrefix("/api/operations/") == true })
        store.disconnect()
    }
    func testMissingClaimReceiptExplicitRetryReusesBothIDs() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        server.change { $0.dropTerminal = true; $0.storeTerminalReceipt = false }
        let first = await store.claimTerminal(store.members[0]); XCTAssertFalse(first)
        server.change { $0.dropTerminal = false; $0.storeTerminalReceipt = true }
        let retry = await store.claimTerminal(store.members[0]); XCTAssertTrue(retry)
        let bodies = server.read { $0.terminalBodies }
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(bodies[0]["claimId"] as? String, bodies[1]["claimId"] as? String)
        XCTAssertEqual(bodies[0]["operationId"] as? String, bodies[1]["operationId"] as? String)
        store.disconnect()
    }

    func testRestartPreservesUnknownPhysicalInputAndRestoresClaimWithoutReplay() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let submissionURL = root.appendingPathComponent("submission"), journalURL = root.appendingPathComponent("journal")
        let store = await connect(network, submissions: try SubmissionStore(storageURL: submissionURL), journal: journalURL)
        let member = store.members[0]
        let claimed = await store.claimTerminal(member); XCTAssertTrue(claimed)
        server.change { $0.dropTerminal = true; $0.terminalUnknown = true }
        let input = await store.terminalInput(member, text: "uncertain"); XCTAssertFalse(input)
        let claimID = server.read { $0.terminalBodies[0]["claimId"] as? String }
        store.disconnect()
        let restarted = await connect(network, submissions: try SubmissionStore(storageURL: submissionURL), journal: journalURL)
        XCTAssertEqual(restarted.terminalLeases["m"]?.leaseId, "lease")
        let retry = await restarted.terminalKey(restarted.members[0], key: "enter"); XCTAssertFalse(retry)
        XCTAssertEqual(server.read { $0.terminalBodies.count }, 2)
        XCTAssertEqual(try restarted.submissions?.terminalClaim(namespace: restarted.writeNamespace, memberID: "m", sessionGeneration: 1), claimID)
        restarted.disconnect()
    }

    func testReleasedLeaseDoesNotResurrectDuringRecovery() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        let claimed = await store.claimTerminal(store.members[0]); XCTAssertTrue(claimed)
        let released = await store.releaseTerminal(store.members[0]); XCTAssertTrue(released)
        for _ in 0..<3 { await store.recoverWrites(); XCTAssertNil(store.terminalLeases["m"]) }
        store.disconnect()
    }

    func testUnknownFreshOperationSurvivesRestartAndCannotRotateAgain() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        server.change { $0.freshUnknown = true; $0.dropFresh = true }
        let journalURL = root.appendingPathComponent("journal")
        let store = await connect(network, journal: journalURL)
        let first = await store.freshSession(store.members[0]); XCTAssertFalse(first)
        store.disconnect()
        let restarted = await connect(network, journal: journalURL)
        let retry = await restarted.freshSession(restarted.members[0]); XCTAssertFalse(retry)
        XCTAssertEqual(server.read { $0.freshSends }, 1)
        restarted.disconnect()
    }

    func testCompletedAttachmentRestoresWithHostAndSubmitsTheSameID() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let url = root.appendingPathComponent("draft")
        let store = await connect(network, drafts: DraftStore(storageURL: url))
        let file = await store.upload(data: Data("a".utf8), filename: "a", mime: "text/plain")
        XCTAssertEqual(file?.id, "file")
        store.disconnect()
        let restarted = await connect(network, drafts: DraftStore(storageURL: url))
        XCTAssertEqual(restarted.drafts.files(for: DraftStore.key(project: "p", target: nil)).map(\.id), ["file"])
        let sent = await restarted.sendMessage(text: "", attachmentIDs: ["file"]); XCTAssertTrue(sent)
        let request = try XCTUnwrap(network.requests.last { $0.url?.path == "/api/projects/p/messages" })
        XCTAssertEqual(try WriteTestServer.body(request)["attachmentIds"] as? [String], ["file"])
        restarted.disconnect()
    }

    func testCorruptWriteJournalFailsClosedBeforeFreshOrTerminalPost() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("broken".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network, journal: url)
        let fresh = await store.freshSession(store.members[0]); XCTAssertFalse(fresh)
        let claim = await store.claimTerminal(store.members[0]); XCTAssertFalse(claim)
        XCTAssertEqual(server.read { $0.freshSends }, 0)
        XCTAssertEqual(server.read { $0.terminalBodies.count }, 0)
        store.disconnect()
    }

}
