import Foundation
import XCTest
@testable import IAMCEO

private actor HistoryMock: MessageHistoryService {
    struct Call: Sendable { let cursor: String?; let limit: Int; let archived: Bool }
    private(set) var calls: [Call] = []
    private var pending: [Int: TestDeadlineContinuation<MessagePage, Error>] = [:]
    private var observers: [(Int, TestDeadlineContinuation<Void, Never>)] = []
    func messagePage(projectID: String, scope: MessageScope, cursor: String?, limit: Int) async throws -> MessagePage {
        try await page(cursor: cursor, limit: limit, archived: false)
    }
    func archivedMessagePage(projectID: String, scope: MessageScope, cursor: String?, limit: Int) async throws -> MessagePage {
        try await page(cursor: cursor, limit: limit, archived: true)
    }
    private func page(cursor: String?, limit: Int, archived: Bool) async throws -> MessagePage {
        let index = calls.count
        calls.append(Call(cursor: cursor, limit: limit, archived: archived))
        return try await withThrowingTestDeadline { continuation in
            pending[index] = continuation
            let ready = observers.filter { $0.0 <= calls.count }
            observers.removeAll { $0.0 <= calls.count }
            for (_, observer) in ready { observer.resume() }
        }
    }
    func waitForCalls(_ count: Int) async {
        if calls.count >= count { return }
        await withTestDeadline(fallback: ()) { observers.append((count, $0)) }
    }
    func respond(_ index: Int, _ result: Result<MessagePage, Error>) { pending.removeValue(forKey: index)!.resume(with: result) }
    func message(id: String) async throws -> Message { throw URLError(.unsupportedURL) }
    func messagesAround(projectID: String, messageID: String, limit: Int) async throws -> [Message] { throw URLError(.unsupportedURL) }
}

final class ChatHistoryTests: XCTestCase {
    private func key(_ project: String = "p", scope: MessageScope = .project) -> ChatHistoryKey {
        ChatHistoryKey(namespace: "host-a", connectionGeneration: UUID(), projectID: project, scope: scope)
    }
    private func message(_ number: Int, delivery: String? = nil) -> Message {
        Message(id: String(format: "%04d", number), projectId: "p", at: "same-time", delivery: delivery)
    }
    private func page(_ numbers: Range<Int>, cursor: String? = nil) -> MessagePage {
        MessagePage(projectId: "p", scope: .project, items: numbers.map { message($0) }, nextCursor: cursor, hasOlder: cursor != nil)
    }
    private func seed(_ history: inout ChatHistory, _ numbers: Range<Int> = 100..<200, cursor: String? = "old") {
        let request = history.begin(.initial)!
        XCTAssertTrue(history.apply(page(numbers, cursor: cursor), request: request))
    }

    func testBinaryTupleOrderAndCanonicalUnicodeIDsRemainDistinct() {
        var history = ChatHistory(key: key())
        let ids = ["é", "e\u{301}", "😀", "\u{E000}", "a"]
        let rows = ids.map { Message(id: $0, projectId: "p", at: "not-a-date") }
        let request = history.begin(.initial)!
        XCTAssertTrue(history.apply(MessagePage(projectId: "p", scope: .project, items: rows + [rows[0]], nextCursor: nil, hasOlder: false), request: request))
        XCTAssertEqual(history.items.map { Data($0.id.utf8) }, ids.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.map { Data($0.utf8) })
        XCTAssertEqual(history.items.count, 5)
        XCTAssertTrue(ChatHistory.ordered(Message(id: "z", at: "10"), Message(id: "a", at: "2")))
    }

