import Foundation
import XCTest
import SwiftUI
@testable import IAMCEO

@MainActor final class TerminalSessionTests: XCTestCase {
    /// Existing claim/fence scenarios start with an explicit human input request.
    /// Their connect spy ignores the initial observe attachment; opening is covered separately in UXTeamTerminalTests.
    private func controlSession(platform: TerminalPlatform, client: TerminalStreamClient = TerminalStreamClient(),
                                connect: @escaping TerminalSession.Connect, send: ((Data) -> Void)? = nil) -> TerminalSession {
        var opened = false
        return TerminalSession(platform: platform, client: client, connect: { api, id, mode, cols, rows, lease, policy in
            if !opened, mode == .observe { opened = true; return }
            connect(api, id, mode, cols, rows, lease, policy)
        }, send: send)
    }

    private func connectedStore(_ network: IsolatedTestNetwork, submissions: SubmissionStore? = nil, journal: URL? = nil) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, submissions: submissions, writeStorageURL: journal)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }

    func testObserveTypingClaimsThroughSurfaceAndReplaysABOnceReady() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        var modes: [TerminalStreamMode] = [], sent: [Data] = []
        let session = TerminalSession(platform: .mac, connect: { _, _, mode, _, _, _, _ in modes.append(mode) }, send: { sent.append($0) })
        session.appear(store: store, member: member, active: true)
        session.client.accept(.ready(mode: .observe, cols: 100, rows: 30, expiresAt: nil))
        session.sizeChanged(cols: 100, rows: 30)
        let parent = TerminalRepresentable(client: session.client, mode: .observe, cols: 100, rows: 30,
            following: .constant(true), onPendingInput: { session.pendingInput($0) }, onSize: { _, _ in },
            onRequestInput: { session.requestInput($0, store: store, member: member) })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 500), coordinator: coordinator)
        coordinator.host = host
        coordinator.send(source: host.terminal, data: Array("a".utf8)[...])
        coordinator.send(source: host.terminal, data: Array("b".utf8)[...])
        XCTAssertTrue(session.starting); XCTAssertTrue(sent.isEmpty)
        try await waitWhile { modes.last != .control }
        XCTAssertEqual(modes, [.observe, .control])
        XCTAssertEqual(server.read { $0.terminalBodies.compactMap { $0["action"] as? String } }, ["claim"])
        session.client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        XCTAssertEqual(sent, [Data("ab".utf8)])
        session.client.onReady?(.control)
        XCTAssertEqual(sent, [Data("ab".utf8)])
        host.teardown(); session.disappear(store: store, member: member); store.disconnect()
    }

    func testMacInactiveGraceKeepsLeaseUntilThreeMinutesAndShowsStatus() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        var modes: [TerminalStreamMode] = []
        let session = TerminalSession(platform: .mac, connect: { _, _, mode, _, _, _, _ in modes.append(mode) })
        session.appear(store: store, member: member, active: true); session.sizeChanged(cols: 100, rows: 30)
        session.beginInput(store: store, member: member)
        try await waitWhile { modes.last != .control }
        session.client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        let now = Date()
        session.setActive(false, store: store, member: member, now: now)
        session.endInputIfInactive(store: store, member: member, now: now.addingTimeInterval(179.999))
        XCTAssertTrue(session.controlling); XCTAssertNotNil(session.ownedLeaseID)
        XCTAssertEqual(modes, [.observe, .control])
        session.setActive(true, store: store, member: member)
        session.endInputIfInactive(store: store, member: member, now: now.addingTimeInterval(200))
        XCTAssertTrue(session.controlling, "Returning cancels the inactivity timer")
        session.setActive(false, store: store, member: member, now: now)
        session.setActive(false, store: store, member: member, now: now.addingTimeInterval(100))
        session.endInputIfInactive(store: store, member: member, now: now.addingTimeInterval(180))
        try await waitWhile { session.controlling || session.ending || session.ownedLeaseID != nil }
        XCTAssertTrue(session.readOnly)
        XCTAssertEqual(session.inputEndedStatus, "자리를 비운 사이 입력을 끝냈습니다 · 클릭하면 다시 시작합니다")
        XCTAssertEqual(server.read { $0.terminalBodies.compactMap { $0["action"] as? String } }, ["claim", "release"])
        session.setActive(true, store: store, member: member)
        XCTAssertEqual(modes.last, .observe)
        session.disappear(store: store, member: member); store.disconnect()
    }

    /// n-term-2: 화면을 클릭만 하고 아무것도 치지 않은 조작권은 자리를 뜨면 곧 놓는다(3분이 아니라 10초).
    /// 그동안 스크롤·클릭만으로는 조작권을 연장하지 않는다. 한 글자라도 치면 예전 그대로다.
    func testClickOnlyClaimIsReleasedSoonAfterLeavingAndTypingRestoresTheLongGrace() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        var modes: [TerminalStreamMode] = [], frames: [String] = []
        let client = TerminalStreamClient(messageSender: { message in
            if case .string(let text) = message { frames.append(text) } else { frames.append("data") }
        })
        let session = TerminalSession(platform: .mac, client: client, connect: { _, _, mode, _, _, _, _ in modes.append(mode) })
        session.appear(store: store, member: member, active: true); session.sizeChanged(cols: 100, rows: 30)
        session.requestInput(Data(), store: store, member: member) // a click on the read-only screen
        try await waitWhile { modes.last != .control }
        client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        XCTAssertTrue(session.controlling)
        client.activity(windowIsKey: true)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertTrue(frames.isEmpty, "Mouse and scroll alone do not extend a lease taken by one click")
        let now = Date()
        session.setActive(false, store: store, member: member, now: now)
        session.endInputIfInactive(store: store, member: member, now: now.addingTimeInterval(9.9))
        XCTAssertTrue(session.controlling)
        session.endInputIfInactive(store: store, member: member, now: now.addingTimeInterval(10))
        try await waitWhile { session.controlling || session.ending || session.ownedLeaseID != nil }
        XCTAssertEqual(server.read { $0.terminalBodies.compactMap { $0["action"] as? String } }, ["claim", "release"])
        XCTAssertEqual(session.inputEndedStatus, TerminalPresentation.inactiveStatus)
        // n-term-6: only the input ends. The window keeps showing the terminal read-only.
        XCTAssertEqual(modes.last, .observe); XCTAssertTrue(session.readOnly)
        // The same click, followed by typing, is a real input session: three minutes as before, and activity renews it.
        client.accept(.ready(mode: .observe, cols: 100, rows: 30, expiresAt: nil))
        session.requestInput(Data(), store: store, member: member)
        try await waitWhile { modes.last != .control }
        client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        session.requestInput(Data("a".utf8), store: store, member: member)
        try await waitWhile { !frames.contains("data") }
        client.activity(windowIsKey: true)
        try await waitWhile { !frames.contains(#"{"type":"activity"}"#) }
        session.setActive(false, store: store, member: member, now: now)
        session.endInputIfInactive(store: store, member: member, now: now.addingTimeInterval(179.9))
        XCTAssertTrue(session.controlling)
        session.endInputIfInactive(store: store, member: member, now: now.addingTimeInterval(180))
        try await waitWhile { session.controlling || session.ending || session.ownedLeaseID != nil }
        XCTAssertEqual(server.read { $0.terminalBodies.compactMap { $0["action"] as? String } }, ["claim", "release", "claim", "release"])
        session.disappear(store: store, member: member); store.disconnect()
    }

    #if os(macOS)
    /// n-term-2: 터미널 창이 key를 잃는 것도 '자리를 뜬 것'이다. 다만 클릭만으로 잡은 조작권에만 적용한다.
    func testWindowLosingKeyStartsTheShortGraceOnlyForAClickOnlyClaim() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        var modes: [TerminalStreamMode] = []
        let session = TerminalSession(platform: .mac, connect: { _, _, mode, _, _, _, _ in modes.append(mode) })
        session.appear(store: store, member: member, active: true); session.sizeChanged(cols: 100, rows: 30)
        session.beginInput(store: store, member: member) // the 입력 시작 button
        try await waitWhile { modes.last != .control }
        session.client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        session.windowKeyChanged(false, store: store, member: member)
        session.endInputIfInactive(store: store, member: member, now: Date().addingTimeInterval(170))
        XCTAssertTrue(session.controlling, "An explicit input session is not ended by another window taking focus")
        await session.finishInput(store: store, member: member, resume: true)
        session.client.accept(.ready(mode: .observe, cols: 100, rows: 30, expiresAt: nil))
        session.requestInput(Data(), store: store, member: member) // a click
        try await waitWhile { modes.last != .control }
        session.client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        session.windowKeyChanged(false, store: store, member: member)
        session.windowKeyChanged(true, store: store, member: member) // back at once: the grace is cancelled
        session.endInputIfInactive(store: store, member: member, now: Date().addingTimeInterval(60))
        XCTAssertTrue(session.controlling)
        session.windowKeyChanged(false, store: store, member: member)
        session.endInputIfInactive(store: store, member: member, now: Date().addingTimeInterval(11))
        try await waitWhile { session.controlling || session.ending || session.ownedLeaseID != nil }
        XCTAssertEqual(server.read { $0.terminalBodies.compactMap { $0["action"] as? String } }, ["claim", "release", "claim", "release"])
        session.disappear(store: store, member: member); store.disconnect()
    }
    #endif

    /// n-term-4: 메인 창이 다른 프로젝트를 보는 동안에는 조작권을 요청하지 않는다. 보기 연결을 끊었다 다시 붙이지도 않는다.
    func testInputForAMemberOutsideTheSelectedProjectIsExplainedWithoutClaimingOrReconnecting() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network)
        let other = Member(id: "elsewhere", projectId: "q", backend: "core", status: "idle", paneId: "pane")
        var modes: [TerminalStreamMode] = []
        let session = TerminalSession(platform: .mac, connect: { _, _, mode, _, _, _, _ in modes.append(mode) })
        session.appear(store: store, member: other, active: true)
        XCTAssertEqual(modes, [.observe])
        XCTAssertFalse(TerminalSession.canControl(other, in: store))
        session.requestInput(Data("a".utf8), store: store, member: other)
        session.requestInput(Data("b".utf8), store: store, member: other)
        XCTAssertEqual(session.notice, "메인 창이 다른 프로젝트를 보고 있어 입력할 수 없습니다. 이 팀원의 프로젝트로 돌아온 뒤 다시 시도하세요.")
        XCTAssertFalse(session.starting); XCTAssertTrue(session.readOnly)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(modes, [.observe], "The viewer is left alone")
        XCTAssertTrue(server.read { $0.terminalBodies.isEmpty })
        session.disappear(store: store, member: other); store.disconnect()
    }

    /// n-term-6: 잠자기 뒤처럼 active가 꺼진 채 남아도 '다시 연결'·'입력 시작' 버튼은 반응한다.
    func testButtonsRespondAfterTheSessionWasLeftInactive() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        var modes: [TerminalStreamMode] = []
        let session = TerminalSession(platform: .mac, connect: { _, _, mode, _, _, _, _ in modes.append(mode) })
        session.appear(store: store, member: member, active: true); session.sizeChanged(cols: 100, rows: 30)
        // The Mac went to sleep. Let the queued end-of-input run before pressing anything.
        func sleepMac() async throws {
            session.setActive(false, store: store, member: member, immediately: true)
            for _ in 0..<30 { await Task.yield() }
            try await waitWhile { session.ending }
        }
        try await sleepMac()
        session.observe(store: store, member: member)
        XCTAssertEqual(modes, [.observe], "The bare call is ignored while inactive")
        session.userReconnect(store: store, member: member)
        XCTAssertEqual(modes, [.observe, .observe])
        try await sleepMac()
        session.userBeginInput(store: store, member: member)
        try await waitWhile { modes.last != .control }
        XCTAssertEqual(server.read { $0.terminalBodies.compactMap { $0["action"] as? String } }, ["claim"])
        session.disappear(store: store, member: member); store.disconnect()
    }

    func testFailedControlRetryReleasesLeaseAndShowsReadOnlyReconnectStatus() async throws {
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasSuffix("/terminal/stream") == true { return IsolatedTestHTTPReply(status: 503) }
            return try server.handle(request)
        }
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        var receives = 0, leases: [String] = []
        let client = TerminalStreamClient(session: network.session, receiveMessage: { request in
            receives += 1
            leases.append(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "lease" }?.value ?? "")
            if receives == 1 || receives == 3 { return .string(#"{"type":"ready","mode":"control","cols":100,"rows":30}"#) }
            throw URLError(.networkConnectionLost)
        })
        let fallback = expectation(description: "released then observing")
        let session = controlSession(platform: .mac, client: client) { api, id, mode, cols, rows, lease, policy in
            if mode == .control {
                client.connect(api: api, memberID: id, mode: mode, cols: cols, rows: rows, leaseID: lease, sizePolicy: policy)
            } else {
                XCTAssertNil(store.terminalLeases[member.id]); fallback.fulfill()
            }
        }
        session.appear(store: store, member: member, active: true); session.sizeChanged(cols: 100, rows: 30)
        session.beginInput(store: store, member: member)
        await fulfillment(of: [fallback], timeout: 3)
        XCTAssertEqual(receives, 4); XCTAssertEqual(leases, Array(repeating: "lease", count: 4))
        XCTAssertTrue(session.readOnly); XCTAssertFalse(session.controlling); XCTAssertNil(session.ownedLeaseID)
        XCTAssertEqual(session.inputEndedStatus, "연결이 끊겨 입력을 끝냈습니다 · 클릭하면 다시 시작합니다")
        XCTAssertEqual(server.read { $0.terminalBodies.compactMap { $0["action"] as? String } }, ["claim", "release"])
        session.disappear(store: store, member: member); store.disconnect()
    }

    func testReadOnlyInactivityDoesNotPreventImmediateBackgroundClose() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let session = TerminalSession(platform: .mac, connect: { _, _, _, _, _, _, _ in })
        session.appear(store: store, member: member, active: true)
        session.client.accept(.ready(mode: .observe, cols: 100, rows: 30, expiresAt: nil))
        let now = Date()
        session.setActive(false, store: store, member: member, now: now)
        session.endInputIfInactive(store: store, member: member, now: now.addingTimeInterval(180))
        XCTAssertNil(session.inputEndedStatus)
        session.setActive(false, store: store, member: member, immediately: true)
        // 닫기는 작업으로 돈다. 정해진 양보 횟수 대신 실제로 닫힐 때까지 기다린다(느린 CI 러너).
        await pollUntil("보기 연결이 닫힘") { session.client.state == .closed(reason: "client_closed", message: nil) }
        XCTAssertEqual(session.client.state, .closed(reason: "client_closed", message: nil))
        session.disappear(store: store, member: member); store.disconnect()
    }

    func testMacBackgroundEndsImmediatelyWithoutGrace() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        var attached = false
        let session = controlSession(platform: .mac) { _, _, mode, _, _, _, _ in attached = mode == .control }
        session.appear(store: store, member: member, active: true); session.sizeChanged(cols: 100, rows: 30)
        session.beginInput(store: store, member: member)
        try await waitWhile { !attached }
        session.client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        session.setActive(false, store: store, member: member, immediately: true)
        try await waitWhile { session.controlling || session.ending || session.ownedLeaseID != nil }
        XCTAssertTrue(session.readOnly); XCTAssertNil(session.ownedLeaseID)
        session.disappear(store: store, member: member); store.disconnect()
    }

    func testMacExplicitInputClaimsAndAttachesControlAtNaturalSize() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let attached = expectation(description: "control attach")
        var modes: [TerminalStreamMode] = []
        let session = controlSession(platform: .mac) { _, id, mode, cols, rows, lease, policy in
            modes.append(mode)
            XCTAssertEqual(id, member.id); XCTAssertEqual(mode, .control); XCTAssertEqual(policy, .fit)
            XCTAssertEqual(cols, 113); XCTAssertEqual(rows, 37); XCTAssertEqual(lease, "lease")
            attached.fulfill()
        }
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        XCTAssertTrue(session.starting); XCTAssertEqual(session.surfaceMode, .control); XCTAssertFalse(session.readOnly)
        // Explicit input claims even before SwiftUI has reported the first viewport.
        try await waitWhile { store.terminalLeases[member.id] == nil }
        XCTAssertNotNil(store.terminalLeases[member.id])
        XCTAssertEqual(server.read { $0.terminalBodies.first?["action"] as? String }, "claim")
        XCTAssertTrue(modes.isEmpty, "Never attach using the placeholder 100x30 grid")
        session.sizeChanged(cols: 113, rows: 37)
        await fulfillment(of: [attached], timeout: 3)
        XCTAssertEqual(modes, [.control], "Explicit input attaches control after the initial observe stream")
        session.client.accept(.ready(mode: .control, cols: 113, rows: 37, expiresAt: 9_999_999_999_999))
        XCTAssertFalse(session.starting); XCTAssertTrue(session.controlling)
        session.disappear(store: store, member: member)
        try await waitWhile { store.terminalLeases[member.id] != nil }
        XCTAssertNil(store.terminalLeases[member.id])
        XCTAssertEqual(server.read { $0.terminalBodies.last?["action"] as? String }, "release")
        XCTAssertEqual(session.client.state, .closed(reason: "client_closed", message: nil))
        store.disconnect()
    }

    func testMacClaimRefusalShowsServerReasonObservesReadOnlyAndRetryClaimsAgain() async throws {
        let server = WriteTestServer()
        server.change { $0.dropTerminal = true }
        let reason = "다른 기기에서 입력 중입니다"
        let retryReason = "세션을 처리 중입니다"
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasSuffix("/terminal/control") == true, server.read({ $0.dropTerminal }) {
                let message = server.read { $0.terminalUnknown } ? retryReason : reason
                return IsolatedTestHTTPReply(status: 409, data: try JSONSerialization.data(withJSONObject: ["error": message, "code": "TERMINAL_REFUSED"]))
            }
            return try server.handle(request)
        }
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let fallback = expectation(description: "read-only fallback"), refusedAgain = expectation(description: "retry refused"), retried = expectation(description: "retried control")
        var modes: [TerminalStreamMode] = []
        let session = controlSession(platform: .mac) { _, _, mode, _, _, _, _ in
            modes.append(mode)
            if mode == .observe {
                if modes.count == 1 { fallback.fulfill() } else { refusedAgain.fulfill() }
            } else { retried.fulfill() }
        }
        session.sizeChanged(cols: 120, rows: 40)
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        await fulfillment(of: [fallback], timeout: 3)
        XCTAssertTrue(session.readOnly); XCTAssertFalse(session.starting)
        XCTAssertEqual(session.surfaceMode, .observe)
        XCTAssertEqual(session.notice, reason)
        let firstRefusal = try XCTUnwrap(store.operationResults.values.first { $0.kind == .terminalControl && $0.status == .refused })
        XCTAssertEqual(firstRefusal.error, reason)
        XCTAssertFalse(network.requests.contains { $0.url?.path == "/api/operations/\(firstRefusal.operationId)" }, "A definitive refusal is final and must not be queried again")
        session.pendingInput(Data("ignored".utf8)) // Fallback typing cannot reclaim control.
        XCTAssertEqual(modes, [.observe])
        server.change { $0.terminalUnknown = true }
        session.beginInput(store: store, member: member)
        await fulfillment(of: [refusedAgain], timeout: 3)
        XCTAssertTrue(session.readOnly); XCTAssertFalse(session.starting)
        XCTAssertEqual(session.surfaceMode, .observe)
        XCTAssertEqual(session.notice, retryReason, "Retry must show its own reason rather than an earlier claim's refusal")
        server.change { $0.dropTerminal = false; $0.terminalUnknown = false }
        session.beginInput(store: store, member: member)
        XCTAssertEqual(session.surfaceMode, .control)
        await fulfillment(of: [retried], timeout: 3)
        XCTAssertEqual(modes, [.observe, .observe, .control]); XCTAssertNil(session.notice)
        let claims = try network.requests.filter { $0.url?.path.hasSuffix("/terminal/control") == true }.map { try WriteTestServer.body($0) }
        XCTAssertEqual(claims.map { $0["action"] as? String }, ["claim", "claim", "claim"])
        XCTAssertEqual(Set(claims.compactMap { $0["operationId"] as? String }).count, 3, "Explicit retries must send fresh claims after definite refusals")
        session.disappear(store: store, member: member)
        try await waitWhile { store.terminalLeases[member.id] != nil }
        store.disconnect()
    }

    func testMacControlAttachFailureReleasesBeforeReadOnlyFallback() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let attached = expectation(description: "control attach"), fallback = expectation(description: "observe after release")
        let client = TerminalStreamClient()
        let session = controlSession(platform: .mac, client: client) { _, _, mode, _, _, _, _ in
            if mode == .control { attached.fulfill() }
            else {
                XCTAssertNil(store.terminalLeases[member.id])
                XCTAssertEqual(server.read { $0.terminalBodies.last?["action"] as? String }, "release")
                fallback.fulfill()
            }
        }
        session.sizeChanged(cols: 120, rows: 40)
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        await fulfillment(of: [attached], timeout: 3)
        client.accept(.closed(reason: "refused", message: "세션을 처리 중입니다")); client.onControlEnded?()
        await fulfillment(of: [fallback], timeout: 3)
        XCTAssertTrue(session.readOnly); XCTAssertEqual(session.notice, "세션을 처리 중입니다")
        session.disappear(store: store, member: member); store.disconnect()
    }

    func testIPhoneExplicitInputFitsViewportAndClosingReleases() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let attached = expectation(description: "phone control attach")
        var modes: [TerminalStreamMode] = []
        let session = controlSession(platform: .iPhone) { _, _, mode, cols, rows, lease, policy in
            modes.append(mode)
            XCTAssertEqual(mode, .control); XCTAssertEqual(lease, "lease")
            XCTAssertEqual(cols, 55); XCTAssertEqual(rows, 24); XCTAssertEqual(policy, .fit)
            attached.fulfill()
        }
        XCTAssertEqual(session.surfaceMode, .observe)
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        XCTAssertTrue(session.starting); XCTAssertFalse(session.readOnly)
        XCTAssertTrue(session.platform.acceptsKeyboard(mode: session.surfaceMode))
        try await waitWhile { store.terminalLeases[member.id] == nil }
        XCTAssertNotNil(store.terminalLeases[member.id])
        XCTAssertEqual(server.read { $0.terminalBodies.first?["action"] as? String }, "claim")
        XCTAssertTrue(modes.isEmpty, "Claim immediately, but wait for the phone viewport before attaching")
        session.sizeChanged(cols: 55, rows: 24)
        await fulfillment(of: [attached], timeout: 3)
        XCTAssertEqual(modes, [.control])
        session.client.accept(.ready(mode: .control, cols: 55, rows: 24, expiresAt: nil))
        XCTAssertFalse(session.starting); XCTAssertTrue(session.controlling)
        session.disappear(store: store, member: member)
        try await waitWhile { store.terminalLeases[member.id] != nil }
        XCTAssertNil(store.terminalLeases[member.id]); XCTAssertNil(session.ownedLeaseID)
        XCTAssertEqual(server.read { $0.terminalBodies.map { $0["action"] as? String } }, ["claim", "release"])
        XCTAssertEqual(session.client.state, .closed(reason: "client_closed", message: nil))
        store.disconnect()
    }

    func testIPhoneClaimRefusalFallsBackReadOnlyAndRetryClaimsControl() async throws {
        let server = WriteTestServer()
        server.change { $0.dropTerminal = true }
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasSuffix("/terminal/control") == true, server.read({ $0.dropTerminal }) {
                return IsolatedTestHTTPReply(status: 409, data: Data(#"{"error":"Another terminal control lease is active","code":"TERMINAL_REFUSED"}"#.utf8))
            }
            return try server.handle(request)
        }
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let fallback = expectation(description: "phone read-only"), retried = expectation(description: "phone retry")
        var modes: [TerminalStreamMode] = [], sent: [Data] = []
        let session = controlSession(platform: .iPhone, connect: { _, _, mode, _, _, _, _ in
            modes.append(mode)
            if mode == .observe { fallback.fulfill() } else { retried.fulfill() }
        }, send: { sent.append($0) })
        session.sizeChanged(cols: 55, rows: 24)
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        session.pendingInput(Data("discard on refusal".utf8))
        await fulfillment(of: [fallback], timeout: 3)
        XCTAssertTrue(session.readOnly); XCTAssertFalse(session.starting)
        XCTAssertEqual(session.surfaceMode, .observe)
        XCTAssertFalse(session.platform.acceptsKeyboard(mode: session.surfaceMode))
        XCTAssertEqual(session.notice, "다른 기기에서 터미널을 조작하고 있습니다")
        XCTAssertTrue(TerminalPresentation.canReconnect(starting: session.starting, ending: session.ending, controlling: session.controlling))
        session.client.accept(.ready(mode: .observe, cols: 160, rows: 50, expiresAt: nil))
        session.pendingInput(Data("ignored while read-only".utf8))
        XCTAssertEqual(modes, [.observe])
        server.change { $0.dropTerminal = false }
        session.beginInput(store: store, member: member)
        XCTAssertEqual(session.surfaceMode, .control)
        XCTAssertEqual(session.client.state, .closed(reason: "client_closed", message: nil), "Retry stops the observer before claiming")
        await fulfillment(of: [retried], timeout: 3)
        session.client.accept(.ready(mode: .control, cols: 55, rows: 24, expiresAt: nil))
        XCTAssertFalse(session.readOnly); XCTAssertNil(session.notice)
        XCTAssertEqual(modes, [.observe, .control]); XCTAssertTrue(sent.isEmpty)
        let claims = try network.requests.filter { $0.url?.path.hasSuffix("/terminal/control") == true }.map { try WriteTestServer.body($0) }
        XCTAssertEqual(claims.map { $0["action"] as? String }, ["claim", "claim"])
        XCTAssertEqual(Set(claims.compactMap { $0["operationId"] as? String }).count, 2)
        session.disappear(store: store, member: member)
        try await waitWhile { store.terminalLeases[member.id] != nil }
        store.disconnect()
    }

    func testIPhoneControlDisconnectReleasesBeforeReadOnlyFallback() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let attached = expectation(description: "phone attached"), fallback = expectation(description: "phone released before observe")
        let session = controlSession(platform: .iPhone) { _, _, mode, _, _, _, _ in
            if mode == .control { attached.fulfill() }
            else {
                XCTAssertNil(store.terminalLeases[member.id])
                XCTAssertEqual(server.read { $0.terminalBodies.last?["action"] as? String }, "release")
                fallback.fulfill()
            }
        }
        session.sizeChanged(cols: 55, rows: 24)
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        await fulfillment(of: [attached], timeout: 3)
        session.client.accept(.ready(mode: .control, cols: 55, rows: 24, expiresAt: nil))
        session.client.accept(.closed(reason: "disconnected", message: "터미널 연결이 끊겼습니다"))
        session.client.onControlEnded?()
        await fulfillment(of: [fallback], timeout: 3)
        XCTAssertTrue(session.readOnly); XCTAssertFalse(session.starting); XCTAssertFalse(session.ending)
        XCTAssertEqual(session.surfaceMode, .observe); XCTAssertNil(session.ownedLeaseID)
        XCTAssertEqual(session.notice, "터미널 연결이 끊겼습니다")
        session.disappear(store: store, member: member); store.disconnect()
    }

    func testIPhoneExplicitInputBuffersDuringClaimAndAttachThenSendsOnce() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let entered = expectation(description: "phone claim pending"), attached = expectation(description: "phone attach pending")
        let gate = DispatchSemaphore(value: 0)
        server.change { $0.gate = gate; $0.entered = entered }
        defer { gate.signal() }
        var sent: [Data] = []
        let session = controlSession(platform: .iPhone, connect: { _, _, _, _, _, _, _ in attached.fulfill() }, send: { sent.append($0) })
        session.sizeChanged(cols: 55, rows: 24)
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        await fulfillment(of: [entered], timeout: 3)
        session.pendingInput(Data("한글".utf8))
        session.pendingInput(Data([27, 91, 65]))
        XCTAssertTrue(sent.isEmpty)
        server.change { $0.gate = nil; $0.entered = nil }; gate.signal()
        await fulfillment(of: [attached], timeout: 3)
        session.pendingInput(Data([13]))
        XCTAssertTrue(session.starting); XCTAssertTrue(sent.isEmpty)
        session.client.accept(.ready(mode: .control, cols: 55, rows: 24, expiresAt: nil))
        XCTAssertFalse(session.starting)
        XCTAssertEqual(sent, [Data("한글".utf8) + Data([27, 91, 65, 13])])
        session.pendingInput(Data("ignored after ready".utf8))
        session.client.accept(.ready(mode: .control, cols: 55, rows: 24, expiresAt: nil))
        XCTAssertEqual(sent.count, 1, "A ready event must never replay the same input twice")
        session.disappear(store: store, member: member)
        try await waitWhile { store.terminalLeases[member.id] != nil }
        store.disconnect()
    }

    func testIPhoneBackgroundReleasesAndExplicitInputAfterForegroundClaimsAgain() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        var attaches = 0
        let session = controlSession(platform: .iPhone) { _, _, mode, _, _, _, policy in
            guard mode == .control else { return }; XCTAssertEqual(policy, .fit); attaches += 1
        }
        session.sizeChanged(cols: 55, rows: 24)
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        try await waitWhile { attaches == 0 }
        XCTAssertEqual(attaches, 1)
        session.client.accept(.ready(mode: .control, cols: 55, rows: 24, expiresAt: nil))
        session.setActive(false, store: store, member: member)
        try await waitWhile { session.controlling || session.ending || store.terminalLeases[member.id] != nil }
        XCTAssertFalse(session.controlling); XCTAssertNil(store.terminalLeases[member.id])
        XCTAssertEqual(session.surfaceMode, .observe, "Background cleanup disables the phone keyboard")
        XCTAssertEqual(attaches, 1)
        XCTAssertEqual(server.read { $0.terminalBodies.map { $0["action"] as? String } }, ["claim", "release"])
        session.setActive(true, store: store, member: member); session.beginInput(store: store, member: member)
        try await waitWhile { attaches < 2 }
        XCTAssertEqual(attaches, 2); XCTAssertFalse(session.readOnly)
        session.disappear(store: store, member: member)
        try await waitWhile { store.terminalLeases[member.id] != nil }
        XCTAssertEqual(server.read { $0.terminalBodies.map { $0["action"] as? String } }, ["claim", "release", "claim", "release"])
        store.disconnect()
    }

    func testIPhoneDisconnectedInputFallsBackToReadOnlyWithoutClaiming() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        store.disconnect()
        let session = controlSession(platform: .iPhone) { _, _, _, _, _, _, _ in XCTFail("Disconnected opening must not attach") }
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        XCTAssertTrue(session.readOnly); XCTAssertFalse(session.starting)
        XCTAssertEqual(session.surfaceMode, .observe)
        XCTAssertEqual(session.notice, "서버에 연결되지 않아 조작할 수 없습니다.")
        XCTAssertTrue(server.read { $0.terminalBodies.isEmpty })
        session.disappear(store: store, member: member)
    }

    func testClosingDuringClaimNeverAttachesAndReleasesLateClaim() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let entered = expectation(description: "claim in flight"), gate = DispatchSemaphore(value: 0)
        server.change { $0.gate = gate; $0.entered = entered }
        let session = controlSession(platform: .mac) { _, _, _, _, _, _, _ in XCTFail("Closed sheet must never attach") }
        session.sizeChanged(cols: 120, rows: 40)
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        await fulfillment(of: [entered], timeout: 3)
        session.disappear(store: store, member: member)
        server.change { $0.gate = nil; $0.entered = nil }; gate.signal()
        await pollUntil("늦은 조작권이 풀림") {
            server.read({ $0.terminalBodies.last?["action"] as? String }) == "release" && store.terminalLeases[member.id] == nil
        }
        XCTAssertEqual(server.read { $0.terminalBodies.map { $0["action"] as? String } }, ["claim", "release"])
        XCTAssertNil(store.terminalLeases[member.id]); XCTAssertFalse(session.starting)
        store.disconnect()
    }

    func testMacStartingBufferIsBoundedAndReportsDiscardOnReady() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let attached = expectation(description: "control attach")
        let session = controlSession(platform: .mac) { _, _, _, _, _, _, _ in attached.fulfill() }
        session.sizeChanged(cols: 120, rows: 40)
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        session.pendingInput(Data(repeating: 65, count: 4096))
        XCTAssertNil(session.notice)
        session.pendingInput(Data([66]))
        XCTAssertTrue(session.notice?.contains("4KB·3초") == true)
        await fulfillment(of: [attached], timeout: 3)
        session.client.accept(.ready(mode: .control, cols: 120, rows: 40, expiresAt: nil))
        XCTAssertTrue(session.notice?.contains("친 키를 버렸습니다") == true)
        session.disappear(store: store, member: member)
        try await waitWhile { store.terminalLeases[member.id] != nil }
        store.disconnect()
    }

    func testTwoSheetsHandoffAndOldControlOrObserverCannotReleaseNewLease() async throws {
        let server = WriteTestServer(); server.change { $0.uniqueTerminalLeases = true }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let firstReady = expectation(description: "first ready"), secondReady = expectation(description: "second ready")
        let first = controlSession(platform: .mac) { _, _, mode, _, _, _, _ in if mode == .control { firstReady.fulfill() } }
        first.sizeChanged(cols: 100, rows: 30); first.appear(store: store, member: member, active: true); first.beginInput(store: store, member: member)
        await fulfillment(of: [firstReady], timeout: 3)
        first.client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        let oldLease = first.ownedLeaseID
        let second = controlSession(platform: .mac) { _, _, mode, _, _, _, _ in if mode == .control { secondReady.fulfill() } }
        second.sizeChanged(cols: 120, rows: 40); second.appear(store: store, member: member, active: true); second.beginInput(store: store, member: member)
        await fulfillment(of: [secondReady], timeout: 3)
        second.client.accept(.ready(mode: .control, cols: 120, rows: 40, expiresAt: nil))
        XCTAssertNotEqual(second.ownedLeaseID, oldLease)
        first.client.accept(.closed(reason: "replaced", message: nil)); first.client.onControlEnded?()
        let observer = TerminalSession(platform: .iPhone) { _, _, _, _, _, _, _ in }
        observer.appear(store: store, member: member, active: true)
        first.disappear(store: store, member: member); observer.disappear(store: store, member: member)
        // 옛 창·보는 창이 새 조작권을 '풀지 않는지' 보는 쪽이라 넉넉히 기다린다.
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(store.terminalLeases[member.id]?.leaseId, second.ownedLeaseID)
        XCTAssertTrue(second.controlling)
        XCTAssertEqual(server.read { $0.terminalBodies.map { $0["action"] as? String } }, ["claim", "release", "claim"])
        second.disappear(store: store, member: member)
        try await waitWhile { store.terminalLeases[member.id] != nil }
        XCTAssertNil(store.terminalLeases[member.id]); store.disconnect()
    }

    func testClosedPendingSheetIsReleasedBeforeNextSheetClaims() async throws {
        let server = WriteTestServer(); server.change { $0.uniqueTerminalLeases = true }
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let entered = expectation(description: "first claim pending"), gate = DispatchSemaphore(value: 0)
        server.change { $0.gate = gate; $0.entered = entered }
        let first = controlSession(platform: .mac) { _, _, mode, _, _, _, _ in if mode == .control { XCTFail("Closed sheet attached") } }
        first.sizeChanged(cols: 100, rows: 30); first.appear(store: store, member: member, active: true); first.beginInput(store: store, member: member)
        await fulfillment(of: [entered], timeout: 3)
        first.disappear(store: store, member: member)
        let secondReady = expectation(description: "new sheet ready")
        let second = controlSession(platform: .mac) { _, _, mode, _, _, _, _ in if mode == .control { secondReady.fulfill() } }
        second.sizeChanged(cols: 120, rows: 40); second.appear(store: store, member: member, active: true); second.beginInput(store: store, member: member)
        server.change { $0.gate = nil; $0.entered = nil }; gate.signal()
        await fulfillment(of: [secondReady], timeout: 3)
        // 세 요청은 새 창이 붙기 전에 차례로 끝난다. 그 뒤에 더 '나가지 않는지' 보는 쪽이라 넉넉히 기다린다.
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(server.read { $0.terminalBodies.map { $0["action"] as? String } }, ["claim", "release", "claim"])
        let claims = server.read { $0.terminalBodies.filter { $0["action"] as? String == "claim" }.compactMap { $0["claimId"] as? String } }
        XCTAssertEqual(Set(claims).count, 2)
        XCTAssertEqual(store.terminalLeases[member.id]?.leaseId, second.ownedLeaseID)
        second.disappear(store: store, member: member)
        try await waitWhile { store.terminalLeases[member.id] != nil }
        store.disconnect()
    }

    func testForegroundRevalidationRetriesControlAndClosingInvalidatesWait() async throws {
        for closeDuringWait in [false, true] {
            let server = WriteTestServer()
            let network = try IsolatedTestNetwork { request in
                if request.url?.path == "/api/sync", let gate = server.read({ $0.gate }) {
                    server.read { $0.entered }?.fulfill(); XCTAssertEqual(gate.wait(timeout: .now() + 5), .success, "Fixture gate timed out")
                }
                return try server.handle(request)
            }
            let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
            var controlAttaches = 0, sent: [Data] = []
            let session = controlSession(platform: .mac, connect: { _, _, mode, _, _, _, _ in if mode == .control { controlAttaches += 1 } }, send: { sent.append($0) })
            session.sizeChanged(cols: 100, rows: 30); session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
            try await waitWhile { controlAttaches == 0 }
            session.client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
            session.setActive(false, store: store, member: member, immediately: true)
            // 조작권이 지워진 뒤에도 입력 끝내기(finishInput)는 몇 번 더 기다렸다 끝난다. 그 사이 beginInput 은 무시되므로
            // 느린 CI 러너에서는 아래 '시작 중' 단정이 흔들렸다. 끝내기까지 끝난 뒤에 다음 단계로 간다.
            try await waitWhile { store.terminalLeases[member.id] != nil || session.ending }
            let gate = DispatchSemaphore(value: 0), entered = expectation(description: "sync held")
            server.change { $0.gate = gate; $0.entered = entered }
            store.setForeground(true); session.setActive(true, store: store, member: member); session.beginInput(store: store, member: member)
            await fulfillment(of: [entered], timeout: 3)
            XCTAssertTrue(store.isRevalidating); XCTAssertTrue(session.starting)
            session.requestInput(Data("ab".utf8), store: store, member: member)
            XCTAssertEqual(controlAttaches, 1)
            if closeDuringWait { session.disappear(store: store, member: member) }
            server.change { $0.gate = nil; $0.entered = nil }; gate.signal()
            try await waitWhile { store.isRevalidating || (!closeDuringWait && controlAttaches < 2) }
            // 더 붙지 '않는지' 보는 쪽이라 넉넉히 기다린다.
            try await Task.sleep(for: .milliseconds(300))
            XCTAssertEqual(controlAttaches, closeDuringWait ? 1 : 2)
            if !closeDuringWait {
                XCTAssertFalse(session.readOnly); XCTAssertNil(session.notice)
                session.client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
                XCTAssertEqual(sent, [Data("ab".utf8)])
            } else { XCTAssertTrue(sent.isEmpty) }
            session.disappear(store: store, member: member)
            try await waitWhile { store.terminalLeases[member.id] != nil }
            store.disconnect()
        }
    }

    func testLostClaimRecoveredAfterClosingIsReleased() async throws {
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasPrefix("/api/operations/") == true, server.read({ $0.dropTerminal }) { throw URLError(.timedOut) }
            return try server.handle(request)
        }
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        server.change { $0.dropTerminal = true }
        let session = controlSession(platform: .mac) { _, _, mode, _, _, _, _ in if mode == .control { XCTFail("Unconfirmed claim attached") } }
        session.sizeChanged(cols: 100, rows: 30); session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        try await waitWhile { session.starting }
        XCTAssertNil(store.terminalLeases[member.id])
        session.disappear(store: store, member: member)
        try await Task.sleep(for: .milliseconds(50))
        server.change { $0.dropTerminal = false }
        await store.recoverWrites()
        await pollUntil("늦은 조작권이 풀림") {
            server.read({ $0.terminalBodies.last?["action"] as? String }) == "release" && store.terminalLeases[member.id] == nil
        }
        XCTAssertEqual(server.read { $0.terminalBodies.last?["action"] as? String }, "release")
        XCTAssertNil(store.terminalLeases[member.id]); store.disconnect()
    }

    func testClosedLostClaimIsReleasedAfterAppStoreRestart() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let submissionURL = root.appendingPathComponent("submissions"), journal = root.appendingPathComponent("journal")
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasPrefix("/api/operations/") == true, server.read({ $0.dropTerminal }) { throw URLError(.timedOut) }
            return try server.handle(request)
        }
        let store = await connectedStore(network, submissions: try SubmissionStore(storageURL: submissionURL), journal: journal)
        let member = try XCTUnwrap(store.members.first)
        server.change { $0.dropTerminal = true }
        let session = controlSession(platform: .mac) { _, _, mode, _, _, _, _ in if mode == .control { XCTFail("Unconfirmed claim attached") } }
        session.sizeChanged(cols: 100, rows: 30); session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        try await waitWhile { session.starting }
        session.disappear(store: store, member: member)
        try await Task.sleep(for: .milliseconds(100)); store.disconnect()
        server.change { $0.dropTerminal = false }
        let restarted = await connectedStore(network, submissions: try SubmissionStore(storageURL: submissionURL), journal: journal)
        await pollUntil("다시 시작한 뒤 늦은 조작권이 풀림") {
            server.read({ $0.terminalBodies.last?["action"] as? String }) == "release" && restarted.terminalLeases[member.id] == nil
        }
        XCTAssertEqual(server.read { $0.terminalBodies.last?["action"] as? String }, "release")
        XCTAssertNil(restarted.terminalLeases[member.id]); restarted.disconnect()
    }

    /// 150ms 디바운스를 실제 시간(100ms sleep 세 번)으로 재지 않는다. 주입한 대기가 끝나기 전에는 0건, 끝나면 최신 1건이다.
    func testResizeDebouncesAndSendsOnlyLatestGridAfter150Milliseconds() async throws {
        var packets: [String] = []
        let debounce = ManualPause()
        let client = TerminalStreamClient(resizeSender: { packets.append($0) }, debouncePause: { try await debounce.pause($0) })
        defer { client.dispose() }
        client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        client.resize(cols: 80, rows: 24)
        try await waitWhile { debounce.waiting != 1 }
        XCTAssertEqual(debounce.requested, [.milliseconds(150)])
        XCTAssertTrue(packets.isEmpty)
        // A newer size replaces the waiting one; the first is never sent.
        client.resize(cols: 120, rows: 40)
        try await waitWhile { debounce.requested.count != 2 || debounce.waiting != 1 }
        XCTAssertTrue(packets.isEmpty)
        debounce.fire()
        try await waitWhile { packets.isEmpty }
        XCTAssertEqual(packets.count, 1)
        let packet = try XCTUnwrap(packets.first)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(packet.utf8)) as? [String: Any])
        XCTAssertEqual(body["cols"] as? Int, 120); XCTAssertEqual(body["rows"] as? Int, 40)
        client.resize(cols: 90, rows: 25)
        try await waitWhile { debounce.requested.count != 3 }
        client.close()
        try await waitWhile { debounce.waiting != 0 }
        debounce.fire()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(packets.count, 1)
    }

    #if os(macOS)
    func testWindowOwnsOneSessionAndKeepsRenderedHostAcrossReadyAndParentRefresh() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        var constructions = 0
        var createdSession: TerminalSession?
        func root(_ member: Member) -> some View {
            TerminalSessionContent(member: member, makeSession: {
                constructions += 1
                let session = TerminalSession(platform: .mac, connect: { _, _, _, _, _, _, _ in })
                createdSession = session
                return session
            })
            .environment(store).environment(\.terminalWindow, true).environment(\.scenePhase, .active)
        }
        let hosting = NSHostingView(rootView: root(member))
        XCTAssertEqual(constructions, 0, "Creating the parent value must not construct a session")
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 1000, height: 650),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = hosting
        defer { createdSession?.disappear(store: store, member: member); window.close(); store.disconnect() }
        func surface(in view: NSView) -> TerminalSurfaceHost? {
            if let host = view as? TerminalSurfaceHost { return host }
            return view.subviews.lazy.compactMap { surface(in: $0) }.first
        }
        await pollUntil("터미널 표면이 붙음") { hosting.layoutSubtreeIfNeeded(); return surface(in: hosting) != nil }
        XCTAssertEqual(constructions, 1, "The first mount must create exactly one session")
        let session = try XCTUnwrap(createdSession)
        let first = try XCTUnwrap(surface(in: hosting)), canvas = first.terminal, engine = canvas.getTerminal()
        XCTAssertTrue(canvas.isDescendant(of: hosting), "The terminal canvas must be mounted in the window")
        XCTAssertGreaterThan(canvas.bounds.width, 0); XCTAssertGreaterThan(canvas.bounds.height, 0)
        first.feed(Data("old screen".utf8))
        let oldBuffer = engine.buffer
        session.client.accept(.ready(mode: .observe, cols: 80, rows: 24, expiresAt: nil))
        session.client.onOutput?(Data("new screen".utf8))
        // 새 세대의 화면 초기화는 SwiftUI 갱신을 거쳐 온다. 고정 60ms 대신 새 버퍼가 될 때까지 기다린다(느린 CI 러너).
        await pollUntil("새 세대의 화면 버퍼") { hosting.layoutSubtreeIfNeeded(); return !(oldBuffer === engine.buffer) }
        hosting.layoutSubtreeIfNeeded()
        XCTAssertTrue(first === surface(in: hosting)); XCTAssertTrue(canvas === first.terminal)
        XCTAssertTrue(engine === canvas.getTerminal()); XCTAssertFalse(oldBuffer === engine.buffer)
        for width: CGFloat in [900, 1000, 800, 1100, 900] {
            var updatedMember = member
            updatedMember.now = "Parent refresh at width \(width)"
            hosting.rootView = root(updatedMember)
            window.setContentSize(CGSize(width: width, height: 600)); hosting.layoutSubtreeIfNeeded()
            // 세션·표면을 '다시 만들지 않는지' 보는 쪽이라 넉넉히 기다린다.
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertEqual(constructions, 1, "Parent recomputation must retain the mounted session")
            XCTAssertTrue(createdSession === session); XCTAssertTrue(first === surface(in: hosting))
            XCTAssertTrue(canvas === first.terminal); XCTAssertTrue(engine === canvas.getTerminal())
        }
    }

    func testTerminalViewAndCESheetPropagateWindowWidthToViewportAndColumns() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        var resizePackets: [[String: Int]] = []
        let client = TerminalStreamClient(resizeSender: { text in
            let packet = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
            resizePackets.append(["cols": try XCTUnwrap(packet["cols"] as? Int), "rows": try XCTUnwrap(packet["rows"] as? Int)])
        })
        let session = controlSession(platform: .mac, client: client) { _, _, _, _, _, _, _ in }
        let hosting = NSHostingView(rootView: TerminalView(member: member, session: session).environment(store).environment(\.terminalWindow, true))
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 1000, height: 650),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = hosting
        defer { session.disappear(store: store, member: member); window.close(); store.disconnect() }
        func surface(in view: NSView) -> TerminalSurfaceHost? {
            if let host = view as? TerminalSurfaceHost { return host }
            return view.subviews.lazy.compactMap { surface(in: $0) }.first
        }
        await pollUntil("터미널 표면이 붙음") { hosting.layoutSubtreeIfNeeded(); return surface(in: hosting) != nil }
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        try await waitWhile { session.ownedLeaseID == nil }
        session.client.accept(.ready(mode: .control, cols: session.naturalCols, rows: session.naturalRows, expiresAt: nil))
        var previousWidth: CGFloat = 0, previousCols = 0
        for width: CGFloat in [720, 960, 1120] {
            window.setContentSize(CGSize(width: width, height: 650)); hosting.layoutSubtreeIfNeeded()
            // 새 폭은 SwiftUI 갱신을 거쳐 표면·터미널 열 수·세션에 닿는다. 고정 200ms 대신 닿을 때까지 기다린다(느린 CI 러너).
            await pollUntil("창 폭 \(Int(width)) 이 터미널 열 수에 닿음") {
                hosting.layoutSubtreeIfNeeded()
                guard let host = surface(in: hosting) else { return false }
                host.layoutSubtreeIfNeeded(); host.layout()
                let cols = host.terminal.getTerminal().cols
                return host.contentSize.width > previousWidth && cols > previousCols && session.naturalCols == cols
            }
            let host = try XCTUnwrap(surface(in: hosting))
            host.layoutSubtreeIfNeeded(); host.layout()
            XCTAssertLessThanOrEqual(host.bounds.width, hosting.bounds.width)
            XCTAssertGreaterThan(host.contentSize.width, previousWidth)
            XCTAssertGreaterThan(host.terminal.getTerminal().cols, previousCols)
            XCTAssertEqual(host.documentView?.frame.size, host.documentView?.bounds.size)
            XCTAssertEqual(session.naturalCols, host.terminal.getTerminal().cols)
            // The resize leaves through a debounced sender on the main run loop. A loaded machine (CI) needs more than
            // the fixed wait above, so wait for the packet; it must still carry this width's columns.
            await pollUntil("크기 바꿈 신호") { resizePackets.last?["cols"] == session.naturalCols }
            XCTAssertEqual(resizePackets.last?["cols"], session.naturalCols, "Real sheet geometry reaches the debounced wire sender")
            previousWidth = host.contentSize.width; previousCols = host.terminal.getTerminal().cols
        }
    }
    #endif

    func testMacStatusKeepsDeliveryMessageAndAddsLastMinuteCountdown() {
        let now = Date(timeIntervalSince1970: 1000), status = "직접 입력 중 · 보낸 지시는 잠시 기다립니다"
        XCTAssertEqual(TerminalPresentation.controlStatus(expiresAt: nil, now: now), status)
        XCTAssertEqual(TerminalPresentation.controlStatus(expiresAt: 1_060_000, now: now), status)
        XCTAssertEqual(TerminalPresentation.controlStatus(expiresAt: 1_059_000, now: now), status + " · 59초 남음")
        XCTAssertEqual(TerminalPresentation.controlStatus(expiresAt: 999_000, now: now), status + " · 0초 남음")
    }
}
