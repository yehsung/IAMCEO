import SwiftUI

/// The screen and key events come from the daemon's leased CLI session (`/terminal/control`).
/// While this device holds the lease, the daemon pauses automatic delivery to the member.
/// Look: the web .tm-screen well (near-black, hairline rim) on the aurora, with a compact status row and glass controls.
struct TerminalMirrorView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    let member: Member
    @State private var screen = ""
    @State private var input = ""
    @State private var inputRevision = 0
    @State private var inputSaveError: String?
    @State private var awaitingResult = false
    @State private var loading = false
    @State private var error: String?
    @State private var lastRead: Date?
    @State private var tick = Date()
    @State private var follow = true
    @FocusState private var inputFocused: Bool

    init(member: Member) { self.member = member }

    private static let bottomID = "terminal-bottom"

    /// Latest copy for display; lease calls only use the id.
    private var current: Member { store.members.first { $0.id == member.id } ?? member }
    private var controlling: Bool {
        guard let lease = store.terminalLeases[member.id], lease.leaseId != nil else { return false }
        return lease.expiresAt.map { $0 > Date().timeIntervalSince1970 * 1000 } ?? true
    }
    private var leaseExpired: Bool { store.terminalLeases[member.id]?.leaseId != nil && !controlling }
    private var pending: Bool { store.pendingActions.contains("terminal:\(member.id)") }
    private var inputScope: String { "\(store.writeNamespace)|\(member.projectId)|\(member.id)" }
    private var storedInput: TerminalInputSnapshot? {
        store.submissions?.terminalInput(namespace: store.writeNamespace, memberID: member.id)
    }
    private var receipts: [OperationReceipt] {
        store.operationResults.values.filter { $0.memberId == member.id && $0.kind == .terminalControl }
            .sorted { ($0.updatedAt ?? $0.createdAt ?? "", $0.operationId) > ($1.updatedAt ?? $1.createdAt ?? "", $1.operationId) }
    }
    private var unresolved: Bool {
        awaitingResult || receipts.contains { $0.status == .pending || $0.status == .unknown }
    }
    private var claimCanBeRecovered: Bool {
        let waiting = receipts.filter { $0.status == .pending || $0.status == .unknown }
        return !awaitingResult && !waiting.isEmpty && waiting.allSatisfy {
            store.submissions?.terminalAttempt(id: $0.operationId)?.action == .claim
        }
    }
    /// iOS with the keyboard up: drop static text and shrink the screen so the input, keys and release button stay visible.
    private var keyboardUp: Bool {
        #if os(iOS)
        inputFocused
        #else
        false
        #endif
    }

    /// Why direct control cannot start right now (nil = it can).
    private var controlBlock: String? {
        if store.isDemo { return "샘플에는 실제 터미널이 없습니다. 실제 Mac에 연결하면 조작할 수 있습니다." }
        if !store.canWrite { return "서버에 연결되지 않아 조작할 수 없습니다." }
        if current.origin == "manual" { return "직접 띄운 세션입니다. 그 세션을 띄운 터미널에서 조작하세요." }
        if let backend = current.backend, backend != "core" { return "이전 실행기의 세션은 여기서 조작할 수 없습니다. 기존 터미널에서 확인하세요." }
        if ["asleep", "offline"].contains(current.status) { return "열린 세션이 없습니다. 팀 화면에서 깨운 뒤 조작하세요." }
        return nil
    }

    var body: some View {
        chrome
            // Restarts on every phase change: a long-running task only sees the scenePhase it started with.
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                await store.recoverWrites()
                while !Task.isCancelled {
                    tick = Date()
                    await readScreen()
                    do { try await Task.sleep(for: .seconds(2)) } catch { break }
                }
            }
            .onAppear { restoreInput() }
            .onChange(of: inputScope) { _, _ in restoreInput(); awaitingResult = false; screen = ""; lastRead = nil }
            .onChange(of: receipts.map { "\($0.operationId):\($0.status.rawValue)" }) { _, _ in
                if !receipts.isEmpty, receipts.allSatisfy({ $0.status == .applied || $0.status == .refused }) { awaitingResult = false }
            }
            .onChange(of: storedInput?.revision) { _, _ in
                // Receipt consumption only clears the submitted revision. Later edits were persisted on each keystroke.
                if inputSaveError == nil { restoreInput() }
            }
            .onDisappear { if controlling { Task { _ = await store.releaseTerminal(member) } } }
    }

    // MARK: Frame

    @ViewBuilder private var chrome: some View {
        #if os(macOS)
        // Sheet without a window toolbar: a one-line title bar (no wrapped text outside the scroll areas).
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "terminal").font(.system(size: 13, weight: .semibold)).foregroundStyle(CE.ink2)
                Text("\(current.name) 터미널").font(CEFont.pageTitle).foregroundStyle(CE.ink).lineLimit(1)
                TeamMemberStatusBadge(member: current)
                Spacer(minLength: 8)
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).frame(width: 28, height: 28)
                        .background(Color.white.opacity(0.07), in: Circle())
                        .overlay { Circle().strokeBorder(CE.line) }
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(CE.ink2)
                .help(controlling ? "닫기 · 조작을 끝내고 자동 전달을 다시 켭니다" : "닫기")
                .accessibilityLabel("터미널 닫기")
            }
            .padding(.horizontal, 18).padding(.vertical, 12)
            .overlay(alignment: .bottom) { Rectangle().fill(CE.line).frame(height: 1) }
            main
        }
        .background { AmbientBackground() }
        .ceSheetSize(width: 860, height: 760)
        #else
        NavigationStack {
            main
                .background { AmbientBackground() }
                .navigationTitle("\(current.name) 터미널")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("닫기") { dismiss() } }
                }
        }
        #endif
    }

    private var main: some View {
        VStack(alignment: .leading, spacing: keyboardUp ? 8 : 10) {
            statusRow
            if !keyboardUp { guidance }
            terminal
            controls
            footer
        }
        .padding(isMac ? 18 : 14)
    }

    // MARK: Sections

    private var statusRow: some View {
        HStack(spacing: 8) {
            controlTag
            #if os(iOS)
            TeamMemberStatusBadge(member: current)
            #endif
            Spacer(minLength: 8)
            readMeta
            headerButtons
        }
    }

    @ViewBuilder private var controlTag: some View {
        if controlling {
            Tag("직접 조작 중 · 자동 전달 멈춤", tone: .approval, icon: "hand.raised.fill")
        } else {
            Tag("읽기 전용", tone: .neutral, icon: "eye")
                .help("CLI 화면을 그대로 보여 줍니다. 승인 창이나 선택 창은 직접 조작으로 처리합니다.")
        }
    }

    @ViewBuilder private var readMeta: some View {
        if let lastRead {
            Text("갱신 \(koTime(lastRead, seconds: true))").font(CEFont.meta).monospacedDigit().foregroundStyle(CE.ink3).lineLimit(1)
                .help("화면은 2초마다 갱신합니다")
        }
    }

    private var headerButtons: some View {
        HStack(spacing: 4) {
            Button { follow.toggle() } label: {
                Image(systemName: follow ? "arrow.down.to.line.compact" : "pause")
                    .font(.system(size: 12, weight: .semibold)).frame(width: 28, height: 28)
                    .background(follow ? CE.accent.opacity(0.16) : Color.white.opacity(0.05), in: Circle())
                    .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? nil : 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(follow ? CE.accent : CE.ink2)
            .help(follow ? "맨 아래 따라가기 켜짐" : "맨 아래 따라가기 꺼짐")
            .accessibilityLabel("맨 아래 따라가기")
            .accessibilityValue(follow ? "켜짐" : "꺼짐")
            Button { Task { await readScreen() } } label: {
                Group {
                    if loading { ProgressView().controlSize(.mini) } else { Image(systemName: "arrow.clockwise") }
                }
                .font(.system(size: 12, weight: .semibold)).frame(width: 28, height: 28)
                .background(Color.white.opacity(0.05), in: Circle())
                .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? nil : 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(CE.ink2)
            .disabled(loading || store.isDemo)
            .help("화면 새로 읽기")
            .accessibilityLabel("터미널 화면 새로 읽기")
        }
    }

    /// Only states that need the CEO get a notice; the plain read-only explanation lives in the tag's tooltip.
    @ViewBuilder private var guidance: some View {
        if controlling {
            EmptyView()
        } else if current.canReadCLIApproval {
            CLIApprovalCard(member: current)
            TermNotice(tone: .approval, icon: "hand.raised.fill", title: "승인·선택 창 앞에서 멈췄습니다",
                       detail: "화면을 확인하고 직접 조작을 시작해 승인하거나 거절하세요. 끝나면 조작을 끝내 자동 전달을 다시 켜세요.")
        } else if current.status == "blocked" {
            let info = MemberStatusInfo(current)
            TermNotice(tone: info.tone, icon: info.icon, title: info.label, detail: info.explanation)
        } else if leaseExpired {
            TermNotice(tone: .attention, icon: "clock.badge.exclamationmark", title: "조작권이 끝났습니다",
                       detail: "5분 동안 입력이 없어 자동 전달이 다시 켜졌을 수 있습니다. 계속하려면 직접 조작을 다시 시작하세요.")
        }
    }

    private var terminal: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        return GeometryReader { proxy in
            ScrollViewReader { reader in
                ScrollView([.horizontal, .vertical]) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(displayText)
                            .font(CEFont.mono)
                            .foregroundStyle(screen.isEmpty ? CE.ink3 : CE.ink)
                            .lineSpacing(3)
                            .textSelection(.enabled)
                            .fixedSize()
                        Color.clear.frame(width: 1, height: 1).id(Self.bottomID)
                    }
                    .padding(14)
                    .frame(minWidth: proxy.size.width, minHeight: proxy.size.height, alignment: .topLeading)
                }
                .onChange(of: screen) { _, _ in
                    if follow { reader.scrollTo(Self.bottomID, anchor: .bottomLeading) }
                }
                .onChange(of: follow) { _, on in
                    if on { reader.scrollTo(Self.bottomID, anchor: .bottomLeading) }
                }
            }
        }
        .frame(minHeight: keyboardUp ? 120 : 220, maxHeight: .infinity)
        .background(CE.bgDeep.opacity(0.82), in: shape)
        .clipShape(shape)
        .overlay { shape.strokeBorder(controlling ? CE.approval.opacity(0.55) : CE.line, lineWidth: controlling ? 1.2 : 1) }
        .shadow(color: controlling ? CE.approval.opacity(0.18) : .clear, radius: 14)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(current.name)의 CLI 화면")
    }

    @ViewBuilder private var controls: some View {
        if controlling {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("\(current.name)의 터미널에 넣을 글", text: Binding(get: { input }, set: editInput), axis: .vertical)
                        .font(CEFont.mono)
                        .lineLimit(1...4)
                        .focused($inputFocused)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .ceField()
                        .accessibilityLabel("터미널 입력")
                    Button { Task { await sendInput() } } label: {
                        Image(systemName: "arrow.up").font(.system(size: 13, weight: .bold)).frame(width: 18, height: 18)
                    }
                    .ceProminentButton()
                    .disabled(input.isEmpty || pending || unresolved || !store.canWrite || inputSaveError != nil)
                    .keyboardShortcut(.return, modifiers: .command)
                    .help("글 넣기 (⌘↩)")
                    .accessibilityLabel("터미널에 글 보내기")
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        key("↑", code: "up", label: "위 방향키")
                        key("↓", code: "down", label: "아래 방향키")
                        key("Enter", code: "enter", label: "엔터")
                        key("Esc", code: "esc", label: "이스케이프")
                        key("Tab", code: "tab", label: "탭")
                        key("⌫", code: "backspace", label: "백스페이스")
                        key("Ctrl+C", code: "ctrl+c", label: "컨트롤 C, 현재 CLI 작업 중단")
                    }
                    .padding(.vertical, 1)
                }
                HStack(spacing: 10) {
                    if let expiresAt = store.terminalLeases[member.id]?.expiresAt {
                        Text(leaseRemaining(expiresAt)).font(CEFont.meta).monospacedDigit().foregroundStyle(CE.ink3).lineLimit(1)
                            .help("조작권은 5분 동안 유지되고 입력할 때마다 늘어납니다")
                    }
                    Spacer(minLength: 0)
                    Button { Task { _ = await store.releaseTerminal(member) } } label: {
                        HStack(spacing: 6) {
                            if pending { ProgressView().controlSize(.mini) } else { Image(systemName: "hand.raised.slash") }
                            Text("조작 끝내기 · 자동 전달 재개")
                        }
                    }
                    .ceSecondaryButton()
                    .disabled(pending)
                }
            }
        } else {
            HStack(spacing: 12) {
                Button { Task { if await store.claimTerminal(member) { await readScreen() } } } label: {
                    HStack(spacing: 6) {
                        if pending { ProgressView().controlSize(.small).tint(.white) } else { Image(systemName: "hand.tap") }
                        Text(pending ? "조작권을 받는 중" : claimCanBeRecovered ? "조작권 다시 확인" : "직접 조작 시작")
                    }
                }
                .ceProminentButton()
                .disabled(!store.canWrite || pending || controlBlock != nil || (unresolved && !claimCanBeRecovered))
                Text(controlBlock ?? "시작하면 \(current.name)에게 가는 자동 전달이 멈춥니다. 끝내면 다시 이어집니다.")
                    .font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(3)
                    .layoutPriority(1)
                Spacer(minLength: 0)
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            if unresolved {
                Label("직접 조작 결과 확인 중 · 입력을 다시 보내지 않습니다. 편집한 글은 보존됩니다.", systemImage: "clock")
                    .font(CEFont.meta).foregroundStyle(CE.attention)
                Button("작업 결과 다시 확인") { Task { await checkResult() } }
                    .ceSecondaryButton().controlSize(.small).disabled(!store.canWrite || pending)
            } else if let receipt = receipts.first {
                Text(receipt.status == .applied ? "직접 조작 적용 확인 · 업무 완료를 뜻하지 않습니다." : TerminalPresentation.message(receipt.error ?? "직접 조작이 거부됐습니다."))
                    .font(CEFont.meta).foregroundStyle(CE.ink3)
            }
            if let inputSaveError {
                Text("입력을 저장하지 못했습니다. 글을 복사해 보관하세요. \(inputSaveError)")
                    .font(CEFont.meta).foregroundStyle(CE.danger).textSelection(.enabled)
                Button("입력 저장 다시 시도") { editInput(input) }.ceSecondaryButton().controlSize(.small)
            }
            if let issue = error ?? store.errorMessage {
                Label(TerminalPresentation.message(issue), systemImage: "exclamationmark.circle").font(CEFont.meta).foregroundStyle(CE.danger)
                    .lineLimit(3).layoutPriority(1)
            }
            if current.origin != "manual" && !keyboardUp {
                let command = "\(store.bootstrap?.cli ?? "iamceo") attach \(current.id)"
                Text("서버 컴퓨터에서 같은 터미널 열기  \(Text(command).font(CEFont.mono).foregroundStyle(CE.ink2))")
                    .font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
                    .help(command)
            }
        }
    }

    private func key(_ title: String, code: String, label: String) -> some View {
        Button { Task { await sendKey(code) } } label: {
            Text(title).font(CEFont.mono.weight(.semibold))
        }
        .buttonStyle(TermKeyStyle())
        .disabled(pending || unresolved || !store.canWrite)
        .accessibilityLabel(label)
    }

    // MARK: Logic

    private func restoreInput() {
        guard let storedInput else { return }
        if !input.utf8.elementsEqual(storedInput.text.utf8) { inputRevision += 1 }
        input = storedInput.text
        inputSaveError = nil
    }

    private func editInput(_ text: String) {
        input = text; inputRevision += 1
        guard !store.isDemo, let submissions = store.submissions else { return }
        do {
            try submissions.setTerminalInput(text, namespace: store.writeNamespace, memberID: member.id)
            inputSaveError = nil
        } catch { inputSaveError = error.localizedDescription }
    }

    private func sendInput() async {
        guard !pending, !unresolved, store.canWrite, inputSaveError == nil, !input.isEmpty else { return }
        let sent = input, revision = inputRevision, scope = inputScope
        let ok = await store.terminalInput(current, text: sent)
        guard scope == inputScope else { return }
        if ok {
            if revision == inputRevision { editInput("") }
            await readScreen()
        } else { markUnconfirmed() }
    }

    private func sendKey(_ code: String) async {
        guard !pending, !unresolved, store.canWrite else { return }
        let scope = inputScope
        let ok = await store.terminalKey(current, key: code)
        guard scope == inputScope else { return }
        if ok { await readScreen() } else { markUnconfirmed() }
    }

    private func markUnconfirmed() {
        // A legacy response has no receipt; keep the input and require observation before another action.
        awaitingResult = receipts.first?.status != .refused
    }

    private func checkResult() async {
        let scope = inputScope
        await store.recoverWrites()
        guard scope == inputScope else { return }
        if !receipts.isEmpty, receipts.allSatisfy({ $0.status == .applied || $0.status == .refused }) { awaitingResult = false }
        await readScreen()
    }

    private var displayText: String {
        if store.isDemo { return "샘플에는 실제 CLI 화면이 없습니다." }
        if !screen.isEmpty { return screen }
        if loading && lastRead == nil { return "화면을 읽는 중입니다" }
        if error != nil { return "화면을 읽지 못했습니다" }
        return lastRead == nil ? "화면을 읽는 중입니다" : "화면이 비어 있습니다"
    }

    private func leaseRemaining(_ expiresAt: Double) -> String {
        let seconds = Int((expiresAt - tick.timeIntervalSince1970 * 1000) / 1000)
        guard seconds > 0 else { return "조작권이 곧 끝납니다" }
        return seconds >= 60 ? "조작권 \(seconds / 60)분 남음" : "조작권 \(seconds)초 남음"
    }

    private func readScreen() async {
        guard !loading else { return }
        guard !store.isDemo else { return }
        guard let api = store.api else { error = "연결된 실행 호스트가 필요합니다."; return }
        let scope = inputScope
        loading = true; defer { loading = false }
        do {
            let result = try await api.screen(memberID: member.id)
            guard scope == inputScope else { return }
            screen = Self.clean(result)
            error = nil
            lastRead = Date()
        } catch {
            guard scope == inputScope else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            self.error = "화면을 읽지 못했습니다: \(error.localizedDescription)"
        }
    }

    /// Strips ANSI control sequences (CSI and OSC) so the raw screen reads as plain text.
    private static func clean(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\u{1B}\\][^\u{07}\u{1B}]*(?:\u{07}|\u{1B}\\\\)", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\u{1B}\\[[0-?]*[ -/]*[@-~]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\r", with: "")
    }
}

