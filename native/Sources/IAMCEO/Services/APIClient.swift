import Foundation

struct APIError: LocalizedError, Sendable {
    let status: Int
    let message: String
    let code: String?
    /// 넓은 옛 코드(TERMINAL_REFUSED 등) 아래의 좁은 사유 코드. 옛 서버는 싣지 않는다(그때는 문장으로 가른다, ServerCode).
    let reason: String?
    init(status: Int, message: String, code: String? = nil, reason: String? = nil) {
        self.status = status
        self.message = message
        self.code = code
        self.reason = reason
    }
    var errorDescription: String? { message }
}

struct ServerEndpoint: Sendable {
    let url: URL
    init(_ input: String) throws {
        guard let parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", let url = parts.url else {
            throw APIError(status: 0, message: "https://your-mac.tailnet.ts.net 같은 서버 주소를 넣어 주세요.")
        }
        let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
        // Tailscale addresses are already end-to-end encrypted (WireGuard) and only reachable inside the tailnet.
        guard scheme == "https" || loopback || Tailnet.isTailnetHost(host) else {
            throw APIError(status: 0, message: "원격 연결은 HTTPS 주소나 Tailscale 주소(100.x)여야 합니다. 같은 Mac이면 127.0.0.1을 쓰세요.")
        }
        self.url = url
    }
}

/// Never forwards an access code through an HTTP redirect or to an attachment's foreign origin.
final class OriginRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

