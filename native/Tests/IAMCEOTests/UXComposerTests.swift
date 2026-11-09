import Foundation
import XCTest
#if os(macOS)
import AppKit
#endif
@testable import IAMCEO

private actor UXComposerUploadGate {
    private var resume: TestDeadlineContinuation<Void, Never>?
    private var released = false
    func wait() async {
        guard !released else { return }
        await withTestDeadline(fallback: ()) { resume = $0 }
    }
    func release() { released = true; resume?.resume(); resume = nil }
}

private final class UXComposerProgress: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Double] = []
    func append(_ value: Double) { lock.withLock { values.append(value) } }
    var recorded: [Double] { lock.withLock { values } }
}

private final class UXComposerFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var offline = false
    private var failures = 0
    private var uploads = 0
    let gate: UXComposerUploadGate?
    init(gate: UXComposerUploadGate? = nil) { self.gate = gate }
    func setOffline(_ value: Bool) { lock.withLock { offline = value } }
    func failNextUpload() { lock.withLock { failures += 1 } }
    func reply(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        try lock.withLock {
            if offline { throw URLError(.notConnectedToInternet) }
            let json: String
            switch request.url?.path {
            case "/api/bootstrap": json = #"{"projects":[{"id":"p"}],"settings":{}}"#
            case "/api/runtime": json = "{}"
            case "/api/projects/p/state":
                json = #"{"project":{"id":"p","connection":{"ok":true}},"members":[{"id":"worker","projectId":"p","kind":"worker","name":"직원"}],"messages":[]}"#
            case "/api/uploads":
                uploads += 1
                if failures > 0 { failures -= 1; return IsolatedTestHTTPReply(status: 503) }
                json = "{\"id\":\"file-\(uploads)\",\"url\":\"/uploads/file\"}"
            default: return IsolatedTestHTTPReply(status: 404)
            }
            var reply = IsolatedTestHTTPReply(data: Data(json.utf8))
            if request.url?.path == "/api/uploads", let gate { reply.beforeDelivery = { await gate.wait() } }
            return reply
        }
    }
}

