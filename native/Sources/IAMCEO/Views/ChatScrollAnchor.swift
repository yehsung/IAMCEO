import SwiftUI
import Observation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct ChatVisibleAnchor: Equatable, Sendable {
    let messageID: String
    /// Row top relative to the viewport. Negative values retain partial exposure.
    let top: CGFloat
}

struct ChatMessageFramesKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

#if os(macOS)
/// Owns notification registrations without extending the controller's lifetime.
private final class ChatScrollNotifications {
    var tokens: [NSObjectProtocol] = []
    func removeAll() {
        tokens.forEach(NotificationCenter.default.removeObserver)
        tokens.removeAll()
    }
    deinit { tokens.forEach(NotificationCenter.default.removeObserver) }
}
#endif

extension View {
    /// Apply only to message wrappers, using the existing `m:<message.id>` identity.
    func chatScrollRow(id: String, coordinateSpace: String) -> some View {
        background(GeometryReader { geometry in
            Color.clear.preference(key: ChatMessageFramesKey.self,
                                   value: [id: geometry.frame(in: .named(coordinateSpace))])
        })
    }

    /// Apply to the ScrollView, and insert ChatScrollHostProbe inside its content.
    func chatScrollAnchoring(_ anchor: ChatScrollAnchor, scope: String) -> some View {
        coordinateSpace(name: scope)
            .background(GeometryReader { geometry in
                Color.clear.onAppear { anchor.setViewport(height: geometry.size.height, scope: scope) }
                    .onChange(of: geometry.size.height) { _, height in anchor.setViewport(height: height, scope: scope) }
            })
            .onPreferenceChange(ChatMessageFramesKey.self) { frames in
                MainActor.assumeIsolated { anchor.observe(frames: frames, scope: scope) }
            }
    }
}

/// One controller per conversation viewport. There is no delegate replacement, window search or private API.
/// A prepend takes precedence over append-follow. The caller must not pin the bottom while isPreservingPosition.
@MainActor @Observable final class ChatScrollAnchor {
    private(set) var scope: String
    private(set) var hostFound = false
    private(set) var isPreservingPosition = false
    private(set) var lastRestorationError: CGFloat?
    private(set) var visibleAnchor: ChatVisibleAnchor?
    private(set) var highlightedMessageID: String?
    private var highlightTask: Task<Void, Never>?
    private var viewportHeight: CGFloat = 0
    private var frames: [String: CGRect] = [:]
    private var target: ChatVisibleAnchor?
    private var transaction: UUID?
    private var deferredMutation: (() -> Void)?
    private var settling: Task<Void, Never>?
    /// 높이가 안 바뀌는 갱신은 프레임 보고가 다시 오지 않는다. 그때 보존 상태를 스스로 끝내는 감시.
    @ObservationIgnored private var restorationWatch: Task<Void, Never>?
    /// 감시 간격. 시험에서 줄인다.
    @ObservationIgnored var restorationTimeout: Duration = .milliseconds(300)
    private var probeID: UUID?
    #if os(macOS)
    private weak var host: NSScrollView?
    #else
    private weak var host: UIScrollView?
    #endif

    init(scope: String) { self.scope = scope }

    func reset(scope: String) {
        cancelPreservation()
        clearHighlight()
        #if os(macOS)
        removeObservers(); macLiveScrolling = false
        #endif
        self.scope = scope; frames = [:]; visibleAnchor = nil; viewportHeight = 0
        host = nil; hostFound = false; probeID = nil
    }

    func setViewport(height: CGFloat, scope: String) {
        guard scope == self.scope, height.isFinite else { return }
        viewportHeight = max(0, height)
        visibleAnchor = Self.firstVisible(frames: frames, viewportHeight: viewportHeight)
    }

    static func firstVisible(frames: [String: CGRect], viewportHeight: CGFloat) -> ChatVisibleAnchor? {
        guard viewportHeight.isFinite, viewportHeight > 0 else { return nil }
        return frames.filter { id, frame in
            id.hasPrefix("m:") && frame.minY.isFinite && frame.maxY.isFinite && frame.height > 0
                && frame.maxY > 0 && frame.minY < viewportHeight
        }.min { a, b in
            a.value.minY == b.value.minY ? a.key.utf8.lexicographicallyPrecedes(b.key.utf8) : a.value.minY < b.value.minY
        }.map { ChatVisibleAnchor(messageID: $0.key, top: $0.value.minY) }
    }

