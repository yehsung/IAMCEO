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
        Group {
            if unsupported && !missingTerminal { TerminalMirrorView(member: member) }
            else { liveSheet }
        }
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
                    Text(TerminalPresentation.message(notice)).font(CEFont.note).foregroundStyle(CE.attention)
                        .lineSpacing(CELeading.spacing(13.5, 1.5)).lineLimit(3)
                        .accessibilityLabel(TerminalPresentation.message(notice))
                }
            }
        } footer: {
            #if os(macOS)
            HStack {
                Text("닫으면 자동 전달이 다시 시작됩니다").font(CEFont.note).foregroundStyle(CE.ink2).lineLimit(1)
                Spacer(minLength: 8)
                Button("닫기") { dismiss() }.ceSecondaryButton().accessibilityLabel("터미널 닫기")
            }
            .frame(maxWidth: .infinity, alignment: .leading).layoutPriority(1)
            #else
            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack {
                    if missingTerminal {
                        Text("깨우면 같은 창에서 다시 연결합니다").font(CEFont.note).foregroundStyle(CE.ink2)
                            .lineSpacing(CELeading.note)
                    } else if controlling || TerminalPresentation.holdsLease(store.terminalLeases[member.id], now: context.date) {
                        Button("입력 끝내기") { Task { await session.finishInput(store: store, member: member, resume: true) } }
                            .ceSecondaryButton().disabled(session.ending).accessibilityLabel("터미널 입력 끝내기")
                    } else {
                        Text(TerminalPlatform.current.observeHint).font(CEFont.note).foregroundStyle(CE.ink2)
                            .lineSpacing(CELeading.note)
                        Spacer(minLength: 8)
                        Button(session.starting ? "입력 준비 중" : "입력 시작") { session.beginInput(store: store, member: member) }
                            .ceProminentButton().disabled(store.isDemo || !store.canWrite || session.starting || session.ending)
                            .accessibilityLabel("터미널 입력 시작")
                    }
                }
            }
            #endif
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
            #if os(macOS)
            if session.readOnly && !missingTerminal {
                // A status-row action: web gbtn--s (32pt), not the footer size.
                Button("다시 시도") { session.beginInput(store: store, member: member) }
                    .ceSecondaryButton().controlSize(.small)
                    .disabled(store.isDemo || !store.canWrite || session.starting || session.ending)
                    .accessibilityLabel("터미널 직접 입력 다시 시도")
            }
            #else
            if !missingTerminal, case .closed = client.state {
                reconnectButton
            } else if !missingTerminal && client.state == .connecting { reconnectButton }
            #endif
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(statusText(now: now))
    }
    #if os(iOS)
    private var reconnectButton: some View {
        Button("다시 연결") { session.observe(store: store, member: member) }.ceSecondaryButton().controlSize(.small)
            .disabled(!TerminalPresentation.canReconnect(starting: session.starting, ending: session.ending, controlling: controlling))
            .accessibilityLabel("터미널 다시 연결")
    }
    #endif

    private func statusText(now: Date) -> String {
        if missingTerminal { return waking ? "깨우는 중…" : "터미널 없음" }
        #if os(macOS)
        if session.starting { return "연결 중" }
        if session.readOnly { return client.state == .connecting ? "읽기 전용 · 연결 중" : "읽기 전용" }
        if controlling { return TerminalPresentation.controlStatus(expiresAt: store.terminalLeases[member.id]?.expiresAt, now: now) }
        return "연결 중"
        #else
        if TerminalPresentation.holdsLease(store.terminalLeases[member.id], now: now) && !controlling {
            return session.starting ? "직접 입력 연결 중 · 자동 전달이 멈춰 있습니다" : "조작권 유지 중 · 이 직원의 자동 전달이 멈춰 있습니다"
        }
        switch client.state {
        case .connecting: return session.starting ? "직접 입력 연결 중" : "연결 중"
        case .live(mode: .observe, cols: _, rows: _): return "보는 중"
        case .live(mode: .control, cols: _, rows: _):
            if let expiry = store.terminalLeases[member.id]?.expiresAt {
                let seconds = max(0, Int(ceil(expiry / 1000 - now.timeIntervalSince1970)))
                if seconds < 60 { return "\(seconds)초 뒤 조작권이 끝납니다" }
            }
            return "직접 입력 중 · 이 직원의 자동 전달이 멈춰 있습니다"
        case let .closed(_, message): return TerminalPresentation.message(message ?? "연결이 끊겼습니다")
        case .unsupported: return "이 서버는 기존 터미널 화면을 사용합니다"
        }
        #endif
    }
    private var sleepingTerminal: some View {
        VStack(spacing: 16) {
            // web .tm-note: 13.5 ink-2 at line-height 1.5, centred.
            Text("이 직원은 잠들어 있어 터미널이 없습니다").font(CEFont.note).foregroundStyle(CE.ink2)
                .lineSpacing(CELeading.spacing(13.5, 1.5)).multilineTextAlignment(.center)
            Button(waking ? "깨우는 중…" : "깨우기") {
                Task {
                    wakeNotice = nil
                    if await store.wakeTerminal(current) {
                        session.memberChanged(store: store, member: current)
                    } else { wakeNotice = store.errorMessage }
                }
            }
            .ceProminentButton()
            .disabled(!TerminalAvailability.needsWake(current) || !store.canWrite || waking || session.ending || store.pendingActions.contains("member:\(member.id)"))
            if let wakeNotice {
                Text(wakeNotice).font(CEFont.note).foregroundStyle(CE.danger)
                    .lineSpacing(CELeading.note).multilineTextAlignment(.center).frame(maxWidth: 440)
            }
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var terminal: some View {
        LiveTerminalSurface(client: client, mode: session.surfaceMode, cols: client.grid.cols, rows: client.grid.rows,
                            onPendingInput: { session.pendingInput($0) },
                            onSize: { session.sizeChanged(cols: $0, rows: $1) })
            .id(client.outputGeneration)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
