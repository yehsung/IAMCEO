import Foundation
import XCTest
@testable import IAMCEO

/// 0.2.10 묶음(payload): 자료 목록 계산을 한 번만, 창 묶음(끝난 할 일·업무의 '더 보기', 빠진 옛 판), 기기에 남기는 마지막 상태의 단계별 덜기.
@MainActor final class W11PayloadTests: XCTestCase {

    // MARK: 자료 목록 계산

    /// 0.2.9 까지 FilesView 가 하던 계산을 그대로 옮긴 것(줄마다 고른 종류를 다시 구하던 구조 포함).
    private struct LegacyFileList {
        let files: [FileDoc]
        let kind: String?
        let query: String
        let searchResults: [FileSearchResult]?
        var allFiles: [FileDoc] { files.sorted { $0.order != $1.order ? $0.order > $1.order : $0.createdAt > $1.createdAt } }
        var listedFiles: [FileDoc] { FileVersions.listed(allFiles) }
        var activeKind: String? {
            guard let kind, listedFiles.contains(where: { $0.kind == kind }) else { return nil }
            return kind
        }
        var shown: [FileDoc] {
            if !query.isEmpty, let searchResults { return FileSearchPresentation(results: searchResults).files(listedFiles, kind: activeKind) }
            return listedFiles.filter { file in (activeKind == nil || file.kind == activeKind) && FileLinks.matches(file, body: nil, query: query) }
        }
        var kindCounts: [String: Int] { listedFiles.reduce(into: [:]) { $0[$1.kind, default: 0] += 1 } }
        var presentKinds: [String] {
            let order = ["document", "artifact", "image", "table", "pdf", "code", "video", "audio", "file"]
            let kinds = Set(listedFiles.map(\.kind))
            return order.filter(kinds.contains) + kinds.subtracting(order).sorted()
        }
    }

    private func files(_ count: Int, seed: Int = 7) -> [FileDoc] {
        var generator = SeededGenerator(seed: UInt64(seed))
        let kinds = ["document", "artifact", "image", "table", "pdf", "code", "newkind"]
        var result: [FileDoc] = []
        for index in 0..<count {
            var file = FileDoc(id: "f\(index)", kind: kinds[Int(generator.next() % UInt64(kinds.count))], projectId: "p",
                               title: index % 5 == 0 ? "보고서 \(index)" : "덱 \(index)", summary: index % 3 == 0 ? "요약 결제" : "",
                               createdAt: String(format: "2026-11-%02dT00:00:%02dZ", 1 + index % 28, index % 60), order: Int(generator.next() % 40))
            // 몇 개는 앞 판을 대신한다(옛 판은 목록에서 빠진다).
            if index > 0, index % 9 == 0 { file.replaces = "f\(index - 1)"; result[index - 1].replacedBy = file.id }
            result.append(file)
        }
        return result
    }

    func testFileListModelMatchesTheOldComputation() {
        let all = files(300)
        let results = [FileSearchResult(id: "f10", match: "title", excerpt: "", rank: 2), FileSearchResult(id: "f3", match: "body", excerpt: "x", rank: 1),
                       FileSearchResult(id: "f3", match: "title", excerpt: "dup", rank: 3), FileSearchResult(id: "missing", match: "title", excerpt: "", rank: 0)]
        for kind in [nil, "document", "artifact", "newkind", "gone"] as [String?] {
            for (query, search) in [("", nil), ("결제", nil), ("보고서", results), ("x", [])] as [(String, [FileSearchResult]?)] {
                let legacy = LegacyFileList(files: all, kind: kind, query: query, searchResults: search)
                let model = FileListModel(files: all, kind: kind, query: query, searchResults: search)
                XCTAssertEqual(model.all, legacy.allFiles)
                XCTAssertEqual(model.listed, legacy.listedFiles)
                XCTAssertEqual(model.activeKind, legacy.activeKind, "kind=\(kind ?? "-")")
                XCTAssertEqual(model.shown, legacy.shown, "kind=\(kind ?? "-") query=\(query)")
                XCTAssertEqual(model.kindCounts, legacy.kindCounts)
                XCTAssertEqual(model.presentKinds, legacy.presentKinds)
                XCTAssertEqual(model.listedIDs, legacy.listedFiles.map(\.id))
                XCTAssertEqual(model.allIDsKey, legacy.allFiles.map(\.id).joined(separator: ","))
                for file in all { XCTAssertEqual(model.resultsByID[file.id], search?.first { $0.id == file.id }) }
            }
        }
    }

