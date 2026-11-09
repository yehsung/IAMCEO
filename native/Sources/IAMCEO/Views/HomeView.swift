import SwiftUI

/// 홈 — "지금". It answers four questions, in this order, and nothing else:
/// 지금 상황 (what is going on) · 내 차례 (what waits on me) · 팀 (who is working on what) · 진척 (how far along),
/// plus 최근 (the latest results). Mac/iPad: 지금 상황 full width, then 내 차례 | 팀·진척·최근. iPhone: one column.
/// Cards with nothing to show are not drawn. Rows are compact (mark · title · quiet context · at most one action);
/// explanations live in tooltips and details. CLI state is never presented as task completion.
struct HomeView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.ceWide) private var wide
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    #endif

    @State private var width: CGFloat = isMac ? 900 : 0
    @State private var nowExpanded = false
    @State private var nowFullHeight: CGFloat = 0
    /// Five lines of the 지금 상황 body (web .hm-now__body: 14.5px × 1.6 × 5 = 116).
    @ScaledMetric(relativeTo: .body) private var nowClampHeight: CGFloat = isMac ? 116 : 120
    /// Mac: the pointing hand pushed while the pointer is over the collapsed 지금 상황 body.
    @State private var nowCursorPushed = false
    @State private var tidyNote: HomeNote?
    /// iPhone/iPad: 판 정리 asks once (no tooltip there, and the circular-arrows mark reads as "refresh").
    @State private var confirmTidy = false
    @State private var startError: String?
    @State private var expandedTodos: Set<String> = []
    @State private var showDoneTodos = false
    @State private var contextID = UUID()
    @State private var todoError: String?
    @State private var lastTodoShift = Date.distantPast

    /// The shared content column (`ceContentColumn`): 880 wide including the gutters, as the web .shell__column.
    private static let columnWidth: CGFloat = 880
    private static let topDecisions = 3

    /// A decision open for 6 hours or more: it is probably holding someone's work.
    static func waitedLong(_ decision: Decision, now: Date = Date()) -> Bool {
        guard let created = parseISODate(decision.createdAt) else { return false }
        return now.timeIntervalSince(created) >= 6 * 3600
    }

    /// "9시간째" / "2일째" for a card that has waited long, nil otherwise.
    static func waitedLabel(_ decision: Decision, now: Date = Date()) -> String? {
        guard waitedLong(decision, now: now), let created = parseISODate(decision.createdAt) else { return nil }
        let hours = Int(now.timeIntervalSince(created) / 3600)
        return hours >= 48 ? "\(hours / 24)일째 기다림" : "\(hours)시간째 기다림"
    }
    private static let topMembers = 5
    /// Web TOP_WORK: up to five work rows.
    private static let topNextWork = 5
    private static let topWorkRows = 5
    /// Web TOP_REPORTS.
    private static let topRecent = 5
    /// Web .hm-row__title 14.5 at 1.4, two lines at most.
    private static let rowTitleLeading = CELeading.spacing(14.5, 1.4)
    /// 팀 summary: fixed order, zero counts dropped. 승인 창 앞 and 오류 are not counted here: they are in 내 차례.
    private static let summaryParts: [(status: String, label: String)] = [
        ("working", "일하는 중"), ("waiting", "내 답 기다림"), ("idle", "쉬는 중"), ("asleep", "잠듦"), ("offline", "안 보임"),
    ]
    private static let tidyHint = "결재·할 일·진행판을 지금 상태로 맞춥니다"
    private static let readOnlyHelp = "샘플은 읽기 전용입니다"

    var body: some View {
        if let state = store.state {
            content(state)
        } else {
            placeholder
        }
    }

    // MARK: - Derived data

    private var hPad: CGFloat { isMac ? 24 : 16 }
    private var contentWidth: CGFloat { min(width, Self.columnWidth) - hPad * 2 }
    /// Web: auto-fit columns of at least 320.
    private var twoColumn: Bool { wide && contentWidth >= 652 }
    private var isHq: Bool { store.state?.project.isHq == true }
    private var leadLabel: String { isHq ? "본사 AI" : "총괄" }
    /// Web .hm-row / .hm-check: 44 on every platform.
    private var rowMinHeight: CGFloat { 44 }
    /// 내 차례: every row has the same 22pt leading column (glyph or checkbox), so titles start here
    /// (web: 44 check − 11 margin + 2 padding = 35).
    private var titleInset: CGFloat { (rowMinHeight + 22) / 2 + 2 }
    private var glyphGap: CGFloat { titleInset - 22 }

    private var openDecisions: [Decision] { newestFirst(store.decisions.filter { $0.status == "open" }) }
    private var attention: HomeAttention { HomeAttention(members: store.members, notices: store.deliveryNotices, messages: store.messages) }

    private func todoBusy(_ id: String) -> Bool {
        store.pendingActions.contains("todo:\(id)") || [.sending, .checking].contains(store.todoWrites[id])
    }
    private func todoNeedsNotice(_ id: String) -> Bool { todoBusy(id) || store.todoWrites[id] == .conflict }
    /// AI가 '필요 없어짐'으로 정리한 할 일은 할 일도, 한 일도 아니다.
    private var visibleTodos: [Todo] { store.todos.filter { $0.outcome != "dropped" || todoNeedsNotice($0.id) }.sorted { $0.createdAt < $1.createdAt } }
    private var liveTodos: [Todo] { visibleTodos.filter { !$0.done || todoNeedsNotice($0.id) } }
    /// Same order reversed: newest-created first.
    private var doneTodos: [Todo] { visibleTodos.filter { $0.done && !todoNeedsNotice($0.id) }.reversed() }

    private func work(_ section: WorkSection) -> [WorkItem] {
        store.work.filter { $0.sec == section.rawValue }.sorted { $0.order < $1.order }
    }

    private func memberName(_ id: String?) -> String? { id.flatMap { id in store.members.first { $0.id == id }?.name } }
    /// Chat target for a member's report: workers get their own thread, the lead lives in the project conversation.
    private func chatTarget(for memberID: String?) -> String? {
        guard let memberID, store.members.first(where: { $0.id == memberID })?.kind == "worker" else { return nil }
        return memberID
    }

    // MARK: - Layout

    private func content(_ state: ProjectState) -> some View {
        let turn = turnRows(attention)
        return ScrollView {
            VStack(alignment: .leading, spacing: CESpace.m) {
                gateCard(state.project)
                nowCard(state.project)
                columns(turn)
            }
            .ceContentColumn()
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .refreshable { await store.refresh() }
        .onChange(of: store.selectedProjectID) { _, _ in resetLocalState() }
        .onChange(of: store.drafts.namespace) { _, _ in resetLocalState() }
        // Any row that moves inside 내 차례 can put another todo under the pointer.
        .onChange(of: turn.rows.map(\.id)) { _, _ in lastTodoShift = Date() }
        .onChange(of: turn.waiting) { _, _ in lastTodoShift = Date() }
    }

    /// Mac/iPad: left = 내 차례 (the primary card), right = 팀 · 진척 · 최근.
    /// iPhone: one column, 내 차례 → 팀 → 진척 → 최근. An empty column gives its width to the other.
    /// Nothing waiting (finished todos may remain): one full-width quiet line instead of the card, with the 완료 fold
    /// at its end, and the right-column cards take the full width under it.
    @ViewBuilder private func columns(_ turn: HomeTurn) -> some View {
        let hasLeft = turn.waiting
        let hasRight = !store.members.isEmpty || !store.work.isEmpty || !recentItems.isEmpty
        if !hasLeft { clearBlock(turn.rows) }
        if twoColumn && hasLeft && hasRight {
            HStack(alignment: .top, spacing: CESpace.m) {
                turnCard(turn)
                    .frame(maxWidth: .infinity)
                VStack(spacing: CESpace.m) {
                    teamCard
                    progressCard
                    recentCard
                }
                .frame(maxWidth: .infinity)
            }
        } else {
            if hasLeft { turnCard(turn) }
            teamCard
            progressCard
            recentCard
        }
    }

    /// Notes and folds belong to one project; never show them on another.
    private func resetLocalState() {
        contextID = UUID()
        nowExpanded = false; confirmTidy = false
        tidyNote = nil; startError = nil; todoError = nil
        expandedTodos = []; showDoneTodos = false
    }

    /// No project state yet: one centred note at the top of the same column the home cards use.
    @ViewBuilder private var placeholder: some View {
        Group {
            if store.isLoading || store.connectionStatus == .connecting {
                EmptyTile(loading: true, title: "프로젝트를 불러오는 중입니다")
            } else if store.projects.isEmpty {
                EmptyTile(icon: "folder.badge.plus", title: "아직 프로젝트가 없습니다",
                          detail: "새 프로젝트를 만들면 총괄이 팀을 꾸리고 지금 상황을 여기에 정리합니다.") {
                    Button("새 프로젝트") { router.showNewProject = true }
                        .ceProminentButton()
                        .disabled(!store.canWrite)
                }
            } else {
                EmptyTile(icon: "exclamationmark.circle", title: "프로젝트를 불러오지 못했습니다",
                          detail: store.connectionStatus == .connected ? "다시 불러오거나 다른 프로젝트를 고르세요." : "서버에 다시 연결되면 불러올 수 있습니다.") {
                    Button("다시 불러오기") {
                        Task { if let id = store.selectedProjectID ?? store.projects.first?.id { await store.selectProject(id: id) } }
                    }
                    .ceSecondaryButton()
                    .disabled(store.connectionStatus != .connected)
                }
            }
        }
        .ceContentColumn()
        .frame(maxHeight: .infinity, alignment: .top)
    }

    // MARK: - 연결 게이트

    /// Web ConnectGate: the reason in bold and the one step that fixes it. Server-down is the global status strip's.
    @ViewBuilder private func gateCard(_ project: Project) -> some View {
        if !store.isDemo && !project.connection.ok {
            let reason = project.connection.reason
            // Web .gate: radius 20, padding 10 10 10 16, gap 8 × 14, text 14/1.5 (650 ink-1 for the reason),
            // the action a glass size m button (44pt, 15/600).
            let textFont: Font = isMac ? .system(size: 14, weight: .semibold) : CEFont.rowTitle
            Plate(padding: 0, radius: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .center, spacing: 14) {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: gateIcon(reason))
                                .font(textFont)
                                .foregroundStyle(reason == "backend_down" ? CE.danger : CE.attention)
                                .accessibilityHidden(true)
                            Text(project.connection.ownerDetail ?? gateFallback(reason))
                                .font(textFont).foregroundStyle(CE.ink)
                                .lineSpacing(CELeading.spacing(14, 1.5))
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        gateAction(reason)
                    }
                    if let startError { HomeNoteLine(note: HomeNote(text: startError, tone: .danger)) }
                }
                .padding(.leading, isMac ? 16 : 14).padding(.trailing, 10).padding(.vertical, 10)
            }
            .accessibilityElement(children: .contain)
        }
    }

    private func gateIcon(_ reason: String?) -> String {
        switch reason {
        case "runner_off": "power"
        case "backend_down": "bolt.horizontal.circle"
        case "archived": "archivebox"
        default: "exclamationmark.circle"
        }
    }

    private func gateFallback(_ reason: String?) -> String {
        switch reason {
        case "runner_off": "AI가 아직 연결되지 않았습니다"
        case "backend_down": "실행 환경에 연결할 수 없습니다"
        case "archived": "보관된 프로젝트입니다"
        default: "연결을 확인해 주세요"
        }
    }

    @ViewBuilder private func gateAction(_ reason: String?) -> some View {
        switch reason {
        case "runner_off":
            let starting = store.pendingActions.contains("conductor-start")
            Button(starting ? "시작하는 중" : "\(leadLabel) 시작") {
                Task {
                    startError = nil
                    if !(await store.startConductor()) {
                        startError = "\(leadLabel) 시작에 실패했습니다." + (store.errorMessage.map { " \($0)" } ?? "")
                    }
                }
            }
            // The one action that unblocks everything: the web's size m (44pt), not the dense in-row size.
            .ceProminentButton()
            .controlSize(.regular)
            .fixedSize()
            .disabled(!store.canWrite || starting)
        case "backend_down":
            Button("실행 환경 보기") {
                #if os(macOS)
                openSettings()
                #else
                router.showSettings = true
                #endif
            }
            .ceSecondaryButton()
            .controlSize(.regular)
            .fixedSize()
        default:
            EmptyView()
        }
    }

    // MARK: - 지금 상황 (+ 판 정리)

    /// The lead's own summary. Always drawn so 판 정리 stays reachable; the tidy action sits in the header with the
    /// last tidy time beside it (web TidyBar: "마지막 판 정리 3분 전 · 지금 판 정리").
    private func nowCard(_ project: Project) -> some View {
        let hasNow = !project.now.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return HomeCard(title: "지금 상황", meta: hasNow ? relativeTime(project.nowAt) : nil) {
            tidyAccessory(project)
        } content: {
            VStack(alignment: .leading, spacing: 6) {
                if hasNow {
                    nowBody(project.now)
                } else {
                    Text("아직 요약이 없습니다 — 판 정리를 맡기면 \(isHq ? "본사 AI가" : "총괄이") 정리합니다")
                        .font(CEFont.note).foregroundStyle(CE.ink2)
                        .lineSpacing(CELeading.note)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 2)
                }
                if let tidyNote { HomeNoteLine(note: tidyNote).padding(.bottom, 2) }
            }
            // CSS half-leading above the first line.
            .padding(.top, 2)
        }
    }

    /// The last tidy time (the hint when there was none), then the button. The time drops first when the header is
    /// narrow (iPhone): the confirmation there repeats it.
    private func tidyAccessory(_ project: Project) -> some View {
        let last = relativeTime(project.tidiedAt)
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                Text(last.isEmpty ? Self.tidyHint : "마지막 판 정리 \(last)")
                    .font(CEFont.meta).monospacedDigit().foregroundStyle(CE.ink2)
                    .lineLimit(1).fixedSize()
                    // The button's hint already says it.
                    .accessibilityHidden(true)
                tidyButton(project)
            }
            tidyButton(project)
        }
        .confirmationDialog("지금 판 정리", isPresented: $confirmTidy, titleVisibility: .visible) {
            Button("\(leadLabel)에게 맡기기") { Task { await tidy() } }
                .disabled(!store.uiCanWrite)
            Button("취소", role: .cancel) {}
        } message: {
            Text("\(isHq ? "본사 AI가" : "총괄이") \(Self.tidyHint)." + (last.isEmpty ? "" : "\n마지막 판 정리 \(last)"))
        }
        // Offered the header's room before the spacer, so the time shows whenever it fits.
        .layoutPriority(1)
    }

    /// A labelled capsule ("판 정리") on every platform: the circular arrows alone read as "refresh". Mac runs it at
    /// once, with the explanation in the tooltip; iPhone/iPad (no tooltip, next to pull-to-refresh) asks once before
    /// it hands the lead a turn.
    private func tidyButton(_ project: Project) -> some View {
        let busy = store.pendingActions.contains("tidy")
        let last = relativeTime(project.tidiedAt)
        let detail = Self.tidyHint + (last.isEmpty ? "" : " · 마지막 판 정리 \(last)")
        return HomeIconButton(icon: "arrow.triangle.2.circlepath", title: busy ? "맡기는 중" : "판 정리", busy: busy) {
            if isMac { Task { await tidy() } } else { confirmTidy = true }
        }
        .disabled(!store.uiCanWrite || busy)
        .help(store.isDemo ? Self.readOnlyHelp : busy ? "판 정리를 맡기는 중입니다" : "지금 판 정리 — \(detail)")
        .accessibilityLabel(busy ? "판 정리를 맡기는 중" : "지금 판 정리")
        .accessibilityHint(store.isDemo ? Self.readOnlyHelp : detail)
    }

    private func tidy() async {
        let lead = leadLabel
        tidyNote = nil
        let note: HomeNote
        if let already = await store.tidyBoard() {
            note = HomeNote(text: already ? "판 정리 지시가 이미 기다리고 있습니다" : "\(lead)에게 판 정리를 맡겼습니다. 바뀐 게 있으면 대화에 알립니다", tone: .neutral)
        } else {
            note = HomeNote(text: "판 정리를 맡기지 못했습니다." + (store.errorMessage.map { " \($0)" } ?? ""), tone: .danger)
        }
        withAnimation(.easeOut(duration: 0.2)) { tidyNote = note }
        // Like the web, a failure stays until the next try; the confirmation fades after 6 s.
        guard note.tone != .danger else { return }
        try? await Task.sleep(for: .seconds(6))
        if tidyNote?.id == note.id { withAnimation(.easeOut(duration: 0.2)) { tidyNote = nil } }
    }

    private func nowBody(_ now: String) -> some View {
        let overflows = nowFullHeight > nowClampHeight + 4
        let collapsed = overflows && !nowExpanded
        return VStack(alignment: .leading, spacing: 4) {
            // Web .hm-now__body .md: 14.5 at 1.6.
            MarkdownText(text: now, size: 14.5, lineHeight: 1.6)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { nowFullHeight = $0 }
                .frame(maxHeight: collapsed ? nowClampHeight : nil, alignment: .top)
                .clipped()
                .mask {
                    if collapsed {
                        LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.7), .init(color: .black.opacity(0), location: 1)],
                                       startPoint: .top, endPoint: .bottom)
                    } else {
                        Rectangle()
                    }
                }
                // The faded body itself opens it (the 더 보기 button stays for keyboard and VoiceOver).
                .contentShape(Rectangle())
                .gesture(TapGesture().onEnded {
                    guard collapsed else { return }
                    setNowCursor(false)
                    withAnimation(.easeOut(duration: 0.2)) { nowExpanded = true }
                }, including: collapsed ? .all : .subviews)
                .onHover { setNowCursor($0 && collapsed) }
                .onChange(of: collapsed) { _, isCollapsed in if !isCollapsed { setNowCursor(false) } }
                .onDisappear { setNowCursor(false) }
            if overflows {
                HomeFoldButton(title: nowExpanded ? "접기" : "더 보기", open: nowExpanded) {
                    withAnimation(.easeOut(duration: 0.2)) { nowExpanded.toggle() }
                }
                .accessibilityLabel(nowExpanded ? "지금 상황 접기" : "지금 상황 더 보기")
            }
        }
        .padding(.bottom, overflows ? 0 : 2)
    }

    /// Mac: a pointing hand over the collapsed body, popped exactly once however the hover ends.
    private func setNowCursor(_ on: Bool) {
        #if os(macOS)
        guard on != nowCursorPushed else { return }
        if on { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        nowCursorPushed = on
        #endif
    }

    /// Web .hm-clear: nothing waits on me — a quiet full-width line, not a card. Finished todos fold into its trailing
    /// end ("완료한 할 일 n"); opened, they list under it, where unchecking still works. Also carries a todo error and
    /// the resend note, which have no card to sit in here.
    private func clearBlock(_ rows: [HomeTurnRow]) -> some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        let fold = rows.lazy.compactMap { row -> Int? in if case .doneFold(let count) = row { count } else { nil } }.first
        let rest = rows.filter { if case .doneFold = $0 { false } else { true } }
        // The fold's 44pt hit area overlaps the line's padding instead of making the line taller.
        let foldPull: CGFloat = -12
        // Web .hm-clear: 14 at 1.5.
        let font: Font = isMac ? .system(size: 14) : CEFont.body
        let leading = CELeading.spacing(isMac ? 14 : 15, 1.5)
        return VStack(alignment: .leading, spacing: 0) {
            if let fold {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) {
                        clearText.font(font).fixedSize()
                        Spacer(minLength: 12)
                        doneFoldButton(fold).fixedSize().padding(.vertical, foldPull)
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        clearText.font(font).lineSpacing(leading).fixedSize(horizontal: false, vertical: true)
                        doneFoldButton(fold).padding(.top, foldPull + 6).padding(.bottom, foldPull - 2)
                    }
                }
            } else {
                clearText.font(font).lineSpacing(leading).fixedSize(horizontal: false, vertical: true)
            }
            if !rest.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rest.enumerated()), id: \.element.id) { index, row in
                        if index > 0 || row.dividerAbove { HomeDivider() }
                        if case .todoError(let text) = row {
                            HomeNoteLine(note: HomeNote(text: text, tone: .danger)).padding(.vertical, 6)
                        } else {
                            turnRow(row)
                        }
                    }
                }
                .padding(.top, 10).padding(.bottom, -6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Color(red: 12 / 255, green: 9 / 255, blue: 28 / 255).opacity(0.5), in: shape)
        .overlay { shape.strokeBorder(CE.line) }
    }

    private var clearText: Text {
        let working = store.members.contains { $0.status == "working" }
        let lead = Text("지금 하실 일이 없습니다.").fontWeight(.semibold).foregroundStyle(CE.ink)
        let rest = Text(working ? "AI가 일하는 중입니다." : "새 일이 생기면 여기에 나타납니다.").foregroundStyle(CE.ink2)
        return Text("\(lead) \(rest)")
    }

    // MARK: - 내 차례

    /// Everything that is stopped until the CEO acts, in priority order: approval prompts, member errors, my sends that
    /// need me, the newest open decisions, open todos. A todo error and the 완료 fold (with its rows) come last.
    /// `waiting` is false when only finished todos (or a todo error) remain: then 내 차례 is the full-width clear line.
    private func turnRows(_ attention: HomeAttention) -> HomeTurn {
        var rows: [HomeTurnRow] = attention.members.map { .member($0.member, $0.delivery) }
        rows += attention.missingMembers.map(HomeTurnRow.delivery)
        if attention.unassigned > 0 { rows.append(.unassigned(attention.unassigned)) }
        rows += attention.failedMessages.map(HomeTurnRow.failedMessage)
        let open = openDecisions
        // Newest first (the owner's choice), but a card that has waited long never hides behind "n건 더".
        let shown = open.prefix(Self.topDecisions) + open.dropFirst(Self.topDecisions).filter { Self.waitedLong($0) }
        rows += shown.map(HomeTurnRow.decision)
        if open.count > shown.count { rows.append(.moreDecisions(open.count - shown.count)) }
        let live = liveTodos
        rows += live.map(HomeTurnRow.todo)
        let waiting = !rows.isEmpty
        // Web .hm-count: everything that waits on me — every open decision (also those behind "n건 더"), not the
        // follow-up, error or fold lines.
        let count = attention.members.count + attention.missingMembers.count + (attention.unassigned > 0 ? 1 : 0)
            + attention.failedMessages.count + open.count + live.filter { !$0.done }.count
        if let todoError { rows.append(.todoError(todoError)) }
        let done = doneTodos
        if !done.isEmpty {
            rows.append(.doneFold(done.count))
            if showDoneTodos { rows += done.map(HomeTurnRow.todo) }
        }
        return HomeTurn(rows: rows, waiting: waiting, count: count)
    }

    private func turnCard(_ turn: HomeTurn) -> some View {
        HomeCard(title: "내 차례", count: turn.count, more: openDecisions.isEmpty ? nil : "결재함", onMore: { router.go(.inbox) }) {
            ForEach(Array(turn.rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 && row.dividerAbove { HomeDivider() }
                turnRow(row)
            }
        }
    }

    @ViewBuilder private func turnRow(_ row: HomeTurnRow) -> some View {
        switch row {
        case .member(let member, let delivery): attentionRow(member, delivery: delivery)
        case .delivery(let summary):
            deliveryAttentionRow(title: "담당자 확인 필요", count: summary.needsOwnerCount,
                                 detail: homeDeliverySummary(summary))
        case .unassigned(let count):
            deliveryAttentionRow(title: "담당 미배정", count: count, detail: "받을 팀원이 정해지지 않았습니다")
        case .failedMessage(let message):
            HStack(spacing: 8) {
                HomeRowButton(bleedTrailing: false, action: { router.openChat(chatTarget(for: message.targetMemberId)) }) {
                    turnLine("exclamationmark.bubble", tint: CE.danger) {
                        Text(homePlainLine(message.body)).font(CEFont.rowTitle).foregroundStyle(CE.ink)
                            .lineSpacing(Self.rowTitleLeading).lineLimit(2).multilineTextAlignment(.leading)
                        Text(["전달 실패", message.deliveryNote].compactMap { $0 }.joined(separator: " · "))
                            .font(CEFont.secondary).foregroundStyle(CE.ink2).lineSpacing(CELeading.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                // The existing retry endpoint schedules evidence collection and preserves recovery fences.
                Button("다시 보내기") { Task { await store.resend(message) } }
                .ceSecondaryButton().ceCompactControl()
                .disabled(!store.uiCanWrite || store.isSending(projectID: message.projectId, targetMemberID: message.targetMemberId))
                .help(store.isDemo ? Self.readOnlyHelp : "같은 글·대상·첨부의 전달 근거를 다시 확인합니다")
            }
        case .decision(let decision): decisionRow(decision)
        case .moreDecisions(let count):
            HomeQuietLink(text: "결재함에서 \(count)건 더") { router.go(.inbox) }
                .padding(.leading, titleInset)
                .accessibilityLabel("결재함에서 \(count)건 더 보기")
        case .todo(let todo): todoRow(todo)
        case .todoError(let text):
            HomeNoteLine(note: HomeNote(text: text, tone: .danger))
                .padding(.leading, titleInset).padding(.vertical, 6)
        case .doneFold(let count):
            doneFoldButton(count)
                .padding(.leading, titleInset)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func doneFoldButton(_ count: Int) -> some View {
        // A 내 차례 row: the full 44pt (web .hm-more-btn).
        HomeFoldButton(title: "완료한 할 일 \(count)", open: showDoneTodos, minHeight: 44) {
            withAnimation(.easeOut(duration: 0.2)) { showDoneTodos.toggle() }
        }
        .accessibilityLabel(showDoneTodos ? "완료한 할 일 \(count)개 접기" : "완료한 할 일 \(count)개 보기")
    }

    /// Leading 22pt glyph, then the title block. The title starts where todo titles start.
    private func turnLine<Lines: View>(_ icon: String, tint: Color, @ViewBuilder lines: () -> Lines) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: glyphGap) {
            HomeGlyph(icon: icon, tint: tint)
            // Web: title 14.5/1.4 and sub 13/1.45 with a 2px gap; SwiftUI has no half-leading, so the gap carries it.
            VStack(alignment: .leading, spacing: 4) { lines() }
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// One intervention per member, with delivery evidence attached to the same row.
    private func attentionRow(_ member: Member, delivery: MemberDeliverySummary?) -> some View {
        let info = MemberStatusInfo(member)
        let approval = info.tone == .approval
        let error = member.status == "error" ? member.lastError.map(friendlyError) : nil
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                HomeRowButton(bleedTrailing: !approval, action: { router.openMember(member.id) }) {
                    turnLine(info.icon, tint: info.tone.color) {
                        Text(member.name).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                        Text([info.label, error.flatMap { $0.isEmpty ? nil : $0 }].compactMap { $0 }.joined(separator: " · "))
                            .font(CEFont.secondary).foregroundStyle(info.tone.color)
                            .lineSpacing(CELeading.secondary).lineLimit(2)
                    }
                }
                .help(info.explanation)
                .accessibilityElement(children: .combine)
                .accessibilityHint("팀원 상세에서 상태와 전달 근거 보기")
                if approval {
                    Button { router.openTerminal(member.id) } label: { Label("터미널", systemImage: "terminal") }
                        .ceSecondaryButton().ceCompactControl()
                        .help("확인된 승인 창을 보고 직접 승인하거나 거절합니다")
                        .accessibilityLabel("\(member.name) 터미널 열기")
                }
            }
            if approval { CLIApprovalCard(member: member) }
            if let delivery, let detail = homeDeliverySummary(delivery) {
                Text(detail)
                    .font(CEFont.meta).foregroundStyle(CE.attention)
                    .lineSpacing(CELeading.meta)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, titleInset).padding(.bottom, 8)
            }
        }
    }

    private func deliveryAttentionRow(title: String, count: Int, detail: String?) -> some View {
        HomeRowButton(action: { router.openChat(nil) }) {
            turnLine("exclamationmark.bubble", tint: CE.attention) {
                Text("\(title) \(DeliveryInfo.badgeCount(count))")
                    .font(CEFont.rowTitle).monospacedDigit().foregroundStyle(CE.ink)
                if let detail { HomeSub(text: detail) }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel((["\(title) \(count)건"] + [detail].compactMap { $0 }).joined(separator: ", "))
        .accessibilityHint("프로젝트 대화에서 원문 보기")
    }

    private func decisionRow(_ decision: Decision) -> some View {
        HomeRowButton(action: { router.openDecision(decision.id) }) {
            turnLine("checkmark.seal", tint: CE.accent) {
                Text(decision.title).font(CEFont.rowTitle).foregroundStyle(CE.ink)
                    .lineSpacing(Self.rowTitleLeading).lineLimit(2).multilineTextAlignment(.leading)
                HStack(spacing: 6) {
                    HomeSub(text: [decision.who, relativeTime(decision.createdAt)].filter { !$0.isEmpty }.joined(separator: " · "))
                    if let waited = Self.waitedLabel(decision) { Tag(waited, tone: .attention) }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("결재함에서 답하기")
    }

    // MARK: 할 일 rows

    /// Web .hm-todo: 22pt rounded checkbox · one-line title · chevron. The fold holds detail, who and when.
    private func todoRow(_ todo: Todo) -> some View {
        let checked = todo.done
        let expanded = expandedTodos.contains(todo.id)
        let hit = rowMinHeight
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                HomeTodoCheck(checked: checked, busy: todoBusy(todo.id), hit: hit) {
                    toggleTodo(todo, to: !checked)
                }
                // The 22pt box lines up with the card's text edge; the hit area extends past it.
                .padding(.leading, -(hit - 22) / 2)
                .disabled(!store.canWrite || todoBusy(todo.id))
                .help(store.isDemo ? Self.readOnlyHelp : checked ? "했음 표시 지우기" : "했음으로 표시 (결재 답이 아닙니다)")
                .accessibilityLabel("\(todo.title) 했음")
                .accessibilityValue([checked ? "표시함" : "표시 안 함", todoWriteNotice(todo.id)?.text].compactMap { $0 }.joined(separator: ", "))

                Button {
                    withAnimation(.easeOut(duration: 0.2)) {
                        if expanded { expandedTodos.remove(todo.id) } else { expandedTodos.insert(todo.id) }
                    }
                } label: {
                    HStack(alignment: .center, spacing: 10) {
                        // Web .hm-todo__title: 15/600 at 1.4, wraps when open.
                        Text(todo.title)
                            .font(isMac ? .system(size: 15, weight: .semibold) : CEFont.rowTitle)
                            .foregroundStyle(checked ? CE.ink2 : CE.ink)
                            .strikethrough(checked, color: CE.ink3)
                            .lineSpacing(CELeading.spacing(15, 1.4))
                            .lineLimit(expanded ? nil : 1)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        HomeChevron(open: expanded)
                    }
                    .padding(.leading, 2).padding(.trailing, 8).padding(.vertical, 6)
                    .frame(minHeight: hit)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowButtonStyle(radius: CERadius.row))
                .padding(.trailing, -8)
                .accessibilityHint(expanded ? "접기" : "자세히 보기")
            }
            if let notice = todoWriteNotice(todo.id) {
                Text(notice.text).font(CEFont.note).foregroundStyle(notice.tone == .neutral ? CE.ink2 : notice.tone.color)
                    .lineSpacing(CELeading.note)
                    .padding(.leading, titleInset).padding(.bottom, 8)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // Fold text starts where the title starts.
            if expanded { todoFold(todo, checked: checked).padding(.leading, titleInset) }
        }
    }

    private func todoFold(_ todo: Todo, checked: Bool) -> some View {
        let closedBy = checked ? (todo.closedBy ?? "") : ""
        let reason = todo.closeReason ?? ""
        // Done rows: the AI closed it ("{who}의 요청"), or I checked it and {who} gets a notice.
        let whoLine = todo.who.isEmpty ? "" : checked && closedBy.isEmpty ? "\(todo.who)에게 알림" : "\(todo.who)의 요청"
        let time = relativeTime(checked ? (todo.doneAt ?? todo.createdAt) : todo.createdAt)
        return VStack(alignment: .leading, spacing: 6) {
            if !todo.detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                // Web .md.hm-todo__detail: 14 at 1.55.
                MarkdownText(text: todo.detail, size: 14, lineHeight: 1.55)
            }
            // Web .hm-todo__meta: 13 at 1.45, ink-2.
            if !closedBy.isEmpty {
                Text(reason.isEmpty ? "\(closedBy) 정리" : "\(closedBy) 정리: \(reason)")
                    .font(CEFont.secondary).foregroundStyle(CE.ink2)
                    .lineSpacing(CELeading.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                if !whoLine.isEmpty { Text(whoLine).lineLimit(1) }
                if !time.isEmpty { Text(time).monospacedDigit().lineLimit(1).fixedSize() }
            }
            .font(CEFont.secondary).foregroundStyle(CE.ink2)
        }
        .padding(.trailing, 8).padding(.top, 2).padding(.bottom, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity)
    }

    private func todoWriteNotice(_ id: String) -> (text: String, tone: Tone)? {
        switch store.todoWrites[id] {
        case .sending: ("보내는 중", .neutral)
        case nil where store.pendingActions.contains("todo:\(id)"): ("보내는 중", .neutral)
        case .checking: ("결과 확인 중 · 확인이 끝나면 다시 바꿀 수 있습니다", .attention)
        case .conflict: ("이전 상태의 변경은 반영하지 않았습니다. 최신 내용과 정리 이유를 확인하세요.", .attention)
        case .confirmedCurrent: ("최신 상태를 확인했습니다", .neutral)
        default: nil
        }
    }

    private func toggleTodo(_ todo: Todo, to done: Bool) {
        guard store.canWrite, Date().timeIntervalSince(lastTodoShift) > 0.4, !todoBusy(todo.id) else { return }
        let projectID = store.selectedProjectID
        let namespace = store.drafts.namespace
        let context = contextID
        todoError = nil
        Task { @MainActor in
            let ok = await store.setTodoDone(todo, done: done)
            guard contextID == context, store.selectedProjectID == projectID, store.drafts.namespace == namespace else { return }
            let status = store.todoWrites[todo.id]
            let confirmedCurrent = status == .confirmedCurrent && store.todos.first(where: { $0.id == todo.id })?.done == done
            if !ok && ![.sending, .checking, .conflict].contains(status) && !confirmedCurrent {
                todoError = "'\(todo.title)' 변경을 반영하지 않았습니다. " + (store.errorMessage ?? "최신 상태를 확인하세요.")
            }
        }
    }

    // MARK: - 팀

    /// Active members and observations that cannot be confirmed, in team order.
    /// 승인 창 앞 and 오류 are listed in 내 차례, not here.
    private var activeMembers: [Member] {
        store.members.filter { ["working", "waiting"].contains($0.status) || MemberStatusInfo.isUncertain($0) }
    }

    private var teamSummary: [(status: String, label: String, count: Int)] {
        let counts = MemberStatusInfo.summaryCounts(store.members)
        return (Self.summaryParts + [("unknown", "상태 확인 불가")]).compactMap { part in
            let count = counts[part.status] ?? 0
            return count > 0 ? (part.status, part.label, count) : nil
        }
    }

    @ViewBuilder private var teamCard: some View {
        if let first = store.members.first {
            if isHq {
                // HQ has one AI: its row is the card.
                let lead = store.members.first { $0.kind == "root" } ?? first
                HomeCard(title: "본사 AI") { memberRow(lead, showsState: true) }
            } else {
                let active = activeMembers
                let shown = Array(active.prefix(Self.topMembers))
                let summary = teamSummary
                HomeCard(title: "팀", more: "사무실 보기", onMore: { router.go(.team) }) {
                    if summary.isEmpty {
                        Text("지금 일하는 팀원이 없습니다").font(CEFont.secondary).foregroundStyle(CE.ink2)
                            .padding(.top, 2).padding(.bottom, 6)
                    } else {
                        // Web .hm-chips: padding 4 0 6.
                        teamSummaryLine(summary).padding(.top, 4).padding(.bottom, 6)
                    }
                    ForEach(Array(shown.enumerated()), id: \.element.id) { index, member in
                        HomeDivider().opacity(index == 0 ? 0.6 : 1)
                        activeRow(member)
                    }
                    if active.count > shown.count {
                        HomeQuietLink(text: "외 \(active.count - shown.count)명") { router.go(.team) }
                            .padding(.leading, 18)
                            .accessibilityLabel("일하는 팀원 \(active.count - shown.count)명 더 보기")
                    }
                }
            }
        }
    }

    /// Web .hm-chips: "● 일하는 중 2" capsules (28pt, white .07), wrapping on narrow widths.
    private func teamSummaryLine(_ parts: [(status: String, label: String, count: Int)]) -> some View {
        HomeFlow(spacing: 6, lineSpacing: 6) {
            ForEach(parts, id: \.status) { part in
                let info = MemberStatusInfo(part.status)
                HStack(spacing: 6) {
                    StatusDot(tone: info.tone, size: 8)
                    Text(part.label)
                    Text("\(part.count)").monospacedDigit().fontWeight(.semibold)
                }
                .font(CEFont.secondary).foregroundStyle(CE.ink)
                .lineLimit(1)
                .padding(.leading, 9).padding(.trailing, 10)
                .frame(minHeight: 28)
                .background(Color.white.opacity(0.07), in: Capsule())
                .fixedSize()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(part.label) \(part.count)명")
            }
        }
    }

    /// Web .hm-row__main--stack: the name line (with when, on the right), then what it is doing on the full width.
    private func activeRow(_ member: Member) -> some View {
        let info = MemberStatusInfo(member)
        let now = plainOneLine(member.now)
        // The dot already says working / waiting; a state the dot cannot say (확인 불가) keeps its words.
        let doing = now.isEmpty ? info.label : (info.icon == "questionmark.circle" ? "\(info.label) · " : "") + now
        let time = relativeTime(member.nowAt)
        return HomeRowButton(action: { router.openMember(member.id) }) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                StatusDot(tone: info.tone, pulsing: info.live, size: 8)
                    .frame(width: 8)
                    .alignmentGuide(.firstTextBaseline) { $0.height / 2 + 5 }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(member.name).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                        Spacer(minLength: 8)
                        if !time.isEmpty {
                            Text(time).font(CEFont.meta).monospacedDigit().foregroundStyle(CE.ink2).lineLimit(1).fixedSize()
                        }
                    }
                    Text(doing).font(CEFont.secondary).foregroundStyle(CE.ink2).lineLimit(1)
                }
            }
        }
        .help([info.explanation, now.isEmpty ? "" : "마지막 보고 · \(now)"].filter { !$0.isEmpty }.joined(separator: "\n"))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([member.name, info.label, now.isEmpty ? "" : "마지막 보고 \(now)", time].filter { !$0.isEmpty }.joined(separator: ", "))
        .accessibilityHint("팀원 보기")
    }

    /// HQ's single AI with its state label.
    private func memberRow(_ member: Member, showsState: Bool = false) -> some View {
        let info = MemberStatusInfo(member)
        let error = member.lastError.flatMap { $0.isEmpty ? nil : friendlyError($0) }
        let sub = member.status == "error" ? (error ?? info.label) : member.now.isEmpty ? "" : "마지막 보고 · \(member.now)"
        return HomeRowButton(action: { router.openMember(member.id) }) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                StatusDot(tone: info.tone, pulsing: info.live, size: 8)
                    .alignmentGuide(.firstTextBaseline) { $0.height / 2 + 5 }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(member.name).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                        if showsState { Text(info.label).font(CEFont.meta.weight(.medium)).foregroundStyle(info.tone.color).fixedSize() }
                    }
                    if !sub.isEmpty { HomeSub(text: sub) }
                }
            }
        }
        .help(info.explanation)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(member.name), \(info.label)\(sub.isEmpty ? "" : ", \(sub)")")
        .accessibilityHint("팀원 보기")
    }

    // MARK: - 진척

    @ViewBuilder private var progressCard: some View {
        if !store.work.isEmpty {
            let done = work(.done), doing = work(.doing), next = work(.next), hold = work(.hold)
            let total = store.work.count
            let today = done.filter { item in parseISODate(item.doneAt).map { Calendar.current.isDateInToday($0) } ?? false }.count
            let parts = [(WorkSection.doing, doing.count), (WorkSection.next, next.count), (WorkSection.hold, hold.count)].filter { $0.1 > 0 }
            // Doing items are not listed: the 팀 rows already say who works on what. 보류 first, then 예정, five in all,
            // each group under its own label (web .hm-work__label) with "외 n건" for the rest.
            let rows = Array((hold + next.prefix(Self.topNextWork)).prefix(Self.topWorkRows))
            let groups = [(WorkSection.hold, hold.count), (WorkSection.next, next.count)].compactMap { section, total in
                let items = rows.filter { $0.sec == section.rawValue }
                return items.isEmpty ? nil : (section: section, items: items, rest: total - items.count)
            }
            HomeCard(title: "진척", more: isHq ? nil : "일 목록", onMore: isHq ? nil : { router.go(.team) }) {
                VStack(alignment: .leading, spacing: 9) {
                    HomeProgressBar(segments: [
                        (done.count, Self.workColor(.done)), (doing.count, Self.workColor(.doing)),
                        (next.count, Self.workColor(.next)), (hold.count, Self.workColor(.hold)),
                    ])
                    progressLine(done: done.count, total: total, parts: parts, today: today)
                }
                .padding(.top, 2).padding(.bottom, rows.isEmpty ? 6 : 8)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(progressLabel(done: done.count, total: total, parts: parts, today: today))
                if !groups.isEmpty {
                    HomeDivider()
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(groups, id: \.section) { group in
                            Text(group.section.title)
                                .font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.ink2)
                                .padding(.top, 6).padding(.bottom, 2)
                                .accessibilityAddTraits(.isHeader)
                            ForEach(group.items) { item in workRow(item) }
                            if group.rest > 0 {
                                if isHq {
                                    Text("외 \(group.rest)건").font(CEFont.secondary).monospacedDigit().foregroundStyle(CE.ink2)
                                        .padding(.top, 4).padding(.bottom, 2)
                                } else {
                                    HomeQuietLink(text: "외 \(group.rest)건") { router.go(.team) }
                                        .accessibilityLabel("\(group.section.title) \(group.rest)건 더 보기")
                                }
                            }
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
    }

    private static func workColor(_ section: WorkSection) -> Color {
        switch section {
        case .done: CE.success
        case .doing: CE.live
        case .next: Color.white.opacity(0.22)
        case .hold: CE.warn.opacity(0.7)
        }
    }

    /// Legend and row dot colour: the bar colour at full strength, with 예정 a touch brighter so a 6pt dot still reads.
    private static func legendColor(_ section: WorkSection) -> Color {
        switch section {
        case .next: Color.white.opacity(0.38)
        case .hold: CE.warn
        default: workColor(section)
        }
    }

    /// "완료 d / 전체 t   ● 진행 중 3  ● 예정 2  ● 보류 1      오늘 끝냄 n". Two lines when one does not fit.
    private func progressLine(done: Int, total: Int, parts: [(WorkSection, Int)], today: Int) -> some View {
        let head = Text("완료 \(done) / 전체 \(total)")
            .font(CEFont.secondary.weight(.semibold)).monospacedDigit().foregroundStyle(CE.ink)
        let legend = HStack(spacing: 10) {
            ForEach(parts, id: \.0) { part in
                HStack(spacing: 5) {
                    Circle().fill(Self.legendColor(part.0)).frame(width: 6, height: 6)
                    Text("\(part.0.title) \(part.1)").monospacedDigit()
                }
            }
        }
        .font(CEFont.meta).foregroundStyle(CE.ink2)
        let todayText = Text("오늘 끝냄 \(today)").font(CEFont.meta.weight(.semibold)).monospacedDigit().foregroundStyle(CE.success)
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                head.fixedSize()
                legend.fixedSize()
                Spacer(minLength: 8)
                if today > 0 { todayText.fixedSize() }
            }
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    head
                    Spacer(minLength: 8)
                    if today > 0 { todayText }
                }
                legend
            }
        }
    }

    private func progressLabel(done: Int, total: Int, parts: [(WorkSection, Int)], today: Int) -> String {
        var text = "진척: 전체 \(total)건 중 완료 \(done)건"
        for (section, count) in parts { text += ", \(section.title) \(count)건" }
        if today > 0 { text += ", 오늘 끝냄 \(today)건" }
        return text
    }

    /// 보류: title and the reason. 예정: title and who. One line when both fit whole; otherwise the reason (or who) moves
    /// to a second line under the title, so neither is cut to "…" — the reason is all a 보류 row has to say.
    private func workRow(_ item: WorkItem) -> some View {
        let section = WorkSection(rawValue: item.sec) ?? .next
        let trailing = section == .hold ? plainOneLine(item.detail) : item.who
        let dot = Circle().fill(Self.legendColor(section)).frame(width: 6, height: 6)
            .frame(width: 8)
            .accessibilityHidden(true)
        // Web .hm-work__title 14 at 1.45; .hm-work__who 12.5 ink-2.
        let title = Text(item.title).font(isMac ? .system(size: 14) : CEFont.body).foregroundStyle(CE.ink)
        let context = Text(trailing).font(CEFont.meta).foregroundStyle(CE.ink2)
        return ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                dot.alignmentGuide(.firstTextBaseline) { $0.height / 2 + 5 }
                title.lineLimit(1).fixedSize()
                Spacer(minLength: 12)
                if !trailing.isEmpty { context.lineLimit(1).fixedSize() }
            }
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                dot.alignmentGuide(.firstTextBaseline) { $0.height / 2 + 5 }
                VStack(alignment: .leading, spacing: 3) {
                    // The web title wraps rather than being cut.
                    title.lineSpacing(CELeading.spacing(14, 1.45)).lineLimit(2)
                    if !trailing.isEmpty { context.lineLimit(1) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, isMac ? 5 : 7)
        .frame(minHeight: isMac ? 30 : 34)
        .help([item.detail, item.who].filter { !$0.isEmpty }.joined(separator: " · "))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([section.title, item.title, trailing].filter { !$0.isEmpty }.joined(separator: ", "))
    }

    // MARK: - 최근 (보고 · 자료)

    /// Reports and files in one list, newest first. A file a shown report already points to is not listed twice.
    private var recentItems: [HomeRecent] {
        let reports = recentReports(store.messages, limit: Self.topRecent)
        let linked = Set(reports.compactMap(\.fileId))
        let files = store.files.filter { !linked.contains($0.id) }.sorted { $0.createdAt > $1.createdAt }.prefix(Self.topRecent)
        let merged = reports.map(HomeRecent.report) + files.map(HomeRecent.file)
        return Array(merged.sorted { $0.date > $1.date }.prefix(Self.topRecent))
    }

    @ViewBuilder private var recentCard: some View {
        let items = recentItems
        if !items.isEmpty {
            HomeCard(title: "최근", links: [
                HomeLink(title: "대화") { router.openChat(nil) },
                HomeLink(title: "자료") { router.go(.files) },
            ]) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { HomeDivider() }
                    recentRow(item)
                }
            }
        }
    }

    /// Web .hm-row__main--stack: a title of up to two lines, then kind badge · who · when (.hm-row__sub--meta).
    private func recentRow(_ item: HomeRecent) -> some View {
        let icon: String, tint: Color, title: String, who: String, at: String, kind: String
        let badge: (text: String, tone: Tone)?
        let action: () -> Void
        switch item {
        case .report(let message):
            let mark = reportMark(message.kind)
            icon = mark.icon; tint = mark.tint
            title = message.title.isEmpty ? homePlainLine(message.body) : message.title
            who = message.who; at = message.at; kind = "\(message.kind) 보고"
            badge = message.kind.isEmpty ? nil : (message.kind, Self.reportTone(message.kind))
            action = { router.openChat(chatTarget(for: message.memberId)) }
        case .file(let file):
            icon = fileKindIcon(file.kind); tint = CE.ink3
            title = file.title
            who = file.who; at = file.createdAt; kind = fileKindName(file.kind)
            badge = nil
            action = { router.openFile(file.id) }
        }
        let time = relativeTime(at)
        return HomeRowButton(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: isMac ? 13 : 15, weight: .medium))
                    .foregroundStyle(tint)
                    .frame(width: 18)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(CEFont.rowTitle).foregroundStyle(CE.ink)
                        .lineSpacing(Self.rowTitleLeading).lineLimit(2).multilineTextAlignment(.leading)
                    HStack(spacing: 8) {
                        if let badge { Tag(badge.text, tone: badge.tone) }
                        if !who.isEmpty { Text(who).lineLimit(1) }
                        if !time.isEmpty { Text(time).monospacedDigit().lineLimit(1).fixedSize() }
                    }
                    .font(CEFont.secondary).foregroundStyle(CE.ink2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .help([kind, who].filter { !$0.isEmpty }.joined(separator: " · "))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([kind, title, who, time].filter { !$0.isEmpty }.joined(separator: ", "))
        .accessibilityHint(item.isFile ? "자료 열기" : "대화에서 보기")
    }

    private func reportMark(_ kind: String) -> (icon: String, tint: Color) {
        switch kind {
        case "완료": ("checkmark.circle", CE.success)
        case "진행": ("arrow.forward.circle", CE.live)
        case "질문": ("questionmark.circle", CE.attention)
        case "막힘": ("exclamationmark.octagon", CE.danger)
        case "답변": ("arrowshape.turn.up.left", CE.ink3)
        default: ("bell", CE.ink3)
        }
    }

    /// Web KIND_TONE: 완료 ok, 질문 accent, 막힘 danger, the rest neutral.
    private static func reportTone(_ kind: String) -> Tone {
        switch kind {
        case "완료": .success
        case "질문": .accent
        case "막힘": .danger
        default: .neutral
        }
    }
}

