import Foundation
import XCTest
@testable import IAMCEO

private actor UXReadGate {
    private var opened = false
    private var waiting: [TestDeadlineContinuation<Void, Never>] = []
    private(set) var entered = false
    func wait() async {
        entered = true
        guard !opened else { return }
        await withTestDeadline(fallback: ()) { waiting.append($0) }
    }
    func open() { opened = true; waiting.forEach { $0.resume() }; waiting = [] }
}

/// URLProtocol-only fixtures. No real sockets, vendor processes, app defaults, or live credentials.
private final class UXStateServer: @unchecked Sendable {
    static let serverID = "277551bf-cf60-4ecd-a450-1fd3e695a8d8"
    private let lock = NSLock()
    private var gates: [String: UXReadGate] = [:]
    private var stateStatus: [String: Int] = [:]
    private var connectionOK = true
    private var projects = ["hq", "p", "q"]
    func hold(_ path: String, gate: UXReadGate) { lock.withLock { gates[path] = gate } }
    func fail(_ project: String, status: Int) { lock.withLock { stateStatus[project] = status } }
    func setConnection(_ ok: Bool) { lock.withLock { connectionOK = ok } }
    func setProjects(_ ids: [String]) { lock.withLock { projects = ids } }
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        let path = request.url!.path
        let (gate, statuses, ok, ids) = lock.withLock { (gates[path], stateStatus, connectionOK, projects) }
        func reply<T: Encodable>(_ value: T, status: Int = 200) throws -> IsolatedTestHTTPReply {
            IsolatedTestHTTPReply(status: status, data: try JSONEncoder().encode(value), beforeDelivery: { if let gate { await gate.wait() } })
        }
        if path == "/api/bootstrap" {
            return try reply(Bootstrap(projects: ids.map { ProjectSummary(id: $0, name: "Summary-\($0)", isHq: $0 == "hq") }))
        }
        if path == "/api/capabilities" { return try reply(ServerCapabilities(contractVersion: 2, capabilities: CapabilityFlags())) }
        if path == "/api/push/status" {
            return try reply(PushStatus(serverId: Self.serverID, supported: true, providers: []))
        }
        let parts = path.split(separator: "/").map(String.init)
        if parts.count == 4, parts[1] == "projects", parts[3] == "state" {
            let id = parts[2]
            return try reply(ProjectState(project: Project(id: id, name: "State-\(id)", connection: ProjectConnection(ok: ok)),
                members: [Member(id: "lead-\(id)", projectId: id, kind: "conductor"), Member(id: "a", projectId: id), Member(id: "b", projectId: id)]), status: statuses[id] ?? 200)
        }
        if parts.count == 4, parts[1] == "projects", parts[3] == "messages", request.httpMethod == "POST" {
            let body = try WriteTestServer.body(request)
            return try reply(Message(id: try XCTUnwrap(body["id"] as? String), projectId: parts[2], mine: true,
                body: body["text"] as? String ?? "", targetMemberId: body["targetMemberId"] as? String))
        }
        if path == "/api/decisions/d" { return try reply(Decision(id: "d", projectId: "q", status: "answered")) }
        return IsolatedTestHTTPReply(status: 404, beforeDelivery: { if let gate { await gate.wait() } })
    }
}

