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
        // 네 번 만에 묶고, 조용해진 뒤 한 걸음(768)만 따라가 본 다음 다시 커지는 것을 보고 그대로 묶어 둔다.
        XCTAssertEqual(fits, [528, 576, 624, 672, 720, 768])
        XCTAssertTrue(fit.held)
        XCTAssertTrue(fit.viewportBound)
        XCTAssertFalse(fit.needsRecheck)
        // 한참 뒤 같은 값을 다시 재도(로드 완료 측정 등) 움직이지 않는다.
        XCTAssertEqual(fit.report(height, at: time + 60), .ignore)
        XCTAssertEqual(fit.report(768, at: time + 61), .ignore)
        XCTAssertEqual(fit.report(height, at: time + 600), .ignore)
    }

    /// 묶은 직후 1초 안에는 같은 되먹임 보고가 몇 번 와도(ResizeObserver, load, 로드 완료 측정) 움직이지 않는다.
    func testRepeatedEchoRightAfterTheHoldIsIgnoredUntilTheRecheck() {
        var fit = ArtifactHeightFit()
        for step in 0..<5 { _ = fit.report(528 + CGFloat(step) * 48, at: Double(step) * 0.02) }
        XCTAssertTrue(fit.held)
        XCTAssertTrue(fit.needsRecheck)
        for tick in 1...20 { XCTAssertEqual(fit.report(768, at: 0.08 + Double(tick) * 0.04), .ignore) }
        XCTAssertTrue(fit.held)
        XCTAssertTrue(fit.viewportBound)
    }

    /// review native-views-1: 빠르게 몇 번 자라다 멈춘 정상 페이지의 마지막 한 걸음이 잘린 채 남지 않는다.
    /// 묶인 뒤 무시한 증가는 조용해진 뒤의 재측정이 되살린다. 자라는 횟수가 몇 번이든 같다.
    func testPageThatStopsGrowingRightAfterTheHoldIsFullyShownByTheRecheck() {
        var cutShort: [Int] = []
        for growths in 3...12 {
            var fit = ArtifactHeightFit()
            var frame: CGFloat = 0, time: TimeInterval = 0
            func feed(_ height: CGFloat) { if case .fit(let value) = fit.report(height, at: time) { frame = value } }
            feed(400)
            for step in 1...growths { time += 0.05; feed(400 + CGFloat(step) * 100) }
            let page = 400 + CGFloat(growths) * 100
            // 같은 높이를 곧바로 다시 재는 것(load, 로드 완료)은 아직 판단을 바꾸지 않는다.
            time += 0.05; feed(page)
            if frame < page {
                // 마지막 한 걸음이 묶인 직후에 와서 무시됐다. 조용해지면 화면이 한 번 다시 잰다.
                cutShort.append(growths)
                XCTAssertTrue(fit.needsRecheck, "\(growths)번")
                time += ArtifactHeightFit.quick + 0.2; feed(page)
                XCTAssertFalse(fit.held, "\(growths)번")
                XCTAssertFalse(fit.viewportBound, "\(growths)번")
                // 그대로인 페이지는 따라가 본 뒤에도 다시 묶이지 않는다.
                time += 0.02; feed(page)
                XCTAssertFalse(fit.held, "\(growths)번")
            }
            XCTAssertEqual(frame, page, "\(growths)번 자란 페이지의 아래가 잘렸다")
            // 나중의 느린 변화도 따라간다.
            time += 30; feed(page + 240)
            XCTAssertEqual(frame, page + 240, "\(growths)번")
        }
        XCTAssertEqual(cutShort, [5, 11], "이 시험이 겨냥한 경우(묶인 직후 한 번 더 자라고 멈춤)가 재현되지 않았다")
    }

    /// 한 걸음 따라가 보는 것은 페이지마다 한 번이다. 폭이 바뀌어 다시 묶여도 확인된 페이지는 더 커지지 않는다.
    func testConfirmedViewportPageIsNotProbedAgainAfterAWidthChange() {
        var fit = ArtifactHeightFit()
        var time: TimeInterval = 0, height: CGFloat = 528, fits: [CGFloat] = []
        func run(_ ticks: Int) {
            for _ in 0..<ticks {
                time += 0.017
                if case .fit(let value) = fit.report(height, at: time) { fits.append(value); height = value + 48 }
            }
        }
        run(200)
        XCTAssertEqual(fits.last, 768)
        XCTAssertFalse(fit.needsRecheck)
        guard case .fit(let floor) = fit.widthChanged(at: time) else { return XCTFail("묶인 페이지는 처음 높이로 돌아간다") }
        XCTAssertEqual(floor, 528)
        fits = []; height = floor + 48
        run(400)
        XCTAssertEqual(fits, [576, 624, 672, 720])
        XCTAssertTrue(fit.held)
        XCTAssertFalse(fit.needsRecheck)
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
        // 조용해진 뒤 한 번 다시 재서 한 걸음만 따라가 보고, 또 커지는 것을 확인하면 그대로 묶어 둔다.
        let before = heights
        let checked = clock.now.advanced(by: .seconds(8))
        while !(delegate.heightFit.held && !delegate.heightFit.needsRecheck), clock.now < checked { try await Task.sleep(for: .milliseconds(20)) }
        guard delegate.heightFit.held, !delegate.heightFit.needsRecheck else { throw XCTSkip("화면 밖 WebKit 이 이 실행에서는 다시 잰 뒤의 되먹임을 만들지 않았습니다") }
        XCTAssertEqual(heights.count, before.count + 1, "확인은 한 걸음뿐이다: \(heights.suffix(6))")
        let settled = heights
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(heights, settled, "묶인 뒤에는 높이가 더 바뀌지 않는다")
        XCTAssertEqual(heights, heights.sorted())
        // 이런 페이지의 높이는 다음에 열 때 쓸 값으로 기억하지 않도록 알린다.
        XCTAssertEqual(bound.last, true)
        XCTAssertEqual(delegate.heightFit.viewportBound, true)
    }

    /// review native-views-1 (실제 WebKit): 빠르게 다섯 번 자라고 멈추는 페이지는 묶였더라도 끝까지 보인다.
    @MainActor func testPageGrowingInFiveQuickStepsEndsFullyShownInARealFittedWebView() async throws {
        let compiled = await artifactBlockRule()
        let rule = try XCTUnwrap(compiled)
        let delegate = ArtifactNavigationDelegate()
        var last: CGFloat = 0
        delegate.onHeight = { last = $0 }
        let html = """
        <style>body{margin:0}.b{height:100px}</style><div class="b">0</div>
        <script>var n=0,t=setInterval(function(){var d=document.createElement('div');d.className='b';d.textContent=++n;document.body.appendChild(d);if(n==5){clearInterval(t);document.body.dataset.done='1'}},40)</script>
        """
        let view = makeArtifactWebView(html: html, title: "자람", rule: rule, delegate: delegate, fitted: true)
        defer {
            view.stopLoading()
            view.configuration.userContentController.removeAllScriptMessageHandlers(from: .defaultClient)
        }
        /// 다 자란 페이지의 높이. 아직 자라는 중이면 nil.
        func grown() async -> CGFloat? {
            guard let frame = delegate.childFrame else { return nil }
            let script = "(function(){var b=document.body;if(!b||b.dataset.done!=='1')return 0;var c=getComputedStyle(b);return Math.ceil(b.scrollHeight+(parseFloat(c.marginTop)||0)+(parseFloat(c.marginBottom)||0))})()"
            let value = try? await view.evaluateJavaScript(script, in: frame, contentWorld: .defaultClient)
            return (value as? NSNumber).map { CGFloat($0.doubleValue) }.flatMap { $0 > 0 ? $0 : nil }
        }
        var wasHeld = false, page: CGFloat?
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(15))
        while clock.now < deadline {
            wasHeld = wasHeld || delegate.heightFit.held
            if page == nil { page = await grown() }
            if let page, last >= page { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard let page else { throw XCTSkip("화면 밖 WebKit 이 이 실행에서는 페이지 스크립트를 끝까지 돌리지 않았습니다") }
        XCTAssertGreaterThanOrEqual(page, 600)
        if last < page, !wasHeld { throw XCTSkip("화면 밖 WebKit 이 이 실행에서는 높이 보고를 보내지 않았습니다") }
        XCTAssertEqual(last, page, "자라다 멈춘 페이지의 아래가 잘렸다 (묶임: \(wasHeld))")
    }

    // 공용 pollUntil(TestSupport)을 부르는 얇은 껍데기. WebKit 은 느려 기한을 20초로 둔다.
    @MainActor private func waitUntil(_ what: String, timeout: Duration = .seconds(20), _ condition: () async -> Bool) async throws {
        guard await pollUntil(what, timeout: timeout, every: .milliseconds(20), condition) else {
            throw NSError(domain: "StabnviewsArtifactRuntimeTests.Timeout", code: 1)
        }
    }
}
