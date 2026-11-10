import Foundation

protocol RealtimeClock: Sendable {
    func now() async -> Duration
    func sleep(for duration: Duration) async throws
}

struct SystemRealtimeClock: RealtimeClock {
    func now() async -> Duration { .seconds(ProcessInfo.processInfo.systemUptime) }
    func sleep(for duration: Duration) async throws { try await Task.sleep(for: duration) }
}

enum RealtimeClientError: Error, Equatable {
    case helloTimeout, stale, invalidFrame, messageTooLarge, consumerTooSlow, restarting
    static func forCloseCode(_ code: Int) -> Self? { code == 1012 ? .restarting : nil }
}

private final class RealtimeRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Each socket owns a session. Closing it also invalidates the session; reconnect creates a new one.
struct URLSessionRealtimeTransportFactory: RealtimeTransportFactory {
    func connect(request: URLRequest) async throws -> any RealtimeTransport {
        try Task.checkCancellation()
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = RealtimeClient.helloTimeoutSeconds
        config.timeoutIntervalForResource = 0
        let session = URLSession(configuration: config, delegate: RealtimeRedirectDelegate(), delegateQueue: nil)
        var request = request
        request.timeoutInterval = RealtimeClient.helloTimeoutSeconds
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = RealtimeClient.maximumMessageSize
        task.resume()
        return URLSessionRealtimeTransport(session: session, task: task)
    }
}

private actor URLSessionRealtimeTransport: RealtimeTransport {
    let session: URLSession
    let task: URLSessionWebSocketTask
    init(session: URLSession, task: URLSessionWebSocketTask) { self.session = session; self.task = task }
    func receive() async throws -> Data {
        do {
            switch try await task.receive() {
            case .data(let data): return data
            case .string(let text): return Data(text.utf8)
            @unknown default: throw RealtimeClientError.invalidFrame
            }
        } catch {
            if let reason = RealtimeClientError.forCloseCode(task.closeCode.rawValue) { throw reason }
            throw error
        }
    }
    func close() async {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }
}

/// Transport only: the host coordinator owns cursor reconciliation, snapshots and reconnect policy.
actor RealtimeClient {
    static let maximumMessageSize = 16 * 1024 * 1024
    /// 연결과 첫 hello 를 기다리는 시간. 서버 루프가 십수 초 막히는 동안 10초에 끊으면 붙을 때마다 다시 끊겨 '연결 중'이 풀리지 않는다.
    /// 살아 있는 연결의 무응답 판정(45초)보다는 짧게 둔다.
    static let helloTimeoutSeconds: TimeInterval = 20
    private let factory: any RealtimeTransportFactory
    private let clock: any RealtimeClock
    private var generation = UUID()
    private var transport: (any RealtimeTransport)?
    private var receiver: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var continuation: AsyncThrowingStream<RealtimeEvent, Error>.Continuation?
    private var lastMessage: Duration = .zero
    private var receivedHello = false
    private var version2 = false

    init(factory: any RealtimeTransportFactory = URLSessionRealtimeTransportFactory(), clock: any RealtimeClock = SystemRealtimeClock()) {
        self.factory = factory; self.clock = clock
    }

    /// Only APIClient may construct the authenticated, origin-checked request.
    func connect(api: APIClient, version: Int = 2) async throws -> AsyncThrowingStream<RealtimeEvent, Error> {
        let old = reset()
        let id = generation
        await old?.close()
        guard id == generation else { throw CancellationError() }
        let request = try await api.webSocketRequest(version: version)
        try Task.checkCancellation()
        guard id == generation else { throw CancellationError() }
        lastMessage = await clock.now()
        guard id == generation else { throw CancellationError() }
        let (stream, sink) = AsyncThrowingStream<RealtimeEvent, Error>.makeStream(bufferingPolicy: .bufferingOldest(256))
        continuation = sink
        sink.onTermination = { [weak self] _ in Task { await self?.stop(id: id) } }
        receiver = Task { await self.receive(request: request, id: id) }
        watchdog = Task { await self.watch(id: id) }
        return stream
    }

    func disconnect() async { let old = reset(); await old?.close() }

    private func stop(id: UUID, error: (any Error)? = nil) async {
        guard id == generation else { return }
        let old = reset(error: error)
        await old?.close()
    }

    /// Invalidate synchronously before any close await, including competing connect calls.
    private func reset(error: (any Error)? = nil) -> (any RealtimeTransport)? {
        generation = UUID()
        receiver?.cancel(); watchdog?.cancel()
        receiver = nil; watchdog = nil
        let old = transport
        transport = nil
        let sink = continuation
        continuation = nil
        receivedHello = false; version2 = false
        if let error { sink?.finish(throwing: error) } else { sink?.finish() }
        return old
    }

    private func receive(request: URLRequest, id: UUID) async {
        do {
            let socket = try await factory.connect(request: request)
            guard id == generation, !Task.isCancelled else { await socket.close(); return }
            transport = socket
            while !Task.isCancelled {
                let data = try await socket.receive()
                guard id == generation, !Task.isCancelled else { return }
                guard data.count <= Self.maximumMessageSize else { throw RealtimeClientError.messageTooLarge }
                let event: RealtimeEvent
                do { event = try JSONDecoder().decode(RealtimeEvent.self, from: data) }
                catch {
                    ContractLog.unreadable("realtime frame", error)
                    // 본문만 읽지 못한 변경 프레임 하나 때문에 연결을 끊지 않는다. 끊으면 같은 종류의 이벤트가 올 때마다 다시 붙는다.
                    guard receivedHello, let unread = RealtimeEvent.unreadable(from: data) else { throw RealtimeClientError.invalidFrame }
                    event = unread
                }
                guard !event.type.isEmpty else { throw RealtimeClientError.invalidFrame }
                // Restart announcements are control frames, including before hello and without a cursor.
                if event.type == "restarting" { throw RealtimeClientError.restarting }
                if !receivedHello {
                    guard event.type == "hello" else { throw RealtimeClientError.invalidFrame }
                    receivedHello = true
                    version2 = event.protocolVersion == 2
                } else {
                    guard event.type != "hello", (event.cursor != nil) == version2,
                          event.protocolVersion == nil else { throw RealtimeClientError.invalidFrame }
                    if !version2 && !Self.legacyTypes.contains(event.type) { throw RealtimeClientError.invalidFrame }
                }
                lastMessage = await clock.now()
                guard id == generation, !Task.isCancelled else { return }
                if case .dropped = continuation?.yield(event) { throw RealtimeClientError.consumerTooSlow }
            }
        } catch {
            // Never expose URLSession errors containing authenticated requests or URLs.
            let safe = (error as? RealtimeClientError) ?? APIError(status: (error as? APIError)?.status ?? 0, message: "실시간 연결이 끊겼습니다.") as any Error
            await stop(id: id, error: safe)
        }
    }

    private static let legacyTypes: Set<String> = ["ping", "projects", "project", "member", "member_removed", "decision", "todo", "work", "message", "file", "activity", "settings", "herdr"]

    private func watch(id: UUID) async {
        do {
            while id == generation, !Task.isCancelled {
                let now = await clock.now()
                guard id == generation, !Task.isCancelled else { return }
                let remaining = lastMessage + (receivedHello ? .seconds(45) : .seconds(Self.helloTimeoutSeconds)) - now
                if remaining <= .zero {
                    await stop(id: id, error: receivedHello ? RealtimeClientError.stale : RealtimeClientError.helloTimeout)
                    return
                }
                try await clock.sleep(for: remaining)
            }
        } catch { /* Cancellation ends the only watchdog. */ }
    }
}