    func observe(frames: [String: CGRect], scope: String) {
        guard scope == self.scope else { return }
        self.frames = frames
        visibleAnchor = Self.firstVisible(frames: frames, viewportHeight: viewportHeight)
        guard transaction != nil, deferredMutation == nil, let target,
              let frame = frames[target.messageID], frame.minY.isFinite else { return }
        let delta = frame.minY - target.top
        lastRestorationError = abs(delta)
        if abs(delta) <= 0.5 {
            finishRestoration()
        } else if isInteracting {
            // A new gesture after the mutation owns the viewport. Do not rewind it on gesture completion.
            cancelPreservation()
        } else {
            // Geometry reflects the current row position, so a tail append cannot affect this delta.
            if abs(adjustOffset(by: delta)) < 0.01 {
                // Bounds may prevent the original position. Expose the actual error instead of claiming success.
                finishRestoration()
            }
        }
    }

    /// Call after a page arrives, immediately before changing the displayed array. False means no safe host/anchor.
    /// During a gesture, retain the response and capture the *latest* position after the gesture ends.
    @discardableResult func prepend(scope: String, mutation: @escaping () -> Void) -> Bool {
        guard scope == self.scope, hostFound, !isPreservingPosition, visibleAnchor != nil else { return false }
        transaction = UUID(); isPreservingPosition = true; lastRestorationError = nil
        deferredMutation = mutation
        if isInteracting { waitForSettling() } else { applyDeferredMutation() }
        return true
    }

    /// Also used by the explicit "맨 아래로" action and scope changes; no old response can restore afterwards.
    func cancelPreservation() {
        settling?.cancel(); settling = nil; deferredMutation = nil; target = nil
        restorationWatch?.cancel(); restorationWatch = nil
        transaction = nil; isPreservingPosition = false; lastRestorationError = nil
    }

    /// Start only once the destination row is laid out, so a slow around load cannot consume the emphasis.
    func highlight(messageID: String, duration: Duration = .seconds(3)) {
        clearHighlight()
        highlightedMessageID = messageID
        highlightTask = Task { [weak self] in
            do { try await Task.sleep(for: duration) } catch { return }
            // 잠을 다 잔 뒤 메인 액터를 기다리는 사이에 새 강조로 바뀌었으면(취소됨) 새 강조를 지우지 않는다.
            guard !Task.isCancelled else { return }
            self?.highlightedMessageID = nil
            self?.highlightTask = nil
        }
    }

    func clearHighlight() {
        highlightTask?.cancel(); highlightTask = nil; highlightedMessageID = nil
    }

    private func applyDeferredMutation() {
        guard let mutation = deferredMutation else { return }
        guard let visibleAnchor else { cancelPreservation(); return }
        target = visibleAnchor; deferredMutation = nil
        var transaction = Transaction(); transaction.disablesAnimations = true
        withTransaction(transaction) { mutation() }
        watchRestoration()
    }

    private func finishRestoration() {
        target = nil; transaction = nil; isPreservingPosition = false
        settling?.cancel(); settling = nil
        restorationWatch?.cancel(); restorationWatch = nil
    }

    /// 전달 상태 글자만 바뀌는 갱신처럼 어떤 행의 높이도 안 바뀌면 observe 가 다시 불리지 않아 보존 상태가
    /// 영영 안 풀리고, 그동안 이후 갱신이 전부 대기열에만 쌓인다. 잠시 뒤에도 그대로면 지금 프레임으로 끝낸다.
    private func watchRestoration() {
        restorationWatch?.cancel()
        guard let token = transaction, isPreservingPosition else { restorationWatch = nil; return }
        let timeout = restorationTimeout
        restorationWatch = Task { [weak self] in
            for _ in 0..<4 {
                do { try await Task.sleep(for: timeout) } catch { return }
                guard let self, self.transaction == token, self.deferredMutation == nil else { return }
                // 새 제스처가 화면을 잡았으면 되돌리지 않는다.
                if self.isInteracting { break }
                self.observe(frames: self.frames, scope: self.scope)
                guard self.transaction == token else { return }
                // 기준 행이 화면에서 사라졌으면 맞출 자리가 없다.
                guard let target = self.target, self.frames[target.messageID] != nil else { break }
            }
            guard let self, self.transaction == token else { return }
            self.restorationWatch = nil
            self.cancelPreservation()
        }
    }

