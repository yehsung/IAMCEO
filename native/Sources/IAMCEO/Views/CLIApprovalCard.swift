import SwiftUI

/// The CLI approval window as the web's ApprovalPanel draws it (approval.css): a "승인 창" kicker with 다시 읽기, the
/// window's title, its text in a deep monospaced well, the question, numbered options tagged 승인 / 거절 (and
/// "이후에도 적용" for choices that change the session's permissions), then the inbox confirm bar. Backed by the CLI
/// approval API; the screen text is shown as read, never translated.
struct CLIApprovalCard: View {
    @Environment(AppStore.self) private var store
    let member: Member
    /// What to say when the window cannot be answered here (the inbox: "answer it in the terminal"). nil draws nothing.
    var fallback: String? = nil
    @State private var prompt: CLIApprovalPrompt?
    @State private var picked: Int?
    @State private var busy = false
    @State private var error: String?
    @State private var readError: String?
    @State private var sent = false
    @State private var sentLine: String?
    /// False until the first read answers: "읽는 중" instead of an empty panel or a re-read button.
    @State private var loaded = false
    @State private var reading = false
    @State private var readSeq = 0
    @State private var refreshes = CLIApprovalRefresh()
    @State private var bodyHeight: CGFloat = 0

    var body: some View {
        Group {
            if member.canReadCLIApproval {
                VStack(alignment: .leading, spacing: 10) {
                    if !loaded {
                        statusLine("승인 창을 읽는 중입니다", color: CE.ink2)
                    } else if let prompt, !sent {
                        head
                        window(prompt)
                        VStack(spacing: 8) {
                            ForEach(prompt.options) { option in
                                CLIOptionTile(option: option, picked: picked == option.n) {
                                    picked = picked == option.n ? nil : option.n
                                    error = nil
                                }
                                .disabled(busy || !store.canWrite)
                            }
                        }
                        if let option = prompt.options.first(where: { $0.n == picked }) {
                            ConfirmBar(quoted: nil, verb: option.reject ? "거절 확인" : "확인", hint: confirmHint(option), busy: busy,
                                       disabled: !store.canWrite, stretch: !isMac, shiftedAt: .distantPast,
                                       onConfirm: { Task { await answer(prompt, option: option.n) } }, onCancel: { picked = nil })
                        }
                    } else if sent {
                        head
                        sentStatus
                    } else if let fallback {
                        // Web .apv--fallback: how to answer it in the terminal, 다시 읽기 at the end of the panel.
                        statusLine(fallback, color: CE.ink2)
                        HStack {
                            Spacer(minLength: 0)
                            rereadButton("다시 읽기")
                        }
                    } else {
                        rereadButton("승인 창 다시 읽기")
                    }
                    if let error { statusLine(error, color: CE.danger) }
                    if let readError { statusLine(readError, color: CE.danger) }
                }
                .animation(.easeOut(duration: 0.18), value: picked)
                // 관측 시각(observedAt)은 서버가 1초마다 고쳐 써서 스냅샷마다 다르다. 이것을 task id에 넣으면 읽기가
                // 스냅샷마다 취소·재시작되어, 서버 응답이 느릴 때 '읽는 중'에서 영영 못 벗어난다.
                .task(id: CLIApprovalCard.readIdentity(namespace: store.writeNamespace, member: member)) { await read() }
                .onChange(of: member.statusObservation?.observedAt) { _, _ in refresh() }
            } else if let fallback {
                statusLine(fallback, color: CE.ink2)
            }
        }
        .modifier(ApprovalKeyboardShortcuts(
            enabled: store.uiCanWrite && !busy && !reading && !sent,
            onNumber: { number in
                guard let option = prompt?.options.first(where: { $0.n == number }) else { return false }
                picked = option.n; error = nil
                return true
            },
            onReturn: {
                if let prompt, let picked { Task { await answer(prompt, option: picked) } }
            },
            onCancel: { picked = nil }))
    }

    // MARK: Pieces

