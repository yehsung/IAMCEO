import Foundation
import XCTest
@testable import IAMCEO

@MainActor final class TerminalWakeTests: XCTestCase {
    private func sleeping(_ status: String = "asleep") -> Member {
        Member(id: "m", projectId: "p", backend: "core", status: status, sessionId: "same-session")
    }

    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }

    private func eventually(_ predicate: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Condition did not become true", file: file, line: line)
    }

    func testWakeEligibilityAndPlatformTitles() {
        for status in ["asleep", "offline"] {
            var member = sleeping(status)
            XCTAssertTrue(TerminalAvailability.needsWake(member))
            XCTAssertEqual(TerminalAvailability.title(member, waking: false, platform: .mac), "깨워서 터미널 열기")
            XCTAssertEqual(TerminalAvailability.title(member, waking: false, platform: .iPhone), "깨워서 터미널")
            XCTAssertEqual(TerminalAvailability.title(member, waking: true), "깨우는 중…")
            member.paneId = ""
            XCTAssertTrue(TerminalAvailability.needsWake(member))
            member.paneId = "pane"
            XCTAssertFalse(TerminalAvailability.needsWake(member))
            XCTAssertFalse(TerminalAvailability.isReady(member))
        }
        for status in ["working", "waiting", "idle", "blocked", "error", "gone"] {
            XCTAssertFalse(TerminalAvailability.needsWake(sleeping(status)))
        }
        for backend in [nil, "tmux", "legacy"] as [String?] {
            var member = sleeping(); member.backend = backend
            XCTAssertFalse(TerminalAvailability.needsWake(member), "Older servers keep their existing opening behavior")
        }
        for origin in ["manual", "adopted"] {
            var member = sleeping(); member.origin = origin
            XCTAssertFalse(TerminalAvailability.needsWake(member))
            XCTAssertFalse(TerminalAvailability.supportsTerminal(member))
        }
    }

    func testWakeWaitsForBothLivePaneAndAwakeStatusAndRejectsDuplicate() async throws {
        let wake = TerminalWake()
        var member = sleeping(), resumes = 0
        let task = Task {
            await wake.wake(memberID: member.id, timeout: .seconds(2), resume: { resumes += 1; return nil }, current: { member }, allowed: { true })
        }
        try await eventually { resumes == 1 }
        let duplicate = await wake.wake(memberID: member.id, resume: { resumes += 1; return nil }, current: { member }, allowed: { true })
        XCTAssertEqual(duplicate, .duplicate); XCTAssertEqual(resumes, 1)
        member.paneId = "pane"
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertTrue(wake.members.contains(member.id), "A pane while asleep must not open")
        member.paneId = nil; member.status = "idle"
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertTrue(wake.members.contains(member.id), "An awake status without a pane must not open")
        member.paneId = "pane"
        let result = await task.value
        XCTAssertEqual(result, .ready); XCTAssertTrue(wake.members.isEmpty)
    }

    func testWakeFailureAndTimeoutHaveKoreanMessages() async {
        let wake = TerminalWake(), member = sleeping()
        let failed = await wake.wake(memberID: member.id, resume: { "No core terminal for member" }, current: { member }, allowed: { true })
        XCTAssertEqual(failed.message, "깨우지 못했습니다: 이 직원은 잠들어 있어 터미널이 없습니다")
        let timeout = await wake.wake(memberID: member.id, timeout: .milliseconds(30), resume: { nil }, current: { member }, allowed: { true })
        XCTAssertEqual(timeout, .timedOut)
        XCTAssertEqual(timeout.message, "깨우는 데 시간이 걸립니다. 잠시 뒤 다시 여세요")
        XCTAssertTrue(wake.members.isEmpty)
    }

    func testDeadlineIncludesAnUnresponsiveResumeAndIgnoresItsLateSuccess() async throws {
        let wake = TerminalWake(), member = sleeping()
        var reply: CheckedContinuation<String?, Never>?
        let task = Task {
            await wake.wake(memberID: member.id, timeout: .milliseconds(50), resume: {
                await withCheckedContinuation { reply = $0 }
            }, current: { member }, allowed: { true })
        }
        try await eventually { reply != nil }
        let result = await task.value
        XCTAssertEqual(result, .timedOut); XCTAssertTrue(wake.members.isEmpty)
        reply?.resume(returning: nil)
        await Task.yield()
        XCTAssertTrue(wake.members.isEmpty)
    }

    func testLiveTerminalOpensEvenWhenResumeReplyIsDelayed() async throws {
        let wake = TerminalWake()
        var member = sleeping()
        var reply: CheckedContinuation<String?, Never>?
        let task = Task {
            await wake.wake(memberID: member.id, timeout: .seconds(2), resume: {
                await withCheckedContinuation { reply = $0 }
            }, current: { member }, allowed: { true })
        }
        try await eventually { reply != nil }
        member.status = "idle"; member.paneId = "pane"
        let result = await task.value
        XCTAssertEqual(result, .ready)
        reply?.resume(returning: "늦게 도착한 실패")
        await Task.yield()
        XCTAssertTrue(wake.members.isEmpty)
    }

    func testLosingWriteAccessWhileWaitingFailsWithoutOpening() async {
        let wake = TerminalWake(), member = sleeping()
        let result = await wake.wake(memberID: member.id, resume: { nil }, current: { member }, allowed: { false })
        XCTAssertEqual(result.message, "깨우지 못했습니다: 서버 연결 또는 프로젝트 상태를 확인해 주세요")
    }

    func testRouterPostsResumeOnceAndOpensOnlyAfterSnapshotSuppliesTerminal() async throws {
        let server = WriteTestServer(), member = sleeping()
        server.change { $0.state.members = [member] }
        let network = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/members/m/resume" { return try server.reply(server.read { $0.state.members[0] }) }
            return try server.handle(request)
        }
        let store = await connect(network), router = Router()
        defer { store.disconnect() }
        router.openTerminal(member, store: store)
        try await eventually { network.requests.contains { $0.url?.path.hasSuffix("/resume") == true } }
        XCTAssertNil(router.terminalMemberID); XCTAssertFalse(store.canOpenTerminal(member))
        router.openTerminal(member, store: store)
        server.change { $0.state.members[0].status = "idle"; $0.state.members[0].paneId = "pane" }
        await store.refresh()
        try await eventually { router.terminalMemberID == member.id }
        XCTAssertEqual(store.members[0].sessionId, "same-session")
        let requests = network.requests.filter { $0.url?.path.hasSuffix("/resume") == true }
        XCTAssertEqual(requests.count, 1); XCTAssertEqual(requests.first?.httpMethod, "POST")
        XCTAssertFalse(network.requests.contains { $0.url?.path.hasSuffix("/fresh-session") == true })
    }

    func testStoreWakeFailureAndTimeoutUseSharedErrorBanner() async throws {
        for fails in [true, false] {
            let server = WriteTestServer(), member = sleeping()
            server.change { $0.state.members = [member] }
            let network = try IsolatedTestNetwork { request in
                if request.url?.path.hasSuffix("/resume") == true {
                    if fails { return IsolatedTestHTTPReply(status: 422, data: Data(#"{"error":"실행이 꺼져 있습니다"}"#.utf8)) }
                    return try server.reply(member)
                }
                return try server.handle(request)
            }
            let store = await connect(network)
            let result = await store.wakeTerminal(member, timeout: .milliseconds(100))
            XCTAssertFalse(result)
            XCTAssertEqual(store.errorMessage, fails ? "깨우지 못했습니다: 실행이 꺼져 있습니다" : "깨우는 데 시간이 걸립니다. 잠시 뒤 다시 여세요")
            XCTAssertTrue(store.terminalWake.members.isEmpty)
            store.disconnect()
        }
    }

    func testArchiveDemoAndDisconnectedCannotWake() async throws {
        let server = WriteTestServer(), member = sleeping()
        server.change { $0.state.members = [member] }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        server.change { $0.state.project.archived = true }
        await store.selectArchivedProject(id: "p")
        XCTAssertTrue(store.isArchive)
        XCTAssertFalse(store.canOpenTerminal(member))
        let archived = await store.wakeTerminal(member)
        XCTAssertFalse(archived)
        store.disconnect()
        XCTAssertFalse(store.canOpenTerminal(member))
        let disconnected = await store.wakeTerminal(member)
        XCTAssertFalse(disconnected)
        let demo = AppStore(demo: true, session: network.session, persistCredentials: false)
        XCTAssertFalse(demo.canOpenTerminal(member))
        let sample = await demo.wakeTerminal(member)
        XCTAssertFalse(sample)
        XCTAssertFalse(network.requests.contains { $0.url?.path.hasSuffix("/resume") == true })
    }

    func testOpenSessionStopsWhenMemberSleepsAndReconnectsInSameSessionOnBothPlatforms() async throws {
        for platform in [TerminalPlatform.mac, .iPhone] {
            let server = WriteTestServer()
            var member = sleeping("idle"); member.paneId = "pane"
            server.change { $0.state.members = [member] }
            let network = try IsolatedTestNetwork { request in
                if request.url?.path.hasSuffix("/resume") == true { return try server.reply(server.read { $0.state.members[0] }) }
                return try server.handle(request)
            }
            let store = await connect(network)
            var connections = 0
            let session = TerminalSession(platform: platform) { _, _, _, _, _, _, _ in connections += 1 }
            session.sizeChanged(cols: 100, rows: 30)
            session.appear(store: store, member: member, active: true)
            try await eventually { connections == 1 }
            session.client.accept(.ready(mode: platform.openingMode, cols: 100, rows: 30, expiresAt: nil))
            server.change { $0.state.members[0].status = "asleep"; $0.state.members[0].paneId = nil }
            await store.refresh()
            session.memberChanged(store: store, member: store.members[0])
            try await eventually { !session.ending }
            XCTAssertTrue(session.missingTerminal); XCTAssertFalse(session.controlling)
            session.beginInput(store: store, member: member)
            XCTAssertEqual(connections, 1, "A stale view snapshot must not attach a missing terminal")
            let wake = Task { await store.wakeTerminal(store.members[0]) }
            try await eventually { network.requests.contains { $0.url?.path.hasSuffix("/resume") == true } }
            server.change { $0.state.members[0].status = "idle"; $0.state.members[0].paneId = "new-pane" }
            await store.refresh()
            let woke = await wake.value
            XCTAssertTrue(woke)
            session.memberChanged(store: store, member: store.members[0])
            try await eventually { connections == 2 }
            XCTAssertFalse(session.missingTerminal); XCTAssertEqual(store.members[0].sessionId, "same-session")
            session.disappear(store: store, member: member)
            try await eventually { store.terminalLeases[member.id] == nil }
            store.disconnect()
        }
    }

    func testDisplayTranslationPreservesRawErrorsAndLeaseGoneDecisions() async throws {
        let translations = [
            ("No core terminal for member", "이 직원은 잠들어 있어 터미널이 없습니다"),
            ("Terminal has finished", "터미널이 종료되었습니다"),
            ("A matching active terminal control lease is required", "직접 조작 시간이 끝났습니다. 다시 시작하세요"),
            ("Another terminal control lease is active", "다른 기기에서 터미널을 조작하고 있습니다")
        ]
        for (raw, translated) in translations {
            let error = APIError(status: 409, message: raw)
            XCTAssertEqual(TerminalPresentation.message(error.message), translated)
            XCTAssertEqual(error.message, raw); XCTAssertEqual(error.localizedDescription, raw)
            let server = WriteTestServer()
            let network = try IsolatedTestNetwork { request in
                if request.url?.path == "/api/capabilities" { return IsolatedTestHTTPReply(status: 404) }
                if request.url?.path.hasSuffix("/terminal/control") == true {
                    let body = try WriteTestServer.body(request)
                    if body["action"] as? String == "claim" { return IsolatedTestHTTPReply(data: Data(#"{"leaseId":"lease"}"#.utf8)) }
                    return IsolatedTestHTTPReply(status: 409, data: try JSONSerialization.data(withJSONObject: ["error": raw]))
                }
                return try server.handle(request)
            }
            let store = await connect(network), member = Member(id: "m", projectId: "p")
            let claimed = await store.claimTerminal(member)
            XCTAssertTrue(claimed)
            let entered = await store.terminalInput(member, text: "x")
            XCTAssertFalse(entered); XCTAssertNil(store.terminalLeases[member.id], "leaseGone must still match the original English error")
            XCTAssertEqual(store.errorMessage, translated)
            XCTAssertEqual(store.rawErrorMessage, raw)
            store.disconnect()
        }
    }

    func testMissingTerminalStreamIsHandledBeforeSnapshotCatchesUpWithoutReconnectLoop() async throws {
        let server = WriteTestServer()
        var member = sleeping("idle"); member.paneId = "old-pane"
        server.change { $0.state.members = [member] }
        let network = try IsolatedTestNetwork(handler: server.handle), store = await connect(network)
        var connections = 0
        let session = TerminalSession(platform: .iPhone) { _, _, _, _, _, _, _ in connections += 1 }
        session.appear(store: store, member: member, active: true)
        let raw = "No core terminal for member"
        session.client.accept(.closed(reason: "finished", message: raw))
        XCTAssertEqual(session.client.state, .closed(reason: "finished", message: raw))
        session.streamChanged(store: store, member: member)
        try await eventually { !session.ending }
        XCTAssertTrue(session.missingTerminal); XCTAssertEqual(connections, 1)
        server.change { $0.state.members[0].status = "asleep"; $0.state.members[0].paneId = nil }
        await store.refresh()
        session.memberChanged(store: store, member: store.members[0])
        server.change { $0.state.members[0].status = "idle"; $0.state.members[0].paneId = "new-pane" }
        await store.refresh()
        session.memberChanged(store: store, member: store.members[0])
        XCTAssertFalse(session.missingTerminal); XCTAssertEqual(connections, 2)
        session.disappear(store: store, member: member); store.disconnect()
    }

    func testRefusedReceiptKeepsEnglishReasonWhileSessionAndBannerDisplayKorean() async throws {
        let server = WriteTestServer(), raw = "Another terminal control lease is active"
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasSuffix("/terminal/control") == true {
                let body = try WriteTestServer.body(request)
                let receipt = OperationReceipt(operationId: body["operationId"] as! String, kind: .terminalControl,
                                               memberId: "m", status: .refused, error: raw)
                return try server.reply(receipt)
            }
            return try server.handle(request)
        }
        let store = await connect(network), member = store.members[0]
        var observed = false
        let session = TerminalSession(platform: .mac) { _, _, mode, _, _, _, _ in observed = mode == .observe }
        session.appear(store: store, member: member, active: true)
        try await eventually { observed }
        XCTAssertEqual(session.notice, "다른 기기에서 터미널을 조작하고 있습니다")
        XCTAssertEqual(store.errorMessage, "다른 기기에서 터미널을 조작하고 있습니다")
        XCTAssertEqual(store.operationResults.values.first?.error, raw)
        session.disappear(store: store, member: member); store.disconnect()
    }
}