    private func waitForSettling() {
        guard settling == nil else { return }
        let token = transaction
        settling = Task { [weak self] in
            // Observe only while a response/restoration is waiting. Never replace SwiftUI's scroll delegate.
            while !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(16)) } catch { return }
                guard let self, self.transaction == token else { return }
                if !self.isInteracting {
                    self.settling = nil
                    if self.deferredMutation != nil { self.applyDeferredMutation() }
                    else { self.observe(frames: self.frames, scope: self.scope) }
                    return
                }
            }
        }
    }

    var isInteracting: Bool {
        #if os(macOS)
        // Public live-scroll notifications also cover momentum scrolling.
        macLiveScrolling
        #else
        host.map { $0.isTracking || $0.isDragging || $0.isDecelerating } ?? false
        #endif
    }

    /// Returns actual movement in top-down points; used by the native-host prototype tests too.
    @discardableResult func adjustOffset(by delta: CGFloat) -> CGFloat {
        guard delta.isFinite, let host else { return 0 }
        #if os(macOS)
        guard let document = host.documentView else { return 0 }
        let clip = host.contentView
        let before = clip.bounds.origin.y
        let rect = document.convert(document.bounds, to: clip)
        let lower = rect.minY - (clip.isFlipped ? host.contentInsets.top : host.contentInsets.bottom)
        let upper = max(lower, rect.maxY - clip.bounds.height + (clip.isFlipped ? host.contentInsets.bottom : host.contentInsets.top))
        let direction: CGFloat = clip.isFlipped ? 1 : -1
        let next = min(max(before + delta * direction, lower), upper)
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: next))
        host.reflectScrolledClipView(clip)
        return (clip.bounds.origin.y - before) * direction
        #else
        let before = host.contentOffset.y
        let lower = -host.adjustedContentInset.top
        let upper = max(lower, host.contentSize.height - host.bounds.height + host.adjustedContentInset.bottom)
        host.setContentOffset(CGPoint(x: host.contentOffset.x, y: min(max(before + delta, lower), upper)), animated: false)
        return host.contentOffset.y - before
        #endif
    }

    #if os(macOS)
    private var macLiveScrolling = false
    /// willStart/didEnd 로 감싸진 스크롤(트랙패드 제스처, 스크롤바) 안인지.
    @ObservationIgnored private var macBracketedScroll = false
    /// 휠 마우스·키보드 스크롤은 didLiveScroll 만 온다. 마지막 알림 뒤 이만큼 조용하면 끝난 것으로 본다.
    @ObservationIgnored var looseScrollQuiet: Duration = .milliseconds(200)
    @ObservationIgnored private var looseScrollEnd: Task<Void, Never>?
    private let notifications = ChatScrollNotifications()

    private func endLooseScroll() {
        looseScrollEnd?.cancel(); looseScrollEnd = nil
    }

    /// 감싸지지 않은 사용자 스크롤. 이것을 상호작용으로 보지 않으면 위치 보정이 사용자의 스크롤을 되돌린다.
    private func looseScrolled() {
        guard !macBracketedScroll else { return }
        if !macLiveScrolling {
            macLiveScrolling = true
            if isPreservingPosition && deferredMutation == nil { cancelPreservation() }
        }
        looseScrollEnd?.cancel()
        let quiet = looseScrollQuiet
        looseScrollEnd = Task { [weak self] in
            do { try await Task.sleep(for: quiet) } catch { return }
            guard !Task.isCancelled, let self, !self.macBracketedScroll else { return }
            self.looseScrollEnd = nil
            self.macLiveScrolling = false
        }
    }

    func attach(_ host: NSScrollView?, probeID: UUID, scope: String) {
        guard scope == self.scope else { return }
        if self.host === host, self.probeID == probeID { return }
        removeObservers()
        self.host = host; self.probeID = probeID; hostFound = host != nil; macLiveScrolling = false
        guard let host else { return }
        notifications.tokens.append(NotificationCenter.default.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: host, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.endLooseScroll()
                self.macBracketedScroll = true
                self.macLiveScrolling = true
                if self.isPreservingPosition && self.deferredMutation == nil { self.cancelPreservation() }
            }
        })
        notifications.tokens.append(NotificationCenter.default.addObserver(forName: NSScrollView.didLiveScrollNotification, object: host, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.looseScrolled() }
        })
        notifications.tokens.append(NotificationCenter.default.addObserver(forName: NSScrollView.didEndLiveScrollNotification, object: host, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.endLooseScroll()
                self.macBracketedScroll = false
                self.macLiveScrolling = false
            }
        })
    }
    private func removeObservers() {
        notifications.removeAll()
        endLooseScroll(); macBracketedScroll = false
    }
    #else
    func attach(_ host: UIScrollView?, probeID: UUID, scope: String) {
        guard scope == self.scope else { return }
        self.host = host; self.probeID = probeID; hostFound = host != nil
    }
    #endif

    func detach(probeID: UUID) {
        guard self.probeID == probeID else { return }
        cancelPreservation(); host = nil; hostFound = false; self.probeID = nil
        #if os(macOS)
        removeObservers(); macLiveScrolling = false
        #endif
    }
}

