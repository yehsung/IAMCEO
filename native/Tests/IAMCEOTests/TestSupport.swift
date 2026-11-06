import Foundation
import XCTest
@testable import IAMCEO

struct IsolatedTestHTTPReply: Sendable {
    var status: Int = 200
    var data: Data = Data("{}".utf8)
    var headers: [String: String] = ["Content-Type": "application/json"]
}

/// Each session owns its handler/capture. Unmatched requests fail in URLProtocol;
/// they never fall through to DNS, TCP, cookies, credentials, or the shared session.
private final class IsolatedTestHTTPState: @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> IsolatedTestHTTPReply
    private let lock = NSLock()
    private var captured: [URLRequest] = []
    let origin: URL
    let handler: Handler
    init(origin: URL, handler: @escaping Handler) { self.origin = origin; self.handler = handler }
    func reply(to request: URLRequest) throws -> IsolatedTestHTTPReply {
        lock.withLock { captured.append(request) }
        guard let url = request.url, url.scheme == origin.scheme, url.host == origin.host,
              url.port == origin.port, url.port != 7878, url.user == nil, url.password == nil else {
            throw URLError(.unsupportedURL)
        }
        return try handler(request)
    }
    var requests: [URLRequest] { lock.withLock { captured } }
}

private final class IsolatedTestHTTPRegistry: @unchecked Sendable {
    static let shared = IsolatedTestHTTPRegistry()
    private let lock = NSLock()
    private var states: [String: IsolatedTestHTTPState] = [:]
    func add(id: String, handler: @escaping IsolatedTestHTTPState.Handler) -> IsolatedTestHTTPState {
        lock.withLock {
            // Mock-only address, deliberately never opened. Integration tests use
            // the explicit port0 address from the Bun runtime instead.
            var port = Int.random(in: 49152...65535)
            while states.values.contains(where: { $0.origin.port == port }) { port = Int.random(in: 49152...65535) }
            let state = IsolatedTestHTTPState(origin: URL(string: "http://127.0.0.1:\(port)")!, handler: handler)
            states[id] = state
            return state
        }
    }
    func get(_ id: String) -> IsolatedTestHTTPState? { lock.withLock { states[id] } }
    func remove(_ id: String) { lock.withLock { _ = states.removeValue(forKey: id) } }
}

private final class IsolatedTestURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canInit(with task: URLSessionTask) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let id = request.value(forHTTPHeaderField: "X-IAMCEO-Test-Fixture"),
                  let state = IsolatedTestHTTPRegistry.shared.get(id) else { throw URLError(.unsupportedURL) }
            let reply = try state.reply(to: request)
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers) else {
                throw URLError(.badServerResponse)
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: reply.data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class IsolatedTestNetwork: @unchecked Sendable {
    private let id: String
    private let state: IsolatedTestHTTPState
    let session: URLSession
    let endpoint: ServerEndpoint
    let webSockets: IsolatedTestWebSocketFactory
    init(handler: @escaping @Sendable (URLRequest) throws -> IsolatedTestHTTPReply = { _ in throw URLError(.resourceUnavailable) }) throws {
        let id = UUID().uuidString
        let state = IsolatedTestHTTPRegistry.shared.add(id: id, handler: handler)
        self.id = id
        self.state = state
        self.endpoint = try ServerEndpoint(state.origin.absoluteString)
        self.webSockets = IsolatedTestWebSocketFactory(origin: state.origin)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [IsolatedTestURLProtocol.self]
        config.httpAdditionalHeaders = ["X-IAMCEO-Test-Fixture": id]
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 2
        self.session = URLSession(configuration: config)
    }
    var requests: [URLRequest] { state.requests }
    func makeAPIClient(accessCode: String = "fixture-only") -> APIClient {
        APIClient(endpoint: endpoint, accessCode: accessCode, session: session)
    }
    func close() async {
        session.invalidateAndCancel()
        IsolatedTestHTTPRegistry.shared.remove(id)
        await webSockets.close()
    }
    deinit {
        session.invalidateAndCancel()
        IsolatedTestHTTPRegistry.shared.remove(id)
    }
}

/// Implements the W1 transport boundary directly. URLProtocol does not intercept
/// URLSessionWebSocketTask upgrades, so no real WS task/session is created here.
actor IsolatedTestWebSocket: RealtimeTransport {
    private var frames: [Result<Data, URLError>] = []
    private var waiter: (UUID, CheckedContinuation<Data, any Error>)?
    private var closed = false
    private(set) var receiveCount = 0
    private(set) var closeCount = 0
    func receive() async throws -> Data {
        receiveCount += 1
        try Task.checkCancellation()
        guard !closed else { throw URLError(.cancelled) }
        guard waiter == nil else { throw URLError(.cannotLoadFromNetwork) }
        if !frames.isEmpty { return try frames.removeFirst().get() }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in waiter = (id, continuation) }
        } onCancel: {
            Task { await self.cancelReceive(id) }
        }
    }
    private func cancelReceive(_ id: UUID) {
        guard waiter?.0 == id else { return }
        let continuation = waiter?.1
        waiter = nil
        continuation?.resume(throwing: CancellationError())
    }
    func enqueue(_ frame: Result<Data, URLError>) throws {
        guard !closed else { throw URLError(.cancelled) }
        if let (_, continuation) = waiter {
            waiter = nil
            switch frame {
            case .success(let data): continuation.resume(returning: data)
            case .failure(let error): continuation.resume(throwing: error)
            }
        } else { frames.append(frame) }
    }
    func close() async {
        guard !closed else { return }
        closed = true
        closeCount += 1
        frames.removeAll()
        let continuation = waiter?.1
        waiter = nil
        continuation?.resume(throwing: URLError(.cancelled))
    }
}

