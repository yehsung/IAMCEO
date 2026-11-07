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
    @State private var session = TerminalSession()

    private var client: TerminalStreamClient { session.client }
    private var current: Member { store.members.first { $0.id == member.id } ?? member }
    private var controlling: Bool { session.controlling }
    private var unsupported: Bool { client.state == .unsupported }

    // CESheet has a fixed width. Match its outer minimum and ideal to avoid clipping.
    #if os(macOS)
    private var sheetSize: CGSize {
        TerminalSheetLayout.size(visibleFrame: NSScreen.main?.visibleFrame.size ?? CGSize(width: 1280, height: 880))
    }
    private var sheetWidth: CGFloat { sheetSize.width }
    #else
    private let sheetWidth: CGFloat = 1040
    #endif

    var body: some View {
        Group {
            if unsupported { TerminalMirrorView(member: member) }
            else { liveSheet }
        }
        .onAppear { session.appear(store: store, member: member, active: scenePhase == .active) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { session.setActive(false, store: store, member: member) }
            else if phase == .active { session.setActive(true, store: store, member: member) }
        }
        .onDisappear { session.disappear(store: store, member: member) }
        #if os(macOS)
        .background {
            Button("닫기") { dismiss() }.keyboardShortcut("w", modifiers: .command)
                .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
        }
        #endif
    }

    private var liveSheet: some View {
        CESheet("\(current.name) 터미널", icon: "terminal", width: sheetWidth, scrolls: false, escapeCloses: false,
                onClose: { dismiss() }) {
            VStack(alignment: .leading, spacing: 10) {
                TimelineView(.periodic(from: .now, by: 1)) { context in statusRow(now: context.date) }
                terminal
                    .background(Color(red: 11/255, green: 9/255, blue: 24/255))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(CE.line) }
                if let notice = session.notice {
                    Text(notice).font(CEFont.meta).foregroundStyle(CE.attention).lineLimit(3)
                        .accessibilityLabel(notice)
                }
            }
        } footer: {
            #if os(macOS)
            HStack {
                Text("닫으면 자동 전달이 다시 시작됩니다").font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1)
                Spacer(minLength: 8)
                Button("닫기") { dismiss() }.ceSecondaryButton().accessibilityLabel("터미널 닫기")
            }
            .frame(maxWidth: .infinity, alignment: .leading).layoutPriority(1)
            #else
            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack {
                    if controlling || TerminalPresentation.holdsLease(store.terminalLeases[member.id], now: context.date) {
                        Button("입력 끝내기") { Task { await session.finishInput(store: store, member: member, resume: true) } }
                            .ceSecondaryButton().disabled(session.ending).accessibilityLabel("터미널 입력 끝내기")
                    } else {
                        Text(TerminalPlatform.current.observeHint).font(CEFont.meta).foregroundStyle(CE.ink3)
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
        .frame(minWidth: sheetWidth, idealWidth: sheetWidth, maxWidth: sheetWidth, minHeight: sheetSize.height, idealHeight: sheetSize.height)
        #endif
    }

    private func statusRow(now: Date) -> some View {
        HStack(spacing: 7) {
            StatusDot(tone: (controlling || TerminalPresentation.holdsLease(store.terminalLeases[member.id], now: now)) ? .attention : .neutral)
            Text(statusText(now: now)).font(CEFont.meta).foregroundStyle((controlling || TerminalPresentation.holdsLease(store.terminalLeases[member.id], now: now)) ? CE.attention : CE.ink2)
            Spacer(minLength: 8)
            #if os(macOS)
            if session.readOnly {
                Button("다시 시도") { session.beginInput(store: store, member: member) }
                    .ceSecondaryButton().disabled(store.isDemo || !store.canWrite || session.starting || session.ending)
                    .accessibilityLabel("터미널 직접 입력 다시 시도")
            }
            #else
            if case .closed = client.state {
                reconnectButton
            } else if client.state == .connecting { reconnectButton }
            #endif
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(statusText(now: now))
    }
    #if os(iOS)
    private var reconnectButton: some View {
        Button("다시 연결") { session.observe(store: store, member: member) }.ceSecondaryButton()
            .disabled(!TerminalPresentation.canReconnect(starting: session.starting, ending: session.ending, controlling: controlling))
            .accessibilityLabel("터미널 다시 연결")
    }
    #endif

    private func statusText(now: Date) -> String {
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
        case let .closed(_, message): return message ?? "연결이 끊겼습니다"
        case .unsupported: return "이 서버는 기존 터미널 화면을 사용합니다"
        }
        #endif
    }
    private var terminal: some View {
        LiveTerminalSurface(client: client, mode: session.surfaceMode, cols: client.grid.cols, rows: client.grid.rows,
                            onPendingInput: { session.pendingInput($0) },
                            onSize: { session.sizeChanged(cols: $0, rows: $1) })
            .id(client.outputGeneration)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
