import Foundation
import XCTest
@testable import IAMCEO

final class DraftPersistenceTests: XCTestCase {
    private func temporaryDirectory() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("iamceo-w3n-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func file(_ id: String) -> Attachment { Attachment(id: id, name: "\(id).txt", url: "/uploads/\(id)") }

    @MainActor func testHostsAttachmentsMemosAndRevisionsSurviveRestart() throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("drafts.json")
        let drafts = DraftStore(namespace: "host-a", storageURL: url)
        let key = DraftStore.key(project: "hq", target: nil)
        drafts.setText("A", for: key); drafts.addFile(file("a"), for: key); drafts.setMemo("memo A", for: "d")
        let revision = drafts.revision(for: key)
        drafts.selectNamespace("host-b")
        XCTAssertEqual(drafts.pendingCount, 0)
        drafts.addFile(file("b"), for: key); drafts.setMemo("", for: "d")
        XCTAssertEqual(drafts.pendingCount, 1)
        let restored = DraftStore(namespace: "host-a", storageURL: url)
        XCTAssertNil(restored.persistenceError)
        XCTAssertEqual(restored.text(for: key), "A")
        XCTAssertEqual(restored.files(for: key).map(\.id), ["a"])
        XCTAssertEqual(restored.revision(for: key), revision)
        XCTAssertEqual(restored.memo(for: "d"), "memo A")
        restored.selectNamespace("host-b")
        XCTAssertEqual(restored.files(for: key).map(\.id), ["b"])
        XCTAssertEqual(restored.memo(for: "d"), "")
        restored.removeAll(); restored.selectNamespace("host-a")
        XCTAssertEqual(restored.text(for: key), "A")
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    @MainActor func testRevisionConsumptionPreservesEditUndoAndReattachedFiles() {
        let drafts = DraftStore(persist: false, namespace: "a")
        drafts.setText("first", for: "key"); drafts.addFile(file("one"), for: "key")
        let sent = drafts.snapshot(for: "key")
        drafts.setText("changed", for: "key"); drafts.setText("first", for: "key")
        drafts.removeFile("one", for: "key"); drafts.addFile(file("one"), for: "key")
        drafts.addFile(file("two"), for: "key")
        drafts.consumeSent(sent)
        XCTAssertEqual(drafts.text(for: "key"), "first")
        XCTAssertEqual(drafts.files(for: "key").map(\.id), ["one", "two"])
        let unchanged = drafts.snapshot(for: "key")
        drafts.addFile(file("three"), for: "key")
        drafts.consumeSent(unchanged)
        XCTAssertEqual(drafts.text(for: "key"), "")
        XCTAssertEqual(drafts.files(for: "key").map(\.id), ["three"])
    }

    @MainActor func testUploadTokensRejectClearLogoutAndABAWithoutRejectingTyping() {
        let drafts = DraftStore(persist: false, namespace: "a")
        let token = drafts.uploadToken(for: "key")
        drafts.setText("typed while uploading", for: "key")
        XCTAssertTrue(drafts.completeUpload(file("one"), token: token))
        let cleared = drafts.uploadToken(for: "key")
        drafts.clear("key")
        XCTAssertFalse(drafts.completeUpload(file("two"), token: cleared))
        let switched = drafts.uploadToken(for: "key")
        drafts.selectNamespace("b"); drafts.selectNamespace("a")
        XCTAssertFalse(drafts.completeUpload(file("three"), token: switched))
        let loggedOut = drafts.uploadToken(for: "key")
        drafts.removeAll()
        XCTAssertFalse(drafts.completeUpload(file("four"), token: loggedOut))
        XCTAssertEqual(drafts.pendingCount, 0)
    }

    @MainActor func testAcceptedSnapshotConsumesOnlyOriginalHostAndDeletionGeneration() {
        let drafts = DraftStore(persist: false, namespace: "a")
        drafts.setText("A", for: "key")
        let a = drafts.snapshot(for: "key")
        drafts.selectNamespace("b"); drafts.setText("B", for: "key")
        drafts.consumeSent(a)
        XCTAssertEqual(drafts.text(for: "key"), "B")
        drafts.selectNamespace("a")
        XCTAssertEqual(drafts.text(for: "key"), "")
        drafts.setText("same", for: "key"); let deleted = drafts.snapshot(for: "key")
        drafts.clear("key"); drafts.setText("same", for: "key")
        drafts.consumeSent(deleted)
        XCTAssertEqual(drafts.text(for: "key"), "same")
    }

    @MainActor func testKeysAndVerifiedEndpointNamespaces() throws {
        XCTAssertNotEqual(DraftStore.key(project: "a:b", target: "c"), DraftStore.key(project: "a", target: "b:c"))
        XCTAssertNotEqual(DraftStore.key(project: nil, target: nil), DraftStore.key(project: "none", target: "chief"))
        XCTAssertEqual(DraftStore.endpointNamespace(try ServerEndpoint("HTTPS://host.example:443/")), "https://host.example")
        XCTAssertNotEqual(DraftStore.endpointNamespace(try ServerEndpoint("https://a.example")), DraftStore.endpointNamespace(try ServerEndpoint("https://b.example")))
    }

    @MainActor func testCorruptPersistenceFailsClosedAndNeverOverwritesSavedBytes() throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("state.json")
        let data = Data("not JSON".utf8); try data.write(to: url)
        let drafts = DraftStore(namespace: "a", storageURL: url)
        XCTAssertNotNil(drafts.persistenceError)
        drafts.setText("edit", for: "key")
        XCTAssertEqual(try Data(contentsOf: url), data)
        XCTAssertThrowsError(try SubmissionStore(storageURL: url))
        let badURL = directory.appendingPathComponent("missing/attempts.json")
        let submissions = try SubmissionStore(storageURL: badURL)
        XCTAssertThrowsError(try submissions.prepareMessage(projectID: "p", targetMemberID: nil, draft: DraftStore(persist: false).snapshot(for: "k")))
        XCTAssertTrue(submissions.messages(namespace: "unassigned").isEmpty)
    }

