import SwiftUI
import Observation

/// App-scoped result survives dismissal of the sheet and never replays a creation request.
@MainActor @Observable
final class ProjectCreationNotice {
    enum Outcome: Sendable, Equatable {
        case created(String), partial(String, String), failed(String), hostChanged
    }
    static let shared = ProjectCreationNotice()
    private(set) var id: UUID?
    private(set) var namespace = ""
    private(set) var projectID: String?
    private(set) var message: String?
    private(set) var running = false
    private(set) var failed = false

    func begin(id: UUID, namespace: String) {
        self.id = id; self.namespace = namespace; projectID = nil
        message = "프로젝트를 만드는 중입니다. 창을 닫아도 계속됩니다."; running = true; failed = false
    }
    func finish(id: UUID? = nil, projectID: String?, message: String, failed: Bool = false) {
        guard id == nil || id == self.id else { return }
        self.projectID = projectID; self.message = message; self.failed = failed; running = false
    }
    func clear() { message = nil }

    static func scope(_ store: AppStore) -> String { store.writeNamespace + ":" + (store.serverID ?? "") }

    func create(store: AppStore, name: String, cwd: String, provider: String) async -> Outcome {
        guard !running, !store.pendingActions.contains("create-project") else { return .failed("이미 프로젝트를 만드는 중입니다.") }
        let namespace = Self.scope(store), id = UUID(), before = Set(store.projects.map(\.id))
        begin(id: id, namespace: namespace)
        let accepted = await store.createProject(name: name, cwd: cwd, goal: "", provider: provider)
        guard namespace == Self.scope(store) else {
            finish(id: id, projectID: nil, message: "연결이 바뀌었습니다. 원래 Mac에 연결해 만들기 결과를 확인해 주세요.", failed: true)
            return .hostChanged
        }
        if accepted, let project = store.selectedProjectID {
            finish(id: id, projectID: project, message: "프로젝트를 만들었습니다. 총괄에게 첫 일을 맡겨 보세요.")
            return .created(project)
        }
        let message = store.errorMessage.map(friendlyError) ?? "프로젝트를 만들지 못했습니다."
        await store.refresh()
        guard namespace == Self.scope(store) else {
            finish(id: id, projectID: nil, message: "연결이 바뀌었습니다. 원래 Mac에 연결해 만들기 결과를 확인해 주세요.", failed: true)
            return .hostChanged
        }
        // The server canonicalizes ~ and symlinks; the returned cwd need not equal the typed path.
        let matches = store.projects.filter { !before.contains($0.id) && $0.name == name }
        if matches.count == 1, let project = matches.first {
            finish(id: id, projectID: project.id, message: message, failed: true)
            return .partial(project.id, message)
        }
        finish(id: id, projectID: nil, message: message, failed: true)
        return .failed(message)
    }

    @discardableResult static func openProject(_ id: String, store: AppStore, router: Router) async -> Bool {
        let namespace = scope(store), navigation = router.navigationRevision
        if store.selectedProjectID != id { await store.selectProject(id: id) }
        guard namespace == scope(store), router.navigationRevision == navigation else { return false }
        guard store.selectedProjectID == id, store.state?.project.id == id else {
            router.navigationNotice = "프로젝트를 열지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요."
            return false
        }
        router.openChat(nil)
        router.focusComposer &+= 1
        if shared.projectID == id && shared.namespace == namespace { shared.clear() }
        return true
    }
}

/// Every entry point uses the same store mutation, including its persisted uncertain-result guard.
struct ProjectManageView: View {
    let selection: ProjectManagementSelection
    var onOpen: (() -> Void)? = nil
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var snapshot: ProjectState?
    @State private var name = ""
    @State private var cwd = ""
    @State private var loaded = false
    @State private var loading = false
    @State private var working = false
    @State private var error: String?
    @State private var succeeded = false
    @State private var namespace = ""
    @State private var showFolderPicker = false
    @State private var showManualPath = false
    @FocusState private var nameFocused: Bool
    @FocusState private var cwdFocused: Bool

