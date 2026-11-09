import Foundation
import SwiftUI
import XCTest
@testable import IAMCEO

@MainActor final class UXTeamTerminalTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }

    private func eventually(timeout: Duration = .seconds(3), _ predicate: () -> Bool,
                            file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(predicate(), "Expected terminal state was not reached", file: file, line: line)
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

    func testForegroundReturnsToViewingWithoutTakingAnotherLease() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network), member = try XCTUnwrap(store.members.first)
        var modes: [TerminalStreamMode] = []
        let session = TerminalSession(platform: .mac) { _, _, mode, _, _, _, _ in modes.append(mode) }
        session.appear(store: store, member: member, active: true)
        session.sizeChanged(cols: 100, rows: 30); session.beginInput(store: store, member: member)
        try await eventually { modes.last == .control }
        session.client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        session.setActive(false, store: store, member: member)
        try await eventually { !session.ending && store.terminalLeases[member.id] == nil }
        session.setActive(true, store: store, member: member)
        XCTAssertEqual(modes.last, .observe)
        XCTAssertTrue(session.readOnly)
        XCTAssertEqual(server.read { $0.terminalBodies.compactMap { $0["action"] as? String } }, ["claim", "release"])
        session.disappear(store: store, member: member); store.disconnect()
    }

    func testSlowWakeBeyondFormerTwentySecondCutoffContinuesWhenPaneArrives() async throws {
        let wake = TerminalWake()
        var member = Member(id: "m", projectId: "p", backend: "core", status: "asleep")
        var resumes = 0
        let waiting = Task {
            await wake.wake(memberID: member.id, resume: { resumes += 1; return nil }, current: { member }, allowed: { true })
        }
        try await eventually { resumes == 1 }
        try await Task.sleep(for: .seconds(21))
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
    func testActivityListRefreshesWhileOpenAndStopsAfterRemoval() async throws {
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasSuffix("/activity") == true {
                return IsolatedTestHTTPReply(data: Data("[]".utf8))
            }
            return try server.handle(request)
        }
        let store = await connect(network), member = try XCTUnwrap(store.members.first)
        let host = NSHostingView(rootView: AnyView(ActivityList(memberID: member.id).environment(store)))
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 500, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { window.close(); store.disconnect() }
        // SwiftUI starts .task when the view appears. Laying out an invisible
        // NSHostingView alone does not establish that lifecycle on macOS.
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        try await eventually { network.requests.contains { $0.url?.path.hasSuffix("/activity") == true } }
        try await eventually(timeout: .seconds(8)) {
            network.requests.filter { $0.url?.path.hasSuffix("/activity") == true }.count >= 2
        }
        let reads = network.requests.filter { $0.url?.path.hasSuffix("/activity") == true }.count
        XCTAssertGreaterThanOrEqual(reads, 2)
        host.rootView = AnyView(EmptyView()); host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(3300))
        XCTAssertEqual(network.requests.filter { $0.url?.path.hasSuffix("/activity") == true }.count, reads)
    }
    #endif
}
