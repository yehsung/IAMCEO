import Foundation
import XCTest
@testable import IAMCEO

struct IsolatedTestHTTPReply: Sendable {
    var status: Int = 200
    var data: Data = Data("{}".utf8)
    var headers: [String: String] = ["Content-Type": "application/json"]
    var beforeDelivery: (@Sendable () async -> Void)? = nil
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
            if let beforeDelivery = reply.beforeDelivery {
                Task { @Sendable [self, reply, beforeDelivery] in
                    await beforeDelivery()
                    self.deliver(reply)
                }
            } else { deliver(reply) }
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    private func deliver(_ reply: IsolatedTestHTTPReply) {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
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
        Self.stop(session, id: id)
        await webSockets.close()
    }
    deinit { Self.stop(session, id: id) }
    /// 시험이 끝난 뒤에도 AppStore 가 띄운 작업(예: 연결을 끊을 때 터미널 조작권 놓기)이 이 세션으로 요청할 수 있다.
    /// 무효화(invalidateAndCancel)한 세션에 새 요청을 만들면 NSException 으로 시험 프로세스가 죽는다(iPhone 시뮬레이터에서
    /// 실제로 났다). 그래서 무효화하지 않고 진행 중인 요청만 끊고 등록을 지운다. 늦은 요청은 IsolatedTestURLProtocol 에서
    /// 실패하고, 바깥 네트워크로는 여전히 나가지 않는다.
    private static func stop(_ session: URLSession, id: String) {
        IsolatedTestHTTPRegistry.shared.remove(id)
        session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
    }
}

/// Implements the W1 transport boundary directly. URLProtocol does not intercept
/// URLSessionWebSocketTask upgrades, so no real WS task/session is created here.
actor IsolatedTestWebSocket: RealtimeTransport {
    private var frames: [Result<Data, any Error>] = []
    private var waiter: (UUID, TestDeadlineContinuation<Data, any Error>)?
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
            try await withThrowingTestDeadline { continuation in waiter = (id, continuation) }
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
    func enqueue(_ frame: Result<Data, any Error>) throws {
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
        let receiveDeadline = ContinuousClock.now + .seconds(3)
        while await socket.receiveCount < 3 && ContinuousClock.now < receiveDeadline { await Task.yield() }
        let received = await socket.receiveCount
        XCTAssertGreaterThanOrEqual(received, 3)
        waiting.cancel()
        do { _ = try await waiting.value; XCTFail("Cancelled receive succeeded") } catch {}
        let waitingForClose = Task { try await transport.receive() }
        let closeDeadline = ContinuousClock.now + .seconds(3)
        while await socket.receiveCount < 4 && ContinuousClock.now < closeDeadline { await Task.yield() }
        let receivedBeforeClose = await socket.receiveCount
        XCTAssertGreaterThanOrEqual(receivedBeforeClose, 4)
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


// A task-group timeout cannot escape a child suspended on a continuation. Resolve
// the continuation itself, once, so failed test preconditions cannot strand a gate.
enum TestDeadlineError: Error { case expired }
final class TestDeadlineContinuation<Value: Sendable, Failure: Error>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Failure>?
    private var watchdog: Task<Void, Never>?
    init(_ continuation: CheckedContinuation<Value, Failure>, timeout: Result<Value, Failure>,
         file: StaticString, line: UInt) {
        self.continuation = continuation
        watchdog = Task { [self] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            if let continuation = take() {
                XCTFail("Fixture continuation timed out after 10 seconds", file: file, line: line)
                continuation.resume(with: timeout)
            }
        }
    }
    private func take() -> CheckedContinuation<Value, Failure>? {
        lock.withLock {
            defer { continuation = nil; watchdog?.cancel(); watchdog = nil }
            return continuation
        }
    }
    func resume(with result: Result<Value, Failure>) { take()?.resume(with: result) }
    func resume(returning value: Value) { resume(with: .success(value)) }
    func resume(throwing error: Failure) { resume(with: .failure(error)) }
}
extension TestDeadlineContinuation where Value == Void {
    func resume() { resume(returning: ()) }
}
func withTestDeadline<Value: Sendable>(fallback: Value, isolation: isolated (any Actor)? = #isolation,
    file: StaticString = #filePath, line: UInt = #line,
    _ body: (TestDeadlineContinuation<Value, Never>) -> Void) async -> Value {
    await withCheckedContinuation(isolation: isolation) { continuation in
        body(TestDeadlineContinuation(continuation, timeout: .success(fallback), file: file, line: line))
    }
}
func withThrowingTestDeadline<Value: Sendable>(isolation: isolated (any Actor)? = #isolation,
    file: StaticString = #filePath, line: UInt = #line,
    _ body: (TestDeadlineContinuation<Value, Error>) -> Void) async throws -> Value {
    try await withCheckedThrowingContinuation(isolation: isolation) { continuation in
        body(TestDeadlineContinuation(continuation, timeout: .failure(TestDeadlineError.expired), file: file, line: line))
    }
}

/// 조건이 풀릴 때까지 기다린다. 기한을 넘기면 조용히 다음 줄로 넘어가지 않고 그 자리에서 실패한다
/// (예전 `for _ in 0..<200 where 조건 { sleep 10ms }`는 2초 뒤 그냥 지나가 엉뚱한 단언에서 실패했다).
@MainActor func waitWhile(_ busy: @MainActor () -> Bool, timeout: Duration = .seconds(10),
                          file: StaticString = #filePath, line: UInt = #line) async throws {
    let deadline = ContinuousClock.now + timeout
    while busy() {
        guard ContinuousClock.now < deadline else {
            XCTFail("Condition did not settle within \(timeout)", file: file, line: line)
            throw TestDeadlineError.expired
        }
        try await Task.sleep(for: .milliseconds(5))
    }
}

/// 대기 시간을 실제로 흘려보내지 않는 가짜 대기. 요청된 시간을 기록하고, 시험이 fire() 할 때 깨어난다.
@MainActor final class ManualPause {
    private(set) var requested: [Duration] = []
    private var pending: [UUID: CheckedContinuation<Void, any Error>] = [:]
    var waiting: Int { pending.count }
    func pause(_ duration: Duration) async throws {
        requested.append(duration)
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) } else { pending[id] = continuation }
            }
        } onCancel: {
            Task { @MainActor in self.pending.removeValue(forKey: id)?.resume(throwing: CancellationError()) }
        }
    }
    func fire() {
        let all = pending; pending = [:]
        all.values.forEach { $0.resume() }
    }
}
