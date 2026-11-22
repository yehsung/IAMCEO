import Foundation

// 0.2.10 창 묶음(ProjectState.window): 서버가 끝난 할 일·업무를 최근 것만, 자료를 옛 판 없이 보낸다(capabilities.windowedState).
// 여기서는 그 밖의 것을 필요할 때만 받는다: 홈·팀의 '더 보기'(끝난 할 일·완료 업무의 다음 쪽)와, 판 보기·옛 판 링크가 여는 옛 판 자료.
// 창 묶음이 아니면(옛 서버, 기능 조회 전) 모든 것이 이미 목록에 있어 아무것도 받지 않는다.

/// '더 보기'로 받은 끝난 항목. 창 묶음 밖의 것만 담고, 화면은 창 묶음의 끝난 항목과 합쳐(창 쪽이 이긴다) 최근 끝낸 순서로 보인다.
struct OlderDoneState: Equatable, Sendable {
    var projectID: String?
    var todos: [Todo] = []
    /// 더 받은 끝난 할 일의 쓰기 판 번호(서버가 쪽에 같은 행에서 읽어 함께 준 값, 또는 같은 스냅숏의 revisions).
    /// 창 밖 할 일의 체크를 풀 때 이 값이 지금 판 번호와 같아야 쓴다(reviewedTodos 와 같은 역할).
    var todoRevisions: [String: Int] = [:]
    /// 다음에 받을 위치. nil 이면 아직 받지 않았다(창 묶음의 위치에서 시작한다).
    var todosCursor: String?
    var todosExhausted = false
    var loadingTodos = false
    var work: [WorkItem] = []
    var workCursor: String?
    var workExhausted = false
    var loadingWork = false
    /// '더 보기' 실패. 할 일(홈)과 업무(팀)는 따로 둔다: 한쪽 실패가 다른 화면에 보이지 않게.
    var todosError: String?
    var workError: String?
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
    /// 더 받은 항목은 창 끝(창의 끝난 항목 가운데 가장 먼저 끝낸 것)보다 먼저 끝낸 것만 남긴다: 창 범위인데 창에 없으면 서버에서
    /// 지웠거나(work_remove) 바뀐 것이다(밀려난 것은 창 끝보다 오래되었다). 창 밖에 더 없으면(`more` false) 창이 끝난 항목 전부다.
    static func merged<Item: Identifiable>(current: [Item], older: [Item], more: Bool, finished: (Item) -> Bool, key: (Item) -> String) -> [Item] where Item.ID == String {
        let done = current.filter(finished)
        guard more, !older.isEmpty else { return done }
        func newer(_ a: Item, _ b: Item) -> Bool { key(a) != key(b) ? key(a) > key(b) : a.id > b.id }
        let end = done.min { newer($1, $0) }
        let currentIDs = Set(current.map(\.id))
        return done + older.filter { item in
            !currentIDs.contains(item.id) && finished(item) && end.map { newer($0, item) } ?? true
        }
    }
}

extension AppStore {
    /// 프로젝트를 바꾸거나 다른 서버로 붙으면 비운다.
    func resetWindowExtras() {
        if olderDone != OlderDoneState() { olderDone = OlderDoneState() }
        if !extraFiles.isEmpty { extraFiles = [:] }
    }

    /// 같은 서버로 다시 붙을 때(연결 재시도): 받아 둔 것은 그대로 둔다(열어 둔 옛 판이 '찾을 수 없는 자료'로 바뀌지 않게).
    /// 앞 연결에서 받던 중이던 요청은 연결이 바뀌어 반영되지 않으므로 받는 중 표시와 그때의 오류만 내린다.
    func settleWindowExtrasForReconnect() {
        var next = olderDone
        next.loadingTodos = false; next.loadingWork = false; next.todosError = nil; next.workError = nil
        if next != olderDone { olderDone = next }
    }

    /// 지금 묶음이 창 묶음인가.
    var stateWindow: ProjectStateWindow? { state?.window }

    // MARK: 끝난 할 일

