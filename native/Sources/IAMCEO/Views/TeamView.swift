import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// 팀: who is doing what, in which CLI state, and the next action for each member.
// CLI state is never presented as task completion; only a `완료` report says that.
// The team is drawn as an office (OfficeView): every session is a small figure that works at its own desk or rests in
// the lounge. Provider model, context meter, folder and terminal commands live in the member detail.

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
            VStack(alignment: .leading, spacing: CESpace.m) {
                if let state = store.state {
                    sections(state)
                } else if store.isLoading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("팀을 불러오는 중입니다").font(CEFont.secondary).foregroundStyle(CE.ink2)
                    }
                    .padding(.vertical, CESpace.xl)
                } else {
                    CompactEmpty(icon: "person.2", title: "팀을 불러오지 못했습니다", detail: "연결 상태를 확인한 뒤 다시 동기화하세요.")
                }
            }
            .frame(maxWidth: 880, alignment: .leading)
            .padding(.horizontal, isMac ? 24 : 16)
            .padding(.top, isMac ? 16 : 12)
            .padding(.bottom, isMac ? 24 : 28)
            .frame(maxWidth: .infinity)
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
                         detail: project.connection.detail ?? "이 프로젝트의 실행 연결을 확인하세요.")
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
            HStack {
                Spacer(minLength: 0)
                Button { router.showNewMember = true } label: { Label("팀장 추가", systemImage: "plus") }
                    .ceSecondaryButton()
                    .controlSize(.small)
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
        if !project.connection.ok, project.connection.reason != "runner_off", let detail = project.connection.detail, !detail.isEmpty { return detail }
        return hasMembers ? "총괄을 시작하면 팀이 다시 일을 이어갑니다." : "총괄이 일을 받아 Claude Code와 Codex 팀장을 꾸립니다."
    }

    private var lockReason: String? {
        if store.isDemo { return "샘플은 읽기 전용입니다." }
        if !store.canWrite { return "서버에 연결되면 시작할 수 있습니다." }
        return nil
    }

    var body: some View {
        let busy = store.pendingActions.contains("conductor-start")
        Plate(padding: 18, raised: true) {
            VStack(alignment: .leading, spacing: 8) {
                Text(project.runnerEnabled && !hasMembers ? "아직 팀이 없습니다" : "총괄을 시작하세요")
                    .font(CEFont.title).foregroundStyle(CE.ink)
                Text(message).font(CEFont.body).foregroundStyle(CE.ink2).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
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
                    .disabled(lockReason != nil || busy || runtimeBlock != nil)
                    if let lockReason { Text(lockReason).font(CEFont.meta).foregroundStyle(CE.ink3) }
                    else if busy { Text("CLI 세션을 띄우는 데 시간이 걸릴 수 있습니다.").font(CEFont.meta).foregroundStyle(CE.ink3) }
                }
                .padding(.top, 6)
                if let failure {
                    Label(failure, systemImage: "exclamationmark.circle").font(CEFont.meta).foregroundStyle(CE.danger)
                        .fixedSize(horizontal: false, vertical: true)
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
            Plate(padding: 0) {
                VStack(spacing: 0) {
                    if shown.isEmpty {
                        Text("없음").font(CEFont.secondary).foregroundStyle(CE.ink3).frame(maxWidth: .infinity).padding(.vertical, 14)
                    }
                    ForEach(Array(shown.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { RowDivider(inset: 0) }
                        row(item, filtered: active != nil)
                    }
                    if items.count > shown.count {
                        RowDivider(inset: 0)
                        Button { withAnimation(.easeOut(duration: 0.2)) { showAll = true } } label: {
                            Text("\(items.count - shown.count)건 더 보기").font(CEFont.meta.weight(.medium)).foregroundStyle(CE.accent)
                                .frame(maxWidth: .infinity, minHeight: isMac ? 34 : 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 2)
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
        return HStack(alignment: .top, spacing: 11) {
            StatusDot(tone: section?.tone ?? .neutral, size: 8).padding(.top, isMac ? 5 : 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(CEFont.body.weight(.medium)).foregroundStyle(CE.ink).lineLimit(2)
                if !sub.isEmpty { Text(sub).font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !trailing.isEmpty {
                Text(trailing).font(CEFont.meta).foregroundStyle(CE.ink3).lineLimit(1).fixedSize()
            }
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }
}

/// Web .tm-chip: dark capsule with a hairline; selected = violet fill and rim.
private struct TeamFilterChip: View {
    let title: String
    let count: Int?
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(title)
                if let count { Text("\(count)").monospacedDigit().fontWeight(.medium) }
            }
            .font(CEFont.meta.weight(.semibold))
            .foregroundStyle(selected ? CE.ink : CE.ink2)
            .padding(.horizontal, 12)
            .frame(minHeight: isMac ? 28 : 36)
            .background(selected ? CE.violet.opacity(0.42) : CE.glassTint.opacity(0.55), in: Capsule())
            .overlay { Capsule().strokeBorder(selected ? CE.violet.opacity(0.9) : Color.white.opacity(0.1)) }
            .frame(minHeight: isMac ? nil : 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count.map { "\(title) \($0)건" } ?? title)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

// MARK: - Member detail (Mac: glass drawer hosted by the shell · iPhone: pushed)
//
// One tone on both platforms: flat plates (no glass on glass, no dark wells), quiet ink3 labels, accent links like
// Home's, and two button weights — the subtle-glass capsule for 지시 / 대화 and a quieter outline for the rest.

struct MemberDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
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
                if summary.undeliveredCount > 0 || summary.unknownCount > 0 || summary.needsOwnerCount > 0 || summary.checkingCount > 0 || summary.deliveringCount > 0 {
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
                            .ceSecondaryButton().controlSize(.small).disabled(store.connectionStatus != .connected || store.isDemo)
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

    @ViewBuilder private func executionDetails(_ m: Member) -> some View {
        if let execution = m.executionState {
            TeamFactRow(label: "실행 근거") {
                VStack(alignment: .leading, spacing: 4) {
                    Text(executionLabel(execution)).foregroundStyle(CE.ink2)
                    if let date = parseISODate(execution.inputReceivedAt) {
                        Text("입력 수신 · \(koDateTime(date))").foregroundStyle(CE.ink3)
                    }
                    if let date = parseISODate(execution.startedAt) {
                        Text("턴 시작 · \(koDateTime(date))").foregroundStyle(CE.ink3)
                    }
                    if let date = parseISODate(execution.lastProgressAt) {
                        Text("마지막 진전 · \(koDateTime(date))").foregroundStyle(CE.ink3)
                    }
                    if let date = parseISODate(execution.endedAt) {
                        Text("턴 종료 · \(koDateTime(date))").foregroundStyle(CE.ink3)
                    }
                    if let code = execution.exitCode { Text("종료 코드 \(code)").foregroundStyle(CE.ink3) }
                    if let reason = execution.reason, !reason.isEmpty { Text(reason).foregroundStyle(CE.ink3) }
                }
            }
        }
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

    private func contextDetails(_ m: Member) -> some View {
        let measurement = contextMeasurement(m)
        let pct = contextPercent(m)
        let block = compactBlock(m)
        return VStack(alignment: .leading, spacing: 6) {
            if let pct {
                TeamContextBar(pct: pct, compactAt: compactAt)
                Text(contextSource(m)).foregroundStyle(CE.ink3)
            } else {
                Text("문맥 확인 중").foregroundStyle(CE.ink3)
            }
            if let window = measurement?.window ?? m.contextWindow, window > 0 {
                Text("문맥 창 \(window.formatted()) 토큰").foregroundStyle(CE.ink3)
            }
            if let model = measurement?.model { Text("측정 모델 · \(model)").foregroundStyle(CE.ink3) }
            if let generation = measurement?.sessionGeneration { Text("세션 세대 · \(generation)").foregroundStyle(CE.ink3) }
            if let date = parseISODate(measurement?.measuredAt) { Text("측정 · \(koDateTime(date))").foregroundStyle(CE.ink3) }
            if let compact = m.contextState?.compaction { Text(compactionLabel(compact)).foregroundStyle(CE.ink2) }
            if let block { Text(block).foregroundStyle(CE.ink3) }
            if m.origin != "manual" {
                Button("문맥 압축") {
                    Task { await run("compact", success: "압축 요청을 접수했습니다. 완료는 실행 근거로 확인합니다.") { await store.compactMember(m) } }
                }
                .ceSecondaryButton().controlSize(.small)
                .disabled(block != nil || running != nil || store.pendingActions.contains("member:\(m.id)"))
            }
        }
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
                    summary(m).padding(.horizontal, drawer ? 4 : 0)
                    deliveryPlate(m)
                    if m.status == "blocked" { approvalBox(m) }
                    recentTalkPlate(m)
                    overviewPlate(m)
                    if m.origin != "manual" { configPlate(m) }
                    terminalPlate(m)
                    activityPlate(m)
                }
                .frame(maxWidth: 760, alignment: .leading)
                .padding(.horizontal, drawer ? 14 : 16)
                .padding(.top, drawer ? 2 : 14)
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
                HStack { Spacer(); closeButton(onClose) }
            }
            if store.state == nil && store.isLoading {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("불러오는 중입니다").font(CEFont.secondary).foregroundStyle(CE.ink2) }
            } else {
                CompactEmpty(icon: "person.crop.circle.badge.questionmark", title: "찾을 수 없는 팀원입니다", detail: "명부에서 빠졌거나 다른 프로젝트의 팀원입니다.")
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Drawer header, inline (no title bar, no hairline): name like a Home card title, the state badge on the same
    /// line, and a quiet round close button. One line only, so it never drives the drawer's size.
    private func drawerHeader(_ m: Member, onClose: @escaping () -> Void) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Text(m.name).font(CEFont.title).foregroundStyle(CE.ink).lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            TeamMemberStatusBadge(member: m)
            if m.kind != "worker" { Tag(rankName(m.kind), tone: .accent) }
            if m.origin == "manual" { Tag("직접 띄움") }
            Spacer(minLength: 8)
            closeButton(onClose)
        }
        .padding(.leading, 18).padding(.trailing, 12)
        .padding(.top, 13).padding(.bottom, 9)
    }

    private func closeButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
        }
        .buttonStyle(DetailCloseButtonStyle())
        .focusEffectDisabled()
        .help("닫기 (esc)")
        .accessibilityLabel("닫기")
    }

    /// Web detail top row: status pill (in the drawer header on Mac), provider, role, subagents, time. Then the status
    /// meaning in one quiet line.
    private func summary(_ m: Member) -> some View {
        let info = MemberStatusInfo(m)
        let observation = MemberObservationInfo(m)
        let time = relativeTime(m.origin == "manual" ? observation.manualActivityAt : observation.lastObservedAt)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                TeamWrapLayout(spacing: 8, lineSpacing: 6) {
                    if onClose == nil {
                        if m.kind != "worker" { Tag(rankName(m.kind), tone: .accent) }
                        if m.origin == "manual" { Tag("직접 띄움") }
                        TeamMemberStatusBadge(member: m)
                    }
                    HStack(spacing: 5) {
                        Tag(providerName(m.cli))
                        if let applied = m.appliedModel, !applied.isEmpty { Text(applied).font(CEFont.meta).foregroundStyle(CE.ink3) }
                        if let requested = m.modelOverride, !requested.isEmpty, requested != m.appliedModel {
                            Text("→ \(requested)").font(CEFont.meta).foregroundStyle(CE.attention).help("요청한 모델 · 세션을 다시 열 때 적용")
                        }
                    }
                    .fixedSize()
                    if !m.role.isEmpty && m.role != m.name { Text(m.role).font(TeamFont.role).foregroundStyle(CE.ink2).lineLimit(1) }
                    Text(SubagentInfo(m).label).font(CEFont.meta).foregroundStyle(CE.ink3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !time.isEmpty { Text(time).font(CEFont.meta).foregroundStyle(CE.ink3).fixedSize() }
            }
            // blocked: the approval box right below says what to do.
            if m.status != "blocked" {
                Text(info.explanation).font(CEFont.meta).foregroundStyle(CE.ink3).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// The one state box: a flat plate with a faint approval wash; colour stays in the mark, the text stays ink.
    private func approvalBox(_ m: Member) -> some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.plate - 4, style: .continuous)
        let info = MemberStatusInfo(m)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: info.icon).font(CEFont.secondary).foregroundStyle(info.tone.color)
                Text(info.label).font(CEFont.rowTitle).foregroundStyle(CE.ink)
            }
            // On core, blocked also means the CLI state could not be read.
            Text(info.explanation)
                .font(CEFont.secondary).foregroundStyle(CE.ink2).fixedSize(horizontal: false, vertical: true)
            if m.origin != "manual" && !teamIsLegacy(m) {
                Button { openTerminal(m) } label: { Label("터미널 열기", systemImage: "terminal") }
                    .ceProminentButton()
                    .controlSize(.small)
                    .padding(.top, 2)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(info.tone.color.opacity(0.07), in: shape)
        .overlay { shape.strokeBorder(info.tone.color.opacity(0.2)) }
    }

    /// The last few lines of this member's conversation room, oldest first like the chat. A worker's room is its
    /// reports and what I sent it; the lead's room is its reports and what I sent without a target.
    private func recentTalk(_ m: Member) -> [Message] {
        let room = m.kind == "worker"
            ? store.messages.filter { $0.memberId == m.id || $0.targetMemberId == m.id }
            : store.messages.filter { $0.memberId == m.id || ($0.mine && $0.targetMemberId == nil) }
        return Array(room.suffix(4))
    }

    private func recentTalkPlate(_ m: Member) -> some View {
        let talk = recentTalk(m)
        return DetailPlate {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    DetailSectionTitle("최근 대화")
                    Spacer(minLength: 8)
                    Button { openChat(m) } label: { Label("대화방 열기", systemImage: "bubble.left.and.bubble.right") }
                        .ceSecondaryButton()
                        .controlSize(.small)
                }
                if talk.isEmpty {
                    Text("아직 주고받은 말이 없습니다").font(CEFont.secondary).foregroundStyle(CE.ink3).padding(.vertical, 4)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(talk.enumerated()), id: \.element.id) { index, message in
                            if index > 0 { RowDivider(inset: 0) }
                            TeamTalkRow(message: message, notice: store.deliveryPages[m.id]?.items.first { $0.messageId == message.id },
                                        hasDeliveryNotices: store.deliveryNotices != nil)
                        }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    /// Facts and actions together: one card for "what it does" and "what I can do".
    private func overviewPlate(_ m: Member) -> some View {
        let decisions = store.decisions.filter { $0.status == "open" && $0.memberId == m.id }.count
        return DetailPlate {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    TeamFactRow(label: LastReportInfo(m).label) {
                        if m.now.isEmpty { Text("아직 보고가 없습니다").foregroundStyle(CE.ink3) }
                        else { Text(teamInlineMarkdown(m.now)).foregroundStyle(CE.ink).fixedSize(horizontal: false, vertical: true) }
                    }
                    if let date = parseISODate(m.nowAt) {
                        TeamFactRow(label: "보고 시각") { Text(koDateTime(date)).foregroundStyle(CE.ink3) }
                    }
                    if let date = parseISODate(m.statusObservation?.observedAt) {
                        TeamFactRow(label: "마지막 관측") { Text(koDateTime(date)).foregroundStyle(CE.ink3) }
                    }
                    if let date = parseISODate(m.manualActivityAt), m.origin == "manual" {
                        TeamFactRow(label: "도구 활동") { Text(koDateTime(date)).foregroundStyle(CE.ink3) }
                    }
                    if !m.next.isEmpty {
                        TeamFactRow(label: "다음") { Text(teamInlineMarkdown(m.next)).foregroundStyle(CE.ink).fixedSize(horizontal: false, vertical: true) }
                    }
                    if m.queuedCount > 0 {
                        TeamFactRow(label: "대기열") {
                            Text("\(m.queuedCount)건 · CLI에 아직 넣지 않은 입력").foregroundStyle(CE.ink).monospacedDigit()
                        }
                    }
                    TeamFactRow(label: "문맥") { contextDetails(m) }
                    executionDetails(m)
                    if decisions > 0 {
                        TeamFactRow(label: "결재") {
                            // Home's quiet accent link ("결재함", "사무실 보기"): no underline, no state colour.
                            Button { goInbox() } label: {
                                Text("\(decisions)건 대기 · 결재함으로").fontWeight(.medium).foregroundStyle(CE.accent)
                                    .teamTallHitArea()
                            }
                            .buttonStyle(DetailPressStyle())
                            .help("결재함 열기")
                        }
                    }
                    if !m.cwd.isEmpty {
                        TeamFactRow(label: "폴더") {
                            Text(m.cwd).font(CEFont.mono).foregroundStyle(CE.ink2)
                                .textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                                .help(m.cwd)
                        }
                    }
                }
                if let error = m.lastError, !error.isEmpty {
                    Text(error).font(CEFont.secondary).foregroundStyle(CE.danger).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                if teamIsLegacy(m) {
                    teamNote(teamLegacyNote)
                }
                RowDivider(inset: 0)
                actions(m)
            }
            .padding(.horizontal, 2)
        }
    }

    @ViewBuilder private func actions(_ m: Member) -> some View {
        let canAct = store.canWrite && !store.pendingActions.contains("member:\(m.id)") && running == nil
        let manual = m.origin == "manual"
        let busyTurn = ["working", "blocked"].contains(m.status)
        let runnerOn = store.state?.project.runnerEnabled ?? false
        let wakeable = ["asleep", "offline", "error"].contains(m.status)
        let down = ["asleep", "offline"].contains(m.status)
        VStack(alignment: .leading, spacing: 8) {
            TeamWrapLayout(spacing: 8, lineSpacing: 8) {
                actionButton("지시", icon: "text.bubble", primary: true, enabled: true, help: "\(m.name)에게 지시를 보냅니다") { instruct(m) }
                actionButton("대화하기", icon: "bubble.left.and.bubble.right", primary: true, enabled: true, help: "\(m.name)와 주고받은 대화") { openChat(m) }
                if manual {
                    if m.kind == "worker" {
                        actionButton("명부에서 빼기", icon: "person.crop.circle.badge.minus", busyTitle: "빼는 중", name: "close", enabled: canAct) { confirmClose = true }
                    }
                } else {
                    if busyTurn {
                        actionButton("중단", icon: "stop.circle", busyTitle: "멈추는 중", name: "interrupt", enabled: canAct) {
                            Task { await run("interrupt", success: "멈추라고 보냈습니다. 지금 턴이 끊기면 대기로 바뀝니다.") { await store.memberAction(m, action: "interrupt") } }
                        }
                    }
                    if wakeable {
                        actionButton("깨우기", icon: "sunrise", busyTitle: "깨우는 중", name: "resume", enabled: canAct && runnerOn && !teamIsLegacy(m)) {
                            Task { await run("resume", success: "다시 열라고 보냈습니다. 세션이 열리면 상태가 바뀝니다.") { await store.memberAction(m, action: "resume") } }
                        }
                    }
                    if !down {
                        actionButton("잠재우기", icon: "moon.zzz", busyTitle: "재우는 중", name: "sleep", enabled: canAct) {
                            Task { await sleep(m) }
                        }
                    }
                    if sleepRefusal != nil && !down {
                        actionButton("그래도 재우기", icon: "moon.zzz.fill", enabled: canAct) { confirmForceSleep = true }
                    }
                    actionButton("새 세션으로 이어가기", icon: "arrow.triangle.2.circlepath", busyTitle: "새 세션을 준비하는 중", name: "fresh", enabled: canAct && !busyTurn && !freshUnresolved(m),
                                 help: busyTurn ? "일하거나 승인 창 앞이면 끝난 뒤 시작하세요" : "역할·현재 일·다음을 새 세션에 인계합니다") {
                        freshMember = m
                        freshGeneration = store.writeRevisions?.members?[m.id]?.sessionGeneration
                        confirmFresh = true
                    }
                }
            }
            freshReceipt(m)
            if let reason = readOnlyReason {
                Label(reason, systemImage: store.isDemo ? "eye" : "wifi.slash").font(CEFont.meta).foregroundStyle(CE.ink3)
            }
            if manual {
                teamNote("직접 띄운 세션입니다. 압축하거나 재울 수 없고, 보낸 말은 그 세션이 wait를 부를 때 전달됩니다.")
            } else if wakeable && !runnerOn {
                teamNote("실행이 꺼져 있어 깨울 수 없습니다. 팀 화면에서 총괄을 시작하세요.")
            }
            if let note {
                Label(note, systemImage: "paperplane").font(CEFont.meta).foregroundStyle(CE.ink2).fixedSize(horizontal: false, vertical: true)
            }
            if let failure {
                Label(failure, systemImage: "exclamationmark.circle").font(CEFont.meta).foregroundStyle(CE.danger).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func configPlate(_ m: Member) -> some View {
        DetailPlate(padding: 0) {
            DisclosureGroup(isExpanded: $configOpen) {
                configBody(m).padding(.bottom, 14)
            } label: {
                HStack(spacing: 8) {
                    DetailSectionTitle("실행 설정")
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
        let rankConfig = store.bootstrap?.settings.ranks[rank]
        return VStack(alignment: .leading, spacing: 10) {
            TeamFactRow(label: "AI CLI", alignment: .center) {
                Picker("AI CLI", selection: Binding(get: { switchAllowed ? provider : m.cli }, set: { provider = $0 })) {
                    Text(providerOption("claude")).tag("claude")
                    Text(providerOption("codex")).tag("codex")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(!switchAllowed || !store.canWrite)
            }
            if let reason = switchBlockReason(m) { teamNote(reason) }
            TeamFactRow(label: "모델", alignment: .center) {
                HStack(spacing: 6) {
                    TextField("모델", text: $model, prompt: Text(rankConfig?.model.map { "직급 기본값 (\($0))" } ?? "직급 기본값"))
                        .font(CEFont.mono)
                        .detailField()
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .disabled(!store.canWrite)
                        .accessibilityLabel("모델")
                    if target == "claude" {
                        Menu {
                            ForEach(["fable", "opus", "sonnet", "haiku"], id: \.self) { name in
                                Button(name) { model = name }
                            }
                            Button("직급 기본값") { model = "" }
                        } label: {
                            Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).frame(width: 28, height: 28)
                                .contentShape(Rectangle())
                        }
                        .menuStyle(.button)
                        .buttonStyle(.borderless)
                        .menuIndicator(.hidden)
                        .fixedSize()
                        .disabled(!store.canWrite)
                        .help("모델 고르기")
                        .accessibilityLabel("모델 고르기")
                    }
                }
            }
            TeamFactRow(label: "effort", alignment: .center) {
                Picker("effort", selection: $effort) {
                    Text(rankConfig?.effort.map { "직급 기본값 (\($0))" } ?? "직급 기본값").tag("")
                    ForEach(["low", "medium", "high", "xhigh"], id: \.self) { Text($0).tag($0) }
                    Text(target == "codex" ? "max · Codex 미지원" : "max").tag("max").disabled(target == "codex")
                    if !["", "low", "medium", "high", "xhigh", "max"].contains(effort) { Text(effort).tag(effort) }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .fixedSize()
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
                Label(block, systemImage: "exclamationmark.circle").font(CEFont.meta).foregroundStyle(CE.attention).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                if dirty && !busy {
                    Button("되돌리기") { loadConfig(m) }.buttonStyle(DetailGhostButtonStyle()).controlSize(.small)
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
                .disabled(!dirty || configChanged(m) || block != nil || !store.canWrite || running != nil || store.pendingActions.contains("member:\(m.id)"))
            }
            if let configNote {
                Label(configNote, systemImage: configHandoff ? "tray.full" : "checkmark.circle").font(CEFont.meta).foregroundStyle(CE.ink2).fixedSize(horizontal: false, vertical: true)
                if configHandoff {
                    Button { instruct(m) } label: { Label("\(m.name)에게 지시", systemImage: "text.bubble") }
                        .ceSecondaryButton().controlSize(.small)
                }
            }
            if let configFailure {
                Label(configFailure, systemImage: "exclamationmark.circle").font(CEFont.meta).foregroundStyle(CE.danger).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func terminalPlate(_ m: Member) -> some View {
        let manual = m.origin == "manual"
        let legacy = teamIsLegacy(m)
        let command = terminalCommand(m)
        return DetailPlate {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    DetailSectionTitle("터미널")
                    Spacer(minLength: 8)
                    if !manual && !legacy {
                        Button { openTerminal(m) } label: { Label("화면 · 직접 조작", systemImage: "terminal") }
                            .buttonStyle(DetailGhostButtonStyle())
                            .controlSize(.small)
                    }
                }
                if manual {
                    teamNote("직접 띄운 세션입니다. 그 세션을 띄운 터미널에서 확인하세요.")
                } else if legacy {
                    teamNote("이전 실행기의 세션은 여기서 조작할 수 없습니다. 기존 터미널에서 확인하세요.")
                } else {
                    teamNote("직접 조작하는 동안 자동 전달과 문맥 압축이 기다립니다. 끝나면 조작권을 놓아 주세요.")
                }
                if let command {
                    TeamCommandRow(label: command.attached ? "연결된 터미널 열기" : "터미널로 열기",
                                   command: command.text,
                                   note: command.attached ? "서버 컴퓨터에서 실행하면 같은 CLI 터미널을 엽니다." : nil,
                                   copiedNote: !command.attached && !["asleep", "offline"].contains(m.status)
                                       ? "지금 도는 세션입니다. 두 곳에서 함께 쓰면 꼬이니 먼저 잠재우고 여세요." : nil)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func activityPlate(_ m: Member) -> some View {
        DetailPlate(padding: 0) {
            DisclosureGroup(isExpanded: $activityOpen) {
                ActivityList(memberID: m.id).padding(.bottom, 10)
            } label: {
                HStack {
                    DetailSectionTitle("활동")
                    Spacer(minLength: 0)
                }
            }
            .disclosureGroupStyle(TeamFoldStyle())
            .padding(.horizontal, 16)
            .padding(.vertical, 2)
        }
    }

    /// `primary` (지시, 대화하기): the subtle-glass capsule used on Home and in 결재함. Everything else: a quieter
    /// outline, so the row is not a band of equally loud pills.
    @ViewBuilder private func actionButton(_ title: String, icon: String, busyTitle: String? = nil, name: String? = nil, primary: Bool = false, enabled: Bool, help: String? = nil, action: @escaping () -> Void) -> some View {
        let busy = name != nil && running == name
        let button = Button(action: action) {
            HStack(spacing: 5) {
                if busy { ProgressView().controlSize(.mini) } else { Image(systemName: icon) }
                Text(busy ? (busyTitle ?? title) : title)
            }
        }
        Group {
            if primary { button.ceSecondaryButton() } else { button.buttonStyle(DetailGhostButtonStyle()) }
        }
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

    /// Points the instruction composer at this member: the docked bar on Mac, the quick-compose sheet on iOS.
    /// Drafts are keyed per target, so nothing already typed moves to someone else.
    private func instruct(_ m: Member) {
        leaveDetail()
        router.chatTarget = m.kind == "worker" ? m.id : nil
        #if os(iOS)
        router.showCompose = true
        #else
        router.focusComposer &+= 1
        #endif
    }

    private func openChat(_ m: Member) {
        leaveDetail()
        router.openChat(m.kind == "worker" ? m.id : nil)
    }

    private func goInbox() {
        leaveDetail()
        router.go(.inbox)
    }

    /// The shell presents the terminal sheet from the window root (Mac and iOS).
    private func openTerminal(_ m: Member) { router.openTerminal(m.id) }

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

    /// Web CopyCommand: `{cli} attach {id}` for a core session with a pane, else the provider's resume command.
    private func terminalCommand(_ m: Member) -> (text: String, attached: Bool)? {
        if m.backend == "core", let pane = m.paneId, !pane.isEmpty {
            return ("\(store.bootstrap?.cli ?? "iamceo") attach \(teamShellQuote(m.id))", true)
        }
        if let session = m.sessionId, !session.isEmpty {
            let resume = m.cli == "codex" ? "codex resume" : "claude --resume"
            return ("cd \(teamShellQuote(m.cwd)) && \(resume) \(teamShellQuote(session))", false)
        }
        return nil
    }

    private func configSummary(_ m: Member) -> String {
        [providerFullName(m.cli), m.appliedModel ?? m.modelOverride, (m.appliedEffort ?? m.effortOverride).map { "effort \($0)" }]
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
        if target == "codex" && effort == "max" { return "Codex는 max effort를 쓰지 않습니다. 다른 값을 고르세요." }
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
        running = name; failure = nil; note = nil; sleepRefusal = nil
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
    @ScaledMetric(relativeTo: .caption) private var markWidth: CGFloat = 38

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            mark.frame(minWidth: markWidth, alignment: .leading)
            Text(text).font(CEFont.secondary).foregroundStyle(CE.ink).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if message.mine, let delivery = notice.map(DeliveryInfo.init) ?? DeliveryInfo(hasDeliveryNotices && ["held", "failed"].contains(message.delivery ?? "") ? nil : message.delivery) {
                Text(delivery.label).font(CEFont.meta.weight(.medium)).foregroundStyle(delivery.tone.color).lineLimit(1).fixedSize()
                    .help(delivery.explanation)
            }
            Text(relativeTime(message.at)).font(CEFont.meta).foregroundStyle(CE.ink3).monospacedDigit().lineLimit(1).fixedSize()
        }
        .padding(.vertical, 8)
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
        .task(id: memberID) {
            shownFor = memberID
            items = []; loaded = false; expanded = []; error = nil
            await load(memberID)
        }
        .onChange(of: store.connectionStatus) { _, status in
            if status == .connected { Task { await load(memberID) } }
        }
    }

    @ViewBuilder private var list: some View {
        if store.isDemo {
            teamNote("샘플에는 활동 기록이 없습니다.")
        } else if let error, items.isEmpty {
            Label(error, systemImage: "exclamationmark.circle").font(CEFont.meta).foregroundStyle(CE.danger).fixedSize(horizontal: false, vertical: true)
        } else if !loaded {
            teamNote(loading ? "불러오는 중입니다" : "서버에 연결되면 활동을 불러옵니다.")
        } else if items.isEmpty {
            teamNote("아직 활동이 없습니다")
        } else {
            if let error { Label(error, systemImage: "exclamationmark.circle").font(CEFont.meta).foregroundStyle(CE.danger) }
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
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            HStack(spacing: 8) {
                Text(clockTime(item.at)).font(CEFont.meta).monospacedDigit().foregroundStyle(CE.ink3)
                Text(activityKindName(item.kind)).font(CEFont.meta.weight(.semibold)).foregroundStyle(kindColor(item.kind))
            }
            .frame(width: metaWidth, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.text.isEmpty ? "—" : item.text)
                    .font(mono ? CEFont.mono : CEFont.secondary)
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
            self.error = "활동을 불러오지 못했습니다: \(error.localizedDescription)"
        }
    }
}

// MARK: - New member

struct NewMemberView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var role = ""
    @State private var provider = "claude"
    @State private var model = ""
    @State private var failure: String?

    init() {}

    private var busy: Bool { store.pendingActions.contains("create-member") }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var blockReason: String? {
        if store.isDemo { return "샘플은 읽기 전용입니다. 실제 Mac에 연결하면 팀장을 추가할 수 있습니다." }
        if !store.canWrite { return "서버에 연결되지 않아 추가할 수 없습니다." }
        guard let project = store.state?.project else { return "프로젝트를 불러온 뒤 추가할 수 있습니다." }
        if project.isHq { return "본사에는 팀장을 추가하지 않습니다." }
        if !project.runnerEnabled { return "이 프로젝트는 실행이 꺼져 있습니다. 팀 화면에서 총괄을 먼저 시작하세요." }
        return nil
    }

    var body: some View {
        #if os(macOS)
        VStack(spacing: 0) {
            HStack {
                Text("팀장 추가").font(CEFont.pageTitle).foregroundStyle(CE.ink)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
            .overlay(alignment: .bottom) { Rectangle().fill(CE.line).frame(height: 1) }
            ScrollView { form.padding(20) }
            HStack(spacing: 10) {
                Spacer(minLength: 0)
                Button("취소") { dismiss() }.ceSecondaryButton().keyboardShortcut(.cancelAction).disabled(busy)
                addButton.keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
            .overlay(alignment: .top) { Rectangle().fill(CE.line).frame(height: 1) }
        }
        .background { AmbientBackground() }
        .ceSheetSize(width: 520, height: 500)
        #else
        NavigationStack {
            ScrollView { form.padding(16) }
                .background { AmbientBackground() }
                .navigationTitle("팀장 추가")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("취소") { dismiss() }.disabled(busy) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button { Task { await add() } } label: {
                            if busy { HStack(spacing: 6) { ProgressView().controlSize(.small); Text("추가하는 중") } } else { Text("추가") }
                        }
                        .disabled(trimmedName.isEmpty || busy || blockReason != nil)
                    }
                }
                .interactiveDismissDisabled(busy)
        }
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
        .disabled(trimmedName.isEmpty || busy || blockReason != nil)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 14) {
            field("이름", text: $name, prompt: "개발 담당", plain: false)
            field("역할 · 선택", text: $role, prompt: "결제 화면 구현", plain: false)
            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("AI CLI")
                Picker("AI CLI", selection: $provider) {
                    Text(providerOption("claude")).tag("claude")
                    Text(providerOption("codex")).tag("codex")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            field("모델 · 선택", text: $model, prompt: "CLI 기본값", plain: true)
            teamNote("새 CLI 세션을 띄워 이 프로젝트의 팀장으로 등록합니다. 세션 준비에 시간이 걸릴 수 있습니다.")
            if store.runtime?.providers[provider]?.installed == false {
                InlineNotice(tone: .attention, icon: "exclamationmark.triangle", title: "\(providerFullName(provider))가 설치돼 있지 않습니다",
                             detail: "설정의 실행 환경을 확인하세요.")
            }
            if let failure {
                Label(failure, systemImage: "exclamationmark.circle").font(CEFont.secondary).foregroundStyle(CE.danger)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let blockReason {
                Label(blockReason, systemImage: store.isDemo ? "eye" : "info.circle").font(CEFont.secondary).foregroundStyle(CE.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text).font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.ink2)
    }

    private func field(_ label: String, text: Binding<String>, prompt: String, plain: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            fieldLabel(label)
            TextField(label, text: text, prompt: Text(prompt))
                .font(plain ? CEFont.mono : CEFont.body)
                .ceField()
                .autocorrectionDisabled(plain)
                #if os(iOS)
                .textInputAutocapitalization(plain ? .never : .sentences)
                #endif
        }
    }

    private func providerOption(_ cli: String) -> String {
        let name = providerFullName(cli)
        return store.runtime?.providers[cli]?.installed == false ? "\(name) · 설치 필요" : name
    }

    private func add() async {
        guard !trimmedName.isEmpty else { failure = "팀장 이름을 넣어 주세요"; return }
        guard blockReason == nil, !busy else { return }
        failure = nil
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let ok = await store.createMember(name: trimmedName, role: role.trimmingCharacters(in: .whitespacesAndNewlines), provider: provider, model: trimmedModel.isEmpty ? nil : trimmedModel)
        guard ok else {
            failure = store.errorMessage ?? "팀장을 추가하지 못했습니다."
            return
        }
        dismiss()
    }
}

// MARK: - Member detail surfaces (file-private)

/// Section plate of the member detail. In the Mac drawer (already a panel) a flat faint white fill and rim, no dark
/// wells; on the iPhone page, which sits on the aurora, the shared card surface, so it is as clear as every other card.
private struct DetailPlate<Content: View>: View {
    @Environment(\.ceInsideGlass) private var insideGlass
    var padding: CGFloat = 14
    @ViewBuilder var content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.plate - 4, style: .continuous)
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

/// Section title inside a plate, as on Home cards.
private struct DetailSectionTitle: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title).font(CEFont.section).foregroundStyle(CE.ink).accessibilityAddTraits(.isHeader)
    }
}

/// Quieter companion of the subtle-glass capsule (`ceSecondaryButton`): same size, no fill, a hairline outline and an
/// ink2 label; a faint fill on hover.
private struct DetailGhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { GhostBody(configuration: configuration) }

    private struct GhostBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.controlSize) private var controlSize
        @State private var hovering = false

        var body: some View {
            configuration.label
                .font(font)
                .lineLimit(1)
                .padding(.horizontal, horizontal).padding(.vertical, vertical)
                .foregroundStyle(isEnabled ? CE.ink2 : CE.ink3)
                .background(Color.white.opacity(fill), in: Capsule())
                .overlay { Capsule().strokeBorder(Color.white.opacity(isEnabled ? 0.11 : 0.06)) }
                .opacity(isEnabled ? 1 : 0.8)
                .ghostHitArea()
                .onHover { hovering = $0 }
        }

        private var fill: Double {
            guard isEnabled else { return 0 }
            return configuration.isPressed ? 0.09 : hovering ? 0.05 : 0
        }

        #if os(macOS)
        private var small: Bool { controlSize == .small || controlSize == .mini }
        private var font: Font { .system(size: small ? 12 : 13, weight: .medium) }
        private var horizontal: CGFloat { small ? 10 : 13 }
        private var vertical: CGFloat { small ? 4 : 6 }
        #else
        private var font: Font { CEFont.rowTitle }
        private var horizontal: CGFloat { 14 }
        private var vertical: CGFloat { 8 }
        #endif
    }
}

/// The drawer's round close button: 26pt, quiet white fill, ink2 mark, no focus ring.
private struct DetailCloseButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { CloseBody(configuration: configuration) }

    private struct CloseBody: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .foregroundStyle(hovering ? CE.ink : CE.ink2)
                .frame(width: 26, height: 26)
                .background(Color.white.opacity(configuration.isPressed ? 0.14 : hovering ? 0.1 : 0.06), in: Circle())
                .overlay { Circle().strokeBorder(Color.white.opacity(0.07)) }
                .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? nil : 44)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

/// Inline links: dim on press, nothing else.
private struct DetailPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}

private extension View {
    /// iPhone: a 44pt hit target around the visible capsule. Mac: the capsule itself.
    @ViewBuilder func ghostHitArea() -> some View {
        #if os(macOS)
        self.contentShape(Capsule())
        #else
        self.frame(minHeight: 44).contentShape(Rectangle())
        #endif
    }

    /// Text field on a flat plate: a light well instead of `ceField`'s dark one.
    func detailField() -> some View {
        self.textFieldStyle(.plain)
            .padding(.horizontal, 11).padding(.vertical, 8)
            .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: CERadius.control, style: .continuous).strokeBorder(CE.line) }
    }
}

// MARK: - Shared helpers (file-private)

/// Collapsible section in the web .tm-fold look: chevron, label, content below. Content is built only when open.
private struct TeamFoldStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { configuration.isExpanded.toggle() }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(CE.ink2)
                        .rotationEffect(.degrees(configuration.isExpanded ? 90 : 0))
                    configuration.label
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: isMac ? 40 : 48)
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

/// Copyable terminal command (web CopyBox): mono command in a dark well and a glass 복사 button.
private struct TeamCommandRow: View {
    let label: String
    let command: String
    var note: String? = nil
    /// Shown after copying (e.g. the session is running right now).
    var copiedNote: String? = nil
    @State private var copied = false
    @State private var everCopied = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(CEFont.meta.weight(.semibold)).foregroundStyle(CE.ink2)
            HStack(spacing: 8) {
                Text(command).font(CEFont.mono).foregroundStyle(CE.ink).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                    .padding(.horizontal, 11).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.white.opacity(0.04), in: shape)
                    .overlay { shape.strokeBorder(CE.line) }
                    .help(command)
                Button(copied ? "복사함" : "복사") {
                    teamCopy(command)
                    copied = true; everCopied = true
                    Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                }
                .buttonStyle(DetailGhostButtonStyle())
                .controlSize(.small)
                .accessibilityLabel(copied ? "명령을 복사했습니다" : "\(label) 명령 복사")
            }
            if let note { teamNote(note) }
            if everCopied, let copiedNote { teamNote(copiedNote) }
        }
    }
}

private struct TeamFactRow<Value: View>: View {
    let label: String
    var alignment: VerticalAlignment = .firstTextBaseline
    @ViewBuilder var value: Value
    @ScaledMetric(relativeTo: .footnote) private var labelWidth: CGFloat = 56

    var body: some View {
        HStack(alignment: alignment, spacing: 10) {
            Text(label).font(TeamFont.label).foregroundStyle(CE.ink3).lineLimit(1).frame(width: labelWidth, alignment: .leading)
            value.font(TeamFont.fact).frame(maxWidth: .infinity, alignment: .leading)
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

private func teamNote(_ text: String) -> some View {
    Text(text).font(CEFont.meta).foregroundStyle(CE.ink3).fixedSize(horizontal: false, vertical: true)
}

private func teamIsLegacy(_ member: Member) -> Bool {
    if let backend = member.backend, backend != "core" { return true }
    return member.origin == "adopted"
}

/// "마지막 일" only when the session is down. idle only means the CLI turn settled, never that the work is done.
private func teamNowLabel(_ member: Member) -> String {
    ["asleep", "offline"].contains(member.status) && !member.now.isEmpty ? "마지막 일" : "지금"
}

private func teamInlineMarkdown(_ value: String) -> AttributedString {
    (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value)
}

/// Same quoting as the web `shellQuote`: bare when safe, else single-quoted.
private func teamShellQuote(_ value: String) -> String {
    let safe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./:=@")
    if !value.isEmpty, value.unicodeScalars.allSatisfy({ safe.contains($0) }) { return value }
    return "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

private func teamCopy(_ text: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}

/// Observation-aware status using the shared tokens, also used by the terminal sheet.
struct TeamMemberStatusBadge: View {
    let member: Member
    var body: some View {
        let info = MemberStatusInfo(member)
        HStack(spacing: 5) {
            StatusDot(tone: info.tone, pulsing: info.live, size: 6)
            Text(info.label).font(CEFont.meta.weight(.medium))
                .foregroundStyle(info.tone == .neutral || info.tone == .dim ? CE.ink2 : info.tone.color)
        }
        .padding(.horizontal, 8).frame(height: 22)
        .background((info.tone == .neutral || info.tone == .dim ? Color.white : info.tone.color).opacity(0.1), in: Capsule())
        .help(info.explanation)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("CLI 상태 \(info.label). \(info.explanation)")
    }
}