// MARK: - Private model helpers

/// Recovery totals are authoritative. Automatic checking never creates an intervention.
struct HomeAttention {
    var members: [(member: Member, delivery: MemberDeliverySummary?)] = []
    var missingMembers: [MemberDeliverySummary] = []
    var unassigned = 0
    var failedMessages: [Message] = []

    init(members: [Member], notices: DeliveryNotices?, messages: [Message] = []) {
        let summaries = notices?.members ?? []
        failedMessages = unresolvedDeliveries(messages, status: "failed").filter { message in
            if let id = message.targetMemberId {
                return summaries.contains { $0.memberId == id && $0.needsOwnerCount > 0 }
            }
            return (notices?.unassigned.needsOwnerCount ?? 0) > 0
        }
        for member in members {
            let info = MemberStatusInfo(member)
            let delivery = summaries.first { $0.memberId == member.id && $0.needsOwnerCount > 0 }
            if member.status == "error" || (info.needsMe && member.status != "waiting") || delivery != nil {
                self.members.append((member, delivery))
            }
        }
        let known = Set(members.map(\.id))
        missingMembers = summaries.filter { $0.needsOwnerCount > 0 && !known.contains($0.memberId) }
        unassigned = max(0, notices?.unassigned.needsOwnerCount ?? 0)
    }
}

