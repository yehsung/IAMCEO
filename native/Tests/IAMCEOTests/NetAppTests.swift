import Foundation
import XCTest
@testable import IAMCEO

private final class NetAppServer: @unchecked Sendable {
    private let lock = NSLock()
    private var outage: APIOutage? = APIOutage(since: "2026-11-10T00:00:00Z", affectedMemberIds: ["m", "n"], lastProbeAt: nil)
    private var answered = false
    private var down = false
    private var failure = false
    private var keepLimited = false
    private var resumeAttempts = 0
    private let sync: Bool
    init(sync: Bool = false) { self.sync = sync }
    func clearOutage() { lock.withLock { outage = nil } }
    func setDown(_ value: Bool) { lock.withLock { down = value } }
    func failAnswer(_ value: Bool) { lock.withLock { failure = value } }
    func remainLimited() { lock.withLock { keepLimited = true } }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        try lock.withLock {
            if down { throw URLError(.notConnectedToInternet) }
            func reply<T: Encodable>(_ value: T) throws -> IsolatedTestHTTPReply {
                IsolatedTestHTTPReply(data: try JSONEncoder().encode(value))
            }
            let bootstrap = Bootstrap(apiOutage: sync ? nil : outage, projects: [ProjectSummary(id: "p")])
            let card = Decision(id: "limit", projectId: "p", kind: "usage_limit",
                usageLimit: UsageLimit(cli: "claude", resetsAt: "2026-11-13T01:00:00Z", memberIds: ["m", "n"], stillLimited: true),
                title: "서버가 정한 제목", detail: "서버가 정한 본문",
                options: [DecisionOption(k: "resume", label: "서버 선택지")], rec: "resume",
                group: "shared", status: answered ? "answered" : "open", updatedAt: resumeAttempts > 0 ? "v2" : "v1")
            let state = ProjectState(project: Project(id: "p", connection: ProjectConnection(ok: true)),
                members: [Member(id: "m", name: "민지"), Member(id: "n", name: "준호")], decisions: [card])
            switch request.url?.path {
            case "/api/bootstrap": return try reply(bootstrap)
            case "/api/capabilities":
                return sync ? try reply(ServerCapabilities(contractVersion: 2, capabilities: CapabilityFlags(realtime: true))) : IsolatedTestHTTPReply(status: 404)
            case "/api/projects/p/state": return try reply(state)
            case "/api/sync":
                let id = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "projectId" }?.value
                return try reply(SyncSnapshot(protocolVersion: 2, cursor: SyncCursor(epoch: "net-app", seq: 1),
                    requestedProjectId: id, projectStatus: id == nil ? .none : .ok, bootstrap: bootstrap,
                    state: id == nil ? nil : state, revisions: nil, apiOutage: outage))
            case "/api/decisions/limit/answer":
                if failure { return IsolatedTestHTTPReply(status: 503) }
                resumeAttempts += 1
                answered = !keepLimited
                var result = card
                result.status = answered ? "answered" : "open"; result.choice = "resume"
                return try reply(result)
            default: return IsolatedTestHTTPReply(status: 404)
            }
        }
    }
}

private actor NetAppGate {
    private var waiter: TestDeadlineContinuation<Void, Never>?
    private var released = false
    func wait() async {
        guard !released else { return }
        await withTestDeadline(fallback: ()) { waiter = $0 }
    }
    func release() { released = true; waiter?.resume(); waiter = nil }
}

