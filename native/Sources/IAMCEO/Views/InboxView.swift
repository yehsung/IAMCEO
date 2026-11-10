import SwiftUI
import ImageIO
import QuickLook
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// 결재함: "결재할 항목" and "결재된 항목".
// Picking an option never sends; the card's confirm bar does, carrying the reviewed version (`expectedVersion`).
// Cards answered during this visit stay in place as compact answered cards ("보냄 → 받음") until the person
// switches segment. Review drafts survive navigation. CLI approval windows (blocked members) are listed separately: they are
// terminal actions, not decisions, and answering a decision never means a todo was done.
// Look: the web inbox (glass segment pill, tinted glass cards, violet group frame, violet option tiles), kept compact.

enum InboxSegment: Hashable { case open, done }

/// Why answers are locked. All are global states, explained once rather than on every card.
private enum AnswerLock { case demo, disconnected, runner }

/// A request to scroll a card's confirm bar into view; the nonce makes a repeat request for the same bar fire again.
private struct RevealRequest: Equatable {
    let target: String
    let nonce = UUID()
}

private func confirmBarID(_ decisionID: String) -> String { "confirm-\(decisionID)" }

/// One row of the open list: a single card, or a group placed at the position of its newest card.
private struct InboxBlock: Identifiable {
    let id: String
    let group: String?
    let decisions: [Decision]
}

extension InboxReviewState {
    /// 방문이 끝날 때 부른다. 여기서 답한 카드, 손댔지만 다른 곳에서 이미 처리된 카드, 목록에서 사라진 카드를
    /// '결재할 항목'에서 치운다. 그러지 않으면 탭을 계속 올려 두는 Mac에서는 이런 카드가 하루 종일 쌓이고 치울 방법이 없다.
    /// 열린 카드의 선택·메모·펼침과 보내는 중인 카드는 건드리지 않는다. 메모 초안은 DraftStore에 남는다.
    /// `decisions`가 nil이면(아직 상태를 받지 못함) 여기서 답한 카드만 치운다.
    func settleVisit(decisions: [Decision]?) {
        var settled = answeredHere
        if let decisions {
            let status = Dictionary(decisions.map { ($0.id, $0.status) }, uniquingKeysWith: { first, _ in first })
            for id in engaged where !inFlight.contains(id) && status[id] != "open" { settled.insert(id) }
        }
        engaged.subtract(settled)
        memoOnly.subtract(settled)
        for id in settled { cardErrors[id] = nil }
        answeredHere = []; batchArmed = [:]
    }
}

