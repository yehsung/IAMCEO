import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// 팀: who is doing what, in which CLI state, and the next action for each member.
// CLI state is never presented as task completion; only a `완료` report says that.
// The team is drawn as an office (OfficeView): every session is a small figure that works, rests or sleeps at its own
// desk. Provider model, context meter, folder and terminal commands live in the member detail.

private enum TeamFont {
    #if os(macOS)
    static let fact: Font = .system(size: 14)
    static let label: Font = .system(size: 13)
    static let role: Font = .system(size: 13)
    #else
    static let fact: Font = .subheadline
    static let label: Font = .footnote
    static let role: Font = .footnote
    #endif
}

// MARK: - Team screen

struct TeamView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    init() {}

    var body: some View {
        @Bindable var router = router
        ScrollView {
            // Web .tm: 12 between panels, in the one shared content column.
            VStack(alignment: .leading, spacing: CESpace.m) {
                if let state = store.state {
                    sections(state)
                } else if store.isLoading {
                    EmptyTile(loading: true, title: "팀을 불러오는 중입니다")
                } else {
                    EmptyTile(icon: "person.2", title: "팀을 불러오지 못했습니다", detail: "연결 상태를 확인한 뒤 다시 동기화하세요.")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .ceContentColumn(top: isMac ? 16 : 12)
        }
        .refreshable { await store.refresh() }
        .modifier(TeamDetailPresentation(memberID: $router.memberID))
    }

    @ViewBuilder private func sections(_ state: ProjectState) -> some View {
        let project = state.project
        let members = state.members
        let needsStart = !store.isDemo && (!project.runnerEnabled || project.connection.reason == "runner_off" || members.isEmpty)

        if !store.isDemo, !project.connection.ok, project.connection.reason != "runner_off" {
            InlineNotice(tone: .attention, icon: "bolt.horizontal.circle", title: "실행 연결에 문제가 있습니다",
                         detail: project.connection.ownerDetail ?? "이 프로젝트의 실행 연결을 확인하세요.")
        }
        if needsStart {
            TeamStartPanel(project: project, hasMembers: !members.isEmpty)
        }
        // 지금 상황 lives on Home; the office shows who works where. 팀장 추가 sits in the office header.
        if !members.isEmpty {
            OfficeView(project: project, members: members, decisions: state.decisions)
        }
        if !state.work.isEmpty {
            TeamWorkList(work: state.work)
        }
        if members.isEmpty && !project.isHq {
            // Web .tm-adopt-entry: the glass button on its own row at the end, size m (44pt, 15 semibold).
            HStack {
                Spacer(minLength: 0)
                Button { router.showNewMember = true } label: { Label("팀장 추가", systemImage: "plus") }
                    .ceSecondaryButton()
                    .controlSize(.regular)
                    .disabled(!store.canWrite || !project.runnerEnabled)
                    .help(teamAddMemberHelp(store, project))
            }
        }
    }
}

/// Mac: the shell hosts the member detail (glass drawer inside the window). iOS: pushed detail on every size.
private struct TeamDetailPresentation: ViewModifier {
    @Binding var memberID: String?

    func body(content: Content) -> some View {
        #if os(macOS)
        content
        #else
        content.navigationDestination(item: $memberID) { id in
            // Fresh state per member: switching member in place must not show the previous one's activity.
            MemberDetailView(memberID: id).id(id).ceStatusStrips()
        }
        #endif
    }
}

// MARK: - Start panel

private struct TeamStartPanel: View {
    @Environment(AppStore.self) private var store
    let project: Project
    let hasMembers: Bool
    @State private var failure: String?

    private var runtimeBlock: String? {
        guard let core = store.runtime?.core, !core.available else { return nil }
        let base = core.installed ? "herdr-core가 설치돼 있지만 지금 쓸 수 없습니다." : "herdr-core가 설치돼 있지 않습니다."
        return [core.detail ?? base, "설정의 실행 환경에서 확인하세요."].joined(separator: " ")
    }

    private var message: String {
        if let runtimeBlock { return runtimeBlock }
        if !project.connection.ok, project.connection.reason != "runner_off", let detail = project.connection.ownerDetail, !detail.isEmpty { return detail }
        return hasMembers ? "총괄을 시작하면 팀이 다시 일을 이어갑니다." : "총괄이 일을 받아 Claude Code와 Codex 팀장을 꾸립니다."
    }

    private var lockReason: String? {
        if store.isDemo { return "샘플은 읽기 전용입니다." }
        if !store.canWrite { return "서버에 연결되면 시작할 수 있습니다." }
        return nil
    }

    var body: some View {
        let busy = store.pendingActions.contains("conductor-start")
        // Web .tm-start: padding 18, gap 8, radius 18; title 16/650, text 14/1.55 ink-2, a size-m primary button.
        Plate(padding: 18, raised: true, radius: CERadius.card) {
            VStack(alignment: .leading, spacing: 8) {
                Text(project.runnerEnabled && !hasMembers ? "아직 팀이 없습니다" : "총괄을 시작하세요")
                    .font(CEFont.title).foregroundStyle(CE.ink)
                    .lineSpacing(CELeading.title)
                    .fixedSize(horizontal: false, vertical: true)
                Text(message).font(TeamFont.fact).foregroundStyle(CE.ink2)
                    .lineSpacing(CELeading.spacing(14, 1.55))
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 12) {
                    Button {
                        Task {
                            failure = nil
                            if !(await store.startConductor()) { failure = store.errorMessage ?? "총괄을 시작하지 못했습니다." }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            if busy { ProgressView().controlSize(.small).tint(.white) }
                            Text(busy ? "시작하는 중" : "총괄 시작")
                        }
                    }
                    .ceProminentButton()
                    .controlSize(.regular)
                    .disabled(lockReason != nil || busy || runtimeBlock != nil)
                    Group {
                        if let lockReason { Text(lockReason) }
                        else if busy { Text("CLI 세션을 띄우는 데 시간이 걸릴 수 있습니다.") }
                    }
                    .font(CEFont.meta).foregroundStyle(CE.ink3)
                    .lineSpacing(CELeading.meta)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 6)
                if let failure {
                    teamFailure(failure)
                }
            }
        }
    }
}

// MARK: - Work list

private struct TeamWorkList: View {
    let work: [WorkItem]
    /// nil = 전체 (everything not done).
    @State private var filter: WorkSection?
    @State private var showAll = false
    private static let limit = 8