@MainActor final class NetAppTests: XCTestCase {
    private func connect(_ network: IsolatedTestNetwork) async -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString
        store.accessCode = "fixture-only"
        await store.connect()
        store.setForeground(false)
        XCTAssertTrue(store.canWrite)
        return store
    }

    func testOutageStripPresenceCountToneAndServerConnectionPrecedence() {
        let outage = APIOutage(since: "now", affectedMemberIds: ["a", "b", "a"], lastProbeAt: nil)
        let info = APIOutageInfo(outage, showsOffline: false)
        XCTAssertEqual(info?.text, "인터넷 연결이 불안정합니다 · 직원 2명 대기 중 · 돌아오면 자동으로 이어 갑니다")
        XCTAssertEqual(info?.tone, .attention)
        XCTAssertNil(APIOutageInfo(nil, showsOffline: false))
        XCTAssertNil(APIOutageInfo(outage, showsOffline: true))
        XCTAssertTrue(APIOutageInfo(APIOutage(since: "now", affectedMemberIds: [], lastProbeAt: nil), showsOffline: false)?.text.contains("직원 0명") == true)
    }

    func testThreeStatusLabelsAndDotsShareAttentionIncludingOffice() {
        for (code, label) in [("network_outage", "인터넷 끊김으로 멈춤"), ("network_retry", "네트워크 재시도 중"), ("usage_limit", "사용 한도 도달")] {
            for freshness in ["fresh", "stale", nil] as [String?] {
                let member = Member(status: "error", statusObservation: StatusObservation(freshness: freshness, ownership: "verified", error: ObservationError(code: code, note: "technical")))
                let info = MemberStatusInfo(member)
                XCTAssertEqual(info.label, label)
                XCTAssertEqual(info.tone, .attention)
                XCTAssertFalse(info.live)
                XCTAssertEqual(officeStateLabel(member), label)
                XCTAssertEqual(MemberStatusInfo(code).tone, .attention)
            }
        }
        // The office's unavailable-state ring uses this same shared tone.
        XCTAssertEqual(MemberStatusInfo("unknown").tone, .attention)
        let conflict = Member(status: "error", statusObservation: StatusObservation(ownership: "conflict", error: ObservationError(code: "network_outage", note: "")))
        XCTAssertEqual(MemberStatusInfo(conflict).label, "소유 관계 확인 필요")
    }

    func testNetworkObservationOnlyRequiresContractErrorCode() throws {
        let member = try JSONDecoder().decode(Member.self, from: Data(#"{"id":"m","status":"error","statusObservation":{"error":{"code":"network_outage"}}}"#.utf8))
        XCTAssertEqual(MemberStatusInfo(member).label, "인터넷 끊김으로 멈춤")
        XCTAssertEqual(member.statusObservation?.error?.note, "")
    }

    func testOldServerAndExplicitNullCompatibility() throws {
        let decoder = JSONDecoder()
        XCTAssertNil(try decoder.decode(Bootstrap.self, from: Data(#"{"projects":[]}"#.utf8)).apiOutage)
        XCTAssertNil(try decoder.decode(Bootstrap.self, from: Data(#"{"projects":[],"apiOutage":null}"#.utf8)).apiOutage)
        let decision = try decoder.decode(Decision.self, from: Data(#"{"id":"old","options":[]}"#.utf8))
        XCTAssertNil(decision.kind)
        XCTAssertNil(decision.usageLimit)
        for suffix in ["", #", "apiOutage":null"#] {
            let json = #"{"protocol":2,"cursor":{"epoch":"e","seq":0},"projectStatus":"none","bootstrap":{"projects":[]}"# + suffix + "}"
            XCTAssertNil(try decoder.decode(SyncSnapshot.self, from: Data(json.utf8)).apiOutage)
        }
        let member = try decoder.decode(Member.self, from: Data(#"{"id":"m","status":"working"}"#.utf8))
        XCTAssertEqual(MemberStatusInfo(member).label, "일하는 중")
    }

    func testUsageLimitDetailsRetainServerCopyDateNamesAndWarning() throws {
        let json = #"{"id":"limit","kind":"usage_limit","title":"원문 제목","detail":"원문 본문","options":[{"k":"resume","label":"이어가기"}],"usageLimit":{"cli":"claude","resetsAt":"2026-11-13T01:00:00.000Z","memberIds":["m","missing","m"],"stillLimited":true}}"#
        var card = try JSONDecoder().decode(Decision.self, from: Data(json.utf8))
        let zone = try XCTUnwrap(TimeZone(identifier: "Asia/Seoul"))
        let info = UsageLimitInfo(card, members: [Member(id: "m", name: "민지")], timeZone: zone)
        XCTAssertEqual(card.title, "원문 제목")
        XCTAssertEqual(card.detail, "원문 본문")
        XCTAssertEqual(card.options.map(\.k), ["resume"])
        XCTAssertEqual(info.resumesText, "11월 13일 오전 10시에 자동으로 이어 갑니다")
        XCTAssertEqual(info.memberNames, ["민지", "missing"])
        XCTAssertEqual(info.warning, "아직 같은 계정이라 한도가 남아 있지 않습니다. 다른 계정으로 로그인한 뒤 다시 누르세요.")
        XCTAssertEqual(UsageLimitInfo.resumeLabel, "계정을 바꿨어요 · 모두 이어가기")
        card.usageLimit?.resetsAt = "invalid"; card.usageLimit?.stillLimited = false
        XCTAssertNil(UsageLimitInfo(card, members: []).resumesText)
        XCTAssertNil(UsageLimitInfo(card, members: []).warning)
        card.usageLimit?.resetsAt = "2026-11-13T01:05:00Z"
        XCTAssertEqual(UsageLimitInfo(card, members: [], timeZone: zone).resumesText, "11월 13일 오전 10시 5분에 자동으로 이어 갑니다")
        card.usageLimit = nil
        XCTAssertNil(UsageLimitInfo(card, members: []).resumesText)
        XCTAssertTrue(UsageLimitInfo(card, members: []).memberNames.isEmpty)
    }

    func testUsageLimitIsFirstAndIncludedInBadge() {
        let cards = [Decision(id: "old"), Decision(id: "limit1", kind: "usage_limit"), Decision(id: "regular"), Decision(id: "limit2", kind: "usage_limit")]
        XCTAssertEqual(UsageLimitInfo.prioritized(cards).map(\.id), ["limit1", "limit2", "old", "regular"])
        XCTAssertEqual(InboxHomePolicy.inboxCount(decisions: cards, members: []), 4)
    }

    func testUsageLimitReviewSubmitsResumeWithoutConfirmationAndRejectsStale() {
        let card = Decision(id: "limit", kind: "usage_limit", options: [DecisionOption(k: "resume")], updatedAt: "v1")
        var review = DecisionReview(decision: card)
        XCTAssertFalse(review.canSubmit(comparedTo: card))
        review.choice = UsageLimitInfo.resumeChoice
        XCTAssertTrue(review.canSubmit(comparedTo: card))
        XCTAssertFalse(review.showsConfirmation(comparedTo: card, memoOnly: false))
        review.choice = "approve"
        XCTAssertFalse(review.canSubmit(comparedTo: card))
        review.choice = "resume"
        var latest = card; latest.updatedAt = "v2"
        XCTAssertFalse(review.canSubmit(comparedTo: latest))
        XCTAssertFalse(review.canSubmit(comparedTo: nil))
    }

    func testBootstrapOutageAppearsClearsAndDisconnects() async throws {
        let server = NetAppServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        XCTAssertNotNil(APIOutageInfo(store.apiOutage, showsOffline: store.showsOffline))
        server.clearOutage()
        await store.refresh()
        XCTAssertNil(store.apiOutage)
        XCTAssertNil(APIOutageInfo(store.apiOutage, showsOffline: store.showsOffline))
        store.disconnect()
        XCTAssertNil(store.apiOutage)
        await network.close()
    }

    func testSyncOutageUpdatesEvenAtSameDomainCursorAndKeepsSnapshotOnTransportFailure() async throws {
        let server = NetAppServer(sync: true), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        XCTAssertNil(store.bootstrap?.apiOutage)
        XCTAssertEqual(store.apiOutage?.affectedMemberIds, ["m", "n"])
        server.setDown(true)
        await store.refresh()
        XCTAssertNotNil(store.apiOutage)
        server.setDown(false); server.clearOutage()
        await store.refresh()
        XCTAssertNil(store.apiOutage)
        XCTAssertTrue(network.requests.contains { $0.url?.path == "/api/sync" })
        await network.close()
    }

    func testResumeSendsOneExactAnswerAndCannotBeBatchApproved() async throws {
        let server = NetAppServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let card = try XCTUnwrap(store.decisions.first)
        let batch = await store.answerBatchResults([card])
        XCTAssertEqual(batch[card.id], .notSent)
        XCTAssertFalse(network.requests.contains { $0.url?.path.hasSuffix("/answer") == true })
        let accepted = await store.resumeUsageLimit(card)
        XCTAssertTrue(accepted)
        let requests = network.requests.filter { $0.url?.path == "/api/decisions/limit/answer" }
        XCTAssertEqual(requests.count, 1)
        let body = try WriteTestServer.body(XCTUnwrap(requests.first))
        XCTAssertEqual(body["choice"] as? String, "resume")
        XCTAssertEqual(body["expectedVersion"] as? String, "v1")
        XCTAssertEqual(body["batch"] as? Bool, false)
        XCTAssertNil(body["note"])
        XCTAssertEqual(requests.first?.httpMethod, "POST")
        await network.close()
    }

    func testStillLimitedResponseKeepsNoticeOpenWithFreshVersionForNextResume() async throws {
        let server = NetAppServer()
        server.remainLimited()
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        defer { store.disconnect() }
        let initial = try XCTUnwrap(store.decisions.first)
        let accepted = await store.resumeUsageLimit(initial)
        XCTAssertTrue(accepted)
        let current = try XCTUnwrap(store.decisions.first)
        XCTAssertEqual(current.status, "open")
        XCTAssertEqual(current.updatedAt, "v2")
        XCTAssertNotNil(UsageLimitInfo(current, members: store.members).warning)
        XCTAssertEqual(InboxHomePolicy.inboxCount(decisions: store.decisions, members: store.members), 1)
        let retried = await store.resumeUsageLimit(current)
        XCTAssertTrue(retried)
        let requests = network.requests.filter { $0.url?.path.hasSuffix("/answer") == true }
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(try WriteTestServer.body(XCTUnwrap(requests.last))["expectedVersion"] as? String, "v2")
        await network.close()
    }

    func testRapidResumePressesSendOnlyOneRequest() async throws {
        let server = NetAppServer(), gate = NetAppGate()
        let network = try IsolatedTestNetwork { request in
            var response = try server.handle(request)
            if request.url?.path == "/api/decisions/limit/answer" {
                response.beforeDelivery = { await gate.wait() }
            }
            return response
        }
        let store = await connect(network)
        defer { store.disconnect() }
        let card = try XCTUnwrap(store.decisions.first)
        let first = Task { await store.resumeUsageLimit(card) }
        let deadline = ContinuousClock.now + .seconds(3)
        while !network.requests.contains(where: { $0.url?.path.hasSuffix("/answer") == true }), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(store.pendingActions.contains("decision:limit"))
        let duplicate = await store.resumeUsageLimit(card)
        XCTAssertFalse(duplicate)
        await gate.release()
        let accepted = await first.value
        XCTAssertTrue(accepted)
        XCTAssertEqual(network.requests.filter { $0.url?.path.hasSuffix("/answer") == true }.count, 1)
        await network.close()
    }

    func testResumeFailureKeepsCardAvailableForRetryAndOfflineSendsNothing() async throws {
        let server = NetAppServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let store = await connect(network)
        let card = try XCTUnwrap(store.decisions.first)
        server.failAnswer(true)
        let rejected = await store.resumeUsageLimit(card)
        XCTAssertFalse(rejected)
        XCTAssertEqual(store.decisions.first?.status, "open")
        server.failAnswer(false)
        await store.refresh()
        let accepted = await store.resumeUsageLimit(card)
        XCTAssertTrue(accepted)
        store.disconnect()
        let before = network.requests.count
        let offline = await store.resumeUsageLimit(card)
        XCTAssertFalse(offline)
        XCTAssertEqual(network.requests.count, before)
        await network.close()
    }
}