struct InboxView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(DraftStore.self) private var drafts
    @Environment(\.ceWide) private var wide

    private var session: InboxReviewState { router.inboxReview }
    @State private var scrollViewport: CGFloat = 0
    @State private var restoringScroll = false
    @State private var scrollRestoreID = UUID()
    @State private var shiftedAt = Date.distantPast
    @State private var flashID: String?
    // Done view.
    @State private var olderDone: [Decision] = []
    /// Paging cursor for "더 불러오기": set only from loaded pages, never from deep-linked single fetches,
    /// so a deep link to an old decision cannot make the next page skip the decisions in between.
    @State private var olderCursor: String?
    @State private var olderExhausted = false
    @State private var loadingOlder = false
    @State private var olderError: String?
    @State private var reopening: Set<String> = []
    @State private var reopenErrors: [String: String] = [:]
    @State private var reopenedNotice: Decision?
    // Deep links and small affordances.
    @State private var linkMissing = false
    @State private var resolvingLink: String?
    @State private var copiedMember: String?
    /// Brings a card's confirm bar into view after it appears (it is added at the card's bottom,
    /// which on iPhone can sit under the tab bar or the keyboard).
    @State private var revealRequest: RevealRequest?

    var body: some View {
        // 'n시간째 기다림' 표시와 오래된 결재 우선 정렬이 조용한 화면에서도 맞도록 1분마다 다시 그린다.
        let _ = MinuteClock.shared.minute
        ScrollViewReader { proxy in
            ScrollView {
                // Web .ibx: 22 between the pill and each section; cards inside a section are 10 apart.
                VStack(alignment: .leading, spacing: 22) {
                    // The segment pill scrolls with the list: nested top bars would overlap the shell's status strips.
                    InboxSegmentBar(segment: Binding(get: { session.segment }, set: { session.segment = $0 }), openCount: openDecisions.count, doneCount: doneCount, stretch: !wide)
                    content
                }
                .ceContentColumn()
            }
            .coordinateSpace(name: "inbox-scroll")
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { scrollViewport = $0 }
            .onPreferenceChange(InboxCardFrames.self) { frames in rememberScroll(frames) }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await store.refresh() }
            .onAppear { sync(); restoreScroll(proxy); handleLink(proxy) }
            .onDisappear {
                router.inlineFieldFocused = false; scrollRestoreID = UUID()
                // iPhone: 다른 탭으로 갔을 때만(같은 탭 안에서 자료·팀원을 연 것은 제외).
                if router.destination != .inbox { settleVisit() }
            }
            .onChange(of: router.decisionID) { _, _ in handleLink(proxy) }
            .onChange(of: versionSignature) { _, _ in
                sync()
                if router.decisionID != nil { handleLink(proxy) }
            }
            .onChange(of: olderDone.count) { _, _ in if router.decisionID != nil { handleLink(proxy) } }
            .onChange(of: session.segment) { _, _ in settleVisit() }
            // Mac은 탭을 계속 올려 두어 onDisappear가 오지 않는다. 결재함을 떠나면 방문이 끝난 것으로 본다.
            // 자료 열람(결재 카드의 파일을 보고 돌아오는 길)은 방문을 끝내지 않는다.
            .onChange(of: router.destination) { old, new in
                if old == .inbox, new != .inbox, new != .files { settleVisit() }
            }
            .onChange(of: store.selectedProjectID) { _, _ in resetProject() }
            .onChange(of: drafts.namespace) { _, _ in resetProject() }
            .onChange(of: displayedIDs) { _, _ in shiftedAt = Date() }
            .onChange(of: revealRequest) { _, request in
                guard let request else { return }
                scrollRestoreID = UUID(); restoringScroll = false
                Task { @MainActor in
                    // Wait for the bar's layout, then scroll only as far as needed (nil anchor): no jump when it is already visible.
                    try? await Task.sleep(for: .milliseconds(80))
                    withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(request.target) }
                }
            }
        }
    }

    private func rememberScroll(_ frames: [String: CGRect]) {
        guard !restoringScroll, router.destination == .inbox,
              (router.phonePaths[.inbox] ?? []).isEmpty, scrollViewport > 0 else { return }
        guard let first = frames.filter({ $0.value.maxY > 0 && $0.value.minY < scrollViewport })
            .min(by: { $0.value.minY < $1.value.minY }) else { return }
        session.scrollID = first.key
        session.scrollLocations[first.key] = InboxScrollLocation(top: first.value.minY, height: first.value.height)
    }

    private func restoreScroll(_ proxy: ScrollViewProxy) {
        let token = UUID(); scrollRestoreID = token
        guard router.decisionID == nil, let id = session.scrollID, let location = session.scrollLocations[id] else {
            restoringScroll = false; return
        }
        restoringScroll = true
        let context = session.contextID
        Task { @MainActor in
            // Allow the restored cards and expanded details to lay out before aligning the saved point.
            try? await Task.sleep(for: .milliseconds(100))
            guard scrollRestoreID == token, session.contextID == context else { return }
            proxy.scrollTo(InboxCardGeometry.locationID(id), anchor: location.anchor(viewport: scrollViewport))
            try? await Task.sleep(for: .milliseconds(80))
            if scrollRestoreID == token { restoringScroll = false }
        }
    }

    // MARK: - Derived state

    private var openDecisions: [Decision] { store.decisions.filter { $0.status == "open" } }
    private var blocked: [Member] { InboxHomePolicy.approvals(store.members) }
    private var uncertainMembers: [Member] { store.members.filter { MemberStatusInfo.isUncertain($0) && !MemberStatusInfo.isNetworkPause($0.statusObservation?.error?.code) } }
    private var gateOpen: Bool { store.canWrite && store.state?.project.connection.ok == true }
    /// Why answers are impossible right now (nil = open). Every reason is global, so it is explained once:
    /// demo and disconnection by the pinned StatusStrips, plus one notice above the list (disconnected / runner).
    private var answerLock: AnswerLock? {
        if store.isDemo { return .demo }
        if store.showsOffline { return .disconnected }
        if store.state?.project.connection.ok != true { return .runner }
        return nil
    }
    /// Fallback for the per-card lock explanation. Draft fields remain available while disconnected.
    private var lockHint: String? {
        if let notice = store.connectionNotice { return notice }
        guard let answerLock, answerLock != .demo else { return nil }
        return "연결 문제로 지금은 답할 수 없습니다"
    }
    private var versionSignature: String {
        store.decisions.map { "\($0.id)@\($0.updatedAt)" }.joined(separator: "|") + "#\(store.selectedProjectID ?? "")"
    }
    private func latest(_ id: String) -> Decision? { store.decisions.first { $0.id == id } }
    private func asker(_ decision: Decision) -> Member? { decision.memberId.flatMap { id in store.members.first { $0.id == id } } }

    /// Open cards plus the cards this visit must keep in place (answered here, being sent, or being worked on).
    private var liveDecisions: [Decision] {
        var result: [Decision] = []
        var seen = Set<String>()
        for decision in store.decisions where decision.status == "open" || session.inFlight.contains(decision.id) || session.answeredHere.contains(decision.id) || session.engaged.contains(decision.id) {
            result.append(decision); seen.insert(decision.id)
        }
        // A card someone was working on that vanished from the payload keeps its reviewed snapshot.
        for id in session.engaged.sorted() where !seen.contains(id) {
            if let snapshot = session.reviews[id]?.decision { result.append(snapshot) }
        }
        return UsageLimitInfo.prioritized(InboxHomePolicy.prioritized(result, members: store.members, notices: store.deliveryNotices))
    }

    private var blocks: [InboxBlock] {
        let live = liveDecisions
        var placed = Set<String>()
        var out: [InboxBlock] = []
        for decision in live {
            if let group = decision.group, !group.isEmpty, decision.kind != "usage_limit" {
                guard !placed.contains(group) else { continue }
                placed.insert(group)
                // Keep the same waiting/blocking priority inside a group as between groups.
                out.append(InboxBlock(id: "group:\(group)", group: group, decisions: live.filter { $0.group == group && $0.kind != "usage_limit" }))
            } else {
                out.append(InboxBlock(id: decision.id, group: nil, decisions: [decision]))
            }
        }
        return out
    }
    private var displayedIDs: [String] { blocks.flatMap { $0.decisions.map(\.id) } }

    private var doneList: [Decision] {
        let loaded = store.decisions.filter { $0.status != "open" }
        let known = Set(store.decisions.map(\.id))
        let older = olderDone.filter { !known.contains($0.id) }
        return (loaded + older).sorted { doneKey($0) > doneKey($1) }
    }
    private func doneKey(_ decision: Decision) -> String { decision.answeredAt ?? decision.closedAt ?? decision.createdAt }
    private var doneCount: Int { max(store.state?.doneDecisionCount ?? 0, doneList.count) }

    // MARK: - Layout

    @ViewBuilder private var content: some View {
        if store.state == nil {
            if store.isLoading {
                EmptyTile(loading: true, title: "결재를 불러오는 중입니다")
            } else {
                emptyCard(icon: "tray", title: "열린 프로젝트가 없습니다", detail: isMac ? "사이드바에서 프로젝트를 고르거나 새로 만드세요." : "위 제목을 눌러 프로젝트를 고르거나 새로 만드세요.")
            }
        } else if session.segment == .open {
            openView
        } else {
            doneView
        }
    }

    // MARK: Open view

    private var openView: some View {
        let blocks = self.blocks
        return VStack(alignment: .leading, spacing: 22) {
            if hasOpenNotices {
                VStack(alignment: .leading, spacing: 10) {
                    connectionNotice
                    disconnectedNotice
                    if linkMissing { missingLinkNotice }
                    if !uncertainMembers.isEmpty {
                        InlineNotice(tone: .neutral, icon: "questionmark.circle", title: "상태 확인 불가 \(uncertainMembers.count)명",
                                     detail: "승인 창이 확인되지 않았습니다. 팀 화면에서 상태 근거를 볼 수 있습니다.",
                                     actionTitle: "팀 화면으로", action: { router.go(.team) })
                    }
                }
            }
            if blocks.contains(where: { $0.decisions.first?.kind == "usage_limit" }) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(blocks.filter { $0.decisions.first?.kind == "usage_limit" }) { block in
                        blockView(block).id(block.id)
                    }
                }
            }
            if !blocked.isEmpty { approvalSection }
            if blocks.isEmpty && blocked.isEmpty {
                emptyCard(title: "결재할 항목이 없습니다", detail: emptyDetail)
            }
            if blocks.contains(where: { $0.decisions.first?.kind != "usage_limit" }) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(blocks.filter { $0.decisions.first?.kind != "usage_limit" }) { block in blockView(block).id(block.id) }
                }
            }
        }
    }

    /// Notices above the open list, grouped so the section rhythm (22) does not open up between them.
    private var hasOpenNotices: Bool {
        let runnerDown = !store.isDemo && store.connectionStatus == .connected && store.state?.project.connection.ok == false
        return runnerDown || (answerLock == .disconnected && !openDecisions.isEmpty) || linkMissing || !uncertainMembers.isEmpty
    }

    /// Web .ibx-empty: the empty message on the same glass card as the list (title 16, body 14, 44 above and below).
    private func emptyCard(icon: String? = nil, title: String, detail: String) -> some View {
        Plate(padding: 0) {
            EmptyTile(icon: icon, title: title, detail: detail, framed: false)
                .padding(.vertical, isMac ? 4 : 12)
        }
    }

    private var emptyDetail: String {
        guard store.members.contains(where: { $0.status == "working" }) else { return "새 결재가 오면 여기에 나타납니다." }
        return store.state?.project.isHq == true ? "본사 AI가 일하는 중입니다. 대화에서 상황을 볼 수 있습니다." : "직원들이 일하는 중입니다. 대화나 팀에서 상황을 볼 수 있습니다."
    }

    @ViewBuilder private var connectionNotice: some View {
        if !store.isDemo, store.connectionStatus == .connected, let connection = store.state?.project.connection, !connection.ok {
            InlineNotice(tone: .attention, icon: "bolt.horizontal.circle", title: "지금은 결재에 답할 수 없습니다",
                         detail: connection.ownerDetail ?? "이 프로젝트의 실행 연결에 문제가 있습니다. 연결되면 답할 수 있습니다.",
                         actionTitle: connection.reason == "runner_off" ? "팀 화면으로" : nil,
                         action: connection.reason == "runner_off" ? { router.go(.team) } : nil)
        }
    }

    /// Once above the list (the pinned strip says the link dropped; this says what happens to the CEO's memos).
    @ViewBuilder private var disconnectedNotice: some View {
        if answerLock == .disconnected, !store.isRestarting, !openDecisions.isEmpty {
            InlineNotice(tone: .attention, icon: "wifi.slash", title: "지금은 결재에 답할 수 없습니다",
                         detail: "쓰던 메모는 이 기기에 남아 있고, 다시 연결되면 보낼 수 있습니다.")
        }
    }

    private var missingLinkNotice: some View {
        InlineNotice(tone: .neutral, icon: "questionmark.circle", title: "찾을 수 없는 결재입니다",
                     detail: "지워졌거나 다른 프로젝트의 결재일 수 있습니다.", actionTitle: "닫기", action: { linkMissing = false })
    }

    // MARK: Approval windows (CLI menus, not decisions)

    /// Web BlockedList: a "승인 대기 n" heading above the cards, then one approval card per stopped session.
    private var approvalSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("승인 대기").font(CEFont.section).tracking(-0.14).foregroundStyle(CE.ink)
                InboxCount(count: blocked.count)
            }
            .padding(.horizontal, 4)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            ForEach(blocked) { member in approvalCard(member) }
        }
    }

    /// Web .ibx-card.ibx-approval: the member row, then the approval window (or how to answer it in the terminal).
    private func approvalCard(_ member: Member) -> some View {
        Plate(padding: 0) {
            VStack(alignment: .leading, spacing: 12) {
                approvalHeader(member)
                CLIApprovalCard(member: member, fallback: "여기서 답할 수 없는 창입니다. 화면을 보고 터미널에서 승인하거나 거절하세요.")
            }
            .padding(.vertical, 16).padding(.horizontal, wide ? 18 : 14)
        }
        .overlay { RoundedRectangle(cornerRadius: CERadius.plate, style: .continuous).strokeBorder(CE.approval.opacity(0.28)) }
    }

    private func approvalHeader(_ member: Member) -> some View {
        let command = TerminalCommand.attach(memberID: member.id, bootstrap: store.bootstrap)
        let copied = copiedMember == member.id
        let now = plainOneLine(member.now)
        let readable = member.canReadCLIApproval
        return HStack(spacing: 6) {
            Button { router.openMember(member.id) } label: {
                HStack(spacing: 10) {
                    StatusDot(tone: .approval)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Text(member.name).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                            Text("승인 창 앞").font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.approval).lineLimit(1).fixedSize()
                        }
                        if !now.isEmpty { Text(now).font(CEFont.meta).foregroundStyle(CE.ink2).lineLimit(1) }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, 10).padding(.trailing, 6).padding(.vertical, 6)
                .frame(minHeight: isMac ? 44 : 52)
            }
            .buttonStyle(RowButtonStyle(radius: CERadius.control))
            .help(MemberStatusInfo(member).explanation)
            .accessibilityLabel("\(member.name), 승인 창 앞" + (now.isEmpty ? "" : ", \(now)"))
            .accessibilityHint("팀원 상세를 엽니다")
            Button { copyCommand(command, member: member.id) } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(copied ? CE.success : CE.ink2)
                    .frame(width: isMac ? 32 : 40, height: isMac ? 32 : 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("터미널 연결 명령 복사 · \(command)")
            .accessibilityLabel(copied ? "터미널 연결 명령 복사함" : "터미널 연결 명령 복사")
            // One filled button per card: when the window can be answered here, its confirm is the primary action.
            Group {
                if readable {
                    Button("터미널 열기") { router.openTerminal(member.id) }.ceSecondaryButton()
                } else {
                    Button("터미널 열기") { router.openTerminal(member.id) }.ceProminentButton()
                }
            }
            .ceCompactControl()
            .help(readable ? "CLI 화면을 터미널에서 직접 봅니다" : "여기서 답할 수 없는 창입니다. 화면을 보고 승인하거나 거절하세요.")
        }
        // Web .ibx-blocked__row: the row's hover fill bleeds 10 to the left and 6 above, so its text lines up with the card.
        .padding(.leading, -10).padding(.top, -6)
    }

    // MARK: Cards and groups

    @ViewBuilder private func blockView(_ block: InboxBlock) -> some View {
        if let group = block.group {
            groupView(group, cards: block.decisions)
        } else if let decision = block.decisions.first {
            cardView(decision)
        }
    }

    private func groupView(_ group: String, cards: [Decision]) -> some View {
        let single = cards.count < 2
        let targets = batchTargets(cards)
        let openInGroup = cards.filter { latest($0.id)?.status == "open" }.count
        let skipped = openInGroup - targets.count
        let busy = session.batchBusy.contains(group)
        let armed = !single && (busy || session.batchArmed[group] == targets.map(\.id)) && !(session.batchArmed[group] ?? []).isEmpty
        return GroupFrame(single: single, wide: wide) {
            if !single {
                VStack(alignment: .leading, spacing: 10) {
                    // Web .ibx-group__head: padding 2 4 2 8; name 14.5/650 at 1.35, the sub-line 12.5 ink-2.
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(alignment: .firstTextBaseline, spacing: 5) {
                                Text(group).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                                Text("· \(cards.count)건").font(CEFont.meta).foregroundStyle(CE.ink2).monospacedDigit().fixedSize()
                            }
                            if skipped > 0 && !targets.isEmpty {
                                Text("권장이 없거나 직접 고른 \(skipped)건은 따로 결정해 주세요")
                                    .font(CEFont.meta).foregroundStyle(CE.ink2).lineSpacing(CELeading.meta)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(.isHeader)
                        Spacer(minLength: 6)
                        if !targets.isEmpty && !armed {
                            Button("이 묶음 추천대로") { session.batchArmed[group] = targets.map(\.id); session.batchErrors[group] = nil }
                                .ceSecondaryButton().controlSize(.regular).fixedSize()
                                .disabled(!gateOpen || busy)
                        }
                    }
                    .padding(.leading, 8).padding(.trailing, 4).padding(.vertical, 2)
                    if armed {
                        // While sending, the armed cards are in flight and no longer targets; keep showing what was confirmed.
                        let armedIDs = session.batchArmed[group] ?? []
                        ConfirmBar(quoted: nil, verb: "묶음 \(armedIDs.count)건 결정", hint: "각 카드의 권장안으로 결정합니다", busy: busy,
                                   disabled: !gateOpen, stretch: !wide, shiftedAt: shiftedAt,
                                   onConfirm: { Task { await runBatch(group, ids: armedIDs) } },
                                   onCancel: { session.batchArmed[group] = nil })
                            .padding(.leading, 8).padding(.trailing, 4).padding(.bottom, 2)
                            .transition(.opacity)
                    }
                    if let error = session.batchErrors[group] { ErrorLine(text: error).padding(.leading, 8).padding(.trailing, 4) }
                }
                .animation(.easeOut(duration: 0.18), value: armed)
            }
        } content: {
            ForEach(cards) { decision in cardView(decision) }
        }
    }

    @ViewBuilder private func cardView(_ shown: Decision) -> some View {
        let id = shown.id
        let current = latest(id)
        if let current, current.status != "open", !session.inFlight.contains(id) {
            // Web .ibx-card--answered: 13 above and below, 18 at the sides (14 on iPhone).
            Plate(padding: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    AnsweredBody(decision: current, asker: asker(current))
                    if let error = session.cardErrors[id] { ErrorLine(text: error) }
                    savedMemo(id)
                    if current.status == "closed", current.closeKind != nil {
                        reopenControl(busy: reopening.contains(id)) { Task { await reopen(current, inPlace: true) } }
                            .padding(.top, 2)
                    }
                    if let error = reopenErrors[id] { ErrorLine(text: error) }
                }
                .padding(.vertical, 13).padding(.horizontal, wide ? 18 : 14)
            }
            .overlay { FlashRing(on: flashID == id) }
            .id(id)
            .background(InboxCardGeometry(id: id))
        } else {
            DecisionCard(
                review: reviewBinding(shown),
                memoOnly: memoOnlyBinding(shown),
                latest: current,
                asker: asker(shown),
                fileTitle: shown.fileId.flatMap { fileID in store.files.first { $0.id == fileID }?.title },
                wide: wide,
                locked: !gateOpen,
                lockHint: lockHint,
                busy: session.inFlight.contains(id),
                error: session.cardErrors[id],
                flash: flashID == id,
                detailExpanded: session.expandedDetail.contains(id),
                canReopen: store.canWrite,
                reopenBusy: reopening.contains(id),
                reopenError: reopenErrors[id],
                shiftedAt: shiftedAt,
                onToggleDetail: { if session.expandedDetail.contains(id) { session.expandedDetail.remove(id) } else { session.expandedDetail.insert(id) } },
                onSubmit: { Task { await submit(id) } },
                onReviewLatest: { reviewLatest(id) },
                onReopen: { if let current { Task { await reopen(current, inPlace: true) } } },
                onOpenFile: { fileID in router.openFile(fileID) },
                onArm: { revealRequest = RevealRequest(target: confirmBarID(id)) }
            )
            .id(id)
            .background(InboxCardGeometry(id: id))
        }
    }

    // MARK: Done view

    private var doneView: some View {
        let list = doneList
        let moreAvailable = (store.state?.doneDecisionCount ?? 0) > list.count && store.api != nil && !store.isDemo && !olderExhausted
        return VStack(alignment: .leading, spacing: 10) {
            if linkMissing { missingLinkNotice }
            if let notice = reopenedNotice {
                InlineNotice(tone: .accent, icon: "arrow.uturn.backward.circle", title: "다시 열었습니다",
                             detail: "'\(notice.title)'",
                             actionTitle: "결재할 항목 보기", action: { reopenedNotice = nil; router.decisionID = notice.id })
            }
            if list.isEmpty {
                emptyCard(title: "결재된 항목이 없습니다", detail: "결정한 결재가 여기에 쌓입니다.")
            } else {
                // Web .glass.ibx-done: padding 4 16; rows 12 above and below, a hairline between them.
                Plate(padding: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(list.enumerated()), id: \.element.id) { index, decision in
                            if index > 0 { Rectangle().fill(CE.line).frame(height: 1).padding(.horizontal, 16) }
                            doneRow(decision)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            if moreAvailable {
                Button(loadingOlder ? "불러오는 중" : "더 불러오기") { Task { await loadOlder() } }
                    .ceGhostButton().controlSize(.regular)
                    .disabled(loadingOlder || store.connectionStatus != .connected)
                    .frame(maxWidth: .infinity)
            }
            if let olderError { ErrorLine(text: olderError) }
        }
    }

    /// Web ReopenButton: a glass button with its consequence written beside it (visible on iPhone too, not only on hover).
    private func reopenControl(busy: Bool, action: @escaping () -> Void) -> some View {
        HStack(spacing: 10) {
            Button(busy ? "여는 중" : "다시 열기", action: action)
                .ceSecondaryButton().controlSize(.regular).fixedSize()
                .disabled(!store.canWrite || busy)
            Text("결재할 항목으로 돌아갑니다")
                .font(CEFont.meta).foregroundStyle(CE.ink2).lineSpacing(CELeading.meta)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func doneRow(_ decision: Decision) -> some View {
        let id = decision.id
        let expanded = session.expandedDone.contains(id)
        let hasMore = !decision.detail.isEmpty || !decision.images.isEmpty || decision.fileId != nil
        let reopenable = decision.status == "closed" && decision.closeKind != nil
        return VStack(alignment: .leading, spacing: 4) {
            AnsweredBody(decision: decision, asker: asker(decision))
            savedMemo(id)
            if reopenable {
                reopenControl(busy: reopening.contains(id)) { Task { await reopen(decision, inPlace: false) } }
                    .padding(.top, 6)
            }
            if let error = reopenErrors[id] { ErrorLine(text: error) }
            if hasMore {
                DisclosureLink(title: expanded ? "배경 접기" : "배경 보기", expanded: expanded,
                               accessibilityLabel: expanded ? "\(decision.title) 배경 접기" : "\(decision.title) 배경 보기") {
                    withAnimation(.easeOut(duration: 0.18)) {
                        if expanded { session.expandedDone.remove(id) } else { session.expandedDone.insert(id) }
                    }
                }
            }
            if expanded && hasMore {
                // Web .ibx-done__bg: padding 12 14, radius 14, white .05; the detail at the card's 14.5 / 1.6.
                VStack(alignment: .leading, spacing: 10) {
                    if !decision.detail.isEmpty { MarkdownText(text: decision.detail, size: 14.5, lineHeight: 1.6).foregroundStyle(CE.ink) }
                    if !decision.images.isEmpty { ImageStrip(images: decision.images) }
                    if let fileID = decision.fileId {
                        FileChip(title: store.files.first { $0.id == fileID }?.title) { router.openFile(fileID) }
                    }
                }
                .padding(.vertical, 12).padding(.horizontal, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 16)
        .background(CE.accent.opacity(flashID == id ? 0.1 : 0))
        .overlay { FlashRing(on: flashID == id, radius: 6) }
        .animation(.easeOut(duration: 0.35), value: flashID == id)
        .id(id)
        .background(InboxCardGeometry(id: id))
    }

    // MARK: - Review bindings

    private func makeReview(_ decision: Decision) -> DecisionReview {
        var review = DecisionReview(decision: decision)
        if let memo = drafts.memo(for: decision.id) { review.note = memo }
        return review
    }

    private func reviewBinding(_ decision: Decision) -> Binding<DecisionReview> {
        let id = decision.id
        return Binding(
            get: { session.reviews[id] ?? makeReview(decision) },
            set: { next in
                let previous = session.reviews[id] ?? makeReview(decision)
                session.reviews[id] = next
                if next.note != previous.note {
                    session.memoRevisions[id, default: 0] += 1
                    drafts.setMemo(next.note, for: id)
                }
                if next.note != previous.note || next.choice != previous.choice { session.engaged.insert(id) }
                // A different pick changes the group's batch targets: ask again.
                if next.choice != previous.choice, let group = decision.group { session.batchArmed[group] = nil }
            })
    }

    private func memoOnlyBinding(_ decision: Decision) -> Binding<Bool> {
        let id = decision.id
        return Binding(
            get: { session.memoOnly.contains(id) },
            set: { value in
                if value { session.memoOnly.insert(id); session.engaged.insert(id) } else { session.memoOnly.remove(id) }
                if let group = decision.group { session.batchArmed[group] = nil }
            })
    }

    /// Open cards in a group the batch may answer: valid recommendation, not changed since review,
    /// and the local pick is unset or equals the recommendation.
    private func batchTargets(_ cards: [Decision]) -> [Decision] {
        cards.compactMap { card -> Decision? in
            guard let current = latest(card.id), current.status == "open", !session.inFlight.contains(card.id), !session.memoOnly.contains(card.id) else { return nil }
            let review = session.reviews[card.id] ?? makeReview(current)
            guard !review.isStale(comparedTo: current) else { return nil }
            guard let rec = current.rec, current.options.contains(where: { $0.k == rec }) else { return nil }
            return review.choice == nil || review.choice == rec ? review.decision : nil
        }
    }

    // MARK: - Sync with polling

    private func sync() {
        let byID = Dictionary(store.decisions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for decision in store.decisions where decision.status == "open" && session.reviews[decision.id] == nil {
            session.reviews[decision.id] = makeReview(decision)
        }
        for (id, review) in session.reviews where !session.inFlight.contains(id) && review.isStale(comparedTo: byID[id]) {
            if review.decision.kind == "usage_limit", let current = byID[id], current.status == "open" {
                // This is a notice, with no approval choice or memo to preserve for review.
                session.reviews[id] = makeReview(current)
            } else if session.engaged.contains(id) && !session.answeredHere.contains(id) {
                // The person was working on this card: keep it, clear the pick, keep the memo, ask for review.
                if review.choice != nil { session.reviews[id]?.choice = nil }
                session.memoOnly.remove(id)
            } else if let current = byID[id], current.status == "open" {
                session.reviews[id] = makeReview(current)
            } else {
                session.reviews[id] = nil
            }
        }
        for (group, ids) in session.batchArmed where !session.batchBusy.contains(group) {
            let cards = liveDecisions.filter { $0.group == group }
            if batchTargets(cards).map(\.id) != ids { session.batchArmed[group] = nil }
        }
    }

    /// 방문이 끝났다: 이미 처리된 카드를 '결재할 항목'에서 치운다(구획 전환, 결재함을 떠남).
    private func settleVisit() {
        session.settleVisit(decisions: store.state == nil ? nil : store.decisions)
        sync()
    }

    private func resetProject() {
        session.contextID = UUID()
        router.inboxReview = InboxReviewState()
        olderDone = []; olderCursor = nil; olderExhausted = false; olderError = nil; loadingOlder = false
        reopening = []; reopenErrors = [:]; reopenedNotice = nil
        linkMissing = false; resolvingLink = nil; copiedMember = nil; revealRequest = nil; flashID = nil
        scrollRestoreID = UUID(); restoringScroll = false
        session.inFlight = []; session.batchBusy = []; session.memoRevisions = [:]; session.segment = .open
    }

    // MARK: - Actions

    private func submit(_ id: String) async {
        guard gateOpen, !session.inFlight.contains(id), let review = session.reviews[id] else { return }
        let current = latest(id)
        let note = review.note.trimmingCharacters(in: .whitespacesAndNewlines)
        let noteOnly = review.decision.kind != "usage_limit" && session.memoOnly.contains(id) && !review.decision.options.isEmpty
        if noteOnly {
            guard review.decision.status == "open", !review.isStale(comparedTo: current), !note.isEmpty else { return }
        } else {
            guard review.canSubmit(comparedTo: current) else { return }
        }
        let namespace = drafts.namespace
        let projectID = store.selectedProjectID
        let visit = session.visitID
        let context = session.contextID
        let memo = drafts.memo(for: id)
        let revision = session.memoRevisions[id, default: 0]
        guard session.beginSubmission(id) else { return }
        session.engaged.insert(id)
        session.cardErrors[id] = nil
        let ok: Bool
        if review.decision.kind == "usage_limit" {
            ok = await store.resumeUsageLimit(review.decision)
        } else {
            ok = await store.answerDecision(review.decision, choice: noteOnly ? nil : review.choice, note: note.isEmpty ? nil : note)
        }
        guard session.contextID == context, drafts.namespace == namespace, store.selectedProjectID == projectID else { return }
        if ok, session.visitID == visit, session.memoRevisions[id, default: 0] == revision, drafts.memo(for: id) == memo {
            drafts.clearMemo(id)
        }
        session.inFlight.remove(id)
        guard session.visitID == visit else { return }
        if ok {
            if review.decision.kind == "usage_limit", let current = latest(id), current.status == "open" {
                // A resume attempt may leave the same card open with stillLimited=true.
                session.reviews[id] = makeReview(current)
                session.engaged.remove(id)
                session.answeredHere.remove(id)
            } else { session.answeredHere.insert(id) }
            session.memoOnly.remove(id)
            if session.memoRevisions[id, default: 0] == revision { session.reviews[id]?.note = "" }
        } else {
            session.cardErrors[id] = latest(id).map({ $0.status != "open" }) == true
                ? "이미 처리된 결재입니다. 내 요청의 수락은 확인하지 못해 메모를 남겼습니다."
                : store.errorMessage.map(friendlyError) ?? "답변 결과를 확인하지 못했습니다. 내 메모는 남겼습니다."
            sync()
        }
    }

    private func runBatch(_ group: String, ids: [String]) async {
        let cards = liveDecisions.filter { $0.group == group }
        let targets = batchTargets(cards)
        guard gateOpen, !session.batchBusy.contains(group), targets.map(\.id) == ids, !targets.isEmpty else { session.batchArmed[group] = nil; return }
        let namespace = drafts.namespace
        let projectID = store.selectedProjectID
        let visit = session.visitID
        let context = session.contextID
        let memos = ids.reduce(into: [String: String]()) { result, id in
            if let memo = drafts.memo(for: id) { result[id] = memo }
        }
        let revisions = session.memoRevisions
        var notes: [String: String] = [:]
        for decision in targets {
            let memo = (session.reviews[decision.id]?.note ?? drafts.memo(for: decision.id) ?? decision.lastNote ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !memo.isEmpty { notes[decision.id] = memo }
            if session.reviews[decision.id] == nil { session.reviews[decision.id] = makeReview(decision) }
        }
        session.batchBusy.insert(group)
        session.batchErrors[group] = nil
        for id in ids { session.inFlight.insert(id); session.engaged.insert(id); session.cardErrors[id] = nil }
        let results = await store.answerBatchResults(targets, notes: notes)
        guard session.contextID == context, drafts.namespace == namespace, store.selectedProjectID == projectID else { return }
        for id in ids {
            // A closed card is not proof that this device's request was accepted.
            if results[id] == .accepted, session.visitID == visit, session.memoRevisions[id, default: 0] == revisions[id, default: 0],
               drafts.memo(for: id) == memos[id] {
                drafts.clearMemo(id)
            }
            session.inFlight.remove(id)
        }
        session.batchBusy.remove(group)
        guard session.visitID == visit else { return }
        for id in ids {
            switch results[id] ?? .notSent {
            case .accepted:
                session.answeredHere.insert(id)
                session.memoOnly.remove(id)
                if session.memoRevisions[id, default: 0] == revisions[id, default: 0] { session.reviews[id]?.note = "" }
            case .conflict:
                session.cardErrors[id] = "다른 곳에서 바뀌었습니다. 내 메모는 남겼습니다. 최신 내용을 확인하세요."
            case .unknown:
                session.cardErrors[id] = "답변 결과 확인 중입니다. 내 메모는 남겼습니다."
            case .refused:
                session.cardErrors[id] = "답변을 반영하지 않았습니다. 내 메모는 남겼습니다."
            case .notSent:
                session.cardErrors[id] = "보내지 않았습니다. 내 메모는 남겼습니다."
            }
        }
        session.batchArmed[group] = nil
        let remaining = ids.filter { results[$0] != .accepted }.count
        if remaining > 0 { session.batchErrors[group] = "\(remaining)건은 카드별 결과를 확인하세요. 메모는 남겼습니다." }
        sync()
    }

    @ViewBuilder private func savedMemo(_ id: String) -> some View {
        if let memo = drafts.memo(for: id), !memo.isEmpty {
            Text("내 메모 · 이 기기에 보관\n\(memo)")
                .font(CEFont.note).foregroundStyle(CE.ink2).lineSpacing(CELeading.spacing(13.5, 1.5))
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
    }

    private func reviewLatest(_ id: String) {
        guard let current = latest(id) else { return }
        if session.reviews[id] == nil { session.reviews[id] = makeReview(current) } else { session.reviews[id]?.reviewLatest(current) }
        // A server reopen brings back the previous note unless the person wrote their own.
        if drafts.memo(for: id) == nil, session.reviews[id]?.note.isEmpty == true { session.reviews[id]?.note = current.lastNote ?? "" }
        session.memoOnly.remove(id)
        session.cardErrors[id] = nil
    }

    private func reopen(_ decision: Decision, inPlace: Bool) async {
        guard store.canWrite, !reopening.contains(decision.id) else { return }
        reopening.insert(decision.id)
        reopenErrors[decision.id] = nil
        let context = session.contextID
        let ok = await store.reopenDecision(decision)
        guard session.contextID == context else { return }
        reopening.remove(decision.id)
        guard ok else {
            reopenErrors[decision.id] = store.errorMessage ?? "다시 열지 못했습니다."
            return
        }
        if inPlace, latest(decision.id)?.status == "open" {
            // The person asked for this change; show the reopened card right away.
            reviewLatest(decision.id)
        } else if !inPlace {
            reopenedNotice = decision
        }
    }

    private func loadOlder() async {
        guard let api = store.api, let projectID = store.selectedProjectID, !loadingOlder else { return }
        // Same key as the server (COALESCE(answered_at, created_at)). First page: below the payload's 50 newest done;
        // later pages: below the last page. Deep-linked decisions in olderDone never move the cursor.
        let before = olderCursor ?? store.decisions.filter { $0.status != "open" }.map(pagingKey).min()
        var path = "/api/projects/\(APIClient.segment(projectID))/decisions?status=done&limit=50"
        if let before { path += "&before=\(APIClient.segment(before))" }
        loadingOlder = true
        olderError = nil
        let context = session.contextID
        do {
            let page: [Decision] = try await api.request(path)
            guard session.contextID == context, store.selectedProjectID == projectID else { return }
            let known = Set(olderDone.map(\.id)).union(store.decisions.map(\.id))
            olderDone += page.filter { !known.contains($0.id) }
            if let oldest = page.map(pagingKey).min() { olderCursor = oldest }
            if page.count < 50 { olderExhausted = true }
        } catch {
            if session.contextID == context, store.selectedProjectID == projectID {
                olderError = friendlyLoadError(error, what: "지난 결재", verb: "불러오지")
            }
        }
        if session.contextID == context { loadingOlder = false }
    }

    private func pagingKey(_ decision: Decision) -> String { decision.answeredAt ?? decision.createdAt }

    private func copyCommand(_ command: String, member: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        #else
        UIPasteboard.general.string = command
        #endif
        copiedMember = member
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.6))
            if copiedMember == member { copiedMember = nil }
        }
    }

    // MARK: - Deep links

    private func handleLink(_ proxy: ScrollViewProxy) {
        guard let id = router.decisionID, store.state != nil else { return }
        guard let decision = latest(id) ?? olderDone.first(where: { $0.id == id }) else { resolveMissingLink(id); return }
        router.decisionID = nil
        linkMissing = false
        let target: InboxSegment = decision.status == "open" || session.answeredHere.contains(id) || session.engaged.contains(id) ? .open : .done
        if target == .done { session.expandedDone.insert(id) }
        if session.segment != target { session.segment = target }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(160))
            withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(id, anchor: .center) }
            flashID = id
            try? await Task.sleep(for: .seconds(1.8))
            if flashID == id { flashID = nil }
        }
    }

    /// The payload holds every open card and the 50 newest done ones; older links are fetched one by one.
    private func resolveMissingLink(_ id: String) {
        guard resolvingLink != id else { return }
        guard let api = store.api, let projectID = store.selectedProjectID, !store.isDemo else {
            linkMissing = true; router.decisionID = nil; return
        }
        resolvingLink = id
        let context = session.contextID
        Task { @MainActor in
            do {
                let found: Decision = try await api.request("/api/decisions/\(APIClient.segment(id))")
                guard session.contextID == context else { return }
                if resolvingLink == id { resolvingLink = nil }
                guard store.selectedProjectID == projectID, router.decisionID == id else { return }
                guard found.projectId.isEmpty || found.projectId == projectID else { linkMissing = true; router.decisionID = nil; return }
                // Open cards arrive with the next poll and are handled then.
                if found.status != "open", !olderDone.contains(where: { $0.id == id }) { olderDone.append(found) }
            } catch {
                guard session.contextID == context else { return }
                if resolvingLink == id { resolvingLink = nil }
                guard router.decisionID == id else { return }
                linkMissing = true; router.decisionID = nil
            }
        }
    }
}

// MARK: - Decision card (open)

private struct DecisionCard: View {
    @Binding var review: DecisionReview
    /// Option card: "메모만 보내기" chosen. Free answers show the final bar as soon as text is entered.
    @Binding var memoOnly: Bool
    let latest: Decision?
    let asker: Member?
    let fileTitle: String?
    let wide: Bool
    let locked: Bool
    /// Fallback reason while final submission is locked; editing remains local.
    let lockHint: String?
    let busy: Bool
    let error: String?
    let flash: Bool
    let detailExpanded: Bool
    let canReopen: Bool
    let reopenBusy: Bool
    let reopenError: String?
    let shiftedAt: Date
    var onToggleDetail: () -> Void
    var onSubmit: () -> Void
    var onReviewLatest: () -> Void
    var onReopen: () -> Void
    var onOpenFile: (String) -> Void
    /// Called when the confirm bar appears because of the person's pick, "답 보내기" or memo-only choice.
    var onArm: () -> Void = {}
    @FocusState private var memoFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(Router.self) private var router
    @Environment(AppStore.self) private var store

    private var decision: Decision { review.decision }
    private var stale: Bool { !busy && review.isStale(comparedTo: latest) }
    private var whoName: String { decision.who.isEmpty ? "담당자" : decision.who }
    private var free: Bool { decision.options.isEmpty }
    private var typed: Bool { !review.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var picked: DecisionOption? { decision.options.first { $0.k == review.choice } }
    private var showsConfirm: Bool {
        review.showsConfirmation(comparedTo: latest, memoOnly: memoOnly, busy: busy)
    }

    var body: some View {
        // Web .ibx-card: padding 16 18 (14 on iPhone), 12 between blocks.
        Plate(padding: 0) {
            VStack(alignment: .leading, spacing: 12) {
                if decision.status == "open" {
                    header
                    if stale { staleNotice }
                    reopenLine
                    // Web .ibx-title: 16.5 / 650, line height 1.4, -.015em.
                    Text(decision.title)
                        .font(CEFont.title).tracking(-0.25)
                        .lineSpacing(CELeading.spacing(16.5, 1.4))
                        .foregroundStyle(CE.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .accessibilityAddTraits(.isHeader)
                    if !decision.detail.isEmpty {
                        ClampedDetail(text: decision.detail, expanded: detailExpanded, onToggle: onToggleDetail)
                    }
                    if !decision.images.isEmpty { ImageStrip(images: decision.images) }
                    if let fileID = decision.fileId { FileChip(title: fileTitle) { onOpenFile(fileID) } }
                    if decision.kind == "usage_limit" { usageLimitArea } else { answerArea }
                } else {
                    // The person reviewed the latest version and it is no longer open.
                    AnsweredBody(decision: decision, asker: asker)
                    if stale { staleNotice }
                    resolvedFooter
                }
            }
            .padding(.vertical, 16).padding(.horizontal, wide ? 18 : 14)
            .animation(.easeOut(duration: 0.18), value: showsConfirm)
        }
        .overlay { FlashRing(on: flash) }
        .modifier(ApprovalKeyboardShortcuts(
            enabled: decision.kind != "usage_limit" && !busy && !stale && !store.isDemo && !store.isArchive && decision.status == "open",
            onNumber: { number in
                guard decision.options.indices.contains(number - 1) else { return false }
                review.choice = decision.options[number - 1].k; memoOnly = false
                return true
            },
            onReturn: { if showsConfirm && !locked { onSubmit() } },
            onCancel: { review.choice = nil; memoOnly = false; review.freeConfirmationCancelled = true }))
        // Only transitions caused on screen arm a reveal; a card that appears already armed does not scroll.
        .onChange(of: showsConfirm) { _, shown in if shown { onArm() } }
        // Clearing the answer also disarms a memo-only confirmation.
        .onChange(of: typed) { _, now in if !now && memoOnly { memoOnly = false } }
        .onChange(of: review.note) { _, _ in review.freeConfirmationCancelled = false }
    }

    /// Quiet "who · time" line. The dot is the asker's CLI state (waiting, working, asleep…).
    private var header: some View {
        let state = asker.map { MemberStatusInfo($0) }
        // Web .ibx-top: who 13 / 600 ink-1, time 12.5 ink-2 at the far end.
        return HStack(alignment: .center, spacing: 8) {
            if decision.kind == "usage_limit" { Tag("사용 한도", tone: .attention) }
            StatusDot(tone: state?.tone ?? .attention)
            Text(whoName).font(CEFont.secondary.weight(.semibold)).foregroundStyle(CE.ink).lineLimit(1)
            Spacer(minLength: 6)
            if decision.status == "open", let waited = HomeView.waitedLabel(decision, waitingSince: InboxHomePolicy.waitingStart(decision, members: store.members, notices: store.deliveryNotices)) { Tag(waited, tone: .attention) }
            Text(relativeTime(decision.createdAt)).font(CEFont.meta).monospacedDigit().foregroundStyle(CE.ink2).fixedSize()
        }
        .help(state.map { "\(whoName) · \($0.label)" } ?? whoName)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([decision.kind == "usage_limit" ? "사용 한도" : nil, whoName, state?.label, relativeTime(decision.createdAt)].compactMap { $0 }.joined(separator: ", "))
    }

    @ViewBuilder private var reopenLine: some View {
        if let note = decision.reopenNote, !note.isEmpty {
            let last = decision.lastChoice.map { key in decision.options.first { $0.k == key }?.label ?? key }
            // Web .ibx-reopened: 13.5 at 1.45, danger.
            Label {
                Text(last.map { "\(note) · 직전 답: \($0)" } ?? note)
                    .lineSpacing(CELeading.note)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "arrow.uturn.backward.circle")
            }
            .font(CEFont.note).foregroundStyle(CE.danger)
        }
    }

    private var staleNotice: some View {
        let detail = latest.map { "지금은 '\(DecisionStateInfo($0).label)' 상태입니다. 선택은 지우고 메모는 남겼습니다." }
            ?? "더 불러올 수 없습니다. 결재된 항목이나 대화에서 확인하세요. 메모는 남겼습니다."
        let reopenable = latest.map { $0.status == "closed" && $0.closeKind != nil } ?? false
        return VStack(alignment: .leading, spacing: 6) {
            InlineNotice(tone: .attention, icon: "arrow.triangle.2.circlepath", title: "결재 내용이 바뀌었습니다", detail: detail,
                         actionTitle: latest == nil ? nil : "최신 내용 검토", action: latest == nil ? nil : onReviewLatest)
            if reopenable {
                Button(reopenBusy ? "여는 중" : "다시 열기", action: onReopen)
                    .ceSecondaryButton().ceCompactControl()
                    .disabled(!canReopen || reopenBusy)
                    .help("결재할 항목으로 돌아갑니다")
            }
            if let reopenError { ErrorLine(text: reopenError) }
        }
    }

    @ViewBuilder private var resolvedFooter: some View {
        HStack(spacing: 10) {
            Text("결재된 항목으로 옮겨집니다").font(CEFont.meta).foregroundStyle(CE.ink2)
            Spacer(minLength: 0)
            if decision.status == "closed", decision.closeKind != nil {
                Button(reopenBusy ? "여는 중" : "다시 열기", action: onReopen)
                    .ceSecondaryButton().ceCompactControl()
                    .disabled(!canReopen || reopenBusy)
                    .help("결재할 항목으로 돌아갑니다")
            }
        }
        if let reopenError, !stale { ErrorLine(text: reopenError) }
    }

    // MARK: Usage limit notice

    private var usageLimitArea: some View {
        let info = UsageLimitInfo(decision, members: store.members)
        return VStack(alignment: .leading, spacing: 10) {
            if let resumes = info.resumesText {
                Text(resumes).font(CEFont.meta).foregroundStyle(CE.ink2)
            }
            if !info.memberNames.isEmpty {
                ChipFlow(spacing: 6) {
                    ForEach(Array(info.memberNames.enumerated()), id: \.offset) { _, name in
                        Tag(name, tone: .attention)
                    }
                }
            }
            if let warning = info.warning {
                Text(warning).font(CEFont.note).foregroundStyle(Tone.attention.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button(UsageLimitInfo.resumeLabel) {
                review.choice = UsageLimitInfo.resumeChoice
                memoOnly = false
                onSubmit()
            }
            .ceProminentButton()
            .disabled(locked || busy || stale)
            if busy { ProgressView().controlSize(.small) }
            if let lockHint { Text(lockHint).font(CEFont.meta).foregroundStyle(CE.ink2) }
            if let error { ErrorLine(text: error) }
        }
    }

    // MARK: Answer area

    @ViewBuilder private var answerArea: some View {
        let typed = self.typed
        let picked = self.picked
        if !free { options(disabled: busy || stale || store.isDemo || store.isArchive) }
        // Web .ibx-memo: a 44pt .input (15px at 1.5, up to 160 tall) with a 44pt glass button beside it.
        HStack(alignment: .bottom, spacing: 8) {
            TextField(free ? "답을 적어 주세요" : "메모 (선택) — 다른 생각이나 조건", text: $review.note, axis: .vertical)
                .lineLimit(1...6)
                .lineSpacing(CELeading.spacing(15, 1.5))
                .focused($memoFocused)
                .onChange(of: memoFocused) { _, focused in router.inlineFieldFocused = focused }
                .onDisappear { if memoFocused { router.inlineFieldFocused = false } }
                .ceField(focused: memoFocused)
                .disabled(busy || store.isDemo || store.isArchive)
                .onSubmit { if free && typed && !locked && !busy && !stale { memoOnly = true; review.freeConfirmationCancelled = false } }
                .accessibilityLabel(free ? "답" : "메모")
            if free && typed && review.freeConfirmationCancelled && !stale {
                Button("답 확인") { review.freeConfirmationCancelled = false }.ceSecondaryButton().disabled(busy)
            } else if !free && typed && picked == nil && !memoOnly && !stale {
                Button("메모만 보내기") { memoOnly = true }
                    .ceSecondaryButton().controlSize(.regular).fixedSize()
                    .disabled(busy || store.isDemo || store.isArchive)
            }
        }
        if showsConfirm {
            let quoted = picked?.label ?? (free ? plainOneLine(review.note) : nil)
            ConfirmBar(
                quoted: quoted,
                verb: free ? "답 보내기" : quoted.map { "\(particleRo($0)) 결정" } ?? "메모만 보내기",
                hint: picked != nil && typed ? "메모도 함께 보냅니다" : nil,
                busy: busy,
                disabled: locked,
                stretch: !wide,
                shiftedAt: shiftedAt,
                onConfirm: onSubmit,
                onCancel: { review.choice = nil; memoOnly = false; review.freeConfirmationCancelled = true })
            .id(confirmBarID(decision.id))
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -4)))
        }
        if locked, let reason = routerWriteBlockedReason { Text(reason).font(CEFont.meta).foregroundStyle(CE.ink2) }
        if let error {
            ErrorLine(text: friendlyError(error))
            if showsConfirm { Button("다시 시도", action: onSubmit).ceSecondaryButton().disabled(locked || busy) }
        }
    }

    private var routerWriteBlockedReason: String? { store.writeBlockedReason ?? lockHint }

    /// One column; three or fewer options sit side by side when each still gets about 200pt (web auto-fit grid).
    @ViewBuilder private func options(disabled: Bool) -> some View {
        let items = Array(decision.options.enumerated())
        if items.count > 1 && items.count <= 3 {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(items, id: \.offset) { _, option in
                        optionTile(option, disabled: disabled)
                            .frame(minWidth: 200, idealWidth: 200, maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 8) {
                    ForEach(items, id: \.offset) { _, option in optionTile(option, disabled: disabled) }
                }
            }
        } else {
            VStack(spacing: 8) {
                ForEach(items, id: \.offset) { _, option in optionTile(option, disabled: disabled) }
            }
        }
    }

    private func optionTile(_ option: DecisionOption, disabled: Bool) -> some View {
        OptionTile(option: option,
                   recommended: option.k == decision.rec,
                   picked: review.choice == option.k,
                   somethingPicked: review.choice != nil,
                   wasLastChoice: decision.reopenNote != nil && decision.lastChoice == option.k) {
            review.choice = review.choice == option.k ? nil : option.k
            memoOnly = false
        }
        .disabled(disabled)
    }
}

/// Web option tile: quiet glass fill; the recommended one violet with a ring; the picked one deep violet with a
/// focus ring and a check. When another option is picked the recommended one steps back.
struct OptionTile: View {
    let option: DecisionOption
    let recommended: Bool
    let picked: Bool
    let somethingPicked: Bool
    let wasLastChoice: Bool
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        // Web .ibx-opt: min 48, padding 11 14, gap 3; label 15 / 600 at 1.4, description 13 at 1.5 ink-2.
        Button(action: action) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .center, spacing: 8) {
                    Text(option.label).font(labelFont).foregroundStyle(isEnabled || picked ? CE.ink : CE.ink2)
                        .lineSpacing(CELeading.spacing(15, 1.4))
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    if recommended { RecommendedBadge() }
                    if wasLastChoice { Tag("직전 답") }
                    Spacer(minLength: 0)
                    if picked {
                        Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                            .accessibilityHidden(true)
                    }
                }
                if let desc = option.desc, !desc.isEmpty {
                    Text(desc).font(CEFont.secondary).foregroundStyle(CE.ink2)
                        .lineSpacing(CELeading.spacing(13, 1.5))
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .frame(maxWidth: .infinity, minHeight: 48, maxHeight: .infinity, alignment: .topLeading)
            .background(fill, in: shape)
            .overlay { shape.strokeBorder(stroke.color, lineWidth: stroke.width) }
            .contentShape(shape)
            .animation(.easeOut(duration: 0.12), value: picked)
        }
        .buttonStyle(OptionPressStyle())
        .onHover { hovering = $0 }
        .accessibilityAddTraits(picked ? .isSelected : [])
        .accessibilityHint("고른 뒤 아래 확인 버튼을 눌러야 결정이 전달됩니다")
    }

    private var labelFont: Font {
        #if os(macOS)
        .system(size: 15, weight: .semibold)
        #else
        CEFont.rowTitle
        #endif
    }

    private var lit: Bool { hovering && isEnabled }
    private var fill: Color {
        if picked { return CE.violet.opacity(0.5) }
        if recommended && !somethingPicked { return CE.violet.opacity(lit ? 0.32 : 0.2) }
        return Color.white.opacity(lit ? 0.11 : 0.06)
    }
    private var stroke: (color: Color, width: CGFloat) {
        if picked { return (CE.accent, 2) }
        if recommended { return somethingPicked ? (CE.violet.opacity(0.5), 1) : (CE.violet.opacity(0.9), 1.5) }
        return (Color.white.opacity(0.14), 1)
    }
}

