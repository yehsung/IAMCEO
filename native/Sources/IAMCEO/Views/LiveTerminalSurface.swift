import SwiftUI
import SwiftTerm

struct TerminalGridLayout: Equatable {
    let fontSize: CGFloat
    let width: CGFloat
    let height: CGFloat
    static func control(viewport: CGSize, cellWidth: CGFloat, cellHeight: CGFloat) -> (cols: Int, rows: Int) {
        (max(40, min(320, Int(viewport.width / max(1, cellWidth)))),
         max(10, min(200, Int(viewport.height / max(1, cellHeight)))))
    }
    static func observe(cols: Int, rows: Int, viewportWidth: CGFloat, baseFont: CGFloat, minimumFont: CGFloat,
                        cellWidth: CGFloat, cellHeight: CGFloat) -> Self {
        let naturalWidth = CGFloat(max(1, cols)) * cellWidth
        let scale = max(minimumFont / baseFont, min(1, max(1, viewportWidth) / max(1, naturalWidth)))
        return Self(fontSize: baseFont * scale, width: naturalWidth * scale, height: CGFloat(max(1, rows)) * cellHeight * scale)
    }
}

/// SwiftTerm owns VT parsing, selection, accessibility and (on iOS) the input accessory.
struct LiveTerminalSurface: View {
    let client: TerminalStreamClient
    let mode: TerminalStreamMode
    let cols: Int
    let rows: Int
    var onTypeWhileObserving: (Data) -> Void
    var onSize: (Int, Int) -> Void
    @State private var following = true
    var body: some View {
        TerminalRepresentable(client: client, mode: mode, cols: cols, rows: rows, following: $following,
                              onTypeWhileObserving: onTypeWhileObserving, onSize: onSize)
            .overlay(alignment: .bottomTrailing) {
                if mode == .observe && !following {
                    Button("맨 아래로", systemImage: "arrow.down.to.line") { following = true }
                        .ceSecondaryButton().padding(10).accessibilityLabel("터미널 맨 아래로")
                }
            }
    }
}

@MainActor
final class TerminalSurfaceCoordinator: NSObject, @preconcurrency TerminalViewDelegate {
    var parent: TerminalRepresentable
    let outputID = UUID()
    weak var host: TerminalSurfaceHost?
    init(_ parent: TerminalRepresentable) { self.parent = parent }
    func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
        guard parent.mode == .control else { return }
        Task { [weak self] in
            guard let self, self.parent.mode == .control else { return }
            self.parent.onSize(newCols, newRows)
        }
        parent.client.resize(cols: newCols, rows: newRows)
    }
    func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
        guard host?.feeding != true else { return } // VT device reports never claim human control.
        if parent.mode == .control { parent.client.send(Data(data)) }
        else { parent.onTypeWhileObserving(Data(data)) }
    }
    func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
    #if os(iOS)
    // SwiftTerm 1.18 only provides a default link handler on macOS.
    func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {}
    #endif
    func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {
        if parent.following { host?.followCursor() }
    }
    func scrolled(source: SwiftTerm.TerminalView, position: Double) {
        // SwiftTerm also sends this notification from parser/display timers.
        // Only the input paths below can establish that a human scrolled.
    }
    func performUserScroll(_ action: () -> Void) {
        guard let host else { action(); return }
        let before = host.scrollLocation
        action()
        userScrolled(from: before)
    }
    func userScrolled(from before: TerminalScrollLocation) {
        guard let host, parent.mode == .observe, host.scrollLocation.isAbove(before),
              TerminalPresentation.pausesFollowing(userScroll: true, programmatic: host.programmaticScroll || host.feeding,
                                                  layingOut: host.layingOut) else { return }
        stopFollowing()
    }
    func stopFollowing() {
        parent.following = false
    }
    func naturalGrid(viewport: CGSize, ideal: CGSize, cols: Int, rows: Int) -> (cols: Int, rows: Int) {
        let grid = TerminalGridLayout.control(viewport: viewport, cellWidth: ideal.width / CGFloat(max(1, cols)), cellHeight: ideal.height / CGFloat(max(1, rows)))
        Task { [weak self] in self?.parent.onSize(grid.cols, grid.rows) }
        return grid
    }
}

/// The outer viewport and SwiftTerm's scrollback are independent scroll axes.
struct TerminalScrollLocation {
    let viewportY: CGFloat
    let historyRow: Int
    func isAbove(_ previous: Self) -> Bool {
        viewportY < previous.viewportY || historyRow < previous.historyRow
    }
    static func viewportY(_ offset: CGFloat, minimum: CGFloat, maximum: CGFloat) -> CGFloat {
        // Rubber-band recovery from a downward scroll is not an upward scroll.
        max(minimum, min(offset, maximum))
    }
}

