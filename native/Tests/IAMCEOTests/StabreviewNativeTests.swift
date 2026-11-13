import Foundation
import XCTest
@testable import IAMCEO

/// 대화 쪽과 활동 목록의 응답을 시험이 정하는 서버. 나머지는 CoordinatorServer가 답한다.
private final class ReviewFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var _page: [Message] = []
    private var _pageReads = 0
    private var _activity: [Activity] = []
    let base = CoordinatorServer()
    let mode = StabSwitch()
    var page: [Message] { get { lock.withLock { _page } } set { lock.withLock { _page = newValue } } }
    var pageReads: Int { lock.withLock { _pageReads } }
    var activity: [Activity] { get { lock.withLock { _activity } } set { lock.withLock { _activity = newValue } } }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        switch request.url!.path {
        case "/api/projects/p/messages/page":
            let items = lock.withLock { _pageReads += 1; return _page }
            let page = MessagePage(projectId: "p", scope: .project, items: items, nextCursor: nil, hasOlder: false)
            return IsolatedTestHTTPReply(data: try JSONEncoder().encode(page))
        case "/api/members/m/activity":
            // 응답 내용은 요청이 닿은 때의 목록이다. 잡아 둔 동안 생긴 활동은 들어 있지 않다.
            return mode.apply(request, to: IsolatedTestHTTPReply(data: try JSONEncoder().encode(activity)))
        default: return try base.handle(request)
        }
    }
}

private final class ReviewFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var _on = false
    var on: Bool { get { lock.withLock { _on } } set { lock.withLock { _on = newValue } } }
}

