import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// MARK: - 대화
//
// The project conversation (총괄) plus one thread per 팀장, after the web thread (Thread.tsx / thread.css):
// my words are violet bubbles on the right, team reports are glass cards, server notices are centred pills.
// Delivery stays honest and compact: "시간  전달 대기 / 보냄 / 보류 / 받음 / 실패". "받음" is never "done"; what a label
// means is a tooltip (Mac) or a tap popover, never a standing line of text.
// Mac: AppShell docks the shared ComposerBar under this screen, bound to `router.chatTarget`, so no composer here.
// iOS: the composer is inline at the bottom; the recipient is picked by the column (iPad regular) or chips (iPhone).

struct ChatView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.ceWide) private var wide

    var body: some View {
        if store.state == nil {
            ChatPlaceholder()
        } else if wide {
            // Column width + divider = 231pt: AppShell offsets the docked Mac composer by exactly this much.
            HStack(spacing: 0) {
                ChatRecipientList()
                    .frame(width: 230)
                Rectangle().fill(CE.line).frame(width: 1)
                VStack(spacing: 0) {
                    ChatThreadHeader()
                    ChatThread()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                #if os(iOS)
                .ceBar(.bottom) { ChatInlineComposer() }
                #endif
            }
        } else {
            VStack(spacing: 0) {
                ChatRecipientChips()
                ChatCompactNotes()
                ChatThread()
            }
            #if os(iOS)
            .ceBar(.bottom) { ChatInlineComposer() }
            // The recipient's detail link lives in the nav bar (AppShell leaves the trailing slot empty on Chat).
            .toolbar {
                if !store.isArchive, let member = ChatScope(store: store, router: router).currentMember {
                    ToolbarItem(placement: .topBarTrailing) {
                        let title = member.kind == "worker" ? "\(member.name) 팀원 보기" : "\(chatLeadLabel(member)) 보기"
                        Button { router.openMember(member.id) } label: { Image(systemName: "person.crop.circle") }
                            .help(title)
                            .accessibilityLabel(title)
                    }
                }
            }
            #endif
        }
    }
}

// MARK: - Message rows

/// One thread entry: my bubble, a centred system pill, or a team report card.
struct ChatMessageRow: View {
    let message: Message
    /// This is my latest message to its target and its delivery is failed/held, so it still needs me.
    var isLatestProblem = false
    /// "{대상}에게" on my bubbles. Off inside one member's thread, where every bubble goes to that member.
    var showsTarget = true
    var body: some View {
        if message.mine {
            ChatMineRow(message: message, isLatestProblem: isLatestProblem, showsTarget: showsTarget)
        } else if message.kind == "시스템" {
            ChatSystemRow(message: message)
        } else {
            ChatReportRow(message: message)
        }
    }
}