// Probe discovery is strictly the nearest ancestor of the view embedded in this conversation's content.
#if os(macOS)
struct ChatScrollHostProbe: NSViewRepresentable {
    let anchor: ChatScrollAnchor
    let scope: String
    func makeNSView(context: Context) -> ChatScrollProbeView { ChatScrollProbeView(anchor: anchor, scope: scope) }
    func updateNSView(_ view: ChatScrollProbeView, context: Context) { view.configure(anchor: anchor, scope: scope) }
    static func dismantleNSView(_ view: ChatScrollProbeView, coordinator: ()) { view.disconnect() }
}

final class ChatScrollProbeView: NSView {
    private weak var anchor: ChatScrollAnchor?
    private var scope: String
    private let probeID = UUID()
    init(anchor: ChatScrollAnchor, scope: String) {
        self.anchor = anchor; self.scope = scope
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { nil }
    override func viewDidMoveToSuperview() { super.viewDidMoveToSuperview(); resolve() }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); resolve() }
    func configure(anchor: ChatScrollAnchor, scope: String) {
        if self.anchor !== anchor || self.scope != scope { disconnect() }
        self.anchor = anchor; self.scope = scope; resolve()
    }
    func disconnect() { anchor?.detach(probeID: probeID) }
    private func resolve() {
        var ancestor = superview
        while let view = ancestor {
            if let scroll = view as? NSScrollView { anchor?.attach(scroll, probeID: probeID, scope: scope); return }
            ancestor = view.superview
        }
        anchor?.attach(nil, probeID: probeID, scope: scope)
    }
}
#else
struct ChatScrollHostProbe: UIViewRepresentable {
    let anchor: ChatScrollAnchor
    let scope: String
    func makeUIView(context: Context) -> ChatScrollProbeView { ChatScrollProbeView(anchor: anchor, scope: scope) }
    func updateUIView(_ view: ChatScrollProbeView, context: Context) { view.configure(anchor: anchor, scope: scope) }
    static func dismantleUIView(_ view: ChatScrollProbeView, coordinator: ()) { view.disconnect() }
}

final class ChatScrollProbeView: UIView {
    private weak var anchor: ChatScrollAnchor?
    private var scope: String
    private let probeID = UUID()
    init(anchor: ChatScrollAnchor, scope: String) {
        self.anchor = anchor; self.scope = scope
        super.init(frame: .zero)
        isUserInteractionEnabled = false
    }
    required init?(coder: NSCoder) { nil }
    override func didMoveToSuperview() { super.didMoveToSuperview(); resolve() }
    override func didMoveToWindow() { super.didMoveToWindow(); resolve() }
    func configure(anchor: ChatScrollAnchor, scope: String) {
        if self.anchor !== anchor || self.scope != scope { disconnect() }
        self.anchor = anchor; self.scope = scope; resolve()
    }
    func disconnect() { anchor?.detach(probeID: probeID) }
    private func resolve() {
        var ancestor = superview
        while let view = ancestor {
            if let scroll = view as? UIScrollView { anchor?.attach(scroll, probeID: probeID, scope: scope); return }
            ancestor = view.superview
        }
        anchor?.attach(nil, probeID: probeID, scope: scope)
    }
}
#endif