/// 배포 전 검토(review:native-state, review:native-views)에서 찾은 문제의 회귀 시험.
@MainActor final class StabreviewNativeTests: XCTestCase {
    // 공용 pollUntil(TestSupport)을 부르는 얇은 껍데기. 기한은 느린 CI 러너에 맞춘 공용 기본값(10초)을 쓴다.
    private func eventually(_ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        await pollUntil("State did not settle", file: file, line: line, condition)
    }
    private func settle() async { for _ in 0..<30 { await Task.yield() }; try? await Task.sleep(for: .milliseconds(10)) }
    private func frame(_ socket: IsolatedTestWebSocket, _ text: String) async throws { try await socket.enqueue(.success(Data(text.utf8))) }
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("stab-review-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    /// 실시간 소켓까지 붙은 저장소.
    private func live(_ network: IsolatedTestNetwork, _ clock: CoordinatorClock, _ factory: CoordinatorSockets) async throws -> (AppStore, IsolatedTestWebSocket)? {
        let store = AppStore(session: network.session, persistCredentials: false,
                             realtime: RealtimeClient(factory: factory, clock: clock), clock: clock, retryJitter: { $0 })
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect()
        await eventually { await factory.sockets.count == 1 }
        guard let socket = await factory.sockets.first else {
            XCTFail("Expected the initial coordinator socket")
            store.disconnect()
            return nil
        }
        try await frame(socket, #"{"type":"hello","protocol":2,"epoch":"E","seq":0,"heartbeatMs":15000,"staleAfterMs":45000}"#)
        await eventually { store.realtimeStatus == .syncing || store.realtimeStatus == .live }
        await settleAndAdvance(clock, .milliseconds(500))
        await eventually { store.realtimeStatus == .live }
        XCTAssertTrue(store.canWrite)
        return (store, socket)
    }
    /// 실시간 없이 쓰기만 하는 저장소(주기 읽기는 멈춰 둔다).
    private func plain(_ network: IsolatedTestNetwork, root: URL? = nil) async throws -> AppStore {
        let store: AppStore
        if let root {
            store = AppStore(session: network.session, persistCredentials: false,
                             submissions: try SubmissionStore(storageURL: root.appendingPathComponent("submissions")),
                             writeStorageURL: root.appendingPathComponent("journal"))
        } else {
            store = AppStore(session: network.session, persistCredentials: false)
        }
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect(); store.setForeground(false)
        XCTAssertTrue(store.canWrite)
        return store
    }
    private func memberEvent(seq: Int, status: String) throws -> String {
        var member = Member(id: "m", projectId: "p"); member.status = status
        let json = String(decoding: try JSONEncoder().encode(member), as: UTF8.self)
        return "{\"type\":\"member\",\"epoch\":\"E\",\"seq\":\(seq),\"member\":\(json)}"
    }

    // MARK: native-state-1 — 전달을 기다리는 글의 대기 사유가 처음 값에서 멈추지 않는다

    func testMemberEventRereadsTheConversationWhileMyInstructionIsStillWaiting() async throws {
        let fixture = ReviewFixture(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: fixture.handle)
        guard let (store, socket) = try await live(network, clock, factory) else { return }
        defer { store.disconnect() }
        func instruction(_ reason: String?, delivery: String = "queued", revision: Int = 1) -> Message {
            Message(id: "w", projectId: "p", at: "2026-11-11T00:00:00.000Z", mine: true, body: "지시", targetMemberId: "m",
                    deliveryInfo: [MessageDeliveryInfo(deliveryId: "d", memberId: "m", waitReason: reason)],
                    delivery: delivery, deliveryRevision: revision)
        }
        func reasons() -> [String] { store.historyMessages.first.map { ChatDeliveryWait.lines($0, target: nil).map(\.reason) } ?? [] }
        func member(_ seq: Int, _ status: String) async throws {
            fixture.base.change { $0.seq = seq }
            try await frame(socket, memberEvent(seq: seq, status: status))
            await eventually { store.receivedCursor?.seq == seq }
            // 이벤트가 부르는 읽기는 묶음 창(250ms)과 직전 읽기와의 간격을 기다린다. 조정자의 시계를 그만큼 민다.
            for _ in 0..<20 where store.appliedSnapshotCursor?.seq != seq {
                await settleAndAdvance(clock, .milliseconds(250))
                for _ in 0..<50 where store.appliedSnapshotCursor?.seq != seq { try? await Task.sleep(for: .milliseconds(2)) }
            }
            XCTAssertEqual(store.appliedSnapshotCursor?.seq, seq)
            await settle()
        }
        fixture.page = [instruction("member_busy")]
        await store.activateHistory()
        XCTAssertEqual(reasons(), ["member_busy"])

        // 직원이 승인 창에 걸렸다. 서버는 member 이벤트만 보내고, 글의 전달 판 번호도 그대로다.
        fixture.page = [instruction("approval")]
        var reads = fixture.pageReads
        try await member(1, "blocked")
        await eventually { reasons() == ["approval"] }
        XCTAssertEqual(fixture.pageReads, reads + 1, "기다리는 글이 보이는 동안에는 대화를 다시 읽어 대기 사유를 맞춘다")

        // 지시가 전달됐다.
        fixture.page = [instruction(nil, delivery: "delivered", revision: 2)]
        reads = fixture.pageReads
        try await member(2, "working")
        await eventually { store.historyMessages.first?.delivery == "delivered" }
        XCTAssertEqual(reasons(), [])
        XCTAssertEqual(fixture.pageReads, reads + 1)

        // 기다리는 글이 없으면 직원 상태가 바뀌어도 대화를 다시 읽지 않는다.
        reads = fixture.pageReads
        try await member(3, "idle")
        try await member(4, "working")
        XCTAssertEqual(fixture.pageReads, reads)
    }

    // MARK: native-state-2 — 읽는 중에 받은 글은 그 읽기가 실패해도 화면에서 빠지지 않는다

    func testMessageReceivedDuringAReadIsNotCountedAsPlaced() {
        let key = ChatHistoryKey(namespace: "host", connectionGeneration: UUID(), projectID: "p", scope: .project)
        func message(_ number: Int) -> Message { Message(id: String(format: "%04d", number), projectId: "p", at: "t\(number)") }
        var history = ChatHistory(key: key)
        let first = history.begin(.initial)!
        XCTAssertTrue(history.apply(MessagePage(projectId: "p", scope: .project, items: [message(1)], nextCursor: nil, hasOlder: false), request: first))
        // 읽기가 없을 때 받은 새 글은 바로 놓인다.
        history.receive(message(2))
        XCTAssertTrue(history.settled(message(2)))

        // 최신 쪽을 읽는 중에 받은 글은 아직 놓이지 않았다. 다시 읽어야 한다는 답을 낸다.
        let latest = history.begin(.latest)!
        history.receive(message(3))
        XCTAssertFalse(history.settled(message(3)))
        // 그 읽기가 실패하면 글은 화면에 없다(그래서 위에서 다시 읽기를 예약해야 한다).
        history.fail(URLError(.timedOut), request: latest)
        XCTAssertEqual(history.items.map(\.id), ["0001", "0002"])
        XCTAssertFalse(history.settled(message(3)))

        // 다시 읽으면 놓인다.
        let again = history.begin(.latest)!
        XCTAssertTrue(history.apply(MessagePage(projectId: "p", scope: .project, items: [message(1), message(2), message(3)], nextCursor: nil, hasOlder: false), request: again))
        XCTAssertEqual(history.items.map(\.id), ["0001", "0002", "0003"])
        XCTAssertTrue(history.settled(message(3)))
        // 이 대화의 글이 아니면 다시 읽을 까닭이 없다.
        XCTAssertTrue(history.settled(Message(id: "x", projectId: "other", at: "t9")))
    }

    // MARK: native-state-3 — 목록을 읽는 동안 이벤트로 끼운 활동이 응답에 덮여 사라지지 않는다

    func testActivityInsertedDuringAListReadSurvivesTheOlderResponse() async throws {
        let fixture = ReviewFixture(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: fixture.handle)
        guard let (store, socket) = try await live(network, clock, factory) else { return }
        defer { store.disconnect() }
        fixture.activity = [Activity(id: 1, memberId: "m", text: "first")]
        await store.activateActivity(memberID: "m")
        XCTAssertEqual(store.activities["m"]?.map(\.id), [1])

        // 목록 읽기가 서버에서 2까지 읽은 뒤 응답이 오기 전에, 활동 7의 이벤트가 먼저 도착한다.
        fixture.activity = [Activity(id: 2, memberId: "m", text: "second"), Activity(id: 1, memberId: "m", text: "first")]
        let held = StabGate()
        fixture.mode.hold("/api/members/m/activity", held)
        let read = Task { await store.refreshActivity() }
        await eventually { await held.entered == 1 }
        fixture.base.change { $0.seq = 1 }
        try await frame(socket, #"{"type":"activity","epoch":"E","seq":1,"projectId":"p","activity":{"id":7,"memberId":"m","text":"pushed"}}"#)
        await eventually { store.activities["m"]?.map(\.id) == [7, 1] }
        await held.open()
        await read.value
        XCTAssertEqual(store.activities["m"]?.map(\.id), [7, 2, 1], "응답보다 새 줄은 남기고, 응답에 있는 줄은 응답대로 채운다")

        // 읽는 동안 이벤트가 없었으면 응답이 그대로 목록이 된다.
        fixture.activity = [Activity(id: 8, memberId: "m", text: "eighth"), Activity(id: 2, memberId: "m", text: "second")]
        await store.refreshActivity()
        XCTAssertEqual(store.activities["m"]?.map(\.id), [8, 2])

        // 응답이 비어 있어도 읽기 전부터 있던 줄은 응답대로 비우고, 읽는 동안 끼운 줄만 남긴다.
        fixture.activity = []
        let again = StabGate()
        fixture.mode.hold("/api/members/m/activity", again)
        let empty = Task { await store.refreshActivity() }
        await eventually { await again.entered == 1 }
        fixture.base.change { $0.seq = 2 }
        try await frame(socket, #"{"type":"activity","epoch":"E","seq":2,"projectId":"p","activity":{"id":9,"memberId":"m","text":"later"}}"#)
        await eventually { store.activities["m"]?.map(\.id) == [9, 8, 2] }
        await again.open()
        await empty.value
        XCTAssertEqual(store.activities["m"]?.map(\.id), [9])
    }

    // MARK: native-state-4 — 앞선 전송의 새로고침이 끝나며 다음 전송의 안내를 지우지 않는다

    func testAcceptedSendDoesNotEraseTheNextSendsNoticeWhenItsRefreshEnds() async throws {
        let server = WriteTestServer(), mode = StabSwitch(), held = StabGate()
        let network = try IsolatedTestNetwork { request in mode.apply(request, to: try server.handle(request)) }
        let store = try await plain(network)
        defer { store.disconnect() }
        mode.hold("/api/sync", held)
        let first = Task { await store.sendMessage(text: "첫 글") }
        await eventually { await held.entered == 1 }
        XCTAssertFalse(store.isSending(projectID: "p", targetMemberID: nil))
        XCTAssertNil(store.messageSendNotice(targetMemberID: nil))

        // 첫 글의 새로고침이 도는 동안 같은 입력칸의 다음 전송이 실패해 안내를 남긴다.
        let second = await store.sendMessage(text: "둘째 글", attachmentIDs: ["없는 첨부"])
        XCTAssertFalse(second)
        let notice = store.messageSendNotice(targetMemberID: nil)
        XCTAssertEqual(notice, "첨부 초안을 확인해 주세요. 누락된 첨부를 빼고 보내지 않습니다.")

        await held.open()
        let accepted = await first.value
        XCTAssertTrue(accepted)
        XCTAssertEqual(store.messageSendNotice(targetMemberID: nil), notice, "첫 글이 끝나며 둘째 글의 안내를 지웠다")
        XCTAssertEqual(server.read { $0.sentIDs.count }, 1)
    }

    // MARK: native-state-5 — 같은 조작권으로 다시 붙어도 '타자한 조작'으로 남는다

    func testControlReattachWithTheSameLeaseKeepsTheTypedState() async throws {
        let network = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 400) }
        let drop = StabGate()
        var receives = 0
        let first = expectation(description: "control attaches"), second = expectation(description: "control reattaches")
        let client = TerminalStreamClient(session: network.session, messageSender: { _ in }, receiveMessage: { _ in
            receives += 1
            if receives == 1 || receives == 3 { return .string(#"{"type":"ready","mode":"control","cols":100,"rows":30}"#) }
            if receives == 2 { await drop.wait(); throw URLError(.networkConnectionLost) }
            try await Task.sleep(for: .seconds(3600)) // 연결 유지: dispose 가 취소한다
            throw CancellationError()
        })
        var readies = 0
        client.onReady = { _ in readies += 1; (readies == 1 ? first : second).fulfill() }
        client.connect(api: network.makeAPIClient(), memberID: "m", mode: .control, leaseID: "lease")
        await fulfillment(of: [first], timeout: 5)
        XCTAssertFalse(client.sentInput)
        client.send(Data("ls\r".utf8))
        XCTAssertTrue(client.sentInput)

        // 망이 잠깐 끊겨 같은 조작권으로 한 번 다시 붙는다(ready 가 또 온다).
        await drop.open()
        await fulfillment(of: [second], timeout: 5)
        XCTAssertEqual(client.state, .live(mode: .control, cols: 100, rows: 30))
        XCTAssertTrue(client.sentInput, "이미 타자한 조작이 '클릭만 한 조작'으로 되돌아갔다")

        // 새 연결(다른 조작)은 처음부터 다시 센다.
        client.connect(api: network.makeAPIClient(), memberID: "m", mode: .observe)
        XCTAssertFalse(client.sentInput)
        client.dispose()
        await network.close()
    }

    // MARK: native-state-6 — 예전 404만으로는 미확인 조작을 닫지 않는다

    func testOperationIsClosedAsNeverArrivedOnlyWhenTheLatestLookupSaidNotFound() async throws {
        let root = try root(); defer { try? FileManager.default.removeItem(at: root) }
        let server = WriteTestServer(), failing = ReviewFlag()
        let network = try IsolatedTestNetwork { request in
            if failing.on, request.url!.path.hasPrefix("/api/operations/") { return IsolatedTestHTTPReply(status: 503) }
            return try server.handle(request)
        }
        let store = try await plain(network, root: root), member = store.members[0]
        defer { store.disconnect() }
        func status(_ id: String) throws -> String? {
            let journal = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("journal"))) as? [String: Any])
            return (journal["operations"] as? [String: [String: Any]])?[id]?["status"] as? String
        }
        let claimed = await store.claimTerminal(member); XCTAssertTrue(claimed)
        server.change { $0.dropTerminal = true; $0.storeTerminalReceipt = false }
        let typed = await store.terminalInput(member, text: "y"); XCTAssertFalse(typed)
        let lost = try XCTUnwrap(server.read { $0.terminalBodies.first { $0["action"] as? String == "input" }?["operationId"] as? String })
        server.change { $0.dropTerminal = false; $0.storeTerminalReceipt = true }
        // 직후의 조회는 404였다(서버에 기록 없음).
        XCTAssertFalse(network.requests.filter { $0.url?.path == "/api/operations/\(lost)" }.isEmpty)
        XCTAssertEqual(try status(lost), "unknown")

        // 두 분 뒤의 조회는 다른 이유로 실패한다. 멈췄던 요청이 그사이 닿았을 수 있으니 예전 404로 닫지 않는다.
        let started = Date().timeIntervalSince1970
        store.wallClock = { started + 120 }
        failing.on = true
        await store.recoverWrites()
        XCTAssertEqual(try status(lost), "unknown")
        let blocked = await store.terminalKey(member, key: "enter"); XCTAssertFalse(blocked)
        XCTAssertEqual(try status(lost), "unknown")

        // 조회가 다시 '기록 없음'으로 답하면 그때 닫는다. 잃은 입력은 다시 보내지 않는다.
        failing.on = false
        await store.recoverWrites()
        XCTAssertEqual(try status(lost), "refused")
        XCTAssertEqual(server.read { $0.terminalBodies.filter { $0["action"] as? String == "input" }.count }, 1)
    }

    // MARK: native-views-2 — 다시 연결된 뒤 늦게 온 해제가 새 활동 등록을 지우지 않는다

    func testLateDeactivationFromBeforeAReconnectKeepsTheNewActivityRegistration() async throws {
        let fixture = ReviewFixture()
        let network = try IsolatedTestNetwork(handler: fixture.handle)
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        await store.connect()
        defer { store.disconnect() }
        fixture.activity = [Activity(id: 1, memberId: "m", text: "first")]
        let old = store.activityEpoch
        let registered = await store.activateActivity(memberID: "m")
        XCTAssertTrue(registered)
        XCTAssertEqual(store.activities["m"]?.map(\.id), [1])

        // 같은 서버에 다시 연결하면(접속 코드만 바뀜) 등록이 통째로 비워지고 화면의 새 task가 다시 등록한다.
        store.accessCode = "fixture-2"
        await store.connect()
        XCTAssertNotEqual(store.activityEpoch, old)
        XCTAssertNil(store.activities["m"])
        let again = await store.activateActivity(memberID: "m")
        XCTAssertTrue(again)
        // 취소된 옛 task의 해제는 그 뒤에 온다. 새 등록을 건드리지 않는다.
        store.deactivateActivity(memberID: "m", epoch: old)
        XCTAssertEqual(store.activities["m"]?.map(\.id), [1])
        fixture.activity = [Activity(id: 2, memberId: "m", text: "second"), Activity(id: 1, memberId: "m", text: "first")]
        await store.refreshActivity()
        XCTAssertEqual(store.activities["m"]?.map(\.id), [2, 1], "등록이 지워져 목록이 더는 읽히지 않는다")

        // 같은 연결 안에서의 해제는 그대로 푼다.
        store.deactivateActivity(memberID: "m", epoch: store.activityEpoch)
        XCTAssertNil(store.activities["m"])
    }

    // MARK: native-views-3 — 결재함 → 자료 → 다른 탭도 방문이 끝난 것이다

    func testInboxVisitEndsWhenLeavingForAnotherTabDirectlyOrThroughFiles() {
        XCTAssertTrue(InboxReviewState.visitEnds(from: .inbox, to: .home))
        XCTAssertTrue(InboxReviewState.visitEnds(from: .inbox, to: .team))
        XCTAssertTrue(InboxReviewState.visitEnds(from: .inbox, to: .chat))
        // 자료를 보고 돌아오는 길은 방문을 끝내지 않는다.
        XCTAssertFalse(InboxReviewState.visitEnds(from: .inbox, to: .files))
        XCTAssertFalse(InboxReviewState.visitEnds(from: .files, to: .inbox))
        // 자료에서 결재함으로 돌아오지 않고 다른 탭으로 가면 끝난다.
        XCTAssertTrue(InboxReviewState.visitEnds(from: .files, to: .home))
        XCTAssertTrue(InboxReviewState.visitEnds(from: .files, to: .team))
        XCTAssertFalse(InboxReviewState.visitEnds(from: .home, to: .team))
        XCTAssertFalse(InboxReviewState.visitEnds(from: .home, to: .inbox))
    }
}
