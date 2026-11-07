import SwiftUI
import SwiftTerm

struct TerminalGridLayout: Equatable {
    let fontSize: CGFloat
    let width: CGFloat
    let height: CGFloat
    static func grid(platform: TerminalPlatform, mode: TerminalStreamMode, cols: Int, rows: Int,
                     viewport: CGSize, cellWidth: CGFloat, cellHeight: CGFloat) -> (cols: Int, rows: Int) {
        if platform.usesCoreGrid(mode: mode) { return (max(1, cols), max(1, rows)) }
        return control(viewport: viewport, cellWidth: cellWidth, cellHeight: cellHeight)
    }
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
    var onPendingInput: (Data) -> Void
    var onSize: (Int, Int) -> Void
    @State private var following = true
    var body: some View {
        TerminalRepresentable(client: client, mode: mode, cols: cols, rows: rows, following: $following,
                              onPendingInput: onPendingInput, onSize: onSize)
            .overlay(alignment: .bottomTrailing) {
                if !following && (mode == .observe || TerminalPlatform.current == .mac) {
                    Button("새 출력이 있습니다 · 맨 아래로", systemImage: "arrow.down.to.line") { following = true }
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
    private var reportedSize: [Int] = []
    init(_ parent: TerminalRepresentable) { self.parent = parent }
    func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
        guard parent.mode == .control, TerminalPlatform.current.controlSizePolicy == .fit else { return }
        reportSize(cols: newCols, rows: newRows)
        parent.client.resize(cols: newCols, rows: newRows)
    }
    func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
        guard host?.feeding != true else { return } // VT device reports never claim human control.
        guard parent.mode == .control else { return }
        if case .live(mode: .control, cols: _, rows: _) = parent.client.state { parent.client.send(Data(data)) }
        else if TerminalPlatform.current.buffersStartingInput { parent.onPendingInput(Data(data)) }
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
        guard let host, parent.mode == .observe || TerminalPlatform.current == .mac, host.scrollLocation.isAbove(before),
              TerminalPresentation.pausesFollowing(userScroll: true, programmatic: host.programmaticScroll || host.feeding,
                                                  layingOut: host.layingOut) else { return }
        stopFollowing()
    }
    func stopFollowing() {
        parent.following = false
    }
    func displayGrid(viewport: CGSize) -> (cols: Int, rows: Int) {
        guard let host else { return (parent.cols, parent.rows) }
        #if os(iOS)
        let terminal = host.terminal
        let dimensions = terminal.getTerminal().getDims()
        let ideal = terminal.getOptimalFrameSize().size
        #endif
        // A resize event can precede SwiftUI's representable update and its next
        // binary paint. Read the live grid here so that paint uses the new grid.
        let core: (cols: Int, rows: Int)
        if parent.mode == .control, case .live(mode: .control, cols: _, rows: _) = parent.client.state {
            core = parent.client.grid
        } else { core = (parent.cols, parent.rows) }
        #if os(macOS)
        let cell = host.cellSize
        return TerminalGridLayout.grid(platform: .mac, mode: parent.mode, cols: core.cols, rows: core.rows,
            viewport: CGSize(width: max(0, viewport.width - host.terminalGutter), height: viewport.height),
            cellWidth: cell.width, cellHeight: cell.height)
        #else
        return TerminalGridLayout.grid(platform: .iPhone, mode: parent.mode, cols: core.cols, rows: core.rows,
            viewport: viewport, cellWidth: ideal.width / CGFloat(max(1, dimensions.cols)),
            cellHeight: ideal.height / CGFloat(max(1, dimensions.rows)))
        #endif
    }
    func naturalGrid(viewport: CGSize, ideal: CGSize, cols: Int, rows: Int) -> (cols: Int, rows: Int) {
        let grid = TerminalGridLayout.control(viewport: viewport, cellWidth: ideal.width / CGFloat(max(1, cols)), cellHeight: ideal.height / CGFloat(max(1, rows)))
        reportSize(cols: grid.cols, rows: grid.rows)
        return grid
    }
    private func reportSize(cols: Int, rows: Int) {
        guard reportedSize != [cols, rows] else { return }
        reportedSize = [cols, rows]
        Task { [weak self] in self?.parent.onSize(cols, rows) }
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

/// Preserve an absolute buffer row even when a full history recycles its oldest lines.
struct TerminalHistoryAnchor {
    private let buffer: SwiftTerm.Buffer
    private let topRow: Int
    private let trimmed: Int
    init(engine: SwiftTerm.Terminal) {
        buffer = engine.buffer
        topRow = engine.getTopVisibleRow()
        trimmed = engine.buffer.totalLinesTrimmed
    }
    func row(in engine: SwiftTerm.Terminal) -> Int? {
        guard engine.buffer === buffer, engine.buffer.totalLinesTrimmed >= trimmed else { return nil }
        return max(0, topRow - (engine.buffer.totalLinesTrimmed - trimmed))
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
    let onPendingInput: (Data) -> Void
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
    private var pausedAnchor: TerminalHistoryAnchor?
    private var followTask: Task<Void, Never>?
    private let canvas = TerminalDocumentCanvas()
    private var fixedGrid: [Int] = []
    init(frame: CGRect, coordinator: TerminalSurfaceCoordinator) {
        self.coordinator = coordinator
        var options = TerminalOptions.default
        options.cols = coordinator.parent.cols; options.rows = coordinator.parent.rows
        options.scrollback = 5000
        terminal = TerminalCanvas(frame: CGRect(x: 0, y: 0, width: 800, height: 500), font: Self.font(13), options: options)
        super.init(frame: frame)
        drawsBackground = true; backgroundColor = NSColor(red: 11/255, green: 9/255, blue: 24/255, alpha: 1)
        hasVerticalScroller = true; hasHorizontalScroller = true; autohidesScrollers = true
        terminal.nativeBackgroundColor = backgroundColor
        terminal.nativeForegroundColor = NSColor(CE.ink); terminal.caretColor = NSColor(CE.accent)
        terminal.terminalDelegate = coordinator; terminal.surface = self
        canvas.wantsLayer = true
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
        NSFont(name: "SFMono-Regular", size: size) ?? NSFont(name: "Menlo-Regular", size: size)
            ?? .monospacedSystemFont(ofSize: size, weight: .regular)
    }
    var terminalGutter: CGFloat {
        guard let scroller = terminal.subviews.compactMap({ $0 as? NSScroller }).first, !scroller.isHidden else { return 0 }
        return NSScroller.scrollerWidth(for: .regular, scrollerStyle: scroller.scrollerStyle)
    }
    var cellSize: CGSize {
        let dims = terminal.getTerminal().getDims(), ideal = terminal.getOptimalFrameSize().size
        return CGSize(width: (ideal.width - terminalGutter) / CGFloat(max(1, dims.cols)),
                      height: ideal.height / CGFloat(max(1, dims.rows)))
    }
    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        updateBackingScale()
    }
    private func updateBackingScale() {
        guard let scale = window?.backingScaleFactor else { return }
        Self.applyBackingScale(to: canvas, scale: scale)
    }
    static func applyBackingScale(to view: NSView, scale: CGFloat) {
        view.layer?.contentsScale = scale
        view.needsDisplay = true
        view.subviews.forEach { applyBackingScale(to: $0, scale: scale) }
    }
    func teardown() {
        followTask?.cancel(); followTask = nil
        if let inputMonitor { NSEvent.removeMonitor(inputMonitor); self.inputMonitor = nil }
        liveScrollObservers.forEach(NotificationCenter.default.removeObserver)
        liveScrollObservers.removeAll()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let inputMonitor { NSEvent.removeMonitor(inputMonitor); self.inputMonitor = nil }
        if window != nil {
            updateBackingScale()
            window?.makeFirstResponder(terminal)
            inputMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .keyDown]) { [weak self] event in
                guard let self, event.window === self.window else { return event }
                if event.type == .keyDown {
                    guard self.coordinator.parent.mode == .observe, self.window?.firstResponder === self.terminal,
                          let key = event.charactersIgnoringModifiers?.unicodeScalars.first,
                          [NSPageUpFunctionKey, NSPageDownFunctionKey].contains(Int(key.value)) else { return event }
                    self.handleObservedKey(event)
                } else {
                    guard self.bounds.contains(self.convert(event.locationInWindow, from: nil)) else { return event }
                    self.handleUserWheel(event)
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
        let cell = cellSize
        _ = coordinator.naturalGrid(viewport: CGSize(width: max(0, contentSize.width - terminalGutter), height: contentSize.height),
            ideal: cell, cols: 1, rows: 1)
        let grid = coordinator.displayGrid(viewport: contentSize)
        let key = [contentSize.width, contentSize.height, CGFloat(grid.cols), CGFloat(grid.rows), parent.mode == .control ? 1 : 0]
        guard key != layoutKey else { return }; layoutKey = key
        if fixedGrid != [grid.cols, grid.rows] {
            TerminalRenderer.resize(terminal, cols: grid.cols, rows: grid.rows)
            terminal.setFrameSize(terminal.getOptimalFrameSize().size)
            TerminalRenderer.resize(terminal, cols: grid.cols, rows: grid.rows)
            fixedGrid = [grid.cols, grid.rows]
        }
        let ideal = terminal.getOptimalFrameSize().size
        if parent.mode == .control {
            // Actual 13pt cells, with identical frame/bounds: no scale transform.
            canvas.setFrameSize(ideal); canvas.setBoundsSize(ideal)
        } else {
            let fit = TerminalGridLayout.observe(cols: grid.cols, rows: grid.rows, viewportWidth: contentSize.width,
                baseFont: 13, minimumFont: 8, cellWidth: ideal.width / CGFloat(grid.cols), cellHeight: ideal.height / CGFloat(grid.rows))
            canvas.setFrameSize(CGSize(width: fit.width, height: fit.height)); canvas.setBoundsSize(ideal)
        }
        updateBackingScale()
    }

    func handleObservedKey(_ event: NSEvent) {
        // SwiftTerm's keyDown/doCommand methods are public, but not open.
        coordinator.performUserScroll { terminal.keyDown(with: event) }
    }
    func handleUserWheel(_ event: NSEvent) {
        if coordinator.parent.mode == .control, terminal.bounds.contains(terminal.convert(event.locationInWindow, from: nil)) {
            // Preserve SwiftTerm mouse reporting and scrollback handling in control.
            coordinator.performUserScroll { terminal.scrollWheel(with: event) }
        } else { scrollWheel(with: event) }
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
        let client = coordinator.parent.client
        if coordinator.parent.mode == .control, case .live(mode: .control, cols: _, rows: _) = client.state,
           fixedGrid != [client.grid.cols, client.grid.rows] { needsLayout = true }
        layoutSubtreeIfNeeded()
        guard contentSize.width > 0, !layoutKey.isEmpty else { pendingBytes.append(data); return }
        if !coordinator.parent.following, pausedAnchor == nil {
            pausedAnchor = TerminalHistoryAnchor(engine: terminal.getTerminal())
        }
        feeding = true
        terminal.feed(byteArray: Array(data)[...])
        restorePausedHistory()
        feeding = false
        scheduleFollow()
    }
    private func restorePausedHistory() {
        guard !terminal.getTerminal().synchronizedOutputActive else { return }
        if !coordinator.parent.following, let anchor = pausedAnchor,
           let row = anchor.row(in: terminal.getTerminal()) {
            terminal.scrollTo(row: row)
        }
        // If the anchor was discarded or the buffer reset, the paused overlay
        // explains the new output and offers an explicit return to the bottom.
        pausedAnchor = nil
    }
    private func scheduleFollow() {
        guard followTask == nil else { return }
        followTask = Task { [weak self] in
            // Coalesce feeds, and wait for synchronized output's end or timeout.
            repeat {
                try? await Task.sleep(for: .milliseconds(20))
                guard !Task.isCancelled, let self else { return }
                if self.terminal.getTerminal().synchronizedOutputActive { continue }
                self.feeding = true
                self.restorePausedHistory()
                self.feeding = false
                self.followTask = nil
                if self.coordinator.parent.following { self.followCursor() }
                return
            } while true
        }
    }
    func followCursor() {
        guard !feeding, !terminal.getTerminal().synchronizedOutputActive else { return }
        pausedAnchor = nil
        programmaticScroll = true
        defer { programmaticScroll = false }
        terminal.scroll(toPosition: 1)
        // feed() updates the parser before SwiftTerm's display timer moves the
        // caret view. scroll(toPosition:) also skips that update at the bottom.
        // Use the current parser row so an immediate follow reaches the cursor.
        let engine = terminal.getTerminal()
        let cellHeight = terminal.getOptimalFrameSize().height / CGFloat(max(1, engine.rows))
        var caret = terminal.caretFrame
        caret.origin.y = terminal.bounds.height - CGFloat(engine.getCursorLocation().y + 1) * cellHeight
        caret.size.height = cellHeight
        terminal.scrollToVisible(caret.insetBy(dx: 0, dy: -6))
    }
}
#else
struct TerminalRepresentable: UIViewRepresentable {
    let client: TerminalStreamClient
    let mode: TerminalStreamMode
    let cols: Int
    let rows: Int
    @Binding var following: Bool
    let onPendingInput: (Data) -> Void
    let onSize: (Int, Int) -> Void
    func makeCoordinator() -> TerminalSurfaceCoordinator { TerminalSurfaceCoordinator(self) }
    func makeUIView(context: Context) -> TerminalSurfaceHost {
        let host = TerminalSurfaceHost(frame: .zero, coordinator: context.coordinator)
        context.coordinator.host = host
        client.attachOutput(owner: context.coordinator.outputID) { [weak host] in host?.feed($0) }
        return host
    }
    func updateUIView(_ host: TerminalSurfaceHost, context: Context) {
        context.coordinator.parent = self; host.updateInputMode(); host.setNeedsLayout()
        if following { host.followCursor() }
    }
    static func dismantleUIView(_ host: TerminalSurfaceHost, coordinator: TerminalSurfaceCoordinator) {
        host.teardown()
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
    private var pausedAnchor: TerminalHistoryAnchor?
    private var followTask: Task<Void, Never>?
    private let canvas = UIView()
    private var dragLocation: TerminalScrollLocation?
    private var fixedGrid: [Int] = []
    private var inputAccessory: UIView?
    init(frame: CGRect, coordinator: TerminalSurfaceCoordinator) {
        self.coordinator = coordinator
        var options = TerminalOptions.default
        options.cols = coordinator.parent.cols; options.rows = coordinator.parent.rows
        options.scrollback = 5000
        terminal = TerminalCanvas(frame: CGRect(x: 0, y: 0, width: 600, height: 400), font: Self.font(10), options: options)
        super.init(frame: frame)
        backgroundColor = UIColor(red: 11/255, green: 9/255, blue: 24/255, alpha: 1)
        terminal.nativeBackgroundColor = backgroundColor!
        terminal.nativeForegroundColor = UIColor(CE.ink); terminal.caretColor = UIColor(CE.accent)
        terminal.terminalDelegate = coordinator; terminal.surface = self
        inputAccessory = terminal.inputAccessoryView
        updateInputMode()
        canvas.addSubview(terminal); addSubview(canvas); delegate = self
        keyboardDismissMode = .interactive
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    static func font(_ size: CGFloat) -> UIFont {
        .monospacedSystemFont(ofSize: size, weight: .regular)
    }
    func teardown() { followTask?.cancel(); followTask = nil }
    func updateInputMode() {
        terminal.keyboardEnabled = TerminalPlatform.iPhone.acceptsKeyboard(mode: coordinator.parent.mode)
        terminal.inputAccessoryView = terminal.keyboardEnabled ? inputAccessory : nil
        if terminal.keyboardEnabled {
            if window != nil, !terminal.isFirstResponder { _ = terminal.becomeFirstResponder() }
        } else { _ = terminal.resignFirstResponder() }
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateInputMode()
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
            let grid = coordinator.displayGrid(viewport: bounds.size)
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
        if !coordinator.parent.following, pausedAnchor == nil {
            pausedAnchor = TerminalHistoryAnchor(engine: terminal.getTerminal())
        }
        feeding = true
        terminal.feed(byteArray: Array(data)[...])
        restorePausedHistory()
        feeding = false
        scheduleFollow()
    }
    private func restorePausedHistory() {
        guard !terminal.getTerminal().synchronizedOutputActive else { return }
        if !coordinator.parent.following, let anchor = pausedAnchor,
           let row = anchor.row(in: terminal.getTerminal()) {
            terminal.scrollTo(row: row)
        }
        // If the anchor was discarded or the buffer reset, the paused overlay
        // explains the new output and offers an explicit return to the bottom.
        pausedAnchor = nil
    }
    private func scheduleFollow() {
        guard followTask == nil else { return }
        followTask = Task { [weak self] in
            // Coalesce feeds, and wait for synchronized output's end or timeout.
            repeat {
                try? await Task.sleep(for: .milliseconds(20))
                guard !Task.isCancelled, let self else { return }
                if self.terminal.getTerminal().synchronizedOutputActive { continue }
                self.feeding = true
                self.restorePausedHistory()
                self.feeding = false
                self.followTask = nil
                if self.coordinator.parent.following { self.followCursor() }
                return
            } while true
        }
    }
    func followCursor() {
        guard coordinator.parent.mode == .observe, !feeding,
              !terminal.getTerminal().synchronizedOutputActive else { return }
        pausedAnchor = nil
        programmaticScroll = true
        terminal.scroll(toPosition: 1)
        scrollRectToVisible(terminal.convert(terminal.caretFrame, to: self), animated: false)
        programmaticScroll = false
    }
}

final class TerminalCanvas: SwiftTerm.TerminalView {
    weak var surface: TerminalSurfaceHost?
    var keyboardEnabled = false
    override var canBecomeFirstResponder: Bool { keyboardEnabled && super.canBecomeFirstResponder }
    override func becomeFirstResponder() -> Bool { keyboardEnabled && super.becomeFirstResponder() }
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard keyboardEnabled, let surface else { return }
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