/// My message: violet bubble on the right (radius 18 18 5 18), then "time  delivery" and at most one action.
struct ChatMineRow: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    let message: Message
    var isLatestProblem = false
    var showsTarget = true
    @State private var explaining = false
    @State private var resending = false
    @State private var resendError: String?

    private var info: DeliveryInfo? { DeliveryInfo(message.delivery) }
    private var note: String? {
        let value = message.deliveryNote?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }
    private var lead: Member? { store.members.first { $0.kind == "conductor" || $0.kind == "root" } }
    /// Who the message waits on: the targeted member, or the lead for a project message.
    private var target: Member? {
        if let id = message.targetMemberId { return store.members.first { $0.id == id } }
        return lead
    }
    private var targetName: String? {
        guard showsTarget, message.targetMemberId != nil || message.targetName != nil else { return nil }
        if let name = message.targetName, !name.isEmpty { return name }
        return message.targetMemberId.flatMap { id in store.members.first { $0.id == id }?.name } ?? "명부에 없는 대상"
    }
    /// Why a resend cannot go out right now (shown as the button's tooltip, not as a line).
    private var lockReason: String? {
        if store.isDemo { return "샘플은 읽기 전용입니다" }
        if store.connectionStatus != .connected { return "서버에 연결되지 않아 지금은 다시 보낼 수 없습니다" }
        if let connection = store.state?.project.connection, !connection.ok {
            return connection.ownerDetail ?? "이 프로젝트의 실행 연결에 문제가 있어 지금은 다시 보낼 수 없습니다"
        }
        if store.pendingActions.contains(where: { $0.hasPrefix("send:") }) { return "보내는 중입니다" }
        return nil
    }

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: isMac ? 96 : 40)
            VStack(alignment: .trailing, spacing: 4) {
                bubble
                footer
                if let resendError {
                    Text(resendError)
                        .font(CEFont.meta).foregroundStyle(CE.danger)
                        .multilineTextAlignment(.trailing)
                        .lineLimit(3)
                        .padding(.trailing, 4)
                }
            }
            .frame(maxWidth: 620, alignment: .trailing)
        }
    }

    private var bubble: some View {
        let shape = ChatBubbleShape.shape
        return VStack(alignment: .leading, spacing: 6) {
            if let targetName {
                Text("\(targetName)에게").font(ChatFont.bubbleTo).foregroundStyle(ChatPalette.bubbleTo).lineLimit(1)
            }
            if !message.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ChatBodyText(text: message.body)
            }
            ForEach(message.attachments) { attachment in
                AttachmentPreview(attachment: attachment)
            }
        }
        .foregroundStyle(Color.white)
        .tint(ChatPalette.bubbleLink)
        .padding(.horizontal, 15).padding(.top, 10).padding(.bottom, 11)
        .background(ChatPalette.bubble, in: shape)
        .overlay { shape.strokeBorder(ChatPalette.bubbleRim, lineWidth: 1) }
    }

    private var footer: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(clockTime(message.at)).monospacedDigit().foregroundStyle(CE.ink3).fixedSize()
            if let info { deliveryLabel(info) }
            if !store.isArchive, message.delivery == "failed" {
                resendButton
            } else if !store.isArchive, message.delivery == "held", isLatestProblem, let target {
                heldAction(target)
            }
        }
        .font(CEFont.meta)
        .padding(.trailing, 4)
    }

    /// "보류 · {note}" like the web; tap (or hover on Mac) tells what the label means.
    private func deliveryLabel(_ info: DeliveryInfo) -> some View {
        Button { explaining = true } label: {
            Text(note.map { "\(info.label) · \($0)" } ?? info.label)
                .foregroundStyle(chatDeliveryColor(message.delivery))
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
                .padding(.vertical, isMac ? 0 : 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(info.explanation)
        .popover(isPresented: $explaining, arrowEdge: .bottom) {
            ChatDeliveryExplanation(info: info, note: note, color: chatDeliveryColor(message.delivery))
        }
        .accessibilityLabel("전달 상태: \(info.label)\(note.map { ", \($0)" } ?? "")")
        .accessibilityHint("뜻 보기")
    }

    private var resendButton: some View {
        let locked = !store.uiCanWrite
        // Another send is in flight (the store de-duplicates per project): wait for it instead of failing.
        let busy = store.pendingActions.contains { $0.hasPrefix("send:") } && !resending
        return Button { Task { await resend() } } label: {
            HStack(spacing: 4) {
                if resending { ProgressView().controlSize(.mini) }
                Text(resending ? "보내는 중" : "다시 보내기").underline(!resending)
            }
            .font(CEFont.meta.weight(.semibold))
            .foregroundStyle(locked || busy ? CE.ink3 : CE.ink)
            .frame(minHeight: isMac ? nil : 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(locked || busy || resending)
        .fixedSize()
        .help(lockReason ?? "같은 글·대상·첨부로 다시 보냅니다.")
    }

    /// A held delivery waits on something only the CEO can clear; point at the place to clear it.
    @ViewBuilder private func heldAction(_ member: Member) -> some View {
        if member.status == "blocked" {
            ChatFooterLink(title: "터미널 열기") { router.openTerminal(member.id) }
                .help("승인 창을 터미널에서 처리하면 보류된 글이 다시 전달됩니다.")
        } else {
            ChatFooterLink(title: member.kind == "worker" ? "팀원 보기" : "\(rankName(member.kind)) 보기") { router.openMember(member.id) }
        }
    }

    private func resend() async {
        resending = true
        resendError = nil
        let ok = await store.resend(message)
        resending = false
        if !ok { resendError = "다시 보내지 못했습니다" + (store.errorMessage.map { ": \($0)" } ?? ".") }
    }
}

/// Server notices ("{name} 오류: …", "{name}에게 전달하지 못했습니다: …") as a quiet centred pill.
struct ChatSystemRow: View {
    let message: Message
    var body: some View {
        let title = message.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let detail = message.body.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = [title, detail == title ? "" : detail].filter { !$0.isEmpty }.joined(separator: " · ")
        Text(line(text))
            .font(CEFont.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 14).padding(.vertical, 6)
            .background(ChatPalette.systemFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
            .textSelection(.enabled)
    }

    private func line(_ text: String) -> AttributedString {
        var main = AttributedString(text)
        main.swiftUI.foregroundColor = CE.ink2
        var time = AttributedString("  " + clockTime(message.at))
        time.swiftUI.foregroundColor = CE.ink3
        time.swiftUI.font = CEFont.meta.monospacedDigit()
        return main + time
    }
}

/// A team report: glass card with kind badge, who, time, title, markdown body, attachments and jump chips.
struct ChatReportRow: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    let message: Message

    /// One-line automatic reports repeat the title as the body; draw it once.
    private var showsBody: Bool {
        func strip(_ value: String) -> String {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return (trimmed.hasPrefix("(자동) ") ? String(trimmed.dropFirst(5)) : trimmed).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let body = strip(message.body)
        return !body.isEmpty && body != strip(message.title)
    }

    var body: some View {
        HStack(spacing: 0) {
            Plate(padding: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        if !message.kind.isEmpty { Tag(message.kind, tone: messageKindTone(message.kind)) }
                        Text(message.who).font(ChatFont.who).foregroundStyle(CE.ink).lineLimit(1)
                        Spacer(minLength: 6)
                        Text(clockTime(message.at)).font(CEFont.meta).foregroundStyle(CE.ink3).monospacedDigit()
                            .help(parseISODate(message.at).map(koDateTime) ?? "")
                    }
                    .accessibilityElement(children: .combine)
                    if !message.title.isEmpty {
                        Text(message.title)
                            .font(ChatFont.cardTitle).foregroundStyle(CE.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    if showsBody {
                        MarkdownText(text: message.body).foregroundStyle(CE.ink)
                    }
                    ForEach(message.attachments) { attachment in
                        AttachmentPreview(attachment: attachment)
                    }
                    jumps
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder private var jumps: some View {
        if message.decisionId != nil || message.fileId != nil {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { decisionJump; fileJump }
                VStack(alignment: .leading, spacing: 8) { decisionJump; fileJump }
            }
            .padding(.top, 2)
        }
    }

    /// Web wording: 결재함에서 답하기 (open, highlighted) · 답함: {선택지 | 메모} · 답한 결재 보기 · 닫힌 결재 보기 ·
    /// 결재함에서 보기 (not loaded here). Whether the answer reached the asker is the tooltip.
    @ViewBuilder private var decisionJump: some View {
        if let id = message.decisionId {
            let decision = store.decisions.first { $0.id == id }
            let link = chatDecisionLink(decision)
            ChatJumpChip(title: store.isArchive ? "결재 기록 보기" : link.title, prominent: !store.isArchive && link.open) { router.openDecision(id) }
                .help(decision.map { DecisionStateInfo($0).label } ?? "결재함에서 찾아 엽니다")
        }
    }

    @ViewBuilder private var fileJump: some View {
        if let id = message.fileId {
            let file = store.files.first { $0.id == id }
            ChatJumpChip(title: file.map { "자료 보기: \($0.title)" } ?? "자료 보기") { router.openFile(id) }
        }
    }
}

struct ChatDaySeparator: View {
    let label: String
    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(CE.line).frame(height: 1)
            Text(label).font(CEFont.micro).foregroundStyle(CE.ink3).fixedSize()
            Rectangle().fill(CE.line).frame(height: 1)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Thread

private struct ChatThread: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(DraftStore.self) private var drafts

    var body: some View {
        let scope = ChatScope(store: store, router: router)
        let key = Data("\(drafts.namespace)|\(drafts.connectionGeneration)|\(scope.threadKey)|\(store.isArchive)".utf8).base64EncodedString()
        ChatConversation(scopeID: key, targetMemberID: router.chatTarget, projectID: store.selectedProjectID,
                         namespace: drafts.namespace).id(key)
    }
}

/// The displayed interval is staged separately so the public scroll adapter captures the position at application time.
private struct ChatConversation: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let scopeID: String
    let targetMemberID: String?
    let projectID: String?
    let namespace: String
    @State private var anchor: ChatScrollAnchor
    @State private var displayed: [Message] = []
    @State private var queued: [Message]?
    @State private var pinned = true
    @State private var started = false
    @State private var restoring: ChatHistoryAnchor?
    @State private var reading: ChatVisibleAnchor?
    @State private var viewportHeight: CGFloat = 0
    @State private var top: CGFloat?
    @State private var intentUsed = false
    @State private var wasInteracting = false
    @State private var dragging = false
    @State private var isVisible = false
    @State private var autoPaused = false
    @State private var lastLoad: ChatHistoryLoad = .initial
    @State private var followID: String?
    @State private var positionError = false
    private static let bottomID = "chat-thread-bottom"

    init(scopeID: String, targetMemberID: String?, projectID: String?, namespace: String) {
        self.scopeID = scopeID
        self.targetMemberID = targetMemberID; self.projectID = projectID; self.namespace = namespace
        _anchor = State(initialValue: ChatScrollAnchor(scope: scopeID))
    }

    private var scope: ChatScope { ChatScope(store: store, router: router) }
    private var history: ChatHistory? {
        guard let history = store.history,
              history.key.projectID == projectID, history.key.namespace == namespace,
              ChatHistoryKey.scopeBytes(history.key.scope) == ChatHistoryKey.scopeBytes(
                ChatHistoryKey.normalizedScope(targetMemberID: targetMemberID, members: store.members)) else { return nil }
        return history
    }
    private var notificationAnchor: String? {
        guard router.chatMessageID == store.notificationMessageID else { return nil }
        return router.chatMessageID
    }
    private var items: [Message] {
        if notificationAnchor != nil { return store.historyMessages }
        if store.isDemo || (!store.isArchive && store.pagingSupport == .unsupported) { return scope.messages }
        return history?.items ?? []
    }
    private var loaded: Bool { store.isDemo || (!store.isArchive && store.pagingSupport == .unsupported)
        || history?.initialized == true || notificationAnchor != nil }
    private var canPage: Bool {
        !store.isDemo && store.connectionStatus == .connected && notificationAnchor == nil
            && history?.hasOlder == true && history?.loading == nil && history?.isBridging == false
            && history?.storeChanged == false && !anchor.isPreservingPosition
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    historyControls
                        .chatScrollRow(id: "history-top", coordinateSpace: scopeID)
                    if displayed.isEmpty && loaded {
                        ChatEmpty(title: "아직 대화가 없습니다", detail: emptyDetail)
                    }
                    ForEach(chatThreadRows(displayed)) { row in
                        switch row {
                        case .day(_, let label): ChatDaySeparator(label: label)
                        case .message(let message):
                            ChatMessageRow(message: message, isLatestProblem: scope.unresolvedIDs.contains(message.id), showsTarget: scope.isProjectThread)
                                .chatScrollRow(id: row.id, coordinateSpace: scopeID)
                                .id(row.id)
                        }
                    }
                    Color.clear.frame(height: 1).id(Self.bottomID)
                        .chatScrollRow(id: "history-bottom", coordinateSpace: scopeID)
                        .accessibilityHidden(true)
                }
                .background { ChatScrollHostProbe(anchor: anchor, scope: scopeID).frame(width: 0, height: 0) }
                .padding(.horizontal, isMac ? CESpace.xl : CESpace.l)
                .padding(.top, 14).padding(.bottom, CESpace.m)
                .frame(maxWidth: 880).frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .chatScrollAnchoring(anchor, scope: scopeID)
            .background(GeometryReader { geometry in
                Color.clear.onAppear { viewportHeight = geometry.size.height }
                    .onChange(of: geometry.size.height) { _, height in viewportHeight = height }
            })
            .onPreferenceChange(ChatMessageFramesKey.self) { frames in
                MainActor.assumeIsolated { observe(frames, proxy: proxy) }
            }
            #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
            .overlay(alignment: .bottom) {
                if !displayed.isEmpty && (!pinned || notificationAnchor != nil) { jumpButton(proxy) }
            }
            .simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { _ in
                if !dragging { dragging = true; wasInteracting = false }
            }.onEnded { _ in dragging = false; wasInteracting = false })
            .onAppear { isVisible = true }
            .task {
                await store.activateHistory(targetMemberID: targetMemberID)
            }
            .onDisappear {
                isVisible = false
                savePosition()
                anchor.cancelPreservation()
                if history != nil { store.deactivateHistory() }
            }
            .onChange(of: ChatThreadContent(items: items), initial: true) { _, content in
                present(content.items, proxy: proxy)
            }
            .onChange(of: loaded) { _, value in
                if value { present(items, proxy: proxy) }
            }
            .onChange(of: anchor.isPreservingPosition) { _, preserving in
                if !preserving, let queued { self.queued = nil; present(queued, proxy: proxy) }
            }
            .onChange(of: anchor.visibleAnchor) { _, visible in
                if positionError, visible != nil, anchor.hostFound, let queued {
                    positionError = false; self.queued = nil; present(queued, proxy: proxy)
                }
            }
            .onChange(of: anchor.isInteracting) { _, interacting in
                if !interacting { wasInteracting = false }
            }
            .onChange(of: history?.error) { _, error in
                if error != nil { autoPaused = true; chatAnnounce("대화를 불러오지 못했습니다. 다시 불러오기를 눌러 주세요.") }
            }
            .onChange(of: history?.loading, initial: true) { _, request in
                if let request { lastLoad = request.kind }
            }
            .onChange(of: router.chatMessageID) { _, _ in
                anchor.cancelPreservation(); queued = nil; restoring = nil; reading = nil
                started = false; present(items, proxy: proxy)
            }
            .onReceive(NotificationCenter.default.publisher(for: ComposerAcceptedMessage.notification)) { note in
                guard let sent = note.object as? ComposerAcceptedMessage,
                      sent.namespace == store.writeNamespace, sent.projectID == store.selectedProjectID,
                      scope.isProjectThread || sent.targetMemberID == router.chatTarget else { return }
                followID = sent.messageID
                store.leaveNotificationAnchor(); router.chatMessageID = nil
                jump(proxy)
            }
        }
    }

    @ViewBuilder private var historyControls: some View {
        VStack(spacing: 6) {
            if store.isArchive { Tag("보관한 대화 · 읽기 전용", tone: .dim) }
            if let notice = router.navigationNotice { Text(notice).foregroundStyle(CE.attention) }
            if notificationAnchor != nil {
                Text("알림의 보고 앞뒤를 보고 있습니다").foregroundStyle(CE.ink2)
                Button("최신 대화로") { returnToLatest() }
                    .ceSecondaryButton()
            } else if store.isDemo {
                Text("샘플 대화 · 읽기 전용").foregroundStyle(CE.ink3)
            } else if store.connectionStatus != .connected {
                Text("연결이 끊겼습니다. 다시 연결하면 이전 글을 불러올 수 있습니다").foregroundStyle(CE.attention)
            } else if history?.storeChanged == true {
                Text("서버의 대화 기록이 변경되었습니다").foregroundStyle(CE.attention)
                Button("최신 대화부터 다시 보기") {
                    anchor.cancelPreservation(); started = false; displayed = []; queued = nil
                    Task { await store.restartHistoryFromLatest() }
                }.ceSecondaryButton()
            } else if history?.isBridging == true {
                Text(history?.error == nil ? "새 대화를 이어 받는 중입니다" : "새 대화를 이어 받지 못했습니다").foregroundStyle(CE.ink2)
                if history?.loading != nil { ProgressView().controlSize(.small) }
                else {
                    Button(history?.error == nil ? "동기화 계속" : "다시 동기화") { Task { await store.continueHistoryBridge() } }
                        .ceSecondaryButton()
                }
            } else if store.pagingSupport == .unsupported && !store.isArchive {
                Text("이 서버는 최근 대화만 보여줍니다").foregroundStyle(CE.ink3)
            } else if !loaded {
                if history?.error != nil {
                    Text("대화를 불러오지 못했습니다").foregroundStyle(CE.attention)
                    Button("다시 불러오기") { Task { await store.refreshHistory() } }.ceSecondaryButton()
                } else { ProgressView("대화를 불러오는 중…").controlSize(.small) }
            } else if history?.loading?.kind == .older {
                ProgressView("이전 글을 불러오는 중…").controlSize(.small)
            } else if history?.error != nil {
                Text(lastLoad == .older ? "이전 글을 불러오지 못했습니다" : "새 대화를 불러오지 못했습니다").foregroundStyle(CE.attention)
                if lastLoad == .older {
                    Button("다시 불러오기") { loadOlder() }.ceSecondaryButton().disabled(!canPage)
                } else {
                    Button("다시 동기화") { Task { await store.refreshHistory() } }.ceSecondaryButton()
                        .disabled(history?.loading != nil)
                }
            } else if history?.hasOlder == true {
                Button("이전 글 불러오기") { loadOlder() }.ceSecondaryButton().disabled(!canPage)
                    .accessibilityHint("이전 글 100개를 불러옵니다")
            } else if !displayed.isEmpty {
                Text("대화의 처음입니다").foregroundStyle(CE.ink3)
            }
            if positionError {
                Text("읽던 위치를 확인하지 못했습니다. 이전 글은 잠시 뒤 다시 불러오세요.").foregroundStyle(CE.attention)
            }
        }
        .font(CEFont.meta).frame(maxWidth: .infinity).padding(.bottom, 2)
        .accessibilityElement(children: .contain)
    }

    private var emptyDetail: String {
        if store.isArchive { return "보관된 기록은 여기서 읽을 수 있습니다." }
        if let member = scope.recipient { return "\(member.name)에게 보낸 지시와 보고가 여기에 이어집니다." }
        return "아래 입력칸에 지시를 적으면 여기에 이어집니다."
    }

    private func loadOlder() {
        guard canPage else { return }
        guard anchor.hostFound, anchor.visibleAnchor != nil else { positionError = true; return }
        positionError = false; autoPaused = false; intentUsed = true
        chatAnnounce("이전 글을 불러오는 중입니다")
        Task { await store.loadOlderMessages() }
    }

    private func present(_ incoming: [Message], proxy: ScrollViewProxy) {
        guard loaded else { return }
        if !started {
            started = true; displayed = incoming
            if let id = notificationAnchor {
                pinned = false; restoring = ChatHistoryAnchor(messageID: chatMessageRowID(id), offset: 0)
            } else if let saved = history?.anchor, history?.pinnedToBottom == false {
                pinned = false; restoring = saved
            } else { pinned = true }
            Task { @MainActor in
                await Task.yield()
                guard isVisible else { return }
                if let restoring { proxy.scrollTo(restoring.messageID, anchor: .top) }
                else { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            }
            return
        }
        guard ChatThreadContent(items: displayed) != ChatThreadContent(items: incoming) else { return }
        queued = incoming
        guard !anchor.isPreservingPosition else { return }
        let hasPrepend = displayed.first.flatMap { first in incoming.first.map { ChatHistory.ordered($0, first) } } ?? false
        if hasPrepend || (!pinned && !displayed.isEmpty) {
            if anchor.prepend(scope: scopeID, mutation: {
                if let queued {
                    let count = max(0, queued.count - displayed.count)
                    displayed = queued; self.queued = nil
                    if hasPrepend && count > 0 { chatAnnounce("이전 글 \(count)개를 불러왔습니다") }
                }
            }) { return }
            // Keep the old viewport rather than applying a page without a proven host/anchor.
            positionError = true
            return
        }
        displayed = incoming; queued = nil
        if pinned || followID.map({ id in incoming.contains { $0.id == id } }) == true {
            followID = nil
            Task { @MainActor in
                await Task.yield()
                if isVisible { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            }
        }
    }

    private func observe(_ frames: [String: CGRect], proxy: ScrollViewProxy) {
        guard started, viewportHeight > 0 else { return }
        if anchor.isInteracting && !wasInteracting { intentUsed = false }
        wasInteracting = anchor.isInteracting
        if let restoring, let frame = frames[restoring.messageID] {
            if !anchor.isInteracting {
                anchor.adjustOffset(by: frame.minY - CGFloat(restoring.offset))
                self.restoring = nil
            }
            return
        }
        if let nextTop = frames["history-top"]?.minY {
            if let top, nextTop > top + 1, anchor.isInteracting, !intentUsed, !autoPaused,
               nextTop >= -480, canPage { loadOlder() }
            top = nextTop
        }
        if !anchor.isInteracting, !anchor.isPreservingPosition, !pinned,
           let reading, let frame = frames[reading.messageID], abs(frame.minY - reading.top) > 0.5 {
            if abs(anchor.adjustOffset(by: frame.minY - reading.top)) > 0.01 { return }
        }
        if !anchor.isPreservingPosition {
            if let bottom = frames["history-bottom"] {
                let nearBottom = bottom.maxY <= viewportHeight + 80
                // During content growth retain the prior pin; real user scrolling may unpin it.
                if anchor.isInteracting || nearBottom { pinned = nearBottom }
                if pinned && !nearBottom && !anchor.isInteracting { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            } else if anchor.isInteracting { pinned = false }
            reading = ChatScrollAnchor.firstVisible(frames: frames, viewportHeight: viewportHeight)
            savePosition()
        }
    }

    private func savePosition() {
        guard notificationAnchor == nil, history != nil, restoring == nil else { return }
        let value = reading.map { ChatHistoryAnchor(messageID: $0.messageID, offset: Double($0.top)) }
        if history?.anchor != value || history?.pinnedToBottom != pinned {
            store.setHistoryReadingPosition(value, pinned: pinned)
        }
    }

    private func jump(_ proxy: ScrollViewProxy) {
        anchor.cancelPreservation(); restoring = nil; reading = nil; pinned = true
        if let queued { displayed = queued; self.queued = nil }
        store.setHistoryReadingPosition(nil, pinned: true)
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
    }

    private func returnToLatest() {
        anchor.cancelPreservation(); queued = nil; restoring = nil; reading = nil
        store.leaveNotificationAnchor(); router.chatMessageID = nil
        store.setHistoryReadingPosition(nil, pinned: true)
        pinned = true; started = false
    }

    private func jumpButton(_ proxy: ScrollViewProxy) -> some View {
        let count = history?.isBridging == true ? 0 : history?.unreadCount ?? 0
        return Button {
            if notificationAnchor != nil { returnToLatest() }
            jump(proxy)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "arrow.down").font(CEFont.micro)
                Text(count > 0 ? "새 글 \(count)개" : "맨 아래로")
            }
            .font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.ink)
            .padding(.horizontal, 12).frame(height: isMac ? 28 : 36)
            .glassChrome(Capsule(), tint: count > 0 ? CE.accentFill.opacity(0.85) : nil, interactive: true)
            .frame(minHeight: isMac ? nil : 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).padding(.bottom, CESpace.s)
        .accessibilityLabel(count > 0 ? "새 글 \(count)개, 맨 아래로 이동" : "맨 아래로 이동")
    }
}

/// Compare all rendered fields, including delivery and attachment changes, without adding model-wide equality.
private struct ChatThreadContent: Equatable {
    let items: [Message]
    static func == (lhs: Self, rhs: Self) -> Bool {
        guard lhs.items.count == rhs.items.count else { return false }
        return zip(lhs.items, rhs.items).allSatisfy { a, b in
            a.id.utf8.elementsEqual(b.id.utf8) && a.projectId == b.projectId && a.at == b.at && a.mine == b.mine
                && a.memberId == b.memberId && a.who == b.who && a.kind == b.kind && a.title == b.title
                && a.body == b.body && a.targetMemberId == b.targetMemberId && a.targetName == b.targetName
                && a.decisionId == b.decisionId && a.fileId == b.fileId && a.delivery == b.delivery && a.deliveryNote == b.deliveryNote
                && a.attachments.count == b.attachments.count && zip(a.attachments, b.attachments).allSatisfy { x, y in
                    x.id == y.id && x.name == y.name && x.mime == y.mime && x.size == y.size
                        && x.url == y.url && x.path == y.path && x.isImage == y.isImage
                }
        }
    }
}

/// Web empty state: centred title and one line, no icon.
private struct ChatEmpty: View {
    let title: String
    let detail: String
    var body: some View {
        VStack(spacing: 8) {
            Text(title).font(ChatFont.emptyTitle).foregroundStyle(CE.ink)
            Text(detail).font(ChatFont.emptyBody).foregroundStyle(CE.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, CESpace.l).padding(.vertical, isMac ? 64 : 48)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

private enum ChatThreadRow: Identifiable {
    case day(id: String, label: String)
    case message(Message)
    var id: String {
        switch self {
        case .day(let id, _): id
        case .message(let message): chatMessageRowID(message.id)
        }
    }
}

/// Swift String identity folds canonically equivalent IDs; the server's BINARY IDs must remain distinct.
private func chatMessageRowID(_ id: String) -> String { "m:" + Data(id.utf8).base64EncodedString() }

@MainActor private func chatAnnounce(_ text: String) {
    #if os(macOS)
    NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                         userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.medium.rawValue])
    #else
    UIAccessibility.post(notification: .announcement, argument: text)
    #endif
}

/// Chronological rows with a day separator whenever the calendar day changes (rows only show a clock time).
@MainActor private func chatThreadRows(_ messages: [Message]) -> [ChatThreadRow] {
    var rows: [ChatThreadRow] = []
    rows.reserveCapacity(messages.count + 4)
    var lastDay: String?
    var used = Set<String>()
    let calendar = Calendar.current
    for message in messages {
        if let date = ChatDates.parse(message.at) {
            let parts = calendar.dateComponents([.year, .month, .day], from: date)
            let day = "day:\(parts.year ?? 0)-\(parts.month ?? 0)-\(parts.day ?? 0)"
            if day != lastDay {
                let id = used.contains(day) ? "\(day)#\(rows.count)" : day
                used.insert(day)
                rows.append(.day(id: id, label: ChatDates.dayLabel(date)))
                lastDay = day
            }
        }
        rows.append(.message(message))
    }
    return rows
}

@MainActor private enum ChatDates {
    static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    static let plain = ISO8601DateFormatter()
    static func parse(_ value: String) -> Date? {
        guard !value.isEmpty else { return nil }
        return fractional.date(from: value) ?? plain.date(from: value)
    }
    static func dayLabel(_ date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "오늘" }
        if calendar.isDateInYesterday(date) { return "어제" }
        let weekdays = ["일", "월", "화", "수", "목", "금", "토"]
        let parts = calendar.dateComponents([.year, .month, .day, .weekday], from: date)
        let weekday = weekdays[max(0, min(6, (parts.weekday ?? 1) - 1))]
        let day = "\(parts.month ?? 0)월 \(parts.day ?? 0)일 (\(weekday))"
        return parts.year == calendar.component(.year, from: now) ? day : "\(parts.year ?? 0)년 \(day)"
    }
}

// MARK: - Recipients

/// Wide (Mac / iPad regular): recipients column in the web sidebar-row style. Selection is the shared composer target.
private struct ChatRecipientList: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(DraftStore.self) private var drafts

    var body: some View {
        let scope = ChatScope(store: store, router: router)
        let problems = scope.deliveryProblems
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                row(nil, scope: scope, problems: problems)
                if !scope.workers.isEmpty {
                    Text("팀장")
                        .font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.ink3)
                        .padding(.horizontal, 12).padding(.top, 14).padding(.bottom, 6)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(scope.workers) { member in
                        row(member, scope: scope, problems: problems)
                    }
                } else if store.state?.project.isHq != true {
                    Text("팀장이 아직 없습니다")
                        .font(CEFont.meta).foregroundStyle(CE.ink3)
                        .padding(.horizontal, 12).padding(.top, 12)
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 10)
        }
        .scrollIndicators(.never)
        .background(CE.glassTint.opacity(0.22))
    }

    private func row(_ member: Member?, scope: ChatScope, problems: [String: String]) -> some View {
        let selected = scope.isSelected(member)
        let problem = problems[member?.id ?? "chief"]
        let draft = chatHasDraft(drafts, project: store.selectedProjectID, target: member?.id)
        let detail = member ?? scope.lead
        return Button { router.chatTarget = member?.id } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Text(member?.name ?? scope.threadTitle).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                        if draft { ChatDraftMark() }
                    }
                    subtitle(member, scope: scope)
                }
                Spacer(minLength: 4)
                if let problem { ChatProblemMark(kind: problem) }
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .frame(maxWidth: .infinity, minHeight: isMac ? 44 : 48, alignment: .leading)
        }
        .buttonStyle(ChatRowStyle(shape: RoundedRectangle(cornerRadius: 13, style: .continuous), selected: selected))
        .contextMenu {
            if !store.isArchive, let detail {
                Button(detail.kind == "worker" ? "팀원 보기" : "\(rankName(detail.kind)) 보기") { router.openMember(detail.id) }
                if detail.status == "blocked" { Button("터미널 열기") { router.openTerminal(detail.id) } }
            }
        }
        .accessibilityLabel(scope.accessibilityText(member, problem: problem, draft: draft))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// One quiet line, like the web project rows: status (dot carries the colour) or "총괄 · status".
    @ViewBuilder private func subtitle(_ member: Member?, scope: ChatScope) -> some View {
        if let status = (member ?? scope.lead)?.status {
            let info = MemberStatusInfo(status)
            HStack(spacing: 5) {
                StatusDot(tone: info.tone, pulsing: info.live, size: 6)
                Text(member == nil ? "\(scope.leadTitle) · \(info.label)" : info.label)
                    .font(CEFont.meta).foregroundStyle(CE.ink2).lineLimit(1)
            }
        } else {
            Text("총괄이 아직 없습니다").font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1)
        }
    }
}

