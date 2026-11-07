import Foundation

struct APIError: LocalizedError, Sendable {
    let status: Int
    let message: String
    let code: String?
    init(status: Int, message: String, code: String? = nil) {
        self.status = status
        self.message = message
        self.code = code
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
    init(endpoint: ServerEndpoint, accessCode: String, session: URLSession? = nil) {
        self.endpoint = endpoint
        self.accessCode = accessCode
        if let session { self.session = session }
        else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 30
            config.timeoutIntervalForResource = 160
            config.httpShouldSetCookies = false
            self.session = URLSession(configuration: config, delegate: OriginRedirectDelegate(), delegateQueue: nil)
        }
    }

    func request<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: Data? = nil, timeout: TimeInterval? = nil, ifMatch: Int? = nil, contractVersion: Int? = nil) async throws -> T {
        let (data, _) = try await raw(path, method: method, body: body, contentType: body == nil ? nil : "application/json", timeout: timeout, ifMatch: ifMatch, contractVersion: contractVersion)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError(status: 0, message: "서버 응답이 이 앱과 호환되지 않습니다: \(error.localizedDescription)") }
    }
    func send<T: Decodable & Sendable, B: Encodable & Sendable>(_ path: String, method: String = "POST", body: B, timeout: TimeInterval? = nil, ifMatch: Int? = nil, contractVersion: Int? = nil) async throws -> T {
        try await request(path, method: method, body: JSONEncoder().encode(body), timeout: timeout, ifMatch: ifMatch, contractVersion: contractVersion)
    }
    private func raw(_ path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil, timeout: TimeInterval? = nil, ifMatch: Int? = nil, contractVersion: Int? = nil) async throws -> (Data, HTTPURLResponse) {
        try Task.checkCancellation()
        if let ifMatch, !(0...9_007_199_254_740_991).contains(ifMatch) {
            throw APIError(status: 0, message: "올바른 revision이 필요합니다.")
        }
        let url = try authorizedURL(path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = timeout ?? (method == "GET" ? 30 : 20)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.httpShouldHandleCookies = false
        req.setValue("Bearer \(accessCode)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
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
            throw APIError(status: http.statusCode, message: message, code: object?["code"] as? String)
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
        return try authorizedWebSocketRequest("/ws", query: version == 2 ? [URLQueryItem(name: "v", value: "2")] : [])
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
        return request
    }
    func attachmentData(_ attachment: Attachment) async throws -> Data { try await raw(attachment.url).0 }
    func artifact(fileID: String) async throws -> String {
        struct Result: Decodable, Sendable { let html: String }
        let result: Result = try await request("/api/files/\(Self.segment(fileID))/artifact")
        return result.html
    }
    func activity(memberID: String) async throws -> [Activity] { try await request("/api/members/\(Self.segment(memberID))/activity?limit=100") }
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
}
struct AnswerRequest: Encodable, Sendable {
    let choice: String?
    let note: String?
    let batch: Bool
    let expectedVersion: String
}
struct CreateProjectRequest: Encodable, Sendable { let name: String; let cwd: String; let goal: String; let startConductor: Bool; let chiefCli: String }
struct CreateMemberRequest: Encodable, Sendable { let name: String; let role: String; let cli: String; let modelOverride: String? }
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
