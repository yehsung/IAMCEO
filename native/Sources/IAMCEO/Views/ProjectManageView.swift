import SwiftUI

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
    @FocusState private var nameFocused: Bool

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
        case .archive: "‘\(project?.name ?? name)’ 프로젝트를 보관할까요?"
        case .restore: "프로젝트 꺼내기"
        }
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
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: CESpace.m) {
                    if loading { ProgressView("확인하는 중") }
                    if store.isDemo { InlineNotice(tone: .accent, icon: "eye", title: "샘플은 읽기 전용입니다") }
                    if selection.mode == .rename || selection.mode == .settings {
                        Plate {
                            VStack(alignment: .leading, spacing: CESpace.s) {
                                Text("프로젝트 이름").font(CEFont.meta).foregroundStyle(CE.ink2)
                                TextField("프로젝트 이름", text: $name).setupInput(active: nameFocused)
                                    .focused($nameFocused)
                                    .onSubmit { Task { await submit() } }
                                if selection.mode == .settings {
                                    Text("폴더 · 새로 뜨는 직원부터 적용됩니다").font(CEFont.meta).foregroundStyle(CE.ink2)
                                    TextField("폴더", text: $cwd).setupInput().autocorrectionDisabled()
                                }
                            }
                        }.disabled(!editable || succeeded)
                    } else if selection.mode == .archive {
                        Text("목록에서 숨기고 IAMCEO가 관리하는 세션을 잠재웁니다. 기록은 남으며 보관함에서 꺼낼 수 있습니다. 직접 실행한 CLI는 종료하지 않습니다.")
                            .font(CEFont.body).foregroundStyle(CE.ink2)
                        ForEach(Array(blockers.enumerated()), id: \.offset) { _, row in
                            InlineNotice(title: row.0, detail: row.1, actionTitle: "\(row.2.title)에서 확인", action: {
                                Task { await store.selectProject(id: selection.projectID); router.go(row.2); dismiss() }
                            })
                        }
                        Button("다시 확인") { Task { await load() } }.ceSecondaryButton().disabled(loading || working || store.isDemo)
                    } else {
                        Text("프로젝트 목록에 다시 표시합니다. 보관 때문에 멈춘 전달이 있으면 기존 지시가 이어질 수 있습니다.")
                            .font(CEFont.body).foregroundStyle(CE.ink2)
                    }
                    if let error { InlineNotice(tone: .danger, title: error) }
                    if checking {
                        InlineNotice(title: "변경 결과를 확인 중입니다", detail: "같은 요청은 다시 보내지 않습니다.", actionTitle: "결과 확인", action: {
                            Task { await store.recheckProject(id: selection.projectID) }
                        })
                    }
                    if succeeded {
                        InlineNotice(tone: .success, icon: "checkmark.circle", title: selection.mode == .restore ? "프로젝트를 보관함에서 꺼냈습니다" : "저장했습니다")
                        if selection.mode == .restore {
                            Button("프로젝트 열기") {
                                Task {
                                    await store.selectProject(id: selection.projectID)
                                    guard store.selectedProjectID == selection.projectID, !store.isArchive else { return }
                                    router.go(.home); dismiss(); onOpen?()
                                }
                            }.ceSecondaryButton()
                        }
                    }
                }.padding(CESpace.l)
            }
            .background { AmbientBackground() }
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(succeeded ? "닫기" : "취소") { dismiss() }.keyboardShortcut(.cancelAction).disabled(working)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(actionTitle) { Task { await submit() } }.disabled(!canSubmit)
                }
            }
        }
        .font(CEFont.body)
        .foregroundStyle(CE.ink)
        .ceSheetSize(width: 560, height: 480)
        .interactiveDismissDisabled(working)
        .task { namespace = store.writeNamespace; await load() }
        .onChange(of: loaded) { _, ready in
            if ready && selection.mode == .rename { nameFocused = true }
        }
        .onChange(of: store.writeNamespace) { _, _ in dismiss() }
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
            snapshot = nil; self.error = "프로젝트 상태를 확인하지 못했습니다. \(error.localizedDescription)"
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
            error = store.errorMessage ?? "변경하지 못했습니다. 다시 확인해 주세요."
            if selection.mode == .archive { loaded = false }
        }
    }
}

private struct ProjectManagementSheets: ViewModifier {
    @Environment(Router.self) private var router
    let enabled: Bool
    func body(content: Content) -> some View {
        content.sheet(item: Binding(get: { enabled ? router.projectManagement : nil }, set: {
            if enabled { router.projectManagement = $0 }
        })) { ProjectManageView(selection: $0).id($0.id) }
    }
}
extension View {
    func projectManagementSheets(enabled: Bool = true) -> some View { modifier(ProjectManagementSheets(enabled: enabled)) }
}