#if os(macOS)
/// Wrap each scroller action, including SwiftTerm's private scroller, rather than
/// treating arbitrary bounds changes as user input. Tracking may run a nested loop;
/// the user scope covers only the action, not the entire mouse-down lifetime.
@MainActor
final class TerminalScrollAction: NSObject {
    weak var coordinator: TerminalSurfaceCoordinator?
    weak var target: AnyObject?
    let action: Selector
    init(scroller: NSScroller, coordinator: TerminalSurfaceCoordinator) {
        target = scroller.target
        action = scroller.action!
        self.coordinator = coordinator
        super.init()
        scroller.target = self
        scroller.action = #selector(scroll(_:))
    }
    @objc func scroll(_ sender: NSScroller) {
        coordinator?.performUserScroll { NSApplication.shared.sendAction(action, to: target, from: sender) }
    }
}

struct TerminalRepresentable: NSViewRepresentable {
    let client: TerminalStreamClient
    let mode: TerminalStreamMode
    let cols: Int
    let rows: Int
    @Binding var following: Bool
    let onTypeWhileObserving: (Data) -> Void
    let onSize: (Int, Int) -> Void
    func makeCoordinator() -> TerminalSurfaceCoordinator { TerminalSurfaceCoordinator(self) }
    func makeNSView(context: Context) -> TerminalSurfaceHost {
        let host = TerminalSurfaceHost(frame: .zero, coordinator: context.coordinator)
        context.coordinator.host = host
        client.attachOutput(owner: context.coordinator.outputID) { [weak host] in host?.feed($0) }
        return host
    }
    func updateNSView(_ host: TerminalSurfaceHost, context: Context) {
        context.coordinator.parent = self; host.needsLayout = true
        if following { host.followCursor() }
    }
    static func dismantleNSView(_ host: TerminalSurfaceHost, coordinator: TerminalSurfaceCoordinator) {
        host.teardown()
        coordinator.parent.client.detachOutput(owner: coordinator.outputID)
    }
}

final class TerminalCanvas: SwiftTerm.TerminalView {
    weak var surface: TerminalSurfaceHost?
    nonisolated override func send(source: SwiftTerm.Terminal, data: ArraySlice<UInt8>) {
        let bytes = Array(data)
        Task { @MainActor [weak self] in
            guard let self, self.surface?.coordinator.parent.mode == .control else { return }
            self.terminalDelegate?.send(source: self, data: bytes[...])
        }
    }
}