    /// Web .apv-head: the kicker (12.5 / 650 in the approval colour) and a small ghost 다시 읽기.
    private var head: some View {
        HStack(spacing: 8) {
            Text("승인 창").font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.approval)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            rereadButton("다시 읽기")
                .padding(.vertical, -6)
        }
    }

    private func rereadButton(_ title: String) -> some View {
        Button(reading ? "읽는 중" : title) { Task { await read() } }
            .ceGhostButton().ceCompactControl()
            .disabled(reading || busy || !store.canWrite)
            .accessibilityLabel(reading ? "승인 창 읽는 중" : "승인 창 다시 읽기")
    }

    /// Title 15.5 / 650 at 1.4, the window text in a deep monospaced well (12.5 at 1.5, up to 280 tall, scrolling),
    /// and the question 14.5 / 600 at 1.45.
    @ViewBuilder private func window(_ prompt: CLIApprovalPrompt) -> some View {
        if !prompt.title.isEmpty {
            Text(prompt.title)
                .font(isMac ? .system(size: 15.5, weight: .semibold) : CEFont.rowTitle)
                .tracking(-0.16)
                .lineSpacing(CELeading.spacing(15.5, 1.4))
                .foregroundStyle(CE.ink)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        if !prompt.body.isEmpty {
            let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
            ScrollView(.vertical) {
                Text(prompt.body)
                    .font(CEFont.mono)
                    .lineSpacing(CELeading.spacing(12.5, 1.5))
                    .foregroundStyle(CE.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 10).padding(.horizontal, 12)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { bodyHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(max(bodyHeight, 20), 280))
            .background(CE.bgDeep.opacity(0.72), in: shape)
            .overlay { shape.strokeBorder(CE.line) }
        }
        if !prompt.question.isEmpty {
            Text(prompt.question)
                .font(isMac ? .system(size: 14.5, weight: .semibold) : CEFont.rowTitle)
                .lineSpacing(CELeading.spacing(14.5, 1.45))
                .foregroundStyle(CE.ink)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    /// Web .apv-sent: what was pressed, in the ok colour; the session state is still being confirmed.
    private var sentStatus: some View {
        let pressed = Text(sentLine ?? "선택을 보냈습니다").foregroundStyle(CE.success)
        let checking = Text(" · 세션 상태를 확인하고 있습니다").foregroundStyle(CE.ink2)
        return Text("\(pressed)\(checking)")
            .font(CEFont.note)
            .lineSpacing(CELeading.note)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Notes, waits and errors: 13.5 at 1.45 (web .apv-wait / .apv-error / .ibx-blocked__hint).
    private func statusLine(_ text: String, color: Color) -> some View {
        Text(text).font(CEFont.note).foregroundStyle(color).lineSpacing(CELeading.note)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func confirmHint(_ option: CLIApprovalOption) -> String {
        if option.reject { return "칸에서 이 거절을 누릅니다." }
        return option.persists ? "칸에서 이 선택지를 누릅니다. 이번 한 번이 아니라 이후에도 적용됩니다." : "칸에서 이 선택지를 누릅니다."
    }

    // MARK: Reading and answering

    /// 처음 읽기와 다시 읽기의 단위: 연결·직원이 같으면 진행 중인 읽기를 취소하지 않는다.
    static func readIdentity(namespace: String, member: Member) -> String { "\(namespace)|\(member.id)" }

    /// 새 관측이 올 때마다 창을 조용히 다시 읽는다(창이 바뀌었을 수 있다). 진행 중인 읽기는 끝까지 두고,
    /// 그 사이 온 요청은 끝난 뒤 한 번으로 합친다. 버튼의 '읽는 중' 표시와 숫자 단축키는 건드리지 않는다.
    @MainActor private func refresh() {
        guard loaded, refreshes.request() else { return }
        let identity = CLIApprovalCard.readIdentity(namespace: store.writeNamespace, member: member)
        Task { @MainActor in
            repeat { await read(quiet: true) }
            while refreshes.finished() && identity == CLIApprovalCard.readIdentity(namespace: store.writeNamespace, member: member)
            refreshes = CLIApprovalRefresh()
        }
    }

    @MainActor private func read(quiet: Bool = false) async {
        let namespace = store.writeNamespace
        var token = 0
        if !quiet { readSeq += 1; token = readSeq; reading = true }
        defer { if !quiet, token == readSeq { reading = false } }
        do {
            let next = try await store.readCLIApproval(member)
            guard !Task.isCancelled, namespace == store.writeNamespace else { return }
            if next?.fingerprint != prompt?.fingerprint {
                picked = nil
                if next != nil { sent = false; sentLine = nil }
            }
            prompt = next
            readError = nil
            loaded = true
        } catch {
            guard !Task.isCancelled, namespace == store.writeNamespace else { return }
            prompt = nil; picked = nil
            readError = friendlyLoadError(error, what: "승인 창", verb: "읽지")
            loaded = true
        }
    }

    @MainActor private func answer(_ prompt: CLIApprovalPrompt, option: Int) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        if await store.answerCLIApproval(member, prompt: prompt, option: option) {
            sentLine = prompt.options.first(where: { $0.n == option }).map { "눌렀습니다: \($0.n). \($0.label)" }
            sent = true; self.prompt = nil; picked = nil
        } else {
            error = store.errorMessage.map(friendlyError) ?? "선택 결과를 확인하지 못했습니다. 창을 다시 확인하세요."
            picked = nil
            await read()
        }
    }
}

/// 승인 창 자동 다시 읽기의 합치기: 한 번에 하나만 읽고, 읽는 동안 온 요청은 끝난 뒤 한 번만 더 읽는다.
struct CLIApprovalRefresh: Equatable {
    private(set) var running = false
    private(set) var queued = false
    /// true면 지금 읽기를 시작한다. false면 진행 중인 읽기 뒤로 미뤘다.
    mutating func request() -> Bool {
        if running { queued = true; return false }
        running = true
        return true
    }
    /// 읽기 하나가 끝났다. true면 미뤄 둔 요청이 있어 한 번 더 읽는다.
    mutating func finished() -> Bool {
        if queued { queued = false; return true }
        running = false
        return false
    }
}

private extension CLIApprovalOption {
    /// Changes the session's permission settings instead of answering once (web ApprovalPanel PERSISTS).
    var persists: Bool {
        !reject && label.range(of: "don'?t ask again|do not ask again|always allow|allow all|during this session|for this session|auto-accept|accept edits|bypass|switch to .*mode",
                               options: [.regularExpression, .caseInsensitive]) != nil
    }
    /// A plain "Yes…" choice (web: the 승인 badge).
    var approves: Bool {
        !reject && label.trimmingCharacters(in: .whitespaces).range(of: "^yes\\b", options: [.regularExpression, .caseInsensitive]) != nil
    }
}

/// Web .apv-opt: the option number in a mono gutter, the label 14.5 / 600 at 1.45, tags under it. Picked is the violet
/// drop with a focus ring; a picked rejection is red (danger .2 with a 2pt danger ring).
private struct CLIOptionTile: View {
    let option: CLIApprovalOption
    let picked: Bool
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("\(option.n).")
                    .font(.system(size: 13, design: .monospaced)).monospacedDigit()
                    .foregroundStyle(CE.ink3)
                    .frame(minWidth: 19, alignment: .leading)
                VStack(alignment: .leading, spacing: 5) {
                    Text(option.label)
                        .font(isMac ? .system(size: 14.5, weight: .semibold) : CEFont.rowTitle)
                        .lineSpacing(CELeading.spacing(14.5, 1.45))
                        .foregroundStyle(isEnabled || picked ? CE.ink : CE.ink2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if option.reject || option.approves || option.persists {
                        HStack(spacing: 8) {
                            if option.reject { Tag("거절", tone: .danger) } else if option.approves { Tag("승인", tone: .success) }
                            if option.persists { Text("이후에도 적용").font(CEFont.meta).foregroundStyle(CE.ink3) }
                        }
                    }
                }
                Spacer(minLength: 0)
                if picked {
                    Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .topLeading)
            .background(fill, in: shape)
            .overlay { shape.strokeBorder(stroke.color, lineWidth: stroke.width) }
            .contentShape(shape)
            .animation(.easeOut(duration: 0.12), value: picked)
        }
        .buttonStyle(OptionPressStyle())
        .onHover { hovering = $0 }
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(picked ? .isSelected : [])
        .accessibilityHint("고른 뒤 아래 확인 버튼을 눌러야 칸에서 누릅니다")
    }

    private var accessibilityText: String {
        var parts = ["\(option.n). \(option.label)"]
        if option.reject { parts.append("거절") } else if option.approves { parts.append("승인") }
        if option.persists { parts.append("이후에도 적용") }
        return parts.joined(separator: ", ")
    }

    private var fill: Color {
        if picked { return option.reject ? CE.danger.opacity(0.2) : CE.violet.opacity(0.5) }
        return Color.white.opacity(hovering && isEnabled ? 0.11 : 0.06)
    }

    private var stroke: (color: Color, width: CGFloat) {
        if picked { return (option.reject ? CE.danger : CE.accent, 2) }
        return (Color.white.opacity(0.14), 1)
    }
}
