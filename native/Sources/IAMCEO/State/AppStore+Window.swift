import Foundation

// 0.2.10 창 묶음(ProjectState.window): 서버가 끝난 할 일·업무를 최근 것만, 자료를 옛 판 없이 보낸다(capabilities.windowedState).
// 여기서는 그 밖의 것을 필요할 때만 받는다: 홈·팀의 '더 보기'(끝난 할 일·완료 업무의 다음 쪽)와, 판 보기·옛 판 링크가 여는 옛 판 자료.
// 창 묶음이 아니면(옛 서버, 기능 조회 전) 모든 것이 이미 목록에 있어 아무것도 받지 않는다.

/// '더 보기'로 받은 끝난 항목. 창 묶음 밖의 것만 담고, 화면은 창 묶음의 끝난 항목과 합쳐(창 쪽이 이긴다) 최근 끝낸 순서로 보인다.
struct OlderDoneState: Equatable, Sendable {
    var projectID: String?
    var todos: [Todo] = []
    /// 다음에 받을 위치. nil 이면 아직 받지 않았다(창 묶음의 위치에서 시작한다).
    var todosCursor: String?
    var todosExhausted = false
    var loadingTodos = false
    var work: [WorkItem] = []
    var workCursor: String?
    var workExhausted = false
    var loadingWork = false
    var error: String?
}

/// 끝난 할 일·업무를 최근 끝낸 순서로 늘어놓는 규칙(서버의 창 묶음·쪽 받기와 같다: 끝낸 시각이 늦은 것, 같으면 id 가 큰 것이 먼저).
enum DoneOrder {
    static func todoKey(_ todo: Todo) -> String { todo.doneAt ?? todo.createdAt }
    static func workKey(_ item: WorkItem) -> String { item.doneAt ?? (item.updatedAt.isEmpty ? item.createdAt : item.updatedAt) }
    static func todos(_ items: [Todo]) -> [Todo] {
        items.sorted { todoKey($0) != todoKey($1) ? todoKey($0) > todoKey($1) : $0.id > $1.id }
    }
    static func work(_ items: [WorkItem]) -> [WorkItem] {
        items.sorted { workKey($0) != workKey($1) ? workKey($0) > workKey($1) : $0.id > $1.id }
    }
    /// 창 묶음의 끝난 항목과 '더 보기'로 받은 항목을 합친다. 같은 id 는 창 쪽(더 새 값)을 쓰고, 창 묶음에서 다시 열린 항목은 뺀다.
    static func merged<Item: Identifiable>(current: [Item], older: [Item], finished: (Item) -> Bool) -> [Item] where Item.ID == String {
        let currentIDs = Set(current.map(\.id))
        return current.filter(finished) + older.filter { !currentIDs.contains($0.id) && finished($0) }
    }
}

extension AppStore {
    /// 프로젝트를 바꾸거나 연결을 새로 하면 비운다.
    func resetWindowExtras() {
        if olderDone != OlderDoneState() { olderDone = OlderDoneState() }
        if !extraFiles.isEmpty { extraFiles = [:] }
    }

    /// 지금 묶음이 창 묶음인가.
    var stateWindow: ProjectStateWindow? { state?.window }

    // MARK: 끝난 할 일

    /// 홈 '완료한 할 일'에 보일 끝난 할 일(창 묶음 + 더 받은 것). 창 묶음이 아니면 nil(화면은 예전 규칙 그대로).
    var windowedDoneTodos: [Todo]? {
        guard state?.window != nil else { return nil }
        let older = olderDone.projectID == selectedProjectID ? olderDone.todos : []
        return DoneOrder.todos(DoneOrder.merged(current: todos, older: older, finished: \.done))
    }
    /// 창 밖에 끝난 할 일이 더 있는가.
    var canLoadOlderTodos: Bool {
        guard let window = state?.window else { return false }
        if olderDone.projectID == selectedProjectID, olderDone.todosCursor != nil || olderDone.todosExhausted { return !olderDone.todosExhausted }
        return window.todosCursor != nil
    }

    func loadOlderDoneTodos() async {
        guard let window = state?.window, let api, let projectID = selectedProjectID, !isArchive else { return }
        if olderDone.projectID != projectID { olderDone = OlderDoneState(projectID: projectID) }
        guard !olderDone.loadingTodos, !olderDone.todosExhausted, let cursor = olderDone.todosCursor ?? window.todosCursor else { return }
        // 처음 받을 때 지금 창의 끝난 할 일도 같이 남긴다: 그 사이 새로 끝난 일로 창이 밀려도 창 끝의 항목이 화면에서 빠지지 않는다.
        if olderDone.todosCursor == nil { olderDone.todos = todos.filter(\.done) }
        olderDone.loadingTodos = true; olderDone.error = nil
        do {
            let page = try await api.doneTodos(projectID: projectID, cursor: cursor)
            guard stillCurrent(api, project: projectID), olderDone.projectID == projectID else { return }
            let known = Set(olderDone.todos.map(\.id))
            olderDone.todos += page.items.filter { !known.contains($0.id) }
            olderDone.todosCursor = page.nextCursor ?? cursor
            olderDone.todosExhausted = page.nextCursor == nil
        } catch {
            guard stillCurrent(api, project: projectID), olderDone.projectID == projectID else { return }
            if (error as? APIError)?.status == 401 { handle(error) }
            olderDone.error = friendlyLoadError(error, what: "완료한 할 일", verb: "읽지")
        }
        if olderDone.projectID == projectID { olderDone.loadingTodos = false }
    }

