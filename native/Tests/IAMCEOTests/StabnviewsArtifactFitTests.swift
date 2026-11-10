import Foundation
import WebKit
import XCTest
@testable import IAMCEO

/// 아티팩트 맞춤 높이의 수렴 감시와 웹 콘텐츠 프로세스 종료 복구.
final class StabnviewsArtifactFitTests: XCTestCase {
    /// `min-height:100vh` 페이지: 맞춘 높이가 곧 뷰포트라, 맞출 때마다 여백만큼 더 큰 값을 다시 보고한다.
    func testViewportBoundPageStopsGrowingAfterAFewFits() {
        var fit = ArtifactHeightFit()
        var time: TimeInterval = 100
        var height: CGFloat = 528
        var fits: [CGFloat] = []
        // 되먹임: 맞춘 높이 + 48 이 약 17ms 뒤에 다시 온다. 묶인 뒤에는 프레임이 그대로라 같은 값만 온다.
        for _ in 0..<400 {
            time += 0.017
            if case .fit(let value) = fit.report(height, at: time) { fits.append(value); height = value + 48 }
        }
        XCTAssertEqual(fits, [528, 576, 624, 672, 720])
        XCTAssertTrue(fit.held)
        XCTAssertTrue(fit.viewportBound)
        // 한참 뒤 같은 값을 다시 재도(로드 완료 측정 등) 움직이지 않는다.
        XCTAssertEqual(fit.report(height, at: time + 60), .ignore)
        XCTAssertEqual(fit.report(720, at: time + 61), .ignore)
    }

    func testOrdinaryPageFollowsEveryChangeAndNeverLocks() {
        var fit = ArtifactHeightFit()
        XCTAssertEqual(fit.report(136, at: 0), .fit(136))
        XCTAssertEqual(fit.report(136, at: 0.02), .ignore)
        XCTAssertEqual(fit.report(136.3, at: 0.04), .ignore)
        // 그림·글꼴이 들어오며 두어 번 커지는 것은 정상이다.
        XCTAssertEqual(fit.report(420, at: 0.2), .fit(420))
        XCTAssertEqual(fit.report(900, at: 0.5), .fit(900))
        XCTAssertFalse(fit.held)
        // 사람이 접이식을 여닫는 느린 변화는 몇 번이든 따라간다.
        var time: TimeInterval = 10
        for step in 1...12 {
            time += 2
            XCTAssertEqual(fit.report(900 + CGFloat(step) * 80, at: time), .fit(900 + CGFloat(step) * 80))
        }
        XCTAssertEqual(fit.report(300, at: time + 0.1), .fit(300))
        XCTAssertFalse(fit.held)
        XCTAssertFalse(fit.viewportBound)
        XCTAssertEqual(fit.widthChanged(at: time + 1), .ignore)
    }

    /// 스스로 빠르게 자라는 페이지(줄이 차례로 붙는 등)는 잠깐 묶였다가도 계속 자라면 다시 따라간다.
    func testSelfGrowingPageIsReleasedWhenItKeepsGrowingOrShrinks() {
        var fit = ArtifactHeightFit()
        var time: TimeInterval = 0
        var last: CGFloat = 0
        for step in 0..<40 {
            time += 0.05
            if case .fit(let value) = fit.report(200 + CGFloat(step) * 30, at: time) { last = value }
        }
        // 마지막 보고에서 많아야 한 걸음 뒤.
        XCTAssertGreaterThanOrEqual(last, 200 + 38 * 30)

        // 묶인 뒤 한참 지나 커진 것은 되먹임이 아니다.
        var slow = ArtifactHeightFit()
        for step in 0..<5 { _ = slow.report(500 + CGFloat(step) * 48, at: Double(step) * 0.02) }
        XCTAssertTrue(slow.held)
        XCTAssertEqual(slow.report(1200, at: 30), .fit(1200))
        XCTAssertFalse(slow.held)

        // 뷰포트보다 작아질 수 없는 페이지가 줄었다면 내용이 줄어든 것이다.
        var shrink = ArtifactHeightFit()
        for step in 0..<5 { _ = shrink.report(500 + CGFloat(step) * 48, at: Double(step) * 0.02) }
        XCTAssertTrue(shrink.held)
        XCTAssertEqual(shrink.report(400, at: 0.2), .fit(400))
        XCTAssertFalse(shrink.held)
    }

    /// 폭이 바뀔 때마다 묶음이 풀려 높이가 쌓이면 창 크기를 끄는 동안 끝없이 커진다. 처음 높이에서 다시 맞춘다.
    func testWidthChangesRestartABoundPageFromItsFirstHeightSoItCannotRatchet() {
        var fit = ArtifactHeightFit()
        var time: TimeInterval = 0
        var height: CGFloat = 528
        var tallest: CGFloat = 0
        func settle() {
            for _ in 0..<50 {
                time += 0.017
                if case .fit(let value) = fit.report(height, at: time) { height = value + 48; tallest = max(tallest, value) }
            }
        }
        settle()
        XCTAssertTrue(fit.held)
        for _ in 0..<100 {
            time += 0.15
            guard case .fit(let value) = fit.widthChanged(at: time) else { return XCTFail("묶인 페이지는 처음 높이로 돌아가 다시 맞춘다") }
            XCTAssertEqual(value, 528)
            height = value + 48
            settle()
        }
        XCTAssertLessThanOrEqual(tallest, 528 + 48 * CGFloat(ArtifactHeightFit.growthLimit + 1))
    }
}