    /// 홈 '완료한 할 일'에 보일 끝난 할 일(창 묶음 + 더 받은 것). 창 묶음이 아니면 nil(화면은 예전 규칙 그대로).
    var windowedDoneTodos: [Todo]? {
        guard let window = state?.window else { return nil }
        let older = olderDone.projectID == selectedProjectID ? olderDone.todos : []
        return DoneOrder.todos(DoneOrder.merged(current: todos, older: older, more: window.todosCursor != nil, finished: \.done, key: DoneOrder.todoKey))
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
        // 판 번호는 같은 스냅숏에서 확인한 값일 때만 함께 남긴다(창 밖으로 밀린 뒤에도 체크를 풀 수 있게).
        if olderDone.todosCursor == nil {
            let done = todos.filter(\.done)
            olderDone.todos = done
            olderDone.todoRevisions = done.reduce(into: [:]) { result, todo in
                if let revision = reviewedTodoRevision(todo) { result[todo.id] = revision }
            }
        }
        olderDone.loadingTodos = true; olderDone.todosError = nil
        do {
            let page = try await api.doneTodos(projectID: projectID, cursor: cursor)
            guard stillCurrent(api, project: projectID), olderDone.projectID == projectID else { return }
            var next = olderDone
            let index = Dictionary(next.todos.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
            for item in page.items {
                // 쪽의 값과 판 번호는 서버가 같은 행에서 읽은 짝이다. 이미 아는 항목도 이 짝으로 바꾼다(더 새 값).
                if let at = index[item.id] { next.todos[at] = item } else { next.todos.append(item) }
                if let revision = page.revisions?[item.id] { next.todoRevisions[item.id] = revision } else { next.todoRevisions[item.id] = nil }
            }
            next.todosCursor = page.nextCursor ?? cursor
            next.todosExhausted = page.nextCursor == nil
            olderDone = next
        } catch {
            guard stillCurrent(api, project: projectID), olderDone.projectID == projectID else { return }
            if (error as? APIError)?.status == 401 { handle(error) }
            olderDone.todosError = friendlyLoadError(error, what: "완료한 할 일", verb: "읽지")
        }
        if olderDone.projectID == projectID { olderDone.loadingTodos = false }
    }

    /// 더 받은 끝난 할 일을 지금 창 끝부터 새로 받는다(업무 쪽은 그대로). 창 밖 할 일의 값·판 번호가 지금과 어긋났을 때 쓴다:
    /// 그 사이 바뀐 것은 새 값과 판 번호로 다시 받는다. 받아 둔 쪽 수만큼은 아니고 첫 쪽만 받는다(더는 '이전 완료 더 보기').
    func reloadOlderDoneTodos() async {
        guard state?.window != nil, let projectID = selectedProjectID, olderDone.projectID == projectID, !olderDone.loadingTodos else { return }
        var next = olderDone
        next.todos = []; next.todoRevisions = [:]; next.todosCursor = nil; next.todosExhausted = false; next.todosError = nil
        if next != olderDone { olderDone = next }
        if canLoadOlderTodos { await loadOlderDoneTodos() }
    }

    /// 스냅숏을 반영할 때(applyWriteContext): 더 받은 할 일 가운데 지금 창에 있는 것은 그 스냅숏의 값과 판 번호로 맞춘다.
    /// 창에 있는 동안 화면은 창 쪽 값을 쓰지만, 나중에 창 밖으로 밀려도 남은 사본의 값과 판 번호가 같은 때의 짝이 되게 한다.
    func refreshOlderDoneTodos(reviewed: [String: Todo], revisions: [String: Int]?, projectID: String?) {
        guard let projectID, olderDone.projectID == projectID, !olderDone.todos.isEmpty else { return }
        var next = olderDone
        for (index, todo) in next.todos.enumerated() {
            guard let fresh = reviewed[todo.id] else { continue }
            next.todos[index] = fresh
            next.todoRevisions[todo.id] = revisions?[todo.id]
        }
        if next != olderDone { olderDone = next }
    }

    // MARK: 완료 업무

    /// 완료 칸 업무(창 묶음 + 더 받은 것, 최근 끝낸 순서). 창 묶음이 아니면 nil.
    var windowedDoneWork: [WorkItem]? {
        guard let window = state?.window else { return nil }
        let older = olderDone.projectID == selectedProjectID ? olderDone.work : []
        return DoneOrder.work(DoneOrder.merged(current: work, older: older, more: window.workCursor != nil, finished: { $0.sec == "done" }, key: DoneOrder.workKey))
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
        olderDone.loadingWork = true; olderDone.workError = nil
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
            olderDone.workError = friendlyLoadError(error, what: "완료한 업무", verb: "읽지")
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
    /// 지금 프로젝트의 판만 담는다(옛 해시 링크가 다른 프로젝트의 자료를 가리켜도 열지 않는다).
    /// 받지 못하면 화면에 보일 까닭을 돌려준다. 받았거나, 받을 필요가 없거나, 그 사이 연결·프로젝트가 바뀌었으면 nil.
    @discardableResult func loadFileChain(id: String) async -> String? {
        guard state?.window != nil, let api, let projectID = selectedProjectID else { return nil }
        do {
            let versions = try await api.fileVersions(id: id)
            guard stillCurrent(api, project: projectID) else { return nil }
            var next = extraFiles
            for version in versions where version.projectId == projectID { next[version.id] = version }
            if next != extraFiles { extraFiles = next }
            return nil
        } catch {
            guard stillCurrent(api, project: projectID) else { return nil }
            if (error as? APIError)?.status == 401 { handle(error) }
            return friendlyLoadError(error, what: "자료", verb: "열지")
        }
    }
}
