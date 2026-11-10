import Foundation
import XCTest
@testable import IAMCEO

private actor TestRealtimeClock: RealtimeClock {
    var time: Duration = .zero
    func now() -> Duration { time }
    func advance(_ seconds: Int) { time += .seconds(seconds) }
    func sleep(for duration: Duration) async throws { try await Task.sleep(for: .milliseconds(1)) }
}

private actor TestRealtimeSocket: RealtimeTransport {
    var queue: [Data] = []
    var waiter: TestDeadlineContinuation<Data, Error>?
    var closed = false
    var closes = 0
    var receives = 0
    var concurrent = 0
    var maximumConcurrent = 0
    var holdClose = false
    var closeWaiter: TestDeadlineContinuation<Void, Never>?
    func receive() async throws -> Data {
        receives += 1; concurrent += 1; maximumConcurrent = max(maximumConcurrent, concurrent)
        defer { concurrent -= 1 }
        if closed { throw CancellationError() }
        if !queue.isEmpty { return queue.removeFirst() }
        return try await withThrowingTestDeadline { waiter = $0 }
    }
    func send(_ text: String) { send(Data(text.utf8)) }
    func send(_ data: Data) {
        if let waiter { self.waiter = nil; waiter.resume(returning: data) }
        else { queue.append(data) }
    }
    func holdNextClose() { holdClose = true }
    func releaseClose() { holdClose = false; closeWaiter?.resume(); closeWaiter = nil }
    func close() async {
        closes += 1; closed = true
        waiter?.resume(throwing: CancellationError()); waiter = nil
        if holdClose { await withTestDeadline(fallback: ()) { closeWaiter = $0 } }
    }
}

private actor TestRealtimeFactory: RealtimeTransportFactory {
    var sockets: [TestRealtimeSocket]
    var requests: [URLRequest] = []
    init(_ socket: TestRealtimeSocket) { sockets = [socket] }
    init(sockets: [TestRealtimeSocket]) { self.sockets = sockets }
    func connect(request: URLRequest) -> any RealtimeTransport { requests.append(request); return sockets.removeFirst() }
}

private actor DelayedRealtimeFactory: RealtimeTransportFactory {
    let socket = TestRealtimeSocket()
    var waiter: TestDeadlineContinuation<Void, Never>?
    func connect(request: URLRequest) async -> any RealtimeTransport {
        await withTestDeadline(fallback: ()) { waiter = $0 }
        return socket
    }
    func release() { waiter?.resume(); waiter = nil }
}

@MainActor
final class RealtimeTests: XCTestCase {
    private let hello = #"{"type":"hello","protocol":2,"epoch":"epoch","seq":0,"heartbeatMs":15000,"staleAfterMs":45000}"#
    private func api() throws -> APIClient { APIClient(endpoint: try ServerEndpoint("https://fixture.invalid:4443"), accessCode: "fixture-code") }
    private func eventually(_ predicate: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<1000 {
            if await predicate() { return }
            try? await Task.sleep(for: .milliseconds(1))
        }
        XCTFail("Condition did not settle", file: file, line: line)
    }

