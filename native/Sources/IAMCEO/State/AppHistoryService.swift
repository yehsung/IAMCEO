import Foundation

// 대화 이력 읽기를 AppStore 의 연결(APIClient)에 잇는 어댑터. 이력 캐시와 페이지 규칙은 ChatHistory.swift 에 있다.

enum HistoryPagingSupport: Sendable { case unknown, supported, unsupported }
actor HistoryRequestFailure {
    private(set) var error: Error?
    func record(_ error: Error) { self.error = error }
}
struct AppHistoryService: MessageHistoryService {
    let api: APIClient
    let failure: HistoryRequestFailure
    func messagePage(projectID: String, scope: MessageScope, cursor: String?, limit: Int) async throws -> MessagePage {
        do { return try await api.messagePage(projectID: projectID, scope: scope, cursor: cursor, limit: limit) }
        catch { await failure.record(error); throw error }
    }
    func archivedMessagePage(projectID: String, scope: MessageScope, cursor: String?, limit: Int) async throws -> MessagePage {
        do { return try await api.archivedMessagePage(projectID: projectID, scope: scope, cursor: cursor, limit: limit) }
        catch { await failure.record(error); throw error }
    }
    func message(id: String) async throws -> Message { try await api.message(id: id) }
    func messagesAround(projectID: String, messageID: String, limit: Int) async throws -> [Message] {
        try await api.messagesAround(projectID: projectID, messageID: messageID, limit: limit)
    }
}