    func testInitialBufferAndJournalPreserveArrivalOrderWithoutDeliveryRanking() {
        var history = ChatHistory(key: key())
        history.receive(message(100, delivery: "failed"))
        let request = history.begin(.initial)!
        XCTAssertNil(history.begin(.initial))
        history.receive(message(100, delivery: "delivered"))
        history.receive(message(200, delivery: "queued"))
        XCTAssertTrue(history.apply(page(100..<101), request: request))
        XCTAssertEqual(history.items.map(\.id), ["0100", "0200"])
        XCTAssertEqual(history.items.first?.delivery, "delivered")
        XCTAssertEqual(history.unreadCount, 0)
        let latest = history.begin(.latest)!
        history.receive(message(100, delivery: "failed"))
        history.receive(message(100, delivery: "queued"))
        XCTAssertTrue(history.apply(page(100..<201), request: latest))
        XCTAssertEqual(history.items.first?.delivery, "queued")
    }

    func testOlderKeepsServerCursorAndUnknownHistoricalOverlayDoesNotCreateInterval() {
        var history = ChatHistory(key: key())
        seed(&history)
        history.pinnedToBottom = false
        history.receive(message(10, delivery: "delivered"))
        XCTAssertEqual(history.items.count, 100)
        let request = history.begin(.older)!
        history.receive(message(200))
        history.receive(message(11, delivery: "delivered"))
        XCTAssertTrue(history.apply(page(0..<100, cursor: "opaque-next"), request: request))
        XCTAssertEqual(history.items.count, 201)
        XCTAssertEqual(history.items[10].delivery, "delivered")
        XCTAssertEqual(history.items[11].delivery, "delivered")
        XCTAssertEqual(history.nextCursor, "opaque-next")
        XCTAssertEqual(history.unreadCount, 1)
        XCTAssertEqual(history.change, .prepend)
        let last = history.begin(.older)!
        XCTAssertTrue(history.apply(page(0..<0), request: last))
        XCTAssertFalse(history.hasOlder)
        XCTAssertNil(history.begin(.older))
    }

    func testOptimisticRowsCannotProveBridgeOverlapAndNewTailIsStaged() {
        var history = ChatHistory(key: key())
        seed(&history)
        history.addOptimistic(message(800))
        let latest = history.begin(.latest)!
        history.receive(message(901))
        history.apply(page(700..<900, cursor: "700"), request: latest)
        XCTAssertTrue(history.isBridging)
        XCTAssertEqual(history.confirmedItems.count, 100)
        XCTAssertFalse(history.items.contains { $0.id == "0901" })
        XCTAssertEqual(history.nextCursor, "old")
        let bridge = history.begin(.bridge)!
        history.fail(URLError(.networkConnectionLost), request: bridge)
        XCTAssertEqual(history.items.count, 101)
        XCTAssertEqual(history.begin(.bridge)?.cursor, "700")
    }

    func testBridgeCommitsAtomicallyAndCountsOnlyNewTail() {
        var history = ChatHistory(key: key())
        seed(&history, 0..<200, cursor: nil)
        history.pinnedToBottom = false
        history.anchor = ChatHistoryAnchor(messageID: "0050", offset: -12.5)
        history.apply(page(700..<900, cursor: "700"), request: history.begin(.latest)!)
        for start in stride(from: 600, through: 200, by: -100) {
            let request = history.begin(.bridge)!
            history.apply(page(start..<(start + 100), cursor: "\(start)"), request: request)
            XCTAssertEqual(history.items.count, 200)
        }
        let request = history.begin(.bridge)!
        history.receive(message(100, delivery: "delivered"))
        history.receive(message(900))
        history.apply(page(100..<200, cursor: "100"), request: request)
        XCTAssertFalse(history.isBridging)
        XCTAssertEqual(history.items.count, 901)
        XCTAssertEqual(history.items[100].delivery, "delivered")
        XCTAssertEqual(history.unreadCount, 701)
        XCTAssertFalse(history.hasOlder)
        XCTAssertEqual(history.anchor?.offset, -12.5)
        history.jumpToLatest()
        XCTAssertEqual(history.unreadCount, 0)
        XCTAssertNil(history.anchor)
    }