    var body: some View {
        let active = effectiveFilter
        let items = visible(active)
        let shown = showAll ? items : Array(items.prefix(Self.limit))
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text("업무").font(CEFont.section).foregroundStyle(CE.ink2).accessibilityAddTraits(.isHeader)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        TeamFilterChip(title: "전체", count: nil, selected: active == nil) { select(nil) }
                        ForEach(WorkSection.allCases) { section in
                            let n = count(section)
                            if n > 0 {
                                TeamFilterChip(title: section.title, count: n, selected: active == section) { select(section) }
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            // Web .tm-work__list: radius 18, padding 4 14.
            Plate(padding: 0, radius: CERadius.card) {
                VStack(spacing: 0) {
                    if shown.isEmpty {
                        teamEmptyNote("없음")
                    }
                    ForEach(Array(shown.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { RowDivider(inset: 0) }
                        row(item, filtered: active != nil)
                    }
                    if items.count > shown.count {
                        RowDivider(inset: 0)
                        Button { withAnimation(.easeOut(duration: 0.2)) { showAll = true } } label: {
                            Text("\(items.count - shown.count)건 더 보기").font(CEFont.note.weight(.medium)).foregroundStyle(CE.accent)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 4)
            }
        }
    }

    private func select(_ section: WorkSection?) {
        filter = section
        showAll = false
    }

    private func count(_ section: WorkSection) -> Int { work.filter { $0.sec == section.rawValue }.count }

    /// A chip that emptied out (its last item moved) falls back to 전체.
    private var effectiveFilter: WorkSection? {
        guard let filter, count(filter) > 0 else { return nil }
        return filter
    }

    private func visible(_ filter: WorkSection?) -> [WorkItem] {
        let sections = WorkSection.allCases
        func rank(_ item: WorkItem) -> Int { sections.firstIndex { $0.rawValue == item.sec } ?? sections.count }
        if let filter {
            let list = work.filter { $0.sec == filter.rawValue }
            if filter == .done { return list.sorted { ($0.doneAt ?? $0.updatedAt) > ($1.doneAt ?? $1.updatedAt) } }
            return list.sorted { $0.order < $1.order }
        }
        return work.filter { $0.sec != WorkSection.done.rawValue }
            .sorted { rank($0) != rank($1) ? rank($0) < rank($1) : $0.order < $1.order }
    }

    private func row(_ item: WorkItem, filtered: Bool) -> some View {
        let section = WorkSection(rawValue: item.sec)
        let trailing = section == .done ? relativeTime(item.doneAt) : (filtered ? "" : (section?.title ?? item.sec))
        let sub = [item.who, item.detail].filter { !$0.isEmpty }.joined(separator: " · ")
        // Web .tm-wi: padding 11 2, gap 11; title 14.5/1.4 wraps, sub 13/1.45 ink-2, the section label on the title's
        // baseline, the dot centred on the first line.
        return HStack(alignment: .firstTextBaseline, spacing: 11) {
            StatusDot(tone: section?.tone ?? .neutral, size: 8)
                .alignmentGuide(.firstTextBaseline) { $0.height / 2 + 5 }
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(CEFont.body.weight(.medium)).foregroundStyle(CE.ink)
                    .lineSpacing(CELeading.spacing(14.5, 1.4))
                    .fixedSize(horizontal: false, vertical: true)
                if !sub.isEmpty {
                    Text(sub).font(CEFont.secondary).foregroundStyle(CE.ink2)
                        .lineSpacing(CELeading.secondary).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !trailing.isEmpty {
                Text(trailing).font(CEFont.meta).foregroundStyle(CE.ink2).lineLimit(1).fixedSize()
            }
        }
        .padding(.vertical, 11).padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
    }
}

/// Web .tm-chip: 13.5/600 ink-2, 36 tall (44 on a phone), padding 0 13, dark capsule rgb(11 8 26 / .55) with a white
/// .1 hairline; selected = violet .42 fill and violet .9 rim; hover brightens the label.
private struct TeamFilterChip: View {
    let title: String
    let count: Int?
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title)
                if let count { Text("\(count)").monospacedDigit().fontWeight(.medium) }
            }
            #if os(macOS)
            .font(.system(size: 13.5, weight: .semibold))
            #else
            .font(.footnote.weight(.semibold))
            #endif
            .foregroundStyle(selected || hovering ? CE.ink : CE.ink2)
            .padding(.horizontal, isMac ? 13 : 14)
            .frame(minHeight: isMac ? 36 : 44)
            .background(selected ? CE.violet.opacity(0.42) : Color(red: 11 / 255, green: 8 / 255, blue: 26 / 255).opacity(0.55), in: Capsule())
            .overlay { Capsule().strokeBorder(selected ? CE.violet.opacity(0.9) : Color.white.opacity(0.1)) }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel(count.map { "\(title) \($0)건" } ?? title)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

// MARK: - Member detail (Mac: glass drawer hosted by the shell · iPhone: pushed)
//
// Top to bottom: who (name, state, one quiet meta line), what needs me (delivery, approval window, last error), what it
// is doing now (last report, next, queue, decisions, context), what I can do (지시 first, the rest in "…"), the last few
// lines of the room, then folded settings and activity. Flat plates (no glass on glass), quiet ink3 labels.

struct MemberDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #endif
    let memberID: String
    private let onClose: (() -> Void)?

    @State private var provider = "claude"
    @State private var model = ""
    @State private var effort = ""
    @State private var baseline = TeamConfigSnapshot()
    @State private var configRevision: Int?
    @State private var freshMember: Member?
    @State private var freshGeneration: Int?
    @State private var running: String?
    @State private var note: String?
    @State private var failure: String?
    @State private var sleepRefusal: String?
    @State private var configNote: String?
    @State private var configFailure: String?
    /// The last apply opened a session and left a handoff note in the queue (wake:false: it goes with the next instruction).
    @State private var configHandoff = false
    @State private var confirmConfig = false
    @State private var confirmFresh = false
    @State private var confirmForceSleep = false
    @State private var confirmClose = false
    @State private var configOpen = false
    @State private var activityOpen = false
    /// Shown after "터미널 명령 복사" (what the command does, and a warning for a running session).
    @State private var copyNote: String?

    init(memberID: String, onClose: (() -> Void)? = nil) {
        self.memberID = memberID
        self.onClose = onClose
    }

    private var current: Member? { store.members.first { $0.id == memberID } }
    private var compactAt: Int { store.bootstrap?.settings.compactAtPct ?? 70 }

    var body: some View {
        let member = current
        Group {
            if let member { content(member) } else { missing }
        }
        // Pushed (iOS): the app background. In the Mac drawer the shell's glass is the surface.
        .background { if onClose == nil { AmbientBackground() } }
        .modifier(TeamPushTitle(title: member?.name ?? "팀원", enabled: onClose == nil))
        .onAppear { if let member { loadConfig(member) } }
        .task(id: "\(store.writeNamespace)|\(memberID)") { await store.recoverWrites() }
        .onChange(of: store.writeNamespace) { _, _ in
            freshMember = nil; freshGeneration = nil; confirmFresh = false; confirmConfig = false
            if let latest = current { loadConfig(latest) }
        }
        .onChange(of: store.writeRevisions?.members?[memberID]?.configRevision) { _, _ in
            if running != "config", TeamConfigSnapshot(provider: provider, model: model, effort: effort) == baseline,
               let latest = current { loadConfig(latest) }
        }
        .onChange(of: memberID) { _, _ in
            freshMember = nil; freshGeneration = nil; confirmFresh = false; confirmConfig = false
            running = nil; note = nil; failure = nil; sleepRefusal = nil; configNote = nil; configFailure = nil; configHandoff = false
            copyNote = nil
            if let latest = current { loadConfig(latest) }
        }
        .onChange(of: member.map(TeamConfigSnapshot.init)) { old, new in
            // Follow server-side changes unless the user is in the middle of editing.
            guard new != nil else { return }
            if running != "config", old == nil || TeamConfigSnapshot(provider: provider, model: model, effort: effort) == baseline {
                if let latest = current { loadConfig(latest) }
            }
        }
    }

    // MARK: Layout

    @ViewBuilder private func deliveryPlate(_ m: Member) -> some View {
        if let summary = store.deliverySummary(memberID: m.id), !store.isArchive {
            let page = store.deliveryPages[m.id]
            Group {
                // A-60: the full plate only when the CEO has to act (or the notices failed to load). Ordinary waiting —
                // the member is busy, waking, or a turn ahead is being confirmed — is one line in 대기열 below.
                if summary.needsOwnerCount > 0 || store.deliveryErrors[m.id] != nil {
                    DeliveryNoticeView(summary: summary, items: page?.items ?? [], canWrite: store.canWrite,
                        pendingIDs: store.deliveryChecking, error: store.deliveryErrors[m.id],
                        hasOlder: page?.nextBefore != nil,
                        onLoadOlder: { Task { await store.loadDeliveryNotices(memberID: m.id, older: true) } },
                        onOpenMessage: { id in
                            openChat(m); router.chatMessageID = id
                        }, onOpenReference: { ref in
                            leaveDetail()
                            switch ref.type {
                            case "decision": router.openDecision(ref.id)
                            case "message": router.openChat(m.kind == "worker" ? m.id : nil); router.chatMessageID = ref.id
                            case "file", "attachment": router.openFile(ref.id)
                            default: router.go(.home)
                            }
                        }, onAction: { item, action, risk in
                            Task { _ = await store.recoverDelivery(item, action: action, acceptDuplicateRisk: risk) }
                        })
                    if store.deliveryErrors[m.id] != nil {
                        Button("전달 안내 다시 읽기") { Task { await store.loadDeliveryNotices(memberID: m.id) } }
                            .ceGhostButton().controlSize(.small).disabled(store.connectionStatus != .connected || store.isDemo)
                    }
                }
            }
            .task(id: "\(store.writeNamespace)|\(m.projectId)|\(m.id)") {
                await store.loadDeliveryNotices(memberID: m.id)
            }
        }
    }

    private func freshReceipts(_ m: Member) -> [OperationReceipt] {
        store.operationResults.values.filter { $0.memberId == m.id && $0.kind == .freshSession }
            .sorted { ($0.updatedAt ?? $0.createdAt ?? "", $0.operationId) > ($1.updatedAt ?? $1.createdAt ?? "", $1.operationId) }
    }

    private func freshUnresolved(_ m: Member) -> Bool {
        freshReceipts(m).contains { $0.status == .unknown || $0.status == .pending }
    }

    @ViewBuilder private func freshReceipt(_ m: Member) -> some View {
        if let receipt = freshReceipts(m).first(where: { $0.status == .unknown || $0.status == .pending }) ?? freshReceipts(m).first {
            VStack(alignment: .leading, spacing: 6) {
                switch receipt.status {
                case .pending, .unknown:
                    teamNote("새 세션 결과 확인 중 · 같은 작업을 다시 실행하지 않습니다.")
                    Button("결과 다시 확인") { Task { await store.recoverWrites() } }
                        .ceSecondaryButton().controlSize(.small).disabled(!store.canWrite || running != nil)
                case .refused:
                    teamNote(receipt.error ?? "새 세션 요청이 거부됐습니다. 최신 상태를 검토하세요.")
                case .applied:
                    teamNote("새 세션 요청이 적용됐습니다. 업무 완료를 뜻하지 않습니다.")
                }
            }
        }
    }

    /// Last thing the session did: the manual tool activity, or the newest turn timestamp (input, start, progress, end).
    /// The observation clock is not activity (it ticks every poll), so it is not used here.
    private func lastActivity(_ m: Member) -> (at: String, date: Date, label: String)? {
        if m.origin == "manual" {
            guard let at = m.manualActivityAt, let date = parseISODate(at) else { return nil }
            return (at, date, "도구 활동")
        }
        guard let execution = m.executionState else { return nil }
        let stamps = [execution.endedAt, execution.lastProgressAt, execution.startedAt, execution.inputReceivedAt]
            .compactMap { at in at.flatMap { value in parseISODate(value).map { (value, $0) } } }
        guard let latest = stamps.max(by: { $0.1 < $1.1 }) else { return nil }
        var label = executionLabel(execution)
        if let code = execution.exitCode { label += " · 종료 코드 \(code)" }
        if let reason = execution.reason, !reason.isEmpty { label += "\n\(reason)" }
        return (latest.0, latest.1, label)
    }

    private func executionLabel(_ execution: MemberExecutionState) -> String {
        switch execution.phase {
        case "received": "입력 수신 · 턴 시작 확인 중"
        case "starting": "입력 전달 중 · 턴 시작 확인 중"
        case "running", "working": "턴 진행 중 · 업무 완료는 보고로 확인합니다"
        case "ended", "finished": execution.result == "error" ? "턴 오류 · 입력 수신과 구분합니다" : "턴 종료 · 업무 완료는 보고로 확인합니다"
        case "interrupted": "턴 중단 · 자동으로 다시 입력하지 않습니다"
        default: "실행 상태 확인 중 · 자동으로 다시 입력하지 않습니다"
        }
    }

    private func compactBlock(_ m: Member) -> String? {
        if let reason = readOnlyReason { return reason }
        if m.origin == "manual" { return "직접 띄운 세션은 원래 터미널에서 압축하세요." }
        if store.state?.project.runnerEnabled != true { return "실행이 꺼져 있어 압축할 수 없습니다." }
        if m.paneId == nil || ["asleep", "offline", "gone"].contains(m.status) { return "열린 세션이 있어야 압축할 수 있습니다." }
        if (m.backend ?? store.bootstrap?.settings.backend) == "core", m.contextState == nil || m.sessionId == nil {
            return "세션 기록 확인 중 · 문맥 압축 대기"
        }
        if store.contextChecking.contains(m.id) { return "압축 결과 확인 중 · 다시 전송하지 않습니다." }
        if let phase = m.contextState?.compaction?.phase, [.queued, .sending, .running, .uncertain, .unknown].contains(phase) {
            return compactionLabel(m.contextState?.compaction)
        }
        return nil
    }

    private func compactionLabel(_ compact: ContextCompaction?) -> String {
        guard let compact else { return "압축 결과 확인 중 · 다시 전송하지 않습니다." }
        switch compact.phase {
        case .queued:
            switch compact.reason {
            case "working": return "압축 예약됨 · 지금 턴이 끝난 뒤 진행합니다."
            case "manual_control": return "직접 조작 중 · 압축 대기"
            case "draft": return "작성 중인 입력이 있어 압축을 기다립니다."
            case "blocked": return "CLI 화면을 먼저 확인하세요 · 압축 대기"
            default: return "압축 예약됨 · 안전한 실행 조건을 기다립니다."
            }
        case .sending, .running: return "문맥 압축 중"
        case .succeeded: return "문맥 압축 완료 · 사용량 갱신 중"
        case .failed: return compact.reason == "user_resolved" ? "사용자 확인으로 압축 대기를 해제했습니다." : "문맥 압축이 끝나지 않았습니다. 터미널을 확인하세요."
        default: return "압축 결과를 확인할 수 없습니다. 다시 보내지 말고 터미널을 확인하세요."
        }
    }

    /// One compact row: "문맥" + bar + percentage (how it was measured in the tooltip), and only while a compaction is
    /// pending, running, unconfirmed or failed, its one-line status. Compacting itself lives in the "…" menu.
    private func contextRow(_ m: Member) -> some View {
        let pct = contextPercent(m)
        return VStack(alignment: .leading, spacing: 4) {
            TeamFactRow(label: "문맥", alignment: .center) {
                Group {
                    if let pct {
                        TeamContextBar(pct: pct, compactAt: compactAt)
                    } else {
                        Text("확인 중").foregroundStyle(CE.ink3)
                    }
                }
                .help(contextHelp(m))
            }
            if let status = compactionStatus(m) {
                TeamFactRow(label: "") {
                    Text(status).font(CEFont.note).foregroundStyle(CE.ink2).lineSpacing(CELeading.note)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// Compaction status worth a line: in flight, unconfirmed, or failed (not a finished one, not a user release).
    private func compactionStatus(_ m: Member) -> String? {
        if store.contextChecking.contains(m.id) { return "압축 결과 확인 중 · 다시 전송하지 않습니다." }
        guard let compact = m.contextState?.compaction else { return nil }
        switch compact.phase {
        case .succeeded?: return nil
        case .failed?: return compact.reason == "user_resolved" ? nil : compactionLabel(compact)
        default: return compactionLabel(compact)
        }
    }

    /// Tooltip of the context meter: how the number was measured, the window and when.
    private func contextHelp(_ m: Member) -> String {
        guard contextPercent(m) != nil else { return "문맥 사용량을 아직 측정하지 못했습니다." }
        let measurement = contextMeasurement(m)
        var lines = [contextSource(m)]
        if let window = measurement?.window ?? m.contextWindow, window > 0 { lines.append("문맥 창 \(window.formatted()) 토큰") }
        if let date = parseISODate(measurement?.measuredAt) { lines.append("측정 \(koDateTime(date))") }
        lines.append("압축 기준 \(compactAt)%")
        return lines.joined(separator: "\n")
    }

    private func contextMeasurement(_ m: Member) -> ContextMeasurement? {
        guard let measurement = m.contextState?.measurement else { return nil }
        if let generation = measurement.sessionGeneration, let current = store.writeRevisions?.members?[m.id]?.sessionGeneration,
           generation != current { return nil }
        if let session = measurement.sessionId, let current = m.sessionId, session != current { return nil }
        return measurement
    }

    private func contextPercent(_ m: Member) -> Double? {
        if m.contextState?.measurement != nil, contextMeasurement(m) == nil { return nil }
        // The shared collector already prefers the CLI's official percentage over a token ratio.
        if let pct = m.contextPct, pct.isFinite { return min(max(pct, 0), 100) }
        if let measurement = contextMeasurement(m), let tokens = measurement.tokens, tokens >= 0,
           let window = measurement.window, window > 0 {
            return min(max(Double(tokens) / Double(window) * 100, 0), 100)
        }
        return nil
    }

    private func contextSource(_ m: Member) -> String {
        let measurement = contextMeasurement(m)
        guard measurement?.fresh == true else { return "마지막 측정 · 갱신 대기" }
        if measurement?.quality == "estimated" {
            let source: String
            switch measurement?.source {
            case "screen": source = "화면 기준"
            case "model": source = "모델 기준"
            case "default": source = "기본 창 기준"
            case "stored": source = "이전 측정 기준"
            default: source = "사용량 기준"
            }
            return "약 \(Int((contextPercent(m) ?? 0).rounded()))% · \(source) 추정"
        }
        guard measurement?.quality == "exact" else { return "측정 정확도 확인 중" }
        switch measurement?.source {
        case "statusline", "codex": return "CLI 측정"
        case "stored": return "이전 CLI 측정"
        default: return "측정 출처 확인 중"
        }
    }

    private func content(_ m: Member) -> some View {
        let drawer = onClose != nil
        return VStack(spacing: 0) {
            if let onClose {
                drawerHeader(m, onClose: onClose)
                // Lost connection / failed write stay visible while the drawer covers the content column.
                StatusStrips().padding(.horizontal, -10)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: CESpace.m) {
                    // iPhone: the name is the navigation title; state, rank and the meta line open the page.
                    if !drawer { phoneHeader(m) }
                    // What needs the CEO first (an approval window, an error); a delivery plate only below them.
                    if m.status == "blocked" { approvalBox(m) }
                    errorBox(m)
                    deliveryPlate(m)
                    nowPlate(m)
                    actions(m).padding(.horizontal, 2)
                    recentTalkPlate(m)
                    // A manual session has no settings here: only its folder, so no empty fold without one.
                    if m.origin != "manual" || !m.cwd.isEmpty { configPlate(m) }
                    activityPlate(m)
                }
                .frame(maxWidth: 760, alignment: .leading)
                // The plates start where the name in the drawer header does (18), as the web dialog's body does.
                .padding(.horizontal, drawer ? 18 : 16)
                .padding(.top, drawer ? 4 : 10)
                .padding(.bottom, drawer ? 14 : 24)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.automatic)
        }
        .confirmationDialog("새 세션으로 이어갈까요?", isPresented: $confirmFresh, titleVisibility: .visible) {
            Button("새 세션으로 이어가기") {
                // The server queues the handoff with wake:false; it reaches the CLI only with the next instruction.
                Task {
                    guard let reviewed = freshMember, let latest = current, latest.id == reviewed.id,
                          latest.projectId == reviewed.projectId, TeamConfigSnapshot(latest) == TeamConfigSnapshot(reviewed),
                          freshGeneration == store.writeRevisions?.members?[m.id]?.sessionGeneration else {
                        failure = "세션이 바뀌었습니다. 최신 상태를 확인하고 다시 선택하세요."; return
                    }
                    await run("fresh", success: Self.handoffQueuedNote("새 세션을 열었습니다.")) { await store.freshSession(latest) }
                }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("이전 세션의 기록을 보관하고 새 세션을 엽니다. CLI 내부 대화 기록이나 추론은 넘어가지 않고 역할·현재 일·다음만 인계 메모로 남깁니다. 인계 메모는 대기열에 들어가 다음 지시와 함께 전달됩니다. 이전 실행기의 터미널은 직접 종료할 때까지 그대로 둡니다.")
        }
        .confirmationDialog("세션을 다시 열까요?", isPresented: $confirmConfig, titleVisibility: .visible) {
            Button("적용하고 다시 열기") {
                Task { await applyConfig(m) }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text(reopenDetail(m, target: configTarget(m)))
        }
        .confirmationDialog("그래도 재울까요?", isPresented: $confirmForceSleep, titleVisibility: .visible) {
            Button("그래도 재우기", role: .destructive) {
                Task { await run("sleep", success: "잠재웠습니다. 대기열은 깨울 때까지 멈춥니다.") { await store.sleepMember(m, force: true) } }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text(forceSleepMessage)
        }
        .confirmationDialog("명부에서 뺄까요?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("명부에서 빼기", role: .destructive) {
                Task {
                    running = "close"; failure = nil; note = nil
                    let ok = await store.closeMember(m)
                    running = nil
                    if ok {
                        router.memberID = nil
                        if router.chatTarget == m.id { router.chatTarget = nil }
                    } else { failure = store.errorMessage ?? "명부에서 빼지 못했습니다." }
                }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("\(m.name) 세션을 IAMCEO 명부에서 뺍니다. 이 팀원에게 열린 결재는 함께 닫힙니다.")
        }
    }

    private var missing: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let onClose {
                HStack { Spacer(); CECloseButton(escapeCloses: false, action: onClose) }
            }
            if store.state == nil && store.isLoading {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("불러오는 중입니다").font(CEFont.note).foregroundStyle(CE.ink2) }
            } else {
                CompactEmpty(icon: "person.crop.circle.badge.questionmark", title: "찾을 수 없는 팀원입니다", detail: "명부에서 빠졌거나 다른 프로젝트의 팀원입니다.")
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Drawer header, inline (no title bar, no hairline): name, state badge and rank on one line with the round close
    /// button, then the role, the provider/model line and, only for a state I have to understand, what it means.
    private func drawerHeader(_ m: Member, onClose: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                Text(m.name).font(CEFont.title).foregroundStyle(CE.ink).lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                TeamMemberStatusBadge(member: m).fixedSize()
                if m.kind != "worker" { Tag(rankName(m.kind), tone: .accent) }
                if m.origin == "manual" { Tag("직접 띄움") }
                Spacer(minLength: 8)
                CECloseButton(escapeCloses: false, action: onClose)
            }
            headerDetails(m)
                .padding(.trailing, 6)
        }
        .padding(.leading, 18).padding(.trailing, 12)
        .padding(.top, 13).padding(.bottom, 12)
    }

    /// iPhone page top (the name is the navigation title): state, rank, then the same meta lines.
    private func phoneHeader(_ m: Member) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TeamMemberStatusBadge(member: m).fixedSize()
                if m.kind != "worker" { Tag(rankName(m.kind), tone: .accent) }
                if m.origin == "manual" { Tag("직접 띄움") }
            }
            headerDetails(m)
        }
        .padding(.horizontal, 2)
    }

    /// Web .tm-detail__top under the name: the role (13.5 ink-2), then the provider badge · model, 서브에이전트 n개
    /// in the working colour and the time at the trailing edge; the state meaning only when it matters.
    @ViewBuilder private func headerDetails(_ m: Member) -> some View {
        let info = MemberStatusInfo(m)
        VStack(alignment: .leading, spacing: 4) {
            if !m.role.isEmpty && m.role != m.name {
                Text(m.role).font(CEFont.note).foregroundStyle(CE.ink2)
                    .lineSpacing(CELeading.spacing(13.5, 1.4)).lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            metaLine(m)
            if showsExplanation(m, info: info) {
                Text(info.explanation).font(CEFont.note).foregroundStyle(CE.ink2)
                    .lineSpacing(CELeading.note)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }
        }
    }

    private func metaLine(_ m: Member) -> some View {
        let config = store.bootstrap?.settings.memberConfig(m)
        let applied = m.appliedModel ?? config?.model
        let requested = config?.model.flatMap { $0.isEmpty ? nil : $0 }
        let pending = requested.flatMap { value in m.appliedModel.flatMap { $0 != value ? value : nil } }
        var model: Text?
        if let applied, !applied.isEmpty { model = Text(applied).foregroundStyle(CE.ink2) }
        if let pending {
            let arrow = Text((model == nil ? "→ " : " → ") + pending).foregroundStyle(CE.attention)
            model = model.map { $0 + arrow } ?? arrow
        }
        let subagents = SubagentInfo(m)
        let subagentText: String? = subagents.count.flatMap { count in
            count > 0 ? (m.subagentState?.quality == "estimated" ? "서브에이전트 약 \(count)개" : "서브에이전트 \(count)개") : nil
        }
        let activity = lastActivity(m)
        var help: [String] = []
        if let pending { help.append("요청한 모델 \(pending) · 세션을 다시 열 때 적용") }
        if let activity { help.append("\(activity.label)\n\(koDateTime(activity.date))") }
        return HStack(alignment: .center, spacing: 8) {
            Tag(providerName(m.cli))
            if let model {
                model.font(CEFont.meta).lineLimit(1).truncationMode(.middle)
            }
            if let subagentText {
                Text(subagentText).font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.live).monospacedDigit()
                    .lineLimit(1).fixedSize()
            }
            Spacer(minLength: 8)
            if let activity {
                Text(relativeTime(activity.at)).font(CEFont.caption).foregroundStyle(CE.ink3).monospacedDigit()
                    .lineLimit(1).fixedSize()
            }
        }
        .help(help.joined(separator: "\n"))
        .accessibilityElement(children: .combine)
    }

    /// The state sentence only where the badge alone is not enough: down, failed, waiting on me, or not observed.
    /// blocked has its own box; a failed session with an error text says it in the error box.
    private func showsExplanation(_ m: Member, info: MemberStatusInfo) -> Bool {
        if MemberStatusInfo.progressNote(m) != nil { return true }
        if m.status == "blocked" { return false }
        if m.status == "error", !(m.lastError ?? "").isEmpty { return false }
        return info.tone == .attention || ["asleep", "offline", "gone", "error"].contains(m.status)
    }

    /// The approval window: a flat plate with a faint approval wash; colour stays in the mark, the text stays ink.
    /// The badge above already names the state, so the box says what to do. A prompt IAMCEO can read (core folder
    /// trust) is answered right here with Home's option card; 터미널 열기 stays as the way to look at the CLI itself
    /// and is the one main action when there is no card.
    private func approvalBox(_ m: Member) -> some View {
        let info = MemberStatusInfo(m)
        let readable = m.canReadCLIApproval
        return stateBox(tone: info.tone, icon: info.icon, title: "CLI 화면에서 처리가 필요합니다") {
            if readable {
                CLIApprovalCard(member: m)
            } else {
                // On core, blocked also means the CLI state could not be read.
                Text(info.explanation)
                    .font(CEFont.note).foregroundStyle(CE.ink2).lineSpacing(CELeading.note)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if m.origin != "manual" && !teamIsLegacy(m) {
                Group {
                    if readable {
                        Button { openTerminal(m) } label: { Label("터미널 열기", systemImage: "terminal") }.ceSecondaryButton()
                    } else {
                        Button { openTerminal(m) } label: { Label("터미널 열기", systemImage: "terminal") }.ceProminentButton()
                    }
                }
                .controlSize(.small)
                .help(terminalHelp(m))
                .padding(.top, 2)
            }
        }
    }

    /// The last error the session reported, in the same box as the approval window.
    @ViewBuilder private func errorBox(_ m: Member) -> some View {
        if let error = m.lastError?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
            stateBox(tone: .danger, icon: "exclamationmark.triangle.fill", title: "마지막 오류") {
                // Web .tm-error: the error itself in the danger colour, 13.5 / 1.45.
                Text(error)
                    .font(CEFont.note).foregroundStyle(CE.danger.opacity(0.92)).lineSpacing(CELeading.note)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                // The way back that is actually in reach: 깨우기 in the row, or for an older runner's session the menu.
                if m.status == "error" && m.origin != "manual" {
                    Text(teamIsLegacy(m) ? "… 메뉴의 새 세션으로 이어가기로 복구하세요." : "깨우기로 다시 여세요.")
                        .font(CEFont.note).foregroundStyle(CE.ink2).lineSpacing(CELeading.note)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func stateBox<Content: View>(tone: Tone, icon: String, title: String, @ViewBuilder content: () -> Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.card, style: .continuous)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: icon).font(.system(size: isMac ? 13.5 : 15, weight: .semibold)).foregroundStyle(tone.color)
                Text(title).font(CEFont.rowTitle).foregroundStyle(CE.ink)
                    .lineSpacing(CELeading.spacing(14.5, 1.35))
                    .fixedSize(horizontal: false, vertical: true)
            }
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.color.opacity(0.07), in: shape)
        .overlay { shape.strokeBorder(tone.color.opacity(0.2)) }
    }

    /// The last few lines of this member's conversation room, oldest first like the chat. A worker's room is its
    /// reports and what I sent it; the lead's room is its reports and what I sent without a target.
    private func recentTalk(_ m: Member) -> [Message] {
        let room = m.kind == "worker"
            ? store.messages.filter { $0.memberId == m.id || $0.targetMemberId == m.id }
            : store.messages.filter { $0.memberId == m.id || ($0.mine && $0.targetMemberId == nil) }
        return Array(room.suffix(4))
    }

    /// The room's last lines. The way into the room is the 대화방 action; a line opens the room at that message.
    private func recentTalkPlate(_ m: Member) -> some View {
        let talk = recentTalk(m)
        return DetailPlate {
            VStack(alignment: .leading, spacing: 4) {
                DetailSectionTitle("최근 대화")
                if talk.isEmpty {
                    Text("아직 주고받은 말이 없습니다").font(CEFont.note).foregroundStyle(CE.ink2)
                        .lineSpacing(CELeading.note).fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 6)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(talk.enumerated()), id: \.element.id) { index, message in
                            if index > 0 { RowDivider(inset: 0) }
                            Button {
                                openChat(m)
                                router.chatMessageID = message.id
                            } label: {
                                TeamTalkRow(message: message, notice: store.deliveryPages[m.id]?.items.first { $0.messageId == message.id },
                                            hasDeliveryNotices: store.deliveryNotices != nil)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(RowButtonStyle(radius: 8))
                            .help("대화방에서 이 말 보기")
                        }
                    }
                    // The row text stays under the title; the hover fill reaches a little past it.
                    .padding(.horizontal, -4)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    /// What it is doing now: the last report (with when), next, queue, open decisions, then one context row.
    private func nowPlate(_ m: Member) -> some View {
        let decisions = store.decisions.filter { $0.status == "open" && $0.memberId == m.id }.count
        let report = LastReportInfo(m)
        let reportedAt = parseISODate(m.nowAt)
        return DetailPlate {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        DetailSectionTitle(report.label)
                        Spacer(minLength: 8)
                        if let reportedAt {
                            Text(relativeTime(m.nowAt)).font(CEFont.caption).foregroundStyle(CE.ink3).monospacedDigit()
                                .help("보고 시각 \(koDateTime(reportedAt))")
                        }
                    }
                    // Web .tm-facts: 14 / 1.45.
                    if m.now.isEmpty {
                        Text(report.text).font(TeamFont.fact).foregroundStyle(CE.ink3)
                            .lineSpacing(CELeading.spacing(14, 1.45))
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(teamInlineMarkdown(m.now)).font(TeamFont.fact).foregroundStyle(CE.ink)
                            .lineSpacing(CELeading.spacing(14, 1.45))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                // Waiting deliveries the plate above no longer shows sit here (the larger of the two counts).
                let queued = max(m.queuedCount, store.deliverySummary(memberID: m.id)?.undeliveredCount ?? 0)
                if !m.next.isEmpty || queued > 0 || decisions > 0 {
                    VStack(alignment: .leading, spacing: 8) {
                        if !m.next.isEmpty {
                            TeamFactRow(label: "다음") {
                                Text(teamInlineMarkdown(m.next)).foregroundStyle(CE.ink).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        if queued > 0 {
                            TeamFactRow(label: "대기열") {
                                let summary = store.deliverySummary(memberID: m.id)
                                let reason = waitReasonLabel(summary?.waitReason, since: summary?.waitingSince,
                                                             used: summary?.runLimit?.used, limit: summary?.runLimit?.limit)
                                Text(["\(queued)건", reason].compactMap { $0 }.joined(separator: " · "))
                                    .foregroundStyle(summary?.waitReason.map { waitReasonTone($0) == .attention } == true ? CE.attention : CE.ink)
                                    .monospacedDigit()
                                    .fixedSize(horizontal: false, vertical: true)
                                    .help("아직 이 직원에게 넣지 않은 지시입니다")
                            }
                        }
                        if decisions > 0 {
                            TeamFactRow(label: "결재") {
                                // Web .tm-inlink: decisions waiting for me pull the eye (wait colour, semibold, underlined).
                                Button { goInbox(m) } label: {
                                    Text("\(decisions)건 대기 · 결재함으로").fontWeight(.semibold).foregroundStyle(CE.attention)
                                        .underline(true, color: CE.attention.opacity(0.7))
                                        .teamTallHitArea()
                                }
                                .buttonStyle(DetailPressStyle())
                                .help("결재함 열기")
                            }
                        }
                    }
                }
                if showsContextRow(m) {
                    RowDivider(inset: 0)
                    contextRow(m)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    /// A session that is down is never measured: no "확인 중" that cannot resolve. A pending compaction still shows.
    private func showsContextRow(_ m: Member) -> Bool {
        contextPercent(m) != nil || compactionStatus(m) != nil || !["asleep", "offline", "gone", "error"].contains(m.status)
    }

    /// 지시 first (the one main action, unless the approval box above holds it), 대화방 and 터미널 beside it, the
    /// state's urgent action (중단 / 깨우기) visible, everything else in "…". Notes and results stay right below.
    @ViewBuilder private func actions(_ m: Member) -> some View {
        let canAct = store.canWrite && !store.pendingActions.contains("member:\(m.id)") && running == nil
        let manual = m.origin == "manual"
        let legacy = teamIsLegacy(m)
        let busyTurn = ["working", "blocked"].contains(m.status)
        let runnerOn = store.state?.project.runnerEnabled ?? false
        let wakeable = ["asleep", "offline", "error"].contains(m.status)
        let approvalHoldsMain = m.status == "blocked" && !manual && !legacy
        // Only when there is a CLI to look at: an open pane, or a state that has one.
        let hasPane = !(m.paneId ?? "").isEmpty && !["asleep", "offline", "gone"].contains(m.status)
        let showsTerminal = !manual && !legacy && !approvalHoldsMain && (hasPane || ["working", "waiting", "idle"].contains(m.status) || TerminalAvailability.needsWake(m) || store.terminalWake.members.contains(m.id))
        VStack(alignment: .leading, spacing: 8) {
            TeamWrapLayout(spacing: 8, lineSpacing: 8) {
                Group {
                    if approvalHoldsMain {
                        Button { instruct(m) } label: { Label("지시", systemImage: "text.bubble") }.ceSecondaryButton()
                    } else {
                        Button { instruct(m) } label: { Label("지시", systemImage: "text.bubble") }.ceProminentButton()
                    }
                }
                .controlSize(.small)
                .help("\(m.name)에게 지시를 보냅니다")
                Button { openChat(m) } label: { Label("대화방", systemImage: "bubble.left.and.bubble.right") }
                    .ceSecondaryButton().controlSize(.small)
                    .help("\(m.name)와 주고받은 대화")
                if showsTerminal {
                    Button { openTerminal(m) } label: {
                        Label(TerminalAvailability.title(m, waking: store.terminalWake.members.contains(m.id), normal: isMac ? "터미널 직접 열기" : "터미널"), systemImage: "terminal")
                    }
                        .ceSecondaryButton().controlSize(.small)
                        .disabled(!store.canOpenTerminal(m))
                        .help(isMac ? "이 CLI 터미널을 봅니다. 입력 시작을 누를 때만 자동 전달이 멈춥니다." : terminalHelp(m))
                        .accessibilityLabel("\(m.name) \(TerminalAvailability.title(m, waking: store.terminalWake.members.contains(m.id)))")
                }
                if !manual && busyTurn {
                    actionButton("중단", icon: "stop.circle", busyTitle: "멈추는 중", name: "interrupt", enabled: canAct,
                                 help: "지금 턴을 멈추라고 보냅니다") {
                        Task { await run("interrupt", success: "멈추라고 보냈습니다. 지금 턴이 끊기면 대기로 바뀝니다.") { await store.memberAction(m, action: "interrupt") } }
                    }
                }
                if !manual && wakeable {
                    actionButton("깨우기", icon: "sunrise", busyTitle: "깨우는 중", name: "resume", enabled: canAct && runnerOn && !legacy && !store.terminalWake.members.contains(m.id),
                                 help: runnerOn ? "세션을 다시 엽니다" : "실행이 꺼져 있어 깨울 수 없습니다") {
                        Task { await run("resume", success: "다시 열라고 보냈습니다. 세션이 열리면 상태가 바뀝니다.") { await store.memberAction(m, action: "resume") } }
                    }
                }
                // Right after the server refused a plain 잠재우기 (failure line below): the follow-up stays in reach.
                if !manual && sleepRefusal != nil && !["asleep", "offline"].contains(m.status) {
                    actionButton("그래도 재우기…", icon: "moon.zzz.fill", enabled: canAct, help: "돌던 턴을 끊고 재웁니다. 먼저 확인을 받습니다.") {
                        confirmForceSleep = true
                    }
                }
                if hasMoreMenu(m) { moreMenu(m, canAct: canAct) }
            }
            #if os(iOS)
            // iPhone: words only, so the row stays on one line at phone width.
            .labelStyle(.titleOnly)
            #endif
            if let busy = menuBusyTitle {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(busy).font(CEFont.note).foregroundStyle(CE.ink2)
                }
            }
            freshReceipt(m)
            if let reason = readOnlyReason {
                teamStatus(reason, icon: store.isDemo ? "eye" : "wifi.slash")
            }
            if manual {
                teamNote("직접 띄운 세션입니다. 압축하거나 재울 수 없고, 보낸 말은 그 세션이 wait를 부를 때 전달됩니다.")
            } else if legacy {
                teamNote(teamLegacyNote)
            } else if wakeable && !runnerOn {
                teamNote("실행이 꺼져 있어 깨울 수 없습니다. 팀 화면에서 총괄을 시작하세요.")
            }
            if let note {
                teamStatus(note, icon: "paperplane")
            }
            if let copyNote {
                teamStatus(copyNote, icon: "doc.on.doc")
            }
            if let failure {
                teamFailure(failure)
            }
        }
    }

    /// Progress of an action started from the "…" menu, which closes as soon as it is chosen.
    private var menuBusyTitle: String? {
        switch running {
        case "sleep": "재우는 중"
        case "fresh": "새 세션을 준비하는 중"
        case "compact": "압축을 요청하는 중"
        case "close": "명부에서 빼는 중"
        default: nil
        }
    }

    /// False only for a manual lead with nothing to copy: no empty "…" menu.
    private func hasMoreMenu(_ m: Member) -> Bool {
        m.origin != "manual" || m.kind == "worker" || terminalCommand(m) != nil
    }

    /// The less frequent actions. A disabled item says why right under it (the sample/offline reason is shown once,
    /// below the buttons, instead).
    private func moreMenu(_ m: Member, canAct: Bool) -> some View {
        let manual = m.origin == "manual"
        let busyTurn = ["working", "blocked"].contains(m.status)
        let down = ["asleep", "offline"].contains(m.status)
        let compact = compactBlock(m)
        let freshReason: String? = busyTurn ? "일하거나 승인 창 앞이면 끝난 뒤 시작하세요" : (freshUnresolved(m) ? "새 세션 결과를 확인하는 중입니다" : nil)
        let command = terminalCommand(m)
        return Menu {
            if manual {
                if m.kind == "worker" {
                    Button(role: .destructive) { confirmClose = true } label: {
                        Label("명부에서 빼기…", systemImage: "person.crop.circle.badge.minus")
                    }
                    .disabled(!canAct)
                }
            } else {
                // After a refusal, 그래도 재우기 sits visibly in the row instead.
                if !down {
                    Button { Task { await sleep(m) } } label: { Label("잠재우기", systemImage: "moon.zzz") }
                        .disabled(!canAct)
                }
                Button {
                    freshMember = m
                    freshGeneration = store.writeRevisions?.members?[m.id]?.sessionGeneration
                    confirmFresh = true
                } label: { Label("새 세션으로 이어가기…", systemImage: "arrow.triangle.2.circlepath") }
                    .disabled(!canAct || freshReason != nil)
                    .help(freshReason ?? "역할·현재 일·다음을 새 세션에 인계합니다")
                if let freshReason, canAct { Text(freshReason) }
                Button {
                    Task { await run("compact", success: "압축 요청을 접수했습니다. 끝나면 문맥 사용량에 반영됩니다.") { await store.compactMember(m) } }
                } label: { Label("문맥 압축", systemImage: "arrow.down.right.and.arrow.up.left") }
                    .disabled(compact != nil || running != nil || store.pendingActions.contains("member:\(m.id)"))
                    .help(compact ?? "CLI에 문맥 압축을 요청합니다")
                if let compact, compact != readOnlyReason { Text(compact) }
            }
            if let command {
                Divider()
                Button { copyTerminalCommand(m, command: command) } label: { Label("터미널 명령 복사", systemImage: "doc.on.doc") }
                    .help(command.attached ? "서버 컴퓨터의 터미널에서 실행하면 같은 CLI 터미널을 엽니다" : "서버 컴퓨터의 터미널에서 이 세션을 다시 엽니다")
            }
        } label: {
            // As tall as the 32pt buttons beside it, so the row keeps one height.
            Image(systemName: "ellipsis")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(CE.ink2)
                .frame(width: isMac ? 32 : 38, height: isMac ? 32 : 38)
                .background(Color.white.opacity(0.06), in: Capsule())
                .overlay { Capsule().strokeBorder(Color.white.opacity(0.1)) }
                .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? nil : 44)
                .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("다른 조작")
        .accessibilityLabel("\(m.name) 다른 조작")
    }

    private func copyTerminalCommand(_ m: Member, command: (text: String, attached: Bool)) {
        teamCopy(command.text)
        if !command.attached && !["asleep", "offline"].contains(m.status) {
            // The warning stays until the next action: running the copy now would drive one session from two places.
            copyNote = "터미널 명령을 복사했습니다. 지금 도는 세션입니다. 두 곳에서 함께 쓰면 꼬이니 먼저 잠재우고 여세요."
            return
        }
        let shown = command.attached
            ? "터미널 명령을 복사했습니다. 서버 컴퓨터에서 실행하면 같은 CLI 터미널을 엽니다."
            : "터미널 명령을 복사했습니다."
        copyNote = shown
        // A plain confirmation clears itself, like the old 복사함.
        Task {
            try? await Task.sleep(for: .seconds(4))
            if copyNote == shown { copyNote = nil }
        }
    }

    private func terminalHelp(_ m: Member) -> String { "이 CLI의 터미널을 엽니다" }

    /// Folded: the session's folder, then (sessions IAMCEO started) the CLI, model and effort.
    private func configPlate(_ m: Member) -> some View {
        DetailPlate(padding: 0) {
            DisclosureGroup(isExpanded: $configOpen) {
                VStack(alignment: .leading, spacing: 10) {
                    if !m.cwd.isEmpty {
                        TeamFactRow(label: "폴더") {
                            Text(m.cwd).font(CEFont.mono).foregroundStyle(CE.ink2)
                                .textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                                .help(m.cwd)
                        }
                    }
                    if m.origin != "manual" { configBody(m) }
                }
                .padding(.bottom, 14)
            } label: {
                HStack(spacing: 8) {
                    DetailSectionTitle("실행 설정", fold: true)
                    Spacer(minLength: 8)
                    Text(configSummary(m)).font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1)
                }
            }
            .disclosureGroupStyle(TeamFoldStyle())
            .padding(.horizontal, 16)
            .padding(.vertical, 2)
        }
    }

    private func configBody(_ m: Member) -> some View {
        let switchAllowed = canSwitchProvider(m)
        let target = configTarget(m)
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let dirty = TeamConfigSnapshot(provider: target, model: trimmed, effort: effort) != baseline
        let reopens = dirty && configReopens(m, target: target, model: trimmed)
        let block = configBlock(m, target: target, reopens: reopens)
        let busy = running == "config"
        let rank = m.kind == "worker" ? "lead" : "manager"
        let rankConfig = store.bootstrap?.settings.rankConfig(rank, cli: target == "codex" ? .codex : .claude)
        let cli: RankSettingsCLI = target == "codex" ? .codex : .claude
        let list = store.modelCatalog.list(for: cli)
        let selected = list.option(for: trimmed)
        let efforts = list.efforts(for: trimmed.isEmpty ? (rankConfig?.model ?? "") : trimmed, cli: cli)
        let modelDefault = rankConfig?.model.map { "직급 기본값 (\($0))" } ?? "직급 기본값"
        let effortDefault = rankConfig?.effort.map { "직급 기본값 (\($0))" } ?? "직급 기본값"
        let modelShown = trimmed.isEmpty ? modelDefault : (selected?.label ?? list.unknownCurrent(trimmed) ?? trimmed)
        let effortShown = effort.isEmpty ? effortDefault : (efforts.contains(effort) ? effort : "현재: \(effort)")
        return VStack(alignment: .leading, spacing: 10) {
            // Web .field__label 13/600 ink-2 next to .input-sized controls (the fact rows above keep 13 ink-3).
            TeamFactRow(label: "AI CLI", alignment: .center, strong: true) {
                Picker("AI CLI", selection: Binding(get: { switchAllowed ? provider : m.cli }, set: { provider = $0 })) {
                    Text(providerOption("claude")).tag("claude")
                    Text(providerOption("codex")).tag("codex")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                #if os(macOS)
                .controlSize(.large)
                #endif
                .fixedSize()
                .disabled(!switchAllowed || !store.canWrite)
            }
            if let reason = switchBlockReason(m) { teamNote(reason) }
            TeamFactRow(label: "모델", alignment: .center, strong: true) {
                TeamSelect(value: modelShown, mono: !trimmed.isEmpty, accessibility: "모델") {
                    Picker("모델", selection: $model) {
                        Text(modelDefault).tag("")
                        ForEach(list.models) { option in
                            Text(option.label).tag(selected?.value == option.value ? trimmed : option.value)
                        }
                        if let unknown = list.unknownCurrent(trimmed) { Text(unknown).tag(trimmed).disabled(true) }
                    }
                    .labelsHidden()
                    .pickerStyle(.inline)
                }
                .disabled(!store.canWrite)
            }
            TeamFactRow(label: "effort", alignment: .center, strong: true) {
                TeamSelect(value: effortShown, accessibility: "effort") {
                    Picker("effort", selection: $effort) {
                        Text(effortDefault).tag("")
                        ForEach(efforts, id: \.self) { Text($0).tag($0) }
                        if !([""] + efforts).contains(effort) { Text("현재: \(effort)").tag(effort).disabled(true) }
                    }
                    .labelsHidden()
                    .pickerStyle(.inline)
                }
                .disabled(!store.canWrite)
            }
            if reopens {
                InlineNotice(tone: .attention, icon: "arrow.triangle.2.circlepath", title: reopenTitle(m, target: target),
                             detail: reopenDetail(m, target: target))
            }
            teamNote(configHelp(m))
            if configChanged(m) {
                teamNote("서버 설정이 바뀌었습니다. 내 편집은 보존했습니다. 현재 값 · \(configSummary(m))")
                Button("내 편집 유지하고 다시 검토") {
                    configRevision = store.writeRevisions?.members?[m.id]?.configRevision
                    baseline = TeamConfigSnapshot(m); configFailure = nil
                }.ceSecondaryButton().controlSize(.small).disabled(busy || !store.canWrite)
            }
            if let block {
                teamStatus(block, icon: "exclamationmark.circle", color: CE.attention)
            }
            HStack(spacing: 8) {
                if dirty && !busy {
                    Button("되돌리기") { loadConfig(m) }.ceGhostButton().controlSize(.small)
                }
                Spacer(minLength: 0)
                // A change that closes and reopens the session is confirmed first; a stored-only change applies directly.
                Button { if reopens { confirmConfig = true } else { Task { await applyConfig(m) } } } label: {
                    HStack(spacing: 6) {
                        if busy { ProgressView().controlSize(.small).tint(.white) }
                        Text(busy ? "적용하는 중" : "변경 적용")
                    }
                }
                .ceProminentButton()
                .controlSize(.small)
                .disabled(list.unknownCurrent(trimmed) != nil || !dirty || configChanged(m) || block != nil || !store.canWrite || running != nil || store.pendingActions.contains("member:\(m.id)"))
            }
            if let configNote {
                teamStatus(configNote, icon: configHandoff ? "tray.full" : "checkmark.circle")
                if configHandoff {
                    Button { instruct(m) } label: { Label("\(m.name)에게 지시", systemImage: "text.bubble") }
                        .ceSecondaryButton().controlSize(.small)
                }
            }
            if let configFailure {
                teamFailure(configFailure)
            }
        }
        .task(id: "\(store.writeNamespace)|\(configOpen)") {
            if configOpen { await store.refreshModels() }
        }
    }

    private func activityPlate(_ m: Member) -> some View {
        DetailPlate(padding: 0) {
            DisclosureGroup(isExpanded: $activityOpen) {
                ActivityList(memberID: m.id).padding(.bottom, 10)
            } label: {
                HStack {
                    DetailSectionTitle("활동", fold: true)
                    Spacer(minLength: 0)
                }
            }
            .disclosureGroupStyle(TeamFoldStyle())
            .padding(.horizontal, 16)
            .padding(.vertical, 2)
        }
    }

    /// State actions in the row (중단, 깨우기): the same quiet glass capsule as 대화방, with a spinner and a busy title
    /// while they run.
    @ViewBuilder private func actionButton(_ title: String, icon: String, busyTitle: String? = nil, name: String? = nil, enabled: Bool, help: String? = nil, action: @escaping () -> Void) -> some View {
        let busy = name != nil && running == name
        Button(action: action) {
            Label {
                Text(busy ? (busyTitle ?? title) : title)
            } icon: {
                if busy { ProgressView().controlSize(.small) } else { Image(systemName: icon) }
            }
        }
        .ceSecondaryButton()
        .controlSize(.small)
        .disabled(!enabled || busy)
        .help(help ?? title)
    }

    // MARK: Navigation

    /// On Mac the detail is a drawer over the window: leave it before going to another screen or the composer.
    private func leaveDetail() {
        #if os(macOS)
        if let onClose { onClose() } else { router.memberID = nil }
        #endif
    }

    /// Points the instruction composer at this member: the docked composer on Mac and iPhone.
    /// Drafts are keyed per target, so nothing already typed moves to someone else.
    private func instruct(_ m: Member) {
        leaveDetail()
        router.chatTarget = m.kind == "worker" ? m.id : nil
        router.focusComposer &+= 1
    }

    private func openChat(_ m: Member) {
        leaveDetail()
        router.openChat(m.kind == "worker" ? m.id : nil)
    }

    private func goInbox(_ member: Member) {
        guard let decision = UXTeamTerminal.openDecision(for: member.id, in: store.decisions) else { return }
        leaveDetail()
        router.openDecision(decision.id)
    }

    /// Mac opens a member-keyed window; iPhone presents the terminal before waking.
    private func openTerminal(_ m: Member) {
        guard store.canOpenTerminal(m) else { return }
        #if os(macOS)
        openWindow(id: "terminal", value: m.id)
        #else
        router.openTerminal(m.id)
        #endif
    }

    // MARK: Logic

    private var readOnlyReason: String? {
        if store.isDemo { return "샘플은 읽기 전용입니다. 실제 Mac에 연결하면 조작할 수 있습니다." }
        if store.isArchive { return "보관함은 읽기 전용입니다." }
        if store.connectionStatus != .connected { return "서버에 연결되지 않아 조작할 수 없습니다." }
        return nil
    }

    private var forceSleepMessage: String {
        var reason = (sleepRefusal ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        while reason.hasSuffix(".") { reason.removeLast() }
        let tail = "그래도 재우면 돌던 턴이 끊기고 대기열은 깨울 때까지 멈춥니다."
        return reason.isEmpty ? tail : "\(reason). \(tail)"
    }

    /// Web CopyCommand: the shared attach command (with the server's IAMCEO_HOME) for a core session with a pane, else
    /// the provider's resume command.
    private func terminalCommand(_ m: Member) -> (text: String, attached: Bool)? {
        if m.backend == "core", let pane = m.paneId, !pane.isEmpty {
            return (TerminalCommand.attach(memberID: m.id, bootstrap: store.bootstrap), true)
        }
        if let session = m.sessionId, !session.isEmpty {
            let resume = m.cli == "codex" ? "codex resume" : "claude --resume"
            return ("cd \(TerminalCommand.shellQuote(m.cwd)) && \(resume) \(TerminalCommand.shellQuote(session))", false)
        }
        return nil
    }

    private func configSummary(_ m: Member) -> String {
        let desired = store.bootstrap?.settings.memberConfig(m)
        return [providerFullName(m.cli), m.appliedModel ?? desired?.model, (m.appliedEffort ?? desired?.effort).map { "effort \($0)" }]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func providerOption(_ cli: String) -> String {
        let name = providerFullName(cli)
        return store.runtime?.providers[cli]?.installed == false ? "\(name) · 설치 필요" : name
    }

    private func canSwitchProvider(_ m: Member) -> Bool {
        !teamIsLegacy(m) && !["working", "blocked"].contains(m.status) && m.queuedCount == 0
    }

    private func switchBlockReason(_ m: Member) -> String? {
        if teamIsLegacy(m) { return "이전 실행기의 세션은 여기서 CLI를 전환할 수 없습니다. 새 세션으로 이어가기를 쓰세요." }
        if ["working", "blocked"].contains(m.status) { return "일이나 전달 대기가 끝나면 CLI를 바꿀 수 있습니다." }
        // Held notes (e.g. a handoff, wake:false) leave the queue only together with the next instruction.
        if m.queuedCount > 0 { return "대기열 \(m.queuedCount)건이 CLI에 들어간 뒤 바꿀 수 있습니다. 대기열은 다음 지시와 함께 들어갑니다." }
        return nil
    }

    private func configTarget(_ m: Member) -> String { canSwitchProvider(m) ? provider : m.cli }

    /// Server: on a core member with a session, a model/effort change closes the CLI and opens it again (patchMemberConfig → switchProvider).
    private func hasLiveCoreSession(_ m: Member) -> Bool {
        m.backend == "core" && (!(m.sessionId ?? "").isEmpty || !(m.paneId ?? "").isEmpty)
    }

    /// True when applying closes the current session and opens a new one (provider switch, or model/effort on a live core session).
    private func configReopens(_ m: Member, target: String, model trimmed: String) -> Bool {
        if target != m.cli { return true }
        let changed = trimmed != (m.modelOverride ?? "") || effort != (m.effortOverride ?? "")
        return changed && hasLiveCoreSession(m)
    }

    /// Server keeps the Claude session id (resume) only for a same-provider Claude change; everything else is a new session.
    private func resumesClaude(_ m: Member, target: String) -> Bool {
        target == m.cli && m.cli == "claude" && !(m.sessionId ?? "").isEmpty
    }

    private func reopenTitle(_ m: Member, target: String) -> String {
        target != m.cli ? "적용하면 \(providerFullName(target)) 새 세션으로 인계합니다" : "적용하면 지금 세션을 닫고 새 설정으로 다시 엽니다"
    }

    private func reopenDetail(_ m: Member, target: String) -> String {
        var parts: [String] = []
        if resumesClaude(m, target: target) {
            parts.append("같은 Claude 대화를 새 모델·effort로 이어 엽니다.")
        } else {
            parts.append("새 \(providerFullName(target)) 세션을 엽니다. 이전 대화는 이어지지 않고 역할·현재 일·다음만 인계합니다.")
        }
        if m.status == "asleep" { parts.append("잠든 팀원도 바로 깨워서 엽니다.") }
        parts.append("인계 메모는 대기열에 들어가 다음 지시와 함께 전달됩니다.")
        return parts.joined(separator: " ")
    }

    private func configHelp(_ m: Member) -> String {
        hasLiveCoreSession(m)
            ? "CLI를 바꾸면 새 세션을 열어 인계합니다. 세션이 있어서 모델·effort를 바꿔도 지금 세션을 닫고 다시 엽니다. 빈 모델은 직급 기본값을 씁니다."
            : "CLI를 바꾸면 새 세션을 열어 인계합니다. 모델·effort 변경은 세션을 열 때 적용됩니다. 빈 모델은 직급 기본값을 씁니다."
    }

    private func configBlock(_ m: Member, target: String, reopens: Bool) -> String? {
        if !effort.isEmpty && !(target == "codex" ? RankSettingsCLI.codex : .claude).efforts.contains(effort) { return "선택한 CLI에서 지원하지 않는 effort입니다. 다른 값을 고르세요." }
        if target != m.cli, store.runtime?.providers[target]?.installed == false {
            return "\(providerFullName(target))가 실행 호스트에 설치돼 있지 않습니다. 설정의 실행 환경을 확인하세요."
        }
        // The server refuses to close a session mid-turn or at an approval window (409).
        if reopens && ["working", "blocked"].contains(m.status) {
            return "일하거나 승인 창 앞이면 세션을 다시 열 수 없습니다. 턴이 끝난 뒤 적용하세요."
        }
        return nil
    }

    /// "Opened" is not "handed over": the handoff note waits in the queue until a wake message goes out.
    private static func handoffQueuedNote(_ opened: String) -> String {
        "\(opened) 인계 메모는 대기열에 있고, 다음 지시를 보내면 함께 들어갑니다."
    }

    private func loadConfig(_ m: Member) {
        apply(TeamConfigSnapshot(m))
        configRevision = store.writeRevisions?.members?[m.id]?.configRevision
    }

    private func configChanged(_ m: Member) -> Bool {
        TeamConfigSnapshot(m) != baseline || configRevision != store.writeRevisions?.members?[m.id]?.configRevision
    }

    private func apply(_ snapshot: TeamConfigSnapshot) {
        provider = snapshot.provider
        model = snapshot.model
        effort = snapshot.effort
        baseline = snapshot
    }

    private func run(_ name: String, success: String, _ operation: () async -> Bool) async {
        let namespace = store.writeNamespace, id = memberID
        running = name; failure = nil; note = nil; sleepRefusal = nil; copyNote = nil
        let ok = await operation()
        guard namespace == store.writeNamespace, id == memberID else { return }
        running = nil
        guard ok else {
            failure = store.errorMessage ?? "요청을 처리하지 못했습니다."
            return
        }
        // A start failure after a handoff leaves the member in error: say so instead of claiming success.
        if ["fresh", "resume"].contains(name), let latest = current, latest.status == "error" {
            failure = latest.lastError ?? "세션을 열지 못했습니다."
        } else {
            note = success
        }
    }

    private func sleep(_ m: Member) async {
        await run("sleep", success: "잠재웠습니다. 깨우거나 지시를 보내면 다시 엽니다.") { await store.sleepMember(m) }
        // The daemon refuses a plain sleep while the member works, waits on a decision or has queued input.
        // An input-box or approval-window refusal cannot be overridden: the CEO has to clear it first.
        if let failure, ["일하는 중", "열린 결재", "대기열"].contains(where: { failure.contains($0) }),
           !failure.contains("입력칸"), !failure.contains("승인 창") {
            sleepRefusal = failure
        }
    }

    private func applyConfig(_ m: Member) async {
        guard !configChanged(m) else {
            configFailure = "서버 설정이 바뀌었습니다. 내 편집을 유지하고 다시 검토하세요."; return
        }
        let target = configTarget(m)
        let switching = target != m.cli
        let sent = TeamConfigSnapshot(provider: provider, model: model, effort: effort)
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let reopens = configReopens(m, target: target, model: trimmed)
        let namespace = store.writeNamespace, id = memberID
        running = "config"; configNote = nil; configFailure = nil; configHandoff = false
        let ok = await store.patchMember(m, provider: target, model: trimmed.isEmpty ? nil : trimmed, effort: sent.effort.isEmpty ? nil : sent.effort)
        guard namespace == store.writeNamespace, id == memberID else { return }
        running = nil
        guard ok else {
            configFailure = store.errorMessage ?? "설정을 바꾸지 못했습니다."
            return
        }
        if let latest = current {
            if TeamConfigSnapshot(provider: provider, model: model, effort: effort) == sent { loadConfig(latest) }
            else {
                baseline = TeamConfigSnapshot(latest)
                configRevision = store.writeRevisions?.members?[latest.id]?.configRevision
            }
            // Any apply that rotated the session can leave the member in error ("새 세션 시작 실패: …").
            if reopens && latest.status == "error" {
                configFailure = latest.lastError ?? "새 세션을 시작하지 못했습니다."
                return
            }
        }
        guard reopens else {
            configNote = "저장했습니다. 세션을 열 때 적용됩니다."
            return
        }
        configHandoff = true
        let opened = switching
            ? "\(providerFullName(target)) 새 세션을 열었습니다."
            : (resumesClaude(m, target: target) ? "같은 Claude 대화를 새 설정으로 다시 열었습니다." : "새 설정으로 \(providerFullName(target)) 새 세션을 열었습니다.")
        configNote = Self.handoffQueuedNote(opened)
    }
}

/// One line of the room: mine = "나" · text · delivery · time; a report = kind tag · title (or first line) · time.
private struct TeamTalkRow: View {
    let message: Message
    var notice: DeliveryNoticeItem?
    var hasDeliveryNotices = false
    @ScaledMetric(relativeTo: .caption) private var markWidth: CGFloat = 40

    var body: some View {
        // Same rhythm as the activity rows (web .tm-act 13.5): about 36pt a row.
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            mark.frame(minWidth: markWidth, alignment: .leading)
            Text(text).font(CEFont.note).foregroundStyle(CE.ink).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if message.mine, let delivery = notice.map(DeliveryInfo.init) ?? DeliveryInfo(hasDeliveryNotices && ["held", "failed"].contains(message.delivery ?? "") ? nil : message.delivery) {
                Text(delivery.label).font(CEFont.meta.weight(.semibold)).foregroundStyle(delivery.tone.color).lineLimit(1).fixedSize()
                    .help(delivery.explanation)
            }
            Text(relativeTime(message.at)).font(CEFont.caption).foregroundStyle(CE.ink3).monospacedDigit().lineLimit(1).fixedSize()
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var mark: some View {
        if message.mine {
            Text("나").font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.accent)
        } else if !message.kind.isEmpty {
            Tag(message.kind, tone: messageKindTone(message.kind))
        } else {
            Text(message.who).font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1)
        }
    }

    private var text: String {
        if message.mine {
            let body = plainOneLine(message.body)
            if !body.isEmpty { return body }
            return message.attachments.isEmpty ? "—" : "첨부 \(message.attachments.count)개"
        }
        let title = plainOneLine(message.title)
        if !title.isEmpty { return title }
        let first = message.body.components(separatedBy: .newlines).map(plainOneLine).first { !$0.isEmpty }
        return first ?? "—"
    }
}

private struct TeamConfigSnapshot: Equatable {
    var provider = "claude"
    var model = ""
    var effort = ""
    init() {}
    init(provider: String, model: String, effort: String) { self.provider = provider; self.model = model; self.effort = effort }
    init(_ m: Member) { provider = m.cli; model = m.modelOverride ?? ""; effort = m.effortOverride ?? "" }
}

private struct TeamPushTitle: ViewModifier {
    let title: String
    let enabled: Bool
    func body(content: Content) -> some View {
        #if os(iOS)
        if enabled {
            content.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        } else {
            content
        }
        #else
        content
        #endif
    }
}

/// Web .tm-ctx: 72×5 bar and the percentage; orange with a badge once the compact threshold is reached.
private struct TeamContextBar: View {
    let pct: Double
    let compactAt: Int

    var body: some View {
        let value = Int(min(max(pct, 0), 100).rounded())
        let due = value >= compactAt
        HStack(spacing: 8) {
            Capsule().fill(Color.white.opacity(0.12)).frame(width: 72, height: 5)
                .overlay(alignment: .leading) {
                    Capsule().fill(due ? CE.attention : CE.live).frame(width: 72 * CGFloat(value) / 100, height: 5)
                }
            Text("\(value)%").font(CEFont.secondary).monospacedDigit().foregroundStyle(CE.ink)
            if due { Tag("압축 기준 도달", tone: .attention) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("문맥 사용 \(value)퍼센트" + (due ? ", 압축 기준 도달" : ""))
    }
}

// MARK: - Activity

/// Recent CLI activity for one member (`GET /api/members/:id/activity`). Newest first.
struct ActivityList: View {
    @Environment(AppStore.self) private var store
    let memberID: String
    @State private var items: [Activity] = []
    @State private var loading = false
    @State private var loaded = false
    @State private var error: String?
    @State private var expanded: Set<Int> = []
    /// Member the list currently shows. @State reads after an await see the latest value, unlike the captured `memberID`.
    @State private var shownFor: String?
    /// Bumped per request; only the newest request may write results.
    @State private var request = 0
    @ScaledMetric(relativeTo: .caption) private var metaWidth: CGFloat = 84

    init(memberID: String) { self.memberID = memberID }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if loaded && !items.isEmpty {
                    Text("최근 \(items.count)건").font(CEFont.meta).foregroundStyle(CE.ink3).monospacedDigit()
                }
                Spacer(minLength: 0)
                if loading { ProgressView().controlSize(.mini) }
                Button { Task { await load(memberID) } } label: {
                    Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold)).frame(width: 26, height: 26)
                        .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? nil : 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(CE.ink2)
                .disabled(loading || store.isDemo || store.api == nil)
                .help("활동 새로 고침")
                .accessibilityLabel("활동 새로 고침")
            }
            list
        }
        .task(id: "\(store.writeNamespace)|\(memberID)") {
            shownFor = memberID
            items = []; loaded = false; expanded = []; error = nil
            await load(memberID)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                if store.connectionStatus == .connected, !loading { await load(memberID) }
            }
        }
        .onChange(of: store.connectionStatus) { _, status in
            if status == .connected { Task { await load(memberID) } }
        }
    }

    @ViewBuilder private var list: some View {
        // Empty and loading states are the web .tm-note: centred, 14 above and below.
        if store.isDemo {
            teamEmptyNote("샘플에는 활동 기록이 없습니다.")
        } else if let error, items.isEmpty {
            teamFailure(error)
        } else if !loaded {
            teamEmptyNote(loading ? "불러오는 중입니다" : "서버에 연결되면 활동을 불러옵니다.")
        } else if items.isEmpty {
            teamEmptyNote("아직 활동이 없습니다")
        } else {
            if let error { teamFailure(error) }
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { RowDivider(inset: 0) }
                    row(item)
                }
            }
        }
    }

    /// Web .tm-act: time and kind in an 84pt column, then the text (tool output monospaced, long text clamped to 3 lines).
    private func row(_ item: Activity) -> some View {
        let long = item.text.count > 180 || item.text.contains("\n")
        let open = expanded.contains(item.id)
        let mono = item.kind == "tool" || item.kind == "tool_result"
        // Web .tm-act: text 13.5 / 1.5 (tool output 12.5 monospaced), meta 12 in an 84pt column.
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            HStack(spacing: 8) {
                Text(clockTime(item.at)).font(CEFont.caption).monospacedDigit().foregroundStyle(CE.ink3)
                Text(activityKindName(item.kind)).font(CEFont.caption.weight(.semibold)).foregroundStyle(kindColor(item.kind))
            }
            .frame(width: metaWidth, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.text.isEmpty ? "—" : item.text)
                    .font(mono ? CEFont.mono : CEFont.note)
                    .lineSpacing(mono ? CELeading.spacing(12.5, 1.5) : CELeading.spacing(13.5, 1.5))
                    .foregroundStyle(textColor(item.kind))
                    .lineLimit(open ? nil : 3)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if long {
                    Button(open ? "접기" : "더 보기") {
                        if open { expanded.remove(item.id) } else { expanded.insert(item.id) }
                    }
                    .buttonStyle(.plain)
                    .font(CEFont.meta)
                    .foregroundStyle(CE.accent)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 8)
    }

    private func kindColor(_ kind: String) -> Color {
        switch kind {
        case "tool": CE.live
        case "error": CE.danger
        default: CE.ink2
        }
    }

    private func textColor(_ kind: String) -> Color {
        switch kind {
        case "error": CE.danger
        case "tool_result", "turn_start", "turn_end", "system": CE.ink2
        default: CE.ink
        }
    }

    private func load(_ id: String) async {
        guard !store.isDemo else { return }
        guard let api = store.api else { return }
        // A newer request (another member, or a reload) supersedes this one instead of being skipped by it.
        request &+= 1
        let mine = request
        loading = true
        defer { if request == mine { loading = false } }
        do {
            let result = try await api.activity(memberID: id)
            guard request == mine, shownFor == id, !Task.isCancelled else { return }
            items = result.sorted { $0.id > $1.id }
            error = nil
            loaded = true
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            guard request == mine, shownFor == id else { return }
            self.error = friendlyLoadError(error, what: "활동", verb: "읽지")
        }
    }
}

// MARK: - New member

import Observation

/// App lifetime state; dismissing the form never cancels or replays the creation request.
@MainActor @Observable
final class MemberCreationNotice {
    enum Outcome: Sendable, Equatable {
        case created(String), partial(String?, String), failed(String), hostChanged
    }
    static let shared = MemberCreationNotice()
    private(set) var namespace = ""
    private(set) var projectID: String?
    private(set) var memberID: String?
    private(set) var message: String?
    private(set) var running = false
    private(set) var failed = false

    func clear() { message = nil }

    func create(store: AppStore, name: String, role: String, provider: String, model: String?) async -> Outcome {
        guard !running, store.canWrite, !store.pendingActions.contains("create-member"),
              let client = store.api, let project = store.state?.project,
              !project.isHq, project.runnerEnabled else { return .failed("지금은 직원을 추가할 수 없습니다.") }
        namespace = ProjectCreationNotice.scope(store)
        projectID = project.id; memberID = nil; failed = false; running = true
        message = "직원을 만드는 중입니다. 창을 닫아도 계속됩니다."
        defer { running = false }
        let before = Set(store.members.map(\.id))
        let sameHost = { self.namespace == ProjectCreationNotice.scope(store) && store.api === client }
        func hostChanged() -> Outcome {
            failed = true
            message = "연결이 바뀌었습니다. 원래 Mac에 연결해 직원 만들기 결과를 확인해 주세요."
            return .hostChanged
        }
        do {
            let member: Member = try await client.send("/api/projects/\(APIClient.segment(project.id))/members",
                body: CreateMemberRequest(name: name, role: role, cli: provider, modelOverride: model), timeout: 150)
            guard sameHost() else { return hostChanged() }
            guard member.projectId == project.id, !member.id.isEmpty else { throw URLError(.badServerResponse) }
            memberID = member.id
            message = "직원을 만들었습니다. 이 직원에게 첫 일을 맡겨 보세요."
            await store.refresh()
            guard sameHost() else { memberID = nil; return hostChanged() }
            return .created(member.id)
        } catch {
            guard sameHost() else { return hostChanged() }
            failed = true
            let detail = friendlyLoadError(error, what: "직원 만들기 결과", verb: "확인하지")
            // Read the original project even if the user switched projects while waiting.
            let snapshot: ProjectState? = try? await client.request("/api/projects/\(APIClient.segment(project.id))/state")
            guard sameHost() else { return hostChanged() }
            let matches = snapshot?.project.id == project.id
                ? snapshot?.members.filter { !before.contains($0.id) && $0.name == name && $0.cli == provider } ?? [] : []
            if matches.count == 1, let member = matches.first {
                memberID = member.id
                message = "직원은 등록됐습니다. 준비 상태를 확인해 주세요. \(detail)"
                await store.refresh()
                guard sameHost() else { memberID = nil; return hostChanged() }
                return .partial(member.id, message!)
            }
            message = "\(detail) 팀에서 등록 여부를 확인해 주세요. 자동으로 다시 요청하지 않습니다."
            return .failed(message!)
        }
    }

    @discardableResult func openMember(store: AppStore, router: Router) async -> Bool {
        guard namespace == ProjectCreationNotice.scope(store), let projectID, let memberID,
              let client = store.api else { return false }
        let navigation = router.navigationRevision
        if store.selectedProjectID != projectID { await store.selectProject(id: projectID) }
        guard namespace == ProjectCreationNotice.scope(store), store.api === client,
              router.navigationRevision == navigation else { return false }
        guard store.state?.project.id == projectID, store.members.contains(where: { $0.id == memberID }) else {
            router.navigationNotice = "직원을 열지 못했습니다. 팀에서 준비 상태를 확인해 주세요."
            return false
        }
        router.openChat(memberID)
        router.focusComposer &+= 1
        clear()
        return true
    }
}

/// Shared banner for the form and the app's notice host.
struct MemberCreationBanner: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    var onOpen: (() -> Void)? = nil
    var body: some View {
        let notice = MemberCreationNotice.shared
        if notice.namespace == ProjectCreationNotice.scope(store), let message = notice.message {
            InlineNotice(tone: notice.failed ? .attention : notice.running ? .neutral : .success,
                         title: notice.running ? "직원 준비 중" : "직원 만들기 결과", detail: message,
                         actionTitle: notice.memberID == nil || notice.running ? "닫기" : "이 직원에게 첫 일 맡기기") {
                if notice.memberID != nil, !notice.running {
                    Task { if await notice.openMember(store: store, router: router) { onOpen?() } }
                } else { notice.clear() }
            }
        }
    }
}

struct NewMemberView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var role = ""
    @State private var selection = NewMemberModelSelection()
    @State private var failure: String?
    @State private var submitted = false
    @State private var presented = false
    @State private var backgroundMessage: String?
    @FocusState private var focus: NewMemberField?

    init() {}

    private var busy: Bool { MemberCreationNotice.shared.running || store.pendingActions.contains("create-member") }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var blockReason: String? {
        if store.isDemo { return "샘플은 읽기 전용입니다. 실제 Mac에 연결하면 팀장을 추가할 수 있습니다." }
        if !store.canWrite { return "서버에 연결되지 않아 추가할 수 없습니다." }
        guard let project = store.state?.project else { return "프로젝트를 불러온 뒤 추가할 수 있습니다." }
        if project.isHq { return "본사에는 팀장을 추가하지 않습니다." }
        if !project.runnerEnabled { return "이 프로젝트는 실행이 꺼져 있습니다. 팀 화면에서 총괄을 먼저 시작하세요." }
        return nil
    }

    /// The shared popup frame: what it does in the header, the form, 취소 / 추가 in the footer band.
    var body: some View {
        // One line; the wait hint only while the session is being prepared.
        CESheet("팀장 추가", subtitle: busy ? "세션을 준비하는 중입니다. 잠시 걸릴 수 있습니다." : "새 CLI 세션을 띄워 팀장으로 등록합니다.",
                icon: "person.badge.plus", width: 520, onClose: { dismiss() }) {
            form
        } footer: {
            Button("취소") { dismiss() }.ceSecondaryButton().controlSize(.regular)
            addButton.controlSize(.regular).keyboardShortcut(.defaultAction)
        }
        .scrollDismissesKeyboard(.interactively)
        .task { await store.refreshModels() }
        .overlay(alignment: .top) { MemberCreationBanner(onOpen: { dismiss() }).padding() }
        .onAppear { presented = true }
        .onDisappear {
            presented = false
            if submitted, busy, router.navigationNotice == nil,
               let message = MemberCreationNotice.shared.message {
                backgroundMessage = message
                router.navigationNotice = message
            }
        }
        #if os(macOS)
        .onAppear { if store.canWrite { focus = .name } }
        #endif
    }

    private var addButton: some View {
        Button { Task { await add() } } label: {
            HStack(spacing: 6) {
                if busy { ProgressView().controlSize(.small).tint(.white) }
                Text(busy ? "추가하는 중" : "추가")
            }
        }
        .ceProminentButton()
        .disabled(trimmedName.isEmpty || busy || submitted || blockReason != nil)
    }

    /// Web form: 14 between fields, 6 between a label (13/600 ink-2) and its 44pt input; errors 13.5 danger.
    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let failure {
                InlineNotice(tone: .danger, icon: "exclamationmark.triangle", title: friendlyError(failure))
            } else if let blockReason {
                InlineNotice(tone: .attention, icon: "info.circle", title: blockReason)
            }
            field("이름", text: $name, prompt: "개발 담당", plain: false, id: .name)
            field("역할 · 선택", text: $role, prompt: "결제 화면 구현", plain: false, id: .role)
            SetupField("팀장이 쓸 AI") {
                Picker("AI CLI", selection: $selection.provider) {
                    Text(providerOption("claude")).tag("claude")
                    Text(providerOption("codex")).tag("codex")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                #if os(macOS)
                .controlSize(.large)
                #endif
                .frame(maxWidth: .infinity)
            }
            SetupField("모델") {
                let cli: RankSettingsCLI = selection.provider == "codex" ? .codex : .claude
                let list = store.modelCatalog.list(for: cli)
                let defaultModel = store.bootstrap?.settings.rankConfig("lead", cli: cli)?.model
                Picker("모델", selection: $selection.model) {
                    Text(defaultModel.map { "직급 기본값 (\($0))" } ?? "직급 기본값").tag("")
                    ForEach(list.models) { option in Text(option.label).tag(option.id) }
                }.labelsHidden()
            }
            if store.runtime?.providers[selection.provider]?.installed == false {
                InlineNotice(tone: .attention, icon: "exclamationmark.triangle", title: "\(providerFullName(selection.provider))가 설치돼 있지 않습니다",
                             detail: "설정의 실행 환경을 확인하세요.")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func field(_ label: String, text: Binding<String>, prompt: String, plain: Bool, id: NewMemberField) -> some View {
        SetupField(label) {
            // Name and optional role use the shared setup field.
            Group {
                if plain {
                    TextField(label, text: text, prompt: Text(prompt)).font(Self.codeFont)
                } else {
                    TextField(label, text: text, prompt: Text(prompt))
                }
            }
                .focused($focus, equals: id)
                .ceField(focused: focus == id)
                .autocorrectionDisabled(plain)
                #if os(iOS)
                .textInputAutocapitalization(plain ? .never : .sentences)
                #endif
        }
    }

    #if os(macOS)
    private static let codeFont: Font = .system(size: 14, design: .monospaced)
    #else
    private static let codeFont: Font = .system(.subheadline, design: .monospaced)
    #endif

    private func providerOption(_ cli: String) -> String {
        let name = providerFullName(cli)
        return store.runtime?.providers[cli]?.installed == false ? "\(name) · 설치 필요" : name
    }

    private func add() async {
        guard !trimmedName.isEmpty else { failure = "팀장 이름을 넣어 주세요"; return }
        guard blockReason == nil, !busy else { return }
        failure = nil
        guard selection.isValid(in: store.modelCatalog) else {
            failure = "모델 목록이 바뀌었습니다. 사용할 모델을 다시 골라 주세요."
            return
        }
        let trimmedModel = selection.model
        submitted = true
        let result = await MemberCreationNotice.shared.create(store: store, name: trimmedName,
            role: role.trimmingCharacters(in: .whitespacesAndNewlines), provider: selection.provider,
            model: trimmedModel.isEmpty ? nil : trimmedModel)
        let notice = MemberCreationNotice.shared
        if !presented, router.navigationNotice == nil || router.navigationNotice == backgroundMessage,
           notice.namespace == ProjectCreationNotice.scope(store) || result == .hostChanged {
            router.navigationNotice = notice.message
        }
    }
}

private enum NewMemberField: Hashable { case name, role, model }

// MARK: - Member detail surfaces (file-private)

/// Section plate of the member detail. In the Mac drawer (already a panel) a flat faint white fill and rim, no dark
/// wells; on the iPhone page, which sits on the aurora, the shared card surface, so it is as clear as every other card.
private struct DetailPlate<Content: View>: View {
    @Environment(\.ceInsideGlass) private var insideGlass
    var padding: CGFloat = 14
    @ViewBuilder var content: Content

    var body: some View {
        // Web team panels: radius 18.
        let shape = RoundedRectangle(cornerRadius: CERadius.card, style: .continuous)
        let inner = content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.ceInsideGlass, true)
        if insideGlass {
            inner
                .background(Color.white.opacity(isMac ? 0.035 : 0.045), in: shape)
                .overlay { shape.strokeBorder(Color.white.opacity(0.065)) }
        } else {
            inner.cardGlass(shape)
        }
    }
}

/// Section title inside a plate, as on Home cards (14 semibold); a fold's title is the web .tm-fold__sum, 14.5.
private struct DetailSectionTitle: View {
    let title: String
    var fold = false
    init(_ title: String, fold: Bool = false) { self.title = title; self.fold = fold }
    var body: some View {
        Text(title).font(fold ? CEFont.rowTitle : CEFont.section).foregroundStyle(CE.ink).accessibilityAddTraits(.isHeader)
    }
}

/// Web .input.tm-select: a dark well with a white .12 ring, the value and a chevron at the trailing edge; the choices
/// open as a menu. `content` is an inline Picker, so the chosen value keeps its checkmark.
private struct TeamSelect<Content: View>: View {
    let value: String
    var mono = false
    let accessibility: String
    @ViewBuilder var content: Content
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        Menu {
            content
        } label: {
            HStack(spacing: 10) {
                Text(value)
                    .font(mono ? Self.monoFont : Self.font)
                    .foregroundStyle(isEnabled ? CE.ink : CE.ink3)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(isEnabled ? CE.ink2 : CE.ink3)
            }
            .padding(.horizontal, 12)
            .frame(minWidth: 170, minHeight: isMac ? 36 : 44, alignment: .leading)
            .background(CE.bgDeep.opacity(0.5), in: shape)
            .overlay { shape.strokeBorder(Color.white.opacity(isEnabled && hovering ? 0.2 : 0.12)) }
            .contentShape(shape)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .onHover { hovering = $0 }
        .accessibilityLabel(accessibility)
        .accessibilityValue(value)
    }

    #if os(macOS)
    private static var font: Font { .system(size: 13.5) }
    private static var monoFont: Font { .system(size: 13, design: .monospaced) }
    #else
    private static var font: Font { .subheadline }
    private static var monoFont: Font { .system(.subheadline, design: .monospaced) }
    #endif
}

/// Inline links: dim on press, nothing else.
private struct DetailPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}

private extension View {
    /// Text field on a flat plate: a light well instead of `ceField`'s dark one.
    func detailField() -> some View {
        self.textFieldStyle(.plain)
            .padding(.horizontal, 11).padding(.vertical, 8)
            .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: CERadius.control, style: .continuous).strokeBorder(CE.line) }
    }
}

// MARK: - Shared helpers (file-private)

/// Collapsible section in the web .tm-fold look (summary 48 tall, 14.5/600, a small chevron): chevron, label, content
/// below. Content is built only when open.
private struct TeamFoldStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { configuration.isExpanded.toggle() }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(CE.ink2)
                        .rotationEffect(.degrees(configuration.isExpanded ? 90 : 0))
                    configuration.label
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: isMac ? 46 : 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? "펼침" : "접힘")
            if configuration.isExpanded {
                configuration.content
            }
        }
    }
}

