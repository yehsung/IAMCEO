import Foundation
import XCTest
@testable import IAMCEO

@MainActor final class OperationRecoveryTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork, root: URL) async throws -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false,
                             submissions: try SubmissionStore(storageURL: root.appendingPathComponent("submissions")),
                             writeStorageURL: root.appendingPathComponent("journal"))
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func journal(_ root: URL) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("journal"))) as? [String: Any])
    }
    private func operations(_ root: URL) throws -> [String: [String: Any]] {
        try XCTUnwrap(journal(root)["operations"] as? [String: [String: Any]])
    }
    private func write(_ value: [String: Any], root: URL) throws {
        try JSONSerialization.data(withJSONObject: value).write(to: root.appendingPathComponent("journal"), options: .atomic)
    }

    /// Model process death after the atomic close-intent write but before any release is dispatched.
    private func persistCloseIntent(_ root: URL, claimID: String) throws {
        var value = try journal(root), ops = try operations(root)
        let id = try XCTUnwrap(ops.first { entry in
            guard entry.value["action"] as? String == "claim",
                  let receipt = entry.value["receipt"] as? [String: Any],
                  let result = receipt["result"] as? [String: Any] else { return false }
            return result["claimId"] as? String == claimID
        }?.key)
        ops[id]?["cancelledClaim"] = true
        value["operations"] = ops; try write(value, root: root)
    }

    func testClosedClaimSurvivesInputKeyPruningAndRestartBeforeRelease() async throws {
        for (inputCount, legacy) in [(2, false), (70, false), (70, true)] {
            let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
            let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
            let store = try await connect(network, root: root), member = store.members[0], owner = UUID()
            let lease = await store.claimTerminalSession(member, owner: owner); XCTAssertNotNil(lease)
            for index in 0..<inputCount {
                let sent = index.isMultiple(of: 2) ? await store.terminalInput(member, text: "input-\(index)") : await store.terminalKey(member, key: "enter")
                XCTAssertTrue(sent)
            }
            let claim = try XCTUnwrap(try operations(root).values.first { $0["action"] as? String == "claim" })
            let id = try XCTUnwrap(claim["id"] as? String)
            XCTAssertNotNil(store.submissions?.terminalAttempt(id: id), "The claim must remain available for a future close")
            store.disconnect()
            try persistCloseIntent(root, claimID: owner.uuidString)
            if legacy {
                var value = try journal(root), ops = try operations(root)
                ops[id]?.removeValue(forKey: "receipt")
                value["operations"] = ops; try write(value, root: root)
            }
            let restarted = try await connect(network, root: root)
            XCTAssertNil(restarted.terminalLeases[member.id])
            for _ in 0..<2 { await restarted.recoverWrites() }
            let releases = server.read { $0.terminalBodies.filter { $0["action"] as? String == "release" } }
            XCTAssertEqual(releases.count, 1)
            XCTAssertEqual(releases.first?["claimId"] as? String, owner.uuidString)
            XCTAssertFalse(try operations(root).values.contains { $0["cancelledClaim"] as? Bool == true })
            restarted.disconnect()
            let again = try await connect(network, root: root)
            XCTAssertNil(again.terminalLeases[member.id], "The applied release must prevent lease resurrection")
            again.disconnect()
        }
    }

    func testLostCancelledClaimRetriesDefinitivelyRefusedReleaseOnNextRecovery() async throws {
        for (restart, httpRefusal) in [(false, false), (true, false), (false, true)] {
            let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
            let server = WriteTestServer()
            let network = try IsolatedTestNetwork { request in
                if request.url?.path.hasPrefix("/api/operations/") == true, server.read({ $0.dropTerminal }) { throw URLError(.timedOut) }
                if request.url?.path.hasSuffix("/terminal/control") == true {
                    let body = try WriteTestServer.body(request)
                    if body["action"] as? String == "release", !server.read({ $0.terminalBodies.contains { $0["action"] as? String == "release" } }) {
                        let receipt = OperationReceipt(operationId: body["operationId"] as! String, kind: .terminalControl,
                                                       memberId: "m", status: .refused, error: "세션을 처리하는 중입니다")
                        server.change { $0.terminalBodies.append(body); $0.receipts[receipt.operationId] = receipt }
                        if httpRefusal {
                            return IsolatedTestHTTPReply(status: 409, data: try JSONSerialization.data(withJSONObject: ["error": "세션을 처리하는 중입니다"]))
                        }
                        return try server.reply(receipt)
                    }
                }
                return try server.handle(request)
            }
            let store = try await connect(network, root: root), member = store.members[0], owner = UUID()
            server.change { $0.dropTerminal = true }
            let claimed = await store.claimTerminalSession(member, owner: owner); XCTAssertNil(claimed)
            _ = await store.releaseTerminalSession(member, owner: owner)
            server.change { $0.dropTerminal = false }
            await store.recoverWrites()
            XCTAssertEqual(store.terminalLeases[member.id]?.leaseId, "lease")
            XCTAssertTrue(try operations(root).values.contains { $0["cancelledClaim"] as? Bool == true })
            XCTAssertEqual(server.read { $0.terminalBodies.filter { $0["action"] as? String == "release" }.count }, 1)
            let active: AppStore
            if restart { store.disconnect(); active = try await connect(network, root: root) }
            else { active = store }
            await active.recoverWrites()
            XCTAssertNil(active.terminalLeases[member.id])
            await active.recoverWrites()
            let releases = server.read { $0.terminalBodies.filter { $0["action"] as? String == "release" } }
            XCTAssertEqual(releases.count, 2)
            XCTAssertEqual(Set(releases.compactMap { $0["operationId"] as? String }).count, 2)
            XCTAssertFalse(try operations(root).values.contains { $0["cancelledClaim"] as? Bool == true })
            active.disconnect()
        }
    }

    func testCancelledCleanupQueriesPendingOrUnknownReleaseWithoutResendingAcrossRestart() async throws {
        for status in [OperationStatus.pending, .unknown] {
            let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
            let server = WriteTestServer()
            let network = try IsolatedTestNetwork { request in
                if request.url?.path.hasSuffix("/terminal/control") == true {
                    let body = try WriteTestServer.body(request)
                    if body["action"] as? String == "release" {
                        let receipt = OperationReceipt(operationId: body["operationId"] as! String, kind: .terminalControl, memberId: "m", status: status)
                        server.change { $0.terminalBodies.append(body); $0.receipts[receipt.operationId] = receipt }
                        throw URLError(.timedOut)
                    }
                }
                return try server.handle(request)
            }
            let store = try await connect(network, root: root), member = store.members[0], owner = UUID()
            let lease = await store.claimTerminalSession(member, owner: owner); XCTAssertNotNil(lease)
            let released = await store.releaseTerminalSession(member, owner: owner); XCTAssertFalse(released)
            for _ in 0..<2 { await store.recoverWrites() }
            store.disconnect()
            let restarted = try await connect(network, root: root)
            for _ in 0..<2 { await restarted.recoverWrites() }
            let releases = server.read { $0.terminalBodies.filter { $0["action"] as? String == "release" } }
            XCTAssertEqual(releases.count, 1)
            let id = try XCTUnwrap(releases.first?["operationId"] as? String)
            XCTAssertGreaterThan(network.requests.filter { $0.url?.path == "/api/operations/\(id)" }.count, 2)
            XCTAssertTrue(try operations(root).values.contains { $0["cancelledClaim"] as? Bool == true })
            let receipt = OperationReceipt(operationId: id, kind: .terminalControl, memberId: "m", status: .applied,
                result: .terminalControl(TerminalControlResultV2(memberId: "m", action: "release", claimId: owner.uuidString, sessionGeneration: 1)))
            server.change { $0.receipts[id] = receipt }
            await restarted.recoverWrites()
            XCTAssertNil(restarted.terminalLeases[member.id])
            XCTAssertFalse(try operations(root).values.contains { $0["cancelledClaim"] as? Bool == true })
            XCTAssertEqual(server.read { $0.terminalBodies.filter { $0["action"] as? String == "release" }.count }, 1)
            restarted.disconnect()
        }
    }

    func testConfirmedLeaseDisappearanceCompletesCancellationWithoutResurrection() async throws {
        for endedByStream in [true, false] {
            let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
            let server = WriteTestServer()
            let network = try IsolatedTestNetwork { request in
                if request.url?.path.hasSuffix("/terminal/control") == true {
                    let body = try WriteTestServer.body(request)
                    if body["action"] as? String == "release" {
                        let receipt = OperationReceipt(operationId: body["operationId"] as! String, kind: .terminalControl,
                            memberId: "m", status: .refused, error: "조작권이 만료되었거나 바뀌었습니다")
                        server.change { $0.terminalBodies.append(body); $0.receipts[receipt.operationId] = receipt }
                        return try server.reply(receipt)
                    }
                }
                return try server.handle(request)
            }
            let store = try await connect(network, root: root), member = store.members[0], owner = UUID()
            let claimed = await store.claimTerminal(member, claimID: owner.uuidString); XCTAssertTrue(claimed)
            let sent = await store.terminalInput(member, text: "before close"); XCTAssertTrue(sent)
            if endedByStream { store.terminalStreamLeaseEnded(memberID: member.id) }
            let released = await store.releaseTerminalSession(member, owner: owner); XCTAssertTrue(released)
            await store.recoverWrites()
            XCTAssertNil(store.terminalLeases[member.id])
            XCTAssertFalse(try operations(root).values.contains { $0["cancelledClaim"] as? Bool == true })
            XCTAssertTrue(try operations(root).values.contains { $0["leaseEnded"] as? Bool == true })
            let before = server.read { $0.terminalBodies.count }
            store.disconnect()
            let restarted = try await connect(network, root: root)
            await restarted.recoverWrites()
            XCTAssertNil(restarted.terminalLeases[member.id])
            XCTAssertEqual(server.read { $0.terminalBodies.count }, before)
            restarted.disconnect()
        }
    }

    func testPruningKeepsCancelledClaimWhenNewerLegacyLeaseCheckpointCannotBeRead() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(); server.change { $0.uniqueTerminalLeases = true }
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasPrefix("/api/operations/") == true, server.read({ $0.dropTerminal }) { throw URLError(.timedOut) }
            return try server.handle(request)
        }
        let store = try await connect(network, root: root), member = store.members[0], oldOwner = UUID(), newOwner = UUID()
        let first = await store.claimTerminal(member, claimID: oldOwner.uuidString); XCTAssertTrue(first)
        let second = await store.claimTerminal(member, claimID: newOwner.uuidString); XCTAssertTrue(second)
        store.disconnect()
        try persistCloseIntent(root, claimID: oldOwner.uuidString)
        var value = try journal(root), ops = try operations(root)
        let latest = try XCTUnwrap(ops.values.max { ($0["order"] as? Int ?? -1) < ($1["order"] as? Int ?? -1) })
        let latestID = try XCTUnwrap(latest["id"] as? String)
        ops[latestID]?.removeValue(forKey: "receipt")
        // Push the old cancelled claim out of both the 64 finals and the active-claim checkpoint.
        for order in 2...135 {
            var refused = latest
            refused["id"] = "refused-\(order)"; refused["order"] = order; refused["status"] = "refused"
            refused.removeValue(forKey: "receipt"); ops["refused-\(order)"] = refused
        }
        value["operations"] = ops; try write(value, root: root)
        server.change { $0.dropTerminal = true }
        let restarted = try await connect(network, root: root)
        await restarted.recoverWrites()
        XCTAssertNil(restarted.terminalLeases[member.id], "An unread newer checkpoint must not resurrect the cancelled old lease")
        XCTAssertTrue(try operations(root).values.contains { $0["cancelledClaim"] as? Bool == true })
        XCTAssertEqual(try operations(root).count, 66)
        let cancelledID = try XCTUnwrap(try operations(root).first { $0.value["cancelledClaim"] as? Bool == true }?.key)
        XCTAssertNotNil(restarted.submissions?.terminalAttempt(id: cancelledID))
        XCTAssertEqual(server.read { $0.terminalBodies.count }, 2)
        server.change { $0.dropTerminal = false }
        await restarted.recoverWrites()
        XCTAssertEqual(restarted.terminalLeases[member.id]?.leaseId, newOwner.uuidString)
        XCTAssertFalse(try operations(root).values.contains { $0["cancelledClaim"] as? Bool == true })
        XCTAssertEqual(server.read { $0.terminalBodies.count }, 2, "Do not release the newer holder")
        restarted.disconnect()
    }

    func testOldCancelledClaimDoesNotRestoreOrReleaseAfterNewLeaseReleaseOrGenerationChange() async throws {
        for superseding in ["newLease", "release", "generation"] {
            let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
            let server = WriteTestServer(); server.change { $0.uniqueTerminalLeases = true }
            let network = try IsolatedTestNetwork(handler: server.handle)
            let store = try await connect(network, root: root), member = store.members[0], oldOwner = UUID(), newOwner = UUID()
            let first = await store.claimTerminal(member, claimID: oldOwner.uuidString); XCTAssertTrue(first)
            let input = await store.terminalInput(member, text: "before close"); XCTAssertTrue(input)
            if superseding == "newLease" {
                let claimed = await store.claimTerminal(member, claimID: newOwner.uuidString); XCTAssertTrue(claimed)
            } else if superseding == "release" {
                let released = await store.releaseTerminal(member); XCTAssertTrue(released)
            } else {
                server.change { $0.revisions.members?[member.id] = MemberRevisions(configRevision: 1, sessionGeneration: 2) }
            }
            store.disconnect()
            try persistCloseIntent(root, claimID: oldOwner.uuidString)
            let before = server.read { $0.terminalBodies.count }
            let restarted = try await connect(network, root: root)
            for _ in 0..<2 { await restarted.recoverWrites() }
            XCTAssertEqual(server.read { $0.terminalBodies.count }, before)
            XCTAssertEqual(restarted.terminalLeases[member.id]?.leaseId, superseding == "newLease" ? newOwner.uuidString : nil)
            XCTAssertFalse(try operations(root).values.contains { $0["cancelledClaim"] as? Bool == true })
            restarted.disconnect()
        }
    }

    func testFirstRefusalBannersOnceAndPersistedRefusalNeverRequeriesAfterRestart() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), raw = "No core terminal for member"
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasSuffix("/terminal/control") == true {
                let body = try WriteTestServer.body(request)
                return try server.reply(OperationReceipt(operationId: body["operationId"] as! String, kind: .terminalControl,
                                                        memberId: "m", status: .refused, error: raw))
            }
            return try server.handle(request)
        }
        let store = try await connect(network, root: root)
        let claimed = await store.claimTerminal(store.members[0]); XCTAssertFalse(claimed)
        XCTAssertEqual(store.errorMessage, "이 직원은 잠들어 있어 터미널이 없습니다")
        store.errorMessage = nil
        for _ in 0..<2 { await store.recoverWrites(); XCTAssertNil(store.errorMessage) }
        store.disconnect()
        let restarted = try await connect(network, root: root)
        for _ in 0..<2 { await restarted.recoverWrites(); XCTAssertNil(restarted.errorMessage) }
        XCTAssertFalse(network.requests.contains { $0.url?.path.hasPrefix("/api/operations/") == true })
        XCTAssertEqual(try operations(root).values.first?["status"] as? String, "refused")
        restarted.disconnect()
    }

    func testMissingTerminalRefusalStaysInOpenWindowForReceiptAndHTTPReplies() async throws {
        for mode in 0...2 {
            let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
            let server = WriteTestServer(), raw = "No core terminal for member"
            let network = try IsolatedTestNetwork { request in
                if mode == 2, request.url?.path == "/api/capabilities" { return IsolatedTestHTTPReply(status: 404) }
                if request.url?.path.hasSuffix("/terminal/control") == true {
                    if mode != 0 { return IsolatedTestHTTPReply(status: 409, data: try JSONSerialization.data(withJSONObject: ["error": raw])) }
                    let body = try WriteTestServer.body(request)
                    return try server.reply(OperationReceipt(operationId: body["operationId"] as! String, kind: .terminalControl,
                                                            memberId: "m", status: .refused, error: raw))
                }
                return try server.handle(request)
            }
            let store = try await connect(network, root: root), member = store.members[0]
            let session = TerminalSession(platform: .mac) { _, _, _, _, _, _, _ in }
            session.appear(store: store, member: member, active: true)
            for _ in 0..<200 where session.starting { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertTrue(session.missingTerminal, "The window offers its existing wake guidance")
            XCTAssertNil(store.errorMessage)
            if mode != 2 { XCTAssertEqual(store.operationResults.values.first?.error, raw) }
            XCTAssertEqual(store.terminalWindowNotice(memberID: member.id), raw)
            for _ in 0..<2 { await store.recoverWrites(); XCTAssertNil(store.errorMessage) }
            session.disappear(store: store, member: member); store.disconnect()
        }
    }

    func testAppliedClaimRestoresFromCachedReceiptAndLegacyClaimFetchesOnlyOnce() async throws {
        for legacy in [false, true] {
            let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
            let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
            let store = try await connect(network, root: root)
            let claimed = await store.claimTerminal(store.members[0]); XCTAssertTrue(claimed)
            store.disconnect()
            if legacy {
                var value = try journal(root), ops = try operations(root)
                for id in Array(ops.keys) { ops[id]?.removeValue(forKey: "receipt") }
                value["operations"] = ops; try write(value, root: root)
            }
            let before = network.requests.filter { $0.url?.path.hasPrefix("/api/operations/") == true }.count
            let restarted = try await connect(network, root: root)
            XCTAssertEqual(restarted.terminalLeases["m"]?.leaseId, "lease")
            for _ in 0..<2 { await restarted.recoverWrites() }
            let after = network.requests.filter { $0.url?.path.hasPrefix("/api/operations/") == true }.count
            XCTAssertEqual(after - before, legacy ? 1 : 0)
            restarted.disconnect()
        }
    }

    func testAppliedClaimFromOldGenerationDoesNotQueryOrRestoreLease() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = try await connect(network, root: root)
        let claimed = await store.claimTerminal(store.members[0]); XCTAssertTrue(claimed)
        store.disconnect()
        var value = try journal(root), ops = try operations(root)
        for id in Array(ops.keys) { ops[id]?.removeValue(forKey: "receipt") }
        value["operations"] = ops; try write(value, root: root)
        server.change { $0.revisions.members?["m"] = MemberRevisions(configRevision: 1, sessionGeneration: 2) }
        let restarted = try await connect(network, root: root)
        for _ in 0..<2 { await restarted.recoverWrites(); XCTAssertNil(restarted.terminalLeases["m"]) }
        XCTAssertFalse(network.requests.contains { $0.url?.path.hasPrefix("/api/operations/") == true })
        restarted.disconnect()
    }

    func testPruningKeepsLatestLeaseUnknownInputAndOtherKindsAndOrderIncreases() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = try await connect(network, root: root)
        let claimed = await store.claimTerminal(store.members[0]); XCTAssertTrue(claimed)
        store.disconnect()
        var value = try journal(root), ops = try operations(root)
        let checkpoint = try XCTUnwrap(ops.values.first)
        let checkpointID = try XCTUnwrap(checkpoint["id"] as? String)
        for order in 1...130 {
            var operation = checkpoint
            operation["id"] = "refused-\(order)"; operation["order"] = order; operation["status"] = "refused"
            operation.removeValue(forKey: "receipt")
            ops["refused-\(order)"] = operation
        }
        for status in ["pending", "unknown"] {
            var operation = checkpoint
            operation["id"] = status; operation["namespace"] = "other-host"; operation["status"] = status
            operation.removeValue(forKey: "receipt"); ops[status] = operation
        }
        var fresh = checkpoint
        fresh["id"] = "fresh"; fresh["kind"] = OperationKind.freshSession.rawValue; fresh["status"] = "refused"
        fresh.removeValue(forKey: "receipt"); ops["fresh"] = fresh
        value["operations"] = ops; try write(value, root: root)
        let restarted = try await connect(network, root: root)
        let kept = try operations(root)
        XCTAssertEqual(kept.count, 68) // 64 recent finals, one lease checkpoint, two unresolved, one fresh-session.
        XCTAssertNotNil(kept[checkpointID]); XCTAssertNotNil(kept["pending"]); XCTAssertNotNil(kept["unknown"]); XCTAssertNotNil(kept["fresh"])
        XCTAssertNil(kept["refused-1"]); XCTAssertNotNil(kept["refused-130"])
        XCTAssertEqual(restarted.terminalLeases["m"]?.leaseId, "lease")
        let again = await restarted.claimTerminal(restarted.members[0]); XCTAssertTrue(again)
        XCTAssertEqual(try operations(root).values.compactMap { $0["order"] as? Int }.max(), 131)
        restarted.disconnect()
    }

    func testPruningAlsoBoundsFinishedSubmissionCopies() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = try await connect(network, root: root)
        for _ in 0..<70 {
            let claimed = await store.claimTerminal(store.members[0]); XCTAssertTrue(claimed)
        }
        let ids = server.read { $0.terminalBodies.compactMap { $0["operationId"] as? String } }
        XCTAssertEqual(try operations(root).count, 64)
        XCTAssertNil(store.submissions?.terminalAttempt(id: ids[0]))
        XCTAssertNotNil(store.submissions?.terminalAttempt(id: ids[69]))
        XCTAssertEqual(store.operationResults.count, 64)
        store.disconnect()
    }
}
