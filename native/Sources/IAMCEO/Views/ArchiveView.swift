import SwiftUI

struct ArchiveLibraryView: View {
    @Environment(AppStore.self) private var store
    @Environment(Router.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var management: ProjectManagementSelection?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: CESpace.m) {
                    if store.isLoadingArchive { ProgressView("보관함을 불러오는 중") }
                    if let error = store.archiveError {
                        InlineNotice(tone: .danger, title: "보관함을 불러오지 못했습니다", detail: error,
                                     actionTitle: "다시 시도", action: { Task { await store.loadArchivedProjects() } })
                    } else if !store.isLoadingArchive && store.archivedProjects.isEmpty {
                        CompactEmpty(icon: "archivebox", title: "보관한 프로젝트가 없습니다", detail: "보관한 프로젝트의 기록을 여기서 읽을 수 있습니다.")
                    }
                    ForEach(store.archivedProjects) { project in
                        Plate {
                            VStack(alignment: .leading, spacing: CESpace.s) {
                                Button {
                                    Task {
                                        await store.selectArchivedProject(id: project.id)
                                        guard store.isArchive, store.selectedProjectID == project.id else { return }
                                        router.go(.home); router.showSettings = false; dismiss()
                                    }
                                } label: {
                                    VStack(alignment: .leading, spacing: CESpace.xs) {
                                        Text(project.name).font(CEFont.rowTitle).foregroundStyle(CE.ink)
                                        Text(project.cwd).font(CEFont.mono).foregroundStyle(CE.ink3)
                                            .lineLimit(1).truncationMode(.middle)
                                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityLabel("\(project.name) 기록 읽기")
                                HStack {
                                    Button("이름 바꾸기…") { management = ProjectManagementSelection(projectID: project.id, mode: .rename) }.ceSecondaryButton()
                                    Button("꺼내기…") { management = ProjectManagementSelection(projectID: project.id, mode: .restore) }.ceSecondaryButton()
                                }.disabled(store.isDemo || store.connectionStatus != .connected || store.isRevalidating)
                            }
                        }
                    }
                }.padding(CESpace.l)
            }
            .background { AmbientBackground() }
            .navigationTitle("보관함")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("다시 확인") { Task { await store.loadArchivedProjects() } }
                        .disabled(store.isDemo || store.isLoadingArchive || store.connectionStatus != .connected)
                }
            }
        }
        .ceSheetSize(width: 620, height: 600)
        .sheet(item: $management) { ProjectManageView(selection: $0, onOpen: { dismiss() }).id($0.id) }
        .task { await store.loadArchivedProjects() }
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