    private var project: Project? {
        store.archivedProjects.first { $0.id == selection.projectID } ?? snapshot?.project
    }
    private var checking: Bool { store.projectResults[selection.projectID] == .checking }
    private var editable: Bool {
        !store.isDemo && store.connectionStatus == .connected && !store.isRevalidating
            && store.writeNamespace == namespace && !working && !loading && !checking && loaded
            && !store.pendingActions.contains("project:\(selection.projectID)")
    }
    private var blockers: [(String, String, Destination)] {
        guard let snapshot else { return [] }
        var rows: [(String, String, Destination)] = []
        let working = snapshot.members.filter { $0.status == "working" }
        let blocked = snapshot.members.filter { $0.status == "blocked" }
        let decisions = snapshot.decisions.filter { $0.status == "open" }
        let todos = snapshot.todos.filter { !$0.done }
        if !working.isEmpty { rows.append(("일하는 직원 \(working.count)명", working.map(\.name).joined(separator: ", "), .team)) }
        if !blocked.isEmpty { rows.append(("승인을 기다리는 직원 \(blocked.count)명", blocked.map(\.name).joined(separator: ", "), .team)) }
        if !decisions.isEmpty { rows.append(("열린 결재 \(decisions.count)건", decisions.map(\.title).joined(separator: ", "), .inbox)) }
        if !todos.isEmpty { rows.append(("미완료 할 일 \(todos.count)건", todos.map(\.title).joined(separator: ", "), .home)) }
        return rows
    }
    private var title: String {
        switch selection.mode {
        case .rename: "프로젝트 이름 바꾸기"
        case .settings: "프로젝트 설정"
        case .archive: "프로젝트를 보관할까요?"
        case .restore: "프로젝트 꺼내기"
        }
    }
    private var icon: String {
        switch selection.mode {
        case .rename: "pencil"
        case .settings: "slider.horizontal.3"
        case .archive: "archivebox"
        case .restore: "tray.and.arrow.up"
        }
    }
    /// Which project, under the title (the name field already shows it while renaming or editing settings).
    private var subtitle: String? {
        guard selection.mode == .archive || selection.mode == .restore else { return nil }
        let current = project?.name ?? name
        return current.isEmpty ? nil : current
    }
    private var actionTitle: String {
        switch selection.mode {
        case .rename, .settings: working ? "저장하는 중…" : "저장"
        case .archive: working ? "보관하는 중…" : "보관"
        case .restore: working ? "꺼내는 중…" : "꺼내기"
        }
    }
    private var canSubmit: Bool {
        guard editable, !succeeded else { return false }
        if selection.mode == .archive { return snapshot != nil && blockers.isEmpty && project?.isHq != true && selection.projectID != "hq" }
        if selection.mode == .restore { return project?.archived == true }
        return !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (selection.mode != .settings || !cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        // While a change is being sent the sheet stays: the round close (and Esc) does nothing, as 취소 is disabled.
        CESheet(title, subtitle: subtitle, icon: icon, width: 500, onClose: { if !working { dismiss() } }) {
            VStack(alignment: .leading, spacing: 14) {
                if loading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("확인하는 중입니다").font(CEFont.note).foregroundStyle(CE.ink2)
                    }
                }
                if store.isDemo { InlineNotice(tone: .accent, icon: "eye", title: "샘플은 읽기 전용입니다") }
                switch selection.mode {
                case .rename, .settings: form
                case .archive: archiveBody
                case .restore:
                    explanation("프로젝트 목록에 다시 표시합니다. 보관 때문에 멈춘 전달이 있으면 기존 지시가 이어질 수 있습니다.")
                }
                if let error {
                    // Archive: a failed check (or a refused archive) is retried right here; the footer stays 취소 + 보관.
                    if selection.mode == .archive && blockers.isEmpty {
                        InlineNotice(tone: .danger, title: error, actionTitle: "다시 확인", action: recheck,
                                     actionDisabled: !canRecheck)
                    } else {
                        InlineNotice(tone: .danger, title: error)
                    }
                }
                if checking {
                    InlineNotice(title: "변경 결과를 확인 중입니다", detail: "같은 요청은 다시 보내지 않습니다.", actionTitle: "결과 확인", action: {
                        Task { await store.recheckProject(id: selection.projectID) }
                    })
                }
                if succeeded {
                    InlineNotice(tone: .success, icon: "checkmark.circle", title: selection.mode == .restore ? "프로젝트를 보관함에서 꺼냈습니다" : "저장했습니다")
                }
            }
        } footer: {
            Button(succeeded ? "닫기" : "취소") { dismiss() }.ceSecondaryButton().disabled(working)
            if succeeded && selection.mode == .restore {
                Button("프로젝트 열기") { openRestored() }
                    .ceProminentButton()
                    .keyboardShortcut(.defaultAction)
            } else {
                Button(actionTitle) { Task { await submit() } }
                    .ceProminentButton()
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSubmit)
            }
        }
        .interactiveDismissDisabled(working)
        .sheet(isPresented: $showFolderPicker) {
            FolderPickerView(initialPath: cwd.isEmpty ? nil : cwd) { cwd = $0 }
        }
        .task { namespace = store.writeNamespace; await load() }
        .onChange(of: loaded) { _, ready in
            if ready && selection.mode == .rename { nameFocused = true }
        }
        .onChange(of: store.writeNamespace) { _, _ in dismiss() }
    }

    // MARK: Pieces

    /// 이름 (and 폴더 in settings), straight on the sheet: no card inside a popup. The same labelled fields as the
    /// new-project sheet (web .field / .input, accent ring on the focused one).
    private var form: some View {
        VStack(alignment: .leading, spacing: 14) {
            SetupField("이름") {
                TextField("프로젝트 이름", text: $name)
                    .labelsHidden()
                    .font(SetupFont.input)
                    .focused($nameFocused)
                    .onSubmit { Task { await submit() } }
                    .ceField(focused: nameFocused)
            }
            if selection.mode == .settings {
                SetupField("폴더", hint: "새로 뜨는 직원부터 적용됩니다.") {
                    HStack {
                        Text(cwd).font(CEFont.mono).lineLimit(2).textSelection(.enabled)
                        Spacer()
                        Button("폴더 고르기…") { showFolderPicker = true }.ceSecondaryButton()
                    }
                    DisclosureGroup("경로 직접 입력", isExpanded: $showManualPath) {
                    TextField("폴더", text: $cwd)
                        .labelsHidden()
                        .font(SetupFont.codeInput)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .focused($cwdFocused)
                        .ceField(focused: cwdFocused)
                    }
                }
            }
        }
        .disabled(!editable || succeeded)
    }

    /// What archiving does, then anything that stops it: one amber box, a row per reason, each with a quiet link to the
    /// screen where it is settled (instead of a stack of separate warning boxes).
    @ViewBuilder private var archiveBody: some View {
        explanation("목록에서 숨기고 IAMCEO가 관리하는 세션을 잠재웁니다. 기록은 남으며 보관함에서 꺼낼 수 있습니다. 직접 실행한 CLI는 종료하지 않습니다.")
        let rows = blockers
        if !rows.isEmpty {
            let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.circle").foregroundStyle(CE.attention)
                        Text("먼저 정리해야 보관할 수 있습니다").foregroundStyle(CE.ink)
                    }
                    .font(CEFont.rowTitle)
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    // Settled it on another screen? Check again here (quiet, next to the list it refreshes).
                    quietLink("다시 확인", icon: "arrow.clockwise", action: recheck)
                        .disabled(!canRecheck)
                        .help("정리한 뒤 다시 확인합니다")
                }
                .padding(.horizontal, 16).padding(.top, 13).padding(.bottom, 3)
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { Rectangle().fill(CE.attention.opacity(0.14)).frame(height: 1).padding(.leading, 16) }
                    blockerRow(row)
                }
            }
            .padding(.bottom, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CE.attention.opacity(0.07), in: shape)
            .overlay { shape.strokeBorder(CE.attention.opacity(0.22)) }
        }
    }

    private func blockerRow(_ row: (String, String, Destination)) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(row.0).font(CEFont.note.weight(.semibold)).foregroundStyle(CE.ink)
                // Mac keeps two lines (the rest on hover); iPhone has no hover, so it shows every name.
                Text(row.1).font(CEFont.meta).foregroundStyle(CE.ink2)
                    .lineSpacing(CELeading.meta)
                    .lineLimit(isMac ? 2 : nil).fixedSize(horizontal: false, vertical: true)
                    .help(row.1)
            }
            Spacer(minLength: 8)
            quietLink("\(row.2.title)에서 확인", trailingChevron: true) {
                Task { await store.selectProject(id: selection.projectID); router.showInMainWindow(row.2); dismiss() }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
    }

    /// Small accent text link (no button chrome) for actions inside the amber box. Icons are decoration only, so
    /// VoiceOver reads just the title.
    private func quietLink(_ title: String, icon: String? = nil, trailingChevron: Bool = false,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            QuietLinkLabel(title: title, icon: icon, trailingChevron: trailingChevron)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel(title)
    }

    private var canRecheck: Bool { !loading && !working && !store.isDemo }
    private func recheck() { Task { await load() } }

    /// web .st-confirm: 14.5 at 1.6, ink-1, a little inset.
    private func explanation(_ text: String) -> some View {
        Text(text).font(CEFont.body).foregroundStyle(CE.ink).ceLineHeight(14.5, 1.6)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, isMac ? 2 : 0).padding(.bottom, 4)
    }

    private func openRestored() {
        Task {
            await store.selectProject(id: selection.projectID)
            guard store.selectedProjectID == selection.projectID, !store.isArchive else { return }
            router.showInMainWindow(.home); dismiss(); onOpen?()
        }
    }

    private func load() async {
        guard !working, !loading else { return }
        loading = true; error = nil; loaded = false
        defer { loading = false }
        if selection.mode == .restore || store.archivedProjects.contains(where: { $0.id == selection.projectID }) {
            await store.loadArchivedProjects()
            guard !Task.isCancelled, namespace == store.writeNamespace else { return }
            if let project = project { name = project.name; cwd = project.cwd; loaded = true }
            else { error = store.archiveError ?? "프로젝트를 찾을 수 없습니다" }
            return
        }
        if store.isDemo {
            if store.state?.project.id == selection.projectID { snapshot = store.state; name = project?.name ?? ""; cwd = project?.cwd ?? "" }
            return
        }
        guard let api = store.api else { error = "서버에 연결해 주세요"; return }
        do {
            let result: ProjectState = try await api.request("/api/projects/\(APIClient.segment(selection.projectID))/state")
            guard !Task.isCancelled, namespace == store.writeNamespace, result.project.id == selection.projectID else { return }
            snapshot = result; name = result.project.name; cwd = result.project.cwd; loaded = true
        } catch {
            guard !Task.isCancelled, namespace == store.writeNamespace else { return }
            snapshot = nil; self.error = friendlyLoadError(error, what: "프로젝트 상태", verb: "확인하지")
            if (error as? APIError)?.status == 401 { await store.refresh() }
        }
    }

    private func submit() async {
        guard canSubmit else { return }
        let selected = store.selectedProjectID == selection.projectID
        let request: PatchProjectRequest
        switch selection.mode {
        case .rename: request = PatchProjectRequest(name: name.trimmingCharacters(in: .whitespacesAndNewlines))
        case .settings: request = PatchProjectRequest(name: name.trimmingCharacters(in: .whitespacesAndNewlines), cwd: cwd.trimmingCharacters(in: .whitespacesAndNewlines))
        case .archive: request = PatchProjectRequest(archived: true)
        case .restore: request = PatchProjectRequest(archived: false)
        }
        working = true; error = nil
        defer { working = false }
        if await store.patchProject(id: selection.projectID, request: request) {
            guard namespace == store.writeNamespace else { return }
            if selection.mode == .archive {
                if selected { router.resetForProjectChange(); router.go(.home) }
                dismiss()
            } else if selection.mode == .restore { succeeded = true }
            else { dismiss() }
        } else {
            guard namespace == store.writeNamespace else { return }
            error = store.errorMessage.map(friendlyError) ?? "변경하지 못했습니다. 다시 확인해 주세요."
            if selection.mode == .archive { loaded = false }
        }
    }
}