/// iPhone: horizontal recipient chips under the navigation bar (selected = violet drop, like the web sidebar row).
private struct ChatRecipientChips: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(DraftStore.self) private var drafts
    private static let projectChipID = "chat-recipient-project"

    var body: some View {
        let scope = ChatScope(store: store, router: router)
        let problems = scope.deliveryProblems
        let selectedID = scope.isProjectThread ? Self.projectChipID : (router.chatTarget ?? Self.projectChipID)
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    chip(nil, scope: scope, problems: problems)
                    ForEach(scope.workers) { member in
                        chip(member, scope: scope, problems: problems)
                    }
                }
                .padding(.horizontal, CESpace.l)
            }
            .onAppear { proxy.scrollTo(selectedID, anchor: .center) }
            .onChange(of: selectedID) { _, id in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .center) }
            }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(CE.line).frame(height: 1) }
    }

    private func chip(_ member: Member?, scope: ChatScope, problems: [String: String]) -> some View {
        let selected = scope.isSelected(member)
        let problem = problems[member?.id ?? "chief"]
        let draft = chatHasDraft(drafts, project: store.selectedProjectID, target: member?.id)
        return Button { router.chatTarget = member?.id } label: {
            HStack(spacing: 6) {
                if let member {
                    let info = MemberStatusInfo(member.status)
                    StatusDot(tone: info.tone, pulsing: info.live, size: 6)
                }
                Text(member?.name ?? scope.threadTitle).font(CEFont.meta.weight(.semibold)).lineLimit(1)
                if draft { ChatDraftMark() }
                if let problem { ChatProblemMark(kind: problem) }
            }
            .foregroundStyle(selected ? CE.ink : CE.ink2)
            .padding(.horizontal, 13)
            .frame(height: 34)
            .background { ChatSelectionFill(shape: Capsule(), selected: selected, rest: 0.06) }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .id(member?.id ?? Self.projectChipID)
        .accessibilityLabel(scope.accessibilityText(member, problem: problem, draft: draft))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Headers

/// Wide: one row. Who the thread is with and their CLI state, the one note that changes what sending does (with the
/// action that clears it), and the detail link. Everything is single-line: this sits outside the scroll view.
private struct ChatThreadHeader: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let scope = ChatScope(store: store, router: router)
        let note = store.isArchive ? nil : scope.runnerOffNote ?? scope.currentMember.flatMap { scope.note(for: $0, wide: true) }
        HStack(spacing: 10) {
            identity(scope)
            if let note { ChatNoteCapsule(note: note).layoutPriority(-1) }
            Spacer(minLength: CESpace.s)
            action(scope)
        }
        .padding(.horizontal, isMac ? CESpace.xl : CESpace.l)
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .overlay(alignment: .bottom) { Rectangle().fill(CE.line).frame(height: 1) }
    }

    @ViewBuilder private func identity(_ scope: ChatScope) -> some View {
        if let member = scope.recipient {
            Text(member.name).font(CEFont.title).foregroundStyle(CE.ink).lineLimit(1)
                .help(member.role.isEmpty ? rankName(member.kind) : member.role)
            statusBadge(member)
            if member.queuedCount > 0 {
                Text("대기열 \(member.queuedCount)").font(CEFont.meta).foregroundStyle(CE.ink3).monospacedDigit().fixedSize()
                    .help("먼저 보낸 글 \(member.queuedCount)건이 차례를 기다립니다")
            }
        } else if scope.missingTarget {
            Text("명부에 없는 대화 상대").font(CEFont.title).foregroundStyle(CE.ink).lineLimit(1)
                .help("이 대상에게는 보낼 수 없습니다")
        } else {
            Text(scope.threadTitle).font(CEFont.title).foregroundStyle(CE.ink).lineLimit(1)
                .help("모든 보고와 지시")
            if let lead = scope.lead {
                Text(scope.leadTitle).font(CEFont.meta).foregroundStyle(CE.ink3).fixedSize()
                statusBadge(lead)
            }
        }
    }

    private func statusBadge(_ member: Member) -> some View {
        StatusBadge(status: member.status).help(MemberStatusInfo(member.status).explanation)
    }

    @ViewBuilder private func action(_ scope: ChatScope) -> some View {
        if store.isArchive {
            Tag("읽기 전용", tone: .dim)
        } else if scope.missingTarget {
            Button("프로젝트 대화로") { router.chatTarget = nil }.ceSecondaryButton().controlSize(.small)
        } else if let member = scope.currentMember {
            Button(member.kind == "worker" ? "팀원 보기" : "\(rankName(member.kind)) 보기") { router.openMember(member.id) }
                .ceSecondaryButton().controlSize(.small)
        }
    }
}

