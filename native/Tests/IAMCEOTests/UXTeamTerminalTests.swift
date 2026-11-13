import Foundation
import SwiftUI
import XCTest
@testable import IAMCEO

@MainActor private final class WakePolls { var count = 0 }

@MainActor final class UXTeamTerminalTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }

    // 공용 pollUntil(TestSupport)을 부르는 얇은 껍데기. 기한은 느린 CI 러너에 맞춘 공용 기본값(10초)을 쓴다.
    private func eventually(timeout: Duration = .seconds(10), _ predicate: () -> Bool,
                            file: StaticString = #filePath, line: UInt = #line) async throws {
        await pollUntil("Expected terminal state was not reached", timeout: timeout, every: .milliseconds(10), file: file, line: line) { predicate() }
    }

    func testOpeningObservesWithoutLeaseOrKeyboardAndOnlyExplicitInputClaims() async throws {
        for platform in [TerminalPlatform.mac, .iPhone] {
            let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
            let store = await connect(network), member = try XCTUnwrap(store.members.first)
            var modes: [TerminalStreamMode] = []
            let session = TerminalSession(platform: platform) { _, _, mode, _, _, lease, _ in
                modes.append(mode)
                if mode == .observe { XCTAssertNil(lease) }
            }
            session.appear(store: store, member: member, active: true)
            XCTAssertEqual(modes, [.observe]); XCTAssertTrue(session.readOnly)
            XCTAssertFalse(platform.acceptsKeyboard(mode: session.surfaceMode))
            XCTAssertTrue(server.read { $0.terminalBodies.isEmpty })
            XCTAssertNil(session.ownedLeaseID)
            session.pendingInput(Data("viewing cannot type".utf8))
            XCTAssertTrue(server.read { $0.terminalBodies.isEmpty })
            session.sizeChanged(cols: 65, rows: 25)
            session.beginInput(store: store, member: member)
            try await eventually { modes.last == .control }
            session.client.accept(.ready(mode: .control, cols: 65, rows: 25, expiresAt: nil))
            XCTAssertTrue(session.controlling)
            await session.finishInput(store: store, member: member, resume: true)
            XCTAssertEqual(modes, [.observe, .control, .observe])
            XCTAssertFalse(session.controlling); XCTAssertEqual(session.surfaceMode, .observe)
            XCTAssertNil(store.terminalLeases[member.id])
            XCTAssertEqual(server.read { $0.terminalBodies.compactMap { $0["action"] as? String } }, ["claim", "release"])
            session.disappear(store: store, member: member); store.disconnect()
        }
    }

    func testMissingTerminalRefusalIsLocalAfterExplicitInput() async throws {
        let server = WriteTestServer(), raw = "No core terminal for member"
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasSuffix("/terminal/control") == true {
                let body = try WriteTestServer.body(request)
                return try server.reply(OperationReceipt(operationId: body["operationId"] as! String, kind: .terminalControl,
                                                        memberId: "m", status: .refused, error: raw))
            }
            return try server.handle(request)
        }
        let store = await connect(network), member = store.members[0]
        let session = TerminalSession(platform: .mac) { _, _, _, _, _, _, _ in }
        session.appear(store: store, member: member, active: true)
        XCTAssertFalse(session.missingTerminal); XCTAssertTrue(store.operationResults.isEmpty)
        session.beginInput(store: store, member: member)
        try await eventually { session.missingTerminal && !session.ending }
        XCTAssertNil(store.errorMessage)
        XCTAssertEqual(store.operationResults.values.first?.error, raw)
        XCTAssertEqual(store.terminalWindowNotice(memberID: member.id), raw)
        session.disappear(store: store, member: member); store.disconnect()
    }

    func testBriefMacDeactivationKeepsInputWithoutTakingAnotherLease() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network), member = try XCTUnwrap(store.members.first)
        var modes: [TerminalStreamMode] = []
        let session = TerminalSession(platform: .mac) { _, _, mode, _, _, _, _ in modes.append(mode) }
        session.appear(store: store, member: member, active: true)
        session.sizeChanged(cols: 100, rows: 30); session.beginInput(store: store, member: member)
        try await eventually { modes.last == .control }
        session.client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        session.setActive(false, store: store, member: member)
        await Task.yield()
        XCTAssertTrue(session.controlling); XCTAssertNotNil(store.terminalLeases[member.id])
        session.setActive(true, store: store, member: member)
        XCTAssertEqual(modes, [.observe, .control])
        XCTAssertFalse(session.readOnly)
        XCTAssertEqual(server.read { $0.terminalBodies.compactMap { $0["action"] as? String } }, ["claim"])
        session.disappear(store: store, member: member); store.disconnect()
    }

    func testSlowWakeBeyondFormerTwentySecondCutoffContinuesWhenPaneArrives() async throws {
        // 21초를 실제로 기다리지 않는다. 50ms 간격의 준비 확인이 420번(=21초) 넘게 돈 뒤에도 기다리고 있는지 본다.
        let polls = WakePolls()
        let wake = TerminalWake(pause: { duration in
            XCTAssertEqual(duration, .milliseconds(50))
            polls.count += 1
            await Task.yield()
        })
        var member = Member(id: "m", projectId: "p", backend: "core", status: "asleep")
        var resumes = 0
        let waiting = Task {
            await wake.wake(memberID: member.id, resume: { resumes += 1; return nil }, current: { member }, allowed: { true })
        }
        try await eventually { resumes == 1 }
        try await eventually(timeout: .seconds(10)) { polls.count > 420 }
        XCTAssertTrue(wake.members.contains(member.id))
        let duplicate = await wake.wake(memberID: member.id, resume: { XCTFail("Duplicate resume"); return nil }, current: { member }, allowed: { true })
        XCTAssertEqual(duplicate, .duplicate)
        member.status = "idle"; member.paneId = "ready-pane"
        let result = await waiting.value
        XCTAssertEqual(result, .ready); XCTAssertEqual(resumes, 1)
        XCTAssertTrue(wake.members.isEmpty)
    }

    func testWakeFailureCanRetryAndClosingCancelsWaiting() async throws {
        let wake = TerminalWake(), member = Member(id: "m", projectId: "p", backend: "core", status: "asleep")
        let failed = await wake.wake(memberID: member.id, resume: { "실행 연결을 확인해 주세요" }, current: { member }, allowed: { true })
        XCTAssertEqual(failed, .failed("실행 연결을 확인해 주세요"))
        let retry = Task { await wake.wake(memberID: member.id, resume: { nil }, current: { member }, allowed: { true }) }
        try await eventually { wake.members.contains(member.id) }
        retry.cancel()
        let cancelled = await retry.value
        XCTAssertEqual(cancelled, .cancelled); XCTAssertTrue(wake.members.isEmpty)
    }

    func testDecisionShortcutOnlySelectsAnOpenDecisionForThisEmployee() {
        let decisions = [Decision(id: "answered", memberId: "m", status: "answered"),
                         Decision(id: "other", memberId: "other"), Decision(id: "wanted", memberId: "m")]
        let router = Router(usesPhoneNavigation: false)
        let decision = UXTeamTerminal.openDecision(for: "m", in: decisions)
        XCTAssertEqual(decision?.id, "wanted")
        if let decision { router.openDecision(decision.id) }
        XCTAssertEqual(router.destination, .inbox); XCTAssertEqual(router.decisionID, "wanted")
        XCTAssertNil(UXTeamTerminal.openDecision(for: "missing", in: decisions))
        XCTAssertNil(UXTeamTerminal.openDecision(for: "m", in: Array(decisions.prefix(2))))
    }

    func testReadingZoomNeverShrinksBelowTwelvePointsAndClampsInvalidPreferences() {
        for value in [-1.0, 0, 0.5, 1, 1.5, 3, 100, .nan, .infinity] {
            let font = 12 * TerminalReadingScale.zoom(value)
            XCTAssertGreaterThanOrEqual(font, 12); XCTAssertLessThanOrEqual(font, 36)
        }
        XCTAssertEqual(TerminalReadingScale.zoom(1.75), 1.75)
    }

    func testMemberModelSelectionUsesCatalogAndClearsAnotherProvidersModel() {
        var selection = NewMemberModelSelection()
        XCTAssertTrue(selection.isValid(in: .fallback)); XCTAssertEqual(selection.model, "")
        selection.model = "sonnet"
        XCTAssertTrue(selection.isValid(in: .fallback))
        selection.provider = "claude"
        XCTAssertEqual(selection.model, "sonnet")
        selection.provider = "codex"
        XCTAssertEqual(selection.model, ""); XCTAssertTrue(selection.isValid(in: .fallback))
        selection.model = ModelCatalog.fallback.codex.models[0].value
        XCTAssertTrue(selection.isValid(in: .fallback))
        selection.model = "removed-model"
        XCTAssertFalse(selection.isValid(in: .fallback))
    }

    #if os(macOS)
    /// 열려 있는 활동 목록은 store가 한 번 읽고 따라간다(실시간이 없는 이 시험 환경에서는 주기적인 전체 읽기가 함께 읽는다).
    /// 화면에서 사라지면 더 읽지 않는다. 예전에는 뷰가 실제 시간 3초마다 직접 읽었고, 앱이 뒤에 있어도 멈추지 않았다.
    func testActivityListRefreshesWhileOpenAndStopsAfterRemoval() async throws {
        let server = WriteTestServer(), clock = CoordinatorClock()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasSuffix("/activity") == true {
                return IsolatedTestHTTPReply(data: Data(#"[{"id":3,"memberId":"m","text":"read"}]"#.utf8))
            }
            return try server.handle(request)
        }
        let store = AppStore(session: network.session, persistCredentials: false, clock: clock, retryJitter: { $0 })
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect()
        let member = try XCTUnwrap(store.members.first)
        func reads() -> Int { network.requests.filter { $0.url?.path.hasSuffix("/activity") == true }.count }
        func syncs() -> Int { network.requests.filter { $0.url?.path == "/api/sync" }.count }
        let host = NSHostingView(rootView: AnyView(ActivityList(memberID: member.id).environment(store)))
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 500, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { window.close(); store.disconnect() }
        // SwiftUI starts .task when the view appears. Laying out an invisible
        // NSHostingView alone does not establish that lifecycle on macOS.
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        try await eventually { store.activities[member.id]?.map(\.id) == [3] }
        XCTAssertEqual(reads(), 1)
        // 3초 주기 읽기가 다시 가짜 시계에 잠든 뒤에 민다. 앞 읽기가 끝나기 전에 밀면 그 대기는 민 시각부터 다시 세어
        // 이번 밀기로 깨지 않는다(느린 CI 러너에서 흔들림). 아래 두 곳도 같다.
        await pollUntil("주기 읽기가 시계에 잠듦") { await clock.hasSleeper(dueWithin: .seconds(3)) }
        await clock.advance(.seconds(3))
        try await eventually { reads() == 2 }
        host.rootView = AnyView(EmptyView()); host.layoutSubtreeIfNeeded()
        try await eventually { store.activities[member.id] == nil }
        let before = syncs()
        await pollUntil("주기 읽기가 시계에 잠듦") { await clock.hasSleeper(dueWithin: .seconds(3)) }
        await clock.advance(.seconds(3))
        try await eventually { syncs() > before }
        await pollUntil("주기 읽기가 시계에 잠듦") { await clock.hasSleeper(dueWithin: .seconds(3)) }
        await clock.advance(.seconds(3))
        try await eventually { syncs() > before + 1 }
        XCTAssertEqual(reads(), 2, "A list that left the screen is not read again")
    }
    #endif
}