actor APIClient {
    let endpoint: ServerEndpoint
    private let accessCode: String
    private let session: URLSession
    /// 직접 만든 세션만 정리한다. 주입받은 세션의 수명은 넘겨준 쪽 것이다.
    private let ownsSession: Bool
    // Enable only after T8 switches every file reader to fileBody(id:).
    let liteStateEnabled: Bool
    private var fileBodyCache: [String: FileDoc] = [:]
    private var fileBodyOrder: [String] = []
    init(endpoint: ServerEndpoint, accessCode: String, session: URLSession? = nil, liteStateEnabled: Bool = false) {
        self.endpoint = endpoint
        self.accessCode = accessCode
        self.liteStateEnabled = liteStateEnabled
        ownsSession = session == nil
        if let session { self.session = session }
        else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 30
            config.timeoutIntervalForResource = 160
            config.httpShouldSetCookies = false
            self.session = URLSession(configuration: config, delegate: OriginRedirectDelegate(), delegateQueue: nil)
        }
    }
    // 무효화하지 않은 URLSession은 delegate와 유휴 연결을 앱이 꺼질 때까지 붙잡는다.
    deinit { if ownsSession { session.finishTasksAndInvalidate() } }

    func acknowledgePairing(code: String, confirmationToken: String) async throws -> PairingCompletion {
        struct Acknowledgement: Encodable, Sendable { let code: String; let confirmationToken: String }
        return try await send("/api/pair/ack", body: Acknowledgement(code: code, confirmationToken: confirmationToken))
    }

    /// Cache belongs to this endpoint/credential actor; never shared across servers or sign-ins.
    /// File IDs identify immutable snapshots. forceRefresh is for legacy documents edited in place.
    func fileBody(id: String, forceRefresh: Bool = false) async throws -> FileDoc {
        if !forceRefresh, let cached = fileBodyCache[id] { return cached }
        let file: FileDoc = try await request("/api/files/\(Self.segment(id))")
        guard file.id == id else { throw APIError(status: 0, message: "자료를 다시 확인해 주세요.") }
        fileBodyCache[id] = file
        fileBodyOrder.removeAll { $0 == id }; fileBodyOrder.append(id)
        while fileBodyOrder.count > 32 { fileBodyCache.removeValue(forKey: fileBodyOrder.removeFirst()) }
        return file
    }
    func clearFileBodyCache() { fileBodyCache.removeAll(); fileBodyOrder.removeAll() }

    func searchFiles(projectID: String, query: String, limit: Int = 200, archived: Bool = false) async throws -> [FileSearchResult] {
        var parts = URLComponents()
        parts.queryItems = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: String(limit))]
        // Encode the project as one segment, including IDs containing slashes.
        let path = "/api/projects/\(Self.segment(projectID))/\(archived ? "archive/" : "")files/search"
        return try await request(path + "?" + (parts.percentEncodedQuery ?? ""), contractVersion: 2)
    }

    /// Only a missing/unsupported route permits the legacy per-body search.
    func searchFilesWithFallback(projectID: String, query: String, files: [FileDoc], archived: Bool = false) async throws -> [FileSearchResult] {
        guard !query.isEmpty else { return [] }
        do { return try await searchFiles(projectID: projectID, query: query, archived: archived) }
        catch let error as APIError where error.status == 404 || error.status == 501 {
            var results: [FileSearchResult] = []
            for file in files where file.projectId == projectID {
                try Task.checkCancellation()
                let full = archived ? file : try await fileBody(id: file.id)
                let metadata = FileLinks.matches(file, body: "", query: query)
                guard metadata || full.body.localizedStandardContains(query) else { continue }
                results.append(FileSearchResult(id: file.id, match: metadata ? "title" : "body", excerpt: "", rank: results.count + 1))
            }
            return results
        }
    }
    func sendMessage(projectID: String, request: SendMessageRequest, contextFileID: String? = nil, contractVersion: Int? = nil) async throws -> Message {
        var body = request
        if let contextFileID { body.contextFileId = contextFileID }
        return try await send("/api/projects/\(Self.segment(projectID))/messages", body: body, contractVersion: contractVersion)
    }
    func completeTodo(id: String, done: Bool, note: String? = nil, fileIDs: [String] = [], revision: Int? = nil) async throws -> TodoWriteResult {
        let body = TodoCompletionRequest(done: done, note: note, fileIds: fileIDs.isEmpty ? nil : fileIDs)
        if let revision { return try await send("/api/todos/\(Self.segment(id))/done", body: body, ifMatch: revision, contractVersion: 2) }
        let todo: Todo = try await send("/api/todos/\(Self.segment(id))/done", body: body)
        return TodoWriteResult(todo: todo, revision: 0)
    }
    func dropTodo(id: String, reason: String? = nil, revision: Int? = nil) async throws -> TodoWriteResult {
        let body = TodoDropRequest(reason: reason)
        if let revision { return try await send("/api/todos/\(Self.segment(id))/drop", body: body, ifMatch: revision, contractVersion: 2) }
        let todo: Todo = try await send("/api/todos/\(Self.segment(id))/drop", body: body)
        return TodoWriteResult(todo: todo, revision: 0)
    }
    /// T9 calls after the app's own Mac notification permission has been enabled.
    func setMacScriptNotifications(_ enabled: Bool, revision: Int? = nil) async throws {
        struct Patch: Encodable, Sendable { let macScriptNotifications: Bool }
        if let revision {
            let _: SettingsWriteResult = try await send("/api/settings", method: "PATCH", body: Patch(macScriptNotifications: enabled), ifMatch: revision, contractVersion: 2)
        } else {
            let _: Settings = try await send("/api/settings", method: "PATCH", body: Patch(macScriptNotifications: enabled))
        }
    }

    /// These independent read-only checks run together; navigation is still owned by the Router token.
    func notificationContext(target: PushTarget) async throws -> NotificationContext {
        let projectID: String
        switch target {
        case .inbox(let project, _), .team(let project, _), .chat(let project, _, _, _): projectID = project
        case .projectHome(let project): projectID = project
        case .home: return NotificationContext()
        case .unknown: throw SubmissionError.mismatchedResult
        }
        async let snapshot: ProjectState = request("/api/projects/\(Self.segment(projectID))/state")
        var context = NotificationContext()
        switch target {
        case .inbox(_, let id): context.decision = try await request("/api/decisions/\(Self.segment(id))")
        case .chat(_, _, let id, _):
            do { context.messages = try await messagesAround(projectID: projectID, messageID: id, limit: 41) }
            catch let error as APIError where error.status == 404 { context.missingReport = true }
        default: break
        }
        context.state = try await snapshot
        return context
    }

    func request<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: Data? = nil, timeout: TimeInterval? = nil, ifMatch: Int? = nil, contractVersion: Int? = nil) async throws -> T {
        let (data, _) = try await raw(path, method: method, body: body, contentType: body == nil ? nil : "application/json", timeout: timeout, ifMatch: ifMatch, contractVersion: contractVersion)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch {
            // 어느 응답의 어느 필드가 어긋났는지 남긴다(값·본문·쿼리는 남기지 않는다).
            ContractLog.unreadable("\(method) \(URLComponents(string: path)?.path ?? "?")", error)
            throw APIError(status: 0, message: "서버 응답이 이 앱과 호환되지 않습니다. 앱과 서버 버전을 확인해 주세요.", code: Self.unreadableCode)
        }
    }
    /// 서버는 답했지만 이 앱이 응답을 해석하지 못했다는 표시. 서버가 주는 code와 겹치지 않는다.
    static let unreadableCode = "CLIENT_DECODE"
    func send<T: Decodable & Sendable, B: Encodable & Sendable>(_ path: String, method: String = "POST", body: B, timeout: TimeInterval? = nil, ifMatch: Int? = nil, contractVersion: Int? = nil) async throws -> T {
        try await request(path, method: method, body: JSONEncoder().encode(body), timeout: timeout, ifMatch: ifMatch, contractVersion: contractVersion)
    }
    func raw(_ path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil, timeout: TimeInterval? = nil, ifMatch: Int? = nil, contractVersion: Int? = nil) async throws -> (Data, HTTPURLResponse) {
        try Task.checkCancellation()
        if let ifMatch, !(0...9_007_199_254_740_991).contains(ifMatch) {
            throw APIError(status: 0, message: "올바른 revision이 필요합니다.")
        }
        var readPath = path
        if liteStateEnabled, method == "GET", var parts = URLComponents(string: path),
           parts.path == "/api/sync" || (parts.path.hasPrefix("/api/projects/") && parts.path.hasSuffix("/state") && !parts.path.contains("/archive/")) {
            var query = (parts.queryItems ?? []).filter { $0.name != "lite" }
            query.append(URLQueryItem(name: "lite", value: "1")); parts.queryItems = query
            readPath = parts.string ?? path
        }
        let url = try authorizedURL(readPath)
        var req = URLRequest(url: url)
        req.httpMethod = method
        // 쓰기 기본값(20초)을 60초 가까이 올리면 AppStore의 '도착하지 않은 쓰기' 판정(60초)도 함께 올려야 한다.
        req.timeoutInterval = timeout ?? (method == "GET" ? 30 : 20)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.httpShouldHandleCookies = false
        req.setValue("Bearer \(accessCode)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        // D5: 앱 버전·API 단계. 서버는 이것으로 앱과 맞지 않는지 판단한다(없으면 출시된 옛 앱으로 본다).
        AppVersion.apply(to: &req)
        if let ifMatch { req.setValue("\"\(ifMatch)\"", forHTTPHeaderField: "If-Match") }
        if let contractVersion { req.setValue(String(contractVersion), forHTTPHeaderField: "X-IAMCEO-Contract") }
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        req.httpBody = body
        let (data, response) = try await session.data(for: req)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, message: "서버 응답이 올바르지 않습니다.") }
        guard (200..<300).contains(http.statusCode) else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = object?["error"] as? String ?? object?["message"] as? String ?? "Request failed (\(http.statusCode))."
            throw APIError(status: http.statusCode, message: message, code: object?["code"] as? String, reason: object?["reason"] as? String)
        }
        return (data, http)
    }
    func authorizedURL(_ path: String) throws -> URL {
        guard let url = URL(string: path, relativeTo: endpoint.url)?.absoluteURL,
              url.scheme == endpoint.url.scheme, url.host == endpoint.url.host, url.port == endpoint.url.port,
              url.user == nil, url.password == nil, url.fragment == nil else {
            throw APIError(status: 0, message: "연결된 서버 밖의 파일 주소는 열지 않습니다.")
        }
        return url
    }
    /// Credentials are sent only in the header, including when using the legacy protocol.
    func webSocketRequest(version: Int = 2) throws -> URLRequest {
        guard version == 1 || version == 2 else {
            throw APIError(status: 0, message: "지원하지 않는 실시간 프로토콜입니다.")
        }
        var query = version == 2 ? [URLQueryItem(name: "v", value: "2")] : []
        if liteStateEnabled { query.append(URLQueryItem(name: "lite", value: "1")) }
        return try authorizedWebSocketRequest("/ws", query: query)
    }
    func terminalStreamRequest(memberID: String, mode: TerminalStreamMode, cols: Int, rows: Int, leaseID: String?, sizePolicy: TerminalSizePolicy = .fit) throws -> URLRequest {
        var query = [URLQueryItem(name: "mode", value: mode.rawValue), URLQueryItem(name: "cols", value: String(cols)), URLQueryItem(name: "rows", value: String(rows)), URLQueryItem(name: "size", value: sizePolicy.rawValue)]
        if let leaseID { query.append(URLQueryItem(name: "lease", value: leaseID)) }
        return try authorizedWebSocketRequest("/api/members/\(Self.segment(memberID))/terminal/stream", query: query)
    }
    func terminalStreamRefusal(memberID: String) async -> APIError? {
        do {
            _ = try await raw("/api/members/\(Self.segment(memberID))/terminal/stream?mode=observe")
            return nil
        } catch let error as APIError { return error.status == 400 ? nil : error }
        catch { return nil }
    }
    private func authorizedWebSocketRequest(_ path: String, query: [URLQueryItem]) throws -> URLRequest {
        var components = URLComponents(url: try authorizedURL(path), resolvingAgainstBaseURL: false)!
        components.scheme = endpoint.url.scheme == "https" ? "wss" : "ws"
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw APIError(status: 0, message: "실시간 연결 주소가 올바르지 않습니다.") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        request.setValue("Bearer \(accessCode)", forHTTPHeaderField: "Authorization")
        // 실시간 연결·첨부 올리기·받기도 이 요청을 바탕으로 만든다. 같은 버전 머리글을 싣는다.
        AppVersion.apply(to: &request)
        return request
    }
    func attachmentData(_ attachment: Attachment) async throws -> Data { try await raw(attachment.url).0 }
    func artifact(fileID: String) async throws -> String {
        struct Result: Decodable, Sendable { let html: String }
        let result: Result = try await request("/api/files/\(Self.segment(fileID))/artifact")
        return result.html
    }
    func activity(memberID: String) async throws -> [Activity] { try await request("/api/members/\(Self.segment(memberID))/activity?limit=100") }
    func models() async throws -> ModelCatalog {
        do { return try await request("/api/models") }
        catch let error as APIError where error.status == 404 { return .fallback }
    }
    func screen(memberID: String) async throws -> String {
        struct Result: Decodable, Sendable { let text: String }
        let result: Result = try await request("/api/members/\(Self.segment(memberID))/screen")
        return result.text
    }
    func upload(data: Data, filename: String, mime: String, projectID: String, targetMemberID: String? = nil) async throws -> Attachment {
        guard data.count <= 50 * 1024 * 1024 else { throw APIError(status: 0, message: "첨부파일은 50MB까지 올릴 수 있습니다.") }
        let boundary = "IAMCEO-\(UUID().uuidString)"
        let safeName = filename.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
        let safeMime = mime.contains("\n") || mime.contains("\r") ? "application/octet-stream" : mime
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(safeMime)\r\n\r\n".utf8)
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var path = "/api/uploads?project=\(Self.segment(projectID))"
        if let targetMemberID { path += "&target=\(Self.segment(targetMemberID))" }
        let (response, _) = try await raw(path, method: "POST", body: body, contentType: "multipart/form-data; boundary=\(boundary)", timeout: 150)
        return try JSONDecoder().decode(Attachment.self, from: response)
    }
    static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? ""
    }
}