/// Web accent badge (.badge[data-tone=accent]: 20 tall, 12 / 650): white text on the violet fill.
private struct RecommendedBadge: View {
    var body: some View {
        Text("권장")
            .font(isMac ? .system(size: 12, weight: .semibold) : CEFont.caption.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20)
            .background(CE.accentFill, in: Capsule())
            .fixedSize()
    }
}

/// Quiet press feedback for option tiles: a touch brighter and a hair smaller. Disabled options keep their fill and
/// ring; only the label steps down to ink-2 (web .ibx-opt:disabled), so locked cards stay readable.
struct OptionPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .brightness(configuration.isPressed ? 0.06 : 0)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(.easeOut(duration: 0.09), value: configuration.isPressed)
    }
}

// MARK: - Confirm bar (second step; nothing is sent on the first tap)

struct ConfirmBar: View {
    let quoted: String?
    let verb: String
    let hint: String?
    let busy: Bool
    let disabled: Bool
    /// iPhone: the confirm button takes the row's width (web phone layout).
    let stretch: Bool
    let shiftedAt: Date
    var onConfirm: () -> Void
    var onCancel: () -> Void

    var body: some View {
        // Web .ibx-confirm: hint 13 at 1.45 ink-2; a 44pt primary (gbtn--m) and a 44pt ghost 취소.
        VStack(alignment: .leading, spacing: 6) {
            if let hint {
                Text(hint).font(CEFont.secondary).foregroundStyle(CE.ink2).lineSpacing(CELeading.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 2)
            }
            HStack(spacing: 8) {
                Button {
                    guard !busy, !disabled else { return }
                    onConfirm()
                } label: {
                    HStack(spacing: 0) {
                        if busy {
                            ProgressView().controlSize(.small).padding(.trailing, 6)
                            Text("보내는 중")
                        } else {
                            // A long quote truncates; the verb always stays visible.
                            if let quoted { Text("'\(quoted)'").lineLimit(1).truncationMode(.tail) }
                            Text(verb).lineLimit(1).fixedSize()
                        }
                    }
                    .frame(maxWidth: stretch ? .infinity : nil)
                }
                .ceProminentButton()
                .disabled(busy || disabled)
                Button("취소", action: onCancel).ceGhostButton().disabled(busy).fixedSize()
                if !stretch { Spacer(minLength: 0) }
            }
            .controlSize(.regular)
        }
    }
}

