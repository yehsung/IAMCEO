import Foundation
import XCTest
@testable import IAMCEO

private final class RequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    func append(_ request: URLRequest) { lock.lock(); defer { lock.unlock() }; requests.append(request) }
    func matching(_ suffix: String) -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests.filter { $0.url?.path.hasSuffix(suffix) == true } }
    func clear() { lock.lock(); defer { lock.unlock() }; requests = [] }
}
private final class StubProtocol: URLProtocol, @unchecked Sendable {
    static let capture = RequestCapture()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.capture.append(request)
        let path = request.url!.path
        if request.value(forHTTPHeaderField: "Authorization") == "Bearer rejected" {
            let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: "HTTP/1.1", headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(#"{"error":"Invalid access code"}"#.utf8))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        var status = 200
        var text = "{}"
        if path == "/api/bootstrap" { text = #"{"projects":[{"id":"p","name":"Project"}],"settings":{}}"# }
        else if path == "/api/projects/p/state" { text = #"{"project":{"id":"p","connection":{"ok":true}},"messages":[]}"# }
        else if path == "/api/projects/p/messages" {
            let calls = Self.capture.matching("/messages")
            if calls.count == 1 {
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                return
            }
            text = #"{"id":"sent","projectId":"p","mine":true,"body":"Hello"}"#
        }
        else if path == "/forbidden" { status = 401; text = #"{"error":"Access code rejected"}"# }
        else if path == "/bad-json" { text = "not json" }
        else if path == "/uploads/test" { text = "file bytes" }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class NetworkTests: XCTestCase {
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: config)
    }
    func testBearerHeaderAndAPIErrorDecoding() async throws {
        let client = APIClient(endpoint: try ServerEndpoint("http://localhost:7878"), accessCode: "test-secret", session: session())
        let data = try await client.attachmentData(Attachment(url: "/uploads/test"))
        XCTAssertEqual(String(data: data, encoding: .utf8), "file bytes")
        let request = try XCTUnwrap(StubProtocol.capture.matching("/uploads/test").last)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-secret")
        XCTAssertNil(request.url?.query)
        do {
            let _: Bootstrap = try await client.request("/forbidden")
            XCTFail("Unauthorized succeeded")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 401)
            XCTAssertEqual(error.message, "Access code rejected")
        }
        do {
            let _: Bootstrap = try await client.request("/bad-json")
            XCTFail("Invalid JSON succeeded")
        } catch let error as APIError { XCTAssertTrue(error.message.contains("호환되지 않습니다")) }
    }
    @MainActor func testUserRetryReusesIdAfterLostAcknowledgement() async throws {
        StubProtocol.capture.clear()
        let store = AppStore(session: session(), persistCredentials: false)
        store.endpoint = "http://localhost:7878"
        store.accessCode = "test-secret"
        await store.connect()
        store.setForeground(false)
        XCTAssertEqual(store.connectionStatus, .connected)
        let first = await store.sendMessage(text: "Hello")
        XCTAssertFalse(first)
        XCTAssertNotNil(store.errorMessage)
        let second = await store.sendMessage(text: "Hello")
        XCTAssertTrue(second)
        let sends = StubProtocol.capture.matching("/messages")
        XCTAssertEqual(sends.count, 2)
        // URLSession may move a body to a stream; the original request body remains available in the protocol request on Darwin.
        let bodies = try sends.map { request -> [String: Any] in
            let data: Data
            if let body = request.httpBody { data = body }
            else if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var bytes = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; bytes.append(buffer, count: count) }
                data = bytes
            } else { throw APIError(status: 0, message: "No request body") }
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        XCTAssertEqual(bodies[0]["id"] as? String, bodies[1]["id"] as? String)
        XCTAssertEqual(bodies[0]["text"] as? String, "Hello")
        store.disconnect()
    }
    @MainActor func testRejectedConnectionNeverShowsOfflineWorkspace() async {
        let store = AppStore(session: session(), persistCredentials: false)
        store.endpoint = "http://localhost:7878"
        store.accessCode = "rejected"
        await store.connect()
        XCTAssertEqual(store.connectionStatus, .failed)
        XCTAssertNil(store.state)
        XCTAssertNil(store.bootstrap)
        XCTAssertNil(store.api)
        XCTAssertEqual(store.errorMessage, "Invalid access code")
    }
    @MainActor func testFailedProjectSwitchClearsPreviousProject() async {
        let store = AppStore(session: session(), persistCredentials: false)
        store.endpoint = "http://localhost:7878"
        store.accessCode = "test-secret"
        await store.connect()
        store.setForeground(false)
        XCTAssertEqual(store.state?.project.id, "p")
        await store.selectProject(id: "missing-project")
        XCTAssertEqual(store.selectedProjectID, "missing-project")
        XCTAssertNil(store.state)
        XCTAssertTrue(store.messages.isEmpty)
        XCTAssertNotNil(store.errorMessage)
        XCTAssertFalse(store.isLoading)
        store.disconnect()
    }

}