/// 내 차례: its rows, and whether anything in them waits on me (beyond finished todos and a todo error).
private struct HomeTurn {
    var rows: [HomeTurnRow]
    var waiting: Bool
    /// The header count: things that wait on me.
    var count: Int
}

/// One row of 내 차례, in priority order.
private enum HomeTurnRow: Identifiable {
    case member(Member, MemberDeliverySummary?)
    case delivery(MemberDeliverySummary)
    case unassigned(Int)
    case failedMessage(Message)
    case decision(Decision)
    case moreDecisions(Int)
    case todo(Todo)
    case todoError(String)
    case doneFold(Int)

    var id: String {
        switch self {
        case .member(let member, _): "member:\(member.id)"
        case .delivery(let summary): "delivery:\(summary.memberId)"
        case .unassigned: "delivery-unassigned"
        case .failedMessage(let message): "failed-message:\(message.id)"
        case .decision(let decision): "decision:\(decision.id)"
        case .moreDecisions: "more-decisions"
        // Open and done rows of the same todo share an id, so a checked row moves into the fold.
        case .todo(let todo): "todo:\(todo.id)"
        case .todoError: "todo-error"
        case .doneFold: "done-fold"
        }
    }

    /// Follow-up lines (more, a todo error) belong to the row above them.
    var dividerAbove: Bool {
        switch self {
        case .moreDecisions, .todoError: false
        default: true
        }
    }
}

