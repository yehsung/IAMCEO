import Foundation
import XCTest
@testable import IAMCEO

@MainActor final class TerminalSessionTests: XCTestCase {
    private func connectedStore(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }

    func testMacOpeningClaimsImmediatelyAndAttachesOnlyControlAtNaturalSize() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let attached = expectation(description: "control attach")
        var modes: [TerminalStreamMode] = []
        let session = TerminalSession(platform: .mac) { _, id, mode, cols, rows, lease, policy in
            modes.append(mode)
            XCTAssertEqual(id, member.id); XCTAssertEqual(mode, .control); XCTAssertEqual(policy, .fit)
            XCTAssertEqual(cols, 113); XCTAssertEqual(rows, 37); XCTAssertEqual(lease, "lease")
            attached.fulfill()
        }
        session.appear(store: store, member: member, active: true)
        XCTAssertTrue(session.starting); XCTAssertEqual(session.surfaceMode, .control); XCTAssertFalse(session.readOnly)
        // Claim starts even before SwiftUI has reported the first viewport.
        for _ in 0..<200 where store.terminalLeases[member.id] == nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNotNil(store.terminalLeases[member.id])
        XCTAssertEqual(server.read { $0.terminalBodies.first?["action"] as? String }, "claim")
        XCTAssertTrue(modes.isEmpty, "Never attach using the placeholder 100x30 grid")
        session.sizeChanged(cols: 113, rows: 37)
        await fulfillment(of: [attached], timeout: 3)
        XCTAssertEqual(modes, [.control], "Mac opening must never use observe")
        session.client.accept(.ready(mode: .control, cols: 113, rows: 37, expiresAt: 9_999_999_999_999))
        XCTAssertFalse(session.starting); XCTAssertTrue(session.controlling)
        session.disappear(store: store, member: member)
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
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
        let session = TerminalSession(platform: .mac) { _, _, mode, _, _, _, _ in
            modes.append(mode)
            if mode == .observe {
                if modes.count == 1 { fallback.fulfill() } else { refusedAgain.fulfill() }
            } else { retried.fulfill() }
        }
        session.sizeChanged(cols: 120, rows: 40)
        session.appear(store: store, member: member, active: true)
        await fulfillment(of: [fallback], timeout: 3)
        XCTAssertTrue(session.readOnly); XCTAssertFalse(session.starting)
        XCTAssertEqual(session.surfaceMode, .observe)
        XCTAssertEqual(session.notice, reason)
        let firstRefusal = try XCTUnwrap(store.operationResults.values.first { $0.kind == .terminalControl && $0.status == .refused })
        XCTAssertEqual(firstRefusal.error, reason)
        XCTAssertTrue(network.requests.contains { $0.url?.path == "/api/operations/\(firstRefusal.operationId)" }, "Missing receipt lookup must not hide the claim refusal")
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
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
        store.disconnect()
    }

    func testMacControlAttachFailureReleasesBeforeReadOnlyFallback() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let attached = expectation(description: "control attach"), fallback = expectation(description: "observe after release")
        let client = TerminalStreamClient()
        let session = TerminalSession(platform: .mac, client: client) { _, _, mode, _, _, _, _ in
            if mode == .control { attached.fulfill() }
            else {
                XCTAssertNil(store.terminalLeases[member.id])
                XCTAssertEqual(server.read { $0.terminalBodies.last?["action"] as? String }, "release")
                fallback.fulfill()
            }
        }
        session.sizeChanged(cols: 120, rows: 40)
        session.appear(store: store, member: member, active: true)
        await fulfillment(of: [attached], timeout: 3)
        client.accept(.closed(reason: "refused", message: "세션을 처리 중입니다")); client.onControlEnded?()
        await fulfillment(of: [fallback], timeout: 3)
        XCTAssertTrue(session.readOnly); XCTAssertEqual(session.notice, "세션을 처리 중입니다")
        session.disappear(store: store, member: member); store.disconnect()
    }

    func testIPhoneStillObservesUntilExplicitInputStart() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let attached = expectation(description: "phone control attach")
        var modes: [TerminalStreamMode] = []
        let session = TerminalSession(platform: .iPhone) { _, _, mode, cols, rows, _, policy in
            modes.append(mode)
            if mode == .control {
                XCTAssertEqual(cols, 55); XCTAssertEqual(rows, 24); XCTAssertEqual(policy, .fit)
                attached.fulfill()
            }
        }
        session.appear(store: store, member: member, active: true)
        XCTAssertEqual(modes, [.observe]); XCTAssertTrue(server.read { $0.terminalBodies.isEmpty })
        session.pendingInput(Data("ignored".utf8)); XCTAssertFalse(session.starting)
        session.sizeChanged(cols: 55, rows: 24)
        session.beginInput(store: store, member: member)
        await fulfillment(of: [attached], timeout: 3)
        XCTAssertEqual(modes, [.observe, .control])
        session.disappear(store: store, member: member)
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
        store.disconnect()
    }

    func testClosingDuringClaimNeverAttachesAndReleasesLateClaim() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let entered = expectation(description: "claim in flight"), gate = DispatchSemaphore(value: 0)
        server.change { $0.gate = gate; $0.entered = entered }
        let session = TerminalSession(platform: .mac) { _, _, _, _, _, _, _ in XCTFail("Closed sheet must never attach") }
        session.sizeChanged(cols: 120, rows: 40)
        session.appear(store: store, member: member, active: true)
        await fulfillment(of: [entered], timeout: 3)
        session.disappear(store: store, member: member)
        server.change { $0.gate = nil; $0.entered = nil }; gate.signal()
        for _ in 0..<200 {
            if server.read({ $0.terminalBodies.last?["action"] as? String }) == "release", store.terminalLeases[member.id] == nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(server.read { $0.terminalBodies.map { $0["action"] as? String } }, ["claim", "release"])
        XCTAssertNil(store.terminalLeases[member.id]); XCTAssertFalse(session.starting)
        store.disconnect()
    }

    func testMacStartingBufferIsBoundedAndReportsDiscardOnReady() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connectedStore(network), member = try XCTUnwrap(store.members.first)
        let attached = expectation(description: "control attach")
        let session = TerminalSession(platform: .mac) { _, _, _, _, _, _, _ in attached.fulfill() }
        session.sizeChanged(cols: 120, rows: 40)
        session.appear(store: store, member: member, active: true)
        session.pendingInput(Data(repeating: 65, count: 4096))
        XCTAssertNil(session.notice)
        session.pendingInput(Data([66]))
        XCTAssertTrue(session.notice?.contains("4KB·3초") == true)
        await fulfillment(of: [attached], timeout: 3)
        session.client.accept(.ready(mode: .control, cols: 120, rows: 40, expiresAt: nil))
        XCTAssertTrue(session.notice?.contains("친 키를 버렸습니다") == true)
        session.disappear(store: store, member: member)
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
        store.disconnect()
    }

    func testMacStatusKeepsDeliveryMessageAndAddsLastMinuteCountdown() {
        let now = Date(timeIntervalSince1970: 1000), status = "직접 입력 중 · 이 직원의 자동 전달이 멈춰 있습니다"
        XCTAssertEqual(TerminalPresentation.controlStatus(expiresAt: nil, now: now), status)
        XCTAssertEqual(TerminalPresentation.controlStatus(expiresAt: 1_060_000, now: now), status)
        XCTAssertEqual(TerminalPresentation.controlStatus(expiresAt: 1_059_000, now: now), status + " · 59초 남음")
        XCTAssertEqual(TerminalPresentation.controlStatus(expiresAt: 999_000, now: now), status + " · 0초 남음")
    }
}
