import Foundation
import XCTest
@testable import IAMCEO

private actor UXCreationGate {
    private var open = false
    private var waiter: TestDeadlineContinuation<Void, Never>?
    func wait() async {
        if !open { await withTestDeadline(fallback: ()) { waiter = $0 } }
    }
    func release() { open = true; waiter?.resume(); waiter = nil }
}

private final class UXCreationServer: @unchecked Sendable {
    let gate = UXCreationGate()
    private let lock = NSLock()
    private var created = false
    var loseResponse = false
    func handle(_ request: URLRequest) throws -> IsolatedTestHTTPReply {
        try lock.withLock {
            func reply<T: Encodable>(_ value: T) throws -> IsolatedTestHTTPReply {
                IsolatedTestHTTPReply(data: try JSONEncoder().encode(value))
            }
            switch request.url!.path {
            case "/api/bootstrap":
                return try reply(Bootstrap(projects: [ProjectSummary(id: "hq", name: "HQ", isHq: true)]
                    + (created ? [ProjectSummary(id: "new", name: "새 프로젝트", cwd: "/fixture/canonical")] : [])))
            case "/api/projects" where request.httpMethod == "POST":
                created = true
                if loseResponse { throw URLError(.timedOut) }
                var response = try reply(Project(id: "new", name: "새 프로젝트", cwd: "/fixture/canonical"))
                response.beforeDelivery = { await self.gate.wait() }
                return response
            case "/api/projects/hq/state", "/api/projects/new/state":
                let id = request.url!.path.contains("/new/") ? "new" : "hq"
                return try reply(ProjectState(project: Project(id: id, name: id),
                    members: [Member(id: "lead-" + id, projectId: id, kind: "conductor")]))
            case "/api/push/status":
                return try reply(PushStatus(serverId: "277551bf-cf60-4ecd-a450-1fd3e695a8d8", supported: true, providers: []))
            default: return IsolatedTestHTTPReply(status: 404)
            }
        }
    }
}

private final class UXMemoryDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var data: [String: Data] = [:]
    private var flags: [String: Bool] = [:]
    override func data(forKey key: String) -> Data? { lock.withLock { data[key] } }
    override func bool(forKey key: String) -> Bool { lock.withLock { flags[key] ?? false } }
    override func set(_ value: Any?, forKey key: String) {
        lock.withLock { data[key] = value as? Data; flags[key] = value as? Bool }
    }
}

@MainActor private final class UXInvitationOS: PushAuthorizationProvider {
    var onToken: (@MainActor @Sendable (Data, UUID) -> Void)?
    var onFailure: (@MainActor @Sendable (UUID) -> Void)?
    var answer: Bool? = false
    var offers = 0
    var permissionRequests = 0
    var registrations = 0
    var authorization: PushAuthorization = .notDetermined
    var onOffer: (() -> Void)?
    func offerNotificationSetup() async -> Bool? { offers += 1; onOffer?(); return answer }
    func settings() async -> PushSystemSettings {
        PushSystemSettings(authorization: authorization, alertsEnabled: authorization == .authorized, soundsEnabled: false)
    }
    func requestAuthorization() async throws { permissionRequests += 1; authorization = .authorized }
    func register(generation: UUID) -> Bool { registrations += 1; return false }
    func cancelPendingRegistration() {}
    func clearDelivered(serverID: String) async {}
}

#if os(macOS)
@MainActor private final class UXMacDelivery: MacNotificationDelivering {
    var permissions = 0
    var clears = 0
    var permitted = true
    var delivered = 0
    var metadata: Data?
    func requestPermission() async throws -> Bool { permissions += 1; return permitted }
    func deliver(identifier: String, title: String, metadata: Data) async throws { delivered += 1; self.metadata = metadata }
    func deliverNotice(identifier: String, title: String, body: String) async throws { delivered += 1 }
    func clear() { clears += 1 }
}
#endif