private enum HomeRecent: Identifiable {
    case report(Message)
    case file(FileDoc)
    var id: String {
        switch self {
        case .report(let message): "report:\(message.id)"
        case .file(let file): "file:\(file.id)"
        }
    }
    var isFile: Bool { if case .file = self { true } else { false } }
    var date: Date {
        switch self {
        case .report(let message): parseISODate(message.at) ?? .distantPast
        case .file(let file): parseISODate(file.createdAt) ?? .distantPast
        }
    }
}

private struct HomeNote: Identifiable {
    let id = UUID()
    let text: String
    let tone: Tone
}

// MARK: - Private building blocks

/// A header link ("결재함", "대화").
private struct HomeLink {
    let title: String
    let action: () -> Void
}

/// Web .hm-card: tinted glass card (Plate), padding 10 16 12 (phone 8 14 10), a 32pt header (title 14/650, count
/// pill, quiet meta, then a trailing accessory or links) and a 4pt gap before the content.
private struct HomeCard<Accessory: View, Content: View>: View {
    let title: String
    var meta: String?
    var count: Int?
    var links: [HomeLink]
    let accessory: Accessory
    let content: Content

    init(title: String, meta: String? = nil, count: Int? = nil, more: String? = nil, onMore: (() -> Void)? = nil,
         links: [HomeLink] = [], @ViewBuilder accessory: () -> Accessory, @ViewBuilder content: () -> Content) {
        self.title = title; self.meta = meta; self.count = count
        var all: [HomeLink] = []
        if let more, let onMore { all.append(HomeLink(title: more, action: onMore)) }
        self.links = all + links
        self.accessory = accessory(); self.content = content()
    }

