import XCTest
import SwiftUI
@testable import IAMCEO
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor final class ChatAnchorTests: XCTestCase {
    func testFirstPartiallyVisibleMessageExcludesHeadersAndPrefetch() {
        let frames = ["day:1": CGRect(x: 0, y: -30, width: 100, height: 40),
                      "m:old": CGRect(x: 0, y: -200, width: 100, height: 100),
                      "m:partial": CGRect(x: 0, y: -37.25, width: 100, height: 180),
                      "m:next": CGRect(x: 0, y: 150, width: 100, height: 120),
                      "m:prefetch": CGRect(x: 0, y: 500, width: 100, height: 100)]
        XCTAssertEqual(ChatScrollAnchor.firstVisible(frames: frames, viewportHeight: 400), ChatVisibleAnchor(messageID: "m:partial", top: -37.25))
        XCTAssertNil(ChatScrollAnchor.firstVisible(frames: frames, viewportHeight: 0))
    }

    func testMissingHostRefusesMutationAndStaleScopeCannotRestore() {
        let anchor = ChatScrollAnchor(scope: "a")
        anchor.setViewport(height: 400, scope: "a")
        anchor.observe(frames: ["m:1": CGRect(x: 0, y: -20, width: 100, height: 80)], scope: "a")
        var applied = false
        XCTAssertFalse(anchor.prepend(scope: "a") { applied = true })
        XCTAssertFalse(applied)
        anchor.reset(scope: "b")
        anchor.observe(frames: ["m:1": CGRect(x: 0, y: 900, width: 100, height: 80)], scope: "a")
        XCTAssertNil(anchor.visibleAnchor)
    }

    #if os(macOS)
    private final class Document: NSView {
        let usesFlippedCoordinates: Bool
        init(flipped: Bool, height: CGFloat) {
            self.usesFlippedCoordinates = flipped
            super.init(frame: CGRect(x: 0, y: 0, width: 320, height: height))
        }
        required init?(coder: NSCoder) { nil }
        override var isFlipped: Bool { usesFlippedCoordinates }
    }

    func testPublicAncestorProbeAndPartialAnchorWithinTwoPointsOnBothCoordinateDirections() {
        for flipped in [true, false] {
            let scroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 400))
            let document = Document(flipped: flipped, height: 2400)
            scroll.documentView = document
            scroll.contentView.scroll(to: CGPoint(x: 0, y: 600.25))
            let anchor = ChatScrollAnchor(scope: "chat")
            let probe = ChatScrollProbeView(anchor: anchor, scope: "chat")
            let wrapper = NSView(frame: .zero)
            document.addSubview(wrapper); wrapper.addSubview(probe)
            XCTAssertTrue(anchor.hostFound)
            anchor.setViewport(height: 400, scope: "chat")
            let direction: CGFloat = scroll.contentView.isFlipped ? 1 : -1
            func row(_ top: CGFloat) -> CGRect { CGRect(x: 0, y: top, width: 300, height: 160) }
            // User moved while the network was waiting. Capture this -37.25pt, never the request's -10pt.
            anchor.observe(frames: ["m:reading": row(-10)], scope: "chat")
            anchor.observe(frames: ["m:reading": row(-37.25)], scope: "chat")
            let offset = scroll.contentView.bounds.minY
            XCTAssertTrue(anchor.prepend(scope: "chat") {
                document.setFrameSize(CGSize(width: 320, height: 3300)) // prepend plus an unrelated tail append
            })
            XCTAssertFalse(anchor.prepend(scope: "chat") { XCTFail("overlapping prepend") })
            anchor.observe(frames: ["m:reading": row(562.75)], scope: "chat") // prepend 600pt
            let movement = (scroll.contentView.bounds.minY - offset) * direction
            XCTAssertEqual(movement, 600, accuracy: 2)
            anchor.observe(frames: ["m:reading": row(562.75 - movement)], scope: "chat")
            XCTAssertLessThanOrEqual(anchor.lastRestorationError ?? .infinity, 2)
            XCTAssertFalse(anchor.isPreservingPosition)
            // An ordinary delivery update does not move the scroll host.
            let restored = scroll.contentView.bounds.minY
            anchor.observe(frames: ["m:reading": row(-37.25)], scope: "chat")
            XCTAssertEqual(scroll.contentView.bounds.minY, restored)
            probe.disconnect()
            XCTAssertFalse(anchor.hostFound)
        }
    }

    func testNativeHostBoundsAndProbeDoesNotSearchSiblingScrollViews() {
        let container = NSView(frame: .zero)
        let scroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: 300, height: 400))
        scroll.documentView = Document(flipped: true, height: 1600)
        container.addSubview(scroll)
        let anchor = ChatScrollAnchor(scope: "a")
        let probe = ChatScrollProbeView(anchor: anchor, scope: "a")
        container.addSubview(probe)
        XCTAssertFalse(anchor.hostFound)
        scroll.documentView?.addSubview(probe)
        XCTAssertTrue(anchor.hostFound)
        anchor.adjustOffset(by: 100_000)
        XCTAssertLessThanOrEqual(scroll.contentView.bounds.minY, 1200)
        anchor.adjustOffset(by: -100_000)
        XCTAssertGreaterThanOrEqual(scroll.contentView.bounds.minY, 0)
        anchor.reset(scope: "b")
        probe.configure(anchor: anchor, scope: "b")
        XCTAssertTrue(anchor.hostFound)
        probe.disconnect()
    }

    func testDeferredPrependCapturesAfterLiveScrollingAndJumpCancelsResponse() async throws {
        let scroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: 300, height: 400))
        let document = Document(flipped: true, height: 2000)
        scroll.documentView = document
        let anchor = ChatScrollAnchor(scope: "a")
        let probe = ChatScrollProbeView(anchor: anchor, scope: "a")
        document.addSubview(probe)
        anchor.setViewport(height: 400, scope: "a")
        anchor.observe(frames: ["m:1": CGRect(x: 0, y: -10, width: 300, height: 200)], scope: "a")
        NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        var applied = false
        XCTAssertTrue(anchor.prepend(scope: "a") { applied = true })
        XCTAssertFalse(applied)
        anchor.observe(frames: ["m:1": CGRect(x: 0, y: -73, width: 300, height: 200)], scope: "a")
        NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
        try await Task.sleep(for: .milliseconds(60))
        XCTAssertTrue(applied)
        anchor.observe(frames: ["m:1": CGRect(x: 0, y: 427, width: 300, height: 200)], scope: "a")
        anchor.observe(frames: ["m:1": CGRect(x: 0, y: -73, width: 300, height: 200)], scope: "a")
        XCTAssertEqual(anchor.lastRestorationError, 0)
        NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        XCTAssertTrue(anchor.prepend(scope: "a") { XCTFail("jump must cancel queued response") })
        anchor.cancelPreservation()
        NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertFalse(anchor.isPreservingPosition)
        probe.disconnect()
    }

    private func eventually(_ what: String, timeout: Duration = .seconds(10), _ condition: () -> Bool) async {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !condition() {
            guard clock.now < deadline else { XCTFail("기다린 상태가 오지 않았습니다: \(what)"); return }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    /// 휠 마우스·키보드 스크롤은 willStart/didEnd 없이 didLiveScroll 만 온다. 그것도 사용자의 스크롤이다.
    func testUnbracketedLiveScrollCountsAsInteractionUntilItGoesQuiet() async {
        let scroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: 300, height: 400))
        let document = Document(flipped: true, height: 2000)
        scroll.documentView = document
        let anchor = ChatScrollAnchor(scope: "a")
        anchor.looseScrollQuiet = .milliseconds(20)
        let probe = ChatScrollProbeView(anchor: anchor, scope: "a")
        document.addSubview(probe)
        XCTAssertFalse(anchor.isInteracting)
        NotificationCenter.default.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
        XCTAssertTrue(anchor.isInteracting, "휠 스크롤 중에는 위치 보정이 끼어들면 안 된다")
        await eventually("휠 스크롤이 조용해지면 상호작용이 끝난다") { !anchor.isInteracting }

        // 제스처(트랙패드)로 감싸진 스크롤은 손을 멈추고 있어도 didEnd 까지 이어진다.
        anchor.looseScrollQuiet = .milliseconds(1)
        NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        NotificationCenter.default.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(anchor.isInteracting)
        NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
        XCTAssertFalse(anchor.isInteracting)

        // 다른 스크롤 뷰의 알림은 듣지 않는다.
        NotificationCenter.default.post(name: NSScrollView.didLiveScrollNotification, object: NSScrollView())
        XCTAssertFalse(anchor.isInteracting)
        probe.disconnect()
    }

    /// 위쪽을 읽는 중에 온, 어떤 행의 높이도 바꾸지 않는 갱신(전달 상태 글자 등)은 프레임 보고가 다시 오지 않는다.
    func testPreservationEndsByItselfWhenTheMutationMovesNoRow() async {
        let scroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: 300, height: 400))
        let document = Document(flipped: true, height: 2000)
        scroll.documentView = document
        scroll.contentView.scroll(to: CGPoint(x: 0, y: 500))
        let anchor = ChatScrollAnchor(scope: "a")
        anchor.restorationTimeout = .milliseconds(10)
        let probe = ChatScrollProbeView(anchor: anchor, scope: "a")
        document.addSubview(probe)
        anchor.setViewport(height: 400, scope: "a")
        anchor.observe(frames: ["m:1": CGRect(x: 0, y: -37.25, width: 300, height: 200)], scope: "a")
        let offset = scroll.contentView.bounds.minY
        var applied = 0
        XCTAssertTrue(anchor.prepend(scope: "a") { applied += 1 })
        XCTAssertEqual(applied, 1)
        XCTAssertTrue(anchor.isPreservingPosition)
        await eventually("높이가 안 바뀐 갱신 뒤 보존 상태가 풀린다") { !anchor.isPreservingPosition }
        XCTAssertEqual(scroll.contentView.bounds.minY, offset, "움직인 행이 없으면 스크롤도 그대로다")
        XCTAssertEqual(anchor.lastRestorationError, 0)
        // 풀린 뒤에는 다음 갱신이 다시 적용된다(대기열에 갇히지 않는다).
        XCTAssertTrue(anchor.prepend(scope: "a") { applied += 1 })
        XCTAssertEqual(applied, 2)

        // 기준 행이 사라져 맞출 자리가 없을 때도 영영 붙잡지 않는다.
        anchor.observe(frames: [:], scope: "a")
        await eventually("기준 행이 사라져도 보존 상태가 풀린다") { !anchor.isPreservingPosition }
        probe.disconnect()
    }

    @Observable final class PrototypeMessages {
        var ids = Array(0..<20)
    }
    private struct Prototype: View {
        let anchor: ChatScrollAnchor
        let messages: PrototypeMessages
        var body: some View {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ChatScrollHostProbe(anchor: anchor, scope: "prototype").frame(height: 0)
                    ForEach(messages.ids, id: \.self) { index in
                        Text("message \(index)").frame(height: 90)
                            .chatScrollRow(id: "m:\(index)", coordinateSpace: "prototype")
                    }
                }
            }.chatScrollAnchoring(anchor, scope: "prototype")
        }
    }

    /// Exercise the real SwiftUI hierarchy and geometry preferences, beyond native-host coordinate fixtures.
    func testSwiftUIPartialAnchorPrototypeWithinTwoPoints() async throws {
        let anchor = ChatScrollAnchor(scope: "prototype")
        let messages = PrototypeMessages()
        let hosting = NSHostingView(rootView: Prototype(anchor: anchor, messages: messages))
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 320, height: 400),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = hosting
        defer { window.orderOut(nil); window.contentView = nil }
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(anchor.hostFound, "SwiftUI's probe must find its actual ancestor")
        anchor.adjustOffset(by: 127.25)
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        let before = try XCTUnwrap(anchor.visibleAnchor)
        XCTAssertLessThan(before.top, 0, "The prototype must actually expose a partial row")
        XCTAssertTrue(anchor.prepend(scope: "prototype") {
            messages.ids.insert(contentsOf: Array(-5..<0), at: 0)
            messages.ids.append(20) // Simultaneous tail append must not enter the anchor delta.
        })
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(200))
        hosting.layoutSubtreeIfNeeded()
        let after = try XCTUnwrap(anchor.visibleAnchor)
        XCTAssertEqual(after.messageID, before.messageID)
        XCTAssertEqual(after.top, before.top, accuracy: 2)
        XCTAssertLessThanOrEqual(anchor.lastRestorationError ?? .infinity, 2)
        XCTAssertFalse(anchor.isPreservingPosition)
    }
    #else
    func testUIKitInsetAwarePartialAnchorWithinTwoPoints() {
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 400))
        scroll.contentSize = CGSize(width: 320, height: 2000)
        scroll.contentInset = UIEdgeInsets(top: 42, left: 0, bottom: 80, right: 0)
        scroll.contentOffset.y = 400
        let anchor = ChatScrollAnchor(scope: "a")
        let probe = ChatScrollProbeView(anchor: anchor, scope: "a")
        scroll.addSubview(probe)
        anchor.setViewport(height: 400, scope: "a")
        anchor.observe(frames: ["m:1": CGRect(x: 0, y: -37.25, width: 300, height: 200)], scope: "a")
        XCTAssertTrue(anchor.prepend(scope: "a") { scroll.contentSize.height += 900 })
        anchor.observe(frames: ["m:1": CGRect(x: 0, y: 562.75, width: 300, height: 200)], scope: "a")
        XCTAssertEqual(scroll.contentOffset.y, 1000, accuracy: 2)
        anchor.observe(frames: ["m:1": CGRect(x: 0, y: -37.25, width: 300, height: 200)], scope: "a")
        XCTAssertLessThanOrEqual(anchor.lastRestorationError ?? .infinity, 2)
        anchor.adjustOffset(by: -100_000)
        XCTAssertEqual(scroll.contentOffset.y, -scroll.adjustedContentInset.top, accuracy: 0.5)
        probe.disconnect()
    }
    #endif
}
