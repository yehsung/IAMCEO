import Foundation
import XCTest
import SwiftUI
import SwiftTerm
@testable import IAMCEO

final class TerminalStreamTests: XCTestCase {
    func testEventParsingAndMalformedMessages() {
        XCTAssertEqual(TerminalStreamEvent.parse(#"{"type":"ready","mode":"observe","cols":200,"rows":120}"#),
                       .ready(mode: .observe, cols: 200, rows: 120, expiresAt: nil))
        XCTAssertEqual(TerminalStreamEvent.parse(#"{"type":"ready","mode":"control","cols":100,"rows":30,"expiresAt":123456}"#),
                       .ready(mode: .control, cols: 100, rows: 30, expiresAt: 123456))
        XCTAssertEqual(TerminalStreamEvent.parse(#"{"type":"lease","expiresAt":654321}"#), .lease(expiresAt: 654321))
        XCTAssertEqual(TerminalStreamEvent.parse(#"{"type":"closed","reason":"lease_ended","message":"조작권이 끝났습니다"}"#),
                       .closed(reason: "lease_ended", message: "조작권이 끝났습니다"))
        for text in ["invalid", #"{"type":"ping"}"#, #"{"type":"ready","mode":"observe","cols":0,"rows":20}"#,
                     #"{"type":"ready","mode":"other","cols":80,"rows":20}"#, #"{"type":"lease"}"#] {
            XCTAssertNil(TerminalStreamEvent.parse(text))
        }
    }
    @MainActor func testStateAndLeaseEvents() {
        let client = TerminalStreamClient()
        client.accept(.ready(mode: .observe, cols: 200, rows: 120, expiresAt: nil))
        XCTAssertEqual(client.state, .live(mode: .observe, cols: 200, rows: 120))
        XCTAssertEqual(client.grid.cols, 200); XCTAssertEqual(client.grid.rows, 120)
        client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: 1000))
        client.accept(.lease(expiresAt: 2000)); XCTAssertEqual(client.expiresAt, 2000)
        client.accept(.closed(reason: "lease_ended", message: nil))
        XCTAssertEqual(client.state, .closed(reason: "lease_ended", message: nil))
        client.close()
    }
    @MainActor func testUnsupportedStatusesAndReconnectDelays() {
        for status in [404,405,501] { XCTAssertTrue(TerminalStreamClient.isUnsupported(status: status)) }
        for status in [0,101,400,401,403,409,429,500] { XCTAssertFalse(TerminalStreamClient.isUnsupported(status: status)) }
        XCTAssertEqual((0...7).map { TerminalStreamClient.reconnectDelay(attempt: $0) }, [1,2,4,8,15,15,15,15])
    }
    func testStreamURLAndHeaderUseSameOriginAndNoAccessCodeInQuery() async throws {
        for address in ["http://127.0.0.1:7881", "https://example.ts.net"] {
            let api = APIClient(endpoint: try ServerEndpoint(address), accessCode: "private-code")
            let request = try await api.terminalStreamRequest(memberID: "member /한글", mode: .control, cols: 100, rows: 30, leaseID: "lease&+?#")
            let url = try XCTUnwrap(request.url)
            XCTAssertEqual(url.scheme, address.hasPrefix("https") ? "wss" : "ws")
            XCTAssertEqual(url.host, URL(string: address)?.host)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer private-code")
            XCTAssertFalse(request.httpShouldHandleCookies)
            XCTAssertFalse(url.absoluteString.contains("private-code"))
            XCTAssertTrue(url.absoluteString.contains("member%20%2F"))
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            XCTAssertEqual(items.first { $0.name == "mode" }?.value, "control")
            XCTAssertEqual(items.first { $0.name == "lease" }?.value, "lease&+?#")
            XCTAssertNil(items.first { $0.name == "t" })
        }
    }
    func testStartBufferReplaysOnceAndEnforcesByteAndTimeBounds() {
        let now = Date(timeIntervalSince1970: 1000)
        var buffer = TerminalStartBuffer(); buffer.begin(now: now)
        XCTAssertTrue(buffer.append(Data("한글\u{1b}[A".utf8), now: now))
        XCTAssertEqual(buffer.take(now: now.addingTimeInterval(3)), Data("한글\u{1b}[A".utf8))
        XCTAssertNil(buffer.take(now: now))
        buffer.begin(now: now)
        XCTAssertTrue(buffer.append(Data(repeating: 65, count: 4096), now: now))
        XCTAssertFalse(buffer.append(Data([66]), now: now))
        XCTAssertTrue(buffer.data.isEmpty); XCTAssertTrue(buffer.discarded)
        XCTAssertNil(buffer.take(now: now))
        buffer.begin(now: now)
        XCTAssertFalse(buffer.append(Data([65]), now: now.addingTimeInterval(3.001)))
        buffer.begin(now: now); XCTAssertTrue(buffer.append(Data([65]), now: now))
        XCTAssertNil(buffer.take(now: now.addingTimeInterval(3.001)))
        buffer.clear(); XCTAssertNil(buffer.startedAt); XCTAssertFalse(buffer.discarded)
    }
    func testObserveGridFitsWidthButNeverReflowsOrShrinksBelowMinimum() {
        let full = TerminalGridLayout.observe(cols: 200, rows: 120, viewportWidth: 2000, baseFont: 12, minimumFont: 8, cellWidth: 7.2, cellHeight: 15)
        XCTAssertEqual(full.fontSize, 12); XCTAssertEqual(full.width, 1440, accuracy: 0.01); XCTAssertEqual(full.height, 1800)
        let fit = TerminalGridLayout.observe(cols: 200, rows: 120, viewportWidth: 1200, baseFont: 12, minimumFont: 8, cellWidth: 7.2, cellHeight: 15)
        XCTAssertEqual(fit.fontSize, 10, accuracy: 0.01); XCTAssertEqual(fit.width, 1200, accuracy: 0.01)
        let small = TerminalGridLayout.observe(cols: 200, rows: 120, viewportWidth: 400, baseFont: 12, minimumFont: 8, cellWidth: 7.2, cellHeight: 15)
        XCTAssertEqual(small.fontSize, 8); XCTAssertGreaterThan(small.width, 400)
        XCTAssertEqual(small.width / small.height, full.width / full.height, accuracy: 0.0001)
        let phone = TerminalGridLayout.observe(cols: 200, rows: 120, viewportWidth: 390, baseFont: 10, minimumFont: 6, cellWidth: 6, cellHeight: 12)
        XCTAssertEqual(phone.fontSize, 6); XCTAssertEqual(phone.width, 720)
        let control = TerminalGridLayout.control(viewport: CGSize(width: 600, height: 360), cellWidth: 6, cellHeight: 12)
        XCTAssertEqual(control.cols, 100); XCTAssertEqual(control.rows, 30)
        let tiny = TerminalGridLayout.control(viewport: .zero, cellWidth: 6, cellHeight: 12)
        XCTAssertEqual(tiny.cols, 40); XCTAssertEqual(tiny.rows, 10)
        let huge = TerminalGridLayout.control(viewport: CGSize(width: 9000, height: 9000), cellWidth: 6, cellHeight: 12)
        XCTAssertEqual(huge.cols, 320); XCTAssertEqual(huge.rows, 200)
    }
    @MainActor func testDemoOutputIsColoredAndBufferedUntilSurfaceMounts() {
        let client = TerminalStreamClient(); client.showDemo()
        XCTAssertEqual(client.state, .live(mode: .observe, cols: 100, rows: 30))
        var bytes = Data(); let owner = UUID()
        client.attachOutput(owner: owner) { bytes.append($0) }
        XCTAssertTrue(String(decoding: bytes, as: UTF8.self).contains("\u{1b}[38;5;141m"))
        XCTAssertTrue(String(decoding: bytes, as: UTF8.self).contains("Claude Code"))
        // Dismantling an old renderer must not remove the new renderer's output sink.
        client.detachOutput(owner: UUID())
        XCTAssertNotNil(client.onOutput)
        client.detachOutput(owner: owner); XCTAssertNil(client.onOutput)
        client.close()
    }
    func testSlowButtonStartHasNoDiscardNoticeButTypedEscDoes() {
        let now = Date(timeIntervalSince1970: 1000)
        var buffer = TerminalStartBuffer(); buffer.begin(now: now)
        XCTAssertTrue(buffer.append(Data(), now: now.addingTimeInterval(5)))
        XCTAssertEqual(buffer.take(now: now.addingTimeInterval(5)), Data())
        XCTAssertFalse(buffer.discarded)
        buffer.begin(now: now); XCTAssertTrue(buffer.append(Data([27]), now: now))
        XCTAssertNil(buffer.take(now: now.addingTimeInterval(5))); XCTAssertTrue(buffer.discarded)
    }
    func testRetryBackoffSurvivesShortReadyBurstsAndThreeRefusalsStop() {
        var retry = TerminalReconnectPolicy()
        XCTAssertEqual((0..<7).map { _ in retry.failed(status: 101, code: nil) }, [1,2,4,8,15,15,15])
        XCTAssertEqual(retry.failed(status: 0, code: nil, stable: true), 1)
        XCTAssertEqual(retry.failed(status: 409, code: "TERMINAL_REFUSED"), 2)
        XCTAssertEqual(retry.failed(status: 409, code: "TERMINAL_REFUSED"), 4)
        XCTAssertNil(retry.failed(status: 409, code: "TERMINAL_REFUSED"))
        XCTAssertNotNil(retry.failed(status: 500, code: nil))
        XCTAssertEqual(retry.refusals, 0)
    }
    @MainActor func testResizeRebuildsOnlyObserveGridAndRequestsFreshRedraw() {
        XCTAssertEqual(TerminalStreamEvent.parse(#"{"type":"resize","cols":80,"rows":24}"#), .resize(cols: 80, rows: 24))
        XCTAssertNil(TerminalStreamEvent.parse(#"{"type":"resize","cols":0,"rows":24}"#))
        let client = TerminalStreamClient()
        client.accept(.ready(mode: .observe, cols: 200, rows: 120, expiresAt: nil))
        let before = client.outputGeneration
        client.attachOutput(owner: UUID()) { _ in }
        client.accept(.resize(cols: 80, rows: 24))
        XCTAssertEqual(client.grid.cols, 80); XCTAssertEqual(client.grid.rows, 24)
        XCTAssertNotEqual(client.outputGeneration, before); XCTAssertNil(client.onOutput)
        client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        let controlGeneration = client.outputGeneration
        client.accept(.resize(cols: 80, rows: 24))
        XCTAssertEqual(client.outputGeneration, controlGeneration); XCTAssertEqual(client.grid.cols, 100)
        client.dispose()
    }
    func testLeasePresentationUsesStoreExpiryAndReconnectCannotInterruptControlStart() {
        let now = Date(timeIntervalSince1970: 1000)
        XCTAssertFalse(TerminalPresentation.holdsLease(nil, now: now))
        XCTAssertFalse(TerminalPresentation.holdsLease(TerminalLease(leaseId: "L", expiresAt: 1_000_000), now: now))
        XCTAssertTrue(TerminalPresentation.holdsLease(TerminalLease(leaseId: "L", expiresAt: 1_000_001), now: now))
        XCTAssertFalse(TerminalPresentation.canReconnect(starting: true, ending: false, controlling: false))
        XCTAssertFalse(TerminalPresentation.canReconnect(starting: false, ending: true, controlling: false))
        XCTAssertFalse(TerminalPresentation.canReconnect(starting: false, ending: false, controlling: true))
        XCTAssertTrue(TerminalPresentation.canReconnect(starting: false, ending: false, controlling: false))
    }
    func testScrollerDragStopsFollowingButProgrammaticAndLayoutScrollDoNot() {
        XCTAssertTrue(TerminalPresentation.pausesFollowing(userScroll: true, programmatic: false, layingOut: false))
        XCTAssertFalse(TerminalPresentation.pausesFollowing(userScroll: true, programmatic: true, layingOut: false))
        XCTAssertFalse(TerminalPresentation.pausesFollowing(userScroll: true, programmatic: false, layingOut: true))
        XCTAssertEqual(TerminalPresentation.renderScale(zoom: 3, screen: 3), 9)
        XCTAssertEqual(TerminalPresentation.renderScale(zoom: 0.6, screen: 3), 3)
    }
    @MainActor func testDisposeBreaksCallbackCyclesAndReleasesClientAndSession() async {
        weak var weakClient: TerminalStreamClient?
        weak var weakSession: URLSession?
        do {
            let session = URLSession(configuration: .ephemeral)
            let client = TerminalStreamClient(session: session)
            weakClient = client; weakSession = session
            client.onReady = { [client] _ in client.close() }
            client.onLease = { [client] _ in client.close() }
            client.onControlEnded = { [client] in client.close() }
            client.dispose()
        }
        for _ in 0..<100 { if weakSession == nil { break }; await Task.yield() }
        XCTAssertNil(weakClient); XCTAssertNil(weakSession)
    }
    @MainActor func testDemoBoxHasEqualTerminalCellWidths() {
        let client = TerminalStreamClient(); client.showDemo()
        var text = ""
        client.attachOutput(owner: UUID()) { text += String(decoding: $0, as: UTF8.self) }
        let plain = text.replacingOccurrences(of: "\u{1b}\\[[0-9;]*m", with: "", options: .regularExpression).replacingOccurrences(of: "\u{1b}c", with: "")
        let lines = plain.components(separatedBy: "\r\n").prefix(3)
        let widths = lines.map { line in line.unicodeScalars.reduce(0) { $0 + ((0xAC00...0xD7A3).contains($1.value) ? 2 : 1) } }
        XCTAssertEqual(widths, [46,46,46]); client.dispose()
    }
    @MainActor func testMacCanvasStartsAtTopSystemFontAndResizePreservesApplicationCursor() {
        #if os(macOS)
        XCTAssertTrue(TerminalDocumentCanvas().isFlipped)
        XCTAssertEqual(TerminalSurfaceHost.font(12).fontName, NSFont.monospacedSystemFont(ofSize: 12, weight: .regular).fontName)
        let view = SwiftTerm.TerminalView(frame: CGRect(x: 0, y: 0, width: 800, height: 500), font: TerminalSurfaceHost.font(12))
        view.feed(text: "\u{1b}[?1h\u{1b}[?25l\u{1b}[31m")
        XCTAssertTrue(view.getTerminal().applicationCursor)
        TerminalRenderer.resize(view, cols: 90, rows: 25)
        XCTAssertTrue(view.getTerminal().applicationCursor)
        XCTAssertEqual(view.getTerminal().cols, 90); XCTAssertEqual(view.getTerminal().rows, 25)
        #endif
    }
    @MainActor func testInternalSwiftTermScrollStopsFollowingAndFeedKeepsHistoryPosition() async {
        #if os(macOS)
        let client = TerminalStreamClient()
        var following = true
        let parent = TerminalRepresentable(client: client, mode: .observe, cols: 100, rows: 30,
            following: Binding(get: { following }, set: { following = $0 }), onTypeWhileObserving: { _ in }, onSize: { _,_ in })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 500), coordinator: coordinator)
        coordinator.host = host
        defer { host.teardown(); client.dispose() }
        host.feed(Data((0..<100).map { "line \($0)\r\n" }.joined().utf8))
        host.followCursor()
        XCTAssertTrue(following, "Parser/layout/programmatic scroll must preserve following")
        host.terminal.scroll(toPosition: 0.3) // SwiftTerm's own scroller and keyboard path.
        XCTAssertFalse(following)
        let position = host.terminal.getTerminal().getTopVisibleRow()
        host.feed(Data("new output\r\n".utf8))
        try? await Task.sleep(for: .milliseconds(60))
        XCTAssertFalse(following)
        XCTAssertEqual(host.terminal.getTerminal().getTopVisibleRow(), position)
        #endif
    }
    @MainActor func testMacEscAndTabAreTerminalInputWhileObserving() {
        #if os(macOS)
        let client = TerminalStreamClient()
        var typed = Data()
        let parent = TerminalRepresentable(client: client, mode: .observe, cols: 100, rows: 30, following: .constant(true), onTypeWhileObserving: { typed.append($0) }, onSize: { _,_ in })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let view = TerminalCanvas(frame: CGRect(x: 0,y: 0,width: 800,height: 500), font: TerminalSurfaceHost.font(12))
        view.terminalDelegate = coordinator
        view.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
        view.doCommand(by: #selector(NSResponder.insertTab(_:)))
        XCTAssertEqual(typed, Data([27,9]))
        client.dispose()
        #endif
    }
    @MainActor func testBackgroundReleaseSurvivesCallerCancellationAndDuplicateCloseCoalesces() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        let member = try XCTUnwrap(store.members.first)
        let claimed = await store.claimTerminal(member); XCTAssertTrue(claimed)
        let entered = expectation(description: "release in flight"), gate = DispatchSemaphore(value: 0)
        server.change { $0.gate = gate; $0.entered = entered }
        let background = Task { await store.releaseTerminal(member) }
        await fulfillment(of: [entered], timeout: 3)
        background.cancel()
        let close = Task { await store.releaseTerminal(member) }
        await Task.yield(); gate.signal()
        let released = await background.value, closed = await close.value
        XCTAssertTrue(released); XCTAssertTrue(closed)
        XCTAssertNil(store.terminalLeases[member.id]); XCTAssertNil(store.errorMessage)
        XCTAssertEqual(server.read { $0.terminalBodies.filter { $0["action"] as? String == "release" }.count }, 1)
        store.disconnect()
    }

    func testRefusalProbeKeepsServerReasonAndCode() async throws {
        let network = try IsolatedTestNetwork { _ in
            IsolatedTestHTTPReply(status: 409, data: Data(#"{"error":"실행이 꺼져 있습니다","code":"TERMINAL_REFUSED"}"#.utf8))
        }
        let api = APIClient(endpoint: network.endpoint, accessCode: "test", session: network.session)
        let refusal = await api.terminalStreamRefusal(memberID: "m")
        XCTAssertEqual(refusal?.status, 409); XCTAssertEqual(refusal?.code, "TERMINAL_REFUSED")
        XCTAssertEqual(refusal?.message, "실행이 꺼져 있습니다")
    }
    @MainActor func testStrictReleaseOfServerExpiredLeaseIsSuccessWithoutFalseError() async throws {
        let server = WriteTestServer()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path.hasSuffix("/terminal/control") == true,
               let body = try? WriteTestServer.body(request), body["action"] as? String == "release" {
                let receipt = OperationReceipt(operationId: body["operationId"] as! String, kind: .terminalControl, memberId: "m", status: .refused,
                                               code: "TERMINAL_REFUSED", error: "조작권이 만료되었거나 바뀌었습니다")
                return IsolatedTestHTTPReply(data: try JSONEncoder().encode(receipt))
            }
            return try server.handle(request)
        }
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        let member = try XCTUnwrap(store.members.first)
        let claimed = await store.claimTerminal(member); XCTAssertTrue(claimed)
        let released = await store.releaseTerminal(member); XCTAssertTrue(released)
        XCTAssertNil(store.terminalLeases[member.id]); XCTAssertNil(store.errorMessage)
        store.disconnect()
    }

}