@MainActor final class UXSettingsConnectionTests: XCTestCase {
    // 공용 pollUntil(TestSupport)을 부르는 얇은 껍데기. 기한은 느린 CI 러너에 맞춘 공용 기본값(10초)을 쓴다.
    private func eventually(_ condition: () -> Bool) async {
        await pollUntil("Fixture did not settle") { condition() }
    }
    private func event<T: Encodable>(_ type: String, _ value: T) throws -> RealtimeEvent {
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
        return try JSONDecoder().decode(RealtimeEvent.self, from: JSONSerialization.data(withJSONObject: ["type": type, type: object]))
    }
    private func store(_ network: IsolatedTestNetwork) -> AppStore {
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = network.endpoint.url.absoluteString; store.accessCode = "fixture"
        return store
    }

    func testSavedConnectionStartsWithReconnectAndQRRemainsExplicit() {
        XCTAssertTrue(ConnectionRecovery.showsSavedConnection(endpoint: "https://mac.example", accessCode: "code", useQR: false))
        XCTAssertFalse(ConnectionRecovery.showsSavedConnection(endpoint: "https://mac.example", accessCode: "code", useQR: true))
        XCTAssertFalse(ConnectionRecovery.showsSavedConnection(endpoint: " ", accessCode: "code", useQR: false))
        XCTAssertFalse(ConnectionRecovery.showsSavedConnection(endpoint: "https://mac.example", accessCode: "\n", useQR: false))
    }

    func testTypingManualCredentialsDoesNotRestoreSavedConnection() async throws {
        let network = try IsolatedTestNetwork()
        let store = AppStore(session: network.session, persistCredentials: false)
        store.endpoint = ""
        XCTAssertFalse(store.restoredCredentials)
        store.endpoint = "anything"
        store.accessCode = "anything"
        XCTAssertFalse(store.restoredCredentials)
        XCTAssertEqual(store.connectionStatus, .disconnected)
        XCTAssertNil(store.errorMessage)
        XCTAssertFalse(store.isDemo)
        store.disconnect()
        XCTAssertFalse(store.restoredCredentials)
        await network.close()
    }

    func testConnectionFailureExplainsRecoveryWithoutRawSystemErrorOrSleepGuess() {
        let raw = "The operation couldn’t be completed. NSURLErrorDomain -1004 private-canary"
        XCTAssertFalse(ConnectionRecovery.reason(raw).contains("private-canary"))
        XCTAssertFalse(ConnectionRecovery.reason(raw).contains("잠들"))
        XCTAssertTrue(ConnectionRecovery.reason("401 Unauthorized").contains("접속 코드"))
        XCTAssertTrue(ConnectionRecovery.reason("The request timed out.").contains("시간"))
        XCTAssertTrue(ConnectionRecovery.checklist.contains("Wi-Fi"))
        XCTAssertTrue(ConnectionRecovery.checklist.contains("Tailscale"))
        XCTAssertTrue(ConnectionRecovery.checklist.contains("IAMCEO"))
        XCTAssertTrue(ConnectionRecovery.checklist.contains("주소"))
    }