/// Label of the quiet accent links in the archive popup; greyed while its button is disabled.
private struct QuietLinkLabel: View {
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false
    let title: String
    let icon: String?
    let trailingChevron: Bool
    var body: some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.system(size: 9.5, weight: .bold)).accessibilityHidden(true) }
            Text(title)
            if trailingChevron {
                Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).accessibilityHidden(true)
            }
        }
        .font(CEFont.meta.weight(.semibold))
        .foregroundStyle(isEnabled ? (hovering ? CE.ink : CE.accent) : CE.ink3)
        .frame(minHeight: isMac ? 26 : 44)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

private struct ProjectManagementSheets: ViewModifier {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    let enabled: Bool
    func body(content: Content) -> some View {
        content.sheet(item: Binding(get: { enabled ? router.projectManagement : nil }, set: {
            if enabled { router.projectManagement = $0 }
        })) { ProjectManageView(selection: Self.reviewed($0)).id($0.id) }
        // Results of a project or member made after its window was closed (C-09): one stack at the top of the window,
        // as wide as a reading column, so the next step ("첫 일 맡기기") is one tap away wherever the CEO is.
        .overlay(alignment: .top) {
            if enabled {
                VStack(spacing: 8) {
                    let notice = ProjectCreationNotice.shared
                    if notice.namespace == ProjectCreationNotice.scope(store), let message = notice.message {
                        InlineNotice(tone: notice.failed ? .attention : notice.running ? .neutral : .success,
                                     title: notice.running ? "프로젝트 준비 중" : notice.failed ? "프로젝트 만들기 결과" : "프로젝트를 만들었습니다",
                                     detail: message,
                                     actionTitle: notice.projectID == nil ? "닫기" : notice.failed ? "프로젝트 확인" : "총괄에게 첫 일 맡기기") {
                            if let id = notice.projectID {
                                Task { await ProjectCreationNotice.openProject(id, store: store, router: router) }
                            } else { notice.clear() }
                        }
                    }
                    MemberCreationBanner()
                }
                .frame(maxWidth: 560)
                .padding(.horizontal, 16).padding(.top, 8)
                .animation(.easeOut(duration: 0.2), value: ProjectCreationNotice.shared.message)
            }
        }
    }

    /// Review hook for the read-only sample (DEBUG only): `--manage-mode archive|settings|restore` opens the popup that
    /// `--sheet rename` asks for in that mode instead, so every mode can be screenshotted.
    private static func reviewed(_ selection: ProjectManagementSelection) -> ProjectManagementSelection {
        #if DEBUG
        if LaunchOptions.demo, let mode = LaunchOptions.value(after: "--manage-mode").flatMap(ProjectManagementMode.init(rawValue:)) {
            return ProjectManagementSelection(projectID: selection.projectID, mode: mode)
        }
        #endif
        return selection
    }
}
extension View {
    func projectManagementSheets(enabled: Bool = true) -> some View { modifier(ProjectManagementSheets(enabled: enabled)) }
}