    func testSingleReceiveAndHeaderOnlyFactoryRequest() async throws {
        let socket = TestRealtimeSocket(); let factory = TestRealtimeFactory(socket)
        let client = RealtimeClient(factory: factory)
        let stream = try await client.connect(api: api())
        await socket.send(hello)
        await socket.send(#"{"type":"ping","epoch":"epoch","seq":0}"#)
        await socket.send(#"{"type":"future_event","epoch":"epoch","seq":1}"#)
        var iterator = stream.makeAsyncIterator()
        let first = try await iterator.next(); let second = try await iterator.next(); let third = try await iterator.next()
        XCTAssertEqual(first?.type, "hello"); XCTAssertEqual(second?.type, "ping"); XCTAssertEqual(third?.cursor?.seq, 1)
        await client.disconnect()
        let maximum = await socket.maximumConcurrent; let closes = await socket.closes
        XCTAssertEqual(maximum, 1); XCTAssertEqual(closes, 1)
        let request = await factory.requests.first
        XCTAssertEqual(request?.url?.absoluteString, "wss://fixture.invalid:4443/ws?v=2")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-code")
    }

    func testHelloAnd45SecondWatchdogUseInjectedMonotonicClock() async throws {
        let clock = TestRealtimeClock(); let socket = TestRealtimeSocket()
        let client = RealtimeClient(factory: TestRealtimeFactory(socket), clock: clock)
        let stream = try await client.connect(api: api())
        await socket.send(hello)
        var iterator = stream.makeAsyncIterator()
        _ = try await iterator.next()
        await clock.advance(44)
        await socket.send(#"{"type":"ping","epoch":"epoch","seq":0}"#)
        _ = try await iterator.next()
        await clock.advance(44)
        try await Task.sleep(for: .milliseconds(5))
        let before = await socket.closes; XCTAssertEqual(before, 0)
        await clock.advance(1)
        do { _ = try await iterator.next(); XCTFail("Stale socket must fail") }
        catch { XCTAssertEqual(error as? RealtimeClientError, .stale) }
        await eventually { await socket.closes == 1 }
    }

    func testMissingHelloTimesOutAndBadFramesDoNotKeepAlive() async throws {
        let clock = TestRealtimeClock(); let socket = TestRealtimeSocket()
        let client = RealtimeClient(factory: TestRealtimeFactory(socket), clock: clock)
        let stream = try await client.connect(api: api())
        // 서버가 바빠 hello 가 십수 초 늦을 수 있다. 20초까지 기다린다(예전 10초).
        XCTAssertEqual(RealtimeClient.helloTimeoutSeconds, 20)
        await clock.advance(20)
        var iterator = stream.makeAsyncIterator()
        do { _ = try await iterator.next(); XCTFail("No hello") }
        catch { XCTAssertEqual(error as? RealtimeClientError, .helloTimeout) }
        let other = TestRealtimeSocket(); let invalid = RealtimeClient(factory: TestRealtimeFactory(other))
        let bad = try await invalid.connect(api: api())
        await other.send(#"{"type":"ping"}"#)
        var badIterator = bad.makeAsyncIterator()
        do { _ = try await badIterator.next(); XCTFail("First frame must be hello") }
        catch { XCTAssertEqual(error as? RealtimeClientError, .invalidFrame) }
    }

    func testCancellationClosesPendingReceiveAndNoReconnectIsStarted() async throws {
        let socket = TestRealtimeSocket(); let factory = TestRealtimeFactory(socket)
        let client = RealtimeClient(factory: factory)
        let stream = try await client.connect(api: api())
        let consumer = Task { for try await _ in stream {} }
        await eventually { await socket.receives == 1 }
        consumer.cancel()
        _ = await consumer.result
        await eventually { await socket.closes == 1 }
        let requests = await factory.requests.count; XCTAssertEqual(requests, 1)
    }

    func testLegacyAndProtocolMixingAndOversizedFrames() async throws {
        let legacy = TestRealtimeSocket(); let client = RealtimeClient(factory: TestRealtimeFactory(legacy))
        let stream = try await client.connect(api: api(), version: 1)
        await legacy.send(#"{"type":"hello","seq":3}"#); await legacy.send(#"{"type":"ping"}"#)
        await legacy.send(#"{"type":"ping","epoch":"epoch","seq":3}"#)
        var iterator = stream.makeAsyncIterator()
        let hello = try await iterator.next(); let ping = try await iterator.next()
        XCTAssertNil(hello?.cursor); XCTAssertEqual(ping?.type, "ping")
        do { _ = try await iterator.next(); XCTFail("Protocol mixing") }
        catch { XCTAssertEqual(error as? RealtimeClientError, .invalidFrame) }
        let socket = TestRealtimeSocket(); let large = RealtimeClient(factory: TestRealtimeFactory(socket))
        let frames = try await large.connect(api: api())
        await socket.send(Data(repeating: 0x20, count: RealtimeClient.maximumMessageSize + 1))
        var largeIterator = frames.makeAsyncIterator()
        do { _ = try await largeIterator.next(); XCTFail("Frame limit") }
        catch { XCTAssertEqual(error as? RealtimeClientError, .messageTooLarge) }
    }

    func testLateFactoryResultAfterTimeoutIsClosedWithoutReceiving() async throws {
        let factory = DelayedRealtimeFactory(); let clock = TestRealtimeClock()
        let client = RealtimeClient(factory: factory, clock: clock)
        let stream = try await client.connect(api: api())
        await eventually { await factory.waiter != nil }
        await clock.advance(20)
        var iterator = stream.makeAsyncIterator()
        do { _ = try await iterator.next(); XCTFail("Connect timeout") }
        catch { XCTAssertEqual(error as? RealtimeClientError, .helloTimeout) }
        await factory.release()
        let socket = factory.socket
        await eventually { await socket.closes == 1 }
        let receives = await socket.receives; XCTAssertEqual(receives, 0)
    }

    func testCompetingConnectDuringOldCloseCannotReplaceNewGeneration() async throws {
        let old = TestRealtimeSocket(); let next = TestRealtimeSocket()
        let factory = TestRealtimeFactory(sockets: [old, next]); let client = RealtimeClient(factory: factory)
        let first = try await client.connect(api: api())
        await old.send(hello)
        var firstIterator = first.makeAsyncIterator(); _ = try await firstIterator.next()
        await old.holdNextClose()
        let api = try api()
        let superseded = Task { try await client.connect(api: api) }
        await eventually { await old.closeWaiter != nil }
        let current = try await client.connect(api: api)
        await next.send(hello)
        var currentIterator = current.makeAsyncIterator(); _ = try await currentIterator.next()
        await old.releaseClose()
        do { _ = try await superseded.value; XCTFail("Old connect must be cancelled") }
        catch { XCTAssertTrue(error is CancellationError) }
        await next.send(#"{"type":"ping","epoch":"epoch","seq":0}"#)
        let ping = try await currentIterator.next(); XCTAssertEqual(ping?.type, "ping")
        let requests = await factory.requests.count; XCTAssertEqual(requests, 2)
        await client.disconnect()
    }

    func testSlowConsumerCannotAccumulateUnboundedEvents() async throws {
        let socket = TestRealtimeSocket(); let client = RealtimeClient(factory: TestRealtimeFactory(socket))
        let stream = try await client.connect(api: api())
        await socket.send(hello)
        for _ in 0..<256 { await socket.send(#"{"type":"ping","epoch":"epoch","seq":0}"#) }
        await eventually { await socket.closes == 1 }
        do { for try await _ in stream {}; XCTFail("Consumer overflow must fail") }
        catch { XCTAssertEqual(error as? RealtimeClientError, .consumerTooSlow) }
    }

    /// n-net-6: 본문만 읽지 못한 변경 프레임은 봉투(type·순번)를 살려 넘긴다. 봉투가 깨졌거나 본문이 없는 종류는 여전히 잘못된 프레임이다.
    func testUnreadablePayloadSurvivesAsItsEnvelopeButABrokenEnvelopeDoesNot() async throws {
        let socket = TestRealtimeSocket(); let client = RealtimeClient(factory: TestRealtimeFactory(socket))
        let stream = try await client.connect(api: api())
        await socket.send(hello)
        await socket.send(#"{"type":"member","epoch":"epoch","seq":1,"member":{"projectId":"p","status":7}}"#)
        await socket.send(#"{"type":"decision","epoch":"epoch","seq":2}"#)
        await socket.send(#"{"type":"ping","epoch":"epoch","seq":2}"#)
        await socket.send(#"{"type":"member","epoch":"","seq":3,"member":{"id":"m"}}"#)
        var iterator = stream.makeAsyncIterator()
        _ = try await iterator.next()
        let member = try await iterator.next()
        XCTAssertEqual(member?.type, "member"); XCTAssertEqual(member?.cursor?.seq, 1)
        XCTAssertEqual(member?.payloadUnreadable, true); XCTAssertNil(member?.member)
        let decision = try await iterator.next()
        XCTAssertEqual(decision?.cursor?.seq, 2); XCTAssertEqual(decision?.payloadUnreadable, true)
        let ping = try await iterator.next()
        XCTAssertEqual(ping?.type, "ping"); XCTAssertEqual(ping?.payloadUnreadable, false)
        do { _ = try await iterator.next(); XCTFail("A broken envelope must end the stream") }
        catch { XCTAssertEqual(error as? RealtimeClientError, .invalidFrame) }
    }

    func testUnreadableEnvelopeRulesMatchTheStrictDecoder() {
        func envelope(_ text: String) -> RealtimeEvent? { RealtimeEvent.unreadable(from: Data(text.utf8)) }
        XCTAssertEqual(envelope(#"{"type":"todo","epoch":"e","seq":4,"todo":7}"#)?.cursor?.seq, 4)
        XCTAssertNil(envelope(#"{"type":"todo","todo":7}"#)?.cursor, "A legacy frame has no cursor")
        XCTAssertNotNil(envelope(#"{"type":"todo","todo":7}"#))
        for broken in [#"{"type":"hello","seq":1}"#, #"{"type":"ping","epoch":"e"}"#, #"{"type":"future","epoch":"e","seq":1}"#,
                       #"{"type":"todo","epoch":"e","seq":-1}"#, #"{"type":"todo","epoch":"e"}"#, #"{"type":"todo","seq":3}"#,
                       #"{"type":"todo","protocol":2,"epoch":"e","seq":1}"#, #"{"todo":{}}"#, "not json"] {
            XCTAssertNil(envelope(broken), broken)
        }
    }
}