// MARK: - Answered / closed rendering

private struct AnsweredBody: View {
    let decision: Decision
    let asker: Member?

    private var closed: Bool { decision.status == "closed" }
    private var who: String { decision.who.isEmpty ? "담당자" : decision.who }

    var body: some View {
        // Web .ibx-answered (gap 4): title 14.5 / 600 at 1.4; answer, memo and close reason 13.5 at 1.5; meta 12.5 at 1.45.
        // Nothing is clamped: the done list is the only place to read the full answer and memo again.
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 8) {
                Text(who).font(CEFont.secondary.weight(.semibold)).foregroundStyle(CE.ink).lineLimit(1)
                if decision.kind == "usage_limit" { Tag("사용 한도", tone: .attention) }
                if closed { Tag("닫힘") } else { AnswerFlow(decision: decision) }
                Spacer(minLength: 6)
                Text(relativeTime(decision.answeredAt ?? decision.closedAt ?? decision.createdAt))
                    .font(CEFont.meta).monospacedDigit().foregroundStyle(CE.ink2).fixedSize()
            }
            Text(decision.title).font(CEFont.rowTitle).foregroundStyle(CE.ink)
                .lineSpacing(CELeading.spacing(14.5, 1.4))
                .fixedSize(horizontal: false, vertical: true)
            if closed {
                Text("닫힘" + (decision.closeReason.map { " · \($0)" } ?? ""))
                    .font(CEFont.note).foregroundStyle(CE.ink).lineSpacing(textLeading)
                    .fixedSize(horizontal: false, vertical: true)
                let meta = [closeKindName(decision.closeKind), decision.closedBy.map { "닫은 이: \($0)" }].compactMap { $0 }
                if !meta.isEmpty {
                    Text(meta.joined(separator: " · ")).font(CEFont.meta).foregroundStyle(CE.ink2).lineSpacing(metaLeading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let quote = decision.closeQuote, !quote.isEmpty {
                    Text("근거로 든 대표 말: '\(quote)'").font(CEFont.meta).foregroundStyle(CE.ink2).lineSpacing(metaLeading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                if let label = answerLabel {
                    Text("답: \(label)").font(CEFont.note).foregroundStyle(CE.ink2).lineSpacing(textLeading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let note = decision.note, !note.isEmpty {
                    Text("메모: \(note)").font(CEFont.note).foregroundStyle(CE.ink2).lineSpacing(textLeading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if decision.status == "answered", let asker, ["blocked", "error", "asleep", "offline"].contains(asker.status) {
                    let info = MemberStatusInfo(asker.status)
                    Label("\(asker.name)\(particleIGa(asker.name)) '\(info.label)' 상태라 아직 받지 못했습니다", systemImage: info.icon)
                        .font(CEFont.note).foregroundStyle(CE.attention).lineSpacing(CELeading.note)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .textSelection(.enabled)
    }

    private var textLeading: CGFloat { CELeading.spacing(13.5, 1.5) }
    private var metaLeading: CGFloat { CELeading.spacing(12.5, 1.45) }

    private var answerLabel: String? {
        let chosen = decision.choice.map { key in decision.options.first { $0.k == key }?.label ?? key }
        guard let chosen else { return (decision.note ?? "").isEmpty ? "답 없음" : nil }
        return decision.batch ? "\(chosen) (묶음 추천대로)" : chosen
    }
}

/// "보냄 → 받음": 보냄 is always lit; 받음 lights only when the asker's CLI received the answer.
private struct AnswerFlow: View {
    let decision: Decision
    var body: some View {
        let received = decision.status == "delivered"
        let who = decision.who.isEmpty ? "담당자" : decision.who
        // Web .ibx-flow: 12.5 / 600, gap 5, a 12×8 arrow.
        HStack(spacing: 5) {
            Text("보냄").foregroundStyle(CE.success)
            Image(systemName: "arrow.right").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(CE.ink3)
            Text("받음").foregroundStyle(received ? CE.success : CE.ink3)
        }
        .font(CEFont.meta.weight(.semibold))
        .fixedSize()
        .help(received ? "\(who)의 CLI가 받았습니다. 처리했다는 뜻은 아닙니다." : "서버에 저장했습니다. \(who)의 CLI에 들어가면 받음으로 바뀝니다.")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(received ? "\(who)\(particleIGa(who)) 받음" : "보냄, 아직 받기 전")
    }
}

// MARK: - Small pieces

/// Web segment pill: thin glass capsule; the active half is a violet drop with a ring that slides between halves.
private struct InboxSegmentBar: View {
    @Binding var segment: InboxSegment
    let openCount: Int
    let doneCount: Int
    let stretch: Bool
    @Namespace private var drop
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            InboxSegmentItem(title: "결재할 항목", count: openCount, highlightCount: true, selected: segment == .open,
                             stretch: stretch, drop: drop) { segment = .open }
            InboxSegmentItem(title: "결재된 항목", count: doneCount, highlightCount: false, selected: segment == .done,
                             stretch: stretch, drop: drop) { segment = .done }
        }
        // Scoped to the pill: only the drop slides; the list below swaps without animating every card.
        .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.82), value: segment)
        .padding(3)
        .cardPill()
        .fixedSize(horizontal: !stretch, vertical: false)
        .frame(maxWidth: stretch ? .infinity : nil, alignment: .leading)
    }
}

/// One half of the segment pill (web .ibx-seg__item: 44 tall on the web, 13.5 / 600, ink-2 that brightens on hover).
/// Pending decisions show their count as an accent bubble so they read at a glance; the done count stays plain.
private struct InboxSegmentItem: View {
    let title: String
    let count: Int
    let highlightCount: Bool
    let selected: Bool
    let stretch: Bool
    let drop: Namespace.ID
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title)
                if highlightCount && count > 0 {
                    InboxCount(count: count, accent: true)
                } else {
                    Text("\(count)").fontWeight(.bold).monospacedDigit()
                }
            }
            .font(segmentFont)
            .foregroundStyle(selected ? Color.white : hovering ? CE.ink : CE.ink2)
            .lineLimit(1)
            .padding(.horizontal, stretch ? 8 : 14)
            .frame(maxWidth: stretch ? .infinity : nil, minHeight: isMac ? 40 : 44)
            .background {
                if selected {
                    Capsule().fill(CE.violet.opacity(0.42))
                        .overlay { Capsule().strokeBorder(CE.violet.opacity(0.9)) }
                        .shadow(color: CE.violet.opacity(0.45), radius: 10, y: 2)
                        .matchedGeometryEffect(id: "drop", in: drop)
                }
            }
            .contentShape(Capsule())
            .animation(.linear(duration: 0.12), value: hovering)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel("\(title) \(count)건")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var segmentFont: Font {
        #if os(macOS)
        .system(size: 13.5, weight: .semibold)
        #else
        CEFont.rowTitle
        #endif
    }
}

/// Web .ibx-count: a 20pt bubble, 12 / 650. Neutral is white .12 with ink digits; accent is the accent fill with white.
private struct InboxCount: View {
    let count: Int
    var accent = false
    var body: some View {
        Text("\(count)")
            .font(isMac ? .system(size: 12, weight: .semibold) : CEFont.caption.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(accent ? Color.white : CE.ink)
            .padding(.horizontal, 6)
            .frame(minWidth: 20, minHeight: 20)
            .background(accent ? CE.accentFill : Color.white.opacity(0.12), in: Capsule())
            .fixedSize()
    }
}

/// Group container (web .ibx-group): violet tint with a violet ring. Its tree is the same for one card and several so
/// a card never remounts (and loses its memo focus) when a second card joins; only the header and tint appear.
private struct GroupFrame<Header: View, Content: View>: View {
    let single: Bool
    let wide: Bool
    @ViewBuilder var header: Header
    @ViewBuilder var content: Content
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: wide ? 26 : 24, style: .continuous)
        VStack(alignment: .leading, spacing: 10) {
            header
            content
        }
        .padding(single ? 0 : (wide ? 10 : 8))
        .background(CE.violet.opacity(single ? 0 : 0.1), in: shape)
        .overlay { shape.strokeBorder(CE.violet.opacity(single ? 0 : 0.3)) }
    }
}

/// The decision's background as the web draws it (.md.ibx-detail: full markdown at 14.5 / 1.6, tables and headings
/// included). Only a really long text is cut, at about twelve lines with a soft fade, and the line height is the same
/// open or closed so nothing jumps when it opens.
private struct ClampedDetail: View {
    let text: String
    let expanded: Bool
    let onToggle: () -> Void
    @State private var fullHeight: CGFloat = 0

    /// About twelve lines at 14.5 / 1.6.
    private let limit: CGFloat = 280
    /// A text only a few lines over the limit is shown whole: cutting it would save almost nothing.
    private var clamps: Bool { fullHeight > limit + 70 }
    private var cut: Bool { clamps && !expanded }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            MarkdownText(text: text, size: 14.5, lineHeight: 1.6).foregroundStyle(CE.ink)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                .frame(maxHeight: cut ? limit : nil, alignment: .top)
                .clipped()
                .mask {
                    if cut {
                        LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 1 - 28 / limit),
                                               .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom)
                    } else {
                        Rectangle()
                    }
                }
            if clamps {
                DisclosureLink(title: expanded ? "접기" : "더 보기", expanded: expanded, action: onToggle)
            }
        }
    }
}