actor IsolatedTestWebSocketFactory: RealtimeTransportFactory {
    private let origin: URL
    private var sockets: [IsolatedTestWebSocket] = []
    private var stopped = false
    private(set) var requests: [URLRequest] = []
    init(origin: URL) { self.origin = origin }
    func connect(request: URLRequest) async throws -> any RealtimeTransport {
        guard !stopped, let url = request.url, url.scheme == "ws", url.host == origin.host,
              url.port == origin.port, url.port != 7878, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { throw URLError(.unsupportedURL) }
        requests.append(request)
        let socket = IsolatedTestWebSocket()
        sockets.append(socket)
        return socket
    }
    var createdSockets: [IsolatedTestWebSocket] { sockets }
    func close() async {
        stopped = true
        for socket in sockets { await socket.close() }
    }
}

final class IsolatedTestSupportTests: XCTestCase {
    func testRESTFactoryAndCatchAllRefusal() async throws {
        let fixture = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(data: Data("fixture".utf8)) }
        let client = fixture.makeAPIClient()
        let data = try await client.attachmentData(Attachment(url: "/fixture"))
        XCTAssertEqual(data, Data("fixture".utf8))
        XCTAssertEqual(fixture.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-only")
        XCTAssertNotEqual(fixture.endpoint.url.port, 7878)
        // Reserved .invalid URL: even a foreign request is caught and refused.
        do {
            _ = try await fixture.session.data(from: URL(string: "https://fixture-escape.invalid")!)
            XCTFail("Foreign request escaped the fixture")
        } catch let error as URLError { XCTAssertEqual(error.code, .unsupportedURL) }
        await fixture.close()
    }
    func testIndependentHandlersAndDefaultFailure() async throws {
        let first = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(data: Data("one".utf8)) }
        let second = try IsolatedTestNetwork()
        XCTAssertNotEqual(first.endpoint.url, second.endpoint.url)
        do {
            _ = try await second.session.data(from: second.endpoint.url)
            XCTFail("Unconfigured route succeeded")
        } catch let error as URLError { XCTAssertEqual(error.code, .resourceUnavailable) }
        XCTAssertTrue(first.requests.isEmpty)
        XCTAssertEqual(second.requests.count, 1)
        await first.close(); await second.close()
    }
    func testWSFactoryFramesFailureAndCancellation() async throws {
        let fixture = try IsolatedTestNetwork()
        var components = URLComponents(url: fixture.endpoint.url, resolvingAgainstBaseURL: false)!
        components.scheme = "ws"; components.path = "/ws"
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer fixture-only", forHTTPHeaderField: "Authorization")
        let transport = try await fixture.webSockets.connect(request: request)
        let sockets = await fixture.webSockets.createdSockets
        let socket = try XCTUnwrap(sockets.first)
        try await socket.enqueue(.success(Data("hello".utf8)))
        let frame = try await transport.receive()
        XCTAssertEqual(frame, Data("hello".utf8))
        try await socket.enqueue(.failure(URLError(.networkConnectionLost)))
        do { _ = try await transport.receive(); XCTFail("Lost frame succeeded") }
        catch let error as URLError { XCTAssertEqual(error.code, .networkConnectionLost) }
        let waiting = Task { try await transport.receive() }
        while await socket.receiveCount < 3 { await Task.yield() }
        waiting.cancel()
        do { _ = try await waiting.value; XCTFail("Cancelled receive succeeded") } catch {}
        let waitingForClose = Task { try await transport.receive() }
        while await socket.receiveCount < 4 { await Task.yield() }
        await fixture.close()
        do { _ = try await waitingForClose.value; XCTFail("Closed receive succeeded") } catch {}
        let count = await socket.closeCount
        XCTAssertEqual(count, 1)
        do { _ = try await fixture.webSockets.connect(request: request); XCTFail("Closed factory connected") } catch {}
    }
    func testWSForeignOriginRefusedWithoutCreatingATask() async throws {
        let fixture = try IsolatedTestNetwork()
        do {
            _ = try await fixture.webSockets.connect(request: URLRequest(url: URL(string: "wss://fixture-escape.invalid/ws")!))
            XCTFail("Foreign WS connected")
        } catch let error as URLError { XCTAssertEqual(error.code, .unsupportedURL) }
        let sockets = await fixture.webSockets.createdSockets
        XCTAssertTrue(sockets.isEmpty)
        await fixture.close()
    }
}
