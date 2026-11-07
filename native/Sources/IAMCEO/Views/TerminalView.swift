import SwiftUI
#if os(macOS)
import AppKit
#endif

struct TerminalView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let member: Member
    @State private var client = TerminalStreamClient()
    @State private var startBuffer = TerminalStartBuffer()
    @State private var starting = false
    @State private var visible = false
    @State private var requestID = UUID()
    @State private var notice: String?
    @State private var naturalCols = 100
    @State private var naturalRows = 30
    @State private var ending = false

    private var current: Member { store.members.first { $0.id == member.id } ?? member }
    private var controlling: Bool {
        if case .live(mode: .control, cols: _, rows: _) = client.state { return true }
        return false
    }
    private var unsupported: Bool { client.state == .unsupported }

    /// A Mac sheet opens at its minimum size, and CESheet draws at a fixed width: both must be the same number or the
    /// content is centred in a narrower window and clipped on both sides. Wide enough for the core grid at a
    /// readable size, never wider than the screen.
    #if os(macOS)
    private var sheetWidth: CGFloat { min(1040, max(720, (NSScreen.main?.visibleFrame.width ?? 1280) - 160)) }
    private var sheetHeight: CGFloat { min(720, max(460, (NSScreen.main?.visibleFrame.height ?? 900) - 140)) }
    #else
    private let sheetWidth: CGFloat = 1040
    #endif

    var body: some View {
        Group {
            if unsupported { TerminalMirrorView(member: member) }
            else { liveSheet }
        }
        .onAppear {
            visible = true
            client.onReady = { mode in
                if mode == .control {
                    if let expiry = client.expiresAt { store.updateTerminalStreamLease(memberID: member.id, expiresAt: expiry) }
                    starting = false
                    if TerminalPlatform.current.startsOnTyping {
                        if let bytes = startBuffer.take(), !bytes.isEmpty { client.send(bytes) }
                        else if startBuffer.discarded { notice = "입력 준비가 길어져 친 키를 버렸습니다. 다시 입력해 주세요." }
                    }
                }
            }
            client.onLease = { expiry in store.updateTerminalStreamLease(memberID: member.id, expiresAt: expiry) }
            client.onControlEnded = {
                starting = false; startBuffer.clear()
                if case let .closed(reason, message) = client.state {
                    if reason == "lease_ended" { store.terminalStreamLeaseEnded(memberID: member.id) }
                    notice = message ?? (reason == "lease_ended" ? "조작권이 끝났습니다." : "직접 입력 연결이 끝났습니다. 보는 중으로 돌아갑니다.")
                }
                observe()
            }
            if scenePhase == .active, !unsupported { observe() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                if unsupported { Task { _ = await store.releaseTerminal(member) } }
                else { Task { await finishInput(resume: false) } }
            }
            else if phase == .active, !unsupported, !starting, !controlling { observe() }
        }
        .onDisappear {
            let usingMirror = unsupported
            visible = false; requestID = UUID(); client.dispose()
            // A pending claim checks visible/requestID before opening any control socket.
            if !usingMirror { Task { _ = await store.releaseTerminal(member) } }
        }
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
                if let notice {
                    Text(notice).font(CEFont.meta).foregroundStyle(CE.attention).lineLimit(3)
                        .accessibilityLabel(notice)
                }
            }
        } footer: {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack {
                    if controlling || TerminalPresentation.holdsLease(store.terminalLeases[member.id], now: context.date) {
                        Button("입력 끝내기") { Task { await finishInput(resume: true) } }
                            .ceSecondaryButton().disabled(ending).accessibilityLabel("터미널 입력 끝내기")
                    } else {
                        Text(TerminalPlatform.current.observeHint).font(CEFont.meta).foregroundStyle(CE.ink3)
                        Spacer(minLength: 8)
                        Button(starting ? "입력 준비 중" : "입력 시작") { beginInput() }
                            .ceProminentButton().disabled(store.isDemo || !store.canWrite || starting || ending)
                            .accessibilityLabel("터미널 입력 시작")
                    }
                }
            }
        }
        #if os(macOS)
        .background { Button("닫기") { dismiss() }.keyboardShortcut("w", modifiers: .command).frame(width: 0, height: 0).opacity(0).accessibilityHidden(true) }
        .frame(minWidth: sheetWidth, idealWidth: sheetWidth, maxWidth: sheetWidth, minHeight: sheetHeight, idealHeight: sheetHeight)
        #endif
    }

    private func statusRow(now: Date) -> some View {
        HStack(spacing: 7) {
            StatusDot(tone: (controlling || TerminalPresentation.holdsLease(store.terminalLeases[member.id], now: now)) ? .attention : .neutral)
            Text(statusText(now: now)).font(CEFont.meta).foregroundStyle((controlling || TerminalPresentation.holdsLease(store.terminalLeases[member.id], now: now)) ? CE.attention : CE.ink2)
            Spacer(minLength: 8)
            if case .closed = client.state {
                Button("다시 연결") { observe() }.ceSecondaryButton().disabled(!TerminalPresentation.canReconnect(starting: starting, ending: ending, controlling: controlling)).accessibilityLabel("터미널 다시 연결")
            } else if client.state == .connecting {
                Button("다시 연결") { observe() }.ceSecondaryButton().disabled(!TerminalPresentation.canReconnect(starting: starting, ending: ending, controlling: controlling)).accessibilityLabel("터미널 다시 연결")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(statusText(now: now))
    }
    private func statusText(now: Date) -> String {
        if TerminalPresentation.holdsLease(store.terminalLeases[member.id], now: now) && !controlling {
            return starting ? "직접 입력 연결 중 · 자동 전달이 멈춰 있습니다" : "조작권 유지 중 · 이 직원의 자동 전달이 멈춰 있습니다"
        }
        switch client.state {
        case .connecting: return starting ? "직접 입력 연결 중" : "연결 중"
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
    }
    private var terminal: some View {
        LiveTerminalSurface(client: client, mode: controlling ? .control : .observe, cols: client.grid.cols, rows: client.grid.rows,
                            onTypeWhileObserving: { bytes in
                                if TerminalPlatform.current.startsOnTyping { beginInput(bytes) }
                            },
                            onSize: { cols, rows in naturalCols = cols; naturalRows = rows })
            .id(client.outputGeneration)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func observe() {
        guard visible, scenePhase == .active, !starting, !ending else { return }
        if store.isDemo { client.showDemo(); return }
        guard let api = store.api else { return }
        client.connect(api: api, memberID: member.id, mode: .observe)
    }
    private func beginInput(_ bytes: Data = Data()) {
        guard bytes.isEmpty || TerminalPlatform.current.startsOnTyping else { return }
        guard !store.isDemo, !ending, visible, store.canWrite else { return }
        if controlling { client.send(bytes); return }
        if starting {
            if TerminalPlatform.current.startsOnTyping, !startBuffer.append(bytes) { notice = "입력 준비 중에는 4KB·3초까지만 보관합니다. 다시 입력해 주세요." }
            return
        }
        starting = true; notice = nil
        if TerminalPlatform.current.startsOnTyping {
            startBuffer.begin(); _ = startBuffer.append(bytes)
        }
        let token = UUID(); requestID = token
        Task {
            let claimed = await store.claimTerminal(member)
            guard requestID == token, visible, scenePhase == .active else {
                if claimed { _ = await store.releaseTerminal(member) }
                return
            }
            guard claimed, let lease = store.terminalLeases[member.id]?.leaseId, let api = store.api else {
                starting = false; startBuffer.clear()
                notice = store.errorMessage ?? "조작권을 받지 못했습니다. 다른 기기나 세션 상태를 확인해 주세요."
                return
            }
            client.connect(api: api, memberID: member.id, mode: .control, cols: naturalCols, rows: naturalRows, leaseID: lease,
                           sizePolicy: TerminalPlatform.current.controlSizePolicy)
        }
    }
    private func finishInput(resume: Bool) async {
        guard !ending else { return }
        ending = true; requestID = UUID(); client.close(); starting = false; startBuffer.clear()
        if store.terminalLeases[member.id]?.leaseId != nil {
            if !(await store.releaseTerminal(member)) { notice = store.errorMessage ?? "조작권을 놓지 못했습니다. 다시 끝내 주세요." }
        }
        ending = false
        if resume || scenePhase == .active { observe() }
    }
}