/// iPhone: only the notes that change what sending does. The detail link is in the nav bar, so a healthy thread
/// spends no height here.
private struct ChatCompactNotes: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        let scope = ChatScope(store: store, router: router)
        let note = scope.currentMember.flatMap { scope.note(for: $0, wide: false) }
        let runner = scope.runnerOffNote
        if !store.isArchive && (note != nil || scope.missingTarget || runner != nil) {
            VStack(alignment: .leading, spacing: 6) {
                if scope.missingTarget {
                    ChatNoteStrip(note: ChatNote(tone: .attention, icon: "person.crop.circle.badge.questionmark",
                                                 text: "명부에 없는 대화 상대 · 보낼 수 없습니다",
                                                 actionTitle: "프로젝트 대화로", action: { router.chatTarget = nil }))
                }
                if let runner { ChatNoteStrip(note: runner) }
                if let note { ChatNoteStrip(note: note) }
            }
            .padding(.horizontal, CESpace.l).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - iOS inline composer

#if os(iOS)
/// The recipient is the selected chip/row and the composer's placeholder ("{대상}에게 …"), so no extra target line.
private struct ChatInlineComposer: View {
    @Environment(Router.self) private var router

    var body: some View {
        @Bindable var router = router
        ComposerBar(target: $router.chatTarget, showsTargetPicker: false)
            .padding(.horizontal, CESpace.m).padding(.top, 6).padding(.bottom, CESpace.s)
            .background {
                LinearGradient(colors: [CE.bg.opacity(0), CE.bg.opacity(0.9)], startPoint: .top, endPoint: .center)
                    .allowsHitTesting(false)
            }
    }
}
#endif

// MARK: - Placeholder (no project state yet)

private struct ChatPlaceholder: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        VStack(spacing: CESpace.m) {
            if store.isLoading {
                ProgressView().controlSize(.small)
                Text("대화를 불러오는 중입니다").font(ChatFont.emptyBody).foregroundStyle(CE.ink2)
            } else if !store.isDemo && store.bootstrap != nil && store.projects.isEmpty {
                ChatEmpty(title: "아직 프로젝트가 없습니다", detail: "새 프로젝트를 만들면 총괄과 대화할 수 있습니다.")
                Button("새 프로젝트") { router.showNewProject = true }
                    .ceProminentButton()
                    .disabled(!store.canWrite)
            } else {
                ChatEmpty(title: "대화를 불러오지 못했습니다",
                          detail: store.connectionStatus == .connected ? "잠시 뒤 다시 동기화하세요." : "서버 연결을 확인한 뒤 다시 연결하세요.")
                if store.connectionStatus == .connected && !store.isDemo {
                    Button("지금 동기화") { Task { await store.refresh() } }.ceSecondaryButton()
                }
            }
        }
        .frame(maxWidth: 420)
        .padding(CESpace.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Shared helpers

/// Recipient facts derived from the store and the shared composer target.
@MainActor private struct ChatScope {
    let store: AppStore
    let router: Router

    var lead: Member? { store.members.first { $0.kind == "conductor" || $0.kind == "root" } }
    var workers: [Member] { store.members.filter { $0.kind == "worker" } }
    /// nil (or the lead's own id) = the project conversation with the lead.
    var isProjectThread: Bool { router.chatTarget == nil || router.chatTarget == lead?.id }
    var recipient: Member? {
        guard !isProjectThread, let id = router.chatTarget else { return nil }
        return store.members.first { $0.id == id }
    }
    var currentMember: Member? { isProjectThread ? lead : recipient }
    var missingTarget: Bool { !isProjectThread && recipient == nil }
    var leadTitle: String { lead.map { rankName($0.kind) } ?? "총괄" }
    /// The all-messages thread: "본사 대화" on HQ, "프로젝트 대화" elsewhere.
    var threadTitle: String { store.state?.project.isHq == true ? "본사 대화" : "프로젝트 대화" }
    var threadKey: String { DraftStore.key(project: store.selectedProjectID, target: isProjectThread ? nil : router.chatTarget) }

    /// Project thread = everything; a member thread = their reports and what I sent them.
    var messages: [Message] {
        guard !isProjectThread, let id = router.chatTarget else { return store.messages }
        return store.messages.filter { $0.memberId == id || $0.targetMemberId == id }
    }

    func isSelected(_ member: Member?) -> Bool {
        guard let member else { return isProjectThread }
        return router.chatTarget == member.id
    }

    /// Target key ("chief" for the project conversation) → "failed" / "held", only while that is my latest message there.
    var deliveryProblems: [String: String] {
        var map: [String: String] = [:]
        for message in unresolvedDeliveries(store.messages, status: "held") { map[message.targetMemberId ?? "chief"] = "held" }
        for message in unresolvedDeliveries(store.messages, status: "failed") { map[message.targetMemberId ?? "chief"] = "failed" }
        return map
    }
    var unresolvedIDs: Set<String> {
        Set((unresolvedDeliveries(store.messages, status: "failed") + unresolvedDeliveries(store.messages, status: "held")).map(\.id))
    }

    /// What sending to this member will do right now, with the one action that unblocks it. Short on purpose: the
    /// full reason is the tooltip, the member detail and the status explanation. 잠듦 / 안 보임 need no note (sending
    /// wakes or reopens the session; the status badge's tooltip says so).
    func note(for member: Member, wide: Bool) -> ChatNote? {
        let router = router
        let id = member.id
        let detailTitle = member.kind == "worker" ? "팀원 보기" : "\(rankName(member.kind)) 보기"
        if member.status == "blocked" {
            return ChatNote(tone: .approval, icon: "hand.raised.fill",
                            text: "승인 창 앞 · 처리할 때까지 보낸 글은 보류됩니다",
                            actionTitle: "터미널 열기", action: { router.openTerminal(id) })
        }
        if member.status == "error" {
            let error = member.lastError?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return ChatNote(tone: .danger, icon: "exclamationmark.triangle.fill",
                            text: error.isEmpty ? "오류 · 턴이나 세션 시작이 실패했습니다" : "오류: \(error)",
                            actionTitle: wide ? nil : detailTitle, action: wide ? nil : { router.openMember(id) })
        }
        if let backend = member.backend, backend != "core" {
            return ChatNote(tone: .attention, icon: "arrow.triangle.2.circlepath",
                            text: "이전 실행기 세션 · 새 세션으로 이어가야 합니다",
                            actionTitle: wide ? nil : detailTitle, action: wide ? nil : { router.openMember(id) })
        }
        if member.origin == "manual" {
            return ChatNote(tone: .neutral, icon: "terminal",
                            text: "직접 띄운 세션 · 그 세션이 wait를 부를 때 전달됩니다")
        }
        if member.status == "waiting" {
            let open = newestFirst(store.decisions.filter { $0.status == "open" && $0.memberId == id })
            let decisionID = open.first?.id
            return ChatNote(tone: .attention, icon: "hourglass",
                            text: open.isEmpty ? "답을 기다리는 결재가 있습니다" : "답하지 않은 결재 \(open.count)건",
                            actionTitle: "결재함으로", action: { if let decisionID { router.openDecision(decisionID) } else { router.go(.inbox) } })
        }
        return nil
    }

    /// The composer footer already shows the connection detail; this adds the way out for a stopped runner.
    var runnerOffNote: ChatNote? {
        guard !store.isDemo, let connection = store.state?.project.connection, !connection.ok, connection.reason == "runner_off" else { return nil }
        let router = router
        return ChatNote(tone: .attention, icon: "power",
                        text: "총괄이 꺼져 있어 지금은 보낼 수 없습니다 · 쓰던 글은 남아 있습니다",
                        actionTitle: "팀 화면으로", action: { router.go(.team) })
    }

    func accessibilityText(_ member: Member?, problem: String?, draft: Bool) -> String {
        var parts = [member?.name ?? threadTitle]
        if let member {
            parts.append(MemberStatusInfo(member.status).label)
        } else if let lead {
            parts.append("\(rankName(lead.kind)) \(MemberStatusInfo(lead.status).label)")
        }
        if problem == "failed" { parts.append("전달 실패한 글 있음") } else if problem == "held" { parts.append("보류된 전달 있음") }
        if draft { parts.append("쓰던 글 있음") }
        return parts.joined(separator: ", ")
    }
}

private struct ChatNote {
    let tone: Tone
    let icon: String
    let text: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var actionColor: Color { tone == .neutral || tone == .dim ? CE.accent : tone.color }
}

/// Wide header: the note inline as a tinted capsule. Single line (truncates; full text on hover and to VoiceOver),
/// so the header's height never depends on its width.
private struct ChatNoteCapsule: View {
    let note: ChatNote
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: note.icon).foregroundStyle(note.tone.color)
            Text(note.text).foregroundStyle(CE.ink2).lineLimit(1).truncationMode(.tail)
            if let title = note.actionTitle, let action = note.action {
                Button(title, action: action)
                    .buttonStyle(.plain)
                    .font(CEFont.meta.weight(.semibold))
                    .foregroundStyle(note.actionColor)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .font(CEFont.meta)
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(note.tone.color.opacity(0.1), in: Capsule())
        .overlay { Capsule().strokeBorder(note.tone.color.opacity(0.22)) }
        .help(note.text)
    }
}

/// iPhone: the note as a tinted strip under the chips. At most two lines (it sits outside the scroll view).
private struct ChatNoteStrip: View {
    let note: ChatNote
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: CESpace.s) {
            Image(systemName: note.icon).foregroundStyle(note.tone.color)
            Text(note.text).foregroundStyle(CE.ink2)
                .lineLimit(2)
                .help(note.text)
            Spacer(minLength: 6)
            if let title = note.actionTitle, let action = note.action {
                Button(title, action: action)
                    .buttonStyle(.plain)
                    .font(CEFont.meta.weight(.semibold))
                    .foregroundStyle(note.actionColor)
                    .padding(.vertical, isMac ? 0 : 6)
                    .contentShape(Rectangle())
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .font(CEFont.meta)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(note.tone.color.opacity(0.1), in: RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: CERadius.control, style: .continuous).strokeBorder(note.tone.color.opacity(0.22)) }
    }
}

