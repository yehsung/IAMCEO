import SwiftUI
#if os(macOS)
import AppKit
#endif

struct TerminalSheetLayout {
    static func size(visibleFrame: CGSize) -> CGSize {
        CGSize(width: min(1120, max(720, visibleFrame.width - 160)),
               height: min(760, max(460, visibleFrame.height - 120)))
    }
}

struct TerminalView: View {
    @Environment(AppStore.self) private var store
    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    @Environment(\.terminalWindow) private var terminalWindow
    #endif
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let member: Member
    let session: TerminalSession
    @State private var following = true
    @State private var wakeNotice: String?

    private var client: TerminalStreamClient { session.client }
    private var current: Member { store.members.first { $0.id == member.id } ?? member }
    private var controlling: Bool { session.controlling }
    private var unsupported: Bool { client.state == .unsupported }
    private var missingTerminal: Bool { TerminalAvailability.needsWake(current) || session.missingTerminal }
    private var waking: Bool { store.terminalWake.members.contains(member.id) }

    // Resolve the presenting window’s screen; width is an ideal, never a fixed frame.
    #if os(macOS)
    private var sheetSize: CGSize {
        TerminalSheetLayout.size(visibleFrame: (NSApp.keyWindow?.screen ?? NSApp.mainWindow?.screen ?? NSScreen.main)?.visibleFrame.size ?? CGSize(width: 1280, height: 880))
    }
    private var sheetWidth: CGFloat { sheetSize.width }
    #else
    private let sheetWidth: CGFloat = 1040
    #endif

    var body: some View {
        #if os(macOS)
        if !terminalWindow {
            Color.clear.frame(width: 1, height: 1).onAppear {
                openWindow(id: "terminal", value: member.id)
                dismiss()
            }
        } else { content }
        #else
        content
        #endif
    }

