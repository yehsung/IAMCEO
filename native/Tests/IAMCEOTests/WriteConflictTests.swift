import Foundation
import XCTest
@testable import IAMCEO

@MainActor final class WriteConflictTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }

    func testSettingsCASRejectsStaleEditorAndPreservesDraftAndCurrent() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        let edit = try XCTUnwrap(store.beginSettingsEditing())
        var draft = edit.draft; draft.compactAtPct = 80
        server.change { $0.bootstrap.settings.permissionMode = "bypassPermissions"; $0.revisions.settings = 2 }
        await store.refresh()
        let saved = await store.updateSettings(draft)
        XCTAssertFalse(saved)
        XCTAssertEqual(store.settingsEdit?.revision, 1)
        XCTAssertEqual(store.settingsEdit?.draft.compactAtPct, 80)
        XCTAssertEqual(store.settingsConflict?.permissionMode, "bypassPermissions")
        let body = try XCTUnwrap(server.read { $0.settingsBodies.last })
        XCTAssertEqual(Set(body.keys), ["compactAtPct"])
        XCTAssertEqual(network.requests.last { $0.url?.path == "/api/settings" }?.value(forHTTPHeaderField: "If-Match"), "\"1\"")
        XCTAssertEqual(server.read { $0.bootstrap.settings.permissionMode }, "bypassPermissions")
        store.disconnect()
    }

    func testSettingsSendsOnlyChangedRankLeafIncludingNullClear() async throws {
        let server = WriteTestServer()
        server.change { $0.bootstrap.settings.ranks = ["worker": RankConfig(model: "old", effort: "high")] }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        var draft = try XCTUnwrap(store.beginSettingsEditing()).draft
        draft.ranks["worker"]?.model = nil
        let saved = await store.updateSettings(draft)
        XCTAssertTrue(saved)
        let body = try XCTUnwrap(server.read { $0.settingsBodies.last })
        let ranks = try XCTUnwrap(body["ranks"] as? [String: [String: Any]])
        XCTAssertEqual(Set(body.keys), ["ranks"])
        XCTAssertEqual(Set(ranks["worker"]!.keys), ["model"])
        XCTAssertTrue(ranks["worker"]?["model"] is NSNull)
        XCTAssertTrue(network.requests.filter { $0.url?.path == "/api/settings" }.allSatisfy { $0.value(forHTTPHeaderField: "X-IAMCEO-Contract") == "2" })
        store.disconnect()
    }

    func testCodexSettingsDirtyPatchAndConflictPreservesDraft() async throws {
        let server = WriteTestServer()
        server.change { $0.bootstrap.settings.codexRanks = ["lead": RankConfig(model: "gpt-6-astra", effort: "high")] }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        var draft = try XCTUnwrap(store.beginSettingsEditing()).draft
        draft.codexRanks["lead"]?.model = nil
        let accepted = await store.updateSettings(draft)
        XCTAssertTrue(accepted)
        let body = try XCTUnwrap(server.read { $0.settingsBodies.last })
        XCTAssertEqual(Set(body.keys), ["codexRanks"])
        let ranks = try XCTUnwrap(body["codexRanks"] as? [String: [String: Any]])
        XCTAssertEqual(Set(ranks["lead"]!.keys), ["model"])
        XCTAssertTrue(ranks["lead"]?["model"] is NSNull)

        draft = try XCTUnwrap(store.beginSettingsEditing()).draft
        draft.codexRanks["lead"]?.effort = "minimal"
        server.change { $0.revisions.settings! += 1; $0.bootstrap.settings.codexRanks["lead"]?.model = "gpt-6-luna" }
        await store.refresh()
        let conflicted = await store.updateSettings(draft)
        XCTAssertFalse(conflicted)
        XCTAssertEqual(store.settingsEdit?.draft.codexRanks["lead"]?.effort, "minimal")
        XCTAssertEqual(store.settingsConflict?.codexRanks["lead"]?.model, "gpt-6-luna")
        let conflictBody = try XCTUnwrap(server.read { $0.settingsBodies.last })
        let conflictRanks = try XCTUnwrap(conflictBody["codexRanks"] as? [String: [String: Any]])
        XCTAssertEqual(Set(conflictRanks["lead"]!.keys), ["effort"])
        store.disconnect()
    }

    func testBatchClassifiesEachCardAndConsumesOnlyOwnAcceptedMemo() async throws {
        let server = WriteTestServer()
        server.change { $0.decisionStatuses = ["conflict": 409, "unknown": 0] }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        let cards = ["accepted", "conflict", "unknown", "invalid"].map {
            Decision(id: $0, projectId: "p", title: $0, options: [DecisionOption(k: "yes", label: "Yes")], rec: $0 == "invalid" ? nil : "yes", updatedAt: "reviewed")
        }
        for card in cards { store.drafts.setMemo("memo", for: card.id) }
        let result = await store.answerBatchResults(cards, notes: Dictionary(uniqueKeysWithValues: cards.map { ($0.id, "memo") }))
        XCTAssertEqual(result, ["accepted": .accepted, "conflict": .conflict, "unknown": .unknown, "invalid": .notSent])
        XCTAssertNil(store.drafts.memo(for: "accepted"))
        XCTAssertEqual(store.drafts.memo(for: "conflict"), "memo")
        XCTAssertEqual(store.drafts.memo(for: "unknown"), "memo")
        XCTAssertEqual(store.drafts.memo(for: "invalid"), "memo")
        store.disconnect()
    }

    func testTodoLostReplyStaysCheckingBlocksOppositeAndConvergesByRevision() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        server.change { $0.dropTodo = true }
        let first = await store.setTodoDone(store.todos[0], done: true)
        XCTAssertFalse(first)
        XCTAssertEqual(store.todoWrites["t"], .checking)
        let second = await store.setTodoDone(store.todos[0], done: false)
        XCTAssertFalse(second)
        XCTAssertEqual(server.read { $0.todoSends }, 1)
        server.change { $0.syncFailure = false }
        await store.refresh()
        XCTAssertEqual(store.todoWrites["t"], .confirmedCurrent)
        XCTAssertTrue(store.todos[0].done)
        store.disconnect()
    }

    /// n-appstore-6: 응답을 잃고 서버에도 닿지 않은 할 일 변경은 요청 제한 시간을 한참 넘기면 닫힌다.
    /// 닫히지 않으면 그 할 일을 이 기기에서 다시 체크할 수 없다.
    func testTodoChangeThatNeverArrivedStopsBlockingAfterItsTimeLimit() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let start = Date().timeIntervalSince1970
        store.wallClock = { start }
        server.change { $0.dropTodo = true }
        let first = await store.setTodoDone(store.todos[0], done: true)
        XCTAssertFalse(first)
        XCTAssertEqual(store.todoWrites["t"], .checking)
        // The request never reached the server: nothing changed there.
        server.change { $0.dropTodo = false; $0.syncFailure = false; $0.state.todos[0].done = false; $0.revisions.todos?["t"] = 1 }
        store.wallClock = { start + 59 }
        await store.refresh()
        XCTAssertEqual(store.todoWrites["t"], .checking)
        let blocked = await store.setTodoDone(store.todos[0], done: true)
        XCTAssertFalse(blocked)
        XCTAssertEqual(server.read { $0.todoSends }, 1)
        store.wallClock = { start + 61 }
        await store.refresh()
        XCTAssertEqual(store.todoWrites["t"], .notApplied)
        XCTAssertFalse(store.todos[0].done)
        let again = await store.setTodoDone(store.todos[0], done: true)
        XCTAssertTrue(again)
        XCTAssertEqual(server.read { $0.todoSends }, 2)
        XCTAssertTrue(store.todos[0].done)
    }

    func testStaleTodoCASCannotOverwriteOtherDevice() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        let old = store.todos[0]
        server.change { $0.state.todos[0].done = true; $0.revisions.todos?["t"] = 2 }
        let changed = await store.setTodoDone(old, done: false)
        XCTAssertFalse(changed)
        XCTAssertEqual(store.todoWrites["t"], .conflict)
        XCTAssertTrue(server.read { $0.state.todos[0].done })
        store.disconnect()
    }

    func testConfirmed401EndsAuthenticationAndSampleCannotWrite() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        server.change { $0.rejectAll = true }
        let changed = await store.setTodoDone(store.todos[0], done: true)
        XCTAssertFalse(changed)
        XCTAssertFalse(store.canWrite)
        XCTAssertNil(store.api)
        XCTAssertEqual(store.connectionStatus, .failed)
        let demo = AppStore(demo: true, session: network.session, persistCredentials: false)
        let before = network.requests.count
        let sent = await demo.sendMessage(text: "no")
        let settings = await demo.updateSettings(Settings())
        XCTAssertFalse(sent); XCTAssertFalse(settings)
        XCTAssertEqual(network.requests.count, before)
        store.disconnect()
    }
    func testSyncTransportFailureNeverDowngradesTerminalWriteContract() async throws {
        let server = WriteTestServer()
        server.change { $0.syncFailure = true }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        let claimed = await store.claimTerminal(store.members[0])
        XCTAssertFalse(claimed)
        XCTAssertTrue(store.canWrite)
        XCTAssertTrue(server.read { $0.terminalBodies.isEmpty })
        store.disconnect()
    }

    func testExplicitLegacyAbsenceRetainsLeaseOnUnknownInputAndRelease() async throws {
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/capabilities" { return IsolatedTestHTTPReply(status: 404) }
            if request.url?.path.hasSuffix("/terminal/control") == true {
                if server.read({ $0.dropTerminal }) { throw URLError(.timedOut) }
                return IsolatedTestHTTPReply(data: Data(#"{"leaseId":"legacy","expiresAt":9999999999999}"#.utf8))
            }
            return try server.handle(request)
        }
        let store = await connect(network)
        let claimed = await store.claimTerminal(store.members[0]); XCTAssertTrue(claimed)
        server.change { $0.dropTerminal = true }
        let input = await store.terminalInput(store.members[0], text: "y"); XCTAssertFalse(input)
        let released = await store.releaseTerminal(store.members[0]); XCTAssertFalse(released)
        XCTAssertEqual(store.terminalLeases["m"]?.leaseId, "legacy")
        server.change { $0.dropTerminal = false }
        let before = network.requests.count
        store.disconnect()
        // 끊을 때 남은 옛 방식 조작권은 놓아 달라고 한 번 보낸다(답은 기다리지 않는다).
        let deadline = Date().addingTimeInterval(2)
        var releaseSent = false
        while !releaseSent, Date() < deadline {
            releaseSent = network.requests.dropFirst(before).contains {
                $0.url?.path == "/api/members/m/terminal/control"
                    && (try? WriteTestServer.body($0))?["action"] as? String == "release"
                    && (try? WriteTestServer.body($0))?["leaseId"] as? String == "legacy"
            }
            if !releaseSent { try await Task.sleep(for: .milliseconds(20)) }
        }
        XCTAssertTrue(releaseSent)
        await network.close()
    }

    /// 흔들림(xctest 가 죽음): 끊을 때 띄운 조작권 놓기 작업이, 시험이 이미 무효화한 세션으로 요청을 만들어
    /// Objective-C 예외("Task created in a session that has been invalidated")로 프로세스를 죽였다.
    /// 놓기 요청은 끊는 그 자리에서 만들고, 그때 세션이 이미 닫혔어도 죽지 않는다.
    func testDisconnectThenClosedSessionNeverCrashesOnLeaseRelease() async throws {
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/capabilities" { return IsolatedTestHTTPReply(status: 404) }
            if request.url?.path.hasSuffix("/terminal/control") == true {
                return IsolatedTestHTTPReply(data: Data(#"{"leaseId":"legacy","expiresAt":9999999999999}"#.utf8))
            }
            return try server.handle(request)
        }
        // 1) 끊자마자 세션을 닫는다(예전에는 나중에 도는 작업이 닫힌 세션으로 요청을 만들었다).
        let store = await connect(network)
        let claimed = await store.claimTerminal(store.members[0]); XCTAssertTrue(claimed)
        store.disconnect()
        await network.close()
        // 2) 세션이 이미 닫힌 뒤에 끊어도 죽지 않는다.
        let second = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/capabilities" { return IsolatedTestHTTPReply(status: 404) }
            if request.url?.path.hasSuffix("/terminal/control") == true {
                return IsolatedTestHTTPReply(data: Data(#"{"leaseId":"legacy-2","expiresAt":9999999999999}"#.utf8))
            }
            return try server.handle(request)
        }
        let late = await connect(second)
        let again = await late.claimTerminal(late.members[0]); XCTAssertTrue(again)
        await second.close()
        late.disconnect()
        // 끊은 뒤에 도는 일이 남아 있었다면 이 사이에 프로세스가 죽는다.
        for _ in 0..<10 { await Task.yield(); try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(store.terminalLeases.isEmpty)
        XCTAssertTrue(late.terminalLeases.isEmpty)
    }

    func testMalformedSyncDoesNotAuthorizeLegacyTerminalWrites() async throws {
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/sync" { return IsolatedTestHTTPReply() }
            return try server.handle(request)
        }
        let store = await connect(network)
        defer { store.disconnect() }
        XCTAssertTrue(store.canWrite)
        XCTAssertNil(store.writeRevisions)
        let member = try XCTUnwrap(store.members.first)
        let claimed = await store.claimTerminal(member)
        XCTAssertFalse(claimed)
        XCTAssertTrue(server.read { $0.terminalBodies.isEmpty })
        XCTAssertFalse(network.requests.contains { $0.url?.path.hasSuffix("/terminal/control") == true })
    }

    func testUnadvertisedOperationsKeepAllLegacyWriteShapes() async throws {
        // Includes a v2 server with operations disabled and optional discovery failures.
        for capability in [nil, "{}", #"{"contractVersion":1,"capabilities":{"operations":true}}"#,
                           #"{"contractVersion":2,"capabilities":{"operations":false}}"#, "not JSON", "timeout"] as [String?] {
            let server = WriteTestServer()
            let network = try IsolatedTestNetwork { request in
                switch request.url?.path {
                case "/api/capabilities":
                    if capability == "timeout" { throw URLError(.timedOut) }
                    guard let capability else { return IsolatedTestHTTPReply(status: 404) }
                    return IsolatedTestHTTPReply(data: Data(capability.utf8))
                case "/api/settings":
                    return try server.reply(Settings())
                case "/api/members/m", "/api/members/m/fresh-session":
                    return try server.reply(Member(id: "m", projectId: "p"))
                case "/api/todos/t/done":
                    return try server.reply(Todo(id: "t", projectId: "p", done: true))
                case "/api/members/m/terminal/control":
                    return IsolatedTestHTTPReply(data: Data(#"{"leaseId":"legacy","expiresAt":9999999999999}"#.utf8))
                default: return try server.handle(request)
                }
            }
            let store = await connect(network)
            let member = try XCTUnwrap(store.members.first), todo = try XCTUnwrap(store.todos.first)
            let settings = await store.updateSettings(Settings())
            let patch = await store.patchMember(member, provider: "codex", model: nil, effort: nil)
            let done = await store.setTodoDone(todo, done: true)
            let fresh = await store.freshSession(member)
            let claim = await store.claimTerminal(member)
            let input = await store.terminalInput(member, text: "yes")
            let key = await store.terminalKey(member, key: "enter")
            let release = await store.releaseTerminal(member)
            let decision = Decision(id: "legacy", projectId: "p", options: [DecisionOption(k: "yes", label: "Yes")], rec: "yes")
            let answer = await store.answerDecision(decision, choice: "yes", note: nil)
            let batch = await store.answerBatchResults([decision])
            XCTAssertTrue([settings, patch, done, fresh, claim, input, key, release, answer].allSatisfy { $0 })
            XCTAssertEqual(batch[decision.id], .accepted)
            XCTAssertNil(store.writeRevisions)
            XCTAssertFalse(network.requests.contains { $0.url?.path == "/api/sync" || $0.url?.path.hasPrefix("/api/operations/") == true })
            let writes = network.requests.filter { $0.httpMethod != "GET" }
            XCTAssertEqual(writes.count, 10)
            XCTAssertTrue(writes.allSatisfy { $0.value(forHTTPHeaderField: "X-IAMCEO-Contract") == nil && $0.value(forHTTPHeaderField: "If-Match") == nil })
            let settingsRequest = try XCTUnwrap(writes.first { $0.url?.path == "/api/settings" })
            XCTAssertEqual(settingsRequest.httpMethod, "PUT")
            let memberRequest = try XCTUnwrap(writes.first { $0.url?.path == "/api/members/m" })
            XCTAssertEqual(memberRequest.httpMethod, "PATCH")
            let freshRequest = try XCTUnwrap(writes.first { $0.url?.path.hasSuffix("/fresh-session") == true })
            XCTAssertTrue(try WriteTestServer.body(freshRequest).isEmpty)
            let inputRequest = try XCTUnwrap(writes.first { (try? WriteTestServer.body($0)["action"] as? String) == "input" })
            let body = try WriteTestServer.body(inputRequest)
            XCTAssertEqual(body["leaseId"] as? String, "legacy")
            XCTAssertNil(body["operationId"])
            store.disconnect()
            await network.close()
        }
    }

    func testAdvertisedV2NeverDowngradesAfterCapabilityAndSyncDisappear() async throws {
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork { request in
            if server.read({ $0.syncFailure }), ["/api/capabilities", "/api/sync"].contains(request.url?.path ?? "") {
                return IsolatedTestHTTPReply(status: 404)
            }
            return try server.handle(request)
        }
        let store = await connect(network)
        defer { store.disconnect() }
        let member = try XCTUnwrap(store.members.first)
        server.change { $0.syncFailure = true }
        await store.refresh()
        let claimed = await store.claimTerminal(member)
        XCTAssertTrue(claimed)
        let request = try XCTUnwrap(network.requests.last { $0.url?.path.hasSuffix("/terminal/control") == true })
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-IAMCEO-Contract"), "2")
        XCTAssertNotNil(try WriteTestServer.body(request)["operationId"])
    }

}