/// Web .th-link: rounded chip with a chevron; the open-decision chip is the violet one.
private struct ChatJumpChip: View {
    let title: String
    var prominent = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title).lineLimit(1)
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(CE.ink2)
            }
            .font(ChatFont.chip)
            .foregroundStyle(CE.ink)
            .padding(.leading, 13).padding(.trailing, 11)
            .frame(minHeight: isMac ? 30 : 44)
        }
        .buttonStyle(ChatJumpStyle(prominent: prominent))
    }
}

private struct ChatJumpStyle: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        ChatJumpBody(label: configuration.label, pressed: configuration.isPressed, prominent: prominent)
    }
}

private struct ChatJumpBody<Label: View>: View {
    let label: Label
    let pressed: Bool
    let prominent: Bool
    @State private var hovering = false
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        let lift = pressed ? 0.12 : hovering ? 0.08 : 0
        label
            .contentShape(shape)
            .background(prominent ? CE.violet.opacity(0.34 + lift * 1.4) : Color.white.opacity(0.07 + lift * 0.75), in: shape)
            .overlay { shape.strokeBorder(prominent ? CE.violet.opacity(0.8) : Color.white.opacity(0.1)) }
            .onHover { hovering = $0 }
    }
}

/// Small text action in my bubble's footer ("터미널 열기", "팀원 보기"), same weight as "다시 보내기".
private struct ChatFooterLink: View {
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).underline()
                .font(CEFont.meta.weight(.semibold))
                .foregroundStyle(CE.ink)
                .frame(minHeight: isMac ? nil : 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
    }
}