    func testPairingRequiresExplicitSameCodeConnectedSignal() throws {
        for status in ["pending", "claimed", "expired", "invalid", "unknown"] {
            XCTAssertFalse(PairingCompletion(code: "one", status: status).confirms("one"))
        }
        XCTAssertFalse(PairingCompletion(code: "another", status: "connected").confirms("one"))
        let completion = try JSONDecoder().decode(PairingCompletion.self, from: Data(#"{"code":"one","status":"connected"}"#.utf8))
        XCTAssertTrue(completion.confirms("one"))
        XCTAssertThrowsError(try JSONDecoder().decode(PairingCompletion.self, from: Data(#"{"status":"connected"}"#.utf8)))
    }

    func testSettingsCloseProtectsDirtyAndInFlightSaves() {
        XCTAssertEqual(SettingsCloseAction.resolve(dirty: false, saving: false), .close)
        XCTAssertEqual(SettingsCloseAction.resolve(dirty: true, saving: false), .confirm)
        XCTAssertEqual(SettingsCloseAction.resolve(dirty: true, saving: true), .wait)
        XCTAssertEqual(SettingsCloseAction.resolve(dirty: false, saving: true), .wait)
    }

    func testRuntimeRequestSurvivesClosedSettingsAndWorksAgainWhenOpen() {
        let navigation = SettingsNavigation()
        navigation.requestRuntime()
        XCTAssertTrue(navigation.pendingRuntime)
        XCTAssertEqual(navigation.revision, 1)
        navigation.pendingRuntime = false
        navigation.requestRuntime()
        XCTAssertTrue(navigation.pendingRuntime)
        XCTAssertEqual(navigation.revision, 2)
    }

    func testFolderChangeUsesServerCanonicalFolderAndPreservesValidationFailure() async throws {
        let network = try IsolatedTestNetwork { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            if query?.first(where: { $0.name == "path" })?.value == "/fixture/forbidden" { return IsolatedTestHTTPReply(status: 403) }
            return IsolatedTestHTTPReply(data: Data(#"{"path":"/fixture/한글 폴더","home":"/fixture","parent":"/fixture","entries":[]}"#.utf8))
        }
        let listing = try await network.makeAPIClient().folderContents(path: "/fixture/한글 폴더")
        XCTAssertEqual(listing.path, "/fixture/한글 폴더")
        do { _ = try await network.makeAPIClient().folderContents(path: "/fixture/forbidden"); XCTFail("Must preserve server policy") }
        catch let error as APIError { XCTAssertEqual(error.status, 403) }
        await network.close()
    }

    func testCreationFinishesAfterNoticeDismissalAndFirstInstructionTargetsCreatedProject() async throws {
        let server = UXCreationServer(), notice = ProjectCreationNotice()
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = store(network), router = Router(destination: .files)
        await store.connect()
        XCTAssertTrue(store.canWrite)
        let task = Task { await notice.create(store: store, name: "새 프로젝트", cwd: "~/canonical", provider: "codex") }
        await eventually { network.requests.contains { $0.httpMethod == "POST" && $0.url?.path == "/api/projects" } }
        XCTAssertTrue(notice.running)
        notice.clear() // The creation sheet/banner can disappear without cancelling its request.
        await server.gate.release()
        let result = await task.value
        XCTAssertEqual(result, .created("new"))
        XCTAssertFalse(notice.running)
        XCTAssertNotNil(notice.message)
        XCTAssertEqual(notice.projectID, "new")
        router.chatTarget = "old-member"
        await ProjectCreationNotice.openProject("new", store: store, router: router)
        XCTAssertEqual(store.selectedProjectID, "new")
        XCTAssertEqual(router.destination, .chat)
        XCTAssertNil(router.chatTarget)
        XCTAssertEqual(router.focusComposer, 1)
        XCTAssertEqual(network.requests.filter { $0.httpMethod == "POST" && $0.url?.path == "/api/projects" }.count, 1)
        store.disconnect(); await network.close()
    }

    func testLostCreationResponseFindsPartialProjectWithoutAutomaticResend() async throws {
        let server = UXCreationServer(); server.loseResponse = true
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = store(network), notice = ProjectCreationNotice()
        await store.connect()
        let result = await notice.create(store: store, name: "새 프로젝트", cwd: "~/canonical", provider: "claude")
        guard case .partial(let id, _) = result else { XCTFail("Expected saved project after uncertain response"); store.disconnect(); await network.close(); return }
        XCTAssertEqual(id, "new")
        XCTAssertTrue(notice.failed)
        XCTAssertFalse(notice.running)
        XCTAssertEqual(network.requests.filter { $0.httpMethod == "POST" && $0.url?.path == "/api/projects" }.count, 1)
        store.disconnect(); await network.close()
    }

    func testCreationResultIsFencedWhenConnectionChanges() async throws {
        let server = UXCreationServer(), notice = ProjectCreationNotice()
        let network = try IsolatedTestNetwork(handler: server.handle)
        let store = store(network)
        await store.connect()
        let task = Task { await notice.create(store: store, name: "새 프로젝트", cwd: "/fixture/canonical", provider: "claude") }
        await eventually { network.requests.contains { $0.httpMethod == "POST" && $0.url?.path == "/api/projects" } }
        store.disconnect()
        await server.gate.release()
        let result = await task.value
        XCTAssertEqual(result, .hostChanged)
        XCTAssertFalse(notice.running)
        XCTAssertTrue(notice.failed)
        XCTAssertNil(notice.projectID)
        await network.close()
    }

    func testOldCreationCannotReplaceNewerJobNotice() {
        let notice = ProjectCreationNotice(), old = UUID(), latest = UUID()
        notice.begin(id: old, namespace: "old")
        notice.begin(id: latest, namespace: "new")
        notice.finish(id: old, projectID: "foreign", message: "wrong")
        XCTAssertEqual(notice.namespace, "new")
        XCTAssertTrue(notice.running)
        XCTAssertNil(notice.projectID)
    }

    func testNotificationInvitationLaterIsOnceAcrossHostsAndRestarts() async throws {
        let network = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 404) }
        let defaults = UXMemoryDefaults(), os = UXInvitationOS()
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: defaults)
        let host = PushHostContext(serverID: "277551bf-cf60-4ecd-a450-1fd3e695a8d8", endpoint: network.endpoint, service: network.makeAPIClient())
        service.setHost(host)
        await service.foreground(); await service.foreground()
        XCTAssertEqual(os.offers, 1)
        XCTAssertEqual(os.permissionRequests, 0)
        XCTAssertEqual(os.registrations, 0)
        let nextOS = UXInvitationOS()
        let next = PushNotificationService(provider: nextOS, environment: .sandbox, defaults: defaults)
        next.setHost(PushHostContext(serverID: "5868c63d-516d-4896-99c2-44a88c57d01a", endpoint: network.endpoint, service: network.makeAPIClient()))
        await next.foreground()
        XCTAssertEqual(nextOS.offers, 0)
        XCTAssertTrue(network.requests.isEmpty)
        await network.close()
    }

    func testNotificationInvitationNowUsesExistingPermissionFlowAndRejectsStaleHost() async throws {
        let network = try IsolatedTestNetwork { request in
            if request.url?.path == "/api/push/status" {
                return IsolatedTestHTTPReply(data: try JSONEncoder().encode(PushStatus(serverId: "277551bf-cf60-4ecd-a450-1fd3e695a8d8", supported: true, providers: [])))
            }
            return IsolatedTestHTTPReply(data: Data(#"{"devices":[]}"#.utf8))
        }
        let os = UXInvitationOS(); os.answer = true
        let service = PushNotificationService(provider: os, environment: .sandbox, defaults: nil)
        let host = PushHostContext(serverID: "277551bf-cf60-4ecd-a450-1fd3e695a8d8", endpoint: network.endpoint, service: network.makeAPIClient())
        service.setHost(host); await service.foreground()
        XCTAssertEqual(os.permissionRequests, 1)
        XCTAssertEqual(os.registrations, 1)
        let staleOS = UXInvitationOS(); staleOS.answer = true
        let stale = PushNotificationService(provider: staleOS, environment: .sandbox, defaults: nil)
        staleOS.onOffer = { stale.setHost(nil) }
        stale.setHost(host); await stale.foreground()
        XCTAssertEqual(staleOS.permissionRequests, 0)
        XCTAssertEqual(staleOS.registrations, 0)
        await network.close()
    }

    func testMacNotificationsCoverFiveKindsAndSuppressDuplicatesAndSnapshotReplay() throws {
        var tracker = MacNotificationTracker()
        let decision = Decision(id: "d", projectId: "p", status: "open")
        XCTAssertEqual(try tracker.event(event("decision", decision))?.kind, "decision")
        XCTAssertNil(try tracker.event(event("decision", decision)))
        let member = Member(id: "m", projectId: "p", status: "blocked", blockedReason: "selection")
        XCTAssertEqual(try tracker.event(event("member", member))?.target, .team(projectId: "p", memberId: "m"))
        XCTAssertNil(try tracker.event(event("member", member)))
        XCTAssertEqual(try tracker.event(event("todo", Todo(id: "t", projectId: "p")))?.kind, "todo_created")
        let completed = Message(id: "c", projectId: "p", memberId: "m", kind: "완료", body: "private-canary")
        let blocked = Message(id: "b", projectId: "p", memberId: "m", kind: "막힘")
        let result = try tracker.event(event("message", completed))
        XCTAssertEqual(result?.kind, "report_complete")
        XCTAssertFalse(result!.title.contains("private-canary"))
        XCTAssertEqual(try tracker.event(event("message", blocked))?.kind, "report_blocked")
        XCTAssertNil(try tracker.event(event("message", completed)))
        var seeded = MacNotificationTracker()
        seeded.seed(ProjectState(project: Project(id: "p"), members: [member], decisions: [decision],
                                 todos: [Todo(id: "t", projectId: "p")], messages: [completed]))
        XCTAssertNil(try seeded.event(event("decision", decision)))
        XCTAssertNil(try seeded.event(event("member", member)))
        XCTAssertNil(try seeded.event(event("message", completed)))
        XCTAssertNil(try seeded.event(event("todo", Todo(id: "t", projectId: "p"))))
    }

    func testMacNotificationDecisionsReopenAndApprovalReturnsWithoutReportingIdleAsComplete() throws {
        var tracker = MacNotificationTracker()
        _ = try tracker.event(event("decision", Decision(id: "d", projectId: "p", status: "answered")))
        XCTAssertNotNil(try tracker.event(event("decision", Decision(id: "d", projectId: "p", status: "open"))))
        _ = try tracker.event(event("member", Member(id: "m", projectId: "p", status: "blocked", blockedReason: "permission")))
        XCTAssertNil(try tracker.event(event("member", Member(id: "m", projectId: "p", status: "idle"))))
        XCTAssertNotNil(try tracker.event(event("member", Member(id: "m", projectId: "p", status: "blocked", blockedReason: "permission"))))
        XCTAssertNil(try tracker.event(event("message", Message(id: "own", projectId: "p", mine: true, kind: "완료"))))
        XCTAssertNil(try tracker.event(event("message", Message(id: "progress", projectId: "p", kind: "진행"))))
        let stale = Member(id: "stale", projectId: "p", status: "blocked", blockedReason: "permission",
                           statusObservation: StatusObservation(source: "core", freshness: "stale", ownership: "verified"))
        XCTAssertNil(try tracker.event(event("member", stale)))
    }

    func testMacBadgeIncludesEveryProjectAndNotificationVisibilityIsSpecific() {
        XCTAssertEqual(MacNotificationPolicy.badge([ProjectSummary(id: "p", needsCount: 5, inboxCount: 99, blockedCount: 99)]), "5")
        XCTAssertEqual(MacNotificationPolicy.badge([ProjectSummary(id: "p", inboxCount: 2, blockedCount: 1),
                                                    ProjectSummary(id: "q", inboxCount: 4, blockedCount: 3)]), "10")
        XCTAssertNil(MacNotificationPolicy.badge([]))
        XCTAssertNil(MacNotificationPolicy.badge([ProjectSummary(inboxCount: -2, blockedCount: -1)]))
        XCTAssertEqual(MacNotificationPolicy.badge([ProjectSummary(inboxCount: Int.max, blockedCount: 1)]), String(Int.max))
        let target = PushTarget.inbox(projectId: "p", decisionId: "d")
        XCTAssertTrue(MacNotificationPolicy.isVisible(target, frontmost: true, projectID: "p", destination: .inbox,
                                                     decisionID: "d", memberID: nil, chatTarget: nil))
        for (front, project, decision) in [(false, "p", "d"), (true, "q", "d"), (true, "p", "other")] {
            XCTAssertFalse(MacNotificationPolicy.isVisible(target, frontmost: front, projectID: project, destination: .inbox,
                                                          decisionID: decision, memberID: nil, chatTarget: nil))
        }
    }

    func testMacNotificationLinksUseValidatedExistingRoutesWithoutInventedServerEventIDs() throws {
        let server = "277551bf-cf60-4ecd-a450-1fd3e695a8d8"
        for target in [PushTarget.inbox(projectId: "p", decisionId: "d"), .team(projectId: "p", memberId: "m"),
                       .chat(projectId: "p", memberId: "m", messageId: "report")] {
            let link = try XCTUnwrap(MacNotificationPolicy.link(serverID: server, target: target))
            XCTAssertNil(link.eventID)
            XCTAssertEqual(link.serverID, server)
        }
        XCTAssertNil(MacNotificationPolicy.link(serverID: "invalid", target: .inbox(projectId: "p", decisionId: "d")))
        XCTAssertNil(MacNotificationPolicy.link(serverID: server, target: .team(projectId: "../p", memberId: "m")))
    }

    #if os(macOS)
    func testMacNotificationDeliveryRequiresOptInAndUnseenTargetAndUsesT2ScriptAPI() async throws {
        let delivery = UXMacDelivery(), service = MacNotificationService(defaults: nil, delivery: UXMacDelivery())
        let event = MacNotificationEvent(kind: "decision", sourceID: "d", target: .inbox(projectId: "p", decisionId: "d"))
        let server = "277551bf-cf60-4ecd-a450-1fd3e695a8d8"
        await service.notify(event, serverID: server, visible: false)
        XCTAssertFalse(service.enabled)
        let enabled = MacNotificationService(defaults: nil, delivery: delivery)
        let network = try IsolatedTestNetwork { request in
            XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(request.url?.path, "/api/settings")
            let body = try WriteTestServer.body(request)
            XCTAssertEqual(body["macScriptNotifications"] as? Bool, false)
            XCTAssertEqual(Set(body.keys), ["macScriptNotifications"])
            var settings = Settings(); settings.macScriptNotifications = false
            return IsolatedTestHTTPReply(data: try JSONEncoder().encode(settings))
        }
        let configured = await enabled.setEnabled(true, api: network.makeAPIClient())
        XCTAssertTrue(configured)
        await enabled.notify(event, serverID: server, visible: true)
        XCTAssertEqual(delivery.delivered, 0)
        await enabled.notify(event, serverID: server, visible: false)
        XCTAssertEqual(delivery.delivered, 1)
        let metadata = try XCTUnwrap(delivery.metadata)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: metadata) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["serverID", "target"])
        XCTAssertEqual(network.requests.count, 1)
        let refused = try IsolatedTestNetwork { _ in IsolatedTestHTTPReply(status: 404) }
        let rejected = MacNotificationService(defaults: nil, delivery: UXMacDelivery())
        let accepted = await rejected.setEnabled(true, api: refused.makeAPIClient())
        XCTAssertFalse(accepted)
        XCTAssertFalse(rejected.enabled)
        XCTAssertEqual(refused.requests.count, 1)
        await network.close(); await refused.close()
    }

    func testMacNotificationsRequireExplicitOptInAndRespectPermissionDenialAndDisable() async {
        let defaults = UXMemoryDefaults(), delivery = UXMacDelivery()
        let service = MacNotificationService(defaults: defaults, delivery: delivery)
        XCTAssertFalse(service.enabled)
        XCTAssertEqual(delivery.permissions, 0)
        delivery.permitted = false
        await service.setEnabled(true)
        XCTAssertTrue(service.enabled)
        XCTAssertNotNil(service.permissionNotice)
        XCTAssertEqual(delivery.permissions, 1)
        await service.setEnabled(false)
        XCTAssertFalse(service.enabled)
        XCTAssertNil(service.permissionNotice)
        XCTAssertEqual(delivery.clears, 1)
        let restored = MacNotificationService(defaults: defaults, delivery: delivery)
        XCTAssertFalse(restored.enabled)
        XCTAssertEqual(delivery.permissions, 1)
    }
    #endif
}
