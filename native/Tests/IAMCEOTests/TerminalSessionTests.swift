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
        for _ in 0..<200 where store.terminalLeases[member.id] == nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNotNil(store.terminalLeases[member.id])
        XCTAssertEqual(server.read { $0.terminalBodies.first?["action"] as? String }, "claim")
        XCTAssertTrue(modes.isEmpty, "Never attach using the placeholder 100x30 grid")
        session.sizeChanged(cols: 113, rows: 37)
        await fulfillment(of: [attached], timeout: 3)
        XCTAssertEqual(modes, [.control], "Explicit input attaches control after the initial observe stream")
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
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
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
        for _ in 0..<200 where store.terminalLeases[member.id] == nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNotNil(store.terminalLeases[member.id])
        XCTAssertEqual(server.read { $0.terminalBodies.first?["action"] as? String }, "claim")
        XCTAssertTrue(modes.isEmpty, "Claim immediately, but wait for the phone viewport before attaching")
        session.sizeChanged(cols: 55, rows: 24)
        await fulfillment(of: [attached], timeout: 3)
        XCTAssertEqual(modes, [.control])
        session.client.accept(.ready(mode: .control, cols: 55, rows: 24, expiresAt: nil))
        XCTAssertFalse(session.starting); XCTAssertTrue(session.controlling)
        session.disappear(store: store, member: member)
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
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
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
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
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
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
        for _ in 0..<200 where attaches == 0 { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(attaches, 1)
        session.client.accept(.ready(mode: .control, cols: 55, rows: 24, expiresAt: nil))
        session.setActive(false, store: store, member: member)
        for _ in 0..<200 where session.controlling || session.ending || store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(session.controlling); XCTAssertNil(store.terminalLeases[member.id])
        XCTAssertEqual(session.surfaceMode, .observe, "Background cleanup disables the phone keyboard")
        XCTAssertEqual(attaches, 1)
        XCTAssertEqual(server.read { $0.terminalBodies.map { $0["action"] as? String } }, ["claim", "release"])
        session.setActive(true, store: store, member: member); session.beginInput(store: store, member: member)
        for _ in 0..<200 where attaches < 2 { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(attaches, 2); XCTAssertFalse(session.readOnly)
        session.disappear(store: store, member: member)
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
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
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
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
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(store.terminalLeases[member.id]?.leaseId, second.ownedLeaseID)
        XCTAssertTrue(second.controlling)
        XCTAssertEqual(server.read { $0.terminalBodies.map { $0["action"] as? String } }, ["claim", "release", "claim"])
        second.disappear(store: store, member: member)
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
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
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(server.read { $0.terminalBodies.map { $0["action"] as? String } }, ["claim", "release", "claim"])
        let claims = server.read { $0.terminalBodies.filter { $0["action"] as? String == "claim" }.compactMap { $0["claimId"] as? String } }
        XCTAssertEqual(Set(claims).count, 2)
        XCTAssertEqual(store.terminalLeases[member.id]?.leaseId, second.ownedLeaseID)
        second.disappear(store: store, member: member)
        for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
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
            var controlAttaches = 0
            let session = controlSession(platform: .mac) { _, _, mode, _, _, _, _ in if mode == .control { controlAttaches += 1 } }
            session.sizeChanged(cols: 100, rows: 30); session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
            for _ in 0..<200 where controlAttaches == 0 { try await Task.sleep(for: .milliseconds(10)) }
            session.client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
            session.setActive(false, store: store, member: member)
            for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
            let gate = DispatchSemaphore(value: 0), entered = expectation(description: "sync held")
            server.change { $0.gate = gate; $0.entered = entered }
            store.setForeground(true); session.setActive(true, store: store, member: member); session.beginInput(store: store, member: member)
            await fulfillment(of: [entered], timeout: 3)
            XCTAssertTrue(store.isRevalidating); XCTAssertTrue(session.starting)
            XCTAssertEqual(controlAttaches, 1)
            if closeDuringWait { session.disappear(store: store, member: member) }
            server.change { $0.gate = nil; $0.entered = nil }; gate.signal()
            for _ in 0..<200 where store.isRevalidating || (!closeDuringWait && controlAttaches < 2) { try await Task.sleep(for: .milliseconds(10)) }
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertEqual(controlAttaches, closeDuringWait ? 1 : 2)
            if !closeDuringWait { XCTAssertFalse(session.readOnly); XCTAssertNil(session.notice) }
            session.disappear(store: store, member: member)
            for _ in 0..<200 where store.terminalLeases[member.id] != nil { try await Task.sleep(for: .milliseconds(10)) }
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
        for _ in 0..<200 where session.starting { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNil(store.terminalLeases[member.id])
        session.disappear(store: store, member: member)
        try await Task.sleep(for: .milliseconds(50))
        server.change { $0.dropTerminal = false }
        await store.recoverWrites()
        for _ in 0..<200 {
            if server.read({ $0.terminalBodies.last?["action"] as? String }) == "release", store.terminalLeases[member.id] == nil { break }
            try await Task.sleep(for: .milliseconds(10))
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
        for _ in 0..<200 where session.starting { try await Task.sleep(for: .milliseconds(10)) }
        session.disappear(store: store, member: member)
        try await Task.sleep(for: .milliseconds(100)); store.disconnect()
        server.change { $0.dropTerminal = false }
        let restarted = await connectedStore(network, submissions: try SubmissionStore(storageURL: submissionURL), journal: journal)
        for _ in 0..<200 {
            if server.read({ $0.terminalBodies.last?["action"] as? String }) == "release", restarted.terminalLeases[member.id] == nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(server.read { $0.terminalBodies.last?["action"] as? String }, "release")
        XCTAssertNil(restarted.terminalLeases[member.id]); restarted.disconnect()
    }

    func testResizeDebouncesAndSendsOnlyLatestGridAfter150Milliseconds() async throws {
        var packets: [String] = []
        let client = TerminalStreamClient(resizeSender: { packets.append($0) })
        defer { client.dispose() }
        client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        client.resize(cols: 80, rows: 24)
        try await Task.sleep(for: .milliseconds(100)); XCTAssertTrue(packets.isEmpty)
        client.resize(cols: 120, rows: 40)
        try await Task.sleep(for: .milliseconds(100)); XCTAssertTrue(packets.isEmpty)
        try await Task.sleep(for: .milliseconds(100)); XCTAssertEqual(packets.count, 1)
        let packet = try XCTUnwrap(packets.first)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(packet.utf8)) as? [String: Any])
        XCTAssertEqual(body["cols"] as? Int, 120); XCTAssertEqual(body["rows"] as? Int, 40)
        client.resize(cols: 90, rows: 25); client.close()
        try await Task.sleep(for: .milliseconds(200)); XCTAssertEqual(packets.count, 1)
    }

    #if os(macOS)
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
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        session.appear(store: store, member: member, active: true); session.beginInput(store: store, member: member)
        for _ in 0..<200 where session.ownedLeaseID == nil { try await Task.sleep(for: .milliseconds(10)) }
        session.client.accept(.ready(mode: .control, cols: session.naturalCols, rows: session.naturalRows, expiresAt: nil))
        var previousWidth: CGFloat = 0, previousCols = 0
        for width: CGFloat in [720, 960, 1120] {
            window.setContentSize(CGSize(width: width, height: 650)); hosting.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(200))
            let host = try XCTUnwrap(surface(in: hosting))
            host.layoutSubtreeIfNeeded(); host.layout()
            XCTAssertLessThanOrEqual(host.bounds.width, hosting.bounds.width)
            XCTAssertGreaterThan(host.contentSize.width, previousWidth)
            XCTAssertGreaterThan(host.terminal.getTerminal().cols, previousCols)
            XCTAssertEqual(host.documentView?.frame.size, host.documentView?.bounds.size)
            XCTAssertEqual(session.naturalCols, host.terminal.getTerminal().cols)
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
