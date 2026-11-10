import Foundation
import XCTest
@testable import IAMCEO

/// 보기 연결은 거절이 이어져도 죽지 않고, dispose 한 클라이언트를 다시 써도 앱이 꺼지지 않는다.
@MainActor final class StabnsvcTerminalRetryTests: XCTestCase {
    func testObserveKeepsRetryingSlowlyAfterThreeRefusalsAndRecovers() async throws {
        let refusal = Data(#"{"error":"세션을 처리하는 중이거나 터미널을 열 수 없습니다","code":"TERMINAL_REFUSED"}"#.utf8)
        let network = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 409, data: refusal) }
        var receives = 0, pauses: [Double] = [], statesAtSlowRetry: [TerminalStreamState] = []
        var observed: TerminalStreamClient?
        let client = TerminalStreamClient(session: network.session, receiveMessage: { _ in
            receives += 1
            if receives <= 5 { throw APIError(status: 409, message: "refused") }
            if receives == 6 { return .string(#"{"type":"ready","mode":"observe","cols":100,"rows":30}"#) }
            try await Task.sleep(for: .seconds(3600)) // 연결 유지: dispose 가 취소한다
            throw CancellationError()
        }, retryPause: { delay in
            pauses.append(delay)
            if delay == TerminalStreamClient.refusedRetryDelay, let state = observed?.state { statesAtSlowRetry.append(state) }
        })
        observed = client
        let live = expectation(description: "observe attaches once the refusals stop")
        client.onReady = { _ in live.fulfill() }
        client.connect(api: network.makeAPIClient(), memberID: "m", mode: .observe)
        await fulfillment(of: [live], timeout: 5)
        // 1·2초 뒤에도 거절이면 안내를 보인 채 30초 간격으로 계속 붙어 본다(예전에는 여기서 영구 중단).
        XCTAssertEqual(pauses, [1, 2, 30, 30, 30])
        XCTAssertGreaterThanOrEqual(receives, 6)
        XCTAssertEqual(statesAtSlowRetry, Array(repeating: TerminalStreamState.closed(reason: "refused", message: "세션을 처리하는 중이거나 터미널을 열 수 없습니다"), count: 3))
        XCTAssertEqual(client.state, .live(mode: .observe, cols: 100, rows: 30))
        observed = nil
        client.dispose()
        await network.close()
    }

    func testConnectAfterDisposeUsesAFreshSessionInsteadOfTheInvalidatedOne() async throws {
        let network = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 503) }
        var receives = 0
        let client = TerminalStreamClient(session: URLSession(configuration: .ephemeral), receiveMessage: { _ in
            receives += 1
            if receives == 1 { return .string(#"{"type":"ready","mode":"observe","cols":80,"rows":24}"#) }
            try await Task.sleep(for: .seconds(3600))
            throw CancellationError()
        })
        client.dispose()
        // 무효화된 세션에 태스크를 만들면 NSException 으로 프로세스가 죽는다. 새 세션을 만들어야 한다.
        let live = expectation(description: "attaches after dispose")
        client.onReady = { _ in live.fulfill() }
        client.connect(api: network.makeAPIClient(), memberID: "m", mode: .observe)
        await fulfillment(of: [live], timeout: 5)
        XCTAssertEqual(client.state, .live(mode: .observe, cols: 80, rows: 24))
        client.dispose()
        await network.close()
    }

    func testRefusedObserveReopensWhenTheOwnerReturnsOrTheMemberChanges() async throws {
        let server = WriteTestServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "test"
        await store.connect(); store.setForeground(false)
        let member = try XCTUnwrap(store.members.first)
        var observes = 0
        let session = TerminalSession(platform: .mac, connect: { _, _, mode, _, _, _, _ in if mode == .observe { observes += 1 } })
        session.appear(store: store, member: member, active: true)
        XCTAssertEqual(observes, 1)
        // 붙어 있는 동안에는 건드리지 않는다.
        session.client.accept(.ready(mode: .observe, cols: 100, rows: 30, expiresAt: nil))
        session.setActive(false, store: store, member: member); session.setActive(true, store: store, member: member)
        var ready = member; ready.paneId = "pane-2"; ready.status = "working"
        session.memberChanged(store: store, member: ready)
        XCTAssertEqual(observes, 1)
        // 거절로 멈춘 뒤 Mac 유예 중에 돌아오면(active 는 그대로) 바로 다시 붙는다.
        session.client.accept(.closed(reason: "refused", message: "세션을 처리하는 중입니다"))
        session.setActive(false, store: store, member: member)
        XCTAssertEqual(observes, 1)
        session.setActive(true, store: store, member: member)
        XCTAssertEqual(observes, 2)
        // 직원 상태·pane 이 바뀌어도 다시 붙는다.
        session.memberChanged(store: store, member: ready)
        XCTAssertEqual(observes, 3)
        // 다른 이유로 닫힌 연결(직접 닫음)은 그대로 둔다.
        session.client.close()
        session.setActive(true, store: store, member: member)
        session.memberChanged(store: store, member: ready)
        XCTAssertEqual(observes, 3)
        session.disappear(store: store, member: member); store.disconnect()
        await network.close()
    }
}