    func testFileListIsComputedOncePerChangeAndStaysLinear() {
        let cache = FileListCache()
        let store = ObjectIdentifier(cache)
        let small = files(514), large = files(5_140)
        _ = cache.model(store: store, revision: 1, files: small, kind: "document", query: "", results: nil)
        _ = cache.model(store: store, revision: 1, files: small, kind: "document", query: "", results: nil)
        XCTAssertEqual(cache.builds, 1, "같은 입력이면 다시 계산하지 않는다")
        _ = cache.model(store: store, revision: 2, files: small, kind: "document", query: "", results: nil)
        _ = cache.model(store: store, revision: 2, files: small, kind: nil, query: "", results: nil)
        XCTAssertEqual(cache.builds, 3, "자료가 바뀌거나 종류를 바꾸면 다시 계산한다")
        // 예전 구조는 종류를 고르면 줄마다 정렬·옛 판 빼기를 되풀이했다(514개에서도 이 시험 빌드로 수백 ms). 새 계산은 5,140개도 한 번이다.
        let started = Date()
        let legacyCount = LegacyFileList(files: small, kind: "document", query: "", searchResults: nil).shown.count
        let legacyMs = Date().timeIntervalSince(started) * 1000
        let modelStarted = Date()
        let model = FileListModel(files: large, kind: "document", query: "", searchResults: nil)
        let modelMs = Date().timeIntervalSince(modelStarted) * 1000
        XCTAssertEqual(FileListModel(files: small, kind: "document", query: "", searchResults: nil).shown.count, legacyCount)
        XCTAssertFalse(model.shown.isEmpty)
        print("W11 file list: legacy shown(514) \(Int(legacyMs))ms, model(5140) \(Int(modelMs))ms")
        XCTAssertLessThan(modelMs, 2_000)
    }

    // MARK: 마지막 상태 덜기

    private func bigState(files fileCount: Int, doneTodos: Int, doneWork: Int, doneDecisions: Int) -> ProjectState {
        let pad = String(repeating: "가", count: 300)
        var files = (0..<fileCount).map { FileDoc(id: "f\($0)", kind: "document", projectId: "p", title: "자료 \($0) \(pad)", summary: pad, body: pad, order: $0) }
        files[1].replacedBy = "f2"; files[2].replaces = "f1"
        let todos = (0..<doneTodos).map { Todo(id: "t\($0)", projectId: "p", title: "끝난 할 일 \($0) \(pad)", done: true, doneAt: String(format: "2026-10-%02dT00:00:00Z", 1 + $0 % 28), createdAt: "2026-09-01T00:00:00Z", outcome: $0 % 10 == 0 ? "dropped" : "done") }
            + [Todo(id: "open", projectId: "p", title: "열린 할 일", createdAt: "2026-11-01T00:00:00Z")]
        let work = (0..<doneWork).map { WorkItem(id: "w\($0)", projectId: "p", sec: "done", title: "끝난 일 \($0) \(pad)", order: $0, doneAt: String(format: "2026-10-%02dT00:00:00Z", 1 + $0 % 28)) }
            + [WorkItem(id: "doing", projectId: "p", sec: "doing", title: "하는 일", order: 9_999)]
        let decisions = [Decision(id: "open-d", projectId: "p", status: "open")]
            + (0..<doneDecisions).map { Decision(id: "d\($0)", projectId: "p", detail: pad, status: "delivered") }
        return ProjectState(project: Project(id: "p"), members: [Member(id: "m", projectId: "p")], decisions: decisions, doneDecisionCount: doneDecisions,
                            todos: todos, work: work,
                            messages: (0..<200).map { Message(id: "m\($0)", projectId: "p", body: pad) }, files: files)
    }

