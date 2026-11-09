import Foundation
import SwiftUI
import XCTest
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif
@testable import IAMCEO

private actor FollowupGate {
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

private final class FollowupHolds: @unchecked Sendable {
    private let lock = NSLock()
    private var gates: [FollowupGate] = []
    func append(_ gate: FollowupGate) { lock.withLock { gates.append(gate) } }
    func take() -> FollowupGate? { lock.withLock { gates.isEmpty ? nil : gates.removeFirst() } }
}

private final class FollowupMessagePosts: @unchecked Sendable {
    private let lock = NSLock()
    private var captured: [SendMessageRequest] = []
    func capture(_ request: URLRequest) throws {
        let body = try WriteTestServer.body(request)
        let sent = SendMessageRequest(id: try XCTUnwrap(body["id"] as? String),
            text: try XCTUnwrap(body["text"] as? String), targetMemberId: body["targetMemberId"] as? String,
            attachmentIds: body["attachmentIds"] as? [String] ?? [], contextFileId: body["contextFileId"] as? String)
        lock.withLock { captured.append(sent) }
    }
    var requests: [SendMessageRequest] { lock.withLock { captured } }
}

#if os(macOS)
/// Uses the same commit/eligibility/send entry point as ComposerBar's Return and button actions.
@MainActor private final class FollowupComposerEditor {
    let editor = MacComposerTextView.Editor()
    let coordinator: MacComposerTextView.Coordinator
    private var post: Task<Bool, Never>?
    init(store: AppStore, key: String) {
        let composer = MacComposerTextView(
            text: Binding(get: { store.drafts.text(for: key) }, set: { store.drafts.setText($0, for: key) }),
            focused: .constant(false), placeholder: "test", intake: MacAttachmentIntake(),
            canReceive: { false }, receive: { _ in false }, submit: {},
            textRevision: { store.drafts.revision(for: key) }, drafts: store.drafts, draftKey: key)
        coordinator = composer.makeCoordinator()
        editor.delegate = coordinator
        editor.textChanged = { [weak editor, weak coordinator] in
            if let editor { coordinator?.publish(editor) }
        }
        coordinator.connect(editor)
        coordinator.synchronize(editor, text: store.drafts.text(for: key), revision: store.drafts.revision(for: key))
        editor.submit = { [weak self] in
            self?.post = Task { await ComposerBar.submit(in: store, targetMemberID: nil) }
        }
    }
    func mark(_ text: String) {
        editor.setMarkedText(text, selectedRange: NSRange(location: text.utf16.count, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
    }
    func type(_ text: String) {
        mark(text)
        editor.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
    }
    func pressReturn() throws -> Task<Bool, Never> {
        post = nil
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r",
            isARepeat: false, keyCode: 36))
        editor.keyDown(with: event)
        return try XCTUnwrap(post)
    }
}
#endif

@MainActor final class UXFollowupTests: XCTestCase {
    private let key = DraftStore.key(project: "p", target: nil)

    private func finish(_ task: Task<Void, Never>, file: StaticString = #filePath, line: UInt = #line) async {
        await withTestDeadline(fallback: (), file: file, line: line) { done in
            Task { await task.value; done.resume() }
        }
        task.cancel()
    }
    private func finish(_ task: Task<Bool, Never>, file: StaticString = #filePath, line: UInt = #line) async -> Bool {
        let result = await withTestDeadline(fallback: false, file: file, line: line) { done in
            Task { done.resume(returning: await task.value) }
        }
        task.cancel()
        return result
    }
    private func waitUntil(_ condition: () async -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { XCTFail("Followup condition timed out"); throw TestDeadlineError.expired }
            try await Task.sleep(for: .milliseconds(2))
        }
    }
    private func connect(_ network: IsolatedTestNetwork, drafts: DraftStore? = nil,
                         submissions: SubmissionStore? = nil) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, drafts: drafts, submissions: submissions)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await finish(Task { await store.connect() })
        store.setForeground(false)
        XCTAssertTrue(store.canWrite)
        return store
    }
    private func file(_ id: String) -> Attachment { Attachment(id: id, url: "/uploads/\(id)") }

    func testPendingPostClearsImmediatelyAndSuccessKeepsNextDraftAndAttachments() async throws {
        let server = WriteTestServer()
        let entered = expectation(description: "POST response held")
        let gate = FollowupGate(entered)
        let network = try IsolatedTestNetwork { request in
            var reply = try server.handle(request)
            if request.url?.path == "/api/projects/p/messages" { reply.beforeDelivery = { await gate.wait() } }
            return reply
        }
        let store = await connect(network)
        defer { store.disconnect() }
        store.drafts.setText("보낸 글", for: key); store.drafts.addFile(file("sent"), for: key)
        let post = Task { await store.sendMessage(text: "보낸 글", attachmentIDs: ["sent"]) }
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertEqual(store.drafts.text(for: key), "")
        XCTAssertTrue(store.drafts.files(for: key).isEmpty)
        XCTAssertTrue(store.isSending(projectID: "p", targetMemberID: nil))
        store.drafts.setText("다음 글", for: key); store.drafts.addFile(file("next"), for: key)
        let second = await finish(Task { await store.sendMessage(text: "다음 글", attachmentIDs: ["next"]) })
        XCTAssertFalse(second)
        XCTAssertTrue(store.messageSendNotice(targetMemberID: nil)?.contains("앞선 글을 보내는 중") == true)
        await finish(Task { await store.recoverWrites() })
        XCTAssertFalse(network.requests.contains { $0.url?.path.hasPrefix("/api/messages/") == true }, "Do not query an active POST for absence")
        await gate.release()
        let accepted = await finish(post)
        XCTAssertTrue(accepted)
        XCTAssertEqual(store.drafts.text(for: key), "다음 글")
        XCTAssertEqual(store.drafts.files(for: key).map(\.id), ["next"])
        XCTAssertEqual(server.read { $0.sentIDs.count }, 1)
        await network.close()
    }

    func testDefiniteFailureRestoresEmptyOrRetainsOriginalBesideNextDraft() async throws {
        for withNext in [false, true] {
            let server = WriteTestServer()
            let entered = expectation(description: "refusal held"), gate = FollowupGate(entered)
            let network = try IsolatedTestNetwork { request in
                if request.url?.path == "/api/projects/p/messages" {
                    return IsolatedTestHTTPReply(status: 422, data: Data(#"{"error":"rejected"}"#.utf8),
                                                beforeDelivery: { await gate.wait() })
                }
                return try server.handle(request)
            }
            let store = await connect(network)
            store.drafts.setText("원문", for: key); store.drafts.addFile(file("sent"), for: key)
            let post = Task { await store.sendMessage(text: "원문", attachmentIDs: ["sent"]) }
            await fulfillment(of: [entered], timeout: 3)
            XCTAssertEqual(store.drafts.text(for: key), "")
            if withNext {
                store.drafts.setText("새 글", for: key)
                store.drafts.addFile(file("next"), for: key); store.drafts.addFile(file("sent"), for: key)
            }
            await gate.release()
            let accepted = await finish(post)
            XCTAssertFalse(accepted)
            XCTAssertEqual(store.drafts.text(for: key), withNext ? "새 글" : "원문")
            XCTAssertEqual(store.drafts.files(for: key).map(\.id), withNext ? ["next", "sent"] : ["sent"])
            let submissions = try XCTUnwrap(store.submissions)
            let attempt = try XCTUnwrap(submissions.messages(namespace: store.writeNamespace).first)
            XCTAssertEqual(attempt.status, .refused)
            let notices = submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts)
            XCTAssertEqual(notices.map(\.id), [attempt.id])
            XCTAssertEqual(notices.first?.failureDisposition, withNext ? .retained : .restored)
            XCTAssertTrue(notices.first?.failureText.contains("보내지 못했습니다: rejected") == true)
            if !withNext { XCTAssertTrue(notices.first?.failureText.contains("글은 입력칸에 되돌려 두었습니다") == true) }
            try submissions.restoreMessage(id: attempt.id, drafts: store.drafts)
            XCTAssertEqual(store.drafts.text(for: key), withNext ? "새 글" : "원문")
            store.disconnect(); await network.close()
        }
    }

    func testFailureNoticesAreViewIndependentDurableAndExplicitlyDismissedOrEdited() async throws {
        for withNext in [false, true] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let draftURL = root.appendingPathComponent("draft"), submissionURL = root.appendingPathComponent("submissions")
            let server = WriteTestServer()
            let entered = expectation(description: "durable refusal held"), gate = FollowupGate(entered)
            let network = try IsolatedTestNetwork { request in
                if request.httpMethod == "POST", request.url?.path == "/api/projects/p/messages" {
                    return IsolatedTestHTTPReply(status: 422, data: Data(#"{"error":"herdr-core에 연결할 수 없습니다"}"#.utf8),
                                                beforeDelivery: { await gate.wait() })
                }
                return try server.handle(request)
            }
            let store = await connect(network, drafts: DraftStore(storageURL: draftURL),
                                      submissions: try SubmissionStore(storageURL: submissionURL))
            let namespace = store.writeNamespace
            let post = Task { await store.sendMessage(text: "원문\n두 번째 줄") }
            await fulfillment(of: [entered], timeout: 3)
            if withNext { store.drafts.setText("새 글", for: key) }
            await gate.release(); _ = await finish(post)
            let first = try XCTUnwrap(store.submissions?.failureNotices(namespace: namespace, key: key, drafts: store.drafts).first)
            XCTAssertEqual(first.failurePreview, "원문")
            XCTAssertTrue(first.failureText.contains("herdr-core에 연결할 수 없습니다"))
            // ComposerBar reads this store query on every instance; it has no local failure State.
            _ = ComposerBar(target: .constant(nil))
            XCTAssertEqual(store.submissions?.failureNotices(namespace: namespace, key: key, drafts: store.drafts).map(\.id), [first.id])
            _ = ComposerBar(target: .constant(nil))
            XCTAssertEqual(store.submissions?.failureNotices(namespace: namespace, key: key, drafts: store.drafts).map(\.id), [first.id])
            store.disconnect()
            let drafts = DraftStore(namespace: namespace, storageURL: draftURL)
            let submissions = try SubmissionStore(storageURL: submissionURL)
            try submissions.recoverMessageDrafts(drafts: drafts)
            XCTAssertEqual(submissions.failureNotices(namespace: namespace, key: key, drafts: drafts).map(\.id), [first.id])
            XCTAssertEqual(drafts.text(for: key), withNext ? "새 글" : "원문\n두 번째 줄")
            if withNext {
                // Even deleting the next draft later cannot silently restore or dismiss this failure.
                drafts.clear(key)
                try submissions.recoverMessageDrafts(drafts: drafts)
                XCTAssertEqual(drafts.text(for: key), "")
                XCTAssertEqual(submissions.failureNotices(namespace: namespace, key: key, drafts: drafts).map(\.id), [first.id])
                try submissions.dismissMessageFailure(id: first.id)
            } else { drafts.setText("수정한 글", for: key) }
            XCTAssertTrue(submissions.failureNotices(namespace: namespace, key: key, drafts: drafts).isEmpty)
            let reloaded = try SubmissionStore(storageURL: submissionURL)
            let reloadedDrafts = DraftStore(namespace: namespace, storageURL: draftURL)
            try reloaded.recoverMessageDrafts(drafts: reloadedDrafts)
            XCTAssertTrue(reloaded.failureNotices(namespace: namespace, key: key, drafts: reloadedDrafts).isEmpty)
            await network.close()
        }
    }

    func testRetainedFailureRetryUsesOneOriginalPostAndPreservesNextDraft() async throws {
        let server = WriteTestServer()
        server.change { $0.storeMessage = false }
        let refused = expectation(description: "initial refusal"), refusalGate = FollowupGate(refused)
        let retried = expectation(description: "explicit retry"), retryGate = FollowupGate(retried)
        let network = try IsolatedTestNetwork { request in
            var replay = request
            if request.httpMethod == "POST", request.url?.path == "/api/projects/p/messages" {
                let body = try WriteTestServer.body(request)
                replay.httpBody = try JSONSerialization.data(withJSONObject: body)
                XCTAssertEqual(body["text"] as? String, "원문")
                XCTAssertEqual(body["attachmentIds"] as? [String], ["sent"])
                XCTAssertEqual(body["contextFileId"] as? String, "context")
                let response = try server.handle(replay)
                if server.read({ $0.sentIDs.count }) == 1 {
                    return IsolatedTestHTTPReply(status: 422, data: Data(#"{"error":"rejected"}"#.utf8),
                                                beforeDelivery: { await refusalGate.wait() })
                }
                return IsolatedTestHTTPReply(data: response.data, beforeDelivery: { await retryGate.wait() })
            }
            return try server.handle(replay)
        }
        let store = await connect(network)
        defer { store.disconnect() }
        store.drafts.addFile(file("sent"), for: key)
        let post = Task { await store.sendMessage(text: "원문", attachmentIDs: ["sent"], contextFileID: "context") }
        await fulfillment(of: [refused], timeout: 3)
        store.drafts.setText("새 글", for: key); store.drafts.addFile(file("next"), for: key)
        await refusalGate.release(); _ = await finish(post)
        let attempt = try XCTUnwrap(store.submissions?.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).first)
        server.change { $0.storeMessage = true }
        let revision = store.drafts.revision(for: key)
        let retry = Task { await store.retryFailedMessage(id: attempt.id) }
        await fulfillment(of: [retried], timeout: 3)
        let duplicate = await finish(Task { await store.retryFailedMessage(id: attempt.id) })
        XCTAssertFalse(duplicate)
        XCTAssertEqual(store.drafts.revision(for: key), revision)
        await retryGate.release()
        let accepted = await finish(retry)
        XCTAssertTrue(accepted)
        XCTAssertEqual(server.read { $0.sentIDs }, [attempt.id, attempt.id], "Exactly one explicit retry POST with the same ID")
        XCTAssertEqual(store.drafts.text(for: key), "새 글")
        XCTAssertEqual(store.drafts.files(for: key).map(\.id), ["next"])
        XCTAssertTrue(store.submissions?.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).isEmpty == true)
        await network.close()
    }

    func testBusyEmptyEditorRetainsFailureRatherThanRestoringAfterConfirmedAbsence() async throws {
        let server = WriteTestServer()
        server.change { $0.dropMessage = true; $0.storeMessage = false }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        _ = await finish(Task { await store.sendMessage(text: "원문") })
        let editorID = UUID()
        store.drafts.registerEditor(id: editorID, key: key, canRestore: { false }, commit: {}, synchronize: { _ in
            XCTFail("A composing editor must never be changed by an automatic failure restoration")
        })
        await finish(Task { await store.recoverWrites() })
        XCTAssertEqual(store.drafts.text(for: key), "")
        let attempt = try XCTUnwrap(store.submissions?.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).first)
        XCTAssertEqual(attempt.status, .notAccepted)
        XCTAssertEqual(attempt.failureDisposition, .retained)
        store.drafts.unregisterEditor(id: editorID)
        await finish(Task { await store.recoverWrites() })
        XCTAssertEqual(store.drafts.text(for: key), "")
        XCTAssertEqual(store.submissions?.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).map(\.id), [attempt.id])
        await network.close()
    }

    func testCheckingComposerSendExplainsSuppressionWithoutAnotherPostOrDraftChange() async throws {
        let server = WriteTestServer()
        server.change {
            $0.state.project.connection = ProjectConnection(ok: true)
            $0.dropMessage = true; $0.storeMessage = false; $0.messageLookupStatus = 503
        }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let empty = await finish(Task { await ComposerBar.submit(in: store, targetMemberID: nil) })
        XCTAssertFalse(empty)
        XCTAssertEqual(store.messageSendNotice(targetMemberID: nil), "보낼 글이나 첨부를 넣어 주세요.")
        XCTAssertEqual(server.read { $0.sentIDs.count }, 0)
        store.drafts.setText("원문", for: key)
        let first = await finish(Task { await ComposerBar.submit(in: store, targetMemberID: nil) })
        XCTAssertFalse(first)
        XCTAssertEqual(store.drafts.text(for: key), "")
        store.drafts.setText("새 글", for: key)
        let snapshot = store.drafts.snapshot(for: key)
        let second = await finish(Task { await ComposerBar.submit(in: store, targetMemberID: nil) })
        XCTAssertFalse(second)
        XCTAssertTrue(store.messageSendNotice(targetMemberID: nil)?.contains("접수 확인 중") == true)
        XCTAssertTrue(store.drafts.matches(snapshot))
        XCTAssertEqual(store.drafts.text(for: key), "새 글")
        XCTAssertEqual(server.read { $0.sentIDs.count }, 1)
        // The AppStore entry point must explain its own query/early-return path as well.
        let direct = await finish(Task { await store.sendMessage(text: "새 글") })
        XCTAssertFalse(direct)
        XCTAssertTrue(store.messageSendNotice(targetMemberID: nil)?.contains("접수 확인 중") == true)
        XCTAssertTrue(store.drafts.matches(snapshot))
        XCTAssertEqual(server.read { $0.sentIDs.count }, 1)
        await finish(Task { await network.close() })
    }

    func testUnknownResultQueriesAcceptanceWithoutRestoringOrPostingAgain() async throws {
        let server = WriteTestServer()
        let entered = expectation(description: "unknown response held"), gate = FollowupGate(entered)
        let network = try IsolatedTestNetwork { request in
            let reply = try server.handle(request)
            if request.url?.path == "/api/projects/p/messages" {
                return IsolatedTestHTTPReply(status: 503, beforeDelivery: { await gate.wait() })
            }
            return reply
        }
        let store = await connect(network)
        defer { store.disconnect() }
        let post = Task { await store.sendMessage(text: "원문") }
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertEqual(store.drafts.text(for: key), "")
        store.drafts.setText("새 글", for: key)
        await gate.release()
        let result = await finish(post)
        XCTAssertFalse(result)
        let id = try XCTUnwrap(server.read { $0.sentIDs.first })
        XCTAssertEqual(store.submissions?.messageAttempt(id: id)?.status, .checking)
        await finish(Task { await store.recoverWrites() })
        XCTAssertEqual(store.submissions?.messageAttempt(id: id)?.status, .accepted)
        XCTAssertEqual(store.drafts.text(for: key), "새 글")
        XCTAssertEqual(server.read { $0.sentIDs }, [id])
        await network.close()
    }

    func testAuthenticationRefusalRestoresCapturedNamespaceAfterConnectionInvalidation() async throws {
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/projects/p/messages" {
                return IsolatedTestHTTPReply(status: 401)
            }
            return try server.handle(request)
        }
        let store = await connect(network)
        defer { store.disconnect() }
        let namespace = store.writeNamespace
        let result = await finish(Task { await store.sendMessage(text: "복원할 글") })
        XCTAssertFalse(result)
        XCTAssertEqual(store.connectionStatus, .failed)
        XCTAssertEqual(store.drafts.namespace, "unassigned")
        XCTAssertEqual(store.drafts.text(for: key), "")
        store.drafts.selectNamespace(namespace)
        XCTAssertEqual(store.drafts.text(for: key), "복원할 글")
        XCTAssertEqual(store.submissions?.messages(namespace: namespace).first?.status, .refused)
        await network.close()
    }

    func testFailedDurableClearKeepsDraftAndNeverPosts() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("draft")
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let drafts = DraftStore(storageURL: url)
        let store = await connect(network, drafts: drafts)
        defer { store.disconnect() }
        drafts.setText("잃으면 안 되는 글", for: key)
        let token = drafts.uploadToken(for: key)
        // Turn only this fixture's draft file into an unwritable file destination.
        try FileManager.default.removeItem(at: url)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        let result = await finish(Task { await store.sendMessage(text: "잃으면 안 되는 글") })
        XCTAssertFalse(result)
        XCTAssertEqual(drafts.text(for: key), "잃으면 안 되는 글")
        XCTAssertTrue(drafts.isCurrentUpload(token), "A failed atomic clear must roll back its generation")
        XCTAssertNotNil(drafts.persistenceError)
        XCTAssertTrue(server.read { $0.sentIDs.isEmpty })
        await network.close()
    }

    func testUnknownThenConfirmedAbsentRestoresAndUneditedRetryKeepsID() async throws {
        let server = WriteTestServer()
        server.change { $0.dropMessage = true; $0.storeMessage = false }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let first = await finish(Task { await store.sendMessage(text: "원문") })
        XCTAssertFalse(first)
        XCTAssertEqual(store.drafts.text(for: key), "")
        await finish(Task { await store.recoverWrites() })
        XCTAssertEqual(store.drafts.text(for: key), "원문")
        let attempt = try XCTUnwrap(store.submissions?.messages(namespace: store.writeNamespace).first)
        XCTAssertEqual(attempt.status, .notAccepted)
        server.change { $0.dropMessage = false; $0.storeMessage = true }
        let retry = await finish(Task { await store.sendMessage(text: "원문") })
        XCTAssertTrue(retry)
        XCTAssertEqual(server.read { $0.sentIDs }, [attempt.id, attempt.id])
        XCTAssertEqual(store.drafts.text(for: key), "")
        await network.close()
    }

    func testUnknownThenConfirmedAbsentRetainsOriginalAndAllowsNextDraftAsNewIntent() async throws {
        let server = WriteTestServer()
        server.change { $0.dropMessage = true; $0.storeMessage = false }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        _ = await finish(Task { await store.sendMessage(text: "원문") })
        store.drafts.setText("다음", for: key)
        await finish(Task { await store.recoverWrites() })
        XCTAssertEqual(store.drafts.text(for: key), "다음")
        let refused = try XCTUnwrap(store.submissions?.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).first)
        XCTAssertEqual(refused.draft.text, "원문")
        XCTAssertEqual(refused.failureDisposition, .retained)
        server.change { $0.dropMessage = false; $0.storeMessage = true }
        let retry = await finish(Task { await store.sendMessage(text: "다음") })
        XCTAssertTrue(retry)
        XCTAssertEqual(server.read { Set($0.sentIDs).count }, 2)
        XCTAssertEqual(server.read { $0.messages.values.first?.body }, "다음")
        XCTAssertEqual(store.submissions?.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).map(\.id), [refused.id])
        await network.close()
    }

    func testRestartWithHeldPostKeepsDurableClearThenRecoversAcceptedOrAbsent() async throws {
        for accepted in [true, false] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let draftURL = root.appendingPathComponent("draft"), submissionURL = root.appendingPathComponent("submission")
            let server = WriteTestServer()
            server.change { $0.storeMessage = accepted }
            let entered = expectation(description: "restart with POST held"), gate = FollowupGate(entered)
            let network = try IsolatedTestNetwork { request in
                let reply = try server.handle(request)
                if request.url?.path == "/api/projects/p/messages" {
                    return IsolatedTestHTTPReply(status: 503, beforeDelivery: { await gate.wait() })
                }
                return reply
            }
            let store = await connect(network, drafts: DraftStore(storageURL: draftURL),
                                      submissions: try SubmissionStore(storageURL: submissionURL))
            let namespace = store.writeNamespace
            let post = Task { await store.sendMessage(text: "원문") }
            await fulfillment(of: [entered], timeout: 3)
            XCTAssertEqual(DraftStore(namespace: namespace, storageURL: draftURL).text(for: key), "")
            store.drafts.setText("다음", for: key)
            store.disconnect()
            let drafts = DraftStore(namespace: namespace, storageURL: draftURL)
            XCTAssertEqual(drafts.text(for: key), "다음")
            let restored = try SubmissionStore(storageURL: submissionURL)
            let restarted = await connect(network, drafts: drafts, submissions: restored)
            XCTAssertEqual(drafts.text(for: key), "다음")
            XCTAssertEqual(restored.failureNotices(namespace: namespace, key: key, drafts: drafts).map { $0.draft.text }, accepted ? [] : ["원문"])
            XCTAssertEqual(server.read { $0.sentIDs.count }, 1)
            await gate.release(); _ = await finish(post)
            restarted.disconnect()
            XCTAssertEqual(drafts.namespace, "unassigned")
            XCTAssertEqual(drafts.text(for: key), "")
            // Repeating recovery after another restart cannot restore the same original twice.
            let secondRestartDrafts = DraftStore(storageURL: draftURL)
            let secondRestartSubmissions = try SubmissionStore(storageURL: submissionURL)
            try secondRestartSubmissions.recoverMessageDrafts(drafts: secondRestartDrafts)
            XCTAssertEqual(secondRestartDrafts.namespace, "unassigned", "Recovery must not select a host")
            XCTAssertEqual(secondRestartDrafts.text(for: key), "")
            secondRestartDrafts.selectNamespace(namespace)
            XCTAssertEqual(secondRestartDrafts.text(for: key), "다음")
            XCTAssertEqual(secondRestartSubmissions.failureNotices(namespace: namespace, key: key, drafts: secondRestartDrafts).map { $0.draft.text }, accepted ? [] : ["원문"])
            await network.close()
        }
    }

    func testCrashWindowsBeforeDetachAndAfterRestoreAreIdempotentAcrossNamespaces() throws {
        let drafts = DraftStore(persist: false, namespace: "a"), submissions = try SubmissionStore(persist: false)
        drafts.setText("원문", for: key)
        let prepared = try submissions.prepareMessage(projectID: "p", targetMemberID: nil,
                                                     draft: drafts.snapshot(for: key), clearsDraft: true)
        // No beginMessage: a prepared intent never left the process, so recovery restores it locally.
        try submissions.recoverMessageDrafts(drafts: drafts)
        XCTAssertEqual(drafts.text(for: key), "원문")
        let retry = try submissions.prepareMessage(projectID: "p", targetMemberID: nil,
                                                  draft: drafts.snapshot(for: key), clearsDraft: true)
        XCTAssertEqual(retry.id, prepared.id)
        try submissions.detachMessage(id: retry.id, drafts: drafts)
        _ = try submissions.beginMessage(id: retry.id)
        drafts.setText("다음", for: key)
        try submissions.refuseMessage(id: retry.id)
        // Simulate the atomic restore reaching disk before SubmissionStore's restore receipt.
        try drafts.restoreSubmission(try XCTUnwrap(retry.handoffDraft), id: try XCTUnwrap(retry.handoffID))
        drafts.selectNamespace("b"); drafts.setText("다른 서버", for: key)
        try submissions.recoverMessageDrafts(drafts: drafts)
        XCTAssertEqual(drafts.text(for: key), "다른 서버")
        drafts.selectNamespace("a")
        XCTAssertEqual(drafts.text(for: key), "원문\n\n다음")
        try submissions.recoverMessageDrafts(drafts: drafts)
        XCTAssertEqual(drafts.text(for: key), "원문\n\n다음")
    }

    func testLegacyOverwrittenRestorationRetainsOriginalAndExplicitInsertionUsesFreshReceipt() throws {
        let drafts = DraftStore(persist: false, namespace: "fixture"), submissions = try SubmissionStore(persist: false)
        drafts.setText("원문", for: key)
        let attempt = try submissions.prepareMessage(projectID: "p", targetMemberID: nil,
            draft: drafts.snapshot(for: key), clearsDraft: true)
        try submissions.detachMessage(id: attempt.id, drafts: drafts)
        _ = try submissions.beginMessage(id: attempt.id)
        drafts.setText("새 글", for: key)
        try submissions.refuseMessage(id: attempt.id, reason: "rejected")
        // Reproduce an older app's merged receipt followed by an IME overwrite before migration.
        _ = try drafts.restoreSubmission(attempt.draft, id: try XCTUnwrap(attempt.handoffID))
        drafts.setText("새 글 바로", for: key)
        try submissions.recoverMessageDrafts(drafts: drafts)
        XCTAssertEqual(drafts.text(for: key), "새 글 바로")
        XCTAssertEqual(submissions.failureNotices(namespace: "fixture", key: key, drafts: drafts).first?.failureDisposition, .retained)
        try submissions.insertFailedMessage(id: attempt.id, drafts: drafts)
        XCTAssertEqual(drafts.text(for: key), "원문\n\n새 글 바로")
        XCTAssertTrue(submissions.failureNotices(namespace: "fixture", key: key, drafts: drafts).isEmpty)
        try submissions.recoverMessageDrafts(drafts: drafts)
        XCTAssertEqual(drafts.text(for: key), "원문\n\n새 글 바로")
    }

    private func realtimeStore(_ network: IsolatedTestNetwork, clock: CoordinatorClock,
                               sockets: CoordinatorSockets) async throws -> (AppStore, IsolatedTestWebSocket) {
        let store = AppStore(session: network.session, persistCredentials: false,
                             realtime: RealtimeClient(factory: sockets, clock: clock), clock: clock,
                             retryJitter: { $0 }, lowPowerMode: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await finish(Task { await store.connect() })
        try await waitUntil { await sockets.sockets.count == 1 }
        let createdSocket = await sockets.sockets.first
        let socket = try XCTUnwrap(createdSocket)
        try await socket.enqueue(.success(Data(#"{"type":"hello","protocol":2,"epoch":"E","seq":0,"heartbeatMs":15000,"staleAfterMs":45000}"#.utf8)))
        try await waitUntil { store.realtimeStatus == .syncing || store.realtimeStatus == .live }
        if store.realtimeStatus != .live { try await tick(clock) }
        try await waitUntil { store.realtimeStatus == .live }
        return (store, socket)
    }
    private func tick(_ clock: CoordinatorClock) async throws {
        // Wait until the coordinator actually registered its minimum-interval sleep before advancing time.
        try await waitUntil {
            let now = await clock.now()
            return await clock.deadlines.contains { $0 <= now + .seconds(1) }
        }
        await clock.advance(.seconds(1))
    }
    private func event(_ seq: Int, server: CoordinatorServer, socket: IsolatedTestWebSocket,
                       store: AppStore) async throws {
        server.change { $0.seq = seq }
        try await socket.enqueue(.success(Data("{\"type\":\"future\",\"epoch\":\"E\",\"seq\":\(seq)}".utf8)))
        try await waitUntil { store.receivedCursor?.seq == seq }
    }

    func testRefreshWaitsForItsOwnPassWhileLaterDirtyKeepsDraining() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), sockets = CoordinatorSockets(), holds = FollowupHolds()
        let network = try IsolatedTestNetwork { request in
            var reply = try server.handle(request)
            if request.url?.path == "/api/sync", let gate = holds.take() { reply.beforeDelivery = { await gate.wait() } }
            return reply
        }
        let (store, socket) = try await realtimeStore(network, clock: clock, sockets: sockets)
        defer { store.disconnect() }
        let entered = (0..<3).map { expectation(description: "pass \($0 + 1)") }
        let gates = entered.map(FollowupGate.init)
        gates.forEach(holds.append)
        await clock.advance(.seconds(1))
        var firstDone = false, secondDone = false
        let first = Task { await store.refresh(); firstDone = true }
        await fulfillment(of: [entered[0]], timeout: 3)
        let revision = store.dirtyRevision
        let second = Task { await store.refresh(); secondDone = true }
        try await waitUntil { store.dirtyRevision > revision }
        try await event(1, server: server, socket: socket, store: store)
        await gates[0].release()
        await finish(first)
        XCTAssertTrue(firstDone); XCTAssertFalse(secondDone, "A pass started before this request cannot satisfy it")
        try await tick(clock)
        await fulfillment(of: [entered[1]], timeout: 3)
        try await event(2, server: server, socket: socket, store: store)
        await gates[1].release()
        await finish(second)
        XCTAssertTrue(secondDone)
        XCTAssertEqual(store.appliedSnapshotCursor?.seq, 1)
        XCTAssertEqual(store.state?.project.name, "seq-1")
        XCTAssertTrue(store.canWrite)
        try await tick(clock)
        await fulfillment(of: [entered[2]], timeout: 3)
        try await event(3, server: server, socket: socket, store: store)
        await gates[2].release()
        try await waitUntil { store.appliedSnapshotCursor?.seq == 2 }
        try await tick(clock)
        try await waitUntil { store.appliedSnapshotCursor?.seq == 3 }
        await network.close()
    }

    func testSelectionReturnsValidatedBeforeLaterDirtyAndCancelledWaiterDoesNotStopPass() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), sockets = CoordinatorSockets(), holds = FollowupHolds()
        let network = try IsolatedTestNetwork { request in
            var reply = try server.handle(request)
            if request.url?.path == "/api/sync", let gate = holds.take() { reply.beforeDelivery = { await gate.wait() } }
            return reply
        }
        let (store, socket) = try await realtimeStore(network, clock: clock, sockets: sockets)
        defer { store.disconnect() }
        let entered = expectation(description: "selection pass"), later = expectation(description: "later pass")
        let gate = FollowupGate(entered), laterGate = FollowupGate(later)
        holds.append(gate); holds.append(laterGate)
        let selection = Task { await store.selectProject(id: "q") }
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertTrue(store.isLoading)
        try await event(1, server: server, socket: socket, store: store)
        await gate.release()
        await finish(selection)
        XCTAssertFalse(store.isLoading)
        XCTAssertEqual(store.state?.project.id, "q")
        XCTAssertTrue(store.canWrite, "The selected project generation was validated before returning")
        try await tick(clock)
        await fulfillment(of: [later], timeout: 3)
        let revision = store.dirtyRevision
        let cancelled = Task { await store.refresh() }
        try await waitUntil { store.dirtyRevision > revision }
        cancelled.cancel()
        await finish(cancelled)
        await laterGate.release()
        try await waitUntil { store.appliedSnapshotCursor?.seq == 1 }
        try await tick(clock)
        await network.close()
    }

    #if os(macOS)
    func testRestoredIMERefusalCanBeResentUnchangedOrEditedAndRestoredAgain() async throws {
        _ = NSApplication.shared
        for suffix in ["", " 고침"] {
            let original = "원문 하나 실패 시험", expected = original + suffix
            let server = WriteTestServer()
            server.change { $0.state.project.connection = ProjectConnection(ok: true) }
            let posts = FollowupMessagePosts(), holds = FollowupHolds()
            let network = try IsolatedTestNetwork { request in
                if request.httpMethod == "POST" {
                    try posts.capture(request)
                    let gate = holds.take()
                    return IsolatedTestHTTPReply(status: 409, data: Data(#"{"error":"herdr-core에 연결할 수 없습니다"}"#.utf8),
                        beforeDelivery: { if let gate { await gate.wait() } })
                }
                return try server.handle(request)
            }
            let store = await connect(network)
            defer { store.disconnect() }
            let fixture = FollowupComposerEditor(store: store, key: key)
            fixture.type(original)
            let first = await finish(try fixture.pressReturn())
            XCTAssertFalse(first)
            XCTAssertEqual(fixture.editor.string, original)
            XCTAssertEqual(store.drafts.text(for: key), original)
            let submissions = try XCTUnwrap(store.submissions)
            let previous = try XCTUnwrap(submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).first)
            if !suffix.isEmpty { fixture.type(suffix) }
            XCTAssertEqual(fixture.editor.string, expected)
            XCTAssertEqual(store.drafts.text(for: key), expected)
            let entered = expectation(description: "resend with suffix '\(suffix)'"), gate = FollowupGate(entered)
            holds.append(gate)
            let secondPost = try fixture.pressReturn()
            await fulfillment(of: [entered], timeout: 3)
            XCTAssertEqual(fixture.editor.string, "")
            XCTAssertEqual(store.drafts.text(for: key), "")
            XCTAssertEqual(submissions.messageAttempt(id: previous.id)?.failureDisposition, .dismissed)
            XCTAssertTrue(submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).isEmpty)
            XCTAssertEqual(posts.requests.map(\.text), [original, expected])
            XCTAssertEqual(Set(posts.requests.map(\.id)).count, 2)
            await gate.release()
            let second = await finish(secondPost)
            XCTAssertFalse(second)
            XCTAssertEqual(fixture.editor.string, expected)
            XCTAssertEqual(store.drafts.text(for: key), expected)
            XCTAssertEqual(fixture.editor.selectedRange(), NSRange(location: expected.utf16.count, length: 0))
            let failures = submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts)
            XCTAssertEqual(failures.count, 1)
            XCTAssertEqual(failures.first?.draft.text, expected)
            XCTAssertEqual(failures.first?.failureDisposition, .restored)
            XCTAssertTrue(failures.first?.failureText.contains("글은 입력칸에 되돌려 두었습니다") == true)
            XCTAssertEqual(posts.requests.count, 2)
            await finish(Task { await network.close() })
        }
    }

    func testRestoredIMERefusalResendsThenRetainsOriginalForInsertDismissAndRetry() async throws {
        _ = NSApplication.shared
        let original = "원문 하나 실패 시험", next = "새 글 바로 친다"
        for action in ["insert", "dismiss", "retry"] {
            let server = WriteTestServer()
            server.change { $0.state.project.connection = ProjectConnection(ok: true) }
            let posts = FollowupMessagePosts(), holds = FollowupHolds()
            let firstEntered = expectation(description: "first refusal \(action)")
            let secondEntered = expectation(description: "restored resubmission \(action)")
            let firstGate = FollowupGate(firstEntered), secondGate = FollowupGate(secondEntered)
            holds.append(firstGate); holds.append(secondGate)
            let network = try IsolatedTestNetwork { request in
                if request.httpMethod == "POST" {
                    XCTAssertEqual(request.url?.path, "/api/projects/p/messages")
                    try posts.capture(request)
                    let gate = holds.take()
                    return IsolatedTestHTTPReply(status: 409,
                        data: Data(#"{"error":"herdr-core에 연결할 수 없습니다. 연결되면 쓸 수 있습니다"}"#.utf8),
                        beforeDelivery: { if let gate { await gate.wait() } })
                }
                return try server.handle(request)
            }
            let store = await connect(network)
            defer { store.disconnect() }
            let fixture = FollowupComposerEditor(store: store, key: key)
            let editor = fixture.editor
            XCTAssertEqual(editor.string, "")
            fixture.type(original)
            XCTAssertEqual(editor.string, original)
            XCTAssertEqual(store.drafts.text(for: key), original)
            let firstPost = try fixture.pressReturn()
            await fulfillment(of: [firstEntered], timeout: 3)
            XCTAssertEqual(editor.string, "")
            XCTAssertEqual(store.drafts.text(for: key), "")
            XCTAssertEqual(editor.selectedRange(), NSRange(location: 0, length: 0))
            await firstGate.release()
            let firstAccepted = await finish(firstPost)
            XCTAssertFalse(firstAccepted)
            let submissions = try XCTUnwrap(store.submissions)
            let first = try XCTUnwrap(submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).first)
            XCTAssertEqual(first.status, .refused)
            XCTAssertEqual(first.failureDisposition, .restored)
            XCTAssertEqual(editor.string, original)
            XCTAssertEqual(store.drafts.text(for: key), original)
            XCTAssertEqual(editor.selectedRange(), NSRange(location: original.utf16.count, length: 0))
            XCTAssertTrue(first.failureText.contains("글은 입력칸에 되돌려 두었습니다"))
            XCTAssertEqual(posts.requests.count, 1)

            // The no-runner server's next snapshot can turn uiCanWrite off after the first
            // refusal. This must still be a new send, not a silently ignored Return.
            server.change { $0.state.project.connection = ProjectConnection(ok: false, reason: "backend_down") }
            await finish(Task { await store.refresh() })
            XCTAssertTrue(store.canWrite)
            XCTAssertFalse(store.uiCanWrite)
            XCTAssertNil(ComposerBar.sendBlockReason(in: store, targetMemberID: nil))
            let secondPost = try fixture.pressReturn()
            await fulfillment(of: [secondEntered], timeout: 3)
            XCTAssertEqual(editor.string, "")
            XCTAssertEqual(store.drafts.text(for: key), "")
            XCTAssertEqual(posts.requests.count, 2)
            XCTAssertEqual(posts.requests.map(\.text), [original, original])
            let firstRequest = try XCTUnwrap(posts.requests.first)
            let secondRequest = try XCTUnwrap(posts.requests.dropFirst().first)
            XCTAssertNotEqual(firstRequest.id, secondRequest.id)
            let second = try XCTUnwrap(submissions.messageAttempt(id: secondRequest.id))
            XCTAssertNotEqual(second.handoffID, first.handoffID)
            XCTAssertEqual(submissions.messageAttempt(id: first.id)?.failureDisposition, .dismissed)
            XCTAssertTrue(submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).isEmpty)

            try await Task.sleep(for: .milliseconds(150))
            fixture.mark(next)
            XCTAssertTrue(editor.hasMarkedText())
            XCTAssertEqual(editor.string, next)
            XCTAssertEqual(store.drafts.text(for: key), next)
            let marked = editor.markedRange(), revision = store.drafts.revision(for: key)
            await secondGate.release()
            let secondAccepted = await finish(secondPost)
            XCTAssertFalse(secondAccepted)
            XCTAssertEqual(editor.string, next)
            XCTAssertEqual(store.drafts.text(for: key), next)
            XCTAssertEqual(editor.markedRange(), marked)
            XCTAssertEqual(store.drafts.revision(for: key), revision)
            let failures = submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts)
            XCTAssertEqual(failures.count, 1)
            let failure = try XCTUnwrap(failures.first)
            XCTAssertEqual(failure.id, second.id)
            XCTAssertEqual(failure.failureDisposition, .retained)
            XCTAssertEqual(failure.draft.text, original)
            editor.insertText(next, replacementRange: NSRange(location: NSNotFound, length: 0))
            XCTAssertEqual(editor.string, next)
            XCTAssertEqual(store.drafts.text(for: key), next)
            XCTAssertEqual(submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).count, 1)

            switch action {
            case "insert":
                // Explicit insertion also commits an in-progress composition.
                editor.setSelectedRange(NSRange(location: 0, length: next.utf16.count))
                fixture.mark(next)
                try submissions.insertFailedMessage(id: failure.id, drafts: store.drafts)
                XCTAssertEqual(editor.string, original + "\n\n" + next)
                XCTAssertEqual(store.drafts.text(for: key), original + "\n\n" + next)
                XCTAssertFalse(editor.hasMarkedText())
                XCTAssertEqual(editor.selectedRange(), NSRange(location: editor.string.utf16.count, length: 0))
                XCTAssertTrue(submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).isEmpty)
                XCTAssertEqual(posts.requests.count, 2)
            case "dismiss":
                let selection = editor.selectedRange(), snapshot = store.drafts.snapshot(for: key)
                try submissions.dismissMessageFailure(id: failure.id)
                XCTAssertTrue(submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).isEmpty)
                XCTAssertEqual(editor.string, next)
                XCTAssertEqual(store.drafts.text(for: key), next)
                XCTAssertTrue(store.drafts.matches(snapshot))
                XCTAssertEqual(editor.selectedRange(), selection)
                XCTAssertEqual(posts.requests.count, 2)
            default:
                let entered = expectation(description: "retained original retried"), gate = FollowupGate(entered)
                holds.append(gate)
                let snapshot = store.drafts.snapshot(for: key)
                let retry = Task { await store.retryFailedMessage(id: failure.id) }
                await fulfillment(of: [entered], timeout: 3)
                XCTAssertEqual(posts.requests.count, 3)
                XCTAssertEqual(posts.requests.last?.id, failure.id)
                XCTAssertEqual(posts.requests.last?.text, original)
                XCTAssertEqual(editor.string, next)
                XCTAssertTrue(store.drafts.matches(snapshot))
                await gate.release()
                let accepted = await finish(retry)
                XCTAssertFalse(accepted)
                XCTAssertEqual(editor.string, next)
                XCTAssertEqual(store.drafts.text(for: key), next)
                XCTAssertTrue(store.drafts.matches(snapshot))
                let retained = submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts)
                XCTAssertEqual(retained.map(\.id), [failure.id])
                XCTAssertEqual(retained.first?.draft.text, original)
                XCTAssertEqual(retained.first?.failureDisposition, .retained)
                XCTAssertEqual(posts.requests.count, 3)
            }
            await finish(Task { await network.close() })
        }
    }

    func testIMERefusalWithoutKeyWindowKeepsOriginalNoticeThroughCommitAndExplicitInsertion() async throws {
        _ = NSApplication.shared
        let server = WriteTestServer()
        let entered = expectation(description: "IME refusal held"), gate = FollowupGate(entered)
        let network = try IsolatedTestNetwork { request in
            if request.httpMethod == "POST", request.url?.path == "/api/projects/p/messages" {
                return IsolatedTestHTTPReply(status: 422, data: Data(#"{"error":"rejected"}"#.utf8),
                                            beforeDelivery: { await gate.wait() })
            }
            return try server.handle(request)
        }
        let store = await connect(network)
        defer { store.disconnect() }
        let draftKey = key
        let composer = MacComposerTextView(
            text: Binding(get: { store.drafts.text(for: draftKey) }, set: { store.drafts.setText($0, for: draftKey) }),
            focused: .constant(false), placeholder: "test", intake: MacAttachmentIntake(),
            canReceive: { false }, receive: { _ in false }, submit: {},
            textRevision: { store.drafts.revision(for: draftKey) }, drafts: store.drafts, draftKey: draftKey)
        let coordinator = composer.makeCoordinator(), editor = MacComposerTextView.Editor()
        editor.delegate = coordinator
        editor.textChanged = { [weak editor] in if let editor { coordinator.publish(editor) } }
        coordinator.connect(editor)
        coordinator.synchronize(editor, text: "", revision: store.drafts.revision(for: key))
        editor.setMarkedText("원문", selectedRange: NSRange(location: 2, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.insertText("원문", replacementRange: NSRange(location: NSNotFound, length: 0))
        store.drafts.addFile(file("sent"), for: key)
        var post: Task<Bool, Never>?
        editor.submit = {
            post = Task { await store.sendMessage(text: "원문", attachmentIDs: ["sent"]) }
        }
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r",
            isARepeat: false, keyCode: 36))
        editor.keyDown(with: event) // No window, no keyWindow lookup, no draftDidDetach callback.
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertEqual(editor.string, "")
        editor.setMarkedText("새 글", selectedRange: NSRange(location: 3, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
        store.drafts.addFile(file("next"), for: key); store.drafts.addFile(file("sent"), for: key)
        let revision = store.drafts.revision(for: key), marked = editor.markedRange()
        await gate.release(); _ = await finish(try XCTUnwrap(post))
        XCTAssertTrue(editor.hasMarkedText())
        XCTAssertEqual(editor.markedRange(), marked)
        XCTAssertEqual(editor.string, "새 글")
        XCTAssertEqual(store.drafts.revision(for: key), revision)
        let submissions = try XCTUnwrap(store.submissions)
        let attempt = try XCTUnwrap(submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).first)
        XCTAssertEqual(attempt.draft.text, "원문")
        XCTAssertEqual(attempt.failureDisposition, .retained)
        editor.insertText("새 글 바로", replacementRange: NSRange(location: NSNotFound, length: 0))
        coordinator.publish(editor)
        XCTAssertEqual(store.drafts.text(for: key), "새 글 바로")
        XCTAssertEqual(submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).map(\.id), [attempt.id])
        // Insertion must also commit a composition that starts after the refusal.
        editor.setSelectedRange(NSRange(location: 0, length: editor.string.utf16.count))
        editor.setMarkedText("새 글", selectedRange: NSRange(location: 3, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
        try submissions.insertFailedMessage(id: attempt.id, drafts: store.drafts)
        XCTAssertFalse(editor.hasMarkedText())
        XCTAssertEqual(store.drafts.text(for: key), "원문\n\n새 글")
        XCTAssertEqual(editor.string, "원문\n\n새 글")
        XCTAssertEqual(editor.selectedRange(), NSRange(location: editor.string.utf16.count, length: 0))
        XCTAssertEqual(store.drafts.files(for: key).map(\.id), ["sent", "next"])
        XCTAssertTrue(submissions.failureNotices(namespace: store.writeNamespace, key: key, drafts: store.drafts).isEmpty)
        await network.close()
    }

    func testUnseenExternalRevisionCannotBeOverwrittenByIMECommit() {
        _ = NSApplication.shared
        var text = "", revision = 0
        let composer = MacComposerTextView(text: Binding(get: { text }, set: { text = $0; revision += 1 }),
            focused: .constant(false), placeholder: "test", intake: MacAttachmentIntake(),
            canReceive: { false }, receive: { _ in false }, submit: {}, textRevision: { revision })
        let coordinator = composer.makeCoordinator(), editor = MacComposerTextView.Editor()
        editor.delegate = coordinator
        editor.textChanged = { [weak editor] in if let editor { coordinator.publish(editor) } }
        coordinator.synchronize(editor, text: text, revision: revision)
        editor.setMarkedText("새 글", selectedRange: NSRange(location: 3, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
        text = "더 새로운 바깥 초안"; revision += 1
        coordinator.synchronize(editor, text: text, revision: revision)
        XCTAssertTrue(editor.hasMarkedText())
        editor.insertText("새 글 바로", replacementRange: NSRange(location: NSNotFound, length: 0))
        coordinator.publish(editor)
        XCTAssertEqual(text, "더 새로운 바깥 초안")
        XCTAssertEqual(editor.string, text)
        XCTAssertEqual(editor.selectedRange(), NSRange(location: text.utf16.count, length: 0))
    }

    func testIMECommitAndNativeClearPrecedePendingPostAndNextTyping() async throws {
        _ = NSApplication.shared
        let server = WriteTestServer()
        let entered = expectation(description: "IME submission held"), gate = FollowupGate(entered)
        let network = try IsolatedTestNetwork { request in
            var reply = try server.handle(request)
            if request.url?.path == "/api/projects/p/messages" { reply.beforeDelivery = { await gate.wait() } }
            return reply
        }
        let store = await connect(network)
        defer { store.disconnect() }
        let draftKey = key
        let composer = MacComposerTextView(
            text: Binding(get: { store.drafts.text(for: draftKey) }, set: { store.drafts.setText($0, for: draftKey) }),
            focused: .constant(false), placeholder: "test", intake: MacAttachmentIntake(),
            canReceive: { false }, receive: { _ in false }, submit: {},
            textRevision: { store.drafts.revision(for: draftKey) })
        let coordinator = composer.makeCoordinator(), editor = MacComposerTextView.Editor()
        editor.delegate = coordinator
        editor.textChanged = { [weak editor] in if let editor { coordinator.publish(editor) } }
        coordinator.synchronize(editor, text: "", revision: store.drafts.revision(for: key))
        editor.setMarkedText("한", selectedRange: NSRange(location: 1, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.commitComposition()
        let snapshot = store.drafts.snapshot(for: key)
        XCTAssertEqual(snapshot.text, "한")
        XCTAssertFalse(editor.hasMarkedText())
        let post = Task {
            await store.sendMessage(text: snapshot.text, draftDidDetach: {
                editor.clearAfterSubmission()
                XCTAssertEqual(editor.string, "")
                // A keystroke in the same turn, before any SwiftUI render, must use the new native buffer.
                editor.insertText("다음", replacementRange: NSRange(location: NSNotFound, length: 0))
            })
        }
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertEqual(editor.string, "다음")
        XCTAssertEqual(store.drafts.text(for: key), "다음")
        await gate.release()
        let accepted = await finish(post)
        XCTAssertTrue(accepted)
        XCTAssertEqual(store.drafts.text(for: key), "다음")
        XCTAssertEqual(server.read { $0.messages.values.first?.body }, "한")
        await network.close()
    }

    func testExternalDraftRestoresCaretToEndWhileOwnEchoKeepsSelection() {
        _ = NSApplication.shared
        var text = "", revision = 0
        let composer = MacComposerTextView(text: Binding(get: { text }, set: { text = $0; revision += 1 }),
            focused: .constant(false), placeholder: "test", intake: MacAttachmentIntake(),
            canReceive: { false }, receive: { _ in false }, submit: {}, textRevision: { revision })
        let coordinator = composer.makeCoordinator(), editor = MacComposerTextView.Editor()
        editor.setSelectedRange(NSRange(location: 0, length: 0))
        coordinator.synchronize(editor, text: "", revision: 0)
        text = "abc"; revision += 1
        coordinator.synchronize(editor, text: text, revision: revision)
        XCTAssertEqual(editor.selectedRange(), NSRange(location: 3, length: 0))
        editor.string = "abc한"; editor.setSelectedRange(NSRange(location: 1, length: 0))
        coordinator.publish(editor)
        coordinator.synchronize(editor, text: text, revision: revision)
        XCTAssertEqual(editor.selectedRange(), NSRange(location: 1, length: 0))
        editor.setMarkedText("ㅎ", selectedRange: NSRange(location: 1, length: 0),
                             replacementRange: NSRange(location: NSNotFound, length: 0))
        let marked = editor.markedRange()
        coordinator.synchronize(editor, text: "외부", revision: revision + 1)
        XCTAssertEqual(editor.markedRange(), marked)
    }
    #elseif os(iOS)
    func testIOSUnseenExternalRevisionCannotBeOverwrittenByIMECommit() {
        var text = "", revision = 0
        let composer = IOSComposerTextView(text: Binding(get: { text }, set: { text = $0; revision += 1 }),
            focused: .constant(false), placeholder: "test", textRevision: { revision })
        let coordinator = composer.makeCoordinator(), editor = IOSComposerTextView.Editor()
        editor.delegate = coordinator
        editor.textChanged = { [weak editor] in if let editor { coordinator.textViewDidChange(editor) } }
        coordinator.synchronize(editor, text: text, revision: revision)
        editor.setMarkedText("새 글", selectedRange: NSRange(location: 3, length: 0))
        XCTAssertNotNil(editor.markedTextRange)
        text = "더 새로운 바깥 초안"; revision += 1
        coordinator.synchronize(editor, text: text, revision: revision)
        editor.insertText("새 글 바로")
        coordinator.textViewDidChange(editor)
        XCTAssertEqual(text, "더 새로운 바깥 초안")
        XCTAssertEqual(editor.text, text)
        XCTAssertEqual(editor.selectedRange, NSRange(location: text.utf16.count, length: 0))
    }

    func testIOSMarkedFailureInsertionCommitsMergesAndMovesCaretToEnd() throws {
        let drafts = DraftStore(persist: false, namespace: "fixture"), submissions = try SubmissionStore(persist: false)
        let draftKey = key
        let composer = IOSComposerTextView(
            text: Binding(get: { drafts.text(for: draftKey) }, set: { drafts.setText($0, for: draftKey) }),
            focused: .constant(false), placeholder: "test", textRevision: { drafts.revision(for: draftKey) },
            drafts: drafts, draftKey: draftKey)
        let coordinator = composer.makeCoordinator(), editor = IOSComposerTextView.Editor()
        editor.delegate = coordinator
        editor.textChanged = { [weak editor] in if let editor { coordinator.textViewDidChange(editor) } }
        coordinator.connect(editor)
        drafts.setText("원문", for: key)
        coordinator.synchronize(editor, text: "원문", revision: drafts.revision(for: key))
        let attempt = try submissions.prepareMessage(projectID: "p", targetMemberID: nil,
            draft: drafts.snapshot(for: key), clearsDraft: true)
        try submissions.detachMessage(id: attempt.id, drafts: drafts)
        _ = try submissions.beginMessage(id: attempt.id)
        editor.setMarkedText("새 글", selectedRange: NSRange(location: 3, length: 0))
        try submissions.refuseMessage(id: attempt.id, reason: "rejected")
        try submissions.restoreMessage(id: attempt.id, drafts: drafts)
        XCTAssertNotNil(editor.markedTextRange)
        XCTAssertEqual(editor.text, "새 글")
        XCTAssertEqual(submissions.failureNotices(namespace: "fixture", key: key, drafts: drafts).first?.draft.text, "원문")
        try submissions.insertFailedMessage(id: attempt.id, drafts: drafts)
        XCTAssertNil(editor.markedTextRange)
        XCTAssertEqual(editor.text, "원문\n\n새 글")
        XCTAssertEqual(drafts.text(for: key), editor.text)
        XCTAssertEqual(editor.selectedRange, NSRange(location: editor.text.utf16.count, length: 0))
        XCTAssertTrue(submissions.failureNotices(namespace: "fixture", key: key, drafts: drafts).isEmpty)
    }

    func testIOSExternalDraftRestoresCaretToEndWhileOwnEchoKeepsSelection() {
        var text = "", revision = 0
        let composer = IOSComposerTextView(text: Binding(get: { text }, set: { text = $0; revision += 1 }),
            focused: .constant(false), placeholder: "test", textRevision: { revision })
        let coordinator = composer.makeCoordinator(), editor = UITextView()
        coordinator.synchronize(editor, text: "", revision: 0)
        text = "abc"; revision += 1
        coordinator.synchronize(editor, text: text, revision: revision)
        XCTAssertEqual(editor.selectedRange, NSRange(location: 3, length: 0))
        editor.text = "abc한"; editor.selectedRange = NSRange(location: 1, length: 0)
        coordinator.textViewDidChange(editor)
        coordinator.synchronize(editor, text: text, revision: revision)
        XCTAssertEqual(editor.selectedRange, NSRange(location: 1, length: 0))
    }
    #endif
}
