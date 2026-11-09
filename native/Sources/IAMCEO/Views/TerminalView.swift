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
    @State private var session: TerminalSession
    @State private var wakeNotice: String?

    init(member: Member, session: TerminalSession = TerminalSession()) {
        self.member = member
        _session = State(initialValue: session)
    }

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
        .onAppear { session.appear(store: store, member: member, active: scenePhase == .active) }
        .onChange(of: "\(current.status)|\(current.paneId ?? "")") { _, _ in session.memberChanged(store: store, member: current) }
        .onChange(of: client.state) { _, _ in session.streamChanged(store: store, member: current) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background || (TerminalPlatform.current == .mac && phase == .inactive) { session.setActive(false, store: store, member: member) }
            else if phase == .active { session.setActive(true, store: store, member: member) }
        }
        .onDisappear { session.disappear(store: store, member: member) }
        #if os(macOS)
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.willSleepNotification)) { _ in
            session.setActive(false, store: store, member: member)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
            session.setActive(false, store: store, member: member)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            session.setActive(true, store: store, member: member)
        }
        .background {
            Button("닫기") { dismiss() }.keyboardShortcut("w", modifiers: .command)
                .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
        }
        #endif
    }

    private var liveSheet: some View {
        CESheet("\(current.name) 터미널", icon: "terminal", width: sheetWidth, scrolls: false, flexibleWidth: true, escapeCloses: false,
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
                                 : "보는 중에도 직원은 계속 일하고, 보낸 지시도 그대로 들어갑니다.")
                    .font(CEFont.note).foregroundStyle(CE.ink2)
                    .lineSpacing(CELeading.spacing(13.5, 1.45))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if controlling || session.starting {
                    Button("입력 끝내기") { Task { await session.finishInput(store: store, member: member, resume: true) } }
                        .ceSecondaryButton().disabled(session.ending)
                } else if !missingTerminal {
                    Button("입력 시작") { session.beginInput(store: store, member: member) }
                        .ceProminentButton()
                        .disabled(store.isDemo || !store.canWrite || session.ending)
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
            if !missingTerminal, !session.starting, case .closed = client.state {
                Button("다시 연결") { session.observe(store: store, member: member) }
                    .ceSecondaryButton().controlSize(.small).disabled(session.ending)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(statusText(now: now))
    }
    private func statusText(now: Date) -> String {
        if missingTerminal { return waking ? "깨우는 중…" : "터미널 준비 필요" }
        if session.ending { return "입력 끝내는 중…" }
        if session.starting { return "입력 준비 중…" }
        if controlling { return TerminalPresentation.controlStatus(expiresAt: store.terminalLeases[member.id]?.expiresAt, now: now) }
        switch client.state {
        case .connecting: return "보기 연결 중…"
        case let .closed(_, message): return friendlyError(TerminalPresentation.message(message ?? "연결이 끊겼습니다"))
        default: return "보는 중"
        }
    }

    private var sleepingTerminal: some View {
        VStack(spacing: 16) {
            if waking {
                ProgressView("깨우는 중…")
                Text("터미널이 준비되면 이어서 연결합니다").font(CEFont.note).foregroundStyle(CE.ink2)
            } else {
                Text(wakeNotice ?? "터미널을 준비하고 있습니다").font(CEFont.note).foregroundStyle(CE.ink2)
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
            await store.memberAction(current, action: "resume") ? nil : (store.errorMessage ?? "직원을 깨우지 못했습니다")
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
                            onSize: { session.sizeChanged(cols: $0, rows: $1) })
            .id(client.outputGeneration)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            if let member = store.members.first(where: { $0.id == memberID }) ?? retained {
                TerminalView(member: member).environment(\.terminalWindow, true)
            } else {
                EmptyTile(icon: "terminal", title: "직원을 찾을 수 없습니다", detail: "팀에서 직원을 다시 선택해 주세요.")
            }
        }
        .onAppear { retained = store.members.first { $0.id == memberID } }
        .frame(minWidth: 640, minHeight: 400)
        .preferredColorScheme(.dark).tint(CE.accent)
    }
}
#endif
