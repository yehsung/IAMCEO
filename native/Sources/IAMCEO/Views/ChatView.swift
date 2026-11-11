import SwiftUI
import ImageIO
import QuickLook
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
// iOS: the composer is inline at the bottom; the recipient is picked by chips. (The recipients column is the wide
// layout, which only Mac reaches: the iOS app is iPhone-only and iPad is not supported.)

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
    private var waits: [ChatDeliveryWait] { ChatDeliveryWait.lines(message, target: target) }
    private var note: String? {
        let value = message.deliveryNote?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : plainDeliveryNote(value)
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
        if let notice = store.connectionNotice { return notice }
        if store.showsOffline { return "서버에 연결되지 않아 지금은 다시 보낼 수 없습니다" }
        if store.connectionStatus != .connected { return "잠시 연결을 확인하는 중" }
        if let connection = store.state?.project.connection, !connection.ok {
            return connection.ownerDetail ?? "이 프로젝트의 실행 연결에 문제가 있어 지금은 다시 보낼 수 없습니다"
        }
        if store.isSending(projectID: message.projectId, targetMemberID: message.targetMemberId) { return "보내는 중입니다" }
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
                        .font(CEFont.secondary).foregroundStyle(CE.danger)
                        .ceLineHeight(13, 1.45)
                        .multilineTextAlignment(.trailing)
                        .lineLimit(3)
                        .padding(.trailing, 4)
                }
            }
            .frame(maxWidth: 620, alignment: .trailing)
        }
        // A footer with a reason line belongs to this bubble: keep clear air below it before the next message.
        .padding(.bottom, info != nil && (note != nil || !waits.isEmpty) ? 6 : 0)
    }

    /// Web .th-mine: gap 8, padding 10 15 11.
    private var bubble: some View {
        let shape = ChatBubbleShape.shape
        return VStack(alignment: .leading, spacing: 8) {
            if let targetName {
                Text("\(targetName)에게").font(ChatFont.bubbleTo).foregroundStyle(ChatPalette.bubbleTo).lineLimit(1)
            }
            if !message.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ChatBodyText(text: message.body)
            }
            if !message.attachments.isEmpty {
                ChatAttachments(items: message.attachments, onBubble: true)
            }
        }
        .foregroundStyle(Color.white)
        .tint(ChatPalette.bubbleLink)
        .padding(.horizontal, 15).padding(.top, 10).padding(.bottom, 11)
        .background(ChatPalette.bubble, in: shape)
        .overlay { shape.strokeBorder(ChatPalette.bubbleRim, lineWidth: 1) }
        .chatMessageMenu(message)
    }

    /// Web .th-foot: 12.5 / 1.4 in ink-2, column gap 8, 4 in from the bubble's edge; the time's tooltip is the full date.
    /// One clean line (time · state · action); the reason, when there is one, sits on its own quiet line under it
    /// instead of wrapping the state and the action across two lines.
    private var footer: some View {
        VStack(alignment: .trailing, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(clockTime(message.at)).monospacedDigit().foregroundStyle(CE.ink2).fixedSize()
                    .help(parseISODate(message.at).map(koDateTime) ?? "")
                if let info { deliveryLabel(info) }
                if !store.isArchive, message.delivery == "failed" {
                    resendButton
                } else if !store.isArchive, message.delivery == "held", isLatestProblem, let target {
                    heldAction(target)
                }
            }
            if !waits.isEmpty {
                TimelineView(.periodic(from: .now, by: 60)) { timeline in
                    VStack(alignment: .trailing, spacing: 1) {
                        ForEach(Array(waits.enumerated()), id: \.offset) { _, wait in
                            Text(wait.label(now: timeline.date) ?? "")
                                .foregroundStyle(waitReasonTone(wait.reason).color)
                                .multilineTextAlignment(.trailing)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: 360, alignment: .trailing)
                }
            }
            if info != nil, let note {
                Text(note)
                    .foregroundStyle(chatDeliveryColor(message.delivery).opacity(0.8))
                    .multilineTextAlignment(.trailing)
                    .lineLimit(2)
                    .lineSpacing(CELeading.meta)
                    .frame(maxWidth: 360, alignment: .trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(CEFont.meta)
        .padding(.trailing, 4)
    }

    /// The state word; tap (or hover on Mac) tells what it means.
    private func deliveryLabel(_ info: DeliveryInfo) -> some View {
        Button { explaining = true } label: {
            Text(info.label)
                .foregroundStyle(chatDeliveryColor(message.delivery))
                .lineLimit(1)
                .fixedSize()
                .quietHitArea()
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
        let busy = store.isSending(projectID: message.projectId, targetMemberID: message.targetMemberId) && !resending
        return Button { Task { await resend() } } label: {
            // Web .th-retry: 13 / 600 in ink-1, 0 4 padding, underlined.
            HStack(spacing: 4) {
                if resending { ProgressView().controlSize(.mini) }
                Text(resending ? "보내는 중" : "다시 보내기").underline(!resending)
            }
            .font(ChatFont.footerAction)
            .foregroundStyle(locked || busy ? CE.ink3 : CE.ink)
            .padding(.horizontal, 4)
            .frame(minHeight: isMac ? 24 : nil)
            .quietHitArea()
        }
        .buttonStyle(.plain)
        .disabled(locked || busy || resending)
        .fixedSize()
        .help(lockReason ?? "같은 글·대상·첨부로 다시 보냅니다.")
    }

    /// A held delivery waits on something only the CEO can clear; point at the place to clear it.
    @ViewBuilder private func heldAction(_ member: Member) -> some View {
        if MemberStatusInfo(member).tone == .approval {
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
        if !ok { resendError = "다시 보내지 못했습니다" + (store.errorMessage.map { ": \(friendlyError($0))" } ?? ".") }
    }
}

/// Server notices ("{name} 오류: …", "{name}에게 전달하지 못했습니다: …") as a quiet centred pill.
struct ChatSystemRow: View {
    let message: Message
    var body: some View {
        let title = message.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let detail = message.body.trimmingCharacters(in: .whitespacesAndNewlines)
        // Server notices often end in a raw provider message ("… 오류: Claude Code can't use …"): say it plainly.
        let text = [title, detail == title ? "" : detail].filter { !$0.isEmpty }.map(Self.plain).joined(separator: " · ")
        // Web .th-system: 13 / 1.5, padding 6 14, radius 12, at most 620 wide; the time is 12 in ink-3.
        Text(line(text))
            .font(CEFont.secondary)
            .ceLineHeight(13, 1.5)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 14).padding(.vertical, 6)
            .background(ChatPalette.systemFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .help(parseISODate(message.at).map(koDateTime) ?? "")
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
            .textSelection(.enabled)
    }

    /// "{이름} 오류: <raw>" keeps the name and maps the raw part; other notices pass through.
    static func plain(_ text: String) -> String {
        guard let range = text.range(of: "오류: ") ?? text.range(of: "): ") else { return friendlyError(text) }
        return String(text[..<range.upperBound]) + friendlyError(String(text[range.upperBound...]))
    }

    private func line(_ text: String) -> AttributedString {
        var main = AttributedString(text)
        main.swiftUI.foregroundColor = CE.ink2
        var time = AttributedString("  " + clockTime(message.at))
        time.swiftUI.foregroundColor = CE.ink3
        time.swiftUI.font = CEFont.caption.monospacedDigit()
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
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    if !message.kind.isEmpty { Tag(message.kind, tone: messageKindTone(message.kind)) }
                    Text(message.who).font(ChatFont.who).foregroundStyle(CE.ink).lineLimit(1)
                    Spacer(minLength: 6)
                    Text(clockTime(message.at)).font(CEFont.meta).foregroundStyle(CE.ink2).monospacedDigit()
                        .help(parseISODate(message.at).map(koDateTime) ?? "")
                    cardActions
                }
                if !message.title.isEmpty {
                    // Web .th-card__title: 15.5 / 650, line height 1.4, −.012em.
                    Text(message.title)
                        .font(ChatFont.cardTitle).tracking(-0.19).foregroundStyle(CE.ink)
                        .ceLineHeight(15.5, 1.4)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                if showsBody {
                    MarkdownText(text: message.body).foregroundStyle(CE.ink)
                }
                if !message.attachments.isEmpty {
                    ChatAttachments(items: message.attachments)
                }
                jumps
            }
            .padding(.top, 13).padding(.horizontal, 16).padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.ceInsideGlass, true)
            .modifier(ChatCardSurface())
            .chatMessageMenu(message)
            .frame(maxWidth: 720, alignment: .leading)
            Spacer(minLength: 0)
        }
    }

    /// The member who wrote this report, when the composer can address them (not on the roster any more: none).
    private var author: Member? {
        message.memberId.flatMap { id in store.members.first { $0.id == id } }
    }

    /// "답하기" points the composer at the author and focuses it, so a report can be answered without hunting for the
    /// recipient. iPhone also gets copy here (a long press is text selection, not a menu).
    @ViewBuilder private var cardActions: some View {
        let replyTarget: String?? = {
            guard let author else { return Optional<String?>.none }
            return author.kind == "worker" ? Optional<String?>.some(author.id) : Optional<String?>.some(nil)
        }()
        let canReply = !store.isArchive && replyTarget != nil && router.chatTarget != replyTarget!
        if canReply, let author, let replyTarget {
            // Tap answers the author; a long press (or right click) offers copy.
            Menu { cardMenu(reply: (author, replyTarget)) } label: { cardActionIcon("arrowshape.turn.up.left") } primaryAction: {
                router.chatTarget = replyTarget
                router.focusComposer &+= 1
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .help("\(author.name)에게 답하기 · 길게 누르면 복사")
            .accessibilityLabel("\(author.name)에게 답하기")
        } else if !isMac {
            Menu { cardMenu(reply: nil) } label: { cardActionIcon("ellipsis") }
                .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                .accessibilityLabel("복사")
        }
    }

    private func cardActionIcon(_ symbol: String) -> some View {
        Image(systemName: symbol).font(.system(size: 12, weight: .semibold)).foregroundStyle(CE.ink2)
            .frame(width: isMac ? 22 : 32, height: isMac ? 22 : 32)
            .contentShape(Rectangle())
    }

    @ViewBuilder private func cardMenu(reply: (Member, String?)?) -> some View {
        if let reply {
            Button { router.chatTarget = reply.1; router.focusComposer &+= 1 } label: {
                Label("\(reply.0.name)에게 답하기", systemImage: "arrowshape.turn.up.left")
            }
        }
        if !message.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Button { chatCopy(message.body) } label: { Label("본문 복사", systemImage: "doc.on.doc") }
        }
        if !message.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Button { chatCopy(message.title) } label: { Label("제목 복사", systemImage: "textformat") }
        }
    }

    /// Web .th-jumps: chips wrap onto new lines with an 8pt gap, directly in the card's 8pt rhythm.
    @ViewBuilder private var jumps: some View {
        if message.decisionId != nil || !chatReportCorrections(message).isEmpty {
            TeamWrapLayout(spacing: 8, lineSpacing: 8) {
                decisionJump
                ForEach(chatReportCorrections(message), id: \.title) { correction in
                    ChatJumpChip(title: correction.title) { router.chatMessageID = correction.messageID }
                }
            }
        }
        if !chatReportFileIDs(message).isEmpty {
            FileChips(fileIDs: chatReportFileIDs(message))
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

}

/// A new day reads as a break: the thread puts 20 above it (10 for the first one) and it keeps 2 under itself, so
/// the next row sits 12 below. 12 semibold: bold 11.5 Hangul looks blotchy.
struct ChatDaySeparator: View {
    let label: String
    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(CE.line).frame(height: 1)
            Text(label).font(CEFont.caption.weight(.semibold)).foregroundStyle(CE.ink3).fixedSize()
            Rectangle().fill(CE.line).frame(height: 1)
        }
        .padding(.bottom, 2)
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
    @State private var historyOwnerID = UUID()
    @State private var focus = ChatMessageFocus()
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
    @State private var scrollRevision = UUID()
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
    private var baseItems: [Message] {
        if notificationAnchor != nil { return store.historyMessages }
        if store.isDemo || (!store.isArchive && store.pagingSupport == .unsupported) { return scope.messages }
        return history?.items ?? []
    }
    private var items: [Message] {
        guard let context = focus.context else { return baseItems }
        let updates = Dictionary(baseItems.map { (Data($0.id.utf8), $0) }, uniquingKeysWith: { _, new in new })
        return context.map { updates[Data($0.id.utf8)] ?? $0 }
    }
    private var showingContext: Bool { focus.context != nil || notificationAnchor != nil }
    private var loaded: Bool { store.isDemo || (!store.isArchive && store.pagingSupport == .unsupported)
        || history?.initialized == true || showingContext }
    private var canPage: Bool {
        !store.isDemo && store.connectionStatus == .connected && !showingContext && !focus.loading
            && history?.hasOlder == true && history?.loading == nil && history?.isBridging == false
            && history?.storeChanged == false && !anchor.isPreservingPosition
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Gaps are per row (see `chatThreadRows`): 10 like the web .th-list, 16 where the speaker side changes,
                // 6 between my bubbles sent within two minutes. The padding sits outside each row's measured frame
                // and scroll id, so anchoring and restoring still land on the row itself.
                LazyVStack(alignment: .leading, spacing: 0) {
                    historyControls
                        .chatScrollRow(id: "history-top", coordinateSpace: scopeID)
                    if displayed.isEmpty && loaded {
                        ChatEmpty(title: "아직 대화가 없습니다", detail: emptyDetail)
                            .padding(.top, 10)
                    }
                    ForEach(chatThreadRows(displayed)) { row in
                        switch row {
                        case .day(_, let label, let gap): ChatDaySeparator(label: label).padding(.top, gap)
                        case .message(let message, let gap):
                            ChatMessageRow(message: message, isLatestProblem: scope.unresolvedIDs.contains(message.id), showsTarget: scope.isProjectThread)
                                .overlay {
                                    if anchor.highlightedMessageID?.utf8.elementsEqual(message.id.utf8) == true {
                                        RoundedRectangle(cornerRadius: CERadius.card).strokeBorder(CE.accent, lineWidth: 2)
                                            .allowsHitTesting(false)
                                    }
                                }
                                .chatScrollRow(id: row.id, coordinateSpace: scopeID)
                                .id(row.id)
                                .padding(.top, gap)
                        }
                    }
                }
                .background { ChatScrollHostProbe(anchor: anchor, scope: scopeID).frame(width: 0, height: 0) }
                // The one content column (880 with 24 gutters, so cards and bubbles line up with the docked composer)
                // and the web's 44pt bottom, which keeps the last line clear of the composer's fade.
                .ceContentColumn(top: 14)
                // The bottom marker is the true end of the content, so scrolling to it shows that bottom space too.
                Color.clear.frame(height: 1).id(Self.bottomID)
                    .chatScrollRow(id: "history-bottom", coordinateSpace: scopeID)
                    .accessibilityHidden(true)
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
                if !displayed.isEmpty && (!pinned || showingContext) { jumpButton(proxy) }
            }
            .overlay(alignment: .top) { focusNotice }
            .simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { _ in
                if !dragging { dragging = true; wasInteracting = false }
            }.onEnded { _ in dragging = false; wasInteracting = false })
            .onAppear { isVisible = true }
            .task(id: store.connectionStatus) {
                await store.activateHistory(ownerID: historyOwnerID, targetMemberID: targetMemberID)
            }
            .task(id: router.chatMessageID.map { Data($0.utf8) }) { await openMessage() }
            .onChange(of: focus.revision) { _, _ in showFocusedMessage(proxy) }
            .onDisappear {
                isVisible = false
                scrollRevision = UUID()
                savePosition()
                anchor.cancelPreservation()
                anchor.clearHighlight(); focus.clear()
                store.deactivateHistory(ownerID: historyOwnerID)
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
            .onReceive(NotificationCenter.default.publisher(for: ComposerAcceptedMessage.notification)) { note in
                guard let sent = note.object as? ComposerAcceptedMessage,
                      sent.namespace == store.writeNamespace, sent.projectID == store.selectedProjectID,
                      scope.isProjectThread || sent.targetMemberID == router.chatTarget else { return }
                followID = sent.messageID
                store.leaveNotificationAnchor(); router.chatMessageID = nil
                focus.clear(); displayed = baseItems
                jump(proxy)
            }
        }
    }

    /// Web .th-older: centred, gap 4, padding 4 0 12 (the 2 here + the first row's 10). Status lines are 13 like
    /// .th-older__error (errors in danger); paging is a ghost .gbtn--s, recovery actions a glass .gbtn--s.
    @ViewBuilder private var historyControls: some View {
        VStack(spacing: 4) {
            if store.isArchive { Tag("보관한 대화 · 읽기 전용", tone: .dim) }
            if let notice = router.navigationNotice { Text(notice).foregroundStyle(CE.attention) }
            if showingContext {
                Text("해당 글의 앞뒤를 보고 있습니다").foregroundStyle(CE.ink2)
                Button("최신 대화로") { returnToLatest() }
                    .ceSecondaryButton()
            } else if store.isDemo {
                Text("샘플 대화 · 읽기 전용").foregroundStyle(CE.ink3)
            } else if let notice = store.connectionNotice {
                Text(notice).foregroundStyle(CE.ink2)
            } else if store.showsOffline {
                Text("연결이 끊겼습니다. 다시 연결하면 이전 글을 불러올 수 있습니다").foregroundStyle(CE.attention)
            } else if history?.storeChanged == true {
                Text("서버의 대화 기록이 변경되었습니다").foregroundStyle(CE.attention)
                Button("최신 대화부터 다시 보기") {
                    anchor.cancelPreservation(); started = false; displayed = []; queued = nil
                    Task { await store.restartHistoryFromLatest() }
                }.ceSecondaryButton()
            } else if history?.isBridging == true {
                Text(history?.error == nil ? "새 대화를 이어 받는 중입니다" : "새 대화를 이어 받지 못했습니다")
                    .foregroundStyle(history?.error == nil ? CE.ink2 : CE.danger)
                if history?.loading != nil { ProgressView().controlSize(.small) }
                else {
                    Button(history?.error == nil ? "동기화 계속" : "다시 동기화") { Task { await store.continueHistoryBridge() } }
                        .ceSecondaryButton()
                }
            } else if store.pagingSupport == .unsupported && !store.isArchive {
                Text("이 서버는 최근 대화만 보여줍니다").foregroundStyle(CE.ink3)
            } else if !loaded {
                if history?.error != nil {
                    Text("대화를 불러오지 못했습니다").foregroundStyle(CE.danger)
                    Button("다시 불러오기") { Task { await store.refreshHistory() } }.ceSecondaryButton()
                } else { ProgressView("대화를 불러오는 중…").controlSize(.small) }
            } else if history?.loading?.kind == .older {
                ProgressView("이전 글을 불러오는 중…").controlSize(.small)
            } else if history?.error != nil {
                Text(lastLoad == .older ? "이전 글을 불러오지 못했습니다" : "새 대화를 불러오지 못했습니다").foregroundStyle(CE.danger)
                if lastLoad == .older {
                    Button("다시 불러오기") { loadOlder() }.ceGhostButton().disabled(!canPage)
                } else {
                    Button("다시 동기화") { Task { await store.refreshHistory() } }.ceSecondaryButton()
                        .disabled(history?.loading != nil)
                }
            } else if history?.hasOlder == true {
                Button("이전 글 불러오기") { loadOlder() }.ceGhostButton().disabled(!canPage)
                    .accessibilityHint("이전 글 100개를 불러옵니다")
            } else if !displayed.isEmpty {
                Text("대화의 처음입니다").foregroundStyle(CE.ink3)
            }
            if positionError {
                Text("읽던 위치를 확인하지 못했습니다. 이전 글은 잠시 뒤 다시 불러오세요.").foregroundStyle(CE.attention)
            }
        }
        .font(CEFont.secondary)
        .lineSpacing(CELeading.secondary)
        .multilineTextAlignment(.center)
        .controlSize(.small)
        .frame(maxWidth: .infinity)
        .padding(.top, 4).padding(.bottom, 2)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var focusNotice: some View {
        if focus.loading {
            ProgressView("해당 글을 찾는 중…").controlSize(.small)
                .padding(12).background(CE.plateSolid)
        } else if let error = focus.error {
            VStack(spacing: 4) {
                InlineNotice(tone: .attention, title: error, actionTitle: "다시 불러오기",
                             action: { Task { await openMessage() } })
                Button("최신 대화로") { returnToLatest() }.ceGhostButton()
            }
            .padding(12).background(CE.plateSolid)
        }
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

    private func openMessage() async {
        scrollRevision = UUID()
        guard let id = router.chatMessageID, let projectID else {
            focus.clear(); anchor.clearHighlight()
            presentReset()
            return
        }
        anchor.cancelPreservation(); anchor.clearHighlight()
        queued = nil; restoring = nil; reading = nil; followID = nil; positionError = false; pinned = false
        let key = ChatHistoryKey(namespace: namespace, connectionGeneration: history?.key.connectionGeneration ?? UUID(),
                                 projectID: projectID,
                                 scope: ChatHistoryKey.normalizedScope(targetMemberID: targetMemberID, members: store.members),
                                 archived: store.isArchive)
        let api = store.isDemo ? nil : store.api
        let navigationRevision = router.navigationRevision, projectRevision = router.projectResetRevision
        let destination = await focus.open(id, key: key, available: baseItems, members: store.members) {
            guard let api else { throw APIError(status: 404, message: "대화를 찾을 수 없습니다.") }
            return try await api.chatMessagesAround(projectID: projectID, messageID: id, archived: key.archived)
        }
        guard let destination, !Task.isCancelled, isVisible, store.api === api,
              store.selectedProjectID?.utf8.elementsEqual(projectID.utf8) == true, store.isArchive == key.archived,
              router.navigationRevision == navigationRevision, router.projectResetRevision == projectRevision,
              router.chatMessageID?.utf8.elementsEqual(id.utf8) == true,
              router.chatTarget.map({ Data($0.utf8) }) == targetMemberID.map({ Data($0.utf8) }) else { return }
        switch destination {
        case .member(let memberID): router.openChat(memberID)
        case .project: router.openChat(nil)
        case .unknown: return
        }
        router.chatMessageID = id
    }

    private func presentReset() {
        anchor.cancelPreservation(); queued = nil; restoring = nil; reading = nil; started = false
    }

    private func showFocusedMessage(_ proxy: ScrollViewProxy) {
        guard isVisible else { return }
        guard let id = focus.messageID else { present(items, proxy: proxy); return }
        guard router.chatMessageID?.utf8.elementsEqual(id.utf8) == true else { return }
        anchor.cancelPreservation(); queued = nil; reading = nil; positionError = false
        displayed = items; started = true; pinned = false
        let rowID = chatMessageRowID(id), revision = focus.revision
        restoring = ChatHistoryAnchor(messageID: rowID, offset: 0)
        Task { @MainActor in
            await Task.yield()
            guard isVisible, focus.revision == revision, focus.messageID?.utf8.elementsEqual(id.utf8) == true else { return }
            proxy.scrollTo(rowID, anchor: .top)
        }
    }

    private func present(_ incoming: [Message], proxy: ScrollViewProxy) {
        guard loaded else { return }
        guard !focus.loading else { return }
        // An explicit destination owns the first layout even when the normal history arrives first.
        if !started, router.chatMessageID != nil, focus.messageID == nil, focus.error == nil {
            displayed = incoming
            return
        }
        if !started {
            started = true; displayed = incoming
            if let id = notificationAnchor {
                pinned = false; restoring = ChatHistoryAnchor(messageID: chatMessageRowID(id), offset: 0)
            } else if let saved = history?.anchor, history?.pinnedToBottom == false {
                pinned = false; restoring = saved
            } else { pinned = true }
            let revision = scrollRevision
            Task { @MainActor in
                await Task.yield()
                guard isVisible, scrollRevision == revision else { return }
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
            let revision = scrollRevision
            Task { @MainActor in
                await Task.yield()
                if isVisible, scrollRevision == revision { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            }
        }
    }

    private func observe(_ frames: [String: CGRect], proxy: ScrollViewProxy) {
        guard started, viewportHeight > 0 else { return }
        if anchor.isInteracting && !wasInteracting { intentUsed = false }
        wasInteracting = anchor.isInteracting
        if let restoring {
            guard let frame = frames[restoring.messageID] else { return }
            if !anchor.isInteracting {
                anchor.adjustOffset(by: frame.minY - CGFloat(restoring.offset))
                self.restoring = nil
                if let id = focus.messageID, restoring.messageID == chatMessageRowID(id) {
                    anchor.highlight(messageID: id)
                }
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
        guard !showingContext, !focus.loading, history != nil, restoring == nil else { return }
        let value = reading.map { ChatHistoryAnchor(messageID: $0.messageID, offset: Double($0.top)) }
        if history?.anchor != value || history?.pinnedToBottom != pinned {
            store.setHistoryReadingPosition(value, pinned: pinned)
        }
    }

    private func jump(_ proxy: ScrollViewProxy) {
        scrollRevision = UUID()
        anchor.cancelPreservation(); restoring = nil; reading = nil; pinned = true
        anchor.clearHighlight()
        if router.chatMessageID != nil { router.chatMessageID = nil; focus.clear() }
        if let queued { displayed = queued; self.queued = nil }
        store.setHistoryReadingPosition(nil, pinned: true)
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
    }

    private func returnToLatest() {
        anchor.cancelPreservation(); queued = nil; restoring = nil; reading = nil
        anchor.clearHighlight(); focus.clear()
        store.leaveNotificationAnchor(); router.chatMessageID = nil
        store.setHistoryReadingPosition(nil, pinned: true)
        pinned = true; started = false
    }

    /// Web .th-down: a .gbtn--s (32, 13.5 / 600, padding 0 14), glass at rest and the violet primary when new posts
    /// arrived, sitting about 16 above the composer.
    @ViewBuilder private func jumpButton(_ proxy: ScrollViewProxy) -> some View {
        let count = history?.isBridging == true ? 0 : history?.unreadCount ?? 0
        let action = {
            if showingContext { returnToLatest() }
            jump(proxy)
        }
        let label = HStack(spacing: 6) {
            Image(systemName: "arrow.down").font(.system(size: 11, weight: .semibold))
            Text(count > 0 ? "새 글 \(count)개" : "맨 아래로").monospacedDigit()
        }
        Group {
            if count > 0 {
                Button(action: action) { label }.ceProminentButton()
            } else {
                Button(action: action) { label }.ceSecondaryButton()
            }
        }
        .controlSize(.small)
        .padding(.bottom, 16)
        .accessibilityLabel(count > 0 ? "새 글 \(count)개, 맨 아래로 이동" : "맨 아래로 이동")
    }
}

/// Compare all rendered fields, including delivery and attachment changes, without adding model-wide equality.
struct ChatThreadContent: Equatable {
    let items: [Message]
    static func == (lhs: Self, rhs: Self) -> Bool {
        guard lhs.items.count == rhs.items.count else { return false }
        return zip(lhs.items, rhs.items).allSatisfy { a, b in
            guard a.id.utf8.elementsEqual(b.id.utf8) && a.projectId == b.projectId && a.at == b.at && a.mine == b.mine
                && a.memberId == b.memberId && a.who == b.who && a.kind == b.kind && a.title == b.title
                && a.body == b.body && a.targetMemberId == b.targetMemberId && a.targetName == b.targetName
                && a.decisionId == b.decisionId && a.fileId == b.fileId && a.delivery == b.delivery && a.deliveryNote == b.deliveryNote else { return false }
            guard a.fileIds.map({ Data($0.utf8) }) == b.fileIds.map({ Data($0.utf8) })
                && a.supersedes.map({ Data($0.utf8) }) == b.supersedes.map({ Data($0.utf8) })
                && a.supersededBy.map({ Data($0.utf8) }) == b.supersededBy.map({ Data($0.utf8) })
                && a.deliveryInfo?.count == b.deliveryInfo?.count else { return false }
            guard zip(a.deliveryInfo ?? [], b.deliveryInfo ?? []).allSatisfy({ x, y in
                x.deliveryId == y.deliveryId && x.memberId == y.memberId && x.waitReason == y.waitReason
                    && x.waitingSince == y.waitingSince && x.runLimit?.used == y.runLimit?.used && x.runLimit?.limit == y.runLimit?.limit
            }) else { return false }
            return a.attachments.count == b.attachments.count && zip(a.attachments, b.attachments).allSatisfy { x, y in
                x.id == y.id && x.name == y.name && x.mime == y.mime && x.size == y.size
                    && x.url == y.url && x.path == y.path && x.isImage == y.isImage
            }
        }
    }
}

/// Web empty state (.empty): centred 16 / 600 title at −.01em and a 14 line at the body's 1.55, no icon.
private struct ChatEmpty: View {
    let title: String
    let detail: String
    var body: some View {
        VStack(spacing: 8) {
            Text(title).font(ChatFont.emptyTitle).tracking(-0.16).foregroundStyle(CE.ink)
                .multilineTextAlignment(.center)
            Text(detail).font(ChatFont.emptyBody).foregroundStyle(CE.ink2)
                .ceLineHeight(14, 1.55)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, CESpace.l).padding(.vertical, isMac ? 64 : 48)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// A thread row and the space above it.
private enum ChatThreadRow: Identifiable {
    case day(id: String, label: String, gap: CGFloat)
    case message(Message, gap: CGFloat)
    var id: String {
        switch self {
        case .day(let id, _, _): id
        case .message(let message, _): chatMessageRowID(message.id)
        }
    }
}

/// Which side of the thread a message sits on (my bubbles, report cards, centred system pills).
private enum ChatSide { case mine, report, system }
private func chatSide(_ message: Message) -> ChatSide {
    message.mine ? .mine : message.kind == "시스템" ? .system : .report
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
/// Spacing reads in turns: 10 between rows (web .th-list), 16 where the side changes (mine ↔ report ↔ system),
/// 6 between two of my bubbles sent less than two minutes apart; 20 above a day separator (10 for the first).
@MainActor private func chatThreadRows(_ messages: [Message]) -> [ChatThreadRow] {
    var rows: [ChatThreadRow] = []
    rows.reserveCapacity(messages.count + 4)
    var lastDay: String?
    var used = Set<String>()
    var previous: (side: ChatSide, date: Date?)?
    var afterDay = false
    let calendar = Calendar.current
    // 이어지는 글은 대개 같은 날이다. 날짜 구성요소 계산은 날이 바뀔 때만 한다.
    var lastDaySpan: DateInterval?
    for message in messages {
        let date = ChatDates.parse(message.at)
        if let date, let span = lastDaySpan, date >= span.start, date < span.end {
            // 직전 글과 같은 날: 구분선 없음.
        } else if let date {
            lastDaySpan = calendar.dateInterval(of: .day, for: date)
            let parts = calendar.dateComponents([.year, .month, .day], from: date)
            let day = "day:\(parts.year ?? 0)-\(parts.month ?? 0)-\(parts.day ?? 0)"
            if day != lastDay {
                let id = used.contains(day) ? "\(day)#\(rows.count)" : day
                used.insert(day)
                rows.append(.day(id: id, label: ChatDates.dayLabel(date), gap: rows.isEmpty ? 10 : 20))
                lastDay = day
                afterDay = true
            }
        }
        let side = chatSide(message)
        let gap: CGFloat
        if afterDay || previous == nil {
            gap = 10
        } else if let previous, previous.side != side {
            gap = 16
        } else if side == .mine, let before = previous?.date, let date, abs(date.timeIntervalSince(before)) < 120 {
            gap = 6
        } else {
            gap = 10
        }
        rows.append(.message(message, gap: gap))
        previous = (side, date)
        afterDay = false
    }
    return rows
}

@MainActor private enum ChatDates {
    // 대화 본문은 스크롤 프레임마다 다시 계산된다. 글마다 한 번만 파싱하도록 공용 캐시를 쓴다.
    static func parse(_ value: String) -> Date? { parseISODate(value) }
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

/// Wide (Mac; iPad is not supported): recipients column in the web sidebar-row style. Selection is the shared
/// composer target.
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
                    // Web .pj-heading: padding 14 12 6, 12 / 600 in ink-3.
                    Text("팀장")
                        .font(CEFont.caption.weight(.semibold)).foregroundStyle(CE.ink3)
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
        // Web .pj: min height 48, padding 7 12, radius 13, gap 10; name 14.5 / 600 at −.01em over a 12 sub-line, 1 apart.
        return Button { router.chatTarget = member?.id } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(member?.name ?? scope.threadTitle).font(CEFont.rowTitle).tracking(-0.15).foregroundStyle(CE.ink).lineLimit(1)
                        if draft { ChatDraftMark() }
                    }
                    subtitle(member, scope: scope)
                }
                Spacer(minLength: 4)
                if let problem { ChatProblemMark(kind: problem) }
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        }
        .buttonStyle(RowButtonStyle(selected: selected, radius: 13))
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
        if let shown = member ?? scope.lead {
            let info = MemberStatusInfo(shown)
            HStack(spacing: 5) {
                StatusDot(tone: info.tone, pulsing: info.live, size: 6)
                Text(member == nil ? "\(scope.leadTitle) · \(info.label)" : info.label)
                    .font(CEFont.caption).foregroundStyle(CE.ink2).lineLimit(1)
            }
        } else {
            Text("총괄이 아직 없습니다").font(CEFont.caption).foregroundStyle(CE.ink3).lineLimit(1)
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
                if let member = member ?? scope.lead {
                    let info = MemberStatusInfo(member)
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
        // 24 on Mac, the thread column's gutter, so the title lines up with the cards under it.
        .padding(.horizontal, isMac ? 24 : CESpace.l)
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .overlay(alignment: .bottom) { Rectangle().fill(CE.line).frame(height: 1) }
    }

    /// Web .shell__title: 17 / 650 at −.015em.
    private func title(_ text: String) -> some View {
        Text(text).font(CEFont.pageTitle).tracking(-0.25).foregroundStyle(CE.ink).lineLimit(1)
    }

    @ViewBuilder private func identity(_ scope: ChatScope) -> some View {
        if let member = scope.recipient {
            title(member.name)
                .help(member.role.isEmpty ? rankName(member.kind) : member.role)
            statusBadge(member)
            if member.queuedCount > 0 {
                Text("대기열 \(member.queuedCount)").font(CEFont.meta).foregroundStyle(CE.ink3).monospacedDigit().fixedSize()
                    .help("먼저 보낸 글 \(member.queuedCount)건이 차례를 기다립니다")
            }
        } else if scope.missingTarget {
            title("명부에 없는 대화 상대")
                .help("이 대상에게는 보낼 수 없습니다")
        } else {
            title(scope.threadTitle)
                .help("모든 보고와 지시")
            if let lead = scope.lead {
                Text(scope.leadTitle).font(CEFont.meta).foregroundStyle(CE.ink3).fixedSize()
                statusBadge(lead)
            }
        }
    }

    private func statusBadge(_ member: Member) -> some View {
        StatusBadge(member: member).help(MemberStatusInfo(member).explanation)
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
        ComposerBar(target: $router.chatTarget, showsTargetPicker: false, respondsToFocusRequests: router.destination == .chat)
            .padding(.horizontal, CESpace.m).padding(.top, 6).padding(.bottom, CESpace.s)
            .background { ComposerFloor() }
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

struct ChatDeliveryWait {
    let reason: String
    var since: String?
    var used: Int?
    var limit: Int?

    func label(now: Date = Date()) -> String? {
        waitReasonLabel(reason, since: since, used: used, limit: limit, now: now)
    }

    static func lines(_ message: Message, target: Member?) -> [Self] {
        // A later wake must not relabel an already sent/received or failed message as still waiting.
        guard message.mine, !["sent", "delivered", "failed"].contains(message.delivery ?? "") else { return [] }
        let pending = ["queued", "held", "delivering"].contains(message.delivery ?? "")
        var lines = (message.deliveryInfo ?? []).filter { info in
            target.map { $0.id.utf8.elementsEqual(info.memberId.utf8) } ?? true
        }.compactMap { info -> Self? in
            guard let reason = info.waitReason, !reason.isEmpty else { return nil }
            return Self(reason: reason, since: info.waitingSince, used: info.runLimit?.used, limit: info.runLimit?.limit)
        }
        if pending, let phase = target?.lifecycleState?.phase, ["starting", "starting_unknown", "reconnecting"].contains(phase),
           !lines.contains(where: { $0.reason == "waking" }) {
            lines.append(Self(reason: "waking"))
        }
        return lines
    }
}

func chatReportFileIDs(_ message: Message) -> [String] {
    var seen = Set<Data>()
    return (message.fileIds + (message.fileId.map { [$0] } ?? [])).filter {
        !$0.isEmpty && seen.insert(Data($0.utf8)).inserted
    }
}

func chatReportCorrections(_ message: Message) -> [(title: String, messageID: String)] {
    var links: [(title: String, messageID: String)] = []
    if let id = message.supersededBy, !id.isEmpty, !id.utf8.elementsEqual(message.id.utf8) {
        links.append(("정정됨 · 최신 보고 보기", id))
    }
    if let id = message.supersedes, !id.isEmpty, !id.utf8.elementsEqual(message.id.utf8) {
        links.append(("앞 보고 정정", id))
    }
    return links
}

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
        if MemberStatusInfo.isUncertain(member) {
            let info = MemberStatusInfo(member)
            return ChatNote(tone: info.tone, icon: info.icon, text: info.label,
                            actionTitle: wide ? nil : detailTitle, action: wide ? nil : { router.openMember(id) })
        }
        if MemberStatusInfo(member).tone == .approval {
            return ChatNote(tone: .approval, icon: "hand.raised.fill",
                            text: "승인 창 앞 · 처리할 때까지 보낸 글은 보류됩니다",
                            actionTitle: "터미널 열기", action: { router.openTerminal(id) })
        }
        if member.status == "error" {
            let error = member.lastError?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return ChatNote(tone: .danger, icon: "exclamationmark.triangle.fill",
                            text: error.isEmpty ? "오류 · 일을 시작하거나 이어 가다 실패했습니다" : "오류: \(friendlyError(error))",
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
            parts.append(MemberStatusInfo(member).label)
        } else if let lead {
            parts.append("\(rankName(lead.kind)) \(MemberStatusInfo(lead).label)")
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
                .lineSpacing(CELeading.meta)
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

/// Web .th-link: rounded chip with a chevron (13.5 / 600 at 1.35, padding 6 12 6 14, radius 12); the open-decision
/// chip is the violet one. 36 tall on Mac (the web chip step), 44 on iPhone.
private struct ChatJumpChip: View {
    let title: String
    var prominent = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title).lineLimit(2).ceLineHeight(13.5, 1.35)
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(CE.ink2)
            }
            .font(ChatFont.chip)
            .foregroundStyle(CE.ink)
            .padding(.leading, 14).padding(.trailing, 12).padding(.vertical, 6)
            .frame(minHeight: isMac ? 36 : 44)
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
    /// Web: white .07 → .13 on hover; the open one violet .34 → .48. 120ms linear.
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        let fill = prominent ? (pressed ? 0.54 : hovering ? 0.48 : 0.34) : (pressed ? 0.17 : hovering ? 0.13 : 0.07)
        label
            .contentShape(shape)
            .background(prominent ? CE.violet.opacity(fill) : Color.white.opacity(fill), in: shape)
            .overlay { shape.strokeBorder(prominent ? CE.violet.opacity(0.8) : Color.white.opacity(0.1)) }
            .animation(.linear(duration: 0.12), value: hovering)
            .onHover { hovering = $0 }
    }
}

/// Small text action in my bubble's footer ("터미널 열기", "팀원 보기"), same as "다시 보내기" (web .th-retry).
private struct ChatFooterLink: View {
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).underline()
                .font(ChatFont.footerAction)
                .foregroundStyle(CE.ink)
                .padding(.horizontal, 4)
                .frame(minHeight: isMac ? 24 : nil)
                .quietHitArea()
        }
        .buttonStyle(.plain)
        .fixedSize()
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

/// What a delivery label means, on tap (popover on every device) — never a standing line in the thread. A short
/// paragraph that is read, so 13 at 1.5 rather than a meta line.
private struct ChatDeliveryExplanation: View {
    let info: DeliveryInfo
    let note: String?
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(info.label).font(CEFont.rowTitle).foregroundStyle(color)
            if let note { Text(note).font(CEFont.secondary).foregroundStyle(CE.ink).ceLineHeight(13, 1.5) }
            if !info.explanation.isEmpty {
                Text(info.explanation).font(CEFont.secondary).foregroundStyle(CE.ink2).ceLineHeight(13, 1.5)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: 280, alignment: .leading)
        .padding(16)
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
/// Both read as the web .md in my bubble: 15 at 1.65 (Dynamic Type on iPhone, like MarkdownText).
private struct ChatBodyText: View {
    let text: String
    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 15
    var body: some View {
        if Self.isStructured(text) {
            MarkdownText(text: text).environment(\.markdownOnAccent, true)
        } else {
            Text(Self.inline(text))
                .font(.system(size: size))
                .lineSpacing(CELeading.spacing(size, 1.65))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .modifier(LocalFilePresentation())
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
    /// Inline markdown on the violet bubble: `code` sits on a dark chip (web .th-mine .md code rgb(9 7 19 / .35)),
    /// since the shared faint white chip disappears on violet.
    static func inline(_ value: String) -> AttributedString {
        var result = markdownInline(value)
        for run in result.runs where run.inlinePresentationIntent?.contains(.code) == true {
            result[run.range].backgroundColor = ChatPalette.bubbleCode
            if run.link == nil { result[run.range].foregroundColor = Color.white }
        }
        return result
    }
}

/// Web thread colours that are not foundation tokens.
private enum ChatPalette {
    /// .th-mine background rgb(72 50 176 / .9).
    static let bubble = Color(red: 72 / 255, green: 50 / 255, blue: 176 / 255).opacity(0.9)
    static let bubbleTo = Color(hex: 0xDAD2FF)
    static let bubbleLink = Color(hex: 0xE6DFFF)
    /// .th-mine .md code background rgb(9 7 19 / .35).
    static let bubbleCode = Color(red: 9 / 255, green: 7 / 255, blue: 19 / 255).opacity(0.35)
    /// .th-card background rgb(15 11 32 / .72): a dark plate, not glass (hundreds of rows scroll).
    static let cardFill = Color(red: 15 / 255, green: 11 / 255, blue: 32 / 255).opacity(0.72)
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
    static let chip: Font = .system(size: 13.5, weight: .semibold)
    static let bubbleTo: Font = .system(size: 12.5, weight: .semibold)
    static let emptyTitle: Font = .system(size: 16, weight: .semibold)
    static let emptyBody: Font = .system(size: 14)
    /// .th-retry 13 / 600.
    static let footerAction: Font = .system(size: 13, weight: .semibold)
    /// .atv-file 13.5, name 550.
    static let fileName: Font = .system(size: 13.5, weight: .medium)
    #else
    static let cardTitle: Font = .callout.weight(.semibold)
    static let who: Font = .footnote.weight(.semibold)
    static let chip: Font = .footnote.weight(.semibold)
    static let bubbleTo: Font = .caption.weight(.semibold)
    static let emptyTitle: Font = .callout.weight(.semibold)
    static let emptyBody: Font = .subheadline
    static let footerAction: Font = .footnote.weight(.semibold)
    static let fileName: Font = .footnote.weight(.medium)
    #endif
}

/// Web .th-card: radius 18, a dark plate rgb(15 11 32 / .72) with a 1pt white .08 ring and a half-point white .42
/// highlight along the top edge. No glass, rim gradient or blurred shadow: hundreds of these scroll.
/// Reduce Transparency: the solid plate.
private struct ChatCardSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.card, style: .continuous)
        if reduceTransparency {
            content.background(CE.plateSolid, in: shape).overlay { shape.strokeBorder(CE.lineStrong) }
        } else {
            content
                .background(ChatPalette.cardFill, in: shape)
                .overlay {
                    ZStack {
                        shape.strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
                        shape.strokeBorder(Color.white.opacity(0.42), lineWidth: 0.5)
                            .mask(alignment: .top) {
                                LinearGradient(colors: [.white, .white.opacity(0)], startPoint: .top, endPoint: .bottom).frame(height: 8)
                            }
                    }
                    .allowsHitTesting(false)
                }
        }
    }
}

private extension View {
    /// Mac: right-click a bubble or card to copy its text without drag-selecting a long report; the full date is
    /// the last (inert) line. iPhone keeps the text's own long-press selection.
    @ViewBuilder func chatMessageMenu(_ message: Message) -> some View {
        #if os(macOS)
        self.contextMenu {
            if !message.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button("본문 복사") { chatCopy(message.body) }
            }
            if !message.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button("제목 복사") { chatCopy(message.title) }
            }
            if let date = parseISODate(message.at) {
                Divider()
                Text(koDateTime(date))
            }
        }
        #else
        self
        #endif
    }
}

@MainActor private func chatCopy(_ text: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}

// MARK: - Attachments (web .atv)

/// Web .atv: 208×148 image thumbnails and file chips in one wrapping row, 8 apart. A fixed thumbnail size, so nothing
/// below moves while an image loads. `onBubble` keeps the chip text readable on my violet bubble.
private struct ChatAttachments: View {
    let items: [Attachment]
    var onBubble = false
    var body: some View {
        TeamWrapLayout(spacing: 8, lineSpacing: 8) {
            ForEach(items) { ChatAttachmentItem(attachment: $0, onBubble: onBubble) }
        }
    }
}

/// One attachment. Loads only through the connected daemon (the API client sends the access code); opens in Quick
/// Look. The name is the tooltip and the accessibility label; share and 텍스트 보기 are in the context menu.
private struct ChatAttachmentItem: View {
    @Environment(AppStore.self) private var store
    let attachment: Attachment
    var onBubble = false
    @State private var data: Data?
    @State private var fileURL: URL?
    /// 받아 둔 원본. 공용 캐시가 같은 첨부를 다시 내려받지 않게 하고, 놓으면 임시 파일도 지워진다.
    @State private var resource: FileResource?
    @State private var image: Image?
    @State private var loading = false
    @State private var error: String?
    @State private var showText = false
    @State private var quickLook: URL?
    @State private var hovering = false

    private static let thumbSize = CGSize(width: 208, height: 148)
    private var displayName: String { attachment.name.isEmpty ? "이름 없는 첨부" : attachment.name }
    private var isTextual: Bool { attachment.mime.hasPrefix("text/") || attachment.mime.contains("json") }
    private var sizeText: String { chatFileSize(attachment.size) }

    var body: some View {
        Group {
            if attachment.isImage { thumbnail } else { fileChip }
        }
        .quickLookPreview($quickLook)
        .task(id: attachment.id) { if attachment.isImage { await load() } }
    }

    // MARK: Image (web .atv-thumb)

    private var thumbnail: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return Button {
            if let fileURL { quickLook = fileURL } else { Task { await load() } }
        } label: {
            ZStack {
                CE.bgDeep.opacity(0.5)
                if let image {
                    image.resizable().scaledToFill()
                        .frame(width: Self.thumbSize.width, height: Self.thumbSize.height)
                        .clipped()
                } else if loading {
                    ProgressView().controlSize(.small)
                } else if let error {
                    VStack(spacing: 4) {
                        Image(systemName: "photo").foregroundStyle(CE.ink3)
                        Text(error).font(CEFont.caption).foregroundStyle(CE.ink2)
                            .multilineTextAlignment(.center).lineLimit(3).lineSpacing(2)
                        if store.api != nil {
                            Text("눌러서 다시 불러오기").font(CEFont.caption.weight(.semibold)).foregroundStyle(CE.ink)
                        }
                    }
                    .padding(10)
                } else if resource != nil {
                    VStack(spacing: 4) {
                        Image(systemName: "photo").foregroundStyle(CE.ink3)
                        Text("여기서 그릴 수 없는 형식 · 눌러서 열기").font(CEFont.caption).foregroundStyle(CE.ink2)
                            .multilineTextAlignment(.center).lineSpacing(2)
                    }
                    .padding(10)
                }
            }
            .frame(width: Self.thumbSize.width, height: Self.thumbSize.height)
            .clipShape(shape)
            .overlay { shape.strokeBorder(Color.white.opacity(hovering ? 0.28 : 0.1), lineWidth: 1) }
            .contentShape(shape)
            .animation(.linear(duration: 0.12), value: hovering)
        }
        .buttonStyle(.plain)
        .disabled(loading)
        .onHover { hovering = $0 }
        .help(fileURL == nil ? displayName : "\(displayName) · 크게 보기")
        .accessibilityLabel(fileURL == nil ? "\(displayName) 불러오기" : "\(displayName) 크게 보기")
        .contextMenu {
            if let fileURL {
                Button("크게 보기") { quickLook = fileURL }
                ShareLink("공유·저장", item: fileURL)
            }
        }
    }

    // MARK: Other files (web .atv-file)

    /// 13.5 at 1.35, padding 6 14, radius 12, white .07 (hover .13) with a white .1 ring; name 550, size 12.5 ink-2.
    private var fileChip: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return VStack(alignment: .leading, spacing: 6) {
            Button { openFile() } label: {
                HStack(spacing: 10) {
                    Group {
                        if loading { ProgressView().controlSize(.mini) }
                        else { Image(systemName: fileKindIcon(chatAttachmentKind(attachment))).font(.system(size: 13)) }
                    }
                    .foregroundStyle(onBubble ? ChatPalette.bubbleTo : CE.ink2)
                    .frame(width: 16)
                    Text(displayName).font(ChatFont.fileName)
                        .foregroundStyle(onBubble ? Color.white : CE.ink)
                        .lineLimit(1).truncationMode(.middle)
                    Text(sizeText).font(CEFont.meta).monospacedDigit()
                        .foregroundStyle(onBubble ? ChatPalette.bubbleTo : CE.ink2)
                        .fixedSize()
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
                .frame(minHeight: isMac ? 36 : 44)
                .background(Color.white.opacity(hovering ? 0.13 : 0.07), in: shape)
                .overlay { shape.strokeBorder(Color.white.opacity(0.1), lineWidth: 1) }
                .contentShape(shape)
                .animation(.linear(duration: 0.12), value: hovering)
            }
            .buttonStyle(.plain)
            .disabled(loading)
            .onHover { hovering = $0 }
            .help("\(displayName) · 원본을 받아 미리 봅니다")
            .accessibilityLabel("\(displayName) 열기")
            .accessibilityValue(sizeText)
            .contextMenu {
                Button("열기") { openFile() }
                if isTextual {
                    Button(showText ? "텍스트 접기" : "텍스트 보기") {
                        if data == nil { Task { await load(); showText = data != nil } } else { showText.toggle() }
                    }
                }
                if let fileURL { ShareLink("공유·저장", item: fileURL) }
            }
            if showText, let data, let content = String(data: data, encoding: .utf8) {
                Text(String(content.prefix(100_000)))
                    .font(CEFont.mono).foregroundStyle(onBubble ? Color.white : CE.ink2)
                    .lineSpacing(CELeading.spacing(12.5, 1.55))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(onBubble ? ChatPalette.bubbleCode : CE.bgDeep.opacity(0.5),
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            if let error {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(CEFont.caption).foregroundStyle(onBubble ? ChatPalette.bubbleTo : CE.attention)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 320, alignment: .leading)
            }
        }
    }

    private func openFile() {
        if let fileURL { quickLook = fileURL; return }
        Task {
            await load()
            if let fileURL { quickLook = fileURL }
        }
    }

    // MARK: Loading (authenticated, same origin only)

    private func load() async {
        guard resource == nil, !loading else { return }
        guard let api = store.api else {
            error = store.isDemo ? "샘플에는 원본 파일이 없습니다." : "서버 연결 후 원본을 불러올 수 있습니다."
            return
        }
        loading = true; defer { loading = false }
        do {
            // 행이 다시 만들어질 때마다 원본을 새로 받아 새 임시 폴더에 쌓지 않도록, 한도가 있는 공용 캐시를 쓴다.
            let loaded = try await FileResources.attachment(attachment, api: api)
            // A thumbnail only needs ~2× its 208×148 box: decode small (off the main thread) so a thread of screenshots stays light.
            if attachment.isImage { image = await PreviewImages.image(loaded, maxPixel: 720).map { Image(decorative: $0, scale: 1) } }
            // 원본 바이트는 글자로 펼쳐 볼 파일만 쥔다. 그림은 캐시의 파일과 축소본만 쓴다.
            if isTextual { data = try loaded.read() }
            resource = loaded; fileURL = loaded.url; error = nil
        } catch { self.error = friendlyLoadError(error, what: "첨부", verb: "받지") }
    }
}

/// The server's file kind for an attachment's icon (images are drawn as thumbnails, so never asked here).
private func chatAttachmentKind(_ attachment: Attachment) -> String {
    let ext = (attachment.name as NSString).pathExtension.lowercased()
    let mime = attachment.mime.lowercased()
    if ["md", "markdown"].contains(ext) { return "document" }
    if ["html", "htm"].contains(ext) || mime == "text/html" { return "artifact" }
    if ext == "pdf" || mime == "application/pdf" { return "pdf" }
    if ["csv", "tsv"].contains(ext) || mime == "text/csv" || mime == "text/tab-separated-values" { return "table" }
    if ["mp4", "mov", "webm", "m4v", "mkv", "avi"].contains(ext) || mime.hasPrefix("video/") { return "video" }
    if ["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"].contains(ext) || mime.hasPrefix("audio/") { return "audio" }
    if mime.hasPrefix("text/") || mime.contains("json") { return "code" }
    return "file"
}

/// Web formatBytes: "512 B", "48 KB", "2.3 MB".
private func chatFileSize(_ size: Int) -> String {
    if size < 1024 { return "\(size) B" }
    if size < 1024 * 1024 { return "\(Int((Double(size) / 1024).rounded())) KB" }
    return String(format: "%.1f MB", Double(size) / (1024 * 1024))
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
