import SwiftUI

struct ArchiveLibraryView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var management: ProjectManagementSelection?

    var body: some View {
        CESheet("보관함", subtitle: "보관한 프로젝트는 읽기 전용으로 열립니다. 꺼내면 다시 일할 수 있습니다.", icon: "archivebox", width: 560) {
            VStack(alignment: .leading, spacing: CESpace.s) {
                if store.isLoadingArchive && store.archivedProjects.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("보관함을 불러오는 중입니다").font(CEFont.secondary).foregroundStyle(CE.ink2)
                    }
                    .padding(.vertical, CESpace.s)
                }
                if let error = store.archiveError {
                    InlineNotice(tone: .danger, title: "보관함을 불러오지 못했습니다", detail: error,
                                 actionTitle: "다시 시도", action: { Task { await store.loadArchivedProjects() } })
                } else if !store.isLoadingArchive && store.archivedProjects.isEmpty {
                    emptyState
                }
                ForEach(store.archivedProjects) { project in row(project) }
            }
        }
        .sheet(item: $management) { ProjectManageView(selection: $0, onOpen: { dismiss() }).id($0.id) }
        .task { await store.loadArchivedProjects() }
    }

    /// Centred quiet empty state: the sheet stays small instead of a tall empty window.
    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "archivebox").font(.system(size: 22, weight: .regular)).foregroundStyle(CE.ink3)
            Text("보관한 프로젝트가 없습니다").font(CEFont.rowTitle).foregroundStyle(CE.ink2)
            Text("프로젝트 메뉴의 ‘보관…’으로 끝난 프로젝트를 여기로 옮길 수 있습니다.")
                .font(CEFont.meta).foregroundStyle(CE.ink3).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .background(Color.white.opacity(0.03), in: RoundedRectangle(cornerRadius: CERadius.control, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: CERadius.control, style: .continuous).strokeBorder(CE.line, style: StrokeStyle(lineWidth: 1, dash: [4, 4])) }
    }

    /// One archived project: name and folder open its read-only record; rename/restore sit at the right.
    private func row(_ project: Project) -> some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        return HStack(alignment: .center, spacing: 12) {
            Button {
                Task {
                    await store.selectArchivedProject(id: project.id)
                    guard store.isArchive, store.selectedProjectID == project.id else { return }
                    router.go(.home); router.showSettings = false; dismiss()
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "archivebox").font(CEFont.secondary).foregroundStyle(CE.ink3).frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.name).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                        Text(project.cwd).font(CEFont.mono).foregroundStyle(CE.ink3).lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("기록 읽기")
            .accessibilityLabel("\(project.name) 기록 읽기")
            Menu {
                Button("이름 바꾸기…") { management = ProjectManagementSelection(projectID: project.id, mode: .rename) }
                Button("꺼내기…") { management = ProjectManagementSelection(projectID: project.id, mode: .restore) }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(CE.ink2)
                    .frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .disabled(store.isDemo || store.connectionStatus != .connected || store.isRevalidating)
            .accessibilityLabel("\(project.name) 관리")
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Color.white.opacity(0.04), in: shape)
        .overlay { shape.strokeBorder(CE.line) }
    }
}

/// Archive records deliberately have no decision answers, todo checks, or session controls.
struct ArchiveView: View {
    let destination: Destination
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router

    var body: some View {
        Group {
            if destination == .chat { ChatView() }
            else if destination == .files { FilesView() }
            else {
                ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: CESpace.m) {
                        if let state = store.state {
                            if destination == .inbox {
                                if state.decisions.isEmpty { empty("결재 기록이 없습니다") }
                                ForEach(state.decisions) { decision in
                                    record(decision.title, detail: decision.detail,
                                           status: decision.status == "open" ? "미처리" : "처리됨",
                                           result: [decision.choice, decision.note, decision.closeReason].compactMap { $0 }.joined(separator: "\n"))
                                        .id(decision.id)
                                }
                                if state.doneDecisionCount > state.decisions.filter({ $0.status != "open" }).count {
                                    Text("처리된 결재는 최근 기록부터 표시합니다.").font(CEFont.meta).foregroundStyle(CE.ink3)
                                }
                            } else if destination == .team {
                                if state.members.isEmpty { empty("직원 기록이 없습니다") }
                                ForEach(state.members) { member in
                                    record(member.name, detail: member.now, status: rankName(member.kind), result: nil)
                                        .id(member.id)
                                }
                            } else {
                                if !state.project.now.isEmpty { record("마지막 상황", detail: state.project.now, status: "기록", result: nil) }
                                Text("업무 기록").font(CEFont.title).foregroundStyle(CE.ink)
                                if state.todos.isEmpty && state.work.isEmpty { empty("업무 기록이 없습니다") }
                                ForEach(state.todos) { todo in
                                    record(todo.title, detail: todo.detail, status: todo.done ? "완료" : "미완료", result: todo.closeReason)
                                }
                                ForEach(state.work) { work in
                                    record(work.title, detail: work.detail,
                                           status: ["todo": "할 일", "doing": "진행", "done": "완료"][work.sec] ?? "업무", result: nil)
                                }
                            }
                        } else {
                            if store.isLoading { ProgressView("기록을 불러오는 중") }
                            else {
                                InlineNotice(title: "기록을 불러오지 못했습니다", actionTitle: "다시 확인", action: { Task { await store.refresh() } })
                            }
                        }
                    }.frame(maxWidth: 880).padding(CESpace.l).frame(maxWidth: .infinity)
                }
                .onChange(of: router.decisionID ?? router.memberID, initial: true) { _, id in
                    if let id { proxy.scrollTo(id, anchor: .top) }
                }
                }
            }
        }
    }

    private func empty(_ title: String) -> some View {
        CompactEmpty(icon: "archivebox", title: title, detail: "보관한 프로젝트는 읽기 전용입니다.")
    }
    private func record(_ title: String, detail: String, status: String, result: String?) -> some View {
        Plate {
            VStack(alignment: .leading, spacing: CESpace.s) {
                HStack { Text(title).font(CEFont.rowTitle).foregroundStyle(CE.ink); Spacer(); Tag(status) }
                if !detail.isEmpty { MarkdownText(text: detail) }
                if let result, !result.isEmpty { MarkdownText(text: result) }
            }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        }
    }
}
