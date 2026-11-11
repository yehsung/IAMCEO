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
                    EmptyTile(loading: true, title: "보관함을 불러오는 중입니다")
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
        EmptyTile(icon: "archivebox", title: "보관한 프로젝트가 없습니다",
                  detail: "프로젝트 메뉴의 ‘보관…’으로 끝난 프로젝트를 여기로 옮길 수 있습니다.")
    }

    /// One archived project: name and folder open its read-only record (hover-lit like a list row); 꺼내기 sits in sight
    /// at the right (web .st-pj: name 14.5/620, folder in code 12.5 ink-2, a visible 꺼내기), 이름 바꾸기 in the ⋯ menu.
    private func row(_ project: Project) -> some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        let canManage = !(store.isDemo || store.connectionStatus != .connected || store.isRevalidating)
        return HStack(alignment: .center, spacing: 8) {
            Button {
                Task {
                    await store.selectArchivedProject(id: project.id)
                    guard store.isArchive, store.selectedProjectID == project.id else { return }
                    router.showInMainWindow(.home); dismiss()
                }
            } label: {
                HStack(spacing: 11) {
                    Image(systemName: "archivebox").font(.system(size: 14, weight: .medium)).foregroundStyle(CE.ink2).frame(width: 20)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.name).font(CEFont.rowTitle).foregroundStyle(CE.ink).lineLimit(1)
                        Text(project.cwd).font(CEFont.mono).foregroundStyle(CE.ink2)
                            .ceLineHeight(12.5, 1.45)
                            .lineLimit(2).truncationMode(.middle)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10).padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle(radius: 10))
            .help("기록 읽기")
            .accessibilityLabel("\(project.name) 기록 읽기")
            Button("꺼내기") { management = ProjectManagementSelection(projectID: project.id, mode: .restore) }
                .ceSecondaryButton()
                .controlSize(.small)
                .fixedSize()
                .disabled(!canManage)
                .accessibilityLabel("\(project.name) 다시 꺼내기")
            Menu {
                Button("이름 바꾸기…") { management = ProjectManagementSelection(projectID: project.id, mode: .rename) }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(canManage ? CE.ink2 : CE.ink3)
                    .frame(width: 30, height: 30)
                    .frame(minWidth: isMac ? nil : 44, minHeight: isMac ? nil : 44)
                    .contentShape(Rectangle())
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .disabled(!canManage)
            .help("이름 바꾸기")
            .accessibilityLabel("\(project.name) 관리")
        }
        .padding(.leading, 4).padding(.trailing, 8).padding(.vertical, 4)
        .background(Color.white.opacity(0.04), in: shape)
        .overlay { shape.strokeBorder(Color.white.opacity(0.09)) }
    }
}

/// Centred quiet empty (or loading) state where content would be: a glyph or spinner, a title, one line and optional
/// actions on a faint tile with a dashed rim. Used by the archive popup and by the 자료·결재함·홈 screens, always centred
/// in its column so nothing sits stuck to the left of a wide area. `framed: false` drops the tile, for a note that sits
/// in the middle of a card that is already a surface (the empty 자료 reader). Loading never draws the tile: the dashed
/// rim means "nothing here", which a list that is still on its way is not.
struct EmptyTile<Actions: View>: View {
    var icon: String?
    var loading: Bool
    let title: String
    var detail: String?
    var framed: Bool
    private let actions: Actions

    init(icon: String? = nil, loading: Bool = false, title: String, detail: String? = nil, framed: Bool = true,
         @ViewBuilder actions: () -> Actions) {
        self.icon = icon; self.loading = loading; self.title = title; self.detail = detail; self.framed = framed
        self.actions = actions()
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: CERadius.control, style: .continuous)
        let tile = framed && !loading
        VStack(spacing: 8) {
            if loading {
                ProgressView().controlSize(.small).frame(height: 26)
            } else if let icon {
                Image(systemName: icon).font(.system(size: 22, weight: .regular)).foregroundStyle(CE.ink3)
                    .frame(height: 26)
                    .accessibilityHidden(true)
            }
            // web .empty: title 16/600 ink-1, body 14 ink-2 at 1.55, generous room.
            Text(title)
                .font(loading ? .system(size: 14) : .system(size: 16, weight: .semibold))
                .tracking(loading ? 0 : -0.16)
                .foregroundStyle(loading ? CE.ink2 : CE.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let detail, !detail.isEmpty {
                Text(detail).font(.system(size: 14)).foregroundStyle(CE.ink2).lineSpacing(CELeading.spacing(14, 1.55))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if Actions.self != EmptyView.self {
                HStack(spacing: 8) { actions }.padding(.top, 8)
            }
        }
        .padding(.horizontal, 24).padding(.vertical, isMac ? 40 : 32)
        .frame(maxWidth: .infinity)
        .background(tile ? Color.white.opacity(0.03) : .clear, in: shape)
        .overlay { if tile { shape.strokeBorder(CE.line, style: StrokeStyle(lineWidth: 1, dash: [4, 4])) } }
        .accessibilityElement(children: .contain)
    }
}

extension EmptyTile where Actions == EmptyView {
    init(icon: String? = nil, loading: Bool = false, title: String, detail: String? = nil, framed: Bool = true) {
        self.init(icon: icon, loading: loading, title: title, detail: detail, framed: framed, actions: { EmptyView() })
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
                                    Text("처리된 결재는 최근 기록부터 표시합니다.").font(CEFont.meta).foregroundStyle(CE.ink2)
                                        .padding(.horizontal, 4)
                                }
                            } else if destination == .team {
                                if state.members.isEmpty { empty("팀원 기록이 없습니다") }
                                ForEach(state.members) { member in
                                    record(member.name, detail: member.now, status: rankName(member.kind), result: nil)
                                        .id(member.id)
                                }
                            } else {
                                if !state.project.now.isEmpty { record("마지막 상황", detail: state.project.now, status: "기록", result: nil) }
                                Text("업무 기록").font(CEFont.title).tracking(isMac ? -0.2 : 0).foregroundStyle(CE.ink)
                                    .padding(.top, 8).padding(.horizontal, 4)
                                    .accessibilityAddTraits(.isHeader)
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
                            if store.isLoading { EmptyTile(loading: true, title: "기록을 불러오는 중입니다") }
                            else {
                                InlineNotice(title: "기록을 불러오지 못했습니다", actionTitle: "다시 확인", action: { Task { await store.refresh() } })
                            }
                        }
                    }
                    // web .shell__column: 880 wide, padding 8 24 44.
                    .ceContentColumn(top: 8)
                }
                .onChange(of: router.decisionID ?? router.memberID, initial: true) { _, id in
                    if let id { proxy.scrollTo(id, anchor: .top) }
                }
                }
            }
        }
    }

    private func empty(_ title: String) -> some View {
        EmptyTile(icon: "archivebox", title: title, detail: "보관한 프로젝트는 읽기 전용입니다.")
    }
    private func record(_ title: String, detail: String, status: String, result: String?) -> some View {
        Plate(padding: isMac ? 18 : CESpace.l) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(title).font(CEFont.rowTitle).foregroundStyle(CE.ink)
                        .lineSpacing(CELeading.spacing(14.5, 1.35))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Tag(status)
                }
                if !detail.isEmpty { MarkdownText(text: detail, size: 14.5) }
                if let result, !result.isEmpty {
                    MarkdownText(text: result, size: 14.5)
                        .padding(.top, 2)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        }
    }
}