    func testStoreReplacementAndMalformedPageKeepVisibleHistory() {
        var history = ChatHistory(key: key())
        seed(&history)
        let bad = history.begin(.older)!
        let foreign = MessagePage(projectId: "other", scope: .project, items: [], nextCursor: nil, hasOlder: false)
        XCTAssertFalse(history.apply(foreign, request: bad))
        XCTAssertEqual(history.items.count, 100)
        XCTAssertEqual(history.nextCursor, "old")
        let latest = history.begin(.latest)!
        history.apply(page(800..<810), request: latest)
        XCTAssertTrue(history.storeChanged)
        XCTAssertEqual(history.items.count, 100)
        XCTAssertNil(history.begin(.older))
        history.addOptimistic(message(999))
        history.restartFromLatest()
        XCTAssertFalse(history.storeChanged)
        XCTAssertFalse(history.initialized)
        XCTAssertTrue(history.optimisticIDs.contains("0999"))
    }

    func testBridgeReachingStartWithPartialOldOverlapDetectsDeletion() {
        var history = ChatHistory(key: key())
        seed(&history)
        let latest = history.begin(.latest)!
        history.apply(page(700..<900, cursor: "700"), request: latest)
        let last = history.begin(.bridge)!
        history.apply(page(150..<200), request: last)
        XCTAssertTrue(history.storeChanged)
        XCTAssertEqual(history.items.map(\.id), (100..<200).map { message($0).id })
        XCTAssertEqual(history.nextCursor, "old")
    }

    func testScopeFilteringAndCancelledFinallyCannotAffectNewRequest() {
        var history = ChatHistory(key: key(scope: .member(memberId: "worker")))
        history.receive(Message(id: "foreign", projectId: "p", memberId: "other"))
        XCTAssertTrue(history.items.isEmpty)
        let stale = history.begin(.initial)!
        history.cancel()
        let fresh = history.begin(.initial)!
        history.fail(URLError(.timedOut), request: stale)
        XCTAssertEqual(history.loading, fresh)
        let scoped = MessagePage(projectId: "p", scope: .member(memberId: "worker"), items: [Message(id: "mine", projectId: "p", targetMemberId: "worker")], nextCursor: nil, hasOlder: false)
        XCTAssertFalse(history.apply(scoped, request: stale))
        XCTAssertTrue(history.apply(scoped, request: fresh))
        XCTAssertEqual(history.items.map(\.id), ["mine"])
    }

    func testEmptyRangeCountsNewTailAndNormalizesOnlyFirstLead() {
        let members = [Member(id: "lead", kind: "conductor"), Member(id: "second", kind: "root")]
        XCTAssertEqual(ChatHistoryKey.normalizedScope(targetMemberID: nil, members: members), .project)
        XCTAssertEqual(ChatHistoryKey.normalizedScope(targetMemberID: "lead", members: members), .project)
        XCTAssertEqual(ChatHistoryKey.normalizedScope(targetMemberID: "second", members: members), .member(memberId: "second"))
        XCTAssertEqual(ChatHistoryKey.normalizedScope(targetMemberID: "removed", members: members), .member(memberId: "removed"))
        var history = ChatHistory(key: key())
        seed(&history, 0..<0, cursor: nil)
        history.pinnedToBottom = false
        let latest = history.begin(.latest)!
        history.apply(page(0..<2), request: latest)
        XCTAssertEqual(history.unreadCount, 2)
    }

    @MainActor func testCancelledLatestDoesNotContinueNewGenerationsBridge() async {
        let service = HistoryMock(); let cache = ChatHistoryCache(); let a = key()
        cache.activate(a)
        let initial = Task { await cache.load(.initial, for: a, using: service) }
        await service.waitForCalls(1); await service.respond(0, .success(page(0..<200, cursor: "old"))); await initial.value
        let stale = Task { await cache.load(.latest, for: a, using: service) }
        await service.waitForCalls(2)
        cache.activate(key("b")); cache.activate(a)
        let fresh = Task { await cache.load(.latest, for: a, using: service) }
        await service.waitForCalls(3); await service.respond(2, .success(page(700..<900, cursor: "700")))
        await service.waitForCalls(4); await service.respond(3, .success(page(600..<700, cursor: "600")))
        await service.waitForCalls(5); await service.respond(4, .success(page(500..<600, cursor: "500")))
        await fresh.value
        await service.respond(1, .success(page(700..<900, cursor: "700")))
        await stale.value
        let calls = await service.calls
        XCTAssertEqual(calls.count, 5)
        XCTAssertTrue(cache.history(for: a)!.isBridging)
        XCTAssertEqual(cache.history(for: a)?.items.count, 200)
    }

