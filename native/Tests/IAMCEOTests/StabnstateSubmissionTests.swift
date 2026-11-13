import Foundation
import XCTest
@testable import IAMCEO

@MainActor final class StabnstateSubmissionTests: XCTestCase {
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("stab-n-state-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    /// Every durable write replaces the file atomically, so an unchanged identity proves nothing was saved.
    private func identity(_ url: URL) throws -> [String] {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return ["\(attributes[.systemFileNumber] ?? "")", "\(attributes[.modificationDate] ?? "")"]
    }
    // 공용 pollUntil(TestSupport)을 부르는 얇은 껍데기. 기한은 느린 CI 러너에 맞춘 공용 기본값(10초)을 쓴다.
    private func eventually(_ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        await pollUntil("State did not settle", file: file, line: line, condition)
    }
    /// A message the server accepted and whose draft was already cleared: nothing is left to do for it.
    @discardableResult
    private func finished(_ submissions: SubmissionStore, _ drafts: DraftStore, key: String, order: Int) throws -> Message {
        drafts.setText("글 \(order)", for: key)
        let attempt = try submissions.prepareMessage(projectID: "p", targetMemberID: nil, draft: drafts.snapshot(for: key), clearsDraft: true)
        try submissions.detachMessage(id: attempt.id, drafts: drafts)
        _ = try submissions.beginMessage(id: attempt.id)
        let message = Message(id: attempt.id, projectId: "p", at: String(format: "2026-11-10T00:%02d:%02d.000Z", order / 60, order % 60),
                              mine: true, body: "글 \(order)")
        try submissions.acceptMessage(id: attempt.id, message: message)
        try submissions.consumeAccepted(id: attempt.id, drafts: drafts)
        return message
    }

    func testFinishedSendRecordsAreNotSavedAgainOnEverySnapshot() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let namespace = DraftStore.endpointNamespace(network.endpoint)
        let drafts = DraftStore(persist: false, namespace: namespace)
        let url = root.appendingPathComponent("submissions")
        let submissions = try SubmissionStore(storageURL: url)
        let key = DraftStore.key(project: "p", target: nil)
        var sent: [Message] = []
        for order in 0..<30 { sent.append(try finished(submissions, drafts, key: key, order: order)) }
        server.change { server in
            for message in sent { server.messages[message.id] = message }
            server.state.messages = Array(sent.suffix(5))
        }
        let store = AppStore(session: network.session, persistCredentials: false, drafts: drafts, submissions: submissions)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        defer { store.disconnect() }
        await store.connect()
        XCTAssertTrue(store.canWrite)
        XCTAssertEqual(store.messages.count, 5)
        let saved = try identity(url)
        for _ in 0..<3 { await store.refresh() }
        await store.recoverWrites()
        XCTAssertEqual(try identity(url), saved, "A snapshot must not rewrite records that have nothing left to do")
        XCTAssertEqual(submissions.messages(namespace: namespace).count, 30)
        XCTAssertFalse(network.requests.contains { $0.url?.path.hasPrefix("/api/messages/") == true })

        // Receiving the same accepted message again is a no-op; a newer delivery state is still saved.
        var delivered = sent[29]
        try submissions.acceptMessage(id: delivered.id, message: delivered)
        XCTAssertEqual(try identity(url), saved)
        delivered.delivery = "delivered"; delivered.deliveryRevision = 2
        try submissions.acceptMessage(id: delivered.id, message: delivered)
        XCTAssertNotEqual(try identity(url), saved)
        XCTAssertEqual(submissions.messageAttempt(id: delivered.id)?.message?.delivery, "delivered")
    }

    func testPruneKeepsRecentFinishedAndEveryUnresolvedRecordAndDropsOnlyTheirHandoffs() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let draftsURL = root.appendingPathComponent("drafts")
        let drafts = DraftStore(namespace: "fixture", storageURL: draftsURL)
        let submissions = try SubmissionStore(storageURL: root.appendingPathComponent("submissions"))
        let key = DraftStore.key(project: "p", target: nil)
        var sent: [Message] = []
        for order in 0..<60 { sent.append(try finished(submissions, drafts, key: key, order: order)) }

        // A dismissed failure has no timestamp and nothing left to do: it goes first.
        let dismissedKey = DraftStore.key(project: "p", target: "dismissed")
        drafts.setText("닫은 실패", for: dismissedKey)
        let dismissed = try submissions.prepareMessage(projectID: "p", targetMemberID: "dismissed", draft: drafts.snapshot(for: dismissedKey), clearsDraft: true)
        try submissions.detachMessage(id: dismissed.id, drafts: drafts)
        _ = try submissions.beginMessage(id: dismissed.id)
        try submissions.refuseMessage(id: dismissed.id, reason: "rejected")
        try submissions.dismissMessageFailure(id: dismissed.id)