    // MARK: 완료 업무

    /// 완료 칸 업무(창 묶음 + 더 받은 것, 최근 끝낸 순서). 창 묶음이 아니면 nil.
    var windowedDoneWork: [WorkItem]? {
        guard state?.window != nil else { return nil }
        let older = olderDone.projectID == selectedProjectID ? olderDone.work : []
        return DoneOrder.work(DoneOrder.merged(current: work, older: older) { $0.sec == "done" })
    }
    /// 완료 칸 전체 수. 창 묶음이면 서버가 센 수, 아니면 목록에서 센다.
    var doneWorkTotal: Int { state?.window?.doneWork ?? work.filter { $0.sec == "done" }.count }
    var canLoadOlderWork: Bool {
        guard let window = state?.window else { return false }
        if olderDone.projectID == selectedProjectID, olderDone.workCursor != nil || olderDone.workExhausted { return !olderDone.workExhausted }
        return window.workCursor != nil
    }

    func loadOlderDoneWork() async {
        guard let window = state?.window, let api, let projectID = selectedProjectID, !isArchive else { return }
        if olderDone.projectID != projectID { olderDone = OlderDoneState(projectID: projectID) }
        guard !olderDone.loadingWork, !olderDone.workExhausted, let cursor = olderDone.workCursor ?? window.workCursor else { return }
        if olderDone.workCursor == nil { olderDone.work = work.filter { $0.sec == "done" } }
        olderDone.loadingWork = true; olderDone.error = nil
        do {
            let page = try await api.doneWork(projectID: projectID, cursor: cursor)
            guard stillCurrent(api, project: projectID), olderDone.projectID == projectID else { return }
            let known = Set(olderDone.work.map(\.id))
            olderDone.work += page.items.filter { !known.contains($0.id) }
            olderDone.workCursor = page.nextCursor ?? cursor
            olderDone.workExhausted = page.nextCursor == nil
        } catch {
            guard stillCurrent(api, project: projectID), olderDone.projectID == projectID else { return }
            if (error as? APIError)?.status == 401 { handle(error) }
            olderDone.error = friendlyLoadError(error, what: "완료한 업무", verb: "읽지")
        }
        if olderDone.projectID == projectID { olderDone.loadingWork = false }
    }

    // MARK: 옛 판 자료

    /// id 로 자료를 찾는다: 목록, 그다음 받아 둔 옛 판.
    func file(id: String) -> FileDoc? { files.first { $0.id == id } ?? extraFiles[id] }

    /// 판 계산(FileVersions)에 쓸 자료: 목록 + 받아 둔 옛 판(같은 id 는 목록 쪽).
    var versionFiles: [FileDoc] {
        guard !extraFiles.isEmpty else { return files }
        let listed = Set(files.map(\.id))
        return files + extraFiles.values.filter { !listed.contains($0.id) }.sorted { $0.order > $1.order }
    }

    /// 창 묶음에서 이 자료의 판을 다 알려면 받아야 하는가: 목록에 없는 자료(옛 판 링크), 서버가 센 판 수보다 아는 앞 판이 적은 최신 판.
    func needsFileChain(_ file: FileDoc) -> Bool {
        guard state?.window != nil else { return false }
        if !files.contains(where: { $0.id == file.id }) { return true }
        if let versions = file.versions, versions > 1 { return FileVersions.previous(of: file, in: versionFiles).count + 1 < versions }
        return false
    }

    /// 그 자료의 모든 판(본문 없이)을 받아 둔다. 창 묶음이 아니면 모든 판이 목록에 있어 받지 않는다.
    func loadFileChain(id: String) async {
        guard state?.window != nil, let api, let projectID = selectedProjectID else { return }
        do {
            let versions = try await api.fileVersions(id: id)
            guard stillCurrent(api, project: projectID) else { return }
            var next = extraFiles
            for version in versions where version.projectId == projectID { next[version.id] = version }
            if next != extraFiles { extraFiles = next }
        } catch {
            if stillCurrent(api), (error as? APIError)?.status == 401 { handle(error) }
        }
    }
}