final class TerminalSurfaceHost: NSScrollView {
    let coordinator: TerminalSurfaceCoordinator
    let terminal: TerminalCanvas
    var feeding = false
    var programmaticScroll = false
    private(set) var layingOut = false
    private var layoutKey: [CGFloat] = []
    private var inputMonitor: Any?
    private var scrollActions: [TerminalScrollAction] = []
    private var liveScrollObservers: [NSObjectProtocol] = []
    private var liveScrollY: CGFloat?
    private var pendingBytes: [Data] = []
    private let canvas = TerminalDocumentCanvas()
    private var fixedGrid: [Int] = []
    init(frame: CGRect, coordinator: TerminalSurfaceCoordinator) {
        self.coordinator = coordinator
        var options = TerminalOptions.default
        options.cols = coordinator.parent.cols; options.rows = coordinator.parent.rows
        terminal = TerminalCanvas(frame: CGRect(x: 0, y: 0, width: 800, height: 500), font: Self.font(12), options: options)
        super.init(frame: frame)
        drawsBackground = true; backgroundColor = NSColor(red: 11/255, green: 9/255, blue: 24/255, alpha: 1)
        hasVerticalScroller = true; hasHorizontalScroller = true; autohidesScrollers = true
        terminal.nativeBackgroundColor = backgroundColor
        terminal.nativeForegroundColor = NSColor(CE.ink); terminal.caretColor = NSColor(CE.accent)
        terminal.terminalDelegate = coordinator; terminal.surface = self
        canvas.addSubview(terminal); documentView = canvas
        let scrollers = [verticalScroller].compactMap { $0 } + terminal.subviews.compactMap { $0 as? NSScroller }
        scrollActions = scrollers.filter { $0.action != nil }.map { TerminalScrollAction(scroller: $0, coordinator: coordinator) }
        // AppKit may apply wheel momentum after scrollWheel(with:) has returned.
        liveScrollObservers = [NSScrollView.willStartLiveScrollNotification, NSScrollView.didLiveScrollNotification].map { name in
            NotificationCenter.default.addObserver(forName: name, object: self, queue: .main) { [weak self] notification in
                let didScroll = notification.name == NSScrollView.didLiveScrollNotification
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let current = self.scrollLocation
                    if didScroll, let y = self.liveScrollY {
                        self.coordinator.userScrolled(from: TerminalScrollLocation(viewportY: y, historyRow: current.historyRow))
                    }
                    self.liveScrollY = current.viewportY
                }
            }
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    static func font(_ size: CGFloat) -> NSFont {
        .monospacedSystemFont(ofSize: size, weight: .regular)
    }
    func teardown() {
        if let inputMonitor { NSEvent.removeMonitor(inputMonitor); self.inputMonitor = nil }
        liveScrollObservers.forEach(NotificationCenter.default.removeObserver)
        liveScrollObservers.removeAll()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let inputMonitor { NSEvent.removeMonitor(inputMonitor); self.inputMonitor = nil }
        if window != nil {
            window?.makeFirstResponder(terminal)
            inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .keyDown]) { [weak self] event in
                guard let self, self.coordinator.parent.mode == .observe, event.window === self.window else { return event }
                if event.type == .keyDown {
                    guard self.window?.firstResponder === self.terminal,
                          let key = event.charactersIgnoringModifiers?.unicodeScalars.first,
                          [NSPageUpFunctionKey, NSPageDownFunctionKey].contains(Int(key.value)) else { return event }
                    self.handleObservedKey(event)
                } else {
                    guard self.bounds.contains(self.convert(event.locationInWindow, from: nil)) else { return event }
                    self.scrollWheel(with: event)
                }
                return nil
            }
        }
    }
    override func layout() {
        super.layout()
        guard !layingOut, contentSize.width > 0 else { return }
        layingOut = true
        defer {
            layingOut = false
            let bytes = pendingBytes; pendingBytes.removeAll()
            bytes.forEach(feed)
        }
        let parent = coordinator.parent
        terminal.allowMouseReporting = parent.mode == .control
        let key = [contentSize.width, contentSize.height, CGFloat(parent.cols), CGFloat(parent.rows), parent.mode == .control ? 1 : 0]
        guard key != layoutKey else { return }; layoutKey = key
        if parent.mode == .control {
            let dimensions = terminal.getTerminal().getDims()
            let grid = coordinator.naturalGrid(viewport: contentSize, ideal: terminal.getOptimalFrameSize().size, cols: dimensions.cols, rows: dimensions.rows)
            TerminalRenderer.resize(terminal, cols: grid.cols, rows: grid.rows)
            let ideal = terminal.getOptimalFrameSize().size
            let size = CGSize(width: max(ideal.width, contentSize.width), height: max(ideal.height, contentSize.height))
            canvas.frame = CGRect(origin: .zero, size: size); canvas.bounds.size = size
            terminal.frame = CGRect(origin: .zero, size: ideal)
        } else {
            if fixedGrid != [parent.cols, parent.rows] {
                TerminalRenderer.resize(terminal, cols: parent.cols, rows: parent.rows)
                terminal.setFrameSize(terminal.getOptimalFrameSize().size)
                TerminalRenderer.resize(terminal, cols: parent.cols, rows: parent.rows)
                fixedGrid = [parent.cols, parent.rows]
            }
            let ideal = terminal.getOptimalFrameSize().size
            _ = coordinator.naturalGrid(viewport: contentSize, ideal: ideal, cols: parent.cols, rows: parent.rows)
            let fit = TerminalGridLayout.observe(cols: parent.cols, rows: parent.rows, viewportWidth: contentSize.width,
                                                  baseFont: 12, minimumFont: 8, cellWidth: ideal.width / CGFloat(parent.cols), cellHeight: ideal.height / CGFloat(parent.rows))
            // Scale the parent coordinate system. SwiftTerm's font, frame and
            // grid never change while an observer resizes its window.
            canvas.setFrameSize(CGSize(width: fit.width, height: fit.height)); canvas.setBoundsSize(ideal)
        }
    }
    func handleObservedKey(_ event: NSEvent) {
        // SwiftTerm's keyDown/doCommand methods are public, but not open.
        coordinator.performUserScroll { terminal.keyDown(with: event) }
    }
    override func scrollWheel(with event: NSEvent) {
        coordinator.performUserScroll { super.scrollWheel(with: event) }
    }
    var scrollLocation: TerminalScrollLocation {
        let clip = contentView
        return TerminalScrollLocation(viewportY: TerminalScrollLocation.viewportY(clip.bounds.minY,
            minimum: clip.documentRect.minY, maximum: clip.documentRect.maxY - clip.bounds.height),
            historyRow: terminal.getTerminal().getTopVisibleRow())
    }
    func feed(_ data: Data) {
        layoutSubtreeIfNeeded()
        guard contentSize.width > 0, !layoutKey.isEmpty else { pendingBytes.append(data); return }
        feeding = true; terminal.feed(byteArray: Array(data)[...]); feeding = false
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(20))
            guard let self, self.coordinator.parent.following else { return }; self.followCursor()
        }
    }
    func followCursor() {
        guard coordinator.parent.mode == .observe else { return }
        programmaticScroll = true
        terminal.scroll(toPosition: 1)
        terminal.scrollToVisible(terminal.caretFrame.insetBy(dx: 0, dy: -6))
        programmaticScroll = false
    }
}
#else
struct TerminalRepresentable: UIViewRepresentable {
    let client: TerminalStreamClient
    let mode: TerminalStreamMode
    let cols: Int
    let rows: Int
    @Binding var following: Bool
    let onTypeWhileObserving: (Data) -> Void
    let onSize: (Int, Int) -> Void
    func makeCoordinator() -> TerminalSurfaceCoordinator { TerminalSurfaceCoordinator(self) }
    func makeUIView(context: Context) -> TerminalSurfaceHost {
        let host = TerminalSurfaceHost(frame: .zero, coordinator: context.coordinator)
        context.coordinator.host = host
        client.attachOutput(owner: context.coordinator.outputID) { [weak host] in host?.feed($0) }
        return host
    }
    func updateUIView(_ host: TerminalSurfaceHost, context: Context) {
        context.coordinator.parent = self; host.setNeedsLayout()
        if following { host.followCursor() }
    }
    static func dismantleUIView(_ host: TerminalSurfaceHost, coordinator: TerminalSurfaceCoordinator) {
        coordinator.parent.client.detachOutput(owner: coordinator.outputID)
    }
}