final class StabnviewsArtifactRuntimeTests: XCTestCase {
    /// 웹 콘텐츠 프로세스가 종료되면 같은 격리 문서를 다시 넣는다(횟수 제한). 다시 넣은 문서도 처음과 같은 규칙으로 열린다.
    @MainActor func testTerminatedContentProcessReloadsTheSameSandboxDocumentAFewTimes() async throws {
        let compiled = await artifactBlockRule()
        let rule = try XCTUnwrap(compiled)
        let delegate = ArtifactNavigationDelegate()
        delegate.onHeight = { _ in }
        let view = makeArtifactWebView(html: "<p id=\"p\">복구 시험</p>", title: "복구", rule: rule, delegate: delegate, fitted: false)
        defer {
            view.stopLoading()
            view.configuration.userContentController.removeAllScriptMessageHandlers(from: .defaultClient)
        }
        /// 지금 붙어 있는 격리 프레임의 글. 프레임이 없거나 사라졌으면 nil.
        func pageText(_ script: String = "document.getElementById('p').textContent") async -> String? {
            guard let frame = delegate.childFrame else { return nil }
            return try? await view.evaluateJavaScript(script, in: frame, contentWorld: .page) as? String
        }
        try await waitUntil("첫 로드") { await pageText() == "복구 시험" }

        for round in 1...ArtifactNavigationDelegate.processReloadLimit {
            // 지금 문서에 표시를 남겨, 뒤에 보이는 글이 새로 넣은 문서의 것임을 확인한다.
            try await waitUntil("옛 문서 표시 \(round)") {
                await pageText("document.getElementById('p').textContent='옛 문서'") == "옛 문서"
            }
            delegate.webViewWebContentProcessDidTerminate(view)
            XCTAssertNil(delegate.childFrame, "종료된 프로세스의 프레임을 붙잡고 있으면 안 된다")
            XCTAssertEqual(delegate.processReloads, round)
            try await waitUntil("다시 넣은 문서 \(round)") { await pageText() == "복구 시험" }
        }
        // 계속 죽는 페이지를 끝없이 다시 넣지 않는다.
        delegate.webViewWebContentProcessDidTerminate(view)
        XCTAssertEqual(delegate.processReloads, ArtifactNavigationDelegate.processReloadLimit)
    }

    /// 실제 WebKit 에서: 뷰포트 높이를 따라 커지는 페이지의 맞춤 미리보기가 몇 번 만에 멈추는지.
    @MainActor func testViewportBoundPageInARealFittedWebViewSettlesInsteadOfGrowingForever() async throws {
        let compiled = await artifactBlockRule()
        let rule = try XCTUnwrap(compiled)
        let delegate = ArtifactNavigationDelegate()
        var heights: [CGFloat] = []
        delegate.onHeight = { heights.append($0) }
        var bound: [Bool] = []
        delegate.onViewportBound = { bound.append($0) }
        let view = makeArtifactWebView(html: "<div style=\"min-height:100vh\">뷰포트만큼</div>", title: "수렴", rule: rule,
                                       delegate: delegate, fitted: true)
        defer {
            view.stopLoading()
            view.configuration.userContentController.removeAllScriptMessageHandlers(from: .defaultClient)
        }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(8))
        while !delegate.heightFit.held, clock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        // 묶이지 않았더라도 끝없이 맞추고 있으면 안 된다.
        XCTAssertLessThanOrEqual(heights.count, ArtifactHeightFit.growthLimit + 2, "맞춤이 끝없이 되풀이된다: \(heights.suffix(6))")
        guard delegate.heightFit.held else { throw XCTSkip("화면 밖 WebKit 이 이 실행에서는 높이 되먹임을 만들지 않았습니다") }
        let settled = heights
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(heights, settled, "묶인 뒤에는 높이가 더 바뀌지 않는다")
        XCTAssertEqual(heights, heights.sorted())
        // 이런 페이지의 높이는 다음에 열 때 쓸 값으로 기억하지 않도록 알린다.
        XCTAssertEqual(bound, [true])
    }

    @MainActor private func waitUntil(_ what: String, timeout: Duration = .seconds(20), _ condition: () async -> Bool) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !(await condition()) {
            guard clock.now < deadline else {
                XCTFail("기다린 상태가 오지 않았습니다: \(what)")
                throw NSError(domain: "StabnviewsArtifactRuntimeTests.Timeout", code: 1)
            }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}