    private func snapshot(_ state: ProjectState) -> LastSeenSnapshot {
        LastSeenSnapshot(namespace: "n", savedAt: Date(), serverID: nil, bootstrap: Bootstrap(projects: [ProjectSummary(id: "p")]), state: state)
    }

    func testOversizedLastStateKeepsTheRecentPartInsteadOfNothing() throws {
        let state = bigState(files: 1_200, doneTodos: 600, doneWork: 900, doneDecisions: 120)
        let full = try JSONEncoder().encode(snapshot(state))
        let limit = 1_500_000
        XCTAssertGreaterThan(full.count, limit * 2, "시험 상태가 상한을 넉넉히 넘는다")
        let data = try XCTUnwrap(OfflineStateStore.encodeWithinLimit(snapshot(state), limit: limit), "예전에는 여기서 아무것도 남기지 않았다")
        XCTAssertLessThanOrEqual(data.count, limit)
        let saved = try JSONDecoder().decode(LastSeenSnapshot.self, from: data)
        let kept = try XCTUnwrap(saved.state)
        XCTAssertEqual(saved.partial, true)
        // 지금 대표가 할 일은 그대로 남는다: 열린 할 일·결재, 진행 중인 일, 팀원.
        XCTAssertTrue(kept.todos.contains { $0.id == "open" })
        XCTAssertTrue(kept.work.contains { $0.id == "doing" })
        XCTAssertTrue(kept.decisions.contains { $0.id == "open-d" })
        XCTAssertEqual(kept.members.map(\.id), ["m"])
        // 덜어 낸 것은 오래된 것부터다. 화면이 전체 수를 보이도록 창 묶음 표를 단다(다음 쪽 위치는 없다).
        XCTAssertLessThanOrEqual(kept.todos.filter(\.done).count, OfflineStateStore.trimmedDoneCount)
        XCTAssertEqual(kept.window?.doneTodos, 540, "필요 없음(dropped)은 뺀 수")
        XCTAssertEqual(kept.window?.doneWork, 900)
        XCTAssertNil(kept.window?.todosCursor)
        XCTAssertFalse(kept.files.contains { $0.id == "f1" }, "옛 판은 먼저 뺀다")
        XCTAssertTrue(kept.files.allSatisfy { $0.body.isEmpty })
        if let oldest = kept.files.map(\.order).min() { XCTAssertGreaterThan(oldest, 0, "남긴 자료는 최근 것") }
        let keptDone = Set(kept.work.filter { $0.sec == "done" }.map(\.id))
        let newestDone = Set(DoneOrder.work(state.work.filter { $0.sec == "done" }).prefix(keptDone.count).map(\.id))
        XCTAssertEqual(keptDone, newestDone, "완료 업무는 최근 끝낸 것을 남긴다")
    }

    func testLastStateTrimmingKeepsTheOldBehaviourWhenItAlreadyFits() throws {
        let small = snapshot(bigState(files: 3, doneTodos: 2, doneWork: 2, doneDecisions: 1))
        let full = try JSONEncoder().encode(small)
        XCTAssertEqual(OfflineStateStore.encodeWithinLimit(small, limit: full.count)?.count, full.count, "상한 안이면 그대로")
        let saved = try JSONDecoder().decode(LastSeenSnapshot.self, from: try XCTUnwrap(OfflineStateStore.encodeWithinLimit(small, limit: full.count - 1)))
        XCTAssertNil(saved.partial, "글·본문만 덜어 맞으면 예전과 같다")
        XCTAssertNil(saved.state?.window)
        XCTAssertEqual(saved.state?.messages.count, OfflineStateStore.trimmedMessageCount)
        XCTAssertNil(OfflineStateStore.encodeWithinLimit(small, limit: 500), "무엇을 덜어도 넘으면 남기지 않는다")
    }