/// Web .tm-facts: a 56pt label column (13, ink-3) and the value at 14 / 1.45. `strong` labels a control instead of a
/// fact (web .field__label: 13/600 ink-2).
private struct TeamFactRow<Value: View>: View {
    let label: String
    var alignment: VerticalAlignment = .firstTextBaseline
    var strong = false
    @ViewBuilder var value: Value
    @ScaledMetric(relativeTo: .footnote) private var labelWidth: CGFloat = 56

    var body: some View {
        HStack(alignment: alignment, spacing: 10) {
            Text(label).font(strong ? TeamFont.label.weight(.semibold) : TeamFont.label).foregroundStyle(strong ? CE.ink2 : CE.ink3)
                .lineLimit(1).frame(width: labelWidth, alignment: .leading)
            value.font(TeamFont.fact).lineSpacing(CELeading.spacing(14, 1.45)).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Wraps children onto new lines when they do not fit (pills, action buttons, the office summary).
struct TeamWrapLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = measure(view, maxWidth: maxWidth)
            if x > 0 && x + spacing + size.width > maxWidth {
                y += lineHeight + lineSpacing
                x = size.width; lineHeight = size.height
            } else {
                x += (x > 0 ? spacing : 0) + size.width
                lineHeight = max(lineHeight, size.height)
            }
            widest = max(widest, x)
        }
        return CGSize(width: maxWidth.isFinite ? min(widest, maxWidth) : widest, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let maxWidth = bounds.width
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0
        var line: [(LayoutSubview, CGSize, CGFloat)] = []
        func flush() {
            for (view, size, originX) in line {
                view.place(at: CGPoint(x: bounds.minX + originX, y: bounds.minY + y + (lineHeight - size.height) / 2), proposal: ProposedViewSize(size))
            }
            line.removeAll()
        }
        for view in subviews {
            let size = measure(view, maxWidth: maxWidth)
            if x > 0 && x + spacing + size.width > maxWidth {
                flush()
                y += lineHeight + lineSpacing
                x = 0; lineHeight = 0
            }
            let originX = x > 0 ? x + spacing : 0
            line.append((view, size, originX))
            x = originX + size.width
            lineHeight = max(lineHeight, size.height)
        }
        flush()
    }

    private func measure(_ view: LayoutSubview, maxWidth: CGFloat) -> CGSize {
        let ideal = view.sizeThatFits(.unspecified)
        guard maxWidth.isFinite, ideal.width > maxWidth else { return ideal }
        return view.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
    }
}

private extension View {
    /// iPhone: a 44pt tall hit area around a small inline link without changing its layout height.
    @ViewBuilder func teamTallHitArea() -> some View {
        #if os(macOS)
        self
        #else
        self.padding(.vertical, 12).contentShape(Rectangle()).padding(.vertical, -12)
        #endif
    }
}

private let teamLegacyNote = "이전 실행기의 세션입니다. 기존 터미널에서 확인하세요. herdr-core에서는 기존 세션 편입과 도구를 붙여 다시 열기를 지원하지 않습니다."

/// Web .tm-note--left: 13.5 / 1.5, ink-2.
private func teamNote(_ text: String) -> some View {
    Text(text).font(CEFont.note).foregroundStyle(CE.ink2).lineSpacing(CELeading.spacing(13.5, 1.5))
        .fixedSize(horizontal: false, vertical: true)
}

/// Web .tm-note for an empty or loading state: centred, 14 above and below.
private func teamEmptyNote(_ text: String) -> some View {
    Text(text).font(CEFont.note).foregroundStyle(CE.ink2).lineSpacing(CELeading.spacing(13.5, 1.5))
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
}

/// A status line with its mark (sent, copied, applied, why it is locked): 13.5 / 1.5.
private func teamStatus(_ text: String, icon: String, color: Color = CE.ink2) -> some View {
    Label(text, systemImage: icon).font(CEFont.note).foregroundStyle(color).lineSpacing(CELeading.spacing(13.5, 1.5))
        .fixedSize(horizontal: false, vertical: true)
}

/// Web .tm-error / .form__error: 13.5 / 1.45, danger.
private func teamFailure(_ text: String) -> some View {
    Label(text, systemImage: "exclamationmark.circle").font(CEFont.note).foregroundStyle(CE.danger).lineSpacing(CELeading.note)
        .fixedSize(horizontal: false, vertical: true)
}

private func teamIsLegacy(_ member: Member) -> Bool {
    if let backend = member.backend, backend != "core" { return true }
    return member.origin == "adopted"
}

/// "마지막 일" only when the session is down. idle only means the CLI turn settled, never that the work is done.
private func teamNowLabel(_ member: Member) -> String {
    ["asleep", "offline"].contains(member.status) && !member.now.isEmpty ? "마지막 일" : "지금"
}

private func teamInlineMarkdown(_ value: String) -> AttributedString { markdownInline(value) }

private func teamCopy(_ text: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}

/// Observation-aware status using the shared tokens, also used by the terminal sheet. Web .status.tm-status: 24 tall,
/// padding 0 9 0 8, dot 8, 12.5/600, a fill per state (none for asleep/offline, which keep only the hollow ring).
struct TeamMemberStatusBadge: View {
    let member: Member
    var body: some View {
        let info = MemberStatusInfo(member)
        HStack(spacing: 6) {
            StatusDot(tone: info.tone, pulsing: info.live, size: 8)
            Text(info.label).font(CEFont.meta.weight(.semibold))
                .foregroundStyle(info.tone == .neutral || info.tone == .dim ? CE.ink2 : info.tone.color)
                .lineLimit(1)
        }
        .padding(.leading, 8).padding(.trailing, 9).frame(minHeight: 24)
        .background(Self.fill(info.tone), in: Capsule())
        .help(info.explanation)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("CLI 상태 \(info.label). \(info.explanation)")
    }

    private static func fill(_ tone: Tone) -> Color {
        switch tone {
        case .live, .accent: CE.violet.opacity(0.2)
        case .attention: CE.attention.opacity(0.15)
        case .approval: CE.approval.opacity(0.17)
        case .danger: CE.error.opacity(0.15)
        case .success: CE.success.opacity(0.14)
        case .neutral: Color.white.opacity(0.06)
        case .dim: Color.clear
        }
    }
}

/// Selection uses only this employee's currently open decisions.
enum UXTeamTerminal {
    static func openDecision(for memberID: String, in decisions: [Decision]) -> Decision? {
        decisions.first { $0.memberId == memberID && $0.status == "open" }
    }
}

struct NewMemberModelSelection {
    var provider = "claude" {
        didSet { if provider != oldValue { model = "" } }
    }
    var model = ""
    var cli: RankSettingsCLI { provider == "codex" ? .codex : .claude }
    func isValid(in catalog: ModelCatalog) -> Bool {
        model.isEmpty || catalog.list(for: cli).models.contains { $0.value == model }
    }
}