    func testAll1205RowsRemainLoadedAcrossLatestRefresh() {
        var history = ChatHistory(key: key())
        seed(&history, 1005..<1205, cursor: "1005")
        history.anchor = ChatHistoryAnchor(messageID: "1100", offset: -42)
        var end = 1005
        while end > 0 {
            let start = max(0, end - 100)
            let request = history.begin(.older)!
            XCTAssertEqual(request.cursor, "\(end)")
            history.apply(page(start..<end, cursor: start == 0 ? nil : "\(start)"), request: request)
            end = start
        }
        XCTAssertEqual(history.items.map(\.id), (0..<1205).map { message($0).id })
        let latest = history.begin(.latest)!
        history.apply(page(1005..<1205, cursor: "new-latest-cursor"), request: latest)
        XCTAssertEqual(history.items.count, 1205)
        XCTAssertFalse(history.hasOlder)
        XCTAssertNil(history.nextCursor)
        XCTAssertEqual(history.anchor?.offset, -42)
    }

    @MainActor func testArchivedCacheUsesOnlyArchivedReadService() async {
        let service = HistoryMock(); let cache = ChatHistoryCache()
        var archived = key(); archived.archived = true
        cache.activate(archived)
        let load = Task { await cache.load(.initial, for: archived, using: service) }
        await service.waitForCalls(1)
        await service.respond(0, .success(page(0..<1)))
        await load.value
        let calls = await service.calls
        XCTAssertEqual(calls.count, 1)
        XCTAssertTrue(calls[0].archived)
    }

    @MainActor func testCacheSingleFlightABAAndLRUPosition() async {
        let service = HistoryMock()
        let cache = ChatHistoryCache()
        let a = key(); let b = key("b")
        cache.activate(a)
        let stale = Task { await cache.load(.initial, for: a, using: service) }
        await service.waitForCalls(1)
        await cache.load(.initial, for: a, using: service)
        cache.activate(b); cache.activate(a)
        let fresh = Task { await cache.load(.initial, for: a, using: service) }
        await service.waitForCalls(2)
        await service.respond(0, .failure(URLError(.timedOut)))
        await stale.value
        XCTAssertNotNil(cache.history(for: a)?.loading)
        await service.respond(1, .success(page(0..<200, cursor: "old")))
        await fresh.value
        cache.setReadingPosition(ChatHistoryAnchor(messageID: "0050", offset: -9), pinned: false, for: a)
        cache.activate(b); cache.activate(key("c")); cache.activate(a)
        XCTAssertEqual(cache.history(for: a)?.anchor?.offset, -9)
        cache.activate(key("d"))
        XCTAssertNil(cache.history(for: b))
        XCTAssertEqual(cache.histories.count, 3)
        XCTAssertEqual(cache.history(for: a)?.items.count, 200)
        cache.removeAll()
        XCTAssertTrue(cache.histories.isEmpty)
    }