/// Recipient rows: clear at rest, light on hover, the web's violet gradient drop when selected.
private struct ChatRowStyle<S: InsettableShape>: ButtonStyle {
    let shape: S
    var selected = false
    func makeBody(configuration: Configuration) -> some View {
        ChatRowBody(label: configuration.label, shape: shape, selected: selected, pressed: configuration.isPressed)
    }
}

private struct ChatRowBody<S: InsettableShape, Label: View>: View {
    let label: Label
    let shape: S
    let selected: Bool
    let pressed: Bool
    @State private var hovering = false
    var body: some View {
        label
            .contentShape(shape)
            .background { ChatSelectionFill(shape: shape, selected: selected, rest: pressed ? 0.09 : hovering ? 0.06 : 0) }
            .onHover { hovering = $0 }
    }
}

/// Web `.pj[aria-current]`: violet gradient (.32 → .2) with a bright top edge; otherwise a plain white fill.
private struct ChatSelectionFill<S: InsettableShape>: View {
    let shape: S
    let selected: Bool
    var rest: Double = 0
    var body: some View {
        if selected {
            shape
                .fill(LinearGradient(colors: [CE.violet.opacity(0.34), CE.violet.opacity(0.2)], startPoint: .top, endPoint: .bottom))
                .overlay { shape.strokeBorder(ChatPalette.selectionRim, lineWidth: 1) }
        } else if rest > 0 {
            shape.fill(Color.white.opacity(rest))
        } else {
            Color.clear
        }
    }
}