/// Tinted notice for states that need the CEO. No vertical fixedSize: this sits outside a scroll view in a Mac sheet,
/// where wrapped fixed-size text would make the sheet's minimum size depend on its width.
private struct TermNotice: View {
    let tone: Tone
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: icon).font(CEFont.rowTitle).foregroundStyle(tone.color).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                Text(detail).font(CEFont.secondary).foregroundStyle(CE.ink2).lineLimit(3)
            }
            Spacer(minLength: 0)
        }
        .padding(CESpace.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.color.opacity(0.1), in: shape)
        .overlay { shape.strokeBorder(tone.color.opacity(0.25)) }
        .layoutPriority(1)
        .accessibilityElement(children: .combine)
    }
}

/// Glass key cap: light fill, hairline rim, pressed state brighter.
private struct TermKeyStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { KeyBody(configuration: configuration) }
    private struct KeyBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false
        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
            configuration.label
                .foregroundStyle(isEnabled ? CE.ink : CE.ink3)
                .padding(.horizontal, 11)
                .frame(minWidth: isMac ? 36 : 44, minHeight: isMac ? 28 : 40)
                .background(Color.white.opacity(configuration.isPressed ? 0.16 : hovering ? 0.10 : 0.07), in: shape)
                .background(.ultraThinMaterial.opacity(isEnabled ? 1 : 0.5), in: shape)
                .overlay { if isEnabled { GlassRim(shape: shape) } else { shape.strokeBorder(CE.line) } }
                .contentShape(shape)
                .onHover { hovering = $0 }
        }
    }
}