    @MainActor func testFirstAttemptRecoveryQueriesIDAndPreservesLaterDraft() async throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let draftURL = directory.appendingPathComponent("draft.json")
        let attemptURL = directory.appendingPathComponent("attempt.json")
        let drafts = DraftStore(namespace: "host-a", storageURL: draftURL)
        drafts.setText("original", for: "key"); drafts.addFile(file("one"), for: "key")
        let store = try SubmissionStore(storageURL: attemptURL)
        let attempt = try store.prepareMessage(projectID: "p", targetMemberID: "worker", draft: drafts.snapshot(for: "key"))
        let request = try store.beginMessage(id: attempt.id)
        XCTAssertEqual(request.id, attempt.id)
        XCTAssertEqual(request.attachmentIds, ["one"])
        drafts.setText("later edit", for: "key"); drafts.addFile(file("two"), for: "key")
        let restored = try SubmissionStore(storageURL: attemptURL)
        XCTAssertEqual(restored.messageAttempt(id: attempt.id)?.status, .checking)
        XCTAssertThrowsError(try restored.prepareMessage(projectID: "p", targetMemberID: "worker", draft: drafts.snapshot(for: "key")))
        let serverMessage = Message(id: attempt.id, projectId: "p", mine: true, body: "original", targetMemberId: "worker")
        let fixture = try IsolatedTestNetwork { request in
            guard request.httpMethod == "GET", request.url?.path == "/api/messages/\(attempt.id)" else { throw URLError(.unsupportedURL) }
            return IsolatedTestHTTPReply(data: try JSONEncoder().encode(serverMessage))
        }
        let status = try await restored.reconcileMessage(id: attempt.id, using: fixture.makeAPIClient())
        XCTAssertEqual(status, .accepted)
        let restoredDrafts = DraftStore(namespace: "host-a", storageURL: draftURL)
        try restored.consumeAccepted(id: attempt.id, drafts: restoredDrafts)
        XCTAssertEqual(restoredDrafts.text(for: "key"), "later edit")
        XCTAssertEqual(restoredDrafts.files(for: "key").map(\.id), ["two"])
        try restored.consumeAccepted(id: attempt.id, drafts: restoredDrafts)
        XCTAssertEqual(restoredDrafts.text(for: "key"), "later edit")
        XCTAssertEqual(fixture.requests.count, 1)
        XCTAssertEqual(try SubmissionStore(storageURL: attemptURL).messageAttempt(id: attempt.id)?.status, .accepted)
        await fixture.close()
    }

    @MainActor func testOnly404PermitsExplicitSameIDRetryAndHostAttemptsAreSeparate() async throws {
        let drafts = DraftStore(persist: false, namespace: "a")
        drafts.setText("body", for: "key")
        let store = try SubmissionStore(persist: false)
        let attempt = try store.prepareMessage(projectID: "p", targetMemberID: nil, draft: drafts.snapshot(for: "key"))
        _ = try store.beginMessage(id: attempt.id)
        for status in [401, 500] {
            let fixture = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: status) }
            do { _ = try await store.reconcileMessage(id: attempt.id, using: fixture.makeAPIClient()); XCTFail("Unexpected success") } catch {}
            XCTAssertEqual(store.messageAttempt(id: attempt.id)?.status, .checking)
            XCTAssertThrowsError(try store.beginMessage(id: attempt.id))
            await fixture.close()
        }
        let missing = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 404) }
        let status = try await store.reconcileMessage(id: attempt.id, using: missing.makeAPIClient())
        XCTAssertEqual(status, .notAccepted)
        let same = try store.prepareMessage(projectID: "p", targetMemberID: nil, draft: drafts.snapshot(for: "key"))
        XCTAssertEqual(same.id, attempt.id)
        XCTAssertEqual(try store.beginMessage(id: attempt.id).id, attempt.id)
        drafts.selectNamespace("b"); drafts.setText("body", for: "key")
        let other = try store.prepareMessage(projectID: "p", targetMemberID: nil, draft: drafts.snapshot(for: "key"))
        XCTAssertNotEqual(other.id, attempt.id)
        await missing.close()
    }

    @MainActor func testTerminalClaimUnknownAndInputRevisionSurviveRestart() throws {
        let directory = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("terminal.json")
        let store = try SubmissionStore(storageURL: url)
        try store.setTerminalInput("A", namespace: "host-a", memberID: "m")
        let claim = try store.terminalClaim(namespace: "host-a", memberID: "m", sessionGeneration: 2)
        let attempt = try store.prepareTerminal(namespace: "host-a", memberID: "m", sessionGeneration: 2, action: .input)
        XCTAssertEqual(try store.beginTerminal(id: attempt.id).claimId, claim)
        try store.setTerminalInput("B", namespace: "host-a", memberID: "m")
        let restored = try SubmissionStore(storageURL: url)
        XCTAssertEqual(try restored.terminalClaim(namespace: "host-a", memberID: "m", sessionGeneration: 2), claim)
        XCTAssertEqual(restored.terminalAttempt(id: attempt.id)?.status, .unknown)
        XCTAssertThrowsError(try restored.beginTerminal(id: attempt.id))
        XCTAssertThrowsError(try restored.prepareTerminal(namespace: "host-a", memberID: "m", sessionGeneration: 2, action: .key, key: .enter))
        let result = TerminalControlResultV2(memberId: "m", action: "input", claimId: claim, sessionGeneration: 2, inputSequence: 1)
        let receipt = OperationReceipt(operationId: attempt.id, kind: .terminalControl, memberId: "m", status: .applied, result: .terminalControl(result))
        try restored.applyTerminalReceipt(receipt)
        XCTAssertEqual(restored.terminalInput(namespace: "host-a", memberID: "m").text, "B")
        let second = try restored.prepareTerminal(namespace: "host-a", memberID: "m", sessionGeneration: 2, action: .input)
        XCTAssertEqual(second.inputSequence, 2)
        _ = try restored.beginTerminal(id: second.id)
        let secondResult = TerminalControlResultV2(memberId: "m", action: "input", claimId: claim, sessionGeneration: 2, inputSequence: 2)
        try restored.applyTerminalReceipt(OperationReceipt(operationId: second.id, kind: .terminalControl, memberId: "m", status: .applied, result: .terminalControl(secondResult)))
        XCTAssertEqual(restored.terminalInput(namespace: "host-a", memberID: "m").text, "")
        try restored.setTerminalInput("C", namespace: "host-a", memberID: "m")
        try restored.applyTerminalReceipt(receipt)
        XCTAssertEqual(restored.terminalInput(namespace: "host-a", memberID: "m").text, "C")
    }

    @MainActor func testLostClaimIsRecoveredByGETAndUnknownInputNeverReplayed() async throws {
        let store = try SubmissionStore(persist: false)
        let claim = try store.prepareTerminal(namespace: "a", memberID: "m", sessionGeneration: 1, action: .claim)
        _ = try store.beginTerminal(id: claim.id)
        let result = TerminalControlResultV2(memberId: "m", action: "claim", claimId: claim.claimID, sessionGeneration: 1)
        let receipt = OperationReceipt(operationId: claim.id, kind: .terminalControl, memberId: "m", status: .applied, result: .terminalControl(result))
        let fixture = try IsolatedTestNetwork { request in
            guard request.httpMethod == "GET", request.url?.path == "/api/operations/\(claim.id)" else { throw URLError(.unsupportedURL) }
            return IsolatedTestHTTPReply(data: try JSONEncoder().encode(receipt))
        }
        try await store.reconcileTerminal(id: claim.id, using: fixture.makeAPIClient())
        try store.setTerminalInput("A", namespace: "a", memberID: "m")
        let input = try store.prepareTerminal(namespace: "a", memberID: "m", sessionGeneration: 1, action: .input)
        XCTAssertEqual(input.claimID, claim.claimID)
        _ = try store.beginTerminal(id: input.id)
        let missing = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 404) }
        do { try await store.reconcileTerminal(id: input.id, using: missing.makeAPIClient()); XCTFail("Missing input succeeded") } catch {}
        XCTAssertEqual(store.terminalAttempt(id: input.id)?.status, .unknown)
        XCTAssertThrowsError(try store.beginTerminal(id: input.id))
        try store.setTerminalInput("B", namespace: "a", memberID: "m")
        try store.setTerminalInput("A", namespace: "a", memberID: "m")
        let inputResult = TerminalControlResultV2(memberId: "m", action: "input", claimId: input.claimID, sessionGeneration: 1, inputSequence: 1)
        try store.applyTerminalReceipt(OperationReceipt(operationId: input.id, kind: .terminalControl, memberId: "m", status: .applied, result: .terminalControl(inputResult)))
        XCTAssertEqual(store.terminalInput(namespace: "a", memberID: "m").text, "A")
        XCTAssertEqual(fixture.requests.count, 1)
        await fixture.close(); await missing.close()
    }

    @MainActor func testTerminalReceiptMismatchDoesNotClearInputAndRefusedKeepsIt() throws {
        let store = try SubmissionStore(persist: false)
        try store.setTerminalInput("text", namespace: "a", memberID: "m")
        let attempt = try store.prepareTerminal(namespace: "a", memberID: "m", sessionGeneration: 1, action: .input)
        _ = try store.beginTerminal(id: attempt.id)
        let bad = TerminalControlResultV2(memberId: "m", action: "input", claimId: "foreign", sessionGeneration: 1, inputSequence: 1)
        XCTAssertThrowsError(try store.applyTerminalReceipt(OperationReceipt(operationId: attempt.id, kind: .terminalControl, memberId: "m", status: .applied, result: .terminalControl(bad))))
        XCTAssertEqual(store.terminalAttempt(id: attempt.id)?.status, .unknown)
        try store.applyTerminalReceipt(OperationReceipt(operationId: attempt.id, kind: .terminalControl, memberId: "m", status: .refused))
        XCTAssertEqual(store.terminalInput(namespace: "a", memberID: "m").text, "text")
        XCTAssertNotEqual(try store.terminalClaim(namespace: "a", memberID: "m", sessionGeneration: 1), try store.terminalClaim(namespace: "b", memberID: "m", sessionGeneration: 1))
    }
}
