import Foundation
import XCTest
@testable import IAMCEO

/// All requests use the per-session URLProtocol fixture with a two-second network deadline.
private final class TodoHygieneHTTP: @unchecked Sendable {
    let server = WriteTestServer()
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        guard request.url?.path == "/api/todos/t/drop" else { return try server.handle(request) }
        return try server.read { server in
            Result {
                server.todoSends += 1
                if server.rejectAll { return IsolatedTestHTTPReply(status: 401) }
                let body = try WriteTestServer.body(request)
                let v2 = request.value(forHTTPHeaderField: "X-IAMCEO-Contract") == "2"
                if v2 && request.value(forHTTPHeaderField: "If-Match") != "\"\(server.revisions.todos!["t"]!)\"" {
                    return IsolatedTestHTTPReply(status: 409)
                }
                server.state.todos[0].done = true
                server.state.todos[0].outcome = "dropped"
                server.state.todos[0].closedBy = "대표"
                server.state.todos[0].closeReason = body["reason"] as? String ?? "대표가 필요 없음으로 정리"
                server.revisions.todos!["t"]! += 1
                if server.dropTodo { server.syncFailure = true; throw URLError(.timedOut) }
                if v2 { return try server.reply(TodoWriteResult(todo: server.state.todos[0], revision: server.revisions.todos!["t"]!)) }
                return try server.reply(server.state.todos[0])
            }
        }.get()
    }
}

@MainActor final class TodoHygieneTests: XCTestCase {
    private func bounded<T: Sendable>(_ body: @escaping @MainActor () async throws -> T) async throws -> T {
        try await withThrowingTestDeadline { deadline in
            Task { @MainActor in
                do { deadline.resume(returning: try await body()) }
                catch { deadline.resume(throwing: error) }
            }
        }
    }
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        return store
    }

    func testDropSendsReasonAndReviewedRevisionAndAppliesDroppedResult() async throws {
        try await bounded {
            let fixture = TodoHygieneHTTP(), network = try IsolatedTestNetwork(handler: fixture.handle)
            let store = await self.connect(network)
            defer { store.disconnect() }
            let todo = try XCTUnwrap(store.todos.first)
            let dropped = await store.dropTodo(todo, reason: "이미 로그인할 필요 없음")
            XCTAssertTrue(dropped)
            XCTAssertEqual(store.todos[0].outcome, "dropped")
            XCTAssertEqual(store.todos[0].closedBy, "대표")
            XCTAssertEqual(store.todos[0].closeReason, "이미 로그인할 필요 없음")
            XCTAssertEqual(store.todoWrites["t"], .confirmed)
            let request = try XCTUnwrap(network.requests.last { $0.url?.path == "/api/todos/t/drop" })
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "\"1\"")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-IAMCEO-Contract"), "2")
            XCTAssertEqual(try WriteTestServer.body(request)["reason"] as? String, "이미 로그인할 필요 없음")
        }
    }

    func testDropLostResponseBlocksWritesAndConvergesOnlyToDroppedOutcome() async throws {
        try await bounded {
            let fixture = TodoHygieneHTTP(), network = try IsolatedTestNetwork(handler: fixture.handle)
            let store = await self.connect(network)
            defer { store.disconnect() }
            fixture.server.change { $0.dropTodo = true }
            let first = await store.dropTodo(store.todos[0])
            XCTAssertFalse(first)
            XCTAssertEqual(store.todoWrites["t"], .checking)
            XCTAssertEqual(store.errorMessage, "업무 변경 결과 확인 중입니다.")
            let duplicate = await store.dropTodo(store.todos[0])
            let opposite = await store.setTodoDone(store.todos[0], done: false)
            XCTAssertFalse(duplicate); XCTAssertFalse(opposite)
            XCTAssertEqual(fixture.server.read { $0.todoSends }, 1)
            fixture.server.change { $0.syncFailure = false }
            await store.refresh()
            XCTAssertEqual(store.todoWrites["t"], .confirmedCurrent)
            XCTAssertEqual(store.todos[0].outcome, "dropped")
        }
    }

    func testLostDropCannotConfirmAConcurrentDoneOutcome() async throws {
        try await bounded {
            let fixture = TodoHygieneHTTP(), network = try IsolatedTestNetwork(handler: fixture.handle)
            let store = await self.connect(network)
            defer { store.disconnect() }
            fixture.server.change { $0.dropTodo = true }
            _ = await store.dropTodo(store.todos[0])
            fixture.server.change { $0.syncFailure = false; $0.state.todos[0].outcome = "done" }
            await store.refresh()
            XCTAssertEqual(store.todoWrites["t"], .conflict)
        }
    }

    func testStaleDropCannotOverwriteAnotherDeviceAndUnreviewedTodoIsRefused() async throws {
        try await bounded {
            let fixture = TodoHygieneHTTP(), network = try IsolatedTestNetwork(handler: fixture.handle)
            let store = await self.connect(network)
            defer { store.disconnect() }
            var edited = store.todos[0]; edited.title = "로컬에서 바뀐 값"
            let unreviewed = await store.dropTodo(edited)
            XCTAssertFalse(unreviewed)
            XCTAssertEqual(store.errorMessage, "최신 업무 상태를 확인한 뒤 변경하세요.")
            XCTAssertEqual(fixture.server.read { $0.todoSends }, 0)
            fixture.server.change { $0.state.todos[0].done = true; $0.state.todos[0].outcome = "done"; $0.revisions.todos?["t"] = 2 }
            let stale = await store.dropTodo(store.todos[0])
            XCTAssertFalse(stale)
            XCTAssertEqual(store.todoWrites["t"], .conflict)
            XCTAssertEqual(store.todos[0].outcome, "done")
            XCTAssertEqual(fixture.server.read { $0.todoSends }, 1)
        }
    }

    func testLegacyAPIUsesUnversionedTodoResponseAndOptionalReason() async throws {
        try await bounded {
            let fixture = TodoHygieneHTTP(), network = try IsolatedTestNetwork(handler: fixture.handle)
            let api = APIClient(endpoint: network.endpoint, accessCode: "test", session: network.session)
            let result = try await api.dropTodo(id: "t")
            XCTAssertEqual(result.revision, 0)
            XCTAssertEqual(result.todo.outcome, "dropped")
            XCTAssertEqual(result.todo.closeReason, "대표가 필요 없음으로 정리")
            let request = try XCTUnwrap(network.requests.last)
            XCTAssertNil(request.value(forHTTPHeaderField: "If-Match"))
            XCTAssertNil(request.value(forHTTPHeaderField: "X-IAMCEO-Contract"))
            XCTAssertTrue(try WriteTestServer.body(request).isEmpty)
        }
    }
}