/// What a delivery label means, on tap (popover on every device) — never a standing line in the thread.
private struct ChatDeliveryExplanation: View {
    let info: DeliveryInfo
    let note: String?
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(info.label).font(CEFont.rowTitle).foregroundStyle(color)
            if let note { Text(note).font(CEFont.meta).foregroundStyle(CE.ink) }
            if !info.explanation.isEmpty { Text(info.explanation).font(CEFont.meta).foregroundStyle(CE.ink2) }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: 260, alignment: .leading)
        .padding(14)
        .presentationCompactAdaptation(.popover)
    }
}

private struct ChatDraftMark: View {
    var body: some View {
        Image(systemName: "pencil")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(CE.ink3)
            .help("쓰던 글이 있습니다")
            .accessibilityLabel("쓰던 글 있음")
    }
}

private struct ChatProblemMark: View {
    let kind: String
    var body: some View {
        let failed = kind == "failed"
        Image(systemName: failed ? "exclamationmark.circle.fill" : "pause.circle.fill")
            .font(.system(size: 12))
            .foregroundStyle(failed ? CE.danger : CE.warn)
            .help(failed ? "전달 실패한 글이 있습니다" : "보류된 전달이 있습니다")
            .accessibilityLabel(failed ? "전달 실패한 글 있음" : "보류된 전달 있음")
    }
}