@MainActor final class UXComposerTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.composerUploads.sessionConfiguration = network.session.configuration
        store.endpoint = network.endpoint.url.absoluteString
        store.accessCode = "fixture-only"
        await store.connect()
        store.setForeground(false)
        XCTAssertTrue(store.uiCanWrite)
        return store
    }

    private func context(_ store: AppStore, target: String? = nil) -> ComposerUploadContext {
        ComposerUploadContext(projectID: "p", targetMemberID: target,
                              token: store.drafts.uploadToken(for: DraftStore.key(project: "p", target: target)))
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition())
    }

    func testOfflineDraftAndAttachmentResumeWithoutSendingMessage() async throws {
        let fixture = UXComposerFixture()
        let network = try IsolatedTestNetwork(handler: fixture.reply)
        let store = await connect(network)
        defer { store.disconnect() }
        fixture.setOffline(true)
        await store.refresh()
        XCTAssertFalse(store.uiCanWrite)
        XCTAssertNotNil(store.writeBlockedReason)
        XCTAssertNil(ComposerAttachmentUploads.blockedReason(in: store, target: nil))
        let captured = context(store)
        store.drafts.setText("끊김 중 쓴 글", for: captured.token.key)
        let source = try PhotoAttachmentFile.write(Data("offline attachment".utf8), filename: "offline.txt")
        defer { source.cleanup() }
        let task = store.composerUploads.upload([source.url], context: captured, store: store)
        try await waitUntil { store.composerUploads.pending.first?.waiting == true }
        XCTAssertFalse(network.requests.contains { $0.url?.path == "/api/uploads" })
        XCTAssertTrue(store.drafts.uploadFailures(for: captured.token.key).isEmpty)
        fixture.setOffline(false)
        await store.refresh()
        await task.value
        XCTAssertEqual(store.drafts.files(for: captured.token.key).count, 1)
        XCTAssertEqual(store.drafts.text(for: captured.token.key), "끊김 중 쓴 글")
        XCTAssertTrue(store.submissions?.messages(namespace: captured.token.namespace).isEmpty == true)
        XCTAssertFalse(network.requests.contains { $0.url?.path == "/api/messages" && $0.httpMethod == "POST" })
        await network.close()
    }

    func testPreUploadRejectionsNeverBecomePersistentFailures() async throws {
        let network = try IsolatedTestNetwork(handler: UXComposerFixture().reply)
        let store = await connect(network)
        defer { store.disconnect() }
        let captured = context(store)
        store.drafts.setText("글만 보낼 수 있음", for: captured.token.key)
        store.composerUploads.reportRejection("설정에서 카메라 접근을 허용해 주세요")
        await store.composerUploads.loadMedia(names: ["취소", "사진 거절"], context: captured, store: store) { _ in
            throw CocoaError(.userCancelled)
        }.value
        XCTAssertNotNil(store.composerUploads.notice)
        XCTAssertTrue(store.drafts.uploadFailures(for: captured.token.key).isEmpty)
        XCTAssertTrue(store.composerUploads.pending.isEmpty)
        XCTAssertEqual(store.drafts.text(for: captured.token.key), "글만 보낼 수 있음")
        XCTAssertFalse(network.requests.contains { $0.url?.path == "/api/uploads" })
        await network.close()
    }

    func testFailedUploadRetriesRetainedBytesAndOriginalTarget() async throws {
        let fixture = UXComposerFixture()
        fixture.failNextUpload()
        let network = try IsolatedTestNetwork(handler: fixture.reply)
        let store = await connect(network)
        defer { store.disconnect() }
        let captured = context(store, target: "worker")
        let source = try PhotoAttachmentFile.write(Data("retained bytes".utf8), filename: "retry.txt")
        defer { source.cleanup() }
        await store.composerUploads.upload([source.url], context: captured, store: store).value
        let failure = try XCTUnwrap(store.drafts.uploadFailures(for: captured.token.key).first)
        XCTAssertFalse(failure.detail.contains("503"))
        XCTAssertTrue(store.composerUploads.canRetry(failure.id, store: store))
        source.cleanup()
        let retry = try XCTUnwrap(store.composerUploads.retry(failure.id, store: store))
        await retry.value
        XCTAssertTrue(store.drafts.uploadFailures(for: captured.token.key).isEmpty)
        XCTAssertEqual(store.drafts.files(for: captured.token.key).count, 1)
        XCTAssertTrue(store.drafts.files(for: DraftStore.key(project: "p", target: nil)).isEmpty)
        let uploads = network.requests.filter { $0.url?.path == "/api/uploads" }
        XCTAssertEqual(uploads.count, 2)
        XCTAssertTrue(uploads.allSatisfy { URLComponents(url: $0.url!, resolvingAgainstBaseURL: false)?.queryItems?.contains(URLQueryItem(name: "target", value: "worker")) == true })
        await network.close()
    }

    func testCancelOneQueuedItemKeepsOtherItemAndDoesNotLeaveFailure() async throws {
        let fixture = UXComposerFixture()
        let network = try IsolatedTestNetwork(handler: fixture.reply)
        let store = await connect(network)
        defer { store.disconnect() }
        fixture.setOffline(true)
        await store.refresh()
        let captured = context(store)
        let sources = try ["one.txt", "two.txt"].map { try PhotoAttachmentFile.write(Data($0.utf8), filename: $0) }
        defer { sources.forEach { $0.cleanup() } }
        let task = store.composerUploads.upload(sources.map(\.url), context: captured, store: store)
        try await waitUntil { store.composerUploads.pending.first?.waiting == true }
        let cancelled = try XCTUnwrap(store.composerUploads.pending.first)
        store.composerUploads.cancel(cancelled.id, drafts: store.drafts)
        try await waitUntil { store.composerUploads.pending.count == 1 && store.composerUploads.pending.first?.waiting == true }
        fixture.setOffline(false)
        await store.refresh()
        await task.value
        XCTAssertTrue(store.drafts.uploadFailures(for: captured.token.key).isEmpty)
        XCTAssertEqual(store.drafts.files(for: captured.token.key).count, 1)
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/api/uploads" }.count, 1)
        await network.close()
    }

    func testCancelUploadAfterHTTPStartNeverCommitsOrCreatesFailure() async throws {
        let gate = UXComposerUploadGate()
        let heldFixture = UXComposerFixture(gate: gate)
        let network = try IsolatedTestNetwork(handler: heldFixture.reply)
        let store = await connect(network)
        defer { store.disconnect() }
        let captured = context(store)
        let source = try PhotoAttachmentFile.write(Data("in-flight bytes".utf8), filename: "cancel.txt")
        defer { source.cleanup() }
        let task = store.composerUploads.upload([source.url], context: captured, store: store)
        try await waitUntil { network.requests.contains { $0.url?.path == "/api/uploads" } }
        let item = try XCTUnwrap(store.composerUploads.pending.first)
        XCTAssertNotNil(item.progress)
        store.composerUploads.cancel(item.id, drafts: store.drafts)
        await gate.release()
        await task.value
        XCTAssertTrue(store.composerUploads.pending.isEmpty)
        XCTAssertTrue(store.drafts.files(for: captured.token.key).isEmpty)
        XCTAssertTrue(store.drafts.uploadFailures(for: captured.token.key).isEmpty)
        await network.close()
    }

    func testForegroundRevalidationHasReasonAndKeepsLocalIntakeAvailable() async throws {
        let network = try IsolatedTestNetwork(handler: UXComposerFixture().reply)
        let store = await connect(network)
        defer { store.disconnect() }
        store.setForeground(true)
        XCTAssertFalse(store.uiCanWrite)
        XCTAssertTrue(store.isRevalidating)
        XCTAssertNotNil(store.writeBlockedReason)
        XCTAssertNil(ComposerAttachmentUploads.blockedReason(in: store, target: nil))
        store.setForeground(false)
        await network.close()
    }

    func testUploadDelegateReportsSentByteFractionAndIgnoresUnknownLength() throws {
        let progress = UXComposerProgress()
        let delegate = ComposerUploadTransport(progress: progress.append)
        let network = try IsolatedTestNetwork()
        let task = network.session.uploadTask(with: URLRequest(url: network.endpoint.url), from: Data())
        defer { task.cancel(); network.session.invalidateAndCancel() }
        delegate.urlSession(network.session, task: task, didSendBodyData: 25, totalBytesSent: 25, totalBytesExpectedToSend: 100)
        delegate.urlSession(network.session, task: task, didSendBodyData: 75, totalBytesSent: 100, totalBytesExpectedToSend: 100)
        delegate.urlSession(network.session, task: task, didSendBodyData: 1, totalBytesSent: 101, totalBytesExpectedToSend: -1)
        XCTAssertEqual(progress.recorded, [0.25, 1])
        XCTAssertTrue(network.requests.isEmpty)
    }

    func testDismissingOneFailurePreservesOtherFilesAndOtherDrafts() {
        let drafts = DraftStore(persist: false, namespace: "fixture")
        let one = drafts.uploadToken(for: "one"), two = drafts.uploadToken(for: "two")
        let id = UUID(), other = UUID(), anotherDraft = UUID()
        drafts.failUpload(name: "same.txt", token: one, id: id, detail: "실패")
        drafts.failUpload(name: "same.txt", token: one, id: other, detail: "실패")
        drafts.failUpload(name: "same.txt", token: two, id: anotherDraft, detail: "실패")
        drafts.dismissUploadFailure(id)
        XCTAssertEqual(drafts.uploadFailures(for: "one").map(\.id), [other])
        XCTAssertEqual(drafts.uploadFailures(for: "two").map(\.id), [anotherDraft])
    }

    func testOpenAcceptedMessageAlwaysUsesCapturedRecipientAndMessage() {
        let router = Router(destination: .team)
        router.chatTarget = "another-worker"
        router.chatMessageID = "old-message"
        router.memberID = "another-worker"
        let accepted = ComposerAcceptedMessage(namespace: "fixture", projectID: "p", targetMemberID: "worker", messageID: "sent-message")
        accepted.open(in: router)
        XCTAssertEqual(router.destination, .chat)
        XCTAssertEqual(router.chatTarget, "worker")
        XCTAssertEqual(router.chatMessageID, "sent-message")
        XCTAssertNil(router.memberID)
        ComposerAcceptedMessage(namespace: "fixture", projectID: "p", targetMemberID: nil, messageID: "lead-message").open(in: router)
        XCTAssertNil(router.chatTarget)
        XCTAssertEqual(router.chatMessageID, "lead-message")
    }

    func testMultipartEscapesHeadersAndKeepsCredentialsInAuthorizedHeader() async throws {
        let network = try IsolatedTestNetwork()
        let (request, body) = try await ComposerAttachmentUploads.request(api: network.makeAPIClient(), data: Data("bytes".utf8),
            filename: "bad\"\r\n.txt", mime: "image/png\r\ninjected: yes", projectID: "p?x=1", target: "m&other=1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
        XCTAssertEqual(request.url?.scheme, "http")
        XCTAssertFalse(request.url!.absoluteString.contains("fixture-only"))
        XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems,
                       [URLQueryItem(name: "project", value: "p?x=1"), URLQueryItem(name: "target", value: "m&other=1")])
        let encoded = String(decoding: body, as: UTF8.self)
        XCTAssertTrue(encoded.contains("Content-Type: application/octet-stream\r\n"))
        XCTAssertFalse(encoded.contains("injected:"))
        XCTAssertTrue(encoded.contains("filename=\"bad___.txt\""))
        XCTAssertTrue(network.requests.isEmpty)
        await network.close()
    }

    #if os(macOS)
    func testMacOfflineIntakeDoesNotRequireWriteReadiness() {
        XCTAssertTrue(MacAttachmentPolicy(archived: false, demo: false, connected: false, writable: false, missingTarget: false).canAccept)
        XCTAssertTrue(MacAttachmentPolicy(archived: false, demo: false, connected: true, writable: false, missingTarget: false).canAccept)
        XCTAssertFalse(MacAttachmentPolicy(archived: true, demo: false, connected: false, writable: false, missingTarget: false).canAccept)
    }

    func testMacReturnSendsShiftReturnAddsLineAndMarkedReturnOnlyCommitsIME() throws {
        let editor = MacComposerTextView.Editor()
        var sends = 0
        editor.submit = { sends += 1 }
        func key(_ flags: NSEvent.ModifierFlags = []) throws -> NSEvent {
            try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
                timestamp: 0, windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        }
        editor.keyDown(with: try key())
        XCTAssertEqual(sends, 1)
        editor.string = "첫 줄"
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
        editor.keyDown(with: try key(.shift))
        XCTAssertTrue(editor.string.contains("\n"))
        XCTAssertEqual(sends, 1)
        editor.setMarkedText("한", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(editor.hasMarkedText())
        editor.keyDown(with: try key())
        XCTAssertEqual(sends, 1)
    }
    #endif

    func testIPhonePasteAcceptsPixelDataWithoutAFileRepresentation() async throws {
        let data = try XCTUnwrap(Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ3cAAAAASUVORK5CYII="))
        let provider = NSItemProvider()
        provider.registerDataRepresentation(forTypeIdentifier: "public.png", visibility: .all) { completion in
            completion(data, nil)
            return nil
        }
        let copy = try await ComposerPasteIntake.copy(provider)
        defer { copy.cleanup() }
        XCTAssertEqual(try Data(contentsOf: copy.url), data)
        XCTAssertTrue(provider.hasItemConformingToTypeIdentifier("public.image"))
    }

    func testIPhonePasteCopiesFileAndRefusesInternetURL() async throws {
        let source = try PhotoAttachmentFile.write(Data("paste".utf8), filename: "paste.txt")
        defer { source.cleanup() }
        let provider = NSItemProvider(item: source.url as NSURL, typeIdentifier: "public.file-url")
        let copied = try await ComposerPasteIntake.copy(provider)
        defer { copied.cleanup() }
        XCTAssertEqual(try Data(contentsOf: copied.url), Data("paste".utf8))
        XCTAssertNotEqual(copied.url, source.url)
        let remote = NSItemProvider(item: URL(string: "https://fixture.invalid/file")! as NSURL, typeIdentifier: "public.file-url")
        do { _ = try await ComposerPasteIntake.copy(remote); XCTFail("Remote URL accepted") } catch {}
    }
}