    // MARK: 요청

    func testWindowParameterOnlyWhenTheServerTakesItAndFallsBackOnAnOldServer() async throws {
        let rejectWindow = Locked(true)
        let fixture = try IsolatedTestNetwork { request in
            let query = request.url?.query ?? ""
            if request.url?.path == "/api/sync", query.contains("window=1"), rejectWindow.value {
                return IsolatedTestHTTPReply(status: 400, data: Data(#"{"error":"조회 조건이 잘못되었습니다","code":"invalid_query"}"#.utf8))
            }
            if request.url?.path.hasSuffix("/archive/state") == true, query.contains("lite=1") {
                return IsolatedTestHTTPReply(status: 400, data: Data(#"{"error":"조회 조건이 잘못되었습니다","code":"invalid_query"}"#.utf8))
            }
            if request.url?.path.hasSuffix("/archive/state") == true {
                return IsolatedTestHTTPReply(data: Data(#"{"project":{"id":"p","archived":true}}"#.utf8))
            }
            if request.url?.path == "/api/projects/p/todos/done" {
                return IsolatedTestHTTPReply(data: Data(#"{"items":[{"id":"t1","done":true}],"nextCursor":null}"#.utf8))
            }
            return IsolatedTestHTTPReply(data: Data(#"{"protocol":2,"cursor":{"epoch":"e","seq":1},"requestedProjectId":"p","projectStatus":"ok","bootstrap":{"projects":[],"settings":{}},"state":{"project":{"id":"p"}}}"#.utf8))
        }
        let api = APIClient(endpoint: fixture.endpoint, accessCode: "fixture-only", session: fixture.session, liteStateEnabled: true)
        _ = try await api.sync(projectID: "p")
        XCTAssertFalse(fixture.requests.last?.url?.query?.contains("window") ?? true, "기능 조회 전에는 싣지 않는다")
        let legacySocket = try await api.webSocketRequest()
        XCTAssertFalse(legacySocket.url?.query?.contains("window") ?? true)
        await api.setWindowedState(true)
        let socket = try await api.webSocketRequest()
        XCTAssertTrue(socket.url?.query?.contains("window=1") ?? false)
        let v1Socket = try await api.webSocketRequest(version: 1)
        XCTAssertFalse(v1Socket.url?.query?.contains("window") ?? true, "v1 소켓에는 싣지 않는다")
        // 되돌린 옛 서버: window 를 400 으로 거절하면 끄고 예전 묶음으로 다시 읽는다.
        let snapshot = try await api.sync(projectID: "p")
        XCTAssertEqual(snapshot.state?.project.id, "p")
        let tried = fixture.requests.suffix(2).map { $0.url?.query ?? "" }
        XCTAssertTrue(tried[0].contains("window=1") && tried[0].contains("lite=1"))
        XCTAssertFalse(tried[1].contains("window"))
        let windowedAfterRefusal = await api.windowedState
        XCTAssertFalse(windowedAfterRefusal)
        let afterRefusal = try await api.webSocketRequest()
        XCTAssertFalse(afterRefusal.url?.query?.contains("window") ?? true, "소켓도 다음 연결부터 뺀다")
        // 창 묶음을 받는 서버면 그대로 싣는다.
        rejectWindow.value = false
        await api.setWindowedState(true)
        _ = try await api.sync(projectID: "p")
        XCTAssertTrue(fixture.requests.last?.url?.query?.contains("window=1") ?? false)
        _ = try await api.sync(projectID: nil)
        XCTAssertNil(fixture.requests.last?.url?.query?.contains("window").nilIfFalse, "프로젝트가 없으면 싣지 않는다")
        // 보관 상태 lite 도 옛 서버면 본문째로 다시 받는다.
        let archived = try await api.archiveState(projectID: "p", lite: true)
        XCTAssertEqual(archived.state.project.id, "p")
        XCTAssertFalse(archived.lite)
        // 끝난 할 일 쪽 받기: 위치는 받은 그대로 넘긴다.
        let page = try await api.doneTodos(projectID: "p", cursor: "WyJhIiwiYiJd")
        XCTAssertEqual(page.items.map(\.id), ["t1"])
        XCTAssertNil(page.nextCursor)
        let pageQuery = fixture.requests.last?.url?.query ?? ""
        XCTAssertTrue(pageQuery.contains("cursor=WyJhIiwiYiJd") && pageQuery.contains("limit=50"))
        await fixture.close()
    }

    // MARK: 창 묶음 화면 상태

    /// 창 묶음을 주는 가짜 서버: 열린 할 일 1 + 최근 끝낸 2(창), 그 밖에 오래전에 끝낸 3. 옛 판 자료는 목록에 없다.
    private final class WindowServer: @unchecked Sendable {
        let lock = NSLock()
        var windowed = true
        var pages: [String] = []
        var versionReads = 0
        func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
            lock.lock(); defer { lock.unlock() }
            let path = request.url!.path, query = request.url?.query ?? ""
            let encoder = JSONEncoder()
            switch path {
            case "/api/capabilities":
                return IsolatedTestHTTPReply(data: try encoder.encode(ServerCapabilities(contractVersion: 2, capabilities: CapabilityFlags(realtime: true, operations: true, windowedState: windowed, archiveLite: true))))
            case "/api/bootstrap":
                return IsolatedTestHTTPReply(data: try encoder.encode(Bootstrap(projects: [ProjectSummary(id: "p")])))
            case "/api/sync":
                let windowedRequest = query.contains("window=1")
                var state = ProjectState(project: Project(id: "p"), members: [Member(id: "m", projectId: "p")],
                                         todos: [Todo(id: "open", projectId: "p", title: "열린", createdAt: "2026-11-01T00:00:00Z"),
                                                 Todo(id: "recent-a", projectId: "p", done: true, doneAt: "2026-11-20T00:00:00Z", createdAt: "2026-11-02T00:00:00Z"),
                                                 Todo(id: "recent-b", projectId: "p", done: true, doneAt: "2026-11-21T00:00:00Z", createdAt: "2026-11-03T00:00:00Z")],
                                         work: [WorkItem(id: "doing", projectId: "p", sec: "doing", order: 1),
                                                WorkItem(id: "done-new", projectId: "p", sec: "done", order: 2, doneAt: "2026-11-21T00:00:00Z")],
                                         files: [FileDoc(id: "f3", kind: "document", projectId: "p", title: "덱 v3", order: 3, replaces: "f2", versions: 3)])
                if windowedRequest {
                    state.window = ProjectStateWindow(doneTodos: 5, doneWork: 4, olderFileVersions: 2, todosCursor: "c-todos", workCursor: "c-work")
                }
                let snapshot = SyncSnapshot(protocolVersion: 2, cursor: try SyncCursor(epoch: "e", seq: 1), requestedProjectId: "p", projectStatus: .ok,
                                            bootstrap: Bootstrap(projects: [ProjectSummary(id: "p")]), state: state,
                                            revisions: SyncRevisions(settings: 1, members: ["m": MemberRevisions(configRevision: 1, sessionGeneration: 1)], todos: ["open": 1]))
                return IsolatedTestHTTPReply(data: try encoder.encode(snapshot))
            case "/api/projects/p/todos/done":
                pages.append(query)
                if query.contains("cursor=c-todos&") {
                    let page = DonePage(items: [Todo(id: "old-1", projectId: "p", done: true, doneAt: "2026-10-02T00:00:00Z"),
                                                Todo(id: "recent-b", projectId: "p", done: true, doneAt: "2026-11-21T00:00:00Z")], nextCursor: "c-todos-2")
                    return IsolatedTestHTTPReply(data: try encoder.encode(page))
                }
                return IsolatedTestHTTPReply(data: try encoder.encode(DonePage(items: [Todo(id: "old-2", projectId: "p", done: true, doneAt: "2026-10-01T00:00:00Z")], nextCursor: nil)))
            case "/api/projects/p/work/done":
                pages.append(query)
                return IsolatedTestHTTPReply(data: try encoder.encode(DonePage(items: [WorkItem(id: "done-old", projectId: "p", sec: "done", doneAt: "2026-09-01T00:00:00Z")], nextCursor: nil)))
            case "/api/files/f3/versions", "/api/files/f1/versions":
                versionReads += 1
                return IsolatedTestHTTPReply(data: try encoder.encode([FileDoc(id: "f3", projectId: "p", title: "덱 v3", order: 3, replaces: "f2"),
                                                                      FileDoc(id: "f2", projectId: "p", title: "덱 v2", order: 2, replaces: "f1", replacedBy: "f3"),
                                                                      FileDoc(id: "f1", projectId: "p", title: "덱 v1", order: 1, replacedBy: "f2")]))
            default:
                return IsolatedTestHTTPReply()
            }
        }
    }

    private func connectedStore(_ server: WindowServer) async throws -> (AppStore, IsolatedTestNetwork) {
        let network = try IsolatedTestNetwork { try server.handle($0) }
        let store = AppStore(session: network.session, persistCredentials: false, drafts: DraftStore(persist: false),
                             submissions: try SubmissionStore(persist: false), realtime: RealtimeClient(factory: network.webSockets))
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect()
        await store.selectProject(id: "p")
        try await pollUntil("창 묶음 상태") { store.stateWindow != nil }
        return (store, network)
    }

    func testDoneItemsLoadOlderPagesInFinishOrderWithoutGaps() async throws {
        let server = WindowServer()
        let (store, network) = try await connectedStore(server)
        defer { store.disconnect() }
        XCTAssertEqual(store.windowedDoneTodos?.map(\.id), ["recent-b", "recent-a"], "최근 끝낸 순서")
        XCTAssertTrue(store.canLoadOlderTodos)
        await store.loadOlderDoneTodos()
        XCTAssertEqual(store.windowedDoneTodos?.map(\.id), ["recent-b", "recent-a", "old-1"], "같은 id 는 한 번만, 더 받은 것이 아래에")
        XCTAssertTrue(store.canLoadOlderTodos)
        await store.loadOlderDoneTodos()
        XCTAssertEqual(store.windowedDoneTodos?.map(\.id), ["recent-b", "recent-a", "old-1", "old-2"])
        XCTAssertFalse(store.canLoadOlderTodos, "끝까지 받았다")
        XCTAssertEqual(server.pages.filter { $0.contains("cursor=") }.count, 2)
        XCTAssertEqual(store.doneWorkTotal, 4)
        await store.loadOlderDoneWork()
        XCTAssertEqual(store.windowedDoneWork?.map(\.id), ["done-new", "done-old"])
        XCTAssertFalse(store.canLoadOlderWork)
        // 목록에 없는 옛 판은 판 묶음을 받아 연다.
        XCTAssertNil(store.file(id: "f1"))
        XCTAssertTrue(store.needsFileChain(store.files[0]), "판 수(3)보다 아는 앞 판이 적다")
        await store.loadFileChain(id: "f3")
        XCTAssertEqual(store.file(id: "f1")?.title, "덱 v1")
        XCTAssertEqual(FileVersions.previous(of: store.files[0], in: store.versionFiles).map(\.id), ["f2", "f1"])
        XCTAssertFalse(store.needsFileChain(store.files[0]))
        // 프로젝트를 바꾸면 비운다.
        store.resetWindowExtras()
        XCTAssertTrue(store.extraFiles.isEmpty)
        XCTAssertEqual(store.windowedDoneTodos?.map(\.id), ["recent-b", "recent-a"])
        await network.close()
    }

    func testOldServerKeepsTheOldLists() async throws {
        let server = WindowServer(); server.windowed = false
        let network = try IsolatedTestNetwork { try server.handle($0) }
        let store = AppStore(session: network.session, persistCredentials: false, drafts: DraftStore(persist: false),
                             submissions: try SubmissionStore(persist: false), realtime: RealtimeClient(factory: network.webSockets))
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect()
        await store.selectProject(id: "p")
        try await pollUntil("상태") { store.state?.project.id == "p" }
        XCTAssertNil(store.stateWindow)
        XCTAssertNil(store.windowedDoneTodos, "창 묶음이 아니면 화면은 예전 규칙")
        XCTAssertFalse(store.canLoadOlderTodos)
        XCTAssertEqual(store.doneWorkTotal, 1)
        await store.loadFileChain(id: "f3")
        XCTAssertEqual(server.versionReads, 0, "모든 판이 목록에 있는 예전 묶음에서는 받지 않는다")
        XCTAssertFalse(network.requests.contains { $0.url?.query?.contains("window") == true })
        store.disconnect()
        await network.close()
    }

    // MARK: 할 일 쓰기 확인

    func testPendingTodoOutsideTheWindowIsResolvedConservatively() throws {
        let store = AppStore(persistCredentials: false, drafts: DraftStore(persist: false), submissions: try SubmissionStore(persist: false))
        store.writeNamespace = "ns"
        let now = Date().timeIntervalSince1970
        try store.saveJournal {
            $0.todos[AppStore.scoped("ns", "bumped")] = PendingTodo(id: "bumped", namespace: "ns", revision: 1, done: false, note: nil, fileIds: nil, createdAt: now)
            $0.todos[AppStore.scoped("ns", "lost")] = PendingTodo(id: "lost", namespace: "ns", revision: 4, done: false, note: nil, fileIds: nil, createdAt: now - 3_600)
            $0.todos[AppStore.scoped("ns", "waiting")] = PendingTodo(id: "waiting", namespace: "ns", revision: 2, done: false, note: nil, fileIds: nil, createdAt: now)
        }
        func sync(windowed: Bool) throws -> SyncSnapshot {
            var state = ProjectState(project: Project(id: "p"))
            if windowed { state.window = ProjectStateWindow() }
            return SyncSnapshot(protocolVersion: 2, cursor: try SyncCursor(epoch: "e", seq: 1), requestedProjectId: "p", projectStatus: .ok,
                                bootstrap: Bootstrap(projects: [ProjectSummary(id: "p")]), state: state,
                                revisions: SyncRevisions(settings: 1, members: [:], todos: ["bumped": 2, "lost": 4, "waiting": 2]))
        }
        // 예전 묶음: 목록에 없는 할 일은 판정하지 않는다(예전과 같다).
        try store.applyWriteContext(try sync(windowed: false))
        XCTAssertEqual(store.journal.todos.count, 3)
        XCTAssertNil(store.todoWrites["bumped"])
        // 창 묶음: 창 밖인데 판 번호가 올랐으면 충돌, 오래 그대로면 '들어가지 않음', 아니면 확인 중.
        try store.applyWriteContext(try sync(windowed: true))
        XCTAssertEqual(store.todoWrites["bumped"], .conflict)
        XCTAssertEqual(store.todoWrites["lost"], .notApplied)
        XCTAssertEqual(store.todoWrites["waiting"], .checking)
        XCTAssertEqual(Set(store.journal.todos.values.map(\.id)), ["waiting"])
    }
}

private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { get { lock.withLock { stored } } set { lock.withLock { stored = newValue } } }
}

private struct SeededGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

private extension Bool {
    var nilIfFalse: Bool? { self ? true : nil }
}