/// Web .ibx-more: a focus-coloured text toggle with a turning chevron; it brightens to ink on hover.
private struct DisclosureLink: View {
    let title: String
    let expanded: Bool
    var accessibilityLabel: String? = nil
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
                    .rotationEffect(.degrees(expanded ? 180 : 0))
            }
            .font(isMac ? .system(size: 13.5, weight: .semibold) : CEFont.note.weight(.semibold))
            .foregroundStyle(hovering ? CE.ink : CE.accent)
            .frame(minHeight: isMac ? 30 : 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(accessibilityLabel ?? title)
    }
}

/// Decision images as the web's thumbnails (.ibx-thumb): one height (128, 112 on iPhone), each at its own shape,
/// radius 12 with a faint ring, side by side and scrolling sideways when there are many. A click opens Quick Look.
private struct ImageStrip: View {
    let images: [Attachment]
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 8) {
                ForEach(images) { image in
                    if image.isImage {
                        DecisionThumb(attachment: image)
                    } else {
                        AttachmentPreview(attachment: image).frame(width: 260)
                    }
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }
}

private struct DecisionThumb: View {
    @Environment(AppStore.self) private var store
    let attachment: Attachment
    @State private var image: Image?
    @State private var pixelSize: CGSize = .zero
    @State private var fileURL: URL?
    /// 받아 둔 원본. 공용 캐시가 같은 그림을 다시 내려받지 않게 하고, 놓으면 임시 파일도 지워진다.
    @State private var resource: FileResource?
    @State private var loading = false
    @State private var failure: String?
    @State private var quickLook: URL?
    @State private var hovering = false

