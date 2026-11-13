import Foundation
import SwiftUI
import WebKit
#if os(macOS)
import AppKit
import AttachmentException
#else
import UIKit
#endif

// 아티팩트(직원이 만든 HTML 페이지) 격리 규칙. 보안 설정은 바꾸지 않는다.
// 바깥으로 나가는 요청(HTTP(S)·WS(S)·file·FTP(S))은 내용 차단 규칙으로 막고, 차단 규칙을 만들지 못하면 페이지를 보이지 않는다.
// 앱이 넣은 첫 문서와 그 안의 srcdoc 틀만 열리고, 새 창·바깥 이동은 열지 않는다. 페이지 스크립트는 불투명한 sandbox 안에서
// 돌고, 높이 재기·링크 알림은 앱만의 격리된 스크립트 세계에서 한다. 링크를 열지 묻는 화면(SandboxedHTML)은 Views/FilesView.swift 에 있다.

/// WebKit's URL-filter regex subset does not support disjunction. Keep each scheme family separate.
/// CSP still limits resources to inline styles and data images/fonts; these rules also block FTP(S).
func artifactBlockRuleJSON() -> String {
    #"""
    [
        {"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^wss?:"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^file:"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^ftps?:"},"action":{"type":"block"}}
    ]
    """#
}

/// Compiled once per app run. Stays nil when WebKit refuses the rule, and then no artifact is shown.
@MainActor private var compiledArtifactRule: WKContentRuleList?

/// The HTTP(S)/WS(S)/file/FTP(S) block layer. nil means compilation failed: callers must not render.
@MainActor
func artifactBlockRule() async -> WKContentRuleList? {
    if let compiledArtifactRule { return compiledArtifactRule }
    let rules = artifactBlockRuleJSON()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "IAMCEOIsolatedArtifact", encodedContentRuleList: rules) { rule, error in
            if let error {
                NSLog("[IAMCEO] Artifact content rule compilation failed: %@", error as NSError)
            } else if rule == nil {
                NSLog("[IAMCEO] Artifact content rule compilation returned neither a rule nor an error")
            }
            if let rule { compiledArtifactRule = rule }
            continuation.resume()
        }
    }
    return compiledArtifactRule
}

/// Only loadHTMLString's first main-frame document may navigate. No URL is opened by this policy.
func artifactAllowsNavigation(firstAction: Bool, url: URL?, mainFrame: Bool, type: WKNavigationType) -> Bool {
    firstAction && mainFrame && type == .other && url?.absoluteString == "about:blank"
}

func artifactAllowsChildNavigation(loaded: Bool, url: URL?, type: WKNavigationType) -> Bool {
    guard let value = url?.absoluteString else { return false }
    return (!loaded && value == "about:srcdoc" && type == .other)
        || (loaded && value.hasPrefix("about:srcdoc#") && type == .linkActivated)
}

/// 맞춤 높이 미리보기의 수렴 감시. 측정한 높이에 프레임(=페이지의 뷰포트)을 맞추므로, 높이가 뷰포트에 따라
/// 정해지는 페이지(`min-height:100vh` 등)는 측정→맞춤→재측정이 끝없이 돌며 계속 커진다.
/// 맞추자마자 다시 커지는 보고가 연달아 오면 더 따라가지 않고 그 높이에 묶어 둔다.
struct ArtifactHeightFit: Equatable {
    enum Step: Equatable {
        case ignore
        /// 프레임과 미리보기를 이 높이에 맞춘다.
        case fit(CGFloat)
    }
    /// 연달아 이만큼 커지면 뷰포트를 따라 커지는 페이지로 본다.
    static let growthLimit = 4
    /// 맞춘 뒤 이 시간 안에 온 증가만 '연달아'로 센다(되먹임은 수십 ms 간격, 사람의 조작은 그보다 느리다).
    static let quick: TimeInterval = 1
    private var applied: CGFloat?
    private var appliedAt: TimeInterval = 0
    /// 처음 측정한 높이. 폭이 바뀌면 여기서부터 다시 맞춘다.
    private var floor: CGFloat?
    private var growths = 0
    private var ceiling: CGFloat = 0
    private var escapes = 0
    /// 묶은 뒤 조용해졌을 때 한 걸음 따라가 보는 중인지.
    private var trial = false
    /// 따라가 보자마자 또 커져, 뷰포트를 따라 커지는 페이지로 확인했는지.
    private var confirmed = false
    /// 지금 묶여 있는지.
    private(set) var held = false
    /// 뷰포트를 따라 커지는 페이지로 판정된 적이 있는지.
    private(set) var viewportBound = false
    /// 묶었지만 아직 확인하지 못했다. 조용해진 뒤(`quick` 뒤) 한 번 다시 재야 한다.
    var needsRecheck: Bool { held && !confirmed }

    mutating func report(_ height: CGFloat, at time: TimeInterval) -> Step {
        guard let applied else {
            self.applied = height; appliedAt = time; floor = height
            return .fit(height)
        }
        if held {
            // 뷰포트보다 작아질 수 없는 페이지가 줄었다면 내용이 줄어든 것이다.
            if height < applied - 0.5 { return follow(height, at: time, growths: 0) }
            guard height > applied + 0.5 else { return .ignore }
            let late = time - appliedAt > Self.quick
            if late, !confirmed {
                // 조용해진 뒤에도 프레임보다 크다. 자라다 멈춘 내용일 수 있으니 한 걸음만 따라가 본다.
                // 뷰포트를 따라 커지는 페이지라면 맞추자마자 또 커지므로, 아래에서 확인하고 다시 묶는다.
                viewportBound = false; trial = true
                return follow(height, at: time, growths: 0)
            }
            guard height > ceiling + 0.5 else { return .ignore }
            // 묶은 뒤에는 프레임이 그대로라 되먹임 보고는 한 번(이미 오던 것)으로 끝난다.
            // 한참 뒤에 오거나 계속 커지면 내용이 스스로 자라는 것이다.
            ceiling = height; escapes += 1
            if escapes >= 2 || late {
                viewportBound = false
                return follow(height, at: time, growths: 0)
            }
            return .ignore
        }
        if abs(height - applied) <= 0.5 { return .ignore }
        let rapid = height > applied && time - appliedAt <= Self.quick
        if trial {
            trial = false
            if rapid {
                // 따라가 보자마자 또 커졌다. 뷰포트를 따라 커지는 페이지다. 더 따라가지 않고, 다시 확인하지도 않는다.
                held = true; viewportBound = true; confirmed = true; ceiling = height; escapes = 1
                return .ignore
            }
        }
        let next = rapid ? growths + 1 : 0
        let step = follow(height, at: time, growths: next)
        if next >= Self.growthLimit {
            held = true; viewportBound = true; ceiling = height; escapes = 0
        }
        return step
    }

    /// 폭이 바뀌면 높이도 달라진다. 묶였던 페이지는 처음 높이에서 다시 맞춰, 폭이 바뀔 때마다 높이가 쌓이지 않게 한다.
    mutating func widthChanged(at time: TimeInterval) -> Step {
        growths = 0; trial = false
        guard viewportBound, let floor else { return .ignore }
        return follow(floor, at: time, growths: 0)
    }

    private mutating func follow(_ height: CGFloat, at time: TimeInterval, growths: Int) -> Step {
        applied = height; appliedAt = time; self.growths = growths
        held = false; escapes = 0
        return .fit(height)
    }
}

@MainActor
final class ArtifactNavigationDelegate: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var childLoaded = false
    private(set) var childFrame: WKFrameInfo?
    var onLink: ((String) -> Void)?
    private(set) var heightFit = ArtifactHeightFit()
    /// 뷰포트를 따라 커지는 페이지로 판정되거나 풀렸을 때. 그런 페이지의 높이는 다음에 열 때 쓸 값으로 기억하지 않는다.
    var onViewportBound: ((Bool) -> Void)?
    /// 높이 보고 시각(시험에서 바꾼다).
    var uptime: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    /// 묶은 뒤 다시 재기까지의 시간. `quick`보다 길어야 한다.
    var recheckDelay: TimeInterval = ArtifactHeightFit.quick + 0.2
    /// 웹 콘텐츠 프로세스가 종료됐을 때 같은 문서를 다시 넣기 위한 것.
    var sandboxDocument: (() -> String)?
    private(set) var processReloads = 0
    static let processReloadLimit = 2
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !message.frameInfo.isMainFrame, message.frameInfo.request.url?.absoluteString.hasPrefix("about:srcdoc") == true else { return }
        if message.name == "artifactHeight", let number = message.body as? NSNumber {
            let height = number.doubleValue
            guard height.isFinite, height > 0 else { return }
            childFrame = message.frameInfo
            report(CGFloat(height), in: message.webView)
        } else if message.name == "artifactLink", let value = message.body as? String { onLink?(value) }
        else if message.name == "artifactAnchor", let value = message.body as? NSNumber,
                value.doubleValue.isFinite, value.doubleValue >= 0,
                let view = message.webView as? ArtifactWebView, view.fitted {
            view.scrollToAnchor(CGFloat(value.doubleValue))
        }
    }

    /// 측정된 페이지 높이를 반영한다. 맞춤 미리보기는 수렴 감시를 거친다.
    private func report(_ height: CGFloat, in webView: WKWebView?) {
        guard let view = webView as? ArtifactWebView, view.fitted else { onHeight?(height); return }
        let bound = heightFit.viewportBound, waiting = heightFit.needsRecheck
        let step = heightFit.report(height, at: uptime())
        if heightFit.viewportBound != bound { onViewportBound?(heightFit.viewportBound) }
        apply(step, to: view)
        if heightFit.needsRecheck, !waiting { recheck(view) }
    }

    /// 묶은 직후의 증가는 되먹임인지 내용이 자란 것인지 알 수 없어 무시한다. 조용해진 뒤 한 번 다시 재서,
    /// 자라다 멈춘 페이지의 마지막 한 걸음이 잘린 채 남지 않게 한다.
    private func recheck(_ view: ArtifactWebView) {
        let delay = recheckDelay
        Task { @MainActor [weak self, weak view] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, let view, self.heightFit.needsRecheck else { return }
            self.measure(view)
        }
    }

    private func apply(_ step: ArtifactHeightFit.Step, to view: ArtifactWebView) {
        guard case .fit(let height) = step else { return }
        onHeight?(height)
        view.evaluateJavaScript("document.getElementById('artifact').style.height='" + String(Double(height)) + "px'", in: nil, in: .defaultClient, completionHandler: { _ in })
    }

    /// 폭이 바뀐 뒤(WebKit이 새 폭으로 배치한 다음) 다시 잰다.
    fileprivate func widthChanged(_ view: ArtifactWebView) {
        apply(heightFit.widthChanged(at: uptime()), to: view)
        measure(view)
    }
    private var firstAction = true
    /// Reports the page's content height (fitted previews only).
    var onHeight: ((CGFloat) -> Void)?
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let main = navigationAction.targetFrame?.isMainFrame == true
        var allow = artifactAllowsNavigation(firstAction: firstAction, url: url, mainFrame: main, type: navigationAction.navigationType)
        if !main, navigationAction.targetFrame != nil,
           artifactAllowsChildNavigation(loaded: childLoaded, url: url, type: navigationAction.navigationType) {
            childLoaded = true; allow = true
        }
        if main { firstAction = false }
        decisionHandler(allow ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { measure(webView) }

    /// 웹 콘텐츠 프로세스가 종료되면(iPhone이 뒤에 있는 앱의 프로세스를 거둘 때 등) 페이지가 빈 상자로 남는다.
    /// 앱이 만든 같은 문서를 처음 여는 것과 똑같은 규칙으로 다시 넣는다. 반복 종료에 대비해 횟수를 제한한다.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let sandboxDocument, processReloads < Self.processReloadLimit else { return }
        processReloads += 1
        firstAction = true; childLoaded = false; childFrame = nil
        if heightFit.viewportBound { onViewportBound?(false) }
        heightFit = ArtifactHeightFit()
        webView.loadHTMLString(sandboxDocument(), baseURL: nil)
    }

    /// The page height as the web measures it (the body's scroll height plus its margins), read from the app's own
    /// isolated script world: page scripts run inside the opaque sandbox, and nothing the page defines can answer for it.
    func measure(_ webView: WKWebView) {
        guard onHeight != nil else { return }
        let script = "(function(){var b=document.body;if(!b)return 0;var c=getComputedStyle(b);return Math.ceil(b.scrollHeight+(parseFloat(c.marginTop)||0)+(parseFloat(c.marginBottom)||0))})()"
        guard let childFrame else { return }
        webView.evaluateJavaScript(script, in: childFrame, in: .defaultClient) { [weak self, weak webView] result in
            if case .success(let value) = result, let height = (value as? NSNumber)?.doubleValue, height.isFinite, height > 0 {
                self?.report(CGFloat(height), in: webView)
            }
        }
    }
}

/// The artifact web view. A fitted preview is as tall as its page, like the web's frame: it re-measures when its width
/// changes, and on Mac hands vertical scrolling to the page around it (a sideways swipe still scrolls a wide table).
private final class ArtifactWebView: WKWebView {
    var fitted = false
    weak var measurer: ArtifactNavigationDelegate?
    private var measuredWidth: CGFloat = -1

    #if os(macOS)
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        widthChanged(newSize.width)
    }
    override func scrollWheel(with event: NSEvent) {
        if fitted && abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX) { nextResponder?.scrollWheel(with: event) }
        else { super.scrollWheel(with: event) }
    }
    #else
    override func layoutSubviews() {
        super.layoutSubviews()
        widthChanged(bounds.width)
    }
    #endif

    func scrollToAnchor(_ top: CGFloat) {
        var ancestor = superview
        while let current = ancestor {
            #if os(macOS)
            if let scroll = current as? NSScrollView, let document = scroll.documentView {
                document.scrollToVisible(convert(CGRect(x: 0, y: top, width: 1, height: 44), to: document))
                return
            }
            #else
            if let scroll = current as? UIScrollView {
                scroll.scrollRectToVisible(convert(CGRect(x: 0, y: top, width: 1, height: 44), to: scroll), animated: false)
                return
            }
            #endif
            ancestor = current.superview
        }
    }

    private func widthChanged(_ width: CGFloat) {
        guard fitted, abs(width - measuredWidth) > 0.5 else { return }
        measuredWidth = width
        // After WebKit has laid the page out at the new width.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self, !self.isLoading else { return }
            self.measurer?.widthChanged(self)
        }
    }
}

/// Requires the compiled block layer before loading any artifact HTML. The page gets the web's artifact kit (dark page,
/// type scale, cards, grids, callouts) under the same protected policy; page scripts run inside the opaque sandbox.
@MainActor
func makeArtifactWebView(html: String, title: String?, rule: WKContentRuleList, delegate: ArtifactNavigationDelegate,
                                 fitted: Bool) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    let controller = configuration.userContentController
    controller.add(delegate, contentWorld: .defaultClient, name: "artifactHeight")
    controller.add(delegate, contentWorld: .defaultClient, name: "artifactLink")
    controller.add(delegate, contentWorld: .defaultClient, name: "artifactAnchor")
    controller.addUserScript(WKUserScript(source: artifactObservationScript, injectionTime: .atDocumentStart,
                                        forMainFrameOnly: false, in: .defaultClient))
    configuration.userContentController.add(rule)
    let view = ArtifactWebView(frame: .zero, configuration: configuration)
    view.fitted = fitted
    view.measurer = delegate
    view.navigationDelegate = delegate
    view.uiDelegate = delegate
    // No white flash before the kit's dark page paints.
    #if os(macOS)
    // 공개되지 않은 KVC 키다. 없어지면 예외가 나는데, 앱은 AppKit 예외를 즉시 종료로 다루므로 여기서 막는다
    // (실패하면 배경만 불투명하게 남는다).
    if IAMCEOCatchException({ view.setValue(false, forKey: "drawsBackground") }) != nil {
        NSLog("[IAMCEO] Artifact web view background could not be made clear")
    }
    #else
    view.isOpaque = false
    view.backgroundColor = .clear
    view.scrollView.backgroundColor = .clear
    if fitted { view.scrollView.isScrollEnabled = false }
    #endif
    let document = { ArtifactKit.sandboxDocument(html, title: title, fitted: fitted) }
    delegate.sandboxDocument = document
    view.loadHTMLString(document(), baseURL: nil)
    return view
}
#if os(macOS)
struct SandboxedHTMLSurface: NSViewRepresentable {
    let html: String
    let rule: WKContentRuleList
    var title: String? = nil
    /// Fitted: as tall as the page (reported here); otherwise the page scrolls inside the view.
    var height: Binding<CGFloat>? = nil
    var viewportBound: Binding<Bool>? = nil
    var onLink: (String) -> Void
    func makeCoordinator() -> ArtifactNavigationDelegate {
        let delegate = ArtifactNavigationDelegate(); delegate.onLink = onLink; return delegate
    }
    func makeNSView(context: Context) -> WKWebView {
        if let height { context.coordinator.onHeight = { value in if abs(height.wrappedValue - value) > 0.5 { height.wrappedValue = value } } }
        if let viewportBound { context.coordinator.onViewportBound = { value in if viewportBound.wrappedValue != value { viewportBound.wrappedValue = value } } }
        return makeArtifactWebView(html: html, title: title, rule: rule, delegate: context.coordinator, fitted: height != nil)
    }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: ArtifactNavigationDelegate) {
        view.stopLoading(); view.configuration.userContentController.removeAllScriptMessageHandlers(from: .defaultClient)
        coordinator.onHeight = nil; coordinator.onLink = nil; coordinator.sandboxDocument = nil; coordinator.onViewportBound = nil
    }
}
#else
struct SandboxedHTMLSurface: UIViewRepresentable {
    let html: String
    let rule: WKContentRuleList
    var title: String? = nil
    var height: Binding<CGFloat>? = nil
    var viewportBound: Binding<Bool>? = nil
    var onLink: (String) -> Void
    func makeCoordinator() -> ArtifactNavigationDelegate {
        let delegate = ArtifactNavigationDelegate(); delegate.onLink = onLink; return delegate
    }
    func makeUIView(context: Context) -> WKWebView {
        if let height { context.coordinator.onHeight = { value in if abs(height.wrappedValue - value) > 0.5 { height.wrappedValue = value } } }
        if let viewportBound { context.coordinator.onViewportBound = { value in if viewportBound.wrappedValue != value { viewportBound.wrappedValue = value } } }
        return makeArtifactWebView(html: html, title: title, rule: rule, delegate: context.coordinator, fitted: height != nil)
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: ArtifactNavigationDelegate) {
        view.stopLoading(); view.configuration.userContentController.removeAllScriptMessageHandlers(from: .defaultClient)
        coordinator.onHeight = nil; coordinator.onLink = nil; coordinator.sandboxDocument = nil; coordinator.onViewportBound = nil
    }
}
#endif

/// App-only, isolated-world observation. Page scripts cannot call these message handlers.
private let artifactObservationScript = #"""
(function(){if(window.top===window)return;function measure(){var b=document.body;if(!b)return;var c=getComputedStyle(b);window.webkit.messageHandlers.artifactHeight.postMessage(Math.ceil(b.scrollHeight+(parseFloat(c.marginTop)||0)+(parseFloat(c.marginBottom)||0)))}var observer=new ResizeObserver(measure);addEventListener('DOMContentLoaded',function(){if(document.body)observer.observe(document.body);measure()});addEventListener('load',measure);addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var h=a.getAttribute('href')||'';if(h.charAt(0)==='#'){try{var id=decodeURIComponent(h.slice(1)),target=id?document.getElementById(id)||document.getElementsByName(id)[0]:document.body;if(target){window.webkit.messageHandlers.artifactAnchor.postMessage(target.getBoundingClientRect().top+window.scrollY)}}catch(x){}return}e.preventDefault();if(!e.isTrusted)return;window.webkit.messageHandlers.artifactLink.postMessage(a.href)},true)})()
"""#