    var body: some View {
        Plate(padding: 0) {
            VStack(alignment: .leading, spacing: 4) {
                header
                // Rows and dividers sit flush: the 4pt gap is only under the header.
                VStack(alignment: .leading, spacing: 0) { content }
            }
            .padding(.horizontal, isMac ? 16 : 14)
            .padding(.top, isMac ? 10 : 8)
            .padding(.bottom, isMac ? 12 : 10)
        }
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(title).font(CEFont.section).tracking(-0.14).foregroundStyle(CE.ink)
                .lineLimit(1).fixedSize()
                .accessibilityAddTraits(.isHeader)
            if let count, count > 0 {
                Text("\(count)")
                    .font(CEFont.caption.weight(.semibold)).monospacedDigit().foregroundStyle(CE.ink)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 20, minHeight: 20)
                    .background(Color.white.opacity(0.12), in: Capsule())
                    .fixedSize()
                    .accessibilityLabel("\(count)건")
            }
            if let meta, !meta.isEmpty {
                Text(meta).font(CEFont.meta).monospacedDigit().foregroundStyle(CE.ink2).lineLimit(1).fixedSize()
            }
            Spacer(minLength: 8)
            accessory
            if !links.isEmpty {
                HStack(spacing: 12) {
                    ForEach(links, id: \.title) { link in HomeHeaderLink(title: link.title, action: link.action) }
                }
            }
        }
        .frame(minHeight: 32)
    }
}