    private var height: CGFloat { isMac ? 128 : 112 }
    private var name: String { attachment.name.isEmpty ? "이름 없는 그림" : attachment.name }
    /// The image's own shape at the thumbnail height, kept within sensible bounds.
    private var width: CGFloat {
        guard pixelSize.width > 0, pixelSize.height > 0 else { return height }
        return min(max(height * pixelSize.width / pixelSize.height, 72), 360)
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        Button {
            if let fileURL { quickLook = fileURL } else {
                Task {
                    await load()
                    if let fileURL { quickLook = fileURL }
                }
            }
        } label: {
            Group {
                if let image {
                    image.resizable().scaledToFill().frame(width: width, height: height)
                } else {
                    ZStack {
                        Color.white.opacity(0.04)
                        if loading {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "photo").font(.system(size: 18)).foregroundStyle(CE.ink3)
                        }
                    }
                    .frame(width: height, height: height)
                }
            }
            .clipShape(shape)
            .overlay { shape.strokeBorder(Color.white.opacity(hovering ? 0.22 : 0.12)) }
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .disabled(loading)
        .onHover { hovering = $0 }
        .help(failure ?? "\(name) 크게 보기")
        .accessibilityLabel("\(name) 크게 보기")
        .quickLookPreview($quickLook)
        .task(id: attachment.id) { await load() }
    }