@MainActor final class UXAppStateTests: XCTestCase {
    // 공용 pollUntil(TestSupport)을 부르는 얇은 껍데기. 기한은 느린 CI 러너에 맞춘 공용 기본값(10초)을 쓴다.
    private func eventually(_ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        await pollUntil("State did not settle", file: file, line: line, condition)
    }
    private func makeStore(_ network: IsolatedTestNetwork, defaults: UserDefaults? = nil) -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false, navigationDefaults: defaults)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        return store
    }
    private func link() throws -> NotificationLink {
        try XCTUnwrap(NotificationLink(url: URL(string: "iamceo://open/\(UXStateServer.serverID)/projects/q/decisions/d")!))
    }


    func testCompletedCapabilityFailuresAllowFreshLegacyWritesAndNeverProbeSync() async throws {
        for failure in ["404", "501", "503", "timeout", "resourceUnavailable", "malformed"] {
            let server = UXStateServer()
            let network = try IsolatedTestNetwork { request in
                if request.url?.path == "/api/capabilities" {
                    if failure == "timeout" { throw URLError(.timedOut) }
                    if failure == "resourceUnavailable" { throw URLError(.resourceUnavailable) }
                    return IsolatedTestHTTPReply(status: Int(failure) ?? 200, data: Data("not JSON".utf8))
                }
                return try server.handle(request)
            }
            let store = makeStore(network)
            await store.connect()
            XCTAssertEqual(store.connectionStatus, .connected, failure)
            XCTAssertTrue(store.uiCanWrite, failure)
            let sent = await store.sendMessage(text: "fresh write")
            XCTAssertTrue(sent, failure)
            XCTAssertFalse(network.requests.contains { $0.url?.path == "/api/sync" })
            XCTAssertTrue(network.requests.filter { $0.httpMethod == "POST" }.allSatisfy {
                $0.value(forHTTPHeaderField: "X-IAMCEO-Contract") == nil
            })
            store.disconnect(); await network.close()
        }
    }


    func testBackgroundedCapabilityProbeIsRetriedOnForegroundWithoutPermanentWriteLock() async throws {
        let server = UXStateServer(), capabilities = UXReadGate()
        server.hold("/api/capabilities", gate: capabilities)
        let network = try IsolatedTestNetwork(handler: server.handle), store = makeStore(network)
        defer { store.disconnect() }
        let connection = Task { await store.connect() }
        await eventually { store.state?.project.id == "hq" }
        XCTAssertFalse(store.uiCanWrite)
        store.setForeground(false)
        await capabilities.open(); await connection.value
        XCTAssertFalse(store.uiCanWrite)
        store.setForeground(true)
        await eventually { store.uiCanWrite }
        XCTAssertTrue(store.uiCanWrite)
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/api/capabilities" }.count, 2)
    }

    func testCapabilityAuthenticationFailureNeverOpensWrites() async throws {
        let server = UXStateServer()
        let network = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/capabilities" { return IsolatedTestHTTPReply(status: 401) }
            return try server.handle(request)
        }
        let store = makeStore(network)
        defer { store.disconnect() }
        await store.connect()
        XCTAssertFalse(store.canWrite); XCTAssertNil(store.api)
        XCTAssertFalse(network.requests.contains { $0.httpMethod == "POST" })
    }

    func testResendSharesSendTargetLockAndRejectsAnotherProjectMessage() async throws {
        let server = UXStateServer(), network = try IsolatedTestNetwork(handler: server.handle), store = makeStore(network)
        defer { store.disconnect() }
        await store.connect(); await store.selectProject(id: "p")
        let held = UXReadGate(); server.hold("/api/projects/p/messages", gate: held)
        let message = Message(id: "failed", projectId: "p", mine: true, body: "retry", targetMemberId: "a", delivery: "failed")
        let retry = Task { await store.resend(message) }
        await eventually { await held.entered }
        XCTAssertTrue(store.isSending(projectID: "p", targetMemberID: "a"))
        XCTAssertFalse(store.isSending(projectID: "p", targetMemberID: "b"))
        let duplicate = await store.sendMessage(text: "duplicate", targetMemberID: "a")
        XCTAssertFalse(duplicate)
        let other = Task { await store.sendMessage(text: "other", targetMemberID: "b") }
        await eventually { store.isSending(projectID: "p", targetMemberID: "b") }
        await held.open()
        let retried = await retry.value, sentOther = await other.value
        XCTAssertTrue(retried); XCTAssertTrue(sentOther)
        await store.selectProject(id: "q")
        let wrongProject = await store.resend(message)
        XCTAssertFalse(wrongProject)
        XCTAssertFalse(network.requests.contains { $0.url?.path == "/api/projects/q/messages" })
    }

    func testCacheBoundsEvictionArchiveSeparationAndOversizedEntry() async throws {
        var cache = ProjectStateCache(countLimit: 2, byteLimit: 4096)
        for id in ["p", "q"] { await cache.insert(ProjectState(project: Project(id: id))) }
        XCTAssertNotNil(cache.value(projectID: "p", archived: false))
        await cache.insert(ProjectState(project: Project(id: "r")))
        XCTAssertNil(cache.value(projectID: "q", archived: false), "Least recently read entry is evicted")
        XCTAssertNotNil(cache.value(projectID: "p", archived: false))
        await cache.insert(ProjectState(project: Project(id: "p", archived: true)))
        XCTAssertNotNil(cache.value(projectID: "p", archived: true))
        XCTAssertNotNil(cache.value(projectID: "p", archived: false))
        await cache.insert(ProjectState(project: Project(id: "large", now: String(repeating: "x", count: 5000))))
        XCTAssertNil(cache.value(projectID: "large", archived: false))
        XCTAssertLessThanOrEqual(cache.count, 2); XCTAssertLessThanOrEqual(cache.byteCount, 4096)
        cache.remove(projectID: "p"); XCTAssertEqual(cache.byteCount, 0)
        var disabled = ProjectStateCache(countLimit: -1, byteLimit: -1)
        await disabled.insert(ProjectState(project: Project(id: "p")))
        XCTAssertEqual(disabled.count, 0)
        var bytes = ProjectStateCache(countLimit: 20, byteLimit: 1300)
        for n in 0..<10 { await bytes.insert(ProjectState(project: Project(id: "\(n)", now: String(repeating: "x", count: 500)))) }
        XCTAssertLessThanOrEqual(bytes.byteCount, 1300); XCTAssertLessThan(bytes.count, 10)
    }

    func testWorkspaceReadsBeforeCatalogAndCapabilitiesAndWritesStayClosed() async throws {
        let server = UXStateServer(), models = UXReadGate(), capabilities = UXReadGate()
        server.hold("/api/models", gate: models); server.hold("/api/capabilities", gate: capabilities)
        let network = try IsolatedTestNetwork(handler: server.handle), store = makeStore(network)
        defer { store.disconnect() }
        let connect = Task { await store.connect() }
        await eventually { store.state?.project.id == "hq" }
        XCTAssertEqual(store.currentProjectName, "State-hq")
        XCTAssertFalse(store.uiCanWrite); XCTAssertEqual(store.writeBlockedReason, "최신 상태를 다시 확인하는 중입니다")
        await capabilities.open()
        await connect.value
        XCTAssertTrue(store.uiCanWrite, "Catalog discovery cannot hold the read or write screen hostage")
        await models.open()
    }

    func testLateStrictCapabilityDiscoveryStillLoadsCurrentWriteRevisions() async throws {
        let server = WriteTestServer(), capabilities = UXReadGate()
        let network = try IsolatedTestNetwork { request in
            var reply = try server.handle(request)
            if request.url?.path == "/api/capabilities" { reply.beforeDelivery = { await capabilities.wait() } }
            return reply
        }
        let store = makeStore(network)
        defer { store.disconnect() }
        let connect = Task { await store.connect() }
        await eventually { store.state?.project.id == "p" }
        XCTAssertFalse(store.canWrite)
        await capabilities.open(); await connect.value
        XCTAssertEqual(store.writeRevisions?.settings, 1)
        XCTAssertNotNil(store.writeRevisions?.members?["m"])
        XCTAssertTrue(store.canWrite)
    }

    func testSelectionImmediatelyShowsCacheButCannotWriteUntilNewRead() async throws {
        let server = UXStateServer(), network = try IsolatedTestNetwork(handler: server.handle), store = makeStore(network)
        defer { store.disconnect() }
        await store.connect(); await store.selectProject(id: "p"); await store.selectProject(id: "hq")
        let held = UXReadGate(); server.hold("/api/projects/p/state", gate: held)
        let selection = Task { await store.selectProject(id: "p") }
        await eventually { await held.entered }
        XCTAssertEqual(store.state?.project.id, "p"); XCTAssertEqual(store.currentProjectName, "State-p")
        XCTAssertFalse(store.uiCanWrite); XCTAssertEqual(store.writeBlockedReason, "프로젝트를 불러오는 중입니다")
        await held.open(); await selection.value
        XCTAssertTrue(store.uiCanWrite)
    }

    func testLateSelectionCannotOverwriteCurrentProjectAndFailedCacheNeverOpensWrites() async throws {
        let server = UXStateServer(), network = try IsolatedTestNetwork(handler: server.handle), store = makeStore(network)
        defer { store.disconnect() }
        await store.connect(); await store.selectProject(id: "p"); await store.selectProject(id: "hq")
        let held = UXReadGate(); server.hold("/api/projects/p/state", gate: held)
        let oldSelection = Task { await store.selectProject(id: "p") }
        await eventually { await held.entered }
        await store.selectProject(id: "hq")
        await held.open(); await oldSelection.value
        XCTAssertEqual(store.selectedProjectID, "hq"); XCTAssertEqual(store.state?.project.id, "hq")
        server.fail("p", status: 503)
        await store.selectProject(id: "p")
        XCTAssertEqual(store.state?.project.id, "p", "A failed refresh still leaves the cached reader available")
        XCTAssertFalse(store.uiCanWrite); XCTAssertNotNil(store.writeBlockedReason)
    }

    func testUncachedTitleUsesSummaryAndReselectDoesNotClearOrResetNavigation() async throws {
        let server = UXStateServer(), network = try IsolatedTestNetwork(handler: server.handle), store = makeStore(network)
        let router = Router(destination: .files); store.registerRouter(router)
        defer { store.disconnect() }
        await store.connect()
        let held = UXReadGate(); server.hold("/api/projects/p/state", gate: held)
        let selection = Task { await store.selectProject(id: "p") }
        await eventually { await held.entered }
        XCTAssertNil(store.state); XCTAssertEqual(store.currentProjectName, "Summary-p")
        await held.open(); await selection.value
        router.fileID = "kept"; router.go(.files)
        let revision = router.navigationRevision, reset = router.projectResetRevision
        await store.selectProject(id: "p")
        XCTAssertEqual(store.state?.project.id, "p"); XCTAssertEqual(router.fileID, "kept")
        XCTAssertEqual(router.navigationRevision, revision); XCTAssertEqual(router.projectResetRevision, reset)
    }

    func testAddressScopedProjectAndTabRestorationAndMissingProjectFallsBackToHQ() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "iamceo.ux-t4.tests.\(UUID().uuidString)"))
        // Only this test's isolated defaults domain is touched.
        let server = UXStateServer(), network = try IsolatedTestNetwork(handler: server.handle)
        let key = "iamceo.navigation.v1." + DraftStore.endpointNamespace(network.endpoint)
        defer { defaults.removeObject(forKey: key) }
        let first = makeStore(network, defaults: defaults), router = Router()
        first.registerRouter(router); await first.connect(); await first.selectProject(id: "p"); router.go(.files)
        first.disconnect()
        let second = makeStore(network, defaults: defaults), restored = Router()
        second.registerRouter(restored); await second.connect()
        XCTAssertEqual(second.selectedProjectID, "p"); XCTAssertEqual(restored.destination, .files)
        second.disconnect()
        server.setProjects(["q", "hq"])
        let missing = makeStore(network, defaults: defaults)
        await missing.connect(); XCTAssertEqual(missing.selectedProjectID, "hq"); missing.disconnect()
        let otherNetwork = try IsolatedTestNetwork(handler: server.handle), other = makeStore(otherNetwork, defaults: defaults), otherRouter = Router()
        let otherKey = "iamceo.navigation.v1." + DraftStore.endpointNamespace(otherNetwork.endpoint)
        defer { defaults.removeObject(forKey: otherKey) }
        other.registerRouter(otherRouter); await other.connect()
        XCTAssertEqual(other.selectedProjectID, "hq"); XCTAssertEqual(otherRouter.destination, .home)
        other.disconnect()
    }

    func testSoftReconnectKeepsRouteProjectDraftAndHistoryGeneration() async throws {
        let server = UXStateServer(), network = try IsolatedTestNetwork(handler: server.handle), store = makeStore(network)
        let router = Router(); store.registerRouter(router)
        defer { store.disconnect() }
        await store.connect(); await store.selectProject(id: "p"); await store.activateHistory()
        router.go(.files); router.fileID = "file"; router.terminalMemberID = "a"
        let historyKey = store.histories.activeKey, reset = router.projectResetRevision
        let draftKey = DraftStore.key(project: "p", target: "a"); store.drafts.setText("keep me", for: draftKey)
        let held = UXReadGate(); server.hold("/api/projects/p/state", gate: held)
        let reconnect = Task { await store.connect() }
        await eventually { await held.entered }
        XCTAssertEqual(store.selectedProjectID, "p"); XCTAssertEqual(store.state?.project.id, "p")
        XCTAssertEqual(router.destination, .files); XCTAssertEqual(router.fileID, "file"); XCTAssertEqual(router.terminalMemberID, "a")
        XCTAssertEqual(router.projectResetRevision, reset); XCTAssertEqual(store.histories.activeKey, historyKey)
        XCTAssertEqual(store.writeBlockedReason, "최신 상태를 다시 확인하는 중입니다")
        await held.open(); await reconnect.value
        XCTAssertEqual(store.drafts.text(for: draftKey), "keep me"); XCTAssertTrue(store.canWrite)
        // Background reconnect is deferred and retains its existing project and navigation.
        store.setForeground(false); await store.connect()
        XCTAssertEqual(router.projectResetRevision, reset); XCTAssertEqual(store.selectedProjectID, "p")
        store.setForeground(true)
    }

    func testRestartRealtimeClosesOldSocketAndStartsANewOneWithoutResettingRouter() async throws {
        let server = CoordinatorServer(), clock = CoordinatorClock(), factory = CoordinatorSockets()
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = AppStore(session: network.session, persistCredentials: false,
            realtime: RealtimeClient(factory: factory, clock: clock), clock: clock)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        let router = Router(); store.registerRouter(router)
        defer { store.disconnect() }
        await store.connect()
        await eventually { await factory.sockets.count == 1 }
        guard let old = await factory.sockets.first else { XCTFail("Expected the initial coordinator socket"); return }
        let reset = router.projectResetRevision
        router.go(.files); router.terminalMemberID = "m"
        await store.restartRealtime()
        await eventually { await factory.sockets.count == 2 }
        let closes = await old.closeCount
        XCTAssertEqual(closes, 1); XCTAssertEqual(router.projectResetRevision, reset)
        XCTAssertEqual(router.destination, .files); XCTAssertEqual(router.terminalMemberID, "m")
        XCTAssertEqual(store.selectedProjectID, "p"); XCTAssertTrue(store.canWrite)
    }

    func testScopedSendActionsAllowOtherRecipientAndProjectWithoutDuplicatingSameTarget() async throws {
        let server = UXStateServer(), network = try IsolatedTestNetwork(handler: server.handle), store = makeStore(network)
        defer { store.disconnect() }
        await store.connect(); await store.selectProject(id: "p")
        let held = UXReadGate(); server.hold("/api/projects/p/messages", gate: held)
        let first = Task { await store.sendMessage(text: "one", targetMemberID: "a") }
        await eventually { await held.entered }
        XCTAssertTrue(store.isSending(projectID: "p", targetMemberID: "a"))
        XCTAssertFalse(store.isSending(projectID: "p", targetMemberID: "b"))
        let duplicate = await store.sendMessage(text: "duplicate", targetMemberID: "a")
        XCTAssertFalse(duplicate)
        let second = Task { await store.sendMessage(text: "two", targetMemberID: "b") }
        await eventually { store.isSending(projectID: "p", targetMemberID: "b") }
        await store.selectProject(id: "q")
        let other = await store.sendMessage(text: "three", targetMemberID: "a")
        XCTAssertTrue(other)
        await held.open()
        let firstSent = await first.value, secondSent = await second.value
        XCTAssertTrue(firstSent); XCTAssertTrue(secondSent)
        XCTAssertEqual(network.requests.filter { $0.url?.path == "/api/projects/p/messages" && $0.httpMethod == "POST" }.count, 2)
    }

    func testWriteBlockReasonsCoverDemoLoadingRevalidationConnectionAndRunner() async throws {
        // F8: 샘플은 읽기 전용이 아니다. 샘플 서버에 붙으면 쓰기를 막는 까닭이 없다.
        let demo = AppStore(demo: true, persistCredentials: false)
        defer { demo.prepareForReplacement() }
        try await waitWhile({ demo.writeBlockedReason != nil }, timeout: .seconds(15))
        let server = UXStateServer(), network = try IsolatedTestNetwork(handler: server.handle), store = makeStore(network)
        defer { store.disconnect() }
        XCTAssertFalse(store.showsOffline)
        XCTAssertEqual(store.writeBlockedReason, "잠시 연결을 확인하는 중")
        await store.connect(); XCTAssertNil(store.writeBlockedReason)
        server.setConnection(false); await store.refresh()
        XCTAssertEqual(store.writeBlockedReason, "프로젝트의 실행 연결을 확인해 주세요"); XCTAssertFalse(store.uiCanWrite)
        server.fail("hq", status: 503); await store.refresh()
        XCTAssertFalse(store.showsOffline, "One failed read cannot confirm a connection loss")
        XCTAssertEqual(store.connectionStatus, .connected)
        XCTAssertEqual(store.state?.project.id, "hq")
        XCTAssertEqual(store.writeBlockedReason, "잠시 연결을 확인하는 중"); XCTAssertFalse(store.uiCanWrite)
    }

    func testNotificationMovesImmediatelyChecksInParallelAndUserTabCancels() async throws {
        let server = UXStateServer(), network = try IsolatedTestNetwork(handler: server.handle), store = makeStore(network)
        defer { store.disconnect() }
        await store.connect(); XCTAssertEqual(store.serverID, UXStateServer.serverID)
        let state = UXReadGate(), decision = UXReadGate()
        server.hold("/api/projects/q/state", gate: state); server.hold("/api/decisions/d", gate: decision)
        let inbox = NotificationInbox(), router = Router()
        inbox.receive(try link(), tapped: true)
        let navigation = Task { await store.processNotifications(router: router, inbox: inbox) }
        await eventually { await state.entered }
        await eventually { await decision.entered }
        XCTAssertEqual(router.destination, .inbox); XCTAssertTrue(router.isOpeningNotification)
        router.go(.files); XCTAssertFalse(router.isOpeningNotification)
        await state.open(); await decision.open(); await navigation.value
        XCTAssertEqual(router.destination, .files); XCTAssertNil(router.decisionID); XCTAssertEqual(store.selectedProjectID, "hq")
        await store.processNotifications(router: router, inbox: inbox)
        XCTAssertEqual(router.destination, .files, "A canceled tap must not reopen on the next refresh")
    }

    func testRouterPhoneStacksReturnToOriginAndSettingsLinkRequestsMainWindow() {
        let router = Router(usesPhoneNavigation: true)
        router.openMember("a"); router.openFile("f")
        XCTAssertEqual(router.destination, .home)
        XCTAssertEqual(router.phonePaths[.home], [.member("a"), .file("f")])
        router.path(for: .home).wrappedValue.removeLast()
        XCTAssertEqual(router.phonePaths[.home], [.member("a")])
        router.go(.team); XCTAssertTrue(router.phonePaths[.team, default: []].isEmpty); XCTAssertNil(router.memberID)
        router.go(.files); XCTAssertTrue(router.phonePaths[.files, default: []].isEmpty); XCTAssertNil(router.fileID)
        router.go(.home); router.path(for: .home).wrappedValue.removeLast()
        XCTAssertEqual(router.phonePaths[.home], [])
        router.go(.inbox); router.go(.chat)
        XCTAssertEqual(router.visitedDestinations, Set(Destination.allCases), "All visited Mac panes have stable identities")
        router.showSettings = true
        let request = router.mainWindowRequest
        router.showInMainWindow(.chat)
        XCTAssertEqual(router.mainWindowRequest, request + 1); XCTAssertFalse(router.showSettings)
        XCTAssertEqual(router.destination, .chat)
        router.openMember("a"); router.resetForProjectChange(); XCTAssertTrue(router.phonePaths.isEmpty)
    }
}