    private var content: some View {
        Group {
            if unsupported && !missingTerminal { TerminalMirrorView(member: member) }
            else { liveSheet }
        }
        .task(id: member.id) { if TerminalAvailability.needsWake(current) { await wake() } }
        // Mac 창은 앞에 있지 않아도 보인다(복원된 창, 옆에 띄운 창). 뒤로 간 장면만 비활성으로 연다.
        .onAppear { session.appear(store: store, member: member, active: TerminalPlatform.current == .mac ? scenePhase != .background : scenePhase == .active) }
        .onChange(of: "\(current.status)|\(current.paneId ?? "")") { _, _ in session.memberChanged(store: store, member: current) }
        .onChange(of: client.state) { _, _ in session.streamChanged(store: store, member: current) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { session.setActive(false, store: store, member: member, immediately: true) }
            else if TerminalPlatform.current == .mac && phase == .inactive { session.setActive(false, store: store, member: member) }
            else if phase == .active { session.setActive(true, store: store, member: member) }
        }
        .onDisappear { session.disappear(store: store, member: member) }
        #if os(macOS)
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.willSleepNotification)) { _ in
            session.setActive(false, store: store, member: member, immediately: true)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
            session.setActive(false, store: store, member: member)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if scenePhase == .active { session.setActive(true, store: store, member: member) }
        }
        // 잠금 화면 없이 깨어나면 앱이 계속 활성이라 다른 신호가 오지 않는다. 깨어난 것 자체로 다시 연다.
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)) { _ in
            if scenePhase != .background { session.setActive(true, store: store, member: member) }
        }
        .background {
            Button("닫기") { dismiss() }.keyboardShortcut("w", modifiers: .command)
                .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
        }
        .background { TerminalWindowKeyReader { session.windowKeyChanged($0, store: store, member: member) } }
        #endif
    }

    private var liveSheet: some View {
        CESheet(String(localized: "\(current.name) 터미널"), icon: "terminal", width: sheetWidth, scrolls: false, flexibleWidth: true, escapeCloses: false,
                onClose: { dismiss() }) {
            VStack(alignment: .leading, spacing: 10) {
                TimelineView(.periodic(from: .now, by: 1)) { context in statusRow(now: context.date) }
                terminal
                    .opacity(missingTerminal ? 0 : 1)
                    .allowsHitTesting(!missingTerminal)
                    .accessibilityHidden(missingTerminal)
                    .overlay { if missingTerminal { sleepingTerminal } }
                    .background(Color(red: 11/255, green: 9/255, blue: 24/255))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(CE.line) }
                if let notice = session.notice {
                    // web .tm-note: 13.5 at line-height 1.5.
                    Text(friendlyError(TerminalPresentation.message(notice))).font(CEFont.note).foregroundStyle(CE.attention)
                        .lineSpacing(CELeading.spacing(13.5, 1.5)).lineLimit(3)
                        .accessibilityLabel(friendlyError(TerminalPresentation.message(notice)))
                }
            }
        } footer: {
            HStack {
                // What the CEO's choice does to the member, in plain words: looking never pauses the work.
                Text(controlling ? "직접 입력하는 동안 보낸 지시는 잠시 기다립니다. 끝내면 이어서 들어갑니다."
                                 : "보는 중에도 팀원은 계속 일하고, 보낸 지시도 그대로 들어갑니다.")
                    .font(CEFont.note).foregroundStyle(CE.ink2)
                    .lineSpacing(CELeading.spacing(13.5, 1.45))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if controlling || session.starting {
                    Button("입력 끝내기") { Task { await session.finishInput(store: store, member: member, resume: true) } }
                        .ceSecondaryButton().disabled(session.ending)
                } else if !missingTerminal {
                    Button("입력 시작") { session.userBeginInput(store: store, member: member) }
                        .ceProminentButton()
                        .disabled(store.isDemo || !store.canWrite || session.ending || !TerminalSession.canControl(member, in: store))
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: min(640, sheetWidth - 80), idealWidth: sheetWidth, maxWidth: .infinity,
               minHeight: min(400, sheetSize.height - 60), idealHeight: sheetSize.height, maxHeight: .infinity)
        #endif
    }

    private func statusRow(now: Date) -> some View {
        HStack(spacing: 7) {
            StatusDot(tone: (controlling || TerminalPresentation.holdsLease(store.terminalLeases[member.id], now: now)) ? .attention : .neutral)
            Text(statusText(now: now)).font(CEFont.meta).foregroundStyle((controlling || TerminalPresentation.holdsLease(store.terminalLeases[member.id], now: now)) ? CE.attention : CE.ink2)
            Spacer(minLength: 8)
            if !following && !missingTerminal {
                Button("새 출력이 있습니다 · 맨 아래로", systemImage: "arrow.down.to.line") { following = true }
                    .ceSecondaryButton().controlSize(.small).accessibilityLabel("터미널 맨 아래로")
            }
            if !missingTerminal, !session.starting, case .closed = client.state {
                Button("다시 연결") { session.userReconnect(store: store, member: member) }
                    .ceSecondaryButton().controlSize(.small).disabled(session.ending)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(statusText(now: now))
    }
    private func statusText(now: Date) -> String {
        if missingTerminal { return waking ? String(localized: "깨우는 중…") : String(localized: "터미널 준비 필요") }
        if session.ending { return String(localized: "입력 끝내는 중…") }
        if session.starting { return String(localized: "입력 준비 중…") }
        if controlling { return TerminalPresentation.controlStatus(expiresAt: store.terminalLeases[member.id]?.expiresAt, now: now) }
        if let status = session.inputEndedStatus { return status }
        switch client.state {
        case .connecting: return String(localized: "보기 연결 중…")
        case let .closed(_, message): return friendlyError(TerminalPresentation.message(message ?? String(localized: "연결이 끊겼습니다")))
        default: return TerminalPlatform.current.observeHint
        }
    }

    private var sleepingTerminal: some View {
        VStack(spacing: 16) {
            if waking {
                ProgressView("깨우는 중…")
                Text("터미널이 준비되면 이어서 연결합니다").font(CEFont.note).foregroundStyle(CE.ink2)
            } else {
                Text(wakeNotice ?? String(localized: "터미널을 준비하고 있습니다")).font(CEFont.note).foregroundStyle(CE.ink2)
                    .multilineTextAlignment(.center)
                Button("다시 시도") { Task { await wake() } }
                    .ceProminentButton().disabled(!store.canWrite || session.ending)
            }
        }
        .padding(.horizontal, 24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func wake() async {
        guard TerminalAvailability.needsWake(current), store.canOpenTerminal(current) else { return }
        wakeNotice = nil
        let namespace = store.writeNamespace
        let outcome = await store.terminalWake.wake(memberID: member.id, resume: {
            await store.memberAction(current, action: "resume") ? nil : (store.errorMessage ?? String(localized: "팀원을 깨우지 못했습니다"))
        }, current: {
            store.members.first { $0.id == member.id }
        }, allowed: {
            store.writeNamespace == namespace && store.canWrite && !store.isArchive
        })
        guard !Task.isCancelled else { return }
        if outcome == .ready { session.memberChanged(store: store, member: current) }
        else if let message = outcome.message { wakeNotice = friendlyError(message) }
    }

    private var terminal: some View {
        LiveTerminalSurface(client: client, mode: session.surfaceMode, cols: client.grid.cols, rows: client.grid.rows,
                            onPendingInput: { session.pendingInput($0) },
                            onSize: { session.sizeChanged(cols: $0, rows: $1) }, following: $following,
                            onRequestInput: { session.requestInput($0, store: store, member: member) })
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The state starts empty so parent body evaluation never constructs a throwaway client.
struct TerminalSessionContent: View {
    let member: Member
    var makeSession: () -> TerminalSession = { TerminalSession() }
    @State private var session: TerminalSession?
    var body: some View {
        Group {
            if let session { TerminalView(member: member, session: session) }
            // An empty Group may never appear, so it cannot bootstrap its own session.
            else { Color.clear }
        }
        .onAppear { if session == nil { session = makeSession() } }
    }
}

#if os(macOS)
private struct TerminalWindowKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var terminalWindow: Bool {
        get { self[TerminalWindowKey.self] }
        set { self[TerminalWindowKey.self] = newValue }
    }
}

struct TerminalWindowContent: View {
    @Environment(AppStore.self) private var store
    let memberID: String?
    @State private var retained: Member?
    var body: some View {
        Group {
            if let retained, store.members.first(where: { $0.id == memberID }) == nil, store.state?.project.id == retained.projectId {
                // 같은 프로젝트를 보고 있는데 명부에 없다: 직원이 빠진 것이다. 옛 서버용 화면으로 바꿔 실패하는 조회를 되풀이하지 않는다.
                EmptyTile(icon: "terminal", title: String(localized: "팀원이 명부에서 빠졌습니다"), detail: String(localized: "이 터미널은 닫혔습니다. 팀에서 팀원을 다시 선택해 주세요."))
            } else if let member = store.members.first(where: { $0.id == memberID }) ?? retained {
                TerminalSessionContent(member: member).environment(\.terminalWindow, true)
            } else {
                EmptyTile(icon: "terminal", title: String(localized: "팀원을 찾을 수 없습니다"), detail: String(localized: "팀에서 팀원을 다시 선택해 주세요."))
            }
        }
        .onAppear { retained = store.members.first { $0.id == memberID } }
        // 실행 때 복원된 창은 명부보다 먼저 뜬다. 명부가 오면 그때 기억한다.
        .onChange(of: store.members.contains { $0.id == memberID }) { _, present in
            if present, retained == nil { retained = store.members.first { $0.id == memberID } }
        }
        .frame(minWidth: 640, minHeight: 400)
        .preferredColorScheme(.dark).tint(CE.accent)
    }
}

/// 이 뷰가 들어 있는 창이 key인지 알린다. NSApp.keyWindow는 다른 창일 수 있어 쓰지 않는다.
private struct TerminalWindowKeyReader: NSViewRepresentable {
    let changed: (Bool) -> Void
    func makeNSView(context: Context) -> TerminalWindowKeyView {
        let view = TerminalWindowKeyView()
        view.changed = changed
        return view
    }
    func updateNSView(_ view: TerminalWindowKeyView, context: Context) { view.changed = changed }
}

private final class TerminalWindowKeyView: NSView {
    var changed: ((Bool) -> Void)?
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        NotificationCenter.default.removeObserver(self)
        guard let window else { return }
        for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification] {
            // Selector observers are automatically removed when this view is deallocated.
            NotificationCenter.default.addObserver(self, selector: #selector(keyChanged), name: name, object: window)
        }
    }
    @objc private func keyChanged(_ notification: Notification) {
        let isKey = notification.name == NSWindow.didBecomeKeyNotification
        // 알림은 SwiftUI 갱신 중에 올 수 있다. 다음 차례에 알린다.
        Task { @MainActor [weak self] in self?.changed?(isKey) }
    }
}
#endif