    /// Same authenticated download as the attachment tiles; the original is kept in a temporary file for Quick Look.
    private func load() async {
        guard fileURL == nil, !loading else { return }
        guard let api = store.api else {
            failure = store.isDemo ? "샘플에는 원본 파일이 없습니다." : "서버 연결 후 원본을 불러올 수 있습니다."
            return
        }
        loading = true
        defer { loading = false }
        do {
            // 카드가 다시 만들어질 때마다 원본을 새로 받아 새 임시 폴더에 쌓지 않도록, 한도가 있는 공용 캐시를 쓴다.
            let loaded = try await FileResources.attachment(attachment, api: api)
            let data = try loaded.read()
            if let decoded = decodeThumbnail(data, maxPixel: 900) { image = decoded.image; pixelSize = decoded.size }
            resource = loaded; fileURL = loaded.url
            failure = nil
        } catch {
            failure = friendlyLoadError(error, what: "첨부")
        }
    }
}

/// Downsampled decode so a card of screenshots does not hold full-size bitmaps.
private func decodeThumbnail(_ data: Data, maxPixel: Int) -> (image: Image, size: CGSize)? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
    guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    return (Image(decorative: cgImage, scale: 1), CGSize(width: cgImage.width, height: cgImage.height))
}

/// Web .ibx-file: "자료 보기: 제목" opens the file in 자료 (14 / 500 in the focus colour, white .05 well, ring .1).
private struct FileChip: View {
    let title: String?
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: "doc.text").font(.system(size: 14, weight: .medium))
                Text(title.map { "자료 보기: \($0)" } ?? "자료 보기").lineLimit(1).truncationMode(.middle)
            }
            .font(isMac ? .system(size: 14, weight: .medium) : CEFont.body.weight(.medium)).foregroundStyle(CE.accent)
            .padding(.leading, 11).padding(.trailing, 14)
            .frame(minHeight: isMac ? 36 : 44)
            .background(Color.white.opacity(hovering ? 0.09 : 0.05), in: shape)
            .overlay { shape.strokeBorder(Color.white.opacity(0.1)) }
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("자료 화면에서 엽니다")
    }
}

