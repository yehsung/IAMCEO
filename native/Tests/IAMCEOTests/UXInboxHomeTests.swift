import Foundation
import XCTest
@testable import IAMCEO

private actor UXInboxGate {
    private var released = false
    private var continuation: TestDeadlineContinuation<Void, Never>?
    func wait() async {
        if !released { await withTestDeadline(fallback: ()) { continuation = $0 } }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

private final class UXInboxServer: @unchecked Sendable {
    private let lock = NSLock()
    let gate: UXInboxGate?
    private var failure = false
    private var offline = false
    private var completed = false
    private var todoBodies: [[String: Any]] = []
    private var answers = 0
    init(gate: UXInboxGate? = nil) { self.gate = gate }
    func fail(_ value: Bool) { lock.withLock { failure = value } }
    func disconnect() { lock.withLock { offline = true } }
    var completions: [[String: Any]] { lock.withLock { todoBodies } }
    var answerCount: Int { lock.withLock { answers } }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        try lock.withLock {
            if offline { throw URLError(.notConnectedToInternet) }
            func reply<T: Encodable>(_ value: T) throws -> IsolatedTestHTTPReply {
                IsolatedTestHTTPReply(data: try JSONEncoder().encode(value))
            }
            switch request.url?.path {
            case "/api/bootstrap": return try reply(Bootstrap(projects: [ProjectSummary(id: "p")]))
            case "/api/runtime": return IsolatedTestHTTPReply()
            case "/api/projects/p/state":
                return try reply(ProjectState(project: Project(id: "p", connection: ProjectConnection(ok: true)),
                    members: [Member(id: "worker", projectId: "p", kind: "worker", status: "waiting")],
                    decisions: [Decision(id: "decision", projectId: "p", memberId: "worker", options: [DecisionOption(k: "yes", label: "진행")], updatedAt: "v1")],
                    todos: [Todo(id: "todo", projectId: "p", memberId: "worker", done: completed)]))
            case "/api/todos/todo/done":
                todoBodies.append(try WriteTestServer.body(request))
                if failure { return IsolatedTestHTTPReply(status: 503) }
                completed = true
                var response = try reply(Todo(id: "todo", projectId: "p", done: true))
                if let gate { response.beforeDelivery = { await gate.wait() } }
                return response
            case "/api/decisions/decision/answer":
                answers += 1
                var response = try reply(Decision(id: "decision", projectId: "p", status: "answered", choice: "yes"))
                if let gate { response.beforeDelivery = { await gate.wait() } }
                return response
            case "/api/uploads": return try reply(Attachment(id: "upload", name: "proof.txt", url: "/uploads/proof"))
            default: return IsolatedTestHTTPReply(status: 404)
            }
        }
    }
}

@MainActor final class UXInboxHomeTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func summary(_ id: String, needs: Int = 0, since: String? = nil) -> MemberDeliverySummary {
        MemberDeliverySummary(memberId: id, undeliveredCount: 100, unknownCount: 20, deliveringCount: 2,
                              checkingCount: 10, needsOwnerCount: needs, waitingBehindCount: 70, oldestAt: nil,
                              reasons: [], waitReason: "approval", waitingSince: since)
    }
    private func notices(_ summaries: [MemberDeliverySummary] = [], unassigned: Int = 0) -> DeliveryNotices {
        DeliveryNotices(version: 2, members: summaries,
                        unassigned: UnassignedDeliverySummary(undeliveredCount: 100, unknownCount: 50, needsOwnerCount: unassigned))
    }
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture-only"
        await store.connect(); store.setForeground(false)
        XCTAssertTrue(store.uiCanWrite)
        return store
    }
    // 공용 pollUntil(TestSupport)을 부르는 얇은 껍데기. 기한은 느린 CI 러너에 맞춘 공용 기본값(10초)을 쓴다.
    private func eventually(_ condition: () -> Bool) async throws {
        await pollUntil { condition() }
    }

    func testNeedsCountsEachServerInterventionOnceWithoutDoubleCountingFailedChatRows() {
        let members = [Member(id: "permission", status: "blocked", blockedReason: "permission"),
                       Member(id: "selection", status: "blocked", blockedReason: "selection"),
                       Member(id: "setup", status: "blocked", blockedReason: "setup"), Member(id: "error", status: "error")]
        let result = InboxHomePolicy.needsCount(decisions: [Decision(id: "open"), Decision(id: "closed", status: "closed")],
            todos: [Todo(id: "open"), Todo(id: "done", done: true)], members: members,
            notices: notices([summary("permission", needs: 3), summary("missing", needs: 2)], unassigned: 4))
        XCTAssertEqual(result, 14) // 1 decision + 1 todo + 2 prompts + 1 error + 9 deliveries
        XCTAssertEqual(InboxHomePolicy.projectCount(ProjectSummary(needsCount: 14, inboxCount: 1)), 14)
        XCTAssertEqual(InboxHomePolicy.projectCount(ProjectSummary(inboxCount: 3, blockedCount: 2, errorCount: 1)), 6)
    }

    func testInboxBadgeUsesTheActualApprovalFilterIncludingUnknownObservations() {
        let members = [Member(id: "permission", status: "blocked", blockedReason: "permission"),
                       Member(id: "unknown", status: "blocked", blockedReason: "permission", statusObservation: StatusObservation(freshness: "stale", ownership: "verified")),
                       Member(id: "waiting", status: "waiting"), Member(id: "error", status: "error")]
        let listed = members.filter { $0.status == "blocked" && MemberStatusInfo($0).tone == .approval }
        XCTAssertEqual(InboxHomePolicy.approvals(members).map(\.id), listed.map(\.id))
        XCTAssertFalse(listed.contains { $0.id == "unknown" })
        XCTAssertEqual(InboxHomePolicy.inboxCount(decisions: [Decision(id: "d")], members: members), 1 + listed.count)
    }

    func testCurrentProjectBadgesUseLiveStateAndRemoteProjectsUseNeedsSummary() async throws {
        let network = try IsolatedTestNetwork(handler: UXInboxServer().handle)
        let store = await connect(network)
        defer { store.disconnect() }
        XCTAssertEqual(store.navBadge(for: .home), 2)
        XCTAssertEqual(store.navBadge(for: .inbox), 1)
        XCTAssertEqual(store.navBadgeHelp(for: .home), "내 차례 2건")
        XCTAssertEqual(store.projectNeedsCount(ProjectSummary(id: "p", needsCount: 999)), 2)
        XCTAssertEqual(store.projectNeedsCount(ProjectSummary(id: "other", needsCount: 7)), 7)
        XCTAssertTrue(store.projectNeedsDanger(ProjectSummary(id: "other", needsDanger: true)))
        await network.close()
    }

    func testOldBlockingAndWaitingSincePriorityIsStableAndShared() {
        let formatter = ISO8601DateFormatter()
        func card(_ id: String, hours: Double, member: String? = nil) -> Decision {
            Decision(id: id, memberId: member, createdAt: formatter.string(from: now.addingTimeInterval(-hours * 3600)))
        }
        let old = card("old", hours: 7), blocking = card("blocking", hours: 1, member: "waiting")
        let fresh = card("fresh", hours: 0.5), waiting = card("delivery-wait", hours: 0.1, member: "long")
        let members = [Member(id: "waiting", status: "waiting"), Member(id: "long", status: "waiting")]
        let value = notices([summary("long", since: formatter.string(from: now.addingTimeInterval(-8 * 3600)))])
        XCTAssertEqual(InboxHomePolicy.prioritized([fresh, blocking, old, waiting], members: members, notices: value, now: now).map(\.id),
                       ["delivery-wait", "old", "blocking", "fresh"])
        XCTAssertTrue(HomeView.waitedLong(old, now: now))
        XCTAssertNotNil(HomeView.waitedLabel(old, now: now))
        XCTAssertFalse(HomeView.waitedLong(fresh, now: now))
        XCTAssertEqual(InboxHomePolicy.prioritized([Decision(id: "b"), Decision(id: "a")], members: [], notices: nil, now: now).map(\.id), ["a", "b"])
    }

    func testFileNavigationPreservesReviewExpansionAndScrollForBothLayouts() {
        for phone in [false, true] {
            let router = Router(destination: .inbox, usesPhoneNavigation: phone)
            let state = router.inboxReview
            var review = DecisionReview(decision: Decision(id: "d", options: [DecisionOption(k: "a", label: "진행")], updatedAt: "v1"))
            review.choice = "a"; review.note = "조건을 확인해 주세요"
            state.reviews["d"] = review; state.engaged.insert("d"); state.expandedDetail.insert("d"); state.scrollID = "d"
            state.scrollLocations["d"] = InboxScrollLocation(top: -240, height: 1200)
            router.openFile("evidence")
            if phone { XCTAssertEqual(router.phonePaths[.inbox], [.file("evidence")]); router.phonePaths[.inbox] = [] }
            else { router.go(.inbox) }
            XCTAssertTrue(router.inboxReview === state)
            XCTAssertEqual(router.inboxReview.reviews["d"]?.choice, "a")
            XCTAssertEqual(router.inboxReview.reviews["d"]?.note, review.note)
            XCTAssertTrue(router.inboxReview.expandedDetail.contains("d"))
            XCTAssertEqual(router.inboxReview.scrollID, "d")
            XCTAssertEqual(router.inboxReview.scrollLocations["d"]?.top, -240)
            let anchor = router.inboxReview.scrollLocations["d"]?.anchor(viewport: 600)
            XCTAssertEqual(anchor?.y, -240.0 / 599.0)
            router.resetForProjectChange()
            XCTAssertTrue(router.inboxReview.reviews.isEmpty)
            XCTAssertNil(router.inboxReview.scrollID)
        }
    }

    func testScrollAnchorRetainsPositionForTallShortAndEqualHeightCards() {
        let tall = InboxScrollLocation(top: -240, height: 1200)
        XCTAssertEqual(tall.anchor(viewport: 600).y * 599, tall.top, accuracy: 0.001)
        let short = InboxScrollLocation(top: -20, height: 200)
        XCTAssertEqual(short.anchor(viewport: 600).y * 599, short.top, accuracy: 0.001)
        let equal = InboxScrollLocation(top: -75, height: 600)
        XCTAssertEqual(equal.anchor(viewport: 600).y * 599, equal.top, accuracy: 0.001)
        XCTAssertEqual(equal.anchor(viewport: 0).y, 0)
    }

    func testChangedQuestionRequiresReviewButRetainsMemo() {
        var current = Decision(id: "d", options: [DecisionOption(k: "a", label: "진행")], updatedAt: "v1")
        var review = DecisionReview(decision: current); review.choice = "a"; review.note = "원래 메모"
        current.updatedAt = "v2"
        XCTAssertFalse(review.canSubmit(comparedTo: current))
        XCTAssertFalse(review.showsConfirmation(comparedTo: current, memoOnly: false))
        review.reviewLatest(current)
        XCTAssertNil(review.choice)
        XCTAssertEqual(review.note, "원래 메모")
    }

    func testFreeAnswerGoesFromTypingDirectlyToOneFinalConfirmation() {
        let decision = Decision(id: "free", updatedAt: "v1")
        var review = DecisionReview(decision: decision)
        XCTAssertFalse(review.showsConfirmation(comparedTo: decision, memoOnly: false))
        review.note = "https://example.test"
        XCTAssertTrue(review.showsConfirmation(comparedTo: decision, memoOnly: false))
        XCTAssertTrue(review.canSubmit(comparedTo: decision))
        review.freeConfirmationCancelled = true
        XCTAssertFalse(review.showsConfirmation(comparedTo: decision, memoOnly: false))
        review.note = " \n "
        XCTAssertFalse(review.canSubmit(comparedTo: decision))
    }

    func testRapidConfirmStartsOnceAndStaysBusyAcrossFileNavigation() async throws {
        let gate = UXInboxGate(), server = UXInboxServer(gate: nil)
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let router = Router(destination: .inbox), review = DecisionReview(decision: try XCTUnwrap(store.decisions.first))
        let state = router.inboxReview
        let first = Task { @MainActor in
            guard state.beginSubmission("decision") else { return false }
            await gate.wait()
            let accepted = await store.answerDecision(review.decision, choice: "yes", note: nil)
            state.inFlight.remove("decision")
            return accepted
        }
        try await eventually { state.inFlight.contains("decision") }
        XCTAssertFalse(state.beginSubmission("decision"))
        router.openFile("evidence")
        XCTAssertTrue(router.inboxReview.inFlight.contains("decision"))
        await gate.release()
        let accepted = await first.value
        XCTAssertTrue(accepted)
        XCTAssertEqual(server.answerCount, 1)
        XCTAssertFalse(state.inFlight.contains("decision"))
        await network.close()
    }

    func testOfflineMemoCanStillBeEditedAndStoredWithALockReason() async throws {
        let server = UXInboxServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        var review = DecisionReview(decision: try XCTUnwrap(store.decisions.first))
        server.disconnect(); await store.refresh()
        XCTAssertFalse(store.uiCanWrite)
        XCTAssertNotNil(store.writeBlockedReason)
        review.note = "끊김 중 작성한 조건"
        store.drafts.setMemo(review.note, for: review.decision.id)
        XCTAssertEqual(store.drafts.memo(for: review.decision.id), review.note)
        XCTAssertEqual(server.answerCount, 0)
        await network.close()
    }

    func testKeyboardDigitsAreLocalToCardAndNeverConsumeMemoText() {
        for number in 1...9 {
            XCTAssertEqual(ApprovalKeyboardShortcuts.optionNumber("\(number)", editing: false), number)
            XCTAssertNil(ApprovalKeyboardShortcuts.optionNumber("\(number)", editing: true))
        }
        for key in ["0", "10", "x", "", "\n"] { XCTAssertNil(ApprovalKeyboardShortcuts.optionNumber(key, editing: false)) }
    }

    func testTodoCompletionSendsExactNoteAndAllFilesWithoutChangingChatDraft() async throws {
        let server = UXInboxServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let todo = try XCTUnwrap(store.todos.first), review = TodoCompletionReview(todo: todo, store: store)
        let key = DraftStore.key(project: "p", target: nil)
        store.drafts.setText("쓰던 지시", for: key)
        review.note = "  확인했습니다\n첨부를 봐 주세요  "
        review.files = [Attachment(id: "a"), Attachment(id: "b")]
        let accepted = await review.submit(store: store)
        XCTAssertTrue(accepted)
        let body = try XCTUnwrap(server.completions.first)
        XCTAssertEqual(body["note"] as? String, review.note)
        XCTAssertEqual(body["fileIds"] as? [String], ["a", "b"])
        XCTAssertEqual(store.drafts.text(for: key), "쓰던 지시")
        await network.close()
    }

    func testTodoCanCompleteWithoutOptionalAnswerOrFiles() async throws {
        let server = UXInboxServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let review = TodoCompletionReview(todo: try XCTUnwrap(store.todos.first), store: store)
        let accepted = await review.submit(store: store)
        XCTAssertTrue(accepted)
        let body = try XCTUnwrap(server.completions.first)
        XCTAssertNil(body["note"])
        XCTAssertNil(body["fileIds"])
        await network.close()
    }

    func testTodoFailurePreservesInputAndManualRetryUsesSameContent() async throws {
        let server = UXInboxServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let review = TodoCompletionReview(todo: try XCTUnwrap(store.todos.first), store: store)
        review.note = "완료 답"; review.files = [Attachment(id: "proof")]
        server.fail(true)
        let rejected = await review.submit(store: store)
        XCTAssertFalse(rejected)
        XCTAssertNotNil(review.error)
        XCTAssertEqual(review.note, "완료 답")
        XCTAssertEqual(review.files.map(\.id), ["proof"])
        server.fail(false)
        await store.refresh()
        let accepted = await review.submit(store: store)
        XCTAssertTrue(accepted)
        XCTAssertEqual(server.completions.count, 2)
        XCTAssertEqual(server.completions.last?["note"] as? String, "완료 답")
        await network.close()
    }

    func testTodoUploadFailureKeepsAnswerAndExistingFiles() async throws {
        let server = UXInboxServer()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/uploads" { throw URLError(.networkConnectionLost) }
            return try server.handle(request)
        }
        let store = await connect(network)
        defer { store.disconnect() }
        let review = TodoCompletionReview(todo: try XCTUnwrap(store.todos.first), store: store)
        review.note = "남겨야 할 답"; review.files = [Attachment(id: "previous")]
        let source = try PhotoAttachmentFile.write(Data("proof".utf8), filename: "proof.txt")
        defer { source.cleanup() }
        await review.upload([source.url], store: store)
        XCTAssertNotNil(review.error)
        XCTAssertFalse(review.error?.contains("NSURLErrorDomain") ?? true)
        XCTAssertEqual(review.note, "남겨야 할 답")
        XCTAssertEqual(review.files.map(\.id), ["previous"])
        XCTAssertFalse(review.uploading)
        XCTAssertTrue(server.completions.isEmpty)
        await network.close()
    }

    func testTodoDoubleConfirmUsesOneRequest() async throws {
        let gate = UXInboxGate(), server = UXInboxServer(gate: nil)
        let network = try IsolatedTestNetwork { request in
            var reply = try server.handle(request)
            if request.url?.path == "/api/todos/todo/done" { reply.beforeDelivery = { await gate.wait() } }
            return reply
        }
        let store = await connect(network)
        defer { store.disconnect() }
        let review = TodoCompletionReview(todo: try XCTUnwrap(store.todos.first), store: store)
        let first = Task { await review.submit(store: store) }
        try await eventually { review.sending }
        let duplicate = await review.submit(store: store)
        XCTAssertFalse(duplicate)
        await gate.release()
        let accepted = await first.value
        XCTAssertTrue(accepted)
        XCTAssertEqual(server.completions.count, 1)
        await network.close()
    }

    func testTodoUploadUsesExistingUploadAPIAndCannotCrossConnectionReset() async throws {
        let network = try IsolatedTestNetwork(handler: UXInboxServer().handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let review = TodoCompletionReview(todo: try XCTUnwrap(store.todos.first), store: store)
        let source = try PhotoAttachmentFile.write(Data("proof".utf8), filename: "proof.txt")
        defer { source.cleanup() }
        await review.upload([source.url], store: store)
        XCTAssertEqual(review.files.map(\.id), ["upload"])
        XCTAssertTrue(store.drafts.files(for: DraftStore.key(project: "p", target: "worker")).isEmpty)
        store.disconnect()
        XCTAssertFalse(review.isCurrent(in: store))
        let accepted = await review.submit(store: store)
        XCTAssertFalse(accepted)
        XCTAssertFalse(network.requests.contains { $0.url?.path == "/api/todos/todo/done" })
        await network.close()
    }

    func testMissingReportOpensItsMessageAndEmployeeWithoutRetryingWork() {
        let router = Router()
        let notice = MissingReportNotice(kind: "missing_report", runId: "run", memberId: "worker", messageId: "message", createdAt: "", title: "결과 보고 누락")
        HomeView.openReport(notice, members: [Member(id: "worker", kind: "worker")], router: router)
        XCTAssertEqual(router.destination, .chat)
        XCTAssertEqual(router.chatTarget, "worker")
        XCTAssertEqual(router.chatMessageID, "message")
        router.openMember(notice.memberId)
        XCTAssertTrue(router.memberID == "worker" || router.phonePaths[.chat]?.last == .member("worker"))
    }

    func testStalledNoticeOnlyUsesExistingSafeRecheck() {
        let notice = DeliveryNoticeItem(id: "delivery", deliveryId: "delivery", phase: .needsOwner,
            reason: "stalled", version: 2, recommendation: DeliveryRecommendation(code: "recheck", text: "다시 확인"),
            allowedActions: [.recheck, .retryWithRisk])
        XCTAssertEqual(deliveryPanelActions(notice), [.recheck])
        XCTAssertNotNil(waitReasonLabel("run_limit", since: "2026-11-09T00:00:00Z", used: 4, limit: 4, now: now))
        XCTAssertEqual(waitReasonTone("approval"), .attention)
    }

    func testRuntimeRequestIsSetBeforeOpeningAndRepeatsForOpenSettings() {
        let router = Router(), navigation = SettingsNavigation.shared
        let originalPending = navigation.pendingRuntime
        defer { navigation.pendingRuntime = originalPending }
        let revision = navigation.revision
        for _ in 0..<2 {
            navigation.pendingRuntime = false
            HomeView.openRuntime(router: router) { XCTAssertTrue(navigation.pendingRuntime) }
            XCTAssertTrue(navigation.pendingRuntime)
        }
        XCTAssertEqual(navigation.revision, revision + 2)
    }
}
