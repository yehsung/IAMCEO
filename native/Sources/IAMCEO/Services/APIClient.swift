import Foundation

struct APIError: LocalizedError, Sendable {
    let status: Int
    let message: String
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
private final class OriginRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
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

    func request<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: Data? = nil, timeout: TimeInterval? = nil) async throws -> T {
        let (data, _) = try await raw(path, method: method, body: body, contentType: body == nil ? nil : "application/json", timeout: timeout)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError(status: 0, message: "서버 응답이 이 앱과 호환되지 않습니다: \(error.localizedDescription)") }
    }
    func send<T: Decodable & Sendable, B: Encodable & Sendable>(_ path: String, method: String = "POST", body: B, timeout: TimeInterval? = nil) async throws -> T {
        try await request(path, method: method, body: JSONEncoder().encode(body), timeout: timeout)
    }
    private func raw(_ path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil, timeout: TimeInterval? = nil) async throws -> (Data, HTTPURLResponse) {
        let url = try authorizedURL(path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = timeout ?? (method == "GET" ? 30 : 20)
        req.setValue("Bearer \(accessCode)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let contentType { req.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        req.httpBody = body
        let (data, response) = try await session.data(for: req)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, message: "서버 응답이 올바르지 않습니다.") }
        guard (200..<300).contains(http.statusCode) else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = object?["error"] as? String ?? object?["message"] as? String ?? "Request failed (\(http.statusCode))."
            throw APIError(status: http.statusCode, message: message)
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