private struct FlashRing: View {
    let on: Bool
    var radius: CGFloat = CERadius.plate
    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .strokeBorder(CE.accent, lineWidth: 2)
            .opacity(on ? 1 : 0)
            .animation(.easeOut(duration: 0.35), value: on)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// Shared with 홈 (the todo completion editor).
struct ErrorLine: View {
    let text: String
    var body: some View {
        // Web .ibx-error: 13.5 at 1.45, danger. Raw server/CLI text reads as plain Korean (friendlyError).
        Label(friendlyError(text), systemImage: "exclamationmark.circle")
            .font(CEFont.note).foregroundStyle(CE.danger).lineSpacing(CELeading.note)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Text helpers

/// Final consonant index of the last Hangul syllable (0 = none), or nil when the word does not end in Hangul.
private func finalConsonant(_ word: String) -> UInt32? {
    guard let scalar = word.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.last,
          (0xAC00...0xD7A3).contains(scalar.value) else { return nil }
    return (scalar.value - 0xAC00) % 28
}

/// "로" / "으로" for the word, "(으)로" when it cannot be decided.
private func particleRo(_ word: String) -> String {
    guard let jong = finalConsonant(word) else { return "(으)로" }
    return jong == 0 || jong == 8 ? "로" : "으로"
}

/// "이" / "가" for the word, "이(가)" when it cannot be decided.
private func particleIGa(_ word: String) -> String {
    guard let jong = finalConsonant(word) else { return "이(가)" }
    return jong == 0 ? "가" : "이"
}

/// An answer must refer to the exact content the person reviewed, even while polling updates the store.
struct DecisionReview {
    private(set) var decision: Decision
    var choice: String?
    var note: String
    var freeConfirmationCancelled = false

    init(decision: Decision) {
        self.decision = decision
        choice = decision.options.contains(where: { $0.k == decision.lastChoice }) ? decision.lastChoice : nil
        note = decision.lastNote ?? ""
    }
    func isStale(comparedTo latest: Decision?) -> Bool {
        guard let latest else { return true }
        return latest.id != decision.id || latest.updatedAt != decision.updatedAt || latest.status != decision.status
    }
    func showsConfirmation(comparedTo latest: Decision?, memoOnly: Bool, busy: Bool = false) -> Bool {
        guard decision.kind != "usage_limit", decision.status == "open", busy || !isStale(comparedTo: latest) else { return false }
        let typed = !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return decision.options.contains { $0.k == choice }
            || (typed && (memoOnly || (decision.options.isEmpty && !freeConfirmationCancelled)))
    }
    func canSubmit(comparedTo latest: Decision?) -> Bool {
        guard decision.status == "open", !isStale(comparedTo: latest) else { return false }
        if decision.kind == "usage_limit" { return choice == UsageLimitInfo.resumeChoice }
        if decision.options.isEmpty { return !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return decision.options.contains { $0.k == choice }
    }
    mutating func reviewLatest(_ latest: Decision) {
        guard latest.id == decision.id else { return }
        decision = latest
        choice = nil
        freeConfirmationCancelled = false
        // The person's draft is deliberately retained; refreshed server notes cannot replace it.
    }
}

/// Local card focus only. A text editor keeps every character and Return/Escape it handles.
struct ApprovalKeyboardShortcuts: ViewModifier {
    let enabled: Bool
    let onNumber: (Int) -> Bool
    let onReturn: () -> Void
    let onCancel: () -> Void
    #if os(macOS)
    @FocusState private var focused: Bool
    private var editing: Bool {
        (NSApp.keyWindow?.firstResponder as? NSTextView)?.isEditable == true
    }
    #endif

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .focusable().focused($focused)
            .simultaneousGesture(TapGesture().onEnded {
                // Let a clicked text field become first responder before deciding to focus its enclosing card.
                Task { @MainActor in
                    await Task.yield()
                    if !editing { focused = true }
                }
            })
            .onKeyPress(characters: CharacterSet(charactersIn: "123456789")) { press in
                guard enabled, !editing, press.modifiers.isEmpty,
                      let number = Self.optionNumber(press.characters, editing: editing) else { return .ignored }
                return onNumber(number) ? .handled : .ignored
            }
            .onKeyPress(.return) {
                guard enabled, !editing else { return .ignored }
                onReturn(); return .handled
            }
            .onKeyPress(.escape) {
                guard enabled, !editing else { return .ignored }
                onCancel(); return .handled
            }
        #else
        content
        #endif
    }

    static func optionNumber(_ characters: String, editing: Bool) -> Int? {
        guard !editing, characters.count == 1, let number = Int(characters), (1...9).contains(number) else { return nil }
        return number
    }
}

/// Save the intra-card offset as well as the ID; a tall review returns to the paragraph being read.
struct InboxScrollLocation {
    let top: CGFloat
    let height: CGFloat
    func anchor(viewport: CGFloat) -> UnitPoint {
        // Restore through a one-point marker at the card's top. Unlike the whole card, its alignment
        // remains defined even when the card height equals the viewport or spans several screens.
        guard viewport > 1 else { return .top }
        return UnitPoint(x: 0, y: top / (viewport - 1))
    }
}

private struct InboxCardFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

private struct InboxCardGeometry: View {
    let id: String
    static func locationID(_ id: String) -> String { "scroll-location-\(id)" }
    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                Color.clear.frame(width: 1, height: 1).id(Self.locationID(id))
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .preference(key: InboxCardFrames.self, value: [id: geometry.frame(in: .named("inbox-scroll"))])
        }
        .allowsHitTesting(false)
    }
}