        // An unanswered send and a failure the owner has not dealt with must survive any pruning.
        let checkingKey = DraftStore.key(project: "p", target: "checking")
        drafts.setText("확인 중", for: checkingKey)
        let checking = try submissions.prepareMessage(projectID: "p", targetMemberID: "checking", draft: drafts.snapshot(for: checkingKey), clearsDraft: true)
        try submissions.detachMessage(id: checking.id, drafts: drafts)
        _ = try submissions.beginMessage(id: checking.id)
        let refusedKey = DraftStore.key(project: "p", target: "refused")
        drafts.setText("보내지 못한 글", for: refusedKey)
        let refused = try submissions.prepareMessage(projectID: "p", targetMemberID: "refused", draft: drafts.snapshot(for: refusedKey), clearsDraft: true)
        try submissions.detachMessage(id: refused.id, drafts: drafts)
        _ = try submissions.beginMessage(id: refused.id)
        try submissions.refuseMessage(id: refused.id, reason: "rejected")

        func handoffs() throws -> Int {
            let saved = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: draftsURL)) as? [String: [String: Any]])
            return (saved["fixture"]?["handoffs"] as? [String: Any])?.count ?? 0
        }
        XCTAssertEqual(try handoffs(), 63)
        XCTAssertTrue(try submissions.pruneMessageHistory(keeping: 100).isEmpty, "Under the limit nothing is removed or saved")
        let removed = try submissions.pruneMessageHistory(keeping: 50)
        drafts.pruneHandoffs(removed)
        let kept = submissions.messages(namespace: "fixture")
        XCTAssertEqual(kept.count, 52)
        XCTAssertNil(submissions.messageAttempt(id: dismissed.id))
        for message in sent.prefix(10) { XCTAssertNil(submissions.messageAttempt(id: message.id)) }
        for message in sent.suffix(50) { XCTAssertEqual(submissions.messageAttempt(id: message.id)?.status, .accepted) }
        XCTAssertEqual(submissions.messageAttempt(id: checking.id)?.status, .checking)
        XCTAssertEqual(submissions.messageAttempt(id: refused.id)?.status, .refused)
        XCTAssertEqual(try handoffs(), 52, "Only the handoffs of removed records are dropped")
        XCTAssertTrue(try submissions.pruneMessageHistory(keeping: 50).isEmpty)

        // The surviving unresolved records recover exactly as before.
        let restoredDrafts = DraftStore(namespace: "fixture", storageURL: draftsURL)
        let restored = try SubmissionStore(storageURL: root.appendingPathComponent("submissions"))
        try restored.recoverMessageDrafts(drafts: restoredDrafts)
        XCTAssertEqual(restored.messageAttempt(id: checking.id)?.status, .checking)
        XCTAssertEqual(restoredDrafts.text(for: checkingKey), "")
        XCTAssertEqual(restoredDrafts.text(for: refusedKey), "보내지 못한 글")
        XCTAssertEqual(restored.messageAttempt(id: refused.id)?.failureDisposition, .restored)
        XCTAssertEqual(restoredDrafts.text(for: key), "")
    }

    func testConnectingPrunesOldFinishedRecordsOnce() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let namespace = DraftStore.endpointNamespace(network.endpoint)
        let drafts = DraftStore(persist: false, namespace: namespace)
        let url = root.appendingPathComponent("submissions")
        let submissions = try SubmissionStore(storageURL: url)
        let key = DraftStore.key(project: "p", target: nil)
        var sent: [Message] = []
        for order in 0..<70 { sent.append(try finished(submissions, drafts, key: key, order: order)) }
        let store = AppStore(session: network.session, persistCredentials: false, drafts: drafts, submissions: submissions)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        defer { store.disconnect() }
        await store.connect()
        XCTAssertEqual(submissions.messages(namespace: namespace).count, 50)
        XCTAssertNil(submissions.messageAttempt(id: sent[19].id))
        XCTAssertNotNil(submissions.messageAttempt(id: sent[20].id))
        let saved = try identity(url)
        await store.refresh()
        XCTAssertEqual(try identity(url), saved)
        // Sending still works with the bounded history.
        let accepted = await store.sendMessage(text: "새 글")
        XCTAssertTrue(accepted)
        XCTAssertEqual(server.read { $0.sentIDs.count }, 1)
    }
}