/// Short single-paragraph messages hug their text (bubble width follows content); structured ones use MarkdownText.
private struct ChatBodyText: View {
    let text: String
    var body: some View {
        if Self.isStructured(text) {
            MarkdownText(text: text)
        } else {
            Text(Self.inline(text))
                .font(CEFont.body)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
    static func isStructured(_ text: String) -> Bool {
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("# ") || line.hasPrefix("## ") || line.hasPrefix("### ")
                || line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") { return true }
            if let dot = line.firstIndex(of: "."), !line[..<dot].isEmpty, line[..<dot].allSatisfy(\.isNumber),
               line[line.index(after: dot)...].hasPrefix(" ") { return true }
        }
        return false
    }
    static func inline(_ value: String) -> AttributedString {
        (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value)
    }
}

/// Web thread colours that are not foundation tokens.
private enum ChatPalette {
    /// .th-mine background rgb(72 50 176 / .9).
    static let bubble = Color(red: 72 / 255, green: 50 / 255, blue: 176 / 255).opacity(0.9)
    static let bubbleTo = Color(hex: 0xDAD2FF)
    static let bubbleLink = Color(hex: 0xE6DFFF)
    /// Bright top edge + faint ring (inset 0 1px .5px -.5px white .4, inset 0 0 0 1px white .07).
    static let bubbleRim = LinearGradient(stops: [
        .init(color: .white.opacity(0.4), location: 0),
        .init(color: .white.opacity(0.08), location: 0.22),
        .init(color: .white.opacity(0.07), location: 1),
    ], startPoint: .top, endPoint: .bottom)
    static let selectionRim = LinearGradient(stops: [
        .init(color: .white.opacity(0.42), location: 0),
        .init(color: .white.opacity(0.06), location: 0.3),
        .init(color: .white.opacity(0.05), location: 1),
    ], startPoint: .top, endPoint: .bottom)
    /// .th-system background rgb(15 11 32 / .66).
    static let systemFill = Color(red: 15 / 255, green: 11 / 255, blue: 32 / 255).opacity(0.66)
}

private enum ChatBubbleShape {
    /// Web radius 18 18 5 18: the tail corner points at the sender (bottom right).
    static var shape: UnevenRoundedRectangle { UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 5, topTrailingRadius: 18, style: .continuous) }
}

private enum ChatFont {
    #if os(macOS)
    static let cardTitle: Font = .system(size: 15.5, weight: .semibold)
    static let who: Font = .system(size: 13.5, weight: .semibold)
    static let chip: Font = .system(size: 13, weight: .semibold)
    static let bubbleTo: Font = .system(size: 12.5, weight: .semibold)
    static let emptyTitle: Font = .system(size: 16, weight: .semibold)
    static let emptyBody: Font = .system(size: 14)
    #else
    static let cardTitle: Font = .callout.weight(.semibold)
    static let who: Font = .footnote.weight(.semibold)
    static let chip: Font = .footnote.weight(.semibold)
    static let bubbleTo: Font = .caption.weight(.semibold)
    static let emptyTitle: Font = .callout.weight(.semibold)
    static let emptyBody: Font = .subheadline
    #endif
}

/// Web delivery tones: 받음 ok, 보류 warn, 실패 danger, 전달 대기 / 보냄 muted.
private func chatDeliveryColor(_ delivery: String?) -> Color {
    switch delivery {
    case "delivered": CE.success
    case "held": CE.warn
    case "failed": CE.danger
    default: CE.ink2
    }
}

/// Link text for a report's decision (web decisionLinkText) and whether it is the open, highlighted one.
private func chatDecisionLink(_ decision: Decision?) -> (title: String, open: Bool) {
    guard let decision else { return ("결재함에서 보기", false) }
    switch decision.status {
    case "open": return ("결재함에서 답하기", true)
    case "closed": return ("닫힌 결재 보기", false)
    default:
        let chosen = decision.options.first { $0.k == decision.choice }?.label
        let label = (chosen ?? decision.note)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return (label.isEmpty ? "답한 결재 보기" : "답함: \(plainOneLine(label))", false)
    }
}

@MainActor private func chatHasDraft(_ drafts: DraftStore, project: String?, target: String?) -> Bool {
    let key = DraftStore.key(project: project, target: target)
    return !drafts.text(for: key).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !drafts.files(for: key).isEmpty
}

/// "결제 총괄" stays as is; a lead whose name does not say its rank gets it as a prefix ("총괄 하나").
private func chatLeadLabel(_ lead: Member) -> String {
    let rank = rankName(lead.kind)
    if lead.name.isEmpty { return rank }
    return lead.name.contains(rank) ? lead.name : "\(rank) \(lead.name)"
}