    @MainActor func testCacheBridgeBudgetAndFailedContinuationRetainsCursor() async {
        let service = HistoryMock(); let cache = ChatHistoryCache(); let a = key()
        cache.activate(a)
        let initial = Task { await cache.load(.initial, for: a, using: service) }
        await service.waitForCalls(1); await service.respond(0, .success(page(0..<200, cursor: "old"))); await initial.value
        let latest = Task { await cache.load(.latest, for: a, using: service) }
        await service.waitForCalls(2); await service.respond(1, .success(page(700..<900, cursor: "700")))
        await service.waitForCalls(3); await service.respond(2, .success(page(600..<700, cursor: "600")))
        await service.waitForCalls(4); await service.respond(3, .success(page(500..<600, cursor: "500")))
        await latest.value
        let calls = await service.calls
        XCTAssertEqual(calls.map(\.limit), [200, 200, 100, 100])
        XCTAssertEqual(cache.history(for: a)?.items.count, 200)
        let failed = Task { await cache.load(.bridge, for: a, using: service) }
        await service.waitForCalls(5); await service.respond(4, .failure(URLError(.timedOut))); await failed.value
        let retry = Task { await cache.load(.bridge, for: a, using: service) }
        await service.waitForCalls(6)
        let retriedCalls = await service.calls
        XCTAssertEqual(retriedCalls[4].cursor, "500"); XCTAssertEqual(retriedCalls[5].cursor, "500")
        await service.respond(5, .success(page(400..<500, cursor: "400")))
        await service.waitForCalls(7); await service.respond(6, .success(page(300..<400, cursor: "300")))
        await service.waitForCalls(8); await service.respond(7, .success(page(200..<300, cursor: "200")))
        await retry.value
        let finish = Task { await cache.load(.bridge, for: a, using: service) }
        await service.waitForCalls(9); await service.respond(8, .success(page(100..<200, cursor: "100")))
        await finish.value
        XCTAssertFalse(cache.history(for: a)!.isBridging)
        XCTAssertEqual(cache.history(for: a)?.items.count, 900)
    }

    /// n-chat-5: 정렬한 목록은 내용이 바뀔 때만 다시 만든다. 복사본끼리 캐시가 섞이지 않는다.
    func testSortedItemsAreRebuiltOnlyWhenRowsChangeAndCopiesStayIndependent() {
        var history = ChatHistory(key: key())
        seed(&history, 100..<103, cursor: nil)
        XCTAssertEqual(history.items.map(\.id), ["0100", "0101", "0102"])
        XCTAssertEqual(history.items.map(\.id), ["0100", "0101", "0102"])
        let before = history
        history.receive(message(103))
        XCTAssertEqual(history.items.map(\.id), ["0100", "0101", "0102", "0103"])
        XCTAssertEqual(before.items.map(\.id), ["0100", "0101", "0102"], "A copy taken earlier keeps its own rows")
        history.addOptimistic(Message(id: "9999", projectId: "p", at: "same-time", mine: true))
        XCTAssertEqual(history.items.last?.id, "9999")
        history.receive(message(101, delivery: "delivered"))
        XCTAssertEqual(history.items.first { $0.id == "0101" }?.delivery, "delivered")
        var copy = history
        copy.receive(Message(id: "9999", projectId: "p", at: "same-time", mine: true, delivery: "queued"))
        XCTAssertEqual(copy.items.last?.delivery, "queued")
        XCTAssertNil(history.items.last?.delivery)
    }

    /// n-appstore-2: 실시간으로 받은 글이 대화에 놓였는지에 따라 최신 쪽을 다시 읽을지 정한다.
    func testSettledTellsWhetherARealtimeMessageStillNeedsAPageRead() {
        var history = ChatHistory(key: key())
        let early = message(50)
        history.receive(early)
        XCTAssertFalse(history.settled(early), "Nothing is loaded yet: only a page read can place it")
        seed(&history, 100..<103, cursor: "old")
        history.receive(message(103))
        XCTAssertTrue(history.settled(message(103)), "A newer row is appended directly")
        history.receive(message(60))
        XCTAssertFalse(history.settled(message(60)), "A row older than the loaded tail is not shown until the page is read")
        let latest = history.begin(.latest)!
        history.receive(message(104))
        // review native-state-2: 읽는 중에 받은 글은 놓인 것으로 치지 않는다(그 읽기가 실패하면 화면에 나오지 않는다).
        XCTAssertFalse(history.settled(message(104)), "A read in flight may fail; the row is placed only once a page holds it")
        XCTAssertTrue(history.apply(page(100..<105), request: latest))
        XCTAssertTrue(history.settled(message(104)))
        XCTAssertTrue(history.settled(Message(id: "elsewhere", projectId: "other")), "Another project's message is not this history's concern")
    }
}