extension APIClient: MessageHistoryService, ProjectManagementService, SyncService, DeliveryNoticeService, OperationService, PushService {
    private func pagePath(projectID: String, archived: Bool, scope: MessageScope, cursor: String?, limit: Int) throws -> String {
        var query = ["limit=\(limit)"]
        switch scope {
        case .project: query.append("scope=project")
        case .member(let memberID): query.append("scope=member&memberId=\(Self.segment(memberID))")
        case .unknown: throw APIError(status: 0, message: "지원하지 않는 대화 범위입니다.")
        }
        if let cursor { query.append("cursor=\(Self.segment(cursor))") }
        return "/api/projects/\(Self.segment(projectID))/\(archived ? "archive/" : "")messages/page?\(query.joined(separator: "&"))"
    }
    func messagePage(projectID: String, scope: MessageScope, cursor: String?, limit: Int) async throws -> MessagePage {
        // A page 404 is also a missing/archived project. The history coordinator
        // must confirm /state succeeds before recording legacy paging support.
        try await request(pagePath(projectID: projectID, archived: false, scope: scope, cursor: cursor, limit: limit))
    }
    func archivedMessagePage(projectID: String, scope: MessageScope, cursor: String?, limit: Int) async throws -> MessagePage {
        try await request(pagePath(projectID: projectID, archived: true, scope: scope, cursor: cursor, limit: limit))
    }
    func message(id: String) async throws -> Message { try await request("/api/messages/\(Self.segment(id))") }
    func messagesAround(projectID: String, messageID: String, limit: Int) async throws -> [Message] {
        try await request("/api/projects/\(Self.segment(projectID))/messages?around=\(Self.segment(messageID))&limit=\(limit)")
    }
    func archivedProjects() async throws -> [Project] { try await request("/api/projects/archived") }
    // B 묶음(설치 수명): 보관한 프로젝트 지우기와 프로젝트 내보내기. 옛 서버는 지우기에 405, 내보내기에 404 를 준다.
    func deleteProject(id: String) async throws -> ProjectDeleteResult {
        try await request("/api/projects/\(Self.segment(id))", method: "DELETE")
    }
    /// 서버가 도는 Mac 에서만 된다(다른 기기는 403 LOCAL_ONLY). zip 을 임시 파일로 받아 그 자리를 돌려준다. 큰 프로젝트도 메모리에 올리지 않는다.
    func exportProject(id: String) async throws -> URL {
        var req = URLRequest(url: try authorizedURL("/api/projects/\(Self.segment(id))/export"))
        req.httpMethod = "GET"
        req.timeoutInterval = 150
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.httpShouldHandleCookies = false
        req.setValue("Bearer \(accessCode)", forHTTPHeaderField: "Authorization")
        let (file, response) = try await session.download(for: req)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else {
            try? FileManager.default.removeItem(at: file)
            throw APIError(status: 0, message: "서버 응답이 올바르지 않습니다.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let object = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any]
            try? FileManager.default.removeItem(at: file)
            throw APIError(status: http.statusCode, message: object?["error"] as? String ?? "Request failed (\(http.statusCode)).", code: object?["code"] as? String)
        }
        let target = FileManager.default.temporaryDirectory.appendingPathComponent("iamceo-export-\(UUID().uuidString).zip")
        try FileManager.default.moveItem(at: file, to: target)
        return target
    }
    func patchProject(id: String, request: PatchProjectRequest) async throws -> Project {
        try await send("/api/projects/\(Self.segment(id))", method: "PATCH", body: request, timeout: 150)
    }
    func archiveState(projectID: String) async throws -> ProjectState {
        try await request("/api/projects/\(Self.segment(projectID))/archive/state")
    }
    func capabilities() async throws -> ServerCapabilities {
        do { return try await request("/api/capabilities") }
        catch let error as APIError where error.status == 404 {
            // No capability is inferred from an auth, transport, JSON or 5xx failure.
            // Missing flags remain unknown so feature-specific probes can still run.
            return ServerCapabilities()
        }
    }
    func sync(projectID: String?) async throws -> SyncSnapshot {
        try await request("/api/sync" + (projectID.map { "?projectId=\(Self.segment($0))" } ?? ""))
    }
    func deliveryNotices(memberID: String, before: String?, limit: Int) async throws -> DeliveryNoticePage {
        try await request("/api/members/\(Self.segment(memberID))/delivery-notices?limit=\(limit)" + (before.map { "&before=\(Self.segment($0))" } ?? ""))
    }
    func unassignedDeliveryNotices(projectID: String) async throws -> DeliveryNotices {
        try await request("/api/projects/\(Self.segment(projectID))/delivery-notices")
    }
    func recoverUnassignedMessage(messageID: String, request: UnassignedRecoveryRequest) async throws -> UnassignedRecoveryResult {
        try await send("/api/messages/\(Self.segment(messageID))/recovery", body: request, contractVersion: 2)
    }
    func recoverDelivery(id: String, request: DeliveryRecoveryRequest) async throws -> DeliveryRecoveryResult {
        try await send("/api/deliveries/\(Self.segment(id))/recovery", body: request, contractVersion: 2)
    }
    func operation(id: String) async throws -> OperationReceipt {
        try await request("/api/operations/\(Self.segment(id))", contractVersion: 2)
    }
    func freshSession(memberID: String, request: FreshSessionRequest) async throws -> OperationReceipt {
        try await send("/api/members/\(Self.segment(memberID))/fresh-session", body: request, timeout: 150, contractVersion: 2)
    }
    func terminalControl(memberID: String, request: TerminalControlV2Request) async throws -> OperationReceipt {
        try await send("/api/members/\(Self.segment(memberID))/terminal/control", body: request, contractVersion: 2)
    }
    func patchSettings(request: SettingsPatchRequest, revision: Int) async throws -> SettingsWriteResult {
        try await send("/api/settings", method: "PUT", body: request, ifMatch: revision, contractVersion: 2)
    }
    func patchMember(id: String, request: PatchMemberRequest, revision: Int) async throws -> MemberConfigWriteResult {
        try await send("/api/members/\(Self.segment(id))", method: "PATCH", body: request, timeout: 150, ifMatch: revision, contractVersion: 2)
    }
    func patchTodo(id: String, request: TodoPatchRequest, revision: Int) async throws -> TodoWriteResult {
        try await send("/api/todos/\(Self.segment(id))/done", body: request, ifMatch: revision, contractVersion: 2)
    }
    func pushStatus() async throws -> PushStatus { try await request("/api/push/status") }
    func pushDevices() async throws -> PushDeviceList { try await request("/api/push/devices") }
    func pushDevice(id: String) async throws -> PushDevice { try await request("/api/push/devices/\(Self.segment(id))") }
    func registerPushDevice(id: String, request: PushRegistrationRequest) async throws -> PushDevice {
        try await send("/api/push/devices/\(Self.segment(id))", method: "PUT", body: request)
    }
    func patchPushDevice(id: String, request: PushDevicePatchRequest) async throws -> PushDevice {
        try await send("/api/push/devices/\(Self.segment(id))", method: "PATCH", body: request)
    }
    func revokePushDevice(id: String, revision: Int) async throws {
        struct Result: Decodable, Sendable { let ok: Bool }
        let result: Result = try await request("/api/push/devices/\(Self.segment(id))", method: "DELETE", ifMatch: revision)
        guard result.ok else { throw APIError(status: 0, message: "기기 해지 결과를 확인하지 못했습니다.") }
    }
    func testPushDevice(id: String, request: PushTestRequest) async throws -> PushTestResult {
        try await send("/api/push/devices/\(Self.segment(id))/test", body: request)
    }
    func pushTarget(eventID: String) async throws -> PushEventTarget {
        try await request("/api/push/events/\(Self.segment(eventID))/target")
    }
}

struct SendMessageRequest: Encodable, Sendable {
    let id: String
    let text: String
    let targetMemberId: String?
    let attachmentIds: [String]
    var contextFileId: String? = nil
}
struct AnswerRequest: Encodable, Sendable {
    let choice: String?
    let note: String?
    let batch: Bool
    let expectedVersion: String
    /// Only on a usage card's `model:` answer: the staff the person saw on the card. Left out (nil) otherwise, so older servers never see it.
    var memberIds: [String]? = nil
}
struct CreateProjectRequest: Encodable, Sendable {
    let name: String; let cwd: String; let goal: String; let startConductor: Bool; let chiefCli: String
    /// true: the server answers the CLI's own "trust this folder?" window for this project. Left out otherwise.
    var trustFolder: Bool? = nil
}
struct CreateMemberRequest: Encodable, Sendable { let name: String; let role: String; let cli: String; let modelOverride: String? }
/// DELETE /api/projects/:id 의 답(B 묶음). 지운 첨부 수는 선택 필드로 읽는다.
struct ProjectDeleteResult: Decodable, Sendable { let id: String; let deleted: Bool; var removedAttachments: Int? = nil }
struct PatchMemberRequest: Encodable, Sendable {
    let cli: String; let modelOverride: String?; let effortOverride: String?
    enum CodingKeys: String, CodingKey { case cli, modelOverride, effortOverride }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(cli, forKey: .cli)
        try c.encode(modelOverride, forKey: .modelOverride)
        try c.encode(effortOverride, forKey: .effortOverride)
    }
}

