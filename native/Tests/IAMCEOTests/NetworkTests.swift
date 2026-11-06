import Foundation
import XCTest
@testable import IAMCEO

private final class RequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    func append(_ request: URLRequest) { lock.lock(); defer { lock.unlock() }; requests.append(request) }
    func matching(_ suffix: String) -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests.filter { $0.url?.path.hasSuffix(suffix) == true } }
}
final class NetworkTests: XCTestCase {
    private func fixture() throws -> IsolatedTestNetwork {
        let capture = RequestCapture()
        return try IsolatedTestNetwork { request in
            capture.append(request)
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer rejected" {
                return IsolatedTestHTTPReply(status: 401, data: Data(#"{"error":"Invalid access code"}"#.utf8))
            }
            let text: String
            switch request.url?.path {
            case "/api/bootstrap": text = #"{"projects":[{"id":"p","name":"Project"}],"settings":{}}"#
            case "/api/projects/p/state": text = #"{"project":{"id":"p","connection":{"ok":true}},"messages":[]}"#
            case "/api/runtime": text = "{}"
            case "/api/projects/p/messages":
                if capture.matching("/messages").count == 1 { throw URLError(.networkConnectionLost) }
                text = #"{"id":"sent","projectId":"p","mine":true,"body":"Hello"}"#
            case "/forbidden":
                return IsolatedTestHTTPReply(status: 401, data: Data(#"{"error":"Access code rejected","code":"AUTH_REJECTED"}"#.utf8))
            case "/bad-json": text = "not json"
            case "/uploads/test": text = "file bytes"
            default: throw URLError(.resourceUnavailable)
            }
            return IsolatedTestHTTPReply(data: Data(text.utf8))
        }
    }
    func testBearerHeaderAndAPIErrorDecoding() async throws {
        let fixture = try fixture()
        let client = fixture.makeAPIClient(accessCode: "test-secret")
        let data = try await client.attachmentData(Attachment(url: "/uploads/test"))
        XCTAssertEqual(String(data: data, encoding: .utf8), "file bytes")
        let request = try XCTUnwrap(fixture.requests.last { $0.url?.path == "/uploads/test" })
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-secret")
        XCTAssertNil(request.url?.query)
        do {
            let _: Bootstrap = try await client.request("/forbidden")
            XCTFail("Unauthorized succeeded")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 401)
            XCTAssertEqual(error.message, "Access code rejected")
            XCTAssertEqual(error.code, "AUTH_REJECTED")
        }
        do {
            let _: Bootstrap = try await client.request("/bad-json")
            XCTFail("Invalid JSON succeeded")
        } catch let error as APIError { XCTAssertTrue(error.message.contains("호환되지 않습니다")) }
    }
    @MainActor func testUserRetryReusesIdAfterLostAcknowledgement() async throws {
        let fixture = try fixture()
        let store = AppStore(session: fixture.session, persistCredentials: false)
        store.endpoint = fixture.endpoint.url.absoluteString
        store.accessCode = "test-secret"
        await store.connect()
        store.setForeground(false)
        XCTAssertEqual(store.connectionStatus, .connected)
        let first = await store.sendMessage(text: "Hello")
        XCTAssertFalse(first)
        XCTAssertNotNil(store.errorMessage)
        let second = await store.sendMessage(text: "Hello")
        XCTAssertTrue(second)
        let sends = fixture.requests.filter { $0.url?.path == "/api/projects/p/messages" }
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
    @MainActor func testRejectedConnectionNeverShowsOfflineWorkspace() async throws {
        let fixture = try fixture()
        let store = AppStore(session: fixture.session, persistCredentials: false)
        store.endpoint = fixture.endpoint.url.absoluteString
        store.accessCode = "rejected"
        await store.connect()
        XCTAssertEqual(store.connectionStatus, .failed)
        XCTAssertNil(store.state)
        XCTAssertNil(store.bootstrap)
        XCTAssertNil(store.api)
        XCTAssertEqual(store.errorMessage, "Invalid access code")
    }
    @MainActor func testFailedProjectSwitchClearsPreviousProject() async throws {
        let fixture = try fixture()
        let store = AppStore(session: fixture.session, persistCredentials: false)
        store.endpoint = fixture.endpoint.url.absoluteString
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

    func testOriginRefusalHappensBeforeSendingBearer() async throws {
        let fixture = try IsolatedTestNetwork()
        let api = fixture.makeAPIClient(accessCode: "private")
        for path in ["https://foreign.invalid/file", "//foreign.invalid/file", "http://127.0.0.1:1/file", "http://user@127.0.0.1/file", "/file#fragment"] {
            do { _ = try await api.attachmentData(Attachment(url: path)); XCTFail("Foreign URL accepted: \(path)") }
            catch let error as APIError { XCTAssertEqual(error.status, 0) }
        }
        XCTAssertTrue(fixture.requests.isEmpty)
        await fixture.close()
    }

    func testRedirectResponsesAreErrorsAndNeverBecomeSuccess() async throws {
        for status in [301, 302, 303, 307, 308] {
            let fixture = try IsolatedTestNetwork { _ in
                IsolatedTestHTTPReply(status: status, data: Data(), headers: ["Location": "https://foreign.invalid/steal"])
            }
            do { let _: Project = try await fixture.makeAPIClient().request("/redirect"); XCTFail("Redirect succeeded") }
            catch let error as APIError { XCTAssertEqual(error.status, status) }
            XCTAssertEqual(fixture.requests.count, 1)
            await fixture.close()
        }
    }

    func testLegacyTimeoutsOptionalIfMatchAndMultipartRemainCompatible() async throws {
        let fixture = try IsolatedTestNetwork { request in
            let text = request.url?.path == "/api/uploads" ? #"{"id":"attachment","url":"/uploads/a"}"# : #"{"id":"p"}"#
            return IsolatedTestHTTPReply(data: Data(text.utf8))
        }
        let api = fixture.makeAPIClient()
        let _: Project = try await api.request("/read")
        let _: Project = try await api.send("/legacy", body: TodoPatchRequest(done: true))
        let _: Project = try await api.request("/custom", method: "PATCH", timeout: 77, ifMatch: 12)
        let _: Project = try await api.send("/custom-send", method: "PUT", body: TodoPatchRequest(done: false), timeout: 88, ifMatch: 13)
        let attachment = try await api.upload(data: Data("file bytes".utf8), filename: "photo\"\r\n.jpg", mime: "bad\r\nmime", projectID: "p /?&", targetMemberID: "m /?&")
        XCTAssertEqual(attachment.id, "attachment")
        XCTAssertEqual(fixture.requests.map(\.timeoutInterval), [30, 20, 77, 88, 150])
        XCTAssertNil(fixture.requests[0].value(forHTTPHeaderField: "If-Match"))
        XCTAssertNil(fixture.requests[1].value(forHTTPHeaderField: "If-Match"))
        XCTAssertEqual(fixture.requests[2].value(forHTTPHeaderField: "If-Match"), "\"12\"")
        XCTAssertEqual(fixture.requests[3].value(forHTTPHeaderField: "If-Match"), "\"13\"")
        XCTAssertTrue(fixture.requests.allSatisfy { $0.value(forHTTPHeaderField: "X-IAMCEO-Contract") == nil })
        let upload = fixture.requests[4]
        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(upload.url), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "project", value: "p /?&"), URLQueryItem(name: "target", value: "m /?&")])
        XCTAssertTrue(upload.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=IAMCEO-") == true)
        XCTAssertEqual(upload.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
        await fixture.close()
    }

    func testTimeoutDoesNotReplayV2MutationOrLoseTransportError() async throws {
        let fixture = try IsolatedTestNetwork { _ in throw URLError(.timedOut) }
        do {
            _ = try await fixture.makeAPIClient().terminalControl(memberID: "m", request: TerminalControlV2Request(action: .input, operationId: "stable-op", expectedSessionGeneration: 1, claimId: "stable-claim", inputSequence: 1, text: "hello"))
            XCTFail("Lost acknowledgement succeeded")
        } catch let error as URLError { XCTAssertEqual(error.code, .timedOut) }
        XCTAssertEqual(fixture.requests.count, 1)
        await fixture.close()
    }

    func testCancelledRequestAndInvalidRevisionSendNothing() async throws {
        let fixture = try IsolatedTestNetwork()
        let api = fixture.makeAPIClient()
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            let _: Project = try await api.request("/cancelled")
        }
        do { try await task.value; XCTFail("Cancelled request succeeded") }
        catch is CancellationError {}
        for revision in [-1, Int.max] {
            do {
                let _: Project = try await api.request("/invalid-revision", method: "DELETE", ifMatch: revision)
                XCTFail("Invalid revision succeeded")
            } catch let error as APIError { XCTAssertEqual(error.status, 0) }
        }
        do {
            _ = try await api.messagePage(projectID: "p", scope: .unknown("future"), cursor: nil, limit: 200)
            XCTFail("Unknown scope sent a request")
        } catch let error as APIError { XCTAssertEqual(error.status, 0) }
        XCTAssertTrue(fixture.requests.isEmpty)
        await fixture.close()
    }
}