extension HomeCard where Accessory == EmptyView {
    init(title: String, meta: String? = nil, count: Int? = nil, more: String? = nil, onMore: (() -> Void)? = nil,
         links: [HomeLink] = [], @ViewBuilder content: () -> Content) {
        self.init(title: title, meta: meta, count: count, more: more, onMore: onMore, links: links,
                  accessory: { EmptyView() }, content: content)
    }
}

/// Web .hm-head__more: 13/500 in the focus colour, underlined on hover; a 44pt hit area on iPhone while the header
/// line stays low.
private struct HomeHeaderLink: View {
    let title: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(CEFont.secondary.weight(.medium))
                .foregroundStyle(CE.accent)
                .underline(isMac && hovering, color: CE.accent.opacity(0.7))
                .lineLimit(1).fixedSize()
                .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? 32 : 44, alignment: .trailing)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, isMac ? 0 : -6)
        .onHover { hovering = $0 }
        .accessibilityLabel("\(title) 열기")
    }
}

/// Small quiet button for a card header (판 정리). With a title: a capsule (Mac 28pt, 12.5/600; iPhone 30pt in a
/// 44pt hit area). Without one: a circle. While busy a spinner takes the icon's place.
private struct HomeIconButton: View {
    let icon: String
    var title: String?
    let busy: Bool
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    private var size: CGFloat { isMac ? 28 : 30 }
    private var hit: CGFloat { isMac ? 28 : 44 }