final class TerminalSurfaceHost: UIScrollView, UIScrollViewDelegate {
    let coordinator: TerminalSurfaceCoordinator
    let terminal: TerminalCanvas
    var feeding = false
    var programmaticScroll = false
    private(set) var layingOut = false
    private var layoutKey: [CGFloat] = []
    private var pendingBytes: [Data] = []
    private let canvas = UIView()
    private var dragLocation: TerminalScrollLocation?
    private var fixedGrid: [Int] = []
    init(frame: CGRect, coordinator: TerminalSurfaceCoordinator) {
        self.coordinator = coordinator
        var options = TerminalOptions.default
        options.cols = coordinator.parent.cols; options.rows = coordinator.parent.rows
        terminal = TerminalCanvas(frame: CGRect(x: 0, y: 0, width: 600, height: 400), font: Self.font(10), options: options)
        super.init(frame: frame)
        backgroundColor = UIColor(red: 11/255, green: 9/255, blue: 24/255, alpha: 1)
        terminal.nativeBackgroundColor = backgroundColor!
        terminal.nativeForegroundColor = UIColor(CE.ink); terminal.caretColor = UIColor(CE.accent)
        terminal.terminalDelegate = coordinator; terminal.surface = self
        canvas.addSubview(terminal); addSubview(canvas); delegate = self
        keyboardDismissMode = .interactive
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    static func font(_ size: CGFloat) -> UIFont {
        .monospacedSystemFont(ofSize: size, weight: .regular)
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil, coordinator.parent.mode == .control { _ = terminal.becomeFirstResponder() }
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard !layingOut, bounds.width > 0 else { return }
        layingOut = true
        defer {
            layingOut = false
            let bytes = pendingBytes; pendingBytes.removeAll()
            bytes.forEach(feed)
        }
        let parent = coordinator.parent
        terminal.allowMouseReporting = parent.mode == .control
        let key = [bounds.width, bounds.height, CGFloat(parent.cols), CGFloat(parent.rows), parent.mode == .control ? 1 : 0]
        guard key != layoutKey else { return }; layoutKey = key
        terminal.isScrollEnabled = parent.mode == .control
        if parent.mode == .control {
            minimumZoomScale = 1; maximumZoomScale = 1
            let dimensions = terminal.getTerminal().getDims()
            let grid = coordinator.naturalGrid(viewport: bounds.size, ideal: terminal.getOptimalFrameSize().size, cols: dimensions.cols, rows: dimensions.rows)
            TerminalRenderer.resize(terminal, cols: grid.cols, rows: grid.rows)
            let ideal = terminal.getOptimalFrameSize().size
            let size = CGSize(width: max(ideal.width, bounds.width), height: max(ideal.height, bounds.height))
            canvas.frame = CGRect(origin: .zero, size: size)
            terminal.frame = CGRect(origin: .zero, size: ideal); contentSize = size
        } else {
            if fixedGrid != [parent.cols, parent.rows] {
                TerminalRenderer.resize(terminal, cols: parent.cols, rows: parent.rows)
                terminal.frame = terminal.getOptimalFrameSize()
                TerminalRenderer.resize(terminal, cols: parent.cols, rows: parent.rows)
                fixedGrid = [parent.cols, parent.rows]
            }
            let ideal = terminal.getOptimalFrameSize().size
            _ = coordinator.naturalGrid(viewport: bounds.size, ideal: ideal, cols: parent.cols, rows: parent.rows)
            let fit = TerminalGridLayout.observe(cols: parent.cols, rows: parent.rows, viewportWidth: bounds.width,
                                                  baseFont: 10, minimumFont: 6, cellWidth: ideal.width / CGFloat(parent.cols), cellHeight: ideal.height / CGFloat(parent.rows))
            let wasFitted = abs(zoomScale - minimumZoomScale) < 0.01
            canvas.bounds.size = ideal
            minimumZoomScale = fit.fontSize / 10; maximumZoomScale = 3
            if wasFitted || zoomScale < minimumZoomScale { zoomScale = minimumZoomScale }
            canvas.center = CGPoint(x: ideal.width * zoomScale / 2, y: ideal.height * zoomScale / 2)
            contentSize = CGSize(width: ideal.width * zoomScale, height: ideal.height * zoomScale)
        }
    }
    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        let density = TerminalPresentation.renderScale(zoom: scale, screen: window?.screen.scale ?? UIScreen.main.scale)
        terminal.contentScaleFactor = density; terminal.layer.contentsScale = density
        terminal.setNeedsDisplay()
    }
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { coordinator.parent.mode == .observe ? canvas : nil }
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { dragLocation = scrollLocation }
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView.isDragging || scrollView.isDecelerating else { return }
        defer { dragLocation = scrollLocation }
        if let before = dragLocation {
            coordinator.userScrolled(from: TerminalScrollLocation(viewportY: before.viewportY, historyRow: scrollLocation.historyRow))
        }
    }
    var scrollLocation: TerminalScrollLocation {
        TerminalScrollLocation(viewportY: TerminalScrollLocation.viewportY(contentOffset.y,
            minimum: -adjustedContentInset.top, maximum: contentSize.height - bounds.height + adjustedContentInset.bottom),
            historyRow: terminal.getTerminal().getTopVisibleRow())
    }
    func feed(_ data: Data) {
        layoutIfNeeded()
        guard bounds.width > 0, !layoutKey.isEmpty else { pendingBytes.append(data); return }
        feeding = true; terminal.feed(byteArray: Array(data)[...]); feeding = false
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(20))
            guard let self, self.coordinator.parent.following else { return }; self.followCursor()
        }
    }
    func followCursor() {
        guard coordinator.parent.mode == .observe else { return }
        programmaticScroll = true
        terminal.scroll(toPosition: 1)
        scrollRectToVisible(terminal.convert(terminal.caretFrame, to: self), animated: false)
        programmaticScroll = false
    }
}

