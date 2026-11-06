import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// 결재함: "결재할 항목" and "결재된 항목".
// Picking an option never sends; the card's confirm bar does, carrying the reviewed version (`expectedVersion`).
// Cards answered during this visit stay in place as compact answered cards ("보냄 → 받음") until the person
// switches segment or leaves the screen. CLI approval windows (blocked members) are listed separately: they are
// terminal actions, not decisions, and answering a decision never means a todo was done.
// Look: the web inbox (glass segment pill, tinted glass cards, violet group frame, violet option tiles), kept compact.

private enum InboxSegment: Hashable { case open, done }

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

struct InboxView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(DraftStore.self) private var drafts
    @Environment(\.ceWide) private var wide

    @State private var segment: InboxSegment = .open
    // Review state for this visit. Memos live in DraftStore and survive the visit.
    @State private var reviews: [String: DecisionReview] = [:]
    /// Option cards: "메모만 보내기" chosen. Free-answer cards: "답 보내기" pressed. Either way the confirm bar is armed.
    @State private var memoOnly: Set<String> = []
    @State private var engaged: Set<String> = []
    @State private var inFlight: Set<String> = []
    @State private var answeredHere: Set<String> = []
    @State private var cardErrors: [String: String] = [:]
    @State private var expandedDetail: Set<String> = []
    @State private var batchArmed: [String: [String]] = [:]
    @State private var batchBusy: Set<String> = []
    @State private var batchErrors: [String: String] = [:]
    @State private var shiftedAt = Date.distantPast
    @State private var flashID: String?
    // Done view.
    @State private var expandedDone: Set<String> = []
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
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: CESpace.m) {
                    // The segment pill scrolls with the list: nested top bars would overlap the shell's status strips.
                    InboxSegmentBar(segment: $segment, openCount: openDecisions.count, doneCount: doneCount, stretch: !wide)
                        .padding(.bottom, 2)
                    content
                }
                .padding(.horizontal, wide ? 24 : CESpace.l)
                .padding(.top, CESpace.m)
                .padding(.bottom, wide ? 24 : 28)
                .frame(maxWidth: 880, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await store.refresh() }
            .onAppear { sync(); handleLink(proxy) }
            .onDisappear { resetVisit(full: true); segment = .open }
            .onChange(of: router.decisionID) { _, _ in handleLink(proxy) }
            .onChange(of: versionSignature) { _, _ in
                sync()
                if router.decisionID != nil { handleLink(proxy) }
            }
            .onChange(of: olderDone.count) { _, _ in if router.decisionID != nil { handleLink(proxy) } }
            .onChange(of: segment) { _, _ in resetVisit(full: false); sync() }
            .onChange(of: store.selectedProjectID) { _, _ in resetProject() }
            .onChange(of: displayedIDs) { _, _ in shiftedAt = Date() }
            .onChange(of: revealRequest) { _, request in
                guard let request else { return }
                Task { @MainActor in
                    // Wait for the bar's layout, then scroll only as far as needed (nil anchor): no jump when it is already visible.
                    try? await Task.sleep(for: .milliseconds(80))
                    withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(request.target) }
                }
            }
        }
    }

    // MARK: - Derived state

    private var openDecisions: [Decision] { store.decisions.filter { $0.status == "open" } }
    private var blocked: [Member] { store.members.filter { $0.status == "blocked" } }
    private var gateOpen: Bool { store.canWrite && store.state?.project.connection.ok == true }
    /// Why answers are impossible right now (nil = open). Every reason is global, so it is explained once:
    /// demo and disconnection by the pinned StatusStrips, plus one notice above the list (disconnected / runner).
    private var answerLock: AnswerLock? {
        if store.isDemo { return .demo }
        if store.connectionStatus != .connected { return .disconnected }
        if store.state?.project.connection.ok != true { return .runner }
        return nil
    }
    /// Zero-height per-card cue: shown as the disabled field's placeholder, so a card reached by a deep link
    /// still says why it is locked. Demo keeps the normal placeholder (the sample strip is always visible).
    private var lockHint: String? {
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
        for decision in store.decisions where decision.status == "open" || inFlight.contains(decision.id) || answeredHere.contains(decision.id) || engaged.contains(decision.id) {
            result.append(decision); seen.insert(decision.id)
        }
        // A card someone was working on that vanished from the payload keeps its reviewed snapshot.
        for id in engaged.sorted() where !seen.contains(id) {
            if let snapshot = reviews[id]?.decision { result.append(snapshot) }
        }
        return newestFirst(result)
    }

    private var blocks: [InboxBlock] {
        let live = liveDecisions
        var placed = Set<String>()
        var out: [InboxBlock] = []
        for decision in live {
            if let group = decision.group, !group.isEmpty {
                guard !placed.contains(group) else { continue }
                placed.insert(group)
                // Inside a group: asked order, oldest first.
                out.append(InboxBlock(id: "group:\(group)", group: group, decisions: Array(live.filter { $0.group == group }.reversed())))
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
            Plate {
                if store.isLoading {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("결재를 불러오는 중입니다").font(CEFont.secondary).foregroundStyle(CE.ink2)
                    }
                } else {
                    CompactEmpty(icon: "tray", title: "열린 프로젝트가 없습니다", detail: isMac ? "사이드바에서 프로젝트를 고르거나 새로 만드세요." : "위 제목을 눌러 프로젝트를 고르거나 새로 만드세요.")
                }
            }
        } else if segment == .open {
            openView
        } else {
            doneView
        }
    }

    // MARK: Open view

    private var openView: some View {
        VStack(alignment: .leading, spacing: CESpace.m) {
            connectionNotice
            disconnectedNotice
            if linkMissing { missingLinkNotice }
            if !blocked.isEmpty { approvalCard }
            let blocks = self.blocks
            if blocks.isEmpty && blocked.isEmpty {
                Plate { CompactEmpty(icon: "checkmark.seal", title: "결재할 항목이 없습니다", detail: emptyDetail) }
            }
            ForEach(blocks) { block in blockView(block) }
        }
    }

    private var emptyDetail: String {
        guard store.members.contains(where: { $0.status == "working" }) else { return "새 결재가 오면 여기에 나타납니다." }
        return store.state?.project.isHq == true ? "본사 AI가 일하는 중입니다. 대화에서 상황을 볼 수 있습니다." : "직원들이 일하는 중입니다. 대화나 팀에서 상황을 볼 수 있습니다."
    }

    @ViewBuilder private var connectionNotice: some View {
        if !store.isDemo, store.connectionStatus == .connected, let connection = store.state?.project.connection, !connection.ok {
            InlineNotice(tone: .attention, icon: "bolt.horizontal.circle", title: "지금은 결재에 답할 수 없습니다",
                         detail: connection.detail ?? "이 프로젝트의 실행 연결에 문제가 있습니다. 연결되면 답할 수 있습니다.",
                         actionTitle: connection.reason == "runner_off" ? "팀 화면으로" : nil,
                         action: connection.reason == "runner_off" ? { router.go(.team) } : nil)
        }
    }

    /// Once above the list (the pinned strip says the link dropped; this says what happens to the CEO's memos).
    @ViewBuilder private var disconnectedNotice: some View {
        if answerLock == .disconnected, !openDecisions.isEmpty {
            InlineNotice(tone: .attention, icon: "wifi.slash", title: "지금은 결재에 답할 수 없습니다",
                         detail: "쓰던 메모는 이 기기에 남아 있고, 다시 연결되면 보낼 수 있습니다.")
        }
    }

    private var missingLinkNotice: some View {
        InlineNotice(tone: .neutral, icon: "questionmark.circle", title: "찾을 수 없는 결재입니다",
                     detail: "지워졌거나 다른 프로젝트의 결재일 수 있습니다.", actionTitle: "닫기", action: { linkMissing = false })
    }

    // MARK: Approval windows (CLI menus, not decisions)

    /// One compact card for every session stopped at a CLI approval prompt. Answering happens in the terminal.
    private var approvalCard: some View {
        Plate(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Text("승인 대기").font(CEFont.micro).foregroundStyle(CE.approval)
                    Text("터미널에서 승인하거나 거절하세요").font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14).padding(.top, 11).padding(.bottom, 2)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                ForEach(Array(blocked.enumerated()), id: \.element.id) { index, member in
                    if index > 0 { RowDivider(inset: 31) }
                    approvalRow(member)
                }
            }
            .padding(.bottom, 4)
        }
        .overlay { RoundedRectangle(cornerRadius: CERadius.plate, style: .continuous).strokeBorder(CE.approval.opacity(0.28)) }
    }

    private func approvalRow(_ member: Member) -> some View {
        let command = "\(store.bootstrap?.cli ?? "iamceo") attach \(member.id)"
        let copied = copiedMember == member.id
        let now = plainOneLine(member.now)
        return HStack(spacing: 6) {
            Button { router.openMember(member.id) } label: {
                HStack(spacing: 10) {
                    StatusDot(tone: .approval)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Text(member.name).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                            Text("승인 창 앞").font(CEFont.meta).foregroundStyle(CE.approval).lineLimit(1).fixedSize()
                        }
                        if !now.isEmpty { Text(now).font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1) }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, 10).padding(.vertical, 8)
                .frame(minHeight: isMac ? 42 : 52)
            }
            .buttonStyle(RowButtonStyle(radius: CERadius.row))
            .help(MemberStatusInfo("blocked").explanation)
            .accessibilityLabel("\(member.name), 승인 창 앞" + (now.isEmpty ? "" : ", \(now)"))
            .accessibilityHint("팀원 상세를 엽니다")
            Button { copyCommand(command, member: member.id) } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(copied ? CE.success : CE.ink2)
                    .frame(width: isMac ? 28 : 40, height: isMac ? 28 : 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("터미널 연결 명령 복사 · \(command)")
            .accessibilityLabel(copied ? "터미널 연결 명령 복사함" : "터미널 연결 명령 복사")
            Button("터미널 열기") { router.openTerminal(member.id) }
                .ceProminentButton().ceCompactControl()
                .help("여기서 답할 수 없는 창입니다. 화면을 보고 승인하거나 거절하세요.")
        }
        .padding(.leading, 4).padding(.trailing, 12).padding(.vertical, 1)
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
        let busy = batchBusy.contains(group)
        let armed = !single && (busy || batchArmed[group] == targets.map(\.id)) && !(batchArmed[group] ?? []).isEmpty
        return GroupFrame(single: single, wide: wide) {
            if !single {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .center, spacing: 10) {
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(alignment: .firstTextBaseline, spacing: 5) {
                                Text(group).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                                Text("· \(cards.count)건").font(CEFont.meta).foregroundStyle(CE.ink3).fixedSize()
                            }
                            if skipped > 0 && !targets.isEmpty {
                                Text("권장이 없거나 직접 고른 \(skipped)건은 따로 결정해 주세요").font(CEFont.meta).foregroundStyle(CE.ink3)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(.isHeader)
                        Spacer(minLength: 6)
                        if !targets.isEmpty && !armed {
                            Button("이 묶음 추천대로") { batchArmed[group] = targets.map(\.id); batchErrors[group] = nil }
                                .ceSecondaryButton().ceCompactControl()
                                .disabled(!gateOpen || busy)
                        }
                    }
                    .padding(.leading, 8).padding(.trailing, 2).padding(.top, 2)
                    if armed {
                        // While sending, the armed cards are in flight and no longer targets; keep showing what was confirmed.
                        let armedIDs = batchArmed[group] ?? []
                        ConfirmBar(quoted: nil, verb: "묶음 \(armedIDs.count)건 결정", hint: "각 카드의 권장안으로 결정합니다", busy: busy,
                                   disabled: !gateOpen, stretch: !wide, shiftedAt: shiftedAt,
                                   onConfirm: { Task { await runBatch(group, ids: armedIDs) } },
                                   onCancel: { batchArmed[group] = nil })
                            .padding(.horizontal, 8).padding(.bottom, 2)
                    }
                    if let error = batchErrors[group] { ErrorLine(text: error).padding(.horizontal, 8) }
                }
            }
        } content: {
            ForEach(cards) { decision in cardView(decision) }
        }
    }

    @ViewBuilder private func cardView(_ shown: Decision) -> some View {
        let id = shown.id
        let current = latest(id)
        if let current, current.status != "open", answeredHere.contains(id), !inFlight.contains(id) {
            Plate(padding: wide ? 16 : 14) {
                AnsweredBody(decision: current, asker: asker(current))
            }
            .overlay { FlashRing(on: flashID == id) }
            .id(id)
        } else {
            DecisionCard(
                review: reviewBinding(shown),
                memoOnly: memoOnlyBinding(shown),
                latest: current,
                asker: asker(shown),
                fileTitle: shown.fileId.flatMap { fileID in store.files.first { $0.id == fileID }?.title },
                wide: wide,
                locked: answerLock != nil,
                lockHint: lockHint,
                busy: inFlight.contains(id),
                error: cardErrors[id],
                flash: flashID == id,
                detailExpanded: expandedDetail.contains(id),
                canReopen: store.canWrite,
                reopenBusy: reopening.contains(id),
                reopenError: reopenErrors[id],
                shiftedAt: shiftedAt,
                onToggleDetail: { if expandedDetail.contains(id) { expandedDetail.remove(id) } else { expandedDetail.insert(id) } },
                onSubmit: { Task { await submit(id) } },
                onReviewLatest: { reviewLatest(id) },
                onReopen: { if let current { Task { await reopen(current, inPlace: true) } } },
                onOpenFile: { fileID in router.openFile(fileID) },
                onArm: { revealRequest = RevealRequest(target: confirmBarID(id)) }
            )
            .id(id)
        }
    }

    // MARK: Done view

    private var doneView: some View {
        let list = doneList
        let moreAvailable = (store.state?.doneDecisionCount ?? 0) > list.count && store.api != nil && !store.isDemo && !olderExhausted
        return VStack(alignment: .leading, spacing: CESpace.m) {
            if linkMissing { missingLinkNotice }
            if let notice = reopenedNotice {
                InlineNotice(tone: .accent, icon: "arrow.uturn.backward.circle", title: "다시 열었습니다",
                             detail: "'\(notice.title)'",
                             actionTitle: "결재할 항목 보기", action: { reopenedNotice = nil; router.decisionID = notice.id })
            }
            if list.isEmpty {
                Plate { CompactEmpty(icon: "tray", title: "결재된 항목이 없습니다", detail: "결정한 결재가 여기에 쌓입니다.") }
            } else {
                Plate(padding: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(list.enumerated()), id: \.element.id) { index, decision in
                            if index > 0 { Rectangle().fill(CE.line).frame(height: 1).padding(.horizontal, wide ? 16 : 14) }
                            doneRow(decision)
                        }
                    }
                    .padding(.vertical, 3)
                }
            }
            if moreAvailable {
                HStack {
                    Spacer(minLength: 0)
                    Button(loadingOlder ? "불러오는 중" : "더 불러오기") { Task { await loadOlder() } }
                        .ceSecondaryButton().ceCompactControl()
                        .disabled(loadingOlder || store.connectionStatus != .connected)
                    Spacer(minLength: 0)
                }
            }
            if let olderError { ErrorLine(text: olderError) }
        }
    }

    private func doneRow(_ decision: Decision) -> some View {
        let id = decision.id
        let expanded = expandedDone.contains(id)
        let hasMore = !decision.detail.isEmpty || !decision.images.isEmpty || decision.fileId != nil
        let reopenable = decision.status == "closed" && decision.closeKind != nil
        return VStack(alignment: .leading, spacing: 6) {
            AnsweredBody(decision: decision, asker: asker(decision))
            if reopenable || hasMore {
                HStack(spacing: 10) {
                    if hasMore {
                        Button {
                            withAnimation(.easeOut(duration: 0.18)) {
                                if expanded { expandedDone.remove(id) } else { expandedDone.insert(id) }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Text(expanded ? "배경 접기" : "배경 보기")
                                Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .bold))
                                    .rotationEffect(.degrees(expanded ? 180 : 0))
                            }
                            .frame(minHeight: isMac ? 24 : 40)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.accent)
                        .accessibilityLabel(expanded ? "\(decision.title) 배경 접기" : "\(decision.title) 배경 보기")
                    }
                    Spacer(minLength: 0)
                    if reopenable {
                        Button(reopening.contains(id) ? "여는 중" : "다시 열기") { Task { await reopen(decision, inPlace: false) } }
                            .ceSecondaryButton().ceCompactControl()
                            .disabled(!store.canWrite || reopening.contains(id))
                            .help("결재할 항목으로 돌아갑니다")
                    }
                }
            }
            if let error = reopenErrors[id] { ErrorLine(text: error) }
            if expanded && hasMore {
                VStack(alignment: .leading, spacing: 10) {
                    if !decision.detail.isEmpty { MarkdownText(text: decision.detail, font: CEFont.secondary).foregroundStyle(CE.ink) }
                    if !decision.images.isEmpty { ImageStrip(images: decision.images) }
                    if let fileID = decision.fileId {
                        FileChip(title: store.files.first { $0.id == fileID }?.title) { router.openFile(fileID) }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 11)
        .padding(.horizontal, wide ? 16 : 14)
        .background(CE.accent.opacity(flashID == id ? 0.1 : 0))
        .overlay { FlashRing(on: flashID == id, radius: 6) }
        .animation(.easeOut(duration: 0.35), value: flashID == id)
        .id(id)
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
            get: { reviews[id] ?? makeReview(decision) },
            set: { next in
                let previous = reviews[id] ?? makeReview(decision)
                reviews[id] = next
                if next.note != previous.note { drafts.setMemo(next.note, for: id) }
                if next.note != previous.note || next.choice != previous.choice { engaged.insert(id) }
                // A different pick changes the group's batch targets: ask again.
                if next.choice != previous.choice, let group = decision.group { batchArmed[group] = nil }
            })
    }

    private func memoOnlyBinding(_ decision: Decision) -> Binding<Bool> {
        let id = decision.id
        return Binding(
            get: { memoOnly.contains(id) },
            set: { value in
                if value { memoOnly.insert(id); engaged.insert(id) } else { memoOnly.remove(id) }
                if let group = decision.group { batchArmed[group] = nil }
            })
    }

    /// Open cards in a group the batch may answer: valid recommendation, not changed since review,
    /// and the local pick is unset or equals the recommendation.
    private func batchTargets(_ cards: [Decision]) -> [Decision] {
        cards.compactMap { card -> Decision? in
            guard let current = latest(card.id), current.status == "open", !inFlight.contains(card.id), !memoOnly.contains(card.id) else { return nil }
            let review = reviews[card.id] ?? makeReview(current)
            guard !review.isStale(comparedTo: current) else { return nil }
            guard let rec = current.rec, current.options.contains(where: { $0.k == rec }) else { return nil }
            return review.choice == nil || review.choice == rec ? review.decision : nil
        }
    }

    // MARK: - Sync with polling

    private func sync() {
        let byID = Dictionary(store.decisions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for decision in store.decisions where decision.status == "open" && reviews[decision.id] == nil {
            reviews[decision.id] = makeReview(decision)
        }
        for (id, review) in reviews where !inFlight.contains(id) && review.isStale(comparedTo: byID[id]) {
            if engaged.contains(id) && !answeredHere.contains(id) {
                // The person was working on this card: keep it, clear the pick, keep the memo, ask for review.
                if review.choice != nil { reviews[id]?.choice = nil }
                memoOnly.remove(id)
            } else if let current = byID[id], current.status == "open" {
                reviews[id] = makeReview(current)
            } else {
                reviews[id] = nil
            }
        }
        for (group, ids) in batchArmed where !batchBusy.contains(group) {
            let cards = liveDecisions.filter { $0.group == group }
            if batchTargets(cards).map(\.id) != ids { batchArmed[group] = nil }
        }
    }

    private func resetVisit(full: Bool) {
        answeredHere = []; engaged = []; cardErrors = [:]
        batchArmed = [:]; batchErrors = [:]; reopenErrors = [:]; reopenedNotice = nil
        if full {
            reviews = [:]; memoOnly = []; expandedDetail = []; expandedDone = []
            linkMissing = false
        }
    }

    private func resetProject() {
        resetVisit(full: true)
        olderDone = []; olderCursor = nil; olderExhausted = false; olderError = nil; loadingOlder = false
        reopening = []; segment = .open
    }

    // MARK: - Actions

    private func submit(_ id: String) async {
        guard gateOpen, !inFlight.contains(id), let review = reviews[id] else { return }
        let current = latest(id)
        let note = review.note.trimmingCharacters(in: .whitespacesAndNewlines)
        let noteOnly = memoOnly.contains(id) && !review.decision.options.isEmpty
        if noteOnly {
            guard review.decision.status == "open", !review.isStale(comparedTo: current), !note.isEmpty else { return }
        } else {
            guard review.canSubmit(comparedTo: current) else { return }
        }
        inFlight.insert(id)
        cardErrors[id] = nil
        let ok = await store.answerDecision(review.decision, choice: noteOnly ? nil : review.choice, note: note.isEmpty ? nil : note)
        inFlight.remove(id)
        if ok {
            answeredHere.insert(id)
            memoOnly.remove(id)
            drafts.clearMemo(id)
        } else {
            cardErrors[id] = store.errorMessage ?? "보내지 못했습니다. 연결을 확인하고 다시 시도해 주세요."
            sync()
        }
    }

    private func runBatch(_ group: String, ids: [String]) async {
        let cards = liveDecisions.filter { $0.group == group }
        let targets = batchTargets(cards)
        guard gateOpen, !batchBusy.contains(group), targets.map(\.id) == ids, !targets.isEmpty else { batchArmed[group] = nil; return }
        var notes: [String: String] = [:]
        for decision in targets {
            let memo = (reviews[decision.id]?.note ?? drafts.memo(for: decision.id) ?? decision.lastNote ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !memo.isEmpty { notes[decision.id] = memo }
        }
        batchBusy.insert(group)
        batchErrors[group] = nil
        for id in ids { inFlight.insert(id) }
        let result = await store.answerBatch(targets, notes: notes)
        for id in ids {
            inFlight.remove(id)
            if let current = latest(id), current.status != "open" {
                answeredHere.insert(id)
                drafts.clearMemo(id)
            }
        }
        batchBusy.remove(group)
        batchArmed[group] = nil
        if let first = result.failures.first { batchErrors[group] = "\(result.failures.count)건을 보내지 못했습니다: \(first)" }
        sync()
    }

    private func reviewLatest(_ id: String) {
        guard let current = latest(id) else { return }
        if reviews[id] == nil { reviews[id] = makeReview(current) } else { reviews[id]?.reviewLatest(current) }
        // A server reopen brings back the previous note unless the person wrote their own.
        if drafts.memo(for: id) == nil, reviews[id]?.note.isEmpty == true { reviews[id]?.note = current.lastNote ?? "" }
        memoOnly.remove(id)
        cardErrors[id] = nil
    }

    private func reopen(_ decision: Decision, inPlace: Bool) async {
        guard store.canWrite, !reopening.contains(decision.id) else { return }
        reopening.insert(decision.id)
        reopenErrors[decision.id] = nil
        let ok = await store.reopenDecision(decision)
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
        do {
            let page: [Decision] = try await api.request(path)
            guard store.selectedProjectID == projectID else { return }
            let known = Set(olderDone.map(\.id)).union(store.decisions.map(\.id))
            olderDone += page.filter { !known.contains($0.id) }
            if let oldest = page.map(pagingKey).min() { olderCursor = oldest }
            if page.count < 50 { olderExhausted = true }
        } catch {
            if store.selectedProjectID == projectID { olderError = error.localizedDescription }
        }
        loadingOlder = false
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
        let target: InboxSegment = decision.status == "open" || answeredHere.contains(id) || engaged.contains(id) ? .open : .done
        if target == .done { expandedDone.insert(id) }
        if segment != target { segment = target }
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
        Task { @MainActor in
            do {
                let found: Decision = try await api.request("/api/decisions/\(APIClient.segment(id))")
                if resolvingLink == id { resolvingLink = nil }
                guard store.selectedProjectID == projectID, router.decisionID == id else { return }
                guard found.projectId.isEmpty || found.projectId == projectID else { linkMissing = true; router.decisionID = nil; return }
                // Open cards arrive with the next poll and are handled then.
                if found.status != "open", !olderDone.contains(where: { $0.id == id }) { olderDone.append(found) }
            } catch {
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
    /// Option card: "메모만 보내기" chosen. Free-answer card: "답 보내기" pressed. Either way the confirm bar shows.
    @Binding var memoOnly: Bool
    let latest: Decision?
    let asker: Member?
    let fileTitle: String?
    let wide: Bool
    let locked: Bool
    /// Placeholder for the disabled field while locked (nil keeps the normal placeholder).
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

    private var decision: Decision { review.decision }
    private var stale: Bool { !busy && review.isStale(comparedTo: latest) }
    private var whoName: String { decision.who.isEmpty ? "담당자" : decision.who }
    private var free: Bool { decision.options.isEmpty }
    private var typed: Bool { !review.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var picked: DecisionOption? { decision.options.first { $0.k == review.choice } }
    private var showsConfirm: Bool {
        decision.status == "open" && !stale && (picked != nil || (memoOnly && typed))
    }

    var body: some View {
        Plate(padding: wide ? 16 : 14) {
            VStack(alignment: .leading, spacing: 10) {
                if decision.status == "open" {
                    header
                    if stale { staleNotice }
                    reopenLine
                    Text(decision.title).font(CEFont.title).foregroundStyle(CE.ink).fixedSize(horizontal: false, vertical: true)
                    if !decision.detail.isEmpty {
                        ClampedDetail(text: decision.detail, lines: wide ? 4 : 5, expanded: detailExpanded, onToggle: onToggleDetail)
                    }
                    if !decision.images.isEmpty { ImageStrip(images: decision.images) }
                    if let fileID = decision.fileId { FileChip(title: fileTitle) { onOpenFile(fileID) } }
                    answerArea
                } else {
                    // The person reviewed the latest version and it is no longer open.
                    AnsweredBody(decision: decision, asker: asker)
                    if stale { staleNotice }
                    resolvedFooter
                }
            }
        }
        .overlay { FlashRing(on: flash) }
        // Only transitions caused on screen arm a reveal; a card that appears already armed does not scroll.
        .onChange(of: showsConfirm) { _, shown in if shown { onArm() } }
        // A free answer cleared after "답 보내기" has nothing left to send: disarm.
        .onChange(of: typed) { _, now in if !now && memoOnly { memoOnly = false } }
    }

    /// Quiet "who · time" line. The dot is the asker's CLI state (waiting, working, asleep…).
    private var header: some View {
        let state = asker.map { MemberStatusInfo($0.status) }
        return HStack(alignment: .center, spacing: 7) {
            StatusDot(tone: state?.tone ?? .attention)
            Text(whoName).font(CEFont.secondary.weight(.semibold)).foregroundStyle(CE.ink).lineLimit(1)
            Spacer(minLength: 6)
            Text(relativeTime(decision.createdAt)).font(CEFont.meta).foregroundStyle(CE.ink3).fixedSize()
        }
        .help(state.map { "\(whoName) · \($0.label)" } ?? whoName)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([whoName, state?.label, relativeTime(decision.createdAt)].compactMap { $0 }.joined(separator: ", "))
    }

    @ViewBuilder private var reopenLine: some View {
        if let note = decision.reopenNote, !note.isEmpty {
            let last = decision.lastChoice.map { key in decision.options.first { $0.k == key }?.label ?? key }
            Label {
                Text(last.map { "\(note) · 직전 답: \($0)" } ?? note).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "arrow.uturn.backward.circle")
            }
            .font(CEFont.secondary).foregroundStyle(CE.danger)
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
            Text("결재된 항목으로 옮겨집니다").font(CEFont.meta).foregroundStyle(CE.ink3)
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

    // MARK: Answer area

    @ViewBuilder private var answerArea: some View {
        let typed = self.typed
        let picked = self.picked
        if !free { options(disabled: locked || busy || stale) }
        HStack(alignment: .bottom, spacing: 8) {
            TextField((locked ? lockHint : nil) ?? (free ? "답을 적어 주세요" : "메모 (선택) — 다른 생각이나 조건"), text: $review.note, axis: .vertical)
                .lineLimit(1...6)
                .font(CEFont.body)
                .ceField()
                .disabled(locked || busy)
                .onSubmit { if free && typed && !locked && !busy && !stale { memoOnly = true } }
                .accessibilityLabel(free ? "답" : "메모")
            if free && !memoOnly && !stale {
                Button("답 보내기") { memoOnly = true }
                    .ceSecondaryButton().fixedSize()
                    .disabled(!typed || locked || busy)
            } else if !free && typed && picked == nil && !memoOnly && !stale {
                Button("메모만 보내기") { memoOnly = true }
                    .ceSecondaryButton().fixedSize()
                    .disabled(locked || busy)
            }
        }
        if showsConfirm {
            let quoted = picked?.label ?? (free ? plainOneLine(review.note) : nil)
            ConfirmBar(
                quoted: quoted,
                verb: quoted.map { "\(particleRo($0)) 결정" } ?? "메모만 보내기로 결정",
                hint: picked != nil && typed ? "메모도 함께 보냅니다" : nil,
                busy: busy,
                disabled: locked,
                stretch: !wide,
                shiftedAt: shiftedAt,
                onConfirm: onSubmit,
                onCancel: { review.choice = nil; memoOnly = false })
            .id(confirmBarID(decision.id))
        }
        if let error { ErrorLine(text: error) }
    }

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
private struct OptionTile: View {
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
        Button(action: action) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .center, spacing: 7) {
                    Text(option.label).font(labelFont).foregroundStyle(isEnabled || picked ? CE.ink : CE.ink2)
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    if recommended { RecommendedBadge() }
                    if wasLastChoice { Tag("직전 답") }
                    Spacer(minLength: 0)
                    if picked {
                        Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                            .accessibilityHidden(true)
                    }
                }
                if let desc = option.desc, !desc.isEmpty {
                    Text(desc).font(CEFont.secondary).foregroundStyle(CE.ink2)
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .frame(maxWidth: .infinity, minHeight: isMac ? 44 : 48, maxHeight: .infinity, alignment: .topLeading)
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

/// Web accent badge: white text on the violet fill.
private struct RecommendedBadge: View {
    var body: some View {
        Text("권장")
            .font(CEFont.micro).foregroundStyle(.white)
            .padding(.horizontal, 7).frame(minHeight: 18)
            .background(CE.accentFill, in: Capsule())
            .fixedSize()
    }
}

/// Quiet press feedback; disabled options stay readable (locked cards, sample mode).
private struct OptionPressStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .brightness(configuration.isPressed ? 0.06 : 0)
            .opacity(isEnabled ? 1 : 0.78)
    }
}

// MARK: - Confirm bar (second step; nothing is sent on the first tap)

private struct ConfirmBar: View {
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
    @State private var shownAt = Date.distantFuture

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let hint { Text(hint).font(CEFont.secondary).foregroundStyle(CE.ink2).padding(.horizontal, 2) }
            HStack(spacing: 8) {
                Button {
                    // A double tap's second half, or a tap right after cards moved, is not a confirmation.
                    let now = Date()
                    guard now.timeIntervalSince(shownAt) >= 0.6, now.timeIntervalSince(shiftedAt) >= 0.5 else { return }
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
                Button("취소", action: onCancel).ceSecondaryButton().disabled(busy).fixedSize()
                if !stretch { Spacer(minLength: 0) }
            }
        }
        .onAppear { shownAt = Date() }
    }
}

// MARK: - Answered / closed rendering

private struct AnsweredBody: View {
    let decision: Decision
    let asker: Member?

    private var closed: Bool { decision.status == "closed" }
    private var who: String { decision.who.isEmpty ? "담당자" : decision.who }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 8) {
                Text(who).font(CEFont.secondary.weight(.semibold)).foregroundStyle(CE.ink).lineLimit(1)
                if closed { Tag("닫힘", tone: .dim) } else { AnswerFlow(decision: decision) }
                Spacer(minLength: 6)
                Text(relativeTime(decision.answeredAt ?? decision.closedAt ?? decision.createdAt)).font(CEFont.meta).foregroundStyle(CE.ink3).fixedSize()
            }
            Text(decision.title).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(2)
            if closed {
                Text("닫힘" + (decision.closeReason.map { " · \($0)" } ?? ""))
                    .font(CEFont.secondary).foregroundStyle(CE.ink2).fixedSize(horizontal: false, vertical: true)
                let meta = [closeKindName(decision.closeKind), decision.closedBy.map { "닫은 이: \($0)" }].compactMap { $0 }
                if !meta.isEmpty { Text(meta.joined(separator: " · ")).font(CEFont.meta).foregroundStyle(CE.ink3) }
                if let quote = decision.closeQuote, !quote.isEmpty {
                    Text("근거로 든 대표 말: '\(quote)'").font(CEFont.meta).foregroundStyle(CE.ink3).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                if let label = answerLabel { Text("답: \(label)").font(CEFont.secondary).foregroundStyle(CE.ink2).fixedSize(horizontal: false, vertical: true) }
                if let note = decision.note, !note.isEmpty {
                    Text("메모: \(note)").font(CEFont.secondary).foregroundStyle(CE.ink2).lineLimit(3)
                }
                if decision.status == "answered", let asker, ["blocked", "error", "asleep", "offline"].contains(asker.status) {
                    let info = MemberStatusInfo(asker.status)
                    Label("\(asker.name)\(particleIGa(asker.name)) '\(info.label)' 상태라 아직 받지 못했습니다", systemImage: info.icon)
                        .font(CEFont.meta).foregroundStyle(CE.attention).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

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
        HStack(spacing: 4) {
            Text("보냄").foregroundStyle(CE.success)
            Image(systemName: "arrow.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(CE.ink3)
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
            item(.open, title: "결재할 항목", count: openCount)
            item(.done, title: "결재된 항목", count: doneCount)
        }
        // Scoped to the pill: only the drop slides; the list below swaps without animating every card.
        .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.82), value: segment)
        .padding(3)
        .cardPill()
        .fixedSize(horizontal: !stretch, vertical: false)
        .frame(maxWidth: stretch ? .infinity : nil, alignment: .leading)
    }

    private func item(_ value: InboxSegment, title: String, count: Int) -> some View {
        let selected = segment == value
        return Button { segment = value } label: {
            HStack(spacing: 6) {
                Text(title)
                Text("\(count)").fontWeight(.bold).monospacedDigit()
            }
            .font(segmentFont)
            .foregroundStyle(selected ? Color.white : CE.ink2)
            .lineLimit(1)
            .padding(.horizontal, 14)
            .frame(maxWidth: stretch ? .infinity : nil, minHeight: isMac ? 30 : 40)
            .background {
                if selected {
                    Capsule().fill(CE.violet.opacity(0.42))
                        .overlay { Capsule().strokeBorder(CE.violet.opacity(0.9)) }
                        .shadow(color: CE.violet.opacity(0.45), radius: 10, y: 2)
                        .matchedGeometryEffect(id: "drop", in: drop)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
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

/// Background text clamped to a few lines; "더 보기" appears only when something is actually cut off.
/// Collapsed it is one inline-markdown text (lists as bullets); expanded it is the full markdown.
private struct ClampedDetail: View {
    let text: String
    let lines: Int
    let expanded: Bool
    let onToggle: () -> Void
    @State private var clampedHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0
    private var truncated: Bool { fullHeight > clampedHeight + 2 }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if expanded {
                MarkdownText(text: text).foregroundStyle(CE.ink)
            } else {
                let preview = previewText
                Text(preview).font(CEFont.body).foregroundStyle(CE.ink).lineSpacing(4).lineLimit(lines)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { clampedHeight = $0 }
                    .background(alignment: .topLeading) {
                        Text(preview).font(CEFont.body).lineSpacing(4)
                            .fixedSize(horizontal: false, vertical: true)
                            .hidden()
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                    }
            }
            if expanded || truncated {
                Button(action: onToggle) {
                    HStack(spacing: 4) {
                        Text(expanded ? "접기" : "더 보기")
                        Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .bold))
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .frame(minHeight: isMac ? 22 : 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.accent)
            }
        }
    }

    private var previewText: AttributedString {
        var out: [String] = []
        var inCode = false
        for raw in text.components(separatedBy: "\n") {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") { inCode.toggle(); continue }
            if inCode { out.append(raw); continue }
            while line.hasPrefix("#") { line.removeFirst() }
            line = line.trimmingCharacters(in: .whitespaces)
            for marker in ["- ", "* "] where line.hasPrefix(marker) { line = "• " + line.dropFirst(marker.count) }
            out.append(line)
        }
        let joined = out.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return inlineMarkdown(joined)
    }
}

/// Decision images as a row of thumbnails (scrolls sideways when there are several).
private struct ImageStrip: View {
    let images: [Attachment]
    var body: some View {
        if images.count == 1, let image = images.first {
            AttachmentPreview(attachment: image).frame(maxWidth: 260, alignment: .leading)
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(images) { image in AttachmentPreview(attachment: image).frame(width: 200) }
                }
            }
        }
    }
}

/// Web .ibx-file: "자료 보기: 제목" opens the file in 자료.
private struct FileChip: View {
    let title: String?
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: "doc.text").font(.system(size: 12, weight: .medium))
                Text(title.map { "자료 보기: \($0)" } ?? "자료 보기").lineLimit(1).truncationMode(.middle)
            }
            .font(CEFont.secondary.weight(.medium)).foregroundStyle(CE.accent)
            .padding(.leading, 11).padding(.trailing, 13)
            .frame(minHeight: isMac ? 30 : 44)
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

private struct ErrorLine: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "exclamationmark.circle")
            .font(CEFont.meta).foregroundStyle(CE.danger).fixedSize(horizontal: false, vertical: true)
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

private func inlineMarkdown(_ value: String) -> AttributedString {
    (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value)
}

/// An answer must refer to the exact content the person reviewed, even while polling updates the store.
struct DecisionReview {
    private(set) var decision: Decision
    var choice: String?
    var note: String

    init(decision: Decision) {
        self.decision = decision
        choice = decision.options.contains(where: { $0.k == decision.lastChoice }) ? decision.lastChoice : nil
        note = decision.lastNote ?? ""
    }
    func isStale(comparedTo latest: Decision?) -> Bool {
        guard let latest else { return true }
        return latest.id != decision.id || latest.updatedAt != decision.updatedAt || latest.status != decision.status
    }
    func canSubmit(comparedTo latest: Decision?) -> Bool {
        guard decision.status == "open", !isStale(comparedTo: latest) else { return false }
        if decision.options.isEmpty { return !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return decision.options.contains { $0.k == choice }
    }
    mutating func reviewLatest(_ latest: Decision) {
        guard latest.id == decision.id else { return }
        decision = latest
        choice = nil
        // The person's draft is deliberately retained; refreshed server notes cannot replace it.
    }
}
