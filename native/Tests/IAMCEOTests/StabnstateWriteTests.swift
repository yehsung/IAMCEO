import Foundation
import XCTest
@testable import IAMCEO

@MainActor final class StabnstateWriteTests: XCTestCase {
    private func eventually(_ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<1500 {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("State did not settle", file: file, line: line)
    }
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("stab-n-state-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func connect(_ network: IsolatedTestNetwork, root: URL? = nil) async throws -> AppStore {
        let store: AppStore
        if let root {
            store = AppStore(session: network.session, persistCredentials: false,
                             submissions: try SubmissionStore(storageURL: root.appendingPathComponent("submissions")),
                             writeStorageURL: root.appendingPathComponent("journal"))
        } else {
            store = AppStore(session: network.session, persistCredentials: false)
        }
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect(); store.setForeground(false)
        XCTAssertTrue(store.canWrite)
        return store
    }
    private func operations(_ root: URL) throws -> [String: [String: Any]] {
        let journal = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("journal"))) as? [String: Any])
        return try XCTUnwrap(journal["operations"] as? [String: [String: Any]])
    }
    /// Model a journal entry written `seconds` ago.
    private func age(_ id: String, by seconds: Double, root: URL) throws {
        let url = root.appendingPathComponent("journal")
        var journal = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var operations = try XCTUnwrap(journal["operations"] as? [String: [String: Any]])
        let created = try XCTUnwrap(operations[id]?["createdAt"] as? Double)
        operations[id]?["createdAt"] = created - seconds
        journal["operations"] = operations
        try JSONSerialization.data(withJSONObject: journal).write(to: url, options: .atomic)
    }
    private func bodies(_ server: WriteTestServer, _ action: String) -> [[String: Any]] {
        server.read { $0.terminalBodies.filter { $0["action"] as? String == action } }
    }

    // MARK: n-appstore-4 — an accepted write does not stay "보내는 중" for the whole refresh

    func testAcceptedMessageUnlocksTheComposerBeforeItsRefreshFinishes() async throws {
        let server = WriteTestServer(), mode = StabSwitch(), held = StabGate()
        let network = try IsolatedTestNetwork { request in mode.apply(request, to: try server.handle(request)) }
        let store = try await connect(network)
        defer { store.disconnect() }
        mode.hold("/api/sync", held)
        let first = Task { await store.sendMessage(text: "첫 글") }
        await eventually { await held.entered == 1 }
        XCTAssertEqual(server.read { $0.sentIDs.count }, 1)
        XCTAssertFalse(store.isSending(projectID: "p", targetMemberID: nil), "The server accepted it; the lock must not wait for the refresh")
        XCTAssertNil(store.messageSendNotice(targetMemberID: nil))
        await held.open()
        let accepted = await first.value
        XCTAssertTrue(accepted)
        let second = await store.sendMessage(text: "다음 글")
        XCTAssertTrue(second)
        XCTAssertEqual(server.read { $0.sentIDs.count }, 2)
    }

    func testCardWriteUnlocksWhenTheSnapshotArrivesNotWhenEveryOtherReadEnds() async throws {
        let server = WriteTestServer(), mode = StabSwitch(), held = StabGate()
        let network = try IsolatedTestNetwork { request in
            if request.url!.path == "/api/members/m/activity" {
                return mode.apply(request, to: IsolatedTestHTTPReply(data: Data("[]".utf8)))
            }
            return try server.handle(request)
        }
        // The activity read needs the foreground, so this store stays active on a clock that only the test moves.
        let clock = CoordinatorClock()
        let store = AppStore(session: network.session, persistCredentials: false, clock: clock, retryJitter: { $0 })
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect()
        defer { store.disconnect() }
        XCTAssertTrue(store.canWrite)
        await store.activateActivity(memberID: "m")
        mode.hold("/api/members/m/activity", held)
        var finished = false
        let write = Task {
            let answered = await store.answerDecision(Decision(id: "d", projectId: "p", updatedAt: "reviewed"), choice: "a", note: nil)
            finished = true
            return answered
        }
        // The post-write refresh waits for the minimum snapshot interval, then reads the snapshot and,
        // later in the same pass, the open activity.
        await eventually { await clock.deadlines.contains(.milliseconds(500)) }
        await clock.advance(.milliseconds(500))
        await eventually { await held.entered == 1 }
        XCTAssertFalse(store.pendingActions.contains("decision:d"), "The snapshot already shows the answer")
        XCTAssertFalse(finished, "The caller still waits for the whole pass")
        await held.open()
        let answered = await write.value
        XCTAssertTrue(answered)
        XCTAssertFalse(store.pendingActions.contains("decision:d"))
    }

    // MARK: n-appstore-7 — an operation whose result never arrives is closed, never replayed

    func testInputThatNeverArrivedBlocksOnlyUntilItIsOldEnoughToClose() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = try await connect(network, root: root), member = store.members[0]
        let claimed = await store.claimTerminal(member); XCTAssertTrue(claimed)
        server.change { $0.dropTerminal = true; $0.storeTerminalReceipt = false }
        let typed = await store.terminalInput(member, text: "y"); XCTAssertFalse(typed)
        let lost = try XCTUnwrap(bodies(server, "input").first?["operationId"] as? String)
        XCTAssertEqual(try operations(root)[lost]?["status"] as? String, "unknown")
        server.change { $0.dropTerminal = false; $0.storeTerminalReceipt = true }

        // Fresh: the lost request may still be on its way, so nothing else goes out.
        for _ in 0..<2 { await store.recoverWrites() }
        let early = await store.terminalKey(member, key: "enter"); XCTAssertFalse(early)
        XCTAssertTrue(bodies(server, "key").isEmpty)
        XCTAssertEqual(try operations(root)[lost]?["status"] as? String, "unknown")
        store.disconnect()

        // Two minutes later and still unknown to the server: it never arrived.
        try age(lost, by: 120, root: root)
        let restarted = try await connect(network, root: root)
        defer { restarted.disconnect() }
        XCTAssertEqual(try operations(root)[lost]?["status"] as? String, "refused")
        XCTAssertEqual(restarted.terminalLeases["m"]?.leaseId, "lease")
        let lookups = network.requests.filter { $0.url?.path == "/api/operations/\(lost)" }.count
        for _ in 0..<2 { await restarted.recoverWrites() }
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/api/operations/\(lost)" }.count, lookups, "A closed operation is not queried again")
        let key = await restarted.terminalKey(restarted.members[0], key: "enter"); XCTAssertTrue(key)
        XCTAssertEqual(bodies(server, "key").count, 1)
        XCTAssertEqual(bodies(server, "input").count, 1, "The lost input itself is never sent again")
    }

    func testUnknownOperationFromAnEndedSessionClosesAndAllowsANewClaim() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = try await connect(network, root: root), member = store.members[0]
        defer { store.disconnect() }
        let claimed = await store.claimTerminal(member); XCTAssertTrue(claimed)
        server.change { $0.terminalUnknown = true }
        let typed = await store.terminalInput(member, text: "y"); XCTAssertFalse(typed)
        let unknown = try XCTUnwrap(bodies(server, "input").first?["operationId"] as? String)
        server.change { $0.terminalUnknown = false }
        await store.refresh()
        XCTAssertEqual(try operations(root)[unknown]?["status"] as? String, "unknown", "Same session: the server may still finish it")
        let blocked = await store.claimTerminal(member); XCTAssertFalse(blocked)

        // The member got a new session: the terminal that input was typed into is gone.
        server.change { $0.revisions.members?["m"] = MemberRevisions(configRevision: 1, sessionGeneration: 2) }
        await store.refresh()
        XCTAssertEqual(try operations(root)[unknown]?["status"] as? String, "refused")
        let again = await store.claimTerminal(member); XCTAssertTrue(again)
        XCTAssertEqual(bodies(server, "claim").last?["expectedSessionGeneration"] as? Int, 2)
        XCTAssertEqual(bodies(server, "input").count, 1)
    }
}