final class TerminalCanvas: SwiftTerm.TerminalView {
    weak var surface: TerminalSurfaceHost?
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard let surface else { super.pressesBegan(presses, with: event); return }
        surface.coordinator.performUserScroll { super.pressesBegan(presses, with: event) }
    }
    nonisolated override func send(source: SwiftTerm.Terminal, data: ArraySlice<UInt8>) {
        let bytes = Array(data)
        Task { @MainActor [weak self] in
            guard let self, self.surface?.coordinator.parent.mode == .control else { return }
            self.terminalDelegate?.send(source: self, data: bytes[...])
        }
    }
}
#endif

/// Resizes the engine without TerminalView.resize's DECSTR soft reset (SwiftTerm 1.18).
@MainActor enum TerminalRenderer {
    static func resize(_ view: SwiftTerm.TerminalView, cols: Int, rows: Int) {
        let engine = view.getTerminal()
        guard engine.cols != cols || engine.rows != rows else { return }
        engine.resize(cols: cols, rows: rows)
        view.frame.size = view.getOptimalFrameSize().size
        view.terminalDelegate?.sizeChanged(source: view, newCols: cols, newRows: rows)
    }
}
#if os(macOS)
final class TerminalDocumentCanvas: NSView {
    override var isFlipped: Bool { true }
}
#endif