struct TerminalControlRequest: Encodable, Sendable {
    let action: String
    var leaseId: String? = nil
    var text: String? = nil
    var key: String? = nil
}
struct TerminalLease: Decodable, Sendable {
    let leaseId: String?
    let expiresAt: Double?
}
extension APIClient {
    func terminalControl(memberID: String, request body: TerminalControlRequest) async throws -> TerminalLease {
        try await send("/api/members/\(Self.segment(memberID))/terminal/control", body: body)
    }
}

// Server-side folder browsing. Paths here always belong to the connected server.
struct ServerFolder: Codable, Sendable, Equatable {
    let name: String
    let path: String
}
struct ServerFolderRow: Sendable, Identifiable {
    struct ID: Hashable, Sendable { let name: String; let ordinal: Int }
    let folder: ServerFolder
    let ordinal: Int
    var id: ID { ID(name: folder.name, ordinal: ordinal) }
}
struct FolderListing: Codable, Sendable, Equatable {
    let path: String
    let parent: String?
    let home: String
    let entries: [ServerFolder]
    var truncated: Bool? = nil
    var rows: [ServerFolderRow] {
        entries.enumerated().map { ServerFolderRow(folder: $0.element, ordinal: $0.offset) }
    }
}
enum FolderBrowserResult: Sendable { case listing(FolderListing), legacy }
struct FolderCrumb: Identifiable, Equatable {
    let name: String
    let path: String
    var id: String { path }
}
enum ServerFolderPaths {
    static func parent(_ path: String) -> String { (path as NSString).deletingLastPathComponent }
    static func appending(_ name: String, to parent: String) -> String { parent.hasSuffix("/") ? parent + name : parent + "/" + name }
    static func breadcrumbs(path: String, home: String) -> [FolderCrumb] {
        guard path == home || path.hasPrefix(home + "/") else { return [] }
        var result = [FolderCrumb(name: "홈", path: home)]
        var current = home
        for name in path.dropFirst(home.count).split(separator: "/").map(String.init) {
            current = appending(name, to: current)
            result.append(FolderCrumb(name: name, path: current))
        }
        return result
    }
    static func nameError(_ input: String) -> String? {
        let name = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.unicodeScalars.count <= 100, !name.hasPrefix("."),
              !name.contains("/"), !name.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) else {
            return "점으로 시작하지 않는 1~100자 이름을 입력하세요. /와 제어문자는 쓸 수 없습니다."
        }
        return nil
    }
    static func repository(_ input: String) -> String? {
        let pattern = #"^(?:https://github\.com/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9_.-]{1,100})$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: input, range: NSRange(input.startIndex..., in: input)),
              match.range.length == input.utf16.count,
              let owner = Range(match.range(at: 1), in: input), let repo = Range(match.range(at: 2), in: input) else { return nil }
        var name = String(input[repo])
        if name.hasSuffix(".git") { name.removeLast(4) }
        guard !name.isEmpty, name != ".", name != ".." else { return nil }
        return String(input[owner]) + "/" + name
    }
}
struct GitHubRepository: Codable, Sendable, Identifiable {
    let nameWithOwner: String
    let description: String?
    let visibility: String
    let updatedAt: String
    let url: String
    var id: String { nameWithOwner }
}
struct GitHubRepositories: Codable, Sendable {
    let available: Bool
    var reason: String? = nil
    var repos: [GitHubRepository] = []
}
extension GitHubRepositories {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        available = try values.decode(Bool.self, forKey: .available)
        reason = try values.decodeIfPresent(String.self, forKey: .reason)
        repos = try values.decodeIfPresent([GitHubRepository].self, forKey: .repos) ?? []
    }
}
struct GitHubCloneJob: Codable, Sendable {
    enum Status: String, Codable, Sendable { case running, done, failed }
    let status: Status
    var path: String? = nil
    var error: String? = nil
}
extension APIClient {
    func folderContents(path: String? = nil) async throws -> FolderListing {
        var parts = URLComponents(); parts.path = "/api/folders"
        if let path { parts.queryItems = [URLQueryItem(name: "path", value: path)] }
        return try await request(parts.string!)
    }
    func folderBrowser() async throws -> FolderBrowserResult {
        do { return .listing(try await folderContents()) }
        catch let error as APIError where error.status == 404 { return .legacy }
    }
    func createFolder(parent: String, name: String) async throws -> ServerFolder {
        struct Body: Encodable, Sendable { let parent: String; let name: String }
        return try await send("/api/folders", body: Body(parent: parent, name: name))
    }
    func githubRepositories(query: String = "") async throws -> GitHubRepositories {
        var parts = URLComponents(); parts.path = "/api/github/repos"
        parts.queryItems = [URLQueryItem(name: "query", value: query)]
        return try await request(parts.string!)
    }
    func cloneRepository(repo: String, parent: String) async throws -> String {
        struct Body: Encodable, Sendable { let repo: String; let parent: String }
        struct Result: Decodable, Sendable { let jobId: String }
        let result: Result = try await send("/api/github/clone", body: Body(repo: repo, parent: parent))
        return result.jobId
    }
    func cloneJob(_ id: String) async throws -> GitHubCloneJob {
        try await request("/api/github/clone/\(Self.segment(id))")
    }
}

struct NotificationContext: Sendable {
    var state: ProjectState?
    var decision: Decision?
    var messages: [Message] = []
    var missingReport = false
}
