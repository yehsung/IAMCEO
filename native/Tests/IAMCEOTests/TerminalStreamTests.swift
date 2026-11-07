import Foundation
import XCTest
import SwiftUI
import SwiftTerm
@testable import IAMCEO

final class TerminalStreamTests: XCTestCase {
    func testPlatformPoliciesAndPureGridSelection() {
        XCTAssertEqual(TerminalPlatform.mac.controlSizePolicy, .core)
        XCTAssertEqual(TerminalPlatform.iPhone.controlSizePolicy, .fit)
        XCTAssertTrue(TerminalPlatform.mac.startsOnTyping)
        XCTAssertFalse(TerminalPlatform.iPhone.startsOnTyping)
        XCTAssertTrue(TerminalPlatform.mac.acceptsKeyboard(mode: .observe))
        XCTAssertFalse(TerminalPlatform.iPhone.acceptsKeyboard(mode: .observe))
        XCTAssertTrue(TerminalPlatform.iPhone.acceptsKeyboard(mode: .control))
        XCTAssertEqual(TerminalPlatform.iPhone.observeHint, "입력하려면 '입력 시작'을 누르세요")
        XCTAssertEqual(TerminalPlatform.mac.observeHint, "키를 누르면 바로 입력합니다")
        for viewport in [CGSize(width: 800, height: 500), CGSize(width: 390, height: 300)] {
            for mode in [TerminalStreamMode.observe, .control] {
                let grid = TerminalGridLayout.grid(platform: .mac, mode: mode, cols: 160, rows: 50,
                    viewport: viewport, cellWidth: 7.2, cellHeight: 15)
                XCTAssertEqual(grid.cols, 160); XCTAssertEqual(grid.rows, 50)
            }
            let observing = TerminalGridLayout.grid(platform: .iPhone, mode: .observe, cols: 160, rows: 50,
                viewport: viewport, cellWidth: 6, cellHeight: 12)
            XCTAssertEqual(observing.cols, 160); XCTAssertEqual(observing.rows, 50)
            let control = TerminalGridLayout.grid(platform: .iPhone, mode: .control, cols: 160, rows: 50,
                viewport: viewport, cellWidth: 6, cellHeight: 12)
            XCTAssertEqual(control.cols, Int(viewport.width / 6)); XCTAssertEqual(control.rows, Int(viewport.height / 12))
        }
    }
    func testPlatformSizePolicyIsSentInRequest() async throws {
        let api = APIClient(endpoint: try ServerEndpoint("http://127.0.0.1:7881"), accessCode: "test")
        for platform in [TerminalPlatform.mac, .iPhone] {
            let request = try await api.terminalStreamRequest(memberID: "m", mode: .control, cols: 65, rows: 25,
                leaseID: "lease", sizePolicy: platform.controlSizePolicy)
            let url = try XCTUnwrap(request.url)
            let items = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
            XCTAssertEqual(items.first { $0.name == "size" }?.value, platform == .mac ? "core" : "fit")
        }
    }
    @MainActor func testMacControlKeepsObserveGridFontAndScaleAcrossWindowAndCoreResize() {
        #if os(macOS)
        let client = TerminalStreamClient()
        let parent = TerminalRepresentable(client: client, mode: .observe, cols: 160, rows: 50,
            following: .constant(true), onTypeWhileObserving: { _ in }, onSize: { _,_ in XCTFail("Mac must not propose a fit grid") })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 500), coordinator: coordinator)
        coordinator.host = host
        defer { host.teardown(); client.dispose() }
        host.layoutSubtreeIfNeeded(); host.layout()
        let canvas = host.documentView!
        let observeFrame = canvas.frame.size, observeBounds = canvas.bounds.size
        let font = host.terminal.font
        coordinator.parent = TerminalRepresentable(client: client, mode: .control, cols: 160, rows: 50,
            following: .constant(true), onTypeWhileObserving: { _ in XCTFail("Already controlling") }, onSize: { _,_ in XCTFail("No fit resize") })
        host.layout()
        XCTAssertEqual(canvas.frame.size, observeFrame); XCTAssertEqual(canvas.bounds.size, observeBounds)
        XCTAssertEqual(host.terminal.font, font)
        XCTAssertEqual(host.terminal.getTerminal().cols, 160); XCTAssertEqual(host.terminal.getTerminal().rows, 50)
        host.frame.size = CGSize(width: 640, height: 400); host.layout()
        XCTAssertEqual(host.terminal.getTerminal().cols, 160); XCTAssertEqual(host.terminal.getTerminal().rows, 50)
        coordinator.parent = TerminalRepresentable(client: client, mode: .control, cols: 180, rows: 60,
            following: .constant(true), onTypeWhileObserving: { _ in }, onSize: { _,_ in XCTFail("No fit resize") })
        host.layout()
        XCTAssertEqual(host.terminal.getTerminal().cols, 180); XCTAssertEqual(host.terminal.getTerminal().rows, 60)
        client.accept(.ready(mode: .control, cols: 180, rows: 60, expiresAt: nil))
        client.accept(.resize(cols: 160, rows: 50))
        host.feed(Data("paint after server resize".utf8)) // Before SwiftUI updates coordinator.parent.
        XCTAssertEqual(host.terminal.getTerminal().cols, 160); XCTAssertEqual(host.terminal.getTerminal().rows, 50)
        #endif
    }
    @MainActor func testIOSObserverCannotFocusOrShowAccessoryOrStartInput() {
        #if os(iOS)
        let client = TerminalStreamClient()
        let parent = TerminalRepresentable(client: client, mode: .observe, cols: 160, rows: 50,
            following: .constant(true), onTypeWhileObserving: { _ in XCTFail("iPhone input requires the button") }, onSize: { _,_ in })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 390, height: 500), coordinator: coordinator)
        coordinator.host = host
        defer { client.dispose() }
        XCTAssertFalse(host.terminal.canBecomeFirstResponder)
        XCTAssertFalse(host.terminal.becomeFirstResponder())
        XCTAssertNil(host.terminal.inputAccessoryView)
        coordinator.send(source: host.terminal, data: Array("ignored".utf8)[...])
        coordinator.parent = TerminalRepresentable(client: client, mode: .control, cols: 65, rows: 25,
            following: .constant(true), onTypeWhileObserving: { _ in XCTFail() }, onSize: { _,_ in })
        host.updateInputMode()
        XCTAssertTrue(host.terminal.canBecomeFirstResponder); XCTAssertNotNil(host.terminal.inputAccessoryView)
        coordinator.parent = parent; host.updateInputMode()
        XCTAssertFalse(host.terminal.canBecomeFirstResponder); XCTAssertFalse(host.terminal.isFirstResponder)
        XCTAssertNil(host.terminal.inputAccessoryView)
        #endif
    }
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
    @MainActor func testResizeRebuildsObserveButPreservesControlRendererAndInput() {
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
        client.attachOutput(owner: UUID()) { _ in }
        client.accept(.resize(cols: 80, rows: 24))
        XCTAssertEqual(client.outputGeneration, controlGeneration); XCTAssertEqual(client.grid.cols, 80)
        XCTAssertNotNil(client.onOutput)
        XCTAssertEqual(client.grid.rows, 24)
        XCTAssertEqual(client.state, .live(mode: .control, cols: 80, rows: 24))
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
    @MainActor func testKeyboardSwiftTermScrollStopsFollowingAndFeedKeepsHistoryPosition() async throws {
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
        host.terminal.scroll(toPosition: 0.3) // A position change alone is not evidence of user input.
        XCTAssertTrue(following)
        host.followCursor()
        func pageKey(_ code: Int) throws -> NSEvent {
            let characters = String(try XCTUnwrap(UnicodeScalar(code)))
            return try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .function,
                timestamp: 0, windowNumber: 0, context: nil, characters: characters,
                charactersIgnoringModifiers: characters, isARepeat: false, keyCode: 0))
        }
        host.handleObservedKey(try pageKey(NSPageDownFunctionKey))
        XCTAssertTrue(following, "Scrolling down or remaining at the bottom must preserve following")
        host.handleObservedKey(try pageKey(NSPageUpFunctionKey))
        XCTAssertFalse(following)
        let position = host.terminal.getTerminal().getTopVisibleRow()
        host.feed(Data("new output\r\n".utf8))
        try? await Task.sleep(for: .milliseconds(60))
        XCTAssertFalse(following)
        XCTAssertEqual(host.terminal.getTerminal().getTopVisibleRow(), position)
        #endif
    }
    @MainActor func testScrollerActionStopsFollowingOnlyWhenMovingUp() throws {
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
        let internalScroller = try XCTUnwrap(host.terminal.subviews.compactMap { $0 as? NSScroller }.first)
        XCTAssertTrue(internalScroller.target is TerminalScrollAction)
        XCTAssertTrue(host.verticalScroller?.target is TerminalScrollAction)
        let target = TerminalTestScrollTarget { host.terminal.scroll(toPosition: $0.doubleValue) }
        let scroller = NSScroller()
        scroller.target = target; scroller.action = #selector(TerminalTestScrollTarget.scroll(_:))
        let action = TerminalScrollAction(scroller: scroller, coordinator: coordinator)
        scroller.doubleValue = 1
        action.scroll(scroller)
        XCTAssertTrue(following)
        scroller.doubleValue = 0.3
        action.scroll(scroller)
        XCTAssertFalse(following)
        #endif
    }
    @MainActor func testUserScrollInEitherModeKeepsBothHistoryAndViewportAcrossOutputAndCanResume() async throws {
        #if os(macOS)
        for mode in [TerminalStreamMode.observe, .control] {
            for internalHistory in [true, false] {
                let client = TerminalStreamClient()
                var following = true
                let parent = TerminalRepresentable(client: client, mode: mode, cols: 160, rows: 50,
                    following: Binding(get: { following }, set: { following = $0 }), onTypeWhileObserving: { _ in }, onSize: { _,_ in })
                let coordinator = TerminalSurfaceCoordinator(parent)
                let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 300), coordinator: coordinator)
                coordinator.host = host
                defer { host.teardown(); client.dispose() }
                host.feed(Data((0..<150).map { "line \($0)\r\n" }.joined().utf8))
                host.followCursor()
                XCTAssertTrue(following, "Output and programmatic scrolling preserve following in \(mode)")
                let before = host.scrollLocation
                XCTAssertGreaterThan(before.viewportY, 0, "Following must reach the cursor before the display timer runs")
                XCTAssertGreaterThan(before.historyRow, 0, "Exercise a terminal with real scrollback")
                let wiredScroller = internalHistory
                    ? host.terminal.subviews.compactMap { $0 as? NSScroller }.first : host.verticalScroller
                XCTAssertTrue(try XCTUnwrap(wiredScroller).target is TerminalScrollAction)
                let target = TerminalTestScrollTarget { scroller in
                    if internalHistory { host.terminal.scroll(toPosition: scroller.doubleValue) }
                    else {
                        host.contentView.scroll(to: CGPoint(x: 0, y: 0))
                        host.reflectScrolledClipView(host.contentView)
                    }
                }
                let scroller = NSScroller()
                scroller.target = target; scroller.action = #selector(TerminalTestScrollTarget.scroll(_:))
                let action = TerminalScrollAction(scroller: scroller, coordinator: coordinator)
                scroller.doubleValue = 0.3
                action.scroll(scroller)
                XCTAssertTrue(host.scrollLocation.isAbove(before), "Exercise actual upward movement on each axis")
                XCTAssertFalse(following, "User scrolling must pause following in \(mode)")
                let paused = host.scrollLocation
                host.feed(Data("new output\r\n".utf8))
                try? await Task.sleep(for: .milliseconds(60))
                XCTAssertFalse(following)
                XCTAssertEqual(host.scrollLocation.historyRow, paused.historyRow)
                XCTAssertEqual(host.scrollLocation.viewportY, paused.viewportY, accuracy: 0.5)
                host.feed(Data("more output\r\n".utf8))
                try? await Task.sleep(for: .milliseconds(60))
                XCTAssertFalse(following)
                XCTAssertEqual(host.scrollLocation.historyRow, paused.historyRow)
                XCTAssertEqual(host.scrollLocation.viewportY, paused.viewportY, accuracy: 0.5)
                following = true // The shared '맨 아래로' button resumes either mode.
                host.followCursor()
                XCTAssertGreaterThan(host.scrollLocation.historyRow, paused.historyRow)
                XCTAssertGreaterThan(host.scrollLocation.viewportY, 0)
            }
        }
        #endif
    }
    @MainActor func testOuterScrollPreservesVisibleTextWhenHistoryFillsAndRecycles() async throws {
        #if os(macOS)
        for mode in [TerminalStreamMode.observe, .control] {
            for initialLines in [4980, 5200] {
                let client = TerminalStreamClient()
                var following = true
                let parent = TerminalRepresentable(client: client, mode: mode, cols: 160, rows: 50,
                    following: Binding(get: { following }, set: { following = $0 }), onTypeWhileObserving: { _ in }, onSize: { _,_ in })
                let coordinator = TerminalSurfaceCoordinator(parent)
                let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 300), coordinator: coordinator)
                coordinator.host = host
                defer { host.teardown(); client.dispose() }
                func output(_ range: Range<Int>) {
                    host.feed(Data(range.map { "numbered line \($0)\r\n" }.joined().utf8))
                }
                func visibleText() -> [String] {
                    // The outer viewport is at its top; these are its first ten displayed lines.
                    (0..<10).map { host.terminal.getTerminal().getLine(row: $0)?.translateToString(trimRight: true) ?? "missing" }
                }
                output(0..<initialLines)
                host.followCursor()
                XCTAssertEqual(host.terminal.getTerminal().options.scrollback, 5000)
                let engine = host.terminal.getTerminal()
                let before = host.scrollLocation
                coordinator.performUserScroll {
                    host.contentView.scroll(to: .zero)
                    host.reflectScrolledClipView(host.contentView)
                }
                XCTAssertFalse(following)
                XCTAssertGreaterThan(before.viewportY, host.scrollLocation.viewportY)
                let text = visibleText(), paused = host.scrollLocation
                XCTAssertTrue(text.allSatisfy { $0.hasPrefix("numbered line ") })
                let trimmed = engine.buffer.totalLinesTrimmed
                for range in [initialLines..<(initialLines + 100), (initialLines + 100)..<(initialLines + 127),
                              (initialLines + 127)..<(initialLines + 187)] {
                    output(range)
                    try? await Task.sleep(for: .milliseconds(60))
                    XCTAssertFalse(following)
                    XCTAssertEqual(visibleText(), text, "Visible content must survive recycling in \(mode), initial=\(initialLines)")
                    XCTAssertEqual(host.scrollLocation.historyRow, paused.historyRow - (engine.buffer.totalLinesTrimmed - trimmed))
                    XCTAssertEqual(host.scrollLocation.viewportY, paused.viewportY, accuracy: 0.5)
                }
                XCTAssertGreaterThan(engine.buffer.totalLinesTrimmed, trimmed, "Exercise actual history recycling")
                following = true
                host.followCursor()
                let resumed = engine.getTopVisibleRow()
                output((initialLines + 187)..<(initialLines + 188))
                XCTAssertEqual(engine.getTopVisibleRow(), resumed, "At capacity, resuming clears the engine's manual-scroll flag")
                // If all anchored content has expired, remain paused at available history;
                // the shared paused overlay offers '새 출력이 있습니다 · 맨 아래로'.
                following = false
                output(10000..<16000)
                XCTAssertEqual(engine.getTopVisibleRow(), 0)
                XCTAssertFalse(following)
            }
        }
        #endif
    }
    @MainActor func testSynchronizedOutputKeepsViewportUntilEndOrTimeout() async {
        #if os(macOS)
        for mode in [TerminalStreamMode.observe, .control] {
            for timeout in [false, true] {
                let client = TerminalStreamClient()
                let parent = TerminalRepresentable(client: client, mode: mode, cols: 160, rows: 50,
                    following: .constant(true), onTypeWhileObserving: { _ in }, onSize: { _,_ in })
                let coordinator = TerminalSurfaceCoordinator(parent)
                let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 300), coordinator: coordinator)
                coordinator.host = host
                defer { host.teardown(); client.dispose() }
                host.feed(Data("\u{1b}[50;1H".utf8))
                host.followCursor()
                try? await Task.sleep(for: .milliseconds(60))
                let displayedCaret = host.terminal.caretFrame
                let displayed = host.scrollLocation.viewportY
                XCTAssertGreaterThan(displayed, 0)
                host.feed(Data("\u{1b}[?2026h\u{1b}[1;1H".utf8))
                host.followCursor() // All callers must honor the synchronized-output guard.
                try? await Task.sleep(for: .milliseconds(80))
                XCTAssertTrue(host.terminal.getTerminal().synchronizedOutputActive)
                XCTAssertEqual(host.scrollLocation.viewportY, displayed, accuracy: 0.5)
                XCTAssertEqual(host.terminal.caretFrame, displayedCaret, "The displayed cursor stays at the last completed frame")
                if timeout { try? await Task.sleep(for: .milliseconds(1150)) }
                else {
                    host.feed(Data("\u{1b}[?2026l".utf8))
                    try? await Task.sleep(for: .milliseconds(80))
                }
                XCTAssertFalse(host.terminal.getTerminal().synchronizedOutputActive)
                XCTAssertEqual(host.scrollLocation.viewportY, 0, accuracy: 0.5)
                XCTAssertNotEqual(host.terminal.caretFrame, displayedCaret, "Display and viewport catch up after synchronization")
            }
        }
        #endif
    }
    @MainActor func testFollowCursorUsesParserRowBeforeDeferredCaretDisplay() {
        #if os(macOS)
        for mode in [TerminalStreamMode.observe, .control] {
            let client = TerminalStreamClient()
            let parent = TerminalRepresentable(client: client, mode: mode, cols: 160, rows: 50,
                following: .constant(true), onTypeWhileObserving: { _ in }, onSize: { _,_ in })
            let coordinator = TerminalSurfaceCoordinator(parent)
            let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 300), coordinator: coordinator)
            coordinator.host = host
            defer { host.teardown(); client.dispose() }
            host.feed(Data((0..<150).map { "line \($0)\r\n" }.joined().utf8))
            host.followCursor()
            XCTAssertGreaterThan(host.scrollLocation.viewportY, 0)
            host.feed(Data("\u{1b}[1;1H".utf8))
            host.followCursor()
            XCTAssertEqual(host.scrollLocation.viewportY, 0, accuracy: 0.5, "Follow the new cursor row synchronously")
            host.feed(Data("\u{1b}[50;1H".utf8))
            host.followCursor()
            XCTAssertGreaterThan(host.scrollLocation.viewportY, 0, "Resume at the bottom without waiting for paint")
        }
        #endif
    }
    @MainActor func testSynchronizedOutputTimeoutWithoutUserScrollPreservesFollowing() async {
        #if os(macOS)
        for prefix in ["", (0..<100).map { "line \($0)\r\n" }.joined(), "\u{1b}[?1049h"] {
            let client = TerminalStreamClient()
            var following = true
            let parent = TerminalRepresentable(client: client, mode: .observe, cols: 100, rows: 30,
                following: Binding(get: { following }, set: { following = $0 }), onTypeWhileObserving: { _ in }, onSize: { _,_ in })
            let coordinator = TerminalSurfaceCoordinator(parent)
            let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 500), coordinator: coordinator)
            coordinator.host = host
            defer { host.teardown(); client.dispose() }
            host.feed(Data((prefix + "\u{1b}[?2026hhello").utf8))
            XCTAssertTrue(host.terminal.getTerminal().synchronizedOutputActive)
            XCTAssertTrue(following)
            try? await Task.sleep(for: .milliseconds(1250))
            XCTAssertFalse(host.terminal.getTerminal().synchronizedOutputActive, "Exercise SwiftTerm's real timeout")
            XCTAssertTrue(following, "Timeout notifications in normal, scrollback and alternate buffers are output")
            host.feed(Data("more output\r\n".utf8))
            XCTAssertTrue(following)
        }
        #endif
    }
    func testOnlyUpwardViewportOrHistoryMovementCountsAsScrollingUp() {
        let before = TerminalScrollLocation(viewportY: 100, historyRow: 70)
        XCTAssertTrue(TerminalScrollLocation(viewportY: 90, historyRow: 70).isAbove(before))
        XCTAssertTrue(TerminalScrollLocation(viewportY: 100, historyRow: 69).isAbove(before))
        XCTAssertFalse(before.isAbove(before))
        XCTAssertFalse(TerminalScrollLocation(viewportY: 110, historyRow: 71).isAbove(before))
        let bounced = TerminalScrollLocation.viewportY(120, minimum: 0, maximum: 100)
        let settled = TerminalScrollLocation.viewportY(100, minimum: 0, maximum: 100)
        XCTAssertEqual(bounced, settled, "Bottom-edge bounce must not look like an upward user scroll")
        XCTAssertEqual(TerminalScrollLocation.viewportY(-10, minimum: 0, maximum: 100), 0)
        XCTAssertEqual(TerminalScrollLocation.viewportY(0, minimum: 0, maximum: -50), 0)
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

#if os(macOS)
@MainActor private final class TerminalTestScrollTarget: NSObject {
    let onScroll: (NSScroller) -> Void
    init(_ onScroll: @escaping (NSScroller) -> Void) { self.onScroll = onScroll }
    @objc func scroll(_ sender: NSScroller) { onScroll(sender) }
}
#endif