    var body: some View {
        Group {
            if let title {
                Button(action: action) {
                    HStack(spacing: 5) {
                        if busy {
                            ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 14, height: 14)
                        } else {
                            Image(systemName: icon).font(.system(size: isMac ? 11 : 12, weight: .semibold))
                        }
                        Text(title).font(isMac ? .system(size: 12.5, weight: .semibold) : CEFont.meta.weight(.semibold))
                            .lineLimit(1)
                    }
                    .foregroundStyle(ink)
                    .padding(.horizontal, 11)
                    .frame(height: size)
                    .background(Capsule().fill(fill))
                    .overlay { Capsule().strokeBorder(isEnabled ? CE.lineStrong : CE.line) }
                    .frame(minWidth: hit, minHeight: hit)
                    .contentShape(Rectangle())
                }
                .buttonStyle(HomePressStyle())
                .onHover { hovering = $0 }
            } else if busy {
                ProgressView().controlSize(.small)
                    .frame(width: size, height: size)
                    .frame(width: hit, height: hit)
            } else {
                Button(action: action) {
                    Image(systemName: icon)
                        .font(.system(size: isMac ? 11.5 : 13.5, weight: .semibold))
                        .foregroundStyle(ink)
                        .frame(width: size, height: size)
                        .background(Circle().fill(fill))
                        .overlay { Circle().strokeBorder(isEnabled ? CE.lineStrong : CE.line) }
                        .frame(width: hit, height: hit)
                        .contentShape(Rectangle())
                }
                .buttonStyle(HomePressStyle())
                .onHover { hovering = $0 }
            }
        }
        // The hit area is 44pt on iPhone; the header line stays low and the mark's edge meets the card's text edge.
        .padding(.vertical, isMac ? 0 : -4)
        .padding(.trailing, isMac || title != nil ? 0 : -(hit - size) / 2)
    }

    private var ink: Color { isEnabled ? (hovering ? CE.ink : CE.ink2) : CE.ink3.opacity(0.75) }
    private var fill: Color { Color.white.opacity(isEnabled ? (hovering ? 0.12 : 0.07) : 0.035) }
}

