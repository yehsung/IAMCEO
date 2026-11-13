import Foundation
import XCTest
import SwiftUI
import SwiftTerm
@testable import IAMCEO

final class TerminalStreamTests: XCTestCase {
    @MainActor func testActivityIsKeyWindowOnlyAndAtMostOncePerThirtySeconds() async throws {
        var texts: [String] = []
        let client = TerminalStreamClient(messageSender: { if case let .string(text) = $0 { texts.append(text) } })
        defer { client.dispose() }
        client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        let now = Date()
        client.activity(windowIsKey: false, now: now)
        client.activity(windowIsKey: true, now: now)
        client.activity(windowIsKey: true, now: now.addingTimeInterval(29.999))
        client.activity(windowIsKey: false, now: now.addingTimeInterval(30))
        client.activity(windowIsKey: true, now: now.addingTimeInterval(30))
        // 보내기는 작업으로 돈다. 정해진 양보 횟수 대신 두 번이 실제로 나갈 때까지 기다린다(느린 CI 러너).
        await pollUntil("활동 신호 두 번") { texts.count >= 2 }
        XCTAssertEqual(texts, [#"{"type":"activity"}"#, #"{"type":"activity"}"#])
        client.accept(.ready(mode: .observe, cols: 100, rows: 30, expiresAt: nil))
        client.activity(windowIsKey: true, now: now.addingTimeInterval(60))
        // 보내면 안 되는 쪽이라 넉넉히 기다린다.
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(texts.count, 2)
    }

    @MainActor func testInputCoalescesInOrderAndSerializesLaterFrames() async throws {
        var frames: [Data] = [], sending = 0
        let client = TerminalStreamClient(messageSender: { message in
            if case let .data(bytes) = message {
                sending += 1
                if frames.isEmpty { try await Task.sleep(for: .milliseconds(35)) }
                frames.append(bytes)
            }
        })
        defer { client.dispose() }
        client.accept(.ready(mode: .control, cols: 100, rows: 30, expiresAt: nil))
        client.send(Data("a".utf8)); client.send(Data("b".utf8)); client.send(Data([27, 91, 65]))
        // 첫 묶음(8ms 묶음 창)이 보내는 중이 된 뒤에 다음 글을 친다. 고정 15ms 는 느린 CI 러너에서 묶음 창보다 먼저 끝날 수 있다.
        await pollUntil("첫 입력 묶음을 보내기 시작함") { sending >= 1 }
        client.send(Data("c".utf8)); client.send(Data("d".utf8))
        // Wait for the second frame rather than a fixed time: a loaded machine (CI) takes longer than the sender's 35 ms.
        await pollUntil("두 번째 입력 묶음") { frames.count >= 2 }
        try await Task.sleep(for: .milliseconds(200)) // a third frame would be a failure: give it ample time to show up
        XCTAssertEqual(frames, [Data([97, 98, 27, 91, 65]), Data("cd".utf8)])
        client.send(Data("must not leak".utf8)); client.close()
        try await Task.sleep(for: .milliseconds(200)) // 닫은 뒤에는 나가면 안 되는 쪽이라 넉넉히 기다린다.
        XCTAssertEqual(frames.count, 2)
    }

    @MainActor func testControlTransportRetriesOriginalLeaseOnlyOnceThenEnds() async throws {
        let network = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 503) }
        var receives = 0, leases: [String] = [], endings = 0
        let client = TerminalStreamClient(session: network.session, receiveMessage: { request in
            receives += 1
            let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            leases.append(items?.first { $0.name == "lease" }?.value ?? "")
            if receives == 1 || receives == 3 {
                return .string(#"{"type":"ready","mode":"control","cols":100,"rows":30}"#)
            }
            throw URLError(.networkConnectionLost)
        })
        let done = expectation(description: "control ended after retry")
        client.onControlEnded = { endings += 1; done.fulfill() }
        client.connect(api: network.makeAPIClient(), memberID: "m", mode: .control, leaseID: "same-lease")
        await fulfillment(of: [done], timeout: 3)
        XCTAssertEqual(receives, 4); XCTAssertEqual(leases, Array(repeating: "same-lease", count: 4)); XCTAssertEqual(endings, 1)
        XCTAssertEqual(client.state, .closed(reason: "disconnected", message: TerminalPresentation.disconnectedStatus))
        client.dispose()
    }

    @MainActor func testControlRefusalDoesNotRetryOrHideServerGuidance() async throws {
        let reason = "다른 기기에서 입력 중입니다"
        let network = try IsolatedTestNetwork { _ in
            IsolatedTestHTTPReply(status: 409, data: Data(#"{"error":"다른 기기에서 입력 중입니다","code":"TERMINAL_REFUSED"}"#.utf8))
        }
        var receives = 0
        let client = TerminalStreamClient(session: network.session, receiveMessage: { _ in
            receives += 1; throw APIError(status: 409, message: reason)
        })
        let ended = expectation(description: "refusal ends control")
        client.onControlEnded = { ended.fulfill() }
        client.connect(api: network.makeAPIClient(), memberID: "m", mode: .control, leaseID: "lease")
        await fulfillment(of: [ended], timeout: 3)
        XCTAssertEqual(receives, 1)
        XCTAssertEqual(client.state, .closed(reason: "disconnected", message: reason))
        client.dispose()
    }

    @MainActor func testUnsupportedRetryStillEndsControlInsteadOfHoldingLease() async throws {
        let network = try IsolatedTestNetwork()
        var receives = 0
        let client = TerminalStreamClient(session: network.session, receiveMessage: { _ in
            receives += 1; throw APIError(status: receives == 1 ? 503 : 404, message: "unavailable")
        })
        let ended = expectation(description: "unsupported retry ends control")
        client.onControlEnded = { ended.fulfill() }
        client.connect(api: network.makeAPIClient(), memberID: "m", mode: .control, leaseID: "lease")
        await fulfillment(of: [ended], timeout: 3)
        XCTAssertEqual(receives, 2)
        XCTAssertEqual(client.state, .closed(reason: "disconnected", message: TerminalPresentation.disconnectedStatus))
        client.dispose()
    }

    @MainActor func testGenerationResetsEngineInPlaceAndObserveResizeKeepsIt() {
        #if os(macOS)
        let client = TerminalStreamClient()
        var following = true
        let parent = TerminalRepresentable(client: client, mode: .observe, cols: 100, rows: 30,
            following: Binding(get: { following }, set: { following = $0 }), onPendingInput: { _ in }, onSize: { _,_ in })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 300), coordinator: coordinator)
        coordinator.host = host
        client.attachOutput(owner: coordinator.outputID) { [weak host] in host?.feed($0) }
        defer { host.teardown(); client.dispose() }
        host.feed(Data("old content".utf8))
        let viewID = ObjectIdentifier(host.terminal), engine = host.terminal.getTerminal(), oldBuffer = engine.buffer
        following = false
        client.accept(.ready(mode: .observe, cols: 80, rows: 24, expiresAt: nil))
        client.onOutput?(Data("first paint".utf8))
        XCTAssertEqual(ObjectIdentifier(host.terminal), viewID); XCTAssertTrue(engine === host.terminal.getTerminal())
        XCTAssertFalse(oldBuffer === engine.buffer); XCTAssertTrue(following)
        XCTAssertEqual(engine.cols, 80); XCTAssertEqual(engine.rows, 24)
        XCTAssertTrue(engine.getLine(row: 0)?.translateToString().hasPrefix("first paint") == true)
        let generation = client.outputGeneration, resizedBuffer = engine.buffer
        client.accept(.resize(cols: 90, rows: 28)); client.onOutput?(Data("more".utf8))
        XCTAssertEqual(client.outputGeneration, generation); XCTAssertNotNil(client.onOutput)
        XCTAssertTrue(resizedBuffer === engine.buffer)
        XCTAssertEqual(engine.cols, 90); XCTAssertEqual(engine.rows, 28)
        #endif
    }

    @MainActor func testMacSingleClickRequestsInputButDoubleClickAndDragSelect() async throws {
        #if os(macOS)
        let client = TerminalStreamClient()
        var requests = 0
        let parent = TerminalRepresentable(client: client, mode: .observe, cols: 100, rows: 30,
            following: .constant(true), onPendingInput: { _ in }, onSize: { _,_ in }, onRequestInput: { _ in requests += 1 })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 500), coordinator: coordinator)
        coordinator.host = host
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.feed(Data("select these words".utf8))
        func event(_ type: NSEvent.EventType, count: Int = 1, x: CGFloat = 20) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: host.terminal.convert(CGPoint(x: x, y: host.terminal.bounds.height - 8), to: nil),
                modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: count, pressure: 1)!
        }
        defer { host.teardown(); window.contentView = nil; client.dispose() }
        XCTAssertTrue(host.acceptsFirstMouse(for: nil)); XCTAssertTrue(host.terminal.acceptsFirstMouse(for: nil))
        host.terminal.mouseDown(with: event(.leftMouseDown)); host.terminal.mouseUp(with: event(.leftMouseUp))
        try await Task.sleep(for: .seconds(NSEvent.doubleClickInterval + 0.05))
        // 느린 CI 러너에서는 타이머가 늦게 돌 수 있어 조건을 기다린다.
        await pollUntil("한 번 클릭의 입력 요청") { requests >= 1 }
        XCTAssertEqual(requests, 1)
        host.terminal.mouseDown(with: event(.leftMouseDown)); host.terminal.mouseUp(with: event(.leftMouseUp))
        host.terminal.mouseDown(with: event(.leftMouseDown, count: 2)); host.terminal.mouseUp(with: event(.leftMouseUp, count: 2))
        // 입력 요청이 '나가지 않는지' 보는 쪽이라 두 번 누름 간격보다 넉넉히 기다린다.
        try await Task.sleep(for: .seconds(NSEvent.doubleClickInterval + 0.3))
        XCTAssertEqual(requests, 1); XCTAssertTrue(host.terminal.selectionActive)
        host.terminal.mouseDown(with: event(.leftMouseDown))
        host.terminal.mouseDragged(with: event(.leftMouseDragged, x: 110)); host.terminal.mouseUp(with: event(.leftMouseUp, x: 110))
        try await Task.sleep(for: .seconds(NSEvent.doubleClickInterval + 0.3))
        XCTAssertEqual(requests, 1); XCTAssertTrue(host.terminal.selectionActive)
        host.feed(Data("new output".utf8))
        XCTAssertTrue(host.terminal.selectionActive, "Output preserves selection when mouse mode is off")
        #endif
    }

    @MainActor func testObserveWheelReachesHistoryAndMouseReportingTracksTUIModeAfterFeed() throws {
        #if os(macOS)
        let client = TerminalStreamClient()
        var following = true
        let parent = TerminalRepresentable(client: client, mode: .observe, cols: 100, rows: 30,
            following: Binding(get: { following }, set: { following = $0 }), onPendingInput: { _ in }, onSize: { _,_ in })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 500), coordinator: coordinator)
        coordinator.host = host
        defer { host.teardown(); client.dispose() }
        host.feed(Data((0..<350).map { "history \($0)\r\n" }.joined().utf8)); host.followCursor()
        let before = host.scrollLocation.historyRow
        let cg = try XCTUnwrap(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: 10, wheel2: 0, wheel3: 0))
        cg.location = CGPoint(x: 30, y: 30)
        host.handleUserWheel(try XCTUnwrap(NSEvent(cgEvent: cg)))
        XCTAssertLessThan(host.scrollLocation.historyRow, before); XCTAssertFalse(following)
        host.feed(Data("\u{1b}[?1000h".utf8)); XCTAssertFalse(host.terminal.allowMouseReporting)
        coordinator.parent = TerminalRepresentable(client: client, mode: .control, cols: 100, rows: 30,
            following: .constant(false), onPendingInput: { _ in }, onSize: { _,_ in })
        host.layout(); XCTAssertTrue(host.terminal.allowMouseReporting)
        host.feed(Data("\u{1b}[?1000l".utf8)); XCTAssertFalse(host.terminal.allowMouseReporting)
        #endif
    }

    @MainActor func testUserScrollUpdatesSynchronizedAnchorAndBottomResumesFollowing() async throws {
        #if os(macOS)
        let client = TerminalStreamClient()
        var following = true
        let parent = TerminalRepresentable(client: client, mode: .observe, cols: 100, rows: 30,
            following: Binding(get: { following }, set: { following = $0 }), onPendingInput: { _ in }, onSize: { _,_ in })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 500), coordinator: coordinator)
        coordinator.host = host
        defer { host.teardown(); client.dispose() }
        host.feed(Data((0..<350).map { "history \($0)\r\n" }.joined().utf8)); host.followCursor()
        coordinator.performUserScroll { host.terminal.scroll(toPosition: 0.2) }
        XCTAssertFalse(following)
        host.feed(Data("\u{1b}[?2026hnew output\r\n".utf8))
        coordinator.performUserScroll { host.terminal.scroll(toPosition: 0.5) }
        let newAnchor = host.scrollLocation.historyRow
        host.feed(Data("\u{1b}[?2026l".utf8))
        // 되돌림은 feed 안에서 바로 끝난다. 뒤따르는 따라가기 작업이 자리를 옮기지 '않는지' 보는 쪽이라 넉넉히 기다린다.
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(host.scrollLocation.historyRow, newAnchor)
        coordinator.performUserScroll { host.followCursor() }
        XCTAssertTrue(host.isAtBottom); XCTAssertTrue(following)
        #endif
    }

    func testPlatformPoliciesAndPureGridSelection() {
        XCTAssertEqual(TerminalPlatform.mac.openingMode, .observe)
        XCTAssertEqual(TerminalPlatform.iPhone.openingMode, .observe)
        XCTAssertEqual(TerminalPlatform.mac.controlSizePolicy, .fit)
        XCTAssertEqual(TerminalPlatform.iPhone.controlSizePolicy, .fit)
        XCTAssertTrue(TerminalPlatform.mac.buffersStartingInput)
        XCTAssertTrue(TerminalPlatform.iPhone.buffersStartingInput)
        for platform in [TerminalPlatform.mac, .iPhone] {
            XCTAssertFalse(platform.acceptsKeyboard(mode: .observe))
            XCTAssertTrue(platform.acceptsKeyboard(mode: .control))
            for viewport in [CGSize(width: 800, height: 500), CGSize(width: 390, height: 300)] {
                let observing = TerminalGridLayout.grid(platform: platform, mode: .observe, cols: 160, rows: 50,
                    viewport: viewport, cellWidth: 6, cellHeight: 12)
                XCTAssertEqual(observing.cols, 160); XCTAssertEqual(observing.rows, 50)
                let control = TerminalGridLayout.grid(platform: platform, mode: .control, cols: 160, rows: 50,
                    viewport: viewport, cellWidth: 6, cellHeight: 12)
                XCTAssertEqual(control.cols, Int(viewport.width / 6)); XCTAssertEqual(control.rows, Int(viewport.height / 12))
            }
        }
        XCTAssertEqual(TerminalPlatform.iPhone.observeHint, "읽기 전용 · 클릭하거나 입력하면 입력을 시작합니다")
        XCTAssertEqual(TerminalPlatform.mac.observeHint, "읽기 전용 · 클릭하거나 입력하면 입력을 시작합니다")
    }
    func testPlatformSizePolicyIsSentInRequest() async throws {
        let api = APIClient(endpoint: try ServerEndpoint("http://127.0.0.1:7881"), accessCode: "test")
        for platform in [TerminalPlatform.mac, .iPhone] {
            let request = try await api.terminalStreamRequest(memberID: "m", mode: .control, cols: 65, rows: 25,
                leaseID: "lease", sizePolicy: platform.controlSizePolicy)
            let items = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems)
            XCTAssertEqual(items.first { $0.name == "size" }?.value, "fit")
        }
    }
    func testSheetSizeFitsScreenWithDefaultAndMinimum() {
        XCTAssertEqual(TerminalSheetLayout.size(visibleFrame: CGSize(width: 1920, height: 1080)), CGSize(width: 1120, height: 760))
        XCTAssertEqual(TerminalSheetLayout.size(visibleFrame: CGSize(width: 1280, height: 800)), CGSize(width: 1120, height: 680))
        XCTAssertEqual(TerminalSheetLayout.size(visibleFrame: CGSize(width: 1024, height: 768)), CGSize(width: 864, height: 648))
        XCTAssertEqual(TerminalSheetLayout.size(visibleFrame: CGSize(width: 800, height: 600)), CGSize(width: 720, height: 480))
        XCTAssertEqual(TerminalSheetLayout.size(visibleFrame: CGSize(width: 640, height: 480)), CGSize(width: 720, height: 460))
    }
    func testNaturalGridRoundsDownAndClampsExtremeViewports() {
        let natural = TerminalGridLayout.control(viewport: CGSize(width: 799, height: 499), cellWidth: 7.5, cellHeight: 16)
        XCTAssertEqual(natural.cols, 106); XCTAssertEqual(natural.rows, 31)
        let minimum = TerminalGridLayout.control(viewport: .zero, cellWidth: 8, cellHeight: 16)
        XCTAssertEqual(minimum.cols, 40); XCTAssertEqual(minimum.rows, 10)
        let maximum = TerminalGridLayout.control(viewport: CGSize(width: 10000, height: 10000), cellWidth: 8, cellHeight: 16)
        XCTAssertEqual(maximum.cols, 320); XCTAssertEqual(maximum.rows, 200)
    }
    @MainActor func testMacControlUsesActualFontCellsWithoutScalingAndFollowsViewportResize() {
        #if os(macOS)
        let client = TerminalStreamClient()
        let parent = TerminalRepresentable(client: client, mode: .control, cols: 160, rows: 50,
            following: .constant(true), onPendingInput: { _ in }, onSize: { _,_ in })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 500), coordinator: coordinator)
        coordinator.host = host
        defer { host.teardown(); client.dispose() }
        for size in [CGSize(width: 800, height: 500), CGSize(width: 640, height: 400), CGSize(width: 1000, height: 650)] {
            host.frame.size = size; host.layoutSubtreeIfNeeded(); host.layout()
            let canvas = host.documentView!
            XCTAssertEqual(canvas.frame.size, canvas.bounds.size, "Control must never scale its canvas")
            XCTAssertEqual(host.terminal.font.pointSize, 13)
            let expected = TerminalGridLayout.control(
                viewport: CGSize(width: host.contentSize.width - host.terminalGutter, height: host.contentSize.height),
                cellWidth: host.cellSize.width, cellHeight: host.cellSize.height)
            XCTAssertEqual(host.terminal.getTerminal().cols, expected.cols)
            XCTAssertEqual(host.terminal.getTerminal().rows, expected.rows)
            XCTAssertNotEqual(expected.cols, 160, "Ignore the core grid in control")
        }
        client.accept(.ready(mode: .control, cols: 180, rows: 60, expiresAt: nil))
        client.accept(.resize(cols: 160, rows: 50))
        let before = host.terminal.getTerminal().getDims()
        host.feed(Data("paint after server resize".utf8))
        XCTAssertEqual(host.terminal.getTerminal().cols, before.cols)
        XCTAssertEqual(host.terminal.getTerminal().rows, before.rows)
        #endif
    }
    @MainActor func testMacReadOnlyScalesCoreGridAndRequestsTypedInput() {
        #if os(macOS)
        let client = TerminalStreamClient()
        let parent = TerminalRepresentable(client: client, mode: .observe, cols: 160, rows: 50,
            following: .constant(true), onPendingInput: { _ in XCTFail("Observe input uses the request callback") }, onSize: { _,_ in })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 500), coordinator: coordinator)
        coordinator.host = host
        defer { host.teardown(); client.dispose() }
        host.layoutSubtreeIfNeeded(); host.layout()
        XCTAssertEqual(host.terminal.getTerminal().cols, 160); XCTAssertEqual(host.terminal.getTerminal().rows, 50)
        XCTAssertLessThan(host.documentView!.frame.width, host.documentView!.bounds.width)
        var requested = Data()
        coordinator.parent.onRequestInput = { requested.append($0) }
        coordinator.send(source: host.terminal, data: Array("ab".utf8)[...])
        XCTAssertEqual(requested, Data("ab".utf8))
        #endif
    }
    @MainActor func testMacBackingScaleTracksOneAndTwoTimesWithoutExtraMagnification() {
        #if os(macOS)
        let canvas = TerminalDocumentCanvas(), child = NSView()
        canvas.wantsLayer = true; child.wantsLayer = true; canvas.addSubview(child)
        for scale: CGFloat in [2, 1, 2] {
            TerminalSurfaceHost.applyBackingScale(to: canvas, scale: scale)
            XCTAssertEqual(canvas.layer?.contentsScale, scale)
            XCTAssertEqual(child.layer?.contentsScale, scale)
        }
        #endif
    }
    @MainActor func testIOSObserverCanFocusByUserIntentWithoutClaimOrAccessory() {
        #if os(iOS)
        let client = TerminalStreamClient()
        let parent = TerminalRepresentable(client: client, mode: .observe, cols: 160, rows: 50,
            following: .constant(true), onPendingInput: { _ in XCTFail("Observe input uses the request callback") }, onSize: { _,_ in })
        let coordinator = TerminalSurfaceCoordinator(parent)
        let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 390, height: 500), coordinator: coordinator)
        coordinator.host = host
        defer { client.dispose() }
        XCTAssertEqual(host.terminal.font.pointSize, 12)
        XCTAssertEqual(host.minimumZoomScale, 1); XCTAssertEqual(host.maximumZoomScale, 3)
        XCTAssertNotNil(host.viewForZooming(in: host))
        XCTAssertTrue(host.terminal.canBecomeFirstResponder)
        XCTAssertFalse(host.terminal.isFirstResponder, "Opening an observe surface never focuses the keyboard")
        XCTAssertNil(host.terminal.inputAccessoryView)
        var requested = Data()
        coordinator.parent.onRequestInput = { requested.append($0) }
        coordinator.send(source: host.terminal, data: Array("ab".utf8)[...])
        XCTAssertEqual(requested, Data("ab".utf8))
        coordinator.parent = TerminalRepresentable(client: client, mode: .control, cols: 65, rows: 25,
            following: .constant(true), onPendingInput: { _ in XCTFail() }, onSize: { _,_ in })
        host.updateInputMode()
        XCTAssertTrue(host.terminal.canBecomeFirstResponder); XCTAssertNotNil(host.terminal.inputAccessoryView)
        XCTAssertNotNil(host.viewForZooming(in: host), "Input mode also allows pinch zoom")
        coordinator.parent = parent; host.updateInputMode()
        XCTAssertTrue(host.terminal.canBecomeFirstResponder)
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
    @MainActor func testResizePreservesObserveAndControlGenerationAndOutputHandler() {
        XCTAssertEqual(TerminalStreamEvent.parse(#"{"type":"resize","cols":80,"rows":24}"#), .resize(cols: 80, rows: 24))
        XCTAssertNil(TerminalStreamEvent.parse(#"{"type":"resize","cols":0,"rows":24}"#))
        let client = TerminalStreamClient()
        client.accept(.ready(mode: .observe, cols: 200, rows: 120, expiresAt: nil))
        let before = client.outputGeneration
        client.attachOutput(owner: UUID()) { _ in }
        client.accept(.resize(cols: 80, rows: 24))
        XCTAssertEqual(client.grid.cols, 80); XCTAssertEqual(client.grid.rows, 24)
        XCTAssertEqual(client.outputGeneration, before); XCTAssertNotNil(client.onOutput)
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
        // URLSession 은 무효화한 뒤 제 큐에서 놓인다. 정해진 양보 횟수 대신 실제로 풀릴 때까지 기다린다(느린 CI 러너).
        await pollUntil("터미널 클라이언트와 세션이 풀림") { weakClient == nil && weakSession == nil }
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
        let expected = NSFont(name: "SFMono-Regular", size: 13) ?? NSFont(name: "Menlo-Regular", size: 13)!
        XCTAssertEqual(TerminalSurfaceHost.font(13).fontName, expected.fontName)
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
            following: Binding(get: { following }, set: { following = $0 }), onPendingInput: { _ in }, onSize: { _,_ in })
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
        // 자리를 '옮기지 않는지' 보는 쪽이라 화면 갱신·따라가기 타이머가 넉넉히 돌 만큼 기다린다.
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(following)
        XCTAssertEqual(host.terminal.getTerminal().getTopVisibleRow(), position)
        #endif
    }
    @MainActor func testScrollerActionStopsFollowingOnlyWhenMovingUp() throws {
        #if os(macOS)
        let client = TerminalStreamClient()
        var following = true
        let parent = TerminalRepresentable(client: client, mode: .observe, cols: 100, rows: 30,
            following: Binding(get: { following }, set: { following = $0 }), onPendingInput: { _ in }, onSize: { _,_ in })
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
            for internalHistory in (mode == .control ? [true] : [true, false]) {
                let client = TerminalStreamClient()
                var following = true
                let parent = TerminalRepresentable(client: client, mode: mode, cols: 160, rows: 50,
                    following: Binding(get: { following }, set: { following = $0 }), onPendingInput: { _ in }, onSize: { _,_ in })
                let coordinator = TerminalSurfaceCoordinator(parent)
                let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 300), coordinator: coordinator)
                coordinator.host = host
                defer { host.teardown(); client.dispose() }
                host.feed(Data((0..<150).map { "line \($0)\r\n" }.joined().utf8))
                host.followCursor()
                XCTAssertTrue(following, "Output and programmatic scrolling preserve following in \(mode)")
                let before = host.scrollLocation
                if mode == .observe { XCTAssertGreaterThan(before.viewportY, 0, "Following must reach the cursor before the display timer runs") }
                else { XCTAssertEqual(before.viewportY, 0, "Fit control has no outer vertical overflow") }
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
                // 자리를 '옮기지 않는지' 보는 쪽이라 넉넉히 기다린다(아래 두 곳도 같다).
                try? await Task.sleep(for: .milliseconds(200))
                XCTAssertFalse(following)
                XCTAssertEqual(host.scrollLocation.historyRow, paused.historyRow)
                XCTAssertEqual(host.scrollLocation.viewportY, paused.viewportY, accuracy: 0.5)
                host.feed(Data("more output\r\n".utf8))
                try? await Task.sleep(for: .milliseconds(200))
                XCTAssertFalse(following)
                XCTAssertEqual(host.scrollLocation.historyRow, paused.historyRow)
                XCTAssertEqual(host.scrollLocation.viewportY, paused.viewportY, accuracy: 0.5)
                following = true // The shared '맨 아래로' button resumes either mode.
                host.followCursor()
                XCTAssertGreaterThan(host.scrollLocation.historyRow, paused.historyRow)
                if mode == .observe { XCTAssertGreaterThan(host.scrollLocation.viewportY, 0) }
            }
        }
        #endif
    }
    @MainActor func testOuterScrollPreservesVisibleTextWhenHistoryFillsAndRecycles() async throws {
        #if os(macOS)
        // Only the scaled read-only fallback has an outer viewport scroll axis.
        for mode in [TerminalStreamMode.observe] {
            for initialLines in [4980, 5200] {
                let client = TerminalStreamClient()
                var following = true
                let parent = TerminalRepresentable(client: client, mode: mode, cols: 160, rows: 50,
                    following: Binding(get: { following }, set: { following = $0 }), onPendingInput: { _ in }, onSize: { _,_ in })
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
                    try? await Task.sleep(for: .milliseconds(200))
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
                    following: .constant(true), onPendingInput: { _ in }, onSize: { _,_ in })
                let coordinator = TerminalSurfaceCoordinator(parent)
                let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 300), coordinator: coordinator)
                coordinator.host = host
                defer { host.teardown(); client.dispose() }
                host.feed(Data("\u{1b}[50;1H".utf8))
                host.followCursor()
                // 조건으로 볼 수 없는 자리: 이 격자에서 마지막 행의 커서 표시 자리는 SwiftTerm 의 처음 자리(0,0)와 같다.
                // 화면 갱신이 늦게 와도 아래는 흔들리지 않는다(동기 출력 중에는 표시가 멈추고, 끝나면 1행으로 옮겨 달라진다).
                try? await Task.sleep(for: .milliseconds(60))
                let displayedCaret = host.terminal.caretFrame
                let displayed = host.scrollLocation.viewportY
                if mode == .observe { XCTAssertGreaterThan(displayed, 0) }
                host.feed(Data("\u{1b}[?2026h\u{1b}[1;1H".utf8))
                host.followCursor() // All callers must honor the synchronized-output guard.
                // 동기 출력 중에는 화면이 '움직이지 않는지' 보는 쪽이라 넉넉히 기다린다(SwiftTerm 의 1초 시간 제한보다는 짧게).
                try? await Task.sleep(for: .milliseconds(200))
                XCTAssertTrue(host.terminal.getTerminal().synchronizedOutputActive)
                XCTAssertEqual(host.scrollLocation.viewportY, displayed, accuracy: 0.5)
                XCTAssertEqual(host.terminal.caretFrame, displayedCaret, "The displayed cursor stays at the last completed frame")
                // timeout 이면 SwiftTerm 의 실제 시간 제한(1초)이 풀어 준다. 아니면 끝 신호를 보낸다.
                if !timeout { host.feed(Data("\u{1b}[?2026l".utf8)) }
                // The catch-up runs on the main run loop after the guard lifts. A loaded machine (CI) can need more than
                // a fixed wait, so wait for it; the viewport and the displayed cursor must still arrive at the cursor.
                await pollUntil("동기 출력이 끝나고 화면이 커서를 따라잡음") {
                    !host.terminal.getTerminal().synchronizedOutputActive && abs(host.scrollLocation.viewportY) <= 0.5
                        && host.terminal.caretFrame != displayedCaret
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
                following: .constant(true), onPendingInput: { _ in }, onSize: { _,_ in })
            let coordinator = TerminalSurfaceCoordinator(parent)
            let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 300), coordinator: coordinator)
            coordinator.host = host
            defer { host.teardown(); client.dispose() }
            host.feed(Data((0..<150).map { "line \($0)\r\n" }.joined().utf8))
            host.followCursor()
            if mode == .observe { XCTAssertGreaterThan(host.scrollLocation.viewportY, 0) }
            host.feed(Data("\u{1b}[1;1H".utf8))
            host.followCursor()
            XCTAssertEqual(host.scrollLocation.viewportY, 0, accuracy: 0.5, "Follow the new cursor row synchronously")
            host.feed(Data("\u{1b}[50;1H".utf8))
            host.followCursor()
            if mode == .observe { XCTAssertGreaterThan(host.scrollLocation.viewportY, 0, "Resume at the bottom without waiting for paint") }
            else { XCTAssertEqual(host.scrollLocation.viewportY, 0) }
        }
        #endif
    }
    @MainActor func testSynchronizedOutputTimeoutWithoutUserScrollPreservesFollowing() async {
        #if os(macOS)
        for prefix in ["", (0..<100).map { "line \($0)\r\n" }.joined(), "\u{1b}[?1049h"] {
            let client = TerminalStreamClient()
            var following = true
            let parent = TerminalRepresentable(client: client, mode: .observe, cols: 100, rows: 30,
                following: Binding(get: { following }, set: { following = $0 }), onPendingInput: { _ in }, onSize: { _,_ in })
            let coordinator = TerminalSurfaceCoordinator(parent)
            let host = TerminalSurfaceHost(frame: CGRect(x: 0, y: 0, width: 800, height: 500), coordinator: coordinator)
            coordinator.host = host
            defer { host.teardown(); client.dispose() }
            host.feed(Data((prefix + "\u{1b}[?2026hhello").utf8))
            XCTAssertTrue(host.terminal.getTerminal().synchronizedOutputActive)
            XCTAssertTrue(following)
            // SwiftTerm 의 실제 시간 제한(1초)이 풀어 줄 때까지 기다린다(느린 CI 러너에서는 고정 1.25초로 모자랄 수 있다).
            await pollUntil("SwiftTerm 동기 출력 시간 제한") { !host.terminal.getTerminal().synchronizedOutputActive }
            // 풀린 뒤의 화면 갱신까지 지나도 따라가기가 꺼지지 '않는지' 보는 쪽이라 넉넉히 기다린다.
            try? await Task.sleep(for: .milliseconds(250))
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
        XCTAssertEqual(TerminalScrollLocation.viewportY(25, minimum: 100, maximum: 0), 25)
    }
    @MainActor func testMacEscAndTabAreBufferedTerminalInputWhileConnecting() {
        #if os(macOS)
        let client = TerminalStreamClient()
        var typed = Data()
        let parent = TerminalRepresentable(client: client, mode: .control, cols: 100, rows: 30, following: .constant(true), onPendingInput: { typed.append($0) }, onSize: { _,_ in })
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