/// iPhone/iPad row action that has no room for words (다시 보내기): a 34pt quiet glass circle — the same look as the
/// row's text capsules (터미널) — in a 44pt hit area, its edge on the card's text edge.
private struct HomeCircleButton: View {
    let icon: String
    let busy: Bool
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    private let size: CGFloat = 34
    private let hit: CGFloat = 44

    var body: some View {
        Button(action: action) {
            Group {
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: icon).font(.system(size: 15, weight: .semibold))
                }
            }
            .foregroundStyle(isEnabled ? CE.ink : CE.ink3)
            .frame(width: size, height: size)
            .background(Color.white.opacity(isEnabled ? 0.07 : 0), in: Circle())
            .background(.ultraThinMaterial.opacity(isEnabled ? 1 : 0.5), in: Circle())
            .overlay { if isEnabled { GlassRim(shape: Circle()) } else { Circle().strokeBorder(CE.line) } }
            .frame(width: hit, height: hit)
            .contentShape(Rectangle())
        }
        .buttonStyle(HomePressStyle())
        .padding(.trailing, -(hit - size) / 2)
    }
}

/// Segmented capsule: each part's width is proportional to its count, 1pt gaps between parts.
private struct HomeProgressBar: View {
    let segments: [(count: Int, color: Color)]

    var body: some View {
        let parts = segments.filter { $0.count > 0 }
        let total = parts.reduce(0) { $0 + $1.count }
        GeometryReader { geo in
            let usable = max(geo.size.width - CGFloat(max(parts.count - 1, 0)), 0)
            HStack(spacing: 1) {
                ForEach(parts.indices, id: \.self) { index in
                    Rectangle().fill(parts[index].color)
                        .frame(width: total > 0 ? usable * CGFloat(parts[index].count) / CGFloat(total) : 0)
                }
            }
        }
        .frame(height: 8)
        .clipShape(Capsule())
        .accessibilityHidden(true)
    }
}

/// Web .hm-row: a tappable row (44pt, padding 7 8) whose hover/press fill bleeds 8pt past the card's text edge.
/// The vertical padding is 9: SwiftUI text has no CSS half-leading, so a two-line row lands on the web's 55.
private struct HomeRowButton<Content: View>: View {
    var bleedTrailing = true
    var minHeight: CGFloat = 44
    var vertical: CGFloat = 9
    let action: () -> Void
    @ViewBuilder var content: Content

    var body: some View {
        Button(action: action) {
            content
                .padding(.horizontal, 8).padding(.vertical, vertical)
                .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle(radius: CERadius.row))
        .padding(.leading, -8)
        .padding(.trailing, bleedTrailing ? -8 : 0)
    }
}

/// 내 차례 leading mark: a 22pt column so every title starts at the same x.
private struct HomeGlyph: View {
    let icon: String
    let tint: Color
    var body: some View {
        Image(systemName: icon)
            .font(.system(size: isMac ? 13.5 : 15, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 22)
            .accessibilityHidden(true)
    }
}

/// Quiet one-line context under a row title (web .hm-row__sub: 13, ink-2).
private struct HomeSub: View {
    let text: String
    var body: some View {
        // Sub-lines carry times ("· 3분 전"): tabular digits, like the web's <Time>.
        Text(text).font(CEFont.secondary).monospacedDigit().foregroundStyle(CE.ink2).lineLimit(1)
    }
}

/// "결재함에서 n건 더", "외 n명": a quiet line that is itself a link (web .hm-rest: 13, ink-2).
private struct HomeQuietLink: View {
    let text: String
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(text).monospacedDigit()
                Image(systemName: "chevron.right").font(.system(size: isMac ? 9 : 10, weight: .bold))
            }
            .font(CEFont.secondary.weight(.medium))
            .foregroundStyle(hovering ? CE.ink : CE.ink2)
            .frame(minHeight: isMac ? 30 : 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(HomePressStyle())
        .onHover { hovering = $0 }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Web .hm-check: a 22pt rounded box; checked fills with the ok colour and a dark tick. The box dips while pressed
/// and the tick springs in, so a tick feels like it landed.
private struct HomeTodoCheck: View {
    let checked: Bool
    let busy: Bool
    let hit: CGFloat
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 7, style: .continuous)
        Button(action: action) {
            ZStack {
                if checked {
                    shape.fill(CE.success)
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(Color(hex: 0x0B1A14))
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.4).combined(with: .opacity))
                } else {
                    // Read-only (sample, offline): a quieter box, never hidden.
                    shape.strokeBorder(hovering && isEnabled ? CE.ink : CE.ink2.opacity(isEnabled ? 1 : 0.6), lineWidth: 1.5)
                }
            }
            .frame(width: 22, height: 22)
            .opacity(busy ? 0.55 : 1)
            .animation(reduceMotion ? .linear(duration: 0.12) : .spring(response: 0.25, dampingFraction: 0.55), value: checked)
            .frame(width: hit, height: hit)
            .contentShape(Rectangle())
        }
        .buttonStyle(HomeCheckPressStyle(reduceMotion: reduceMotion))
        .onHover { hovering = $0 }
        .accessibilityAddTraits(.isToggle)
    }
}

/// The check box shrinks to 0.88 while pressed and springs back on release.
private struct HomeCheckPressStyle: ButtonStyle {
    let reduceMotion: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.88 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.55), value: configuration.isPressed)
    }
}

private struct HomeChevron: View {
    let open: Bool
    var body: some View {
        Image(systemName: "chevron.down")
            .font(.system(size: isMac ? 10 : 12, weight: .semibold))
            .foregroundStyle(CE.ink2)
            .rotationEffect(.degrees(open ? 180 : 0))
            .accessibilityHidden(true)
    }
}

/// Web .hm-more-btn: "더 보기" / "접기" / "완료한 할 일 n" with a chevron — 13.5/600 ink-2 (ink-1 on hover), 7pt gap.
private struct HomeFoldButton: View {
    let title: String
    let open: Bool
    /// Mac: 32 under 지금 상황 (the line stays low); the 완료 fold is a 내 차례 row and passes 44. iPhone: always 44.
    var minHeight: CGFloat = 32
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Text(title).monospacedDigit().foregroundStyle(hovering ? CE.ink : CE.ink2)
                HomeChevron(open: open)
            }
            .font(isMac ? .system(size: 13.5, weight: .semibold) : CEFont.note.weight(.semibold))
            .frame(minHeight: isMac ? minHeight : 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(HomePressStyle())
        .onHover { hovering = $0 }
    }
}

/// Web .hm-tidy__note (13 at 1.45, ink-2) and .hm-error (13.5 at 1.45, danger).
private struct HomeNoteLine: View {
    let note: HomeNote
    var trailing = false
    var body: some View {
        let danger = note.tone == .danger
        Text(note.text)
            .font(danger ? CEFont.note : CEFont.secondary)
            .lineSpacing(danger ? CELeading.note : CELeading.secondary)
            .foregroundStyle(danger ? CE.danger : CE.ink2)
            .multilineTextAlignment(trailing ? .trailing : .leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
    }
}

private struct HomeDivider: View {
    var body: some View {
        Rectangle().fill(CE.line).frame(height: 1).accessibilityHidden(true)
    }
}

private struct HomePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// Wraps chips onto new lines instead of squeezing them at iPhone width.
private struct HomeFlow: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > maxWidth {
                y += lineHeight + lineSpacing
                x = 0; lineHeight = 0
            }
            widest = max(widest, x + size.width)
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: proposal.width ?? widest, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += lineHeight + lineSpacing
                x = bounds.minX; lineHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

/// First readable line of a markdown body, without list/heading markers or emphasis symbols.
private func homePlainLine(_ text: String) -> String {
    for raw in text.components(separatedBy: .newlines) {
        var line = raw.trimmingCharacters(in: .whitespaces)
        if line.isEmpty || line.hasPrefix("```") { continue }
        while line.hasPrefix("#") { line.removeFirst() }
        for marker in ["- ", "* ", "• ", "> "] where line.hasPrefix(marker) { line.removeFirst(marker.count) }
        line = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespaces)
        if !line.isEmpty { return line }
    }
    return ""
}
